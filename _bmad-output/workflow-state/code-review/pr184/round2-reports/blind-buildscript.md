# Blind Adversarial Review — chunk-buildscript.diff

Scope: diff-only review of `scripts/build-exedev-image.ts`, `tests/scripts/build-exedev-image.test.ts`, `tests/scripts/exedev-bun-pin.test.ts`. All line references are DIFF-RELATIVE (line numbers of `/tmp/pr184-r2/chunk-buildscript.diff`).

---

## F1 [HIGH] Signal/exit handlers are module-import side effects — every test run inherits them

**Location:** diff lines 93–102 (`process.on("exit", sweepLeaks)` and the SIGINT/SIGTERM loop), contrasted with diff lines 1188–1196 (the tail comment: "Guarded so … can be unit-tested by importing this module; running the script directly is unaffected") and lines 21–24 (the same file's stated import-safety philosophy).

**Defect:** The leak registry's handlers are registered at module top level, outside the `import.meta.main` guard. Both new test files import this module. Importing therefore installs, into the test-runner process: (a) a process-wide `exit` hook that shells out to `docker rm` over the registry, and (b) SIGINT/SIGTERM handlers that call `process.exit(130/143)`. The file's own comments claim importing runs nothing.

**Failure scenario:** `bun test` imports the module to test `deriveBuildId`. A developer presses Ctrl-C mid-suite, or CI sends SIGTERM on timeout. This module's handler fires, calls `sweepLeaks()` (spawning `docker` in a unit-test process), and immediately `process.exit(130)`s — preempting the runner's own signal handling, teardown, and result reporting. Any other script that imports an exported helper (`metadataDigests`, `tarUnescape`, …) silently inherits the same global signal behavior, including having its SIGTERM converted into an unconditional hard exit. The handlers are exactly the kind of import side effect the docblock two screens up (lines 21–24) declares this codebase avoids.

---

## F2 [MEDIUM] `assertCid`'s failure path leaks the container it was invented to track

**Location:** diff lines 533–543 (`assertCid`).

**Defect:** `assertCid` is called on the stdout of a **successful** `docker create` (the `run(…)` wrapper has already accepted exit 0). If the stdout fails the 64-hex check, `assertCid` calls `die(2, …)` **before** the `leaked.containers.add(cid)` line and before any caller `try/finally` is entered. The container that `docker create` just made is real; its id is merely obscured by extra stdout. Nothing removes it, nothing registers it, and `die` skips `finally` — so the exit-handler sweep has nothing to sweep.

**Failure scenario:** The docblock's own motivating case — a docker that prints a platform-mismatch warning or credential-helper chatter on create — trips the check on every run. Each run leaks one stopped container holding a reference to the image. Per the leak-registry docblock (lines 63–68), that is precisely the condition the preflight at the top of `main` refuses to run under ("remove the containers holding it"). The validator added to prevent opaque downstream failures manufactures the persistent-leak condition the registry exists to prevent, and does so repeatably.

---

## F3 [MEDIUM] Per-run temp dirs trade self-healing for accumulation on the exits the handlers cannot see

**Location:** diff lines 986–997 (`runDir = fs.mkdtempSync(path.join(BUILD_DIR, "run-"))`, "A fresh directory also removes the pre-clean these two needed"), and the handler coverage claim at lines 70–75.

**Defect:** The old design used fixed paths (`exedev.docker.tar`, `build-metadata.json`) pre-cleaned at the start of every run — self-healing against *any* prior death, including ones no handler can observe. The new design creates a unique `run-*` dir per invocation and relies entirely on `finally` / the exit hook / SIGINT/SIGTERM handlers to remove it. SIGKILL, OOM-kill, power loss, and SIGHUP (no handler is registered for it, and no `exit` event fires) all bypass every cleanup path, and the next run creates a *new* dir rather than reclaiming the old one. No sweep of stale `run-*` dirs exists anywhere in the diff.

**Failure scenario:** A CI runner OOM-kills the ~10-minute build (the docblock itself calls the archive ~1.6 GB). Each retry strands another ~1.6 GB under `BUILD_DIR`. The handler docblock argues Ctrl-C "is not an exotic case" for a ten-minute build — a dropped ssh session (SIGHUP) during the same ten minutes is equally unexotic and is silently uncovered. The old fixed-path design leaked at most one archive ever; the new one leaks one per unclean death, unboundedly.

---

## F4 [MEDIUM] The EISDIR carve-out turns a fail-closed credential check fail-open, on a false premise

**Location:** diff lines 493–516 (`inspectConfigs`: `isDir` flag, `if (isDir && text === null) continue;`), including the comment "a directory by one of those names … cannot carry a credential at all".

**Defect:** Previously, any unreadable candidate produced "could not read /p — treating as a finding" (fail closed, possibly noisy). Now an EISDIR silently `continue`s. Two problems:

1. The premise is false as stated: a *directory* named `credentials` (or `foo.pem/`) absolutely can carry credentials — as files inside it. Those interior files are only caught if their own basenames independently match a candidate pattern; `credentials/token` would not.
2. The two-variant loop reuses one `dest` per candidate. If the first spelling resolves to a directory (`docker cp` succeeds, read gives EISDIR, `isDir = true`), the second spelling — a genuine credential **file** — is `docker cp`'d *into* the now-existing directory `dest` (docker copies into an existing dir), so `readFileSync(dest)` throws EISDIR again, `text` stays null, and the `isDir && text === null` branch silently skips a real file.

**Failure scenario:** An image ships `/etc/ssl/private.pem` as an NFD-named directory alongside an NFC-named credential file (the exact Unicode-collision territory this function's own dedup comment worries about), or simply a `credentials/` directory holding a token file with a non-matching basename. The old code raised a finding; the new code greens it. On a credential gate, a silent pass is the one outcome the file's own doctrine (line 633: "A vacuous pass on a credential gate is the one outcome that must never look like a green one") forbids.

---

## F5 [MEDIUM] The metadata-digest guard does not cover its own documented burn case: a single flat key holding the wrong exporter's digest

**Location:** diff lines 917–942 (`metadataDigests` docblock), 1020–1041 (caller: `digests.get("image") ?? (distinct.size === 1 ? [...distinct][0]! : null)`).

**Defect:** The docblock states the flat `containerimage.digest` "describes whichever exporter buildx decided to report" and that recording the docker-archive digest as the registry digest is the *worse* failure ("the post-push equality then fails on every push, reporting a build-tooling mismatch in the words of a supply-chain compromise"). But the caller's guard only fires when *several distinct* digests are present with none attributable to `image`. When buildx writes exactly one flat key — the shape the docblock says is ambiguous — `distinct.size === 1` accepts it unconditionally. The comment "When buildx reports one digest, there is nothing to disambiguate" conflates "no data to disambiguate with" and "nothing ambiguous": the build declares two exporters either way.

**Failure scenario:** A buildx version reports the flat key populated from the `type=docker` exporter (the tar's manifest digest) on this two-`--output` build. `builtDigest` becomes a digest no registry resolves; the post-push equality then fails on every push with the supply-chain-worded message — the exact outcome the whole `metadataDigests` addition claims to have retired.

---

## F6 [MEDIUM] `tarUnescape` iterates code units on its non-escape path, contradicting its own "decoded through BYTES, not code units" claim

**Location:** diff lines 548–580 (`tarUnescape`), especially line 562: `bytes.push(...Buffer.from(c, "utf8"))` where `c = entry[i]` is a single UTF-16 code unit.

**Defect:** For any character outside the BMP, `entry[i]` yields a lone surrogate; `Buffer.from(loneSurrogate, "utf8")` encodes it as U+FFFD (EF BF BD). So a path containing both a backslash (which forces the function past the early return) and an astral character (emoji, rare CJK, etc.) is corrupted into replacement characters. The docblock's entire argument is that per-code-unit decoding produces mojibake that makes `docker cp` miss files and raises phantom findings — and the function commits a variant of the same sin one branch over. (Iterating with `for (const ch of entry)` or building from `Buffer.from(entry)` and splicing would not have this property; the tests cover only 2-byte BMP characters like `ő`, so the suite cannot see it.)

**Failure scenario:** GNU tar in a UTF-8 locale lists `usr/share/emoji-📁/file\ with\ backslash` (backslash escaped, emoji passed through raw). The entry contains `\\`, so the decoder runs; the emoji becomes `��`; the classified path no longer names a real file; if it matched a config candidate, `docker cp` misses it and the gate raises "could not read … — treating as a finding" (exit 1) on a clean image — the "126 phantom findings" regression class the docblock says this function exists to prevent.

---

## F7 [MEDIUM] The tag-injection guard — the diff's headline security fix — has zero test coverage

**Location:** diff lines 34–51 (`TAG_RE` and its docblock), 887–894 (enforcement in `parseArgs`); absence: nothing in either test file touches `TAG_RE`, `parseArgs`, or any tag string.

**Defect:** The docblock claims `--tag 'ghcr.io/x/y:v1,push=true'` would make the pre-gate build publish, and that the grammar "refuses `,` and `=` by construction". That claim rests on a ~300-character regex, and not one test asserts it: not the accept side (does `DEFAULT_TAG` pass? host:port forms? digest-only refs?) nor the reject side (comma, `=`, uppercase path, empty string). Every other new export in this diff (`tarUnescape`, `metadataDigests`, `resolveRuntimeBaseRef`, `dockerfileArgDefault`) received a dedicated suite; the one function whose failure mode is "the pre-gate build publishes to a registry" received none. `parseArgs` as a whole — including the `tokenizeArgs` migration whose docblock describes a real prior mis-parse (`--tag --push` silently enabling push) — is likewise untested.

**Failure scenario:** A future edit relaxes the regex (say, to admit an uppercase path segment someone hit in practice) and inadvertently opens a character class that admits `,`. No test fails. The next mistyped `--tag` with an exporter attribute publishes an ungated image, through the exact hole the comment block says is closed "by construction".

---

## F8 [LOW] The "every declared input has a mutation case" tripwire tests the fixture, not the type

**Location:** diff lines 1289–1300 (test: `expect(Object.keys(baseInputs()).sort()).toEqual([...])`), with the comment "This fails the moment the shape grows".

**Defect:** The assertion inspects `baseInputs()` — an object literal defined in the test file — not `BuildIdInputs`. It fails only when someone *edits the fixture*. An **optional** field added to `BuildIdInputs` (`extraPins?: string[]`) compiles cleanly with the untouched fixture, the keys assertion still passes, and the field is hashed (or not hashed) with no test noticing — the exact scenario the comment claims this test intercepts. The tripwire only works for required fields, where the TypeScript compiler, not this test, is doing the actual enforcement.

**Failure scenario:** DF1.10 adds an optional `engineVersion?` input consumed by `deriveBuildId` when present. No mutation row exists, the keys test is green, and two substrates differing only in engine version share a buildId — the "single thing the docstring says this value exists to prevent", undetected by the test that advertises detecting it.

---

## F9 [LOW] The content-hash diff is still blind to symlinked executables and permission-only changes, while its docblock claims the failure direction is "never fewer"

**Location:** diff lines 743–786 (`listExecutables` docblock and the `find / -xdev -type f -perm -u+x -exec sha256sum {} +` command), 1109–1114 (the path-or-content diff).

**Defect:** Two residual false-negative classes sit inside a function now documented as the thing that "makes AC5's negative control a control": (1) `-type f` excludes symlinks, so an executable that enters the image *as a symlink* (an installer that links `/usr/local/bin/tool → /opt/vendor/tool` where the target is outside `-perm -u+x` visibility or on the base) never enters the built set at all; (2) a base binary whose bytes are unchanged but whose mode changed (e.g. a setuid flip) hashes identically and reads as not-added. The docblock's claim that "the failure direction of the change is 'more binaries need attributing', never fewer" is true only relative to the previous path-only diff, but the surrounding prose presents the map as "Executables in an image", which it is not.

**Failure scenario:** A vendor installer ships its real binary at an attributed path and adds an unattributed second entry point as a symlink; the diff never lists it, `uncoveredBinaries` never sees it, and it ships unattributed — a shape of AC5's named failure the reworked control still cannot observe.

---

## F10 [LOW] The sha256sum name-unescape silently rewrites escape pairs it doesn't know, instead of dying like every other unparseable line

**Location:** diff lines 812–821, specifically `raw.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c))`.

**Defect:** The decoder handles `\n` and `\\` and maps *any other* escaped pair `\x` to the bare character `x` — silently. The adjacent code takes the opposite stance for the line as a whole: "An unparseable line is fatal for the same reason a partial listing is — dropping it silently removes a binary from the set." Coreutils' escaping repertoire is not frozen (newer releases escape `\r` as well); a `\r` pair would decode to a literal `r`, corrupting the recorded path. Because both listings corrupt identically the diff arithmetic survives, but the path reported to the operator (and fed to `uncoveredBinaries` and the licence table) names a file that does not exist — precisely the "plausible-looking blob is worse than none" failure this file's other validators are built around.

**Failure scenario:** An added binary at `/opt/x/tool\rname` is reported uncovered as `opt/x/toolrname`; the operator goes to find it, cannot, and the table entry written to satisfy the gate names a path the image does not contain.

---

## F11 [LOW] `resolveRuntimeBaseRef` falsely reports a cycle for a stage named after its own base image

**Location:** diff lines 286–302, the chase loop with `seen`.

**Defect:** `FROM alpine AS alpine\nFROM alpine` is legal Docker (a later `FROM alpine` resolves to the *stage*, which derives from the *image* `alpine`). Here `stageBase` maps `alpine → alpine`; the chase visits `alpine`, adds it to `seen`, resolves to `alpine` again, sees it in `seen`, and returns null — reported to the operator as "cannot determine which image the FINAL stage derives from" and made fatal. The self-referential mapping is not a cycle in Docker's semantics; the resolution bottoms out at the image after one hop. It fails closed rather than open, but it refuses a valid Dockerfile with a diagnosis ("give the final stage a literal FROM") whose suggested fix — `FROM alpine` — is already what the file says.

**Failure scenario:** DF1.10 introduces a builder stage named for readability after the base it wraps; the build becomes permanently fatal with an instruction the operator has already followed, and nothing in the test suite (which covers only genuine two-stage cycles) names the case.

---

*Findings only, per instructions. Ten of eleven findings are in the script; F7/F8 concern the tests. Nothing above required repository context beyond the diff's own text.*
