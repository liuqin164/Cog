#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { KernelAgentMemoryBackend } from '../../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../../src/factory.js';

const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);
const DAY = 86_400_000;
const AGENT = 'owner';
const repoTmp = resolve(import.meta.dir, '../../.cogmem/backref-eval');
mkdirSync(repoTmp, { recursive: true });
const runDir = mkdtempSync(join(repoTmp, 'run-'));
process.env.TMPDIR = runDir;

interface Probe {
  id: string;
  question: string;
  expect: string;
  seed: 'previous-day' | 'previous-session' | 'current-earlier';
}

const PROBES: Probe[] = [
  { id: 'yesterday', question: '昨天聊的那个', expect: 'Orion', seed: 'previous-day' },
  { id: 'last-session', question: '上次聊的那个', expect: 'Orion', seed: 'previous-session' },
  { id: 'later-state', question: '后来怎么样了', expect: '限流阈值', seed: 'current-earlier' },
  { id: 'just-now', question: '刚才那个怎么样了', expect: '限流阈值', seed: 'current-earlier' },
];

async function run(probe: Probe, withContext: boolean): Promise<boolean> {
  const projectId = `${probe.id}-${withContext ? 'with' : 'without'}`;
  const kernel = createMemoryKernel({ dbPath: join(runDir, `${projectId}.db`), projectTimeZone: 'Asia/Tokyo' });
  const backend = new KernelAgentMemoryBackend(kernel);
  try {
    if (withContext) {
      if (probe.seed !== 'current-earlier') {
        await backend.rememberTurnWithResult({
          agentId: AGENT,
          projectId,
          sessionId: probe.seed === 'previous-day' ? 'session-yesterday' : 'session-previous',
          turnId: `${probe.id}:previous`,
          userText: '部署代号是 Orion，上线窗口周二凌晨两点。',
          assistantText: '记下了。',
          timestamp: NOW - DAY,
          ingestMode: 'immediate_compile',
        });
      } else {
        for (let turn = 1; turn <= 10; turn += 1) {
          await backend.rememberTurnWithResult({
            agentId: AGENT,
            projectId,
            sessionId: 'session-today',
            turnId: `${probe.id}:${turn}`,
            userText: turn === 1
              ? '限流阈值定在每秒八百次。'
              : turn === 10 ? '刚才说的限流阈值方案。' : `普通对话第 ${turn} 轮。`,
            assistantText: turn === 1 ? '记下了。' : turn === 10 ? '就是那个限流阈值方案。' : '好。',
            timestamp: NOW - (10 - turn) * 60_000,
            ingestMode: 'immediate_compile',
          });
        }
      }
    }
    const result = backend.recall({
      agentId: AGENT,
      projectId,
      query: probe.question,
      excludeSessionId: 'session-today',
      excludeSessionTailTurns: 2,
      limit: 3,
      now: NOW,
    });
    return result.items.map((item) => item.text).join('\n').includes(probe.expect);
  } finally {
    kernel.close();
  }
}

const rows: Array<{ id: string; question: string; withContext: boolean; withoutContext: boolean }> = [];
for (const probe of PROBES) {
  rows.push({
    id: probe.id,
    question: probe.question,
    withContext: await run(probe, true),
    withoutContext: await run(probe, false),
  });
}

const withContext = rows.filter((row) => row.withContext).length;
const withoutContext = rows.filter((row) => row.withoutContext).length;
console.log(`next-day reference follow-up: with context ${withContext}/${rows.length}, without context ${withoutContext}/${rows.length}`);
for (const row of rows) {
  console.log(`- ${row.id}: with=${row.withContext ? 'hit' : 'miss'} without=${row.withoutContext ? 'hit' : 'miss'} (${row.question})`);
}
if (withContext !== rows.length || withoutContext !== 0) {
  rmSync(runDir, { recursive: true, force: true });
  throw new Error('back-reference evaluation failed');
}
rmSync(runDir, { recursive: true, force: true });
