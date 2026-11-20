#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createMemoryKernel, KernelAgentMemoryBackend } from '../../src/public.ts';
import { ModelRegistry } from '../../src/models/ModelRegistry.ts';
import { EMBEDDING_MODEL } from '../../shell/src/embedding/model.ts';
import { XenovaEmbeddingProvider } from '../../shell/src/embedding/xenova.ts';

interface SessionTurn {
  role: string;
  content: string;
}

interface Instance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: SessionTurn[][];
  answer_session_ids: string[];
}

const repo = resolve(import.meta.dir, '../..');
const workRoot = join(repo, '.cogmem', 'assoc');
const dataPath = resolve(argument('data') ?? '');
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const cacheDir = resolve(argument('cache-dir') ?? join(workRoot, 'models'));
const limit = Number(argument('limit') ?? 50);
const k = Number(argument('k') ?? 5);
const model = argument('model') ?? 'auto/deepseek-v4.1-flash';
const baseUrl = (argument('base-url') ?? 'http://127.0.0.1:3425/v1').replace(/\/$/u, '');
const apiKey = argument('api-key') ?? 'magpie';
const answer = !process.argv.includes('--no-answer');
const keepScratch = process.argv.includes('--keep');
const agentId = 'lme-agent';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sample(instances: Instance[]): Instance[] {
  const sorted = [...instances].sort((left, right) => left.question_id.localeCompare(right.question_id));
  const step = Math.max(1, Math.floor(sorted.length / Math.max(1, limit)));
  const picked: Instance[] = [];
  for (let index = 0; index < sorted.length && picked.length < limit; index += step) picked.push(sorted[index]!);
  return picked;
}

function parseWhen(value: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})/u.exec(value);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Date.now();
}

function sessionText(turns: SessionTurn[]): string {
  return turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n');
}

function judgePrompt(instance: Instance, hypothesis: string): string {
  if (instance.question_id.includes('_abs')) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${instance.question}\n\nExplanation: ${instance.answer}\n\nModel Response: ${hypothesis}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (instance.question_type === 'temporal-reasoning') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.\n\nQuestion: ${instance.question}\n\nCorrect Answer: ${instance.answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (instance.question_type === 'knowledge-update') {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${instance.question}\n\nCorrect Answer: ${instance.answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (instance.question_type === 'single-session-preference') {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${instance.question}\n\nRubric: ${instance.answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
  }
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: ${instance.question}\n\nCorrect Answer: ${instance.answer}\n\nModel Response: ${hypothesis}\n\nIs the model response correct? Answer yes or no only.`;
}

async function chat(prompt: string, maxTokens: number): Promise<{ text: string; model: string }> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: maxTokens, reasoning: { effort: 'low' } }),
  });
  if (!response.ok) throw new Error(`model ${response.status}: ${await response.text()}`);
  const body = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string } }> };
  return { text: body.choices?.[0]?.message?.content?.trim() ?? '', model: body.model ?? model };
}

async function waitForEmbeddings(kernel: ReturnType<typeof createMemoryKernel>, projectId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (kernel.eventEmbeddingStore.getProgress(projectId).completed >= expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`embeddings did not settle for ${projectId}: ${kernel.eventEmbeddingStore.getProgress(projectId).completed}/${expected}`);
}

async function main(): Promise<void> {
  if (!dataPath) throw new Error('Usage: bun eval/associative/longmemeval.ts --data <longmemeval.json> [--limit N]');
  const dataset = JSON.parse(readFileSync(dataPath, 'utf8')) as Instance[];
  const instances = sample(dataset);
  const scratch = mkdtempSync(join(workRoot, 'lme-'));
  process.env.TMPDIR ??= scratch;
  mkdirSync(outDir, { recursive: true });
  const provider = new XenovaEmbeddingProvider(cacheDir);
  const registry = new ModelRegistry({
    memory: { role: 'memory', provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', modelName: 'unused', timeoutMs: 1_000, maxTokens: 1024, fallback: 'rule_only' },
    reasoning: { role: 'reasoning', provider: 'rule_only', modelName: 'rule_only', timeoutMs: 1_000, fallback: 'memory' },
    embedding: { role: 'embedding', provider: 'openai_compatible', modelName: EMBEDDING_MODEL, timeoutMs: 30_000 },
  });
  const kernel = createMemoryKernel({ dbPath: join(scratch, 'memory.sqlite'), projectTimeZone: 'UTC', modelRegistry: registry, embeddingProvider: provider });
  const backend = new KernelAgentMemoryBackend(kernel, { agentId });
  const keepAlive = setInterval(() => {}, 1_000);
  await provider.warm();

  const rows: Array<Record<string, unknown>> = [];
  const answeredBy = new Set<string>();
  for (const [index, instance] of instances.entries()) {
    const projectId = `lme-${instance.question_id}`;
    const eventToSession = new Map<string, string>();
    const sessionDates = new Map<string, string>();
    for (const [sessionIndex, turns] of instance.haystack_sessions.entries()) {
      const sessionId = instance.haystack_session_ids[sessionIndex] ?? `${instance.question_id}-${sessionIndex}`;
      const sessionDate = instance.haystack_dates[sessionIndex] ?? instance.question_date;
      sessionDates.set(sessionId, sessionDate);
      const result = await backend.rememberTurnWithResult({
        agentId,
        projectId,
        sessionId,
        threadId: sessionId,
        userText: sessionText(turns),
        timestamp: parseWhen(sessionDate),
      });
      for (const eventId of result.rawEventIds) eventToSession.set(eventId, sessionId);
    }
    await waitForEmbeddings(kernel, projectId, instance.haystack_sessions.length);
    const recalled = backend.recall({
      agentId,
      projectId,
      query: instance.question,
      limit: k,
      now: parseWhen(instance.question_date),
      timeZone: 'UTC',
    });
    const sessions = recalled.items.map((item) => {
      const eventId = item.sourceAnchor?.eventId;
      return (eventId ? eventToSession.get(eventId) : undefined) ?? '?';
    });
    const retrievalHit = sessions.some((sessionId) => instance.answer_session_ids.includes(sessionId));
    let hypothesis = '';
    let judge = false;
    if (answer) {
      const memories = recalled.items.map((item, index) => {
        const date = sessionDates.get(sessions[index] ?? '');
        return `${date ? `[${date}] ` : ''}${item.text}`;
      }).join('\n---\n');
      const prompt = `You are the user's memory companion. Answer the question using only the recalled memories below. If they do not contain the answer, say that you do not have it. Keep the answer short.\n\nQuestion date: ${instance.question_date}\n\nQuestion: ${instance.question}\n\nRecalled memories:\n${memories || '(none)'}\n\nAnswer:`;
      const reply = await chat(prompt, 2_048);
      hypothesis = reply.text;
      answeredBy.add(reply.model);
      const verdict = await chat(judgePrompt(instance, hypothesis), 512);
      answeredBy.add(verdict.model);
      judge = verdict.text.toLowerCase().includes('yes');
    }
    rows.push({
      question_id: instance.question_id,
      question_type: instance.question_type,
      question: instance.question,
      answer: instance.answer,
      hypothesis,
      judged_correct: judge,
      retrieval_hit: retrievalHit,
      recalled_sessions: sessions,
    });
    process.stdout.write(`${index + 1}/${instances.length} ${instance.question_id} retrieval=${retrievalHit} judge=${judge}\n`);
  }

  const byType = new Map<string, { n: number; correct: number; retrieval: number }>();
  for (const row of rows) {
    const type = String(row.question_type);
    const entry = byType.get(type) ?? { n: 0, correct: 0, retrieval: 0 };
    entry.n += 1;
    if (row.judged_correct) entry.correct += 1;
    if (row.retrieval_hit) entry.retrieval += 1;
    byType.set(type, entry);
  }
  const total = rows.length;
  const correct = rows.filter((row) => row.judged_correct).length;
  const retrieval = rows.filter((row) => row.retrieval_hit).length;
  const result = {
    at: new Date().toISOString(),
    data: dataPath,
    split: dataPath.split('/').at(-1),
    sampling: { rule: 'sort by question_id, step=floor(n/limit), take limit', n: total, dataset: dataset.length },
    k,
    embedding: EMBEDDING_MODEL,
    answering: answer ? { requested: model, observed: [...answeredBy] } : null,
    accuracy: correct / total,
    retrievalHitRate: retrieval / total,
    byType: Object.fromEntries([...byType].map(([type, entry]) => [type, { n: entry.n, accuracy: entry.correct / entry.n, retrieval: entry.retrieval / entry.n }])),
    rows,
  };
  writeFileSync(join(outDir, 'longmemeval-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const markdown = [
    '# LongMemEval — #355',
    '',
    `- data: \`${dataPath}\``,
    `- sample: ${total} questions (${result.sampling.rule}), k=${k}`,
    `- embedding: \`${EMBEDDING_MODEL}\``,
    `- answering: ${answer ? `${model} (observed: ${[...answeredBy].join(', ')})` : 'disabled (--no-answer)'}`,
    '',
    '| question type | n | retrieval hit | accuracy |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(result.byType).map(([type, entry]) => `| ${type} | ${entry.n} | ${pct(entry.retrieval)} | ${answer ? pct(entry.accuracy) : 'n/a'} |`),
    `| all | ${total} | ${pct(result.retrievalHitRate)} | ${answer ? pct(result.accuracy) : 'n/a'} |`,
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'longmemeval-results.md'), markdown);
  process.stdout.write(markdown);

  provider.dispose();
  kernel.close();
  clearInterval(keepAlive);
  if (!keepScratch) rmSync(scratch, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
