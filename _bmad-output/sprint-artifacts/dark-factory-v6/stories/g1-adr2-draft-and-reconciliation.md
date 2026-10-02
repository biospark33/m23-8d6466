# G1: ADR-2 Operator Decision Path + Decided-Shape Implementation — Fail-Closed Until Ruled

**Story Points:** 2
**Sprint:** v6a — Foundation (Governance epic; wave-1, zero E21 gates — the implementation half is verdict-gated, and that gate is operator GO, not an E21/ops gate)
**Status:** ready-for-dev — pre-dev campaign (qds-story-review) runs before any dev lane starts

> **The input artifact already exists.** The derivation session wrote the draft:
> `docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md` (PROPOSED; it defines the Tier A/B/C
> taxonomy itself per DD-19, closing R2 §2's finding that no tier labels existed in the record before).
> G1's work is the **operator-decision path**: present the draft, record the verdict, implement only
> what was accepted. A REJECTED verdict is a valid completion, not a failure.

## Spec Reference

- Charter `2026-10-01-v6-derivation-session-INPUT.md` §3 v6a G1 row; §4 item 11 ("ADR-2 draft scope per Z-table row").
- **Input artifact:** `docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md` — PROPOSED; Decision list verbatim: (1) auto-merge becomes the default for runs passing the full chain; (2) QA owns the merge-verdict input — a structured verdict carried in the `fleet result` payload (`factory_result` verdict field), never the dev run's self-report; (3) the E21-S05b approvals inbox is the human override surface (channel ≠ policy); (4) what never auto-merges — the gate/credentials/audit surfaces, out-of-declared-scope, verdict absent/stale/escalated; (5) the override is the human's, always — any human may reject a queued auto-merge until the moment it executes. The reversible default is not a Decision clause — it is Consequences' **Reversal path**: "a named, reversible setting, not inline behavior".
- **ADR-1** (`docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md`, ACCEPTED — closed record, never edited): §4 reserved exactly this decision ("Auto-approve is out of scope here … its own future ADR"); §3 verbatim: "**channel ≠ policy** — `fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only. The inbox relays *to* the gate; it never *is* the gate."
- **DD-18:** the swarmclaw server surface is dormant-retained pending this ADR's outcome — an ACCEPT re-opens the query-surface question, a REJECT closes it. **DD-19:** the Tier reconciliation note; its override-surface clause is ADR-2-dependent and must stay true post-verdict.
- R3 facts: `TIMEOUT_APPROVER_ID = "system:timeout"` (`src/fleet/approval-gate.ts:876`) — the recorded precedent for labeled non-human approver decisions; gate mechanics (`src/fleet/approvers.ts`: scrypt `.factory/approvers.json` 0600, token stdin-only); the `fleet result` verb (no `--driver`, poller-safe, `src/fleet/verbs.ts:616`); the run-completion chain (`src/fleet/run-completion.ts:392`) that ends at gate registration; the `run-approval` audit hop (walk-observed vocabulary — frozen, DF5.3). **DD-28.26(2)** rules where the `policy:adr-2` label lives: in the run record's persisted approval state (`approverId` — the `TIMEOUT_APPROVER_ID` home, `approval-gate.ts` ~:876), not on the hop — the hop is walk-observed-only with no emitter (link-store.ts design), and DD-28.1 sanctions hop-vocabulary population only for EMPTY hops.
- Standing rule (autonomy-horizon review §4.3): autonomy expansion enters as decided records through normal review — **never as quiet scope growth in a story AC**. This story IS that discipline applied to the approval layer.

## User Story

As the operator,
I want the ADR-2 draft put to me for a recorded verdict, and only the clauses I accept implemented — with auto-merge mechanically fail-closed while the ADR is PROPOSED and a named reversible setting when accepted —
so that the approval doctrine changes only by my explicit, recorded decision, and can be undone with one value.

## Overview

Three parts. **(1) Decision workflow:** the operator reads the draft, rules in chat — ACCEPTED / AMENDED / REJECTED (AMENDED records a per-clause disposition) — and the verdict is recorded in the ADR file: status flip, signature block, and a dated operator-verdict block enumerating per-clause dispositions and naming the effects on DD-18 and DD-19. **(2) Fail-closed policy seam:** a `src/fleet/` policy module whose auto-merge default is OFF unless the operator, post-verdict, creates the named setting; absent file = the v5 park behavior, byte-identical. **(3) Implementation strictly of the accepted clauses:** the never-auto-merge predicate, the labeled auto-merge consult in the run-completion chain, and the QA-verdict consumption requirements. On REJECTED, part 3 is zero lines of `src/` and the DD-18 question closes.

**What this does NOT deliver, stated before an AC implies otherwise:** no behavior change pre-verdict; no edit to ADR-1 (closed record); no gate-mechanics change ever (the S05b inbox relay is v6b-side, gated on E21-S05b); no QA-verdict producer (A2, v6b — until it lands, no run is auto-merge-eligible, by construction); no Tier C drift (remains out, DD-19); no Jev arming (this ADR does not touch J2's gate).

## E2E Slice

**Demonstrable behavior:** Given a fake-driver run record driven to the end of the observe chain, When the chain reaches the gate point, Then with the setting absent (or the ADR PROPOSED) the run parks `awaiting-approval` exactly as v5 — same surface, same exit path; with the ADR ACCEPTED and the setting ON and an eligible run, the chain proceeds with the run record's persisted approval state carrying `approverId: "policy:adr-2"` — the label's home per DD-28.26(2) (the `system:timeout` precedent's home in `approval-gate.ts` ~:876), not the `run-approval` audit hop, which stays the walker's existing first-observation digest with no new emitter; and a run whose diff touches any never-auto-merge path (e.g. `src/providers/credentials.ts`) parks regardless of verdict or setting.

**Wiring closed:** On completion of this story, every auto-merge path in the factory routes through the fail-closed policy module — using only code merged by this story plus the existing run-completion chain and audit hop. **No stub, no `TODO: wire later`.** The eligibility path is inert until A2 produces verdicts, and that inertness is asserted by test, not assumed.

**Dependency edges (predecessors):** none — charter root (wave 1, no gates).

> **Not an edge — A2:** the QA-verdict *producer* is v6b; G1 pins the consumption requirements and stays structurally ineligible until A2 lands. **Not an edge — E21/S05b:** the override-surface clause is a channel whose factory-side obligation (channel ≠ policy) is asserted here, with no inbox code. **Not an edge — Z2:** no observe artifact is consumed pre-verdict.

## Acceptance Criteria

1. **(make-or-break — no verdict, no implementation)** Given the ADR is PROPOSED, When any work in this story proceeds, Then the only permitted change is the recorded verdict block (plus this story's own repo-state tests — the consistency and verdict-block tests, which read files and import no policy module; the policy module and its loader-arm tests are implementation and land post-verdict together); every implementation AC below is unreachable until the operator rules, and the ruling is recorded in the ADR file itself (status + signature + dated operator-verdict block with per-clause dispositions). *Negative controls, both MUST fail:* **implementation proceeding without an operator verdict** — any `src/` diff landing against a still-PROPOSED ADR; and **auto-merge enabled while ADR-2 is PROPOSED** — the operator-local ON setting present in the working tree while the ADR header still reads PROPOSED (`.factory/` is gitignored operator-local by design — the `approvers.json` posture — so the setting cannot be "committed"; the repo-consistency test reads the working tree and makes that tree red, while a fresh CI checkout trivially reads OFF because the ON state cannot travel through git).
2. **Fail-closed loader + reversible default (Consequences — reversal path).** Given the policy module, When loaded, Then the default is OFF with the file absent, OFF with the file present-but-OFF, and ON only via the operator-created named setting (`.factory/policy.json` — operator-local and gitignored by the `.factory/` posture, 0600, `{ "autoMergeDefault": true, "adr2AcceptedOn": "<date>" }`); the ON state is a named value the operator flips back to reverse — never inline behavior, never committed. *Negative control: an implementation that enables auto-merge through code default, env, or any path other than the named setting MUST fail this one.*
3. **The never-auto-merge list is a predicate, not prose (clause 4).** Given any candidate run, When eligibility is evaluated, Then a run parks regardless of verdict or setting when its diff touches the named surfaces (`src/fleet/approval-gate.ts`, `src/providers/credentials.ts`, `src/audit/`, `AUDIT_HOPS` ownership), falls outside its declared diff-scope (compared against the run record's declared scope using `classifyDiffScope`'s class vocabulary — restated here so this AC is self-contained: `scope-requires-privilege` = deny-glob hit, `out-of-scope-diff` = no allow match or unpermitted action; **the symbol is never imported or modified** — the vocabulary crosses, the fixloop layer does not), or carries a QA verdict that is absent, stale (rebased after QA), or escalated. *Negative control: a predicate that merges with a stale or absent verdict, or that imports/modifies `classifyDiffScope`, MUST fail this one.*
4. **QA-verdict consumption requirements are pinned; v6a inertness is asserted (clause 2).** Given eligibility, Then it requires a structured QA verdict carried in the `fleet result` payload. G1's pin of record is the minimal consumption shape ADR-2 clause 2 itself names — `factory_result.verdict` plus the presence/freshness/escalation flags; A2 owns the producer and may extend its schema adds-only. The verdict must be present, fresh, not escalated, audit-rowed, where audit-rowed means the verdict is traceable to its producing QA run's audited records (the producing run IS the audit trail; no new hop — `AUDIT_HOPS` frozen — the exact row mechanism is the A2 producer's to name) — and a test proves that with no producer in the production module graph, **no v6a run is auto-merge-eligible** (the chain always parks; the three-arm demo's proceed arm exercises eligibility with a test-fabricated `fleet result` payload per the same schema — a fixture, not a producer, and the inertness test asserts no real producer exists in the production graph). *Negative control: an implementation that treats the dev run's self-report as a verdict — the exact failure ADR-2's own Alternatives table rejects ("grading its own homework") — MUST fail this one.*
5. **The decided decision is labeled and audited; the gate never moves (clauses 1 + 3).** Given an eligible run under an accepted policy, When the chain proceeds, Then the decision carries approver id `policy:adr-2` (labeled non-human, the `system:timeout` precedent — `TIMEOUT_APPROVER_ID`, `approval-gate.ts:876`) **in the run record's persisted approval state** — the label's sanctioned home per DD-28.26(2); the `run-approval` audit row remains the walker's existing first-observation digest with **no new emitter for the hop** (walk-observed-only; DD-28.1 sanctions vocabulary population only for EMPTY hops — `AUDIT_HOPS` frozen); and `src/fleet/approval-gate.ts` is byte-identical — the scrypt/allowlist/stdin/human path untouched, the inbox clause recorded as a v6b relay. *Negative controls, all MUST fail: any diff to the gate's mechanics, any new emitter writing the hop, and any shape where an inbox or other channel is the gate rather than a relay to it — CHANNEL ≠ POLICY verbatim.*
6. **Rejection is a first-class completion.** Given a REJECTED (or clause-1-unaccepted AMENDED) verdict, When the story closes, Then the merge contains the verdict block, the DD-18 closure note (server surface stays dormant-retained), and **zero `src/` implementation lines**; the gate doctrine is unchanged. This outcome satisfies this story's DoD. *Negative control: a REJECTED outcome that ships any enabling code, or an ACCEPTED one that leaves DD-18 unaddressed, MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| operator verdict (ACCEPTED / AMENDED / REJECTED) → recorded block | in-scope | verdict-block presence asserted in `tests/fleet/auto-merge-policy.test.ts` | — |
| fail-closed loader (absent/OFF/ON arms) | in-scope | same suite | — |
| never-auto-merge predicate (paths, scope, verdict freshness) | in-scope | `tests/fleet/auto-merge-policy.test.ts` | — |
| run-completion consult + labeled `policy:adr-2` decision | in-scope | `tests/fleet/auto-merge-chain.test.ts` (fake driver) | — |
| repo-consistency test (setting ON while ADR PROPOSED = red) | in-scope | same suite | — |
| S05b inbox relay as override surface | out-of-scope — v6b, gated on E21-S05b; channel ≠ policy asserted here, no inbox code | — | A1-era v6b work |
| QA-verdict production (`factory_result` from the hunter-pack) | out-of-scope — A2, v6b; G1 pins consumption only | — | A2 |
| gate-mechanics changes (scrypt/stdin/allowlist) | out-of-scope — never; ADR-1 §3 and ADR-2 both bind | — | none |
| Tier C drift (events→platform UI primary, D6 reversal) | out-of-scope — remains out (DD-19) | — | none |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| run-completion chain | `src/fleet/run-completion.ts` (existing) | chain suite green **before** this story starts; ineligible path **byte-identical after** |
| approval gate | `src/fleet/approval-gate.ts` + `approvers.ts` | gate suite green; **byte-identical after** — a diff here is the AC5 violation signal |
| audit hop walker | `src/audit/chain.ts` (read-only) | audit suite green **byte-identical after**; no new hop |

> Not a prerequisite: any box, any key, any spend, any live round, any E21 lane, any Hindsight instance.
> G1 is charter-tier `none` and sits in R5 §4.3's live-round exclusion — the demo runs on the fake driver.

## Technical Notes

- **The workflow's recording step is a docs edit with contract force.** The verdict block is appended to the draft (the PROPOSED body stays as written — the draft is the input artifact; amendments are recorded, not silently folded). The block names: per-clause dispositions, the DD-18 effect (re-opened / closed), and the DD-19 effect (unchanged, or a dated register addendum if the verdict changes what DD-19 records — the register is this derivation's open record; dated addendum is its sanctioned form).
- **Considered and rejected: runtime parsing of the ADR header by the loader.** Docs are not runtime config; the loader stays dumb and fail-closed (absent = OFF), and the "ON while PROPOSED" invariant is a working-tree consistency test — the same discipline as the gitnexus contract suite: the one test meant to go red on drift. It runs where the tree lives (operator host, dev lanes), treats a missing or headerless ADR file as PROPOSED, and a fresh CI checkout trivially reads OFF because the gitignored setting cannot travel through git.
- **Considered and rejected: implementing eligibility for non-QA runs.** Clause 2's minimum trustable input is a structured, auditable QA verdict; without a producer, a permissive eligibility field would be a hole wearing a feature's name. Structural inertness is the honest v6a state.
- **Region ownership on shared files:** `src/fleet/run-completion.ts` takes an **adds-only** consult before gate registration (ineligible path byte-identical); `approval-gate.ts`, `src/gate/` verdict logic, `classifyRunExit`, `classifyDiffScope` are **not modified**. No re-pin is owed — nothing under the box COPY set changes.
- **Guards/limits (named):** the consult adds one synchronous policy evaluation to the chain (no I/O beyond the policy file read); the verdict block is append-only; `.factory/policy.json` follows the `.factory/` 0600 posture beside `approvers.json`.
- **Deviation (binding on this story): clause 5's veto window is not built here.** ADR-2's "any human may reject a queued auto-merge until the moment it executes" implies a queue with a lifetime; the v6a consult decides at chain-end in one tick, so there is nothing to veto against. With no producer (AC4) nothing is eligible anyway, so the divergence is unreachable in v6a. When A2 makes eligibility real, the veto-window queue becomes the first post-A2 concern — and if the operator's verdict keeps clause 5 verbatim, the verdict block must name the queue as accepted-not-yet-built, or the wiring waits for it. Surfaced rather than silently absorbed.

## Observability Contract

- Chain event `auto-merge-consult` (`{runId, eligible, reasons: [...]}`) on every chain-end evaluation — eligible runs list the satisfied requirements; parked runs list the failing clause by name (`never-path`, `scope`, `verdict-absent`, `verdict-stale`, `verdict-escalated`, `policy-off`). The decision itself is visible in the run record's persisted approval state (`approverId: "policy:adr-2"` — DD-28.26(2)); the `run-approval` audit row stays the walker's first-observation digest — no emitter is added for the hop.
- `reasons` is **absent, not `[]`**, when the policy is OFF (no evaluation occurred — the default park is the v5 behavior, not a consult outcome). No token or verdict payload material in logs.

## Files to Modify

- `docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md` (verdict block — status flip + signature + dated operator-verdict block; the only docs edit)
- `src/fleet/auto-merge-policy.ts` (new — fail-closed loader, never-auto-merge predicate, eligibility, consult result)
- `src/fleet/run-completion.ts` (adds-only — the consult before gate registration; ineligible path byte-identical)
- `tests/fleet/auto-merge-policy.test.ts` (new — loader arms, predicate arms, repo-consistency test, verdict-block presence)
- `tests/fleet/auto-merge-chain.test.ts` (new — fake-driver three-arm demo: default park, accepted-eligible labeled proceed, never-list park)
- `src/fleet/approval-gate.ts` (**not modified** — byte-identical; ADR-1 §3 / ADR-2 clause 3 bind)
- `src/gate/` verdict logic + `classifyDiffScope` (`src/fixloop/feedback-run.ts`) (**not modified** — never-edit list; vocabulary restated, never imported)

## Security Invariants

- **INV-G1-1 (fail-closed until ruled):** PROPOSED or verdict-absent = the v5 park behavior on every path; no `src/` implementation without a recorded verdict; the repo cannot hold an ON setting against a PROPOSED ADR without going red. What this does not fence, plainly: a future operator edit that flips the setting post-acceptance — that flip is the designed, reversible act.
- **INV-G1-2 (the gate does not move — CHANNEL ≠ POLICY verbatim):** `fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only; the gate's mechanics are byte-identical after this story; any channel (inbox or otherwise) relays *to* the gate and never *is* the gate.
- **INV-G1-3 (labeled, audited decisions):** auto-merge decisions carry `policy:adr-2` in the run record's persisted approval state (DD-28.26(2)); the `run-approval` hop stays walk-observed-only — no new emitter; `AUDIT_HOPS` frozen; scripted/policy decisions are labeled as such (SC2.7 precedent).
- **INV-G1-4 (reversibility is a named setting, never inline):** the default is one operator-owned value; the reversal path from ADR-2's Consequences is implemented, not narrated.
- **INV-G1-5 (closed records untouched):** ADR-1 is never edited; the draft's PROPOSED body is amended only via the appended verdict block; the never-edit list (`AUDIT_HOPS`, gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope`) holds.

## Definition of Done

- [ ] **Workflow:** operator verdict recorded in the ADR (status + signature + dated block, per-clause dispositions, DD-18/DD-19 effects named) — whichever outcome (AC1, AC6).
- [ ] **Impl (accept/amend paths):** `auto-merge-policy.ts` + the run-completion consult; on REJECTED: zero `src/` lines and the DD-18 closure note instead (AC2–AC4, AC6).
- [ ] **Test (fail-closed):** absent-file OFF, present-OFF, ON-requires-setting arms; **an ON setting against a PROPOSED ADR makes the consistency test red** (AC1, AC2).
- [ ] **Test (never-list):** named paths, out-of-scope, verdict absent/stale/escalated each park regardless of setting; `classifyDiffScope` import-zero (AC3).
- [ ] **Test (inertness):** with no QA-verdict producer in the production module graph, no v6a run is eligible — the chain always parks; the proceed arm is fixture-fed, and the inertness test asserts no real producer in the graph (AC4).
- [ ] **Test (gate unchanged):** `approval-gate.ts` zero-diff; an eligible proceed carries `approverId: "policy:adr-2"` in the run record's persisted approval state (DD-28.26(2)); the `run-approval` hop gains no emitter, no new hop (AC5).
- [ ] **Contract:** run-completion diff adds-only; ineligible path byte-identical; audit walker byte-identical after.
- [ ] **Security:** INV-G1-1..5 verified; ADR-1 untouched; verdict block append-only.
- [ ] **Test (e2e demo — MANDATORY):** fake-driver three-arm chain demo — default park (v5-identical), accepted-eligible labeled proceed, never-list park. **Explicitly non-live:** no box, no spend, no E21 — every behavior under test is host-side and offline.

## Dev Agent Record

*(written at implementation time, not at spec time.)*
