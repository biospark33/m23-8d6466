# DF2.10 (PR #184) — Acceptance Audit

Satisfied: 8 of 11 ACs.

(AC units counted: 1, 1a/b, 1c, 2, 3, 4, 5, 6, 7a, 7b, 7c. Satisfied: 1, 1a/b, 2, 3, 5, 7a, 7b, 7c. Partial: 1c, 4, 6. Additional findings below cover the Observability Contract and INV-IBOX-2/3, which are constraints rather than numbered ACs.)

---

## [HIGH] AC4's "refused unless the ratified deviation is recorded" is not implemented at all

- **AC / constraint violated:** AC4 — "Given the operator instead selects a private image, Then the value is read from a 0600 host file, is redacted in every `emit()` line, never appears in the `create_shape` provenance record, and **the path is refused unless the ratified deviation INV-IBOX-3 requires is recorded where this driver already reads operator attestations (`postureFile`, `driver.ts:198`), naming the PAT's `read:packages` scope, expiry and rotation owner**." INV-IBOX-3: "the private path requires a **recorded operator-ratified deviation**, an unratified one being the exact failure mode this ADR exists to unwind."
- **Verdict:** MISSING
- **File:** `src/providers/exedev/driver.ts:394-409` (constructor), `:1010-1035` (`exeDevDriverFromEnv`); `postureFile` is read only at `src/providers/exedev/driver.ts:754-769`, inside `setPublic`, and nowhere on the `registryAuth` path.
- **Evidence:** The only thing standing between an operator and a credential in ssh argv is `assertRegistryAuth`, which is a *shape* check (`USERNAME:PASSWORD`, charset, length). Set `QDS_EXEDEV_REGISTRY_AUTH_FILE` — or pass `registryAuth` to the constructor — and the flag is spread into argv with no attestation consulted. Three sub-requirements are absent:
  - no read of `postureFile` (or any attestation) for a recorded deviation;
  - no assertion that the deviation record names `read:packages` scope, expiry, or rotation owner;
  - no check that the credential file is mode 0600 — `readFileSync(authFile, "utf8")` at `:1020` accepts any mode, and DF2.1's `assertNoSecret` is never invoked on this path.
  The test suite mirrors the gap rather than catching it: `tests/providers/exedev/image-contract.test.ts:325` is titled *"valid credential: in argv (the ratified D8 deviation)"* and its comment says the path "requires a recorded ratification" — but the test constructs `new ExeDevDriver({ …, registryAuth: VALID_AUTH })` with no attestation present and asserts it **succeeds**. That is an AC requirement inverted into a passing test.
  The Dev Agent Record's justification ("no INV-IBOX-3 deviation needed ratifying" because our own image is public) answers a different question: AC4's requirement is explicitly conditioned on *"Given the operator instead selects a private image"*, and that path ships fully wired and reachable.
- **Why it matters:** The whole reason `--registry-auth` is default-off is that argv is visible in the host process table, which redaction cannot cover. The gate that was supposed to make that deviation deliberate does not exist, so the first tenant who sets one env var takes it silently.

## [HIGH] The recorded pin cannot be reproduced by the publish workflow — the tag is a digest input, and the two use different tags

- **AC / constraint violated:** Files to Modify — "`.github/workflows/publish-exedev-image.yml` (new — publishes and **fails if the pushed digest ≠ the repo pin**)"; AC1 — the marker `buildId` must equal "the one the repo pin pairs with **the digest that was pulled**"; Technical Notes — "Host enforces the digest at pull, box proves the `buildId`, and neither drifts from the other without the gate saying so."
- **Verdict:** PARTIAL
- **File:** `scripts/build-exedev-image.ts:968` (`"--build-arg", \`QDS_IMAGE_REF=${opts.tag}\``) vs `.github/workflows/publish-exedev-image.yml` (the `src` step: `echo "tag=${IMAGE}:sha-${src_sha}"`); pin at `src/providers/exedev/driver.ts:161-162`.
- **Evidence:** The tag string is baked into `/etc/qds-image.json` as `imageRef` and therefore into the layer bytes and the manifest digest. The story's own Known Limitations confirm the mechanism: *"the identical tree built under a different tag yields `sha256:1ccee04d…`, differing only because the tag string reaches the marker."* The pinned, live-booted digest `sha256:a70674b2…` was built by hand **under tag `ghcr.io/biospark33/qds-exedev:df2-10`** (Dev Agent Record, "The pinned digest is unmoved" table). The workflow never uses that tag — it computes `${IMAGE}:sha-${src_sha}`. Therefore the workflow's gate is *guaranteed* to fail on its first execution, print a different digest, and force a re-pin to an artifact that was never live-booted and never passed the e2e round recorded in the Dev Agent Record.
  Gate B cannot detect the swap: `deriveBuildId` (`scripts/build-exedev-image.ts:349-369`) hashes base digests ‖ bun ‖ pi ‖ Dockerfile ‖ systemd units — **not** the tag, the marker, the epoch, or `gitSha`. Both artifacts carry `buildId` `664876fb1a9128ec`.
- **Why it matters:** The artifact production and the artifact proof are decoupled. What the workflow will publish is not what was proven to boot, and the in-box identity check is blind to the difference by construction.

## [MEDIUM] Gate B reads the marker's `imageRef` and never asserts it

- **AC / constraint violated:** INV-IBOX-2 — "image identity is asserted in-box, never assumed … Gate B compares that `buildId` to the one the repo pin pairs with the pulled digest"; Technical Notes — "neither drifts from the other without the gate saying so."
- **Verdict:** PARTIAL
- **File:** `src/providers/exedev/transport.ts` — `imageMarkerFailure`, the `buildId` comparison arm (chunk-src.diff:661-663)
- **Evidence:** `imageMarkerFailure` compares only `marker.buildId !== expectedBuildId`. It then *interpolates* `marker.imageRef` into the failure text (`imageRef in marker: ${marker.imageRef}`) — so the field is read and displayed but never judged. The driver knows the expected value exactly (`this.image`), and `parseImageMarker` already guarantees the field is a non-empty string. Combined with the previous finding (buildId excludes the tag/marker/revision), a box booted from any same-tree build under a different tag or revision passes gate B silently.
- **Why it matters:** A free, already-available assertion is declined, leaving the one in-box identity check strictly weaker than the data it holds.

## [MEDIUM] AC1c's `{ code, message, remediation }` payload is flattened to a bare message string

- **AC / constraint violated:** AC1c — "Fail-closed: absent, over a 4 KiB read cap, unparseable or mismatched refuses the box with `{ code, message, remediation }` **in the payload**"; Observability Contract — "errors carry `{ code, message, remediation }` (`image-invalid`, `registry-auth-invalid`, `image-marker-mismatch`)."
- **Verdict:** PARTIAL
- **File:** `src/providers/exedev/transport.ts` `imageMarkerFailure` (chunk-src.diff:641-665); consumed at `src/providers/exedev/setup-gate.ts:441-444`; result shape at `src/providers/exedev/setup-gate.ts:82-95`
- **Evidence:** `imageMarkerFailure` returns `string | null`. The `absent` / `unreadable` / `oversized` / over-cap arms construct no `ExeDevDriverError` at all, so no `code` and no `remediation` exist for them. The one arm that does — `parseImageMarker`, which throws `ExeDevDriverError("image-marker-mismatch", …, "ssh <vm> 'cat /etc/qds-image.json'")` — is caught and reduced to `` `${prefix}: ${(e as Error).message}` ``, discarding both `code` and `remediation`. The gate pushes `{ item: "B", ok: false, note: markerNote }`; `SetupGateResult` then carries `failedItem: "B"` and `assertionCode: 1` (DF3.1's generic B code), and `debugCommands` (`setup-gate.ts:596-601`) is a fixed list that was **not** extended with a `cat /etc/qds-image.json`. So `image-marker-mismatch` — a code the Observability Contract names by hand — never reaches any production caller; it is only reachable in `tests/providers/exedev/image-contract.test.ts:464`, which calls `parseImageMarker` directly.
- **Why it matters:** The AC's payload contract exists so a boot regression is machine-classifiable and self-remediating. A caller today gets an English sentence and a generic `1`.

## [MEDIUM] AC6's `Restart=no` (and the rest of the unit's policy) is asserted by nothing

- **AC / constraint violated:** AC6 — "a **system** `qds-run@.service` template with **`Restart=no`**, `User=exedev`, `After=systemd-tmpfiles-setup.service` and the **literal** `EnvironmentFile=/home/exedev/app/.env` — `%h` is refused … *Negative control: `Restart=on-failure` here passes a naive "the engine comes back" test, re-walks phases whose commits and spend already happened, and MUST fail this one.*"
- **Verdict:** PARTIAL
- **File:** `oci/exedev/systemd/qds-run@.service:429` (`Restart=no` — correct as shipped); no test found. `grep -rn "qds-run@" tests/ scripts/ src/` returns nothing.
- **Evidence:** The unit file has the right contents, but nothing enforces them. The Dockerfile's build-time check (`RUN … systemd-analyze verify …`) validates *parseability and silence* — `Restart=on-failure`, `%h/app/.env` and `User=root` all pass `systemd-analyze verify` cleanly. The AC6 QDS_* check greps only for `QDS_`. The unit's bytes feed `deriveBuildId`, but a policy edit is inert until someone rebuilds and republishes, and the pin gate compares against whatever the operator pastes in — it is not a policy check. AC6's stated negative control ("`Restart=on-failure` … MUST fail this one") therefore has no failing test to fail.
  Note the tmpfiles half *is* covered, and well: the live e2e reboot proof (`tier1-image-contract.live.test.ts:335-369`) is a behavioural check stronger than a byte assertion.
- **Why it matters:** The one directive whose wrong value causes double-spend and double-commit is guarded only by review.

## [MEDIUM] Observability Contract: `boot_ready_ms` does not exist; two create events drop required fields

- **AC / constraint violated:** Observability Contract — "Every `create()` logs `{ requestId, runId, event, imageRef, imageDigest, registryAuthUsed }`" and "Sub-timings: `create_ms`, `boot_ready_ms`, `marker_assert_ms`. A field never evaluated reports `0`."
- **Verdict:** PARTIAL
- **File:** `src/providers/exedev/driver.ts` — `create_requested` emit (chunk-src.diff:356-361) and `create_failed` emit (chunk-src.diff:378-382)
- **Evidence:**
  - `boot_ready_ms`: a repo-wide grep over `src/ tests/ scripts/` returns **zero** hits. It is emitted nowhere and defaulted to `0` nowhere. (`marker_assert_ms` does exist — `emitGate`'s computed key `` [`${item.toLowerCase()}_ms`] `` at `setup-gate.ts:280` yields it from the `"marker_assert"` item name. `create_ms` exists on `create_shape` / `create_failed`.)
  - `create_failed` carries `{ vm, imageRef, registryAuthUsed, exitCode, create_ms }` — **no `imageDigest`**, though the contract says every create event carries it and `imageFields()` exists precisely to make that impossible to forget. The failure path builds its field object by hand instead of calling `imageFields()`.
  - `create_requested` omits `create_ms` entirely rather than reporting `0` as the contract's "a field never evaluated reports `0`" requires.
- **Why it matters:** `create_failed` is the event a boot regression is diagnosed from, and it is the one missing the join key to the image digest.

## [LOW] `--image` is an unconditional spread, not a conditional one

- **AC / constraint violated:** AC3 — "`create()` threads both flags as **conditional spreads** in the existing argv literal"; Overview — "`create()` gains two **conditional** argv spreads — `--image` and `--registry-auth`."
- **Verdict:** PARTIAL
- **File:** `src/providers/exedev/driver.ts`, the `new` argv literal (chunk-src.diff:369) — `...["--image", this.image],`
- **Evidence:** `--registry-auth` is genuinely conditional (`...(this.registryAuth === undefined ? [] : […])`). `--image` is a spread of a constant two-element array, which is a no-op wrapper around two unconditional elements; there is no path through `create()` that omits `--image`. This is defensible (the constructor always assigns a default) but it is not what the AC specifies, and it removes the ability to create a box on the substrate default — which is the only escape hatch if a published digest is ever unpullable.
- **Why it matters:** Every caller of `create()` — 6 direct, 4 execution flows per the story's own GitNexus impact — now unconditionally boots the pin, with no way to fall back.

## [LOW] The publish workflow — including the entire `attest` job — has never executed; the pinned image was pushed by hand

- **AC / constraint violated:** Definition of Done — "**Impl:** `scripts/build-exedev-image.ts` + the publish workflow; the pushed digest is written back into the repo pin and the workflow fails on mismatch."
- **Verdict:** PARTIAL
- **File:** `.github/workflows/publish-exedev-image.yml` (611 new lines, of which the `attest` job is ~190)
- **Evidence:** Stated plainly by the Dev Agent Record: *"The attestation steps have never executed. This workflow has never run at all — it is absent from the default branch, and the pinned image was built and pushed by hand."* Verification is `actionlint` + `zizmor` + two `run:` blocks extracted and stubbed offline. The gate that is the workflow's entire reason to exist ("publishes and fails if the pushed digest ≠ the repo pin") has never gated the artifact that is actually pinned. Separately, the sigstore/`attest-build-provenance` job is unrequested scope — it appears in no AC, no DoD line and no Files-to-Modify entry — and it is the least-exercised code in the PR.
- **Why it matters:** The honesty of the disclosure is exemplary, but the DoD line is unmet, and ~190 lines of never-run YAML holding `id-token: write` land in the same PR.

## [LOW] The "13 files touched, not 10" deviation record undercounts

- **AC / constraint violated:** Files to Modify (10 entries) and Deviations item 1, which claims the true count is 13 and enumerates the three extras.
- **Verdict:** PARTIAL
- **File:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md:242-245`
- **Evidence:** The PR diff touches 22 paths. Beyond the 10 listed and the 3 declared, it also touches `src/providers/exedev/transport.ts` (described in Deviation 2 but never counted), `tests/providers/exedev/setup-gate.test.ts`, `tests/scripts/exedev-bun-pin.test.ts` (a new file), and `.claude/skills/qds-live-e2e/SKILL.md` — plus `_bmad-output/sprint-artifacts/sprint-status.yaml` and two evidence JSONs. The atomicity audit the deviation cites was answered with a number that is itself wrong.
- **Why it matters:** The deviation record exists so a file-count gate is auditable; an undercounted record defeats it.

## [LOW] `.claude/skills/qds-live-e2e/SKILL.md` edits document other stories' test files

- **AC / constraint violated:** Technical Notes, "Region ownership" — "A change outside your own region belongs in the owning story."
- **Verdict:** PARTIAL (scope creep)
- **File:** `.claude/skills/qds-live-e2e/SKILL.md` (chunk-ci.diff:1-63)
- **Evidence:** The roster-path correction and the "read the call, not the name" guidance are legitimately DF2.10's (they were discovered running this story's e2e). But the same hunk adds `approval-gate` and `attach-transport` to the tier-1 file list and adds a "2 (misnamed)" row naming `tier5-gate-steering` — three test files this story neither adds nor touches.
- **Why it matters:** Small, and the content is correct; it is still an undeclared edit to another story's documented surface.

## [LOW] `isUnpinnedImage`'s doc comment claims a workflow refusal that does not exist

- **AC / constraint violated:** none directly — but the comment is load-bearing documentation for the pin ritual AC1/DoD describe.
- **Verdict:** CONTRADICTED (comment vs. code)
- **File:** `src/providers/exedev/driver.ts:96-99` — "The refusal lives where it belongs instead: `.github/workflows/publish-exedev-image.yml` fails when the pin is still a sentinel"
- **Evidence:** The workflow's "Read the repo pin" step checks only that the constants are non-empty and that the digest has a `sha256:` prefix (`case "$digest" in sha256:*) ;; *) … exit 1 ;; esac`). The all-zeros sentinel `…@sha256:000…0` satisfies both. `isUnpinnedImage` is never referenced by the workflow — it is used only in `tests/providers/exedev/image-contract.test.ts:88,100`. A sentinel pin *is* caught, but incidentally, by the later digest-equality comparison, and the printed error reads as "pushed image does not match the repo pin" rather than "you never pinned".
- **Why it matters:** The comment tells the next maintainer a guard exists at a location where it does not, which is how a guard gets deleted.

## [LOW] `assertImageRef`'s remediation suggests a reference its own regex rejects

- **AC / constraint violated:** AC3 — the image error must be actionable (it is the one error deliberately permitted to echo the value).
- **Verdict:** PARTIAL
- **File:** `src/providers/exedev/driver.ts:216` — `"pass a digest-pinned reference, e.g. ghcr.io/OWNER/IMAGE@sha256:<64 hex>"`
- **Evidence:** `IMAGE_REF_RE` (`:198-199`) admits path components matching `[a-z0-9]+(?:[._-][a-z0-9]+)*` only — no uppercase. An operator who follows the remediation literally, or who uses a mixed-case GitHub org name, is refused again by the same rule. (The refusal is correct for OCI; the guidance is not.)
- **Why it matters:** The one error whose message is allowed to be verbose points at an example that fails validation.

## [LOW] `IMAGE_MARKER_MAX_BYTES` comment states a marker size contradicted by the live measurement

- **AC / constraint violated:** none — documentation accuracy against the story's own evidence.
- **Verdict:** PARTIAL
- **File:** `src/providers/exedev/transport.ts` — "The marker is six short strings — the built image's is 154 bytes." (chunk-src.diff:566)
- **Evidence:** The live e2e round recorded in the Dev Agent Record measured the shipped marker at **238 bytes** ("Marker present and under cap | `/etc/qds-image.json`, **238 bytes** vs the 4096-byte gate cap"). 154 bytes appears to predate the marker gaining the full digest reference in `imageRef`.
- **Why it matters:** Trivial on its own, but the number is the stated justification for the 4 KiB cap, so a stale value quietly misstates the headroom.
