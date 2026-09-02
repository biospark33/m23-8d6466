# W1-B fix report — `scripts/build-exedev-image.ts`, `tests/scripts/exedev-bun-pin.test.ts`

Round 1, PR #184 (DF2.10). 25 findings owned. **24 fixed, 1 deferred (with reason), 1 partial
false-positive corrected-in-place.** No commits, no `git add`.

## Gitnexus blast radius

`mcp__gitnexus__impact` returns `Target '<name>' not found` for `readBunPin`,
`uncoveredBinaries` and `gatherBuildIdInputs` against repo `/Users/steve/QDS-Factory` — the index
predates this PR and does not carry `scripts/build-exedev-image.ts` at all. **The index is stale
for every symbol in my cluster**, so blast radius was established by exhaustive grep instead
(recorded per symbol below). Someone should reindex via `bash scripts/install-gitnexus-plus.sh`
before the next round; the impact tool is currently silently answering "no callers" for a file it
has never seen, which is the worst possible failure mode for the CLAUDE.md rule that requires it.

Grep-established radius — `grep -rn 'from ".*build-exedev-image' --include=*.ts .`:

| Symbol | External consumers | Risk |
|---|---|---|
| `readBunPin` | `tests/scripts/exedev-bun-pin.test.ts` only (my file) | LOW — signature unchanged, failure mode changed (see below) |
| `listExecutables` | none (module-private) | LOW |
| `uncoveredBinaries` | none outside this module | NONE — signature unchanged |
| `parseBaseRefs` | none | LOW — behaviour byte-identical, body refactored onto `fromInstructions` |
| `PI_VERSION`, `deriveBuildId`, `nodeModulesRoot`, `validateBinaryLicenses` | none | untouched / additive |
| the module as a whole | `.github/workflows/publish-exedev-image.yml` invokes it as a CLI (W1-A's file) | see "flags for W1-A" |

Nothing is HIGH or CRITICAL. `scripts/build-exedev-image.ts` has exactly one importer in the repo
and it is the test file I also own.

## Findings

| ID | Verdict | What changed |
|---|---|---|
| B1 | **fixed** | New `die(1)` gate on `sweep.unreadable` / `unresolved` / `missingTexts`, immediately after the `treePackageCount` gate. Verified against `license-sweep.ts:137-144` — both documented as fail-closed refusals; neither was read anywhere in this file. |
| B2 | **fixed** | Both `docker cp` calls in `extractNodeModules` take `-L`. Verified the chain: `license-sweep.ts:288-296` pushes a dangling symlink to `unreadable`, `treePackageCount` is `entries.length` (`:575`), and the AC5 gate is `> 0`. Confirmed the sibling `inspectConfigs` already used `-L` with a docblock saying why. |
| B3 | **fixed** | `imageSourceSha()`'s git path now validated as 40 hex against the same `fortyHex` as the env path, `die(2, …)` otherwise. The literal `"unknown"` is gone. |
| B4 | **fixed** | New `TAG_RE` (docker reference grammar) enforced at the end of `parseArgs`, i.e. before `docker rmi -f ${opts.tag}`. Refuses `,` and `=` by construction. This also closes "force-removes an unrelated local image on a typo" (blind LOW). |
| B5 | **fixed** | New exported `resolveRuntimeBaseRef(dockerfile)` chases stage aliases to the image the FINAL stage bottoms out at; `null` (cycle / `scratch` / no FROM / not in `baseRefs`) is `die(2, …)`. `parseBaseRefs` refactored onto a shared `fromInstructions` helper with byte-identical behaviour. |
| B6 | **fixed** | Module-level `leaked = { containers, paths }` registry + `sweepLeaks()` run from `process.on("exit")` and from SIGINT/SIGTERM handlers (exit 130/143). `die` is untouched. Containers register in `assertCid` and deregister in each `finally`; `treeDir` and the new per-run dir register on creation. `--keep-tree` deliberately does NOT register `treeDir` — a gate failure is exactly when someone wants the tree. |
| B7 | **fixed** | New exported `metadataDigests(meta)` collects every `containerimage.digest` the metadata file carries, in all three shapes (flat, `"<exporter>.containerimage.digest"`, nested `{ image: { … } }`). Picks the `image` exporter, else the single distinct value, else `die(2)` naming the cause, listing the keys seen, and stating explicitly that this is a build-tooling mismatch and not a supply-chain finding. Metadata read failure is now its own `die(2)` too. |
| B8 | **fixed** | `gatherBuildIdInputs` now also returns `runtimeBasePinned` (`ref@sha256:…`, the digest the buildId hashed). `listExecutables` and `sizeOf` for the base both use it, so the negative control diffs the bytes the buildId recorded rather than whatever the local daemon holds. |
| B9 | **fixed** | The accept path in `ensureReproBuilder` reads `Driver:` out of the plain inspect report (not `--format`, which this file already documents as silently ignored by imagetools) and `die(2)`s on anything but `docker-container`, telling the operator to `docker buildx rm`. |
| B10 | **fixed** | On a failed `create`, a second `inspect` distinguishes "absent" from "present but broken"; the broken case prints `docker buildx rm … && docker buildx create …` instead of the create that just failed. |
| B11 (Q-6) | **fixed** | `listExecutables` now returns `Map<path, sha256>` (`find … -exec sha256sum {} +` through `/bin/sh`), and `added` is `built.filter(([p, sha]) => base.get(p) !== sha)`. Public signature of `uncoveredBinaries` and the shape of `addedBinaries` in the evidence JSON are unchanged. See "newly-uncovered binaries" below. |
| B12 | **fixed** | `archive` and `metadataFile` moved into a per-run `mkdtemp` under `oci/.build/exedev/run-*` (already gitignored via `oci/.build/`), registered for teardown and removed in `main`'s `finally`. The two pre-run `rmSync`es they needed are gone. |
| B13 | **fixed** | The `RepoDigests` fallback is deleted. A failed registry read is `die(2)` with a message that says the registry read failed. |
| B14 | **fixed** | `opts.summary` and `opts.evidence` are dropped alongside the NOTICE before the build, so a failed run cannot leave a previous run's digest/size for `tier1-image-contract.live.test.ts` to read. |
| B15 | **fixed** | New `readInput(file, why)` helper: every `readFileSync` in `gatherBuildIdInputs` (Dockerfile, each systemd asset, `package.json`) is guarded and `die(2)`s, matching the `:471-486` precedent. |
| B16 | **fixed** | `writeJson` wrapped; an I/O failure is `die(2)` and says "every gate passed; this is a fatal I/O failure recording the result, not a compliance failure". |
| B17 | **fixed** | `sizeOf` returns `number \| null`; a failed/NaN/zero inspect records `null`, never `0`. Verified `tier1-image-contract.live.test.ts:119-120` already guards with `typeof … === "number"`, so it degrades to its own documented "never evaluated" 0 rather than breaking. |
| B18 | **fixed** | Two changes: `validateBinaryLicenses` is now total (`typeof raw === "object" && raw !== null`), and `main` `die(2)`s on a non-object/array parse before calling it — so a malformed input FILE is exit 2, per the contract, while the exported function stays throw-free for the test wave. |
| B19 | **fixed (finding was a latent-risk, not a live bug)** | Checked the real declaration: `scripts/build-image.ts:83-84`, `SECRET_ENV = /…/i` — **non-global, so `.test` in a loop is stateless today and there is no live false negative**. Fixed anyway as instructed, with a comment saying exactly that: `scanImage` now builds a local `new RegExp(SECRET_ENV.source, SECRET_ENV.flags.replace(/[gy]/g, ""))`, so adding `g` one module over cannot silently halve a credential gate's coverage. |
| B20 | **fixed** | The `/nothing to sweep/` prose match is deleted. `sites.length === 0` returns `emptySweep()` structurally (nothing was extracted, so there provably is no tree); a throw from a tree we DID extract is now fatal and names the sites. **Behaviour change — see below.** |
| B21 | **fixed** | `parseArgs` uses the existing `tokenizeArgs` from `scripts/lib/cli-args.ts` (`boolFlags: ["--push", "--keep-tree"]`) instead of `argv.includes` + a filter. No new parsing code. |
| B22 | **fixed, with a probe** | `--quoting-style=escape` is **not available on this host**: `tar --version` here is `bsdtar 3.5.3` and the probe exits 1 (measured). It is a GNU-tar-only option and the listing runs on the HOST, not in a container, so using it unconditionally would break every macOS build. So it is probed once per run and used when present (GNU tar = the CI/publish path, where it matters), with a new exported `tarUnescape` that decodes through **bytes** — GNU tar renders non-ASCII as `\NNN` octal under a C locale, and a per-code-unit decode would mojibake the `/etc/ssl/certs` UTF-8 names and re-create the 126-phantom-findings regression `inspectConfigs` was already fixed out of once. Without GNU tar the split is unchanged (mis-splits, never silently passes). |
| B23 | **fixed** | `--entrypoint /usr/bin/find` → `--entrypoint /bin/sh` + `-c 'exec find …'`, so `find` resolves through the container PATH; the failure message no longer points at stderr from a process that never started. |
| B24 | **fixed** | `SOURCE_DATE_EPOCH` well-formedness is `/^[1-9][0-9]{0,10}$/` — `0` and leading zeros refused, message updated. |
| B25a — ARG binding | **fixed** | New exported `dockerfileArgDefault(dockerfile, name)`. `gatherBuildIdInputs` compares `BUN_VERSION` and `PI_VERSION` against the Dockerfile's `ARG` defaults **before** `parseBaseRefs`/registry resolution and before the build, and `die(2)`s naming the cause — the `BUN_VERSION` arm explicitly says to re-measure `ARG BUN_SHA256`. Dockerfile NOT edited. |
| B25b — `inspectConfigs` EISDIR | **fixed** | `EISDIR` is distinguished from a genuine read failure and skipped (a directory carries no credential). Everything else still fails closed. |
| B25c — NOTICE ordering | **fixed** | `if (scan.findings.length > 0) die(1, …)` now runs BEFORE `renderNotice`/`writeFileSync(NOTICE_PATH)`. |
| B25d — `docker create` cid | **fixed** | New `assertCid(raw, label)`: `/^[0-9a-f]{64}$/` or `die(2)`, matching the four sibling validations. It is also where containers enter the leak registry. |
| `readBunPin` testability | **fixed** | New exported `class BunPinError extends Error { lines }`. `readBunPin` throws it; `gatherBuildIdInputs` catches and `die(2, err.lines)`. All four rejection paths are now assertable. |
| B11's second half — `uncoveredBinaries` matches on basename only | **DEFERRED** | Real (a new `/opt/vendor/bash` reads as covered by an entry naming `bash`). Not fixed: full-path matching requires `oci/exedev/binary-licenses.json`'s `names[]` to become paths, and that file is W1-E (lead-owned). Fixing one side alone fails every build. Recommend landing it with the E1/E2 edits or in round 2. |

## Intentional behaviour changes — for the test wave (W2-D)

1. **`readBunPin` throws `BunPinError` instead of `die(2)`.** Its one caller exits. Any future
   caller must catch. (Exported: `BunPinError`.)
2. **`listExecutables` returns `Map<path, sha256>`, not `Set<path>`.** Module-private; `added`,
   `uncoveredBinaries` and the evidence JSON keep their existing shapes. Costs one sha256 pass over
   the executables of two images per build (a few seconds; not the ten QEMU minutes).
3. **`added` is now a path **or content** difference.** Strictly more binaries can require
   attribution; never fewer.
4. **`sweepImageTree` no longer swallows a `sweepTree` throw when a tree WAS extracted.** Previously
   any error whose text matched `/nothing to sweep/` returned a clean empty sweep. Now: no sites →
   `emptySweep()`; sites present and the sweep throws → `die(2)`. Edge case that flips: an image with
   a `node_modules` containing only dot-files (e.g. a lone `.package-lock.json`) used to pass
   vacuously and now fails closed. That is the intended direction.
5. **`imageSizeBytes` / `baseImageSizeBytes` can be `null`.** `tier1-image-contract.live.test.ts`
   already guards with `typeof === "number"` (verified at `:119-120`), so it records its documented 0.
6. **Fatal where it used to be silent:** no git (`imageSourceSha`), `SOURCE_DATE_EPOCH=0`,
   a `qds-repro` on the wrong driver, an ambiguous `containerimage.digest`, an undeterminable final
   stage, a `BUN_VERSION`/`PI_VERSION` divergence from the Dockerfile `ARG` defaults, an unparseable
   `sha256sum` line, a non-64-hex `docker create` id, an invalid `--tag`. All `die(2)`.
7. **New exports for W2-D to cover:** `resolveRuntimeBaseRef`, `dockerfileArgDefault`, `tarUnescape`,
   `metadataDigests`, `BunPinError`.
8. **Artifact paths moved:** `oci/.build/exedev/exedev.docker.tar` and `build-metadata.json` are now
   `oci/.build/exedev/run-XXXXXX/…`. Nothing in the repo referenced either (grepped). The NOTICE,
   summary and evidence default paths are unchanged.

## Flags for W1-A (workflow owner) — do not act on these myself

- The workflow must keep invoking the script with a `--tag` that satisfies a docker reference
  grammar; `${IMAGE}:sha-${src_sha}` does. A tag assembled from an unvalidated workflow input would
  now `die(2)` rather than injecting `--output` attributes.
- `QDS_GIT_SHA` is now **mandatory** in any environment without a working `git rev-parse HEAD`. The
  workflow already sets it; a container-based rebuild without `.git` would now fail loudly (which is
  the point) rather than shipping `gitSha:"unknown"`.
- B25a means a `packageManager` bump in `package.json` now fails the build with a named cause at
  second zero instead of a bare `sha256sum -c` mismatch ten QEMU minutes in. Pairs with A2.

## Newly-uncovered binaries (B11)

**None can be enumerated without a build, and I did not run one (ten QEMU-emulated minutes,
explicitly out of scope).** What the change will surface, from reading `oci/exedev/Dockerfile:99-146`:

- `RUN rm -rf /home/exedev/.local/pi … && exeuntu update pi --version 0.84.4` replaces the stock pi
  tree **at the same paths**. Every executable under `/home/exedev/.local/pi/` whose bytes differ
  from the base's will now enter `added` for the first time. If the real ELF's basename is `pi`, the
  existing `["pi"]` entry covers it; **anything else the vendor's 0.84.4 tree ships as an executable
  (a bundled runtime, a helper) will be newly uncovered and will stop the build.**
- `install … bun /usr/local/bin/bun` is a new PATH and was already covered.
- `chown -R` does not change content, so it produces no false positives.

**Action for the lead:** the first `bun scripts/build-exedev-image.ts` run after this lands will
either pass or print `this image adds N executable(s) with no entry in
oci/exedev/binary-licenses.json:` followed by the exact list. That list is the `binary-licenses.json`
update; I did not touch that file (W1-E).

## Gate output

- `bunx tsc --noEmit` → **exit 0** (`/tmp/fix-buildscript-tsc.log`, run with all parallel agents'
  in-flight edits present).
- `bunx @biomejs/biome check scripts tests/scripts` → **"Checked 44 files. No fixes applied."**
- `bun test tests/scripts/` → 322 pass / 2 skip / **1 fail** (`/tmp/fix-buildscript-test.log`).
  The single failure is `install-gitnexus-plus.sh — EMBEDDINGS_FLAG branch (#74, PR #90)`, a
  5-second subprocess-budget shell test that **is flaky on this loaded host and is not mine**:
  - reverted my hunk (`git stash push -- scripts/build-exedev-image.ts tests/scripts/exedev-bun-pin.test.ts`)
    and ran that file alone at baseline → **same failure, exit 143 (SIGTERM), same arm**;
  - across runs it fails a *different* arm each time (`Darwin x86_64 runs analyze WITHOUT
    --embeddings`, then `Darwin x86_64 emits NO empty-string positional`, then `Linux x86_64
    includes --embeddings`) and once passed clean;
  - a `kill-tree.test.ts` timing assertion also failed once under load and passed on two isolated
    re-runs. Verified it signals a *spawned child* (`harness.kill("SIGINT")`, `kill-tree.test.ts:208`),
    never the test process, so my new SIGINT/SIGTERM handlers cannot reach it.
  - Baseline full-suite run with my hunk stashed: **319 tests, 0 fail** — my six new tests account
    for the 319→325 count.
- `tests/scripts/exedev-bun-pin.test.ts` alone: **10 pass / 0 fail**.
- Pure-function checks run through `bun -e` (not committed — W2-D owns
  `tests/scripts/build-exedev-image.test.ts`): `resolveRuntimeBaseRef` on the real Dockerfile agrees
  with the old heuristic and diverges correctly on `FROM a AS r / FROM b AS x / FROM r` (returns
  `a`, old code returned `b`), on the dedup-collapse shape, and returns `null` for cycle / `scratch`
  / no-FROM; `tarUnescape` round-trips `\n`, `\305\221` → `ő`, `\\`; `metadataDigests` handles all
  three shapes and rejects a non-digest; `validateBinaryLicenses(null)` and `([])` return one problem
  instead of throwing; the real `binary-licenses.json` still validates clean; `TAG_RE` accepts the
  five real tag shapes and rejects `…:v1,push=true`, `…:v1,dest=/tmp/x`, `--push`, `x/y=z:v1`,
  uppercase and embedded space. All pass.
- **No docker build was run.**

## New tests (`tests/scripts/exedev-bun-pin.test.ts`)

10 tests. Kept the three accepting cases; replaced the "only accepting paths are exercised" docblock;
added the four rejection paths (unparseable JSON, absent `packageManager`, non-string
`packageManager`, non-bun manager, and `bun@latest`/`bun@` for the version-shape refusal); replaced
`/^[0-9A-Za-z.-]+$/` (a charset check that accepts `"bun"` and `"-"`) with `/^\d+\.\d+\.\d+/`; and
added an assertion that the captured pin **equals** `dockerfileArgDefault(dockerfile, "BUN_VERSION")`
plus a shape check on `ARG BUN_SHA256`, so the lockstep the build now enforces also fails in a second
without docker.
