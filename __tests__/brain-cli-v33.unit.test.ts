import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

async function run(entrypoint: string, args: string[]) {
  const proc = Bun.spawn({ cmd: ['bun', entrypoint, ...args], stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test('prospective CLI creates, confirms, and lists a due candidate without executing it', async () => {
  const dir = makeTempDir('cogmem-prospective-');
  const dbPath = join(dir, 'memory.db');
  const kernel = createMemoryKernel({ dbPath });
  const evidence = kernel.eventStore.append({
    streamId: 'thread', streamType: 'thread', eventType: 'RAW_EVENT_RECORDED',
    rawEventType: 'message', projectId: 'brain', role: 'user', payload: { text: 'Remind me to check CI.' },
  });
  const confirmation = kernel.eventStore.append({
    streamId: 'thread', streamType: 'thread', eventType: 'RAW_EVENT_RECORDED',
    rawEventType: 'message', projectId: 'brain', role: 'user', payload: { text: 'Yes, confirm that reminder.' },
  });
  kernel.close();
  const cli = join(import.meta.dir, '..', 'src', 'bin', 'prospective.ts');
  const created = await run(cli, [
    'create', '--db', dbPath, '--project', 'brain', '--type', 'reminder', '--key', 'release:ci',
    '--title', 'Check CI', '--evidence', evidence.eventId, '--due', '100',
  ]);
  expect(created.exitCode).toBe(0);
  const candidate = JSON.parse(created.stdout);
  expect(candidate.status).toBe('pending');

  const confirmed = await run(cli, ['confirm', '--db', dbPath, '--project', 'brain', '--id', candidate.candidateId, '--evidence', confirmation.eventId]);
  expect(confirmed.exitCode).toBe(0);
  expect(JSON.parse(confirmed.stdout).status).toBe('confirmed');

  const due = await run(cli, ['due', '--db', dbPath, '--project', 'brain', '--at', '200']);
  expect(due.exitCode).toBe(0);
  expect(JSON.parse(due.stdout).items[0].candidateId).toBe(candidate.candidateId);
});
