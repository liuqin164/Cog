/**
 * The shell *is* the kernel host process (guidance topology): one kernel per database, opened here,
 * and the MCP face that other hosts reach serves calls from this same instance.
 *
 * The public kernel surface has no host-mode HTTP transport (`startCogmemMcpHttpServer` is not
 * exported by `cogmem`), so the shell owns a small loopback MCP face over the exported
 * `listCogmemMcpTools` / `callCogmemMcpTool`. That is a probe finding, recorded with F1/F2/F6.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { callCogmemMcpTool, listCogmemMcpTools } from 'cogmem';
import { DeepWriteRedactor } from 'cogmem/internal';
// The observatory's modules are exported by neither `cogmem` nor `cogmem/internal`, so the star map
// is reached by path — and only when it resolves. A shell copied away from the kernel source (the
// detach test does exactly that) keeps serving MCP and simply has no observatory page. Gap F-MCP: a
// host that wants the star map on its own port should not have to know the kernel's file layout.
const OBSERVATORY_MODULE = '../../src/observatory/MemoryObservatory.ts';
const OBSERVATORY_ROUTES = '../../src/observatory/routes.ts';

/**
 * Mirrors `src/mcp/profiles.ts` CORE_TOOLS. The kernel exports neither the profile table nor the
 * `isToolAllowed` helper, so a host that serves its own MCP face has to restate the list. Recorded as
 * gap F-MCP in the #165 list (every host that builds its own transport pays it).
 */
export const CORE_MCP_TOOLS: readonly string[] = [
  'cogmem_recall',
  'cogmem_remember_turn',
  'cogmem_episode_append',
  'cogmem_graph_explore',
  'cogmem_graph_node',
  'cogmem_explain_recall',
];

export interface McpFaceOptions {
  port: number;
  hostname: string;
  path: string;
  profile: 'core' | 'admin' | 'full';
  /** Extra health fields the host wants reported (lifecycle state, version, ...). */
  health?: () => Record<string, unknown>;
}

export interface McpFaceHandle {
  url: string;
  port: number;
  sessions(): number;
  stop(): void;
}

function allowed(profile: McpFaceOptions['profile'], name: string): boolean {
  if (profile === 'full') return true;
  // `admin` is not implemented by this face yet: the shell's face serves `core`, and a wider profile
  // has to name its tools explicitly rather than inheriting an unexported table.
  return CORE_MCP_TOOLS.includes(name);
}

/** One MCP session: its own transport, and its own Protocol — the SDK's Server may own only one. */
interface FaceSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
}

/**
 * The read-only star map, over a connection the page can never write through, or undefined when the
 * kernel has no database file to point a page at (`:memory:` has no second connection) or when the
 * kernel source is not where this shell can see it.
 */
async function openObservatory(
  kernel: unknown,
  dbPath: string | undefined,
): Promise<{ db: Database; handle: (request: Request, remoteAddress?: string) => Promise<Response | null> } | undefined> {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return undefined;
  try {
    const [observatoryModule, routesModule] = await Promise.all([
      import(OBSERVATORY_MODULE),
      import(OBSERVATORY_ROUTES),
    ]);
    const db = new Database(dbPath, { readonly: true });
    const atlas = (kernel as { memoryAtlasService?: { node(...args: unknown[]): any } }).memoryAtlasService;
    const observatory = new observatoryModule.MemoryObservatory({
      db,
      nodeDetail: atlas ? (nodeId: string, projectId: string) => atlas.node(nodeId, { projectId, includeEvidence: true, evidenceLimit: 8, refresh: false, staleOk: true }) : undefined,
    });
    return { db, handle: routesModule.createObservatoryRoutes({ observatory }) };
  } catch {
    return undefined;
  }
}

/** A loopback-only MCP face over the in-process kernel. No credential, so loopback is the boundary. */
export async function startKernelMcpFace(
  kernel: unknown,
  projectId: string,
  options: McpFaceOptions,
): Promise<McpFaceHandle> {
  // One Server per session, not one shared Server: `Protocol.connect` refuses a second transport, so
  // a shared instance could serve exactly one client and answered every later session with the SDK's
  // "Already connected to a transport" error. Sessions are few; a Server apiece is the SDK's shape.
  const sessions = new Map<string, FaceSession>();

  function createFaceServer(): Server {
    const server = new Server(
      { name: 'cogmem-companion-shell', version: '0.1.0-spike' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
      tools: listCogmemMcpTools().filter((tool: { name: string }) => allowed(options.profile, tool.name)),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const name = request.params.name;
      if (!allowed(options.profile, name)) {
        return { isError: true, content: [{ type: 'text', text: `tool_not_in_profile: ${name} is not exposed by profile "${options.profile}"` }] };
      }
      const args = { ...((request.params.arguments ?? {}) as Record<string, unknown>), projectId };
      const result = await callCogmemMcpTool(name, args, { kernel: kernel as any, hostId: 'companion-shell' });
      return result as CallToolResult;
    });
    return server;
  }

  const kernelHealth = (): Record<string, unknown> => {
    try {
      const health = (kernel as { getHealthStatus?: () => { status?: string; package?: string; dbPath?: string } }).getHealthStatus?.();
      if (!health) return { status: 'unknown' };
      return { status: health.status ?? 'unknown', package: health.package, dbPath: health.dbPath };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  };

  const observatory = await openObservatory(kernel, kernelHealth().dbPath as string | undefined);

  const httpServer = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    async fetch(request: Request, server): Promise<Response> {
      const url = new URL(request.url);
      // The install doctor's window into a *running* resident. Opening a second kernel to ask the
      // first how it is would be two writers on one file, which CONCURRENT_ACCESS.md forbids.
      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          service: 'cogmem-companion-shell',
          version: '0.1.0-spike',
          bind: options.hostname,
          port: httpServer.port ?? options.port,
          path: options.path,
          kernel: kernelHealth(),
          ...options.health?.(),
        });
      }
      if (observatory) {
        const response = await observatory.handle(request, server.requestIP(request)?.address ?? undefined);
        if (response) return response;
      }
      if (url.pathname !== options.path) return new Response('not_found', { status: 404 });
      const sessionId = request.headers.get('mcp-session-id');
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return new Response('session_not_found', { status: 404 });
        return session.transport.handleRequest(request);
      }
      const faceServer = createFaceServer();
      let created!: WebStandardStreamableHTTPServerTransport;
      created = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Plain JSON replies. The face is local and loopback-only; SSE buys nothing here and makes a
        // one-call client (the install probe) parse a stream to read one object.
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport: created, server: faceServer });
        },
      });
      created.onclose = () => {
        const id = created.sessionId;
        if (id) sessions.delete(id);
        void faceServer.close();
      };
      await faceServer.connect(created);
      return created.handleRequest(request);
    },
  });
  const actualPort = httpServer.port ?? options.port;
  return {
    url: `http://${options.hostname}:${actualPort}${options.path}`,
    port: actualPort,
    sessions: () => sessions.size,
    stop() {
      for (const session of sessions.values()) {
        void session.transport.close();
        void session.server.close();
      }
      sessions.clear();
      observatory?.db.close();
      httpServer.stop(true);
    },
  };
}

/**
 * Secret redaction for captured text.
 *
 * The kernel's public surface exports no redaction primitive at all: `redactSecretText` and the
 * pattern table live in `src/security/SecretPatterns.ts`, which neither `public.ts` nor `internal.ts`
 * re-exports. `HostBridge` applies it internally to tool observations only, so a channel message or a
 * terminal record has no public path that removes a secret before it reaches the ledger. The shell
 * therefore borrows `DeepWriteRedactor` from the `cogmem/internal` entry and refuses to start without
 * it: writing secrets to the ledger because the import moved is the one failure mode this must not
 * have. This is gap F-SEC in the #165 list.
 */
export class SecretRedactor {
  private readonly redactor = new DeepWriteRedactor();

  redact<T>(value: T): { value: T; count: number; chars: number } {
    const before = typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
    const result = this.redactor.redact(value);
    const after = typeof result.value === 'string' ? result.value.length : JSON.stringify(result.value ?? '').length;
    return { value: result.value, count: result.redactionCount, chars: Math.max(0, before - after) };
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
