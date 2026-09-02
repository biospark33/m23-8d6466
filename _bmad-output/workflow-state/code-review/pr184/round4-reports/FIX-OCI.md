# FIX-OCI

Round 4, PR #184 (`feature/df2.10`). Files owned: `oci/exedev/Dockerfile`,
`oci/exedev/systemd/qds-run@.service`, `oci/exedev/systemd/qds-steering.conf`,
`oci/exedev/binary-licenses.json` (prose/`$comment`/`version`/`licenseUrl` only),
`.claude/skills/qds-live-e2e/SKILL.md`, `.dockerignore`. No commits, no staging.

`qds-steering.conf` and `.dockerignore` had no findings and are UNTOUCHED.

## Patched

| ID | File:line | What changed | Why |
|----|-----------|--------------|-----|
| E1 | `oci/exedev/Dockerfile:359`, `:365`, `:369` | Marker RUN now computes `pi_sha256="$(sha256sum "$(readlink -f /usr/local/bin/pi)" \| cut -d' ' -f1)"`, asserts it non-empty, and stamps it into `/etc/qds-image.json` as `piSha256` alongside the observed versions. | pi is installed with no content gate at all; recording the bytes makes drift between two builds of the same `PI_VERSION` detectable after the fact. |
| E1 | `oci/exedev/Dockerfile:169-186` (pi step), `:350-358` (marker) | New prose stating plainly that this is a RECORD, NOT A VERIFICATION, that nothing refuses a build on it, and exactly what would upgrade it to a gate (an upstream digest for `pi-linux-x64` pinned in-repo the way `BUN_SHA256` was). States explicitly that an `ARG PI_SHA256=""` empty-default bypass is deliberately not shipped. | The fail-safe resolution the review pre-authorised: a checksum that cannot be satisfied, or a skippable one, are both worse than an honest record. |
| E2 | `oci/exedev/Dockerfile:97` | `org.opencontainers.image.licenses="MIT"` → `"NOASSERTION"`. | The label is spec'd as the licence of the *contained software* as one SPDX expression; the image ships a GPL/LGPL Ubuntu userland plus statically-linked LGPL JavaScriptCore. `NOASSERTION` is the valid SPDX expression for "not determinable as one expression". |
| E2 | `oci/exedev/Dockerfile:83-96` | New prose justifying `NOASSERTION`, quoting the table's own "a single identifier cannot honestly carry a static-link graph", and pointing at `binary-licenses.json` / the generated NOTICE / `oci/license-texts/` as the real artifact. | The prose that justified `MIT` had to move with the behaviour. |
| E3 | `oci/exedev/Dockerfile:1` | `# syntax=docker/dockerfile:1` → `# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32`. **Option (1): digest resolved live, not invented.** | The frontend is pulled and *executed* by BuildKit at higher privilege than the base; it was the only unpinned upstream in a file whose doctrine is "digest-pinned, never `:latest`". |
| E3 | `oci/exedev/Dockerfile:3-15` | Prose: what the frontend is, how to re-resolve it, and why option (2) (delete the line) was rejected. | See Decisions. |
| E4 | `oci/exedev/Dockerfile:429-430` | NEW check: `! grep -rqE '^[[:space:]]*(Default)?Environment=.*QDS_' /etc/systemd/`. One recursive pass covers the manager configuration, its drop-in dir, and every per-unit drop-in dir. Anchored on the directive so the shipped unit's own comments (which name `QDS_RUN_ROOT`) are not findings. | `After=`-only greps missed the two surfaces that actually reach a `qds-run@` instance. Proven caught below. |
| E4 | `oci/exedev/Dockerfile:436-440` | Login/session file list widened from `/etc/environment /etc/profile.d/` to add `/etc/environment.d/ /etc/profile /etc/bash.bashrc /home/exedev/.profile /home/exedev/.bashrc /home/exedev/.bash_profile /home/exedev/.bash_login`; message now "QDS_* in a login/session env file". | bash sources `~/.bashrc` for a non-interactive `ssh box cmd` — the exact invocation shape the setup gate and driver use. |
| E4 | `oci/exedev/Dockerfile:387-425` | The "complete set" claim is deleted and replaced with a numbered list of the five surfaces actually checked, a named ceiling (`grep -r` does not follow recursion symlinks), and an explicit **NOT COVERED** paragraph for runtime delivery (`EnvironmentFile=`, a post-boot drop-in, `ssh box QDS_X=… cmd`). | The over-claim was as load-bearing as the gap. |
| E5 | `oci/exedev/systemd/qds-run@.service:99-112` | `[Install]` / `WantedBy=multi-user.target` **deleted**; replaced by prose saying why the section is absent and that DF1.10 uses `systemctl start`, never `enable`. | An enabled instance is pulled in by `multi-user.target` on every subsequent boot — the same double-spend `Restart=no` refuses, through a different door. Without the section `enable` fails loudly. |
| E6 | `oci/exedev/systemd/qds-run@.service:65`, `:72` | `TimeoutStopSec=300`, `TimeoutStartSec=60`, each with prose justifying the number. | The 90 s manager default SIGKILLs the cgroup — a routine teardown/reap `systemctl stop` could kill a phase engine mid-`git push` or mid-model-call. 300 s covers one repo-sized push + one in-flight completion; bounded rather than `infinity` so a SIGTERM-ignoring engine costs five minutes, not a wedged reaper. `TimeoutStartSec` bounds the exec (Type=simple starts on fork) and is stated so a manager-default change cannot move it silently. |
| E7 | `oci/exedev/binary-licenses.json:25-36` | The false sentence is replaced by an explicit CORRECTION paragraph naming the real behaviour, the real message, and where it was verified. | See Decisions — the ~:16-17 sentence was the true one. |
| E8 | `oci/exedev/Dockerfile:65-72` | BUMP PROCEDURE gains a fourth step: re-push `ghcr.io/biospark33/qds-exedev-private` with the new digest, naming `tier1-registry-auth.live.test.ts` and the `manifest unknown` failure. Adds that this applies to any edit to the Dockerfile or `oci/exedev/systemd/*`, since both are `deriveBuildId` inputs. | Following the old procedure verbatim landed a green build and a red AC4 with no pointer to the missing step. |
| E9 | `.claude/skills/qds-live-e2e/SKILL.md:46-53`, `:55-73` | The two contradictory sentences replaced by ONE truth: a two-row table naming both callers and the path each hands to `driver.setup()`, plus the consequence on each arm. `export QDS_EXEDEV_ROSTER=…` at :40 is KEPT (it is not inert). | See Decisions. |
| E10 | `oci/exedev/Dockerfile:209` | `chown -R exedev:exedev /home/exedev/.local` → `chown -R exedev:exedev /home/exedev/.local/pi`. | The `-R` was broader than the comment justified (the pi tree exeuntu just wrote as root, not everything under `.local`). |
| E10 | `oci/exedev/Dockerfile:154-167` | Prose adds an HONEST LIMIT: narrowing the chown does **not** make pi tamper-proof — exedev owns its `$HOME`, so it can unlink and replace `/home/exedev/.local/bin/pi` regardless of the file's owner, and names what would actually close it (install outside `$HOME` into root-owned dirs, i.e. not using `exeuntu update pi`). | Do not let a smaller diff read as a fixed hazard. |
| E11 | `oci/exedev/binary-licenses.json:50`, `:76` | `version` is now `"1.3.13"` / `"0.84.4"`. | A legal artifact's version field must hold a version. |
| E11 | `oci/exedev/binary-licenses.json:55`, `:81` | The provenance sentence moved into `verifiedHow` under a `PROVENANCE:` heading, including that the ARGs are `--build-arg`-overridable so the field describes the pinned build and an override must move the entry. | Keeps the pointer without letting it stand in for a value. |
| E12 | `oci/exedev/binary-licenses.json:53`, `:67`, `:79` | `licenseUrl`/bundled `url` pinned to tags: `blob/bun-v1.3.13/LICENSE.md` (×2) and `blob/v0.84.4/LICENSE`. Tag spellings VERIFIED over the network (see gate output). | `verifiedAt` pins the observation, not the target; the pinned artifacts are old releases. |
| E12 | `oci/exedev/binary-licenses.json:38-42`, `:62` | New `$comment` paragraph stating the tag-pinning rule and its single documented exception; the bundled NOASSERTION note now says why "a live reference" means "a reference that still describes THESE bytes". | The bundled entry's whole defence was a pointer that drifted. |
| E13 | `oci/exedev/systemd/qds-run@.service:40` | `AssertPathExists=/home/exedev/app/.env` (NOT `ConditionPathExists=`), with prose. | See Decisions / False positives — `Condition…=` would have been fail-OPEN. |
| E14 | `oci/exedev/systemd/qds-run@.service:26` | `Requires=systemd-tmpfiles-setup.service` added beside the existing `After=`, with prose explaining that `After=` is ordering only and is satisfied vacuously when the dependency never ran or failed. | Makes the "real dependency on every boot" the one systemd enforces. |

## False positives

| ID | Why it does not hold, with evidence |
|----|-------------------------------------|
| E12 (partial) | **`~:45` (`"url": "https://github.com/oven-sh/webkit"`) is not a `blob/main/` reference.** It is a bare repository URL, and it is verbatim what bun's own `LICENSE.md` gives *at the pinned tag*: `curl -s https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.13/LICENSE.md \| grep -i webkit` → line 9: `You can find the patched version of WebKit used by Bun here: <https://github.com/oven-sh/webkit>`. Upstream publishes no per-release ref for the WebKit fork, so pinning it would mean inventing a ref — which the finding itself forbids. The URL is KEPT and the reason is now recorded in the note (`binary-licenses.json:62`). The other three URLs (~:37, ~:51, ~:62) were genuine `blob/main/` and are fixed. |
| E13 (partial) | **The prescribed fix (`ConditionPathExists=`) would have been a regression.** A failed `Condition…=` marks the unit *skipped* and the start job **succeeds** — `systemctl start qds-run@<id>` would exit 0 while nothing ran, turning today's loud 203/EXEC-class failure into a silent no-op for DF1.10's caller. `AssertPathExists=` gives the same named cause in `systemctl status` (`Assertion failed for …`) **and** fails the job. Fail-safe option taken; the finding's goal (diagnosability without weakening fail-closed) is met, its prescribed directive is not what shipped. |
| E1 (scope) | Not a false positive, but a scope note: the finding's optional second half — "and, if the build script surfaces it, into the build evidence" — was NOT done. `scripts/build-exedev-image.ts` belongs to FIX-BUILDSCRIPT. `piSha256` is now in `/etc/qds-image.json`; surfacing it in build evidence is a one-line read for that owner if wanted. |

## Test expectations OTHER fixers must update

All three failures are in `tests/providers/exedev/image-assets.test.ts` (owned by another fixer — **not edited**). Caused by E5/E6/E13/E14, which change the unit's directive set. `tests/scripts/exedev-bun-pin.test.ts` is unaffected (all 9 pass).

| test file:line | current expectation | new expected value | which finding caused it |
|----------------|---------------------|--------------------|-------------------------|
| `tests/providers/exedev/image-assets.test.ts:257-259` (`directive-set` policy's `expected` record) | `Unit: ["Description", "After"],`<br>`Service: ["Type", "User", "Restart", "EnvironmentFile"],`<br>`Install: ["WantedBy"],` | `Unit: ["Description", "After", "Requires", "AssertPathExists"],`<br>`Service: ["Type", "User", "Restart", "TimeoutStopSec", "TimeoutStartSec", "EnvironmentFile"],`<br>*(drop the `Install` key entirely — the section is gone by design)* | E5, E6, E13, E14 |
| `tests/providers/exedev/image-assets.test.ts:337` | `expect(unitKeys("Service")).toEqual(["Type", "User", "Restart", "EnvironmentFile"]);` | `expect(unitKeys("Service")).toEqual(["Type", "User", "Restart", "TimeoutStopSec", "TimeoutStartSec", "EnvironmentFile"]);` | E6 |
| `tests/providers/exedev/image-assets.test.ts:509` (MUTATIONS[1].mutate) | `mutate: (t) => t.replace("[Install]", "Restart=on-failure\n\n[Install]"),` | `mutate: (t) => t.replace(\`EnvironmentFile=${EXPECTED_ENV_FILE}\`, \`Restart=on-failure\nEnvironmentFile=${EXPECTED_ENV_FILE}\`),` — `rejectedBy` stays `["restart-no", "directive-set"]`. The mutation's INTENT (a later `Restart=` that last-wins semantics make live) is preserved; it only needs a new anchor because `[Install]` no longer exists as a header. Note the literal string `[Install]` now appears only inside a COMMENT, so the old mutation produces garbage rather than no-op'ing — it fails confusingly, not loudly. | E5 |

**I verified these three values are sufficient and complete.** A patched copy of the test (repo untouched: copy placed at `/tmp/pr184-r4/check/a/b/c/copy.test.ts` with `src`/`oci` symlinked so the relative imports resolve) with exactly those three edits and nothing else runs **14 pass / 0 fail**. Every other mutation row, including the two ACCEPTED false-positive controls, still lands on exactly its declared `rejectedBy` set.

Two further notes for that owner:

1. **`image-assets.test.ts:472-484` ("the unchecked surfaces are empty in the repo, so the incomplete scan is not yet load-bearing") is now obsolete by its own terms** — the deferral it documents (lines 444-471) is discharged, the scan IS widened. It currently still passes, but only incidentally: its three `not.toMatch` assertions look for the literals `DefaultEnvironment=`, `system.conf`(`.d`) and `.service.d` in the Dockerfile text, and the new prose/greps deliberately avoid all three spellings (the grep uses the regex `(Default)?Environment=`, and one recursive pass over `/etc/systemd/` needs no path literals). That is green-by-luck, not by design. Recommend replacing that test with a positive assertion that the Dockerfile's AC6 RUN greps `/etc/systemd/` recursively.
2. Nothing else regressed: `bun test tests/providers/exedev/ tests/scripts/` → **671 pass, 2 skip, 1 todo, 3 fail** — the 3 above and no others. `image-contract.test.ts:1043` (`a well-formed marker parses to the six keys`) is UNAFFECTED by the new `piSha256` field, because `parseImageMarker` (`src/providers/exedev/transport.ts:279-286`) *constructs* its return value from six named keys and ignores everything else. Confirmed green in that run.

## Gate output

### 1. JSON parse + the real validator

```
$ python3 -c "import json,sys; json.load(open('oci/exedev/binary-licenses.json')); print('json ok')"
json ok

$ bun -e '<validateBinaryLicenses on the real file, plus an E7 probe>'
problems: []
E7 probe (top-level NOASSERTION): ["entry 0 (p): no canonical text in oci/license-texts/ for \"NOASSERTION\""]
```

### 2. `systemd-analyze verify` — **could not run on this host** (macOS 22.6.0; `which systemd-analyze` → nothing). Run against real systemd in a throwaway container instead, at the SAME version the base ships (the Dockerfile records `255.4-1ubuntu8.17`), replicating the Dockerfile's DoD(a) RUN verbatim (throwaway `[Service]`/`ExecStart` appended, throwaway binary installed):

```
systemd 255 (255.4-1ubuntu8.17)
--- verify output (must be EMPTY) ---
[]
verify exit=0
```

The Dockerfile requires verify to be **silent**, not merely exit 0, so the negative control matters — a bogus directive is still caught:

```
=== NEGATIVE CONTROL: verify is not vacuous (bogus directive) ===
[/tmp/bogus@.service:115: Unknown key name 'Typo' in section 'Service', ignoring.]
```

Same container, the new AC6 shell run against real `/etc/systemd`, real `/etc/tmpfiles.d`, a real `exedev` user:

```
=== NEGATIVE CONTROL: a drop-in that AC6 must now catch ===
CAUGHT (correct)              # /etc/systemd/system/qds-run@.service.d/10-runroot.conf → Environment=QDS_RUN_ROOT=…
CAUGHT manager default (correct)   # the manager drop-in → DefaultEnvironment=QDS_STEERING_ROOT=…
=== POSITIVE: the AC6 RUN, verbatim, on the shipped assets ===
AC6 RUN exit=0                # no false positive from the unit's own QDS_-naming comments
=== POSITIVE: a QDS_ in ~/.bashrc must now be caught ===
CAUGHT (correct)
=== tmpfiles DoD (b) ===
tmpfiles ok                   # `700 exedev exedev`, unchanged
```

Both "CAUGHT" lines are surfaces the OLD grep missed entirely — that is E4's fix proven, not asserted.

### 3. `docker build --check` — **ran** (daemon reachable, Docker Desktop 28.4.0):

```
$ docker build --check --platform linux/amd64 -f oci/exedev/Dockerfile .
#2 resolve image config for docker-image://docker.io/docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#2 DONE 1.0s
#4 [internal] load metadata for ghcr.io/boldsoftware/exeuntu@sha256:4398215003cf896d4a0bbab119f461e0fa09d36fe5b68e7349e0bfb305b9e27d
#4 DONE 0.8s
Check complete, no warnings found.
check exit=0
```

This also proves the E3 pin: BuildKit resolved and used the digest-pinned frontend, and that frontend parsed the file (including `COPY --chmod`) with zero warnings.

Belt and braces, every `RUN` extracted and `bash -n`'d (all 7, unedited ones included):

```
run0: bash -n exit=0  | cd /tmp \
run1: bash -n exit=0  | rm -rf /home/exedev/.local/pi /home/exedev/.local/pi.old \
run2: bash -n exit=0  | rm -rf \
run3: bash -n exit=0  | cp /etc/systemd/system/qds-run@.service /tmp/qds-verify@.service \
run4: bash -n exit=0  | systemd-tmpfiles --create /etc/tmpfiles.d/qds-steering.conf \
run5: bash -n exit=0  | [ -n "${QDS_IMAGE_REF}" ] && [ -n "${QDS_BUILD_ID}" ] \
run6: bash -n exit=0  | leaked="$(env | sed -n 's/^\(QDS_[A-Za-z0-9_]*\)=.*/\1/p' \
```

and the new `piSha256` fragment executed for real, positive and negative:

```
piSha256=1fea43009afc5ef34783ecc8a7622574a6b5da43ae69cdefda22f57ce9dbd28b len=64
fragment exit=0
--- negative: symlink target missing ---
refused (correct), exit=1     # the && chain fails the RUN rather than stamping an empty field
```

### 4. `bun test tests/providers/exedev/image-assets.test.ts tests/scripts/exedev-bun-pin.test.ts`

```
exit=1
error: directive-set: DF1.10 adds exactly one line (ExecStart=/usr/local/bin/qds-engine run %i); pinning the set makes that addition a deliberate, visible change
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > every AC6 policy holds on the file as shipped
error: expect(received).toEqual(expected)
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > no ExecStart — DF1.10 owns it, and its arrival must be a visible change
error: AC6's named negative control: Restart=on-failure
(fail) DF2.10 AC6 — negative controls: each assertion rejects the wrong file > every mutation is rejected by exactly the policies named, and by no others

 21 pass
 3 fail
 79 expect() calls
Ran 24 tests across 2 files.
```

The `directive-set` diff, verbatim, is the exact new expected value handed to the owning fixer above:

```
+   "[Unit] directives are [Description, After, Requires, AssertPathExists], expected [Description, After]",
+   "[Service] directives are [Type, User, Restart, TimeoutStopSec, TimeoutStartSec, EnvironmentFile], expected [Type, User, Restart, EnvironmentFile]",
+   "section [Install] is missing",
```

Wider run for regressions: `bun test tests/providers/exedev/ tests/scripts/` → `671 pass, 2 skip, 1 todo, 3 fail` — the same three, nothing else.

### 5. `bunx biome check .claude/skills/qds-live-e2e/SKILL.md`

**Biome does not cover Markdown** — it processed zero files:

```
Checked 0 files in 27ms. No fixes applied.
internalError/io
  × No files were processed in the specified paths.
biome exit=1
```

The exit 1 is "no files matched", not a lint finding. No Markdown linter applies here.

### Not runnable here

- A real `docker build` of this Dockerfile (QEMU-emulated linux/amd64, ~10 min + a multi-GB base pull) was not run. `--check` plus the container replications of DoD(a), DoD(b) and the AC6 RUN cover every fragment I edited except the `exeuntu update pi` step itself, which needs the real base.
- Consequently the `chown` narrowing (E10) is verified only as syntax and intent; the first real rebuild is what proves `/home/exedev/.local/pi` is the right and sufficient target. Failure direction is a loud build failure, not a silent boot break.

### Cross-cutting consequence (flag to the round lead)

Every edit here moves a `deriveBuildId` input (`dockerfile` bytes and `systemd/qds-run@.service` bytes — `scripts/build-exedev-image.ts` `deriveBuildId`). The currently-pinned `DEFAULT_IMAGE_REF` / `DEFAULT_IMAGE_BUILD_ID` pair in `src/providers/exedev/driver.ts` is therefore **stale**: the image must be rebuilt, republished, re-pinned, **and the private mirror re-pushed** before the live `tier1-image-contract` (gate B buildId) and `tier1-registry-auth` (AC4) legs can pass again. That coupling is now written into the Dockerfile's BUMP PROCEDURE (E8) so the next person does not rediscover it.

## Decisions taken

**E1 — record, not verify.** No upstream checksum for `pi-linux-x64` exists to pin, and an `ARG PI_SHA256=""` with an "unpinned" empty default is the documented bypass this repo refuses elsewhere. So the build now *records* `sha256(pi)` in `/etc/qds-image.json` next to the versions the marker already carries, following the marker RUN's existing jq shape. Nothing refuses on it. The Dockerfile says so in those words, and names the single thing that would upgrade it to a gate: an upstream-published digest measured the way `BUN_SHA256` was, at which point the step gains bun's `sha256sum -c -` refusal. Deliberately NOT asserted equal to a constant — an equality against a value measured from the same unverified install can only ever pass.

**E3 — option (1), the digest.** `docker buildx imagetools inspect docker/dockerfile:1` worked here (network + daemon available) and returned the multi-arch **index** digest `sha256:ecfaec9e…5fc32` (image created 2026-07-29), so it still resolves per-platform, exactly like the `FROM` pin. Nothing was invented. Option (2) — deleting `# syntax` — was checked and would have been *viable*: the file has no heredoc, no `RUN --mount`, no `COPY --link`, no `ARG` in `FROM` (and `scripts/build-exedev-image.ts:581` refuses heredocs outright, which is corroborating evidence). It was rejected anyway because the built-in frontend's version then rides on whichever daemon happens to build — a floating dependency wearing a different hat, in the one file whose doctrine is that pins are reviewed diffs. The pin is proven live by gate 3: BuildKit resolved and ran that exact digest.

**E7 — the ~:16-17 sentence was TRUE; ~:26-27 was FALSE.** Read `validateBinaryLicenses` (`scripts/build-exedev-image.ts:1350-1357`) and `resolveLicenseText` (`scripts/lib/license-sweep.ts:408`). A top-level `spdxId` that is not the literal `UNVERIFIED` goes to `resolveLicenseText`, which parses `NOASSERTION` as an ordinary SPDX atom and looks for `NOASSERTION.txt` in `oci/license-texts/` — the directory holds eight files and that is not one of them (nor could it sensibly be). It returns `null`, and the entry becomes a problem. Executed, not reasoned: a probe entry with `spdxId: "NOASSERTION"` yields `["entry 0 (p): no canonical text in oci/license-texts/ for \"NOASSERTION\""]`. So a top-level `NOASSERTION` **does** fail the build — by the ordinary path, with a different message than `UNVERIFIED`'s special case. The `$comment` now says exactly that, flags it as a correction so a future reader knows which way the sentence flipped, and preserves the genuinely true part: only a `bundled` member may carry `NOASSERTION`, because its `spdxId` is never resolved.

**E9 — the one roster truth: both resolutions are real, on different call paths, and neither sentence was wrong; the file was.**
- Production `fleet dispatch`: `src/fleet/dispatch.ts:1424` derives `join(dirname(manifestPath), "roster.yaml")`, pre-checks it host-side (`loadManifestAndRoster`, :1352-1545), and passes it into `driver.setup()` at :2899. `QDS_EXEDEV_ROSTER` is **not read on this path at all**.
- Live e2e: `preflight()` (`tests/fleet/e2e/live-harness.ts:130`) copies `process.env.QDS_EXEDEV_ROSTER` into `ctx.rosterPath`, and `tests/fleet/e2e/tier1-image-contract.live.test.ts:382` hands it straight to `driver.setup({ rosterPath })` → `rosterModels(opts.rosterPath)` (`src/providers/exedev/setup-gate.ts:357`).

So `QDS_EXEDEV_ROSTER` is **not inert** and the `export …` line at SKILL.md:40 stays. The "sails through `liveGate()` and dies at setup" paragraph is true — on the harness arm only, which is the arm a live round runs. SKILL.md now states this as one fact with a two-row table, and adds the corollary the old text hid: on the dispatch arm a bogus `QDS_EXEDEV_ROSTER` changes nothing and the run goes green, so "I set the env var" is never evidence about which roster the gate actually read.

**E13 — `AssertPathExists`, not `ConditionPathExists` (fail-safe).** See False positives. The prescribed directive would have converted a loud failure into `systemctl start` exiting 0 on a skipped unit.

**E6 — the numbers.** `TimeoutStopSec=300`: sized to the two operations that must never be cut in half (one repo-sized `git push`, one in-flight model completion), bounded rather than `infinity` so a SIGTERM-ignoring engine costs a teardown five minutes instead of wedging the reaper. `TimeoutStartSec=60`: for `Type=simple` systemd considers the unit started on fork, so this bounds the exec only; stated explicitly rather than inherited so a change to the manager default cannot move it silently.
