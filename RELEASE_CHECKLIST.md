# Cog 5.0.0 Release Checklist

This release is distributed through the npm registry. GitHub remains the source and review mirror.
Every item below is a command or a file fact. A claim that cannot be checked mechanically is not
on this list. Paste the command output beside the checkbox in the release issue.

## Old-Database Refusal

5.0 has no upgrade path for a database created before 4.0. The release rehearsal is the refusal
itself: build a pre-4.0-shaped file, confirm 5.0 refuses it, and confirm the bytes did not change.

```bash
work="$PWD/.cogmem/tmp/release-olddb"
mkdir -p "$work"
export OLD_DB="$work/schema31.db"
bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.env.OLD_DB ?? ".cogmem/tmp/release-olddb/schema31.db");
db.exec(`
  CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE _schema_migrations (version TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL);
`);
db.prepare("INSERT INTO _meta (key, value) VALUES (?, ?)").run("schema_version", "31");
for (let version = 15; version <= 31; version += 1) {
  db.prepare("INSERT INTO _schema_migrations (version, description, applied_at) VALUES (?, ?, ?)")
    .run(String(version).padStart(4, "0"), "legacy", "2026-01-01T00:00:00.000Z");
}
db.close();
'
sha256sum "$OLD_DB" > "$OLD_DB.before.sha256"
cogmem memory recall --query x --db "$OLD_DB" --timezone UTC --json
sha256sum -c "$OLD_DB.before.sha256"
cogmem memory status --db "$work/fresh-5.0.db" --json
```

- [ ] The old file exits non-zero with `"reason": "no_upgrade_path"`, and `sha256sum -c` prints
      `OK` (no backup, no partial rewrite). `memory status` reports counters and does not open the
      kernel, so it is not the refusal command.
- [ ] The fresh file answers with the raw and Dream counters.
- [ ] The refusal text names the supported path: export from the old install, then
      `cogmem import openclaw|hermes` or `cogmem episode import`.

## Required Metadata

- [ ] `package.json` has `name = cogmem`, `version = 5.0.0`, and `publishConfig.access = public`.
- [ ] Public export `.` points to `dist/public.js` and `dist/public.d.ts`; `./web` is the
      only other subpath.
- [ ] `package.json` declares exactly two bins, `cog` and `cogmem`, and both source entrypoints
      exist (`__tests__/release-metadata.unit.test.ts`).
- [ ] `files` includes `install.sh`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
      `RELEASE_CHECKLIST.md`, `docs/install.md`, and `docs/agent-install.md`.
- [ ] `git ls-files dist` prints nothing; no local database, SQLite sidecar, `.DS_Store`, or
      `dist/.tsbuildinfo` is tracked.
- [ ] The `cogmem-*` aliases were removed in 4.0 (#112); the `cogmem-mcp` bin went with the MCP
      surface in 5.0 (R2 of #200).
- [ ] `CHANGELOG.md` has `## 5.0.0`, and its entry names what was removed or merged (#52).

## Local Gates

Run from the repository root, in this order:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
TMPDIR="$PWD/.cogmem/tmp" bun test __tests__
cd shell && bun install --frozen-lockfile && bun test test && cd ..
bun run leak:check
npm pack --dry-run --json
```

- [ ] Every command exits 0. Record the root suite's `pass` / `fail` / files and the shell suite's
      counts, with the `TMPDIR` used.
- [ ] The shipped-doc guards pass inside the root suite: `release-metadata.unit.test.ts`,
      `agent-install-doc.unit.test.ts`, and `install-doc.unit.test.ts`.
- [ ] `npm pack --dry-run --json` includes built `dist/**` files, `install.sh`, `docs/install.md`,
      and `docs/agent-install.md`, and includes no local database or machine-specific file.
- [ ] `bun run ci:status` reports the push to `main` green. CI runs `prepublishOnly` plus the shell
      suite and `leak:check` (`.github/workflows/ci.yml`).

## Install Path

- [ ] `__tests__/installer-script.unit.test.ts` passes: `install.sh` links the bins the package
      declares, not a `cogmem*` glob.
- [ ] In a clean `HOME`, package home, and bin directory, `install.sh` leaves both `cog --help`
      and `cogmem --version` executable. Record the two commands and their exit codes.

## Box Gate

- [ ] The 5.0 seven-day survival run has a recorded result on #165.
- [ ] The F13 companion-behaviour evaluation on the same box is green (result on #167).
- [ ] The box is back in first-install state and `Paused`, following the cleanup list in
      `docs/box.md`.

## Publish

- [ ] The version tag points at the reviewed `main` commit and matches `package.json` (`5.0.0` or
      `v5.0.0`).
- [ ] A GitHub Release is created from that tag. `publish.yml` runs on `release: published`, not
      on a tag push, and refuses a mismatched tag or an already-published version.
- [ ] `publish.yml` runs the root suite, the shell suite and `leak:check`, and refuses to publish
      unless the tagged commit's `.github/workflows/ci.yml` run conclusion is `success`.
- [ ] The rehearsal was dispatched from this branch (`gh workflow run publish.yml --ref <branch>`):
      the shell suite and `leak:check` ran, a non-green CI stopped the flow, and the publish step
      did not run.
- [ ] `npm view cogmem@5.0.0 version` prints `5.0.0`.
- [ ] `npm view cogmem dist-tags.latest` prints `5.0.0`.
- [ ] Emergency manual fallback only: `npm publish --provenance --access public`.
