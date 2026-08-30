# Fix cluster G — reverify (PR #150 round 7)

Files owned: `src/reverify/runner.ts`, `src/reverify/approval.ts`, `tests/reverify/approval.test.ts`,
`tests/reverify/runner.test.ts`, plus Deviation 8 text in
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md`.
No commits made. `src/fleet/approval-gate.ts` untouched (cluster A's file — and it was unmodified in
the working tree throughout, so all results below are against the pristine PR-head gate).

## Verdict table

| # | Sev | Verdict | Disposition |
|---|-----|---------|-------------|
| 2 (runner side) | HIGH | REAL — confirmed against source | **FIXED** |
| 12 | MEDIUM | REAL — confirmed against source | **FIXED — WIRED** (not fallback) |

## Finding 2 — stranded `pausing` resume arm unreachable (runner side)

Verified against source: `runner.ts` minted a fresh `rv-<runId>-<iso>-<random>` reverifyId on every
invocation and presented `report.reverifyId` as the request's `reportId`; the gate's `pausing` arm
(`approval-gate.ts:853-868`) resumes only on a byte-identical reportId. A crash between `pausing`
registration and promotion therefore answered `pause-in-progress` on every retry, and `pausing`
never expires — permanent stranding confirmed.

Fix (`src/reverify/runner.ts`, in `reverify()` just before `port.requestApproval`): read the run
record's `extensions.approval`; **iff** `state === "pausing"` and it carries a non-empty string
`reportId`, re-present THAT bound reportId instead of the fresh `report.reverifyId`. Only `pausing`
re-presents — checked the gate's re-entry arms:

- `awaiting-approval` rebinds (writes fresh reportId, appends history) — existing behavior is
  correct and is kept (fresh mint).
- terminal states answer `already-decided` against either id — fresh mint kept, so a genuinely new
  report after a decided/superseded gate still mints fresh (covered by the pre-existing
  "default adapter rebinds" test, which still passes).
- The REPORT keeps its own fresh reverifyId (it is genuinely a new report on disk); only the
  request re-presents the stranded binding.

**Behavior change (intentional):** a retry against a stranded `pausing` extension now yields
`{ outcome: "requested" }` and promotion to `awaiting-approval` instead of an endless
`pause-in-progress`. No other path changes.

Regression test (`tests/reverify/runner.test.ts`, AC6 describe): "a retry after a stranded pausing
extension RE-PRESENTS the bound reportId and resumes" — plants a `pausing` extension bound to
`rv-stranded`, drives `reverify()` with NO approval override (real adapter over the real gate),
asserts `requested`, record promoted to `awaiting-approval` with `reportId === "rv-stranded"`, and
`report.reverifyId !== "rv-stranded"`. Against the pristine gate, a fresh id would have returned
`pause-in-progress` — the test fails without the runner fix.

## Finding 12 — Deviation 8 bundle guard dead code → WIRED (not fallback)

Verified against source: `assertBundlePresent` (`approval-gate.ts:668-674`) early-returns when
`deps.bundleDir === undefined`; the only production construction was
`recordApprovalPort(deps.store ?? new RunRecordStore({ dir: runsDir }))` at `runner.ts:~406` with
no opts — guard never ran in production. Harvest invariant verified: `harvest.ts:435-436`
(`join(runsDir, runId + ".bundle")`) and `harvest.ts:18-19` (bundle presence at
`<runsDir>/<run-id>.bundle` IS the record) — a pure function of runId and runsDir.

Wiring (`src/reverify/runner.ts`): the default adapter is now built as
`recordApprovalPort(store, { bundleDir: runsDir })`, where `runsDir` is the same resolved dir the
runner already reads `<runId>-artifacts` from. The gate runs immediately after a green verdict on a
harvested run, so the bundle provably exists on the normal path — wiring is safe; **fallback not
needed**. Docstring in `src/reverify/approval.ts` updated (it previously claimed "opts DEFAULTS TO
NONE is the whole call at runner.ts"; now records bundleDir as the one passed seam and keeps the
deliberate-teardown-absence rationale).

**Behavior change (intentional, fail-closed):** on the default path, a green report whose bundle is
missing now throws inside the gate, which the runner catches into the existing
`approval-request-failed` flagged report with `approval: null` — previously it bound an approval to
nothing. Normal path (bundle present) unchanged.

Tests:

- `tests/reverify/approval.test.ts` — new describe "bundle guard — the wired bundleDir (DF3.4
  Deviation 8)": (1) bundle gone ⇒ first request refuses (`/cannot pause run-1: its harvested
  bundle is gone/`), nothing bound; (2) bundle present ⇒ first request AND rebind pass;
  (3) bundle removed between pauses ⇒ rebind refuses (`/cannot rebind …/`), live binding intact.
- `tests/reverify/runner.test.ts` — harness plants `<runsDir>/<runId>.bundle` (a harnessed run IS a
  harvested run; guard is existence-only); new e2e test "a green verdict whose harvested bundle is
  GONE is refused by the wired bundle guard" asserts `approval-request-failed` flag,
  `approval === null`, and no extension written.

Story text: Deviation 8 row in the story's Dev Agent Record updated — "What we built" now states
the guard is wired via `recordApprovalPort(store, { bundleDir: runsDir })` on first request AND
rebind; the evidence column names the bundle-path source (`harvest.ts:435-436`) and records that
the guard was inert as first shipped and is now wired, with the pinning tests named. No other
section touched.

## GitNexus impact results (run before edits)

- `reverify` (ambiguous, 3 candidates; authoritative candidate
  `Function:src/reverify/runner.ts:reverify`): impactedCount 2, risk **LOW**, 1 direct caller
  (`scripts/reverify.ts:main`).
- `recordApprovalPort` (`Function:src/reverify/approval.ts:recordApprovalPort`): impactedCount 3,
  risk **LOW**, direct caller `reverify` → `scripts/reverify.ts:main`. Modules affected: Reverify
  only. No HIGH/CRITICAL warnings.

## Verification gates

- `bun test tests/reverify/ > /tmp/qds-fix-g.log 2>&1` → exit 0; ANSI-stripped grep for
  `\(fail\)|^error` → no matches. **84 pass, 0 fail** (5 files, 79.8s). Includes both new tests.
- `bunx tsc --noEmit` → 0 errors.
- `bunx biome check src/reverify/runner.ts src/reverify/approval.ts tests/reverify/` → clean
  (8 files, no fixes).

Note on cluster A: `src/fleet/approval-gate.ts` was unmodified in the working tree during the whole
run, so these results are against the pristine gate. Cluster A's planned resume-arm additions
(restamping `requestedAt`/`expiresAt`, bundle re-check on resume) are additive to what my tests
assert; my stranded-pausing test plants a bundle, so it stays green whether or not the gate's
resume arm gains a bundle check.

## Out of scope / left for other clusters

- Gate side of finding 2 (resume restamp, resume-time bundle check, finding 13) — cluster A.
- Deviation 11 record (decision-needed 37) — recorded by the decision-needed flow, not me.
