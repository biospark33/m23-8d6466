# J2: Measured Arm-Thresholds — the S1 Observer's Routing Unlock, Signed and Auditable

**Story Points:** 3
**Sprint:** v6b (Autonomy, lane 2 — E21-independent; the measured half of DD-21, answering handoff §9 DoD 6's standing "arm-thresholds explicitly NOT done")
**Status:** gated — gate = corpus milestones + explicit operator sign-off (in-story ACs; the DD-21 unlock gate). J1 merged is a dep, not the gate.

## Spec Reference

- **Charter** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` — v6b table J2 row (:102, deps "J1 + corpus milestones"); §2.3 L4 (:55, "confidence gating → arm-thresholds unlock, gated on calibration milestones + operator sign-off"); §7.8 Goodhart risk (:155, "arming on ~3 positives").
- **DD register (same PR):** `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` **DD-21** — the Jev register entry that writes these milestones into the gate; **DD-15** — P2.9–P2.11 A/B + confirm machinery PARKED under DD-23; this story's operator-run confirm CLI is deliberately NOT that parked machinery (Technical Notes).
- **Jev handoff** `_bmad-output/typesafe-integration/handoff.md` — §3 LOCKED #5 (recording-only until measured — the rule this story ends, by measurement), #9 (no severity calibration; ≈3 positive BLOCKER examples is the Goodhart floor), #10 (S1 is a pre-router, never a replacement), #12 (outcome-validated precision as the accumulation metric); §9 DoD 6 (the deferred item this story retires).
- **Landed measurement surfaces (consumed unchanged):** `scripts/judgment/observe-round.ts` (S1 observer — recording-only; `OBSERVER_QUESTIONS` :57-72, `JEV_LABELER` :49, INV-J5 gate :95-97); `scripts/judgment/ab-report.ts` (`computeReport` :242-308, `outcomeAgrees` :228-230, outcome section rendered "not yet available" while fields are null); `scripts/corpus/schema.ts` (`abReserved` outcome fields :58-65, `recordKey` :122-124); corpus at `_bmad-output/judgment/corpus/`. Baseline of record: jev-live-r1 — 108/108 findings, 88.0% disposition agreement, $0.00223, ~220ms (2026-09-22).

## User Story

As the operator who must not arm model-driven routing on a handful of agreeing answers,
I want the S1 observer's routing authority to unlock only when the corpus proves it — an outcome-confirmed record count, an agreement confidence-interval floor — and only on my explicit signed flip,
so that arming is a named, auditable event in the record rather than config drift, and un-arming is equally named.

## Overview

Build the unlock machinery the Jev handoff deferred: a milestone gate over the corpus, an operator-signed flip, and the armed routing surface. **The gate** (`src/judgment/arm-gate.ts`) evaluates two thresholds **in code** (LOCKED: thresholds-in-code): a minimum count of outcome-confirmed jev-arm records, and a minimum lower bound of a two-sided 95% Wilson score interval on their outcome-agreement rate. **The flip** appends a hash-chained entry to `_bmad-output/judgment/arm-state.jsonl` — the log's head IS the state; there is no other mutable state to drift. **The armed surface** (`route-round.ts`) partitions one round's frontier findings into `deep-adjudication` vs `obvious-dismiss-candidate` from the recorded jev answers, and refuses while recording-only. The observer itself stays recording-only, byte-identical: arming changes what may *consume* recorded answers, never what the observer records.

**What this does NOT deliver:** no auto-applied verdicts — the routing manifest is an input; the frontier session stays authoritative (LOCKED #10), and nothing auto-dismisses a finding or touches a merge. No gate-runner, approve-gate, or code-entry change of any kind (charter §6: no Jev answer gates code entry). No auto-confirm machinery (the parked P2.9–P2.11 shape). No severity calibration (LOCKED #9 — routing lanes only).

## E2E Slice

**Demonstrable behavior:** Given today's corpus (zero outcome-confirmed records), When `bun scripts/judgment/arm-thresholds.ts` runs, Then the verdict is `not-eligible` naming both gaps (`outcome_confirmed=0/<MIN>`, `ci_lower=n/a`); When `--arm` runs without eligibility or without the sign-off pair, Then it refuses exit 2 having written nothing. Given a fixture corpus that meets both milestones, When the operator runs `--arm --sign-off "steve 2026-XX-XX"` with `QDS_JUDGMENT_ARM_CONFIRMED=1`, Then a flip entry lands in `arm-state.jsonl` carrying the evidence snapshot (counts, rate, `ci_lower`, thresholds, corpus digest) and `route-round --pr N --round R` emits `_bmad-output/judgment/routing/N-R.json`; `--unarm` flips back, and `route-round` refuses again.

**Wiring closed:** On completion, the entire lifecycle — confirm outcomes, evaluate, arm, route, unarm — runs using only code merged by this story plus the landed corpus/ab-report/observer modules. **No stub, no `TODO: wire later`.** The out-of-repo consumer (the operator's triage session reading the manifest) is a documented contract, not a code dependency.

**Dependency edges (predecessors):** **J1 (direct, program-ordering):** routing authority may exist only over a seam-pinned judgment path — the answers being routed must trace to adapter outputs whose contract J1's suite pins; pre-J1 there is no pinned provenance for a routed answer. **Corpus milestones (external-measurement, not a story):** the record count and CI are corpus reality, evaluated at flip time by the gate itself.

> **Not an edge — A1/A2:** the v6b autonomy stories consume fleet runs and Home bots, not the routing manifest. If a later story wants observer-routed QA triage, that is new scope with its own gate, never this manifest silently widening.

## Acceptance Criteria

1. **(make-or-break — the gate is closed by construction)** Given the corpus as it exists, When the gate evaluates, Then the verdict is `not-eligible`; `--arm` refuses exit 2 **before any file write** unless BOTH the milestone evidence and the sign-off pair hold. *Negative controls, both MUST fail: an `--arm` that succeeds without the operator sign-off pair (`--sign-off` non-empty text AND `QDS_JUDGMENT_ARM_CONFIRMED=1` — either missing refuses); and an `--arm` that succeeds below either milestone (fewer than `MIN_OUTCOME_CONFIRMED_JEV_RECORDS` confirmed jev-arm records, or Wilson lower bound below `MIN_WILSON_LOWER_AGREEMENT`).*
2. **Thresholds live in code, named, with derivations.** `MIN_OUTCOME_CONFIRMED_JEV_RECORDS`, `MIN_WILSON_LOWER_AGREEMENT`, `WILSON_Z = 1.959964` (two-sided 95%), and `MIN_ROUTE_CONFIDENCE = 0.90` (the armed DISMISS-lane routing threshold) are constants in `arm-gate.ts` carrying their derivation comments; the values are the writer-proposal this story pins in code, and the operator's DD-21 milestone review — a hard precondition of the first real `--arm` (Dev Agent Record) — confirms or amends them into the register before that flip; no env var, config file, or CLI flag can lower any of the four. *Negative control: an implementation reading any threshold from environment or config MUST fail — thresholds-in-code is LOCKED (D-5).*
3. **The flip is a named, hash-chained, append-only event.** Every arm/unarm appends `{seq, at, from, to, sign_off, evidence{confirmed, agreed, rate, ci_lower, thresholds, corpus_digest}, prev_digest}` to `_bmad-output/judgment/arm-state.jsonl`; each entry chains the prior entry's digest (canonical-JSON sha256); consumers walk the chain from genesis; the head entry IS the current state; an absent or empty file means recording-only (fail-closed). *Negative controls, all MUST fail: a silent un-arming — truncating, deleting, or hand-editing the log breaks the chain and every consumer refuses; a flip written by any path that does not append a well-formed chained entry; and a consumer that honors an "armed" head whose chain fails verification.*
4. **The armed routing surface refuses closed and routes narrowly when open.** `route-round.ts` exits 2 `not-armed` while the log head is not a chain-valid armed entry; when armed it emits the manifest partitioning the round's frontier findings by their **recorded** jev answers: disposition `DISMISS` **and** chosen-criterion probability ≥ `MIN_ROUTE_CONFIDENCE` → `obvious-dismiss-candidate`, everything else → `deep-adjudication`; each manifest entry carries the finding id, the jev rationale, and the armed-state digest it routed under. *Negative controls: a routing decision made from anything but recorded corpus answers (re-judging live inside route-round MUST fail); a manifest entry lacking its armed-state digest MUST fail; and any code path that auto-dismisses a finding, edits a review verdict, or touches `gate-runner.ts`/`approval-gate.ts`/`AUDIT_HOPS` MUST fail — the manifest is an input, the frontier stays authoritative (LOCKED #10).*
5. **The outcome population has an honest in-repo path.** `confirm-outcome.ts` appends operator-confirmed outcome entries `{...recordKey, outcome_confirmed, outcome_source, confirmed_at}` to `corpus/outcomes.jsonl`, joined onto jev-arm records by the corpus `recordKey` (`pr, round, finding_id, labeler`) — within the jev arm this coincides with ab-report's `(pr, round, finding_id)` join, but `recordKey` is the idempotence authority; the gate's counted population is only that join; every gate verdict prints the `outcome_source` distribution — a population fed by a single self-confirming source is visible, not hidden (§7.8 counter-metric). *Negative control: a gate evaluation that counts unconfirmed records toward the milestone, or imputes outcomes from agreement-with-lead, MUST fail — agreement-with-lead is circular; outcome-confirmed is the metric (LOCKED #12).*
6. **The recording-only machinery is untouched.** `observe-round.ts` and `ab-report.ts` are byte-identical after; the observer's "recording-only — no threshold, no routing, no gate authority" line remains true of the observer. *Negative control: any edit that gives the observer, the client, or the corpus writer knowledge of arm state MUST fail — the flip lives entirely in the new consumers.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| gate evaluation (dry-run, default) | in-scope | `tests/judgment/arm-gate.test.ts` | — |
| operator `--arm` / `--unarm` with sign-off pair | in-scope | `tests/judgment/arm-gate.test.ts` | — |
| `route-round` manifest (armed) + `not-armed` refusal | in-scope | `tests/judgment/route-round.test.ts` | — |
| `confirm-outcome` entries + source distribution | in-scope | `tests/judgment/arm-gate.test.ts` | — |
| automatic outcome confirmation from merge/CI evidence | out-of-scope — the parked P2.9–P2.11 shape (DD-15/DD-23); the operator-run CLI is the deliberate narrow slice | — | DD-23 dated trigger |
| routing into fleet dispatch, fix-loop, or the approve gate | out-of-scope — never; no Jev answer gates code entry (charter §6) | — | none |
| severity assignment by jev | out-of-scope — LOCKED #9; severity stays with the frontier session | — | none |
| auto-applying a router/model-tier change | out-of-scope — FR-LEARN-30 shape: propose, never auto-apply (M3.2's lane) | — | M3.2 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| judgment seam + adapters | `src/judgment/` (J1, merged) | `bun test tests/judgment/` green before this story starts |
| corpus capture + merge + observer | `scripts/corpus/`, `scripts/judgment/observe-round.ts` (merged) | `bun test tests/scripts/corpus/ tests/judgment/` green before; `observe-round.ts` byte-identical after |
| measurement surface | `scripts/judgment/ab-report.ts` `computeReport` (merged, exported, pure) | consumed by import; the file is **not modified** |

> No box, no TypeSafe key and no spend are prerequisites — J2 is mock-tier end to end. Milestones are corpus reality, not spend.

## Technical Notes

- **The milestone values, chosen and owned.** `MIN_OUTCOME_CONFIRMED_JEV_RECORDS = 200` and `MIN_WILSON_LOWER_AGREEMENT = 0.90`: ~2× the largest single-round population to date (jev-live-r1's 108), an order of magnitude past the ≈3-positive Goodhart floor of LOCKED #9, and a floor no smaller than the observed 88% lead-agreement baseline — but measured against **outcomes**, not the lead. These are a chosen floor, not a derivation; the operator's DD-21 milestone review confirms or amends them (recorded in the register before the first real `--arm`), and this story's gate enforces whatever that review pins. They are deliberately the *gate's* constants, not the review campaign's to renegotiate.
- **"Agreement CI" is outcome agreement.** The charter's milestone phrase is ambiguous between agreement-with-lead (circular — the jev arm was labeled to agree with the lead's process) and agreement-with-outcome (the anti-Goodhart metric LOCKED #12 names). This story implements **outcome agreement** (`outcomeAgrees`, `ab-report.ts:228`): confirmed-true agrees with every disposition except DISMISS; confirmed-false agrees with DISMISS. If the operator intends lead-agreement, that is a one-constant change at DD-21 — flagged, not silently chosen twice.
- **Gating use of recorded probabilities is NET-NEW at arming.** The standing report rule is "p>0.5, no gating use" (`ab-report.ts:180`). Arming re-adjudicates exactly that clause, above `MIN_ROUTE_CONFIDENCE = 0.90` on the chosen criterion's probability, and only for the DISMISS lane; below threshold, and for every other disposition, the no-gating-use rule stands. The DD-21 milestone review records the re-adjudication; probabilities keep being read from the rationale clause (`parseIsRealDefect` precedent) — structured answer fields on corpus records are a schema growth this story does not take.
- **Region ownership:** `arm-state.jsonl` and `routing/*.json` are this story's, under `_bmad-output/judgment/` (house rule: corpus-adjacent judgment artifacts stay in-repo there). `observe-round.ts`, `ab-report.ts`, `scripts/corpus/*` are consumed, never edited — the confirm path is a new file + join, not a rewrite of immutable records. Fence note: `arm-gate.ts` sits inside the two-import fence, so it is a pure evaluator + chain verifier (`node:fs` for `arm-state.jsonl` only, fence-legal); corpus reading and the outcome join live in `scripts/judgment/arm-thresholds.ts`, which passes parsed records in.
- **Considered and rejected: scrypt-gating the flip.** The approvers machinery (DF3.4) protects merge authority; arming protects routing influence. An env-confirm + recorded sign-off string matches the spend-gate idiom (`QDS_LIVE_PROBE_CONFIRMED`) at proportionate cost. Revisit only if arming ever approaches gate authority — which charter §6 forbids it from doing.
- **Chain discipline, minimal.** One sha256 of the canonical prior entry per line — the `provenanceDigest`/audit-chain idiom at its smallest, ~15 lines, no store, no walker CLI beyond the gate's own verification. What the chain does not fence: an attacker who rewrites the whole log consistently can forge state — accepted, because the log lives in the operator's repo at 0600-equivalent trust, and the flip command is operator-run — the §8 idiom (subagents never commit, never spend without steve's go) extended to arming.

## Observability Contract

- Gate verdicts (every run, dry or armed): `{milestones: {confirmed: n, confirmed_min, agreed, rate, ci_lower, ci_floor}, sources: {<outcome_source>: count}, verdict: "eligible" | "not-eligible", gaps: [...]}` — counts are real counts; **absent outcomes are absent, never 0** (a corpus with no outcome entries prints `confirmed=0` from zero records, and `ci_lower=n/a` — never a fabricated interval).
- Flip events are the log entries themselves (AC3's shape) — no second log; `route-round` prints one line per manifest: `{pr, round, armed_digest, deep_adjudication: n, obvious_dismiss_candidates: n}`.
- Every manifest entry is traceable: finding_id → jev rationale → armed-state digest → the flip's evidence snapshot → corpus digest at flip time. An auditor can walk that chain in one pass.

## Files to Modify

- `src/judgment/arm-gate.ts` (new — milestone constants, Wilson lower bound, gate evaluation, log chain-walk verification)
- `scripts/judgment/arm-thresholds.ts` (new CLI — dry-run verdict by default; `--arm`/`--unarm` with the sign-off pair; appends the chained flip)
- `scripts/judgment/confirm-outcome.ts` (new CLI — appends outcome entries to `corpus/outcomes.jsonl`)
- `scripts/judgment/route-round.ts` (new CLI — the armed routing manifest; `not-armed` refusal)
- `scripts/corpus/schema.ts` (adds only — `OutcomeRecordSchema`, joined by the existing `recordKey`)
- `tests/judgment/arm-gate.test.ts` (new — gate, thresholds immutability, sign-off refusals, chain tamper cases, outcome join)
- `tests/judgment/route-round.test.ts` (new — armed manifest, `not-armed` refusal, provenance digests)
- `scripts/judgment/observe-round.ts` — **not modified** (declared here; byte-identical is the AC6 invariant)
- `scripts/judgment/ab-report.ts` — **not modified** (declared here; `computeReport` consumed by import)

## Security Invariants

- **INV-ARM-1 (fail-closed):** recording-only is the default state of the universe — absent log, broken chain, malformed entry, or missing sign-off each refuse; nothing routes on anything less than a chain-valid armed head.
- **INV-ARM-2 (authority bound):** armed authority is exactly the review-finding routing manifest; the approve gate, `gate-runner.ts` verdict logic, `classifyRunExit`, `classifyDiffScope`, `AUDIT_HOPS` and every fleet verb are unreachable from this story's modules (and the existing fences keep them so); no Jev answer gates code entry (charter §6).
- **INV-J2/J3 (inherited, untouched):** egress classes and the ZDR-gated stage-2 ceiling govern anything that would re-judge; the digest-stable provenance side-channel is untouched — arming adds consumers, never a new emit path.
- **INV-J5 (inherited):** mock default; this story introduces no live path at all — milestones are met by corpus accumulation, not spend.

## Definition of Done

- [ ] **Impl:** gate + flip CLI + confirm CLI + routing CLI land; the flip log is append-only with per-entry chaining; there is no other mutable arm-state anywhere (AC3).
- [ ] **Contract:** thresholds (all four, AC2) are module constants with derivation comments; grep test proves no env/config read can lower them; values match the operator-confirmed DD-21 milestone-review record that precedes any real `--arm` (AC2).
- [ ] **Test (gate):** not-eligible on the real corpus; eligible only past both milestones on fixture corpora; each refusal names its gap; the outcome-source distribution prints on every verdict (AC1, AC5).
- [ ] **Test (sign-off):** `--arm` without `--sign-off` text or without `QDS_JUDGMENT_ARM_CONFIRMED=1` refuses exit 2 having written nothing (AC1).
- [ ] **Test (tamper):** truncated log, deleted log, spliced entry, and out-of-order seq each break the chain and every consumer refuses; the negative controls of AC3 are named failing cases (AC3).
- [ ] **Test (routing):** `not-armed` refusal; armed manifest partitions by recorded answers only; every entry carries its armed-state digest; no live judgment call exists in `route-round.ts` (AC4).
- [ ] **Security:** `git diff` shows `observe-round.ts` and `ab-report.ts` byte-identical, `scripts/corpus/schema.ts` adds-only, every other `scripts/corpus/*` file untouched, and zero changed lines in all charter §6 never-edit modules (AC6).
- [ ] **Integration:** the full lifecycle runs green in a temp corpus dir — confirm → not-eligible → eligible fixture → arm → route → unarm → refuse — with mock-tier data only.
- [ ] **Test (e2e demo — MANDATORY):** the lifecycle demo above is the mandatory e2e; it is mock-tier by design (no live round), and the evidence JSON lands under `_bmad-output/evidence/v6b/j2/`.

## Dev Agent Record

*(written at implementation time — preceded by the milestone review: the operator confirms DD-21's pinned values before `--arm` can ever succeed in the real corpus)*

## Review Findings (post-merge)

*(appended by the review campaign)*
