# P0.2: Productionize Vendored coms.ts + Record In-Node Architecture Decision

**Story Points:** 3

## Spec Reference

- PRD §4.6 (Pi team coms contract); FR-EX-1, FR-EX-2
- Phase exit gate: PRD §13 Phase-0 clause 2 (coms smoke-test + arch decision)

## User Story

As a Pi swarm integrator,
I want vendored `coms.ts` productionized on `pi@0.55.0` and the subprocess-RPC vs socket-coms architecture decision recorded,
so that Pi agent teams can exchange messages peer-to-peer with structured replies (FR-EX-1, FR-EX-2, G1).

## Overview

Smoke-tests the vendored `coms.ts` + `coms-net.ts` from `pi-vs-claude-code-vendor/` on pinned `pi@0.55.0`, records the OQ-1 architecture decision (subprocess-RPC as day-1 default, socket-coms as viable alternative), and produces the decision artifact in the OQ registry. Cuts Pi execution layer only. 3 pts because it is one concern (coms viability + decision record) with no downstream wiring beyond the decision artifact.

## E2E Slice

**Demonstrable behavior:** A two-agent smoke test registers via `coms.ts` extensions on `pi@0.55.0`, a `coms_send` + `coms_await` exchange completes (or a subprocess-RPC `pi --mode json -p` exchange completes), and the OQ-1 decision artifact exists in `_bmad-output/` recording subprocess-RPC as default.

**Wiring closed:** On completion of this story, running the coms smoke-test script produces structured output showing ≥2 Pi agents registered and ≥1 message exchanged, plus the OQ decision artifact file exists. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone.

## Acceptance Criteria

1. **(make-or-break)** Given vendored `coms.ts` in the vendor tree, When the smoke-test script runs on `pi@0.55.0`, Then ≥2 Pi agents register and ≥1 structured message round-trips (coms_send → coms_await succeeds, or subprocess-RPC JSON parse succeeds).
2. Given the smoke-test results, When the OQ-1 decision is recorded, Then the artifact exists at `_bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md` with decision rationale and both paths documented.
3. Given `pi@0.55.0` pinned, When `pi -e ./coms.ts --list-models` runs, Then model listing succeeds (zero exit code) confirming extension load compatibility.

## Technical Notes

- **Contracts/Schema:** OQ decision artifact: markdown with sections (context, options, decision, rationale, constraints). Coms contract: `coms_send(target, prompt, conversation_id?, response_schema?)` / `coms_await(msg_id, timeout_ms?)` / `coms_get` / `coms_list`. `response_schema` is parse-only (`JSON.parse` on `agent_end`, NOT schema-validated — §5.2).
- **Integration points (each wired & exercised in this story):** vendored `coms.ts` loads on `pi@0.55.0`; `pi.registerFlag("cname", ...)` registers `--cname`; unix socket registry at `~/.pi/coms/` populated; subprocess-RPC `pi --mode json -p` produces parseable JSON event stream.
- **Files / functions touched:** `pi-vs-claude-code-vendor/coms.ts` (vendored, read-only verification), `scripts/coms-smoke-test.ts` (new), `_bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md` (new).
- **Guards/limits:** Default `coms_await` timeout 30 min (`PI_COMS_TIMEOUT_MS = 1_800_000ms`, ~`coms.ts:50`); receiver-side turn deadline `PI_COMS_TURN_DEADLINE_MS` (default 30 min, ~`coms.ts:54`); `MAX_HOPS=5` (fixed constant, ~`coms.ts:49`) for socket-coms.

## Files to Modify

- `scripts/coms-smoke-test.ts`
- `_bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md`
- `pi-vs-claude-code-vendor/package.json` (version pin verification)

## Security Invariants

- **INV-1:** Smoke test uses pi's ambient configured auth (whatever provider key pi already holds, selected via `PI_SMOKE_MODEL`); there is no test-key sandbox. Mitigation: env-secret values are redacted from captured output and the JSON report; no real secrets in test fixtures.
- **INV-2:** Unix socket coms files under `~/.pi/coms/` are per-user scope; no cross-user leakage.

## Definition of Done

- [x] **Impl:** Coms smoke-test script exercises both socket-coms registration and subprocess-RPC on `pi@0.55.0`.
- [x] **Impl:** OQ-1 architecture decision artifact written with subprocess-RPC as day-1 default and socket-coms as viable alternative.
- [x] **Contract:** `coms_send`/`coms_await`/`coms_get`/`coms_list` verb signatures documented in decision artifact with parse-only `response_schema` caveat.
- [x] **Integration:** Vendored `coms.ts` loads on `pi@0.55.0` with zero errors; `pi -e ./coms.ts --list-models` returns model listing.
- [x] **Test (smoke):** Two-agent registration succeeds; structured message parseable on both paths.
- [x] **Security:** INV-1 enforced: smoke test uses ambient pi auth with env-secret redaction from the JSON report; no real secrets in test fixtures. INV-2 enforced: unix socket files under `~/.pi/coms/` are per-user scope; no cross-user leakage.
- [x] **Observability:** OQ-1 decision artifact is well-formed markdown with all required sections (context, options, decision, rationale, constraints) and parseable by downstream tooling.
- [x] **Test (e2e demo — MANDATORY):** Smoke-test script produces structured JSON output showing ≥2 agents registered + ≥1 message exchanged; OQ-1 artifact file exists and is well-formed. Evidence: 2026-07-13 run of record (`agents_registered: 4`, `messages_exchanged: 3`, `pass: true`) embedded in the OQ-1 artifact's Evidence section; raw JSON at `_bmad-output/sprint-artifacts/_research/oq-1-smoke-run-2026-07-13.json`.

## Dev Agent Record

**Status:** done (2026-07-13) — PR #25, branch `feature/p0-2-coms-vendor-decision`.

- AC1 (make-or-break): PASS live — `PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5 bun scripts/coms-smoke-test.ts` exits 0 with 2 real `pi -e ./coms.ts` peers registered by coms.ts's own `session_start`, a real `coms_send`→`coms_await` round-trip (`"pong"`), and 2/2 subprocess-RPC `agent_end` round-trips. No waiver.
- AC2: PASS — `_bmad-output/sprint-artifacts/_research/oq-1-coms-arch-decision.md` with all required sections, amended 2026-07-13 with D1/D2/DEC1 decisions.
- AC3: PASS — both `coms.ts` and `coms-net.ts` load on pinned `pi@0.55.0`, `--list-models` exit 0 (251 models, 2026-07-10/13).

### Review Findings

bmad-code-review (2026-07-13): 3 parallel layers (Blind Hunter / Edge Case Hunter / Acceptance Auditor) over 3 diff chunks, verified triage, all findings fixed. 54 patch, 3 decision-needed (resolved), 8 dismissed as noise, 0 deferred.

**Decisions (resolved with user):**

- [x] [Review][Decision] D1: No IPC authentication; Windows named pipe without ACL — **resolved: shared-secret auth implemented.** Per-session `crypto.randomUUID()` secret in the 0700 registry entry, required in every `PromptEnvelope`, receivers nack mismatches before any turn; `coms_send` reads the target secret from its registry entry; win32 fails fast (POSIX-only release). [shared secret: `PromptEnvelope.secret` ~`coms.ts:119-121`, generated via `crypto.randomUUID()` in `session_start` ~`coms.ts:1582`; nack in `handlePrompt` via `secretEqual` ~`coms.ts:359, 1114-1117`; `coms_send` reads the target's registry secret ~`coms.ts:2246-2265`; response-secret verify in `handleResponse` ~`coms.ts:1223-1243`]
- [x] [Review][Decision] D2: `conversation_id` accepted but dropped — **resolved: threaded end-to-end** (envelope → InboundContext → `sendMessage` details → echoed in response; surfaced in `coms_get`/`coms_net_get`) in both coms.ts and coms-net.ts. [coms.ts: envelope `conversation_id` ~`coms.ts:125`, inbound threading in `handlePrompt` ~`coms.ts:1157-1164`, response echo ~`coms.ts:2657-2659`; coms-net.ts: envelope types ~`coms-net.ts:158-201`, inbound + send ~`coms-net.ts:1199-1254, 2286-2375`, get/await surfacing + response echo ~`coms-net.ts:2431-2650, 2767`]
- [x] [Review][Decision] DEC1: AC1 objectively red (auth-deferral) — **resolved: made genuinely green.** Live probe found Anthropic OAuth expired; smoke test now honors `PI_SMOKE_MODEL` and passes with real registrations + real `agent_end` events, no waiver. Also exposed+fixed a real coms.ts bug: pi 0.55.0 stores extension-injected messages as `custom_message` entries (not `message`), so replies never dispatched; plus a print-mode exit race (fire-and-forget `agent_end` killed by `process.exit`) closed with a synchronous exit-fallback delivery. [`custom_message` match in `activeInbound` ~`coms.ts:1042-1051`, `agent_end` anchor + branch walk ~`coms.ts:2551-2554, 2582-2589`; exit-fallback `pendingExitDispatches` ~`coms.ts:2669, 2704-2708`, synchronous `process.on("exit")` delivery ~`coms.ts:2820-2839`]

**Patches (all applied):**

- [x] [Review][Patch] A1: Hop-limit bypass via negative/NaN hops [coms.ts:799]
- [x] [Review][Patch] A2: pendingReplies registered after sendEnvelope — fast reply orphaned [coms.ts:1746-1787]
- [x] [Review][Patch] A3: coms_get reported "complete" when result.error set [coms.ts:1855]
- [x] [Review][Patch] A4: Unvalidated peer agent_card fields crash TUI render [coms.ts:1543-1567]
- [x] [Review][Patch] A5: session_start reentrant — double-bound servers/timers [coms.ts:1000-1020]
- [x] [Review][Patch] A6: inboundQueue unbounded, no eviction [coms.ts:56, 815, 1311-1317]
- [x] [Review][Patch] A7: prompt/sender fields not type-checked before injection [coms.ts:806-809]
- [x] [Review][Patch] A8: Same-name startup race hard-failed instead of retrying [coms.ts:1132-1176]
- [x] [Review][Patch] A9: Env numerics + coms_await timeout_ms unsanitized [coms.ts:34-42, 1905-1907]
- [x] [Review][Patch] A10: coms_get rendered "undefined" on absent response [coms.ts:1851]
- [x] [Review][Patch] A11: Dead code (keepaliveTouch, reject, unused imports) [coms.ts]
- [x] [Review][Patch] A12: renderPool did sync FS reads per TUI frame [coms.ts:1516, 1364-1367]
- [x] [Review][Patch] A13: probeStaleSocket 250ms verdict could unlink live socket [coms.ts:519-523]
- [x] [Review][Patch] A14: session_start failure paths leaked display filters [coms.ts:1037-1039]
- [x] [Review][Patch] A15: /coms substring --all match + unvalidated --project [coms.ts:2061-2079]
- [x] [Review][Patch] B1: coms_net_await timeout uncapped (Infinity/overflow) [coms-net.ts:1897-1903]
- [x] [Review][Patch] B2: long-poll non-terminal status reported as empty success [coms-net.ts:1956-1961]
- [x] [Review][Patch] B3: register response sse_url unvalidated [coms-net.ts:1231-1235]
- [x] [Review][Patch] B4: send response msg_id unvalidated [coms-net.ts:1740-1743]
- [x] [Review][Patch] B5: Untrusted AgentCard fields crash widget/list [coms-net.ts:302-328]
- [x] [Review][Patch] B6: Aborted/empty turn POSTed as empty success [coms-net.ts:2068-2074]
- [x] [Review][Patch] B7: SSE terminal status left zombie online agent [coms-net.ts:1072-1077]
- [x] [Review][Patch] B8: inboundQueue no TTL/dedupe [coms-net.ts:928-933, 1468-1475]
- [x] [Review][Patch] B9: No reply resync after SSE reconnect [coms-net.ts:1166-1189]
- [x] [Review][Patch] B10: Env-parsed constants unvalidated [coms-net.ts:42-55]
- [x] [Review][Patch] B11: Raw peer strings (ANSI/control chars) into TUI/prompts [coms-net.ts:289-298]
- [x] [Review][Patch] B12: --project switch mixed-project pool widget [coms-net.ts:1498]
- [x] [Review][Patch] B13: httpFetch unbounded resp.text() body [coms-net.ts:333-354]
- [x] [Review][Patch] B14: SSE cap mixed code units with bytes [coms-net.ts:739]
- [x] [Review][Patch] B15: data-less/colon-less SSE events silently dropped [coms-net.ts:689-729]
- [x] [Review][Patch] B16: heartbeat_interval_ms declared but ignored [coms-net.ts:603, 1397-1402]
- [x] [Review][Patch] B17: PendingReply.reject dead; teardown stranded awaits [coms-net.ts:1278-1284]
- [x] [Review][Patch] B18: health-check comment contradicted bearer behavior [coms-net.ts:1370-1371]
- [x] [Review][Patch] B19: invalid --server-url got misleading error [coms-net.ts:1339-1349]
- [x] [Review][Patch] B20: stale PI_COMS_PROJECT env name in comment [coms-net.ts:393]
- [x] [Review][Patch] B21: --all substring-matched toggle [coms-net.ts:2123-2160]
- [x] [Review][Patch] B22: /coms-net refresh failure invisible [coms-net.ts:2178]
- [x] [Review][Patch] B23: docs referenced nonexistent coms-net-server.ts [coms-net.ts:20-22]
- [x] [Review][Patch] B24: response_schema forwarded without shape validation [coms-net.ts:1712-1717]
- [x] [Review][Patch] B25: concurrent awaits on same msg_id double-consume [coms-net.ts:1908-1916]
- [x] [Review][Patch] C1: No timeout on pi spawns — smoke could hang [coms-smoke-test.ts]
- [x] [Review][Patch] C2: spawn error/signal/null-status uninspected; no maxBuffer [coms-smoke-test.ts]
- [x] [Review][Patch] C3: PI_COMS_DIR never passed to spawned pi [coms-smoke-test.ts]
- [x] [Review][Patch] C4: inv2 check was a tautology (tmpdir-built path) [coms-smoke-test.ts]
- [x] [Review][Patch] C5: test envelope didn't match real PromptEnvelope [coms-smoke-test.ts]
- [x] [Review][Patch] C6: AC3 model count coupled to hardcoded provider regex [coms-smoke-test.ts]
- [x] [Review][Patch] C7: auth detection single stderr regex [coms-smoke-test.ts]
- [x] [Review][Patch] C8: uncaught fs errors aborted run without JSON report [coms-smoke-test.ts]
- [x] [Review][Patch] C9: coms-net.ts never load-tested [coms-smoke-test.ts]
- [x] [Review][Patch] C10: decision doc misstated socket location [oq-1-coms-arch-decision.md:144-152]
- [x] [Review][Patch] C11: stale response_schema citation [oq-1-coms-arch-decision.md:121]
- [x] [Review][Patch] C12: frozen "251 models" evidence would rot [oq-1-coms-arch-decision.md]
- [x] [Review][Patch] C13: primaryExtensionName trusted argv[i+1] [themeMap.ts:102-118]
- [x] [Review][Patch] C14: vendored MIT code shipped no LICENSE/attribution [pi-vs-claude-code-vendor/LICENSE]

**Verification:** biome clean on all touched files; repo `tsc --noEmit` exit 0; scoped vendor tsc zero new errors vs baseline; live smoke run exit 0 (`pass: true`, all 10 checks ok).

**Round 2 (2026-07-13, 12 layers: blind/edge/auditor × 4 groups):** ~60 raw findings → 52 patch, 0 decision-needed, 0 deferred, ~8 dismissed (duplicates/false positives across layers). All patches applied.

- [x] [Review][Patch] R2-1: envPositiveInt floored fractional (0,1) env values to 0 [coms.ts:35]
- [x] [Review][Patch] R2-2: Crossed reply attribution with queued inbounds — FIFO turnQueue [coms.ts, coms-net.ts]
- [x] [Review][Patch] R2-3: Replayed msg_id re-injected turns — 1h tombstone set [coms.ts, coms-net.ts]
- [x] [Review][Patch] R2-4: agent_end fabricated empty response when anchor compacted away [coms.ts]
- [x] [Review][Patch] R2-5: pendingExitDispatches unbounded growth [coms.ts]
- [x] [Review][Patch] R2-6: bindEndpoint probe-timeout unlinked live peer socket [coms.ts]
- [x] [Review][Patch] R2-7: Response path unauthenticated — secret echo + timing-safe verify [coms.ts; coms-net.ts: corrected 2026-07-14 — never implemented there; response authentication is delegated to the server contract (unknown envelope fields don't verifiably round-trip), disclosed in code + audited once per session as `response_auth_delegated`]
- [x] [Review][Patch] R2-8: removeRegistryEntry residual TOCTOU — inode/mtime recheck [coms.ts]
- [x] [Review][Patch] R2-9: Dead code readAllRegistryEntriesAcrossProjects removed [coms.ts]
- [x] [Review][Patch] R2-10: coms_await/coms_net_await dropped conversation_id [coms.ts, coms-net.ts]
- [x] [Review][Patch] R2-11: Receiver turn deadline coupled to sender TIMEOUT_MS — PI_COMS_TURN_DEADLINE_MS [coms.ts]
- [x] [Review][Patch] R2-12: Non-string registry fields crashed widget render [coms.ts]
- [x] [Review][Patch] R2-13: refreshPool concurrent runs (interval vs /coms) [coms.ts]
- [x] [Review][Patch] R2-14: Concurrent coms_await same msg_id double-consume [coms.ts]
- [x] [Review][Patch] R2-15: coms_send ack-loss deleted pending reply [coms.ts]
- [x] [Review][Patch] R2-16: cleanShutdown left identity set (zombie sender) [coms.ts]
- [x] [Review][Patch] R2-17: Any non-nack JSON accepted as ack — require type+msg_id match [coms.ts]
- [x] [Review][Patch] R2-18: Secret compare not constant-time — timingSafeEqual [coms.ts]
- [x] [Review][Patch] R2-19: sanitizePeerText left C1 controls (U+0080–U+009F) [coms-net.ts]
- [x] [Review][Patch] R2-20: Self-send guard in coms_send/coms_net_send [coms.ts, coms-net.ts]
- [x] [Review][Patch] R2-21: Non-object response_schema silently coerced — explicit throw [coms.ts, coms-net.ts]
- [x] [Review][Patch] R2-22: Registry file written 0644 carrying secret — chmod 0600 [coms.ts]
- [x] [Review][Patch] R2-23: Co-load flag collision with coms-net — duplicate-tolerant registerFlag [coms.ts, coms-net.ts]
- [x] [Review][Patch] R2-24: MAX_HOPS env-overridable to 64 — fixed constant 5 [coms.ts, coms-net.ts]
- [x] [Review][Patch] R2-25: cleanShutdown never settled pendingReplies (30-min hang) [coms-net.ts]
- [x] [Review][Patch] R2-26: Failed response POST marked inbound fulfilled — one retry + final audit [coms-net.ts]
- [x] [Review][Patch] R2-27: coms_net_get fast path reported errored reply as "complete" [coms-net.ts]
- [x] [Review][Patch] R2-28: /coms-net --all toggle no-op render — snapshot key covers flags [coms-net.ts]
- [x] [Review][Patch] R2-29: Heartbeat no in-flight guard [coms-net.ts]
- [x] [Review][Patch] R2-30: Runtime messages referenced unshipped coms-net-server.ts [coms-net.ts]
- [x] [Review][Patch] R2-31: Reconnect cluster: terminal re-register → cleanShutdown; manual reconnect failure → reschedule; heartbeat cadence refresh; stale-generation guard; non-string prompt nack; body-cap reader cancel; long-poll malformed-reply guard; stale-anchor prune [coms-net.ts]
- [x] [Review][Patch] R2-32: server_url userinfo/query/fragment not stripped; audit log credential risk [coms-net.ts]
- [x] [Review][Patch] R2-33: process.exit truncated piped JSON report — writeSync + exitCode [coms-smoke-test.ts]
- [x] [Review][Patch] R2-34: AC3 fallback counted stdout noise as models; no extension-load negative assertion [coms-smoke-test.ts]
- [x] [Review][Patch] R2-35: Version-pin first-match fragility — exact-line match [coms-smoke-test.ts]
- [x] [Review][Patch] R2-36: Auth-failure regex false-positives on model output — stderr-only tightened [coms-smoke-test.ts]
- [x] [Review][Patch] R2-37: Peer-early-exit mislabeled as transport failure [coms-smoke-test.ts]
- [x] [Review][Patch] R2-38: Registry-file presence as socket readiness proxy — real connect probe [coms-smoke-test.ts]
- [x] [Review][Patch] R2-39: Orphaned grandchildren; finally rmSync could mask result — killTree + awaited close [coms-smoke-test.ts]
- [x] [Review][Patch] R2-40: Shape-coverage fake ULID — real Crockford-base32 ULID [coms-smoke-test.ts]
- [x] [Review][Patch] R2-41: package.json unenforced engines.pi removed [pi-vs-claude-code-vendor/package.json]
- [x] [Review][Patch] R2-42: stderr cap silently dropped diagnostics — truncated flag surfaced [coms-smoke-test.ts]
- [x] [Review][Patch] R2-43: win32 shell quoting mangled embedded quotes [coms-smoke-test.ts]
- [x] [Review][Patch] R2-44: Skipped checks laundered failures — structural SKIPPABLE allowlist + PI_SMOKE_STRICT gate [coms-smoke-test.ts]
- [x] [Review][Patch] R2-45: Ambient env secrets could leak into report — value redaction [coms-smoke-test.ts]
- [x] [Review][Patch] R2-46: Registration counted headers from failed processes [coms-smoke-test.ts]
- [x] [Review][Patch] R2-47: Pinned envelope shape copy drifted from contract [coms-smoke-test.ts]
- [x] [Review][Patch] R2-48: OQ-1 artifact self-contradicted AC1 status (red run-of-record vs green claims) — post-remediation run embedded [oq-1-coms-arch-decision.md]
- [x] [Review][Patch] R2-49: OQ-5 (pi 0.55.0 vs coms.ts 0.73+ skew) decision unrecorded — section added [oq-1-coms-arch-decision.md]
- [x] [Review][Patch] R2-50: D1 threat model circular vs same-user attacker — honest residual + chmod/file-mode/contract gaps documented [oq-1-coms-arch-decision.md]
- [x] [Review][Patch] R2-51: Contract gaps: await timeout/unknown-id, target precedence, fenced-JSON unwrap, response secret, MAX_HOPS const [oq-1-coms-arch-decision.md]
- [x] [Review][Patch] R2-52: Story stale citations + INV-1 drift + artifact header date [p0-2-coms-vendor-decision.md, oq-1-coms-arch-decision.md]

**bmad-code-review round 3 (2026-07-13): 3 parallel layers over 3 diff chunks, verified triage, all findings fixed. 42 patch (13+18+11), 0 decision-needed, 0 deferred, 0 dismissed.**

**Patches (all applied):**

- [x] [Review][Patch] A1: `pendingExitDispatches` grows unbounded, survives session resets, and can hang process exit [coms.ts:74, 1252, 2471-2476]
- [x] [Review][Patch] A2: `agent_end` fulfills the oldest queued inbound on *every* turn end, including turns coms did not trigger [coms.ts:2320-2341]
- [x] [Review][Patch] A3: Malformed `<name>.json` in the registry permanently blocks that agent name [coms.ts:1431-1448]
- [x] [Review][Patch] A4: `turnQueue` entries shifted and discarded when `identity` is null [coms.ts:2315, 2341]
- [x] [Review][Patch] A5: `response_schema` enforced on reply but never documented to callers [coms.ts:2012]
- [x] [Review][Patch] A6: `refreshInFlight` latch force-reset mid-refresh → torn cross-session `peerCards` writes [coms.ts:883, 1262, 1780, 1807-1809]
- [x] [Review][Patch] A7: Registry secret file world-readable between publish and chmod [coms.ts:397-399, 464]
- [x] [Review][Patch] A8: `probeStaleSocket` treats `ECONNREFUSED` as "definitively stale" — false on Linux with a full accept backlog [coms.ts:638-646]
- [x] [Review][Patch] A9: `coms_list` interpolates peer-controlled `context_used_pct` without the validation `refreshPool` got [coms.ts:1940-1946]
- [x] [Review][Patch] A10: No per-field size cap: an authenticated peer can inject up to ~16MB prompts [coms.ts:70, 1021-1027]
- [x] [Review][Patch] A11: `session_shutdown` during `onSessionStart` init wedges the `shuttingDown` latch → registry entry and socket leak [coms.ts:2546-2554]
- [x] [Review][Patch] A12: `TURN_DEADLINE_MS` pruning deletes inbound entries without tombstoning → replay-guard hole [coms.ts:1586-1594]
- [x] [Review][Patch] A13: `envPositiveInt` accepts 1 ms → `PI_COMS_PING_INTERVAL_MS` can busy-loop the ping cycle [coms.ts:55-57]
- [x] [Review][Patch] B1: Failed response POST produces duplicate submissions and corrupts the retry-timer map [coms-net.ts:~2264, ~2355, ~2374]
- [x] [Review][Patch] B2: `/coms-net --reconnect` silently no-ops after a terminal-status cleanShutdown [coms-net.ts:~2403-2420]
- [x] [Review][Patch] B3: Non-anchored `turnQueue` head stalls FIFO attribution for up to ~31 minutes [coms-net.ts:~2248-2258]
- [x] [Review][Patch] B4: Server-assigned agent name stored and rendered unsanitized [coms-net.ts:~1403-1419]
- [x] [Review][Patch] B5: SSE read-loop abort race kills the reconnect loop [coms-net.ts:~1248-1258]
- [x] [Review][Patch] B6: Heartbeat eviction of an aborted-turn inbound skips the tombstone → stale re-injection after reconnect [coms-net.ts:~1494]
- [x] [Review][Patch] B7: Negative `hops` from a peer bypasses `MAX_HOPS` [coms-net.ts:~1061-1064]
- [x] [Review][Patch] B8: SSE `response` event and reconnect-resync resolve a complete-without-response reply as a blank success [coms-net.ts:~1146-1153, ~1333-1340]
- [x] [Review][Patch] B9: Non-OK, non-terminal SSE HTTP responses leak the unread body/socket [coms-net.ts:~1211]
- [x] [Review][Patch] B10: Inbound prompt text has no size cap before injection into the session [coms-net.ts:~1050-1056]
- [x] [Review][Patch] B11: SSE parser's per-feed `Buffer.byteLength(buf)` contradicts the claimed O(N) parsing [coms-net.ts:~799-805, ~852-861, ~876, ~894]
- [x] [Review][Patch] B12: Boot-failure returns leave `identity` set in a half-initialised extension [coms-net.ts:~1590, ~1598, ~1611, ~1624, ~1638]
- [x] [Review][Patch] B13: `cleanShutdown` leaves `identity`/`serverUrl`/`authToken` populated; tools keep firing with a dead token [coms-net.ts:~1817, ~1904]
- [x] [Review][Patch] B14: `coms_net_list` renders raw `context_used_pct`, including NaN [coms-net.ts:~1846, ~1874]
- [x] [Review][Patch] B15: `tombstoneFulfilled`'s 1000-entry bound is not enforced under a distinct-id flood [coms-net.ts:~1118-1127]
- [x] [Review][Patch] B16: `findSystemPromptPath` misses the `--flag=value` argv form [coms-net.ts:~369-374]
- [x] [Review][Patch] B17: `coms_net_await` drops `conversation_id` when the server long-poll wins with no local pending entry [coms-net.ts:~2158-2173, ~2214, ~2221]
- [x] [Review][Patch] B18: Send-side `response_schema` validation rejects arrays, receiver accepts them; parity comment is wrong [coms-net.ts:~1067]
- [x] [Review][Patch] C1: win32 `shell: true` arg quoting is ineffective [coms-smoke-test.ts:~252-255]
- [x] [Review][Patch] C2: Path A `registered` counts processes that exited non-zero [coms-smoke-test.ts:~421-422]
- [x] [Review][Patch] C3: `extBase` via `split("/")` breaks AC3 load-failure detection on win32 [coms-smoke-test.ts:~179-181]
- [x] [Review][Patch] C4: `models_listed` report fields can show a model count while the AC3 check failed [coms-smoke-test.ts:~196]
- [x] [Review][Patch] C5: STRICT mode still lets a *skipped* `socket_live_round_trip` satisfy the gate [coms-smoke-test.ts:~942]
- [x] [Review][Patch] C6: `waitForReady`-fail branch records no `socket_registry_two_agents` entry [coms-smoke-test.ts:~598-604]
- [x] [Review][Patch] C7: INV-1 redaction allowlist misses common secret-bearing env names [coms-smoke-test.ts:~84-87]
- [x] [Review][Patch] C8: Final `writeSync(1, …)` can throw uncaught EPIPE and lose the report [coms-smoke-test.ts:~948-953]
- [x] [Review][Patch] C9: Version-pin regex duplicates the `PIN` literal [coms-smoke-test.ts:~144]
- [x] [Review][Patch] C10: `THEME_MAP[name]` allows prototype-chain hits instead of the synthwave fallback [themeMap.ts:~76-78]
- [x] [Review][Patch] C11: OQ-1 artifact cites a `package.json` `engines` field that no longer exists [oq-1-coms-arch-decision.md:38]

### Remediation Round (2026-07-13)

Second adversarial review round, 12 layers (Blind Hunter / Edge Case Hunter /
Acceptance Auditor × 4 file groups: coms.ts, coms-net.ts, smoke test, docs).
~60 raw findings triaged to ~55 patches: coms.ts (23), coms-net.ts (15
contract + 11 reconnect), smoke test (15), plus docs fixes. Key outcomes:
response-secret auth on both envelopes (timing-safe, `forged_response`
audit), `MAX_HOPS=5` fixed constant (env knobs removed),
`PI_COMS_TURN_DEADLINE_MS` receiver-side knob, registry files chmod 0600,
strict gate `PI_SMOKE_STRICT=1`, `coms_await` surfaces `conversation_id`, C1
control chars stripped, self-send rejected, non-object `response_schema`
rejected.

**Verification:** repo `tsc --noEmit` clean; biome clean on touched files;
vendored-code standard "no new tsc errors vs baseline" held (zero new errors);
fresh smoke run 2026-07-13 (`PI_SMOKE_STRICT=1
PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5`): `pass: true`, all 10
checks ok, AC1 true (both clauses), both AC3 checks true — raw JSON at
`_bmad-output/sprint-artifacts/_research/oq-1-smoke-run-2026-07-13.json`,
embedded in the OQ-1 artifact Evidence section.

### Review Findings — Round 4 (2026-07-13)

bmad-code-review round 4: 6 layers (blind/edge/adversarial hunters +
verification-gap + acceptance-auditor) over coms.ts, coms-net.ts, the smoke
test, and docs/themeMap. ~70 raw findings → 56 patch items, 2 dismissed
(documented scope deviation; informational), 0 decision-needed. **56/56
resolved** (55 patched; 1 verified already-correct in current code). A
regression re-review of the fix diff caught 17 follow-up issues (3 coms.ts,
8 coms-net.ts, 6 script/docs — incl. a real turnQueue reply-loss regression
from the round-4 edits); all 17 fixed. Wiring the vendor dir into tsconfig
with real pi 0.55.0 types surfaced 52 latent strictness errors (implicit-any
through `any`-typed safe-register helpers, unchecked indexed access, pi API
`number | null` pct) — all fixed without behavior change. Post-remediation:
repo `tsc --noEmit` clean, biome clean, `bun test` green (6/6, incl. the new
oq1-evidence gate). Key themes:

- [x] Session-latch races: concurrent session_start/shutdown serialized on one
  latch (both files); bounded init spin; exit-handler install-once + budget
  guards; duplicate-safe tool/command registration [coms.ts, coms-net.ts]
- [x] Response/prompt size caps at both trust boundaries; nack-as-rejection;
  sender field sanitization; corrupt-registry pruning; queue/tombstone caps;
  in-flight awaits resolved on reset/shutdown [coms.ts, coms-net.ts]
- [x] Raw-socket negative probes (wrong secret, hop overflow, oversized line)
  augment the client-side shape self-check (now honestly labeled as a drift
  detector); strict gate is now the default with a loud `pass_with_waiver`
  mode [coms-smoke-test.ts]
- [x] INV-1 env scoping: pi children get a minimal env allowlist (only the
  needed provider key; full-env fallback disclosed via `env_scope`); redaction
  demoted to defense-in-depth [coms-smoke-test.ts, oq-1-coms-arch-decision.md]
- [x] Docs: stale coms.ts line refs refreshed to symbol+approx-line form;
  `bAnswered:false` disclosed in Evidence; coms-net server redelivery
  contract recorded [oq-1-coms-arch-decision.md]
- [x] Repo wiring: `smoke:coms` script, vendor dir in lint paths and tsconfig
  include (pi 0.55.0 types via vendor devDependency), `tests/oq1-evidence.test.ts`
  gating the run of record [package.json, tsconfig.json, tests/]
- [x] themeMap: `--extension=path` equals-form parsed, title-defer race
  documented, theme-apply failures warn once [themeMap.ts]

### Senior Developer Review (AI) — bmad-code-review round 5 (2026-07-14)

**Reviewer:** Official BMAD `code-review` workflow (BMM 4-implementation), executed as waves of parallel subagents (4 reviewers → verified triage → 5 fixers → verification + adversarial regression re-review → regression fixes → live re-verification).
**Outcome:** Changes Requested → **all resolved** (35/35). Story stays `done`.

#### Summary

Fresh systematic review of the merged P0.2 scope (post-round-4 HEAD `6b306fe`): 29 raw findings (3 HIGH, 5 MEDIUM, 21 LOW), triage re-verified every one against current code (0 dismissed, 0 merged). All 29 fixed, including LOW. An adversarial regression re-review of the fix diff caught 5 follow-ups (2 MEDIUM, 3 LOW) — all fixed. A live smoke re-run then caught the real root cause of two red runs: a **harness timing coin flip**, not a protocol bug (see below). Post-remediation: biome clean, `tsc --noEmit` exit 0, `bun test` 190/190, and a fresh strict-gate live smoke run green 13/13.

#### Key Findings (by severity)

**HIGH (3):**
- [x] Batched follow-up turns share one `agent_end` (pi 0.55.0 runLoop — verified in pinned `agent-loop.js`); fulfilling one inbound per event + unbounded post-anchor walk → cross-attributed/lost replies. Fixed per-turn in **both** coms.ts and coms-net.ts: every anchored unfulfilled entry fulfilled per event, reply text sliced between its anchor and the next inbound's anchor; unanchored slots kept (not starved); exit-fallback dispatches all pushed synchronously before the first await (print-mode exit race).
- [x] SSE half-open watchdog (coms-net) aborted the connection but the intentional-abort guard swallowed it → inbound delivery died permanently while heartbeats kept the agent "online". Now falls through to `scheduleReconnect()` with a `watchdog_timeout` audit.
- [x] Evidence gate (`oq1-evidence.test.ts`) could not distinguish a strict run from a waived regeneration. Hardened: gen-2 reports must carry `strict: true`, gate_note must match strict-gating phrasing and not waiver markers; frozen gen-1 JSON still accepted via its legacy strict phrasing.

**MEDIUM (5 + 2 regression):**
- [x] coms.ts pong-card + registry `purpose`/`model`/`cwd` fields rendered/returned unsanitized (ANSI + prompt-injection channels missed by prior rounds) → sanitized at ingestion.
- [x] coms-net response path unauthenticated — R2-7 was **over-claimed** in this story (line 148 corrected): the scheme isn't safely implementable (server doesn't verifiably round-trip unknown envelope fields); now disclosed in code + audited once/session as `response_auth_delegated`; residual gap documented.
- [x] Response payloads uncapped at producer (coms.ts) and receiver (coms-net) → 256 KB caps with explicit "response too large" errors both sides.
- [x] `bun run typecheck` failed on fresh checkout (vendor deps never installed) → vendor dir is now a bun workspace; fresh-clone `bun install && bun run typecheck` verified exit 0; documented in AGENTS.md/CLAUDE.md.
- [x] win32: `spawnSync` probes didn't quote args (AC3 broke on space paths) → shared `win32ShellArgs` helper.
- [x] Regression: coms.ts shifted unanchored turnQueue slots while coms-net kept them → parity restored (keep + re-anchor); duplicate-POST window closed with a synchronous `dispatching` claim flag.

**LOW (21 + 3 regression):** all fixed — sender_endpoint length cap; fractional `coms_await` timeout rejected; `context_used_pct` clamped to [0,100]; registry `.tmp` reaping; response_schema receiver-side shape/32 KB cap (parity); `msg_id` ≤128 + ULID gates; `agent_end` shutdown guard; `sanitizeCardPatch` status coercion; renderCall/sender.session_id sanitization; heartbeatTick try-wrap; win32 env allowlist (case-insensitive + SystemRoot et al.); `waitForEntry` early-exit on peer death; dead comments corrected (5); story D1/D2/DEC1 citation blocks refreshed to symbol+approx-line form (F-1..F-3, F-5); OQ-1 Evidence notes the frozen JSON is report-schema gen 1 (F-4).

**Harness root cause (found by live re-run):** `socket_live_round_trip` went red twice — isolated repro proved the protocol path works end-to-end with the round-5 code. The real cause: B's followUp answer runs only after its `sleep 60` stay-alive turn ends (~70-90s after B's boot), but A's `coms_await` budget was 45s and the spawn cap 90s — a model-latency coin flip. Fixed: `AWAIT_TIMEOUT_MS` 45s→150s, `SPAWN_TIMEOUT_MS` 90s→240s, comments updated (C19).

#### Acceptance Criteria Coverage

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC1 | Smoke run ≥2 agents register + ≥1 structured round-trip on pi@0.55.0 | IMPLEMENTED | Fresh strict-gate run 2026-07-14: `pass: true`, `agents_registered: 4`, `messages_exchanged: 3`, `socket_live_round_trip` content-verified `"pong"`, 13/13 checks — raw JSON `_bmad-output/sprint-artifacts/_research/oq-1-smoke-run-2026-07-14.json` (gen-2, `strict: true`, no waiver). Prior run of record 2026-07-13 also stands (gen-1). |
| AC2 | OQ-1 artifact with context/options/decision/rationale/constraints | IMPLEMENTED | `_research/oq-1-coms-arch-decision.md` — all five sections present (auditor-verified). |
| AC3 | `pi -e ./coms.ts --list-models` exit 0 | IMPLEMENTED | Both extensions load, `models_listed: 251` in the 2026-07-14 run (`ac3_extension_loads_coms`, `ac3_extension_loads_coms_net` green). |

**3 of 3 acceptance criteria fully implemented.**

#### Task / DoD Completion Validation

8 of 8 DoD boxes re-verified against current code with file:line evidence (contract verb signatures + parse-only `response_schema` caveat documented; zero-error extension load; INV-1 redaction + env allowlist; INV-2 per-user isolation; well-formed OQ-1 sections; e2e evidence embedded). Zero checked-but-unverifiable items.

#### Test Coverage and Gaps

`tests/oq1-evidence.test.ts` hardened (strict/waiver discrimination, above); 190/190 `bun test` green. No new test gaps; the live round-trip remains gated by the strict smoke run rather than a unit test (by design — it needs real pi peers).

#### Security Notes

Sanitization coverage extended to pong cards, registry-derived fields, renderCall args, `sender.session_id`; response-side auth in coms-net honestly documented as delegated-to-server (was over-claimed); producer+receiver response size caps; ULID gates on both response paths.

#### Verification

biome clean on touched files; repo `tsc --noEmit` exit 0 (fresh-clone path verified: `rm -rf node_modules pi-vs-claude-code-vendor/node_modules && bun install && bun run typecheck`); `bun test` 190/190; live strict-gate smoke 2026-07-14 exit 0 (`PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5`): `pass: true`, 13/13 checks, AC1 green with content-verified reply. Review artifacts: `.swarm/p0-2-review/round5/` (findings ×4, triage, regression-review). GitNexus MCP `impact`/`detect_changes` were unavailable in this session (CLI exposes analyze/status/clean/wiki only) — manual caller checks performed instead; index predates this branch.
