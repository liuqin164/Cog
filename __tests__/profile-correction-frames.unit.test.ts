import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { deterministicFrameFallback } from '../src/semantic/index.js';
import type { MemoryEvent } from '../src/types/index.js';
import { makeTempDir } from './helpers/tmp.js';

const T0 = Date.UTC(2026, 10, 16, 9);
const projectId = 'correction-frame';
const scratch = makeTempDir('cogmem-correction-frame-');
let kernel: MemoryKernel;
let backend: KernelAgentMemoryBackend;

beforeAll(() => {
  kernel = createMemoryKernel({ dbPath: join(scratch, 'memory.db'), projectTimeZone: 'UTC' });
  backend = new KernelAgentMemoryBackend(kernel);
});

afterAll(() => {
  kernel.close();
});

function frameWithPreference(event: MemoryEvent, episodeId: string, object: string) {
  const frame = deterministicFrameFallback({ projectId, episodeId, events: [event], now: T0 });
  frame.needsReview = false;
  frame.sourceAuthority = 'processor';
  frame.evidenceEventIds = [event.eventId];
  frame.nodes.push(
    { frameNodeId: 'n-actor', dimension: 'actor', label: '主人', confidence: 0.9, evidenceEventIds: [event.eventId] },
    { frameNodeId: 'n-object', dimension: 'object', label: object, confidence: 0.9, evidenceEventIds: [event.eventId] },
  );
  frame.relations.push({
    sourceFrameNodeId: 'n-actor',
    relationType: 'LIKES',
    targetFrameNodeId: 'n-object',
    confidence: 0.9,
    evidenceEventIds: [event.eventId],
    validFrom: event.occurredAt,
  });
  return frame;
}

function publishFrame(event: MemoryEvent, episodeId: string, object: string): string {
  const saved = kernel.memoryFrameStore.save({
    frame: frameWithPreference(event, episodeId, object),
    sourceFingerprint: `correction-${episodeId}-${object}`,
    status: 'active',
    now: T0,
  });
  kernel.memoryFrameStore.publish(saved.frameId, 'staged', 'active', T0 + 1);
  return saved.frameId;
}

describe('a profile correction reaches frames and their Atlas nodes', () => {
  test('the old frame is not recalled, not projected, and cannot be republished as a belief', () => {
    const event = kernel.recordRawEvent({
      projectId,
      threadId: 'preference-thread',
      role: 'user',
      content: '我喜欢喝乌龙茶。',
      occurredAt: T0,
    });
    const episode = kernel.episodeStore.createEpisode({
      projectId,
      sessionId: 'session-1',
      conversationThreadId: 'preference-thread',
      episodeType: 'preference',
      importance: 0.6,
      eventId: event.eventId,
      globalSeq: event.globalSeq,
      occurredAt: T0,
    });
    kernel.episodeStore.appendEvent({
      episodeId: episode.episodeId,
      eventId: event.eventId,
      relation: 'primary',
      confidence: 1,
      globalSeq: event.globalSeq,
      occurredAt: T0,
    });
    kernel.beliefStore.upsert({
      projectId,
      scope: 'project',
      subject: '主人',
      predicate: 'preference.LIKES',
      objectValue: { raw: '乌龙茶', type: 'string' },
      confidence: 0.9,
      sourceType: 'user_input',
      extractionReason: 'preference_signal',
      sourceEventId: event.eventId,
      validFrom: T0,
    }, T0);
    kernel.profile.compile({ projectId, now: T0 + 1 });
    const frameId = publishFrame(event, episode.episodeId, '乌龙茶');
    kernel.rebuildMemoryAtlas({ projectId });

    const before = backend.recall({ projectId, agentId: 'hermes', query: '乌龙茶 红茶', limit: 8 });
    expect(before.items.map((item) => item.text).join('\n')).toContain('乌龙茶');
    expect(kernel.memoryFrameStore.get(frameId)?.status).toBe('active');

    const correction = kernel.recordRawEvent({
      projectId,
      threadId: 'correction-thread',
      role: 'user',
      content: '现在喜欢红茶。',
      occurredAt: T0 + 2_000,
    });
    const entry = kernel.profile.entries({ projectId, ledger: 'facts' })
      .find((candidate) => candidate.value === '乌龙茶')!;
    const corrected = kernel.profile.correct({
      projectId,
      ledger: 'facts',
      key: entry.key,
      value: '红茶',
      correctionEventId: correction.eventId,
      now: T0 + 3_000,
    });

    expect(corrected.replaced).toEqual({ profile: 1, beliefs: 1, facts: 0, frames: 1, cards: 0 });
    expect(kernel.memoryFrameStore.get(frameId)?.status).toBe('superseded');
    const immediate = backend.recall({ projectId, agentId: 'hermes', query: '乌龙茶 红茶', limit: 8 });
    const immediateText = immediate.items.map((item) => item.text).join('\n');
    expect(immediateText).toContain('红茶');
    expect(immediateText).not.toContain('乌龙茶');

    kernel.runMaintenanceTick({ projectId, now: T0 + 4_000 });
    const activeFrameDocuments = kernel.factStore.getDatabase().prepare(`
      SELECT label, summary FROM memory_atlas_documents
      WHERE project_id=? AND status='active' AND json_extract(metadata_json,'$.projection')='memory_atlas.frame.v2'
    `).all(projectId) as Array<{ label?: string; summary?: string }>;
    expect(activeFrameDocuments.some((row) => `${row.label ?? ''} ${row.summary ?? ''}`.includes('乌龙茶'))).toBe(false);

    publishFrame(event, `${episode.episodeId}-republish`, '乌龙茶');
    const beliefs = kernel.beliefStore.findByCanonicalKey(entry.key, projectId);
    expect(beliefs.some((belief) => belief.status === 'active' && String(belief.objectValue.raw) === '乌龙茶')).toBe(false);
    expect(beliefs.some((belief) => belief.status === 'active' && String(belief.objectValue.raw) === '红茶')).toBe(true);
  });
});
