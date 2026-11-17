import { expect, test } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { deterministicFrameFallback } from '../src/semantic/DeterministicFrameFallback.js';
import { frameSourceFingerprint } from '../src/store/MemoryFrameStore.js';
import type { MemoryEvent } from '../src/types/index.js';
import { makeTempDir } from './helpers/tmp.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 5, 12, 0, 0);

function createKernelAt(dbPath: string): MemoryKernel {
  return createMemoryKernel({ dbPath });
}

/** One episode per call, with enough text that the fallback frame carries nodes and edges. */
function seedEpisode(kernel: MemoryKernel, index: number, text = '部署流程复盘，负责小组是青栎组，在东京办公室完成。'): string {
  const sessionId = `session-${index}`;
  const eventId = `evt-${index}`;
  const occurredAt = T0 + index * 60_000;
  const event = kernel.eventStore.append({
    eventId,
    streamId: sessionId,
    streamType: 'thread',
    eventType: 'MESSAGE',
    rawEventType: 'message',
    projectId: 'p',
    sessionId,
    threadId: sessionId,
    role: 'user',
    occurredAt,
    localDate: '2026-06-05',
    payload: { text },
  });
  kernel.appendRawEventToEpisode(event, { projectId: 'p', sessionId, sourceAgent: 'test', now: occurredAt });
  return eventId;
}

/**
 * Publish a model-shaped frame for the episode. The rule fallback can only reach
 * `needs_confirmation` (its evidence authority cannot be approved), so the fields that make a
 * frame publishable are set here; the content is still the deterministic shape the projector
 * reads, which is exactly the corpus `measure-atlas-rebuild.ts` measured.
 */
function publishFrame(kernel: MemoryKernel, episodeId: string): string {
  const links = kernel.episodeStore.listEventLinks(episodeId);
  const events = links.map((link) => kernel.eventStore.getEvent(link.eventId)).filter((event): event is MemoryEvent => Boolean(event));
  const episode = kernel.episodeStore.getEpisode(episodeId)!;
  const fallback = deterministicFrameFallback({ projectId: 'p', episodeId, episodeType: episode.episodeType, events, now: T0 });
  const saved = kernel.memoryFrameStore.save({
    frame: {
      ...fallback,
      sourceAuthority: 'processor',
      semanticCompleteness: 'full',
      needsReview: false,
      status: 'staged',
    },
    sourceFingerprint: frameSourceFingerprint(events.map((event) => event.eventId), episodeId),
    status: 'staged',
    publishStatus: 'active',
  });
  expect(kernel.memoryFrameStore.publish(saved.frameId, 'staged', 'active')).toBe(true);
  return saved.frameId;
}

function graph(kernel: MemoryKernel): { nodes: string[]; edges: string[]; supports: string[] } {
  const db = kernel.memoryAtlasStore.db;
  const nodes = (db.prepare(`SELECT node_type,node_id,label,status FROM memory_atlas_documents WHERE project_id='p' ORDER BY node_id`).all() as Array<{ node_type: string; node_id: string; label: string; status: string }>)
    .map((row) => `${row.node_type}\u0000${row.node_id}\u0000${row.label}\u0000${row.status}`);
  const edges = (db.prepare(`SELECT source_type,source_id,relation_type,target_type,target_id,status FROM memory_edges WHERE project_id='p' ORDER BY source_id,relation_type,target_id`).all() as Array<Record<string, string>>)
    .map((row) => `${row.source_type}:${row.source_id}\u0000${row.relation_type}\u0000${row.target_type}:${row.target_id}\u0000${row.status}`);
  const supports = (db.prepare(`SELECT node_id,source_id FROM memory_atlas_supports WHERE project_id='p' AND source_type='frame' AND status='active' ORDER BY node_id,source_id`).all() as Array<{ node_id: string; source_id: string }>)
    .map((row) => `${row.node_id}\u0000${row.source_id}`);
  return { nodes, edges, supports };
}

/** Count `INSERT INTO memory_atlas_supports` executions, the frame projector's unit of work. */
function countSupportWrites(kernel: MemoryKernel): { writes: () => number; restore: () => void } {
  const db = kernel.memoryAtlasStore.db;
  const original = db.prepare.bind(db);
  let writes = 0;
  db.prepare = ((sql: string) => {
    const statement = original(sql) as unknown as { run: (...args: unknown[]) => unknown };
    if (/INSERT INTO memory_atlas_supports/iu.test(sql)) {
      const run = statement.run.bind(statement);
      statement.run = (...args: unknown[]) => {
        writes += 1;
        return run(...args);
      };
    }
    return statement;
  }) as typeof db.prepare;
  return { writes: () => writes, restore: () => { db.prepare = original; } };
}

test('repairing one stale frame produces the graph a full rebuild produces (#110)', () => {
  const dbPath = join(makeTempDir('cogmem-frame-repair-equivalence-'), 'memory.db');
  const kernel = createKernelAt(dbPath);
  let repaired: ReturnType<typeof graph> = { nodes: [], edges: [], supports: [] };
  let staleFrameId = '';
  try {
    for (let index = 0; index < 6; index += 1) seedEpisode(kernel, index);
    const episodes = kernel.listEpisodes({ projectId: 'p', limit: 10 });
    for (const episode of episodes) publishFrame(kernel, episode.episodeId);
    kernel.rebuildMemoryAtlas({ projectId: 'p' });

    // Split an episode's evidence: its frame's source fingerprint no longer matches, which is the
    // double-stamp's stale signal. Repair must re-project that frame and leave the others alone.
    const changed = episodes[2]!;
    staleFrameId = kernel.memoryFrameStore.getByEpisode('p', changed.episodeId)!.frameId;
    kernel.memoryAtlasStore.db.prepare(`DELETE FROM memory_episode_events WHERE rowid=(SELECT rowid FROM memory_episode_events WHERE episode_id=? LIMIT 1)`).run(changed.episodeId);
    kernel.memoryAtlasStore.markProjectionDirty('p', { reason: 'test' });

    const repair = kernel.memoryFrameStore.listRepairFrames({ projectId: 'p' });
    expect(repair.ids).toEqual([staleFrameId]);
    expect(repair.stale).toBe(1);
    expect(repair.unprojected).toBe(0);

    const result = kernel.memoryAtlasIndexer.ensureFresh({ projectId: 'p', frameMode: 'repair' });
    expect(result.refreshed).toBe(true);
    repaired = graph(kernel);
  } finally {
    kernel.close();
  }

  const copyPath = join(makeTempDir('cogmem-frame-repair-copy-'), 'memory.db');
  copyFileSync(dbPath, copyPath);
  const rebuilt = createKernelAt(copyPath);
  try {
    rebuilt.rebuildMemoryAtlas({ projectId: 'p' });
    expect(repaired.nodes).toEqual(graph(rebuilt).nodes);
    expect(repaired.edges).toEqual(graph(rebuilt).edges);
    expect(repaired.supports).toEqual(graph(rebuilt).supports);
  } finally {
    rebuilt.close();
  }
});

test('a repair writes one frame worth of supports however large the corpus is (#110)', () => {
  const measure = (frameCount: number): { repaired: number; full: number } => {
    const kernel = createKernelAt(join(makeTempDir('cogmem-frame-repair-cost-'), 'memory.db'));
    try {
      for (let index = 0; index < frameCount; index += 1) seedEpisode(kernel, index);
      const episodes = kernel.listEpisodes({ projectId: 'p', limit: frameCount + 10 });
      for (const episode of episodes) publishFrame(kernel, episode.episodeId);
      kernel.rebuildMemoryAtlas({ projectId: 'p' });
      const stale = episodes[0]!;
      kernel.memoryAtlasStore.db.prepare(`DELETE FROM memory_episode_events WHERE rowid=(SELECT rowid FROM memory_episode_events WHERE episode_id=? LIMIT 1)`).run(stale.episodeId);
      kernel.memoryAtlasStore.markProjectionDirty('p', { reason: 'test' });

      const counter = countSupportWrites(kernel);
      try {
        kernel.memoryAtlasIndexer.ensureFresh({ projectId: 'p', frameMode: 'repair' });
        const repaired = counter.writes();
        kernel.rebuildMemoryAtlas({ projectId: 'p' });
        return { repaired, full: counter.writes() - repaired };
      } finally {
        counter.restore();
      }
    } finally {
      kernel.close();
    }
  };

  const small = measure(4);
  const large = measure(24);
  expect(small.repaired).toBeGreaterThan(0);
  // One frame's nodes and edges do not depend on how many other frames exist.
  expect(large.repaired).toBeLessThanOrEqual(small.repaired + 5);
  // The full pass still pays every frame, so the two numbers really are different work.
  expect(large.full).toBeGreaterThan(small.full * 3);
});

test('Night pays no frame-layer cost when no frame needs repair (#110)', async () => {
  const kernel = createKernelAt(join(makeTempDir('cogmem-frame-repair-night-'), 'memory.db'));
  try {
    for (let index = 0; index < 4; index += 1) seedEpisode(kernel, index);
    const episodes = kernel.listEpisodes({ projectId: 'p', limit: 10 });
    for (const episode of episodes) publishFrame(kernel, episode.episodeId);
    kernel.rebuildMemoryAtlas({ projectId: 'p' });
    expect(kernel.memoryFrameStore.listRepairFrames({ projectId: 'p' }).ids).toEqual([]);

    const counter = countSupportWrites(kernel);
    try {
      // The night dreams the sealed episodes and writes staged frames; those set the dirty flag,
      // but no *active* frame needs the projector, so the frame layer must not run.
      const first = await kernel.runNight({ projectId: 'p', now: T0 + DAY });
      expect(first.reconciled.refreshed).toBe(true);
      expect(counter.writes()).toBe(0);
      const second = await kernel.runNight({ projectId: 'p', now: T0 + 2 * DAY });
      expect(second.reconciled.refreshed).toBe(false);
      expect(counter.writes()).toBe(0);
    } finally {
      counter.restore();
    }
  } finally {
    kernel.close();
  }
});

test('Night repairs only the stale frame it was told about (#110)', async () => {
  const kernel = createKernelAt(join(makeTempDir('cogmem-frame-repair-night-stale-'), 'memory.db'));
  try {
    const frameCount = 16;
    for (let index = 0; index < frameCount; index += 1) seedEpisode(kernel, index);
    const episodes = kernel.listEpisodes({ projectId: 'p', limit: frameCount + 10 });
    for (const episode of episodes) publishFrame(kernel, episode.episodeId);
    kernel.rebuildMemoryAtlas({ projectId: 'p' });

    const totalSupports = Number((kernel.memoryAtlasStore.db.prepare(`SELECT COUNT(*) AS n FROM memory_atlas_supports WHERE project_id='p' AND source_type='frame' AND status='active'`).get() as { n: number }).n);
    const perFrame = totalSupports / frameCount;

    const changed = episodes[5]!;
    kernel.memoryAtlasStore.db.prepare(`DELETE FROM memory_episode_events WHERE rowid=(SELECT rowid FROM memory_episode_events WHERE episode_id=? LIMIT 1)`).run(changed.episodeId);
    expect(kernel.memoryFrameStore.listRepairFrames({ projectId: 'p' }).ids).toHaveLength(1);

    const counter = countSupportWrites(kernel);
    try {
      const night = await kernel.runNight({ projectId: 'p', now: T0 + DAY });
      expect(night.reconciled.refreshed).toBe(true);
      // One frame, not sixteen: the count tracks the stale set, not the corpus.
      expect(counter.writes()).toBeGreaterThan(0);
      expect(counter.writes()).toBeLessThanOrEqual(Math.ceil(perFrame) + 5);
    } finally {
      counter.restore();
    }
  } finally {
    kernel.close();
  }
});
