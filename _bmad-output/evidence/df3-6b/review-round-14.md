# DF3.6b — code review round 14 (a covering review, because the bot went quiet)

**Date:** 2026-09-19 · **Trigger:** CodeRabbit acknowledged two full-review requests (02:53Z, 03:19Z)
and posted no review for ~55 minutes against a 12–15 minute norm on this PR. Rather than stall the
monitor loop, the disabled-bot path applies: keep polling, and cover the gap locally.

## Why this round looked where it did

Thirteen rounds had become documentation-weighted — rounds 10, 12 and 13 each found the PREVIOUS
round's record defective rather than its code. That is a reasonable thing for review to converge on
and a bad thing for it to stay on, because the shipped mechanism stops being read. So the covering
review was pointed at `git diff origin/dev...HEAD` in full, at the CODE, with documentation nits
explicitly out of scope, and asked for leaks, teardown races, fail-open classification, and claims
the tests do not actually cover.

It found one, in the last category.

## The finding — a latch that only unsets on process exit

`scripts/pipeline-run.ts` carried `inBoxFrontDoor` as a **module-level `let`**, set `true`
immediately before the in-box re-entry and never reset:

```ts
let inBoxFrontDoor = false;              // module scope
…
inBoxFrontDoor = true;                   // before `return main(deriveInBoxArgv(runId))`
…
residentRssBytes: inBoxFrontDoor ? loadedBounds.residentRssBytes : undefined,
```

The flag exists for INV-MEM-2's Scope clause: the in-box front door (`run <runId>`) supplies the
bound, the host-side `--manifest` shape must NEVER receive one, because darwin has no cgroups and
passing a bound there silently disarms DF3.3's and DF3.6a's whole host-side behavioural coverage. The
surrounding comment argues that hazard at length. **The latch's own shape then reintroduced it one
level up.**

One process per invocation makes this unreachable in the shipped CLI, and invisible to the suite:
every test reaches this file through `Bun.spawn`, so a latch that unsets only on process exit cannot
be observed. It is a landmine for any in-process reuse of `main()` — a batch runner, a worker, a
harness that imports it. The first in-box run pins it `true` for the process's life; a later
host-side call then forwards a real `residentRssBytes` into `startResident`, hits
`ensureDelegatedSubtree()` on a box with no delegated cgroup, and refuses the resident on precisely
the shape the flag exists to keep unarmed.

**Fix: make it a parameter** — `main(argv, inBoxFrontDoor = false)`, with the recursive call passing
`true`. Each invocation gets its own binding, so the hazard is structurally foreclosed rather than
documented.

## Verification — three reviews, one of them empirical

| Reviewer | Method | Result |
|----------|--------|--------|
| covering | whole-branch read, code-focused | Found the latch. Cleared the leaf lifecycle, the `stop()`-vs-in-flight-`call()` teardown ownership race, the placement script's argv shifting, the OOM arm's ordering, and the refresh precedence — each against the tests that exercise them. |
| A | static, adversarial | Clean. Answered the question that decides whether the fix is a regression: **the `residentRssBytes` read executes in the INNER `main` invocation only**, because the outer `return`s the recursive call and never falls through. The parameter therefore reproduces the old behaviour exactly. |
| B | empirical, in a throwaway worktree | Reproduced both halves. |

B's run is the part worth keeping. It established, by execution rather than argument:

1. **No existing test distinguishes the two implementations.** The three suites that exercise this
   file pass identically at HEAD (module-level `let`) and on the fix: 103 pass, 0 fail both ways.
2. **The failure is constructible.** Driving two sequential in-process `main()` calls — leg 1 in-box,
   leg 2 host-side, same process — the OLD code emits
   `{"event":"resident_disabled","reason":"rss_unenforceable","detail":"/proc/self/cgroup is unreadable…"}`
   on leg 2: a host-side run degraded by cgroup machinery it should never have touched. The NEW code
   runs leg 2 clean — `resident_solicit` and `cost_attribution`, no disable, no refusal.

So: a genuine state-isolation defect, with zero live callers today. Not theoretical — the leak was
triggered, not inferred — and not currently reachable. Recorded as hardening with a demonstrated
failure mode, which is a more useful thing to know than either label alone.

**No test was added.** `main` is module-private and the file self-executes on `import.meta.main`, so
covering this would mean exporting `main` and running the CLI in-process — a larger change to the
shipped file than the fix itself, to pin a state variable the fix deletes. The parameter has no state
to leak; there is nothing left for a test to catch.

## Also noted, and declined

`startResident`'s arming probe cleans up its probe leaf under a bare `catch {}` with no diagnostic —
the one silent catch in `resident.ts` without one. The reviewer could not construct a path that
reaches it for a real reason (nothing runs inside that leaf), and `warn` is not yet in scope at that
point in the function. Left as is: adding the plumbing to report an unreachable failure is a worse
trade than the observability it buys. Named here so the next reader finds it considered rather than
missed.

## Gates

`bunx tsc --noEmit` clean, Biome clean, `check-story-consistency` OK. Focal suites 103 pass / 0 fail.
`scripts/pipeline-run.ts` IS a walked input, so the buildId is re-pinned in this commit.
