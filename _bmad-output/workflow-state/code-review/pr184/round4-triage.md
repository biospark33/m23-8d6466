# PR #184 — review round 4 triage ledger

Source: 14 reviewers (6 blind, 7 edge, 1 auditor) over 11 diff chunks (11,995 code lines;
`_bmad-output/` artifacts excluded). Raw findings: 118 (3 BLOCKER, 15 HIGH, 62 MEDIUM, 38 LOW).
After dedupe: 94 distinct. Classified below.

Legend: **P** = patch, **D** = defer (real, not this PR's scope), **X** = dismiss (verified false positive),
**DN→** = decision_needed, resolved with the fail-safe option (user pre-authorized).

---

## Cluster A — CI / supply chain (`.github/`)  → fixer FIX-CI

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| A1 | BLOCKER | Exception entry with missing/misspelled `expires` is a permanent silent pin-gate bypass (`jq -r` prints `"null"`; `[ "2026-09-02" \> "null" ]` is false forever). Same for missing `reason` (`"null"` is non-empty → accept arm). | edge-ci#1, blind-ci#2 | **P** |
| A2 | HIGH | Provenance identity binds `--signer-workflow` = path with **no ref**, so a bundle minted from any feature branch verifies. | blind-ci#1 | **P** |
| A3 | HIGH | Exception expiry never re-evaluated — gate is `pull_request`-only on 3 paths, no `schedule:`/`push:`. Expired exception never fires. | edge-ci#2, blind-ci#4, auditor#9 | **P** |
| A4 | MED | `verify-image-pin.yml` has `permissions: contents: read` only; repo is PRIVATE so the attestation read may never succeed → every legitimate re-pin forced into the exception register. | edge-ci#3 | **P** |
| A5 | MED | Single-shot `gh attestation verify` against an API the sibling job retries 5× for eventual consistency. | blind-ci#5 | **P** |
| A6 | MED | `concurrency.group: ${{ github.workflow }}` — the prescribed "push to heal" run can be **cancelled** (cancelled ≠ red). | edge-ci#4 | **P** |
| A7 | MED | `publish-exedev` environment is a bare name; nothing asserts it exists with required reviewers. A missing environment publishes with zero approval, fully green. | edge-ci#5 | **DN→P** (assert + fail closed on the real-publish arm) |
| A8 | MED | Duplicate digests in the register → multi-line `expires` → arbitrary verdict. | blind-ci#7, edge-ci#7 | **P** |
| A9 | LOW | `verify-image-pin.yml` never checks `DEFAULT_IMAGE_BUILD_ID` (publish gate checks both). | edge-ci#6 | **P** |
| A10 | LOW | Checkout omits `persist-credentials: false` (zizmor `artipacked`), unlike the sibling. | blind-ci#10, edge-ci#8 | **P** |
| A11 | LOW | Fork-guard comment describes a case `github.repository_owner` cannot select on `pull_request`. | blind-ci#9 | **P** (comment) |
| A12 | LOW | Attest job's "unlike the tag-pinned actions" comment is stale — every action here is SHA-pinned. | blind-ci#11 | **P** (comment) |
| A13 | MED | Push happens before the digest/buildId gate → mismatch leaves an unattested public `sha-<sha>` tag. | blind-ci#6 | **D** — acknowledged in-file at `:30`, pruning declared a manual chore; changing publish ordering is out of round scope. |
| A14 | MED | `packages: write` unconditional, so the dry-run route hands a registry-write token to an unreviewed ref. | edge-ci#6 | **D** — reviewer itself concedes a write-access actor can already add a workflow with `packages: write`; residual is a GitHub property, not this diff. Noted in story. |
| A15 | MED | The gate is triggered by, and reads, the PR that edits it. | blind-ci#3 | **D** — inherent to `pull_request` checks; mitigated by branch protection + required review, which is server-side. |
| A16 | MED | New dependabot `docker` entry is inert (no tag on the base pin). | blind-ci#6, auditor#5 | **D** — the file documents this verbatim and defers the one-token fix to DF1.10 because it moves the buildId. |
| A17 | LOW | `github-actions` dependabot ecosystem asserted but not visible in the hunk. | blind-ci#12 | **X** — edge-ci confirmed it exists at `.github/dependabot.yml:25-31`. |

## Cluster B — build script (`scripts/build-exedev-image.ts`)  → fixer FIX-BUILDSCRIPT

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| B1 | HIGH | The credential gate **prints the credential** into the build log: `SECRET_ENV` matches because a value follows, and the whole layer-history line (value included) goes into `findings` → stderr → the CI job log. | edge-buildscript#1 | **P** |
| B2 | HIGH | Dry-run adopts `builtDigest` from an unverified flat `containerimage.digest` (could be the docker-archive exporter). The workflow then offers it to a human as the pin to commit. | edge-buildscript#2, blind-b#9 | **P** |
| B3 | HIGH | `os.tmpdir()/qds-exedev-scan-*` and `-tree-*` are never swept — the scan tree is the one the file calls "can be a real private key". Startup sweep covers only `BUILD_DIR`. | edge-buildscript#3 | **P** |
| B4 | MED | `judgeCandidateDir` reads through symlinks host-side (reopening the hole `-L` was added to close); `Dirent.isDirectory()` is false for symlink-to-dir → EISDIR → phantom fatal finding. | blind-a#1 | **P** |
| B5 | MED | `nodeModulesRoot` returns `null` on the first non-boundary hit, missing a real `node_modules/` further right — fails **green** on the condition the sweep exists to catch. | blind-a#2 | **P** |
| B6 | MED | `parseBaseRefs` registers the stage alias before testing the same instruction's ref → `FROM x AS x` drops the base from `baseRefs` and buildId. | blind-a#3 | **P** |
| B7 | MED | `resolveBaseDigest` local fallback takes `RepoDigests[0]` without matching `ref`'s repository, **and** silently substitutes a stale daemon digest for any registry failure (401/429/DNS). | blind-a#4, edge-buildscript#4 | **P** |
| B8 | MED | The `$`-template refusal is ordered after the digest match → `FROM ${BASE}@sha256:…` slips through. | blind-a#5 | **P** |
| B9 | MED | Continuation-into-`FROM` is not refused (only `FROM …\`), so a phantom FROM becomes the runtime base. | blind-a#6 | **P** |
| B10 | MED | `tarUnescape` may not skip the trailing surrogate after `codePointAt` → 3 junk bytes per astral char. | blind-a#7 | **P** (verify in source first; dismiss if a compensating `i++` exists) |
| B11 | MED | NOTICE is written **before** the binary-attribution gate → a failed AC5 build leaves the artifact the header swears it never leaves. | blind-b#1 | **P** |
| B12 | MED | `leaked.containers.delete(cid)` runs unconditionally after an unchecked `docker rm -f` — a **failed** removal is erased from the leak registry. Two sites. | blind-b#2 | **P** |
| B13 | MED | Stale-run sweep: `statSync` ENOENT on a vanished sibling kills a healthy concurrent run (`die(2)`); and the directory-mtime age gate can delete a **live** run's dir, because the whole gate phase writes nothing into `runDir`. | blind-b#3 | **P** |
| B14 | MED | `main()`'s `finally` `rmSync` can throw and **replace** the in-flight error, exiting 1 — the code reserved for a compliance failure. | blind-b#4 | **P** |
| B15 | MED | Protected-build-input guard is a case-sensitive compare on a case-insensitive filesystem → `--evidence OCI/exedev/Dockerfile` deletes the real tracked Dockerfile. | blind-b#5 | **P** |
| B16 | MED | `--summary`/`--evidence` will `rmSync` **any** path outside a five-entry allowlist (`--evidence src/providers/exedev/driver.ts` destroys the pin file). | edge-buildscript#5 | **P** |
| B17 | MED | AC5 binary attribution matches **basenames only** — `bun` and `pi` are wildcards at any path. | edge-buildscript#6 | **P** |
| B18 | MED | `dockerfileArgDefault` reads only the first `ARG NAME=` (silently degrades the moment DF1.10 adds a stage) and returns `null` for a trailing comment. | edge-buildscript#8 | **P** |
| B19 | MED | `listExecutables` audits the image with the image's own `find`/`sha256sum`; the docblock's residual-false-negative list omits this class. | blind-b#6 | **P** (docblock — the measurement cannot be moved out of the image without a second toolchain) |
| B20 | MED | `docker cp -L` docblock credits `-L` with closing a hole that `failClosed` actually closes. | blind-b#7 | **P** (docblock) |
| B21 | LOW | `docker cp` stderr is captured (`"pipe"`) and then discarded — the fail-closed finding names no cause. | blind-a#8 | **P** |
| B22 | LOW | Nothing checks NOTICE/`--summary`/`--evidence` are three distinct paths; `--summary <NOTICE_PATH>` overwrites the published NOTICE **after** every gate passed. | blind-b#8 | **P** |
| B23 | LOW | `fs.writeFileSync(NOTICE_PATH, …)` and `renderNotice` on the clean path are unwrapped → ENOSPC reports as exit 1 (compliance failure). The identical call in the failure branch **is** wrapped. | blind-b#10, edge-buildscript#7 | **P** |
| B24 | LOW | The local tag survives every failure after `docker tag`, contradicting the header's "leaves no local artifact behind". | edge-buildscript#9 | **P** |

## Cluster C — exedev src (`src/providers/exedev/`)  → fixer FIX-SRC-EXEDEV

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| C1 | MED | `create()` rethrows `ExeDevDriverError` **before** `redactRegistryAuth` on the unverified premise "our own typed errors never carry the credential". | blind-src#3 | **P** (scrub unconditionally) |
| C2 | MED | `...opts` spread last defeats the both-or-neither pin guard when a caller passes `{ image: undefined }` — driver falls back to `DEFAULT_IMAGE_REF` paired with an override buildId. | blind-src#4 | **P** |
| C3 | MED | B0 hands **one** `budgetFree()` snapshot to two sequential execs (`test -f` then `cat`), so wall time is ~2× the remaining budget. | blind-src#5 | **P** (absolute deadline shared across both legs) |
| C4 | MED | `expanduser` returns the path **unexpanded** when `HOME` is unset and passwd lookup fails → non-empty, guard passes, `[ ! -f "~/..." ]` true → a present registry reads as tolerated absence. The one fail-OPEN shape. | edge-src#2 | **P** (`case "$models_json" in /*) ;; *) refuse ;; esac`) |
| C5 | MED | A D-pre refusal exits 3 before C runs, so the result has `assertionCode: 3` with **no C row at all** — indistinguishable from a gate never asked to run it. Breaks the `controlled` branch's stated premise. | edge-src#3 | **P** |
| C6 | MED | Gate B compares against `driver.imageBuildId`, which `QDS_EXEDEV_IMAGE_BUILD_ID` overrides — a digest-shaped override is silent (announce arm only fires for a tag pin). | auditor#3 | **DN→P** (keep AC3's override, make it **loud**: announce whenever the effective ref ≠ `DEFAULT_IMAGE_REF`) |
| C7 | LOW | Lapsed ratification throws before `create_requested` and outside the try → no `create_failed` event for the one new failure mode this PR introduced. | blind-src#7 | **P** |
| C8 | LOW | `redactRegistryAuth`'s docblock claims coverage (`line-wrapped secret`) that `split(secret)` cannot provide. | blind-src#8 | **P** (comment) |
| C9 | LOW | D-pre adds up to two **unbounded** `pi --version` calls ahead of the whole gate, in a script whose header says pi stalls nondeterministically. | blind-src#9 | **P** |
| C10 | LOW | Credential file is opened/fstat'd/mode-checked/read even when `opts.registryAuth` will discard it. | edge-src#5 | **P** |
| C11 | LOW | No size bound on the credential file read — `stat.size` is in hand and unused; the 512-byte ceiling is enforced only after the bytes are in memory. | edge-src#6 | **P** |
| C12 | LOW | `marker_assert_ms` has no `>= 1` clamp while its neighbour `boot_ready_ms` does — a sub-ms B0 read publishes the never-evaluated sentinel. | edge-tests-unit#4 | **P** |

## Cluster D — fleet + credentials (`src/fleet/`, `src/providers/credentials.ts`)  → fixer FIX-SRC-FLEET

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| D1 | HIGH | The new `null` transport skip is **never counted** — `runRace` increments `unusableTicks` only for `"unusable"`, so a permanently-dead arm still never reaches `MARKER_UNUSABLE_TICKS_LIMIT` and the race still spins to its full ceiling holding the fleet lock. The change's own comment claims to fix exactly this. | edge-src#1, blind-src#1 | **P** |
| D2 | MED | Box-controlled `probeStderr` goes **raw** into a logged `Error` message on the fanout path, while the sibling gate path `JSON.stringify`s it for exactly this reason (log-line forgery). | blind-src#2 | **P** |
| D3 | LOW | Compensation logger passes a possibly-non-string rejection to `redactSecrets`; and a **successful** compensation (live key minted then revoked) is logged nowhere. | blind-src#6 | **P** |
| D4 | HIGH | `src/providers/credentials.ts` (DF2.3 region) was modified in a story that says "no DF2.3 code is touched" — no AC, no Files-to-Modify entry, no deviation record. | auditor#1 | **P** (record as a deviation in the story; the code change itself is correct and stays) |
| D5 | HIGH | `src/fleet/fanout-primitive.ts` change was explicitly **deferred** in round 2 ("Out of this PR's clusters") and landed anyway; the deferral text is now false. | auditor#2 | **P** (record as a deviation; fix D1 so the change actually delivers what it claims) |

## Cluster E — image + unit (`oci/`, skill doc)  → fixer FIX-OCI

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| E1 | HIGH | `pi` is installed over the network with **zero** integrity verification, directly below a bun step that pins an in-repo sha256. pi is the binary that runs with the per-run LLM key. | blind-oci#1 | **DN→P** (cannot invent an upstream checksum; record the **observed** sha256 of the installed pi binary into `/etc/qds-image.json` and the build evidence so drift is detectable, and say so plainly) |
| E2 | HIGH | `org.opencontainers.image.licenses="MIT"` is contradicted by `binary-licenses.json` in the same PR (statically-linked LGPL-2.0-or-later JavaScriptCore, plus a whole GPL userland). | blind-oci#2 | **P** (`NOASSERTION` + pointer to the NOTICE) |
| E3 | MED | `# syntax=docker/dockerfile:1` is the only unpinned upstream in a file whose doctrine is "digest-pinned, never `:latest`" — and it is *executed* as the build frontend. | blind-oci#3 | **P** |
| E4 | MED | The AC6 `QDS_*` sweep claims "the complete set" of surfaces and omits every systemd env surface except the unit file (`/etc/systemd/system.conf*`, unit drop-ins) plus `~/.bashrc`/`/etc/profile`. | blind-oci#4, edge-src#4, auditor#8 | **P** |
| E5 | MED | `[Install] WantedBy=multi-user.target` on a per-run template is the double-spend `Restart=no` exists to forbid — an enabled instance restarts on every boot. | blind-oci#5 | **P** (delete `[Install]`) |
| E6 | MED | No `TimeoutStopSec=`/`TimeoutStartSec=` — the 90 s default SIGKILL lands mid-`git push`/mid-LLM-call on the routine teardown path. | blind-oci#6 | **P** |
| E7 | MED | `binary-licenses.json`'s `$comment` gives two incompatible rules for a top-level `NOASSERTION`. | blind-oci#7 | **P** (match the comment to `validateBinaryLicenses`' actual behaviour) |
| E8 | MED | The Dockerfile BUMP PROCEDURE omits the private-mirror re-push that `SKILL.md` documents as required — following it verbatim gives a green build and a red AC4. | blind-oci#8 | **P** |
| E9 | MED | `SKILL.md` tells two mutually exclusive stories about roster path resolution (`dirname(manifestPath)/roster.yaml` vs `QDS_EXEDEV_ROSTER`). | blind-oci#9 | **P** (verify in source, then state one) |
| E10 | LOW | `chown -R /home/exedev/.local` puts the target of the root-owned `/usr/local/bin/pi` symlink under the login user's control. | blind-oci#10 | **P** |
| E11 | LOW | `version` fields in the legal artifact contain prose, not versions. | blind-oci#11 | **P** |
| E12 | LOW | Every `licenseUrl` targets mutable `blob/main/` in a table that argues against exactly that. | blind-oci#12 | **P** |
| E13 | LOW | `EnvironmentFile=` is mandatory-form with `Restart=no` and no ordering on the credential delivery → generic 203/EXEC instead of a legible cause. | blind-oci#13 | **P** (`ConditionPathExists=`) |
| E14 | LOW | `After=` with no `Requires=` on the unit's stated hard dependency. | blind-oci#14 | **P** |

## Cluster F — live e2e (`tests/fleet/e2e/`)  → fixers FIX-LIVE-T1, FIX-LIVE-T2345

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| F1 | BLOCKER | AC4 positive leg leaks a **billing box**: `posCreated = true` is set *after* `create()`, which has three documented throw sites *after* the box exists at the substrate. Sibling file gets this right. | edge-live-t1#1 | **P** |
| F2 | BLOCKER | `teardownQuietly` was wired into only **2 of 9** `finally` teardowns; the other 7 still let a 180 s `runFleet` rejection escape the `finally`, skipping `destroyQuietly`, the leak sweep, `writeEvidence`, the workspace `rmSync` and `settleRun`. Amplified in the fanout tiers (one timeout skips every later arm). | edge-live-t2345#1 | **P** |
| F3 | HIGH | AC4 negative-control box leaks if the unguarded `negDriver.list()` probe throws — the `finally` has no `negVm` branch at all. | edge-live-t1#2 | **P** |
| F4 | HIGH | Three files newly **add** `expect(destroyFailures).toEqual([])` ahead of `if (failure) throw failure` — the exact shape `settleRun` was written to delete; a red run discards the body's real error. | edge-live-t1#3 | **P** |
| F5 | HIGH | T5.1's box-absence verdict is vacuously true when the box name could not be recovered and one un-retried `list()` comes back empty (25 s+ substrate lag is measured in this repo). No `fleetCleanupProblems` backstop. | edge-live-t2345#2 | **P** |
| F6 | HIGH | T5.1 was left on the pre-`settleRun` shape — the diff edits that exact block without converting it. | edge-live-t2345#3 | **P** |
| F7 | MED | The "is the mirror actually private?" guard can never fire: GHCR answers 401 with a Bearer challenge for **public** packages too, and this `fetch` never follows the challenge. Dead code; if the mirror is flipped public the negative leg proves nothing. | edge-live-t1#4 | **P** |
| F8 | MED | The AC4 negative control passes on **any** create failure, not on an auth failure — the error shape is captured into evidence and never asserted. Compounds with F7. | edge-live-t1#5 | **P** |
| F9 | MED | `tier1-image-contract` file timeout (1 500 000 ms) is budgeted on typical probe latency; the sum of declared ceilings is ~2 900 s. A bun test-timeout abort is the one path that leaks a box **and** never revokes the key. | edge-live-t1#6 | **P** |
| F10 | MED | `teardownQuietly` writes a **failed** teardown into evidence with no `ok` field — indistinguishable from success under the repo's `phase === X && ok === false` audit idiom. | edge-live-t2345#4 | **P** |
| F11 | MED | An evidence-write failure in the `finally` makes `settleRun` unreachable in 9 tiers — the held body error *and* every cleanup verdict are replaced by the write error. Triggered by exactly the condition (a key leaked into evidence) that most needs the verdict. | edge-live-t2345#5 | **P** |
| F12 | MED | T3.4a's best-effort in-body residue cleanup was promoted to a run-failing verdict without the idempotence `destroyQuietly` provides. | edge-live-t2345#6 | **P** |
| F13 | LOW | AC4 test never `rmSync`s its tmp workspace; the hoisted `let workspace = ""` reads as if cleanup were handled. Leaves the 0600 posture file behind every round. | edge-live-t1#7 | **P** |
| F14 | LOW | A TIER-2-gated test carries a `tier1-` filename, so the natural `tier1-*` sweep red-fails on `liveGate("2")`. | edge-live-t1#8 | **P** |
| F15 | LOW | `teardownQuietly`'s `...label` is spread after `phase`, so a caller can silently rewrite the entry's discriminator. | edge-live-t2345#7 | **P** |
| F16 | MED | `preflight`'s image-override warning is stderr-only; the docblock claims it is "RECORDED". A round against `QDS_EXEDEV_IMAGE=<other>` yields evidence indistinguishable from a repo-pinned round. | edge-live-t2345 coverage | **P** |
| F17 | MED | 7 of 9 tiers have no OpenRouter key-hash delta and no `revokeQuietly` fallback — a teardown that exits 0 without revoking passes all seven green. | edge-live-t2345 coverage | **D** — real coverage gap, but adding a key-hash delta to 7 live tiers is a test-design change of its own size; recorded in the story for a follow-up. |

## Cluster G — unit/contract tests  → fixers FIX-FIXTURE (wave 2), FIX-TESTS-CONTRACT (wave 3)

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| G1 | MED | Password-half leak test's `JSON.stringify(lines)` absence claim is unguarded — passes vacuously if `create()` emits nothing. Every sibling guards this. | blind-tests-contract#1 | **P** |
| G2 | MED | Redaction asserted only as "secret absent + marker present" — total obliteration of stderr passes all three tests; no test that redaction does **not** fire without a credential. | blind-tests-contract#2 | **P** |
| G3 | MED | "Not a cent was spent" is an unguarded absence over a filtered array — argv drift makes `boxCmds` empty and the claim vacuous. The sibling using the same filter self-guards. | blind-tests-contract#3 | **P** |
| G4 | MED | INV-IBOX-2 both-or-neither is asserted only at the factory; ~a dozen tests construct the split pin through `new ExeDevDriver` and assert success, with no test claiming it is refused *or* intentionally allowed. | blind-tests-contract#4 | **P** |
| G5 | MED | Exit-code taxonomy half-built: the `cat` leg is never tested for 255 or 143 — the most likely real transport fault on that leg. | blind-tests-contract#5 | **P** |
| G6 | MED | The frozen clock leaks out of the "MUST STAY LAST IN THIS FILE" test into a whole trailing `describe` — and this PR raised a timeout instead of restoring the clock. D10 drives the gate through a budget that cannot run out. | edge-tests-unit#1 | **P** |
| G7 | MED | Nothing tests the `grep -xE` exact-line pi version pass — all three doubles print a bare version, so deleting the guard keeps every AC2/D7 test green while every banner-printing box refuses D. | edge-tests-unit#2 | **P** |
| G8 | MED | "every declared input has a mutation case below" never checks a mutation case exists — `mutations` is keyed by free-form English and is not linked to `allInputs`. | edge-tests-unit#3 | **P** |
| G9 | MED | `imageMarkerTruncated` serves `exitCode: 0`, which the production seam cannot produce (a cap breach SIGKILLs → 137 + truncated). No gate-level test covers a real cap hit; the ordering in `transport.ts` is unpinned by the fake. | edge-tests-assets#1 | **P** |
| G10 | MED | The fake records `--image` and then serves `DEFAULT_IMAGE_MARKER` regardless — every box "booted" the pinned image no matter what the driver asked for, so a wrong-ref regression passes gate B green. | edge-tests-assets#2 | **P** |
| G11 | LOW | `expect(fake.calls).toEqual([])` after constructor-only refusals is dead, and its rationale comment inverts the argument. | blind-tests-contract#6 | **P** |
| G12 | LOW | `Object.keys(EVERY_ASSERTION_ITEM)` asserts a literal the test itself wrote; `bun test` does not typecheck, so the compile-time half is not carried at runtime. | blind-tests-contract#7 | **P** |
| G13 | LOW | Canary leak assertions are constant-true on 13 of 15 ratification arms. | blind-tests-contract#8 | **P** |
| G14 | LOW | The 0600 fixture's mode is not pinned by `chmod`, in the one test whose subject is file mode — the sibling 0644 fixture does chmod, with a comment saying why. | blind-tests-contract#9 | **P** |
| G15 | LOW | "the four copies" of the steering tuple is five — `BOX_STEERING_ROOT_SH` (`attach.ts:80`), the one the box-side scripts actually run, is unguarded here. | edge-tests-assets#3 | **P** |
| G16 | LOW | The tmpfiles negative control exercises `tmpfilesEntries` (a pure `split`), not the assertions it claims to guard. | edge-tests-assets#4 | **P** |

## Cluster H — story artifact  → wave 3

| # | Sev | Finding | Sources | Class |
|---|-----|---------|---------|-------|
| H1 | LOW | "13 files touched, not 10" is stale (≥5 more), and there is no round-3 record though commit `c52f4d0` is titled "review round 3". | auditor#6 | **P** |
| H2 | LOW | AC7(c)'s cold-boot falsifier is a `0` sentinel in the **build** evidence; the real number lives only in the live-e2e evidence. | auditor#7 | **D** — documented sentinel convention (Observability Contract: a field never evaluated reports 0); the number exists and is honest. Recorded. |
| H3 | MED | The provenance gate cannot fail for the only artifact that ships (the shipped pin is the register's single exception), in the same PR as "a gate with a documented bypass is not a gate". | auditor#4 | **D** — self-expiring, reasoned, owner named. A1/A3 make the expiry real, which is the part that was broken. Recorded. |

---

## Totals

- **Patch:** 84
- **Defer:** 8 (A13, A14, A15, A16, F17, H2, H3, + B10 conditionally)
- **Dismiss:** 1 (A17 — verified against `.github/dependabot.yml:25-31`)
- **Decision-needed, resolved fail-safe:** 3 (A7, C6, E1)
