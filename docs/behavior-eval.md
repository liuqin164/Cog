# Companion behaviour evaluation (F13, #167)

This is the 5.0 release gate for companion behaviour, not another unit-test file. It decides whether
Cog **remembered what it should, surfaced what it should, withheld what it must, and changed after
being corrected**. The pass standard is written inside each scenario before the run; the runner only
executes it and reports what happened.

The code is `eval/behavior/` and this document is held by
`__tests__/behavior-eval.contract.test.ts`. Version: `BEHAVIOR_EVAL_CONTRACT_VERSION = 1`.

## What this is not

- **No free conversation and no model judge.** A scenario scripts inputs and asserts on the ledger,
  the four books, the surfacing decision or the decision trace. A model may have produced an offline
  extraction, but its output is pinned in the scenario as a fixture.
- **No new kernel behaviour.** The suite drives the landed public faces through `src/public.ts`.
  When a scenario exposes a product bug, the round reports or files it; the scenario is not bent to
  the implementation.
- **No sleeping and no ambient clock in assertions.** Every instant the assertions depend on is a
  constant or is read back from the kernel's own recorded state. The runner calls `runWakeTick` and
  surfacing with explicit `now` values and never sleeps. F9's pause instant is the one value the
  kernel records itself; the pause scenario reads it back from `sovereignty.pause`.
- **No box-only path.** The same files run in fixture mode on a source checkout and against an
  installed package on the box.

## Categories (frozen)

| Category | Question |
|---|---|
| `record` | Did the thing that should be remembered reach the right book after capture and compilation? |
| `surface` | Did the due promise, wake intention or learned procedure appear at the right moment, once? |
| `withhold` | Did life-sensitive, secret or paused material stay out of the lanes that must not show it? |
| `correct` | After an owner correction or veto, did every later read agree with the new value? |

Each category has at least four scenarios. The register below is the frozen list.

## Scenario schema (frozen)

| Field | Means |
|---|---|
| `id` | Stable scenario id; the red set in fault injection names these. |
| `category` | One of the four categories above. |
| `title` | One-line scene, repeated verbatim in this document. |
| `criteria` | The written pass standard, one entry per assertion group. |
| `pinned` | What the scenario fixes, so no model output or ambient time decides the result. |
| `run` | The deterministic driver; it may only assert the written criteria. |

## Scenario register (frozen)

| ID | Category | Scene |
|---|---|---|
| `record-profile-books` | `record` | A stated fact and preference reach the profile ledgers with the source turn |
| `record-procedure-book` | `record` | Two same-domain task attempts compile the tools and steps into the procedure book |
| `record-commitment-book` | `record` | A matter-of-fact promise enters the commitment book with owner, content and due |
| `record-intention-book` | `record` | An agent plan stated in conversation enters the intention ledger as active |
| `surface-commitment-once` | `surface` | An arrived promise is offered at its due instant and not offered a second time |
| `surface-wake-on-time` | `surface` | A registered wake intention fires at its instant, once, and not before or after |
| `surface-task-preference` | `surface` | The second same-domain task assembly carries the learned procedure and the owner preference |
| `surface-prospective-once` | `surface` | A confirmed due reminder announces once and does not replay after a restart |
| `withhold-life-default` | `withhold` | A life-marked turn stays out of default recall and is reached by the forensic intent |
| `withhold-life-occasion` | `withhold` | Life-marked material is withheld in group and public even when asked or forensic |
| `withhold-secret-all-channels` | `withhold` | Secret-marked text is hard-withheld from both surfacing channels and default recall |
| `withhold-pause` | `withhold` | A paused project records nothing during the pause, so nothing can surface later |
| `correct-profile-preference` | `correct` | Correcting a preference replaces it in every subsequent read, keeping the old version in history |
| `correct-profile-fact` | `correct` | Correcting a standing fact reaches the original source and the profile recall agrees |
| `correct-life-tier` | `correct` | Correcting a life-sensitivity mark changes every later recall and surfacing read |
| `correct-intention-veto` | `correct` | An owner veto closes the plan everywhere, including after a restart |

## Criteria discipline

A scenario's `criteria` entries are the contract. They are written from the ticket's behaviours
before the implementation is consulted, and each assertion message names its `C1`/`C2`/`C3` group.
When a criterion and the implementation disagree, the conflict is reported with the failing
scenario; the criterion is not relaxed to make the suite green.

The assertions are deterministic:

- instants are constants or read back from the kernel's recorded state, and passed to
  `runWakeTick`, `compile` and surfacing reads;
- the write path and the compilers run locally; no network or model is called;
- model-owned extraction is pinned as a fixture in the scenario's `pinned` list;
- a scenario creates its own SQLite database under `TMPDIR` and removes it afterwards.

## Fault injection (frozen)

The suite proves itself by being made to fail. The injection is applied only in a scratch copy of
the tree; the main checkout never carries the broken line.

| Injection | Target | Expected red scenarios |
|---|---|---|
| `life-default-lane-open` | `eventHoldsLifeSensitivityMark()` in `src/security/LifeSensitivity.ts` | `withhold-life-default`, `correct-life-tier` |

Protocol:

1. Create a scratch worktree/copy of the committed head and apply one line-level patch that breaks
   the named gate.
2. Run `bun eval/behavior/run.ts --json` in the scratch copy. The suite must exit non-zero, and the
   red set must be exactly the expected scenarios above. A red scenario outside the set is a finding
   about the suite; a green expected scenario means the suite does not guard that gate.
3. Restore the line and rerun; all scenarios must pass.
4. Record the patch (file, line, before/after), the red run's IDs and the restored run's summary in
   the round report on the issue/PR.

## Running

Fixture mode against the checkout (the same mode CI and a local developer use):

```bash
TMPDIR="$PWD/.cogmem/tmp" bun eval/behavior/run.ts
```

Installed-package mode on the box, after the candidate tarball is installed:

```bash
bun eval/behavior/run.ts --module /data/home/.npm-global/lib/node_modules/cogmem/dist/public.js
```

`--filter <id-or-category>` narrows the run. `--repeat N` reruns every selected scenario N times and
fails if any attempt fails. `--json` emits the machine-readable result used in the round evidence.

The full suite also runs inside `bun test __tests__` through
`__tests__/behavior-eval.contract.test.ts`, so a green ordinary test run includes the behaviour gate.
