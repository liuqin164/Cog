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
- `src/state/agent-loop.ts` — Pi's turn loop, event names and hook positions reused verbatim.
- `src/plugins/host.ts` — one registry, one bus; native Cordis-style plugins.
- `src/pi/adapter.ts` — the removable Pi compatibility layer.
- `src/plugins/*` — clock, recall, dream, emergence (conservative), cage, capture, the four tools,
  mg provider. Dream, emergence and recall are plugins like the rest: swap one by not loading it.
- `src/channels/terminal.ts` — the self-owned terminal channel.
- `src/probes/gaps.ts` — the F1/F2/F6 (+F-SEC, F-MCP) probe and gap list.

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

`COMPATIBILITY.md` records the pinned Pi version and the real-plugin test set.
`SURVIVAL.md` is the startup script and care notes for the 7-day run (not started in this round).
