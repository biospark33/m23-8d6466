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
- **Guards/limits:** Default `coms_await` timeout 30 min (`PI_COMS_TIMEOUT_MS = 1_800_000ms`, `coms.ts:46`); receiver-side turn deadline `PI_COMS_TURN_DEADLINE_MS` (default 30 min, `coms.ts:50`); `MAX_HOPS=5` (fixed constant, `coms.ts:45`) for socket-coms.

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

- [x] [Review][Decision] D1: No IPC authentication; Windows named pipe without ACL — **resolved: shared-secret auth implemented.** Per-session `crypto.randomUUID()` secret in the 0700 registry entry, required in every `PromptEnvelope`, receivers nack mismatches before any turn; `coms_send` reads the target secret from its registry entry; win32 fails fast (POSIX-only release). [coms.ts:78-80, 789-793, 1035-1038, 1132]
- [x] [Review][Decision] D2: `conversation_id` accepted but dropped — **resolved: threaded end-to-end** (envelope → InboundContext → `sendMessage` details → echoed in response; surfaced in `coms_get`/`coms_net_get`) in both coms.ts and coms-net.ts. [coms.ts:166, 835, 2027; coms-net.ts:937, 967, 2096]
- [x] [Review][Decision] DEC1: AC1 objectively red (auth-deferral) — **resolved: made genuinely green.** Live probe found Anthropic OAuth expired; smoke test now honors `PI_SMOKE_MODEL` and passes with real registrations + real `agent_end` events, no waiver. Also exposed+fixed a real coms.ts bug: pi 0.55.0 stores extension-injected messages as `custom_message` entries (not `message`), so replies never dispatched; plus a print-mode exit race (fire-and-forget `agent_end` killed by `process.exit`) closed with a synchronous exit-fallback delivery. [coms.ts:775-797, 2006-2022, 2068-2076, 2175-2195]

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
- [x] [Review][Patch] R2-7: Response path unauthenticated — secret echo + timing-safe verify [coms.ts, coms-net.ts]
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
