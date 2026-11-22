/**
 * The night integration, run in the DREAMING state.
 *
 * The product is written as the companion's own agent identity and carries the full `sourceRefs` of
 * the day's events, so it can be attributed (and later deleted) like any other memory rather than
 * laundering itself into the user's recall as anonymous evidence.
 *
 * Deterministic by design: the summary is a function of the day's redacted ledger, not a model call.
 * Its provenance says so — `rule_extraction`, never `llm_inference`.
 */
import type { KernelAgentMemoryBackend, MemoryEvent, MemoryKernel, MemorySourceRef } from 'cogmem';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin } from './host.ts';

export interface DreamServiceOptions {
  kernel: MemoryKernel;
  backend: KernelAgentMemoryBackend;
  agentId: string;
  projectId: string;
  sessionId: string;
  runKernelNight: boolean;
  maxEpisodes: number;
  trace?: TraceLog;
  /** The host's model budget seam, around the kernel Night that may call the memory model. */
  beforeKernelNight?: (now: number) => void;
  afterKernelNight?: (now: number) => void;
}

export interface DreamPluginConfig extends Omit<DreamServiceOptions, 'kernel' | 'backend' | 'trace'> {}

export interface DreamResult {
  localDate: string;
  eventCount: number;
  sourceRefs: MemorySourceRef[];
  summary: string;
  dreamEventId?: string;
  kernelNightRan: boolean;
  kernelNightSkippedReason?: string;
  processedEpisodeCount: number;
  memoryModelUsed: boolean;
  memoryModelDegraded?: string;
}

export class DreamService {
  constructor(private readonly options: DreamServiceOptions) {}

  async integrate(localDate: string, dayThreadId: string, now = Date.now()): Promise<DreamResult> {
    const { kernel, backend, agentId, projectId, sessionId } = this.options;
    const events = kernel
      .getThreadEvents(dayThreadId, { projectId, limit: 5_000 })
      .filter((event) => !isDreamProduct(event));
    const refs = dedupeRefs(events);
    let kernelNightRan = false;
    let kernelNightSkippedReason: string | undefined;
    let processedEpisodeCount = 0;
    let memoryModelUsed = false;
    let memoryModelDegraded: string | undefined;
    if (this.options.runKernelNight) {
      this.options.beforeKernelNight?.(now);
      try {
        const night = await kernel.runNight({ projectId, maxEpisodes: this.options.maxEpisodes, now });
        kernelNightRan = true;
        kernelNightSkippedReason = night.dream.skipped ? night.dream.reason : undefined;
        processedEpisodeCount = night.dream.processedEpisodeCount;
        if (night.dream.semanticProcessorReason) {
          memoryModelDegraded = night.dream.semanticProcessorReason;
          this.options.trace?.append('dream_model_degraded', {
            localDate,
            reason: night.dream.semanticProcessorReason,
            error: night.dream.semanticProcessorError,
          });
          if (night.dream.semanticProcessorReason === 'semantic_processor_failed') {
            this.options.trace?.append('memory_model_unavailable', {
              localDate,
              reason: night.dream.semanticProcessorReason,
              error: night.dream.semanticProcessorError,
            });
          }
        } else if (night.dream.semanticProcessorAvailable) {
          memoryModelUsed = true;
          this.options.trace?.append('dream_model_used', { localDate });
        }
      } catch (error) {
        kernelNightSkippedReason = error instanceof Error ? error.message : String(error);
        this.options.trace?.append('dream_kernel_night_failed', { localDate, message: kernelNightSkippedReason });
      } finally {
        this.options.afterKernelNight?.(now);
      }
    } else {
      kernelNightSkippedReason = 'disabled_by_config';
    }
    const summary = summarize(localDate, events, kernelNightSkippedReason);
    const existing = kernel
      .getThreadEvents(`companion-dream:${localDate}`, { projectId, limit: 50 })
      .find((event) => isDreamProduct(event));
    const dreamEvent = existing ?? await backend.ingestTaskEvent({
      agentId,
      projectId,
      workspaceId: projectId,
      sessionId,
      threadId: `companion-dream:${localDate}`,
      taskId: `dream-${localDate}`,
      title: `夜间整合 ${localDate}`,
      content: summary,
      metadata: {
        sourceAgent: agentId,
        kind: 'dream-integration',
        sourceEventIds: refs.map((ref) => ref.eventId),
        sourceRefs: refs,
        kernelNightRan,
      },
      timestamp: now,
    });
    this.options.trace?.append('dream_integrated', {
      localDate,
      eventCount: events.length,
      sourceRefCount: refs.length,
      dreamEventId: dreamEvent.eventId,
      kernelNightRan,
      reused: existing !== undefined,
    });
    return {
      localDate,
      eventCount: events.length,
      sourceRefs: refs,
      summary,
      dreamEventId: dreamEvent.eventId,
      kernelNightRan,
      kernelNightSkippedReason,
      processedEpisodeCount,
      memoryModelUsed,
      memoryModelDegraded,
    };
  }
}

function isDreamProduct(event: MemoryEvent): boolean {
  const metadata = (event.payload as { metadata?: { kind?: unknown } } | undefined)?.metadata;
  return metadata?.kind === 'dream-integration';
}

function dedupeRefs(events: MemoryEvent[]): MemorySourceRef[] {
  const seen = new Set<string>();
  const refs: MemorySourceRef[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    refs.push({
      eventId: event.eventId,
      eventType: event.eventType,
      sourceId: event.sourceId,
      contentHash: event.contentHash,
      threadId: event.threadId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      role: event.role,
      threadSeq: event.threadSeq,
      turnSeq: event.turnSeq,
      eventOrdinal: event.eventOrdinal,
    });
  }
  return refs;
}

function summarize(localDate: string, events: MemoryEvent[], nightNote?: string): string {
  const counts = { user: 0, assistant: 0, tool: 0, other: 0 };
  for (const event of events) {
    if (event.role === 'user') {
      counts.user += 1;
    } else if (event.role === 'assistant') counts.assistant += 1;
    else if (event.role === 'tool') counts.tool += 1;
    else counts.other += 1;
  }
  const lines = [
    `夜间整合 ${localDate}：当日共 ${events.length} 条事件（用户 ${counts.user}、助手 ${counts.assistant}、工具 ${counts.tool}、其它 ${counts.other}）。`,
  ];
  if (events.length > 0) lines.push(`事件：${events.slice(0, 20).map((event) => event.eventId).join(', ')}${events.length > 20 ? ` 等 ${events.length} 条` : ''}`);
  if (nightNote) lines.push(`内核 dream 备注：${nightNote}`);
  return lines.join('\n');
}

/** The night integration as a plugin: DREAMING is a state, the integration is an installed ability. */
export function dreamPlugin(config: DreamPluginConfig): NativePlugin {
  return {
    name: 'dream',
    inject: ['kernel', 'memory', 'trace'],
    provide: ['dream'],
    apply(ctx) {
      const service = new DreamService({
        ...config,
        kernel: ctx.getService<MemoryKernel>('kernel'),
        backend: ctx.getService<KernelAgentMemoryBackend>('memory'),
        trace: ctx.getService<TraceLog>('trace'),
      });
      ctx.provide('dream', service);
    },
  };
}
