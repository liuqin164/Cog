/**
 * The three memory-sovereignty entry points (#232): `/forget` previews then deletes a window
 * through F9's `deleteRange`, `/export` writes F9's archive and answers with its path, and
 * `/correct` goes through the profile face so the next recall reads the new value.
 *
 * Each test drives the resident's real `runCommand`, so the command table, the handler and the
 * kernel face are the same ones a user reaches.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

const PROJECT = 'companion-test';
const DAY = 86_400_000;

async function startedShell(dir: string) {
  const shell = makeShell(dir, new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
  await shell.start();
  return shell;
}

describe('/forget deletes one previewed window and leaves an audit row', () => {
  test('preview shows the range and count; confirm removes the range from recall; audit names it', async () => {
    const dir = makeTempDir();
    const shell = await startedShell(dir);
    try {
      const base = Date.UTC(2026, 0, 10);
      const marker = 'zz-forget-marker';
      const kept = 'zz-kept-marker';
      const lane = { captureLane: 'conversation', sourceAgent: shell.config.agentId, speaker: 'owner', channel: 'chat' };
      const sourceId = `${shell.config.agentId}:${shell.config.sessionId}`;
      const inside = shell.kernel.recordRawEvent({
        projectId: PROJECT,
        threadId: 'forget-thread',
        sessionId: shell.config.sessionId,
        sourceId,
        role: 'user',
        content: `${marker} 我喜欢喝乌龙茶。`,
        occurredAt: base + 1_000,
        metadata: lane,
      });
      const outside = shell.kernel.recordRawEvent({
        projectId: PROJECT,
        threadId: 'forget-thread',
        sessionId: shell.config.sessionId,
        sourceId,
        role: 'user',
        content: `${kept} 我住在东京。`,
        occurredAt: base + DAY + 1_000,
        metadata: lane,
      });
      // A compiled profile entry citing the window is the recall-visible evidence.
      shell.kernel.beliefStore.upsert({
        projectId: PROJECT,
        scope: 'project',
        subject: 'owner',
        predicate: 'likes',
        objectValue: { raw: 'oolong', type: 'string' },
        confidence: 0.9,
        sourceType: 'user_input',
        extractionReason: 'preference_signal',
        sourceEventId: inside.eventId,
        validFrom: base + 1_000,
      });
      shell.kernel.profile.compile({ projectId: PROJECT });
      const recall = (query: string) => shell.backend.recall({ agentId: shell.config.agentId, projectId: PROJECT, query, limit: 5 });
      const profileText = (query: string) => recall(query).items
        .filter((item) => item.id.startsWith('profile:'))
        .map((item) => item.text)
        .join(' ');
      const digest = () => {
        const value = shell.kernel.sessionContext.digest({ projectId: PROJECT, agentId: shell.config.agentId, sessionId: shell.config.sessionId });
        return [...value.entries.map((entry) => entry.text), ...value.tail.map((turn) => turn.text)].join('\n');
      };
      expect(profileText('oolong')).toContain('oolong');
      expect(digest()).toContain(marker);

      // Confirming with no preview deletes nothing and says why.
      const bare = await shell.runCommand('forget', 'confirm');
      expect(bare.text).toContain('还没有预览');

      const preview = await shell.runCommand('forget', `${new Date(base).toISOString()} ${new Date(base + DAY).toISOString()}`);
      expect(preview.text).toContain('将删除');
      const previewed = Number(/(\d+) 条账本记录/u.exec(preview.text)?.[1]);
      expect(previewed).toBeGreaterThanOrEqual(1);
      expect(preview.text).toContain('/forget confirm');

      const confirmed = await shell.runCommand('forget', 'confirm');
      expect(confirmed.text).toContain('已删除');
      expect(confirmed.text).toContain('审计');
      const deleted = (confirmed.data as { sovereignty_delete: { deleted: Record<string, number>; auditId: string } }).sovereignty_delete;
      expect(deleted.deleted.events).toBeGreaterThanOrEqual(1);

      // The deleted turn is gone from recall; the turn outside the window still answers.
      expect(profileText('oolong')).not.toContain('oolong');
      expect(digest()).not.toContain(marker);
      expect(digest()).toContain(kept);
      expect(shell.kernel.eventStore.getEvent(outside.eventId)).toBeTruthy();

      // The receipt is the owner's audit: range, counts and id, never the deleted text.
      const audit = shell.kernel.sovereignty.audit(PROJECT).find((entry) => entry.action === 'delete_range');
      expect(audit?.auditId).toBe(deleted.auditId);
      expect(audit?.range).toEqual({ start: base, end: base + DAY });
      expect(JSON.stringify(audit)).not.toContain(marker);

      // The preview was consumed, so a second confirm cannot delete again.
      expect((await shell.runCommand('forget', 'confirm')).text).toContain('还没有预览');
    } finally {
      await shell.stop();
    }
  });
});

describe('/export writes the archive and answers with the path', () => {
  test('an outside path asks first; the confirmed file is 0600 and carries the conversation', async () => {
    const dir = makeTempDir();
    const shell = await startedShell(dir);
    try {
      const marker = 'zz-export-marker';
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: PROJECT,
        sessionId: shell.config.sessionId,
        userText: `${marker} 我明天把报告发你。`,
      });
      const path = join(dir, 'out', 'archive.md');
      // #290: outside the data dir the path is shown and nothing is written until the owner says so.
      const preview = await shell.runCommand('export', path);
      expect(preview.text).toContain(path);
      expect(preview.text).toContain('确认执行');
      expect(existsSync(path)).toBe(false);
      const reply = await shell.runCommand('export', 'confirm');
      expect(reply.text).toContain(path);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const body = readFileSync(path, 'utf8');
      expect(body).toContain('## Conversations');
      expect(body).toContain('## Profile');
      expect(body).toContain(marker);

      // With no argument the file lands under the data dir and the receipt still names it.
      const fallback = await shell.runCommand('export', '');
      const fallbackPath = (fallback.data as { sovereignty_export: { path: string } }).sovereignty_export.path;
      expect(fallbackPath.startsWith(join(dir, 'data', 'exports'))).toBe(true);
      expect(existsSync(fallbackPath)).toBe(true);

      // An explicit path inside the data dir is still direct: no confirmation for its own folder.
      const inside = join(dir, 'data', 'inside.md');
      const direct = await shell.runCommand('export', inside);
      expect(direct.text).toContain(inside);
      expect(existsSync(inside)).toBe(true);
    } finally {
      await shell.stop();
    }
  });
});

describe('/correct changes the profile entry the next recall reads', () => {
  test('one correction recompiles the ledger; recall carries the new value, not the old', async () => {
    const dir = makeTempDir();
    const shell = await startedShell(dir);
    try {
      await shell.kernel.ingest({ content: '我喜欢喝乌龙茶。', projectId: PROJECT });
      shell.kernel.profile.compile({ projectId: PROJECT });
      const entry = shell.kernel.profile.entries({ projectId: PROJECT, ledger: 'preferences' })[0];
      expect(entry).toBeDefined();

      const recall = (query: string) => shell.backend.recall({ agentId: shell.config.agentId, projectId: PROJECT, query, limit: 5 });
      const profileText = (query: string) => recall(query).items
        .filter((item) => item.id.startsWith('profile:'))
        .map((item) => item.text)
        .join(' ');
      expect(profileText('乌龙茶')).toContain('乌龙茶');

      const reply = await shell.runCommand('correct', `${entry!.key} 喝红茶`);
      expect(reply.text).toContain('已纠正');
      expect(reply.text).toContain('v2');
      expect(shell.kernel.profile.entries({ projectId: PROJECT, ledger: 'preferences' }).map((item) => item.value)).toEqual(['喝红茶']);
      expect(profileText('红茶')).toContain('喝红茶');
      expect(profileText('红茶')).not.toContain('乌龙茶');

      // An unknown key is a receipt, not a write.
      const missing = await shell.runCommand('correct', 'no.such.key 喝茶');
      expect(missing.text).toContain('没有叫 no.such.key');
    } finally {
      await shell.stop();
    }
  });
});
