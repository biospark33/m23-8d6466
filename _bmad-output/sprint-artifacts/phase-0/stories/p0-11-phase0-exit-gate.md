# P0.11: Phase-0 Exit Gate (§13 Aggregated Assertion Check)

**Story Points:** 3

## Spec Reference

- PRD §13 (Phase Exit Gates); FR-OR-4, FR-EX-1..10, FR-MEM-1, FR-CP-9..11
- Phase exit gate: PRD §13 Phase 0 full gate

## User Story

As a QDS project lead,
I want a single binary gate script that asserts every Phase-0 deliverable is live,
so that I can promote to Phase 1 with confidence that no foundational component is missing (G1 — reliable infrastructure).

## Overview

This story creates a single executable gate script (`scripts/phase0-exit-gate.ts`) that runs a battery of assertions covering all P0 stories (P0.1 through P0.10). Each assertion maps to a PRD §13 Phase-0 clause. The script exits 0 on all-green or exits 1 with a detailed failure report on any red assertion. This is a 3-point unit because it requires writing assertion logic for 10 predecessor stories but no new infrastructure — it is purely a verification harness that aggregates existing functionality.

## E2E Slice

**Demonstrable behavior:** Run `npx tsx scripts/phase0-exit-gate.ts`. The script checks: env propagation (P0.1), coms viable (P0.2), mixed-model output (P0.3), guard fires (P0.4), pi-lens headless (P0.5), LSP live (P0.6), SwarmClaw+Hindsight MCP bridge (P0.7), webhook callback (P0.8), memory round-trip (P0.9), graph queries (P0.10). All green → exit 0 with `PHASE_0_GATE: PASS`. Any red → exit 1 with `PHASE_0_GATE: FAIL` and per-assertion failure details.

**Wiring closed:** On completion of this story, running the gate script produces a binary PASS/FAIL result for every §13 Phase-0 assertion using only code merged by this story and all predecessors (P0.1–P0.10). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.1, P0.2, P0.3, P0.4, P0.5, P0.6, P0.7, P0.8, P0.9, P0.10 (all Phase-0 stories must be complete).

> **Dependency status as of 2026-07-25 — P0.11 is UNBLOCKED.** Done: P0.2, P0.3,
> P0.5, P0.6, P0.7, P0.9, P0.10. Killed by Warren decision (assertions must be
> dropped from the gate, not left failing): **P0.1, P0.4, P0.8**. P0.11 is the
> only Phase-0 story remaining.
>
> **P0.6 assertion — reuse, and do not over-claim.** `scripts/lsp-verify.ts`
> already emits a machine-readable verdict (`{results, summary}`, exit 0 iff no
> FAIL), so the gate should invoke it rather than re-implement LSP probing; its
> shared transport lives in `scripts/lib/mcp-stdio-client.ts`.
> **Its 7/7 probe pass is NOT full story acceptance:** AC1, AC3, AC3a and AC4 are
> recorded story-level PARTIAL. If the gate asserts "LSP live", scope that
> assertion to what is actually proven — warm diagnostics reflect uncommitted
> edits within the latency budget — and not to first-query freshness, the AC3
> artifact half, or pi-lens's internal init timeout. See
> `_research/lsp-verification-report.md` §7 and the P0.6 story status table.

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given all P0.1–P0.10 stories are fully implemented and their systems are running, When `npx tsx scripts/phase0-exit-gate.ts` is executed, Then the script exits with code 0 and stdout contains `PHASE_0_GATE: PASS` with every assertion reporting green.
2. Given any single P0 predecessor is broken (e.g., SwarmClaw server is down), When the gate script runs, Then it exits with code 1, stdout contains `PHASE_0_GATE: FAIL`, and the specific failing assertion(s) are listed with error details — not a generic "tests failed" message.
3. Given the gate script is run in a clean environment where no P0 infrastructure is running, When it executes, Then it fails fast on the first assertion group (env propagation) and reports which env vars are missing — it never hangs waiting for a timeout on downstream assertions.

## Technical Notes

- **Contracts/Schema:**
  > **Updated 2026-07-25 to match the shipped contract** (`src/gate/gate-runner.ts`).
  > Two deliberate changes from the original sketch: `check()` no longer returns
  > `duration_ms` (the runner measures it authoritatively, removing that
  > boilerplate from every assertion), and `skip` / `void` were added because a
  > gate needs to distinguish "could not evaluate" and "clause dropped" from a
  > plain pass/fail.

  ```typescript
  // Gate assertion definition
  const GateAssertionSchema = z.object({
    id: z.string(),                         // e.g., "P0.7-mcp-bridge"
    story: z.string(),                      // e.g., "P0.7"
    prd_clause: z.string(),                 // e.g., "§13 P0 clause 6"
    description: z.string(),
    group: z.enum(["preflight", "main"]),   // preflight is the fail-fast barrier
    check: z.function(),                    // () => Promise<GateCheckOutcome>
    timeout_ms: z.number().positive().optional(),  // per-assertion budget override
    void_reason: z.string().optional(),     // set => clause VOID, check never run
  });

  // What check() resolves to. duration_ms is measured by the runner, not here.
  interface GateCheckOutcome {
    pass: boolean;
    skip?: boolean;      // could not evaluate — still fails the gate
    detail?: string;
  }

  // Gate report
  const GateReportSchema = z.object({
    timestamp: z.string().datetime(),
    overall: z.enum(["PASS", "FAIL"]),
    assertions: z.array(z.object({
      id: z.string(),
      story: z.string(),
      prd_clause: z.string(),
      status: z.enum(["pass", "fail", "skip", "void"]),
      pass: z.boolean(),                    // mirrors status === "pass"
      detail: z.string().optional(),
      duration_ms: z.number(),              // measured by the runner
    })),
    // Counts so a reader need not re-tally. VOID is excluded from the verdict;
    // a gate with zero live assertions is FAIL, never a vacuous PASS.
    summary: z.object({
      pass: z.number(), fail: z.number(), skip: z.number(), void: z.number(),
    }),
    total_duration_ms: z.number(),
  });
  ```

- **Integration points (each wired & exercised in this story):**
  - Environment variable checks — P0.1 assertions
  - Coms HTTP endpoint health — P0.2 assertions
  - Mixed-model output file verification — P0.3 assertions
  - Guard trigger test — P0.4 assertions
  - Pi-lens headless invocation — P0.5 assertions
  - LSP diagnostic request — P0.6 assertions
  - SwarmClaw `/api/agents` + `/api/mcp-servers/{id}/test` — P0.7 assertions
  - SwarmClaw `/api/webhooks/{id}` with test payload — P0.8 assertions
  - Hindsight retain→recall→reflect round-trip — P0.9 assertions
  - GitNexus query invocation — P0.10 assertions

- **Files / functions touched:**
  - `scripts/phase0-exit-gate.ts` — main gate script
  - `src/gate/assertions/p0-1-env.ts` — env propagation checks
  - `src/gate/assertions/p0-2-coms.ts` — coms viability checks
  - `src/gate/assertions/p0-3-mixed-model.ts` — mixed-model output checks
  - `src/gate/assertions/p0-4-guard.ts` — guard trigger checks
  - `src/gate/assertions/p0-5-pi-lens.ts` — pi-lens headless checks
  - `src/gate/assertions/p0-6-lsp.ts` — LSP diagnostics checks
  - `src/gate/assertions/p0-7-mcp-bridge.ts` — SwarmClaw MCP bridge checks
  - `src/gate/assertions/p0-8-webhook.ts` — webhook callback checks
  - `src/gate/assertions/p0-9-memory.ts` — memory round-trip checks
  - `src/gate/assertions/p0-10-gitnexus.ts` — graph query checks

- **Guards/limits:**
  - Per-assertion timeout: 30 seconds
  - Total gate script timeout: 600 seconds (10 minutes)
  - Fail-fast on env group: if P0.1 assertions fail, skip remaining assertions and report
  - Parallel assertion execution within groups where safe (P0.7–P0.10 can run in parallel)
  - Gate report written to `_bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json`

## Files to Modify

> ≤13 unique paths, one per line.
- `scripts/phase0-exit-gate.ts`
- `src/gate/assertions/p0-1-env.ts`
- `src/gate/assertions/p0-2-coms.ts`
- `src/gate/assertions/p0-3-mixed-model.ts`
- `src/gate/assertions/p0-4-guard.ts`
- `src/gate/assertions/p0-5-pi-lens.ts`
- `src/gate/assertions/p0-6-lsp.ts`
- `src/gate/assertions/p0-7-mcp-bridge.ts`
- `src/gate/assertions/p0-8-webhook.ts`
- `src/gate/assertions/p0-9-memory.ts`
- `src/gate/assertions/p0-10-gitnexus.ts`
- `src/gate/gate-runner.ts`
- `tests/gate/phase0-exit-gate.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.
>
> **AMENDED 2026-07-25 (during P0.11 implementation).** The original wording
> called the gate "read-only … never modifies protocol state". That cannot hold
> simultaneously with §13 clauses 6 and 7: clause 6's E2E slice *is* a
> registration sequence (all four SwarmClaw routes are POST-only, with no GET
> listing endpoint, so the bridge cannot be observed without registering), and
> clause 7's round-trip necessarily *retains* a memory. The invariant is
> restated below to what is actually true and enforceable.

**INV-1 — No credential writes, persistence, or leakage.** The gate never
creates, stores, or logs credentials. A **pre-existing** bearer token is *used*
— it must be transmitted in `HindsightClient`'s `Authorization` header to reach
an authenticated Hindsight — but it is never echoed into a detail string, the
report, or stdout, and never written to disk. (An earlier draft of this
invariant said credentials are never "transmitted", which contradicted the
gate's own authenticated probe.)

**INV-2 — No destructive operations.** The gate creates only additive probe
records and deletes/overwrites nothing. Specifically it may: register an agent
(`POST /api/agents`, idempotent — 409 tolerated), register an MCP server
(`POST /api/mcp-servers`), and retain one clearly-labelled memory during the
clause-7 round-trip. No delete, truncate, or overwrite path exists.

**INV-3 — Probe writes are identifiable.** Every record the gate creates is
named with a `qds-phase0-gate-probe` prefix so an operator can distinguish gate
artifacts from production state.

**INV-4 — No secrets in output.** The report (`phase0-gate-report.json`) and
stdout contain pass/fail status, durations, and error text only. Env vars are
reported by **name**, never by value; HTTP error bodies are truncated
service-response text.

**INV-5 — The clause-6 probe runs only against a DISPOSABLE SwarmClaw.** This is
an operating requirement, not a footnote. The probe creates one MCP-server
record per gate run and SwarmClaw exposes no `GET /api/mcp-servers` listing and
no `DELETE`, so the gate can neither discover nor remove a prior registration.
Run repeatedly against a **long-lived, shared** instance it would consume the
`MAX_MCP_SERVERS = 32` budget and **deny capacity to real registrations**.

- **Required procedure:** point the gate at a dedicated SwarmClaw started for
  the run (`SWARMCLAW_PORT=3100 bun src/swarmclaw/index.ts`). Its stores are
  in-memory, so a restart clears every probe record.
- **Enforcement:** the assertion detects `429` from registration and reports
  capacity exhaustion explicitly, naming the remedy, instead of surfacing a
  generic registration failure.
- **Agent registration is unaffected** — stable id, 409 tolerated, one record
  total.
- **Permanent fix is upstream:** a listing or delete endpoint on SwarmClaw would
  let the probe clean up after itself, at which point this requirement can be
  relaxed.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.
>
> Legend: `[x]` met · `[~]` partial (scope stated) · `[ ]` not met.

- [x] **Impl:** Gate script `scripts/phase0-exit-gate.ts` runs all 10 assertion groups and produces a structured JSON report — *asserted per PRD §13 CLAUSE (1,2,3,4,4b,5,6,7,7b,8), not per story number; the two mappings are not 1:1 and three predecessor stories are killed. 12 assertion entries (10 clauses + preflight + the clause-6 split).*
- [x] **Impl:** Each assertion group has at least one check that validates the corresponding story's E2E slice behavior
- [x] **Impl:** Fail-fast behavior: preflight failure skips remaining groups and reports immediately — *the P0.1 env group became a generic toolchain/env preflight, since P0.1 was killed*
- [x] **Impl:** Parallel execution — bounded-concurrency pool (default 4); assertions spawn children asynchronously so the pool is genuinely concurrent
- [x] **Contract:** `GateAssertionSchema` and `GateReportSchema` validated on all assertion definitions and output — *every definition is `safeParse`d at gate startup (abort → exit 2), ids checked unique; report validated in tests*
- [x] **Integration:** Gate script calls live SwarmClaw endpoints, Hindsight API, and GitNexus tools — no mocked dependencies — *clauses 1/2 read frozen runs-of-record (real recorded live runs) rather than re-executing paid runs; labelled as such at runtime*
- [~] **Test (unit/integration):** exits 1 with specific failure details when any predecessor is red — **proven**. Exits 0 when all predecessors are green — **not demonstrable on any available host** (see MANDATORY item below); covered by unit tests over the runner instead
- [x] **Test (guard):** Clean environment → fail-fast with the missing binaries/env listed; hanging check → per-assertion timeout fires (proven against a real child process, not only a mocked promise)
- [ ] **Test (e2e demo — MANDATORY):** **NOT MET.** Gate runs against the best-available provisioned environment and reports `PHASE_0_GATE: FAIL`, exit 1, report written. A green run is blocked by three environment/spec/**deliverable** gaps, none introduced by this story (clause 4 is a defect in the P0.5 deliverable, not an environment gap): clause 7 (Hindsight — **OQ-4 still BLOCKED-on-env**), clause 6 (`hindsight-local-mcp` is HTTP, not the stdio the clause specifies), clause 4 (`pi-lens-verify.ts` ignores `PI_LENS_ROOT`). See `_research/phase0-gate-report.md` §3
- [x] **Test (report format):** Gate report JSON validates against `GateReportSchema` — timestamp, overall status, per-assertion results with durations, and pass/fail/skip/void counts

## Dev Agent Record

**Implemented 2026-07-25.** Evidence report: `_research/phase0-gate-report.md`.
Machine-readable run: `_bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json`.

### Outcome

**`PHASE_0_GATE: FAIL` (exit 1) — 7 pass, 2 fail, 1 skip, 2 void. Phase-0 is NOT
currently exitable.** This is the gate working, not a gate defect.

AC1 (make-or-break) is **undemonstrated rather than failed**: its precondition
("all P0.1–P0.10 fully implemented *and their systems are running*") is not
satisfied on any available host. AC2 and AC3 are **met** — the gate exits 1,
prints `PHASE_0_GATE: FAIL`, and names each blocking assertion with specific
error detail, not a generic message.

### Blockers preventing a green gate (all upstream of this story)

1. **Clause 7 (P0.9 / Hindsight)** — no Hindsight API reachable; `:8888` is a
   Jupyter server. **OQ-4 is still recorded BLOCKED-on-env** (arm64
   `libpq`/`openssl@3`); P0.9 did not resolve it. Operator action required.
2. **Clause 6 (P0.7 / MCP bridge)** — agent registration succeeds against a live
   SwarmClaw, but MCP registration fails: `hindsight-local-mcp` is not on PATH
   and, per P0.7's own story, the real binary is an **HTTP server, not stdio
   JSON-RPC**. The clause may be unachievable as literally specified.
3. **Clause 4 (P0.5 / pi-lens)** — pi-lens 3.8.71 **is** installed, and
   `lsp-verify.ts` finds it via `PI_LENS_ROOT` (7/7 pass). `pi-lens-verify.ts`
   resolves **global-only** and has no override, so it exits 2. Defect in the
   P0.5 deliverable; **not fixed here** (outside this story's Files-to-Modify —
   scope creep). Recommended follow-up.

### Deviations from the story spec (deliberate, each justified)

- **Assertions are keyed to PRD §13 clauses, not to P0.1–P0.10 story numbers.**
  The story's file list implies 1:1; the PRD does not work that way (there is no
  clause 9; clause 6 covers two stories; three stories are killed).
- **Clause 3 kept LIVE as a structural check** rather than voided with P0.4.
  Voiding it would silently retire a budget-runaway safety property (R10). It is
  labelled STRUCTURAL at runtime and does not claim a live loopy-prompt kill.
- **`check()` returns `{pass, skip?, detail?}`; the runner measures
  `duration_ms`** rather than each check self-reporting it, as the sketched
  `GateAssertionSchema` implied — timing in the runner is authoritative and
  removes the same boilerplate from every assertion.
- **A SKIP fails the gate.** "Could not evaluate" must never read as green.
- **Security Invariants AMENDED** (done — see the Security Invariants section
  above). The original claimed the gate is read-only, which cannot hold with
  clause 6's POST-only registration sequence and clause 7's memory retain. The
  section now states five concrete invariants: no credential
  writes/persistence/leakage, no destructive operations, probe writes
  identifiable, no secrets in output, and clause-6 probing restricted to a
  disposable SwarmClaw (INV-1..INV-5).

### Review

Three independent local reviews were run before PR (correctness/edge-cases;
over-claiming/spec-fidelity; security/conventions). Findings applied:

- **CRITICAL (found by two reviewers independently):** `spawnSync` blocks the
  event loop, so the per-assertion timeout could never preempt those checks and
  the pool was effectively serialised; `p0-6`'s 180 s inner budget also exceeded
  the advertised 30 s guard 6×. Fixed: all child spawning is async (`execFile`),
  a per-assertion `timeout_ms` override was added and declared where needed, and
  the PATH probe no longer shells out at all.
- **CRITICAL:** total-budget expiry did not stop the pool claiming new work, so
  the process could outlive its stated budget. Fixed: the pool observes expiry.
- **IMPORTANT:** hand-rolled CLI parsing replaced with the repo's shared
  `parseValueFlags` helper.
- **IMPORTANT:** the timeout/concurrency tests used non-blocking mocks and could
  not catch the bug above. Added three tests that spawn **real** child processes.
- Two false-reds found by running the gate: `assertions.exit_code` key path in
  the P0.3 evidence file, and a stderr tail that sliced mid-path. Both fixed.
- Spec-fidelity review returned **no findings**; security review confirmed no
  secret/env-value leakage into the report or stdout.

### Verification

- `bun test tests/gate/` → **45 pass, 0 fail**
- `bun test` (repo-wide) → **582 pass, 3 skip, 2 fail**; both failures are
  **pre-existing and unrelated** — `tests/gitnexus/graph-queries.test.ts`
  (fixture symbol filtered from the standing index) and
  `cli-anything/test/runner-integration.test.ts` (worker-timeout AC3). Both
  reproduce on the `origin/main` tree; this PR touches zero cli-anything files.
- `bunx tsc --noEmit` clean; `biome check` clean on all new files.
- CLI contract: unknown flag → 2, `--help` → 0, `--report` without value → 2.

### Flagged for the story owner (not changed here, per operator instruction)

- `sprint-status.yaml` marks **P0.5** and **P0.9** `done`, but both story files
  have **all DoD boxes unchecked**; P0.5's status is *"Changes Required /
  Partially Approved"* with its own MANDATORY agent e2e **not met**.
- **pi version drift (R4):** installed `pi` is **0.81.1**; OQ-5 pins **0.55.0**
  and requires a re-run of the load smoke-test before adopting pi ≥ 0.73.
- **gitnexus index is STALE** — FR-EX-9 makes a fresh `analyze` a Phase-1
  sequencing precondition.
- **`provision-hindsight-banks.ts` bridge probe is broken** (pre-existing): it
  GETs POST-only SwarmClaw routes, so it can never succeed against a live
  server; its default port (3000) also mismatches SwarmClaw's (3100).
