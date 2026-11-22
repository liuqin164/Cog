import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { AgentRecallEngine } from '../src/agent/AgentRecallEngine.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

test('#413 the term frequency cache refreshes when the ledger grows', () => {
  const dir = makeTempDir('recall-term-frequency-');
  const projectId = 'term-frequency';
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
  try {
    const record = (content: string, occurredAt: number) =>
      kernel.recordRawEvent({ projectId, threadId: 'frequency-thread', role: 'user', content, occurredAt });
    record('zeta rareword', 1);
    const engine = new AgentRecallEngine(kernel);
    const read = () => (engine as unknown as {
      queryTermFrequencies(query: unknown): { frequent: Set<string>; rare: Set<string> };
    }).queryTermFrequencies({ query: 'rareword', projectId });

    expect(read().rare.has('rareword')).toBe(true);
    expect(read().frequent.has('rareword')).toBe(false);

    record('rareword', 2);
    record('rareword', 3);

    expect(read().frequent.has('rareword')).toBe(true);
    expect(read().rare.has('rareword')).toBe(false);
  } finally {
    kernel.close();
  }
});
