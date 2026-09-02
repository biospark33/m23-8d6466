# edge-tests-live-t1

## [BLOCKER] AC4 positive leg leaks a billing box when `create()` throws after the box exists
- **File:line:** `tests/fleet/e2e/tier1-registry-auth.live.test.ts:203` (guard set), `:226` (the finally that reads it)
- **Trigger:** `posDriver.create(posVm)` reaches `ssh exe.dev new`, the box is created at the substrate, and then `create()` throws on one of its documented post-`new` arms — `provisionSteeringChannel` failing (`steering-channel-unprovisionable`, driver.ts:753/762/791) or `create-shape-unresolved` (driver.ts:769, whose own message says "the VM may be live and unrecorded"). `posCreated` is still `false`, so the `finally` destroys nothing, no `destroyQuietly` runs, no `finally-destroy` evidence entry names the box, and `destroyFailures` stays empty — the run reports the body error and a clean cleanup while a real box bills indefinitely. Steering-provision failure is a first-class, retried failure mode in the driver, not a hypothetical.
- **Evidence:**
  ```ts
  const created = await posDriver.create(posVm);
  posCreated = true;
  ...
  } finally {
    if (posCreated) {
      const posDestroyer = new ExeDevDriver({ image: privateRef, imageBuildId: DEFAULT_IMAGE_BUILD_ID });
      const d = await destroyQuietly(posDestroyer, posVm, evidence);
  ```
- **Confirmed by:** read `ExeDevDriver.create` (`src/providers/exedev/driver.ts:653-774`) — three throw sites after the `new` has already run at the substrate. Compared against the sibling file that gets this right: `tier1-image-contract.live.test.ts:337` assigns `vm = runId;` *before* `await ctx.driver.create(vm)` and guards its finally on `vm !== ""` (`:536`), which covers the partial-create case. The negative leg in this same file also explicitly sweeps for it ("if `new` named a box that never boots, it is billing"); only the positive leg gates on a post-create flag.

## [HIGH] AC4 negative-control box leaks if the `list` probe throws
- **File:line:** `tests/fleet/e2e/tier1-registry-auth.live.test.ts:178`
- **Trigger:** `negDriver.create(negVm)` fails in a way that still named a box at exe.dev (the case the next line exists to sweep), then the unguarded `negDriver.list(negVm)` throws — a dropped ssh, an `ls --json` timeout, a transport abort. The throw escapes to the outer `catch`, `posCreated` is false, and the `finally` sweeps only `posVm`. `negVm` is never listed, never destroyed, and appears in evidence only inside the `test-error` string. Nothing in the file ever destroys `negVm` outside this one in-body call.
- **Evidence:**
  ```ts
  const negListed = (await negDriver.list(negVm)).some((b) => b.name === negVm);
  evidence.push({ phase: "negative-control-listed", listed: negListed });
  if (negListed) {
    const d = await destroyQuietly(negDriver, negVm, evidence);
  ```
- **Confirmed by:** the `finally` at `:225-243` contains no `negVm` branch at all; `destroyQuietly` (`live-harness.ts:497`) never throws, so moving/duplicating this sweep into the `finally` is free.

## [HIGH] Newly added `expect(destroyFailures)` before the rethrow discards the body's real error — the exact bug `settleRun` was written to fix
- **File:line:** `tests/fleet/e2e/tier1-registry-auth.live.test.ts:247-248`; `tests/fleet/e2e/tier1-approval-gate.live.test.ts:663-664` and `:938-939`
- **Trigger:** the test body fails on a real substrate regression (`failure` is held) AND cleanup also failed (a destroy returned `ok:false`). The `expect(destroyFailures).toEqual([])` throws its own AssertionError first, so `if (failure !== undefined) throw failure;` is never reached and the held regression is discarded. The operator reads "cleanup failures: e2e-…: rm failed" where an AC4/approval-gate regression was, and pays for another 15–25 minute paid round to rediscover it. The diff *adds* these `expect` lines ahead of the rethrow rather than routing through the harness primitive that already solves this.
- **Evidence:**
  ```ts
  // tier1-registry-auth.live.test.ts:247
  expect(destroyFailures).toEqual([]);
  if (failure !== undefined) throw failure;
  ```
  ```ts
  // tier1-approval-gate.live.test.ts:663
  expect(destroyFailures).toEqual([]);
  if (failure !== undefined) throw failure;
  ```
- **Confirmed by:** `live-harness.ts:616-648` documents this precise shape as the bug: "The shape this replaces was `expect(destroyFailures).toEqual([]); … if (failure !== undefined) throw failure;` — correct on a GREEN run and wrong on a red one … the held body error was discarded." `settleRun` + `fleetCleanupProblems` are exported and already used by `tier2-fanout-bestofn.live.test.ts:335`, `tier3-expose-port.live.test.ts:344`, `tier3-remote-phases.live.test.ts:245`, `tier3-race.live.test.ts:474`. The four TIER-1 files in this diff import neither.

## [MEDIUM] The "is the mirror actually private?" guard can never fire
- **File:line:** `tests/fleet/e2e/tier1-registry-auth.live.test.ts:107-115`
- **Trigger:** GHCR implements the Docker Registry v2 *token* flow: an unauthenticated request to `https://ghcr.io/v2/<repo>/manifests/<ref>` answers `401` with a `WWW-Authenticate: Bearer realm=https://ghcr.io/token…` challenge for **public** packages too — an anonymous client is expected to fetch a token from that realm and retry. This `fetch` sends no `Authorization` header and never follows the challenge, so `anon.status === 200` is unreachable regardless of package visibility. The guard is dead code: if someone flips `qds-exedev-private` to public, this check passes silently and the file proceeds to a negative leg that no longer proves anything about credentials.
- **Evidence:**
  ```ts
  // (ghcr answers 401 for anonymous, 403 for denied — 200 means someone flipped it public.)
  const anon = await fetch(`https://ghcr.io/v2/${PRIVATE_REPO.replace("ghcr.io/", "")}/manifests/${digest}`, {
    method: "HEAD",
    headers: { Accept: "application/vnd.oci.image.manifest.v1+json" },
  });
  if (anon.status === 200) {
  ```
- **Confirmed by:** the code itself sends no bearer token and no token-realm follow-up; the comment's premise ("401 for anonymous [only when private]") is contradicted by the registry v2 token flow GHCR implements. Not exercised live from this sandbox — the defect is structural (no token acquisition path exists in the request), not empirical.

## [MEDIUM] The AC4 negative control passes on any create failure, not on an auth failure
- **File:line:** `tests/fleet/e2e/tier1-registry-auth.live.test.ts:164-189`
- **Trigger:** `expect(negOutcome).toBe("threw")` is satisfied by *any* rejection from `create()` — an ssh blip, a spawn failure, an `exec` timeout, a `create-shape-unresolved`, a substrate hiccup. The failure shape is recorded into evidence and deliberately never asserted. So a round where the mirror is accidentally public (which the guard above cannot catch) plus one transient exe.dev failure on the negative leg yields: neg "refused" (for the wrong reason), pos "authenticated create succeeded" (but would have succeeded without the credential too) — a green AC4 "the credential path is proven live" where the credential was never load-bearing. The two MEDIUMs compound: the only defence against the public-package case is the dead guard.
- **Evidence:**
  ```ts
  try {
    await negDriver.create(negVm);
  } catch (e) {
    negOutcome = "threw";
    negError = e instanceof Error ? e.message : String(e);
  }
  ...
  expect(negOutcome).toBe("threw");
  ```
- **Confirmed by:** `ExeDevDriver.create` (`driver.ts:705-739`) funnels transport rejections *and* non-zero `new` exits into `ExeDevDriverError`s whose codes are distinguishable (`create-failed` vs `create-shape-unresolved`) and whose messages carry the substrate stderr — the material to assert on (e.g. the error names an auth/pull refusal, or at minimum is `create-failed` with a non-empty stderr) exists and is captured into `negError`, but is only `.slice(0, 600)`'d into evidence.

## [MEDIUM] `tier1-image-contract` file timeout is budgeted on typical, not ceiling, probe latency — overrun is the one path that leaks
- **File:line:** `tests/fleet/e2e/tier1-image-contract.live.test.ts:611`
- **Trigger:** the file runs 16 `ctx.driver.exec(vm, …)` probes, each bounded only by `DEFAULT_EXEC_TIMEOUT_MS` (120 000 ms), plus `create`, `fill`, `mint`/`deliver`, the setup gate's own `DEFAULT_GATE_TIMEOUT_MS` (300 000), `BOOT_BUDGET_MS` (120 000) and `REBOOT_BUDGET_MS` (240 000). The in-file budget audit prices all probes at "~30 s" combined. A degraded-network round where probes are slow but not hung — 60–90 s each rather than a second — exceeds 1 500 000 ms on arithmetic the audit itself calls out as the failure mode: "A bun test-timeout abort is the ONE path where that finally does not execute, i.e. the path that leaks a billing box." On that path the box leaks *and* the minted OpenRouter key is never revoked. The `execTimed`/`BOOT_PROBE_TIMEOUT_MS` work in this diff bounds the two poll legs only; the 16 straight-line probes keep the driver's 120 s ceiling each.
- **Evidence:**
  ```ts
  // create (~60 s measured) + BOOT_BUDGET_MS 120 + probes ~30 + fill ~120 + mint/deliver ~20 …
  1_500_000,
  ```
- **Confirmed by:** `grep -c "driver.exec(vm"` → 16 in this file; `DEFAULT_EXEC_TIMEOUT_MS = 120_000` (`src/providers/exedev/transport.ts:41`); `DEFAULT_GATE_TIMEOUT_MS = 300_000` (`src/providers/exedev/setup-gate.ts:135`). Sum of declared ceilings ≈ 2 900 s vs a 1 500 s file budget.

## [LOW] AC4 test never removes its tmp workspace
- **File:line:** `tests/fleet/e2e/tier1-registry-auth.live.test.ts:118`, `:128`
- **Trigger:** `workspace = tmpWorkspace("t1reg")` is assigned and the `let workspace = ""` hoist exists precisely for a finally-time cleanup, but no `rmSync` appears anywhere in the file. Every live round leaves a `/tmp/qds-e2e-t1reg-*` directory containing the 0600 posture file behind. Not a paid resource; the hoisted variable reads as if cleanup were handled.
- **Evidence:** `let workspace = "";` … `workspace = tmpWorkspace("t1reg");` with no `rmSync(workspace, …)` in the `finally` (`:225-243`).
- **Confirmed by:** `grep -n "rmSync\|workspace" tests/fleet/e2e/tier1-registry-auth.live.test.ts` returns only lines 118/128/135; `tmpWorkspace`'s own doc (`live-harness.ts:650`) says "`rmSync` it in the test's outer finally", and `tier1-image-contract.live.test.ts:576` does exactly that.

## [LOW] A TIER-2-gated test carrying a `tier1-` filename red-fails any tier-1 sweep
- **File:line:** `tests/fleet/e2e/tier1-image-contract.live.test.ts:108`
- **Trigger:** `liveTodoOff()` keys only on `QDS_E2E_LIVE`, so under `QDS_E2E_LIVE=1 QDS_E2E_TIER=1 bun test tests/fleet/e2e/tier1-*.live.test.ts` — the natural invocation given the filenames — this test *runs* and `liveGate("2")` throws `QDS_E2E_TIER is "1", not "2"`. The paid round ends with a red that is not a substrate failure, in a suite whose whole discipline is that a red means something real; the risk is the operator learning to dismiss it.
- **Evidence:** `liveGate("2");` in a file named `tier1-image-contract.live.test.ts`, with an `t1-image-contract` evidence name.
- **Confirmed by:** `liveGate` throws on tier mismatch (`live-harness.ts:59-61`); `liveTodoOff` checks only `QDS_E2E_LIVE` (`:72-74`). Every other tier-2 test is named `tier2-`/`tier3-` (`tier2-fanout-bestofn.live.test.ts:69`, `tier3-race.live.test.ts:86`). The file header acknowledges the mismatch but keeps the name.
