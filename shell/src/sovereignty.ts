import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CompanionShell } from './app.ts';
import type { CommandReply } from './commands.ts';
import { formatBytes } from './memory.ts';
import { forgetRuntimeText } from './state/checkpoint.ts';

export class SovereigntyCommands {
  /**
   * The window `/forget` previewed and `/forget confirm` may execute. Process-local: a restart
   * asks for a fresh preview rather than resuming a confirmation the owner can no longer see.
   */
  private pendingForget?: { start: number; end: number };
  /**
   * The export path `/export` asked the owner to confirm (#290). Process-local: unlike the data-dir
   * path, writing outside the data dir must belong to a confirmation the owner just saw.
   */
  private pendingExport?: { path: string };
  /**
   * The practice `/correct` proposed and `/correct confirm` may write (#264). Process-local for the
   * same reason as the forget window: a confirmation must belong to a proposal the owner just saw.
   */
  private pendingProcedureCorrection?: { domain: string; key: string; value: string; title: string; steps: string[] };

  constructor(private readonly shell: CompanionShell) {}

  // ---- Memory sovereignty entry points (#232): three commands over F9's face. ----

  forgetPreview(start: number, end: number): CommandReply {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return { text: '删除窗口无效：起点必须早于终点（半开窗口 [起, 止)）。', receipt: true };
    }
    const projectId = this.shell.config.projectId;
    // The same half-open occurredAt filter deleteRange applies; this is a read, not a second rule.
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
    const result = this.shell.kernel.sovereignty.deleteRange({
      projectId,
      start: pending.start,
      end: pending.end,
      reason: 'owner_command',
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
    const promptsRemoved = this.shell.trace.forgetWindow('run_prompt', pending.start, pending.end);
    const deleted = Object.entries(result.deleted)
      .filter(([, value]) => value > 0)
      .map(([field, value]) => `${field} ${value}`)
      .join(' · ');
    const copies = [
      `本机快照 ${result.artifacts.snapshotsRemoved} 个`,
      `周归档 ${result.artifacts.archivesRemoved} 个`,
      `数据目录内导出 ${result.artifacts.exportsRemoved} 个已删除`,
      `${result.artifacts.notCovered.join('、')}不在覆盖范围内`,
    ].join('；');
    return {
      text: `已删除 ${new Date(pending.start).toISOString()} 至 ${new Date(pending.end).toISOString()}：${deleted || '没有记录'}。副本：${copies}。checkpoint：文本字段只存账本引用，${scrubbed.cleared} 个失去引用的字段已清空；trace：run_prompt 记录 ${promptsRemoved} 条已删除。审计 ${result.auditId}。`,
      receipt: true,
      data: { sovereignty_delete: result },
    };
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
    // Any new export invalidates an older unconfirmed request: a confirmation must belong to the
    // path the owner just saw, not one two commands ago.
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
    // The correction names the owner's turn. The command line is that turn, recorded through the
    // same backend every typed message uses, so pause/exclusion rules apply unchanged.
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
    this.shell.trace.append('profile_corrected', {
      projectId,
      ledger: entry.ledger,
      key: entry.key,
      version: corrected.version,
      eventId: correctionEventId,
    });
    return {
      text: `已纠正 ${entry.ledger} · ${entry.key}：${entry.value} → ${corrected.value}（v${corrected.version}）。下一次召回起全局按新值。`,
      receipt: true,
      data: { profile_correction: { ledger: entry.ledger, key: entry.key, value: corrected.value, version: corrected.version } },
    };
  }

  /**
   * `/correct` on a practice (#264). The compiler already reads `metadata.procedureCorrection`, but
   * nothing in the shell wrote it. A proposal is not a correction: the mark is written only by
   * `confirmProcedureCorrection`, and until then the book is untouched.
   */
  private proposeProcedureCorrection(key: string, value: string, knownProfiles: string): CommandReply {
    const projectId = this.shell.config.projectId;
    this.shell.kernel.procedures.compile({ projectId, now: this.shell.now() });
    const current = this.shell.kernel.procedures.entries({ projectId }).filter((entry) => entry.status === 'current');
    const named = current.filter((entry) =>
      entry.key === key || `${entry.domain}:${entry.key}` === key || entry.domain === key);
    // An imported guide and an own practice can share a key; the owner's correction replaces the
    // practice they actually do, and the imported book stays recallable as what was read.
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

  /** `/correct confirm`: write the practice correction and recompile, so the next recall reads it. */
  async confirmProcedureCorrection(): Promise<CommandReply> {
    const pending = this.pendingProcedureCorrection;
    if (!pending) return { text: '还没有做法提议：先 /correct <做法键> <新做法>。', receipt: true };
    const projectId = this.shell.config.projectId;
    // The mark is the compiler's evidence: a `user` turn carrying the domain and key. The command
    // line is that turn, recorded through the same backend every typed message uses.
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

/** Whether `target` resolves inside `root`; a sibling whose name starts with `..` is not inside. */
function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
