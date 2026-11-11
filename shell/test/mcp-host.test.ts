import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createMemoryKernel } from 'cogmem';
import { CORE_MCP_TOOLS, startKernelMcpFace } from '../src/kernel-host.ts';
import { openMcpSession } from '../src/install/mcp.ts';
import { makeTempDir } from './helpers.ts';

describe('in-process kernel host and its MCP face', () => {
  test('the restated core profile names stay inside the eight-tool budget and exist in the kernel', async () => {
    const { listCogmemMcpTools } = await import('cogmem');
    const kernelTools = new Set(listCogmemMcpTools().map((tool: { name: string }) => tool.name));
    expect(CORE_MCP_TOOLS.length).toBeLessThanOrEqual(8);
    for (const name of CORE_MCP_TOOLS) expect(kernelTools.has(name)).toBe(true);
  });

  test('the MCP face starts on the kernel the shell owns and stops cleanly', async () => {
    const dir = makeTempDir();
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const face = await startKernelMcpFace(kernel, 'companion-test', { port: 0, hostname: '127.0.0.1', path: '/mcp', profile: 'core' });
    try {
      expect(face.port).toBeGreaterThan(0);
      expect(face.url).toContain(':');
      expect(face.sessions()).toBe(0);
      // A non-MCP path is a plain 404, not a crash.
      const response = await fetch(`http://127.0.0.1:${face.port}/nope`);
      expect(response.status).toBe(404);
    } finally {
      face.stop();
      kernel.close();
    }
  });

  test('two sessions in a row are both served, and /health answers without a second kernel', async () => {
    const dir = makeTempDir();
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const face = await startKernelMcpFace(kernel, 'companion-test', { port: 0, hostname: '127.0.0.1', path: '/mcp', profile: 'core' });
    try {
      const health = (await (await fetch(`http://127.0.0.1:${face.port}/health`)).json()) as { status: string; bind: string; kernel?: { package?: string } };
      expect(health.status).toBe('ok');
      expect(health.bind).toBe('127.0.0.1');
      expect(health.kernel?.package).toBe('cogmem');

      // The regression this test pins: a shared Server refused every session after the first with
      // "Already connected to a transport", and this loop is what a real host does.
      const first = await openMcpSession(face.url);
      const second = await openMcpSession(face.url);
      expect((await first.callTool('cogmem_recall', { query: 'anything' })).isError).toBe(false);
      expect((await second.callTool('cogmem_recall', { query: 'anything' })).isError).toBe(false);
      expect(face.sessions()).toBe(2);
    } finally {
      face.stop();
      kernel.close();
    }
  });

  test('the star map is mounted read-only beside the MCP path', async () => {
    const dir = makeTempDir();
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.sqlite'), projectTimeZone: 'UTC' });
    const face = await startKernelMcpFace(kernel, 'companion-test', { port: 0, hostname: '127.0.0.1', path: '/mcp', profile: 'core' });
    try {
      const page = await fetch(`http://127.0.0.1:${face.port}/observatory/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const snapshot = await fetch(`http://127.0.0.1:${face.port}/observatory/snapshot`);
      expect(snapshot.status).toBe(200);
      // The page is GET-only.
      expect((await fetch(`http://127.0.0.1:${face.port}/observatory/snapshot`, { method: 'POST' })).status).toBe(405);
    } finally {
      face.stop();
      kernel.close();
    }
  });
});
