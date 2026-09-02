# edge-ci

## [BLOCKER] An exception entry with no (or a misspelled) `expires` key is a permanent, silent pin-gate bypass
- **File:line:** `.github/workflows/verify-image-pin.yml:133-140` (register: `.github/image-pin-exceptions.json:7`)
- **Trigger:** A PR moves `DEFAULT_IMAGE_REF` to an arbitrary, never-published, never-attested digest and adds `{"digest": "sha256:<that digest>", "reason": "…"}` to `.github/image-pin-exceptions.json` — omitting `expires`, or spelling it `expiry`/`expiresAt`/`Expires`. `gh attestation verify` fails for both stores (`verified=0`), the code falls into the exception arm, and the expiry test does not fire.
- **Evidence:**
  ```
  109:  exception_expires=$(jq -r --arg d "$digest" '.exceptions[] | select(.digest == $d) | .expires' … || true)
  133:  if [ -n "$exception_reason" ]; then
  134:    today=$(date -u +%Y-%m-%d)
  135:    if [ "$today" \> "$exception_expires" ]; then
  ```
  `jq -r` on an absent field prints the literal string `null`, so `exception_expires="null"`. `[ "2026-09-02" \> "null" ]` is FALSE (`'2'` < `'n'` in ASCII), so the entry is never expired — on any date, forever. `reason` has the same hazard in the other direction: a missing `reason` yields the non-empty string `null`, which satisfies `[ -n "$exception_reason" ]`, so an entry consisting of nothing but a `digest` key takes the accept path. Exit 0, `::warning::` only.
- **Confirmed by:** Ran the exact two `jq` invocations and the exact `[ "$today" \> "$e" ]` test against a synthetic register lacking `expires` — output: `reason=[pwned] expires=[null] … NOT EXPIRED -> ACCEPTED (bypass)`. Also `grep -rn image-pin-exceptions` over the repo: the string appears in exactly ONE file (`.github/workflows/verify-image-pin.yml`) — there is no schema validation, no required-field check, and no test anywhere that would catch a missing or misspelled key. The register's own `$comment` (`.github/image-pin-exceptions.json:2`) asserts "the verify workflow fails after `expires`, so an exception cannot quietly become permanent"; that is exactly the property that is unenforced.

## [HIGH] The exception expiry is never re-evaluated — nothing runs the gate after the expiry date
- **File:line:** `.github/workflows/verify-image-pin.yml:34-39`
- **Trigger:** The bootstrap exception expires 2026-10-15. No PR after that date touches `src/providers/exedev/driver.ts`, `.github/image-pin-exceptions.json`, or `verify-image-pin.yml` — the overwhelmingly likely case, since the pin only moves on a deliberate re-pin. `dev`/`main` keep shipping an unattested, hand-pushed production boot digest and CI emits zero signal, indefinitely.
- **Evidence:**
  ```
  34: on:
  35:   pull_request:
  36:     paths:
  37:       - src/providers/exedev/driver.ts
  38:       - .github/image-pin-exceptions.json
  39:       - .github/workflows/verify-image-pin.yml
  ```
- **Confirmed by:** Read the complete `on:` block — there is no `schedule:`, no `push:`, no `workflow_dispatch:`. The gate is a change-triggered PR check only, so "self-expiring" is conditional on someone happening to open a PR that touches one of three paths. Compare the intent statement at `verify-image-pin.yml:27-31` ("An exception past its `expires` date fails the gate, so nothing in that file can quietly become permanent") — true only for a PR that already touches the pin. A `schedule:` leg is the missing trigger.

## [MEDIUM] `verify-image-pin.yml` grants only `contents: read`; the repository is PRIVATE, so the GitHub-store attestation read may never succeed — pushing every legitimate re-pin into the exception register
- **File:line:** `.github/workflows/verify-image-pin.yml:41-42`, used at `:118-126`
- **Trigger:** DF1.10's re-pin lands: a properly attested, CI-built digest. `gh attestation verify --repo biospark33/QDS-Factory …` reads `GET /repos/{owner}/{repo}/attestations/{digest}` with a `GITHUB_TOKEN` whose permission set is `contents: read` and *nothing else* (an explicit `permissions:` block sets every unlisted scope to `none`, including `attestations`). On a private repo that read is not anonymous. `verified=0` → no exception entry for the new digest → hard fail on a pin that is genuinely attested. The documented remedy in the failure text is "re-pin via the publish workflow", which does not help; the only way to go green becomes adding an exception entry — normalising the bypass path in finding 1.
- **Evidence:**
  ```
  41: permissions:
  42:   contents: read
  …
  125:  if ! gh attestation verify "${args[@]}"; then verified=0; fi
  ```
- **Confirmed by:** `gh repo view biospark33/QDS-Factory --json isPrivate` → `{"isPrivate":true,"visibility":"PRIVATE"}`, so the anonymous-public-repo path for the attestations API does not apply. Confirmed the permission asymmetry against the only job in the repo that runs `gh attestation verify` successfully today — `publish-exedev-image.yml`'s `attest` job at `:907-915` — which holds `attestations: write` (implying read) plus `id-token: write`; `verify-image-pin.yml` holds neither. Stated honestly: I confirmed the asymmetry and the private visibility, not the endpoint's exact permission requirement. The failure direction is closed (red), but a permanently-red gate is what converts the exception register from an escape hatch into the routine path.

## [MEDIUM] Workflow-scoped concurrency group: the prescribed "push the pin-adoption commit to heal it" run can be CANCELLED rather than run, and cancelled is not red
- **File:line:** `.github/workflows/publish-exedev-image.yml:98-101`
- **Trigger:** A dependabot npm merge lands on `dev` (package.json is in `on.push.paths`) and starts a ~30 min publish. The operator pushes the pin-adoption commit to `dev` — it queues. A third publish-triggering push (another source commit, or a dry-run dispatch from any feature branch, which shares the group) arrives while the second is still pending. GitHub keeps at most ONE pending run per concurrency group and cancels the older pending run, so the healing run never executes. The run shows as *cancelled*, not failed — no red check, no annotation, and `dev` stays on a pin that does not match the published digest.
- **Evidence:**
  ```
  98: concurrency:
  99:   group: ${{ github.workflow }}
  100:   cancel-in-progress: false
  ```
- **Confirmed by:** Read the group expression: it contains no `github.ref`, `github.event_name` or `inputs.dry_run`, so feature-branch dry runs, `dev` publishes and `main` publishes all serialise into one queue slot. The workflow's own recovery text (`:826-832`, "The PUSH is what heals this… Do NOT press Re-run on THIS run") depends on that pushed run actually executing, and the only thing that would surface its non-execution is someone noticing a cancelled run.

## [MEDIUM] The "human second factor" is an environment NAME with nothing in-repo creating or asserting it
- **File:line:** `.github/workflows/publish-exedev-image.yml:157`
- **Trigger:** The `publish-exedev` environment is never created via the API (or is later deleted, renamed, or has its required-reviewer rule removed by anyone with repo admin). GitHub creates a referenced-but-nonexistent environment implicitly, with NO protection rules. Every subsequent push to `dev` then publishes to the public, customer-mirrored package with zero approval — and the run is fully green, so nothing distinguishes "approved publish" from "no approval gate existed".
- **Evidence:**
  ```
  157: environment: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'publish-dry-run' || 'publish-exedev' }}
  ```
  The comment at `:150-156` states the requirement — "Both names must exist as environments in this repository (created via the API alongside this change); a name with no environment behind it runs with no protection at all, silently" — and then does nothing about it.
- **Confirmed by:** Grepped the whole workflow for any step that queries `/repos/{owner}/{repo}/environments/publish-exedev` or otherwise asserts a reviewer rule exists — there is none. Every other cross-file agreement in this PR is asserted in code (the `BUILD_DIR` grep at `:432-448`, the `UNPINNED_DIGEST` spelling readback at `:403-412`, the pin-declaration count check); this one, the only control the file calls "THE HUMAN SECOND FACTOR", is the exception.

## [MEDIUM] `packages: write` is unconditional, so the dry-run route grants a registry-write token to an unreviewed ref with no environment protection
- **File:line:** `.github/workflows/publish-exedev-image.yml:177-179` with `:157` and `:209`
- **Trigger:** A write-access actor (or a compromised bot/collaborator account) pushes a branch, edits its own copy of `publish-exedev-image.yml` — `workflow_dispatch` executes the workflow file *from the dispatched ref* — and dispatches it with `dry_run: true`. The dispatch routes to `publish-dry-run`, which by design has no protection rules and no reviewer, while the job still carries `packages: write` and `secrets.GITHUB_TOKEN`. The "Refuse a publishing dispatch from an unprotected ref" step at `:209` is gated on `!inputs.dry_run` and, being in the same file, can simply be deleted on that branch. Result: an arbitrary manifest pushed to `ghcr.io/biospark33/qds-exedev` — the public package customers mirror — with no approval and no branch-protection review.
- **Evidence:**
  ```
  177:     permissions:
  178:       contents: read
  179:       packages: write
  …
  209:         if: github.event_name == 'workflow_dispatch' && !inputs.dry_run
  ```
  The trigger comment at `:57-65` claims this design "closes the door the branch-filtered push trigger left open: any write-access actor could dispatch from any branch carrying arbitrary build inputs and write to the customer-mirrored package."
- **Confirmed by:** Read the `permissions:` block — it is job-level and unconditional; Actions has no way to make a permission conditional on an input, so the dry-run route cannot drop `packages: write` without a second job. Stated honestly: a write-access actor could already add a *new* workflow with `packages: write` on their own branch, so the residual risk is a pre-existing GitHub property — but the stated closure is not delivered, and the dry-run environment is explicitly documented as carrying no protection rules (`:150-153`).

## [LOW] `verify-image-pin.yml` checks the digest but never `DEFAULT_IMAGE_BUILD_ID`
- **File:line:** `.github/workflows/verify-image-pin.yml:78-99` (the `pin` step reads only `DEFAULT_IMAGE_REF`)
- **Trigger:** A hand-edited PR moves `DEFAULT_IMAGE_REF` to a genuinely attested digest but leaves `DEFAULT_IMAGE_BUILD_ID` at the previous value (or transposes two hex chars). The gate verifies the attestation and goes green; the driver then passes a buildId that no box's `/etc/qds-image.json` marker matches, and every `create()` fails the setup gate at boot.
- **Evidence:** the step's grep and count checks target `DEFAULT_IMAGE_REF` only:
  ```
  87:  n_ref=$(grep -c 'export const DEFAULT_IMAGE_REF' "$DRIVER" || true)
  92:  ref=$(printf '%s' "$flat" | grep -oE 'export const DEFAULT_IMAGE_REF =[^;]*' | …)
  ```
- **Confirmed by:** `grep -rn DEFAULT_IMAGE_BUILD_ID src/ tests/` — the constant lives at `src/providers/exedev/driver.ts:278` and is consumed at `driver.ts:521` (`this.imageBuildId`). The publish workflow's gate DOES check both together (`publish-exedev-image.yml:787`, `actual_build_id != EXPECTED_BUILD_ID`), so the two constants are treated as a unit there and not here — and the publish gate only runs on a push to `main`/`dev`, i.e. after the PR merged.

## [LOW] Duplicate digest entries in the exception register produce a multi-line `expires` and a meaningless comparison
- **File:line:** `.github/workflows/verify-image-pin.yml:108-109`, `:135`
- **Trigger:** Two entries carry the same `digest` — e.g. a stale one from an earlier bootstrap plus a re-ratified one added by a later PR. `jq` emits one line per match, so `exception_expires` becomes `"2099-01-01\n2026-10-15"` and `[ "$today" \> "$exception_expires" ]` string-compares the date against the concatenation. Ordering decides the verdict: with the far-future entry first, an expired entry is silently masked; with it second, an unexpired entry is reported as EXPIRED.
- **Evidence:**
  ```
  109:  exception_expires=$(jq -r --arg d "$digest" '.exceptions[] | select(.digest == $d) | .expires' … || true)
  135:  if [ "$today" \> "$exception_expires" ]; then
  ```
  There is no `| first`, no `-n1`/`head -1`, and no uniqueness assertion.
- **Confirmed by:** Same repo-wide grep as finding 1 — `image-pin-exceptions` appears only in this workflow, so nothing else validates the register's shape or enforces one entry per digest.

## [LOW] `verify-image-pin.yml`'s checkout omits `persist-credentials: false`, which the sibling workflow sets deliberately
- **File:line:** `.github/workflows/verify-image-pin.yml:53`
- **Trigger:** Any PR that triggers this workflow. The job's checkout leaves the Actions token in `.git/config`; the same repo treats that as a defect elsewhere.
- **Evidence:**
  ```
  53:  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
  ```
  with no `with:` block at all, versus `publish-exedev-image.yml:225-231`:
  ```
  persist-credentials: false   # DF2.9 round 3, zizmor `artipacked`
  ```
- **Confirmed by:** Read both checkout steps in this PR. The action SHA is identical and correctly pinned in both; only the hardening option differs, and the publish workflow's comment names the zizmor rule that flags exactly this.

---

Checked and found NO defect in (so these are deliberately absent above): action SHA pinning (`actions/checkout@3d3c42e5…`, `oven-sh/setup-bun@0c5077e5…`, `actions/upload-artifact@ea165f8d…`, `actions/attest-build-provenance@4d101475…` — all commit-SHA-pinned, no `@main`, no `@v4` float, no `curl | bash`); script injection (every `${{ }}` reaching a `run:` block is routed through a step/job `env:` first — no `github.event.*`, branch name, PR title or dispatch input is interpolated into shell); `BUILD_DIR` agreement (`scripts/build-exedev-image.ts:124` is `const BUILD_DIR = path.join(REPO_ROOT, "oci/.build/exedev");`, which the workflow's grep at `:503` matches and equals the `BUILD_DIR` env — the assertion is live, not vacuous); the evidence-JSON fields the dry gate reads (`builtDigest`, `buildId`, `gitSha`, `platform` are all written at `scripts/build-exedev-image.ts:2061-2075`); `SOURCE_DATE_EPOCH`/`QDS_GIT_SHA` env overrides (honoured at `:326` and `:366`); dependabot's `github-actions` ecosystem entry (`.github/dependabot.yml:25-31`), which the attest job's SHA-pin-freshness claim depends on; fork-PR exposure on `verify-image-pin.yml` (`github.repository_owner` is the BASE owner on a `pull_request`, so the guard does not skip fork PRs as its comment claims — but the repo is private, so fork PRs are not a reachable scenario).
