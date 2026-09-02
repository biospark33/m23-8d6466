# blind-src

## [MEDIUM] The probe-exit fix does not restore the bound its own comment claims to restore
- **File:line:** `src/fleet/fanout-primitive.ts:744-757`
- **Trigger:** The comment states the defect as "a dead arm could never reach `MARKER_UNUSABLE_TICKS_LIMIT` and the race spun to its full ceiling with the fleet lock held". The new code turns a 255/137 probe into `skipTick(...)` + `return null`, described as "a transport skip: no evidence either way, so it must not reset the streak". A skip does not reset the streak — but it does not *increment* it either. So an arm whose ssh is permanently down (exit 255 on every tick) still never reaches `MARKER_UNUSABLE_TICKS_LIMIT`; it now sits at streak 0 forever and the race still spins to its full ceiling holding the fleet lock. The only behaviour that actually changed is that a *previously accumulated* streak survives a transport blip. I cannot see `skipTick`'s accounting or whether skipped ticks have their own ceiling, so capped at MEDIUM — but if they do not, the stated bug is unfixed and the comment is now a false record of a fix.
- **Evidence:**
  ```
  +      skipTick("race-probe-failed", new Error(`presence probe exited ...`));
  +      return null; // a transport skip: no evidence either way, so it must not reset the streak
  ```

## [MEDIUM] Box-controlled stderr goes raw into a logged message on the fanout path, while the sibling path JSON-escapes it for exactly this reason
- **File:line:** `src/fleet/fanout-primitive.ts:756`
- **Trigger:** `res.probeStderr` is stderr from a box the code has just decided it cannot trust, interpolated raw into an `Error` message that is recorded by `skipTick`. The same value on the gate path is deliberately `JSON.stringify`'d — `src/providers/exedev/transport.ts:344` comments "JSON.stringify, not a raw slice: the stderr tail is box-controlled and this note is logged — a newline or an ANSI escape in it forges log lines from a machine the gate has just decided it does not trust." A box emitting `\n{"level":"info",...}` on stderr forges log records on the fanout path only.
- **Evidence:**
  ```
  +      skipTick("race-probe-failed", new Error(`presence probe exited ${String(res.probeExit)} — ... : ${res.probeStderr?.trim().slice(0, 200) ?? ""}`));
  ```
  vs `transport.ts:344`: ``${JSON.stringify((read.probeStderr ?? "").trim().slice(0, 200))}``

## [MEDIUM] `create()` rethrows `ExeDevDriverError` without scrubbing — the one error class most likely to have been built from the argv containing the credential
- **File:line:** `src/providers/exedev/driver.ts:715`
- **Trigger:** The catch block exists precisely because "a rejection (spawn ENOENT, an exec timeout, a transport abort) routinely carries the whole argv in `err.message`". But the transport layer's own failures are thrown as `ExeDevDriverError` (that is the module's error type), and this branch rethrows those *before* `redactRegistryAuth` runs, on the unverified assertion "Our own typed errors never carry the credential". The argv it was built from is `["ssh","exe.dev","new","--name",name,"--image",ref,"--registry-auth","USER:PASSWORD","--json"]`. `sshCommand`/`control`/`withTimeout` error construction is not in this diff, so I cannot confirm the message is credential-free — capped at MEDIUM. If any of them names the argv, this is a credential in a log.
- **Evidence:**
  ```
  +      if (e instanceof ExeDevDriverError) throw e;
  +      throw new ExeDevDriverError(
  +        "create-failed",
  +        `... did not complete: ${this.redactRegistryAuth(e instanceof Error ? e.message : String(e))}`,
  ```

## [MEDIUM] `...opts` last defeats the both-or-neither pin guard when a caller passes an explicitly-undefined half
- **File:line:** `src/providers/exedev/driver.ts:1249-1251` and `src/providers/exedev/driver.ts:1333-1338`
- **Trigger:** `hasEffectiveImage` is computed as `opts.image !== undefined || hasImage`, so a caller passing `{ image: undefined }` (the normal shape when forwarding an optional config field) with `QDS_EXEDEV_IMAGE` set in the env passes the guard — and then `...opts` spread LAST writes `image: undefined` over the env value, while `imageBuildId` keeps the env value. The driver falls back to `DEFAULT_IMAGE_REF` paired with an override buildId, which is precisely "every box comes up, passes A, and dies at gate B saying the box booted an image this repo does not pin" — the exact failure this guard's comment says it exists to prevent. Same trap in the mirror direction for `imageBuildId`.
- **Evidence:**
  ```
  +  const hasEffectiveImage = opts.image !== undefined || hasImage;
  ...
  +    ...(hasImage ? { image } : {}),
  +    ...(hasBuildId ? { imageBuildId: buildId } : {}),
  +    ...opts,
  ```

## [MEDIUM] B0 hands one `budgetFree()` snapshot to two sequential execs, so it can consume ~2× the remaining free budget
- **File:line:** `src/providers/exedev/setup-gate.ts:507`
- **Trigger:** `budgetFree()` is evaluated once and passed as `deadlineMs` to `readBoxFile`, which uses that same value as a full per-call timeout for BOTH the `test -f` probe and the `cat`. A's two git calls each recompute `budgetFree()` and so share one remaining-budget window; B0 does not. The in-code justification ("B0 spends TWO free-phase budgets ... the same shape as A's two git calls") describes the overrun rather than bounding it: on a hung box B0's wall time is ~2× whatever `budgetFree()` returned, blowing past `gateTimeoutMs`. I cannot see `budgetFree()`'s definition (remaining-time vs fixed cap) in this diff, so capped at MEDIUM.
- **Evidence:**
  ```
  +        markerRead = await readBoxFile(driver, vm, IMAGE_MARKER_PATH, budgetFree());
  ```
  with `transport.ts:144,152` both doing `withTimeout(run(...), deadlineMs, ...)`.

## [LOW] Compensation logger can be handed a non-string, and a *successful* compensation leaves no record
- **File:line:** `src/providers/credentials.ts:374`
- **Trigger:** `revErrCred.message ?? revErr` passes the raw rejection value to `redactSecrets` whenever the rejection is not Error-shaped (a thrown string, a rejected `{}`), producing `[object Object]` at best and a throw inside the catch at worst — inside the compensation path for a LIVE provider key. Separately, only the *failed* compensation is logged: when `revokeAndVerify` succeeds, the fact that a live key was minted and then revoked because the store write failed appears nowhere.
- **Evidence:**
  ```
  +          message: redactSecrets(revErrCred.message ?? revErr, res.hash),
  ```

## [LOW] A lapsed ratification refuses the create with no `create_failed` event, unlike every other create failure
- **File:line:** `src/providers/exedev/driver.ts:676`
- **Trigger:** The per-create re-assertion is placed before `create_requested` and outside the try, so when a ratification lapses or the posture file is revoked mid-fleet — the exact scenario the comment says this line exists for — the throw escapes with no `create_requested` and no `create_failed` line. The observability the rest of this diff adds ("a create that never returns still joins to the image it asked for") does not cover the one new failure mode it introduced.
- **Evidence:**
  ```
  +    if (this.registryAuth !== undefined) assertRegistryAuthDeviation(this.postureFile);
  +    const createStartedAt = Date.now();
  +    this.emit("create_requested", { ...this.imageFields(name), create_ms: 0 });
  ```

## [LOW] `redactRegistryAuth`'s doc claims a coverage its implementation cannot provide
- **File:line:** `src/providers/exedev/driver.ts:590-603`
- **Trigger:** The comment lists three defeating shapes it says are handled: "echoes only the secret (or renders the pair quoted, or wraps it across a line)". `String.prototype.split(secret)` matches only a contiguous substring, so a line-wrapped secret is *not* redacted. The next maintainer reads this as covered and does not add the check.
- **Evidence:**
  ```
  +   * a control plane that echoes only the secret (or renders the pair quoted, or
  +   * wraps it across a line) defeats an exact `USERNAME:PASSWORD` match
  ...
  +      .split(secret)
  +      .join("[registry-auth redacted]");
  ```

## [LOW] D-pre adds an unbounded `pi --version` invocation ahead of the whole gate, in a script whose own header says pi stalls nondeterministically
- **File:line:** `src/providers/exedev/assertions-in-box.sh:139` and `:141`
- **Trigger:** The setup-gate header rewritten in this same PR says D no longer uses `pi -p` because it "stalls nondeterministically". D-pre then adds up to two `pi --version` calls with no `timeout` wrapper, ahead of C. A pi that hangs here burns the entire host-side gate budget and surfaces as a generic gate timeout rather than as the D-pre refusal this block was written to produce. Every other invocation of pi in this system (`gate_b`'s `pi --list-models`) is budgeted by the host via `execTimed`; the script's own commands are not individually bounded, so this is consistent with the file but new exposure ahead of everything else.
- **Evidence:**
  ```
  +pi_full="$(pi --version 2>/dev/null | grep -xE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  +if [ -z "$pi_full" ]; then
  +  pi_full="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  ```
