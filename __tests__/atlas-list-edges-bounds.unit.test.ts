import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

test('listEdges bounds action frames and fetches their evidence without N+1', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-atlas-edge-bounds-'), 'memory.db') });
  try {
    const store = kernel.memoryAtlasStore;
    const insertFrame = store.db.prepare(`
      INSERT INTO memory_action_frames(
        action_id, project_id, frame_type, action, actor, target_entity_id, occurred_at,
        confidence, created_at, updated_at
      ) VALUES(?, 'p', 'action', '更新', 'user', 'target', ?, 1, ?, ?)
    `);
    const insertEvidence = store.db.prepare(`
      INSERT INTO memory_action_frame_evidence(action_id, event_id, project_id, created_at) VALUES(?, ?, 'p', ?)
    `);
    store.db.transaction(() => {
      for (let i = 0; i < 2500; i += 1) {
        insertFrame.run(`act-${i}`, 1_700_000_000_000 + i, i, i);
        insertEvidence.run(`act-${i}`, `evt-${i}`, i);
      }
    })();

    let prepared = 0;
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => {
      prepared += 1;
      return prepare(sql);
    }) as typeof store.db.prepare;

    const listed = store.listEdges('p');
    expect(listed.edges.length).toBe(4000);
    expect(listed.omitted).toBe(0);
    expect(prepared).toBeLessThanOrEqual(5);
    const actionEdge = listed.edges.find((edge) => edge.relation === 'TARGETS');
    expect(actionEdge?.evidenceEventIds).toHaveLength(1);

    const narrowed = store.listEdges('p', 100);
    expect(narrowed.edges.length).toBe(100);
    expect(narrowed.omitted).toBe(3900);
  } finally {
    kernel.close();
  }
});
