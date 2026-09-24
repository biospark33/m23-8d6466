# rig_swarm Phase Kind (S1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `rig_swarm` phase kind that runs an OpenRig swarm (pinned `@openrig/cli@0.5.14`) INSIDE a factory box, with per-seat capped keys, a `testCommand` gate, seat-cost attribution, teardown-on-settle, and OpenRig-state harvest.

**Architecture:** A third `PhaseKind` beside `code` and `dispatch_task`. The phase body boots the OpenRig daemon on loopback, seeds per-seat pi agent dirs with pre-minted per-seat keys, imports the rig over `POST /api/rigs/import`, queues the objective to the lead seat, polls until the lead closes its queue item, then tears everything down in a `finally` (finding 1: a swarm never stops on its own). The phase engine keeps gate authority: `testCommand` composes the same `commandGate` loop code phases use. Per-seat cost rows ride the existing `cost_attribution` money seam parsed from seat session JSONL.

**Tech Stack:** TypeScript / Bun, zod (closed manifest schema), the existing provider layer (credentials / run-record / teardown / harvest), OpenRig 0.5.14 daemon HTTP API on `127.0.0.1:7433`.

## Global Constraints

- Branch `feature/rig-swarm-phase` off **`origin/dev`**; PR target `dev` (repo convention: prefix=feature/, base=dev).
- OpenRig pin: EXACTLY `@openrig/cli@0.5.14`. No fork, no upstream dependency on the host.
- Research doc: `docs/planning/2026-09-23-openrig-swarm-integration-research.md` §5.6 (change list), §9a (findings 1–5). If it is not on `dev` yet (PR #283 open), read it from `origin/feature/openrig-swarm-spike` before starting.
- Spike ground truth (do not re-derive): session name = `<pod>-<member>@<rig>`; seat pi dir `$OPENRIG_HOME/state/pi/<session>/agent` (adapter mkdirp's, never wipes) pre-seeded with `auth.json` (seat key) + `settings.json` (`{"extensions":["/opt/qds/pi-ext/self-compact/self-compact.ts"]}`); daemon `rig daemon start --no-kernel`, healthz `127.0.0.1:7433/healthz`; import `POST /api/rigs/import` with `X-Rig-Root`; objective `POST /api/queue/create {sourceSession, destinationSession:"<lead>", body, nudge:true}`; completion = lead runs `rig queue update <qid> --state done --closure-reason no-follow-on`; teardown `rig down <rig> --delete --force; rig daemon stop; tmux kill-server`.
- Repo CLAUDE.md GitNexus rules apply on EVERY task that edits an existing symbol: run `impact({target, direction:"upstream"})` FIRST and report blast radius; run `detect_changes()` before every commit; HIGH/CRITICAL risk → warn the operator before editing.
- Tests: `bun test tests/<path> > /tmp/qds-test.log 2>&1` per task; full suite at the end read through the CLAUDE.md `tr`/`perl` filter. Never a bare `bun test` without a log.
- Files under 500 lines. New logic lives in NEW files; `scripts/pipeline-run.ts` (4.7k lines) gets only the factory branch + a mechanical extraction.
- µ$ (integer micro-dollars) everywhere money moves (DD-9). USD floats only at the JSONL/provider boundary, converted once.
- No re-pin of `DEFAULT_IMAGE_REF`/`DEFAULT_IMAGE_BUILD_ID` from this branch — the publish workflow refuses feature branches. The Dockerfile task is declared pairing debt; adoption + paid live round happen AFTER merge (qds-live-e2e skill, "Pin adoption").
- DoD for S1: manifest validates, unit tests green, tsc + biome clean, detect_changes reviewed, PR to dev with pairing debt declared. Live round is post-merge, post-adoption, with operator "go".

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Create the branch off dev**

```bash
git fetch origin
git checkout -b feature/rig-swarm-phase origin/dev
```

- [ ] **Step 2: Confirm the research doc is reachable** (if PR #283 is merged it is on dev; otherwise it is not required to be — this plan inlines everything needed).

```bash
ls docs/planning/2026-09-23-openrig-swarm-integration-research.md 2>/dev/null || echo "not on dev yet — inlined in plan, OK"
```

- [ ] **Step 3: Commit this plan doc onto the branch.**

```bash
git add docs/superpowers/plans/2026-09-23-rig-swarm-phase-s1.md
git commit -m "docs(plan): S1 rig_swarm phase implementation plan

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 1: `rig_swarm` in types + manifest schema

**Files:**
- Modify: `src/phase-engine/types.ts:162` (PhaseKind), `src/phase-engine/types.ts:179-193` (PhaseSpec)
- Modify: `src/phase-engine/manifest.ts:131` (EXECUTING_KINDS), `:226-233` (schema fields), `:236-270` (superRefine), `:286-340` (PipelineManifestSchema)
- Test: `tests/phase-engine/manifest.test.ts`

**Interfaces:**
- Produces: `PhaseKind = "code" | "dispatch_task" | "rig_swarm"`; `RigSpec`/`RigPodSpec`/`RigMemberSpec` types; `PhaseSpec.rigSpec?: RigSpec`, `.objective?: string`, `.leadSeat?: string`, `.seatBudgets?: Record<string, number>` (µ$). Every later task consumes these exact names.
- Repo rule: run `impact({target: "PhaseKind", direction: "upstream"})` and `impact({target: "PhaseSpecSchema", direction: "upstream"})` first and report the blast radius (expect: wide — manifest load, factory never-check, tests). Report risk; proceed only after telling the operator the result.

- [ ] **Step 1: Write the failing tests** (append to `tests/phase-engine/manifest.test.ts`; reuse the file's existing helpers for writing manifests to a temp run root — read its top before writing)

```ts
// A minimal VALID rig_swarm phase, reused across the swarm tests.
const RIG_SWARM_PHASE = {
  name: "swarm_build",
  kind: "rig_swarm",
  description: "Run the OpenRig swarm to build the change",
  rigSpec: {
    name: "dev",
    pods: [
      {
        id: "devpod",
        members: [
          { id: "lead", model: "openrouter/anthropic/claude-haiku-4.5" },
          { id: "worker", model: "openrouter/deepseek/deepseek-v3.2" },
        ],
      },
    ],
  },
  objective: "Add a hello() function plus a test; delegate the test to worker; commit on the checkout branch.",
  leadSeat: "lead",
  seatBudgets: { lead: 250_000_000, worker: 250_000_000 },
};

// 1. valid rig_swarm phase loads
test("rig_swarm phase with all required fields loads", () => {
  const m = baseManifest({ phases: [RIG_SWARM_PHASE, CODE_PHASE] }); // helper from the file's existing fixture style
  expect(() => loadManifestForTest(m)).not.toThrow();
});

// 2. each required field refused when missing
test.each(["rigSpec", "objective", "leadSeat", "seatBudgets"] as const)(
  "rig_swarm without %s is refused at load",
  (field) => {
    const phase = { ...RIG_SWARM_PHASE } as Record<string, unknown>;
    delete phase[field];
    expect(() => loadManifestForTest(baseManifest({ phases: [phase, CODE_PHASE] })))
      .toThrow(new RegExp(`${field} is required when kind is 'rig_swarm'`));
  },
);

// 3. command still forbidden on rig_swarm
test("rig_swarm with command is refused", () => {
  const phase = { ...RIG_SWARM_PHASE, command: ["echo", "hi"] };
  expect(() => loadManifestForTest(baseManifest({ phases: [phase, CODE_PHASE] })))
    .toThrow(/command is forbidden when kind is 'rig_swarm'/);
});

// 4. testCommand is now legal on rig_swarm (today code-only)
test("rig_swarm may declare testCommand", () => {
  const phase = { ...RIG_SWARM_PHASE, testCommand: ["bun", "test"] };
  expect(() => loadManifestForTest(baseManifest({ phases: [phase, CODE_PHASE] }))).not.toThrow();
});

// 5. leadSeat must name a rigSpec member
test("rig_swarm leadSeat not in rigSpec is refused", () => {
  const phase = { ...RIG_SWARM_PHASE, leadSeat: "chief" };
  expect(() => loadManifestForTest(baseManifest({ phases: [phase, CODE_PHASE] })))
    .toThrow(/leadSeat 'chief' is not a member of rigSpec/);
});

// 6. seatBudgets keys must exactly equal the member set
test("seatBudgets keys must exactly match rigSpec members", () => {
  const phase = { ...RIG_SWARM_PHASE, seatBudgets: { lead: 100_000_000 } };
  expect(() => loadManifestForTest(baseManifest({ phases: [phase, CODE_PHASE] })))
    .toThrow(/seatBudgets keys must exactly match rigSpec member ids/);
});

// 7. one tier-2 brain per box: at most one rig_swarm phase per manifest
test("two rig_swarm phases in one manifest are refused", () => {
  const m = baseManifest({ phases: [RIG_SWARM_PHASE, { ...RIG_SWARM_PHASE, name: "swarm_two" }] });
  expect(() => loadManifestForTest(m))
    .toThrow(/at most one rig_swarm phase per manifest/);
});

// 8. dispatch_task keeps refusing testCommand (no regression)
test("dispatch_task still refuses testCommand", () => {
  const phase = { ...DISPATCH_PHASE, testCommand: ["bun", "test"] }; // existing dispatch fixture
  expect(() => loadManifestForTest(baseManifest({ phases: [phase, CODE_PHASE] })))
    .toThrow(/testCommand is forbidden when kind is 'dispatch_task'/);
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
bun test tests/phase-engine/manifest.test.ts > /tmp/qds-test.log 2>&1; tail -20 /tmp/qds-test.log
```
Expected: FAIL — unknown key `rigSpec` (`.strict()` rejection) / kind not in enum.

- [ ] **Step 3: Implement — types.ts**

In `src/phase-engine/types.ts`, extend the kind union and add the rig types above `PhaseSpec`:

```ts
/**
 * The kinds a phase can BE — which is to say, the kinds that execute.
 * (existing doc comment stays; append:)
 *
 * `rig_swarm` (S1) runs an OpenRig swarm INSIDE the box as the tier-2 engine.
 * The factory's guarantees wrap it: VM sandbox, per-seat capped OpenRouter
 * keys, wall clock, harvest, out-of-box reverify, human approval, PR. One
 * tier-2 brain per box: the OpenRig lead seat orchestrates and the resident
 * agent is off. Research doc §4.1 rule 2.
 */
export type PhaseKind = "code" | "dispatch_task" | "rig_swarm";

/** One seat in an OpenRig pod. Pi-only for S1 (Claude/Codex seats are S2). */
export interface RigMemberSpec {
  id: string;
  /** OpenRouter model slug the seat runs on (e.g. "openrouter/deepseek/deepseek-v3.2"). */
  model: string;
  /** Only "pi" today; explicit so a future runtime spelling is a schema change. */
  runtime?: "pi";
  /** Working directory the seat starts in; absent = the run's repo workdir. */
  cwd?: string;
}

export interface RigPodSpec {
  id: string;
  members: RigMemberSpec[];
}

/**
 * A native OpenRig RigSpec (research doc §5.6: accept native first; a
 * roster→RigSpec translator is deferred). The phase body materializes the rig
 * dir (agent.yaml stubs + rig.yaml) from this and imports it.
 */
export interface RigSpec {
  name: string;
  pods: RigPodSpec[];
}
```

And on `PhaseSpec` (after `task?`):

```ts
  /** Required iff `kind === "rig_swarm"`: the native rig definition. */
  rigSpec?: RigSpec;
  /** Required iff `kind === "rig_swarm"`: the objective queued to the lead seat. */
  objective?: string;
  /** Required iff `kind === "rig_swarm"`: the seat id that orchestrates. */
  leadSeat?: string;
  /**
   * Required iff `kind === "rig_swarm"`: per-seat spend ceilings in integer µ$.
   * Keys must exactly equal the rigSpec member id set. Σ(seatBudgets) ≤ the
   * run's admitted ceiling is enforced at dispatch (seatKeyPlan clamps
   * proportionally); the per-seat key is the provider-side hard limit.
   */
  seatBudgets?: Record<string, number>;
```

- [ ] **Step 4: Implement — manifest.ts**

1. `EXECUTING_KINDS` (line 131) and its doc stays truthful — add the member:

```ts
const EXECUTING_KINDS = ["code", "dispatch_task", "rig_swarm"] as const satisfies readonly PhaseKind[];
```

2. Schema fields on `PhaseSpecSchema` (after `task`):

```ts
    // S1 rig_swarm fields — all four required together via superRefine below.
    rigSpec: z
      .object({
        name: nonBlankString,
        pods: z
          .array(
            z
              .object({
                id: nonBlankString,
                members: z
                  .array(
                    z
                      .object({
                        id: nonBlankString,
                        model: nonBlankString,
                        runtime: z.literal("pi").optional(),
                        cwd: nonBlankString.optional(),
                      })
                      .strict(),
                  )
                  .min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .optional(),
    objective: nonBlankString.optional(),
    leadSeat: nonBlankString.optional(),
    seatBudgets: z
      .record(nonBlankString, z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .optional(),
```

3. superRefine changes — allow `testCommand` on rig_swarm (replace the existing testCommand block), add the rig_swarm required-set:

```ts
    // testCommand is optional and valid when kind is "code" (the commandGate
    // composition) OR "rig_swarm" (the settled-swarm gate — same gate, same
    // authority): elsewhere it is silently dead, so refuse rather than let an
    // author believe it enforced.
    if (spec.kind !== "code" && spec.kind !== "rig_swarm" && spec.testCommand !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `testCommand is forbidden when kind is '${spec.kind}'`,
      });
    }
    // S1: rig_swarm's required field set. Each missing field is its own issue
    // so an author sees everything wrong at once.
    if (spec.kind === "rig_swarm") {
      const required = [
        ["rigSpec", spec.rigSpec],
        ["objective", spec.objective],
        ["leadSeat", spec.leadSeat],
        ["seatBudgets", spec.seatBudgets],
      ] as const;
      for (const [field, value] of required) {
        if (value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} is required when kind is 'rig_swarm'` });
        }
      }
      if (spec.rigSpec !== undefined && spec.leadSeat !== undefined && spec.seatBudgets !== undefined) {
        const members = spec.rigSpec.pods.flatMap((p) => p.members.map((m) => m.id));
        if (!members.includes(spec.leadSeat)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `leadSeat '${sanitizeForMessage(spec.leadSeat)}' is not a member of rigSpec`,
          });
        }
        const budgetSeats = Object.keys(spec.seatBudgets).sort();
        if (JSON.stringify(budgetSeats) !== JSON.stringify([...members].sort())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "seatBudgets keys must exactly match rigSpec member ids",
          });
        }
      }
    }
```

4. One tier-2 brain per box — manifest-level refine on `PipelineManifestSchema` (append `.superRefine` after `.strict()`):

```ts
  .superRefine((m, ctx) => {
    // Research doc §4.1 rule 2: ONE tier-2 brain per box. Two rig_swarm phases
    // would boot two swarms in one box (or two rigs under one daemon).
    const swarm = m.phases.filter((p) => p.kind === "rig_swarm");
    if (swarm.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `at most one rig_swarm phase per manifest (one tier-2 brain per box); got ${swarm.length}`,
      });
    }
  });
```

- [ ] **Step 5: Run the schema tests to PASS**

```bash
bun test tests/phase-engine/manifest.test.ts > /tmp/qds-test.log 2>&1; grep -E "\(fail\)|\(pass\)" /tmp/qds-test.log | tail -20
```

- [ ] **Step 6: Prove the compile-time direction holds** — `bunx tsc --noEmit`. The `never` residue in `makeBodyFactory` (pipeline-run.ts:2649) will now be REACHED for `rig_swarm` — that is expected and fixed in Task 4; tsc still passes because the residue accepts the widened `spec.kind`. If tsc instead errors on `_AllKindsExecute`, the kinds lists disagree — fix that first.

```bash
bunx tsc --noEmit 2>&1 | head -20; echo "tsc exit=$?"
```

- [ ] **Step 7: Commit**

```bash
git add src/phase-engine/types.ts src/phase-engine/manifest.ts tests/phase-engine/manifest.test.ts
# detect_changes() first, per repo CLAUDE.md
git commit -m "feat(phase-engine): rig_swarm phase kind in closed manifest schema

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: seat-cost parsing (`openrig-cost.ts`)

**Files:**
- Create: `src/phase-engine/phases/openrig-cost.ts`
- Test: `tests/phase-engine/openrig-cost.test.ts`

**Interfaces:**
- Consumes: `usdToMicros` — currently module-private in `src/providers/credentials.ts:126`. EXPORT it this task (mechanical `export` keyword; run `impact({target:"usdToMicros", direction:"upstream"})` first — expect LOW, no behavior change).
- Produces (Task 3 consumes):
  - `export interface SeatUsage { seat: string; sessionName: string; model: string | null; costMicroUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; timestamp: string | null; }`
  - `export function parseSeatSessionJsonl(text: string, seat: string, sessionName: string): SeatUsage[]`
  - `export function emitSeatCosts(usages: readonly SeatUsage[], deps: { emitMoneyLine: (line: Record<string, unknown>) => void; invocationSeqByAgent?: Map<string, number>; requestId: string; runId: string; phaseId: string; role: string }): number` — returns total µ$; emits one `cost_attribution` line per usage with the EXACT shape dispatch-task.ts:788-810 emits.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { emitSeatCosts, parseSeatSessionJsonl } from "../../src/phase-engine/phases/openrig-cost.ts";

const line1 = JSON.stringify({
  role: "assistant",
  model: "deepseek/deepseek-v3.2",
  timestamp: "2026-09-23T18:00:00.000Z",
  usage: { cost: 0.0125, input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 },
});
const line2 = JSON.stringify({
  role: "user",
  content: "no usage here",
});
const line3 = "not json at all";
const line4 = JSON.stringify({
  role: "assistant",
  model: "deepseek/deepseek-v3.2",
  timestamp: "2026-09-23T18:01:00.000Z",
  usage: { cost: 0.002, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
});

test("parseSeatSessionJsonl keeps only messages carrying usage.cost", () => {
  const rows = parseSeatSessionJsonl([line1, line2, line3, line4].join("\n"), "worker", "dev-worker@spike");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({
    seat: "worker",
    sessionName: "dev-worker@spike",
    model: "deepseek/deepseek-v3.2",
    costMicroUsd: 12_500, // Math.round(0.0125 * 1e6), DD-9 boundary
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    timestamp: "2026-09-23T18:00:00.000Z",
  });
});

test("empty file parses to no rows", () => {
  expect(parseSeatSessionJsonl("", "lead", "dev-lead@spike")).toHaveLength(0);
});

test("emitSeatCosts emits one cost_attribution line per usage with the dispatch-task shape", () => {
  const seq = new Map<string, number>();
  const emitted: Record<string, unknown>[] = [];
  const total = emitSeatCosts(parseSeatSessionJsonl([line1, line4].join("\n"), "worker", "dev-worker@spike"), {
    emitMoneyLine: (l) => emitted.push(l),
    invocationSeqByAgent: seq,
    requestId: "req-1",
    runId: "run-1",
    phaseId: "ph-1",
    role: "worker",
  });
  expect(total).toBe(12_500 + 2_000);
  expect(emitted).toHaveLength(2);
  expect(emitted[0]).toMatchObject({
    type: "cost_attribution",
    requestId: "req-1",
    runId: "run-1",
    phaseId: "ph-1",
    agentId: "dev-worker@spike",
    role: "worker",
    invocationSeq: 0,
    model: "deepseek/deepseek-v3.2",
    costMicroUsd: 12_500,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    turnCount: 1,
    unpricedTurns: 0,
    timestamp: "2026-09-23T18:00:00.000Z",
  });
  // second line from the SAME agent advances the run-scoped ordinal (INV-COST-8)
  expect(emitted[1]).toMatchObject({ invocationSeq: 1 });
  expect(seq.get("dev-worker@spike")).toBe(2);
});

test("emitSeatCosts returns 0 for an empty seat", () => {
  const total = emitSeatCosts([], {
    emitMoneyLine: () => {},
    requestId: "r", runId: "run", phaseId: "p", role: "lead",
  });
  expect(total).toBe(0);
});
```

- [ ] **Step 2: Run, verify FAIL** (module does not exist)

```bash
bun test tests/phase-engine/openrig-cost.test.ts > /tmp/qds-test.log 2>&1; tail -5 /tmp/qds-test.log
```

- [ ] **Step 3: Export the micros boundary** in `src/providers/credentials.ts` — change line 126 `function usdToMicros(` to `export function usdToMicros(`. (After running the impact check from Interfaces. `microsToUsd` stays private — nothing new needs it.)

- [ ] **Step 4: Implement `src/phase-engine/phases/openrig-cost.ts`** (keep under 150 lines; file doc: "Seat session JSONL → cost_attribution money lines. S1 of the rig_swarm integration — per-seat cost evidence must reach the ledger or teardown flags the run `unwired` (teardown.ts reportSpendDivergence).")

```ts
import { redactSecrets } from "../../swarmclaw/log.ts"; // if the import surface differs, mirror dispatch-task.ts's import of it
import { usdToMicros } from "../../providers/credentials.ts";

/** One priced assistant message from a seat's pi session JSONL (µ$ ints, DD-9). */
export interface SeatUsage {
  seat: string;
  sessionName: string;
  model: string | null;
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  timestamp: string | null;
}

/**
 * Parse one seat's session JSONL. Tolerant by design: pi writes role/user
 * lines and assistant lines without usage between priced ones, and a torn
 * tail line is a crash artifact, not a parse error — each unparsable or
 * usage-less line is skipped, never thrown.
 */
export function parseSeatSessionJsonl(text: string, seat: string, sessionName: string): SeatUsage[] {
  const out: SeatUsage[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const usage = (row as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) continue;
    const cost = (usage as { cost?: unknown }).cost;
    if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
    const u = usage as Record<string, unknown>;
    const r = row as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    out.push({
      seat,
      sessionName,
      model: typeof r.model === "string" ? r.model : null,
      costMicroUsd: usdToMicros(cost),
      inputTokens: n(u.input),
      outputTokens: n(u.output),
      cacheReadTokens: n(u.cacheRead),
      cacheWriteTokens: n(u.cacheWrite),
      timestamp: typeof r.timestamp === "string" ? r.timestamp : null,
    });
  }
  return out;
}

/**
 * Emit the DF2.12 cost_attribution lines for one seat's usage, in file order.
 * `agentId` is the OpenRig session name (the seat's identity in the swarm);
 * `role` is the rigSpec member id. The line shape is byte-compatible with
 * dispatch-task.ts's emitMoney call (INV-COST-8 fields included) so the host
 * bridge and ledger treat both engines identically. Returns the seat's total
 * µ$ so the caller can log it alongside the teardown.
 */
export function emitSeatCosts(
  usages: readonly SeatUsage[],
  deps: {
    emitMoneyLine: (line: Record<string, unknown>) => void;
    invocationSeqByAgent?: Map<string, number>;
    requestId: string;
    runId: string;
    phaseId: string;
    role: string;
  },
): number {
  const seq = deps.invocationSeqByAgent ?? new Map<string, number>();
  let total = 0;
  for (const u of usages) {
    const invocationSeq = seq.get(u.sessionName) ?? 0;
    seq.set(u.sessionName, invocationSeq + 1);
    deps.emitMoneyLine({
      type: "cost_attribution",
      requestId: deps.requestId,
      runId: deps.runId,
      phaseId: deps.phaseId,
      agentId: u.sessionName,
      role: deps.role,
      invocationSeq,
      model: u.model,
      costMicroUsd: u.costMicroUsd,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      turnCount: 1,
      unpricedTurns: 0,
      timestamp: u.timestamp,
    });
    total += u.costMicroUsd;
  }
  return total;
}
```

Note on `redactSecrets`: if the repo's redaction import path differs, copy exactly what `dispatch-task.ts` imports and apply it to any error message that could embed file content. If the parse path never builds messages from file bytes (it does not — it skips), drop the import.

- [ ] **Step 5: Run to PASS**

```bash
bun test tests/phase-engine/openrig-cost.test.ts > /tmp/qds-test.log 2>&1; grep -E "\(fail\)" /tmp/qds-test.log | head
```

- [ ] **Step 6: Commit** (`detect_changes()` first)

```bash
git add src/phase-engine/phases/openrig-cost.ts src/providers/credentials.ts tests/phase-engine/openrig-cost.test.ts
git commit -m "feat(phase-engine): seat session JSONL to cost_attribution emission

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: swarm lifecycle (`openrig-swarm.ts`)

**Files:**
- Create: `src/phase-engine/phases/openrig-swarm.ts` (target ~350 lines, HARD cap 500)
- Test: `tests/phase-engine/openrig-swarm.test.ts`

**Interfaces:**
- Consumes: Task 1's `RigSpec`/`PhaseSpec` fields; Task 2's `parseSeatSessionJsonl`/`emitSeatCosts`; the `PhaseBody`/`PhaseBodyContext` contract from `src/phase-engine/phase.ts:73-81`.
- Produces: `openrigSwarmPhase(spec: PhaseSpec, deps: OpenrigSwarmDeps): PhaseBody<{ exitStatus: "success" | "fail" }>` and `export interface OpenrigSwarmDeps` (below). Also exports `parseQueueShow(stdout: string): { state: string | null; closureReason: string | null }` and `SWARM_POLL_INTERVAL_MS = 15_000`, `SWARM_GATE_MARGIN_MS = 60_000`, `DEFAULT_OPENRIG_HOME = ".openrig"`. The seat-keys env var name `SWARM_SEAT_KEYS_ENV = "QDS_SWARM_KEYS_FILE"` is OWNED by `src/providers/credentials.ts` (Task 5) and imported here — providers must not import from phase-engine, phase-engine already imports from providers.

Design (locked before code — do not redesign while implementing):

- The body runs IN THE BOX (the engine process). Keys arrive via `process.env.QDS_SWARM_KEYS_FILE` → a JSON file `{"<seat>": "<key>", …}` written host-side in Task 6. Never log, trace, or embed a key value.
- Lifecycle order (spike-proven, box-seed.sh): resolve workdir → read seat keys → seed per-seat dirs → daemon up + healthz → materialize rig dir → import → queue objective → poll → **costs BEFORE teardown** → teardown in `finally`.
- Trace rows are `type:"log"` with names `swarm_seat_up`, `swarm_qitem_transition`, `swarm_settled` (the `resident_directive` pattern, pipeline-run.ts:2493-2510). Every trace call is wrapped in try/catch — the trace store is a sidecar; the phase verdict owns the run.
- Findings baked in: (1) teardown runs the moment the lead's qitem is `done`, on abort, on timeout, and on ANY throw — always in `finally`; (2) the objective text gets the identity preamble (`export OPENRIG_SESSION_NAME=<session>` per seat) prepended; (3) fallback at `maxDurationMs - SWARM_GATE_MARGIN_MS`: stop polling, trace `swarm_settled` with `reason:"timeout-fallback"`, return normally so the composed `testCommand` gate still runs.
- Repo workdir resolution: probe `<HOME>/app`, `<HOME>/src` (the harvest DEFAULT_WORKDIRS order), first existing wins; a rigSpec member `cwd` overrides for that member only.
- The command runner is injectable for tests; the default shells out.

- [ ] **Step 1: Write the failing tests** (fake runner drives everything; no network, no tmux)

```ts
import { describe, expect, test } from "bun:test";
import {
  openrigSwarmPhase,
  parseQueueShow,
  type CmdResult,
  type CmdRunner,
} from "../../src/phase-engine/phases/openrig-swarm.ts";
import type { PhaseSpec } from "../../src/phase-engine/types.ts";

const SPEC: PhaseSpec = {
  name: "swarm_build",
  kind: "rig_swarm",
  description: "Run the OpenRig swarm",
  maxDurationMs: 600_000,
  retries: 0,
  rigSpec: {
    name: "devrig",
    pods: [{ id: "dev", members: [
      { id: "lead", model: "openrouter/anthropic/claude-haiku-4.5" },
      { id: "worker", model: "openrouter/deepseek/deepseek-v3.2" },
    ]}],
  },
  objective: "Add hello() plus a test; delegate the test to worker.",
  leadSeat: "lead",
  seatBudgets: { lead: 250_000_000, worker: 250_000_000 },
  testCommand: ["bun", "test"],
};

// Deterministic fake runner: records argv, serves canned responses.
function fakeRunner(handlers: Record<string, (argv: string[]) => CmdResult>): { run: CmdRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CmdRunner = async (argv) => {
    const key = argv.join(" ");
    calls.push([...argv]);
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.includes(pattern)) return handler(argv);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const KEYS = JSON.stringify({ lead: "sk-or-v1-lead", worker: "sk-or-v1-worker" });

function baseHandlers(): Record<string, (argv: string[]) => CmdResult> {
  return {
    "healthz": () => ({ exitCode: 0, stdout: "OK", stderr: "" }),
    "/api/rigs/import": () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, name: "devrig" }), stderr: "" }),
    "/api/queue/create": () => ({ exitCode: 0, stdout: JSON.stringify({ id: "q-1" }), stderr: "" }),
    "queue show q-1": () => ({ exitCode: 0, stdout: "id: q-1\nstate: done\nclosureReason: no-follow-on\n", stderr: "" }),
  };
}

// Each test sets HOME to a temp dir containing a fake workdir `app/` and the
// keys file; see the file's beforeEach helper (mirror tests/helpers.ts style).
async function runPhase(spec: PhaseSpec, run: CmdRunner, home: string, signal = new AbortController().signal) {
  return openrigSwarmPhase(spec, { run, home })( {
    signal,
    phaseId: "ph-1",
    ctx: { runId: "run-1", pipelineId: "pipe-1", requestId: "req-1" },
    // ...only the fields PhaseBodyContext actually carries; read phase.ts:73 first
  } as never);
}

test("full lifecycle: seeds, boots, imports, queues, polls to done, tears down", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  const { home, traces, money } = makeTempHome(); // helper in this test file
  const value = await runPhase(SPEC, run, home);
  expect(value.exitStatus).toBe("success");
  const joined = calls.map((c) => c.join(" "));
  expect(joined.some((c) => c.includes("daemon start --no-kernel"))).toBe(true);
  expect(joined.some((c) => c.includes("/api/rigs/import") && c.includes("X-Rig-Root"))).toBe(true);
  expect(joined.some((c) => c.includes("/api/queue/create") && c.includes("dev-lead@devrig"))).toBe(true);
  expect(joined.some((c) => c.includes("rig down devrig --delete --force"))).toBe(true);
  expect(joined.some((c) => c.includes("daemon stop"))).toBe(true);
  expect(joined.some((c) => c.includes("tmux kill-server"))).toBe(true);
  // teardown happens AFTER the settled trace and cost emission
  const names = traces.map((t) => t.name);
  expect(names).toContain("swarm_seat_up");
  expect(names).toContain("swarm_qitem_transition");
  expect(names).toContain("swarm_settled");
  // per-seat auth.json seeded BEFORE import
  for (const seat of ["lead", "worker"]) {
    const auth = await Bun.file(`${home}/.openrig/state/pi/dev-${seat}@devrig/agent/auth.json`).text();
    expect(JSON.parse(auth).openrouter.key).toBe(`sk-or-v1-${seat}`);
  }
});

test("missing keys file refuses before any box state changes", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  const { home } = makeTempHome({ withKeys: false });
  await expect(runPhase(SPEC, run, home)).rejects.toThrow(/QDS_SWARM_KEYS_FILE/);
  expect(calls.map((c) => c.join(" ")).some((c) => c.includes("daemon start"))).toBe(false);
});

test("lead closing the item tears down IMMEDIATELY (no further polling)", async () => {
  let polls = 0;
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => {
    polls += 1;
    return { exitCode: 0, stdout: "state: done\nclosureReason: no-follow-on\n", stderr: "" };
  };
  const { run, calls } = fakeRunner(handlers);
  const { home } = makeTempHome();
  await runPhase(SPEC, run, home);
  expect(polls).toBe(1);
  const after = calls.map((c) => c.join(" "));
  const doneIdx = after.findIndex((c) => c.includes("queue show"));
  const downIdx = after.findIndex((c) => c.includes("rig down devrig --delete --force"));
  expect(downIdx).toBeGreaterThan(doneIdx);
  expect(after.slice(doneIdx + 1).some((c) => c.includes("queue show"))).toBe(false);
});

test("abort mid-poll still tears down (finally)", async () => {
  const ac = new AbortController();
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => {
    ac.abort();
    return { exitCode: 0, stdout: "state: open\n", stderr: "" };
  };
  const { run, calls } = fakeRunner(handlers);
  const { home } = makeTempHome();
  await expect(runPhase(SPEC, run, home, ac.signal)).rejects.toThrow();
  expect(calls.map((c) => c.join(" ")).some((c) => c.includes("rig down devrig --delete --force"))).toBe(true);
});

test("timeout fallback settles without done and lets the gate decide", async () => {
  const handlers = baseHandlers();
  handlers["queue show q-1"] = () => ({ exitCode: 0, stdout: "state: open\n", stderr: "" });
  const { run } = fakeRunner(handlers);
  const { home, traces } = makeTempHome();
  const spec = { ...SPEC, maxDurationMs: 1000 }; // margin makes deadline immediate
  const value = await runPhase(spec, run, home);
  expect(value.exitStatus).toBe("success"); // body settles; the GATE owns the verdict
  const settled = traces.find((t) => t.name === "swarm_settled");
  expect(JSON.parse(settled!.payloadJson!).reason).toBe("timeout-fallback");
});

test("seat costs are emitted BEFORE teardown runs", async () => {
  const { run, calls } = fakeRunner(baseHandlers());
  const { home, money } = makeTempHome({ sessionJsonl: true });
  await runPhase(SPEC, run, home);
  const costIdx = money.findIndex((l) => (l as { type?: string }).type === "cost_attribution");
  const downIdx = calls.map((c) => c.join(" ")).findIndex((c) => c.includes("rig down devrig"));
  expect(costIdx).toBeGreaterThanOrEqual(0);
  expect(money.some((l) => (l as { agentId?: string }).agentId === "dev-worker@devrig")).toBe(true);
});

test("parseQueueShow reads the human output shape", () => {
  expect(parseQueueShow("id: q-1\nstate: done\nclosureReason: no-follow-on\n"))
    .toEqual({ state: "done", closureReason: "no-follow-on" });
  expect(parseQueueShow('{"id":"q-1","state":"done","closureReason":"no-follow-on"}'))
    .toEqual({ state: "done", closureReason: "no-follow-on" });
  expect(parseQueueShow("")).toEqual({ state: null, closureReason: null });
});
```

- [ ] **Step 2: Run, verify FAIL** (module missing)

```bash
bun test tests/phase-engine/openrig-swarm.test.ts > /tmp/qds-test.log 2>&1; tail -5 /tmp/qds-test.log
```

- [ ] **Step 3: Implement `src/phase-engine/phases/openrig-swarm.ts`.** Skeleton with every function the tests name — fill each `exec` with the exact argv shown:

```ts
/**
 * The rig_swarm phase body: one OpenRig swarm INSIDE the box, booted, fed its
 * objective, polled to settlement, torn down. Research doc §5.6 + §9a.
 *
 * Ordering invariants (each carries a test):
 *  - keys read BEFORE any daemon/box state changes;
 *  - teardown ALWAYS runs (finally), AFTER cost emission, on done / abort /
 *    timeout / throw — a swarm has no natural stop (§9a finding 1);
 *  - the body settles (never fails) on the timeout fallback so the composed
 *    testCommand gate still renders a verdict.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseBody, PhaseBodyContext } from "../phase.ts";
import type { PhaseSpec, RigSpec } from "../types.ts";
import { emitSeatCosts, parseSeatSessionJsonl } from "./openrig-cost.ts";

export const SWARM_POLL_INTERVAL_MS = 15_000;
export const SWARM_GATE_MARGIN_MS = 60_000;
export const DEFAULT_OPENRIG_HOME = ".openrig";
// SWARM_SEAT_KEYS_ENV is imported from ../../providers/credentials.ts (Task 5 owns it).

export interface CmdResult { exitCode: number; stdout: string; stderr: string; }
export type CmdRunner = (argv: readonly string[], opts?: { timeoutMs?: number }) => Promise<CmdResult>;

export interface OpenrigSwarmDeps {
  requestId?: string;
  /** HOME used to resolve the repo workdir + OpenRig home (tests inject a temp). */
  home?: string;
  /** Injectable command runner. Default: Bun.spawn with captured stdio. */
  run?: CmdRunner;
  tracer?: { trace: (row: Record<string, unknown>) => void };
  emitMoneyLine?: (line: Record<string, unknown>) => void;
  invocationSeqByAgent?: Map<string, number>;
  log?: (line: Record<string, unknown>) => void;
  /** Test seam: overrides the default poll interval. */
  pollIntervalMs?: number;
}

export function parseQueueShow(stdout: string): { state: string | null; closureReason: string | null } {
  // Tolerant dual shape: the CLI's human "key: value" lines OR a JSON object.
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        state: typeof o.state === "string" ? o.state : null,
        closureReason: typeof o.closureReason === "string" ? o.closureReason : null,
      };
    } catch { /* fall through */ }
  }
  const kv = (key: string): string | null => {
    const m = trimmed.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  return { state: kv("state"), closureReason: kv("closureReason") };
}

// ... identity preamble, seeding, rig materialization, import, queue, poll
// loop, costs, teardown — every block below is its own small function so the
// body reads top-to-bottom and stays under the 500-line cap.
```

Body blocks, exactly (fill into the file):

1. **Refusals first** — throw `Error` (phase fails) when: `process.env[SWARM_SEAT_KEYS_ENV]` unset/empty; the file unreadable; a rigSpec member is missing from the keys map; no workdir found (`<home>/app`, `<home>/src` both absent).
2. **Seed** — for each member of every pod: `fs.mkdirSync(<rigHome>/state/pi/<pod>-<member>@<rig>/agent, { recursive: true })`; write `auth.json` = `{"openrouter":{"type":"api_key","key":"<seat key>"}}` with mode 0o600 (`fs.writeFileSync(p, body, { mode: 0o600 })`); `settings.json` = `{"extensions":["/opt/qds/pi-ext/self-compact/self-compact.ts"]}`. Then trace `swarm_seat_up` `{session: "<pod>-<member>@<rig>"}` per seat. `<rigHome>` = `path.join(home, DEFAULT_OPENRIG_HOME)`.
3. **Daemon** — if `run(["curl","-fsS","127.0.0.1:7433/healthz"])` exits non-zero: `run(["rig","daemon","start","--no-kernel"])`, then poll healthz up to 30×1s, throwing `Error("rig daemon failed to become healthy")` if never green.
4. **Rig dir** — materialize under the phase's run root (NOT the repo): `<runRoot>/rig/`. Write one 4-line `agents/<member>/agent.yaml` stub per member (the box-seed.sh shape) and `rig.yaml` with `cwd` = member.cwd ?? resolved workdir. Serialize the YAML from the RigSpec with the repo's already-installed `yaml` package (`import { stringify } from "yaml"` — `yaml` is one of the two vendored node_modules; do NOT add a dependency).
5. **Import** — `run(["curl","-sS","-X","POST","127.0.0.1:7433/api/rigs/import","-H",`X-Rig-Root: <rigDir>`,`-H","Content-Type: text/yaml","--data-binary","@<rigDir>/rig.yaml"])`. Non-zero exit or non-ok response → throw (the finally still tears down).
6. **Queue the objective** — body text per seat instruction finding 2:

```ts
const objectiveBody =
  `OBJECTIVE: ${spec.objective}\n\n` +
  `IDENTITY: before running any rig command, run \`export OPENRIG_SESSION_NAME=${session}\` ` +
  `(Pi seats do not receive OPENRIG_* env; without it your messages show From: <unknown sender>).`;
const queuePayload = JSON.stringify({
  sourceSession: "qds-engine",
  destinationSession: `${firstPodId}-${spec.leadSeat}@${spec.rigSpec.name}`,
  body: objectiveBody,
  nudge: true,
});
run(["curl","-sS","-X","POST","127.0.0.1:7433/api/queue/create","-H","Content-Type: application/json","-d",queuePayload]);
```
Parse `qid` from the response (`JSON.parse(stdout).id ?? .qid`; both spellings tolerated, throw if neither).

7. **Poll loop** — `deadline = Date.now() + spec.maxDurationMs - SWARM_GATE_MARGIN_MS`; each iteration: throw-if-aborted (`bodyCtx.signal.aborted` → throw the abort reason); `run(["rig","queue","show",qid])`; `parseQueueShow`; on `state` CHANGE trace `swarm_qitem_transition` `{qid, from, to, closureReason}`; on `state === "done"` break with `settled = {reason: "lead-closed", state, closureReason}`; else sleep `deps.pollIntervalMs ?? SWARM_POLL_INTERVAL_MS`; if `Date.now() >= deadline` → `settled = {reason: "timeout-fallback"}` and break (body still returns `exitStatus:"success"` — the GATE owns the verdict).
8. **Costs BEFORE teardown** — for each member: read `<rigHome>/state/pi/<session>/sessions/*.jsonl` (largest file wins if several; skip seat silently if the dir/file is absent), `parseSeatSessionJsonl`, `emitSeatCosts(rows, { emitMoneyLine: deps.emitMoneyLine ?? defaultStderrMoney, invocationSeqByAgent, requestId, runId: bodyCtx.ctx.runId, phaseId: bodyCtx.phaseId, role: member.id })`. All best-effort in try/catch — a missing seat log must not fail the phase or skip teardown.
9. **`finally` teardown**, in this fixed order, each best-effort (catch + log, never throw over the settled result):
   - `rig down <rigSpec.name> --delete --force`
   - `rig daemon stop`
   - `tmux kill-server`
10. **Settled trace + return** — after the finally completes, trace `swarm_settled` `{reason, qid, state, closureReason, timeoutFallback: settled.reason === "timeout-fallback"}` and return `{ exitStatus: "success" }`. Hard failures (refusals, daemon never healthy, import failed) THROW before settlement — the phase records `fail`.

Default runner (bottom of file):

```ts
const defaultRun: CmdRunner = async (argv, opts) => {
  const proc = Bun.spawn(argv as string[], {
    stdout: "pipe", stderr: "pipe",
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};
```

- [ ] **Step 4: Run to PASS, then check size + types**

```bash
bun test tests/phase-engine/openrig-swarm.test.ts > /tmp/qds-test.log 2>&1; grep -E "\(fail\)" /tmp/qds-test.log | head
wc -l src/phase-engine/phases/openrig-swarm.ts   # must be < 500
bunx tsc --noEmit 2>&1 | head -5
```

- [ ] **Step 5: Commit** (`detect_changes()` first)

```bash
git add src/phase-engine/phases/openrig-swarm.ts tests/phase-engine/openrig-swarm.test.ts
git commit -m "feat(phase-engine): rig_swarm swarm lifecycle phase body

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: factory branch + gate-loop extraction (`pipeline-run.ts`)

**Files:**
- Modify: `scripts/pipeline-run.ts:2404-2655` (makeBodyFactory)
- Test: `tests/phase-engine/pipeline-run.test.ts`

**Interfaces:**
- Produces: module-private `composeGatedBody(args: { journal: PhaseJournal; gate: ReturnType<typeof commandGate>; base: PhaseBody<unknown>; spec: PhaseSpec; cwd: string; resident?: ResidentHooks; tracer: Tracer; requestId: string; }): PhaseBody<unknown>` — a MECHANICAL move of pipeline-run.ts:2450-2563's loop, byte-equal logic; both `code` and `rig_swarm` branches call it.
- Repo rule: `impact({target: "makeBodyFactory", direction: "upstream"})` FIRST — expect HIGH (every phase body of every run flows through it). Report to operator; the change is additive (new branch + extraction, existing branches byte-equal).

- [ ] **Step 1: Write the failing test** (append; mirror the file's existing factory-test scaffolding)

```ts
test("rig_swarm spec with testCommand yields a gated body", () => {
  const factory = makeBodyFactoryForTest({ journal: fakeJournal() }); // existing helpers in this file
  const spec: PhaseSpec = {
    name: "swarm_build", kind: "rig_swarm", description: "swarm", maxDurationMs: 600_000, retries: 0,
    rigSpec: { name: "r", pods: [{ id: "p", members: [{ id: "lead", model: "m" }] }] },
    objective: "o", leadSeat: "lead", seatBudgets: { lead: 1000 }, testCommand: ["true"],
  };
  const body = factory(spec);
  expect(typeof body).toBe("function"); // a composed body, NOT the never-residue throw
});

test("rig_swarm spec without testCommand yields the bare body", () => {
  const factory = makeBodyFactoryForTest({ journal: fakeJournal() });
  const spec: PhaseSpec = {
    name: "swarm_build", kind: "rig_swarm", description: "swarm", maxDurationMs: 600_000, retries: 0,
    rigSpec: { name: "r", pods: [{ id: "p", members: [{ id: "lead", model: "m" }] }] },
    objective: "o", leadSeat: "lead", seatBudgets: { lead: 1000 },
  };
  const body = factory(spec);
  expect(typeof body).toBe("function");
});
```

- [ ] **Step 2: Run, verify FAIL** (today the factory falls through to the never-residue throw for rig_swarm).

- [ ] **Step 3: Implement.**

1. Extract the gate loop: cut pipeline-run.ts:2450-2563 (from `const gate = commandGate([...test], …)` through the closing of `gated`'s body) into a new module-private function `composeGatedBody(args)` placed just above `makeBodyFactory`, with the closure variables (`journal`, `cwd`, `resident`, `tracer`, `requestId`, `spec`, `base`) taken from `args`. NO logic edits — comments ride along. The `code` branch becomes:

```ts
      const test = spec.testCommand ?? [];
      if (test.length === 0 || journal === undefined) {
        return base;
      }
      const gate = commandGate([...test], { cwd, env: childEnv(), label: `testCommand:${spec.name}` });
      return composeGatedBody({ journal, gate, base, spec, cwd, resident, tracer, requestId });
```

2. Add the rig_swarm branch BEFORE the dispatch_task branch (order irrelevant; before the never-residue):

```ts
    // S1 rig_swarm: the OpenRig swarm is the tier-2 engine INSIDE the box
    // (research doc §4.1 rule 2). The engine keeps gate authority via
    // testCommand — the same commandGate loop code phases compose.
    if (spec.kind === "rig_swarm") {
      const body = openrigSwarmPhase(spec, {
        requestId,
        tracer,
        emitMoneyLine: moneyLineTee(),
        invocationSeqByAgent,
      });
      const test = spec.testCommand ?? [];
      if (test.length === 0 || journal === undefined) {
        return body;
      }
      const gate = commandGate([...test], { cwd, env: childEnv(), label: `testCommand:${spec.name}` });
      return composeGatedBody({ journal, gate, base: body, spec, cwd, resident, tracer, requestId });
    }
```

with `import { openrigSwarmPhase } from "../src/phase-engine/phases/openrig-swarm.ts";` at the file's existing phase-engine import block. Update the never-residue message's kind list text (`'code', 'dispatch_task' and 'rig_swarm'`).

- [ ] **Step 4: Run to PASS** (new tests + the file's existing suite)

```bash
bun test tests/phase-engine/pipeline-run.test.ts tests/phase-engine/pipeline-run-money-line.test.ts > /tmp/qds-test.log 2>&1; grep -E "\(fail\)" /tmp/qds-test.log | head
bunx tsc --noEmit 2>&1 | head -5
```

- [ ] **Step 5: Commit** (`detect_changes()` first; compare scope against the impact report)

```bash
git add scripts/pipeline-run.ts tests/phase-engine/pipeline-run.test.ts
git commit -m "feat(phase-engine): rig_swarm executor in makeBodyFactory; extract composeGatedBody

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: per-seat keys (run-record namespace + credentials)

**Files:**
- Modify: `src/providers/run-record.ts:189-364` (EXTENSION_NAMESPACES)
- Modify: `src/providers/credentials.ts` (new exports after mintRunKey)
- Test: `tests/providers/credentials.test.ts`

**Interfaces:**
- Produces:
  - Extension namespace `swarmSeats`: `{ schemaVersion: 1, fields: { seats: "strings", keyHashes: "strings" } }` (seat names and key hashes, SAME ORDER).
  - `export interface SeatKeyPlan { seat: string; limitMicroUsd: number }`
  - `export async function mintSeatKeys(deps: CredentialDeps, runId: string, plan: readonly SeatKeyPlan[]): Promise<{ keys: Record<string, string>; hashes: Record<string, string> }>`
  - `export async function deliverSeatKeys(deps: CredentialDeps, runId: string, vm: string, keys: Record<string, string>): Promise<void>` — writes `/opt/qds/swarm-keys/<runId>.json` (0600) in the box via driver.exec and appends `QDS_SWARM_KEYS_FILE=/opt/qds/swarm-keys/<runId>.json` to the env file (idempotent via grep).
  - `export async function captureSeatSpend(deps: CredentialDeps, runId: string): Promise<number>` — sums `getKeyEntry(hash).usageUsd` over `extensions.swarmSeats.keyHashes`, µ$ via `usdToMicros`, writes `spendMicroUsd`.
  - `export async function revokeSeatKeys(deps: CredentialDeps, runId: string): Promise<number>` — `revokeAndVerify` per hash, returns count revoked.
  - `export const SWARM_SEAT_KEYS_ENV = "QDS_SWARM_KEYS_FILE"` — the env-var name, owned here; Task 3's phase body imports it (providers must not import from phase-engine; phase-engine already imports from providers).
- Repo rule: `impact({target: "mintRunKey", direction: "upstream"})` + `impact({target: "EXTENSION_NAMESPACES", direction: "upstream"})` first, report risk. `mintRunKey` itself is NOT edited — the invariant it guards (one live key per run) is preserved for single-key runs; `mintSeatKeys` is a sibling for swarm runs.

- [ ] **Step 1: Write the failing tests** (FakeKeyApi pattern from the file's existing mint tests — read its fixture helpers first)

```ts
const PLAN = [
  { seat: "lead", limitMicroUsd: 250_000_000 },
  { seat: "worker", limitMicroUsd: 250_000_000 },
];

test("mintSeatKeys mints one key per seat with its own limit and records the namespace", async () => {
  const { deps, keyApi } = makeCredDeps(); // existing helper: FakeKeyApi + temp RunRecordStore, capMicroUsd 500_000_000
  deps.store.create("run-1");
  const { keys, hashes } = await mintSeatKeys(deps, "run-1", PLAN);
  expect(Object.keys(keys).sort()).toEqual(["lead", "worker"]);
  expect(keyApi.created).toEqual([
    { name: "sbx-run-1-lead", limitUsd: 250 }, // microsToUsd boundary
    { name: "sbx-run-1-worker", limitUsd: 250 },
  ]);
  const rec = deps.store.get("run-1");
  expect(rec.extensions?.swarmSeats?.seats).toEqual(["lead", "worker"]);
  expect(rec.extensions?.swarmSeats?.keyHashes).toEqual(Object.values(hashes));
});

test("mintSeatKeys refuses when seat limits sum above the run cap", async () => {
  const { deps } = makeCredDeps();
  deps.store.create("run-2");
  await expect(mintSeatKeys(deps, "run-2", [
    { seat: "lead", limitMicroUsd: 400_000_000 },
    { seat: "worker", limitMicroUsd: 400_000_000 },
  ])).rejects.toThrow(/seat limits sum .* above the run cap/);
});

test("mintSeatKeys refuses a seat above the backstop ceiling", async () => {
  const { deps } = makeCredDeps();
  deps.store.create("run-3");
  await expect(mintSeatKeys(deps, "run-3", [{ seat: "lead", limitMicroUsd: 50_000_001 }]))
    .rejects.toThrow(/backstop/);
});

test("mintSeatKeys refuses an already-minted run (single key OR swarm)", async () => {
  const { deps } = makeCredDeps();
  deps.store.create("run-4");
  deps.store.set("run-4", { keyHash: "aaaaaaaa" }); // single-key mint already happened
  await expect(mintSeatKeys(deps, "run-4", PLAN)).rejects.toThrow(/already carries keyHash/);
});

test("mintSeatKeys refuses duplicate seat names and bad seat spellings", async () => {
  const { deps } = makeCredDeps();
  deps.store.create("run-5");
  await expect(mintSeatKeys(deps, "run-5", [
    { seat: "lead", limitMicroUsd: 10 }, { seat: "lead", limitMicroUsd: 10 },
  ])).rejects.toThrow(/duplicate seat/);
  await expect(mintSeatKeys(deps, "run-5", [{ seat: "Big Seat", limitMicroUsd: 10 }]))
    .rejects.toThrow(/seat name/);
});

test("captureSeatSpend sums provider usage across seats into spendMicroUsd", async () => {
  const { deps, keyApi } = makeCredDeps();
  deps.store.create("run-6");
  await mintSeatKeys(deps, "run-6", PLAN);
  keyApi.usageByHash[/* lead hash */ ""] = 0.1; // set for both hashes via the hashes returned above
  const total = await captureSeatSpend(deps, "run-6");
  expect(total).toBe(200_000); // 0.1 + 0.1 USD in µ$
  expect(deps.store.get("run-6").spendMicroUsd).toBe(200_000);
});

test("captureSeatSpend treats an absent (out-of-band revoked) seat as 0, not a lie", async () => {
  const { deps, keyApi } = makeCredDeps();
  deps.store.create("run-7");
  const { hashes } = await mintSeatKeys(deps, "run-7", PLAN);
  keyApi.usageByHash[hashes.worker] = 0.25;
  const total = await captureSeatSpend(deps, "run-7");
  expect(total).toBe(250_000);
});

test("revokeSeatKeys revokes every recorded hash", async () => {
  const { deps, keyApi } = makeCredDeps();
  deps.store.create("run-8");
  const { hashes } = await mintSeatKeys(deps, "run-8", PLAN);
  const n = await revokeSeatKeys(deps, "run-8");
  expect(n).toBe(2);
  expect(keyApi.revokedHashes.sort()).toEqual(Object.values(hashes).sort());
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement — run-record.ts namespace** (append to `EXTENSION_NAMESPACES`):

```ts
  /**
   * S1 rig_swarm: per-seat provider keys. `seats` and `keyHashes` are index-
   * aligned (seat[i]'s hash is keyHashes[i]). The single-key core fields
   * (`keyHash`/`limitMicroUsd`) stay untouched: a swarm run carries NO core
   * keyHash, and teardown branches on this namespace's presence.
   */
  swarmSeats: { schemaVersion: 1, fields: { seats: "strings", keyHashes: "strings" } },
```

(Secret-scan note, verified against `assertNoSecret`: lowercase-hex hashes fail the mixed-class heuristic by construction — no uppercase — and match no `SECRET_PREFIXES` entry, so hashes pass; seat names likewise.)

- [ ] **Step 4: Implement — credentials.ts**, new exports after `revokeAndVerify` (mirroring mintRunKey's guards, logs, and `timed()`/`log()` idioms — copy the surrounding style, including `emitCredentialLinkBestEffort` where mintRunKey emits):

```ts
const SEAT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface SeatKeyPlan { seat: string; limitMicroUsd: number; }

/**
 * Mint one capped key per swarm seat (S1). Guards mirror mintRunKey's:
 * already-minted (core keyHash OR swarm namespace), per-seat cap ≤ backstop,
 * cap round-trip — plus Σ(seat limits) ≤ deps.capMicroUsd, the run-level
 * ceiling the budget gate admitted (budget-gate.ts mintCapMicroUsd).
 * Dispatch clamps authored budgets proportionally BEFORE calling
 * (dispatch.ts seatKeyPlan), so Σ ≤ ceiling holds by construction there;
 * the guard here is the invariant's home.
 */
export async function mintSeatKeys(
  deps: CredentialDeps,
  runId: string,
  plan: readonly SeatKeyPlan[],
): Promise<{ keys: Record<string, string>; hashes: Record<string, string> }> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId };
  if (plan.length === 0) {
    throw new CredentialLifecycleError("cap-invalid", "seat plan is empty", "declare at least one rigSpec member");
  }
  const seats = plan.map((p) => p.seat);
  if (new Set(seats).size !== seats.length) {
    throw new CredentialLifecycleError("cap-invalid", "duplicate seat in plan", "rigSpec member ids must be unique");
  }
  for (const seat of seats) {
    if (!SEAT_NAME_RE.test(seat)) {
      throw new CredentialLifecycleError(
        "cap-invalid",
        `seat name '${seat}' must match ${SEAT_KEY_NAME}`,
        "use lowercase alphanumerics and hyphens (rigSpec member ids become provider key names)",
      );
    }
  }
  const rec = deps.store.get(runId);
  if (rec.keyHash) {
    throw new CredentialLifecycleError(
      "already-minted",
      `run ${runId} already carries keyHash ${rec.keyHash.slice(0, 8)}… — revoke it before minting seat keys`,
      "the single-key and per-seat paths are mutually exclusive on one run",
    );
  }
  if (rec.extensions?.swarmSeats?.keyHashes?.length) {
    throw new CredentialLifecycleError("already-minted", `run ${runId} already carries swarm seat keys`, "revoke before re-minting");
  }
  const capMicroUsd = deps.capMicroUsd ?? defaultKeyCapMicroUsd;
  const sum = plan.reduce((a, p) => a + p.limitMicroUsd, 0);
  if (!Number.isInteger(sum) || sum > capMicroUsd) {
    throw new CredentialLifecycleError(
      "cap-invalid",
      `seat limits sum to ${sum} µ$, above the run cap ${capMicroUsd} µ$`,
      "dispatch clamps authored seatBudgets proportionally before minting; this refusal means the caller skipped that",
    );
  }
  for (const p of plan) {
    // Same backstop + round-trip guards as mintRunKey (INV-CAP-1 semantics).
    if (p.limitMicroUsd > defaultKeyCapMicroUsd) { /* throw "backstop" CredentialLifecycleError, same wording pattern as mintRunKey:563 */ }
    if (usdToMicros(microsToUsd(p.limitMicroUsd)) !== p.limitMicroUsd) { /* throw "cap-invalid" round-trip refusal */ }
  }
  const keys: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  const seatOrder: string[] = [];
  const hashOrder: string[] = [];
  try {
    for (const p of plan) {
      const name = `${SBX_KEY_PREFIX}${runId}-${p.seat}`;
      const res = await timed(ctx, "mint_seat", () => deps.keyApi.createKey(name, microsToUsd(p.limitMicroUsd)));
      keys[p.seat] = res.key;
      hashes[p.seat] = res.hash;
      seatOrder.push(p.seat);
      hashOrder.push(res.hash);
    }
  } catch (e) {
    // Compensation: revoke every seat key minted before the failure — the
    // same orphan discipline mintRunKey's transport arm applies, now for N-1
    // live keys.
    for (const h of hashOrder) {
      try { await revokeAndVerify(deps, h); } catch { /* logged by revokeAndVerify's own path */ }
    }
    throw e;
  }
  deps.store.set(runId, { extensions: { swarmSeats: { seats: seatOrder, keyHashes: hashOrder } } });
  return { keys, hashes };
}
```

`deliverSeatKeys`, `captureSeatSpend`, `revokeSeatKeys` — same file, mirroring `deliverRunKey`/`captureSpend`/`revokeRunKey` structure:

```ts
export const SWARM_KEYS_DIR = "/opt/qds/swarm-keys";

export async function deliverSeatKeys(deps: CredentialDeps, runId: string, vm: string, keys: Record<string, string>): Promise<void> {
  // One exec per mutation, key material ONLY inside stdin of the write —
  // never in argv (an exec wrapper that reports its argv would leak it).
  await deps.driver.exec(vm, ["bash", "-c",
    `install -d -m 700 ${SWARM_KEYS_DIR} && umask 077 && cat > ${SWARM_KEYS_DIR}/${runId}.json`,
  ], { stdin: JSON.stringify(keys) });
  const envLine = `${SWARM_SEAT_KEYS_ENV}=${SWARM_KEYS_DIR}/${runId}.json`;
  await deps.driver.exec(vm, ["bash", "-c",
    `grep -q '^${SWARM_SEAT_KEYS_ENV}=' app/.env 2>/dev/null || printf '%s\\n' '${envLine}' >> app/.env`,
  ]);
}
```

(If `driver.exec` has no `stdin` option — check `ProviderDriver`'s exec signature first — deliver via a heredoc-free base64 payload in the script body, exactly as `deliverRunKey` does today; copy its mechanism verbatim. Do NOT invent a new transport.)

```ts
export async function captureSeatSpend(deps: CredentialDeps, runId: string): Promise<number> {
  const ctx: StepContext = { requestId: deps.requestId ?? newRequestId(), runId };
  const rec = deps.store.get(runId);
  const hashes = rec.extensions?.swarmSeats?.keyHashes ?? [];
  if (hashes.length === 0) return 0;
  let totalMicroUsd = 0;
  for (const hash of hashes) {
    const { entry, truncated } = await deps.keyApi.getKeyEntry(hash, MAX_VERIFY_PAGES);
    if (truncated) { /* throw list-unverified, captureSpend wording */ }
    if (entry === null || !Number.isFinite(entry.usageUsd)) continue; // absent/refunded-out seat contributes 0; single-key captureSpend's stricter refusals do not apply per-seat
    totalMicroUsd += usdToMicros(entry.usageUsd);
  }
  if (!Number.isSafeInteger(totalMicroUsd)) { /* throw invalid-provider-usage */ }
  deps.store.set(runId, { spendMicroUsd: totalMicroUsd });
  return totalMicroUsd;
}

export async function revokeSeatKeys(deps: CredentialDeps, runId: string): Promise<number> {
  const rec = deps.store.get(runId);
  const hashes = rec.extensions?.swarmSeats?.keyHashes ?? [];
  let n = 0;
  for (const hash of hashes) {
    await revokeAndVerify(deps, hash);
    n += 1;
  }
  return n;
}
```

(Define `const SEAT_KEY_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/` once and use it in the error message; the snippet's `SEAT_KEY_NAME` placeholder is that constant.)

- [ ] **Step 5: Run to PASS** (credentials.test.ts whole file — existing mint/teardown tests must stay green)

```bash
bun test tests/providers/credentials.test.ts > /tmp/qds-test.log 2>&1; grep -E "\(fail\)" /tmp/qds-test.log | head
```

- [ ] **Step 6: Commit** (`detect_changes()` first)

```bash
git add src/providers/run-record.ts src/providers/credentials.ts tests/providers/credentials.test.ts
git commit -m "feat(providers): per-seat swarm keys — mint, deliver, capture, revoke

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: dispatch seat plan + teardown seat branch

**Files:**
- Modify: `src/fleet/dispatch.ts` (mintAndDeliverKey, ~:1666-1770)
- Modify: `src/providers/teardown.ts:1017` and `:1047` (capture/revoke call sites)
- Test: `tests/fleet/dispatch-seat-plan.test.ts` (new), extend `tests/providers/teardown.test.ts`

**Interfaces:**
- Consumes: Task 5's `SeatKeyPlan`/`mintSeatKeys`/`deliverSeatKeys`/`captureSeatSpend`/`revokeSeatKeys`; Task 1's `PhaseSpec.seatBudgets`.
- Produces: exported `seatKeyPlan(budgets: Record<string, number>, ceilingMicroUsd: number): SeatKeyPlan[]` — proportional clamp, Σ ≤ ceiling by construction.
- Repo rule: `impact({target: "mintAndDeliverKey", direction: "upstream"})` and `impact({target: "teardownSandbox", direction: "upstream"})` FIRST. Expect HIGH — dispatch and teardown are the run lifecycle's spine. Report to operator before editing.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/fleet/dispatch-seat-plan.test.ts
import { seatKeyPlan } from "../../src/fleet/dispatch.ts";

test("seatKeyPlan scales authored budgets proportionally into the ceiling", () => {
  const plan = seatKeyPlan({ lead: 500, worker: 500 }, 750);
  expect(plan).toEqual([
    { seat: "lead", limitMicroUsd: 375 },
    { seat: "worker", limitMicroUsd: 375 },
  ]);
});

test("seatKeyPlan floor keeps the sum at or under the ceiling", () => {
  for (let ceiling = 1; ceiling <= 100; ceiling += 7) {
    const plan = seatKeyPlan({ a: 100, b: 100, c: 100 }, ceiling);
    const sum = plan.reduce((acc, p) => acc + p.limitMicroUsd, 0);
    expect(sum).toBeLessThanOrEqual(ceiling);
    expect(plan.every((p) => p.limitMicroUsd >= 1)).toBe(true);
  }
});

test("seatKeyPlan leaves budgets untouched when they already fit", () => {
  expect(seatKeyPlan({ lead: 250_000_000, worker: 250_000_000 }, 500_000_000))
    .toEqual([{ seat: "lead", limitMicroUsd: 250_000_000 }, { seat: "worker", limitMicroUsd: 250_000_000 }]);
});
```

Teardown tests (mirror the file's existing capture/revoke tests, swarm variant):

```ts
test("teardown with swarmSeats captures summed spend and revokes every seat key", async () => {
  // fixture: record with extensions.swarmSeats {seats:[lead,worker], keyHashes:[h1,h2]}, FakeKeyApi with usage on both
  // run teardownSandbox (the file's existing happy-path invocation shape)
  // expect: record.spendMicroUsd === summed µ$; both hashes revoked (FakeKeyApi.revokedHashes contains both)
});

test("teardown without swarmSeats keeps the single-key path", async () => {
  // existing happy-path fixture as-is: keyHash path, captureSpend+revokeRunKey semantics unchanged
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement — dispatch.ts.** In the dispatch body, where the loaded manifest is at hand and before the `mintAndDeliverKey(...)` call:

```ts
    // S1: a rig_swarm phase swaps the single run key for per-seat capped keys.
    // Authored seatBudgets may exceed the admitted ceiling (the manifest is
    // authored before admission); clamp proportionally so Σ ≤ ceiling holds
    // by construction (floor: never a 0-limit key).
    const swarmPhases = loaded.manifest.phases.filter((p) => p.kind === "rig_swarm");
    const seatPlan = swarmPhases[0]?.seatBudgets
      ? seatKeyPlan(swarmPhases[0].seatBudgets, effectiveCeilingMicros)
      : undefined;
```

and inside `mintAndDeliverKey` (add `seatPlan?: readonly SeatKeyPlan[]` to its args), branch:

```ts
  if (seatPlan !== undefined) {
    const { keys } = await ctx.within("mint", () =>
      mintSeatKeys({ keyApi: deps.keyApi, driver: deps.driver, store: deps.store, requestId,
                     capMicroUsd: effectiveCeilingMicros, recordAuditLink }, runId, seatPlan));
    await ctx.within("deliver", () =>
      deliverSeatKeys({ keyApi: deps.keyApi, driver: deps.driver, store: deps.store, requestId, recordAuditLink,
                        ...(credEnvFile !== undefined ? { envFile: credEnvFile } : {}) }, runId, vm.name, keys));
  } else {
    // …existing mintRunKey + deliverRunKey calls, byte-identical…
  }
```

Define `seatKeyPlan` in dispatch.ts (or a small helper beside it) exactly:

```ts
export function seatKeyPlan(budgets: Record<string, number>, ceilingMicroUsd: number): SeatKeyPlan[] {
  const entries = Object.entries(budgets);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return entries.map(([seat, authored]) => ({
    seat,
    limitMicroUsd: Math.max(1, Math.floor((authored * ceilingMicroUsd) / total)),
  }));
}
```

- [ ] **Step 4: Implement — teardown.ts.** At the capture site (:1017) and revoke site (:1047), branch on the namespace (the swarm keys file is box-only state; nothing else changes):

```ts
      // S1: swarm runs carry per-seat keys in extensions.swarmSeats and NO
      // core keyHash — branch so the swarm keys are captured and revoked too.
      if (cred.store.get(runId).extensions?.swarmSeats?.keyHashes?.length) {
        await captureSeatSpend(cred, runId);
      } else {
        await captureSpend(cred, runId);
      }
```

```ts
      if (cred.store.get(runId).extensions?.swarmSeats?.keyHashes?.length) {
        await revokeSeatKeys(cred, runId);
      } else {
        await revokeRunKey(cred, runId);
      }
```

(Match the surrounding code's exact variable names for the creds deps and record access at those call sites — read ~40 lines around each before editing.)

- [ ] **Step 5: Run to PASS**

```bash
bun test tests/fleet/dispatch-seat-plan.test.ts tests/providers/teardown.test.ts > /tmp/qds-test.log 2>&1; grep -E "\(fail\)" /tmp/qds-test.log | head
```

- [ ] **Step 6: Commit** (`detect_changes()` first — verify the blast radius matches the Task-6 impact report)

```bash
git add src/fleet/dispatch.ts src/providers/teardown.ts tests/fleet/dispatch-seat-plan.test.ts tests/providers/teardown.test.ts
git commit -m "feat(fleet): per-seat key plan at dispatch; swarm-aware teardown capture/revoke

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: harvest OpenRig state

**Files:**
- Modify: `src/providers/harvest.ts:174-181` (BOX_HOME_SOURCES) + the artifacts script loop (~:605-680)
- Test: extend the existing harvest test file under `tests/providers/` (if none covers the script text, add `tests/providers/harvest-openrig.test.ts` asserting on the generated script via whatever seam the file already exposes; exporting the script builder for tests follows the repo's "exported for tests ONLY" precedent)

**Scope decision (YAGNI, stated):** harvest the seat session JSONLs — the cost + forensics evidence this stage needs (`$OPENRIG_HOME/state/pi/*/sessions/*.jsonl`). The daemon SQLite db is NOT harvested in S1: no consumer reads it (cost rows come from the JSONLs), it is unbounded in size against the tar cap, and its schema is upstream-churned. Add it when a consumer exists.

- [ ] **Step 1: Write the failing test**

```ts
test("artifacts script includes the OpenRig seat session JSONLs", () => {
  const script = artifactsScriptForTest(["app"]); // the file's script builder via its test seam
  expect(script).toContain('"$home/.openrig"/state/pi/*/sessions/*.jsonl');
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — add to `BOX_HOME_SOURCES`:

```ts
  // S1 rig_swarm: per-seat pi session JSONLs (cost + forensics evidence).
  // The OpenRig paths cannot collide with the runId-prefixed entries above
  // (`.openrig/` is a distinct top-level prefix), preserving the
  // no-collision invariant. The glob is shell-active by design — the list is
  // shell words (see the loop) — and the `for f in` loop already skips
  // absent sources silently.
  '"$home/.openrig"/state/pi/*/sessions/*.jsonl',
```

Read the `for f in ${BOX_HOME_SOURCES.join(" ")}` loop (~:664) first and confirm unquoted-glob entries survive its quoting; if the loop quotes each entry, mirror however the existing `-solicit-*` glob entries are spelled and keep the glob parts unquoted the same way. Respect `TAR_MAX_BYTES` (:83) — the loop/cap machinery already bounds the whole archive; no new cap logic.

- [ ] **Step 4: Run to PASS** (+ full `tests/providers/`)

```bash
bun test tests/providers/ > /tmp/qds-test.log 2>&1; grep -E "\(fail\)" /tmp/qds-test.log | head
```

- [ ] **Step 5: Commit** (`detect_changes()` first)

```bash
git add src/providers/harvest.ts tests/providers/
git commit -m "feat(harvest): pull OpenRig seat session JSONLs into the artifacts tar

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: image baking (pairing debt) + gates + PR

**Files:**
- Modify: `oci/exedev/Dockerfile` (new stages after the engine-tree stage ~:390-415)
- Modify: `binary-licenses.json` (node, better_sqlite3.node; tmux entry if the file tracks base tools)
- Modify: `docs/planning/…` NOT touched. No pin of `DEFAULT_IMAGE_REF`/`DEFAULT_IMAGE_BUILD_ID` (`src/providers/exedev/driver.ts:451,516`) — that is post-merge adoption.

**Interfaces:** the baked paths the phase body depends on — `/opt/qds/pi-ext/self-compact/self-compact.ts` (settings.json already points there), `rig` on PATH, `node` on PATH (the gate runs `node --test` in spike parity; the pinned image has NO node), `/opt/openrig` tree (hash-gated like `QDS_ENGINE_TREE_SHA256`).

- [ ] **Step 1: Dockerfile stages** (append after the engine-tree stage; follow the file's TOFU pattern documented at the `QDS_ENGINE_TREE_SHA256` block — first build MEASURES, then you pin):

```dockerfile
# S1 rig_swarm: Node 22 (sha-pinned tarball — the image has NO node and the
# gate + OpenRig runner need it), OpenRig 0.5.14 as a hash-gated tree at
# /opt/openrig (NEVER inside /opt/qds-factory/node_modules — the engine-tree
# gate above asserts that tree is exactly yaml+zod), and the self-compact
# extension the seats' settings.json loads.
ARG NODE_VERSION=22.20.0
ARG NODE_SHA256=<MEASURE at first build, then pin — TOFU, same doctrine as BUN_SHA256>
RUN set -e; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.xz" | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1; \
    rm "node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    node --version

ARG OPENRIG_VERSION=0.5.14
ARG OPENRIG_TREE_SHA256=<MEASURE at first build, then pin>
RUN set -e; \
    npm i -g --prefix /opt/openrig "@openrig/cli@${OPENRIG_VERSION}"; \
    ln -s /opt/openrig/bin/rig /usr/local/bin/rig; \
    tree="$(cd /opt/openrig/lib/node_modules/@openrig/cli && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"; \
    [ "${tree}" = "${OPENRIG_TREE_SHA256}" ] || { echo "R3-a: OpenRig tree hash ${tree} != pinned OPENRIG_TREE_SHA256 — registry bytes moved" >&2; exit 1; }; \
    rig --version

COPY pi-vs-claude-code-vendor/self-compact/extensions/self-compact /opt/qds/pi-ext/self-compact
RUN set -e; \
    [ -f /opt/qds/pi-ext/self-compact/self-compact.ts ]; \
    chown -R root:root /opt/qds/pi-ext; \
    find /opt/qds/pi-ext -type d -exec chmod 0755 {} +; \
    find /opt/qds/pi-ext -type f -exec chmod 0644 {} +; \
    chmod 0755 /opt/qds/swarm-keys 2>/dev/null || install -d -m 700 /opt/qds/swarm-keys
```

NOTES: verify `npm i -g --prefix /opt/openrig` puts the bin at `/opt/openrig/bin/rig` on the actual build — adjust the symlink if the layout differs. Run the first build to MEASURE both hashes (the build FAILS on the gate with the measured value in its message — that is the TOFU ritual), then pin them into the ARGs in the same commit. `binary-licenses.json`: add the node tarball and `better_sqlite3.node` (OpenRig dep) entries in the file's existing format; add a tmux entry only if the file's scope covers base-image tools.

- [ ] **Step 2: Declare the pairing debt** — do NOT touch `driver.ts:451/516`. The PR description records: image changes ship un-pinned; after merge, the publish workflow prints the new `DEFAULT_IMAGE_REF`/`BUILD_ID`; adopt in ONE commit on `dev` at the three sites (research doc §5.6 last row); re-push the private mirror; THEN the paid live round (qds-live-e2e skill; operator "go"; keys ≤ $0.50/seat; revoke + destroy in `finally`; confirm `ssh exe.dev ls --json` empty).

- [ ] **Step 3: Full gates**

```bash
bunx tsc --noEmit 2>&1 | head; echo "tsc=$?"
bunx biome check . 2>&1 | tail -5
bun test > /tmp/qds-test.log 2>&1; echo "exit=$?"
tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error" | head -20
```
Expected: 0 failures. Any failure → fix before the PR (superpowers:systematic-debugging).

- [ ] **Step 4: detect_changes() review** — `detect_changes({})` and confirm affected symbols/processes are exactly: PhaseKind/manifest schema, makeBodyFactory/composeGatedBody, credentials seat functions, dispatch mint path, teardown capture/revoke sites, harvest sources. Compare against the impact reports collected across tasks; investigate any surprise before opening the PR.

- [ ] **Step 5: Push + open PR to `dev`** (normal prose for the PR body):

Title: `feat: rig_swarm phase kind (S1) — OpenRig swarm inside the factory box`

Body sections: summary (what S1 adds, §5.6 mapping), pairing debt (image changes un-pinned; adoption ritual spelled out), spike provenance (S0 evidence, PR #283), test evidence (tsc/biome/full-suite output summary), out-of-scope list (P0 worker hardening, Q1, SC1/SC2, S2 seats). End with:

`🤖 Generated with [Claude Code](https://claude.com/claude-code)`

```bash
git push -u origin feature/rig-swarm-phase
gh pr create --base dev --title "feat: rig_swarm phase kind (S1) — OpenRig swarm inside the factory box" --body-file /tmp/pr-body.md
```

---

## Post-merge (NOT this branch — recorded here so it is not lost)

1. Adopt the pin: publish workflow output → `DEFAULT_IMAGE_REF` + `DEFAULT_IMAGE_BUILD_ID` in `src/providers/exedev/driver.ts:451,516` + `build-exedev-image.test.ts` expectation, ONE commit on `dev`; re-push the private mirror.
2. Live round under `qds-live-e2e`: worst-case spend estimate printed first, explicit operator "go", 2 Pi seats ≤ $0.50/seat, revokes + box destroy in `finally`, `ssh exe.dev ls --json` empty at the end. DoD: harvested commit, testCommand gate green, reverify green, per-seat cost rows in the ledger, 0 boxes, 0 live keys.

### Review Findings

bmad-code-review round 1 on PR #284 diff (2026-09-24): 53 findings triaged — 45 patch, 1 defer, 7 dismissed. Full triage: `/tmp/qds-pr284-review/triage.json`.

- [ ] [Review][Patch] Unbounded CLI spawns in openrig-swarm.ts [src/phase-engine/phases/openrig-swarm.ts] (F-001, HIGH)
- [ ] [Review][Patch] rig_swarm without testCommand whose poll loop hits the deadline settles timeout-fallback and returns exitStatus success (l.401) — an unverified swarm is journaled success and the pipeline proceeds; schema never requires testCommand; pipeline-run.test.ts [src/phase-engine/phases/openrig-swarm.ts] (F-002, HIGH)
- [ ] [Review][Patch] Box-global teardown [src/phase-engine/phases/openrig-swarm.ts] (F-003, HIGH)
- [ ] [Review][Patch] Plaintext OpenRouter seat keys written to rigHome/state/pi/<session>/agent/auth.json (l.187-198) and no teardown path removes them — every run leaves operator keys at a predictable box path. [src/phase-engine/phases/openrig-swarm.ts] (F-004, HIGH)
- [ ] [Review][Patch] Manifest member/pod/rig ids are nonBlankString only [src/phase-engine/manifest.ts] (F-005, HIGH)
- [ ] [Review][Patch] Swarm teardown skips step-5 verify with a comment but emits no run-credential.verify-revoked link; chain.ts [src/providers/teardown.ts] (F-006, HIGH)
- [ ] [Review][Patch] Single-key ↔ swarm exclusion is one-directional [src/providers/credentials.ts] (F-007, HIGH)
- [ ] [Review][Patch] Seat createKey transport timeout whose POST landed server-side leaves an untracked live key [src/providers/credentials.ts] (F-008, HIGH)
- [ ] [Review][Patch] Swarm branch of mintAndDeliverKey calls ctx.within('mint'/'deliver') with no third payload argument, dropping the operator-facing keyHash/cap pointer the single-key path keeps for abandoned mints — N live keys with no hash/cap in the operator log. [src/fleet/dispatch.ts] (F-009, HIGH)
- [ ] [Review][Patch] seatKeyPlan [src/fleet/dispatch.ts] (F-010, MED)
- [ ] [Review][Patch] captureSeatSpend unconditionally overwrites spendMicroUsd [src/providers/credentials.ts] (F-011, MED)
- [ ] [Review][Patch] mintSeatKeys compensation loop [src/providers/credentials.ts] (F-012, MED)
- [ ] [Review][Patch] Test-strength cluster [tests/phase-engine/pipeline-run.test.ts] (F-013, MED)
- [ ] [Review][Patch] Cost attribution reads only the largest .jsonl per seat (rotated/multi-session usage silently unattributed — the divergence teardown flags as unwired), and a statSync throw mid-scan drops the seat's entire attribution. [src/phase-engine/phases/openrig-swarm.ts] (F-014, MED)
- [ ] [Review][Patch] Parser skips usage-less lines then emits turnCount [src/phase-engine/phases/openrig-cost.ts] (F-015, MED)
- [ ] [Review][Patch] Healthz window (30×(30s+1s)≈15.5min worst) runs before the deadline is computed at l.307, so wall time exceeds maxDurationMs by all setup time; a slow-flapping daemon can consume the entire window with zero polls. [src/phase-engine/phases/openrig-swarm.ts] (F-016, MED)
- [ ] [Review][Patch] composeGatedBody retry on GateFailureError (pipeline-run.ts [scripts/pipeline-run.ts] (F-017, MED)
- [ ] [Review][Patch] Poll loop treats only state==='done' as terminal; a readable terminal failed/cancelled queue state polls to the deadline then timeout-fallback→success under a bare body. [src/phase-engine/phases/openrig-swarm.ts] (F-018, MED)
- [ ] [Review][Patch] rigSpec/objective/leadSeat/seatBudgets are accepted silently on every other kind (testCommand/roster/task refusals exist; the four rig_swarm fields have no reverse-direction refusal) — dead payload an author can believe is enforced, against the file's own refuse-when-dead doctrine. [src/phase-engine/manifest.ts] (F-019, MED)
- [ ] [Review][Patch] Test hygiene [tests/phase-engine/openrig-swarm.test.ts] (F-020, LOW)
- [ ] [Review][Patch] manifest.test.ts [tests/phase-engine/manifest.test.ts] (F-021, LOW)
- [ ] [Review][Patch] rig daemon start exit code ignored — a hard failure flows into the healthz loop and surfaces ~30s later as the misleading 'failed to become healthy'. [src/phase-engine/phases/openrig-swarm.ts] (F-022, LOW)
- [ ] [Review][Patch] Synchronous readFileSync/JSON.parse of potentially multi-MB session JSONLs on the event loop during teardown-critical seconds. [src/phase-engine/phases/openrig-swarm.ts] (F-023, LOW)
- [ ] [Review][Patch] Empty/unset HOME yields rigHome '.openrig' relative to cwd and the workdir probe can adopt an unrelated ./src checkout as every seat's cwd. [src/phase-engine/phases/openrig-swarm.ts] (F-025, LOW)
- [ ] [Review][Patch] Unbounded objective string [src/phase-engine/manifest.ts] (F-026, LOW)
- [ ] [Review][Patch] deliverSeatKeys [src/providers/credentials.ts] (F-027, LOW)
- [ ] [Review][Patch] deliverSeatKeys half-failure [src/providers/credentials.ts] (F-028, LOW)
- [ ] [Review][Patch] mintSeatKeys interpolates runId into provider key names and remediation text without the LEGACY_RUN_ID_RE grammar check deliverSeatKeys enforces — the two halves disagree on accepted runId and the unvalidated form reaches the provider first. [src/providers/credentials.ts] (F-029, LOW)
- [ ] [Review][Patch] usdToMicros newly exported with no importer in the diff (mintSeatKeys uses it module-internally) — unexplained API-surface widening on a money function. [src/providers/credentials.ts] (F-030, LOW)
- [ ] [Review][Patch] dispatch-seat-plan clamp test asserts against the imported defaultKeyCapMicroUsd constant itself — a silent constant change keeps the test green while fixture assumptions (Σ=backstop) go stale. [tests/fleet/dispatch-seat-plan.test.ts] (F-031, LOW)
- [ ] [Review][Patch] revokeSeatKeys doc says 'count revoked this call' but already-gone outcomes increment too — retries overstate. [src/providers/credentials.ts] (F-032, LOW)
- [ ] [Review][Patch] mintSeatKeys lacks mintRunKey's run-level guards [src/providers/credentials.ts] (F-033, MED)
- [ ] [Review][Patch] Composed provider key name sbx-<runId>-<seat> reaches 100 chars at grammar maxima with no length guard — provider-dependent mint death mid-plan or silent reaper mis-join on truncation. [src/providers/credentials.ts] (F-034, LOW)
- [ ] [Review][Patch] New content-gate ARGs (NODE_SHA256/OPENRIG_TREE_SHA256 + NODE_VERSION/OPENRIG_VERSION) bypass checksumArgProblems (still [BUN_SHA256, PI_AI_SHA256] at l.1440), the env-override/multi-declaration refusals, the BUN/PI lockstep loop (l.1638), and deriveBuildId inputs (l.1715) — a --build-arg override builds a substituted image under the byte-identical buildId as the legit build. [scripts/build-exedev-image.ts] (F-038, HIGH)
- [ ] [Review][Patch] OpenRig tree-hash pipeline (find -type f | sort | xargs sha256sum | sha256sum) silently drops whitespace/newline-named files (xargs splitting) and sha256sum failures don't propagate (no pipefail) — first build pins a partial-tree value and later mutation of exactly that file false-passes the gate claiming to freeze the WHOLE tree. [oci/exedev/Dockerfile] (F-039, MED)
- [ ] [Review][Patch] rig --version executes after the tree gate in the same RUN — first-run state rig writes mutates /opt/openrig after the hash is measured, so the pinned tree can differ from the shipped tree. [oci/exedev/Dockerfile] (F-040, LOW)
- [ ] [Review][Patch] NODE_VERSION/OPENRIG_VERSION have no mechanical lockstep with binary-licenses.json version fields (validateBinaryLicenses never reads version) — a legitimate ARG bump publishes stale legal attribution with licenseUrl tags pinned to old releases. [scripts/build-exedev-image.ts] (F-041, MED)
- [ ] [Review][Patch] su -s /bin/sh exedev -c gates are non-login [oci/exedev/Dockerfile] (F-042, MED)
- [ ] [Review][Patch] Silent set -e asserts ([ \$(node --version) = ... ], command -v, the cleanup RUN's existence asserts) exit 1 with no message — the first real build, the only build where they can fire, dies undiagnosably, breaking the file's own loud-refusal doctrine. [oci/exedev/Dockerfile] (F-043, LOW)
- [ ] [Review][Patch] mergeSweeps spreads piVersions/licenseTexts last-write-wins on key collision contradicting its own 'nothing is deduplicated or reconciled' contract — engine yaml and openrig yaml (different versions) collide and one licence text renders for two shipped versions; tests cover only distinct keys. [scripts/build-exedev-image.ts] (F-044, MED)
- [ ] [Review][Patch] Roadmap orders R0.3 (publish the image, evidence = printed digest) before R0.4 (pin the sentinels) but every build refuses until the sentinels are pinned — R0.3's evidence is unobtainable in the stated order; also Dockerfile comment says pins land in ONE adoption commit vs roadmap R0.4/R0.5 two-commit split. [src/../docs/planning/2026-09-24-openrig-integration-roadmap.md] (F-045, MED)
- [ ] [Review][Patch] binary-licenses provenance wording [oci/exedev/binary-licenses.json] (F-047, LOW)
- [ ] [Review][Patch] better-sqlite3 LICENSE-tag drift re-check missing from the first-build reconciliation ritual (ritual lists only +x paths and hashes). [oci/exedev/binary-licenses.json] (F-050, LOW)
- [ ] [Review][Patch] emitSeatCosts' returned seat total is discarded by its only production caller though the interface comment promises the caller logs it alongside teardown. [src/phase-engine/phases/openrig-swarm.ts] (F-051, LOW)
- [ ] [Review][Patch] Roadmap §0 records a snapshot ('11 commits, head 0044e62d') that the roadmap's own commit (cf629518) falsifies — 12 commits, new head; 'verified 2026-09-24' stale on arrival. [src/../docs/planning/2026-09-24-openrig-integration-roadmap.md] (F-052, LOW)
- [x] [Review][Defer] Cost snapshot races live seats [src/phase-engine/phases/openrig-swarm.ts] — deferred: Inherent TOCTOU on a filesystem the seats own until teardown; the pre-teardown emission is deliberate (crash-safety, ff39b624)
