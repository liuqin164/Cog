import type { BeliefRecord, Neuron } from './index.js';
import type { EntityTimelineItem } from '../store/EntityStore.js';
import type { EventRecord, FactRecord } from '../store/FactStore.js';
import type { FileEvidence } from '../assets/index.js';
import type { SkillCandidateLike } from './ExtensionPoints.js';
import type { MemoryAtlasSlice } from '../atlas/MemoryAtlasTypes.js';
import type { MemoryQueryFrameV1 } from '../semantic/MemoryFrameTypes.js';
import type { SourceAdapterKind } from '../adapters/types.js';

export interface BrainRecallResult {
  query: string;
  atlas?: MemoryAtlasSlice;
  queryFrame?: MemoryQueryFrameV1;
  strategy: {
    primaryLevel: 'compiled_memory' | 'raw_evidence' | 'recent_unprocessed_sources';
    fallbackUsed: boolean;
    vectorSearchUsed?: boolean;
  };
  compiledMemory: {
    beliefs: BeliefRecord[];
    facts: FactRecord[];
    events: EventRecord[];
    entityTimeline: EntityTimelineItem[];
  };
  rawEvidence: Neuron[];
  fallbackSnippets: Array<{
    sourceId: string;
    sourcePath: string;
    text: string;
    timestamp: number;
    sourceType: SourceAdapterKind;
  }>;
  profileSignals: Array<{
    neuronId: string;
    sourcePath?: string;
    text: string;
    tags: string[];
    namespace: 'user_profile' | 'agent_persona';
  }>;
  profileSurface: {
    userProfile: Array<{
      neuronId: string;
      sourcePath?: string;
      label: string;
      value: string;
      section?: string;
    }>;
    agentPersona: Array<{
      neuronId: string;
      sourcePath?: string;
      label: string;
      value: string;
      section?: string;
    }>;
  };
  summaries?: Array<{
    summaryId: string;
    text: string;
    scope: string;
    windowStart?: number;
    windowEnd?: number;
    confidence: number;
  }>;
  fileEvidence?: FileEvidence[];
  skillCandidates?: SkillCandidateLike[];
  topicRouteInfo?: {
    matchedTopicPath: string | null;
    confidence: number;
    fallbackToGlobal: boolean;
  };
}
