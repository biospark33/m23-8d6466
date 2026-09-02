# blind-ci

## [HIGH] Every publish guard lives in a file a feature branch can edit; the attestation that results is accepted because nothing binds the ref
- **File:line:** `.github/workflows/publish-exedev-image.yml:157` (environment selector), `:208` (ref refusal), `.github/workflows/verify-image-pin.yml:97` + `:118-126` (identity binding)
- **Trigger:** `workflow_dispatch` runs the version of the workflow file that exists on the **selected ref**, not on the default branch. An actor with write access pushes `feature/x` carrying a one-line edit — `environment: publish-dry-run` unconditionally, or simply deleting the "Refuse a publishing dispatch from an unprotected ref" step — and dispatches it against that ref with `dry_run: false`. The `if: github.repository_owner` guard passes (same repo), `DRY_RUN` is empty, the push happens, the `attest` job mints a Sigstore bundle. `verify-image-pin.yml` then accepts that bundle for a pin change: `--signer-workflow` binds only `owner/repo/.github/workflows/publish-exedev-image.yml` — **a path, with no ref** — so provenance minted from an arbitrary branch is indistinguishable from provenance minted from `dev`. The file's own claim that the required-reviewer rule "lives SERVER-SIDE where a feature branch cannot edit it out" is false: the branch cannot edit the rule, but it chooses **which environment name** the job deploys to, which selects whether any rule applies at all. Environment deployment-branch restrictions do not help for the same reason. The whole "publishes come only from reviewed refs, pins only from attested publishes" chain (`verify-image-pin.yml:11-13`) reduces to "the file said so".
- **Evidence:**
```
    environment: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'publish-dry-run' || 'publish-exedev' }}
      - name: Refuse a publishing dispatch from an unprotected ref
        if: github.event_name == 'workflow_dispatch' && !inputs.dry_run
```
```
          SIGNER: ${{ github.repository }}/.github/workflows/publish-exedev-image.yml
            args=("oci://$REF"
              --repo "$GITHUB_REPOSITORY"
              --signer-workflow "$SIGNER"
```
  The ref must be bound in the *verifier* (`--cert-identity` / `--cert-identity-regex` pinning `@refs/heads/(main|dev)`), because that is the only control not stored in the branch under attack.

## [HIGH] An exception entry whose `expires` key is missing or misspelled never expires — the self-expiry claim is defeated by a typo
- **File:line:** `.github/workflows/verify-image-pin.yml:135`, register at `.github/image-pin-exceptions.json:7`
- **Trigger:** `jq -r '… | .expires'` prints the literal string `null` when the key is absent (typo `expiry`, `expires_at`, or simply omitted). `[ "2026-09-01" \> "null" ]` is **false** — digits sort before lowercase letters — so the expiry branch is never taken and the gate falls through to `::warning::` + `exit 0`, forever. Same class of failure for any non-ISO spelling (`"2026-9-5"`, `"15/10/2026"`), which is compared lexically against `%Y-%m-%d` and gives an arbitrary verdict. Nothing in this diff schema-validates the exceptions file: `digest`, `expires`, `reason` and `removedBy` are all free-form, and only `digest` is ever required to be well-formed (by the `select`). This directly contradicts the register's own guarantee.
- **Evidence:**
```
            if [ "$today" \> "$exception_expires" ]; then
```
```
  "$comment": "… the verify workflow fails after `expires`, so an exception cannot quietly become permanent."
```
  Fix direction: require the field (`jq -e … .expires`) and validate the `^\d{4}-\d{2}-\d{2}$` shape before comparing; a null/garbage `expires` must be a hard failure, not a permanent pass.

## [MEDIUM] The gate that guards the exception register is triggered by, and reads, the PR that edits it
- **File:line:** `.github/workflows/verify-image-pin.yml:35-39`, `:107-109`
- **Trigger:** `pull_request` checks out the PR's tree, so `.github/image-pin-exceptions.json` **and `verify-image-pin.yml` itself** are the PR's versions. One PR that (a) moves `DEFAULT_IMAGE_REF` to any digest and (b) adds an exception naming that digest with `"expires": "2099-01-01"` goes green with a warning annotation nobody reads. A PR that instead edits line 143's `exit 1` to `exit 0` also goes green, and the required-check name is unchanged. The only enforcement is human review — which is fine as a stated posture, but the header markets this as a "machine-enforced invariant".
- **Evidence:**
```
on:
  pull_request:
    paths:
      - src/providers/exedev/driver.ts
      - .github/image-pin-exceptions.json
      - .github/workflows/verify-image-pin.yml
```

## [MEDIUM] The pin gate is `pull_request`-only, while the ritual that moves the pin is documented as a push
- **File:line:** `.github/workflows/verify-image-pin.yml:34-35`; prescribed bypass at `.github/workflows/publish-exedev-image.yml:759` and `:764`
- **Trigger:** `publish-exedev-image.yml` runs on `push: branches: [main, dev]`; `verify-image-pin.yml` has **no `push:` trigger at all**. Its recovery text tells the operator to edit `driver.ts`, "commit, and PUSH the commit to a branch this workflow triggers on" — i.e. `dev` or `main`. A direct push to `dev` carrying a new `DEFAULT_IMAGE_REF` never runs the provenance gate; the publish workflow happily rebuilds and goes green. Whether that path is reachable depends on branch protection on `dev`/`main`, which is not in this diff — hence capped at MEDIUM — but the trigger asymmetry between the producer (push + dispatch) and the consumer gate (PR only) is unconditional and visible here.
- **Evidence:**
```
            echo "lines, commit, and PUSH the commit to a branch this workflow triggers on:"
            echo "The PUSH is what heals this: $DRIVER is in on.push.paths, so pushing the"
```

## [MEDIUM] `verify-image-pin` does a single-shot `gh attestation verify` against an API the sibling job documents as eventually consistent
- **File:line:** `.github/workflows/verify-image-pin.yml:125`
- **Trigger:** `publish-exedev-image.yml:1074-1078` retries the *same* command 5× over ~40s because "a bundle filed seconds earlier can read back empty on the first try". The consumer gate does one attempt per store, and the pin-adoption PR is by construction opened minutes after the publish run that filed the bundle. A propagation lag therefore fails the gate with `::error::DEFAULT_IMAGE_REF moved to <digest>, which carries no provenance …` — a confident wrong diagnosis pointing the reviewer at the exception register (i.e. at the escape hatch) for what is a transient read.
- **Evidence:**
```
            if ! gh attestation verify "${args[@]}"; then verified=0; fi
```
  versus, in the producer:
```
            for attempt in 1 2 3 4 5; do
```

## [MEDIUM] Push happens before the gate, so every mismatch leaves an unattested, publicly pullable tag behind and nothing prunes it
- **File:line:** `.github/workflows/publish-exedev-image.yml:490` (`--push`), gate at `:603`, attest skip at `:190-191`/`:903`
- **Trigger:** `--push` is added whenever `DRY_RUN` is empty, and the digest/buildId comparison runs *after*. On any mismatch the job fails, `steps.publish.outputs.published` is still `true`… no — it is set, but the job's failure skips `attest` via `needs`. Net: the public package now holds `ghcr.io/biospark33/qds-exedev:sha-<sha>`, anonymously pullable, with **no** provenance attestation, and the workflow states this is routine, not exceptional ("routine source-only commits (including weekly dependabot bumps) also move the digest and land here as a matter of course", `:779`). AC4's whole model is customers mirroring the public source image; a mirror pipeline that copies by tag rather than by the pinned digest can pick up a build no gate accepted. The comment at `:30` acknowledges the accumulation and explicitly declines to prune.
- **Evidence:**
```
          if [ -z "$DRY_RUN" ]; then args+=(--push); fi
```
```
#      publicly-pullable, unsigned per-revision `sha-<sha>` tags that nothing
#      references (the attest job is skipped when publish fails). Pruning
#      those is a manual registry chore, not something this workflow does.
```

## [MEDIUM] The new dependabot entry is inert by its own admission — the boot image's base digest is watched by nobody
- **File:line:** `.github/dependabot.yml:65-68`
- **Trigger:** `oci/exedev/Dockerfile` pins the base as a bare `@sha256:…` with no tag, and dependabot's docker updater derives the stream to follow from the tag. This entry can never open a PR in its current form, and the diff explicitly declines to land the one-token fix (`exeuntu:latest@sha256:…`) in this change. What ships is config that reads as coverage and provides none — "no PR is indistinguishable from no upstream change", as the comment itself puts it. Semantically dead YAML is exactly the failure mode a reviewer would otherwise catch six months from now.
- **Evidence:**
```
  - package-ecosystem: docker
    directory: /oci/exedev
    schedule:
      interval: weekly
```

## [MEDIUM] Duplicate digests in the exception register produce a multi-line `expires` and an undefined comparison
- **File:line:** `.github/workflows/verify-image-pin.yml:108-109`, compared at `:135`
- **Trigger:** `jq '.exceptions[] | select(.digest == $d) | .expires'` emits one line **per** matching entry. Two entries for the same digest (a re-ratification appended rather than replaced — the exact workflow the `removedBy` field invites) makes `exception_expires` a two-line string, and `[ "$today" \> "$two\nlines" ]` compares against the concatenation. The publish workflow goes to considerable trouble to make a duplicate `DEFAULT_IMAGE_REF` declaration fatal (`:365-379`); the register gets no equivalent uniqueness check.
- **Evidence:**
```
            exception_expires=$(jq -r --arg d "$digest" '.exceptions[] | select(.digest == $d) | .expires' .github/image-pin-exceptions.json || true)
```

## [LOW] The fork guard in `verify-image-pin.yml` cannot do what its comment claims
- **File:line:** `.github/workflows/verify-image-pin.yml:47-49`
- **Trigger:** For a `pull_request` event, the workflow runs in the **base** repository, so `github.repository_owner` is always `biospark33` — including for PRs from forks. The guard never skips a fork PR; it only skips if someone forks the repo *and* opens PRs against their own fork. The stated reasoning ("a fork PR has no access to this repo's attestation store and would fail on a path that was never its own") describes a case this expression does not select. Copied verbatim from the publish workflow, where the same expression *is* correct because that one triggers on `push`.
- **Evidence:**
```
    # Same owner guard + reasoning as publish-exedev-image.yml: a fork PR has
    # no access to this repo's attestation store and would fail on a path that
    # was never its own.
    if: github.repository_owner == 'biospark33'
```

## [LOW] `verify-image-pin.yml`'s checkout persists the token; the sibling workflow's does not, and says why
- **File:line:** `.github/workflows/verify-image-pin.yml:53`
- **Trigger:** No `with: persist-credentials: false`, so the job token lands in `.git/config` for the rest of the job — the `artipacked` finding the publish workflow explicitly remediates at `:223-227`. Impact is bounded (`contents: read`, and the only later steps are `grep`/`jq`/`gh`), but the inconsistency means the zizmor rule the team already adopted will flag this new file on its next run.
- **Evidence:**
```
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```
  (no `with:` block, versus the publish job's `persist-credentials: false` + `fetch-depth: 0`.)

## [LOW] The attest job's SHA-pinning rationale describes a repo state this diff contradicts
- **File:line:** `.github/workflows/publish-exedev-image.yml:972-974`
- **Trigger:** The comment justifies SHA-pinning `attest-build-provenance` as an exception to "the tag-pinned actions in the `publish` job and ci.yml" — but every action added here is already SHA-pinned (`:223`, `:237`, `:867`). Either the comment is stale or the described tag-pinned actions live elsewhere; as written it invites a future maintainer to conclude that tag pins are the house style and relax one of these. Cannot confirm ci.yml's state without repo access.
- **Evidence:**
```
      # SHA-pinned, unlike the tag-pinned actions in the `publish` job and
      # ci.yml. Not inconsistency for its own sake: this is the only job in the
```
  and, in that same job:
```
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```

## [LOW] The `github-actions` dependabot ecosystem that keeps these four SHA pins fresh is asserted, not visible
- **File:line:** `.github/workflows/publish-exedev-image.yml:977-978`; `.github/dependabot.yml` (hunk shows only the `/oci` docker entry as context)
- **Trigger:** The attest job's pin is defended with "Dependabot's github-actions entry maintains SHA pins the same way it maintains tags". The visible portion of `dependabot.yml` contains docker entries only; if no `package-ecosystem: github-actions` entry exists, all four commit-SHA pins in this PR go stale silently and never receive a security update. Not determinable from the diff — the hunk starts at line 35 — hence LOW.
- **Evidence:**
```
      # Dependabot's github-actions entry maintains SHA pins the same way it
      # maintains tags, so the pin does not go stale silently.
```
