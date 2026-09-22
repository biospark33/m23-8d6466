# JEV Story Pair — Pre-Dev Adversarial Review — Findings, Plan, and Tracker

**Created:** 2026-09-22
**Status:** ACTIVE — fixes pending
**Scope:** `_bmad-output/typesafe-integration/stories/jev-1-corpus-capture.md` + `jev-2-judgment-core.md`
**Goal:** Resolve all findings before Wave 2 implementation so the pair is bulletproof.

Pattern doc: `_bmad-output/typesafe-integration/handoff.md` (§3 LOCKED = settled law).
Vendor authority: `typesafe:typesafe-ai` skill (contract verified EXACT against live docs — zero contradictions).
Pairing: ONE dependency-pair (shared contracts: disposition enum, finding_text/INV-7, §3.12 A/B axis, schema export seam, mock switch). All waves dispatch 1 agent owning both files.

## Executive Summary

| Severity | Count |
|---|---|
| BLOCKER | 1 |
| HIGH | 4 |
| MEDIUM | 11 |
| LOW | 6 |

Coherence: symbol-level claims check out against the real tree; weaknesses cluster at the Wave-3 seam (observer owned by neither story) and two honesty gaps (contract test can't smell the wire; labeler AC self-contradiction). No redesign needed — all fixes are line/paragraph spec edits plus one small probe script.

## Status Dashboard

| Severity | TODO | IN_PROGRESS | DONE | DEFERRED |
|---|---|---|---|---|
| BLOCKER | 0 | 0 | 1 | 0 |
| HIGH | 0 | 0 | 4 | 0 |
| MEDIUM | 0 | 0 | 11 | 0 |
| LOW | 0 | 0 | 6 | 0 |

### Wave progress

| Wave | What | Status |
|---|---|---|
| Initial scan | 1 paired reviewer; tracker created | ✅ DONE |
| 0 — Cross-cutting | CC-1 A/B axis, CC-2 Wave-3 seam | ✅ DONE |
| 1 — BLOCKERs | JEV2-B1 | ✅ DONE |
| 2 — HIGHs | JEV1-H1/H2, JEV2-H1/H2 | ✅ DONE |
| 3 — MEDIUMs | 11 items | ✅ DONE |
| 4 — LOWs | 6 items, single bundled | ✅ DONE |
| 5 — Verification | fresh-eyes paired verifier | ✅ DONE |
| 5b/5c — re-fix | as surfaced | ✅ DONE |

## Cross-cutting themes (Wave 0)

### CC-1 — §3.12 A/B axis completeness (spans both stories)
**Affects:** JEV1-H2, JEV2-H2. Frontier arm records must carry `arm: "frontier"` (not null) and the JEV-2 envelope must carry `latency_ms` — else the agreement-with-lead join has no selectable frontier population and the jev arm loses its latency metric.
**Fix:** JEV-1 AC1: five reserved fields null, `arm` stamped `"frontier"` on skill-sidecar + backfill records. JEV-2 envelope: add `latency_ms: number` measured around `judge()`; E2E observable line added.

### CC-2 — Wave-3 observer seam ownership (spans both stories)
**Affects:** JEV1-M4, JEV2-M7 (+ JEV1 AC5). The observer is named as consumer in both stories, owned by neither.
**Fix:** JEV-1: `merge.ts` exports `appendRecord` (drop "or equivalent"). Both stories: one sentence — Wave-3 observer lives under `scripts/` (imports `src/judgment/` + `scripts/corpus/` without tripping JEV-2's two-import fence). JEV-1 Technical Notes: Jev choice→enum normalization map `{patch→PATCH, dismiss→DISMISS, gate-action→GATE_ACTION}`; other enum values unreachable from jev arm.

## Tracker: BLOCKERs

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| JEV2-B1 | JEV-2 | Contract test cannot detect upstream drift (never touches wire) | ✅ DONE | fix-jev | fix = honest DoD + live-probe script, steve-gated |

**JEV2-B1 recipe:** (1) keep `tests/judgment/contract.test.ts` as in-repo pin; (2) add `scripts/judgment/live-probe.ts` — one canonical minimal request when `TYPESAFE_API_KEY` set AND steve-gated, diffs response vs `typesafe-api-contract.json`, exit 2 on drift; (3) re-calibration ritual documented in contract file header (docs.typesafe.ai/models.md append `.md`); probe referenced from drift playbook.

## Tracker: HIGHs

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| JEV1-H1 | JEV-1 | AC4(d) vs 4(e) contradict on labeler | ✅ DONE | fix-jev | CC: none |
| JEV1-H2 | JEV-1 | Forward records stamped arm:null — severs §3.12 axis | ✅ DONE | fix-jev | CC-1 |
| JEV2-H1 | JEV-2 | Hunk-refusal fixture has no implementable semantics | ✅ DONE | fix-jev | CC: none |
| JEV2-H2 | JEV-2 | Envelope lacks latency_ms | ✅ DONE | fix-jev | CC-1 |

**JEV1-H1 recipe:** Strike "(labeler where absent historically…)" from AC4(e) — only arm/latency/cost/outcomes are null-when-unbackable. Technical Notes: "`labeler` is always the provenance class (forward = lead identity, backfill = `agreement-with-claude`) — records WHO labelled, not whether source named one."
**JEV1-H2 recipe:** see CC-1.
**JEV2-H1 recipe:** Reword INV-J2 test: "fixture DECLARING `diff-hunk` at stage 1 refused with ZDR-gate error" + new test "unknown/absent class refused". Note: content-level hunk detection out of scope; fence = declaration-discipline at the seam, owned by JEV-3 state builder.
**JEV2-H2 recipe:** see CC-1.

## Tracker: MEDIUMs

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| JEV1-M1 | JEV-1 | Stale inventory: 14 dirs not 16 + stray `df3-3-selfreview.diff` FILE | ✅ DONE | fix-jev | |
| JEV1-M2 | JEV-1 | Backfill letter-code alias table unspecified (pr184 P/D/X/DN→) | ✅ DONE | fix-jev | |
| JEV1-M3 | JEV-1 | INV-C2 forward path: zero enforcement/detection | ✅ DONE | fix-jev | |
| JEV1-M4 | JEV-1 | `appendRecord` unowned; observer module location unpinned | ✅ DONE | fix-jev | CC-2 |
| JEV2-M1 | JEV-2 | Mock/live precedence + live-without-key behavior unpinned | ✅ DONE | fix-jev | |
| JEV2-M2 | JEV-2 | Strict-at-runtime diverges from hindsight precedent, unstated | ✅ DONE | fix-jev | decision: strict+rationale |
| JEV2-M3 | JEV-2 | INV-J1 maskEnv unsatisfiable under two-import fence | ✅ DONE | fix-jev | |
| JEV2-M4 | JEV-2 | "Stage" never defined; ceiling attribution unknown | ✅ DONE | fix-jev | |
| JEV2-M5 | JEV-2 | Egress max-class hardcoded vs §3.7 "config selects" | ✅ DONE | fix-jev | decision: ADR amendment |
| JEV2-M6 | JEV-2 | No request-size budget owner (64k/32k limits) | ✅ DONE | fix-jev | |
| JEV2-M7 | JEV-2 | Jev choice↔corpus disposition mapping owned by nobody | ✅ DONE | fix-jev | CC-2 |

**Recipes:**
- **JEV1-M1:** AC4 given → "every entry under `_bmad-output/workflow-state/code-review/`"; AC4(b) add "non-directory entries reported skipped, never read". Drop the count.
- **JEV1-M2:** Technical Notes mapping row: `P/PATCH→PATCH; D/DEFER→DEFER; X/DISMISS→DISMISS; DN→/DECISION_NEEDED→DECISION_NEEDED; POST_MERGE_CHANGED→POST_MERGE_CHANGED; anything else → skipped-with-reason in yield report (never guessed)`.
- **JEV1-M3:** DoD item: merge.ts prints per-run summary (written/skipped/duplicate-skipped) + doc note that finding_text provenance is the skill edit's contract; honest-limitation negative fixture.
- **JEV1-M4:** see CC-2.
- **JEV2-M1:** Overview sentence: "Resolution order: `TYPESAFE_MOCK=1` forces mock (overrides everything); else constructor `mode`; else default `mock`. Live additionally requires non-empty `TYPESAFE_API_KEY`, else constructor throws." Named test.
- **JEV2-M2:** DECIDED (steve): keep `.strict()` at runtime; §Technical Notes states deliberate divergence + rationale: "recording-only: a refused judgment is safer than an unparsed one — availability cost accepted until first live round."
- **JEV2-M3:** INV-J1 sentence: "this client performs NO env diagnostics — key read once at construction, never echoed; no masking helper needed or imported."
- **JEV2-M4:** One paragraph: stage = one `JudgmentCeiling` instance held by caller for the stage's process lifetime; in-memory counter (per-process breaker, acceptable for batch); `judge()` refuses with typed `CeilingExceededError` carrying observed-vs-ceiling.
- **JEV2-M5:** DECIDED (steve): keep stage-1 hardcoded; ADR amendment (PROPOSED) at `_bmad-output/typesafe-integration/adr/0001-egress-max-class-code-pinned.md`: "max class is code-pinned per stage; config knob ships with stage-2 ZDR work."
- **JEV2-M6:** Technical Notes: client documents (not enforces) 64k/32k budgets; `warnWhenStateCharsOver` default ~100k chars logs house-shaped warning; pre-flight sizing owned by JEV-3 (boundary note).
- **JEV2-M7:** see CC-2.

## Tracker: LOWs

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| JEV1-L1 | JEV-1 | Sidecar validation schema unspecified | ✅ DONE | fix-jev | |
| JEV1-L2 | JEV-1 | Handoff §5 stale "pr123 = pure prose" unflagged | ✅ DONE | fix-jev | |
| JEV1-L3 | JEV-1 | Reuse scripts/lib/cli-args.ts | ✅ DONE | fix-jev | |
| JEV2-L1 | JEV-2 | mockBody listed "(verified)" but module-private | ✅ DONE | fix-jev | |
| JEV2-L2 | JEV-2 | No injected-fetch seam; retry delay no test knob | ✅ DONE | fix-jev | |
| JEV2-L3 | JEV-2 | 401/422 error discards vendor offending-field detail | ✅ DONE | fix-jev | |

**Recipes:**
- **JEV1-L1:** `TriageSidecarSchema` named export in `schema.ts` (top-level pr/round/findings + per-finding required/optional per Appendix A).
- **JEV1-L2:** §Spec Reference clause: "(handoff §5's 'pr123 = pure prose' is stale — file is a parseable table; §11 R1 digest correct)."
- **JEV1-L3:** Technical Notes: "flag parsing + failure exits from `scripts/lib/cli-args.ts` (`tokenizeArgs`, `parseValueFlags`, `exitWithFailure`)."
- **JEV2-L1:** Drop `mockBody` from build-against list or reword: "private precedent to copy, not an import."
- **JEV2-L2:** Reword to "globalThis.fetch stub harness per hindsight suite idiom"; `JudgmentClientOptions` test-only `retryDelayMs` override.
- **JEV2-L3:** AC2 add: "thrown error carries response body text (truncated) for field-level diagnosis," mirroring `HindsightHttpError`.

## Verified-correct elements (do NOT undo)

### JEV-1
- Disposition enum = 5 historical + GATE_ACTION (matches R1 histogram exactly); "LOCKED, do not narrow" note correct.
- pr123/triage.md IS a parseable table — E2E candidate choice correct (over stale handoff §5).
- Backfill honesty rules (created_at day-or-null, never fabricate; labeler agreement-with-claude) match R1.
- Exclusion list exact filenames match §11 R1 verbatim; files exist.
- zod `.strict()`/`.nullish().default(null)`/`z.enum` valid on installed 3.25.76; merge idempotence keyed (pr, round, finding_id, labeler) coherent with append-only JSONL.
- No src/ touched, no package.json change — §3.3 respected, story standalone.

### JEV-2
- Two-import fence fence-clean AND correct: log.ts header invites non-MCP modules; hindsight's maskEnv/tool-bridge import is the trap avoided.
- `httpRequest`/`HttpPolicy`/`HttpResult`/`retryAfterMs`/`MAX_RETRY_AFTER_MS` exist with claimed semantics; retryAfterMs already caps.
- POST-retry divergence (maxAttempts 2, retryOn 429/529) sound for read-only judgments; not a credentials.ts violation.
- Side-channel FALLBACK verified right: `EXTENSION_NAMESPACES` frozen allow-list; new ns = banned provider edit.
- Mock-mode env divergence from hindsight declared deliberate.
- Response-shape claims match live docs exactly (noul no confidence; choice/score shapes).
- noul+choice only, no severity, no gate-runner/audit contact, frozen-surfaces AC8 matches CLAUDE.md.

## Wave-5 verification findings (fresh-eyes pass — verdict FAIL, 14 findings)

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| JEV1-V1 | JEV-1 | HIGH: frontier-arm latency_ms/cost_estimate_usd have no data path | ✅ DONE | refix-jev | fix = sidecar extension (option a); does NOT touch §3.12 LOCKED |
| JEV1-V2 | JEV-1 | TN contradict AC-4 on backfill stamping; day-granular source doesn't exist | ✅ DONE | refix-jev | |
| JEV1-V3 | JEV-1 | Alias table doesn't match real ledger encodings (bold cells, compounds, **N**) | ✅ DONE | refix-jev | |
| JEV1-V4 | JEV-1 | Histogram completeness check unsatisfiable (POST_MERGE_CHANGED literal absent) | ✅ DONE | refix-jev | |
| JEV1-V5 | JEV-1 | INV-C1 overstates enforcement (shape-only; secrets in free text unchecked) | ✅ DONE | refix-jev | |
| JEV1-V6 | JEV-1 | Backfill idempotence + append concurrency unspecified | ✅ DONE | refix-jev | |
| JEV2-V7 | JEV-2 | Request schema looser than live contract (criteria required per type; state union; usage sub-shape) | ✅ DONE | refix-jev | |
| JEV2-V8 | JEV-2 | No runtime model-identity check (pin z.literal on response model) | ✅ DONE | refix-jev | |
| JEV2-V9 | JEV-2 | §3.2 monthly bill alarm unowned | ✅ DONE | team-lead | parent fix: owner named in handoff §10 |
| JEV2-V10 | JEV-2 | ADR 0001 PROPOSED yet load-bearing for Wave 2 | ✅ DONE | team-lead | parent fix: steve acceptance recorded; ADR → ACCEPTED |
| JEV1-V11 | JEV-1 | Import barrel/export names unpinned (no scripts/corpus index.ts) | ✅ DONE | refix-jev | |
| JEV2-V12 | JEV-2 | Emit file layout + re-emit semantics unspecified; envelopes/ name misleads | ✅ DONE | refix-jev | |
| JEV2-V13 | JEV-2 | TYPESAFE_MOCK non-"1" values unspecified | ✅ DONE | refix-jev | |
| GEN-V14 | handoff | §5 stale (pr123 prose claim; 16 dirs) | ✅ DONE | team-lead | parent fix: handoff §5 corrected |

### Wave-5 fix recipes (5b/5c)

- **JEV1-V1:** Appendix A per-finding optional `latency_ms` (preserve-or-null, same rule as created_at) + top-level optional `duration_ms` input for the frontier cost estimate; merge preserves-or-nulls into reserved fields; skill's final act records per-finding elapsed time. (Option (a) — completes §3.12 without LOCKED edit.)
- **JEV1-V2:** One rule stated once: backfill derives day-granular created_at from dates INSIDE the ledger file when present, else null; reword the two contradicting TN sentences to match AC-4(d)/(e).
- **JEV1-V3:** Normalization rule: strip markdown emphasis; split trailing annotations (e.g. "(comment)") into `rationale`; compound `DN→X` cells map to X with the compound preserved in rationale; unknown codes (incl. `N`) → skipped-with-reason, never guessed. Add per-encoding fixtures (pr123 words, pr184 letter+bold+compound, pr128-r5 N).
- **JEV1-V4:** Drop the "2 POST_MERGE_CHANGED rows must come out somewhere" sentence; replace with: completeness baseline = the parser's own counts published in the backfill yield report on the two named ledgers (pr123, pr184/round4).
- **JEV1-V5:** Reword INV-C1: enforcement is shape-only (strict schema blocks unknown KEYS, not secret content in free text); secret exclusion in finding_text/rationale is the skill contract; per-class redaction applies at Jev egress only, not the corpus file.
- **JEV1-V6:** AC-2 extended to BOTH writers (merge.ts + backfill.ts) with one idempotence test each; single-writer assumption stated (cold path) OR scripts/lib/run-lock.ts reuse named — pick run-lock reuse.
- **JEV2-V7:** Technical Notes: per-type discriminated question schema (choice: criteria REQUIRED map ≤255 options; score: criteria REQUIRED ordered array 2–10 levels; noul: criteria optional {true?, false?}); state accepts string|object|array; usage = {input_tokens, output_tokens}, billing input-token-only (cost = input_tokens × $0.042/Mtok). Contract json pins them.
- **JEV2-V8:** Response schema: `model: z.literal("jev-1.13.0")` — the only automated identity guard; consistent with strict posture.
- **JEV1-V11:** Add `scripts/corpus/index.ts` barrel to files-touched; pin export names once: `TriageRecordSchema`, `TriageSidecarSchema`, `DISPOSITIONS` (or `Disposition` enum), `appendRecord`.
- **JEV2-V12:** Pin layout: one file per requestId under `_bmad-output/judgment/provenance/` (renamed from envelopes/); second write with identical digest = no-op, different digest = typed `DigestDivergenceError`; AC-6 wording updated. Add one sentence (§3.4 fidelity note): the fallback logs; it does not alarm — digest divergence is a tested property, not a store-level tamper alarm.
- **JEV2-V13:** One clause: forced mock iff value is exactly `"1"`; any other value (incl. `"0"`) ignored.
- **JEV2 fence clause:** one sentence — the two-import fence covers repo-internal imports; zod (external) is obviously allowed.



## Session log (append-only)

- 2026-09-22 | team-lead (initial review) | DONE: scan captured, tracker created | IN_PROGRESS: steve sign-off | NOTES: 22 findings; 2 steve decisions embedded (JEV2-M2 strict+rationale, JEV2-M5 ADR-over-knob); vendor contract verified clean via typesafe:typesafe-ai skill.
- 2026-09-22 | steve (sign-off) | DONE: 3 decisions locked | NOTES: JEV1-H2 = stamp arm:"frontier"; JEV2-M2 = strict+rationale; JEV2-M5 = hardcode + ADR 0001 (PROPOSED, written by parent).
- 2026-09-22 | fix-jev (waves 0–4, single paired agent) | DONE: CC-1, CC-2, JEV2-B1, all H/M/L (22/22) | NOTES: one conflict resolved (JEV1-H1 gloss superseded by CC-1 arm ruling — AC4(e) now lists latency/cost/outcomes null-unbackable, arm+labeler always stamped); only 2 story files touched; JEV1-M2 rendered DN-code mapping as `DN/DECISION_NEEDED→DECISION_NEEDED` (tracker recipe had stray arrow).
- 2026-09-22 | verify-jev (wave 5, fresh-eyes paired verifier) | DONE: verification pass | VERDICT: FAIL — 14 new findings (JEV1-V1 HIGH + 13 M/L) | NOTES: contract alignment mostly ALIGNED (3 DRIFT items → V1/V2/V13); LOCKED fidelity 11 INTACT, §3.7 documented-drift pending acceptance (V10), §3.12 partial (V1); buildable except listed ambiguities. 5b/5c dispatched.
- 2026-09-22 | team-lead (wave 5 parent fixes) | DONE: JEV2-V9, JEV2-V10, GEN-V14 | NOTES: handoff §10 names steve as monthly-bill-alarm owner (billing console, outside repo); ADR 0001 PROPOSED→ACCEPTED (steve selected hardcode+ADR in structured sign-off 2026-09-22); handoff §5 corrected (pr123 IS a parseable table; 14 dirs + df3-3-selfreview.diff file).
- 2026-09-22 | refix-jev (waves 5b/5c) | DONE: JEV1-V1/V2/V3/V4/V5/V6/V11, JEV2-V7/V8/V12/V13, fence clause (11/11) | VERDICT: zero §3 conflicts; JEV-1 130→133 lines, JEV-2 100→100; porcelain clean (2 story files only). Campaign COMPLETE pending orchestrator spot-read.
