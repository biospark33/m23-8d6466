# R4 — External Dependencies & Integration Contracts (QDS-Factory v4)

**Purpose:** Document the exact external tool/SDK contracts each Phase-0/Phase-1 story integrates against — versions, call shapes, flags, env, and verification status — so story writers specify *real* APIs, not blueprint assumptions.

**Source of truth:** `prd-qds-factory-v4.md` §4.5, §4.6, §5.1–5.4, §12.1–12.2, Appendix D (spikes executed 2026-06-06). Every contract below is command/file-evidenced in that PRD. Where a contract is unverified or blocked, the status banner says so and gives the fallback + exact unblock.

**Legend:** ✅ verified/spiked · ⚠️ corrected-or-blocked · 🔧 must-acquire · ❌ absent.

---

## 1. Pi binary + coms contract (execution coordination)

**Version (PINNED):** `pi@0.55.0`. OQ-5 RESOLVED — pin in the factory lockfile; re-run the load smoke-test before adopting any pi ≥ 0.73. The coms.ts comments target pi 0.73+, but 0.55.0's flag parser is *more lenient* (the strict "Unknown options" rejection coms.ts guards against is absent on 0.55.0), so the contract degrades gracefully.

**Vendoring (Phase-0, 🔧 done in spike):** `coms.ts` is NOT in any local pi clone — it lives only upstream. Vendored from `disler/pi-vs-claude-code@main` to `/Users/steve/QDS-Engineer/pi-vs-claude-code-vendor/` (`coms.ts`, `coms-net.ts`, `themeMap.ts` [shared-helper dep], `scripts/coms-net-server.ts`). Loads on 0.55.0 with zero errors: `pi -e ./coms.ts --list-models` → 100 models; `registerFlag` signature matches `extensions/types.d.ts:684`.

**Extension API (load-bearing call shapes):**
- `pi.registerFlag("cname", …)` (`coms.ts:536`), read at `:225` — registers `--cname`. NOT a core flag (absent from `pi --help`). Used by the launcher to name each worker `<run-id>-<role>`. Fallback chain if unavailable: system-prompt frontmatter `name:` → `agent-<6chars>`.
- `pi.getFlag(...)` / `pi.registerTool(...)` — present + signature-compatible on 0.55.0.
- `sendMessage(..., { triggerTurn: true })` — the `agent_end` nudge (`tilldone.ts:365-383`) that forces the receiver to take a turn. Verified on 0.55.0.

**coms verbs (upstream, ✅, parse-only schema):**
- `coms_send(target, prompt, conversation_id?, response_schema?)`
- `coms_get` (non-blocking poll) · `coms_list`
- `coms_await(msg_id, timeout_ms?)` — default timeout **30 min = 1_800_000ms** (`PI_COMS_TIMEOUT_MS`, `coms.ts:32`).
- **`response_schema` is PARSE-ONLY** — receiver's final message is `JSON.parse`d on `agent_end`; it is **NOT** schema-validated. ⇒ the launcher lead must validate worker replies against schema itself (§4.6).
- Transport: per-agent unix socket + file registry `~/.pi/coms/`; no hub; `MAX_HOPS=5`.

**Pi core flags (✅ confirmed in 0.55.0 `pi --help`):** `--model`, `--mode json`, `--mode rpc`, `-e <ext>`, `-p`/`--print`, `--append-system-prompt`, `--session`. `--mode json`/`--print` is genuinely non-interactive (no TUI).

**Provider routing (❌ no native GLM):** Pi natively supports only `anthropic` + `openrouter`. GLM/Kimi MUST route via `openrouter`. Launcher flag: `--role-model <role>=<provider/model>` (repeatable).

**ARCHITECTURE DECISION (OQ-1, ✅ RESOLVED):** Two in-node mechanisms both run on 0.55.0 — (A) socket-coms via vendored `coms.ts`; (B) subprocess-RPC via on-disk `agent-team.ts:347-368` / `pi-pi.ts:294` spawning `pi --mode json -p` and parsing the JSON event stream. **Decision: subprocess-RPC is the proven zero-infra day-1 path; socket-coms is also viable.** Because socket-coms works, §7's `coms_send`/`coms_await`/`response_schema` protocol MAY be kept as-authored — the §7/§4.6 verb-rewrite is **optional, contingent on path chosen**, not forced.

> **UNVERIFIED:** full 2-agent `coms_send`→`coms_await` round-trip is **deferred — needs a paid LLM turn + API key** (no key present in spike, $0 spent). Load/registration proven; live message exchange is not.

---

## 2. pi-lens (in-node QA gate + LSP surface)

**Version:** `pi-lens v3.8.47` (OQ-2 RESOLVED). Install: `pi install npm:pi-lens` → `~/.pi/agent/settings.json` `packages: ["npm:pi-lens"]`. Reverse: `pi remove npm:pi-lens`.

**Registered agent tools (primary LSP surface):**
- `lsp_diagnostics` (file / dir / batch) — **the single most load-bearing call.** Returns a structured `details` object (`tools/lsp-diagnostics.ts:451-470`) serialized to stdout via the `tool_execution_end` event → `JSON.stringify`. **Machine-readable headless emission CONFIRMED** ⇒ the post-edit diagnostics gate (FR-EX-11) does **not** need the FR-EX-12 ast-grep fallback on the merits.
- `lsp_navigation` — definitions, references, hover, workspace symbols, call hierarchy, `rename {apply:true}` (semantically-safe cross-file rename), findSymbol.
- `ast_grep_*` tools.

**Modes:** `--mode json` and `--mode rpc` both confirmed emitting machine-readable JSON on 0.55.0.

**LSP server prerequisite (🔧 acquired in spike, must be on PATH):** pi-lens auto-discovers servers from PATH / `node_modules` but **cannot diagnose a language whose server is absent.** Installed globally: `typescript-language-server@5.3.0` (+ `typescript`), `pyright@1.1.410`. Reverse: `npm rm -g typescript-language-server pyright`.

**Standalone fallback (nav-only role):** `@spences10/pi-lsp v0.0.33` (defs/refs/hover/diagnostics/symbols, MIT). Do NOT load both pi-lens + pi-lsp by default (tool overlap → agent confusion).

> **UNVERIFIED / CAVEAT:** **TDI (Turn Diagnostic Index) is a TUI slash-command `/lens-tdi`, NOT a headless flag.** Headless TDI = read on-disk `~/.pi-lens/` history/review JSON artifacts, not a CLI emit. The §9.3 fallback (warning-count proxy via `--mode rpc`) applies if a numeric TDI is needed headless. Live diagnostic *content* deferred — needs an API key (single trivial run to confirm).

---

## 3. Paperclip (control plane) — REST + plugin contract

**Live instance:** `localhost:3100` (running this session — npx, `local_trusted`, v2026.529.0, company "QDS"). Repo `/Users/steve/boardlensai/paperclip` @ `paperclipai/paperclip`.

**REST endpoints (✅):**
- `POST /api/plugins/install` (`routes/plugins.ts:1008`, openapi `:3385`) — install external plugin.
- `POST /api/workflows/{name}/run` (handler `api.ts:1784`, OpenAPI def `:566`) — e.g. `qds-piv-loop`.
- `GET /api/stream/__dashboard__` (`api.ts:1384`) — **SSE progress stream**.
- `GET /api/plugins` → currently `[]` (no plugins installed).
- Cost ledger (for yield-curve, OQ-17): `GET /companies/:companyId/costs/by-agent-model | /by-provider | /summary` (`from`/`to` params) — `server/src/routes/costs.ts:132-177`.

**Agent-registration adapter `hermes_local` (✅, `adapters/registry.ts:440-500`):** host injects `PAPERCLIP_API_KEY` (`:468`) + `PAPERCLIP_RUN_ID` (`:469`) into the agent process; external Hermes calls REST as a registered agent (keyed via `agent_api_keys` table). "root agent" + `hermes_local` agent type.

**executionPolicy (approval gates, ✅):** `issues.ts:52` `jsonb("execution_policy")` — lives on issues, not agents. Approve/resume decisions persisted in `issue_execution_decisions`; logged human decisions in `approvals.ts:5-28` (`status`/`payload`/`decisionNote`/`decidedByUserId`/`decidedAt`).

**Cost model correction (⚠️):** issues have **NO `cost` column.** Cost = separate ledger `cost_events` (`issueId` FK, `costCents`). Accountability spine reads the ledger. `createCostEventSchema` requires `costCents` (cents). NB **Pi has ZERO Paperclip/cost integration** (OQ-8) ⇒ `pi-team-launch.sh` is the **sole emitter** of per-role `cost_events` rows; cost via OpenRouter `/api/v1/generation?id=` reconciliation **or** a local price table.

**Plugin UI (OQ-17, ✅):** native `dashboardWidget` slot (`PLUGIN_UI_SLOT_TYPES`, `shared/src/constants.ts:870-887`) mounted at `Dashboard.tsx:309-314`; host ships no chart lib (plugin bundles its own).

> **BLOCKED-on-creds (OQ-3 / Telegram):** the plugin SDK has **NO first-class messaging / inline-button / approval-routing primitive** — only generic `webhooks` / `tools` / `launchers` / `jobs`. Telegram plugin is **external + not installed**; bidirectional `/approve` `/status`, inline approvals, per-type routing are **unverifiable from disk**. **`@mvanhorn` attribution was WRONG** (core contributor, not plugin author — do not cite). **Fallback in effect: Hermes-driven Telegram gateway** for any unconfirmed capability; log the gap. **Unblock:** real plugin npm name + bot token + live chat + instance-admin → `POST /api/plugins/install`, then live `/approve`+`/status` round-trip.

---

## 4. Archon (orchestration) — DAG + env patch

**On disk:** plain upstream `coleam00/Archon@dev`, HEAD/base SHA `536584db`. NOT a fork; no env patch applied.

**Workflow run path:** bash node only (zero native Pi refs). `executeBashNode` (`dag-executor.ts:1305`) → `execFileAsync('bash',['-c',finalScript],{cwd,timeout})` at `:1362`. **Bash-node stdout = node's structured output** (captured verbatim `:1361-1368`); logs/diagnostics → stderr → surfaced as Archon warning (`:1370-1378`).

**DAG workflows:** base PIV = 8 nodes (`.archon/workflows/defaults/archon-piv-loop.yaml`: explore, create-plan, refine-plan, implement-setup, implement, code-review, fix-feedback, finalize). **14-node `qds-piv-loop` does NOT exist → must author** (register via `POST /api/workflows/{name}/run`). An extra `script` node type (bun/uv runtime) exists beyond bash.

**ENV PATCH (OQ-6 RESOLVED — 3 sites, not 2):** applied on branch `qds/env-patch-spike` (base SHA `536584db`, uncommitted/not pushed). The single most load-bearing rule: the executor merge must be **`env: { ...process.env, ...(node.env ?? {}) }`** — never a bare `env: node.env` (which wipes inherited PATH/creds and breaks every existing bash node, CORRECTNESS-A).
- (a) add `env` to `bashNodeSchema` — `packages/workflows/src/schemas/dag-node.ts`.
- (b) merge into `execFileAsync` options object — `packages/workflows/src/dag-executor.ts:1362`.
- (c) widen `@archon/git` `exec.ts` options type with `env?: NodeJS.ProcessEnv` — `packages/git/src/exec.ts` (else (a)+(b) fail to compile, TS2353 — **the missed 3rd site**).
- Verification: `tsc --noEmit` clean; existing `dag-executor` suite **150 pass / 0 fail**. Blast radius LOW — `executeBashNode` has 1 upstream caller (`executeDagWorkflow`). **Decision: maintained private branch + documented rebase, pin base SHA `536584db`** (upstream acceptance uncertain). Follow-up scope: two other `bash execFileAsync` sites (`~:1577` script-node, `~:2022` alt-bash) do NOT get per-node `env`.

---

## 5. Launcher contract — `pi-team-launch.sh`

**Status:** does NOT exist on disk — **Phase-0 item 3 deliverable** (spec only). Single entry point a bash node invokes to run an in-node Pi team; the **hard-guard enforcement point** (owns spawn/kill of every `pi` subprocess; budget/turn/wall-clock caps live here, never delegated).

**Signature (long-flags):** `--task <desc>` · `--context-path <path>` (Mulch-primed + Seeds/issue bundle) · `--archetype <A..F>` (default C/TDD-Trio) · `--budget-cap-cents <n>` · `--turn-cap <n>` · `--wall-clock-cap-ms <n>` (**must be ≤ the bash node's own `timeout`**, `dag-node.ts:181`) · `--role-model <role>=<provider/model>` (repeatable; GLM/Kimi always via `openrouter`) · `--worktree <path>` (defaults to inherited `cwd`).

**Mechanics:** each role = one `pi` subprocess named `--cname <run-id>-<role>`; per-role system prompts via `--append-system-prompt`. Exactly one **lead** role (Architect/maker/Integrator) emits the merged JSON result on its final turn → launcher writes it (and only it) to stdout. Lead validates each worker reply against schema (coms `response_schema` is parse-only); launcher validates the lead's merged object before writing. **Mandatory worker-schema field `changed_files: string[]`**; lead computes the set-union and runs `lsp_diagnostics` over it before emit (FR-EX-11). Merged output schema = union `changed_files` + result + `partial: boolean` + `exit_class` (`transient|overflow|logic`) + waivers. OQ-16b await-timeout defaults: Solo/Pair 10min, TDD-Trio 8min, Contract-split Quad 6min.

---

## 6. Seeds 0.2.5 + Mulch 0.6.3 (decomposition + priming) — PRIVATE CLIs

**⚠️ These are PRIVATE CLIs, NOT npm packages.** The npm names `sd` / `mulch` are **unrelated** — do not `npm install` them. Pin the installed binary version (or a newer private-channel release if one exists); no newer public target.
- **Seeds:** `/usr/local/bin/sd`, **v0.2.5** (blueprint expected 0.4.7 → upgrade/pin). Verbs: `create / dep / ready / close` (✅). `seeds-decompose` → store `.seeds/issues.jsonl` (fields: id, title, status, type, priority, labels, blocks[], blockedBy[], closeReason).
- **Mulch:** `/usr/local/bin/mulch`, **v0.6.3** (expected 0.10.1 → upgrade/pin). Verbs: `prime / record / learn` (✅). Store `.mulch/expertise/<domain>.jsonl` (`boardlensai/.mulch` = 13 records).

---

## 7. Hindsight (memory: retain → recall → reflect)

**Client/stack:** `hindsight_client 0.7.2` (Hermes venv); local stack `~/.hindsight-docker` v18.1.0 (embedded PostgreSQL 18.1 native, **port 8888 — NOT docker-compose**). Cloud: `api.hindsight.vectorize.io`.

**API (bank-scoped, identical cloud vs self-host — only `base_url` + bearer differ):** `/v1/default/banks/{bank_id}/…`
- retain = `POST …/memories` · recall = `POST …/recall` · reflect = `POST …/reflect` · plus `…/consolidate` + `…/mental-models/{id}/refresh`.
- **Auth = OPTIONAL bearer** (SDK `api_key` / control-plane `HINDSIGHT_CP_DATAPLANE_API_KEY`). **NOT `HINDSIGHT_API_LLM_API_KEY`** (that is the LLM-provider key — do not conflate, NFR-SEC-5).
- Banks: `{repo}` and `{repo}-dev-meta`.

**Paperclip plugin (🔧 external):** `@vectorize-io/hindsight-paperclip` (v0.2.0) — install `pnpm paperclipai plugin install`. Events: `agent.run.started` → auto-recall; `agent.run.finished` → auto-retain (`document_id = runId`); configurable bank granularity. **Not in the Paperclip repo.**

> **BLOCKED-on-env (OQ-4):** self-host **direction confirmed** (the v4 default holds; cloud = opt-in). But the local stack **won't boot here** — arm64 `libpq`→`openssl@3` expects `/opt/homebrew`, host has only x86_64 Homebrew (`/usr/local`) + macOS-15 binaries on macOS-13. Round-trip retain→recall→reflect **unproven.** **Unblock (operator):** arm64 OpenSSL at `/opt/homebrew/opt/openssl@3`, **or** external Postgres via `HINDSIGHT_API_DATABASE_URL`, **or** host-matched re-fetch; then re-run throwaway round-trip. `GROQ_API_KEY` present for the LLM side.

---

## 8. GitNexus (repo-wide static architecture)

**CLI:** GitNexus **v1.6.3** installed (`/usr/local/bin`, ≥1.4.8 required). `gitnexus analyze` builds the knowledge graph. **MCP server confirmed live this session** (used for the §4.4 executor impact analysis).

**Extension (🔧 NOT installed):** `pi-gitnexus-plus` v0.7.0 → `pi install npm:pi-gitnexus-plus`. Registers **14 agent tools** (`query`, `context`, `impact`, `detect_changes`, `rename`, `cypher`, `route_map`, `tool_map`, `shape_check`, `api_impact`, `group_*`, `read_resource`); auto-augments file reads + searches with call chains / execution flows / blast radius. Stdio (local CLI) or HTTP transport. Most load-bearing agent tools: `gitnexus_context` + `gitnexus_impact`.

**License caveat (§14 R12):** GitNexus core is PolyForm Noncommercial; the extension itself is MIT.

---

## 9. Model routing (cross-cutting)

- **Anthropic Opus** — native, for judgment roles (Architect / Reviewer / Adversary).
- **OpenRouter** — for GLM/Kimi constrained roles (Implementer). **Claude Code / Pi do NOT support GLM/Kimi natively — ALWAYS via OpenRouter** (`provider/model` = `openrouter/...`).
- **Telegram comms front-door:** BLOCKED on creds (OQ-3) → **Hermes-driven Telegram gateway fallback in effect.**

---

## UNVERIFIED / BLOCKED / FALLBACK-ONLY — quick index

| Contract | Status | Effect on story writing |
|---|---|---|
| coms `coms_send`→`coms_await` live 2-agent round-trip | UNVERIFIED (needs API key; load proven) | Write to the contract; flag a Phase-0 live-confirm AC. |
| pi-lens headless **TDI** | CAVEAT — TUI slash-command only; headless = read `~/.pi-lens/` artifacts | Do NOT spec a `--tdi` flag; spec artifact-file read or warning-count proxy. |
| pi-lens `lsp_diagnostics` live content | minor — content needs API key (emission proven) | Gate design is safe; one trivial live run to confirm. |
| Telegram plugin (OQ-3) | BLOCKED-on-creds; SDK has no messaging primitive | Spec **Hermes-gateway fallback**, not plugin parity. `@mvanhorn` attribution is WRONG. |
| Hindsight local stack boot (OQ-4) | BLOCKED-on-env (OpenSSL/arch); direction = self-host | Spec self-host default + operator unblock; round-trip unproven. |
| OQ-8 cost attribution (OpenRouter `/generation` shape, Pi generation-id) | UNVERIFIED | Launcher emits `cost_events`; fallback = `heartbeat_runs.usageJson` *estimated*. |
| Seeds/Mulch | PRIVATE CLIs (npm `sd`/`mulch` unrelated) — pin 0.2.5 / 0.6.3 | Never `npm install`; reference `/usr/local/bin/{sd,mulch}`. |
| `pi-team-launch.sh` | does not exist — Phase-0 item 3 deliverable (spec) | All §4.6 details are spec, not observed. |
| pin `pi@0.55.0` | RESOLVED | Re-smoke-test before any pi ≥ 0.73. |
