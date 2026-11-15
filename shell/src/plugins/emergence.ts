/**
 * The emergence decision point: a consumer of F6's surfacing query, not a second policy.
 *
 * The kernel answers with candidates, their sensitivity grade, occasion binding and the F7
 * modulation step; the shell only decides whether to speak. There is no word list here — a
 * sensitive turn is graded by F10's mark and withheld by F6's channel policy, so a benign
 * "孩子" or "药店" is not caught by a substring and a life-marked turn cannot slip through.
 *
 * Only due sources are first-class: an arrived commitment, a due intention (through its F2 wake
 * intention) and a wake intention. The associative ledger echo this service used in 5.0 is gone:
 * it surfaced whatever the owner had just said, had no due instant, and was the path #229 burned.
 */
import type { KernelAgentMemoryBackend, SensitivityTier, SurfacingDecisionTrace, SurfacingSource } from 'cogmem';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin } from './host.ts';

export interface EmergenceConfig {
  limit: number;
}

/** Sources with a due instant. Everything else is a helper lane, not a reason to speak first. */
export const FIRST_CLASS_PROACTIVE_SOURCES: readonly SurfacingSource[] = [
  'commitment',
  'prospective-memory',
  'wake-intention',
];

export interface EmergenceCandidate {
  id: string;
  text: string;
  reason: string;
  source: SurfacingSource;
  sensitivity: SensitivityTier;
  /** The source's own due/observed instant: a snoozed commitment resumes as a new occurrence. */
  observedAt: number;
  sourceRefs: Array<{ eventId?: string; sourceId?: string; contentHash?: string }>;
  decisionTrace: SurfacingDecisionTrace;
}

export interface EmergenceWithheld {
  id: string;
  source: SurfacingSource;
  sensitivity: SensitivityTier;
  reason: string;
  decisionTrace: SurfacingDecisionTrace;
}

export interface EmergenceDecision {
  mode: 'surfacing';
  channel: 'proactive';
  occasion: string;
  candidates: EmergenceCandidate[];
  suppressed: Array<{ id: string; reason: string }>;
  withheld: EmergenceWithheld[];
  /** First-class sources that were not due, or a non-first-class lane the shell deliberately ignores. */
  excluded: Array<{ id: string; source: SurfacingSource; reason: string }>;
  decidedAt: number;
}

export class EmergenceService {
  constructor(
    private readonly backend: KernelAgentMemoryBackend,
    private readonly options: { agentId: string; projectId: string; trace?: TraceLog; config?: Partial<EmergenceConfig> },
  ) {}

  private get limit(): number {
    return this.options.config?.limit ?? 10;
  }

  /**
   * A cheap "is anything due" probe before the full candidate query. The query scans the recent
   * ledger and classifies every candidate; an idle tick with nothing due should not pay for it.
   */
  hasDue(now = Date.now()): boolean {
    try {
      if (this.backend.nextWakeAt({ projectId: this.options.projectId, agentId: this.options.agentId, now }) === now) return true;
      return this.backend.listCommitments({
        projectId: this.options.projectId,
        now,
        statuses: ['due_soon', 'overdue'],
      }).length > 0;
    } catch {
      // A failed probe must not drop a due promise; let the full query decide.
      return true;
    }
  }

  /**
   * One deterministic query. `now` is the caller's clock; there is no user text to match, because
   * a due promise or intention is a reason to speak whether or not the owner just said anything.
   */
  decide(now = Date.now()): EmergenceDecision {
    const result = this.backend.surfacingCandidates({
      projectId: this.options.projectId,
      channel: 'proactive',
      now,
      limit: this.limit,
    });

    const candidates: EmergenceCandidate[] = [];
    const withheld: EmergenceWithheld[] = [];
    const excluded: EmergenceDecision['excluded'] = [];
    for (const item of result.candidates) {
      if (!FIRST_CLASS_PROACTIVE_SOURCES.includes(item.source)) {
        excluded.push({ id: item.candidateId, source: item.source, reason: 'no_due_instant' });
        continue;
      }
      candidates.push({
        id: item.candidateId,
        text: item.content,
        reason: item.reason,
        source: item.source,
        sensitivity: item.sensitivity,
        observedAt: item.freshness.observedAt,
        sourceRefs: item.sourceRefs,
        decisionTrace: item.decisionTrace,
      });
    }
    for (const item of result.withheld) {
      if (!FIRST_CLASS_PROACTIVE_SOURCES.includes(item.source)) {
        excluded.push({ id: item.candidateId, source: item.source, reason: 'no_due_instant' });
        continue;
      }
      withheld.push({
        id: item.candidateId,
        source: item.source,
        sensitivity: item.sensitivity,
        reason: item.reason,
        decisionTrace: item.decisionTrace,
      });
    }

    const decision: EmergenceDecision = {
      mode: 'surfacing',
      channel: 'proactive',
      occasion: result.occasion,
      candidates,
      suppressed: withheld.map((item) => ({ id: item.id, reason: item.reason })),
      withheld,
      excluded,
      decidedAt: now,
    };
    this.options.trace?.append('emergence_decision', {
      now,
      channel: decision.channel,
      occasion: decision.occasion,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        source: candidate.source,
        text: candidate.text,
        sensitivity: candidate.sensitivity,
        steps: candidate.decisionTrace.steps,
      })),
      withheld: withheld.map((item) => ({
        id: item.id,
        source: item.source,
        sensitivity: item.sensitivity,
        reason: item.reason,
        steps: item.decisionTrace.steps,
      })),
      excluded,
    }, now);
    return decision;
  }
}

/** The decision point as a plugin: it can be swapped for a stricter policy without touching the shell. */
export function emergencePlugin(options: { agentId: string; projectId: string; config?: Partial<EmergenceConfig> }): NativePlugin {
  return {
    name: 'emergence',
    inject: ['memory', 'trace'],
    provide: ['emergence'],
    apply(ctx) {
      const service = new EmergenceService(ctx.getService<KernelAgentMemoryBackend>('memory'), {
        agentId: options.agentId,
        projectId: options.projectId,
        trace: ctx.getService<TraceLog>('trace'),
        config: options.config,
      });
      ctx.provide('emergence', service);
    },
  };
}
