# Z3 R2 — Blind Hunter

Scope: `z3-factory.diff` (QDS-Factory) + `z3-fork.diff` (swarmclaw fork), diffs only.<br />
Line numbers are file lines in the post-image (new files: diff line minus hunk offset).<br />
Totals: 3 HIGH, 9 MED, 9 LOW (21).

---

### B-1 [HIGH] scripts/z3/live-round-wiring.ts:358
**Problem.** `awaitProtocolComplete` reads `run.artifacts` to find the `factory_result` artifacts, but the fork's `state` command never emits `artifacts` (`scripts/solstice/z3-exit-round.ts:88-107` maps only id/templateId/scheduleId/createdAt/status/steps/factoryState/events, and the fork test `z3-exit-round.test.ts:173` pins exactly those keys). `RunSchema.artifacts` is `.default([])` (live-round-wiring.ts:120), so the missing field parses silently as an empty array instead of failing loudly. That contradicts the module's own claim that shape drift fails loudly.<br />
**Failure.** On every live round, `driveBranchAndComplete` sees `factoryResults = []`. It pushes `no factory_result for <id> (F-011)` once per fleet run, and `code run verdict null, not approved`, so branch-and-complete is red and AC1 fails even on a perfect round. The fixture tier never runs the wiring, so no test catches this.<br />
**Fix.** Emit `artifacts` (kind, content) from the fork `state()` and add it to the pinned key set in the fork test. Make `artifacts` required in `RunSchema` (no `.default`), so a fork that omits it is a contract error.

### B-2 [HIGH] tests/fleet/e2e/z3-exit-round.live.test.ts:95
**Problem.** The schedule is armed fork-side with `runAt = now + 120s`. Several throws can follow before `runZ3Round` owns cleanup: the cap read-back check (`:110`), `z3LiveDeps` construction, and an early `awaitTrigger` throw such as a ZodError drift. In all of these, `protocolRunId` stays null. Nothing cancels or disarms the schedule, and the fork CLI has no `disarm` verb. The error text even tells the operator to "remove that schedule fork-side before it fires", which means beating a 120 s timer by hand.<br />
**Failure.** The armed caps mismatch (or the state contract drifts), the test throws, and 2 minutes later the fork fires the round unattended. The QA legs submit real spend and boxes with no driver and no cleanup. The code submit then sits in the gate for 900 s and exits 99.<br />
**Fix.** Add `disarm <scheduleId>` to the fork CLI (it marks the schedule cancelled, and also cancels any run it already fired). Wrap everything from `armZ3Schedule` to the end of the test in try/finally: disarm when the round never bound a run, and when `awaitTrigger` throws, cancel every run carrying that scheduleId. Alternatively, arm the schedule inactive and only activate it after the cap read-back passes.

### B-3 [HIGH] scripts/z3/leg-drivers.ts:316
**Problem.** `observeDeltas` only attributes a fresh box or provider key to a sibling run once the fork's `factoryState` names that run's `runId` (`protocolFleetRunIds`, :318). The fork sets `runId` only when the next leg's `fleet submit` returns. Provisioning the box and minting the key happen *inside* that submit, which takes minutes. The driver's QA-observe snapshot is taken about 10–30 s after leg *i* goes terminal. That is exactly when the fork, which chains without waiting, is inside leg *i+1*'s submit.<br />
**Failure.** On a correct round, leg *i+1*'s box and key exist but are not yet attributable. They get charged to leg *i*'s observe, so qa-run-observe goes red ("observe provisioned box(es)") and AC6 fails. The fixture hides this because its `provision()` writes the record, box, key and runId atomically (`tests/z3/fixture.ts:81`).<br />
**Fix.** Attribute through the requestIds instead of the runIds. The fork persists `requestId` at `submitting`, before the exec, so the driver can map them through `RunRecordStore` records (`requestId` → `runId`/`vmName`/`keyHash`). Alternatively, before measuring, wait until every factoryState entry that is `submitting` has reached `submitted`. Add a fixture variant where the box and key appear before the runId is visible.

### B-4 [MED] scripts/z3/leg-drivers.ts:537
**Problem.** `armCrashWindow` runs kill → release → restart unconditionally:
- **Not held.** If the hold line never appears within 5 s (:541), it kills anyway. The wrapper may not be installed, or its workId/requestId parse missed, and `arm()` checks only the host-side `real-cli` file, never that the container uses the wrapper. The fork stays `submitting` for the whole real exec, which provisions a box for minutes, so the watcher kills the container mid-exec. That is the uncontrolled SC2.6 race with real spend, possibly an orphaned box with no recorded runId.
- **Kill failed.** It still releases (:556). The held submit then execs in a live fork, and `docker start` on a running container does nothing. Spend continues for a round the leg will declare red.
- **Round stopped.** `stopped()` is only polled inside `awaitStepSubmitting`. If the round fails after the watcher passed that poll, the `finally` awaits a watcher that goes on to kill, **release** and restart. The replay then execs real spend on a failed round, and the cleanup's `abort` is a no-op because `release` already exists (the wrapper only checks `abort` while `release` is absent).

**Fix.**
- If `!heldAtKill`: abort the gate, do not kill, and fail.
- If the kill threw: abort instead of release.
- Re-check `stopped()` just before release, and abort if it is set.
- Make the wrapper honour `abort` even when `release` exists (check `abort` before the loop).
- Before relying on the gate, verify it is in the path: earlier QA submits must have left `exec` lines in the journal.

### B-5 [MED] scripts/z3/leg-drivers.ts:556
**Problem.** The release of the held code submit is timed by the watcher alone, not by the driver's progress. The fork starts the code submit as soon as the last `qa-observe` step completes, but the driver retains that lens's findings host-side only *after* awaitResult, forensics and observe. The released replay runs dispatch's recall, which is the priming witness, and this can happen before or during the last retain.<br />
**Failure.** The priming witness becomes nondeterministic. The last lens's findings may be missing from the code run's `<kg_context>`. If only the last lens produced findings, priming-recall is red. If earlier lenses produced findings, it passes without proving the round-trip for the latest retain. The fixture's `readRecall` always returns `docId(0)`, so the ordering is never exercised.<br />
**Fix.** Gate the release on a promise that resolves after the last `driveFindingsRetain`. The hold makes this free: the window stays open. Have priming-recall require that a document retained by the *last* lens is cited, or record which lens it cites.

### B-6 [MED] scripts/z3/live-round-wiring.ts:459
**Problem.** The live traces are built as `journal.map(documentId => ({ side: "host", … }))`: every trace is labelled `host` by construction, so `side: "box"` can never occur live. In addition, `retainSide = r.traces.every(...)` (leg-drivers.ts:378) is vacuously `host` for an empty trace list. AC5 only checks that `retainTraces` is an array (assertions.ts:375), never that it is non-empty or that it covers `documentIds`. The journal also records only `client.retain`. If `retainFindings` writes through any other client method (batch retain, a different call path), the journal stays empty and the leg still reads host-side.<br />
**Failure.** A box-side retain, or a host-client path that the journal does not wrap, still produces a green "host-side only" AC5. The check cannot fail live.<br />
**Fix.** Require `traces.length > 0`, and require that the trace documentIds equal `documentIds` (assert in both the driver and AC5). Derive the box half from an independent source, such as the memgate/hindsight audit of who wrote each documentId, not from a label the wiring sets itself.

### B-7 [MED] scripts/z3/live-round-wiring.ts:265
**Problem.** The state-outage budget is measured from `lastGoodState`, which is shared and set at the last *successful* read. It is not measured from when the current failure streak began. Long stretches use only `fleet result` or other non-state calls (awaitResult for a QA leg, the code run's park). After one of those, `lastGoodState` can be an hour old.<br />
**Failure.** The first transient `docker exec` blip on the next `state()` call (a timeout, tsx cold start) throws `fork state unreadable for 180s` immediately, without one retry, and fails a healthy round.<br />
**Fix.** Track the streak start locally inside `state()` (`const firstFail ??= Date.now()`) and compare against that.

### B-8 [MED] scripts/z3/live-round-wiring.ts:465
**Problem.** `gatewayAssert` uses a raw `fetch` with no `AbortSignal`/timeout, and the round deadline is only checked between polls. Any hung call (fetch, Hindsight client calls) blocks past `ROUND_BUDGET_MS`.<br />
**Failure.** The gateway accepts the connection and never answers. The round hangs until the bun test timeout, and bun then fails the test and tears down. The `finally` cleanup (cancel, destroy, revoke-verify) may never run, so boxes and keys outlive the round.<br />
**Fix.** Use `AbortSignal.timeout(...)` on every fetch, and add a per-call cap derived from the remaining deadline. Consider running the cleanup from a process-level `beforeExit`/signal handler as a backstop.

### B-9 [MED] scripts/z3/fleet-gate.sh:71
**Problem.** The real CLI runs as a child of bash (`printf | "$REAL" "$@"`), not via `exec`, and there is no TERM/INT trap. A non-interactive bash killed by SIGTERM dies while its child keeps running.<br />
**Failure.** The fork times out a fleet verb and signals the wrapper's pid (not the process group). The wrapper dies, but the real `submit` keeps provisioning. The fork records the step as failed or retryable while a box and key are created behind it. A retry then double-books, or the box is orphaned without a runId. This affects every verb, not just the z3 submit.<br />
**Fix.** For non-submit verbs, `exec "$REAL" "$@" <<<"$brief"` (or exec with the original stdin, unbuffered). For submit, `trap 'kill -TERM $child' TERM INT` around a backgrounded child plus `wait`, or simply `exec` after writing the `exec` journal line (nothing consumes the `exit`/rc line).

### B-10 [MED] tests/fleet/e2e/z3-exit-round.live.test.ts:141
**Problem.** `readHarvest` throws unconditionally (the documented upstream blocker), yet the test still runs `gateFire`, arms the schedule and fires. A live run is red by construction.<br />
**Failure.** The operator records a GO and fires. Leg 0 provisions and runs, and the fork chains on to leg 1's submit, which is real spend. The round then fails at the first findings-retain, so known-wasted spend buys a guaranteed red. Combined with the known #465 blocker (findings-only runs stranding in `pausing`), `awaitResult(... "terminal")` can also sit for the full 200-minute budget with a live box.<br />
**Fix.** Refuse before `gateFire` while the harvest seam is a stub. Make that a named precondition throw, the same way `liveGate` refuses, so no spend is possible until the blocker clears.

### B-11 [MED] scripts/z3/leg-drivers.ts:657
**Problem.** Cleanup records `unattributedFreshBoxes` for the operator but does not count them as a problem. The fork `cancel` snapshot (`z3-exit-round.ts:125`) only includes entries that already have a `runId`, so a `submitting` entry has none. A submit that is in flight at cancel time therefore produces a box born *after* the cancel. That box carries no runId the sweep knows, and AC7 only checks `leftoverBoxes` (attributed boxes).<br />
**Failure.** The round fails mid-submit (see B-4's release-after-stop path). The in-flight submit completes after the cancel and its box is listed under `unattributedFreshBoxes`. The cleanup and AC7 stay green with a leaked, billing box.<br />
**Fix.** In the cleanup, also attribute through the `requestId`s of the bound run's factoryState (`recordsForRequestId`), so in-flight submits are swept and destroyed. Re-list after a short settle. Treat any fresh box whose name matches a record for one of this round's requestIds as leftover.

### B-12 [MED] scripts/z3/fleet-gate.sh:48
**Problem.** The wrapper reads `workId` from the brief (stdin) but `requestId` only from an argv `--request-id <id>` pair. The `--request-id=<id>` form is not parsed, and neither is a requestId carried only in the brief (the gate test's briefs do carry `requestId`). When the parse misses, every journal line has `"requestId":""`.<br />
**Failure.** `journalFor(requestId)` matches nothing. `heldAtKill` is false and `submitExecs` is 0 even though the hold worked. The round goes red, and together with B-4 the kill has already landed.<br />
**Fix.** Fall back to the brief's `"requestId"`, accept `--request-id=…`, and refuse to hold (journal a `phase:"unparsed"` line) when no requestId resolves.

### B-13 [LOW] scripts/z3/fleet-gate.sh:43
**Problem.** `brief="$(cat)"` runs for *every* verb and strips trailing newlines (and NULs). The test fake CLI also captures its stdin with `$(cat)` (`tests/z3/fleet-gate.test.ts:23`), so the "byte-exact" pass-through test (:51) cannot detect the stripping.<br />
**Failure.** A caller that spawns a non-submit verb with an open, never-closed stdin pipe hangs the wrapper forever. Any consumer that is sensitive to the trailing newline gets different bytes than the comment promises.<br />
**Fix.** Only buffer stdin for `submit`. Have the test's fake CLI record stdin with `cat > file` and compare bytes, including a brief that ends in `\n`.

### B-14 [LOW] scripts/z3/live-round-wiring.ts:296
**Problem.** `awaitTrigger` ignores the schedule's own status (which `state` returns). A fire the fork refuses (`z3_fire_refused` → schedule `failed`) is waited on until the round deadline, which is 200 min. On `runs.length > 1` it throws without binding either run, so the cleanup cancels neither of them.<br />
**Fix.** Fail fast when the armed schedule shows `failed`/`completed` with no run. On multiple runs, bind them all for the cleanup, or cancel each one before throwing.

### B-15 [LOW] scripts/z3/assertions.ts:446
**Problem.** AC7 checks destroy receipts only for `cleanup.runIds`. It never checks that `cleanup.runIds` covers the runIds of the round's `kill-and-provision` legs.<br />
**Failure.** A cleanup record whose runIds came back empty (lost tracking, or a sweep that failed) passes the destroy check vacuously.<br />
**Fix.** Assert that every `kill-and-provision.runId` is in `cleanup.runIds` and has an exit-0 destroy receipt.

### B-16 [LOW] scripts/z3/leg-drivers.ts:166
**Problem.** `tail()` scrubs and then slices. The slice can start a string mid-token, which creates a *new* `\b`-anchored DETECT match. For example, `task-<20+ chars>` is not a match, but cut to `sk-<20+ chars>` it is (`\bsk-` matches at the start of the string).<br />
**Failure.** A rare evidence-write refusal turns a leg into "evidence write refused", losing the leg's real evidence.<br />
**Fix.** After slicing, scrub again (or trim to a whitespace boundary).

### B-17 [LOW] scripts/z3/evidence.ts:88
**Problem.** `scrubText` applies the shape regexes *before* replacing the known-secret values. If an env secret contains a shape prefix followed by a character outside the regex body class, the regex redacts only the head. The known-value pass then no longer finds the full secret, and the tail fragment lands. `credentialHits` also checks only the full value, so the write is not refused.<br />
**Fix.** Replace the known secret values first, then apply the shape regexes.

### B-18 [LOW] tests/fleet/e2e/z3-exit-round.live.test.ts:96
**Problem.** The live arm config omits `codePollTimeoutMs`. The fork therefore defaults the code run's poll deadline (and its observe's) to the QA 1 h default (`protocol-z3-exit-round.ts:145`), measured from submit. That 1 h must cover the code run executing, parking, then the driver's park detection, forensics (up to 10 s sleeps), snapshot and approve.<br />
**Failure.** A code run that takes about 50 min plus the park/approve latency times out fork-side, so a correct round goes red. The live budget is 200 min, so the fork deadline, not the round, is the binding limit.<br />
**Fix.** Pass an explicit `codePollTimeoutMs` sized to the round budget, and assert it in `armedCapsProblems`.

### B-19 [LOW] scripts/z3/round-plan.ts:167
**Problem.** `gateFire` and AC7 accept any GO whose amount and rev match. `when` is never compared to the fire time or bounded in age, and nothing binds the GO to this round.<br />
**Failure.** A GO from an earlier round, at the same rev and amount, silently authorizes a new fire.<br />
**Fix.** Require `go.when` to be within a freshness window before `roundStart`, and AC7: `when < trigger.firedAt`. Optionally have the GO name a nonce that the test prints with the worst-case line.

### B-20 [LOW] tests/z3/wiring.test.ts:42
**Problem.** `RUNS_DIR.startsWith("/")` is always true for `path.resolve(...)`, so the test asserts nothing. The title ("can never diverge") claims more than the test checks.<br />
**Fix.** Delete the test, or assert the real property: the allowlist path and every `--dir` derive from the one constant.

### B-21 [LOW] tests/z3/fixture.ts:81
**Problem.** The fixture world makes every substrate transition atomic and instant: `provision()` sets the record, box, key and runId together, `readRecall` is fixed regardless of retain order, and the fake writes its own `held` journal line. So the races in B-3, B-4, B-5 and B-11 are structurally untestable. The fixture's own header says it "behaves like the real fork".<br />
**Fix.** Add fixture switches for:
- the box and key appearing before the runId is visible;
- a recall that only sees documents retained before the release;
- no `held` line;
- a stop between the submitting read and the kill.

Then add one negative control for each.
