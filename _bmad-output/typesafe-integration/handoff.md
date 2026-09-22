# TypeSafe (Jev) Integration — Orchestrator Handoff Brief

Repo: QDS-Factory (branch base: `dev`; feature prefix `feature/`). Created 2026-09-22.
This file is the SOURCE OF TRUTH for this work. Chat context is disposable; this file is not.

## 0. How to use this doc (orchestrator protocol — follow exactly)

1. The main session is an ORCHESTRATOR. It decides, dispatches, verifies, commits. It does NOT read large artifacts itself — subagents read and return ≤60-line summaries.
2. Work proceeds in WAVES (§7). Within a wave, independent tasks go to PARALLEL subagents (single message, multiple Agent calls). Between waves the orchestrator verifies gates and writes the next wave's briefs.
3. After EVERY wave: update §2 Status board + append a ≤15-line "Wave N outcome" to §11. This is the resume point if the session is cleared.
4. Decisions marked LOCKED (§3) are SETTLED with rationale recorded. Do not relitigate. If new facts contradict a LOCKED decision, surface to steve first.
5. Implementation goes through the repo's own process: story specs → qds-story-review hardening → dev via qds-dev conventions (feature branch → PR → dev). GitNexus: `impact()` before editing any existing symbol; `detect_changes()` before any commit; cite by SYMBOL, never by line number (repo rule — line drift was the most-cited defect in its own review history).
6. Tests always tee to a log: `bun test > /tmp/qds-test.log 2>&1` then the tr/perl/grep extraction from repo CLAUDE.md.

## 1. Mission

Give QDS-Factory a third tier between its deterministic host control plane and its System-Two LLM agent waves: **calibrated, typed, batched semantic judgment** (TypeSafe Jev API). Not an LLM — no generation. Code sends state + typed questions (`choice`/`score`/`noul`); gets typed answers + probabilities. Host code owns all policy and thresholds.

Shipping order (this work):
- **S-A Corpus capture** — schema'd triage records at review time (zero deps, zero vendor).
- **S-B `src/judgment/` core** — vendor client per house idiom, recording-only, mock mode.
- **S-C S1 observer** — at review-triage stage, Jev pre-routes findings alongside the existing frontier session; paired labels fill the corpus; calibration measured; NOTHING is armed yet.

Out of scope (do NOT build): auto-fix gating on Jev answers, severity calibration (data can't support it), diff-hunk egress (stage 2, gated on executed ZDR addendum — see §3.7), audit-chain hop, gate-runner changes, S5 GitNexus noul bridge (cut).

## 2. Status board

| Wave | Scope | Status |
|---|---|---|
| 0 | Recon (3 parallel read-only agents) | DONE |
| 1 | Story specs + hardening | DONE |
| 2 | Implementation (corpus writer; judgment core) | DONE |
| 3 | S1 observer wiring + integration tests | DONE |
| 4 | Suite, review, PR, measurement harness | DONE |

## 3. LOCKED decisions (rationale recorded — do not relitigate)

1. **Host-side placement.** In-box rejected: a judgment computed in-box is box output; the host's founding lesson is never trusting box output for control flow (feedback-run.ts INV-7, classifyDiffScope, admission guards). Machine-state-only rejected: leaves nothing semantic to judge.
2. **Budget: infrastructure tier.** No per-run budget admission for Jev calls. They are code-initiated, batched, stage-scoped — cannot spiral (repo's existing line: unmetered key-mgmt vs metered agent spend). Cost observed via envelope usage + one stage-level ceiling (circuit breaker) + monthly bill alarm. At $0.042/Mtok a 19-finding triage ≈ $0.0008 — metering would cost more than a year of spend.
3. **No SDK dependency.** package.json stays `yaml`+`zod`. Build on `src/lib/http.ts` + zod schemas, mirroring `src/hindsight/client.ts` (schemas + mock mode + tests). Avoids SDK/Bun-compat unknowns and re-unifying a wrapper the repo already unified once.
4. **No audit-chain changes.** `AUDIT_HOPS` (src/audit/link-store.ts) is a frozen ten-hop contract; a new hop rewrites `complete` semantics and breaks historical walks. Judgments land in the run-record side channel (verify exact mechanism in Wave 0; fallback: side JSON log keyed by requestId). All emitted `detail` must be DIGEST-STABLE — store reports `divergent` (tamper alarm) when the same subject re-emits with a different evidence digest; credentials.ts hit this bug class 3×. Volatile fields (answer values, confidence) ride log lines, not store rows.
5. **Recording-only until measured.** gate-runner untouched (its semantics have no home for uncertainty: skip ≠ pass, empty = FAIL). No Jev answer gates anything in waves 0–4.
6. **Model pinned, contract-tested.** Pin `jev-1.13.0` — NEVER the `jev-latest` alias (docs themselves advise pinning; aliases repoint silently). Contract test in the `tests/gitnexus/` pattern: strict schema on response shape + pinned model id, the ONE suite allowed to fail loudly on upstream drift. Re-calibration ritual documented alongside.
7. **Typed egress classes, staged.** `machine-state | finding-text | ac-prose | diff-hunk`. Every seam declares what it ships; config selects max class. Stage 1 = finding-text + ac-prose. Stage 2 (diff hunks) is HARD-GATED on an executed ZDR addendum with defined retention + deletion clauses — the published DPA has none (verified 2026-09-22: only "as long as necessary"). steve owns the vendor email; this work stream NEVER contacts TypeSafe itself.
8. **Redaction designed for the whitelist, not reused.** `redactSecrets` (step-log.ts) is a targeted pattern redactor, NOT a diff scrubber — and is lossy both ways (audit/chain.ts had to stop routing join slugs through it). The choke-point function (§7 Wave 2) validates egress class + redacts per class.
9. **No severity calibration.** Whole triage history has ≈3 positive BLOCKER examples. Calibrated questions: binary `is_real_defect` (noul) + `disposition` (choice: patch/dismiss/gate-action) only. Severity stays with the frontier session.
10. **S1 is a pre-router, not a replacement.** Code-grounded adjudication ("verified against real source by the lead") stays frontier. Jev adds a calibrated prior that routes findings into deep-adjudication vs obvious-dismiss. Cost-replacement claims are retracted; value = routing precision + measured calibration curve.
11. **Corpus capture precedes everything.** Fixes the "ready-made calibration set doesn't exist" finding: existing triage.md files store verdicts, not replayable inputs, and labels are LLM-lead-generated. From now on each triage emits `{finding_text, diff_context_ref, label, disposition, labeler, round, created_at}` as schema'd records; backfill of the 16 existing ledgers is best-effort and honestly labeled `agreement-with-claude`.
12. **A/B measurement is part of the mission, not an afterthought.** Same findings flow to BOTH arms every round: arm `frontier` = existing lead triage (as-is, unchanged), arm `jev` = observer. Metrics, defined NOW in the corpus schema: per-finding `latency_ms` (both arms), cost — exact for Jev (response `usage` × $0.042/Mtok), estimated for frontier (documented cost model on session duration — labeled `estimate`, never passed off as metered), performance = agreement-with-lead per question +, as rounds accumulate, outcome-validated precision (was a Jev-dismissed finding later confirmed real in fix waves / re-review / human override? — `outcome_confirmed`/`outcome_source` fields filled by later rounds). No speed-vs-performance-vs-cost claim ships without this table behind it.

## 4. Vendor facts (TypeSafe — verified 2026-09-22)

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`. Request: `{model, state, questions}`; `questions` = map of `{type: noul|choice|score, instructions, criteria?}`. Response: `{model, answers: {<qid>: {type, noul|choice+probabilities+confidence|score+legend+probabilities+confidence}}, usage}`. Errors: 401/422/429/529 — backoff-retry 429/529.
- Limits: **64k tokens/request; 32k for state + longest question; 250k tok/s; 1200 req/min**. Input-token billing only.
- `jev-1.13.0` is current; `jev-latest`/`jev-preview` both alias it today. Pin the versioned id (§3.6).
- 1.13 jaggedness (route around, design already does): literal reading; unreliable counting/numbers (compute in code); dates as text; indirection cost; context rot on large state (→ small per-finding states, NOT one mega-state; batch across requests, rate limits allow it); state not treated as hostile (→ explicit criteria, hostile-prose handling at the choke point); no arithmetic identities between questions (never compare a noul threshold to a choice probability); no generation ever.
- ZDR: offered for enterprise per docs pages, NOT in the published DPA (§3.7). Subprocessors: trust.typesafe.ai/subprocessors, 15-day objection right.
- Playground exists for manual probes; docs at docs.typesafe.ai (Mintlify; append `.md` for raw markdown).

## 5. Repo facts (verified paths/symbols — start here, don't re-derive)

| Purpose | Where |
|---|---|
| Unified external-REST idiom (F063) | `src/lib/http.ts` |
| In-repo vendor-client reference: schemas + mock mode + tests | `src/hindsight/client.ts` (~466 LOC) |
| Frozen audit hop table + divergent alarm | `src/audit/link-store.ts` `AUDIT_HOPS`, unique-conflict arm |
| Gate semantics (skip≠pass; empty=FAIL; throw→fail) | `src/gate/gate-runner.ts` |
| Key-management REST discipline (idempotent-verb-only retries) | `src/providers/credentials.ts` `openRouterKeyApi` |
| Targeted redactor + what it is NOT | `src/providers/step-log.ts` `redactSecrets` |
| Exact exit/scope classifiers (leave alone) | `src/providers/cap-rejection.ts` `classifyRunExit`; `src/fixloop/feedback-run.ts` `classifyDiffScope` |
| Fix-loop import fence + INV-7 (untrusted prose kept out of records) | `src/fixloop/feedback-run.ts` header |
| Run-record store | `src/providers/run-record.ts` (Wave 0: find the side-channel/extension mechanism) |
| Review-triage artifacts (backfill corpus source) | `_bmad-output/workflow-state/code-review/` (14 dirs + one stray FILE `df3-3-selfreview.diff`; formats inconsistent; corrected 2026-09-22 Wave-5: pr123/triage.md IS a parseable table — earlier "pure prose, zero rows" claim was wrong; see tracker JEV1-M1/GEN-V14) |
| Contract-test pattern to mirror | `tests/gitnexus/gitnexus-cli-contract.json` + `tests/gitnexus/cli-contract.ts` + `contract.test.ts` |
| Repo layering rule to respect | cap-rejection.ts header: `src/providers/` imports no tier-3 workspace code (R3 §9.2) — new `src/judgment/` must sit above providers or beside lib; Wave 0 confirms the clean layer |

## 6. Adversarial review digest (15 findings — settled; full text in session memory of 2026-09-22)

CONFIRMED and absorbed into §3/§7: (1) egress class + redactSecrets inadequacy → §3.7/3.8; (2) calibration set didn't exist → §3.11; (3) BLOCKER positives ≈3 → §3.9; (4) audit hop is contract change → §3.4; (5) divergent tamper alarm on re-emits → §3.4; (6) uncertainty has no gate home → §3.5; (7) SDK duplicates unified idiom → §3.3; (8) no pin → §3.6; (9) S1 replaces only cheap half → §3.10; (11) 12x/10x unmeasured → measure or claim nothing; (12) verify-pass unpriced → verify pass is the frontier session (already running), specified in S-C; (13) ~150-line estimate wrong → sized as story pair, hindsight/client.ts is the reference; (14) cite by symbol → §0.5; (15) triage is the cold path → this work is a sensor-layer bet on autonomous cadence, stated as experiment not optimization. PARTIAL: (10) ledger-match noul and S5 graph noul cut; semantic AC-mapping deferred. NOT adopted: none without stated rationale above.

## 7. Work plan

### Wave 0 — recon (3 parallel read-only subagents, no writes)
- **R1 Corpus:** read all 16 `_bmad-output/workflow-state/code-review/*/triage.md` (+ `reports/*.md` siblings). Return: field inventory actually present per file, which are machine-parseable, row counts, disposition-vocabulary histogram, and a proposed corpus record schema + backfill feasibility % per file. Do NOT write the schema file yet.
- **R2 Seams:** locate run-record side-channel mechanism (`src/providers/run-record.ts`: extensions or equivalent — name the exact field/API and its validation); confirm `src/lib/http.ts` surface (exports, error types, timeout/retry seams); confirm hindsight mock-mode pattern worth copying; confirm where `src/judgment/` sits in the layer graph without violating R3 §9.2 or provider import bans. Return: exact symbols to build against + one-layer-dependency diagram.
- **R3 Triage hookpoint:** find where the review workflow's triage step executes today (BMad review skill flow; which script/session writes triage.md; is there a deterministic hook or is it pure Claude-session?). Determine the cleanest capture point for S-A's writer (CLI script vs skill instruction) and what identifiers exist at that moment (pr, round, finding ids). Return: hookpoint recommendation with file:symbol evidence.

**Gate 0→1:** orchestrator reads 3 summaries, resolves: corpus schema shape, judgment module location, capture mechanism (script vs skill edit). Update §2/§11.

### Wave 1 — specs (single agent, or orchestrator if small)
Write two story specs (BMad format, matching existing `_bmad-output` story structure — copy an existing story file as template):
- **Story A — triage corpus capture:** schema (zod) for the record — MUST include the §3.12 A/B fields (`arm`, `latency_ms`, `cost_exact_usd` | `cost_estimate_usd`, `outcome_confirmed`, `outcome_source`); writer (script or skill-instruction hook per R3); backfill script for parseable ledgers with `labeler: agreement-with-claude`; tests; DONE = new triage rounds emit records + backfill produces ≥1 parseable file's worth.
- **Story B — `src/judgment/` core:** client on `src/lib/http.ts` + zod (request/response schemas, strict, §4 contract); mock mode (env `TYPESAFE_MOCK=1` → deterministic canned answers, zero network — EVERYTHING in waves 0–4 runs green without a key); envelope type with provenance (`{requestId, model: "jev-1.13.0", questions, answers, usage, egress_class, created_at}`); egress choke-point function (class validation + per-class redaction, §3.7/3.8); stage ceiling circuit breaker; contract test on pinned model + response shape (§3.6); run-record side-channel emit with digest-stable detail; log-line contract matching house log shape; tests. DONE = `bun test tests/judgment/` green in mock mode, tsc + biome clean.
- Run `qds-story-review` hardening on both specs. Fix findings (same triage discipline: fix all, or record dismissal rationale).

**Gate 1→2:** specs hardened; steve-visible summary posted in chat.

### Wave 2 — implementation (2 parallel subagents, one per story, feature branches `feature/jev-corpus-capture` and `feature/jev-judgment-core`)
Each agent: implement own story, tests first per repo convention, `detect_changes()` before commit, NEVER push or open PR (orchestrator does). Return: ≤40-line summary + test log path.

**Gate 2→3:** both branches green standalone + merged to an integration branch locally; suite green; no audit/gate-runner/providers symbol touched (detect_changes proves it).

### Wave 3 — S1 observer (single subagent on `feature/jev-s1-observer`)
Wire the observer: at the triage stage (mechanism per R3), for each finding build a SMALL state (finding text + minimal context — respect 32k state budget), ask `is_real_defect` (noul) + `disposition` (choice) + nothing else; write results as corpus records with `labeler: jev-1.13.0-observer` alongside the human/lead labels; emit envelope provenance to the run-record side channel. Mock mode default; real calls only when `TYPESAFE_API_KEY` is set AND steve has said go in chat (real spend = opt-in). No threshold, no routing behavior change, no gate authority — pure recording.

**Gate 3→4:** paired-label records appear (mock); suite green; steering doc updated.

### Wave 4 — verification + PR + measurement (parallel: V1 full-suite runner; V2 A/B report agent — builds the script that renders the speed/performance/cost table per §3.12: per-question agreement, latency both arms, exact-vs-estimated cost, outcome-validated precision as data accrues; no magic thresholds; V3 PR-prep agent assembling branch → PR description from §6 digest + story docs)
Orchestrator: reviews V outputs, merges integration branch, runs full `bun test` tee'd to log, opens PR to `dev`, posts summary. DONE = PR open, CI-equivalent suite green, measurement script ready, §2 board complete.

## 8. Guardrails (violating any = stop and surface)

- `TYPESAFE_API_KEY` never hardcoded, never logged, never enters a box; read via env at client construction only.
- No diff hunks or third-party bot prose shipped to the API in stage 1 (finding text authored by the lead + AC prose only; bot-comment text stays behind the feedback-run INV-7 fence).
- Never edit: `AUDIT_HOPS`, `gate-runner.ts` verdict logic, `classifyRunExit`, `classifyDiffScope`, provider layer (§5 layering rule). New code only + the one capture hookpoint.
- No real API spend without explicit steve go in chat; mock mode is the default everywhere.
- Subagents never commit to `dev`, never push, never open PRs. Orchestrator commits with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Corpus records containing finding text stay in-repo under `_bmad-output/` (already the home of such artifacts).

## 9. Definitions of done (whole mission)

1. New triage rounds emit schema'd corpus records without manual steps.
2. `src/judgment/` exists: strict-typed client, mock mode, pinned-model contract test, egress choke point, provenance envelope, side-channel emit (digest-stable), stage ceiling.
3. S1 observer produces paired labels per finding when enabled.
4. A/B measurement script (§3.12): one command renders the speed/performance/cost table — ready for the moment real paired labels accumulate.
5. Everything green in mock mode with NO env key; full suite green; PR to `dev`.
6. `arm-thresholds` is explicitly NOT done — it waits for measured calibration + steve sign-off.

## 10. Open items (owner: steve)

- Vendor email (ZDR addendum, retention schedule, subprocessor list, incident notice, rate-limit tier) — steve handles. Stage-2 hunks + any enterprise-tier work waits on the reply.
- Real-key go/no-go for observer calls (after Wave 2 mock-green).
- **Monthly bill alarm (§3.2 third spend control)** — owned by steve in the vendor billing console, OUTSIDE the repo; no story implements it (settled Wave 5, JEV2-V9).

## 11. Wave outcomes (append-only log)

<!-- Wave 0 outcome (2026-09-22):
RECON DONE (R1 corpus / R2 seams / R3 hookpoint, all read-only).
R1: 13 triage ledgers (not 16 — df1-10-r6, e2e-audit, pr185 are raw pre-triage, unbackable). Best backfill: pr184/round4 90%, pr123 + pr128-r5 85%. Unbackable everywhere: created_at (day-granular), labeler (~half), arm/latency/cost. GATE-ACTION: 0 historical occurrences. Historical vocab: PATCH 123 / DEFER 41 / DISMISS 32 / DECISION_NEEDED 14 / POST_MERGE_CHANGED 2. INV-7 clean in all ledgers; EXCLUDE from backfill: pr135/pr-comment.md, pr135/pr-comment-round7.md, pr184/HANDOFF-round2.md (bot prose).
GATE RESOLUTIONS:
1. Schema: finding_id, finding_text(req), diff_context_ref(req), label(req), disposition(req), rationale(optional), labeler(req), pr, round, created_at + reserved arm/latency_ms/cost_exact_usd|cost_estimate_usd/outcome_confirmed/outcome_source (nullable). Disposition enum = 5 historical + GATE_ACTION (widened from §3.9 triad — agreement-vs-lead metric needs shared vocab; LOCKED intent preserved: no severity, no gating; calibration claims restricted to classes with examples). zod schema.
2. Module: src/judgment/ imports ONLY src/lib/http.ts + swarmclaw/log (hindsight precedent). NO providers import → side-channel emit = §3.4 FALLBACK (side JSON log keyed by requestId, default _bmad-output/judgment/envelopes/). Reason: real side channel = EXTENSION_NAMESPACES allow-list in src/providers/run-record.ts; new ns = provider file edit = banned by §8.
3. Capture: skill-instruction edit — step-03-triage.md final act writes <workdir>/triage.json (unified findings + pr + round) — proven step-02 Write-file contract, structured data only exists in-session at triage moment. Repo side: scripts/corpus/ zod schema + validate/merge/backfill CLIs → JSONL records under _bmad-output/judgment/corpus/. NOTE FOR STEVE: skill file lives at ~/.claude/skills/bmad-code-review/ — outside repo, cannot ride the PR; steve owns that file.
Wave 1 next: two story specs (BMad format) + qds-story-review hardening. -->

<!-- Wave 1 outcome (2026-09-22):
SPECS + HARDENING DONE. Files: stories/jev-1-corpus-capture.md (3pts), stories/jev-2-judgment-core.md (4pts) — BMad format off df6-1a template, parallel-safe (zero file overlap). Hardening campaign = full qds-story-review protocol: initial scan 22 findings (1B/4H/11M/6L) → steve sign-off (frontier stamp / strict+rationale / hardcode+ADR) → waves 0–4 fixed by one paired agent → Wave 5 fresh-eyes verify FAIL (14 new: JEV1-V1 HIGH = frontier latency/cost had no data path; 13 M/L) → 5b/5c re-fix 11 story findings + 3 parent-fixed (handoff §5/§10, ADR ACCEPTED). Campaign total 36 findings, all ✅ DONE — tracker: 2026-09-22-jev-pre-dev-adversarial-review.md. ADR 0001 ACCEPTED (egress max-class code-pinned; config knob ships with stage-2 ZDR work). Orchestrator spot-read closed 2 residual nits (stale 16-dir count on jev-1 §Spec Reference; cost_estimate_usd formula now pinned = duration_ms × QDS_FRONTIER_USD_PER_MS env, null until steve calibrates rate). Steve-visible at gate: disposition enum widened to 6 (evidence-driven, intent preserved); side-channel = §3.4 fallback provenance/ dir (provider edit banned); capture hookpoint = steve-owned ~/.claude/skills/bmad-code-review/step-03-triage.md edit (Appendix A of jev-1 = paste-ready sidecar contract); TYPESAFE_API_KEY in .env (gitignored) — spend still gated on explicit go.
Wave 2 next: 2 parallel impl agents, branches feature/jev-corpus-capture + feature/jev-judgment-core, NEVER push/PR (orchestrator does). Gate 2→3 = both green standalone + local integration merge + detect_changes proves no banned surface touched. -->

<!-- Wave 2 outcome (2026-09-22):
IMPLEMENTATION DONE, GATE 2→3 PASSED. Two parallel agents in git worktrees (feature/jev-corpus-capture @ 3c0579b0 = 15 files/1423 ins: scripts/corpus/{schema,validate,merge,backfill,index}.ts + tests, 32/0 green, tsc+biome clean, real-ledger e2e pr184-r4 108/108 + pr123 91/91; feature/jev-judgment-core @ a7b0aeee = 17 files/2067 ins: src/judgment/{client,schemas,egress,envelope,ceiling,emit,index}.ts + scripts/judgment/live-probe.ts + 8 test suites + typesafe-api-contract.json, 75/0 keyless mock green ×3, tsc+biome clean). Deviations (all accepted): spawnSync for exit-code tests; private test log paths (--); merge/backfill --out flag default unchanged (INV-C3); forward labeler default "frontier-lead"; judge() ships state as redacted string (non-string JSON.stringify'd through choke point); live-probe gate flag = QDS_LIVE_PROBE_CONFIRMED=1; 2 extra test files (fence, probe-gate).
Integration branch integration/jev = dev + both merges + 1 fix (8b4a8f39: backfill test capture via subprocess — console.log monkeypatch raced parallel judgment suites, truncated summary line, INV-C2 assertion failed only on integrated tree; 107 corpus+judgment tests green together post-fix). Full suite 6560 tests: 6494 pass, 3 fail = 2× story-consistency slate sprint-status drift (pre-existing on dev, slate bookkeeping, unrelated) + corpus race (fixed). detect_changes compare vs dev: 0 changed symbols, low risk, no banned surface (AUDIT_HOPS/gate-runner/classifiers/providers untouched). Worktrees removed; feature branches kept local.
Spend gate: STILL LOCKED — mock-only until steve says go in chat. .env has TYPESAFE_API_KEY but nothing calls live.
Wave 3 next: S1 observer, single agent, branch feature/jev-s1-observer FROM integration/jev. Scope per §7 Wave 3 + campaign-learned constraints (observer lives under scripts/, imports scripts/corpus barrel + src/judgment; jev choice→enum normalization {patch→PATCH, dismiss→DISMISS, gate-action→GATE_ACTION}; small per-finding states, 32k budget, warnWhenStateCharsOver; no threshold/no routing/no gate authority; mock default, live = key + steve go). -->

<!-- Wave 3 outcome (2026-09-22):
S1 OBSERVER DONE, GATE 3→4 PASSED. feature/jev-s1-observer @ 1c2f1628 (3 files/720 ins: scripts/judgment/observe-round.ts 335 + tests 383 + fixture), merged to integration/jev @ b419578a. 125 tests green together on integration (18 new), tsc+biome clean, 0 changed symbols. Behavior: reads frontier records from corpus JSONL (--pr/--round), per-finding small state (finding_text + diff_context_ref + ids; >100k chars = pre-flight refusal), exactly 2 questions (noul is_real_defect + choice disposition patch/dismiss/gate-action), maps choice→enum, noul+probability ride rationale text, labeler=jev-1.13.0-observer, arm=jev, latency_ms + cost_exact_usd (input_tokens×0.042/1e6) from envelope, appendRecord idempotent under corpus run-lock, provenance free via client emit, CLI default = client no-mode = ALWAYS MOCK (live unreachable without code change + key + steve go). Ceiling mid-round: judged prefix stays (appendRecord per-record, no batch rollback) — refusal + exit 2 + tests pin it. Deviations (accepted): imports 4 internals from scripts/corpus/merge.ts beyond barrel (barrel untouched — my no-existing-file-touch constraint); --provenance-dir + --ceiling-tokens test knobs. NOTE: agent interrupted once pre-code; resume nudge worked.
Wave 4 next: V1 full suite (orchestrator runs tee'd), V2 A/B report script agent (renders §3.12 table from corpus JSONL — per-question agreement, latency both arms, exact-vs-estimated cost, outcome-validated precision; no magic thresholds), V3 PR-prep agent (description from §6 digest + story docs) — parallel; then orchestrator merges, opens PR to dev, posts summary. DONE = PR open, suite green, measurement script ready, §2 board complete. arm-thresholds explicitly NOT done. -->

<!-- Wave 4 outcome (2026-09-22): MISSION COMPLETE (except §9.6 arm-thresholds — deliberately NOT done, waits on measured calibration + steve sign-off).
V2: feature/jev-ab-report @ 2c1ca52b — scripts/judgment/ab-report.ts + 19 tests, 144/0 combined, no thresholds, unpopulated sections print "not yet available"; merged 4090619f. V3: PR package assembled (orchestrator corrected its stale "docs untracked" claim — docs were committed in wave 1, handoff outcomes committed d37931fb). V1 full suite on final tree: 6597 tests / 209 files — 3 fails all verified non-product (2× slate story-consistency drift = pre-existing on bare dev; 1× test-results drain-backstop timing flake, green ×2 isolated, sibling timing test flaked under load in an earlier run). detect_changes vs dev: 0 symbols, low risk, 39 files.
**PR #278 OPEN: integration/jev → dev — https://github.com/Quantum-Digital-Solutions/QDS-Factory/pull/278**
§9 DoD: (1) new triage rounds emit records ✓ (pending steve's out-of-repo skill edit — Appendix A paste); (2) src/judgment/ complete ✓; (3) S1 observer paired labels ✓ (mock); (4) A/B script one command ✓; (5) green mock keyless + full suite + PR ✓; (6) arm-thresholds NOT done ✓ (by design).
STEVE'S OPEN ITEMS: (a) paste Appendix A into ~/.claude/skills/bmad-code-review/steps/step-03-triage.md (final act: Write <workdir>/triage.json); (b) real-spend go/no-go for observer rounds (key in .env, nothing calls live); (c) optional: QDS_FRONTIER_USD_PER_MS rate in .env to enable frontier cost estimates; (d) vendor email thread (ZDR/stage-2) unchanged. After PR merges to dev: feature branches (jev-corpus-capture, jev-judgment-core, jev-s1-observer, jev-ab-report) can be deleted; integration/jev branch deleted post-merge. -->
