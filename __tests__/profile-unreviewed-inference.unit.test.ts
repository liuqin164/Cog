import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

describe('unreviewed llm inference stays out of the profile', () => {
  test('an old llm_inference belief without reviewConfirmed is excluded and a reviewed one is kept', () => {
    const dir = makeTempDir('cogmem-profile-unreviewed-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
    try {
      const projectId = 'profile-unreviewed-inference';
      const event = kernel.recordRawEvent({ threadId: 't-inference', projectId, role: 'user', content: '记一下。' });
      kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'uses',
        objectValue: { raw: 'vim', type: 'string' },
        confidence: 0.9,
        sourceType: 'llm_inference',
        sourceEventId: event.eventId,
        validFrom: 1000,
      });
      kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'drives',
        objectValue: { raw: 'car', type: 'string' },
        confidence: 0.9,
        sourceType: 'llm_inference',
        sourceEventId: event.eventId,
        validFrom: 2000,
        metadata: { reviewConfirmed: true },
      });

      kernel.profile.compile({ projectId });

      const facts = kernel.profile.entries({ projectId, ledger: 'facts' });
      expect(facts.map((entry) => entry.value)).toEqual(['car']);
      expect(facts.some((entry) => entry.value === 'vim')).toBe(false);
    } finally {
      kernel.close();
    }
  });

  test('an entry compiled from unreviewed inference before the gate existed retires on the next compile', () => {
    const dir = makeTempDir('cogmem-profile-upgrade-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
    try {
      const projectId = 'profile-unreviewed-upgrade';
      const event = kernel.recordRawEvent({ threadId: 't-upgrade', projectId, role: 'user', content: '记一下。' });
      const inferred = kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'uses',
        objectValue: { raw: 'vim', type: 'string' },
        confidence: 0.9,
        sourceType: 'llm_inference',
        sourceEventId: event.eventId,
        validFrom: 1000,
        metadata: { reviewConfirmed: true },
      }).belief!;
      kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'drives',
        objectValue: { raw: 'car', type: 'string' },
        confidence: 0.9,
        sourceType: 'llm_inference',
        sourceEventId: event.eventId,
        validFrom: 2000,
        metadata: { reviewConfirmed: true },
      });
      kernel.profile.compile({ projectId });
      expect(kernel.profile.entries({ projectId, ledger: 'facts' }).map((entry) => entry.value).sort()).toEqual(['car', 'vim']);

      kernel.factStore.getDatabase().prepare(`UPDATE beliefs SET metadata_json = '{}' WHERE id = ?`).run(inferred.id);
      kernel.profile.compile({ projectId });

      expect(kernel.profile.entries({ projectId, ledger: 'facts' }).map((entry) => entry.value)).toEqual(['car']);
    } finally {
      kernel.close();
    }
  });

  test('a key whose evidence row was deleted retires', () => {
    const dir = makeTempDir('cogmem-profile-deleted-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
    try {
      const projectId = 'profile-evidence-deleted';
      const event = kernel.recordRawEvent({ threadId: 't-deleted', projectId, role: 'user', content: '记一下。' });
      const belief = kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'uses',
        objectValue: { raw: 'vim', type: 'string' },
        confidence: 0.9,
        sourceType: 'llm_inference',
        sourceEventId: event.eventId,
        validFrom: 1000,
        metadata: { reviewConfirmed: true },
      }).belief!;
      kernel.profile.compile({ projectId });
      expect(kernel.profile.entries({ projectId, ledger: 'facts' }).map((entry) => entry.value)).toEqual(['vim']);

      kernel.factStore.getDatabase().prepare(`DELETE FROM beliefs WHERE id = ?`).run(belief.id);
      kernel.profile.compile({ projectId });

      expect(kernel.profile.entries({ projectId, ledger: 'facts' })).toEqual([]);
    } finally {
      kernel.close();
    }
  });
});
