/**
 * The hygiene gate for self-written or self-learned proposals (#228 item 5).
 *
 * A skill, plugin or rule draft passes three stages before anything reviews or applies it:
 * deterministic code checks (size, shape, secrets, hidden characters), a transparent score, and the
 * provenance rule. A toxic finding discards the whole proposal, never just the offending file. A
 * rule learned from external content is held until the owner approves it through the shell's one
 * question pause (`ask_user` / `SUSPENDED`), not through a second approval surface. Every stage
 * writes a trace record that carries the outcome without copying the proposal's raw text.
 *
 * This module only gates. It does not install a plugin, write a skill, or change the kernel's rule
 * layer; a proposal that reaches `pending_review` is still only a candidate.
 */

export type SelfChangeKind = 'skill' | 'plugin' | 'rule';
export type HygieneOrigin = 'self' | 'web' | 'email' | 'message';
export type HygieneStatus = 'discarded' | 'rejected' | 'awaiting_owner' | 'pending_review' | 'active';

export interface SelfChangeFile {
  path: string;
  content: string;
}

export interface SelfChangeDiff {
  added: number;
  removed: number;
  files: number;
}

export interface SelfChangeTests {
  command: string;
  passed: boolean;
}

export interface SelfChangeProposalInput {
  kind: SelfChangeKind;
  /** `self` is the companion's own draft; web, email and another person's message are external. */
  origin: HygieneOrigin;
  reason: string;
  files: SelfChangeFile[];
  diff: SelfChangeDiff;
  tests?: SelfChangeTests;
  /** What undoes this change; a proposal without one is not rollbackable. */
  rollback: string;
}

export interface HygieneFinding {
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface HygieneProposal extends SelfChangeProposalInput {
  id: string;
  status: HygieneStatus;
  score: number;
  findings: HygieneFinding[];
  createdAt: number;
  requiresOwnerApproval: boolean;
  ownerQuestion?: string;
}

export interface HygieneOutcome {
  proposal: HygieneProposal;
  /** A toxic finding means the whole proposal was discarded, not repaired. */
  toxic: boolean;
  accepted: boolean;
  /** The proposal needs the one question pause before it can take effect. */
  needsOwner: boolean;
  /** The pause could not be opened (for example an autonomous run has nobody to answer). */
  ownerUnavailable: boolean;
  summary: string;
}

export interface HygieneTrace {
  append(kind: string, record?: Record<string, unknown>, now?: number): void;
}

export interface HygieneOwnerQuestion {
  question: string;
  context?: string;
  approvalId?: string;
}

export interface HygieneOwnerAnswer {
  ok: boolean;
  text: string;
}

export interface HygienePipelineOptions {
  trace: HygieneTrace;
  now: () => number;
  /** Backed by the shell's `ask_user`; opening it is what suspends the work run. */
  askOwner: (input: HygieneOwnerQuestion) => HygieneOwnerAnswer;
}

export const HYGIENE_MAX_FILES = 8;
export const HYGIENE_MAX_FILE_BYTES = 32 * 1024;
export const HYGIENE_MAX_TOTAL_BYTES = 64 * 1024;
export const HYGIENE_MAX_DIFF_LINES = 400;
export const HYGIENE_MAX_DIFF_FILES = 8;
export const HYGIENE_MIN_SCORE = 75;

const ALLOWED_EXTENSIONS = ['.ts', '.js', '.mjs', '.json', '.md', '.txt', '.toml', '.yaml', '.yml', '.sh', '.css', '.html'];

const SECRET_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'private_key', pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/gu },
  { code: 'openai_key', pattern: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}/gu },
  { code: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/gu },
  { code: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { code: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
  { code: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/giu },
  { code: 'credential_assignment', pattern: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9._~+\/=-]{12,}/giu },
];

/** Zero-width, bidi-control, tag and other invisible formatting code points. */
const HIDDEN_CHARACTERS = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
/** C0 controls and DEL that are not ordinary whitespace. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function textFields(input: SelfChangeProposalInput): Array<{ path: string; text: string }> {
  return [
    ...input.files.map((file) => ({ path: file.path, text: file.content })),
    { path: '<reason>', text: input.reason },
    { path: '<rollback>', text: input.rollback },
    ...(input.tests ? [{ path: '<tests.command>', text: input.tests.command }] : []),
  ];
}

function inspectText(input: SelfChangeProposalInput): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const field of textFields(input)) {
    for (const { code, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of field.text.matchAll(pattern)) {
        findings.push({
          code: 'secret_detected',
          message: `secret pattern ${code} at ${field.path}:${lineAt(field.text, match.index ?? 0)}`,
          path: field.path,
          line: lineAt(field.text, match.index ?? 0),
        });
      }
    }
    for (const pattern of [HIDDEN_CHARACTERS, CONTROL_CHARACTERS]) {
      pattern.lastIndex = 0;
      for (const match of field.text.matchAll(pattern)) {
        const codePoint = match[0].codePointAt(0)?.toString(16).toUpperCase() ?? '?';
        findings.push({
          code: 'hidden_character',
          message: `hidden character U+${codePoint} at ${field.path}:${lineAt(field.text, match.index ?? 0)}`,
          path: field.path,
          line: lineAt(field.text, match.index ?? 0),
        });
      }
    }
  }
  return findings;
}

function inspectShape(input: SelfChangeProposalInput): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  const add = (code: string, message: string, path?: string): void => {
    findings.push({ code, message, ...(path ? { path } : {}) });
  };
  if (!['skill', 'plugin', 'rule'].includes(input.kind)) add('kind_invalid', `unknown proposal kind: ${String(input.kind)}`);
  if (!['self', 'web', 'email', 'message'].includes(input.origin)) add('origin_invalid', `unknown proposal origin: ${String(input.origin)}`);
  if (input.reason.trim().length < 10) add('reason_required', 'reason must say why the change is proposed (at least 10 characters)');
  if (input.rollback.trim() === '') add('rollback_required', 'rollback must name how the change is undone');
  if (input.files.length === 0) add('files_required', 'a proposal must carry at least one file');
  if (input.files.length > HYGIENE_MAX_FILES) add('file_count_too_large', `${input.files.length} files exceeds ${HYGIENE_MAX_FILES}`);

  let totalBytes = 0;
  for (const file of input.files) {
    const bytes = Buffer.byteLength(file.content, 'utf8');
    totalBytes += bytes;
    const path = file.path.trim();
    if (path === '' || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/u.test(path)
      || path.includes('\0') || path.split(/[\\/]/u).includes('..')) {
      add('path_unsafe', `path is not a relative workspace path: ${JSON.stringify(file.path)}`, file.path);
    }
    if (path !== '' && !ALLOWED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) {
      add('file_type_not_allowed', `file type is not allowed: ${path}`, file.path);
    }
    if (bytes > HYGIENE_MAX_FILE_BYTES) add('file_too_large', `${path} is ${bytes} bytes, over ${HYGIENE_MAX_FILE_BYTES}`, file.path);
  }
  if (totalBytes > HYGIENE_MAX_TOTAL_BYTES) add('proposal_too_large', `${totalBytes} bytes exceeds ${HYGIENE_MAX_TOTAL_BYTES}`);

  const diff = input.diff;
  const numbers = [diff?.added, diff?.removed, diff?.files];
  if (!numbers.every((value) => Number.isInteger(value) && value >= 0)) {
    add('diff_required', 'diff must carry non-negative integer added, removed and files counts');
  } else {
    if (diff.added + diff.removed > HYGIENE_MAX_DIFF_LINES) {
      add('diff_too_large', `${diff.added + diff.removed} changed lines exceeds ${HYGIENE_MAX_DIFF_LINES}`);
    }
    if (diff.files > HYGIENE_MAX_DIFF_FILES) add('diff_files_too_large', `${diff.files} changed files exceeds ${HYGIENE_MAX_DIFF_FILES}`);
  }

  if (input.kind === 'plugin' || input.kind === 'skill') {
    if (!input.tests) add('tests_required', 'a code proposal must carry the test gate it ran');
    else if (!input.tests.passed) add('tests_not_passed', `test gate did not pass: ${input.tests.command}`);
    else if (input.tests.command.trim() === '') add('tests_command_required', 'test gate must name the command that ran');
  }
  return findings;
}

function scoreOf(input: SelfChangeProposalInput, totalBytes: number): number {
  const changedLines = input.diff.added + input.diff.removed;
  let score = 70;
  if (input.tests?.passed === true) score += 10;
  if (input.rollback.trim() !== '') score += 10;
  if (input.reason.trim().length >= 20) score += 5;
  if (changedLines <= 100) score += 5;
  if (totalBytes > 16 * 1024) score -= 10;
  if (input.files.length > 4) score -= 10;
  if (changedLines > 200) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function isAffirmative(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (/(不|否|拒绝|别|no|reject)/u.test(normalized)) return false;
  const stripped = normalized.replace(/[。！!，,\s]+$/u, '');
  if (['是', '好', '可以', '行', '好的', '是的'].includes(stripped)) return true;
  return /^(批准|同意|确认|yes|ok|approve|approved)/u.test(normalized)
    || /(批准|同意|确认)/u.test(normalized);
}

/**
 * The gate's registry, kept in memory. The trace is the durable audit record; this map is the
 * process's live view of which proposals are still waiting for an owner answer.
 */
export class HygienePipeline {
  private readonly byId = new Map<string, HygieneProposal>();
  private seq = 0;

  constructor(private readonly options: HygienePipelineOptions) {}

  submit(input: SelfChangeProposalInput): HygieneOutcome {
    const at = this.options.now();
    const id = `hygiene-${at.toString(36)}-${this.seq++}`;
    const totalBytes = input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
    const proposal: HygieneProposal = {
      ...input,
      id,
      status: 'pending_review',
      score: 0,
      findings: [],
      createdAt: at,
      requiresOwnerApproval: input.kind === 'rule' && input.origin !== 'self',
    };
    this.byId.set(id, proposal);
    this.options.trace.append('hygiene_proposal_received', {
      id,
      proposalKind: input.kind,
      origin: input.origin,
      reasonChars: input.reason.trim().length,
      files: input.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') })),
      diff: input.diff,
      tests: input.tests ? { command: input.tests.command, passed: input.tests.passed } : undefined,
      rollbackChars: input.rollback.trim().length,
    }, at);

    const findings = [...inspectShape(input), ...inspectText(input)];
    proposal.findings = findings;
    this.options.trace.append('hygiene_checked', {
      id,
      passed: findings.length === 0,
      findings: findings.map(({ code, message, path, line }) => ({ code, message, ...(path ? { path } : {}), ...(line ? { line } : {}) })),
    }, at);

    const score = scoreOf(input, totalBytes);
    proposal.score = score;
    this.options.trace.append('hygiene_scored', { id, score, threshold: HYGIENE_MIN_SCORE }, at);

    const toxic = findings.some((finding) => finding.code === 'secret_detected' || finding.code === 'hidden_character');
    if (toxic) {
      proposal.status = 'discarded';
      return this.dispose(proposal, true, false, false, `toxic finding: ${findings.map((finding) => finding.code).join(', ')}`);
    }
    if (findings.length > 0) {
      proposal.status = 'rejected';
      return this.dispose(proposal, false, false, false, `checks failed: ${findings.map((finding) => finding.code).join(', ')}`);
    }

    if (score < HYGIENE_MIN_SCORE) {
      proposal.status = 'rejected';
      return this.dispose(proposal, false, false, false, `score_below_threshold: ${score} < ${HYGIENE_MIN_SCORE}`);
    }

    if (proposal.requiresOwnerApproval) {
      const excerpt = input.files.map((file) => file.content.trim()).join('\n').slice(0, 300);
      const question = `外部来源（${input.origin}）的规矩提案：${excerpt}\n批准后才会生效。回复「批准」或「拒绝」。`;
      const asked = this.options.askOwner({ question, context: id, approvalId: id });
      proposal.ownerQuestion = question;
      if (!asked.ok) {
        proposal.status = 'rejected';
        return this.dispose(proposal, false, false, true, 'owner_unavailable');
      }
      proposal.status = 'awaiting_owner';
      this.options.trace.append('hygiene_owner_asked', { id, questionChars: question.length }, at);
      return this.dispose(proposal, false, true, false, 'awaiting_owner');
    }

    proposal.status = 'pending_review';
    return this.dispose(proposal, false, true, false, 'pending_review');
  }

  /**
   * The owner's line came back through the existing question suspension. Affirmative is explicit;
   * anything else leaves the rule inactive. An id this process no longer knows is traced, not guessed.
   */
  answer(id: string, text: string): HygieneProposal | undefined {
    const proposal = this.byId.get(id);
    if (!proposal || proposal.status !== 'awaiting_owner') {
      this.options.trace.append('hygiene_owner_answer_orphaned', { id, hasProposal: proposal !== undefined }, this.options.now());
      return undefined;
    }
    if (isAffirmative(text)) {
      proposal.status = 'active';
      this.options.trace.append('hygiene_owner_approved', { id, answerChars: text.trim().length }, this.options.now());
    } else {
      proposal.status = 'discarded';
      this.options.trace.append('hygiene_owner_declined', { id, answerChars: text.trim().length }, this.options.now());
    }
    return proposal;
  }

  get(id: string): HygieneProposal | undefined {
    return this.byId.get(id);
  }

  /** Only an approved external rule has taken effect; a pending proposal is still a candidate. */
  isEffective(id: string): boolean {
    return this.byId.get(id)?.status === 'active';
  }

  private dispose(
    proposal: HygieneProposal,
    toxic: boolean,
    accepted: boolean,
    ownerUnavailable: boolean,
    summary: string,
  ): HygieneOutcome {
    this.options.trace.append('hygiene_disposition', {
      id: proposal.id,
      status: proposal.status,
      disposition: proposal.status,
      score: proposal.score,
      proposalKind: proposal.kind,
      origin: proposal.origin,
      requiresOwnerApproval: proposal.requiresOwnerApproval,
      findings: proposal.findings.map((finding) => finding.code),
    }, this.options.now());
    return {
      proposal,
      toxic,
      accepted,
      needsOwner: proposal.status === 'awaiting_owner',
      ownerUnavailable,
      summary,
    };
  }
}
