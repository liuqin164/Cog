/**
 * The agent's two channels for self-change: `propose_self_change` records, `apply_self_change`
 * installs what the owner approved.
 *
 * Recording still writes no file and installs nothing. A toxic draft is discarded before it can be
 * shown to anyone; a plugin proposal and a rule learned from the web, email or another person are
 * held behind the existing `ask_user` pause until the owner approves. Applying is a separate call
 * after that approval, and it is the applier (`self-change.ts`) that writes and can roll back.
 */
import type { HygieneOutcome, HygieneOrigin, HygienePipeline, SelfChangeKind } from '../hygiene.ts';
import type { NativePlugin, ToolOutcome } from './host.ts';

interface HygieneHost {
  submit(input: {
    kind: SelfChangeKind;
    origin: HygieneOrigin;
    reason: string;
    files: Array<{ path: string; content: string }>;
    diff: { added: number; removed: number; files: number };
    tests?: { command: string; passed: boolean };
    rollback: string;
  }): HygieneOutcome;
}

interface SelfChangeApplyHost {
  applySelfChange(proposalId: string): { ok: boolean; text: string };
}

function field(args: unknown, key: string): unknown {
  return (args as Record<string, unknown> | undefined)?.[key];
}

function text(args: unknown, key: string): string {
  const value = field(args, key);
  return typeof value === 'string' ? value : '';
}

function requireText(args: unknown, key: string): string {
  const value = text(args, key);
  if (value.trim() === '') throw new Error(`invalid_arguments: "${key}" must be a non-empty string`);
  return value;
}

function filesOf(args: unknown): Array<{ path: string; content: string }> {
  const raw = field(args, 'files');
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('invalid_arguments: "files" must be a non-empty array');
  return raw.map((entry, index) => {
    const path = (entry as Record<string, unknown> | undefined)?.path;
    const content = (entry as Record<string, unknown> | undefined)?.content;
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new Error(`invalid_arguments: files[${index}] must carry string "path" and "content"`);
    }
    return { path, content };
  });
}

function diffOf(args: unknown): { added: number; removed: number; files: number } {
  const raw = field(args, 'diff');
  const record = raw as Record<string, unknown> | undefined;
  const values = [record?.added, record?.removed, record?.files];
  if (!values.every((value) => typeof value === 'number')) {
    throw new Error('invalid_arguments: "diff" must carry numeric "added", "removed" and "files"');
  }
  return { added: values[0] as number, removed: values[1] as number, files: values[2] as number };
}

function testsOf(args: unknown): { command: string; passed: boolean } | undefined {
  const raw = field(args, 'tests');
  if (raw === undefined) return undefined;
  const record = raw as Record<string, unknown> | undefined;
  if (typeof record?.command !== 'string' || typeof record?.passed !== 'boolean') {
    throw new Error('invalid_arguments: "tests" must carry string "command" and boolean "passed"');
  }
  return { command: record.command, passed: record.passed };
}

function outputFor(outcome: HygieneOutcome): ToolOutcome {
  const { proposal } = outcome;
  const findings = proposal.findings.map((finding) => finding.code).join(', ');
  if (proposal.status === 'discarded') {
    return { output: `proposal_discarded: 整份丢弃（${outcome.summary}）；检查结论已留痕（${findings}）。`, isError: true };
  }
  if (proposal.status === 'rejected') {
    return { output: `proposal_rejected: 未进入审查（${outcome.summary}）；检查结论已留痕。`, isError: true };
  }
  if (proposal.status === 'awaiting_owner') {
    const why = proposal.kind === 'plugin'
      ? '安装插件会执行代码，必须等你批准后才会写入并加载'
      : '它来自外部内容，必须等用户批准后才生效';
    const next = proposal.kind === 'plugin' ? '用户批准后用 apply_self_change 应用；被拒绝则不要重试。' : '不要假装它已经生效。';
    return {
      output: `proposal_awaiting_owner: 已记录（${proposal.id}，评分 ${proposal.score}）；${why}。这次 run 会在问题回答处暂停；${next}`,
      isError: false,
    };
  }
  return {
    output: `proposal_hygiene_passed: 已记录（${proposal.id}，评分 ${proposal.score}），检查通过并进入待审；没有安装、没有写入、没有生效。`,
    isError: false,
  };
}

export function hygienePlugin(): NativePlugin {
  return {
    name: 'self-change-hygiene',
    inject: ['hygiene', 'shell'],
    apply(ctx) {
      const hygiene = ctx.getService<HygienePipeline>('hygiene');
      ctx.registerTool({
        name: 'propose_self_change',
        description:
          'Record a self-written skill, plugin or rule proposal for review. The tool only records it: it writes no file, installs nothing, and changes no rule. Code proposals must carry a passed test command, a rollback, and a diff within the small-change cap. Anything containing a secret or hidden character is discarded whole. A rule learned from web, email or another person is held until the user explicitly approves it through the question pause.',
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['skill', 'plugin', 'rule'] },
            origin: { type: 'string', enum: ['self', 'web', 'email', 'message'], description: 'Where the proposal came from; anything but self is external' },
            reason: { type: 'string', description: 'Why this change is proposed, at least 10 characters' },
            files: {
              type: 'array',
              description: 'The complete proposed files; paths relative to the workspace',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
              },
              minItems: 1,
            },
            diff: {
              type: 'object',
              description: 'The change size; the gate rejects anything over the small-change cap',
              properties: {
                added: { type: 'number' }, removed: { type: 'number' }, files: { type: 'number' },
              },
              required: ['added', 'removed', 'files'],
            },
            tests: {
              type: 'object',
              description: 'The test gate that ran and its verdict; required for skill and plugin proposals',
              properties: { command: { type: 'string' }, passed: { type: 'boolean' } },
              required: ['command', 'passed'],
            },
            rollback: { type: 'string', description: 'What undoes this change' },
          },
          required: ['kind', 'origin', 'reason', 'files', 'diff', 'rollback'],
        },
        execute({ args }): ToolOutcome {
          const kind = requireText(args, 'kind') as SelfChangeKind;
          const origin = requireText(args, 'origin') as HygieneOrigin;
          const tests = testsOf(args);
          return outputFor(hygiene.submit({
            kind,
            origin,
            reason: requireText(args, 'reason'),
            files: filesOf(args),
            diff: diffOf(args),
            ...(tests ? { tests } : {}),
            rollback: requireText(args, 'rollback'),
          }));
        },
      });
      const shell = ctx.getService<SelfChangeApplyHost>('shell');
      ctx.registerTool({
        name: 'apply_self_change',
        description:
          'Apply one plugin proposal the owner approved through the question pause. This is the only path that writes self-written code: it snapshots plugins.json and the target files, writes the plugin into the data directory, registers it, and restarts the resident so the next boot can prove the load and roll back on failure. A proposal without an owner approval record is refused; so is anything that is not a plugin. Never call it before the owner has answered.',
        // Applying writes files and triggers a restart; a replay must not install twice.
        replay: 'never',
        parameters: {
          type: 'object',
          properties: {
            proposal_id: { type: 'string', description: 'The proposal id returned by propose_self_change, after the owner approved it' },
          },
          required: ['proposal_id'],
        },
        execute({ args }): ToolOutcome {
          const id = text(args, 'proposal_id').trim();
          if (id === '') throw new Error('invalid_arguments: "proposal_id" must be a non-empty string');
          const result = shell.applySelfChange(id);
          return { output: result.text, isError: !result.ok };
        },
      });
    },
  };
}
