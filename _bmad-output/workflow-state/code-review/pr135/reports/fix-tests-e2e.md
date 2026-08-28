# fix-tests-e2e — PR #135 review fixer report

Scope: `tests/phase-engine/resident-e2e.test.ts` only (wave-2, e2e suite).
`pipeline-run.test.ts` is another agent's; no src/ or scripts/ edits. No
commits, no staging.

## Round 7

Fixer: fix-tests-e2e (wave 2). Branch `feature/df3-3-resident-orchestrator-agent`,
wave-1 source fixes already on disk.

### Wave-1 fallout reconciliation

Baseline before any edit: `bun test tests/phase-engine/resident-e2e.test.ts` →
**12 pass / 0 fail**. Every wave-1 behavior-change flag was checked against the
suite; NONE required re-pinning:

1. **stop()/SIGINT quarantines the session jsonl to `.torn-<seq>`** (S2-1):
   the SIGINT test reads the session file only as a pre-signal readiness probe
   (`invocations()` polls to 3 markers, then the file is never read again);
   its journal pins assert `resident.exitStatus === "transient"`, which the
   hoisted quarantine leaves untouched. Passes unchanged.
2. **exitStatus null after spawn failure** (S2-3): no e2e leg pins a journaled
   exitStatus after a spawn failure. The degraded leg pins `"logic"` for a
   non-zero process exit — that path still runs a process, so S2-3 does not
   reach it. Passes unchanged.
3. **Off-point directives rejected / run_end proceed-only** (S1-1): every
   scripted reply in this suite is on-point (proceed everywhere, retry at
   post_gate_failure, abort at run_start/post_gate_failure, select_roster at
   run_start). Passes unchanged.
4. **Code-phase roster picks engine-rejected / dup-named dispatch phases
   disable roster steering** (S3-2/S3-7): the fixture manifest
   (`tests/phase-engine/fixtures/pipeline.resident.json`) declares plan/build
   as `kind: "code"`, so the advertised `phaseIds` set is now EMPTY and the
   closed-set test's pick (`phase: "build"`) is rejectable on phase too. But
   the engine's rosterId check (`steering.ts:408`) fires BEFORE the phase
   check (`steering.ts:417`), so the tripwire detail is still
   `rosterId outside closed roster set: no-such-role` — the test's
   `"no-such-role"` substring pin and its 2-accepted/1-rejected counts hold
   unchanged. Verified by the green run; no re-pin needed.
5. **Extra journal resident-block refresh after run.finish** (S3-3): additive
   intermediate write; the closed key set and terminal values are unchanged.
   The telemetry-boundary and zero-ceiling key-set pins pass unchanged.

No failure traced to a wave-1 regression; nothing was papered over.

### Findings

| # | sev | verdict | verified-at → change |
|---|-----|---------|----------------------|
| W2-1 | LOW | **patched** | Verified at old `resident-e2e.test.ts:786`: the `finally` SIGKILLed only the runner; a regression leaving the hung fake-pi child alive would orphan it (600 s `QDS_RESIDENT_TIMEOUT_MS` hang) past the suite. Fix (post-edit `:808-822`): after the runner kill, `Bun.spawnSync(["pkill","-KILL","-f",sessionPath])` reaps the grandchild by its unique argv marker — `resident.ts:458` puts `--session <sessionPath>` on the pi child's command line, and that full path (`<unique mkdtemp>/run-end-signal/sig-run-end.resident.jsonl`) appears on no unrelated process (the runner's own argv carries `--run-root <dir>`, never the session file). pkill's no-match exit 1 is the normal path and is ignored; stdout/stderr ignored. |
| W2-3 | INFO | **patched** | Verified at old `:809-815`: the zero-ceiling leg's `toEqual` shape ignores undefined-valued keys, so a `resident: undefined` (or any extra top-level key) would pass "no resident block". Fix (post-edit `:845-849`): added the closed-key idiom already used by the telemetry-boundary leg — `expect(Object.keys(leg.journal).sort()).toEqual(["gateEvents","ok","phases","runId","version"])` — alongside the existing toEqual. |
| W2-4 | INFO | **patched** | Verified at old `:755-762`: the 30 s exit poll ran before `new Response(proc.stdout/stderr).text()` started; a >64KB burst between signal and exit would fill the pipe buffer and deadlock the runner into the timeout. Fix (post-edit `:756-782`): `const drained = Promise.all([...stdout, ...stderr])` starts BEFORE the poll (same concurrent shape as `runLeg`'s `:196-200`), awaited after the poll as `const [, stderr] = await drained`. |
| W2-5 | LOW | **patched** | Verified: no leg parsed the journaled `resident.exitStatus` against the CC-1 enum — the telemetry-boundary leg (old `:602`) only checked null-or-string, so `"ok"` would pass. Fix in the demo leg (post-edit `:397-405`): import `EXIT_STATUSES` from `../../cli-anything/src/types.ts` (the exact idiom of `tests/providers/cap-rejection.test.ts:19`; `src/phase-engine/types.ts:14-17` confirms that file is the CC-1 declaration site), assert `cc1.toContain(r?.exitStatus)` (widened to `readonly unknown[]` so the nullable read-side view typechecks against the const tuple), and — the demo leg's three calls all succeed — pin `r?.exitStatus).toBe("success")` alongside. Pin verified live: the demo run journals `"success"` (`resident.ts:572` sets `lastExit = "success"` on each clean call). |

### Gate results

- `bun test tests/phase-engine/resident-e2e.test.ts` — **12 pass / 0 fail**,
  120 expect() calls (was 117; +3 from W2-3/W2-5 pins). Run twice (before and
  after the W2-5 type fix), green both times.
- `bunx biome check tests/phase-engine/resident-e2e.test.ts` — clean, no fixes.
- `bunx tsc --noEmit` — clean (exit 0, whole repo). First pass caught a real
  type error in the W2-5 assertion (`toContain` on the const tuple rejects the
  nullable view); fixed via the `readonly unknown[]` widening above, re-run
  clean.
