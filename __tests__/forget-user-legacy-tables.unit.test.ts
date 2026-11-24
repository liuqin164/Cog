import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { createMemoryKernel } from '../src/factory.js';
import { assertPrivacySchemaClassified } from '../src/governance/PrivacyDeletionRegistry.js';
import { makeTempDir } from './helpers/tmp.js';

const LEGACY_TABLES = [
  '_episode_integrity_markers',
  'entity_scope_migration_quarantine',
  'memory_activation',
  'pending_entity_resolution_quarantine',
  'pipeline_checkpoints',
  'policy_execution_audit_outbox',
  'policy_execution_legacy_tombstones',
  'policy_execution_quarantine',
  'policy_execution_read_model',
  'policy_executions',
  'policy_projection_state',
  'projection_event_discard_receipts',
  'runtime_event_outbox',
  'runtime_projection_state',
  'runtime_projection_states',
  'runtime_projection_transitions',
  'runtime_scope_discard_receipts',
  'runtime_states',
  'runtime_transitions',
];

test('#521 forgetUser tolerates empty legacy tables from a 5.0 development database', async () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('forget-legacy-'), 'memory.sqlite'), projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    for (const table of LEGACY_TABLES) db.exec(`CREATE TABLE ${table} (id TEXT)`);
    expect(() => assertPrivacySchemaClassified(LEGACY_TABLES)).not.toThrow();
    kernel.recordRawEvent({
      projectId: 'legacy-project',
      threadId: 'legacy-thread',
      role: 'user',
      content: 'legacy token',
      occurredAt: Date.now(),
    });

    const result = await kernel.forgetUser('legacy-project');

    expect(result.deleted.events).toBeGreaterThanOrEqual(1);
    for (const table of LEGACY_TABLES) {
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)).toBeTruthy();
    }
  } finally {
    kernel.close();
  }
});

test('#521 an unclassified non-legacy table still fails the classification assertion', async () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('forget-unknown-'), 'memory.sqlite'), projectTimeZone: 'UTC' });
  try {
    const db = kernel.factStore.getDatabase();
    db.exec(`CREATE TABLE brand_new_unclassified (id TEXT)`);
    kernel.recordRawEvent({
      projectId: 'unknown-project',
      threadId: 'unknown-thread',
      role: 'user',
      content: 'unknown token',
      occurredAt: Date.now(),
    });

    expect(() => assertPrivacySchemaClassified(['brand_new_unclassified'])).toThrow('privacy_schema_unclassified');
    await expect(kernel.forgetUser('unknown-project')).rejects.toThrow('privacy_schema_unclassified');
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='brand_new_unclassified'`).get()).toBeTruthy();
  } finally {
    kernel.close();
  }
});
