# W2-CI

Exclusive file: `.github/workflows/publish-exedev-image.yml`. Nothing else touched.

## Patched

| File:line | What changed | Why |
|---|---|---|
| `.github/workflows/publish-exedev-image.yml:580-595` (step **Build and push**, comment) | Replaced the claim that "`builtDigest` lands in the evidence JSON either way, which is what the gate's dry arm below reads" with an accurate account: a no-push run records `builtDigest` only from an exporter-scoped `image` digest, today's buildx writes one flat unattributed `containerimage.digest`, so a dry run records `builtDigest: null` + `builtDigestReason`. | That sentence was the prose justifying the old behaviour and it is now false. The file argues its reasoning; a stale argument is worse than none. |
| `:706` | Added `unpinnable=0` immediately after `set -euo pipefail`. | The flag is read on the shared tail after the if/else, so it must be defined on **both** arms or `set -u` kills the push path. |
| `:710-733` (dry-arm comment) | Rewrote "What it PROVES" — it no longer claims a digest comparison "with the same sentinel handling and the same adoption block as a real publish". Now states plainly that on today's buildx the dry arm is given no digest, can **neither verify nor bootstrap a pin**, that only a real `--push` run can, and that this is a printed refusal rather than a silent pass or a fall-through into the adoption block. | Requirement 3. Same reason as above: the behaviour changed, so the paragraph that defended it changed. |
| `:728-736` | `actual_digest=$(jq -er .builtDigest "$evidence")` → `actual_digest=$(jq -r '.builtDigest // ""' "$evidence")`, with a comment naming the `jq -e`/`set -e` interaction. | Requirement 1, and it is a live bug **today**, not only post-B2: `jq -e` exits 1 on a null result, so the assignment died under `set -euo pipefail` **before the `case` arm could print anything**. Reproduced below — bare exit 1, zero output. |
| `:737-758` | New `""` case arm: sets `unpinnable=1` and prints a `::warning::` that quotes `jq -r '.builtDigestReason // "no reason recorded"'`, explains the flat-key/two-exporter cause, states "no pin beats a wrong pin", and says a real `--push` run is the only thing that can check or produce a pin. | Requirements 2 and 3. |
| `:759-766` | New explicit `*)` arm: a **non-empty, non-`sha256:`** value keeps the original hard `::error::` + `exit 1`, now naming it as a build-script contract violation and quoting the reason field too. | Not in the brief, but falling out of the four-case proof: withheld and corrupt are different conditions. Collapsing garbage into the warn path would have been a *loosening* of the gate. Fail-safe where a choice exists. |
| `:770-774` | `echo "built : $IMAGE@$actual_digest …"` guarded — prints `$IMAGE (DRY RUN — nothing was pushed, and no digest was recorded)` when unpinnable. | Otherwise the very first line of the gate prints `ghcr.io/biospark33/qds-exedev@` with a dangling `@` — the same "offer a human an empty pin" hazard, one line earlier than the adoption block. |
| `:862-884` | The pin comparison `if` gained a leading `if [ "$unpinnable" = 1 ]` branch that prints a `::warning::pin NOT CHECKED`, the repo pin, this run's buildId, and "Nothing below adopts anything" — then `elif` for the original comparison. Preceded by a comment arguing the fail-vs-warn decision. | Requirements 3 and 4. **This is the actual hazard the brief names**: with `actual_digest` empty, the fall-through prints `export const DEFAULT_IMAGE_REF = "ghcr.io/biospark33/qds-exedev@";` and tells a human to commit it. |
| `:944-950` | The closing `echo "digest and buildId match the pin ($EXPECTED_REF)"` is now branched: when unpinnable it prints `build gates passed; the PIN WAS NOT CHECKED — this run is not evidence the pin is good`. | A green step that says "digest and buildId match the pin" after comparing nothing is the exact misreading requirement 4 warns about. |

What was deliberately **not** changed: `actual_build_id` / `actual_git_sha` / `platform` keep `jq -er`. Those three are unconditionally written by the script and are not nullable; a null there is a real defect and the hard failure is correct. Widening the tolerant read to them would have been scope creep in the loosening direction.

## Verified, no change needed

1. **Additive evidence fields.** Confirmed against the post-wave-1 workflow. The only evidence reads are:
   ```
   736: actual_digest=$(jq -r '.builtDigest // ""' "$evidence")
   767: actual_build_id=$(jq -er .buildId "$evidence")
   768: actual_git_sha=$(jq -er .gitSha  "$evidence")
   769: platform=$(jq -er .platform "$evidence")
   ```
   plus the two new `.builtDigestReason` reads I added. `grep -n 'keys\|to_entries\|has('` over the whole workflow returns only two prose comments (`:205`, `:471`) and no jq — **no exact key-set comparison anywhere**. `coldBootMeasuredBy` and `coldBootSource` are never read by this workflow; the evidence JSON is uploaded whole as an artifact (`:1035-1036`) which is shape-agnostic. Additive fields are safe. Confirmed.

2. **`--summary` / `--evidence` resolve inside `BUILD_DIR`.** Confirmed independently, and the fixer is right that **no workflow change is needed**. The chain:
   - script `:124` — `const BUILD_DIR = path.join(REPO_ROOT, "oci/.build/exedev")`
   - script `:1931` — the guard is `insideOrEqual(c, canonicalOutputPath(BUILD_DIR)) || !insideOrEqual(c, canonicalOutputPath(REPO_ROOT))`, i.e. inside BUILD_DIR **or** outside REPO_ROOT
   - workflow `:139` — `BUILD_DIR: oci/.build/exedev`
   - workflow `:512-528` — a dedicated step *asserts* the workflow env equals the script constant, greps it straight out of the source and fails loudly on divergence
   - workflow `:589-590` — `--summary "$BUILD_DIR/sweep-summary.json"`, `--evidence "$BUILD_DIR/publish-evidence.json"`
   Both land in the first half of the disjunction, and the collision half is satisfied because the two basenames differ. The script's own comment at `:1922-1924` cites this workflow by name and reaches the same conclusion. Nothing to patch.

3. **`tier1-image-contract.live.test.ts` rename.** `grep -n "tier1-image-contract" .github/workflows/publish-exedev-image.yml` → **no match**. The workflow never names any live test file. The three surviving references are all in `scripts/build-exedev-image.ts` (`:2022`, `:2139`, `:2573` — the last one being the `coldBootSource` evidence string), which is another fixer's file and untouched here. `git diff --stat` confirms the rename really happened (`tests/fleet/e2e/tier1-image-contract.live.test.ts | 612 ------`). **Flagging for the build-script fixer**: those three are still stale in `scripts/`, and `:2573` bakes the dead path into shipped evidence JSON.

## False positives

None. Every claim in the brief held against the real post-wave-1 files:

- B2 is real — `scripts/build-exedev-image.ts:2274` is literally `const builtDigest = scoped ?? (opts.push ? flat : null);`, with `builtDigestReason` at `:2276-2283` and the measured-on-2026-09-01 note at `:2254-2257` confirming today's buildx writes one flat key.
- The `jq -e` breakage is real and reproduced below.
- The dry arm had moved from `:629` to `:708`, as the brief anticipated; the code was otherwise verbatim as quoted.

## Gate output

### 1. actionlint (with shellcheck 0.11.0)
```
$ actionlint .github/workflows/publish-exedev-image.yml
actionlint exit=0
```
Clean — no output, exit 0.

### 2. YAML parse
```
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish-exedev-image.yml')); print('yaml ok')"
yaml ok
```

### 3. `bash -n` on every edited `run:` block
Extracted via `yaml.safe_load` → `step['run']`, not by hand:
```
wrote publish (44 lines)
wrote gate (237 lines)
--- bash -n ---
gate step run: syntax OK
publish step run: syntax OK
```

### 4. Empirical proof

**First, the regression as it stands today** (the old line `:708`, verbatim):
```
$ echo '{"builtDigest":null}' > /tmp/pr184-r4/ev-old.json
$ bash -c 'set -euo pipefail; d=$(jq -er .builtDigest /tmp/pr184-r4/ev-old.json); echo "case ran: [$d]"'
OLD-CODE step exit=1
```
No stdout at all. The `echo` never ran; in CI that is a red step with no `::error::` annotation. Confirmed exactly as reported.

**Then the shipped block.** The gate step's `run:` was extracted VERBATIM from the shipped YAML by `yaml.safe_load` and executed as-is under the real env (`DRY_RUN=1`, `IMAGE`/`DRIVER`/`BUILD_DIR` taken from the workflow's own `env:` block) against synthetic evidence files. This is the code CI will run, byte for byte.

```
================ CASE a: builtDigest null WITH builtDigestReason ================
::warning::this dry run can neither verify nor bootstrap the pin — the build recorded no usable builtDigest.
  evidence : oci/.build/exedev/publish-evidence.json
  reason   : this buildx reports one flat containerimage.digest for a two-exporter solve and attributes it to no exporter; without a push there is no registry read-back to prove it describes the type=image export rather than the docker archive, so it is not recorded as a pin
This is the NORMAL outcome on a buildx that writes one flat containerimage.digest
for the two-exporter solve and attributes it to no exporter. Only the --push
registry read-back can prove that value is the type=image manifest digest and not
the docker archive's, so without a push the script refuses to record it as a pin —
and this gate will not offer you one. No pin beats a wrong pin: a docker-archive
digest adopted as DEFAULT_IMAGE_REF names bytes no registry can ever resolve.
A REAL --push run is the only thing that can check the pin or produce a new one.
Re-run this workflow with dry_run off, or push to a branch that publishes.
built   : ghcr.io/biospark33/qds-exedev (DRY RUN — nothing was pushed, and no digest was recorded)
buildId : bid-abc
platform: linux/amd64
gitSha  : deadbeefcafe
::warning::pin NOT CHECKED — this run compared no digest against src/providers/exedev/driver.ts.
  repo pin : ghcr.io/biospark33/qds-exedev@sha256:1111111111111111111111111111111111111111111111111111111111111111
  this run : buildId bid-abc, digest not recorded
A buildId differing from the pin's already tells you the tree moved, but only a
--push run can produce the digest to pin it to. Nothing below adopts anything.
build gates passed; the PIN WAS NOT CHECKED — this run is not evidence the pin is good
---- step exit=0 ----

================ CASE b: builtDigest null, NO reason field at all ================
::warning::this dry run can neither verify nor bootstrap the pin — the build recorded no usable builtDigest.
  evidence : oci/.build/exedev/publish-evidence.json
  reason   : no reason recorded
This is the NORMAL outcome on a buildx that writes one flat containerimage.digest
for the two-exporter solve and attributes it to no exporter. Only the --push
registry read-back can prove that value is the type=image manifest digest and not
the docker archive's, so without a push the script refuses to record it as a pin —
and this gate will not offer you one. No pin beats a wrong pin: a docker-archive
digest adopted as DEFAULT_IMAGE_REF names bytes no registry can ever resolve.
A REAL --push run is the only thing that can check the pin or produce a new one.
Re-run this workflow with dry_run off, or push to a branch that publishes.
built   : ghcr.io/biospark33/qds-exedev (DRY RUN — nothing was pushed, and no digest was recorded)
buildId : bid-abc
platform: linux/amd64
gitSha  : deadbeefcafe
::warning::pin NOT CHECKED — this run compared no digest against src/providers/exedev/driver.ts.
  repo pin : ghcr.io/biospark33/qds-exedev@sha256:1111111111111111111111111111111111111111111111111111111111111111
  this run : buildId bid-abc, digest not recorded
A buildId differing from the pin's already tells you the tree moved, but only a
--push run can produce the digest to pin it to. Nothing below adopts anything.
build gates passed; the PIN WAS NOT CHECKED — this run is not evidence the pin is good
---- step exit=0 ----

================ CASE c: valid sha256 digest matching the pin ================
built   : ghcr.io/biospark33/qds-exedev@sha256:1111111111111111111111111111111111111111111111111111111111111111 (DRY RUN — nothing was pushed)
buildId : pinned-build-id
platform: linux/amd64
gitSha  : deadbeefcafe
digest and buildId match the pin (ghcr.io/biospark33/qds-exedev@sha256:1111111111111111111111111111111111111111111111111111111111111111)
---- step exit=0 ----

================ CASE d: malformed non-digest string ================
::error::oci/.build/exedev/publish-evidence.json records a builtDigest that is not a digest: [not-a-digest]
  reason field : no reason recorded
The build script writes either a sha256: digest or null there, never anything
else, so this is a defect in scripts/build-exedev-image.ts and not a pin problem.
---- step exit=1 ----

================ CASE e (extra): builtDigest null BUT gitSha wrong — the hard checks must still fail ================
::warning::this dry run can neither verify nor bootstrap the pin — the build recorded no usable builtDigest.
  evidence : oci/.build/exedev/publish-evidence.json
  reason   : one flat containerimage.digest, no exporter attribution
This is the NORMAL outcome on a buildx that writes one flat containerimage.digest
for the two-exporter solve and attributes it to no exporter. Only the --push
registry read-back can prove that value is the type=image manifest digest and not
the docker archive's, so without a push the script refuses to record it as a pin —
and this gate will not offer you one. No pin beats a wrong pin: a docker-archive
digest adopted as DEFAULT_IMAGE_REF names bytes no registry can ever resolve.
A REAL --push run is the only thing that can check the pin or produce a new one.
Re-run this workflow with dry_run off, or push to a branch that publishes.
built   : ghcr.io/biospark33/qds-exedev (DRY RUN — nothing was pushed, and no digest was recorded)
buildId : bid-abc
platform: linux/amd64
gitSha  : 0000000000wrong
::error::the marker's gitSha is 0000000000wrong, not the image source revision deadbeefcafe.
QDS_GIT_SHA was not honoured by scripts/build-exedev-image.ts (imageSourceSha()).
Until that is fixed the digest tracks HEAD and this gate can never pass twice.
::warning::pin NOT CHECKED — this run compared no digest against src/providers/exedev/driver.ts.
  repo pin : ghcr.io/biospark33/qds-exedev@sha256:1111111111111111111111111111111111111111111111111111111111111111
  this run : buildId bid-abc, digest not recorded
A buildId differing from the pin's already tells you the tree moved, but only a
--push run can produce the digest to pin it to. Nothing below adopts anything.
---- step exit=1 ----

```

Case (e) is an extra I added: it proves the checks that *can* still run on a digest-less dry run **do** still run and **do** still fail the job (`step exit=1` on a bad `gitSha`), and that the adoption block is still not printed. The warn path suppresses exactly one thing.

Summary of the four required cases:

| Case | Verdict | Adoption block printed? |
|---|---|---|
| (a) `builtDigest: null` + reason | `::warning::`, reason quoted verbatim, **exit 0** | no |
| (b) `builtDigest: null`, no reason field | `::warning::`, `reason : no reason recorded`, **exit 0** | no |
| (c) valid `sha256:…` matching the pin | normal pass, `digest and buildId match the pin`, **exit 0** | n/a |
| (d) malformed `"not-a-digest"` | `::error::`, named as a build-script defect, **exit 1** | no |

## Decision: fail vs warn vs partial on a null dry-run digest, and why

**PARTIAL — pass the build verdict, refuse the pin verdict, loudly.** The third option in the brief, and it is the honest one. It is written into the workflow as prose at `:862-877` so the next reader gets the argument and not just the behaviour.

The reasoning, in the order it actually matters:

**Failing every dry run is not fail-safe, it is fail-useless — and it is fail-*dangerous*.** On the only buildx we have, `builtDigest: null` is not an anomaly; it is the *normal* dry-run outcome. A gate that goes red 100% of the time on its intended input teaches people to ignore it inside a week, and worse, it creates pressure toward the one workaround that makes the red go away: running a **real `--push`** to get a green. That trades a missing pin check for extra unaudited publishes to ghcr. Reaching for the harshest exit code is not automatically the safe choice when the harshness has a predictable escape hatch.

**Passing silently is the one genuinely unsafe option**, and it is the one the old code would have degenerated into if the `jq -e` bug were fixed carelessly — or, as things actually stood, into a bare red step with no explanation, which is arguably worse because the operator cannot even tell *what* went wrong.

**So: split the verdict, because the two things being verdicted are genuinely independent.** A dry run's purpose is to prove the build and its gates run — the DF2.9 license sweep, the credential scan, the in-build marker assertions, the platform, the `gitSha` honouring `QDS_GIT_SHA`. Every one of those still concludes, and every one of those still **fails the job** when it concludes no (proven by case (e): exit 1). None of them needs a digest. The pin comparison is the only assertion that does, so it is the only one withheld.

**What "refuse" concretely means here** — the withholding is stated three times, at every point a human could misread the run:
1. `::warning::this dry run can neither verify nor bootstrap the pin` with `builtDigestReason` quoted at the point of failure;
2. `::warning::pin NOT CHECKED — this run compared no digest against src/providers/exedev/driver.ts` where the comparison would have been, plus "Nothing below adopts anything";
3. the closing line, which refuses to say `digest and buildId match the pin` and says `the PIN WAS NOT CHECKED — this run is not evidence the pin is good` instead.

Both warnings surface in the GitHub Actions annotation list, so they are visible from the run summary without opening the log.

**And the fail-safe is preserved where it actually counts.** The whole point of B2 is that no pin beats a wrong pin. The concrete hazard was never the exit code — it was the fall-through printing `export const DEFAULT_IMAGE_REF = "ghcr.io/biospark33/qds-exedev@";` and instructing a human to commit it. **A dry run on this buildx now hands nobody a pin at all**, which is exactly what was asked for. Where a choice remained (case (d), a corrupt non-digest value), I took the strict arm: that keeps its hard `exit 1`, because a script violating its own output contract is not a condition any prose makes safe to continue past.
