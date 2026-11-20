import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel } from '../src/factory.js';
import {
  EXPLICIT_EXCLUSION_INLINE_CLOSE as CLOSE,
  EXPLICIT_EXCLUSION_INLINE_OPEN as OPEN,
  EXPLICIT_EXCLUSION_WHOLE_TURN as WHOLE,
} from '../src/context/ExplicitExclusion.js';
import { makeTempDir } from './helpers/tmp.js';

const SCOPE = { agentId: 'hermes-agent', projectId: 'proj-hermes', sessionId: 'hermes-session' };

function fixture() {
  const dir = makeTempDir('cogmem-explicit-exclusion-');
  const kernel = createMemoryKernel({ dbPath: join(dir, 'brain.db'), vectorBackend: 'sqlite-vec' });
  return { kernel, memory: new KernelAgentMemoryBackend(kernel) };
}

/**
 * #133: marked text is never stored — not "stored and hidden". So the check is the store itself, not recall:
 * every text surface in the database is searched for the passage. Recall is asserted as well, but it is the
 * weaker statement.
 */
function storeContains(kernel: ReturnType<typeof createMemoryKernel>, needle: string): string[] {
  const db = kernel.factStore.getDatabase();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
  const hits: string[] = [];
  for (const table of tables) {
    let rows: unknown[];
    try { rows = db.prepare(`SELECT * FROM "${table}"`).all(); } catch { continue; }
    if (JSON.stringify(rows).includes(needle)) hits.push(table);
  }
  return hits;
}

test('a marked span never reaches the store, and the rest of the turn does', async () => {
  const { kernel, memory } = fixture();
  try {
    const secret = 'my private medical note';
    await memory.rememberTurn({
      ...SCOPE,
      userText: `Public part before. ${OPEN}${secret}${CLOSE} Public part after.`,
      assistantText: 'Understood.',
    });

    // The passage is nowhere: not the ledger, not a neuron, not the FTS index.
    expect(storeContains(kernel, secret)).toEqual([]);
    // The rest of the same turn landed normally and is recallable.
    expect(storeContains(kernel, 'Public part before.').length).toBeGreaterThan(0);
    const recalled = memory.recall({ agentId: 'hermes-agent', projectId: 'proj-hermes', query: 'public part before', limit: 5 });
    expect(recalled.items.length).toBeGreaterThan(0);
  } finally {
    kernel.close();
  }
});

test('sending the same text without the marker stores it, so exclusion leaves no state behind', async () => {
  const { kernel, memory } = fixture();
  try {
    const prose = 'a passage that was excluded once';
    await memory.rememberTurn({ ...SCOPE, userText: `${OPEN}${prose}${CLOSE}`, assistantText: 'ok' });
    expect(storeContains(kernel, prose)).toEqual([]);
    await memory.rememberTurn({ ...SCOPE, userText: prose, assistantText: 'ok' });
    expect(storeContains(kernel, prose).length).toBeGreaterThan(0);
  } finally {
    kernel.close();
  }
});

test('the whole-turn marker keeps the user turn out of the store', async () => {
  const { kernel, memory } = fixture();
  try {
    const prose = 'everything here is off the record';
    await memory.rememberTurn({ ...SCOPE, userText: `${prose} ${WHOLE}`, assistantText: 'ok' });
    expect(storeContains(kernel, prose)).toEqual([]);
  } finally {
    kernel.close();
  }
});
