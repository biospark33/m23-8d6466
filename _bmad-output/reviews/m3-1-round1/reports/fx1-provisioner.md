# fx1 — provisioner cluster fixes (round 1, F-001..F-004)

Branch `feature/m3-1-manager-meta-banks-l3-consolidate`. Owned files only:
`src/hindsight/bank-provisioner.ts`, `scripts/p0-9/leg-lib.ts`,
`tests/hindsight/bank-provisioning.test.ts`. No commit (per check discipline).

## Verdict table

| Finding | Verdict | How |
|---|---|---|
| F-004 — family-signature widening (unsanctioned behavior change to M1.1-owned read predicate) | **FIXED (reverted)** | `resolveProvisionedRepoBankId` back to the STRICT dev-meta-only signature: `existing.has(candidate) && existing.has(\`${candidate}-dev-meta\`)`. `META_SIBLINGS` / `hasMetaSibling` deleted. qa/maint siblings no longer prove ownership. |
| F-002 — legacy 52-max family unfindable read-side (MAX_BASE_LEN 52→50 orphan) | **FIXED** | Read-side only. New exported `safeRepoBaseCandidates(baseId): [string, ...string[]]` returns [current 50-form, legacy 52-form] (deduped when equal, both hyphen-stripped via a shared `truncateTo`). `resolveProvisionedRepoBankId` probes EVERY candidate form (base + collision loop -2..-11 per form), current form first. Write-side untouched: `resolveRepoBankId` and the listBanks-fail fallback still truncate to 50. |
| F-003 — leg-lib 52-base mirror disagrees with provisioner 50 | **FIXED (single-source)** | leg-lib `MAX_BASE_LEN = 52` const deleted. `safeRepoBase` now derives from the provisioner: `safeRepoBaseCandidates(resolveBankId(slug))[0]` — the mirror cannot drift again. `isRerunTarget`-equivalent gate in `rerunAwareProvision` detects BOTH forms: `safeRepoBaseCandidates(...).find(c => existingBankIds.includes(c))`, so a long-slug second run takes the rerun lane instead of minting a junk `-2` family. `rosterPatternClaim` claims shapes under both base forms. No separate helper exported — the gate is a one-liner over the provisioner's canonical export. |
| F-001 — rerun lane upserts stale three-name roster (MM leg never converges) | **FIXED** | `rerunAwareProvision` rerun lane upserts the canonical five (`familyBase`, `-dev-meta`, `-qa-meta`, `-maint-meta`, `qds-collective`) — same construction style, aligned with bank-provisioner.ts `targets` and provision-hindsight-banks.ts `canonicalRoster`. The stored pre-M3.1 three-name snapshot no longer limits the upsert set; `createdInAttempt` honestly reports the qa/maint creations (R2-011 semantics preserved). Roster is built from the DETECTED family base, so a legacy 52-form family is converged, not forked. |

## GitNexus impact (per repo CLAUDE.md) — `resolveProvisionedRepoBankId` upstream

`impact({target: "resolveProvisionedRepoBankId", direction: "upstream"})` → **risk HIGH**, exact, 5 impacted:
- depth 1 direct callers: `retainOnce` (src/fleet/retain-best-effort.ts, 9 processes), `mintAndDeliverMemoryKey` (src/fleet/dispatch.ts, 7 processes), `primeDispatchBrief` (src/hindsight/kg-context.ts, 1 process)
- depth 2: scripts/fleet.ts; depth 3: tests/fleet/observe-contract.ts

This HIGH is the finding itself: the widening changed where fleet retain/dispatch content lands. The semantic REVERT restores these consumers' pre-M3.1 dev behavior (families recognized via -dev-meta only) — that restoration is the point of F-004, not a new risk. No fleet file was touched.

## Behavior-change flags (all three intentional, all review-mandated)

1. **Strict recognition revert (F-004)**: a family with ONLY qa-meta or ONLY maint-meta siblings is now null again (foreign). Matches M1.1 pre-branch semantics; every provisioned family carries -dev-meta, so no AC weakens.
2. **Legacy read probe (F-002)**: a 51-52-char-base family from the pre-M3.1 52-max era is recognized read-side again (base form + suffixed forms). Write-side still 50 — AC1's 50+3+11=64 corner is re-pinned by an existing test plus a new direct `resolveRepoBankId` 52-char-slug→50-char-output test.
3. **Rerun five-roster (F-001)**: reruns now create qa/maint meta banks over a stored three-name snapshot (the stale snapshot is not a limit). `buildProvisionEnvelope`'s `(raw.roster ?? canonicalRoster(base))` fallback in scripts/provision-hindsight-banks.ts (READ-ONLY, verified) now reports five bank ids from the rerun lane's raw.roster — correct.

## Residuals in unowned files (gaps, not fixed here)

- `scripts/provision-hindsight-banks.ts:377` `isRerunProvision` still gates on the 50-form only (`safeRepoBase`). Harmless for convergence — both CLI lanes route through `rerunAwareProvision` (line 685 `attempt()`), whose both-forms gate now decides the lane — but a legacy 52-form family takes the "shared-fresh" branch: it fires a bridge probe the rerun lane never reads, and `compensateRerunFailure` (line 524) builds its delete-roster from the 50-form, so legacy-form qa/maint creations on a FAILED rerun classify as `unclaimed-created` residue instead of being compensated-deleted. Conservative direction (deletes nothing outside its roster); owner should align both to `safeRepoBaseCandidates`.
- `scripts/provision-hindsight-banks.ts:524` `compensateRerunFailure` — same 50-form roster source (above).

## Test updates (tests/hindsight/bank-provisioning.test.ts — owned)

- INVERTED (F-004): "a qa-meta sibling alone does NOT identify the family (strict dev-meta signature)" (was "also identifies"), "a maint-meta sibling … alone does NOT identify", "suffixed family NOT recognized via a maint-meta sibling without dev-meta"; NEW "recognized via dev-meta even when qa/maint siblings also exist". "-ops-meta is NOT a family signature" kept.
- NEW: legacy 52-max family recognized read-side (54-char slug → 52-char legacy base + dev-meta found; `safeRepoBaseCandidates` shape pinned 50-then-52).
- NEW: legacy family with qa/maint siblings found via dev-meta (strict predicate, legacy probe).
- NEW: collision loop probes legacy forms too (suffixed legacy family recognized).
- NEW: WRITE-side still truncates to 50 for a 52-char slug (`resolveRepoBankId` direct — no 52-length write regression, AC1 corner).
- No pure rerun-target helper was added to leg-lib (the gate is a one-liner over the provisioner's `safeRepoBaseCandidates`), so nothing new to unit-test there; `safeRepoBaseCandidates` itself is pinned by the legacy tests above.

## Read-only suites that now fail BY DESIGN (need test-owner update, not a code revert)

Both pin the pre-M3.1 three-name roster that F-001 deliberately supersedes:

1. `tests/p0-9/legs.test.ts:819` "rerunAwareProvision: provisionImpl wins on the fresh path; rerun reports recreated roster members (R2-011)": `rerun.createdInAttempt` expects `["qds-factory-dev-meta"]`, now `["qds-factory-dev-meta", "qds-factory-qa-meta", "qds-factory-maint-meta"]`; `rerun2.createdInAttempt` expects `[]`, now the two meta creations. (Test file not owned — not edited.)
2. `tests/provision-hindsight-banks.test.ts:742/744` "rerun lane: PUT-upserts the canonical roster…": `instance.puts` expects the three-name roster, now five PUTs in canonical order; `createdInAttempt` +2.

Everything else in both suites passes (legs.test.ts 56/57, provision-hindsight-banks.test.ts 68/69).

## Gates (operator-directed discipline)

- `bun test tests/hindsight/bank-provisioning.test.ts` → **50 pass / 0 fail** (191 expect calls), exit 0.
- `bunx tsc --noEmit` → **0 errors in owned files**. 8 remaining errors are ALL in `src/hindsight/nightly-consolidate.ts` — that file is modified in the working tree by a teammate fixer (not in my owned set; I never touched it).
- `bunx @biomejs/biome check` on the three owned files → **clean** ("Checked 3 files… No fixes applied").
- Focal-adjacent (read-only runs): legs.test.ts and provision-hindsight-banks.test.ts as reported above.
- No full suite, no commit.
