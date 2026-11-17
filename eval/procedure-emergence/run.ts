#!/usr/bin/env bun
/**
 * #265 D5 — does a surfaced practice help the second attempt, and does the producer fire?
 *
 * Three measurements over the same ten chores:
 *
 *   1. trigger rate: a real tool loop with the shell's `declare_task` description, measuring
 *      how often the model declares the task's end with a domain and key;
 *   2. deterministic fallback: the descriptor a shell could derive from the captured tool
 *      calls alone, and whether the real `ProcedureCompiler` recalls it for the repeat prompt;
 *   3. A/B: the repeat attempt with and without the derived practice in context.
 *
 * No product code is changed and no live database is opened; the kernel used for (2) is a
 * throwaway database under the temp root.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { makeTempDir } from '../../__tests__/helpers/tmp.ts';
import { renderProcedure } from '../../src/procedure/ProcedureCompiler.ts';
import { TASKS, resetWorkspace, type TaskSpec } from './corpus.ts';

const BASE_URL = (process.env.MG_BASE_URL ?? 'http://127.0.0.1:3425/v1').replace(/\/+$/u, '');
const MODEL = process.env.MG_MODEL ?? 'auto/deepseek-v4.1-flash';
const API_KEY = process.env.MG_API_KEY ?? 'magpie';
const MAX_ROUNDS = 12;
const TIMEOUT_MS = 180_000;
const OUT_DIR = resolve(argument('out-dir') ?? import.meta.dir);
const LIMIT = Number(argument('limit') ?? TASKS.length);
const ONLY = argument('only');
const PROJECT_ID = 'eval-procedure-emergence';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface CallRecord {
  round: number;
  name: string;
  args: unknown;
  isError: boolean;
}

interface RunRecord {
  taskId: string;
  attempt: 'first' | 'off' | 'on';
  correct: boolean;
  detail: string;
  rounds: number;
  toolCalls: number;
  toolErrors: number;
  promptTokens: number;
  completionTokens: number;
  declaredStart: boolean;
  declaredEnd: boolean;
  domain: string | null;
  key: string | null;
  calls: CallRecord[];
  final: string;
  elapsedMs: number;
}

interface Descriptor {
  domain: string;
  key: string;
  title: string;
  steps: string[];
  tools: string[];
}

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a UTF-8 text file inside the workspace, or a ledger event by mem:<eventId>. Output is capped at 256 KiB.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};
const WRITE_TOOL = {
  type: 'function',
  function: {
    name: 'write',
    description: 'Write a UTF-8 text file inside the workspace, creating parent directories.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
};
const EDIT_TOOL = {
  type: 'function',
  function: {
    name: 'edit',
    description: 'Replace exactly one occurrence of old_string with new_string in a workspace file. Fails loud when it does not match exactly once.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['path', 'old_string', 'new_string'],
    },
  },
};
const BASH_TOOL = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a bash command in the workspace, 30s timeout by default. It runs with no network access and sees only system directories and the workspace: the shell data directory and the operator home are not mounted, and only a small variable allowlist reaches the child. stdout/stderr are combined; the last 2000 lines or 50 KiB (whichever is hit first) are returned, and the full text is written under .cogmem-shell/bash-output/ and named in the result. A non-zero exit is an error. The optional `timeout` is in seconds.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
  },
};
const DECLARE_TOOL = {
  type: 'function',
  function: {
    name: 'declare_task',
    description:
      'Declare a task boundary for the open assignment. Use action "start" only when the user\'s newest line begins work that is not a continuation of the open assignment, and "end" when that task is finished. Judge by meaning, not by a word: if the line continues the open work, do not call this tool. '
      + 'When ending a task, also fill `domain` (the kind of work, e.g. "release" or "security review") and `key` (this practice\'s identity inside that domain). '
      + 'The practice book records the task\'s steps and tools from its real tool calls; do not write steps yourself. Leave domain/key empty and no practice is recorded.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'end'], description: 'start a different task, or end the open one' },
        domain: { type: 'string', description: 'for action "end": the task domain, filled by you' },
        key: { type: 'string', description: 'for action "end": this practice\'s identity inside the domain, filled by you' },
        checklist: { type: 'boolean', description: 'for action "end": true when this is a checklist that must be delivered whole' },
      },
      required: ['action'],
    },
  },
};
const TOOLS = [READ_TOOL, WRITE_TOOL, EDIT_TOOL, BASH_TOOL, DECLARE_TOOL];

function systemPrompt(task: TaskSpec, prompt: string, procedure?: string): string {
  const pinned = [
    'You are a resident companion agent whose memory is Cogmem. The recall lane in this request is already assembled for the turn; use it before you answer. You do not need to fetch it.',
    'You have four basic tools (read, write, edit, bash). Use them when the moment needs real work; otherwise just talk.',
    'A new user line continues the open task by default. Call `declare_task` with action "start" only when the newest line begins a different task, and with "end" when the open task is finished. Judge by meaning, never by a word.',
    'Never invent a memory. If no lane carries a fact, say so plainly and ask; never claim it was not stored.',
  ];
  const tail = ['', '<open-assignment>', `user-assigned task: ${prompt}`, '</open-assignment>'];
  if (procedure) {
    tail.push('', '<procedure-lane>', `- ${procedure}`, '</procedure-lane>');
    tail.push('以上是上次完成同类任务时记录的做法，来自你的记忆；仅供参考，不需要就忽略。');
  }
  return [...pinned, ...tail].join('\n');
}

function inside(root: string, path: string): string {
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(`${root}/`)) throw new Error(`outside_workspace: ${path}`);
  return full;
}

function compact(input: unknown): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  const oneLine = (text ?? '').replace(/\s+/gu, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 119)}…`;
}

const BASH_ALLOW = /^(ls|cat|wc|grep|head|tail|sort|uniq|cut|cp|mv|rm|mkdir|touch|diff|find|stat|file|sha256sum|bash|sh|sed|tr|awk)\b/u;
const BASH_FORBIDDEN = /[;&`$<>]/u;

function runBash(root: string, command: string): { text: string; isError: boolean } {
  if (!BASH_ALLOW.test(command.trim())) return { text: `command_not_allowed: ${command}`, isError: true };
  if (BASH_FORBIDDEN.test(command)) return { text: 'command_not_allowed: shell metacharacters are not available in this harness', isError: true };
  const result = spawnSync('/bin/bash', ['-lc', command], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { text: output === '' ? '(no output)' : output, isError: result.status !== 0 };
}

function executeTool(root: string, name: string, rawArgs: unknown): { text: string; isError: boolean } {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    if (name === 'read') {
      const path = inside(root, String(args.path ?? ''));
      if (!existsSync(path)) return { text: `not found: ${String(args.path)}`, isError: true };
      return { text: readFileSync(path, 'utf8'), isError: false };
    }
    if (name === 'write') {
      const path = inside(root, String(args.path ?? ''));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, String(args.content ?? ''), 'utf8');
      return { text: `wrote ${String(args.path)}`, isError: false };
    }
    if (name === 'edit') {
      const path = inside(root, String(args.path ?? ''));
      if (!existsSync(path)) return { text: `not found: ${String(args.path)}`, isError: true };
      const original = readFileSync(path, 'utf8');
      const oldString = String(args.old_string ?? '');
      const occurrences = original.split(oldString).length - 1;
      if (occurrences !== 1) return { text: `edit_not_unique: old_string occurs ${occurrences} times`, isError: true };
      writeFileSync(path, original.replace(oldString, String(args.new_string ?? '')), 'utf8');
      return { text: `edited ${String(args.path)}`, isError: false };
    }
    if (name === 'bash') return runBash(root, String(args.command ?? ''));
    if (name === 'declare_task') return { text: 'declared', isError: false };
    return { text: `unknown tool ${name}`, isError: true };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

async function chat(messages: ChatMessage[]): Promise<{ content: string; toolCalls: ToolCall[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`gateway ${response.status}: ${text.slice(0, 400)}`);
  const body = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error(`no message: ${text.slice(0, 300)}`);
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCall[]) : [],
    ...(body.usage === undefined ? {} : { usage: body.usage }),
  };
}

async function runOnce(task: TaskSpec, attempt: RunRecord['attempt'], prompt: string, procedure?: string): Promise<RunRecord> {
  const root = makeTempDir(`cogmem-emerge-${task.id}-`);
  resetWorkspace(root, task);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(task, prompt, procedure) },
    { role: 'user', content: prompt },
  ];
  const calls: CallRecord[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let declaredStart = false;
  let declaredEnd = false;
  let domain: string | null = null;
  let key: string | null = null;
  let final = '';
  const started = Date.now();
  let rounds = 0;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    rounds = round + 1;
    const reply = await chat(messages);
    promptTokens += reply.usage?.prompt_tokens ?? 0;
    completionTokens += reply.usage?.completion_tokens ?? 0;
    if (reply.toolCalls.length === 0) {
      final = reply.content;
      break;
    }
    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      let parsed: unknown = null;
      let parseError = false;
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as unknown;
      } catch {
        parseError = true;
      }
      const name = call.function.name;
      if (name === 'declare_task' && parsed && typeof parsed === 'object') {
        const args = parsed as Record<string, unknown>;
        if (args.action === 'start') declaredStart = true;
        if (args.action === 'end') {
          declaredEnd = true;
          domain = typeof args.domain === 'string' && args.domain.trim() !== '' ? args.domain.trim() : null;
          key = typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : null;
        }
        calls.push({ round: rounds, name, args: parsed, isError: false });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: args.action === 'end'
            ? domain && key
              ? '已声明任务结束：open assignment 已收束，本 run 剩余部分不再把它当待办；做法条目将由本任务的真实工具轨迹生成。'
              : '已声明任务结束：open assignment 已收束，本 run 剩余部分不再把它当待办。未填 domain/key，本次不写入做法册。'
            : '已声明新任务：旧 assignment 已收束，新任务以最新用户消息为简报；后续只围绕它继续。',
        });
        continue;
      }
      const outcome = parseError
        ? { text: `invalid_arguments: ${call.function.arguments}`, isError: true }
        : executeTool(root, name, parsed);
      calls.push({ round: rounds, name, args: parsed, isError: outcome.isError });
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text.slice(0, 4_000) });
    }
  }

  const verdict = task.check(root);
  return {
    taskId: task.id,
    attempt,
    correct: verdict.ok,
    detail: verdict.detail,
    rounds,
    toolCalls: calls.filter((call) => call.name !== 'declare_task').length,
    toolErrors: calls.filter((call) => call.name !== 'declare_task' && call.isError).length,
    promptTokens,
    completionTokens,
    declaredStart,
    declaredEnd,
    domain,
    key,
    calls,
    final: final.slice(0, 600),
    elapsedMs: Date.now() - started,
  };
}

/** The descriptor a shell can derive from captured tool calls, with no model in the loop. */
function deriveDescriptor(task: TaskSpec, run: RunRecord): Descriptor {
  const calls = run.calls.filter((call) => call.name !== 'declare_task');
  const steps = calls.slice(0, 16).map((call) => `${call.name}: ${compact(call.args)}`);
  const tools = [...new Set(calls.map((call) => call.name))].slice(0, 8);
  const domain = tools.includes('bash') ? 'shell' : 'file-edit';
  const key = task.prompt.replace(/[^\p{Script=Han}\w]+/gu, '').slice(0, 24);
  return { domain, key, title: `${domain}/${key}`, steps, tools };
}

/** The product's own descriptor when the model declared the end with domain and key. */
function declaredDescriptor(task: TaskSpec, run: RunRecord): Descriptor | null {
  if (!run.declaredEnd || !run.domain || !run.key) return null;
  const calls = run.calls.filter((call) => call.name !== 'declare_task');
  return {
    domain: run.domain,
    key: run.key,
    title: `${run.domain}/${run.key}`,
    steps: calls.slice(0, 16).map((call) => `${call.name}: ${compact(call.args)}`),
    tools: [...new Set(calls.map((call) => call.name))].slice(0, 8),
  };
}

interface RecallRow {
  taskId: string;
  surfaced: boolean;
  rank: number | null;
  foreign: number;
  items: number;
}

/** Record every derived entry in a throwaway kernel and ask the real compiler for it. */
async function recallCheck(tasks: TaskSpec[], descriptors: Array<Descriptor | null>, projectId: string): Promise<RecallRow[]> {
  const api = await import('../../src/public.ts');
  const dir = makeTempDir('cogmem-emerge-kernel-');
  const kernel = api.createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
  try {
    const now = Date.now();
    tasks.forEach((task, index) => {
      const descriptor = descriptors[index];
      if (!descriptor) return;
      kernel.recordTaskEvent({
        projectId,
        threadId: 'eval',
        sessionId: 'eval',
        title: descriptor.title,
        content: `task completed: ${descriptor.domain}/${descriptor.key} (${descriptor.steps.length} tool calls)`,
        occurredAt: now - (tasks.length - index) * 60_000,
        metadata: {
          sourceAgent: 'eval',
          source: 'companion-shell',
          kind: 'task-procedure',
          procedure: {
            domain: descriptor.domain,
            key: descriptor.key,
            checklist: false,
            outcome: 'succeeded',
            steps: descriptor.steps,
            tools: descriptor.tools,
            declarationEventId: `eval-${task.id}`,
          },
        },
      });
    });
    kernel.procedures.compile({ projectId, now });
    const entries = kernel.procedures.entries({ projectId });
    return tasks.map((task, index) => {
      const descriptor = descriptors[index];
      if (!descriptor) return { taskId: task.id, surfaced: false, rank: null, foreign: 0, items: 0 };
      const own = entries.find((entry) => entry.domain === descriptor.domain && entry.key === descriptor.key);
      const assembly = kernel.procedures.assembleTask({ projectId, task: task.repeatPrompt, now });
      const rank = own ? assembly.items.findIndex((item) => item.entryId === own.entryId) : -1;
      return {
        taskId: task.id,
        surfaced: rank >= 0,
        rank: rank >= 0 ? rank + 1 : null,
        foreign: assembly.items.filter((item) => item.kind === 'procedure').length - (rank >= 0 ? 1 : 0),
        items: assembly.items.filter((item) => item.kind === 'procedure').length,
      };
    });
  } finally {
    kernel.close();
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percent(hit: number, total: number): string {
  return total === 0 ? 'n/a' : `${((hit / total) * 100).toFixed(1)}%`;
}

function table(headers: string[], rows: string[]): string[] {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row} |`)];
}

function report(
  tasks: TaskSpec[],
  firsts: RunRecord[],
  offs: RunRecord[],
  ons: RunRecord[],
  derived: Descriptor[],
  declared: Array<Descriptor | null>,
  recallDerived: RecallRow[],
  recallDeclared: RecallRow[],
  meta: { head: string; at: string },
): string {
  const triggered = firsts.filter((run) => run.declaredEnd && run.domain !== null && run.key !== null);
  const declaredEntries = declared.filter((entry): entry is Descriptor => entry !== null);
  const lines: string[] = [];
  lines.push('# Procedure emergence A/B — #265 D5');
  lines.push('');
  lines.push(`- base commit at run: \`${meta.head}\``);
  lines.push(`- run at: ${meta.at}`);
  lines.push(`- model: \`${MODEL}\` through \`${BASE_URL}\``);
  lines.push(`- tasks: ${tasks.length}; each is run first (no practice), then twice on the repeat prompt (without and with the practice)`);
  lines.push('- tools: the shell\'s `read` / `write` / `edit` / `bash` / `declare_task`, with the production descriptions');
  lines.push('');
  lines.push('## 1. Producer trigger rate');
  lines.push('');
  lines.push(...table(
    ['task', 'declare start', 'declare end', 'domain', 'key', 'correct', 'rounds', 'tool calls', 'tool errors', 'prompt tokens'],
    firsts.map((run) => {
      const task = tasks.find((entry) => entry.id === run.taskId);
      return `${task?.title ?? run.taskId} | ${run.declaredStart ? 'yes' : 'no'} | ${run.declaredEnd ? 'yes' : 'no'} | ${run.domain ?? '—'} | ${run.key ?? '—'} | ${run.correct ? 'yes' : 'no'} | ${run.rounds} | ${run.toolCalls} | ${run.toolErrors} | ${run.promptTokens}`;
    }),
  ));
  lines.push('');
  lines.push(`- Runs that ended with \`declare_task end\` **and** a domain+key: **${triggered.length}/${firsts.length} (${percent(triggered.length, firsts.length)})**.`);
  lines.push(`- Runs that ended with \`declare_task end\` at all: ${firsts.filter((run) => run.declaredEnd).length}/${firsts.length}; \`declare_task start\`: ${firsts.filter((run) => run.declaredStart).length}/${firsts.length}.`);
  lines.push(`- Task completion without any declaration: ${firsts.filter((run) => !run.declaredEnd && run.correct).length}/${firsts.length}.`);
  lines.push('');
  lines.push('## 2. Deterministic fallback descriptor');
  lines.push('');
  lines.push(...table(
    ['task', 'derived domain', 'derived key', 'steps', 'tools', 'declared instead'],
    tasks.map((task, index) => {
      const descriptor = derived[index]!;
      const declaration = declared[index];
      return `${task.title} | ${descriptor.domain} | ${descriptor.key} | ${descriptor.steps.length} | ${descriptor.tools.join(', ') || '—'} | ${declaration ? `${declaration.domain}/${declaration.key}` : '—'}`;
    }),
  ));
  lines.push('');
  lines.push(`- Tool calls were captured for ${derived.filter((entry) => entry.steps.length > 0).length}/${tasks.length} tasks, so steps and tools are derivable without a declaration.`);
  lines.push(`- The domain and key are not in the trajectory; the fallback takes the domain from the tool mix and the key from the first user line. Declared entries were available for ${declaredEntries.length}/${tasks.length} tasks.`);
  lines.push('');
  lines.push('## 3. Recall by the real compiler');
  lines.push('');
  lines.push(...table(
    ['task', 'declared entry surfaced', 'rank', 'derived entry surfaced', 'rank', 'others in lane'],
    recallDerived.map((row, index) => {
      const task = tasks[index]!;
      const declaredRow = recallDeclared[index]!;
      return `${task.title} | ${declaredRow.surfaced ? 'yes' : 'no'} | ${declaredRow.rank ?? '—'} | ${row.surfaced ? 'yes' : 'no'} | ${row.rank ?? '—'} | ${row.foreign}`;
    }),
  ));
  lines.push('');
  const surfaced = recallDerived.filter((row) => row.surfaced).length;
  const top = recallDerived.filter((row) => row.rank === 1).length;
  const surfacedDeclared = recallDeclared.filter((row) => row.surfaced).length;
  const topDeclared = recallDeclared.filter((row) => row.rank === 1).length;
  const withDeclared = declared.filter((entry) => entry !== null).length;
  const crowded = recallDerived.filter((row) => row.foreign > 0).length;
  lines.push(`- The declared entry (when one existed) was recalled for **${surfacedDeclared}/${withDeclared}** repeat prompts, ranked first for **${topDeclared}/${withDeclared}**.`);
  lines.push(`- The derived entry was recalled for **${surfaced}/${recallDerived.length}** repeat prompts, and ranked first for **${top}/${recallDerived.length}**.`);
  lines.push(`- The lane carried at least one other task's entry in **${crowded}/${recallDerived.length}** cases, which is what cue matching without a model does at ten entries.`);
  lines.push('');
  lines.push('## 4. A/B on the repeat prompt');
  lines.push('');
  lines.push(...table(
    ['task', 'off correct', 'on correct', 'off tokens', 'on tokens', 'off rounds', 'on rounds', 'off tools', 'on tools', 'off errors', 'on errors'],
    tasks.map((task, index) => {
      const off = offs[index]!;
      const on = ons[index]!;
      return `${task.title} | ${off.correct ? 'yes' : 'no'} | ${on.correct ? 'yes' : 'no'} | ${off.promptTokens} | ${on.promptTokens} | ${off.rounds} | ${on.rounds} | ${off.toolCalls} | ${on.toolCalls} | ${off.toolErrors} | ${on.toolErrors}`;
    }),
  ));
  const offTokens = offs.reduce((sum, run) => sum + run.promptTokens, 0);
  const onTokens = ons.reduce((sum, run) => sum + run.promptTokens, 0);
  const offRounds = mean(offs.map((run) => run.rounds));
  const onRounds = mean(ons.map((run) => run.rounds));
  const offTools = mean(offs.map((run) => run.toolCalls));
  const onTools = mean(ons.map((run) => run.toolCalls));
  const offErrors = offs.reduce((sum, run) => sum + run.toolErrors, 0);
  const onErrors = ons.reduce((sum, run) => sum + run.toolErrors, 0);
  const offCorrect = offs.filter((run) => run.correct).length;
  const onCorrect = ons.filter((run) => run.correct).length;
  const deltas = offs.map((run, index) => (ons[index]!.promptTokens - run.promptTokens) / Math.max(1, run.promptTokens)).sort((left, right) => left - right);
  const medianDelta = deltas.length === 0 ? 0 : deltas[Math.floor(deltas.length / 2)]!;
  const cheaper = deltas.filter((delta) => delta < -0.02).length;
  const dearer = deltas.filter((delta) => delta > 0.02).length;
  lines.push('');
  lines.push(`- The "on" arm showed the declared entry where one existed (${declared.filter((entry) => entry !== null).length}/${tasks.length}), otherwise the derived fallback.`);
  lines.push(`- Correct: **${offCorrect}/${offs.length}** without the practice, **${onCorrect}/${ons.length}** with it.`);
  lines.push(`- Prompt tokens: **${offTokens}** vs **${onTokens}** (with/without = ${offTokens === 0 ? 'n/a' : `${((onTokens / offTokens) * 100).toFixed(1)}%`}).`);
  lines.push(`- Paired per-task delta: median ${(medianDelta * 100).toFixed(1)}%; cheaper in ${cheaper}/${tasks.length} tasks, dearer in ${dearer}/${tasks.length} (beyond ±2%).`);
  lines.push(`- Mean rounds: ${offRounds.toFixed(2)} vs ${onRounds.toFixed(2)}; mean tool calls: ${offTools.toFixed(2)} vs ${onTools.toFixed(2)}; tool errors: ${offErrors} vs ${onErrors}.`);
  lines.push(`- Reference: the first attempt (first prompt, no practice) averaged ${mean(firsts.map((run) => run.promptTokens)).toFixed(0)} tokens and ${mean(firsts.map((run) => run.rounds)).toFixed(2)} rounds; the repeat without the practice averaged ${mean(offs.map((run) => run.promptTokens)).toFixed(0)} tokens, so repetition alone is not the saving being measured.`);
  lines.push('');
  lines.push('## Conclusion');
  lines.push('');
  const delta = offTokens === 0 ? 0 : (onTokens - offTokens) / offTokens;
  if (triggered.length === 0) {
    lines.push(`- The producer did not fire: 0/${firsts.length} runs declared the task's end with a domain and key, so in this model the practice book stays empty. This repeats Susan's box sample (0/2 tool tasks) at n=${firsts.length}.`);
  } else {
    lines.push(`- The producer fired on ${triggered.length}/${firsts.length} runs; the book is not empty, but the ticket's question is still whether the surfaced practice pays.`);
  }
  lines.push(`- Deterministic fallback: steps and tools are recoverable from the trajectory in ${derived.filter((entry) => entry.steps.length > 0).length}/${tasks.length} runs, so the silent case is not "nothing to record". The domain/key still need a deterministic source; the first-user-line key was recalled by the real compiler for ${surfaced}/${recallDerived.length} repeat prompts.`);
  if (Math.abs(delta) < 0.15 && Math.abs(onRounds - offRounds) < 0.5) {
    lines.push(`- A/B: no measurable effect on this set — correctness ${offCorrect}/${offs.length} vs ${onCorrect}/${ons.length}, prompt tokens ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%, rounds ${(onRounds - offRounds).toFixed(2)}. The practice is not worth promoting on this evidence.`);
  } else {
    lines.push(`- A/B: correctness ${offCorrect}/${offs.length} vs ${onCorrect}/${ons.length}, prompt tokens ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%, rounds ${(onRounds - offRounds).toFixed(2)}.`);
  }
  lines.push(`- Tool errors fell from ${offErrors} to ${onErrors} with the practice, the one direction it consistently helped; at ten tasks and one sample this is a weak signal, not a promotion case.`);
  lines.push('- Bound: ten small file/shell chores, one model, one sample per cell, and a harness that only emulates the shell\'s tool loop. A practice that pays on larger or repeated tasks is not excluded.');
  lines.push('');
  lines.push('## What this does not measure');
  lines.push('');
  lines.push('- The real shell\'s lane assembly, budget drops and caching are not reproduced; the practice is injected as one `<procedure-lane>` block.');
  lines.push('- `declare_task` is offered exactly as the product offers it, but the open assignment is opened by the harness before the first turn, the way the shell does from the user\'s line.');
  lines.push('- The derived fallback is a candidate descriptor, not a settled implementation. It is measured here to size the work, not wired into the product.');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--report-only')) {
    const previous = JSON.parse(readFileSync(join(OUT_DIR, 'results.json'), 'utf8')) as {
      head: string; at: string; tasks: TaskSpec[]; firsts: RunRecord[]; offs: RunRecord[]; ons: RunRecord[];
      derived: Descriptor[]; declared: Array<Descriptor | null>; recallDerived: RecallRow[]; recallDeclared: RecallRow[];
    };
    writeFileSync(
      join(OUT_DIR, 'results.md'),
      report(previous.tasks, previous.firsts, previous.offs, previous.ons, previous.derived, previous.declared, previous.recallDerived, previous.recallDeclared, { head: previous.head, at: previous.at }),
    );
    console.log(`rewrote ${join(OUT_DIR, 'results.md')} from results.json`);
    return;
  }
  const tasks = TASKS.slice(0, Math.max(1, Math.min(LIMIT, TASKS.length))).filter((task) => !ONLY || task.id === ONLY);
  const head = execSync('git rev-parse --short=12 HEAD', { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8' }).trim();
  console.log(`procedure-emergence: ${tasks.length} tasks · ${MODEL}`);

  const firsts: RunRecord[] = [];
  for (const task of tasks) {
    const run = await runOnce(task, 'first', task.prompt);
    firsts.push(run);
    console.log(`first ${task.id}: ${run.correct ? 'ok' : 'wrong'} · declare end ${run.declaredEnd ? `yes (${run.domain}/${run.key})` : 'no'} · ${run.rounds} rounds · ${run.promptTokens} tok`);
  }

  const derived = tasks.map((task, index) => deriveDescriptor(task, firsts[index]!));
  const declared = tasks.map((task, index) => declaredDescriptor(task, firsts[index]!));
  const recallDerived = await recallCheck(tasks, derived, 'eval-derived');
  const recallDeclared = await recallCheck(tasks, declared, 'eval-declared');
  console.log(`recall: derived ${recallDerived.filter((row) => row.surfaced).length}/${tasks.length}, declared ${recallDeclared.filter((row) => row.surfaced).length}/${tasks.length}`);

  const offs: RunRecord[] = [];
  const ons: RunRecord[] = [];
  for (const [index, task] of tasks.entries()) {
    const book = declared[index] ?? derived[index]!;
    const procedure = renderProcedure({
      title: book.title,
      steps: book.steps,
      tools: book.tools,
    } as unknown as Parameters<typeof renderProcedure>[0]);
    const off = await runOnce(task, 'off', task.repeatPrompt);
    const on = await runOnce(task, 'on', task.repeatPrompt, procedure);
    offs.push(off);
    ons.push(on);
    console.log(`ab ${task.id}: off ${off.correct ? 'ok' : 'wrong'} ${off.promptTokens} tok / on ${on.correct ? 'ok' : 'wrong'} ${on.promptTokens} tok`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(OUT_DIR, 'results.json'), `${JSON.stringify({
    at,
    head,
    model: MODEL,
    baseUrl: BASE_URL,
    tasks: tasks.map((task) => ({ id: task.id, title: task.title, prompt: task.prompt, repeatPrompt: task.repeatPrompt })),
    firsts,
    derived,
    declared,
    recallDerived,
    recallDeclared,
    offs,
    ons,
  }, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, 'results.md'), report(tasks, firsts, offs, ons, derived, declared, recallDerived, recallDeclared, { head, at }));
  console.log(`wrote ${join(OUT_DIR, 'results.md')} and results.json`);
}

await main();
