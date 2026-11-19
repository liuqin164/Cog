import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

function fixture(prefix: string) {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir(prefix), 'memory.db') });
  return { kernel, backend: new KernelAgentMemoryBackend(kernel) };
}

function texts(backend: KernelAgentMemoryBackend, projectId: string, query: string, limit = 5): string {
  return backend.recall({ agentId: 'a', projectId, query, limit }).items.map((item) => item.text).join('\n');
}

describe('Issue #72: supersession on the recall surface', () => {
  test('raw recall does not leak a superseded value', async () => {
    const { kernel, backend } = fixture('cogmem-supersession-');
    try {
      await backend.rememberTurn({ agentId: 'a', projectId: 'p', sessionId: 's', userText: 'The deployment window for beacon is scheduled on day 3. Ticket OLD-123.' });
      await backend.rememberTurn({ agentId: 'a', projectId: 'p', sessionId: 's', userText: 'Correction: the deployment window for beacon is now scheduled on day 17. Ticket NEW-456.' });
      const result = texts(backend, 'p', 'When is the deployment window for beacon now scheduled?');
      expect(result).toContain('NEW-456');
      expect(result).not.toContain('OLD-123');
    } finally {
      kernel.close();
    }
  });

  test('different hostIds do not supersede each other (#65)', async () => {
    const { kernel, backend } = fixture('cogmem-supersession-isolation-');
    try {
      await backend.rememberTurn({ agentId: 'a', projectId: 'p', sessionId: 's-a', userText: 'The deployment window for atlas is on day 5. Ticket A-100.' });
      await backend.rememberTurn({ agentId: 'b', projectId: 'p', sessionId: 's-b', userText: 'Correction: the deployment window for atlas is on day 10. Ticket B-200.' });
      const fromA = backend.recall({ agentId: 'a', projectId: 'p', query: 'When is the deployment window for atlas?', limit: 5 }).items.map((item) => item.text).join('\n');
      const fromB = backend.recall({ agentId: 'b', projectId: 'p', query: 'When is the deployment window for atlas?', limit: 5 }).items.map((item) => item.text).join('\n');
      expect(fromA).toContain('A-100');
      expect(fromA).not.toContain('B-200');
      expect(fromB).toContain('B-200');
      expect(fromB).not.toContain('A-100');
    } finally {
      kernel.close();
    }
  });

  test('the untagged rule_only default path still supersedes', async () => {
    const { kernel, backend } = fixture('cogmem-untagged-supersession-');
    try {
      await backend.rememberTurn({ agentId: '', projectId: 'p', sessionId: 's', userText: 'The index rebuild for atlas was scheduled on day 9. Ticket OLD-UNTAGGED.' });
      await backend.rememberTurn({ agentId: '', projectId: 'p', sessionId: 's', userText: 'Correction: the index rebuild for atlas is now scheduled on day 10. Ticket NEW-UNTAGGED.' });
      const result = backend.recall({ agentId: '', projectId: 'p', query: 'When is the index rebuild for atlas now scheduled?', limit: 5 }).items.map((item) => item.text).join('\n');
      expect(result).toContain('NEW-UNTAGGED');
      expect(result).not.toContain('OLD-UNTAGGED');
    } finally {
      kernel.close();
    }
  });

  test('a correction the ranker buried is resolved before truncation', async () => {
    const { kernel, backend } = fixture('cogmem-buried-correction-');
    try {
      await backend.rememberTurn({ agentId: 'a', projectId: 'p', sessionId: 's', userText: 'The retention sweep for flint was scheduled on day 2. Ticket OLD-BURIED.' });
      for (let index = 0; index < 6; index += 1) {
        await backend.rememberTurn({ agentId: 'a', projectId: 'p', sessionId: 's', userText: `The retention sweep for team-${index} is scheduled on day ${10 + index}. Ticket D-${index}.` });
      }
      await backend.rememberTurn({ agentId: 'a', projectId: 'p', sessionId: 's', userText: 'Correction: the retention sweep for flint is now scheduled on day 3. Ticket NEW-BURIED.' });
      const result = texts(backend, 'p', 'When is the retention sweep for flint now scheduled?', 3);
      expect(result).not.toContain('OLD-BURIED');
    } finally {
      kernel.close();
    }
  });
});
