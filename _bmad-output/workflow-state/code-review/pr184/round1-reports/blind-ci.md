# Blind adversarial review — `chunk-ci.diff`

All line numbers are **diff-relative** (position in `/tmp/pr184-review/chunk-ci.diff`).

---

## [HIGH] The publish job runs three tag-pinned third-party/first-party actions while holding `packages: write` and a live ghcr credential
- **File:** `.github/workflows/publish-exedev-image.yml:200, :214, :509` (diff lines 200, 214, 509)
- **Trigger:** `actions/checkout@v7`, `oven-sh/setup-bun@v2`, `actions/upload-artifact@v4` are mutable refs. Anyone who can move one of those tags (upstream account compromise, or in `oven-sh`'s case a third party entirely) gets arbitrary code execution inside the `publish` job. That job holds `packages: write`, and by the time the build step runs, `~/.docker/config.json` contains a ghcr token that can push to the public package the whole design depends on.
- **Why it matters:** The workflow's own `attest` job argues at length (diff 593–598) that a hijacked mutable tag in a privileged job is unacceptable — and then applies that reasoning to exactly one step. The `publish` job cannot mint an OIDC token, but it *can* publish arbitrary bytes under `ghcr.io/biospark33/qds-exedev`, which is the artifact every customer mirrors. Note also that the story record (diff 865) dismisses zizmor's 4 `unpinned-uses` findings as "all pre-existing policy drift"; three of the four are in a **new** file created by this diff, so "pre-existing" is not a true characterisation of them.

## [HIGH] Any merge that carries the image tree forward moves `src_sha`, so the gate goes red — and the image is published anyway — on every merge and every promote
- **File:** `.github/workflows/publish-exedev-image.yml:134-145` and `:242-268`
- **Trigger:** `on.push.branches: [main, dev]` + `paths: oci/exedev/**`. A squash-merge (or any merge commit) that lands `oci/exedev/**` on `dev` *is itself a new commit touching those paths*, so `git log -1 -- oci/exedev scripts/build-exedev-image.ts` resolves to the squash commit, not the branch commit the pin was computed at. New `src_sha` + new `%ct` epoch → new `gitSha`/`imageRef` in `/etc/qds-image.json` → new digest → the gate at :390 fails. The same thing happens again on the `dev → main` promote.
- **Why it matters:** The convergence argument (diff 219–241) only holds for a *driver.ts-only* commit. It does not hold for the merge commit that carries the image tree between branches — which is the normal path for every change to this image. Each such merge produces a red required-looking job plus a stray published image at an unpinned tag, and needs a fresh manual pin commit + re-dispatch to clear. `%ct` also means a rebase with an unchanged tree changes the digest.

## [HIGH] The push happens before the gate, so the gate cannot refuse a publish — only report one
- **File:** `.github/workflows/publish-exedev-image.yml:344-358` (push) vs `:390` (gate)
- **Trigger:** Any run where the built digest ≠ the repo pin: dependabot base bump, a merge commit (above), an unrelated `oci/exedev` edit, a `workflow_dispatch` from a feature branch.
- **Why it matters:** The header comment claims "A publish that moves the digest without moving the pin means production boots an image no review saw — **the gate step refuses it**" (diff 110–112). It refuses nothing; `--push` already happened, and the gate's own error text admits "The image IS published at the actual digest above" (diff 459). Unreviewed bytes reach the public package on every failing run. The digest pin protects production, but the *package* accumulates unreviewed, publicly-pullable, unsigned images under predictable `sha-<sha>` tags (the `attest` job is skipped when `publish` fails, so these are never signed).

## [MEDIUM] The workflow file is itself a digest input (via the tag string) but is excluded from both `SOURCE_PATHS` and `on.push.paths`
- **File:** `.github/workflows/publish-exedev-image.yml:144-145`, `:163-164`, `:247`, `:263`
- **Trigger:** Editing `IMAGE` (or the `tag=` expression) in this workflow.
- **Why it matters:** The story record states outright that the tag reaches the baked marker and changes the digest — "the identical tree built under a different tag yields `sha256:1ccee04d…`, differing *only* because the tag string reaches the marker" (diff 809). So `IMAGE` and the tag template are build inputs of the same standing as the Dockerfile. Changing them on `main` publishes nothing (no path match) and, when a later run does fire, produces a digest nobody expected. This is precisely the "a change that should publish does not" hazard the lockstep comment at :138-142 names, applied to the file that comment lives in.

## [MEDIUM] Dependabot cannot bump a digest-only `FROM` — the new entry is likely a no-op, and it is described as the load-bearing early-warning signal
- **File:** `.github/dependabot.yml:87-90` (rationale at :73-86)
- **Trigger:** The base is pinned as `ghcr.io/boldsoftware/exeuntu@sha256:4398215003cf…` with no tag (story record, diff 727). Dependabot's docker updater only updates a digest when a **tag is also present** in the `FROM` — it has no other way to know which stream to follow. A bare `@sha256:` pin gets no PRs.
- **Why it matters:** The comment asserts this entry is "the INTENDED early-warning signal" for upstream's weekly no-cache rebuild, and that it "is what makes 'our image is pinned' mean something more than 'we wrote a sha down once'." If the updater is silent, the base pin ages indefinitely with nothing watching it, and the failure mode is invisible (no PR is indistinguishable from no upstream change). The diff does not include `oci/exedev/Dockerfile`, so this cannot be confirmed from the diff — which is itself the problem: a config whose correctness depends on a file the change does not show.

## [MEDIUM] The pin-read step dies under `set -euo pipefail` before it can print the diagnostic it exists to print
- **File:** `.github/workflows/publish-exedev-image.yml:287-302`
- **Trigger:** `DEFAULT_IMAGE_REF` or `DEFAULT_IMAGE_BUILD_ID` renamed or removed; or `$DRIVER` renamed/moved.
- **Why it matters:** `ref=$(printf … | grep -oE … | head -1 | sed …)` — a non-matching `grep` exits 1, `pipefail` propagates it, and `set -e` kills the step at the assignment. The `if [ -z "$ref" ]` block below — including the message the comment calls out as the whole point ("If these were renamed, this gate stopped gating — fix the grep, do not delete it") — is unreachable for the exact case it was written for. Same for `tr '\n' ' ' < "$DRIVER"` if the file moved. The gate still fails closed, but it fails as an opaque shell error, which is the failure mode the step's author explicitly tried to prevent (diff 219–241 documents that a previous version of this gate failed on every run "for a reason that reads as 'the pin is wrong'"). `head -1` on a multi-match grep can also raise SIGPIPE and trip `pipefail` on a *successful* read.

## [MEDIUM] "The attestation steps have never executed" is justified by a claim the source-revision fix in this same diff invalidates
- **File:** `_bmad-output/…/df2-10-factory-owned-boot-image.md:802` (and the stale premise at :809)
- **Trigger:** Reading the two sections against each other.
- **Why it matters:** :802 says the signing path is unverified because "its pin gate is satisfiable only when rebuilding *at the pinned revision* … so a dispatch on any newer commit fails the gate **before** reaching the attestation steps." But the workflow now builds at `src_sha`, not HEAD — that is the entire point of the "Resolve the image source revision" step. A dispatch at any newer commit that does not touch `oci/exedev`/`scripts/build-exedev-image.ts` rebuilds byte-identical bytes and *passes*, so the attestation steps would run. Either the convergence fix works and the stated reason for not exercising the signing path is false, or the fix does not work and the gate's central claim is false. One of the two load-bearing claims in this PR is wrong, and the record does not say which.

## [MEDIUM] `workflow_dispatch` from any branch publishes to the public production package, with no environment or approval
- **File:** `.github/workflows/publish-exedev-image.yml:130`, `:189-191`
- **Trigger:** Any actor with write access dispatches the workflow from a branch containing an arbitrary `oci/exedev/Dockerfile`.
- **Why it matters:** The build runs on a branch-controlled Dockerfile and `scripts/build-exedev-image.ts` (branch-controlled code, executed as `bun scripts/…`), then pushes to `ghcr.io/biospark33/qds-exedev` — a package the design states customers mirror. The gate fires after the push (see above), so it does not prevent this. There is no `environment:` with required reviewers on the publish job, which is the one mechanism that would gate the registry write itself rather than the pin adoption.

## [MEDIUM] The skill's roster instructions contradict themselves on which mechanism actually opens the roster file
- **File:** `.claude/skills/qds-live-e2e/SKILL.md:9-10`, `:16-32`
- **Trigger:** An operator sets `QDS_EXEDEV_ROSTER` to any path other than `dirname(manifestPath)/roster.yaml`.
- **Why it matters:** The text says the roster is "the file the setup gate reads BESIDE the dispatch manifest (`dispatch.ts`: `dirname(manifestPath)/roster.yaml`)" — i.e. resolved by proximity to the manifest, not by the env var — and in the same paragraph says "a bogus roster path sails through `liveGate()` and dies at setup, after a box may already exist." Both cannot be true: if the setup gate resolves the path from the manifest directory, a bogus `QDS_EXEDEV_ROSTER` cannot be what dies at setup (it would be ignored, and a *correct-looking* env var would silently have no effect). The recipe at :9-10 tells operators to export the variable, so whichever reading is right, one of the two is teaching the wrong mental model for the failure that "may already have created a box".

## [LOW] The `attest` job's stated race cannot happen for the reason given
- **File:** `.github/workflows/publish-exedev-image.yml:552-557` (vs `:151-153`)
- **Trigger:** n/a — the reasoning, not the code.
- **Why it matters:** "`cancel-in-progress: false` means a queued second publish can land between the two [jobs]" is false: the concurrency group is workflow-scoped, so a queued run does not start until the entire first run (both jobs) finishes. The revalidation step is still worth having (a manual push, which the comment also names, is real), but the primary justification given for it is wrong — and it's the justification a future maintainer would weigh when deciding whether the step can be deleted.

## [LOW] The stated reason for excluding `package.json` from `SOURCE_PATHS` rests on a false claim about `buildId`
- **File:** `.github/workflows/publish-exedev-image.yml:236-241`
- **Trigger:** A bun version bump in `package.json`.
- **Why it matters:** The comment says "A bun-pin bump is still caught, one field over — it moves the buildId, which the gate compares independently of the digest." Per the story record (diff 726), `buildId` is `sha256(base digest ‖ BUN_VERSION ‖ PI_VERSION ‖ Dockerfile ‖ both unit files)` — `BUN_VERSION` is a Dockerfile input, living in `oci/exedev` and already covered. `package.json`'s bun pin is the *runner's* bun, and the workflow hardcodes `bun-version: 1.3.13` at :215 rather than reading it from `package.json` at all. So the claimed safety net does not exist, and the workflow's runner-bun pin can drift from `packageManager` with nothing detecting it — which the comment at :211-213 asks a human to prevent by hand.

## [LOW] `IMAGE` and `IMAGE_PATH` are the same identifier written twice
- **File:** `.github/workflows/publish-exedev-image.yml:163-164`, used at `:487`, `:491`
- **Trigger:** Editing one and not the other.
- **Why it matters:** The anonymous-pull assertion queries `IMAGE_PATH` while everything else pushes/reads `IMAGE`. Diverge them and the check interrogates a different package than the one published — a 404/403 reads as "not public" (misleading but safe), and if the other path happens to exist and be public, the check passes while proving nothing. `IMAGE_PATH` is derivable as `${IMAGE#ghcr.io/}`.

## [LOW] `BUILD_DIR` is parameterised for the build step and hardcoded for the artifact upload
- **File:** `.github/workflows/publish-exedev-image.yml:166` vs `:512`
- **Trigger:** Changing `BUILD_DIR`.
- **Why it matters:** The upload silently collects nothing (`if-no-files-found: warn`, so no failure) and the sweep summary / evidence for failed runs — the runs the `if: always()` exists for — quietly stop being captured.

## [LOW] A network failure in the anonymous-pull check is reported as "the package is not public"
- **File:** `.github/workflows/publish-exedev-image.yml:488-500`
- **Trigger:** DNS/TLS/transient failure on the manifest request; `curl -s` without `--fail` yields `code=000`.
- **Why it matters:** The step then prints a confident, specific, wrong remediation (go flip package visibility in the UI) for what is a retryable network blip. The token fetch immediately above uses `curl -fsSL` inside a command substitution, so a failure there kills the step under `set -e` with no message at all.

## [LOW] The public-visibility assertion is unreachable on exactly the run that needs it
- **File:** `.github/workflows/publish-exedev-image.yml:480` (after the gate at `:390`)
- **Trigger:** The documented bootstrap ritual — first publish, gate fails by design (diff 119–122).
- **Why it matters:** GHCR creates the package private on first push, and the first push is guaranteed to fail the gate, so the visibility check never runs on the one run where the package is definitely private. The operator learns about it a full pin-commit-and-re-dispatch cycle later. Nothing about the check depends on the gate passing.

## [LOW] Nothing on the consuming side verifies the attestation this workflow spends a whole job producing
- **File:** `.github/workflows/publish-exedev-image.yml:515-707`
- **Trigger:** Production boot.
- **Why it matters:** Per the diff's own description, production passes `--image <ref>` and nothing else; the digest pin is the only control. The signature is verified once, in the job that created it, and then never again by any consumer shown here. That is a reasonable place to *start*, but "signed provenance" currently buys detection of nothing that the digest pin does not already buy — worth stating in the record rather than leaving the reader to infer a verification step that does not exist.

## [LOW] The SHA pin on `attest-build-provenance` depends on a dependabot `github-actions` entry the diff does not show
- **File:** `.github/dependabot.yml` (hunk starts at line 35; earlier entries not in the diff) vs `.github/workflows/publish-exedev-image.yml:597-598`
- **Trigger:** No `package-ecosystem: github-actions` entry existing.
- **Why it matters:** The comment justifies the SHA pin partly with "Dependabot's github-actions entry maintains SHA pins the same way it maintains tags, so the pin does not go stale silently." If that entry does not exist, the one SHA-pinned action in the repo is also the one action that will never be updated — and a stale pin on the only job holding `id-token: write` is exactly the thing that would matter.

## [LOW] The skill's copy-paste env block omits a variable the same file says `liveGate()` requires
- **File:** `.claude/skills/qds-live-e2e/SKILL.md:5-12` vs `:26-28`
- **Trigger:** Following the setup block verbatim in a clean shell.
- **Why it matters:** The new prose states `liveGate()` throws unless `OPENROUTER_PROVISIONING_KEY` is non-empty; the exports block lists five variables and not that one. (The hunk begins mid-block at line 37 of the original file, so it may be exported above the visible context — but as presented, the recipe produces the "half-configured env makes `liveGate()` THROW" outcome the very next bullet warns about.)

## [LOW] Two files were added to the tier-1 row with no stated verification of their `liveGate()` argument
- **File:** `.claude/skills/qds-live-e2e/SKILL.md:41`
- **Trigger:** Trusting the table's "boxes only, 0 model spend" for `tier1-approval-gate` / `tier1-attach-transport`.
- **Why it matters:** The same diff adds a section arguing that "**The filename prefix is not the gate — read the call, not the name**" and documents two files whose prefix lies. The two new tier-1 entries were added by prefix, and the record says nothing about having grepped them. If either calls `liveGate("2")`, the table makes the same false zero-spend claim the new section was written to prevent.

## [LOW] The sprint-status comment still asserts the premise the story disproved
- **File:** `_bmad-output/sprint-artifacts/sprint-status.yaml:876`
- **Trigger:** Reading the status line for DF2.10.
- **Why it matters:** Only `status:` changed (`ready-for-dev` → `in-review`); the trailing comment still reads "digest acceptance is UNVERIFIED today, so AC1's fallback is an immutable tag". The Dev Agent Record in the same PR records AC1(a) as MEASURED-TRUE with a booted box. This file is the index other stories read for dependency context (DF1.10 inherits the pin ritual from here), so the stale premise is the one a downstream planner would pick up.
