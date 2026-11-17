# Procedure emergence A/B (#265 D5)

One command from the repository root (the temp root is the suite's usual one):

```bash
TMPDIR="$PWD/.cogmem/tmp" bun eval/procedure-emergence/run.ts
```

It measures the three things #265 asks for, in one pass over ten repeatable
chores. `--limit N` runs a prefix, `--only <task>` a single chore, and
`--report-only` re-renders `results.md` from the existing `results.json`.

1. **Producer trigger rate.** Each chore runs once through a real tool loop with
   the shell's `read` / `write` / `edit` / `bash` / `declare_task` descriptions,
   the production `declare_task` text, and an `<open-assignment>` block, exactly
   the shape the shell gives the front model. The run counts `declare_task end`
   calls that also filled a domain and a key — the only shape that writes a
   practice.
2. **Deterministic fallback.** From the captured tool calls alone the harness
   derives `steps` (one per real call, as `procedureEvidenceOf` does) and
   `tools`. `domain` and `key` are not in the trajectory: the fallback takes the
   domain from the tool mix (`shell` / `file-edit`) and the key from the first
   user line. The derived entry is recorded in a throwaway kernel and the real
   `ProcedureCompiler` is asked, with the repeat prompt, whether it surfaces it.
3. **A/B.** The repeat prompt runs twice against a reset workspace: once with
   nothing, once with the practice as a `<procedure-lane>` block. The practice
   is the declared entry where one exists, otherwise the derived fallback.

No product code changes and no live database is opened; the kernel is a temp
SQLite file that is closed at the end. Each run gets a fresh workspace under the
temporary root; nothing is left behind.

## Corpus

Ten small file/shell chores: create a list file, count ERROR lines, extract TODO
lines, convert TSV to CSV, rename a JSON key, merge two JSON files, summarise
headings, fix a shell script, list `.txt` files. Each has a first prompt and a
rephrased repeat prompt; the checker reads the workspace afterwards.

The chores are deliberately small. They are the shape Susan's box run used (tool
tasks that end in a file), not a stand-in for multi-hour work.

## Measured (2026-11-17)

Model `auto/deepseek-v4.1-flash`, temperature 0, one sample per cell, head
`f74b3b2b51f4`.

**Trigger.** 6/10 first runs ended with `declare_task end` and a domain+key;
`start` was called 0/10 times. The box sample of 0/2 tool tasks did **not**
reproduce here: when the open assignment is in the prompt and the user line is
a bounded chore, the producer fires at 60%.

**Fallback.** Steps and tools were derivable for 10/10 runs. The derived entry
was recalled by the real compiler for 10/10 repeat prompts, but ranked first
for only 4/10, and 9/10 lanes also carried another task's entry. The declared
entries were recalled 6/6 (2/6 first). Cue matching without a model is
permissive at ten entries.

**A/B.**

| | without practice | with practice |
| --- | ---: | ---: |
| correct | 9/10 | 10/10 |
| prompt tokens | 87,366 | 107,148 (+22.6%) |
| median per-task token delta | — | +9.8% |
| tasks cheaper / dearer (±2%) | — | 3 / 6 |
| mean rounds | 6.10 | 6.50 |
| mean tool calls | 5.60 | 5.20 |
| tool errors | 17 | 10 |

The first attempt (different prompt, no practice) averaged 8,932 tokens and the
repeat without the practice 8,737, so repetition alone is not the effect being
measured. One task (`fix-script`) accounts for most of the token regression
(8,595 → 24,512, 6 → 12 rounds); the median delta is the fairer summary and it
is still positive.

## Conclusion

- **Do not promote D5 on this evidence.** The practice did not save steps or
  tokens; it cost 22.6% more tokens (median +9.8%, dearer in 6/10 tasks) for the
  same completion, with one task fixed and tool errors down 17 → 10. That is a
  weak correctness signal at n=10, not a value case.
- **The producer is not the only problem.** At 60% trigger rate in this shape,
  the book would not be empty, so "declared practice" does not need a
  correctness fallback for coverage alone.
- **A deterministic fallback is feasible for steps and tools, not for the
  name.** Domain and key remain a semantic judgement; the first-user-line key
  is recallable but imprecise (4/10 rank-1, 9/10 lanes with a foreign entry).
  If the fallback is built, it should be a candidate descriptor for confirmation,
  not a silent write.

## Bounds

- Ten small chores, one model, one sample per cell; a practice that pays on
  larger or genuinely repeated tasks is not excluded.
- The harness emulates the shell's tool loop and injects one lane; it does not
  reproduce the real assembler, budget drops, or prompt caching.
- The workspace is reset before every attempt, so the second attempt cannot
  cheat by finding the first attempt's files; equally, it does not test
  "continue the same workspace", which is a different question.
- `declare_task` is offered with the production description and accepted
  unconditionally; the real shell refuses it outside a user-present work run,
  which this harness always is.
