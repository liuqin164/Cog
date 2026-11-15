/**
 * The Pi plugin registry (#223): a data-dir file the resident reads at startup, unioned with the
 * environment variable that predates it.
 *
 * The discriminators are the three failure modes the ticket names: a corrupt or wrongly shaped file
 * must stop startup loudly (not fall back), the two sources must load a shared spec once, and the
 * write path must leave a 0600 file the installer never overwrites.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultShellConfig } from '../src/config.ts';
import { mergePluginSpecs, pluginsConfigPath, readPluginRegistry, writePluginRegistry } from '../src/plugins/registry.ts';
import { makeTempDir } from './helpers.ts';

describe('reading the plugin registry', () => {
  test('a missing file is an empty registry, not an error', () => {
    expect(readPluginRegistry(makeTempDir())).toEqual([]);
  });

  test('a valid file is read back trimmed, in order', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify([' @scope/pkg ', 'pi-web-access@0.47.0']), 'utf8');
    expect(readPluginRegistry(dir)).toEqual(['@scope/pkg', 'pi-web-access@0.47.0']);
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

describe('the registry is the environment variable\'s union, not its replacement', () => {
  test('env first, then registry, one copy of a spec named by both', () => {
    const dir = makeTempDir();
    writePluginRegistry(dir, ['from-registry', 'shared']);
    const previous = process.env.COGMEM_SHELL_PI_PLUGINS;
    process.env.COGMEM_SHELL_PI_PLUGINS = 'from-env, shared';
    try {
      const config = defaultShellConfig({ dataDir: dir });
      expect(config.pi.plugins).toEqual(['from-env', 'shared', 'from-registry']);
    } finally {
      if (previous === undefined) delete process.env.COGMEM_SHELL_PI_PLUGINS;
      else process.env.COGMEM_SHELL_PI_PLUGINS = previous;
    }
  });

  test('mergePluginSpecs dedupes across sources and keeps the first occurrence', () => {
    expect(mergePluginSpecs(['a', 'b'], ['b', 'c'], ['a'])).toEqual(['a', 'b', 'c']);
    expect(mergePluginSpecs([], [])).toEqual([]);
  });
});

describe('writing the registry', () => {
  test('the file is 0600 and round-trips exactly', () => {
    const dir = makeTempDir();
    writePluginRegistry(dir, ['@llblab/pi-telegram']);
    const path = pluginsConfigPath(dir);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(['@llblab/pi-telegram']);
    expect(readPluginRegistry(dir)).toEqual(['@llblab/pi-telegram']);
  });
});
