import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMemoryKernel, KernelAgentMemoryBackend, type MemoryKernel } from 'cogmem';

import { EventBus } from '../src/bus.ts';
import { RunCage } from '../src/plugins/cage.ts';
import { PluginHost, ToolRegistry } from '../src/plugins/host.ts';
import { WorkflowService, workflowsPlugin } from '../src/plugins/workflows.ts';
import { TraceLog } from '../src/trace.ts';
import { makeShell, makeTempDir, ScriptedProvider } from './helpers.ts';

/**
 * The shell half of #228 item 4: rehearsal has no side effects, the cage still sees every step,
 * execution stops at the first failed step, and a failed workflow falls back to the model.
 */

function registerTools(registry: ToolRegistry, workspaceRoot: string) {
  const calls: string[] = [];
  const writes: string[] = [];
  registry.register({
    name: 'read_file',
    description: 'read',
    parameters: {},
    replay: 'safe',
    rehearse({ args }) {
      return `would read ${String((args as { path?: string }).path)}`;
    },
    execute({ args }) {
      const path = String((args as { path?: string }).path);
      return readFileSync(join(workspaceRoot, path), 'utf8');
    },
  }, { source: 'plugin:test' });
  registry.register({
    name: 'write_file',
    description: 'write',
    parameters: {},
    replay: 'never',
    rehearse({ args }) {
      const input = args as { path?: string; content?: string };
      return `would write ${input.content?.length ?? 0} bytes to ${input.path}`;
    },
    execute({ args }) {
      const input = args as { path?: string; content?: string };
      const path = String(input.path);
      calls.push(`write:${path}`);
      writes.push(path);
      mkdirSync(join(workspaceRoot, path, '..'), { recursive: true });
      writeFileSync(join(workspaceRoot, path), input.content ?? '', 'utf8');
      return `wrote ${path}`;
    },
  }, { source: 'plugin:test' });
  registry.register({
    name: 'echo',
    description: 'echo',
    parameters: {},
    rehearse() {
      return 'would echo';
    },
    execute({ args }) {
      const input = args as { text?: string };
      calls.push(`echo:${input.text ?? ''}`);
      return `echo ${input.text ?? ''}`;
    },
  }, { source: 'plugin:test' });
  registry.register({
    name: 'no_rehearse',
    description: 'no rehearsal half',
    parameters: {},
    execute() {
      calls.push('no_rehearse');
      return 'ran';
    },
  }, { source: 'plugin:test' });
  registry.register({
    name: 'fail',
    description: 'always fails',
    parameters: {},
    rehearse() {
      return 'would fail';
    },
    execute() {
      calls.push('fail');
      return { output: 'boom', isError: true };
    },
  }, { source: 'plugin:test' });
  return { calls, writes };
}

function seedEntry(kernel: MemoryKernel, projectId: string, domain: string, key = 'publish'): string {
  for (let index = 0; index < 5; index += 1) {
    kernel.recordTaskEvent({
      projectId,
      threadId: `seed-${index}`,
      role: 'system',
      content: 'task completed',
      occurredAt: 1_000 + index,
      metadata: {
        procedure: {
          domain,
          key,
          title: `${domain} task`,
          steps: ['run it'],
          tools: ['read'],
          outcome: 'succeeded',
        },
      },
    });
  }
  kernel.procedures.compile({ projectId, now: 2_000 });
  return kernel.procedures.entries({ projectId })[0]!.entryId;
}

function harness(options: { whitelist?: string[] | null; maxTurns?: number } = {}) {
  const dir = makeTempDir();
  const workspaceRoot = join(dir, 'ws');
  mkdirSync(workspaceRoot, { recursive: true });
  const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
  const backend = new KernelAgentMemoryBackend(kernel, { agentId: 'workflow-test-agent' });
  const bus = new EventBus();
  const trace = new TraceLog(join(dir, 'trace'));
  const cage = new RunCage({
    maxTurnsPerRun: options.maxTurns ?? 10,
    maxTokensPerRun: 100_000,
    toolWhitelist: options.whitelist ?? null,
  }, trace);
  cage.register(bus);
  const tools = new ToolRegistry();
  const recorded = registerTools(tools, workspaceRoot);
  const projectId = 'workflow-shell-test';
  const service = new WorkflowService({
    kernel,
    backend,
    bus,
    tools,
    trace,
    projectId,
    sessionId: 'session-test',
    agentId: 'workflow-test-agent',
    workspaceRoot,
    budget: cage,
    now: () => 5_000,
  });
  return { dir, workspaceRoot, kernel, backend, bus, trace, cage, tools, service, projectId, recorded };
}

async function activeWorkflow(h: ReturnType<typeof harness>, steps: unknown[], domain = 'deploy') {
  const entryId = seedEntry(h.kernel, h.projectId, domain);
  h.service.propose(entryId, steps);
  const dryRun = await h.service.dryRun(entryId);
  expect(dryRun.passed).toBe(true);
  return h.service.promote(entryId);
}

describe('rehearsal is a gate with no side effects', () => {
  test('dry-run calls rehearse, never execute', async () => {
    const h = harness();
    try {
      const entryId = seedEntry(h.kernel, h.projectId, 'deploy');
      h.service.propose(entryId, [
        { tool: 'write_file', args: { path: 'out.txt', content: 'hello' }, success: { type: 'not_error' } },
      ]);
      const dryRun = await h.service.dryRun(entryId);
      expect(dryRun.passed).toBe(true);
      expect(dryRun.reason).toBe('rehearsed');
      expect(h.recorded.calls).toEqual([]);
      expect(existsSync(join(h.workspaceRoot, 'out.txt'))).toBe(false);
    } finally {
      h.kernel.close();
    }
  });

  test('a tool without a rehearsal half cannot be promoted', async () => {
    const h = harness();
    try {
      const entryId = seedEntry(h.kernel, h.projectId, 'deploy');
      h.service.propose(entryId, [
        { tool: 'no_rehearse', args: {}, success: { type: 'not_error' } },
      ]);
      const dryRun = await h.service.dryRun(entryId);
      expect(dryRun.passed).toBe(false);
      expect(dryRun.reason).toContain('tool_not_rehearsable');
      await expect(h.service.promote(entryId)).rejects.toThrow('workflow_dry_run_failed');
      expect(h.recorded.calls).toEqual([]);
    } finally {
      h.kernel.close();
    }
  });

  test('an unknown tool is refused in rehearsal', async () => {
    const h = harness();
    try {
      const entryId = seedEntry(h.kernel, h.projectId, 'deploy');
      h.service.propose(entryId, [
        { tool: 'ghost', args: {}, success: { type: 'not_error' } },
      ]);
      const dryRun = await h.service.dryRun(entryId);
      expect(dryRun.passed).toBe(false);
      expect(dryRun.reason).toContain('unknown_tool');
    } finally {
      h.kernel.close();
    }
  });

  test('the cage whitelist sees rehearsal and execution alike', async () => {
    const h = harness({ whitelist: ['read_file'] });
    try {
      const entryId = seedEntry(h.kernel, h.projectId, 'deploy');
      h.service.propose(entryId, [
        { tool: 'write_file', args: { path: 'out.txt', content: 'x' }, success: { type: 'not_error' } },
      ]);
      const dryRun = await h.service.dryRun(entryId);
      expect(dryRun.passed).toBe(false);
      expect(dryRun.reason).toContain('tool_not_in_whitelist');
      expect(existsSync(join(h.workspaceRoot, 'out.txt'))).toBe(false);
    } finally {
      h.kernel.close();
    }
  });
});

describe('an active workflow executes without the model deciding each step', () => {
  test('steps run in order and the execution is recorded as procedure support', async () => {
    const h = harness();
    try {
      writeFileSync(join(h.workspaceRoot, 'in.txt'), 'hello', 'utf8');
      const workflow = await activeWorkflow(h, [
        { tool: 'read_file', args: { path: 'in.txt' }, success: { type: 'not_error' } },
        { tool: 'write_file', args: { path: 'out.txt', content: '{{task}}' }, success: { type: 'not_error' } },
      ]);
      const result = await h.service.execute(workflow, { runId: 'run-1', userText: 'deploy the site' });
      expect(result.ok).toBe(true);
      expect(result.summary.stopReason).toBe('run_complete');
      expect(result.summary.toolResults.map((tool) => tool.toolName)).toEqual(['read_file', 'write_file']);
      expect(readFileSync(join(h.workspaceRoot, 'out.txt'), 'utf8')).toBe('deploy the site');
      const [recorded] = h.kernel.workflows.list({ projectId: h.projectId });
      expect(recorded?.executions).toBe(1);
      expect(recorded?.lastOutcome).toBe('succeeded');
      expect(recorded?.lastExecutionRefs).toHaveLength(1);
      const event = h.kernel.eventStore.getEvent(recorded!.lastExecutionRefs![0]!.eventId!);
      expect(JSON.stringify(event?.payload)).toContain('workflow-execution');
      // The procedure entry is untouched by the execution.
      expect(h.kernel.procedures.entries({ projectId: h.projectId })[0]!.steps).toEqual(['run it']);
    } finally {
      h.kernel.close();
    }
  });

  test('a failed step stops the run and records the failure', async () => {
    const h = harness();
    try {
      const workflow = await activeWorkflow(h, [
        { tool: 'write_file', args: { path: 'a.txt', content: 'a' }, success: { type: 'not_error' } },
        { tool: 'fail', args: {}, success: { type: 'not_error' } },
        { tool: 'write_file', args: { path: 'b.txt', content: 'b' }, success: { type: 'not_error' } },
      ]);
      const result = await h.service.execute(workflow, { runId: 'run-2', userText: 'deploy the site' });
      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe(2);
      expect(result.summary.stopReason).toBe('run_error');
      expect(result.summary.toolResults.map((tool) => tool.toolName)).toEqual(['write_file', 'fail']);
      expect(existsSync(join(h.workspaceRoot, 'a.txt'))).toBe(true);
      expect(existsSync(join(h.workspaceRoot, 'b.txt'))).toBe(false);
      const [recorded] = h.kernel.workflows.list({ projectId: h.projectId });
      expect(recorded?.consecutiveFailures).toBe(1);
      expect(recorded?.lastOutcome).toBe('failed');
    } finally {
      h.kernel.close();
    }
  });

  test('output_contains is checked against the real output', async () => {
    const h = harness();
    try {
      const workflow = await activeWorkflow(h, [
        { tool: 'echo', args: { text: 'hello' }, success: { type: 'output_contains', text: 'world' } },
      ]);
      const missed = await h.service.execute(workflow, { runId: 'run-3', userText: 'deploy the site' });
      expect(missed.ok).toBe(false);
      expect(missed.reason).toContain('output_contains');
    } finally {
      h.kernel.close();
    }
    const h2 = harness();
    try {
      const workflow = await activeWorkflow(h2, [
        { tool: 'echo', args: { text: 'hello' }, success: { type: 'output_contains', text: 'hello' } },
      ]);
      const met = await h2.service.execute(workflow, { runId: 'run-4', userText: 'deploy the site' });
      expect(met.ok).toBe(true);
    } finally {
      h2.kernel.close();
    }
  });

  test('the frozen task and workspace slots resolve', async () => {
    const h = harness();
    try {
      const workflow = await activeWorkflow(h, [
        { tool: 'echo', args: { text: '{{task}}', workspace: '{{workspace}}' }, success: { type: 'not_error' } },
      ]);
      const result = await h.service.execute(workflow, { runId: 'run-5', userText: 'deploy the site' });
      expect(result.ok).toBe(true);
      expect(h.recorded.calls).toContain('echo:deploy the site');
      expect(result.summary.toolCalls[0]!.input).toEqual({ text: 'deploy the site', workspace: h.workspaceRoot });
    } finally {
      h.kernel.close();
    }
  });

  test('the cage turn budget stops the workflow at the next step', async () => {
    const h = harness({ maxTurns: 1 });
    try {
      const workflow = await activeWorkflow(h, [
        { tool: 'echo', args: { text: 'one' }, success: { type: 'not_error' } },
        { tool: 'echo', args: { text: 'two' }, success: { type: 'not_error' } },
      ]);
      const result = await h.service.execute(workflow, { runId: 'run-6', userText: 'deploy the site' });
      expect(result.ok).toBe(false);
      expect(result.summary.stopReason).toBe('budget_exceeded');
      expect(result.failedStep).toBe(2);
      expect(h.recorded.calls).toEqual(['echo:one']);
    } finally {
      h.kernel.close();
    }
  });
});

describe('the tool surface presents, proposes and vetoes', () => {
  test('list_workflows, propose_workflow and veto_workflow are the model-facing face', async () => {
    const dir = makeTempDir();
    const workspaceRoot = join(dir, 'ws');
    mkdirSync(workspaceRoot, { recursive: true });
    const kernel = createMemoryKernel({ dbPath: join(dir, 'memory.db'), projectTimeZone: 'UTC' });
    const backend = new KernelAgentMemoryBackend(kernel, { agentId: 'workflow-test-agent' });
    const trace = new TraceLog(join(dir, 'trace'));
    const cage = new RunCage({ maxTurnsPerRun: 10, maxTokensPerRun: 100_000, toolWhitelist: null }, trace);
    const host = new PluginHost({ trace });
    try {
      cage.register(host.bus);
      host.seedService('kernel', kernel);
      host.seedService('memory', backend);
      host.seedService('eventBus', host.bus);
      host.seedService('trace', trace);
      host.seedService('cage', cage);
      registerTools(host.tools, workspaceRoot);
      const projectId = 'workflow-tool-surface';
      host.register(workflowsPlugin({
        agentId: 'workflow-test-agent',
        projectId,
        sessionId: 'session-test',
        workspaceRoot,
        tools: host.tools,
      }));
      await host.start();
      const entryId = seedEntry(kernel, projectId, 'deploy');
      const listed = await host.tools.invoke('list_workflows', { toolCallId: 'c1', input: {} }, { runId: 'r1' });
      expect(listed.isError).toBe(false);
      expect(listed.output).toContain(entryId);
      expect(listed.output).toContain('established practices');

      const proposed = await host.tools.invoke('propose_workflow', {
        toolCallId: 'c2',
        input: {
          entryId,
          steps: [{ tool: 'read_file', args: { path: 'in.txt' }, success: { type: 'not_error' } }],
        },
      }, { runId: 'r2' });
      expect(proposed.isError).toBe(false);
      expect(proposed.output).toContain('workflow_active');
      expect(kernel.workflows.list({ projectId })[0]?.status).toBe('active');

      kernel.recordRawEvent({ projectId, threadId: 't-owner', role: 'user', content: '这个工作流不要。' });
      const vetoed = await host.tools.invoke('veto_workflow', {
        toolCallId: 'c3',
        input: { entryId, reason: 'owner said no' },
      }, { runId: 'r3' });
      expect(vetoed.isError).toBe(false);
      expect(vetoed.output).toContain('workflow_vetoed');
      expect(kernel.workflows.list({ projectId })[0]?.status).toBe('vetoed');
    } finally {
      await host.stop();
      kernel.close();
    }
  });
});

describe('the app executes an active workflow and falls back on failure', () => {
  test('a matching active workflow runs without calling the model', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'the model should not run', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    writeFileSync(join(shell.config.workspaceRoot, 'README.md'), 'hello', 'utf8');
    const projectId = shell.config.projectId;
    const entryId = seedEntry(shell.kernel, projectId, 'deploy');
    shell.kernel.workflows.propose({
      projectId,
      entryId,
      steps: [{ tool: 'read', args: { path: 'README.md' }, success: { type: 'not_error' } }],
      now: 3_000,
    });
    shell.kernel.workflows.dryRun({ projectId, entryId, passed: true, now: 3_100 });
    shell.kernel.workflows.activate({ projectId, entryId, now: 3_200 });
    await shell.start();
    try {
      const summary = await shell.submit('deploy the site');
      expect(summary!.assistantText).toContain('steps completed');
      expect(provider.calls).toHaveLength(0);
      expect(shell.trace.read().some((entry) => entry.kind === 'workflow_executed')).toBe(true);
    } finally {
      await shell.stop();
    }
  });

  test('a failed workflow stops and hands the task to the model with the failure named', async () => {
    const dir = makeTempDir();
    const provider = new ScriptedProvider([{ text: 'model fallback done', toolCalls: [] }]);
    const shell = makeShell(dir, provider);
    const projectId = shell.config.projectId;
    const entryId = seedEntry(shell.kernel, projectId, 'deploy');
    shell.kernel.workflows.propose({
      projectId,
      entryId,
      steps: [{ tool: 'read', args: { path: 'missing.txt' }, success: { type: 'not_error' } }],
      now: 3_000,
    });
    shell.kernel.workflows.dryRun({ projectId, entryId, passed: true, now: 3_100 });
    shell.kernel.workflows.activate({ projectId, entryId, now: 3_200 });
    await shell.start();
    try {
      const summary = await shell.submit('deploy the site');
      expect(summary!.assistantText).toContain('model fallback done');
      expect(provider.calls).toHaveLength(1);
      const messages = provider.calls[0]!.messages;
      expect(messages.some((message) => message.role === 'system' && message.content.includes('<workflow-fallback>'))).toBe(true);
      expect(messages.some((message) => message.role === 'system' && message.content.includes('missing.txt'))).toBe(true);
      const fallback = shell.trace.read().find((entry) => entry.kind === 'workflow_fallback');
      expect(fallback?.entryId).toBe(entryId);
      const [recorded] = shell.kernel.workflows.list({ projectId });
      expect(recorded?.consecutiveFailures).toBe(1);
      expect(recorded?.status).toBe('active');
    } finally {
      await shell.stop();
    }
  });
});
