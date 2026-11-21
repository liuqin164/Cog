import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkForUpdate,
  compareVersions,
  isNewerVersion,
  isUpdateCacheFresh,
  loadUpdateSettings,
  maybeStartVersionCheck,
  readUpdateCache,
  refreshUpdateCache,
  renderUpdateNotice,
  UPDATE_CHECK_FAILURE_RETRY_MS,
} from '../src/install/VersionCheck.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * #150. What is asserted here is the contract the ticket fixed: the check is
 * cached for about a day, silent when the registry cannot be reached, and
 * switchable off.
 */

function writeConfig(dir: string, body: string): string {
  const configPath = join(dir, '.cogmem', 'config.toml');
  mkdirSync(join(dir, '.cogmem'), { recursive: true });
  writeFileSync(configPath, body);
  return configPath;
}

const BASE_CONFIG = '[core]\ndb_path = "memory.db"\nvector_backend = "sqlite-vec"\n';

describe('version comparison', () => {
  test('compares numerically, not as strings', () => {
    expect(compareVersions('4.10.0', '4.9.0')).toBe(1);
    expect(compareVersions('4.2', '4.2.0')).toBe(0);
    expect(compareVersions('v4.2.1', '4.2.0')).toBe(1);
    // A pre-release suffix is not a newer stable release.
    expect(isNewerVersion('4.2.0-beta.1', '4.2.0')).toBe(false);
    expect(isNewerVersion('4.2.0', '4.1.9')).toBe(true);
    expect(isNewerVersion('4.1.0', '4.1.0')).toBe(false);
  });
});

describe('update settings', () => {
  test('the check is on by default', () => {
    const home = makeTempDir('cogmem-update-settings-');
    writeConfig(home, BASE_CONFIG);
    const settings = loadUpdateSettings({ env: { HOME: home }, cwd: home });
    expect(settings.check).toBe(true);
    expect(settings.cachePath).toBe(join(home, '.cogmem', 'update-check.json'));
  });

  test('the config switches the check off, and the environment can too', () => {
    const home = makeTempDir('cogmem-update-settings-');
    const configPath = writeConfig(home, `${BASE_CONFIG}[update]\ncheck = false\n`);
    expect(loadUpdateSettings({ env: { HOME: home }, configPath }).check).toBe(false);

    const enabled = writeConfig(join(home, 'other'), `${BASE_CONFIG}[update]\ncheck = true\n`);
    expect(loadUpdateSettings({ env: { HOME: home, COGMEM_UPDATE_CHECK: '0' }, configPath: enabled }).check).toBe(false);
    expect(loadUpdateSettings({ env: { HOME: home, COGMEM_UPDATE_CHECK: '1' }, configPath: enabled }).check).toBe(true);
  });

  test('an unreadable config is not this module failure to report', () => {
    const home = makeTempDir('cogmem-update-settings-');
    const broken = join(home, 'broken.toml');
    writeFileSync(broken, 'this is not = = toml\n');
    const settings = loadUpdateSettings({ env: { HOME: home }, configPath: broken });
    expect(settings.check).toBe(true);
  });
});

describe('the registry read', () => {
  test('a successful read is cached, and the notice follows from the cache', async () => {
    const home = makeTempDir('cogmem-version-check-');
    const cachePath = join(home, 'cache.json');
    const cache = await refreshUpdateCache({
      cachePath,
      registryUrl: 'https://registry.invalid',
      now: 1_000,
      fetchImpl: async () => new Response(JSON.stringify({ version: '5.0.1' }), { status: 200 }),
    });
    expect(cache.latestVersion).toBe('5.0.1');
    expect(readUpdateCache(cachePath)?.latestVersion).toBe('5.0.1');

    const status = checkForUpdate({ env: { HOME: home }, cachePath, now: 2_000 });
    expect(status.updateAvailable).toBe(true);
    expect(status.stale).toBe(false);
    expect(renderUpdateNotice(status)).toContain('cogmem 5.0.1 is available');
    expect(renderUpdateNotice(status)).toContain('/upgrade');
  });

  test('a registry failure is silent, cached, and retried on the shorter cadence', async () => {
    const home = makeTempDir('cogmem-version-check-');
    const cachePath = join(home, 'cache.json');
    const cache = await refreshUpdateCache({
      cachePath,
      now: 1_000,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(cache.latestVersion).toBeUndefined();
    expect(cache.error).toBe('registry_unreachable');
    expect(readUpdateCache(cachePath)?.error).toBe('registry_unreachable');
    // Still fresh for an hour, then owed again; a failure does not poison a whole day.
    expect(isUpdateCacheFresh(cache, 1_000 + UPDATE_CHECK_FAILURE_RETRY_MS - 1)).toBe(true);
    expect(isUpdateCacheFresh(cache, 1_000 + UPDATE_CHECK_FAILURE_RETRY_MS + 1)).toBe(false);

    const status = checkForUpdate({ env: { HOME: home }, cachePath, now: 2_000 });
    expect(status.updateAvailable).toBe(false);
    expect(renderUpdateNotice(status)).toBeUndefined();
  });

  test('an HTTP error is a failure, not a version', async () => {
    const home = makeTempDir('cogmem-version-check-');
    const cachePath = join(home, 'cache.json');
    const cache = await refreshUpdateCache({
      cachePath,
      now: 1_000,
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    expect(cache.latestVersion).toBeUndefined();
    expect(cache.error).toBeDefined();
  });

  test('the check starts nothing when it is off or today already answered', () => {
    const home = makeTempDir('cogmem-version-check-');
    writeConfig(home, `${BASE_CONFIG}[update]\ncheck = false\n`);
    expect(maybeStartVersionCheck({ env: { HOME: home }, cwd: home })).toEqual({ started: false, reason: 'check_disabled' });

    const fresh = join(home, 'cache.json');
    writeFileSync(fresh, JSON.stringify({ checkedAt: Date.now(), latestVersion: '5.0.1' }));
    expect(maybeStartVersionCheck({ env: { HOME: home, COGMEM_UPDATE_CHECK: '1' }, cwd: home, cachePath: fresh }))
      .toEqual({ started: false, reason: 'cache_fresh' });
  });

  test('switched off means no status to render at all', () => {
    const home = makeTempDir('cogmem-version-check-');
    writeConfig(home, `${BASE_CONFIG}[update]\ncheck = false\n`);
    const status = checkForUpdate({ env: { HOME: home }, cwd: home });
    expect(status.enabled).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(renderUpdateNotice(status)).toBeUndefined();
  });
});

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the one-line notice on a command', () => {
  async function runCli(args: string[], home: string) {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(coreRoot, 'src', 'bin', 'cogmem.ts'), ...args],
      cwd: coreRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      // The switch is on for this test, and only for this test.
      env: { ...process.env, HOME: home, COGMEM_UPDATE_CHECK: '1', NO_COLOR: '1' },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test('a normal command adds it, and --json does not', async () => {
    const home = makeTempDir('cogmem-notice-');
    mkdirSync(join(home, '.cogmem'), { recursive: true });
    writeFileSync(join(home, '.cogmem', 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latestVersion: '9.9.9' }));

    const normal = await runCli(['doctor'], home);
    expect(normal.stderr).toContain('cogmem 9.9.9 is available');
    expect(normal.stderr).toContain('/upgrade');

    const json = await runCli(['doctor', '--json'], home);
    expect(json.stderr).not.toContain('is available');
  }, 60_000);
});

test('a resident started outside the dispatcher starts the check on its own path', async () => {
  // The matrix cell the ticket names explicitly: the resident started directly
  // (systemd, a fixture), not through the CLI dispatcher. The evidence is the cache
  // file the detached child writes, because the point is that it never waits for it.
  const home = makeTempDir('cogmem-observatory-check-');
  const dbDir = makeTempDir('cogmem-observatory-check-db-');
  const registry = Bun.serve({ port: 0, fetch: () => Response.json({ version: '9.9.9' }) });
  const proc = Bun.spawn({
    cmd: [process.execPath, join(coreRoot, 'src', 'bin', 'observatory.ts'), '--port', '7598', '--db', join(dbDir, 'memory.db')],
    cwd: coreRoot,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: home, COGMEM_UPDATE_CHECK: '1', COGMEM_UPDATE_REGISTRY: `http://127.0.0.1:${registry.port}` },
  });
  try {
    const cachePath = join(home, '.cogmem', 'update-check.json');
    let latest: string | undefined;
    for (let attempt = 0; attempt < 200 && latest !== '9.9.9'; attempt += 1) {
      if (existsSync(cachePath)) {
        try { latest = (JSON.parse(readFileSync(cachePath, 'utf8')) as { latestVersion?: string }).latestVersion; } catch { /* mid-write */ }
      }
      if (latest !== '9.9.9') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(latest).toBe('9.9.9');
  } finally {
    proc.kill();
    registry.stop(true);
  }
}, 60_000);
