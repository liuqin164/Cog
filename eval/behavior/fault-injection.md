# F13 fault-injection record (#167)

Subject: `bf87d7c` (the behaviour-eval contract, scenarios and runner). The injection ran in a
scratch worktree, never in the main checkout.

## Injection

File: `src/security/LifeSensitivity.ts`
Function: `eventHoldsLifeSensitivityMark()`

```diff
-  return tier === 'private' || tier === 'high';
+  return false && (tier === 'private' || tier === 'high');
```

This is the shared mark predicate every default recall lane consults. Releasing it lets life-marked
turns into the ordinary lane while leaving the surfacing tag source and the explicit forensic intent
alone — the ticket's "放行生活敏感内容进默认车道" fault.

## Red run

Command:

```bash
TMPDIR=/home/ubuntu/projects/Cogmem/.cogmem/tmp bun eval/behavior/run.ts --json
```

Exit: `1`. Summary: `14 pass / 2 fail / 16 scenarios`.

| Red scenario | Failure |
|---|---|
| `withhold-life-default` | `C1 default lane: found "处方" in "医生给我开了处方，诊断是高血压，zephyrmark。"` |
| `correct-life-tier` | `C1 default recall withholds: found "处方" in "医生给我开了处方，诊断是高血压，lifecorrectmark。"` |

The red set is exactly the register's expected set in `docs/behavior-eval.md`. The life-occasion,
secret and pause scenarios stayed green, which is the point: F8's occasion gate, #142's keychain
hard withhold and F9's write-path pause are separate mechanisms and were not broken.

## Restored run

The file was restored with `git checkout -- src/security/LifeSensitivity.ts`; `git status --short`
was clean apart from the scratch `node_modules` symlink. The same command then exited `0` with
`16 pass / 0 fail / 16 scenarios`. The worktree was removed after the run.

## Scope note

The first attempt disabled only the life check in
`KernelAgentMemoryBackend.isRawEventInRecallScope()`. The suite stayed green: the raw-ledger fallback
consulted the shared mark predicate as well. The injection above is the one recorded because it is
the policy point, not a single call site. This is evidence that the scenarios drive the actual read
path rather than one accidental branch.
