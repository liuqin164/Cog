/**
 * The shell's view of one lane assembly: what `/context` and the TUI show.
 *
 * The kernel owns the lanes and the decision trace; this module only projects them into plain
 * numbers and strings so both faces report the same composition instead of inventing a second
 * accounting. `browseIds` is the pointer a downgraded lane leaves behind.
 */
import type {
  SessionContextAssembly,
  SessionContextDecision,
  SessionContextLaneName,
  SessionContextLaneStatus,
} from 'cogmem';

export interface LaneView {
  lane: SessionContextLaneName;
  status: SessionContextLaneStatus;
  tokens: number;
  items: number;
  browseIds: string[];
}

export interface LaneDecisionView {
  lane: SessionContextLaneName;
  action: SessionContextDecision['action'];
  tokensBefore: number;
  tokensAfter: number;
  omittedItems: number;
  browseIds: string[];
}

export interface LaneAssemblyView {
  targetTokens: number;
  usedTokens: number;
  lanes: LaneView[];
  decisionTrace: LaneDecisionView[];
  /** The stub ids this assembly expanded into `working_set` (#253); `[]` when none matched. */
  autoExpanded: string[];
}

export const LANE_LABELS: Record<SessionContextLaneName, string> = {
  pinned: '钉死',
  profile: '画像',
  digest: '摘要',
  working_set: '工作集',
  recall: '召回',
  tail: '尾巴',
};

const STATUS_WORDS: Record<SessionContextLaneStatus, string> = {
  included: '在场',
  downgraded: '已降级为指针',
  empty: '空',
};

export function laneAssemblyView(assembly: SessionContextAssembly): LaneAssemblyView {
  return {
    targetTokens: assembly.targetTokens,
    usedTokens: assembly.usedTokens,
    lanes: assembly.lanes.map((lane) => ({
      lane: lane.lane,
      status: lane.status,
      tokens: lane.tokens,
      items: lane.items.length,
      browseIds: [...lane.browseIds],
    })),
    decisionTrace: assembly.decisionTrace.map((decision) => ({
      lane: decision.lane,
      action: decision.action,
      tokensBefore: decision.tokensBefore,
      tokensAfter: decision.tokensAfter,
      omittedItems: decision.omittedItems,
      browseIds: [...decision.browseIds],
    })),
    autoExpanded: [...assembly.autoExpanded],
  };
}

export function laneReportLines(view: LaneAssemblyView, requestTokens?: number): string[] {
  const lines = [`目标带宽 ${view.targetTokens} token，车道估算 ${view.usedTokens} token`];
  if (requestTokens !== undefined && requestTokens > 0) {
    lines.push(`请求估算约 ${Math.round(requestTokens)} token（含工具声明，chars/4 口径；provider 实报时校准）`);
  }
  for (const lane of view.lanes) {
    const browse = lane.browseIds.length > 0 ? ` · 可浏览 ${lane.browseIds.length} 条` : '';
    lines.push(`${LANE_LABELS[lane.lane]}：${lane.items} 条，约 ${lane.tokens} token，${STATUS_WORDS[lane.status]}${browse}`);
  }
  if (view.decisionTrace.length === 0) {
    lines.push('无降级。');
  } else {
    for (const decision of view.decisionTrace) {
      const ids = decision.browseIds.length > 0 ? ` [${decision.browseIds.slice(0, 5).join(', ')}]` : '';
      if (decision.action === 'downgraded') {
        lines.push(`降级 ${LANE_LABELS[decision.lane]}：${decision.tokensBefore} → ${decision.tokensAfter} token，${decision.omittedItems} 条 → 指针${ids}`);
      } else {
        lines.push(`裁剪 ${LANE_LABELS[decision.lane]}：${decision.tokensBefore} → ${decision.tokensAfter} token，${decision.omittedItems} 条`);
      }
    }
  }
  return lines;
}
