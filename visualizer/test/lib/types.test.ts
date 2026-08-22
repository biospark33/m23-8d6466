/**
 * DF4.2 test for src/lib/types.ts (AC1).
 *
 * types.ts is `export type { ... } from '@shared/types'` — a pure re-export.
 * It transpiles to nothing: zero executable lines, zero functions. There is
 * no runtime behavior to cover, so this is deliberately NOT a runtime
 * coverage test. What it actually checks:
 *
 *  1. Importing the file for its runtime side effect (none) still succeeds
 *     and produces a coverage record — bun's lcov only lists a file it
 *     actually loaded, and check-lcov.ts treats a file with LF:0/FNF:0 as a
 *     vacuous pass, but ONLY if a record exists at all. A pure `import
 *     type` is erased by the transpiler and would never touch the file, so
 *     the record would be silently missing. The bare `import "..."` below
 *     is what makes that record appear.
 *  2. Type-level assignability assertions (checked by `vue-tsc`/`tsc`, not
 *     by bun at test time — bun only transpiles, it does not type-check)
 *     that every name re-exported from `./types` stays structurally
 *     identical to its `@shared/types` source. If a rename or field drift
 *     ever desyncs the two, `bun run typecheck:visualizer` fails on this
 *     file; `bun test` alone will not catch it, since it never type-checks.
 *  3. One honest runtime assertion: a synthetic object shaped like each
 *     re-exported interface satisfies that type. This is a compile-time
 *     check with a runtime side door (the object literal exists at
 *     runtime) — it is not a substitute for #2, just a belt-and-suspenders
 *     sanity check that the shapes are usable, not merely typeable.
 */
import { describe, expect, test } from "bun:test";

// Runtime side-effect import — see note 1 above. Intentionally not `import
// type`: that form is erased and would never load the file.
import "../../src/lib/types.ts";

import type {
  Session as LibSession,
  SessionSummary as LibSessionSummary,
  SessionUsage as LibSessionUsage,
  SessionDetail as LibSessionDetail,
  Phase as LibPhase,
  EventRow as LibEventRow,
  EventsPage as LibEventsPage,
  Envelope as LibEnvelope,
  GateResult as LibGateResult,
  GateCheck as LibGateCheck,
  AgentSession as LibAgentSession,
  AgentStartPayload as LibAgentStartPayload,
  AgentEndPayload as LibAgentEndPayload,
  UsageBreakdown as LibUsageBreakdown,
  ToolCallPayload as LibToolCallPayload,
  PromptEvent as LibPromptEvent,
  PromptsResponse as LibPromptsResponse,
  HealthResponse as LibHealthResponse,
  SessionStatus as LibSessionStatus,
  PhaseStatus as LibPhaseStatus,
  PhaseKind as LibPhaseKind,
  EventType as LibEventType,
} from "../../src/lib/types.ts";
import type {
  Session,
  SessionSummary,
  SessionUsage,
  SessionDetail,
  Phase,
  Event,
  EventsPage,
  Envelope,
  GateResult,
  GateCheck,
  AgentSession,
  AgentStartPayload,
  AgentEndPayload,
  UsageBreakdown,
  ToolCallPayload,
  PromptEvent,
  PromptsResponse,
  HealthResponse,
  SessionStatus,
  PhaseStatus,
  PhaseKind,
  EventType,
} from "../../shared/types.ts";

// Structural-equality check, not mere assignability — catches an optional
// field added on one side but not the other, which plain `A extends B` (or
// vice versa) would miss for object types with matching required fields.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

// A single exported tuple, one slot per re-exported name, so `noUnusedLocals`
// doesn't flag 21 separate one-off type aliases as dead code — each slot
// still independently fails `vue-tsc`/`tsc` if that name's shape drifts.
// `types.ts` has zero executable lines, so this drift check is compile-time
// only — `vue-tsc` evaluates every slot below and fails if a re-exported name
// drifts from `@shared/types`. Exporting keeps tsc from pruning it as an
// unused local (TS6196); nothing imports it and it erases at runtime.
// biome-ignore lint/suspicious/noExportsInTest: the export IS the assertion.
export type _ReExportSurfaceStaysInSync = [
  Expect<Equal<LibSession, Session>>,
  Expect<Equal<LibSessionSummary, SessionSummary>>,
  Expect<Equal<LibSessionUsage, SessionUsage>>,
  Expect<Equal<LibSessionDetail, SessionDetail>>,
  Expect<Equal<LibPhase, Phase>>,
  Expect<Equal<LibEventRow, Event>>,
  Expect<Equal<LibEventsPage, EventsPage>>,
  Expect<Equal<LibEnvelope, Envelope>>,
  Expect<Equal<LibGateResult, GateResult>>,
  Expect<Equal<LibGateCheck, GateCheck>>,
  Expect<Equal<LibAgentSession, AgentSession>>,
  Expect<Equal<LibAgentStartPayload, AgentStartPayload>>,
  Expect<Equal<LibAgentEndPayload, AgentEndPayload>>,
  Expect<Equal<LibUsageBreakdown, UsageBreakdown>>,
  Expect<Equal<LibToolCallPayload, ToolCallPayload>>,
  Expect<Equal<LibPromptEvent, PromptEvent>>,
  Expect<Equal<LibPromptsResponse, PromptsResponse>>,
  Expect<Equal<LibHealthResponse, HealthResponse>>,
  Expect<Equal<LibSessionStatus, SessionStatus>>,
  Expect<Equal<LibPhaseStatus, PhaseStatus>>,
  Expect<Equal<LibPhaseKind, PhaseKind>>,
  Expect<Equal<LibEventType, EventType>>,
];

describe("types.ts re-export surface", () => {
  test("importing the pure type re-export succeeds and yields no runtime bindings", async () => {
    const mod: Record<string, unknown> = await import("../../src/lib/types.ts");
    // `export type {...}` erases to nothing — the module object carries no
    // own properties beyond Symbol.toStringTag from the ESM interop shim.
    expect(Object.keys(mod)).toEqual([]);
  });

  test("a synthetic object shaped to the re-exported Session type satisfies it (INV-4: synthetic only)", () => {
    const session = {
      request_id: "req-synthetic-1",
      request: "synthetic request",
      status: "success",
      engineer: "engineer-x",
      started_at: "2024-01-01T00:00:00.000Z",
      ended_at: "2024-01-01T00:01:00.000Z",
      duration_ms: 60_000,
      total_tokens: 100,
      total_cost: 1000,
      pipeline_name: "synthetic-pipeline",
      archived: 0,
    } satisfies LibSession;
    expect(session.request_id).toBe("req-synthetic-1");
    expect(session.status).toBe("success");
  });

  test("a synthetic object shaped to the re-exported GateCheck type satisfies it", () => {
    const check = { item: "lint", ok: true, note: "clean" } satisfies LibGateCheck;
    expect(check).toEqual({ item: "lint", ok: true, note: "clean" });
  });
});
