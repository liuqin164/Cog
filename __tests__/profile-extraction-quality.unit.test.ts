import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const scratch = makeTempDir('cogmem-profile-quality-');
const kernels: MemoryKernel[] = [];

const makeKernel = (name: string): MemoryKernel => {
  const kernel = createMemoryKernel({ dbPath: join(scratch, `${name}.db`), projectTimeZone: 'UTC' });
  kernels.push(kernel);
  return kernel;
};

afterAll(() => {
  for (const kernel of kernels) kernel.close();
});

const FACTS = [
  '我喜欢你回答得简短一点。',
  '我住在东京都世田谷区三丁目十二号。',
  '我每天早上七点起床。',
  '我对花生过敏。',
] as const;

const covered = (values: string[]): number => [
  values.some((value) => value.includes('简短')),
  values.some((value) => value.includes('世田谷')),
  values.some((value) => value.includes('七点')),
  values.some((value) => value.includes('花生')),
].filter(Boolean).length;

describe('profile extraction quality (#329)', () => {
  test('rule-only ingestion covers at least three of the four owner facts', async () => {
    const kernel = makeKernel('rule-only');
    const projectId = 'rule-only';
    for (const content of FACTS) await kernel.ingest({ content, projectId });

    kernel.profile.compile({ projectId });
    const entries = kernel.profile.entries({ projectId });
    const values = entries.map((entry) => entry.value);
    expect(covered(values)).toBe(4);
    expect(entries.find((entry) => entry.key.includes('address'))?.sourceRefs.length).toBeGreaterThan(0);
    expect(entries.find((entry) => entry.key.includes('allergic_to'))?.sourceRefs.length).toBeGreaterThan(0);
    expect(entries.find((entry) => entry.key.includes('wake_time'))?.sourceRefs.length).toBeGreaterThan(0);
  });

  test('model-produced belief evidence covers all four owner facts', () => {
    const kernel = makeKernel('model');
    const projectId = 'model';
    const beliefs = [
      ['likes', '简短回答'],
      ['lives_at', '东京都世田谷区三丁目十二号'],
      ['wakes_at', '早上七点'],
      ['allergic_to', '花生'],
    ] as const;
    for (const [index, [predicate, value]] of beliefs.entries()) {
      const event = kernel.recordRawEvent({ threadId: 'model-thread', projectId, role: 'user', content: `fact ${index}`, occurredAt: 1_000 + index });
      kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate,
        objectValue: { raw: value, type: 'string' },
        confidence: 0.9,
        sourceType: 'llm_inference',
        extractionReason: 'explicit_user_statement',
        sourceEventId: event.eventId,
        validFrom: 1_000 + index,
      });
    }

    kernel.profile.compile({ projectId });
    expect(covered(kernel.profile.entries({ projectId }).map((entry) => entry.value))).toBe(4);
  });
});
