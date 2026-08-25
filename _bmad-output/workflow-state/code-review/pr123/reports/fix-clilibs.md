# W1d fix report — clilibs cluster (round 10, PR 123 / df3-1)

Branch `feature/df3-2-fanout-best-of-n`. Files touched:
`scripts/lib/run-lock.ts`, `scripts/sandbox-teardown.ts`, `scripts/lib/cost-ledger-opts.ts`,
`scripts/qds-cost.ts`, `scripts/pipeline-run.ts`,
`tests/scripts/sandbox-teardown-cli.test.ts`, `tests/scripts/qds-cost.test.ts`.

No exported signature changed. `acquireRunLock` / `releaseRunLock` / `claim` / `isAlive` /
`hostTag` / `writeLockDirect` / `markRunLockDestructive` / `clearRunLockDestructive` /
`costLedgerOpts` keep their exact signatures — fleet.ts consumers unaffected.

## Dispositions

| Finding | Verdict | What landed |
|---|---|---|
| FR1 MED | FIXED | `releaseRunLock`: once rename+verify proves the taken bytes are ours, the `.rescue` rm is best-effort (`run-lock.ts`, success branch). Non-ENOENT errors log a one-line warning via `writeStderr` and the release still succeeds; pre-rename failures stay loud. Callers no longer exit 1 over a release that succeeded after printing `torn down:`. |
| FR2 MED | FIXED | F5 ported from fleet's finally into sandbox-teardown's finally: when `destructivePhase` is set, read the record; `closedAt` present ⇒ `clearRunLockDestructive` + release + new diagnostic `lock-released-work-landed` naming the idempotent re-run. Unreadable record ⇒ hold (fail-closed). Exit stays 1 (this CLI's table is 0/1); behavior mirrors fleet's "work landed ⇒ nothing left to guard". |
| FR3 MED | FIXED | Self-pid branch in `refuse()` now requires realpath identity with an entry in `held` before marking provably stale; alias-reached own live lock (symlink/case-insensitive spelling) returns a non-stale live-holder refusal instead of advising `rm` mid-destruction. Unprovable (realpath throws) ⇒ treated as live. Recycled-predecessor case unchanged. |
| FR4 MED | FIXED | `costLedgerOpts` appends `— or point $QDS_COST_CONFIG_FILE at a readable config to proceed` to `cost-config-unreadable`/`cost-config-invalid` remediations. Still throws — fail-closed preserved. Verified live: remediation renders through both CLIs' printers. |
| FR6 LOW | FIXED | `envPath` trims and returns the trimmed value; whitespace-only ⇒ undefined as before. Padded values no longer open literal-space filenames. |
| FR7 LOW | FIXED (comment-only) | The "touched NOTHING" comment now says what is true: store construction has already mkdir'd/chmodded 0700 and swept temps; what the probe order protects is the RUN's state (no phantom lock). Conditional chmod would live in `src/providers/run-record.ts` (not owned this round) — documented instead, per the finding's alternative branch. |
| FR8 LOW | FIXED (+ parity in qds-cost) | `reportFailure` wrapper (run-lock's `writeStderr` posture) around every failure report inside sandbox-teardown's catch/finally and qds-cost's catches/finally. An EPIPE out of `out=writeSync(1,…)` can no longer replace the classified error or skip the mapped exit. qds-cost was not named in FR8 but had the identical hazard; included for consistency — flag if unwanted. |
| FR10 LOW | FIXED | Future-dated `createdAt` beyond a 5-min skew bound prints `held Ns (its createdAt is Xs in the future — the holder host's clock leads this one)` and fires the pid-reuse hint against NOW. Still never auto-stale. Same-host/foreign/self branches all use the honest age text. |
| FR11 LOW | FIXED | Signal handler resets `unwinding = false` and re-registers its listener when `process.kill(self)` throws, so a refused re-raise (seccomp/EPERM) does not dead-letter every later Ctrl-C. |
| FR12 LOW | FIXED | Foreign-host refusal gains guidance: hostname-change possibility + long-silence-is-evidence nudge + explicit "this module will not probe or clear a lock whose host it cannot match". Behavior unchanged (stale=false). |
| FR13 LOW | FIXED | `admittedCeilingBeside` order is now: READ (absence keeps its historical `is unreadable` ENOENT shape) → FRESHNESS → content parse/validation. A stale witness on the declared path is diagnosed as stale, not by whatever its content is — matching the witness-only path. |
| FR15 LOW | FIXED | Empty-body refusal gets dedicated remediation text (no more base-template "rm once holder unknown is gone" fighting the appended walk-back). Machine-readable flags untouched (`stale=false`). |
| FP6 LOW | FIXED | qds-cost resolves records dir via exported `resolveRunsDir(dir)`; restated chain deleted. Helper is pure string resolution (no mkdir/chmod), so the reporting CLI still never materializes the directory. Unused `DEFAULT_RUNS_DIR` import dropped. |
| FP7 LOW | FIXED | Pre-check is a NO-CREATE open (`openSync(path,"r")`) capturing the probed inode; after CostLedger constructs, the path must still be that inode, else close + refuse with new code `ledger-replaced`. Closes C5's existsSync→open fake-zero window (CostLedger fabricates+schemas an empty db). AC5 zero-row case untouched. |
| FP11 LOW | PARTIAL FALSE-POSITIVE | Bare `--dir=` empty value was ALREADY refused exit 2 by the shared grammar (`parseValueFlags` rejects zero-length `=` values) — verified empirically. Real residue was WHITESPACE-only/padded values passing verbatim; qds-cost now refuses those with the same `--dir requires a non-empty value` + help, exit 2. |

Deferred per instructions: FR5, FR9, FR14 — untouched.

## BEHAVIOR CHANGES (flagged)

1. **FR2**: teardown failure with `closedAt` already set now RELEASES the lock (was: wedged until manual rm) and adds a `lock-released-work-landed` diagnostic. Exit code unchanged (1).
2. **FR3**: self-pid lock reached via a path alias is now refused as LIVE (was: marked stale with rm advice). Only proven-unheld self-pid claims remain stale.
3. **FR1**: successful release no longer fails on rescue-copy rm errors (warning to stderr instead of throw).
4. **FR6/FP11**: padded/whitespace env override values are trimmed; whitespace-only `--dir` refused exit 2.
5. **FP7**: EACCES on the ledger FILE now reports `ledger-unreadable` at probe time (was: surfaced later as `ledger-unopenable` from the ctor). New code `ledger-replaced` for the race case. `ledger-missing` messaging unchanged.
6. **qds-cost test fixture** updated for F8 fractional box-hour pricing (see below).

## Baseline failure verdict (qds-cost CLI > full view … complete run)

GENUINELY BROKEN TEST, not env-dependence. Root cause: commit bf076a7
("fix(df3): F8 — fractional box-hour pricing from wall-clock ms") replaced
`ceil(lifetime-hours) × rate` with `ceil(rate × lifetimeMs / MS_PER_HOUR)` but did not update
this fixture. Fixture: 90 min lifetime @ 3,600,000 µ$/h → old expectation 2h = 7,200,000 µ$
(total 7,350,000); correct current figure 1.5h = 5,400,000 µ$ (total 5,550,000). The ledger's
current output ($5.55 total) matches F8's documented intent (the whole-hour minimum was the bug
F8 fixed). Fixed the fixture's expected figures + comments in tests/scripts/qds-cost.test.ts.

## Gates

**Snapshot note (round-10 wrap-up):** the figures below are the INTERMEDIATE
per-cluster gate taken mid-wave, while other fixers' files were still in flight
in the shared tree; they are preserved verbatim on purpose. The AUTHORITATIVE
final validation gate for the round is the closing run recorded in
[harden-cli-tests.md §Gates](./harden-cli-tests.md): `bunx tsc --noEmit` clean ·
`bunx biome check` clean · `bun test tests/fleet/` → **528 pass, 0 fail**.

- `bunx biome check` on all 7 touched files → clean.
- `bunx tsc --noEmit` → exit 0.
- `bun test tests/scripts/ tests/phase-engine/pipeline-run.test.ts` → **317 pass, 0 fail**,
  2 skip (was 21 pass/1 fail pre-fix).
- Informational: `bun test tests/fleet/verbs.test.ts tests/fleet/cli.test.ts
  tests/providers/run-record.test.ts` → 282 pass, 1 fail — the failure is in
  tests/fleet/cli.test.ts (invalid-run-id message shape + brief U+FFFD byte cap),
  BOTH files currently modified in-tree by the fleet agent; neither path touches
  run-lock/cost-ledger-opts. Out of my scope.

GitNexus evidence (completed at wrap-up, tree settled — per symbol):

| Symbol | Impact (upstream) | Direct callers | Affected processes | Risk |
|---|---|---|---|---|
| `releaseRunLock` | 11 impacted (d=4 direct) | fleet teardown/harvest paths, sandbox-teardown | `fanout`, fleet `run`, teardown `run`, `recordWriter` | **HIGH** |
| `acquireRunLock` | 9 impacted (d=3 direct) | fleet verbs, sandbox-teardown | same four as above | **HIGH** |
| `costLedgerOpts` | 7 impacted (d=4 direct) | fleet.ts, qds-cost.ts, sandbox-teardown.ts | fleet/teardown/qds-cost `run`s | **HIGH** |

The three HIGH ratings are EXPECTED shared-seam topology, not regressions: every
consumer routes through these functions, signatures were preserved, and the
changes are internal-only (release best-effort rescue rm; refusal classifier;
remediation text). No consumer edits were required.

Final `detect_changes({scope:"compare", base_ref:"main"})` for the whole round:
**125 changed symbols across 83 files, 37 affected processes**; this cluster's
own symbols appear there (refuse, onSignal, installSignalRelease, envPath,
admittedCeilingBeside, run ×2, assertValidMicroTotal). The CRITICAL aggregate is
the full 55-finding round's diff plus docs/tests, confined to this story's
modules — not a single-cluster blast radius. These fixes were COMMITTED as part
of cf56c26 on `fix/df3-1-review-round-10`; the earlier no-commit stance was a
mid-wave working note, not final evidence.

New tests added (tests/scripts/sandbox-teardown-cli.test.ts): F5 released-lock case;
symlink-alias self-pid LIVE case; unheld self-pid stays stale (FR3 regression guard);
future-dated createdAt names the skew (FR10).
