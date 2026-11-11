/**
 * The smallest Streamable-HTTP MCP client that can drive the resident's own face: initialize, one
 * tool call. The first-wake probe goes through here rather than opening a second kernel, because two
 * writer kernels on one file is the one thing CONCURRENT_ACCESS.md forbids — the running resident is
 * the writer, and this is how the installer asks it to remember and recall.
 */
export interface McpToolResult {
  isError: boolean;
  text: string;
}

export interface McpSession {
  readonly sessionId: string;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
}

async function rpc(url: string, body: unknown, sessionId?: string, timeoutMs = 30_000): Promise<{ response: Response; payload?: JsonRpcResponse }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (text.trim() === '') return { response };
  try {
    return { response, payload: JSON.parse(text) as JsonRpcResponse };
  } catch {
    // An SSE frame still carries the JSON on its `data:` line.
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    if (dataLine) return { response, payload: JSON.parse(dataLine.slice('data:'.length).trim()) as JsonRpcResponse };
    throw new Error(`mcp_unparseable_response: ${text.slice(0, 200)}`);
  }
}

export async function openMcpSession(url: string, timeoutMs = 30_000): Promise<McpSession> {
  const initialize = await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cogmem-install-probe', version: '0.1.0' } },
  }, undefined, timeoutMs);
  const sessionId = initialize.response.headers.get('mcp-session-id');
  if (!initialize.response.ok || !sessionId) {
    throw new Error(`mcp_initialize_failed: HTTP ${initialize.response.status}${initialize.payload?.error?.message ? ` ${initialize.payload.error.message}` : ''}`);
  }
  // The notification has no id and no reply; a 202 is the whole contract.
  await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, timeoutMs);

  let nextId = 2;
  return {
    sessionId,
    async callTool(name, args) {
      const { response, payload } = await rpc(url, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, sessionId, timeoutMs);
      if (!response.ok || payload?.error) {
        throw new Error(`mcp_tool_failed: ${name} HTTP ${response.status} ${payload?.error?.message ?? ''}`.trim());
      }
      const content = payload?.result?.content ?? [];
      const text = content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
      return { isError: payload?.result?.isError === true, text };
    },
    close() {
      // Streamable HTTP sessions end by dropping the id; there is no explicit close verb in this face.
    },
  };
}
