import type Database from 'bun:sqlite';

import { TraceStore } from '../observability/TraceStore.js';
import { TraceWriter } from '../observability/TraceWriter.js';
import { buildSessionDigest, SESSION_DIGEST_TAIL_TURNS, type SessionDigest } from './SessionDigest.js';
import {
  compileSessionDeepCards,
  mergeDeepCardEntries,
  readDeepCardEntries,
  type SessionDeepCompileRunInput,
  type SessionDeepCompileRunResult,
} from './SessionDeepCards.js';
import { requireSessionText } from './SessionErrors.js';
import { readSessionTurns, SESSION_DIGEST_MAX_TURNS, type SessionTurn, type SessionTurnRead } from './SessionLedger.js';
import { recallSession, type SessionRecallInput, type SessionRecallPage } from './SessionRecall.js';
import type { TextGenerateFn } from '../models/ModelRole.js';
import {
  assembleSessionContext,
  type AssembleSessionContextInput,
  type SessionContextAssembly,
  type SessionContextItem,
} from './SessionContextAssembler.js';

export const SESSION_CONTEXT_CONTRACT_VERSION = 1;

export const SESSION_CONTEXT_API_METHODS = ['digest', 'recall', 'assemble'] as const;

export interface SessionDigestInput {
  projectId: string;
  agentId: string;
  sessionId: string;
  previousSessionId?: string;
  /** How many recent turns stay verbatim. */
  tailTurns?: number;
}

export interface SessionContextServiceOptions {
  openLoops?: (input: { projectId: string; agentId: string; sessionId: string; now: number }) => SessionContextItem[];
  deepGenerate?: () => TextGenerateFn | undefined;
}

export class SessionContextService {
  private traceStore: TraceStore | null = null;
  private traceWriter: TraceWriter | null = null;

  constructor(private readonly db: Database, private readonly options: SessionContextServiceOptions = {}) {}

  digest(input: SessionDigestInput): SessionDigest {
    const { projectId, agentId, sessionId } = requireScope(input);
    const read = readDigestTurns(this.db, { ...input, projectId, agentId, sessionId, limit: SESSION_DIGEST_MAX_TURNS });
    const digest = buildSessionDigest(read.turns, { sessionId, tailTurns: input.tailTurns, truncated: read.truncated });
    return {
      ...digest,
      entries: mergeDeepCardEntries(digest.entries, readDeepCardEntries(this.db, { projectId, agentId, sessionId })),
    };
  }

  async compileEpisodeCards(input: SessionDeepCompileRunInput = {}): Promise<SessionDeepCompileRunResult> {
    return compileSessionDeepCards(this.db, {
      ...input,
      generateText: input.generateText ?? this.options.deepGenerate?.(),
    });
  }

  recall(input: SessionRecallInput): SessionRecallPage {
    return recallSession(this.db, input);
  }

  assemble(input: AssembleSessionContextInput): SessionContextAssembly {
    const { projectId, agentId, sessionId } = requireScope(input);
    const digest = input.cachedDigest ?? (() => {
      const read = readDigestTurns(this.db, { ...input, projectId, agentId, sessionId, limit: SESSION_DIGEST_MAX_TURNS });
      const turns = read.turns;
      const built = buildSessionDigest(turns, { sessionId, tailTurns: input.tailTurns, truncated: read.truncated });
      return {
        ...built,
        entries: mergeDeepCardEntries(built.entries, readDeepCardEntries(this.db, { projectId, agentId, sessionId })),
      };
    })();
    const openLoops = [...(input.openLoops ?? []), ...this.openLoops({ projectId, agentId, sessionId })];
    const protectedIds = [
      ...this.protectedEventIds(projectId, sessionId),
      ...(input.protectedIds ?? []),
    ];
    const assembly = assembleSessionContext({ ...input, projectId, agentId, sessionId, openLoops, protectedIds }, digest);
    if (assembly.decisionTrace.length > 0) this.recordTrace(assembly);
    return assembly;
  }

  private protectedEventIds(projectId: string, sessionId: string): string[] {
    const ids = new Set<string>();
    try {
      const rows = this.db.query(`
        SELECT event_type, payload_json FROM memory_events
        WHERE COALESCE(project_id, '') = ?
          AND event_type IN ('COMMITMENT_OPENED', 'INTENTION_OPENED', 'PROFILE_ENTRY_CORRECTED')
      `).all(projectId) as Array<{ event_type: string; payload_json: string }>;
      for (const row of rows) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (row.event_type === 'PROFILE_ENTRY_CORRECTED') {
          if (typeof payload.correctionEventId === 'string') ids.add(payload.correctionEventId);
          continue;
        }
        for (const eventId of sourceRefEventIds(payload.sourceRefs)) ids.add(eventId);
      }
      const corrections = this.db.query(`
        SELECT l.event_id FROM memory_episode_events l
        JOIN memory_events e ON e.event_id = l.event_id
        WHERE COALESCE(e.project_id, '') = ? AND COALESCE(e.session_id, '') = ?
          AND l.relation IN ('corrects_previous', 'rejects_assistant_proposal')
      `).all(projectId, sessionId) as Array<{ event_id: string }>;
      for (const row of corrections) ids.add(row.event_id);
    } catch {
      return [...ids];
    }
    return [...ids];
  }

  private openLoops(input: { projectId: string; agentId: string; sessionId: string }): SessionContextItem[] {
    if (!this.options.openLoops) return [];
    try {
      return this.options.openLoops({ ...input, now: Date.now() });
    } catch {
      return [];
    }
  }

  private recordTrace(assembly: SessionContextAssembly): void {
    try {
      if (!this.traceStore) {
        this.traceStore = new TraceStore(this.db);
        this.traceStore.initSchema();
        this.traceWriter = new TraceWriter(this.traceStore);
      }
      this.traceWriter!.emit({
        projectId: assembly.projectId,
        eventType: 'session.context.assemble',
        payload: {
          sessionId: assembly.sessionId,
          agentId: assembly.agentId,
          targetTokens: assembly.targetTokens,
          usedTokens: assembly.usedTokens,
          downgrades: assembly.decisionTrace,
          autoExpanded: assembly.autoExpanded,
        },
      });
    } catch {}
  }
}

function readDigestTurns(
  db: Database,
  input: { projectId: string; agentId: string; sessionId: string; previousSessionId?: string; tailTurns?: number; limit: number; excludeTurnIds?: readonly string[] },
): SessionTurnRead {
  const read = readSessionTurns(db, {
    projectId: input.projectId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    limit: input.limit,
  });
  const excluded = new Set(input.excludeTurnIds ?? []);
  const turns = excluded.size === 0 ? read.turns : read.turns.filter((turn) => !excluded.has(turn.turnId));
  const tailTurns = input.tailTurns ?? SESSION_DIGEST_TAIL_TURNS;
  const previousSessionId = input.previousSessionId;
  if (previousSessionId === undefined || previousSessionId === input.sessionId || turns.length >= tailTurns) {
    return { turns, truncated: read.truncated };
  }
  const previous = readSessionTurns(db, {
    projectId: input.projectId,
    agentId: input.agentId,
    sessionId: previousSessionId,
    limit: tailTurns - turns.length,
  });
  if (previous.turns.length === 0) return { turns, truncated: read.truncated };
  return { turns: [...previous.turns, ...turns], truncated: read.truncated };
}

function requireScope(input: { projectId: string; agentId: string; sessionId: string }): {
  projectId: string;
  agentId: string;
  sessionId: string;
} {
  return {
    projectId: requireSessionText(input.projectId, 'project_id_required'),
    agentId: requireSessionText(input.agentId, 'agent_id_required'),
    sessionId: requireSessionText(input.sessionId, 'session_id_required'),
  };
}

function sourceRefEventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((ref) => (ref && typeof ref === 'object' && typeof (ref as { eventId?: unknown }).eventId === 'string'
      ? (ref as { eventId: string }).eventId
      : ''))
    .filter(Boolean);
}

export type { SessionTurn };
