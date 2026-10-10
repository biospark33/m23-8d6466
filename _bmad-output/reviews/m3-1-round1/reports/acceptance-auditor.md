# Acceptance Auditor — M3.1 round 1

Diff audited: `_bmad-output/reviews/m3-1-round1/diff.patch` (dev…feature/m3-1-manager-meta-banks-l3-consolidate, commits b2eacbcd / 5f5889ac / 66bb1509).
Spec: `_bmad-output/reviews/m3-1-round1/story-spec.md`. Live-round-only DoD items (VPS infra round, operator GO, evidence) are treated as pending by design and are NOT flagged.

## Findings

- **F1 — A coalesced re-fire can flip from "counted success" to a failed run with a 5-minute stall; the test only passes via the clock-skew window.**
  Violates: AC2 ("treats a re-fire that lands while one is in flight as the server's coalescing success, never a failure"), E2E slice ("a re-fire inside the dedup window coalesces rather than stacks … a counted `coalesced` success shape"), DoD idempotency item.
  Severity: **HIGH**.
  Evidence: in `src/hindsight/nightly-consolidate.ts`, step 3 (refresh evidence) runs unconditionally after a `deduplicated === true` consolidate; `observeRefresh` requires `Date.parse(o.created_at) > consolidateCompletedAtMs - EVIDENCE_CLOCK_SKEW_MS` with `EVIDENCE_CLOCK_SKEW_MS = 5_000` and a 300 s budget, then returns `REFRESH_EVIDENCE_MISSING` → `ok:false` → `runMemoryNightly` exit 1. If the server ever reports `deduplicated:true` for a consolidate whose original refresh op is more than 5 s older than the re-fire (post-completion dedup window — exactly the semantics the story itself declares docs-derived and pending live verification), no fresh op ever appears and the expected-concurrent-fire night exits non-zero after burning the full budget. The coalesced fixture (case 4) passes only because its refresh row has `created_at = NOW_MS` while `consolidateCompletedAtMs` is ~7 tick-ms past `NOW_MS`, i.e. ~4993 ms inside the skew window — set `EVIDENCE_CLOCK_SKEW_MS = 0` and case 4 fails. The test demonstrates the skew window, not the in-flight semantics it claims. The strictly-in-flight case works (the original's refresh lands after the re-fire's completion timestamp); the live round must fire the second trigger while the first consolidate is genuinely in flight, and should also probe a post-completion re-fire before this shape is trusted.

- **F2 — Un-sanctioned behavior change to `resolveProvisionedRepoBankId` (family-signature widening) on a shared M1.1/M1.2-owned predicate.**
  Violates: DoD contract gate ("`client.ts`/`bank-provisioner.ts` diffs are adds-only; no existing method, schema, or bank name changes" — the only sanctioned non-add is the AC1 `MAX_BASE_LEN` retune), Files-to-Modify fence, and the review charter's "any OTHER silent schema/method change to M1.1/M2-owned surfaces".
  Severity: **HIGH**.
  Evidence: the diff replaces `existing.has(\`${safeBase}-dev-meta\`)` with `hasMetaSibling` (any of `-dev-meta`/`-qa-meta`/`-maint-meta` now proves family ownership) in the read-side resolver. That function is consumed by M1.2/fleet surfaces — `src/fleet/retain-best-effort.ts:111`, `src/fleet/dispatch.ts`, `src/hindsight/kg-context.ts:399` — i.e. the predicate deciding where fleet-side retain content lands. The widening is not needed by any AC (a family provisioned by any provisioner version always carries `-dev-meta`, so the old strict signature already satisfies AC1/AC4) and weakens a load-bearing ownership check — the diff's own "-ops-meta is NOT a family signature" test shows the strictness was deliberate. Revert to dev-meta-only, or document as an explicit second deviation with operator sign-off. It is currently a third, undocumented behavior edit to an adds-only file.

- **F3 — The read-side direct-to-instance reads contradict INV-MEM-2's literal text.**
  Violates: INV-MEM-2 ("neither leg addresses 8888/18889 directly; the gateway origin is the only egress for bank operations") as written.
  Severity: **MED**.
  Evidence: `src/hindsight/nightly-consolidate.ts` header: "Read-side exception: the preflight mental-model read and the refresh-evidence operations poll call the server-credentialed client DIRECTLY"; additionally `scripts/memory-nightly.ts` calls `client.listBanks()` directly for bank resolution. Verified real, not paranoid: `src/memgate/forward.ts` default-refuses `mental-models`/`operations` ("Everything else bank-scoped — mental-models, config, transfer, DELETE, … — is UNMAPPED and default-refuses"), and adding a route is fenced out of this story — so the reads cannot ride the gateway, and AC2's own proof standard (observed evidence from "the instance's operation list") requires them. The deviation is therefore necessitated by the spec, but it lives only in a module-header comment while INV-MEM-2's text is left stating the opposite. Reconcile: reword INV-MEM-2 (writes gateway-fronted; read-only evidence/bank-listing reads direct from the trusted tier) in the story record with operator sign-off, so the invariant and the code stop disagreeing.

- **F4 — AC1 negative control 1 ("a manager meta bank named outside the `qds-` scheme") is not test-enforced and has no referent in code.**
  Violates: AC1's negative-control clause ("Negative controls, all MUST fail"), and the audit mandate that each negative control be actually test-enforced, not just claimed.
  Severity: **MED**.
  Evidence: nothing in the codebase enforces a `qds-` scheme — `BankIdSchema` is `/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/` (scheme-agnostic), `resolveBankId` adds no prefix, and the provisioner/tests contain no non-`qds` refusal. The closest new test ("-ops-meta is NOT a family signature") covers read-side family recognition, not the scheme. As specified the control is vacuous: there is no rule it could fail against. Either add an assertion pinning the meta-bank naming convention at the provisioner boundary, or amend the spec to state that `qds-` is a naming convention (this repo's slug), not an enforced scheme.

- **F5 — The spec-named guard `NIGHTLY_WALL_CLOCK_BUDGET_MS` does not exist.**
  Violates: Technical Notes, "Guards/limits (named)".
  Severity: **MED**.
  Evidence: `grep -rn NIGHTLY_WALL_CLOCK_BUDGET src/ scripts/ tests/` → zero hits. The landed budgets are the client's per-call timeouts and `DEFAULT_REFRESH_EVIDENCE_TIMEOUT_MS = 300_000` (a per-job poll budget, not a wall-clock cap). Worst case is sequential: 3 banks × (60 s consolidate + 300 s evidence) ≈ 18 minutes, unbounded by any job-level guard — and F1 can push a coalesced bank to the full 300 s in normal operation. Implement the named guard or amend the spec's guards list.

- **F6 — The ConsolidateResponseSchema widening is documented but not sanctioned in the story, and it is a change, not an add, to an M2-owned schema file outside the Files-to-Modify fence; unrelated comment-only edits ride along.**
  Violates: DoD contract gate ("no existing method, schema, or bank name changes"); the "ONE sanctioned deviation" framing.
  Severity: **MED**.
  Evidence: `src/hindsight/schemas.ts` replaces the required-counts shape with `.default(0)` folds plus `operation_id`/`deduplicated` optional fields. The widening IS documented in-code (rationale + consumers-must-poll note + a test pinning both the legacy and real wire bodies parse) and in workflow-state key_findings — but the story spec sanctions no schemas.ts edit at all, and the DoD's own words forbid an existing-schema change. It is also not "adds-only" (required fields were loosened), so calling it "the one documented adds-only deviation" is imprecise. Required action: record the deviation in the story file (AC/DoD amendment) as THE one deviation before merge. Riding along in the same file and in `tests/hindsight/client.test.ts` are comment-only `dp:ok` additions to M1.2-owned lines (RetainResponse/RecallResponse transforms, four test lines) — zero behavior delta, but they are outside every fence; drop them or account for them separately.

- **F7 — `withManagerMentalModels` — the AC1 wiring and failure-conversion point — has zero test coverage, so AC1's fifth negative control is only half-enforced.**
  Violates: AC1 negative control 5 ("a provisioning pass that creates the banks but no triggered mental model — refresh then never fires and the AC2 receipt fails loud by design" must fail), audit mandate that negative controls be test-enforced.
  Severity: **MED**.
  Evidence: the AC2 half (nightly `MM_TRIGGER_ABSENT` fail-loud) is tested (cases 7-8). The provisioning half — a leg failure converting the envelope to `ok:false, banks:[]` and a non-zero exit — is enforced only by `withManagerMentalModels` (`grep -rn withManagerMentalModels tests/` → no hits; `meta-bank-provisioning.test.ts` covers `ensureManagerMentalModels`/`canonicalRoster`/`managerMentalModelId` only, and `main()` is inert behind `import.meta.main`). The wrapper contains real logic (repoBankId derived from `envelope.banks[0]` in two lanes; the failure fold). Add a direct test of the exported wrapper (success fold + failure fold).

- **F8 — AC1's letter says "GET the mental model by custom id"; the implementation uses `listMentalModels` + find-by-id.**
  Violates: AC1 wording (create-if-absent path "GET the mental model by custom id").
  Severity: **LOW**.
  Evidence: `ensureManagerMentalModels` uses `listMentalModels(bankId, "content")` + `.find((mm) => mm.id === mmId)`; workflow-state records the deliberate choice ("GET-by-custom-id + create-dup status marked UNVERIFIED — design avoids both: listMentalModels+find, PATCH-converge"). Semantically equivalent presence check with a documented rationale — acceptable; state it in the PR description so the AC wording drift is on the record.

- **F9 — INV-MEM-1's "exactly `{consolidate}` on one `*-meta` bank" vs the fallback leg's single token scoped to all three meta banks.**
  Violates: INV-MEM-1 wording (literal "on one `*-meta` bank").
  Severity: **LOW**.
  Evidence: case 17 mints the job token with `banks: DERIVED_BANKS` (all three). AC4 itself says "an agent token" (singular) for the fallback leg, so the one-token shape follows AC4; the security payload that matters — no retain-class/content-write verb, bank-scoped, never a box credential — IS tested (cases 12-14). Reconcile the INV-MEM-1 sentence (per-bot token on the schedule leg; one three-bank token on the fallback leg) or grant per-bank tokens.

- **F10 — DoD "Test (fallback, AC4): the crontab leg runs green with the E21 seam fakes deleted from the module graph" is implemented as a static import-graph scan, not literal file deletion.**
  Violates: none functionally — letter-vs-spirit note on the DoD item.
  Severity: **LOW**.
  Evidence: case 15 walks the transitive closure of both entrypoints and asserts zero matches for `home-bot|E21|fleet|pi-vs-claude-code-vendor|scripts/lib/run-lock` in both import specifiers and in-source symbols, with cycle/depth guards and a "walk actually traversed" assertion (`seen.size > 2`). An implementation importing the seam fails. This is equivalent to — arguably stronger than — deleting the fakes, since deletion would break unrelated suites; note the interpretation in the PR description.

## Scope fences checked (no violation beyond F2/F6)

- No new gateway route/verb: `src/memgate/` is untouched by the diff; case 12 pins `AGENT_TOKEN_VERBS` without `refresh`. ✔
- No factory lock: no `run-lock` import; the graph fence forbids it by name. ✔
- No in-box write-back, no router tuning, no L4 reflect, no retention changes: absent from the diff. ✔
- CHANNEL ≠ POLICY: no `fleet approve`/gate surface touched. ✔
- DD-16: no write credential enters a box — the fallback runs host-side; agent tokens have no box delivery path; the documented crontab line carries the env-file PATH only (`scripts/memory-nightly.ts` header), never a `VAR=` line. ✔
- Out-of-story hunks, all accounted: `sprint-status.yaml` + workflow-state (bookkeeping, commit 66bb1509); `scripts/install-gitnexus-plus.sh` + `tests/scripts/build-exedev-image.test.ts` (commit 5f5889ac "unblock 8 env-red tests … no deferral per operator" — operator-sanctioned pre-existing fixes, byte-isolated from M3.1 behavior). The schemas.ts/comment ride-alongs are F6.

## AC coverage table

| AC / DoD item | Where satisfied in the diff |
|---|---|
| AC1 — meta-bank family + reservation retune | `src/hindsight/bank-provisioner.ts` (`MAX_BASE_LEN` 52→50 diff @709-710; five-target `targets` @776-782); corner tests 50+3+11=64 (`tests/hindsight/bank-provisioning.test.ts` @1679-1716, @1823-1846, @1801-1821); MM create-if-absent/PATCH-converge + fresh read-back + post-pass confirm (`scripts/provision-hindsight-banks.ts` `ensureManagerMentalModels` diff @535-611); MM leg wired into both lanes' success envelopes (@647-673); re-provision verify-only + drift fail-loud + create-failed/timeout fail-loud (`tests/hindsight/meta-bank-provisioning.test.ts` @2246-2355). Gaps: F4 (scheme control), F7 (wrapper untested), F8 (GET wording). |
| AC1 neg-control: family constant without retune fails | ✔ test-enforced — the 50+3+11=64 corner tests fail if `MAX_BASE_LEN` stays 52 (66-char id → `BankIdSchema` parse fail). |
| AC1 neg-control: 65-char bankId accepted fails | ✔ in substance — `BankIdSchema` 64-cap + diff sanity checks (66/73-char variants fail parse, @1627-1629). |
| AC1 neg-control: re-provision re-attempts create fails | ✔ test-enforced — `createCalls`/`patchCalls` length 0 on converged re-provision (@2284-2297); PATCH-drift and create-failed/timeout fail loud (@2318-2355). Provisioning-half of control 5: F7. |
| AC2 — consolidate + trigger refresh, receipts, fail-loud | ✔ `src/hindsight/nightly-consolidate.ts` (gateway verify→forward → `client.consolidate`, `src/memgate/gateway.ts:498`); OBSERVED refresh evidence with staleness rejection + skew (cases 1, 9, 10, 11); no-refresh-method pinned (`tests/hindsight/client.test.ts` "no refresh method exists"); consolidate receipt present even when coalesced (`{deduplicated:true}`). Gap: F1 (coalesced evidence timing); F3 (read-side INV-MEM-2 tension). |
| AC2 neg-control: in-box write-back / content-write verb | ✔ test-enforced — cases 12-14 (`AGENT_GRANT_CLASSES.bot` deep-equals `["consolidate"]`; bot grant asking `retain` refused; job token on `/memories` POST refused scope-verb). |
| AC3 — platform-schedule leg (seam-fake), token scoping | ✔ same module with `leg:"schedule"` (case 2), wrong-bank → `GATEWAY_SCOPE_BANK` (case 5), wrong-verb → `GATEWAY_SCOPE_VERB` (case 6), three separate POSTs never fan-out (case 3). Token provisioning-delivery into the Home: pending A1 fork-side delivery (spec's sanctioned seam posture). Wording note: F9. |
| AC4 — crontab fallback, zero E21, env-only token | ✔ `scripts/memory-nightly.ts` (documented crontab line in header, env-file PATH only, fail-closed exit 2 — cases 16, 18); module-graph fence case 15 (interpretation note F10). |
| AC4 neg-control: fallback needing E21/raw 8888 fails | ✔ by construction + case 15 (any seam import fails); refusals prove verify-then-forward is the only write path (cases 5-6). No dedicated raw-8888 assertion — structural. |
| AC5 — spend print, operator GO, evidence scrub; CHANNEL ≠ POLICY | Pending live round (by design — not flagged). CHANNEL ≠ POLICY and DD-16 hold by inspection (no gate surface touched; no box-held write credential). |
| DoD Impl: three banks idempotent | ✔ five-target roster + idempotent PUT tests (@1770-1799). |
| DoD Impl: nightly receipts; coalesced counted success | ✔ receipts + `coalesced` event (case 4) — but see F1. |
| DoD Impl: fallback CLI, zero E21 asserted by test | ✔ case 15 + `scripts/memory-nightly.ts`. |
| DoD Contract: adds-only client/provisioner | client.ts ✔ adds-only (4 methods + `MENTAL_MODEL_TIMEOUT_MS` + imports). bank-provisioner.ts: retune sanctioned; **F2 violation** (`resolveProvisionedRepoBankId`); F6 (schemas.ts widening = the documented deviation, needs story-level sanction). |
| DoD Test (fence) | ✔ cases 12-14, 5-6. |
| DoD Test (fallback, AC4) | ✔ case 15 (static scan — F10 note). |
| DoD Test (idempotency) | Partial — case 4 coalesced counted success; case 3 one op per bank; no two-firing receipt-count-stable assertion at the fake tier (acceptable; live round verifies the dedup claim per spec). F1 caveat on the realistic shape. |
| DoD Security: no token values; mechanism named in receipt | ✔ envelopes/headers carry env-var NAMES only; `mechanism: "consolidation-trigger"` in receipt + `refresh-op` event. |
| DoD Integration + e2e demo (live round, dedup verification) | Pending live round / operator GO (by design — not flagged). |
