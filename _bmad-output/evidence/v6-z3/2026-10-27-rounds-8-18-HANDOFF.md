# Z3 live exit round — handoff (2026-10-27 ~03:05 UTC)

Status at stop: **round 18 reached the deepest point of the arc ever
(trigger → 3 QA legs closed+retained → crash window → redrive → priming),
every prior failure class fixed and proven, and the remaining red is a
STORY-CONTRACT decision, not a code bug.**

## The one remaining blocker — operator decision needed

The QA legs hunt `git diff HEAD~1..HEAD -- <lens scopes>` at the pinned sha
(QDS_EXEDEV_SHA). Tonight's pin (dev / the fix branches) touches
`scripts/z3` + `tests/z3` — the A2-era lens scopes cover `src/qa`,
`scripts/qa`, `tests/qa`. The worker's own report (round 17 leg 1,
`qds-20261027-1ffaa2` worker_output):

> "Bounded review set is empty: git diff --name-only HEAD~1..HEAD -- src/qa
> scripts/qa tests/qa returned zero paths … no findings to report."

So: zero findings per leg → sidecar zero → bank gets nothing this round →
`priming-recall` reds by contract ("the code run's <kg_context> cites no
finding this round retained"). The chain is WORKING as designed; the round
is auditing a diff its lenses don't cover.

Operator options (either unblocks the round):

1. **Extend the lens scopes** in the hunter-pack pipeline config to include
   the z3 story's own surface (`scripts/z3`, `tests/z3`) — the round then
   audits the Z3 story's own changes, which is what it is substantively
   about. Contract text ("same text both repos") would want a note.
2. **Pin QDS_EXEDEV_SHA to an in-scope commit** — any dev commit whose diff
   touches `src/qa`/`scripts/qa`/`tests/qa`. Loses "audits the round's own
   tree".

Where the scopes live: the hunter-pack manifest/brief (the worker prompt
says "Review ONLY the files in that list" — the list is derived from the
diff at the pinned sha filtered by lens scope). A2-era config.

## The night's fix ledger (all pushed, gates green at each step)

| Fix | Where | Proof |
|-----|-------|-------|
| DATA_DIR pin in qa-f3 override (base compose silently moved it to /app/data) | Solstice submodule dir, untracked | in-container probe: participants resolve |
| Recreate must include docker-compose.local.yml (devlocal stored-text keyring + original DATA_DIR) — without it the new image's instrumentation dies (StoredTextKeyringError → no daemon → "hibernation?") | runbook addition owed | daemon+scheduler verified live |
| swarmclaw#914: template reorder (legs back-to-back, observes trailing) | merged 202ebd686 | 22/22 |
| #480: settleAndTeardown (A2 cadence pair) per QA leg | merged 6b522fe0 | live-proven rounds 12-18 (every leg closed) |
| #481: QA observes move after approve (per-leg observe await deadlocked the chain) | merged 07e3490e | live-proven round 18 |
| #482 branch (5 commits): ledger readonly retry + wal_checkpoint heal (recovery runs at first READ), CR sleep-skip, 15s settle→teardown grace, **sidecar "none" arm writes the empty zero** (worker replies sometimes carry no `findings` key — model nondeterminism; absence reds a green leg) | PR #482, head 143b8840 | tsc/lint/tests green; redrive+checkpoint heal live-proven round 18 |
| swarmclaw#916: fork z3 CLI flushes state line before exit (state crossed 64 KiB → process.exit discarded the pipe tail → "Unexpected EOF") | PR #916, head d3d689b66 | byte-proven in-container (66,537 via pipe); deployed in-container via docker cp |

## Round ledger (fires tonight, GO-gated each)

- 8: arm refusal (DATA_DIR) — $0. 9: never fired (keyring) — $0.
- 10: leg-1 first-boot transient — probe proved pipeline green (~1 box-min).
- 11: killed at ~35 min — ordering flaw found (#481) — swept clean.
- 12: redrive ledger read (WAL recovery reader-side) — #482 retry+heal.
- 13: proved retry alone can't heal — checkpoint heal added.
- 14: proved open-close heal insufficient (recovery at first READ) — TRUNCATE checkpoint.
- 15/17: harvest-malformed → sidecar "none" arm root cause → zero-fix.
- 16: cleanup EOF = the 64 KiB CLI truncation (#916) — substrate was green.
- 18: **deepest** — redrive passed, priming-recall red = the lens-scope
  decision above.

Substrate between rounds: fleet empty every time, ledger $0 unreleased,
boxes swept, memgate token valid (24h from 11:52Z — EXPIRED ~11:52Z TODAY
2026-10-27; re-mint via `.unlazy/z3/mint-token.ts` before the next fire).

## Next session's steps

1. Operator: pick the lens-scope option (above).
2. Apply it, `preflightFork()` CLEAN, fresh GO (fork rev unchanged
   202ebd686f2d50d…; note the docker-cp'd CLI + pending #916/#482 merges).
3. Fire; expected arc: legs → crash window → redrive → priming (now citing
   real findings) → park → scripted approve → observes → branch_taken.
4. On green: F4 closeout as written in the sprint handoff (evidence commit
   rounds 8-N, flip Z3 done, close #913+#479, z3-round-done PR, full gates,
   fork image rebuild for #916).
