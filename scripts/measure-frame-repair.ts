#!/usr/bin/env bun
/**
 * Before/after for #110 on one machine and one corpus: a full frame-layer rebuild vs a bounded
 * repair of k staleframes at 100 and 500 active frames.
 *
 *   bun scripts/measure-frame-repair.ts
 *
 * The before number is the existing path (`MemoryFrameProjector.rebuild`, which every Night paid
 * before this round). The after number is the repair path Night now calls. Both run inside the
 * store's `deferFts + transaction` context and over the same database, which is the measurement
 * the ticket's 382/674 ms-per-frame figures came from.
 *
 * The corpus is synthetic on purpose: a fresh database per size, one episode and one published
 * frame per turn. `MEASURE_REPAIR=10` repairs ten stale frames instead of one.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryKernel } from '../dist/factory.js';
import { MemoryFrameProjector } from '../dist/atlas/MemoryFrameProjector.js';
import { deterministicFrameFallback } from '../dist/semantic/DeterministicFrameFallback.js';
import { frameSourceFingerprint } from '../dist/store/MemoryFrameStore.js';

const root = join(process.cwd(), '.cogmem', 'tmp');
mkdirSync(root, { recursive: true });
const repairCount = Math.max(1, Math.trunc(Number(process.env.MEASURE_REPAIR ?? 1)));
const T0 = Date.UTC(2026, 5, 5, 12, 0, 0);

function build(frameCount: number): { dbPath: string; kernel: ReturnType<typeof createMemoryKernel> } {
  const dir = join(root, `frame-repair-${frameCount}-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'memory.db');
  const kernel = createMemoryKernel({ dbPath });
  // Enough event text for the fallback frame's place/state/event nodes: the measured corpus was
  // ~79 nodes/frame, and this is the same shape, not a one-node toy.
  for (let index = 0; index < frameCount; index += 1) {
    const sessionId = `session-${index}`;
    // Four frames a day, so a shared day node carries a handful of supports — the shape a year
    // corpus has (536 episodes / 365 days), not every frame piling onto one day.
    const occurredAt = T0 + index * 6 * 60 * 60_000;
    const event = kernel.eventStore.append({
      eventId: `evt-${index}`, streamId: sessionId, streamType: 'thread', eventType: 'MESSAGE',
      rawEventType: 'message', projectId: 'p', sessionId, threadId: sessionId, role: 'user',
      occurredAt,
      payload: { text: `第 ${index} 次部署复盘：青栎组在东京办公室完成，当时还是 v${index} 版本。` },
    });
    kernel.appendRawEventToEpisode(event, { projectId: 'p', sessionId, sourceAgent: 'measure', now: occurredAt });
    const episodeId = (kernel.factStore.getDatabase().prepare(`SELECT episode_id FROM memory_episode_events WHERE event_id=?`).get(event.eventId) as { episode_id: string }).episode_id;
    const links = kernel.episodeStore.listEventLinks(episodeId);
    const events = links.map((link) => kernel.eventStore.getEvent(link.eventId)).filter(Boolean);
    const episode = kernel.episodeStore.getEpisode(episodeId)!;
    const fallback = deterministicFrameFallback({ projectId: 'p', episodeId: episode.episodeId, episodeType: episode.episodeType, events, now: occurredAt });
    // The measured corpus had ~79 nodes/frame; the rule fallback is ~7. Add the model-sized
    // entity fan-out so the unit cost is comparable rather than a toy.
    for (let extra = 0; extra < 70; extra += 1) {
      const frameNodeId = `entity:extra-${extra}`;
      fallback.nodes.push({ frameNodeId, dimension: 'entity', label: `extra-${index}-${extra}`, confidence: 0.5, evidenceEventIds: [event.eventId] });
      fallback.relations.push({ sourceFrameNodeId: `event:${event.eventId}`, relationType: 'INVOLVES_ENTITY', targetFrameNodeId: frameNodeId, confidence: 0.5, evidenceEventIds: [event.eventId] });
    }
    const saved = kernel.memoryFrameStore.save({
      frame: { ...fallback, sourceAuthority: 'processor', semanticCompleteness: 'full', needsReview: false },
      sourceFingerprint: frameSourceFingerprint(events.map((event) => event.eventId), episode.episodeId),
      status: 'staged', publishStatus: 'active',
    });
    if (!kernel.memoryFrameStore.publish(saved.frameId, 'staged', 'active')) throw new Error(`publish failed at ${index}`);
  }
  return { dbPath, kernel };
}

function timed(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

for (const frameCount of [100, 500]) {
  const { dbPath, kernel } = build(frameCount);
  const store = kernel.memoryAtlasStore;
  const db = kernel.factStore.getDatabase();
  const inContext = <T,>(fn: () => T): T => store.deferFts(() => db.transaction(() => fn())());
  const projector = new MemoryFrameProjector(db, kernel.memoryFrameStore, store, kernel.eventStore.getProjectTimeZone());

  store.markProjectionDirty('p');
  const fullNight = timed(() => kernel.rebuildMemoryAtlas({ projectId: 'p' }));

  const active = Number((db.prepare(`SELECT COUNT(*) AS n FROM memory_frames WHERE project_id='p' AND status='active'`).get() as { n: number }).n);
  const frames = kernel.memoryFrameStore.list('p', { statuses: ['active'], limit: 500 });
  const stale = frames.slice(0, repairCount).map((frame) => frame.frameId);
  for (const frame of frames.slice(0, repairCount)) {
    db.prepare(`DELETE FROM memory_episode_events WHERE rowid=(SELECT rowid FROM memory_episode_events WHERE episode_id=? LIMIT 1)`).run(frame.episodeId);
  }
  store.markProjectionDirty('p');

  const fullFrame = median(Array.from({ length: 3 }, () => timed(() => inContext(() => projector.rebuild('p', Date.now(), { canonicalDocumentsRebuilt: true })))));
  const repairFrame = median(Array.from({ length: 3 }, () => timed(() => inContext(() => projector.repair('p', stale, Date.now())))));
  const nightRepair = median(Array.from({ length: 3 }, () => {
    store.markProjectionDirty('p');
    return timed(() => kernel.memoryAtlasIndexer.ensureFresh({ projectId: 'p', frameMode: 'repair' }));
  }));
  const supportCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM memory_atlas_supports WHERE project_id='p' AND source_type='frame' AND status='active'`).get() as { n: number }).n);

  console.log(`\nframes ${active}  stale ${repairCount}  supports ${supportCount}  db ${dbPath}`);
  console.log(`  full Night (rebuild)                    ${fullNight.toFixed(0).padStart(8)} ms`);
  console.log(`  frame layer, full re-projection         ${fullFrame.toFixed(0).padStart(8)} ms  ${(fullFrame / active).toFixed(0)} ms/frame`);
  console.log(`  frame layer, bounded repair of ${String(repairCount).padEnd(3)}      ${repairFrame.toFixed(0).padStart(8)} ms  ${(repairFrame / repairCount).toFixed(0)} ms/stale frame`);
  console.log(`  Night reconcile, bounded frame mode     ${nightRepair.toFixed(0).padStart(8)} ms`);
  kernel.close();
}
