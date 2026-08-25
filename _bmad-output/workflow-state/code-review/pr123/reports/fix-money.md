# Round 10 fix report — W1e (cost-ledger / run-record / credentials / reaper)

Branch `feature/df3-2-fanout-best-of-n`. No commits/pushes. GitNexus impact run before edits:
`admitIssue` upstream = 0 direct callers, LOW; `sweep` upstream = scripts/sandbox-reap.ts:run, LOW.

## Dispositions

### FP1 HIGH [money] — FIXED. Aged read-fault no longer expires a live reservation

- Was: the `catch` arm in `admitIssue`'s reservation loop expired ANY aged admission whose
  `readRunRecord` threw, dropping its ceiling from `reservedMicroUsd` — a transient EIO/EACCES past
  the grace window handed the next dispatch the full remaining headroom atop live exposure.
- Now (`src/providers/cost-ledger.ts`): before expiring, `recordStructurallyAbsent(runId)`
  (:1708) stats `<runsDir>/<runId>.json`. Expire only on proven ENOENT, a confirmed ZERO-BYTE
  tombstone, or an id outside even `LEGACY_RUN_ID_RE` (can never have named a record or box —
  also keeps the hand-built filename from escaping the dir). Everything else — non-empty file,
  or a stat fault (EACCES/EIO) — is UNPROVABLE and KEEPS its ceiling counted
  (`reservation-unresolvable-held` log line, :1465). Young-guard and BEGIN IMMEDIATE semantics
  untouched; the ceiling add + safe-integer overflow guard were centralized into one `reserve()`
  closure so both arms share it.
- New optional dep `CostLedgerDeps.runsDir` (:649), default `resolveRunsDir()` =
  `$QDS_RUNS_DIR ?? .sandbox/runs`, so default-layout and env-var deployments are fixed with zero
  caller changes.
- **GAP FLAGGED (out of my ownership):** deployments that relocate records via `--dir` flag keep
  today's expire-on-fault behavior until the wiring passes `runsDir: store.dir` into
  `new CostLedger({ ...costLedgerOpts(store.dir), ... })` in `scripts/fleet.ts`
  (makeLedgerFactory ~749, teardown-report ~1985) and `scripts/sandbox-teardown.ts` (~232).
  One-line additions for the scripts owner. No-worse-than-before otherwise.

### FP2 MED — FIXED. Tagged legacy-shape boxes are now owned by the sweep

- Was: sweep classification and the pre-destroy recheck used strict `RUN_ID_SHAPE`; a factory-TAGGED
  box whose id predates the tightening classified `foreign` → reported, never reaped → bills forever.
- Now (`src/providers/reaper.ts`): local `isReaperOwnedVm` (:84) = `tag === SBX_OWNERSHIP_TAG` AND
  (`RUN_ID_SHAPE` OR `LEGACY_RUN_ID_RE`). Used at classification (:412) and destroy recheck (:663).
  The tag half — what INV-1 actually leans on — is NOT relaxed; untagged anything stays foreign.
- **BEHAVIOR CHANGE:** a TAGGED provider box with any `[a-z0-9][a-z0-9-]*` name is now reapable.
  Previously only strict-shaped ones were. Rationale: an adversary can already forge strict-shaped
  names, so shape added no adversarial defense over the tag; it only stranded real factory boxes.
- Pre-existing test updated to say what it means: "foreign controls" in
  `tests/providers/reaper.test.ts` seeded its permissive-name operator VM WITH the default factory
  tag (fixture auto-tags); under the new predicate that is indistinguishable from a factory box, so
  the fixture now seeds it `tag: null` (an operator's box has no tag of ours). Flagged here as a
  deliberate test-semantics change, not green-washing.
- **GAP FLAGGED (out of my ownership):** `reapRuns` in `src/providers/driver.ts` still gates raw
  destroys on strict `isFactoryOwnedVm`, so it refuses legacy-tagged boxes (fail-safe, only noisier).
  Its owner should widen identically or accept the divergence; I could not touch driver.ts.

### FP3/FP8/FP9/FP10/FP12 — DEFERRED per instruction. Untouched.

### FP4 MED — FALSE POSITIVE (no source change)

Claim was that `credentials.ts` error paths call `redactSecrets` unguarded and feed it non-strings,
so a redactor throw would replace the real failure. Evidence against:

- All four cited sites (credentials.ts:196, :200, :277, :566) call ONLY `redactSecrets`.
- `redactSecrets` (src/providers/step-log.ts:225-271) wraps its ENTIRE body — including the
  `redactKeyManagementUrls` composition and the `keep` parking — in one try/catch returning
  `REDACTED`, with a comment naming this exact hazard ("Every caller is a catch block logging
  someone else's failure..."). It cannot throw by construction.
- Non-string rejection values are coerced by `asText` (step-log.ts:193-201), which catches
  `String()` throwing on null-prototype/hostile values → `"[unprintable]"`.
- The `safeRedact` wrapper the finding cites exists in scripts/cap-hit-demo.ts because THAT script
  calls `redactWithKey`/`redactKeyManagementUrls` directly, outside redactSecrets' guard.
  credentials.ts does not.
- Regression test added anyway (`tests/providers/credentials.test.ts`, "a hostile non-string
  rejection survives every error log without replacing the real failure"): delivery rejects with a
  `{message: <null-proto object>}` value and the compensation `getKeyEntry` rejects with another;
  asserts the ORIGINAL `code: "boom"` propagates, keyHash stays recorded, both log lines carry
  string messages containing "[unprintable]" and never the hostile payloads. Passes.

### FP5 LOW — FIXED. Slug scope predicate trims column-side

- `issueScopeSql` (src/providers/cost-ledger.ts:126-127) now folds
  `lower(trim(col, char(32,9,10,11,12,13)))` — mirroring `canonicalRepoSlug`'s trim, same ASCII set
  and same Unicode divergence documented in `sqlCanonicalIssueId`. Padded historical raw slugs can
  no longer vanish from `spentRow.total` (under-count = bypass direction); over-inclusion only ever
  ADDS spend to a scope, which is the fail-safe direction.
- Added matching expression indexes `cost_events_issue_canonical_trimmed` /
  `gate_admissions_issue_canonical_trimmed` (:296, gate_admissions block) so issue-scoped predicates
  don't fall back to a scan inside BEGIN IMMEDIATE; older indexes kept (IF NOT EXISTS never
  rewrites existing DBs).

## Tests added

- `tests/providers/cost-ledger.test.ts` (orphan-guard describe): aged+EIO over present non-empty
  file ⇒ ceiling HELD (`reservedMicroUsd` counted, granted ceiling clamped to remaining headroom);
  held reservation alone ≥ cap ⇒ REFUSED; ENOENT-by-stat ⇒ expires; confirmed zero-byte tombstone ⇒
  expires; illegal id (`../../escape`) ⇒ expires without touching the filesystem. Canonical-slug
  describe: padded raw-slug row counts toward view SUM and refuses the gate at cap.
- `tests/providers/reaper.test.ts`: TAGGED legacy-shape record-less box ⇒ `leaked-vm:destroy`,
  dry-run predicts and `--yes` destroys through the widened recheck (box hand-seeded as a
  pre-tightening build would have left it — FakeDriver.create is strict today but list/destroy honor
  the legacy grammar); UNTAGGED legacy-shape box stays foreign.
- `tests/providers/credentials.test.ts`: FP4 regression test above.

## Gates — commands and results

| Command | Result |
|---|---|
| `bunx biome check` (all 9 touched files) | clean |
| `bunx tsc --noEmit` | my files clean; remaining errors all in `scripts/fleet.ts` / `scripts/lib/run-lock.ts` — another agent's uncommitted work-in-progress (350+136 changed lines, not mine) |
| `bun test tests/providers/cost-ledger.test.ts tests/providers/run-record.test.ts tests/providers/credentials.test.ts tests/providers/reaper.test.ts tests/providers/budget-gate.test.ts` | **278 pass, 0 fail** (1296 expect calls) |
| `bun test tests/providers/` (full dir) | 699 pass, 0 fail |
| `bun test tests/fleet/dispatch.test.ts` (solo) | 113 pass, 0 fail (known fleet-busy flake did not fire) |
| `bun test tests/fleet/verbs.test.ts tests/fleet/cli.test.ts` | pass solo |

Unrelated, not mine: full-dir `tests/fleet/` shows intermittent load-order failures in
`brief-schema.test.ts` ("re-stamping LAST-WINS") and one cli byte-cap case — both pass solo; they
live in files other round-10 agents (fix-manifest / fix-cli) are actively editing alongside their
in-flight `scripts/fleet.ts` changes.

`detect_changes()` (unstaged, whole tree) reports CRITICAL only because 30 files are modified across
all concurrent fixers; my slice's changed symbols are exactly CostLedger.constructor/admitIssue/
SCHEMA/issueScope* and reaper.sweep (+ test helpers) — nothing unexpected.
