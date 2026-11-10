# 7-day survival run: start script and care notes

**Not started in this round.** Stage-one acceptance is the shell prototype and its kill test; Susan
starts and watches the 7-day run after that, per the #165 dispatch.

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
  emergence decision (the state machine's evidence).
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

## What makes the run fail (guidance's first-priority list)

A wrong transition, a lost state, two RUNNING hosts, or a dream colliding with a run.
