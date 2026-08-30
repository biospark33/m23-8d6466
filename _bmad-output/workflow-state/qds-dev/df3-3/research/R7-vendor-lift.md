# R7 — Vendor-code lift scan (PONYTAIL: maximize copying, minimize new code)

Story: DF3.3 Resident Orchestrator Agent. Scanned: `cli-anything/` (full src/ + scripts + tests),
`pi-vs-claude-code-vendor/`, and the existing `src/` consumers. All line numbers verified 2026-08-27.

---

## 0. Import mechanics (how src/ talks to cli-anything today)

`cli-anything/package.json` is `private` with **no `exports` and no `main`** — there is no
package-root import. The house pattern (15+ precedents) is a **direct relative path with explicit
`.ts` extension**:

- `src/phase-engine/types.ts:14` — `import type { ExitStatus } from "../../cli-anything/src/types.ts"`
- `src/phase-engine/phases/dispatch-task.ts:33-36` — merger.ts, redact.ts, runner.ts, types.ts
- `src/fleet/dispatch.ts:31`, `src/pr/body.ts:14`, `src/reverify/report.ts:19-21`, etc.

Importing from `cli-anything/scripts/` has no src/ precedent yet but is mechanically identical
(Bun resolves `.ts`); `scripts/team-lead-driver.ts:824` guards its `main()` with
`if (import.meta.main)`, so importing it is side-effect-safe — that guard exists precisely so
"the harvest seam above can be imported by tests without the driver spawning subprocesses".

**Module boundary (story line 147-149, R3 §9.2):** resident agent = `src/fleet/resident.ts`
(fleet code, may import pi/driver helpers); solicitation port = `src/phase-engine/steering.ts`
(engine code). Fleet imports the engine barrel, **never the reverse** — so `steering.ts` defines
an injectable port and `pipeline-run.ts`/resident wiring injects the fleet implementation.
Consequence: `harvestPiStream` + `runWorkerPi`-shaped spawn code lives in `resident.ts`;
`steering.ts` holds only schema + parse + degrade + metering.

---

## 1. IMPORT — story-forbidden re-declarations (must import, never copy)

| What | Where | House precedent |
|---|---|---|
| `EXIT_STATUSES` / `ExitStatus` (CC-1 5-value enum; array is source, union derives) | `cli-anything/src/types.ts:99-108` (story cites the :94-185 block) | `src/phase-engine/types.ts:14` (type), `src/reverify/report.ts:21` + `src/phase-engine/phases/team-event-adapter.ts:13` (array — iterate to stay in sync) |
| `redactSecrets(text, parentEnv)` | `cli-anything/src/redact.ts:62` | `src/phase-engine/phase.ts:22`, `gates/library.ts:18`, `dispatch-task.ts:34` |
| Brief schema | `src/fleet/brief-schema.ts:289-429` (`BriefSchema`/`Brief`) | consumed, never re-declared (story line 133-135) |
| Rates | `src/phase-engine/roster/validate.ts:471` `resolveRate(slug)`, `:434` `loadRateSources()`, `:448` `resetRateSources()` | docstrings **name DF3.3**: validate.ts:60-65 "sole rate source for … DF3.3's resident accounting"; :448-453 explains `resetRateSources` exists for DF3.3's resident. µ$ projection formula at :64-65: `micros = tokens * ratePerMTok / 1_000_000` |

Redaction binding pattern to copy (6 lines): `src/phase-engine/phases/dispatch-task.ts:120-126`
builds `secretEnv` from `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` (name-only, empty values don't
count) and binds `const redact = (s) => redactSecrets(s, secretEnv)`. Redact-then-truncate order
rule: `src/phase-engine/envelopes/adapter.ts:43-46` ("redaction runs BEFORE truncation so a token
split by the cut can never leak a partial"). Boundary-cut guard if a reply is capped mid-secret:
`redactBoundaryPrefix` (`cli-anything/src/redact.ts:128`) + `capExcerpt` (`:37`).

---

## 2. COPY — the single-call primitive (the heart of the lift)

The prompt's cross-reference target `src/fleet/team-lead-driver.ts` **does not exist**. The DF1.6
driver is `cli-anything/scripts/team-lead-driver.ts` (824 lines), reached from src/ indirectly:
`dispatch-task.ts:35` → `runTeamManifest` (`cli-anything/src/runner.ts:642`) → `buildTeamSpawn`
(`cli-anything/src/team-events.ts:36-48`, `QDS_TEAM_RUNNER=local` → `bun …/team-lead-driver.ts`).

**Verdict for a single cheap-model resident solicited synchronously 3×/run:** do NOT route through
`runTeamManifest` — that path buys the NDJSON team-event protocol, budget/coms guards, worker await
slots, and merged-output invariants (~1400 lines of wrong-shape machinery). Copy the driver's
*inner* primitive instead:

### 2a. `runWorkerPi` — `cli-anything/scripts/team-lead-driver.ts:542-659` — COPY, adapted
Exactly the "one synchronous pi call with timeout" the story needs: `spawn("pi", argv,
{stdio:["ignore","pipe","pipe"], env})`, StringDecoder chunk-safe stdout/stderr, single
`setTimeout` → SIGKILL, `error` handler resolves gracefully (spawn failure ≠ crash), `close`
flushes decoder and harvests. Adaptations for `resident.ts`:
- **Session**: driver uses `--no-session` (`:386`). The story's retry point "re-enters the same
  session" → pass `--session-id <id>` create-or-continue instead. The flag is real: fixtures
  `cli-anything/test/fixtures/pi-session-resume-a.ndjson` / `-b.ndjson` exercise it, and
  `harvestPiStream`'s docstring (`:168-177`) defines the resumed-session cost accounting ("TWO
  cost events, each complete for its own invocation; the run's true total is their SUM").
  Engine-side id minting/cache: reuse `SessionCache` (`src/phase-engine/agents/session.ts:35`),
  keyed on the exact `(agentId, provider, model)` triple — its docstring is exactly the
  "same session on retry, fresh on any model change" rule.
- **Timeout**: 60,000 ms per call (story) — parameter, driver default is 240 s.
- **maxOutputTokens 1,024**: **OPEN ITEM** — no in-tree precedent for a pi output-token flag
  (`grep maxOutputTokens|--max` in driver: nothing). Verify `pi --help` (0.55.x) before wiring;
  if absent, degrade to a prompt-side instruction and record the deviation.
- Argv base: `buildWorkerArgv` (`:378-396`, exported) shows the canonical order
  (`--provider p --model m --mode json … -p <prompt last>`). Call it or inline the same shape;
  do NOT reuse `SCHEMA_INSTRUCTION` (`:366-367`) — it is worker-shaped (`changedFiles`); the
  resident's own directive instruction is ~3 new lines.

### 2b. `harvestPiStream` — `team-lead-driver.ts:270-364` — IMPORT (already exported)
Parses pi `--mode json` NDJSON → assistant text + per-invocation totals (`inputTokens`,
`outputTokens`, `cacheRead/WriteTokens`, `turnCount`, `unpricedTurns`, `costUsd`). Battle-tested
(`test/team-lead-driver.test.ts`, `test/team-events.test.ts:258-259`). Use its **token counts**
× `resolveRate` → integer µ$ (DD-9); ignore its `costUsd` USD float (usage.ts:14-19 forbids USD
floats inside phase-engine). Handles: terminal-only accumulation (`message_end` only, INV-COST-3),
truncated-stream unpriced accounting, toolResult exclusion.

### 2c. JSON-of-model-reply parse — use the HOUSE one, not the vendor's
Vendor `extractJsonObject` (`team-lead-driver.ts:120-166`, **not exported**) takes the LAST
balanced object. House equivalent `extractJsonCandidate`
(`src/phase-engine/agents/envelope-parse.ts:92-99`, exported) prefers a fenced block, else first
balanced object — and `steering.ts` is engine code, so this import stays in-tree. Feed the
candidate to a new `SteeringDirectiveSchema.safeParse`; the sanitized-issue pattern
(`safeIssueLine`, `envelope-parse.ts:120-145`; never echo model text into prompts, INV-2) is the
model for the `residentTripwire` `gate_bypass_attempt` detail field (story AC2 requires recording
the rejected action name — that name is model-authored, sanitize it:
`sanitizeForMessage`, `src/phase-engine/types.ts:77`).

### 2d. Prompt cap 16,000 chars incl. suffix — copy the rule form
`merger.ts:218-245` `truncateWithSuffix` is the exact "reserve suffix width before cutting"
rule (surrogate-safe, `[truncated, N chars total]` suffix) but is **private**. DF1.2's exported
`truncateTail` (`envelopes/adapter.ts:28`) keeps the TAIL — wrong direction for a prompt head.
Recommendation: copy the ~15-line head-truncator into `steering.ts` citing merger.ts as source
 keeps Files-to-Modify scope; the 1-word alternative (add `export` in merger.ts) touches a
file outside the story's list. `TRUNCATION_SUFFIX`/`MAX_SUFFIX_LENGTH` ARE exported
(`merger.ts:205,212`) — import those rather than restating the suffix format.

### 2e. Smaller lifts
- Exit-status mapping table shape: `cli-anything/src/index.ts:33-39` (`TEAM_EXIT_CODES`) if the
  resident's process-exit → `exitStatus` mapping needs one (only 5 rows).
- Injection seam for tests: `_injectRunner`/`_resetRunner`
  (`dispatch-task.ts:67-74`) is the house pattern for swapping the real spawn for a scripted
  fake — mirror it in `resident.ts` for `tests/phase-engine/fixtures/fake-resident.ts`
  (fixture-script precedent: `tests/phase-engine/fixtures/test-command-output.ts`).
- Prompt persistence pre-execution through the tracer: `dispatch-task.ts:222-235` (per-role
  `type:"prompt"` trace rows, redacted, before the spawn). Same shape for each solicitation's
  rendered prompt + raw reply (story Observability Contract).

---

## 3. pi-vs-claude-code-vendor — determination: NOT for the resident

- **What it is** (`package.json`): "Vendored Pi coms extensions (coms.ts + coms-net.ts) … Loaded
  via `pi -e ./coms.ts`; not a published package." Two transports (Unix-socket IPC / HTTP-SSE
  hub) of an **agent-to-agent messaging extension** — `coms_get`/`coms_await` tools, prompt
  envelopes, peer registries. `coms-core.ts` is the LOCAL shared layer (pure helpers, caps,
  `sanitizePeerText`, `isSafePathComponent`); `themeMap.ts` is TUI theming.
- **Should the resident use it? NO.** coms is precisely an agent-initiated channel — INV-RES-1
  (story line 223-227) forbids any design where the agent calls out ("a tool surface … a
  writable control file"), and the resident's only egress is one validated directive returned
  from an engine-initiated synchronous call. coms would also add a second transport to maintain
  for 3 calls/run. Its only DF3.3 relevance is transitive: `coms-core.ts` helpers already lift
  into our tree via `cli-anything/src/types.ts:2` and `merger.ts:1-4`.
- Possibly relevant to **DF3.4** (`fleet attach` inbox drain), not this story.
- **DIVERGENCE.md rules** (maintainer constraints): vendored files sync by 3-way merge against
  upstream `0ed11f44`; any local edit needs a ledger row; `coms-core.ts` is local (no upstream).
  Net: do not touch this directory for DF3.3.

---

## 4. Must be written NEW (no vendor source exists)

1. `SteeringDirective` closed `.strict()` zod union — 4 actions + optional `note` (story lines
   127-130). Model: `EnvelopeSchema` + `parseEnvelope` (`envelope-parse.ts:34-47,147-181`),
   including the compile-time mirror-assertion trick if a TS twin is declared. This is the
   story's one new contract.
2. `src/phase-engine/steering.ts` — the port: three solicitation points, prompt render + 16k cap,
   parse, two-malformed degrade (AC3), tripwire rows (AC2), sub-timings
   (`prompt_render_ms`/`agent_call_ms`/`directive_parse_ms`), µ$ metering via `resolveRate`
   (`micros = tokens * ratePerMTok / 1e6`). Pure engine code; the pi call is injected.
3. `src/fleet/resident.ts` — `startResident(brief, roster)`: roster-driven spawn config,
   empty-brief → `status:"disabled"` never-spawn path (AC4), session handling, `runWorkerPi`
   copy, `harvestPiStream` import, spend accumulation into `spendMicros`.
4. `scripts/pipeline-run.ts` — `--no-resident` flag + resident spawn/telemetry hooks around the
   existing `walkPhases` call (line ~971); `resident.*` journal block.
5. Tests + fixtures (`resident.test.ts`, `steering.test.ts`, `fake-resident.ts`,
   `pipeline.resident.json`).

## 5. Lift plan summary

- **Import as-is**: `ExitStatus`/`EXIT_STATUSES`, `redactSecrets` (+`redactBoundaryPrefix`/
  `capExcerpt` if capping replies), `harvestPiStream`, `SessionCache`, `extractJsonCandidate`,
  `sanitizeForMessage`, `BriefSchema`, `resolveRate`/`loadRateSources`/`resetRateSources`,
  `TRUNCATION_SUFFIX`/`MAX_SUFFIX_LENGTH`.
- **Copy adapted**: `runWorkerPi` (session-id instead of --no-session; 60 s timeout;
  maxOutputTokens flag TBD), head-truncate-with-suffix (~15 lines from merger.ts rule form),
  redaction binding (6 lines from dispatch-task.ts:120-126), `_injectRunner` test seam pattern.
- **New**: `SteeringDirective` schema, `steering.ts` port, `resident.ts` shell + wiring,
  pipeline-run hooks, tests/fixtures. Everything else in the story (points, degrade, telemetry)
  is orchestration around the above, not library code.

**Open item (one):** pi 0.55.x flag name for `maxOutputTokens` 1,024 — verify via `pi --help`
before wiring; no in-tree precedent.
