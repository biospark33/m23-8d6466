# edge-tests-live-t2345

## [BLOCKER] `teardownQuietly` was applied to only 2 of 9 `finally` teardowns — the other 7 still leak a paid box when the 180 s ceiling fires

- **File:line:**
  - `tests/fleet/e2e/tier2-dispatch-engine.live.test.ts:329`
  - `tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts:294`
  - `tests/fleet/e2e/tier3-expose-port.live.test.ts:265`
  - `tests/fleet/e2e/tier3-manystories.live.test.ts:381`
  - `tests/fleet/e2e/tier3-race.live.test.ts:435`
  - `tests/fleet/e2e/tier3-reaper.live.test.ts:526` (T3.4b)
  - `tests/fleet/e2e/tier4-resident.live.test.ts:541`
- **Trigger:** the teardown verb exceeds 180 s (or the spawn dies). `runFleet` **rejects** — `live-harness.ts:236` `reject(new Error(\`runFleet timeout after ${…} ms\`))`. The rejection escapes the `finally` at the `await`, so on that path **none** of the following runs: `destroyQuietly(ctx.driver, vm)` on the very next line, the leftover sweep, the `final-ls` leak listing, `writeEvidence`, the workspace `rmSync`, and `settleRun` (which is *after* the finally and therefore unreachable). The box keeps billing, no evidence is written, and the held body error is replaced by the teardown timeout. This is verbatim the failure `teardownQuietly`'s own docblock says it exists to eliminate (`live-harness.ts:574-582`) — it was wired in at only `tier3-reaper.live.test.ts:361` and `tier3-remote-phases.live.test.ts:211`.
- **Amplified in the fanout tiers:** the unguarded teardown sits inside a `for` over arms (`tier2-fanout-bestofn:291-297`, `tier3-manystories:377-383`, `tier3-race:431-437`), so arm 0's timeout skips arm 1's teardown *and* the entire `armVms` destroy loop below it (`tier2-fanout-bestofn:298-302`) — 2+ boxes leaked from one timeout.
- **Evidence:**
  ```ts
  // tier2-fanout-bestofn.live.test.ts:291-302  (inside `finally`)
  for (let i = 0; i < armRunIds.length; i++) {
    const id = armRunIds[i] as string;
    if (workspace !== "") {
      const td = await runFleet(["teardown", id, "--driver", "exedev", "--dir", join(workspace, "runs"), "--no-harvest"], { timeoutMs: 180_000 });
      evidence.push({ phase: "finally-teardown-arm", arm: i, exitCode: td.exitCode });
    }
  }
  for (const vm of armVms) { … await destroyQuietly(ctx.driver, vm, evidence) … }
  ```
- **Confirmed by:** read `runFleet` in `tests/fleet/e2e/live-harness.ts:209-245` (the ceiling `reject`s, it does not resolve with a null exit); grepped every `await runFleet(["teardown"` / `teardownQuietly(` call site across the nine tier files and read the `finally` bodies of tier2-dispatch-engine, tier2-fanout-bestofn, tier4-resident to confirm the destroy sits *after* the unguarded await inside the same `finally`.

## [HIGH] T5.1's box-absence verdict is vacuously true when the box name could not be recovered and the sweep list comes back empty

- **File:line:** `tests/fleet/e2e/tier5-gate-steering.live.test.ts:687-694`, asserted at `:760`
- **Trigger:** a gate-refused dispatch provisions a box but emits a refusal envelope, so `runId`/`vmName` stay `""` (the F12 lesson this very block cites). The `else` branch then derives `sweep` from **one un-retried** `ctx.driver.list()`. The repo has measured 25 s+ substrate listing lag (`r7-T-h1`, which is why every other tier polls `final-ls` 5×8 s). If that single list misses the just-created box, `sweep = []`; the absence loop at `:703-708` computes `t51BoxAbsence = !names.some((n) => sweep.includes(n))` → `!false` → `true` on the first iteration, and `expect(t51BoxAbsence).toBeTrue()` at `:760` passes. The round reports clean while the box bills. Unlike every other tier, T5.1 has no absolute `e2e-|qds-`-prefix leak assertion (`fleetCleanupProblems(…, finalBoxes)`) to backstop it — its only leak gate is this relative one.
- **Evidence:**
  ```ts
  // :687-694
  try { sweep = (await ctx.driver.list()).map((b) => b.name).filter((n) => /^(e2e|qds)-/.test(n)); }
  catch (e) { sweepError = (e as Error).message; }
  …
  // :705
  t51BoxAbsence = !names.some((n) => sweep.includes(n));
  ```
- **Confirmed by:** read `tier5-gate-steering.live.test.ts:661-767`; compared against the retry-polled `final-ls` loops in `tier2-dispatch-engine:341-352` and `tier2-fanout-bestofn:306-315` which exist *because* of the same measured lag; confirmed T5.1 has no `fleetCleanupProblems`/`settleRun` call (grep across all nine files).

## [HIGH] T5.1 was left on the exact pre-`settleRun` shape the PR exists to delete — a cleanup assertion still discards the body's held error

- **File:line:** `tests/fleet/e2e/tier5-gate-steering.live.test.ts:755-767`
- **Trigger:** the body fails on a real regression (`failure` is held at `:659`) **and** any cleanup verdict also fails — e.g. `expect(t51BoxAbsence).toBeTrue()` at `:760` because a destroy failed. That `expect` throws its own AssertionError and `if (failure !== undefined) throw failure;` at `:767` is never reached. The operator reads "box absence" where the engine regression was and pays for another live round. `settleRun`'s docblock (`live-harness.ts:619-625`) describes this failure mode word-for-word; eight tier bodies were converted, T5.1 was not — and the diff *edits* this exact block (deleting the `finally-revoke-error` assertion) without converting it.
- **Evidence:**
  ```ts
  expect(deltaError).toBeUndefined();
  expect(leaked).toEqual([]);
  expect(t51BoxAbsence).toBeTrue();
  expect(evidence.filter((p) => p.phase === "finally-revoke" && p.ok === false)).toEqual([]);
  if (failure !== undefined) throw failure;
  ```
- **Confirmed by:** read `live-harness.ts:616-648` (`settleRun`) and `tier5-gate-steering.live.test.ts:750-767`; grepped `settleRun(` — present in all eight other tier bodies, absent from tier5.

## [MEDIUM] `teardownQuietly` writes a FAILED (non-zero-exit) teardown into evidence with no `ok` field — indistinguishable from a success in the JSON

- **File:line:** `tests/fleet/e2e/live-harness.ts:592-594`
- **Trigger:** teardown exits non-zero (e.g. it failed to revoke the key). The evidence entry pushed at `:592` carries `exitCode` and `stderrTail` but **no `ok`**, while the throw arm at `:597` does push `ok: false`. Post-hoc evidence auditing in this repo uses the `phase === X && ok === false` idiom — `tier5-gate-steering.live.test.ts:766` is exactly that shape — so a failed teardown reads as clean in any such filter. The new unit test does not pin it: it asserts only `entry?.exitCode).not.toBe(0)` (`live-harness.test.ts:158`), never `entry?.ok`.
- **Evidence:**
  ```ts
  evidence.push({ phase: "finally-teardown", ...label, exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
  if (td.exitCode === 0) return { ok: true };
  return { ok: false, error: `fleet teardown exited …` };
  ```
- **Confirmed by:** read `live-harness.ts:584-600` and `live-harness.test.ts:146-159`; grepped for the `ok === false` evidence-filter idiom (`tier5-gate-steering.live.test.ts:766`).

## [MEDIUM] An evidence-write failure in the `finally` makes `settleRun` unreachable — the held body error *and* every cleanup verdict are dropped

- **File:line:** `tests/fleet/e2e/tier2-dispatch-engine.live.test.ts:357-362` (same shape at `tier2-fanout-bestofn:322-327`, `tier3-expose-port:331-336`, `tier3-manystories:407-412`, `tier3-race:461-466`, `tier3-reaper:396-401` and `:549-554`, `tier3-remote-phases:229-234`, `tier4-resident:555-561`)
- **Trigger:** `writeEvidence` throws — `live-harness.ts:189` `throw new Error(\`evidence ${name} failed the secret scrub — refusing to write ${path}\`)`, or an `ENOSPC`/`EACCES` from `mkdirSync`/`writeFileSync` at `:183`/`:191`. It is wrapped in `try { … } finally { rmSync }` with **no catch**, so it propagates out of the outer `finally`, and `settleRun(failure, fleetCleanupProblems(destroyFailures, finalBoxes))` on the line below never executes. Result: the body's real regression AND the accumulated `destroyFailures` / leaked-box listing are all replaced by the evidence-write error. The verdict machinery the whole PR builds is bypassed by the one condition (a key leaked into evidence) that most needs it.
- **Evidence:**
  ```ts
  try {
    evidencePath = writeEvidence("t2-1-dispatch-engine", { … phases: evidence });
    process.stderr.write(`[T2.1] evidence: ${evidencePath}\n`);
  } finally {
    if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
  }
  ```
- **Confirmed by:** read `writeEvidence` at `live-harness.ts:182-193` (it throws on scrub failure) and the tail of every converted tier's `finally`.

## [MEDIUM] T3.4a's in-body residue cleanup now fails an otherwise-green run on a routine non-zero teardown exit

- **File:line:** `tests/fleet/e2e/tier3-reaper.live.test.ts:265-271`
- **Trigger:** this `teardownQuietly` is inside the **test body**, in the kill-window attempt loop, cleaning up residue left by a deliberately SIGKILLed dispatch (`:261` "a too-late kill leaves record+box"). Previously the exit code was only recorded (`evidence.push({ phase: "attempt-cleanup", id, teardownExit })`). Now any non-zero exit — a half-written record, run-lock contention with the just-killed dispatch, a run already torn down — is pushed into `destroyFailures`, which is permanent, and `settleRun` at `:412` turns it into a failure of a 1.5 M ms real-money TIER-3 run whose body passed and whose boxes are all gone. Best-effort mid-test cleanup was promoted to a run-failing verdict without the "is this box actually still billing?" check that `destroyQuietly` (idempotent, `driver.ts:936` returns on already-gone) provides.
- **Evidence:**
  ```ts
  const torn = await teardownQuietly(
    ["teardown", id, "--driver", "exedev", "--dir", runsDir, "--no-harvest"],
    { env, timeoutMs: 180_000 }, evidence, { at: "attempt-cleanup", id },
  );
  if (!torn.ok) destroyFailures.push(`${id}: ${torn.error}`);
  ```
- **Confirmed by:** read `tier3-reaper.live.test.ts:240-280` and `:405-412`; read `ExeDevDriver.destroy` at `src/providers/exedev/driver.ts:921-942` confirming the destroy path *is* idempotent while the teardown-verb path is not.

## [LOW] `teardownQuietly`'s label can silently overwrite the entry's own fields

- **File:line:** `tests/fleet/e2e/live-harness.ts:592` and `:597`
- **Trigger:** `{ phase: "finally-teardown", ...label, exitCode, … }` — `label` is spread *after* `phase`, so a caller passing `{ phase: … }`, `{ ok: … }` or `{ exitCode: … }` silently rewrites the entry's discriminator (the throw arm's `...label` also precedes `exitCode: null, ok: false`, so those two are safe but `phase` is not). `tier3-reaper.live.test.ts:269` already passes `{ at: "attempt-cleanup", id }` specifically to work around not being able to set `phase` — which is the seam that will get used wrongly.
- **Evidence:** `evidence.push({ phase: "finally-teardown", ...label, exitCode: td.exitCode, stderrTail: … });`
- **Confirmed by:** read `live-harness.ts:584-600` and both `teardownQuietly` call sites in `tier3-reaper.live.test.ts` (`:265`, `:361`) and `tier3-remote-phases.live.test.ts:211`.

## Coverage gaps (no finding line, but nothing here would fail)

- **A teardown that exits 0 without revoking the OpenRouter key** is only caught in T5.1 (`listedKeyHashes` delta, `:734-741`) and T4/T3.5 (`listedKeyHashes` import). T2.1, T2.2, T3.1, T3.2, T3.3 and both reaper tests have **no** key-hash delta and **no** `revokeQuietly` fallback in their `finally` — a regression that makes `fleet teardown` skip the revoke while still exiting 0 and destroying the box passes all seven green. Confirmed by grepping `listedKeyHashes|revokeQuietly` across the nine files: present only in tier3-expose-port (sweep only), tier3-remote-phases, tier3-reaper (assertion, not fallback), tier4-resident, tier5.
- **`preflight`'s new image-override warning is stderr only** (`live-harness.ts:113-117`) — it is not pushed into any `evidence` array and not asserted anywhere, so a round run against `QDS_EXEDEV_IMAGE=<some other image>` produces evidence JSON indistinguishable from a repo-pinned round. The docblock claims the line is "RECORDED"; it is printed, not recorded. Confirmed by reading `live-harness.ts:101-133` (no `evidence` parameter exists on `preflight`) and grepping the tier files for `IMAGE OVERRIDE` (no consumers).
