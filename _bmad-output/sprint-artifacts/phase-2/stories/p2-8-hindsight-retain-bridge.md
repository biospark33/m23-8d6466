# P2.8: Hindsight Retain Bridge — Push the Daily Learnings Doc into qds-product + qds-meta

**Story Points:** 3

## Spec Reference

- QDS-MEM-003 §7.1–7.2 (Nightly Promotion → Hindsight retain); QDS-MEM-001 §6.2 (bank routing/precedence + retain I/O schema)
- QDS-MEM-003-IMPL §C D7 (resolves SPIKE-9: bridge is batch cron retain, not a live per-event hook); §D.5 (real `retain()` signature)

## User Story

As a QDS dev agent,
I want each day's Daily Learnings doc routed and pushed into the correct Hindsight banks with a stable dated documentId,
so that distilled operational learnings enter collective memory exactly once per day with no duplicates on cron retries (G-durable — promotion reaches Hindsight idempotently).

## Overview

This story wires the bridge from the P2.7 Daily Learnings doc into Hindsight via the real `retain()` API (§D.5), closing the D7 batch-promotion loop end-to-end. Doc sections are routed by the reused QDS-MEM-001 §6.2 precedence rules: product decisions/antipatterns/patterns go to **qds-product** (tags `module:X, knowledge_type:Y, severity:Z`), and skill/outcome/optimization learnings go to **qds-meta** (tags `skill:X, outcome:Y, quality_dim:Z`). Hindsight exposes no multi-bank retain, so the bridge loops per bank. The load-bearing detail is idempotency: each daily push uses a **stable dated `documentId`** (e.g. `daily-learnings-2026-06-19`) with **`updateMode:"replace"`** — omitting the documentId would duplicate the entry on every cron retry, the single most dangerous bridge defect. This builds on the cross-epic P1.11 retain wiring (KEEP loop). Wiring closes with no stub and no TODO: a real Daily Learnings doc lands in both banks, and re-pushing the same doc replaces rather than duplicates. This story adds no Hindsight bank/agent changes (additive use only) and does not do the consolidation (P2.7 owns that).

## E2E Slice

**Demonstrable behavior:** Take a real P2.7 Daily Learnings doc for `2026-06-19`. The bridge routes its sections per QDS-MEM-001 §6.2, then loops per bank: it calls `retain("qds-product", productContent, {documentId:"daily-learnings-2026-06-19", updateMode:"replace", tags:{module, knowledge_type, severity}})` and `retain("qds-meta", metaContent, {documentId:"daily-learnings-2026-06-19", updateMode:"replace", tags:{skill, outcome, quality_dim}})`. Querying each bank afterward returns exactly one document for that date with the correct tags. Re-running the bridge for the same doc (cron retry) calls `retain` again with the same documentId+`replace` and the post-query count stays at exactly one per bank.

**Wiring closed:** On completion of this story, a Daily Learnings doc is routed and retained idempotently into qds-product and qds-meta on a real run using only code merged by this story and predecessors P2.7 + P1.11. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P2.7, P1.11

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a Daily Learnings doc for date D, When the bridge retains it twice (initial push + a simulated cron retry), Then each bank uses the identical stable documentId `daily-learnings-D` with `updateMode:"replace"` and, after both calls, querying each bank returns exactly one document for date D (count == 1 per bank — no duplication on retry).
2. Given a doc containing both product-class and meta-class sections, When routing runs per QDS-MEM-001 §6.2, Then product decisions/antipatterns/patterns land in qds-product and skill/outcome/optimization learnings land in qds-meta with no section misrouted; a section matching MULTIPLE classes routes by §6.2 precedence and a section matching NO class is flagged (not dropped) and defaulted to **qds-product** with reserved tags `knowledge_type:'pattern'`, `severity:'low'`, `module:'unclassified'`, plus a `flagged:true` metadata field — so the default satisfies the closed `z.enum` vocab without inventing an out-of-vocab tag value.
3. Given two target banks, When the bridge pushes, Then it loops `retain()` once per bank (no multi-bank retain call) and ALWAYS pushes BOTH banks every run — even when a bank's routed content is empty — so `replace` clears a re-routed/now-empty bank's stale prior entry; and when retaining to a bank fails, the bridge STILL attempts the other bank (never short-circuits on the first failure), with each bank's `replace` independently idempotent so the next run self-heals the failed bank (no partial state corrupts the next retry). On partial failure (ONE OR BOTH banks fail), `push(doc)` THROWS a single `RetainPartialFailure` (an `AggregateError` subclass whose `.errors` array COLLECTS EVERY per-bank failure encountered — one entry if one bank failed, TWO entries if both banks failed with different errors; NO per-bank error is discarded) and `retained_at` REMAINS NULL — the caller does NOT advance/mark the night retained, leaving the date detectable by the AC7 recovery scan. (The throw is the single contract; a caller MAY `catch` `RetainPartialFailure` and map it to a failure result, but `push(doc)` itself throws — it does not return a result.)
4. Given a retained doc, When it is written to qds-product, Then it carries `module`, `knowledge_type`, and `severity` tags (values validated against the §6.2 `z.enum` vocabulary); when written to qds-meta it carries `skill`, `outcome`, and `quality_dim` tags (closed-vocab enum-validated; correct tag scoping per bank, no anonymous writes).
5. Given the source Daily Learnings doc, When content is retained, Then the bridge RE-SCANS the body for secret patterns itself (defense-in-depth, INV-OM3 = re-scan not re-trust — does not merely trust P2.7's upstream mask) and asserts no secret pattern is present before retain.
6. Given a successful retain of both banks for date D, When the pushes complete, Then the bridge stamps `promotion_runs.retained_at` for date D, so a doc-written-but-not-retained date is detectable and replayable (closing the P2.7↔P2.8 exactly-once seam).
7. Given date D-1 has `doc_path` set but `retained_at` NULL (a stranded prior retain failure/crash), When the next nightly run executes, Then the run (the P2.8 bridge, or the cron-runner invoking it) FIRST scans `promotion_runs` for any prior date with `doc_path` set AND `retained_at` NULL (the `retained_at IS NULL` predicate is the filter — it inherently skips any date that already has `retained_at` set, so only stranded/incomplete retain records are targeted, never already-successful ones), re-pushes D-1's doc (re-route + retain both banks with the same dated documentId+`replace`), and stamps `retained_at` for D-1 — then proceeds with today's date (recovery scan makes INV-P28-3 both detectable AND replayable).
8. Given a bank's content was already retained on a partial-failure run, When the bridge re-pushes after recovery, Then the re-pushed per-bank content is BYTE-IDENTICAL to the first attempt — routing is a PURE DETERMINISTIC function of the immutable Daily Learnings artifact (a section cannot move banks between runs), so `replace` overwrites with identical bytes and no stale/moved-section entry can survive.

## Technical Notes

- **Contracts/Schema:**
```typescript
// real retain() signature (§D.5, from hindsight-docs/references/developer/api/retain.md) — reuse the P1.11 hindsight-client
// AND EXTEND it (additive, NOT a redefine) to expose the FULL §D.5 surface:
// await client.retain(bankId, content, { documentId, updateMode, tags, context?, timestamp?, metadata?, entities? })
// P1.11's retain schema (p1-11 §Contracts) only models { bank_id, content, metadata:{issueId,runId,stepId,kind} } —
// it does NOT expose documentId/updateMode/tags. P2.8 OWNS extending the client to forward them so the bridge's
// idempotency contract is schema-enforced at the client boundary, NOT assumed from P1.11 passthrough.
// Closed-vocab tag VALUES validated via z.enum (§6.2), NOT open z.record(string,string).
const KnowledgeType = z.enum(['decision', 'antipattern', 'pattern']);     // §6.2 qds-product
const Severity      = z.enum(['critical', 'high', 'medium', 'low']);      // §6.2 qds-product
const Outcome       = z.enum(['success', 'partial', 'failure', 'skipped', 'confirmed', 'rolled_back']); // §6.2 qds-meta; 'confirmed'/'rolled_back' added for P2.11 experiment-verdict retention
const QualityDim    = z.enum(['correctness', 'efficiency', 'maintainability', 'safety', 'intervention_effectiveness']); // §6.2 qds-meta; 'intervention_effectiveness' added for P2.11 experiment-verdict retention
const ProductTags = z.object({ module: z.string(), knowledge_type: KnowledgeType, severity: Severity });
const MetaTags    = z.object({ skill: z.string(), outcome: Outcome, quality_dim: QualityDim });
// metadata slot mirrors §D.5 retain() `metadata?` — carries the no-class `flagged:true` signal (NOT a tag value).
const RetainMetadata = z.object({ flagged: z.boolean().optional() }).optional();
const RetainPlan = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  documentId: z.string().regex(/^daily-learnings-\d{4}-\d{2}-\d{2}$/),  // STABLE dated id, e.g. daily-learnings-2026-06-19 — regex-enforced so an omitted/malformed documentId fails validation (INV-P28-1) before it can duplicate on retry
  updateMode: z.literal('replace'),                     // dated + replace = idempotent overwrite
  // BOTH banks pushed every run (even when content is empty) so `replace` clears a re-routed/now-empty bank.
  pushes: z.tuple([
    z.object({ bankId: z.literal('qds-product'), content: z.string(), tags: ProductTags, metadata: RetainMetadata }),
    z.object({ bankId: z.literal('qds-meta'),    content: z.string(), tags: MetaTags,    metadata: RetainMetadata }),
  ]),
});
```
- **Integration points (each wired & exercised in this story):** reads the P2.7 artifact at `promotion_runs.doc_path` and RE-VALIDATES it against the `DailyLearningsDoc` schema (**defined in P2.7 §Technical Notes → Contracts/Schema** — the `const DailyLearningsDoc = z.object({ date, generated_at, window, clusters[], truncated, doc_bytes })` block at P2.7 line 45; NOT redefined here, shared/imported so the two stories carry one validation contract, no drift); reuses the P1.11 `hindsight-client` `retain()` wiring AND EXTENDS it additively to expose the full §D.5 retain surface (cross-epic KEEP loop — MCP-only channel per INV-MEM-1); applies QDS-MEM-001 §6.2 routing/precedence + I/O schema; targets banks **qds-product** and **qds-meta**; stamps `promotion_runs.retained_at` on success (R12/R14 seam).
- **Files / functions touched:** `src/promotion/retain-bridge.ts` (`RetainBridge.push(doc)` — re-scan secrets, build documentId, route per §6.2, ALWAYS loop BOTH banks even after the first fails, retain with `replace`, THROW on partial failure leaving `retained_at` NULL, stamp `retained_at` only on full success; OWNS the `RetainPartialFailure` error class — an `AggregateError` subclass exposing `.errors` (the collected per-bank failures); `push(doc)` always attempts BOTH banks (never short-circuits on the first failure) then, on partial failure, throws ONE `RetainPartialFailure` aggregating ALL per-bank errors encountered — one `.errors` entry if one bank failed, two if both failed with different errors — so NO per-bank error is discarded; `RetainBridge.recoverStranded()` — scan `promotion_runs` for prior dates with `doc_path` set AND `retained_at` NULL, re-push each before today), `src/promotion/retain-routing.ts` (QDS-MEM-001 §6.2 precedence → bank+tags mapping; PURE DETERMINISTIC fn of the immutable doc; multi-class→precedence, no-class→qds-product default with reserved in-vocab tags + `flagged:true`), `src/promotion/retain-types.ts` (`RetainPlan` + `RetainMetadata` + closed-vocab `z.enum` tag schemas + the `RetainPartialFailure` `AggregateError` subclass), `src/memory/hindsight-client.ts` (EXTEND P1.11's client additively to forward the full §D.5 retain surface — `documentId`/`updateMode`/`tags`/`metadata` — which P1.11's `{bank_id,content,metadata}` retain schema does not expose; the idempotency contract is OWNED + schema-enforced by P2.8, not assumed from P1.11 passthrough).
- **Routing precedence (§6.2):** a section matching MULTIPLE knowledge classes is assigned by §6.2 precedence order; a section matching NO class is flagged and routed to the default bank **qds-product** with reserved in-vocab tags (`knowledge_type:'pattern'`, `severity:'low'`, `module:'unclassified'`) plus a `flagged:true` metadata field (never silently dropped, never an out-of-vocab tag value). Tag VALUES validated against the closed §6.2 vocabulary via `z.enum` (`knowledge_type`, `severity`, `outcome`, `quality_dim`) — not open `z.record(string,string)`.
- **Guards/limits:** stable dated `documentId` per day; `updateMode:"replace"` (never default/append — append duplicates on retry); BOTH banks pushed EVERY run even when empty (so `replace` clears a now-empty bank); per-bank loop (no multi-bank retain); both banks are ALWAYS attempted even after the first fails, so every per-bank failure is captured; on partial failure `push(doc)` throws a single `RetainPartialFailure` (AggregateError) whose `.errors` array COLLECTS ALL per-bank failures (one if one bank failed, two if both failed with different errors — no per-bank error discarded); the next run's `replace` self-heals a previously failed bank (no partial-state corruption); reuse P1.11 MCP-only channel (no direct HTTP to Hindsight); bridge RE-SCANS for secrets before retain (re-scan not re-trust).
- **SPIKE note:** resolves **SPIKE-9 (D7)** — the bridge is a batch nightly retain, NOT a live per-event hook; no spike is open against this story.

## Files to Modify

> ≤10 unique paths, one per line.
- `src/promotion/retain-bridge.ts`
- `src/promotion/retain-routing.ts`
- `src/promotion/retain-types.ts`
- `src/memory/hindsight-client.ts`
- `tests/promotion/retain-bridge.test.ts`
- `tests/promotion/retain-idempotency.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** The bridge performs no per-event work and no LLM call — it pushes the already-distilled batch doc; egress is the once-daily `retain()` loop only.
- **INV-OM3:** Retained content carries no secret pattern — the bridge RE-SCANS the doc body itself before retain (defense-in-depth: re-scan, not re-trust P2.7's upstream mask); no secrets enter collective memory.
- **INV-P28-1:** Idempotent retain — every daily push uses a stable dated `documentId` with `updateMode:"replace"`; omitting the documentId or using append is forbidden (it duplicates on every cron retry). Each bank's `replace` is independently idempotent; BOTH banks are pushed every run (even empty) so `replace` clears stale/now-empty banks. Re-pushing the same date yields exactly one document per bank.
- **INV-P28-2:** Correct tag scoping — qds-product entries carry `module/knowledge_type/severity` and qds-meta entries carry `skill/outcome/quality_dim`, with closed-vocab values validated via `z.enum`; no cross-bank misrouting, no no-class section silently dropped, no anonymous (untagged) writes.
- **INV-P28-3:** Exactly-once seam — `promotion_runs.retained_at` is stamped only after both banks succeed; on partial failure `push(doc)` ALWAYS attempts BOTH banks (never short-circuits on the first failure) then throws a single `RetainPartialFailure` (AggregateError) whose `.errors` array COLLECTS EVERY per-bank failure encountered (one if one bank failed, two if both failed with different errors — no per-bank error discarded/swallowed) and `retained_at` stays NULL. A doc-written-but-not-retained date (`doc_path` set, `retained_at` NULL) is detectable AND replayable: every nightly run first scans for such stranded prior dates and re-pushes them (re-push is byte-identical per bank since routing is a pure deterministic fn of the immutable doc), closing the P2.7↔P2.8 seam gap.

## Definition of Done

> high-signal, story-specific boxes. NO project-wide CI filler.

- [ ] **Impl:** `RetainBridge.push(doc)` reads + re-validates the P2.7 doc at `promotion_runs.doc_path` against `DailyLearningsDoc` and builds the stable dated `documentId`
- [ ] **Impl:** Route doc sections per QDS-MEM-001 §6.2 precedence → qds-product vs qds-meta; multi-class match resolves by precedence, no-class match is flagged/defaulted (never silently dropped), with correct per-bank tags
- [ ] **Impl:** ALWAYS loop BOTH banks every run (even when a bank's content is empty, so `replace` clears it) — once per bank, no multi-bank retain — reusing the P1.11 hindsight-client (MCP-only channel)
- [ ] **Impl:** Every push uses `updateMode:"replace"` with the dated documentId (idempotent overwrite, never append); each bank's `replace` independently idempotent so a one-bank failure self-heals next run
- [ ] **Impl:** Stamp `promotion_runs.retained_at` only after both banks succeed; on partial failure `push(doc)` THROWS leaving `retained_at` NULL (R12/R14 exactly-once seam; doc-written-but-not-retained is detectable/replayable)
- [ ] **Impl:** `recoverStranded()` — each nightly run first scans `promotion_runs` for any prior date with `doc_path` set AND `retained_at` NULL and re-pushes it (re-push byte-identical per bank) before today's date
- [ ] **Contract:** `RetainPlan` validated before push; tag VALUES validated via closed-vocab `z.enum` (`knowledge_type/severity/outcome/quality_dim`), not open `z.record`; real §D.5 retain signature honored (no client redefinition)
- [ ] **Integration:** End-to-end push of a real Daily Learnings doc into both banks; post-query confirms one doc/bank with correct enum-validated tags; `retained_at` stamped
- [ ] **Security:** INV-OM1 (no per-event/LLM egress), INV-OM3 (bridge RE-SCANS for secrets — re-scan not re-trust), INV-P28-1 (stable dated documentId + replace, both banks every run ⇒ no duplicate on retry), INV-P28-2 (enum-validated per-bank tag scoping, no-class never dropped), INV-P28-3 (`retained_at` exactly-once seam) — each enforced and asserted
- [ ] **Test (unit):** routing splits product vs meta sections; multi-class→precedence and no-class→qds-product default with reserved in-vocab tags + `flagged:true`; per-bank enum tag assembly; retry with same documentId+replace does not duplicate; both-banks-pushed-when-empty clears a now-empty bank; re-push of the same doc is byte-identical per bank; `recoverStranded()` re-pushes a D-1 with `doc_path` set/`retained_at` NULL and stamps it
- [ ] **Test (partial-failure aggregation):** when ONE bank fails, `push(doc)` throws a `RetainPartialFailure` (assert `instanceof AggregateError`) whose `.errors` array contains exactly ONE entry carrying that bank's per-bank error, and `retained_at` stays NULL; when BOTH banks fail with DIFFERENT errors, `push(doc)` throws a `RetainPartialFailure` whose `.errors` array contains TWO entries — one per bank — exposing BOTH per-bank error messages (neither is swallowed), and `retained_at` stays NULL; the bridge attempted both banks in both cases (the second bank was reached despite the first failing)
- [ ] **Test (client extend + passthrough):** P1.11's retain schema (`{bank_id,content,metadata}`) does NOT expose `documentId`/`updateMode`/`tags`, so this story EXTENDS the hindsight-client additively to forward the full §D.5 retain surface; assert the bridge's `retain(bank, content, {documentId, updateMode:"replace", tags, metadata})` reaches the underlying Hindsight MCP `retain` call with `documentId` + `updateMode` + `tags` + `metadata` intact (the idempotency contract is OWNED + schema-enforced by P2.8, NOT assumed from P1.11 passthrough)
- [ ] **Test (e2e demo — MANDATORY):** Push a real P2.7 doc for date D into qds-product + qds-meta, query both banks and assert one correctly-tagged doc each; re-run the bridge for the same doc and re-query — assert the per-bank count stays at exactly one and `promotion_runs.retained_at` is stamped (idempotent dated documentId proven end-to-end)

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
