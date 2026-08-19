---
baseline_commit: 3830a2f0e5f9ebab0e8593c27f8684100c967685
---

# DF2.4: Live Cap-Hit Kill Demonstration — Real Key, Real Spend, Recorded Evidence

**Story Points:** 3
**Sprint:** v5-S2 (provider closure)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §6 item 2 (credential
  containment), §6 item 5 (blast-radius honesty), §8 step 2
- Decision register: v5 §4 **D8**; derivation register
  `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` **DD-6** (this story exists
  to discharge audit §6 hole 6), **DD-9** (µ$ cost unit)
- Audit: `docs/superpowers/specs/2026-08-11-story-disposition-audit.md` §6 hole 6 — "the only cap
  evidence in the whole program is P0.4's structural check"; P0.4's live loopy-prompt run has never
  been executed (`_bmad-output/sprint-artifacts/phase-0/stories/p0-4-hard-guard-kill.md` AC1/AC2 —
  DD-6 cites "AC3", but P0.4's AC3 is the `coms_await` timeout; the live-run clauses are AC1/AC2)
- Contracts: exitStatus enum **CC-1** (`cli-anything/src/types.ts:79`); run-record schema owned by
  DF2.1; mint/cap/capture-spend/revoke/verify verbs owned by DF2.3
- Binding facts: R5 §6 facts **11** (exe.dev figures vendor-single-origin), **15** (in-box evidence
  is a claim, not proof), **17** (one secret per box)

## User Story

As the person selling spend containment,
I want a recorded run in which a real capped key on a real box is spent to its ceiling and the run
is killed and evidenced,
so that the enterprise pitch rests on a captured artifact instead of an assertion nothing has ever
demonstrated.

## Overview

`scripts/cap-hit-demo.ts` composes verbs that already exist: DF2.1 creates the record, DF2.3 mints a
key at a deliberately low cap, DF2.2 fills the box and gates it to `ready`, then a loopy workload
runs until the provider refuses to serve the key. The host reads the key's usage from the provider,
`classifyRunExit` overrides whatever the box claimed to `overflow`, and DF2.5's teardown captures
spend, revokes, verifies revocation and closes the record. The deliverable is the evidence artifact
plus a harness that can produce another on demand — not new containment mechanism.

## E2E Slice

**Demonstrable behavior:** Given a box gated `ready` and a key minted at `capMicroUsd: 50_000`
($0.05), When `bun scripts/cap-hit-demo.ts` runs the loopy workload, it completes ≥2 paid turns →
the provider rejects further calls on that key → the host reads `usage ≥ limit` from the provider →
the run is classified `overflow` → teardown revokes and verifies absence from the key list.
Observable artifact: `.sandbox/evidence/df2-4-cap-hit-<run-id>.json` carrying `capMicroUsd`,
`spendMicroUsd`, `turnsCompleted`, the provider's verbatim rejection status, `exitStatus: "overflow"`,
`killOrigin`, `revocationVerified: true`, `closedAt`, and `verdict: "demonstrated"`.

**Wiring closed:** On completion of this story, a live cap hit is a repeatable, evidenced event using
only code merged by this story plus DF2.1/DF2.2/DF2.3/DF2.5. No stub, no `TODO: wire later`, and no
sibling story is required to make this behavior real. DF3.6 adds an inner ceiling later; it does not
complete this one.

**Dependency edges (predecessors):** DF2.2, DF2.3, DF2.5 (R5 §2). DF2.5's teardown is invoked unchanged
and re-implemented nowhere here; R5 §3 lands DF2.5 in S1, ahead of this S2 story — this story must
not be sequenced before it.

## Acceptance Criteria

1. **(make-or-break)** Given a real provisioned key capped at `capMicroUsd` and a box at `ready`,
   When the demo runs, Then the workload is killed on cap exhaustion and the evidence artifact
   records `spendMicroUsd ≥ capMicroUsd`, `exitStatus: "overflow"`, `killOrigin: "provider-cap"`,
   `revocationVerified: true`, a closed run record, and `verdict: "demonstrated"` — every number the
   verdict rests on (spend, cap, revocation) read host-side from the provider, never from the box.
2. Given the box reports its own failure as `transient` (a provider HTTP error looks like one), When
   the host reads `usageMicroUsd ≥ capMicroUsd` from the provider key API **and** the run received a
   provider cap-rejection response for that key (`providerCapRejected: true`, with a
   `terminationProvenance` that is neither `wall-clock` nor `host-error` — see the typed input in
   Technical Notes), Then `classifyRunExit` overrides to `overflow` with `killOrigin: "provider-cap"` —
   how the run died outranks what it said about itself (CC-1 precedence, R1 §4.5).
   **Both of those inputs are produced host-side, never read out of the box** — `providerCapRejected`
   comes from the host's own post-termination re-probe of the provider with the retained run key
   (Technical Notes), and `terminationProvenance` is set by whichever host-side guard fired. When
   `usageMicroUsd ≥ capMicroUsd` holds but `providerCapRejected` is false, or the provenance is
   `wall-clock`/`host-error`, the verdict is `inconclusive` (host-side provider evidence preserved,
   existing precedence kept).
   *Negative control: an implementation that trusts the box's self-report — sourcing either field
   from the box's own report or its merged output — passes an ordinary network-failure test and MUST
   fail this one (INV-2).*
3. Given the demo's wall-clock ceiling (900_000 ms) elapses before the cap is crossed, or the
   provider never rejects, Then the verdict is `inconclusive`, the artifact names which guard fired,
   the containment claim is **not** recorded as proven, and teardown is still invoked — completing
   DF2.5's six steps, or, where DF2.5's harvest abort fires, leaving the box alive and the record
   open for DF2.6's reaper. No verdict skips the teardown call and none forces a step past its abort.
4. Given the provider rejects on turn 1 with `turnsCompleted: 0`, When the artifact is written, Then
   the verdict is `inconclusive` with reason `cap-below-first-turn`: a key that was dead on arrival
   proves a misconfiguration, not a mid-run kill. The cap is a configured input so this case is
   re-runnable at a higher value without a code change.
5. Given the run is killed, When the artifact is written, Then it contains no key material: the
   provider's rejection body is redacted **with the run key itself as the redaction input** before
   storage — the pattern and the ≥8-char boundary rule come from `cli-anything/src/redact.ts:27,62`
   but are reimplemented under `src/providers/`, because root `src/` imports no tier-3 workspace
   code (R3 §9.2) and that helper redacts only values present in a parent env map. Only `keyHash`
   (never the key) identifies the credential.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/cap-hit-demo.ts [--cap <µ$>] [--roster <path>]` | in-scope | `tests/providers/cap-hit-demo.test.ts` | — |
| `classifyRunExit` on the demo's own host-side path (`scripts/cap-hit-demo.ts`) — this story ships the classifier and its one call site, not a wiring into every run | in-scope | `tests/providers/cap-rejection.test.ts` | production wiring on the general execute path: DF3.1 (dispatch) / DF1.6 (merged output) |
| Host-side absolute per-run spend ceiling (a different, inner control) | out-of-scope | — | DF3.6 |
| Ledger budget cap + dispatch refusal | out-of-scope | — | DF2.8 |
| `fleet dispatch` reaching the same execute path | out-of-scope | — | DF3.1 |
| Audit-chain events for mint/cap/kill/revoke | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Provisioning key (host env only) | OpenRouter — the working path today (R5 §6 fact 4) | DF2.3 mint returns a hash readable from `GET /keys` before the box is filled |
| Box at `ready` | exe.dev driver, DF2.2 | five-assertion gate returns ready with all five notes captured before a paid token is spent |
| Non-zero-priced cheap roster entry | `~/.pi/agent/models.json` (`deepseek/deepseek-v4-flash-0731`) | DF2.2 assertion D proves `cost.total > 0` — a box reporting `$0.0000` makes this demo meaningless |
| Loopy workload fixture | committed manifest, shape inherited from P0.4's never-run loopy manifest | fixture asserted non-terminating in unit test before any live run |
| Teardown + revoke/verify | DF2.5 teardown, DF2.3 credential verbs | teardown invoked on every verdict, its abort semantics intact; revocation verified against the authoritative key list |

## Technical Notes

- **This story adds one mechanism and no more:** `classifyRunExit`. Everything else is composition
  of DF2.1/2.2/2.3/2.5 verbs behind one script. Its input is a typed object, not positional args:
  `classifyRunExit({ inBoxExit, usageMicroUsd, capMicroUsd, providerCapRejected, terminationProvenance })`,
  where `inBoxExit: ExitStatus` (CC-1 enum, `cli-anything/src/types.ts:79`), `usageMicroUsd: number`
  is the host-side read of provider key usage (`GET /api/v1/key`, never the box's number),
  `capMicroUsd: number` is the key's spend cap, `providerCapRejected: boolean` records whether a
  provider cap-rejection response was observed for this key this run, and `terminationProvenance:
  "provider-cap" | "wall-clock" | "host-error" | null` records how the run ended independent of the
  box's claim. `capMicroUsd` **is** the provider key limit and **is** DF2.1's `limitMicroUsd` —
  DF2.3 mints the key at this cap and DF2.1 records it as `limitMicroUsd` (`df2-1-provider-driver-run-records.md:121-123`, the twelve-field schema bullet);
  the demo's `--cap <µ$>` is that same value supplied at mint, so the story never holds two names for
  one number. The verdict is `overflow` (`killOrigin: "provider-cap"`) iff `usageMicroUsd ≥ capMicroUsd`
  **and** `providerCapRejected` **and** `terminationProvenance ∉ {"wall-clock", "host-error"}`; every
  other `usage ≥ cap` case yields `inconclusive` with the host-side evidence preserved.
- **The cap under test is the outermost backstop.** The ceiling chain is
  `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` — DF3.6's resident ceiling
  innermost, then DF2.8's budget cap, then DF2.3's **configured default** key cap — and DF3.6's
  manifest loader refuses at config load if it is inverted, so "configure the inner controls above
  the key cap" is not a reachable state. The third term is the configured default and **never a
  minted `limitMicroUsd`**: a run's minted cap only *clamps* the effective resident ceiling to
  `min(residentSpendCeilingMicros, limitMicroUsd)` and never enters the load assertion (DF3.6 AC2b).
  The demo instead **lowers all three**, preserving the ordering: `--cap 50_000` µ$
  at mint, `runBudgetCapMicros` 40_000, `residentSpendCeilingMicros` 30_000. Neither inner control
  can pre-empt the kill in this run — DF2.8's cap is a pre-dispatch admission gate (out of scope
  here, so its `min(defaultKeyCapMicroUsd, remainingMicroUsd)` mint clamp never applies: the demo
  mints through DF2.3 directly at `--cap`, bypassing the ledger's remainder computation **by
  design** — a cap-kill demo with no ledger in the loop mints exactly the cap it advertises, while
  DF2.8's `min()` remains the production dispatch path, `df2-8-cost-ledger-budget-cap.md` AC3) and DF3.6's ceiling governs resident sessions, which this demo does not
  start — so the provider key cap is the binding live control. The demo records all three values so
  a reader sees which was binding.
- **Spend is the provider's number, not ours.** `spendMicroUsd` comes from `GET /api/v1/key` with
  the runtime key **before** revoke, because after DELETE it is unrecoverable (R4 §3.1,
  `teardown.just:73-100`). µ$ conversion happens only at the HTTP boundary (DD-9).
  `turnsCompleted` is the artifact's one box-reported figure, stored with `source: "in-box"`: it can
  only downgrade a verdict to `inconclusive` (AC4), never establish one (INV-2).
- **Who produces `providerCapRejected` and `terminationProvenance` — the host, by re-probe.** Neither
  field is harvested from the box; reading them there would rest the verdict on in-box output, which
  INV-2 forbids. After the workload terminates and **before** revoke (the key is still live, same
  window as the spend read), the host issues one cheap probe call to the provider with the retained
  run key. A provider cap-rejection response to that probe sets `providerCapRejected: true` and its
  verbatim status is what the artifact records; any other outcome leaves it `false`.
  `terminationProvenance` is likewise host-assigned by which host-side guard ended the run —
  `wall-clock` when the demo's 900_000 ms ceiling fired, `host-error` when the host's own call path
  failed, `provider-cap` when the re-probe rejected, `null` when the workload exited on its own. The
  probe's own cost is inside the cap by construction (the key is already exhausted); a probe that
  cannot be issued leaves both at their false/`null` defaults, which yields `inconclusive` (AC2).
- **Cap overshoot is expected and bounded [VERIFY].** Enforcement is per-request, so final usage may
  exceed the ceiling by up to one request's cost. AC1 asserts `≥ cap`, never `== cap`; the artifact
  records the overshoot so the real bound is measured here rather than assumed.
- **exitStatus lives on the step-output envelope, not the run record.** DF2.1's twelve-field record
  is closed and this story adds nothing to it; `exitStatus` and `killOrigin`
  (`provider-cap` | `wall-clock` | `host-error`) live in the evidence artifact and the merged output.
- **The rejection mapping is derived from the run, not guessed.** The provider's cap-exhaustion
  status and body shape are vendor-single-origin `[VERIFY]`; the classifier's primary signal is
  `providerUsage ≥ cap` read host-side, the observed status recorded so the table seeds from evidence.
- **Deviation/assumption:** this run costs real money bounded by the cap plus one request's
  overshoot. If it cannot be run against a live account this sprint, the verdict is `inconclusive`
  with reason `no-live-account` and the gap goes in the Dev Agent Record — never claimed on the fake
  driver alone.

## Observability Contract

- Every demo step logs `{ requestId, runId, step, keyHashPrefix, durationMs, outcome }`;
  `keyHashPrefix` is the first 8 chars of the hash, never the key.
- requestId is minted by the script and propagates into the run record and teardown; errors carry
  `{ code, message, remediation }` naming the literal next command.
- Sub-timings: `mint_ms`, `setup_ms`, `workload_ms`, `reprobe_ms` (the post-termination provider
  re-probe that sets `providerCapRejected`), `capture_spend_ms`, `teardown_ms`. Where the
  in-box workload cannot be broken down, it reports `0` and `durationMs` is authoritative.

## Files to Modify

- `src/providers/cap-rejection.ts`
- `src/providers/index.ts`
- `scripts/cap-hit-demo.ts`
- `tests/providers/cap-rejection.test.ts`
- `tests/providers/cap-hit-demo.test.ts`
- `tests/providers/fixtures/loopy-workload.yaml`
- `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-4-cap-hit.md`

## Security Invariants

- **INV-1 (bounded blast radius):** the maximum loss this story can incur is `capMicroUsd` plus one
  request's overshoot, on one key, on one box. Nothing in the demo path raises a cap, and the demo's
  low cap is never persisted as a default for other runs.
- **INV-2 (evidence integrity across the trust boundary):** every asserted number — spend,
  revocation, cap — is read host-side. In-box output is a claim, not proof (R5 §6 fact 15): the
  box's exit classification and `turnsCompleted` are inputs to the verdict, never its basis.
- **INV-3 (resource limit + kill path):** the cap is enforced by the provider; the kill is proven by
  `spendMicroUsd ≥ capMicroUsd` plus a terminated run classified `overflow`. The demo's own
  900_000 ms ceiling bounds it so a non-firing cap cannot burn indefinitely.
- **INV-4 (credential):** DF2.3's INV-CRED-1 … INV-CRED-6 apply unchanged — one secret per box, mint
  with the `sbx-` prefix, stdin delivery never argv, spend before revoke, revocation verified against
  the authoritative key **list**. This story mints by no other path and weakens none of them.
- **INV-5 (fail-closed on the claim itself):** a demonstration that does not demonstrate is recorded
  `inconclusive` and the containment claim is withheld. Teardown is invoked on every verdict; where
  DF2.5's abort semantics stop it short, the record is left open for DF2.6's reaper rather than
  forced closed — this story weakens no step of DF2.5. No path writes `verdict: "demonstrated"`
  without `spendMicroUsd ≥ capMicroUsd` and a revocation verified against the key list.

## Definition of Done

- [x] **Impl:** `scripts/cap-hit-demo.ts` composes mint → fill → setup → loopy workload → host-side
      spend read → classify → teardown, with `--cap` and `--roster` as inputs.
- [x] **Impl:** `classifyRunExit({ inBoxExit, usageMicroUsd, capMicroUsd, providerCapRejected,
      terminationProvenance })` overrides any in-box classification to `overflow` (`killOrigin:
      "provider-cap"`) iff `usageMicroUsd ≥ capMicroUsd` and `providerCapRejected` and the
      `terminationProvenance` is neither `wall-clock` nor `host-error`; `capMicroUsd` is read from
      DF2.1's `limitMicroUsd`.
- [x] **Contract:** the evidence artifact schema is fixed and asserted — `capMicroUsd`,
      `spendMicroUsd`, `turnsCompleted`, provider rejection status, `exitStatus`, `killOrigin`,
      `revocationVerified`, `closedAt`, `verdict`; DF2.1's record gains no field (INV-2, key-set diff).
- [x] **Integration:** teardown is DF2.5's, unchanged; spend capture and revoke-verify are DF2.3's,
      unchanged — the demo adds no second credential path.
- [x] **Security:** rejection bodies are redacted against the run key before storage and the artifact
      is scanned for any ≥8-char substring of the key → zero hits (AC5, INV-4).
- [x] **Test (unit):** `classifyRunExit` maps `usageMicroUsd ≥ capMicroUsd` **plus `providerCapRejected`
      and a non-`wall-clock`/`host-error` `terminationProvenance`** to `overflow` for `inBoxExit`
      values of `transient`, `logic`, and `lead_failure` alike; `usageMicroUsd ≥ capMicroUsd` without
      `providerCapRejected`, or with a `wall-clock`/`host-error` provenance, yields `inconclusive`.
- [x] **Test (self-report trap):** box reports `transient`, provider usage exceeds cap → `overflow`;
      an implementation trusting the box's self-report MUST fail this test (AC2).
- [x] **Test (host-produced classifier inputs):** `providerCapRejected` is set only by the host's
      post-termination re-probe of the provider with the retained key, and `terminationProvenance`
      only by the host-side guard that fired; a fixture whose in-box output claims a cap rejection
      the re-probe does not reproduce yields `inconclusive`, and an implementation reading either
      field from the box MUST fail this test (AC2, INV-2)
- [x] **Test (inconclusive paths):** wall-clock-first and `turnsCompleted: 0` each produce
      `verdict: "inconclusive"` with the named reason, and teardown is still invoked (AC3, AC4).
- [x] **Test (e2e demo — MANDATORY):** one live run against a real exe.dev box and a real capped
      OpenRouter key produces `.sandbox/evidence/df2-4-cap-hit-<run-id>.json` with
      `verdict: "demonstrated"`; the artifact is committed to
      `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-4-cap-hit.md` and is the
      discharge of audit §6 hole 6.
      **Done 2026-08-19**: run `df2-4-cap-hit-20260819-fc8f12` — spend 53 447 µ$ ≥ cap 50 000 µ$,
      25 paid turns, host re-probe observed `403 Key limit exceeded`, exitStatus `overflow`,
      killOrigin `provider-cap`, revocation verified against the key list, record closed,
      verdict `demonstrated`. Every verdict number host-side — sole exception:
      `turnsCompleted` (in-box-sourced per `turnsSource`, a downgrade-only gate;
      0 turns → `cap-below-first-turn`).

## Dev Agent Record

### Implementation Plan (as built)

- `src/providers/cap-rejection.ts` — the story's ONE new mechanism: `classifyRunExit` (pure,
  AC2 truth table) + `redactWithKey` (AC5; ≥8-char boundary rule from `cli-anything/src/redact.ts:23-27`,
  reimplemented because `src/providers/` imports no tier-3 workspace code). `InBoxExit` mirrors the
  CC-1 enum (`cli-anything/src/types.ts:99-108`); a mirror-sync test guards drift.
- `scripts/cap-hit-demo.ts` — composition only: `createRun` → `mintRunKey(--cap)` → `deliverRunKey`
  → (exedev only) `fill` + five-assertion `setup` gate → loopy workload via `executeRun` bounded by
  the wall-clock ceiling (budget passed into `execTimed` → Bun SIGKILL/exit-137; +1 s race backstop)
  → host re-probe (`deps.probe` ?? fake `chatComplete` ?? production `openRouterChatProbe` — one
  minimal `POST /chat/completions` with the retained runtime key, BEFORE revoke) → `captureSpend`
  → `classifyRunExit` (cap = the provider-echoed `limitMicroUsd` DF2.3 wrote to the record, never
  the operator's request) → `teardownSandbox` on EVERY path (early failures route through a
  `finishEarly` helper that still tears down and writes an artifact) → atomic artifact write
  (0700 dir / 0600 file / tmp+rename) to `.sandbox/evidence/df2-4-cap-hit-<runId>.json`.
- Fake substrate (`--driver fake` + `QDS_FAKE_KEY_API=1` test seam) drives the full verdict matrix
  in tests; live path gated by `test.todoIf(!QDS_EXEDEV_LIVE)` with half-set-env refusal.

### Debug Log

- Wave-built via parallel subagents (tests first, RED confirmed, then impl). Two impl agents hit
  context-window limits mid-flight; draft finished + hardened in main thread.
- Self-review (adversarial, pre-push) found 10 issues, all fixed: BLOCKER — production KeyApi had
  no chat probe (live `demonstrated` structurally unreachable; added `openRouterChatProbe` + probe
  resolution); HIGH — classifier/artifact used requested cap instead of record's provider-echoed
  `limitMicroUsd`; HIGH — mint/deliver/fixture throw paths skipped teardown+artifact (now
  `finishEarly`); MED — race-loser could overwrite wall-clock provenance with host-error (guarded);
  MED — DOD's box-claims-rejection tripwire test missing (added); plus LOW fixes (137-SIGKILL
  comment, `status: body` rejection format, NaN flag validation, test-seam docs, null exitStatus
  on pre-workload artifacts).
- **Live-fire campaign (19 runs, 2026-08-18/19)** — each failure fail-closed (teardown ran, keys
  revoked+verified, boxes destroyed, $0 orphaned at rest) and each taught a measured fact:
  1. runs 1–4: exe.dev image has no `/home/agent` (user `exedev`) — corrected paths via the
     DF2.2/DF2.3 override knobs, and the image ships no models.json → demo places a transformed
     cost catalog via DF2.1's `fillRun`.
  2. runs 4–8: gate D's `pi -p` instrument — cold-start >60 s killed by the script budget
     (widened), then nondeterministic streaming stalls → D's instrument replaced with the
     provider's own `usage.cost` from a curl call (route-dependent scalar-or-object shape
     handled). GR-002 scope override: DF2.2's in-box script repaired (3 edits, each a
     measured-incompatibility fix enabling this story's Infra Prereq; DF2.2's fake-substrate
     suite stayed green throughout).
  3. runs 9–13: workload shape — `pi -p` is single-turn (loop wrapped), reasoning-model endless
     turns never complete inside 900 s (input-heavy turns), output-token burn loses the wall-clock
     race at 84% of cap.
  4. run 15 + isolated scratch-key experiments: **enforcement lag measured** — first refusal at
     1.8× a $0.01 limit; the demo's run crossed at 1.07× with ~$1.6K µ$ turns. Manual kill +
     revoke contained run 15's overshoot.
  5. runs 16–17: pi stalls under sustained looping → workload rebuilt as a raw curl loop
     (gate C's seam, which never stalled once in 19 runs).
  6. run 18: `usage.cost` scalar shape → parser fixed. **Run 19: demonstrated.**

### Completion Notes

- **The live run is the story's deliverable** — see
  `evidence/df2-4-cap-hit.md` (run `df2-4-cap-hit-20260819-fc8f12`, verdict `demonstrated`,
  spend 53 447 ≥ cap 50 000 µ$, 25 turns, 403 refusal host-observed, teardown complete).
  Audit §6 hole 6 discharged (DD-6).
- All six `[VERIFY]`-class story assumptions live-tested; four came back different from the
  story's model and are now measurements recorded in the evidence file: rejection is **403**
  (not 402); enforcement **lags ~2–4 requests** (overshoot is cadence×cost, not one request);
  overshoot on the demonstrated run = 6.9%; `usage.cost` shape is route-dependent. The
  `[VERIFY]` "overshoot bounded by one request" is falsified for large requests and preserved
  approximately by sizing turns small — the artifact records the real number either way (AC1
  asserts `≥ cap`, never `== cap`).
- 43 story tests green (+1 live-gated todo); `tests/providers/` 311/0; setup-gate suite 38/0;
  `bun run typecheck` 0; `bun run lint` 0; defensive-programming + PR-conflict gates clean;
  GitNexus detect_changes LOW, 0 affected processes.
- Repo-wide `bun test` has 3 pre-existing failures unrelated to this story (verified on a
  stashed clean baseline: 2× roster e2e network-dependent, 1× bench env test).
- **Spend disclosure:** 19 demo runs + 6 scratch/probe keys against OpenRouter, all revoked and
  verified absent; every box destroyed; ~$0.75 total burned across the campaign (the delivered
  run itself: $0.0534). exe.dev: 1 account (personal), all VMs reaped (0 remain).
- `turnsCompleted` is the artifact's one in-box figure (`turnsSource: "in-box"`, downgrade-only).
- Unit note: provider API speaks USD dollars; µ$ conversion stays inside DF2.3's HTTP boundary
  (DD-9). `captureSpend` reads the provisioning LIST entry (the DF2.3 verb, mandated unchanged),
  which is host-side provider data and satisfies AC1's "read host-side from the provider".
- Operational residue: `OPENROUTER_PROVISIONING_KEY` now lives in the gitignored `.env`
  (user-directed; bun auto-loads it). exe.dev ssh config entries added for `exe.dev`/`*.exe.xyz`.

### File List

- `src/providers/cap-rejection.ts` (new)
- `src/providers/index.ts` (barrel export, +2 lines)
- `scripts/cap-hit-demo.ts` (new)
- `tests/providers/cap-rejection.test.ts` (new)
- `tests/providers/cap-hit-demo.test.ts` (new)
- `tests/providers/fixtures/loopy-workload.yaml` (new)
- `tests/providers/fixtures/loopy-workload.test.ts` (new)
- `tests/providers/fixtures/df2-4-demo.roster.yaml` (new — single-model demo roster)
- `tests/providers/fixtures/df2-4-models.json` (new — declared-rate cost catalog for the gate)
- `tests/providers/fixtures/fake-key-api.ts` (additive `chatComplete` substrate knob)
- `src/providers/exedev/assertions-in-box.sh` (DF2.2 repair: curl-based D instrument, both
  `usage.cost` shapes — scope-overridden, justified in Debug Log)
- `tests/providers/exedev/fixtures/fake-exedev.ts` (stub curl mirrors provider `usage.cost` shape)
- `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-4-cap-hit.md` (the deliverable)

### Change Log

- 2026-08-18: story implemented (composition of DF2.1/2.2/2.3/2.5 verbs + `classifyRunExit`
  mechanism); TDD red→green; adversarial self-review round applied (10 findings fixed).
- 2026-08-19: 19-run live-fire campaign; DF2.2 gate-D instrument repaired for the real image;
  workload rebuilt as curl paid-until-refusal loop; **live demonstration recorded** (verdict
  `demonstrated`, audit §6 hole 6 discharged); all keys/boxes cleaned up; status → review.

### Review Findings — round 2 (2026-08-19, BMAD 3-layer: Blind Hunter / Edge Case Hunter / Acceptance Auditor)

Sources: Blind Hunter 11 findings, Edge Case Hunter 16, Acceptance Auditor 0 (all ACs PASS).
After code-verified triage: 0 decision-needed, 8 patch, 0 defer, 19 dismissed.

- [x] `[Review][Patch]`Bare post-mint `deps.store.get(runId)` reads can throw past a live key [scripts/cap-hit-demo.ts:252,722,764] — record corruption would skip teardown/revocation; route reads through a fail-safe helper
- [x] `[Review][Patch]``effectiveCapMicroUsd` NaN/Infinity passes `??` unchecked [scripts/cap-hit-demo.ts:722] — non-finite record cap must fall back to requested cap (fail-closed)
- [x] `[Review][Patch]`Live fixture fields unvalidated before shell construction [scripts/cap-hit-demo.ts:517-537] — non-string/empty `model`/`prompt` and non-finite `paddingBytes` must route to `finishEarly("workload-fixture-invalid")`, never into argv
- [x] `[Review][Patch]`Probe transport failure indistinguishable from true no-rejection [scripts/cap-hit-demo.ts:662-666] — catch must set `rejectionStatus = "probe-error: …"` (redacted) while staying fail-closed
- [x] `[Review][Patch]``KEY_MANAGEMENT_URL_RE` hash charset hex-only [scripts/cap-hit-demo.ts:189] — broaden to `[0-9a-zA-Z%-]{16,}` so encoding/format drift cannot leak a management deep-link
- [x] `[Review][Patch]``FakeKeyApi.chatComplete` reverse-scans plaintext map [tests/providers/fixtures/fake-key-api.ts:180-187] — direct sha256 lookup, drop O(n) value scan + uniqueness assumption
- [x] `[Review][Patch]`AC2 negative control doesn't assert box's claimed rejection stayed out of `rejectionStatus` [tests/providers/cap-hit-demo.test.ts:249-266] — add not-contains assertions; add probe-transport-failure test
- [x] `[Review][Patch]``evidenceDir` precedence (deps > opts > env) undocumented at use site [scripts/cap-hit-demo.ts:224] — one comment line

Dismissed (19, code-verified false positives / documented design): wall-clock-vs-host-error race
settle order is correct (both hunters flagged same theory); ≥8-char redaction boundary is the
sanctioned policy (adjacent reconstitution caught by longest-first matching); AbortSignal.timeout
supported under Bun shebang; revocation trust is DF2.3's verified teardown contract; in-memory
keyHash fallback is authoritative; in-box turns spoofing is documented downgrade-only (INV-2);
shQuote verified proper POSIX escaping; evidence "no sk-or" claim true (key unrecoverable for
stronger scan); Infinity already rejected by positiveInt; MAX_ITERATIONS comment accurate;
fake USD float compare test-controlled; empty keyHash/prefix honest "no key" states; redactor
case-sensitivity mirrors sanctioned cli-anything redactor; spend `?? 0` safe default.
- 2026-08-19: BMAD round-2 review (3-layer: Blind/Edge/Auditor) — 8 patches applied
  (fail-safe record reads, finite-cap guard, fixture validation, probe-error status, URL-regex
  charset, fake-API direct hash lookup, negative-control + probe-failure tests, precedence
  comment + a pre-existing typecheck error in the keyHash assertion fixed); 19 findings
  dismissed as code-verified false positives; providers 314/0, typecheck 0, lint 0.
- 2026-08-19: Sift review — key-management-URL rule moved to the shared gate
  (`KEY_MANAGEMENT_URL_RE` + `redactKeyManagementUrls` exported from cap-rejection.ts;
  leakScan/scanArtifactForLeak flag deep-links; script regex removed); unit + e2e
  shared-gate tests added; providers 317/0, typecheck 0.

### Review Findings — round 3 (2026-08-19, BMAD 3-layer: Blind Hunter / Edge Case Hunter A+B / Acceptance Auditor)

Sources: Blind Hunter 14, Edge Case Hunter A 3, Edge Case Hunter B 6, Acceptance Auditor 0 (all 5 ACs + invariants PASS, CC-1 mirror verified).
After code-verified triage: 0 decision-needed, 13 patch, 0 defer, 9 dismissed.

- [ ] `[Review][Patch]` finishEarly reads `recAfter.limitMicroUsd ?? capMicroUsd` / `spendMicroUsd ?? 0` without finite guard — corrupted NaN record figures ship to artifact (round-2 guard covered only the classification path) [scripts/cap-hit-demo.ts:307-308]
- [ ] `[Review][Patch]` mint-failure artifact publishes `keyHash: ""`; `revocationVerified` treats empty-string keyHash as a verified id [scripts/cap-hit-demo.ts:316,322,336,949]
- [ ] `[Review][Patch]` fixture `paddingBytes` unbounded — `head -c ${paddingBytes}` interpolates fixture-scaled huge values into the live shell (self-DoS); clamp ≤1 MiB [scripts/cap-hit-demo.ts:588-590,600]
- [ ] `[Review][Patch]` `readRecordSafe` swallows store errors with no observable trace — add error log so record corruption is surfaced, not silent [scripts/cap-hit-demo.ts:262-268]
- [ ] `[Review][Patch]` probe transport failure gets zero retries — one network hiccup wastes an entire live-spend run; retry once on thrown transport error (fail-closed preserved) [scripts/cap-hit-demo.ts:205-213,801-819]
- [ ] `[Review][Patch]` `turn_end` counted as bare substring — non-marker occurrences inflate turnsCompleted; anchor to own line `/^turn_end$/gm` [scripts/cap-hit-demo.ts:732]
- [ ] `[Review][Patch]` fixture `provider` field declared in YAML but never validated — schema drift invisible; require "openrouter" when present [scripts/cap-hit-demo.ts:570, tests/providers/fixtures/loopy-workload.yaml:12]
- [ ] `[Review][Patch]` fixture `paddingBytes`/`wall_clock_cap_ms` Number()-coerced — string values silently accepted; strict typeof-number validation [scripts/cap-hit-demo.ts:588,594]
- [ ] `[Review][Patch]` `classifyRunExit` accepts negative/non-finite usage/cap — corrupted negative usage buries overflow; validate + throw [src/providers/cap-rejection.ts:56-73]
- [ ] `[Review][Patch]` `classifyRunExit` passes through runtime-invalid `inBoxExit` (TS-bypass caller) — validate against CC-1 enum + throw [src/providers/cap-rejection.ts:72]
- [ ] `[Review][Patch]` `redactWithKey` MAX_ITERATIONS exhaustion returns under-redacted text — throw on exhaustion instead (fail-closed) [src/providers/cap-rejection.ts:129-156]
- [ ] `[Review][Patch]` `<8-char` secret returned verbatim lacks key-format justification comment (OpenRouter keys ≥8 by construction; boundary mirrors sanctioned policy) [src/providers/cap-rejection.ts:106]
- [ ] `[Review][Patch]` `shQuote` — the shell-injection boundary for live argv — has zero unit tests; add edge-case suite (quotes, backslash, newline, `$`, backtick) [src/providers/exedev/transport.ts:83]

Dismissed (9, code-verified / documented design): workload-still-active after grace settle is documented
intentional fail-closed (comment at use site); destroy-without-list-verify accepted and documented;
Windows chmod non-atomic — Unix-only demo (darwin/linux); evidenceDir precedence already
inline-commented (round 2); key-management-URL over-redaction is documented defense-in-depth; `sleep`
in tests is fine for the Unix-centric project; leak-scan overlap detection complete for its purpose
(any ≥8 hit is a leak); broad fixture catch routes fail-closed to finishEarly; test subprocess cleanup
bounded by Bun test timeout.
- 2026-08-19: BMAD round-3 review (Blind/Edge A+B/Auditor; auditor re-audited all 5 ACs
  PASS) — 13 patches applied: finishEarly finite guards; keyHash null-not-"" +
  non-empty revocation check; paddingBytes 1 MiB clamp; readRecordSafe store-error
  surfacing; probe retry-once on transport error; turn_end line-anchored count;
  fixture provider/numeric-type validation; classifyRunExit non-negative-finite +
  inBoxExit runtime validation (throws); redactWithKey exhaustion throw;
  key-format justification comment; shQuote edge-case suite (38 tests);
  9 findings dismissed as documented/false-positive; providers 382/0, typecheck 0.
