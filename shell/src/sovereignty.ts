import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CompanionShell } from './app.ts';
import type { CommandReply } from './commands.ts';
import { formatBytes } from './memory.ts';
import { forgetRuntimeText } from './state/checkpoint.ts';
import { forgetHash, forgetNeedles } from './trace.ts';

export class SovereigntyCommands {
  private pendingForget?: { start: number; end: number };
  private pendingExport?: { path: string };
  private pendingProcedureCorrection?: { domain: string; key: string; value: string; title: string; steps: string[] };

  constructor(private readonly shell: CompanionShell) {}

  forgetPreview(start: number, end: number): CommandReply {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return { text: '删除窗口无效：起点必须早于终点（半开窗口 [起, 止)）。', receipt: true };
    }
    const projectId = this.shell.config.projectId;
    const count = this.shell.backend.countEventsBetween({ projectId, startTime: start, endTime: end });
    const pending = this.shell.backend.countPendingBindingsBetween({ projectId, startTime: start, endTime: end });
    this.pendingForget = { start, end };
    return {
      text: [
        `将删除 ${new Date(start).toISOString()} 至 ${new Date(end).toISOString()}（含起不含止）的 ${count} 条账本记录，以及 pending_bindings 待绑定引用 ${pending} 条。`,
        '引用这些记录的画像、程序、承诺、情节与图谱条目会随证据一并删除，然后重建。',
        '数据库页会被重写；本机数据目录内的夜间快照、周归档与导出副本也会一并删除。',
        '数据目录之外的导出文件与已复制到其他机器的备份不在覆盖范围内。',
        '确认执行：/forget confirm。回执与审计只记范围、条数和审计 id，不记被删内容。',
      ].join('\n'),
      receipt: true,
    };
  }

  forgetConfirm(): CommandReply {
    const pending = this.pendingForget;
    if (!pending) return { text: '还没有预览：先 /forget <起> <止> 看范围和条数。', receipt: true };
    const projectId = this.shell.config.projectId;
    const deletedTexts = new Set<string>();
    this.shell.machine.updateRuntime({
      pendingForget: { start: pending.start, end: pending.end, hashes: this.rangeHashes(projectId, pending.start, pending.end) },
    });
    const result = this.shell.kernel.sovereignty.deleteRange({
      projectId,
      start: pending.start,
      end: pending.end,
      reason: 'owner_command',
      collectText: (text) => deletedTexts.add(text),
    });
    this.pendingForget = undefined;
    this.shell.trace.append('forget_range_deleted', {
      projectId,
      start: pending.start,
      end: pending.end,
      auditId: result.auditId,
      deleted: result.deleted,
    });
    this.shell.stateLedger.forget();
    const scrubbed = forgetRuntimeText(this.shell.machine.runtime, this.shell.stateLedger);
    this.shell.machine.updateRuntime(scrubbed.runtime);
    const traceRecordsRemoved = this.shell.trace.forgetWindow(pending.start, pending.end, [...deletedTexts]);
    this.shell.machine.updateRuntime({ pendingForget: undefined });
    const deleted = Object.entries(result.deleted)
      .filter(([, value]) => typeof value === 'number' && value > 0)
      .map(([field, value]) => `${field} ${value}`)
      .join(' · ');
    const copies = [
      `本机快照 ${result.artifacts.snapshotsRemoved} 个`,
      `周归档 ${result.artifacts.archivesRemoved} 个`,
      `数据目录内导出 ${result.artifacts.exportsRemoved} 个已删除`,
      `${result.artifacts.notCovered.join('、')}不在覆盖范围内`,
    ].join('；');
    return {
      text: `已删除 ${new Date(pending.start).toISOString()} 至 ${new Date(pending.end).toISOString()}：${deleted || '没有记录'}。副本：${copies}。checkpoint：文本字段只存账本引用，${scrubbed.cleared} 个失去引用的字段已清空；trace：${traceRecordsRemoved} 条带文本记录已删除。审计 ${result.auditId}。`,
      receipt: true,
      data: { sovereignty_delete: result },
    };
  }

  resumePendingForget(): void {
    const pending = this.shell.machine.runtime.pendingForget;
    if (!pending) return;
    this.shell.stateLedger.forget();
    const scrubbed = forgetRuntimeText(this.shell.machine.runtime, this.shell.stateLedger);
    this.shell.machine.updateRuntime(scrubbed.runtime);
    this.shell.trace.forgetWindow(pending.start, pending.end, [], pending.hashes);
    this.shell.machine.updateRuntime({ pendingForget: undefined });
  }

  private rangeHashes(projectId: string, start: number, end: number): string[] {
    const hashes = new Set<string>();
    for (const event of this.shell.kernel.eventStore.iterateProjectEvents(projectId, start, end)) {
      const text = (event.payload as { text?: unknown } | undefined)?.text;
      if (typeof text !== 'string') continue;
      for (const needle of forgetNeedles([text])) hashes.add(forgetHash(needle));
    }
    return [...hashes];
  }

  exportMemory(path: string | undefined): CommandReply {
    const arg = path?.trim() ?? '';
    if (arg === 'confirm') {
      const pending = this.pendingExport;
      if (!pending) return { text: '还没有待确认的导出：先 /export <路径> 看落盘位置。', receipt: true };
      return this.writeExport(pending.path, true);
    }
    const outputPath = arg !== ''
      ? arg
      : join(this.shell.config.dataDir, 'exports', `memory-${new Date(this.shell.now()).toISOString().replace(/[:.]/gu, '-')}.md`);
    this.pendingExport = undefined;
    if (!isWithin(this.shell.config.dataDir, outputPath)) {
      this.pendingExport = { path: outputPath };
      return {
        text: `导出会写到数据目录之外的 ${resolve(outputPath)}（文件权限 0600）。确认执行：/export confirm。`,
        receipt: true,
      };
    }
    return this.writeExport(outputPath, false);
  }

  private writeExport(outputPath: string, confirmed: boolean): CommandReply {
    const result = this.shell.kernel.sovereignty.exportArchive({ projectId: this.shell.config.projectId, outputPath });
    if (confirmed) this.pendingExport = undefined;
    this.shell.trace.append('memory_exported', { path: result.path, bytes: result.bytes, auditId: result.auditId });
    const { events, profile, procedures, commitments, graph } = result.counts;
    return {
      text: `已导出 ${events} 条对话、${profile} 条画像、${procedures} 条程序、${commitments} 条承诺、${graph} 个图谱节点（${formatBytes(result.bytes)}）到 ${result.path}。审计 ${result.auditId}。`,
      receipt: true,
      data: { sovereignty_export: result },
    };
  }

  async correctProfile(key: string, value: string): Promise<CommandReply> {
    const projectId = this.shell.config.projectId;
    const entries = this.shell.kernel.profile.entries({ projectId });
    const exact = entries.filter((entry) => entry.key === key);
    const matches = exact.length > 0 ? exact : entries.filter((entry) => entry.key.endsWith(`.${key}`));
    if (matches.length === 0) {
      const known = entries.slice(0, 12).map((entry) => `${entry.ledger}:${entry.key}`).join('、');
      return this.proposeProcedureCorrection(key, value, known);
    }
    if (matches.length > 1) {
      return {
        text: `${key} 命中多条（${matches.map((entry) => `${entry.ledger}:${entry.key}`).join('、')}），请用完整键再试。`,
        receipt: true,
      };
    }
    const entry = matches[0]!;
    const turn = await this.shell.backend.rememberTurnWithResult({
      agentId: this.shell.config.agentId,
      projectId,
      sessionId: this.shell.config.sessionId,
      userText: `/correct ${entry.key} ${value}`,
    });
    const correctionEventId = turn.rawEventIds[0];
    if (!correctionEventId) return { text: '纠正未执行：纠正面需要一个用户回合，这次没有写进去。', receipt: true };
    const corrected = this.shell.kernel.profile.correct({
      projectId,
      ledger: entry.ledger,
      key: entry.key,
      value,
      correctionEventId,
    });
    const counts = corrected.replaced;
    const check = this.correctionSelfCheck(projectId, entry.key, entry.value, corrected.value, correctionEventId);
    this.shell.trace.append('profile_corrected', {
      projectId,
      ledger: entry.ledger,
      key: entry.key,
      version: corrected.version,
      eventId: correctionEventId,
      replaced: counts,
    });
    const layers = [
      `画像 ${counts.profile} ✓`,
      `信念/事实 ${counts.beliefs + counts.facts} ✓${counts.beliefs + counts.facts ? ' 已替换' : ''}`,
      `语义帧 ${counts.frames} ✓${counts.frames ? ' 已作废' : ''}`,
      counts.cards > 0 ? `情节卡 ${counts.cards} ⚠ 已加注「后有纠正」` : '情节卡 0 ✓',
    ].join(' · ');
    const hit = check.hit ? `${corrected.value} ✓` : `${corrected.value} 未命中 ✗`;
    const oldHits = `旧值「${entry.value}」作为当前值出现 ${check.oldHits} 次 ${check.oldHits === 0 ? '✓' : '✗'}`;
    return {
      text: `已纠正 ${entry.ledger} · ${entry.key}：${entry.value} → ${corrected.value}（v${corrected.version}）\n· ${layers}\n· 自检：「${check.question}」→ ${hit}；${oldHits}`,
      receipt: true,
      data: { profile_correction: { ledger: entry.ledger, key: entry.key, value: corrected.value, version: corrected.version, replaced: counts, selfCheck: check } },
    };
  }

  private correctionSelfCheck(projectId: string, key: string, oldValue: string, newValue: string, correctionEventId: string) {
    const question = `${key.replace(/[|._]+/gu, ' ')} 现在是什么？`;
    const recall = (query: string) => this.shell.backend.recall({ agentId: this.shell.config.agentId, projectId, query, limit: 8 });
    const asked = recall(question);
    const oldAsked = recall(oldValue);
    const oldHits = new Set<string>();
    for (const item of [...asked.items, ...oldAsked.items]) {
      if (item.sourceAnchor?.eventId === correctionEventId || item.id === correctionEventId) continue;
      if (item.text.split(newValue).join('').includes(oldValue)) oldHits.add(item.id);
    }
    return { question, hit: asked.items.some((item) => item.text.includes(newValue)), oldHits: oldHits.size };
  }

  private proposeProcedureCorrection(key: string, value: string, knownProfiles: string): CommandReply {
    const projectId = this.shell.config.projectId;
    this.shell.kernel.procedures.compile({ projectId, now: this.shell.now() });
    const current = this.shell.kernel.procedures.entries({ projectId }).filter((entry) => entry.status === 'current');
    const named = current.filter((entry) =>
      entry.key === key || `${entry.domain}:${entry.key}` === key || entry.domain === key);
    const own = named.filter((entry) => entry.origin !== 'imported');
    const matches = own.length > 0 ? own : named;
    if (matches.length === 0) {
      return {
        text: `没有叫 ${key} 的当前画像或做法条目。${knownProfiles ? `现有画像：${knownProfiles}` : '画像册目前是空的。'}`,
        receipt: true,
      };
    }
    if (matches.length > 1) {
      return {
        text: `${key} 命中多条做法（${matches.map((entry) => `${entry.domain}:${entry.key}`).join('、')}），请用完整键再试。`,
        receipt: true,
      };
    }
    const entry = matches[0]!;
    this.pendingProcedureCorrection = {
      domain: entry.domain,
      key: entry.key,
      value,
      title: entry.title,
      steps: [...entry.steps],
    };
    this.shell.trace.append('procedure_correction_proposed', {
      projectId,
      domain: entry.domain,
      key: entry.key,
      entryId: entry.entryId,
    });
    return {
      text: `提议：把做法「${entry.title}」（${entry.domain} · ${entry.key}）改为「${value}」。这是提议，尚未生效；确认请发 /correct confirm。`,
      receipt: true,
      data: { procedure_correction_proposal: { domain: entry.domain, key: entry.key, value } },
    };
  }

  async confirmProcedureCorrection(): Promise<CommandReply> {
    const pending = this.pendingProcedureCorrection;
    if (!pending) return { text: '还没有做法提议：先 /correct <做法键> <新做法>。', receipt: true };
    const projectId = this.shell.config.projectId;
    const turn = await this.shell.backend.rememberTurnWithResult({
      agentId: this.shell.config.agentId,
      projectId,
      sessionId: this.shell.config.sessionId,
      userText: pending.value,
      metadata: { procedureCorrection: { domain: pending.domain, key: pending.key } },
    });
    const correctionEventId = turn.rawEventIds[0];
    if (!correctionEventId) return { text: '纠正未执行：做法纠正需要一个用户回合，这次没有写进去。', receipt: true };
    this.pendingProcedureCorrection = undefined;
    this.shell.kernel.procedures.compile({ projectId, now: this.shell.now() });
    const entry = this.shell.kernel.procedures.entries({ projectId }).find((candidate) =>
      candidate.domain === pending.domain && candidate.key === pending.key && candidate.origin !== 'imported');
    this.shell.trace.append('procedure_corrected', {
      projectId,
      domain: pending.domain,
      key: pending.key,
      eventId: correctionEventId,
      entryId: entry?.entryId,
      version: entry?.version,
      grade: entry?.grade,
    });
    if (!entry) {
      return {
        text: `已写入做法纠正，但重编译后没有找到 ${pending.domain} · ${pending.key} 的现行条目；审计 ${correctionEventId}。`,
        receipt: true,
      };
    }
    return {
      text: `已纠正做法 ${pending.domain} · ${pending.key}：「${pending.steps.join('；')}」→「${pending.value}」（${entry.grade}，v${entry.version}）。下一次同类任务按新做法。`,
      receipt: true,
      data: {
        procedure_correction: {
          domain: pending.domain,
          key: pending.key,
          value: pending.value,
          entryId: entry.entryId,
          version: entry.version,
          grade: entry.grade,
        },
      },
    };
  }

}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
