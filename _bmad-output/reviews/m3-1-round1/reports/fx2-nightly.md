# fx2 — nightly job cluster (src/hindsight/nightly-consolidate.ts + tests/hindsight/nightly-consolidate.test.ts)

Branch: feature/m3-1-manager-meta-banks-l3-consolidate. No files outside the two owned files were touched.

## Verdict table

| Finding | Fix | Where | Test pin |
|---|---|---|---|
| F-006 terminal-status gate | `observeRefresh` now classifies each matching row: `failed`/`cancelled` → `REFRESH_FAILED` with the terminal status + error_message quoted; `pending`/`processing` → keep polling; any other terminal status (incl. `completed`) = evidence | `REFRESH_TERMINAL_FAILURE_STATUSES` / `REFRESH_PENDING_STATUSES` + `observeRefresh` | "terminal status cancelled is NOT success evidence", "pending refresh keeps polling" |
| F-008 duplicate banks | `[...new Set(deps.banks)]` at entry; dupes dropped → `nightly-banks-deduped` event with `dropped` count; `nightly-fire` carries the deduped list | `runNightlyConsolidate` entry | "duplicate bank ids are deduped at entry" (2 consolidates, 2 receipts, dropped=1) |
| F-009 unparseable created_at | Matching rows with `NaN` `Date.parse` are counted per poll and surfaced: `REFRESH_EVIDENCE_MISSING` message appends "N matching refresh row(s) seen with unparseable created_at" (appended only when N>0) | `observeRefresh` → `consolidateOneBank` | "matching row with an UNPARSEABLE created_at" |
| F-010 ops pagination | Evidence poll pages with `offset = page * limit` (limit 50, max 5 pages), stops early on a match, breaks on a short page; page 1 omits `offset` so existing URLs are unchanged | `observeRefresh` page loop | "the evidence poll PAGINATES" (50 non-matching rows page 1, match on page 2 via offset=50) |
| F-018 poll-interval floor | `POLL_INTERVAL_FLOOR_MS = 50` (exported): intervals below the floor (0/negative/NaN) clamp to 50; absent interval keeps the 2000 default | `observeRefresh` | "pollIntervalMs below the floor is clamped" (setTimeout recorder; note: the client's own ~10s request-timeout timers ride the same global, so the pin is "no sleep below the floor" + "a 50ms sleep issued") |
| F-019 clock validation | Entry guard: `!Number.isFinite(nowMs(deps))` → typed `MemgateError("nightly-clock-invalid")`, remediation names the `deps.now` seam | `runNightlyConsolidate` first statement | "non-finite injected clock → typed nightly-clock-invalid", zero fetches |
| F-021 multi-model evidence | Preflight collects ALL triggered model ids; none → `MM_TRIGGER_ABSENT` with the models-seen list; evidence matches ANY triggered id; receipt names the matched model | `consolidateOneBank` step 1 + `observeRefresh(mentalModelIds)` | "multiple triggered models: the refresh fired for the SECOND model is matched" + case 7 now asserts the models-seen message |
| F-015 event status | `nightly-bank-failed` always carries `status: "error"`; `nightly-complete` carries `status: "error"` iff failures exist (fields override the entry default) | `emit` call sites | case 9 (failed events) + case 1 (green complete stays "ok") + budget tests |
| F-005 header reword | Coalescing claim now docs-grounded: `deduplicated:true` = server reused a PENDING consolidation (operations.md:65); once processing, next submit is a NEW slot, so the shared drain + its refresh lands AFTER the re-fire's completion timestamp; live-round caveat NAMED in the header; honest stale-op failure pinned | module header + test | "deduplicated:true whose only refresh op is STALE → REFRESH_EVIDENCE_MISSING, ok:false" |
| F-007 wall-clock budget | `export const NIGHTLY_WALL_CLOCK_BUDGET_MS = 900_000`; job deadline = start + `deps.wallClockBudgetMs ?? NIGHTLY_WALL_CLOCK_BUDGET_MS`; per-bank evidence window = min(evidence deadline, wall deadline); a bank starting after the deadline → `NIGHTLY_BUDGET_EXHAUSTED` naming the const | entry + bank loop | zero-budget test (both banks exhausted, zero fetches) + stepped-clock test (bank 1 receipts, bank 2 exhausted) + exported-const pin |
| F-028 graph fence | In-source forbidden-symbol scan restricted to `OWNED_FILES` (the two story files); import-SPECIFIER scan kept over the full transitive closure — rationale commented at the fixture | test case 15 | existing case 15 still asserts the walk traverses (seen.size > 2) and zero violations |
| F-016 cousin check | No `toBeDefined()` tautologies in this file (grep: zero hits); ops-poll sequence fake reads-then-advances (`q.shift()` returns the front element — first poll sees entry 0), no pre-increment bug | test fixture line 252 | n/a — verified clean |

## Behavior-change flags (integration notes for reviewers)

1. **Terminal-status gate (F-006)**: a refresh op observed as `pending`/`processing` no longer passes as evidence; `cancelled` now fails the bank (`REFRESH_FAILED`). A poll stuck on a non-terminal row to the budget → `REFRESH_EVIDENCE_MISSING` (unchanged code, stricter semantics).
2. **Dedupe (F-008)**: duplicate `deps.banks` no longer produce a guaranteed false failure; a new event type `nightly-banks-deduped` exists.
3. **Poll-interval floor (F-018)**: callers passing `pollIntervalMs` below 50 now poll at 50ms minimum. The rig's `pollIntervalMs: 1` therefore clamps to 50, so `EVIDENCE_BUDGET_MS` was retuned 40 → 60 tick-ms (comment in the fixture explains the arithmetic; missing-evidence cases now run 3–4 polls ≈ 150ms real).
4. **Wall-clock budget (F-007)**: the job now has a 15-minute default overall deadline; a slow instance can produce `NIGHTLY_BUDGET_EXHAUSTED` failure rows where it previously would have run unbounded.
5. **Schema-tighten fixture fallout (fx3)**: every consolidate stub body already carried `operation_id`; no fixture changes were required. The job's local `MemgateClientWithEvidence` interface gained `offset?: number` to match fx3's `listOperations` opts.
6. **MM_TRIGGER_ABSENT message (F-021)** now lists the models seen — message-text change only.

## Blocked-on-fx4

None remaining — fx4 landed `scripts/memory-nightly.ts` while this fix round ran, and the CLI pins were integrated against the landed code:

- case 19: pins `COLLECTIVE_SLUG_REFUSED` + "no provisioning circle" remediation (the landed remediation *explains* the circle rather than creating one — the task's `not.toContain("provision-hindsight-banks")` was replaced by the landed rationale phrasing per the "match reality" rule).
- case 20: fx4 put the unknown-flag gate in the script's `import.meta.main` block (core `argv` is documented ignored), so the pin is a spawned `bun scripts/memory-nightly.ts --dry-run` subprocess → exit 2 + "unknown flag: --dry-run" + "usage:".
- case 21: pins exit 1 + `BANK_LIST_UNREACHABLE` + `HINDSIGHT_BASE_URL` remediation on a 500 listBanks — passes against the landed code.

## Suite / tsc / biome

```
bun test tests/hindsight/nightly-consolidate.test.ts
  → exit 0, Ran 33 tests across 1 file, 33 pass, 0 fail (~0.9s)
bunx tsc --noEmit
  → 0 errors
bunx @biomejs/biome check src/hindsight/nightly-consolidate.ts tests/hindsight/nightly-consolidate.test.ts
  → Checked 2 files in 22ms. No fixes applied.
```

Per check discipline: no full suite run, no commit.
