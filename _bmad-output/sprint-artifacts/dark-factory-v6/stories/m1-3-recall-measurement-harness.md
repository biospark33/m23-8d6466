# M1.3: Recall measurement harness — labeled probes, hit-rate@k, priming-usefulness, interim report

**Story Points:** 3
**Sprint:** v6a (Foundation — memory ladder, story 7 of 11; the measurement leg whose decision checkpoint is deliberately DATED past the sprint)
**Status:** done — PR #413 merged to dev 2026-10-07 (merge 939aed0f, head 6bf51483). First real-instance baseline committed (hit-rate@5 0.565 over 23 probes); the DD-22 re-measure is operator-ruled (M1.4 rides it).

> **Provenance:** charter row M1.3 (`2026-10-01-v6-derivation-session-INPUT.md:79`) + DD agenda item 9 (DD-22: "define hit-rate@k target + labeled probe set NOW; decision checkpoint after ~30 M1 cycles"). Risk §7.3 (recall quality post-re-pin) demands the probe set exist BEFORE the deep dependency matures. v6a's FIRST named flex-cut lives here (R5 F4, register decision): the report leg slips to v6b if v6a strains — the probe set, harness, and instrumentation do not.

## Spec Reference

- **Charter** `2026-10-01-v6-derivation-session-INPUT.md` — row M1.3 (:79); §7.3; DD agenda item 9 (DD-22). The concrete threshold below is writer-proposed (DD-22) and register-amendable at the operator's milestone review — DD-22 is the register entry this story implements, not the other way round; the values are DD-22's working bar pending a DD-21-style operator pin.
- **M1.2 contract consumed unmodified:** side-channel `_bmad-output/memory/recall/<runId>.json`, `memory-retain-receipt`/`retain` rows (audit.db), `client.recall(bankId, query, limit = 5)` (default k = 5), retain `documentId = <runId>`. Expected-id matching keys on the typed `documentId` — the wire-to-client mapping is of record in M1.2's Term mapping: 0.10.0 recall results carry DISTINCT `id` and `document_id` on the WIRE (Hindsight 0.10.0 OpenAPI `RecallResult`), and M1.2's additive recall schema (their AC5) exposes the wire's `document_id` as the null-tolerant typed `documentId` field on `client.recall()` results — this harness consumes `documentId` (the typed name) for expected-document matching and never the wire name; `memoryId` stays distinct and the recall response keeps M1.2's strict parse — this story relaxes nothing. `expectedDocumentIds` are therefore document ids (the retain-time `documentId` values), NOT `memoryId`s — recall-result ids are server-minted fact ids, distinct from document identity, and M1.2's echo leg asserts no identity between the two (its AC7 keys the echo on the wire's `document_id`), so the harness keys on `documentId` unconditionally. `documentId = <runId>` rides M1.2's [VERIFY] flag (DD-28.26(3)): if the echo leg fails on 0.10.0, the fallback retain-identity ledger is runId-keyed, so the `<runId>` label contract holds in either mode. **Mode note:** in the echo-failure fallback the server assigns ids, so recall `documentId`s cannot match `expectedDocumentIds` — the documentId-keyed harness cannot score against the live instance in that mode; the run records the mode as harness-blocking (a ledger-backed matching arm is the named follow-up, not this story's scope).
- **Stores consumed READ-ONLY:** run records `.sandbox/runs/`, cost-ledger `.sandbox/cost-ledger.db` (read-only open never creates — `src/providers/cost-ledger.ts`), dispatch-log `.sandbox/dispatch-log.jsonl`.
- **Seed content source:** P0.9 provision-and-import leg (Mulch → `qds-factory-dev-meta`) — content that exists BEFORE the deep dependency matures (risk §7.3 ordering). Seed-label provenance reads the PERSISTED P0.9 evidence-leg JSONs (`_bmad-output/evidence/p0-9-closure/`, written by M1.1's leg driver) — no separate import manifest exists; those JSONs are the mint record for seeded Mulch documents. Reader contract (M1.1-owned producer): the provision-and-import leg JSON records per-bank retained document ids — each Mulch entry retained with a deterministic `document_id` (a retain item without one gets a server-assigned random UUID per the 0.10.0 docs, unrecoverable later; retain-response ids are the fallback) — and AC1(ii) validates seeded probes' `expectedDocumentIds` against exactly that per-bank roster.
- **Honesty pattern:** JEV-4 (`scripts/judgment/ab-report.ts`) wording discipline — renders data, judges nothing; observational joins labeled as correlation, never causation.

## User Story

As the operator deciding at the DD-22 checkpoint whether Hindsight stays the factory KG, I want a labeled probe set and per-cycle priming telemetry instrumented now, so that the decision after ~30 M1 cycles is a measurement, not a vibe.

## Overview

Three offline instruments over M1.2's artifacts plus one report: (1) a schema'd, labeled probe set — `{probeId, query, expectedDocumentIds[], bank}` — seeded from pre-dependency content and grown append-only by real cycles; (2) `probe-recall.ts` — recalls each probe, validates label integrity BEFORE scoring, computes hit-rate@k (k = 5); (3) `priming-report.ts` — joins side-channel + run records + cost ledger + dispatch log into primed-vs-unprimed coverage/cost/outcome tables plus a cycles-to-date counter carrying the DD-22 checkpoint flag at ≥ 30 cycles. **The Graphiti-vs-Hindsight decision is implemented by NOTHING** — the report flags `checkpointEligible`; the swap decision is operator-only and no code path swaps backends.

**What this does NOT deliver:** the decision itself (operator, at the dated checkpoint), any swap machinery (never), in-box citation capture (M2.2+), dashboard rendering (A5's surface), scheduled/cron report runs (ad-hoc invocations; the checkpoint is dated, not cron'd).

## E2E Slice

**Demonstrable behavior:** `bun scripts/memory/probe-recall.ts` exits 0 and writes `_bmad-output/evidence/memory/<ts>-hit-rate.json` — `{perProbe: [{probeId, hit, rank}], aggregate: {probes, hits, hitRateAt5, medianRecallMs}, labelIntegrity: "pass", canary: {bank, documentId, hit}}`; a failing label-integrity check (including a canary miss) exits non-zero with the offending probeIds and writes no scoring artifact — the `<ts>-hit-rate.json` evidence JSON stays WITHHELD; a canary miss additionally records its outcome (bank, `documentId`, query, recall tail) in a separate failure diagnostic, `_bmad-output/evidence/memory/<ts>-canary-failure.json` — the path AC1 names too, so both descriptions agree: the hit-rate artifact is withheld, the diagnostic is not. `bun scripts/memory/priming-report.ts` writes `_bmad-output/memory/reports/<date>-interim.{json,md}` — `{cyclesToDate, primedCount, unprimedCount, costTable, outcomeTable, checkpointEligible}`.

**Wiring closed:** On completion of this story, probe scoring and the report run end-to-end using only this story's scripts plus M1.2's already-merged contracts, against an injected deterministic recall surface in CI (the `HindsightClient` mock is stateless — `recall` returns `{results: []}`, `listBanks` returns `{}` — so it cannot produce hits or pass an integrity gate; see Technical Notes) and against whatever `HINDSIGHT_BASE_URL` points at when invoked for real. **No stub, no `TODO: wire later`.** Scheduling, swap logic, and dashboards are out of scope by construction.

**Dependency edges (predecessors):** M1.2 is the **only direct edge** (side channel + retain receipts + client recall surface). *Not an edge — A5:* the KPI story reads the same stores independently; *not an edge — J2:* the calibration corpus is a different corpus with a different schema.

## Acceptance Criteria

1. **(make-or-break) Labeled probe set with enforced label integrity — including bank provenance.** Given the committed probe set (≥ 20 schema-valid probes, each with ≥ 1 `expectedDocumentId`), When `probe-recall.ts` starts, Then it runs the integrity gate BEFORE scoring: (i) each probe's `bank` exists (`listBanks` against the configured instance), and (ii) every `expectedDocumentId` appears in the factory's own mint records **for THAT probe's bank** — the bank provenance carried by the mint records themselves: M1.2 `memory-retain-receipt` rows (for run outcomes — each row's digest-stable `detail` records the retain bank id beside the `documentId`, M1.2 AC6's detail field; the gate compares each receipt's bank field against the probe's `bank`) and the persisted P0.9 provision-and-import leg JSON (`_bmad-output/evidence/p0-9-closure/`, M1.1's driver output, per-bank retained document ids for seeded Mulch documents — the reader contract in Spec Reference); an id minted into a DIFFERENT bank than the probe's `bank` field is a mismatched bank/ID pair — the same phantom class as an id minted nowhere — and both refuse to score: exit non-zero, name the offending probeIds; and (iii) the **self-hit canary** passes: before any scoring, the harness retains ONE canary document — deterministic `documentId = qds-canary` + `updateMode:"replace"`, so the canary replaces itself and never accumulates — via M1.2's retain surface into the seeded probe bank (`qds-factory-dev-meta`), then recalls a canary query that must surface it; the canary must HIT on `documentId` (the injected CI fake serves it deterministically). A canary miss means the id substrate or the matching key is structurally broken — the silent-`0.0` failure class that would falsely OPEN the DD-22 Graphiti evaluation — and the WHOLE run refuses to score: exit non-zero, the hit-rate artifact withheld, canary outcome recorded in the separate failure diagnostic `_bmad-output/evidence/memory/<ts>-canary-failure.json` (the E2E Slice's artifact contract — the `<ts>-hit-rate.json` evidence JSON itself is never written on a failed gate); never a legitimate-looking `hitRateAt5: 0.0` aggregate. The canary gates, it does not score (excluded from the aggregate). Without the bank match, a doc minted to bank A could satisfy a probe pointing at bank B and inflate hit-rate with a cross-bank lie. `labelIntegrity: "pass"` means provenance-verified, NOT upstream-verified — upstream-side deletion of a minted document is not fenced in v6.0, a deliberate trade-off: membership-by-id enumeration exists upstream but the gate keys on the provision-time mint record — the mint record is the factory's own provenance, immune to upstream deletions after the fact (and existence-by-recall-result would conflate recall quality with label validity — exactly the confound this AC forbids). *Negative controls, all MUST fail: probes whose expected ids are absent from the mint records silently scoring 0 — deflating hit-rate for a data reason, not a recall-quality reason — MUST fail validation, not the score; and a probe whose expected id was minted into a different bank scoring against the wrong bank's recall results.*
2. **hit-rate@k computed and persisted.** A probe HITS only when one of ITS `expectedDocumentIds` appears in the top-k recall results' `documentId` values (k = 5, the client's default limit; matching keys on `documentId` per the Spec Reference contract — never on `memoryId`: recall-result ids are server-minted fact ids, distinct from document identity); per-probe rank + aggregate `hitRateAt5` land in the evidence JSON, machine-checkable, no hand-copied numbers. *Negative control: an implementation counting "recall returned k documents" as a hit — matching nothing expected — MUST fail this AC.*
3. **Priming-usefulness join, honestly labeled.** Per runId, the report joins `{primed (side channel), exit classification (run record), costMicroUsd (ledger SUM, exact integer µ$), retried (priorAttempt presence)}` and renders primed-vs-unprimed tables. All store reads are read-only. Cross-group deltas are labeled `correlation (observational)` — no causal wording anywhere in the report; cost figures are exact from the ledger and are never relabeled or estimated. *Negative controls: a single synthetic/fabricated run row in the report MUST fail; a "priming caused X" phrasing MUST fail; any report path that writes to the ledger or audit.db MUST fail.*
4. **DD-22 checkpoint encoding.** `cyclesToDate` counts M1 cycles as side-channel rows deduped on runId, side-channel-LEFT-JOIN-receipt — receipt presence is recorded as a per-row data-quality field, never a filter (a receipt-less cycle still counts); the report sets `checkpointEligible: true` only at ≥ 30. No code path evaluates, recommends-executes, or swaps the KG backend. *Negative control: any auto-swap or auto-migration code (Hindsight → Graphiti or back) MUST fail — the decision is the operator's at the dated checkpoint, which continues into v6b and is NOT sprint-bound.*
5. **Flex-cut separability.** The metrics JSON is the atomic deliverable; the `.md` renders purely from it. Deleting the md render leaves ACs 1–4 intact. *Negative control: an implementation computing any metric inside the md renderer (making the JSON incomplete without it) MUST fail this AC.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| ad-hoc `probe-recall.ts` / `priming-report.ts` invocation | in-scope | AC1–AC5 | — |
| probe set growth per cycle (append-only, labels validated) | in-scope | AC1 integrity gate | — |
| ≥ 30 cycles reached | in-scope — `checkpointEligible` flag only | AC4 | operator decision at DD-22 checkpoint (v6b/late v6a) |
| hit-rate below the DD-22 bar | out-of-scope — decision input, not code | — | DD-22 checkpoint |
| Graphiti evaluation / swap | out-of-scope — operator decision, no machinery | — | DD-22 checkpoint |
| scheduled/cron report runs | out-of-scope — checkpoint is DATED, not cron'd | — | none in v6.0 |
| in-box citation capture (did the agent USE the priming) | out-of-scope — M2.2+ | — | M2.2+ |
| dashboard/KPI rendering | out-of-scope — A5 | — | A5 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| M1.2 side channel + receipts | files + `.sandbox/audit.db` | `bun test tests/hindsight/run-retain.test.ts` green before start; fixture side-channel rows in CI |
| Deterministic recall surface (CI) | injected structural-typed fake; `src/hindsight/` untouched | `bun test tests/hindsight/client.test.ts` green before start; M1.3 modifies no M1.2 file |
| `.sandbox` stores | read-only consumers | ledger read-only open never creates the file (proven by test); audit opened read-only |

> Not prerequisites: the VPS instance or M1.1's banks (the story's acceptance is mock-tier machinery + committed seed data; real-baseline numbers accrue wherever `HINDSIGHT_BASE_URL` points as cycles accumulate), M2.1, A5, E21, and no live fleet round (charter Live tier: none — no box, no fleet spend).

## Technical Notes

- **The DD-22 bar (writer-proposed; register-amendable at the operator's milestone review, pending a DD-21-style operator pin):** Hindsight STANDS if hit-rate@5 ≥ 0.7 AND median probe recall < `SLOW_QUERY_THRESHOLD_MS` (5_000, the existing `round-trip-verifier.ts` constant); below either bar, the Graphiti successor evaluation OPENS at the checkpoint. Neither number executes anything — they are the decision inputs DD-22 commits to now so the later conversation cannot move the goalposts.
- **Probe sizing:** 20-seed floor from Mulch-imported content + first-cycle retains; grow ~2 probes/cycle append-only (≈ 80 at the checkpoint). Probes live in `_bmad-output/` with the corpus precedent. Seed probes (`-dev-meta`) and M1.2's dispatch fan-out are deliberately disjoint: the evidence JSON aggregate carries a per-bank breakdown, and seeded `-dev-meta` probes are reported separately from any repo-bank probes.
- **Guards/limits (all named):** `MAX_PROBE_QUERY_CHARS = 1_000`; concurrent probe runs serialize via `acquireRunLock` on the probes dir (the `corpus-writer` precedent, `CORPUS_LOCK_ID` analog `probe-writer`) so evidence files never interleave; `MIN_PROBE_SET_SIZE = 20` enforced before aggregate `hitRateAt5` is emitted (below it, the report says so instead of printing a number over a too-small sample).
- **Injectable recall surface:** both scripts take their recall/banks client as a structural-typed parameter defaulting to `HindsightClient` — the `ProvisionClient` precedent (`src/hindsight/bank-provisioner.ts:43-50`: plain-object mock in tests, real client structurally compatible). Tests and CI inject a deterministic fake with fixture banks + canned recall results; `src/hindsight/client.ts` stays untouched (M1.2-owned, and its stateless mock cannot produce hits or bank listings).
- **Probe-set growth mechanism:** the `priming-report.ts` invocation appends candidate probes — recent cycle outcome-document ids plus new P0.9 import ids — through the SAME `probe-schema.ts` integrity gate before any append; `probe-set.json` is append-only (existing rows immutable, labels never rewritten). A candidate failing the gate appends nothing.
- **Ordering against M1.2:** strictly downstream — reads only artifacts M1.2 already writes; if M1.2's receipt leg fell out (its Deviation 1 declined), `cyclesToDate` counts side-channel rows alone and the story still stands.
- **Considered and rejected:** computing usefulness inside M1.2 — that couples the producer to its own evaluation; the side-channel contract is the seam, and M1.3 stays a pure consumer (fixes are one-sided).

## Observability Contract

- One machine-checkable evidence JSON per probe-recall run in `_bmad-output/evidence/memory/` (openrig-sc2 naming discipline); exit non-zero on label-integrity failure, artifact withheld.
- Report prints `cyclesToDate` and `checkpointEligible` on every invocation; a section with no data is absent, not 0 (e.g. `costTable` absent before the first retained cycle).
- No new log vocabulary — the scripts reuse `swarmclaw/log` with the M1.2 `kg-recall`/`memory-retain` lines where applicable.

## Files to Modify

- `scripts/memory/probe-schema.ts` — new: zod probe schema + label-integrity check
- `_bmad-output/memory/probes/probe-set.json` — new data: ≥ 20 seed probes from Mulch-imported content (schema'd, committed)
- `scripts/memory/probe-recall.ts` — new: recall runner → per-probe/aggregate hit-rate@5 + evidence JSON
- `scripts/memory/priming-report.ts` — new: join → interim report `{json,md}` + cycles counter + checkpoint flag
- `tests/memory/probe-harness.test.ts` — new: mock-client determinism, hit-rate math, label-integrity refusal, join fixtures, read-only posture
- `_bmad-output/memory/reports/` — new output dir: interim report artifacts (the deliverable)

## Security Invariants

- **INV-PH-1 (no secrets in probes):** probe queries/labels derive only from `qds-` bank content — code and run artifacts; no credentials, tokens, or box-internal paths.
- **INV-PH-2 (read-only posture):** run records, cost ledger, audit.db are opened read-only; no story code writes any `.sandbox` store. What this does not fence: probe-recall DOES hit the configured Hindsight (reads only, with exactly ONE sanctioned exception — AC1(iii)'s self-hit canary retain, one idempotent document into the seeded probe bank; no reflect/consolidate calls from this story).
- **INV-PH-3 (no backend mutation):** no code path creates, deletes, or swaps KG banks or backends — the DD-22 decision surface is a flag, nothing more (the canary retain targets an existing provisioned bank; no bank create/delete/swap).
- **Not fenced:** evidence directory growth (timestamped files accumulate; cleanup rides the existing evidence hygiene, no retention policy invented here).

## Definition of Done

- [ ] **Impl:** probe schema + label-integrity gate incl. the self-hit canary; probe-recall with hit-rate@5 + evidence JSON; priming-report join + `cyclesToDate` + `checkpointEligible`.
- [ ] **Contract:** report md renders solely from the metrics JSON (AC5 proven by deleting/relocating the renderer in test).
- [ ] **Data:** ≥ 20 seeded probes committed and integrity-passing against fixture banks.
- [ ] **Security:** read-only posture asserted by test (ledger absent-file stays absent; audit.db mtime unchanged after a report run).
- [ ] **Test (unit):** `bun test tests/memory/probe-harness.test.ts` green — injected deterministic recall surface, no network.
- [ ] **Test (regression):** `bun test tests/hindsight/ tests/fleet/` green and untouched — this story modifies no M1.2 file.
- [ ] **Integration:** one end-to-end invocation against fixture side-channel + receipt + ledger rows produces both artifacts with `checkpointEligible` correctly false below 30 cycles.
- [ ] **Flex-cut:** register note recorded — report `.md` leg is v6a's first named cut (slips to v6b on trigger; JSON metrics never cut).
- [ ] **Test (e2e demo — MANDATORY):** `probe-recall.ts` + `priming-report.ts` run end-to-end against the injected deterministic recall surface producing both artifacts in `_bmad-output/evidence/memory/` + `_bmad-output/memory/reports/`; no live tier, no spend (charter Live tier: none).

## Dev Agent Record

**Branch:** `feature/m1-3-recall-measurement-harness` (base/target `dev`); orchestrated build under `.unlazy/m1-3/` (research wave + 3 implementation leaves + branch node; PLAN.md contract inventory, revisions 1-5).

**Prerequisite (operator-ruled, commit `9bb63e3c`):** the story's named seed source was empty — the P0.9 provision-and-import leg had never minted a document (every retain 422'd: array under `metadata.tags`, the 0.10.0 `Dict[str,str]` metadata contract that `src/hindsight/client.ts:264-265` documents and works around on the wire; `scripts/p0-9/hindsight-live.ts:333` measured it live 2026-10-04), and no M1 cycle had ever run, so receipts were absent too. The corpus also held only 8 expertise entries against the ≥20 seed floor. Operator ruled: fix the import leg first, grow the corpus to 20+. `scripts/p0-9/provision-and-import.ts` now sends item-level `tags` (the measured-good shape), `.mulch/expertise/qds-platform.yaml` adds 15 real entries (23 total, unique concept sets), and the leg was re-run against a local pinned `hindsight:0.10.0` instance (same index digest the VPS ran, loopback 18890, capped OpenRouter key minted for the boot-required LLM extraction and revoked after — $0.74 total spend across two attempts, leak-checked to zero live keys). The passing leg JSON (`2026-10-07T12-01-42-955Z-p0-9-provision-and-import-kvdvho.json`) minted 23 documents per bank with zero failures and is the seed mint record AC1(ii) consumes. The failed $0.05-cap attempt evidence is committed alongside (honest history: 402 after 5 docs, compensated clean).

**Spec-vs-reality drift (recorded, binding):** AC3 names `exit classification (run record)` and `retried (priorAttempt presence)`; neither field exists in `.sandbox/runs/` records — exit classification lives in the retain payload retained INTO the KG (`src/hindsight/run-retain.ts:37,167-175`), and no priorAttempt marker exists anywhere in run records or extensions. D1/D2: the report omits both columns and carries dataNotes naming where classification lives (never fabricated, never zero-filled — the observability contract's "absent, not 0"). The dispatch log is consumed as a read-only failure count (`dispatchFailures`), present only when the log exists.

**Contract amendments (all in `.unlazy/m1-3/PLAN.md`, none silent):** R3 — `p09EvidenceDir` is an explicit dep on both runners (real layout separates `_bmad-output/evidence/memory/` artifacts from the `evidence/p0-9-closure/` mint record; the original single-dir binding would phantom-refuse every real CLI run); `DEFAULT_P09_EVIDENCE_DIR` exported. R4 — leaf-1.3+1.4 merged into leaf-1.34 (the single test file's static imports make parallel runner builds require cross-lease stubs). R5 — strict AC1 refusal at run time: leaf-t's hit-rate-math fixture originally under-minted a probe id and expected a scored miss; ruled that AC1's negative control governs ("absent from the mint records … MUST fail validation, not the score"), fixture amended to mint all labels, runner refuses on all violations with no classification.

**Test/verification evidence:** `tests/memory/probe-harness.test.ts` 60/60 (probe-schema 17, probe-recall 16, priming-report 24, harness-e2e 3; 43 red at authoring, recounted after each review round — 55 after round 2, 59 after the round-3 re-pins, 60 after round 4) — written TDD-red first (43 red proven against missing modules), then made green; `bunx tsc --noEmit` 0 errors; repo-wide `bun run lint` exit 0; leaf ledgers under `.unlazy/m1-3/gates/` all ALL MET with automatic evidence; driver e2e verifier (`scripts/dev/verify-m13-e2e.ts`) runs both runners end-to-end against real CostLedger/audit-store fixtures — integrity pass, both artifacts, `checkpointEligible` false at 5 cycles, absent-ledger-stays-absent, audit.db mtime unchanged. Seed probes verified against the real mint record: 23/23 ids present for `qds-factory-dev-meta` (computed roster == minted record, bidirectionally).

**Live-tier note for the operator:** the real-instance baseline ALREADY EXISTS — the canary + probe run against the local `m13-hindsight` instance (the same instance the prerequisite rerun used) produced the committed first baseline `_bmad-output/evidence/memory/2026-10-07T15-52-32-492Z-hit-rate.json` (hit-rate@5 0.565 over 23 probes, canary hit, median 106ms; see the provenance README beside it). The instance is now down (no `m13-hindsight` containers or volumes remain — the `docker compose -p m13-hindsight down -v` teardown already happened, and the throwaway OpenRouter key was revoked at provisioning close-out). Any future canary + probe run (~$0.01 for the canary retain; recalls are RRF, no LLM) is a REPEAT measurement against a fresh instance — it grows the DD-22 series, it is not the first baseline — and remains optional: not required by this story's DoD (mock-tier machinery + committed seeds).

**Operator ruling (2026-10-07, M2.1 kickoff):** the first baseline's hit-rate@5 (0.565) misses the DD-22 bar (≥ 0.7); median (106 ms) passes. Per DD-22's design the numbers are decision inputs, not triggers — the ruling is to let the series accrue and RE-RUN the canary + probe measurement on a fresh pinned instance once cycle count is materially higher (target: before the ~30-cycle DD-22 checkpoint, at operator discretion as cycles accrue — the corpus is unchanged hours after the baseline, so an immediate re-measure is a no-op), then take the Graphiti-successor decision at the checkpoint WITH the repeat data point in hand. This line is the durable record of that ruling; recurring host reminders cannot span the weeks to the checkpoint (cron expiry), so future sessions should surface it from this note when `checkpointEligible` flips or cycle count passes ~15.

**Spec-letter note (R2):** side-channel `recalledDocumentIds` are dev-meta documents actually recalled during priming, so growth banks them dev-meta — the spec's "outcome-document ids" letter describes repo-bank outcome docs; the report md's id-anchor caveat on the cycle split (cycle-grown probes are id-anchored: the query embeds the document id) is the honest framing of that banking choice.

### Review Findings (round 1, 2026-10-07 — full campaign: 25 patch / 2 dismissed / 1 deferred)

- [x] [Review][Patch] Scoring-loop recall error escapes unclassified [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] listBanks rejection crashes instead of label-integrity refusal [scripts/memory/probe-schema.ts]
- [x] [Review][Patch] Empty probe set scores a 0.0 artifact; hitRateAt5 not withheld below MIN_PROBE_SET_SIZE (spec letter) [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] Unreadable cost ledger kills the report (needs dataNote omission) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Under-lock probe-set read unguarded [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Growth probeId slug collision bricks the set with duplicate probeIds [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Growth lock failure fatal to whole report (degrade to dataNote) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Audit-db readonly opens crash on TOCTOU/non-sqlite (return absent-data) [scripts/memory/probe-schema.ts]
- [x] [Review][Patch] costTable/outcomeTable zero-filled at zero cycles (absent, not 0) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] dispatchFailures unreachable from CLI; unreadable log reads as 0 [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Redact revoked OpenRouter key-management URLs from committed P0.9 evidence (45x) [_bmad-output/evidence/p0-9-closure]
- [x] [Review][Patch] Growth probes: origin field (seed|cycle), per-source-bank candidates, byOrigin aggregate [scripts/memory/priming-report.ts]
- [x] [Review][Patch] verify-m13-e2e hermeticity (auditPath into tmpdir) + tmpdir cleanup on fail [scripts/dev/verify-m13-e2e.ts]
- [x] [Review][Patch] Remove stale all-zero-recallMs artifact; recallMs sub-ms floor [_bmad-output/evidence/memory]
- [x] [Review][Patch] writtenAt Date.parse ordering with tie fallback [scripts/memory/probe-schema.ts]
- [x] [Review][Patch] latencyMs shape-check finite/non-negative [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Skip empty-concepts entries with recorded failure in p0-9 import [scripts/p0-9/provision-and-import.ts]
- [x] [Review][Patch] Artifact stamp collision: run-unique rand per repo naming discipline [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] Guard canary diagnostic write (refusal contract under write failure) [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] Per-cycle rows (runId, primed, receiptPresent) — AC4 per-row letter [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Growth uses the SAME integrity path: extract shared mint-membership core [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Serialize concurrent probe-recall runs under the named lock [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] Dev Agent Record suite count 43 -> 44 (16/11/14/3) [story record]
- [x] [Review][Patch] verify-test-slice parsing/bounds fixes; verifier vacuous check; header wording; test name overstatement; record DD-22 working bar as decision-input context in evidence+md [scripts/dev + scripts/memory]
- [x] [Review][Patch] Drop dead PrimingReportDeps.runsDir [scripts/memory/priming-report.ts]
- [x] [Review][Defer] Failed-leg evidence deleteOutcomes semantics (leg-driver classification, pre-existing) [scripts/p0-9/leg-lib.ts] — deferred, pre-existing

### Review Findings (round 2, 2026-10-07 — 17 patch / 0 dismissed / 1 deferred)

- [x] [Review][Patch] costTable $0-print for absent/unpriced cycles at >0 cycles — branch on CostView hasEvents/hasTokenRows/unpricedRows [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Verifier hitRateAt5 assertion NaN-vacuous below floor — assert belowFloor + hits [scripts/dev/verify-m13-e2e.ts]
- [x] [Review][Patch] Committed baseline artifact predates shipped shape — provenance README in evidence/memory [_bmad-output/evidence/memory]
- [x] [Review][Patch] Cycle probes id-anchored: byOrigin + caveat in md; outcome-doc banking deviation noted [scripts/memory/priming-report.ts]
- [x] [Review][Patch] recallDir unreadable (non-ENOENT) → dataNote, not silent zero cycles [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Malformed canary resolve crashes outside try — shape-check inside [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] CWD hint in refusal reasons (relative defaults) [scripts/memory]
- [x] [Review][Patch] probe-recall CLI main catch — structured lock-timeout line [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] mergeMint deduped via probe-schema export [scripts/memory]
- [x] [Review][Patch] Lock across the same-day json/md pair write [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Growth unreadable-set skip gets a dataNote [scripts/memory/priming-report.ts]
- [x] [Review][Patch] writtenAt tie-break comment honesty [scripts/memory/probe-schema.ts]
- [x] [Review][Patch] --min-pass required, no silent 1 default [scripts/dev/verify-test-slice.mjs]
- [x] [Review][Patch] SideRow docstring + growth credits row.banks[0] when present [scripts/memory/priming-report.ts]
- [x] [Review][Patch] RunLockReentrantError fatal in growth (align contention policy) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Verifier dead runsDir wiring dropped [scripts/dev/verify-m13-e2e.ts]
- [x] [Review][Patch] writeP09 `at` shadow rename [tests/memory/probe-harness.test.ts]
- [x] [Review][Defer] vrf9ks memoryResidue mirrors mintRecord vs residue:[] (leg-driver family, pre-existing) — deferred, pre-existing

### Review Findings (round 3, 2026-10-07 — verification round: 12 patch / 0 dismissed / 0 new deferred)

- [x] [Review][Patch] writeP09 rename incomplete: `writtenAt: at` serialized the helper function — fixtures lost writtenAt, epoch-ordering test passed via tie-break (coverage restored + same-stamp tie test added) [tests/memory/probe-harness.test.ts]
- [x] [Review][Patch] Committed interim report pair stale-shaped — regenerated with shipped code + provenance note extended to cover it [_bmad-output/memory/reports]
- [x] [Review][Patch] Dev Agent Record test counts 48/48 → final recount [story record]
- [x] [Review][Patch] Jammed one-line test statement normalized [tests/memory/probe-harness.test.ts]
- [x] [Review][Patch] Header dispatchFailures wording aligned (absent log = silent by design) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Misplaced renderer comment above import.meta.main removed [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Canary mkdirSync inside the guarded region — uncreatable evidenceDir still returns the exit-3 refusal [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] ledger.close() failure no longer contradicts an assigned costTable (read-complete note) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] md-write failure rolls the json back — no torn pair on disk [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Present-but-unreadable audit db → receiptCoverage-0 dataNote (not silent absent) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Individually unreadable side-channel files counted + noted (not silently malformed) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Empty-concepts guard before seen.add — duplicate skips now recorded [scripts/p0-9/provision-and-import.ts]
- [x] [Review][Patch] Dead runsDir dropped from test baseReportDeps (driver close-out) [tests/memory/probe-harness.test.ts]

All three rounds: 58 findings raised (28 + 18 + 12), 54 patched (every HIGH/MED/LOW through round 3), 2 deferred as pre-existing leg-driver semantics, 2 dismissed as spec-sanctioned.

### Review Findings (round 3, 2026-10-07 — final wave: 12 patch / 0 dismissed / 0 deferred)

- [x] [Review][Patch] writeP09 `writtenAt: at` bound the helper function (JSON.stringify dropped it) — every fixture had NO writtenAt and the writtenAt-wins test resolved via the filename tie-break; fixed to `stamp` + same-stamp tie-path test added [tests/memory/probe-harness.test.ts]
- [x] [Review][Patch] Committed interim report pair stale-shaped (pre-round-2 dataNotes text not producible by shipped code) — regenerated with current code + provenance sentence in evidence/memory README [_bmad-output/memory/reports + _bmad-output/evidence/memory/README.md]
- [x] [Review][Patch] Dev Agent Record suite count stale (48/48-era) — recounted to 59/59 (17/16/23/3) [story record]
- [x] [Review][Patch] canary-miss test's first statement jammed onto the test() line — normalized [tests/memory/probe-harness.test.ts]
- [x] [Review][Patch] Header overclaim: absent dispatch log omits dispatchFailures silently by design (present-but-unreadable gets the note) — wording aligned [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Misplaced "Pure renderer (AC5)" comment above `import.meta.main` (describes report-render.ts) — deleted [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Canary-path mkdirSync could throw past the contracted refusal — moved inside the guarded region (refusal survives, diagnosticPath omitted) [scripts/memory/probe-recall.ts]
- [x] [Review][Patch] Cost-join outer catch could push "costTable omitted" beside a serialized table on close() failure — close-failure branch notes the table is read-complete [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Torn json/md pair on md-write failure — json rolled back to its previous bytes (or absent state) before rethrow [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Present-but-unreadable audit db collapsed to silent 0% coverage — dataNote "audit db unreadable … receiptCoverage reported 0" (absent db stays silent) [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Side-channel row present-but-unreadable indistinguishable from malformed JSON — read-vs-parse failures counted separately, non-ENOENT reads get a counted dataNote [scripts/memory/priming-report.ts]
- [x] [Review][Patch] Empty-concepts guard sat after seen.add — second same-domain empty-concepts entry dropped without its recorded failure; guard moved before the dedupe + dedicated test (also un-broke 3 legs.test.ts green-leg fixtures made leg-fatal by F-017's corpus entry) [scripts/p0-9/provision-and-import.ts + tests/p0-9/legs.test.ts]

### Review Findings (round 4, 2026-10-07 — 4 patch / 0 dismissed / 0 deferred)

- [x] [Review][Patch] Three-round summary overcounted: 59 raised / 3 deferred vs the recorded round headings (28 + 18 + 12 = 58; deferrals 1 + 1 = 2 — the verification-round section's 13th checkbox, the dead-runsDir driver close-out, double-books round 2's fix) — summary aligned to 58 / 54 patched / 2 dismissed / 2 deferred [story record]
- [x] [Review][Patch] Live-tier note claimed the real-instance run was still pending — it already happened (committed first baseline `2026-10-07T15-52-32-492Z-hit-rate.json`, hit-rate@5 0.565 / 23 probes / canary hit / median 106ms) and the `m13-hindsight` instance is down (no containers or volumes remain); note rewritten, future runs framed as repeat measurements [story record]
- [x] [Review][Patch] Round-1 [Review][Patch] checklist entries left unchecked though all 25 patches shipped (rounds 2–3 entries were already checked) — marked [x]; the round-1 [Review][Defer] disposition entry left as-is [story record]
- [x] [Review][Patch] Receipt coverage query keyed on `subject_id` (the retain's documentId) — works today only because M1.2's `deriveDocumentId` aliases runId verbatim; keyed on `run_id` (AC4's join is on the run) + discriminating fixture: receipt whose subject_id names a live cycle but run_id does not must NOT count as covered. `probe-schema`'s `loadReceiptMintRecords` intentionally keeps `subject_id` — mint membership joins on the document, a different key [scripts/memory/priming-report.ts + tests/memory/probe-harness.test.ts]
