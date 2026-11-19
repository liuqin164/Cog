import { describe, expect, test } from 'bun:test';

import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const NO_DREAM = { windowStartHour: 0, windowEndHour: 0, runKernelNight: false, maxEpisodes: 5 };

describe('Atlas on the companion recall path (#356)', () => {
  test('a real shell recall rebuilds a stale Atlas and records the node it returned', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '七年。', toolCalls: [] }]);
    const shell = makeShell(dir, provider, {
      dream: NO_DREAM,
      projectId: 'p',
      agentId: 'a',
      sessionId: 's',
    });
    await shell.start();
    try {
      const old = Date.now() - 2 * 60 * 60 * 1000;
      for (let index = 0; index < 4; index += 1) {
        shell.kernel.appendEpisodeMessage({
          projectId: 'p',
          sessionId: `past-${index}`,
          sourceAgent: 'a',
          role: 'user',
          text: `我们决定把归档保留期定成七年，第八年统一销毁（第 ${index} 次确认）。`,
          timestamp: old + index * 1000,
        });
        shell.kernel.appendEpisodeMessage({
          projectId: 'p',
          sessionId: `past-${index}`,
          sourceAgent: 'a',
          role: 'assistant',
          text: '记下了：归档保留期七年。',
          timestamp: old + index * 1000 + 500,
        });
      }
      shell.kernel.runMaintenanceTick({ projectId: 'p', now: Date.now(), atlasRefresh: false });
      expect(shell.kernel.memoryAtlasStore.countDocuments('p')).toBe(0);
      shell.kernel.memoryAtlasStore.db.prepare(`
        UPDATE memory_atlas_projection_state SET last_rebuild_at=? WHERE project_id=? AND projection_name='memory_atlas.v2'
      `).run(Date.now() - 2 * DAY, 'p');

      await shell.submit('归档保留期定成七年，是第几年销毁？');

      expect(provider.calls.length).toBe(1);
      expect(shell.kernel.memoryAtlasStore.countDocuments('p')).toBeGreaterThan(0);

      const recall = shell.backend.recall({
        agentId: 'a',
        projectId: 'p',
        query: '归档保留期定成七年，是第几年销毁？',
        limit: 4,
      });
      const atlasItem = recall.items.find((item) => item.tags.includes('atlas_node'));
      expect(atlasItem?.displayTitle).toContain('归档保留期');
      const atlasNode = atlasItem!.canonicalId!;

      const access = shell.kernel.memoryAtlasStore.db.prepare(`
        SELECT access_kind FROM memory_atlas_access WHERE project_id=? AND node_id=?
      `).all('p', atlasNode) as Array<{ access_kind: string }>;
      expect(access.map((row) => row.access_kind)).toContain('recall_hit');
      const activation = shell.kernel.memoryAtlasStore.db.prepare(`
        SELECT usage_count FROM memory_atlas_activation WHERE project_id=? AND node_id=?
      `).get('p', atlasNode) as { usage_count: number } | null;
      expect(activation?.usage_count).toBeGreaterThan(0);
    } finally {
      await shell.stop();
    }
  });

  test('a shell recall builds an Atlas that was never built (#361)', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: '七年。', toolCalls: [] }]);
    const shell = makeShell(dir, provider, {
      dream: NO_DREAM,
      projectId: 'p',
      agentId: 'a',
      sessionId: 's',
    });
    await shell.start();
    try {
      const old = Date.now() - 2 * 60 * 60 * 1000;
      shell.kernel.appendEpisodeMessage({
        projectId: 'p',
        sessionId: 'past',
        sourceAgent: 'a',
        role: 'user',
        text: '我们决定把归档保留期定成七年，第八年统一销毁。',
        timestamp: old,
      });
      shell.kernel.appendEpisodeMessage({
        projectId: 'p',
        sessionId: 'past',
        sourceAgent: 'a',
        role: 'assistant',
        text: '记下了：归档保留期七年。',
        timestamp: old + 500,
      });
      shell.kernel.runMaintenanceTick({ projectId: 'p', now: Date.now(), atlasRefresh: false });
      expect(shell.kernel.memoryAtlasStore.getProjectionState('p')?.lastRebuildAt).toBeUndefined();
      expect(shell.kernel.memoryAtlasStore.countDocuments('p')).toBe(0);

      await shell.submit('归档保留期定成七年，是第几年销毁？');

      expect(provider.calls.length).toBe(1);
      expect(shell.kernel.memoryAtlasStore.getProjectionState('p')?.lastRebuildAt).toBeNumber();
      expect(shell.kernel.memoryAtlasStore.countDocuments('p')).toBeGreaterThan(0);
    } finally {
      await shell.stop();
    }
  });
});
