/**
 * The native plugin loader behind `<dataDir>/plugins.json`.
 *
 * A spec is a package name or a path to a module whose default export is a `NativePlugin`
 * (`{ name, inject?, provide?, apply }`, the same object the host already registers). Loading and
 * validation are all this module does; the host keeps its own conflict, dependency and fail-fast
 * rules. A spec that cannot be imported is named and skipped, because one bad registry entry must
 * not cost the resident — the same rule the removed compatibility layer used for its plugins.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { countSecretFindings } from 'cogmem';
import { insideWorkspace } from './builtin-tools.ts';
import type { NativePlugin, PluginHost } from './host.ts';

export interface PluginLoadResult {
  spec: string;
  status: 'loaded' | 'failed';
  /** The plugin's own `name`; absent when the module could not be loaded or validated. */
  name?: string;
  /** The package's version for a package spec; absent for a path spec. */
  version?: string;
  reason?: string;
  tools: string[];
  commands: string[];
}

interface LoadOptions {
  cwd: string;
  pluginWorkspaceRoot?: string;
  trace?: { append(kind: string, record?: Record<string, unknown>, now?: number): void };
}

const ENTRY_FILES = ['index.ts', 'index.js', 'index.mjs', 'index.tsx'];
const MAX_PLUGIN_SPEC_BYTES = 256 * 1024;

function entryOf(base: string): string | undefined {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const file of ENTRY_FILES) {
    const candidate = join(base, file);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The module URL to import: a path relative to the workspace, or a package resolved from it. */
function importSpecifier(spec: string, cwd: string): { url: string; pathish: boolean } {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const entry = entryOf(resolve(cwd, spec));
    if (!entry) throw new Error(`plugin_not_found: ${spec}`);
    return { url: pathToFileURL(entry).href, pathish: true };
  }
  const require = createRequire(join(cwd, 'package.json'));
  try {
    return { url: pathToFileURL(require.resolve(spec)).href, pathish: false };
  } catch {
    // Let Bun resolve the package from the shell's own tree (the usual install location).
    return { url: spec, pathish: false };
  }
}

function readPackageVersion(entry: string): string | undefined {
  let dir = entry;
  for (let depth = 0; depth < 6; depth += 1) {
    dir = dirname(dir);
    const manifestPath = join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const version = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }).version;
        return typeof version === 'string' ? version : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function isNativePlugin(value: unknown): value is NativePlugin {
  const plugin = value as NativePlugin | undefined;
  return plugin !== null && typeof plugin === 'object' && typeof plugin.name === 'string' && typeof plugin.apply === 'function';
}

function secretReason(text: string, where: string): string | undefined {
  const findings = countSecretFindings(text);
  if (findings.total === 0) return undefined;
  return `plugin_secret_text: ${where} 含 ${findings.total} 处密钥类文本（${Object.keys(findings.byKind).join(', ')}）`;
}

export function checkPluginSpec(
  spec: string,
  options: { cwd: string; roots: readonly string[]; dataDir?: string },
): string | undefined {
  const specBytes = Buffer.byteLength(spec, 'utf8');
  if (specBytes > MAX_PLUGIN_SPEC_BYTES) {
    return `plugin_spec_too_large: spec 文本 ${specBytes} 字节（上限 ${MAX_PLUGIN_SPEC_BYTES}）`;
  }
  const specSecret = secretReason(spec, 'spec');
  if (specSecret) return specSecret;

  let resolved: { url: string; pathish: boolean };
  try {
    resolved = importSpecifier(spec, options.cwd);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!resolved.url.startsWith('file:')) return undefined;

  let entry = fileURLToPath(resolved.url);
  if (resolved.pathish) {
    try {
      entry = realpathSync(entry);
    } catch {
      return `plugin_not_found: ${entry}`;
    }
    const contained = options.roots.some((root) => {
      try {
        insideWorkspace(root, entry, options.dataDir);
        return true;
      } catch {
        return false;
      }
    });
    if (!contained) return `path_outside_workspace: ${spec}`;
  }

  let size: number;
  try {
    size = statSync(entry).size;
  } catch {
    return `plugin_not_found: ${entry}`;
  }
  if (size > MAX_PLUGIN_SPEC_BYTES) {
    return `plugin_source_too_large: ${entry} 是 ${size} 字节（上限 ${MAX_PLUGIN_SPEC_BYTES}）`;
  }

  let source: string;
  try {
    source = readFileSync(entry, 'utf8');
  } catch (error) {
    return `plugin_unreadable: ${entry}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const sourceSecret = secretReason(source, entry);
  if (sourceSecret) return sourceSecret;

  const extension = extname(entry).toLowerCase();
  const loader = extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : extension === '.ts' || extension === '.mts' || extension === '.cts' ? 'ts' : 'js';
  try {
    new Bun.Transpiler({ loader }).transformSync(source);
  } catch (error) {
    return `plugin_unparseable: ${entry}: ${String(error)}`;
  }
  return undefined;
}

/**
 * Import and register every spec. Registration happens before `host.start()`; the returned tools and
 * commands are filled by the caller once the host has run each plugin's `apply`.
 */
export async function loadNativePlugins(host: PluginHost, specs: readonly string[], options: LoadOptions): Promise<PluginLoadResult[]> {
  const results: PluginLoadResult[] = [];
  for (const spec of specs) {
    try {
      const { url, pathish } = importSpecifier(spec, options.cwd);
      const module = (await import(url)) as { default?: unknown };
      if (!isNativePlugin(module.default)) {
        throw new Error('plugin_invalid: the default export must be a NativePlugin with name and apply');
      }
      const root = options.pluginWorkspaceRoot === undefined ? undefined : resolve(options.pluginWorkspaceRoot);
      const entry = url.startsWith('file:') ? resolve(fileURLToPath(url)) : undefined;
      const untrusted = !pathish || (root !== undefined && entry !== undefined && (entry === root || entry.startsWith(root + sep)));
      host.register(module.default, {}, { fatal: false, trusted: !untrusted });
      results.push({
        spec,
        status: 'loaded',
        name: module.default.name,
        ...(pathish || !url.startsWith('file:') ? {} : { version: readPackageVersion(fileURLToPath(url)) }),
        tools: [],
        commands: [],
      });
      options.trace?.append('plugin_loaded', { spec, plugin: module.default.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.trace?.append('plugin_load_failed', { plugin: spec, message });
      results.push({ spec, status: 'failed', reason: message, tools: [], commands: [] });
    }
  }
  return results;
}
