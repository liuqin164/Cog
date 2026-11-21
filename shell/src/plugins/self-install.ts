import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { TraceLog, TraceRecord } from '../trace.ts';
import type { PluginsAdmin } from '../plugins-admin.ts';
import type { CommandProposal } from '../proposals.ts';
import { checkPluginSpec } from './load.ts';
import { readPluginRegistry } from './registry.ts';
import { RESERVED_BUILTIN_TOOLS, RESERVED_CORE_COMMANDS, type NativePlugin, type ToolOutcome } from './host.ts';

export const PLUGIN_WORKSPACE_DIR = 'plugin-workspace';

export const RESERVED_PLUGIN_NAMES: readonly string[] = [
  'clock',
  'model-router',
  'provided-model',
  'cage',
  'builtin-tools',
  'command-proposals',
  'ask-user',
  'assignment',
  'capture',
  'session-context',
  'memory-tool',
  'soul-edit',
  'dream',
  'emergence',
  'terminal-channel',
  'web',
  'web-channel',
  'plugin-self-install',
];

export interface PluginPermissions {
  provide: string[];
  inject: string[];
  data: string[];
}

export interface PluginProposal extends CommandProposal {
  kind: 'plugin';
  name: string;
  purpose: string;
  sourcePath: string;
  sourceSha256: string;
  sourceBytes: number;
  permissions: PluginPermissions;
  removal: string;
  approvedAt?: number;
}

export interface ProposePluginInput {
  name: string;
  purpose: string;
  source?: string;
  sourcePath?: string;
  permissions?: Partial<PluginPermissions>;
}

export interface PluginProposeResult {
  accepted: boolean;
  proposal?: PluginProposal;
  reason?: string;
}

export interface PluginProposalsOptions {
  dataDir: string;
  workspaceRoot: string;
  trace: TraceLog;
  now: () => number;
  serviceExists: (name: string) => boolean;
  onChange?: (proposal: PluginProposal) => void;
}

export function pluginWorkspaceDir(dataDir: string): string {
  return join(dataDir, PLUGIN_WORKSPACE_DIR);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) return undefined;
  return value.map((entry) => entry.trim());
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function reservedNameInSource(source: string): string | undefined {
  for (const name of RESERVED_BUILTIN_TOOLS) {
    if (new RegExp(`registerTool\\s*\\(\\s*\\{[\\s\\S]*?\\bname\\s*:\\s*['"]${name}['"]`, 'u').test(source)) return name;
  }
  for (const name of RESERVED_CORE_COMMANDS) {
    if (new RegExp(`registerCommand\\s*\\(\\s*\\{[\\s\\S]*?\\bname\\s*:\\s*['"]${name}['"]`, 'u').test(source)) return `/${name}`;
  }
  return undefined;
}

export class PluginProposals {
  private readonly byId = new Map<string, PluginProposal>();
  private seq = 0;

  constructor(private readonly options: PluginProposalsOptions) {}

  get(id: string): PluginProposal | undefined {
    return this.byId.get(id);
  }

  pending(): PluginProposal[] {
    return [...this.byId.values()].filter((proposal) => proposal.status === 'pending');
  }

  private removeStagedSource(sourcePath: string): void {
    const source = resolve(sourcePath);
    const workspace = resolve(pluginWorkspaceDir(this.options.dataDir));
    if (dirname(dirname(source)) !== workspace) return;
    try {
      if (readPluginRegistry(this.options.dataDir).some((spec) => spec === sourcePath || resolve(spec) === source)) return;
    } catch {
      return;
    }
    rmSync(dirname(source), { recursive: true, force: true });
  }

  propose(input: ProposePluginInput): PluginProposeResult {
    const name = input.name.trim();
    const purpose = input.purpose.trim();
    const at = this.options.now();
    const id = `plugin-proposal-${at.toString(36)}-${this.seq++}`;
    const reject = (reason: string): PluginProposeResult => {
      this.options.trace.append('plugin_proposal_rejected', { id, name, purpose, reason }, at);
      return { accepted: false, reason };
    };
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) return reject(`invalid_plugin_name: ${name || '（空）'}`);
    if (RESERVED_PLUGIN_NAMES.includes(name)) return reject(`plugin_name_reserved: ${name} 是内置插件名`);
    if (purpose === '') return reject('plugin_purpose_required');
    if (!input.permissions) return reject('plugin_permissions_required: 需要 provide/inject/data 权限面声明');
    const provide = stringList(input.permissions.provide);
    const inject = stringList(input.permissions.inject);
    const data = stringList(input.permissions.data);
    if (!provide || !inject || !data) {
      return reject('plugin_permissions_required: provide/inject/data 必须都是字符串数组');
    }
    if (new Set(provide).size !== provide.length || new Set(inject).size !== inject.length) {
      return reject('plugin_permissions_invalid: provide/inject 不得重复');
    }
    if (provide.some((service) => inject.includes(service))) {
      return reject('plugin_permissions_invalid: 不得 provide 并 inject 同一个服务');
    }
    for (const service of inject) {
      if (!this.options.serviceExists(service)) return reject(`plugin_service_missing: ${service} 不是当前可注入的服务`);
    }
    for (const service of provide) {
      if (this.options.serviceExists(service)) return reject(`plugin_service_conflict: ${service} 已被占用`);
    }
    const workspace = pluginWorkspaceDir(this.options.dataDir);
    const entry = join(workspace, name, 'index.ts');
    if (input.sourcePath) {
      const requested = resolve(input.sourcePath);
      if (requested !== workspace && !requested.startsWith(workspace + sep)) {
        return reject(`path_outside_plugin_workspace: ${input.sourcePath}`);
      }
      if (!existsSync(requested)) return reject(`plugin_not_found: ${requested}`);
      let source: string;
      try {
        source = readFileSync(requested, 'utf8');
      } catch (error) {
        return reject(`plugin_unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.record(id, at, name, purpose, requested, source, { provide, inject, data }, reject);
    }
    const source = textOf(input.source);
    if (source.trim() === '') return reject('plugin_source_required');
    try {
      if (readPluginRegistry(this.options.dataDir).includes(entry)) return reject(`plugin_already_registered: ${entry}`);
    } catch (error) {
      return reject(`plugin_registry_unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
    writeFileSync(entry, source, { mode: 0o600 });
    const result = this.record(id, at, name, purpose, entry, source, { provide, inject, data }, reject);
    if (!result.accepted) rmSync(dirname(entry), { recursive: true, force: true });
    return result;
  }

  private record(
    id: string,
    at: number,
    name: string,
    purpose: string,
    entry: string,
    source: string,
    permissions: PluginPermissions,
    reject: (reason: string) => PluginProposeResult,
  ): PluginProposeResult {
    let registered: string[];
    try {
      registered = readPluginRegistry(this.options.dataDir);
    } catch (error) {
      return reject(`plugin_registry_unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (registered.includes(entry)) return reject(`plugin_already_registered: ${entry}`);
    const reserved = reservedNameInSource(source);
    if (reserved) return reject(`plugin_reserved_name: ${reserved} 是内置工具或核心命令，插件不得覆盖`);
    const refused = checkPluginSpec(entry, {
      cwd: this.options.workspaceRoot,
      roots: [pluginWorkspaceDir(this.options.dataDir)],
    });
    if (refused) return reject(refused);
    const sourceBytes = Buffer.byteLength(source, 'utf8');
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const removal = `/plugins remove ${entry}`;
    const proposal: PluginProposal = {
      id,
      kind: 'plugin',
      command: 'plugin',
      args: name,
      reason: purpose,
      status: 'pending',
      createdAt: at,
      name,
      purpose,
      sourcePath: entry,
      sourceSha256,
      sourceBytes,
      permissions,
      removal,
      detail: [
        `源码：${entry}（${sourceBytes} 字节，sha256 ${sourceSha256.slice(0, 12)}）`,
        `权限：provide=[${permissions.provide.join(', ')}] inject=[${permissions.inject.join(', ')}] data=[${permissions.data.join(', ')}]`,
        `摘除：${removal}`,
      ],
    };
    this.byId.set(id, proposal);
    this.options.trace.append('plugin_proposed', {
      id,
      name,
      purpose,
      spec: entry,
      sourcePath: entry,
      sourceBytes,
      sourceSha256,
      permissions,
      removal,
    }, at);
    this.options.onChange?.(proposal);
    return { accepted: true, proposal };
  }

  markApproved(id: string): PluginProposal | undefined {
    const proposal = this.byId.get(id);
    if (!proposal || proposal.status !== 'pending') return undefined;
    proposal.status = 'executed';
    proposal.approvedAt = this.options.now();
    this.options.trace.append('plugin_approved', {
      id,
      name: proposal.name,
      spec: proposal.sourcePath,
      permissions: proposal.permissions,
    }, proposal.approvedAt);
    this.options.onChange?.(proposal);
    return proposal;
  }

  discard(id: string): PluginProposal | undefined {
    const proposal = this.byId.get(id);
    if (!proposal || proposal.status !== 'pending') return undefined;
    proposal.status = 'discarded';
    this.options.trace.append('plugin_proposal_discarded', { id, name: proposal.name, spec: proposal.sourcePath, reason: 'owner_discarded' });
    this.removeStagedSource(proposal.sourcePath);
    this.options.onChange?.(proposal);
    return proposal;
  }

  settle(id: string, text: string, ok: boolean): PluginProposal | undefined {
    const proposal = this.byId.get(id);
    if (!proposal) return undefined;
    proposal.resultText = text;
    if (!ok) {
      proposal.status = 'rejected';
      proposal.rejectedReason = text;
      this.removeStagedSource(proposal.sourcePath);
    }
    this.options.onChange?.(proposal);
    return proposal;
  }
}

export type PluginAuditStatus =
  | 'pending'
  | 'approved'
  | 'registered'
  | 'pending-health'
  | 'installed'
  | 'rejected'
  | 'discarded'
  | 'removed';

export interface PluginAuditEntry {
  id: string;
  name: string;
  purpose: string;
  spec: string;
  sourcePath: string;
  permissions: PluginPermissions | null;
  removal: string;
  status: PluginAuditStatus;
  statusReason?: string;
  at: number;
}

function statusOf(record: TraceRecord): PluginAuditStatus | undefined {
  switch (record.kind) {
    case 'plugin_proposed': return 'pending';
    case 'plugin_approved': return 'approved';
    case 'plugin_registered': return 'registered';
    case 'plugin_install_pending_health': return 'pending-health';
    case 'plugin_health_ok': return 'installed';
    case 'plugin_health_failed':
    case 'plugin_install_rejected':
    case 'plugin_proposal_rejected': return 'rejected';
    case 'plugin_proposal_discarded': return 'discarded';
    case 'plugin_removed': return 'removed';
    default: return undefined;
  }
}

export function pluginAuditEntries(trace: TraceLog): PluginAuditEntry[] {
  const entries = new Map<string, PluginAuditEntry>();
  for (const record of trace.read()) {
    const id = typeof record.id === 'string' ? record.id : '';
    if (id === '') continue;
    const status = statusOf(record);
    if (!status) continue;
    const previous = entries.get(id);
    const spec = textOf(record.spec) || previous?.spec || '';
    const name = textOf(record.name) || previous?.name || '';
    const purpose = textOf(record.purpose) || previous?.purpose || '';
    const permissions = record.permissions && typeof record.permissions === 'object'
      ? record.permissions as PluginPermissions
      : previous?.permissions ?? null;
    const removal = textOf(record.removal) || previous?.removal || (spec ? `/plugins remove ${spec}` : '');
    entries.set(id, {
      id,
      name,
      purpose,
      spec,
      sourcePath: textOf(record.sourcePath) || previous?.sourcePath || spec,
      permissions,
      removal,
      status,
      ...(textOf(record.healthReason)
        ? { statusReason: textOf(record.healthReason) }
        : textOf(record.reason)
          ? { statusReason: textOf(record.reason) }
          : previous?.statusReason
            ? { statusReason: previous.statusReason }
            : {}),
      at: record.at,
    });
  }
  return [...entries.values()];
}

export function latestAuditForSpec(trace: TraceLog, spec: string): PluginAuditEntry | undefined {
  return pluginAuditEntries(trace).filter((entry) => entry.spec === spec).pop();
}

function field(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

function statusLine(entry: PluginAuditEntry): string {
  const reason = entry.statusReason ? `：${entry.statusReason}` : '';
  return `${entry.id} · ${entry.name || entry.spec} · ${entry.status}${reason}`;
}

export function selfInstallPlugin(options: { proposals: PluginProposals; admin: PluginsAdmin; trace: TraceLog }): NativePlugin {
  return {
    name: 'plugin-self-install',
    apply(ctx) {
      ctx.registerTool({
        name: 'propose_plugin',
        description:
          'Offer the owner a native plugin to install. The source is staged in the controlled plugin workspace and recorded with its name, purpose, permission surface, and removal method; it is not loaded until the owner approves the proposal. Only source under that workspace is accepted. Declare every tool with ctx.registerTool: the host adds a loaded plugin\'s registered tools to the cage whitelist automatically and removes them on uninstall, so you do not need to inject "cage" or call cage.allowTools yourself. permissions.provide registers services, permissions.inject requires existing ones, and permissions.data names the data touched.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Lowercase plugin name, e.g. "hello-clock"' },
            purpose: { type: 'string', description: 'One line telling the owner what the plugin does and why' },
            source: { type: 'string', description: 'The full TypeScript/JavaScript module source, default-exporting a NativePlugin' },
            permissions: {
              type: 'object',
              description: 'The plugin permission surface: services it provides, services it injects, and what data it touches',
              properties: {
                provide: { type: 'array', items: { type: 'string' } },
                inject: { type: 'array', items: { type: 'string' } },
                data: { type: 'array', items: { type: 'string' } },
              },
              required: ['provide', 'inject', 'data'],
            },
          },
          required: ['name', 'purpose', 'source', 'permissions'],
        },
        execute({ args }): ToolOutcome {
          const raw = (args as Record<string, unknown> | undefined)?.permissions;
          const permissions = raw && typeof raw === 'object' ? raw as Partial<PluginPermissions> : undefined;
          const result = options.proposals.propose({
            name: field(args, 'name'),
            purpose: field(args, 'purpose'),
            source: field(args, 'source'),
            ...(permissions ? { permissions } : {}),
          });
          if (!result.accepted || !result.proposal) {
            return { output: `proposal_rejected: ${result.reason ?? 'unknown'}`, isError: true };
          }
          return {
            output: `plugin_proposed: ${result.proposal.name} 已写入 ${result.proposal.sourcePath}，等待主人批准（提议 ${result.proposal.id}）。批准前不会加载。摘除：${result.proposal.removal}`,
            isError: false,
          };
        },
      });
      ctx.registerTool({
        name: 'plugin_proposal_status',
        description:
          'Read the plugin audit ledger: one proposal by id, or every plugin proposal and its latest state (pending, approved, installed, rejected, removed).',
        replay: 'safe',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Proposal id; omit to list every proposal' },
          },
        },
        execute({ args }): ToolOutcome {
          const id = field(args, 'id').trim();
          const entries = pluginAuditEntries(options.trace);
          if (id !== '') {
            const entry = entries.find((candidate) => candidate.id === id);
            if (!entry) return { output: `plugin_proposal_not_found: ${id}`, isError: true };
            return {
              output: [
                statusLine(entry),
                `用途：${entry.purpose || '（未记录）'}`,
                `源码：${entry.sourcePath || '（未接受）'}`,
                entry.permissions
                  ? `权限：provide=[${entry.permissions.provide.join(', ')}] inject=[${entry.permissions.inject.join(', ')}] data=[${entry.permissions.data.join(', ')}]`
                  : '权限：未记录',
                `摘除：${entry.removal || `（无记录）`}`,
              ].join('\n'),
              isError: false,
            };
          }
          if (entries.length === 0) return { output: '插件提案账本为空。', isError: false };
          return { output: entries.slice(-50).map(statusLine).join('\n'), isError: false };
        },
      });
      ctx.registerTool({
        name: 'installed_plugins',
        description:
          'List the plugins currently registered in plugins.json with load health, why each was installed, and the exact removal command.',
        replay: 'safe',
        parameters: { type: 'object', properties: {} },
        execute(): ToolOutcome {
          const state = options.admin.pluginState();
          if (state.registered.length === 0) return { output: '没有已装插件。', isError: false };
          const audit = pluginAuditEntries(options.trace);
          const lines = state.registered.map((spec) => {
            const result = state.results.find((entry) => entry.spec === spec);
            const proposed = audit.filter((entry) => entry.spec === spec).pop();
            const lineState = result
              ? `${result.status}${result.tools.length > 0 ? ` tools=[${result.tools.join(', ')}]` : ''}${result.reason ? ` ${result.reason}` : ''}`
              : '本进程未加载（注册后尚未重启）';
            return `- ${proposed?.name ?? spec} · ${spec} · ${lineState} · 用途：${proposed?.purpose ?? '手动登记，无提案记录'} · 摘除：${proposed?.removal ?? `/plugins remove ${spec}`}`;
          });
          return { output: lines.join('\n'), isError: false };
        },
      });
    },
  };
}
