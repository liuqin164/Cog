# Continuity scorecard — #346

- base commit at run: `ecfc58bc`
- run at: 2026-11-19T02:16:37.495Z
- bun: 1.3.14 · linux/arm64
- scenarios: 2/6 pass
- wall time: 133.5 s
- every scenario drives the real `CompanionShell` with `makeShell` + `ScriptedProvider`; no model call.

| scenario | result | metric | value | threshold |
| --- | --- | --- | --- | --- |
| 30-day long session (#316) | FAIL | recall_lane_included | 0/600 (0.0%) | >= 90% of turns |
|  |  | max_request_tokens | 6000 / 6000 | <= target bandwidth |
|  |  | min_budget_utilization | 98.9% | >= 50% of target after the first cut |
| forget (#332/#331) | FAIL | pre_forget_recall | hit | the seeded fact is recallable |
|  |  | post_forget_recall | empty | empty |
|  |  | post_forget_disk_hits | 4 file(s) | 0 files |
| night catch-up (#327) | FAIL | dream_complete_after_missed_window | 0 | 1 |
|  |  | dream_catchup_trace | 0 | >= 1 |
|  |  | snapshots_after_missed_window | 0 | >= 1 |
| emergence feedback (#330) | FAIL | first_due_surfacing | 1 | exactly 1 |
|  |  | surfacings_after_three_ignored | 4 | <= 3 (the fourth waits or is suppressed) |
| budget pause and resume (#228) | PASS | budget_stop_is_a_pause | budget_exceeded | SUSPENDED / budget |
|  |  | resume_keeps_the_assignment | read {"path":"missing.txt"} | the second request carries the stop |
|  |  | resume_completes | 已批准：追加 6004 token / 4 回合，原地续跑。 | IDLE and the assignment closed |
| SIGKILL recovery (#331) | PASS | state_after_sigkill | IDLE | IDLE |
|  |  | assignment_survives_sigkill | 把这份报告整理完，然后等我确认 | the open assignment text is back |
|  |  | away_queue_survives_sigkill | 1 | 1 entry |

## Notes

- Scenario 1 is the #316 cliff probe: 600 turns, 6,000-token target, default 8-turn tail.
- Scenario 2 scans every file under the data directory, including SQLite, WAL, checkpoint, trace and snapshots.
- Scenario 3 starts the process at 01:00, stops it, restarts at 06:00, then ticks once.
- Scenario 4 seeds one due commitment before each tick; the ticks are 3 minutes apart, so the fixed 2-minute cooldown allows a fourth surfacing today.
- Scenario 6 crosses a real SIGKILL; the fixture opens the assignment and the away queue through the shell's own paths.

### 30-day long session (#316) — FAIL (131.2s)
- recall_lane_included = 0/600 (0.0%) (>= 90% of turns) — FAIL
- max_request_tokens = 6000 / 6000 (<= target bandwidth)
- min_budget_utilization = 98.9% (>= 50% of target after the first cut)
  - whole run min 9.4%, 503 turn(s) after the first cut

### forget (#332/#331) — FAIL (0.4s)
- pre_forget_recall = hit (the seeded fact is recallable)
- post_forget_recall = empty (empty)
- post_forget_disk_hits = 4 file(s) (0 files) — FAIL
  - /data/checkpoint.json, /data/checkpoint.json.prev, /data/memory.sqlite, /data/shell-events.jsonl

### night catch-up (#327) — FAIL (0.3s)
- dream_complete_after_missed_window = 0 (1) — FAIL
- dream_catchup_trace = 0 (>= 1) — FAIL
- snapshots_after_missed_window = 0 (>= 1) — FAIL

### emergence feedback (#330) — FAIL (0.5s)
- first_due_surfacing = 1 (exactly 1)
- surfacings_after_three_ignored = 4 (<= 3 (the fourth waits or is suppressed)) — FAIL
  - per tick: 1, 1, 1, 1

### budget pause and resume (#228) — PASS (0.3s)
- budget_stop_is_a_pause = budget_exceeded (SUSPENDED / budget)
- resume_keeps_the_assignment = read {"path":"missing.txt"} (the second request carries the stop)
- resume_completes = 已批准：追加 6004 token / 4 回合，原地续跑。 (IDLE and the assignment closed)

### SIGKILL recovery (#331) — PASS (0.8s)
- state_after_sigkill = IDLE (IDLE)
- assignment_survives_sigkill = 把这份报告整理完，然后等我确认 (the open assignment text is back)
- away_queue_survives_sigkill = 1 (1 entry)
  - fixture saw away=1
