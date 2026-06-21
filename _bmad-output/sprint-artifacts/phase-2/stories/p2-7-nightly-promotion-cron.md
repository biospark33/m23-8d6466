# P2.7: Nightly Promotion Cron — Consolidate Daily Events into a Daily Learnings Doc

**Story Points:** 4

## Spec Reference

- QDS-MEM-003 §7.1 (Nightly Promotion); QDS-MEM-003-IMPL §C D1 (all-tier LLM moves off per-event capture into nightly promotion)
- QDS-MEM-003 §10 (cron model); QDS-EXEC-001 §7 SPIKE-9 (resolved: bridge is batch cron, not live hook)

## User Story

As a QDS dev agent,
I want a single off-peak nightly job to consolidate the previous day's captured events into one bounded "Daily Learnings" doc,
so that durable learnings are distilled once per day at predictable cost without per-event LLM egress (G-cost — one LLM run/night replaces the stripped per-event SDKAgent).

## Overview

This story wires the nightly promotion job end-to-end: a single off-peak cron tick reads the previous day's `events`/`runs` rows over a bounded time window (window scales with **days, not event volume**), performs **light** mechanical consolidation (dedupe near-identical signals, cluster by run/skill/topic, summarize each cluster), and emits exactly one structured "Daily Learnings YYYY-MM-DD" doc (machine JSON + human prose) rendered with the reused claude-mem context formatters. This is **D1**: the only LLM work in the whole operational-memory tier lives here, replacing the stripped per-event `SDKAgent` (§D.2). Deep multi-day synthesis is explicitly NOT done here — it stays in Hindsight's weekly Synthesizer agent. The job is the net-new `NightlyPromotionJob` class plus a thin cron-runner. Wiring closes with no stub and no TODO: a real night of captured events produces a real capped doc on disk. The downstream `retain()` push of that doc is P2.8; this story stops at producing the doc.

## E2E Slice

**Demonstrable behavior:** Seed a day's worth of `events`/`runs` (multiple runs across ≥2 skills with deliberate near-duplicate signals). Invoke the nightly job for that date. The job acquires a single-instance run-marker row, reads only that day's window, dedupes + clusters + summarizes (one LLM consolidation pass), and writes one `daily-learnings-2026-06-18` artifact containing a JSON block (clusters with run/skill/topic + per-cluster summary) and a rendered prose section. Re-running the job for the same date is a no-op (run-marker present → skip, no second LLM call). The emitted doc is byte-capped and contains zero secret patterns.

**Wiring closed:** On completion of this story, the previous day's captured events are consolidated into one bounded, secret-masked Daily Learnings doc by a single idempotent off-peak cron run, using only code merged by this story and predecessors P2.3+P2.5+P2.6. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P2.3, P2.5, P2.6

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a day with captured events and no `promotion_runs` row for that date, When the nightly job runs once and then is invoked a second time for the same date, Then the first run writes exactly one Daily Learnings doc and the atomic `INSERT … ON CONFLICT(date) DO NOTHING` acquires the marker, and the second run's acquire affects 0 rows so it performs zero LLM/consolidation work and writes zero additional docs (the date's `promotion_runs` row count stays at exactly 1, enforced by the PRIMARY KEY on `date`).
2. Given the previous day's events span multiple runs and skills with near-duplicate signals (including near-identical signals appearing in DIFFERENT runs), When consolidation runs, Then signals are deduped by the deterministic key SCOPED to the same `run_id` (cosine over the 384-dim `event_vec` ≥ threshold `T`, else normalized payload-hash equality for non-embedded events, compared ONLY within a run) and the doc clusters by run/skill/topic with a single summary per cluster, so same-run duplicate signals collapse (`deduped_count > 0`) while cross-run near-dupes are preserved as distinct cluster members (dedupe demonstrably reduces same-run cluster member count below the raw event count without collapsing distinct executions).
3. Given a night whose captured event volume is below the configured threshold, When the cron tick fires, Then the job skips consolidation, writes no doc, records the skip on the marker (`skipped: true`, reason `below-threshold`, `finished_at` set), and makes zero LLM calls — this skip marker is terminal by design (never re-processed).
4. Given consolidation would otherwise produce a doc exceeding the configured size cap, When the doc is assembled, Then the doc is masked first, then truncated/elided (truncation reserves the `…[truncated]` marker length) to stay at or under the cap measured on post-mask bytes, and `truncated: true` is set in the JSON block (the doc never exceeds the cap).
5. Given source events contain secret-shaped strings (including only in an event's `error` field, paraphrased by the summarizer into the cluster summary), When the FINAL doc is rendered, Then the secret-mask runs AFTER LLM generation over the whole rendered doc (JSON summaries + prose) so no secret pattern survives into either the JSON or prose body.
6. Given the job crashed after acquiring the marker but before writing the doc (`finished_at IS NULL` / `doc_path IS NULL`), When the job is re-invoked for that same date D, Then it claims the reprocess via a SINGLE ATOMIC conditional `UPDATE promotion_runs SET started_at=?, finished_at=NULL WHERE date=? AND finished_at IS NULL AND (skipped=0 AND doc_path IS NULL)` returning affected-rows==1 (it NEVER DELETEs the marker), reprocesses date D (re-runs consolidation and writes the doc), and never silently skips a crashed date; a concurrent tick whose conditional UPDATE affects 0 rows exits (the 0-row loser never owns a marker another tick holds).
7. Given the cron is configured for off-peak once-per-night, When two ticks somehow overlap (same date), Then only the `INSERT … ON CONFLICT(date) DO NOTHING` that affects 1 row proceeds; the other affects 0 rows and exits without processing (single-instance guard backed by the PK, closing TOCTOU).

## Technical Notes

- **Contracts/Schema:**
```typescript
// Daily Learnings doc (machine JSON half; prose half rendered via claude-mem ContextBuilder)
const DailyLearningsDoc = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),       // bounded window key
  generated_at: z.number().int(),                       // epoch ms
  window: z.object({ from: z.number().int(), to: z.number().int() }),
  clusters: z.array(z.object({
    cluster_key: z.string(),                            // {run|skill|topic} grouping key
    dimension: z.enum(['run', 'skill', 'topic']),
    skill: z.string().nullable(),
    member_event_ids: z.array(z.string()),              // post-dedupe survivors
    deduped_count: z.number().int(),                    // collapsed near-dupes
    summary: z.string(),                                // LIGHT per-cluster summary (the only LLM output)
  })),
  truncated: z.boolean(),                               // set when size cap hit
  doc_bytes: z.number().int(),                          // ≤ cap
});
// promotion run-marker (single-instance + COMPLETION-STATE idempotency ledger)
// DDL: dedicated table (NOT schema_meta), PRIMARY KEY on `date` backs "exactly 1 marker row".
//   CREATE TABLE promotion_runs (
//     date TEXT PRIMARY KEY,              -- idempotency key (one row per date)
//     started_at INTEGER NOT NULL, finished_at INTEGER,  -- finished_at NULL = crashed → REPROCESS
//     skipped INTEGER NOT NULL DEFAULT 0, skip_reason TEXT,
//     doc_path TEXT,                      -- NULL when not yet written (crash before doc-write)
//     llm_calls INTEGER NOT NULL DEFAULT 0,
//     retained_at INTEGER                 -- P2.8 stamps on retain success (R14 seam)
//   );
// Atomic acquire = single `INSERT INTO promotion_runs(date,started_at) VALUES(?,?) ON CONFLICT(date) DO NOTHING`.
//   tick affecting 0 rows → another instance holds it → exit (closes TOCTOU; no read-then-write race).
// Idempotency key = COMPLETION-STATE, not row-existence: a row with finished_at IS NULL OR
//   (skipped=0 AND doc_path IS NULL) = crashed mid-run → the next invocation REPROCESSES date D
//   via a SINGLE ATOMIC conditional claim (NEVER DELETE a marker another tick may concurrently own):
//   UPDATE promotion_runs SET started_at=?, finished_at=NULL
//     WHERE date=? AND finished_at IS NULL AND (skipped=0 AND doc_path IS NULL);
//   affected-rows==1 → this tick owns the reprocess; affected-rows==0 → another tick claimed it (loser exits).
const PromotionRun = z.object({
  date: z.string(), started_at: z.number().int(), finished_at: z.number().int().nullable(),
  skipped: z.boolean(), skip_reason: z.string().nullable(), doc_path: z.string().nullable(),
  llm_calls: z.number().int(),
  retained_at: z.number().int().nullable(),             // P2.8 stamps on retain success (R14 seam)
});
```
- **Pipeline order (load-bearing):** `summarize → render → MASK → CAP/truncate → validate`. The secret-mask runs on the FINAL rendered doc (JSON cluster summaries + prose) AFTER LLM generation — so a secret the summarizer paraphrased out of an event's `error` field into a cluster summary is still caught. The byte-cap is measured on POST-mask bytes; truncation reserves the `…[truncated]` marker length so final bytes ≤ cap inclusive of the marker.
- **Dedup key (deterministic + run-scoped, so AC2 is testable):** near-duplicate detection is SCOPED to the same provenance context — two `tool_call`/`message` signals are compared for dedup ONLY when they share the same `run_id`. Within a run, two signals are near-duplicates when cosine over their existing 384-dim `event_vec` ≥ configured threshold `T`; for non-embedded events (`node`/`outcome`) fall back to normalized-payload-hash equality. Events in DIFFERENT runs are NEVER collapsed, even when their embeddings are near-identical — they are distinct executions with distinct provenance (e.g. the same `bash` tool_call shape in two unrelated runs solving different problems stays as two signals). Cross-run same-`skill` near-dupes are preserved as distinct cluster members (the cluster-by-skill dimension sees both). Dedup runs per-run before the run/skill/topic clustering step. No nondeterministic/LLM-judged dedupe; no global/cross-run dedup.
- **Typed handoff to P2.8:** on success the job stamps `promotion_runs.doc_path`; P2.8 reads the artifact AT `doc_path` and RE-VALIDATES it against the `DailyLearningsDoc` schema before retain (the seam is the validated artifact, not an in-memory object).
- **Integration points (each wired & exercised in this story):** reads `events`/`runs` via the P2.1 recall API (bounded-window scan by `created_at`); reuses claude-mem `ContextBuilder` (`claude-mem/src/services/context/*`, §D.1) for prose render; reuses the P2.3 `maskAndCap`/secret-mask util (`src/capture/mask-and-cap.ts`) on the FINAL doc output; writes the doc artifact to the configured learnings dir; writes/reads the `promotion_runs` marker table (PK on `date`).
- **Files / functions touched:** `src/promotion/nightly-promotion-job.ts` (`NightlyPromotionJob.run(date)` — read→dedupe→cluster→summarize→render→cap→write), `src/promotion/cron-runner.ts` (off-peak schedule + single-instance acquire), `src/promotion/promotion-config.ts` (tunables: window, threshold, size cap, schedule), `src/promotion/doc-renderer.ts` (claude-mem ContextBuilder adapter, JSON+prose).
- **Guards/limits:** bounded read window (days not events); idle-night volume threshold (skip below, marker terminal-by-design); doc size cap (mask→truncate→flag, post-mask bytes); one LLM consolidation pass per run; cron idempotent via the `promotion_runs` PK on `date` + completion-state ledger (atomic `INSERT … ON CONFLICT(date) DO NOTHING` to acquire; crashed-date reprocess via a SINGLE ATOMIC conditional `UPDATE … WHERE date=? AND finished_at IS NULL AND (skipped=0 AND doc_path IS NULL)` returning affected-rows — never DELETE a marker another tick may own; `finished_at`/`doc_path` NULL ⇒ crashed ⇒ reprocess, never silent skip); all tunables (incl. dedup threshold `T`) in `promotion-config.ts`.
- **Cron library decision (explicit — design did NOT pin):** RECOMMEND **`croner`** (zero-dep, TypeScript, Bun-friendly) for the off-peak schedule; ALTERNATIVE reuse swarmclaw's `cron-parser ^5.5.0` + a custom single-tick loop; `node-cron` ACCEPTABLE only after a Bun-runtime smoke check. Pin the chosen lib at P2.0. Schedule semantics: once/night, off-peak, single fire. Idempotency does NOT rely on the scheduler — it relies on the `promotion_runs` run-marker, so a missed/duplicated tick cannot double-process.
- **Disambiguation:** this nightly promotion cron is the operational-memory daily consolidator — it is NOT a Hindsight strategic cron agent (Synthesizer/Meta-Optimizer/Blind-Spot run weekly/biweekly/monthly and do the deep synthesis this job deliberately avoids).

## Files to Modify

> ≤10 unique paths, one per line.
- `src/promotion/nightly-promotion-job.ts`
- `src/promotion/cron-runner.ts`
- `src/promotion/promotion-config.ts`
- `src/promotion/doc-renderer.ts`
- `tests/promotion/nightly-promotion-job.test.ts`
- `tests/promotion/cron-idempotency.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** The only LLM work in the tier is this nightly consolidation pass — no per-event egress; the job makes exactly one consolidation LLM call per processed night and zero on skipped/idempotent nights (asserted).
- **INV-OM3:** Source `payload_json`/`result_json` are already ≤64KB secret-masked at write; the doc renderer re-applies the secret-mask to the FINAL rendered doc AFTER LLM generation (covering `error`-field text the summarizer may have paraphrased into a summary) so no secret pattern is promoted into the Daily Learnings doc.
- **INV-P27-1:** Cron is idempotent and single-instance via the `promotion_runs` PRIMARY KEY on `date` (atomic `INSERT … ON CONFLICT(date) DO NOTHING`; the tick affecting 0 rows exits — TOCTOU closed) plus a completion-state ledger: idempotency is keyed on completion-state, not row-existence, so a crashed date (`finished_at`/`doc_path` NULL) is REPROCESSED via a SINGLE ATOMIC conditional `UPDATE … WHERE date=? AND finished_at IS NULL AND (skipped=0 AND doc_path IS NULL)` returning affected-rows (the 0-row loser exits; the marker is NEVER DELETEd, so no tick can clobber a marker another tick concurrently owns), never silently skipped; a `skipped:true` marker is terminal by design.
- **INV-P27-2:** The emitted doc is hard-capped at the configured byte size — consolidation that would exceed the cap truncates and sets `truncated: true` (resource bound, prevents unbounded doc growth).

## Definition of Done

> high-signal, story-specific boxes. NO project-wide CI filler.

- [ ] **Impl:** `NightlyPromotionJob.run(date)` reads only the bounded day window via P2.1 recall (scan by `created_at`, scales with days not event count)
- [ ] **Impl:** Light mechanical consolidation — run-scoped dedupe (same `run_id` only; cosine over `event_vec` ≥ `T`, else normalized payload-hash) performed per-run before clustering so cross-run near-dupes are never collapsed, then cluster by run/skill/topic, one summary per cluster (NO deep multi-day synthesis; that stays in Hindsight weekly)
- [ ] **Impl:** Emit one "Daily Learnings YYYY-MM-DD" doc (JSON block + prose) via the pipeline `summarize → render → MASK → CAP/truncate → validate` (mask AFTER LLM gen; cap on post-mask bytes; truncation reserves marker length), rendered via reused claude-mem `ContextBuilder`
- [ ] **Impl:** Idle-night skip — below volume threshold ⇒ no doc, no LLM call, marker records `skipped`/reason and is terminal by design
- [ ] **Impl:** `promotion_runs` PK on `date`; atomic acquire `INSERT … ON CONFLICT(date) DO NOTHING` (0-row tick exits); crashed-date reprocess via SINGLE ATOMIC conditional `UPDATE … WHERE date=? AND finished_at IS NULL AND (skipped=0 AND doc_path IS NULL)` returning affected-rows (0-row loser exits; NEVER DELETE the marker); `retained_at` column present for the P2.8 seam (R14)
- [ ] **Impl:** Off-peak once/night cron-runner using the chosen lib (croner recommended); schedule + tunables (incl. dedup `T`) in `promotion-config.ts`
- [ ] **Contract:** `DailyLearningsDoc` + `PromotionRun` schemas validated on emit; doc clusters carry dimension/summary/member ids; `doc_path` stamped as the typed handoff P2.8 re-validates
- [ ] **Integration:** End-to-end over real seeded `events`/`runs` — read → dedupe → cluster → summarize → render → mask → cap → validate → write
- [ ] **Security:** INV-OM1 (exactly one consolidation LLM call/night, zero on skip/idempotent), INV-OM3 (secret-mask on FINAL doc after LLM gen), INV-P27-1 (PK+completion-state single-instance/idempotent, crashed date reprocessed), INV-P27-2 (doc size cap on post-mask bytes + truncate flag) — each enforced and asserted
- [ ] **Test (unit — dedup branch a, embedded, same-run):** near-duplicate `tool_call`/`message` signals sharing the same `run_id` collapse via cosine over `event_vec` ≥ `T` (embedded-event branch), so `deduped_count > 0` within that run
- [ ] **Test (unit — dedup branch b, non-embedded, same-run):** `node`/`outcome` events with no `event_vec` sharing the same `run_id` collapse via normalized-payload-hash equality (the hash branch — the only dedup path for non-embedded events per R6 — ships tested)
- [ ] **Test (unit — dedup scoping, cross-run non-collapse):** near-identical signals (cosine ≥ `T` or equal normalized payload hash) in DIFFERENT `run_id`s are NOT collapsed — both survive as distinct cluster members even when they share the same `skill` (proves dedup is run-scoped, not global; multi-run provenance preserved)
- [ ] **Test (unit):** clustering keys by run/skill/topic; below-threshold skip path; size-cap truncation sets `truncated`; SECRET-ONLY-IN-`error`-field paraphrased by a stubbed summarizer is asserted ABSENT from the final doc; crashed-marker (`finished_at` NULL) re-invocation reprocesses date D via the atomic conditional UPDATE (0-row loser exits)
- [ ] **Test (cron-lib smoke):** the chosen cron lib fires exactly once off-peak under the Bun runtime (single-fire schedule smoke-check) — depends on P2.0 pinning exactly one cron lib (cross-ref P2.0; this box exercises whichever lib P2.0 pinned)
- [ ] **Test (e2e demo — MANDATORY):** Seed a full day of multi-run/multi-skill events with near-dupes and a secret-shaped string (incl. one only in an `error` field); run the job; assert exactly one capped, secret-free Daily Learnings doc with clustered summaries is written and `promotion_runs.doc_path` is stamped; re-run for the same date and assert zero new docs and zero LLM calls (PK-backed single-marker idempotency proven end-to-end)

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
