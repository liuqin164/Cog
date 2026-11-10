# @cogmem/companion-shell (F11 #165, stage one)

A resident companion shell for Cogmem: a memory-native state machine, a plugin host, and the four
basic tools. The kernel is untouched by this branch; every gap the shell hit is a ticket proposal in
`src/probes/gaps.ts` and on #165.

## Run

```sh
cd shell
bun install
bun run typecheck
bun test test

# one turn against the mg gateway (magpie at 127.0.0.1:3425)
bun run src/cli.ts once "今天过得怎么样？"

# resident (terminal channel + in-process kernel + MCP face on 7338)
bun run src/cli.ts start

# F1/F2/F6 gap list (throwaway in-memory kernel unless --db is passed, so run it freely)
bun run src/cli.ts probe
```

The mg routing group measured ~2.5 minutes for a one-word reply on this box; the live model test is
opt-in (`SHELL_LIVE_MODEL=1 bun test test/mg-live.test.ts`) so the suite stays fast.

Useful flags: `--workspace <dir>`, `--data <dir>`, `--db <file>`, `--project <id>`, `--agent <id>`,
`--tools read,write,edit,bash`, `--turns <n>`, `--tokens <n>`, `--mcp-port <n>`, `--no-mcp`,
`--no-terminal`, `--no-pi`, `--pi-plugin <pkg-or-path>` (repeatable).

## Shape

- `src/state/table.ts` — the declarative transition table, the single source of truth.
- `src/state/machine.ts` — the only writer of the lifecycle; a failed checkpoint write halts.
- `src/state/agent-loop.ts` — Pi's turn loop, event names and hook positions reused verbatim
  (the `prepareRequest` / `finishTurn` / `prepareNextTurn` triad, not the older `shouldStopAfterTurn`).
- `src/state/projection.ts` — the append-only context log and its `context_edit` overlay.
- `src/state/retry.ts` — the failure ladder's classification and backoff, ported from pinned pi-ai.
- `src/plugins/host.ts` — one registry, one bus; native Cordis-style plugins.
- `src/pi/adapter.ts` — the removable Pi compatibility layer.
- `src/plugins/*` — clock, recall, dream, emergence (conservative), cage, capture, the four tools,
  mg provider. Dream, emergence and recall are plugins like the rest: swap one by not loading it.
- `src/channels/terminal.ts` — the self-owned terminal channel.
- `src/probes/gaps.ts` — the F1/F2/F6 (+F-SEC, F-MCP) probe and gap list.

## Failure ladder

A failed model call goes down one ladder, in Pi's fixed order: **context overflow first**, then
**retryability** (account/subscription limits are classified non-retryable and are checked before the
transient table, because they reset in hours and retrying only burns the day), then a **bounded retry**
with exponential backoff capped at 60 s. The pattern tables are ported from pinned
`@earendil-works/pi-ai@1.5.0` (`utils/retry.ts`, `utils/overflow.ts`).

An overflow gets exactly one recovery attempt per run (the **one-shot latch** — read it back in the
trace as `provider_call_failed` with `next: "recover_overflow"`, then `next: "fail"` on the second
overflow); a second overflow is a failure, not a loop. The shell has no compaction subsystem, so
that one attempt is a single re-request rather than a compacted one — the latch is the safety property
that survives compaction landing later.

**Retries are charged to the run, not to the cage.** A retry re-requests the *same* turn, so the turn
counter — and therefore `maxTurnsPerRun` — moves once however many provider calls the turn took. The
discriminating test runs with a one-turn budget and a provider that fails once: the run completes with
`turns: 1`. Everything is legible in the trace as `provider_call_failed` with `kind`, `next`, `attempt`
and `delayMs`.

## Capture and redaction

Every captured text — the user turn, the assistant reply, each `read`/`bash` tool observation and each
terminal record — is redacted with the kernel's own pattern table before it is written, and the event
carries `metadata.secretFindings.total`. The shapes exercised by the tests include connection strings,
whole private-key blocks, bearer headers, assigned keys/passwords and secrets inside multi-line output.

**Flush policy.** Capture buffers the raw event stream and writes it once, on `agent_end`. A failed
write is neither retried nor swallowed: the plugin records `capture_failed` — the run, the turn and the
counts of what was lost — and lets the failure reach the run's boundary, where it becomes
`agent_end_hook_failed` in the trace and `stopReason: run_error` in the summary. The machine still
leaves RUNNING through the legal edge, the channel sees the error, and the account for that turn is
lost loudly. A one-retry version stood here first and was removed: `CODING_STANDARDS.md`'s "not a way to
survive the failure" rejects retry ladders, and a transient ledger error is better reported than
papered over.

**The settled boundary.** `agent_end` is emitted, its awaited handlers finish, and only then
`agent_settled` — the run returns after that, which is the moment the machine leaves RUNNING (Pi's
`agent_settled`, not `agent_end`). A settle handler therefore still sees RUNNING, and an `agent_end`
handler that fails still reaches settled with `stopReason: run_error`.

## Tool-loadout declarations

The transcript says what the model may call. When hot-plugging changes the executable set, the loop
declares the difference to the model before the next request as `toolsAdded` / `toolsRemoved` on a
system message — Pi's `declareToolChanges` — with an empty list omitting its field. The first run sets
the baseline silently; a hot-plug (mid-run or while idle) is what produces a delta. Each declaration
is a `tools_declared` trace record and updates `runtime.declaredTools` in the checkpoint.

**Replay policy.** Every tool declares `replay: 'never' | 'safe'` (Pi's `AgentTool.replay`); the host
defaults anything undeclared to `never`, `read` declares `safe`, and `bash`/`write`/`edit` declare
`never`. The checkpoint records the tool calls a RUNNING run had started but not finished, and on
recovery the shell refuses replay for the `never` ones by name in a `recovery_no_replay` trace. Nothing
replays a tool call today — the policy is what a future recovery would have to obey, and the refusal is
recorded rather than assumed.

**Recovery is strict here.** On start, the checkpoint's declared loadout is compared with the set the
process can actually execute; any difference — a plugin removed, added or failed to load — is a
`tool_set_mismatch` trace and a refused start, not a degraded run. Pi reconciles a transcript loadout
with what registered; the shell deliberately refuses instead, because a transcript naming tools the
process does not have is a lie the model would keep acting on.

## Baseline (measured)

Reproduce with `bun run scripts/measure-baseline.ts` (`--no-mcp` to leave the MCP face out); the
script prints one JSON line, with the terminal and the Pi adapter off like the resident defaults. The
medians below are of eight runs (five for the `--no-mcp` row); the spread is what the same box gave
across three measurement sessions, and a loaded box moves it by tens of milliseconds.

| Measure | Value | Notes |
|---|---|---|
| Process start → IDLE, MCP face on | **432 ms** median (observed 421–465) | measured with `process.uptime()`, so bun's own start-up and the module graph are included |
| Process start → IDLE, `--no-mcp` | 401 ms median (observed 397–422) | the loopback MCP face costs roughly 30 ms of the start |
| `checkpoint.json` at boot (2 transitions) | 999 B | |
| `checkpoint.json` at the history cap (242 transitions, 200 records kept) | 30,999 B | `trimHistory` caps the history, so the file is bounded rather than growing for the run's life |
| Transition write | temp + fsync + rename + directory fsync | the durability the kill-recovery test depends on; ~150 B of JSON rewritten per transition at the cap |

None of these needed fixing: a resident process pays the start once, and the checkpoint is bounded and
human-readable on purpose (`SURVIVAL.md` tells the operator to `cat` it).

`COMPATIBILITY.md` records the pinned Pi version and the real-plugin test set.
`SURVIVAL.md` is the startup script and care notes for the 7-day run (not started in this round).
