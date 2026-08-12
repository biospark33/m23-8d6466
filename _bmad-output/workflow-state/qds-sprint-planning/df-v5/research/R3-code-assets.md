# R3 — Code Asset & Integration-Seam Map (Dark Factory v5 story derivation)

**Agent:** Research Agent 3 · **Date:** 2026-08-11 · **Branch:** `docs/dark-factory-v5-design`
**Purpose:** precise file paths, exported interfaces, and integration seams for the `## Files to Modify`
sections and Technical Notes of the new DF stories. All paths **repository-relative**
(local checkout root at time of writing: `<workspace>` = `/Users/steve/QDS-Factory`, labeled
local-only provenance). All line numbers verified against working tree at time of writing.

---

## 0. Headline findings (read these first)

1. **All three cited line numbers are ACCURATE.** `runner.ts:554` (QDS_TEAM_RUNNER ternary),
   `team-events.ts:36` (`buildTeamSpawn`), `coms.ts:14-15` (misattributed vendor header) all verified
   verbatim. See §1.2, §1.3, §3.1.
2. **The "step output schema" in design doc §5.2 does not exist in code.** §5.2 says
   *"Step output schema: exitStatus enum (CC-1), `changedFiles`, `testResults`, `durationMs`,
   `mulchPrimed`/`mulchPrimeError`, artifacts — as hardened in P1.6."* The **only** shipped schema is
   `MergedOutput` (`cli-anything/src/types.ts:131-141`), which has `exitStatus`, `changedFiles`,
   `durationMs` — and **no** `testResults`, **no** `mulchPrimed`/`mulchPrimeError`, **no** `artifacts[]`,
   **no** `summary`, **no** `testsExecuted`, **no** `exitCode`/`partialOutput`. Repo-wide grep for
   `testResults` in `*.ts` returns **zero hits**; `mulchPrim*` appears **only** in
   `_bmad-output/sprint-artifacts/**` story prose (P1.6, P1.12) — never in source. P1.6 was specified
   and adversarially reviewed but **never implemented**. Treat the fuller schema as a **DF build item
   with a written spec available**, not as a KEEP asset. (§1.5)
3. **Zero sandbox/provider/exe.dev code exists.** Confirmed absent: no `*sandbox*`, `*provider*`,
   `*factory*`, `*fleet*` directory anywhere outside `node_modules`; grep for
   `exe.dev|exedev|E2B|Daytona|firecracker|microvm` across all `*.ts` returns **zero hits**. The word
   "provider" in source refers exclusively to *LLM* providers (the `provider/model` role split).
   DF2/DF3 are **greenfield**. (§7)
4. **Layout convention (for new modules):** root `src/` holds **flat, one-level capability domains** —
   `src/gate/`, `src/hindsight/`, `src/swarmclaw/` — each with an optional `index.ts` barrel, mirrored
   1:1 by `tests/<domain>/`. `cli-anything/` and `pi-vs-claude-code-vendor/` are **bun workspaces**
   (`package.json:workspaces`) with colocated `test/`. **Recommendation: DF2/DF3 host-side code goes in
   new flat domains under root `src/` — `src/phase-engine/`, `src/providers/`, `src/fleet/` — with
   tests at `tests/phase-engine/` etc. Do NOT nest under `cli-anything/src/factory/`:** cli-anything is
   the tier-3 harness workspace and its own `package.json` scopes it to the team-run harness. (§9)
5. **The `runWorkerPi` usage bug is a plain assignment, in two call sites' worth of one function.**
   `cli-anything/scripts/team-lead-driver.ts:231, 233, 237, 238` use `=` not `+=` inside a
   per-NDJSON-line loop, so a multi-turn pi run reports **only the final turn's** tokens and cost.
   No cache-token fields are parsed at all; no turn counter exists. (§2.3)

---

## 1. `cli-anything/` — tier-3 harness core (KEEP, design §7)

### 1.1 Structure & scale

Bun workspace, `type: module`, deps `yaml@^2.9.0` + `zod@^3.24.0`. Binary entry
`cli-anything/src/index.ts`.

| Path | Lines | Role |
|---|---|---|
| `cli-anything/src/index.ts` | 9218 B | CLI entry: `main(argv)`, `exitCodeFor(result)` |
| `cli-anything/src/runner.ts` | 36015 B | Single-command + team run engines; **all launcher guards** |
| `cli-anything/src/team-events.ts` | 162 | Wire layer: spawn build, NDJSON parse, atomic artifact write |
| `cli-anything/src/merger.ts` | ~215 | Worker validation, changedFiles union, merged-output construction |
| `cli-anything/src/types.ts` | 179 | **All schemas + the MergedOutput contract** |
| `cli-anything/src/redact.ts` | ~140 | Secret redaction (F6-proven) |
| `cli-anything/src/env.ts` | ~100 | `cleanEnv` / `mergeEnv` / `diag` / key-name logging |
| `cli-anything/src/manifest.ts` | ~70 | YAML parse + `manifestKind()` single-vs-team discriminator |
| `cli-anything/src/coms-log.ts` | ~90 | `ComsLogCollector`, wire-entry parse, 1000-entry cap |
| `cli-anything/scripts/team-lead-driver.ts` | 409 | **PROMOTE** — the local pi lead+workers runtime |
| `cli-anything/manifests/research-trio.yaml` | — | The only manifest; `npm run smoke:team` target |
| `cli-anything/test/*.test.ts` | 9 files | **150 test cases** (matches design §7's "150 tests") |

Test counts per file: `runner.test.ts` 46, `index.test.ts` 25, `merger.test.ts` 22,
`runner-integration.test.ts` 17, `redact.test.ts` 13, `manifest.test.ts` 10, `e2e.test.ts` 7,
`coms-log.test.ts` 6, `team-events.test.ts` 4.

### 1.2 The runner seam (DF1/DF3's primary insertion point) — VERIFIED

`cli-anything/src/runner.ts:554`:

```ts
const runner = env.QDS_TEAM_RUNNER === "local" ? "local" : "warren";
const { file, argv } = buildTeamSpawn(manifest, runner);
```

This two-line ternary **is** the entire runtime-selection surface. Adding a third runtime means
widening this ternary and `buildTeamSpawn`'s union type — nothing else in `runTeamManifest` knows
which runtime produced the stream. Design §5.2's claim that "any future runtime plugs in here" is
**accurate and cheap to act on**.

### 1.3 `buildTeamSpawn` — VERIFIED at `team-events.ts:36`

```ts
export function buildTeamSpawn(
  manifest: TeamManifest,
  runner: "warren" | "local" = "warren",
): { file: string; argv: string[] }
```

- `runner === "local"` → `{ file: "bun", argv: [<pkg>/scripts/team-lead-driver.ts] }` (line 43-48),
  path built with `join(import.meta.dir, "..", "scripts", "team-lead-driver.ts")`.
- `runner === "warren"` → `warren run pi <project> -p <prompt> --provider P --model M --trigger cli-anything`
  (lines 49-65).
- Companion export `splitRoleModel(roleModel)` at `team-events.ts:12` splits on the **first** `/`
  (CC-2 amended), with a defensive `idx === -1` branch returning `{provider: "", model: raw}`.

### 1.4 The NDJSON contract — `parseTeamEventLine`

Defined `cli-anything/src/team-events.ts:77`. Event union `TeamEvent` at `team-events.ts:69-74`:

```ts
export type TeamEvent =
  | { kind: "cost";             event: CostEvent }
  | { kind: "coms";             raw: unknown }
  | { kind: "worker_output";    agentId: string; output: unknown }
  | { kind: "merged";           result: Record<string, unknown> }
  | { kind: "coms_init_error";  reason: string };
```

Parser discipline worth citing in Technical Notes:
- Non-`{`-prefixed and unparseable lines → `null` (not an error). `team-events.ts:78-86`.
- `cost` rejects non-finite / negative `costUsd` → `null`. Other numeric fields default to 0,
  strings to `"unknown"`. `team-events.ts:89-106`.
- `merged` **rejects** a non-object / array / null `result` → `null`, so a garbled lead cannot report
  success with an empty `{}` result; `mergedResult` stays null and the run classifies `lead_failure`.
  `team-events.ts:113-123` (the comment there explains the historical bug).
- Third export: `writeArtifactAtomic(dir, name, data)` at `team-events.ts:138` — tmp+rename atomic
  write, guarded by `SAFE_ARTIFACT_NAME_RE = /^[\w.-]+$/` (line 135), cleans up tmp on failure.

### 1.5 The step-output schema — what actually exists

**Shipped** (`cli-anything/src/types.ts`):

| Symbol | Line | Notes |
|---|---|---|
| `ManifestSchema` / `Manifest` | 14 / 23 | Flat single-command manifest, `.strict()` |
| `TeamRoleSchema` | 33 | `agentId` refined by `isSafePathComponent`; `model` must contain a non-terminal `/` |
| `TeamManifestSchema` / `TeamManifest` | 52 / 75 | Team block; workers `.min(1).max(3)` |
| `ExitStatus` (5-value enum, CC-1) | **79-84** | `success \| transient \| overflow \| logic \| lead_failure` |
| `Waiver` | 87 | `budget_override \| model_fallback`, audit-only in Phase 0 |
| `ComsLogEntry` | 94 | camelCase at harness boundary (CC-9) |
| `CostEvent` | 108 | `agentId, model, inputTokens, outputTokens, costUsd, durationMs, timestamp` |
| `MergedError` | 119 | `reason` (4-value, excludes `success`), `message`, optional `details` |
| **`MergedOutput`** | **131-141** | `result, changedFiles, partial, exitStatus, durationMs, waivers, agentOutputs, comsLog, error` |
| `WorkerOutput` | 144 | `agentId, changedFiles (mandatory), result` |
| `ExitClass` / `HarnessResult` | 151 / 161 | Single-command path only |

Team manifest defaults (`types.ts:62-68`): `budgetCapUsd` 0.5 (max 10), `turnCap` 5 (max 50),
`wallClockCapMs` 300_000 (max 3_600_000), `comsAwaitTimeoutMs` 240_000 (max 1_800_000).

**Specified but NOT implemented** — the P1.6 story text is the best available spec for the DF story
that adds these. Source: `_bmad-output/sprint-artifacts/phase-1/stories/p1-6-pi-team-protocol-step.md`
(AC1 line 32, AC3 line 34, Contracts/Schema line 62, pi-lens validation rules line 66, Hindsight-
unreachable behavior line 87). Missing fields: `testResults{passed,failed,coverage?}`,
`testsExecuted?`, `summary`, `mulchPrimed`, `mulchPrimeError?`, `artifacts[]{name,path}`, and on the
failure branch `error: string`, `exitCode: number|null`, `partialOutput: string|null`.
`_bmad-output/sprint-artifacts/phase-1/stories/p1-12-mulch-prime-record.md:31` pins `mulchPrimed`
as a cross-story contract with P1.6.

### 1.6 Launcher guards (INV-2) — all in `runner.ts`

| Guard | Line | Detail |
|---|---|---|
| `BUDGET_KILL_FRACTION` | **463** | `0.9` — kill threshold is 90% of cap |
| `MAX_TEAM_STDOUT_BYTES` | **472** | 1 MiB per-line cap (F15 OOM fix); oversize lines dropped |
| `TeamRunOptions` | **474-489** | env, comsAwaitTimeoutMs, wallClockCapMs, budgetCapUsd, teamStdoutCapBytes, graceMs, artifactsDir |
| `runTeamManifest` | **502** | The team engine |
| `budgetCapUsd` / `killThresholdUsd` resolve | **514-515** | opts → manifest fallback |
| `wallClockCapMs` resolve | **516** | opts → manifest fallback |
| `graceMs` | 519-525 | opts → `QDS_TEAM_GRACE_MS` (bounded 0..60_000) → `WATCHDOG_GRACE_MS` (5000, line 77) |
| `artifactsDir` | 526 | default `<cwd>/artifacts` |
| `QDS_AGENT_TEAM_CONFIG_JSON` materialization | **533-545** | lead+workers with `splitRoleModel` applied, plus `turnCap` |
| `PI_COMS_TIMEOUT_MS` export | 546 | driver reads this |
| Provider-key presence logging (INV-1, names only) | 548-551 | `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` |
| Wall-clock arm | **675-683** | → `overflow` with `wall-clock cap N ms exceeded` |
| Budget kill arm | **707**, 870-871 | → message names both threshold and cap |
| Artifact write on lead_failure | **929-939** | `mkdirSync` + `writeArtifactAtomic(dir, agentId, redactDeep(raw, redact))` |
| `killTree` | 85 | Process-tree kill |
| `DEFAULT_TIMEOUT_MS` | 72 | 10 min (single-command path) |

Settle machinery: `settle()` at line 588 is the single funnel — clears timers, removes signal
handlers, validates each worker output, unions `changedFiles` **only** for `success`/`transient`
(line 607-610), and calls `buildMergedOutput`. Per-worker single-settle await slots via
`createPending` at lines 572-578 (P0.3-S-H5).

### 1.7 `merger.ts` — output construction

- `MAX_CHANGED_FILES_BYTES` (18) = 32 KiB.
- `validateWorkerOutput(agentId, raw): WorkerValidation` (46) — `changedFiles` **mandatory**; each
  entry must be a relative path whose every `/`-component passes coms-core's `isSafePathComponent`
  (`isSafeRelativePath`, line ~36); entries sanitized via `sanitizePeerText`.
- `unionChangedFiles(lists)` (100), `createPending<T>()` (130), `redactDeep(value, redact)` (151).
- `buildMergedOutput(opts: BuildMergedOutputOptions)` (187) — **enforces P0.3-M2 uniformity at the
  construction site**: success must carry `error:null` and `partial:false` (throws otherwise);
  non-success must carry `error{reason,message}` (throws otherwise); `lead_failure` forces
  `agentOutputs = {}` and `changedFiles = []`; redaction applied deep to
  result/agentOutputs/comsLog/error. **Any DF story extending the step output must extend
  `BuildMergedOutputOptions` (164) and this function, not just the `MergedOutput` type** — the
  invariants live here.

### 1.8 `redact.ts` — the F6-proven module (KEEP verbatim)

`cli-anything/src/redact.ts`, 13 tests in `cli-anything/test/redact.test.ts`.

| Export | Line | Value / signature |
|---|---|---|
| `MAX_STDOUT_EXCERPT` | 12 | 256 KiB |
| `MAX_PROBE_RESULT_LEN` | 15 | 1024 |
| `SECRET_KEY_RE` | 23 | key-name heuristic |
| `MIN_REDACTABLE_VALUE_LEN` | 27 | 8 — shorter values ignored (false-positive guard) |
| `MIN_BOUNDARY_PREFIX_LEN` | 30 | = 8 |
| `capExcerpt(text)` | 37 | |
| `capProbe(value)` | 45 | |
| `redactSecrets(text, parentEnv)` | 62 | the main entry; runner binds it as `redact` at `runner.ts:553` |
| `redactBoundaryPrefix(text, parentEnv)` | 128 | handles a secret bisected by the truncation cut |

---

## 2. `cli-anything/scripts/team-lead-driver.ts` — PROMOTE to canonical team runtime

409 lines. Header comment (lines 2-22) documents the 6-step protocol and the `QDS_TEAM_RUNNER=local`
selection.

### 2.1 CLI surface — there is none

**The driver takes no argv.** `main()` (256) reads everything from env:

| Env var | Line | Semantics |
|---|---|---|
| `QDS_AGENT_TEAM_CONFIG_JSON` | 257 | `{lead?: WorkerConfig, workers: WorkerConfig[], turnCap}`. Missing → `exit 64`; unparseable → `exit 64`; `workers.length === 0` → `exit 64` |
| `PI_COMS_TIMEOUT_MS` | 286-292 | Bounded-int parse: integer in `[1, 2_147_483_647]` else fall back to 240_000. The comment (280-285) documents why bare `Number()` is a footgun (NaN→~0ms, >2^31 →1ms — both instant-kill) |

`WorkerConfig` (26-31): `{agentId, provider, model, prompt}`. **Any DF story adding a driver flag is
introducing the first one** — note this in Technical Notes so writers don't assume an existing parser.
(Repo does have a shared flag grammar available for reuse: `scripts/lib/cli-args.ts`
`parseValueFlags`, 83 lines, 23 tests.)

### 2.2 Spawn shape

`runWorkerPi(w, timeoutMs)` (124) spawns:

```
pi --provider <P> --model <M> --mode json --no-session -p "<prompt>\n\n<schemaInstruction>"
```
with `{ stdio: ["ignore","pipe","pipe"], env: process.env }` (142). `schemaInstruction` (127-128)
demands `{"changedFiles": string[], "result": {"summary": string}}` and marks `changedFiles`
mandatory. Hardening already present: `StringDecoder` for multi-byte chunk boundaries (146-147),
`settled` single-settle flag, `child.on("error")` handler resolving gracefully so one broken worker
degrades to partial rather than killing the lead (163-176), SIGKILL timer (157-159).

`main()` fans out workers with `Promise.all` (296-334): per worker emits `coms` send → runs pi →
emits `cost` → emits `coms` receive → validates → emits `worker_output`. Then an optional **real
lead merge LLM turn** (352-388) on the lead's own provider/model, with mechanical-concat fallback if
the lead call fails. Finally emits `merged` (393-404) and `process.exit(0)`.

`extractJsonObject(text)` (66) — fenced-block candidates plus a **string-aware balanced-brace scan**
(74-100), candidates tried in reverse (last-wins). Worth reusing rather than reimplementing.

### 2.3 The final-turn-only usage overwrite — EXACT LOCATION

Inside `runWorkerPi`'s `child.on("close")` handler, the NDJSON harvest loop (188-240) walks **every**
event line. The usage block:

```ts
// team-lead-driver.ts:227-239
if (usage != null && typeof usage === "object") {
  const cost = usage.cost;
  if (typeof cost === "object" && cost !== null) {
    const total = (cost as Record<string, unknown>).total;
    if (typeof total === "number" && Number.isFinite(total)) costUsd = total;   // :231  ASSIGN
  } else if (typeof cost === "number" && Number.isFinite(cost)) {
    costUsd = cost;                                                             // :233  ASSIGN
  }
  const inTok  = usage.input  ?? usage.inputTokens;
  const outTok = usage.output ?? usage.outputTokens;
  if (typeof inTok  === "number") inputTokens  = inTok;                         // :237  ASSIGN
  if (typeof outTok === "number") outputTokens = outTok;                        // :238  ASSIGN
}
```

Every line in the stream **overwrites** the accumulator. For a multi-turn pi run the harvested
`costUsd`/`inputTokens`/`outputTokens` are the **last** event's values, not the run total. Note the
`text` variable has the same shape at line 220 (`if (blockTexts.length > 0) text = blockTexts.join()`)
— last-message-wins is *intended* there, but not for usage.

**What an "accumulate usage across turns, emit cacheRead/cacheWrite/turn-count" story touches:**

| Change | Site |
|---|---|
| Accumulate instead of assign | `team-lead-driver.ts:231, 233, 237, 238` (`=` → `+=`), plus decide whether `usage.cost.total` is per-turn or cumulative in pi's own stream — **this must be established empirically against pi 0.55.0, not assumed**; if pi emits a running total, `+=` double-counts and the fix is a max/last-wins on cost with `+=` on tokens |
| Parse cache tokens | New reads in the same block (~line 235). pi/Anthropic field names (`cache_read_input_tokens`, `cache_creation_input_tokens` or camelCase variants) need verification against a live `pi --mode json` stream |
| Turn counter | New counter in the loop (188-240); increment per usage-bearing event |
| Widen the outcome type | `PiRunOutcome` interface at **114-121** — add `cacheReadTokens`, `cacheWriteTokens`, `turnCount` |
| Emit on the wire | The **two** `say({type:"cost", ...})` sites: worker at **301-310**, lead at **363-372** |
| Widen the wire contract | `CostEvent` at `cli-anything/src/types.ts:108-116` |
| Widen the parser | `parseTeamEventLine` `case "cost"` at `cli-anything/src/team-events.ts:89-106` — note it currently defaults unknown numerics to 0, so new fields need the same defaulting discipline |
| Tests | `cli-anything/test/team-events.test.ts` (4 tests, the cost-parse home) and `cli-anything/test/runner.test.ts` (46) for the budget-accumulation path |

Budget consumer to keep consistent: `cumulativeCostUsd` in `runner.ts` (declared line 563, compared
against `killThresholdUsd` from line 515). Changing cost semantics changes when the budget guard fires.

---

## 3. `pi-vs-claude-code-vendor/` — vendored coms substrate (KEEP)

### 3.1 Files present (all 7 confirmed)

| File | Size | Nature |
|---|---|---|
| `coms.ts` | 115,934 B | Vendored — Unix-socket IPC transport |
| `coms-net.ts` | 147,072 B | Vendored — HTTP/SSE hub transport |
| `themeMap.ts` | 9,605 B | Vendored — local import of both transports |
| `coms-core.ts` | 12,001 B | **LOCAL extraction, NOT vendored** — no upstream counterpart |
| `DIVERGENCE.md` | 13,342 B | Divergence ledger + maintainer rules |
| `LICENSE` | 1,514 B | Upstream MIT (IndyDevDan) |
| `package.json` | 1,553 B | Provenance block + peer/dev deps |

### 3.2 Pinned versions

From `pi-vs-claude-code-vendor/package.json`:
- `_provenance.source_repo`: `https://github.com/disler/pi-vs-claude-code`, `source_path` `extensions/`
- `_provenance.commit`: **`0ed11f44932fdef29bd98467700019762298f50d`**, dated `2026-07-10T16:09:59Z`,
  vendored `2026-07-10`
- `vendored_files`: `["coms.ts", "coms-net.ts", "themeMap.ts"]` — **`coms-core.ts` deliberately excluded**
  so a re-vendor 3-way merge never overwrites it
- `peerDependencies` / `devDependencies`: `@mariozechner/pi-coding-agent`: **`0.55.0`** (exact pin, both)

External imports supplied by the pi runtime at load: `@mariozechner/pi-coding-agent`,
`@mariozechner/pi-tui`, `@sinclair/typebox`. **This is the F13 licensing surface** — design §8 step 2
gates the OCI image contract on `@mariozechner/*` redistribution.

### 3.3 The `coms.ts:14-15` misattribution — STILL PRESENT, verified verbatim

```
14  * Vendored into QDS-Factory (pi-vs-claude-code-vendor/) from the pi-mono coms
15  * extension for the pi-vs-claude-code review harness.
```

The header credits **"the pi-mono coms extension"**; `package.json:_provenance.source_repo` says
`disler/pi-vs-claude-code`. A one-line docs fix, still open. (Two lines in a comment — zero blast
radius, but it is the provenance statement a licensing reviewer reads first, which is why F13 cares.)

### 3.4 What in-tree code depends on the vendor

- `cli-anything/src/types.ts:2` — `import { isSafePathComponent } from "../../pi-vs-claude-code-vendor/coms-core.ts"`
  (used by `TeamRoleSchema.agentId` refinement, line 38)
- `cli-anything/src/merger.ts` — `isSafePathComponent` + `sanitizePeerText` for changedFiles validation
- `scripts/lib/coms-smoke-helpers.ts` — re-exports `ulid` + `CROCKFORD` from coms-core (per DIVERGENCE
  `#59`, which removed a duplicated copy)
- Tests: `tests/vendor/coms-core.test.ts` (48 cases), `tests/vendor/coms-wire-guards.test.ts` (10 cases)

`coms-core.ts` public surface per DIVERGENCE.md: `ulid` + `CROCKFORD`, `isValidHex`, `hexFg`,
`fallbackColor` + `FALLBACK_PALETTE`, `parseFrontmatter`, `abbreviateModel`, `sanitizePeerText`,
`secretEqual`, `isSafePathComponent`, and
`envBoundedInt(env, def, { min?, max?, integer? })` — the unified bounded env-int parser.

**Maintainer rule any DF story touching these must honour** (DIVERGENCE.md "Rules for maintainers"):
upstream syncs **must** 3-way merge against `0ed11f44`, never overwrite; every new local edit gets a
DIVERGENCE row; new *shared* helper logic goes in `coms-core.ts`, transport-specific logic stays
per-file.

---

## 4. Gate chassis — the DF5 lights-on gate re-derivation base

### 4.1 `src/gate/gate-runner.ts` (335 lines) — orchestration, story-agnostic

Explicitly "knows nothing about any individual Phase-0 story" (header line 4). This is a **reusable
chassis**; DF5 supplies new assertion modules, not a new runner.

**Per-clause assertion API:**

```ts
export interface GateAssertion {          // :45
  id: string;                             // stable, printed on failure — e.g. "P0.7-mcp-bridge"
  story: string;                          // predecessor story
  prd_clause: string;                     // e.g. "§13 P0 clause 6"
  description: string;
  group: "preflight" | "main";            // preflight runs first as a barrier
  check: () => Promise<GateCheckOutcome>;
  timeout_ms?: number;                    // per-assertion budget override
  void_reason?: string;                   // presence ⇒ VOID; check never invoked
}

export interface GateCheckOutcome {       // :39
  pass: boolean;
  skip?: boolean;                         // "could not evaluate" — reported distinctly, still fails
  detail?: string;
}
```

Constants: `DEFAULT_ASSERTION_TIMEOUT_MS` 30_000 (:25), `DEFAULT_TOTAL_TIMEOUT_MS` 600_000 (:27),
`DEFAULT_CONCURRENCY` 4 (:29). `runGate(assertions, options)` at **:144**.
`RunGateOptions` (:130) = `{assertionTimeoutMs?, totalTimeoutMs?, concurrency?}`.

**Semantics DF5 stories must not silently re-litigate** (header lines 8-20, enforced in code):
- **A SKIP is not a pass** — an unproven assertion makes the gate red (:211-212).
- **A VOID clause is excluded from the verdict entirely**; `check` never runs (:167-178). VOID is for
  PRD clauses whose predecessor story was killed — recorded for traceability, not deleted.
- **A gate with no live assertions is FAIL, never a vacuous PASS** (:324-326).
- Every failure carries its own detail string; the failing assertion is named, not summarised.
- Preflight fail-fast: main-group assertions are still **listed** in the report but marked
  `skip` with `"not attempted — preflight assertion(s) did not pass (fail-fast)"` (:250-262).
- Total-budget expiry overwrites unsettled assertions as `fail` with a budget-expired detail
  (:291-301); the worker pool observes `budgetExpired` and stops claiming work (:237).
- Checks **MUST NOT block the event loop** (no `spawnSync`) or no timeout can preempt them —
  documented at :66-68. **Cite this in any DF5 story that adds a check.**

**Report JSON shape:**

```ts
export interface GateAssertionResult {    // :77
  id; story; prd_clause;
  status: "pass" | "fail" | "skip" | "void";
  pass: boolean;                          // convenience mirror of status === "pass"
  detail?: string;
  duration_ms: number;
}

export interface GateReport {             // :88
  timestamp: string;                      // ISO, from gate start
  overall: "PASS" | "FAIL";
  assertions: GateAssertionResult[];      // input order preserved despite reordered/concurrent exec
  summary: { pass: number; fail: number; skip: number; void: number };
  total_duration_ms: number;
}
```

Zod mirrors exported for validation: `GateAssertionSchema` (:96), `GateAssertionResultSchema` (:107),
`GateReportSchema` (:117).

### 4.2 `scripts/phase0-exit-gate.ts` (176 lines) — the clause-map driver

Structure a DF5 lights-on gate should mirror:
- Clause map in the header comment (lines 10-25) — one line per clause with its disposition tag
  (`STRUCTURAL` / `SCOPED` / `VOID` / plain). This is the human-readable audit trail.
- Imports all 9 assertion modules (lines 47-55), assembles via `buildAssertions()` (:90).
- `parseArgs` (:75) reuses `scripts/lib/cli-args.ts` `parseValueFlags` rather than re-rolling flag
  parsing — `--report <path>`, `--help`/`-h`.
- `render(report)` (:129) prints the per-assertion table; `main()` (:156).
- Output: human table on stdout terminated by `PHASE_0_GATE: PASS` / `PHASE_0_GATE: FAIL`;
  machine-readable `GateReport` written to `--report` path
  (default `_bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json`).
- **Exit codes: 0 = PASS, 1 = FAIL, 2 = fatal before any assertion ran.**

### 4.3 Evidence recording — `src/gate/verifier-child.ts` (162 lines)

The pattern for "assert against a verifier harness's verdict rather than re-probing":

| Export | Line |
|---|---|
| `VerifierCheck` (`{..., evidence?: Record<string, unknown>}`) | 29 (evidence at 33) |
| `VerifierVerdict` | 40 |
| `VerifierRun` | 45 |
| `runVerifier(...)` | 62 |
| `findCheck(run, ac)` | 123 |
| `verifierUnusable(run)` | 149 |

`src/gate/assertions/lib/verdict.ts` — `checkRequiredAcs(run, acs)` + `isOutcome(x)`: the shared shell
that answers "is the run usable / are the required ACs present / is each green" before clause-specific
evidence guards. Its header documents *why* it was hoisted (p0-5 and p0-6 were structurally identical
peers that drifted). **A DF5 story adding a second verifier-backed clause should extend this, not
copy a sibling module.**

### 4.4 Assertion module inventory (1,338 lines, all in `src/gate/assertions/`)

`p0-1-env.ts` 112 · `p0-2-coms.ts` 195 · `p0-3-mixed-model.ts` 134 · `p0-4-guard.ts` 126 ·
`p0-5-pi-lens.ts` 95 · `p0-6-lsp.ts` 92 · `p0-7-mcp-bridge.ts` 230 · `p0-9-memory.ts` 144 ·
`p0-10-gitnexus.ts` 210 · `lib/verdict.ts`.

`p0-3-mixed-model.ts` is the best template for DF5: it exports a pure auditor
`auditMixedModelRun(run): MixedModelAudit` separately from the check closure ("exported so the clause
contract is testable rather than buried in a check"), asserts every field with an **explicit positive
assertion** (`!== 0`, `!== false`, `!== "success"`) so a *missing* field fails rather than reading as
satisfied, and asserts against a **frozen run of record** because the live path costs real money —
"a gate must be safe to re-run", with the recording labelled as such in the detail string. Its header
also models how to record a **SPEC-VS-IMPL discrepancy** (clause 1 names `pi-team-launch.sh`, which
never existed) rather than silently reinterpreting a clause — directly relevant given finding #2.

Gate tests: `tests/gate/assertion-modules.test.ts` **104**, `tests/gate/phase0-exit-gate.test.ts`
**45**, `tests/gate/verifier-child.test.ts` **22** — 171 total.

---

## 5. SwarmClaw — host-side service chassis (KEEP)

`src/swarmclaw/`, 2,260 lines across 7 files. Hand-rolled router over `Bun.serve`.

### 5.1 The 4 routes (`src/swarmclaw/index.ts:85-97`)

| Method | Path | Handler |
|---|---|---|
| POST | `/api/agents` | `handleRegisterAgent(agentStore, body, requestId)` — `routes/agents.ts:19` |
| POST | `/api/mcp-servers` | `handleRegisterMCPServer(mcpStore, body, requestId)` — `routes/mcp-servers.ts:50` |
| POST | `/api/mcp-servers/:id/test` | `handleTestMCPServer(mcpStore, id, requestId)` — `routes/mcp-servers.ts:175` |
| POST | `/api/mcp-servers/:id/invoke` | `handleInvokeMCPServer(mcpStore, id, body, requestId)` — `routes/mcp-servers.ts:222` |

Param extraction by regex `^\/api\/mcp-servers\/([^/]+)\/(test|invoke)$` (:90, :94). Unmatched → 404
`{error: "not found"}` (:98). Uncaught throw → 500 `{error: "internal server error", requestId}` (:118).
All routes are POST — the body-cap precheck at :67 relies on that.

### 5.2 Body caps

- `MAX_BODY_BYTES = 1_048_576` (**index.ts:135**), `PAYLOAD_TOO_LARGE` sentinel error (:137).
- **Pre-buffer** `content-length` check (:67-81): over-cap → **413** `{error:"payload too large"}` with
  `connection: close`. The drain loop is itself capped at `MAX_BODY_BYTES` (:149) with a
  `// ponytail:` comment explaining the poisoning-clear rationale (:74).
- `safeJson(req)` (:164) re-checks during streaming (`received > MAX_BODY_BYTES`, :177) — belt and
  braces, because `content-length` is client-supplied.

### 5.3 Request-id middleware

`index.ts:42-58`: reads inbound `x-request-id` header, else mints one; every response carries
`"x-request-id": requestId` plus `content-type: application/json` (:53); `requestId` is threaded into
each handler call and into error bodies. `logResponse` (`routes/agents.ts:89`) and
`deriveErrorMessage(body, fallback)` (`routes/agents.ts:116`) are the shared response helpers.

### 5.4 SIGTERM discipline (`index.ts:200-229`)

Port validation first: non-integer or out of `[0, 65535]` → structured JSON error on stderr +
`exit(1)` (:200-205). Then:
- `shuttingDown` re-entrancy guard (:211-212) — SIGTERM twice does not double-shutdown.
- Structured JSON log line on stdout at shutdown start (:213).
- **Force-exit watchdog: `setTimeout(() => process.exit(1), 12_000).unref()`** (:217) — comment
  explains 12 s exceeds the worst case (5 s SIGTERM grace + SIGKILL reap + margin); a stuck shutdown
  must never hang the process.
- `await srv.stop()` → `shutdownAll` propagates SIGTERM to MCP subprocesses, waits the grace window,
  then SIGKILLs stragglers (`StdioTransport.shutdown`) (:218-220).
- `finally { process.exit(0) }`; per-transport failures swallowed because already logged (:221-225).
- **Both** `SIGTERM` and `SIGINT` bound to the same handler (:227-228).

Other exports: `SwarmClawServer` interface (:24), `createServer(port = 0)` (:31) — port 0 means
ephemeral, which is how the tests get isolation.

Supporting modules: `mcp/stdio-transport.ts` (737), `mcp/tool-bridge.ts` (500),
`store/mcp-store.ts` (161), `store/agent-store.ts` (130).

Tests (`tests/swarmclaw/`, **106 cases**): `agent-mcp-registration.test.ts` 49,
`mcp-stdio-transport.test.ts` 46, `e2e-demo.test.ts` 8, `lifecycle.test.ts` 3. Fixtures:
`fixtures/fake-mcp-server.ts`, `fixtures/fake-hindsight-mcp.ts`.

---

## 6. Hindsight client — memory layer (KEEP)

`src/hindsight/`, 2,565 lines across 6 files.

| File | Lines |
|---|---|
| `src/hindsight/client.ts` | 460 |
| `src/hindsight/schemas.ts` | 181 |
| `src/hindsight/index.ts` | 49 (barrel — **the stable contract**) |
| `src/hindsight/bank-provisioner.ts` | 563 |
| `src/hindsight/mulch-importer.ts` | 731 |
| `src/hindsight/round-trip-verifier.ts` | 581 |

**Barrel discipline** (`index.ts` header): "Downstream agents import from here. This file re-exports
the stable contract; do not re-shape without coordinating." Re-exports from `schemas.ts`:
`BankIdSchema`, `resolveBankId`, the four payload/response schema pairs
(`Retain`/`Recall`/`Reflect`/`Consolidate`), `MulchExpertiseSchema`, and five `ERR_*` constants
(`ERR_BANK_COLLISION`, `ERR_BANK_ID_INVALID`, `ERR_HINDSIGHT_UNAVAILABLE`,
`ERR_MCP_BRIDGE_NOT_REGISTERED`, `ERR_MULCH_FILE_COUNT`). From `client.ts`: `HindsightClient`,
`HindsightHttpError`, and the four timeout constants.

**Mock mode flag:** `HindsightClientOptions.mode?: "live" | "mock"` (`client.ts:104`, private field
:115), **default `'live'`**. `'mock'` short-circuits before the network at **`client.ts:321`**
(`if (this.mode === "mock") return mockBody(path, bankId)`), returning canned **schema-valid** bodies
from `mockBody(path, bankId)` (:57-63) that pass the same `requestJSON` validation as live responses.
The short-circuit sits **inside** the try so the `finally` still runs and a mock call is still traced
(:317-321).

**Timeouts** (`client.ts:43-46`): `RETAIN_TIMEOUT_MS` 30_000, `RECALL_TIMEOUT_MS` 10_000,
`REFLECT_TIMEOUT_MS` 30_000, `CONSOLIDATE_TIMEOUT_MS` 60_000.

**Mock-mode caveat a DF story must respect** (from `p1-12-mulch-prime-record.md:66`): timeout/waiver
tests must run **live** against a deterministic slow/failing transport — mock short-circuits before
`fetch`/`AbortController`, so a mock-mode timeout assertion cannot execute the path it claims to cover.

**Test count = 114** (design §7 says 113 — off by one, immaterial):
`tests/hindsight/mulch-import.test.ts` 34, `bank-provisioning.test.ts` 33, `client.test.ts` 23,
`memory-round-trip.test.ts` 19, `bridge-round-trip.test.ts` 5.
Adjacent CLI tests: `tests/provision-hindsight-banks.test.ts` 15,
`tests/import-mulch-expertise.test.ts` 8.

Env contract (from `scripts/provision-hindsight-banks.ts` header): `HINDSIGHT_BASE_URL`
(default `http://127.0.0.1:8888`), `HINDSIGHT_BEARER_TOKEN` (INV-HM1, preferred) or
`HINDSIGHT_API_KEY` (legacy fallback), `SWARMCLAW_BASE_URL` (bridge probe, default
`http://127.0.0.1:3000`).

---

## 7. exe.dev / sandbox / provider code — CONFIRMED ABSENT

Three independent checks, all negative:

1. `find . -type d \( -name '*sandbox*' -o -name '*provider*' -o -name '*factory*' -o -name '*fleet*' \)`
   excluding `node_modules`/`.git` → **no results**.
2. `grep -rln "exe\.dev|exedev|E2B|e2b|Daytona|firecracker|microvm" --include='*.ts'` → **no results**.
3. `grep -rn "provider" --include='*.ts' src/ cli-anything/src/` → 14 hits, **all** LLM-provider
   semantics (`splitRoleModel`, `--provider` flag, provider-key presence logging). Zero
   infrastructure-provider code.

**DF2 (provider layer) and DF3 (fleet dispatcher) are greenfield.** No existing interface to conform
to, no migration, no deprecation. The only existing "runtime selection" precedent in the whole repo is
the `runner.ts:554` ternary, and the design doc's own §5.1 provider-driver verb list
(`create/fill/setup/execute/observe/teardown/reap`) is the spec.

---

## 8. `scripts/` inventory — gates & verification

Root `scripts/`, 5 top-level harnesses + `lib/`.

| Script | Lines | Story | Purpose |
|---|---|---|---|
| `scripts/phase0-exit-gate.ts` | 176 | P0.11 | The gate driver (§4.2) |
| `scripts/pi-lens-verify.ts` | 646 | P0.5 | Drives `pi-lens-mcp` over stdio + reads on-disk artifacts; proves machine-readable surfaces **without a live LLM** |
| `scripts/lsp-verify.ts` | 1,418 | P0.6 | Warm per-worktree LSP diagnostics + navigation via pi-lens MCP `dist/mcp/server.js` over stdio JSON-RPC; explicitly "mirrors P0.5's discipline per the Wave 1 Reuse Mandate" |
| `scripts/coms-smoke-test.ts` | 1,425 | P0.2 | **Both** messaging substrates against pinned `pi@0.55.0`: Path A subprocess-RPC (`pi --mode json -p`, round-trip counts only from a real `agent_end` with assistant text), Path B socket-coms (both vendored extensions load) |
| `scripts/provision-hindsight-banks.ts` | 183 | P0.9 | CLI: provision 3 banks; `--repo-slug` |
| `scripts/import-mulch-expertise.ts` | 165 | P0.9 | Reads `.mulch/expertise/`, retains JSONL into `{resolveBankId(slug)}-dev-meta`; output contract `{ok:true,totalFiles,importedFiles,updatedFiles,failures,requestId}` exit 0 / `{ok:false,error:{code,message},requestId}` exit 1 |
| `scripts/install-gitnexus-plus.sh` | — | #46/#47 | **Canonical reindex** — never a bare `gitnexus analyze` (see root `CLAUDE.md`) |

**`scripts/lib/` — reusable harness pieces (822 lines). Reuse these; do not re-roll.**

| Module | Lines | Tests | What it gives you |
|---|---|---|---|
| `scripts/lib/cli-args.ts` | 83 | 23 | `parseValueFlags(argv, {flags, onValue, help})` — the repo's shared flag grammar (`--f v` / `--f=v` / `--help` / unknown-flag throws) |
| `scripts/lib/mcp-stdio-client.ts` | 242 | 25 | MCP stdio JSON-RPC client |
| `scripts/lib/pi-lens-harness.ts` | 246 | — | pi-lens install resolution + harness plumbing |
| `scripts/lib/coms-smoke-helpers.ts` | 208 | 54 | Re-exports `ulid` + `CROCKFORD` from coms-core (#59) |
| `scripts/lib/harness-notes.ts` | 43 | — | Harness note recording |

**npm scripts** (root `package.json`) — the existing verification entry points:

```
test           bun test
typecheck      bunx tsc --noEmit
lint           bunx @biomejs/biome check src scripts tests cli-anything pi-vs-claude-code-vendor
smoke:coms     bun scripts/coms-smoke-test.ts
smoke:team     QDS_TEAM_RUNNER=local bun cli-anything/src/index.ts run --manifest cli-anything/manifests/research-trio.yaml
verify:pi-lens bun scripts/pi-lens-verify.ts
verify:lsp     bun scripts/lsp-verify.ts
```

`smoke:team` is **the existing Build-Order-Step-0 command** — the DF proof story's starting point.

Other root tests: `tests/lsp-verify.test.ts` 36, `tests/scripts/coms-smoke-helpers.test.ts` 54,
`tests/scripts/mcp-stdio-client.test.ts` 25, `tests/scripts/cli-args.test.ts` 23,
`tests/oq1-evidence.test.ts` 13, `tests/gitnexus/graph-queries.test.ts` 10,
`tests/pi-lens-verify.test.ts` ~11 (integration, `test.skip()`s when no pi-lens install resolves),
`tests/scripts/install-gitnexus-embeddings.test.ts` 5.

**Root-tree total ≈ 640 test cases; `cli-anything` 150. Repo ≈ 790.**

---

## 9. Layout convention & proposed new-module paths

### 9.1 The convention, as observed

- **Root `src/` = flat, one-level capability domains.** Exactly three today: `src/gate/`,
  `src/hindsight/`, `src/swarmclaw/`. No `src/lib/`, no `src/core/`, no deeper grouping directory.
- **Sub-structure inside a domain is by role, only when it earns it**: `src/swarmclaw/{routes,store,mcp}/`,
  `src/gate/assertions/` (with `assertions/lib/` for the shared shell). `src/hindsight/` stayed flat.
- **Barrel `index.ts` where there are external consumers** (`src/hindsight/index.ts` with an explicit
  "stable contract, do not re-shape" note; `src/swarmclaw/index.ts` doubles as the server entry).
  `src/gate/` has no barrel — its consumer is a script that imports modules directly.
- **Tests mirror source 1:1 at `tests/<domain>/`**, with fixtures at `tests/<domain>/fixtures/`.
  Script tests live at `tests/scripts/` or `tests/<script-name>.test.ts`.
- **Executables live in root `scripts/`**, never in `src/`; shared script helpers in `scripts/lib/`
  with tests in `tests/scripts/`.
- **Bun workspaces for self-contained units**: `package.json:workspaces = ["pi-vs-claude-code-vendor",
  "cli-anything"]`. A workspace owns its own `src/`, `test/` (singular, colocated — note the naming
  difference from root's `tests/`), `scripts/`, and `package.json`.
- **Tooling scope is enumerated, not globbed**: the `lint` script names
  `src scripts tests cli-anything pi-vs-claude-code-vendor`. **A new top-level directory would need
  adding here** — one more reason to prefer new domains under existing `src/`.

### 9.2 Proposed paths per DF epic

| DF epic | Proposed location | Rationale |
|---|---|---|
| **DF0** proof (build order step 0) | No new module — `npm run smoke:team` + a new `tests/` or evidence file | The runtime exists; step 0 is an executable DoD, not new code |
| **DF1** TS phase engine (tier 2) | `src/phase-engine/` + `tests/phase-engine/` | New flat domain. Likely sub-roles: `phases/`, `gates/`, `envelopes/`, `trace/` — mirroring `src/swarmclaw/{routes,store,mcp}/`. Add `index.ts` barrel (multiple consumers: resident agent, fleet harvest) |
| **DF2** provider seam + exe.dev driver + credential lifecycle | `src/providers/` + `tests/providers/` | New flat domain. `src/providers/index.ts` exports the driver interface (`create/fill/setup/execute/observe/teardown/reap`); `src/providers/exedev/` and later `src/providers/oci/` as sibling implementations. Credential lifecycle (mint/cap/revoke/verify) + run records are the same domain — inkwell pattern reimplemented, per §7 |
| **DF3** fleet dispatcher + tier-1 skills | `src/fleet/` + `tests/fleet/`, CLI at `scripts/fleet.ts` | Consistent with "executables in `scripts/`, logic in `src/`". Subcommands `dispatch \| fanout \| status \| attach \| harvest \| teardown \| reap` parsed with `scripts/lib/cli-args.ts` `parseValueFlags` |
| **DF4** visualizer adoption | `src/visualizer/` or a third workspace | If it ships its own deps/build (likely — it's a web UI), make it a **workspace** like `cli-anything`, and add it to `package.json:workspaces` **and** the `lint` script |
| **DF5** lights-on gate + PR | `src/gate/assertions/df-*.ts` + `scripts/df-lights-on-gate.ts` | **Reuse the chassis unchanged.** New assertion modules alongside the `p0-*` ones; new driver script mirroring `phase0-exit-gate.ts` (clause map header, `parseValueFlags` for `--report`, `render()`, `DF_GATE: PASS/FAIL`, exit 0/1/2). Tests extend `tests/gate/` |
| **DF6** memory wiring | Extend `src/hindsight/` | Domain exists; respect the `index.ts` "do not re-shape without coordinating" note |
| **Step-output schema** (finding #2) | `cli-anything/src/types.ts` + `merger.ts` | Belongs to the tier-3 workspace, not a new domain |

**Do not** create `cli-anything/src/factory/`. `cli-anything` is the tier-3 team harness workspace with
its own `package.json` and a scoped description; tier-1/tier-2 host-side code there would invert the
tier boundary the design doc draws.

---

## 10. Quick reference — seam table for `## Files to Modify` sections

| Seam | File:line | Signature / value |
|---|---|---|
| Runtime selection ternary | `cli-anything/src/runner.ts:554` | `env.QDS_TEAM_RUNNER === "local" ? "local" : "warren"` |
| Team spawn builder | `cli-anything/src/team-events.ts:36` | `buildTeamSpawn(manifest, runner): {file, argv}` |
| Role/model split | `cli-anything/src/team-events.ts:12` | `splitRoleModel(s): {provider, model}` (first `/`) |
| NDJSON event union | `cli-anything/src/team-events.ts:69` | 5 kinds: cost/coms/worker_output/merged/coms_init_error |
| NDJSON parser | `cli-anything/src/team-events.ts:77` | `parseTeamEventLine(line): TeamEvent \| null` |
| Atomic artifact write | `cli-anything/src/team-events.ts:138` | `writeArtifactAtomic(dir, name, data)` |
| exitStatus enum (CC-1) | `cli-anything/src/types.ts:79` | 5-value |
| **MergedOutput contract** | `cli-anything/src/types.ts:131` | 9 fields; **no testResults/mulchPrimed/artifacts** |
| CostEvent wire type | `cli-anything/src/types.ts:108` | widen here for cache tokens / turn count |
| Merged-output invariants | `cli-anything/src/merger.ts:187` | `buildMergedOutput(opts)`; opts type at `:164` |
| Worker reply validation | `cli-anything/src/merger.ts:46` | `validateWorkerOutput(agentId, raw)` |
| Budget kill fraction | `cli-anything/src/runner.ts:463` | `0.9` |
| Team stdout line cap | `cli-anything/src/runner.ts:472` | 1 MiB |
| Team run options | `cli-anything/src/runner.ts:474` | 7 overrides |
| Team engine | `cli-anything/src/runner.ts:502` | `runTeamManifest(path, opts)` |
| Agent-team config export | `cli-anything/src/runner.ts:533` | `QDS_AGENT_TEAM_CONFIG_JSON` |
| Wall-clock guard | `cli-anything/src/runner.ts:675` | → `overflow` |
| Budget guard | `cli-anything/src/runner.ts:707` | → `overflow`, 90% of cap |
| Lead-failure artifact dump | `cli-anything/src/runner.ts:929` | redacted, atomic |
| Secret redaction entry | `cli-anything/src/redact.ts:62` | `redactSecrets(text, parentEnv)` |
| Driver env contract | `cli-anything/scripts/team-lead-driver.ts:257, 286` | `QDS_AGENT_TEAM_CONFIG_JSON`, `PI_COMS_TIMEOUT_MS` |
| Driver pi spawn | `cli-anything/scripts/team-lead-driver.ts:129` | `pi --provider P --model M --mode json --no-session -p` |
| **Usage overwrite bug** | `cli-anything/scripts/team-lead-driver.ts:231,233,237,238` | `=` should accumulate |
| PiRunOutcome type | `cli-anything/scripts/team-lead-driver.ts:114` | widen for cache/turn fields |
| Cost emit sites (2) | `cli-anything/scripts/team-lead-driver.ts:301, 363` | worker + lead |
| Vendor provenance pin | `pi-vs-claude-code-vendor/package.json` | commit `0ed11f44`, pi `0.55.0` |
| Vendor misattribution | `pi-vs-claude-code-vendor/coms.ts:14-15` | "pi-mono" vs actual `disler/pi-vs-claude-code` |
| Gate assertion interface | `src/gate/gate-runner.ts:45` | `GateAssertion` |
| Gate check outcome | `src/gate/gate-runner.ts:39` | `{pass, skip?, detail?}` |
| Gate runner | `src/gate/gate-runner.ts:144` | `runGate(assertions, options)` |
| VOID mechanism | `src/gate/gate-runner.ts:167-178` | `void_reason` set ⇒ check never invoked, excluded from verdict |
| Verdict rule | `src/gate/gate-runner.ts:324-326` | all-void or empty ⇒ FAIL |
| GateReport shape | `src/gate/gate-runner.ts:88` | + zod `GateReportSchema:117` |
| Gate driver template | `scripts/phase0-exit-gate.ts` | clause map, `--report`, exit 0/1/2 |
| Evidence field | `src/gate/verifier-child.ts:33` | `VerifierCheck.evidence?` |
| Shared AC-check shell | `src/gate/assertions/lib/verdict.ts` | `checkRequiredAcs(run, acs)` |
| SwarmClaw routes | `src/swarmclaw/index.ts:85-97` | 4 POST routes |
| Body cap | `src/swarmclaw/index.ts:135` | `MAX_BODY_BYTES = 1_048_576`, 413 + `connection: close` |
| Request-id middleware | `src/swarmclaw/index.ts:42-58` | inbound-or-mint, echoed on every response |
| SIGTERM discipline | `src/swarmclaw/index.ts:210-228` | re-entrancy guard, 12 s force-exit watchdog, SIGTERM+SIGINT |
| Hindsight barrel | `src/hindsight/index.ts` | stable contract |
| Hindsight mock flag | `src/hindsight/client.ts:104` (short-circuit `:321`) | `mode?: "live" \| "mock"`, default live |
| Shared flag parser | `scripts/lib/cli-args.ts` | `parseValueFlags` |
