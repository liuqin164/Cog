# @cogmem/companion-shell (F11 #165, stage one)

A resident companion shell for Cogmem: a memory-native state machine, a plugin host, and the four
basic tools. It lives in the main tree as a private, unpublished package — `files` in the root
`package.json` does not list `shell/`, so it is not in the npm tarball — and every gap it hit is a
ticket proposal in `src/probes/gaps.ts` and on #165. The kernel takes zero diff from it: the shell
reaches the kernel through this directory's own `tsconfig.json` paths (`cogmem` → `../src/public.ts`,
`cogmem/internal` → `../src/internal.ts`).

## Run

Run these from inside the checkout, after `bun install` at the root: the shell resolves `cogmem` to
the kernel source beside it, not to an installed package. The root CI runs the last two as their own
gate (`.github/workflows/ci.yml`), because `prepublishOnly` never sees this directory.

```sh
cd shell
bun install
bun run typecheck
bun test test

# one turn against the mg gateway (magpie at 127.0.0.1:3425)
bun run src/cli.ts once "今天过得怎么样？"

# resident (terminal channel + in-process kernel + loopback HTTP face on 7338)
bun run src/cli.ts start

# F1/F2/F6 gap list (throwaway in-memory kernel unless --db is passed, so run it freely)
bun run src/cli.ts probe
```

The mg routing group measured ~2.5 minutes for a one-word reply on this box; the live model test is
opt-in (`SHELL_LIVE_MODEL=1 bun test test/mg-live.test.ts`) so the suite stays fast.

Useful flags: `--workspace <dir>`, `--data <dir>`, `--db <file>`, `--project <id>`, `--agent <id>`,
`--tools read,write,edit,bash`, `--turns <n>`, `--tokens <n>`, `--http-port <n>`, `--no-http`,
`--no-terminal`, `--attach`.

Native plugins can also be registered from the conversation: `/plugins add <pkg-or-path>` writes
`<dataDir>/plugins.json` (0600) and restarts the resident through its service manager; `/plugins` and
`GET /health`'s `plugins` field report what actually loaded. A spec's module default-exports a native
plugin (`{ name, inject?, provide?, apply }`, the host's own API in `src/plugins/host.ts`).

## Web tools (#225)

The resident registers three read-only tools from `src/plugins/web.ts`:

- **`web_search`** — Exa's free MCP endpoint first, DuckDuckGo's HTML endpoint as fallback; either
  can be disabled. Results over 30,000 characters are cached and paged with `web_recall`.
- **`web_fetch`** — HTTP GET, Readability extraction, Markdown output. HTML only; it does **not**
  execute JavaScript, so a client-rendered page returns `extract_failed` instead of a fake body.
  PDFs, GitHub special handling and video are phase 2.
- **`web_recall`** — read a cached `responseId` by `offset`/`limit` (at most 30,000 characters per
  page) or `findText`. Cache entries expire after one hour.

The optional `<dataDir>/web.json` turns either backend off; a missing file leaves both on:

```json
{ "search": { "exa": { "enabled": true }, "duckduckgo": { "enabled": true } } }
```

A malformed file or field is a startup error naming the path and the field. With both backends
disabled, `web_search` returns `web_search_unavailable` naming the file and both fields.

The fetch path is the trust boundary: only http/https, no embedded credentials, every resolved
address is checked against loopback/private/link-local/reserved ranges, every redirect hop is
revalidated (5 hops maximum), and each call has a 20-second timeout. Cache files live under
`<dataDir>/web-cache` at 0700/0600 and are pruned to 64 entries / 32 MiB.

## Budget tiers (#222)

The cage still has one enforcement mechanism — the same hook points, whitelist and forced
`budget_exceeded` → `IDLE` transition — but its numeric limits now come in two tiers:

- **work** — a run the user assigned. A user message opens that assignment; 32 turns / 400k tokens
  is the shipped default, because one real install task burned 20k on reading a few large source
  files and never reached the download/register/load steps.
- **tight** — pure autonomous runs (emergence, idle checks, scheduled wakes, dreams): 6 turns /
  20k tokens, unchanged.

An autonomous wake inherits the work tier only when the ledger still holds an unfinished
user-assigned task (the assignment's `origin` is `user_message`); a fresh autonomous idea stays
tight. This is a provenance read, not a keyword guess about the wake's text. `--turns` /
`--tokens` still override the tight tier for a hand-run shell.

Both tiers live in `<dataDir>/budgets.json`, beside the rhythm env file; the installer writes it
once and never overwrites it. Edit a number and restart the service — no source edit, no rebuild:

```json
{
  "autonomous": { "maxTurnsPerRun": 6, "maxTokensPerRun": 20000 },
  "work":       { "maxTurnsPerRun": 32, "maxTokensPerRun": 400000 },
  "maxTokensPerDay": 2000000,
  "maxTokensPerNight": 200000,
  "maxIdleTurns": 4
}
```

A file that exists but does not parse (or names a non-positive limit) stops startup with
`invalid_budgets_config` rather than silently falling back. When the work tier cuts a user
assignment, the checkpoint keeps the task open with the tool call it stopped on and the next move;
the next run reads that block from the prompt tail, so it does not restart from the same file read.

`maxIdleTurns` (#241) is the no-progress floor: consecutive turns with no assistant text and no
tool result that the same call has not already returned. At 4 (default) a repeated read/edit/bash
loop stops through `run_error` (`no_progress: …`) and says so on the terminal and TUI faces; a long
task that emits stage text, or whose calls return new output, is not stopped. It is top-level
because both cages share the same floor.

`maxTokensPerDay` is the aggregate ceiling across both tiers (#233), counted on the same Tokyo day
as the emergence cap and persisted in the checkpoint's `costDayDate` / `costDayTokens` on every
turn, so a restart cannot refund the day. The default is five full work runs (2,000,000): the
autonomous baseline of eight emergence runs at 20k is about 160k, so a normal day is far below it,
while a runaway loop crosses it after roughly a hundred tight runs. When the day is at the limit,
autonomous runs are not started (`emergence_skipped` with `reason: "daily_token_budget"` and the
restart-resume path records `daily_budget_exceeded`); a user line still runs, and the stop is said
out loud once. Raise the number in this file and restart to continue.

`maxTokensPerNight` (#231 route A) caps the Dream memory model's calls, which do not run through
the agent loop. It is charged to the same `costDayTokens` counter as `maxTokensPerDay`, not a
second ledger; the night's start is checkpointed with that counter, so a restart mid-night resumes
rather than refunds the night. A night that reaches the cap records
`dream_model_budget_exceeded`, the kernel keeps the deterministic candidates and falls back to
rule-only, and no model candidate is written. The
memory role is the resident's mg route. The embedding role names `Xenova/bge-base-zh-v1.5`, but
recall reports `semanticIndex: false` until the local model has loaded; a missing or broken model
leaves recall lexical and the `/health` payload reports `embedding.state: degraded`. The model lives
under `<dataDir>/models/`; the installer supplies it, and a resident start downloads it in the
background on an upgrade. `MemoryKernel.reEmbed(projectId)` is the bounded migration path for an
existing brain once that provider exists.

## Self-modification (#236)

When the companion writes or installs its own plugin, it is changing the thing that runs it. The
shape is fixed before the pipeline (#228 item 5) exists: **one self-change is one small diff that
`git revert` can undo, with its own test gate and its own acceptance point.** A long session is not
the unit of self-modification; a commit is.

The measurement behind this is on #236. Across 94 completed T3/Codex turns (51 sessions, 2026-11-14
to 11-16, one model), 46 (48.9%) ended without a clean visible final answer: 18 conversation recaps
emitted as the final message, 23 thinking-only endings, 4 raw tool-text endings, 1 empty. The rate
did **not** rise with context length (median peak 154k tokens for abnormal vs 178k for clean;
r = -0.12), and it was highest in turns under five minutes. What did predict it was the previous
turn: after an abnormal ending the next turn in the same thread was abnormal 57.6% of the time,
against 10.0% after a clean one. None of the 18 recaps was a real `compacted` event; the model
emitted the recap itself.

So the rule is about the thread, not the token count:

- **Small** — one change, one commit, one reason; a diff a reviewer can hold in one pass.
- **Revertible** — `git revert <sha>` returns to the last accepted tree; no migration or data rewrite
  rides along.
- **Gated** — a named test or command passes before the next change starts. A failure stops the
  series; it is not fixed forward in the same session.
- **Independently accepted** — each change has its own acceptance observation (test count, trace row,
  user-visible effect), not one acceptance at the end of a batch.
- **Fresh thread after an abnormal ending** — a recap or thinking-only ending is a signal to start a
  new thread with the todo list, not to continue the one that produced it.

External-content rules still wait for the user's approval (#228 item 5); this section fixes only the
shape of the change.

## `install`: the F21 bootstrap (#203)

`bin/install` is the install guide for a self-owned companion — six steps, text in / text out, no TUI
framework. It is *not* wired into the main tree's `cogmem` bin; that integration is a post-4.2 step.

```sh
bun run bin/install                 # interactive
bun run bin/install --yes           # defaults: mg gateway, system TZ, dream 2:00–5:00
bun run bin/install --uninstall     # stop the service, remove the unit, keep the memory
```

0. **预检** — OS (macOS/Linux only; Windows is refused, its service story is not this round), bun,
   free disk, and whether the loopback HTTP port is free. No old-install branch: every version so far
   has no users, so there is one path and no migration.
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
5. **自检式首醒** — write a probe memory through the resident's own control socket (its in-process
   kernel keeps the single writer), restart the process, and recall it. Only then does the installer
   print success; the endpoint is a first `cog` attach.

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

## `upgrade`: the resident form (#165)

`/upgrade <新版目录>` upgrades the *resident* the way `cogmem update` upgrades a CLI install: 停服 →
换版 → 迁移 → 启服, with rollback. The full contract is [`UPGRADE.md`](UPGRADE.md); the short shape:

- **only from a silent state** — `IDLE` or `DORMANT`. In `RUNNING` / `DREAMING` / `WAKING` it is refused
  with a receipt that names the state, and nothing is staged, snapshotted or promised.
- **the new tree is staged beside** the serving one, not over it:
  `<dataDir>/app/versions/<version>/`, `node_modules` symlinked from the source.
- **the brain is snapshotted before it is migrated** — the new version opening the database *is* the
  migration, so the snapshot is taken while the old version is stopped and nothing has opened it:
  `<dataDir>/snapshots/pre-upgrade-<from>-<stamp>.snap`, one file, checksummed, restorable.
- **the gate runs in the staged tree's own process**: open the brain, the doctor's static checks, the
  soul, and a recall self-check (write a probe turn, recall it by its token). The live half of the doctor
  (health face, attach socket, the unit) needs a process, so it runs after the start — and a failure there
  rolls back too.
- **any failed check rolls back**: restore the snapshot, point the service back at the old tree, start
  it. The old tree was never modified, which is what makes "旧版可服务" cheap.
- **the report is owed, not hoped for** — announced before going offline (a receipt, not a model
  turn), carried as an F2 wake intention until it is spoken, and spoken on the next attach's
  "你不在时发生了什么" as a version delta plus the gate result. A failed upgrade, a rolled-back one, and a
  supervisor that vanished without a word are all reported; silence is the one outcome that is itself
  reported (`升级后沉默`).

The shell does not stop itself, and does not restart itself: it writes the request, keeps the promise, and
hands both to `src/upgrade/supervisor.ts`, which outlives the stop it performs. Under a service manager the
supervisor is started as its own transient unit for exactly that reason — a supervisor inside the unit's
cgroup would be stopped by the stop it is about to run.

```sh
# the cycle, by hand (the resident must be IDLE first)
bun run src/cog.ts            # attach
> /upgrade /path/to/new/cog-tree
```

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
(`/soul /memory /forget /export /correct /commitments /status /context /sleep /dream /plugins /help /exit`, plus `/model` when
more than one route is configured); attaching while `DREAMING`
shows a sleep screen and any input wakes it through the legal `DREAMING→WAKING` edge. Attaching plays
"你不在时发生了什么" — the dreams, the held emergence candidates and the fulfilled commitments read back
from the ledger, not replayed into the conversation.

**The agent can hand you a command.** Its reply may carry a `propose_command` offer — the command, any
argument, and a one-line reason — which renders in the transcript as an executable element in the
receipt's visual family (`⌁ 提议 /pause · 你刚说今天很累`, then `Enter 执行 · Esc 放弃（尚未执行）`). It
never runs on its own: `Enter` sends the confirmation over the socket and the resident executes it
through the same dispatch a typed `/pause` takes; `Esc` retires it. Either answer is final — a proposal
is one-shot and cannot be replayed — and both land in the trace (`command_proposed`, `_confirmed`,
`_executed`, `_discarded`, `_rejected`, `_execution_refused`). Only commands the palette offers may be
proposed: `/pin` and `/unpin` are refused on the spot and traced, and an offer nobody confirms
changes nothing.

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
- `src/plugins/load.ts` — resolves a registry spec (package or path) and registers its native plugin.
- `src/plugins/*` — clock, recall, dream, emergence (conservative), cage, capture, the four tools,
  web search/fetch/recall, command-proposals (the `propose_command` tool), mg provider. Dream,
  emergence and recall are plugins like the rest: swap one by not loading it.
- `src/proposals.ts` — command proposals (spec §7): the registry the agent's tool records into, and the
  one execution entry `executeProposal`, gated on a user-confirmation event. The shell's `confirmProposal`
  is its only caller, and it dispatches through `runCommand`, never a second dispatcher.
- `src/hygiene.ts` — the self-written/skill/plugin/rule gate (#228 item 5): size, shape, secret and
  hidden-character checks, a deterministic score, the #236 small-diff cap, and the rule that a plugin
  proposal or an external-sourced rule waits for the owner through the existing question suspension.
  `propose_self_change` still only records; `src/self-change.ts` is the separate applier (#291) that
  takes an owner-approved plugin proposal, snapshots `plugins.json` and the target files, writes and
  registers it, and restores the snapshot on the next boot if the plugin did not load. A rule or skill
  proposal has no apply path, and a proposal without the owner's approval is refused.
- `src/model/routes.ts` / `router.ts` — the named-route store (`0600`), the redaction helpers, and the
  switchable provider the resident's `model` service is.
- `src/channels/terminal.ts` — the self-owned terminal channel (line mode, for `--no-terminal`-off residents).
- `src/tui/*` — the `cog` interface: frame/theme, markdown, the view reducer, layout and virtualization,
  the input editor, the palette, and the raw-mode app. Pure `render(view, size, env)` core, so the
  snapshots are text comparisons.
- `src/attach/*` — the resident's control socket (the channel `cog` and the install's first-wake probe
  speak) and the client `cog` connects with.
- `src/cog.ts` — the `cog` entry point: attach-or-spawn, `--headless`, and the non-TTY line mode.
- `src/presence.ts` — "while you were away", read back from the trace, the runtime and the kernel.
- `src/probes/gaps.ts` — the F1/F2/F6 (+F-SEC) probe and gap list.
- `src/kernel-host.ts` — the loopback HTTP face over the in-process kernel: `GET /health` (kernel
  status without opening a second kernel, which two-writer discipline forbids) and, when the kernel
  source is beside the shell, the read-only observatory at `/observatory` — its pages and JSON
  endpoints plus `/observatory/events`, the kernel's own event stream, which the route factory takes
  as a positional argument (see the borrow note in that file). Plain JSON, no tool
  surface. It used to also serve MCP to other hosts; that endpoint (and the per-session `Server`
  behind it) was removed by #200 R2 — the shell and the kernel are one process, so it was a second
  way in with no second reader.
- `src/install/*` — the F21 bootstrap: the six-step installer, the versioned soul table, the model
  probe, the systemd/launchd unit renderers, the shell-side doctor, and the attach-socket probe
  client the first-wake check speaks.
- `src/upgrade/*` — the resident-form upgrade (`UPGRADE.md`): the durable request/outcome records, the
  beside-install staging, the pre-switch gate, and the out-of-process supervisor that owns
  停服 → 快照 → 迁移 → 健康门 → 切换 → 启服 and its rollback.

## Failure ladder

A failed model call goes down one ladder: **context overflow first**, then **account/subscription
limits** (non-retryable; they reset in hours and retrying only burns the day), then a **whole-turn
timeout** (non-retryable: the cap covers connect, prefill and every token, so retrying it multiplied one
silent wait into up to ~8 minutes — #240), then a **bounded retry** for transport failures only (a
connection that failed, not a server that answered: 429/5xx fail fast) with exponential backoff capped
at 60 s. The pattern tables are ported from pinned `@earendil-works/pi-ai@1.5.0`
(`utils/retry.ts`, `utils/overflow.ts`); the timeout rung and the transport-only narrowing are the
deliberate deviations.

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
"check the model name". It does not replace the ladder: 401/403/404 and 429 stay `fatal` (no retry),
while a refused connection stays `retryable` with the same capped exponential backoff as any other
transport failure; a timeout fails fast and names itself. The route probe uses the same classifier, so
the install's wording and the runtime's behaviour cannot drift apart. (One pattern was added to the
ported table: Bun's fetch says "Unable to connect" for a refused connection, and Pi's table predates
that phrasing.)

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

## Bash sandbox (#233, #288)

`bash` runs through `bubblewrap` when it is usable: a minimal read-only system root (`/usr`, `/bin`,
`/sbin`, `/lib`, `/lib64`, `/etc`) plus the workspace read-write, with fresh `/tmp` and `/var/tmp`
tmpfs mounts. The operator's home and the shell data dir are not mounted; when the data dir sits
under the workspace (the default `<workspace>/.cogmem-shell`) an empty read-only mount masks it, so
`memory.sqlite`, `budgets.json`, `routes.json`, `checkpoint.json` and `plugins.json` are unreadable
and unwritable from the sandboxed process. A denied write is a tool error and a `bash_sandbox_denied`
trace record. The network namespace is unshared, so a fetched page cannot instruct bash to send a
secret out. The child inherits only a small variable allowlist (`PATH`, locale, `TZ`, `TERM`, ...),
never API keys or tokens; `HOME` is `/tmp` and `COGMEM_CONFIG` still points at the companion's config,
which the mask makes unreadable (the in-bash CLI fallback therefore cannot open the database).
`write`/`edit` refuse the same data-dir paths for the same reason (`path_in_data_dir`). If `bwrap` is
missing or its user namespace is refused, the probe fails once, `bash_sandbox_unavailable` is traced,
and `bash` runs as before — the shell keeps working on machines that cannot sandbox, but says so
rather than claiming protection it lacks.

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

Reproduce with `bun run scripts/measure-baseline.ts` (`--no-http` to leave the loopback HTTP face
out); the script prints one JSON line, with the terminal off like the resident
defaults. The medians below are of eight runs of this round's head; the spread is what the same box
gave in one measurement session, and a loaded box moves it by tens of milliseconds.

| Measure | Value | Notes |
|---|---|---|
| Process start → IDLE, HTTP face on | **354 ms** median (observed 331–386) | measured with `process.uptime()`, so bun's own start-up and the module graph are included |
| Process start → IDLE, `--no-http` | 318 ms median (observed 311–329) | the loopback status/star-map face costs roughly 35 ms of the start |
| `checkpoint.json` at boot (2 transitions) | 1,083 B | |
| `checkpoint.json` at the history cap (242 transitions, 200 records kept) | 31,083 B | `trimHistory` caps the history, so the file is bounded rather than growing for the run's life |
| Transition write | temp + fsync + rename + directory fsync | the durability the kill-recovery test depends on; ~150 B of JSON rewritten per transition at the cap |

None of these needed fixing: a resident process pays the start once, and the checkpoint is bounded and
human-readable on purpose (`SURVIVAL.md` tells the operator to `cat` it).

`SURVIVAL.md` is the startup script and care notes for the 7-day run (not started in this round).
