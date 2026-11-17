/**
 * #267: what one typical attach request carries, split into system prompt, tool schemas and lane
 * content. Same accounting the request path uses (`accountRequest`, chars/4), so the number is the
 * shell's own estimate rather than a second one.
 *
 * Usage: `bun scripts/measure-context-share.ts` (from `shell/`). Not part of the test suite.
 *
 * "Typical attach" is a cold session with three seeded turns and one new user line: enough for the
 * digest/profile/tail lanes to have something to carry. The tool list is the shell's real one —
 * built-in plugins plus the default native set — not a hand-written sample.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionShell } from '../src/app.ts';
import { accountRequest } from '../src/state/context-budget.ts';
import type { ModelCompletionInput, ModelProvider, ModelTurn } from '../src/state/agent-loop.ts';

class ScriptedProvider implements ModelProvider {
  readonly name = 'measure';
  readonly model = 'measure/none';
  readonly calls: ModelCompletionInput[] = [];
  async complete(input: ModelCompletionInput): Promise<ModelTurn> {
    this.calls.push(input);
    return { text: '收到。', toolCalls: [] };
  }
}

const dir = mkdtempSync(join(tmpdir(), 'companion-context-share-'));
const provider = new ScriptedProvider();
const seedTurns = Math.max(3, Math.trunc(Number(process.env.MEASURE_SEED_TURNS ?? 3)));
const shell = new CompanionShell({
  config: {
    workspaceRoot: join(dir, 'ws'),
    dataDir: join(dir, 'data'),
    dbPath: join(dir, 'data', 'memory.sqlite'),
    timeZone: 'UTC',
    projectId: 'context-share',
    agentId: 'cogmem-context-share',
    sessionId: 'context-share',
    terminalEnabled: false,
    http: { enabled: false, port: 0, hostname: '127.0.0.1' },
    plugins: [],
    dream: { runKernelNight: false, maxEpisodes: 5, windowStartHour: 3, windowEndHour: 3 },
  },
  modelProvider: provider,
  tick: false,
});

try {
  await shell.start();
  for (let index = 0; index < seedTurns; index += 1) {
    await shell.backend.rememberTurnWithResult({
      agentId: shell.config.agentId,
      projectId: shell.config.projectId,
      sessionId: shell.config.sessionId,
      turnId: `seed-${index}`,
      userText: `第 ${index} 轮：部署窗口是周二凌晨两点，负责小组是青栎组，变更编号 CHG-${1000 + index}。`,
      assistantText: '记下了。',
      ingestMode: 'immediate_compile',
    });
  }
  await shell.submit('部署窗口还是周二吗？顺便把发布清单列一下。');

  const call = provider.calls.at(-1)!;
  const account = accountRequest({ messages: call.messages, systemPrompt: call.systemPrompt, tools: call.tools });
  const lanes = shell.currentStatus().contextLanes;
  const laneTokens = (lanes?.lanes ?? []).filter((lane) => lane.lane !== 'pinned').reduce((sum, lane) => sum + lane.tokens, 0);
  const pinnedInSystem = (lanes?.lanes ?? []).find((lane) => lane.lane === 'pinned')?.tokens ?? 0;
  const tools = call.tools.length;
  const averageToolTokens = account.toolTokens / Math.max(1, tools);
  // t / (base + t) = 0.15, with base the non-tool part of this request.
  const baseTokens = account.totalTokens - account.toolTokens;
  const toolsFor15Percent = Math.ceil((0.15 * baseTokens / 0.85) / Math.max(1, averageToolTokens));
  console.log(JSON.stringify({
    request: {
      messages: account.messages,
      systemTokens: account.systemTokens,
      toolTokens: account.toolTokens,
      messageTokens: account.messageTokens,
      totalTokens: account.totalTokens,
      toolCount: tools,
      averageToolTokens: Math.round(averageToolTokens),
      laneTokens,
      pinnedInSystem,
    },
    shares: {
      system: account.systemTokens / account.totalTokens,
      tools: account.toolTokens / account.totalTokens,
      messages: account.messageTokens / account.totalTokens,
    },
    toolsFor15Percent,
    toolNames: call.tools.map((tool) => tool.name),
    toolTokensByName: Object.fromEntries(call.tools.map((tool) => [
      tool.name,
      Math.ceil(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length / 4),
    ])),
  }, null, 2));
} finally {
  await shell.stop();
  rmSync(dir, { recursive: true, force: true });
}
