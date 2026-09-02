# Blind adversarial review — `scripts/build-exedev-image.ts`

Line numbers are new-file line numbers (hunk `@@ -0,0 +1,1214 @@`, so file line = diff line − 6).

## [HIGH] A comma in `--tag` injects arbitrary buildx output attributes, including `push=true`
- **File:** scripts/build-exedev-image.ts:1010 (also :1005 and :1114)
- **Trigger:** `--tag 'ghcr.io/x/y:v1,push=true'` (or any tag string carrying a comma — e.g. a CI workflow input, a tag assembled from an env var). The value is spliced raw into buildx's CSV option syntax: `--output type=image,name=${opts.tag},rewrite-timestamp=true`. buildx splits on commas, so everything after the first comma in the tag becomes an additional output attribute.
- **Why it matters:** The script's central invariant is "nothing is tagged or pushed until every gate has passed" (header, lines 87 and 1004–1010, which deliberately omit `name=` from the docker export for exactly this reason). A comma-carrying tag turns the *pre-gate* build into a push, publishing an image that has not been swept, credential-scanned or attributed. `opts.tag` is never validated against a reference grammar anywhere in the file. This is argv-safe (no shell), but the injection is into buildx's own option parser, which is enough.

## [HIGH] The image tag is baked into the image, so the pushed digest is a function of `--tag` — but `buildId` deliberately excludes it
- **File:** scripts/build-exedev-image.ts:968 (`--build-arg QDS_IMAGE_REF=${opts.tag}`), cf. :348 ("Deliberately NOT hashed: … the image ref")
- **Trigger:** Any two runs of the same source tree with different `--tag` values — e.g. a local run using `DEFAULT_TAG` (`ghcr.io/biospark33/qds-exedev:local`, line 124) and the CI publish run using a release tag. The build arg lands in a layer (`/etc/qds-image.json`), so the layer bytes and therefore the manifest digest differ.
- **Why it matters:** The whole file is built around "the pushed digest == the digest pinned in driver.ts, and an unchanged tree rebuilds to an unchanged digest" (header, lines 21–25). That claim is false across tag values, and it fails *silently in the direction that matters*: `buildId` is identical for both builds, so the in-box gate B assertion (INV-IBOX-2) passes while the digests disagree. The pin gate then fires for a reason nobody looking at the buildId can explain — which is precisely the "tripwire that fires on every rebuild and gets bypassed the third time" outcome the header says it is preventing. Either the ref must be out of the image or it must be in the buildId; it cannot be neither.

## [HIGH] `runtimeBaseRef` = last deduped `FROM` is wrong for the standard multi-stage shape the parser explicitly supports
- **File:** scripts/build-exedev-image.ts:509 (`runtimeBaseRef: baseRefs[baseRefs.length - 1]!`), with `parseBaseRefs` at :382–:397
- **Trigger:** A Dockerfile shaped `FROM exeuntu AS runtime-base` … `FROM node:22 AS builder` … `FROM runtime-base` (final stage derives from an *earlier stage*, so it contributes no ref). `parseBaseRefs` correctly drops stage references, so `refs = [exeuntu, node:22]` and the "last" ref is the **builder**, not the runtime base. Same failure via the dedup path (`if (!refs.includes(ref))`, :394): `FROM exeuntu AS build` … `FROM exeuntu` collapses to one entry and the ordering claim breaks again.
- **Why it matters:** `runtimeBaseRef` is the negative control for AC5 — `listExecutables(built) \ listExecutables(base)` at :1089–:1091. Diffing against the wrong base image produces a garbage "added" set: every executable the real base ships reads as *added* (build stops on hundreds of unattributed binaries), or, if the wrong base is the fatter one, real added binaries are subtracted away and ship unattributed. The header itself (lines 994–998) says DF1.10 will add an engine build stage to this same Dockerfile, which is exactly the shape that breaks this heuristic.

## [MEDIUM] `die()` exits the process, so every `finally` cleanup block is skipped — containers and temp trees leak on failure
- **File:** scripts/build-exedev-image.ts:172–174 (`die` → `exitWithFailure`), leaks at :663–:665, :685–:687 and :1205–:1207
- **Trigger:** Any gate failure or fatal after a container is created. `scanImage` creates a container (:626) and removes it in `finally` (:664); but `die(2, …)` at :640 / :648 and `run()`'s internal `die` both terminate via `process.exit`, which does **not** unwind `finally`. Same for `extractNodeModules` (:675–:687) and for `main`'s `finally { fs.rmSync(treeDir) }` (:1205) — every `die(1, …)` inside that try (npm-tree finding :1061, NOTICE gap :1082, credential findings :1085, uncovered binaries :1093, digest mismatch :1136) skips it.
- **Why it matters:** A repeatedly-failing build accumulates stopped containers holding image references. That is not merely untidy here: the script's own preflight (:942–:950) refuses to run when `opts.tag` still resolves after `docker rmi -f`, and the advice it prints is "remove the containers holding it". Failure N leaves the container that makes failure N+1 unrunnable. Extracted `node_modules` trees under `os.tmpdir()` leak on the same paths.

## [MEDIUM] `imageSourceSha()` returns the literal string `"unknown"` on the fallback path its own docstring forbids
- **File:** scripts/build-exedev-image.ts:281 (`return (tryRun("git", …) ?? "unknown").trim();`)
- **Trigger:** `QDS_GIT_SHA` unset and `git rev-parse HEAD` unavailable — no git binary on the runner, a non-repo working directory, a tarball checkout.
- **Why it matters:** The docstring three lines above (:269–:274) states the value is "validated as 40 hex rather than taken on trust" because "'unknown' or a branch name there is a provenance claim that is silently false". The validation is applied to the env path only; the git path is unvalidated and returns the exact sentinel the comment names. `unknown` then goes into `--build-arg QDS_GIT_SHA` (:970) and into `/etc/qds-image.json`, shipping a false provenance field, and it also silently changes the image digest relative to a build where git worked. Every other unresolvable input in this file fails closed (`sourceDateEpoch` :246, `resolveBaseDigest` :437); this one does not.

## [MEDIUM] `containerimage.digest` is read as a single flat key from a build with **two** exporters
- **File:** scripts/build-exedev-image.ts:1022–:1029
- **Trigger:** The build at :996–:1013 passes two `--output`s (`type=docker` and `type=image`) with one `--metadata-file`. Both exporters report a `containerimage.digest`, and the docker-archive manifest digest is **not** the registry image manifest digest. On a buildx version that namespaces per-exporter metadata, `meta["containerimage.digest"]` is simply absent.
- **Why it matters:** Two outcomes, both bad. (a) Absent key on a buildx upgrade → `die(2)` at :1029 on every build, with a message that does not point at the cause. (b) Present but sourced from the docker exporter → `builtDigest` is a digest no registry will ever resolve, and the post-push equality check at :1136 (`digest !== builtDigest`) fails *after* the image is already published, or, if the two happen to agree in one buildx version, the check is proving something other than what the comment claims. The code never disambiguates which export the digest describes, and the digest it records is the value written into the summary and the evidence as the reproducibility proof (:1171).

## [MEDIUM] The digest-mismatch gate fires *after* the push, leaving the published artifact behind
- **File:** scripts/build-exedev-image.ts:1136–:1141
- **Trigger:** The registry resolves the tag to something other than `builtDigest` — a concurrent job pushing the same tag, a registry-side conversion, or case (b) of the finding above.
- **Why it matters:** The header asserts "Nothing is tagged until every check has passed, so a build that tripped a gate leaves no artifact behind" (lines 86–87). On this path the artifact *is* the registry tag, it has already been pushed at :1112, and the script exits 1 without attempting to delete or re-point it. Downstream consumers pulling by tag get the unvetted image. The earlier local-tag drop (:941) shows the author understood exactly this requirement for the local case.

## [MEDIUM] Base digests are resolved three independent times against a floating tag
- **File:** scripts/build-exedev-image.ts:420–:441 (`resolveBaseDigest`), :1090 (`listExecutables(runtimeBaseRef, …)`), :996 (the buildx build)
- **Trigger:** An unpinned `FROM <tag>` (the function explicitly supports this — it only refuses `$`-templated refs) where the tag moves, or a host whose locally-cached copy of that tag is older than the registry's.
- **Why it matters:** `resolveBaseDigest` prefers the *registry* digest (:432), buildx resolves the tag itself when it builds, and `docker run <runtimeBaseRef>` at :1090 uses whatever the *local daemon* has (pulling only if absent — a stale local copy is used as-is). So the `buildId` can record digest A, the image can be built on digest B, and the added-binary negative control can subtract digest C. The header's claim that "a floating base tag that moved under us must change the identity" (:379–:381) holds only if all three resolutions agree, which nothing here enforces. Related: the local fallback `{{index .RepoDigests 0}}` (:434) takes index 0 of a list that can hold digests for *other* repositories entirely — an image pulled from two registries yields a digest that does not belong to `ref`.

## [MEDIUM] A pre-existing `qds-repro` builder on the wrong driver is silently accepted
- **File:** scripts/build-exedev-image.ts:296–:298
- **Trigger:** Someone (or an earlier version of this script, or another repo) created a builder named `qds-repro` with `--driver docker` or `remote`. `docker buildx inspect --bootstrap qds-repro` exits 0 and the function returns the name.
- **Why it matters:** The entire justification for this function (:284–:288, :133–:143) is that the default `docker` driver *cannot* export `type=image` at all. Detect-then-create validates existence but never the driver, so the failure resurfaces at the build with the raw buildx error — the exact "unexplained failure three commands later" the docstring says it exists to prevent. One `--format '{{.Driver}}'` on the inspect closes it.

## [MEDIUM] Binaries replaced in place escape attribution entirely
- **File:** scripts/build-exedev-image.ts:1091 (`[...builtBins].filter((p) => !baseBins.has(p))`), :840 (`uncoveredBinaries` matches on `path.basename`)
- **Trigger:** The image overwrites an executable that already exists at the same path in the runtime base. Concretely plausible here: `exeuntu update pi --version` (header, :150–:153) installs a compiled ELF — if the base image already ships any `pi` at that path, the shipped binary is a different program with different licensing and is invisible to the diff.
- **Why it matters:** AC5's coverage set is computed by *path* membership only, with no content comparison (no size, no hash). "Added" is the only thing the gate can see, so an unattributed third-party binary that lands on an existing path passes. The basename-only match at :840 widens the same hole in the other direction: a new `/opt/vendor/bash` is considered covered by an entry naming `bash`.

## [MEDIUM] Fixed build-artifact paths make concurrent runs clobber each other
- **File:** scripts/build-exedev-image.ts:119–:122 and :952–:955 (`archive`, `metadataFile`, `NOTICE_PATH`, default summary/evidence)
- **Trigger:** Two invocations on one host — the obvious case being a CI matrix over `--platform`, which is a first-class flag (:160) but is not part of any output path. Also a local run overlapping a watch/CI run.
- **Why it matters:** `exedev.docker.tar` and `build-metadata.json` are shared mutable state across the whole build. Run A can read run B's metadata (recording B's digest as A's `builtDigest`), or `docker load` A's archive after B truncated it. The failure is silent and lands in exactly the value the pin gate compares. `--summary`/`--evidence` are overridable; these two are not.

## [MEDIUM] Post-push digest falls back to a local `RepoDigests` entry that need not be from this push
- **File:** scripts/build-exedev-image.ts:1121–:1124
- **Trigger:** `manifestDigest(opts.tag)` returns null (registry read fails — network flake, auth expiry, or the imagetools template quirk the file itself documents at :406–:410) while the daemon holds a `RepoDigests` entry for that tag from an *earlier* pull or push.
- **Why it matters:** The push was performed by BuildKit, not the daemon, so the daemon's `RepoDigests` for this tag is by definition stale here — it is whatever the daemon last pulled/pushed under that name. The comment on the very next line says it is reading the digest "back from the registry rather than assumed from the local image id"; the fallback quietly does the assumed thing. It is caught by the equality at :1136 only insofar as it produces a *mismatch*, which is reported as "the swept, scanned and attributed image is not the image now under the tag" — a false and alarming diagnosis of a registry read failure.

## [LOW] `binary-licenses.json` containing `null` throws an uncaught `TypeError` (exit 1, not 2)
- **File:** scripts/build-exedev-image.ts:753 (`const entries = (raw as { entries?: unknown }).entries;`)
- **Trigger:** The file contains the literal `null` (valid JSON, so the try/catch at :914–:920 passes it through).
- **Why it matters:** Property access on `null` throws before validation can return a problem list. The uncaught throw exits 1, which the documented contract (:89–:91) reserves for a *compliance failure* — a malformed input file is a fatal-before-the-gates condition and must be 2. Any caller distinguishing "the image is non-compliant" from "the build could not run" is misled.

## [LOW] `SECRET_ENV.test(line)` in a loop is stateful if the imported regex carries `/g`
- **File:** scripts/build-exedev-image.ts:621–:622
- **Trigger:** `SECRET_ENV` (imported from `./build-image.ts`) being declared with the `g` or `y` flag, now or after a future edit there.
- **Why it matters:** `RegExp.prototype.test` advances `lastIndex` on a global regex, so alternate calls in a loop return false regardless of content — a credential-shaped layer would be missed on every second line. This is a credential gate; a false negative here is the failure mode with the worst payoff. `SECRET_ENV.test` should not be called in a loop without resetting `lastIndex`, or the import should be a non-global literal.

## [LOW] Sweep's healthy path depends on matching another module's error *message*
- **File:** scripts/build-exedev-image.ts:726 (`if (/nothing to sweep/.test(msg)) return emptySweep();`)
- **Trigger:** `sweepTree` in `./lib/license-sweep.ts` rewording its throw.
- **Why it matters:** On this image the empty tree is the *expected* result, so a reworded message converts every clean build into `die(2, "the filesystem sweep could not conclude")`. Cross-module coupling through prose, with no shared constant or typed error to anchor it.

## [LOW] `--push` / `--keep-tree` detected by `argv.includes`, then filtered out of the value-flag parse
- **File:** scripts/build-exedev-image.ts:858, :861, :865
- **Trigger:** Either literal appearing as the *value* of another flag — `--tag --push`, `--platform --keep-tree`.
- **Why it matters:** `push` is set to true by a token that was never meant as a flag, and the same token is then deleted from the array handed to `parseValueFlags`, which shifts the flag/value pairing it sees. The mis-parse silently enables the one option that publishes to a registry.

## [LOW] A stale 1.6 GB archive survives failure paths between build and load
- **File:** scripts/build-exedev-image.ts:1038 (`fs.rmSync(archive, { force: true })`)
- **Trigger:** `die(2)` at :1029 (unusable `containerimage.digest`) or at :1036 (`docker load` reported no image id) — both sit between the export and the removal, and `die` exits the process.
- **Why it matters:** Each failed run leaves a multi-gigabyte file in `oci/.build/exedev/`. It is truncated by the next run's `fs.rmSync` at :954, so this is disk pressure rather than a correctness bug — but on a CI runner it is a plausible out-of-space cause for the *next* build.

## [LOW] `sizeOf` records 0 (or `null`) for a failed inspect, indistinguishable from a real measurement
- **File:** scripts/build-exedev-image.ts:1144
- **Trigger:** `docker image inspect` failing for either ref — most plausibly `runtimeBaseRef` when it is a registry ref the daemon never pulled locally.
- **Why it matters:** `Number(null ?? 0)` is `0`, and a non-numeric output yields `NaN` which `JSON.stringify` writes as `null`. `imageSizeBytes` / `baseImageSizeBytes` are two of the ADR's named re-opening falsifiers (:1181–:1186); a silent 0 is a recorded measurement that is false, which is worse than an absent field for a value whose entire purpose is falsification.

## [LOW] Tar/history output is split on `\n` with no allowance for embedded newlines
- **File:** scripts/build-exedev-image.ts:621 (history) and :646 (export listing)
- **Trigger:** A path containing a newline in the exported filesystem (legal on Linux), or a `docker image history --no-trunc` `CreatedBy` for a heredoc `RUN`.
- **Why it matters:** A newline in a path splits one entry into two bogus ones; each half is then classified, and `docker cp` of a half-path fails, producing a spurious "could not read … — treating as a finding" (exit 1 on a clean image). More quietly, `nodeModulesRoot` can miss the real tree root because it sees only a fragment. The file argues at length (:791–:800) against parsing `tar -tv` for exactly this class of reason, then parses `tar -tf` line-wise anyway; `--null`/`-0` framing is the closed form.

## [LOW] `--tag` is `docker rmi -f`'d before any validation
- **File:** scripts/build-exedev-image.ts:941
- **Trigger:** A mistyped or copy-pasted `--tag` naming an unrelated local image (`ubuntu:22.04`, a colleague's build, an image id).
- **Why it matters:** The script force-removes a local image it did not create, before doing anything else. Defensible for its own tag; the absence of any check that the ref belongs to this project makes it a destructive side effect of a typo.

## [LOW] Executable enumeration hard-codes `/usr/bin/find` inside both images
- **File:** scripts/build-exedev-image.ts:803
- **Trigger:** A runtime base without findutils, or with `find` at `/bin/find` (busybox-derived), or a base whose `/usr/bin` layout differs.
- **Why it matters:** `docker run --entrypoint /usr/bin/find` fails to start, `res.status !== 0`, and the build dies at :818 claiming the enumeration "exited N (see the find stderr above)" — a message that points at `find`'s output when the actual cause is that `find` was never executed. This constrains which bases the Dockerfile may use, and the constraint is enforced only as a confusing runtime failure.

## [LOW] `SOURCE_DATE_EPOCH` validation accepts `0` and leading zeros
- **File:** scripts/build-exedev-image.ts:231–:240
- **Trigger:** `SOURCE_DATE_EPOCH=0` (or `00000`) in the environment — a plausible value for someone reaching for "fully deterministic".
- **Why it matters:** `wellFormed = /^[0-9]{1,11}$/` passes, `builtAt` becomes `1970-01-01T00:00:00.000Z`, and every layer mtime is rewritten to the epoch. Not incorrect for reproducibility, but the marker then carries a `builtAt` that reads as a bug in every downstream consumer, and the guard's stated purpose (catching values people paste in by mistake) does not cover the degenerate end of the range.
