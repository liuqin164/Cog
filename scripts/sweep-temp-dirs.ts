import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { sweepLegacyTempDirs } from './temp-prefixes.ts';

const root = resolve(process.argv[2] ?? join(process.cwd(), '.cogmem', 'tmp'));
const startedAt = Date.now();
const before = duKb(root);
const removed = sweepLegacyTempDirs(root, startedAt);
const after = duKb(root);
let remaining = 0;
try {
  remaining = readdirSync(root).length;
} catch {}

console.log(`removed ${removed} entr(ies) from ${root}`);
console.log(`freed ${formatKb(before - after)}; ${remaining} top-level entr(ies) left, ${formatKb(after)}`);

function duKb(path: string): number {
  const result = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
  if (result.status !== 0) return 0;
  return Number(result.stdout.split(/\s+/)[0]) || 0;
}

function formatKb(kb: number): string {
  if (kb < 1024) return `${Math.max(0, kb)} KB`;
  return `${(Math.max(0, kb) / 1024).toFixed(1)} MB`;
}
