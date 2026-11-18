# 7-day survival run: start script and care notes

**Not started in this round.** Stage-one acceptance is the shell prototype and its kill test; Susan
starts and watches the 7-day run after that, per the #165 dispatch.

## 48-hour precondition gate (#235)

The seven-day run is not the first time this resident meets the clock. Before starting it, leave the
resident running for **48 hours of real use** and pass every check below. The scripted half is
`test/soak-fake-clock.test.ts`: a fake clock drives idle ticks, one user message, a promise expiry and
a mixed sequence, and asserts hard caps on model calls, ledger rows and the user lane. It runs in CI
with the rest of `shell/test`. Its caps are 2 ledger rows per user turn, at most 6 for a due promise,
and 0 for idle ticks. The 48-hour half is the same question against the real trace and ledger.

Use the resident normally across the 48 hours (messages, a promise or two); the checks below are
about what happens between and around those events.

1. **Soak suite green at the deployed commit.** From `shell/`:
   `TMPDIR="$PWD/.cogmem/tmp" bun test test/soak-fake-clock.test.ts`.
   A failing cap is a finding, not a threshold to tune.
2. **No repeated surfacing.** At most 8 `emergence_run` records per Asia/Tokyo day (the shipped
   cap), and no candidate id runs twice:
   `rg '"kind":"emergence_run"' .cogmem-shell/shell-events.jsonl* | jq -r '.id' | sort | uniq -d`
   must print nothing.
3. **No idle ledger growth.** During a quiet 30 minutes — no user message, outside the 02:00–05:00
   dream window — the `memory_events` count must be identical at both ends. Run this at the start
   and end of the window:
   ```sh
   bun -e 'import { Database } from "bun:sqlite"; const db = new Database(".cogmem-shell/memory.sqlite", { readonly: true }); console.log(db.query("select count(*) as n from memory_events").get()); db.close()'
   ```
   The two numbers must match. A row every 30 seconds with no event is the #229 signature.
4. **No autonomous user turn.** The user lane must only hold what the user said:
   ```sh
   bun -e 'import { Database } from "bun:sqlite"; const db = new Database(".cogmem-shell/memory.sqlite", { readonly: true }); console.log(db.query("select count(*) as n from memory_events where role = ? and payload_json like ?").get("user", "%\"origin\":\"emergence\"%")); db.close()'
   ```
   must print `n: 0`.
5. **No abnormal loop in the trace.** Zero `tick_error`, `illegal_transition` or `alarm` records:
   `rg -c '"kind":"(tick_error|illegal_transition|alarm)"' .cogmem-shell/shell-events.jsonl* || true`
   must print nothing.
6. **One process, one RUNNING.** `runtime.lock` names a live pid, and `checkpoint.json` holds a
   single state. A second `start` is refused with `runtime_lock_held`.

Record the six results, the head commit and the 48-hour window on #235 before starting the
seven-day run. Any failure means the seven-day clock has not started.

## Continuity scorecard (#346) vs the 48-hour soak (#235)

The two suites ask different questions and both are needed:

- **#235 / `test/soak-fake-clock.test.ts` is the bounds suite.** It asserts that time does not make
  the resident do more work than the events that arrived: idle ticks start no run, one message
  stays one run, a promise runs once, and the ledger/user lane do not grow. Its failures are caps.
- **#346 / `eval/continuity/run.ts` is the content-quality scorecard.** It asserts that the context
  still carries what the owner needs: the recall lane is present, the budget is used rather than
  collapsed, forget is real on disk, the night catches up, a due promise is not repeated forever,
  a pause resumes the same work, and a kill keeps the open assignment. Its failures are metrics.

The scorecard is not a PR gate yet. Run it with `bun eval/continuity/run.ts` from the repository
root; `--report-only` exits 0 so a baseline can be recorded. Its current red scenarios are the
baseline #316/#327 (plus the measured #330/#331 side findings), not a reason to tune a threshold.

## Start

```sh
cd shell
bun install
./scripts/survival-start.sh          # writes .cogmem-shell/ logs and a pid file
```

The script runs `bun run src/cli.ts start` with `nohup`, keeps stdout/stderr in
`.cogmem-shell/survival.log`, and writes the pid to `.cogmem-shell/survival.pid`.

## Watch

- `tail -f .cogmem-shell/survival.log` — the CLI's own lines.
- `.cogmem-shell/shell-events.jsonl` — every transition, cage violation, capture, dream and
  emergence decision (the state machine's evidence). Watch for `capture_failed` (a turn's ledger
  write failed, with the counts of what was lost) and `agent_end_hook_failed` (the run then ends as
  `run_error` instead of being wedged in RUNNING) — `README.md` has the flush policy.
- `.cogmem-shell/checkpoint.json` — `state`, `activeRunId`, `wakeIntents`, `history`.
- `cat .cogmem-shell/runtime.lock` — the owning pid; a live pid with a second `start` must be
  refused (`runtime_lock_held`).
- Memory curve: `ps -o rss= -p $(cat .cogmem-shell/survival.pid)` once a day.

## Recovery drill (already run once in this round)

```sh
kill -9 $(cat .cogmem-shell/survival.pid)     # while a run is in flight
./scripts/survival-start.sh                   # state returns to IDLE, wake intents survive
```

What to report if the state machine misbehaves: the last `transition` records plus the
`checkpoint.json` at the time — that pair is the whole diagnosis.

## Storage contract (round 14, #165)

The two files under `.cogmem-shell/` are read differently on purpose:

- `checkpoint.json` is **state**: every publish is a temp write + fsync + rename (fsync of the
  directory last), so a kill leaves the previous complete checkpoint or the new one, never a half
  file. One previous generation is kept as `checkpoint.json.prev` (a hard link, so it costs no data
  write). A live file damaged from outside falls back one generation and writes
  `checkpoint_corrupt_recovered` in the trace, keeping the damaged bytes as
  `checkpoint.json.corrupt`; if both generations are unreadable the shell refuses to start
  (`checkpoint_corrupt`, exit 1) with the machine left in DORMANT and no lock held. Deleting
  `checkpoint.json` is still a reset, not a resurrection.
- `shell-events.jsonl` is **evidence**: append-only, not fsynced, and read tolerantly — a malformed
  line is skipped, a torn final line is dropped and terminated, and the damage is written down once
  as a `trace_corrupt` record. A log where nothing parses is moved aside to
  `shell-events.jsonl.corrupt` and a fresh log records the loss.

Sizes measured on this box (round 14): the checkpoint is capped at ~52 KiB (200 history records
plus capped runtime fields) and a save at that cap is ~4 ms; a 10-tool-call run writes ~15
checkpoints and ~1.7 KiB of trace. The trace read is a full re-read (~7 ms/MB) and happens on
attach and `/dream` only.

## What makes the run fail (guidance's first-priority list)

A wrong transition, a lost state, two RUNNING hosts, or a dream colliding with a run.
