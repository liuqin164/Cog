import { EVAL_T0, check, contains, equal, hasLength, turn } from '../harness.js';
import type { CompanionScenario } from '../types.js';

const T0 = EVAL_T0;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const surfaceScenarios: CompanionScenario[] = [
  {
    id: 'surface-commitment-once',
    category: 'surface',
    title: 'An arrived promise is offered at its due instant and not offered a second time',
    criteria: [
      'C1: the proactive query offers the commitment at the due instant',
      'C2: the next query at the same instant offers it no more',
      'C3: the commitment is still in the book after being spoken',
    ],
    pinned: [
      'the promise turn and due instant are fixed constants',
      'the surfacing decision is F6/F16 deterministic logic, no model',
    ],
    async run({ kernel }) {
      const projectId = 'surface-commitment-once';
      turn(kernel, {
        projectId,
        threadId: 'promise-turn',
        content: '我明天把文件发你。',
        occurredAt: T0,
      });
      kernel.commitments.compile({ projectId, now: T0 + 1_000 });
      const due = kernel.commitments.list({ projectId, now: T0 + 1_000 })[0].dueAt;

      const first = kernel.surfacing.candidates({ projectId, channel: 'proactive', now: due });
      const firstCommitments = first.candidates.filter((candidate: any) => candidate.source === 'commitment');
      hasLength(firstCommitments, 1, 'C1 one commitment candidate');
      contains(firstCommitments[0].content, '文件', 'C1 candidate content');

      const second = kernel.surfacing.candidates({ projectId, channel: 'proactive', now: due + 1 });
      hasLength(second.candidates.filter((candidate: any) => candidate.source === 'commitment'), 0, 'C2 no replay');
      hasLength(kernel.commitments.list({ projectId, now: due + 1 }), 1, 'C3 commitment remains');
    },
  },
  {
    id: 'surface-wake-on-time',
    category: 'surface',
    title: 'A registered wake intention fires at its instant, once, and not before or after',
    criteria: [
      'C1: a tick one millisecond before the instant emits nothing',
      'C2: the tick at the instant fires exactly that intention',
      'C3: later ticks emit nothing and the ledger records one FIRED row',
    ],
    pinned: [
      'all instants are constants; the scenario calls the tick, no timer or sleep',
      'the intention is registered through F2 with a fixed source ref',
    ],
    async run({ kernel }) {
      const projectId = 'surface-wake-on-time';
      const at = T0 + HOUR;
      const intention = kernel.wakeIntentions.register({
        projectId,
        agentId: 'hermes',
        at,
        reason: 'check the deploy',
        sourceRefs: [{ sourceType: 'behavior-eval', sourceId: 'surface-wake-on-time' }],
        now: T0,
      });

      equal(kernel.runWakeTick({ projectId, now: at - 1 }).emitted, 0, 'C1 before the instant');
      const onTime = kernel.runWakeTick({ projectId, now: at });
      hasLength(onTime.firedWakeIntentions, 1, 'C2 one firing');
      equal(onTime.firedWakeIntentions[0].intentionId, intention.intentionId, 'C2 the registered intention');
      equal(kernel.runWakeTick({ projectId, now: at + 1 }).emitted, 0, 'C3 no replay');
      equal(
        kernel.wakeIntentions.audit({ projectId, intentionId: intention.intentionId })
          .filter((row: any) => row.eventType === 'WAKE_INTENTION_FIRED').length,
        1,
        'C3 one FIRED row',
      );
    },
  },
  {
    id: 'surface-task-preference',
    category: 'surface',
    title: 'The second same-domain task assembly carries the learned procedure and the owner preference',
    criteria: [
      'C1: start-of-work assembly includes the compiled procedure with its tools',
      'C2: the assembly also includes the owner preference from the profile ledger',
      'C3: both items can name their sourceRefs',
    ],
    pinned: [
      'the preference is captured through the deterministic ingest path; the task descriptor is pinned',
      'assembly is F15 deterministic projection; no model',
    ],
    async run({ kernel }) {
      const projectId = 'surface-task-preference';
      await kernel.ingest({ projectId, content: '我喜欢在发布前先跑一遍测试。' });
      for (const [index, threadId] of ['task-1', 'task-2'].entries()) {
        kernel.recordTaskEvent({
          projectId,
          threadId,
          role: 'system',
          content: 'task completed',
          occurredAt: T0 + index * 1_000,
          metadata: {
            procedure: {
              domain: '发布',
              key: 'publish',
              title: '发布 npm 包',
              steps: ['跑测试', 'bun run build'],
              tools: ['bun'],
              outcome: 'succeeded',
            },
          },
        });
      }
      kernel.profile.compile({ projectId, now: T0 + 2_000 });
      kernel.procedures.compile({ projectId, now: T0 + 3_000 });

      const assembly = kernel.procedures.assembleTask({ projectId, task: '帮我发布 npm 包', now: T0 + 4_000 });
      const procedure = assembly.items.find((item: any) => item.kind === 'procedure');
      const preference = assembly.items.find((item: any) => item.kind === 'preference');
      check(procedure, 'C1 procedure item');
      contains(procedure.text, 'bun run build', 'C1 procedure steps');
      contains(procedure.text, 'tools: bun', 'C1 procedure tools');
      check(preference, 'C2 preference item');
      contains(preference.text, '发布前先跑一遍测试', 'C2 preference text');
      check(procedure.sourceRefs.length > 0 && preference.sourceRefs.length > 0, 'C3 sourceRefs');
    },
  },
  {
    id: 'surface-prospective-once',
    category: 'surface',
    title: 'A confirmed due reminder announces once and does not replay after a restart',
    criteria: [
      'C1: the first tick at the instant reports the due reminder once',
      'C2: a second tick at the same instant reports nothing',
      'C3: a fresh kernel on the same database reports nothing either',
    ],
    pinned: [
      'request, confirmation and due instants are fixed constants',
      'F18 announce-once state is the ledger row, not a process-local set',
    ],
    async run({ kernel, reopen }) {
      const projectId = 'surface-prospective-once';
      const request = turn(kernel, {
        projectId,
        threadId: 'reminder-thread',
        content: '提醒我检查 CI。',
        occurredAt: T0 - 10 * MINUTE,
      });
      const confirmation = turn(kernel, {
        projectId,
        threadId: 'reminder-thread',
        content: '是的，确认这个提醒。',
        occurredAt: T0 - 9 * MINUTE,
      });
      const dueAt = T0 - MINUTE;
      const candidate = kernel.prospectiveMemoryService.propose({
        projectId,
        candidateType: 'reminder',
        canonicalKey: 'behavior-eval:check-ci',
        title: '检查 CI',
        evidenceEventIds: [request.eventId],
        proposedBy: 'operator',
        dueAt,
      });
      kernel.prospectiveMemoryService.resolve(
        candidate.candidateId,
        { action: 'confirm', confirmationEvidenceEventId: confirmation.eventId },
        projectId,
      );

      const first = kernel.runWakeTick({ projectId, now: T0 });
      equal(first.prospectiveDue.length, 1, 'C1 first tick');
      equal(first.prospectiveDue[0].candidateId, candidate.candidateId, 'C1 candidate');
      equal(kernel.runWakeTick({ projectId, now: T0 }).prospectiveDue.length, 0, 'C2 second tick');

      const restarted = reopen();
      equal(restarted.runWakeTick({ projectId, now: T0 + HOUR }).prospectiveDue.length, 0, 'C3 restart');
      equal(restarted.prospectiveMemoryService.get(candidate.candidateId, projectId)?.status, 'confirmed', 'C3 status');
    },
  },
];
