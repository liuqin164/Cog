/**
 * The shell *is* the kernel host process (guidance topology): one kernel per database, opened here.
 *
 * It used to serve that kernel over MCP to other hosts. That face is gone (#200 R2): the shell and
 * the kernel are one process, so an outward MCP endpoint was a second way in with no second reader,
 * and this shell's only other caller — the installer — speaks the control socket instead. What is
 * left on the loopback HTTP port is status and the star map, and nothing that runs a tool: `GET
 * /health` (the doctor's window into a *running* resident, so it never opens a second kernel) and
 * the read-only observatory.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecretText } from 'cogmem';
import {
  createObservatoryRoutes,
  MemoryObservatory,
  readObservatoryToken,
} from 'cogmem';
import { readMemoryUsage } from './memory.ts';

/** The product manifest beside this module (`dist/shell` → package root). */
function productVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
      if (typeof version === 'string' && version !== '') return version;
    } catch {
      // Keep walking: src and dist sit at different depths.
    }
    dir = dirname(dir);
  }
  return 'unknown';
}

export interface HttpFaceOptions {
  port: number;
  hostname: string;
  /** Extra health fields the host wants reported (lifecycle state, version, ...). */
  health?: () => Record<string, unknown>;
  healthStatus?: () => string;
  /** The companion's own identity, listed in the roster before it has written a ledger row. */
  connectedAgents?: () => string[];
  /** The shell's trace file; the observatory reads its surfacing counts from it. */
  tracePath?: string;
  credentials?: HttpCredentialFace;
  channels?: HttpChannelFace;
  companionName?: () => string;
  companionAvatar?: () => string;
  webChannel?: () => {
    handle(request: Request, remoteAddress?: string): Promise<Response | null>;
    uiContribution?(): { id: string; label: string; script: string; style?: string };
  } | undefined;
}

export interface HttpCredentialFace {
  pending(): Array<{ id: string; service: string; purpose: string; fields: Array<{ name: string; label?: string; secret?: boolean }>; requestedBy: string; createdAt: number; allowedOrigins?: string[] }>;
  refs(): Array<{ ref: string; service: string; createdAt: number; allowedOrigins?: string[] }>;
  submit(id: string, values: Record<string, string>, surface: string, allowedOrigins?: string[]): { ok: true; ref: string } | { ok: false; reason: string };
  cancel(id: string, surface: string): boolean;
  revoke(ref: string): boolean;
}

export interface HttpChannelCard {
  id: string;
  name: string;
  state: 'disconnected' | 'pairing' | 'connected' | 'error';
  detail?: string;
  pairingCode?: string;
  config: Array<{ name: string; label?: string; secret?: boolean }>;
  connectable: boolean;
}

export interface HttpChannelFace {
  list(): HttpChannelCard[];
  begin(id: string): { ok: boolean; requestId?: string; error?: string };
  start(id: string, ref: string): { ok: boolean; channel?: HttpChannelCard; error?: string };
  disconnect(id: string): { ok: boolean; channel?: HttpChannelCard; error?: string };
}

export interface HttpFaceHandle {
  /** `http://host:port`; the resident's address, used in what the installer prints. */
  baseUrl: string;
  healthUrl: string;
  port: number;
  stop(): void;
}

async function openObservatory(
  kernel: unknown,
  dbPath: string | undefined,
  connectedAgents?: () => string[],
  tracePath?: string,
  credentials?: HttpCredentialFace,
  channels?: HttpChannelFace,
  ui?: { slots: () => Array<{ id: string; label: string; script: string; style?: string }>; name: () => string; avatar: () => string },
): Promise<{ db: Database; handle: (request: Request, remoteAddress?: string) => Promise<Response | null> } | undefined> {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return undefined;
  const db = new Database(dbPath, { readonly: true });
  const atlas = (kernel as { memoryAtlasService?: { node(...args: unknown[]): any } }).memoryAtlasService;
  const events = (kernel as { events?: unknown }).events as Parameters<typeof createObservatoryRoutes>[1];
  const soul = (kernel as { soul?: unknown }).soul as Parameters<typeof createObservatoryRoutes>[2];
  const observatory = new MemoryObservatory({
    db,
    nodeDetail: atlas ? (nodeId: string, projectId: string) => atlas.node(nodeId, { projectId, includeEvidence: true, evidenceLimit: 8, refresh: false, staleOk: true }) : undefined,
    connectedAgents,
    tracePath: tracePath ?? (dbPath ? join(dirname(dbPath), 'shell-events.jsonl') : undefined),
  });
  return {
    db,
    handle: createObservatoryRoutes(observatory, events, soul, {
      token: readObservatoryToken(dirname(dbPath)),
      credentials,
      channels,
      uiSlots: ui?.slots,
      companionName: ui?.name,
      companionAvatar: ui?.avatar,
    }),
  };
}

/** A loopback-only HTTP face over the in-process kernel: status and the read-only star map. */
export async function startKernelHttpFace(kernel: unknown, options: HttpFaceOptions): Promise<HttpFaceHandle> {
  const kernelHealth = (): Record<string, unknown> => {
    try {
      const health = (kernel as { getHealthStatus?: () => { status?: string; package?: string; dbPath?: string; storage?: unknown; backlog?: unknown } }).getHealthStatus?.();
      if (!health) return { status: 'unknown' };
      return { status: health.status ?? 'unknown', package: health.package, dbPath: health.dbPath, storage: health.storage, backlog: health.backlog };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  };

  const observatory = await openObservatory(kernel, kernelHealth().dbPath as string | undefined, options.connectedAgents, options.tracePath, options.credentials, options.channels, {
    slots: () => {
      const slots = [];
      const web = options.webChannel?.()?.uiContribution?.();
      if (web) slots.push(web);
      if (options.channels) slots.push({ id: 'channels', label: '渠道', script: '/observatory/channels.js', style: '/observatory/channels.css' });
      return slots;
    },
    name: () => options.companionName?.() ?? 'Cog',
    avatar: () => options.companionAvatar?.() ?? 'C',
  });

  const httpServer = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    async fetch(request: Request, server): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        const { storage, backlog, ...kernel } = kernelHealth();
        return Response.json({
          status: options.healthStatus?.() ?? 'ok',
          service: 'cogmem-companion-shell',
          version: productVersion(),
          bind: options.hostname,
          port: httpServer.port ?? options.port,
          kernel,
          storage,
          backlog,
          // The process's own RSS and the unit's ceiling (#226): the doctor reads them here rather
          // than asking systemd, so the same number is visible with no service manager.
          memory: readMemoryUsage(),
          ...options.health?.(),
        });
      }
      const channel = options.webChannel?.();
      if (channel) {
        const response = await channel.handle(request, server.requestIP(request)?.address ?? undefined);
        if (response) return response;
      }
      if (observatory) {
        const response = await observatory.handle(request, server.requestIP(request)?.address ?? undefined);
        if (response) return response;
      }
      return new Response('not_found', { status: 404 });
    },
  });
  const actualPort = httpServer.port ?? options.port;
  return {
    baseUrl: `http://${options.hostname}:${actualPort}`,
    healthUrl: `http://${options.hostname}:${actualPort}/health`,
    port: actualPort,
    stop() {
      observatory?.db.close();
      httpServer.stop(true);
    },
  };
}

export class SecretRedactor {
  redact<T>(value: T): { value: T; count: number; chars: number } {
    return redactValue(value);
  }

  /** The ledger mark. `total` is what the kernel's own suppression checks read. */
  mark<T>(value: T): { value: T; metadata: Record<string, unknown> } {
    const result = this.redact(value);
    if (result.count === 0) return { value: result.value, metadata: {} };
    return {
      value: result.value,
      metadata: { secretFindings: { total: result.count }, redaction: { count: result.count, chars: result.chars } },
    };
  }
}

function redactValue<T>(value: T): { value: T; count: number; chars: number } {
  if (typeof value === 'string') {
    const result = redactSecretText(value);
    return { value: result.text as T, count: result.count, chars: result.chars };
  }
  if (Array.isArray(value)) {
    let count = 0;
    let chars = 0;
    const redacted = value.map((item) => {
      const result = redactValue(item);
      count += result.count;
      chars += result.chars;
      return result.value;
    });
    return { value: redacted as T, count, chars };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    let chars = 0;
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const result = redactValue(child);
      count += result.count;
      chars += result.chars;
      redacted[key] = result.value;
    }
    return { value: redacted as T, count, chars };
  }
  return { value, count: 0, chars: 0 };
}
