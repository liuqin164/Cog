import type { MemoryGraph } from '../core/MemoryGraph.js';
import type { Neuron } from '../types/index.js';

export interface VectorFilterContext {
  projectId?: string;
  topicPath?: string;
  queryTime: number;
  maxStaleMs?: number;
  entityHints?: string[];
}

export interface VectorFilterRule {
  name: string;
  filter(neuronIds: string[], context: VectorFilterContext): string[];
}

export class VectorCandidateFilter {
  constructor(private readonly rules: VectorFilterRule[] = []) {}

  filter(neuronIds: string[], ctx: VectorFilterContext): string[] {
    return this.rules.reduce((ids, rule) => rule.filter(ids, ctx), neuronIds);
  }
}

abstract class MemoryGraphVectorFilterRule implements VectorFilterRule {
  abstract readonly name: string;
  abstract filter(neuronIds: string[], context: VectorFilterContext): string[];
  constructor(protected readonly memoryGraph: MemoryGraph) {}

  protected neuron(id: string): Neuron | null {
    return this.memoryGraph.getNeuron(id);
  }
}

export class TopicFilter extends MemoryGraphVectorFilterRule {
  readonly name = 'topic';

  filter(neuronIds: string[], context: VectorFilterContext): string[] {
    if (!context.topicPath) return neuronIds;
    const prefix = context.topicPath;
    return neuronIds.filter((id) => {
      const topicPath = this.neuron(id)?.metadata.topicPath;
      if (!topicPath) return false;
      return topicPath === prefix || topicPath.startsWith(`${prefix}/`);
    });
  }
}
