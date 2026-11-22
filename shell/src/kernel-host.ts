/**
 * The shell *is* the kernel host process (guidance topology): one kernel per database, opened here.
 *
 * It used to serve that kernel over MCP to other hosts. That face is gone (#200 R2): the shell and
 * the kernel are one process, so an outward MCP endpoint was a second way in with no second reader,
 * and this shell's only other caller — the installer — speaks the control socket instead. What is
 * left on the loopback HTTP port is status and the star map, and nothing that runs a tool: `GET
 * /health` (the doctor's window into a *running* resident, so it never opens a second kernel) and
 * the read-only observatory when the kernel source is beside the shell.
 *
 * The observatory's modules are exported by neither `cogmem` nor `cogmem/internal`, so the star map
 * is reached by path — and only when it resolves. A shell copied away from the kernel source (the
 * detach test does exactly that) keeps serving health and simply has no observatory page. This is
 * the same class of borrow the secret redactor had (#189, now closed) and is named in the round
 * report rather than probed here: it is a relative path into the kernel's file layout, which no
 * package export covers.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecretText } from 'cogmem';
import { readMemoryUsage } from './memory.ts';

// Source: the kernel's TypeScript beside the checkout. Published: the compiled copy under dist/.
const SOURCE_LAYOUT = import.meta.url.endsWith('.ts');
const OBSERVATORY_MODULE = SOURCE_LAYOUT ? '../../src/observatory/MemoryObservatory.ts' : '../observatory/MemoryObservatory.js';
const OBSERVATORY_ROUTES = SOURCE_LAYOUT ? '../../src/observatory/routes.ts' : '../observatory/routes.js';
const OBSERVATORY_TOKEN = SOURCE_LAYOUT ? '../../src/observatory/token.ts' : '../observatory/token.js';

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
  webChannel?: () => { handle(request: Request, remoteAddress?: string): Promise<Response | null> } | undefined;
}

export interface HttpCredentialFace {
  pending(): Array<{ id: string; service: string; purpose: string; fields: Array<{ name: string; label?: string; secret?: boolean }>; requestedBy: string; createdAt: number }>;
  refs(): Array<{ ref: string; service: string; createdAt: number }>;
  submit(id: string, values: Record<string, string>, surface: string): { ok: true; ref: string } | { ok: false; reason: string };
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

/**
 * The read-only star map, over a connection the page can never write through, or undefined when the
 * kernel has no database file to point a page at (`:memory:` has no second connection) or when the
 * kernel source is not where this shell can see it.
 */
async function openObservatory(
  kernel: unknown,
  dbPath: string | undefined,
  connectedAgents?: () => string[],
  tracePath?: string,
  credentials?: HttpCredentialFace,
  channels?: HttpChannelFace,
): Promise<{ db: Database; handle: (request: Request, remoteAddress?: string) => Promise<Response | null> } | undefined> {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return undefined;
  try {
    const [observatoryModule, routesModule, tokenModule] = await Promise.all([
      import(OBSERVATORY_MODULE),
      import(OBSERVATORY_ROUTES),
      import(OBSERVATORY_TOKEN),
    ]);
    const db = new Database(dbPath, { readonly: true });
    const atlas = (kernel as { memoryAtlasService?: { node(...args: unknown[]): any } }).memoryAtlasService;
    // The factory's shape drifted under the shell (23-165 probe): it takes the kernel's event
    // stream as a second positional argument now, not an options object. The stream is what backs
    // `/observatory/events`, so borrowing it keeps this face identical to the kernel's own
    // `startObservatoryServer` rather than a variant with one route missing.
    const events = (kernel as { events?: unknown }).events;
    const soul = (kernel as { soul?: unknown }).soul as Parameters<typeof routesModule.createObservatoryRoutes>[2];
    const observatory = new observatoryModule.MemoryObservatory({
      db,
      nodeDetail: atlas ? (nodeId: string, projectId: string) => atlas.node(nodeId, { projectId, includeEvidence: true, evidenceLimit: 8, refresh: false, staleOk: true }) : undefined,
      connectedAgents,
      tracePath: tracePath ?? (dbPath ? join(dirname(dbPath), 'shell-events.jsonl') : undefined),
    });
    return {
      db,
      handle: routesModule.createObservatoryRoutes(observatory, events, soul, {
        token: tokenModule.readObservatoryToken(dirname(dbPath)),
        credentials,
        channels,
      }),
    };
  } catch {
    return undefined;
  }
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

  const observatory = await openObservatory(kernel, kernelHealth().dbPath as string | undefined, options.connectedAgents, options.tracePath, options.credentials, options.channels);

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

/**
 * Secret redaction for captured text (#189).
 *
 * `redactSecretText` is the kernel's public primitive: the same pattern table the kernel's own
 * write path counts with, so a value redacted here and a value redacted there come out identical.
 * The shell used to borrow `DeepWriteRedactor` from `cogmem/internal` because the public surface
 * had no secret primitive; #189 promoted the text helpers, and this class is now only the
 * structured-value walk over that primitive.
 */
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
