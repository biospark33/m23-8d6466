# Adversarial Review Findings — QDS-Factory v4 (Phase 0 + Phase 1) — 2026-06-06

**Status:** Iteration 1 complete. **NOT converged** (corpus ≈27 HIGH / ~40 MED; convergence = HIGH==0 AND MED≤3).
**Corrections deferred** per operator (plan change pending). This file preserves the full finding set so fixes can be applied later.
**Method:** 6 parallel adversarial reviewers (5 story clusters + 1 cross-story consistency hunter), domain checklists loaded: auth, secrets, migration, input.

> Many findings are real and load-bearing; many "unverified contract" findings are honest gaps the writers were told to flag but instead asserted as binary. Triage before applying.

---

## Themes (cross-cutting)

**A. Invented / unverified contracts asserted as binary make-or-break facts**
- P0.3: model id `anthropic/claude-opus-4` is not a valid pinned id → parameterize `<anthropic-judgment-model>`, resolve+pin at run (real Opus id family `claude-opus-4-*`).
- P1.1: `GET /api/me` self-lookup endpoint not in ground truth → bind make-or-break to a verified agent-scoped read (e.g. `costs.ts` route) + direct `agents`-row query.
- P1.4: `workflow-registry.ts` registration invented → Archon registers via YAML drop-in `.archon/workflows/defaults/` + `POST /api/workflows/{name}/run`.
- P1.4 / P1.8: `__dashboard__` SSE is a GLOBAL stream; per-event issue-id correlation + `Last-Event-ID` reconnect invented → correlate via run id ↔ `issues.executionRunId` (r3 hop 2); weaken/replace reconnect AC; define run-completion as terminal run-status, not SSE EOF.
- P1.5: writes `routerSelection` into `heartbeat_runs.usageJson` — but selection runs PRE-execution (row may not exist) and `usageJson` is the cost-estimate field → disambiguate Archon runId vs heartbeat_runs.id; persist rationale on a proper record/field (NFR-OBS-6a).
- P1.11: Hindsight recall body fields (`budget:"mid"`, `max_tokens`) + "RRF + cross-encoder 4-strategy fusion" invented → strip fusion claim; mark request bodies UNVERIFIED + add Phase-0 confirm AC (OQ-4 unproven).
- P1.13: asserts existing `cost-summary` endpoint computes the `parentId` SUBTREE sum — unverified (r3 describes subtree as a query pattern) → assert against the story's own `issue-tree-cost.ts` helper, not the endpoint behavior.
- P1.14: reads `activity_log` (absent from r3 verified schema) + `wall_clock_ms`/`retry_count` (unenumerated `heartbeat_runs` cols) → derive `first_pass_accept` from `issues.status`; map to `processLossRetryCount`/`retryOfRunId` + `finishedAt-startedAt`.
- P0.10: `gitnexus_context`/`gitnexus_impact` result field names (`nodes`/`affected`/`blastRadius`) invented → mark story-defined wrapper types + add a shape-confirm subtask.
- **P1.15/P1.18/P1.19 + r4:** r4 has NO GitHub integration section, yet these assert `gh pr create/view`, `/repos/.../comments`, combined-status, `resolveReviewThread`, and CodeRabbit/Gemini bot logins as ground truth → add a GitHub-contract row to r4 (endpoints, token/scope, exact bot logins, whether bots post a commit-status context) OR flag UNVERIFIED + add Phase-0 live-confirm ACs. **P1.19 GREEN semantics likely wrong**: CodeRabbit/Gemini post review threads, not commit statuses → redefine GREEN = (thread resolved/outdated) + (CI checks success), not a bot commit-status.

**B. Broken e2e split — P1.6 / P1.7 (the headline structural defect)**
- P1.6 (implement node) and P1.7 (post-edit LSP gate) co-own the launcher lead-emit/stdout surface, use DIVERGENT file maps (P1.6 `scripts/pi-team/*.ts`; P1.7 `scripts/lib/*.sh`) and even disagree on launcher language (TS vs bash). P1.6 collects `changed_files` for a consumer only P1.7 builds; P1.7 rewrites P1.6's "wiring-closed" emit step.
- Also P0.3/P1.6/P1.7 fragment the launcher file map; merged-output schema defined twice.
- **FIX (recommended):** one authoritative `pi-team-launch.sh` file map across P0.3/P1.6/P1.7. P0.3 = spawn/kill + hard-guard skeleton. P1.6 = lead-merge + cost-emit + capture structured result (`changed_files` is part of P1.6's own result manifest → not dangling). P1.7 = additively inserts the diagnostics gate BEFORE emit, explicitly "extends P1.6's emit", declared dependency. Each story's wiring-closed scoped to its own increment (P1.6: "captures structured result"; P1.7: "no emit over dirty diagnostics").

**C. Decorative / wrong dependency edges**
- P0.1→P0.3: standalone shell launcher needs no env patch → drop the edge OR run the demo via a DAG bash node so the P0.1 dep is real.
- P0.5→P0.6: different pi-lens tools (TDI/warning vs diagnostics/nav), no shared code → drop edge or cite the shared symbol; designate P0.5 as sole pi-lens-install + OQ-2-verdict owner.
- **P1.3 ↔ P0.9 (HIGH producer gap):** P0.9 does NOT produce `.seeds/issues.jsonl` (P1.3 self-produces it via `sd create`/`sd dep`). FR-MEM-4 decomposition has no Phase-0 producer → relabel the edge "provides pinned `sd 0.2.5` binary only"; move FR-MEM-4 `.seeds/issues.jsonl` creation explicitly into P1.3 scope; correct r5.
- **P1.4 ↔ P1.15 (HIGH double-authority):** P1.4 enumerates 14 nodes incl. `finalize`+`retain-learnings`; P1.15 says it "gains the `finalize` node" (13→14) → reconcile: P1.4 authors `finalize`/`retain-learnings` as placeholder structural nodes; P1.15 fills `finalize` body (and must say so, not claim P1.4 wiring-closed on a stub). Fix the 13-vs-14 node-count narrative.
- Node-name anchors: P1.7 ↔ P1.4 node 8 `diagnostics-gate`; P1.10 ↔ P1.4 node 12 `approval-gate` — add the node id as the anchor in P1.7/P1.10 Technical Notes.

**D. Security correctness**
- P0.7 (HIGH×2): admin-gate + bearer-401 ACs asserted against the live `local_trusted / no-auth` instance (r3 §A) → reconcile (downgrade to code-level/unit assertion OR document enforcement on `localhost:3100`). Tenant binding: `:companyId` is a path param with no session cross-check → add "tenant server-derived; reject `:companyId` mismatch vs `agent_api_keys`-bound company".
- **P1.10 (HIGH, genuine hole):** inline-button callback trusts `decidedByUserId`/`decision` from the webhook payload → add invariant: verify callback authenticity (Telegram secret-token / bot-token HMAC) AND server-derive the approver from the verified sender against an authorized-approver allowlist; never trust payload body.
- P0.8 (HIGH×2): make-or-break unreachable in BLOCKED-on-creds reality (no live chat) + assumes a paused `executionPolicy` gate no P0 story creates → make binary = decision-log completeness (4 rows, none `unknown`, `blocked` is a passing terminal), decouple from non-zero exit; seed a paused-gate issue inside the story.

**E. Gate-story correctness**
- **P0.11 (HIGH×3, structurally un-passable as written):** the aggregate `oq-decision-log.json` the gate reads is never assembled — no story writes OQ-1/2/5/6 into one keyed file; OQ-3/OQ-4 live in different files/formats → designate one canonical `oq-decision-log.json` + add a DoD box to each producing story (P0.1/P0.2/P0.5/P0.6/P0.8/P0.9) to write its OQ entry. OQ provenance mis-mapped (AC-11 "P0.8 + this gate"); §13.1 `satisfiedBy` says P0.2 but the merged-JSON launcher is P0.3 → fix per-OQ owners (OQ-1/5→P0.2, OQ-2→P0.5/6, OQ-3→P0.8, OQ-4→P0.9, OQ-6→P0.1) and §13.1→P0.3. Confirm no §13 clause lacks a producer (check FR-CP-10 event-subscribe).
- **P1.17 (HIGH):** AC-8/clause-8 under-verifies — tests only the `approvals`/`issue_execution_decisions` write, not "resumes the paused run to completion + reject halts cleanly" → strengthen AC-8 to assert terminal run status after approve AND clean halt on reject. AC-3: add reached-implement-node precondition (missing node = fail, not skip). Confirm SP 3 vs 4 (drives the full live flow).
- P1.16 (HIGH, pure-text): predecessor rationale for P1.11 and P1.13 is SWAPPED (P1.13 = cost_events/hop 5 + budget; P1.11 = Hindsight/hop 10) → relabel to match r5 + P1.17. MED: state the epic terminus is hop 7's `parentId` walk root (epic→Seeds is the same read, not a separate join).

**F. Make-or-break gated on UNVERIFIED/BLOCKED externals** (P1.5 Hindsight OQ-4, P1.6 live paid team + OQ-8 cost, P1.7 live lsp content, P1.10/P0.8 Telegram, P1.11 Hindsight) → demote the unproven external to a flagged confirm-AC; keep the binary make-or-break on the provable-today/local half of the slice. (The writer-brief required this honesty; several stories asserted the unproven path as the gate.)

**G. Smaller (MED/LOW)** — apply opportunistically:
- P0.1: hardcoded "150 tests pass" → "no new failures vs pinned-SHA baseline"; register `qds-env-probe.yaml` so `/run` resolves it; document Zod `Record<string,string>` intentionally narrower than `ProcessEnv`.
- P0.4: budget guard is per-turn-boundary (no proven mid-run cost signal; OpenRouter generationId unconfirmed); spend "≤ cap + one-turn overshoot tolerance"; rely on launcher internal tally not a `cost_events` SUM.
- P0.5: re-point SP 4→3; oversized `~/.pi-lens/` artifact parse cap + fixture; `qa-gate.ts` is the self-contained Phase-0 consumer (not a promise of a not-yet-built node).
- P0.6: ≤3s p95 scoped to post-warm (exclude one-time warm); make-or-break assert `navResolved !== null` before `defLine`.
- P0.9: Mulch import source is `boardlensai/.mulch` (qds-factory `.mulch` likely empty) → make non-empty-prime box conditional/point at real source; E2E URL use `/v1/default/banks/{bank}/...`; add negative bank-isolation probe; add redaction test; fix weak P0.7 edge rationale.
- P1.2: owns its own partial-unique index on `originKind='qds_intake'` (distinct predicate from P1.3's `seeds_story`); name length cap + rejection error shape; make-or-break runs over the Hermes-gateway path (only verifiable trigger today).
- P1.3: migration `0040` add rollback (`DROP INDEX IF EXISTS`) + real-Postgres up/down/up test + `CREATE INDEX CONCURRENTLY` note; partial-mirror self-heals on idempotent re-run.
- P1.9: migration `00xx` → concrete number after `0040` (e.g. `0041`); pin overflow threshold value+source; name wall-clock derivation cols; cite real `issue_execution_decisions` columns or narrow to `approvals`.
- P1.13: estimate flag maps to a real column (`billingType` enum), not an invented `estimated` boolean; reconcile "projected" vs current `tree_spend >= cap`.
- P1.18: pin exact bot login strings (`coderabbitai[bot]`, `gemini-code-assist[bot]`), exact-login match not substring; seen-set upsert strictly after successful wake.
- P1.19: add per-comment idempotency AC (one fix attempt per comment id per round, ≤8-retry cap); map combined-status `pending`-after-timeout → `transient`, `failure` → `logic`.
- Migration numbering spans two repos (`boardlensai/paperclip` `0039`/`0040` vs Hermes/factory) — state which repo each migration targets so counters don't collide.
- Template-drift LOWs: P1.11/P1.12 missing the AC-block instruction line.

---

## Per-cluster severity tally (iteration 1)

| Cluster | HIGH | MED | LOW |
|---|---|---|---|
| P0.1–P0.6 | 5 | 11 | 7 |
| P0.7–P0.11 | 9 | 9 | 6 |
| P1.1–P1.8 (incl. batch) | 6 | 15 | 9 |
| P1.9–P1.14 (incl. cross) | 5 | 7 | 7 |
| P1.15–P1.19 (incl. cross-cut) | 4 | 4 | 4 |
| Cross-story consistency | 2 | 4 | 2 |

## Clean / strong (no HIGH)
- **P1.12 (mulch-prime)** — cleanest story; LOWs only. Tenant isolation exemplary.
- **P1.3 authority-split** — no leak (deps only in Seeds, assign+cost only in Paperclip).
- **P1.4 node enumeration + env-bash node** — present and correct.
- **P1.5 GLM/Kimi-always-via-OpenRouter** — correct.
- **P1.13 cost-column discipline** (per-issue = `SUM(cost_events)`, no `issue.cost`) — correct.
- **P1.14 zero-extra-inference guarantee** (FR-LEARN-28/29) — correctly specified + tested.
- **P1.16 §8.4 10-join transcription** — exact, complete, zero invented hops.
- **P0.1 env-patch, P0.4 hard-guard, P0.11 fail-closed harness design** — structurally sound.

## Graph verdicts (cross-story hunter)
- **Dependency graph: ACYCLIC.** All 30 `depends-on` targets exist; edges point strictly backward in wave order.
- **All deps resolve: Y** — except the P1.3↔P0.9 case is a genuine producer gap (FR-MEM-4 `.seeds/issues.jsonl` has no Phase-0 producer), must be reassigned, not just relabeled.
- **SP/totals confirmed:** 30 stories, all 3–4 SP, Phase 0 = 37 pts, Phase 1 = 67 pts, **total 104 pts** (matches r5).
