import { recognizeCommitments } from '../commitment/index.js';
import { recognizeIntentions } from '../intention/index.js';
import type { MemoryEventRole } from '../types/index.js';
import type {
  AgentTurnMemoryResult,
  AgentTurnReceipt,
  AgentTurnReceiptAction,
} from '../agent/AgentMemoryTypes.js';

export const AGENT_TURN_RECEIPT_ACTIONS: readonly AgentTurnReceiptAction[] = ['confirm', 'intention', 'forget'];

const RECEIPT_LABELS: Record<AgentTurnReceiptAction, string> = {
  confirm: '对',
  intention: '只是打算，不用提醒',
  forget: '别记',
};

const ZONE_LABELS: Record<string, string> = {
  'Asia/Tokyo': 'JST',
  'Asia/Shanghai': 'CST',
  'Asia/Seoul': 'KST',
  'Asia/Taipei': 'CST',
  UTC: 'UTC',
};

function zoneLabel(timeZone: string): string {
  return ZONE_LABELS[timeZone] ?? timeZone;
}

export function formatReceiptDue(dueAt: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(dueAt);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  const weekdays: Record<string, string> = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };
  return `${weekdays[part('weekday')] ?? part('weekday')}（${part('month')}/${part('day')} ${part('hour')}:${part('minute')} ${zoneLabel(timeZone)}）`;
}

function bodyOf(receipt: AgentTurnReceipt): string {
  const content = receipt.content.replace(/^(好的|嗯|行|可以|那)[，,、\s]*/u, '').trim();
  if (receipt.kind !== 'commitment' || receipt.owner !== 'user') return content;
  const stripped = content.replace(/^我(?:们)?(?:会|将|要|打算|准备)?\s*/u, '');
  return `提醒你${stripped || content}`;
}

export function formatAgentTurnReceipt(receipt: AgentTurnReceipt): string {
  const label = receipt.kind === 'commitment' ? '承诺' : '打算';
  const due = receipt.dueAt !== undefined
    ? formatReceiptDue(receipt.dueAt, receipt.timeZone)
    : receipt.dueCondition ?? '';
  const buttons = receipt.actions.map((action) => `[${RECEIPT_LABELS[action]}]`).join(' ');
  return `记下了 · ${label}：${due}${bodyOf(receipt)}  ${buttons}`;
}

function receiptOf(input: {
  kind: AgentTurnReceipt['kind'];
  content: string;
  dueAt?: number;
  dueCondition?: string;
  confidence: AgentTurnReceipt['confidence'];
  owner?: AgentTurnReceipt['owner'];
  sourceEventId: string;
  timeZone: string;
}): AgentTurnReceipt {
  const receipt: AgentTurnReceipt = {
    receiptId: `commitment-receipt:${input.sourceEventId}`,
    kind: input.kind,
    provenance: 'rule_extraction',
    content: input.content,
    dueAt: input.dueAt,
    dueCondition: input.dueCondition,
    confidence: input.confidence,
    owner: input.owner,
    sourceEventId: input.sourceEventId,
    timeZone: input.timeZone,
    text: '',
    actions: AGENT_TURN_RECEIPT_ACTIONS,
  };
  receipt.text = formatAgentTurnReceipt(receipt);
  return receipt;
}

export function buildAgentTurnReceipt(input: {
  text: string;
  role: MemoryEventRole;
  occurredAt: number;
  timeZone?: string;
  sourceEventId: string;
}): AgentTurnReceipt | undefined {
  const timeZone = input.timeZone ?? 'UTC';
  const commitment = recognizeCommitments({
    text: input.text,
    role: input.role,
    occurredAt: input.occurredAt,
    timeZone,
    includeAmbiguous: true,
  })[0];
  if (commitment) {
    return receiptOf({
      kind: 'commitment',
      content: commitment.content,
      dueAt: commitment.dueAt,
      dueCondition: commitment.dueCondition,
      confidence: commitment.confidence,
      owner: commitment.owner,
      sourceEventId: input.sourceEventId,
      timeZone,
    });
  }
  const intention = recognizeIntentions({ text: input.text, role: input.role, occurredAt: input.occurredAt, timeZone })[0];
  if (!intention) return undefined;
  return receiptOf({
    kind: 'intention',
    content: intention.content,
    dueAt: intention.dueAt,
    confidence: 'explicit',
    owner: 'agent',
    sourceEventId: input.sourceEventId,
    timeZone,
  });
}

export function withAgentTurnReceipt(
  result: AgentTurnMemoryResult,
  receipt: AgentTurnReceipt | undefined,
): AgentTurnMemoryResult {
  return receipt ? { ...result, receipt } : result;
}

export function receiptTextReply(text: string): { redisplay: true } | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  return Object.values(RECEIPT_LABELS).includes(normalized) || normalized === '只是打算' ? { redisplay: true } : undefined;
}
