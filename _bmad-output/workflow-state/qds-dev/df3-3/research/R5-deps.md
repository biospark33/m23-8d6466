# R5 — Dependency interface verification for DF3.3 (resident orchestrator agent)

Verified against working tree of `feature/df3-3-resident-orchestrator-agent` (== main content).
Every claim carries file:line. Drift between story/task text and code is flagged **DRIFT**.

---

## 1. DF1.5 roster — `src/phase-engine/roster/`

**Exports / signatures**

- `loadRoster(rosterPath: string, opts: LoadRosterOptions = {}): ResolvedRoster` — `src/phase-engine/roster/schema.ts:332`. `LoadRosterOptions { repoRoot?, cwd? }` (schema.ts:74-79). Path is realpath'd + confined to repo root BEFORE read (INV-2), 256 KiB ceiling `ROSTER_MAX_BYTES` (schema.ts:44, 374-379).
- `parseRoster(text, path?): ResolvedRoster` — schema.ts:202. Closed zod schema at every level (`.strict()`), unknown key = error (schema.ts:127-131).
- `validateRoster(roster: ResolvedRoster, deps: ValidateDeps = {}): Promise<RosterReport>` — `src/phase-engine/roster/validate.ts:879-997`. Runs both gates (pi catalog, provider API), resolves rates, `exitCode: 0|1|2` (2 dominates 1, validate.ts:977-981).
- `ResolvedRole` shape — schema.ts:46-64: `{ name, model, provider, thinking, tools: string[]|null, writes: string[]|null, harness_engineering: string[], slug: "${provider}/${model}", warnings }`.
- `ResolvedRoster { path, roles, warnings }` — schema.ts:66-72.

**models.json rate keys — DRIFT (naming)**

- The FILE `~/.pi/agent/models.json` cost block keys are `input`, `output`, `cacheRead`, `cacheWrite` (`CostEntry`, validate.ts:82-87; REQUIRED list validate.ts:379). `inputPerMTok`/`outputPerMTok`/`cacheReadPerMTok`/`cacheWritePerMTok` are the **converted** `ResolvedRate` TS field names (validate.ts:71-79), integer µ$/MTok.
- Conversion: `toMicrosPerMTok(value, unit)` (validate.ts:214-250), converts exactly once (DD-9), plausibility band 100 µ$–10^10 µ$ per MTok (validate.ts:203-204). Consumer projection formula: `micros = tokens * ratePerMTok / 1_000_000` (validate.ts:63).
- `resolveRate(slug: string, sources: RateSources = loadRateSources()): ResolvedRate` — validate.ts:471-563. models.json takes precedence wholesale over pi's bundled catalog; absent cache rates from the bundled catalog resolve to 0.
- **Resident hook already present**: `resetRateSources()` — validate.ts:453-455 — exists explicitly "for DF3.3's long-lived resident: without this, an operator edit to `~/.pi/agent/models.json` would never take effect in a running orchestrator." Also `loadRateSources()` throws on an unusable registry rather than dropping broken entries (validate.ts:435-446).

**Declaring a roster role (e.g. "resident")**

- Roster file shape: `config/rosters/qds-default.roster.yaml:22-45` — a `defaults:` block (`provider: openrouter`, `thinking`, `tools: null`, `writes: []`, `harness_engineering: []`) plus `roles:` entries `{- name, model, [thinking], [writes], [tools]}`. A `resident` role = one more `roles:` entry; there is NO reserved-name mechanism and no new key the schema would accept (`writes` must be declared in the role or `defaults`, schema.ts:272-280).
- **Caution**: `dispatchTask` treats `roles[0]` as the LEAD and every remaining role as a worker, and requires `roles.length >= 2` (`src/phase-engine/phases/dispatch-task.ts:178-194`); prompts for ALL roles are the same task brief (dispatch-task.ts:195-198). Adding `resident` to the ACTIVE dispatch roster makes it a dispatched team member, and inserting it first silently changes the lead. If DF3.3's resident is not a team member it needs its own roster file (pattern: `config/rosters/df16-e2e.roster.yaml`) or lookup by name with the team mapping adjusted.

**Refusal paths (unknown slug / unresolvable rate)**

- Unknown slug: `catalogVerdict` returns `"fail"` with `pi-catalog gate rejected "<slug>": not in pi's merged catalog` (validate.ts:850-851); provider gate likewise (validate.ts:866-870). `validateRoster` exitCode 1. In the engine, `dispatchTask` refuses (logic step output) when `gate.exitCode !== 0` — dispatch-task.ts:184-191 — before any spawn. Fleet-side, dispatch pre-checks roster presence/charset/content host-side before a box exists (`src/fleet/dispatch.ts:1601-1636`).
- Unresolvable rate: `resolveRate` throws `RateError` `"no rate for \"<slug>\" in pi's bundled catalog and ~/.pi/agent/models.json — refusing to default it to zero"` (validate.ts:549-553). Zero-priced operator override also refused (validate.ts:493-501). `RateError { code: "rate_unresolved" }` — validate.ts:174-180.
- Roster file problems: `RosterError { code: "roster_invalid" | "roster_unreadable", problems }` — schema.ts:89-104.

---

## 2. DF1.1 phase engine

**Engine entry (what a runner composes)** — `scripts/pipeline-run.ts`:
`loadManifest(manifestPath, budgetMs, runRoot)` (pipeline-run.ts:703) → `new FileJournal(journalPath, runId)` (:888) → `new TracingJournal(innerJournal, tracer, ctx)` (:930) → `new Run({...})` (:932) → `await walkPhases(manifest, factory)` (:971) → `run.finish(!terminated)` (:1007). Body factory `makeBodyFactory` (:534-568) maps `kind === "code"` → `runCommand`, `kind === "dispatch_task"` → `dispatchTask(spec, { tracer, requestId, rootDir: cwd })` (:567).

**PhaseJournal port** — `src/phase-engine/journal.ts:47-58`:
```ts
writePhase(record: PhaseRecord): void            // upsert by phaseId; ALWAYS persists "fail"
promotePhase(phaseId, status: PhaseStatus, exitStatus?: ExitStatus): void  // sole path to "success"
writeGateEvent(event: GateEvent): void           // append-only
finish(runId: string, accepted: boolean): RunOutcome
phases(): readonly PhaseRecord[]
```
`FileJournal` (journal.ts:77-164) flushes atomically (temp+fsync+rename, O_NOFOLLOW) on every op. `TracingJournal` (`src/phase-engine/trace/journal-bridge.ts:52`) is the DF1.4 decorator — same signatures, forwards to Tracer, tracer errors never break the run.

**Manifest validation + freeze** — `src/phase-engine/manifest.ts`:
- `PipelineManifestSchema` (manifest.ts:122), `MANIFEST_VERSION = "1.0.0"` (`src/phase-engine/types.ts:20`).
- `loadManifest(path, budgetMs, root)` — manifest.ts:616; freezes via `deepFreeze` (manifest.ts:600-614) — `LoadedManifest` returned frozen.
- `stampManifestLimit(manifest, limitMicroUsd)` (manifest.ts:753), `stripAuthoredLimit` (:729), `serializeManifest` (:812), `requiredBudgetMs` (:592).

**Legal phase-status transitions** (the only paths):
- `PhaseStatus = "fail" | "success"` — types.ts:140. There is no third state.
- `Run.phase` constructs the record with `status: "fail"` (phase.ts:234-235) and `FileJournal.writePhase` re-forces `"fail"` (journal.ts:94) — default-fail at two independent layers.
- On clean body exit: `promotePhase(phaseId, "success", "success")`; otherwise `promotePhase(phaseId, "fail", exitStatus)` with exitStatus from the taxonomy (phase.ts:375-379; exitStatus derivation phase.ts:286-292).
- `finish(runId, accepted)` settles `ok = phases.length > 0 && every("success") && accepted` (journal.ts:119). No demotion path exists; `walkPhases` halts after the first non-success phase (`Run.isHalted`, phase.ts:162-164, 187-190).

---

## 3. DF3.1 brief — `src/fleet/brief-schema.ts`

- `BriefSchema = z.strictObject({...})` — brief-schema.ts:289-427, closed to unknown fields. Fields: `repoSlug`, `issueId` (int >0, ≤`MAX_ISSUE_ID`), `issueUrl?`, `commitSha` (40-hex), `requestId?`, `manifestPath` (repo-relative, no `..`), `repoUrl` (https-only, cross-checked to name the same repo as `repoSlug`, :424-427).
- `requestId` is LOOSE at schema layer (any non-blank string ≤128, no control chars, brief-schema.ts:350-357); UUID-v4 validation happens in dispatch: `resolveBriefRequestId(parsedBrief)` (dispatch.ts:447) — a non-UUID brief requestId is dropped and a fresh one minted via `resolveRunCorrelation`; a malformed `deps.requestId` refuses exit 2 (dispatch.ts:1400-1411).
- `export type Brief = z.infer<typeof BriefSchema>` (brief-schema.ts:429); `extractZodErrorField` (:454); `sanitizeLabel` (:173); `MAX_REQUEST_ID = 128` (:264).
- **Where the brief lands**: the brief itself is never written into the box as a file. Dispatch validates it (`BriefSchema.safeParse(brief)`, dispatch.ts:1345-1382), then at the fill step composes two in-box files from it (dispatch.ts:2482-2508):
  - `pipeline.yaml` = `serializeManifest(stampManifestLimit(loaded, mintedCeilingMicros))` — the cap's only in-box carrier (AC9a);
  - `run-context.json` = `{ runId, pipelineId, requestId, effectiveCeilingMicros, repoSlug, issueId, issueUrl? }` — DF1.6's spawn seam (AC9b).
  Both are placed by `fillRun(driver, vm, files)` (dispatch.ts:2536; `src/providers/driver.ts:870-896`) — BoxFile paths are relative to the driver exec cwd (exedev: the box's ssh HOME; see fill.ts:71-85 note that every driver exec lands in ssh HOME).

---

## 4. DF1.6 — pi spawn, prompt, reply, usage, cost, timeouts

**DRIFT (location)**: the task/story names `src/fleet/team-lead-driver.ts` — the file actually lives at `cli-anything/scripts/team-lead-driver.ts` (824 lines); the dispatch_task phase body is `src/phase-engine/phases/dispatch-task.ts`.

- **Spawn chain**: `dispatchTask` (dispatch-task.ts:110) → `runTeamManifest(manifestFile, opts)` (`cli-anything/src/runner.ts:642`) with `{ forceLocalRunner: true, effectiveCeilingMicros, abortSignal, onTeamEvent, onRunFacts }` (dispatch-task.ts:274-336). `forceLocalRunner` sets child env `QDS_TEAM_RUNNER=local` (runner.ts:680-683), selecting `team-lead-driver.ts` as the harness; the phase refuses up front unless parent `QDS_TEAM_RUNNER === "local"` (dispatch-task.ts:133-139).
- **pi process spawn**: `runWorkerPi` (team-lead-driver.ts:542-659) — `spawn("pi", buildWorkerArgv(w), { stdio: ["ignore","pipe","pipe"], env: process.env })` (:589-592). `buildWorkerArgv` (:378-396): `--provider P --model M --mode json --no-session [--no-extensions --no-skills -e ext...] -p "<prompt>\n\n<SCHEMA_INSTRUCTION>"`. Keys ride inherited env, never argv (INV-1).
- **Prompt rendering**: every roster role gets the SAME task brief (`prompts[role.name] = taskBrief`, dispatch-task.ts:195-198); `SCHEMA_INSTRUCTION` (team-lead-driver.ts:366-367) demands `{"changedFiles": string[], "result": {"summary": string}}`. Compiled prompts are traced pre-spawn (`type: "prompt"`, dispatch-task.ts:223-235).
- **Reply parsing**: `extractJsonObject` (team-lead-driver.ts:120-166) — last JSON object, fenced or bare, balanced-brace scan.
- **Usage extraction**: `harvestPiStream(stdout)` (team-lead-driver.ts:270-364) — accumulates ONLY on `message_end` (double-count guard INV-COST-3), per-invocation totals `{costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turnCount, unpricedTurns}` (:178-189); truncated streams count open messages as unpriced (:281-283, 361-362).
- **Cost metering**: `costEvent(agentId, model, outcome)` (team-lead-driver.ts:98-117) emits the NDJSON `cost` event matching `CostEvent` (`cli-anything/src/types.ts:141-161`) — `costUsd` stays a USD FLOAT on the wire; integer µ$ belongs to DF2.8's ledger (DD-9), converted at its boundary. Budget cap: `effectiveCeilingMicros` → `budgetCapUsd = min(existing, ceiling/1e6, 10)` (runner.ts:663-672) — ceiling can only LOWER.
- **Timeouts**: per-worker await `PI_COMS_TIMEOUT_MS` (default 240 000 ms, bounds-checked, team-lead-driver.ts:691-697) enforced by SIGKILL (:606-608); manifest `wallClockCapMs` default 300 000 (`TeamManifestSchema`, cli-anything/src/types.ts:81); run-level `killOrigin` contract `RunFacts` (runner.ts:606-613) → `classifyRun` maps watchdog|budget|wallClock→overflow, requestedShutdown→logic, unknown→transient (dispatch-task.ts:340-358).

---

## 5. DF2.2 — box create/fill/setup, setup-gate seam

- **Driver interface**: `ProviderDriver` — 8 primitives incl. `create(name, tag?)`, `exec(vm, argv, stdin?)`, `copyFile` (box→host ONLY) — `src/providers/driver.ts:174-200`. `ExeDevDriver implements ProviderDriver` (`src/providers/exedev/driver.ts:90`).
- **Create**: `provisionAdmittedRun` (driver.ts:489) composes record → box (INV-1 ordering); `createRun` (driver.ts:840).
- **Fill**: `fillRun(driver, vm, files)` (driver.ts:870-896) — content arrives on exec stdin through a python3 openat/O_NOFOLLOW traversal. exedev repo fill: `fillExeDev` (`src/providers/exedev/fill.ts:261-379`) — default `bundle-push` mode (host-credentialed, F4), pins `commitSha`, creates `sbx/<runId>` branch; `DEFAULT_FILL_WORKDIR = "src"` (fill.ts:85, HOME-relative).
- **Setup-gate seam (live model ping)**: `setupGate(driver, vm, opts): Promise<SetupGateResult>` — `src/providers/exedev/setup-gate.ts:277`, a driver METHOD (`driver.ts:474-477`). Five sequential assertions (setup-gate.ts:6-20): A git integrity, B pi registry loaded, **C live ping per roster model (real chat/completions)**, D cost table loaded, E capped credit remaining. C/D/E run as ONE in-box script (`assertions-in-box.sh`, setup-gate.ts:120-127) so the runtime key never crosses the wire; the roster is an ARGUMENT, never an env var (setup-gate.ts:22-25).
- **How the engine learns a box is ready**: `SetupGateResult { ready, failedItem?, assertionCode?, assertions[], debugCommands[], teardownCommand, vm }` (setup-gate.ts:75-88). `ready === true` is the signal; a failure RETURNS (never throws, never process.exit) and leaves the VM alive (INV-5, setup-gate.ts:27-32). Sentinel `/tmp/PROVISION_READY` (setup-gate.ts:115); evidence `.sandbox/setup-gate/<runId>.json` (:118). Assertion exit codes A/B=1, C=2, D=3, E=4 (:61-67).
- In-box env for runs: DF2.2's setup provisions `QDS_TEAM_RUNNER=local` beside DF2.3's key file (`DEFAULT_ENV_FILE = KEY_ENV_FILE`, setup-gate.ts:116-117).

---

## 6. DF2.1 run record — **DRIFT (field count)**

- Story DF2.1 and DF3.3 both say "**twelve**-field closed run record". The DF2.1 story list (df2-1 story :121-123) names 12: `runId, vmName, httpsUrl, keyHash, limitMicroUsd, spendMicroUsd, sessionId, commitSha, ports, pid, createdAt, closedAt`. Current code has **13 core fields**: `CORE_FIELDS` at `src/providers/run-record.ts:58-72` adds **`requestId`** as a core field (INV-4-bis, promoted per the comment at run-record.ts:100-108 — the dispatch correlation join key).
- Operative constraint unchanged and stronger in code: `set()` rejects any key outside `CORE_FIELDS` + allow-listed `extensions` namespaces (run-record.ts:141-... registered: `pr`, `fixLoop`, `fanout`, `budget`, `approval`); `extensions` is the single sanctioned additive surface (run-record.ts:18-19, 141-186). **DF3.3 adds NO core field; if it ever needs cross-cutting state it must register a new `extensions` namespace — the story says it adds nothing at all.**
- `spendMicroUsd?: number` — integer micro-dollars, the run total (run-record.ts:97, DD-9 :89). `SETTABLE_FIELDS` derived (run-record.ts:85-87); `runId`/`createdAt` immutable (:75).

---

## 7. DF1.4 SQLite trace store (PhaseJournal impl + new row kinds)

- SQLite implementation: `Tracer` (`src/phase-engine/trace/tracer.ts`) applies `SCHEMA_DDL` (7 tables: sessions, phases, events, envelopes, gate_results, processes, agent_sessions — `src/phase-engine/trace/schema.ts:20-100`) then `applyMigrations(this.db)` (tracer.ts:418-429) **at store open**, not at box init. `TracingJournal` (trace/journal-bridge.ts:52) is how the engine's journal writes reach it.
- **Adding a new row kind (e.g. `residentTripwire`)**: the `events.type` column is plain `TEXT NOT NULL` with no CHECK (schema.ts:53); the gate is the TS union `TraceEventType` (`src/phase-engine/types.ts:325-336` — 11 members incl. `log`, `error`). Appending `"residentTripwire"` to that union is the whole change; `Tracer.trace({requestId, phaseId?, type, name, payloadJson?})` (`TraceEventInput`, types.ts:350-360) then persists it. Alternatively ride `type: "log"` with a payload discriminator — zero type change.
- **New COLUMN pattern** (only if a query needs it): append a `[table, column, decl]` tuple to the frozen `MIGRATIONS` list (migrations.ts:23-36, freeze :40-41) — nullable/DEFAULT-only so `ALTER TABLE ADD COLUMN` is metadata-only; re-apply is idempotent via `PRAGMA table_info` (migrations.ts:54-77). DF1.8 set the precedent (repo_slug/issue_id/issue_url, migrations.ts:31-35).

---

## 8. exitStatus (CC-1) — `cli-anything/src/types.ts`

- `EXIT_STATUSES = ["success","transient","overflow","logic","lead_failure"] as const` — cli-anything/src/types.ts:99-105; `export type ExitStatus = (typeof EXIT_STATUSES)[number]` — :108. (The task said "~lines 94-185"; the export sits at 99-108.)
- Runtime guard: `isExitStatus(value): value is ExitStatus` — `src/phase-engine/phases/team-event-adapter.ts:20`.
- `src/phase-engine/types.ts:14,17` re-exports `ExitStatus` (imported from CC-1, never re-declared) — the canonical import site pattern.

## Exact imports DF3.3 will need

From `src/phase-engine/*` (e.g. a new `src/phase-engine/phases/resident.ts`):
```ts
import { EXIT_STATUSES, type ExitStatus } from "../../../cli-anything/src/types.ts";
import { isExitStatus } from "./team-event-adapter.ts";
import { loadRoster, parseRoster, RosterError, type ResolvedRoster } from "../roster/schema.ts";
import { resolveRate, resetRateSources, loadRateSources, RateError, type ResolvedRate } from "../roster/validate.ts";
import type { PhaseJournal, PhaseRecord, PhaseStatus } from "../journal.ts";
import type { TraceEventType, TraceEventInput } from "../types.ts";
import type { Tracer } from "../trace/tracer.ts";
```
From `src/fleet/*` or `scripts/`:
```ts
import { EXIT_STATUSES, type ExitStatus } from "../cli-anything/src/types.ts";   // src/fleet depth
import { EXIT_STATUSES, type ExitStatus } from "../cli-anything/src/types.ts";   // scripts/ depth (same)
import { loadRoster } from "../src/phase-engine/roster/schema.ts";               // scripts/ depth
import { resolveRate, resetRateSources } from "../src/phase-engine/roster/validate.ts";
```
Match existing depth conventions: `src/phase-engine/types.ts:14` uses `"../../cli-anything/src/types.ts"`; `src/fleet/dispatch.ts:27` uses `"../../cli-anything/src/types.ts"`; `scripts/pipeline-run.ts` imports from `"../src/phase-engine/index.ts"` barrel (which re-exports `types.ts` via `export *`, index.ts:46).
