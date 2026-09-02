# Blind adversarial test review — PR184 test chunks

Scope: `chunk-tests-unit.diff` (image-contract.test.ts, setup-gate.test.ts, fixtures/fake-exedev.ts)
and `chunk-tests-live.diff` (tier1-image-contract.live.test.ts, exedev-bun-pin.test.ts).
Line numbers are new-file lines derived from the hunk headers (approximate for the two
modified files, exact for the three new files).

---

## [HIGH] No per-exec timeout inside `pollBootId` — a hung ssh defeats the poll budget and leaks a billing box

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:154-176 (`pollBootId`, diff lines 160-182)
- **Trigger:** `await ctx.driver.exec(vm, ["cat", BOOT_ID_PATH])` hangs — the routine case during a
  `sudo reboot`, where the TCP connection is established but the peer never responds and no
  `ClientAliveInterval`/`ConnectTimeout` fires. The loop condition `while (Date.now() - started < budgetMs)`
  is only evaluated *between* attempts, so `BOOT_BUDGET_MS`/`REBOOT_BUDGET_MS` are not enforced at all
  while an attempt is in flight; no `timeoutMs` is passed to `exec`.
- **Why it matters:** The budget the test advertises (and the 1 500 000 ms ceiling computed from summing
  the legs) becomes fiction: one hung ssh runs to the bun test timeout, which is the *one* path the file's
  own closing comment identifies as skipping the `finally` — leaking a live box and an unrevoked
  OpenRouter key. This is the exact failure mode the timeout arithmetic was raised to prevent.

## [HIGH] The key revoke in `finally` is gated on `mintedHash`, which is only set after `mintRunKey` resolves

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:382-384 (diff 388-390)
- **Trigger:** `mintRunKey` creates the key server-side and then rejects — response parse error, socket
  timeout after the POST was accepted, or a throw inside the store write. `mintedHash` stays `""`, so
  `revokeQuietly` is skipped even though a spendable key exists at OpenRouter.
- **Why it matters:** A live key at `CAP_MICRO_USD` survives the run with nothing pointing at it (the test
  never learned the hash to report). The condition should be `store !== undefined` alone, with
  `revokeQuietly` resolving the hash from the store / tolerating "nothing to revoke".

## [HIGH] `writeEvidence` throwing inside `finally` replaces the original test failure

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:388-404 (diff 394-410)
- **Trigger:** the evidence dir is unwritable, disk is full, or one of the pushed phase objects is not
  JSON-serializable (`gate.assertions` and raw `stdout` slices are pushed verbatim). The `try { writeEvidence } finally { rm workspace }`
  has no `catch`, so its exception propagates out of the outer `finally` and discards the in-flight throw
  from the `catch` block.
- **Why it matters:** The file's own comment claims cleanup "may not mask the test's own result" — but
  only `revokeQuietly`/`destroyQuietly` are quiet. A masked failure on a ~25-minute paid test costs
  another full run to rediagnose, and the operator sees an I/O error where an AC6 regression was.

## [HIGH] `destroyQuietly` failure is invisible — a leaked box produces a green test

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:385-387 (diff 391-393)
- **Trigger:** `exe.dev rm` fails (control-plane 5xx, name mismatch, transient network). `destroyQuietly`
  swallows it into `evidence`; nothing after that reads the evidence array, and the test still reports pass.
- **Why it matters:** The one outcome this file must never report green-and-silent is "box still running".
  Evidence-only recording means the leak is discovered by the bill, not by the suite. At minimum the
  post-`finally` should surface a non-destroyed box (a `process.exitCode`/warning line, or an assertion
  in a follow-up hook), not just a JSON field nobody reads.

## [MEDIUM] `captureLog` swallows the thunk's exception; two tests destructure only `{ lines }` and never assert success

- **File:** tests/providers/exedev/image-contract.test.ts:64-76 (`captureLog`, diff 239-251); consumers at
  :370-385 (diff 545-560) and :325-343 (diff 500-518)
- **Trigger:** `driver.create()` throws — e.g. an argv regression that the fake's anchored matcher rejects
  with exit 64, or any future create-path error. `captureLog` returns `{ error, lines }`; the "default-off"
  test binds only `lines`, so the throw is silently discarded.
- **Why it matters:** In the default-off test every remaining assertion survives a failed create:
  `newArgv(fake)` returns `[]` (see next finding) so `.not.toContain("--registry-auth")` passes,
  `fake.creates[0]?.registryAuth` is `undefined` so `toBeUndefined()` passes, and the only surviving
  check is that ≥1 `exedev.create*` log line exists — which `create_requested` emits before the failure.
  The test therefore green-lights a create that never reached the substrate.

## [MEDIUM] `newArgv()` returns `[]` when no `new` command was issued, making every `.not.toContain(...)` assertion vacuous

- **File:** tests/providers/exedev/image-contract.test.ts:58-61 (diff 233-236); vacuous uses at :231 and
  :375 (diff 406, 550)
- **Trigger:** any regression where `create()` does not reach the seam (throws early, short-circuits, or
  the argv shape changes so `a[2] !== "new"` — e.g. a `--` separator or a different subcommand position).
- **Why it matters:** `expect(newArgv(fake)).not.toContain(envOnly)` and
  `expect(newArgv(fake)).not.toContain("--registry-auth")` both pass on the empty array. The absence
  claims — "env value never reaches argv", "no credential flag when unset" — are precisely the ones that
  need a non-empty precondition (`expect(newArgv(fake).length).toBeGreaterThan(0)` or asserting the full
  array with `toEqual`, as the positive tests do).

## [MEDIUM] `fake.creates[0]?.registryAuth` — optional chaining turns "no create happened" into a pass

- **File:** tests/providers/exedev/image-contract.test.ts:376 (diff 551)
- **Trigger:** `fake.creates` empty (create refused / matcher missed). `undefined?.registryAuth` is
  `undefined`, satisfying `toBeUndefined()`.
- **Why it matters:** The fixture's whole justification (`FakeCreate` doc comment, diff 71-78) is that
  `creates` proves the control plane *parsed* the argv, distinguishing it from a fall-through to exit 64.
  Optional chaining here re-admits exactly the case the array was added to catch. The sibling assertions
  at :259 and :346 (`toBe(DEFAULT_IMAGE_REF)` / `toBe(VALID_AUTH)`) do fail on empty — only the
  `toBeUndefined()` one is defeated.

## [MEDIUM] The fake serves the marker path only for `test -f` and `cat`; any other verb falls through to the HOST's `/etc`

- **File:** tests/providers/exedev/fixtures/fake-exedev.ts:~639-653 (diff 145-159)
- **Trigger:** `readBoxFile` changes its size-capped read to `head -c`, `wc -c`, `dd`, `stat -c %s`, or
  wraps the two commands into one `sh -c 'test -f X && cat X'` variant that no longer word-matches
  `\bcat\b` — the `if (command.includes(IMAGE_MARKER_PATH))` block matches, neither inner regex fires,
  and execution reaches `spawnLocal(["sh","-c",command], ...)`.
- **Why it matters:** The comment directly above explains that a host probe reads as "marker absent for
  reasons that have nothing to do with the box" — and then leaves the fall-through open for every verb
  outside the two hard-coded ones. The gate-B pass tests would flip to failures with a misleading note,
  and (worse) on a dev machine that *does* have a `/etc/qds-image.json` the fake would serve foreign
  content. The path-matched branch should end in an explicit loud failure, not `spawnLocal`.

## [MEDIUM] The fake's `DEFAULT_IMAGE_MARKER` hand-copies `piVersion`/`bunVersion` in the same object where it imports `buildId` to avoid exactly that

- **File:** tests/providers/exedev/fixtures/fake-exedev.ts:~109-120 (diff 43-54)
- **Trigger:** the image pin bumps pi or bun. `DEFAULT_IMAGE_BUILD_ID` is imported and tracks; `"0.84.4"`
  and `"1.3.13"` are literals and do not.
- **Why it matters:** Any gate assertion that ever starts comparing the marker's runtime versions against
  the repo pins will read green against a stale double, and today the divergence is undetectable because
  *nothing in the unit suite asserts those two fields at all* (see next finding). The doc comment's own
  argument — "a hand-copied literal here would keep reading green on the day the pin lands" — applies
  verbatim to the two literals beside it.

## [MEDIUM] Gate B is only ever proven on `buildId`; `imageRef`, `piVersion` and `bunVersion` have no negative case

- **File:** tests/providers/exedev/image-contract.test.ts:569-603 (fail-closed table, diff 744-778)
- **Trigger:** an implementation of gate B that compares `buildId` and ignores every other marker field —
  or one that regresses to ignoring `imageRef`. Every case in the table varies `buildId`, structure, or
  size; none ships a well-formed marker whose `imageRef` disagrees with the driver's `image` while
  `buildId` matches.
- **Why it matters:** The tenant test (:623-653) sets `buildId` *and* `imageRef` together, so it cannot
  isolate which one the gate reads. A box that booted a different repository's image but carries a
  colliding/copied `buildId` is accepted, and INV-IBOX-2's "the box states what it booted" is only
  half-enforced by the suite.

## [MEDIUM] The `why` regexes in the fail-closed table are supersets of each other — a mis-diagnosed refusal still passes

- **File:** tests/providers/exedev/image-contract.test.ts:571-580 (diff 746-755)
- **Trigger:** the gate reports "not a JSON object" for the truncated-JSON case, or "buildId missing"
  for the mismatch case. `/parseable|JSON/i` matches the wrong-type wording; `/buildId|repo pin/i`
  matches nearly every gate-B note; `/cap|bytes/i` matches any message containing "bytes".
- **Why it matters:** The table's stated purpose is that each malformed shape refuses *for its own reason*.
  With overlapping regexes, an implementation that collapses all six arms into one generic note passes
  the whole table, and the operator-facing diagnosis nobody verified is what ships.

## [MEDIUM] No refusal test for an image ref or credential arriving via `exeDevDriverFromEnv` — the only untrusted source

- **File:** tests/providers/exedev/image-contract.test.ts:215-250 (diff 390-425)
- **Trigger:** `exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: "ghcr.io/qds/img:$(id)" }, …)`. The factory is
  exercised only with well-formed values; every refusal case goes through `new ExeDevDriver(...)` directly.
- **Why it matters:** The constructor tests establish that validation happens at the trust boundary — but
  the actual boundary in production is the environment variable, and a factory that builds the argv itself,
  normalises the value, or defaults before validating would satisfy every test in this file while threading
  an operator-supplied `$(id)` into an ssh remote command line. Same gap for whatever env key supplies
  `registryAuth`: the factory's credential path is untested end to end.

## [MEDIUM] The two diffs make contradictory factual claims about what `pi --version` prints

- **File:** tests/providers/exedev/setup-gate.test.ts:~852-860 (diff 880-889) vs
  tests/fleet/e2e/tier1-image-contract.live.test.ts:252-253 (diff 257-258)
- **Trigger:** whichever comment is wrong. The unit stub asserts "MEASURED on the real linux/amd64 factory
  image: `pi --version` prints the bare version, no `pi ` prefix" and stubs `echo "0.84.4"`; the live test
  says "pi prints more than a bare number" and extracts with `/[0-9]+\.[0-9]+\.[0-9]+/`.
- **Why it matters:** If the live comment is right, the shell stub is an unfaithful double of the exact
  surface the new AC2 assertion parses, and `assertions-in-box.sh`'s extraction is untested against the
  real output shape — the Dockerfile marker step is described as asserting *exact equality* against
  `PI_VERSION`, so a prefix the stub omits is a build-time failure no unit test can see.

## [MEDIUM] `PI_REVIEWED_SERIES` is duplicated as a bare literal in the test shim

- **File:** tests/providers/exedev/setup-gate.test.ts:~858 and :~1002 (diff 887, 913)
- **Trigger:** bumping the pinned pi. `"0.84.4"` lives in the passing shim, `"0.99.0"` in the refusing
  shim, `"0.84.4"` again in `fake-exedev.ts`'s `DEFAULT_IMAGE_MARKER`, and the real value in
  `assertions-in-box.sh` — four places, no import.
- **Why it matters:** The AC2 test exists to make the F14 tolerance version-conditional. After a pin bump
  the *passing* shim starts reporting an unreviewed series and D fails everywhere, which reads as a broken
  gate rather than "update the reviewed series" — and the failure lands in unrelated tests, so the signal
  points at the wrong file.

## [MEDIUM] The AC2 test consumes `f11-roster.yaml`, which it does not create — ordering dependence

- **File:** tests/providers/exedev/setup-gate.test.ts:~1014 (diff 922)
- **Trigger:** running this test alone (`bun test -t "DF2.10 AC2"`), or a reorder/removal of whichever
  earlier test writes `f11-roster.yaml` into `rosterDir`.
- **Why it matters:** If the roster is written by a sibling *test* rather than a `beforeAll`, the script
  is invoked with a missing roster path and fails for a reason unrelated to the pi series — the
  `expect(d?.note).toMatch(/UNREVIEWED/)` assertion then fails confusingly, or (if the script tolerates a
  missing roster) D refuses for the wrong reason and the test passes vacuously.

## [MEDIUM] `readBunPin` has no rejection coverage, by admission — and the reason is a testability defect in the production module

- **File:** tests/scripts/exedev-bun-pin.test.ts:19-27 (docstring) and :19-38 (diff 448-467)
- **Trigger:** `packageManager: "pnpm@1.3.13"`, a missing `packageManager` key, `"bun@"`, malformed JSON.
  None are exercised, because "every rejecting path in this module calls `die()`, which is `process.exit`".
- **Why it matters:** The pin feeds a GitHub release URL interpolated in the Dockerfile, and the file's own
  premise is that a bad capture costs ten QEMU-emulated minutes. Whether the regex is anchored to `bun@`
  at all is unverified — a capture that accepts any `<manager>@<semver>` would silently build against
  pnpm's version. The lazy fix is for `readBunPin` to throw and the caller to `die()`, which makes all
  four negative cases one-liners.

## [MEDIUM] The round-4 timing regression test's pass window is now narrower relative to real exec time

- **File:** tests/providers/exedev/setup-gate.test.ts:~740-748 (diff 846-864)
- **Trigger:** a loaded/slow runner. The comment budgets "9 × 500 ms of tax + ~0.1-0.5 s of real exec time
  ≈ 4.6-5.0 s consumed; the deadline at 5.55 s leaves ≈ 0.55-0.95 s". Real exec time is now spread over
  nine spawns instead of seven; exceeding ~1.05 s total pushes remaining below zero and C/D/E is refused,
  failing `expect(result.assertions.map(a => a.item)).toContain("C")`.
- **Why it matters:** A wall-clock-derived pass window of ~400 ms on a suite that spawns nine real
  subprocesses is a flake, and a flake in the one test that guards the INV-2 spend budget gets muted
  rather than fixed.

## [MEDIUM] `rebootExit` is recorded but never checked — a refused `sudo -n reboot` presents as a 4-minute boot-id timeout

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:339-345 (diff 345-351)
- **Trigger:** the image ships without passwordless sudo for `exedev`, or `reboot` is not permitted.
  `exec` returns a non-zero exit, the evidence records it, and the test proceeds to `pollBootId` for a
  *different* boot id.
- **Why it matters:** The failure message is "box did not answer ssh with an accepted boot id within
  240000 ms", which reads as a machine that failed to come back — the opposite diagnosis from "the reboot
  was never issued". Burns `REBOOT_BUDGET_MS` of paid box time to produce a misleading error.

## [LOW] The AC6 claim rests on an assumption about `driver.exec` that is asserted only in a comment

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:332-338, 359-373 (diff 338-344, 365-379)
- **Trigger:** `ExeDevDriver.exec` acquiring any lazy per-connection provisioning (the driver already
  provisions the steering channel in `create()`), or a future `exec` that ensures `/run/steering` before
  running.
- **Why it matters:** `pollBootId` calls `exec` repeatedly *after* the reboot and before the stat, so the
  "no code path of ours having run" claim would be false and the test would report `/etc/tmpfiles.d`
  working when the driver had recreated the directory. The suite would not notice.

## [LOW] `expect(Object.keys(marker).length).toBe(6)` and the non-empty loop re-assert the production parser's own guarantees

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:236-241 (diff 242-247)
- **Trigger:** always. `parseImageMarker` is documented (and unit-tested at image-contract.test.ts:469-473)
  to refuse missing/empty fields and non-objects, and presumably returns a fixed key set.
- **Why it matters:** These lines read as substrate verification on the most expensive test in the repo
  but can only fail if the parser is broken — which the unit suite already covers. Whatever they were
  meant to catch about the *box* (e.g. the marker matching `package.json`'s bun pin, or the file's mode/
  ownership) is not covered anywhere.

## [LOW] Nothing links the built image's `bunVersion` back to `package.json`'s pin

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:275-276 (diff 275-276); tests/scripts/exedev-bun-pin.test.ts
- **Trigger:** a build that ignores the `BUN_VERSION` build arg, or an image rebuilt after the repo pin
  moved. `expect(bunObserved).toBe(marker.bunVersion)` compares the box to the *marker's own claim*; the
  marker is tied to the repo only through `buildId`.
- **Why it matters:** `readBunPin` is unit-tested and the in-box bun is compared to the marker, but no
  assertion closes the loop `package.json → marker.bunVersion`. A build-arg regression produces a
  self-consistent box that passes AC2 while running a bun nobody pinned.

## [LOW] `expect(caught?.remediation.includes(secret)).toBe(false)` is element-equality if `remediation` is `string[]`

- **File:** tests/providers/exedev/image-contract.test.ts:319 (diff 494)
- **Trigger:** `remediation` being an array (the suite treats it inconsistently: `.length > 0` at :153 and
  `toContain(IMAGE_MARKER_PATH)` at :465 both work for either type). If it is an array, a remediation line
  reading `"expected <user>:<token>, got qdsbot:SUPERSECRET…"` passes, because no *element* equals the
  bare secret.
- **Why it matters:** This is one of the two INV-IBOX-3 leak checks. If the type is `string[]`, the
  remediation half of the credential-leak assertion has never been able to fail. Worth confirming the
  type and switching to `expect(JSON.stringify(caught?.remediation)).not.toContain(secret)` either way.

## [LOW] The stderr-redaction test only exercises an echo of the full `user:pass` form

- **File:** tests/providers/exedev/image-contract.test.ts:387-420 (diff 562-595)
- **Trigger:** a control plane that echoes only the password half (`unknown token: ghp-LEAK…`) or a
  percent/URL-encoded form. A redactor implemented as `replace(registryAuth, "[registry-auth redacted]")`
  passes this test and leaks in both cases.
- **Why it matters:** The test's own framing is "the measured hazard: a control plane that echoes the argv
  it received" — but argv-splitting error messages routinely quote a single offending token, and the
  canary check (`includes(CANARY_SECRET)`) would catch it if the case existed. Adding the password-only
  stderr arm is one line.

## [LOW] `expect(fake.calls).toEqual([])` depends on no earlier test in the shared-`beforeAll` describe having issued a command

- **File:** tests/providers/exedev/image-contract.test.ts:156-158 (diff 331-333), fake created in
  `beforeAll` at :110 (diff 285)
- **Trigger:** any future test added above "the refusal happens in the CONSTRUCTOR" in the same describe
  that calls `create()`/`exec()` on the shared fake.
- **Why it matters:** The empty call log is explicitly named as "THE claim" that proves nothing reached
  the wire, and it is order-dependent shared state with no `beforeEach` reset. A locally-constructed
  `fakeExeDev()` inside the test (as every test in the sibling describe does) makes the claim
  order-independent.

## [LOW] The 7-case fail-closed loop shares a 180 s budget across seven create → fill → setup cycles

- **File:** tests/providers/exedev/image-contract.test.ts:568-603 (diff 743-778)
- **Trigger:** a slow runner. Each case runs a real `git clone`-shaped `fill` plus a full gate;
  single-case siblings are given 90 s each, so seven cases at 180 s total assumes ~25 s each.
- **Why it matters:** A timeout here aborts mid-loop, so the later cases (including the load-bearing
  "well-formed, readable, and WRONG" mismatch case, which is last) are never evaluated — and the failure
  reports as a timeout rather than a missing assertion.

## [LOW] `evidenceDir` is passed to the gate but never created

- **File:** tests/providers/exedev/image-contract.test.ts:491, 498 (diff 666, 673)
- **Trigger:** the gate writing evidence with a non-recursive create, or the gate treating an unwritable
  evidence dir as non-fatal.
- **Why it matters:** `originDir` and `rosterDir` are both `mkdirSync`'d in the same `beforeAll`;
  `evidenceDir` is not. Either the gate silently skips evidence (so the evidence path is untested here)
  or it will start failing the moment the gate's own mkdir behaviour changes.

## [LOW] `expect(version).toMatch(/^[0-9A-Za-z.-]+$/)` is a charset check, not a version check

- **File:** tests/scripts/exedev-bun-pin.test.ts:33-37 (diff 462-466)
- **Trigger:** `readBunPin` returning `"sha512"`, `"bun"`, `"-"`, or any other URL-safe garbage from a
  regression in the capture group.
- **Why it matters:** The test's stated purpose is that the value produces a working release URL. It
  catches the `+sha512.` suffix (`+` is outside the class) but not a capture that grabbed the wrong token
  entirely — `/^\d+\.\d+\.\d+/` alongside it costs nothing.

## [LOW] The repo-pin assertions run *after* the expensive `create()`

- **File:** tests/fleet/e2e/tier1-image-contract.live.test.ts:141-142 (diff 147-148)
- **Trigger:** an operator with `QDS_EXEDEV_IMAGE` exported (the harness's `preflight` plausibly builds
  the driver via `exeDevDriverFromEnv`). `expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF)` fails only
  after a real box has been created and billed.
- **Why it matters:** The whole point of the assertion is "no `--image` override is passed here on
  purpose" — a precondition, checkable for free immediately after `preflight("2")` returns and before a
  cent is spent.

## [LOW] The unit suite hard-requires a digest pin while the live test is written to accommodate an immutable tag

- **File:** tests/providers/exedev/image-contract.test.ts:93 (diff 268) vs
  tests/fleet/e2e/tier1-image-contract.live.test.ts:106 (`pinShape`, diff 112)
- **Trigger:** adopting AC1b (immutable tag) instead of AC1a. `expect(imageDigestOf(DEFAULT_IMAGE_REF)).toMatch(/^sha256:[0-9a-f]{64}$/)`
  goes red, and `isUnpinnedImage` on a tag-only reference is untested in both directions.
- **Why it matters:** The live test records `pinShape: "immutable-tag"` as a live possibility that the
  unit suite cannot ever observe, so the recorded field is dead. More concretely: if the tag shape is
  adopted, the failure surfaces as a broken assertion in the DoD gate rather than as a decision to
  revisit — and `isUnpinnedImage("ghcr.io/x/y:v1")`, the function guarding the DoD, has no test at all
  for the tag case.
