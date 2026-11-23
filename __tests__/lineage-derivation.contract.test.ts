import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { DERIVATION_CLASSIFICATION, LINEAGE_TABLES, registerDerivation } from '../src/governance/DerivationLedger.js';
import { FINAL_TABLES } from '../src/migrations/v3_7_4/FinalSchemaDefinition.js';
import { deterministicFrameFallback } from '../src/semantic/DeterministicFrameFallback.js';
import { SummaryStore } from '../src/store/SummaryStore.js';
import { makeTempDir } from './helpers/tmp.js';

test('#470 every FINAL_TABLES table with a TEXT column is classified', () => {
  const withText = FINAL_TABLES.filter(({ sql }) => /\bTEXT\b/u.test(sql)).map(({ name }) => name);
  expect(withText.filter((name) => !DERIVATION_CLASSIFICATION[name])).toEqual([]);
  const known = new Set(FINAL_TABLES.map(({ name }) => name));
  expect(Object.keys(DERIVATION_CLASSIFICATION).filter((name) => !known.has(name))).toEqual([]);
});

test('#470 every wired store write registers its derivation', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('lineage-'), 'memory.sqlite'), projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    const projectId = 'lineage-project';
    const sessionId = 'lineage-session';
    const at = Date.UTC(2026, 10, 23, 9);
    const event = kernel.recordRawEvent({
      projectId,
      threadId: sessionId,
      sessionId,
      role: 'user',
      content: 'lineage skeleton',
      occurredAt: at,
    });
    kernel.appendRawEventToEpisode(event, { projectId, sessionId, sourceAgent: 'lineage', now: at });
    const episodeId = (db.prepare(`SELECT episode_id FROM memory_episode_events WHERE event_id=?`).get(event.eventId) as { episode_id: string }).episode_id;

    const [fact] = kernel.factStore.insertFacts([{
      neuronId: event.eventId,
      subject: 'owner',
      predicateFamily: 'prefers',
      object: 'tea',
      validFrom: at,
      certaintyLevel: 'certain',
      confidence: 0.9,
      status: 'verified',
      sourceText: 'lineage',
    }]);
    const [compiled] = kernel.factStore.insertEvents([{
      neuronId: event.eventId,
      eventType: 'preference',
      validFrom: at,
      confidence: 0.9,
      status: 'verified',
    }]);
    kernel.memoryBindingStore.upsertTopic({ projectId, topicPath: 'lineage/topic', topicType: 'concept', now: at });
    const binding = kernel.memoryBindingStore.insertBinding({
      eventId: event.eventId,
      projectId,
      topicPath: 'lineage/topic',
      bindingType: 'about',
      confidence: 0.9,
      source: 'deterministic',
      signal: 'lineage',
      claimKey: 'lineage',
      createdAt: at,
    });
    const cluster = kernel.memoryBindingStore.upsertCluster({
      projectId,
      topicPath: 'lineage/topic',
      clusterType: 'concept',
      title: 'lineage',
      summary: 'lineage',
      claimKey: 'lineage',
      status: 'active',
      confidence: 0.9,
      eventId: event.eventId,
      now: at,
    });
    const { belief } = kernel.beliefStore.upsert({
      projectId,
      scope: 'project',
      subject: 'owner',
      predicate: 'prefers',
      objectValue: { raw: 'tea', normalized: 'tea', type: 'string' },
      confidence: 0.9,
      sourceType: 'user_input',
      sourceEventId: event.eventId,
      validFrom: at,
    }, at);
    const frame = deterministicFrameFallback({
      projectId,
      episodeId,
      events: [{ eventId: event.eventId, occurredAt: at } as never],
      now: at,
    });
    const savedFrame = kernel.memoryFrameStore.save({
      frame: { ...frame, sourceAuthority: 'processor', needsReview: false, evidenceEventIds: [event.eventId] },
      sourceFingerprint: 'lineage',
      publishStatus: 'active',
    });
    const timeline = kernel.temporalMemoryService.record({
      projectId,
      entryType: 'milestone',
      title: 'lineage',
      occurredAt: at,
      evidenceEventIds: [event.eventId],
    });
    const prospective = kernel.prospectiveMemoryService.propose({
      projectId,
      candidateType: 'reminder',
      canonicalKey: 'lineage',
      title: 'lineage',
      proposedBy: 'deterministic',
      evidenceEventIds: [event.eventId],
    });
    const summary = new SummaryStore(db).insertSummary({
      projectId,
      scope: 'turn_window',
      text: 'lineage',
      confidence: 0.9,
      status: 'provisional',
      sourceNeuronIds: [event.eventId],
    });

    const rows = db.prepare(`SELECT derived_kind, derived_id, source_event_id, project_id FROM memory_derivations`).all() as Array<{
      derived_kind: string;
      derived_id: string;
      source_event_id: string;
      project_id: string | null;
    }>;
    const registered = new Set(rows.map((row) => `${row.derived_kind}:${row.derived_id}:${row.source_event_id}`));
    expect([...new Set(rows.map((row) => row.derived_kind))].sort()).toEqual([...LINEAGE_TABLES].sort());
    for (const entry of [
      `facts:${fact!.factId}:${event.eventId}`,
      `compiled_events:${compiled!.eventId}:${event.eventId}`,
      `memory_bindings:${binding.bindingId}:${event.eventId}`,
      `memory_clusters:${cluster.clusterId}:${event.eventId}`,
      `beliefs:${belief!.id}:${event.eventId}`,
      `memory_frames:${savedFrame.frameId}:${event.eventId}`,
      `memory_timeline_entries:${timeline.entryId}:${event.eventId}`,
      `prospective_memories:${prospective.candidateId}:${event.eventId}`,
      `deep_write_summaries:${summary.summaryId}:${event.eventId}`,
    ]) expect(registered.has(entry), entry).toBe(true);
    expect(rows.every((row) => row.project_id === projectId)).toBe(true);
    expect(() => registerDerivation(db, { kind: 'memory_derivations', derivedId: 'x', sourceEventIds: [event.eventId] }))
      .toThrow('derivation_kind_unregistered:memory_derivations');
  } finally {
    kernel.close();
  }
}, 30_000);
