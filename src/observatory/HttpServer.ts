import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createMemoryKernel, createMemoryKernelFromConfig, type MemoryKernel } from '../factory.js';
import { ensureUsableTempSpace } from '../utils/SqliteTempDirectory.js';
import { createObservatoryCandidateFace } from './candidates.js';
import { MemoryObservatory } from './MemoryObservatory.js';
import { createObservatoryRoutes, OBSERVATORY_PREFIX, type ObservatoryChannelFace, type ObservatoryCredentialFace } from './routes.js';
import { readObservatoryToken } from './token.js';

export interface ObservatoryRuntime {
  kernel?: MemoryKernel;
  dbPath?: string;
  configPath?: string;
  cwd?: string;
  connectedAgents?: () => string[];
  tracePath?: string;
}

export interface ObservatoryServerOptions extends ObservatoryRuntime {
  port: number;
  hostname?: string;
  credentials?: ObservatoryCredentialFace;
  channels?: ObservatoryChannelFace;
}

export interface ObservatoryServerHandle {
  url: string;
  port: number;
  stop(): void;
}

function resolveKernel(runtime: ObservatoryRuntime): MemoryKernel {
  if (runtime.kernel) return runtime.kernel;
  if (runtime.dbPath) return createMemoryKernel({ dbPath: runtime.dbPath });
  return createMemoryKernelFromConfig({ configPath: runtime.configPath, cwd: runtime.cwd });
}

export async function startObservatoryServer(options: ObservatoryServerOptions): Promise<ObservatoryServerHandle> {
  const hostname = options.hostname ?? '127.0.0.1';
  const kernel = resolveKernel(options);
  const ownsKernel = !options.kernel;
  const dataDir = kernel.databasePath && kernel.databasePath !== ':memory:' && !kernel.databasePath.startsWith('file:')
    ? dirname(kernel.databasePath)
    : undefined;

  const observatoryDb = openObservatoryDatabase(kernel);
  if (observatoryDb === null) {
    if (ownsKernel) kernel.close();
    throw new Error('observatory_requires_a_file_database');
  }

  const handleObservatory = createObservatoryRoutes(new MemoryObservatory({
    db: observatoryDb.db,
    nodeDetail: (nodeId, projectId) => kernel.memoryAtlasService.node(nodeId, {
      projectId, includeEvidence: true, evidenceLimit: 8, refresh: false, staleOk: true,
    }),
    books: (projectId) => ({
      commitments: kernel.commitments.list({ projectId, limit: 100 }),
      intentions: kernel.intentions.list({ projectId, limit: 100 }),
    }),
    connectedAgents: options.connectedAgents ?? (() => []),
    tracePath: options.tracePath ?? (kernel.databasePath && kernel.databasePath !== ':memory:' && !kernel.databasePath.startsWith('file:')
      ? join(dataDir!, 'shell-events.jsonl')
      : undefined),
  }), kernel.events, kernel.soul, {
    token: kernel.databasePath && kernel.databasePath !== ':memory:' && !kernel.databasePath.startsWith('file:')
      ? readObservatoryToken(dataDir!)
      : undefined,
    credentials: options.credentials,
    candidates: createObservatoryCandidateFace(kernel, { readOnly: residentRunning(dataDir) }),
    channels: options.channels,
  });

  const httpServer = Bun.serve({
    port: options.port,
    hostname,
    async fetch(request: Request, server): Promise<Response> {
      const response = await handleObservatory(request, server.requestIP(request)?.address ?? undefined);
      return response ?? new Response('not_found', { status: 404 });
    },
  });

  const actualPort = httpServer.port ?? options.port;
  return {
    url: `http://127.0.0.1:${actualPort}${OBSERVATORY_PREFIX}/`,
    port: actualPort,
    stop() {
      httpServer.stop(true);
      observatoryDb.close();
      if (ownsKernel) kernel.close();
    },
  };
}

function openObservatoryDatabase(kernel: MemoryKernel): { db: Database; close: () => void } | null {
  const path = kernel.databasePath;
  if (!path || path === ':memory:' || path.startsWith('file:')) return null;
  const db = new Database(path, { readonly: true });
  ensureUsableTempSpace(db);
  return { db, close: () => db.close() };
}

function residentRunning(dataDir: string | undefined): boolean {
  if (!dataDir) return false;
  try {
    const holder = JSON.parse(readFileSync(join(dataDir, 'runtime.lock'), 'utf8')) as { pid?: unknown };
    const pid = holder.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
