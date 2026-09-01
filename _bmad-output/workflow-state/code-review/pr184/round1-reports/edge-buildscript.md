# Edge-case hunt — `scripts/build-exedev-image.ts` (PR #184, DF2.10)

Unhandled edge cases only. Most severe first.

## [HIGH] `extractNodeModules` copies without `-L`, so a symlinked npm tree lands as dangling symlinks and the AC5 gate reads 0 packages
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:679` and `:683` (the two `docker cp` calls), gate at `:1050`
- **Trigger:** the built image ships a `node_modules` in which any package directory is a symlink (npm workspace links, a hoisted/linked package, `.bin`-style linking, or a tree exeuntu's pi installer leaves behind). `docker cp cid:/<site> <host>` without `-L` writes the symlink verbatim into the host scratch dir, where its absolute in-container target does not exist.
- **Why it matters:** `walkTree` classifies exactly that shape as `unreadable`, NOT as an entry — `license-sweep.ts:288-296` says so in its own words: *"a dangling symlink (the shape a linked package takes after a `docker cp` onto the host)"* → `unreadable.push(manifest)`. `treePackageCount` is `entries.length` (`license-sweep.ts:575`). The AC5 gate at `:1050` is `if (sweep.treePackageCount > 0)`. A tree whose packages are all symlinks therefore yields `treePackageCount === 0` and the build **passes with an unswept npm tree in the shipped image** — the exact failure the gate exists to catch. The sibling function `inspectConfigs` at `:564` already uses `docker cp -L` and its docblock explains at length why link-following is mandatory to judge the bytes a booted box reads; that reasoning was not applied to the tree extraction.
- **Verified:** read `license-sweep.ts:229-330` (`walkTree`/`visitPackage`), confirmed `unreadable` vs `entries` split and `treePackageCount: entries.length` at `:575`; confirmed `inspectConfigs` uses `-L` at `build-exedev-image.ts:575`.

## [HIGH] `sweep.unreadable`, `sweep.unresolved` and `sweep.missingTexts` are never gated — DF2.9's fail-closed signals are dropped
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1050-1082` (the only place `sweep` is judged)
- **Trigger:** any extracted tree where a package directory cannot be read, has no/corrupt `package.json`, or resolves no license. The script branches only on `sweep.treePackageCount`, `sweep.entries`, `sweep.denied`, `sweep.pinViolations` and `verifyNoticeCoverage`.
- **Why it matters:** `SweepResult.unreadable` is documented in `license-sweep.ts:143-144` as *"Package dirs the walk could not read — fail closed rather than skip"*, and `unresolved` at `:137-138` as *"No license metadata AND no shipped text — fail closed (INV-4)"*. Neither is read here. Combined with the finding above, a tree can be simultaneously present, unreadable, and reported clean. This is independent of the `-L` fix: even after fixing the copy, an unreadable dir still silently passes.
- **Verified:** grepped every use of the `sweep` binding in `build-exedev-image.ts` (lines 1044-1190); `unreadable`, `unresolved`, `missingTexts` and `uncommonIds` appear nowhere except in `emptySweep()`.

## [HIGH] `imageSourceSha()` falls back to the literal string `"unknown"`, which the Dockerfile's guard accepts
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:281`
- **Trigger:** `QDS_GIT_SHA` unset AND `git rev-parse HEAD` fails — a source tarball / `git archive` export, a checkout with no commits, `git` not on PATH, a repo owned by another uid (`dubious ownership`), or a container build context without `.git`.
- **Why it matters:** the function's own docblock (`:270` region) says the value is *"Validated as 40 hex rather than taken on trust: … and `"unknown"` or a branch name there is a provenance claim that is silently false."* The env path IS validated; the git path is not — `?? "unknown"` returns exactly the string the docblock names as forbidden. `oci/exedev/Dockerfile:275-276` guards only with `[ -n "${QDS_GIT_SHA}" ]`, which `"unknown"` satisfies, so `/etc/qds-image.json` ships `gitSha:"unknown"` as provenance a box reads back. It also silently moves the digest (the marker is a layer), so such a build can never reproduce a published digest and the failure surfaces as an unexplained pin mismatch, not as "no git here".
- **Verified:** read `oci/exedev/Dockerfile:259-292` (the marker RUN and its `-n` guards); confirmed no 40-hex validation on the git-derived path.

## [MEDIUM] `ensureReproBuilder` accepts a pre-existing `qds-repro` of the wrong driver
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:296-304`
- **Trigger:** a builder already named `qds-repro` created with the default `docker` driver (or `remote`/`kubernetes`). `docker buildx inspect --bootstrap qds-repro` exits 0, and the function returns immediately without inspecting the driver.
- **Why it matters:** the entire reproducibility claim rests on `docker-container` (the docblock at `:285-295` says so: *"a reproducibility claim that silently depends on the operator's `buildx use` is not a claim"*). Detecting by NAME reintroduces exactly that dependency one level down. The build then fails at the `--output type=image,rewrite-timestamp=true` export with a raw buildx exporter error — the "unexplained failure three commands later" the function was written to prevent.
- **Verified:** diff + read of the function; the `--driver docker-container` argument appears only on the `create` path (`:299-303`), never on the accept path.

## [MEDIUM] A broken-but-present `qds-repro` is unrecoverable, and the printed remedy is the command that just failed
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:304-310`
- **Trigger:** the builder record exists but cannot bootstrap — the `buildx_buildkit_qds-repro0` container was `docker rm`'d, the `moby/buildkit` image was pruned with no network to re-pull, or the docker context it was created against is gone. `inspect --bootstrap` fails, then `buildx create --name qds-repro` fails with `existing instance for "qds-repro"`.
- **Why it matters:** the die message tells the operator to run `docker buildx create --name qds-repro --driver docker-container --bootstrap` — the exact invocation that just returned non-zero for that reason. There is no `buildx rm` path and no distinction between "absent" and "present but broken". CI is affected too: the runner cache can carry a stale builder record.
- **Verified:** diff only (the failure mode is buildx's documented `existing instance` error; not reproduced here).

## [MEDIUM] `builtDigest` is read from one `containerimage.digest` key while TWO exporters are active in that solve
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1021-1029` (metadata read), consequence at `:1136`
- **Trigger:** any `--push` run. The gating build at `:996-1013` declares `--output type=docker,dest=…` AND `--output type=image,name=…` against a single `--metadata-file`.
- **Why it matters:** the script assumes the single flat key `containerimage.digest` describes the `type=image` exporter. With multiple exporters, which exporter owns that key (or whether buildx emits per-exporter keys instead) is version-dependent. If it reports the docker-archive exporter's manifest digest, then `builtDigest` is not a registry digest, and the post-push equality at `:1136` dies with **exit 1** — `"the pushed digest is not the digest the gates read"` — on every push. That is a build-tooling mismatch presented as a supply-chain compliance failure, and the publish workflow has no way to tell them apart. Nothing in the script asserts that the two exports agree, or that only one exporter contributed the key.
- **Verified:** diff only — needs a real buildx run to settle. Flagging because the failure mode is a false CRITICAL-looking alarm on the one path that matters.

## [MEDIUM] The buildId depends on `package.json`, which the publish workflow deliberately excludes from the source-revision path set
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:500` (`bunVersion: readBunPin(readFileSync(REPO_ROOT/package.json))`), hashed at `:359`
- **Trigger:** a `packageManager` bump in `package.json` (the workflow's own comment says dependabot rewrites it weekly), followed by any re-run of `publish-exedev-image.yml` at an unchanged image source revision (`workflow_dispatch`, a re-run, or a later push that resolves the same `src_sha`).
- **Why it matters:** `.github/workflows/publish-exedev-image.yml:151` sets `SOURCE_PATHS=(oci/exedev scripts/build-exedev-image.ts)` and `:140-145` explains package.json is excluded on purpose. But `bunVersion` IS a buildId input and a build arg, so a bump changes both the buildId and the digest while `src_sha` — and therefore the tag `${IMAGE}:sha-${src_sha}`, described at `:163` as an *"Immutable per-SOURCE-revision tag"* — does not move. The same tag then resolves to different bytes across two runs. The disagreement is between the script's input set and the workflow's path set; neither side asserts the other.
- **Verified:** read workflow lines 140-170 and 240-262; read the buildId field list at `build-exedev-image.ts:355-369`.

## [MEDIUM] Stale `--summary` / `--evidence` JSON survive a failed build and are read by a live test
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1155` and `:1157` (both written only on the success path); pre-build cleanup at `:936` and `:941`
- **Trigger:** run the script once successfully, then again with a change that trips any gate (`die(1)` on the npm tree, credentials, uncovered binaries, or the digest mismatch).
- **Why it matters:** the script explicitly drops the image tag (`:941`) and the NOTICE (`:936`) so that *"a build that tripped a gate leaves no artifact behind"* (header). It never drops `opts.summary` or `opts.evidence`. After a failed run, `oci/.build/exedev/build-evidence.json` still holds the previous run's `buildId`, `builtDigest` and `imageSizeBytes` for an image that no longer resolves under the tag. `tests/fleet/e2e/tier1-image-contract.live.test.ts:69` reads that exact default path for AC7c's size evidence, so the live round can report size/digest evidence for an image that failed its gates.
- **Verified:** read `tests/fleet/e2e/tier1-image-contract.live.test.ts:66-70`; `BUILD_EVIDENCE_PATH` is `oci/.build/exedev/build-evidence.json`, byte-identical to `DEFAULT_EVIDENCE`.

## [MEDIUM] Added-binary coverage is computed by PATH, so a binary REPLACED at the same path is never attributed
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1091`
- **Trigger:** the Dockerfile replaces an executable in place. `oci/exedev/Dockerfile:140-146` does exactly this — `exeuntu update pi --version 0.84.4` overwrites the stock pi tree that the base already ships.
- **Why it matters:** `added = builtBins \ baseBins` is set difference over absolute paths. If the vendor installer lands the new pi at the same paths the base used, pi never enters `added`, `uncoveredBinaries` is never asked about it, and the `pi` entry in `oci/exedev/binary-licenses.json` is dead weight that proves nothing. AC5's negative control silently covers only NEW paths, not new BYTES at old paths — and replacement is the more likely way an unattributed project enters this image, since the Dockerfile's whole pi section is a replacement.
- **Verified:** read `oci/exedev/Dockerfile:140-146`; read `oci/exedev/binary-licenses.json` (entries cover exactly `["bun","bunx"]` and `["pi"]`). Note also `find -type f` excludes the `/usr/local/bin/pi` symlink the Dockerfile asserts at `:144`, so the `pi` entry can only ever be matched via the real ELF's basename.

## [MEDIUM] `package.json` and the systemd asset files are read with unguarded `readFileSync` — an I/O failure exits 1, not 2
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:500` (package.json) and `:490` (each systemd file)
- **Trigger:** `package.json` absent/unreadable, or a systemd asset that `readdirSync` listed but `readFileSync` cannot read (dangling symlink, permissions, a directory entry — `filter((f) => !f.startsWith("."))` does not filter directories).
- **Why it matters:** the throw is uncaught, and bun exits **1** — which the header contract reserves for *"1 compliance failure"*, with 2 reserved for *"fatal before the gates could conclude (no builder, docker failure, missing input)"*. A missing input is reported as a licence/credential compliance failure. This is inconsistent within the same function: `DOCKERFILE` and `SYSTEMD_DIR` ARE explicitly guarded ten lines up (`:471-486`) and correctly `die(2)`.
- **Verified:** read `gatherBuildIdInputs` in full (`:470-511`); confirmed `readBunPin` only guards *parse* failure, never the read.

## [MEDIUM] `writeJson` failures exit 1 after a successful push
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:885-887` (`writeJson`), called at `:1155` and `:1157`
- **Trigger:** `--summary`/`--evidence` pointing at an unwritable directory, a path whose parent is a file, or a full disk. `path.resolve(value)` accepts any string; nothing validates writability, and the calls happen AFTER `--push` has already published.
- **Why it matters:** same contract violation as above, but worse placed: the image is already in the registry, every gate passed, and the run reports exit 1 (compliance failure). The publish workflow's gate step would then never run, and the operator is told the image failed compliance when it did not.
- **Verified:** diff + `parseValueFlags` grammar in `scripts/lib/cli-args.ts:52-88` — it enforces non-empty only, never a path shape.

## [MEDIUM] `sizeOf()` silently records 0 or `null` for the ADR's named falsifier
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1144`, used at `:1185-1186`
- **Trigger:** `docker image inspect` fails for either ref — the base was pulled by the buildx builder rather than the daemon, or was pruned between `listExecutables` and here.
- **Why it matters:** `Number(tryRun(...) ?? 0)` collapses "could not measure" into `0`, and this very file defines `0` as "never evaluated" fourteen lines down (`coldBootMs: 0`, *"a field never evaluated reports 0"*). The size half of AC7c is one of the ADR's two named re-opening falsifiers; recording an un-measurement as a legitimate 0 makes it unfalsifiable in the one direction that matters. Second branch: any non-numeric docker output yields `NaN`, and `JSON.stringify(NaN)` writes `null`, so a consumer typed `imageSizeBytes: number` reads `null`.
- **Verified:** diff; `tryRun` (`:193-200`) returns `null` on empty output, so the `?? 0` path is live.

## [LOW] No SIGINT/SIGTERM handling — an interrupted run leaks a temp tree, a scratch dir, a container and a ~1.6 GB archive
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1040` (`treeDir` mkdtemp), `:566` (`inspectConfigs` scratch), `:626` and `:674` (`docker create`), `:952` (`archive`)
- **Trigger:** Ctrl-C during the multi-minute QEMU build, the export/tar scan, or the push.
- **Why it matters:** `finally` blocks do not run on a signal. Each interrupt leaves a `qds-exedev-tree-*` and possibly a `qds-exedev-scan-*` in `os.tmpdir()`, a stopped `docker create` container pinning the image, and the archive in `oci/.build/exedev/`. The archive is cleaned by the next run (`:954`) and the leaked container is at least *detected* by the `stillThere` check at `:945` with an actionable message — but the temp dirs accumulate silently, and each holds an extracted filesystem.
- **Verified:** grepped for `process.on(` in the file — no signal handlers exist.

## [LOW] `PI_VERSION` and `BUN_VERSION` are duplicated between the script and the Dockerfile defaults, with nothing binding them
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:152` (`export const PI_VERSION = "0.84.4"`) vs `/Users/steve/QDS-Factory/oci/exedev/Dockerfile:99` (`ARG PI_VERSION=0.84.4`), same shape for `BUN_VERSION` at `Dockerfile:70`
- **Trigger:** someone bumps only the `ARG` default in the Dockerfile.
- **Why it matters:** the script always passes `--build-arg PI_VERSION=<its own constant>`, so the Dockerfile default is dead code. Editing it changes the buildId (Dockerfile bytes ARE hashed, `:365`) and therefore the digest, while the image installed is unchanged — a buildId that moved without the substrate moving, which is precisely what `deriveBuildId`'s docblock says must never happen. The build still passes: the Dockerfile's `[ "${pi_observed}" = "${PI_VERSION}" ]` compares against the passed value, not the edited default.
- **Verified:** read `oci/exedev/Dockerfile:70, 99, 275-280`; read the buildId field list at `:355-369`.

## [LOW] Nothing binds `BUN_VERSION` (from `package.json`) to `BUN_SHA256` (pinned in the Dockerfile)
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:500` supplies the version; `/Users/steve/QDS-Factory/oci/exedev/Dockerfile:76` pins the checksum
- **Trigger:** any `packageManager` bump — which the publish workflow's own comment (`:140-142`) says dependabot performs weekly.
- **Why it matters:** the next image build fails inside `sha256sum -c` with a bare checksum mismatch. The Dockerfile calls this intentional-loud (`:73-75`), but the script that *chose* the version says nothing, so the operator sees a checksum error rather than "package.json moved bun to X; re-measure BUN_SHA256". A pre-build comparison is cheap and would name the cause.
- **Verified:** read `oci/exedev/Dockerfile:70-92`; `package.json:9` is `"packageManager": "bun@1.3.13"`, matching the current `ARG BUN_VERSION=1.3.13`.

## [LOW] `inspectConfigs` reports a false credential finding when a candidate path resolves to a directory
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:575-590`
- **Trigger:** a tar entry that `classifyScanPath` returns `"inspect"` for and that is, in-container, a symlink to a DIRECTORY. `docker cp -L` exits 0 and writes a directory at `cfg-<i>`; `readFileSync` throws `EISDIR`; both Unicode spellings fail; `text` stays `null`.
- **Why it matters:** the path is then reported as `"could not read /… — treating as a finding"` and the build dies **1** on a directory that carries no credential. `CONFIG_CANDIDATE_OUTSIDE_DEPS` (`scripts/build-image.ts:71-72`) matches the bare basename `credentials` and any `.pem`/`.key`, so a symlinked directory with one of those names on a stock Ubuntu base trips it. The `entry.endsWith("/")` filter at `:655` excludes directory ENTRIES, not symlinks-to-directories. `EISDIR` is a distinguishable errno and is currently swallowed by the same bare `catch` as a genuine unreadable file.
- **Verified:** read `classifyScanPath` and its regexes at `scripts/build-image.ts:57-95`.

## [LOW] `sourceDateEpoch()` accepts `0` and leading-zero values with no lower bound
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:231`
- **Trigger:** `SOURCE_DATE_EPOCH=0` (or `00000000000`), which is what an unset-but-exported shell variable defaulting through `${VAR:-0}` produces, and what a CI expression evaluating to empty then defaulted yields.
- **Why it matters:** `/^[0-9]{1,11}$/` guards only the millisecond mistake the docblock names. `0` passes, so `builtAt` bakes `1970-01-01T00:00:00.000Z` into `/etc/qds-image.json` and every layer mtime lands at the epoch. The build is still reproducible, so no gate fires — the marker just carries a build date that is provably wrong, on the same field the docblock argues must be a function of the source.
- **Verified:** diff; the workflow always supplies a real `git log -1 --format=%ct`, so this is operator/local-path only.

## [LOW] The NOTICE is written before the credential gate runs
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1083` (write) vs `:1085` (`if (scan.findings.length > 0) die(1, …)`)
- **Trigger:** any INV-IBOX-1 finding — a credential path, a secret-shaped layer-history line, or an unreadable config.
- **Why it matters:** the header states *"Nothing is tagged until every check has passed, so a build that tripped a gate leaves no artifact behind."* `oci/.build/exedev/NOTICE` is an artifact, freshly written, describing an image that failed a credential gate. Two lines of reordering (run the findings gate before the NOTICE write) closes it.
- **Verified:** diff, confirmed ordering against the real file line numbers.

## [LOW] The `--tag` value is never shape-validated before it is baked into the marker and interpolated into the `--output` CSV
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:854-883` (`parseArgs`), consumed at `:968` (`QDS_IMAGE_REF`) and `:1010` / `:1114` (`--output type=image,name=${opts.tag},…`)
- **Trigger:** `--tag=--push` (the `=` form explicitly accepts flag-looking values — `scripts/lib/cli-args.ts:19`), or any tag containing a comma or `=`.
- **Why it matters:** `--output` is a comma-separated `key=value` CSV, so a comma in the tag injects exporter options into a solve whose whole purpose is a controlled, reproducible export; an `=` splits a key. The value also becomes `QDS_IMAGE_REF` in `/etc/qds-image.json`, which boxes read as identity. Secondary: `parseArgs` filters `--push`/`--keep-tree` out of argv (`:865`) BEFORE `parseValueFlags` sees it, so `--tag --push` errors with "requires a non-empty value" while `opts.push` is already `true` — the diagnostic does not mention that `--push` was consumed as a filter, not as a value.
- **Verified:** read `scripts/lib/cli-args.ts` in full; the `=` branch (`:57-70`) checks only non-emptiness and never rejects a `--`-prefixed value, by documented design.

## [LOW] `docker create` output is trimmed and used as a container id with no shape check
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:626` and `:674`
- **Trigger:** any docker version or configuration that writes a note to **stdout** on create (platform-mismatch warnings, deprecation notices, credential-helper chatter).
- **Why it matters:** `cid` becomes a multi-line string that is then `shQuote`'d into the export pipeline at `:635` and interpolated as `${cid}:/${variant}` in `docker cp` at `:575`. Every other identifier in this file is regex-validated against its expected shape (`manifestDigest` at `:414`, `builtDigest` at `:1025`, `imageId` at `:1035`, both git values) with an explicit rationale that a plausible-looking blob is worse than none — `cid` is the one that is not. Failure surfaces as an opaque docker error rather than "docker create said something unexpected".
- **Verified:** diff; contrasted against the four sibling validations in the same file.

## [LOW] The post-push `RepoDigests` fallback can supply a STALE digest that is then reported as a supply-chain compliance failure
- **File:** `/Users/steve/QDS-Factory/scripts/build-exedev-image.ts:1121-1124`, consequence at `:1136`
- **Trigger:** `manifestDigest(opts.tag)` returns `null` (registry unreachable, imagetools auth expired mid-run, `{{json .Manifest}}` unsupported on an older buildx) while the local daemon happens to hold a `RepoDigests` entry for that tag from an earlier `docker pull`.
- **Why it matters:** `digest` is then an OLD registry digest, `digest !== builtDigest` fires, and the script dies **1** with *"the pushed digest is not the digest the gates read … the swept, scanned and attributed image is not the image now under the tag"*. That message asserts a supply-chain compromise; the actual cause is a failed registry read. The fallback exists to survive a read failure but has no way to state that it took the fallback, and the evidence JSON records the stale value as `imageDigest`/`pinShape: "digest"`.
- **Verified:** diff; `tryRun` returns `null` when `docker image inspect --format '{{index .RepoDigests 0}}'` errors on an empty slice, so the null-case is handled — the non-null-but-stale case is the unhandled one.
