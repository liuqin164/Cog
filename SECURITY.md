# Security

Cog is local-first by default. Memory data is stored in the configured SQLite database path.

## Data Handling

- Core does not require a hosted storage service.
- TOML is the only kernel configuration entrypoint. Security and governance settings live in `config.toml`; environment variables are only interpolated when explicitly referenced in that file.
- PII redaction is configured under `[governance]` with `pii_redact_email`, `pii_redact_phone`, and `pii_redact_ssn`.
- Field encryption is available by passing an `EncryptionProvider` when creating the kernel.
- Embedding providers may send text to the provider explicitly configured in `config.toml`.
- Snapshot files should be treated as sensitive because they contain exported memory data. The
  nightly snapshot and the weekly archive are complete copies of the SQLite database as raw bytes;
  Cog does not encrypt them for you. With no `EncryptionProvider`, every remembered turn, profile
  entry and procedure in those files is readable plaintext. Encrypt the disk or volume (LUKS,
  FileVault, an encrypted directory) when the machine may be lost, shared or backed up off-device,
  and treat a copied snapshot as a copy of the database itself. Deleting the live database does not
  delete the snapshots that already hold it; remove them deliberately when that is what you mean.
- Imports and migrations should be run with dry-run first when moving existing agent memory into core.
- Raw chronological ledger events are written through the kernel so configured PII redaction runs before persistence. Encrypted deployments still treat ledger payloads as sensitive.
- Agent-facing recall is governed by default: archived memory, suspect LLM inference, suspect tool observations, and suspect unverified claims are suppressed from active context.
- Raw user utterances can be recalled as provenance evidence when explicitly tagged as raw user evidence; this does not promote them into verified facts.
- Recall explanations expose same-project `filteredEvidence` with `reason` and optional `governanceReason`. Scoped explanations must not expose filtered evidence from other projects.

## Threat model

The supported deployment is one operating-system user on one machine. The guarantees below are
written for that user's own processes; they are not isolation between users.

### Same-machine, multiple users

Every service face binds loopback, but loopback is machine-wide and an HTTP request carries no OS
identity. A second local user, or any process that can connect to `127.0.0.1:<port>`, can:

- Read the observatory. `/snapshot`, `/node/:id`, `/timeline`, `/recalls`, `/health`, `/events` and
  `/soul` require only a loopback socket and a loopback `Host`; they answer without a token. That
  exposes the whole memory corpus, stored recall decisions and every soul version. This is the
  accepted single-user posture, recorded here so a shared-VPS deployment can see its exposure. The
  read routes are deliberately unchanged in 5.0: TCP loopback gives the server no peer identity
  (`SO_PEERCRED` is a Unix-socket facility), so "authenticate the local user" needs a different
  transport or an out-of-band credential flow, not another header check.
- Write a soul only with the token. The token is minted by the installer at
  `<dataDir>/observatory-token`, mode 0600; since #308 no HTTP route returns it. The page asks the
  owner to paste it once per tab, and `POST /observatory/soul` compares it in constant time.
  Another user who cannot read the 0600 file cannot obtain it over HTTP. A process running as the
  owner can read the file directly, and no local file mode prevents that.

The model API key follows the same rule: it lives only in `<dataDir>/env` (0600), is read by the
resident, and is never printed or logged. A process running as the owner can read it; another user
cannot.

### bash tool

- Sandbox on (Linux, when the installer's `bwrap` probe succeeds): the command runs with
  `--unshare-net` (no network), the workspace writable, the data directory masked read-only (when it
  is not the workspace itself), system directories read-only, `/tmp` and `/var/tmp` as private
  tmpfs, and `HOME=/tmp`. Writes outside the workspace fail as read-only.
- Sandbox off (macOS, which has no `bwrap`, or Linux when the probe fails): the command runs as the
  owner with the owner's full filesystem and network access. Every result is prefixed
  `[sandbox: off]`, and startup records `bash_sandbox_unavailable` in the trace. `doctor` and
  `/status` report the same state.

### Outbound traffic

- `web_fetch` accepts only `http(s)`, refuses embedded credentials, resolves the hostname, refuses
  loopback, private, link-local and reserved answers, re-validates every redirect, and pins the
  first validated address so a second DNS answer cannot move the connection. It still reaches any
  public host the model asks for; that host sees the request and the `cogmem-web/1.0` user agent.
  It sends no cookies and no model key, and it does not execute JavaScript.
- `web_search` is off by default since #306. Enabling Exa and/or DuckDuckGo in
  `<dataDir>/web.json` sends the query text to that third party (Exa first, DuckDuckGo as fallback).
- Embedding and model calls go only to the provider configured in `config.toml` or the install's
  model route. There is no Cog-hosted copy of the memory database.

### Native plugins

`<dataDir>/plugins.json` names packages or module paths that the resident imports into its own
process. A plugin is arbitrary code with the resident's privileges — the database, the files the
user can read, outbound network, in-memory keys — and there is no sandbox or permission model
around it. Installing a plugin is trusting that code. The host's conflict and quarantine rules
protect the process from a *broken* plugin, not a hostile one.

## Agent roster

A registry file (`<workspace>/.cogmem/agents.json` first, then `~/.cogmem/agents.json`, or the
`--agents <path>` flag on `cogmem observatory`) lists the agents this install owns. It is a
roster, not an authentication mechanism: since R3 of #200 it carries names and project scopes
only, and there is no credential to present or compare.

- The roster is read-only. Nothing in this install mints a credential or looks one up; a
  `token`/`tokenDigest` field left behind in a file an older install wrote is ignored rather
  than trusted.
- A roster named by `--agents` that cannot be read is refused at startup instead of being
  treated as "no roster": an operator who believes the roster is in effect must not silently get
  an install that ignores it.
- No roster is the supported single-agent case, and is a different answer from a named roster
  that cannot be read.

## Reporting

Report vulnerabilities privately through the repository security advisory flow. Do not open public issues for exploitable security bugs.

## Dependency sourcing

- `xlsx` is installed from the SheetJS official CDN tarball
  (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), not npm: 0.18.5 is the last npm
  release and carries two unfixed advisories, while 0.20.3 is the maintained distribution. The
  lockfile pins its integrity hash, so install resolves the same bytes.
- `protobufjs` is overridden to `^7.6.6` because `onnxruntime-web` still declares `^7.2.4`, which
  can resolve to versions affected by the DoS and code-generation advisories fixed after 7.5.5.
- `@xmldom/xmldom` is overridden to `0.8.15` because `mammoth` declares `^0.8.6`; 0.8.15 is the
  first 0.8.x without the parser injection and quadratic-parsing advisories. Remove both overrides
  once the direct consumers raise their own floors.
