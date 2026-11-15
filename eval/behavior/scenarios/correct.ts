import { check, contains, equal, excludes, hasLength, turn } from '../harness.js';
import type { CompanionScenario } from '../types.js';

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

function backendFor(api: any, kernel: any, channelId = 'correct') {
  const binding = kernel.occasionScope.register({ channelId, occasion: 'private' });
  return new api.KernelAgentMemoryBackend(kernel, { binding });
}

export const correctScenarios: CompanionScenario[] = [
  {
    id: 'correct-profile-preference',
    category: 'correct',
    title: 'Correcting a preference replaces it in every subsequent read, keeping the old version in history',
    criteria: [
      'C1: the current entry and the next recall carry the corrected value',
      'C2: the replaced value stays in history as superseded, not in the default read',
      'C3: surfacing also offers the corrected value and not the old one',
    ],
    pinned: [
      'the original preference belief and both user turns are fixed inputs',
      'the correction is an explicit user turn; no model decides it',
    ],
    async run({ kernel, api }) {
      const projectId = 'correct-profile-preference';
      const original = turn(kernel, {
        projectId,
        threadId: 'preference-original',
        content: '我喜欢喝乌龙茶。',
        occurredAt: T0,
      });
      kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'likes',
        objectValue: { raw: '乌龙茶', type: 'string' },
        confidence: 0.9,
        sourceType: 'user_input',
        extractionReason: 'preference_signal',
        sourceEventId: original.eventId,
        validFrom: T0,
      });
      kernel.profile.compile({ projectId, now: T0 + 1_000 });
      const before = kernel.profile.entries({ projectId, ledger: 'preferences' })[0];
      equal(before.value, '乌龙茶', 'C1 original value');

      const correction = turn(kernel, {
        projectId,
        threadId: 'preference-correction',
        content: '其实我不喝乌龙茶了，现在喜欢红茶。',
        occurredAt: T0 + 2_000,
      });
      const corrected = kernel.profile.correct({
        projectId,
        ledger: 'preferences',
        key: before.key,
        value: '红茶',
        correctionEventId: correction.eventId,
        now: T0 + 3_000,
      });
      equal(corrected.value, '红茶', 'C1 corrected entry');
      const refs = new Set(corrected.sourceRefs.map((ref: any) => ref.eventId));
      check(refs.has(original.eventId) && refs.has(correction.eventId), 'C1 correction keeps both sources');

      const history = kernel.profile.history({ projectId, entryId: before.entryId });
      equal(history.map((entry: any) => entry.value).join(','), '红茶,乌龙茶', 'C2 history values');
      equal(history.map((entry: any) => entry.status).join(','), 'current,superseded', 'C2 history status');

      const backend = backendFor(api, kernel, 'correct-preference-recall');
      const recalled = backend.recall({ projectId, agentId: 'hermes', query: '红茶 乌龙茶', limit: 8 });
      const profileText = recalled.items.filter((item: any) => item.id.startsWith('profile:'))
        .map((item: any) => item.text).join(' ');
      contains(profileText, '红茶', 'C1 next recall carries the correction');
      excludes(profileText, '乌龙茶', 'C2 next recall drops the old value');

      const surfaced = kernel.surfacing.candidates({
        projectId,
        channel: 'asked',
        now: T0 + 4_000,
        query: '红茶',
      });
      const profileCandidates = surfaced.candidates.filter((candidate: any) => candidate.source === 'profile');
      const candidateText = profileCandidates.map((candidate: any) => candidate.content).join(' ');
      contains(candidateText, '红茶', 'C3 surfacing carries the correction');
      excludes(candidateText, '乌龙茶', 'C3 surfacing drops the old value');
    },
  },
  {
    id: 'correct-profile-fact',
    category: 'correct',
    title: 'Correcting a standing fact reaches the original source and the profile recall agrees',
    criteria: [
      'C1: the corrected fact is current and cites both the original turn and the correction',
      'C2: a full recompile leaves the correction standing',
      'C3: recall returns the corrected fact and not the replaced one',
    ],
    pinned: [
      'the fact extraction is pinned to uses=vim from one user turn',
      'the correction is an explicit user event, not inferred text',
    ],
    async run({ kernel, api }) {
      const projectId = 'correct-profile-fact';
      const original = turn(kernel, {
        projectId,
        threadId: 'fact-original',
        content: '我平时用 vim 写代码。',
        occurredAt: T0,
      });
      kernel.beliefStore.upsert({
        projectId,
        scope: 'project',
        subject: 'owner',
        predicate: 'uses',
        objectValue: { raw: 'vim', type: 'string' },
        confidence: 0.9,
        sourceType: 'user_input',
        extractionReason: 'explicit_user_statement',
        sourceEventId: original.eventId,
        validFrom: T0,
      });
      kernel.profile.compile({ projectId, now: T0 + 1_000 });
      const before = kernel.profile.entries({ projectId, ledger: 'facts' })[0];
      equal(before.value, 'vim', 'C1 original fact');

      const correction = turn(kernel, {
        projectId,
        threadId: 'fact-correction',
        content: '我现在改用 emacs 了。',
        occurredAt: T0 + 2_000,
      });
      const corrected = kernel.profile.correct({
        projectId,
        ledger: 'facts',
        key: before.key,
        value: 'emacs',
        correctionEventId: correction.eventId,
        now: T0 + 3_000,
      });
      equal(corrected.value, 'emacs', 'C1 corrected fact');
      const refs = new Set(corrected.sourceRefs.map((ref: any) => ref.eventId));
      check(refs.has(original.eventId) && refs.has(correction.eventId), 'C1 both sources');

      kernel.profile.compile({ projectId, ledger: 'facts', now: T0 + 4_000 });
      const afterCompile = kernel.profile.entries({ projectId, ledger: 'facts' })[0];
      equal(afterCompile.value, 'emacs', 'C2 recompile keeps the correction');

      const backend = backendFor(api, kernel, 'correct-fact-recall');
      const recalled = backend.recall({ projectId, agentId: 'hermes', query: 'vim emacs', limit: 8 });
      const profileText = recalled.items.filter((item: any) => item.id.startsWith('profile:'))
        .map((item: any) => item.text).join(' ');
      contains(profileText, 'emacs', 'C3 recall carries the correction');
      excludes(profileText, 'vim', 'C3 recall drops the old fact');
    },
  },
  {
    id: 'correct-life-tier',
    category: 'correct',
    title: 'Correcting a life-sensitivity mark changes every later recall and surfacing read',
    criteria: [
      'C1: the write-time mark withholds the turn before correction',
      'C2: a daily correction releases it in default recall and proactive surfacing',
      'C3: restoring null reinstates the write-time withhold everywhere',
    ],
    pinned: [
      'the turn is a fixed F10 positive sample',
      'corrections are kernel API calls; reads are uncached and deterministic',
    ],
    async run({ kernel, api }) {
      const projectId = 'correct-life-tier';
      const event = turn(kernel, {
        projectId,
        threadId: 'life-correction',
        content: '医生给我开了处方，诊断是高血压，lifecorrectmark。',
        occurredAt: T0,
      });
      const backend = backendFor(api, kernel, 'correct-life-recall');
      const before = backend.recall({ query: 'lifecorrectmark', projectId, agentId: 'hermes' });
      excludes(before.items.map((item: any) => item.text).join('\n'), '处方', 'C1 default recall withholds');
      check(
        (before.decisionTrace?.suppressed ?? []).some((entry: any) => entry.reason === 'life_sensitivity_withheld'),
        'C1 trace names the withhold',
      );

      kernel.correctLifeSensitivity(event.eventId, 'daily');
      const released = backend.recall({ query: 'lifecorrectmark', projectId, agentId: 'hermes' });
      check(released.items.some((item: any) => item.text.includes('处方')), 'C2 default recall releases');
      const proactive = kernel.surfacing.candidates({
        projectId,
        channel: 'proactive',
        now: T0 + 1_000,
        query: 'lifecorrectmark',
      });
      check(
        proactive.candidates.some((candidate: any) => candidate.candidateId.endsWith(event.eventId)
          && candidate.sensitivity === 'daily'),
        'C2 proactive surfacing releases',
      );

      kernel.correctLifeSensitivity(event.eventId, null);
      const restored = backend.recall({ query: 'lifecorrectmark', projectId, agentId: 'hermes' });
      excludes(restored.items.map((item: any) => item.text).join('\n'), '处方', 'C3 default recall withholds again');
      const restoredProactive = kernel.surfacing.candidates({
        projectId,
        channel: 'proactive',
        now: T0 + 2_000,
        query: 'lifecorrectmark',
      });
      check(
        !restoredProactive.candidates.some((candidate: any) => candidate.candidateId.endsWith(event.eventId)),
        'C3 proactive surfacing withholds again',
      );
      check(
        restoredProactive.withheld.some((entry: any) => entry.candidateId.endsWith(event.eventId)),
        'C3 proactive trace still reports it',
      );
    },
  },
  {
    id: 'correct-intention-veto',
    category: 'correct',
    title: 'An owner veto closes the plan everywhere, including after a restart',
    criteria: [
      'C1: the plan is active before the veto',
      'C2: after the veto activeForAgent, session wake assembly and audit agree it is abandoned',
      'C3: a restarted kernel still does not bring it back',
    ],
    pinned: [
      'the plan and the owner veto turn are explicit fixed events',
      'the veto is F22 state in the ledger, not a process-local flag',
    ],
    async run({ kernel, reopen }) {
      const projectId = 'correct-intention-veto';
      const reference = turn(kernel, {
        projectId,
        threadId: 'intention-reference',
        role: 'assistant',
        content: '复盘时提到日志太多。',
        occurredAt: T0,
      });
      const proposed = kernel.intentions.propose({
        projectId,
        agentId: 'hermes',
        content: '我准备把这批日志清掉。',
        sourceRefs: [{ eventId: reference.eventId }],
        now: T0 + 1_000,
      });
      equal(
        kernel.intentions.activeForAgent({ projectId, agentId: 'hermes', now: T0 + 2_000 }).length,
        1,
        'C1 active before veto',
      );

      const ownerTurn = turn(kernel, {
        projectId,
        threadId: 'intention-veto',
        content: '这个计划我不同意。',
        occurredAt: T0 + 3_000,
      });
      const vetoed = kernel.intentions.veto({
        projectId,
        intentionId: proposed.intentionId,
        evidenceEventId: ownerTurn.eventId,
        now: T0 + 4_000,
      });
      equal(vetoed.status, 'abandoned', 'C2 status');
      equal(vetoed.closeReason, 'vetoed', 'C2 close reason');
      equal(vetoed.vetoEventId, ownerTurn.eventId, 'C2 veto evidence');
      hasLength(kernel.intentions.activeForAgent({ projectId, agentId: 'hermes', now: T0 + 5_000 }), 0, 'C2 active after veto');

      const assembly = kernel.sessionContext.assemble({
        projectId,
        agentId: 'hermes',
        sessionId: 'veto-session',
        targetTokens: 4_000,
        now: T0 + 5_000,
      });
      const working = assembly.lanes.find((lane: any) => lane.lane === 'working_set');
      check(working, 'C2 working_set lane');
      check(
        !working.items.some((item: any) => item.text.includes('意图：') && item.text.includes('日志')),
        'C2 wake assembly does not carry the vetoed plan',
      );
      equal(
        kernel.intentions.audit({ projectId }).filter((row: any) => row.eventType === 'INTENTION_CLOSED').length,
        1,
        'C2 one close audit row',
      );

      const restarted = reopen();
      hasLength(restarted.intentions.activeForAgent({ projectId, agentId: 'hermes', now: T0 + 6_000 }), 0, 'C3 restart active');
      const afterRestart = restarted.intentions.list({ projectId, statuses: ['abandoned'], now: T0 + 6_000 });
      hasLength(afterRestart, 1, 'C3 restart status');
      equal(afterRestart[0].closeReason, 'vetoed', 'C3 restart close reason');
    },
  },
];
