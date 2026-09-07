# Edge-case hunt — PR #184, CI chunk

Scope: `.github/workflows/publish-exedev-image.yml`, `.github/dependabot.yml`,
`.claude/skills/qds-live-e2e/SKILL.md`, `_bmad-output/sprint-artifacts/sprint-status.yaml`,
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md`.

Only unhandled paths are listed. Paths the code already covers (the `if: failure()` fan-in
on `login`/`publish` when an *earlier* step failed, the `set -e` trap the verify loop's
`if` spelling avoids, `pipefail` on the token curl, the blank-output guard in
`Revalidate the published digest`, the `sha256:` shape checks on both digest reads,
the `--signer-workflow`/`--predicate-type`/`--deny-self-hosted-runners`/`--bundle-from-oci`
flags — all four confirmed present in the locally installed `gh` 2.93.0 — the pin grep's
immunity to the `isUnpinnedImage(ref: string = DEFAULT_IMAGE_REF)` default at
`src/providers/exedev/driver.ts:194`, and the SKILL.md roster/`liveGate`/tier claims)
are omitted.

---

## [HIGH] The NOTICE is never uploaded — the artifact step collects a directory the build script does not write to

- **File:** `.github/workflows/publish-exedev-image.yml:70` (`BUILD_DIR: oci/exedev/.build`),
  `:409-417` (the upload step and its comment), `:256-262` (the `mkdir -p` + flags)
  vs `scripts/build-exedev-image.ts:119` (`const BUILD_DIR = path.join(REPO_ROOT, "oci/.build/exedev")`)
  and `:120` (`const NOTICE_PATH = path.join(BUILD_DIR, "NOTICE")`).
- **Trigger:** every run, success or failure.
- **Why it matters:** the workflow's build dir is `oci/exedev/.build`; the script's is
  `oci/.build/exedev`. The two JSONs land in the workflow's dir only because they are
  passed as explicit `--summary`/`--evidence` paths (the script `path.resolve`s them,
  `scripts/build-exedev-image.ts:872-873`). Everything the script writes to *its own*
  `BUILD_DIR` — the NOTICE (`:1083`), `build-metadata.json`, `exedev.docker.tar` — lands
  in `oci/.build/exedev/` and is never collected. The step is named "Upload sweep summary,
  NOTICE and evidence" and its comment states the reason for uploading a whole directory
  is precisely that "The NOTICE has no CLI flag of its own" — so the one artifact the
  directory-wide collection exists to capture is the one it misses, silently, under
  `if-no-files-found: warn`. DF2.9's license-attribution artifact for the boot image is
  therefore never published from CI.
  Note for whoever fixes it: repointing the upload at `oci/.build/exedev/` would also
  sweep up a ~1.6 GB `exedev.docker.tar` on any run that fails between the build and the
  `docker load` at `scripts/build-exedev-image.ts:1034` (the `rmSync` that removes it is
  at `:1038`, after the load). Name the NOTICE explicitly instead.
- **Verified:** read both `BUILD_DIR` definitions and `NOTICE_PATH`; confirmed the script
  writes the NOTICE unconditionally on the clean path (`:1076-1083`, the "recorded negative
  evidence for AC5" branch) and that only `--summary`/`--evidence` are redirectable.

---

## [HIGH] `scripts/build-exedev-image.ts` cannot reach the image bytes but is a digest input — the pin is already invalid on this branch

- **File:** `.github/workflows/publish-exedev-image.yml:49` and `:151` (`SOURCE_PATHS=(oci/exedev scripts/build-exedev-image.ts)`)
  vs `.dockerignore:18` (`scripts`).
- **Trigger:** any edit to `scripts/build-exedev-image.ts`, including a comment-only one.
- **Why it matters:** `.dockerignore` excludes `scripts` from the build context (the
  context is `REPO_ROOT`, `scripts/build-exedev-image.ts:993`), and the only two `COPY`s in
  `oci/exedev/Dockerfile` (`:200-201`) read `oci/exedev/systemd/`. So the builder's bytes
  can never reach the image. Its *only* effect on the digest is self-inflicted: being in
  `SOURCE_PATHS` moves `source_sha` and `source_epoch`, both of which are baked into
  `/etc/qds-image.json` (`ARG QDS_GIT_SHA`, `QDS_BUILT_AT`, `oci/exedev/Dockerfile:259-262`)
  and therefore into the digest. Every touch of the builder — including a docs pass —
  invalidates the published pin and forces a full rebuild, re-publish and re-pin.
  This has already fired on this PR. On `feature/df2.10`,
  `git log -1 --format='%H %ct' -- oci/exedev scripts/build-exedev-image.ts` returns
  `41cb8dd0f937f205944fea9a88ccb30ea65667fa` / epoch `1788281611`, while the pin recorded
  at `src/providers/exedev/driver.ts:246-247` (`sha256:a70674b2…`) was built at `7806bbee`
  / epoch `1788226040` (the story's own figures). So the first dispatch of this workflow
  pushes a public tag `sha-41cb8dd0…` at a digest nothing pins, then fails the gate. The
  story's "What is NOT verified" acknowledges *that* the gate fails on a newer commit; it
  does not acknowledge that a file which cannot change the image is what made the commit
  newer.
- **Verified:** ran the `SOURCE_PATHS` `git log` verbatim on the branch; grepped
  `.dockerignore` for `scripts`; grepped all `COPY`/`ADD` lines in `oci/exedev/Dockerfile`;
  read the context argument in the build script.

---

## [MEDIUM] `package.json` is a digest input outside both lockstep lists — a bun bump changes the image with no trigger and a marker that names the wrong revision

- **File:** `.github/workflows/publish-exedev-image.yml:44-49` (`on.push.paths`) and
  `:151` (`SOURCE_PATHS`); the input is `scripts/build-exedev-image.ts:500`
  (`bunVersion: readBunPin(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"))`),
  feeding `deriveBuildId` at `:349-360` and `--build-arg QDS_BUILD_ID` at `:969`.
- **Trigger:** dependabot's weekly npm PR bumping `packageManager` in `package.json`
  (the `/` npm entry, `.github/dependabot.yml:16-25`), or any manual bun-pin bump.
- **Why it matters:** the workflow's own comment at `:135-142` argues package.json is
  deliberately excluded and that "A bun-pin bump is still caught, one field over — it moves
  the buildId, which the gate compares independently of the digest." The gate does compare
  it — but nothing *runs* the gate: a package.json-only change matches neither
  `on.push.paths` nor any other trigger. Until someone dispatches manually, the divergence
  is invisible. Worse, the workflow builds the HEAD **working tree** while stamping a
  *different* revision's sha and epoch into the marker, so after a bun bump the published
  image's `/etc/qds-image.json` claims `gitSha = <old source revision>` for bytes that
  revision's tree would not produce. That breaks the exact property the story sells
  ("anyone can rebuild commit X and get digest D"), and it is the one input that can
  diverge — every other digest input (Dockerfile, systemd units, base digest, `PI_VERSION`
  const) lives inside `SOURCE_PATHS` and so is identical at HEAD and at `source_sha`.
- **Verified:** read `readBunPin` (`:444-467`) and `gatherBuildIdInputs` (`:470-511`);
  confirmed `PI_VERSION` is a const in the script (`:152`) and the base digest is in the
  Dockerfile (`:51`), i.e. both covered by `SOURCE_PATHS`.

---

## [MEDIUM] The new dependabot docker entry is a no-op: the exeuntu base is digest-only, with no tag

- **File:** `.github/dependabot.yml:87-90` (the added `/oci/exedev` entry) vs
  `oci/exedev/Dockerfile:51` — `FROM ghcr.io/boldsoftware/exeuntu@sha256:4398215003cf…`,
  no tag.
- **Trigger:** upstream's weekly no-cache rebuild moving the exeuntu digest — the exact
  event the entry's comment says it exists to surface.
- **Why it matters:** Dependabot's docker updater derives the dependency version from the
  tag and falls back to the digest only as a version *string*; a reference with a digest
  and no tag gives it nothing resolvable to compare against, so no update PR is opened.
  The contrast is inside this repo: the sibling `/oci` entry works because
  `oci/Dockerfile:41` and `:61` use `node:22-bookworm-slim@sha256:…` — tag **and** digest.
  As written, the comment's claim that "A digest-bump PR here is therefore the INTENDED
  early-warning signal" is unbacked, and the base digest will silently rot.
  Fix is one token: `FROM ghcr.io/boldsoftware/exeuntu:latest@sha256:4398…` (adding the
  tag does not change the resolved image and so does not change the digest or the
  `buildId` — `parseBaseRefs` reads the digest, and `deriveBuildId` hashes the Dockerfile
  bytes, so it *will* re-pin once; land it with the next re-pin).
- **Verified:** grepped every `FROM`/`ARG` in both Dockerfiles and compared the two
  reference forms; confirmed `oci/exedev/Dockerfile` exists so the `directory` itself is
  valid. Confirm empirically by watching for a bump PR after the next upstream rebuild.

---

## [MEDIUM] The 403 explainer fires for failures that have nothing to do with the registry

- **File:** `.github/workflows/publish-exedev-image.yml:269-270`
  (`if: failure() && (steps.login.outcome == 'failure' || steps.publish.outcome == 'failure')`)
  and the body at `:271-292`.
- **Trigger:** any non-registry failure of the `Build and push` step — a denied license in
  the DF2.9 sweep (script exit 1), a credential-scan finding (exit 1), an unreadable
  package or missing builder (exit 2), a `systemd-analyze verify` failure, an OOM.
- **Why it matters:** `steps.publish` is a single step that does five things (build,
  license sweep, credential scan, marker assertions, push). Any of them failing sets
  `outcome == 'failure'`, and the step then prints `::error::registry step failed — read
  this before assuming a bad image path` followed by a three-bullet essay about ghcr
  permissions and package ownership, and `exit 1`s — overwriting the real cause in the
  annotation list with a confident wrong diagnosis. The script's own exit codes (0 clean /
  1 compliance / 2 fatal-before-the-sweep) are documented three lines above at `:245-247`
  and are exactly the discriminator that is not used.
- **Verified:** read the exit-code contract in `scripts/build-exedev-image.ts` (`die(1, …)`
  compliance paths at `:1082`, `die(2, …)` prerequisite paths at `:471-474`, `:640`,
  `:1029`) and confirmed all of them surface through the one `publish` step id.

---

## [MEDIUM] A squash or rebase merge invalidates the pin on landing, and the recovery commit cannot re-trigger the workflow

- **File:** `.github/workflows/publish-exedev-image.yml:44-49` (`on.push.paths`) and
  `:146-168` (the source-revision step), against the header's convergence claim at
  `:123-127`.
- **Trigger:** merging this PR into `dev` with "Squash and merge" or "Rebase and merge".
- **Why it matters:** the convergence argument depends on the commit that last touched
  `SOURCE_PATHS` surviving the merge. A true merge commit preserves it (git's history
  simplification returns the feature-branch commit, since the merge is TREESAME to that
  parent for those paths). A squash or rebase merge does not: the paths are re-authored
  under a brand-new SHA with the merge's timestamp, so `source_sha` and `source_epoch`
  both move and the pin adopted on the branch is stale the instant it lands. The push
  trigger then fires on `dev`, builds, pushes a public tag, and fails the gate — and the
  documented recovery (a `driver.ts`-only commit) matches neither path in `on.push.paths`,
  so `dev` stays red until an operator knows to dispatch manually. The workflow's
  bootstrapping ritual is written for `workflow_dispatch` and never mentions this.
- **Verified:** `git log origin/dev --format='%h parents=%p'` shows two-parent merge
  commits today (`7806bbe`, `185291e`), so the current convention is safe — but
  `_bmad-output/sprint-artifacts/sprint-status.yaml` records "PR #103 squash-merged" and
  "PR #105 squash-merged (43ca5e7)" for DF2.7/DF2.9, so both styles are in use and the
  GitHub UI offers squash by default.

---

## [LOW] `oci/exedev/.build/` is not gitignored, while `oci/.build/` is

- **File:** `.gitignore:12` (`oci/.build/`) vs `.github/workflows/publish-exedev-image.yml:70`
  and `:256` (`mkdir -p "$BUILD_DIR"` where `BUILD_DIR: oci/exedev/.build`).
- **Trigger:** running the workflow's build command locally, e.g. to reproduce a digest.
- **Why it matters:** the script's own scratch dir (`oci/.build/exedev`) is ignored; the
  directory the *workflow* invents is not. `git check-ignore -v oci/exedev/.build` returns
  nothing. Untracked-and-un-ignored scratch beside a tracked Dockerfile is one `git add -A`
  from landing in a PR — the same hazard `.gitignore:44-47` already calls out by name for
  `.qds-mon/` and `.pollscripts/`.
- **Verified:** ran `git check-ignore -v oci/exedev/.build` (no match) and read
  `.gitignore` in full.

---

## [LOW] `jq -r .token` misattributes a token-endpoint failure as "the package is not public"

- **File:** `.github/workflows/publish-exedev-image.yml:391`.
- **Trigger:** ghcr returning a 200 body without a `.token` field (an auth-service
  regression, a redirect to an error document, an ordinary ghcr incident).
- **Why it matters:** `jq -r` on a missing key emits the literal string `null`, so
  `Authorization: Bearer null` goes out, the manifest read answers 401/403, and the step
  prints `the package is not public` plus a settings URL and a Danger-Zone instruction —
  sending an operator to flip a visibility switch that is already correct. The adjacent
  digest reads in this same workflow all use `jq -er` (`:413`, `:432-433`, `:466-467`,
  `:535+`); this one call does not.
- **Verified:** diff plus the `-er` usage of every sibling `jq` call in the same file.

---

## [LOW] The anonymous-pull probe has no timeout, no retry, and no message on a network-level failure

- **File:** `.github/workflows/publish-exedev-image.yml:392-395`.
- **Trigger:** DNS failure, TLS reset or a hung connect to `ghcr.io` after a successful push.
- **Why it matters:** `curl -s -o /dev/null -w '%{http_code}'` carries no `-f`, no
  `--max-time` and no `--retry`. On an HTTP error it returns the code (handled); on a
  transport failure it exits non-zero, `set -e` kills the step, and the operator sees a
  bare curl exit with none of the step's diagnostics — after a successful publish, which
  is the expensive half. A hung connect burns the remainder of `timeout-minutes: 30`. The
  workflow already treats transient registry reads as retryable elsewhere (the 5-attempt
  loop at `:695-699`); this read is the one that is not.
- **Verified:** diff only.

---

## [LOW] `IMAGE` and `IMAGE_PATH` are two hardcoded spellings of one registry path with no lockstep guard

- **File:** `.github/workflows/publish-exedev-image.yml:67-68`.
- **Trigger:** renaming the package, transferring the repository, or a fork.
- **Why it matters:** `IMAGE_PATH` is consumed only by the anonymous-pull step (`:391`,
  `:395`); everything else uses `IMAGE`. Changing one and not the other leaves a workflow
  that publishes to A and proves the public visibility of B — and the proof step *passes*,
  because it would be reading a package that really is public. The `on.push.paths` /
  `SOURCE_PATHS` pair at least carries a "KEEP IN LOCKSTEP" comment; this pair has none,
  and `IMAGE_PATH` is derivable (`${IMAGE#ghcr.io/}`).
- **Verified:** grepped every use of both variables in the file.

---

## [LOW] Fork pushes run the whole build before failing on a hardcoded `biospark33` package

- **File:** `.github/workflows/publish-exedev-image.yml:38-49` (`push: branches: [main, dev]`)
  with `:67-68` hardcoded to `ghcr.io/biospark33/qds-exedev`.
- **Trigger:** a fork pushing to its own `main`/`dev` with any change under `oci/exedev/**`.
- **Why it matters:** the fork's `GITHUB_TOKEN` has `packages: write` for the *fork's*
  namespace, not `biospark33`'s, so the push 403s — after a full base pull, image build,
  license sweep and credential scan. The `Classify a registry failure` explainer then
  offers three causes, none of which is "you are on a fork and the image path is not
  yours". A `jobs.publish.if: github.repository == 'Quantum-Digital-Solutions/QDS-Factory'` (or deriving
  `IMAGE` from `github.repository_owner`) fails in seconds instead.
- **Verified:** diff plus the hardcoded env block.

---

## [LOW] A missing marker file inside the image fails the gate with a bare `cat` error

- **File:** `.github/workflows/publish-exedev-image.yml:431-433`.
- **Trigger:** a Dockerfile regression that drops `/etc/qds-image.json` (or renames it),
  or a base-image change that masks the path.
- **Why it matters:** `marker=$(docker run --rm --entrypoint cat "$IMAGE@$actual_digest" /etc/qds-image.json)`
  fails the assignment, `set -e` ends the step, and none of the surrounding gate's
  diagnostics run — no `pushed:`/`buildId:`/`platform:` lines, no INV-IBOX-2 explanation.
  Every other failure arm in this step prints a named `::error::` with a remedy; this one
  emits `cat: /etc/qds-image.json: No such file or directory`. The Dockerfile already
  guards the *build* side of this contract with empty-`ARG` checks
  (`oci/exedev/Dockerfile:274+`); the publish side does not.
- **Verified:** read the step body and the Dockerfile's marker `RUN` guard.

---

## [LOW] SKILL.md's `liveGate` grep recipe returns multiple lines on the very files it warns about

- **File:** `.claude/skills/qds-live-e2e/SKILL.md`, the block added at diff lines 47-59
  (`grep -n 'liveGate(' tests/fleet/e2e/<file>.live.test.ts`, then "The argument is the
  tier, and it is the only authority on what a file costs").
- **Trigger:** running the recipe against `tier1-image-contract` — the headline example —
  or against `tier1-approval-gate`.
- **Why it matters:** the recipe promises one line whose argument is the tier. Measured:
  `tier1-image-contract.live.test.ts` returns two lines, `:34` (a doc comment reading
  `` `liveGate("2")` + `preflight("2")` ``) and `:87` (the call);
  `tier1-approval-gate.live.test.ts` returns two *real* calls, `:124` and `:649`. A reader
  who takes the first line as authoritative is reading a comment. `grep -n '^\s*liveGate('`
  (or `grep -c`) restores the one-line-one-answer property the paragraph claims. Everything
  else in this SKILL.md block checks out — `config/rosters/roster.yaml` exists with exactly
  the two documented roles, `qds-default.roster.yaml` sits beside it, no
  `df16-e2e.roster.yaml` exists anywhere in the tree, `rosterModels()` is at
  `src/providers/exedev/setup-gate.ts:158` and throws at `:338` before any spend,
  `dirname(manifestPath)/roster.yaml` is `src/fleet/dispatch.ts:1424`, `liveGate` checks
  exactly the six named env vars (`tests/fleet/e2e/live-harness.ts:42-66`) and never opens
  the roster path, and the tier table now accounts for all 18 files in `tests/fleet/e2e/`
  with every `liveGate` argument matching.
- **Verified:** ran the documented grep against all four files named in the new table rows;
  listed `tests/fleet/e2e/` and `config/rosters/`; read `live-harness.ts:40-70`.
