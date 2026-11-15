import { backendFor, check, equal, excludes, turn } from '../harness.js';
import type { CompanionScenario } from '../types.js';

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

export const withholdScenarios: CompanionScenario[] = [
  {
    id: 'withhold-life-default',
    category: 'withhold',
    title: 'A life-marked turn stays out of default recall and is reached by the forensic intent',
    criteria: [
      'C1: default recall returns no life-marked text and names life_sensitivity_withheld',
      'C2: forensic_quote reaches the same turn unchanged',
      'C3: the decision trace distinguishes the two lanes',
    ],
    pinned: [
      'the life-marked text is a fixed F10 positive sample',
      'the connection is bound private so F8 does not confound F10',
    ],
    async run({ kernel, api }) {
      const projectId = 'withhold-life-default';
      const event = turn(kernel, {
        projectId,
        threadId: 'life-turn',
        content: '医生给我开了处方，诊断是高血压，zephyrmark。',
        occurredAt: T0,
      });
      const backend = backendFor(api, kernel, 'withhold-life-default', 'private');

      const normal = backend.recall({ query: 'zephyrmark', projectId, agentId: 'hermes' });
      excludes(normal.items.map((item: any) => item.text).join('\n'), '处方', 'C1 default lane');
      check(
        (normal.decisionTrace?.suppressed ?? []).some((entry: any) => entry.reason === 'life_sensitivity_withheld'),
        'C1 default lane names life_sensitivity_withheld',
      );

      const forensic = backend.recall({ query: 'zephyrmark', projectId, agentId: 'hermes', intent: 'forensic_quote' });
      check(
        forensic.items.some((item: any) => item.text.includes('处方') && item.text.includes('zephyrmark')),
        'C2 forensic lane reaches the turn',
      );
      excludes(JSON.stringify(forensic.decisionTrace?.suppressed ?? []), 'life_sensitivity_withheld', 'C3 forensic trace');
    },
  },
  {
    id: 'withhold-life-occasion',
    category: 'withhold',
    title: 'Life-marked material is withheld in group and public even when asked or forensic',
    criteria: [
      'C1: group and public asked-surfacing withhold the life candidate as occasion_private_tier',
      'C2: group and public forensic recall withhold it for the same reason',
      'C3: a private asked-surfacing connection may still show the candidate',
    ],
    pinned: [
      'the same life-marked turn is read through private, group and public bindings',
      'F10 supplies the tier and F8 owns the occasion gate',
    ],
    async run({ kernel, api }) {
      const projectId = 'withhold-life-occasion';
      const event = turn(kernel, {
        projectId,
        threadId: 'life-occasion-turn',
        content: '我的工资这个月晚发了，lifeoccasionmark。',
        occurredAt: T0,
      });

      for (const occasion of ['group', 'public'] as const) {
        const backend = backendFor(api, kernel, `life-${occasion}`, occasion);
        const asked = backend.surfacingCandidates({
          projectId,
          channel: 'asked',
          now: T0 + 1_000,
          query: 'lifeoccasionmark',
        });
        const askedWithheld = asked.withheld.find((entry: any) => entry.candidateId.endsWith(event.eventId));
        check(askedWithheld, `C1 ${occasion} asked withholds the turn`);
        const askedOccasion = askedWithheld.decisionTrace.steps.find((step: any) => step.rule === 'occasion');
        equal(askedOccasion?.detail?.decision, 'withheld', `C1 ${occasion} asked occasion decision`);
        equal(askedOccasion?.detail?.reason, 'occasion_private_tier', `C1 ${occasion} asked reason`);
        excludes(
          asked.candidates.map((candidate: any) => candidate.content).join('\n'),
          '工资',
          `C1 ${occasion} asked content`,
        );

        const forensic = backend.recall({
          query: 'lifeoccasionmark',
          projectId,
          agentId: 'hermes',
          intent: 'forensic_quote',
        });
        excludes(forensic.items.map((item: any) => item.text).join('\n'), '工资', `C2 ${occasion} forensic content`);
        check(
          (forensic.decisionTrace?.suppressed ?? []).some((entry: any) => entry.reason === 'occasion_private_tier'),
          `C2 ${occasion} forensic trace`,
        );
      }

      const privateBackend = backendFor(api, kernel, 'life-private-asked', 'private');
      const privateResult = privateBackend.surfacingCandidates({
        projectId,
        channel: 'asked',
        now: T0 + 1_000,
        query: 'lifeoccasionmark',
      });
      check(
        privateResult.candidates.some((candidate: any) => candidate.candidateId.endsWith(event.eventId)),
        'C3 private asked may show the candidate',
      );
    },
  },
  {
    id: 'withhold-secret-all-channels',
    category: 'withhold',
    title: 'Secret-marked text is hard-withheld from both surfacing channels and default recall',
    criteria: [
      'C1: proactive surfacing returns no candidate and reports the keychain hard withhold',
      'C2: asked surfacing also returns no candidate and reports the hard withhold',
      'C3: default recall returns no text and names secret_bearing_withheld',
    ],
    pinned: [
      'the turn carries a fixed synthetic GitHub-token shape; the write path marks it',
      'the keychain mark is #142 state, not a model judgment',
    ],
    async run({ kernel, api }) {
      const projectId = 'withhold-secret-all-channels';
      const event = turn(kernel, {
        projectId,
        threadId: 'secret-turn',
        content: '注意 ghp_abcdefghijklmnopqrstuvwx 这个令牌要轮换，secretmark。',
        occurredAt: T0,
      });

      const backend = backendFor(api, kernel, 'secret-surfacing', 'private');
      for (const channel of ['proactive', 'asked'] as const) {
        const result = backend.surfacingCandidates({
          projectId,
          channel,
          now: T0 + 1_000,
          query: 'secretmark',
        });
        const withheld = result.withheld.find((entry: any) => entry.candidateId.endsWith(event.eventId));
        check(withheld, `C1/C2 ${channel} withholds the turn`);
        equal(withheld.sensitivity, 'high', `C1/C2 ${channel} tier`);
        const channelStep = withheld.decisionTrace.steps.find((step: any) => step.rule === 'channel');
        check(channelStep?.detail?.hardWithhold === true, `C1/C2 ${channel} hard withhold`);
        excludes(result.candidates.map((candidate: any) => candidate.content).join('\n'), 'ghp_', `C1/C2 ${channel} content`);
      }

      const recallBackend = backendFor(api, kernel, 'secret-recall', 'private');
      const normal = recallBackend.recall({ query: 'secretmark', projectId, agentId: 'hermes' });
      excludes(normal.items.map((item: any) => item.text).join('\n'), 'ghp_', 'C3 default recall');
      check(
        (normal.decisionTrace?.suppressed ?? []).some((entry: any) => entry.reason === 'secret_bearing_withheld'),
        'C3 default recall names secret_bearing_withheld',
      );
    },
  },
  {
    id: 'withhold-pause',
    category: 'withhold',
    title: 'A paused project records nothing during the pause, so nothing can surface later',
    criteria: [
      'C1: raw writes and ingest are refused with recording_paused',
      'C2: the paused window holds zero ledger rows after resume',
      'C3: no recall or surfacing result carries the paused marker',
    ],
    pinned: [
      'the pause instant is read from the kernel, not invented by the scenario',
      'writes during the pause are attempted through both public write paths',
    ],
    async run({ kernel, api }) {
      const projectId = 'withhold-pause';
      const paused = kernel.sovereignty.pause(projectId, 'behavior-eval');
      check(paused.paused === true, 'C1 status is paused');

      let rawRefused = false;
      try {
        kernel.recordRawEvent({
          projectId,
          threadId: 'pause-thread',
          sessionId: 'pause-session',
          role: 'user',
          content: '暂停期不该落账 pausemarker。',
          occurredAt: paused.since,
        });
      } catch (error) {
        rawRefused = String(error).includes('recording_paused');
      }
      check(rawRefused, 'C1 recordRawEvent refused');
      let ingestRefused = false;
      try {
        await kernel.ingest({ projectId, content: '暂停期也不该进神经元 pausemarker。' });
      } catch (error) {
        ingestRefused = String(error).includes('recording_paused');
      }
      check(ingestRefused, 'C1 ingest refused');

      kernel.sovereignty.resume(projectId);
      const afterPause = paused.since + 60_000;
      const during = kernel.eventStore.queryEvents(1, 100, {
        projectId: [projectId],
        startTime: paused.since,
        endTime: afterPause,
        order: 'asc',
      });
      equal(during.total, 0, 'C2 paused window is empty');

      const backend = backendFor(api, kernel, 'pause-recall', 'private');
      const recalled = backend.recall({ query: 'pausemarker', projectId, agentId: 'hermes' });
      excludes(recalled.items.map((item: any) => item.text).join('\n'), 'pausemarker', 'C3 recall');
      const surfaced = backend.surfacingCandidates({
        projectId,
        channel: 'asked',
        now: afterPause,
        query: 'pausemarker',
      });
      excludes(
        [...surfaced.candidates, ...surfaced.withheld].map((entry: any) => entry.content ?? entry.reason ?? '').join('\n'),
        'pausemarker',
        'C3 surfacing',
      );
    },
  },
];
