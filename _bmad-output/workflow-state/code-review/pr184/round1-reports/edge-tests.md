# PR #184 — Edge Case Hunt: test changes (`chunk-tests-unit.diff`, `chunk-tests-live.diff`)

Repo verified at `/Users/steve/QDS-Factory` (branch `feature/df2.10`). All line
numbers below are REAL file lines in that checkout, not diff offsets.

---

## [HIGH] The live test's `finally` can throw before it destroys the real box
- **File:** `/Users/steve/QDS-Factory/tests/fleet/e2e/tier1-image-contract.live.test.ts:382`
- **Trigger:** `revokeQuietly()` reads the run record OUTSIDE its own try (`/Users/steve/QDS-Factory/tests/fleet/e2e/live-harness.ts:484` — `const rec = store.get(runId);` sits before the `try`). If the record is missing, unreadable or malformed (the workspace was removed under it, a partial write, an ENOENT from a failed `store.create`), `store.get` throws straight out of the `finally` block. `destroyQuietly(ctx.driver, vm, evidence)` on line 386 then never runs — and neither does the evidence write.
- **Why it matters:** A real exe.dev box billing forever, on the failure path that most needs the forensic trail. Every sibling live test wraps this exact call in its own try/catch for precisely this reason, with the hazard spelled out in a comment: `/Users/steve/QDS-Factory/tests/fleet/e2e/tier1-approval-gate.live.test.ts:553-561` ("so a missing or malformed record throws straight out of this `finally` — killing the ledger close, the evidence write and the workspace cleanup") and `/Users/steve/QDS-Factory/tests/fleet/e2e/tier1-teardown.live.test.ts:169-175`. The new file is the only one that regressed the pattern. Destroy should also come FIRST (the box is the expensive leak; the key is capped at 50 000 µ$).
- **Verified:** Read the new file's `finally`, `revokeQuietly` in the harness, and both sibling live tests' guards.

## [HIGH] `deriveBuildId` — the function that mints the identity gate B enforces — has zero tests, and every gate-B assertion in the unit suite is a tautology
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:349` (untested); `/Users/steve/QDS-Factory/tests/providers/exedev/fixtures/fake-exedev.ts:43-54` (the tautology)
- **Trigger:** `DEFAULT_IMAGE_MARKER` imports `DEFAULT_IMAGE_BUILD_ID` from `driver.ts` and gate B compares the box's marker against `driver.imageBuildId`, which defaults to the same constant. Every "gate B passes" assertion therefore compares a constant with itself and is true for any value of that constant. Meanwhile nothing anywhere asserts a property of `deriveBuildId` itself: not that identical inputs produce identical ids, not that a changed Dockerfile / systemd unit / base digest / bun / pi version CHANGES the id, not that the length framing does what its docstring claims (`bun=1.3 pi=13.0` vs `bun=1.31 pi=3.0`).
- **Why it matters:** If `deriveBuildId` silently stopped folding in an input — say `systemdFiles` were dropped from the hash by a refactor — no test fails, and the publish workflow cannot catch it either, because the workflow's "pushed buildId == the repo pin" check (`.github/workflows/publish-exedev-image.yml:294-377`) computes both sides with the SAME function. Two different substrates would then claim the same identity, which the function's own docstring calls "the one thing this value exists to prevent." A five-line pure-function test (one fixed vector + one one-field-changed pair per input) would close it.
- **Verified:** Read `deriveBuildId` and its inputs; grepped `tests/` for `deriveBuildId` (zero hits); read the fake's `DEFAULT_IMAGE_MARKER` and `setup-gate.ts:441`.

## [HIGH] Nothing couples `PI_VERSION` to `PI_REVIEWED_SERIES` — the AC2 alarm can go stale while CI stays green
- **File:** `/Users/steve/QDS-Factory/tests/providers/exedev/setup-gate.test.ts:857` (hard-coded stub); `/Users/steve/QDS-Factory/src/providers/exedev/assertions-in-box.sh:189`; `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:152`; `/Users/steve/QDS-Factory/oci/exedev/Dockerfile:99`
- **Trigger:** Bump `PI_VERSION` to `0.85.0` in the build script and the Dockerfile, and forget `PI_REVIEWED_SERIES="0.84"` in `assertions-in-box.sh`. The F14 tolerance test at `setup-gate.test.ts:943` keeps passing because its pi stub prints the literal `"0.84.4"`, and the new AC2 test at `:989` keeps passing because its stub prints `"0.99.0"`. Both are green. Every REAL box now runs 0.85.0, so `series != reviewed` fires and D refuses on every box in production.
- **Why it matters:** This is the exact failure DF2.10 AC2 exists to prevent — an unreviewed runtime inheriting or losing a tolerance — and the test that is supposed to be the alarm is deaf to it because the version is re-typed as a literal instead of derived from the pin. `PI_VERSION` is already exported (`build-exedev-image.ts:152`), so the stub can print it and one assertion can pin `PI_REVIEWED_SERIES === PI_VERSION.split(".").slice(0,2).join(".")`. Four independent copies of this version exist today: build script, Dockerfile ARG, shell script's reviewed series, and the fake's marker (`fake-exedev.ts:105`); no test compares any pair.
- **Verified:** Read all four literals and both shell-script tests.

## [HIGH] The production credential path (`QDS_EXEDEV_REGISTRY_AUTH_FILE`) and the buildId override have zero coverage anywhere in the repo
- **File:** `/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:1009-1037`; only `QDS_EXEDEV_IMAGE` is touched, at `/Users/steve/QDS-Factory/tests/providers/exedev/image-contract.test.ts:234-241`
- **Trigger:** `src/providers/index.ts:138` registers the production driver as `exeDevDriverFromEnv()`. That function reads three env vars. Grepping `tests/ src/ scripts/` for `QDS_EXEDEV_REGISTRY_AUTH_FILE`, `QDS_EXEDEV_IMAGE_BUILD_ID` and `registry-auth-unreadable` returns hits ONLY in `driver.ts` itself. Uncovered branches, named: (a) the `readFileSync` success path and its `raw.trim()` newline strip — nothing proves a credential file with a trailing newline does not carry `\n` into ssh argv; (b) the `registry-auth-unreadable` throw at line 1022; (c) the `QDS_EXEDEV_IMAGE_BUILD_ID` override at line 1014.
- **Why it matters:** The whole `describe("DF2.10 AC4 — the registry credential is a separate class")` block proves properties of a credential that was hand-injected into the constructor, and never touches the only path production uses to LOAD one. Also uncovered because untested and unimplemented: the credential file's MODE is never checked (a world-readable 0644 PAT is accepted silently), even though the option's own docstring says "from a 0600 host file". And `QDS_EXEDEV_IMAGE_BUILD_ID` accepts any string with no validation — an operator who sets it to whatever a box reports disables INV-IBOX-2 entirely, with no test asserting either the honoring or the hazard.
- **Verified:** Read `exeDevDriverFromEnv` and `src/providers/index.ts:138`; grepped the whole repo for the two env names.

## [MEDIUM] `imageMarkerFailure`'s `unreadable` and `oversized` arms are unreachable through the fake and untested
- **File:** `/Users/steve/QDS-Factory/src/providers/exedev/transport.ts:247` and `:250`; fake at `/Users/steve/QDS-Factory/tests/providers/exedev/fixtures/fake-exedev.ts:638-651`
- **Trigger:** The fake derives BOTH the `test -f` exit and the `cat` exit from a single `marker === null`. There is no configuration in which `test -f` succeeds and `cat` fails, so `{kind:"unreadable"}` can never be produced — yet that is a reachable production state and precisely the one gate B exists for: a box that booted a NON-factory image may have `/etc/qds-image.json` as a root-only 0600 file (our Dockerfile chmods 0644, a foreign image need not) — `test -f` passes without read permission, `cat` exits 1. Likewise `{kind:"oversized"}` (`read.truncated`, i.e. over `EXEC_MAX_OUTPUT_BYTES`) is unreachable because the fake never sets `truncated`. The suite's "over-cap" case (`image-contract.test.ts:571`) exercises the DIFFERENT `content.length > IMAGE_MARKER_MAX_BYTES` branch, and its `why: /cap|bytes/i` regex matches both messages, so it does not even distinguish them.
- **Why it matters:** Two of the five fail-closed arms of the function that is the whole of INV-IBOX-2's in-box half ship unproven. `imageMarkerFailure` is a pure function of `(BoxFileRead, string)` — `tests/providers/exedev/read-box-file.test.ts` already shows the two-line `driverOf` pattern that would cover all five arms directly.
- **Verified:** Read `imageMarkerFailure`, the fake's interceptor, and the existing `read-box-file.test.ts`.

## [MEDIUM] Gate B's marker read can THROW out of `setup()`, and no test covers it — the "payload, never a throw" claim is unverified for the transport path
- **File:** `/Users/steve/QDS-Factory/src/providers/exedev/setup-gate.ts:440`
- **Trigger:** `readBoxFile` bounds both of its commands with `withTimeout(..., deadlineMs, "race-probe"/"race-read")`, which REJECTS with `TimeoutError` on expiry (`src/providers/timeout.ts:52`). Line 440 is not wrapped in try/catch, and `ExeDevDriver.setup` is a bare `return setupGate(this, vm, opts)` (`driver.ts:846`). A box that accepts the ssh connection but is slow to answer (the ordinary boot-race case this gate runs into) makes `driver.setup()` REJECT instead of returning `{ready:false, failedItem:"B", assertionCode:1}`.
- **Why it matters:** `image-contract.test.ts:568-604` asserts the payload discipline for six CONTENT failures and none for a transport failure — and the fake's marker interceptor returns synchronously, bypassing `spawnLocal` entirely, so a hang cannot be expressed at all. Callers keying on `assertionCode` (dispatch's 1|2|3|4 table) get an exception they do not handle, on a live box.
- **Verified:** Read `setup-gate.ts:419-474`, `withTimeout`, `driver.ts:846`, and the fake's interceptor (no timeout modelling).

## [MEDIUM] The live test can leak a minted OpenRouter key: the revoke is gated on a local variable, not on the record
- **File:** `/Users/steve/QDS-Factory/tests/fleet/e2e/tier1-image-contract.live.test.ts:291-292` and `:382`
- **Trigger:** `mintRunKey` persists `keyHash` into the run record BEFORE it can still throw — `src/providers/credentials.ts:351` (`deps.store.set(runId, { keyHash: res.hash })`) precedes the malformed-hash refusal at `:353` and the over-grant refusal after it. In that window a live provisioned key exists and is recorded, but `mintedHash` is still `""`, so the `finally`'s `mintedHash !== ""` guard skips `revokeQuietly` — which would otherwise have found the key via `store.get(runId).keyHash` and revoked it.
- **Why it matters:** `revokeQuietly` already no-ops when the record carries no keyHash (`live-harness.ts:485`), so the `mintedHash` half of the guard buys nothing and costs a leaked live credential. Gate on `store !== undefined` alone.
- **Verified:** Read `mintRunKey`'s ordering and `revokeQuietly`.

## [MEDIUM] `default-off` is vacuous when `create()` fails — three assertions that all hold on an empty call log
- **File:** `/Users/steve/QDS-Factory/tests/providers/exedev/image-contract.test.ts:370-385`
- **Trigger:** `captureLog` SWALLOWS the thrown error (returns `{error, lines}`) and this test never inspects `error`. If `create()` threw for any reason, `newArgv(fake)` returns `[]` → `expect([]).not.toContain("--registry-auth")` passes; `fake.creates` is empty → `fake.creates[0]?.registryAuth` is `undefined` → `toBeUndefined()` passes; the emitted lines still contain `create_requested` + `create_failed`, both carrying `registryAuthUsed: false` → the loop passes and `creates.length > 0` passes.
- **Why it matters:** The one test that proves the default-off posture is satisfiable by a driver that cannot create a box at all. The sibling test at `:325` is safe only because it asserts `fake.creates[0]?.registryAuth).toBe(VALID_AUTH)`. Add `expect(fake.creates).toEqual([{name:"df210-auth-off", image: PINNED}])`, or make `captureLog` rethrow when the caller does not ask for the error.
- **Verified:** Read `captureLog` (`:39-52`), `newArgv` (`:34`), and the test.

## [MEDIUM] Redaction is exact-full-string only; the test only exercises the one echo shape that redaction handles
- **File:** `/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:438-441`; test at `/Users/steve/QDS-Factory/tests/providers/exedev/image-contract.test.ts:387-419`
- **Trigger:** `redactRegistryAuth` does `text.split(this.registryAuth).join(...)` — it only matches the literal `USERNAME:PASSWORD` string. The test's `leaky` seam echoes exactly that (`--registry-auth ${VALID_AUTH}`), so the assertions `err.message.includes(CANARY_SECRET) === false` and `toContain("[registry-auth redacted]")` both pass. A substrate that echoes only the password half (`unknown credential "ghp-LEAKCANARY-…"`), or wraps/escapes/percent-encodes it, or splits it across a truncated stderr boundary, leaks the secret into a thrown, logged error — and no test covers any of those shapes.
- **Why it matters:** INV-IBOX-3's whole claim is that the credential never reaches a log. The measured hazard the test names ("a control plane that echoes the argv it received") is asserted in exactly one spelling. Redacting the PASSWORD substring as well (`secret` half) would cover all of them and is a one-line change.
- **Verified:** Read `redactRegistryAuth` and the leak test.

## [MEDIUM] The bun pin test guards the URL charset but not the pin's coupling to the Dockerfile
- **File:** `/Users/steve/QDS-Factory/tests/scripts/exedev-bun-pin.test.ts:32-36`; `/Users/steve/QDS-Factory/oci/exedev/Dockerfile:70` and `:76`
- **Trigger:** `scripts/build-exedev-image.ts:966` passes `--build-arg BUN_VERSION=<from package.json>` but NEVER passes `BUN_SHA256`. The Dockerfile's `ARG BUN_SHA256=79c0771…` default is pinned to the CURRENT bun. Bump `packageManager` in `package.json` (dependabot does this on a schedule) and the build downloads bun N+1 and verifies it against bun N's checksum — a hard failure ten QEMU-emulated minutes in. The new test asserts only that the captured version is URL-safe.
- **Why it matters:** The test file's own docstring reasons about exactly this hazard class ("it produces a 404 mid-build, ten QEMU-emulated minutes in") and then guards only half of it. One assertion — `readBunPin(package.json)` equals the Dockerfile's `ARG BUN_VERSION` default — turns a ten-minute remote failure into a one-second local one, and makes the stale-`BUN_SHA256` pairing visible.
- **Verified:** Grepped `--build-arg` in the build script (no `BUN_SHA256`); read the Dockerfile's ARG block.

## [MEDIUM] Five of the six exported functions in the new 1 214-line build script have no tests
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:378` (`parseBaseRefs`), `:599` (`nodeModulesRoot`), `:751` (`validateBinaryLicenses`), `:838` (`uncoveredBinaries`), `:349` (`deriveBuildId`, above). Only `readBunPin` is covered.
- **Trigger:** Named uncovered branches: `parseBaseRefs` never looks at `COPY --from=<external image>` — a foreign image copied into the build contributes bytes to the substrate and NOTHING to the buildId. (Today's Dockerfile has one `FROM` and no `COPY --from`, so the entire multi-stage/`scratch`/stage-name-shadowing logic in that function is dead code with no test and no consumer.) `validateBinaryLicenses` and `uncoveredBinaries` gate the NOTICE/licence sweep with `die(1, …)`; their accepting AND rejecting shapes are unproven.
- **Why it matters:** These are pure functions over strings — the cheapest possible tests — sitting on the path that decides what the published image contains and what identity it claims. The test file's own rationale ("every rejecting path in this module calls `die()`, which is `process.exit`") explains why the rejecting paths are skipped but not why the ACCEPTING paths of the other four are.
- **Verified:** Grepped `tests/` for all five names (only `readBunPin` hits); read `parseBaseRefs`; grepped the Dockerfile for `FROM`/`COPY --from`.

## [MEDIUM] The round-4 timing regression test got two more seam calls and kept the same 1 050 ms margin
- **File:** `/Users/steve/QDS-Factory/tests/providers/exedev/setup-gate.test.ts:710-756`
- **Trigger:** The budget moved 4 550 → 5 550 ms for 7 → 9 taxed calls, leaving the same ~1 050 ms of headroom to absorb the REAL execution time of two more calls plus git spawns. On a loaded runner, if consumed time exceeds 5 550 ms the phase guard refuses C/D/E, `seen.find(c => c.gateScript)` is `undefined`, and `expect(gateCall).toBeDefined()` fails — a flake, not a defect report. If it instead lands above 1 000 ms remaining, `toBeLessThan(1_000)` fails.
- **Why it matters:** This is the regression test for a real INV-2 spend-past-budget bug; a flaky version of it gets quarantined, and the guard goes with it. The instrument is the per-call tax, so widening the tax (e.g. 500 → 900 ms with a proportionally larger budget) restores the same window with more absolute slack.
- **Verified:** Read the test and counted the seam calls in `setup-gate.ts` (3 provisioning + 2 A + 2 marker + 2 pi = 9).

## [LOW] The live test never runs in CI — say so out loud
- **File:** `/Users/steve/QDS-Factory/tests/fleet/e2e/live-harness.ts:73`; `.github/workflows/ci.yml:73`
- **Trigger:** `liveTodoOff()` is `process.env.QDS_E2E_LIVE !== "1"`, and CI runs a bare `bun test` with `QDS_E2E_LIVE` unset anywhere in `.github/workflows/`. `test.todoIf(true)` marks the whole file todo and its body never executes.
- **Why it matters:** By design, but it means AC1 (systemd/PID 1/login user), AC2 (in-box bun/pi pins), AC6 (the reboot proof) and the only NON-tautological check of `DEFAULT_IMAGE_BUILD_ID` against a real box are operator-run only. Combined with the publish workflow having no `pull_request` trigger (`.github/workflows/publish-exedev-image.yml:33-49` — `workflow_dispatch` + push to main/dev only), a PR that edits `oci/exedev/Dockerfile` without re-publishing is green on every automated gate; the alarm fires post-merge on `dev`.
- **Verified:** Read the harness gate, `ci.yml`, and the publish workflow triggers.

## [LOW] Vacuous marker-shape assertions in both suites
- **File:** `/Users/steve/QDS-Factory/tests/providers/exedev/image-contract.test.ts:469-473`; `/Users/steve/QDS-Factory/tests/fleet/e2e/tier1-image-contract.live.test.ts:234-268`
- **Trigger:** `parseImageMarker` constructs and returns an object LITERAL of exactly six keys and refuses any input whose six fields are not non-empty strings (`transport.ts:218-229`). So `expect(Object.keys(marker).sort()).toEqual([six])`, `expect(Object.keys(marker).length).toBe(6)`, the live test's "all six non-empty" loop, and `expect(marker.bunVersion.length).toBeGreaterThan(0)` / `marker.piVersion.length > 0` are all true for EVERY input the parser does not throw on. They cannot fail.
- **Why it matters:** Not harmful, but the live test's comment claims the non-empty checks guard "an empty marker field equal to an empty in-box read" — a hazard the parser already eliminated. The real assertions in that block are `bunObserved === marker.bunVersion` and `piObserved === marker.piVersion`, and `piObserved` genuinely can be `""` (the regex `?.[0] ?? ""` on unexpected output), which the `piObserved.length > 0` check DOES catch. Keep that one, drop the rest.
- **Verified:** Read `parseImageMarker` against both assertion blocks.

## [LOW] `assertRegistryAuth`'s 512-byte rule is the one refusal arm with no test
- **File:** `/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:329`
- **Trigger:** The refusal table at `image-contract.test.ts:275-286` covers no-separator, empty password, whitespace, tab, control char, shell metachar, command substitution, bad username, empty username — nine arms. `secret.length > 512` is the tenth and is absent.
- **Why it matters:** It is the only length bound on a value that gets concatenated into an ssh remote command line; a regression that dropped it would be invisible. One row in the existing table.
- **Verified:** Compared the source's refusal arms against the test table.

## [LOW] Nothing pins the deliberate decision that `imageRef` is NOT compared
- **File:** `/Users/steve/QDS-Factory/src/providers/exedev/transport.ts:262`
- **Trigger:** `imageMarkerFailure` compares only `buildId`; `marker.imageRef` is used solely in the failure message. The tenant test (`image-contract.test.ts:623`) supplies a marker whose `imageRef` MATCHES the driver's image, so no test distinguishes "imageRef ignored" from "imageRef compared". A box whose marker says `imageRef: "ghcr.io/attacker/x"` with a matching buildId passes gate B, and a future tightening that compared `imageRef` would break the D7 tenant-mirror case with no test to say so.
- **Why it matters:** The non-comparison is a considered decision (a mirrored image keeps the digest but not the ref) that no test records. One case in the fail-closed loop with a mismatched `imageRef` and a correct `buildId`, asserted PASSING, makes the decision executable.
- **Verified:** Read `imageMarkerFailure` and the tenant test's marker patch.

## [LOW] Marker cap: the live test is one byte stricter than the gate
- **File:** `/Users/steve/QDS-Factory/tests/fleet/e2e/tier1-image-contract.live.test.ts:225` vs `/Users/steve/QDS-Factory/src/providers/exedev/transport.ts:253`
- **Trigger:** The gate refuses at `content.length > 4096` (4096 exactly is accepted); the live test asserts `toBeLessThan(4096)` (4096 exactly fails); the Dockerfile asserts `-lt 4096` (matches the live test). Three places, two rules.
- **Why it matters:** Harmless today (the built marker is ~154 bytes) but a marker that grew to exactly 4096 would be accepted by the gate and rejected by the build and by the live test. Pick `>=` or `>` once.
- **Verified:** Read all three checks.

## [LOW] The new AC2 shell test inherits the host environment wholesale, including `OPENROUTER_API_KEY`
- **File:** `/Users/steve/QDS-Factory/tests/providers/exedev/setup-gate.test.ts:1014` (`env: { ...process.env, PATH: …, HOME: … }`)
- **Trigger:** The fake substrate deliberately nulls `OPENROUTER_API_KEY` before every in-box exec (`fake-exedev.ts:446`) with the rationale "a leaked host OPENROUTER_API_KEY would let E pass without DF2.3's delivery file, masking a missing-key bug as a green gate." The new AC2 test (and the F14 test it was copied from) spawns `assertions-in-box.sh` with the host env intact.
- **Why it matters:** Does not affect today's assertion (the script exits 3 at D before E), but it is the same unfaithful-double class the fake spends a comment forbidding, and it silently changes what this test proves the moment its scope reaches E.
- **Verified:** Compared the spawn env in both shell tests against `spawnLocal`'s env in the fake.

## [LOW] The image-reference grammar's rejections of legitimate tenant refs are untested in either direction
- **File:** `/Users/steve/QDS-Factory/src/providers/exedev/driver.ts:283-284`
- **Trigger:** `IMAGE_REF_RE`'s path component is `[a-z0-9]`-only, so an uppercase repository path (`harbor.acme.internal/QDS/img@sha256:…`) is refused; and the host alternation requires a dot or literal `localhost`, so a dotless host with a port (`registry:5000/img:tag`, valid to Docker) is refused. The accept list at `image-contract.test.ts:115-126` and the refuse list at `:128-158` cover neither case, so both behaviours are unpinned.
- **Why it matters:** The D7 "customer's own registry" tier is the stated reason the grammar admits mirrors, and it is proven against exactly one lowercase dotted Harbor host. Whichever way these two should go, a test should say so before a tenant discovers it.
- **Verified:** Read the regex and both test tables.

## [LOW] The fake's `new` grammar is itself unverified against exe.dev, and the only test that would catch a wrong flag name never runs in CI
- **File:** `/Users/steve/QDS-Factory/tests/providers/exedev/fixtures/fake-exedev.ts:506`
- **Trigger:** The anchored matcher is an excellent drift detector for the DRIVER, but it encodes the same assumption the driver does — that the flags are `--image` and `--registry-auth`, in that position. If exe.dev's actual flag is `--from-image`, the fake accepts, `creates` records it, every unit assertion passes, and the only thing that would notice is `tier1-image-contract.live.test.ts`, which is todo-gated out of CI (see above). `driver.ts:525` already flags the `new` RESPONSE shape as UNVERIFIED for the same reason.
- **Why it matters:** Not fixable at the unit layer — worth recording as a known limit of what the unit suite proves about AC3, so the live run is treated as required evidence rather than optional.
- **Verified:** Read the fake's matcher, the driver's argv construction, and the live gate.
