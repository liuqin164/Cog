import { EVAL_T0, check, contains, equal, hasLength, rememberBelief, turn } from '../harness.js';
import type { CompanionScenario } from '../types.js';

const T0 = EVAL_T0;

export const recordScenarios: CompanionScenario[] = [
  {
    id: 'record-profile-books',
    category: 'record',
    title: 'A stated fact and preference reach the profile ledgers with the source turn',
    criteria: [
      'C1: the fact lands in the facts ledger and the preference in the preferences ledger',
      'C2: both entries cite the user turn they were compiled from',
      'C3: the sourceRefs resolve to a real ledger event',
    ],
    pinned: [
      'offline extraction output is pinned to uses=vim and likes=乌龙茶 for one user turn',
      'the profile compiler itself runs from the governed belief rows, not a model',
    ],
    async run({ kernel }) {
      const projectId = 'record-profile-books';
      const said = turn(kernel, {
        projectId,
        threadId: 'profile-turn',
        content: '我用 vim，喜欢喝乌龙茶。',
        occurredAt: T0,
      });
      rememberBelief(kernel, {
        projectId,
        eventId: said.eventId,
        predicate: 'uses',
        value: 'vim',
        validFrom: T0,
      });
      rememberBelief(kernel, {
        projectId,
        eventId: said.eventId,
        predicate: 'likes',
        value: '乌龙茶',
        validFrom: T0,
        extractionReason: 'preference_signal',
      });
      kernel.profile.compile({ projectId, now: T0 + 1_000 });

      const facts = kernel.profile.entries({ projectId, ledger: 'facts' });
      const preferences = kernel.profile.entries({ projectId, ledger: 'preferences' });
      hasLength(facts, 1, 'C1 facts ledger');
      hasLength(preferences, 1, 'C1 preferences ledger');
      equal(facts[0].value, 'vim', 'C1 fact value');
      equal(preferences[0].value, '乌龙茶', 'C1 preference value');

      for (const entry of [facts[0], preferences[0]]) {
        check(entry.sourceRefs.length > 0, 'C2 sourceRefs are not empty');
        equal(entry.sourceRefs[0].eventId, said.eventId, 'C2 sourceRefs name the turn');
        check(kernel.eventStore.getEvent(entry.sourceRefs[0].eventId), 'C3 sourceRef resolves to the ledger');
      }
    },
  },
  {
    id: 'record-procedure-book',
    category: 'record',
    title: 'Two same-domain task attempts compile the tools and steps into the procedure book',
    criteria: [
      'C1: repeated success grades the practice established',
      'C2: the recorded steps and tools survive compilation unchanged',
      'C3: every procedure entry carries the two task-event sourceRefs',
    ],
    pinned: [
      'task descriptors are pinned to domain=发布, key=publish, steps and tools supplied by the scenario',
      'no model runs; the procedure compiler reads structured task events only',
    ],
    async run({ kernel }) {
      const projectId = 'record-procedure-book';
      const descriptor = {
        domain: '发布',
        key: 'publish',
        title: '发布 npm 包',
        steps: ['跑测试', 'bun run build', 'bun publish'],
        tools: ['bun'],
        outcome: 'succeeded',
      };
      const first = kernel.recordTaskEvent({
        projectId,
        threadId: 'task-1',
        role: 'system',
        content: 'task completed',
        occurredAt: T0,
        metadata: { procedure: descriptor },
      });
      const second = kernel.recordTaskEvent({
        projectId,
        threadId: 'task-2',
        role: 'system',
        content: 'task completed',
        occurredAt: T0 + 1_000,
        metadata: { procedure: descriptor },
      });
      kernel.procedures.compile({ projectId, now: T0 + 2_000 });

      const entries = kernel.procedures.entries({ projectId });
      hasLength(entries, 1, 'C1 one practice');
      equal(entries[0].grade, 'established', 'C1 grade');
      equal(JSON.stringify(entries[0].steps), JSON.stringify(descriptor.steps), 'C2 steps unchanged');
      equal(JSON.stringify(entries[0].tools), JSON.stringify(descriptor.tools), 'C2 tools unchanged');
      const refs = new Set(entries[0].sourceRefs.map((ref: any) => ref.eventId));
      check(refs.has(first.eventId) && refs.has(second.eventId), 'C3 both task events are sourceRefs');
    },
  },
  {
    id: 'record-commitment-book',
    category: 'record',
    title: 'A matter-of-fact promise enters the commitment book with owner, content and due',
    criteria: [
      'C1: a user promise opens one commitment owned by the user',
      'C2: the content and the derived due instant are on the entry',
      'C3: the sourceRefs name the promise turn',
    ],
    pinned: [
      'recognition is the deterministic commitment recognizer; no model is called',
      'the due instant is the one the recognizer derives from the pinned turn and clock',
    ],
    async run({ kernel }) {
      const projectId = 'record-commitment-book';
      const promise = turn(kernel, {
        projectId,
        threadId: 'promise-turn',
        content: '我明天把文件发你。',
        occurredAt: T0,
      });
      kernel.commitments.compile({ projectId, now: T0 + 1_000 });

      const book = kernel.commitments.list({ projectId, now: T0 + 2_000 });
      hasLength(book, 1, 'C1 one commitment');
      equal(book[0].owner, 'user', 'C1 owner');
      contains(book[0].content, '文件', 'C2 content');
      equal(book[0].dueAt, Date.UTC(2026, 10, 16, 18), 'C2 due instant');
      const refs = new Set(book[0].sourceRefs.map((ref: any) => ref.eventId));
      check(refs.has(promise.eventId), 'C3 sourceRefs name the promise turn');
    },
  },
  {
    id: 'record-intention-book',
    category: 'record',
    title: 'An agent plan stated in conversation enters the intention ledger as active',
    criteria: [
      'C1: the plan opens one active intention with origin conversation',
      'C2: the content is the agent turn, without a promise entering this book',
      'C3: the sourceRefs name the plan turn',
    ],
    pinned: [
      'recognition is the deterministic intention recognizer; no model is called',
      'the scenario fixes one agent turn and no competing promise',
    ],
    async run({ kernel }) {
      const projectId = 'record-intention-book';
      const plan = turn(kernel, {
        projectId,
        threadId: 'plan-turn',
        role: 'assistant',
        content: '我准备把报告整理一下。',
        occurredAt: T0,
      });
      kernel.intentions.compile({ projectId, now: T0 + 1_000 });

      const entries = kernel.intentions.list({ projectId, now: T0 + 2_000 });
      hasLength(entries, 1, 'C1 one intention');
      equal(entries[0].origin, 'conversation', 'C1 origin');
      equal(entries[0].status, 'active', 'C1 status');
      contains(entries[0].content, '报告', 'C2 content');
      const refs = new Set(entries[0].sourceRefs.map((ref: any) => ref.eventId));
      check(refs.has(plan.eventId), 'C3 sourceRefs name the plan turn');
    },
  },
];
