#!/usr/bin/env bun
/**
 * #346 — the product-level continuity scorecard.
 *
 * One command, from the repository root:
 *
 *   bun eval/continuity/run.ts
 *
 * Every scenario drives a real `CompanionShell` with the shell test helpers' `makeShell` and
 * `ScriptedProvider`; no real model is called. The six scenarios are the ones in #346:
 *
 *   1. 30 days x 20 turns: every request stays inside the target bandwidth and the recall lane is
 *      present in at least 90% of turns (#316).
 *   2. forget: a seeded fact is recallable, `/forget` removes it from recall and from every file
 *      under the data directory (#332/#331).
 *   3. night: the process is asleep across the 02:00-05:00 window; the first tick after 05:00
 *      catches the Dream up once and writes one snapshot (#327).
 *   4. emergence: a due promise surfaces once; after three ignored surfacings the next one is
 *      delayed or suppressed (#330).
 *   5. budget pause: a work run stops at the cage, `/continue` resumes the same assignment from
 *      the checkpointed stop (#228).
 *   6. kill: SIGKILL during a run; the next process still has the open assignment and away queue
 *      (#331).
 *
 * The scorecard writes `results.md` / `results.json` next to this file and exits non-zero when a
 * scenario fails. `--report-only` exits 0 (for a baseline run); `--keep` leaves the temp dirs.
 */
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ScriptedProvider, makeShell, makeTempDir, waitUntil } from '../../shell/test/helpers.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const NO_DREAM = { windowStartHour: 23, windowEndHour: 23, runKernelNight: false, maxEpisodes: 5 };
const DREAM_2_TO_5 = { windowStartHour: 2, windowEndHour: 5, runKernelNight: false, maxEpisodes: 5 };
const LONG_SESSION_DAYS = 30;
const LONG_SESSION_TURNS_PER_DAY = 20;

const repo = resolve(import.meta.dir, '../..');
const outDir = resolve(argument('out-dir') ?? import.meta.dir);
const keep = process.argv.includes('--keep');
const reportOnly = process.argv.includes('--report-only');

interface Metric {
  key: string;
  value: string;
  pass: boolean;
  threshold: string;
  detail?: string;
}

interface ScenarioResult {
  name: string;
  metrics: Metric[];
  pass: boolean;
  durationMs: number;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function gitHead(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function percent(hits: number, total: number): string {
  return total === 0 ? 'n/a' : `${((100 * hits) / total).toFixed(1)}%`;
}

function metric(key: string, value: string, pass: boolean, threshold: string, detail?: string): Metric {
  return { key, value, pass, threshold, ...(detail === undefined ? {} : { detail }) };
}

function cleanup(dir: string): void {
  if (!keep) rmSync(dir, { recursive: true, force: true });
}

function scanForText(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const wanted = Buffer.from(needle);
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      try {
        if (readFileSync(child).includes(wanted)) hits.push(child.slice(dir.length) || child);
      } catch {
        // A file that vanished between readdir and read is not evidence either way.
      }
    }
  };
  walk(dir);
  return hits.sort();
}

function snapshotCount(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.snap')).length;
  } catch {
    return 0;
  }
}

async function runScenario(name: string, scenario: () => Promise<Metric[]>): Promise<ScenarioResult> {
  const started = performance.now();
  try {
    const metrics = await scenario();
    return { name, metrics, pass: metrics.every((item) => item.pass), durationMs: performance.now() - started };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return {
      name,
      metrics: [metric('error', message.split('\n')[0]!, false, 'no error', message)],
      pass: false,
      durationMs: performance.now() - started,
    };
  }
}

/** 1. 30 days x 20 turns: bandwidth ceiling and recall-lane presence (#316). */
async function longSession(): Promise<Metric[]> {
  const dir = makeTempDir('continuity-long-');
  const provider = new ScriptedProvider([{ text: '记下了，我继续整理。', toolCalls: [] }]);
  const shell = makeShell(dir, provider, {
    dream: NO_DREAM,
    contextSweetSpot: 6_000,
    idleWakeIntervalMs: DAY,
  });
  await shell.start();
  try {
    await shell.submit('记住：我的项目代号是青岚。');
    const included: boolean[] = [];
    const utilization: number[] = [];
    let maxUsed = 0;
    let target = 6_000;
    for (let day = 0; day < LONG_SESSION_DAYS; day += 1) {
      for (let turn = 0; turn < LONG_SESSION_TURNS_PER_DAY; turn += 1) {
        const text =
          `第${day + 1}天第${turn + 1}轮：今天继续整理书架和旧照片，把上周的会议记录也归档了，` +
          `顺便确认一下我的项目代号是什么？还有几份文档需要按日期重新排列，晚点再处理。`;
        await shell.submit(text);
        const view = shell.currentStatus().contextLanes;
        const recall = view?.lanes.find((lane) => lane.lane === 'recall');
        included.push(recall?.status === 'included');
        target = view?.targetTokens ?? target;
        maxUsed = Math.max(maxUsed, view?.usedTokens ?? 0);
        utilization.push((view?.usedTokens ?? 0) / Math.max(1, view?.targetTokens ?? target));
      }
      if ((day + 1) % 5 === 0) process.stderr.write(`[continuity] long session: day ${day + 1}/${LONG_SESSION_DAYS}\n`);
    }
    const hits = included.filter(Boolean).length;
    const minUtilization = Math.min(...utilization);
    return [
      metric(
        'recall_lane_included',
        `${hits}/${included.length} (${percent(hits, included.length)})`,
        hits / included.length >= 0.9,
        '>= 90% of turns',
      ),
      metric('max_request_tokens', `${maxUsed} / ${target}`, maxUsed <= target, '<= target bandwidth'),
      metric(
        'min_budget_utilization',
        `${(100 * minUtilization).toFixed(1)}%`,
        minUtilization >= 0.5,
        '>= 50% of target',
      ),
    ];
  } finally {
    await shell.stop();
    cleanup(dir);
  }
}

/** 2. Forget: recall empty and zero file hits after `/forget confirm` (#332/#331). */
async function forget(): Promise<Metric[]> {
  const dir = makeTempDir('continuity-forget-');
  const marker = 'zz-forget-7f3a9c';
  const query = '我以前的住址是哪里？';
  const shell = makeShell(dir, new ScriptedProvider([{ text: '记下了。', toolCalls: [] }]), { dream: NO_DREAM });
  await shell.start();
  try {
    await shell.submit(`${marker} 我的旧住址是青叶町十二号。`);
    const recall = (text: string) =>
      shell.backend.recall({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        query: text,
        limit: 5,
      });
    const before = recall(query).items.some((item) => item.text.includes(marker));
    const now = Date.now();
    await shell.runCommand('forget', `${new Date(now - DAY).toISOString()} ${new Date(now + DAY).toISOString()}`);
    await shell.runCommand('forget', 'confirm');
    const after = recall(query).items.some((item) => item.text.includes(marker));
    await shell.stop();
    const hits = scanForText(dir, marker);
    return [
      metric('pre_forget_recall', before ? 'hit' : 'miss', before, 'the seeded fact is recallable'),
      metric('post_forget_recall', after ? 'hit' : 'empty', !after, 'empty'),
      metric(
        'post_forget_disk_hits',
        `${hits.length} file(s)`,
        hits.length === 0,
        '0 files',
        hits.slice(0, 6).join(', '),
      ),
    ];
  } finally {
    await shell.stop();
    cleanup(dir);
  }
}

/** 3. Night: sleep across the window, then catch the Dream up once and snapshot (#327). */
async function night(): Promise<Metric[]> {
  const dir = makeTempDir('continuity-night-');
  const clock = { now: T0 + HOUR };
  const config = { dream: DREAM_2_TO_5, idleWakeIntervalMs: DAY };
  const first = makeShell(dir, new ScriptedProvider([{ text: '好的。', toolCalls: [] }]), config, { now: () => clock.now });
  await first.start();
  try {
    await first.submit('今天修好了花园的栅栏。');
  } finally {
    await first.stop();
  }
  clock.now = T0 + 6 * HOUR;
  const second = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), config, { now: () => clock.now });
  await second.start();
  try {
    await second.tick(clock.now);
    const trace = second.trace.read();
    const dreams = trace.filter((record) => record.kind === 'dream_complete').length;
    const catchups = trace.filter((record) => record.kind === 'dream_catchup').length;
    const snapshots = snapshotCount(join(dir, 'data', 'snapshots'));
    return [
      metric('dream_complete_after_missed_window', String(dreams), dreams === 1, '1'),
      metric('dream_catchup_trace', String(catchups), catchups >= 1, '>= 1'),
      metric('snapshots_after_missed_window', String(snapshots), snapshots >= 1, '>= 1'),
    ];
  } finally {
    await second.stop();
    cleanup(dir);
  }
}

/** 4. Emergence: one due promise, then three ignored surfacings (#330). */
async function emergence(): Promise<Metric[]> {
  const dir = makeTempDir('continuity-emergence-');
  const clock = { now: T0 };
  const provider = new ScriptedProvider([{ text: '提醒你一下。', toolCalls: [] }]);
  const shell = makeShell(dir, provider, { dream: NO_DREAM, idleWakeIntervalMs: DAY }, { now: () => clock.now });
  await shell.start();
  try {
    const due = T0 + 3 * HOUR;
    const texts = [
      '我 3 小时后把红色雨伞的照片发你',
      '我 3 小时后把蓝色笔记本带给你',
      '我 3 小时后把绿色杯子送到你桌上',
      '我 3 小时后把黄色钥匙交给你',
    ];
    const runsByTick: number[] = [];
    for (const [index, text] of texts.entries()) {
      await shell.backend.rememberTurnWithResult({
        agentId: shell.config.agentId,
        projectId: shell.config.projectId,
        sessionId: shell.config.sessionId,
        threadId: 'continuity-emergence',
        turnId: `continuity-commitment-${index}`,
        userText: text,
        assistantText: '记下了。',
        timestamp: T0 + index,
        ingestMode: 'immediate_compile',
      });
      clock.now = due + 1_000 + index * 3 * MINUTE;
      const before = shell.trace.read().filter((record) => record.kind === 'emergence_run').length;
      await shell.tick(clock.now);
      const after = shell.trace.read().filter((record) => record.kind === 'emergence_run').length;
      runsByTick.push(after - before);
    }
    const total = runsByTick.reduce((sum, count) => sum + count, 0);
    return [
      metric('first_due_surfacing', String(runsByTick[0] ?? 0), runsByTick[0] === 1, 'exactly 1'),
      metric(
        'surfacings_after_three_ignored',
        String(total),
        total <= 3,
        '<= 3 (the fourth waits or is suppressed)',
        `per tick: ${runsByTick.join(', ')}`,
      ),
    ];
  } finally {
    await shell.stop();
    cleanup(dir);
  }
}

/** 5. Budget pause: `/continue` resumes the same assignment from its checkpointed stop (#228). */
async function budgetPause(): Promise<Metric[]> {
  const dir = makeTempDir('continuity-pause-');
  const tight = { maxTurnsPerRun: 5, maxTokensPerRun: 1_000, toolWhitelist: null };
  const provider = new ScriptedProvider([
    {
      text: 'working',
      toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: { path: 'missing.txt' } }],
      usage: { input: 1_500, output: 1 },
    },
    { text: 'finished', toolCalls: [] },
  ]);
  const shell = makeShell(dir, provider, { budgets: tight, workBudget: tight, dream: NO_DREAM });
  await shell.start();
  try {
    const first = await shell.submit('把这份报告整理完');
    const paused = shell.state === 'SUSPENDED' && shell.machine.runtime.suspension?.kind === 'budget';
    const stoppedStep = shell.machine.runtime.openAssignment?.stoppedStep ?? '';
    const reply = await shell.runCommand('continue');
    await waitUntil(() => shell.state === 'IDLE', 10_000);
    const resumed = provider.calls.length >= 2
      && (provider.calls[1]!.systemPrompt ?? '').includes('<open-assignment>')
      && (provider.calls[1]!.systemPrompt ?? '').includes('stopped at:');
    const closed = shell.machine.runtime.openAssignment === undefined;
    return [
      metric('budget_stop_is_a_pause', first?.stopReason ?? 'none', paused, 'SUSPENDED / budget'),
      metric('resume_keeps_the_assignment', stoppedStep || '(none)', resumed, 'the second request carries the stop'),
      metric('resume_completes', reply.text, closed, 'IDLE and the assignment closed'),
    ];
  } finally {
    await shell.stop();
    cleanup(dir);
  }
}

/** 6. SIGKILL: the open assignment and away queue survive a real process boundary (#331). */
async function killedProcess(): Promise<Metric[]> {
  const dir = makeTempDir('continuity-kill-');
  let child: ReturnType<typeof spawn> | undefined;
  let shell: ReturnType<typeof makeShell> | undefined;
  try {
    const fixture = join(import.meta.dir, 'fixtures', 'shell-kill.ts');
    child = spawn(process.execPath, [fixture, dir], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const events: Array<{ event?: string; [key: string]: unknown }> = [];
    createInterface({ input: child.stdout! }).on('line', (line: string) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        // A banner is not an event.
      }
    });
    const ready = await waitForEvent(events, 'ready', 20_000, () => stderr);
    child.kill('SIGKILL');
    await new Promise<void>((resolvePromise) => child!.once('exit', () => resolvePromise()));
    child = undefined;

    shell = makeShell(dir, new ScriptedProvider([{ text: 'unused', toolCalls: [] }]), {
      projectId: 'companion-kill',
      agentId: 'cogmem-companion-kill',
      sessionId: 'session-kill',
      dream: NO_DREAM,
      idleWakeIntervalMs: DAY,
    });
    await shell.start();
    const assignment = shell.machine.runtime.openAssignment;
    const away = shell.machine.runtime.awayQueue ?? [];
    return [
      metric('state_after_sigkill', shell.state, shell.state === 'IDLE', 'IDLE'),
      metric(
        'assignment_survives_sigkill',
        assignment?.text ?? '(missing)',
        assignment?.text === '把这份报告整理完，然后等我确认',
        'the open assignment text is back',
      ),
      metric(
        'away_queue_survives_sigkill',
        String(away.length),
        away.length === 1 && away[0]?.text === '你不在时攒下的一条浮现',
        '1 entry',
        `fixture saw away=${String(ready.away ?? '?')}`,
      ),
    ];
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await shell?.stop();
    cleanup(dir);
  }
}

async function waitForEvent(
  events: Array<{ event?: string; [key: string]: unknown }>,
  name: string,
  timeoutMs: number,
  stderr: () => string,
): Promise<{ event?: string; [key: string]: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find((event) => event.event === name);
    if (found) return found;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timeout waiting for ${name}; saw ${events.map((event) => event.event).join(', ')}; stderr: ${stderr()}`);
}

function renderMarkdown(results: ScenarioResult[]): string {
  const passed = results.filter((result) => result.pass).length;
  const totalSeconds = results.reduce((sum, result) => sum + result.durationMs, 0) / 1000;
  const lines = [
    '# Continuity scorecard — #346',
    '',
    `- base commit at run: \`${gitHead()}\``,
    `- run at: ${new Date().toISOString()}`,
    `- bun: ${process.versions.bun} · ${process.platform}/${process.arch}`,
    `- scenarios: ${passed}/${results.length} pass`,
    `- wall time: ${totalSeconds.toFixed(1)} s`,
    '- every scenario drives the real `CompanionShell` with `makeShell` + `ScriptedProvider`; no model call.',
    '',
    '| scenario | result | metric | value | threshold |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const result of results) {
    for (const [index, item] of result.metrics.entries()) {
      lines.push(
        `| ${index === 0 ? result.name : ''} | ${index === 0 ? (result.pass ? 'PASS' : 'FAIL') : ''} | ${item.key} | ${item.value} | ${item.threshold} |`,
      );
    }
  }
  lines.push(
    '',
    '## Notes',
    '',
    '- Scenario 1 is the #316 cliff probe: 600 turns, 6,000-token target, default 8-turn tail.',
    '- Scenario 2 scans every file under the data directory, including SQLite, WAL, checkpoint, trace and snapshots.',
    '- Scenario 3 starts the process at 01:00, stops it, restarts at 06:00, then ticks once.',
    '- Scenario 4 seeds one due commitment before each tick; the ticks are 3 minutes apart, so the fixed 2-minute cooldown allows a fourth surfacing today.',
    '- Scenario 6 crosses a real SIGKILL; the fixture opens the assignment and the away queue through the shell\'s own paths.',
    '',
  );
  for (const result of results) {
    lines.push(`### ${result.name} — ${result.pass ? 'PASS' : 'FAIL'} (${(result.durationMs / 1000).toFixed(1)}s)`);
    for (const item of result.metrics) {
      lines.push(`- ${item.key} = ${item.value} (${item.threshold})${item.pass ? '' : ' — FAIL'}`);
      if (item.detail) lines.push(`  - ${item.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const scenarios: Array<[string, () => Promise<Metric[]>]> = [
    ['30-day long session (#316)', longSession],
    ['forget (#332/#331)', forget],
    ['night catch-up (#327)', night],
    ['emergence feedback (#330)', emergence],
    ['budget pause and resume (#228)', budgetPause],
    ['SIGKILL recovery (#331)', killedProcess],
  ];
  const results: ScenarioResult[] = [];
  for (const [name, scenario] of scenarios) {
    process.stderr.write(`[continuity] running ${name}\n`);
    results.push(await runScenario(name, scenario));
  }
  const markdown = renderMarkdown(results);
  const json = {
    head: gitHead(),
    runAt: new Date().toISOString(),
    bun: process.versions.bun,
    platform: process.platform,
    arch: process.arch,
    results,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.md'), markdown);
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(json, null, 2)}\n`);
  console.log(markdown);
  const failed = results.filter((result) => !result.pass);
  process.stderr.write(`[continuity] ${results.length - failed.length}/${results.length} scenarios pass\n`);
  if (failed.length > 0 && !reportOnly) process.exitCode = 1;
}

await main();
