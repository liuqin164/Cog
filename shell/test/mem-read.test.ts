/**
 * #252 B2: a memory key is drilled down through `read`, not through bash.
 *
 * The key is the eventId the digest's `sourceRefs` and a recall item's `anchorEvent` already carry.
 * `read mem:<eventId>` resolves it through the kernel's read face, keeps the same 256 KiB cap as a
 * file read, and is idempotent, so recovery may replay it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanionShell } from '../src/app.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const NO_DREAM = { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 };
const EVENT_TEXT = '部署窗口是周二凌晨两点，「周五不能部署」；预算 120,000 日元。';

/** The key a context stub hands a model: the digest entry's own sourceRef, from a real captured turn. */
async function digestKey(shell: CompanionShell): Promise<{ key: string; text: string }> {
  await shell.submit(EVENT_TEXT);
  await shell.submit('第二条。');
  const digest = shell.backend.sessionDigest({
    projectId: shell.config.projectId,
    agentId: shell.config.agentId,
    sessionId: shell.config.sessionId,
    tailTurns: 2,
  });
  const entry = digest.entries[0];
  expect(entry).toBeDefined();
  return { key: entry!.sourceRefs[0]!, text: entry!.text };
}

describe('read mem:<eventId>', () => {
  test('a digest sourceRef opens the ledger row verbatim', async () => {
    const shell = makeShell(
      makeTempDir('mem-read-'),
      new ScriptedProvider([{ text: '收到一。', toolCalls: [] }, { text: '收到二。', toolCalls: [] }]),
      { dream: NO_DREAM },
    );
    await shell.start();
    try {
      const { key, text } = await digestKey(shell);
      expect(text).toBe(EVENT_TEXT);
      const result = await shell.host.tools.invoke('read', { toolCallId: 'c1', input: { path: `mem:${key}` } }, { runId: 'r' });
      expect(result.isError).toBe(false);
      expect(result.output).toBe(EVENT_TEXT);
    } finally {
      await shell.stop();
    }
  });

  test('the model drills down with read alone, no bash', async () => {
    let key = '';
    const provider = new ScriptedProvider([
      { text: '收到一。', toolCalls: [] },
      { text: '收到二。', toolCalls: [] },
      () => ({ text: 'drill', toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: `mem:${key}` } }] }),
      { text: 'done', toolCalls: [] },
    ]);
    const shell = makeShell(makeTempDir('mem-read-model-'), provider, { dream: NO_DREAM });
    await shell.start();
    try {
      key = (await digestKey(shell)).key;
      const summary = await shell.submit('刚才那条部署窗口的原话是什么');
      expect(summary!.toolResults).toHaveLength(1);
      expect(summary!.toolResults[0]!.toolName).toBe('read');
      expect(summary!.toolResults[0]!.isError).toBe(false);
      expect(summary!.toolResults[0]!.output).toBe(EVENT_TEXT);
      expect(summary!.toolResults.some((result) => result.toolName === 'bash')).toBe(false);
    } finally {
      await shell.stop();
    }
  });

  test('a write or edit through a mem: path is refused, traced, and leaves no file', async () => {
    const shell = makeShell(makeTempDir('mem-read-write-'), new ScriptedProvider([{ text: 'idle', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      const event = shell.kernel.recordRawEvent({ projectId: shell.config.projectId, threadId: 'write-target', role: 'user', content: 'ledger row' });
      const path = `mem:${event.eventId}`;
      const wrote = await shell.host.tools.invoke('write', { toolCallId: 'c1', input: { path, content: 'tampered' } }, { runId: 'r' });
      expect(wrote.isError).toBe(true);
      expect(wrote.output).toContain('read_only_memory_path');
      const edited = await shell.host.tools.invoke('edit', { toolCallId: 'c2', input: { path, old_string: '周二', new_string: '周三' } }, { runId: 'r' });
      expect(edited.isError).toBe(true);
      expect(edited.output).toContain('read_only_memory_path');
      expect(existsSync(join(shell.config.workspaceRoot, path))).toBe(false);
      const refused = shell.trace.read().filter((record) => record.kind === 'memory_path_write_refused');
      expect(refused.map((record) => record.tool)).toEqual(['write', 'edit']);
    } finally {
      await shell.stop();
    }
  });

  test('an event that does not exist is an error that names the mem: path, not an empty success', async () => {
    const shell = makeShell(makeTempDir('mem-read-missing-'), new ScriptedProvider([{ text: 'idle', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      const result = await shell.host.tools.invoke('read', { toolCallId: 'c1', input: { path: 'mem:evt-does-not-exist' } }, { runId: 'r' });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('memory_event_not_found');
      expect(result.output).toContain('mem:<eventId>');
    } finally {
      await shell.stop();
    }
  });

  test('an event past 256 KiB is cut at the cap, and the cut is traced', async () => {
    const shell = makeShell(makeTempDir('mem-read-big-'), new ScriptedProvider([{ text: 'idle', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      const big = '日'.repeat(100_000); // 300 000 bytes, past the 262 144-byte cap
      const event = shell.kernel.recordRawEvent({
        projectId: shell.config.projectId,
        threadId: 'bulk',
        role: 'user',
        content: big,
      });
      const result = await shell.host.tools.invoke('read', { toolCallId: 'c1', input: { path: `mem:${event.eventId}` } }, { runId: 'r' });
      expect(result.isError).toBe(false);
      expect(result.output.startsWith('日')).toBe(true);
      expect(result.output).toContain('[memory event truncated:');
      expect(result.output).not.toContain('\uFFFD');
      const record = shell.trace.read().find((entry) => entry.kind === 'memory_read_truncated');
      expect(record?.eventId).toBe(event.eventId);
      expect(record?.cap).toBe(256 * 1024);
    } finally {
      await shell.stop();
    }
  });

  test('a workspace file still reads exactly as before', async () => {
    const shell = makeShell(makeTempDir('mem-read-file-'), new ScriptedProvider([{ text: 'idle', toolCalls: [] }]), { dream: NO_DREAM });
    await shell.start();
    try {
      writeFileSync(join(shell.config.workspaceRoot, 'notes.txt'), 'plain file\n', 'utf8');
      const result = await shell.host.tools.invoke('read', { toolCallId: 'c1', input: { path: 'notes.txt' } }, { runId: 'r' });
      expect(result.isError).toBe(false);
      expect(result.output).toBe('plain file\n');
    } finally {
      await shell.stop();
    }
  });
});
