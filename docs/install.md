# Installing Cog

`cogmem install` is the one installer. It installs the resident, registers the user-level service
and runs a first-wake smoke test. An agent installing the companion follows
[`docs/agent-install.md`](agent-install.md).

Nothing below is a bug report or a to-do: `rule_only` is a legal end state, and the install gate
is working when it says `WARN`. Every command and field below was checked against the `--help`
of the command it is shown with and the configuration source. If you are reading this page from
an installed package and something does not match the `--help` you have, the `--help` is right.

## Companion install (`cogmem install`)

`install.sh` installs the package and links both declared bins, `cog` and `cogmem`; it does not
run this installer. `cogmem install` runs six steps: preflight, place, model, rhythm, resident
and awake. Step 6 writes a probe memory through the resident, restarts it and recalls the probe;
that is the smoke test. The installer stops at the first failed step, prints the reason, and
resumes from that step when you rerun it.

Interactively it asks for the model route. Unattended, the whole route must be named:

```bash
export MG_API_KEY=...
cogmem install \
  --yes \
  --provider openai_compatible \
  --base-url https://api.example.com/openai \
  --model your-model
```

`--yes` requires `--provider` (`mg` or `openai_compatible`), `--base-url` and `--model`;
`openai_compatible` also requires `MG_API_KEY` or `COGMEM_MODEL_KEY`. Two namespaces appear here:
`COGMEM_*` is Cog's own configuration, while `MG_BASE_URL`, `MG_API_KEY` and `MG_MODEL` belong to
the local mg gateway and are read only when that route is chosen. A missing flag stops the install
before it touches the machine and names what is missing. The other flags are `--data`,
`--workspace`, `--project`, `--agent`, `--http-port`, `--service-name`, `--home`, `--platform`,
`--skip-service`, `--uninstall` and `--help`.

The default data directory is `~/.cogmem/companion` (mode 0700); the nightly snapshots and weekly
archives there are complete plaintext copies of the database. A warning such as an unavailable
local embedding model means a degraded install, not a failed one. After `cogmem install`,
`cogmem` is usable directly: the management CLI resolves the companion's own database without
a `~/.cogmem/config.toml`.

### Vector provider

The companion's semantic lane defaults to the local `Xenova/bge-base-zh-v1.5` model (768 dimensions).
It can instead use Ollama or any OpenAI-compatible `/embeddings` endpoint:

```bash
cogmem install --yes \
  --provider mg --base-url http://127.0.0.1:3425/v1 --model auto/deepseek-v4.1-flash \
  --embedding-provider ollama \
  --embedding-base-url http://127.0.0.1:11434 \
  --embedding-model qwen3-embedding:0.6b
```

The installer writes the choice to the 0600 env file and probes the endpoint with one real
embedding; a provider that cannot return a vector of the configured dimension stops the install.
The keys are `COGMEM_EMBEDDING_PROVIDER` (`local` / `ollama` / `openai`),
`COGMEM_EMBEDDING_BASE_URL`, `COGMEM_EMBEDDING_MODEL`, `COGMEM_EMBEDDING_DIMENSIONS` and
`COGMEM_EMBEDDING_QUERY_PREFIX`. An OpenAI-compatible endpoint also needs
`COGMEM_EMBEDDING_API_KEY`; that key is written only to the 0600 env file and never printed.

The query prefix is part of the provider configuration because the bge-zh instruction is
model-specific: local defaults to the model card's Chinese prefix, remote models default to an
empty prefix. Set `COGMEM_EMBEDDING_QUERY_PREFIX=` to disable it explicitly.

Switching model or dimension does not silently reuse old vectors. The resident keeps
`semanticIndexEnabled()` false while the existing `ReEmbeddingPipeline` re-embeds the brain, and
falls back to lexical recall with the same honest label if the provider fails. A remote install
does not download the local 99 MiB model.

## 1. Degraded installs: what `rule_only` means

The installer asks for the model route. If you leave it unset, or the provider cannot be reached,
the install finishes degraded rather than failing: storage and literal recall work, paraphrases do
not, and `cogmem doctor` reports `WARN — installed but degraded` and names the next step.

That is a legal end state, not a broken one. Rerunning `cogmem install` with the route named finishes
it:

```bash
export MG_API_KEY=...
cogmem install --yes --provider openai_compatible --base-url https://api.example.com/openai --model your-model
cogmem doctor
```

`doctor` goes back to `OK — installed and working` once a real memory model answers.

## 2. The kernel configuration file

The companion installer writes its own settings, so a kernel `.cogmem/config.toml` is not created by
any command. One is still read when you pass `--config <config.toml>`; every role has its own section:

```toml
[embedding]
provider = "deterministic_local"   # or "openai_compatible"

[memory_model]
provider = "openai_compatible"     # or "rule_only" / "anthropic"
base_url = "http://127.0.0.1:11434/v1"
model = "your-model"
api_key = "${COGMEM_MODEL_KEY}"

[reasoning_model]
provider = "openai_compatible"
base_url = "http://127.0.0.1:11434/v1"
model = "your-model"
api_key = "${COGMEM_MODEL_KEY}"
```

`api_key` (and `base_url`, and `model`) accept `${ENV_VAR}` interpolation, so the secret can stay
in the environment instead of the file. Valid providers are `deterministic_local` and
`openai_compatible` for `embedding`, and `rule_only`, `openai_compatible` or `anthropic` for
`memory_model` and `reasoning_model`; anything else is refused at parse time as
`invalid_model_provider` rather than silently falling back.

`memory_model` is the one that decides whether the gate is degraded: while it reads `rule_only`,
`doctor` reports the WARN. Setting it to a real provider and running `cogmem doctor` again is what
turns the gate back to `OK`.

### The language the social vocabulary speaks

Recall drops small talk before it looks anything up — `thanks so much!`, 「这次谢谢你啦」 — and the
words it matches against are **per language**. The project's own `language` selects the pack; without
it, the Chinese vocabulary is the one in use:

```toml
[project]
language = "en"        # zh is the default when nothing is declared
```

Both spellings are accepted — `[project] language` wins over a top-level `language`, the same way
`timezone` works. One language per project, so a project whose turns are English wants them declared:
measured on a fresh install, `thanks so much!` comes back with an answer while no language is declared,
and comes back empty with `residue_empty` once `language = "en"` is set.

## 3. Installer environment variables

`install.sh` installs the package and links the CLI, then stops. It never runs the wizard and
never writes config, so `curl | bash` cannot ask questions on one machine and invent answers on
another.

| Variable | What it does |
| --- | --- |
| `COGMEM_SKIP_INIT` | Still accepted, and now does nothing. |
| `COGMEM_PACKAGE_SPEC` | Selects what is installed: a version, a range, a tarball, a path, or a URL or `npm:`/`github:` location. |
| `COGMEM_NPM_SPEC`, `COGMEM_RELEASE_TARBALL` | Older names for the same setting, in that order of precedence. |
| `COGMEM_INSTALL_HOME`, `COGMEM_BIN_DIR` | Move the package home and the linked CLI, so the same script installs a locally packed build without the package itself coming from the registry — its dependencies still resolve from the registry unless they are already cached. |
| `COGMEM_UPDATE_CHECK` | `0` turns the version check off for this process, the same switch `[update] check = false` sets. |
| `COGMEM_UPDATE_REGISTRY` | The registry the version check reads, for a mirror or a private one. Defaults to `https://registry.npmjs.org`. |

A `github:` or `git+https:` spec is treated as source: the package is installed with lifecycle
scripts off, built where it landed and relinked, because bun does not install a git dependency's
devDependencies before its `prepare` and the build would otherwise fail and roll the install back.

If the next command reports `cogmem: command not found`, the CLI was linked into a directory
outside your `PATH`. The installer prints the exact `export` line to fix it, and `cogmem doctor`
reports the same directory as a WARN.

## 4. Staying current

Cog checks the registry for a newer release once a day, and tells you when there is one. It is
worth saying what the check does *not* do: it reads version metadata only, sends nothing about this
machine, and never waits on the network during a command — a detached helper does the read and
writes `~/.cogmem/update-check.json`, and the command you ran reads that cache and finishes. A
failed read is silent and is cached too, for an hour, so an offline machine retries tomorrow rather
than on every command.

When a newer release exists, a normal command adds one line on stderr:

```
cogmem <latest> is available (you have <current>). Run `/upgrade` in `cog`; it stops the resident, swaps the package, verifies it and starts it again.
```

`cogmem doctor` reports the same thing in full, and separates three facts that an upgrade can leave
disagreeing: the **disk** version, the **latest** release, and the **serving** version of a resident
process. When a resident is still serving an older tree, doctor says so explicitly — `the resident
process is still serving <serving> …; the disk is at <disk>` — and `--json` carries
`version.disk`, `version.latest`, `version.updateAvailable`, `version.serving`, `version.skew` and
`version.restartRequired`.

### Turning the check off

```toml
[update]
check = false
```

Nothing is read, and no line is added to any command's output. `COGMEM_UPDATE_CHECK=0` does the same
for one process.

### Upgrading

The resident upgrades itself from `/upgrade` in `cog`. It stages the next package beside the
serving one, snapshots the brain before the new version opens it, runs the health gate, and rolls
back if any check fails. Only a silent resident (`IDLE` or `DORMANT`) may start it, and the result
is reported on the next attach. There is no automatic upgrade and no second command: the contract
is in [`shell/UPGRADE.md`](https://github.com/liuqin164/Cog/blob/main/shell/UPGRADE.md).

## 5. Platforms

The resident is a user-level service: a systemd user unit on Linux, a launchd agent on macOS. It
does not need root. Windows is not supported; `cogmem install` refuses the platform at preflight,
before any install step runs, rather than half-installing. The runtime is Bun; the package declares
`engines.bun` and does not support Node for the resident.

macOS has no bubblewrap (`bwrap`), so the bash tool has no isolation boundary there. The companion
stays usable and reports the fact: `/status` and `doctor` show `sandbox: off`, and startup writes
`bash_sandbox_unavailable` to the trace. On Linux the installer probes bwrap; when it is missing,
the same report appears and the hint names the package to install.

The Linux unit runs with `ProtectSystem=strict` and `ProtectHome=read-only`; the workspace and the
data directory are the only writable paths, carved out with `ReadWritePaths` because both may live
under `$HOME`. `NoNewPrivileges`, `PrivateTmp`, `RestrictSUIDSGID`, `LockPersonality` and an
address-family allowlist (`AF_UNIX` for the attach socket, `AF_INET`/`AF_INET6` for the loopback
HTTP face, `AF_NETLINK` for interface discovery) complete the sandbox. The unit restarts a crashed
resident, but `StartLimitIntervalSec=300` / `StartLimitBurst=5` stop a deterministic crash loop so
the last log survives; `doctor` reports a unit that stopped that way instead of calling it healthy.

## 6. Old databases, snapshots and encryption

A database created before 4.0 cannot be opened by this release. It is identified and refused with
a message beginning `no_upgrade_path:`; the file is left byte-for-byte unchanged, with no backup
written beside it and no partial rewrite. Keep the old install for that file. To move the history
forward, export the conversations from the old install into files, create a new database, and
import those files (`cogmem import openclaw` / `cogmem import hermes`, or
`cogmem episode import --format jsonl --file <path>`). Importing the old database or a snapshot of
it is not a migration — it meets the same refusal.

The nightly snapshot and the weekly archive are complete copies of the SQLite database in
plaintext. They live under `<data dir>/snapshots` with mode 0700, but mode 0700 is not encryption:
anyone who can read the disk, or a copy of it, can read every remembered turn. Use full-disk or
volume encryption (LUKS, FileVault, an encrypted directory) when the machine may be lost, shared
or backed up off-device. A range deletion removes the local snapshots, archives and exports that
were created after the earliest deleted row (see
[memory-sovereignty.md](memory-sovereignty.md)); copies exported outside the data directory and
backups already moved to another machine are not reached. See [SECURITY.md](../SECURITY.md).
