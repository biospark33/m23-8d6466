# PR #184 (DF2.10) — review round 1 triage ledger

Sources: 9 reviewers (4 blind, 4 edge, 1 auditor). Raw findings ≈156 → 118 patch / 9 defer / 8 dismiss after dedupe.

## Dismissed (verified false against real source)

| # | Finding | Why dismissed |
|---|---|---|
| X1 | blind-srcoci HIGH — `assertions-in-box.sh` refusal contains `production-legal`, pass-matcher may glob it | edge-srcoci read the real `case` arms (`:236-243`): they are `*"custom registry absent"*` and `*" models priced"`. The refusal matches neither. |
| X2 | blind-srcoci MEDIUM — `readFileSync` used with no import | edge-srcoci verified the import at `driver.ts:28`. Compiles. |
| X3 | blind-srcoci MEDIUM — `pi --version` parsed two contradictory ways (Dockerfile exact-eq vs grep) | edge-srcoci verified real output is bare `0.84.4`; both spellings agree. (The *doc comment* contradiction is real — kept as P-DOC-3.) |
| X4 | blind-ci MEDIUM — SKILL.md roster instructions self-contradictory | edge-ci verified `liveGate` (`live-harness.ts:42-66`) checks six env vars and never opens the roster; `dirname(manifestPath)/roster.yaml` is `dispatch.ts:1424`. Both statements are true of different mechanisms. |
| X5 | blind-ci LOW — SKILL.md env block omits `OPENROUTER_PROVISIONING_KEY` | edge-ci verified the var is exported above the visible hunk context. |
| X6 | blind-ci LOW — the two new tier-1 rows may lie about spend | edge-ci ran the documented grep on all four files; every `liveGate` argument matches the table. |
| X7 | blind-ci LOW — `attest-build-provenance` SHA pin depends on a dependabot `github-actions` entry that may not exist | verified present in `.github/dependabot.yml` (pre-existing entry, above the diff hunk). |
| X8 | edge-ci "checked and consistent" list (tmpfiles ↔ driver ↔ Dockerfile, unit env path, production driver construction, `--image`/`--registry-auth` flag existence) | no defect. |

## Deferred (real, but the fail-safe call is not to act in this round)

All five image-content items share one reason: **`deriveBuildId` hashes the Dockerfile bytes and the systemd unit bytes.** Any edit to them moves the buildId, moves the digest, and invalidates the pin that was live-booted and proven in this PR's e2e round. DF1.10 adds the engine build stage to this same Dockerfile and re-pins — that is the correct moment.

| # | Finding | Source |
|---|---|---|
| D-1 | pi is installed with no checksum/signature while bun is `sha256sum -c`'d | blind-srcoci MED |
| D-2 | `qds-run@.service`: `After=` is not `Requires=`; `EnvironmentFile=` has no `-` prefix | blind-srcoci MED, edge-srcoci LOW |
| D-3 | no cheap systemd hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem`), no `TimeoutStopSec`; `%i` unquoted in the `ExecStart` contract comment; `[Install]` ships on a unit systemd refuses | blind-srcoci LOW ×3 |
| D-4 | AC6's "complete set of surfaces" omits `DefaultEnvironment=`, `/etc/systemd/system.conf.d/`, unit drop-in dirs | blind-srcoci LOW, edge-srcoci LOW |
| D-5 | dependabot cannot bump a digest-only `FROM`; fix is `exeuntu:latest@sha256:…` (a Dockerfile edit) | blind-ci MED, edge-ci MED — **comment corrected in-round**, tag lands at the next re-pin |

Other defers:

| # | Finding | Why |
|---|---|---|
| D-6 | major-tag (not SHA) pins on `actions/checkout@v7`, `oven-sh/setup-bun@v2`, `actions/upload-artifact@v4` | repo-wide convention; DF2.9's record documents the v7 downgrade scar. Changing three actions in one workflow diverges from the other 8 workflows. |
| D-7 | `workflow_dispatch` from any branch publishes to the production package with no `environment:` approval gate | an `environment:` with required reviewers blocks the documented bootstrap ritual (first publish must fail the gate by design). Operator/infra decision. |
| D-8 | nothing on the consuming side verifies the Sigstore attestation | out of DF2.10's scope; no AC covers consumption. Recorded. |
| D-9 | the publish workflow has never executed; the pinned image was pushed by hand | already disclosed in the Dev Agent Record. Unchanged by this round. |

## Decision-needed → resolved conservatively (fail-safe), surfaced

| # | Ambiguity | Resolution taken |
|---|---|---|
| Q-1 | The image tag is baked into the marker, so the digest is a function of `--tag`. Fix = remove the ref from the marker, **or** add the tag to `deriveBuildId`. Both invalidate the shipped pin. | **Keep the behaviour.** Do not invalidate a live-booted pin. Instead make the workflow gate's failure message name the cause explicitly so the operator is not sent chasing a phantom compromise. |
| Q-2 | The push happens before the digest gate, so the gate reports rather than refuses. | **Keep** — a digest cannot be compared before it exists. Correct the two overclaiming comments (workflow header, build-script header) to state what actually happens: production is protected by the pin; the *package* accumulates unreferenced per-revision tags. |
| Q-3 | `--image` is an unconditional spread; AC3 says "conditional". | **Keep unconditional** — always-pinned is the fail-safe posture; a conditional spread reintroduces an unpinned boot path. Correct the AC/comment wording instead. |
| Q-4 | Gate B reads `marker.imageRef` and never asserts it. | **Keep not asserting** — a D7 tenant mirror keeps the digest but not the ref. Pin the decision with a test and a comment so a future tightening is deliberate. |
| Q-5 | `scripts/build-exedev-image.ts` is in `SOURCE_PATHS` but `.dockerignore` excludes it from the build context, so a comment-only edit invalidates the pin. | **Keep it in `SOURCE_PATHS`** — its constants (`PI_VERSION`) *are* build args and therefore digest inputs. Over-triggering is the safe direction. Document the cost in the lockstep comment. |
| Q-6 | Binaries replaced in place at an existing path escape AC5 attribution (`added = builtBins \ baseBins` is a path-set difference). | **Tighten to path+content**: set difference over `path\tsha256`, so replaced bytes register as added. This strengthens a compliance gate; the failure direction is "more things need attributing", never fewer. |

## Patch (fix in this round) — by fix cluster

### W1-A — `.github/workflows/publish-exedev-image.yml`, `.github/dependabot.yml`, `.gitignore` (14)
A1 NOTICE never uploaded: workflow `BUILD_DIR: oci/exedev/.build` ≠ script `oci/.build/exedev` (edge-ci HIGH; blind-ci LOW dup) ·
A2 `package.json` is a buildId/digest input outside both `on.push.paths` and `SOURCE_PATHS`; a bun bump stamps a *different* revision's sha into the marker (edge-ci MED, edge-buildscript MED, blind-ci LOW) ·
A3 a re-pin commit (`driver.ts`-only) matches no trigger, so the documented recovery cannot clear a red `dev` (blind-ci HIGH, edge-ci MED) ·
A4 pin-read step dies under `set -euo pipefail` before printing the diagnostic it exists to print (blind-ci MED) ·
A5 the 403 registry explainer fires for sweep/scan/OOM failures and overwrites the real cause (edge-ci MED) ·
A6 `jq -r .token` → `Bearer null` misreported as "package is not public" (edge-ci LOW) ·
A7 anonymous-pull probe: no `--max-time`/`--retry`, `code=000` reported as "not public" (edge-ci LOW, blind-ci LOW) ·
A8 `IMAGE`/`IMAGE_PATH` duplicated with no lockstep guard (blind-ci LOW, edge-ci LOW) ·
A9 fork pushes run the full build before 403ing on a hardcoded package path (edge-ci LOW) ·
A10 a missing `/etc/qds-image.json` fails the gate with a bare `cat` error, skipping every diagnostic (edge-ci LOW) ·
A11 `oci/exedev/.build/` un-gitignored (edge-ci LOW; dissolved by A1) ·
A12 the sentinel-pin refusal `isUnpinnedImage`'s comment promises does not exist in the workflow (auditor LOW) ·
A13 the `attest` job's stated concurrency race cannot happen — the group is workflow-scoped (blind-ci LOW) ·
A14 comment corrections: the workflow file is itself a digest input via the tag string but is in neither path list (blind-ci MED); the "bun bump is caught one field over" claim is false (blind-ci LOW); dependabot digest-only `FROM` limitation (D-5); Q-1, Q-2, Q-5 wording.

### W1-B — `scripts/build-exedev-image.ts`, `tests/scripts/exedev-bun-pin.test.ts` (25)
B1 `sweep.unreadable` / `unresolved` / `missingTexts` never gated — DF2.9's fail-closed signals dropped (edge-buildscript HIGH) ·
B2 `extractNodeModules` uses `docker cp` without `-L`; a symlinked npm tree ⇒ `treePackageCount === 0` ⇒ the AC5 gate passes an unswept tree (edge-buildscript HIGH) ·
B3 `imageSourceSha()` returns the literal `"unknown"` on the unvalidated git path, which the Dockerfile's `-n` guard accepts (blind-buildscript MED, edge-buildscript HIGH) ·
B4 `--tag` is never shape-validated; a comma injects buildx `--output` attributes (incl. `push=true`) into the *pre-gate* build (blind-buildscript HIGH, edge-buildscript LOW) ·
B5 `runtimeBaseRef = baseRefs[last]` is wrong for the multi-stage shape `parseBaseRefs` supports — AC5's negative control diffs against the wrong base (blind-buildscript HIGH) ·
B6 `die()` is `process.exit`, so every `finally` is skipped: containers, temp trees and a 1.6 GB archive leak; no SIGINT/SIGTERM handling (blind-buildscript MED ×2 + LOW, edge-buildscript LOW) ·
B7 `containerimage.digest` read as one flat key from a two-exporter solve (blind-buildscript MED, edge-buildscript MED) ·
B8 base digest resolved three independent times against a floating tag (registry / buildx / local daemon) (blind-buildscript MED) ·
B9 `ensureReproBuilder` accepts a pre-existing `qds-repro` on the wrong driver (blind-buildscript MED, edge-buildscript MED) ·
B10 a broken-but-present builder is unrecoverable and the printed remedy is the command that just failed (edge-buildscript MED) ·
B11 Q-6 — replaced-in-place binaries escape attribution; `uncoveredBinaries` matches on basename only ·
B12 fixed `archive`/`metadataFile` paths ⇒ concurrent runs clobber each other (blind-buildscript MED) ·
B13 post-push `RepoDigests` fallback can supply a stale digest, reported as a supply-chain compromise (blind-buildscript MED, edge-buildscript LOW) ·
B14 stale `--summary`/`--evidence` JSON survive a failed build and are read by the live test (edge-buildscript MED) ·
B15 unguarded `readFileSync` on `package.json` and the systemd assets ⇒ exit 1 (compliance) for a missing input (edge-buildscript MED) ·
B16 `writeJson` failure exits 1 *after* a successful push (edge-buildscript MED) ·
B17 `sizeOf()` records `0`/`null` for an ADR-named falsifier (blind-buildscript LOW, edge-buildscript MED) ·
B18 `binary-licenses.json` containing `null` throws `TypeError` ⇒ exit 1, not 2 (blind-buildscript LOW) ·
B19 `SECRET_ENV.test()` in a loop is stateful if the imported regex carries `/g` (blind-buildscript LOW) ·
B20 the sweep's healthy path depends on matching another module's error *prose* (blind-buildscript LOW) ·
B21 `--push`/`--keep-tree` via `argv.includes` mis-parse as another flag's value (blind-buildscript LOW, edge-buildscript LOW) ·
B22 tar/history output split on `\n` with no allowance for embedded newlines (blind-buildscript LOW) ·
B23 `/usr/bin/find` hardcoded inside both images (blind-buildscript LOW) ·
B24 `SOURCE_DATE_EPOCH` accepts `0`/leading zeros (blind-buildscript LOW, edge-buildscript LOW) ·
B25 `PI_VERSION`/`BUN_VERSION` duplicated as dead Dockerfile `ARG` defaults with nothing binding them; nothing binds `BUN_VERSION`→`BUN_SHA256` (edge-buildscript LOW ×2, edge-tests MED) · `inspectConfigs` EISDIR false credential finding (edge-buildscript LOW) · NOTICE written before the credential gate (edge-buildscript LOW) · `docker create` output used as a cid with no shape check (edge-buildscript LOW) · `readBunPin` should throw so its four rejection paths are testable (blind-tests MED).

### W1-C — `src/providers/exedev/driver.ts` (13)
C1 **AC4 MISSING** — the private-registry path is not refused unless a ratified INV-IBOX-3 deviation is recorded in `postureFile` naming `read:packages` scope, expiry and rotation owner (auditor HIGH) ·
C2 a *thrown* (not non-zero) `control()` call leaks the registry credential unredacted and emits no `create_failed` (blind-srcoci HIGH) ·
C3 the registry-auth file's 0600 mode is asserted in prose three times and checked nowhere (blind-srcoci LOW, edge-srcoci MED, auditor HIGH) ·
C4 `QDS_EXEDEV_IMAGE` and `QDS_EXEDEV_IMAGE_BUILD_ID` are read independently; setting either alone fails every box at gate B with a misleading message (blind-srcoci MED, edge-srcoci MED) ·
C5 `exeDevDriverFromEnv` spreads `...opts` first, so the environment clobbers explicit caller options (blind-srcoci MED) ·
C6 the docstring names `QDS_EXEDEV_REGISTRY_AUTH`; the code reads `QDS_EXEDEV_REGISTRY_AUTH_FILE` (blind-srcoci MED) ·
C7 `imageBuildId` is the only new constructor option with no validation (edge-srcoci LOW, blind-srcoci MED) ·
C8 `redactRegistryAuth` is exact-full-string only — a password-half echo leaks (blind-srcoci LOW, blind-tests LOW, edge-tests MED) ·
C9 `create_failed` omits `imageDigest` and hand-rolls `imageFields()`; `create_requested` omits `create_ms`; `boot_ready_ms` exists nowhere (blind-srcoci LOW, edge-srcoci LOW, auditor MED ×2) ·
C10 `assertRegistryAuth`'s metacharacter denylist omits `#`, which truncates the remote command line (edge-srcoci LOW) ·
C11 `assertImageRef` admits mutable tags and the env seam feeds them straight in with no warning event (blind-srcoci LOW) ·
C12 `assertImageRef`'s remediation example uses uppercase, which its own regex rejects (auditor LOW) ·
C13 `isUnpinnedImage`'s comment claims a workflow refusal that does not exist (auditor LOW; paired with A12).

### W1-D — `src/providers/exedev/transport.ts`, `setup-gate.ts`, `assertions-in-box.sh` (11)
D1 **Gate B0 can THROW out of `setupGate`** — `readBoxFile`'s `withTimeout` rejects, breaking the "failure RETURNS a payload" contract and downgrading dispatch's exit-3 to exit-1 (edge-srcoci HIGH, edge-tests MED) ·
D2 B0 reports an ssh transport failure (exit 255/137) as "this box did not boot a factory image" (edge-srcoci HIGH) ·
D3 **AC1c** — `imageMarkerFailure` returns a bare string; `{ code, message, remediation }` is discarded, `image-marker-mismatch` never reaches a production caller, and `debugCommands` was not extended (auditor MED) ·
D4 B0 spends gate budget with no re-check, passes the *same* `deadlineMs` to two calls, and uses `exec` (fixed 120 s) not `execTimed` (blind-srcoci MED, edge-srcoci MED) ·
D5 the `dp:ok` suppression on `readBoxFile` now asserts something false — "sole caller … wraps in try/catch" (edge-srcoci MED) ·
D6 `PI_REVIEWED_SERIES` is not bound to `PI_VERSION`, and the refusal fires *after* the paid `pi -p` call (edge-srcoci MED, edge-tests HIGH) ·
D7 D's unreviewed-series refusal blames `PI_VERSION` when the real cause is a `pi` that cannot report a version (edge-srcoci LOW) ·
D8 box-controlled `marker.imageRef` and stderr are interpolated raw into logged gate notes (blind-srcoci LOW) ·
D9 the 4096 cap is counted in UTF-16 code units against the Dockerfile's `stat -c %s` bytes, and `>` vs `>=` disagrees across three places (blind-srcoci LOW, edge-srcoci LOW, edge-tests LOW) ·
D10 `emitGate(…, "marker_assert", …)` produces a `marker_assert_ms` field no `gate_*` filter picks up (edge-srcoci LOW) ·
D11 `IMAGE_MARKER_MAX_BYTES`'s comment says the marker is 154 bytes; the live round measured 238 (auditor LOW) · Q-4 comment.

### W1-E — `oci/exedev/binary-licenses.json` (lead, 2)
E1 attributes `bunx`, which the Dockerfile never installs (blind-srcoci MED, edge-srcoci LOW) ·
E2 the `$comment` rule "every `spdxId` must resolve to a canonical text" is contradicted by `bundled[]`'s `LGPL-2.0-or-later` and `NOASSERTION` (blind-srcoci MED).

### W2 — tests (after source settles)
W2-A `image-contract.test.ts` + `fixtures/fake-exedev.ts` (13): `captureLog` swallows the throw · `newArgv()` `[]` makes every `.not.toContain` vacuous · `fake.creates[0]?.` optional chaining · the fake falls through to the HOST `/etc` for any verb but `test -f`/`cat` · the fake hardcodes `piVersion`/`bunVersion` beside an imported `buildId` · `unreadable`/`oversized` arms unreachable through the fake · the `why` regexes are supersets · no refusal test through `exeDevDriverFromEnv` (the only untrusted source) · no coverage for `QDS_EXEDEV_REGISTRY_AUTH_FILE` / `QDS_EXEDEV_IMAGE_BUILD_ID` · `remediation.includes(secret)` is element-equality on `string[]` · redaction tested in one spelling only · `fake.calls toEqual([])` is order-dependent shared state · `evidenceDir` never created · 180 s for seven create→fill→gate cycles · Q-4's decision needs a pinning test · `isUnpinnedImage` has no tag-case test · `assertRegistryAuth`'s 512-byte arm and `IMAGE_REF_RE`'s uppercase/dotless-host cases are untested.
W2-B `setup-gate.test.ts` (4): `PI_REVIEWED_SERIES` re-typed as a literal in two shims · the AC2 test consumes `f11-roster.yaml` it does not create · the round-4 timing test kept a ~1 050 ms margin across two more taxed calls · the AC2 shell test inherits the host env including `OPENROUTER_API_KEY`.
W2-C `tier1-image-contract.live.test.ts` (10): `revokeQuietly`'s `store.get` is outside its own try and can throw before `destroyQuietly` · the revoke is gated on `mintedHash` not on the record · `pollBootId` has no per-exec timeout · `writeEvidence` throwing in `finally` replaces the real failure · a failed `destroyQuietly` still reports green · `rebootExit` recorded and never checked · repo-pin assertions run after the paid `create()` · vacuous marker-shape assertions · the 4096 off-by-one · nothing links `marker.bunVersion` back to `package.json`.
W2-D new `tests/scripts/build-exedev-image.test.ts`: `deriveBuildId` has zero tests (edge-tests HIGH) and five of six exported functions are uncovered (`parseBaseRefs`, `nodeModulesRoot`, `validateBinaryLicenses`, `uncoveredBinaries`) · `readBunPin`'s four rejection paths.
W2-E new `tests/providers/exedev/systemd-unit.test.ts`: **AC6's stated negative control has no failing test** — `Restart=no`, `User=exedev`, literal `EnvironmentFile=/home/exedev/app/.env`, `After=systemd-tmpfiles-setup.service` are asserted by nothing (auditor MED).
