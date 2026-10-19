# Z3: Cross-Repo Live Exit Round — the v6 SC2.7 Analog

**Story Points:** 3
**Sprint:** v6b-Autonomy (E21-gated via A2; the v6 program's exit criterion — last story on the critical path)
**Status:** **review** — code complete in both repos; live round handoff. Predecessors A2, Z2 and M2.1 are done. The factory half is on `feature/z3-cross-repo-live-exit-round`: round plan, the leg drivers with evidence written by each leg's own driver, the AC1–AC7 assertions with fixture-tier negative controls, the SC2.6-style crash-gate wrapper, the todo-gated live test and the operator runbook in `docs/planning/v6-crossrepo-contract.md` §Z3 round record. The fork counterpart is on swarmclaw `feature/z3-exit-round-counterpart`: the `z3_exit_round` protocol, the schedule fire hook and the `scripts/solstice/z3-exit-round.ts` arm/state/cancel/disarm CLI. Three pre-PR bmad review rounds ran (`_bmad-output/workflow-state/code-review/z3-r{1,2,3}/`). **The live T2 round is not fired.** It is blocked upstream on #467 (QA harvest findings never persisted host-side) and #465 (findings-only runs strand in `pausing`). The live test refuses by name, before any spend, while `Z3_UPSTREAM_BLOCKERS` is non-empty. After that, it needs the operator's GO. Live tier: **live — T2 minimum, cross-repo**. **No crontab fallback exists for this story:** the round's entire value is the live proof.

## Spec Reference

> **Spec drift (2026-10-19, D-1):** this story calls ADR-2 PROPOSED. It became ACCEPTED on 2026-10-15 via G1. G1 shipped the fail-closed policy (`src/fleet/auto-merge-policy.ts` plus the run-completion consult), but ON stays structurally unreachable until the clause-5 veto-window carrier (`enqueueVetoWindow`) is in the tree. Z3 still asserts park → human decide, and it now also records the auto-merge consult state and fails AC2 if it is ON. The contract delta is recorded in `docs/planning/v6-crossrepo-contract.md` §Z3 round record.

- **SC2.7 precedent** (`_bmad-output/evidence/openrig-sc2/`, 11-round evidence set): the 2026-09-30 exit chain `…T03-37-09-sc2-7-kill-and-provision.json → …-box-forensics.json → …-observe.json → …-approve.json → …-branch-and-complete.json`, plus the #383 race-window re-run `…T15-19-10-… → …-race-window-closed.json → …-branch-and-complete.json`; SC2.6's windows (`…T01-08-26-sc2-6-window-a…`) carry the mid-submit kill calibration that motivates the crash-window leg here.
- ADR-1 (`docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md`): clause 3 verbatim — "`fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only"; clause 4 — auto-approve/auto-merge is explicitly NOT decided (G1's ADR-2 is PROPOSED — it decides nothing).
- Charter: Z3 row (`2026-10-01-v6-derivation-session-INPUT.md:101`), §5.6 live-round rules (no-fakes, worst-case spend printed, operator GO, keys/boxes cleaned in `finally`, evidence scrubbed), §6 guardrails, risk #4 (approval-channel creep → scripted approvers labeled).
- Sibling contracts consumed: **Z3↔Z2 boundary** — Z2 owns trigger wiring + the `factory_observe` step kind; Z3 only *drives and asserts* them. **Z3↔Z1 boundary** — Z1 owns the `factory_observe` read-only consumption surface (read-only `fleet status`/`result`, no box, no key); Z3 consumes it. **Z3↔A2 boundary** — A2 owns the QA protocol (legs, retain, issues); Z3 runs it end-to-end and adds the round scaffolding (approval-park leg, crash-window leg, exactly-one-box proof).

## User Story

As the operator, I want one scheduled protocol to drive a real fleet run end-to-end across both repos — memory priming and observe consumption added to the proven SC2.7 shape — so that v6 has its exit evidence: the macro host and the memory ladder are real, and the approval gate still needs a human.

## Overview

The round fires A2's scheduled protocol once: QA hunter-pack legs run and retain findings to the shared `qds-` bank (host-side, A2's M1.2-pattern retain — the gateway does not re-route host retain/recall; the round's own memory-leg assertions authenticate via M2.1's long-lived agent tokens, no per-run key — that is M2.2/M2.3's lane), then the protocol's code-affecting fleet run dispatches, its recall surfaces the just-retained findings (priming round-trip proven *inside* one protocol), the run parks at the approval gate, a human decides, and the branch witness lands. Observe legs read run state via Z1's `factory_observe` surface.
**What this does NOT deliver:** no auto-merge — ADR-2 is PROPOSED and decides nothing; the park→human→decide arc is the assertion. No in-box `kg_recall` leg (M2.2/M2.3's lane — no per-run recall key is minted here). No new fleet verbs, no approval-policy change, no schedule-authoring UX.

## E2E Slice

**Demonstrable behavior:** Given operator GO, a fork schedule wakes the QA protocol. Kill-and-provision provisions exactly one box per fleet run; box-forensics proves the count. QA legs run, harvest, and retain findings host-side (A2's M1.2-pattern retain; the priming-recall leg's gateway-origin assertion authenticates with an M2.1 agent token). The protocol's code-affecting run dispatches; its dispatch recall returns a retained finding inside `<kg_context>` (round-trip closed). Observe legs read terminal state via `factory_observe` — no box, no key. The code-affecting run parks at the approval gate; the operator executes `fleet approve` (token on stdin, scrypt-verified, approver id recorded, `scripted: true` labeled when a driver performed it — extending SC2.7's synthetic-approver-id precedent (sc27-e2e-approver) with an explicit `scripted: true` field the SC2.7 evidence never carried; new requirement per DD-28.26(8)); the `branch_taken` witness lands and a `factory_result` artifact exists for every terminal verdict (F-011).

**Wiring closed:** On completion, schedule → protocol → fleet runs → observe → findings→bank→priming → park → human decide → branch works end-to-end using only code merged by this story plus A2, Z2, M2.1 (and their transitive bases). **No stub, no `TODO: wire later`.** The approval-inbox channel (E21-S05b) is out of scope by construction — channel ≠ policy, and the CLI stdin path is the one asserted.

**Dependency edges (predecessors):** **A2**, **Z2**, and **M2.1** are direct edges (the protocol driven, the trigger + step kind consumed, the agent tokens the round's memory-leg assertions authenticate with). Transitive: M1.2 (through A2's retain/recall pattern), Z1 (through Z2's step kind), E21 S02b+S03b (through A2's gate). **Not an edge — M2.2/M2.3:** this round's memory legs are host-side; no in-box recall is asserted. **Not an edge — A3:** the parked run is the protocol's own code-affecting run (SC2.7's shape), not a maintenance sweep. **Not an edge — G1:** the round *produces evidence for* ADR-2's draft; it does not adopt it.

## Acceptance Criteria

1. **(make-or-break)** Given operator GO, one scheduled protocol fire drives the full arc green — trigger → fleet runs → observe legs → findings→bank→priming round-trip → approval park → human decide → `branch_taken` — and every leg writes its own timestamped machine-checkable JSON (`exitCode`/`stdoutTail`/`stderrTail` + observability lines) into `_bmad-output/evidence/v6-z3/`, in the `openrig-sc2/` naming style. *Negative control: any leg evidence hand-copied or reconstructed post-hoc MUST fail this one — house style is "each leg JSON is written by the leg's own driver script."*
2. **Auto-approve fails.** The approval leg records the approver id, scrypt verification, and the stdin path; a driver-executed approve is labeled `scripted: true`. *Negative controls, both MUST fail: a round that proceeds past the park without a recorded human/scripted-labeled approve decision; a round that treats ADR-2's PROPOSED status as license to auto-merge — a proposal decides nothing.*
3. **Exactly-one-box is proven, not assumed.** Per fleet run: the kill-and-provision leg names one VM, box-forensics confirms exactly one box for that runId, teardown reaps it; round cap `Z3_MAX_FLEET_RUNS = MAX_QA_LEGS + 1` (DD-28.26(7) — derived from A2's constant, never restated here; QA legs + the code-affecting run), sequential. *Negative control: a round whose evidence shows two live boxes for one runId — or whose box count is unproven (no forensics leg) — MUST fail this one.*
4. **Crash-window idempotency.** A deliberate mid-submit kill (SC2.6 calibration — `FLEET_EXEC_TIMEOUT_MS = 300_000` at `fork:src/lib/server/protocols/protocol-factory-exec.ts` makes the window real) followed by a re-drive strands no box, double-books no spend, and tears no run record; the re-drive reuses surviving state. *Negative controls, all MUST fail: a re-drive that provisions a second box for the same runId; a re-drive whose ledger shows two bookings for the same runId (readable via Z1's status/result surface); a re-drive that mutates or recreates the run record.*
5. **In-box retain fails.** The memory legs' evidence shows retain executed host-side — A2's retain rides the factory host's Hindsight client (M1.2 pattern); any round-side gateway assertion logs the gateway origin with its agent token; no write credential exists in any box at any point. *Negative control: an evidence trace of findings retained from inside a box MUST fail this one (F10/INV-7, DD-16).*
6. **Observe consumes Z1's read-only surface.** Observe legs call `factory_observe` (read-only status/result); they provision no box and mint no key. *Negative control: an observe leg that provisions a box or mints a provider or memory key MUST fail this one.*
7. **Live rules hold.** `*.live.test.ts` no-fakes hard rule; worst-case spend printed before fire (sum of per-run caps, printed by `scripts/z3/round-plan.ts`); operator GO recorded per round; keys revoked-and-verified and boxes destroyed in `finally` — a failed leg still cleans; evidence scrubbed (no tokens, no credentialed URLs). *Negative control: an evidence file containing a live credential, or a `finally` that skips revoke-verify on failure paths, MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| Scheduled protocol fire (fork schedule → QA protocol) | in-scope — the round's trigger | live round | none in v6.0 |
| Post-merge trigger re-fire | out-of-scope — A2's live round proved it | — | A2 |
| Operator-initiated protocol fire | out-of-scope — none in v6.0 | — | none |
| Auto-merge / policy-gated approval | out-of-scope — ADR-2 PROPOSED (G1), consumed by nothing pre-verdict | — | G1 |
| In-box `kg_recall` legs | out-of-scope — M2.2/M2.3 | — | M2.3 |
| New fleet verbs / approval-policy change | out-of-scope — registry closed, ADR-1 §3 | — | none |

## Infra Prerequisites

| Component | Service | Lifecycle Hook Verified |
| --- | --- | --- |
| A2 QA protocol | fork-side protocol + factory legs | A2 live round green before this story starts |
| Z2 triggers + `factory_observe` step kind | fork `origin/dev` at bumped pin | Z2 fake-CLI-journal suite green; pin bump recorded |
| M2.1 gateway + agent tokens | dedicated Hindsight behind the gateway (M1.1 stack) | M2.1 suites green; gateway round-trip re-checked before fire |
| T2-grade box image | exedev driver pin | re-pin ritual landed (wave-0 ops) — blocks every T2 round |
| Operator GO | spend gate | recorded per round in evidence, before fire |

> Not prerequisites: E21-S05b approvals inbox (the CLI stdin path is the asserted channel); M2.2/M2.3 (no in-box lane); A3 (no sweep). Box + fork daemon + schedules are the round's substrate — they are what it proves, listed here as its fuel.

## Technical Notes

- **Round shape (named, not implied):** one scheduled protocol fire; `Z3_MAX_FLEET_RUNS = MAX_QA_LEGS + 1` (DD-28.26(7) — derived from A2's constant, never restated; QA hunter-pack legs + one operator-chosen benign code-affecting brief whose recall proves priming and whose chain parks at the gate); worst-case spend = Σ per-run `groupCapUsd`, printed pre-fire. SC2 precedent priced this at 2–4 rounds until the invariants + park held (R5 §4.4).
- **Scripted approver, codified.** The human executes the approve (terminal or wrapper); evidence records approver id + `scripted: true` + the stdin path taken, token never logged. This extends SC2.7's synthetic-approver-id precedent (sc27-e2e-approver) — whose evidence carried no `scripted` field — with the explicit label as a new requirement (DD-28.26(8)); the approval *policy* is untouched (ADR-1 §3 verbatim).
- **Exactly-one-box proof shape.** Driver inventory read before provision and after teardown, per runId; the forensics leg re-reads the run record + driver inventory and asserts equality. No polling, no daemon — the legs are an exiting sequence like DF3.8's sweep.
- **Fork-rev stamp is the leg drivers' job.** Z1's drift alarm (`swarmclawForkRev`) arms evidence that carries the field, and this round extends `live-harness.ts` unmodified — which stamps nothing fork-side (`sc2-harness.ts` owns the `openrig-sc2/` stamp). Every leg JSON therefore carries `swarmclawForkRev` = the fork rev the round ran against, and the round record names that rev: Z1's trigger surface makes Z3 rounds a pin-bump occasion, and a round that can't name its rev can't trigger one.
- **Crash-window leg.** Kill during the `external_job` submit window (where SC2.6 calibrated), then re-drive the same protocol. The #383 approval-gate pre-registration (before teardown closes the record) is what makes the re-drive safe to assert: no poller tick reads a pre-approval terminal verdict.
- **Considered and rejected: reusing the SC2.7 evidence set as this round's evidence.** Rejected — SC2.7 predates the memory legs and observe consumption; the v6 exit criterion requires its own timestamped set. Revisit never; the round is per-program by design.
- **Region ownership on shared files:** `src/fleet/verbs.ts` untouched (no new verbs — 16-verb closed registry); `src/audit/link-store.ts` untouched (`AUDIT_HOPS` frozen); `src/providers/exedev/driver.ts` untouched (pin as-landed by the re-pin ritual; no image-pin ritual owed by this story).

## Observability Contract

- Leg JSON naming: `YYYY-MM-DDTHH-mm-ss-…Z-z3-<leg>.json` matching `openrig-sc2/` house style; required legs: `trigger`, `kill-and-provision`, `box-forensics`, `qa-run-observe`, `findings-retain`, `priming-recall`, `observe-read-only`, `approval-park`, `approve`, `branch-and-complete`, `crash-window-redrive`.
- `factory_result` artifact asserted on every terminal verdict (F-011); `branch_taken` witness asserted (`fork:protocol-step-processors.ts:354`). Absent-not-0: a leg that did not run contributes no counts; counts of 0 appear only from legs that ran. Volatile fields (finding text, recall bodies) stay in leg JSON, never in digest-stable store rows.

## Files to Modify

- `tests/fleet/e2e/z3-exit-round.live.test.ts` — new (**Tier 2, cross-repo** — deliberately, because tier selection drives real spend; extends `tests/fleet/e2e/live-harness.ts` unmodified, flat beside the existing `*.live.test.ts` files)
- `scripts/z3/round-plan.ts` — new (round composition, cap constants, worst-case spend print, GO gate)
- `scripts/z3/leg-drivers.ts` — new (one driver per leg; each writes its own leg JSON)
- `_bmad-output/evidence/v6-z3/` — new (committed scrubbed evidence, `openrig-sc2/` naming)
- `_bmad-output/evidence/openrig-sc2/fork-rev-manifest.json` — **adds only**: the `v6-z3/` rows this round's evidence needs for Z1's alarm (authored by this round per z1 AC5 — Z1 authors `openrig-sc2/` rows only)
- `docs/planning/v6-crossrepo-contract.md` — adds only (Z3 round record; any contract deltas observed during the round enter as findings, never as quiet edits)
- Counterpart (solstice repo, not a factory file): scheduled-protocol round harness + schedule definition, BUILD-IN-FORK, same contract text.

## Security Invariants

- **INV-Z3-1 (ADR-1 §3, verbatim):** `fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only; scripted execution is labeled, never hidden.
- **INV-Z3-2:** auto-merge is absent — ADR-2 is PROPOSED and nothing in this round merges without the recorded human decision.
- **INV-Z3-3 (F10/INV-7/DD-16):** no write credential in any box; A2's retains are host-side per its M1.2-pattern contract (host env token — the gateway does not re-route host retain/recall); the round's memory-leg assertions authenticate with M2.1's bank/verb-scoped agent tokens; no per-run key minted (no in-box recall here).
- **INV-Z3-4 (ADR-1 §2):** fleet is the only code-entry path; the protocol's code-affecting run is a fleet run — brief-validated, budget-gated, box-isolated, harvested.
- **INV-Z3-5:** cleanup is unconditional — keys revoked-and-verified and boxes destroyed in `finally`, on every exit path.
- **INV-Z3-6:** evidence scrubbed before commit; 8888/18889 never exposed; explicit `qds-` bank ids every call.

## Definition of Done

- [x] **Impl:** round plan + leg drivers; tsc/biome clean; `detect_changes()` 0 unexpected affected symbols. *(2026-10-19: scripts/z3/** + fork counterpart; fences byte-identical to dev; z3-r1..r3 review rounds.)*
- [ ] **Integration:** worst-case spend printed and operator GO recorded before the first fire.
- [ ] **Integration:** full round green — all 11 legs present, each JSON written by its own driver and stamped `swarmclawForkRev` (Z1's alarm covers the `v6-z3/` corpus — the manifest rows for it are authored by this round, per z1 AC5's per-directory growth rule).
- [x] **Security:** AC2/AC3/AC5 negative controls demonstrated failing (fixture-tier dry runs where live spend is not warranted). *(tests/z3: named `AC<n> negative control:` tests for AC1–AC7, all through the production assertions.)*
- [ ] **Integration:** crash-window leg live — mid-submit kill + re-drive, zero stranded boxes, zero double spend.
- [ ] **Integration:** priming round-trip proven — the code-affecting run's `<kg_context>` contains a retained finding with citation token.
- [ ] **Security:** `finally` cleanup verified on a failure path (deliberately failed leg → revoke-verify receipts in evidence).
- [ ] **Test (e2e demo — MANDATORY):** the live T2 cross-repo round IS the demo; `_bmad-output/evidence/v6-z3/` scrubbed and committed.
- [x] **Integration:** counterpart fork-side round harness filed in the solstice repo from the same contract text. *(swarmclaw `feature/z3-exit-round-counterpart`: `z3_exit_round` protocol + schedule fire hook + `scripts/solstice/z3-exit-round.ts` arm/state/cancel/disarm.)*
- [ ] **Contract:** v6 exit criterion recorded (sprint-status v6 + program notes); `bun test tests/scripts/story-consistency.test.ts` green.
