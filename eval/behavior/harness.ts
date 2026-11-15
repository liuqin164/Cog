import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { KernelApi, ScenarioContext } from './types.js';
import { makeTempDir } from '../../__tests__/helpers/tmp.js';

/** The source public surface. A box run passes `--module` to the installed `dist/public.js`. */
export const DEFAULT_MODULE = new URL('../../src/public.ts', import.meta.url).href;

function moduleSpecifier(value: string): string {
  if (value.startsWith('file:') || value.startsWith('data:') || value.startsWith('node:')) return value;
  if (value.startsWith('.') || value.startsWith('/')) return pathToFileURL(resolve(value)).href;
  return value;
}

export async function loadKernelApi(modulePath = DEFAULT_MODULE): Promise<KernelApi> {
  const api = await import(moduleSpecifier(modulePath));
  if (typeof api.createMemoryKernel !== 'function') {
    throw new Error(`behavior-eval module has no createMemoryKernel: ${modulePath}`);
  }
  return api as KernelApi;
}

export async function withKernel<T>(
  slug: string,
  api: KernelApi,
  run: (context: ScenarioContext) => Promise<T>,
): Promise<T> {
  const directory = makeTempDir(`cogmem-behavior-${slug}-`);
  const dbPath = `${directory}/memory.db`;
  const make = () => api.createMemoryKernel({ dbPath, projectTimeZone: 'UTC' });
  let current: any;
  const context: ScenarioContext = {
    get kernel() {
      return current;
    },
    api,
    reopen() {
      current.close();
      current = make();
      return current;
    },
  };
  try {
    current = make();
    return await run(context);
  } finally {
    try {
      current?.close();
    } catch {
      // A scenario may already have closed it on a failed restart; the temp tree still goes.
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The shared scenario clock. Every instant a scenario names is derived from this constant. */
export const EVAL_T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

/** Pin one offline extraction output onto a real captured turn. */
export function rememberBelief(
  kernel: any,
  input: {
    projectId: string;
    eventId: string;
    predicate: string;
    value: string;
    validFrom: number;
    extractionReason?: string;
  },
): void {
  kernel.beliefStore.upsert({
    projectId: input.projectId,
    scope: 'project',
    subject: 'owner',
    predicate: input.predicate,
    objectValue: { raw: input.value, type: 'string' },
    confidence: 0.9,
    sourceType: 'user_input',
    extractionReason: input.extractionReason ?? 'explicit_user_statement',
    sourceEventId: input.eventId,
    validFrom: input.validFrom,
  });
}

/** The public agent-facing backend bound to one occasion. */
export function backendFor(
  api: KernelApi,
  kernel: any,
  channelId: string,
  occasion: 'private' | 'group' | 'public' = 'private',
): any {
  const binding = kernel.occasionScope.register({ channelId, occasion });
  return new api.KernelAgentMemoryBackend(kernel, { binding });
}

export class ScenarioFailure extends Error {}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

export function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new ScenarioFailure(`${message}: expected ${show(expected)}, got ${show(actual)}`);
}

export function contains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new ScenarioFailure(`${message}: missing ${show(needle)} in ${show(haystack)}`);
}

export function excludes(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) throw new ScenarioFailure(`${message}: found ${show(needle)} in ${show(haystack)}`);
}

export function hasLength(value: unknown[], expected: number, message: string): void {
  if (value.length !== expected) throw new ScenarioFailure(`${message}: expected ${expected}, got ${value.length}`);
}

/** A deterministic turn writer: every instant is supplied by the scenario. */
export function turn(
  kernel: any,
  input: {
    projectId: string;
    threadId: string;
    role?: 'user' | 'assistant' | 'other';
    content: string;
    occurredAt: number;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  },
): any {
  return kernel.recordRawEvent({
    projectId: input.projectId,
    threadId: input.threadId,
    sessionId: input.sessionId ?? `${input.threadId}-session`,
    role: input.role ?? 'user',
    content: input.content,
    occurredAt: input.occurredAt,
    metadata: input.metadata,
  });
}
