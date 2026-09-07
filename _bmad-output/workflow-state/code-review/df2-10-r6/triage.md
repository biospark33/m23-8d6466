# DF2.10 review round 6 — triage ledger

Scope: full DF2.10 story diff, base `7806bbe` → `origin/dev`, 56 code files, 17,652 diff lines.
Wave: 18 reviewers (8 blind, 9 edge, 1 acceptance auditor) over 14 chunks. ~180 raw findings.
Branch: `fix/df2.10-review-round-6`. Baseline gates clean (biome 305 files, tsc 0 errors).

Reports: `/tmp/df210-review/reports/*.md` — fixers read their own, findings are quoted verbatim there.

---

## DISMISSED — verified false against real source (do NOT patch, do NOT re-raise)

| id | finding | refutation |
|----|---------|------------|
| X1 | blind-buildscript-b [HIGH] `redactAssignments` misses an assignment preceded by `&`/`;`/`=` and prints the secret verbatim | The stated consequence is wrong. `SECRET_ENV` (`scripts/build-image.ts:83-84`) has the **identical** lead class `(^\|[\s\|"'])`. `cd /app&&NPM_TOKEN=abc` does not match the detector either, so no finding is ever pushed and nothing is printed. A detector gap, not a redaction leak. The **value-extent** half of the same area IS real — see P1. |
| X2 | blind-e2e-tier35 [LOW] `listedKeyHashes` newly called in T3.1/T3.2 but maybe not imported | Present: 4 occurrences in `tier3-race.live.test.ts`, 3 in `tier3-manystories.live.test.ts`. Reviewer flagged it as "probably fine, confirm" — confirmed. |
| X3 | blind-test-image-contract [LOW] the ratification accept-arms assert only `not.toThrow()` | Reviewer's own verdict: "none required if the function is `void`-returning". `assertRegistryAuthDeviation` is void-returning; the 15 refusal arms make the short-circuit implementation impossible. Defence-in-depth note, not a defect. |
| X4 | edge-driver-src [LOW] `IMAGE_REF_RE` admits an out-of-range port | Reviewer's own fix line: "not worth the regex; ignore unless a real operator hits it." No injection risk (charset clean); a worse error site only. |

### Carried forward from round 4 — must not be re-raised (story lines 968–1022)
`B10` tarUnescape surrogate advance · `D3a` redactSecrets non-string · `A14` split publish job to drop `packages: write` · `FP-1` useConst in tier3-remote-phases:73 · `A17` dependabot github-actions entry.
None of these were re-raised this round.

---

## DECISION-NEEDED → resolved conservatively (fail-safe), listed for ratification

| id | choice | resolution taken |
|----|--------|------------------|
| R1 | blind-oci-image [HIGH] pi install path: `chown`/`rm` target `.local/pi/`, `binary-licenses.json` `paths` names `.local/bin/pi`. Both cannot be right. | **Measure, do not guess.** Fixer resolves the real in-image ELF path from the Dockerfile's own install invocation and makes `chown`, `rm` and `paths` all name it. If unresolvable without a live image, WIDEN `paths` to cover both spellings (fail-closed: coverage gate keeps refusing an unattributed binary) and leave a `ponytail:` note. |
| R2 | D64 one digest scoped to a non-`image` exporter accepted as the pin | **Fail closed.** `flat` derives from the unscoped key only; a lone non-`image`-scoped digest gets its own pre-push `die(2)`. Refusing to publish beats publishing an unverified pin. |
| R3 | D9 attest job skipped ⇒ green run | **Fail closed.** Add a final `if: always()` job that reds the run when `published == 'true' && attest.result != 'success'`. Prefers a red run over a silently unsigned public image. |
| R4 | D38 account-wide `e2e-\|qds-` sweep vs run-scoped | **Report wide, act narrow.** Destroy verdict scopes to this run's names; other strays become a separate labelled warning that does not fail the run. Avoids both the false-red treadmill and silent leaks. |
| R5 | D56 `registerDriver("exedev", exeDevDriverFromEnv)` blocks teardown/reap on a half-set pin | **Cleanup must always be reachable.** Move the both-or-neither / auth-file gates onto the create path, not driver resolution. A stray env var must never strand a billing box. |
| R6 | D50 daily provenance re-check covers `main` only | **Cover `dev` too** — it is this repo's integration base and carries the working pin for days. Adds a scheduled job with `ref: dev`. |

---

## PATCH — by fix cluster

Severity counts: **2 BLOCKER · 24 HIGH · 51 MED · 47 LOW** (post-dedupe, post-dismiss).

### F1 — `scripts/build-exedev-image.ts` + its tests
Reports: `blind-buildscript-a`, `blind-buildscript-b`, `edge-buildscript-a`, `edge-buildscript-b`, `edge-test-build-script`
- **P1 [BLOCKER]** `redactAssignments`' `\S+` stops at the first whitespace — a secret with a space leaks its tail into the build log. Executed proof: `ENV NPM_TOKEN={"k": "sekrit"}` → `ENV NPM_TOKEN=<redacted> "sekrit"}`. Redact to end-of-line-or-next-`NAME=`.
- **P2 [BLOCKER→test]** the test that claims to close P1 asserts four hand-picked space-free strings and never imports `SECRET_ENV`. Drive the assertion off the detector; add a quoted space-bearing fixture.
- **P3 [HIGH]** binary/DER credential at a candidate path reads CLEAN (utf8 lossy decode → no regex fires). Fail-open in INV-IBOX-1. Read as Buffer; non-UTF-8/NUL is itself a finding.
- **P4 [HIGH]** `SOURCE_DATE_EPOCH` falls back to HEAD while `QDS_GIT_SHA` falls back to the image-source revision — the two digest inputs track different commits, so the pin gate cannot converge.
- **P5 [HIGH]** a digest positively scoped to the `docker` exporter is accepted as the pin on `--push` (R2).
- **P6 [HIGH]** `judgeCandidateDir`'s "could not read" fail-closed branch has zero coverage; the test named for it duplicates the recursion test.
- P7–P30 [MED/LOW] `absent` regex matches auth failures · FIFO/device hangs the gate forever · `QDS_GIT_SHA` set-but-empty → HEAD · concurrent runs collide on `qds-repro` + `DEFAULT_TAG` · `stillRunning()` heartbeats only `runDir`, not `treeDir`/scan/push · NOTICE survives a failed push · exit-code misclassification cluster (malformed licence entries exit 1; unswept node_modules exit 2; `maxBuffer` RangeError → exit 1; unguarded `finally` rmSync → exit 1) · vacuous NOTICE coverage gate · `builtDigest` null on every dry run · `deriveBuildId` omits platform · unframed label → executed collision · hand-enumerated buildId input set · `docker rmi -f ${opts.tag}` destroys an operator's local image and the comment misattributes the guard · CRLF defeats the continuation guard and the ARG regex · `includes("<<")` refuses any `<<` · out-of-repo `--summary`/`--evidence` deleted unconditionally · `canonicalOutputPath` case-fold keyed on `process.platform` (can delete `driver.ts`) + its test half never runs on CI · `dest=${archive}` unvalidated into the buildx CSV · directories-only listing reads as a clean scan · writability probe leaks directory trees · `-perm -u+x` false-negative class · Docker Hub ref normalisation · `nodeModulesRoot` trailing-slash miss · `assertCid` echoes 120 raw bytes · `ensureReproBuilder` bootstraps before rejecting · NFC/NFD "both spellings" overclaim · whitespace-padded `names` · `--keep-tree` deleted by the next sweep · `listExecutables` failure hint misdiagnoses · `metadataDigests` same-scope collision · `parseBaseRefs` case-sensitive dedup · `readBunPin` accepts `bun@1` · fixture: combined `test -f && cat` slips the drift alarm · fixture: `imageMarkerTruncated` overrides `imageMarkerCatExit` · fixture: `DEFAULT_IMAGE_MARKER` calls `readBunPin` at module load · `bunx` substring key · `BunPinError` one-of-four coverage · `parseArgs` "before any action" unpinned · `writeRatifiedRegistryDeviation` fixed `attestedAt`.

### F2 — `.github/workflows/publish-exedev-image.yml`
Reports: `blind-workflow-publish`, `edge-workflow-publish`
- **P31 [HIGH]** SLSA provenance attests `gitCommit: $GITHUB_SHA`, not the image source revision it was built at — signed, Rekor-logged, wrong commit.
- **P32 [HIGH]** the pin gate compares the digest substring only; `DEFAULT_IMAGE_REF` is never checked to point at `$IMAGE`. A pin naming a foreign registry passes.
- **P33 [HIGH]** a post-gate failure publishes a pinned image that never gets attested, and nothing re-enters; `verify-image-pin` then fails daily.
- **P34 [HIGH]** three `imagetools inspect` reads have no failure arm and no retry — a registry blip dies as a bare red on the step most likely to be misread as "the pin is wrong".
- **P35 [HIGH]** the environment branch policy / reviewer rule has zero automated verification, by admission (documented residual — harden what is in-file, land the audit note).
- P36–P48 [MED/LOW] prune never fires on push-then-exit-1, nor on cancel/timeout (`!= 'success'`) · prune exits 0 unconditionally and is untested against this package · digest-less dry run skips the buildId comparison it can make · attest skipped ⇒ green (R3) · visibility URL assumes an org-owned package · anonymous-pull check re-spells the tag, so 404 reads as "not public" · publish concurrency group still cancels a pending pin-adoption run · bare `jq -er` reads with no `::error::` · duplicate cosign attestations accumulate · `contents: read` unjustified on `attest` · stale "workflow-scoped concurrency" and "QEMU rebuild"/"eventually consistent GitHub store" rationales · `--signer-workflow` not ref-anchored · `RUNNER_ENVIRONMENT` unguarded under `set -u` · one `run:` missing `set -euo pipefail` · `docker login` before the build · sweep-summary artifact uploaded on `always()` · `driver.ts` in `on.push.paths` causes approval fatigue.

### F3 — `verify-image-pin.yml` + register + `.dockerignore` + SKILL.md + roster
Report: `edge-workflow-verify-misc`
- **P49 [HIGH]** on a PR the exception register is read from the BASE tree, so a new or malformed entry is never validated pre-merge — the landmine goes off after merge, on `dev`/`main`.
- **P50 [HIGH]** the remediation the gate prints is unreachable in a single PR: pin comes from the head, register from the base, so the documented bootstrap path is a dead end on first use.
- P51–P60 [MED/LOW] daily re-check covers `main` only, never `dev` (R6) · overlay step's promised `-e` guard is absent; a 200-with-no-`.content` writes 3 bytes over `driver.ts` and misdiagnoses · header claims the register carries the bootstrap entry, the committed register is `[]` · the verify path was proven against the pre-cosign producer and nothing re-proves it · `.dockerignore` credential patterns are non-recursive and `.sandbox` is unignored (three real `.env` files ship to the build context) · SKILL.md's round-exit checklist names exactly the wrong file set (`tier1-registry-auth` is the only uncovered file, and it is the one not named) · any-length `sha256:` accepted · duplicate guard counts lines not declarations · register unvalidated while the pin is the sentinel · a revert-to-sentinel PR passes green · `base-drift` guard bypassed when its own input is unreadable · vestigial single-element loop · `t4.resident.pipeline.json` sits 2 % under a hard admission ceiling (comment only).

### F4 — `oci/exedev/*` + `tests/providers/exedev/image-assets.test.ts`
Reports: `blind-oci-image`, `edge-test-assets-setupgate` (image-assets half)
- **P61 [HIGH]** the INV-IBOX-1 private-key removal is a gate that can never fail — `rm -rf` exits 0 on absent paths, the list is derived from a one-time scan, and the bump procedure never re-runs the credential scan. Assert each path existed.
- **P62 [HIGH]** pi install location contradicts itself across `chown`, `rm` and `binary-licenses.json` `paths` (R1).
- **P63 [HIGH]** the AC6 test's regex does not pin `(Default)?`, so narrowing the Dockerfile scan back to `Environment=` — re-opening the manager-wide `DefaultEnvironment=` hole the test replaced — stays green. Executed proof.
- P64–P80 [MED/LOW] `systemd-analyze verify` swallows its diagnostic in exactly the failing case · `TimeoutStartSec=60` inert on `Type=simple` · `command -v bun` asserts the builder PATH, not the ssh PATH · AC6 scan omits sshd `SetEnv` / `sshd_config.d/` / `~/.ssh/environment` · `rm -rf .../pi/node_modules` silent no-op · `BUN_SHA256` overridable by `--build-arg` · no sandboxing directives at all on the unit that runs agent-authored code · AC6 greps cannot distinguish clean from read-nothing (`grep` exit 2) · `PassEnvironment=` unmatched · "empty output = clean" has no positive control · `[ -n "$pi_sha256" ]` near-vacuous · "nothing goes below this line" is a comment, not a gate · unloadable unit gives an unnamed error · `%i` charset unconstrained · missing `WorkingDirectory=`; `Requires=` also pulls in the oneshot · `curl` lacks `--proto`/`--max-time` · OCI labels omit `revision`/`version` · `\|\| true` masks a `sed` failure on the flagship AC6 assertion · two `.d/` siblings shadow their parents in `toContain` · the AC6 test asserts the grep's text, never that a hit fails the build · `Restart=` empty-reset mutation row missing · `directive-set` order sensitivity undocumented · asset-inventory glob buried at the tail of another test.

### F5a — `src/providers/exedev/{driver,transport}.ts` + `image-contract` / `read-box-file` tests
Reports: `blind-driver-src`, `edge-driver-src`, `blind-test-image-contract`
- **P81 [HIGH]** `parseImageMarker` interpolates the raw V8 `JSON.parse` SyntaxError — which quotes box-controlled bytes — into a logged gate note and the evidence artifact. Newlines/ANSI forge log lines from the machine the gate just decided not to trust. Every sibling path in the same file scrubs.
- **P82 [HIGH]** the file-loaded credential is never proven to reach the driver or argv: the only happy-path assertion is `not.toThrow()`. An implementation that reads the file and discards the value passes the whole suite.
- **P83 [HIGH]** `DEFAULT_IMAGE_BUILD_ID` has no "still a placeholder" merge gate, though gate B keys on it, not on `DEFAULT_IMAGE_REF`.
- P84–P100 [MED/LOW] `result.error` attached without checking `markerError` belongs to `firstFail` · `create()`'s rejection path cannot distinguish "no box" from "a box may be live" · every factory/constructor refusal emits zero observability · `image_override` emitted per resolution with `runId: null` and an orphan requestId · the auth file is re-read on every resolve; a mid-fleet rotation is an unattributed hard failure · `redactRegistryAuth` guards a zero-length secret but not a one-character one · `--image` unconditional makes an unpullable digest a fleet-wide create failure routed into the never-destroy path · `stat.size` is 0 for procfs, bypassing the pre-read ceiling · empty credential file refuses with the wrong reason · marker gate over-claims "PROVES" (drift, not tamper) · `IMAGE_MARKER_MAX_BYTES` enforced after the whole read · `readBoxFile` silently degrades when `execTimed` is absent · `isUnpinnedImage` uses `endsWith` and is never consulted on the runtime path · date-only expiry lapses at UTC midnight · `redactRegistryAuth` never scrubs the username · duplicate exit-status constants in two modules · credential loaded before the ratification gate can refuse it · `left()`'s 1 ms floor blames the box for the caller's budget · `truncated` from stderr condemns a fanout arm permanently · `EVERY_ASSERTION_ITEM` key comparison cannot fail · `marker.buildId` same-source comparison · missing distinctness guards on two mismatch tests · un-anchored `boxCmds` spend claims · `isUnpinnedImage()` default-arg assertion strictly weaker than the line below · near-vacuous `remediation.length` · raw control character in a source literal · `newArgv` returns the first create · `refusal()` accepts an async thunk · cleanup skipped on one failure path · tenant test runs `setup()` twice against one box · zero-margin timing assertion · `expect(call.timeoutMs).toBeGreaterThan(0)` cannot fail.

### F5b — `setup-gate.ts` + `assertions-in-box.sh` + `setup-gate.test.ts`
Reports: `blind-driver-src` (gate half), `blind-oci-image` (script half), `edge-test-assets-setupgate` (setup-gate half)
- **P101 [HIGH]** `ready` is computed from "no failed row", never from "every row ran" — `notRun` is recorded and then ignored, so a gate can report a box READY while the paid live pings never ran. Fail closed: `ready = firstFail === undefined && notRun.length === 0`.
- **P102 [MED]** the pi-version fallback re-introduces the banner failure the exact-line match was added to prevent: `A new version 0.99.0 is available\npi 0.84.4` yields `0.99`, refusing **every box in the fleet**. Anchor the fallback to the version line.
- P103–P112 [MED/LOW] the fallback has zero test coverage (deleting it breaks only real `pi X.Y.Z` runtimes) · the D-pre refusal is scoped to the absent-registry arm and no test covers present-registry + unreviewed series · three fail-closed arms of the script are asserted by nobody · the `timeout` fallback reintroduces the stall the block exists to prevent · `PI_REVIEWED_SERIES` is a third hand-maintained copy with no binding test · a D-pre refusal emits `D` before `C` emits anything · happy path never asserts `notRun` is absent · `boot_ready_ms >= gate_a_ms` is a tautology · `preCdeMs` passes vacuously ahead of the assertion that would name the fault · pi shims rot on a prerelease `PI_VERSION` · `writeShimRoster` leaves `f11-roster.yaml` behind · stale budget comment after the one-budget-for-the-pair change.

### F6 — `src/fleet/fanout-primitive.ts` + `credentials.ts` + `index.ts` + their tests
Report: `edge-fleet-src`
- **P113 [HIGH]** a ~30 s host-side transport blip abandons EVERY arm of the fan-out and leaks all N boxes. The skip streak is per-arm but the fault is fleet-wide; a fast-failing `Connection refused` makes six ticks ~25–30 s, not the ~90 s the doc claims.
- **P114 [HIGH]** `registerDriver("exedev", () => exeDevDriverFromEnv())` moves the pin/auth gates onto every driver resolution, so a half-set env pin blocks **teardown and reap** — an operator cannot clean up boxes they already have, and `asUsage` flattens it to "never retry" (R5).
- P115–P124 [MED/LOW] `probeArm`'s catch-all can discard a WON arm (a `store.mutate` throw after the marker read) · `unreadable` counted as `probe-unanswered` for a box that answered twice · the charset guard runs after `revokeAndVerify` interpolates the provider hash into shell remediation · the failed-compensation branch (the one that leaves a live unreachable key) has no test · `readBunPin` accepts `bun@1` / `bun@1.3` · the registry PAT is read on every resolve and the module header's "no env secret is read" is now false · the second `store.set` is outside the compensation · the error arm drops `mint_compensation_ms`/`compensated` · `PROBE_SKIP_TICKS_LIMIT` documented as a time bound it is not · no pairing between `ARG BUN_SHA256` and its version.

### F7 — `tests/fleet/e2e/live-harness.ts` + `live-harness.test.ts`  *(Wave 1 — tier tests depend on it)*
Reports: `blind-e2e-harness`, `edge-e2e-t1b-t2`, `blind-e2e-tier35`
- **P125 [HIGH]** the F16 `effectiveImage` stamp is module state set only in `preflight()`, so a live test that builds its own driver inherits another file's image and stamps a false provenance — the artifact silently changes meaning with invocation order.
- **P126 [HIGH]** cleanup problems reach the thrown error and the console **unscrubbed**, while every sibling path in the same function scrubs. A `fleet teardown` dying while echoing a PAT puts 200 raw chars into a CI log.
- **P127 [HIGH]** add a bounded-retry `fleetLeftovers(driver)` helper — the measured 25 s+ destroy lag makes every single-shot `final-ls` a false leak verdict (consumed by F8/F9/F10 in wave 2).
- P128–P133 [MED/LOW] a payload key named `image` silently overwrites the provenance stamp (spread order) · nothing destroys a stray the backstop finds · evidence-write failures laundered through `destroyFailures` · a non-Error body failure drops every cleanup problem to stderr · `settleRun` mutates the caught error in place · `keyLeakProblems` claims a fallback revoke was attempted when it was not · `live-harness.test.ts` spawns real subprocesses and dirties the evidence dir from the fast suite.

### F8 / F9 / F10 — tier-1 / tier-2 / tier-3–5 live tests  *(Wave 2 — after F7 lands)*
Reports: `blind-e2e-harness`, `edge-e2e-t1b-t2`, `blind-e2e-tier35`
- **P134 [HIGH]** T2.2 (`2_400_000`) and T2.1 (`1_800_000`) file budgets are **below the sum of their own inner ceilings** (3060 s and 1800 s). The bun timeout abort skips the whole `finally` — every arm box and minted key leaks. Verified against source.
- **P135 [HIGH]** twelve single-shot `final-ls` sites vs a measured 25 s+ lag → false leak on a clean paid round (use F7's helper).
- **P136 [HIGH]** T1.5 has no cleanup-time box check at all — and a fanout that wrongly provisions is exactly what it tests for.
- **P137 [HIGH]** T3.4a's `finally` wraps the whole per-run loop, so one bad record skips teardown for every remaining run.
- **P138 [HIGH]** `keyLeakProblems` is an unguarded `await` in all seven tier-3–5 `finally` blocks, ahead of the evidence write.
- **P139 [HIGH]** the ghcr pre-flight `fetch`es in `tier1-registry-auth` have no timeout and eat the same 900 s budget the two box legs need — expiry strands two real boxes.
- **P140 [HIGH]** `expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF)` cannot fail, and its comment claims the opposite.
- P141–P155 [MED/LOW] T3.3 builds a `RunRecordStore` without the `workspace !== ""` guard, so a failed `tmpWorkspace` revokes **unrelated runs' keys** · `store.get(vm)` not awaited · T5.1 dropped the `try/catch` around `revokeQuietly` and its asserted verdict · T5 tamper guard's porcelain prefix whitelist misses `MM`/`AM`/`R `/`" D"`/`UU` · T4's per-leg budget tripled against an unchanged `2_400_000` timeout · unguarded `new RunRecordStore` in two tier-2 `finally` blocks · the account-wide backstop fails every test in a round after one stray (R4) · nothing destroys what the backstop finds · `hashesBefore` is account-wide · T1.7/D8 fail on any `e2e-`/`qds-` box · the negative control can be defeated by a digest-level image cache · the 300 s create budget applied to every exec · `Number("")` passes the marker-bytes check · a `store.create` throw becomes a phantom key leak · T1.8 double-reports its own box · seven tests removed `throw e` and depend entirely on `settleRun` (pin it with a unit test) · `rmSync` is the last unguarded statement of each `finally` · T3.4a reads the run record after tearing it down · `finally-revoke ok:false` folded into the verdict only in T5.1 · T5.1's org-rename comment contradicts itself.

### F11 — story record  *(Wave 3)*
Report: `auditor-df210`. **All 7 ACs implemented** — every finding is a truthfulness/staleness defect in the Dev Agent Record, which is what DF1.10 inherits.
- **P156 [HIGH]** the Status line and three separate "the workflow has never executed / the image was pushed by hand" claims are false — the branch is merged and the current pin was CI-published.
- **P157 [HIGH]** "The pin that shipped" names a **retired** pin (`a70674b2…`/`664876fb…`); the runs proving the current pin (`92447929…`/`3cf094fb…`) appear nowhere.
- **P158 [HIGH]** "What a human must do" items 3 and 4 are discharged but still written as open (the exception register is `[]`; both live legs passed on the new pin).
- P159–P165 [MED/LOW] "Signed provenance" still describes `actions/attest-build-provenance` and a two-store verification the code does not have · two build-script docblocks credit the same retired action · the fork-guard comment asserts a user-owned package the same PR refuted · the `environment:` comment claims a required-reviewer rule measured unobtainable and deliberately dropped · issue #186's list still defers items round 4 landed · the marker is a seven-key document, the story specifies six · the workflow header says pruning is "not something this workflow does" next to the prune step · A2's ref-anchor landed on the consumer only · round 4's "not yet copied into `_bmad-output/`" caveat is stale.

---

## Deferred — real, out of this round's scope

- **DF1.10 inherits:** `NoNewPrivileges`/`PrivateTmp` on `qds-run@.service` are patched here, but the unit's `ExecStart` and the runId charset contract belong to DF1.10.
- **A13 residual:** the three pre-existing untagged package versions remain a manual registry chore (unchanged from round 4).
- **Environment branch-policy drift audit** (issue tracked): still not detectable from CI; P35 hardens what is in-file only.
