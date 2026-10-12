# M3.2: L4 Weekly Reflect → PROPOSE Router/Skill Tuning — Proposals Only, Operator-Applied or Nothing

**Story Points:** 3
**Sprint:** v6b — Autonomy (memory-ladder arc, after M3.1 — the second half of the L3/L4 learning cadence; DD-23(b)'s Layer-B safe subset, part 2)
**Status:** done — merged PR #424 to dev 2026-10-12 (f15f7ee1; head 88ed5e8d). Deps M3.1 + A5 satisfied. No E21 code enters the factory import graph on either leg. Two CodeRabbit review rounds: r1 — week-scoped evidence gather (`isoWeekStartUtc` inverse of `isoWeekOf`; window binds before recency caps; fault/absence semantics unchanged), crontab stderr split to `last-events.log`, exit-contract doc truth; r2 — exit-0 clause corrected to the `ok` formula, nonexistent-week labels (2027-W53) rejected at the helper + refused exit-2 at the driver gate; whole-file routing-log read accepted with documented ceiling. tests/learning 116/0; tsc + biome clean.

## Spec Reference

- Charter `2026-10-01-v6-derivation-session-INPUT.md` §3 v6b M3.2 row (verbatim): "L4 weekly reflect → PROPOSE router/skill tuning (FR-LEARN-30 shape: proposals to meta bank + posted to operator; NEVER auto-apply)".
- FR-LEARN-30 verbatim — `_bmad-output/planning-artifacts/prd-qds-factory-v4.md:420`: the weekly routine reads outcome records and the `{repo}-*-meta` banks, produces a human-readable rationale summary via `reflect`, and **"proposes (does NOT auto-apply) a `qds-model-router` config change … The operator reviews and applies the change manually; nothing is promoted to production automatically."** Reinforced (:603, :605): "there is no auto-promotion of any config in v4; the weekly proposal (FR-LEARN-30) is operator-applied." L4 row (:575): router decisions scored by cost/quality → tune which model tier won; evolve skills.
- **DD-23(b):** Layer-B self-optimization safe subset = J3 + M3.2 only; everything else PARKED. This story is the subset's second half — it proposes; it never expands its own authority.
- **Jev LOCKED set holds verbatim (D-5):** LOCKED #9 **no severity calibration** — severity stays with the frontier session; LOCKED #5 recording-only until measured. **DD-21:** J2's arm-thresholds unlock requires calibration milestones + explicit operator sign-off — a proposal satisfies neither.
- Consumed contracts: M3.1's `*-meta` bank family + both trigger legs (`nightly-consolidate.ts` job-module precedent, `scripts/memory-nightly.ts` crontab idiom, INV-MEM-1..4); M1.2's idempotent-retain path (stable dated `documentId`, `updateMode: "replace"` — P2.8 fold); J3's `.sandbox/routing-log.jsonl` (J3-owned read contract, read-never-write, **absent-tolerant per J3's own flex-cut residue**); A5's `.sandbox/kpi-snapshots/` (A5-owned closed schema, read-only, typed absence).
- R3 facts: `HindsightClient.reflect(bankId, query?)` (`src/hindsight/client.ts:207`, 30 s timeout), `retain` (:166, metadata `kind`/`tags`). J3-owned log line shape (per J3's own spec — the read contract's owner, not R3): `{ workKey|issueId, runId, shape, risk_tier, applied_tier, score: {<feature>: value…}, jev_recommendation, jev_requestId, jev_skipped?, created_at }`.

## User Story

As the factory operator,
I want a weekly host-side reflect over the routing-decision log, the yield-curve snapshots, and the run records to land concrete tuning proposals in the manager meta banks and post them to me,
so that router/skill tuning happens on measured evidence and nothing — weights, thresholds, skills — changes without my explicit action.

## Overview

A weekly job (M3.1's machinery, both legs) gathers its inputs read-only — J3's routing decisions, A5's KPI snapshots, `.sandbox/runs/` — reflects per manager `*-meta` bank, and composes **tuning proposals** (`router-tuning | threshold-suggestion | skill-update`), each citing its evidence. Proposals land three places and nowhere else: the append-only proposals store, an idempotent retain into the target meta bank, and the operator-facing carrier of whichever leg fired (manager-bot chat on the schedule leg; stdout on the crontab leg). The inbox relays *to* the gate; it never *is* the gate — channel ≠ policy. The applied route for every proposal is an operator-authored change in a later change — this story's module graph contains no writer of routing, threshold, skill, or gate state.

**What this does NOT deliver, stated before an AC implies otherwise:** no auto-apply and no config mutation (FR-LEARN-30 is the ceiling); no severity calibration (Jev LOCKED #9); no skill-file edits (proposals suggest, the operator applies); no J2 gate bypass (a proposal is not sign-off); no writes to the routing log, KPI snapshots, or run records; no in-box anything (sketch-M3 stays PARKED); no new audit hop; no dashboard; no S05b-inbox carrier (future — the invariant is operator-posting, the inbox may carry proposals once it exists, it is not owed here).

## E2E Slice

**Demonstrable behavior:** Given a fixture-seeded `.sandbox` (routing-log lines, one KPI snapshot, run records), When `bun scripts/memory-weekly.ts --week <iso-week>` runs, Then it exits 0 having written one proposal record per finding under `.sandbox/proposals/` (0600, closed schema; O_EXCL on the temp file + atomic rename — a byte-identical retry's replace is a rename-over the existing `documentId` record, never an in-place rewrite), retained each to its target `*-meta` bank with `documentId = "l4-proposal-<week>-<firedAt>-<seq>"` — firing identity carried in the id, so a same-week re-fire mints NEW documentIds instead of rewriting old ones (M1.2's replace is byte-identical-only; a rewritten same-week id would trip its divergent-tamper alarm by design), and printed the full proposal text to stdout, redirected by the documented crontab line into the operator-visible `.sandbox/proposals/last-post.log` (the crontab leg's carrier); a re-fire over the same week never stacks, and its receipt lists the week's full authoritative `documentId` set **and names the superseded ids from earlier firings** so a shrunken re-fire's superseded records stay detectable, never silently authoritative. On the schedule leg (gateway fake + agent token), the same job runs and the firing turn's reply carries the posted proposal summary.

**Wiring closed:** On completion of this story, the weekly reflect runs end-to-end — gather → reflect → compose → retain → post — using only code merged by this story plus M3.1's machinery and M1.2's retain path. **No stub, no `TODO: wire later`.**

**Dependency edges (predecessors):** M3.1 — *direct* (the bank family, the trigger legs, the gateway verb posture). A5 — *direct* (the snapshot schema this job reads; charter dep row, R5 §1.2).

> **Not an edge — J3:** the routing log is a standalone artifact; the charter's M3.2 row carries no J3 dep — that is exactly why the log exists (J3's own words). If the J3→v7 flex-cut fires, this job reflects on A5 KPIs + run records alone, tolerantly. **Not an edge — A1:** gates the platform-schedule leg only; the fallback leg inherits nothing. **Not an edge — M2.2:** `kg_recall` is a box-facing recall surface; this job is host-side only.

## Acceptance Criteria

1. **(make-or-break — PROPOSE is the ceiling)** Given any weekly firing, When proposals are produced, Then the job's only writes are (a) `.sandbox/proposals/` records and (b) idempotent retains into `*-meta` banks — and no code path in this story's module graph mutates J3's weight constants, any routing/threshold/skill/gate state, or any consumed store. *Negative controls, both MUST fail:* **an auto-applied tuning proposal** — any path where a proposed change takes effect on routing, thresholds, skills, or config as part of the weekly job (FR-LEARN-30 verbatim: the operator "reviews and applies the change manually"); and **a proposal path bypassing the operator** — any route to effect that does not require an operator-authored change, including a proposal-status machine that honors statuses this story itself wrote.
2. **The operator is the only application path, and threshold suggestions name their adjudicator.** Given the module graph, Then a test asserts no import reaches any writer of routing/threshold/gate state, and every `threshold-suggestion` proposal carries `advisory: true` plus the named adjudicating owner (the operator; arm-threshold changes additionally name J2's DD-21 milestone gate as unsatisfied by this proposal). *Negative control: an implementation whose suggestion is indistinguishable from a directive — advisory omitted, or a proposal asserted to satisfy J2's sign-off — MUST fail this one.*
3. **Posted to the operator is an invariant; bank-only retention is not posting.** Given each firing leg, When a proposal lands, Then it reaches the operator through the firing leg's carrier — schedule leg: the manager bot's turn reply carries the host-composed proposal summary into chat; crontab leg: the full proposal text on stdout, captured by the documented crontab line's `>> .sandbox/proposals/last-post.log` redirect — and the posted carrier plus the store plus the bank are all present in the receipts. *Negative control: **a proposal retained to the meta bank but never surfaced through the firing leg's carrier MUST fail this one** — the bank is the durable copy, not the channel.*
4. **Inputs are read-only, cited, and absence-typed.** Given the routing log, KPI snapshots, and run records in any state of existence, When the job runs, Then every proposal cites its evidence (`routing_log_refs`, `kpi_snapshot_refs`, `run_record_refs`), every consumed store is byte-identical after, and each absent source records `{source, status: "absent"}` while the reflect still composes proposals from what exists. *Negative controls, both MUST fail: an implementation requiring any input to exist at fire time (it must compile and produce green with the routing log deleted — the J3 flex-cut residue, per J3's own spec), and one that writes, rewrites, or re-derives a consumed store.*
5. **Severity calibration stays LOCKED out.** Given the proposal schema, Then it carries no severity field to set, no calibration surface, and no code path that derives or adjusts severity weights (Jev LOCKED #9 verbatim: "Severity stays with the frontier session"); `router-tuning` proposals concern model-tier selection only. *Negative control: **severity calibration sneaking in** — a schema field, tag, or proposal kind that adjusts severity scoring/calibration, or a reflect query asking the instance to weight severity, MUST fail this one.*
6. **Weekly cadence rides M3.1's legs exactly.** Given both trigger legs, When the job fires, Then the platform-schedule leg wakes through M3.1's machinery (agent token scoped per M3.1) and the documented crontab line (`scripts/memory-weekly.ts`) runs the same job module through the same gateway with zero E21 symbols in the fallback module graph. *Negative control: a crontab leg importing any Home-bot/fork/E21 symbol, or addressing raw 8888/18889 instead of the gateway, MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| crontab fallback → job → gateway → reflect + proposal + retain + stdout | in-scope | `tests/learning/weekly-reflect.test.ts` | — |
| platform schedule → manager bot wake → same job (agent token) | in-scope (seam-fake until A1's fork-side delivery lands) | same suite | — |
| proposal kinds: `router-tuning` / `threshold-suggestion` / `skill-update` | in-scope | same suite | — |
| absent-input arms (routing log, snapshots, run records each absent in turn) | in-scope | same suite | — |
| S05b inbox as an additional proposal carrier | out-of-scope — may carry proposals once it exists; operator-posting is the invariant and is satisfied here without it | — | v7 carrier extension |
| auto-apply / config mutation from a proposal | out-of-scope — never; FR-LEARN-30 is the ceiling | — | none |
| severity calibration | out-of-scope — Jev LOCKED #9; a re-adjudication needs a new D-number (DD-21 discipline) | — | none |
| writes to routing log / KPI snapshots / run records | out-of-scope — J3/A5/run-record owned; this job reads only | — | none |
| new audit hop for proposal provenance | out-of-scope — `AUDIT_HOPS` frozen (DF5.3); provenance rides the proposal record | — | none |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| meta banks + trigger machinery | M3.1 (`nightly-consolidate.ts`, `scripts/memory-nightly.ts`) | `bun test tests/hindsight/` green before this story starts |
| gateway verbs + agent tokens | M2.1 (verb machinery; this story consumes `reflect` + `retain` scopes on the host-held agent-token class, adds-only) | M2.1 gateway suite green |
| KPI snapshot schema | A5 (`.sandbox/kpi-snapshots/`, closed schema) | `bun test tests/kpi/` green |
| Hindsight client | M1.1/M1.2-owned (`reflect`, idempotent retain) | consumed as-is — **byte-identical after** |

> No exedev box, no fleet run, no Jev key, and no E21 lane are prerequisites. The charter's live-round
> list excludes M3.2 (R5 §4.3); the mandatory demo is a seeded fixture. An optional infra-tier leg may
> ride M3.1's instance (the reflect call invokes the instance's configured LLM — real, if small, spend)
> but is not owed by this story.

## Technical Notes

- **The bot is the trigger and the carrier, never the composer.** Proposals are composed host-side from host-held inputs; the schedule leg's bot relays the host-composed summary (A1's digest duty). The weekly job holds a **host-held** agent token scoped exactly `{reflect, retain}` on the target `*-meta` bank(s), and the retain verb never enters a bot-held token — the bot-held agent-token class keeps M3.1's INV-MEM-1 vocabulary `{consolidate}` (DD-28.26 item 1; endpoint-mode `{consolidate, refresh}` only via a register amendment), and the adds-only scope grant lands on the host-held class only (no content-write credential in any Home).
- **Idempotency is borrowed, not built:** `documentId = "l4-proposal-<week>-<firedAt>-<seq>"` + `updateMode: "replace"` (M1.2's P2.8 fold). `replace` guards the byte-identical retry within a firing; the `<firedAt>` identity makes a same-week re-fire mint new documentIds — never a rewrite of an old id, which M1.2's byte-identical-only replace would alarm on by design — and the receipt names superseded ids. No lock, no cursor.
- **Guards/limits (named):** `WEEKLY_WALL_CLOCK_BUDGET_MS` bounds the job above the client's 30 s REFLECT timeout; `PROPOSAL_RATIONALE_CHAR_CEILING = 4_000` (DF1.11's attach-message ceiling — a proposal is read in a chat turn); receipts respect the 8 KiB detail discipline.
- **Region ownership on shared files:** every factory file this story touches is NEW; `src/hindsight/client.ts` is M1.1/M3.1-owned and **not modified** (`reflect` + retain metadata `kind: "observation"`, tags carry the proposal identity); M2.1's gateway verb registry takes **adds-only** `reflect`/`retain` scopes on the host-held agent-token class. No re-pin is owed — nothing under the box COPY set changes (R3 §5).
- **Considered and rejected: a proposal status machine (PROPOSED→ACCEPTED→APPLIED).** Statuses written and honored by the same system that wrote the proposal is auto-apply's little sibling — the operator's adjudication lives in their own change, not in a state this story tracks. Revisit only if the operator asks for proposal bookkeeping, measured by ask, not hypothesized.

## Observability Contract

- Events: `weekly-fire` (`{requestId, leg: crontab | schedule, week}`), `reflect-run` (`{bankId, reflect_ms}`), `proposal-composed` (`{proposal_id, kind, target_bank, evidence_refs}`), `proposal-posted` (`{proposal_id, carrier: chat | stdout}`), `weekly-complete` (`{proposals, banks_ok, absent_sources, total_ms}`). Errors carry `{code, message, remediation}`.
- `reflect_ms` is **absent, not `0`** when a bank was skipped; a live leg prints worst-case spend before firing and carries it in the evidence JSON. Token names/scopes only, never values.

## Files to Modify

- `src/learning/proposal-schema.ts` (new — closed proposal + receipt schemas; kinds, evidence refs, `advisory` marking, absence typing)
- `src/learning/weekly-reflect.ts` (new — the job: gather read-only → reflect per bank → compose → retain + post; the single orchestrator both legs call)
- `scripts/memory-weekly.ts` (new — bounded CLI with the documented crontab line (`>> .sandbox/proposals/last-post.log`); the fallback driver; imports no E21 symbol)
- `tests/learning/weekly-reflect.test.ts` (new — both legs, all five negative controls, absence arms, idempotent re-fire, seeded-fixture demo)
- `src/hindsight/client.ts` (M1.1/M3.1-owned — **not modified**: reflect + retain consumed as-is)
- `.sandbox/routing-log.jsonl` (J3-owned — **not modified**, read-never-write)
- `.sandbox/kpi-snapshots/` (A5-owned — **not modified**, read-only)

## Security Invariants

- **INV-LEARN-1 (the PROPOSE ceiling — FR-LEARN-30 verbatim):** this story's module graph contains no writer of routing, threshold, skill, or gate state; the only route from proposal to effect is an operator-authored change. What this does not fence, plainly: the operator's own later change, which is outside this story by construction.
- **INV-LEARN-2 (read-only over truth):** consumed stores byte-identical after every firing; absent sources typed, never zeroed.
- **INV-LEARN-3 (no severity calibration — Jev LOCKED #9):** no severity surface in schema, query, or kind; re-adjudication requires a new D-number.
- **INV-LEARN-4 (gateway-only + token hygiene, inherited from M3.1):** both legs address the gateway origin, never 8888/18889; agent tokens bank/verb-scoped, provisioning-delivered, never logged; the weekly job's credential is the host-held agent-token class scoped exactly `{reflect, retain}`, and the retain verb never enters a bot-held token (that class's vocabulary stays M3.1's `{consolidate}` per DD-28.26 item 1 — a test asserts the class split).
- **INV-LEARN-5 (frozen surfaces untouched):** no new audit hop; gate, gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope` — byte-identical.

## Definition of Done

- [ ] **Impl:** `weekly-reflect.ts` + `proposal-schema.ts` — gather → reflect → compose → retain + post, closed schema, kinds + evidence refs + advisory marking (AC1, AC2).
- [ ] **Impl:** `memory-weekly.ts` fallback CLI with the documented crontab line; zero E21 symbols asserted by test, not comment (AC6).
- [ ] **Contract:** `.sandbox/proposals/` append-only 0600 (temp O_EXCL + atomic rename; byte-identical retry = rename-over; a re-fire mints new `<firedAt>` documentIds and the receipt names the week's authoritative set plus the superseded ids); `documentId` carries firing identity + replace within a firing; consumed stores byte-identical (AC4).
- [ ] **Test (never-apply):** an auto-applied tuning proposal MUST fail; a bypass-of-operator path MUST fail; no writer import in the module graph (AC1).
- [ ] **Test (posting):** bank-only retention with no firing-leg carrier MUST fail; both carriers demonstrated (AC3).
- [ ] **Test (severity):** a severity-calibration field, tag, or query MUST fail the schema (AC5).
- [ ] **Test (absence):** each input absent in turn → typed `{source, status: "absent"}`, proposals still compose green (AC4, J3 cut residue).
- [ ] **Security:** INV-LEARN-1..5 verified — no writer import, no severity surface, gateway-only, frozen surfaces zero-diff.
- [ ] **Test (e2e demo — MANDATORY):** seeded-fixture end-to-end — seed routing log + KPI snapshot + run records → `bun scripts/memory-weekly.ts` → proposals in store + bank retains + stdout text; schedule leg at the gateway fake with agent token. **Explicitly non-live:** no box, no spend — every behavior under test is host-side and offline.

## Dev Agent Record

**Implemented 2026-10-11** on `feature/m3-2-l4-weekly-reflect-propose` (from dev @ 87cb235b), orchestrated 4-leaf build (.unlazy/m3-2/).

**Files (all new):** `src/learning/proposal-schema.ts` (156L), `src/learning/gather.ts` (233L), `src/learning/compose.ts` (308L+fixes), `src/learning/weekly-reflect.ts` (496L), `src/learning/index.ts` (49L), `scripts/memory-weekly.ts` (388L+fixes), `tests/learning/{proposal-schema,gather,compose,weekly-reflect}.test.ts` (77 tests). **Unmodified (consumed as-is):** `src/hindsight/client.ts`, `src/memgate/*`, all frozen surfaces (zero-diff vs dev, gate-proven).

**Key decisions:** (1) retain path = `verifyRequest`→`forwardScoped` (nightly :349 idiom) — the client-at-gateway-origin primary is impossible (MemgateDeps is in-process, no origin). (2) Fresh-empty bank ⇒ REFLECT_UNPARSEABLE/banks_failed (honest red; M1.2+M3.1 guarantee content flow before weekly ever fires). (3) Retry byte-identity is LLM-determinism-dependent BY DESIGN — drift trips PROPOSAL_DIVERGENT (alarm, not silent). (4) File-list amendment (PLAN C14): per-leaf suite files + gather/compose split for the 500-line pin; disclosed in PR.

**Verification:** tests/learning 77/0; tsc clean; biome clean; full-suite gate = zero failures outside the documented slow-host timeout class (baseline-proven: clean dev worktree fails 17/38 cap-hit on this host); INV-LEARN-1..5 test-proven (writer-import fence over transitive closure incl. src/gate, class-split grant proof, closure-wide port scan, absence arms, byte-identical consumed stores). Mandatory seeded-fixture spawned e2e green (non-live, loopback shim). Review: driver self-review round 0 — 9 findings (1 MED exit-2 envelope silent, 8 LOW), all dispositioned/patched (`_bmad-output/reviews/m3-2/round-0-selfreview.md`); bmad-code-review rounds follow.
