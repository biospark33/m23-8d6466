# F1 — `scripts/build-exedev-image.ts` + its tests

Branch `fix/df2.10-review-round-6`. Files touched (only these four):
`scripts/build-exedev-image.ts`, `tests/scripts/build-exedev-image.test.ts`,
`tests/scripts/exedev-bun-pin.test.ts`, `tests/providers/exedev/fixtures/fake-exedev.ts`.

## Fixed

### BLOCKERs

- **P1 `redactAssignments`' `\S+` value extent** — `scripts/build-exedev-image.ts:1650-1691`.
  Value now runs to end-of-line-or-next-`NAME=`:
  `/(^|[\s|"'])([A-Za-z0-9_]+)=(?:(?!\s+[A-Za-z0-9_]+=).)*/g`. Docblock rewritten to scope the
  "SUPERSET" claim to the NAME class (which is where it was true) and to state the price paid:
  the layer command after the assignment is redacted along with the value, because a
  space-bearing value is indistinguishable from the command that follows it.
- **P2 the test that cannot see P1** — `tests/scripts/build-exedev-image.test.ts:1476-1548` (+ the `SECRET_ENV` import at `:20`).
  The file now imports `SECRET_ENV` from `scripts/build-image.ts` and the invariant is driven
  off the detector over a 180-line generated corpus (6 names × 5 value shapes × 6 frames),
  with a guard asserting the detector actually fires on it (`matched.length > 30`) so the loop
  cannot go vacuous. Added a dedicated space-bearing test with the two executed proofs
  (`ENV NPM_TOKEN={"k": "sekrit"}`, `|1 API_KEY="a sekrit c" …`), a next-`NAME=` termination
  test, and a test pinning that a redacted line carries none of the original value.

### HIGH

- **P3 binary/DER credential reads clean** — new `decodeCandidate()` at `:1262-1280`; used by
  `inspectConfigs` (`:1385`) and `judgeCandidateDir` (`:1504`). Reads a Buffer; a NUL byte or
  bytes that do not round-trip through UTF-8 are a finding in their own right. Tests:
  `judgeCandidateDir > a BINARY credential is a finding` plus a positive control that valid
  multi-byte UTF-8 is still judged (so the gate does not now refuse every non-ASCII config).
- **P4 `SOURCE_DATE_EPOCH` fallback tracked HEAD** — `sourceDateEpoch(rev)` at `:351`,
  called as `sourceDateEpoch(gitSha)` at `:2456`. Both digest inputs are now functions of the
  same revision. A `QDS_GIT_SHA` naming a commit the checkout does not have is fatal here
  rather than falling back.
- **P5 docker-scoped digest accepted as the pin (R2)** — `:2799-2830`. `flat` derives from the
  UNSCOPED key (`digests.get("")`) only, never from "the only value in the map". A digest
  positively attributed to a non-`image` exporter now falls into the existing
  fatal-before-the-gates refusal with a reason naming the exporters it did find.
- **P6 `judgeCandidateDir`'s "could not read" arm had zero coverage** —
  `tests/scripts/build-exedev-image.test.ts:1038-1059`. The old test was a byte-for-byte
  duplicate of the recursion test (`isDirectory()` is classified before `readFileSync`, so the
  EISDIR it described was unreachable). Replaced with a real `chmod 0o000` file, skipped under
  root.

### MED / LOW

- **`absent` matched auth failures** — `inspectManifest` `:830-842`. Bare `not found` /
  `does not exist` dropped; a `denied|unauthorized|forbidden|docker login|rate limit` veto runs
  first, because registries mask 403 as 404 by design.
- **FIFO/device wedges the gate** — `inspectConfigs` stats before reading (`:1375-1395`);
  `judgeCandidateDir` uses `e.isFile()` (`:1490-1495`). Test: real `mkfifo`.
- **`QDS_GIT_SHA` set-but-empty → HEAD** — `:409-430`, now the malformed case with its own line.
- **concurrent runs collide on `qds-repro`** — `ensureReproBuilder` `:469-527` refactored to
  `acceptExisting()`; a failed create re-probes (buildx's `existing instance` is a race, not a
  fault). This also fixes **"bootstraps a wrong-driver builder before rejecting it"**: the probe
  is now a plain `inspect` and the bootstrap runs only after the driver is accepted.
- **`stillRunning()` heartbeated only `runDir`** — `:2681` now walks a `liveDirs` list;
  `treeDir` is added at `:2851`; `stillRunning()` added immediately before and after the push
  (`:3049`, `:3059`).
- **NOTICE survives a failed push** — registered in `leaked.paths` when written (`:2999`),
  deregistered on the success path beside the tag (`:3206`). The docblock that said
  "NOTICE_PATH is not in `leaked.paths`" is rewritten.
- **exit-code misclassification cluster** — (a) `validateBinaryLicenses` returns
  `{structural, compliance}` (`:1955`, interface at `:1930`), and `main` exits 2 for structural /
  1 for compliance (`:2437-2444`); (b) `sweepImageTree`'s throw for an extracted tree is now
  `die(1)` (`:1899`); (c) listing `maxBuffer` capped at 512 MiB, below V8's string limit,
  so an overrun lands on ENOBUFS→`die(2)` instead of an uncaught RangeError→exit 1 (`:1757`);
  (d) `inspectConfigs`' `finally { rmSync }` wrapped in try/catch (`:1425-1437`).
- **vacuous NOTICE coverage gate** — comment at `:2929-2939` now says it is a structural
  invariant, not a control, and explains why `gaps` is provably `[]` there. A falsifiable check
  was added beside it: the render must name `opts.tag` and `builtAt` (`:2951-2956`).
- **`builtDigest` null on every dry run** — evidence gains `unverifiedFlatDigest` (`:3142`),
  explicitly never a pin, so two dry runs are comparable.
- **CRLF defeats the continuation guard and the ARG regex** — `fromInstructions` normalises
  first (`:684`), `dockerfileArgDefaults` too (`:1020`); bytes fed to `deriveBuildId`
  untouched. Tests pin both the parse and the still-firing refusal.
- **commented-out continuation trips the refusal** — the continuation scan runs over
  comment-stripped lines (`:689-690`).
- **`includes("<<")` refuses any `<<`** — anchored to a heredoc opener
  `/<<-?['"]?[A-Za-z_]/` (`:696`). Tests cover three innocent `<<` shapes and three real
  opener spellings.
- **out-of-repo outputs deleted unconditionally** — `outputPathAllowed`'s second arm is now
  "under `os.tmpdir()`", which is what its own docblock already claimed (`:2389`).
  `main`'s refusal message updated (`:2454-2458`). Test: `~/.npmrc`, `~/.ssh/known_hosts`, `/etc/hosts`.
- **`canonicalOutputPath` case-fold keyed on `process.platform`** — replaced with a probed
  `CASE_INSENSITIVE_FS` (inode comparison against a case-flipped `REPO_ROOT`, `:2330-2348`),
  and both `canonicalOutputPath` and `outputPathAllowed` take the flag explicitly so the test
  drives both arms on every platform. Also fixed while here: only the immediate parent was
  realpath'd, so `/tmp/df210/run7/evidence.json` compared a literal `/var/...` against a
  realpath'd `/private/var/...` — it now resolves through the deepest existing ancestor (`:2350-2364`).
- **`dest=${archive}` unvalidated into the buildx CSV** — startup refusal at `:2645-2651`.
- **directories-only listing reads as a clean scan** — emptiness counted AFTER the file filter
  (`:1785-1793`).
- **writability probe leaks directory trees** — no more `mkdirSync`; an existing parent gets
  the create-and-drop, a missing one gets `accessSync(W_OK)` on the nearest existing ancestor
  (`:2515-2524`).
- **Docker Hub ref normalisation** — `repoDigestFor` canonicalises `[index.]docker.io/[library/]`
  on both sides (`:874-876`). Test covers four spellings in both directions plus a foreign repo.
- **`nodeModulesRoot` trailing-slash miss** — boundary on both sides (`:1536-1543`).
- **`assertCid` echoes 120 raw bytes** — replaced with a shape summary (length, line count,
  long-hex-token / JSON-punctuation flags) at `:1571`.
- **NFC/NFD "both spellings" overclaim** — all three variants are tried (`:1357`), comment
  corrected to say why `[p, NFC(p)]` was the overclaim.
- **whitespace-padded `names`** — `uncoveredBinaries` compares trimmed (`:2175-2180`). Test added.
- **`--keep-tree` deleted by the next sweep** — distinct `qds-exedev-keep-` prefix (`:2844`),
  which no sweep prefix matches.
- **`listExecutables` failure hint misdiagnoses** — branched on `res.status` (125 vs 126/127)
  at `:2098-2108`.
- **`metadataDigests` same-scope collision** — a scope claimed by two DIFFERENT digests is
  dropped, routing into the caller's ambiguity refusal (`:2294-2308`). Two tests, both orderings.
- **`parseBaseRefs` case-sensitive dedup** — deduped on lowercase, first-seen spelling kept
  (`:642-651`). Test added.
- **`readBunPin` accepts `bun@1`** — anchored on
  `\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?` (`:971`). Eight refusal rows and four
  accept rows in `exedev-bun-pin.test.ts`.
- **quoted `ARG` default** — a symmetric quote pair is stripped, as docker does (`:1023-1027`).
- **`maxBuffer` overrun reported as "docker export | tar failed"** — `listing.error.message`
  and `listing.signal` now in the message (`:1760-1770`).
- **three evidence fields provably constant** — kept (they are the verdict) with a comment
  saying so, and five VARYING counts added beside them: `historyLinesScanned`,
  `filesystemPathsScanned`, `credentialCandidatesInspected`, `builtExecutableCount`,
  `baseExecutableCount` (`:3175-3187`). `ImageScan` grew three fields to carry them.
- **dry-run summary prints the literal `null`** — prints `builtDigestReason` instead (`:3229`).
- **push re-solve mismatch wording** — cache-miss line added to the `die` (`:3076`).
- **push succeeds + evidence write fails ⇒ digest never printed** — `say("pushed digest: …")`
  immediately after the equality check, before both `writeJson`s (`:3086`).
- **no timeout on any subprocess** — `sweepLeaks` bounds its `docker rm`/`rmi` at 30 s with
  SIGKILL (`:286`), `inspectManifest` bounds its registry read at 5 min (`:813`).
  These are the two the reviewer scoped it to (the exit handler and the registry read).
- **`!baseRefs.includes(runtimeBaseRef)` unreachable** — annotated as a belt-and-braces
  assertion that the two parsers agree (`:1213-1221`).
- **`bunx` substring key** — keyed on the install/link instruction shape
  (`/\b(?:ln|install|cp|mv)\b[^\n]*\bbunx\b/`), test file `:1311-1325`.
- **`BunPinError` one-of-four coverage** — table-driven over all six rejection paths, each row
  named, `threw` asserted separately so a path that stops throwing is named (`tests/scripts/build-exedev-image.test.ts:1554-1590`).
- **`parseArgs` "before any action" unpinned** — new subprocess test asserting `BUILD_DIR`'s
  existence is unchanged across the run AND that the same exit 2 comes back on a `PATH` with no
  `docker` on it (`tests/scripts/build-exedev-image.test.ts:801-822`); uses `process.execPath` so the runtime lookup does not need PATH.
- **fixture: combined `test -f && cat` slips the drift alarm** — `fake-exedev.ts:747-757`
  requires exactly one verb and throws naming the collapse.
- **fixture: `imageMarkerTruncated` overrides `imageMarkerCatExit`** — precedence documented on
  the field (`:113-131`); behaviour kept (it is the right default — `readBoxFile` checks
  `truncated` before `exitCode`).
- **fixture: `DEFAULT_IMAGE_MARKER` calls `readBunPin` at module load** — wrapped in
  `bunPinOrReason()` (`:147-160`); a refusal now travels IN the marker as the `bunVersion`
  value instead of exploding at import with no test name attached.
- **fixture: `writeRatifiedRegistryDeviation` fixed `attestedAt`** — derived from `Date.now()`
  (`:870`); same for `writePostureAttestation` (`:896`). `expiry` stays far-future,
  which is deliberate and stays commented as such.
- **`ARG BUN_SHA256` ↔ version pairing** — recorded as a named residual gap on the assertion
  itself (`exedev-bun-pin.test.ts:103-112`), with why closing it needs a network fetch.
- **`--tag` docblock misattributed the `docker rmi -f` guard** — corrected (`:144-156`);
  behaviour kept, see below.

## Deferred to the DF1.10 re-pin (#186)

Three findings are real and all three were REVERTED out of this round on the team lead's scope
correction. Each one changes the value `deriveBuildId` returns for the current tree, which
un-pins `DEFAULT_IMAGE_BUILD_ID = "3cf094fb6990ed66"` in `src/providers/exedev/driver.ts` — the
only pin that has been live-booted and e2e-proven — and costs the full ritual (rebuild → ghcr
push → re-pin → a paid live e2e round). A review round must not trigger that silently.

Verified reverted: `git diff` over `scripts/build-exedev-image.ts` contains no change to any
`h.update(…)`, `field(…)`, or `BuildIdInputs` line, and the fixture's buildId derives to
`3f3f3e440570355e` with the label collision still reproducible — i.e. the function is
byte-identical in behaviour to HEAD.

| # | finding | why it is real | why it moves the pin |
|---|---------|----------------|----------------------|
| 1 | `platform` is not a `deriveBuildId` input | `--platform linux/arm64` builds a completely different substrate — different ELFs, different libc — under a byte-identical buildId, and `resolveBaseDigest` does not close it (`{{json .Manifest}}` on a multi-arch tag yields the INDEX digest, identical for every architecture). Gate B's INV-IBOX-2 therefore passes on an image built for the wrong architecture. | Adding a hashed contribution changes every derived buildId. |
| 2 | the framing LABEL is not length-prefixed | `${label}:${len}\n` is reconstructable more than one way when a label can carry `:` or a newline. EXECUTED: `systemdFiles: [{name:"a",bytes:"X"},{name:"b",bytes:""}]` and `[{name:"a:1\nX\nsystemd/b",bytes:""}]` both hash to `10c0ed4ae242e878`. Two substrates, one identity — the single thing the value exists to prevent. Repo-owned filenames make it theoretical today. | Changing the framing changes every derived buildId. |
| 3 | the buildId input set is hand-enumerated | A Dockerfile `COPY` from outside `oci/exedev/systemd/` ships bytes the identity does not cover: the Dockerfile bytes move once when the COPY lands, then every edit to that asset ships a different substrate under an unchanged buildId. | Closing it means hashing more files, which changes every derived buildId. (Note for the lead: my reverted implementation was a pre-build `die(2)` REFUSAL, not a hash change, so it did not actually move the pin — it is deferred because you asked for it, and it can land in a later round on its own if you want it before #186.) |

All three are now documented IN the code, on `deriveBuildId`'s docblock, as a numbered
`KNOWN GAPS, deliberately NOT closed here` block naming the re-pin cost and #186.

Free tripwires kept (no production code, no pin movement, each written to FAIL when the defect
is fixed so the re-pin is verifiable):

- `tests/scripts/build-exedev-image.test.ts:223` — `KNOWN DEFECT (#186): the framing LABEL is
  NOT length-prefixed, so a crafted filename collides`, asserting the collision pair still
  collides.
- `tests/scripts/build-exedev-image.test.ts:257` — `KNOWN DEFECT (#186): platform is not a
  buildId input, so two architectures claim one identity`.
- `tests/scripts/build-exedev-image.test.ts:604` — a COPY-source tripwire over the real
  Dockerfile, scan inlined so it needs no export. Fails the day a `COPY` outside
  `oci/exedev/systemd/` is added, pointing at #186.

## False positives

- **blind-buildscript-b [MED], scan-dir half of "`stillRunning()` heartbeats only `runDir`"** —
  the claim that `qds-exedev-scan-*` is "age-swept by concurrent runs with no heartbeat" is
  wrong. The staleness gate reads the DIRECTORY's mtime, and a directory's mtime moves when a
  child is created — `inspectConfigs` writes a `cfg-${i}-${j}` child into the scratch dir on
  every single `docker cp` (`scripts/build-exedev-image.ts:1358-1362`), so the dir is continuously heartbeated by its own
  work, and it does not outlive that loop. The `treeDir` half of the same finding IS real and
  is fixed. I added `treeDir` to the heartbeat and a comment stating why the scan dir needs no
  entry, rather than adding a third path that would do nothing.
- **edge-buildscript-a [MED], part (b) of "concurrent runs collide … on the shared default
  tag"** — the finding is real but the proposed fix ("skip the `rmi` sweep for a tag this
  process did not itself create in this run") does not work: both runs DO create it. Run B's
  `docker tag imageId opts.tag` re-points the shared `DEFAULT_TAG` and registers it, so B's
  sweep is removing a tag it genuinely created. The only real remedies are per-run tags (which
  the file deliberately declines — the live-e2e reader and the publish workflow address the
  default paths by name) or not running two default-tag builds at once. Kept the behaviour and
  sharpened the existing "HONESTLY PARTIAL" comment to name this exact mechanism (`scripts/build-exedev-image.ts:2622-2635`).
  Part (a), the builder collision, is fixed.
- **blind-buildscript-b [HIGH] `redactAssignments` lead-class miss** — already dismissed as X1
  in the triage ledger, and I re-verified it: `SECRET_ENV` (`scripts/build-image.ts:83`) has
  the identical `(^|[\s|"'])` lead class, so `cd /app&&NPM_TOKEN=abc` never becomes a finding
  in the first place and nothing is printed. A detector gap, not a redaction leak. The lead
  class is unchanged; only the VALUE extent moved.

## Accepted tradeoffs (behaviour kept, overclaiming comment corrected)

- **`docker rmi -f ${opts.tag}` destroys an operator's local image** — the drop is the
  documented contract of `--tag` (it is in `--help`: "The tag is DROPPED before the build so
  that a failed build leaves nothing resolving under it"), and restricting it to an allowlist
  would break the flag. What was false is the claim that `TAG_RE` protects against a typo
  naming an unrelated local image; the docblock now says the ordering only keeps a MALFORMED
  tag away from the removal, and that the grammar's job is exporter-attribute injection.
- **`-perm -u+x` misses group/other-executable files** — NOT switched to `-perm /111`. `find`
  here is the one inside the image, resolved through its PATH, and `/111` is GNU/BSD syntax a
  busybox layout need not accept: a hard enumeration failure on a base we do not control is
  worse than a named ceiling, and both listings being diffed use the same predicate so a base
  file in this class cancels out. Named as class (1b) in the KNOWN CEILING list, which the
  reviewer offered as the alternative.
- **`tarUnescape`'s final `toString("utf8")` mangles a non-UTF-8 filename** — already an
  accurately-stated KNOWN CEILING in the docblock (`scripts/build-exedev-image.ts:1622-1634`), with the fail direction
  ("fails CLOSED as a 'could not read' finding, never as a silent pass") and the upgrade path
  (byte-path plumbing into the `docker cp` argv) both named. Nothing to correct; closing it is
  a plumbing change out of proportion to this round.

## Behaviour changes for wave 2

1. **The buildId does NOT move.** All three pin-moving findings were reverted — see
   *Deferred to the DF1.10 re-pin (#186)* above. `deriveBuildId` is behaviourally identical to
   HEAD; `DEFAULT_IMAGE_BUILD_ID` stays valid and no re-pin or paid live round is triggered by
   this round's F1 changes.
2. **`validateBinaryLicenses` returns `{structural, compliance}`**, not `string[]`. Only
   `main` and `tests/scripts/build-exedev-image.test.ts` consume it (grepped). A malformed
   `binary-licenses.json` now exits **2**, not 1 — the publish workflow's exit-code classifier
   sees a different code for that input.
3. **An extracted-but-unsweepable npm tree now exits 1**, not 2 (same classifier).
4. **A lone digest scoped to a non-`image` exporter is now fatal on a DRY run too**, not just
   on `--push`. Today's measured buildx writes one FLAT key, so the live path is unchanged;
   only a buildx that namespaces per exporter is affected.
5. **`redactAssignments` output shape changed** — everything after the assignment is now
   redacted with it (`|1 NPM_TOKEN=<redacted>`, not `… <redacted> /bin/sh -c npm install`).
   Any test or log grep expecting the old shape will move.
6. **`outputPathAllowed`'s second arm is now `os.tmpdir()`**, not "anywhere outside the repo".
   CI passes `$BUILD_DIR/...` and lands in the first arm, unaffected — but any caller passing
   a `$HOME` path is now refused at parse.
7. **`nodeModulesRoot` treats a slashless `node_modules` entry as a site**, so a regular FILE
   named `node_modules` in an image now produces a loud spurious `die(1)`. Deliberate,
   fail-closed.
8. **Evidence JSON gains six fields** (all additive; the workflow's `.builtDigest`,
   `.builtDigestReason`, `.buildId`, `.gitSha`, `.platform` reads are untouched):
   `unverifiedFlatDigest`, `historyLinesScanned`, `filesystemPathsScanned`,
   `credentialCandidatesInspected`, `builtExecutableCount`, `baseExecutableCount`.
   → **For F2:** `publish-exedev-image.yml:917` warns "this dry run can neither verify nor
   bootstrap the pin" — `unverifiedFlatDigest` is the comparable-across-two-dry-runs value it
   could now print. Optional, and it must NOT be offered as a pin.
9. **One new fatal-before-the-gates refusal**: a `BUILD_DIR` path containing `,` or `=`
   (it is spliced into buildx's `--output` CSV). Passes on the current tree. The COPY-source
   refusal that was here is deferred to #186; only its test-side tripwire remains.
10. **`--keep-tree` writes to `qds-exedev-keep-*`**, not `qds-exedev-tree-*`. Anything grepping
    for the old prefix under `--keep-tree` moves.
11. **`canonicalOutputPath` / `outputPathAllowed` take an optional second `caseInsensitive`
    argument** (defaulted to a probed constant). Additive; no caller has to change.
12. **Fixture (`fake-exedev.ts`)**: a command that both probes and `cat`s the marker path in
    one shot now THROWS (the drift alarm the combined form used to slip); `attestedAt` in
    `writePostureAttestation` and `writeRatifiedRegistryDeviation` is now `Date.now() - 1 day`
    instead of the literal `2026-08-15T00:00:00.000Z` — any test asserting that literal moves;
    `DEFAULT_IMAGE_MARKER`'s `bunVersion` is `unreadable-bun-pin(<why>)` instead of an
    import-time throw when the pin is unreadable.

## Gates

```
$ bun test tests/scripts/build-exedev-image.test.ts tests/scripts/exedev-bun-pin.test.ts
 165 pass
 0 fail                                                   exit=0

$ bun test tests/scripts/ tests/providers/exedev/          exit=1
 716 pass
 5 fail
 2800 expect() calls
```

All 5 failures are in OTHER fixers' in-flight files, none of them mine:

```
(fail) setup gate — E2E chain (create → fill → setup) > round-6 regression: E rejects negative limit (limit -5) — not positive (round-6)
        tests/providers/exedev/setup-gate.test.ts (F5b, ` M`) against src/providers/exedev/assertions-in-box.sh (F5b, ` M`)
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > every AC6 policy holds on the file as shipped
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > no ExecStart — DF1.10 owns it, and its arrival must be a visible change
(fail) DF2.10 AC6 — negative controls: each assertion rejects the wrong file > every mutation is rejected by exactly the policies named, and by no others
(fail) DF2.10 AC6 — negative controls: each assertion rejects the wrong file > the mutations are real: each one actually changed the file
        tests/providers/exedev/image-assets.test.ts (F4, ` M`) asserting NoNewPrivileges / PrivateTmp / UMask on
        oci/exedev/systemd/qds-run@.service — which `git status` shows is NOT YET modified. F4's test landed ahead of their unit edit.
```

A later re-run of `bun test tests/scripts/` alone came back with 5 failures in
`tests/scripts/install-gitnexus-embeddings.test.ts` (`0 pass, 5 fail`, every arm
`script exited 143`). NOT mine and not a code failure:

- that suite imports only `bun:test` + node builtins — nothing from any file I touched;
- it shells out to `scripts/install-gitnexus-plus.sh`, which runs `gitnexus analyze` under a
  300 s cap; 143 is SIGTERM, i.e. the cap firing;
- the SAME suite passed in my earlier `bun test tests/scripts/` run (exit=0, no failures) on
  identical code. Seven fixers are running suites in parallel on this machine; the 300 s cap
  is losing to the load.

`scripts/install-gitnexus-plus.sh` is unmodified in the working tree.

```
$ bunx biome check scripts/ tests/scripts/ tests/providers/exedev/
Checked 53 files in 899ms. No fixes applied.

$ bunx tsc --noEmit
(no output)                                                exit=0
  — clean of BuildIdInputs errors specifically: the `platform` plumbing is fully reverted
    (interface, hash contribution, gatherBuildIdInputs signature and call site, fixture,
    mutation row, allInputs key).
```
