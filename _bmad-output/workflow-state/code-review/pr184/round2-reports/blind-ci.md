# Blind Adversarial Review — chunk-ci.diff (round 2)

Scope: diff only (`.github/workflows/publish-exedev-image.yml`, `.github/dependabot.yml`, `oci/exedev/binary-licenses.json`). Line numbers are diff-relative (numbered lines of /tmp/pr184-r2/chunk-ci.diff). The bootstrap-sentinel "publish then refuse" behavior is treated as intended; only its implementation coherence is challenged.

---

## F1 [HIGH] `2>&1` on the marker read feeds docker pull progress into jq, breaking the gate on its success path

Location: workflow diff lines 322–333 (gate step, `if ! marker=$(docker run --rm --entrypoint cat "$IMAGE@$actual_digest" /etc/qds-image.json 2>&1)`).

Claim: The new guard redirects stderr into `marker` to capture the `cat: No such file` reason for the failure arm — but on the SUCCESS arm the same redirect captures docker's own stderr chatter. When `$IMAGE@$actual_digest` is not already present in the local daemon (the gate explicitly reads back "from the REGISTRY, not from the local daemon", and an image pushed via buildx is not necessarily loaded under its registry digest), `docker run` emits `Unable to find image ... locally` plus pull-progress lines to stderr. Those lines are prepended to the JSON in `marker`, so `jq -er .buildId` (line 332) hits a parse error, `set -e` kills the step at the assignment, and the operator gets a bare jq error with none of the pushed/buildId/platform diagnostics — the exact anonymous-death failure mode this very hunk claims to have eliminated ("Every other failure arm in this step names itself; this one has to as well").

Concrete failure scenario: fresh runner, publish succeeds, digest matches the pin perfectly. Gate step pulls the image by digest, pull progress lands in `marker`, `jq -er .buildId` exits nonzero on invalid JSON, gate goes red with `jq: error ... Invalid literal` — a correct publish reported as a gate failure, and the printed "adopt these constants" recovery never appears. Whether it reproduces depends on daemon state, so it will also be flaky across runners, which is worse than deterministic.

## F2 [MEDIUM] The bootstrap branch asserts "nothing was compromised and nothing moved" about a digest it never verified

Location: workflow diff lines 340–346 (gate, `if [ "$UNPINNED" = "1" ]`), with lines 199–211 (pin step sentinel detection).

Claim: `UNPINNED=1` is derived solely from the repo-side sentinel. It says nothing about the registry-side `actual_digest`. Yet when the (guaranteed) mismatch occurs, the gate prints "nothing was compromised and nothing moved" and instructs the operator to adopt the constants below — which are read back from the registry (`$IMAGE@$actual_digest`, `$actual_build_id` from the pulled marker). The workflow cannot make the "nothing was compromised" claim: during the window between the push and the gate's read-back, anything that can mutate the tag (the attest comment at lines 457–466 enumerates exactly these actors: manual `docker push`, `crane copy`, registry-side retag) replaces the digest the gate reads.

Concrete failure scenario: bootstrap run pushes the image; an attacker (or a concurrent out-of-band repair) rewrites the `sha-<sha>` tag before the gate reads it back. The gate resolves the attacker's digest, prints it under an explicit "nothing was compromised" banner, and the operator — following instructions — commits the attacker's digest as `DEFAULT_IMAGE_REF`. The pin gate then goes green forever on a digest no review saw. The bootstrap is inherently TOFU; the message converts "unverified first trust" into an affirmative false assurance.

## F3 [MEDIUM] The sentinel digest is a second hardcoded spelling of the driver's `UNPINNED_DIGEST`

Location: workflow diff line 207 (`if [ "$digest" = "sha256:0000...0000" ]`), comment at lines 193–205.

Claim: The comment says the sentinel is "`UNPINNED_DIGEST` in $DRIVER", but the workflow compares against its own 64-zeros literal. This diff elsewhere lectures at length about exactly this hazard ("two hardcoded spellings of one package can diverge", lines 87–90) and then reintroduces it for the sentinel. There is no check that the two spellings agree.

Concrete failure scenario: the driver's sentinel is (or later becomes) any other well-formed placeholder — 64 f's, a truncated-then-padded value, a differently-cased constant. `unpinned` stays 0, the bootstrap run's guaranteed mismatch is reported through the ordinary "pushed image does not match the repo pin" arm, and the operator is sent "hunting a compromise" — the precise misdiagnosis lines 203–205 say this branch exists to prevent.

## F4 [MEDIUM] Pin parse takes the first regex match across the flattened file; a stale or commented constant shadows the real pin

Location: workflow diff lines 183–185 (`flat=$(tr '\n' ' ' ...)`, `grep -oE ... | head -1`), interacting with the gate's own printed adoption snippet at lines 350–353.

Claim: The driver is flattened to one line and the FIRST occurrence of `DEFAULT_IMAGE_REF = "..."` wins, whether it lives in code, a block comment, or a doc-string. The gate itself prints a paste-ready `export const DEFAULT_IMAGE_REF = "...";` block, inviting append-style adoption. Nothing in the parse distinguishes "the declaration" from "a mention".

Concrete failure scenario: an operator (or the next automated fix wave) performs pin adoption by pasting the printed block below the old constant, or a reviewer adds a comment containing the previous example ref above the declaration. `head -1` returns the stale digest, the gate compares against the wrong pin, and every subsequent run is red with a mismatch that no amount of re-pinning at the real declaration site fixes — the "do not keep re-pinning" advice at line 361 then actively points the operator away from the actual cause.

## F5 [MEDIUM] The repo-identity guard silently disarms the whole pipeline on rename/transfer — green-by-skip

Location: workflow diff line 111 (`if: github.repository == 'Quantum-Digital-Solutions/QDS-Factory'`).

Claim: The guard is justified as a fork fast-fail, but it string-matches the canonical repo name. A rename or org transfer makes the condition false in the canonical repo itself. The job is then *skipped*, not failed — no red run, no annotation, nothing. Every downstream job (including attest) skips with it. The digest gate, the license sweep, the publish, and the signing all stop happening, quietly, on every push that used to trigger them.

Concrete failure scenario: the repo is renamed (or `biospark33` becomes an org). Pushes to `dev` touching `oci/exedev/**` show a skipped workflow — which reads as "nothing to do" — while the image and pin drift apart with no early-warning signal. The one guard whose failure mode should be loud has a failure mode of silence.

## F6 [MEDIUM] NOTICE collection rests on an unenforced cross-file constant that this very diff changes, backed by `if-no-files-found: warn`

Location: workflow diff lines 94–99 (`BUILD_DIR: oci/.build/exedev`, comment "MUST equal BUILD_DIR in scripts/build-exedev-image.ts") and lines 436–446 (named-path upload, `if-no-files-found: warn`).

Claim: The NOTICE — described in this same diff as "the DF2.9 attribution artifact" and in binary-licenses.json as feeding "the legal artifact" — is collected only from a directory whose equality with the build script's internal constant is asserted by comment, not by any check. The diff changes the workflow's value (from `oci/exedev/.build` to `oci/.build/exedev`) — i.e., it performs exactly the divergence event the comment warns about, and a blind reader cannot confirm the script side matches. If it doesn't, the upload finds nothing at `$BUILD_DIR/NOTICE` and emits a *warning*, which fails nothing.

Concrete failure scenario: the script's BUILD_DIR differs (or moves later, with only one side updated). Every publish run "succeeds" while the NOTICE — the artifact whose collection is the stated reason this upload step exists — is silently absent from every artifact bundle. `warn` guarantees nobody notices until the attribution artifact is actually needed, which is the one moment it must exist.

## F7 [MEDIUM] `package.json` as trigger + SOURCE_PATH makes red gate runs a weekly routine and teaches operators to ignore the tamper signal

Location: workflow diff lines 125–135 (SOURCE_PATHS rationale), line 159 (SOURCE_PATHS array), lines 363–368 (gate message: "A moved digest here is not evidence of tampering").

Claim: The stated digest input is one field (`packageManager`), but the whole file is a SOURCE_PATH, so every dependabot npm bump — explicitly weekly — moves `src_sha`, rebuilds, pushes a new publicly-pullable unsigned `sha-<sha>` tag (which lines 49–52 admit nothing prunes and nothing references), and *guarantees* a red gate run requiring the manual re-pin ritual. The gate's mismatch message now closes with "A moved digest here is not evidence of tampering." The gate's entire security purpose (line 42: catch "an image no review saw") depends on a mismatch being alarming; this change makes mismatch the weekly steady state and adds text instructing the reader to discount it.

Concrete failure scenario: after a month of routine dependabot-induced red runs, a genuinely unexplained digest mismatch arrives. The on-call operator, conditioned by weekly reds and by the message's own "not evidence of tampering" line, runs the adoption ritual and pins the moved digest without investigation. The gate still "works" mechanically while its alarm value has been spent. The comment accepts the re-pin cost but never accounts for the desensitization cost or the unsigned-tag accumulation it converts from exceptional to weekly.

## F8 [MEDIUM] Re-run semantics: fixed artifact name + `if: always()` collides on re-run attempts — and the diff's own recovery text says "re-run"

Location: workflow diff lines 436–446 (upload step, name `exedev-image-publish-${{ github.sha }}`, `if: always()`), with lines 410–413 (visibility step: "re-run this workflow") and line 343 ("Adopt the constants below and re-run").

Claim: `actions/upload-artifact@v4` artifacts are immutable per workflow run; a duplicate name across re-run attempts of the same run is rejected. Because the upload runs `if: always()`, attempt 1 uploads on every outcome — so any "Re-run failed jobs" attempt 2 reaches the upload with the name already taken and fails there. This diff's newly added error texts explicitly prescribe re-running (transport failure in the visibility step; the bootstrap adoption message).

Concrete failure scenario: the visibility check hits a transient ghcr transport failure and prints "re-run this workflow. Do NOT change the package's visibility settings." The operator re-runs failed jobs; publish, gate, and visibility all pass on attempt 2; the always-on upload then 409s on the duplicate artifact name, the publish job goes red anyway, attest is skipped, and the image ends up published, gated, but unsigned — from following the workflow's own instructions.

## F9 [LOW] `IMAGE_PATH` env removed with only one migrated consumer visible in the diff

Location: workflow diff line 85 (deletion of `IMAGE_PATH: biospark33/qds-exedev`); replacement derivation at lines 379, 391, 407 (visibility step only).

Claim: The diff deletes a workflow-level env var and shows exactly one step migrated to the derived `image_path`. Any other reference to `$IMAGE_PATH` elsewhere in the file (or `${{ env.IMAGE_PATH }}` in an expression) is outside this diff and would now expand to empty (silently, in expressions) or die as unbound (under `set -u`, in shell).

Concrete failure scenario: a step outside the shown hunks (e.g., anything in the attest job addressing the ghcr HTTP API) still reads `IMAGE_PATH`; expression contexts substitute empty string, producing a request against `https://ghcr.io/v2//manifests/...` that fails with a status the surrounding diagnostics misattribute. Blind, this is unprovable either way — which is itself the finding: the diff does not demonstrate the deletion is safe.

## F10 [LOW] "Adopt the constants below and re-run" is ambiguous between a new push and a same-run re-run, and the same-run reading loops red

Location: workflow diff lines 341–343 (bootstrap adoption message), interacting with lines 69–77 (driver.ts trigger path).

Claim: The convergence design requires the adoption *commit's push* to trigger the healing run (that is why driver.ts was added to `on.push.paths`). But the printed instruction says only "re-run". Re-running the SAME run checks out the old sha, re-reads the sentinel driver, and fails identically — forever, per attempt (and per F8, the re-run also collides at the upload step).

Concrete failure scenario: operator commits the pin on a branch (or pushes to a branch the workflow doesn't trigger on), then presses "Re-run failed jobs" on the red bootstrap run expecting green. Sentinel again, red again; nothing in the message distinguishes this from the "third digest / not reproducible" case two paragraphs earlier, which then sends them chasing a reproducibility bug that does not exist.

## F11 [LOW] `|| true` on the `tr` read folds an existing-but-unreadable driver into the "renamed constants" diagnosis

Location: workflow diff lines 178–185 (pin step: `[ ! -f "$DRIVER" ]` guard, then `flat=$(tr '\n' ' ' < "$DRIVER" || true)`).

Claim: The new guard checks existence (`-f`) but not readability. If the file exists and the read fails (permissions, I/O error), `|| true` swallows it, `flat` is empty, and the empty-value guard fires with the "Expected two module-level constants (DF2.10 AC3)" message — asserting the constants were renamed or removed when they are intact and unreadable. The hunk's own comment celebrates making "the guard run"; it runs, with the wrong verdict, and the actual `tr` error was discarded.

Concrete failure scenario: a checkout/permissions anomaly on the runner makes `$DRIVER` unreadable. The operator is sent to verify constant names that are fine; the one line of stderr that named the real cause was suppressed by the `|| true` this diff added and defends at length.

---

11 findings: 1 HIGH, 7 MEDIUM, 3 LOW. No shell-injection findings: all new `${{ }}` uses flow through `env:` or non-shell contexts, and the derived `image_path`/hex `github.sha` values are injection-inert as used.
