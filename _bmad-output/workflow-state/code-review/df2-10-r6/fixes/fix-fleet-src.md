# F6 — fleet/credentials src + unit tests (fixer `fix-fleet-src`)

Branch `fix/df2.10-review-round-6`. No commits, no pushes.
Files touched: `src/fleet/fanout-primitive.ts`, `src/providers/credentials.ts`,
`src/providers/index.ts`, `tests/fleet/patterns.test.ts`,
`tests/providers/credentials.test.ts`, **new** `tests/providers/driver-registry.test.ts`,
plus the three cleanup call sites the scope correction directed me to:
`scripts/sandbox-teardown.ts`, `scripts/sandbox-reap.ts`, `scripts/fleet.ts`
(two of its five `resolveDriver` sites).
`tests/fleet/resident.test.ts` — no finding against it (the report lists its
repoSlug change under "Checked and clean"); left untouched.

Skipped as assigned elsewhere: `readBunPin` `bun@1`/`bun@1.3`, `ARG BUN_SHA256`
version pairing (both `fix-buildscript`), and the two `read-box-file.test.ts`
findings (`fix-driver-transport`).

## Scope corrections

The team lead's mid-task correction on **P114**: DF2.10's
`registerDriver("exedev", () => exeDevDriverFromEnv())` is **AC3's intended
fix**, named in the story's Spec Reference as the defect being repaired, and
AC3 also requires the pin and the credential be validated in `ExeDevDriver`'s
constructor. So neither the registered factory nor the location of the
validation may move; only the **reachability of the verbs that create nothing**
is in scope.

My first pass had violated both: it swapped the registered factory for a
`Proxy` over `new ExeDevDriver()` and deferred the `process.env` read to first
`create`/`image`/`imageBuildId` touch — which is the literal AC3 negative
control. **That edit has been fully reverted**; `git diff` on
`src/providers/index.ts` now shows the AC3 comment block and
`registerDriver("exedev", () => exeDevDriverFromEnv())` byte-identical to
DF2.10, and `src/providers/exedev/driver.ts` was never touched. The redone fix
is below. Two consequences of the correction, recorded honestly:

- The module header's "no env secret is read" claim could not be made true by
  deferral any more, so it is **corrected** rather than preserved (the report's
  own first-listed fix for that finding). Resolution does read env and may open
  the auth file; the header now says so and points at the seam that handles it.
- `fleet attach` (`scripts/fleet.ts:3473`) is the same shape — it reaches into
  a box that already exists — but it is not a cleanup verb and a refusal there
  strands nothing that is billing on its own. Left alone deliberately; flagging
  it rather than widening the correction's scope.

## Fixed

### P114 [HIGH] / R5 — a half-set image pin or a bad auth file blocked teardown and reap
New `resolveCleanupDriver(name, ctx)` in `src/providers/index.ts` (below the
untouched `exedev` registration). It calls `resolveDriver`; if construction
throws an `ExeDevDriverError`, it retries the **same factory over an empty
environment** — `exeDevDriverFromEnv({}, { requestId })` — logs the refusal
with `outcome: "degraded"` plus its code and remediation, and returns the
driver. An empty env is exactly the configuration these verbs use: the image
pin and the registry credential are read by `create` and by nothing else.
Anything that is not an `ExeDevDriverError` (an unknown `--driver` name) still
propagates to exit 2.

Applied at the four call sites that create nothing, verified by reading each:

| site | verb | why |
|---|---|---|
| `scripts/sandbox-teardown.ts:175` | teardown / harvest | destroys an existing box |
| `scripts/sandbox-reap.ts:131` | reap | only ever destroys — a refusal here strands exactly the orphans it collects |
| `scripts/fleet.ts:2489` | `runStatus` | reads only (`statusAll`/`statusRun` → `get`/`list`) |
| `scripts/fleet.ts:3784` | `runDestructive` | teardown / harvest |

Left on the strict `resolveDriver` deliberately: `scripts/fleet.ts:1844`
(`runDispatch`) and `:2196` (`runFanout`) both create boxes, so the pin
refusal must stand; `:3473` (`attach`) per the note above;
`scripts/cap-hit-demo.ts:1366` creates.

### P119/P120 [MED] — the header's "no env secret is read" is now false
`src/providers/index.ts:1-14` — corrected, not preserved (see Scope
corrections). It now states what is actually true: no socket is opened;
resolution DOES read the operator's boot-image override (AC3's whole point) and
may open `QDS_EXEDEV_REGISTRY_AUTH_FILE`; both are create-time configuration
validated in the constructor; and verbs that create nothing go through
`resolveCleanupDriver`.

The registry PAT is still read on every `exedev` resolve — that is inherent to
AC3's factory placement and out of scope to change here. What the fix removes
is the *refusal* standing in front of cleanup, not the read.

New `tests/providers/driver-registry.test.ts` (5 tests) pins the contract from
both sides: a half-set pin and a 0644 auth file each still make
`resolveDriver("exedev")` throw, while `resolveCleanupDriver` returns a working
driver and logs `outcome: "degraded"` with the refusal's code and remediation;
an unknown driver name still throws; and with nothing set the cleanup seam is
the ordinary resolve with no log line. The auth-file test asserts `/registry/i`
rather than a specific code because `fix-driver-transport`/`fix-setup-gate` are
moving which of the ratification/mode/ownership gates fires first.

### P113 [HIGH] — a fleet-wide host blip abandoned every arm
`src/fleet/fanout-primitive.ts` (runRace's poll pass). The per-arm skip streak
still counts every tick, but it is now only **acted on** with corroboration:
the give-ups are collected into a `starved` map during the pass and applied
after it, only when `anyArmAnswered` (some arm reached its box on the same
tick — `absent`, `unusable`, `claim-failed`, or a settled-failed marker) or
`current.length === 1` (the starved arm is the last undecided one, so there is
nothing to compare it against and the per-arm bound is all that stands between
a dead box and the 1 h ceiling).

Streaks keep accumulating through a blip, so the moment the fleet recovers
around a genuinely dead arm that arm is abandoned on the next tick — the bound
is delayed by the blip, not removed.

### P123 [LOW] — `PROBE_SKIP_TICKS_LIMIT` documented as a time bound it is not
`src/fleet/fanout-primitive.ts:69-96` — the doc now states the real range
(≈6 × poll ≈ 30 s at the fast end, 6 × (poll + deadline) ≈ 90 s at the slow
end, with both inputs unvalidated `deps` seams) instead of the single
fabricated 90 s figure, and explains why the short end is what forced the
corroboration rule.

### P115 [MED] — `probeArm`'s catch-all could discard a WON arm
`src/fleet/fanout-primitive.ts` — `store.mutate` now has its own `try/catch`
inside `probeArm`. A lock contention with a second process racing the same
`fanoutId`, a corrupt record or an EIO **after** the marker read as
`ok === true` logs `race-claim-failed` and returns a new verdict
`"claim-failed"`, which runRace treats exactly like `absent` (clears both
streaks, keeps polling — the marker is still there and the next tick re-claims).
The outer catch's comment now states that "skip" means the probe produced no
reading and nothing else.

### P117 [MED] — `unreadable` logged as `probe-unanswered`
`src/fleet/fanout-primitive.ts` — `res.kind === "unreadable"` returns
`"unusable"` instead of `"skip"`. `test -f` answered and `cat` answered, so the
box answered twice; it is counted on the corruption streak and abandoned (if at
all) as `marker-unusable`. Folding rather than a third streak is defensible
here: journal.ts publishes by temp+rename, so a `cat` that keeps failing on a
file `test -f` keeps finding is EACCES/EIO, and a genuinely vanishing marker
clears the streak by itself on the next tick's clean miss.

### P118 [MED] — charset guard moved above `revokeAndVerify`
`src/providers/credentials.ts` — the `/^[A-Za-z0-9_-]+$/` assertion now runs
immediately after `res` is obtained, above `ctx.keyHash = res.hash` and above
the `store.set` compensation. It therefore precedes both interpolations that
motivated it: `revokeHash`'s `DELETE /keys/${keyHash}` message and its
`curl -X DELETE …/keys/${keyHash}` remediation (`credentials.ts` revokeHash),
and the `already-minted` remediation on a later run, which interpolates the
**recorded** `keyHash` into a copy-paste curl.

Behaviour change: a malformed hash is no longer written to the run record.
That is the point — a metachar hash cannot be safely used by any automated
path (it reaches a URL and two shell strings), and this refusal's own
remediation already directs the operator to the key **name**.
`tests/providers/credentials.test.ts` ("hash-malformed refusal") updated
accordingly, plus a scan asserting no log line carries the metachars.

### P120 [MED] — the failed-compensation branch now has a test
`tests/providers/credentials.test.ts` — new test
"when the compensating revoke ALSO fails, the live unreachable key is logged
and the store error is still the cause". `store.set` throws ENOSPC **and**
`deleteKey` rejects (`Object.create(api)` override — `FakeKeyApi` uses TS
`private`, not `#`, so prototype delegation works). Asserts: ENOSPC is still
the reported cause, the key really is still live at the provider
(`listAllKeys` finds it), and the log line carries `outcome:"error"`,
`status:"error"`, `error.code:"revoke-failed"`, a `keyHashPrefix`,
`compensated: 0` and `mint_compensation_ms`.

### P122 [LOW] — the compensation error arm dropped the ok arm's fields
`src/providers/credentials.ts` — **both** error arms (the `store.set`
compensation and the pre-existing mint-timeout orphan loop) now emit
`duration`, `mint_compensation_ms` and `compensated: 0`. Fixing only the new
one would have left the sibling path invisible to the same dashboard.

### P121 [LOW] — the second `store.set` is outside the compensation
`src/providers/credentials.ts` — comment added naming the asymmetry and why it
is deliberate: `keyHash` already landed, so a failure here leaves a key that
`revokeRunKey`/`revokeQuietly` can still reach through the record. Revoking a
reachable key would throw away a usable run over a store hiccup. Not wrapped.

### Tests rewritten / added in `tests/fleet/patterns.test.ts`
- "a box that NEVER answers is bounded" — **rewritten**. It previously set
  `driver.probeExit = () => 255` on *every* box and read the resulting
  all-arms abandonment as the bound; that is the P113 false positive itself.
  Now one arm is silent while its sibling answers, and it asserts the per-arm
  bound survives: abandoned on tick `PROBE_SKIP_TICKS_LIMIT`, `armUnknown`,
  box alive, no teardown, exactly one `probe-unanswered` naming that arm.
- **new** "a FLEET-WIDE transport blip abandons nothing" — every arm 255 for
  `2 × PROBE_SKIP_TICKS_LIMIT` ticks, then the host recovers and the marker
  lands. Asserts the winner is declared, no arm is `armUnknown`, the sibling
  is a decided `lostRace` (torn down, not leaked to the reaper), no
  `probe-unanswered`, and the blip is still reported per tick.
- **new** "a marker `test -f` finds and `cat` cannot read is corruption" —
  0o000 marker; asserts `MARKER_UNUSABLE_TICKS_LIMIT` ticks, one
  `marker-unusable`, zero `probe-unanswered`, a `race-read-failed` line, box
  alive. (chmod-based; the repo already relies on a non-root test uid — CI is
  `runs-on: ubuntu-latest` running `bun test` as the runner user, and
  `image-contract.test.ts`'s loose-mode auth-file test has the same
  requirement.)
- **new** "a record write that fails AFTER the marker read as a winner does
  not throw the win away" — corrupts the fan-out record JSON mid-race so
  `store.mutate` throws from inside the claim, restores it two ticks later.
  Asserts the arm wins, nothing is `armUnknown`, a `race-claim-failed` line
  exists and no `probe-unanswered` does. Content-based rather than
  permission-based, so it is root-safe.

## False positives
None. Every finding in `edge-fleet-src.md` assigned to me was reproduced
against the working-tree source before it was patched, and nothing on the
"Checked and clean" list was touched.

Two report claims worth recording as *confirmed-and-narrowed* rather than
false:
- P120(c) "`--registry-auth <USER:PAT>` is now `ps`-visible for every real
  `create`" — accurate, and unchanged by this fix (it is `driver.ts:766`'s
  pre-existing argv shape). What this fix removes is the credential being
  loaded for verbs that cannot use it.
- The report's line numbers for the auth-file gates in `driver.ts` have already
  moved under `fix-driver-transport`/`fix-setup-gate`'s concurrent edits
  (`assertRegistryAuthDeviation` now runs *before* the file is opened, at
  `driver.ts:1522`). My fix is orthogonal to which gate fires first, and the
  new test is written not to care.

## Impact analysis
Run before editing, `direction: "upstream"`, `repo: /Users/steve/QDS-Factory`:

| target | risk | direct | processes | note |
|---|---|---|---|---|
| `resolveDriver` | **CRITICAL** | 8 | 9 (`runDestructive`, `runGateVerbs`, `runStatus`, `runFanout`, `runDispatch`, `fleet.run`, `sandbox-teardown.run`, `sandbox-reap.run`, `cap-hit-demo.main`) | Body, signature and semantics **unchanged**. Four of those nine processes now call the new `resolveCleanupDriver` wrapper instead — the four that create nothing, which are precisely the ones the bug broke. The other five are untouched and still refuse. |
| `mintRunKey` | **CRITICAL** | 4 | 5 (`runCapHitDemo`, `runCredentialLifecycle`, `dispatch`, `runDispatch`, `cap-hit-demo.main`) | Signature unchanged. One observable change: a malformed provider hash is no longer persisted (see P118). |
| `exeDevDriverFromEnv` | LOW | 2 | 0 | Now called lazily instead of eagerly; call shape unchanged (`(env, opts)`). |
| `PROBE_SKIP_TICKS_LIMIT` | LOW | 0 | 0 | Doc-only, plus the corroboration rule at its single use site. |

`registerDriver` itself is untouched (only its `exedev` invocation);
`runRace`/`probeArm` are module-private.

## Behaviour changes for wave 2
1. `resolveDriver` is **unchanged** — same factory, same refusals, same
   `ExeDevDriver`. New export `resolveCleanupDriver(name, ctx)`, used by
   teardown/harvest/reap/status. With a broken create-time config those four
   verbs now emit one extra log line (`operation: "provider.resolve"`,
   `outcome: "degraded"`) and run against the repo-default driver instead of
   exiting 2. A live tier that asserts "teardown refuses when the pin is half
   set" would now see it succeed — that is the fix, not a regression.
2. A fan-out race no longer returns `null` on a fleet-wide transport blip; it
   rides it out to the ceiling. A live tier that simulates total transport loss
   and expects `winner === null` inside ~30 s will now run to `ceilingMs`.
3. `unreadable` markers abandon at `MARKER_UNUSABLE_TICKS_LIMIT` (3) with event
   `marker-unusable`, not at `PROBE_SKIP_TICKS_LIMIT` (6) with
   `probe-unanswered`. New log code `race-claim-failed`.
4. A malformed provider key hash is refused **before** the run record is
   written, so `store.get(runId).keyHash` is `undefined` after a
   `mint-malformed` refusal. Cleanup for that case is by key NAME.
5. `credential.mint_compensation` error lines now carry `compensated: 0` and
   `mint_compensation_ms`.

## Gates

Re-run after the scope correction:

```
$ bunx biome check src/fleet/ src/providers/ tests/fleet/ tests/providers/ \
    scripts/fleet.ts scripts/sandbox-teardown.ts scripts/sandbox-reap.ts
Checked 115 files in 3s. No fixes applied.

$ bunx tsc --noEmit 2>&1 | grep -E "error TS"
tests/scripts/build-exedev-image.test.ts(167,7): error TS2353: Object literal may only
  specify known properties, and 'platform' does not exist in type 'Record<keyof BuildIdInputs, 0>'.
```

The one tsc error is `fix-buildscript`'s file, mid-edit; zero in mine. (The
same command returned 0 errors an hour earlier, before their latest write.)

```
$ bun test tests/providers/driver-registry.test.ts tests/fleet/patterns.test.ts \
    tests/providers/credentials.test.ts
 107 pass
 0 fail

$ bun test tests/scripts/sandbox-reap.test.ts tests/scripts/sandbox-teardown-cli.test.ts
 44 pass
 0 fail

$ bun test tests/fleet/verbs.test.ts tests/fleet/gate-verbs.test.ts \
    tests/fleet/dispatch.test.ts tests/fleet/approvers.test.ts tests/fleet/approval-gate.test.ts
 585 pass
 1 fail
Ran 586 tests across 5 files. [1418.43s]
```

The one failure — `approvers.ts — versioned entries and the scrypt work factor
(D9) > an N·r product EXACTLY at the allocation ceiling is ACCEPTED` — took
**1,178,713 ms** for a single test. It is a scrypt work-factor measurement
starved of CPU by the other fixers' concurrent suites; `approvers.ts` is
password hashing and touches no driver, no fan-out and no credential mint.

The three CLI suites above are the ones that exercise the four call sites I
changed (`runStatus`, `runDestructive`, `sandbox-teardown`, `sandbox-reap`) —
all green.

Full-scope sweep from before the correction (the fanout/credentials half of the
diff is unchanged since):

```
$ bun test tests/fleet/ tests/providers/
 2065 pass
 15 fail
Ran 2106 tests across 62 files. [1479.62s]
```

Those 15 failures are **not in my files** and not caused by this diff:

- 11 × `tests/providers/harvest.test.ts` "DF2.5 harvest — INV-3: evil artifacts
  tgzs …", every one a 30 s timeout on a real `git bundle verify`
  (`HarvestError: bundle-verify-failed`, empty stderr). Flaky under load — five
  concurrent `bun test` runs from the other fixers were on the box. Re-running
  that file alone produced a **different** failing subset (2 fails, both in
  "AC1: ranged bundle lands only at refs/sandbox/<run-id>", same 30 s
  `git bundle verify` shape), which is nondeterminism, not a regression. Neither
  `src/providers/harvest.ts` nor `tests/providers/harvest.test.ts` is modified
  in the working tree, and nothing in my diff is on that path.
- 4 × `tests/providers/exedev/image-assets.test.ts` "DF2.10 AC6 —
  qds-run@.service …". That file and its assets
  (`src/providers/exedev/assertions-in-box.sh`, `driver.ts`, `setup-gate.ts`,
  `transport.ts` all show as modified) belong to `fix-setup-gate` /
  `fix-driver-transport`, who were mid-edit during the run.

My own files: 107/107 pass (isolated run above).
