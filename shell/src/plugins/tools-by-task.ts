/**
 * Mount optional tool schemas only for the task that needs them (#267).
 *
 * The shell's four basic tools and the interaction tools the system prompt names are always
 * declared. Three groups are not: web, workflows, and self-change. They are the expensive schemas
 * (self-change alone is ~900 tokens) and most turns never call them, so a request carries them only
 * when the newest user line, the open assignment, or a recent call names that work.
 *
 * No state is added: the set is recomputed from the messages at every request. The agent loop's
 * existing `toolsAdded` / `toolsRemoved` declaration turns a change into one system line, so the
 * model is told what it may call rather than discovering it by failure. A tool outside these three
 * groups is never hidden — a third-party plugin keeps its schema.
 */
import type { AgentMessage } from '../state/agent-loop.ts';
import type { NativePlugin } from './host.ts';

/** Always declared: basics, plus the tools the pinned prompt instructs the model to use. */
const ALWAYS = new Set(['read', 'write', 'edit', 'bash', 'propose_command', 'ask_user', 'declare_task']);

interface OptionalGroup {
  name: string;
  tools: readonly string[];
  cue: RegExp;
}

const GROUPS: readonly OptionalGroup[] = [
  {
    name: 'web',
    tools: ['web_search', 'web_fetch', 'web_recall'],
    cue: /搜索|网页|联网|上网|最新消息|新闻|\b(?:web|search|online|http|url)\b/iu,
  },
  {
    name: 'workflows',
    tools: ['list_workflows', 'propose_workflow', 'veto_workflow'],
    cue: /工作流|workflow|编排|多步|自动运行|定时任务/iu,
  },
  {
    name: 'self-change',
    tools: ['propose_self_change', 'apply_self_change', 'propose_soul_edit'],
    cue: /(?:安装|卸载|升级).{0,8}(?:插件|plugin)|(?:插件|plugin).{0,8}(?:安装|卸载)|self-change|改自己|灵魂|人格|\bsoul\b/iu,
  },
];

export function selectToolNames(all: readonly string[], text: string, used: ReadonlySet<string>): string[] {
  const mounted = new Set(ALWAYS);
  for (const group of GROUPS) {
    if (used.has(group.name) || group.cue.test(text)) for (const tool of group.tools) mounted.add(tool);
  }
  return all.filter((name) => mounted.has(name) || !GROUPS.some((group) => group.tools.includes(name)));
}

interface PreparedRequest {
  tools?: Array<{ name: string }>;
  messages?: AgentMessage[];
  systemPrompt?: string;
  [key: string]: unknown;
}

function taskText(request: PreparedRequest): string {
  const messages = request.messages ?? [];
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const assignment = /<open-assignment>([\s\S]*?)<\/open-assignment>/u.exec(request.systemPrompt ?? '')?.[1] ?? '';
  return `${lastUser}\n${assignment}`;
}

function usedGroups(messages: readonly AgentMessage[]): Set<string> {
  const used = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      for (const group of GROUPS) if (group.tools.includes(call.toolName)) used.add(group.name);
    }
  }
  return used;
}

export function toolsByTaskPlugin(): NativePlugin {
  return {
    name: 'tools-by-task',
    inject: ['eventBus'],
    apply(ctx) {
      ctx.on('prepareRequest', (value: unknown) => {
        if (!value || typeof value !== 'object') return value;
        const request = value as PreparedRequest;
        if (!Array.isArray(request.tools)) return value;
        const names = selectToolNames(request.tools.map((tool) => tool.name), taskText(request), usedGroups(request.messages ?? []));
        const keep = new Set(names);
        return { ...request, tools: request.tools.filter((tool) => keep.has(tool.name)) };
      });
    },
  };
}
