/**
 * `<dataDir>/plugins.json`: the native plugin registry the resident reads at startup.
 *
 * The file is a JSON array of specs — a package name (`@scope/pkg`, `pkg@1.2.3`) or a path relative
 * to the workspace. A spec's module default-exports a `NativePlugin` (see `plugins/load.ts`).
 * It exists because the service manager's environment is fixed when the process starts: a companion
 * asked to register a plugin had no product surface to write, so registering one meant surgery on
 * its own unit.
 *
 * A file that exists but cannot be understood is a startup error, like `budgets.json`: a user who
 * edited it must not be left believing it applied. The installer writes the official specs on first
 * install and never overwrites it; `/plugins add` is the write path afterwards.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OFFICIAL_PLUGIN_SPECS = ['builtin:web-channel'] as const;

export function isOfficialPluginSpec(spec: string): boolean {
  return (OFFICIAL_PLUGIN_SPECS as readonly string[]).includes(spec);
}

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
