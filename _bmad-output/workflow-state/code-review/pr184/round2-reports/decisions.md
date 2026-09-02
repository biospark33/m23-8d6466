# PR #184 round-2 — challenge of the six "resolved conservatively" decisions

Scope: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md` §"Decision-needed — resolved conservatively" (lines 381–401), verified against `src/providers/exedev/driver.ts`, `src/providers/exedev/transport.ts`, `scripts/build-exedev-image.ts`, `.github/workflows/publish-exedev-image.yml`, `oci/exedev/Dockerfile`, `/Users/steve/QDS-Factory/.dockerignore`, `tests/providers/exedev/image-contract.test.ts`. Read-only; no full test run.

Scoreboard: 3 RIGHT · 3 RIGHT-BUT-INCOMPLETE · 0 WRONG. Nothing above LOW severity. All incompleteness is one-string/doc-level; nothing blocks merge.

---

## Decision 1 — the tag is a digest input (kept) — **RIGHT-BUT-INCOMPLETE** (LOW)

**Factual basis verified.** `scripts/build-exedev-image.ts:1484` passes `--build-arg QDS_IMAGE_REF=${opts.tag}`; `oci/exedev/Dockerfile:259,282` bakes it into `/etc/qds-image.json`, which is layer content, so the digest is a function of the tag. `deriveBuildId` (script:475) deliberately excludes it — the docblock at :471–473 says exactly why ("a buildId that changes when the substrate did not is a buildId that proves nothing"). The workflow's mismatch message (workflow:540–546) does name the cause ("BEFORE assuming the image content changed: the TAG is a digest input… A moved digest here is not evidence of tampering"), as the decision claims. #187 tracks the fix at the DF1.10 re-pin seam. Keeping the live-booted pin over a mid-PR invalidation is the correct conservative call.

**The incomplete part: one of the two recorded reversal options is a footgun.** The decision offers "removing the ref from the marker **or adding the tag to `deriveBuildId`**". The second option is wrong on its own terms: the publish tag is `:sha-<src_sha>` (workflow:229), so folding it into `deriveBuildId` makes `DEFAULT_IMAGE_BUILD_ID` change on **every source commit**, destroying the "buildId proves substrate, not build" invariant that script:471–473 states and that gate B depends on — a mirror or a re-tag would then fail gate B, breaking decision 4's D7 posture too. Only "remove the ref from the marker" (#187's direction) is a valid reversal, and it is not one line either: Dockerfile jq + `parseImageMarker`'s required-keys list (`transport.ts:265`) + the `QdsImageMarker` type + tests + a mandatory re-pin. The section's "each is a one-line change" header does not hold for this item — the item's own text half-admits this ("both invalidate the pin"), so this is doc-drift, not a wrong decision.

**Correct resolution:** strike "adding the tag to `deriveBuildId`" from the reversal text (or mark it rejected); #187 already carries the real fix. Blast radius: one line of story prose.

---

## Decision 2 — push precedes the gate (kept) — **RIGHT-BUT-INCOMPLETE** (LOW)

**The resolution is fail-safe:** production boots only `DEFAULT_IMAGE_REF` (driver.ts:256), the pin only moves via a reviewed commit, and the gate (workflow:435–549) reads the digest back **from the registry** post-push, which is the strongest read. The acknowledged cost (unreferenced per-revision tags in a public package) is real and benign.

**The stated reason is factually false by the repo's own code.** Workflow:18 asserts "a digest cannot be compared before it exists, so `--push` has already happened by the time the gate reads it back." But the build script's second exporter exists precisely to refute this: script:~1527 `--output type=image,name=…` is documented as "**Not pushed — this export exists to make the manifest digest MEASURABLE on every run** … a local `bun scripts/…` run can prove two builds agree **without a registry to push at**", and the pin comment (driver.ts:229–238) records that two local pre-push builds and the eventual registry read-back all agreed on `sha256:a70674b2…`. So the manifest digest exists and is comparable **before** any push. A gate-before-push design is implementable with the machinery already present: run the script without `--push`, compare `builtDigest` (evidence JSON, "the manifest digest the build produced BEFORE any push") to the pin, and on match re-invoke with `--push` — the script's own `buildxArgs` comment says "Publishing re-invokes this with a pushing output; BuildKit answers it from cache and exports the bytes the gates already read." Bootstrap still works (sentinel run pushes and fails the gate by design, workflow:288–304); the post-push registry read-back can stay as a second assert.

**Judgment:** keeping push-first is an acceptable conservative resolution (the pin, not the gate, protects production; pre-gating would only save junk tags and avoid publicly publishing a mismatched artifact under a `sha-` tag). But the corrected comments still overclaim an impossibility that the sibling script disproves — the honest reason is "pre-push gating buys little and push-first keeps the bootstrap ritual one-pass." Fix the comment now; consider the pre-push compare when #187/DF1.10 reworks this file anyway. Blast radius: comment text, or ~15 workflow lines if pre-gating is adopted.

---

## Decision 3 — `--image` unconditional where AC3 said "conditional" (kept, wording corrected) — **RIGHT-BUT-INCOMPLETE** (LOW)

**Always-pinned is right, and the "removed escape hatch" is illusory.** Verified: the constructor always assigns `this.image = opts.image ?? DEFAULT_IMAGE_REF` (driver.ts:480) and `create()` spreads `--image` unconditionally (driver.ts:629–636). A conditional spread's only new capability would be booting the substrate default image — which carries no `/etc/qds-image.json`, so gate B0 refuses the box anyway (`imageMarkerFailure`, transport.ts:281+; fail-closed by design). The "escape hatch" would produce a box that boots and then dies at the gate: a trap, not a hatch. AC3's story text was corrected to match (story:190 now reads "passes `--image` (and optionally `--registry-auth`)"), so decision text and code agree.

**What actually happens today if the pinned digest 404s at `ssh exe.dev new`:** the host-side pull fails, `control()` returns non-zero (or throws), and `create()` throws `create-failed` with remediation **"re-run; the VM may not exist — confirm with `ssh exe.dev ls --json`"** (driver.ts:648–649, 664–665). Re-running cannot fix an unpullable digest.

**A documented no-code-edit path DOES exist — at a different seam.** `exeDevDriverFromEnv` (driver.ts:1155–1219, registered as the production factory at `src/providers/index.ts:138`) honors `QDS_EXEDEV_IMAGE` + `QDS_EXEDEV_IMAGE_BUILD_ID` (both-or-neither enforced, :1170–1178, with a remediation that names where the buildId comes from), so the operator can: `crane copy` a mirror (digest-preserving, per driver.ts:218–221 and the story's D7 paragraph) or rebuild via `bun scripts/build-exedev-image.ts` (which prints the buildId), point the env pair at it, and gate B passes on buildId per decision 4. Tag-pinned overrides are admitted and announced via the `image_not_digest_pinned` warning event (driver.ts:514–518).

**The incomplete part:** the recovery is documented only in the env-factory docstring and the both-or-neither refusal — **not at the failure site**. An operator staring at `create-failed … exited N` after a registry outage gets a remediation ("re-run") that cannot help, and nothing routes them to the env pair. Also unverified (needs the live substrate): whether exe.dev's `new` actually exits non-zero on an unpullable `--image` or names a VM that never boots — if the latter, the failure surfaces as a gate-A timeout, even further from the recovery docs.

**Correct resolution:** extend `create()`'s `create-failed` remediation with one clause, e.g. "…if the failure is an image pull, mirror the pin (`crane copy`) and set QDS_EXEDEV_IMAGE + QDS_EXEDEV_IMAGE_BUILD_ID". Blast radius: two remediation strings in driver.ts + the tests asserting them. Optionally have a live round record the actual `new --image <bad digest>` failure shape.

---

## Decision 4 — gate B does not compare `marker.imageRef` (kept, pinned by test) — **RIGHT**

**Verified:** `transport.ts:359–367` compares only `buildId` and explicitly documents "`marker.imageRef` is REPORTED, never compared (triage Q-4, deliberate)"; the pinning test exists and asserts the pass (`image-contract.test.ts:1143` — "a mismatched ref with the right buildId PASSES", constructing `harbor.acme.internal/mirror/qds-exedev:tenant-copy`), and its comment records why comparing would break the D7 mirror.

**What this leaves open, enumerated:**
1. **The #187 case — same buildId, N digests.** Because the tag is a digest input (decision 1), the same source tree published under different tags yields distinct digests with one buildId. A box booted from the hand-pinned `:df2-10`-era digest is indistinguishable at gate B from one booted from the workflow's `:sha-…` digest. Materially the bytes differ only in the marker's `imageRef` string, so the substrate risk is nil; the cost is bookkeeping — gate B cannot tell *which artifact* booted, only *which source*.
2. **The structural fact the stated reason under-states:** the marker is box-reported content. A malicious or hand-rolled image can claim **any** buildId *and* any ref, so comparing the ref adds zero adversarial power — gate B is an honest-box misconfiguration detector, not an attestation. Byte identity is enforced only by the host-side digest pull, which is exactly why the `image_not_digest_pinned` warning (driver.ts:514) fires when the effective ref is tag-pinned.

**Judgment:** the decision is right and now correct in the strongest sense — executable (the test) rather than prose. Comparing the ref would refuse legitimate mirrors and catch nothing an adversary couldn't forge. The one wording nit: transport.ts's "the buildId is the identity assertion" overclaims — buildId asserts *source* identity, the digest pull asserts *artifact* identity; #187 (remove the ref from the marker so digest becomes deterministic per source) is the fix that collapses the residual, and it is already filed at the right seam. No action beyond #187.

---

## Decision 5 — `scripts/build-exedev-image.ts` stays in `SOURCE_PATHS` (kept) — **RIGHT**

**Verified the premise:** the root `/Users/steve/QDS-Factory/.dockerignore` excludes `scripts` from the build context (context is `REPO_ROOT`, script:1504–1510), so the script's *bytes* never enter the image. But `SOURCE_PATHS` (workflow:213) gates **which revision's `src_sha`/`src_epoch` stamp the artifact** — the tag `:sha-<src_sha>`, `SOURCE_DATE_EPOCH`, and `QDS_GIT_SHA` all derive from it — and the script determines the image bytes through argv, not context: `BUN_VERSION`/`PI_VERSION` build args, `SOURCE_DATE_EPOCH`, `--provenance=false --sbom=false`, `rewrite-timestamp=true`, the marker build args (script:1479–1502). Remove it from `SOURCE_PATHS` and a script edit that changes any of those builds **different bytes stamped with an old revision's gitSha and epoch** — the marker lies about provenance and the gate mismatch presents as "the digest moved again" with the true cause invisible. That is precisely the artifact-drift class the pin exists against.

**Cost, precisely stated:** a comment-only script edit moves `src_sha`, hence the tag (a digest input, decision 1) **and** `src_epoch` (also a digest input) — so the cost is not merely a spurious CI run, it is a **forced re-pin ritual** per script touch. The workflow documents this trade in place (:190 "Over-triggering is the safe direction", :202–204 names the mirror-image cost of the workflow file itself being left out). The ritual converges in one commit by design (driver.ts is trigger-only, :64–72). Cost < risk holds: a bounded, self-explaining re-pin vs. silently mis-attributed artifact bytes. Note the cost shrinks but does not vanish after #187 (epoch remains a digest input). An optional refinement — hoisting the digest-relevant constants into a tiny file and gating on that — is churn for little; not recommended now.

---

## Decision 6 — AC5 coverage tightened from path to path+content — **RIGHT**

**Verified:** `listExecutables` (script:1219+) emits `path → sha256` via in-container `find … -exec sha256sum +`, fail-closed on non-zero exit, unparseable lines, and empty output; the diff is `const added = [...builtBins].filter(([p, sha]) => baseBins.get(p) !== sha)` (script:~1671) — path present in base with different bytes now enters `added`. Failure direction is strictly "more binaries need attributing". The base is addressed by the same digest the buildId hashed, so the control subtracts the right bytes. The measured claim checks out in structure: `addedBinaries` is recorded in the evidence JSON (script:1787), and the recorded reason pi is absent (base already ships 0.84.4, `PI_VERSION` pins 0.84.4, byte-identical reinstall) is consistent and — critically — degrades safely: the day `exeuntu update pi` produces non-identical bytes, `added` grows and the build fails toward attribution, never away. Reversal genuinely is one line (revert the filter to `!baseBins.has(p)`). The known ceiling (basename matching in `uncoveredBinaries`) is separately pinned and tracked as #188. Decision text matches code exactly.

---

## Actions (all LOW, none blocking)

| # | Decision | Action | Blast radius |
|---|---|---|---|
| 1 | D1 | Strike "adding the tag to `deriveBuildId`" as a reversal option in the story (it churns buildId per commit and breaks the D7 mirror posture) | story prose only |
| 2 | D2 | Correct workflow:18's "cannot be compared before it exists" (the script measures the digest pre-push by design); optionally adopt pre-push compare when DF1.10/#187 touches this file | comment, or ~15 workflow lines |
| 3 | D3 | Add the env-pair mirror recovery to `create-failed`'s remediation strings (driver.ts:649, 665); have a live round record exe.dev's actual failure shape for an unpullable `--image` | 2 strings + their tests |
