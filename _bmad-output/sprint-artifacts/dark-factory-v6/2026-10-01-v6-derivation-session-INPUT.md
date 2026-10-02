# Dark Factory v6 — Derivation-Session INPUT (program charter)

**Date:** 2026-10-01 (evening session, post-v5-closeout)
**Status:** ACTIVE — this file is the SOURCE OF TRUTH for the v6 derivation session. Chat context is disposable; this file is not.
**Consumer:** the next Claude session, invoked by the operator with `/qds-sprint-planning`, pointing at this file. It performs the v6 derivation (DD register + story specs) per the process in §9.
**Provenance:** produced by the 2026-10-01 scoping session (exploration: 4 read-only agents over factory/zeropoint/Solstice repos + memory recovery + web research). Every load-bearing fact was file-verified or live-verified and carries its source path.
**Rule honored:** the v5 derivation register (`docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`) and ADR-1 are closed records — never edited. Everything v6 decides enters as **DD-14+** in a NEW register and as NEW D-numbers via ADRs. Changes never enter as quiet scope growth (the autonomy-horizon review's standing rule).

---

## 0. Operator decisions locked 2026-10-01 (SETTLED — do not re-litigate; contradicting facts → surface to steve first)

| # | Decision | Rationale (recorded) |
|---|---|---|
| **D-1** | **Two sprints.** v6a "Foundation" = 11 stories / 36 pts, THE next sprint, zero E21 gates, ships standalone. v6b "Autonomy" = 12 / 45, everything requiring E21 Home bots. Physical cut line: *does the story need Home bots.* | Prior sketch (8–10/25–30) priced the shallow integration; deep E21 + vision honoring cannot land in one ~45-pt sprint without bandaids. Expect +10–15% review growth (DD-13 precedent: +12 on 111). |
| **D-2** | **Factory KG = dedicated Hindsight 0.10.0** (re-pin from the 0.8.6 the HANDOFF verified), own container — NEVER the shared zeropoint tenant sidecar. Only front door = the M2 memory gateway with real authz (per-run scoped **recall-only** keys via DF2.3 mint/revoke machinery). No presidio/PII/tenant machinery (factory data = code/run artifacts). Structured truth (run records, cost ledger, audit chain) stays in `.sandbox/` SQLite — KG sits beside it, never replaces it. | Fixes the verified no-auth danger (0.8.6 answered 200 with no auth header; bank_id per-call with no per-bank auth) by topology, not trimming. All written assets count: `src/hindsight/client.ts` (bank-scoped retain/recall/reflect/consolidate), `scripts/provision-hindsight-banks.ts`, P0.9 evidence-leg design. Zep-product ruled out (Community Edition deprecated 2025; cloud violates data boundary). |
| **D-3** | **Factory 24/7 agents live as E21 Home bots** (deep integration). QA/maintenance/manager agents = bots-as-profiles in one factory Home (owner = operator). Stories gate on E21 lanes: S02b (in-flight), S03b, S04a/b, S05a/b. Factory CI stays green regardless of E21 slip via spec-seam fixtures (§5). | Deepest honoring of the v3/v4 "Hermes department managers" vision. Approvals channel may move to the E21-S05b inbox — **channel ≠ policy**: `fleet approve` stays scrypt-gated, allowlisted, token-on-stdin, human-only (ADR-1 §3); the channel change is captured in ADR-2 DRAFT, not decided. |
| **D-4** | **Jev tier expanded behind a `JudgmentProvider` adapter seam** (operator: "adapter pattern so future jev-like tier-1 systems swap in"). Typed ask (state + questions → answers + probabilities + usage + provenance); egress classes, ceiling circuit breaker, envelope provenance = neutral-layer policy. `jev` (pinned jev-1.13.0) + existing `mock` = first two registered adapters. Per-adapter contract tests; the jev pinned-model drift alarm stays THE alarm. | Seam half-exists (mock mode already satisfies the shape) — formalize, don't invent. Ten-levels mapping (§2.3): L3 scoring → dispatch prioritization; L4 → arm-thresholds gated on calibration milestones; L5 → model router; L7/L8/L9 host-side pack; L10 ask_jev parked on E21-S16; **L6 in-box tool hooks PARKED** (conflicts LOCKED host-side placement — re-adjudication requires a new D-number, DD-21). |
| **D-5** | **D-register note:** D-4 supersedes-refines the Jev handoff's LOCKED #3 ("no SDK") wording — still no SDK, now behind a named seam. All other Jev LOCKED decisions hold verbatim: host-side placement, recording-only until measured, no severity calibration, thresholds-in-code, stage-2 diff-hunk egress ZDR-gated, ceiling + bill alarm. | `_bmad-output/typesafe-integration/handoff.md` §3 is the authority for anything it doesn't amend. |

---

## 1. Situation

- **v5 CLOSED 2026-10-01:** 42/42 stories / 169/169 pts; PR #399 squash-merged `5feaeec6`; close-out PRs #400 (plans-docs sync) + #401 (audit). `dev` @ `1b51777d`. Operator ruling: **next program = the v6 pivot — factory/OpenRig pieces fired by zeropoint/swarmclaw DAGs via the CLI/adapter, broadening the live ADR-1/SC2 `external_job` narrow form.**
- **Prior integration sketch is stale by its own doc.** `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-17-swarmclaw-kg-integration-HANDOFF.md` (read FIRST — three stacked status layers, newest 2026-10-01) declares its 09-17 Epic S/M skeletons superseded: they predate ADR-1 + the live SC2 substrate. Its ground-truth seams section remains accurate and load-bearing.
- **The v3/v4 vision is recovered and must be honored** (the operator's stated concern). v4 PRD (`_bmad-output/planning-artifacts/prd-qds-factory-v4.md`) is the fullest statement: Hermes Dev/QA/Maintenance 24/7 managers (FR-MG-1), post-merge QA hunter-pack priming the next Dev run (F3), scheduled maintenance sweeps (F4), five nested loops L1–L5 (§9.1), L3 nightly consolidate / L4 weekly reflect→PROPOSE (never auto-apply), 8 proactive cron agents (QDS-MEM-001/002), GitNexus 4–6h refresh (FR-MEM-6), yield-curve KPIs with Goodhart counter-metrics (L5/FR-LEARN-33).
- **Ten gaps vs current plans** — every one gets: a story, or an explicit park with a dated trigger, or an ADR home. None silently dropped.
  1. 24/7 department managers → **A1** (v6b). 2. QA department F3 → **A2**. 3. Maintenance sweeps F4 → **A3**. 4. L3/L4 learning cadences → **M3.1/M3.2**. 5. 7 of 8 proactive agents → **PARKED DD-23** (triggers dated). 6. Yield KPIs L5 → **A5**. 7. GitNexus refresh → **A6** (v6a). 8. Layer-B self-optimization → **J3 + M3.2** (safe subset), rest PARKED DD-23. 9. Telegram/channel intake → stays parked (OQ-3 blocked-on-creds, DD-1). 10. P2 memory epic (13/44, never scheduled) → **FOLD register DD-15**.

## 2. Verified substrate facts (writers must not contradict)

### 2.1 Factory (all live, file-verified)
- **16 fleet verbs** (`src/fleet/verbs.ts:73-431` closed registry = THE contract; DF3.5 skill-contract test compares): `dispatch, status, harvest, teardown, fanout, rank, approve, reject, attach, enrol, unlock, run, observe, submit, result, cancel`. `--driver` required on all except `rank, approve, reject, enrol, unlock, result`. Exit codes 0–6 (6 = work landed, output/cleanup failed — Q11 ruling). **The HANDOFF's "13 verbs" is stale — 16 is current.**
- **DF2.3** `src/providers/credentials.ts`: mintRunKey/revokeRunKey/openRouterKeyApi (micro-USD caps, idempotent-verb-only retries) — the ordering M2's gateway mirrors.
- **DF3.4** `src/fleet/approval-gate.ts` + `approvers.ts` (scrypt `.factory/approvers.json`, token STDIN-only). **DF3.7** `src/fleet/run-completion.ts` observeAndDriveChain (2h window; NO push channel — pull-only via `fleet status`). **DF3.8** `src/fleet/observe.ts` (exiting cron pass, no daemon — INV-IBOX-16). **DF5.3** `src/audit/chain.ts` walkAuditChain + `src/audit/link-store.ts` **frozen AUDIT_HOPS — no new hop ever** (divergent tamper alarm on re-emits). **DF6.1a/b** `src/fixloop/` (30s poll, 15min window, escalation PR comment = the only human-egress today).
- **DF3.6b** `src/phase-engine/resident-bounds.ts`; image pin `scripts/build-exedev-image.ts` (deriveBuildId :638) + `src/providers/exedev/driver.ts:493` + `scripts/adopt-image-pin.ts` (#396–#398 ritual precedent). **CI verify-image-pin currently RED** — two conditions: (a) base-drift fires BY DESIGN (upstream exeuntu weekly rebuild — not an incident); (b) `DEFAULT_IMAGE_REF ee802669…` MANIFEST_UNKNOWN on GHCR = real red → full re-pin ritual (re-pin base → rebuild → re-sweep → publish via publish-exedev-image.yml → adopt) or documented exception. Blocks every T2 round (wave-0 ops).
- **Hindsight host client COMPLETE** `src/hindsight/{client,bank-provisioner,mulch-importer,round-trip-verifier,schemas,index}.ts` — NOT in box image COPY set (Dockerfile:277-305). `scripts/provision-hindsight-banks.ts` exists. Gate `src/gate/assertions/p0-9-memory.ts`.
- **In-repo chassis** `src/swarmclaw/`: utilities (`log`/`newRequestId`/`maskEnv`) are LOAD-BEARING (imported by hindsight, judgment, providers, fleet); server surface (createServer/routes/store) = orphan. Fate = DD-18 + Z5.
- **Jev tier** `src/judgment/` (client/schemas/egress/ceiling/emit/envelope) + corpus (`scripts/corpus/`, `_bmad-output/judgment/corpus/`) + S1 observer (`scripts/judgment/observe-round.ts`, 88% disposition agreement / 108 findings / $0.002, ~220ms) + `scripts/judgment/ab-report.ts`. Live-proven jev-live-r1 (2026-09-22). Handoff §4 vendor facts binding (noul returns NUMBER; 64k/req; input-token billing).
- **State:** `.sandbox/` runs/ 0600 O_EXCL JSON + atomic rename; per-run locks `scripts/lib/run-lock.ts` (NOT re-entrant — RunLockReentrantError); audit.db; cost-ledger.db (integer micro-USD); dispatch-log.jsonl.
- **E2E:** `tests/fleet/e2e/live-harness.ts`; `QDS_E2E_LIVE=1` + `QDS_E2E_TIER` ∈ {1,2} exactly (T3/4/5 = naming over TIER=2); no-fakes hard rule in `*.live.test.ts`; requires `QDS_EXEDEV_REPO_URL, QDS_EXEDEV_SHA, QDS_EXEDEV_ROSTER, OPENROUTER_PROVISIONING_KEY`; evidence scrubbed → `_bmad-output/evidence/`.
- **Ops DEFERRED (operator-gated, zero agent spend):** image re-pin ritual (above), Vultr VPS G1–G9 (`_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md` — x86_64 Ubuntu 24.04, firewall 22/80/443 **never 18889**, hindsight.env, SOLSTICE_TENANT_ID), G5 pairing (operator env: QDS_E2E_FIX_PR, records dir, fix-scope.json), P0.5/P0.9 closure (`_bmad-output/plans/2026-09-30-p0-5-p0-9-closure-plan.md` — five P0.9 evidence legs ride M1.1 on the VPS).

### 2.2 ZeroPoint (zeropoint = product name; two repos + one runtime)
- `/Users/steve/Solstice` = parent (control-plane/docs/infra). **Main checkout STALE (~47 PRs behind origin/dev)** — fresh state in `/Users/steve/Solstice/.worktrees/hermes-agent` (branch feature/e21-s02b-bot-profiles). The APP = swarmclaw fork (`@swarmclawai/swarmclaw`, submodule `Solstice/external/swarmclaw`). `/Users/steve/swarmclaw` = separate fork checkout. Hermes = PyPI `hermes-agent` (MIT) → image `ghcr.io/quantum-digital-solutions/hermes-agent:0.21.5` built by `Solstice/infra/hermes-agent/Dockerfile`.
- **E21 "Hermes Personal Runtime"** (`Solstice/docs/sprint-artifacts/e21/EPIC.md` + `docs/planning/adr-run-2-hermes-personal-runtime.md` D1–D10, B1–B5, INV-1..8): 37 stories / 142 pts. Done: S00, S00b, S01, S03a (LLM gateway), S10a/b/c, S17a, S18. **In-flight: S02a (home lifecycle/caps), S02b (bots as profiles + turn principal)**. Backlog incl. S03b (provider wiring + in-container key removal), S04a/b (bridge relay/server + session auth), S05a/b (allowlist/frame policy + approvals interception/inbox), S06 (chat as Bridge client), S11 (knowledge MCP — 2 read-only tools), S12 (gVisor), S13a/b (credential containment/broker), S16 (capability policy + skill catalog), S17b/c (live E2E + security sign-off). Hermes runs today pre-E21 as sandbox containers per soul (`sandbox-provider.ts`, internal egress net, memory ONLY via sandbox-memory-gateway, approvals intercepted `acp-approval-firewall.ts`, `cron_mode: deny`).
- **`external_job` LIVE** (ADR-1 ACCEPTED, operator-signed 2026-09-30; SC2.6/SC2.7 proven, 11-round evidence `_bmad-output/evidence/openrig-sc2/`): fork `src/types/protocol.ts:148` `ProtocolExternalJobConfig{repoSlug, repoUrl, commitSha(40-hex), manifestPath, issueId XOR workId, groupCapUsd, pollTimeoutMs(default 1h), onFailure}`; submit via `$SWARMCLAW_FACTORY_FLEET_CLI`; parks; daemon poller → `factory_result` verdict + `branch_taken` witness; #383 pre-registers approval gate BEFORE teardown. **Grammar boundary:** swarmclaw never learns QDS's driver grammar; `--driver exedev` lives only in the deployed wrapper.
- **Schedules:** platform heartbeats/schedules + `schedule_wake` session tool (durable wake events, enqueueSystemEvent).
- **KG stack (fork paths):** Hindsight **0.10.0** pinned (`config/hindsight-version.txt`, CI rejects :latest) — factory re-pins 0.8.6 → 0.10.0 (D-2). Internal `http://hindsight:8888`, host 127.0.0.1:18889, own Postgres volumes. Native MCP `POST :18889/mcp` (28 tools) + REST `/v1/default/banks…`. Banks: `solstice-soul-*`, `solstice-meta`, `solstice-agent-*`, `solstice-l2-<tenant>`, `solstice-l3-*`. `<kg_context>` injection: `reactive/reactive-grounding-extension.ts` beforePromptBuild → `hindsight-context-adapter.ts` (fan-out recall, tiered stage-1, Presidio redaction-or-fail-closed, citation floor) — **COPY the pattern for M1.2; skip its Clerk gate + Presidio; keep the directive/citation grammar (EMPTY_KG_DIRECTIVE etc.)**.
- **SKIP for factory:** presidio sidecar + pseudonym (E19) + write-lane JVB verdicts; Clerk auth (`kg-tenant-auth.ts`); per-soul/L2/L3 bank tiering; dream/L3 cascade; E21 Home/Bridge/browser-UI apparatus (orthogonal to fleet); E21-S11 knowledge MCP (don't wait on it).
- **Deploy template:** `/Users/steve/Solstice/.claude/worktrees/vultr-deploy` @ `d0c513fa` `deploy/control-plane/{Caddyfile,docker-compose.yml,backup.sh}` — intended TEMPLATE for the integrated stack once it lands (do not treat QDS runbook and template as independent deployables).

### 2.3 Ten-levels-of-Jev mapping (github.com/disler/ten-levels-of-jev, MIT)
L1/L2 done (triage seam). L3 composite scoring (weights in code) → dispatch prioritization + pre-dispatch risk tier (J3). L4 confidence gating → arm-thresholds unlock, gated on calibration milestones + operator sign-off (J2). L5 intent/model routing → v4 FR-LEARN-30 successor: cheap Jev call picks model tier per story-shape (J3). L6 tool-call guardrail hooks → IN-BOX, conflicts LOCKED host-side placement → **PARKED DD-21**. L7 should-I-compact → HOST-side: resident orchestrator asks per observe tick, signals via the DF1.11 steering seam (`/run/steering` tmpfs) (J4). L8 cheap reads / L9 files-at-scale → QA hunter-pack pre-filter, pre-dispatch manifest sanity, repo-sweep triage (J4; L9 = first flex-cut). L10 agentic ask_jev → E21 Home bots via S16 skill catalog (zeropoint-side) → **PARKED J5**, gate = E21-S16.

## 3. Target architecture

### Epic table

| Epic | Pts | Scope |
|---|---|---|
| **Z** — Zeropoint macro-host | 16 | adapter contract v2 (`factory_observe` read-only step kind), `SWARMCLAW_FORK_REV` pinning harness + drift alarm, fork-side triggers + notify, VPS deploy profile, chassis fate, cross-repo live exit round. **Renamed from sketch "S" — S-IDs collide with E21-Sxx namespaces (DD-14).** |
| **M** — Memory ladder | 26 | M1: dedicated Hindsight + `qds-` banks + recall-primed dispatch + measurement harness. M2: authz gateway + in-box `kg_recall` + combined live round. M3: manager meta banks + L3 nightly consolidate + L4 weekly reflect→PROPOSE. Sketch-M3 (in-box write-back) **PARKED** — F10/INV-7 (box prose never trusted at boundary); sanitized write-back via review harvester is the later shape. |
| **A** — Autonomy (E21-gated) | 16 | department managers as Home bots, QA department F3, maintenance sweeps F4, yield KPIs L5 + Goodhart pairs |
| **J** — Judgment tier | 16 | J1 adapter seam (v6a); J2 arm-thresholds (measured + signed); J3 model router; J4 host-side pack; J5 ask_jev parked on E21-S16 |
| **G** — Governance | 2 | ADR-2 DRAFT + Tier C vs ADR-1 reconciliation note |

### v6a — Foundation (THE next sprint, 11 / 36, starts immediately, zero E21 gates)

| ID | Title | Pts | Deps | Live tier |
|---|---|---|---|---|
| Z1 | Adapter contract v2: `factory_observe` read-only surface (read-only `fleet status`/`result`, no box, no key) + `SWARMCLAW_FORK_REV` pinning harness + drift alarm + q1-contract extension to the observe consumption surface | 3 | — | none |
| Z2 | BUILD-IN-FORK: `factory_observe` step kind + post-merge and schedule→protocol trigger wiring + notify leg. Every new step-config field gets a `normalizeStep` carry + round-trip test (config-drop trap class) | 5 | Z1 | fake-CLI journal |
| Z4 | Factory VPS deploy profile: compose (dedicated Hindsight 0.10.0 + M2 gateway + fleet CLI) extending the vultr-deploy/Caddy-allowlist template; deployed wrapper owns `--driver exedev` | 3 | ops VPS G1–G7 | infra |
| Z5 | Chassis fate: extract `log`/`newRequestId`/`maskEnv` to `src/lib/`; disposition dormant server surface per DD-18 | 2 | — | none |
| M1.1 | Dedicated Hindsight 0.10.0 on VPS (re-pin), `qds-` bank provisioning, round-trip verify (`src/hindsight/round-trip-verifier.ts`), no-auth danger retired-check. P0.5/P0.9 closure evidence rides this story's legs | 3 | Z4 | infra |
| M1.2 | Host-side memory cycle: dispatch-time bounded recall → `<kg_context>` brief appendix (proceed-unprimed-on-timeout — bad KG degrades to v5 behavior) + harvest-time idempotent retain (P2.8 fold: stable dated `documentId`, `updateMode:"replace"`) | 5 | M1.1 (mock-first dev before VPS) | **T2** |
| M1.3 | Recall measurement harness: labeled probe set, hit-rate@k, priming-usefulness instrumentation, interim report; Graphiti checkpoint bar set at DD-22, decision gated on ~30 M1 cycles | 3 | M1.2 | none |
| M2.1 | Memory gateway: per-run **recall-only** scoped keys (mint→deliver→revoke-and-verify-before-destroy, mirroring `credentials.ts` ordering; runId + bank-allowlist + TTL bound) + long-lived agent tokens (bank/verb-scoped) + D8 amendment implementation | 5 | M1.1 | unit/mock |
| J1 | `JudgmentProvider` interface extraction + `jev`/`mock` registered adapters + neutral-layer policy (egress classes, ceiling, envelope) + per-adapter contract tests; jev drift alarm stays THE alarm | 3 | — | mock + Jev-live probe |
| A6 | GitNexus 4–6h graph-refresh cron on VPS + staleness alarm (FR-MEM-6) | 2 | Z4 | infra |
| G1 | ADR-2 DRAFT (auto-merge default + QA-owned verdicts consuming `fleet result` payload; S05b inbox = human override surface; PROPOSED, operator decides) + Tier C vs ADR-1 reconciliation note | 2 | — | none |

**Wave 1 (start now, no gates):** Z1 ∥ J1 ∥ G1 ∥ M2.1. **Wave 2:** M1.1, M1.2 (mock-first), Z5, A6. **Wave 3:** M1.3, Z2 (fork repo, fake-CLI keeps factory green), Z4 if VPS landed late.
**Critical path:** ops-VPS → M1.1 → M1.2 (T2) → M1.3 cycles (continue into v6b; Graphiti checkpoint is DATED, not sprint-bound).
**Exit evidence:** primed live dispatch T2 green + gateway round-trip on VPS + CI green at re-pinned image + M1.3 interim report.

### v6b — Autonomy (12 / 45, E21-gated)

| ID | Title | Pts | Deps |
|---|---|---|---|
| A1 | Department managers as E21 Home bots (one factory Home, owner=operator) + heartbeat digest duty (absorbs fix-loop-runner: scheduled observe poll → chat digest + escalation) + per-bot spend ceiling; spend join per DD-20 | 5 | **E21 S02b, S03b**, Z2 |
| A2 | QA department F3: post-merge trigger → hunter-pack protocol → `external_job` QA run (`w:qa-*` work keys) → findings → shared `qds-` bank retain (primes next Dev run) + issue filing | 5 | A1, M1.2, Z2 |
| A3 | Maintenance sweeps F4: weekly manager wake → sweep protocol → dep-bump/refactor briefs (hotspots from A6 GitNexus + audit chain) → fleet run → parks at approve gate | 3 | A1, A6, Z2 |
| A5 | Yield KPIs L5 + Goodhart counter-metrics: TDI-proxy / cost-per-story / first-pass-accept / retry from `.sandbox` SQLite + both spend ledgers; snapshot persistence (visualizer render optional AC) | 3 | M1.2 |
| M2.2 | In-box `kg_recall` pi extension + roster grant + **full image re-pin ritual** (new box files move deriveBuildId); recall-only, sanitized output, char budget, F10-treated | 5 | M2.1 |
| M2.3 | Combined memory live round: primed dispatch + in-box recall during real run + revoke-verify at teardown; evidence scrubbed | 2 | M2.2, M1.2 |
| M3.1 | Manager `*-meta` banks + L3 nightly consolidate + mental-model refresh (platform schedule → manager bot via agent token; documented crontab fallback if E21 slips — gateway is driver-agnostic) | 3 | M2.1, A1 |
| M3.2 | L4 weekly reflect → PROPOSE router/skill tuning (FR-LEARN-30 shape: proposals to meta bank + posted to operator; NEVER auto-apply) | 3 | M3.1, A5 |
| Z3 | Cross-repo live exit round (the v6 SC2.7 analog): scheduled protocol drives real fleet run end-to-end — observe legs, findings→bank→next-run priming round-trip, approval park + human decide, exactly-one-box invariants | 3 | A2, Z2, M2.1 |
| J2 | Measured arm-thresholds / confidence gating: S1 observer routing ARMED, gated on calibration milestones (outcome-confirmed record count, agreement CI) + explicit operator sign-off AC | 3 | J1 + corpus milestones |
| J3 | Model-router decision layer: L3 composite scoring (weights in code, no calibration needed) picks model tier per story-shape at dispatch; decision log feeds M3.2 | 5 | J1, M1.2 |
| J4 | Host-side judgment pack: L7 compact-signal (resident compaction decided host-side per observe tick, signal via DF1.11 steering seam) + L8 QA pre-filter + pre-dispatch sanity + L9 repo-sweep triage (**L9 = first flex-cut**) | 5 | J1 |

**Critical path:** E21 S02b (in-flight) → S03b → A1 → A2 → Z3. Second path: M2.1 → M2.2 → M2.3. **Named flex-cuts if v6b strains:** J4-L9 leg, then J3 → v7 (decided now, not mid-sprint).
**Parked:** J5 (E21 `ask_jev` via S16 skill catalog) — gate E21-S16; re-enter at v6b→v7 derivation.

## 4. Derivation-session agenda (what the new session writes)

All outputs enter as **DD-14+** in a NEW register `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` (follow the DD-1…DD-13 register's format), one PR:

1. **DD-14** Namespace + split ratification: epics Z/M/A/J/G; S→Z rename rationale; v6a/v6b cut line + standalone-value statement; story file paths `_bmad-output/sprint-artifacts/dark-factory-v6/stories/`.
2. **DD-15** P2 fold/supersede register (13 stories / ~44 pts, `_bmad-output/sprint-artifacts/phase-2/README.md`, never scheduled; entry gates cite retired v4 premises): FOLD P2.4 (protocol/DAG-node events into run tree) → Z2 observe artifacts + A5 KPI join; FOLD P2.8 (idempotent retain: dated documentId + replace) → M1.2; SUPERSEDE P2.0–P2.3, P2.5–P2.7, P2.12 by named successors (.sandbox SQLite trace store DF1.4, audit chain DF5.3, run records, M3.1); PARK P2.9–P2.11 (A/B + confirm machinery) with Layer-B, DD-23.
3. **DD-16** D8 amendment text (architecture D8, `2026-08-11-dark-factory-v5-architecture-design.md` ~:298-305): per-box credential set = (1) one provider secret (unchanged) + (2) one per-run **recall-only** memory key — gateway-issued, runId + bank-allowlist + TTL bound, revoked-and-verified before destroy mirroring `credentials.ts` ordering; no WRITE credential ever enters a box (F10/INV-7 — writes are host-side from harvested evidence); egress scoped to the gateway origin.
4. **DD-17** DD-5 fix, superseded-form: stdio premise dies; dedicated instance's bank-scoped REST (`src/hindsight/client.ts`) + M2 gateway replace the local-MCP surface entirely.
5. **DD-18** Chassis fate: extract utilities (Z5); retire or fixture the server surface pending ADR-2's query-surface need.
6. **DD-19** Tier C vs ADR-1 reconciliation note: v6 adopts macro hosting, schedules, bot residency, approval/notification surfaces (partial Tier B via `factory_result` artifacts + chat digests); **D6 stays unreversed** (in-box engine, host authority, fleet front door); full Tier C drift remains out.
7. **DD-20** Bot-spend source of truth: zeropoint LLM-gateway ledger (E08 budgets) for Home-bot turns; factory cost-ledger for fleet runs; join keys = workKey (`w:` namespace) + runId + botId; A5 consumes both.
8. **DD-21** Jev register: L6 PARKED (host-side-placement conflict; re-adjudication = new D-number + evidence of need); LOCKED #3 superseded-refined (adapter seam, still no SDK); J2 unlock milestones written into its gate.
9. **DD-22** Graphiti successor bar: define hit-rate@k target + labeled probe set NOW; decision checkpoint after ~30 M1 cycles.
10. **DD-23/24** Parks with dated triggers: Synthesizer/Meta-Optimizer/BlindSpot (+ factory-tier four) — after ≥30 cycles + 4 weeks of outcome records; Telegram/OQ-3 unchanged (DD-1 v5 register).
11. **G1 handoff:** ADR-2 draft scope per Z-table row.
12. **PR #400/#401 backfill** rides the same PR: record v5 close + 2026-10-01 ruling + the two-sprint v6 shape in README/sprint-status/research docs (no repo doc currently mentions #400/#401).
13. **Ops dependency register:** re-pin ritual (blocks ALL T2), VPS G1–G9 + M-ladder deploy, G5 pairing, P0.5/P0.9 closure, GHCR publish ownership (E01-S06/G9).

## 5. Cross-repo dependency management (seed — formalize in `docs/planning/v6-crossrepo-contract.md`)

1. **Contract-as-code:** every verb-shape the fork adapter consumes stays pinned by the Q1 contract discipline (exact field-set pins, missing AND extra fields fail by name, literal SCHEMA_VERSION, closed status enums, exit-code table). Z1 extends it to the observe consumption surface. The contract is the only code-level coupling; moves only via deliberate version bump.
2. **E21 spec-seam fixtures:** map each E21 gate → its testable seam AS WRITTEN in the E21 spec. Known seams: S02b `TURN_REFUSALS` vocabulary + `isHomeBackedAgent`; S03b the four `SOLSTICE_*_TOKEN` names + `writeProfileTokens`; S05b approvals interception + inbox. Factory stories code against fakes honoring those seams (extend the SC2 fake-CLI-journal pattern to a fake Home-bot/gateway journal) — factory CI green before/during/after E21 lands.
3. **Pinned fork revs:** `SWARMCLAW_FORK_REV` constant + drift-alarm test in factory; advanced only by deliberate bump PR (mirrors image-pin adoption). Z2's fork PRs merge on fork dev; factory pin bumps only at evidence rounds.
4. **CI greenness invariant:** zeropoint code never enters the factory import graph. Coupling only at (a) CLI JSON contract, (b) pinned-rev fixtures, (c) live evidence files.
5. **Counterpart stories, one contract text:** zeropoint-side work beyond E21's slate (observe step, triggers, factory bot profiles) filed in the solstice repo from the same derivation, classified BUILD-IN-FORK per E21 vocabulary. Factory points cover factory-repo work + joint rounds only.
6. **Live rounds are the only real-behavior assertions** (Z3, A2, A3, M2.3, M1.2): no-fakes rule, worst-case spend printed, operator GO, keys/boxes cleaned in `finally`, evidence scrubbed.

## 6. Guardrails (binding on every story)

- Fleet = only code-entry path; `fleet approve` scrypt/stdin/human-only (ADR-1). No Jev answer, no bot, no schedule gates code entry.
- INV-IBOX / F10 / INV-7: box prose never trusted at boundary; no write credential in-box ever; `kg_recall` recall-only + sanitized + char-budgeted.
- Gateway authz: bank-scoped, recall-only in-box keys, revoke-verify-before-destroy, never public 8888/18889, Caddy allowlist from the vultr template.
- Jev: host-side placement, recording-only until measured, stage-2 egress ZDR-gated, pinned model, ceiling + bill alarm. Jev handoff §8 guardrails verbatim.
- Never edit: `AUDIT_HOPS` (`src/audit/link-store.ts`), gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope`, provider layer import rules (R3 §9.2).
- `src/providers/` imports no tier-3 workspace code; new modules sit per the existing layer graph (GitNexus `impact()` before editing any symbol; `detect_changes()` before any commit — repo CLAUDE.md).
- Ops stays operator-gated: zero agent spend on re-pin / VPS / G5 until explicit GO.

## 7. Risks (top 8 — full register rides the derivation doc)

1. **E21 lane slip** (S02b in-flight → S03b backlog) → v6a unaffected; seam fixtures; M3.1 crontab fallback; Z3 late-bound; E21 tracker reviewed at every v6a gate.
2. **Gateway security** (authz surface over a store that answered 200 with no auth at 0.8.6) → recall-only keys, scoped tokens, revoke-verify, Caddy allowlist, no public 8888/18889, M2.3 adversarial live round, digest-stable audit rows.
3. **Recall quality post-re-pin** (0.8.6→0.10.0) → probe set defined BEFORE deep dependency; proceed-unprimed degrades to v5 behavior; Graphiti bar pre-agreed (DD-22).
4. **Approval-channel creep** → ADR-2 stays DRAFT; scripted approvers labeled (SC2.7 precedent); Z3 asserts park + human decide.
5. **VPS/re-pin ops timing** → wave-1 needs neither; Z4 profile pre-built to fire; P0.5/P0.9 ride M1.1; scheduled "VPS day".
6. **Sprint bloat** (81 pts honest) → physical cut line; named flex-cuts; +15% review contingency; parks carry dated triggers.
7. **Cross-repo drift** → fork-rev pin + drift alarm; `normalizeStep` carry ACs; SCHEMA_VERSION bump discipline; one contract text both sides.
8. **Jev Goodhart** (arming on ~3 positives) → J2 gated on milestones + operator sign-off; outcome-confirmed corpus fields; L6 parked; stage-2 ZDR-gated; ceiling + bill alarm unchanged.

## 9. Process for the new session (follow exactly)

1. Invoke `/qds-sprint-planning` pointed at THIS file. Branch `feature/v6-derivation` exists (created 2026-10-01, may be behind dev — rebase or re-branch per convention: prefix=feature/, base=dev, target=dev).
2. Read the formats before writing: v5 DD register (format precedent), `_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md` (index style — NO slate arithmetic in the index; sprint-status.yaml is the numbers authority), one recent v5 story file (story-file style: Spec Reference / User Story / Overview / E2E Slice / ACs with negative controls / Trigger Surface / Files to Modify / DOD; atomicity gate: normative ≤200 lines, ≤8 SP, DOD ≤10 high-signal).
3. Write the DD-14+ register → epic/story specs (11 v6a full + 12 v6b marked gated) → crossrepo contract doc → ADR-2 PROPOSED → PR backfill → sprint-status v6 section (rows must reconcile: per-epic sums = per-sprint sums = total; story-consistency test).
4. Run `qds-story-review` multi-wave adversarial campaign on all specs (wave-7–10 pattern; tracker in `_bmad-output/sprint-artifacts/dark-factory-v6/`); fix or record dismissal per triage discipline. Expect +10–15% pt growth (DD-13 precedent) — both sprints hold headroom.
5. Sprint slicing: waves, two dev lanes, E2E tier budgets, live-round cost estimates for operator GO gates.
6. PR discipline: docs PR → dev. `bun test tests/scripts/story-consistency.test.ts` green before any PR. GitNexus `detect_changes()` (docs-only expected: 0 affected symbols).
7. Operator gates AFTER derivation: v6a slate sign-off + E2E spend budget + wave-0 ops scheduling (re-pin / VPS / G5) before any dev lane starts.

## 8. Sources (read on demand — do not re-derive)

| Topic | Path |
|---|---|
| Prior integration thinking (3 status layers) | `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-17-swarmclaw-kg-integration-HANDOFF.md` |
| ADR-1 (ACCEPTED) | `docs/decisions/2026-09-30-adr-1-swarmclaw-macro-host.md` |
| v5 DD register (format + DD-1..DD-13) | `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` |
| v5 architecture (D1–D8, D6, D8) | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` |
| Autonomy re-entry rule | `docs/superpowers/specs/2026-08-14-df-v5-autonomy-horizon-review.md` |
| OpenRig program record | `docs/planning/2026-09-24-openrig-integration-roadmap.md` + `2026-09-23-openrig-swarm-integration-research.md` |
| SC2 live evidence | `_bmad-output/evidence/openrig-sc2/` |
| P0.5/P0.9 closure plan | `_bmad-output/plans/2026-09-30-p0-5-p0-9-closure-plan.md` |
| VPS runbook (G1–G9) | `_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md` |
| Jev handoff (LOCKED decisions + vendor facts) | `_bmad-output/typesafe-integration/handoff.md` |
| v3/v4 vision | `_bmad-output/planning-artifacts/prd-qds-factory-v4.md` (§9.1 five loops, FR-MG-1/10, FR-LEARN-30) + `architecture-v3.md` + `handoff-self-learning-optimization.md` |
| Proactive agents designs | `docs/planning/hindsight-memory-master-design.md` (QDS-MEM-001) + `hindsight-factory-tier-design.md` (QDS-MEM-002) |
| P2 epic (fold target) | `_bmad-output/sprint-artifacts/phase-2/README.md` |
| E21 epic + ADR | `Solstice/docs/sprint-artifacts/e21/EPIC.md` + `Solstice/docs/planning/adr-run-2-hermes-personal-runtime.md` (worktree `.worktrees/hermes-agent` = fresh) |
| Deploy template | `/Users/steve/Solstice/.claude/worktrees/vultr-deploy` @ d0c513fa |
| 4-week plan (terminology trap ⚠) | `docs/planning/qds-factory-4-week-execution-and-spike-plan.md` — "Hermes" = department managers; proactive cron agents are a different population |

---

## Appendix — HANDOFF PROMPT (paste into the new session)

> **Operator:** paste the block below as the FIRST message of the fresh session. Nothing else needed.

```
/qds-sprint-planning

Derive the Dark Factory v6 sprint (v6a Foundation + v6b Autonomy) from the program charter at:

_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md

Read that file IN FULL before anything else — it is the source of truth. It carries:
- 5 operator decisions LOCKED 2026-10-01 (two-sprint split; dedicated Hindsight 0.10.0 behind an
  authz gateway; 24/7 agents as E21 Home bots; JudgmentProvider adapter seam; Jev LOCKED#3
  superseded-refined) — settled, do not re-litigate; contradicting facts → surface to me first.
- Verified substrate facts (factory 16-verb registry, zeropoint/E21 map with in-flight lanes,
  KG stack, reuse-vs-skip) with source paths — writers must not contradict them.
- The full v6a/v6b story tables (11/36 + 12/45) with deps, live-tier needs, and named flex-cuts.
- The DD-14+ derivation agenda, cross-repo contract seed, guardrails, risk register, and the
  exact process to follow (formats to read first, campaign, PR discipline, operator gates).

Non-negotiables: fleet stays the only code-entry path; `fleet approve` scrypt human-only (ADR-1);
no write credential ever in-box; AUDIT_HOPS frozen; ops items stay operator-gated (zero agent
spend — image re-pin, VPS G1–G9, G5 pairing all need my explicit GO); new decisions enter ONLY as
DD-14+ in the new register, never as quiet scope growth.

Deliverables this session: DD-14+ register doc, epics-and-stories index (no slate arithmetic in
it — sprint-status.yaml is the numbers authority), 11 v6a story specs + 12 v6b gated specs in
_bmad-output/sprint-artifacts/dark-factory-v6/stories/, cross-repo contract doc, ADR-2 PROPOSED
draft, PR #400/#401 backfill note, sprint-status v6 section (reconciled; story-consistency test
green), then the qds-story-review campaign. Docs PR to dev at the end. Do not start story
IMPLEMENTATION — that is later sessions via qds-dev.
```
