import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepareRunRoot, RUN_ROOT_PREFIX, runRoot } from './temp-root.ts';

describe('test run roots', () => {
  test('a stale root is swept and a live process root is kept', () => {
    const live = runRoot();
    const stale = join(dirname(live), `${RUN_ROOT_PREFIX}99999999`);
    mkdirSync(stale, { recursive: true });
    try {
      prepareRunRoot();
      const roots = readdirSync(dirname(live)).filter((entry) => entry.startsWith(RUN_ROOT_PREFIX));
      expect(roots).toContain(`${RUN_ROOT_PREFIX}${process.pid}`);
      expect(roots).not.toContain(`${RUN_ROOT_PREFIX}99999999`);
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
  });

  test('a stale legacy-prefix directory is swept and a fresh one is kept', () => {
    const root = dirname(runRoot());
    const stale = join(root, `companion-kill-stale-${process.pid}`);
    const live = join(root, `companion-kill-live-${process.pid}`);
    mkdirSync(stale, { recursive: true });
    mkdirSync(live, { recursive: true });
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(stale, old, old);
    try {
      prepareRunRoot(Date.now() - 3_600_000);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      rmSync(stale, { recursive: true, force: true });
      rmSync(live, { recursive: true, force: true });
    }
  });
});
