# DF3.6b — code review round 15 (CodeRabbit recovers; two real findings, one declined on evidence)

**Date:** 2026-09-20 · **Trigger:** CodeRabbit returned at 03:55Z after ~65 minutes of silence across
two acknowledged requests, with three Minors on the round-14 push.

## The three findings

| # | Site | Verdict |
|---|------|---------|
| 1 | story, INV-MEM-1's security invariant | **Real.** Two sites still carried a claim the invariant itself retracted in round 1. |
| 2 | `src/fleet/resident.ts`, the `removeLeaf` EBUSY backoff | **Declined** — the premise is false on this runtime. The swap was made anyway, for a different reason. |
| 3 | `tests/providers/exedev/image-assets.test.ts`, one negative control | **Real, and the serious one.** A control row that could not fail. |

## Finding 3 — a negative control that never reached the guard it names

The fence suite's row *"commented out by a `#` on an EARLIER line of the same RUN"* built its mutant
without the Dockerfile line-continuation backslash. The injected line therefore **ended the RUN**,
`${scan}` fell outside the extracted slice, and `fencedFatally` returned at its missing-line guard —
never reaching `commentStartsAt`, the check the row exists to exercise.

Confirmed by mutation before fixing: deleting `if (commentStartsAt(before) !== -1) return false;`
left the entire file green. Backslash added; the row now goes red under that same mutation, and names
itself when it does.

**This is the fourth vacuous-control defect on this branch** (M1's default-assertion, the timeout test
SIGKILLing before it staged, the `$'`-expanding string replacements, and now a dropped line
continuation). Every one passed while asserting nothing, and none was visible by reading — each fell
out of deleting the requirement and watching the control stay green. Writing the mutation check is
not optional discipline on this file; it is the only thing that has ever caught this class.

Because one vacuous row implies the method that produced it, a reviewer audited **all ten rows** the
same way, mapping each to the guard that actually rejects it:

| Guard | Rows it rejects |
|-------|-----------------|
| missing-line | "commented out" (the outer `strip()` removes the whole line first), "target repointed off the unit", "deleted outright" |
| startsWith (position anchor) | "mid-line shell comment", "wrapped in a skip conditional", "guarded with an `&&` prefix" |
| fatal-tail regex | "made non-fatal with `\|\| true`", "fatal tail present but unreachable" |
| `commentStartsAt` | "commented out by a `#` on an EARLIER line" — uniquely, confirmed live |
| unit-reassignment | "unit reassigned between the anchor and the scan" |

Every row is rejected by a guard consistent with its label, and the positive control is not masking
anything. No further vacuous rows.

## Finding 1 — the security invariant, stale in three places

INV-MEM-1 originally said the bound is "outside the resident's address space" and "not a value pi's
own process can read or write as data". Review round 1 retracted that: under `Delegate=memory` the
leaf is created as `User=exedev` and pi is `exec`'d into it **as the same uid**, so `memory.max` is a
file pi's uid OWNS. What keeps the bound out of pi's reach is that pi is spawned **`--no-tools`** —
load-bearing security configuration, not a cost knob.

The amendment was written in round 1 and three copies of the wrong framing survived it:

1. The Technical Notes copy, unamended, giving the retracted reason as settled fact.
2. **INV-MEM-1's own lead sentence**, which asserted the retracted clause directly ABOVE its own
   amendment. Exactly the shape of ruling 9's setup paragraph, found the same way — a reader who
   stops at the lead sentence gets the wrong answer.
3. `df3-6a-resident-spend-iteration-bounds.md` — a **sibling story**, citing INV-MEM-1's old shape in
   INV-BND-1's own text with no amendment note. Outside this story strictly; corrected anyway,
   because a false security claim pointing at this story's invariant is this story's problem.

A sweep cleared the two things that would have been worse than documentation:

- **`--no-tools` is on every production resident spawn path.** There is exactly one `Bun.spawn` call
  site for pi and the flag is unconditional in its argv.
- **It is pinned by a test.** `tests/fleet/resident.test.ts:494` asserts the whole spawn argv by
  strict array equality, so an edit dropping `--no-tools` fails a test rather than silently removing
  the containment.

## Finding 2 — declined on evidence, then adopted for a different reason

CodeRabbit: *"When `rmdirSync(dir)` throws `EBUSY` on Bun's main thread, `Atomics.wait` throws
`TypeError`."* Probed on Bun 1.3.13 — bare, inside a `catch` after a real synchronous `fs` throw, and
inside a genuine `Worker`. Every call returns `"timed-out"`. It does not throw. `removeLeaf` also has
no path off the main JS thread: the file has no `worker_threads` usage, and `Bun.spawn` creates an OS
subprocess, not a JS thread.

**The premise is false, so the finding is declined.** But two things about it were right and are kept:

- The stated CONSEQUENCE was accurate. The call is not inside its own `try`, so a throw there would
  escape `removeLeaf` entirely and abandon the bounded retry — worse than the last-attempt path,
  which rethrows the original `EBUSY` deliberately. The finding was moot only because of its premise.
- The premise is **wrong, not unreasonable** — it is true in browsers, where the restriction exists to
  stop a page blocking its UI thread.

So the swap to `Bun.sleepSync` was made anyway, on a reason CodeRabbit did not give: a sleep spelled
as an atomics primitive on a throwaway `SharedArrayBuffer` is what drew this finding, and it will draw
the same wrong finding again. The comment now records the probe, so the next reader finds the evidence
rather than re-litigating it. **The commit does not repeat the bot's incorrect justification.**

## Gates

`bunx tsc --noEmit` clean, Biome clean, `check-story-consistency` OK across 42 stories. Focal suites
green. `src/fleet/resident.ts` is a walked input, so the buildId is re-pinned in this commit.
