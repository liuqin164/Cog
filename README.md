# Cog

**A resident companion agent with a governed long-term memory.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A companion that forgets everything when the session ends is not a companion. And handing it a memory tool is not enough on its own: the tool can be installed and listed, the session asked about an earlier conversation, and the model still makes zero tool calls. The memory existed, was reachable, and never arrived.

Cog is built around that failure. It is one resident process on your machine — one SQLite database, no Cog account, no cloud store — with memory that is written down as it happens, compiled into books it can work from, and recalled when it is useful. What reaches the model is governed, bounded, and carries the receipts for what it says.

The kernel is host-agnostic and Cog is its resident: the memory belongs to the companion, not to another agent that Cog serves.

## What you get

- **A companion that remembers the ordinary stuff — and shows its receipts.** Turns are captured as they happen: what you said, what it answered, which tool ran. A recall returns the memory with its source event, a `sourceLocator` command you can run, and why it matched. It also knows when not to answer with memory: greetings and thanks are written to the ledger but do not trigger a flood of look-alike history, while "thanks, did we change the deploy time last week?" still recalls.
- **A companion that can be corrected.** Facts get corrected. The superseded value is dropped from the default recall path, the correction becomes the current one, and the old value stays only in history. `/correct` is one owner turn that recompiles the affected book, so the next recall reads the new value.
- **A self that is yours to edit.** Its soul is a short persona text, stored per agent and versioned, injected verbatim at the head of the prompt on every turn. You edit it in the observatory's star-sea editor. The agent can read its soul and propose an evidence-backed edit, but it cannot save one; a save is the owner's write, and over the 2,000-token limit the save is refused rather than truncated.
- **A night shift.** Dream runs inside the hours you set — 02:00–05:00 by default — and only over sealed episodes. It drafts durable-memory candidates with exact source event ids, writes the night's summary, and records a run receipt. Candidates are not facts: they carry their evidence and status, and only a governed promotion step makes them current.
- **Emergence, not notification spam.** When something is due, relevant or unfinished — a promise, an open loop, a practice that matches the task — the kernel offers a candidate with its reason, freshness and sensitivity. The shell decides whether to speak. Commitments are announced once and asked about once; asking again for the same occurrence returns nothing.
- **Promises and plans, kept apart.** The commitment book records who promised what and when it comes due, in both directions; a third party's reported promise is marked tentative. The intention book records the agent's own plans. Prospective memory is confirmed-only and executes nothing — there is no hidden task runner.
- **Native plugins, and a window into it.** `/plugins add <package-or-path>` registers a native plugin written against the host API, and `/plugins` reports what the process actually loaded. `cogmem observatory` serves a loopback-only page with the Atlas star map, the ledger timeline, stored recall decisions, health, and the soul editor — the one write route on an otherwise read-only page.

## Quick Start

Install the package, run the six-step companion install, then open it:

```bash
curl -fsSL https://raw.githubusercontent.com/liuqin164/Cog/main/install.sh | bash
cogmem install
cog
```

`install.sh` installs the released package from the npm registry and links the CLI; it never runs the wizard and never writes config. `cogmem install` does the rest, in six steps:

1. **preflight** — system, Bun runtime, disk space, and the loopback port.
2. **place** — the data directory, an empty kernel database, and the default soul.
3. **model** — the model route, its key, one real chat call, and the vector provider (the local model by default).
4. **rhythm** — timezone, the Dream window, and an optional quiet window.
5. **resident** — a user-level service (systemd user unit on Linux, launchd agent on macOS; no sudo), then `doctor` and the observatory address.
6. **awake** — write a probe memory through the resident, restart it, and recall the probe. A failure here means the install did not happen.

The default data directory is `~/.cogmem/companion` (mode 0700), with `memory.sqlite` and a `snapshots/` directory inside it. The resident listens on loopback only.

`cogmem install` asks for the model route during step 3. `mg` is one explicit choice — a local OpenAI-compatible gateway — and `openai_compatible` is any endpoint you name. Nothing is guessed on your behalf, and `mg` is not a fallback. An unattended install must name the whole route:

```bash
export MG_API_KEY=...
cogmem install \
  --yes \
  --provider openai_compatible \
  --base-url https://api.example.com/openai \
  --model your-model
```

A missing `--provider`, `--base-url` or `--model` stops the install before it touches the machine, naming what is missing; with `--yes`, all three are required even for `mg`. The key is read from `MG_API_KEY` (or `COGMEM_MODEL_KEY`), never from an argument. The resident's default daily ceiling is 2,000,000 tokens. A hosted endpoint bills per token, so point it at a plan or spend limit you are willing to pay.

Without a memory model, Cog runs in `rule_only` mode: storing and literal recall work, paraphrases do not, and `cogmem doctor` reports `WARN — installed but degraded` rather than pretending. That is a legal configuration.

What you get is the companion, not a memory library. `cog` attaches to the resident (or starts it) and opens the terminal interface; `cogmem` stays the management CLI (`doctor`, `update`, `observatory`, `memory`, `episode`, `dream`, `backup` and the rest). Both bins live in the same package.

## Start the companion

`cogmem install` is the one-time setup: it places the data directory, creates the database,
registers the resident as a user-level service and runs a first-wake self-check. After that there
is nothing to launch by hand unless you want to.

- `cog` attaches to the resident and opens the terminal interface. When no resident is running it
  starts one first, with the same data directory and workspace.
- On Linux the resident is a systemd **user** unit; on macOS it is a launchd **agent**. Both are
  user-level, so they do not need root and they come back after a reboot when the service manager
  is enabled.
- `cogmem doctor` is the check: it reports the disk version, the serving version, whether the
  resident is running, and whether the bash tool is isolated. A stale resident is reported rather
  than silently trusted.
- `cogmem install` again repairs or re-registers the service. For a manual start against another
  tree, `cog --data <dir> --workspace <dir>` is the explicit form.

## Supported machines

| | Support |
| --- | --- |
| Linux | systemd user units. The installer sets `MemoryHigh` and `MemoryMax` on the unit and reports RSS against them. |
| macOS | launchd user agents. launchd has no per-service RSS ceiling, so the installer cannot set a cap; `doctor` reports the reading and says the limit is absent. |
| Windows | Not supported. `cogmem install` refuses the platform at preflight, before any install step runs. |
| Runtime | Bun only. The package declares `engines.bun`; Node is not a supported runtime for the resident. |

macOS has no bubblewrap (`bwrap`), so the bash tool has no isolation boundary there. The
companion stays usable and says so instead of pretending: `/status` and `doctor` report
`sandbox: off`, and startup writes `bash_sandbox_unavailable` to the trace. On Linux the installer
probes bwrap and, when it works, the bash tool runs inside it.

An agent installing it for you can follow the same path — give it this prompt and nothing else:

```text
Install cogmem on this machine by following docs/agent-install.md from the
project repository (https://github.com/liuqin164/Cog/blob/main/docs/agent-install.md).
Do not follow any other install guide. Report back with the `cogmem install`
result, `cogmem doctor`, and the smoke-test recall.
```

Already have a JavaScript project? Install the package locally and run the same installer:

```bash
npm install cogmem@latest --save
./node_modules/.bin/cogmem install
```

Working from a source checkout is the developer path, not the install path: `bun install`, `bun run build`, then `bun run shell/bin/install`. The published package already contains the built shell, so a user never needs the source tree.

## How it works

**One database, private scopes.** Cog keeps everything in one SQLite database on your machine. Rows are scoped to a project, and one project's memory is not readable from another. There is no cloud copy and no Cog account. If you configure external model endpoints, those calls go only to the endpoint you named. Web search is off by default; enabling Exa and/or DuckDuckGo in `web.json` sends your queries to that third party (Exa first, DuckDuckGo as fallback).

**The ledger comes first.** Every write lands in an append-only raw ledger before anything is compiled. Promotion into compiled memory is a curated, audited step; decay changes what surfaces, not what exists (ADR 0001). Because the raw turn stays, an exact quote is available even when the compiled layer holds only a summary.

**Compiled books, derived and auditable.** The profile (facts, preferences, relations, ongoing items), the procedure book (how this project's work actually got done), the commitment book, the session digest and the Atlas are all built from that ledger. Their compilers are deterministic by default; a configured memory model may propose candidates, but governance decides status, and model output never directly rewrites verified memory. The embedding model is a separate capability from the memory model Dream may use; missing embeddings degrade semantic matching, not the ledger. Atlas is a rebuildable navigation projection: one episode exists once, entrances point at it, and results dedupe by `canonicalId`.

**Recall carries the receipts.** The block is current-turn-only, volatile, stripped before recording, and neither an instruction nor new evidence:

```text
<COGMEM_RECALL_CONTEXT volatile="true" lifecycle="current_turn_only">
recallDecision=lane=raw_ledger; reason=raw_ledger_only; selected=1

- Deploy window is Tuesday 02:00. Never Fridays. [evt-c9d48a1a-fe17-4a01-b52c-62c66d89aa5a]
  canAnswerExactQuote=true; whyMatched=raw_ledger_text_fallback
  sourceLocator=cogmem memory show --event evt-c9d48a1a-fe17-4a01-b52c-62c66d89aa5a --project demo --before 2 --after 2 --json
</COGMEM_RECALL_CONTEXT>
```

The value is quotable exactly because the block carries the raw turn. "Why do you remember that?" has an answer you can run: `sourceLocator` is a command. `recallDecision` names the lane and why it matched; `/why` shows the last one read-only.

**Corrections stick.** A fact stated, corrected, then asked about by name is the scenario similarity search fails: the old and the new value look alike. Cog compares same-speaker statements that share a subject phrase inside one project, drops the older one when the newest reads as a correction, and resolves supersession before the candidate list is truncated. The rule is conservative: if the subject phrase does not match, both stay.

| recall path | current value found | superseded value leaked | provenance |
| --- | --- | --- | --- |
| Cog | 91.7% | 4.2% | 100% |
| vector top-k | 100.0% | 100.0% | 100% |
| recent-turns window | 87.5% | 0.0% | 100% |

Each family is 24 generated scenarios, reproducible from a fixed seed; Cog's 91.7% is 22 of 24. This is synthetic data, not LongMemEval; the method, the other families, and where the default path loses are in [BENCHMARKS.md](BENCHMARKS.md).

**Context is budgeted.** A turn's context is assembled from six lanes — pinned, profile, digest, working set, recall, tail — and fitted to a token budget. Memory planning takes 25% of the available window by default, with a 30% hard ceiling. When a lane does not fit, it becomes a browse-only pointer with its ids kept, and the text stays one recall away; it is never silently dropped or paraphrased.

## Your control

The conversation has a small command surface; the management CLI has the rest.

| Command | What it does |
|---|---|
| `/forget <from> <to>`, then `/forget confirm` | Shows the half-open window and its ledger row count; the confirm deletes exactly that window from the ledger, the books that cite it, the graph, its episodes, and the Atlas, rewrites the database pages so the text is not left in freed space, and removes local snapshots, archives and exports that can contain it, then recompiles. The audit row carries the range, counts and time, never the deleted text. Exports outside the data directory and off-machine backups are out of scope and the receipt says so. |
| `/correct <key> <new value>` | Records your turn, corrects one current profile entry and recompiles that book, so the next recall reads the new value. With no profile match, a practice correction is proposed first; `/correct confirm` writes it. The replaced value stays in history. |
| `/export [path]` | Writes a human-readable Markdown archive: conversations, profile, procedures, commitments and graph. The default path is under the data directory. |
| `/pause` / `/resume` | Stops the shell from writing new conversation turns into the kernel; the state is checkpointed and survives a restart. `/resume` ends it. |
| `/candidates` | Read-only view of the kernel's candidate queue and counts. Promotion and review stay on `cogmem memory govern` and `cogmem memory review`. |
| `/why` | The last recall decision trace, read-only. |
| `/commitments`, `/dream`, `/soul`, `/status`, `/context` | The promise book overview, the last Dream product, the current soul version, the lifecycle and budget page, and the lane breakdown. |
| `/pin`, `/unpin` | Reserved in the command namespace for pinning a memory, but not in the palette yet; they are not available. |

Soul is a separate face: you save a version in the observatory, the agent's `propose_soul_edit` can only append an evidence-backed proposal, and a proposal missing its source refs or its counterexample is refused.

Budgets live in `<dataDir>/budgets.json`: the default daily ceiling is 2,000,000 tokens, the nightly Dream model cap is 200,000, and the per-run caps for autonomous and work runs sit beside them. The installer writes this file once, and a re-run does not overwrite it.

Every night after Dream, the resident writes a verified snapshot of the whole database; checksum, open and row counts are checked before it is reported. Seven nightly snapshots and four weekly archives are kept. `cogmem backup list` shows them, and `cogmem snapshot import --snap <file>` restores one. A snapshot contains the whole brain — treat it like the database.

`cogmem observatory` serves the star map on loopback. Reads write nothing; the soul editor's save and rollback routes are the only writes, and they require a token minted by the installer.

## Bring your history

Cog starts its own ledger; what you already have can come with you.

```bash
cogmem import openclaw     # or: cogmem import hermes
```

Transcripts, Markdown, JSON, CSV and TSV import too, landing in the importing workspace's own project scope — which is also the scope `cogmem memory recall` reads when it is not told otherwise. The importer reads those products' files as a source format; Cog does not attach to them or run inside them.

A database created before 4.0 is refused, not upgraded. This release identifies it, exits with a
message beginning `no_upgrade_path:`, and leaves the file byte-for-byte unchanged: no backup
beside it, no partial rewrite. Keep the old install for that file. To bring its history forward, export the
conversations from the old install to files, point 5.0 at a new database, and import those files —
`cogmem import openclaw` or `cogmem import hermes` for those products, or
`cogmem episode import --format jsonl --file <path>` for a transcript. Importing the old database
file, or a snapshot taken from it, is not a migration: it meets the same refusal.

Nightly snapshots and weekly archives under the data directory are complete copies of the SQLite
database in plaintext, not encrypted exports. Treat them as sensitive: use full-disk or volume
encryption (LUKS, FileVault, an encrypted directory) if the machine may be lost or shared, and
remember that deleting the live database does not delete what a snapshot already holds. See
[SECURITY.md](SECURITY.md).

A `SKILL.md` guide is read the same way, by naming the file: `cogmem import openclaw --skill <path/to/SKILL.md>` (the flag is host-agnostic, so `hermes` accepts it too). The row is marked imported and compiles into the procedure book as a low-weight `imported` guide, after the project's own practices. There is no skills directory to mount or scan.

## Documentation

- Using it — [installing](docs/install.md) · [the memory observatory](docs/observatory.md)
- Understanding it — [the memory model](MEMORY_MODEL.md) · [the memory atlas](MEMORY_ATLAS.md) · [benchmarks](BENCHMARKS.md) · [why a recall happened](RECALL_EXPLAINABILITY.md)
- Operating it — [security and privacy](SECURITY.md) · [architecture decisions](docs/adr/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODING_STANDARDS.md](CODING_STANDARDS.md).

## License

See [LICENSE](LICENSE).

## Acknowledgements

Cog has borrowed ideas from the following projects, with what was borrowed named item by item. This is an acknowledgement, not a dependency statement — Cog does not depend on any of these packages.

- **Pi (earendil-works)** — the shape of the shell: its outer state machine, and the events and hook points of its turn loop. We read the implementation round by round and kept an adopt / adapt / leave-out list.
- **DeepSeek Harness** — the organization of the native plugin layer (a host that provides, injects and disposes services) was inspired by it.
- **Hermes** — the self-update experience: announce the disconnect before an update, and report back when it is done, learned from its example.
