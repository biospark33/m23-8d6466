# DF1.10 / PR #216 — Handoff for review round 2 (post-review closeout)

Written 2026-09-04 by the round-1 review session. Everything below is verified against the repo,
not remembered.

## State at handoff

- Repo `/Users/steve/QDS-Factory`, branch **`feature/df1.10`**, HEAD **`6204c081`**, working tree CLEAN.
- **PR #216** → base **`dev`** (repo convention: ALL feature PRs merge to `dev`; `dev`→`main` is a
  periodic promote only). State OPEN, MERGEABLE.
- Round 1 landed: 15 adversarial reviewers over the 18,343-line diff, ~212 findings, 9 fixers in two
  waves. Full write-up is the **"Review Findings — round 1"** section at the bottom of
  `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-10-in-box-phase-engine.md`, and the PR
  comment at https://github.com/Quantum-Digital-Solutions/QDS-Factory/pull/216#issuecomment-5547701170
- Sprint status: DF1.10 is now `in-review` in `_bmad-output/sprint-artifacts/sprint-status.yaml:130`.
- Gates at `6204c081`: `tsc` 0 · `biome` clean (687 files) · `bun test` **5285 pass / 0 fail** /
  8 skip / 27 todo · `detect_changes` 147 symbols / 31 processes, all in-module.
- CodeRabbit full review was requested on `6204c081` and may have landed comments since.

## THE CONSTRAINT THAT SHAPES THIS WHOLE PLAN

`deriveBuildId` hashes `oci/exedev/Dockerfile` **and both systemd unit files**, so editing either
moves the buildId → the digest → invalidates the pin
`sha256:8cdcfe84…` / `c2b0c0f0531078e1` (`src/providers/exedev/driver.ts:305,365`) that DF1.10's
20-of-20 live round proved on real boxes.

**And a re-pin CANNOT be done from this branch.** Verified in
`.github/workflows/publish-exedev-image.yml`:
- `on.workflow_dispatch.inputs.dry_run` (`:66-70`): *"a REAL publish (dry_run: false) is refused
  unless dispatched from **dev or main** — enforced by the publish-exedev environment's deployment
  BRANCH POLICY … and, in depth, by a refusal step in the job."*
- `on.push.branches: [main, dev]` (`:75-77`): *"Feature branches publish via workflow_dispatch only."*
- The bootstrapping ritual (`:40-50`): dispatch → let the gate fail → paste the two constant lines it
  prints into `driver.ts` → commit → **push** (the push triggers the healing run, because `driver.ts`
  is in `on.push.paths`). Re-running the failed run just re-reads the old constants.

A feature branch can only **dry-run** (build + gate, zero registry writes) — which produces no
digest, so there is nothing to pin and nothing to live-test. The only alternative is another
hand-push, which is exactly what finding **A2** objects to.

**Therefore: no image or unit edit on `feature/df1.10`. The image bundle is PHASE 2, on `dev`.**

## PHASE 1 — on `feature/df1.10`, now

### 1.1 Land F21 (the only code item left that is unblocked)

`tests/providers/exedev/image-assets.test.ts:~437-456`. The `%i`-quoting assertion itself is sound
(`ExecStart=/usr/local/bin/qds-engine run "%i"`), but its **rationale comment is wrong**: `%i` is the
*escaped* instance name taken from the unit filename and cannot contain whitespace; `%I` is the
unescaped form where argument confusion arises. Genuinely unasserted: that a runId interpolated into
`qds-run@<runId>.service` comes back out of `%i` **unchanged** (systemd escapes `/`, `.`, `-` in
instance names).

fix-F deferred this in round 1 only because cluster A was mid-flight changing `IN_BOX_RUN_ID_RE`'s
doc in `scripts/pipeline-run.ts:~1592`. **Cluster A has landed**, so it is unblocked.
Do: correct the comment, and add one assertion that the fleet's runId grammar survives systemd
instance-name escaping. Test-only — it cannot move the pin. Re-run
`bun test tests/providers/exedev/image-contract.test.ts` after and confirm `DEFAULT_IMAGE_BUILD_ID`
still matches `c2b0c0f0531078e1`.

### 1.2 File the GitHub issues

Check for duplicates FIRST — several neighbours already exist: **#186** (DF2.10 re-pin bundle,
image-content fixes blocked on deriveBuildId, explicitly tagged "DF1.10 seam"), **#187** (build tag
is a digest input; the workflow's first run cannot match the live-booted pin), **#188** (AC5 basename
attribution), **#181** (in-box ack round trip, DF1.10 seam), **#210** (live-gated e2e tests are
invisible to every static gate), **#211** (`runAgentPhase` unreachable after the `PhaseKind`
narrowing), **#162** (test-suite hermeticity and known flakes), **#215** (fleet-lock load flake).

Prefer commenting on an existing issue over opening a near-duplicate. Full bodies for every item
below are already drafted in the story's Review Findings section — reuse them rather than rewriting.

| # | Item | Shape | Notes |
|---|---|---|---|
| I1 | **DF1.10 re-pin bundle** — F-D1..F-D7 + F6 | ONE issue, checklist of 8 | Mirror #186's shape. Cross-link #186/#187/#188. This is what Phase 2 closes |
| I2 | **A2 — the shipped pin is CI-UNPROVEN** | own issue | `DEFAULT_IMAGE_REF` was hand-pushed (three re-pins in one sitting); the publish workflow's digest↔buildId equality check has never run end to end against the digest that ships. DF2.10's "first pin this repository did not push by hand" property has been given back. Closed by Phase 2's CI publish. Cross-link #187 |
| I3 | **A3 — INV-RES-3 restored positionally** | own issue, DF3.3 seam | The one-key property holds because the CALLER relocated (correct per R7), but `src/fleet/resident.ts` still spawns pi off whatever `OPENROUTER_API_KEY` its env carries, nothing asserts in-box, and deviation **C16 deleted the second-mint exhibit** that would have caught a regression. Round 1 put a key-provenance assertion in the tier-4 live test instead of editing DF3.3's file. Wants an in-code assertion that the key came from the unit's `EnvironmentFile` path |
| I4 | **A4 — the unit couples DF1.11's channel to DF1.10's start** | own issue, DF1.11 seam | `qds-run@.service`'s `AssertPathIsDirectory=/run/steering` means the DF1.10 unit **refuses to start** if DF1.11 relocates the channel — until a re-pin. Ordering is handled (`Requires=systemd-tmpfiles-setup.service`), so it is effectively an image-integrity assertion, but the coupling must be known before DF1.11 moves anything |
| I5 | **D2b — teardown artifacts failure is log-only** | own issue, DF2.1 seam | Round 1 made an artifacts failure non-fatal so `destroy` always runs (a workload-planted symlink could otherwise pin a billing box open forever). Recording that failure ON the run record needs a new `EXTENSION_NAMESPACES` entry in `src/providers/run-record.ts` (DF2.1's, and INV-IBOX-9 says the record schema is closed). Marked `TODO (cross-cluster)` at `runArtifactsStep` |
| I6 | **D28 — `fillRun` throws a bare `Error` with no `code`** | own issue | `src/providers/driver.ts:~927`. `dispatch.ts`'s classifier reads `code` off driver rejections, so a test cannot assert one today. Blast radius is **CRITICAL** (14 impacted, 4 direct, 6 processes) — wants its own round |
| I7 | **F2 — C37 narrowed a MERGED story's property** | own issue, DF2.10 amendment | DF2.10 AC5's property was "no npm tree in the image at all"; the gate now ADMITS one at `opt/qds-factory/node_modules` by exact path. Tight (two packages, `--frozen-lockfile`, in-Dockerfile probe fails the build on a third) and disclosed in the Dev Agent Record, but **no DF2.10 amendment records it** |
| I8 | **D5 — `.qds/` is deletable by the workload's own git** | own issue, accepted residual | AC2b required moving the manifest pair INTO the checkout, so any code phase running `git clean -xdf` deletes `pipeline.yaml` + `run-context.json` mid-run (`-x` explicitly ignores the exclude file the design leans on). Documented as out-of-contract in round 1; wants a belt-and-braces copy outside the checkout |
| I9 | **Evidence churn** | comment on **#162** first | A test under `tests/phase-engine/trace/` rewrites committed evidence at `_bmad-output/evidence/df1-4/{e2e-two-phase-trace.db,two-page-read.json}` in place, so every full suite run dirties the tree with fresh UUIDs/timestamps. Pre-existing, not DF1.10's. Trap for anyone who runs the suite then `git add -A` |

### 1.3 Wire the seams into the story files — THIS IS THE POINT OF THE EXERCISE

An issue nobody's story references is an issue nobody does. For each, add a line to the OWNING
story's spec so it is visible when that story is picked up, and check it off in DF1.10's own doc.

- `.../stories/df1-10-in-box-phase-engine.md` — in the **Review Findings** section, replace the
  prose deferral lists with the real issue numbers, as checkbox items. Keep the reasoning; add the refs.
- `.../stories/df1-11-in-box-steering-executor.md` — add **I4** near its channel-lifecycle scope.
  DF1.11 relocating `/run/steering` without a re-pin will make every DF1.10 run refuse to start.
- `.../stories/df3-3-resident-orchestrator-agent.md` — add **I3** against INV-RES-3. Note explicitly
  that C16 removed the regression detector, so the invariant is currently held by placement + one
  live test only.
- `.../stories/df3-7-approval-gate-bridge.md` — note that DF3.7 polls the marker path DF1.10 just
  hardened, and that `ENGINE_MARKER_FOREIGN` / `ENGINE_JOURNAL_ORPHANED` are new contract surface
  its bridge will meet.
- `.../stories/df2-1-provider-driver-run-records.md` — add **I5** (the extension namespace).
- `.../stories/df2-10-factory-owned-boot-image.md` — add **I7** (the AC5 amendment) and **I2**
  (the pin is CI-unproven; DF2.10's own headline property has regressed).
- `_bmad-output/sprint-artifacts/sprint-status.yaml` — append the issue numbers to DF1.10's status
  comment so the sprint view carries them. Keep `status: in-review` until the live round passes.

### 1.4 Live e2e round — MANDATORY before merge

**Use the `qds-live-e2e` skill** (`.claude/skills/qds-live-e2e/SKILL.md`). Do not improvise it.

The previous 20-of-20 green result was on the PRE-REVIEW SHA and **does not carry**: wave 2 changed
what several tiers assert. Specifically re-verify:
- **The new status vocabulary.** `fleet status` gained `engine-failed` and `not-running`; an absent
  marker is now corroborated by `systemctl is-active`. Round 2 already fixed one **live-round killer**
  here — `tier2-in-box-engine.live.test.ts:450`'s `if (state !== "running") break;` would have failed
  a HEALTHY run, because the engine writes the marker then exits and a poll landing microseconds
  early sees absent-marker + inactive-unit. Confirm the `POLLABLE_STATES` replacement behaves live.
- `fleet run` now makes **2** driver calls on the success path (start + `systemctl is-active`), and
  `fleet status` makes a second exec per absent-marker row.
- **`trace/trace.db-shm` is no longer in the artifacts tar**, and the box runs a best-effort
  `wal_checkpoint(TRUNCATE)` before tarring.
- **Teardown continues to revoke+destroy after an artifacts failure** (exit 0 + a
  `teardown.artifacts_failed` log line at `status:"error"`, `outcome:"continued"`).
- **New refusals**: `run-not-startable`/`gate-failed`, `start-failed`/`unit-refused`,
  `qds-dir-present` (fill), `ENGINE_MARKER_FOREIGN`, `ENGINE_JOURNAL_ORPHANED`.
- The tier-4 **key-provenance** assertion added for I3, and tier-3's raised/lowered ceilings (the old
  runner ceiling was HALF its own priced worst case, and a bun test-timeout abort is the one path
  that skips the `finally` — that is how boxes and live capped keys leak).

Round-exit hygiene, every round: fleet `{"vms":[]}`, key hashes set-equal to the pre-round snapshot,
no `fleet.lock`. Commit the evidence JSONs.

### 1.5 Merge

Once the live round is green and CodeRabbit's round-2 comments are resolved: merge PR #216 into `dev`.
Flip DF1.10 to `done` in `sprint-status.yaml` with the usual one-line evidence summary.

## PHASE 2 — on `dev`, after DF1.10 merges: the re-pin bundle (closes I1 + I2)

Only now is the publish workflow available. Branch off `dev`, make the image changes, and follow the
bootstrapping ritual at `.github/workflows/publish-exedev-image.yml:40-50`.

**Take these (mechanical, low-argument):**
- **F-D5** — `EnvironmentFile` applies AFTER systemd's default PATH, so a `PATH=` line in
  `/home/exedev/app/.env` breaks the wrapper's bare `bun` after four build-time `command -v bun`
  assertions passed. One-token fix: `exec /usr/local/bin/bun …` (the assertion block already pins
  that exact path).
- **F-D6** — the `su`-based PATH assertions depend on PAM/`login.defs`; print `su`'s own output on
  the failure branch so a PAM regression is distinguishable from a PATH regression.
- **F-D7** — the AC6 allowlist is grepped out of the file it validates, so the unit self-authorises
  its own `QDS_*` VALUES. Pin `QDS_TEAM_RUNNER=local` as a literal in the scan.
- **F-D4** — `/opt/qds-factory` ships the root `package.json` and `bun.lock` into a customer-facing
  box, against the explicit disclosure argument behind the `COPY scripts/` narrowing. **Verify first**
  whether `bun` itself consults the root `package.json` (`type`/`imports`/`exports`) when running an
  explicit `.ts` entry against a sibling `node_modules` — round 1 confirmed no repo code reads them,
  but did NOT establish that.
- **F6** — `contextFilesUnder` skips only `node_modules` while `.dockerignore` also carries
  `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `*.log`, `tests`, `docs`. A stray `.env.local`
  under a COPY'd subtree changes the buildId **without changing the image**, so a dev tree and CI's
  clean checkout derive DIFFERENT buildIds for an identical image. This changes the derivation, so it
  belongs in the same re-pin.

**HOLD these — decisions, not bugs:**
- **F-D1 (HIGH)** — `RuntimeDirectory=journal trace` uses LITERALS in a template unit, so every
  instance shares `/run/journal`, and `Preserve=yes` carries run A's terminal marker into run B.
  Proposed: `RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace` with `runMarkerRoot()` following.
  **Why hold:** that is a coordinated code+image change to the exact marker-identity surface round 1
  just rewrote, and its exploitable path is ALREADY CLOSED by the TypeScript runId comparison. It
  deserves its own round with its own live proof, not a ride-along.
- **F-D3 (MED)** — `NoNewPrivileges=yes` makes `sudo` inert for the whole process tree, and this unit
  by its own justification "runs AGENT-AUTHORED code as the box's login user", which on a dev box
  routinely means `sudo apt-get install …`. **This is a policy call for the operator**: dropping it
  weakens the boundary around agent-authored code; keeping it constrains what a `code` phase may
  legally do. Ask, decide, and record the decision in the stanza either way.
- **F-D2 (MED)** — `PrivateTmp=yes` hides the run's `/tmp` from every ssh-based host operation.
  Harvest is verified UNAFFECTED (none of `harvest.ts`'s three source sets contains a `/tmp` path);
  the real exposure is `childEnv()` (`scripts/pipeline-run.ts:~249`) passing `TMPDIR` through to every
  manifest-borne command, so agent/pi/bun writes to `/tmp` are invisible to a human debugging over
  ssh and vanish at unit stop. Decide whether `/tmp` should be host-debuggable.

Phase 2 needs its own live round against the NEW pin, and it discharges **I2** by construction —
the pin will finally have been CI-published with gate B run end to end against the shipping digest.

## Rules that bit round 1 — do not relearn them

1. **Never a bare `bun test`.** Per `CLAUDE.md`: tee to a log, then strip CR + ANSI before grepping,
   or `(fail)` silently matches nothing:
   ```bash
   bun test > /tmp/qds-test.log 2>&1; echo "exit=$?"
   tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
   ```
2. **`PIPESTATUS`, not `$?`, after a pipe.** `bunx tsc --noEmit | tail -30; echo $?` reports *tail's*
   exit. Round 1's baseline captured meaningless zeros this way.
3. **Revert evidence churn before staging.** Running the suite rewrites
   `_bmad-output/evidence/df1-4/*`. `git checkout -- _bmad-output/evidence/` before `git add -A`.
4. **The editor's diagnostics lie during concurrent edits.** Three times in round 1 they reported
   syntax errors in files that `tsc` said were clean. The compiler is the authority.
5. **Subagents cannot write report files** — a hook blocks it, and mailbox replies truncate at 16 KB.
   Recover full reports from their transcripts:
   ```bash
   jq -r 'select(.type=="assistant")|.message.content[]?|select(.type=="text")|.text' \
     ~/.claude/projects/-Users-steve-QDS-Factory/<session>/subagents/agent-a<name>-*.jsonl
   ```
6. **Before editing a symbol**, run gitnexus `impact({target, direction:"upstream"})` and report the
   blast radius; **before committing**, `detect_changes()`. Repo rule, `CLAUDE.md`.
7. **Do not touch** `src/fleet/resident.ts` or `src/phase-engine/steering.ts` (DF3.3/DF1.11-owned, and
   the story forbids it), and **add no field to DF2.1's run record** (INV-IBOX-9) — `extensions` is
   the sanctioned open map.
