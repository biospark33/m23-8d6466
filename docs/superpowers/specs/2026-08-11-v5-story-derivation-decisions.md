# Dark Factory v5 — Story Derivation Decision Register

**Date:** 2026-08-11
**Status:** ACTIVE — governs the DF story backlog derivation
**Derives from:** `2026-08-11-dark-factory-v5-architecture-design.md` (r2) §8 ·
`2026-08-11-story-disposition-audit.md` (F14) §3/§4/§6 ·
`2026-08-11-pre-derivation-gates-report.md` §4
**Rule honored:** the three documents above are closed records and are not modified; every
new decision made at derivation time is recorded here. Sizing/dependency evidence:
`_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md`.

---

## 1. Namespacing & layout (SPL-017 collision check: clean)

| Decision | Value |
|---|---|
| Epic code | **DF** (Dark Factory) — no collision with existing codes (phase-0/P0, phase-1/P1, phase-2/P2) |
| Sub-epics | DF1–DF5 = §8 build-order steps 1–5; **DF6** = the "5+" PR-feedback loop (DD-4) |
| Story IDs | `DF{step}.{n}` (e.g., DF1.6) |
| Story files | `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df{step}-{n}-{kebab-title}.md` |
| Retired superstructure | phase-0/phase-1 story files stay in place as historical record; sprint-status.yaml gains DF epic blocks and marks phase-1 stories per the F14 disposition (RETIRE / KEEP-repointed / superseded-by-DF successor) |
| Module roots | New code: `src/phase-engine/*` (DF1) · `src/providers/*` (DF2) · `src/fleet/*` (DF3) · flat `src/` domains per R3 §9.1 for DF5/DF6 (`src/reverify/`, `src/pr/`, `src/audit/`, `src/fixloop/`); KEEP assets stay under `cli-anything/*` (stated once here — cross-story review found it inferred four times) |

## 2. Slate, sizing, horizon

**31 stories / 123 points / three sprints** (v5-S1 48 pts · v5-S2 50 pts · v5-S3 25 pts), per
R5 §1/§3 as re-baselined below. The F14 audit's "30–45 pts net-new" was a floor: the gates report
added five obligations (14 pts) the audit predates, and steps 1–2 each decompose into 5–6 subsystems.
**Stated plainly: the lights-on PR (DF5.4 gate green) lands in sprint 3, not sprint 2.**
The two-sprint compression (cut DF4 + DF3.2 + DF6.1 = 123 − 10 − 4 − 6 = 103 pts) is recorded
and NOT taken.

> **DD-13 — point re-baseline, post-derivation.** The slate opened at 111 pts and closed the
> pre-dev adversarial review at **123**. The +12 is fix-wave scope growth on six stories that were
> under-scoped against their real surface, not new stories: DF1.6 5→8, DF2.1 3→4, DF2.9 3→5,
> DF3.4 4→6, DF4.1 4→6, DF6.1 4→6. The story count is unchanged at 31 — no splits were taken
> (fewest files). DF2.9 also moved v5-S1 → v5-S2 to relieve S1, which stood at 53 pts; it holds no
> dependency edges, so the move re-sequences nothing. Sprint subtotals are recomputed from the
> story-file Sprint headers, which are the authority.

## 3. Coverage-hole dispositions (audit §6 — each hole gets a story or a recorded decision)

| # | Hole (audit §6) | Disposition |
|---|---|---|
| DD-1 | **#1 Channel layer has no build-order step** | **DECIDED: operator-CLI-only for v5.0.** Tier 1 is Claude Code + the tested fleet-dispatcher CLI; the operator is the channel. No channel story is derived. OQ-3 stays BLOCKED-on-creds; the Hermes fallback stays recorded-only. Channel↔factory bridge re-enters at a future vX derivation with working credentials, as a DF3-adjacent sub-epic. Writers must not assume Telegram intake anywhere. |
| DD-2 | **#2 PR-feedback fix loop unslotted** | **DECIDED: named step "5+" → epic DF6**, derived now (DF6.1, P1.19 re-derivation), scheduled v5-S3 after DF5.2. Carries the F6 scope caveat verbatim: multi-worker concurrent editing UNPROVEN — single-fixer proven only. P1.18 (KEEP) repoints to DF6.1. |
| DD-3 | **#3 Visualizer zero ancestry** | Covered by stories DF4.1/DF4.2, derived from the SSSF reference docs + F11/R10 confidentiality constraints alone (no prior ACs exist — acknowledged, not a defect). |
| DD-4 | **#4 OQ-4 Hindsight wall unowned** | **OWNER ASSIGNED: the operator (Steve), as an environment task** (arm64 libpq/openssl@3 build + port move off 8888), due before §8 step-6 derivation begins; step-6 derivation is BLOCKED on OQ-4 resolution or an explicit waiver. Not a DF story (steps 6–7 out of horizon). Consequence for this horizon: DD-6. |
| DD-5 | **#5 P0.7 AC2 stdio-vs-HTTP premise broken** | **DEFERRED to step-6 derivation** — the spec amendment (hindsight-local-mcp is HTTP on `:8888/mcp/`, not a stdio binary) is drafted when the step-6 memory epic derives, alongside DD-4's unblock. Recorded here so it is not lost; independent of v5 correctness. |
| DD-6 | **#6 Spend containment never fired live** | **STORY: DF2.4** — live cap-hit kill demonstration, discharging P0.4's never-run AC3 intent. The enterprise pitch gets its evidence. |
| DD-7 | **#7 SwarmClaw residual role undefined** | **DECIDED: SwarmClaw = host-side service chassis for factory query surfaces** — the natural HTTP home for the audit-chain query (DF5.3) and cost view (DF2.8) if/when they need an HTTP surface; otherwise dormant-retained for step 6. It is NOT the factory front door (that died with P1.1's premise — the front door is the tier-1 CLI). One-line role statement lands via DF5.5. P0.7 assets stay frozen KEEP. |

## 4. Boundary contracts (R5 §5.4 — prevent double implementation)

| Pair | Boundary (binding on both stories) |
|---|---|
| **DF1.3 ↔ P1.9 (KEEP)** | DF1.3 owns **in-phase** retry (JSON-parse + gate-violation retries, re-entering the same agent session). P1.9 owns **cross-run** restart classification keyed on the exitStatus enum. Both stories name this boundary; DF5.5 amends P1.9's text. |
| **DF1.5 ↔ P1.5 (KEEP)** | DF1.5 owns the roster **config schema + dual slug validation** (pi catalog AND provider API + `models.json`). P1.5 keeps **router scoring against outcome records** (step 6). DF5.5 amends P1.5's text. |
| **DF5.3 retain link ↔ OQ-4** | DF5.3's audit chain records the Hindsight retain-receipt link **VOID** (P0.11 VOID convention) pending step 6 — written into DF5.3's AC explicitly (consequence of DD-4). |

## 5. Conditions-register encoding map (gates report → stories)

| Binding condition | Encoded in |
|---|---|
| F13: OCI NOTICE re-swept post-build (15 license-text-less pkgs + full Apache-2.0 text for 3 @aws-sdk pkgs), `--omit=optional` drops `@mariozechner/clipboard`, fix `pi-vs-claude-code-vendor/coms.ts:14-15` header, never ship `@mariozechner/pi-proxy` or `@mariozechner/pi`, pin pi libs 0.55.x | **DF2.9** |
| F8 condition 1: session-cumulative usage + `cacheRead`/`cacheWrite`/turn-count in `team-lead-driver.ts` before any hosted pricing | **DF2.7** (prerequisite of DF2.8 ledger) |
| F8 condition 2 + R6: tier-1 priced at API rates only; org-owned-API-key-only for client deployments; Commercial Terms §A.1 is the load-bearing grant | Constraint on **DF2.8** + **DF3.5** wording (no Max-derived rate anywhere) |
| D4/F12 tripwire re-spec: absolute per-run spend ceiling (below the run key's cap), never the 15% ratio | **DF3.6** |
| 37K-token pi overhead (78–88% of bill) → lean worker profile, 5–6× payoff as measured hypothesis | **DF1.9** (benchmark AC — measure, not assume) |
| F6 scope caveat: multi-worker concurrent editing unproven | **DF6.1** |
| Roster slugs validate against pi catalog AND provider; `~/.pi/agent/models.json` mechanism | **DF1.5** |

## 5a. Erratum to audit §3 clause pointers (R2 finding) — DD-8/DD-9/DD-10

R2 (`R2-surviving-clauses.md` §0/§11) found that audit §3's `AC`/`INV` labels do not resolve
against the current story files for 8 of 10 RE-DERIVE stories: label drift, nonexistent labels,
and 28 "phantom" clauses whose text exists nowhere in the story set. The phantom clauses are
the v5 design's §5.2 / PR #97 contract language — legitimate, binding requirements whose
verbatim source is the **design doc and the code**, not story prose. The F14 dispositions and
the GO verdict are unaffected; the closed audit is not modified — this erratum governs instead.

| ID | Decision |
|---|---|
| **DD-8** | **Writers consume R2 §1–§11, never audit §3 directly.** True surviving clauses paste verbatim from R2's quoted source text (real labels + line numbers). Items R2 marks NET-NEW are authored **fresh** in their mapped successor story, cited to design §5.2 / PR #97 / the gates report — not under the "survives verbatim, do not re-litigate" banner — and get full adversarial review like any new material. |
| **DD-9** | **Cost unit = integer micro-dollars (µ$), settling the 10,000× contradiction.** P1.13's source uses `costCents` with a 500-cent ($5.00) default cap; the design says micro-dollars. Micro-dollars win (SPL-018 enterprise-correct): cheap-roster runs cost $0.015 and per-role splits are sub-cent — cents cannot represent them. The default cap is **explicitly restated as 5,000,000 µ$ ($5.00)** in DF2.8; no numeric literal is carried across the unit change. |
| **DD-10** | **D8 reverses P1.15's in-box push — explicitly.** The source story has Warren pushing from the box; v5 doctrine is push-credential-never-enters-a-box, host-side push after out-of-box re-verify (D8/F10). DF5.2 authors the host-side flow as new material; the in-box push clause is dead and must not be cited as ancestry. |

## 5b. Scope items decided without a story (pre-dev review) — DD-11/DD-12

Two design-doc items reached the pre-dev adversarial review owned by no story and with no
recorded deferral. Both are decided here rather than left orphaned.

| ID | Decision |
|---|---|
| **DD-11** | **Per-box egress policy (D8 / design §6.3) — DEFERRED to the OCI driver (§8 step 7).** exe.dev exposes no per-VM egress control today, so no v5.0 story can enforce it. The §6.3 data-containment claim is therefore **scoped to BYOK direct-provider egress** for v5.0 and **must not be sold as an allowlist**; DF3.5's factory-guide wording carries that scope caveat. The policy re-enters with the OCI driver, where the network namespace is ours. |
| **DD-12** | **Permission fingerprinting (gates report §3.3, ADOPT) — DEFERRED.** It guards a concurrent-shared-tree hazard that v5.0's one-run-one-box isolation (R8) structurally removes, so the ADOPT is superseded for v5.0 rather than dropped. It re-enters the moment runs ever share a working tree. |

## 6. Writer ground rules

- Facts writers must not contradict: R5 §6 (20 numbered facts) is binding.
- RE-DERIVE stories carry their audit-§3 surviving clauses **verbatim** (extraction:
  R2-surviving-clauses.md).
- Atomicity gate (Phase 2.5) applies to every story: normative ≤200 lines, ≤8 SP (target
  3–5), DOD ≤10 high-signal, Files-to-Modify mandatory, Security Invariants when triggered.
- exe.dev claims carry [VERIFY] vendor-single-origin flags; no AC assumes a compliance
  artifact (SOC 2/DPA/SLA) exists.
