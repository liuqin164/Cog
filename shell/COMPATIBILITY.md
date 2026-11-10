# Pi compatibility baseline (F11 #165)

- **Target Pi version: `@earendil-works/pi-coding-agent@1.5.0`** (pinned; see `src/pi/target.ts`).
  The box's installed CLI is 1.4.0 and its local package is 1.3.0; the adapter is written against the
  1.5.0 extension types and tested with the plugins below.
- Compatibility object is the **plugin contract** (tool registration, event hooks, TypeBox
  parameters, extension loading), not Pi's package as a runtime dependency. The shell does not import
  Pi's loop; it reimplements the contract.

## Real plugins exercised through the adapter

| Plugin | Version | Kind | What the test drives |
|---|---|---|---|
| `pi-web-access` | 0.47.0 | tool | loads, registers its tools/commands, and one tool executes through the adapter into the shell tool registry |
| `@lalalic/channel` | 1.0.6 | channel | loads, receives a channel message over its own WebSocket protocol, and the message reaches the shell as an inbound turn |

Both are pinned in `package.json`; the test records the version it loaded (see `test/pi-adapter.test.ts`
and the `pi_plugin_loaded` trace line).

## In scope

- `registerTool` with TypeBox `parameters`
- `on(event, handler)` for the full lifecycle: `before_agent_start`, `agent_start`, `turn_start`,
  `message_start/update/end`, `tool_execution_start/update/end`, `turn_end`, `agent_end`,
  `session_start/shutdown`, plus `tool_call` → `beforeToolCall` and `tool_result` → `afterToolCall`
- `registerCommand`, `registerProvider`, `registerFlag`/`getFlag`, `sendMessage`/`sendUserMessage`
  (`deliverAs: steer | followUp`), `exec`, `getSettings`, `events`
- lifecycle: adapter load translates registration, then fires `session_start`

## Refused or dropped (documented, not promised away)

Every capability named below is asserted against the trace in `test/pi-adapter.test.ts`, so this list
and the log cannot drift apart.

- **Refused** (`PiCapabilityUnsupported`), traced as `pi_capability_refused`: `registerMcpServer` and
  `registerVirtualModel` are refused while the plugin loads, so the plugin is disabled and the reason is
  additionally recorded as `pi_plugin_refused`. The interactive UI surface is only reachable from a
  call the adapter hands a context to — an event handler, a tool's `execute`, or a command handler:
  `ui.select`, `ui.confirm`, `ui.input`, `ui.editor` and `ui.custom` are refused at the
  call and traced there, and the plugin keeps running without a user.
- **Dropped** (traced as `pi_capability_dropped`, plugin keeps running): rendering-only
  registrations — `registerMessageRenderer`, `registerEntryRenderer`, `registerToolRenderer`,
  `registerMarkdownTransformer`, `registerShortcut` — because a resident headless process has no renderer
  or key surface.
- **Empty, and recorded**: `sessionManager.getEntries` and `sessionManager.getBranch` return `[]` (no
  session tree exists headlessly; a plugin that tolerates an empty history keeps working, one that needs
  the tree does not) and `setActiveTools` is a no-op because the cage whitelist decides the loadout. Each
  call records the drop the first time, so the degradation is visible in `.cogmem-shell/shell-events.jsonl`.
- Payload parity is at the documented field level, not byte-for-byte: `turn_end` carries
  `{ message, toolResults, turnIndex }`, `agent_end` carries `{ messages, summary }` (the `summary`
  is a companion superset). Entry ids, boundary state and session-tree fields are absent by design.
