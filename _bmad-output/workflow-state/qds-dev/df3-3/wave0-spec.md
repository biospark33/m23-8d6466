# DF3.3 Wave-0 Implementation Contract

Authoritative interface contract for the parallel TDD wave. Where this conflicts
with a research note, THIS WINS; where it conflicts with source code, SOURCE
WINS (report the conflict, don't silently adapt). Story file:
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-3-resident-orchestrator-agent.md`
Research: `_bmad-output/workflow-state/qds-dev/df3-3/research/R1..R7-*.md`

## Verified platform facts (do not re-derive)

- zod 3.25.76, v3 API only. `z.discriminatedUnion("action", [...])`; closed-ness
  is member-level: every member is `z.object({...}).strict()`.
- pi 0.55.0: NO maxOutputTokens CLI flag → enforce 1024 via prompt instruction
  (SCHEMA_INSTRUCTION text) + record deviation in Dev Agent Record. Session
  continuation flag is `--session <path>` (NOT --session-id). `-p` non-interactive,
  `--mode json`, `--no-tools` exists (use it — INV-RES-1 made structural).
- `resolveRate` IS exported (roster/validate.ts:471) — story hardening note was
  stale. Use it; never re-read models.json.
- Run record CORE_FIELDS has 13 fields (requestId promoted). Add NOTHING.
- team-lead-driver lives at `cli-anything/scripts/team-lead-driver.ts`.
- Module boundary: fleet imports engine barrel, NEVER reverse. steering.ts
  (engine) must not import from src/fleet.

## Cluster ownership (disjoint — do not touch others' files)

- **C1 engine:** `src/phase-engine/steering.ts` (NEW), `src/phase-engine/index.ts`
  (barrel exports only), `tests/phase-engine/steering.test.ts`,
  `tests/phase-engine/fixtures/fake-resident.ts`
- **C2 fleet:** `src/fleet/resident.ts` (NEW), `src/fleet/index.ts` (barrel
  exports only), `tests/fleet/resident.test.ts`
- **C3 runner:** `scripts/pipeline-run.ts`, `tests/phase-engine/fixtures/pipeline.resident.json`,
  e2e test file `tests/phase-engine/resident-e2e.test.ts` (proceed-only
  byte-identity + steered invariants + demo)

## C1 — src/phase-engine/steering.ts (the port)

```ts
export const PROMPT_CHAR_CEILING = 16_000;   // includes truncation suffix
export const MAX_OUTPUT_TOKENS = 1_024;      // prompt-enforced (pi has no flag) — deviation noted
export const SOLICIT_TIMEOUT_MS = 60_000;
export const MAX_MALFORMED_ATTEMPTS = 2;     // two consecutive malformed replies → degrade

export type SteeringPoint = "run_start" | "post_gate_failure" | "run_end";

export const SteeringDirectiveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("proceed"),  note: z.string().optional() }).strict(),
  z.object({ action: z.literal("retry"),    guidance: z.string(), note: z.string().optional() }).strict(),
  z.object({ action: z.literal("select_roster"), phase: z.string(), rosterId: z.string(), note: z.string().optional() }).strict(),
  z.object({ action: z.literal("abort"),    reason: z.string(),   note: z.string().optional() }).strict(),
]);
export type SteeringDirective = z.infer<typeof SteeringDirectiveSchema>;

/** Fleet-supplied agent caller. Engine never imports fleet (INV-RES-1). */
export interface ResidentCaller {
  /** One synchronous solicitation. Returns raw reply text + token usage.
   *  Throws on timeout / unreachable / process death. */
  call(prompt: string): Promise<{ raw: string; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface SolicitCtx {
  runId: string;
  requestId?: string;
  phase?: string;            // undefined at run_start
  rosterIds?: readonly string[]; // closed DF1.5 id set, for select_roster validation
  promptContext: string[];   // mutable — DF3.4 will push drained inbox lines pre-render
}

export type ResidentStatus = "active" | "degraded" | "disabled" | "stopped";
export interface ResidentTripwire { runId: string; requestId?: string; cause: "gate_bypass_attempt"; phase?: string; detail: string; }
// (spend_ceiling_breach + watchdog_kill causes are DF3.6's to raise — union stays
//  closed to "gate_bypass_attempt" in DF3.3; DF3.6 widens it.)

export interface ResidentTelemetry {
  status: ResidentStatus;
  directives: number;                        // COUNT of accepted directives (E2E asserts === 3)
  directivesRejected: number;
  steeringIterations: Record<string, number>; // per-phase count
  spendMicros: number;                        // engine-metered integer µ$ (usage × rate ÷ 1e6, rounded)
  exitStatus: ExitStatus | null;              // from cli-anything/src/types.ts — import, never re-declare
  tripwires: ResidentTripwire[];
}
```

`createSteering(deps: { caller: ResidentCaller; rate: { inputPerMTok: number; outputPerMTok: number }; onTripwire?: (t: ResidentTripwire) => void })`
returns a controller:

```ts
export interface SteeringController {
  readonly telemetry: ResidentTelemetry;
  /** Never throws. Degraded/disabled → resolves { action: "proceed" } (deterministic default). */
  solicit(point: SteeringPoint, ctx: SolicitCtx): Promise<SteeringDirective>;
}
```

Behavior (AC2/AC3, INV-RES-2/5):
1. Render prompt: join ctx.promptContext lines; enforce PROMPT_CHAR_CEILING by
   head-truncation with the suffix width RESERVED BEFORE cutting (copy the rule
   form from merger.ts:218-245 — private helper, do not export merger's).
   Prompt must instruct: reply with ONE JSON object matching the union, ≤1024
   output tokens.
2. `caller.call(prompt)` — on throw (timeout/unreachable): telemetry.status
   "degraded", resolve `{action:"proceed"}`. No retry of the call, no retry of
   the underlying phase, no gate skipped.
3. Parse raw via `extractJsonCandidate` (agents/envelope-parse.ts:92) then
   `safeParse(SteeringDirectiveSchema)`.
   - Not JSON-extractable (malformed): ONE reparse attempt = one more
     `caller.call` with a correction prompt naming the parse failure (model on
     envelope-parse.ts:34-47). Second consecutive malformed → status
     "degraded", resolve default. Never a third call.
   - Valid JSON, schema-rejected (unknown action incl. skip_gate/reorder_phases/
     set_status/extend_budget, unknown field, bad rosterId): record tripwire
     `{cause:"gate_bypass_attempt", detail:<rejected action name or field issue>}`,
     directivesRejected++, emit via onTripwire, resolve default
     `{action:"proceed"}`. Single attempt — no reparse for schema rejections.
   - Accepted: directives++ (count); if action==="retry" and ctx.phase set,
     steeringIterations[phase]++; resolve the directive.
4. Metering on EVERY reply (accepted or not): spendMicros += round(inputTokens·inputPerMTok/1e6)
   + round(outputTokens·outputPerMTok/1e6). Integer µ$, never float.
5. `select_roster` with rosterId outside ctx.rosterIds (when provided) is a
   REJECTED directive (tripwire), not an error.
6. `abort`: resolve it — the ENGINE (pipeline-run) performs its own fail
   transition. steering.ts only parses/validates/records.

Engine-side effect application is C3's job (steering.ts holds no engine state).

## C2 — src/fleet/resident.ts (the agent)

```ts
export const DEFAULT_RESIDENT_SLUG = "deepseek-v4-flash-0731"; // provenance default; runtime rate ALWAYS resolveRate()
export interface ResidentSpawn {
  caller: ResidentCaller;        // implements call() over a pi subprocess
  rate: { inputPerMTok: number; outputPerMTok: number };
  exitStatus(): Promise<ExitStatus>;
  stop(): Promise<void>;         // SIGKILL group; DF3.6 decides when, DF3.3 supplies how
}
export function startResident(opts: {
  brief: unknown;                // DF3.1 BriefSchema value (already validated at ingress)
  runId: string;
  sessionDir: string;            // --session <path> file lives here
  slug?: string;                 // default DEFAULT_RESIDENT_SLUG
  env?: NodeJS.ProcessEnv;       // key delivery (env-borne, never argv)
  bin?: string;                  // pi binary override — test seam (QDS_PI_BIN env fallback)
}): ResidentSpawn | { disabled: true };
```

- Brief absent/empty (null/undefined/empty object/empty string) → return
  `{disabled:true}` — resident NEVER spawned, AC4, explicit non-error.
- Rate: `resolveRate(slug)` — throws (RateError) → propagate; caller refuses
  before spawn (DF1.5 rule).
- Spawn adapted from `runWorkerPi` (cli-anything/scripts/team-lead-driver.ts:542-659):
  `Bun.spawn([bin, "--provider","openrouter","--model",slug,"--mode","json",
  "--no-tools","--session",join(sessionDir, runId+".resident.jsonl"),"-p",prompt],
  { stdout:"pipe", stderr:"pipe", timeout: SOLICIT_TIMEOUT_MS, killSignal:"SIGKILL", env })`.
  Timeout via Bun.spawn native `timeout` (transport.ts:64-77 pattern). Binary
  missing → synchronous ENOENT throw = the AC3 unreachable path.
- Reply: `harvestPiStream` (team-lead-driver.ts:270-364, EXPORTED — import it)
  → text + token totals. Usage from message_end totals only.
- Prompt/reply persistence PRE-EXECUTION, redacted: `redactSecrets`
  (cli-anything/src/redact.ts:62) — bind via the dispatch-task.ts:120-126
  pattern. Persist under the run's journal/trace dir; the caller (C3) passes
  the path in opts (add `persistDir?: string`; when absent, skip persistence —
  unit tests use that).
- Session continuity: same `--session <path>` per run → "re-enters the same
  session" (E2E slice). One process per call is fine (pi resumes the session
  file); the session FILE is the continuity, not a long-lived process.
- exitStatus mapping: clean exit → "success"; timeout SIGKILL → "transient";
  ENOENT/child error → "transient"; nonzero exit → "logic". Values only from
  the imported EXIT_STATUSES set.

## C3 — scripts/pipeline-run.ts (the wiring)

- Add `--no-resident` flag (additive; existing flags untouched).
- Resident source: `run-context.json` in dirname(resolved manifest) (already
  read as cap witness, pipeline-run.ts:345-346). requestId present AND not
  `--no-resident` AND brief non-empty → resident path; else
  `resident.status:"disabled"`, fully deterministic run (AC4).
- Hook sites (R2 map):
  1. run_start — after `new Run` (~:932), before walkPhases (~:971).
  2. post_gate_failure — AFTER DF1.3 authorizes attempt N+1
     (retry.ts:284-287 branch). Point 2 supplies guidance text only; it never
     decides the retry.
  3. run_end — after `run.finish(accepted)` (~:1007). Report text only.
- `abort` directive at any point → engine's own fail transition (existing
  fail path), then stop.
- `select_roster` accepted → engine picks from DF1.5 closed id set for the
  NEXT dispatch_task phase (if any); outside set was already rejected in C1.
- `retry` accepted → guidance text is appended to the retry attempt's prompt
  context (the engine-authorized attempt that DF1.3 already armed).
- Telemetry → journal: `JournalFile.resident?: ResidentTelemetry` (optional
  field, journal.ts:68-75). Tripwires ALSO via
  `tracer.trace({type:"log", name:"residentTripwire", ...})` (TraceEventType
  union — types.ts:325 — gains "residentTripwire" member if log names are
  union-gated; if free-text, no union edit needed. SOURCE WINS — check).
- E2E fixture wiring (R2 gap): `makeBodyFactory` must compose
  `gatedBody`+`commandGate` (gates/library.ts:230, command-gate.ts:50) on code
  phases that declare a gate, with the DF1.3 retry loop authorizing attempt 2.
  The fixture `pipeline.resident.json` declares a `build` phase whose test
  command fails on first attempt, passes on second (state file in /tmp counting
  invocations), gating per story E2E slice.
- Byte-identity discipline: with a proceed-only resident, journal must be
  byte-identical to `--no-resident` control after deleting `resident.*` and
  timing fields (`completedAt`, any `*_ms`/durationMs). Test does:
  readJournal both, strip, deep-equal + stable stringify compare.

## Test matrix (DOD → tests)

| DOD | Test | File |
|-----|------|------|
| contract union | rejects skip_gate/reorder_phases/set_status/extend_budget/unknown field → tripwire gate_bypass_attempt w/ action name; single attempt, default proceed | steering.test.ts |
| fail-closed | unreachable (ENOENT), timeout, malformed×2 → degraded, run completes, 0 gates skipped, exactly 2 calls | steering.test.ts |
| metering | integer µ$ sums from usage×rate; float never appears | steering.test.ts |
| prompt cap | 20k-char context → prompt ≤16000 INCL suffix; suffix reserved pre-cut | steering.test.ts |
| AC4 | empty brief → disabled, no spawn, clean run | resident.test.ts |
| spawn | argv shape (--no-tools --session --mode json -p), env-borne key, no argv secrets | resident.test.ts |
| AC1a | proceed-only vs --no-resident → byte-identical journals (strip resident.*+timing) | resident-e2e.test.ts |
| AC1b | steered: phase order preserved, verdicts evidence-derived, no unearned promotion; NO byte-identity assert | resident-e2e.test.ts |
| demo | out.json: gate fail→retry w/ guidance→pass, steeringIterations.build==1, directives===3, spendMicros number | resident-e2e.test.ts |
| telemetry boundary | journal resident block fields; ZERO ratio/percentage fields; ZERO new run-record core fields | resident-e2e.test.ts |

fake-resident.ts fixture: a runnable pi-emulating script (argv-compatible:
reads -p prompt, replies JSON from a scripted map env var, --mode json NDJSON
on stdout with message_end usage) — used via `bin:`/QDS_PI_BIN in e2e.

## House rules

- TDD: test file first, watch it fail, then implement. Every added test
  mutation-verified RED against pre-fix source where feasible.
- Fakes local to test files; import constants from source, never mirror.
- No sleeping — planted timestamps / injected timers.
- biome + `tsc --noEmit` clean on your cluster before you report done.
- Run your focal tests: `bun test tests/phase-engine/steering.test.ts` etc.
- GitNexus `impact` before editing ANY existing symbol (barrel index.ts,
  pipeline-run.ts internals, journal.ts). Report blast radius in your summary.
- Do NOT commit. Do NOT touch files outside your cluster. Report drift
  SOURCE-vs-spec in your final message.
