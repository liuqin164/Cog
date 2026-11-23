import { expect, test } from 'bun:test';
import type Database from 'bun:sqlite';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { assertDerivedErasureCovered } from '../src/governance/DerivedErasureRegistry.js';
import { deterministicFrameFallback } from '../src/semantic/DeterministicFrameFallback.js';
import { makeTempDir } from './helpers/tmp.js';

const SECRET = 'ZQXDERIVEDSECRET8842';
const OTHER = 'OTHERPROJECTTOKEN5521';
const DAY = 24 * 60 * 60 * 1000;

test('#422 a range deletion erases every derived row the real pipelines wrote', async () => {
  const dir = makeTempDir('forget-derived-');
  const dbPath = join(dir, 'memory.sqlite');
  const projectId = 'derived-window';
  const base = Date.now() - 120_000;
  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    const events = [];
    for (let index = 0; index < 6; index += 1) {
      const sessionId = `derived-session-${Math.floor(index / 2)}`;
      const event = kernel.recordRawEvent({
        projectId,
        threadId: sessionId,
        sessionId,
        sourceId: 'derived-agent',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${SECRET} turn ${index} Cogmem 项目 memory write pipeline 乌龙茶 王芳 邮件`,
        occurredAt: base + index * 1_000,
        metadata: { captureLane: 'conversation', sourceAgent: 'derived-agent', speaker: 'owner', channel: 'chat' },
      });
      events.push(event);
      kernel.appendRawEventToEpisode(event, { projectId, sessionId, sourceAgent: 'derived-agent', now: base + index * 1_000 });
    }
    for (let index = 0; index < 3; index += 1) {
      await kernel.ingest({ projectId, content: `${SECRET} 王芳对花生过敏 ${index}` });
    }
    const bindings = kernel.bindRawEvents({ projectId });
    expect(bindings.createdBindings).toBeGreaterThan(0);

    const episodeIds = (db.prepare(`
      SELECT DISTINCT episode_id FROM memory_episode_events WHERE event_id IN (${events.map(() => '?').join(',')})
    `).all(...events.map((event) => event.eventId)) as Array<{ episode_id: string }>).map((row) => row.episode_id);
    expect(episodeIds.length).toBeGreaterThan(0);
    const firstEpisodeId = (db.prepare(`SELECT episode_id FROM memory_episode_events WHERE event_id=?`).get(events[0]!.eventId) as { episode_id?: string } | null)?.episode_id;
    expect(firstEpisodeId).toBeTruthy();

    const person = kernel.entityStore.upsertEntity({
      canonicalName: `王芳-${SECRET}`,
      type: 'person',
      aliases: [SECRET],
      createdFrom: events[0]!.eventId,
      metadata: { projectId },
      createdAt: base,
    });
    const object = kernel.entityStore.upsertEntity({
      canonicalName: `乌龙茶-${SECRET}`,
      type: 'object',
      createdFrom: events[0]!.eventId,
      metadata: { projectId },
      createdAt: base,
    });
    kernel.entityStore.addAttribute({
      entityId: person.entityId,
      attributeKey: 'allergy',
      attributeValue: SECRET,
      sourceNeuronId: events[0]!.eventId,
      createdAt: base,
    });
    kernel.entityStore.addRelation({
      sourceEntityId: person.entityId,
      targetEntityId: object.entityId,
      relationType: 'likes',
      projectId,
      sourceNeuronId: events[0]!.eventId,
      createdAt: base,
    });

    const topic = kernel.userTopicPathRegistry.create({
      projectId,
      topicPath: `secret/${SECRET}`,
      canonicalName: SECRET,
      createdBy: 'user_explicit',
      evidenceEventIds: [events[0]!.eventId],
      now: base,
    });
    kernel.topicAliasRegistry.add({
      projectId,
      topicId: topic.topicId,
      alias: SECRET,
      createdBy: 'user_explicit',
      confidence: 1,
      evidenceEventIds: [events[0]!.eventId],
      now: base,
    });

    const belief = kernel.beliefGovernanceService.apply({
      projectId,
      ownership: 'user',
      beliefType: 'preference',
      canonicalKey: `preference-${SECRET}`,
      statement: `${SECRET} likes 乌龙茶`,
      evidenceEventIds: [events[0]!.eventId],
      occurredAt: base,
    });
    kernel.temporalMemoryService.record({
      projectId,
      entryType: 'event',
      canonicalKey: `timeline-${SECRET}`,
      entityId: person.entityId,
      beliefId: belief.beliefId,
      title: SECRET,
      occurredAt: base,
      evidenceEventIds: [events[0]!.eventId],
    });
    const prospective = kernel.prospectiveMemoryService.propose({
      projectId,
      candidateType: 'reminder',
      canonicalKey: `prospective-${SECRET}`,
      title: SECRET,
      proposedBy: 'deterministic',
      evidenceEventIds: [events[0]!.eventId],
    });

    const frame = deterministicFrameFallback({
      projectId,
      episodeId: firstEpisodeId!,
      events: [{ eventId: events[0]!.eventId, occurredAt: base } as never],
      now: base,
    });
    const savedFrame = kernel.memoryFrameStore.save({
      frame: {
        ...frame,
        sourceAuthority: 'processor',
        needsReview: false,
        evidenceEventIds: [events[0]!.eventId],
        nodes: frame.nodes.map((node, index) => index === 0 ? { ...node, label: `${SECRET} ${node.label}` } : node),
      },
      sourceFingerprint: 'derived-fingerprint',
      publishStatus: 'active',
    });
    expect(kernel.memoryFrameStore.publish(savedFrame.frameId, 'staged', 'active')).toBe(true);

    const night = await kernel.runNight({ projectId, now: base + DAY });
    expect(night.dream.processedEpisodeCount).toBeGreaterThan(0);
    kernel.promoteDreamCandidates({ projectId });
    kernel.graphOverview({ projectId, refresh: true });
    const otherProject = 'derived-other';
    kernel.recordRawEvent({
      projectId: otherProject,
      threadId: 'other-thread',
      role: 'user',
      content: `${OTHER} must survive the other project's rebuild`,
      occurredAt: base,
    });
    kernel.graphOverview({ projectId: otherProject, refresh: true });

    const present = (table: string, where = '1', params: Array<string | number> = []): number =>
      Number((db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE ${where}`).get(...params) as { c?: number } | null)?.c ?? 0);
    expect(present('memory_bindings', `COALESCE(project_id,'')=?`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_clusters', `COALESCE(project_id,'')=?`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_topics', `COALESCE(project_id,'')=?`, [projectId])).toBeGreaterThan(0);
    expect(present('topic_nodes', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_entities', `COALESCE(project_id,'')=?`, [projectId])).toBeGreaterThan(0);
    expect(present('entity_attributes', `source_neuron_id IN (SELECT event_id FROM memory_events WHERE project_id=?)`, [projectId])).toBeGreaterThan(0);
    expect(present('entity_relations', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_frames', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_atlas_supports', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_atlas_aliases', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('deep_write_candidates', `run_id IN (SELECT run_id FROM deep_write_runs WHERE project_id=?)`, [projectId])).toBeGreaterThan(0);
    expect(present('deep_write_summaries', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('belief_graph_nodes', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('belief_graph_evidence', `event_id IN (SELECT event_id FROM memory_events WHERE project_id=?)`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_timeline_entries', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('prospective_memories', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('episode_closure_receipts', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('episode_dream_jobs', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('episode_dream_runs', `project_id=?`, [projectId])).toBeGreaterThan(0);
    expect(present('memory_event_cjk_terms', `event_id IN (SELECT event_id FROM memory_events WHERE project_id=?)`, [projectId])).toBeGreaterThan(0);
    const runIds = (db.prepare(`SELECT run_id FROM deep_write_runs WHERE project_id=?`).all(projectId) as Array<{ run_id: string }>).map((row) => row.run_id);
    expect(runIds.length).toBeGreaterThan(0);
    const eventPlaceholders = events.map(() => '?').join(',');
    const eventIds = events.map((event) => event.eventId);

    assertDerivedErasureCovered((db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((row) => row.name));

    const result = kernel.sovereignty.deleteRange({ projectId, start: base - 60_000, end: Date.now() + 60_000 });
    expect(result.deleted.events).toBeGreaterThanOrEqual(events.length);
    for (const event of events) {
      expect(present('memory_event_cjk_terms', 'event_id=?', [event.eventId])).toBe(0);
    }

    const tables: Array<[string, string, Array<string | number>]> = [
      ['memory_bindings', `event_id IN (${eventPlaceholders})`, eventIds],
      ['memory_clusters', `project_id=?`, [projectId]],
      ['memory_topics', `project_id=?`, [projectId]],
      ['topic_nodes', `project_id=?`, [projectId]],
      ['memory_entities', `project_id=?`, [projectId]],
      ['entity_aliases', `project_id=?`, [projectId]],
      ['entity_attributes', `source_neuron_id IN (${eventPlaceholders})`, eventIds],
      ['entity_relations', `project_id=?`, [projectId]],
      ['compiled_events', `neuron_id IN (${eventPlaceholders})`, eventIds],
      ['pending_entity_resolution', `context_neuron_id IN (${eventPlaceholders})`, eventIds],
      ['memory_frames', `project_id=?`, [projectId]],
      ['memory_frame_nodes', `frame_id=?`, [savedFrame.frameId]],
      ['memory_frame_relations', `frame_id=?`, [savedFrame.frameId]],
      ['memory_frame_reviews', `frame_id=?`, [savedFrame.frameId]],
      ['memory_atlas_supports', `project_id=?`, [projectId]],
      ['memory_atlas_aliases', `project_id=?`, [projectId]],
      ['memory_atlas_alias_supports', `project_id=?`, [projectId]],
      ['memory_atlas_alias_ambiguities', `project_id=?`, [projectId]],
      ['belief_graph_nodes', `belief_id=?`, [belief.beliefId]],
      ['belief_graph_evidence', `belief_id=?`, [belief.beliefId]],
      ['belief_graph_versions', `belief_id=?`, [belief.beliefId]],
      ['memory_timeline_entries', `project_id=?`, [projectId]],
      ['prospective_memories', `candidate_id=?`, [prospective.candidateId]],
      ['prospective_memory_transitions', `candidate_id=?`, [prospective.candidateId]],
      ['deep_write_candidates', `run_id IN (${runIds.map(() => '?').join(',')})`, runIds],
      ['deep_write_summaries', `project_id=?`, [projectId]],
      ['episode_closure_receipts', `project_id=?`, [projectId]],
      ['episode_dream_jobs', `project_id=?`, [projectId]],
      ['episode_dream_runs', `project_id=?`, [projectId]],
      ['memory_episodes', `project_id=?`, [projectId]],
      ['interaction_units', `EXISTS (SELECT 1 FROM json_each(message_neuron_ids_json) WHERE value IN (${eventPlaceholders}))`, eventIds],
    ];
    for (const [table, where, params] of tables) expect(present(table, where, params), table).toBe(0);
    expect(present('memory_derivations', `COALESCE(project_id,'')=?`, [projectId])).toBe(0);
    expect(rowsHolding(db, SECRET)).toEqual([]);

    const otherFts = Number((db.prepare(`SELECT COUNT(*) AS c FROM memory_atlas_fts WHERE project_id=?`).get(otherProject) as { c?: number } | null)?.c ?? 0);
    expect(otherFts).toBeGreaterThan(0);
    kernel.rebuildMemoryAtlas({ projectId });
    expect(Number((db.prepare(`SELECT COUNT(*) AS c FROM memory_atlas_fts WHERE project_id=?`).get(otherProject) as { c?: number } | null)?.c ?? 0)).toBe(otherFts);
  } finally {
    kernel.close();
  }
}, 60_000);

test('#422 an episode that crosses the window is erased whole', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('forget-episode-'), 'memory.sqlite'), projectTimeZone: 'UTC' });
  try {
    const projectId = 'episode-window';
    const base = Date.UTC(2026, 2, 3, 9);
    const events = [0, 1, 2, 3].map((index) => {
      const sessionId = `episode-session-${Math.floor(index / 2)}`;
      const event = kernel.recordRawEvent({
        projectId,
        threadId: sessionId,
        sessionId,
        role: 'user',
        content: `episode turn ${index}`,
        occurredAt: base + index * 60_000,
      });
      kernel.appendRawEventToEpisode(event, { projectId, sessionId, sourceAgent: 'episode-agent', now: base + index * 60_000 });
      return event;
    });

    kernel.sovereignty.deleteRange({ projectId, start: events[1]!.occurredAt - 1, end: events[1]!.occurredAt + 1 });

    expect(kernel.eventStore.getEvent(events[0]!.eventId)).toBeFalsy();
    expect(kernel.eventStore.getEvent(events[1]!.eventId)).toBeFalsy();
    expect(kernel.eventStore.getEvent(events[2]!.eventId)).toBeTruthy();
    expect(kernel.eventStore.getEvent(events[3]!.eventId)).toBeTruthy();
  } finally {
    kernel.close();
  }
});

test('#500 a row referenced only through relatedEventIds is erased by the ledger', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('forget-lineage-'), 'memory.sqlite'), projectTimeZone: 'UTC' });
  const projectId = 'lineage-window';
  const base = Date.UTC(2026, 2, 4, 9);
  try {
    const deleted = kernel.recordRawEvent({
      projectId,
      threadId: 'lineage-thread',
      sessionId: 'lineage-session',
      role: 'user',
      content: 'lineage deleted source',
      occurredAt: base,
    });
    const kept = kernel.recordRawEvent({
      projectId,
      threadId: 'lineage-thread',
      sessionId: 'lineage-session',
      role: 'assistant',
      content: 'lineage surviving source',
      occurredAt: base + 10 * 60_000,
    });
    kernel.memoryBindingStore.upsertTopic({ projectId, topicPath: 'lineage/topic', topicType: 'concept', now: base });
    const binding = kernel.memoryBindingStore.insertBinding({
      eventId: kept.eventId,
      relatedEventIds: [deleted.eventId],
      projectId,
      topicPath: 'lineage/topic',
      bindingType: 'about',
      confidence: 0.9,
      source: 'deterministic',
      signal: 'lineage',
      claimKey: 'lineage',
      createdAt: base,
    });
    const db = kernel.factStore.getDatabase();
    expect((db.prepare(`SELECT event_id FROM memory_bindings WHERE binding_id=?`).get(binding.bindingId) as { event_id: string }).event_id).toBe(kept.eventId);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM memory_derivations WHERE derived_kind='memory_bindings' AND derived_id=? AND source_event_id=?`)
      .get(binding.bindingId, deleted.eventId) as { c: number }).c).toBe(1);

    kernel.sovereignty.deleteRange({ projectId, start: base - 1_000, end: base + 60_000 });

    expect(Number((db.prepare(`SELECT COUNT(*) AS c FROM memory_bindings WHERE binding_id=?`).get(binding.bindingId) as { c: number }).c)).toBe(0);
    expect(Number((db.prepare(`SELECT COUNT(*) AS c FROM memory_derivations WHERE derived_kind='memory_bindings' AND derived_id=? AND source_event_id=?`)
      .get(binding.bindingId, deleted.eventId) as { c: number }).c)).toBe(0);
    expect(kernel.eventStore.getEvent(deleted.eventId)).toBeFalsy();
    expect(kernel.eventStore.getEvent(kept.eventId)).toBeTruthy();
  } finally {
    kernel.close();
  }
});

function rowsHolding(db: Database, needle: string): string[] {
  const hits: string[] = [];
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
    for (const column of columns) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE instr(CAST("${column.name}" AS TEXT), ?) > 0`).get(needle) as { c: number };
      if (Number(row.c) > 0) hits.push(`${name}.${column.name}:${row.c}`);
    }
  }
  return hits;
}
