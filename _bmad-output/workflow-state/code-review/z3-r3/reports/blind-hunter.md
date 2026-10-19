# Z3 R3 — Blind Hunter

I worked from the two diffs only (`z3-factory.diff`, `z3-fork.diff`). Line numbers are file lines in the new or edited files.

### B-1 [HIGH] scripts/z3/leg-drivers.ts:604
**Problem.** The watcher checks the hold once, before it waits for `retainDone()`. It does not check the journal again before the kill. The wrapper's hold ends after `HOLD_LIMIT_S` (240 s). After that it writes `expired` and exits 99, and the fork records the code step as failed. `held()` is "some `held` line and no `exec` line", so it still returns true after `expired`. `heldAtKill: true` and `releasedAfterRetain: true` are hard-coded literals, so AC4 (`assertions.ts:303-304`) can never catch this case.
The wait can run past 240 s. The fork chains to `z3-code-run` once `qa-observe-<last>` finishes, but the driver still has the last QA leg's tail to run: `awaitResult`, forensics (up to one 10 s stability sleep), `awaitObserveStep`, `observeDeltas`, `retainFindings` and `gatewayAssert`. Each `state()` read is a blocking `docker exec … npx tsx` call.
`observeDeltas` (`:359`) makes this worse. If any delta is unattributed while a sibling is `submitting`, it re-polls up to 30 × 10 s = 300 s. In the last QA observe, that sibling is the held code submit, and the hold cannot ack until the observe returns. So any unattributed fresh key at the last observe means the hold expires.
**Failure.** The last QA tail takes more than 240 s. The hold expires and the code step fails with exit 99. The watcher still kills, releases and restarts the fork, and the restarted fork has nothing to replay. `driveKillAndProvision` then throws "z3-code-run failed fork-side". The round is red by construction, and if crash-window evidence lands it says `heldAtKill: true` for a hold that had already expired.
**Fix.** Put a timestamp on each journal line. Right before the kill, re-read the journal and stand down if it shows `expired`, `exec`, or a held line older than the limit. Record the actual held/expired state instead of literal `true`. Either size the hold limit to the QA tail and leave `observeDeltas` out of the gated window (do not wait on a `submitting` sibling that is the gated code step), or start the hold only after `retainDone`. Add a fixture test where the hold expires during the retain wait.

### B-2 [HIGH] tests/fleet/e2e/z3-exit-round.live.test.ts:124
**Problem.** The pre-round `finally` (`:190-198`) disarms only when `armed !== undefined`. `armZ3Schedule` → `forkCli` throws on any non-zero exit, and that includes the 120 s `spawnSync` timeout (`live-round-wiring.ts:156`). Killing the `docker exec` client does not kill the `tsx arm` process inside the container. That process finishes and persists an `active` schedule with `runAt = now + 120 s`. The same gap opens when arm persists the row but prints no `{…}` line (for example, `loadSchedule` read-back fails after `upsertSchedule`).
**Failure.** The arm takes more than 120 s (cold `npx tsx` plus the server-module import inside the container). The test sees "fork CLI arm failed (exit null)", the finally aborts the gate, and the test exits. Two minutes later the schedule fires the full round. The gate holds and aborts only the code submit, so all three QA legs provision boxes and spend up to 3 × `Z3_QA_GROUP_CAP_USD`, and no cleanup cancels them. The runbook's "every path after arming disarms" (`docs/planning/v6-crossrepo-contract.md:212`) is false on this path.
**Fix.** On an arm failure, read `state` and disarm (then cancel) every `z3_exit_round` schedule or run created since `roundStart`. A better fix: pass a client-generated nonce, such as `--name` or a config marker, and disarm by that nonce. Also give `arm` a timeout well above tsx boot time.

### B-3 [HIGH] scripts/z3/fleet-gate.sh:1
**Problem.** The diff adds the wrapper as `new file mode 100644`. The header comment, the runbook (`v6-crossrepo-contract.md:155`: "committed `100755`") and `tests/z3/fleet-gate.test.ts:4354`, which runs the file directly, all depend on the exec bit. The local test probably passes only because the working-tree file is `+x` while the index holds 644.
**Failure.** A fresh clone, CI, or the VPS `/factory` checkout gets a non-executable wrapper. The fork `execFile()`s it with `shell:false`, so every fleet verb fails with EACCES, and `fleet-gate.test.ts` fails in CI. `preflightFork` would catch it live, but only after the operator has rebuilt and recreated the container.
**Fix.** `git update-index --chmod=+x scripts/z3/fleet-gate.sh` before commit. Optionally add a test that asserts `git ls-files -s` reports `100755`.

### B-4 [MED] scripts/z3/fleet-gate.sh:83
**Problem.** The hold limit counts loop iterations (`waited` += 1 per `sleep 0.1`), not elapsed time. Each iteration also spawns `sleep` and runs two or three `test -f` checks on a bind mount. Under container load an iteration takes well over 100 ms, so 2400 iterations can approach or pass the fork's 300 s `execFile` timeout. That defeats the "240 s sits BELOW 300 s" invariant. The script has no `trap`, so a SIGTERM from the fork's timeout leaves no `expired` line and leaks the temp brief.
**Failure.** The fork's timeout fires first and SIGTERMs the wrapper during the hold. The step sees a signal or timeout exit instead of the designed exit 99, which the fork may treat as a recoverable or replayable exit, and the journal ends at `held` (which B-1's `held()` treats as still held).
**Fix.** Use a wall-clock bound, for example `deadline=$((SECONDS + HOLD_LIMIT_S))` and `[ "$SECONDS" -ge "$deadline" ]`. Add `trap 'jline expired; rm -f "$tmp"; exit 99' TERM INT`.

### B-5 [MED] scripts/z3/leg-drivers.ts:740
**Problem.** The cleanup record goes through the same scrub-then-detect writer as every other leg. DETECT is deliberately wider than SCRUB: bare `sk-or-`, `z3tok-`, `mgrun-`, `github_pat_`, and `mgat.<x>.` with no signature. The cleanup payload also carries raw, untruncated subprocess output: `destroyBoxes` receipts put the whole `fleet cancel` stderr in `stderrTail: out.stderr` (`live-round-wiring.ts:621`), and the `protocolCancel` / `scheduleDisarm` bodies are written as returned.
**Failure.** A `fleet cancel` or provisioning error prints something like "expected key prefix sk-or-" or "mgrun- key revoked". Scrub cannot remove the bare prefix, detection fires, and the cleanup write is refused. The one record INV-Z3-5 requires on every path is then missing. AC7 reports "no cleanup record — the finally did not run", which hides the real revoke and destroy receipts.
**Fix.** Route every receipt string through `tail()` with a size bound. When the full write is refused, fall back to a minimal cleanup record that carries only counts, exit codes and problem pattern names, so a record always lands. Or make SCRUB redact the bare prefixes DETECT flags.

### B-6 [MED] docs/planning/v6-crossrepo-contract.md:192
**Problem.** The runbook tells the operator to set `Z3_CODE_POLL_TIMEOUT_MS` "below the 200-minute round budget, for example `7200000`". The live test never reads that variable. It computes `codePollTimeoutMs = codePollTimeoutFor(ROUND_BUDGET_MS, runs)` with `ROUND_BUDGET_MS = 300 * 60_000` (`z3-exit-round.live.test.ts:81`). The budget is 300 min, not 200.
`codePollTimeoutFor(200 min)` throws for 3 QA legs (`round-plan.test.ts:4551` proves it). So the runbook's own numbers describe a round the code refuses.
**Failure.** The operator sets `Z3_CODE_POLL_TIMEOUT_MS` to tune the code deadline. It is silently ignored, the armed config carries 120 min, and the GO paperwork records a value that was never applied.
**Fix.** Drop the env var from the runbook and state the computed 120 min and the 300 min budget. Or read the variable and check it against `codePollTimeoutFor`.

### B-7 [MED] scripts/z3/round-plan.ts:232
**Problem.** `gateFire` accepts a GO dated up to 5 min in the future. The schedule fires `ARM_LEAD_MS = 120 s` after arming (`z3-exit-round.live.test.ts:86`). AC7 then requires `go.when <= trigger.firedAt` (`assertions.ts:580`).
**Failure.** The operator's clock is 3 to 5 min ahead. The GO passes the gate, the round fires, and real spend happens. AC7 then fails with "the operator GO is not dated before the fire". The check that should refuse before spend fails only after it.
**Fix.** In `gateFire`, refuse `at > now` (or allow only a few seconds of skew), so a GO that passes the gate always predates the fire.

### B-8 [MED] scripts/z3/live-round-wiring.ts:219
**Problem.** `preflightFork` checks the wrapper with `test -x` only. It never runs the wrapper. `#!/bin/bash` needs bash in the fork image, `sleep 0.1` needs a sleep that takes fractions, and `mktemp` needs a writable `/tmp`. None of these is probed.
**Failure.** On an Alpine or slim Node image with no bash, or with a `read_only` rootfs, `test -x` passes. Then every fleet verb the fork runs fails (ENOENT from the missing interpreter, or `mktemp` / `exec 3<""` failing). With bash and a writable `/tmp` but a busybox `sleep` that rejects `0.1`, the hold loop busy-spins and the hold limit ends in milliseconds. All of these show up after the GO, mid-round.
**Fix.** In preflight, run the wrapper inside the container on a harmless pass-through verb (`docker exec … /factory/scripts/z3/fleet-gate.sh --version` or `status`) and require exit 0. Also run `docker exec … sh -c 'sleep 0.1 && mktemp && rm -f "$_"'`.

### B-9 [MED] tests/fleet/e2e/z3-exit-round.live.test.ts:196
**Problem.** The pre-round `finally` runs `disarmZ3Schedule(...)` and then `cancelForkRun(id)` in a loop with no guards. If either call throws (fork down, a `state` timeout, a non-zero `fleet cancel`), the exception replaces the original error, such as the cap-mismatch refusal. It also stops the loop, so later fired runs are never cancelled.
**Failure.** The caps read-back mismatches (`:138`), and meanwhile the schedule has fired two runs because the disarm lost the race. `cancelForkRun(run1)` throws on a non-zero fleet cancel. `run2` is never cancelled, and the test reports the cancel error instead of the cap refusal.
**Fix.** Wrap each step, collect problems, cancel every id, then rethrow the original error with the cleanup problems attached (the `settleRun` posture).

### B-10 [LOW] tests/fleet/e2e/z3-exit-round.live.test.ts:83
**Problem.** `CLEANUP_BUDGET_MS = 45 min`, plus 10 min of test slack, is below the cleanup's own worst case. That worst case is disarm plus `state`, one fork cancel at `FORK_CANCEL_TIMEOUT_MS` (13 min), up to four sequential `fleet cancel` destroys at 300 s each (20 min), revoke-verify, a re-sweep with a 180 s outage budget, and a second destroy pass over leftovers (up to 20 min more), about 60 min in total. Every call is a blocking `spawnSync`, and the round deadline does not bound them, so a poll that overruns the deadline also eats into the cleanup's share.
**Failure.** A red round against a slow exe.dev hits the bun test timeout during the leftover destroy. The process exits with boxes still live and no cleanup record.
**Fix.** Size the budget from the same constants (`FORK_CANCEL_TIMEOUT_MS + 2 × N × 300 s + …`), or give cleanup its own deadline that it checks between steps.

### B-11 [LOW] src/lib/server/protocols/protocol-z3-exit-round.ts:153 (fork)
**Problem.** The observe id comes from `QA_LENS[index]`, not from the leg it observes (`leg.id`). This assumes `buildQaHunterPackSteps` returns legs in `QA_LENS` order.
**Failure.** If the hunter-pack builder reorders or filters lenses, `qa-observe-correctness` observes `qa-leg-diff-scope`. The factory's AC6 check fails with "observes X, not qa-leg-correctness's run", and the round is red for a naming mismatch.
**Fix.** `const lens = leg.id.replace(/^qa-leg-/, '')`, or have the builder return the lens with each leg.
