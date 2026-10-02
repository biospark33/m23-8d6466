# M2.3: Combined memory live round — primed dispatch, in-box recall, revoke-verify teardown

**Story Points:** 2
**Sprint:** v6b (Autonomy — memory lane, lane story 3 of 3: M2.1 → M2.2 → M2.3, M2.1 itself shipping in v6a; the lane's exit round — the second lane completes here without E21)

## Spec Reference

- **Charter:** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` — v6b table row M2.3 (:98, deps M2.2 **+ M1.2**); §5.6 live-round rules (:134); §7.2 risk (gateway security over a store that answered 200 with no auth at 0.8.6).
- **Decision (fifth class):** **DD-16** (per-box credential set + revoke-verify ordering) and **DD-14** in `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md`; D-2's no-auth-danger retirement is WHAT this round proves (risk §7.2).
- **Ancestry disposition:** the P0.9 `negative-probes` evidence leg (`_bmad-output/plans/2026-09-30-p0-5-p0-9-closure-plan.md`) is the probe-battery ancestor — its semantics (refuse-by-name, never by waiver) carry over; its transport was re-homed by M1.1 (dedicated instance per D-2), which this round's probes exercise, not re-litigate.
- **Sibling contracts consumed unmodified:** M1.2 primed dispatch (`<kg_context>` brief appendix + proceed-unprimed-on-timeout degrade); M2.2 in-box `kg_recall` (sanitized, `KG_RECALL_CHAR_CEILING`, `QDS_KG_RECALL_KEY`/`QDS_KG_GATEWAY_URL` — this round asserts on `QDS_KG_RECALL_KEY`; M2.1's deliverer writes exactly that name (the Deviation-1 seam, single-named in the cross-story pass)); M2.1 gateway key contract + refusal table — the `runCredentialLifecycle` mirror (`src/providers/credentials.ts:1622-1727`), with the one battery-only refusal token (`no-auth`) register-flagged per M2.2 Deviation 2. No gateway code is written here.

## User Story

**As** the operator, **I want** one live round that proves the full memory cycle — dispatch-time primed recall, in-box `kg_recall` during a real run, and revoke-and-verify-before-destroy at teardown — **so that** the memory lane's security posture is demonstrated against the real gateway, including the five ways it must refuse.

## Overview

ONE T2-grade live round (plus its adversarial companion probes) on a real exedev box against the VPS stack: a `qds-` bank is seeded, a run dispatches with a primed brief, the worker recalls in-box mid-run, teardown revoke-verifies, and the host-side driver fires the negative-probe battery that retires the 0.8.6 no-auth danger for the factory topology. **What this does NOT deliver:** no recall-quality measurement (M1.3's probe set and hit-rate@k); no Graphiti checkpoint (DD-22, dated); no new gateway or extension code; no E21-gated lanes.

## E2E Slice

**Demonstrable behavior:** With `QDS_E2E_LIVE=1` and `QDS_E2E_TIER=2` exactly and operator GO given: `bun test tests/fleet/e2e/memory-combined.live.test.ts` drives a real fleet run — seed evidence records into a `qds-` bank → `fleet dispatch` whose brief carries the `<kg_context>` appendix (M1.2's ladder: results → directive; timeout/error → **silent proceed-unprimed, no directive**; degrade not fail) → the worker's `kg_recall` call succeeds mid-run with sanitized, budgeted output → run completes → teardown revoke-verifies the memory key before box destroy → the driver fires five probes (no-auth, cross-run key, bank outside allowlist, expired TTL, revoked key) and records each refusal with its reason. Each leg writes its own timestamped JSON to `_bmad-output/evidence/memory-live/`.

**Wiring closed:** On completion of this story, the round passes using only code merged by M1.1, M1.2, M2.1, M2.2, and this story's round driver. **No stub, no `TODO: wire later`** — a probe that cannot run is a FAILED round, not a skipped assertion.

**Dependency edges (predecessors):** **M2.2 and M1.2 are *direct* edges** (the in-box tool; the primed dispatch). M2.1 and M1.1 are *transitive* through them (gateway + dedicated instance). The ops re-pin ritual is a *transitive external prerequisite* (T2 is blocked until it fires — R5 wave analysis). **Not an edge — M1.3:** the round may feed M1.3's instrumentation a pointer, but it consumes no measurement report and makes no quality claim.

## Acceptance Criteria

1. **(make-or-break — the full cycle, live)** Given operator GO, the required env (`QDS_E2E_LIVE=1`, `QDS_E2E_TIER=2`, `QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`, `OPENROUTER_PROVISIONING_KEY`, `MEMGATE_ADMIN_KEY` — the admin key the driver's probe mint/revoke are gated on, M2.1 AC7), and the VPS stack healthy, When one round executes against one real box, Then all three legs — primed dispatch, in-box recall, revoke-verify teardown — are green in the SAME round and each leg's evidence JSON exists in `_bmad-output/evidence/memory-live/`. A round proving the legs in separate runs fails this AC; the point is the cycle under one credential lifecycle.
2. **(primed-dispatch leg)** Given the seeded bank contains a record matching the brief's subject, When the brief is built at dispatch, Then it carries the `<kg_context>` appendix citing that record; and given a recall timeout or unreachable gateway, the dispatch proceeds unprimed per M1.2's ladder — **silent, no `<kg_context>`, no directive emitted** (EMPTY_KG_DIRECTIVE is the zero-observations shape only; bad KG degrades to v5 behavior — never a failed dispatch). *Negative control (MUST fail, both limbs): a timeout/unreachable-gateway dispatch that FAILS instead of proceeding unprimed, AND a timeout that emits EMPTY_KG_DIRECTIVE — an implementation that turns a KG outage into a failed dispatch, or that fires the zero-observations directive on a transport failure, fails this AC; the degrade limb is load-bearing, not best-effort.*
3. **(in-box recall leg)** Given the run's per-run recall-only key, When the worker invokes `kg_recall` mid-run, Then the returned content is sanitized per M2.2's boundary (the extension's sanitize pass) and within `KG_RECALL_CHAR_CEILING` (M2.2 ACs hold under live conditions), the call and its latency appear in the observability vocabulary, and the box holds no credential other than the DD-16 pair. *Negative control (MUST fail): a box env exposing a second memory credential or any write-capable key fails the leg — asserted by the box-env forensics probe (the openrig-sc2 SC2.7 precedent: probe the box env pre-destroy, `probeStdout`/`probeExit` house shape) diffing the live env against the DD-16 pair.*
4. **(revoke-verify leg)** When the run reaches teardown, Then the memory key is revoked and verify-revoked BEFORE box destroy, mirroring `credentials.ts` ordering, and the verify evidence (gateway confirmation, timestamp) lands in the teardown leg JSON. *Negative control (MUST fail this one): a round that skips revoke-verify — treating box destruction as the credential boundary — MUST fail: a destroyed box does not revoke a gateway key, and the round's own teardown assertion is what catches it.*
5. **(adversarial battery)** When the host-side driver fires the five probes, Then all five are REFUSED and the recorded reason names the failed check in M2.1's refusal vocabulary: (a) a request with NO auth header (`no-auth`, register-flagged per M2.2 Deviation 2) — the literal 0.8.6 danger; (b) run A's key presented against run B's allowlisted bank — the bank is bound to run B and outside run A's allowlist (`scope-bank`; constructed with two driver-minted run keys so the probe is distinct from (c)); (c) a key scoped to bank X recalling bank Y (`scope-bank`); (d) a probe key past its TTL (`expired`); (e) a revoked probe key (`revoked`). Probe keys are driver-minted, never the run's key. *Negative control (MUST fail the round): ANY probe succeeding — above all a no-auth request returning 200 — fails the round and re-opens charter risk §7.2; a no-auth request MUST NOT succeed.*
6. **(live hygiene)** Before fire, the driver prints worst-case spend (fleet-run key cap + box hours, micro-USD); keys and boxes are cleaned in `finally` on every exit path; evidence is scrubbed (no tokens, keys, or unmasked secrets — `maskEnv` patterns; payloads are `exitCode`/`stdoutTail`/`stderrTail` house style) before landing in `_bmad-output/evidence/`.
7. **(digest-stable audit rows)** After the round, When the audit chain is walked, Then the rows the round itself produced are digest-stable — the teardown `run-credential` `revoke`/`verify-revoked` rows, and the `memory-retain-receipt`/`retain` row when the round's run harvests (same-subject re-emit of IDENTICAL content produces no `divergent` alarm) — and volatile fields (recall query text, result content) appear in NO row. The gateway's own key-lifecycle events stay LOG LINES only (M2.1's frozen posture: no hop, `AUDIT_HOPS` untouched) — the walk asserts they never became rows.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| Full cycle, one round, one box | in-scope | AC1 | none |
| Adversarial probe battery | in-scope | AC5 | none |
| Recall timeout degrade | in-scope | AC2 fallback limb | none |
| Recall-quality measurement (hit-rate@k) | out-of-scope — M1.3 owns the labeled probe set | M1.3 | M1.3 |
| Graphiti checkpoint decision | out-of-scope — DD-22, dated, not sprint-bound | M1.3 report | DD-22 checkpoint |
| Box write-back | out-of-scope — PARKED (F10/INV-7) | none | sanitized write-back via review harvester, later program |
| E21-gated autonomy rounds | out-of-scope — A2/Z3 lanes | A2/Z3 | none in this lane |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| VPS stack (Z4 profile) | dedicated Hindsight 0.10.0 + M2 gateway + Caddy allowlist | M1.1 round-trip verifier green + M2.1 gateway suite green **before** the round |
| T2-grade image | re-pinned image (M2.2 ritual, fired on GO, batched per M2.2 AC5 — carries M1.2's + J3's COPY-set edits) | `verify-image-pin` verify leg green **before** the round |
| M1.2 priming | live-proven T2 round | M1.2's own evidence leg green **before** the round |
| Env | operator-provided: `QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`, `OPENROUTER_PROVISIONING_KEY`, `MEMGATE_ADMIN_KEY` (driver-side probe mint/revoke, M2.1 AC7) | driver refuses to start (exit 2) with any missing, before any spend |

> Not prerequisites: the Graphiti decision, any E21 lane, M3 meta banks, or a second box — one box, one stack, one round.

## Technical Notes

- **Live-gate discipline.** `liveGate("2")` gating only `"1" | "2"` (v5 precedent, df6-1b:836-837); no-fakes hard rule in `*.live.test.ts`; T3/4/5 labels are naming over TIER=2 (charter §2.1).
- **Adversarial dimension — probes from the HOST, never from the box.** The battery runs in the round driver holding `MEMGATE_ADMIN_KEY` (M2.1's admin key — driver-side probe mint/revoke are gated on it, M2.1 AC7); a box never tests its own jail. Rejected alternative, written out so a dev does not re-derive it: firing probes from in-box code would prove only what the box can reach, not what an arbitrary network client can.
- **Probe key hygiene.** Each probe mints its OWN driver-side key via M2.1's host surface: (d) uses a short-TTL mint and waits expiry (TTL is the blast-radius bound for a stolen key — skipping it to save wall-clock is rejected); (e) revokes then calls (the revoke-verify contract, attacked); (a)-(c) reuse probe keys, never the run's.
- **Ordering against M2.1.** This story adds zero gateway code; the battery is M2.1's refusal table made live. A probe passing is a gateway defect surfaced, not a round feature to bend.
- **Digest-stability method (AC7).** Same-subject re-emit must not trip the divergent-digest tamper alarm (`credentials.ts` hit this bug class 3× — the store reports `divergent` on re-emits with a different evidence digest); volatile fields ride log lines only (Jev LOCKED #4).
- **Deviation/assumption (Deviation 1, binding on this story):** charter prose "second path M2.1 → M2.2 → M2.3" omits the M1.2 join the table carries (R5 F6); this spec follows the table — M1.2 is a direct edge. The round's env names follow charter §2.1's spellings exactly (`QDS_EXEDEV_REPO_URL`/`QDS_EXEDEV_SHA`/`QDS_EXEDEV_ROSTER`); the derivation brief elsewhere carried `QDS_EVEDEV_ROSTER`, a typo for `QDS_EXEDEV_ROSTER` — the charter text is authoritative and this story treats EVEDEV as a non-existent variable (a driver started with it would refuse at the missing-env gate, exit 2, before any spend).
- **Deviation 2, register-flagged:** the battery's refusal vocabulary consumes M2.1's `memgate-refused` reason set, which does not yet name one of the five required classes — `no-auth` (no auth header, the 0.8.6 shape). That token is NET-NEW to M2.1's refusal vocabulary (its verify-time refusal exists; only the named token is new), flagged jointly with M2.2 Deviation 2; the cross-run probe needs NO new token — at probe (b)'s construction (run A's key vs run B's allowlisted bank) the gateway's existing `scope-bank` check refuses it. If the register declines, probes record the refusal status plus the reason as returned, and INV-M3-2's "named reason" reads as the status-plus-body the gateway actually emits — surfaced, not silent.

## Observability Contract

- Leg events: `memory-live.primed-dispatch`, `memory-live.in-box-recall`, `memory-live.revoke-verified`, `memory-live.probe.<name>:refused` (probe names `no-auth|cross-run|bank-allowlist|ttl|revoked`), plus `memory-live.spend` (worst-case pre-fire + actual, integer micro-USD).
- Sub-timings: recall wall-clock host-side, server duration alongside; a leg that did not run reports **absent, not 0**.
- Evidence: one timestamped machine-checkable JSON per leg in `_bmad-output/evidence/memory-live/`, written by the leg's own leg code (P0.9 house rule — never hand-copied), scrubbed per AC6.

## Files to Modify

- `tests/fleet/e2e/memory-combined.live.test.ts` — **new** (Tier 2 deliberately — drives real spend; liveGate("2"); writes each leg's evidence JSON)
- `scripts/e2e/memory-negative-probes.ts` — **new** (the host-side AC5 battery; `MEMGATE_ADMIN_KEY`-gated probe-key minter)
- `config/rosters/memory-live.roster.yaml` — **new** (worker role granted the memory extension; consumed via `QDS_EXEDEV_ROSTER`)
- `src/fleet/run-completion.ts` — **DF3.7-owned — not modified** (the teardown chain this round exercises must need no change; if it does, the round FAILS and the defect goes back to its owner)

## Security Invariants

- **INV-M3-1 (fleet is the entry path):** the round's run goes through `fleet dispatch` — brief-validated, budget-gated, box-isolated (ADR-1 §2); nothing in the round gates code entry.
- **INV-M3-2 (the no-auth retirement):** a no-auth request to the gateway origin MUST be refused with a named reason (`no-auth` — M2.2 Deviation 2's register-flagged token) — the 0.8.6 danger is retired by demonstrated topology (risk §7.2).
- **INV-M3-3 (revoke-verify-before-destroy):** teardown ordering per `credentials.ts:1622-1727`, asserted by the round itself (AC4).
- **INV-M3-4 (frozen audit):** no new hop, `AUDIT_HOPS` untouched; `memory-retain-receipt` remains the ONLY memory audit hop — first writer M1.2 (vocabulary `retain`), this round adds nothing to it (INV-AUDIT-4's refusal stands for every other writer); digest-stable rows per AC7.
- **INV-M3-5 (hygiene):** worst-case spend printed before fire; operator GO required; keys and boxes cleaned in `finally`; evidence scrubbed before landing (charter §5.6).
- **INV-M3-6 (secrets never in argv):** driver tokens and probe keys ride env/stdin per D8; no token in argv, logs, or evidence JSONs.

## Definition of Done

- [ ] **Impl:** round driver + probe battery + roster fixture merged; liveGate wired to `"2"`.
- [ ] **Test (e2e live — MANDATORY):** one round, one box, all three legs green (AC1); leg JSONs in `_bmad-output/evidence/memory-live/`, scrubbed.
- [ ] **Test (adversarial):** five probes all refused with named reasons recorded (AC5); a deliberate no-auth replay of the 0.8.6 shape returns non-200.
- [ ] **Security:** revoke-verify evidence in the teardown leg JSON (AC4); the skip-revoke-verify negative control demonstrably fails the round's own assertion.
- [ ] **Contract:** audit walk clean post-round — digest-stable rows, no `divergent`, no volatile fields in rows (AC7).
- [ ] **Spend:** worst-case printed pre-fire; actual recorded in micro-USD in the spend leg.
- [ ] **Cleanup:** `finally` cleanup verified on pass, fail, and interrupt paths (AC6).
- [ ] **Preflight:** `bun scripts/roster-check.ts --roster config/rosters/memory-live.roster.yaml` green on the new roster file before fire (F097 precedent: roster-check is a pre-flight gate, not post-hoc).
- [ ] **Handoff:** pointer to the round's evidence delivered to M1.3 (instrumentation input only — no quality claim made here).
- [ ] **Integration:** GitNexus `detect_changes()` before commit (docs/test-only expected: 0 affected production symbols).
