import { existsSync } from 'node:fs';
import { ProcessLock, RuntimeLockHeldError } from '../../src/process-lock.ts';

const dir = process.argv[2];
const go = process.argv[3];
const done = process.argv[4];
const lock = new ProcessLock(dir);

process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid })}\n`);
while (!existsSync(go)) await Bun.sleep(1);

try {
  const result = lock.acquire(process.pid, Date.now());
  process.stdout.write(`${JSON.stringify({ event: 'acquired', pid: process.pid, recoveredStalePid: result.recoveredStalePid ?? null })}\n`);
  const deadline = Date.now() + 5_000;
  while (!existsSync(done) && Date.now() < deadline) await Bun.sleep(1);
} catch (error) {
  if (error instanceof RuntimeLockHeldError) {
    process.stdout.write(`${JSON.stringify({ event: 'held', pid: process.pid, holder: error.pid })}\n`);
  } else {
    throw error;
  }
}
