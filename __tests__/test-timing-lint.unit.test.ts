import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { findSlowWaits } from '../scripts/test-timing-lint.ts';
import { makeTempDir } from './helpers/tmp.js';

test('a short sleep outside a retry loop is reported and a bounded poll is not', () => {
  const dir = makeTempDir('cogmem-test-timing-');
  writeFileSync(join(dir, 'blind-wait.test.ts'), [
    'async function blind(): Promise<void> {',
    '  await new Promise((resolve) => setTimeout(resolve, 20));',
    '}',
    'async function poll(): Promise<void> {',
    '  for (let attempt = 0; attempt < 3; attempt += 1) {',
    '    await new Promise((resolve) => setTimeout(resolve, 10));',
    '  }',
    '}',
    '',
  ].join('\n'));

  const problems = findSlowWaits(dir);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain('blind-wait.test.ts:2');
  expect(problems[0]).toContain('setTimeout(20)');
});

test('the existing suite has no blind short waits', () => {
  expect(findSlowWaits(join(process.cwd(), '__tests__'))).toEqual([]);
});
