import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
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
});
