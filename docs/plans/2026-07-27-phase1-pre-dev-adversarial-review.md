# Phase 1 — Pre-Dev Adversarial Review (QDS Campaign)

**Date:** 2026-07-27
**Sprint:** Phase 1 (Dev vertical slice — make-or-break)
**Campaign type:** Post-Phase-0 spec-drift hardening. Phase 0 shipped (implementation delivered; P0.5 + P0.9 remain `in-review` on incomplete DoD evidence, and the §13 exit gate is FAIL). Actual dev changed load-bearing surfaces in ways the original Phase-1 specs could not predict. This campaign finds that drift and hardens Phase-1 specs before dev starts.
**Tracker owner:** parent agent (Claude). Subagents return reports; only parent mutates this file.

## Why this campaign

Phase 0 implementation work is present for P0.2/3/5/6/7/9/10/11, but delivery is not the same as DoD completion: **P0.5 and P0.9 are `in-review`, not `done`** — their exit evidence is incomplete (P0.5: 3 met / 1 partial / 5 not satisfied; P0.9: 6 met / 4 partial / 1 not satisfied — the MANDATORY e2e demo in each has never run). See `_bmad-output/sprint-artifacts/p0-5-p0-9-dod-reconciliation.md`. The §13 exit gate verdict is **FAIL** (7 pass / 2 fail / 1 skip / 2 void). The real Phase-0 surfaces diverge from what Phase-1 drafts assume:

- **P0.1 (Archon harness) was KILLED.** The CLI-Anything harness actually shipped via P0.3 + the `cli-anything` workspace (PR #87). Phase-1 stories still cite "P0.1 (CLI-Anything harness skeleton)" as a live dependency.
- **P0.3 is DONE** (PR #40, 2026-07-20), not deferred — but P1.6's reconciliation note still calls it DEFERRED.
- **Warren CLI CC-2 amended** (0.10.0 has no `--config` flag). P1.4/P1.6 still contain `warren run --config .canopy/agent.json`.
- **exitStatus enum promoted to 5-value** (`success|transient|overflow|logic|lead_failure`) in P0.3 Wave 5b. Phase-1 consumers cite 4-value.
- **Hindsight transport**: `hindsight-local-mcp` is HTTP :8888/mcp, not stdio (gate clause 6 fail); Hindsight API unreachable locally (clause 7 fail, OQ-4 BLOCKED-on-env). P1.11/P1.12 assume live Hindsight.
- **pi-lens-verify PI_LENS_ROOT** fixed post-spec (PR #84). P1.7 (lsp gate) must reference `lsp-verify.ts` harness, not stale `pi-lens-verify`.
- **Tech debt merged** changes SwarmClaw body-cap behavior (drain/413, commit 43e2c6b) consumed by P1.1/P1.3/P1.6/P1.15.
- **P1.4 + P1.8 wrongly killed** (cascade from P0.1 Archon kill — but P1.4 had already been re-scoped to depend on SwarmClaw P0.7, not Archon; the cascade applied to a dep edge that no longer existed). Their files are zombie artifacts; P1.6 depends on the template P1.4 ships.

Goal: harden the 8 drift-hotspot Phase-1 stories so the first dev-time bmad-code-review on each surfaces minor nits, not multiple rounds of large drift fixes.

## Scope

| Story | File | Pts | Deps (actual) | Pairing |
|-------|------|-----|---------------|---------|
| P1.1 | `…/phase-1/stories/p1-1-dev-manager-a2a.md` | 3 | P0.7 | **Pair C** (agent registry ↔ run) |
| P1.3 | `…/phase-1/stories/p1-3-seeds-decompose-mirror.md` | 4 | P1.2, P0.9 | **Single D** |
| P1.4 | `…/phase-1/stories/p1-4-protocol-template.md` | 4 | P0.7 | **Pair A** (template writer) |
| P1.6 | `…/phase-1/stories/p1-6-pi-team-protocol-step.md` | 5 | P0.3, P0.5, P0.9, P1.1, P1.4 | **Pair A** (dispatch consumer) |
| P1.7 | `…/phase-1/stories/p1-7-lsp-diagnostics-gate.md` | 3 | P0.6, P1.6 | **Single E** |
| P1.8 | `…/phase-1/stories/p1-8-protocol-run-github.md` | 3 | P1.1, P1.4 | **Pair C** (run consumer) |
| P1.11 | `…/phase-1/stories/p1-11-hindsight-prime-retain.md` | 4 | P0.9, P1.6 | **Pair B** (Hindsight banks) |
| P1.12 | `…/phase-1/stories/p1-12-mulch-prime-record.md` | 3 | P0.9, P1.6 | **Pair B** (Mulch banks) |

> **P0.11 semantics (P1.1-R5-3, added 2026-07-28 — PR #98 round 5).** The "Deps (actual)" column above omits `P0.11` while `sprint-status.yaml` still declares it on the P1.1 row, and the P1.1/P1.4 story files previously called it "deferred". One reading, used verbatim in all three places: **P0.11 is DELIVERED BUT NON-BLOCKING.** The gate shipped (`sprint-status.yaml` `status: done`, 2026-07-25) and its verdict is **FAIL** with all blockers upstream/environmental; what the 4-week execution plan §4.2 defers is its **gating authority**, folded into per-story Definition-of-Done checkpoints plus the P1.17 Phase-1 slice gate. So the `P0.11` entry in P1.1's `sprint-status.yaml` deps is a completed, non-blocking predecessor kept for ordering/provenance — it is deliberately absent from the "Deps (actual)" column here, which lists *blocking* technical predecessors only. A red P0.11 does not hold P1.1 or any Phase-1 story.

**Out of scope (this pass):** P1.2, P1.5, P1.9, P1.10, P1.13–P1.19 — mostly inherit hardened contracts from this cluster. Will be reviewed in a follow-up pass if needed.

## Dependency graph + pairing rationale (Rule 1)

- **Pair A = P1.4 + P1.6.** P1.4 authors the qds-factory protocol template (dispatch→parallel→compare→decide→summarize); P1.6's dispatch_task step consumes that template. Shared contracts: exitStatus enum (5-value CC-1), Warren CLI surface (CC-2), mulchBank↔mulchBankId field map (CC-7), changedFiles schema. One agent holds both halves so the template/step contract is decided once.
- **Pair B = P1.11 + P1.12.** Both consume P0.9's Hindsight/Mulch banks through the SwarmClaw bridge. Shared drift: `hindsight-local-mcp` transport (stdio vs HTTP, CC-5), OQ-4 BLOCKED-on-env (live Hindsight unreachable locally), maskEnv secret masking, `MCPInvokeErrorResponseSchema` error shape.
- **Pair C = P1.1 + P1.8.** P1.1 owns SwarmClaw agent registration + A2A envelope; P1.8's protocol run assigns agents against that registry and emits run state via the same SwarmClaw API. Shared contracts: agentId grammar, /api/a2a envelope, correlation ID propagation (CC-9).
- **Single D = P1.3.** Seeds-decompose → GitHub issue mirror (authority split). No cluster sibling shares the issue-mirror contract (P1.2 intake is out of scope).
- **Single E = P1.7.** Post-edit lsp_diagnostics gate. Consumes P0.6 `lsp-verify.ts` harness + `scripts/lib/*`. No cluster sibling; cross-refs P0.6 hardened QA findings.

## Status dashboard

| Wave | State | Findings resolved |
|------|-------|-------------------|
| Dependency graph + tracker | ✅ DONE | — |
| Initial scan (5 reviewers) | ✅ DONE | 7 BLOCKER + 14 HIGH + ~25 MED/LOW |
| Wave 0 cross-cutting | ✅ DONE (judgments resolved: sanction src/hindsight/client.ts; revive P1.4/P1.8 + yaml flipped; mulch no-CLI) | CC-1..CC-14 |
| Wave 1-4 fixes (consolidated) | ✅ DONE | 5 paired fixers, ~45 findings applied |
| Wave 5 verify | ✅ DONE | 5 verifiers: 0 BLOCKER/HIGH regression, 1 MED + ~16 LOW |
| Wave 5b/5c re-fix | ✅ DONE | 1 bundled re-fixer: 1 MED + 16 LOW applied |
| **CAMPAIGN** | ✅ **CONVERGED** | 8 stories hardened; 0 open findings |

## Wave 5 verification findings (fresh-eyes, post-fix)

**Verdict per pair:** A=3 (1 MED), B=3 LOW, C=3 LOW, D=3 LOW, E=CLEAN+1 LOW. **No BLOCKER/HIGH regressions introduced by fixes.** Campaign working as designed — residuals are polish.

### MED (1)
- **P1.6-V1**: AC1 (make-or-break, L32) + AC3 (L34) success/failure literals omit `mulchPrimed: boolean, mulchPrimeError?: string` that the Technical Notes schema (L56) + AC4 mandate. Test author coding to AC1 asserts a shape the schema rejects. (Extends Wave-5-flagged P1.6-N6.)

### LOW (~16)
- P1.4-V1: AC5 editorial bleed (meta-commentary in Then-clause) → relocate to footnote/DoD.
- P1.6-V2: `.canopy/agent.json` example (L43-52) omits `capabilities` field the prose (L41) claims.
- P1.12-V1: AC3 cross-ref "(CC-6 PB-L2)" conflates two tracker entries → fix to `PB-L2`.
- P1.12-V2: `mulchPrimed` field-name must align with P1.6 run-state schema (cross-story pin).
- M-PairB-1: P1.11+P1.12 both edit `src/protocol/phase-executor.ts` (P1.6 artifact) → merge-risk note (declared dep).
- P1.7-V1: ast-grep-present + no-tests middle case undefined → declare vacuous-pass, `waiver.reason:'no-lsp'`, emit allowed.
- P1.7-L4: add positive DoD assertion (gate invokes `lsp_diagnostics` once with `paths:[f1,f2,…]` for >1 file).
- P1.1-V1: add INV-5 "agentType + endpointUrl required non-empty" (functional in AC1, missing as INV).
- P1.8-V1: `PhaseRecord.agents: string[]` → type as agentId[] / reference RegisterAgentSchema.
- P1.8-V2: partial unique index reword → "partial unique index `ON runs(issueId) WHERE status='running'`".
- P1.8-V3: AC4 "SwarmClaw unreachable → runId:null" is client-side → reword "dev-manager client returns runId:null, no cache/retry".
- N-P1.1/P1.8-NEW-1: DoD note "import `ExitStatus` from `cli-anything/src/types.ts` (single source; do not re-declare)".
- P1.3-V1: `redactBoundaryPrefix` citation `runner.ts:223` → `:244` (symbol moved).
- P1.3-N1: pin UUID v5 namespace constant (e.g. in `src/seeds/schema.ts`) for cross-deployment reproducibility.
- P1.3-N3: document GitHub 65536 cap measured on post-redaction text (L2 test).
- P1.3-M2: idempotency test must state the status-transition carve-out (AC15 intake gate).

### NEW-finding adjudication (verifier verdicts)
- P1.6-N6 (AC3 narrative vs schema): **CONFIRMED** (extended to AC1 → P1.6-V1).
- P1.4-N2 (compare/decide 5-value echo): **REFUTED** — exitStatus is dispatch/parallel layer, not load-bearing for compare/decide.
- P1.6-N5 (style): CONFIRMED (capabilities field → P1.6-V2).
- N-P1.12-NEW-1 (100KB vs 5MB cap): **REFUTED** — distinct guards, distinct scopes, both correctly cited.
- N-PairB-1 (mock-mode constructor): **REAL, deferrable** — P1.11 impl task (health-check fallback path doesn't require it); stays INFO.
- N-P1.11-NEW-1 (phase-executor.ts): REAL, properly declared P1.6 dep.
- P1.7-L3 (no-evaluator exact-string): **RESOLVED-AS-WRITTEN** — DoD already asserts.
- P1.3-N2 (~/.seeds lock process-local): REAL, self-doc'd via `ponytail:` comment. No action.

## Scan findings (collated, 5 dependency-paired reviewers) — HISTORICAL INTAKE RECORD

> **Status of everything in this section: RESOLVED.** These tables are the
> as-filed intake from the initial scan; the `⬜` marks are their *filing*
> state and were never re-ticked in place. The authoritative outcome is the
> Status dashboard above (**CAMPAIGN CONVERGED — 0 open findings**), the Wave
> 1-4 fixer records, and the Wave 5 verification. Every CC-*/PB-*/N-*/per-story
> ID below was applied or explicitly adjudicated (see *NEW-finding
> adjudication* — P1.4-N2 and N-P1.12-NEW-1 were REFUTED, not applied). **Do
> not track follow-up work from these tables; use the Status dashboard.**

### BLOCKER (7)

| ID | Story(ies) | Finding | Status |
|----|-----------|---------|--------|
| CC-1 | P1.1, P1.4, P1.6, P1.8 | exitStatus enum drift. P0.3 ships 5-value `success\|transient\|overflow\|logic\|lead_failure` (`cli-anything/src/types.ts:78-84`). P1.1+P1.6 cite 4-value; P1.8 has NO enum (PhaseOutput undefined). | ⬜ |
| CC-3 | P1.1, P1.6 (+P1.8 transitive) | P0.1 phantom dep. P1.1 L26 + P1.6 L26 cite "P0.1 (CLI-Anything harness skeleton)". P0.1 KILLED (gate L17). Real harness = P0.3/cli-anything workspace (PR #87). | ⬜ |
| CC-5 | P1.11, P1.12 | Hindsight transport. P1.11 INV-MEM-1 "no direct HTTP to Hindsight API" **forbids P0.9's shipped surface** (`src/hindsight/client.ts:48` DEFAULT_BASE_URL=http://127.0.0.1:8888). + OQ-4 BLOCKED-on-env: ACs require live Hindsight w/ no fallback. | ⬜ |
| CC-6 | sprint-status, P1.4, P1.8 | P1.4+P1.8 wrongly killed (cascade off already-removed P0.1 dep). Revive + flip sprint-status. | ⬜ |
| PB-B1 | P1.11, P1.12 | File-path fork. Propose `src/memory/` + `src/mulch/` (neither exists). P0.9 hardened code lives `src/hindsight/`. Parallel clients fork contract. | ⬜ |
| PB-B2 | P1.12 | Mulch CLI subprocess contradicts P0.9 amendment ("importer reads `.mulch/expertise/` directly; `/usr/local/bin/mulch` NOT spawned"). P1.12 AC1 mandates `mulch prime`/`record` subprocess. | ⬜ |
| N-P1.1-1 | P1.1 (+P1.8, P1.3 consume) | `/api/a2a` route does NOT exist in source (`src/swarmclaw/index.ts:85-98` ships 4 routes only). P1.1 must flag it as NEW additive surface. | ⬜ |
| N-P1.8-1 | P1.8 | PhaseOutput shape undefined; exitStatus contract absent. Consumers diverge. | ⬜ |

### HIGH (14, selected)

| ID | Story | Finding |
|----|-------|---------|
| CC-2/CC-13 | P1.4, P1.6 | Warren CLI `warren run --config .canopy/agent.json` fiction. Real 0.10.0 = `warren run <agent> <project> -p "<prompt>"` (`runner.ts:694-720`). P1.6 AC1 unimplementable as written. |
| CC-4 | P1.6 | P0.3 "deferred" note stale. P0.3 = done (PR #40). |
| CC-7 | P1.1, P1.4, P1.6 | mulchBank↔mulchBankId field map anchored to fictional `.canopy/agent.json` Warren input. |
| CC-9 | P1.1, P1.8, P1.11, P1.12, P1.3 | requestId propagation. P1.8/P1.11/P1.12 absent; P1.1/P1.3 don't name `x-request-id` header. |
| P1.6-N1 | P1.6 | AC1 (make-or-break) embeds `warren run --config` → unimplementable. |
| P1.6-N2 | P1.6 | lead_failure path undocumented (harness-classified, not warren exit code). |
| P1.11-H1↑ | P1.11 | Parallel hindsight-client proposed at `src/memory/hindsight-client.ts` — forks P0.9 `src/hindsight/client.ts` (PR #34 defensive parsing). Upgrade→BLOCKER. |
| PB-H1 | P1.11 | RecallResponse shape mismatch. P0.9 = `{results:[{content,score,memoryId}],durationMs}`. P1.11 invents `{entries:MemoryEntry[]}`. |
| PB-H2 | P1.11 | RetainResponse shape + `bank_id` snake_case. P0.9 = `{memoryId,bankId,status,durationMs}` camelCase. |
| PB-H3 | P1.12 | MulchExpertiseSchema ignored. P0.9 mandates canonical schema; P1.12 uses simplified `MulchEntry`. |
| N-P1.8-2 | P1.8 | Phase list 5 vs 6 internal inconsistency (Overview=6, E2E=5). |
| N-P1.8-3 | P1.8 | requestId absent from state-event payload + run-initiation. |
| P1.3-H1 | P1.3 | INV-3 redaction absent. Mirror publishes to GitHub (external!) — must cite `redactSecrets`+`redactBoundaryPrefix` (`runner.ts:178,223`). |
| P1.3-H2 | P1.3 | Wrong env-var `SWARMCLAW_A2A_PORT`. Canonical = `SWARMCLAW_PORT` (`index.ts:199`). |

### MEDIUM (~18, selected)
P1.4-N1 (exitStatus enum constraint in schema), P1.4-N2 (.canopy/agent.json ownership = SwarmClaw store, indep of Warren register-agent), P1.6-N3 (warren exit-code assumption needs pre-dev verify), PB-M1 (requestId absent both), PB-M2 (maskEnv citation missing both), PB-M3 (timeout 15s vs P0.9 10s recall cap), PB-M4 (retain metadata drift), N-P1.1-2 (IPv4-mapped IPv6 `::ffff:127.0.0.1` gap), N-P1.8-5 (agentId grammar unconstrained in P1.8), P1.3-M1 (concurrency single-flight), P1.3-M2 (idempotency contradicts authority split — deterministic seeds-id or tombstone), P1.3-M3 (413 body-cap undefined), P1.3-M4 (Hindsight silent-failure — add dependenciesPersisted), P1.7-M1 (AC3a/AC4 silent — paths+concurrency not sequential), P1.7-M2 (fail-closed no-evaluator), P1.7-M3 (30s/file budget invented vs P0.6 15s init + 60-120s RPC).

### LOW (~8): P1.6-N4, P1.4 DoD labels, PB-L1/L2, N-P1.8-6, P1.3-L1/L2/L3, P1.7-L1/L2.

## Wave 0 cross-cutting resolutions (parent-locked; judgments flagged)

**LOCKED (unambiguous drift corrections):**
- **CC-1**: canonical exitStatus = 5-value incl `lead_failure`. lead_failure = harness-classified (lead exits before merged-JSON emit; exitCode = lead process exit). Apply P1.1, P1.4, P1.6, P1.8.
- **CC-3**: P0.1 dep removed; real harness dep = P0.3 (cli-anything workspace). Apply P1.1, P1.6, P1.8.
- **CC-9**: requestId = `x-request-id` header (UUID v4 strict, `index.ts:42-46`) + `_meta.requestId` + envelope `id`. Every story propagates. Apply P1.1, P1.8, P1.11, P1.12, P1.3.
- **CC-10 (new)**: Memory/Mulch phases extend `src/hindsight/` (prime-phase.ts, retain-phase.ts, record-phase.ts). Delete `src/memory/`+`src/mulch/` proposals. Apply P1.11, P1.12.
- **CC-11 (new)**: schemas canonical. P1.11 consumes P0.9 `RecallResponseSchema` + `RetainResponseSchema` (camelCase) verbatim — drop MemoryEntry/entries/bank_id. P1.12 consumes `MulchExpertiseSchema`. Apply P1.11, P1.12.
- **CC-12 (new)**: `/api/a2a` = NEW additive surface (P0.7 ships 4 routes only). P1.1 adds it; P1.8 + P1.3 consume. Apply P1.1, P1.8, P1.3.
- **CC-13 (new)**: Warren CLI canonical = `warren run <agent> <project> -p "<prompt>" [--provider --model]`. No `--config`. Apply P1.4, P1.6 (rewrite AC1 + prose).
- **CC-14 (new)**: `.canopy/agent.json` = SwarmClaw agent-config store, independent of Warren `register-agent`. Both populated for validation. Apply P1.4, P1.6.

**JUDGMENT CALLS — RESOLVED** (user decisions taken 2026-07-27 17:1x; see Session log. Selected outcome in **bold**):
- **CC-5**: Hindsight transport reframe — **(a) permit `src/hindsight/client.ts` as sanctioned HTTP boundary (reframe P1.11 INV-MEM-1)** ✅ chosen; (b) route all Hindsight ops through the SwarmClaw `/api/mcp-servers/{id}/invoke` bridge — rejected. Plus OQ-4 env-fallback AC added to P1.11 + P1.12 for live-Hindsight ACs.
- **CC-6**: **revive P1.4 + P1.8; sprint-status.yaml mutated (killed→draft, dep edges restored)** ✅ applied.
- **PB-B2**: P1.12 Mulch — **(a) reframe to recall/retain from the `{repo}-dev-meta` bank per P0.9 Consumer Contract (no CLI)** ✅ chosen; (b) keep the CLI subprocess — rejected.

## Verified-correct elements (do not regress)

**P1.1**: agentId regex matches `agent-store.ts:10`; SSRF loopback contract (`routes/agents.ts:34-55`); 409/429 codes; retry/backoff wall-clock bound; A2A error codes -32010..-32013 don't collide with P0.7 bridge.
**P1.4**: AC6/AC7 two-pass validation; compare/decide algorithms (Jaccard, weighted scoring, tie threshold); template immutability + version pinning.
**P1.6**: INV-2 path-traversal defense; INV-3 RSS watchdog (200ms, SIGTERM→5s→SIGKILL→overflow); CC-9 requestId propagation (envelope); changedFiles schema.
**P1.3**: authority split (Seeds authoritative, one-directional); INV-2 file perms `chmod 0600`; sanitization deny-by-default; JSONL atomicity; error-code range -32014..-32018 (distinct, P0.9-confirmed).
**P1.7**: version-pin handling (3.8.71, floor 3.8.69); tool-contract table; reuse mandate `scripts/lib/*`; INV-DIAG-1/2/3.
**P1.11/P1.12**: P1.11 AC3 waiver semantics; bank naming `{repo}`/`{repo}-dev-meta`/`qds-collective`.

## Wave progress

### Wave 1-4 outcome (5 paired fixers, bundled-by-file)
- **Fixer A (P1.4+P1.6)**: +30/-25. CC-1 lead_failure added; CC-3 P0.1→P0.3 (P1.6 dep + P1.4 L119); CC-4 P0.3 deferred→done; CC-7 mulchBank re-anchor; CC-13 warren `--config` rewritten 7 locations incl AC1; CC-14 .canopy store note; P1.6-N1..N4; P1.4-N1. NEW flagged: P1.6-N6 (MED — AC3 failure narrative underspecified vs schema: mulchPrimed/mulchPrimeError in schema not narrative), P1.6-N5 (LOW style), P1.4-N2 (LOW — compare/decide don't echo 5-value enum).
- **Fixer B (P1.11+P1.12)**: full rewrite, ACs 4→5 each. CC-5 INV-MEM-1 reframed (sanction src/hindsight/client.ts); OQ-4 env-fallback AC5 both; CC-9 requestId; CC-10 src/memory+src/mulch deleted → src/hindsight/; CC-11 canonical schemas (Recall/Retain/MulchExpertise); PB-B2 mulch CLI removed → recall/retain bank. NEW flagged: N-P1.11-NEW-1 (LOW — src/protocol/phase-executor.ts doesn't exist, P1.6 artifact), N-PairB-1 (INFO — HindsightClient needs mock-mode constructor option for AC5; propose P0.9 follow-up).
- **Fixer C (P1.1+P1.8)**: +14/-5 (P1.1), +24/-5 (P1.8). CC-1 5-value enum; CC-3 P0.1→P0.3; CC-9 x-request-id header named + P1.8 requestId in state-event; CC-12 /api/a2a flagged additive; P1.8 PhaseOutput declared; phase list unified to 6; agentId grammar constrained; IPv4-mapped IPv6 added. NEW flagged: N-P1.8-NEW-1/2 (LOW — partial unique index SQL; AC4 client-timeout reword), N-P1.1-NEW-1 (LOW — exitStatus declared 3 places, no single source; impl should import from cli-anything/src/types.ts).
- **Fixer D (P1.3)**: +23/-8. CC-8 body-cap -32020; CC-9 requestId symbols; CC-12 /api/a2a additive; P1.3-H1 redaction machinery cited; P1.3-H2 SWARMCLAW_PORT; P1.3-M1 single-flight lock -32021; P1.3-M2 deterministic UUID v5 idempotency; P1.3-M4 dependenciesPersisted; L1 split -32017/-32019; L2 GitHub body cap; L3 env-var override test. NEW flagged: P1.3-N1 (LOW — UUID v5 namespace unnamed), P1.3-N2 (LOW — ~/.seeds lock is process-local), P1.3-N3 (LOW — body cap measured on redacted text, load-bearing for test).
- **Fixer E (P1.7)**: +20/-4. P1.7-M1 AC4 paths+concurrency; P1.7-M2 fail-closed no-evaluator AC5; P1.7-M3 latency budget 3s warm/30s ceiling; latency drift reconciled (427ms source-of-truth); 9/20 reframed to stale-first-response. NEW flagged: P1.7-L3/L4 (LOW — no-evaluator exact-string assertion; positive paths-assertion).

### Wave 5 verification targets (NEW findings verifiers must adjudicate)
- P1.6-N6 MED (AC3 narrative vs schema), P1.4-N2 LOW (compare/decide 5-value echo), N-P1.1-NEW-1 LOW (exitStatus single-source), N-PairB-1 INFO (mock-mode P0.9 follow-up), N-P1.11-NEW-1 LOW (phase-executor.ts ownership), P1.3-N1/N2/N3 LOW, P1.7-L3/L4 LOW, N-P1.8-NEW-1/2 LOW.

## Session log

- **2026-07-27 16:40** — Campaign start. Scope 8 drift-hotspot stories. Pairing A=P1.4+P1.6, B=P1.11+P1.12, C=P1.1+P1.8, D=P1.3, E=P1.7. Investigated P1.4/P1.8 kill: cascade error. Tracker created.
- **2026-07-27 16:5x** — Initial scan (5 paired reviewers): 7 BLOCKER + 14 HIGH + ~25 MED/LOW. Wave 0 CC-1..CC-14 locked.
- **2026-07-27 17:1x** — User judgments: sanction src/hindsight/client.ts; revive P1.4/P1.8 (+sprint-status.yaml flipped); mulch no-CLI. Wave 0 DONE.
- **2026-07-27 17:2x-17:5x** — Wave 1-4 consolidated fixers (5 paired, bundled-by-file): all complete. ~45 findings applied + 0 regressions self-reported. ~13 NEW LOW/MED/INFO findings surfaced for Wave 5 adjudication.
- **2026-07-27 18:0x** — Wave 5 verify dispatched (5 paired verifiers, uncoupled from fixers, fresh-eyes). Pending.
- **2026-07-27 18:4x** — Wave 5 verify complete: 0 BLOCKER/HIGH regressions, 1 MED (P1.6-V1) + ~16 LOW. NEW-finding adjudication: P1.4-N2 + N-P1.12-NEW-1 REFUTED; P1.6-N6 CONFIRMED→V1; rest REAL-LOW or self-doc'd.
- **2026-07-27 18:5x** — Wave 5c bundled re-fix: 1 MED + 16 LOW applied across 8 stories. 1 discrepancy (P1.3-M2 recipe said "AC15" but P1.3 has 7 ACs — re-fixer correctly mapped to `-32015` intake-status code). **CAMPAIGN CONVERGED.**

## Outcome

8 drift-hotspot Phase-1 stories hardened against actual Phase-0 shipped surfaces. ~70 findings resolved across scan → Wave 0 → Wave 1-4 → Wave 5 verify → Wave 5c re-fix. The biggest drift caught:

- **exitStatus enum** — Phase-0 promoted to 5-value (`+lead_failure`); all 4 consuming stories cited 4-value. Fixed.
- **Warren CLI** — `warren run --config` fiction; P1.6 make-or-break AC1 was unimplementable as written. Rewritten to canonical `warren run <agent> <project> -p`.
- **P0.1 phantom dep** — killed story cited as live dep by P1.1+P1.6. Repointed to P0.3.
- **P1.4 + P1.8 wrongly killed** — cascade off an already-removed Archon dep edge. Revived + sprint-status.yaml flipped.
- **Hindsight transport** — P1.11 INV forbade the shipped `src/hindsight/client.ts` HTTP surface. Reframed to sanction it + OQ-4 env-fallback ACs.
- **Schema fork** — P1.11/P1.12 invented `src/memory/`+`src/mulch/` dirs + parallel clients + wrong response shapes. Repointed to `src/hindsight/` + canonical P0.9 schemas.
- **`/api/a2a`** — assumed to exist; P0.7 ships only 4 routes. Flagged as new additive surface P1.1 ships.
- **Mulch CLI** — P1.12 mandated `mulch prime`/`record` subprocess contradicting P0.9 amendment. Reframed to bank recall/retain.

Also: wrong env-var (`SWARMCLAW_A2A_PORT`→`SWARMCLAW_PORT`), GitHub-mirror redaction machinery uncited, requestId propagation gaps across 5 stories, IPv4-mapped IPv6 loopback gap, file-path/citation drift. Expectation: first dev-time bmad-code-review on each story surfaces minor nits, not multiple rounds of large drift fixes.

## PROPOSED follow-ups (parent surfaced, NOT silently amended)

- **P0.9 backlog**: add `mode?: 'live'|'mock'` to `HindsightClientOptions` (P1.11/P1.12 AC5 need it; INFO, deferrable via health-check fallback).
- **`src/protocol/phase-executor.ts`**: P1.6 ships it; P1.11 + P1.12 both extend it. Coordinate edit ordering (P1.11 first, P1.12 reuses the hook).
- **Single-source `ExitStatus`**: all stories should `import { ExitStatus } from 'cli-anything/src/types.ts'` at impl time (DoD notes added; not a spec blocker).
- **Stories NOT in this pass** (P1.2, P1.5, P1.9, P1.10, P1.13–P1.19): inherit hardened contracts from this cluster. Run a lighter follow-up pass if interlock concerns surface.

## Accepted residuals (cosmetic, documented — not blocking)

- P1.4 INV-3 + Guards/limits two-pass -32011→-32602 verbatim duplication (consistent, redundant).
- P1.3 `~/.seeds/decompose.lock` process-local ceiling (self-doc'd via `ponytail:` comment; per-session locks if throughput matters).

## Seeded drift inventory (pre-scan seeds) — HISTORICAL, ALL RESOLVED

> **Status: RESOLVED — this is the campaign's opening seed list, kept for
> provenance.** It was written *before* the initial scan and its `⬜` marks are
> the as-seeded state, never re-ticked in place. Every seed here was absorbed
> into the collated scan findings above and resolved through Waves 0–5c; the
> campaign is **CONVERGED with 0 open findings** (Status dashboard). The
> original instruction below ("Reviewers must verify or correct each") was
> addressed by the initial scan and is no longer an open action.
>
> Originally: these were verified by the parent against the
> phase0-gate-report.json, merged PRs, and sprint-status.yaml.

### Cross-cutting (≥2 stories) — Wave 0 candidates

| ID | Sev | Finding | Stories | Status |
|----|-----|---------|---------|--------|
| CC-1 | BLOCKER | exitStatus enum drift. P0.3 Wave 5b promoted CC-1 to **5-value** `success\|transient\|overflow\|logic\|lead_failure`. P1.1 + P1.6 cite **4-value** canonical. All consumers must accept all 5. | P1.1, P1.4, P1.6, P1.8 | ⬜ |
| CC-2 | HIGH | Warren CLI surface. P0.3 CC-2 amended 2026-07-20: real Warren 0.10.0 has no `--config` flag; canonical = `warren run <agent> <project> -p "<prompt>" [--provider --model]`. P1.4/P1.6 still contain `warren run --config .canopy/agent.json` + `.canopy/agent.json` manifest story. | P1.4, P1.6 | ⬜ |
| CC-3 | BLOCKER | P0.1 phantom dependency. P0.1 KILLED (Archon). P1.1 + P1.6 cite "P0.1 (CLI-Anything harness skeleton)" as live dep. Real harness shipped via P0.3 / `cli-anything` workspace (PR #87). Re-point dep to P0.3. | P1.1, P1.6 | ⬜ |
| CC-4 | HIGH | P0.3 "deferred" note stale. P1.6 reconciliation calls P0.3 DEFERRED. Actually status=done (PR #40, 2026-07-20). Remove/flip reconciliation note. | P1.6 (and P1.4 if present) | ⬜ |
| CC-5 | BLOCKER | Hindsight transport + env. Gate clause 6 fail: `hindsight-local-mcp` is HTTP :8888/mcp, not stdio JSON-RPC. Clause 7 fail: Hindsight API 404 locally (OQ-4 BLOCKED-on-env, arm64 libpq/openssl@3 mismatch). P1.11/P1.12 assume live stdio Hindsight. Define transport truth + fallback. | P1.11, P1.12 | ⬜ |
| CC-6 | HIGH | P1.4 + P1.8 wrongly killed. Cascade from P0.1 Archon kill, but P1.4 deps had already been re-scoped to P0.7 (SwarmClaw). Kill commit 8d2fa78 diff shows P1.4 deps=[P0.11] with comment "P0.1 removed (killed)" — cascade applied to a non-existent dep edge. Flip sprint-status killed→draft; restore dep edges. | sprint-status.yaml, P1.4, P1.8 | ⬜ |
| CC-7 | MEDIUM | mulchBank ↔ mulchBankId field mapping. P1.1 flags: P1.6 dispatch_task config uses `mulchBankId`, `.canopy/agent.json` uses `mulchBank`. Post-CC-2 amendment the manifest story changed — re-verify the translation boundary. | P1.1, P1.4, P1.6 | ⬜ |
| CC-8 | MEDIUM | SwarmClaw body-cap / drain-413 tech debt. Commit 43e2c6b (drain refused body before 413) changed body-cap behavior. P1.1/P1.3/P1.6/P1.15 consume SwarmClaw endpoints — verify against current `src/swarmclaw/index.ts`. | P1.1, P1.3, P1.6 | ⬜ |
| CC-9 | MEDIUM | requestId / correlation ID propagation. P0.7 hardened `_meta.requestId` + UUID-strict `x-request-id` as cross-layer join key. P1.1 A2A + P1.8 run-state must propagate requestId end-to-end. Verify spec cites the hardened header. | P1.1, P1.8 | ⬜ |

### Per-story drift seeds

| Story | ID | Sev | Finding | Status |
|-------|----|-----|---------|--------|
| P1.7 | P1.7-H1 | HIGH | pi-lens-verify PI_LENS_ROOT. Gate clause 4 skip: `pi-lens-verify.ts` ignored PI_LENS_ROOT (fixed PR #84 "unify resolver"). P1.7 must reference `lsp-verify.ts` (P0.6 harness, honours PI_LENS_ROOT, 7/7 pass) not stale `pi-lens-verify`. Verify P1.7's harness citation. | ⬜ |
| P1.7 | P1.7-H2 | HIGH | P0.6 AC partialness cascade. P0.6 story-level PARTIAL (AC1 single-query freshness 9/20 stale; AC3 artifact half unasserted; AC3a init timeout unexercised; AC4 not literal sequential). P1.7 builds a gate ON TOP of P0.6 — must not inherit unverified ACs as assumptions. | ⬜ |
| P1.1 | P1.1-H1 | HIGH | A2A error codes (-32010..-32013) vs P0.7 hardened bridge. P0.7 invoke uses `MCPInvokeErrorResponseSchema` (JSON-RPC `-32601/-32602`→400 else 502). Verify P1.1's A2A error codes don't collide/contradict the bridge contract. | ⬜ |
| P1.11 | P1.11-H1 | HIGH | Hindsight client defensive parsing. P0.9 client.ts must apply PR #34 lessons (primitive/array error frames, timers cleared in finally). Verify P1.11 cites the hardened client surface. | ⬜ |
| P1.12 | P1.12-H1 | HIGH | Mulch huge-file DoS + single-flight. P0.9 scan flagged per-file size cap + provision single-flight lock. Verify P1.12 Mulch prime/record carries these guards. | ⬜ |

_(The initial scan filed its findings in the collated **Scan findings** section
above, not here — this seed list was not extended further.)_

<!--
Removed 2026-07-28 (PR #98 review): three empty duplicate template headings
("Verified-correct elements", "Wave progress", "Session log") plus a duplicate
opening session-log entry ending "Initial scan dispatching next." They were
unfilled scaffolding left below the seed inventory and contradicted the
populated, authoritative sections of the same name earlier in this document,
which record CAMPAIGN CONVERGED / 0 open findings. The live sections above are
the single source of campaign status.
-->
