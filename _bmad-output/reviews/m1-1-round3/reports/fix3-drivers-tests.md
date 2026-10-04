# fix3-drivers-tests — round-3 FINAL fix wave (scope m1-1)

Owner: fix3-drivers-tests. Branch `feature/m1-1-dedicated-hindsight-vps`, working tree
(NOT committed, per instruction). Files touched — exactly the sanctioned set:

- `scripts/p0-9/provision-and-import.ts` (R3-005)
- `scripts/p0-9/idempotency-rerun.ts` (R3-005)
- `scripts/p0-9/hindsight-live.ts` (R3-012)
- `scripts/p0-9/negative-probes.ts` (R3-012)
- `scripts/p0-9/auth-retired-check.ts` (R3-013 + R3-015)
- `tests/p0-9/legs.test.ts` (fixtures for all of the above + R3-017)

NOT touched: `scripts/p0-9/leg-lib.ts` (fix3-leglib), `scripts/provision-hindsight-banks.ts`
+ its test (fix3-cli), everything else.

## R3-005 (MED) — claim-scoped compensation in provision-and-import + idempotency-rerun

Root fix, both drivers: the raw post∖pre diff is demoted from delete-driver to
observation. Compensation now deletes ONLY the attempt's CLAIM set:

- **Fresh lane**: `claimableCreates()` reads `rerunAwareProvision`'s `raw` and takes
  the provisionBanks result's `status:"created"` members (`bankId`s), falling back to
  the helper's `createdInAttempt` when the raw envelope is not banks-shaped (failure
  envelope / thrown failure). Defensive on BOTH helper shapes — pre-R3-009
  (createdInAttempt includes `exists`) and post-R3-009 (filtered): the driver always
  re-filters `status === "created"` off the raw itself.
- **Rerun lane**: the helper's `createdInAttempt` semantics (canonical roster members
  it created this attempt; `[]` under failure).
- Each claim is intersected with the diff, so a pre-attempt bank is never deleted even
  when a provisioner envelope optimistically reports `status:"created"` for it.
- The REMAINING diff banks are recorded as `unclaimedCreated[]` — named, LEFT IN
  PLACE, with a `compensation-attribution / unclaimed-created-left-in-place` step
  whose reason is verbatim *"not attributable to this attempt — probe/manual/foreign
  creation during the window"*. New evidence field `unclaimedCreated` initialized on
  every outcome (both drivers' `ext`).
- Residue semantics unchanged: failed deletes of CLAIMED banks are residue and fail
  the leg; a fully-green run deletes nothing; R2-019 post-snapshot-failure residue
  still names the helper's honest `createdInAttempt`.

idempotency-rerun specifics: `createdInRerun` stays the RAW diff (it is the
idempotency-violation detector — snapshot-3 ≠ snapshot-2 fails the leg regardless of
attribution), but the compensation loop now iterates `claim(attempt1) ∪
claim(attempt2)` instead of `diff ∪ diff`. `unclaimedCreated` covers both windows.

File headers of both drivers rewritten to the claim-scoped contract.

**Tests (legs.test.ts) — fixtures moved to the new shape:**
- New fixture `failingThirdCreateImpl(client, probeBank?)`: a fresh-lane
  `provisionImpl` that lands b1+b2, fails the collective, and returns a FAILURE
  ENVELOPE CARRYING per-bank statuses (`created/created/failed`) — the claim source
  the real provisionBanks' `envelopeErr` drops. Optionally also creates a foreign
  `qds-probe-*` bank mid-window (what hindsight-live / auth-retired-check do without
  the family lock).
- provision-and-import "AC3 compensation fixture" now uses it: b2 delete fails → b1
  delete STILL issued, residue names b2, the probe bank lands in
  `unclaimedCreated`, is NEVER in `deleteBank` calls, never in residue.
- idempotency-rerun "AC3 rollback path" (a)/(b) same shape; (a) also pins the probe
  bank left in place while b1+b2 (claimed) are compensated.
- "happy-path compensation" test renamed to the claim semantics (A/B/C): A asserts
  `unclaimedCreated: []` on a clean window; B pins that a pre-existing collective /
  pre-existing-other are never claimed nor deleted.

## R3-012 (LOW) — header honesty: the advertised mock rehearsal

`hindsight-live.ts` + `negative-probes.ts` `Run:` header lines now state the truth:
`HINDSIGHT_LEG_MODE=mock` is the hermetic rehearsal — it records skipped-hermetic
steps and **exits 1 DELIBERATELY** (fail-closed per R2-003; no transport is ever
fabricated from env); a green rehearsal requires an injected transport
(`deps.fetchImpl` / `deps.client`), which only the test harness provides. No
behavior change.

## R3-013 + R3-015 (LOW) — auth-retired-check write-leg-specific retirement

- `dangerRetired` now requires the **RETAIN (write) leg specifically** refused-auth
  (401/403): `retainAuthRefused = retainProbe.kind === "refused" &&
  isAuthRefusalStatus(retainProbe.status)`. The old pair-wide OR (either leg's 401)
  is gone — a retain-transport-error + recall-401 pair can no longer retire the
  unauthenticated-WRITE danger (0.8.6's danger is precisely the write answering 200).
- Class tree (in order): both legs transport-error → **`not-measured`** (R3-015 —
  never `refused-unclassified`, which asserted a refusal for a probe that produced
  no response); any 2xx → `answered-2xx`; retain 401/403 → `refused-auth`
  (dangerRetired true); retain unmeasured → **`write-leg-unmeasured`**; non-auth
  404/422 → `refused-non-auth`; else `refused-unclassified` (R2-009 verdict). The
  no-transport initial outcome now carries `class:"not-measured"` too.
- New optional outcome field `writeMeasured` on the unauthenticated probe.
- `buildContainmentStatement` gained a `writeMeasured` param and the pinned
  inconclusive branch: *"Measured verdict: INCONCLUSIVE — the write leg of the
  unauthenticated probe was UNMEASURED (the retain transport-errored; only the
  recall read produced a response): the 0.8.6 danger is specifically the
  unauthenticated WRITE answering 200, and no retirement claim is made from a
  half-measured probe pair — containment carries the weight until the write leg is
  measured."* Fully-unmeasured keeps the existing honest not-measured verdict.
- File-header probe-(a) doc updated to the same rule.

**Tests:** `makeAuthFetch` extended with per-leg control (`retainStatus`,
`recallStatus`, `retainError`, `recallError`; both default to the old
`unauthStatus`). Three new pins:
1. retain transport-error + recall 401 → `dangerRetired:false`, class
   `write-leg-unmeasured`, `measured:true` / `writeMeasured:false`, verdict matches
   `/write leg/` + `/UNMEASURED/`.
2. Converse: retain 401 + recall transport-error → `dangerRetired:true`, class
   `refused-auth` (the WRITE's own refusal retires; the read's gap does not matter).
3. Both legs transport-error → class `not-measured`, `dangerRetired:false`,
   verdict `/NOT measured in this run/i`. Hermetic no-transport test extended to pin
   `class === "not-measured"`.

## R3-017 (LOW) — provision-and-import happy-path tests A/B/C read the real corpus

Shared fixture `TMP_CORPUS` + `makeTmpCorpus()` (the mint test's own fixture,
hoisted): a deterministic 3-entry tmp corpus written under the per-test `tmpDir` and
injected as `deps.expertiseDir` in A/B/C AND the mint test (which was refactored onto
the same helper). No provision-and-import test now depends on the repo's real
`.mulch/expertise` contents — checkout-independent pass/fail.

Block-header contract comment updated: `createdInAttempt` documented as the CLAIM
set, `unclaimedCreated` added to the pinned evidence shape, `dangerRetired`
documented as write-leg-specific.

## Verify (four-pass)

| Gate | Command | Result |
|------|---------|--------|
| Focal (full, owned) | `bun test tests/p0-9/legs.test.ts` | **exit 0 — 47 pass, 0 fail, 0 skip** (was 44 pre-wave: +3 auth pins) |
| Full file re-run | `bun test tests/p0-9/legs.test.ts` (after the fixture typing fix) | **exit 0 — 47 pass, 0 fail, 0 skip** |
| Typecheck | `bunx tsc --noEmit` | **exit 2 — 5 errors, ALL in `scripts/provision-hindsight-banks.ts`** (TS6133 unused imports: `ProvisionOptions`, `ProvisionResult`, `isPidDead`, `mkdirSync`, `dirname` — fix3-cli's mid-edit state; the file is outside this wave's scope and was not touched). **0 errors in this wave's six files.** |
| Lint (scoped) | `bunx @biomejs/biome check scripts/p0-9/{provision-and-import,idempotency-rerun,hindsight-live,negative-probes,auth-retired}.ts tests/p0-9/legs.test.ts` | **exit 0 — 6 files checked, clean** |

The tsc asterisk is the concurrent-edit seam: fix3-cli owns
`scripts/provision-hindsight-banks.ts` and is landing R3-004 (whose compensation
code consumes exactly those imports) — repo-wide tsc goes green when their wave
completes. No other suites were run; no unlazy scripts; nothing committed.
