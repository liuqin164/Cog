import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { MemoryGraph } from '../src/core/MemoryGraph.js';
import { createMemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

type IndexSnapshot = {
  time: Record<string, string[]>;
  project: Record<string, string[]>;
};

function snapshot(graph: MemoryGraph): IndexSnapshot {
  const index = graph as unknown as {
    timeIndex: Map<string, Set<string>>;
    projectIndex: Map<string, Set<string>>;
  };
  const dump = (map: Map<string, Set<string>>): Record<string, string[]> =>
    Object.fromEntries(
      [...map.entries()]
        .map(([key, ids]) => [key, [...ids].sort()] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  return { time: dump(index.timeIndex), project: dump(index.projectIndex) };
}

describe('MemoryGraph resident indexes follow deletion (#227)', () => {
  test('range deletion drops the id from the time, project and reflection indexes', async () => {
    const dir = makeTempDir('cogmem-index-cleanup-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
    try {
      const createdAt = Date.UTC(2026, 0, 20, 12);
      const before = Date.now();
      const doomed = await kernel.ingest({
        projectId: 'index-doomed',
        content: 'delete this memory',
        createdAt,
        topicPath: 'PROJECT/index-doomed/topic-a',
      });
      const survivor = await kernel.ingest({
        projectId: 'index-survivor',
        content: 'keep this memory',
        createdAt: createdAt + 86_400_000,
      });
      const after = Date.now();

      const dateKey = new Date(createdAt).toDateString();
      expect(kernel.memoryGraph.getNeuronIdsByProject('index-doomed')).toContain(doomed.id);
      expect(snapshot(kernel.memoryGraph).time[dateKey]).toContain(doomed.id);
      expect(kernel.topicRegistry.getTopicPaths('index-doomed')).toContain('PROJECT/index-doomed/topic-a');

      kernel.sovereignty.deleteRange({
        projectId: 'index-doomed',
        start: before,
        end: after + 1,
        reason: 'index cleanup discriminator',
      });

      expect(kernel.memoryGraph.getNeuronIdsByProject('index-doomed')).not.toContain(doomed.id);
      expect(snapshot(kernel.memoryGraph).time[dateKey] ?? []).not.toContain(doomed.id);
      expect(kernel.topicRegistry.getTopicPaths('index-doomed')).not.toContain('PROJECT/index-doomed/topic-a');
      expect(kernel.memoryGraph.getNeuronIdsByProject('index-survivor')).toContain(survivor.id);

      const reflection = (kernel as unknown as { reflection: { activationLog: Map<string, number[]> } }).reflection;
      expect(reflection.activationLog.has(doomed.id)).toBe(false);
    } finally {
      kernel.close();
    }
  });

  test('incremental removal after deletion matches a full rebuild', async () => {
    const dir = makeTempDir('cogmem-index-rebuild-');
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
    try {
      const before = Date.now();
      await kernel.ingest({ projectId: 'index-rebuild-a', content: 'first', createdAt: Date.UTC(2026, 0, 2) });
      await kernel.ingest({ projectId: 'index-rebuild-a', content: 'second', createdAt: Date.UTC(2026, 0, 3) });
      const survivor = await kernel.ingest({
        projectId: 'index-rebuild-b',
        content: 'third',
        createdAt: Date.UTC(2026, 0, 2),
      });

      kernel.sovereignty.deleteRange({
        projectId: 'index-rebuild-a',
        start: before,
        end: Date.now() + 1,
        reason: 'incremental maintenance discriminator',
      });
      const incremental = snapshot(kernel.memoryGraph);

      kernel.memoryGraph.rebuildIndexes();
      expect(snapshot(kernel.memoryGraph)).toEqual(incremental);
      expect(kernel.memoryGraph.getNeuronIdsByProject('index-rebuild-b')).toEqual([survivor.id]);
    } finally {
      kernel.close();
    }
  });
});
