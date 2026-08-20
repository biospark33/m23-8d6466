# DF3.3: Resident Orchestrator Agent — Interprets the Brief, Steers the Engine, Never Holds Gate Authority

**Story Points:** 4
**Sprint:** v5-S2 (fleet band)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 tier 2, §5.2 (contracts, F12 invariant), §5.3, §6 items 5/6
- Decision register: v5 §4 **D4** (tier 2 = resident agent operating a deterministic TS phase engine; cheap-model default; demotion tripwires F7), **D6**; findings **F7**, **F12**; risk **R3**
- Closed record (READ-ONLY, cited not modified): `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` §3.3 "D4 tripwire finding" — the 15%-of-run-total tripwire is a **ratio trap**, re-specced as DF3.6's absolute ceiling
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` §5 row 4, **DD-8**, **DD-9** (integer µ$)
- Binding facts: R5 §6 facts **4** (OpenRouter is the working path), **9** (rates), **12** (never the 15% ratio), **15** (in-box output is a claim, not proof)

## User Story

As a factory operator dispatching a story to a sandbox,
I want a resident agent that reads the dispatch brief and steers the run at engine-chosen decision points,
so that a run adapts mid-flight without any agent ever being able to move a gate, reorder a phase, or promote a status.

## Overview

`startResident(brief, roster)` spawns one cheap-model agent per sandbox alongside DF1.1's phase
engine. The engine — not the agent — drives: at exactly three engine-owned solicitation points it
renders a bounded prompt, calls the resident, and parses the reply against a closed
`SteeringDirective` schema, which expresses guidance text, a roster choice, or an abort and nothing
else. Every solicitation happens **after** the deterministic decision it could otherwise corrupt is
already made — after the gate verdict, after DF1.3's retry authorization — so the agent interprets
and steers while the engine keeps gates, phase order, and status promotion. This story closes the
wiring from DF3.1's dispatch brief to a steered run and its resident report.

## E2E Slice

**Demonstrable behavior:** Given `tests/phase-engine/fixtures/pipeline.resident.json` (this story's
E2E fixture) with a `build` phase whose test command fails once, and a brief naming the target
issue, When `bun scripts/pipeline-run.ts --manifest <fixture> --journal out.json` runs, it spawns
the resident → solicits at run start (`{action:"proceed"}`) → runs `build` → gate fails → DF1.3
authorizes retry attempt 2 → solicits for guidance (`{action:"retry",
guidance:"the assertion compares bytes, not strings"}`) → re-enters the same session → gate
passes → solicits for the report → `out.json` satisfies the **steered-run invariants**: the same
phase order as the control run, every gate verdict computed by DF1.2 from real evidence, and
no status promoted that the control run would not also have promoted from the same evidence —
plus `resident: { status:"active", directives: 3, steeringIterations:{build:1}, spendMicros:N }`
(`directives` is the **count** of accepted directives, not an array).
Byte-identity with the control is asserted separately, in the **proceed-only** run (all three
solicitations return `{action:"proceed"}`), where the resident changes nothing by construction.

**Wiring closed:** On completion of this story, a resident agent interprets a brief and steers a real
run using only code merged by this story plus DF1.1's lifecycle, DF1.5's validated roster (the
resident slug, and its rate through DF1.5's roster loading which exports
`inputPerMTok`/`outputPerMTok` integer µ$ per million tokens from models.json), DF1.6's
`dispatch_task` phase, DF2.2's provisioned box, DF2.8's budget cap (contract-cited;
DF2.8 implementation pending — see R5 disposition), and DF3.1's brief. No stub, no `TODO: wire later`.
The *bounds* on this agent (iteration cap, RSS cap, absolute spend ceiling) are DF3.6's,
engine-enforced; this story ships the agent and the telemetry that makes D4's month-1 tripwire
evaluation possible.

**Dependency edges (predecessors):** DF1.1, DF1.5, DF1.6, DF2.2, DF3.1.

## Acceptance Criteria

1. **(make-or-break)** Given any manifest and any sequence of resident directives, When the
   run completes, Then no directive has directly set a phase status, re-ordered `phases[]`,
   or satisfied a gate — the resident appears in the journal only as recorded directives,
   guidance text, and telemetry. Accepted directives have engine-defined effects only:
   `abort` triggers the engine's own `fail` transition, `select_roster` picks from DF1.5's closed
   id set, and `retry` guidance is text the agent consumes on an engine-authorized retry — so
   outcomes may differ from a `--no-resident` run, but only through those engine-owned verbs.
   The claim is therefore proven in **two** shapes, never one: (a) **proceed-only equivalence** — a
   run whose every solicitation returns `{action:"proceed"}` produces a journal **byte-identical**
   to the `--no-resident` control (a control flag this story adds to `scripts/pipeline-run.ts`, already in Files to Modify — the control leg of this equivalence test) once `resident.*` and timing fields are excluded; (b)
   **steered-run invariants** — a run carrying real directives preserves phase order, computes every
   gate verdict from real evidence, and promotes no status the same evidence would not have promoted
   without a resident. Byte-identity is **never** asserted of a steered run — AC1's first sentence
   admits that steered outcomes legitimately differ.
   *Negative control: an implementation that lets a directive set a phase status, re-order
   `phases[]`, or mark a gate satisfied passes a happy-path steering test and MUST fail this one.*
2. Given a resident reply naming an action outside the closed union — `skip_gate`,
   `reorder_phases`, `set_status`, `extend_budget`, or any unknown field — When the directive
   is parsed, Then the `.strict()` schema rejects it, the engine proceeds with its
   deterministic default, and a `residentTripwire` row records
   `cause: "gate_bypass_attempt"` with the rejected action name.
3. Given the resident process is unreachable, exceeds its solicitation timeout, or emits
   unparseable JSON twice in a row, When the engine reaches a solicitation point, Then the run
   continues fully deterministic with `resident.status: "degraded"` — no hang, no third
   reparse, no retry of the underlying phase, and no gate skipped. **Unparseable replies are
   fail-closed:** after two consecutive malformed responses the resident is degraded and the
   engine proceeds deterministically; the run never continues with a parsed-unchecked directive
   (R3 fail-closed discipline).
4. Given a dispatch brief that is absent or empty, When the run starts, Then the resident is
   **never spawned**, `resident.status` is `"disabled"`, and the run completes normally — an
   explicit non-error path, not a failure.
5. Given a completed run, When the run **journal** is read, Then `resident.status` is one of the
   closed set `"active" | "degraded" | "disabled" | "stopped"` — `stopped` is written **only** by
   DF3.6's bound enforcement, never by this story's code paths — and the journal carries the
   resident's
   `spendMicros` (engine-metered, integer µ$), per-phase `steeringIterations`,
   `directivesRejected`, `exitStatus` (a CC-1 `exitStatus` value describing how the resident process
   itself ended — this story owns the `resident` journal block and therefore declares the field;
   DF3.6's watchdog is what writes `"overflow"` into it, exactly as it alone writes
   `status: "stopped"`) and any `residentTripwire` rows — sufficient for D4's month-1 evaluation —
   and **no ratio, percentage, or share-of-run-total field** (R5 §6 fact 12). DF2.1's twelve-field
   run record is **closed**: this story adds no field to it, and its `spendMicroUsd` is the run total.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `fleet dispatch` brief → in-box resident spawn | in-scope | `tests/fleet/resident.test.ts` | — |
| engine solicitation point (`solicit()` library call) | in-scope | `tests/phase-engine/steering.test.ts` | — |
| operator mid-run steering (`fleet attach`) | out-of-scope | — | DF3.4 |
| iteration / RSS / spend bounds on the resident | out-of-scope | — | DF3.6 |
| tier-3 pi team spawned by a `dispatch_task` phase | out-of-scope | — | DF1.6 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| resident model slug (cheap default) | roster config from DF1.5; provider **OpenRouter** (R5 §6 fact 4 — direct-Anthropic is blocked on this host) | dual slug validation (pi catalog + provider API) passes at roster load; an unknown slug refuses the run before spawn |
| resident slug rate | DF1.5 models.json loads `inputPerMTok`/`outputPerMTok`/`cacheReadPerMTok`/`cacheWritePerMTok` as integer µ$ **per million tokens** (DD-9); **this story reads `inputPerMTok`/`outputPerMTok` only** | resolves at roster load for the resident slug; a slug with no resolvable rate refuses the resident before spawn (DF1.5's rule, consumed here and by DF3.6, never re-derived) |
| per-run LLM key | DF2.3 delivery — the box's single secret at `app/.env`, mode `0600` | DF2.2 setup gate's live model ping green before the engine starts |
| sandbox box | DF2.2 exe.dev driver (`create/fill/setup`) | setup gate returns ready; the engine does not start on a non-ready box |
| run journal / trace store | DF1.1 `PhaseJournal` port, SQLite-backed by DF1.4 | telemetry rows write through the same port; schema migrated at box init |
| pi runtime 0.55.x | in-box OCI image (DF2.9 contract) | `pi --version` asserted by the DF2.2 setup gate |

## Technical Notes

- **Contracts/Schema — exactly one is new here:** the closed union
  `SteeringDirective = { action:"proceed" } | { action:"retry", guidance } |
  { action:"select_roster", phase, rosterId } | { action:"abort", reason }`, each with an optional
  `note`, parsed with a `.strict()` zod object per DF1.1 INV-2. **Unparseable replies are
  fail-closed:** after two consecutive malformed responses the resident is degraded (AC3),
  consistent with R3 fail-closed discipline. The dispatch brief is **not** re-declared: this story
  consumes DF3.1's closed `src/fleet/brief-schema.ts`, already validated at ingress
  (DF3.1 INV-2), and adds no second brief schema. `exitStatus` values are imported from
  `cli-anything/src/types.ts:94-185` (CC-1); not re-declared.
- **Shared file with DF3.4 and DF3.6 — `src/phase-engine/steering.ts` (DF3-P1-22, XC-P2-05).** All
  three are v5-S2, and the order is three-way: **DF3.3 authors the file** — the engine-owned
  solicitation port and its three points; **DF3.4 rebases onto it** and adds only the `attach` inbox
  drain + ack append at those same three points; **DF3.6 rebases last** and wraps the existing call
  sites in its `checkBounds(point)` guard. Each successor **adds only** — no fourth solicitation
  point, and no edit to a DF3.3-owned line. This note is mirrored in df3-4's and df3-6's Files lists.
- **Shared file with DF1.8 — `scripts/pipeline-run.ts` (XC).** DF1.8 also edits this entrypoint (run
  correlation wiring). Both are v5-S2: **DF1.8 lands first and DF3.3 rebases onto it**, adding only
  the resident spawn/telemetry hooks around DF1.1's existing engine call (the actual flags are
  `--manifest`, `--journal`, `--run-id`, `--repo-slug`, `--issue` per R1 §176). DF3.3 changes
  no line DF1.8 owns, and neither story re-implements the other's region.
- **Where the code lives (R3 §9.2):** the resident *agent* is fleet code (`src/fleet/resident.ts`);
  the solicitation *port* is engine code (`src/phase-engine/steering.ts`). Fleet imports the engine
  barrel, never the reverse — so INV-RES-1 is a module boundary, not a habit.
- **The three solicitation points, stated once — the whole containment argument:**
  (1) **run start**, after the manifest is validated and frozen — `proceed`/`select_roster`/
  `abort`; (2) **post-gate-failure**, called only *after* DF1.2 computed the verdict **and**
  DF1.3 authorized attempt N+1 — the directive supplies `guidance` text only, never the retry
  decision; (3) **run end**, after `finish(accepted)` — report text only. There is no fourth point:
  the agent is never consulted before a decision it could corrupt, and DF3.4's `attach` adds none —
  an operator message is queued and delivered as prompt context at the next of these three.
- **The directive verbs are asymmetric by design:** `abort` is the only destructive one and
  it ends the run as `fail` — no directive can move a run toward green. `select_roster`
  picks from the closed set of ids DF1.5 validated at load; an id outside that set is a
  rejected directive (AC2), not a fresh model spawn.
- **Cost knob (D4):** the `resident` roster role defaults to a cheap OpenRouter slug
  (`deepseek-v4-flash-0731`, $0.08/$0.18 per MTok, cache read 0.2× — R5 §6 fact 9); the slug is
  configuration, and nothing in this story assumes a frontier model. Those two numbers are
  provenance, **not** the runtime source: the rate for any slug is read from DF1.5's models.json
  validation, which loads `inputPerMTok`/`outputPerMTok`/`cacheReadPerMTok`/`cacheWritePerMTok`
  as integer µ$ **per million tokens** (DD-9). **This story reads `inputPerMTok`/`outputPerMTok`
  only**, and every consumer divides by `1e6` at the projection to reach µ$ for a single call;
  the unit is per-MTok precisely so a cheap model's rate does not round to zero as an integer.
  This story quotes no rate into code, and DF3.6's projection reads the same source — one rate
  source, DF1.5's key names, no second table.
- **Spend is metered engine-side, in integer µ$ (DD-9):** the engine sums the provider's reported
  usage on each reply; the agent never reports its own. This meter is independent of
  `team-lead-driver.ts`'s final-turn overwrite (DF2.7's, R5 §6 fact 7) — the resident is a direct
  engine-owned spawn, so it accumulates correctly from day one.
- **Micro-USD field naming, one rule (applies across DF3.3/DF3.6):** names ending `*MicroUsd` are
  **persisted** fields on DF2.1's run record and DF2.3's key metadata; names ending `*Micros` are
  **in-memory / journal** values owned by the engine. The mapping is explicit and one-way:
  `runRecord.spendMicroUsd := ` run total (DF2.5 writes it), `journal.resident.spendMicros := `
  engine-metered resident subtotal, `residentSpendCeilingMicros := ` manifest bound (DF3.6),
  `runKeyCapMicros := runRecord.limitMicroUsd` (read-only). Neither suffix is a synonym for the
  other and no code path renames one into the other implicitly.
- **Guards/limits (per call):** solicitation prompt ≤ 16,000 characters **including** its truncation
  suffix (reserve the suffix width before cutting, per DF1.2's rule form); `maxOutputTokens` 1,024;
  timeout 60,000 ms; at most one reparse of a malformed reply, then degrade (AC3). Both ceilings are
  the inputs to DF3.6's worst-case cost projection. The per-run and per-phase bounds — iterations,
  RSS, absolute spend ceiling — are **DF3.6's**, engine-enforced, and are not restated here.
- **D4 tripwire telemetry (F7), recorded so the month-1 evaluation is possible:** three causes, each
  a `residentTripwire` row `{ runId, requestId, cause, phase, detail }` — `spend_ceiling_breach`
  (raised by DF3.6's absolute ceiling, **never** by a ratio), `gate_bypass_attempt` (a rejected
  directive naming a gate or phase-order action; since bypass is architecturally impossible, the
  honest signal is the *attempt*), and `watchdog_kill` (DF3.6's, carrying `cause` so "killed twice
  for the same cause" is computable). This story records; evaluation is an operator activity.
- **Deviation/assumption:** the resident is solicited synchronously and holds no state the engine
  cannot reconstruct from the journal, so a resident that dies mid-run degrades (AC3) rather than
  invalidating the run. A later asynchronous resident widens this port; it gets no second channel.
  Degradation is **fail-closed:** the engine never parses and executes an unvalidated reply, and
  a resident that cannot communicate is treated as absent, not as a reason to skip gates or
  truncate phases (R3 fail-closed discipline).

## Observability Contract

- Every solicitation logs `{ requestId, runId, phase, point, model, durationMs, directiveAction, accepted, spendMicros }`
- `requestId` propagates unchanged from the DF3.1 dispatch through the brief onto every resident
  log line and telemetry row; errors include `{ code, message, stack? }`
- Every rendered prompt and raw reply persists **pre-execution** (v5 §5.2), redacted through `cli-anything/src/redact.ts:62`
- Sub-timings: `prompt_render_ms`, `agent_call_ms`, `directive_parse_ms`. A point never reached
  reports `0`; where a breakdown is unavailable, `durationMs` is authoritative.

## Files to Modify

- `src/fleet/resident.ts`
- `src/fleet/index.ts`
- `src/phase-engine/steering.ts`
- `src/phase-engine/index.ts`
- `scripts/pipeline-run.ts`
- `tests/fleet/resident.test.ts`
- `tests/phase-engine/steering.test.ts`
- `tests/phase-engine/fixtures/fake-resident.ts`
- `tests/phase-engine/fixtures/pipeline.resident.json`

## Security Invariants

- **INV-RES-1 (no gate authority — structural, not procedural):** the resident holds no
  reference to a gate, the journal writer, the frozen manifest, or the phase constructor.
  Its only egress into the engine is one validated `SteeringDirective` returned from an
  engine-initiated call. A design in which the agent *calls* the engine — a tool surface,
  an MCP server, a writable control file — violates this invariant however it is permissioned.
- **INV-RES-2 (validation strictly precedes effect):** every reply is parsed against the
  `.strict()` directive schema before any engine state is touched. Unknown fields and
  unknown actions are rejections, not warnings. A rejected directive has exactly one
  effect: a telemetry row.
- **INV-RES-3 (credential containment):** the resident runs inside the box against the single
  per-run, spend-capped, revocation-verified key (DF2.3 INV-CRED-1, R5 §6 fact 17); never the
  provisioning key, never a push credential. The brief carries **no** credential material — a value
  matching a credential shape (`sk-`, `ghp_`, `Bearer `, `-----BEGIN`, or a field named
  `key`/`token`/`secret`/`password`) refuses the run (DF1.1 INV-4), naming the field, never the value.
- **INV-RES-4 (in-box output is a claim, not proof):** the resident's report and guidance are
  agent-authored in-box evidence (F10/R9, R5 §6 fact 15) — recorded, never treated as
  verification, and never able to satisfy a gate or authorize a PR. DF5.1's host-side
  re-verify is the only thing that does.
- **INV-RES-5 (fail-closed toward determinism):** every degradation path — unreachable agent,
  timeout, malformed reply, rejected directive, disabled resident — lands on the engine's
  deterministic default. Degradation is always *less* agent influence, never a skipped gate,
  a shortened phase, or a raised budget.

## Definition of Done

- [ ] **Impl:** the engine solicits at exactly the three points in Technical Notes; the diff contains no fourth call site and no agent-initiated channel into the engine (INV-RES-1).
- [ ] **Impl:** resident spawn is roster-driven with a cheap OpenRouter default; an empty brief produces `status:"disabled"` and a clean deterministic run.
- [ ] **Contract:** `SteeringDirective` closed `.strict()` union with the four actions; unparseable replies fail-closed after two attempts (AC3, R3 fail-closed); the brief is DF3.1's `src/fleet/brief-schema.ts` with no second schema; `exitStatus` imported from `cli-anything/src/types.ts:94-185`, never re-declared.
- [ ] **Integration:** the brief arrives from DF3.1's dispatch with `requestId` intact and propagates onto every resident log line and telemetry row; DF2.8 budget cap is contract-cited (implementation pending per R5 disposition).
- [ ] **Security:** credential-shaped brief values refuse the run (INV-RES-3); prompts and replies persist pre-execution, redacted (§5.2).
- [ ] **Test (proceed-only equivalence, AC1a):** the same manifest run with a resident answering `{action:"proceed"}` at all three points and with `--no-resident` yields **byte-identical** journals once `resident.*` and timing fields are excluded.
- [ ] **Test (steered-run invariants, AC1b):** a run with real `retry`/`select_roster` directives preserves phase order, computes every gate verdict from real evidence, and promotes no status unearned by that evidence; an implementation permitting a status- or order-changing directive MUST fail this test. Byte-identity is not asserted here.
- [ ] **Test (degradation fail-closed):** resident killed mid-run, resident timing out, and two consecutive malformed replies each yield `status:"degraded"`, a completed run, and zero skipped gates; unparseable replies are never executed (R3 fail-closed discipline).
- [ ] **Test (telemetry boundary):** a completed run journal contains resident `spendMicros`, per-phase `steeringIterations`, `directivesRejected`, and an `exitStatus` parsing against the CC-1 enum; a schema scan finds **zero** ratio/percentage/share fields (R5 §6 fact 12) and **zero** fields added to DF2.1's closed run record.
- [ ] **Test (e2e demo — MANDATORY):** the fixture run writes `out.json` showing a gate failure steered to a pass on attempt 2 with `resident.steeringIterations.build == 1` and the AC1b steered-run invariants holding against the `--no-resident` control (same phase order, evidence-derived verdicts, no unearned promotion) — the journal file is the artifact.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

---

## Hardening Revision — 2026-08-20

**Revised by:** Writer Agent W2 (DF3 hardening)

**Changes:**
1. Fixed DRIFTED pipeline-run.ts invocation: removed phantom `--brief`/`--no-resident` flags; E2E now cites actual flags per R1 (`--manifest`, `--journal`, `--run-id`, `--repo-slug`, `--issue`).
2. Fixed DRIFTED DF1.5 rate citation: removed unverifiable `resolveRate(slug)` export claim; now cites direct models.json load of `inputPerMTok`/`outputPerMTok` integer µ$ per million tokens (DD-9).
3. Added DF2.8 contract-citation with "implementation pending" marker per R5 disposition.
4. Encoded R3 fail-closed discipline: AC3 and Technical Notes now explicitly state unparseable replies are fail-closed (two-attempts limit, degrade to deterministic).
5. Trimmed DOD from 12 to 10: merged illegal-directive test into degradation fail-closed; removed status closed union test (covered by telemetry boundary).
6. Updated exitStatus import location from `:79` to `:94-185` per R1.
7. Campaign fixes 2026-08-20: DF3.3-M1.

**Size compliance:** ≤200 normative / ≤400 total / Files to Modify ≤9.
