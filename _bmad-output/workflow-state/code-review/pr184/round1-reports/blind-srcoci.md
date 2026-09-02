# Blind adversarial review — chunk-src.diff + chunk-oci.diff

Line numbers are line offsets within the two diff files as supplied (`chunk-src.diff`,
`chunk-oci.diff`), since the hunks' own file line numbers are not resolvable without
reading the repo.

## [HIGH] The new "unreviewed pi series" refusal message contains the phrase `production-legal` — the same phrase the tolerated-absence pass note is built around

- **File:** `src/providers/exedev/assertions-in-box.sh` — chunk-src.diff:42 (refusal text) vs :44 (pass text) vs :53-55 (`case "$d_scan" in`)
- **Trigger:** `PI_VERSION` is bumped to a series other than `0.84`, `models.json` is absent, and the `case` pass arm globs on `*production-legal*` (or any substring the two messages share).
- **Why it matters:** The added comment at :37-39 asserts "the wording below deliberately avoids the phrase the pass-matcher greps for", but the refusal it writes ends in `…whether absence is still production-legal` — literally the distinguishing phrase of the pass note at :44. The `case` arms are not in the diff, so this claim is unverifiable from the change that makes it, and if the arm is the obvious `*production-legal*` glob the refusal reads as a PASS. This is the only thing standing between an unreviewed pi runtime and a green gate, because the Python `sys.exit(1)` at :43 is thrown away by the command substitution `d_scan="$(python3 -c …)"` — the exit code never reaches the caller, only the text does. A diff whose entire safety argument lives in a file it does not show is a finding on its own terms.

## [HIGH] A thrown (not non-zero) `control()` call leaks the registry credential unredacted

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:362-388
- **Trigger:** `this.control([... "--registry-auth", this.registryAuth ...])` **rejects** rather than resolving with `exitCode !== 0` — spawn failure (`ENOENT`), an exec timeout, a transport-level abort.
- **Why it matters:** `redactRegistryAuth` is applied only inside the `res.exitCode !== 0` branch. Runner/spawn errors routinely embed the full argv in `err.message` (`spawn ssh … --registry-auth USER:PASS`), and that rejection propagates straight out of `create()` to whatever logs the exception. There is also no `create_failed` emit on that path, so the failure is unattributed *and* the credential-scrub is skipped. The scrub belongs around the whole `control` call (try/catch, or in the runner), not around one of its two failure shapes.

## [MEDIUM] The documented env var name is not the one the code reads

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:436 (doc says `QDS_EXEDEV_REGISTRY_AUTH`) vs :447 (`env.QDS_EXEDEV_REGISTRY_AUTH_FILE`)
- **Trigger:** An operator follows the docstring and exports `QDS_EXEDEV_REGISTRY_AUTH=/path/to/creds`.
- **Why it matters:** The variable is silently ignored — no credential is loaded, no warning is emitted, and the boot falls through to the public path. Against a private mirror this surfaces as an opaque registry-auth failure inside exe.dev, far from the cause. Worse if the operator reads the doc as "this is where the credential goes" and puts the credential itself in that var.

## [MEDIUM] `imageBuildId` can be overridden from the environment with no validation, no pairing check, and no observability — gate B is silently defeatable

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:445-469; consumed at `setup-gate.ts` chunk-src.diff:509
- **Trigger:** `QDS_EXEDEV_IMAGE_BUILD_ID` set alone (image stays the repo pin), or `QDS_EXEDEV_IMAGE` set alone (buildId stays `DEFAULT_IMAGE_BUILD_ID`).
- **Why it matters:** Three distinct problems from one seam. (1) `assertImageRef` is called on the image, but `imageBuildId` gets **no** validation of any kind. (2) The digest/buildId pin is documented at :104 and :171-179 as something "only ever recorded as a pair", yet nothing enforces that the two env vars move together — setting only the image guarantees every box fails gate B with a misleading "the box booted an image this repo does not pin", and setting only the buildId turns INV-IBOX-2 into a check the operator picked the answer to. (3) `imageRef` is logged on every create event but `imageBuildId` is logged **nowhere**, so a run whose marker assertion was neutered by an env var leaves no trace of it. Either require both-or-neither, or at minimum emit the buildId alongside `imageRef` in `imageFields()`.

## [MEDIUM] pi is installed with no integrity verification while bun is checksummed

- **File:** `oci/exedev/Dockerfile` — chunk-oci.diff:146 (`exeuntu update pi …`) vs :91-98 (bun with `sha256sum -c`)
- **Trigger:** Any build. A compromised or MITM'd pi release channel, or a mutated artifact behind the vendor's downloader.
- **Why it matters:** The bun step goes to real trouble — an in-repo `BUN_SHA256` constant explicitly chosen so the check is not against a file fetched from the same host as the artifact. The pi step then pulls a compiled ELF over the network with no checksum, no signature, and no pinned digest, and that ELF is the thing the whole factory runs. The comment defends the *choice of installer* (vendor-owned symlink placement) but never addresses integrity, so the image's supply-chain posture is only as strong as its weakest fetch. The `[ -x … ]` assertions at :150-152 prove a file is executable, not that it is the right file. At minimum record the expected sha256 of the installed `pi` and assert it in the same RUN.

## [MEDIUM] `binary-licenses.json` attributes `bunx`, which the Dockerfile never installs

- **File:** `oci/exedev/binary-licenses.json` — chunk-oci.diff:358 (`"names": ["bun", "bunx"]`) vs `oci/exedev/Dockerfile` chunk-oci.diff:96
- **Trigger:** Any build; visible immediately in the built image.
- **Why it matters:** The install step is `install -m 0755 -o root -g root bun-linux-x64/bun /usr/local/bin/bun` — a single file. Nothing creates the `bunx` symlink that a normal bun install provides. So the table describes a binary that is not there (the coverage direction is safe, but the table is wrong about the image), and separately **`bunx` is unavailable in-box**, which will bite the first in-box step that shells out to it. Either install the symlink or drop the name.

## [MEDIUM] `pi --version` is parsed two contradictory ways in the same change

- **File:** `oci/exedev/Dockerfile` chunk-oci.diff:283/285 (`pi_observed="$(pi --version)"` … `[ "${pi_observed}" = "${PI_VERSION}" ]`) vs `src/providers/exedev/assertions-in-box.sh` chunk-src.diff:24 (`pi --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1`)
- **Trigger:** Any build, plus every gate run.
- **Why it matters:** These cannot both be correct. If `pi --version` prints a bare `0.84.4`, the grep-and-head pipeline in the shell script is pointless ceremony. If it prints anything else — `pi 0.84.4`, a banner, a trailing build hash — the Dockerfile's raw string equality fails and the image cannot be built at all, and the value baked into the marker's `piVersion` would have been the decorated string. One of the two authors measured and the other guessed; the same story shipping both is the smell. Make the Dockerfile extract the version the same way the assertion does.

## [MEDIUM] The reproducible-digest claim is contradicted by `QDS_BUILT_AT` being baked into the marker

- **File:** `oci/exedev/Dockerfile` — chunk-oci.diff:268, :292; claim at `src/providers/exedev/driver.ts` chunk-src.diff:134-143
- **Trigger:** Two builds of the same tree at different wall-clock times, with `QDS_BUILT_AT` passed as the current time.
- **Why it matters:** driver.ts states the digest is now reproducible and names "a wall-clock `builtAt` in the marker" as one of the three causes of drift that were *fixed*. The Dockerfile still writes `builtAt` from a build arg into `/etc/qds-image.json`, which is a real layer whose bytes go into the digest. The fix therefore lives entirely in `scripts/build-exedev-image.ts` (not in this diff) passing a deterministic value — and if anyone builds by hand with `--build-arg QDS_BUILT_AT=$(date …)`, the pin moves and the publish gate's equality check fails for a reason nothing in these two files explains. The Dockerfile should say what shape `QDS_BUILT_AT` must have, or derive it from `SOURCE_DATE_EPOCH`.

## [MEDIUM] B0 spends gate budget with no re-check before the pi assertions run

- **File:** `src/providers/exedev/setup-gate.ts` — chunk-src.diff:507-520
- **Trigger:** A slow or hanging box: the marker read consumes most or all of the remaining `gateTimeoutMs`, then `budgetFree()` is called again for `command -v pi` and `pi --list-models`.
- **Why it matters:** The existing code guards B's entry with an explicit "gate budget exhausted before B ran" check (:491). The new B0 is inserted *after* that guard and before the pi commands, so the budget can be fully drained between the check and its use, and `budgetFree()` may hand `execTimed` a zero or negative timeout. A `0` timeout is exactly the value that means "no timeout" in a lot of exec wrappers — the failure mode is a gate that hangs instead of failing closed, which is the opposite of what the surrounding comments promise. Re-check the budget (or clamp it) between B0 and the pi commands.

## [MEDIUM] `bundled[].spdxId` values have no canonical text, against the file's own stated rule

- **File:** `oci/exedev/binary-licenses.json` — chunk-oci.diff:352-353 (rule) vs :370 (`LGPL-2.0-or-later`) and :376 (`NOASSERTION`)
- **Trigger:** The build's `resolveLicenseText` validation running over nested `bundled` entries.
- **Why it matters:** The `$comment` says "Every 'spdxId' must resolve to a canonical text in `oci/license-texts/`", and the LGPL note at :372 says outright that no LGPL text is checked in. So either the validator only walks top-level `entries` — in which case the stated rule is an overclaim about the strongest-sounding guarantee in the file — or it walks `bundled` too and this file cannot build. `NOASSERTION` also isn't distinguished from the `UNVERIFIED` sentinel that the comment declares to be a build failure by design; two spellings of "we don't know" with different enforcement is how one of them stops being enforced.

## [MEDIUM] `exeDevDriverFromEnv` lets the environment clobber explicit caller options

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:464-469
- **Trigger:** `exeDevDriverFromEnv(env, { image: "…" })` with `QDS_EXEDEV_IMAGE` also set.
- **Why it matters:** `...opts` is spread first, so the env values win over anything a caller passed explicitly. For a function whose second parameter is named `opts`, callers will reasonably expect the reverse precedence, and the surprise is silent — the driver boots a different image than the code asked for. Given this is also the seam the marker gate keys on, "the explicit argument lost" is an expensive surprise. Spread the env first and `...opts` last, or refuse when both are set.

## [MEDIUM] `readFileSync` is used with no import visible in the diff

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:452, against the import hunk at :60-67
- **Trigger:** Compilation, if `node:fs` was not already imported by this module.
- **Why it matters:** The diff shows the top-of-file import hunk and adds exactly one name (`imageDigestOf`). `readFileSync` is a new call with no accompanying import in the change that introduces it. Either the module already had an unrelated sync-fs dependency (unusual for a driver that otherwise talks only over an injected command seam) or this does not build. Flagging because the diff does not carry its own justification.

## [MEDIUM] The unit orders after `systemd-tmpfiles-setup.service` but does not require it, and `EnvironmentFile` is not optional-marked

- **File:** `oci/exedev/systemd/qds-run@.service` — chunk-oci.diff:416 (`After=`), :436 (`EnvironmentFile=`)
- **Trigger:** `systemd-tmpfiles-setup.service` fails or is masked; or `/home/exedev/app/.env` has not been delivered yet when the unit is started.
- **Why it matters:** `After=` is pure ordering — it says nothing about the unit having succeeded, so the comment's claim that "the engine never races the channel it writes into" holds only for ordering, not for existence. If tmpfiles-setup fails, the engine starts against a missing `/run/steering` and discovers it at the first write. Add `Requires=` (or a `ConditionPathIsDirectory=/run/steering`). Separately, `EnvironmentFile=` without a leading `-` makes a missing `.env` a hard start failure — which may well be the intent (fail closed on a missing credential) but is undocumented in a file that documents everything else, so the next reader cannot tell deliberate from overlooked.

## [LOW] No cheap hardening on a unit that runs untrusted generated work with an LLM credential in its environment

- **File:** `oci/exedev/systemd/qds-run@.service` — chunk-oci.diff:418-436
- **Trigger:** Any `qds-run@<runId>` instance, once DF1.10 adds `ExecStart`.
- **Why it matters:** `[Service]` carries `Type`, `User`, `Restart`, `EnvironmentFile` and nothing else. `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`/`full`, `ProtectHome=` and `ProtectKernelTunables=` are one line each and cost nothing here, and the process this supervises runs model-authored commands. Adding them later means re-verifying the unit on a real box; adding them now costs one more line in the build-time `systemd-analyze verify` that already exists.

## [LOW] The `ExecStart` contract handed to DF1.10 leaves `%i` unquoted

- **File:** `oci/exedev/systemd/qds-run@.service` — chunk-oci.diff:449
- **Trigger:** A runId containing whitespace or a quote character reaching `systemctl start qds-run@<escaped>`.
- **Why it matters:** Specifiers are substituted into the command line before it is split into words, so a `%i` that expands to whitespace splits into multiple argv entries and one containing a quote can break parsing outright. systemd does not spawn a shell, so this is argument confusion rather than injection — but the contract is written to be copied verbatim by another story, and `ExecStart=/usr/local/bin/qds-engine run "%i"` is the same length. (Whether runIds are already constrained upstream is not visible in this diff; the contract shouldn't rely on that.)

## [LOW] Box-controlled marker content is interpolated raw into gate notes

- **File:** `src/providers/exedev/transport.ts` — chunk-src.diff:647 (`read.stderr.trim().slice(0, 200)`), :662 (`${marker.imageRef}`)
- **Trigger:** A box whose `/etc/qds-image.json` contains an `imageRef` with newlines/ANSI/control characters, or whose `cat` writes crafted stderr.
- **Why it matters:** `marker.buildId` is passed through `JSON.stringify` (correct), but `marker.imageRef` on the very next line is not — up to ~4 KiB of box-controlled text goes straight into a gate note that is logged. Same for the stderr tail. Log-line forgery from a machine the gate has just decided it does not trust is a small but free win to close: `JSON.stringify` both.

## [LOW] The 4096-"byte" marker cap is measured in UTF-16 code units

- **File:** `src/providers/exedev/transport.ts` — chunk-src.diff:652
- **Trigger:** A marker containing multi-byte UTF-8 (any non-ASCII in `imageRef`/`gitSha`/`builtAt`).
- **Why it matters:** `read.content.length` counts JS string units, not bytes, so up to ~3× the advertised cap can pass a check whose message says "is N bytes, over the 4096-byte cap". The Dockerfile's own assertion at chunk-oci.diff:298 uses `stat -c '%s'`, i.e. real bytes, so the two ends of the contract measure different things. Small window, trivially closed with `Buffer.byteLength`.

## [LOW] `assertImageRef` accepts mutable tags, so the env override can silently un-pin the factory

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:198-199, :445-446
- **Trigger:** `QDS_EXEDEV_IMAGE=ghcr.io/biospark33/qds-exedev:latest`.
- **Why it matters:** The entire argument for this change (chunk-src.diff:118-127) is that a tag "re-acquires exactly the disease this story treats". The validator nonetheless admits `:<tag>`, the env seam feeds it straight in, and `imageDigestOf` then logs `imageDigest: null` — which the transport doc frames as "the honest record that this box was pinned by immutable tag", a framing that quietly covers the un-pinned case too. Nothing warns. If tags must stay legal for the D7 mirror case, emit a distinct warning event when the effective image is not digest-pinned.

## [LOW] `redactRegistryAuth` only matches the exact `USER:PASS` string

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:324-327
- **Trigger:** Substrate stderr that echoes only the password half, or a shell-quoted/escaped/line-wrapped rendering of the argv.
- **Why it matters:** `text.split(this.registryAuth).join(…)` is exact-substring only. exe.dev echoing `--registry-auth 'user:pass'` with quotes still contains the full value (fine), but echoing just the secret, or wrapping it across a line, defeats it. Redacting the secret half independently as well is one extra line and the failure mode is a credential in a log.

## [LOW] `create_failed` omits `imageDigest`, and duplicates `imageFields()` instead of calling it

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:336-342 (accessor), :356-361 (`create_requested`), :378-382 (`create_failed`)
- **Trigger:** Any failed create; any future edit to the image field set.
- **Why it matters:** `imageFields()` is introduced with the explicit rationale "one accessor so no call site can forget one", and then two of the four call sites hand-roll the object. `create_failed` carries `imageRef` and `registryAuthUsed` but not `imageDigest` — the field the transport doc calls "the join key between a boot regression and the image that caused it" — so the one event where that join matters most is the one missing it. The next field added to `imageFields()` will land in two events out of four.

## [LOW] The AC6 "complete set of surfaces" is not complete

- **File:** `oci/exedev/Dockerfile` — chunk-oci.diff:312-314 (claim), :319-329 (checks)
- **Trigger:** A `QDS_*` variable introduced via `DefaultEnvironment=` in `/etc/systemd/system.conf`, a drop-in under `/etc/systemd/system.conf.d/`, a file in `/etc/environment.d/`, `/etc/default/*`, `/etc/security/pam_env.conf`, or `/etc/bash.bashrc`.
- **Why it matters:** The comment asserts the four checked surfaces "are the complete set of ways a `QDS_*` variable reaches a booted box from this image". `DefaultEnvironment=` in particular reaches **every** service systemd starts, including `qds-run@`, and is not checked. The check is still useful; the claim above it is stronger than the code, and a claim like that is what stops the next person from adding the missing greps.

## [LOW] The registry-auth file's permissions are never checked

- **File:** `src/providers/exedev/driver.ts` — chunk-src.diff:449-462
- **Trigger:** `QDS_EXEDEV_REGISTRY_AUTH_FILE` pointing at a world-readable file.
- **Why it matters:** The docstring and the `assertRegistryAuth` remediation both say "0600 host file" three times, and nothing verifies it. `statSync(...).mode & 0o077` is one line, at the one place in the system that reads a credential off disk — a check that is asserted in prose but not in code is the shape of thing that is discovered to be false during an incident.

## [LOW] `pi --version` extraction is fragile under `set -e` / `pipefail`

- **File:** `src/providers/exedev/assertions-in-box.sh` — chunk-src.diff:24
- **Trigger:** `pi` absent or non-executable (grep matches nothing → exit 1), or `pi --version` writing enough output that `head -1` closes the pipe first (grep gets SIGPIPE → 141).
- **Why it matters:** The comment at :23 promises "Fail-closed on an unreadable version: empty never equals the reviewed series" — i.e. the empty value is supposed to *flow into* the Python comparison and produce the crafted refusal message. If the enclosing script runs under `set -e` with `pipefail` (not visible in the diff), the assignment itself fails first and the script aborts before that message is ever produced, so the carefully worded diagnostic never reaches the operator. `pi_full="$(… || true)"` makes the stated behaviour the actual one regardless of what the file's prologue turns on.

## [LOW] A unit systemd refuses to load ships with an `[Install]` section

- **File:** `oci/exedev/systemd/qds-run@.service` — chunk-oci.diff:445 (no ExecStart), :457-458 (`[Install] WantedBy=multi-user.target`)
- **Trigger:** Anyone running `systemctl enable qds-run@x.service` on a box booted from this image before DF1.10 lands.
- **Why it matters:** The Dockerfile itself measured that systemd refuses this unit outright ("Service has no ExecStart=… Refusing"), yet the file advertises itself as enableable. Enabling it creates a `multi-user.target.wants` symlink whose unit then fails at every boot. Cheap mitigation: leave the `[Install]` stanza commented out alongside the `ExecStart` contract that DF1.10 is told to uncomment, so both arrive together.

## [LOW] No `TimeoutStopSec`/`KillMode` on a supervisor whose whole design argument is "a restart is a double-commit"

- **File:** `oci/exedev/systemd/qds-run@.service` — chunk-oci.diff:418-430
- **Trigger:** `systemctl stop qds-run@<runId>` (or shutdown) while the engine is mid-phase.
- **Why it matters:** The `Restart=no` rationale is that the engine cannot know which git commits and LLM spend already happened, so a restart is double-spend. The same reasoning applies to being SIGKILLed 90 seconds into a graceful stop — it produces exactly the partially-completed state the restart policy exists to avoid. A `TimeoutStopSec=` chosen against the real phase length (and `KillSignal=`/`KillMode=mixed` if the engine forks) is the other half of that argument.
