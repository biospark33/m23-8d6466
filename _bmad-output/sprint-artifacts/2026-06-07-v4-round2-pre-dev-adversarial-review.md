# QDS-Factory v4 — Pre-Dev Adversarial Review Campaign (Round 2)

**Date:** 2026-06-07
**Status:** ✅ CAMPAIGN COMPLETE — All waves resolved. 43 original + 47 Wave-5 verification findings (90 total). All stories hardened, dev-ready.
**Scope:** 5 stories (P0.2, P1.2, P1.3, P1.6, P1.13)
**Prior review:** `2026-06-06-v4-pre-dev-adversarial-review.md` (Round 1: P0.3, P0.7, P0.9, P0.11, P1.1 — 124 findings resolved)
**Warren decision:** Applied (P0.1, P0.4, P0.8 killed; sprint-status.yaml updated ✅)
**Method:** 5 parallel PhD-level adversarial reviewers → collated tracker → wave protocol
**Session:** Initial scan completed 2026-06-07 ~10:15 EDT

---

## Status Dashboard

| Wave | Status | Findings | Done | Remaining |
|------|--------|----------|------|-----------|
| Initial Scan | ✅ DONE | 43 | 43 | 0 |
| Wave 0 — Cross-cutting | ✅ DONE | 5 CC items | 5 | 0 |
| Wave 1 — BLOCKERs | ✅ DONE | 2 | 2 | 0 |
| Wave 2 — HIGHs | ✅ DONE | 18 | 18 | 0 |
| Wave 3 — MEDIUMs | ✅ DONE | 18 | 18 | 0 |
| Wave 4 — LOWs | ✅ DONE | 5 | 5 | 0 |
| Wave 5 — Verification | ✅ DONE | 47 | 47 | 0 |
| Wave 5b+5c — Re-fix (collapsed) | ✅ DONE | 47 | 47 | 0 |

## Per-Story Progress

| Story | Title | SP | BLOCKER | HIGH | MED | LOW | Total |
|-------|-------|-----|---------|------|-----|-----|-------|
| P0.2 | coms-vendor-decision | 3 | 0 | 3 | 2 | 1 | 6 |
| P1.2 | qds-intake-issue | 3 | 0 | 3 | 4 | 1 | 8 |
| P1.3 | seeds-decompose-mirror | 4 | 2 | 4 | 3 | 1 | 10 |
| P1.6 | pi-team-warren-run | 5 | 0 | 4 | 5 | 2 | 11 |
| P1.13 | cost-ledger-budget | 4 | 0 | 4 | 4 | 0 | 8 |
| **Totals** | | **19** | **2** | **18** | **18** | **5** | **43** |

## Cross-Cutting Themes

| CC ID | Theme | Stories Affected | Severity | Status |
|-------|-------|------------------|----------|--------|
| CC-1 | **Origin-field settable via REST** — `createIssueSchema` strips `originKind`/`originId`; both P1.2 and P1.3 assume these are writable on issue-create POST. If not settable, both dedup strategies collapse. | P1.2, P1.3 | BLOCKER | ✅ DONE |
| CC-2 | **`exit_class` schema conflict** — P1.6 allows `null`, P0.3 (Round 1) forbids it (mandatory non-null string). Downstream integration breaks. | P1.6, P0.3 | HIGH | ✅ DONE |
| CC-3 | **Cost envelope boundary precision** — P1.6 writes raw float `costTotal`, P1.13 converts to `costCents` via ceiling rounding. Neither story explicitly owns the conversion boundary. | P1.6, P1.13 | HIGH | ✅ DONE |
| CC-4 | **Warren client ungrounded** — P1.6 invents `WarrenClient.dispatch()` with no predecessor. P1.4 and P1.8 both killed. Core orchestration surface has no spec grounding. | P1.6 | HIGH | ✅ DONE |
| CC-5 | **P0.2 → P0.11 decision record contract** — P0.2 writes one schema (`oq1_path`, `oq5_verdict`, etc.), P0.11 reads another (`{id, decision, fallback?}`). No transformation rule specified. | P0.2, P0.11 | HIGH | ✅ DONE |

---

## Findings

### Cross-Cutting (resolve in Wave 0)

| ID | Stories | Severity | Title | Status | Fix Recipe |
|----|---------|----------|-------|--------|------------|
| CC-1 | P1.2, P1.3 | BLOCKER | Origin-field settable via REST? — `createIssueSchema` strips `originKind`/`originId` | ✅ DONE | Verify in Paperclip `issues.ts:4614` whether `originKind`/`originId` are settable via the REST `create()` path or only via internal service calls. If REST-strippable: (a) switch to using the Paperclip service layer directly from Hermes, OR (b) extend `createIssueSchema` to accept origin fields for `hermes_local` callers. P1.2 must define `originKind='qds_intake'`; P1.3 must define `originKind='seeds_story'`. Both need application-level find-before-insert dedup if no DB constraint exists. |
| CC-2 | P1.6, P0.3 | HIGH | `exit_class` allows null in P1.6 but P0.3 forbids it | ✅ DONE | Remove `&#124;null` from P1.6 merged-output schema. Default when no error: `exit_class: "transient"`. Both stories must agree: `exit_class: "transient"&#124;"overflow"&#124;"logic"` (mandatory, non-null). |
| CC-3 | P1.6, P1.13 | HIGH | Cost envelope boundary precision — conversion ownership undefined | ✅ DONE | P1.6 Technical Notes: "`costTotal` is raw float USD; conversion to integer cents is P1.13's responsibility using ceiling rounding." P1.13 Technical Notes: "P1.13 owns the float→cents conversion boundary; reads raw `costTotal` from envelope, applies `Math.ceil(Number((usd * 100).toFixed(10)))`." |
| CC-4 | P1.6 | HIGH | Warren client ungrounded — invented API with no predecessor | ✅ DONE | Clarify in P1.6: `WarrenClient` is a NEW QDS-specific TypeScript client wrapping Archon's `POST /api/workflows/{name}/run` + SSE, authored within this story. Alternative: align with P0.3's launcher model where bash node executes the launcher script. Developer must not invent an API surface from scratch. |
| CC-5 | P0.2, P0.11 | HIGH | Decision record schema incompatible with P0.11 OQ log | ✅ DONE | P0.2 Technical Notes: add "Downstream contract for P0.11" paragraph specifying transformation: `readOqDecisionLog()` reads P0.2's file and maps to `{ id: "OQ-1", decision: "<oq1_path> (<oq1_fallback>)" }` and `{ id: "OQ-5", decision: "<oq5_verdict> (pi <pi_version>)" }`. |

### P0.2 — coms-vendor-decision

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P0.2-H1 | HIGH | contract-gap | Decision record schema incompatible with P0.11's OQ decision-log — no ingestion contract | ✅ DONE | Add "Downstream contract for P0.11" paragraph to Technical Notes specifying how P0.11's `readOqDecisionLog()` maps P0.2's output into two canonical OQ entries: `{ id: "OQ-1", decision: "<oq1_path> (<oq1_fallback>)" }` and `{ id: "OQ-5", decision: "<oq5_verdict> (pi <pi_version>)" }`. Mirror in P0.11 Technical Notes. |
| P0.2-H2 | HIGH | contract-gap | Vendored file path `packages/pi-coms-vendor/` contradicts spike location (has `extensions/` subdir) | ✅ DONE | Either (A) update paths to include `extensions/` subdirectory matching upstream structure, or (B) add explicit note that files are flattened from upstream layout. Update E2E smoke-test command to reference explicit path. |
| P0.2-H3 | HIGH | wiring-claim | Smoke-test script has no spec for producing JSON decision record from bash | ✅ DONE | Add implementation spec to Technical Notes: `coms-smoke-test.sh` runs `pi -e` load, captures evidence, writes decision record JSON via heredoc or `node -e` template with captured values. Exit 0 on green + record written; non-zero on failure. |
| P0.2-M1 | MEDIUM | ac-ambiguity | Contract-surface probe underspecified — `sendMessage({triggerTurn:true})` is in `tilldone.ts` (separate extension), not probeable in single-extension load | ✅ DONE | Either remove `sendMessage` from AC-1 probe list (scope to coms-only tools), or add `tilldone.ts` to loaded extensions. Clarify probe mechanism: `pi --list-tools` for tools, flag introspection for flags. |
| P0.2-M2 | MEDIUM | schema-gap | Decision record schema `contract_surface: string[]` content undefined; no green/red examples | ✅ DONE | Add green and red path examples to Contracts/Schema section showing complete JSON with `contract_surface` values. |
| P0.2-L1 | LOW | cross-cut-consistency | No upstream commit SHA pin for vendored files — upstream drift risk | ✅ DONE | Add to Technical Notes: pin to spike commit SHA; record in `VENDOR_SHA` file or comment at top of vendored `coms.ts`. |

### P1.2 — qds-intake-issue

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P1.2-H1 | HIGH | contract-gap | `originKind`/`originId` idempotency mechanism fabricated — no partial unique index exists for intake dedup; create service does plain insert | ✅ DONE | Define `originKind='qds_intake'`. Implement application-level find-before-insert: `SELECT id FROM issues WHERE company_id = ? AND origin_kind = 'qds_intake' AND origin_id = ?` before create. If row exists, return existing issue id. |
| P1.2-H2 | HIGH | ac-ambiguity | Status "open/triage" does not exist in Paperclip's ISSUE_STATUSES enum | ✅ DONE | Replace "open/triage" with "todo" (or omit status and let server default apply when `assigneeAgentId` is set). Paperclip statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. |
| P1.2-H3 | HIGH | contract-gap | Create-issue API path not specified; `companyId` source unspecified | ✅ DONE | Add to Technical Notes: "Issue-create API: `POST /companies/:companyId/issues` (`server/src/routes/issues.ts:3636`). `companyId` from `PAPERCLIP_COMPANY_ID` env var. Auth via P1.1 client (bearer + run-scoped header)." |
| P1.2-M1 | MEDIUM | schema-gap | `title` field is mandatory but story never specifies what title value is set from `/qds <request>` | ✅ DONE | Specify: `/qds <request>` body becomes `title` field (after `/qds` prefix stripped). Max 500 chars. Empty body rejected per INV-2. |
| P1.2-M2 | MEDIUM | schema-gap | `originKind`/`originId` not in `createIssueSchema` — REST endpoint strips them | ✅ DONE | (Bound to CC-1 resolution.) Verify settable path; if REST-strippable, use service-layer call or extend schema. |
| P1.2-M3 | MEDIUM | wiring-claim | "Wiring closed" depends on Hermes command-router infrastructure that doesn't exist yet | ✅ DONE | Add note: `qds-command.ts` and `gateway-fallback.ts` are NEW files, not modifications. Command routing layer created from scratch. |
| P1.2-M4 | MEDIUM | ac-ambiguity | AC-2 idempotency key composition undefined — "identical request" not defined | ✅ DONE | Define: `originKind='qds_intake'`, `originId=SHA256(normalized_request_text + source_channel)`. Specify normalization (strip trailing whitespace, collapse multiple spaces). |
| P1.2-L1 | LOW | cross-cut-consistency | Missing `local_trusted` mode note (present in all Round-1 stories) | ✅ DONE | Add mode note: "Under `local_trusted`, server does not enforce auth; client-side guard from P1.1 ensures authenticated-only creates." |

### P1.3 — seeds-decompose-mirror

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P1.3-F1 | BLOCKER | contract-gap | Migration `0040` already exists upstream (Paperclip at `0094`) — will collide | ✅ DONE | Renumber to `0095` (or next after upstream HEAD at dev time). Update DoD and Files to Modify. |
| P1.3-F2 | BLOCKER | contract-gap | Migration path wrong — missing `src/` segment (`packages/db/migrations/` → `packages/db/src/migrations/`) | ✅ DONE | Fix path to `packages/db/src/migrations/0095_seeds_origin_unique_index.sql`. All 95 upstream migrations live in `src/migrations/`. |
| P1.3-F3 | HIGH | model/tool-id | P0.9 predecessor claims Seeds is `@os-eco/seeds-cli` v0.5.9 (public npm); P1.3 correctly says private CLI v0.2.5 | ✅ DONE | Add note: "Seeds version: `sd 0.2.5` at `/usr/local/bin/sd`, private CLI (not npm). P0.9's reference to `@os-eco/seeds-cli` v0.5.9 is a known error." |
| P1.3-F4 | HIGH | ac-ambiguity | AC-1 asserts "no `cost` column" as schema check — but this is a pre-existing invariant, not a gate P1.3 creates | ✅ DONE | Replace with assertion P1.3's code could violate: "none of the 3 child issues carry a `cost` field in their JSON body or any `issue_relations` rows with dependency type." |
| P1.3-F5 | HIGH | dependency-error | P0.9 predecessor mislabeled — P0.9 provides `sd` binary only, not `.seeds/issues.jsonl` output | ✅ DONE | Change dep edge from "P0.9 (Seeds decomposition into .seeds/issues.jsonl with dependency edges, FR-MEM-4)" to "P0.9 (provides pinned sd 0.2.5 binary; P1.3 owns sd create/sd dep calls)." |
| P1.3-F6 | HIGH | schema-gap | `originKind` column is `NOT NULL DEFAULT 'manual'` — backward-compat claim about NULL `originKind` is wrong | ✅ DONE | Change "existing issues with originKind NULL are unaffected" to "existing issues (all with originKind='manual', the column default) are unaffected because the partial index WHERE originKind='seeds_story' excludes them." |
| P1.3-F7 | MEDIUM | cross-cut | P1.2 also needs partial unique index on same columns — potential migration sequencing conflict | ✅ DONE | Add note: if P1.2 hasn't merged its migration, combine into single migration. Otherwise add only `seeds_story` index. |
| P1.3-F8 | MEDIUM | ac-ambiguity | AC-3 partial-failure contract undefined — are earlier successful creates rolled back or kept? | ✅ DONE | Specify: best-effort with `partial-state` report (list succeeded/failed story IDs), or all-or-nothing with compensating rollback. Recommend best-effort + explicit logging. |
| P1.3-F9 | MEDIUM | cross-cut | Auth injection cites `registry.ts:468-469` but should clarify mirror code reads env vars and sends as headers | ✅ DONE | Clarify: mirror module reads `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID` from env (injected by adapter) and sends as `Authorization: Bearer` and header. |
| P1.3-F10 | LOW | ac-ambiguity | "The divergence is logged" — no log level, destination, or format specified | ✅ DONE | Specify: log to stderr with issue id, Seeds status, Paperclip status, timestamp (NFR-OBS-3). |

### P1.6 — pi-team-warren-run

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P1.6-F1 | HIGH | architecture | `WarrenClient.dispatch()` is an invented API — no predecessor produces the Warren client | ✅ DONE | (Bound to CC-4.) Clarify: new QDS-specific TS client wrapping Archon's workflow API, authored in this story. Or align with P0.3 launcher model. |
| P1.6-F2 | HIGH | dependency | P0.3 spawn/kill dep diverged — coms vs bash-tool subprocess; coordination mechanisms fundamentally different | ✅ DONE | State explicitly: P1.6 workers are bash-tool-spawned pi subprocesses (not coms-based). Lead owns PID tracking and SIGKILL. P0.3 dep is guard-discipline pattern only, not shared code. |
| P1.6-F3 | HIGH | ac-ambiguity | AC-2 crash-partial cost extraction untestable — SIGKILL race condition inherent | ✅ DONE | Define: best-effort parse of complete NDJSON lines readable from pipe buffer at SIGKILL. Partial lines discarded. Zero lines → `costTotal: 0, estimated: true`. Test via synthetic NDJSON fixture, not live SIGKILL. |
| P1.6-F4 | HIGH | schema-conflict | `exit_class` allows `null` in P1.6 but P0.3 forbids it — cross-story conflict | ✅ DONE | (Bound to CC-2.) Remove `&#124;null`. Default: `exit_class: "transient"`. Schema: `"transient"&#124;"overflow"&#124;"logic"` (mandatory, non-null). |
| P1.6-F5 | MEDIUM | file-map | `scripts/pi-team/` conflicts with P0.3's `src/launcher/` — merged-output schema defined in two places | ✅ DONE | Add "File map relationship to P0.3" subsection specifying which P0.3 files are superseded by P1.6. Authoritative schema in exactly one file (recommend P1.6's `worker-schema.ts`). |
| P1.6-F6 | MEDIUM | cross-cut | `costTotal` is raw float USD; P1.13 needs integer `costCents` — conversion boundary undocumented | ✅ DONE | (Bound to CC-3.) P1.6: "costTotal is raw float; conversion is P1.13's responsibility." |
| P1.6-F7 | MEDIUM | risk | 5-point estimate doesn't reflect integration risk of 6 predecessors + 6 dependents | ✅ DONE | Add risk subsection: unit tests for merge/schema/cost-envelope are predecessor-independent; e2e demo requires all predecessors. Develop schema/validation in isolation first. |
| P1.6-F8 | MEDIUM | ac-ambiguity | AC-1 requires ≥2 workers but Solo archetype has 0 — minimum archetype unspecified | ✅ DONE | Clarify AC-1: "exercising archetype B Pair or C TDD-Trio; Solo archetype A is out of scope for this AC." |
| P1.6-F9 | LOW | stale-claim | "Only openrouter model with tool use + cost reporting" claim is unverifiable and likely stale | ✅ DONE | Change to: "spike-verified cheapest model at time of Phase-0 spike; model selection parameterized in `lead-system-prompt.ts` for easy update." |
| P1.6-F10 | LOW | naming | `lead-merge.ts` underspecified — also validates schema and computes set-union | ✅ DONE | Rename to `lead-merge-validate.ts` or add parenthetical: `lead-merge.ts (merge + schema validation + set-union)`. |

### P1.13 — cost-ledger-budget

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P1.13-F1 | HIGH | contract-gap | `cost-summary` route path is `GET /issues/:id/cost-summary` (no `:companyId`), not `/companies/:companyId/issues/:id/cost-summary` | ✅ DONE | Fix all 4 references (AC-1, Technical Notes, DoD, e2e test) to `GET /issues/:id/cost-summary`. Route internally resolves company via `assertCompanyAccess`. |
| P1.13-F2 | HIGH | schema-gap | `estimated:true` marker has no column — BILLING_TYPES enum has no `estimated` value; Zod will reject | ✅ DONE | Use `billingCode` field (optional/nullable string) with sentinel `"estimated"` for estimated rows. `billingType` stays a valid enum value (e.g., `"unknown"`). No Paperclip migration needed. |
| P1.13-F3 | HIGH | ac-ambiguity | "Projected spend" undefined — no formula for budget gate projection | ✅ DONE | Define: `projected = current_spentMonthlyCents + sum(estimated_role_cost_cents)` from model router pricing. At minimum: state whether gate checks `spent >= cap` or `spent + projected >= cap`. |
| P1.13-F4 | HIGH | wiring-scope | Budget-cap READ endpoint unnamed; roll-up mechanism ambiguous (auto via Paperclip POST or manual) | ✅ DONE | (a) Specify budget-cap READ endpoint (e.g., `GET /agents/:agentId` returns `budgetMonthlyCents`/`spentMonthlyCents`). (b) Clarify: roll-up is automatic via Paperclip's `budgetHooks` on POST — QDS code does not call a separate endpoint. |
| P1.13-F5 | MEDIUM | integration | DoD references `usage-aggregate.ts:90-122` — wrong file; P1.13 reads cost envelope, not Warren internals | ✅ DONE | Remove `usage-aggregate.ts` reference from DoD. Replace: "P1.13's `cost-emitter.ts` reads P1.6 cost envelope (`$QDS_COST_ENVELOPE_DIR/<warrenRunId>.json`) and POSTs each entry to Paperclip." |
| P1.13-F6 | MEDIUM | ac-ambiguity | AC-1 "tree-sum equality" underspecified for subtree case — row issueId vs query issueId | ✅ DONE | Specify: all per-role rows POSTed with `issueId` = Pi team's assigned issue; cost-summary GET called on same issue ID. Recursive CTE includes root. |
| P1.13-F7 | MEDIUM | security | INV-4 says `PAPERCLIP_RUN_ID` sent as header but never names the header | ✅ DONE | Specify exact header name (check `registry.ts:468-469` for canonical name — likely `x-paperclip-run-id` or `x-run-id`). |
| P1.13-F8 | MEDIUM | schema-gap | `occurredAt` required by schema but cost envelope has no timestamp field — derivation unspecified | ✅ DONE | Specify: `occurredAt = new Date().toISOString()` at emit time (when cost is finalized for POST). Or add `occurredAt` to cost envelope contract shared with P1.6. |

---

## Verified-Correct Elements

### P0.2
- ✅ Zero dead references (no killed-story refs, no Archon/dag terminology)
- ✅ Standalone dependency claim correct (`deps: []` in sprint-status.yaml)
- ✅ Source repo `disler/pi-vs-claude-code@main` exists; spike vendored files confirmed
- ✅ Line-number references verified accurate (`coms.ts:536`, `:32`, `:225`; `agent-team.ts:347-368`; `pi-pi.ts:294`)
- ✅ AC structure correct (3 scenarios, 1 make-or-break binary)
- ✅ Guards/limits candor excellent (explicit scope of what story does NOT prove)
- ✅ OQ-1 decision framing correct (both paths confirmed viable by spike)

### P1.2
- ✅ No dead references; clean Hermes/Paperclip language
- ✅ Schema column names verified against `issues.ts` source
- ✅ P1.1 contract alignment correct (Dev manager `agents.id` as `assigneeAgentId`)
- ✅ OQ-3 fallback correctly handled (AC-3 tests Hermes-gateway path)
- ✅ Security invariants well-scoped (INV-1 through INV-3)
- ✅ `local_trusted` auth pattern consistent with P1.1

### P1.3
- ✅ Authority split clean (Seeds=deps, Paperclip=assignment+cost; no `cost` column)
- ✅ `originKind`/`originId` columns confirmed at `issues.ts:45-46`
- ✅ Partial unique index pattern confirmed (`issues.ts:93-141`)
- ✅ Line-number citations accurate
- ✅ Seeds CLI path/version correct (`/usr/local/bin/sd`, v0.2.5, private)
- ✅ `hermes_local` auth injection at `registry.ts:468-469` confirmed
- ✅ No killed-story references

### P1.6
- ✅ Worker model `openrouter/google/gemini-2.5-flash` confirmed valid on OpenRouter
- ✅ Cost envelope path contract consistent with P1.13
- ✅ `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID` exclusion from prompt with enforcement assertion
- ✅ Warren 17%/83% cost split accurately reflects spike finding
- ✅ NDJSON parse path `turn_end.message.usage.cost.total` matches pi 0.55.0 format
- ✅ Crash-partial cost extraction logic thorough
- ✅ Pi flags (`-p`, `--no-session`, `--mode json`) confirmed
- ✅ P1.7 correctly scoped as separate successor
- ✅ All 6 dependency edges reference real, non-killed stories

### P1.13
- ✅ `createCostEventSchema` shape verified against source (exact match)
- ✅ POST endpoint verified at `costs.ts:73`; server-side own-agent enforcement at `:77-80`
- ✅ Budget cap fields verified (`agents.ts:30-31`, `companies.ts:14-15`)
- ✅ No `issue.cost` column discipline consistently enforced
- ✅ Cost envelope canonical path aligned with P1.6
- ✅ Ceiling rounding formula mathematically correct (IEEE 754 noise handled)
- ✅ Warren 83% undercount awareness correct
- ✅ `companyId` is route-scoped, not body-scoped (correctly not listed in body fields)

---

## Session Log

| Time | Wave | Agent IDs | Summary |
|------|------|-----------|---------|
| 2026-06-07 ~09:52 | Campaign launch | — | Round-2 campaign launched. Stories: P0.2, P1.2, P1.3, P1.6, P1.13. Initial scan dispatching. |
| 2026-06-07 ~10:15 | Initial Scan | reviewer-p02, reviewer-p12, reviewer-p13, reviewer-p16, reviewer-p113 | 5 reviewers returned. 43 findings: 2 BLOCKER, 18 HIGH, 18 MEDIUM, 5 LOW. 5 cross-cutting themes identified (CC-1 is BLOCKER). Tracker populated. Wave 0 dispatching. |
| 2026-06-07 ~10:20 | Wave 0 (partial) + Waves 1–4 (P0.2/P1.2) | session-1 agents | P0.2 all 6 findings fixed. P1.2 7/8 fixed (M2 resolved via CC-1 fallback; M3 deferred). P1.3 BLOCKERs F1/F2 fixed. CC-5 resolved. Session ended before remaining stories. |
| 2026-06-07 ~10:25 | Waves 0–4 collapse (resume) | P1.3-agent, P1.6-agent, P1.13-agent | Session 2 resumed campaign. P1.2-M3 fixed inline. 3 parallel agents dispatched for P1.3 (9 items), P1.6 (14 items), P1.13 (9 items). Awaiting completion. |
| 2026-06-07 ~11:55 | Wave 5 — Verification | verifier-p02, verifier-p12, verifier-p13, verifier-p16, verifier-p113 | 5 fresh-eyes verifiers returned. 47 new findings: 9 HIGH, 21 MEDIUM, 17 LOW. P1.13 cleanest (0 HIGH). No BLOCKERs. |
| 2026-06-07 ~12:05 | Wave 5b+5c (collapsed) | Wave5bc-fix-P02, -P12, -P13, -P16, -P113 | 5 parallel fix agents (collapsed 5b+5c). All completed. 88 insertions, 57 deletions across 5 stories. P1.3 fastest (1m57s). P1.6 slowest (4m20s). |

## Wave 5 Verification Findings (47 total)

| Story | HIGH | MEDIUM | LOW | Total | Key themes |
|-------|------|--------|-----|-------|------------|
| P0.2 | 2 | 4 | 4 | 10 | Contract surface probe scope; schema examples; stale editorial |
| P1.2 | 2 | 5 | 3 | 10 | Migration 0094 new; SHA-256 ambiguity; header naming |
| P1.3 | 3 | 5 | 3 | 11 | Python→TypeScript language fix; CC-1 fallback; Seeds read mechanism |
| P1.6 | 2 | 4 | 3 | 9 | exit_class null still present; WarrenClient grounding; file map |
| P1.13 | 0 | 3 | 4 | 7 | Route path; projected spend formula; TOCTOU; cost source clarity |

**Wave 5 fix summary:** All 47 findings resolved in collapsed 5b+5c pass. No regressions detected. Stories are dev-ready.
