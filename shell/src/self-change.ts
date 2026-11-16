/**
 * The applier for one kind of self-change: installing a plugin proposal the owner approved (#291).
 *
 * The hygiene gate decides whether a proposal may be installed; this module is the only path that
 * writes it. Applying is two steps in two processes. Here the files and the registry entry are
 * written, a record carrying the pre-apply snapshot is persisted, and the resident is restarted
 * through the existing plugin restart. On the next boot `reconcile` reads the load result: a loaded
 * plugin is recorded as applied, and anything else restores the snapshot before the owner can
 * mistake a half-install for a working one.
 *
 * The record is also the audit entry `/plugins` reads. The trace carries the same events, but the
 * trace is evidence, not state: the snapshot must survive the restart the apply itself triggers.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { HYGIENE_MIN_SCORE, type HygieneProposal } from './hygiene.ts';
import type { PluginLoadResult } from './plugins/load.ts';
import { pluginsConfigPath, readPluginRegistry, writePluginRegistry } from './plugins/registry.ts';

const ENTRY_FILES = ['index.ts', 'index.js', 'index.mjs', 'index.tsx'];

export type SelfChangeApplyStatus = 'pending' | 'applied' | 'rolled_back' | 'failed';

export interface SelfChangeApplySnapshot {
  /** `null` means `plugins.json` did not exist before the apply. */
  registry: string[] | null;
  /** Each target's previous text, or `null` when the file did not exist. */
  files: Array<{ path: string; content: string | null }>;
  targetDirExisted: boolean;
}

export interface SelfChangeApplyRecord {
  applyId: string;
  proposalId: string;
  spec: string;
  targetDir: string;
  status: SelfChangeApplyStatus;
  createdAt: number;
  updatedAt: number;
  /** The record is the snapshot; this is the path a reader opens to audit both. */
  snapshotPath: string;
  snapshot: SelfChangeApplySnapshot;
  reason?: string;
  tools?: string[];
  commands?: string[];
}

export interface SelfChangeTrace {
  append(kind: string, record?: Record<string, unknown>, now?: number): void;
}

export type SelfChangeApplyOutcome =
  | { ok: true; record: SelfChangeApplyRecord }
  | { ok: false; refused: true; reason: string }
  | { ok: false; refused: false; reason: string; record: SelfChangeApplyRecord };

export function selfChangeApplyDir(dataDir: string): string {
  return join(dataDir, 'self-change-applies');
}

export function selfChangePluginDir(dataDir: string): string {
  return join(dataDir, 'self-plugins');
}

function recordPath(dataDir: string, applyId: string): string {
  return join(selfChangeApplyDir(dataDir), `${applyId}.json`);
}

function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

/** Every readable record, oldest first. A malformed record is skipped rather than voiding the rest. */
export function readSelfChangeApplies(dataDir: string): SelfChangeApplyRecord[] {
  const dir = selfChangeApplyDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const records: SelfChangeApplyRecord[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SelfChangeApplyRecord;
      if (typeof parsed.applyId === 'string' && typeof parsed.proposalId === 'string'
        && typeof parsed.spec === 'string' && typeof parsed.targetDir === 'string'
        && ['pending', 'applied', 'rolled_back', 'failed'].includes(parsed.status)
        && parsed.snapshot !== undefined) records.push(parsed);
    } catch {
      // One damaged record must not hide the others; the trace remains the primary account.
    }
  }
  return records.sort((left, right) => left.createdAt - right.createdAt);
}

export function writeSelfChangeApply(dataDir: string, record: SelfChangeApplyRecord): void {
  writeAtomic(recordPath(dataDir, record.applyId), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TargetFile {
  path: string;
  target: string;
  content: string;
}

export class SelfChangeApplier {
  private seq = 0;

  constructor(private readonly options: { dataDir: string; trace: SelfChangeTrace; now: () => number }) {}

  records(): SelfChangeApplyRecord[] {
    return readSelfChangeApplies(this.options.dataDir);
  }

  pending(): SelfChangeApplyRecord | undefined {
    return this.records().find((record) => record.status === 'pending');
  }

  /** The specs a restart still has to prove, used to isolate a pending plugin at boot. */
  pendingSpecs(): Set<string> {
    return new Set(this.records().filter((record) => record.status === 'pending').map((record) => record.spec));
  }

  apply(proposal: HygieneProposal): SelfChangeApplyOutcome {
    const refusal = this.refusalFor(proposal);
    if (refusal) {
      this.options.trace.append('self_change_apply_refused', { proposalId: proposal.id, reason: refusal });
      return { ok: false, refused: true, reason: refusal };
    }

    const targetDir = resolve(selfChangePluginDir(this.options.dataDir), proposal.id);
    let files: TargetFile[];
    try {
      files = proposal.files.map((file) => this.targetFor(targetDir, file.path, file.content));
    } catch (error) {
      const reason = `unsafe_path: ${text(error)}`;
      this.options.trace.append('self_change_apply_refused', { proposalId: proposal.id, reason });
      return { ok: false, refused: true, reason };
    }
    if (!files.some((file) => ENTRY_FILES.includes(file.path))) {
      const reason = `plugin_entry_missing: expected one of ${ENTRY_FILES.join(', ')} at the plugin root`;
      this.options.trace.append('self_change_apply_refused', { proposalId: proposal.id, reason });
      return { ok: false, refused: true, reason };
    }

    const at = this.options.now();
    const applyId = `apply-${at.toString(36)}-${this.seq++}`;
    const snapshotPath = recordPath(this.options.dataDir, applyId);
    const snapshot: SelfChangeApplySnapshot = {
      registry: existsSync(pluginsConfigPath(this.options.dataDir)) ? readPluginRegistry(this.options.dataDir) : null,
      files: files.map((file) => ({ path: file.path, content: existsSync(file.target) ? readFileSync(file.target, 'utf8') : null })),
      targetDirExisted: existsSync(targetDir),
    };
    const record: SelfChangeApplyRecord = {
      applyId,
      proposalId: proposal.id,
      spec: targetDir,
      targetDir,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      snapshotPath,
      snapshot,
    };
    writeSelfChangeApply(this.options.dataDir, record);
    this.options.trace.append('self_change_apply_started', {
      applyId,
      proposalId: proposal.id,
      spec: record.spec,
      snapshot: snapshotPath,
      files: files.map((file) => file.path),
      registry: snapshot.registry,
    }, at);

    try {
      for (const file of files) writeAtomic(file.target, file.content, 0o600);
      writePluginRegistry(this.options.dataDir, [...(snapshot.registry ?? []), record.spec]);
    } catch (error) {
      const reason = `write_failed: ${text(error)}`;
      return { ok: false, refused: false, reason, record: this.fail(record, reason) };
    }
    return { ok: true, record };
  }

  /**
   * Called once per boot after the host started. Only a pending record is decided: a plugin that
   * started is applied; anything else is restored to the snapshot and recorded as rolled back.
   */
  reconcile(results: PluginLoadResult[], started: (name: string) => boolean): SelfChangeApplyRecord[] {
    const changed: SelfChangeApplyRecord[] = [];
    for (const record of this.records().filter((entry) => entry.status === 'pending')) {
      const result = results.find((entry) => entry.spec === record.spec);
      const loaded = result?.status === 'loaded' && result.name !== undefined && started(result.name);
      if (loaded) {
        record.status = 'applied';
        record.updatedAt = this.options.now();
        record.tools = result.tools;
        record.commands = result.commands;
        writeSelfChangeApply(this.options.dataDir, record);
        this.options.trace.append('self_change_apply_verified', {
          applyId: record.applyId,
          proposalId: record.proposalId,
          spec: record.spec,
          snapshot: record.snapshotPath,
          health: 'ok',
          tools: record.tools,
          commands: record.commands,
        });
      } else {
        const reason = result?.reason ?? (result?.status === 'loaded' ? 'plugin_not_started' : 'plugin_not_loaded');
        // The process must not report a plugin as loaded after it was quarantined or skipped.
        if (result?.status === 'loaded') {
          result.status = 'failed';
          result.reason = reason;
          result.tools = [];
          result.commands = [];
        }
        changed.push(this.fail(record, reason));
      }
      if (record.status === 'applied') changed.push(record);
    }
    return changed;
  }

  private refusalFor(proposal: HygieneProposal): string | undefined {
    if (proposal.kind !== 'plugin') return `only_plugin_install_is_supported: ${proposal.kind}`;
    if (proposal.status !== 'approved') return `not_approved: ${proposal.status}`;
    if (proposal.findings.length > 0) return `hygiene_findings: ${proposal.findings.map((finding) => finding.code).join(', ')}`;
    if (proposal.score < HYGIENE_MIN_SCORE) return `score_below_threshold: ${proposal.score} < ${HYGIENE_MIN_SCORE}`;
    if (!proposal.tests?.passed) return 'tests_not_passed';
    const pending = this.pending();
    if (pending) return `apply_pending_restart: ${pending.applyId} (${pending.spec})`;
    return undefined;
  }

  private targetFor(targetDir: string, path: string, content: string): TargetFile {
    const trimmed = path.trim();
    if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/u.test(trimmed)
      || trimmed.includes('\0') || trimmed.split(/[\\/]/u).includes('..')) {
      throw new Error(`${JSON.stringify(path)} is not a relative plugin path`);
    }
    const target = resolve(targetDir, trimmed);
    if (target !== targetDir && !target.startsWith(targetDir + sep)) {
      throw new Error(`${JSON.stringify(path)} escapes the plugin directory`);
    }
    return { path: trimmed.split('\\').join('/'), target, content };
  }

  private fail(record: SelfChangeApplyRecord, reason: string): SelfChangeApplyRecord {
    this.options.trace.append('self_change_apply_failed', {
      applyId: record.applyId,
      proposalId: record.proposalId,
      spec: record.spec,
      snapshot: record.snapshotPath,
      reason,
    });
    const restored = this.restore(record);
    record.status = restored.errors.length === 0 ? 'rolled_back' : 'failed';
    record.reason = restored.errors.length === 0 ? reason : `${reason}; rollback_incomplete: ${restored.errors.join('; ')}`;
    record.updatedAt = this.options.now();
    writeSelfChangeApply(this.options.dataDir, record);
    this.options.trace.append('self_change_apply_rolled_back', {
      applyId: record.applyId,
      proposalId: record.proposalId,
      spec: record.spec,
      snapshot: record.snapshotPath,
      reason,
      restored: ['files', 'registry'],
      rollbackErrors: restored.errors,
    });
    return record;
  }

  private restore(record: SelfChangeApplyRecord): { errors: string[] } {
    const errors: string[] = [];
    for (const file of record.snapshot.files) {
      try {
        const target = resolve(record.targetDir, file.path);
        if (file.content === null) rmSync(target, { force: true });
        else writeAtomic(target, file.content, 0o600);
      } catch (error) {
        errors.push(`${file.path}: ${text(error)}`);
      }
    }
    try {
      if (record.snapshot.registry === null) rmSync(pluginsConfigPath(this.options.dataDir), { force: true });
      else writePluginRegistry(this.options.dataDir, record.snapshot.registry);
    } catch (error) {
      errors.push(`plugins.json: ${text(error)}`);
    }
    if (!record.snapshot.targetDirExisted) {
      try {
        rmSync(record.targetDir, { recursive: true, force: true });
      } catch (error) {
        errors.push(`plugin directory: ${text(error)}`);
      }
    }
    return { errors };
  }
}
