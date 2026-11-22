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
});
