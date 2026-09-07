# Fixes — `.github/workflows/publish-exedev-image.yml` (round 6)

File: `/Users/steve/QDS-Factory/.github/workflows/publish-exedev-image.yml`
Branch: `fix/df2.10-review-round-6` (no commit, no push). 578 insertions / 108 deletions, one file.

Line numbers below are POST-fix.

## Fixed

### From `blind-workflow-publish.md`

1. **[HIGH] SLSA provenance named `GITHUB_SHA` (P31)** — `:1683-1698` (comment), `:1709-1711`, `:1729-1739`.
   `publish` gained a `source_sha` output (`:257-262`); `attest` takes it as `SOURCE_SHA` (`:1542-1544`) and
   feeds it to `resolvedDependencies[0].digest.gitCommit`. `GITHUB_SHA` is kept as a second, named entry
   (`name: "workflow-revision"`) per the pre-decided call. Both jq args are `:?`-guarded, so a blank
   `source_sha` refuses to sign rather than attesting an empty commit.
2. **[HIGH] Pin gate never checked the registry path (P32)** — `:530-551`. New `case "$ref" in "$IMAGE"@*)`
   right after the `sha256:` shape check, with a named refusal. Verified by execution: today's real pin
   passes; `ghcr.io/someone-else/whatever@…`, `…/qds-exedev-evil@…` and a glob-bearing pin all refuse.
   The bootstrap sentinel still passes (the sentinel replaces only the digest — `driver.ts:200`).
3. **[HIGH] Environment policy has no automated verification (P35)** — behaviour unchanged (the assert was
   measured 403 three ways and removed; keeping the residual documented is the standing decision). What was
   wrong was the prose: `:186-197` no longer claims a server-side *required-reviewer* rule and now names the
   422 billing-plan measurement and the branch-policy-only reality. The "not detectable from CI" residual
   block (`:322-333`) stands and is now also referenced from the fork guard.
4. **[MED] Prune never fired for push-then-exit-1** — `:741-751`. `published=true` is now written *before*
   the build runs (it is what "a `--push` build ran" means). Output doc rewritten at `:263-280`; the
   downstream reasoning (`attest` still requires `needs: publish` success) is spelled out there.
5. **[MED] Prune unreachable on cancel/timeout (P36)** — `:1244`. `steps.gate.outcome != 'success'`, with the
   three non-success outcomes enumerated at `:1197-1205`. The gate-`success` precision (never delete an
   image the anonymous-pull check later failed on) is unchanged.
6. **[MED] Prune exits 0 / untested against this package** — the control is unchanged, the *claims* are now
   honest: the gate's user-facing text says the next step **attempts** to prune and tells the reader to read
   its verdict (`:1141-1147`); the permission comment (`:1216-1225`) names the missing measurement and what
   would close it. Also added a third outcome so the error is not cried wolf: a lookup that succeeded and
   found nothing prints `::notice::nothing to prune` (`:1268-1290`) — needed because `published` now means
   "a push was attempted". All five paths executed against a stubbed `gh` (ok / empty / lookup-fail /
   delete-fail / owner-type-unknown) and each produced the intended verdict with `exit 0`.
7. **[MED] Digest-less dry run skipped the buildId comparison** — `:1078-1109`. The `unpinnable` branch now
   compares `actual_build_id` to `EXPECTED_BUILD_ID` and sets `fail=1` on mismatch; skipped only when the
   pin is the UNPINNED sentinel (where a mismatch is guaranteed and meaningless). The "FAIL vs WARN" comment
   above it (`:1066-1076`) and the closing line (`:1177`) were rewritten so nothing claims the pin was
   checked when only the digest verdict is withheld.
8. **[MED] Skipped `attest` ⇒ green run (P33/R3)** — new final job `attested` at `:1946-2015`:
   `needs: [publish, attest]`, `if: always()`, `permissions: {}`, fails when
   `published == 'true' && attest.result != 'success'`. Its message distinguishes the post-gate case (image
   live and unsigned — re-running IS correct here, explicitly contrasted with the gate's "Do NOT press
   Re-run") from the pre-gate case (prune already tried). Scope caveat (outputs from a failed job) written
   down at `:1962-1968`.
9. **[MED] Visibility URL assumed an org package while the header said user-owned** — `:1405-1412`. The URL
   is now derived from `IMAGE` (owner and package both), and the ownership contradiction is resolved at the
   source: the fork-guard comment now records that the package **moved to the org** (auditor item).
10. **[MED] Anonymous-pull check re-spelled the tag** — `:1331-1343` + `:1420-1424`. It consumes
    `steps.src.outputs.tag` and uses `${TAG##*:}`; 404 has its own arm that explicitly says "NOT a
    visibility verdict".
11. **[LOW] `repository_owner` green-by-silence** — behaviour kept (per the brief). `:187-192` now says the
    skip is not detectable from CI and rides the same scheduled org-App audit as the branch policy.
12. **[LOW] `docker login` before the build** — `:658-671`. No ordering change is available (the script owns
    the `--push`); the exposure is now stated next to the login, including why a `docker logout` would buy
    nothing and would break the gate's read-back before a visibility flip.
13. **[LOW] Dry arm used bare `jq -er` for buildId/gitSha/platform** — `:854-873` adds a `jq_field` helper
    that names the missing field on **stderr** (stdout is the value) and returns 1; used at `:937-939`.
    Executed: a null field prints the `::error::` and *then* dies, instead of dying bare.
14. **[LOW] Anonymous pull proved a tag manifest only** — `:1370-1424`. Three anonymous reads now: the TAG,
    the PINNED DIGEST, and one LAYER BLOB from the digest's manifest. One `verdict` classifier handles
    transport / 404 / not-public, with an explicit success arm first (a function ending on a false `[ ]`
    test returns 1 — executed both ways to confirm). The blob accepts `200 302 307` and deliberately does
    not follow the CDN redirect (curl re-sends `Authorization` cross-host; a signed URL plus that header
    answers 400, which would read as "not public").
15. **[LOW] Stale "workflow-scoped concurrency"** — `:1555-1562`. Restated as "all real publishes share the
    single `publish` group, and dry runs never reach this job".
16. **[LOW] Stale eventual-consistency / QEMU retry rationale** — `:1918-1932`. Both retired reasons are
    named as retired; the surviving reason is ghcr's referrers-index propagation, and the cost of a red run
    is stated as the ~30-minute publish job, not a QEMU rebuild.
17. **[LOW] `--signer-workflow` not ref-anchored** — documented at `:1879-1895` rather than changed, with the
    measured reason: `gh` refuses two identity flags at once — verified locally, *"if any flags in the group
    [cert-identity cert-identity-regex signer-repo signer-workflow] are set none of the others can be"* — so
    adding the regexp would DROP the workflow-path check on the one step that must not break. The comment
    points at the real ref anchor (`verify-image-pin.yml:345`) and tells consumers to copy that command.

### From `edge-workflow-publish.md`

18. **[HIGH] Post-gate failure leaves a pinned image unattested** — covered by the `attested` job (#8), which
    also carries the missing "a post-gate failure is the one case where Re-run is right" note.
19. **[HIGH] Three `imagetools inspect` reads with no failure arm** — gate read `:960-985` (5 attempts,
    5 s apart, then a named "REGISTRY READ FAILURE, not a pin verdict" refusal); `:1575-1590` and
    `:1803-1818` each get a named arm, and the `.digest`/`.mediaType` lifts are guarded in one `if !… || !…`
    so an output-shape change reports itself. The post-signing one says the signature already landed.
20. **[MED] Publish concurrency group cancels a pending pin-adoption run** — no fix available; documented as
    a residual at `:131-141` with both escapes refuted (concurrency is evaluated before `steps.src` exists;
    keying on `github.ref` would let dev and main race the same per-source-revision tag) and the operating
    rule written down (re-push the adoption commit).
21. **[MED] anon-pull tag re-spell / 404 as "not public"** — see #10.
22. **[MED] Cancel/timeout leaves the ungated tag** — see #5.
23. **[MED] Visibility URL owner type** — see #9.
24. **[LOW] Bare `jq -er` field reads** — see #13; the marker reads at `:1037-1038` go through `jq_field` too.
25. **[LOW] Duplicate cosign attestations** — documented at `:1763-1778` (cause, blast radius = registry
    clutter only, and why `--replace` is *not* passed: unmeasured against the bundle-as-referrer write path
    `--bundle-from-oci` depends on, and an unmeasured flag on the signing step can turn every publish red).
    Listed under cross-file needs as a measurement to take.
26. **[LOW] `attest`'s `contents: read`** — kept and justified in place (`:1508-1514`): it is what
    `sigstore/cosign-installer` uses to resolve the pinned release through the API. Dropping it was not
    worth risking the installer in the only `id-token: write` job.
27. **[LOW] Stale "cannot land here" reason** — see #15 (same site).
28. **[LOW] `RUNNER_ENVIRONMENT` unguarded under `set -u`** — `:1709`, now
    `${RUNNER_ENVIRONMENT:?…}` with a message naming what breaks.
29. **[LOW] `Classify a registry failure` had no `set`** — `:784-790`, `set -uo pipefail` with the same
    one-line justification the other two `-e`-less blocks carry.

### From `auditor-df210.md`

30. **Fork-guard comment claimed a user-owned package and an unmoved `IMAGE`** — `:190-199` rewritten: the
    package moved to the org, an org repo cannot push to a user-owned GHCR package, and an owner change is
    always a re-publish + re-pin.
31. **`environment:` claimed a server-side required-reviewer rule; `dry_run` description repeated it** —
    `:186-197` and `:56-71` / the input description at `:69`. Both now say deployment **branch policy**
    (dev/main) and state that no reviewer approval exists on this plan (HTTP 422).
32. **Header bullet said pruning ungated tags is "not something this workflow does"** — `:24-32` now points
    at the prune step and states its residual (only versions this run created; admin-permission failures
    stay a manual chore).

Also corrected in passing, because the round-6 changes would otherwise have left them false: the
`driver.ts`-in-`on.push.paths` comment (`:100-107`) now names the real cost (an idempotent re-publish plus
one more cosign referrer) instead of an approval that does not exist.

## False positives

- **[LOW, blind] "Build artifacts from a credential scan are uploaded on `if: always()`"** — the sweep
  summary carries no matched values. `SweepSummary` (`scripts/lib/license-sweep.ts:725-735`, built by
  `summarize()` at `:737-757`) is counts, package keys, `deniedHits` as `name@version @ depPath`,
  `piVersions`, `noticeBytes`, `sweptAt`, `exitCode` — no file content and no matched strings. The
  credential-scan findings never reach it: they go through `die(1, …)` to stderr, and the one finding that
  ever quoted content is redacted first (`redactAssignments`, `build-exedev-image.ts:1347-1367`). Nothing
  changed.
- **[LOW, edge] "A `dry_run: false` dispatch from a feature branch burns a human approval before the in-file
  refusal fires"** — there is no reviewer prompt to burn. The required-reviewer rule was measured
  unobtainable (HTTP 422, billing plan) and deliberately dropped; `publish-exedev` carries a deployment
  branch policy only, which blocks the dispatch *before* the job starts rather than paging anyone. The
  approval language that made this finding readable has been removed (#31). The underlying residual — the
  branch policy's removal is not detectable from CI — is unchanged and already documented at `:322-333`.

## Cross-file needs

None of these are in files I own; recorded rather than done.

1. **Exercise the prune's delete path once** (ops, not code): push a throwaway tag to
   `ghcr.io/quantum-digital-solutions/qds-exedev`, run the delete
   (`gh api --method DELETE orgs/quantum-digital-solutions/packages/container/qds-exedev/versions/<id>`) with a
   repo-scoped `GITHUB_TOKEN`, and record whether `packages: write` suffices or GHCR demands package admin.
   Until then the workflow's honest position is "attempts to prune"; if it 403s, either grant admin or stop
   promising a prune at all.
2. **Measure `cosign attest --replace` against the bundle-as-referrer write path** (cosign v3.1.3 + ghcr)
   before anyone adds it here. If it dedupes referrers, add it; if it is a no-op or errors under the new
   bundle format, keep the documented residual.
3. **The scheduled org-App drift audit** that both the environment branch policy and the
   `repository_owner` skip depend on is still not landed (tracked in-file at `:322-333`). Two controls are
   currently undetectable-on-removal because of it.
4. **`scripts/build-exedev-image.ts` docblocks** still credit `actions/attest-build-provenance` in two places
   (auditor MED) — owned by the build-script fixer, not me.
5. **Consumer/producer contract note:** the SLSA predicate now emits **two** `resolvedDependencies` entries
   (index 0 = image source revision, index 1 = `workflow-revision`). Anything downstream that reads
   `resolvedDependencies[0]` gets a *better* answer (the commit that reproduces the bytes) but anything that
   assumed a single-element array should be checked. `verify-image-pin.yml` verifies the bundle's signature
   and predicate type, not the predicate body, so no change is needed there today.

## Gates

```
$ bunx biome check .github/ 2>&1 | tail -5
Checked 1 file in 123ms. No fixes applied.

$ python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish-exedev-image.yml')); print('yaml ok')"
yaml ok

$ actionlint .github/workflows/publish-exedev-image.yml ; echo "exit=$?"
exit=0
(shellcheck 0.11.0 is installed, so actionlint linted every `run:` body through it — clean.)
```

Shell logic executed locally against stubs rather than reasoned about:

```
$ bash /tmp/t1.sh   # verdict(): success/redirect/404/403/transport arms
A ok
B ok
::error::manifest does not exist
C correctly failed
::error::manifest not public
D correctly failed
::error::transport manifest
E correctly failed
reached end with set -e alive
exit=0

$ bash /tmp/t3.sh   # jq_field(): names the field, THEN dies under set -e
before
::error::could not read gitSha in ev — jq said: null
exit=1

$ for m in ok empty lookupfail delfail nowner; do bash /tmp/t4.sh $m; done   # prune, three outcomes
::warning::pruned: deleted version 12345 (…:sha-deadbeef)
::notice::nothing to prune — no package version carries …:sha-deadbeef.
the versions listing failed: HTTP 403
::error::COULD NOT PRUNE — version : <unresolved; owner type [Organization]>
::error::COULD NOT PRUNE — version : 12345
::error::COULD NOT PRUNE — version : <unresolved; owner type [unknown]>
(all exit=0)

$ bash /tmp/t5.sh   # P32 case pattern
PASS   ghcr.io/quantum-digital-solutions/qds-exedev@sha256:92447929…
REFUSE ghcr.io/someone-else/whatever
REFUSE ghcr.io/quantum-digital-solutions/qds-exedev-evil
REFUSE ghcr.io/*

$ gh attestation verify … --signer-workflow … --cert-identity-regex …
if any flags in the group [cert-identity cert-identity-regex signer-repo signer-workflow] are set
none of the others can be; [cert-identity-regex signer-workflow] were all set
```

Diff re-read end to end (`git diff -- .github/workflows/publish-exedev-image.yml`); no `run:` block
indentation change beyond the added lines, and the whole file still parses as YAML.
