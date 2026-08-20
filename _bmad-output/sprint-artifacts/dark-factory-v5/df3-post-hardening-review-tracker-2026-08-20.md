# DF3 Post-Hardening Adversarial Review — Findings, Plan, and Multi-Session Tracker

**Created:** 2026-08-20
**Status:** RESOLVED — all 16 findings ✅ DONE; Wave 5 converged (0 new BLOCKER/HIGH/MEDIUM)
**Scope:** DF3.1–DF3.6 (six fleet-band stories, dark-factory-v5)
**Goal:** Bulletproof the post-hardening DF3 specs before dev starts. Stories were revised 2026-08-20 against the implemented DF1/DF2 architecture (crosswalk + doctrine campaign); this review verifies that revision AND applies fresh-eyes adversarial scrutiny.

**Campaign context (differs from a greenfield pre-dev review):**
- Research reports live in `_bmad-output/workflow-state/qds-sprint-planning/df3-hardening/research/` (R1 DF1-arch, R2 DF2-arch, R3 doctrine, R4a/R4b crosswalk, R5 deps+DF2.8)
- DF2.8 is undeveloped (in-flight in the main worktree): every DF2.8 citation must be contract-cited-pending, never phantom code
- Atomicity: 5 inherited normative-size BLOCKs overridden by operator (see `atomicity-audit-2026-08-20.md`) — do NOT re-raise size as a finding; substance only
- Load-bearing domains: fleet dispatch contracts, credential/quota guards, resident-agent bounds, approval authority, run-record extension namespaces, requestId propagation, integer-µ$ accounting

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Status Dashboard](#status-dashboard)
3. [Cross-cutting themes](#cross-cutting-themes-fix-once-fix-everywhere)
4. [Execution plan — wave structure](#execution-plan--wave-structure)
5. Tracker: BLOCKERs / HIGHs / MEDIUMs / LOWs
6. Full findings — per-story sections
7. [Verified-correct elements](#verified-correct-elements-do-not-undo)
8. [Session log](#session-log-append-only)

---

## Executive Summary

Initial scan run by the campaign parent (glm-5.3 main loop) after 3 paired reviewer subagents were lost to a provider rate limit; every load-bearing citation was grep-verified against `src/` directly. The post-hardening revision is substantially sound — DF2.8 contract-cited markers, extension-namespace approval mechanics, race-polling composition, and doctrine encoding all resolve against the implemented codebase.

**Result:** 16 findings across 6 stories.

| Severity | Count | Definition |
|---|---|---|
| **BLOCKER** | 0 | — |
| **HIGH** | 2 | Phantom API cited in a make-or-break AC; undeclared file surface required by an AC |
| **MEDIUM** | 9 | Clarity/consistency gaps; cross-story seam gap; internal contradiction |
| **LOW** | 5 | Stale line refs, line-wrap artifact, naming-rule gap |

**Seams verified aligned (no fix needed):** S1 verb registry (DF3.1 creates / DF3.2+DF3.4 register / DF3.5 consumes — consistent in all four), S2 attach (DF3.3's three solicitation points + DF3.4's drain-at-those-points — consistent), S4 race-loss teardown (DF3.2 AC5 → DF2.5 order; DF3.5 documents teardown verb).

**Seam gap found:** S3 fanout × approval — no story states how approval interacts with N fan-out arms (CC-3 → DF3.4-M4).

---

## Status Dashboard

### Overall progress

| Severity | TODO | IN_PROGRESS | DONE | DEFERRED | BLOCKED |
|---|---|---|---|---|---|
| BLOCKER | 0 | 0 | 0 | 0 | 0 |
| HIGH | 0 | 0 | 2 | 0 | 0 |
| MEDIUM | 0 | 0 | 9 | 0 | 0 |
| LOW | 0 | 0 | 5 | 0 | 0 |

### Per-story progress

| Story | TODO | IN_PROGRESS | DONE | Notes |
|---|---|---|---|---|
| DF3.1 | 0 | 0 | 3 | Pair A — H1/M1/L1 fixed |
| DF3.2 | 0 | 0 | 2 | Pair A — M1/L1 fixed; L2 = no-edit note |
| DF3.3 | 0 | 0 | 1 | Pair B — M1 fixed |
| DF3.4 | 0 | 0 | 5 | Pair C — H1/M1-M4 fixed |
| DF3.5 | 0 | 0 | 1 | Pair C — L1 fixed |
| DF3.6 | 0 | 0 | 3 | Pair B — M1/M2/L1 fixed |

### Wave progress

| Wave | What | Status |
|---|---|---|
| Initial scan | Parent-run adversarial scan (subagent reviewers lost to rate limit; every citation grep-verified) | DONE |
| 0 — Cross-cutting prep | CC-1 manifest ownership split; CC-2 fanout×approval (parent-locked) | DONE |
| 1–4 — BLOCKER/HIGH/MEDIUM/LOW | 3 pair fixers, exact recipes (0 BLOCK / 2 HIGH / 9 MED / 5 LOW) | DONE |
| 5 — Verification | 3 fresh-eyes paired verifiers | DONE |
| 5b/5c — Re-fix | Wave-5 surfaced: 0 BLOCKER/HIGH/MEDIUM; 3 LOW notes (see below) | DONE (no edits required) |

---

## Pairing plan (Rule 1)

| Pair | Stories | Load-bearing contract held |
|---|---|---|
| A | DF3.1 + DF3.2 | dispatch ack + requestId shape; fanout composes dispatch; checkHeadroom(1) vs (N) |
| B | DF3.3 + DF3.6 | solicitation↔checkBounds gating; manifest bound fields; resident.status lifecycle |
| C | DF3.4 + DF3.5 | approve/reject verbs + skills contract test; approval record mechanism |

**Parent-arbitrated seams (span pairs; parent owns canonical resolution):**
- S1: verb registry `src/fleet/verbs.ts` — DF3.1 ships, DF3.5 consumes (A↔C)
- S2: `fleet attach` steering path — DF3.4 surface, DF3.3 resident consumer (B↔C)
- S3: fanout × approval — best-of-N arms each a run: does each arm pause for approval? (A↔C)
- S4: race-loss teardown — DF3.2 tears down losers via DF3.5-documented teardown verb (A↔C)

---

## Severity legend & status legend

- **BLOCKER** — broken/insecure as-written; dev must not start until fixed
- **HIGH** — significant gap; production-incident risk within 2 weeks
- **MEDIUM** — test/observability/config gap; tech-debt accumulator
- **LOW / nit** — polish, doc consistency, minor robustness

⬜ TODO · 🟡 IN_PROGRESS · ✅ DONE · ⏭️ DEFERRED (ADR/user link required) · ❌ BLOCKED

---

## Cross-cutting themes (fix once, fix everywhere)

### CC-1 — Manifest bound-field ownership split (fixes DF3.1-H1 + DF3.6-M2)
**Affects:** DF3.1, DF3.6
**Symptom:** DF3.1's AC9 stamps `limitMicroUsd` into the frozen manifest and hands `effectiveCeilingMicros` into the run context, but Files-to-Modify lists no phase-engine file — while DF3.6 both relies on that field being schema-declared and claims it "writes no manifest field" despite listing `src/phase-engine/manifest.ts` in its own FTM.
**Canonical resolution (parent-locked):** DF3.1 owns declaring `limitMicroUsd` in the manifest zod schema (`src/phase-engine/manifest.ts` joins DF3.1's FTM); DF3.6 owns its three bound fields (`residentSpendCeilingMicros`, `maxSteeringIterations`, `residentRssBytes`) in the same schema. Neither story stamps the other's fields at runtime.
**Tracker IDs:** DF3.1-H1, DF3.6-M2

### CC-2 — Fan-out × approval interaction (seam S3; fixes DF3.4-M4)
**Affects:** DF3.4 (portion), DF3.2 (verified only)
**Canonical resolution (parent-locked):** the approval gate is per-run. Each fan-out arm that reaches a green host-side re-verify pauses at its own `extensions.approval` independently; race losers are torn down by DF3.2 (AC5) and never reach the gate; approving one arm decides nothing about its siblings; there is no fan-out-level approval in v5.0. Encoded once, in DF3.4's Technical Notes (owner of approval semantics). DF3.2 needs no edit — its silence is the correct separation.
**Tracker IDs:** DF3.4-M4

### Verified-aligned seams (no action)
- **S1 verb registry:** DF3.1 AC6 creates `src/fleet/verbs.ts` + `listVerbs()`; DF3.2 FTM and DF3.4 FTM both say "adds only its own entries"; DF3.5 consumes and adds no second source. Consistent.
- **S2 attach:** DF3.3 defines exactly three solicitation points and states attach "adds none — an operator message is queued and delivered as prompt context at the next of these three"; DF3.4 specifies the drain at those same three points, no fourth. Consistent.
- **S4 race-loss teardown:** DF3.2 AC5 losers go through DF2.5's fixed order; DF3.5's `factory-harvest` documents the teardown verb; no `fleet reap` anywhere (DF2.6's `scripts/sandbox-reap.ts` is the surface in both DF3.1 and DF3.2 trigger tables). Consistent.

---

## Tracker: BLOCKERs

0 items.

---

## Tracker: HIGHs

2 items.

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| DF3.1-H1 | DF3.1 | AC9 manifest/harness surfaces missing from Files-to-Modify | ✅ DONE | fix-a/b/c (2026-08-20) | CC-1 |
| DF3.4-H1 | DF3.4 | Phantom `setExtension()` cited in make-or-break AC1(a) | ✅ DONE | fix-a/b/c (2026-08-20) | actual mechanism: `RunRecordPatch.extensions` / `validateExtensions` under the store lock |

---

## Tracker: MEDIUMs

9 items.

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| DF3.1-M1 | DF3.1 | INV-4-bis ordered before INV-4; INV-6 duplicates INV-4's first clause verbatim | ✅ DONE | fix-a/b/c (2026-08-20) | numbering/dedup |
| DF3.2-M1 | DF3.2 | AC5 per-call-deadline justification self-contradictory (10s vs "shorter than 5s+margin") | ✅ DONE | fix-a/b/c (2026-08-20) | mechanism sound, wording garbled |
| DF3.3-M1 | DF3.3 | `--no-resident` control used in AC1a/DoD but never declared as a flag this story adds | ✅ DONE | fix-a/b/c (2026-08-20) | residual phantom after flag fix |
| DF3.4-M1 | DF3.4 | AC1(a) cites private `withLock` as if externally callable | ✅ DONE | fix-a/b/c (2026-08-20) | cite the public locked-update path |
| DF3.4-M2 | DF3.4 | FTM note references eliminated `.sandbox/approvals/` dir | ✅ DONE | fix-a/b/c (2026-08-20) | rewrite remnant; actual: extension join on `.sandbox/runs/` |
| DF3.4-M3 | DF3.4 | INV-APPROVE-7 names `credentialHash`; actual field is `keyHash` (run-record.ts:57) | ✅ DONE | fix-a/b/c (2026-08-20) | wrong name can make a grep DoD vacuous |
| DF3.4-M4 | DF3.4 | Fan-out × approval interaction unspecified | ✅ DONE | fix-a/b/c (2026-08-20) | CC-2 |
| DF3.6-M1 | DF3.6 | AC5 unwatchable⇒not-started leaves `resident.status` unstated | ✅ DONE | fix-a/b/c (2026-08-20) | specify `"disabled"` + bounds log line, no tripwire row |
| DF3.6-M2 | DF3.6 | "writes no manifest field" contradicts own FTM listing manifest.ts | ✅ DONE | fix-a/b/c (2026-08-20) | CC-1 |

---

## Tracker: LOWs / nits

5 items.

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| DF3.1-L1 | DF3.1 | exitStatus cite `cli-anything/src/types.ts:79` → actual `:94-108` | ✅ DONE | fix-a/b/c (2026-08-20) | DF3.3 already uses `:94-185` |
| DF3.2-L1 | DF3.2 | AC5 code-span line-wrap breaks `/run/journal/final.json` mid-string | ✅ DONE | fix-a/b/c (2026-08-20) | rejoin |
| DF3.2-L2 | DF3.2 | engine comment journal.ts:42 cites "DF3.2 AC7"; poller spec is AC5 | ✅ DONE | fix-a/b/c (2026-08-20) | code-comment note for DF3.2 dev; no story edit |
| DF3.5-L1 | DF3.5 | "invoked through the repo's package script" — no package script exists/planned | ✅ DONE | fix-a/b/c (2026-08-20) | align to `bun scripts/fleet.ts --help` |
| DF3.6-L1 | DF3.6 | `runBudgetCapMicros` missing from the shared µ$-naming mapping list | ✅ DONE | fix-a/b/c (2026-08-20) | config-default family |

---

## Full findings — per-story sections

### DF3.1 — Fleet Dispatcher Core Verbs

**DF3.1-H1 — AC9 manifest surfaces missing from FTM.** Story lines L113-130 (AC9), L245-257 (FTM).
**Why broken:** AC9(a) stamps `limitMicroUsd` into DF1.1's frozen manifest at fill and AC9(b) hands `effectiveCeilingMicros` into the run context DF1.6's harness reads — but the manifest's zod schema (`src/phase-engine/manifest.ts:125+`) declares no such field and is absent from Files to Modify. DF3.6's AC2b/INV-BND-2 depend on the field being schema-declared and refuse-the-run-on-missing; as written, the two stories each assume the other owns the declaration.
**Concrete fix:** add `src/phase-engine/manifest.ts` to Files to Modify; add one clause to AC9(a): "this story declares `limitMicroUsd` in the manifest's zod schema (Files to Modify) — DF3.6's three bound fields join it there under DF3.6's own FTM entry"; note the run context is constructed by dispatch itself at fill (no harness file edit).

**DF3.1-M1 — INV numbering/duplication.** L262-279.
**Fix:** order INV-4 before INV-4-bis; open INV-6 with "Redaction complement to INV-4:" instead of repeating the containment sentence.

**DF3.1-L1 — stale line cite.** L228 `cli-anything/src/types.ts:79` → `:94-108`.

### DF3.2 — Fleet Patterns as Code

**DF3.2-M1 — AC5 deadline wording.** L116-121. "per-call deadline of 10_000 ms — shorter than the 5_000 ms poll interval's next cycle plus margin" is arithmetically garbled (10s > 5s).
**Fix:** "each probe/read carries a 10_000 ms per-call deadline; a call that overruns a poll tick causes that tick's poll to be skipped and logged, and the loop retries on the next 5_000 ms tick, the whole loop still bounded by the 3_600_000 ms ceiling."

**DF3.2-L1 — line-wrap.** L100-101 rejoin `"/run/journal/final.json"` inside the single code span.
**DF3.2-L2 — engine comment cites AC7.** `src/phase-engine/journal.ts:42` says "DF3.2's host-side poller keys on (AC7)"; the poller is AC5. No story edit — recorded for DF3.2 dev to align the comment when touching that file.

### DF3.3 — Resident Orchestrator Agent

**DF3.3-M1 — `--no-resident` residual phantom.** L67 (AC1), L253/257 (DoD tests) use the flag as if it exists; R1 confirmed it does not (actual flags: `--manifest --journal --run-id --repo-slug --issue`), and the E2E slice was already corrected to omit it.
**Fix:** at first use (AC1a) add "(the `--no-resident` control flag, added to `scripts/pipeline-run.ts` by this story — it is the control leg of AC1a's equivalence test)"; DoD rows inherit the meaning.

### DF3.4 — Approval Gate + attach

**DF3.4-H1 — phantom `setExtension()`.** L78-79 (AC1a), L213-214 (Technical Notes). No such export exists; extensions ride `RunRecordPatch.extensions` validated by `validateExtensions` (run-record.ts:247+) applied under the store's PID lock.
**Fix:** replace both cites with "an extensions-carrying record patch (`RunRecordPatch.extensions`), validated against `EXTENSION_NAMESPACES` by `validateExtensions` and applied atomically under the record's PID lock".

**DF3.4-M1 — private `withLock`.** L72 (AC1a) cites "DF2.1's `withLock`"; it is a private method (run-record.ts:574). **Fix:** cite "the store's locked update path (the public patch API that takes the per-record PID lock internally)".

**DF3.4-M2 — `.sandbox/approvals/` remnant.** L266-267 FTM note. **Fix:** "adds only the approval-extension join over `.sandbox/runs/` and the lazy expiry sweep".

**DF3.4-M3 — `credentialHash` → `keyHash`.** L312 (INV-APPROVE-7). Actual field: `keyHash` (run-record.ts:57).

**DF3.4-M4 — fan-out × approval (CC-2).** Add one Technical Notes sentence under "The gate relocates.": canonical resolution per CC-2 above.

### DF3.5 — Factory Skills

**DF3.5-L1 — package-script phantom.** L138 "invoked through the repo's package script". **Fix:** preflight is `bun scripts/fleet.ts --help` exits `0` (matches DF3.1's invocation surface).

### DF3.6 — Resident Bounds

**DF3.6-M1 — unwatchable status value.** L104-112 (AC5) + INV-BND-5 specify not-started but name no journal value. **Fix:** append to AC5: "the journal records `resident.status: "disabled"` (DF3.3's closed set) and the bounds-check log line carries `bound:"rss", allowed:false, cause:"unwatchable"`; no `residentTripwire` row is emitted — DF3.3's closed three-cause set is unchanged."

**DF3.6-M2 — "no manifest field" contradiction.** L133 vs FTM L236. **Fix:** "This story adds its three bound fields to the manifest schema (Files to Modify) but writes no bound *value* at run time beyond the clamp's journal row; it never stamps or alters `limitMicroUsd` (DF3.1's field, CC-1)."

**DF3.6-L1 — naming-rule gap.** L164-171 mapping list omits `runBudgetCapMicros`. **Fix:** add "DF2.8's configured default `runBudgetCapMicros` (config-family; `Micros` by DD-9 lineage — a configured constant, not a persisted record field)".

---

## Verified-correct elements (do NOT undo)

### DF3.1
- `resolveRunCorrelation` boundary (issue-correlation.ts:85) — one resolver, exit-code mapping only
- `checkHeadroom(1)` pre-record placement + `{ admitted: true }` in-process-only design + no-CLI-flag coverage test
- DF2.8 contract-cited markers (AC7, sequencing note, infra prereqs) per R5 disposition
- `parseValueFlags` cite (scripts/lib/cli-args.ts:50 — verified exists)

### DF3.2
- `checkHeadroom(N)` single-call admission; `.sandbox/fleet.lock` with pid+pidStartTime identity reclaim
- Race marker polling composition (`driver.exec` probe + `driver.copyFile`, no port addition) — verified against journal.ts:39-44 incl. `QDS_RUN_ROOT` test override
- `extensions.fanout` with mandatory `schemaVersion: 1` (namespace pre-registered per run-record.ts:124)

### DF3.3
- Three solicitation points after deterministic decisions; `SteeringDirective` closed `.strict()` union
- exitStatus/status ownership split with DF3.6 (DF3.3 declares fields, DF3.6 writes "stopped"/"overflow" only)
- µ$ naming rule (`*MicroUsd` persisted / `*Micros` engine) and its DF3.6 mirror
- Actual pipeline-run.ts flags in E2E slice (`--manifest --journal --run-id --repo-slug --issue`)

### DF3.4
- `extensions.approval` mechanism matching run-record.ts reality (allow-list, schemaVersion, writable-after-close at :502-505)
- `teardownSandbox(deps, runId, { noHarvest: true })` (teardown.ts:197,81) and `revokeAndVerify` (credentials.ts:413) — verified real
- stdin-only NDJSON attach transport (argv-injection-safe); rebind/terminal-state race rules
- Fail-closed allowlist INV-APPROVE-3; fs.writeSync exit paths INV-APPROVE-9

### DF3.5
- Registry consumption (second consumer, never second source) across all four files
- Sprint-compression soft-dep handling for DF3.2
- Six fixed lint patterns with exactly two verbatim allowlist entries

### DF3.6
- AC2a/AC2b defaults-vs-minted split; frozen-manifest-only `limitMicroUsd` reads; fail-closed missing-cap refusal
- RSS tree-sum + platform dispatch (/proc Linux, ps darwin); DF2.4 group-kill parity (SIGTERM→SIGKILL)
- Pre-flight projection (`spent + projected > ceiling` ⇒ no call), fail-safe zero-usage charging

---

## Session log (append-only)

- 2026-08-20 | qds-story-review parent (glm-5.3) | NOTES: tracker created; pairing plan locked (A: 3.1+3.2, B: 3.3+3.6, C: 3.4+3.5); seams S1-S4 parent-arbitrated; 3 paired reviewers dispatched.
- 2026-08-20 | parent | NOTES: 3 reviewer subagents lost to provider 429 (weekly limit) mid-scan; parent completed the initial scan inline with direct grep verification of every load-bearing citation against src/. 16 findings (0 B / 2 H / 9 M / 5 L).
- 2026-08-20 | fix-a / fix-b / fix-c (parallel, bundled-by-file) | DONE: DF3.1-H1,M1,L1; DF3.2-M1,L1 (L2 = no-edit note); DF3.3-M1; DF3.4-H1,M1,M2,M3,M4; DF3.5-L1; DF3.6-M1,M2,L1 | NOTES: exact recipes applied; phantom scan clean post-fix.
- 2026-08-20 | ver-a / ver-b / ver-c (fresh-eyes, paired) | NOTES: Wave 5 converged — 0 new BLOCKER/HIGH/MEDIUM; 3 LOW notes (DF3.3-V-L1 fixture-path prose duplication [standard practice, no action]; DF3.6-V-L1 explicitly "not a finding" [cross-story alignment confirmation]; DF3.1-V-L1 defaultKeyCapMicroUsd lacks file:line [nit, no action]). Full reports: `_bmad-output/workflow-state/qds-sprint-planning/df3-hardening/verdicts/verify-{a,b,c}-*.md`. All three pair-contract verdicts ALIGNED/PASS; phantom sweeps CLEAN.

---

## Wave-5 verification findings (final)

| ID | Pair | Severity | Finding | Disposition |
|---|---|---|---|---|
| DF3.3-V-L1 | B | LOW | fixture path cited in both E2E slice and FTM | No action — FTM listing a file the story creates is the established pattern |
| DF3.6-V-L1 | B | LOW | (verifier recorded a cross-story alignment confirmation, not a defect) | No action |
| DF3.1-V-L1 | A | LOW | `defaultKeyCapMicroUsd` named without file:line | No action — DF2.3 named as owner; intent clear |

**Campaign result: converged. All six DF3 stories ready-for-dev.**

---
