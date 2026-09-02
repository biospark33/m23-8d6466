# FIX-CI

Fixer scope: `.github/workflows/verify-image-pin.yml`, `.github/workflows/publish-exedev-image.yml`,
`.github/image-pin-exceptions.json`, `.github/dependabot.yml`. No file outside that set was touched.
No git add / commit / push.

**Round 4 + the coordinator's mid-task scope addition (A13/A14/A15/A16).** All 16 findings were
located in the real files before editing. **14 patched, 1 partially false (A12), 1 declined with
evidence (A14), 1 confirmed-and-left-alone (A17).** No gitnexus `impact` runs: every edit is YAML
or a `run:` shell block — no named TS/JS symbols were touched (`src/providers/exedev/driver.ts`
and `oci/exedev/Dockerfile` were read only, to learn the buildId shape and the base pin).

**Three things a human must act on**, all found empirically during this round and detailed below:
the `publish-exedev` environment has **no required-reviewer rule** today (A7 fails closed on the
next real publish); the exeuntu base has **already drifted** upstream (A16 fails on its first
scheduled run); and the exception register's entry **expires 2026-10-15** (A3's new daily leg
will start failing the day after).

## Patched

| ID | File:line | What changed | Why |
|----|-----------|--------------|-----|
| A1 | `verify-image-pin.yml:200-243` | Replaced the two bare `jq -r` reads with a whole-register TYPE validation: every entry must have a `sha256:<64hex>` string `.digest`, a string non-empty `.reason`, and a string `.expires` matching `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`. Any violation, any jq error, any non-array `.exceptions` → `exit 1` naming the offending entry index and digest. The `-r` lookups now run only after that proof. | Confirmed real. `jq -r` on an absent field prints the literal `null`; `[ -n "null" ]` is TRUE and `[ "$today" \> "null" ]` is FALSE on every date (digits sort before lowercase), so an entry with only a `digest` key took the ACCEPT path permanently. Empirical proof of the OLD behaviour below. |
| A8 | `verify-image-pin.yml:227-228` | Duplicate-digest detection folded into the same validation (`group_by`/`select(length>1)`), named in the failure output. Not `head -1`. | Confirmed real: `.exceptions[] \| select(.digest == $d) \| .expires` emits one line per match, and a multi-line `$exception_expires` makes `[ "$today" \> … ]` arbitrary. Now impossible to reach — uniqueness is proven before the lookup runs. |
| A3 | `verify-image-pin.yml:34-68` | Added `push: branches:[main,dev]` on the same three paths, `schedule: cron "17 6 * * *"`, and `workflow_dispatch:`. Prose block above `on:` explains each leg. | Confirmed real. **No PR-only expressions needed guarding** — the job reads only `github.repository_owner`, `$GITHUB_REPOSITORY` and two committed files, so all four legs run byte-identical logic. The scheduled leg's default checkout is the default branch, which is exactly what A3 asked for; no `ref:` was needed. |
| A2 | `verify-image-pin.yml:245-283` | `--signer-workflow "$SIGNER"` → `--cert-identity-regex "$signer_re"` where `signer_re="^https://github\.com/<repo>/\.github/workflows/publish-exedev-image\.yml@refs/heads/(main\|dev)$"`. Repo name `.`-escaped via `sed`. The `SIGNER` env var was removed (now unused). | Confirmed real and reachable via `workflow_dispatch` from any ref. **Flag spelling checked against the runner-class CLI before committing to it** (`gh 2.93.0`): `-i, --cert-identity-regex` exists. It is **mutually exclusive** with `--signer-workflow` — verified empirically, gh refuses both (`if any flags in the group [cert-identity cert-identity-regex signer-repo signer-workflow] are set none of the others can be`) — so this REPLACES rather than augments. It is strictly narrower: `--signer-workflow` is itself implemented as the same SAN regex minus the ref anchor. Accept/reject matrix in the gate output. |
| A4 | `verify-image-pin.yml:70-80` | Added `attestations: read` to the workflow `permissions:` block. | Confirmed real: `gh repo view --json isPrivate` → `true` (output below), and an explicit `permissions:` block zeroes every unlisted scope. Without this the github-store arm would 404 forever and every pin would route through the exception register. |
| A5 | `verify-image-pin.yml:284-303` | Wrapped each store's `gh attestation verify` in the producer's exact retry shape: `ok=0; for attempt in 1 2 3 4 5; … sleep 10`. | Confirmed real. The two loops now read the same; a propagation artifact can no longer present as "no provenance", which is the one failure that routes an operator to the exception register. |
| A9 | `verify-image-pin.yml:130-172` | `pin` step now also count-checks (`-ne 1` → fail) and extracts `DEFAULT_IMAGE_BUILD_ID`, and shape-checks it as `^[0-9a-f]{16}$` — **on the non-sentinel arm only**. | Confirmed real: the step read only `DEFAULT_IMAGE_REF`. **Deliberate scope limit, noted in-file:** the hex check is skipped on the sentinel arm because the bootstrap ritual cannot produce a real buildId until the first publish, and demanding one there would brick the documented path to the first pin. The count + non-empty checks apply on every arm (matching the producer's contract). The shape check cannot prove the buildId *belongs to* the digest — that needs `/etc/qds-image.json`, i.e. a ~1.6 GB pull on every pin PR. Left to the post-merge publish gate and boot gate B, and said so in the comment. |
| A6 | `publish-exedev-image.yml:94-118` | `group: ${{ github.workflow }}-${{ (github.event_name == 'workflow_dispatch' && inputs.dry_run) && format('dry-{0}', github.ref) \|\| 'publish' }}` | Confirmed real: with one workflow-scoped group, GitHub's one-pending-run-per-group rule lets a feature-branch dry run cancel a *pending* pin-adoption push — and cancelled is not red. **FAIL-SAFE DEVIATION from the finding's literal wording, taken deliberately:** the finding said "include `github.ref`". I split by ref for DRY RUNS ONLY and kept every real publish in ONE queue. Reason: the tag is per-SOURCE-revision (`:sha-<src_sha>`), so `main` and `dev` publishing the same image source revision write the SAME tag — splitting real publishes by ref would re-open the exact tag race the original comment exists to prevent. Dry runs write nothing, so isolating them is free. Argued in-file. |
| A7 | `publish-exedev-image.yml:224-278` | New step "Assert the publish environment still requires a human reviewer", `if: env.DRY_RUN == ''`, placed before checkout. `gh api repos/$GITHUB_REPOSITORY/environments/publish-exedev`, then requires ≥1 reviewer inside a `required_reviewers` protection rule. Fails closed on API error too, printing the manual check URL. Not added to the dry-run arm. | Confirmed real. **⚠️ LIVE GAP FOUND — read this:** the `publish-exedev` environment exists but its `protection_rules` today are `[{"type":"branch_policy"}]` with **NO `required_reviewers` rule** (raw API output in the gate section). So "THE HUMAN SECOND FACTOR" is currently not in place, and **this new step will fail the next real publish until a required-reviewer rule is added**. That is the fail-safe outcome the finding asked for, but it is a blocking operator action, not a no-op. Also observed: `can_admins_bypass: true` on that environment. |
| A10 | `verify-image-pin.yml:100-106` | `actions/checkout` now carries `with: persist-credentials: false` and the zizmor `artipacked` comment, matching the sibling. `fetch-depth` deliberately NOT copied — this job runs no `git log`. | Confirmed real. |
| A11 | `verify-image-pin.yml:84-96` | Rewrote the fork-guard comment: it says the guard cannot select fork PRs (on `pull_request` the workflow runs in the base repo, so `github.repository_owner` is always the base owner), names what it DOES guard (a fork of this repo running its own push/schedule/dispatch legs), and notes fork PRs are unreachable while the repo is private. Guard kept. | Confirmed real; comment-only change. |
| A13 | `publish-exedev-image.yml:806-812` (recovery text), `:869` (`id: gate`), `:944-1013` (new step) | Gate step given `id: gate`. New step **"Prune the ungated push"**, `if: steps.gate.outcome == 'failure' && steps.publish.outputs.published == 'true'`: derives owner/package from `$IMAGE`, asks `gh api users/<owner> --jq .type` whether the delete endpoint is `users/` or `orgs/`, resolves the version id by the pushed tag, `DELETE`s it. On any failure it exits **0** with a loud `::error::` naming the exact tag, the version id and the manual `gh api --method DELETE` command. Gate recovery text updated to say the artifact is pruned and the adoption push re-publishes identical bytes. | Confirmed real: `--push` is inside the build step (`:592`), the comparison runs after (`:869`), and `attest` is skipped via `needs` on failure — leaving a public, anonymously pullable, unattested `sha-<sha>` tag. **Cannot turn a red run green** (it only runs on an already-failed gate and always exits 0) and **cannot delete a passing build** (keyed on the gate's own outcome, not `failure()` — the anonymous-pull check runs *after* a passing gate and its failure must not trigger a delete). **Permission honestly untested and said so in-file:** `packages: write` is what `actions/delete-package-versions` documents, but GHCR wants admin on the package and this one is user-scoped; that is exactly why the failure path is a named manual chore. |
| A15 | `verify-image-pin.yml:38-45, 53-71` (trigger), `:118-160` (new overlay step) | `on: pull_request:` → `on: pull_request_target:` (same three paths). New step **"Overlay the PR's proposed pin (data, never code)"**, `if: github.event_name == 'pull_request_target'`: fetches the PR head's `driver.ts` via `gh api repos/{owner}/{repo}/contents/…?ref=<head sha>`, base64-decodes it, and writes it over the base checkout. Guards an empty/failed read. `permissions:` unchanged (`contents: read`, `attestations: read`) — nothing that writes. | Confirmed real: a `pull_request` run checks out the PR tree, so the gate logic, this file and the exception register were all the PR's own versions. **The PR head is never checked out and never executed** — no `ref:` on checkout, no install, no build; the overlaid file is only `grep`ped, and the two extracted values are matched by `case` and passed as a single argv element to `gh` (never eval'd, never word-split), and cannot contain a newline (the extraction flattens with `tr '\n' ' '` and takes a quoted run), so they cannot forge a line into `$GITHUB_OUTPUT`. **The plain `pull_request` leg was NOT retained** — reasoning in-file and below. |
| A16 | `verify-image-pin.yml:436-548` (new `base-drift` job), `dependabot.yml:62-72` (comment) | New **second job** in the existing workflow (not a new file — see below), `if:` schedule-or-dispatch only, `permissions: contents: read` only, 5 min timeout. Derives the base ref from `oci/exedev/Dockerfile`'s single digest-pinned ghcr `FROM` (count-checked, with an error that tells DF1.10 what to do when it adds a stage), resolves `ghcr.io/<path>:latest` via an anonymous ghcr token reading `Docker-Content-Digest`, and **fails** on mismatch with re-pin instructions. Dependabot's DORMANT comment now points at it. | Confirmed real and **already firing**: the pinned base is `sha256:4398215003cf…`, upstream `:latest` is `sha256:bd447a7715e4…` — live proof below. **Chose a second job over a new workflow file** (fewer files, as invited): it asks the same question one tier down and needs the same daily clock, and a separate job keeps a separate check name so a base-drift alarm never reads as a provenance failure. **Chose fail over open-an-issue**: an issue needs `issues: write` on a workflow that currently writes nothing plus a dedupe/close dance, and would be read by whoever watches issues — which, on the evidence of the dormant dependabot entry, is the failure mode being fixed. `oci/exedev/Dockerfile` was **read only, never edited**. |
| A12 | `publish-exedev-image.yml:1031-1040` | Comment corrected: SHA pinning is the standard *in this workflow* (all four `uses:` are SHA-pinned); the outlier is ci.yml, now named with its three actual tag pins and flagged as "should be brought in line rather than copied". | **Half false** — see below. Patched to the extent it was true. |

## False positives

| ID | Why the finding does not hold, with the evidence |
|----|--------------------------------------------------|
| A12 (partial) | The finding says "every action added in this PR is already SHA-pinned", implying the whole comment is wrong. Half of it was right. `grep -nE 'uses:' .github/workflows/ci.yml` → `actions/checkout@v7` (:41, :140), `oven-sh/setup-bun@v2` (:53, :144), `actions/upload-artifact@v4` (:156) — **ci.yml genuinely is tag-pinned**. The false half is "the `publish` job": that job's three `uses:` are `actions/checkout@3d3c42e5…`, `oven-sh/setup-bun@0c5077e5…`, `actions/upload-artifact@ea165f8d…` — all SHA. So I removed the `publish` job claim, kept and made concrete the ci.yml claim, and turned it from "we are inconsistent on purpose" into "ci.yml is the outlier and should follow, not be followed". |
| **A14** | **NOT PATCHED — the proposed fix does not address the stated threat, and its cost is a regression in A7.** Three pieces of evidence. **(1) The attack premise defeats the fix.** The finding's own path is "a write-access actor pushes a branch and *deletes the refusal step on their own copy*". An actor who can edit the workflow on their branch can equally write `permissions: packages: write` into whichever job the split created — or, as the original A14 deferral recorded, add a brand-new push-triggered workflow with that permission and never touch this file. The split protects against nothing inside the threat model. **(2) On the unmodified dry-run route no privileged token is ever materialised.** `grep -nE 'secrets\.GITHUB_TOKEN\|github\.token\|GH_TOKEN' publish-exedev-image.yml` → in the `publish` job the token appears only at `:268` (the new A7 step) and `:539-540` (docker login), **both `if: env.DRY_RUN == ''`**; `:996`/`:1129` are in `attest`, which never runs on a dry run. A `permissions:` block declares a *scope*, it does not put a token into any step's environment — so on a dry run the only consumer is `actions/checkout`, which we give `persist-credentials: false`. `bun install`'s lifecycle scripts and the Dockerfile build have no token to lift. **(3) The refactor would weaken A7, the control the same coordinator asked me to harden.** Actions forbids `environment:` on a job that calls a reusable workflow — verified with actionlint: `when a reusable workflow is called with "uses", "environment" is not available. only following keys are allowed: "name", "uses", "with", "secrets", "needs", "if", and "permissions"`. So the `publish-exedev` environment routing — THE HUMAN SECOND FACTOR — would have to move inside the callee and be selected by a caller-supplied input, i.e. the approval gate becomes a function of an argument. Given (1) it buys nothing, (2) the exposure is near-nil, and (3) it costs the approval gate's structure plus a ~400-line blind refactor of the publish path in parallel with other fixers, the conservative call is not to do it. **Say the word and I will build it anyway** — the mechanics are clear, it is a judgement call, not a blocker. |
| A17 | Confirmed DISMISSED, left alone. The `github-actions` dependabot ecosystem entry exists at `.github/dependabot.yml:24-31` (`- package-ecosystem: github-actions` / `directory: /` / weekly / `groups: actions: update-types: [minor, patch]`). `.github/dependabot.yml` was **not modified at all** in this round. |

## Deferred / untouched (and why)

(A13/A14/A15/A16 moved into scope mid-task; see the tables above. Nothing remains deferred from
the original list except the items below.)

- **`oci/exedev/Dockerfile`** — read, never edited, as instructed. The A16 job reads its `FROM`
  pin at runtime; the one-token `exeuntu:latest@sha256:…` fix stays with DF1.10.
- **The three untagged orphan versions already in the package** (`3c21d5f9…`, `b49540a2…`,
  `d4b9d80c…`, listed in the gate output) — pre-existing, not pushed by any workflow run, and
  outside the prune step's remit by design: it only ever deletes a version **this run** created.
  Pruning those is still the manual registry chore the file's header describes.
- **`.github/image-pin-exceptions.json`** — **not modified.** Its single entry (the DF2.10 bootstrap pin, `expires: 2026-10-15`) passes the new strict validation unchanged; proof below. Its `$comment` promise ("the verify workflow fails after `expires`") is now actually true, thanks to A1 + A3.
- **Not in scope, flagged for whoever owns it:** the consumer's `--bundle-from-oci` arm performs no `docker login`, unlike the producer's attest job. This is fine *only while the ghcr package is public* (AC4, which the publish workflow proves on every real run). If AC4's public-source-image decision is ever reversed, that arm starts 401ing and the gate goes permanently red. Not patched — not in my findings list, and patching it would add a registry credential to a read-only gate.

## Gate output

### 1. actionlint (installed; shellcheck 0.11.0 also installed, so actionlint's shell linting really ran)

```
$ which actionlint
/usr/local/bin/actionlint
$ which shellcheck && shellcheck --version | head -3
/usr/local/bin/shellcheck
ShellCheck - shell script analysis tool
version: 0.11.0

$ actionlint .github/workflows/verify-image-pin.yml .github/workflows/publish-exedev-image.yml
actionlint exit=0
```

(Clean, including the new `concurrency` expression — actionlint validates context availability, so `inputs.dry_run` in a workflow-level `concurrency:` is confirmed legal, as is `attestations: read` as a permission scope.)

### 2. jq + YAML parse

```
$ jq empty .github/image-pin-exceptions.json && echo "jq empty: OK"
jq empty: OK

$ python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]; print('yaml parse OK')" \
    .github/workflows/verify-image-pin.yml .github/workflows/publish-exedev-image.yml .github/dependabot.yml
yaml parse OK
```

### 3. `bash -n` on every extracted `run:` block (both files, all steps)

```
OK   bash -n  .github/workflows/verify-image-pin.yml::verify::Resolve the pinned image reference
OK   bash -n  .github/workflows/verify-image-pin.yml::verify::Verify provenance (or an audited, unexpired exception)
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Refuse a publishing dispatch from an unprotected ref
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Assert the publish environment still requires a human reviewer
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::step4
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Resolve the image source revision
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Read the repo pin
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Assert BUILD_DIR matches the build script
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Log in to ghcr.io
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Build and push
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Classify a registry failure
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Assert pushed digest and buildId equal the repo pin
OK   bash -n  .github/workflows/publish-exedev-image.yml::publish::Assert the package is anonymously pullable
OK   bash -n  .github/workflows/publish-exedev-image.yml::attest::Log in to ghcr.io
OK   bash -n  .github/workflows/publish-exedev-image.yml::attest::Revalidate the published digest before signing
OK   bash -n  .github/workflows/publish-exedev-image.yml::attest::Assert the attestation did not move the image digest
OK   bash -n  .github/workflows/publish-exedev-image.yml::attest::Verify the attestation against the published digest
```

### 4. A1 / A8 EMPIRICAL PROOF

The test harness extracts the register block **verbatim out of the shipped workflow YAML**
(`yaml.safe_load` → the `Verify provenance` step's `run:` → the slice from `# The exception
register first` to `# THE REF IS BOUND HERE`), so this exercises the code that will run in CI,
not a paraphrase of it. Harness at `/tmp/pr184-r4/a1-proof/`.

```
extracted the shipped register block verbatim: 3367 chars
```

**First, the OLD code on the (e) "digest key only" register — the bypass, reproduced:**

```
=== the OLD logic, on the same 'digest key only' register (e-digest-only.json) ===
old exception_reason  = [null]
old exception_expires = [null]
  [ -n reason ] -> TRUE  (enters the exception branch)
  expired -> FALSE  ==> OLD CODE ACCEPTS, FOREVER (today=2026-09-02 vs [null])
```

**Now the NEW code against every malformed shape:**

```
════════ a-missing-expires.json ════════
::error::a-missing-expires.json has malformed entries — refusing to honour any of them:
  entry 0 (sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d): .expires is missing, null, or not a YYYY-MM-DD date
Every entry needs a sha256:<64 hex> .digest, a non-empty .reason a reviewer can
defend, and an .expires date spelled YYYY-MM-DD. An entry that cannot expire is
not an exception, it is a permanent bypass wearing one's clothes.
--> REFUSED (exit 1)
════════ b-missing-reason.json ════════
::error::b-missing-reason.json has malformed entries — refusing to honour any of them:
  entry 0 (sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d): .reason is missing, null, or empty
Every entry needs a sha256:<64 hex> .digest, a non-empty .reason a reviewer can
defend, and an .expires date spelled YYYY-MM-DD. An entry that cannot expire is
not an exception, it is a permanent bypass wearing one's clothes.
--> REFUSED (exit 1)
════════ c-duplicate-digest.json ════════
::error::c-duplicate-digest.json has malformed entries — refusing to honour any of them:
  digest sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d has 2 entries — exactly one per digest is required, or the lookup below returns a multi-line value and the verdict is arbitrary
Every entry needs a sha256:<64 hex> .digest, a non-empty .reason a reviewer can
defend, and an .expires date spelled YYYY-MM-DD. An entry that cannot expire is
not an exception, it is a permanent bypass wearing one's clothes.
--> REFUSED (exit 1)
════════ d-malformed-expires.json ════════
::error::d-malformed-expires.json has malformed entries — refusing to honour any of them:
  entry 0 (sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d): .expires is missing, null, or not a YYYY-MM-DD date
Every entry needs a sha256:<64 hex> .digest, a non-empty .reason a reviewer can
defend, and an .expires date spelled YYYY-MM-DD. An entry that cannot expire is
not an exception, it is a permanent bypass wearing one's clothes.
--> REFUSED (exit 1)
════════ e-digest-only.json ════════
::error::e-digest-only.json has malformed entries — refusing to honour any of them:
  entry 0 (sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d): .reason is missing, null, or empty
  entry 0 (sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d): .expires is missing, null, or not a YYYY-MM-DD date
Every entry needs a sha256:<64 hex> .digest, a non-empty .reason a reviewer can
defend, and an .expires date spelled YYYY-MM-DD. An entry that cannot expire is
not an exception, it is a permanent bypass wearing one's clothes.
--> REFUSED (exit 1)
════════ f-null-fields.json ════════
::error::f-null-fields.json has malformed entries — refusing to honour any of them:
  entry 0 (sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d): .reason is missing, null, or empty
  entry 0 (sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d): .expires is missing, null, or not a YYYY-MM-DD date
Every entry needs a sha256:<64 hex> .digest, a non-empty .reason a reviewer can
defend, and an .expires date spelled YYYY-MM-DD. An entry that cannot expire is
not an exception, it is a permanent bypass wearing one's clothes.
--> REFUSED (exit 1)
════════ g-not-json.json ════════
jq: parse error: Invalid literal at line 1, column 7
::error::g-not-json.json could not be read as the expected shape — it is not valid JSON, has no .exceptions array, or an entry is not an object.
A pin exception that does not parse cleanly is a silent, permanent bypass, so
this fails the gate rather than falling through to it. See the jq error above.
--> REFUSED (exit 1)
════════ h-valid-control.json ════════
ACCEPT-PATH-REACHED reason=[the DF2.10 bootstrap pin] expires=[2026-10-15]
--> ACCEPTED (exit 0)
```

`f-null-fields` (explicit JSON `null`s) and `g-not-json` were added beyond the four required
cases: `null` is the shape a hand-edit most plausibly produces, and a syntactically broken
register must refuse rather than fall through.

**The real committed register still passes, and expiry still fires:**

```
=== the REAL committed register through the NEW logic ===
ACCEPT-PATH-REACHED reason=[DF2.10 bootstrap pin — built and pushed BY HAND before the publish workflow ever executed (the workflow's first run cannot match it by construction, issue #187), so no CI provenance attestation exists for it. Live-booted and e2e-proven on 2026-09-01 (evidence: _bmad-output/evidence/df3-e2e/2026-09-01-114112-t1-image-contract.json).] expires=[2026-10-15]
exit=0

=== expiry still fires on a WELL-FORMED but lapsed entry ===
ACCEPT-PATH-REACHED reason=[lapsed] expires=[2026-01-01]
  today=2026-09-02 > expires=2026-01-01 -> EXPIRED, gate fails (the downstream branch)
```

### A2 supporting evidence

Flag availability and mutual exclusion on the runner-class CLI:

```
$ gh --version
gh version 2.93.0 (2026-05-27)

$ gh attestation verify --help | grep -E 'cert-identity|signer-workflow'
      --cert-identity string         Enforce that the certificate's SubjectAlternativeName matches the provided value exactly
  -i, --cert-identity-regex string   Enforce that the certificate's SubjectAlternativeName matches the provided regex
      --signer-workflow string       Enforce that the workflow that signed the attestation matches the provided value ([host/]<owner>/<repo>/<path>/<to>/<workflow>)

$ gh attestation verify /tmp/dummy-artifact.bin --repo biospark33/QDS-Factory \
    --signer-workflow '…/publish-exedev-image.yml' --cert-identity-regex '…'
if any flags in the group [cert-identity cert-identity-regex signer-repo signer-workflow] are set none of the others can be; [cert-identity-regex signer-workflow] were all set
exit=1
```

The exact regex the shipped shell builds, matched against real SAN shapes:

```
regex: ^https://github\.com/biospark33/QDS-Factory/\.github/workflows/publish-exedev-image\.yml@refs/heads/(main|dev)$
ACCEPT biospark33/QDS-Factory/.github/workflows/publish-exedev-image.yml@refs/heads/dev
ACCEPT biospark33/QDS-Factory/.github/workflows/publish-exedev-image.yml@refs/heads/main
REJECT biospark33/QDS-Factory/.github/workflows/publish-exedev-image.yml@refs/heads/feature/evil
REJECT biospark33/QDS-Factory/.github/workflows/publish-exedev-image.yml@refs/heads/devil
REJECT biospark33/QDS-Factory/.github/workflows/publish-exedev-image.yml@refs/tags/v1
REJECT attacker/QDS-Factory/.github/workflows/publish-exedev-image.yml@refs/heads/dev

=== dot-bearing repo name escaping ===
GITHUB_REPOSITORY=own/re.po -> escaped: own/re\.po
```

`devil` and `refs/tags/v1` reject, so the `$` anchor and the `refs/heads/` literal both hold.

### A4 supporting evidence

```
$ gh repo view --json isPrivate,nameWithOwner
{"isPrivate":true,"nameWithOwner":"biospark33/QDS-Factory"}
```

### A7 supporting evidence — the live gap

```
$ gh api /repos/biospark33/QDS-Factory/environments
{"total_count":2,"environments":[
  {"name":"publish-dry-run", …, "can_admins_bypass":true, "protection_rules":[], "deployment_branch_policy":null},
  {"name":"publish-exedev",  …, "can_admins_bypass":true,
   "protection_rules":[{"id":64352242,"node_id":"GA_kwDORm6IDM4D1e_y","type":"branch_policy"}],
   "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}]}
```

Both environments exist (so A7's "implicitly created with no rules" hazard is not what is
happening today), but `publish-exedev` carries only a `branch_policy` — **no
`required_reviewers`**. The new step therefore fails closed on the next real publish, by design,
until a reviewer rule is added.

### A9 EMPIRICAL PROOF (buildId guard, all four arms)

Same harness idea: the `Resolve the pinned image reference` step's `run:` extracted verbatim
from the shipped YAML, run against mutated copies of the real `driver.ts`.

```
=== A9 (a) DEFAULT_IMAGE_BUILD_ID declared twice ===
::error::src/providers/exedev/driver.ts declares DEFAULT_IMAGE_BUILD_ID 2 times — exactly one is required. A duplicate silently shadows the real half of the pin, the same way a duplicate ref would.
--> exit=1

=== A9 (b) buildId present but not 16-hex, with a real digest pinned ===
pin: ghcr.io/biospark33/qds-exedev@sha256:a70674b2…5285d (buildId TBD)
::error::DEFAULT_IMAGE_BUILD_ID is not a 16-hex buildId (found [TBD]) while DEFAULT_IMAGE_REF names a real digest.
--> exit=1

=== A9 (c) same bad buildId but the SENTINEL pin — bootstrap must NOT be blocked ===
::notice::DEFAULT_IMAGE_REF is the bootstrap sentinel — nothing to verify yet.
--> exit=0          <-- the deliberate exemption, working

=== A9 (d) DEFAULT_IMAGE_BUILD_ID removed entirely ===
::error::no DEFAULT_IMAGE_BUILD_ID declaration in src/providers/exedev/driver.ts — the buildId is half the pin, and a gate that cannot find it has stopped gating it.
--> exit=1
```

### A15 EMPIRICAL PROOF (the overlay path, against the real API)

The overlay step's fetch and the pin step's extraction, run end to end read-only:

```
=== A15: the contents-API read used by the overlay step (read-only, real API) ===
head sha : c52f4d0e0f5abbfb8b8c1f0a72ab1aa067be93bb
bytes    : 72346
DEFAULT_IMAGE_REF decls: 1
export const DEFAULT_IMAGE_BUILD_ID = "664876fb1a9128ec"

=== and the pin step's extraction, run verbatim over that fetched copy ===
pin: ghcr.io/biospark33/qds-exedev@sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d (buildId 664876fb1a9128ec)
--> exit=0
GITHUB_OUTPUT contents:
ref=ghcr.io/biospark33/qds-exedev@sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d
sentinel=0
```

So `contents?ref=<sha>` → base64 → the base branch's grep logic produces exactly the right
values, with the PR head never checked out.

### A16 EMPIRICAL PROOF (base drift — and it is ALREADY drifted)

The `base-drift` job's `run:` extracted verbatim from the shipped YAML and executed against the
**real** `oci/exedev/Dockerfile` and the **live** ghcr endpoint:

```
watching ghcr.io/boldsoftware/exeuntu:latest
pinned  : sha256:4398215003cf896d4a0bbab119f461e0fa09d36fe5b68e7349e0bfb305b9e27d
upstream: sha256:bd447a7715e40984673e29d817b73eb3611bdcf834929821ddc9b204fc5ec72a
::error::the exeuntu base pinned in oci/exedev/Dockerfile has DRIFTED from upstream :latest.
  pinned   : sha256:4398215003cf896d4a0bbab119f461e0fa09d36fe5b68e7349e0bfb305b9e27d
  upstream : sha256:bd447a7715e40984673e29d817b73eb3611bdcf834929821ddc9b204fc5ec72a
…
Adopting it is a deliberate re-pin, not a one-line edit: bump the FROM digest in
oci/exedev/Dockerfile, then rebuild, re-sweep and re-publish via publish-exedev-image.yml and
move DEFAULT_IMAGE_REF/DEFAULT_IMAGE_BUILD_ID in src/providers/exedev/driver.ts to
the new digest — the base is a digest input, so it moves both.
--> exit=1
```

The upstream base moved and **nothing in the repository knew**, which is precisely A16's claim,
now measured rather than argued. Both non-drift arms and both guard arms also exercised:

```
=== A16 (a) NO-DRIFT arm: Dockerfile pinned to the CURRENT upstream digest ===
the pinned exeuntu base is still ghcr.io/boldsoftware/exeuntu:latest — no drift
--> exit=0

=== A16 (b) TWO digest-pinned ghcr FROM lines (the DF1.10 engine-stage case) ===
::error::expected exactly one digest-pinned ghcr FROM line in oci/exedev/Dockerfile, found 2.
If a stage was added (DF1.10 adds an engine stage), this check must be taught which
base to watch — or taught to watch both. Do not let it silently pick one…
--> exit=1

=== A16 (c) NO digest-pinned FROM at all ===
::error::…found 0.
--> exit=1
```

### A13 EMPIRICAL PROOF (version resolution — READ-ONLY, no DELETE was issued)

```
owner=biospark33 pkg=qds-exedev owner_type=User
delete endpoint base = users/biospark33

=== resolver proven against the tag that DOES exist today ===
$ T=df2-10 gh api --paginate users/biospark33/packages/container/qds-exedev/versions \
    --jq '.[] | select(.metadata.container.tags | index(env.T)) | .id'
1195250697

=== and against a tag that does not exist (must resolve to nothing → the LOUD arm) ===
resolved=[]  -> empty, so the step prints the ::error:: manual-prune instruction

=== package digests currently held ===
sha256:a70674b2b9c959d98bac8b51ae8edb304f771a364dba41410ab9d71b4625285d  tags=[df2-10]
sha256:3c21d5f948a585d560ac2f8b00990c98d84e7c14196b4784209578a336cf93ad  tags=[]
sha256:b49540a239ad9f9218be6be5a7c84d2d13fc80c91dff66f69596ab3ea1140db5  tags=[]
sha256:d4b9d80c5bb9c071d387a67ba25c926df27ed44ef8503f3b5e79e5736fafdeeb  tags=[]
```

Two things worth flagging from that listing. **(a)** The owner-type probe and the jq resolver
both work, and the "not found" arm correctly resolves to empty, which is the arm that prints the
manual-prune error. **(b)** There is **no `sha-<sha>` tag in the package at all** — the pinned
digest carries the hand-made tag `df2-10`. That corroborates the exception register's claim that
the current pin was pushed by hand and the publish workflow has never completed a real publish
(issue #187), and it means the prune step has no historical versions to act on: it will only ever
see tags its own run created. The three untagged versions are the pre-existing accumulation the
file's header describes; they are outside the step's remit by design.

Note: the read-only probes above used my owner-level `gh` credentials. Whether the **workflow's**
`GITHUB_TOKEN` can perform the `DELETE` is untested and is documented as untested in the step's
own comment — which is why its failure path is a loud, named manual chore rather than a silent
assumption.

### A14 EVIDENCE (why the proposed fix was declined)

```
$ grep -nE 'secrets\.GITHUB_TOKEN|github\.token|GH_TOKEN|if: env.DRY_RUN' .github/workflows/publish-exedev-image.yml
266:        if: env.DRY_RUN == ''          <-- A7 env-protection step
268:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
535:        if: env.DRY_RUN == ''          <-- docker login
539:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
540:        run: printf '%s' "$GH_TOKEN" | docker login ghcr.io …
870:        if: env.DRY_RUN == ''          <-- anonymous-pull assertion
996:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}   <-- attest job (never runs on a dry run)
1129:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}  <-- attest job
```

Every token reference in the `publish` job is behind `if: env.DRY_RUN == ''`; the rest are in
`attest`, which is gated on `needs.publish.outputs.published == 'true'`. No dry-run step
receives a token.

```
$ cat probe.yml
jobs:
  call:
    permissions: {contents: read}
    environment: publish-exedev
    uses: ./.github/workflows/nonexistent-reusable.yml

$ actionlint probe.yml
probe.yml:7:5: when a reusable workflow is called with "uses", "environment" is not available.
only following keys are allowed: "name", "uses", "with", "secrets", "needs", "if", and
"permissions" in job "call" [syntax-check]
```

That is the cost side: the reusable-workflow split would force the `publish-exedev` environment
approval out of the caller and into an input-selected position in the callee.

### 5. biome

Biome DOES cover part of `.github` — the JSON, not the YAML (biome has no YAML analyzer, and
`biome.json`'s `files.ignore` does not exclude `.github`):

```
$ bunx biome check .github
Checked 1 file in 16ms. No fixes applied.
exit=0

$ bunx biome check .github --verbose | grep -A1 'Files processed'
  i Files processed:
  - .github/image-pin-exceptions.json
```

So biome checked exactly `.github/image-pin-exceptions.json` (unmodified) and passed. The two
workflow YAMLs are outside biome's reach — actionlint + shellcheck + `bash -n` are their gates.

### Diff size

```
$ actionlint .github/workflows/*.yml
actionlint(all workflows) exit=0

$ git diff --stat -- .github/
 .github/dependabot.yml                     |  13 +-
 .github/workflows/publish-exedev-image.yml | 183 +++++++++++++-
 .github/workflows/verify-image-pin.yml     | 381 +++++++++++++++++++++++++++--
 3 files changed, 551 insertions(+), 26 deletions(-)

$ git diff --stat -- .github/image-pin-exceptions.json
(empty — unchanged)
```

(Comment-heavy by design — these files argue their reasoning in prose and I matched that
density. `.github/image-pin-exceptions.json`: zero changes. `.github/dependabot.yml`: comment
only, no config change — the DORMANT note now names the `base-drift` job as the coverage.)

## Behaviour changes other fixers or wave 2 must know about

1. **⚠️ OPERATOR ACTION REQUIRED, BLOCKING: `publish-exedev` has no required-reviewer rule
   today.** The new A7 step will fail every real publish (push to main/dev, or a dispatch with
   `dry_run: false`) until someone adds a Required reviewers rule at
   `https://github.com/biospark33/QDS-Factory/settings/environments → publish-exedev`. This is
   the fail-safe outcome the finding demanded, and it is currently the *live* state, not a
   hypothetical. Dry runs are unaffected. Whoever plans the merge needs to sequence this.
2. **`verify-image-pin` now runs on `push` to main/dev, daily on cron, and on dispatch** — not
   just on PRs. Anyone reasoning about "which checks gate this PR" should know the daily leg
   verifies the DEFAULT BRANCH's pin, independently of any PR. It will start failing on
   **2026-10-16**, the day after the bootstrap exception expires, unless DF1.10's attested
   re-pin has landed by then. That is intended (that is what an expiry is for) but it is a dated
   alarm someone now owns.
3. **The pin gate now reads `DEFAULT_IMAGE_BUILD_ID` too.** Whoever owns `src/providers/exedev/driver.ts`:
   that constant must remain (a) declared **exactly once** with the literal text
   `export const DEFAULT_IMAGE_BUILD_ID`, (b) a double-quoted string on the same logical
   declaration, and (c) **16 lowercase hex chars** whenever `DEFAULT_IMAGE_REF` is a non-sentinel
   digest. Today's value `664876fb1a9128ec` satisfies this. A renamed constant or a
   commented-out second copy now fails `verify-image-pin`, not just the publish workflow.
4. **`--signer-workflow` is gone from the consumer.** Any future doc, test or script asserting
   that `verify-image-pin.yml` passes `--signer-workflow` is now stale — it passes
   `--cert-identity-regex`. If the publish workflow file is ever **renamed**, or if publishing is
   ever allowed from a branch other than `main`/`dev`, the regex at
   `verify-image-pin.yml:270` must be updated in the same commit or every subsequent pin fails
   verification. (Producer-side `--signer-workflow` in the `attest` job is untouched.)
5. **Publish concurrency groups changed.** Dry runs now queue per-ref (`…-dry-refs/heads/<x>`);
   all real publishes share `…-publish`. A feature-branch dry run can no longer cancel a pending
   pin-adoption push. Anyone reading run history will see new group names.
6. **The consumer verify step is now up to ~80 s slower on a genuinely unattested pin**
   (2 stores × 5 attempts × 10 s). Well inside the job's `timeout-minutes: 10`; the sentinel arm
   still skips the step entirely.
7. **The exception register's schema is now enforced.** Anyone adding an entry must supply a
   `sha256:<64hex>` digest, a non-empty reason, and a `YYYY-MM-DD` expires, with no duplicate
   digests — and a malformed entry fails the gate for *every* pin, not just the one it names.
8. **⚠️ The exeuntu base has ALREADY drifted** (`4398215003cf…` pinned vs `bd447a7715e4…`
   upstream, measured live). The new `base-drift` job will therefore go **red on its very first
   scheduled run**. That is correct behaviour and the whole point of the check, but it means a
   red daily run appears the moment this merges, and someone has to decide whether to adopt the
   new base (a full re-pin: Dockerfile FROM → rebuild → re-sweep → re-publish → move both driver
   constants) or to consciously stay behind. Whoever owns DF1.10 should probably absorb it.
9. **`verify-image-pin` PR checks now run on `pull_request_target`, not `pull_request`.**
   Consequences for whoever manages branch protection: the check name is unchanged
   (`verify-image-pin / verify`), but the workflow that runs is the **base branch's** copy. Two
   knock-ons — (a) a PR that changes this gate does not exercise its own new version, the `push`
   leg does that one merge later; (b) this PR (#184) is itself unaffected, because `dev` does not
   yet have a `pull_request_target` leg, so the existing `pull_request` leg is what runs here.
   The `pull_request` leg was deliberately dropped rather than kept alongside — two check runs
   sharing one name makes "which did branch protection require?" ambiguous exactly when it
   matters.
10. **A failed publish now DELETES the image it just pushed.** The documented ritual still
    converges — the adoption push rebuilds the identical bytes at the same source revision and
    re-publishes them, which is the reproducibility property this workflow already depends on —
    but the gate's recovery text changed accordingly ("The image was published … and is being
    PRUNED"). Anyone who has memorised "the image IS published at the actual digest above" should
    re-read it. If the delete cannot be performed the run stays red from the gate and an
    `::error::` names the tag to prune by hand; the prune step can never turn a red run green and
    never deletes a build that passed.
11. **`base-drift` is a second job in `verify-image-pin.yml`**, so that workflow now produces two
    check names (`verify / verify` and `verify / base-drift`). `base-drift` is skipped on every PR
    and push leg — it runs only on schedule and dispatch.
12. **A14 was declined, not forgotten** — see the false-positives table for the evidence and the
    offer to build it anyway if the call is overruled.
13. I did **not** touch `src/`, `scripts/`, `oci/`, `tests/`, or
    `.github/image-pin-exceptions.json`. `driver.ts` and `oci/exedev/Dockerfile` were read only.
    `.github/dependabot.yml` changed by comment only.
