# FIX-BUILDSCRIPT

PR #184, branch `feature/df2.10`, review round 4. Files touched (only these):
`scripts/build-exedev-image.ts`, `tests/scripts/build-exedev-image.test.ts`,
`tests/scripts/exedev-bun-pin.test.ts`, `oci/exedev/binary-licenses.json` (the
`paths` field only — see Cross-file needs).

gitnexus `impact(direction: "upstream")` was run before editing each named
symbol. **All LOW risk, no HIGH/CRITICAL** — every caller is inside this module
plus its two test files: `parseBaseRefs` 1, `nodeModulesRoot` 1,
`uncoveredBinaries` 1, `validateBinaryLicenses` 1, `dockerfileArgDefault` 2,
`manifestDigest` 2 direct / 8 transitive (one affected process, `main`, same
file). Nothing outside `scripts/`+`tests/scripts/` imports any of them
(`src/`, the workflows and the live tests import only `PI_VERSION`,
`readBunPin`, `DEFAULT_TAG`).

## Patched

| ID | File:line | What changed | Why |
|----|-----------|--------------|-----|
| B1 | `scripts/build-exedev-image.ts:1441` (new `redactAssignments`), used at `:1489` | New exported `redactAssignments(line)` rewrites every `NAME=value` on a layer-history line to `NAME=<redacted>`; the INV-IBOX-1 history finding now quotes the redacted line. | `SECRET_ENV` matches *because* a value follows, and `die(1, scan.findings)` writes findings to stderr → the build log, which GitHub masks only for `secrets.*`. The one finding in the file that reported content was publishing the credential it had just caught. Redacts **every** assignment, not only the secret-shaped one (a non-matching name can hold the matching name's value); the character class is a superset of `SECRET_ENV`'s, asserted against the detector itself in a test. Flag values (`--prefix=/usr/local`) survive, so the layer stays readable. |
| B2 | `:2274-2300` (digest selection), `:2545` (evidence) | On a **non-push** run only an explicitly scoped `image` digest is accepted; the flat single-key fallback yields `builtDigest: null` plus a new evidence field `builtDigestReason` carrying the sentence. A push still accepts the flat key (the read-back equality proves it) and still dies when there is none. | **Fail-safe, chosen deliberately.** The flat key is accepted on trust and only the `--push` registry read-back (`digest !== builtDigest`, inside `if (opts.push)`) proves it. A dry run wrote the unproven value as `builtDigest`, and `publish-exedev-image.yml` offers it to a human as the pin to commit — possibly the docker-archive manifest digest, which no registry resolves. No pin beats a wrong pin. **This changes dry-run behaviour on today's buildx — see Cross-file needs, FIX-CI must handle it.** |
| B3 | `:2110-2166` | The startup sweep now covers three roots: `BUILD_DIR/run-*` (unlistable = fatal, as before) plus `os.tmpdir()/qds-exedev-scan-*` and `os.tmpdir()/qds-exedev-tree-*` (unlistable = skip; the system temp dir is not ours). | Both `mkdtemp` trees were never swept by anything. The scan tree is the realistic leak, not the theoretical one: `scanImage` buffers a whole `docker export \| tar` listing at `maxBuffer: 2 GiB`, which is exactly when an OOM-kill arrives — the death class the leak-handler docblock names and for which no handler runs. |
| B4 | `:1180-1230` `judgeCandidateDir` | `e.isSymbolicLink()` is tested **first**; a symlink of any kind is a named finding, never followed. Docblock rewritten. | Two bugs on one line. (a) `docker cp -L` dereferences SRC_PATH only, so entries inside a copied tree keep absolute *in-container* targets and `readFileSync` resolved them against the **build host** — a clean host `/etc/…` greening an image credential. (b) `Dirent.isDirectory()` is false for a link to a directory, so that entry fell into `readFileSync` → EISDIR → an unconditional "could not read" that failed clean builds. Both directions fixed by classifying links first. Fail-closed preserved (a link is a finding). |
| B5 | `:1240-1256` `nodeModulesRoot` | Scans from `idx + 1` instead of giving up on the first non-boundary hit. | `usr/lib/my_node_modules/foo/node_modules/pkg/x.js` returned `null`. The gate is "expected 0, a NON-ZERO count is itself the finding", so the miss was a **silent green** on exactly the condition the sweep exists to catch. |
| B6 | `:648-663` `parseBaseRefs` | The ref is tested against `stages` **before** this instruction's own alias is registered (the alias is still added, for later instructions). | `FROM alpine AS alpine` resolved its ref against the alias it was mid-declaration of: the base never entered `baseRefs`, its digest never entered the buildId, and `!baseRefs.includes(runtimeBaseRef)` then killed a valid Dockerfile naming nothing about the cause. Now matches Docker's own order and `resolveRuntimeBaseRef`'s. |
| B7a | `:764-786` new exported `refRepository` / `repoDigestFor`, used at `:825` | Local fallback reads `{{json .RepoDigests}}` and selects the entry whose repository half equals the ref's, instead of `{{index .RepoDigests 0}}`. | A mirrored/retagged base carries several entries and position decided; the `${ref}@${digest}` pair that came out is one the named registry does not resolve — and AC5's negative control `docker run`s that pair. |
| B7b | `:715-760` `manifestDigest` → `inspectManifest` (returns `{digest, absent, detail}`), used at `:801-820` and `:2470` | The registry lookup distinguishes "answered: no such reference" (`manifest unknown\|not found\|no such manifest\|does not exist\|NAME_UNKNOWN`) from silence. **Unreachable registry + non-digest-pinned ref ⇒ `die(2)`**, naming the cause; the local `RepoDigests` path survives only for a definitive registry negative. | **Fail-safe option taken, as instructed.** Collapsing every failure into one null let a 401/429/DNS blip substitute whatever the daemon last pulled under a floating tag while buildx resolved the current one over the network — two substrates, one buildId. **Nothing offline is lost:** a digest-pinned base returns from the pinned arm before any registry read, so the local path never served the offline digest-pinned case. The push-path read-back also gained the stderr tail in its `die(2)` message. |
| B8 | `:789-799` | The `ref.includes("$")` refusal moved **above** the `@sha256:` match. | `FROM ${BASE}@sha256:<64hex>` satisfied the pinned arm and returned from it, so a `$`-bearing string reached docker argv and failed opaquely there. |
| B9 | `:667-700` `fromInstructions` | New check: any line ending in a backslash whose **successor** matches `/^\s*FROM\s/i` is refused, alongside the existing FROM-ends-in-backslash check. | The old guard caught only half the class. A non-FROM instruction whose continuation reads as a FROM mints a phantom that is appended **last**, so `resolveRuntimeBaseRef`'s `froms.at(-1)` takes it as the runtime base and the negative control subtracts the wrong image. The docblock claimed the whole class was refused; it now is. |
| B11 | `:2410-2431` | `fs.writeFileSync(NOTICE_PATH, notice)` moved to **after** the `uncoveredBinaries` gate (render + `verifyNoticeCoverage` stay where they were — they are gates). | `die` is `process.exit` and does not unwind the `finally`, and `NOTICE_PATH` is not in `leaked.paths`, so an AC5 failure left `oci/.build/exedev/NOTICE` on disk describing an image that was never tagged or pushed — the exact artifact the comment three lines above swears the credential gate prevents. Chose "write later" over "register in `leaked.paths`", as suggested. |
| B12 | `:1338-1350` new `removeContainer`, used in `scanImage` and `extractNodeModules` | `leaked.containers.delete(cid)` happens **only** when `docker rm -f` exited 0. | Root-cause fix in one shared helper rather than two call sites. A failed removal previously left a container holding an image reference with **no record**, so the exit/signal handlers — whose entire job is that retry — could not see it, and the next run hit the preflight's "remove the containers holding it" refusal. |
| B13a | `:2138-2155` | `lstatSync` (not `stat`), and `ENOENT` → `continue` rather than `die(2)`. | A concurrent run removing its own `run-XXXX` between the `readdir` and the `stat` is the matrix case the design exists for, and it killed a healthy build. Same for a dangling symlink named `run-foo`. `lstat` also stops a link being followed into a recursive removal it does not describe. |
| B13b | `:2192-2213` new `stillRunning()`, called at `:2302, 2304, 2306, 2394, 2401` | Bumps `runDir`'s mtime (`fs.utimesSync`) at each gate-phase boundary. **Chose the mtime bump over a heartbeat file** — it moves the exact value the sweep reads and adds no second path to create, register and clean up. Best-effort (`try/catch`). | The age gate reads the directory mtime, which moves only on child create/remove — and the whole phase after `docker load` (export, tar listing, `sweepImageTree`, two `find / -exec sha256sum` passes over a multi-GB image) writes nothing into `runDir`. A gate phase longer than an hour made a **live** run look stale to a concurrently starting one. |
| B14 | `:2578-2596` `main`'s `finally` | Each removal goes through a local `drop()` that swallows its own error and leaves the path **registered in `leaked.paths`** for the exit handler to retry. | An EACCES/EBUSY/ENOTEMPTY from `rmSync` replaced the in-flight exception (an operator saw a filesystem error for a licence-gate crash) and an uncaught throw from a `finally` exits **1**, the code reserved for a compliance failure. |
| B15 | `:1888-1910` new exported `canonicalOutputPath` | Comparison paths are `realpath`'d at the **parent** and lower-cased on `darwin`/`win32`. | `path.resolve` normalises separators and `..` and nothing else. Case let `OCI/exedev/Dockerfile` past the old guard while `rmSync` resolved it case-insensitively onto the real tracked file; a symlinked parent walked past it the same way. Parent-only realpath because the output need not exist yet; an unresolvable parent falls back to the literal path, which can only refuse *more*. |
| B16 | `:1912-1939` new exported `outputPathAllowed`, used at `:1998`; the `protectedInputs` denylist **deleted** | Positive constraint: an output must resolve **inside `BUILD_DIR`** or **outside `REPO_ROOT`**. Everything else in the working tree is refused. | **Fail-safe.** The denylist refused `--evidence oci/exedev/Dockerfile` and *passed* `--evidence src/providers/exedev/driver.ts` — the file holding the digest pin this script exists to feed — and `--summary .env`. The positive rule subsumes the old list (all five inputs are in the repo, none in `BUILD_DIR`), so the denylist is gone rather than added to. **CI verified:** `publish-exedev-image.yml:517-521` passes `"$BUILD_DIR/sweep-summary.json"` and `"$BUILD_DIR/publish-evidence.json"`, and its own step at `:437-453` asserts that `BUILD_DIR` env equals this module's constant — so CI lands in the first arm by construction. Both spellings are pinned in a test. |
| B17 | `:1682-1707` (`BinaryEntry.paths` + `validateBinaryLicenses`), `:1739-1766` (`uncoveredBinaries`), `oci/exedev/binary-licenses.json:48,74` | Optional `paths[]` per entry. Coverage now requires basename match **AND**, when `paths` is present, membership. Absent `paths` = old behaviour exactly (additive). Validation: present ⇒ non-empty array of non-empty strings, no leading slash. `paths` added to bun (`usr/local/bin/bun`) and pi (`home/exedev/.local/bin/pi`, `usr/local/bin/pi`). | Basename-only coverage meant any executable called `bun` or `pi`, from any project, at any path, passed unquestioned — while the negative control was being strengthened to catch content-level replacement. bun's path is **measured**, from this repo's own `oci/.build/exedev/build-evidence.json` (`addedBinaries: ["usr/local/bin/bun"]`, 2026-09-01) and the Dockerfile's `install … /usr/local/bin/bun`. pi's paths come from the table's own `notes` (exeuntu installs to `/home/exedev/.local/bin/pi`, symlinks `/usr/local/bin/pi`; `find -type f` sees the former); pi is not currently in `added` (bytes match the base), so if that path is wrong it surfaces as a **loud fail-closed build stop** on the next pi bump, not a silent pass. |
| B18 | `:857-891` `dockerfileArgDefault` → `dockerfileArgDefaults` (returns distinct defaults, `string[]`), caller `:967-989` | Collects **every** declaration (global regex), tolerates a trailing `# comment`, and the caller `die(2)`s on 0 declarations *or* on >1 disagreeing ones. | An `ARG` must be re-declared in every stage that consumes it and this file's own comments say DF1.10 adds a build stage, so a first-match-only read compared against the builder's copy and let a stale RUNTIME default through — surfacing as the bare `sha256sum -c` mismatch ten QEMU minutes in that the docblock exists to prevent. `ARG PI_VERSION=0.84.4  # comment` also reported "declares no ARG". |
| B19 | `:1636-1653` docblock | The KNOWN CEILING list grew from two residual classes to three: **the instrument is the subject** — `find` and `sha256sum` are the image's own, run as root inside the artifact under audit, and the base run uses a *different* pair, so the two listings being diffed are not produced by one instrument. Names the upgrade path (a trusted toolchain mounted into both runs, or hashing the exported tar host-side) as the same #188 seam. | Docblock-only, as instructed: the measurement cannot move out of the image without a second toolchain. |
| B20 | `:1370-1390` `extractNodeModules` docblock | Corrected to credit the thing that does the work: `-L` covers the tree **root** only; nested links still land verbatim, and what holds the line is the `sweep.unreadable` → `die(1)` in `main`'s `failClosed` block, named explicitly so deleting it reads as reopening the hole. `inspectConfigs`' docblock got the same correction. | Someone later deleting `failClosed` would have trusted `-L` to hold the line. |
| B21 | `:1120, 1136-1141, 1173-1175` | `docker cp`'s stderr tail is captured and appended to the "could not read /… — treating as a finding" message. | stderr was already piped and dropped; the operator got a build-stopping INV-IBOX-1 finding naming a path and no cause. |
| B22 | `:1992-2015` | All three output paths (NOTICE, `--summary`, `--evidence`) are canonicalised into one `Map`; a collision is `die(2)`. | `--summary out.json --evidence out.json` silently lost the summary; `--summary <NOTICE_PATH>` overwrote the published NOTICE **after** every gate passed and still reported success. |
| B23 | `:2371-2380` (render), `:2416-2422` (write) | The clean-path `renderNotice` is wrapped in an IIFE with a `die(2)` catch; the `writeFileSync` likewise. | Both sat outside any try, so an ENOSPC exited **1** and `publish-exedev-image.yml`'s classifier printed a licence diagnosis for a disk fault. The identical `renderNotice` in the failure branch was already wrapped. |
| B24 | `:284-291` (`leaked.tags`), `:298-299` (`sweepLeaks`), `:2425-2431` (register), `:2578-2581` (deregister) | `leaked.tags` added to the registry; `sweepLeaks` `docker rmi -f`s them; the tag is registered the moment `docker tag` succeeds and deregistered **only** after the last `writeJson` and the success banner. | `docker tag` precedes the push, the read-back `die(2)`, the digest-mismatch `die(1)` and both `writeJson` `die(2)`s — all `process.exit` — with no `docker rmi` anywhere, contradicting the header's "a failed build leaves no local artifact behind" and misleading a human who pushes by hand after a mismatch. |
| H2 | `:2551-2565` | `coldBootMs: 0` kept (Observability Contract unchanged) and two sibling fields added: `coldBootMeasuredBy` ("not measured here — a build cannot boot a box; 0 is the … never-evaluated sentinel") and `coldBootSource` (pointing at `tests/fleet/e2e/tier1-image-contract.live.test.ts`). | The uploaded artifact carried a bare `0` that reads as a measurement to any consumer that does not know the convention. Now a reader of the JSON alone can tell a sentinel from a measurement. **Nothing asserts on the evidence key set** — checked: `publish-exedev-image.yml` reads only `.builtDigest`, `.buildId`, `.gitSha`, `.platform` by name; `tier1-image-contract.live.test.ts` reads the file but is another fixer's; no test in `tests/scripts/` asserts the key set. Additive fields are safe. |
| G8 | `tests/scripts/build-exedev-image.test.ts:114-190` | The `mutations` array is now `[keyof BuildIdInputs, string, mutate][]` and the "every declared input has a mutation case" test asserts `new Set(mutations.map(field)) === Object.keys(allInputs)`. Test names carry the field. | The compile-time `Record<keyof BuildIdInputs, 0>` and the runtime `Object.keys` check both forced updates while nothing tied either to the mutation rows — add a field, satisfy both, forget the row, and a field silently dropped from the hash failed no test. That mutation table is the only one of the three that proves the field reaches the hash. |

### Tests added/changed (all in my two test files)

`parseBaseRefs` self-alias (B6) · continuation-into-FROM refusal (B9) ·
`dockerfileArgDefaults` trailing comment + multi-stage divergence + agreeing
copies (B18, also updated in `exedev-bun-pin.test.ts`) · `outputPathAllowed`
CI shape / outside-repo / source-file / `..` / symlinked-parent / case (B15,
B16) · `judgeCandidateDir` symlink reported-not-followed for all three link
shapes, plus a replacement unreadable-regular-file case (B4) ·
`nodeModulesRoot` non-boundary-then-real (B5) · `uncoveredBinaries` additive
default + scoped `paths` + the **real table** against the real measured paths
(B17) · `validateBinaryLicenses` accepts scoped, rejects malformed `paths`,
rejects a leading slash (B17) · `refRepository`/`repoDigestFor` port-vs-tag and
mirrored-entry selection (B7a) · `redactAssignments` including a
"nothing `SECRET_ENV` can match survives unredacted" case (B1) · G8 key-set
assertion.

The `KNOWN CEILING: coverage matches on basename` test was **replaced** (it
pinned the behaviour B17 removes) by the pair above; its `opt/vendor/bun`
assertion survives as the *additive-default* case, which is still true.

## False positives

| ID | Why it does not hold, with evidence |
|----|-------------------------------------|
| **B10** | **FALSE POSITIVE.** `tarUnescape`'s pass-through loop *does* have the compensating advance. `scripts/build-exedev-image.ts:1215` (pre-edit; unchanged by this round) reads `if (cp > 0xffff) i += 1;` immediately after `bytes.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));` — the low surrogate is skipped. It is also already under test: `tests/scripts/build-exedev-image.test.ts` "iterates code points, so an astral character survives alongside an escape" asserts `tarUnescape("usr/share/emoji-📁/a\\tb") === "usr/share/emoji-📁/a\tb"`, `tarUnescape("📁\\\\x") === "📁\\x"` and `tarUnescape("a\\012📁") === "a\n📁"` — all three contain an astral character **and** an escape, so they force the loop past the `!entry.includes("\\")` early return. No patch, no new test needed. |

Everything else in the list was located, verified against the real file and
patched.

## Gate output

### 1. `bun test tests/scripts/`

```
$ bun test tests/scripts/ > /tmp/pr184-r4/bs-test.log 2>&1; echo "exit=$?"
exit=0

$ tr '\r' '\n' < /tmp/pr184-r4/bs-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
(no output)

$ tr '\r' '\n' < /tmp/pr184-r4/bs-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | tail -5
 448 pass
 2 skip
 0 fail
 1119 expect() calls
Ran 450 tests across 14 files. [26.08s]
```

(`tests/scripts/build-exedev-image.test.ts` alone: `125 pass / 0 fail / 231
expect() calls`.)

### 2. `bunx biome check scripts/build-exedev-image.ts tests/scripts/`

```
Checked 15 files in 69ms. No fixes applied.
```

(Clean. Five errors during the round — one `noUnusedTemplateLiteral` in the new
HELP line and four `noVoidTypeReturn` from `return die(…)` inside `main` — were
fixed by dropping the `return` where `main` is `void` and, for the one place
that needed the value, wrapping `renderNotice` in a typed IIFE.)

### 3. `bunx tsc --noEmit`

Clean **in the files I touched**:

```
$ bunx tsc --noEmit 2>&1 | grep -E "build-exedev|exedev-bun-pin"
(no output)
```

Pre-existing errors elsewhere, **not mine** (they are in another fixer's live
e2e tests):

```
tests/fleet/e2e/tier2-dispatch-engine.live.test.ts(103,9): error TS6133: 'evidencePath' is declared but its value is never read.
tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts(81,9): error TS6133: 'evidencePath' is declared but its value is never read.
tests/fleet/e2e/tier5-gate-steering.live.test.ts(61,3): error TS6133: 'fleetCleanupProblems' is declared but its value is never read.
tests/fleet/e2e/tier5-gate-steering.live.test.ts(62,3): error TS6133: 'keyLeakProblems' is declared but its value is never read.
tests/fleet/e2e/tier5-gate-steering.live.test.ts(72,3): error TS6133: 'settleRun' is declared but its value is never read.
tests/fleet/e2e/tier5-gate-steering.live.test.ts(74,3): error TS6133: 'writeEvidence' is declared but its value is never read.
tests/fleet/e2e/tier5-gate-steering.live.test.ts(746,24): error TS2304: Cannot find name 'writeEvidence'.
```

These were present before my first edit (same list on the first run) and are in
`tests/fleet/`, which I do not own.

### 4. No-side-effect invocation

```
$ bun scripts/build-exedev-image.ts --help; echo "exit=$?"
usage: bun scripts/build-exedev-image.ts [options]

  --tag <ref>       image reference to apply once every check passes
                    [ghcr.io/biospark33/qds-exedev:local]. The tag is DROPPED before the build so
                    that a failed build leaves nothing resolving under it.
  --platform <p>    build platform [linux/amd64]. exe.dev boxes are amd64;
                    building this on an arm64 host runs under QEMU and is slow.
  --push            push the tag after every gate passes, and record the
                    pushed manifest digest in the summary and the evidence.
  --summary <file>  structured sweep summary [oci/.build/exedev/sweep-summary.json]
  --evidence <file> build evidence JSON [oci/.build/exedev/build-evidence.json]
                    both are created AND DELETED by this run, so each must sit under
                    oci/.build/exedev/ or outside the repository, and the two must differ.
  --keep-tree       keep the extracted filesystem candidates for inspection

exit: 0 clean · 1 compliance failure · 2 fatal (no builder / docker error)
exit=0

$ bun scripts/build-exedev-image.ts --tag 'ghcr.io/x/y:v1,push=true'
exe.dev image build FAILED:
  - --tag "ghcr.io/x/y:v1,push=true" is not an image reference this script can act on
  - want [host[:port]/]path[:tag], lowercase path, no commas, no '=' and no @sha256 digest
  - a digest reference cannot be tagged or pushed (docker refuses to create one), so it fails here rather than after the ten-minute build
  - the value is spliced into buildx's comma-separated --output options and baked into /etc/qds-image.json as identity
```

No real build was run. The four `parseArgs` subprocess tests in
`build-exedev-image.test.ts` cover the rest of the arg grammar and all still
pass.

## Behaviour changes wave 2/3 must know about

1. **`builtDigest` can now be `null` on a run without `--push`** (B2). On
   today's buildx — which writes one flat `containerimage.digest` and no
   per-exporter key, per the file's own MEASURED note — **every dry run now
   records `builtDigest: null` and a `builtDigestReason` sentence.** A push run
   is unchanged. This is the single highest-blast-radius change in this round.
2. **New evidence JSON fields** (additive): `builtDigestReason` (string|null),
   `coldBootMeasuredBy`, `coldBootSource`. `coldBootMs` still `0`.
3. **`oci/exedev/binary-licenses.json` gained `paths` on both entries** (B17).
   The build now fails closed if bun lands anywhere other than
   `usr/local/bin/bun`, or pi anywhere other than `home/exedev/.local/bin/pi` /
   `usr/local/bin/pi`. bun's path is measured from the recorded evidence; pi's
   is from the table's own notes and is currently unexercised (pi is not in
   `added`).
4. **`--summary` / `--evidence` are constrained positively** (B16): inside
   `oci/.build/exedev/` or outside the repo, and the three output paths must be
   distinct (B22). Any script/CI/doc that pointed either flag at a repo path
   outside `BUILD_DIR` now dies 2 at startup. CI's two invocations are inside
   `BUILD_DIR` and verified fine.
5. **An unreachable registry is now fatal when resolving a non-digest-pinned
   base** (B7b). Today's `oci/exedev/Dockerfile` pins its single base by digest,
   so this cannot fire on the current tree — it fires only if a future
   Dockerfile introduces a floating base *and* the registry is unreachable.
6. **Exported API changes** (only `tests/scripts/` consume these; `src/`, the
   workflows and the live tests import only `PI_VERSION`, `readBunPin`,
   `DEFAULT_TAG` and are unaffected):
   - `dockerfileArgDefault(df, name): string | null` → **`dockerfileArgDefaults(df, name): string[]`**
   - new exports: `redactAssignments`, `refRepository`, `repoDigestFor`,
     `canonicalOutputPath`, `outputPathAllowed`
   - `BinaryEntry` gained optional `paths?: string[]`
   - internal only: `manifestDigest` → `inspectManifest` returning
     `{digest, absent, detail}`.
7. **`judgeCandidateDir` finding text changed** for symlinks: it now emits
   `/<label>/<name> is a symlink; its target is an in-image path this scan
   cannot resolve on the host — treating as a finding` instead of
   `could not read …`. Anything grepping INV-IBOX-1 output for the old wording
   needs updating. On the stock exeuntu base this can raise findings the old
   code raised under a different message (it never raised *fewer*).
8. **A failed run now removes the local tag** (B24). `docker rmi -f <tag>` runs
   in `sweepLeaks` on every exit path that did not reach the success banner. A
   human debugging a failed publish will no longer find the tag resolvable.

## Cross-file needs

**FIX-CI / `.github/workflows/publish-exedev-image.yml` — REQUIRED, from B2.**
The dry arm at `:629` does:

```bash
actual_digest=$(jq -er .builtDigest "$evidence")
case "$actual_digest" in sha256:*) ;; *) echo "::error::$evidence carries no usable builtDigest: [$actual_digest]"; exit 1 ;; esac
```

I verified the null behaviour directly:

```
$ echo '{"builtDigest":null}' > /tmp/ev.json
$ set -euo pipefail; d=$(jq -er .builtDigest /tmp/ev.json) || echo "jq exited $?"
jq exited 1
```

`jq -e` exits **1** on a null result, so under `set -euo pipefail` the
**assignment fails and the step ends before the `case` arm can print anything**
— the operator gets a bare non-zero step with no `::error::` line and no
explanation. That already degrades badly today; after B2 it becomes the *normal*
dry-run outcome on this buildx.

What the workflow needs (I did **not** edit it):

- read it tolerantly, e.g. `actual_digest=$(jq -r '.builtDigest // ""' "$evidence")`
  (drop `-e`, or `|| true`), then
- when it is empty, print a legible refusal that quotes the new
  `builtDigestReason` field:
  `jq -r '.builtDigestReason // "no reason recorded"' "$evidence"` — e.g.
  "this buildx reports one flat `containerimage.digest` for a two-exporter solve
  and attributes it to no exporter; without a push there is no registry
  read-back to prove it describes the `type=image` export, so it was not
  recorded as a pin", and
- say plainly that **a dry run on this buildx cannot bootstrap or verify a pin**
  and that a real `--push` run is required — rather than falling through to the
  existing "adopt these two constants" block, which would otherwise offer an
  empty digest.

**FIX-CI — informational, from B16.** I read `publish-exedev-image.yml:437-453`
and `:509-528` and verified the two invocations
(`--summary "$BUILD_DIR/sweep-summary.json"`, `--evidence
"$BUILD_DIR/publish-evidence.json"`) land inside the script's `BUILD_DIR`, which
that workflow already asserts equals the script constant. **No workflow change
is needed for B16.** Just do not point either flag at a repo path outside
`oci/.build/exedev/` in future.

**FIX-OCI / `oci/exedev/binary-licenses.json` — coordination note, from B17.**
I added exactly one field to each of the two entries and touched nothing else:

- entry `bun`: `"paths": ["usr/local/bin/bun"]` (line 48)
- entry `pi`: `"paths": ["home/exedev/.local/bin/pi", "usr/local/bin/pi"]` (line 74)

The `$comment` prose, `version` and `licenseUrl` are yours; I did not modify
them and your in-flight `$comment` rewrite (the NOASSERTION correction) merged
cleanly with my additions. Two things you may want to fold into the prose you
own, both of which my change makes stale:

1. the `$comment`'s "Known ceiling … the diff is BY PATH" paragraph — the diff
   has been by path **and content** since an earlier round, and it is the
   *coverage* that was by basename and is now optionally path-scoped;
2. a sentence documenting `paths` alongside `names` (present ⇒ coverage is
   narrowed to those paths; absent ⇒ basename anywhere), since the file's
   `$comment` is where this table's schema is explained to a human.

**FIX-DRIVER / live tests — informational.** `tests/fleet/e2e/tier1-image-contract.live.test.ts`
reads `oci/.build/exedev/build-evidence.json`. Its keys are all still present;
three fields were added. If it does an exact key-set comparison anywhere (I did
not find one, but I do not own that file), it needs the three new names:
`builtDigestReason`, `coldBootMeasuredBy`, `coldBootSource`.
