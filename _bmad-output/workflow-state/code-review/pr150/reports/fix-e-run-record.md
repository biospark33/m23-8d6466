# Fix E — `src/providers/run-record.ts` (findings 24, 25)

Cluster E, PR #150 remediation wave. Files owned: `src/providers/run-record.ts`,
`tests/providers/run-record.test.ts`. No commits made.

## Verdicts

| # | Sev | Finding | Verdict | Disposition |
|---|-----|---------|---------|-------------|
| 24 | LOW | Retired-field migration at the 256-element cap sheds the migrated id itself (drop-oldest = head = legacy scalar) | **TRUE POSITIVE** | **Fixed** |
| 25 | LOW | Head-fold ordering inverts under mixed-version writers (rolling upgrade re-creates the retired scalar) | **TRUE POSITIVE** | **Fixed** (best-effort ordering; unrecoverable interleave documented in-code + on stderr, per the finding's defer-if-unfixable clause — a fix WAS possible for what disk state can prove) |

## Finding 24 — migration sheds the id it exists to preserve

Verified against source: `validateExtensions` folded `[legacy, ...history]` through
`shedStrings`, which drops from the head. With a 256-element on-disk history the
combined array is 257 and the shed element is the legacy scalar — the exact id the
migration's own comment ("a migration in an audit trail may not lose an id") protects.
The `shedStrings` stderr note also named no ids.

Fix (`src/providers/run-record.ts`):

- The head-fold path now sheds the oldest HISTORY entries (`history.slice(shed)`)
  and always keeps the migrated id at the head; the stderr note names the dropped
  ids (`dropping the N oldest: <ids>`).
- `shedStrings`'s own note now names the dropped ids as well (same format), so any
  shedding anywhere on the write path is attributable.

## Finding 25 — head-fold ordering under mixed-version writers

Verified against source: the fold always placed the scalar at the head on the
assumption "the scalar predates every element the array writer appended". During a
rolling upgrade an old build can re-write `supersededReportId` after the new build's
first migration; the second migration then head-folds an id that postdates the array —
an inverted rebind history.

Assessment of recoverability: the disk state CAN distinguish the two cases. Only a
v2 writer can write `supersededReportIds`, and `validateExtensions` never downgrades a
stored `schemaVersion`, so a scalar present while the STORED `schemaVersion` is
already ≥ the namespace version proves a migration already ran and the scalar was
re-created afterwards. What disk canNOT record is the scalar's exact interleave with
appends made since that migration — that is unrecoverable and is stated as such
in-code and in the stderr note, per the finding's "document the limitation" clause.

Fix (`src/providers/run-record.ts`): when `stored >= spec.schemaVersion`, the fold
appends at the TAIL (truthful relative to the migration; and tail placement means
`shedStrings`'s head-drop can never shed the migrated id — finding 24 cannot recur on
this path) and emits a stderr note naming the field, the situation, and the
unrecoverable-interleave caveat. The pre-migration case (`stored` below the namespace
version — where the array is provably empty) keeps the head fold. Dedupe
(`history.includes(legacy)`) still wins over position on both paths.

## Behavior changes (all intentional)

1. `shedStrings` stderr note now lists the dropped ids after `dropping the N oldest:`.
   Diagnostic text only; no test or consumer parsed the old text (grep-verified).
2. At-cap retired-field fold now sheds the oldest history entries instead of the
   migrated id, with a note naming the dropped ids.
3. A retired scalar found on a record already at the namespace's schemaVersion
   (re-created by an older build) now appends at the tail with a loud stderr note,
   instead of head-folding. Single-build pre-DF3.4 records (schemaVersion 1) are
   unaffected — existing fold test unchanged and passing.

## GitNexus impact (run before editing; both module-private, no exported symbol touched)

- `impact shedStrings --direction upstream` (repo QDS-Factory): risk **CRITICAL**,
  impactedCount 5, direct callers 1, 7 processes affected (`awaitDecision`,
  `submitDecision`, `teardownRun`, fleet CLI `run`, …). Mitigation: no signature or
  return-contract change; only the diagnostic note text changed.
- `impact validateExtensions --direction upstream`: risk **CRITICAL**,
  impactedCount 7, direct callers 2, 7 processes affected (same set + `reapRuns`).
  Mitigation: migration-only behavior change inside the write path; read path and
  all signatures untouched. The HIGH/CRITICAL blast radius is inherent to the store
  being on every record write; the edits are confined to the retired-field fold arm.

## Regression tests added (`tests/providers/run-record.test.ts`)

- "a fold at the 256-element bound sheds the oldest HISTORY entry — never the
  migrated id": on-disk v1 record, 256-element array + legacy scalar → result is 256
  elements with `rv-legacy` at the head, `rv-0` shed, and the stderr note contains
  `dropping the 1 oldest: rv-0`.
- "a scalar RE-CREATED by an older build mid rolling upgrade appends at the tail,
  not the head": on-disk v2 record with array `["rv-a","rv-b"]` + scalar `rv-c` →
  `["rv-a","rv-b","rv-c"]`, scalar retired, note contains `appending it to the tail`
  and `unrecoverable`; plus a dedupe case (scalar `rv-b` already in the array folds
  to nothing).

## Verification

- `bun test tests/providers/run-record.test.ts` → exit 0, **108 pass / 0 fail**
  (445 expect() calls); the `(fail)`/error grep over the ANSI-stripped log matched
  nothing.
- `bunx tsc --noEmit` → exit 0 (whole repo, including parallel fixers' files).
- `bunx biome check src/providers/run-record.ts tests/providers/run-record.test.ts`
  → clean, exit 0.

Nothing left undone. No commit made.
