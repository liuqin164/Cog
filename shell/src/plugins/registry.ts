/**
 * `<dataDir>/plugins.json`: the Pi plugin registry the resident reads at startup.
 *
 * The file is a JSON array of package specs — the same strings `COGMEM_SHELL_PI_PLUGINS` takes
 * (`@scope/pkg`, `pkg@1.2.3`, or a path relative to the workspace). It exists because the
 * environment variable is fixed when the service starts: a companion asked to install a plugin had
 * no product surface to write, so registering one meant surgery on its own unit. The two sources are
 * unioned, so an existing install keeps working and the registry adds to it.
 *
 * A file that exists but cannot be understood is a startup error, like `budgets.json`: a user who
 * edited it must not be left believing it applied. The installer writes `[]` on first install and
 * never overwrites it; `/plugins add` is the write path afterwards.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function pluginsConfigPath(dataDir: string): string {
  return join(dataDir, 'plugins.json');
}

export function readPluginRegistry(dataDir: string): string[] {
  const path = pluginsConfigPath(dataDir);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid_plugins_config: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`invalid_plugins_config: ${path}: expected an array of package specs`);
  return parsed.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`invalid_plugins_config: ${path}: [${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

/** Atomic publish (temp + rename) at 0600, the same shape as the other operating files. */
export function writePluginRegistry(dataDir: string, specs: readonly string[]): void {
  const path = pluginsConfigPath(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(specs, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/**
 * The startup list: every source in order, first occurrence wins. Env first keeps an existing
 * install's load order; a spec named by both sources loads once.
 */
export function mergePluginSpecs(...sources: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of sources) {
    for (const raw of source) {
      const spec = raw.trim();
      if (spec === '' || seen.has(spec)) continue;
      seen.add(spec);
      merged.push(spec);
    }
  }
  return merged;
}
