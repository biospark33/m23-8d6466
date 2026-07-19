# Phase 0 Wave 2 — Pre-Dev Adversarial Review (QDS Campaign)

**Date:** 2026-07-19
**Sprint:** Phase 0, Wave 2
**Campaign type:** Wave-1-hardening propagation + adversarial pre-dev review
**Tracker owner:** parent agent (Claude). Subagents return reports; only parent mutates this file.

## Why this campaign

Wave 1 stories (P0.1, P0.2, P0.5, P0.7) shipped, then absorbed **2–4 bmad-code-review rounds each** (PRs #28–#35) producing massive fixes. Goal: propagate that hardened quality into Wave 2 specs (P0.3, P0.6, P0.8, P0.9) NOW, correct factual drifts vs merged code, so the first dev-time bmad-code-review on each Wave 2 story is minor — not 2–4 rounds of large fixes. Source material: Wave 1 Dev Agent Records (review-finding themes), PRs #28–#35, the resulting hardened code in the repo.

## Scope

| Story | File | Pts | Deps (merged) | Pairing |
|-------|------|-----|---------------|---------|
| P0.3 | `…/phase-0/stories/p0-3-mixed-model-demo.md` | 4 | P0.1, P0.2 | Single B (consumes runner.ts + coms) |
| P0.6 | `…/phase-0/stories/p0-6-lsp-provision-diagnostics.md` | 3 | P0.5 | Single C (LSP/pi-lens) |
| P0.8 | `…/phase-0/stories/p0-8-github-webhook-callback.md` | 3 | P0.7 | **Pair A** (SwarmClaw bridge consumers) |
| P0.9 | `…/phase-0/stories/p0-9-hindsight-banks-mulch.md` | 4 | P0.7 | **Pair A** |

**Out of scope:** P0.10 (gitnexus-analyze — separate test-fix task, not a spec-harden target). P0.11 (gate story).

## Dependency graph + pairing rationale (Rule 1)

- **Pair A = P0.8 + P0.9.** Both consume P0.7's SwarmClaw MCP invoke bridge (`POST /api/mcp-servers/{id}/invoke`) + the hardened stdio-transport (PR #31/#34). P0.8 creates session runs on ingest; P0.9 invokes Hindsight tools through the same bridge. Shared contract: invoke error shape, requestId propagation (CC-9), timeout/retry, body cap, shutdown lifecycle. One agent holds both halves so the bridge contract is decided once.
- **Single B = P0.3.** Touches `cli-anything/src/runner.ts` (the file PR #33 hardened) + consumes coms (P0.2, now with `coms-core.ts` shared layer via PR #35). No Wave 2 sibling shares the contract; cross-refs merged P0.1/P0.2 code.
- **Single C = P0.6.** LSP provisioning; depends on P0.5 pi-lens. No Wave 2 sibling; cross-refs P0.5 hardened QA findings.

## Status dashboard

| Wave | State | Findings resolved |
|------|-------|-------------------|
| -1 Propagation mining | ✅ DONE | — (seeds finding table) |
| Dependency graph + tracker | ✅ DONE | — |
| Initial scan (3 reviewers) | ✅ DONE | 16 propagation + 24 new = 40 findings |
| Wave 0 cross-cutting | 🟡 IN_PROGRESS (canonical locked) | CC-W1..W4 |
| Wave 1-4 fixes (consolidated) | 🟡 IN_PROGRESS | 3 paired fixers dispatched |
| Wave 5 verify | ✅ DONE | 14 verification findings (P0.8 clean) |
| Wave 5b/5c re-fix | ✅ DONE | P0.3 + P0.6 + P0.9 re-fixed; P0.8 clean |
| **CAMPAIGN** | ✅ **CONVERGED** | ~54 findings resolved; 2 cosmetic residuals accepted |

## Propagation lesson inventory (parent-verified, seeded as findings)

> These were verified by the parent against merged code + Wave 1 Dev Agent Records. Reviewers must **verify or correct** each (cite current code) and add NEW gaps. Evidence column = the Wave 1 PR/round that established the lesson.

### P0.3 (cli-anything runner.ts + coms consumer)

| ID | Sev | Finding | Evidence (Wave 1) | Status |
|----|-----|---------|-------------------|--------|
| P0.3-H1 | HIGH | coms integration description stale: spec maps `coms_*`→`coms_net_*` in `extensions/coms-net.ts` and credits P1.4, but hardened vendor tree now has shared `pi-vs-claude-code-vendor/coms-core.ts` (PR #35). Update coms wiring to reference the actual current surface. | PR #35 (`refactor(vendor): extract coms-core.ts shared layer`); `find` confirms `coms-core.ts` | ⬜ |
| P0.3-H2 | HIGH | merger.ts secret redaction underspecified. INV-3 says "no secret values in merged JSON or coms log" but doesn't reference P0.1's proven redaction machinery: longest-first single-pass regex alternation, boundary-prefix leak protection, re-cap after redaction, marker-corruption prevention. merger.ts merges worker outputs + coms log → must apply same machinery. | PR #28 rounds 1–4 (P0.1 INV-2/INV-3) | ⬜ |
| P0.3-H3 | HIGH | budget-kill + lead-failure worker-termination process-tree semantics naive ("SIGTERM then SIGKILL" + 5s grace). P0.1 hardened: detached spawn POSIX, SIGKILL to process group, `killChildTree` SIGKILL fallback, unref'd 5s watchdog for grandchild stdout-hold, signal-handler install-before-spawn, SIGHUP reaps detached tree. Warren/Pi workers are exactly this failure mode. | PR #28 round 3 (P0.1 timeout/process-tree) | ⬜ |
| P0.3-M1 | MEDIUM | timeout reconciliation. Spec: coms_await 240000ms (4min Trio override), wall-clock 5min. P0.2 round-5 root cause: AWAIT 45s→150s, SPAWN 90s→240s (model-latency coin-flip broke round-trip); coms.ts:65 `TIMEOUT_MS` default 1,800,000ms (30min). Reconcile P0.3's 4min await against P0.2's hardened harness timeouts or document the relationship explicitly. | PR #29 (P0.2 round 5, C19) | ⬜ |
| P0.3-M2 | MEDIUM | JSON contract uniformity. P0.1 round-3: every settle path emits all fields explicitly (no path-dependent absent fields). P0.3 merged-output schema has optional `error?`; every exit path (success/transient/overflow/logic) must populate full schema explicitly. Propagate into DoD. | PR #28 round 3 (P0.1) | ⬜ |

### P0.6 (LSP provisioning, deps on P0.5 pi-lens)

| ID | Sev | Finding | Evidence (Wave 1) | Status |
|----|-----|---------|-------------------|--------|
| P0.6-H1 | HIGH | AC1 "≤3s p95 (NFR-PERF-6)" vs P0.5 cold-start reality: warm ~1.2–1.9s OK, COLD starts (pyright, opengrep ~8s auxiliary) EXCEED 3s; p95 never measured (observed samples only). P0.6 must specify p95 is over WARM diagnostics only (cold-start once per worktree session, not per turn — already line 40) + cold-start as logged advisory. Else dev-review flags "p95 over what distribution?" | P0.5 QA Results (Performance) | ⬜ |
| P0.6-M1 | MEDIUM | INV-2 "no secret values in diagnostic payloads" assumes P0.5 secret-scan is solid. P0.5 QA: emit-block NOT observed (needs gitleaks/trivy; `secret_detected` label doesn't exist in pi-lens 3.8.69 — rule-ID-based). P0.6 should reference P0.5 secret-scan as upstream guard AND acknowledge its empirical status. | P0.5 QA Results (AC2) | ⬜ |
| P0.6-M2 | MEDIUM | pi-lens version drift. P0.5 pinned 3.8.47, installed 3.8.69. P0.6 depends on P0.5's lsp_diagnostics surface — don't hard-pin a drifted version; reference installed version or range. | P0.5 QA Results (version drift) | ⬜ |

### P0.8 (webhook → SwarmClaw session run, deps on P0.7)

| ID | Sev | Finding | Evidence (Wave 1) | Status |
|----|-----|---------|-------------------|--------|
| P0.8-H1 | HIGH | session-run creation must reconcile with P0.7 hardened shutdown lifecycle: in-flight registrations killable (`attachTransport` + pending-transport drain in `shutdownAll`), listener stopped before teardown, per-transport error isolation (`Promise.allSettled`), 12s force-exit watchdog. If SwarmClaw shuts down mid-ingest, session-run creation must be consistent with P0.7's shutdown ordering. | PR #31 (P0.7 round 1, shutdown lifecycle) | ⬜ |
| P0.8-H2 | HIGH | webhook payload cap (5MB, line 95) vs P0.7 413 body cap (incl chunked transfer-encoding). Document which layer wins + how a >cap GitHub payload is rejected (413 at SwarmClaw before reaching webhook handler?). | PR #31 (P0.7 round 1, body cap) | ⬜ |
| P0.8-M1 | MEDIUM | requestId propagation (CC-9). P0.7: UUID-strict `x-request-id` with regen fallback, `_meta.requestId` wire propagation is the cross-layer join key. P0.8 webhook ingest → session-run-create must propagate requestId. Spec doesn't mention it. | P0.7 CC-9 + round 1 (_meta.requestId) | ⬜ |
| P0.8-M2 | MEDIUM | session-run dedup ("same push SHA within 60s idempotent", line 97) less rigorous than P0.2 hardened tombstone thinking (1h tombstone for replayed msg_id, eviction, race on concurrent dup). Reconcile dedup TTL/eviction/concurrency. | PR #29 (P0.2 R2-3 tombstone) | ⬜ |

### P0.9 (Hindsight banks via SwarmClaw bridge, deps on P0.7)

| ID | Sev | Finding | Evidence (Wave 1) | Status |
|----|-----|---------|-------------------|--------|
| P0.9-H1 | HIGH | error-shape assumptions vs P0.7 hardened invoke error contract. AC-3 `{ok:false, error:<msg>}`; AC-4/AC-5 use `-32001/-32002`. P0.7 actual: JSON-RPC codes propagated (`-32601`/`-32602`→HTTP 400, else 502); `MCPInvokeErrorResponseSchema` = `{jsonrpc:"2.0",error:{code,message,data?},id}`. Map P0.9's `-32001..-32005` to where they actually surface (Hindsight non-200→502? wrapped?). Risk: P0.9 invents an error shape that doesn't match the bridge. | PR #31 (P0.7 round 1, contract honesty) | ⬜ |
| P0.9-H2 | HIGH | invoke timeout/retry vs P0.7 hardened transport. P0.7: invoke 120s (`SWARMCLAW_INVOKE_TIMEOUT_MS`), tool-cache re-enumeration on tool-not-found, retry revalidates args against refreshed schema. P0.9 CC-7 (recall 10s/reflect 30s/consolidate 60s, all <120s ✓) but must reference P0.7 retry/re-enumeration so provisioner doesn't fight the bridge cache. | PR #31 (P0.7 round 3, tool-bridge retry) | ⬜ |
| P0.9-M1 | MEDIUM | `src/hindsight/client.ts` must apply PR #34 defensive parsing: Hindsight responses may have primitive or array-shaped error frames (don't assume object shape); all timers cleared in `finally`. Propagate PR #34's exact lessons into client.ts contract. | PR #34 (primitive env.error + array error frames + dangling timer) | ⬜ |
| P0.9-M2 | MEDIUM | secret masking. P0.7 INV-SC5 `maskEnv` masks ALL env values + subprocess-stderr redaction. P0.9 INV-HM1 bearer token env-only. Reference P0.7 `maskEnv` as the mechanism (token transits SwarmClaw env map → masked in all diagnostic output). | PR #31 (P0.7 round 1, maskEnv) | ⬜ |

## Scan findings (collated after initial scan)

**Verified against merged code.** 1 BLOCKER, 13 HIGH, 11 MEDIUM, 4 LOW ≈ 29 new + 16 propagation.

### BLOCKER
- **P0.9-H1** Error shape `{ok:false,error}` + codes `-32001..-32005` do not exist in P0.7 hardened bridge (`MCPInvokeErrorResponseSchema`; `-32601/-32602`→400 else 502). Reframe as provisioner-internal codes (CC-W3).

### HIGH
- **P0.3-H1/H2/H3** coms-core drift; merger redaction machinery; hardened-kill semantics.
- **P0.3-S-H4/H5/H6** budget-poll race (cost overshoot between polls); 100ms boundary race non-deterministic (→ single-settle); changedFiles worker-lie + redaction.
- **P0.6-H1 + P0.6-S-H1/H2** p95 vs cold-start; AC3 init-timeout (hang); stable-ID vs P0.5 `idObserved:false`.
- **P0.8-H1/H2** shutdown-lifecycle reconciliation; **5MB payload vs P0.7 1MB body cap** (cross-story dep — needs P0.7 per-route override; flagged, not silently amended).
- **P0.8-S-H1/H2** HMAC replay (`X-GitHub-Delivery` dedup); sig-header parse fragility (hex-decode + length check before timingSafeEqual).
- **P0.9-H2 + P0.9-S-H1/H2** invoke timeout/retry vs bridge; Mulch huge-file DoS (per-file size cap); provision single-flight lock.

### MEDIUM (selected)
P0.3-S-M3 exitStatus precedence; S-M4 artifact atomic-write vs kill; S-M5 waiver semantics. P0.6-S-M3 nav external-defs; S-M4 batch unexercised; S-M5 verify-script strict-gating; S-M6 stale-index negative-control. P0.8-M1 requestId; M2 dedup rigor; S-M1/S-M2 sig missing-vs-invalid + event routing/ping. P0.9-M1/M2 client.ts defensive parsing + maskEnv; S-M1/S-M2 collision loop bound + ReflectResponseSchema casing.

### LOW
P0.3-S-L1/L2 durationMs provenance; coms-init transient AC. P0.6-S-L7 warning surface path. P0.9-S-L1 confidence ranking clarity.

## Wave 0 cross-cutting resolutions (parent-locked canonical)

**CC-W1 — P0.7 Contract Reference block (apply to P0.8 AND P0.9).** Add `### P0.7 Contract Reference (hardened, merged)` subsection restating: body cap `MAX_BODY_BYTES=1_048_576` (1MB, content-length + chunked, 413+close BEFORE handlers); UUID-strict `x-request-id` + `_meta.requestId`; `MCPInvokeErrorResponseSchema` shape + code→HTTP map; invoke timeout 120s clamped [60,3600]; shutdown ordering + 12s watchdog.

**CC-W2 — Wave 1 Reuse Mandate (apply to ALL FOUR).** Add `### Wave 1 Reuse Mandate` subsection per story enumerating hardened primitives to REUSE (cite by symbol), not reimplement: P0.3 → `killChildTree`/`redactSecrets`/`redactBoundaryPrefix`/`classifyExit`/`armWatchdog`/signal-handlers-before-spawn (runner.ts); P0.6 → P0.5 `scripts/pi-lens-verify.ts` harness pattern (strict-gated, fail-fast, bounded RPC deadlines, observed-vs-derived); P0.8/P0.9 → via CC-W1.

**CC-W3 — error-shape contract (apply to P0.8 AND P0.9).** P0.9: `-32001..-32005` are PROVISIONER-INTERNAL app codes returned directly as `{ok:false,error:{code,message},requestId}`, NOT through the MCP `/invoke` bridge (bridge uses `MCPInvokeErrorResponseSchema`). Map -32001/-32002→503, -32003→400, -32004→429, -32005→502. P0.8: distinct HMAC error bodies (`missing_signature`/`invalid_signature`/`payload too_large`/`ignored:event_not_subscribed`).

**CC-W4 — redaction machinery (apply to P0.3 AND P0.9).** P0.3 INV-3 → cite P0.1 `redactSecrets`/`redactBoundaryPrefix` (longest-first, KMP, re-cap) applied to agentOutputs/comsLog/error.details. P0.9 INV-HM5 → client.ts treats every Hindsight response as `unknown`, narrows before access, stringifies non-object bodies, clears timers in `finally` (mirrors PR #34 `stdio-transport.ts:603-622`); INV-HM1 → cite P0.7 `maskEnv`.

**Cross-story dependency flagged (parent surfaces, does NOT silently amend):** P0.8-H2 requires P0.7 to expose a per-route body-cap override (5MB for `/api/webhooks/{id}`). Additive, backward-compatible (default stays 1MB). Tracked as a P0.7 follow-up + PROPOSED ADR; P0.8 DoD states the dependency.

## Wave 5 verification findings (fresh-eyes, post-fix)

**P0.8 — CLEAN** (cosmetic LOWs only: INV numbering order, one cite lacks file/symbol).

**P0.3 — 1 BLOCKER + 3 (one root cause: `lead_failure` not propagated):**
- P0.3-V-B1 BLOCKER: schema/5-path list has 5-value enum incl `lead_failure`; CC-1 still says 4-value. Intra-file contradiction.
- P0.3-V-H1: `error.reason` enum mismatched between schema (`overflow|timeout|lead_failure`) and 5-path table (`transient|logic|lead_failure|overflow`).
- P0.3-V-M1: lead-failure flat P1.6 schema (line ~88) contradicts merged-output uniform schema (path 5 says `agentOutputs:{}`).
- P0.3-V-L1: lead-failure classification self-conflicts in one paragraph (`logic` vs `transient` vs `lead_failure`).
- **Resolution (locked):** promote `lead_failure` into CC-1 (5-value) + signal-table row; unify `error.reason` to `{overflow,transient,logic,lead_failure}` (drop `timeout` — subsumed by `transient`); remove flat P1.6 schema (keep full merged-output shape); note `classifyExit` bypassed for lead-failure.

**P0.9 — 4 (error-model dangling):**
- P0.9-V-H1: `-32001..-32005` HTTP map (503/400/429/502) dangling — no P0.9 HTTP listener (provisioner is CLI script).
- P0.9-V-M2: `-32004→429` semantically wrong (file-count = 400/quota, not rate-limit).
- P0.9-V-M3: envelope inconsistent — AC-4/5 bodies omit `requestId` (CC-9 requires it).
- P0.9-V-M4: `RetainResponseSchema` mixes `bank_id` (snake) + camelCase — CC-8 violation.
- **Resolution (locked):** drop HTTP-status map for -32001..-32005 (they're provisioner-SCRIPT codes: CLI exit + `{ok:false,error:{code,message},requestId}` envelope; HTTP surface for Hindsight ops is P0.7 `/invoke`→`MCPInvokeErrorResponseSchema`); unify envelope with `requestId`; `bank_id`→`bankId`; mark -32006..-32009 reserved.

**P0.6 — 2 HIGH + Gap A + 2 MED + 2 LOW:**
- P0.6-V-HIGH1: AC4 "atomic all-or-nothing batch" fiction — LSP `textDocument/diagnostic` is per-document, no batch primitive.
- P0.6-V-HIGH2: AC2b external-def model non-native + under-specified (ts-language-server returns actual `Location[]` w/ external URIs; `external:true` is pi-lens-layer; determination method unspecified).
- Gap A: line ~40 schema still asserts "structured details object" despite P0.5 caveat (structured came from `pilens_analyze`, not `pilens_lsp_diagnostics`).
- P0.6-V-MED3: AC1 conflates count-delta control with p95 — "warm" undefined, no sample count, no distribution source.
- P0.6-V-MED4: AC3a `LSP_INIT_TIMEOUT_S=10s` is an unverified guess.
- P0.6-V-LOW5/6: version-inheritance DoD checkbox; DoD contract-checkbox labeling.
- Citation fix: `lsp_navigation` returns `Location[]` (uri+range); "file:line:character" is presentation layer.

**Citation accuracy (all stories):** P0.1/P0.2/P0.7 primitive citations verified accurate against source. Contract alignment: P0.3↔P0.1 ALIGNED, P0.3↔P0.2 ALIGNED, P0.8↔P0.7 ALIGNED, P0.9↔P0.7 ALIGNED (bridge surface), P0.6↔P0.5 MISALIGNED (Gap A).

## Wave 5b/5c re-fix (complete)

- **P0.3** — `lead_failure` promoted into CC-1 (5-value enum + signal-table row + classifyExit-bypass note); `error.reason` unified to `{overflow,transient,logic,lead_failure}` (dropped `timeout`); flat P1.6 lead schema removed (full merged-output shape); lead-failure detection clarified. (+5 lines)
- **P0.6** — AC4 sequential per-file (not atomic; LSP one-doc-per-request); AC2b native `Location[]` + `external:true` as harness-layer URI-prefix convention; line-40 `lsp_diagnostics` schema TBD per P0.5 caveat (observed surface = `pilens_analyze`); WARM operationally defined (≥20 samples, `latency.log`); `LSP_INIT_TIMEOUT_S` 15 s; version DoD checkbox; DoD C1/C2 labels. (+4 lines)
- **P0.9** — dangling HTTP map dropped; Error Code Taxonomy gets a `Surface` column (`provisioner script` CLI+envelope vs `MCPInvokeErrorResponseSchema` bridge); `-32004` = quota envelope; all provisioner envelopes carry `requestId`; `RetainResponseSchema.bank_id`→`bankId`; `-32006..-32009` reserved. (+45 lines)

## Accepted residuals (cosmetic, documented — not blocking)

- **P0.3 AC#3** uses per-worker prose reason `"timeout"` for the partial-result path. This is a per-worker log reason, NOT the top-level `error.reason` enum (which is `{overflow,transient,logic,lead_failure}`); the CC-1 signal table already establishes coms_await timeout → `transient`. Defensible; left intact.
- **P0.6 AC2 parent line** still reads "file:line:character" (presentation format). Consistent with the corrected C2 contract (which clarifies it IS the presentation layer over native `Location[]`). Defensible; left intact.

## Open item requiring operator decision (parent surfaced, did NOT silently amend)

**P0.8-H2 → P0.7 per-route body-cap override.** P0.8 needs `/api/webhooks/{id}` to accept 5 MB payloads; P0.7's global `MAX_BODY_BYTES` is 1 MB (413 before HMAC). Options: (a) add a per-route body-cap override to P0.7 (additive, backward-compatible — recommended), or (b) raise the global cap (broader blast radius). P0.8 spec documents the dependency + a PROPOSED ADR placeholder. **No P0.7 edit made.** Operator to decide + approve the ADR before P0.8 dev can satisfy its make-or-break AC on >1 MB push payloads.

## Session log

- **2026-07-19 09:42** — Campaign start. Scope P0.3/P0.6/P0.8/P0.9. Pairing A=P0.8+P0.9, B=P0.3, C=P0.6. Wave -1 propagation mining: 16 findings seeded.
- **2026-07-19 09:5x** — Initial scan (3 paired reviewers): 16 propagation CONFIRMED (P0.3-M1 CORRECTED) + 24 new (1 BLOCKER P0.9-H1, 13 HIGH, …). Wave 0 cross-cuts CC-W1..W4 locked.
- **2026-07-19 10:0x** — Consolidated fix wave (3 paired fixers, bundled-by-file): P0.3 +31, P0.6 +16, P0.8 +39, P0.9 +57 lines. 1 judgment call flagged (P0.3 `lead_failure` enum).
- **2026-07-19 10:1x** — Wave 5 fresh-eyes verify (3 paired verifiers, uncoupled): 14 findings. P0.8 CLEAN. P0.3 1 BLOCKER (lead_failure contradiction), P0.9 4 (dangling HTTP map), P0.6 2 HIGH + Gap A (batch fiction, external-def, surface mismatch). All citations verified accurate.
- **2026-07-19 10:2x** — Wave 5b/5c re-fix (3 re-fixers): all verification findings resolved. 2 cosmetic residuals accepted with reasoning. **Campaign CONVERGED.**

## Outcome

4 Wave 2 specs hardened to absorb Wave 1's post-merge review lessons + correct factual drifts vs merged code. ~54 findings resolved across propagation → scan → fix → verify → re-fix. Specs now cite the actual hardened primitives (P0.1 `killChildTree`/`redactSecrets`/`classifyExit`, P0.2 `coms-core.ts` parity layer, P0.7 `MCPInvokeErrorResponseSchema`/`maskEnv`/body-cap/shutdown) instead of re-implementing naively. Expected: first dev-time bmad-code-review on each story surfaces minor nits, not 2–4 rounds of large fixes.

## Verified-correct elements (do not regress)

> Per story — items reviewers confirm are already sound; later fixes must not regress them.

_(populated during scan)_

## Wave progress

_(updated by parent after each wave)_

## Session log

- **2026-07-19 09:42** — Campaign start. Scope: P0.3, P0.6, P0.8, P0.9. Pairing: A=P0.8+P0.9, B=P0.3, C=P0.6. Wave -1 propagation mining complete (5+3+4+4 = 16 seeded findings, all parent-verified vs merged code). Tracker created. Initial scan dispatching next.
