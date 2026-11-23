import { socialTurnResources } from '../config/LanguagePacks.js';
import { ZH_REFERENCE_SIGNALS } from '../lexicon/language-packs/zh.js';
import { extractRecallKeywords } from './AgentRecallQueryCompiler.js';

export type BackReferenceKind = 'current_session' | 'previous_session' | 'state_follow_up';

export interface BackReferenceDetection {
  kind: BackReferenceKind;
  followUp: boolean;
  source: 'deterministic_backref';
}

export interface BackReferenceRewrite extends BackReferenceDetection {
  anchorText: string;
  anchorTime?: number;
  terms: string[];
}

const STATE_FOLLOW_UP = /(后来|然后|结果|现在|最近|它|他|她).{0,8}(怎么样|怎样|如何|进展|状态|结果)/u;
const PREVIOUS_SESSION = /(上次|上回|昨天|前天|前一天|那天|那次|以前|之前|上一|上个)/u;

const REFERENCE_TERMS = [...new Set([
  ...Object.values(ZH_REFERENCE_SIGNALS).flat(),
  '那件', '这件', '那事', '这事', '那边', '那块', '那回',
])];

const STRIP_TERMS = [
  '上次', '上回', '刚才', '刚刚', '上面', '之前', '原先', '原来', '前一版', '刚说', '刚提',
  '昨天', '前天', '前一天', '那天', '那次', '当时', '那时', '以前', '上一', '上个',
  '那件', '这件', '那事', '这事', '事情', '那边', '那块', '那回',
  '后来', '然后', '现在', '最近', '结果', '怎么样了', '怎么样', '怎样', '如何', '进展', '状态',
  '什么', '聊过', '聊', '说过', '说', '讨论过', '讨论', '提过', '提', '讲过', '讲', '问过', '问',
  '记得', '还记得', '关于', '我们', '你们', '你', '我', '它', '的', '了', '吗', '呢', '呀', '吧', '啊', '哦', '嗯', '是', '都', '还', '又',
].sort((left, right) => right.length - left.length);

export function detectBackReference(query: string): BackReferenceDetection | undefined {
  const text = query.trim();
  if (text === '') return undefined;
  const hasReference = socialTurnResources().backReference.test(text)
    || REFERENCE_TERMS.some((term) => text.includes(term))
    || STATE_FOLLOW_UP.test(text);
  if (!hasReference) return undefined;
  if (extractRecallKeywords(stripBackReference(text)).length > 0) return undefined;
  const followUp = STATE_FOLLOW_UP.test(text);
  const kind: BackReferenceKind = PREVIOUS_SESSION.test(text)
    ? 'previous_session'
    : followUp ? 'state_follow_up' : 'current_session';
  return { kind, followUp, source: 'deterministic_backref' };
}

function stripBackReference(text: string): string {
  let output = text;
  for (const term of STRIP_TERMS) output = output.split(term).join(' ');
  return output.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}
