# A5: Yield KPIs L5 + Goodhart Counter-Metrics — the Yield Curve, With Its Cheating Visible

**Story Points:** 3
**Sprint:** v6b — Autonomy (A-epic; E21-independent, lane-2 — runs on v6a artifacts + local stores only)
**Status:** ready-for-dev — pre-dev campaign (qds-story-review) runs before any dev lane starts

> **Decisions of record (NET-NEW — flag for the DD-14+ register):**
> **(1) Gateway-spend import artifact.** DD-20 joins BOTH spend ledgers (zeropoint LLM-gateway for Home-bot
> turns + factory cost-ledger for fleet runs). Mechanically the join crosses repos, and the cross-repo
> contract (charter §5.4) forbids zeropoint code in the factory import graph — so A5 consumes a
> **strict-schema JSONL export** at `.sandbox/imports/gateway-spend-<window>.jsonl`; the *producer* is
> zeropoint-side work filed in the solstice repo per §5.5's counterpart-stories rule (BUILD-IN-FORK) —
> and that counterpart is **scheduled nowhere** in this slate (verified 2026-10-08 by grep, Re-visit
> below). Therefore gateway rows are **absent-not-0 BY DEFAULT** until the producer lands — the same
> pattern as escaped-defect (3): the DD-20 join degrades to factory-ledger-only, flagged
> `spend_incomplete`, with factory-known DD-20 join keys (runId + botId) lacking an import row COUNTED
> as `missing_gateway_rows` — the count itself `absent` when the import file is wholly absent, since
> there is nothing to count against. No AC or acceptance may require gateway-side numbers to be
> present; the absent path is a named, tested behavior, never an error, and never a blocker for A5's
> DOD.
> **(2) TDI is a proxy, named as one.** The v4 TDI series was pi-lens-derived; the factory has no pi-lens.
> A5 computes **TDI-proxy** = defect signals per accepted story (reverify vetoes + fix-loop charged
> attempts + A2 QA findings once A2 lands) — the renaming is load-bearing, not cosmetic. The v4
> counter-metric for the TDI pair — **pi-lens warning count** (FR-LEARN-33 verbatim) — dies with the
> same absence, so the pair substitutes **unattributed-signal count** (defect signals with no outcome
> linkage); this substitution is a STATED deviation from the verbatim v4 pair, same provenance as the
> KPI rename. Same deviation class, smaller: v4's **retry-count** is computed as a **rate**
> (workKeys with >1 attempt / workKeys attempted) so windows of different size stay comparable.
> **(3) Escaped-defect is absent-not-0 until A2 lands.** FR-LEARN-33 marks the pair "Phase-2 QA
> dependent"; A5 has no dep edge on A2 (charter) — the counter-metric reports `absent` with its named
> source, never `0`.

## Spec Reference

- Charter `2026-10-01-v6-derivation-session-INPUT.md` — §3 v6b A5 row (snapshot persistence; "visualizer render optional AC"); DD-20 (§4 item 7: both ledgers, join keys workKey `w:` + runId + botId); DD-15 (P2.4 fold: protocol/DAG-node events → Z2 observe artifacts + **A5 KPI join**); §2.1 state stores.
- `_bmad-output/planning-artifacts/prd-qds-factory-v4.md` — FR-LEARN-33 (:423, verbatim in R1: the four KPI-counter pairs, "No KPI panel renders without its pair"); directions (:865: TDI ↓, cost/story ↓, first-pass-accept ↑, retry-count ↓); enforcement NFR-OBS-6(b) (:735: "4/4 yield KPIs show a paired counter-metric"); L5 loop row (:576).
- DD-9 micro-USD doctrine — money is integer micro-dollars everywhere (`src/providers/cost-ledger.ts:7-11`); per-issue spend is always `SUM(cost_micro_usd)`; read-only open never creates the ledger (`:1351`).
- Sibling contracts consumed unmodified: **M1.2**'s harvest-time idempotent-retain path (P2.8 fold) for the `{baseId}-dev-meta` snapshot retain; **Z2**'s observe artifacts (ADR-1 `external_job` artifact tree — the K-join carrier, optional dimension); **J1** none (A5 touches no Jev surface); **J3**'s `.sandbox/routing-log.jsonl` (read-side dimension, no dep edge — the log schema is J3-owned and A5 tolerates its absence).
- R3 facts: `CostLedger` (`src/providers/cost-ledger.ts:1117`), `DEFAULT_COST_LEDGER_FILE = ".sandbox/cost-ledger.db"` (:579), `walkAuditChain`/`chainVerdict` (`src/audit/chain.ts:726`/`:560`), run records (`src/providers/run-record.ts`, 0600 O_EXCL + atomic rename), `DISPATCH_FAILURE_LOG = ".sandbox/dispatch-log.jsonl"` (`src/fleet/dispatch.ts:103`), script precedents `scripts/qds-cost.ts` / `scripts/qds-audit.ts`.

## User Story

As the operator deciding whether the factory is actually getting cheaper per usable story,
I want the four v4 yield KPIs computed from the stores that already exist — every one rendered beside the counter-metric that exposes gaming it —
so that M3.2's weekly reflect reads measured curves instead of vibes, and no KPI can look good by lying about its denominator.

## Overview

`scripts/qds-kpi.ts` (precedent: `scripts/qds-cost.ts` — operator-invoked, read-only, exiting, no daemon) computes four KPIs over an operator-named window from `.sandbox/` stores + the gateway-spend import: **TDI-proxy** (defect signals per accepted story: reverify vetoes + fix-loop charged attempts + A2 QA findings when present), **cost-per-story** (factory ledger µ$ + joined gateway bot-turn spend, per accepted story), **first-pass-accept** (terminal runs accepted with no fix-loop charged attempt, over terminal runs), **retry-rate** (workKeys with >1 dispatch attempt, over workKeys attempted) — each paired with its FR-LEARN-33 counter-metric (unattributed-signal count; cost-per-accepted-PR; escaped-defect rate; unclassified-restart rate). One append-only snapshot JSON per invocation persists the full pair set; the snapshot summary retains idempotently into `{baseId}-dev-meta` (M3.1's `*-meta` family) via M1.2's path. The gateway-spend import follows the same absence law as the dimensions: **absent by default** until the counterpart producer lands (decision (1)), never `0`, never an error. Dimensions (J3 routing decisions, A2 QA outcomes, Z2 observe artifacts) join read-side when their sources exist and are **absent, not `0`**, when they do not.

**What this does not deliver, stated before an AC implies otherwise:** no dashboard (the visualizer render is an OPTIONAL AC — the snapshot + schema are the gate), no new audit hop, no writes to any ledger or run record (strictly read-only over stores), no daemon or schedule shipped (the documented cron line is the operator's, DF3.8 idiom), no A2/J3/Z2 dep edges, and no KPI gates anything — the yield curve informs M3.2's PROPOSE and the operator; it never gates code entry.

## E2E Slice

**Demonstrable behavior:** Given a fixture-seeded `.sandbox` (runs/, cost-ledger.db, audit.db, dispatch-log.jsonl, a gateway-spend import file), When `bun scripts/qds-kpi.ts --window 7d` runs, Then it exits 0 and writes `.sandbox/kpi-snapshots/<UTC-timestamp>.json` (0600, atomic rename) carrying all four KPIs **each with its paired counter-metric**, the spend join provenance (rows from each ledger, join keys used, `unmatched_gateway_rows` count), and per-KPI source-store + direction; a second invocation over the same window appends a second snapshot (never mutates the first) and retains one idempotent `{baseId}-dev-meta` document `kpi-snapshot-<windowId>-<payload-hash>`.

**Wiring closed:** On completion of this story, `bun scripts/qds-kpi.ts` produces the complete paired-KPI snapshot from stores that already exist plus the import artifact — using only code merged by this story plus M1.2's retain path. **No stub, no `TODO: wire later`.** The visualizer render is optional by charter text and is not the wiring-closed claim; the zeropoint-side *producer* of the import file is a counterpart story in the solstice repo, not factory code.

**Dependency edges (predecessors):** M1.2 — direct: the idempotent-retain helper and dated-`documentId` discipline (the only in-table edge; charter's dep row confirmed by R5 §1.2).

> **Not an edge — A2 / J3 / Z2:** all three are read-side dimensions consumed when their artifacts exist. A5 compiles and computes green before any of them lands: no import file → spend marked `spend_incomplete`; no routing log → dimension absent; no QA findings → escaped-defect absent. Absence tolerance is an AC, not a graceful-degradation afterthought.

## Acceptance Criteria

1. **(make-or-break — pairing is structural, at write time)** Given any snapshot write, When the snapshot is assembled, Then every KPI object carries its paired counter-metric object and the strict schema refuses the snapshot otherwise — the FR-LEARN-33 pairs are: TDI-proxy ↔ unattributed-signal count; cost-per-story ↔ cost-per-accepted-PR; first-pass-accept ↔ escaped-defect rate; retry-rate ↔ unclassified-restart rate (4/4, NFR-OBS-6(b)). *Negative controls, all three MUST fail:* an implementation rendering or persisting a KPI without its counter-metric pair (the exact NFR-OBS-6 failure); one that zero-fills a counter-metric whose source is absent (an unimplemented escaped-defect rate MUST be `absent` with its named source — `0` asserts a measured-clean window that was never measured); and one whose pair exists in the render but not in the persisted snapshot (the render lying about the store).
2. **The spend join is both ledgers or it is marked incomplete, and money never leaves the ledger.** Given a window, When cost-per-story is computed, Then factory spend comes from `SUM(cost_micro_usd)` over `.sandbox/cost-ledger.db` (read-only open, never created) and bot-turn spend comes from the gateway-spend import joined on DD-20's keys exactly (runId where present, else the issueId↔workKey correspondence the import row carries, plus botId) — with every unmatched gateway row counted in `unmatched_gateway_rows`, never silently dropped, and a missing import file producing `spend_incomplete: true` with the bot component `absent`, a partial import (factory-known DD-20 join keys with no row — decision (1)'s default until the producer lands) producing the same flag with `missing_gateway_rows` counted. *Negative controls, all four MUST fail:* an implementation presenting a factory-only total as a **complete** cost-per-story — factory-ledger-only is the sanctioned degraded default (decision (1)) only while flagged `spend_incomplete` with `missing_gateway_rows` accounted; the unflagged variant (the join silently missing one ledger) MUST fail; one deriving spend from token counts × price — DD-9 micro-USD doctrine: spend is read from ledger micro-USD rows, never recomputed from usage; one joining on timestamp proximity or any key DD-20 does not name; and one admitting a gateway import row whose money field is a float or outside the safe-integer range — the strict schema pins that field as `cost_micro_usd`, integer, safe-integer-guarded (`cost-convert-invalid` precedent, `src/providers/cost-ledger.ts:309-313`), and such a row MUST fail the strict parse.
3. **The four KPIs come from named stores, with enforced directions.** Given a window, Then each KPI names its source stores in the snapshot — TDI-proxy and first-pass-accept from run records' DF6.1a fix fields (`fixAttemptRunIds`/`fixContext`/`fixOutcome`/`fixOutcomeClass`, `src/providers/run-record.ts:218-234` — "fix-loop records" is not a store; charged-ness derives from each attempt's `fixOutcomeClass` under the EscalationClass taxonomy, `src/fixloop/escalation.ts:45-92`) (+ audit walk `walkAuditChain` for gate-evidence linkage), retry-rate from `.sandbox/dispatch-log.jsonl` failure entries + run records, cost from AC2's join — and the schema carries the literal v4 direction per KPI (`tdi_proxy: "down"`, `cost_per_story: "down"`, `first_pass_accept: "up"`, `retry_rate: "down"`), refusing any other value. *Negative control: an implementation whose snapshot flips a direction to make a bad month look good — a "corrected" direction MUST fail the strict schema.*
4. **Dimensions join read-side, and absence is typed.** Given J3's `.sandbox/routing-log.jsonl`, A2's QA findings, and Z2's observe artifacts in various states of existence, When the snapshot is written, Then each dimension that exists joins by its owned key (routing decisions by runId; QA findings by workKey/issueId; observe artifacts via the ADR-1 `external_job` artifact tree per the P2.4 fold) and each that does not records `{source, status: "absent"}` — a dimension column is never `0`, never omitted, and never a build or run failure. *Negative control: an implementation requiring any dimension source to exist at import time — A5 must compile and compute green before A2, J3, or the fork-side observe artifacts land — MUST fail.*
5. **Snapshots are append-only, 0600, and retain idempotently; the render is optional.** Given repeated invocations, Then each writes a fresh `.sandbox/kpi-snapshots/<UTC-timestamp>.json` via the run-record idiom (O_EXCL create, temp+rename, 0600, 0700 dir posture) and retains the summary to `{baseId}-dev-meta` (M3.1's `*-meta` family) with `documentId = "kpi-snapshot-" + <windowId> + "-" + short(sha256(payload))` — where **`windowId` is the UTC day-truncated window-bounds slug** and the retained payload is a **pure function of the window's data**: no `snapshot_path`, no wall-clock timestamp, no invocation-order field. Two invocations over unchanged window data produce byte-identical payloads → idempotent replace; window data that changes under the same bounds changes the payload hash → a **new** documentId, never M1.2's divergent-tamper alarm (same documentId + mutated content is exactly that alarm, and the hash fold makes that state unreachable by construction). `updateMode: "replace"` (P2.8 fold). *Negative controls, both MUST fail: an implementation deriving `windowId` from the bare `--window` label (`"7d"`) reuses one documentId across windows of changed data; and a same-window re-invoke over mutated window data yielding the SAME documentId — content drift must land a new doc, never trip the tamper alarm.* The optional visualizer render — IF exercised — consumes only the persisted snapshot file, never re-derives from stores. *Negative controls, both MUST fail: an implementation mutating or rewriting a prior snapshot (the curve must be auditable against what was believed at the time), and a render that recomputes rather than reads the snapshot — the render would then be able to disagree with the persisted record.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/qds-kpi.ts --window <w>` (operator-invoked, read-only) | in-scope | `tests/kpi/yield.test.ts` | — |
| gateway-spend import artifact consumption (strict schema, join, unmatched count) | in-scope | `tests/kpi/yield.test.ts` | producer = solstice-repo counterpart, unscheduled (see producer row below, §5.5) |
| gateway-spend **producer** (zeropoint-side export writer of `.sandbox/imports/gateway-spend-<window>.jsonl`) | out-of-scope — **unscheduled follow-up**; named home = solstice repo per §5.5 counterpart-stories rule; NOT scheduled in this slate (factory rows degrade absent-not-0 until it lands, decision (1)) | — | solstice repo (§5.5) |
| snapshot persistence + idempotent meta retain | in-scope | `tests/kpi/yield.test.ts` (M1.2 retain seam) | — |
| dimension joins: routing log / QA findings / observe artifacts | in-scope | `tests/kpi/yield.test.ts` (absence arms included) | — |
| visualizer render of the yield curve | optional — charter marks it optional; the snapshot + schema are the gate; may ship or slip without moving DOD | — | v7 if skipped |
| M3.2 weekly reflect consuming snapshots | out-of-scope — M3.2's story; the snapshot schema here is its read contract | — | M3.2 |
| scheduled invocation (cron line) | out-of-scope — documented in `--help`, operator-owned, never shipped as a process (DF3.8 idiom) | — | none |
| writes to cost-ledger / run records / audit chain | out-of-scope — strictly read-only over stores; the ledger read-only open never creates | — | none |
| new audit-chain hop for KPI provenance | out-of-scope — `AUDIT_HOPS` frozen (DF5.3); provenance rides the snapshot file | — | none |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| factory cost ledger | `.sandbox/cost-ledger.db` (`src/providers/cost-ledger.ts`) | ledger suite green (`bun test tests/providers/` cost-ledger tests); absent-ledger arm tested — read-only open never creates (R3 :1351) |
| run records + dispatch log | `.sandbox/runs/` + `.sandbox/dispatch-log.jsonl` | run-record store suite green; absent dispatch-log tolerated as `absent`, not `0` |
| audit chain walk | `.sandbox/audit.db` (`src/audit/chain.ts`, read-only walker) | audit suite green **byte-identical after** — a diff touching `link-store.ts` is the AC-violation signal |
| idempotent-retain helper | M1.2 (`{baseId}-dev-meta`, P2.8 fold) | M1.2's retain tests green; consumed, never re-implemented |

> Not a prerequisite: any box, any live round, any Jev key, any E21 lane, any zeropoint service. A5 is
> fully offline (R5 §4.3 places it outside the live-round list); the gateway import file is data, not a
> service dependency.

## Technical Notes

- **Every KPI's gaming vector is named, because that is what the pair is for.** TDI-proxy can be inflated by logging noise → counter: unattributed-signal count (signals with no outcome linkage — the stated substitute for v4's pi-lens warning count, decision (2)). Cost-per-story can be gamed by rejecting expensive work → counter: cost-per-accepted-PR (the accepted denominator priced honestly). First-pass-accept can be gamed by lowering the accept bar → counter: escaped-defect rate (A2-sourced, absent until it lands). Retry-rate can be gamed by relabeling restarts → counter: unclassified-restart rate (restarts whose cause is not in the dispatch/fixloop taxonomy). A counter-metric that merely restates its KPI's numerator is the failure AC1 exists to prevent.
- **The window is the denominator contract.** Every KPI is computed over the same operator-named window; the snapshot carries the window bounds and each KPI's denominator count, so a ratio is never read without its n. A KPI whose denominator count is 0 is `absent` (no terminal runs yet), not 0% — the same absent-not-0 rule as every missing source.
- **Guards/limits, named rather than implied:** snapshot files cap at the full pair set + provenance (no truncation path — the schema is closed); the import file's schema is strict (unknown fields refuse, the Q1 missing-and-extra-fail discipline applied to data); unmatched and missing gateway rows are bounded by the window and always surfaced in count, never sampled.
- **Region ownership on shared files:** this story modifies NO existing source module — `scripts/qds-kpi.ts` is new, `src/kpi/` is new, and every store is consumed through its existing read API. `src/audit/link-store.ts` and the provider layer are untouched (read-only consumer of `walkAuditChain` only). **No image pin is owed:** nothing under the box COPY set changes (R3 §5 — `src/kpi/` is not engine-reachable), so `deriveBuildId` stays put.
- **Considered and rejected: computing KPIs at harvest time (per-run) instead of a separate script.** Harvest owns run completion, not measurement cadence; folding computation there couples the curve to every harvest failure and re-derives history on each run. A read-only window computation over append-only stores is re-runnable, cheap, and honest about being a view. Revisit only if M3.2's reflect needs per-decision KPI granularity the snapshots cannot carry — measured, not hypothesized.
- **The ADR-1 accepted-gap residue is surfaced, not absorbed.** Headless `workId` briefs not booking spend is open upstream (ADR-1 Consequences, R2 §1.3); until it closes, gateway rows keyed only by `w:` may not join a factory issue. A5's answer is the counted `unmatched_gateway_rows` — the gap stays visible in every snapshot until the zeropoint side closes it.

## Observability Contract

- Per invocation: one `{ requestId, event: "kpi-snapshot-written", window, snapshot_path, spend_incomplete, unmatched_gateway_rows, missing_gateway_rows, dimensions_present: [...], kpis: 4, pairs: 4, duration_ms }` line; per-KPI computation failures are typed `{ code, message, remediation }` and mark THAT KPI `absent` with its source named — a failed TDI-proxy never zeroes the snapshot.
- Sub-timings (`duration_ms`, per-source read timings) are **absent, not `0`**, when a source was absent — same rule as every skipped ask.
- No credential material is read or logged; the import file may carry bot identities (botId) and is treated as data at rest under `.sandbox/` posture (0600 family), never echoed to stdout beyond counts.

## Files to Modify

- `src/kpi/kpis.ts` (new — the four KPI + counter-metric computations, denominator contracts, strict snapshot schema with enforced directions)
- `src/kpi/join.ts` (new — DD-20 both-ledger join, gateway import schema + unmatched/missing-row accounting, dimension joins with typed absence)
- `scripts/qds-kpi.ts` (new — operator CLI, `--window`, `--help` cron-line documentation, `qds-cost.ts` idiom)
- `src/hindsight/client.ts` (M1.2-owned — **not modified**: the idempotent-retain path consumed as-is)
- `tests/kpi/yield.test.ts` (new — pairing refusal, join completeness, doctrine, directions, absence arms, append-only posture, idempotent retain, seeded-fixture demo)

## Security Invariants

- **INV-A5-1 (read-only over truth):** every store is opened read-only; the cost-ledger read-only open never creates; run records, ledgers, and the audit chain are byte-identical after every invocation. What this does not fence, said plainly: the snapshot files and the import directory are THIS story's writes, under `.sandbox/` 0600 posture — the invariant bounds the truth stores, not the story's own artifacts.
- **INV-A5-2 (DD-9 micro-USD doctrine):** money is integer micro-dollars end-to-end from ledger row to persisted snapshot; no float arithmetic on money anywhere; the only USD rendering (optional visualizer) is derived at render time from integer µ$ and labeled.
- **INV-A5-3 (frozen stores untouched):** `AUDIT_HOPS`, gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope`, provider layer import rules — byte-identical; KPI provenance rides the snapshot file, never the audit chain.
- **INV-A5-4 (cross-repo coupling stays at the artifact):** zeropoint code never enters the factory import graph (charter §5.4); the gateway ledger is reached only through the strict-schema import file — never a direct DB connection, never a network read.
- **INV-A5-5 (no daemon, no gate):** the script exits on every path; scheduling is the operator's documented cron line; no KPI gates code entry — fleet stays the only code-entry path (charter §6).

## Definition of Done

- [ ] **Impl:** `src/kpi/kpis.ts` + `src/kpi/join.ts` — four KPIs, four FR-LEARN-33 pairs, named stores and denominators per KPI, strict closed schema (AC1–AC3).
- [ ] **Contract:** `.sandbox/kpi-snapshots/` append-only 0600 snapshots via the run-record idiom; the gateway import schema (strict, missing-and-extra-fields-fail; money field `cost_micro_usd`, integer, safe-integer-guarded per the `cost-convert-invalid` precedent) documented in `src/kpi/join.ts`'s docblock as the DD-20 artifact contract (AC2, AC5).
- [ ] **Integration:** `scripts/qds-kpi.ts` runs green against a fixture-seeded `.sandbox`; the M1.2 retain lands one idempotent `kpi-snapshot-<windowId>-<payload-hash>` document (AC5).
- [ ] **Test (pairing):** a snapshot assembled with any unpaired KPI, any zero-filled absent counter-metric, or any render-vs-store pair divergence MUST fail (AC1).
- [ ] **Test (doctrine + join):** an unflagged factory-only total presented as complete cost-per-story MUST fail; token×price spend MUST fail; timestamp-proximity join MUST fail; a float-money import row MUST fail the strict parse; `spend_incomplete` + `unmatched_gateway_rows` + `missing_gateway_rows` arms pass on a missing/partial import — the sanctioned degraded default, not an error (AC2).
- [ ] **Test (absence):** with routing log, QA findings, observe artifacts, dispatch log, and import file each absent in turn, the snapshot computes green with typed `{source, status: "absent"}` columns and zero-denominator KPIs `absent` (AC4).
- [ ] **Test (fix charged-ness):** fixture seeds one charged and one uncharged fix attempt (per-attempt `fixOutcomeClass`, `src/providers/run-record.ts:218-234`); only the charged one counts toward TDI-proxy and first-pass-accept (AC3).
- [ ] **Test (append-only):** a second invocation never mutates the first snapshot; snapshots are 0600 with 0700 dir posture (AC5).
- [ ] **Security:** zero-diff on `link-store.ts`, gate-runner, `classifyRunExit`, `classifyDiffScope`; no float money path; no zeropoint import in the graph; the script exits on every path (INV-A5-1..5).
- [ ] **Test (e2e demo — MANDATORY):** one seeded-fixture end-to-end run in BOTH import arms: seed stores → run `scripts/qds-kpi.ts --window 7d` → verify the snapshot carries 4/4 paired KPIs with directions, typed absences for every not-yet-landed dimension, and the retained meta document; with a fixture import file seeded, spend provenance from BOTH ledgers; with the imports directory EMPTY (decision (1)'s default), `spend_incomplete: true` and the degraded factory-only curve green — this arm is what proves the absent-path is acceptance-satisfiable. **Explicitly non-live:** no box, no spend — A5 sits outside R5 §4.3's live-round list, and a seeded fixture is legitimate evidence because every behavior under test is host-side and offline.

## Re-visit (2026-10-08)

**Checked: the gateway-spend producer is scheduled nowhere.** `grep -rn "gateway-spend" _bmad-output/ docs/ | grep -v a5-yield` returns **zero hits** — no sprint story, epic row, or follow-up list carries the solstice-side export writer. The counterpart named in decision (1) exists only as this story's own mention of it; the import artifact had an unscheduled producer.

**Decision recorded (amends decision (1)):** gateway rows are **absent-not-0 BY DEFAULT** until the counterpart lands — the escaped-defect pattern applied to the spend side. The DD-20 join degrades to factory-ledger-only, flagged `spend_incomplete`, with factory-known DD-20 join keys (runId + botId) lacking an import row COUNTED as `missing_gateway_rows`; the count itself is `absent` when the import file is wholly absent (nothing to count against). No AC or acceptance requires gateway-side numbers; the absent path is a named, tested behavior (`tests/kpi/yield.test.ts` absence arms), never an error. A5's DOD is satisfiable with a wholly empty imports directory.

**Trigger Surface** gains the counterpart as an out-of-scope follow-up with its named home (solstice repo, §5.5 counterpart-stories rule) — deliberately NOT scheduled in this slate.

## Dev Agent Record

*(written at implementation time, not at spec time.)*
