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
import { randomUUID } from 'node:crypto';
import { callCogmemMcpTool, listCogmemMcpTools } from 'cogmem';
import { DeepWriteRedactor } from 'cogmem/internal';

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

/** A loopback-only MCP face over the in-process kernel. No credential, so loopback is the boundary. */
export async function startKernelMcpFace(
  kernel: unknown,
  projectId: string,
  options: McpFaceOptions,
): Promise<McpFaceHandle> {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
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
  await server.connect(new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() }));

  const httpServer = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== options.path) return new Response('not_found', { status: 404 });
      const sessionId = request.headers.get('mcp-session-id');
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (sessionId) return new Response('session_not_found', { status: 404 });
        const created: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            transports.set(id, created);
          },
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        await server.connect(created);
        transport = created;
      }
      return transport!.handleRequest(request);
    },
  });
  const actualPort = httpServer.port ?? options.port;
  return {
    url: `http://${options.hostname}:${actualPort}${options.path}`,
    port: actualPort,
    sessions: () => transports.size,
    stop() {
      for (const transport of transports.values()) void transport.close();
      transports.clear();
      void server.close();
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
