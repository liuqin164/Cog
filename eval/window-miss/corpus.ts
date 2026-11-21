import { Database } from 'bun:sqlite';

import { CLASSIFICATION_CORPUS, COMPILE_SCENARIOS } from '../dream-scorecard/corpus.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 2, 0, 0);
const DEFAULT_LEDGER = `${process.env.HOME}/.cogmem/companion-archive-20261116/memory.sqlite`;

export type ProbeKind = 'duplicate' | 'conflict' | 'procedure';
export type Arm = 'window' | 'wide';
export type Verdict = 'handled' | 'window_miss' | 'model_miss';

export interface ProbeEvent {
  role: string;
  text: string;
  occurredAt: number;
  localDate?: string;
}

export interface ProbeWindow {
  id: string;
  events: ProbeEvent[];
}

export interface Expectation {
  id: string;
  label: string;
  kind: ProbeKind;
  mode: 'present' | 'dedupe';
  candidateTypes: string[];
  termGroups: string[][];
  minEvidenceWindows?: number;
}

export interface Probe {
  id: string;
  source: 'scorecard' | 'ledger';
  kind: ProbeKind;
  title: string;
  windows: ProbeWindow[];
  expectation: Expectation;
}

function corpusText(id: string): string {
  const item = CLASSIFICATION_CORPUS.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`missing classification item: ${id}`);
  return item.userText;
}

function compileText(scenarioId: string, dayIndex: number, turnIndex: number): string {
  const scenario = COMPILE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  const turn = scenario?.days[dayIndex]?.turns[turnIndex];
  if (!turn) throw new Error(`missing compile turn: ${scenarioId}/${dayIndex}/${turnIndex}`);
  return turn.userText;
}

function userWindow(id: string, text: string, offset: number): ProbeWindow {
  return {
    id,
    events: [{
      role: 'user',
      text,
      occurredAt: T0 + offset * HOUR,
      localDate: '2026-11-10',
    }],
  };
}

function scorecardProbes(): Probe[] {
  const docs = corpusText('rule-docs-language');
  const commit = corpusText('commit-report');
  const kyoto = corpusText('intention-kyoto');
  const honesty = corpusText('soul-honesty');
  const report = userWindow('release-a', compileText('launch', 0, 1), 0);
  const meeting = userWindow('meeting-a', corpusText('rule-no-meetings'), 0);
  return [
    {
      id: 'dup-docs-rule',
      source: 'scorecard',
      kind: 'duplicate',
      title: 'same document-language rule repeated in two windows',
      windows: [userWindow('docs-a', docs, 0), userWindow('docs-b', docs, 2)],
      expectation: {
        id: 'dup-docs-rule',
        label: 'one durable Chinese-docs rule',
        kind: 'duplicate',
        mode: 'dedupe',
        candidateTypes: ['preferences', 'user_preference', 'boundary', 'project_memory'],
        termGroups: [['对外文档', '文档'], ['中文'], ['英文']],
      },
    },
    {
      id: 'dup-commit-report',
      source: 'scorecard',
      kind: 'duplicate',
      title: 'same report commitment repeated in two windows',
      windows: [userWindow('commit-a', commit, 0), userWindow('commit-b', commit, 2)],
      expectation: {
        id: 'dup-commit-report',
        label: 'one durable Friday-report commitment',
        kind: 'duplicate',
        mode: 'dedupe',
        candidateTypes: ['preferences', 'long_term_goal', 'user_preference', 'project_memory'],
        termGroups: [['星河'], ['报告'], ['周五', '星期五']],
      },
    },
    {
      id: 'dup-kyoto-trip',
      source: 'scorecard',
      kind: 'duplicate',
      title: 'same Kyoto intention repeated in two windows',
      windows: [userWindow('kyoto-a', kyoto, 0), userWindow('kyoto-b', kyoto, 2)],
      expectation: {
        id: 'dup-kyoto-trip',
        label: 'one durable Kyoto intention',
        kind: 'duplicate',
        mode: 'dedupe',
        candidateTypes: ['temporal_fact_update', 'project_memory', 'summary', 'topic_summary'],
        termGroups: [['京都'], ['红叶', '枫叶']],
      },
    },
    {
      id: 'dup-honesty-soul',
      source: 'scorecard',
      kind: 'duplicate',
      title: 'same honesty statement repeated in two windows',
      windows: [userWindow('honesty-a', honesty, 0), userWindow('honesty-b', honesty, 2)],
      expectation: {
        id: 'dup-honesty-soul',
        label: 'one durable honesty preference',
        kind: 'duplicate',
        mode: 'dedupe',
        candidateTypes: ['preferences', 'user_preference', 'boundary', 'project_memory'],
        termGroups: [['诚实'], ['拐弯抹角', '直率', '直接']],
      },
    },
    {
      id: 'conflict-release-day',
      source: 'scorecard',
      kind: 'conflict',
      title: 'release window changes from Wednesday to Thursday across windows',
      windows: [report, userWindow('release-b', '发布窗口改到周四晚上。', 2)],
      expectation: {
        id: 'conflict-release-day',
        label: 'one update naming Wednesday and Thursday',
        kind: 'conflict',
        mode: 'present',
        candidateTypes: ['conflict_candidate', 'temporal_fact_update', 'correction', 'project_memory', 'summary', 'topic_summary'],
        termGroups: [['发布窗口', '发布'], ['周三', '星期三'], ['周四', '星期四']],
        minEvidenceWindows: 2,
      },
    },
    {
      id: 'conflict-report-date',
      source: 'scorecard',
      kind: 'conflict',
      title: 'report deadline changes from Friday to Monday across windows',
      windows: [userWindow('report-a', commit, 0), userWindow('report-b', '报告改到下周一交。', 2)],
      expectation: {
        id: 'conflict-report-date',
        label: 'one update naming Friday and Monday',
        kind: 'conflict',
        mode: 'present',
        candidateTypes: ['conflict_candidate', 'temporal_fact_update', 'correction', 'project_memory', 'summary', 'topic_summary'],
        termGroups: [['报告'], ['周五', '星期五'], ['下周一', '周一']],
        minEvidenceWindows: 2,
      },
    },
    {
      id: 'conflict-docs-language',
      source: 'scorecard',
      kind: 'conflict',
      title: 'document language changes from Chinese to English across windows',
      windows: [userWindow('docs-conflict-a', docs, 0), userWindow('docs-conflict-b', '对外文档改用英文版。', 2)],
      expectation: {
        id: 'conflict-docs-language',
        label: 'one update naming Chinese and English',
        kind: 'conflict',
        mode: 'present',
        candidateTypes: ['conflict_candidate', 'temporal_fact_update', 'correction', 'project_memory', 'summary', 'topic_summary'],
        termGroups: [['对外文档', '文档'], ['中文'], ['改用英文', '改为英文', '切换英文']],
        minEvidenceWindows: 2,
      },
    },
    {
      id: 'conflict-meeting-window',
      source: 'scorecard',
      kind: 'conflict',
      title: 'Wednesday meeting ban lifted across windows',
      windows: [meeting, userWindow('meeting-b', '周三晚上可以排会议了。', 2)],
      expectation: {
        id: 'conflict-meeting-window',
        label: 'one update naming the old ban and the new allowance',
        kind: 'conflict',
        mode: 'present',
        candidateTypes: ['conflict_candidate', 'temporal_fact_update', 'correction', 'project_memory', 'summary', 'topic_summary'],
        termGroups: [
          ['周三', '星期三'],
          ['会议', '排会'],
          ['不要', '禁止', '不再'],
          ['可以排会', '可以排会议', '可以安排', '解除', '取消'],
        ],
        minEvidenceWindows: 2,
      },
    },
  ];
}

interface LedgerEventRow {
  event_id: string;
  global_seq: number;
  episode_id: string;
  role: string | null;
  local_date: string | null;
  occurred_at: number;
  payload_json: string;
}

function ledgerEvents(ledgerPath: string, episodeIds: string[]): ProbeEvent[] {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    const placeholders = episodeIds.map(() => '?').join(', ');
    const rows = db.query(`
      SELECT e.event_id, e.global_seq, l.episode_id, e.role, e.local_date, e.occurred_at, e.payload_json
      FROM memory_events e
      JOIN memory_episode_events l ON l.event_id = e.event_id
      WHERE e.event_type = 'RAW_EVENT_RECORDED'
        AND l.episode_id IN (${placeholders})
      ORDER BY e.global_seq
    `).all(...episodeIds) as LedgerEventRow[];
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as { text?: unknown };
      return {
        role: row.role || 'other',
        text: String(payload.text ?? ''),
        occurredAt: Number(row.occurred_at),
        localDate: row.local_date || undefined,
      };
    }).filter((event) => event.text.trim());
  } finally {
    db.close();
  }
}

function ledgerProbes(ledgerPath: string): Probe[] {
  const installRequestEpisode = 'episode-daeeeff6-0f51-49ff-afaa-895516d4a104';
  const secondInstallEpisode = 'episode-e80f2f5a-59af-462f-a212-f80cb2a85602';
  const pauseEpisode = 'episode-b7916426-461d-4c02-a01d-c202cc7e7f0f';
  const closeEpisode = 'episode-15c6a692-0bd6-4c2f-9161-a8cd4a5ebd6c';
  return [
    {
      id: 'ledger-dup-plugin-request',
      source: 'ledger',
      kind: 'duplicate',
      title: 'same Pi-plugin installation request replayed in two episodes',
      windows: [
        { id: installRequestEpisode, events: ledgerEvents(ledgerPath, [installRequestEpisode]) },
        { id: secondInstallEpisode, events: ledgerEvents(ledgerPath, [secondInstallEpisode]) },
      ],
      expectation: {
        id: 'ledger-dup-plugin-request',
        label: 'one durable Pi-plugin installation task',
        kind: 'duplicate',
        mode: 'dedupe',
        candidateTypes: ['preferences', 'user_preference', 'boundary', 'long_term_goal', 'project_memory'],
        termGroups: [['pi-telegram'], ['插件'], ['安装']],
      },
    },
    {
      id: 'ledger-procedure-pi-removal',
      source: 'ledger',
      kind: 'procedure',
      title: 'Pi-plugin lesson spans attempts, root cause, and native-only decision',
      windows: [
        { id: installRequestEpisode, events: ledgerEvents(ledgerPath, [installRequestEpisode]) },
        { id: pauseEpisode, events: ledgerEvents(ledgerPath, [pauseEpisode]) },
        { id: closeEpisode, events: ledgerEvents(ledgerPath, [closeEpisode]) },
      ],
      expectation: {
        id: 'ledger-procedure-pi-removal',
        label: 'one lesson linking the plugin attempt, env-var root cause, and native-only path',
        kind: 'procedure',
        mode: 'present',
        candidateTypes: ['failure_lesson', 'diagnostic_conclusion', 'project_memory', 'summary', 'topic_summary'],
        termGroups: [
          ['pi-telegram', 'Pi 插件'],
          ['COGMEM_SHELL_PI_PLUGINS'],
          ['原生插件', '原生', 'native'],
        ],
      },
    },
  ];
}

export function buildProbes(ledgerPath = process.env.WINDOW_MISS_LEDGER || DEFAULT_LEDGER): Probe[] {
  return [...scorecardProbes(), ...ledgerProbes(ledgerPath)];
}
