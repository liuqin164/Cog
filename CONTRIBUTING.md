# Contributing

## Setup

`dist/` is not tracked (#53), so a source checkout must be built before anything that reads build
output — the test gate runs after the build.

```bash
bun install
bun run build
bun run typecheck
bun test
```

## Pull Request Gate

Before opening a pull request, run:

```bash
bun run build
bun run typecheck
TMPDIR="$PWD/.cogmem/tmp" bun test __tests__
cd shell && bun install --frozen-lockfile && bun test test && cd ..
bun run leak:check
npm pack --dry-run --json
```

`cogmem` is distributed through the npm registry. **This is not the PR gate.** Publishing is the
point of no return for a version. Normal publishing creates a GitHub Release from the matching
version tag (`v5.0.0` or `5.0.0`); `.github/workflows/publish.yml` runs on the release `published`
event, refuses a tag that does not match `package.json` or a version already on npm, and then
publishes with provenance. Tag pushes alone do not publish. Do not tag or publish while 5.0 is
unreleased without the owner's explicit go-ahead. Use `npm pack --dry-run --json` to verify
package contents. Use `npm publish --provenance --access public` only as an emergency manual
fallback.

## API Discipline

Only explicitly exported symbols in `src/public.ts` are public. Do not re-export `src/internal.ts` from the package entrypoint.

## Adapter Changes

Agent-specific code must keep core independent from agent runtimes. Prefer a narrow workspace profile plus fixture-backed tests over importing another runtime.
