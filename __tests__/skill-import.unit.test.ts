import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KernelAgentMemoryBackend } from '../src/agent/AgentMemoryBackend.js';
import { runHermesImport, runOpenClawImport } from '../src/bin/import-support.js';
import { createMemoryKernel, type MemoryKernel } from '../src/factory.js';
import { makeTempDir } from './helpers/tmp.js';

/**
 * #266: a SKILL.md enters through the existing import channel, carries `metadata.imported`, and
 * compiles into the procedure book as an `imported` guide that recall puts after an own practice.
 * The file is named explicitly — there is no directory to mount or scan.
 */

const scratch = makeTempDir('cogmem-skill-import-');

const SKILL = [
  '---',
  'name: publish',
  'domain: 发布',
  'description: >',
  '  发布 npm 包（导入手册）',
  'allowed-tools: bun npm',
  '---',
  '',
  '# Publish',
  '',
  '1. 跑测试',
  '2. bun run build',
  '3. npm publish --access public',
].join('\n');

function writeSkill(relativeDir: string): string {
  const dir = join(scratch, relativeDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, SKILL);
  return path;
}

function importedSkillEvent(kernel: MemoryKernel, projectId: string) {
  const { records } = kernel.eventStore.queryEvents(1, 100, {
    projectId: [projectId],
    eventType: ['RAW_EVENT_RECORDED'],
    order: 'asc',
  });
  return records.find((event) => {
    const metadata = (event.payload as { metadata?: Record<string, unknown> }).metadata;
    return metadata?.imported === true && metadata?.procedure !== undefined;
  });
}

function addNativePractice(kernel: MemoryKernel, projectId: string, occurredAt: number): void {
  kernel.recordTaskEvent({
    projectId,
    threadId: 'native-publish',
    role: 'system',
    content: 'task completed',
    occurredAt,
    metadata: {
      procedure: {
        domain: '发布',
        key: 'publish',
        title: '发布 npm 包',
        steps: ['跑测试', 'bun run build', 'npm publish'],
        tools: ['bun', 'npm'],
        outcome: 'succeeded',
      },
    },
  });
}

test('an openclaw import reads a named SKILL.md as an imported procedure guide', async () => {
  const workspace = join(scratch, 'openclaw-ws');
  mkdirSync(workspace, { recursive: true });
  const skillPath = writeSkill('openclaw-ws/skills/publish');
  const dbPath = join(scratch, 'openclaw.db');
  const projectId = 'skill-import-openclaw';

  await runOpenClawImport([
    '--workspace', workspace, '--project', projectId, '--db', dbPath, '--timezone', 'UTC',
    '--skill', skillPath, '--json',
  ]);

  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  try {
    const raw = importedSkillEvent(kernel, projectId);
    expect(raw).toBeDefined();
    const metadata = (raw!.payload as {
      metadata: { imported?: boolean; procedure?: { key?: string; steps?: unknown[] } };
    }).metadata;
    expect(metadata.imported).toBe(true);
    expect(metadata.procedure.key).toBe('publish');
    expect(metadata.procedure.steps).toEqual(['跑测试', 'bun run build', 'npm publish --access public']);

    kernel.procedures.compile({ projectId, now: 10_000 });
    const importedOnly = kernel.procedures.entries({ projectId });
    expect(importedOnly).toHaveLength(1);
    expect(importedOnly[0]!.origin).toBe('imported');
    expect(importedOnly[0]!.grade).toBe('tentative');

    // The #143 rule is untouched: another agent in the same project can read the import.
    const otherAgent = new KernelAgentMemoryBackend(kernel).recall({
      agentId: 'hermes', projectId, query: 'npm publish access public', limit: 5,
    });
    expect(otherAgent.items.map((item) => item.text).join(' ')).toContain('npm publish --access public');

    // #262's own attempt for the same domain/key; imported stays the lower-weighted layer.
    addNativePractice(kernel, projectId, 20_000);
    kernel.procedures.compile({ projectId, now: 21_000 });
    const recalled = kernel.procedures.recall({ projectId, task: '帮我发布 npm 包', now: 22_000 });
    expect(recalled.map((entry) => entry.origin)).toEqual(['experience', 'imported']);

    const assembled = kernel.procedures.assembleTask({ projectId, task: '帮我发布 npm 包', now: 22_000, targetTokens: 1_000 });
    const procedures = assembled.items.filter((item) => item.kind === 'procedure');
    expect(procedures).toHaveLength(2);
    expect(procedures[0]!.text).not.toContain('导入手册');
    expect(procedures[1]!.text).toContain('导入手册');

    // The surfacing lane re-sorts by its own keys, so the imported penalty must hold there too.
    const surfaced = kernel.surfacing.candidates({
      projectId, channel: 'asked', query: '帮我发布 npm 包', now: 22_000,
    }).candidates.filter((candidate) => candidate.source === 'procedure');
    expect(surfaced).toHaveLength(2);
    expect(surfaced[0]!.content).not.toContain('导入手册');
    expect(surfaced[1]!.content).toContain('导入手册');
  } finally {
    kernel.close();
  }
});

test('the hermes importer accepts the same named skill without a hermes workspace', async () => {
  const workspace = join(scratch, 'hermes-ws');
  mkdirSync(workspace, { recursive: true });
  const skillPath = writeSkill('hermes-ws/skills/publish');
  const dbPath = join(scratch, 'hermes.db');
  const projectId = 'skill-import-hermes';

  await runHermesImport([
    '--workspace', workspace, '--project', projectId, '--db', dbPath, '--timezone', 'UTC',
    '--skill', skillPath, '--json',
  ]);

  const kernel = createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  try {
    const raw = importedSkillEvent(kernel, projectId);
    expect(raw).toBeDefined();
    kernel.procedures.compile({ projectId, now: 1_000 });
    expect(kernel.procedures.entries({ projectId }).map((entry) => entry.origin)).toEqual(['imported']);
  } finally {
    kernel.close();
  }
});
