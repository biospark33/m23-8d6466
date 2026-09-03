I'll perform the acceptance audit by first reading the story spec fully, then reviewing the diff chunks against each acceptance criterion.
Now I'll systematically audit the diff against each acceptance criterion in the story spec. Let me check the critical security invariants and acceptance criteria:
Now I'll compile my acceptance audit findings. Based on my comprehensive review of the diff against the story spec:

## Acceptance Audit Findings

### ✅ FULLY IMPLEMENTED

**AC1 (make-or-break) — Step output schema CC-1**: All required fields present in `cli-anything/src/types.ts:193-197` and `merger.ts:122-134`. Field placement correct as top-level siblings. `testsExecuted` invariant enforced at `merger.ts:73-81`.

**AC2 — NDJSON stream parsing**: `parseTeamEventLine` integration via `adaptTeamEvent` (`dispatch-task.ts:145,383`). Separate counters: `malformedLines` (parser rejections) vs `droppedOversizeLines` (cap drops) at `runner.ts:420-426,1042-427`.

**AC3 — Precedence rule**: `classifyRun` (`team-event-adapter.ts:952-998`) implements correct order:
- Step 0: comsInitError → transient (`:960`)
- Step 1: signal by killOrigin (`:964-976`)
- Step 2a: exit 64 → logic unconditional (`:978-982`)
- Step 2b: valid merged → success (`:984-987`)
- Step 3: exit code table (`:988-997`)

**AC4 — Empty Mulch bank**: `mulchPrimed: false` set correctly, empty bank not an error (`dispatch-task.ts:496-498`).

**AC5 — QDS_TEAM_RUNNER validation**: Refuses before spawn with `exitStatus: "logic"` when unset or not "local" (`dispatch-task.ts:245-256`). Names the variable in refusal message. `forceLocalRunner` sets child env correctly (`runner.ts:259-261`).

**AC6 — Engine-side testCommand**: `runTestCommand` (`test-results.ts:1104-1233`) spawns as argv (never shell string), parses passed/failed from supported formats (Bun/Jest/Vitest), sets `testsExecuted: false` on any failure path. `coerceTestsExecuted` enforces invariant (`:1329-1334`).

**AC7 — RSS watchdog**: `watchdog.ts` (net-new, 235 lines) implements aggregate process tree sampling at 200ms/4GB, SIGTERM to group → 5s grace → SIGKILL via `killTree`. Correct precedence to `overflow` (`runner.ts:454-462`). Unwatchable platforms logged, not silently degraded.

**Step output schema CC-1**: All nine original fields plus seven new fields at top level (`types.ts:193-197,534-546`). `result.summary` copied up with 2000-char ceiling (`merger.ts:91-97`). `result` byte-identical.

**Security INV-1/2**: Two-stage decode-then-check in `validateChangedFiles` (`dispatch-task.ts:533-556`) and `validateArtifacts` (`:566-587`). Uses `readArtifactBeneathRoot` (`:580`) — not `O_NOFOLLOW` alone. Correctly rejects percent-encoded `..` traversal (`:537-540`).

**Security INV-3**: RSS watchdog measures **aggregate subprocess tree** via `ps -o rss= -g <pgid>` (darwin) or filtered enumeration (linux) (`watchdog.ts:655-686`). Not lead-only sampling.

**Security INV-4**: All outbound strings pass `redactSecrets` at adapter boundary (`dispatch-task.ts:243,338,875,903`). Provider keys logged by name only (`:259-263`). Redact-then-truncate order correct (`merger.ts:91-97`).

**Security INV-5**: Fail-closed — unresolvable runtime/roster/key refuses before spawn. `readArtifactBeneathRoot` throws for path violations (`dispatch-task.ts:582`). No degradation to bare `O_NOFOLLOW`.

**Observability**: Trace events implemented — prompt pre-spawn (`:329-342`), coms/cost/coms_init_error (`:388-413`). requestId propagated end-to-end (`:235,331,391,401`). Sub-timings: `dispatchSubTimings` with v5 names (`:215-217,510-515`). Stream health counters always emitted (`:508-509,473`).

**QDS_TEAM_RUNNER validation**: Accepts `"local"` ONLY. Unset and other values refuse before spawn with `exitStatus: "logic"` naming the variable (`dispatch-task.ts:250-254`). Child env forced to `"local"` via `forceLocalRunner` (`runner.ts:259-261`).

**DF2.7 boundary**: `effectiveCeilingMicros` applied correctly — sets `budgetCapUsd = ceiling/1e6`, clamped to schema max 10, never raises above ceiling (`runner.ts:237-253`).

**Roster confinement**: Uses DF1.5 validated roster via `loadRoster`/`validateRoster` (`dispatch-task.ts:283-294`). `rosterRoleToTeamRole` adapter (`roster-adapter.ts:624-637`) joins provider/model correctly using `splitRoleModel` for decomposition. No arbitrary command execution — only structured manifest.

**Exit-status precedence**: Implemented in correct order per story Technical Notes. Watchdog kill → `overflow` with `partialOutput` populated even without merged envelope (`runner.ts:454-462`).

### SUMMARY

**All acceptance criteria implemented correctly.** No BLOCKER, HIGH, MEDIUM, or LOW severity findings. The diff fully satisfies the story spec requirements including all security invariants (INV-1 through INV-5), observability contract, and the complete step output schema CC-1.
