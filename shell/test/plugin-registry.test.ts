/**
 * The native plugin registry (#223, converted in #224): a data-dir file the resident reads at
 * startup.
 *
 * The discriminators are the three failure modes the ticket names: a corrupt or wrongly shaped file
 * must stop startup loudly (not fall back), the config carries the file's specs once, and the write
 * path must leave a 0600 file the installer never overwrites.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultShellConfig } from '../src/config.ts';
import { pluginsConfigPath, readPluginRegistry, writePluginRegistry } from '../src/plugins/registry.ts';
import { makeTempDir } from './helpers.ts';

describe('reading the plugin registry', () => {
  test('a missing file is an empty registry, not an error', () => {
    expect(readPluginRegistry(makeTempDir())).toEqual([]);
  });

  test('a valid file is read back trimmed, in order', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify([' @scope/pkg ', './plugins/echo.ts']), 'utf8');
    expect(readPluginRegistry(dir)).toEqual(['@scope/pkg', './plugins/echo.ts']);
  });

  test('a corrupt file fails startup loudly, like budgets.json', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'plugins.json'), '[{"oops":', 'utf8');
    expect(() => readPluginRegistry(dir)).toThrow(/^invalid_plugins_config: /u);
    expect(() => defaultShellConfig({ dataDir: dir })).toThrow(/invalid_plugins_config/u);
  });

  test('a wrongly shaped file is named, not silently dropped', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify({ plugins: ['a'] }), 'utf8');
    expect(() => readPluginRegistry(dir)).toThrow(/expected an array of package specs/u);

    writeFileSync(join(dir, 'plugins.json'), JSON.stringify(['a', 3]), 'utf8');
    expect(() => readPluginRegistry(dir)).toThrow(/\[1\] must be a non-empty string/u);

    writeFileSync(join(dir, 'plugins.json'), JSON.stringify(['a', '  ']), 'utf8');
    expect(() => readPluginRegistry(dir)).toThrow(/\[1\] must be a non-empty string/u);
  });
});

describe('the config carries the registry read at startup', () => {
  test('the file\'s specs are the configured list, in order', () => {
    const dir = makeTempDir();
    writePluginRegistry(dir, ['from-registry', 'shared']);
    expect(defaultShellConfig({ dataDir: dir }).plugins).toEqual(['from-registry', 'shared']);
  });
});

describe('writing the registry', () => {
  test('the file is 0600 and round-trips exactly', () => {
    const dir = makeTempDir();
    writePluginRegistry(dir, ['./plugins/hello.ts']);
    const path = pluginsConfigPath(dir);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(['./plugins/hello.ts']);
    expect(readPluginRegistry(dir)).toEqual(['./plugins/hello.ts']);
  });
});
