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

/**
 * The three projection actions the context trace counts (#268). They are per assembly: a fold is a
 * downgrade/trim decision in this assembly, a drill is a `mem:` read since the previous one, and an
 * auto-expand is a deterministic expansion into the working set (#253). A zero is a measurement,
 * not a missing field.
 */
export interface ContextMetrics {
  folds: number;
  drills: number;
  autoExpands: number;
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
    lines.push(`请求估算约 ${Math.round(requestTokens)} token（含工具声明，字符类别口径；provider 实报时校准）`);
  }
  for (const lane of view.lanes) {
    const browse = lane.browseIds.length > 0 ? ` · 可浏览 ${lane.browseIds.length} 条` : '';
    const empty = lane.lane === 'profile' && lane.status === 'empty'
      ? ' · 尚无画像条目：账本里还没有可编译的证据'
      : '';
    lines.push(`${LANE_LABELS[lane.lane]}：${lane.items} 条，约 ${lane.tokens} token，${STATUS_WORDS[lane.status]}${browse}${empty}`);
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

/** The `/context` metrics line; both faces read it so the numbers are never restated. */
export function contextMetricsLine(metrics: ContextMetrics): string {
  return `本轮折叠 ${metrics.folds} 次 · 下钻 ${metrics.drills} 次 · 自动展开 ${metrics.autoExpands} 次`;
}
