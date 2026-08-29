# R6 — Cross-track: successor contracts on `src/phase-engine/steering.ts`

Sources: df3-3, df3-4, df3-6 story files (`_bmad-output/sprint-artifacts/dark-factory-v5/stories/`).
Verified: `src/phase-engine/steering.ts` does not exist — DF3.3 authors it greenfield.

## (a) What each successor ADDS to steering.ts

**DF3.4** (Files to Modify, steering.ts entry; Technical Notes "The attach transport, named"; AC6;
INV-APPROVE-5): at exactly DF3.3's three solicitation points, and only there —
- drain `/run/steering/inbox.ndjson` (dedupe key `messageId`),
- fold each drained message into **that solicitation's prompt context as guidance text**,
- append `{ messageId, ackedAt, point }` to `/run/steering/acks.ndjson`.
No fourth point (INV-APPROVE-5 keeps DF3.3's containment argument intact).

**DF3.6** (Files to Modify, steering.ts entry; Overview; Trigger Surface; DOD): a
`checkBounds(point)` wrapper around the existing call sites, run **immediately before** every
DF3.3 solicitation — rejects the call on per-phase iteration exhaustion, projected worst-case
spend breach, or watchdog-already-killed. DOD: "no unguarded call site in the diff."

## (b) Contracts each successor assumes DF3.3 exports

**DF3.4 assumes:** a solicit function whose rendered prompt reads from a context the drain can
append to; a stable `point` identity (it writes `point` into the ack line and logs it); the
three points as discrete, addressable sites.

**DF3.6 assumes:**
- a single wrappable call path per point (`checkBounds(point)` param needs the point identity);
- the engine-metered accumulator: cumulative `spendMicros` (integer µ$, DD-9) for the
  `spent + projected > effectiveCeiling` projection (AC1, Technical Notes "Pre-flight projection");
- DF3.3's per-call guard values as projection inputs — prompt ≤ 16,000 chars and
  `maxOutputTokens` 1,024 (df3-3 Technical Notes "Guards/limits"; df3-6 Technical Notes says
  "Both ceilings are DF3.3's per-call guards");
- the `resident` journal block it writes into without adding fields (df3-3 AC5): closed
  `status` set `"active"|"degraded"|"disabled"|"stopped"` — df3.6 writes `"stopped"` (breach)
  and reuses `"disabled"` for unwatchable RSS ("a fourth value would violate its AC5");
  `exitStatus` (CC-1 import) — df3.6 alone writes `"overflow"` (df3-6 AC4);
- `residentTripwire` rows `{ runId, requestId, cause, phase, detail }` with the **closed
  three-cause set** `spend_ceiling_breach | gate_bypass_attempt | watchdog_kill` — df3.3 records
  `gate_bypass_attempt`; df3.6 raises the other two (df3-3 Technical Notes "D4 tripwire
  telemetry"; df3-6 Technical Notes "Tripwire causes are emitted");
- per-phase `steeringIterations` (df3.6's iteration bound is per phase, AC3);
- `requestId` on every log/telemetry row ("propagates unchanged from DF3.3's solicitation
  record", df3-6 Observability);
- a way to **stop the resident** (kill the subprocess tree, df3-6 Overview/AC4) — only DF3.6
  decides when, so DF3.3 must supply the mechanism.

## (c) Ordering / ownership rule (all three stories, mirrored)

DF3.3 authors the file → DF3.4 rebases, adds only inbox drain + ack append at the same three
points → DF3.6 rebases last, adds only the `checkBounds(point)` wrapper. **Each successor adds
only: no fourth solicitation point, no edit to a DF3.3-owned line** (df3-6 adds: nor a
DF3.4-owned line).

## Port API proposal (minimal — satisfies DF3.3 now, successors add without editing lines)

The whole trick: **one choke-point function**. If the engine loop's three sites are bare
`await solicit(point, ctx)` calls and everything else lives inside `solicit`, both successors
insert *inside* the function (pure added blocks) instead of editing call-site lines.

```ts
// src/phase-engine/steering.ts (DF3.3-owned)
export type SteeringPoint = "run_start" | "post_gate_failure" | "run_end";

export const steeringDirectiveSchema: z.ZodType<SteeringDirective>; // closed .strict() union, 4 actions
export const PROMPT_CHAR_CEILING = 16_000;   // consumed by DF3.6's projection
export const MAX_OUTPUT_TOKENS = 1_024;      // consumed by DF3.6's projection

export interface ResidentTelemetry {        // owns the journal `resident` block
  status: "active" | "degraded" | "disabled" | "stopped";  // closed set (AC5)
  directives: number;                       // accepted count
  directivesRejected: number;
  steeringIterations: Record<string, number>; // per phase
  spendMicros: number;                      // engine-metered integer µ$
  exitStatus?: ExitStatus;                  // imported from cli-anything/src/types.ts:94-185
  tripwires: ResidentTripwireRow[];         // { runId, requestId, cause, phase, detail }, 3 causes
}

export interface SolicitCtx {
  runId: string;
  requestId: string;                        // from DF3.1 brief, propagates everywhere
  phase: string;
  rosterIds: readonly string[];             // closed DF1.5 set for select_roster
  promptContext: string[];                  // MUTABLE — DF3.4 pushes drained inbox lines pre-render
  telemetry: ResidentTelemetry;             // MUTABLE accumulator — DF3.6 reads spendMicros/iterations
}

export interface SolicitOutcome {
  issued: boolean;                          // false = skipped (disabled / guarded) → deterministic default
  directive: SteeringDirective | null;
  accepted: boolean;
  spendMicros: number;                      // this call's metered cost
  durationMs: number;                       // + subTimings prompt_render_ms / agent_call_ms / directive_parse_ms
}

export function solicit(point: SteeringPoint, ctx: SolicitCtx): Promise<SolicitOutcome>;
export function stopResident(t: ResidentTelemetry, exitStatus: ExitStatus): Promise<void>;
// kills the tree per DF2.4 doctrine, writes exitStatus; DF3.6 decides WHEN (it alone writes "stopped"/"overflow")
```

Internal seam order inside `solicit` (the insertion points successors use, in sequence):
1. eligibility guard — DF3.6 inserts `checkBounds` here (one block guards all three points);
2. inbox drain → `ctx.promptContext` — DF3.4 inserts here, before prompt render;
3. prompt render (≤ `PROMPT_CHAR_CEILING` incl. reserved truncation suffix) from `ctx.promptContext`;
4. agent call (`MAX_OUTPUT_TOKENS`, 60s timeout, ≤ 1 reparse then degrade);
5. `.strict()` parse → telemetry/log row (`gate_bypass_attempt` on rejection);
6. ack append — DF3.4 inserts here, after the reply.

Net: DF3.3 ships zero hook registry, zero plugin machinery — just the choke point, the mutable
ctx/telemetry, exported guard constants, and the `point` identity. Successor diffs are added
blocks in named slots; the add-only rule holds at the line level.
