import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

const DAY = 24 * 60 * 60 * 1000;

function seedClosedEpisode(kernel: MemoryKernel): string {
  const old = Date.now() - 2 * 60 * 60 * 1000;
  const user = kernel.appendEpisodeMessage({
    projectId: 'p',
    sessionId: 's',
    sourceAgent: 'a',
    role: 'user',
    text: '我们决定把归档保留期定成七年，第八年统一销毁。',
    timestamp: old,
  });
  kernel.appendEpisodeMessage({
    projectId: 'p',
    sessionId: 's',
    sourceAgent: 'a',
    role: 'assistant',
    text: '记下了：归档保留期七年。',
    timestamp: old + 1000,
  });
  kernel.runMaintenanceTick({ projectId: 'p', now: Date.now(), atlasRefresh: false });
  return user.episodeId!;
}

test('a recall rebuilds an Atlas left dirty for a day and records the hit', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-atlas-recall-refresh-'), 'memory.db') });
  try {
    const episodeId = seedClosedEpisode(kernel);
    expect(kernel.memoryAtlasStore.countDocuments('p')).toBe(0);
    kernel.memoryAtlasStore.db.prepare(`
      UPDATE memory_atlas_projection_state SET last_rebuild_at=? WHERE project_id=? AND projection_name='memory_atlas.v2'
    `).run(Date.now() - 2 * DAY, 'p');

    const result = new KernelAgentMemoryBackend(kernel).recall({
      agentId: 'a', projectId: 'p', query: '归档保留期', limit: 4, now: Date.now(),
    });

    expect(kernel.memoryAtlasStore.getProjectionState('p')?.status).toBe('clean');
    expect(kernel.memoryAtlasStore.countDocuments('p')).toBeGreaterThan(0);
    expect(episodeId).toBeString();
    const item = result.items.find((candidate) => candidate.tags.includes('atlas_node'));
    expect(item?.displayTitle).toContain('归档保留期');
    expect(item?.canonicalId).toBeString();

    const access = kernel.memoryAtlasStore.db.prepare(`
      SELECT node_id FROM memory_atlas_access WHERE project_id=? AND access_kind='recall_hit'
    `).all('p') as Array<{ node_id: string }>;
    expect(access.map((row) => row.node_id)).toContain(item!.canonicalId!);
    const activation = kernel.memoryAtlasStore.db.prepare(`
      SELECT usage_count FROM memory_atlas_activation WHERE project_id=? AND node_id=?
    `).get('p', item!.canonicalId!) as { usage_count: number } | null;
    expect(activation?.usage_count).toBeGreaterThan(0);
  } finally {
    kernel.close();
  }
});

test('a recall within the day leaves a dirty Atlas for the nightly pass', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-atlas-recall-recent-'), 'memory.db') });
  try {
    seedClosedEpisode(kernel);
    kernel.memoryAtlasStore.db.prepare(`
      UPDATE memory_atlas_projection_state SET last_rebuild_at=? WHERE project_id=? AND projection_name='memory_atlas.v2'
    `).run(Date.now() - 60_000, 'p');

    new KernelAgentMemoryBackend(kernel).recall({
      agentId: 'a', projectId: 'p', query: '归档保留期', limit: 4, now: Date.now(),
    });

    expect(kernel.memoryAtlasStore.getProjectionState('p')?.status).toBe('dirty');
    expect(kernel.memoryAtlasStore.countDocuments('p')).toBe(0);
  } finally {
    kernel.close();
  }
});

test('a recall builds an Atlas that was never built', () => {
  const kernel = createMemoryKernel({ dbPath: join(makeTempDir('cogmem-atlas-recall-first-'), 'memory.db') });
  try {
    seedClosedEpisode(kernel);
    kernel.memoryAtlasStore.db.prepare(`
      UPDATE memory_atlas_projection_state SET last_rebuild_at=NULL WHERE project_id=? AND projection_name='memory_atlas.v2'
    `).run('p');
    expect(kernel.memoryAtlasStore.getProjectionState('p')?.lastRebuildAt).toBeUndefined();
    expect(kernel.memoryAtlasStore.countDocuments('p')).toBe(0);

    const result = new KernelAgentMemoryBackend(kernel).recall({
      agentId: 'a', projectId: 'p', query: '归档保留期', limit: 4, now: Date.now(),
    });

    const state = kernel.memoryAtlasStore.getProjectionState('p');
    expect(state?.status).toBe('clean');
    expect(state?.lastRebuildAt).toBeNumber();
    expect(kernel.memoryAtlasStore.countDocuments('p')).toBeGreaterThan(0);
    expect(result.items.some((candidate) => candidate.tags.includes('atlas_node'))).toBe(true);
  } finally {
    kernel.close();
  }
});
