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
`--no-terminal`, `--attach`, `--no-pi`, `--pi-plugin <pkg-or-path>` (repeatable).

## `install`: the F21 bootstrap (#203)

`bin/install` is the install guide for a self-owned companion — six steps, text in / text out, no TUI
framework. It is *not* wired into the main tree's `cogmem` bin; that integration is a post-4.2 step.

```sh
bun run bin/install                 # interactive
bun run bin/install --yes           # defaults: mg gateway, system TZ, dream 2:00–5:00
bun run bin/install --uninstall     # stop the service, remove the unit, keep the memory
```

0. **预检** — OS (macOS/Linux only; Windows is refused, its service story is not this round), bun,
   free disk, and whether the MCP port is free. No old-install branch: every version so far has no
   users, so there is one path and no migration.
1. **落位** — install the package deps, create the data directory (`0700`) and `snapshots/` (`0700`),
   initialize an empty kernel through `createMemoryKernel`, and write the default soul.
2. **模型** — pick mg or an OpenAI-compatible endpoint, take the key through a masked prompt, and make
   **one real call** right there. A failure stops the install at this step with a named diagnosis
   (`model_unreachable`, `model_unauthorized`, `model_not_found`, `model_rate_limited`, `model_timeout`,
   …) instead of surfacing after "success". A custom endpoint is saved as a **named route** (name,
   baseUrl, key, model) in `<dataDir>/routes.json` (`0600`) and becomes the active one; mg remains the
   built-in default and is not rewritten.
3. **节律** — time zone, dream window, do-not-disturb window. TZ and the dream window go to the
   resident's env file; the quiet window is recorded (the shell has no silence gate yet — that is F16).
4. **常驻** — register a **user-level** service (`systemd --user` on Linux, launchd agent on macOS; no
   sudo), start it, run the shell-side doctor, and print the star-sea and health addresses.
5. **自检式首醒** — write a probe memory through the resident's own MCP face, restart the process, and
   recall it. Only then does the installer print success; the endpoint is a first `cog` attach.

Each step is idempotent and its completion is written to `<dataDir>/install.json` only after it fully
succeeded, so a re-run resumes at the first unfinished step.

**Soul.** F17's versioned kernel table and star-sea editor have not landed, and this round may not
touch the kernel, so the installer writes the v0 row into a shell-owned `companion_soul` table in the
same database file (`v0`, `supersedes` NULL). `ponytail:` interim — F17 moves it into the kernel. The
default text is `DEFAULT_SOUL` in `src/install/soul.ts`, verbatim; `/soul` in the TUI now reads it back.

**Security posture, printed at install time:** every service face is loopback only; the data and
snapshot directories are `0700`; the model key is taken through masked input and lives only in the
`0600` `<dataDir>/env` file (mg) or the `0600` `<dataDir>/routes.json` (a custom route) — it is never
printed and never enters the trace.

## Model routes (OpenAI protocol)

Beyond the built-in mg gateway, a user can keep named routes: **name, baseUrl, apiKey, model** and
nothing else. They live in `<dataDir>/routes.json` (`0600`), mg is always present as the built-in route
and is never written to that file, and a route whose name is `mg` is refused. The installer's model step
is the entry point for adding one.

In the TUI, `/model` lists the routes with the active one marked and `/model <name>` switches. The
switch moves the live `ModelRouter` — the object the agent loop already calls — so it takes effect on
the next turn: the process is not restarted and the session's checkpoint is not touched. A stored route
switch is remembered for the next process; switching back to mg is not persisted (it is not user
configuration). The route list is also in the attach snapshot and broadcast as `companion_model_routes`.

`src/model/routes.ts` is the store and the redaction helpers; `src/model/router.ts` is the switchable
provider and its plugin face. A URL printed anywhere goes through `redactUrl`, and a provider error body
is redacted with the route's own key before it can reach a trace or a transcript.

A `routes.json` that does not parse does not stop the resident: mg answers, `/model` says what is wrong
(`routes_unreadable` / `routes_schema` / `routes_invalid_entries`), the trace records it, and the next
write moves the unreadable bytes to `routes.json.broken` instead of losing them.

## `cog`: the terminal TUI (F20 #197)

`cog` is the terminal front end. It attaches to a running resident over a Unix socket in the data
directory (`<dataDir>/attach.sock`); if none is running it brings one up detached with `--attach`, then
attaches. The TUI is a separate process on purpose: closing the window, `Ctrl+C` twice, or `/exit` only
detaches, and a crashed view cannot take the companion down — the resident keeps its state, its lock
and its memory.

```sh
cd shell
bun run src/cog.ts              # attach (starting the resident if needed)
bun run src/cog.ts --headless   # start the resident detached and exit, no界面
bun run src/cli.ts start --attach   # an attachable resident, run directly
```

Four sections: a status bar (name · lifecycle in human words · kernel · next wake), the transcript,
the input box (1–8 lines, inner-scrolling), and a footer (context bandwidth gauge · model route ·
today's token cost · workspace). `RUNNING` shows a work indicator with the cage's turn and token bars;
a line sent while working is queued visibly and `Esc` withdraws it. `/` opens the command palette
(`/soul /memory /commitments /status /context /sleep /dream /help /exit`, plus `/model` when more than
one route is configured); attaching while `DREAMING`
shows a sleep screen and any input wakes it through the legal `DREAMING→WAKING` edge. Attaching plays
"你不在时发生了什么" — the dreams, the held emergence candidates and the fulfilled commitments read back
from the ledger, not replayed into the conversation.

The renderer is self-owned (ANSI + differential repaint, no TUI framework): the transcript is
virtualized, so a scroll frame over ten thousand entries costs ~0.07 ms regardless of length.
`NO_COLOR` drops the palette to plain text and `TERM=dumb` degrades the borders and markers to ASCII.

`bun test test/tui-*.test.ts` covers the layout snapshots (`test/snapshots/`, regenerate deliberately
with `COG_UPDATE_SNAPSHOTS=1`), steering, the sleep screen, the attach protocol and the frame-cost
numbers.

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
- `src/model/routes.ts` / `router.ts` — the named-route store (`0600`), the redaction helpers, and the
  switchable provider the resident's `model` service is.
- `src/channels/terminal.ts` — the self-owned terminal channel (line mode, for `--no-terminal`-off residents).
- `src/tui/*` — the `cog` interface: frame/theme, markdown, the view reducer, layout and virtualization,
  the input editor, the palette, and the raw-mode app. Pure `render(view, size, env)` core, so the
  snapshots are text comparisons.
- `src/attach/*` — the resident's control socket and the client `cog` connects with.
- `src/cog.ts` — the `cog` entry point: attach-or-spawn, `--headless`, and the non-TTY line mode.
- `src/presence.ts` — "while you were away", read back from the trace, the runtime and the kernel.
- `src/probes/gaps.ts` — the F1/F2/F6 (+F-SEC, F-MCP) probe and gap list.
- `src/kernel-host.ts` — the loopback MCP face over the in-process kernel. **One `Server` per
  session**: `Protocol.connect` refuses a second transport, and a single shared `Server` answered
  every session after the first with the SDK's *Already connected to a transport* error (fixed this
  round; the face is what the install's first-wake probe drives). It answers `GET /health` (kernel
  status without opening a second kernel, which two-writer discipline forbids) and mounts the
  read-only observatory at `/observatory` when the kernel source is beside it. Plain JSON responses
  (`enableJsonResponse`), so a one-call client reads one object.
- `src/install/*` — the F21 bootstrap: the six-step installer, the versioned soul table, the model
  probe, the systemd/launchd unit renderers, the shell-side doctor, and the minimal MCP client.

## Failure ladder

A failed model call goes down one ladder, in Pi's fixed order: **context overflow first**, then
**retryability** (account/subscription limits are classified non-retryable and are checked before the
transient table, because they reset in hours and retrying only burns the day), then a **bounded retry**
with exponential backoff capped at 60 s. The pattern tables are ported from pinned
`@earendil-works/pi-ai@1.5.0` (`utils/retry.ts`, `utils/overflow.ts`).

An overflow gets exactly one recovery attempt per run (the **one-shot latch** — read it back in the
trace as `provider_call_failed` with `next: "recover_overflow"`, then `next: "fail"` on the second
overflow); a second overflow is a failure, not a loop. The shell has no compaction subsystem, so the
recovery makes the context actually shrink: it drops the oldest live call-plus-results exchange through
the projection (paired, like any omission) and re-requests. With nothing left to drop the overflow
fails as `overflow_recovery_unavailable` rather than re-sending the same bytes. The latch is the safety
property that survives compaction landing later.

**Retries are charged to the run, not to the cage.** A retry re-requests the *same* turn, so the turn
counter — and therefore `maxTurnsPerRun` — moves once however many provider calls the turn took. The
discriminating test runs with a one-turn budget and a provider that fails once: the run completes with
`turns: 1`. Everything is legible in the trace as `provider_call_failed` with `kind`, `next`, `attempt`
and `delayMs`.

**A custom endpoint's classes are named, and the ladder still decides.** `classifyEndpointFailure`
(`src/state/retry.ts`) names what a failure is — `auth` (401/403), `model_not_found` (404),
`rate_limit` (429), `unreachable`, `timeout`, `http` — for the diagnosis that says "check the key" or
"check the model name". It does not replace the ladder: 401/403/404 stay `fatal` (no retry), while a
refused connection and a timeout stay `retryable` with the same capped exponential backoff as any other
transient failure. The route probe uses the same classifier, so the install's wording and the runtime's
behaviour cannot drift apart. (One pattern was added to the ported table: Bun's fetch says "Unable to
connect" for a refused connection, and Pi's table predates that phrasing.)

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
is a `tools_declared` trace record, updates `runtime.declaredTools` in the checkpoint, and is written to
the ledger as a `tool-loadout` task event — the transcript the model was told about, durably, not only
in the run's context.

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
