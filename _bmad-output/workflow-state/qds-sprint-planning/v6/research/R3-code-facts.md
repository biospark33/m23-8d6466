# R3 — Factory code substrate facts (v6 derivation research)

Agent: Research Agent 3 (factory code substrate). Read-only session, 2026-10-01.
Every claim cites SYMBOL + path; line numbers verified this session on branch `feature/v6-derivation`.
Charter: `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md`.

---

## 1. Fleet verb registry — `src/fleet/verbs.ts`

**16 closed verbs, confirmed, in registry order** (`listVerbs()`, `src/fleet/verbs.ts:87-663`):
`dispatch, status, harvest, teardown, fanout, rank, approve, reject, attach, enrol, unlock, run, observe, submit, result, cancel`.

**`--driver` required on 10; absent (not merely optional) on 6:**
- WITH `--driver` (required: true): dispatch (:93), status (:134), harvest (:156), teardown (:173), fanout (:186), attach (:318), run (:465), observe (:520), submit (:576), cancel (:648).
- NO `--driver` at all: rank (:225-237 — reads fanout records + step output only), approve (:274), reject (:308), enrol (:411), unlock (:441), result (:616 — poller-safe: no box probes).
- Rationale is registry docblock + per-entry comments: `assertDriverChosen` in `scripts/fleet.ts` refuses without `--driver` as exit 2 (no verb may default the fake driver); the 6 exceptions touch no box so requiring a dead flag "trains operators to paste magic values".

**Exit-code semantics (0–6)** — per-entry `exitCodes` arrays + Q11 ruling (`docs/decisions/2026-08-tech-debt-answers.md § Q11`, cited in verbs.ts:124-128):
- 0 = success (result: also covers a RUNNING run — poller keys on payload `terminal` field, verbs.ts:633-637).
- 1 = transient/retryable; on verbs reaching a live box it is the dangerous code (retryable teardown/dispatch can destroy/spend twice) — `run` is the documented exception (idempotent systemd unit start, verbs.ts:487-504).
- 2 = usage/schema (`FleetError` exit codes stay 1..5; 2 includes unknown verb/flag, missing required flag, empty `--approver`).
- 3 = dispatch-only setup gate refusal on a live box (dispatch :128, submit :609).
- 4 = no such run record.
- 5 = refused before anything mutated (run lock refusal, corrupt record, allowlist guard, fleet-busy/no-headroom).
- **6 = "billable work landed; the CLI's own OUTPUT or CLEANUP failed after it"** — one definition, Q11 ruling, verbs.ts:115-128. Not retryable. `FleetError.exitCode` stays 1..5; 6 is CLI-only.

**Skill-contract test:** `tests/fleet/skill-contract.test.ts` (story DF3.5). Compares the four Tier-1 skills under `.claude/skills/factory/` (`factory-dispatch`, `factory-guide`, `factory-harvest`, `factory-observe`, EXPECTED_SKILLS :61) against `listVerbs()`: every fenced `fleet`/`bun scripts/fleet.ts` invocation resolves verb AND flags against the registry (:534-550), missing required flags fail (:574-579), plus prohibited-command scan (ssh/curl/git-push/key-mint/revoke/vm-destroy, :340-347), fixed commercial lint patterns a–f (:367-374), token-shape heuristic (:450), and a mandatory DoD e2e chaining dispatch→status runId through the fake driver (:1081-1159). **Every wave appends entries and edits no predecessor** — the property keeping the generated skill contract stable (verbs.ts:82-84, 469-470).

---

## 2. DF2.3 credentials — `src/providers/credentials.ts` (1949 lines)

**Symbols:**
- `mintRunKey(deps, runId)` :553 — mints one capped key; refuses `capMicroUsd` above `defaultKeyCapMicroUsd` with `cap-invalid` BEFORE `keyApi.createKey` (INV-CAP-1, :55-58).
- `revokeRunKey(deps, runId)` :978 — returns `"revoked" | "already-gone" | "none"`.
- `verifyRevoked` — fail-closed list walk, `MAX_VERIFY_PAGES = 20` (:108).
- `openRouterKeyApi(opts)` :1745 — production KeyApi; requires env `OPENROUTER_PROVISIONING_KEY` by NAME (`provisioningKeyEnv`, default that name; :1747-1755); key is host-only (INV-CRED-2), never leaves the closure's fetch headers.

**Micro-USD caps (integer µ$ everywhere, DD-9):**
- `defaultKeyCapMicroUsd = 50_000_000` (:88) — the provider-side BACKSTOP ceiling on what mint may request. Enforced at mint; "raising the ceiling is a code change plus a test that names it" (:55-58).
- `usdToMicros` :126-135 — finite-guarded conversion (throws `invalid-provider-usage` on non-numeric provider figures). Ordering invariant (:69-75): `residentSpendCeilingMicros (8_000, engine-enforced) <= capMicroUsd (mint-time, per run) <= defaultKeyCapMicroUsd (provider ceiling)`.
- Delivery contract: `KEY_ENV_FILE = "app/.env"`, `KEY_ENV_VAR = "OPENROUTER_API_KEY"` (:100-101), HOME-relative (F3). `SBX_KEY_PREFIX = "sbx-"` (:91) — distinguishes managed keys from operator's own (reaper load-bearing).

**Idempotent-verb-only retry rule** (`openRouterKeyApi.http()`, :1761-1793): transport errors retry ≤2 (`MAX_TRANSPORT_RETRIES`, :105) with 100ms stepped backoff — **for non-POST methods only; `POST /keys` (the mint) is deliberately exempt (attempts = 1)** because a timed-out mint may have SUCCEEDED server-side and a retry would strand a second live key (:1762-1766, implemented :1770). A 4xx is a response, never a transport error, and is never retried.

**The ordering M2.1's gateway must mirror** — `runCredentialLifecycle(deps, runId)` :1622-1727, docblock :1617-1621:
1. Record exists and carries `vmName` (record → VM → key; refuses mint with no box, :1624-1630).
2. `assertEnvFileSafe` BEFORE mint (bad config fails while no key exists, :1631-1633).
3. `mintRunKey` (:1634).
4. `deliverRunKey` in try (:1636); on delivery failure (except the `DELIVER_AUDIT_LINK_FAILED` discrimination, :1651): best-effort `revokeAndVerify(deps, minted.hash)` compensation + its `revoke`/`verify-revoked` audit links, THEN rethrow the original delivery error (:1637-1723). "A minted key must never outlive a failed delivery."
5. `captureSpend` (:1724) → `revokeRunKey` (:1725) → `verifyRevoked` (:1726).
Charter's shorthand "mint→deliver→revoke-verify" matches; the precise chain is mint → deliver → capture-spend → revoke → verify, with revoke-verify compensation bracketing the unhappy delivery path. Teardown-path audit emits (`revoke`, `verify-revoked`) are BEST-EFFORT — an audit-store refusal never strands a billing box (:303-353).

---

## 3. DF3.4 / DF3.7 / DF3.8 / DF5.3 / DF6.1a-b

**DF3.4 approval gate.**
- `src/fleet/approvers.ts` (1263 lines): `DEFAULT_APPROVERS_FILE = ".factory/approvers.json"` (:47); allowlist file must be mode 0600, else every decision refused (:4, :435-439); **token STDIN ONLY, never argv/env** ("would show in `ps`", DF2.3 INV-CRED-3, :33; remediation text at :564 "pipe the correct token on stdin"); `TOKEN_STDIN_TIMEOUT_MS = 10_000` (:76); `SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1 }` (:221), scrypt hash form `scrypt(token, salt, params)` hex, per-entry cost params stored beside the hash (:89-120); `SCRYPT_ALLOC_CEILING_BYTES = 1 << 30` (:126); `mintApproverToken()` :267 (token shown once, allowlist keeps only the scrypt hash); atomic 0600-from-birth write via `openSync(…, "wx", 0o600)` temp + rename (:912); `authenticateApprover` :439 — existence checks deferred past authentication (enumerate-run-ids oracle closed, round 9); `MAX_TOKEN_BYTES = 4096` (:67).
- `src/fleet/approval-gate.ts` (2610 lines): approval timeout `DEFAULT_TIMEOUT_MS = 24h` (:852), min 60s (:853), max 365d (:862); `TIMEOUT_APPROVER_ID = "system:timeout"` (:876); `reclaimApprovalLock(dir, runId, force)` :710 (the `fleet unlock` machinery — no token check by ruling: anyone with runs-dir access can already rm the file, verbs.ts:441-446); `OBSERVE_CHAIN_ORIGIN = "observe-chain"` (:932); `MAX_PROPOSAL_CHARS = 8_000`, `MAX_REASON_CHARS = 1_000` (:886-887); `expiredState(ext, now)` :1025; `CorruptApprovalRecordError` :1130. ADR-1's channel-≠-policy line is real: gate policy (scrypt/stdin/human) lives in these two modules independent of any notification channel.

**DF3.7 run completion — `src/fleet/run-completion.ts` (714 lines).**
- `DEFAULT_OBSERVATION_WINDOW_MS = 7_200_000` (2h) :63; `observeAndDriveChain(runId, deps)` :392; window configurable via `deps.windowMs` (:471).
- Drives the harvest→teardown→reverify→gate chain; **NO push channel — pull-only** via the observe verb's marker polls (charter fact re-confirmed: the module exports the poller; `fleet status`/`result` are the poll surfaces).
- Observe exit table (verbs.ts:547-568): 1 = TRANSIENT both arms (run-completion-unobserved, box-unreachable — re-invoke and the poll restarts); 5 = the module's refusals (run-engine-dead, run-already-closed, approval-already-registered, record-names-no-box, record-not-pausing); 6 = chain landed but post-chain step failed (vetoed re-verify, approval-failed, chain-failed, gate outcome handed off).

**DF3.8 observe sweep — `src/fleet/observe.ts` (775 lines).**
- `SWEEP_INTERVAL_MINUTES = 30` (:107) — derived as reaper `staleAfterMs` (240 min) / 8; a module-level assertion requires it be an integer divisor of 60 in 1..59 so the cron `*/N` template stays even (:116-124). The `--all` flag's help note carries the literal cron line (`*/30 * * * * … bun scripts/fleet.ts observe --all --driver exedev`, verbs.ts:532).
- Exiting cron pass, no daemon, no PID file (INV-IBOX-16): `observeSweep(deps)` :307; `SWEEP_WALL_CLOCK_BUDGET_MS = 1_200_000` (20 min, :97); `MAX_CANDIDATES_PER_PASS = 25` (:89); `PROVISION_LAG_MARGIN_MS = 300_000` (:79). Every per-run refusal is a counted skip inside a pass that still exits 0 (verbs.ts:527).

**DF5.3 audit chain.**
- `src/audit/link-store.ts` (1026 lines): **`AUDIT_HOPS` frozen 10-hop list** :52-63 — `pr-run, run-issue, run-cost, run-credential, run-box, run-bundle, run-reverify, run-approval, run-gate-evidence, memory-retain-receipt`. Per-hop event vocabulary `HOP_EVENT_VOCABULARY` :77-88 (fail-loud at write time `audit-link-invalid`): `run-credential` = [mint, deliver, revoke, verify-revoked]; `run-box` = [create, fill, setup-gate, teardown, reap]; `run-bundle` = [bundle-verify, bundle-fetch]; `pr-run`/`run-reverify`/`run-approval` = [walk-observed] only; `run-issue`, `run-cost`, `run-gate-evidence`, **`memory-retain-receipt` have EMPTY vocabularies — nothing in the tree writes them, by design (INV-AUDIT-4)**. Note for M1.2: the empty `memory-retain-receipt` hop already exists as a reserved slot.
- Storage: `DEFAULT_AUDIT_DB_FILE = ".sandbox/audit.db"` (:175); `openAuditStore` :612 (writer, resolves `QDS_AUDIT_DB ?? .sandbox/audit.db` relative to CWD); `openAuditStoreForWalk` :832 (reader+appender ONE handle, inode-verified, never re-creates — asserts schema and fails closed `audit-store-schema-absent`, INV-AUDIT-6, :30-35). `canonicalJson` :187, `sha256Hex` :216; divergent-digest re-emit collisions are the tamper alarm (see credentials.ts:1660-1667 for the compensations-must-not-carry-path-markers precedent). Hop narrowed against `AUDIT_HOPS` at read time; a malformed row throws `corruptRow` (:906-907). detail_json ≤ 8 KiB (:94); `SUBJECT_NONE_KEY = "<none>"` coalesce sentinel (:97).
- `src/audit/chain.ts` (1935 lines): `walkAuditChain(ref, opts)` :726 — the chain walker; `chainVerdict(report)` :560 ({complete, brokenHops}); `DEFAULT_HOP_CEILING_MS = 3_000` (:167); fix-run sub-walk at :1907.

**DF6.1a/b fix loop — `src/fixloop/`.**
- `ci-status.ts`: **`CI_POLL_INTERVAL_MS = 30_000`** (:31), **`CI_POLL_WINDOW_MS = 15 * 60_000`** (15 min, :33); `pollRequiredChecks`/`probeRequiredChecks`, `GhRunner` seam, `parseChecksJson`.
- `escalation.ts` (379 lines): **the escalation PR comment is this half's only egress to the public internet** (:17). `EscalationClass` taxonomy (:45-92): `CHARGED_CLASSES = {ci-red, ci-verdict-unavailable}`, `MAX_CHARGED_ATTEMPTS = 2` (:100), `MAX_UNCHARGED_ATTEMPTS = 3` (:101), `MAX_OUT_OF_SCOPE_DIFF = 1` (:102); `evaluateCeilings` :120; `deriveAttemptLadder` :181; `buildEscalationComment`.
- `feedback-run.ts` (918 lines): `FIX_SCOPE_FILE = ".factory/fix-scope.json"` (:54), `FIX_RUN_MANIFEST_PATH = "config/rosters/fix-run.pipeline.json"` (:53), `FIX_DISPATCH_CEILING_MS = 2_100_000` (:70), `MAX_FIX_COMMENTS = 20` (:45), snippet ceilings 4_000 chars / 40_000 bytes total (:47-49); `classifyDiffScope` (the never-edit guardrail symbol) lives here; `commentsDigest` :198 (sha256 over normalized bodies). A1 (v6b) absorbs the fix-loop runner via scheduled observe poll — these constants are the behavior it inherits.
- `src/fixloop/index.ts` :1-82 — public barrel.

---

## 4. DF3.6b resident bounds, DF1.11 steering seam, image pin machinery

**`src/phase-engine/resident-bounds.ts` (537 lines):**
`PROVISIONAL_RESIDENT_RSS_BYTES = 536_870_912` (512 MiB, :33); `DEFAULT_RESIDENT_SPEND_CEILING_MICROS = 8_000` µ$ (:44 — the bottom term of the credentials.ts:69-75 ordering); `DEFAULT_MAX_STEERING_ITERATIONS = 3` (:52); `BoundConfigError` :59; `loadResidentBounds(manifest)` :129; `projectWorstCaseMicros(rate)` :242; `createBoundsGuard` :302; `stampResidentBounds` :498.

**DF1.11 steering seam — the `/run/steering` tmpfs:**
- In-box channel root: `src/fleet/attach.ts` — resolution is `process.env.QDS_STEERING_ROOT || "/run/steering"` (:77); box-side script uses the identical default `'root="${QDS_STEERING_ROOT:-/run/steering}"'` (`BOX_STEERING_ROOT_SH`, :95), and `src/providers/exedev/driver.ts:123` carries the same default in its exec script. Both legs resolving differently splits the channel onto two files — the documented hazard (:71-74).
- Host-side controller: `src/phase-engine/steering.ts` (1433 lines) — `SteeringDirectiveSchema` (zod discriminated union on `action`, :111), `createSteering(deps)` :449, `PROMPT_CHAR_CEILING = 16_000` (:25), `ATTACH_MESSAGE_CHAR_CEILING = 4_000` (:49), `SOLICIT_TIMEOUT_MS = 60_000` (:30), `MAX_MALFORMED_ATTEMPTS = 2` (:32), `PlacementRefusedError` :181, `SteeringInbox` :198, `SteeringController` :266. Un-acked writes are never retried — the next drain re-reads the file in full (:733). J4's L7 compact-signal rides exactly this seam.

**Image pin machinery:**
- `scripts/build-exedev-image.ts`: `deriveBuildId(inputs)` :638 (deterministic from build inputs — base digest, BUN_VERSION, PI_VERSION, Dockerfile bytes, systemd unit bytes); `PI_VERSION = "0.84.4"` (:192), `NODE_VERSION = "22.20.0"` (:203), `OPENRIG_VERSION = "0.5.14"` (:213); `DEFAULT_TAG` local (:131); `CHECKSUM_ARGS = [BUN_SHA256, PI_AI_SHA256, NODE_SHA256, OPENRIG_TREE_SHA256]` (:1544); `copyContextSources` :1274 (the COPY-set-as-buildId-input mechanism); `resolveRuntimeBaseRef` :833, `classifyRegistryRefusal` :884.
- `src/providers/exedev/driver.ts`: **`DEFAULT_IMAGE_REF` :492-494 = `ghcr.io/quantum-digital-solutions/qds-exedev@sha256:ee80266907399d700b33dbe3ed10895187e87c45dfcb56c54db7aba7acc9bcea`** (the digest the charter reports as MANIFEST_UNKNOWN on GHCR — the real red); **`DEFAULT_IMAGE_BUILD_ID = "26b5ce571e50bfcc"` :600**. INV-IBOX-2 (:496-508): the box CANNOT read the digest it was pulled from — host enforces digest at pull, box proves the buildId (gate B), refuse on disagreement. (Minor drift note: the comment at driver.ts:466-467 still says "the image bakes 52538541c5430cc5 and this constant says 52538541c5430cc5" — stale prose, constant is now 26b5ce571e50bfcc.)
- `scripts/adopt-image-pin.ts`: regex-adopts the printed `export const DEFAULT_IMAGE_REF = "…"` + `export const DEFAULT_IMAGE_BUILD_ID = "<16hex>"` pair from a gate/publish block into driver.ts (patterns at :49, :62, :70). The #396–#398 ritual precedent.

---

## 5. Hindsight host client — `src/hindsight/`

**Modules** (all present): `client.ts` (466), `bank-provisioner.ts` (493), `mulch-importer.ts` (770), `round-trip-verifier.ts` (624), `schemas.ts` (181), `index.ts` (49).

**`client.ts` public API (`HindsightClient`, class :112):**
- Options :94-106: `baseUrl` (default env `HINDSIGHT_BASE_URL`), `apiKey`, `requestId`, **`mode: "live" | "mock"` — default live; `'mock'` short-circuits every request to a schema-valid canned body without touching the network** (callers needing a real round-trip must NOT set it). Auth: INV-HM1 env-only fallback — `HINDSIGHT_BEARER_TOKEN` preferred, `HINDSIGHT_API_KEY` legacy; empty strings coerced to undefined so a misconfigured var cannot shadow a valid one (:124-134).
- Methods (all bank-scoped, REST `/v1/default/banks/…`): `listBanks()` :142 (GET /v1/default/banks); `createBank(bankId)` :152 (**PUT, idempotent upsert — NOT POST**, :146-151); `retain(bankId, content, metadata?{source: "agent"|"mulch-import"|"manual"|"consolidate", kind: "decision"|"pattern"|"expertise"|"observation", tags?})` :166 (POST …/memories); `recall(bankId, query, limit = 5)` :192 (POST …/memories/recall); `reflect(bankId, query?)` :207 (POST …/reflect); `consolidate(bankId, options?{maxAge?, preserveRecent?})` :224 (POST …/consolidate).
- Timeouts (:44-47): RETAIN 30s, RECALL 10s, REFLECT 30s, CONSOLIDATE 60s.
- `schemas.ts`: `BankIdSchema` (:28), payload/response zod schemas (:60-141), MCP error codes `-32001..-32005` (:161-165).

**Bank naming scheme (`bank-provisioner.ts`):** three banks per story CC-6 (:1-4): `{resolveBankId(repoSlug)}`, `{baseId}-dev-meta`, and the fixed `COLLECTIVE_BANK_ID = "qds-collective"` (:40). Base truncated to ≤52 chars (`MAX_BASE_LEN`, :167) so base + `-11` suffix + `-dev-meta` all stay ≤64 (BankIdSchema cap); collision loop appends `-2..-11` (`resolveRepoBankId` :184-208), all-collide → `-32005`. `createBank` is idempotent (409/"exists" → success, :247+). Cross-project lock `LOCK_STALE_MS = 300_000` (:123); `provisionBanks(opts)` :355; `ProvisionClient` structural type for mock injection (:47-50). Script: `scripts/provision-hindsight-banks.ts` (exists, `import.meta.main`-guarded, `realBridgeProbe` :95, calls `provisionBanks` :176, sets the stdio-transport log sink :29).

**Round-trip verifier check sequence (`round-trip-verifier.ts`):** `verifyRoundTrip(opts)` :197 — docblock :191-193: **retain → recall → reflect → consolidate → post-consolidation recall** (5 steps; failure step names at :177). Host-side wall-clock recall timing (F009, :139-156 — server `durationMs` kept alongside as `serverRecall`); `SLOW_QUERY_THRESHOLD_MS = 5_000` (AC-7, :188); returns `RoundTripOk{memoryId, recallMatches, insightCount, consolidatedCount, preservedCount, durations, slowQuery}` / `RoundTripErr{step, error}`.

**Gate:** `src/gate/assertions/p0-9-memory.ts` — `memoryAssertions()` :94; drives `verifyRoundTrip` against `HINDSIGHT_BASE_URL ?? "http://127.0.0.1:8888"` (:104); `ASSERTION_TIMEOUT_MS = 150_000` (:35, listBanks probe + five calls); `evaluateRoundTrip(result, bankId)` :72; `describeListBanksFailure` :45 (names a non-Hindsight HTTP listener via `<title>` sniffing).

**NOT in the box image COPY set — CONFIRMED:** the exedev box image is `oci/exedev/Dockerfile` (1350 lines; the root `oci/Dockerfile` is the separate DF2.9 enterprise/pi image, 88 lines). Its engine-stage COPY enumeration (~:277-355) is explicitly "ENUMERATED, NOT `COPY src/`" (:234-235) — every COPYed path is a buildId input. It copies: `scripts/pipeline-run.ts`, `scripts/lib/`, `src/fleet/`, `src/lib/`, `src/phase-engine/`, `src/swarmclaw/` (:352), `cli-anything/`, `pi-vs-claude-code-vendor/coms-core.ts`, and a NAMED provider file list (bounded-exec, timeout, step-log, cap-rejection, run-record, fs-atomic, credentials, errors, driver, harvest, path-guard, quota, quota-intents, viz-guard). **Zero occurrences of `hindsight`, `judgment`, `fixloop`, or `src/audit` anywhere in the file (grep count 0).** Consequence: adding hindsight imports to `src/fleet/` or `src/phase-engine/` engine-reachable code will trip the build's resolution probe until the COPY set grows — that is the re-pin-ritual coupling M2.2's AC names ("new box files move deriveBuildId").

---

## 6. Swarmclaw chassis — `src/swarmclaw/`

**Files:** `index.ts` (createServer, :35), `log.ts`, `mcp/stdio-transport.ts`, `mcp/tool-bridge.ts`, `routes/agents.ts`, `routes/mcp-servers.ts`, `store/agent-store.ts`, `store/mcp-store.ts`.

**LOAD-BEARING utilities (confirmed by importer grep):**
- `log.ts`: `LogEntry` (:10), `setLogSink` (:44), `log` (:52), `newRequestId` (:56). `swarmclaw/log` imported by ~50 files: src/providers (15 files), src/fleet (8), src/audit (2), src/reverify, src/judgment (client.ts), scripts/fleet.ts, scripts/{qds-cost,qds-audit,run-record,fix-run,cap-hit-demo,sandbox-reap,sandbox-teardown}.ts, plus tests.
- `mcp/stdio-transport.ts` re-exports the log trio and is imported by all four hindsight modules + `scripts/provision-hindsight-banks.ts`.
- `maskEnv` is DEFINED in `mcp/tool-bridge.ts:158` and imported by `src/hindsight/client.ts:26` (INV-HM1 env diagnostics masking) and `routes/mcp-servers.ts:19,140` (INV-SC5).

**ORPHAN server surface (confirmed):** `createServer`/`routes/*`/`store/*` are consumed ONLY by `src/swarmclaw/index.ts` itself (routes+stores are its internals, :16-25) and then by `src/index.ts` (the repo-root re-export :1-2) and two tests (`tests/swarmclaw/index.test.ts`, `tests/swarmclaw/e2e-demo.test.ts`; one more test imports routes/store directly). **No production module under src/ or scripts/ imports the server surface.** Z5's extract-`log`/`newRequestId`/`maskEnv`-to-`src/lib/` move is mechanical; DD-18's disposition question is exactly this dormant createServer/routes/store subtree. Note: `mcp/` is NOT orphan — stdio-transport + tool-bridge are hindsight's plumbing.

---

## 7. Judgment tier — `src/judgment/`

**Modules:** `client.ts`, `schemas.ts`, `egress.ts`, `ceiling.ts`, `emit.ts`, `envelope.ts`, `index.ts` (barrel, exports empty in grep — types flow via direct module imports).

**How mock mode satisfies the adapter shape today (`client.ts`):**
- `JudgmentClient` :98; `judge(state, questions: Record<string, Question>, opts: {egressClass, ceiling?})` :133-… returns `Promise<JudgmentEnvelope>` — this IS the typed ask shape D-4 formalizes (state + questions → answers + probabilities via AnswerSchema + usage + provenance envelope).
- Mode resolution :108-126: `TYPESAFE_MOCK === "1"` forces mock → constructor `mode` → default **mock** (INV-J5: every wave green with no env key). Live mode requires non-empty `TYPESAFE_API_KEY` read once, never logged (INV-J1).
- **Mock short-circuits the NETWORK only — never validation** (:164-171): the canned body goes through the SAME `makeJudgmentResponseSchema(Object.keys(questions))` strict parse; unknown keys, missing fields, or answers to unasked ids refuse with no envelope (AC-4). This is the contract test template J1's per-adapter tests formalize.
- Order of operations in judge(): egress choke FIRST (:147), ceiling admit (:149), documented budget warn (:151-161 — vendor 64k tokens/req, 32k state+longest-question, documented not enforced), then request.

**Neutral-layer policy:**
- `egress.ts`: `EGRESS_CLASSES = ["machine-state", "finding-text", "ac-prose", "diff-hunk"]` (:17); `DEFAULT_MAX_EGRESS_CLASS = "ac-prose"` (:27 — diff-hunk is ZDR-gated above the default); `redactForEgress` :60; `egress(text, class)` :78; `EgressRefusedError` :29.
- `ceiling.ts`: `DEFAULT_STAGE_CEILING_INPUT_TOKENS = 1_000_000` (:14); `JudgmentCeiling` :30 (one instance per stage, caller-held, `.admit()`); `CeilingExceededError` :16.
- `envelope.ts`: `EnvelopeSchema` strict zod (:14-27): `requestId, model (literal TYPESAFE_MODEL), questions, answers, usage, latency_ms, egress_class, created_at (ISO-8601)`. Provenance rides WITH the answer set (JEV-2); volatile fields never enter the digest-stable side-channel (INV-J3).
- `emit.ts`: `DEFAULT_PROVENANCE_DIR = "_bmad-output/judgment/provenance"` (:30); `provenanceDigest` :60; `detailFromEnvelope` :65; `emitProvenance` :90; `DigestDivergenceError` :41.
- `schemas.ts`: **`TYPESAFE_MODEL = "jev-1.13.0"` (:21, the pinned model, literal-checked in envelope + responses — THE drift alarm target)**; `TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone"` (client.ts:43); `JUDGE_TIMEOUT_MS = 30_000`, `DEFAULT_MAX_ATTEMPTS = 2` (retry), `DEFAULT_WARN_STATE_CHARS = 100_000`.

**Scripts + corpus:**
- `scripts/judgment/observe-round.ts` — the S1 observer (JEV-3): for each `arm="frontier"` corpus record builds a SMALL state (finding_text + diff_context_ref + ids — never a diff hunk, never bot prose), asks exactly TWO questions (`is_real_defect` noul + `disposition` choice), appends one record `labeler: jev-1.13.0-observer` (:47 `JEV_LABELER`), `arm: jev`; idempotent on (pr, round, finding_id, labeler); `OBSERVER_EGRESS_CLASS = "finding-text"` (:46); recording-only (§3.5 — no threshold/routing/gate authority); `--live` rides the INV-J5 double gate (TYPESAFE_API_KEY AND QDS_LIVE_PROBE_CONFIRMED=1).
- `scripts/judgment/ab-report.ts` — JEV-4 A/B report: joins frontier↔jev on (pr, round, finding_id); PERFORMANCE (disposition agreement + cross-tab parsed from rationale, never guessed), SPEED (latency_ms per arm, nulls never imputed), COST (jev `cost_exact_usd` vs frontier `cost_estimate_usd` — estimate labeled, §3.12 wording discipline), OUTCOME-VALIDATED PRECISION (reads "not yet available" while outcome fields null). Renders data, judges nothing; does not import the judgment client.
- Corpus: `DEFAULT_CORPUS_DIR = "_bmad-output/judgment/corpus"` (scripts/corpus/merge.ts:32); `CORPUS_LOCK_ID = "corpus-writer"` (:34, held via `acquireRunLock` on the corpus dir :171); capture tooling barrel `scripts/corpus/index.ts` (TriageRecordSchema, DISPOSITIONS, appendRecord; backfill/merge/schema/validate modules). Provenance side-channel: `_bmad-output/judgment/provenance` (emit.ts:30). Charter's S1 numbers (88% agreement / 108 findings / $0.002 / ~220ms) are evidence-file facts, not code — code confirms only the machinery.

---

## 8. State shapes — writers/readers per store

- **`.sandbox/runs/` run records JSON** — `src/providers/run-record.ts`: `RunRecordStore`; `DEFAULT_RUNS_DIR = ".sandbox/runs"` (:1220), env `QDS_RUNS_DIR` (:1246, empty-string treated as UNSET not a path, :1226-1230). INV-3 no-overwrite: `create()` opens `O_WRONLY|O_CREAT|O_EXCL` (`wx`), never an existence check; updates write a sibling temp file + `renameSync` (atomic swap); mode 0600, fail-closed if O_EXCL or 0600 cannot be honored (:10-15); record store also guards 0700 directory posture (:1184-1200).
- **Per-run locks** — `scripts/lib/run-lock.ts`: `RunLockReentrantError` (:81, code `run-lock-reentrant`) — **NOT re-entrant by design**: `acquireRunLock(runsDir, runId, holder)` :1011 throws it when the same process already holds the lock (:1028); `RunLockedError` :54 (cross-process holder); `withRunLock` :1109; destructive-mark helpers :374-399; `hostTag()` :173, `isAlive(pid)` :192; `releaseHeldRunLocks` :470.
- **audit.db** — `src/audit/link-store.ts` (writer `openAuditStore` :612, walker handle `openAuditStoreForWalk` :832), `DEFAULT_AUDIT_DB_FILE = ".sandbox/audit.db"` (:175), env override `QDS_AUDIT_DB` (resolution noted in tests/fleet/skill-contract.test.ts:489-496). bun:sqlite.
- **cost-ledger.db** — `src/providers/cost-ledger.ts`: `DEFAULT_COST_LEDGER_FILE = ".sandbox/cost-ledger.db"` (:579), env `QDS_COST_LEDGER_FILE` (:1147). **Money is integer micro-dollars everywhere (DD-9)** (:7-11); `INSERT … ON CONFLICT DO NOTHING`, never an update; per-issue spend is always `SUM(cost_micro_usd)`; `usdToMicros` here is the SECOND module-private copy (the other in credentials.ts:126 — both finite-guarded, ponytail note at credentials.ts:122-125 names the dedup trigger); safe-integer guard throws `cost-convert-invalid` (:309-313); read-only open never creates the ledger (:1351). Bridge to run records: `src/providers/cost-ledger-bridge.ts`.
- **dispatch-log.jsonl** — `src/fleet/dispatch.ts`: `DISPATCH_FAILURE_LOG = ".sandbox/dispatch-log.jsonl"` (:103); failure entries appended on FleetError exits (:28, :1110 — a failed append is itself reported); writers also in `src/fleet/submit.ts` and `src/fleet/fanout-primitive.ts`.

---

## 9. CI image-pin state

- Workflow: `.github/workflows/verify-image-pin.yml` — the pin-change gate. FOUR legs (:89-105): `pull_request_target` on paths `src/providers/exedev/driver.ts` / `.github/image-pin-exceptions.json` / the workflow file; `push` (main, dev, same paths); `schedule` daily cron `17 6 * * *` (:104); `workflow_dispatch`. Matrix: schedule/dispatch run TWO legs (`default` + `dev` — the pin lives on dev between promotes, :142-161). Required-check name for branch protection: `verify-image-pin / verify (default)`.
- Job `verify` (:126-607): extracts exactly-one `DEFAULT_IMAGE_REF` + exactly-one `DEFAULT_IMAGE_BUILD_ID` from driver.ts (:288-327); refuses non-digest refs (:396); 64-hex + 16-hex shape checks (:372-390); verifies Sigstore provenance from the ghcr OCI referrer via `gh attestation verify --bundle-from-oci` bound to `publish-exedev-image.yml@refs/heads/(main|dev)` (:520, :569-574), 5 attempts over ~40s; exception register `.github/image-pin-exceptions.json` only DOWNGRADES a verify failure to a loud warning while unexpired (:596-604).
- Job `base-drift` (:634-759): scheduled/dispatch only; compares the pinned exeuntu base digest against upstream `:latest`. **Fires BY DESIGN** — "upstream rebuilds exeuntu weekly on a no-cache cron, so this fires by design … It is NOT an incident" (:750-752). This is charter red-condition (a).
- **Current red condition (b) — the real one:** `DEFAULT_IMAGE_REF` at `src/providers/exedev/driver.ts:492-494` names digest `sha256:ee802669…9bcea`, which the charter reports MANIFEST_UNKNOWN on GHCR (no bytes to pull, no referrer to verify) → every `verify` leg fails the attestation step → full re-pin ritual (re-pin base → rebuild → re-sweep → publish via publish-exedev-image.yml → adopt via `scripts/adopt-image-pin.ts`). In-repo corroboration: `DEFAULT_IMAGE_BUILD_ID = "26b5ce571e50bfcc"` (driver.ts:600) exists as a constant while the comment at driver.ts:466-467 still describes the PREVIOUS pairing (52538541c5430cc5) — the pin moved since that comment was true, consistent with an adopted-then-lost publish.
- **Exception register is EMPTY** (`.github/image-pin-exceptions.json`: `"exceptions": []`) — steady state restored 2026-09-06 per its `$comment`; the workflow header's "holds ONE entry today, expires 2026-10-05" prose (:31-38) is STALE (its own text says "Read the file, not this paragraph"). No exception is available to absorb the current red; nothing expires before 2026-10-05 because nothing is registered.

---

## Writer bindings — hard facts story specs must not contradict

1. **16 verbs, closed registry** `listVerbs()` in `src/fleet/verbs.ts`; append-only by convention (every wave adds entries, edits no predecessor). `--driver` REQUIRED on dispatch, status, harvest, teardown, fanout, attach, run, observe, submit, cancel; ABSENT on rank, approve, reject, enrol, unlock, result.
2. **Exit codes 0–6 with ONE Q11 definition of 6**: billable work landed, output/cleanup failed after — not retryable, CLI-only. 1 = transient (dangerous on box-reaching verbs; `run`'s 1 is the earned idempotent-start exception). 3 = dispatch/submit setup gate only.
3. **Credential ordering to mirror in M2.1**: record → VM → validate delivery target → mint → deliver → (capture-spend) → revoke → verify-revoked, with revoke-verify COMPENSATION on delivery failure (a minted key never outlives a failed delivery). Transport retries ≤2 for non-POST only; POST/mint never retried. Backstop cap `defaultKeyCapMicroUsd = 50_000_000` µ$ enforced at mint (INV-CAP-1); per-run cap derives from admission; integer µ$ everywhere.
4. **Approval policy is channel-independent**: `.factory/approvers.json` 0600, scrypt ({N:2^15, r:8, p:1}), token STDIN-only (10s timeout), no token flag exists to declare; 24h default approval timeout; unlock needs no token by recorded ruling. ADR-2's inbox channel changes none of this.
5. **Observation numbers**: 2h default window (`DEFAULT_OBSERVATION_WINDOW_MS = 7_200_000`); observe sweep 30 min cron (`SWEEP_INTERVAL_MINUTES`, derived reaper-staleAfterMs/8, must divide 60), 20-min wall budget, 25 candidates/pass, EXITING pass no daemon; fix-loop CI poll 30s in 15-min window; escalation PR comment = fixloop's only internet egress; charged attempts ≤2.
6. **`AUDIT_HOPS` is frozen** — 10 hops exactly; `memory-retain-receipt` exists with an EMPTY vocabulary (nothing writes it, INV-AUDIT-4). M1/M2 stories retain into Hindsight banks; if any story wants the audit hop, that is a never-edit violation to surface first. Walk = `walkAuditChain`, verdict = `chainVerdict`, store default `.sandbox/audit.db`.
7. **`/run/steering` tmpfs is the DF1.11 seam** (override `QDS_STEERING_ROOT`, identical default in attach.ts + exedev driver script); directive schema is a zod discriminated union on `action`; attach message ≤4_000 chars; prompt ceiling 16_000. J4's compact signal goes through here, nowhere else.
8. **Image pin is a PAIR** — `DEFAULT_IMAGE_REF` (digest) + `DEFAULT_IMAGE_BUILD_ID` (16-hex, currently `26b5ce571e50bfcc`) in `src/providers/exedev/driver.ts`; box proves buildId, host enforces digest, gate B refuses disagreement. ANY change to the box COPY set (new src/ files engine-reachable) moves deriveBuildId → full re-pin ritual. `src/hindsight/`, `src/judgment/`, `src/audit/`, `src/fixloop/` are NOT in the box COPY set today.
9. **Judgment shape J1 formalizes (do not invent a new one)**: `judge(state, questions, {egressClass, ceiling?}) → JudgmentEnvelope{requestId, model: "jev-1.13.0" (literal), questions, answers, usage, latency_ms, egress_class, created_at}`. Mock = network-only short-circuit through the SAME strict validation; egress classes closed list `machine-state|finding-text|ac-prose|diff-hunk`, default ceiling `ac-prose`; ceiling 1M stage tokens; provenance side-channel digest-stable, volatile fields excluded (INV-J3); `TYPESAFE_MODEL` literal is THE drift alarm.
10. **State stores**: runs/ JSON 0600 O_EXCL-create + temp+rename update; run locks NON-reentrant (`RunLockReentrantError`); audit.db + cost-ledger.db are bun:sqlite under `.sandbox/` (QDS_AUDIT_DB / QDS_COST_LEDGER_FILE overrides), ledger money integer µ$ INSERT-only; dispatch-log.jsonl `.sandbox/dispatch-log.jsonl` written by dispatch/submit/fanout on failure paths.
11. **CI**: `verify-image-pin` is a four-leg gate; base-drift red is BY DESIGN (weekly upstream rebuild), but the current DEFAULT_IMAGE_REF `ee802669…` has no verifiable provenance AND the exception register is EMPTY — T2 remains blocked until the re-pin ritual lands. Z4/M1.1 stories must treat re-pin as an ops-gated prerequisite, not a code task.

**Charter-contradicting / stale facts surfaced:**
- Charter §2.1 cites `src/fleet/verbs.ts:73-431` — the registry now spans ~:87-663 (line drift only; 16 verbs + driver/exit tables confirmed exactly as chartered).
- Charter says "Dockerfile:277-305" for the COPY set — the file is `oci/exedev/Dockerfile` (root `oci/Dockerfile` is a different, 88-line image); the enumeration runs ~:277-355. Fact itself confirmed (hindsight absent).
- `verify-image-pin.yml` header claims the exception register "holds ONE entry today (expires 2026-10-05)" — the register itself is EMPTY (steady state since 2026-09-06). No exception cushion exists for the current red.
- driver.ts:466-467 comment names buildId pairing 52538541c5430cc5; the constant is `26b5ce571e50bfcc` — stale comment, not a contract drift.
