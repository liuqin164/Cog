import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * #119: the compiled layer was written and never read.
 *
 * Two faults, both found by running it rather than reading it:
 *
 * 1. the Atlas node allowlist named dimensions the projection does not emit for a
 *    conversation (`episode`, `entity` were missing), and it existed twice — the main path
 *    and one helper each kept a copy;
 * 2. when that was fixed, the card was still dropped: it cites the same event as the raw
 *    answer, and `mergeRecallItems` dedupes by event id with the raw item first.
 *
 * The shape that works is the one the budget rule already states — index first, detail by
 * ID: the raw sentence is the answer, and the compiled card says what it is. This test
 * holds both halves.
 */
test('a dreamed episode contributes to recall without replacing the answer (#119)', async () => {
  const dir = makeTempDir('cogmem-atlas-recall-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), vectorBackend: 'sqlite-vec' });
  const old = Date.now() - 7_200_000;
  for (const [role, text] of [
    ['user', '我们决定把归档保留期定成七年，第八年统一销毁。'],
    ['assistant', '记下了：归档保留期七年。'],
  ] as const) {
    kernel.appendEpisodeMessage({ projectId: 'p', sessionId: 's1', sourceAgent: 'a', role, text, timestamp: old });
  }
  await kernel.runNight({ projectId: 'p', maxEpisodes: 20 });
  kernel.backfillMemoryFrames({ projectId: 'p', limit: 20 });

  const recall = new KernelAgentMemoryBackend(kernel).recall({ query: '归档保留期', projectId: 'p', agentId: 'a', limit: 4, now: Date.now() });
  const counts = (recall as unknown as { decisionTrace: { candidateCounts: Record<string, number> } }).decisionTrace.candidateCounts;

  // The lane is no longer invisible: a trace that says 0 while the Atlas has nodes is
  // what made this look like "no compiled memory" for several rounds.
  expect(counts.atlas ?? 0).toBeGreaterThan(0);

  const enriched = (recall.items ?? []).find((item) => item.tags?.includes('atlas_node'));
  expect(enriched).toBeDefined();
  // The answer is still the sentence the user wrote, not a label standing in for it.
  expect(enriched!.text).toContain('归档保留期定成七年');
  expect(enriched!.displayTitle).toContain('归档保留期');
  kernel.close();
});

test('a query with no atlas match still answers, and says the lane was empty (#119)', () => {
  const dir = makeTempDir('cogmem-atlas-recall-none-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), vectorBackend: 'sqlite-vec' });
  kernel.appendEpisodeMessage({ projectId: 'p', sessionId: 's1', sourceAgent: 'a', role: 'user', text: '限流阈值定在每秒八百次。', timestamp: Date.now() - 7_200_000 });
  kernel.memoryAtlasStore.markProjectionClean('p');
  const recall = new KernelAgentMemoryBackend(kernel).recall({ query: '限流阈值', projectId: 'p', agentId: 'a', limit: 3, now: Date.now() });
  const counts = (recall as unknown as { decisionTrace: { candidateCounts: Record<string, number> } }).decisionTrace.candidateCounts;
  expect(counts.atlas).toBe(0);
  expect((recall.items ?? []).length).toBeGreaterThan(0);
  kernel.close();
});

test('an Atlas node survives the merge when no raw lane answers (#362)', () => {
  const dir = makeTempDir('cogmem-atlas-merge-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), vectorBackend: 'sqlite-vec' });
  const event = kernel.appendEpisodeMessage({
    projectId: 'p', sessionId: 's1', sourceAgent: 'a', role: 'user',
    text: '今天天气不错。', timestamp: Date.now() - 7_200_000,
  });
  kernel.memoryAtlasStore.upsertDocument({
    id: 'episode:atlas-only', projectId: 'p', nodeType: 'episode', sourceId: 'atlas-only',
    label: '海象协议上线窗口', summary: '海象协议在十一月二十日上线', confidence: 0.9,
    supportCount: 1, status: 'active', evidenceEventIds: [event.eventId],
  });
  kernel.memoryAtlasStore.markProjectionClean('p');

  const result = new KernelAgentMemoryBackend(kernel).recall({
    query: '海象协议上线窗口', projectId: 'p', agentId: 'a', limit: 4, now: Date.now(),
  });
  const trace = (result as unknown as { decisionTrace: { candidateCounts: Record<string, number>; selectedCount: number } }).decisionTrace;

  expect(trace.candidateCounts.atlas).toBe(1);
  expect(trace.selectedCount).toBe(1);
  const item = result.items.find((candidate) => candidate.canonicalId === 'episode:atlas-only');
  expect(item).toBeDefined();
  expect(item!.canonicalId).toBeString();
  const activation = kernel.memoryAtlasStore.db.prepare(`
    SELECT usage_count FROM memory_atlas_activation WHERE project_id=? AND node_id=?
  `).get('p', 'episode:atlas-only') as { usage_count: number } | null;
  expect(activation?.usage_count).toBeGreaterThan(0);
  kernel.close();
});
