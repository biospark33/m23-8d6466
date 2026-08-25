# Recon — manifest-execution gap analysis

Question: can the CURRENT code execute manifest phases on a provisioned exe.dev
box, end-to-end? Read-only recon; all claims verified from source on branch
`feature/df3-2-fanout-best-of-n`.

## Verdict: NO

The executor exists and is tested host-side; nothing invokes it anywhere.
Dispatch provably stops at stamp+ack.

## 1. Intended chain

- `src/fleet/dispatch.ts:1374-1376` — dispatch loads the manifest HOST-SIDE for
  validation + stamping only (`loadManifest(manifestPath, manifestBudgetMs,
  repoRoot)`); `:1391-1392` states the intent that "scripts/pipeline-run.ts
  reads the DELIVERED, already-stamped" copy.
- Step list `dispatch.ts:642-643`: validate → resolve → admit → record → box →
  key → fill → gate → expose → ack. That is ALL of it.
- Step 8 fill (`dispatch.ts:2223-2284`): stamps `limitMicroUsd`
  (`stampManifestLimit`, `:2225`), serializes BOTH `pipeline.yaml` AND the
  witness `run-context.json` (carrying `effectiveCeilingMicros`, `:2230-2256`)
  and delivers them to box HOME via `fillRun` (`src/providers/driver.ts:814`;
  box-relative paths land at `$HOME` — T2.1 reads them back at
  `tests/fleet/e2e/tier2-dispatch-engine.live.test.ts:184`).
- Steps 9-11: setup gate (`:2287-2454`), expose (`:2469+`), ack returning
  `{state:"ready"}` = "provisioned, never succeeded" (`:2657-2698`). **No step
  starts any engine. Nothing copies an executor into the box.**
- The designed executor: `scripts/pipeline-run.ts:8` —
  `bun scripts/pipeline-run.ts --manifest <path> --budget-ms <n> --journal out.json`.
  Loads the manifest (`:666`), reconciles dispatch's ceiling witness
  (`runContextFrom`, `:272-340`; in-box intent explicit at `:264-265`: "it
  writes the witness moments before the box runs"), registers phase bodies
  (`makeBodyFactory :500-537`: kind `code` → local spawn with scrubbed env
  `:110-126`; kind `dispatch_task` → dispatchTask; other kinds throw "no
  executor registered"), writes journal rows + terminal marker under `/run`
  ("the only environment whose markers a poller reads", `journal.ts:32-34,43`),
  opens a SQLite Tracer at `<markerRoot>/trace`.
- **Callers of pipeline-run.ts: tests ONLY** —
  `tests/phase-engine/pipeline-run.test.ts:19`,
  `tests/phase-engine/trace/wiring.test.ts:587/683/769`,
  `tests/phase-engine/issue-correlation.test.ts:811`. Zero references in src/,
  scripts/, or any fleet verb. Verb registry is closed at exactly 6 entries —
  dispatch, status, harvest, teardown, fanout, rank (`verbs.ts:44-49`). No
  run/execute verb exists.

## 2. Substrate assumptions vs reality

pipeline-run is `#!/usr/bin/env bun` TS importing repo-relative modules
(`:1,:43-75`). It needs (a) bun/node, (b) the QDS-Factory checkout beside it.

Box has NEITHER. TIER-1 finding F1 is a MEASURED environment fact:
`node --version` → exit 127 on the box image; image contract = python3, curl,
git, pi (`_bmad-output/workflow-state/code-review/e2e-audit/e2e-run-report.md:106-108,31`).

Post-dispatch box holds: `$HOME/pipeline.yaml` (stamped),
`$HOME/run-context.json`, `$HOME/app/.env` (run key +
`QDS_TEAM_RUNNER=local`, written by `setup-gate.ts:283-295` for DF1.6's spawn
seam), target repo cloned at `$HOME/src`.

Dry-trace answer to "could `bun scripts/pipeline-run.ts …` execute
t2.pipeline.json on the box today": NO, twice over.
1. No bun on the box and the script is never delivered anyway.
2. Even host-side, nothing passes it box context — and its dispatch_task body
   spawns `bun …/team-lead-driver.ts` via buildTeamSpawn (hardcodes
   `file:"bun"`, `cli-anything/src/team-events.ts:36-47`) requiring
   ANTHROPIC/OPENROUTER key in process.env + `QDS_TEAM_RUNNER === "local"`
   (`dispatch-task.ts:133-136`) — that executes wherever pipeline-run runs,
   not on the box.

The unused `QDS_TEAM_RUNNER=local` line in the box env file awaits a consumer
that was never shipped.

## 3. Gap list

| # | Gap | Evidence |
|---|-----|----------|
| G1 | No in-box runtime: no bun/node in image | F1, run-report.md:108 |
| G2 | No invocation link anywhere: no verb/hook/exec reference to pipeline-run | grep across src/scripts/tests = tests + comments only; dispatch ends at ack (dispatch.ts:2657-2698) |
| G3 | Executor never transported: fill array = pipeline.yaml + run-context.json only | dispatch.ts:2230-2256 |
| G4 | Journal + /run terminal marker written on zero real runs | they only exist when pipeline-run executes, which never happens post-dispatch |
| G5 | Harvest can't see engine observability even if it existed: probes `specs app_docs adws/adw_data/ssmf.db trace.db run.log` INSIDE repo workdir candidates `["app","src","/home/agent/app","/home/agent/src"]`, while tracer writes `/run/trace/trace.db` — two different trace.db's (inkwell vs phase-engine) | harvest.ts:318-333,73-74 |
| G6 | Code-phase stdout relayed to stderr and discarded from the journal value ({exitCode} only) — step outputs unqueryable; blocks rank's future scoring | pipeline-run.ts:120-128,:523 |

Working today (non-gaps): manifest delivery + stamp + witness AC9a/9b proven
live (T2.1 assert #5); gate C/D drive pi in-box on the run key; harvest bundle
+ teardown + spend capture all real.

## 4. T3 design

Pure-test CANNOT honestly exercise manifest-on-box execution — hand-exec'ing
each command from the harness is exactly T2.1's cheat again. One missing link
⇒ pick one:

**(A) SMALL-SHIM — recommended now.** ~150-250 LOC host-side remote runner,
e.g. `scripts/pipeline-run-remote.ts`:
- fetch the DELIVERED manifest off-box via `driver.exec cat $HOME/pipeline.yaml`
  (proves the stamp rode out);
- loadManifest it, drive `Run`/walkPhases with a body factory identical to
  makeBodyFactory except the `code` body calls
  `driver.exec(vm, ["sh","-c",cmd])` in `$HOME/src` instead of local spawn;
- FileJournal to the records dir; `QDS_RUN_ROOT=<tmp>` for the marker;
  reuse runContextFrom's witness logic unchanged.
- Manifest: keep echo/true phases, ADD a third code phase:
  `cd $HOME/src && printf '<payload>' > t3_phase_marker.txt && git add && git -c user.name=t3 commit -q -m t3-marker`.
- Asserts: (1) journal rows per phase, ordered, settled ok (mirror
  tests/phase-engine/pipeline-run.test.ts expectations) + terminal marker under
  `QDS_RUN_ROOT/<runId>`; (2) harvest bundle carries the marker:
  `git show refs/sandbox/<runId>:t3_phase_marker.txt`; (3) witness reconciled
  (`effectiveCeilingMicros == record.limitMicroUsd`); (4) spend ≤ cap;
  teardown / box-gone / key-revoked as T2.1.
- Honest label: phases execute ON THE BOX orchestrated FROM the host —
  production code paths throughout, no fake substrate.

**(B) REAL-STORY — the actual product promise.** In-box executor via
`bun build --compile --target=bun-linux-x64` single binary of pipeline-run.ts,
delivered at fill, exec'd with `. $HOME/app/.env`, journal+marker under /run,
harvest extended to pull `/run/trace/trace.db` + the journal (fixes G5), plus a
decision on dispatch_task-in-box (cannot today: buildTeamSpawn hardcodes
`file:"bun"`). Closes G1-G4 properly; makes the poller contract real.

Either path ALSO fix G6 cheaply: return a bounded stdout tail on the
code-phase value so step outputs become queryable for rank.

## 5. Scope call

Chain-MISSING, not chain-present ⇒ **small-shim (A) for T3 evidence now;
REAL-STORY (B) as a proper DF story for the product promise.**

Basis: every upstream primitive (stamp/witness AC9a-b, body factories, journal,
marker, tracer, dispatch_task→pi) exists and is unit/live-tested host-side;
exactly ONE link — invocation substrate in the box — is absent (G1-G3), and it
cannot be papered over by tests because the box physically lacks the runtime
(F1, measured exit 127).

Estimated: (A) ~1 new script + 1 manifest edit + ~300-line live test.
(B) full story: compile + deliver + exec plumbing, /run harvest extension,
poller docs, dispatch_task-in-box decision.
