# FIX-SRC-EXEDEV

Round 4, fixer scope: `src/providers/exedev/{driver,transport,setup-gate}.ts`,
`src/providers/exedev/assertions-in-box.sh`,
`tests/providers/exedev/{setup-gate,read-box-file}.test.ts`.
Every finding was located in the real file before patching. All 14 held as
described except C1, whose *premise* is refuted in the shipped transport (see
False positives) — patched anyway on the pre-authorized fail-safe.

No commits, no staging, no push. Nothing outside the six owned files was touched.

## Patched

| ID | File:line | What changed | Why | gitnexus blast radius |
|----|-----------|--------------|-----|-----------------------|
| C1 | `src/providers/exedev/driver.ts:766-772` | The `e instanceof ExeDevDriverError` arm in `create()`'s catch now runs `redactRegistryAuth` over the message before rethrowing; a NEW `ExeDevDriverError` is built only when the scrub actually removed something (ordinary case keeps its stack, code and remediation). Comment rewritten to stop asserting the exemption is safe. | The exemption rested on "our own typed errors never carry the credential" — true of every refusal in this module today, but unverifiable at this seam: `this.run` is an INJECTED command seam and `ExeDevDriverError` is the module's public error type, while the argv this call was built from carries `--registry-auth USERNAME:PASSWORD`. Redaction is one string scan on an already-failing path. | `impact(ExeDevDriver.create, upstream)` → **HIGH**, 6 impacted, direct 1, `epistemic: lower-bound` (8 interface implementations). Processes: `runCapHitDemo`, `provisionAdmittedRun`, `runDispatch`, `dispatch`. No signature change; the thrown `code`/`remediation` are preserved, so no consumer's classification moves. |
| C2 | `src/providers/exedev/driver.ts:1295-1302, 1327-1328, 1416-1421` | `exeDevDriverFromEnv` strips undefined-valued keys from `opts` ONCE into `given`; both the both-or-neither guard and the final spread read `given`. | `{ image: undefined }` (the normal shape when forwarding an optional config field) counted as an override in `hasEffectiveImage`, then the `...opts` spread (LAST) wrote that `undefined` over the env value while `imageBuildId` kept the env's — the mismatched pair the guard exists to prevent, arriving through the guard. Mirror trap for `imageBuildId`, closed by the same line. | `impact(exeDevDriverFromEnv, upstream)` → **LOW**, 5 impacted, direct 1 (`src/providers/index.ts`), 0 processes. Behaviour for every non-undefined key is byte-identical. |
| C3 | `src/providers/exedev/transport.ts:105-106, 142-156, 165-166` | `readBoxFile` takes ONE absolute deadline (`Date.now() + deadlineMs`) and budgets both legs from it: the probe gets what is left, then the `cat` gets what the probe left, floored at 1 ms. Docblock corrected ("the PAIR bounded by ONE `deadlineMs`"). | Both legs used to get the FULL `deadlineMs`, so a hung box cost its caller up to 2 × the number it said. B0 hands one `budgetFree()` snapshot and is then measured against `gateTimeoutMs`; the fanout race ticks against a per-tick deadline. Neither has a second budget. Fail-safe: the floor keeps the read *issued* (killed at spawn → `unreadable`/rejection, both already fail-closed at both call sites) rather than adding a fifth `BoxFileRead` arm. | `impact(readBoxFile, upstream)` → **HIGH**, 8 impacted, direct 2 (`setupGate`, `probeArm`), 4 processes (`fanout`, `runDispatch`, `dispatch`, `setupGate`), 3 modules. **SIGNATURE UNCHANGED** — see the handoff section. |
| C4 | `src/providers/exedev/assertions-in-box.sh:128-143` | New `case "$models_json" in /*) ;; *) emit D 0 …; exit 3 ;; esac` immediately after the emptiness guard. | `os.path.expanduser` returns its argument UNCHANGED when HOME is unset and the uid has no passwd entry, printing a literal `~/.pi/agent/models.json`: non-empty, so the emptiness guard passed, and `[ ! -f "~/…" ]` then tested a literal-tilde RELATIVE path that never exists — reading a PRESENT, possibly-unpriced registry as the tolerated absence. Both read sites (D-pre and D's scan) are covered by the one refusal, because it exits before either. | Shell — not indexed. Read sites verified by hand at (post-patch) `:165` and `:283`. |
| C5 | `src/providers/exedev/setup-gate.ts:41-42, 97-115, 699-709` + test | New optional `SetupGateResult.notRun?: AssertionItem[]` — the complement of `assertions`, computed once over the whole A–E table at assembly, emitted only when non-empty (so it also rides the evidence artifact). | A D-pre refusal emits one `{"item":"D"}` line and exits 3; `controlled` is true, so only the D row is pushed and C — the live per-model ping whose absence is the whole point of the hoist — is neither failed nor skipped. An artifact with no C row is indistinguishable from a gate never asked to run one. `failedItem`/`assertionCode` are deliberately **unchanged**: a fabricated failed C ahead of D would rewrite assertionCode 3 into 2 and send dispatch to the wrong table. | `impact(setupGate, upstream)` → ambiguous (3 same-named symbols); the src one reports 0 direct callers because it is reached through `ExeDevDriver.setup`. Additive optional field; `fake-gate.ts` and `dispatch.ts` compile and pass untouched (`bunx tsc --noEmit` clean, `tests/fleet/` green). |
| C6 | `src/providers/exedev/driver.ts:570-588` | New constructor announce `image_override` — fires whenever `image !== DEFAULT_IMAGE_REF` **or** `imageBuildId !== DEFAULT_IMAGE_BUILD_ID`, carrying `imageRef`, `imageDigest`, `imageBuildId` and a `why`. The tag arm above it is unchanged. | RESOLUTION as directed: the override stays (AC3 requires it) but stops being silent. The tag arm fired only for a mutable pin, so a digest-shaped override rode `imageRef`/`imageBuildId` through the create events looking exactly like the repo pin, and gate B passed because it checks the box against the DRIVER's claim, not the repo's. Either half fires it — half a pin is refused at the factory, but a direct `new ExeDevDriver({imageBuildId})` (documented test seam) is not. | Constructor of `ExeDevDriver`; the announce uses the existing private `emit`, exactly as the tag arm does. New log line only — see the handoff section. |
| C7 | `src/providers/exedev/driver.ts:718-733` | `assertRegistryAuthDeviation(this.postureFile)` MOVED from before `create_requested`/outside the try to the first statement INSIDE the try. | It was the one new failure mode this diff introduced (a ratification lapsing mid-fleet) and the only create failure that emitted no event at all. It now emits `create_requested` then `create_failed` (exitCode `null`) like every other refusal, and C1's catch preserves its typed `registry-auth-unratified` code — a lapse must never read as `create-failed`. | Same `create` blast radius as C1 (**HIGH**). The throw, its code and its remediation are unchanged; only two log lines are added on a path that previously threw silently. |
| C8 | `src/providers/exedev/driver.ts:606-627` | Docblock corrected: the "wraps it across a line" claim is removed and replaced with an explicit COVERAGE paragraph — `split(secret)` is a contiguous-substring match, a wrapped/interrupted secret is NOT redacted, and the guarantee INV-IBOX-3 rests on is the ratified deviation. | Comment-only; the implementation is correct as written and a line-wrap-tolerant redactor is not a one-liner (it would need to reason about arbitrary insertions inside the secret). Out of scope, and now honestly stated instead of over-claimed. | Comment only. |
| C9 | `src/providers/exedev/assertions-in-box.sh:155-170` | `pi --version` is invoked ONCE into `pi_version_out`, wrapped in `timeout 10` when `command -v timeout` succeeds, and both greps read that variable. | Up to two unbounded `pi --version` calls sat ahead of the whole gate in a block that exists to refuse *cheaply* — and D abandoned `pi -p` precisely because pi's node client stalls nondeterministically on these boxes. A stall here burned the host-side gate budget and surfaced as a generic gate timeout instead of the D-pre refusal. `timeout` is coreutils and the image is exeuntu/Ubuntu (`oci/exedev/Dockerfile` uses `sha256sum`/`install`/`unzip`); a box without it degrades to the bare call rather than being refused for a missing utility. Also halves the invocations. | Shell — not indexed. `bash -n` and `shellcheck -s sh` clean (see gates). |
| C10 | `src/providers/exedev/driver.ts:1346-1355` | The `QDS_EXEDEV_REGISTRY_AUTH_FILE` block is now gated on `given.registryAuth === undefined` as well. | `...opts` spreads LAST, so an explicit `registryAuth` means the file's bytes were never going to be used — yet a 0644 file in the env threw `registry-auth-file-mode` naming a file the driver had no interest in, and an operator's credential was loaded into the process for nothing. Same asymmetry the image pin already handles with `hasEffectiveImage`. | Part of `exeDevDriverFromEnv` (**LOW**, direct 1). |
| C11 | `src/providers/exedev/driver.ts:300-309, 1381-1394` | New `REGISTRY_AUTH_FILE_MAX_BYTES = 1024` and a `stat.size` check between the owner check and `readFileSync`, refusing with a new code `registry-auth-file-oversized`. | `stat.size` was in hand and never read, so a mispointed path at a large 0600 file the operator owns (shell history, heap dump, `.env` backup) was slurped whole before `assertRegistryAuth` rejected it on `secret.length > 512`. The ceiling: 128 (username) + 1 + 512 (password) = 641 is the longest credential `assertRegistryAuth` admits; the slack covers a trailing newline. | Part of `exeDevDriverFromEnv` (**LOW**, direct 1). New error code — see the handoff section. |
| C12 | `src/providers/exedev/setup-gate.ts:539-546` + `tests/providers/exedev/setup-gate.test.ts:331-338` | `marker_assert_ms: Math.max(1, Date.now() - markerT)`, and the test now asserts `>= 1` instead of only `typeof === "number"`. | Under "a field never evaluated reports 0", a sub-millisecond B0 read published the never-evaluated sentinel for an assertion that DID run. Clamped UNCONDITIONALLY, unlike `boot_ready_ms`: B0 is evaluated on the failing path too, so both outcomes must report a measured duration. | Local to `setupGate`'s B0 emission. |
| G6 | `tests/providers/exedev/setup-gate.test.ts` (frozen test's `finally`) | `setSystemTime()` added to the round-5 test's `finally`, restoring the clock. | Confirmed exactly as reported: the freeze had no reset anywhere in the file, and `describe("setup gate — input contract (D9/D10/D14)")` runs AFTER it — every test in that block ran with `Date.now()` pinned, so `budgetFree()` returned the full `gateTimeoutMs` on every call and D10 drove `setupGate` through a budget that could not expire. `bun test -t "D10"` exercised a different clock than the file. | Test-only. |
| G7 | `tests/providers/exedev/setup-gate.test.ts` (new direct-script test) | New test: a pi double whose `--version` prints an update banner carrying a HIGHER semver on the first line and the real `PI_VERSION` on the second; asserts D passes on the tolerance, names no UNREVIEWED series, and exits 0. | Confirmed: all three existing pi doubles print a bare version or nothing, so the `grep -xE` exact-line pass was untested. **Mutation-verified**: with line 168's exact-line match replaced by `pi_full=""`, this test fails (`expect(d?.ok).toBe(true)` → received false) while AC2, D7 and F14 stay green. Script restored and re-verified byte-identical afterwards. | Test-only. |

Fail-safe choices, stated: C3 floors the second leg at 1 ms rather than skipping it
(both callers already fail closed on the resulting kill/rejection); C4 and C9 refuse
rather than degrade, except that C9 degrades to an unbounded call when `timeout` is
absent (refusing a box for a missing coreutils utility would be a worse failure than
the one being bounded); C5 records the skip WITHOUT touching `assertionCode`; C6 keeps
the override and makes it loud, per the resolution.

## False positives

| ID | Why it does not hold, with evidence |
|----|-------------------------------------|
| C1 (premise only — the fix was still applied, as directed) | "the transport layer's own failures ARE `ExeDevDriverError`" is not true of the shipped transport. Traced every rejection reachable from `create()`'s `await this.control(...)`: `sshCommand` (`transport.ts:48-85`) throws nothing typed — a `Bun.spawn` ENOENT is a plain `Error` naming argv[0] only; `withTimeout` (`src/providers/timeout.ts`) throws `TimeoutError`, message `` `${what} timed out after ${ms}ms` ``, which names no argv and is NOT an `ExeDevDriverError`; `src/providers/bounded-exec.ts` contains no `throw new` of any `ProviderError` (grep returns nothing). Inside that try, the ONLY reachable `ExeDevDriverError` is `assertRegistryAuthDeviation`'s, whose message names the posture file path — never argv. So no shipped path leaked. The finding's *fix* is still right and was applied: `this.run` is an injected seam and `ExeDevDriverError` is the module's public type, so the exemption is an assertion this seam cannot check. |

No other finding was refuted. C2, C4, C5, C7, C9, C10, C11, C12, G6 and G7 were each
reproduced against the real file (line numbers were approximate but every construct was
present as described); C3's overrun is real (`readBoxFile` handed `deadlineMs` to both
`withTimeout` calls AND to both `execTimed` calls); C6 and C8 are as described.

## Gate output

**1. `bun test tests/providers/exedev/`** (after `tr`/`perl` de-ANSI — required):

```
exit=1
error: directive-set: DF1.10 adds exactly one line (ExecStart=/usr/local/bin/qds-engine run %i); pinning the set makes that addition a deliberate, visible change
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > every AC6 policy holds on the file as shipped [2.33ms]
error: expect(received).toEqual(expected)
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > no ExecStart — DF1.10 owns it, and its arrival must be a visible change [0.09ms]
error: AC6's named negative control: Restart=on-failure
(fail) DF2.10 AC6 — negative controls: each assertion rejects the wrong file > every mutation is rejected by exactly the policies named, and by no others [0.27ms]

 223 pass
 1 todo
 3 fail
 1276 expect() calls
Ran 227 tests across 6 files. [109.92s]
```

ATTRIBUTION — all 3 failures are `tests/providers/exedev/image-assets.test.ts`
(another fixer's file) asserting on `oci/exedev/systemd/qds-run@.service`
(another fixer's file). `git status` shows the unit file MODIFIED and the test
file NOT modified: the systemd fixer added `Requires`, `AssertPathExists`,
`TimeoutStopSec`, `TimeoutStartSec` and dropped `[Install]` without updating the
pinned policy set. Failure text names only unit directives — nothing from my six
files. My own files: `setup-gate.test.ts` 49 pass / 0 fail standalone;
`read-box-file.test.ts` green.

**2. `bun test tests/fleet/ | tail -20`** — first run showed ONE failure, a
load-dependent flake in another file:

```
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > a hung loser teardown hits its deadline: disposal completes, the timeout is named, the lock survives [4940.52ms]
 1058 pass · 24 todo · 1 fail · Ran 1083 tests across 33 files. [327.35s]
```

Investigated rather than waved off (`readBoxFile` is that file's dependency): the
test drives a 2 s `loserTeardownTimeoutMs` against real host git and its own
comments admit the timing sensitivity ("Exact timeout count depends on race
between 2s deadline and teardown progress"). Re-ran it alone 4×: 4/4 pass. Ran
the whole `patterns.test.ts` 2×: 47 pass / 0 fail both times. Re-ran the full
suite:

```
 1059 pass
 24 todo
 0 fail
 7614 expect() calls
Ran 1083 tests across 33 files. [212.20s]
```

The failing assertion (`steps` reached `stopVisualizer/spend/artifacts` but not
`close` inside 2 s) is teardown-deadline work, structurally independent of the
probe budget C3 changed.

**3. `bunx biome check src/providers/exedev/ tests/providers/exedev/`**

```
Checked 12 files in 79ms. No fixes applied.
```

**4. `bunx tsc --noEmit`** — no output at all (whole repo clean, including every
file I touched).

**5. `bash -n` + `shellcheck`**

```
bash -n: ok

In src/providers/exedev/assertions-in-box.sh line 305:
d_scan="$(python3 -c '
                     ^-- SC2016 (info): Expressions don't expand in single quotes, use double quotes for that.
shellcheck exit=1
```

The single SC2016 is PRE-EXISTING and deliberate (`shellcheck -s sh` on
`git show HEAD:…` reports the identical info at the then-line 276; the python
body is single-quoted on purpose — the file says so at the `else` above it).
My additions (the `case` refusal and the bounded `pi --version`) draw no
shellcheck output.

## Signature / behaviour changes other fixers and wave 2-3 MUST know about

1. **`readBoxFile` — SIGNATURE UNCHANGED, semantics tightened.**
   `readBoxFile(driver, vm, path, deadlineMs)` is byte-identical in shape;
   `deadlineMs` is still a DURATION, not an absolute timestamp. What changed:
   the presence probe and the `cat` now share that one budget instead of each
   getting it in full. Nothing to update in `src/fleet/fanout-primitive.ts:743`
   — its per-tick deadline now means what it says (worst case ~1× instead of
   ~2×). The only observable difference for a caller is that a slow probe
   shortens the read, which lands on the already-handled `unreadable`/rejection
   paths. `tests/providers/exedev/read-box-file.test.ts`'s old
   `expect(timeoutMs).toEqual([5_000, 5_000])` had to go — it pinned the double
   spend — and is replaced by a bound-plus-sharing pair of assertions.

2. **New gate-result field: `SetupGateResult.notRun?: AssertionItem[]`** (C5).
   Optional, present only when non-empty, and it rides the evidence artifact
   (`.sandbox/setup-gate/<runId>.json`) because the artifact spreads the result.
   `assertions`, `failedItem` and `assertionCode` are **unchanged** — a D-pre
   refusal is still `failedItem:"D"`, `assertionCode:3`, `assertions:[A,B,D]`,
   now with `notRun:["C","E"]`. Anyone consuming the artifact or the gate result
   can start telling "C failed" from "C never ran"; nobody has to.
   `src/providers/fake-gate.ts` builds `SetupGateResult` without it and still
   type-checks (its results simply carry no `notRun`) — if the fake gate should
   also report skips, that is a follow-up in that file's owner's scope.
   The run-record `extensions.gate` schema (`run-record.ts:323`) is untouched.

3. **New create-path log event: `exedev.image_override`** (C6). Emitted from the
   `ExeDevDriver` CONSTRUCTOR whenever `image !== DEFAULT_IMAGE_REF` or
   `imageBuildId !== DEFAULT_IMAGE_BUILD_ID`, carrying
   `{imageRef, imageDigest, imageBuildId, why}` and `status:"ok"`. It fires for
   every driver built with an explicit image/buildId — including live E2E
   harnesses and `image-contract.test.ts`'s override cases. Anything that
   asserts an EXACT log-event count or set around driver construction will see
   one more line (nothing in the current suites does; all green). The pre-existing
   `image_not_digest_pinned` arm is unchanged and both can fire together for a
   tag-shaped override.

4. **New error code: `registry-auth-file-oversized`** (C11), thrown by
   `exeDevDriverFromEnv` when `QDS_EXEDEV_REGISTRY_AUTH_FILE` exceeds 1024 bytes.
   Anything enumerating that factory's refusal codes (docs, the live TIER-1
   registry-auth test) should include it. Related: with an explicit
   `opts.registryAuth`, the auth FILE is no longer opened at all (C10), so a
   test that set both and expected a file-mode refusal would now pass instead —
   nothing in the suite does.

5. **`create()` now emits two events on a lapsed ratification** (C7):
   `create_requested` then `create_failed` (`exitCode: null`). The throw, its
   `registry-auth-unratified` code and its remediation are unchanged; only the
   observability is. A live-E2E assertion of "no create events when the posture
   file is revoked" would now be wrong — the events are the fix.

6. **Test-file clock hygiene** (G6): the round-5 frozen-clock test now restores
   the clock in its own `finally`. It is still commented MUST STAY LAST, and
   should stay last — the restore is a second belt, not a licence to reorder.
   On the 60 s timeout at D10: with the clock restored, that whole
   `describe` runs in ~690 ms in isolation, so the bump is no longer
   load-bearing — I KEPT it and rewrote its comment to say so, because a green
   run proves a ceiling unhit, not unnecessary, and every other
   box-provisioning test in the file carries the same 60 s.
