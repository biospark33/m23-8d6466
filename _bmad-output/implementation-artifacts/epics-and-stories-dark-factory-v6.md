# Dark Factory v6 — Epic & Story Index

> **Dark Factory v6 backlog — derived 2026-10-02** from the program charter
> `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md`
> (operator decisions D-1…D-5 LOCKED 2026-10-01).
> Derivation decisions (epic codes, DD-14+, substrate erratum, ops register, campaign adjudications):
> `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md`.
> Cross-repo contract: `docs/planning/v6-crossrepo-contract.md`.
> ADR-2 (PROPOSED): `docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md`.

> **Epic bullets are summaries, non-normative; story files govern.** Where a bullet and its
> linked story file disagree, the story file is authoritative.

> **Slate arithmetic is deliberately absent from this file.** Story count, points, per-epic
> and per-sprint subtotals, statuses and the dependency graph live in
> `_bmad-output/sprint-artifacts/sprint-status.yaml` and are read from there.

| Epic | Mission |
|---|---|
| Z | Zeropoint macro-host — adapter contract, fork-side step kind, VPS deploy profile, chassis fate, cross-repo exit round |
| M | Memory ladder — dedicated Hindsight, host-side memory cycle, authz gateway, in-box recall, L3/L4 learning cadences |
| A | Autonomy (E21-gated) — department managers as Home bots, QA department, maintenance sweeps, yield KPIs; A6 (GitNexus refresh cron) is the sole pre-E21 member, in v6a |
| J | Judgment tier — JudgmentProvider seam, measured arm-thresholds, model router, host-side pack |
| G | Governance — ADR-2 decision workflow + reconciliation note |

**Sprints:** **v6a "Foundation"** — the stories below tagged v6a; zero E21 gates; ships
standalone. **v6b "Autonomy"** — tagged v6b; every story that needs E21 Home bots; gated rows
are spec-complete, dev blocked until their named gates clear (status in sprint-status.yaml).

---

## Epic Z — Zeropoint macro-host

### Story Z1: Adapter contract v2

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/z1-adapter-contract-v2.md`](../sprint-artifacts/dark-factory-v6/stories/z1-adapter-contract-v2.md)

As the **factory operator**, I want the fork-consumable factory surface pinned as an executable
contract with a fork-rev drift alarm, So that zeropoint and factory can drift apart loudly
instead of silently.

**Sprint:** v6a · deps: none · live tier: none

- Read-only `factory_observe` consumption surface over `fleet status`/`fleet result` — no box, no key
- `SWARMCLAW_FORK_REV` pin + drift alarm (image-pin adoption ritual precedent)
- Q1 contract discipline extended to the observe surface (field-set pins, SCHEMA_VERSION, closed enums)

### Story Z2: BUILD-IN-FORK `factory_observe` step kind + triggers + notify

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/z2-factory-observe-step-kind.md`](../sprint-artifacts/dark-factory-v6/stories/z2-factory-observe-step-kind.md)

As the **zeropoint operator**, I want protocols to observe factory runs and fire on post-merge/schedule
triggers with a notify leg, So that swarmclaw DAGs drive the factory end-to-end.

**Sprint:** v6a · deps: Z1 · live tier: fake-CLI journal

- Fork-side step kind consuming Z1's contract; post-merge + durable-schedule triggers; notify leg
- Every new step-config field carries a `normalizeStep` + round-trip test (config-drop trap class)
- Fake-CLI journal keeps factory CI green without the fork

### Story Z3: Cross-repo live exit round *(gated)*

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/z3-cross-repo-live-exit-round.md`](../sprint-artifacts/dark-factory-v6/stories/z3-cross-repo-live-exit-round.md)

As the **factory operator**, I want one scheduled protocol driving a real fleet run end-to-end —
observe legs, findings→bank→next-run priming, approval park + human decide, exactly-one-box —
So that v6's cross-repo integration is proven on the real substrate like SC2.7 was.

**Sprint:** v6b · **Status: gated** (A2 + Z2 + M2.1) · live round

### Story Z4: Factory VPS deploy profile

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/z4-factory-vps-deploy-profile.md`](../sprint-artifacts/dark-factory-v6/stories/z4-factory-vps-deploy-profile.md)

As the **factory operator**, I want a compose profile for the factory stack (dedicated Hindsight
0.10.0 + M2 gateway + fleet CLI) on the Vultr VPS, So that the memory ladder has a home.

**Sprint:** v6a · deps: ops VPS G1–G7 (external gate) · live tier: infra

- Extends the vultr-deploy/Caddy template; **adds** factory services (inherits none — control-plane compose holds only control-plane + caddy)
- Authored/fired AC split: authored ACs run early; fired ACs gate on the operator's VPS-day GO
- Deployed wrapper owns `--driver exedev`; port 18889 never public

### Story Z5: Chassis fate

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/z5-chassis-fate.md`](../sprint-artifacts/dark-factory-v6/stories/z5-chassis-fate.md)

As a **factory maintainer**, I want the swarmclaw chassis resolved — load-bearing utilities
extracted, the orphan server surface dispositioned — So that `src/swarmclaw/` stops being an
undecided lump in the tree.

**Sprint:** v6a · deps: none · live tier: none

- `log`/`newRequestId`/`maskEnv` → `src/lib/` (pure move, ~50 importers updated)
- Server surface dormant-retained behind a fixture per DD-18, pending ADR-2's outcome

---

## Epic M — Memory ladder

### Story M1.1: Dedicated Hindsight 0.10.0 on VPS

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m1-1-dedicated-hindsight-vps.md`](../sprint-artifacts/dark-factory-v6/stories/m1-1-dedicated-hindsight-vps.md)

As the **factory operator**, I want the factory KG on its own dedicated Hindsight 0.10.0 instance
with `qds-` banks and a round-trip-verified, no-auth-danger-retired posture, So that factory
memory never rides the shared tenant sidecar.

**Sprint:** v6a · deps: Z4 (authored-early) · live tier: infra · carries the P0.5/P0.9 closure evidence legs (transport re-homed per DD-17)

### Story M1.2: Host-side memory cycle

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m1-2-host-side-memory-cycle.md`](../sprint-artifacts/dark-factory-v6/stories/m1-2-host-side-memory-cycle.md)

As the **factory**, I want dispatch-time bounded recall priming run briefs and harvest-time
idempotent retain, host-side only, So that runs start KG-primed and finish writing memory —
with bad KG degrading to v5 behavior, never blocking.

**Sprint:** v6a · deps: M1.1 (mock-first) · live tier: **T2**

- `<kg_context>` brief appendix, proceed-unprimed-on-timeout; pattern copied from zeropoint's grounding extension (skip Clerk/Presidio)
- Idempotent retain = P2.8's mechanism (dated `documentId` + `updateMode:"replace"`)
- Writes the existing (empty) `memory-retain-receipt` audit hop — AUDIT_HOPS untouched

### Story M1.3: Recall measurement harness

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m1-3-recall-measurement-harness.md`](../sprint-artifacts/dark-factory-v6/stories/m1-3-recall-measurement-harness.md)

As the **factory operator**, I want a labeled probe set and hit-rate@k measurement with a
pre-agreed Graphiti-vs-Hindsight bar, So that the KG choice is decided by measurement after
~30 M1 cycles, not by vibes.

**Sprint:** v6a · deps: M1.2 · live tier: none · DD-22 checkpoint (dated, not sprint-bound)

### Story M2.1: Memory gateway

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m2-1-memory-gateway.md`](../sprint-artifacts/dark-factory-v6/stories/m2-1-memory-gateway.md)

As the **factory**, I want an authz gateway issuing per-run recall-only scoped keys and
long-lived bank/verb-scoped agent tokens, So that the verified no-auth danger is fixed by
topology and boxes never hold a write credential.

**Sprint:** v6a · deps: M1.1 (acceptance-only edge — dev-first sanctioned, DD-26) · live tier: unit/mock

- Mirrors `credentials.ts` ordering: mint→deliver→revoke-and-verify-before-destroy (+ compensation)
- D8 amendment implementation (DD-16); never public 8888/18889; Caddy allowlist

### Story M2.2: In-box `kg_recall` pi extension *(M2.1 dep; the re-pin ritual is an operator GO, not a story gate)*

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m2-2-in-box-kg-recall.md`](../sprint-artifacts/dark-factory-v6/stories/m2-2-in-box-kg-recall.md)

As an **in-box run**, I want a read-only `kg_recall` tool backed by the gateway's per-run key,
So that the box can pull sanitized memory without ever holding a write credential.

**Sprint:** v6b · deps: M2.1 · carries the **full image re-pin ritual** (operator-gated)

### Story M2.3: Combined memory live round

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m2-3-combined-memory-live-round.md`](../sprint-artifacts/dark-factory-v6/stories/m2-3-combined-memory-live-round.md)

As the **factory operator**, I want one live round proving primed dispatch + in-box recall +
revoke-verify at teardown with adversarial negative probes, So that the gateway's security
posture is demonstrated, not asserted.

**Sprint:** v6b · deps: M2.2 + M1.2 · live round (T2)

### Story M3.1: Manager meta banks + L3 nightly consolidate *(gated, with crontab fallback)*

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m3-1-manager-meta-banks-l3-consolidate.md`](../sprint-artifacts/dark-factory-v6/stories/m3-1-manager-meta-banks-l3-consolidate.md)

As a **department manager bot**, I want a `*-meta` bank and a nightly consolidate/mental-model
refresh, So that each department's memory compounds — via platform schedule, or the documented
crontab fallback if E21 slips (the gateway is driver-agnostic).

**Sprint:** v6b · deps: M2.1 (hard gate) · A1 gates only the platform-schedule leg — the crontab fallback proceeds without it

### Story M3.2: L4 weekly reflect → PROPOSE

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/m3-2-l4-weekly-reflect-propose.md`](../sprint-artifacts/dark-factory-v6/stories/m3-2-l4-weekly-reflect-propose.md)

As the **factory operator**, I want weekly reflect producing router/skill tuning PROPOSALS to
the meta bank and to me, So that the factory learns — and never auto-applies.

**Sprint:** v6b · deps: M3.1 + A5 · FR-LEARN-30 shape; PROPOSE, never auto-apply

---

## Epic A — Autonomy (E21-gated)

### Story A1: Department managers as E21 Home bots *(gated)*

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/a1-department-managers-home-bots.md`](../sprint-artifacts/dark-factory-v6/stories/a1-department-managers-home-bots.md)

As the **factory operator**, I want the Dev/QA/Maintenance department managers living 24/7 as
bots in one factory Home — heartbeat digests, per-bot spend ceilings — So that the v3/v4
"managers" vision runs deep, not shallow.

**Sprint:** v6b · **Status: gated** (E21 S02b + S03b + Z2) · absorbs fix-loop runner duty; owner=operator-as-user (org-owner policy-refused, DD-25); spend join per DD-20

### Story A2: QA department F3 *(gated)*

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/a2-qa-department-f3.md`](../sprint-artifacts/dark-factory-v6/stories/a2-qa-department-f3.md)

As the **QA department**, I want post-merge hunter-pack protocols running real fleet QA runs
whose findings land in the shared `qds-` bank, So that every QA run primes the next Dev run.

**Sprint:** v6b · **Status: gated** (A1 + M1.2 + Z2) · `w:qa-*` work keys; host-side retain; issue filing

### Story A3: Maintenance sweeps F4 *(gated)*

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/a3-maintenance-sweeps-f4.md`](../sprint-artifacts/dark-factory-v6/stories/a3-maintenance-sweeps-f4.md)

As a **maintenance manager bot**, I want weekly sweeps turning GitNexus/audit-chain hotspots
into dep-bump and refactor briefs that park at the approve gate, So that maintenance is a
cadence, not a crisis.

**Sprint:** v6b · **Status: gated** (A1 + A6 + Z2) · parks at the gate — nothing auto-merges (ADR-2 PROPOSED until the operator decides via G1)

### Story A5: Yield KPIs L5 + Goodhart counter-metrics

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/a5-yield-kpis-goodhart.md`](../sprint-artifacts/dark-factory-v6/stories/a5-yield-kpis-goodhart.md)

As the **factory operator**, I want yield KPIs (TDI-proxy, cost-per-story, first-pass-accept,
retry) computed from `.sandbox` SQLite + both spend ledgers with Goodhart counter-metrics,
So that the factory's yield curve is visible and gaming it is visible too.

**Sprint:** v6b · deps: M1.2 · visualizer render optional

### Story A6: GitNexus 4–6h graph-refresh cron on VPS + staleness alarm

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/a6-gitnexus-refresh-cron.md`](../sprint-artifacts/dark-factory-v6/stories/a6-gitnexus-refresh-cron.md)

As the **factory**, I want the GitNexus graph refreshed on a 4–6h host cron on the VPS with a
staleness alarm that fails past the 8h ceiling,
So that A3's sweeps traverse a near-current graph and CLI drift is caught within one cadence.

**Sprint:** v6a · deps: Z4 · the fired half is v6a flex-cut #2 (rides ops; can slip to v6b without breaking v6a's exit evidence)

---

## Epic J — Judgment tier

### Story J1: `JudgmentProvider` seam

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/j1-judgmentprovider-seam.md`](../sprint-artifacts/dark-factory-v6/stories/j1-judgmentprovider-seam.md)

As the **factory**, I want a typed judgment adapter seam with `jev`/`mock` as the first two
registered adapters and neutral-layer policy, So that future jev-like tier-1 systems swap in
without re-deriving the guardrails.

**Sprint:** v6a · deps: none · live tier: mock + Jev-live probe · D-4; LOCKED #3 superseded-refined (DD-21)

### Story J2: Measured arm-thresholds *(gated on corpus milestones)*

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/j2-measured-arm-thresholds.md`](../sprint-artifacts/dark-factory-v6/stories/j2-measured-arm-thresholds.md)

As the **factory operator**, I want S1-observer routing armed only at calibration milestones
with my explicit sign-off, So that the judgment tier goes live measured, never on ~3 positives.

**Sprint:** v6b · deps: J1 + corpus milestones (DD-21 gate) · recording-only→armed flip is auditable

### Story J3: Model-router decision layer

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/j3-model-router-decision-layer.md`](../sprint-artifacts/dark-factory-v6/stories/j3-model-router-decision-layer.md)

As the **factory**, I want L3 composite scoring (weights in code) picking the model tier per
story-shape at dispatch with a decision log, So that cheap calls go to cheap models and the
choices are reflectable.

**Sprint:** v6b · deps: J1 + M1.2 · second named flex-cut (→ v7)

### Story J4: Host-side judgment pack

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/j4-host-side-judgment-pack.md`](../sprint-artifacts/dark-factory-v6/stories/j4-host-side-judgment-pack.md)

As the **factory**, I want host-side judgment legs — L7 compact-signal via the steering seam,
L8 QA pre-filter, pre-dispatch sanity, L9 repo-sweep triage — So that judgment fires where the
guardrails live, never in the box.

**Sprint:** v6b · deps: J1 · L9 = first named flex-cut; L6 in-box hooks PARKED (DD-21)

---

## Epic G — Governance

### Story G1: ADR-2 decision workflow + reconciliation note

**Story File:** [`sprint-artifacts/dark-factory-v6/stories/g1-adr2-draft-and-reconciliation.md`](../sprint-artifacts/dark-factory-v6/stories/g1-adr2-draft-and-reconciliation.md)

As the **factory operator**, I want the ADR-2 draft (auto-merge default, QA-owned verdicts,
S05b inbox as override surface) presented for decision and the outcome implemented — or the
rejection recorded — So that the autonomy policy is decided, not left in limbo.

**Sprint:** v6a · deps: none · input artifact: `docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md` (PROPOSED); Tier taxonomy defined there (DD-19)
