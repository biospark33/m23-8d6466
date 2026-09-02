# W1-A fix report — CI cluster (PR #184, DF2.10)

Files touched (only these): `.github/workflows/publish-exedev-image.yml`,
`.github/dependabot.yml`. **`.gitignore` NOT touched — see A11.**
No commits, no `git add`. Changes are in the working tree.

## Verdicts

| ID | Verdict | What changed |
|----|---------|--------------|
| A1 | fixed | `BUILD_DIR: oci/exedev/.build` → `oci/.build/exedev` (matches `scripts/build-exedev-image.ts:119`), so `--summary`/`--evidence` land beside the NOTICE. Upload step now names three paths (`NOTICE`, `sweep-summary.json`, `publish-evidence.json`) via `${{ env.BUILD_DIR }}` instead of collecting the directory — which would have swept the ~1.6 GB `exedev.docker.tar` on a run dying between build and `docker load`. Using the env var also closes blind-ci's "parameterised for build, hardcoded for upload" LOW. |
| A2 | fixed **(behaviour change — see below)** | `package.json` added to both `on.push.paths` and `SOURCE_PATHS`. The lockstep comment now explains it is a digest input via `readBunPin` → `deriveBuildId` → `--build-arg`, and states the accepted cost. |
| A3 | fixed | `src/providers/exedev/driver.ts` added to `on.push.paths` ONLY, with an inline comment stating it is deliberately absent from `SOURCE_PATHS` and why that preserves convergence (it does not move `src_sha`, so the re-run rebuilds the digest just pinned). The lockstep comment above now flags the one asymmetry rather than being falsified by it. |
| A4 | fixed | `\|\| true` on the `tr` read and both `grep \| head \| sed` pipelines, plus an explicit `[ ! -f "$DRIVER" ]` arm with its own message (a moved file and a renamed constant are different failures). |
| A5 | fixed | `Build and push` captures `rc` and publishes `build_rc` as a step output, then re-exits with it. The classifier is now a `case` on `LOGIN_OUTCOME:BUILD_RC`: registry essay for `failure:*` and `*:2` (2 is the only publish-path code a push can produce — `run()` dies 2 on any non-zero subprocess including `docker buildx build --push`), a compliance message for `*:1`, and an "outside the script's contract" message for anything else (137/143). |
| A6 | fixed | `jq -r .token` → `jq -er .token`, inside an `if !` so a token-endpoint failure gets its own message instead of dying silently under `set -e`. |
| A7 | fixed | Both curls get `--max-time 30 --retry 3 --retry-connrefused`; the manifest read captures curl's exit status and `000` gets its own arm that explicitly says *do not change visibility settings on the strength of this message*. |
| A8 | fixed | `IMAGE_PATH` deleted from `env:`; derived at its single use site as `image_path=${IMAGE#ghcr.io/}`. One source of truth beats a lockstep comment. |
| A9 | fixed | `jobs.publish.if: github.repository == 'biospark33/QDS-Factory'`. |
| A10 | fixed | The marker `cat` is wrapped in `if ! marker=$(… 2>&1)` with a named `::error::` carrying the digest, the captured `cat` stderr, and the INV-IBOX-2 / gate-B0 consequence. |
| A11 | **false positive as scoped — no fix needed** | Dissolved by A1, exactly as predicted. `git check-ignore -v oci/.build/exedev` → `.gitignore:12:oci/.build/`. The workflow no longer creates `oci/exedev/.build` anywhere, so there is nothing left to ignore. `.gitignore` is untouched. |
| A12 | fixed, **but not as specified** | See "Deviation" below. |
| A13 | fixed | The attest job's revalidation comment no longer claims a queued second publish can land between the jobs (the concurrency group is workflow-scoped, so it cannot). It now names the real movers: a manual push, a `crane copy`, a registry-side retag, an operator repairing a half-published package. |
| A14 | fixed | Comment corrections, itemised below. |

### A14 itemised

- **Header, Q-2**: "the gate step refuses it" → the gate *reports*; a digest cannot be compared before it exists, so `--push` already happened. States what is protected (production, via the pin) and what is not (the package, which accumulates unsigned unreferenced `sha-<sha>` tags — the attest job is skipped when publish fails).
- **The false "bun bump is caught, one field over" claim**: deleted with the paragraph it lived in, replaced by the A2 rationale.
- **Q-5**: the new comment documents that `scripts/build-exedev-image.ts` is in `SOURCE_PATHS` despite `.dockerignore` excluding `scripts` from the build context — its constants are build args, so a comment-only edit to it re-pins, knowingly.
- **Workflow-file-is-a-digest-input (blind-ci MED)**: recorded as a KNOWN GAP in the `SOURCE_PATHS` comment (the tag string reaches the marker), with the reason it is not added — every comment edit here would otherwise re-pin the image.
- **Q-1**: the gate's mismatch message gains a closing paragraph: the tag is a digest input, a different tag on the identical tree yields a different digest, and a moved digest here is not evidence of tampering. It also names the new npm-bump path.
- **D-5, `.github/dependabot.yml`**: the entry's claim that a digest-bump PR is "the INTENDED early-warning signal" is now qualified by a DORMANT UNTIL THE DOCKERFILE CARRIES A TAG paragraph — dependabot derives the stream from the tag, `oci/exedev/Dockerfile` has a bare `@sha256:`, the sibling `/oci` entry works because it has tag AND digest, and the one-token fix lands with the next deliberate re-pin (DF1.10) because it moves the Dockerfile bytes. Says plainly that until then no PR is indistinguishable from no upstream change.

## Deviation from the brief — A12

The brief said to "add the sentinel refusal to the pin-read step". Implemented as a
**carried** refusal, not an early exit, because an early exit breaks the documented
bootstrap ritual: on the first publish the pin IS the sentinel, and the ritual requires
that run to build and push so the gate has a real digest to print. Exiting at pin-read
would leave the operator with a gate demanding a pin and a workflow that never produces
one — a deadlock, on the exact run the ritual is written for.

Instead the pin-read step sets `unpinned=1`, emits a `::warning::` naming the run a
BOOTSTRAP run, and exports it; the gate keys on it and prints "$DRIVER has never been
pinned — it still carries the sentinel digest … nothing was compromised and nothing
moved" instead of the ordinary mismatch headline. The workflow now genuinely keys on
the sentinel and refuses to go green against one, which is what `isUnpinnedImage`'s
comment needs to be true.

**Note for whoever owns `driver.ts` (C13):** the accurate wording is that the workflow
*detects* the sentinel and can never pass its gate against one — not that it refuses to
run. `isUnpinnedImage` itself is unchanged and untouched by me.

## INTENTIONAL BEHAVIOUR CHANGES — for the test wave

1. **`package.json` is now a source path (A2).** Every npm-only dependabot PR now moves
   `src_sha` and `src_epoch`, therefore moves the digest, therefore needs a re-pin.
   Measured on `feature/df2.10`: this does **not** invalidate the current pin today —
   `git log -1 -- oci/exedev scripts/build-exedev-image.ts package.json` returns the same
   `41cb8dd0` / epoch `1788281611` as before the change, because `package.json` was last
   touched at `e5e0c14e` (epoch `1787953350`), older than the image tree. The cost is
   prospective, not immediate.
2. **`driver.ts` now triggers the workflow (A3).** A pin-adoption commit on `main`/`dev`
   auto-runs the publish workflow. Intended: it is what clears a red branch without a
   manual dispatch. It does not move `src_sha`, so it converges.
3. **Forks no longer run the publish job at all (A9).** Including `workflow_dispatch`
   on a fork. Correct — a fork has nothing to publish to this package.
4. **`steps.publish` now has an output** (`build_rc`). Nothing else consumes it yet.
5. **The artifact is three named files, not a directory (A1).** Anything else the script
   writes to `BUILD_DIR` (`build-metadata.json`) is no longer uploaded.

## Verification

All performed offline. `bun test` deliberately not run — no TypeScript changed.

```
actionlint .github/workflows/publish-exedev-image.yml   → exit 0
uvx zizmor --offline …/publish-exedev-image.yml         → 7 findings (4 suppressed),
                                                          3 high unpinned-uses
  baseline (git show HEAD:… into a scratch tree)        → 7 findings (4 suppressed),
                                                          3 high unpinned-uses
  ⇒ byte-identical finding set; NO new finding class.
shellcheck -S warning (all 12 run: blocks extracted)    → exit 0
bun -e yaml.parse(.github/dependabot.yml)               → parses, 4 update entries
git check-ignore -v oci/.build/exedev                   → .gitignore:12:oci/.build/
grep -rn IMAGE_PATH .github/                            → no refs
grep -rn 'oci/exedev/\.build' (yml/ts/md/sh)            → no stale refs
```

`zizmor` is installed only via `uvx` (not on `PATH` as `zizmor`); `actionlint` and
`shellcheck` are on `PATH`.

### Offline exercise of every edited `run:` block

Blocks extracted from the parsed YAML (so the harness runs the real text), driven
against stubbed `docker`/`curl`/`bun` on `PATH`.

**Read the repo pin** — 5 cases, all reached their intended arm:

| case | result |
|---|---|
| `$DRIVER` missing | `::error::… does not exist — the pin gate has nothing to read.` exit 1 |
| constants renamed | full "could not read the image pin" diagnostic **printed**, exit 1 |
| non-digest ref | `::error::DEFAULT_IMAGE_REF is not a digest reference`, exit 1 |
| sentinel pin | `::warning::… BOOTSTRAP run`, `unpinned=1`, exit 0 |
| good pin | `unpinned=0`, all four outputs written, exit 0 |

The renamed-constants case is the A4 proof. Pre-fix control (old spelling, no `|| true`,
same input) exited 1 **without ever reaching the guard** — the sentinel line
`echo "REACHED THE GUARD"` never printed. Post-fix it prints the whole diagnostic.

**Classify a registry failure** — `LOGIN_OUTCOME:BUILD_RC`:
`failure:` → registry essay · `success:2` → registry essay · `success:1` → compliance
message ("Do not adjust registry permissions for this") · `success:137` and `success:`
→ outside-the-contract message. All exit 1.

**Build and push** — stub `bun` exiting 0/1/2 → step exits 0/1/2 and writes
`build_rc=0/1/2` to `$GITHUB_OUTPUT`. The code survives `set -e`.

**Assert the package is anonymously pullable** — stub `curl`:
token ok + 200 → green, exit 0 · token ok + 403 → "not public" + settings URL, exit 1 ·
token ok + transport failure (curl exit 6, `%{http_code}`=000) → the new 000 arm, exit 1,
explicitly telling the operator not to touch visibility · token endpoint 404 (curl -f
exit 22) → token arm, exit 1 · token endpoint 200 with no `.token` field → token arm via
`jq -er`, exit 1. `image_path` derived correctly as `biospark33/qds-exedev`.

**Assert pushed digest and buildId equal the repo pin** — stub `docker`:
match → exit 0 with all four report lines · marker missing (`docker run cat` exit 1) →
named `::error::` carrying the captured `cat` stderr and the INV-IBOX-2 consequence,
exit 1 (pre-fix: a bare `cat:` error and no diagnostics) · mismatch with `UNPINNED=0` →
"pushed image does not match the repo pin" + the new tag-is-a-digest-input paragraph ·
mismatch with `UNPINNED=1` → the sentinel headline instead, same adoption lines.

## Not fixed, and why

Nothing in the A1–A14 list was deferred. Items in my files that the triage ledger placed
elsewhere and I left alone: D-6 (tag-pinned actions — repo-wide convention, and the
zizmor baseline comparison above is only meaningful because I did not touch them), D-7
(`environment:` approval gate — operator decision), and the edge-ci HIGH about
`scripts/build-exedev-image.ts` being a digest input it cannot reach, which the ledger
resolved as Q-5 (keep, document) and which I documented rather than changed.
