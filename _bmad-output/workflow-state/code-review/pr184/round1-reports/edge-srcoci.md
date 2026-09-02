# Edge-case hunt — PR #184, chunks `src` + `oci`

Scope: `src/providers/exedev/{driver,setup-gate,transport}.ts`, `src/providers/index.ts`,
`src/providers/exedev/assertions-in-box.sh`, `oci/exedev/{Dockerfile,binary-licenses.json,systemd/*}`.
Only unhandled paths and real cross-file inconsistencies below.

---

## [HIGH] Gate B0 can THROW out of `setupGate`, breaking the "failure RETURNS a payload" contract and downgrading dispatch's exit-3 to exit-1

- **File:** `src/providers/exedev/setup-gate.ts:440` (call), `src/providers/exedev/transport.ts:129` and `:137` (the throwing `withTimeout`), `src/providers/timeout.ts:46-56`
- **Trigger:** B0 calls `readBoxFile(driver, vm, IMAGE_MARKER_PATH, budgetFree())`. `readBoxFile` bounds each of its two execs with `withTimeout(...)`, which **rejects with `TimeoutError`** — it does not return a value. `budgetFree()` (setup-gate.ts:355) has a **1000 ms floor**, so once the whole-gate deadline is nearly consumed (e.g. 50 ms left, which passes the `Date.now() >= deadline` check at :422), B0 gets a 1 s budget for two round-trip ssh calls. One slow box, one slow network, or a box that hangs on `test -f` and B0 rejects. Nothing between :440 and the caller catches it.
- **Why it matters:** Every *other* gate assertion uses `driver.execTimed(...)` (driver.ts:820), which passes the budget down to `Bun.spawn({timeout})` and **returns a non-zero `ExecResult`** — it never throws. B0 is the only step in the gate that can reject. The in-code comment at setup-gate.ts:444-449 explicitly claims "never a throw", and the module header at :28-31 claims failure "RETURNS `{ready:false, failedItem, assertionCode, assertions[]}`". A rejection escapes past the result assembly, so `src/fleet/dispatch.ts:2905` never gets a result object; the throw lands in the outer catch and becomes **exit-1 `dispatch-failed`** instead of the exit-3 gate refusal — the exact regression dispatch.ts:2911-2917 documents having already fixed once for a different unguarded read. The run record's `extensions.gate` block (dispatch.ts:2952-2963) is never written either, so `fleet status` shows no gate outcome.
- **Verified:** read `withTimeout` (`src/providers/timeout.ts:46`) — rejects, does not resolve; read `sshCommand` (`transport.ts:48-85`) — a timeout is a SIGKILL and a non-zero `exitCode`, never a rejection, confirming the asymmetry; read `setupGate` :419-474 for the absence of a try/catch; read `dispatch.ts:2896-2970` for what the caller does with a non-object/thrown result.

---

## [HIGH] B0 reports an ssh transport failure as "this box did not boot a factory image"

- **File:** `src/providers/exedev/transport.ts:130` (the `absent` arm) → `transport.ts:244-246` (the message)
- **Trigger:** `readBoxFile` returns `{kind:"absent"}` whenever the presence probe `sh -c 'test -f /etc/qds-image.json'` exits non-zero. That includes **ssh exit 255** (connection never came up / dropped mid-flight) and **exit 137** (SIGKILL from the exec budget), not only "the file is not there".
- **Why it matters:** The resulting gate note is a definitive claim about image identity — *"is absent — this box did not boot a factory image (INV-IBOX-2…)"* — asserted from evidence that cannot support it. The operator is sent to audit the image pin for what is a network fault. This driver already knows the distinction: `steeringProvisionFailure` (driver.ts:130-154) branches on exactly 137 and 255 precisely because "conflating a transport fault with a substrate finding sends the operator to audit the wrong thing". B0 re-introduces the conflation the sibling code was written to avoid. It is fail-closed, so no bad box ships — but the diagnosis is wrong and the box is condemned for the wrong reason.
- **Verified:** read `readBoxFile` (transport.ts:123-148) — no exit-code classification on the probe; read `EXEC_KILLED_EXIT` / `EXEC_TRANSPORT_EXIT` (driver.ts:113-114) and `steeringProvisionFailure` for the existing precedent.

---

## [MEDIUM] `QDS_EXEDEV_IMAGE` can be set without `QDS_EXEDEV_IMAGE_BUILD_ID` — every box then fails gate B

- **File:** `src/providers/exedev/driver.ts:1009-1040` (`exeDevDriverFromEnv`), `driver.ts:401-403` (constructor)
- **Trigger:** The two env vars are read and spread **independently** (`...(image === undefined || image.length === 0 ? {} : { image })` / same for `buildId`). An operator who sets only `QDS_EXEDEV_IMAGE` — the obvious single-knob action for "boot my mirror" — gets `image = <their ref>` paired with `imageBuildId = DEFAULT_IMAGE_BUILD_ID`. Gate B0 then compares the mirror's marker `buildId` against this repo's pin and refuses **every** box with `buildId "…" != the repo pin "664876fb1a9128ec"`.
- **Why it matters:** The two values are only ever meaningful as a pair — driver.ts:255-265 says so ("the two are only ever recorded as a pair", "the repo pin and its buildId pair must be re-recorded together", Dockerfile:56). Nothing enforces it. The constructor validates `image` at the trust boundary but does not check the pairing, so the failure surfaces per-box, at gate time, after the box was created and paid for, with a message that reads as "your image is wrong" rather than "you set one of two required vars". The inverse (buildId only) is equally silent.
- **Verified:** read `exeDevDriverFromEnv` at driver.ts:1009-1040 and the constructor at :399-409; `image-contract.test.ts:629` is the only place both are set together, and it sets them by hand.

---

## [MEDIUM] The registry-credential file's mode is documented as 0600 and never checked

- **File:** `src/providers/exedev/driver.ts:1016-1027`
- **Trigger:** `QDS_EXEDEV_REGISTRY_AUTH_FILE=/path/to/creds` where the file is 0644 (or 0666, or group-readable). `readFileSync` succeeds, `raw.trim()` becomes the credential, the driver constructs, and the run proceeds.
- **Why it matters:** The whole design rationale at driver.ts:1002-1007 is that the *env var is a path precisely because a value would leak via `/proc/<pid>/environ`* — the security property being bought is "the secret lives in a 0600 file". The doc comment and the remediation string (`"point it at a 0600 file containing USERNAME:PASSWORD"`) both assert the mode; nothing verifies it. This is a trust-boundary check that is claimed and not made, on the one path in this story that handles a real credential (INV-IBOX-3). A one-line `statSync(authFile).mode & 0o077` refusal closes it.
- **Verified:** read driver.ts:1009-1040 — only `readFileSync` in a try/catch; no `statSync`, no mode check anywhere in the module (`grep -n "statSync\|mode &" src/providers/exedev/driver.ts` → nothing).

---

## [MEDIUM] B0 is the only gate step whose underlying ssh is not bounded by the gate budget, and it spends 2× the per-assertion budget

- **File:** `src/providers/exedev/setup-gate.ts:440`, `src/providers/exedev/transport.ts:129,137`, `src/providers/exedev/driver.ts:806-817`
- **Trigger:** `readBoxFile` calls `driver.exec` (not `execTimed`). `exec` hard-codes `timeoutMs: this.execTimeoutMs` = `DEFAULT_EXEC_TIMEOUT_MS` = **120 000 ms** (transport.ts:41) for the spawned ssh, and `withTimeout` layers `budgetFree()` on top. `withTimeout` **abandons** rather than cancels (`src/providers/driver.ts:689` documents this for the sibling case), so on a B0 timeout the ssh keeps running against the box for up to 120 s with its output discarded, and the gate has no handle on it.
- **Why it matters:** Two separate budget breaks. (a) `readBoxFile` passes the *same* `deadlineMs` to each of its two calls, so B0 can burn `2 × budgetFree()` where every other assertion burns one — the whole-gate `deadline` accounting at setup-gate.ts:355 assumes one budget per call. (b) The per-assertion budget is advisory only for B0: the process itself is killed at 120 s, not at the gate budget, which is the property `execTimed` exists to provide.
- **Verified:** compared `exec` (driver.ts:806, fixed `this.execTimeoutMs`) against `execTimed` (driver.ts:820, caller-supplied `timeoutMs`); read `readBoxFile`'s two `withTimeout(..., deadlineMs, ...)` calls.

---

## [MEDIUM] `PI_REVIEWED_SERIES` duplicates the pinned `PI_VERSION` with no static binding — and the refusal only fires after paid assertions

- **File:** `src/providers/exedev/assertions-in-box.sh:189` (`PI_REVIEWED_SERIES="0.84"`), vs `oci/exedev/Dockerfile:99` (`ARG PI_VERSION=0.84.4`) and `scripts/build-exedev-image.ts:152` (`export const PI_VERSION = "0.84.4"`)
- **Trigger:** Bump `PI_VERSION` to 0.85.x in the build script and the Dockerfile. Nothing in CI, no unit test, and no build step compares those to `PI_REVIEWED_SERIES`. The mismatch is detected only on a live box, inside assertion D.
- **Why it matters:** Two problems. (a) The design claim at assertions-in-box.sh:186-188 — *"Bump PI_VERSION without revisiting it and the mismatch below IS the refusal"* — is true only at run time, on a real box, once per box, forever, rather than once at build/CI where a version bump is actually reviewed. (b) The refusal fires **after** the paid work: `d_resp`/`d_total` (a real `pi -p` LLM call, assertions-in-box.sh:~150-175) and assertion C's live pings both run first. So a forgotten constant costs real spend on every box in the fleet before refusing, which is the ordering INV-2 ("no spend past budget", spend-ordering) exists to prevent. The version-conditional check is pure string comparison and could run before any spend.
- **Verified:** `grep -rn "PI_REVIEWED_SERIES"` across the repo → only assertions-in-box.sh:189/:234 and a *behavioural* test (`tests/providers/exedev/setup-gate.test.ts:989-1010`, which stubs `pi --version` at 0.99.0). No test or script binds the constant to `PI_VERSION`; read `scripts/build-exedev-image.ts:152` and Dockerfile:99 for the two other copies.

---

## [MEDIUM] The `dp:ok` suppression on `readBoxFile` now asserts something false

- **File:** `src/providers/exedev/transport.ts:128`
- **Trigger:** The suppression reads `// dp:ok sole caller probeArm (fanout-primitive.ts:738) wraps the call in try/catch and records a skipped tick`. This PR adds a **second** caller (setup-gate.ts:440) that does *not* wrap it in try/catch.
- **Why it matters:** The justification is the only record of why the function is allowed to reject, and it is now wrong in both halves ("sole caller", "wraps in try/catch"). Anyone auditing the rejection path reads a reassurance that no longer holds — this is the paperwork half of the HIGH finding above, and the reason that bug is easy to miss on review.
- **Verified:** `grep -rn "readBoxFile" --include=*.ts src/` → `transport.ts:123` (def), `fanout-primitive.ts` (the documented caller), `setup-gate.ts:440` (new). No `dp:` checker script exists in `scripts/`, so nothing mechanically catches the stale claim.

---

## [LOW] `imageFields()` claims to be the single accessor, but two of the three image events bypass it — and `create_failed` drops `imageDigest`

- **File:** `src/providers/exedev/driver.ts:450-456` (accessor), `:492-497` (`create_requested`), `:514-518` (`create_failed`)
- **Trigger:** Any create. `create_shape` uses `...this.imageFields()`; `create_requested` and `create_failed` re-inline `imageRef` / `registryAuthUsed` by hand.
- **Why it matters:** The accessor's own doc says it exists "so no call site can forget one". Two of three call sites already forgot: `create_failed` emits `imageRef` but **not** `imageDigest`, so the one event an operator joins on when a box fails to boot from a bad pin is the one missing the digest join key. Also note `emitGate(…, "marker_assert", …)` (setup-gate.ts:442) uses an `item` outside the `gate_a`/`gate_b`/`gate_cde` naming every other gate line uses, producing a `marker_assert_ms` field (setup-gate.ts:280) that no `gate_*` filter will pick up.
- **Verified:** read driver.ts:450-456, :492-497, :514-518 and `emitGate` at setup-gate.ts:259-282.

---

## [LOW] `assertRegistryAuth`'s metacharacter denylist omits `#`

- **File:** `src/providers/exedev/driver.ts:337`
- **Trigger:** A registry password containing `#`. It passes every rule; `control()` (driver.ts:~425) passes it as a bare argv element to local `ssh`, which **concatenates argv into one remote command line** — so the remote shell sees `… --registry-auth pa#ss --json` and truncates at the `#`, silently discarding `--json`.
- **Why it matters:** Not an injection (the dangerous set — `$ ` \` ; & | < > ( ) whitespace, control chars — is covered), but the create then returns a non-JSON body and dies as `new-unparseable` (driver.ts:947-958), pointing the operator at exe.dev's response shape rather than at their password. `%` and `,` are likewise absent but harmless. Adding `#` to the class at :337 is the whole fix.
- **Verified:** read `assertRegistryAuth` (driver.ts:315-338), `control` (driver.ts:~425, `this.run(["ssh","exe.dev",...sub])` with no quoting of `sub`), and `parseJson` (driver.ts:947).

---

## [LOW] `imageBuildId` is the only new constructor option with no validation

- **File:** `src/providers/exedev/driver.ts:403`
- **Trigger:** `new ExeDevDriver({ imageBuildId: "" })` or `exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE_BUILD_ID: " " })` (a whitespace-only value is non-empty, so the length guard at :1036 admits it).
- **Why it matters:** The block's own comment at :396-399 says "**BOTH** image flags are validated HERE, at the same trust boundary". `image` gets `assertImageRef`, `registryAuth` gets `assertRegistryAuth`, `imageBuildId` gets nothing. It is not a shell-injection risk (it never reaches argv — only a `===` comparison and a `JSON.stringify` in a message), but an empty/whitespace pin refuses every box with a message that reads as a marker problem rather than a config typo. `/^[0-9a-f]{16}$/` matches what `build-exedev-image.ts` actually generates.
- **Verified:** read driver.ts:399-409; `DEFAULT_IMAGE_BUILD_ID = "664876fb1a9128ec"` (:266) is 16 lowercase hex.

---

## [LOW] `binary-licenses.json` attributes `bunx`, which the Dockerfile never installs

- **File:** `oci/exedev/binary-licenses.json:23` vs `oci/exedev/Dockerfile:90`
- **Trigger:** The bun step installs exactly one file: `install -m 0755 -o root -g root bun-linux-x64/bun /usr/local/bin/bun`. No `bunx` symlink, no second install. The entry's `names` is `["bun", "bunx"]`.
- **Why it matters:** Not a build failure — `uncoveredBinaries` (`scripts/build-exedev-image.ts:838-841`) computes `added \ covered`, so an entry naming a binary that is not present is silently ignored. But the table is the legal artifact, and it currently claims attribution for a binary this image does not ship, while `attributedBinaries` in the build receipt (`build-exedev-image.ts:1193`) publishes that claim. The table's own header insists the coverage set must be computed rather than asserted; this is the reverse direction of the same error.
- **Verified:** read Dockerfile:85-92 (the only `install` of bun), `grep -rn "bunx"` across `src/` and `scripts/` → no runtime expects `bunx` on the box; read `uncoveredBinaries` at build-exedev-image.ts:838.

---

## [LOW] The marker size cap is compared in UTF-16 code units, the Dockerfile asserts bytes

- **File:** `src/providers/exedev/transport.ts:253-255` vs `oci/exedev/Dockerfile:292`
- **Trigger:** A marker whose `imageRef`/`gitSha` carry non-ASCII (a mirrored registry path with an IDN host, say). `read.content.length` counts UTF-16 code units; `stat -c '%s'` counts bytes.
- **Why it matters:** The two caps disagree for any non-ASCII content: the Dockerfile can pass a 4090-byte marker that the gate would judge under a different unit, and vice versa. Both are far from the real 154-byte marker so nothing breaks today; the discrepancy matters only because the comment at transport.ts:165-170 calls this an exact "4 KiB read cap" the Dockerfile "holds the file under". `Buffer.byteLength(read.content)` makes the two agree.
- **Verified:** read transport.ts:166-171 and :253-255; Dockerfile:292 `[ "$(stat -c '%s' /etc/qds-image.json)" -lt 4096 ]`.

---

## [LOW] `qds-run@.service`: `EnvironmentFile=` has no `-` prefix and `After=` is not `Requires=`

- **File:** `oci/exedev/systemd/qds-run@.service:35` and `:15`
- **Trigger:** (a) DF1.10 starts `qds-run@<runId>.service` on a box where DF2.3's key delivery has not happened or was rolled back → systemd fails the unit at load with "Failed to load environment files", and `Restart=no` (:28) means no retry and no second signal. (b) `systemd-tmpfiles-setup.service` fails at boot → `After=` orders but does not require, so the engine starts with no `/run/steering`.
- **Why it matters:** (a) is arguably the intended fail-closed behaviour, but it is not stated, and the failure mode (a systemd load error, not an engine error) is opaque compared to every other refusal in this story, which names its cause and a next command. (b) is inconsistent with the unit's own comment at :11-14 claiming "the engine never races the channel it writes into" — ordering alone does not guarantee the channel exists, only that the attempt happened first. The driver's `provisionSteeringChannel` covers (b) at create time, so it is latent rather than live.
- **Verified:** read the unit in full; `STEERING_PROVISION_SCRIPT` at driver.ts:97-102 creates `/run/steering` at `-m 700` with the exec user's uid/gid, which does match `oci/exedev/systemd/qds-steering.conf`'s `d /run/steering 0700 exedev exedev` and the Dockerfile's build-time `stat` assert at :246 — that pair is consistent.

---

## [LOW] AC6's "complete set of surfaces" omits `/etc/systemd/system.conf` `DefaultEnvironment=` and unit drop-ins

- **File:** `oci/exedev/Dockerfile:305-306` (the claim) and `:313-323` (the four checks)
- **Trigger:** A future story (or the base image) setting `DefaultEnvironment=QDS_RUN_ROOT=…` in `/etc/systemd/system.conf` or a drop-in under `/etc/systemd/system.conf.d/`, or a `QDS_*` `Environment=` in a drop-in directory `/etc/systemd/system/qds-run@.service.d/`.
- **Why it matters:** The comment asserts *"The four surfaces checked are the complete set of ways a QDS_* variable reaches a booted box from this image"*. `DefaultEnvironment=` reaches **every** unit's environment, including `qds-run@`, and is not one of the four; the drop-in directory reaches the unit specifically and is not checked either (only the unit file itself is grepped, at :316-318). The gate is also positional — it only catches what is above the last `RUN`, which the comment does warn about. Extending the third grep to `/etc/systemd/system.conf /etc/systemd/system.conf.d/ /etc/systemd/system/*.d/` closes it without changing the shape.
- **Verified:** read Dockerfile:294-323; the greps cover exactly `env`, `qds-run@.service`, `qds-steering.conf`, `/etc/environment` + `/etc/profile.d/`.

---

## [LOW] D's unreviewed-series refusal blames `PI_VERSION` when the real cause may be a broken `pi`

- **File:** `src/providers/exedev/assertions-in-box.sh:192-193` and `:209`
- **Trigger:** `pi --version` exits non-zero, prints to stderr only, or prints nothing parseable. `pi_full` becomes empty (stderr is discarded by `2>/dev/null`), `pi_series` becomes empty, and the `series != reviewed` arm fires with *"pi series ? is UNREVIEWED for a missing models.json (verified against 0.84; box reports ?) — PI_VERSION moved without re-checking…"*.
- **Why it matters:** Fail-closed, which is right (the comment at :188 intends exactly this) — but the message states a cause (someone bumped PI_VERSION) that the evidence contradicts (the box could not report a version at all). Gate B's `command -v pi` passing does not imply `pi --version` works. A distinct arm for `full == ""` ("the box could not report a pi version") costs one `if` and points the operator at the right thing.
- **Verified:** read assertions-in-box.sh:189-234 and the pass-matcher `case` at :236-243 — the unreviewed message correctly avoids both passing patterns (`*"custom registry absent"*` and `*" models priced"`), so the refusal itself lands in the right arm. Confirmed `set -u` only (no `set -e`, :24), so the `sys.exit(1)` inside the command substitution does not abort the script.

---

## Checked and found CONSISTENT (no finding)

Recorded so these are not re-walked:

- **Dockerfile ↔ code paths.** `/usr/local/bin/bun` (Dockerfile:90, asserted at :92) and `/usr/local/bin/pi` (Dockerfile:146, asserted `-L` + `-x` + `command -v` at :144-146) match what `setup-gate.ts:459` names and what a non-login `ssh box "cmd"` resolves. The build context is the **repo root** (`build-exedev-image.ts:964,988`), so `COPY oci/exedev/systemd/…` at Dockerfile:200-201 resolves.
- **tmpfiles ↔ driver.** `d /run/steering 0700 exedev exedev` == `STEERING_PROVISION_SCRIPT`'s `install -d -m 700 -o $(id -u) -g $(id -g)` (driver.ts:97-102) == the Dockerfile's `stat` assert (:246) == `attach.ts:62,80`'s `${QDS_STEERING_ROOT:-/run/steering}`. Four copies, all agreeing.
- **Unit env file path.** `EnvironmentFile=/home/exedev/app/.env` matches `KEY_ENV_FILE = "app/.env"` (`src/providers/credentials.ts:59`, box-home-relative) and the gate's `QDS_TEAM_RUNNER=local` append target (`setup-gate.ts:124,369`). Both written lines are valid systemd `KEY=value` syntax.
- **`readFileSync` import.** Present at `driver.ts:28` — the new `exeDevDriverFromEnv` use at :1020 compiles.
- **Production driver construction.** `grep -rn "new ExeDevDriver("` outside `tests/` → nothing. `src/providers/index.ts:138` is the only production site and it now routes through `exeDevDriverFromEnv`; `index.ts:146` still re-exports the class, and no non-test consumer imports it.
- **No credential leak on the create success path.** `parseJson` (driver.ts:947-958) never interpolates `res.stdout` into its error, so the unredacted-stdout leak vector does not exist; `create_failed` emits no stderr field.
- **`--image` / `--registry-auth` flags exist** on the exe.dev plan (`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:70`).
- **`pi --version` output shape** is bare (`0.84.4`), so the Dockerfile's exact-equality assert (:279) and the script's `grep -oE` extraction (:192) agree on the real binary.
