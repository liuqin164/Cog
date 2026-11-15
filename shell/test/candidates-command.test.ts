import { describe, expect, test } from 'bun:test';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

describe('/candidates', () => {
  test('reports the kernel queue counts, candidate types and review states', async () => {
    const dir = makeTempDir();
    const shell = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]));
    try {
      const db = shell.kernel.factStore.getDatabase();
      db.prepare(`
        INSERT INTO deep_write_runs(run_id,project_id,source_neuron_ids_json,mode,prompt_hash,output_hash,status,created_at,updated_at)
        VALUES('run-1',?,'[]','normal','p','o','succeeded',1,1)
      `).run(shell.config.projectId);
      const insert = db.prepare(`
        INSERT INTO deep_write_candidates(candidate_id,run_id,candidate_type,status,confidence,content_json,evidence_json,status_reason,created_at,updated_at)
        VALUES(?, 'run-1', ?, ?, 0.72, '{}', '[]', ?, 1, 1)
      `);
      insert.run('cand-preference', 'preferences', 'candidate', 'evidence_backed');
      insert.run('cand-correction', 'correction', 'needs_confirmation', 'ambiguous_target');

      const reply = await shell.runCommand('candidates');

      expect(reply.text).toContain('候选队列：待治理 1 · 待确认 1');
      expect(reply.text).toContain('来源（候选类型）：');
      expect(reply.text).toContain('preferences 1');
      expect(reply.text).toContain('correction 1');
      expect(reply.text).toContain('未结候选 2 条');
      expect(reply.text).toContain('preferences · candidate · 置信度 0.72 · evidence_backed');
      expect(reply.text).toContain('correction · needs_confirmation · 置信度 0.72 · ambiguous_target');
      expect(reply.data?.companion_candidates).toBeDefined();
    } finally {
      await shell.stop();
    }
  });
});
