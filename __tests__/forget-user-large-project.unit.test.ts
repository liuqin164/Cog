import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

test('#407 forgetUser deletes a project above the SQL variable limit', async () => {
  const dir = makeTempDir('forget-large-project-');
  const projectId = 'forget-large-project';
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    const insert = db.prepare(`INSERT INTO memory_events (
      event_id, stream_id, stream_type, event_type, event_version, project_id, project_scope,
      occurred_at, payload_json, payload_hash
    ) VALUES (?, ?, 'thread', 'RAW_EVENT_RECORDED', 1, ?, ?, ?, '{}', 'hash')`);
    db.transaction(() => {
      for (let index = 0; index < 65_536; index += 1) {
        insert.run(`event-${index}`, `stream-${index}`, projectId, projectId, index);
      }
    })();
    db.prepare(`INSERT INTO facts (
      fact_id, neuron_id, subject, predicate_family, valid_from, certainty_level, confidence, status, source_text
    ) VALUES ('fact-large', 'event-0', 'subject', 'object', 1, 'certain', 1, 'active', 'text')`).run();

    const result = await kernel.forgetUser(projectId);

    expect(result.deleted.events).toBe(65_536);
    expect(result.deleted.facts).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM memory_events WHERE COALESCE(project_id,'') = ?`).get(projectId))
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM facts WHERE neuron_id = 'event-0'`).get()).toEqual({ count: 0 });
  } finally {
    kernel.close();
  }
}, 120_000);
