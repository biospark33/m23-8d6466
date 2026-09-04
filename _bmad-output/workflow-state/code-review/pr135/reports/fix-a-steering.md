# Fix report — Cluster A (src/phase-engine/steering.ts + tests/phase-engine/steering.test.ts)

PR 135 review round 2. Branch `feature/df3-3-resident-orchestrator-agent`. No commits made.

## Verdict table

| Item | Verdict | Evidence |
|------|---------|----------|
| A1 [HIGH] select_roster fail-open, `ctx.rosterIds === undefined` | **fixed** | steering.ts:298-302 — `!(ctx.rosterIds ?? []).includes(...)`; absent set reads as empty, pick rejected with `outside closed roster set`. In-set pick with rosterIds present still accepted (existing test at steering.test.ts:116 passes unchanged). |
| A2 [MED] meter() no finite/negative guard | **fixed** | steering.ts:225-230 — `clamp(n) = Number.isFinite(n) && n > 0 ? n : 0` on both terms before rounding. |
| A3 [MED] throwing onTripwire breaks never-throws | **fixed** | steering.ts:243-249 — observer call wrapped in try/catch; journal row (already pushed) survives. |
| A4 [LOW] parseReply/safeParse callee throw escapes solicit | **fixed** | steering.ts:272-279 — parse step wrapped; a throw becomes a malformed reply and counts toward MAX_MALFORMED_ATTEMPTS. |
| A5 [MED] degradation cause discarded | **fixed (in-memory getter)** | Journal constraint honored, no schema invented: the journal resident block is a closed key set (e2e asserts exact keys, resident-e2e.test.ts:356) and the tripwire cause union is closed to `gate_bypass_attempt`. Exposed as `SteeringController.lastDegradationReason` (interface doc steering.ts:108-113), a sanitized getter on the controller — deliberately NOT on `ResidentTelemetry`, because `residentTelemetryOf()` (pipeline-run.ts:1431-1442) spreads telemetry straight into `writeResident`, so a telemetry field would have leaked into the journal and broken the closed-key-set assert. Set on both degradation paths (caller throw steering.ts:268, malformed-limit steering.ts:283). |
| A6 [LOW] correction prompt doesn't restate the union | **fixed** | steering.ts:176 — `malformedCorrectionPrompt` appends DIRECTIVE_INSTRUCTION (the four member shapes). Prompt grows ~440 chars, still far under the ceiling (correction prompts are caller-supplied text, not routed through renderPrompt's budget). |
| A7 [MED] head-truncation cuts the NEWEST context first | **fixed** | `truncateHeadWithSuffix` → `truncateTailWithSuffix` (steering.ts:136-154): suffix reserved pre-cut, surrogate-safe (low-surrogate scan at the cut point), drops the HEAD so the tail (accepted guidance, pushed last) survives. PROMPT_CHAR_CEILING contract preserved; the 20k-char ceiling test passes unchanged and a new A7 test pins tail-survival. |
| A8 [LOW] KNOWN_ACTIONS duplicates schema literals | **fixed** | steering.ts:56 — `KNOWN_ACTIONS = SteeringDirectiveSchema.options.map(m => m.shape.action.value)`; verified `options` API against zod ^3.24. |
| A9 µ$ rounding tie | **added** | steering.test.ts — 1115 × 100000 / 1e6 = 111.5 → 112 (round-half-up). |
| A10 select_roster rejection asserts single attempt | **added** | `expect(s.calls()).toBe(1)` added to the existing out-of-set test. |
| A11 malformed-counter resets across solicits | **added** | 4-call test: recover in solicit 1 (2 calls), then ONE malformed in solicit 2 still gets its correction (2 more calls) — status stays active, directives 2. |
| A12 two consecutive retries → {build:2} | **added** | Two `post_gate_failure` solicits, `steeringIterations` toEqual `{ build: 2 }`. |
| A13 required fields rejected on known actions | **added (no source change needed)** | Verified against the live schema before editing: `{action:"retry"}`, `{action:"select_roster"}`, `{action:"abort"}`, `{action:"retry",guidance:42}` all already fail with `invalid_type` — guidance/rosterId/reason are declared required (only `note` is optional). Pinned as a test; no schema change made. |
| A14 correction attempt metered | **added** | malformed (28 µ$) then valid (28 µ$) → 56. |

## Behavior changes flagged for wave 2

1. **select_roster with no `rosterIds` in ctx is now rejected** (was accepted). Sole caller is `scripts/pipeline-run.ts`, which always passes a `rosterIds` array (line 561 type is required `readonly string[]`, populated from `closedRosterIds` at 1254 and passed at 1310/1337/1399) — so no live path changes, but a future caller omitting the field now gets fail-closed instead of fail-open. No e2e expectation depends on the old behavior.
2. **Tail-truncation**: the 20k-char ceiling test's suffix/instruction asserts pass unchanged; the only new observable is WHICH half of the context survives. Any test elsewhere asserting head-survival would break — grep found none (only `tests/reverify/report.test.ts` and `tests/phase-engine/envelope-adapter.test.ts`, which exercise `src/reverify/report.ts` and `envelope-adapter.ts`, unrelated helpers with their own truncators).
3. **`lastDegradationReason` on the controller**: additive interface member; `residentTelemetryOf()` spreads `steering.telemetry` only, so the journal resident block key set is untouched (e2e closed-key-set assert still passes for the steering module's part — see test-environment note below).
4. **Correction prompt is ~440 chars longer** and now contains the union shapes. The existing INV-2 test ("never echoes the model's raw text") passes; a stateless caller's second attempt now sees the schema.

## Impact analysis

GitNexus `impact({target:"solicit"|"createSteering"})` returns "Target not found" — the index predates this PR's new files. Reindexed via the documented command was out of scope for a fix wave (other agents editing concurrently). Manual blast radius by grep instead:

- `createSteering`: defined steering.ts, re-exported by `src/phase-engine/index.ts:103`, consumed by `scripts/pipeline-run.ts:1279` (sole production caller).
- `solicit`: called via `solicitResident` (pipeline-run.ts:629) at three sites (1310, 1337, 1399).
- `truncateHeadWithSuffix`: module-private, single call site (renderPrompt) — renamed in the same file.
- `KNOWN_ACTIONS`: module-private, single call site (rejectionDetail).
- Risk: LOW. Contained entirely to this PR's own modules (steering.ts + its test). pipeline-run.ts was NOT edited (outside my file list).

## Verification

```
bun test tests/phase-engine/steering.test.ts
  38 pass
  0 fail
  138 expect() calls
Ran 38 tests across 1 file. [50.00ms]

bunx biome check src/phase-engine/steering.ts tests/phase-engine/steering.test.ts
  Checked 2 files in 17ms. No fixes applied.   (clean)

bunx tsc --noEmit | grep steering.ts   →  0 errors in steering files
```

### Test-environment note (not my files)

`tsc --noEmit` currently reports errors in `scripts/pipeline-run.ts` (TS2554 ×3, TS2454, TS2339) and `src/fleet/resident.ts` — those files are mid-edit by the cluster B/C fix agents working in the same tree; none of the errors reference steering. `bun test tests/phase-engine/resident-e2e.test.ts` fails 5/6, and fails **identically with my steering.ts reverted to HEAD** (verified by checkout + rerun + restore), so the e2e failures are the pipeline-run/resident edits in flight, not cluster A. Cluster A's own gate is green.
