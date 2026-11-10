import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createMemoryKernel } from 'cogmem';
import { CORE_MCP_TOOLS, startKernelMcpFace } from '../src/kernel-host.ts';
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
});
