# Z3 R2: fork-side dispositions (leaf-K)

Fork worktree: `solstice-ai/.claude/worktrees/z3-sc`, branch `feature/z3-exit-round-counterpart`. Nothing is committed.<br />
Every change is in `scripts/solstice/z3-exit-round.ts` and its test. `protocol-z3-exit-round.ts` and `scheduler.ts` are unchanged since R1.

| Finding | Disposition | Note |
|---|---|---|
| E-1 / A-1 / B-1 (artifacts) | PATCH | `state` now emits `artifacts` for every run, as persisted: `{id, kind, stepId, title, content, createdAt}`. `stepId` is the artifact's `phaseId`, i.e. the step that wrote it. Both factory adapters create artifacts with `createArtifact(run, {id: step.id}, …)`, so that field holds the step id. `content` is the raw JSON verdict or observe payload, so the factory reads the verdict status with `JSON.parse(content).status`. Test: a `factory_result` and a `factory_observe` artifact, built with the same constructor the adapters use, come back field for field, and survive the one-line JSON round trip. The run key set is pinned with `artifacts` included. |
| E-1 / A-1 (event summary) | PATCH | Each event now carries `summary` (always present on the event store row). The test pins it. |
| E-2 / A-6 / B-2 (disarm) | PATCH | New verb `disarm <scheduleId>`, printing `{disarmed, firedRunId}`.<br />Behaviour:<br />- An `active` or `paused` row is archived (`archivedFromStatus` recorded, history `reason: z3_disarmed`). The tick fires only `active` rows. `paused` is archived as well, because a paused row can be resumed.<br />- After writing, it waits 3 s, then re-checks whether a run with this `scheduleId` exists.<br />- `firedRunId` is the newest such run, or null. disarm never cancels that run; the caller runs `cancel` on it.<br />- `disarmed` is true when no run fired and the row can no longer fire (archived, or already failed/refused).<br />- Unknown ids and non-z3 schedules are refused, and nothing is written.<br />- It is idempotent.<br />Tests:<br />- disarm on a due row means the REAL scheduler tick fires nothing, and a re-run still reports disarmed.<br />- Race 1: the tick fired first, so disarm returns `{disarmed:false, firedRunId}` and leaves the row `completed`.<br />- Race 2: during the settle, a daemon that read the row as active overwrites it and creates the run. The re-check reports that run.<br />- A non-z3 schedule is refused and stays `active`.<br />Residual: there is no lock across the CLI and daemon processes. A tick slower than the 3 s settle could still fire unseen. The caller should re-run `disarm` or read `state`, and cancel anything with that `scheduleId`. This is marked `ponytail:` in the code. |
| E-2 (arm `protocolConfig ?? null`) | PATCH | `arm` now throws if the persisted row has no `protocolConfig`, instead of printing null. Its output type is a non-null record, so the factory's strict schema holds. |
| E-7 (cancel duration vs the 120 s factory timeout) | PATCH (parallel) + budget reported | The exit-checked verify cancels now run in parallel. The awaited `cancelFactoryRuns` is the SC2.4 path; it stays sequential and is not changed here. Worst case = (outstanding external_job submits) × `FLEET_EXEC_TIMEOUT_MS` 300 s inside `cancelFactoryRuns`, plus one parallel verify of 300 s. A z3 round is a strict single-cursor `nextStepId` chain with no parallel steps, so at most one submit is outstanding at a time. Required factory budget: at least 2 × 300 s plus tsx boot, about 11 min. **Recommend `forkCli` cancel timeout = 660_000 ms.** The CLI header documents this. |
| E-5 (in-flight submit orphaned on cancel), fork part | PATCH | `cancel` adds `inFlightRequestIds`: outstanding external_job entries that have no runId yet, meaning the submit exec is still running. Their ack lands on a cancelled run and is dropped (the F-004 guard, protocol-factory.ts:197-198). The requestId is therefore the only key the factory can map through `recordsForRequestId`. `cancelFactoryRuns` still marks those entries cancelled, so no replay resubmits them (tested). Mapping and destroy stay with the factory. |
| A-2 / B-3 (attribution by requestId), fork part | data available | `state.factoryState` already holds every entry's `requestId`, including `submitting` entries; SC2.1 persists it before the exec. No fork change is needed. The mapping is factory-side. |
| E-3, E-4, E-6, E-8, E-9, E-10, A-3–A-5, A-7–A-13, B-4–B-21 | n/a (factory) | None of these touches fork code. One note for E-10 / B-18: the fork already accepts `codePollTimeoutMs` in the arm config, and it covers both `z3-code-run` and `z3-code-observe` (R1). The factory only has to pass it. |
| A-11 (stale fork CLI path in factory comments) | n/a (factory) | The correct path is `scripts/solstice/z3-exit-round.ts`. |

Gates (fork worktree):

- `protocol-z3-exit-round.test.ts`: 20/20, 0 fail
- `scripts/solstice/z3-exit-round.test.ts`: 13/13, 0 fail (was 7; adds artifacts, in-flight cancel, and 4 disarm tests)
- Regression: `protocol-qa-hunter-pack` 6/6, `protocol-triggers` 10/10, `protocol-z2-e2e` 4/4, `runtime/scheduler` 19/19
- `npx tsc --noEmit -p tsconfig.json`: exit 0
- `npx eslint` on the 5 changed `.ts` files: exit 0

Contract changes for the factory (all additive):

1. `state` runs gain `artifacts: [{id, kind, stepId|null, title, content, createdAt}]`, and events gain `summary`. The run key set is now `artifacts, createdAt, events, factoryState, id, scheduleId, status, steps, templateId`.
2. `cancel` output gains `inFlightRequestIds: string[]`.
3. New verb `disarm <scheduleId>` prints `{disarmed: boolean, firedRunId: string|null}`. It takes about 3 s, because of the settle.
4. `cancel` needs a timeout of at least 660 s.
