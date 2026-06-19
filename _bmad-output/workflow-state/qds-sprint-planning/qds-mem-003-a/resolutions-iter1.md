# §H — Adversarial Resolutions (iteration 1) — APPLY to all P2 stories

> These are the cross-cutting architecture decisions that resolve the recurring HIGH/MEDIUM
> findings from the iteration-1 adversarial sweep. Every fixer agent applies the resolutions that
> touch its stories, PLUS the per-story findings handed to it. Edit story files IN PLACE.
> Keep each story ≤200 normative lines; Files-to-Modify ≤10; do not introduce ⛔/pending/TBD markers.

## R1 — `run_id` for non-DAG-run events (lifecycle + orphan capture) [INV-OM2 contradiction]
`events.run_id` is NOT NULL + FK `runs`. Events that have no live DAG run must still satisfy this.
**Decision:** synthesize a real `runs` row and reference it — never NULL, never drop.
- **Experiment lifecycle** (P2.9 propose+gate, P2.10 execute+deploy, P2.11 confirm): one lifecycle run per experiment, `run_id = "experiment:<experiment_id>"`, `dag_def_id="__experiment_lifecycle__"`, created at propose time. ALL transition/audit `events` (event_type `outcome`) FK to it. INV-OM2 holds.
- **Orphan capture** (P2.3/P2.5/P2.6 when an ExtensionAPI event fires with no active run context): synthesize `run_id = "orphan:<sessionId>"` + a matching `runs` row (`dag_def_id="__orphan__"`). The capture event is WRITTEN (never dropped, never null). Helper authored in P2.3, reused by P2.5/P2.6.
- **Update INV-OM2 wording** (in each story's Security Invariants): "non-null `run_id` referencing a real `runs` row; lifecycle events use `experiment:<id>` runs, orphan-context capture uses `orphan:<session>` runs — never NULL, never a silent drop."

## R2 — FK / CASCADE (GAP #2)
**Decision:** enforce `FOREIGN KEY(run_id) REFERENCES runs(run_id)` and `FOREIGN KEY(experiment_id) REFERENCES experiments(experiment_id)` on `events`. **No ON DELETE CASCADE** — retention (P2.12) deletes explicitly. `event_vec` (vec0 virtual) and `event_edges` are NOT FK-enforceable → P2.12 deletes their rows explicitly in the same transaction as the `events` delete. P2.1 DDL adds the FK clauses; P2.1 AC inserts an orphan row and asserts rejection.

## R3 — DDL-applier ownership (P2.1 ↔ P2.2 seam) [double-create + missing applier]
**Decision:** P2.1 owns schema CONTENT (authoritative DDL: tables, FK, the 9 events indexes + 3+2+2, `event_vec`, FTS5 table+triggers, `schema_meta`) — authored as the migration `.sql` files. P2.2 owns the runner MECHANISM + ledger + seeds, and its migration set INCLUDES the P2.1-authored DDL files: `0001_schema_meta`, `0002_events_runs_experiments_indexes`, `0003_event_edges_event_vec`, `0004_events_fts5_triggers`, `0005_seed_meta`. P2.1's embedded DDL blocks are labeled "spec-citation; applied at runtime SOLELY by P2.2's runner — P2.1 does not CREATE at runtime." P2.1 `schema_meta` block keeps no duplicate `CREATE` ownership claim.

## R4 — events index count (8→9)
The 9th events index is composite **`(run_id, created_at)`** backing the `reconstructRun` ordered scan (the <200ms make-or-break). Fix §C reference and P2.1 to name all 9 explicitly; P2.1 AC#2 asserts this composite exists; P2.12 perf depends on it.

## R5 — exact dependency pins (P2.0) [caret contradicts pin invariant]
P2.0 pins EXACT resolved versions in package.json + commits the lockfile. The research-context's `^3.8.1` denotes the upstream RANGE; the story pins the resolved value (e.g. `@huggingface/transformers` `3.8.1`, `better-sqlite3` `12.6.2`, `sqlite-vec` exact). `onnxruntime` is TRANSITIVE of transformers.js (not separately pinned — state this). Enumerate the real pinned set {sqlite-vec, @huggingface/transformers, better-sqlite3, cron-lib}; AC asserts each by exact string read from the lockfile, no `^`/`~`. STRIP gate greps the import specifier `@anthropic-ai/claude-agent-sdk` + `query(` call-shape across the whole tree (not just known paths); enumerate the 5 caller files. License gate asserts permissive (MIT/BSD/Apache-2.0 allowlist), not merely "recorded". Defer the cron-lib pin justification or drop from P2.0 if unused there.

## R6 — embedding scope (event_vec)
**Decision:** only `tool_call` (P2.3) and `message` (P2.5) events get an `event_vec` row. `node` (P2.4) and `outcome` (P2.6) events are NOT embedded (queried by index, not similarity). Document in P2.1 recall section ("KNN covers tool_call/message events only") and one line in each capture story.

## R7 — `maskAndCap` shared util
Canonical path **`src/capture/mask-and-cap.ts`**, export `maskAndCap`. P2.3 authors; P2.4/P2.5/P2.6 REUSE (fix P2.4 & P2.6 which cite the wrong `mask-util.ts`). Requirements:
- **Total (never throws):** circular-safe replacer + BigInt-safe; on serialization failure returns sentinel `{"_capture_error":"unserializable"}` (≤64KB). Capture handler never throws into the pi-mono event loop.
- **Masks BOTH** the stored payload AND the embed-input text (so secrets never reach `event_vec`). Mask surface = `payload_json`, `result_json`, AND `error`.
- **Order:** mask → then cap; cap reserves marker length so final bytes ≤ 65536 inclusive of the `…[truncated]` marker.
- **Pattern set** named concretely (key/secret/token/password k-v with delimiters `:`/`=`/`":"`, plus `sk-`/bearer/AKIA-style) driven from a `tests/capture/secret-corpus.json` fixture with positive+negative cases.

## R8 — `baseline_metrics_json` shape
`{ metric, baseline_value, n, window_start_ms, window_end_ms, computed_at_ms }`. P2.10 WRITES it (deploy test asserts it contains the chosen metric's value, not just non-null). P2.11 READS exactly this shape (cite "validated against P2.10 baseline shape"). Defined once here; both cite.

## R9 — deploy_ref revert source (P2.11) [no prior-value column]
Schema has a single `deploy_ref`. **Decision:** revert = redeploy the **control variant** (`experiments.variant_a_ref` is the control/baseline); P2.11 sets `deploy_ref` back to the control config. No new column. P2.10 deploys the winner; P2.11 rollback restores `variant_a_ref`. Document in both.

## R10 — `state-machine.ts` single source of truth
Authored COMPLETE in **P2.9** at `src/experiments/state-machine.ts`: the full §B.2 legal-transition table (all edges proposed→…→confirmed|rolled_back, +rejected) with PER-ENTRYPOINT guards (gate may only do proposed→approved|rejected; execute approved→running→analyzed; deploy analyzed→deployed; confirm deployed→confirming→confirmed|rolled_back). P2.10 and P2.11 REUSE it (P2.10 lists it in Files-to-Modify as reuse; P2.11 drops the parallel transition logic in `src/optimizer/experiment-store.ts` and imports the shared machine). P2.9's illegal-transition test scopes refusals to the GATE entrypoint, not global illegality of later edges. All transition events use `event_type='outcome'` (state explicitly in P2.10).

## R11 — P2.9 dependency edges
Predecessors = **P2.1** (the `experiments` table + recall/operational store the optimizer scans — hard data dep) **+ P2.8** (promotion/retain ordering). Fix the rationale: the optimizer reads the P2.1 operational store (`runs`/`events`), NOT Hindsight bank output.

## R12 — cron idempotency (P2.7 + P2.11)
Dedicated run-marker table (NOT `schema_meta`). Atomic acquire = single `INSERT ... ON CONFLICT(key) DO NOTHING`; the tick affecting 0 rows exits (closes TOCTOU). Completion-state ledger: a row with `finished_at IS NULL` (or `doc_path`/verdict null) = crashed → REPROCESS, never silently skip.
- **P2.7:** `promotion_runs` PRIMARY KEY on `date`; `skipped:true` markers terminal-by-design (documented); add a `retained_at` column P2.8 stamps (seam, see R14).
- **P2.11:** idempotency is **per-experiment** (status filter excludes already-terminal rows) + per-experiment `documentId` (R13), NOT per-day. The eligible scan ALSO picks up orphaned `confirming` rows (prior crash) → fail-safe `rolled_back` + revert. The whole `deployed→confirming→terminal` write is one transaction (so `confirming` is never durably stranded), OR the scan recovers it — pick the transaction form.

## R13 — P2.11 verdict documentId
`confirm-<experiment_id>` (NO date — the verdict is per-experiment, once). P2.7/P2.8 daily-doc documentId stays dated `daily-learnings-YYYY-MM-DD`.

## R14 — P2.8 retain bridge
- Per-bank `replace` is independently idempotent; on one-bank failure, surface the error AND rely on next run's `replace` to self-heal each bank. **Always push BOTH banks every run (even empty)** so `replace` clears a re-routed/now-empty bank's stale prior entry. Reword the "partial documentId" AC to what's actually guarded.
- Tag VALUES validated against the closed §6.2 vocabulary via `z.enum([...])` (at least `knowledge_type`, `severity`, `outcome`, `quality_dim`), not open `z.record(string,string)`.
- Routing: a section matching MULTIPLE classes routes by §6.2 precedence; a section matching NONE is flagged/defaulted, **never silently dropped**.
- P2.8 RE-SCANS the doc for secrets (defense-in-depth) — does not merely trust P2.7's mask (INV-OM3 = "re-scan, not re-trust").
- Add a passthrough test that the P1.11 client actually forwards `documentId`+`updateMode` to MCP (the whole idempotency delegates to it).
- Stamp `promotion_runs.retained_at` on success (R12 seam): a doc-written-but-not-retained date is detectable & replayable.

## R15 — P2.12 replay + retention
- Rename "reversible window" → **"retention floor / grace window"** everywhere; drop false "reversible" language (deletion is hard DELETE). INV-RPL2 reworded.
- `runRetention()` deletes `events` + matching `event_vec` + `event_edges` rows in ONE transaction (no orphan vectors/edges — they don't cascade). AC asserts zero orphans remain.
- Decay predicate EXCLUDES events whose `run_id` has `runs.status='running'` (no in-flight deletion). AC for "running run with old events → none deleted."
- Safety: max-rows-per-run cap + a `dryRun` mode returning would-delete count (refuse if >N% without force).
- Replay strictly READ-ONLY; observability metrics (`lastReplayMs`/`lastDecayAt`) persist to a dedicated metrics row, NOT event tables; INV-RPL1 checksum scoped to event tables.
- Tree reconstruction handles dangling parent (parent decayed) gracefully; cycle-guard with stated threat model (DB corruption / future writers).
- Perf: assert <200ms at N≥1000 events warm-cache, depends on the R4 `(run_id,created_at)` index.

## R16 — capture correctness (P2.3/P2.5)
- **P2.3:** buffer `tool_execution_start` `args`+start-ts keyed by `toolCallId`; join on `tool_execution_end` to populate `payload_json` (from args+result) and `duration_ms`. (`tool_execution_end` carries only `{toolCallId,toolName,result,isError}` — no args/duration.) parent_event_id = the enclosing turn/node event for the current `turnIndex` (NOT "most recent open").
- **P2.5:** turn-buffer state machine: accumulate `message_update` text by `turnIndex`; `turn_end` flushes+clears (ONE `message` row); `agent_end` flushes ONLY if buffer non-empty (interrupted turn) else no-op. AC binary on both arms. Add a p99 latency bound to P2.5 AC#1 (consistent with the canonical-pattern claim). Define `messageText` extraction from `TurnEndEvent.message` precisely; state `toolResults` intentionally not captured here (owned by P2.3).
- Both: model pipeline warm-loaded from `env.localModelPath` BEFORE the network mock installs (so the make-or-break egress test is deterministic). Cite ExtensionAPI events by file+SYMBOL, drop fabricated `types.ts` line numbers. Add P2.3 to P2.5's predecessor edges (reuses P2.3 utils).

## R17 — P2.4 DAG-node capture
- Node identity: PHASE events keyed by `phaseId`, STEP events by `stepId`, fallback `id` only for node-less types — ONE node per phase/step (started/completed are transitions on it). Fix `dag_node_id` derivation + make-or-break AC.
- ROOT node → `parent_event_id = NULL`; tree contract exempts exactly one root (AC "single connected tree with exactly one root").
- Handoff edges resolved TWO-PASS (ingest all node events, then resolve `event_edges` by `taskId`); AC for "edge target not-yet-seen." INV-DAG1 enforced at write time (verify both endpoints' run_id match — schema can't).
- `ingestProtocolRunEvents` returns `{written, skipped, edges}` (not void) so skip-counting is observable/testable.
- Header scoped: "**BLOCKED-BY SPIKE-10 for live tap + E2E; ships interface + unit tests first**" (mirror P2.10, match §B.4 "E2E of P2.10"). INV-OM1 tap-agnostic (don't pre-commit the spike's choice). Rename final DoD box "Test (integration demo over fixtures — MANDATORY; live-source E2E binds post-SPIKE-10)."

## R18 — P2.7 promotion cron
- Secret-mask runs on the FINAL rendered doc (JSON summaries + prose) AFTER LLM generation, covering `error` and all unmasked surfaces; pipeline order `summarize → render → MASK → CAP/truncate → validate`; cap measured on post-mask bytes. Unit test: secret only in `error` field, paraphrased by stubbed summarizer, asserted absent.
- Dedup key defined deterministically (cosine over the existing 384-dim `event_vec` ≥ threshold T, or normalized payload hash) so AC2 is testable.
- Truncation reserves marker length (≤cap inclusive). Cron-lib smoke-check box ("fires once off-peak under Bun"). Typed handoff to P2.8: P2.8 reads the artifact at `doc_path` and re-validates against `DailyLearningsDoc`.

## P2.0 minor (from AR-A MEDIUM/LOW)
Reconcile the three names (title/filename/§F) to one canonical short name in the epic summary; P0.7 gate either a checked box or explicitly process-level; note vendored tree + model dir as created artifacts.
