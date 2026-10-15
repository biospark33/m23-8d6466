# ADR-2: Autonomy approval surface — auto-merge default with QA-owned verdicts, the E21-S05b inbox as the human override surface

- **Status:** ACCEPTED — operator verdict recorded 2026-10-15 via story **G1**
  (`_bmad-output/sprint-artifacts/dark-factory-v6/stories/g1-adr2-draft-and-reconciliation.md`);
  see the operator-verdict block appended at the end of this file. The body below is the
  input artifact as proposed; amendments are recorded in the verdict block, never folded
  into the draft text.
- **Date:** 2026-10-02
- **Extends:** [ADR-1](2026-09-30-adr-1-swarmclaw-macro-host.md) (ACCEPTED 2026-09-30) — and only
  within the exact clause ADR-1 §4 reserved: *"Auto-approve is out of scope here … its own future
  ADR and is explicitly NOT decided by this document."*
- **Derivation provenance:** charter `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md`
  §0 D-3, §3 row G1, §4 item 11; decision register DD-19 (`docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md`).

## Context

ADR-1 moved the macro-process front door: swarmclaw protocols host factory work via the
`external_job` step, park at `awaiting-approval`, and are decided by the scrypt-gated
`fleet approve` seam. Everything else stayed fixed — the fleet is the only way code changes
enter, the gate is allowlisted, token-on-stdin, human-only, and no swarmclaw component merges
anything by itself.

v6 changes the population of actors around that gate. The 24/7 department managers live as
E21 Home bots in one factory Home (D-3), the QA department runs post-merge hunter-packs (A2),
maintenance sweeps produce briefs that park at the gate (A3), and the v6 exit round (Z3)
proves the whole loop live. With humans deciding every parked run by hand, the operator
becomes the throughput bottleneck of their own factory — the exact failure the v4 vision's
L4 "reflect → PROPOSE, never auto-apply" shape was designed to avoid at the tuning layer,
here applied at the approval layer.

This ADR proposes the approval-layer policy ADR-1 declined to decide. It is deliberately
narrow: it does not touch the gate's mechanics, the fleet's front-door status, or the
in-box execution engine.

## Tier taxonomy (defined here — the labels previously existed only in the integration HANDOFF)

No prior document defines these terms; ADR-1 never uses the labels. They are defined here so
the reconciliation note (DD-19) and this draft share one vocabulary:

| Tier | Meaning | Status |
|---|---|---|
| **Tier A** | ADR-1's approved narrow form: swarmclaw hosts macro processes via `external_job`; the fleet CLI stays the substrate; D6 intact; the front door gains a protocol-shaped opening and nothing more. | **ACCEPTED** (ADR-1, 2026-09-30). |
| **Tier B** | Observability/notification drift: run events surface into the platform (zeropoint UI/inbox/chat) rather than only the factory's own surfaces — approval/notification surfaces move, policy does not. Partially covered already: the DF4.x SSSF visualizer renders run views; v6 adds chat digests (A1) and proposes the S05b inbox as an override surface (this ADR). Tier B is a *surface* classification only: the auto-merge default this ADR's Decision 1 proposes is a **policy change, not Tier B drift** — it is decided on its own terms by this ADR's verdict and never rides Tier B's partial adoption. | **PARTIAL, proposed to widen** (this ADR + DD-19); Decision 1 classified separately as policy. |
| **Tier C** | Engine drift: the factory itself becomes "just" swarmclaw protocol runs — events → platform UI as the primary surface, reversing D6 (in-box engine, host authority, fleet front door). | **OUT.** Nothing in v6 or this ADR adopts it. |

## Decision (PROPOSED)

1. **Auto-merge becomes the default for factory-run PRs that pass the full chain.** A run that
   completes dispatch → execution → harvest → host-side re-verify → **QA-owned verdict green**
   may merge without a human approval event. This reverses the v5 default (every PR waits at
   the approve gate) *only* for runs that clear every automated check below.
2. **QA owns the merge-verdict input.** The verdict consumed by auto-merge is the QA
   department's structured result — carried in the `fleet result` payload (the `factory_result`
   artifact's verdict field), produced by the A2 hunter-pack protocol, not by the dev run's
   self-report. A QA verdict is a first-class fact with an audit row; "green" asserted by the
   authoring run never merges anything.
3. **The E21-S05b approvals inbox is the human override surface.** Parked runs, escalations,
   and QA-flagged PRs land in the inbox the S05b approvals interception already provides.
   The inbox is a *channel*, not a *policy*: **channel ≠ policy.** `fleet approve` keeps its
   exact mechanics — scrypt-gated (`.factory/approvers.json`), allowlisted, token-on-stdin,
   human-only (ADR-1 §3 verbatim). The inbox relays *to* the gate; it never *is* the gate.
   Scripted approvers remain labeled as scripted (SC2.7 precedent).
4. **What never auto-merges.** PRs touching: the gate/credentials/audit surfaces themselves
   (`src/fleet/approval-gate.ts`, `src/providers/credentials.ts`, `src/audit/`, `AUDIT_HOPS`),
   scope outside the run's declared diff-scope, or any run whose QA verdict is absent, stale
   (rebased after QA), or escalated. These park for a human regardless of verdict.
5. **The override is the human's, always.** Any human may reject a queued auto-merge until the
   moment it executes; a rejection parks the run and records who decided. Auto-merge is a
   default, never a mandate.

## Consequences

- **Throughput:** the operator stops being the per-PR bottleneck for mechanical fixes; the QA
  department becomes the load-bearing verdict source, which is why A2 (its substrate) is a
  hard predecessor of this policy going live.
- **Risk moves into QA:** a wrong-but-confident QA verdict merges a bad PR. Countermeasures
  proposed here: verdicts are structured + audit-rowed; the never-auto-merge list (clause 4);
  A5's first-pass-accept KPI + Goodhart counter-metrics watch exactly this; the weekly L4
  reflect (M3.2) reviews auto-merge outcomes and may PROPOSE tightening — never loosening —
  the policy.
- **The gate does not move.** Every clause above composes with ADR-1 §3: the mechanics of
  `fleet approve` are unchanged; only which runs *reach* it changes.
- **Clause 5's carrier travels with any ACCEPT:** the veto-window queue is clause 5's
  precondition — auto-merge ON before the queue exists violates clause 5, and the implementing
  story's consistency test must be able to see that state (a clause-5 carrier in the named
  setting, or the verdict block's explicit clause-5 disposition).
- **ADR-1 gaps carry forward:** the #380 spend-booking gap for headless `workId` briefs is
  unaffected here; DD-20 records which side owns closing it.
- **Reversal path:** if auto-merge produces a bad merge, the operator flips the default back
  (one config value) — the story implementing this ADR (G1) must make the default a named,
  reversible setting, not inline behavior.

## What this ADR does NOT decide

- Tier C drift (events→platform UI as primary surface; reversing D6) — remains out.
- The swarmclaw chassis server-surface fate (DD-18 keeps it dormant pending this ADR's
  outcome; an ACCEPTED verdict here re-opens that question, a REJECTED verdict closes it).
- The Jev arm-thresholds policy (J2's milestones + operator sign-off are decided in the
  register, DD-21) — this ADR does not arm anything.
- Jev L6 in-box tool hooks — parked (DD-21).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep human-approve-everything (v5 default) | The operator becomes the factory's throughput ceiling; v6's 24/7 managers exist precisely to remove that ceiling. The cost is paid daily once A1/A2 land. |
| Auto-merge on dev-run self-report (no QA verdict) | The authoring run grading its own homework is the failure mode F10/INV-7 exist to prevent; a structured, auditable QA verdict is the minimum trustable input. |
| Replace `fleet approve` with the inbox as the gate | Channel ≠ policy: the gate's scrypt/allowlist/stdin mechanics are the audited, reviewed, operator-signed seam (ADR-1 §3); re-implementing them behind an inbox re-opens every attack surface the gate closed. |

## Signature

| | |
|---|---|
| **Operator (Steve)** | ✅ ACCEPTED — 2026-10-15, via story G1 (ruled in the G1 session; recorded in the operator-verdict block below) |
| **Date** | 2026-10-15 |

## Operator verdict — ACCEPTED (2026-10-15, via story G1)

Recorded by the operator (Steve) in the G1 decision session. This block is the
append-only amendment of the PROPOSED draft above, which stands as written as the
input artifact. Only the accepted clauses are implemented (story G1, AC1).

| Clause | Disposition |
|---|---|
| 1 — auto-merge default for full-chain runs | **ACCEPTED** as written. |
| 2 — QA owns the merge-verdict input (`factory_result.verdict`) | **ACCEPTED** as written; the A2 hunter-pack (v6b) owns the producer and may extend the schema adds-only. |
| 3 — S05b approvals inbox as the human override surface | **ACCEPTED** as written; channel ≠ policy holds verbatim; the inbox relay is v6b work gated on E21-S05b. |
| 4 — what never auto-merges | **ACCEPTED** as written (gate/credentials/audit surfaces, out-of-declared-scope, absent/stale/escalated QA verdicts). |
| 5 — the human override is unconditional | **ACCEPTED verbatim.** The veto-window queue is named the **blocking build item** for any arming of `autoMergeDefault`: while the queue is absent, clause 5's reject-until-execution guarantee has no carrier, so the policy stays fail-closed OFF (the setting's `vetoWindowQueueLive` carrier cannot be truthfully set). The queue is the first post-A2 concern. No clause-5 amendment is made — the single-tick consult is the v6a implementation shape, never an arming license. |

**Operator notes.**

- The pre-authorization surface of record is the named setting (`.factory/policy.json`,
  `autoMergeDefault`) — the operator's "check the box ahead of time" act: operator-local,
  gitignored, reversible by flipping one value.
- **Operator-directed follow-up (recorded here, not part of this verdict's accepted
  clauses):** a per-run "ask before it gets going" consent surface — the agent asks the
  operator, before a run starts, whether it may proceed under auto-merge — is to be
  specified as its own decided work item and built soon. It enters the record through
  normal review (no quiet scope growth in a story AC).
- The operator affirms the DAG verification chain (deterministic checks → agent
  verification rounds → QA-owned verdict) as the required pre-merge path, consistent
  with clause 1 as written.

**Effects.**

- **DD-18: RE-OPENED.** The swarmclaw server-surface (query-surface) question re-opens
  per this ADR's "does NOT decide" list; the surface stays dormant-retained until that
  follow-on decision is recorded.
- **DD-19: unchanged.** Tier B remains PARTIAL; the auto-merge default is a policy
  change decided by this verdict, never Tier B drift, exactly as the draft's tier table
  states.
- **Arming state at verdict time:** `autoMergeDefault` cannot arm — A2's QA-verdict
  producer does not exist and the clause-5 veto-window queue is not built. v6a ships
  the fail-closed machinery only.
