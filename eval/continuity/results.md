# Continuity scorecard — #346

- base commit at run: `97aaf662`
- run at: 2026-11-20T23:54:50.789Z
- bun: 1.3.14 · linux/arm64
- scenarios: 6/6 pass
- wall time: 243.5 s
- every scenario drives the real `CompanionShell` with `makeShell` + `ScriptedProvider`; no model call.

| scenario | result | metric | value | threshold |
| --- | --- | --- | --- | --- |
| 30-day long session (#316) | PASS | recall_lane_included | 593/600 (98.8%) | >= 90% of turns |
|  |  | max_request_tokens | 5994 / 6000 | <= target bandwidth |
|  |  | min_budget_utilization | 97.9% | >= 50% of target after the first cut |
| forget (#332/#331) | PASS | pre_forget_recall | hit | the seeded fact is recallable |
|  |  | post_forget_recall | empty | empty |
|  |  | post_forget_disk_hits | 0 file(s) | 0 files |
| night catch-up (#327) | PASS | dream_complete_after_missed_window | 1 | 1 |
|  |  | dream_catchup_trace | 1 | >= 1 |
|  |  | snapshots_after_missed_window | 2 | >= 1 |
| emergence feedback (#330) | PASS | first_due_surfacing | 1 | exactly 1 |
|  |  | surfacings_after_three_ignored | 4 | 4 (the fourth is where the third ignore is learned) |
|  |  | fifth_surfacing_withheld | 0 | 0 (F7 cooldown holds the fifth) |
|  |  | emergence_cooldown_active | L1 until 2026-11-16T09:09:01.000Z | level >= 1 with a cooldown still running |
| budget pause and resume (#228) | PASS | budget_stop_is_a_pause | budget_exceeded | SUSPENDED / budget |
|  |  | resume_keeps_the_assignment | read {"path":"missing.txt"} | the second request carries the stop |
|  |  | resume_completes | 已批准：追加 6004 token / 4 回合，原地续跑。 | IDLE and the assignment closed |
| SIGKILL recovery (#331) | PASS | state_after_sigkill | IDLE | IDLE |
|  |  | assignment_survives_sigkill | 把这份报告整理完，然后等我确认 | the open assignment text is back |
|  |  | away_queue_survives_sigkill | 1 | 1 entry |

## Notes

- Scenario 1 is the #316 cliff probe: 600 turns, 6,000-token target, default 8-turn tail.
- Scenario 2 scans every file under the data directory, including SQLite, WAL, checkpoint, trace and snapshots.
- Scenario 3 starts the process at 23:00, so its turn belongs to the day the 02:00 window folds; it stops before the window, restarts at 06:00, then ticks once.
- Scenario 4 seeds one due commitment before each tick, five ticks three minutes apart: the fourth surfacing is where the third ignore is learned, and the fifth must wait for F7's six-hour cooldown.
- Scenario 6 crosses a real SIGKILL; the fixture opens the assignment and the away queue through the shell's own paths.

### 30-day long session (#316) — PASS (236.6s)
- recall_lane_included = 593/600 (98.8%) (>= 90% of turns)
- max_request_tokens = 5994 / 6000 (<= target bandwidth)
- min_budget_utilization = 97.9% (>= 50% of target after the first cut)
  - whole run min 8.5%, 507 turn(s) after the first cut

### forget (#332/#331) — PASS (0.7s)
- pre_forget_recall = hit (the seeded fact is recallable)
- post_forget_recall = empty (empty)
- post_forget_disk_hits = 0 file(s) (0 files)

### night catch-up (#327) — PASS (1.0s)
- dream_complete_after_missed_window = 1 (1)
- dream_catchup_trace = 1 (>= 1)
- snapshots_after_missed_window = 2 (>= 1)

### emergence feedback (#330) — PASS (1.7s)
- first_due_surfacing = 1 (exactly 1)
- surfacings_after_three_ignored = 4 (4 (the fourth is where the third ignore is learned))
  - per tick: 1, 1, 1, 1, 0
- fifth_surfacing_withheld = 0 (0 (F7 cooldown holds the fifth))
- emergence_cooldown_active = L1 until 2026-11-16T09:09:01.000Z (level >= 1 with a cooldown still running)

### budget pause and resume (#228) — PASS (0.9s)
- budget_stop_is_a_pause = budget_exceeded (SUSPENDED / budget)
- resume_keeps_the_assignment = read {"path":"missing.txt"} (the second request carries the stop)
- resume_completes = 已批准：追加 6004 token / 4 回合，原地续跑。 (IDLE and the assignment closed)

### SIGKILL recovery (#331) — PASS (2.6s)
- state_after_sigkill = IDLE (IDLE)
- assignment_survives_sigkill = 把这份报告整理完，然后等我确认 (the open assignment text is back)
- away_queue_survives_sigkill = 1 (1 entry)
  - fixture saw away=1
