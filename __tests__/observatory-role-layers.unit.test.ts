import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { startObservatoryServer, type ObservatoryServerHandle } from '../src/observatory/HttpServer.js';
import { makeTempDir } from './helpers/tmp.js';

const scratch = makeTempDir('cogmem-observatory-roles-');
const dbPath = join(scratch, 'memory.db');
const projectId = 'role-layers';
let kernel: MemoryKernel;
let handle: ObservatoryServerHandle;

beforeAll(async () => {
  kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  const now = Date.UTC(2026, 10, 20, 9);
  const rule = kernel.recordRawEvent({
    projectId, threadId: 't', role: 'user',
    content: '以后所有对外文档一律用中文写。', occurredAt: now,
  });
  kernel.recordRawEvent({
    projectId, threadId: 't', role: 'assistant',
    content: '我明天把文件发你。', occurredAt: now + 1_000,
  });
  kernel.recordRawEvent({
    projectId, threadId: 't', role: 'assistant',
    content: '我准备把报告整理一下。', occurredAt: now + 2_000,
  });
  kernel.beliefStore.upsert({
    projectId, scope: 'project', subject: 'user', predicate: 'boundary',
    objectValue: { raw: '中文写', normalized: '中文写', type: 'string' },
    confidence: 0.9, sourceEventId: rule.eventId, sourceType: 'user_input',
    extractionReason: 'explicit_user_statement', metadata: { deep_write_candidate_type: 'boundary' },
  }, now + 3_000);
  kernel.commitments.compile({ projectId, now: now + 4_000 });
  kernel.intentions.compile({ projectId, now: now + 5_000 });
  kernel.soul.save({ agentId: 'hermes', actor: 'user', content: '先读再问，别猜。', now: now + 6_000 });
  handle = await startObservatoryServer({ dbPath, cwd: scratch, port: 0, kernel });
});

afterAll(() => {
  handle.stop();
  kernel.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the star map carries the four governed layers', () => {
  test('snapshot role counts equal direct SQL', async () => {
    const response = await fetch(`${handle.url.replace(/\/$/u, '')}/snapshot?project=${projectId}`);
    const snapshot = await response.json() as {
      nodes: Array<{ id: string; role: string }>;
      counts: { nodesByRole: Record<string, number> };
    };
    const db = new Database(dbPath, { readonly: true });
    const rule = (db.query(`SELECT COUNT(*) AS c FROM beliefs WHERE project_id = ? AND predicate = 'boundary'`).get(projectId) as { c: number }).c;
    const soul = (db.query(`SELECT COUNT(*) AS c FROM soul_versions`).get() as { c: number }).c;
    const promise = (db.query(`SELECT COUNT(DISTINCT json_extract(payload_json, '$.commitmentId')) AS c FROM memory_events WHERE project_id = ? AND event_type = 'COMMITMENT_OPENED'`).get(projectId) as { c: number }).c;
    const intent = (db.query(`SELECT COUNT(DISTINCT json_extract(payload_json, '$.intentionId')) AS c FROM memory_events WHERE project_id = ? AND event_type = 'INTENTION_OPENED'`).get(projectId) as { c: number }).c;
    db.close();
    expect(snapshot.counts.nodesByRole.rule).toBe(rule);
    expect(snapshot.counts.nodesByRole.soul).toBe(soul);
    expect(snapshot.counts.nodesByRole.promise).toBe(promise);
    expect(snapshot.counts.nodesByRole.intent).toBe(intent);
    expect([rule, soul, promise, intent].every((count) => count > 0)).toBe(true);
  });

  test('each layer node opens its original text and source', async () => {
    const base = handle.url.replace(/\/$/u, '');
    const snapshot = await (await fetch(`${base}/snapshot?project=${projectId}`)).json() as {
      nodes: Array<{ id: string; role: string }>;
    };
    for (const role of ['rule', 'soul', 'promise', 'intent']) {
      const node = snapshot.nodes.find((item) => item.role === role)!;
      expect(node).toBeTruthy();
      const detail = await (await fetch(`${base}/node/${encodeURIComponent(node.id)}?project=${projectId}`)).json() as {
        summary?: string; evidence: Array<{ excerpt?: string; sourceLocator?: { command: string } }>;
      };
      expect(detail.summary?.length).toBeGreaterThan(0);
      expect(detail.evidence[0]?.sourceLocator?.command.length).toBeGreaterThan(0);
    }
  });
});
