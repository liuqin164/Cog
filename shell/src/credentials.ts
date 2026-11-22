import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandProposal, CredentialField } from './proposals.ts';

export type CredentialSurface = 'terminal' | 'web';

export interface CredentialRequestInput {
  service: string;
  purpose: string;
  fields: CredentialField[];
  requestedBy?: string;
}

export interface CredentialRef {
  ref: string;
  service: string;
  createdAt: number;
}

export interface CredentialPending {
  id: string;
  service: string;
  purpose: string;
  fields: CredentialField[];
  requestedBy: string;
  createdAt: number;
}

export type CredentialOutcome = { outcome: 'saved'; ref: string } | { outcome: 'cancelled' };
export type CredentialSubmission = { ok: true; ref: string } | { ok: false; reason: string };

interface CredentialRecord extends CredentialRef {
  values: Record<string, string>;
}

interface CredentialFile {
  version: 1;
  entries: CredentialRecord[];
}

interface PendingCredential {
  id: string;
  input: Required<CredentialRequestInput>;
  proposal: CommandProposal;
  promise: Promise<CredentialOutcome>;
  resolve: (outcome: CredentialOutcome) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,31}$/iu;
const MAX_FIELDS = 8;

function text(value: unknown, field: string): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result === '') throw new Error(`invalid_credential_request: ${field} must be a non-empty string`);
  return result;
}

function normalizeFields(input: unknown): CredentialField[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FIELDS) {
    throw new Error(`invalid_credential_request: fields must contain 1-${MAX_FIELDS} entries`);
  }
  const seen = new Set<string>();
  return input.map((entry) => {
    const record = entry as Record<string, unknown>;
    const name = text(record?.name, 'field name');
    if (!FIELD_NAME.test(name)) throw new Error(`invalid_credential_request: field name ${name}`);
    if (seen.has(name)) throw new Error(`invalid_credential_request: duplicate field ${name}`);
    seen.add(name);
    const label = typeof record.label === 'string' && record.label.trim() !== '' ? record.label.trim() : name;
    return { name, label, secret: record.secret === true };
  });
}

function slug(value: string, fallback: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 24);
  return result === '' ? fallback : result;
}

export class CredentialVault {
  readonly path: string;

  constructor(
    dataDir: string,
    private readonly trace: { append(kind: string, record?: Record<string, unknown>, now?: number): void },
    private readonly now: () => number,
  ) {
    this.path = join(dataDir, 'credentials.json');
  }

  list(): CredentialRef[] {
    return this.load().map(({ ref, service, createdAt }) => ({ ref, service, createdAt }));
  }

  save(service: string, fields: CredentialField[], values: Record<string, string>): CredentialRef {
    const entries = this.load();
    const base = slug(service, 'credential');
    let ref = base;
    for (let suffix = 2; entries.some((entry) => entry.ref === ref); suffix += 1) ref = `${base}-${suffix}`;
    const record: CredentialRecord = {
      ref,
      service,
      createdAt: this.now(),
      values: Object.fromEntries(fields.map((field) => [field.name, values[field.name]!])),
    };
    this.store([...entries, record]);
    return { ref, service, createdAt: record.createdAt };
  }

  use(ref: string, caller: string): Record<string, string> {
    const record = this.load().find((entry) => entry.ref === ref);
    if (!record) {
      this.trace.append('credential_use_refused', { ref, caller, reason: 'not_found' }, this.now());
      throw new Error(`credential_not_found: ${ref}`);
    }
    this.trace.append('credential_used', { ref, service: record.service, caller }, this.now());
    return { ...record.values };
  }

  revoke(ref: string): boolean {
    const entries = this.load();
    const record = entries.find((entry) => entry.ref === ref);
    if (!record) {
      this.trace.append('credential_revoke_refused', { ref }, this.now());
      return false;
    }
    this.store(entries.filter((entry) => entry.ref !== ref));
    this.trace.append('credential_revoked', { ref, service: record.service }, this.now());
    return true;
  }

  private load(): CredentialRecord[] {
    if (!existsSync(this.path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new Error('credential_store_corrupt');
    }
    const file = parsed as Partial<CredentialFile> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.entries)) throw new Error('credential_store_corrupt');
    return file.entries as CredentialRecord[];
  }

  private store(entries: CredentialRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
  }
}

export class CredentialService {
  private readonly vault: CredentialVault;
  private readonly waiting = new Map<string, PendingCredential>();
  private seq = 0;

  constructor(
    dataDir: string,
    private readonly trace: { append(kind: string, record?: Record<string, unknown>, now?: number): void },
    private readonly now: () => number,
    private readonly canAsk: () => boolean,
    private readonly onChange: (proposal: CommandProposal) => void,
  ) {
    this.vault = new CredentialVault(dataDir, trace, now);
  }

  request(input: CredentialRequestInput, signal?: AbortSignal): Promise<CredentialOutcome> {
    return this.open(input, signal, this.canAsk());
  }

  requestForOwner(input: CredentialRequestInput): Promise<CredentialOutcome> {
    return this.open(input, undefined, true);
  }

  private open(input: CredentialRequestInput, signal: AbortSignal | undefined, allowed: boolean): Promise<CredentialOutcome> {
    const service = text(input.service, 'service');
    const purpose = text(input.purpose, 'purpose');
    const fields = normalizeFields(input.fields);
    if (!allowed) {
      this.trace.append('credential_request_refused', { service, reason: 'no_owner' }, this.now());
      throw new Error('credential_request_unavailable: only a user-present work run can ask for a credential');
    }
    const at = this.now();
    const id = `credential-${at.toString(36)}-${this.seq++}`;
    const requestedBy = input.requestedBy?.trim() || 'companion';
    const proposal: CommandProposal = {
      id,
      kind: 'credential',
      command: '',
      args: service,
      reason: purpose,
      credential: { service, purpose, fields },
      status: 'pending',
      createdAt: at,
    };
    let resolve!: (outcome: CredentialOutcome) => void;
    const promise = new Promise<CredentialOutcome>((done) => { resolve = done; });
    const entry: PendingCredential = { id, input: { service, purpose, fields, requestedBy }, proposal, promise, resolve, ...(signal ? { signal } : {}) };
    if (signal) {
      entry.onAbort = () => this.cancel(id, 'terminal');
      signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    this.waiting.set(id, entry);
    this.trace.append('credential_requested', { id, service, purpose, fields: fields.map((field) => field.name), requestedBy }, at);
    this.onChange(proposal);
    if (signal?.aborted) this.cancel(id, 'terminal');
    return promise;
  }

  submit(id: string, values: Record<string, string>, surface: string): CredentialSubmission {
    if (surface !== 'terminal' && surface !== 'web') {
      this.trace.append('credential_submit_refused', { id, surface, reason: 'untrusted_surface' }, this.now());
      return { ok: false, reason: 'channel_collection_refused' };
    }
    const pending = this.waiting.get(id);
    if (!pending) {
      this.trace.append('credential_submit_refused', { id, surface, reason: 'no_pending_request' }, this.now());
      return { ok: false, reason: 'no_pending_request' };
    }
    const expected = pending.input.fields.map((field) => field.name).sort();
    const provided = Object.keys(values ?? {}).sort();
    const missing = expected.filter((name) => !provided.includes(name));
    const extra = provided.filter((name) => !expected.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      this.trace.append('credential_submit_refused', { id, surface, reason: 'field_mismatch', missing, extra }, this.now());
      return { ok: false, reason: 'field_mismatch' };
    }
    for (const name of expected) {
      if (typeof values[name] !== 'string' || values[name] === '') {
        this.trace.append('credential_submit_refused', { id, surface, reason: 'empty_field', field: name }, this.now());
        return { ok: false, reason: 'empty_field' };
      }
    }
    let ref: string;
    try {
      ref = this.vault.save(pending.input.service, pending.input.fields, values).ref;
    } catch (error) {
      this.trace.append('credential_save_failed', { id, surface, reason: error instanceof Error ? error.message : String(error) }, this.now());
      return { ok: false, reason: 'credential_store_failed' };
    }
    pending.proposal.status = 'executed';
    pending.proposal.resultText = `已保存：${ref}`;
    this.trace.append('credential_saved', { id, ref, service: pending.input.service, surface, fields: expected }, this.now());
    this.onChange(pending.proposal);
    this.settle(pending, { outcome: 'saved', ref });
    return { ok: true, ref };
  }

  cancel(id: string, surface: string = 'terminal'): boolean {
    if (surface !== 'terminal' && surface !== 'web') {
      this.trace.append('credential_cancel_refused', { id, surface, reason: 'untrusted_surface' }, this.now());
      return false;
    }
    const pending = this.waiting.get(id);
    if (!pending) return false;
    pending.proposal.status = 'discarded';
    pending.proposal.resultText = '已取消';
    this.trace.append('credential_cancelled', { id, service: pending.input.service, surface }, this.now());
    this.onChange(pending.proposal);
    this.settle(pending, { outcome: 'cancelled' });
    return true;
  }

  pending(): CredentialPending[] {
    return [...this.waiting.values()].map(({ id, input, proposal }) => ({
      id,
      service: input.service,
      purpose: input.purpose,
      fields: input.fields,
      requestedBy: input.requestedBy,
      createdAt: proposal.createdAt,
    }));
  }

  isPending(id: string): boolean {
    return this.waiting.has(id);
  }

  proposal(id: string): CommandProposal | undefined {
    return this.waiting.get(id)?.proposal;
  }

  refs(): CredentialRef[] {
    return this.vault.list();
  }

  revoke(ref: string): boolean {
    return this.vault.revoke(ref);
  }

  use(ref: string, caller: string): Record<string, string> {
    return this.vault.use(ref, caller);
  }

  private settle(pending: PendingCredential, outcome: CredentialOutcome): void {
    this.waiting.delete(pending.id);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(outcome);
  }
}
