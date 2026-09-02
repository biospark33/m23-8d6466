# auditor

Scope note: verdicts below rest on the three assigned diff slices (`chunk-src.diff`,
`chunk-oci.diff`, `chunk-ci.diff`), targeted greps into `chunk-buildscript.diff`, and the story
file. Test files and evidence JSONs were **not** in my slices; where an AC's proof lives only
there I say so rather than assert it. Line references are given as `path` + symbol, with the
chunk-diff line in parentheses for exact traceability (chunk line ≠ source line).

## AC coverage table

| AC | Verdict | Evidence (file:line) |
|----|---------|----------------------|
| AC1 — boots at pinned ref, passes every gate, baked `buildId` **equals** the repo pin | SATISFIED (one deviation, see F3) | `src/providers/exedev/setup-gate.ts` B0 block (chunk-src.diff:1098-1163); `transport.ts:imageMarkerFailure` (chunk-src.diff:1403-1493); live proof recorded at story:311-321 |
| AC1(a) digest arm / (b) immutable-tag fallback — "Dev Agent Record states which one shipped" | SATISFIED | `driver.ts:DEFAULT_IMAGE_REF` = `…@sha256:a70674b2…` (chunk-src.diff:354-355); story:203-214, 309 states digest arm shipped |
| AC1(c) folded into gate B, no new `AssertionItem` letter, no `1\|2\|3\|4` edit, payload `{code,message,remediation}` | SATISFIED | `setup-gate.ts` pushes `item:"B"` only (chunk-src.diff:1163); `SetupGateResult.error` added, `assertionCode` untouched (chunk-src.diff:1024-1034, 1189) |
| AC1 fail-closed on absent / over-cap / unparseable / mismatched | SATISFIED | `imageMarkerFailure` arms (chunk-src.diff:1430-1491); `IMAGE_MARKER_MAX_BYTES` checked `>=` in bytes (chunk-src.diff:1467-1470) |
| AC2 — `ARG BUN_VERSION` = repo pin, `ARG PI_VERSION`, `setup-gate.ts:422` corrected, F14 arm version-conditional | SATISFIED | `oci/exedev/Dockerfile` `ARG BUN_VERSION=1.3.13` + `BUN_SHA256` (chunk-oci.diff:92-114), `ARG PI_VERSION=0.84.4` (chunk-oci.diff:121-168); pi message corrected (chunk-src.diff:1168-1173); `PI_REVIEWED_SERIES="0.84"` D-pre arm (chunk-src.diff:81-157) |
| AC2 — marker records **observed** not echoed versions | SATISFIED (stronger than asked) | Dockerfile marker RUN asserts `pi_observed == PI_VERSION`, `bun_observed == BUN_VERSION` (chunk-oci.diff:297-314) |
| AC3 — `--image` unconditional, `--registry-auth` conditional, both validated **in the constructor**, module-level default, no `process.env` in `create()` | SATISFIED | argv spread (chunk-src.diff:747-762); constructor validation (chunk-src.diff:599-627); `DEFAULT_IMAGE_REF` module-level (chunk-src.diff:354); env read isolated to `exeDevDriverFromEnv` + `providers/index.ts` (chunk-src.diff:856-967, 1519) |
| AC4 — public by default; `--registry-auth` validated, redacted, default-off, refused without a recorded ratified deviation naming scope/expiry/rotation owner | SATISFIED | `assertRegistryAuth` (chunk-src.diff:426-457), `assertRegistryAuthDeviation` (chunk-src.diff:481-552), per-create re-assert (chunk-src.diff:734), `redactRegistryAuth` (chunk-src.diff:663-677), anonymous-pull proof step (chunk-ci.diff:857-908) |
| AC5 — sweep over the **exported filesystem**, non-zero package count is itself the finding, binary coverage **computed** by diffing built vs base | SATISFIED | `sweepImageTree(imageId, scan.nodeModulesSites, treeDir)` (chunk-buildscript.diff:1897-1901); non-zero count `die(1,…)` (chunk-buildscript.diff:1904-1929); added-set computed by path **and content** then `uncoveredBinaries` (chunk-buildscript.diff:1970-1991); `sweptPackageCount` in evidence (chunk-buildscript.diff:2100) |
| AC6 — system `qds-run@.service`, `Restart=no`, `User=exedev`, `After=systemd-tmpfiles-setup.service`, literal `EnvironmentFile`, exact tmpfiles bytes, **no** `QDS_*` | SATISFIED (one over-claim, F8) | `oci/exedev/systemd/qds-run@.service` (chunk-oci.diff:426-483); `qds-steering.conf` = `d /run/steering 0700 exedev exedev` (chunk-oci.diff:490); build-time verify + tmpfiles `--create` proof (chunk-oci.diff:246-268); QDS_* sweep RUN (chunk-oci.diff:335-345) |
| AC6 — reboot proof, `/run/steering` back at 0700 with no code path having run | CANNOT VERIFY FROM MY SLICES (recorded) | story:320; live evidence JSON not in my slices |
| AC7(a) exeuntu pullable vs clone, recorded | SATISFIED | `FROM ghcr.io/boldsoftware/exeuntu@sha256:43982150…` (chunk-oci.diff:73); story:220 |
| AC7(b) `exe.dev/install-shelley` KEPT unless a probe shows otherwise | SATISFIED | Dockerfile declares no LABEL touching `exe.dev/*` (chunk-oci.diff:76-85); story:222 |
| AC7(c) size + cold-boot time in the evidence JSON | PARTIAL (see F7) | `imageSizeBytes`/`baseImageSizeBytes` written (chunk-buildscript.diff:2095-2096); `coldBootMs: 0` sentinel in the **build** evidence (chunk-buildscript.diff:2099); the real number lives only in the live-e2e evidence (story:326-329) |
| DoD — publish workflow fails if pushed digest ≠ repo pin | SATISFIED as code, NEVER EXECUTED | gate step (chunk-ci.diff:665-845); story:286, 524-529 admit the workflow has never run |
| DoD — `.github/dependabot.yml` second `docker` entry | PARTIAL (see F5) | chunk-ci.diff:36-39 and its own "DORMANT UNTIL THE DOCKERFILE CARRIES A TAG" comment (chunk-ci.diff:24-35) |
| Negative controls (AC1/AC2/AC3/AC4/AC5) | CANNOT VERIFY FROM MY SLICES | test files not in the assigned slices |

## Findings

### [HIGH] DF2.3's credential lifecycle was modified, in a story that says "no DF2.3 code is touched"
- **AC violated:** "Not an edge — DF2.3 (credential class) … No edge, and **no DF2.3 code is touched**" (story:45-47); Technical Notes "Region ownership … A change outside your own region belongs in the owning story" (story:138-139); Files to Modify (story:155-164) does not list `src/providers/credentials.ts`; the Deviations list enumerates exactly three extra files and this is not one (story:242-245).
- **File:line:** `src/providers/credentials.ts` `mintRunKey` (chunk-src.diff:33-69, hunk `@@ -349,7 +349,38`)
- **Gap:** the diff adds a compensation path to `mintRunKey`: a failing `store.set` now triggers `revokeAndVerify` (a real provider round-trip) plus a new `credential.mint_compensation` log event, then rethrows. This is a semantic change to DF2.3's mint/revoke lifecycle — new outbound provider traffic on a previously-inert failure path, a new log operation name, and a changed exception surface. It is nowhere in the story: no AC, no Files-to-Modify entry, no deviation record, no round record. It is plausibly a follow-on from the live-round harness defect at story:307, which the story explicitly classified as **"Not a product defect"** — yet a product file changed.
- **Evidence:**
  ```
  -  deps.store.set(runId, { keyHash: res.hash });
  +  try {
  +    deps.store.set(runId, { keyHash: res.hash });
  +  } catch (e) {
  +    try {
  +      await revokeAndVerify(deps, res.hash);
  ```

### [HIGH] A fleet-region change the story itself DEFERRED landed in this PR
- **AC violated:** Region ownership (story:138-139); Files to Modify (story:155-164); and directly contradicts the story's own round-2 deferral.
- **File:line:** `src/fleet/fanout-primitive.ts` `probeArm` (chunk-src.diff:5-25, hunk `@@ -741,7 +741,22`); enabling change in `src/providers/exedev/transport.ts` `readBoxFile` (chunk-src.diff:1220-1242)
- **Gap:** story:515-517 records, as a round-2 **deferral**, "`src/fleet/fanout-primitive.ts` `probeArm` ignores the new `probeExit` discriminator … **Out of this PR's clusters; needs a fleet fix or issue**." The diff does the fix anyway. Two behaviour changes to DF3's race path ship unauthorized: (1) a non-1 probe exit is now a skipped tick returning `null` instead of `"absent"`, so arms that previously reset their corruption streak now accumulate toward `MARKER_UNUSABLE_TICKS_LIMIT` and can lose a race they used to survive; (2) `readBoxFile` now prefers `driver.execTimed` when present, so the fleet race's per-tick ssh is **killed** at the budget rather than abandoned — a real change in substrate-side process behaviour for every existing `readBoxFile` caller. Both may well be improvements; neither is authorized by this story, and the deferral text is now false.
- **Evidence:**
  ```
  -    if (res.kind === "absent") return "absent"; // no marker yet — a clean read, resets the streak
  +      if (res.probeExit === undefined || res.probeExit === 1) return "absent";
  +      skipTick("race-probe-failed", …);
  +      return null; // a transport skip: no evidence either way, so it must not reset the streak
  ```

### [MEDIUM] Gate B compares against the *effective* buildId, not the repo pin — two env vars boot an unreviewed image with every gate green
- **AC violated:** AC1 ("its baked `/etc/qds-image.json` `buildId` **equals** the one **the repo pin** pairs with the digest that was pulled"); INV-IBOX-2 ("Gate B compares that `buildId` to the one **the repo pin** pairs with the pulled digest").
- **File:line:** `src/providers/exedev/setup-gate.ts` — `imageMarkerFailure(markerRead, driver.imageBuildId)` (chunk-src.diff:1145); `src/providers/exedev/driver.ts` `exeDevDriverFromEnv` (chunk-src.diff:856-967)
- **Gap:** the comparand is `driver.imageBuildId`, which `QDS_EXEDEV_IMAGE_BUILD_ID` overrides at the registry factory — and `QDS_EXEDEV_IMAGE` overrides the reference in the same breath (both-or-neither is enforced, which makes the *pair* override the easy path, not the hard one). Set both and production boots an image no review saw, and gate B **passes**, because it is now checking the box against the env's claim rather than against the repo's. The announce arm only fires for a **tag** pin (`imageDigestOf(this.image) === null`, chunk-src.diff:637-642), so a digest-shaped override is silent apart from `imageRef`/`imageBuildId` riding the create events. AC3 does authorize an override "read at the registry factory under `QDS_*`", so this is a genuine tension between AC3 and AC1/INV-IBOX-2 rather than a pure defect — but as shipped, the in-box half of "we own the substrate" is bypassable by environment, and nothing (including `verify-image-pin.yml`, which reads only the in-repo constant) covers that path.
- **Evidence:**
  ```
  imageMarkerFailure(markerRead, driver.imageBuildId)
  …
  const image = env.QDS_EXEDEV_IMAGE;
  const buildId = env.QDS_EXEDEV_IMAGE_BUILD_ID;
  ```

### [MEDIUM] The provenance gate cannot fail for the only artifact that ships — an exception file exempts the shipped pin
- **AC violated:** none literally (attestation is beyond the story's ACs), but it contradicts the PR's own supply-chain claim ("Signed provenance, restored out of band … **Produced is not verified**", story:264-273) and the sibling workflow's stated rule.
- **File:line:** `.github/image-pin-exceptions.json` (chunk-ci.diff:45-56); `.github/workflows/verify-image-pin.yml` exception arm (chunk-ci.diff:1287-1295)
- **Gap:** the register's single entry is `sha256:a70674b2…` — i.e. `DEFAULT_IMAGE_REF`, the one digest production boots. So the new consumer gate verifies nothing today: it attempts `gh attestation verify` against both stores, and on failure downgrades to `::warning::` and `exit 0`. Combined with the admitted fact that the publish workflow **has never executed** (story:286) and the image was pushed by hand, there is no signed provenance anywhere on the production path, and the gate written to detect that fact is configured not to. It is honest (self-expiring 2026-10-15, reasoned, reviewed, deletion owner named) — which is why this is MEDIUM, not BLOCKER — but it sits in the same PR as `publish-exedev-image.yml`'s "There is deliberately no `--allow-unpinned` input: **a gate with a documented bypass is not a gate**" (chunk-ci.diff:103-104). Both statements cannot be the project's rule.
- **Evidence:**
  ```
  echo "::warning::pin $digest has NO verifiable attestation — accepted under the audited exception register …"
  exit 0
  ```

### [MEDIUM] The dependabot entry discharging a Files-to-Modify item is inert by construction
- **AC violated:** Files to Modify — "`.github/dependabot.yml` (authored by DF2.9; adds a second `docker` directory entry)" (story:163); DoD "`.github/dependabot.yml` gains the second `docker` entry" (story:189). The entry's *purpose* is Infra-Prereq early warning on exeuntu drift (story:123-124 and the ADR's "boot regressions" falsifier).
- **File:line:** `.github/dependabot.yml` (chunk-ci.diff:36-39), rationale at chunk-ci.diff:24-35
- **Gap:** the entry cannot ever open a PR, and the diff says so: dependabot's docker updater derives the stream from a **tag**, and `oci/exedev/Dockerfile` pins `ghcr.io/boldsoftware/exeuntu@sha256:…` with no tag. So the box is ticked while, in the file's own words, "the base digest is watched by nobody: no PR is indistinguishable from no upstream change." Upstream rebuilds weekly on a no-cache cron — exactly the drift this story exists to detect. The one-token fix (`exeuntu:latest@sha256:…`) is deferred to DF1.10 because it moves the buildId.
- **Evidence:**
  ```
  # DORMANT UNTIL THE DOCKERFILE CARRIES A TAG. This entry cannot open a PR
  # today: oci/exedev/Dockerfile pins the base as `ghcr.io/…@sha256:…` with NO tag
  ```

### [LOW] Story file's "13 files touched, not 10" is stale; there is no round-3 record
- **AC violated:** Dev Agent Record accuracy (story:242-249); commit `c52f4d0` is titled "review round 3" and the story has no round-3 section.
- **File:line:** story:242 vs the diff slices
- **Gap:** beyond the ten Files-to-Modify entries and the three recorded deviations, the assigned slices alone add at least five more touched files: `src/providers/credentials.ts`, `src/fleet/fanout-primitive.ts`, `.github/workflows/verify-image-pin.yml`, `.github/image-pin-exceptions.json`, `.dockerignore`. The atomicity claim the Deviations section was written to defend no longer holds as stated, and two of those five (F1, F2) are in other stories' regions.
- **Evidence:** `1. **13 files touched, not 10.**` (story:242) vs `chunk-src.diff:29` (`credentials.ts`), `chunk-src.diff:1` (`fanout-primitive.ts`), `chunk-ci.diff:1149` (`verify-image-pin.yml`), `chunk-ci.diff:40` (`image-pin-exceptions.json`), `chunk-oci.diff:1` (`.dockerignore`).

### [LOW] AC7(c)'s cold-boot falsifier is a `0` sentinel in the build evidence
- **AC violated:** AC7(c) "built image size and cold-boot time vs stock exeuntu, **in the evidence JSON**"; DoD "evidence JSON records … the built image size and the cold-boot time" (story:197).
- **File:line:** `scripts/build-exedev-image.ts` evidence writer (chunk-buildscript.diff:2095-2100)
- **Gap:** `imageSizeBytes` and `baseImageSizeBytes` are measured; `coldBootMs: 0` is written as the never-evaluated sentinel with a comment deferring it to the live e2e round. The falsifier is therefore recorded in a *different* artifact (the e2e evidence, story:326-329) than the one the build produces, and the build evidence — the artifact the publish workflow uploads — carries a zero that reads as a measurement to anything that does not know the sentinel convention. Substantively discharged (the ADR's number exists, and it is the honest cold-pull ~60 s rather than the flattering warm 5 s); only the artifact boundary drifts from the DoD's wording.
- **Evidence:**
  ```
  // Filled by the live e2e round, which is the only thing that can boot a
  // box. Per the Observability Contract, a field never evaluated reports 0.
  coldBootMs: 0,
  ```

### [LOW] AC6's build-time QDS_* check claims a "complete set" of surfaces it does not cover
- **AC violated:** AC6 "Neither image nor unit sets `QDS_RUN_ROOT`, `QDS_STEERING_ROOT` or any `QDS_*` path variable"; DoD "the same check asserts the rendered unit and the image environment set **no** `QDS_*` path variable".
- **File:line:** `oci/exedev/Dockerfile` final RUN (chunk-oci.diff:316-345)
- **Gap:** the comment asserts "The four surfaces checked are the complete set of ways a `QDS_*` variable reaches a booted box from this image" — image env, unit, tmpfiles conf, `/etc/environment` + `/etc/profile.d/`. Not checked: `/home/exedev/.bashrc` / `.profile` (bash does source `~/.bashrc` for a non-interactive `ssh box cmd`, which is exactly how the setup gate and driver invoke everything — the Dockerfile itself relies on that distinction when it argues bun must live on the default PATH, chunk-oci.diff:99-106), `/etc/systemd/system.conf`'s `DefaultEnvironment=`, and PAM `environment`. The image adds nothing to any of them, so this is a completeness over-claim rather than a live hole — but AC6 is load-bearing for DF1.11's INV-IBOX-13 and DF3.7's AC4, and the next person will trust the sentence.
- **Evidence:**
  ```
  # The four surfaces checked are the complete set of ways a QDS_* variable
  # reaches a booted box from this image: the image environment, the unit, the
  # tmpfiles entry, and the login/session env files.
  ```

### [LOW] `verify-image-pin.yml` guards the PR path only
- **AC violated:** none (workflow is beyond spec); noted because it is the sole consumer of the attestation the PR spends a job producing.
- **File:line:** `.github/workflows/verify-image-pin.yml` (chunk-ci.diff:1188-1193)
- **Gap:** triggered on `pull_request` paths only, so a direct push to `dev`/`main` moving `DEFAULT_IMAGE_REF` is unchecked; the invariant "the pin only ever names a CI-built, attested artifact" holds exactly as far as branch protection requires PRs, which this repo enforces server-side but this file does not state. Also `if: github.repository_owner == 'biospark33'` makes the job skip (green-by-silence) on forks.
- **Evidence:**
  ```
  on:
    pull_request:
      paths:
        - src/providers/exedev/driver.ts
  ```

### Decorative-compliance sweep — what I looked for and did NOT find
Stated explicitly so the absence is a result, not an omission:
- **`buildId` is compared, not merely computed** — `marker.buildId !== expectedBuildId` returns a refusal (chunk-src.diff:1481-1491), threaded into the payload and reachable only through the fail-closed `else` (chunk-src.diff:1154-1164). No env var relaxes B0 itself.
- **The binary coverage set is computed, never read from the table it checks** — built-vs-base diff, by path **and content hash**, so an in-place replacement (`exeuntu update pi`) is caught (chunk-buildscript.diff:1970-1983). The AC5 tautology negative control is genuinely closed.
- **The license sweep gates on more than a package count** — `unreadable`/`unresolved`/`missingTexts` all `die(1)` (chunk-buildscript.diff:1934-1953), so a tree the walk could not parse cannot report clean.
- **No `--allow-unpinned` / skip input on the publish gate**, and the sentinel is cross-asserted in both spellings (chunk-ci.diff:471-486).
- **The registry-auth refusal never echoes the value** (chunk-src.diff:426-457), and the ratification check fails closed on every arm including a lapsed expiry (chunk-src.diff:546-548).
- **`systemd-analyze verify` is not trusted on exit code alone** — silence is also required (chunk-oci.diff:246-255), and `systemd-tmpfiles` runs for real with a `stat` assertion rather than a parse check (chunk-oci.diff:266-268).
