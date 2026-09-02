# W2-FIXTURE

Scope: `tests/providers/exedev/fixtures/fake-exedev.ts` and
`tests/providers/exedev/image-assets.test.ts` only. `image-contract.test.ts` was
read but never written (verified: `git diff --stat` shows its 219 changed lines
are the parallel fixer's, and my only write to that path was zero).

## Patched

| ID | File:line | What changed | Why |
|----|-----------|--------------|-----|
| P1.1 | `image-assets.test.ts:266-274` | `directive-set` policy's `expected` record: `Unit: ["Description","After","Requires","AssertPathExists"]`, `Service: ["Type","User","Restart","TimeoutStopSec","TimeoutStartSec","EnvironmentFile"]`, `Install` key DELETED | FIX-OCI added `Requires=`/`AssertPathExists=`/`TimeoutStopSec=`/`TimeoutStartSec=` and deleted `[Install]`. Verified against the real unit: the file has no `[Install]` header at all (only the comment at `qds-run@.service:100-113` explaining that its absence IS the policy — an enabled per-run instance reboots into the same double-spend `Restart=no` refuses). Comment added at the deleted key so the next author cannot "restore" it. |
| P1.2 | `image-assets.test.ts:350-357` | `expect(unitKeys("Service")).toEqual([...])` → the same six-key Service list | Same change, stated flatly in the no-ExecStart test. |
| P1.3 | `image-assets.test.ts:626-636` | `MUTATIONS[1].mutate` re-anchored from `t.replace("[Install]", …)` to `t.replace(\`EnvironmentFile=${EXPECTED_ENV_FILE}\`, \`Restart=on-failure\n…\`)`; `rejectedBy` unchanged | Verified the finding: `[Install]` survives in the unit ONLY inside a comment body (line 100), so the old anchor spliced `Restart=on-failure` into a comment the parser correctly ignores — the row would then fail as "rejected by nobody", reading as a broken policy rather than a stale mutation. New anchor keeps the intent exactly (a LATER `Restart=` in `[Service]` that last-wins makes live) and still trips `restart-no` + `directive-set`. Confirmed the literal `EnvironmentFile=/home/exedev/app/.env` first occurs at the directive (line 79), not in the comments that mention `EnvironmentFile=` bare (lines 28, 38). |
| P2 | `image-assets.test.ts:534-591` | "the unchecked surfaces are empty…" REPLACED by "the AC6 scan is WIDE: /etc/systemd/ recursively, plus the login/session files" | Verified green-by-luck: the Dockerfile's new scan (`Dockerfile:429-440`) uses `grep -rqE '^[[:space:]]*(Default)?Environment=.*QDS_' /etc/systemd/` and one recursive pass, so none of the three forbidden literals (`DefaultEnvironment=`, `system.conf(.d)`, `.service.d`) can ever appear — the old test passed because the widening was spelled differently. The replacement is positive and goes RED on narrowing: (a) regex requires a recursive `grep`, an `Environment=`-anchored `QDS_` pattern and the target `/etc/systemd/` followed by whitespace — re-narrowing to `/etc/systemd/system/qds-run@.service` fails the trailing-`\s`; (b) each of the nine login/session paths asserted by name; (c) the unit-file leg still present. Asset-directory glob kept. |
| G9 | `fake-exedev.ts:748-757` (+ knob doc `:110-118`) | `imageMarkerTruncated` now returns `exitCode: 137` alongside `truncated: true` (was `0`) | Verified in the real seam: `sshCommand` (`transport.ts:70-84`) passes `kill` into `readBounded` and spawns with `killSignal: "SIGKILL"`, so a cap breach kills the exec and truncation + 137 arrive together — exactly what `transport.ts:174-180` states and what `EXEC_KILLED_EXIT = 137` (`:224`) routes to `image-marker-unreachable`. Empty stderr kept: a SIGKILLed process says nothing (the fake's own `sshStderr` already returns `""` for non-255). Re-read the wave-1 `readBoxFile` (`transport.ts:152-185`, now one shared deadline): the `read.truncated` check still precedes the exit-code check, so the fake's cap hit still classifies `oversized`. The point of the change is that it now classifies `oversized` *for the right reason* — swap those two blocks and the fake finally goes red with the real box instead of staying green alone. |
| G10 | `fake-exedev.ts:381-401` (option + doc), `:571-577` (create hook) | New OPT-IN `FakeExeDevOptions.markersByImage?: Record<string, string \| null>` — at `new`, if the create's `--image` ref has an entry, the box is `configure`d with that marker | Verified the finding: `creates.push({… image: m[4]})` recorded the ref and the marker branch (`:700`) served `cfg.imageMarker ?? DEFAULT_IMAGE_MARKER` regardless, so `new ExeDevDriver({ image })` with no matching `imageBuildId` (the documented-legal seam — `driver.ts:529-531` leaves `imageBuildId` at `DEFAULT_IMAGE_BUILD_ID`) produced a box gate B passed green. **ADDITIVE ONLY**: no map, or no entry for the ref ⇒ zero behaviour change; applied through the ordinary `configure` path so a later explicit `configure(name, {imageMarker})` still wins. Proof of "default unchanged" below. |
| G10-test | `image-assets.test.ts:758-828` | New describe exercising the knob: a foreign digest ref + foreign `buildId`, driver built with `{image: FOREIGN_REF}` only, then gate B's own two calls — `readBoxFile` + `imageMarkerFailure(read, driver.imageBuildId)` (`setup-gate.ts:526,532`) — asserted to return `image-marker-mismatch` naming both buildIds and the foreign ref. Second half re-uses the SAME fake to create a repo-pinned box (no map entry) and asserts `imageMarkerFailure(...) === null`. | Gate B is exactly those two calls, so this asserts the real logic in ms rather than a 20 s create→fill→gate round. **PARKED, and the header says so**: its home is `image-contract.test.ts`; it is here only because that file was mid-edit by the parallel fixer and a knob with no check is how a fake grows a hole. |
| G15 | `image-assets.test.ts:47` (`ATTACH_PATH`), `:353` + `:365` (wording four→five), `:478-500` (new fourth copy), `:501` (Dockerfile copy renumbered fifth) | Added `BOX_STEERING_ROOT_SH` as the fifth resolver: reads `attach.ts` source, pins the declaration marker, extracts `${QDS_STEERING_ROOT:-…}` and compares to the tmpfiles path; then asserts `APPEND_SCRIPT` and `ACK_READ_SCRIPT` still resolve their root THROUGH that constant | Verified: `attach.ts:80` declares it and `:229`/`:292` use it — it is the leg that actually writes `inbox.ndjson` into the channel the tmpfiles entry provisions, and its only other pin was a hard-coded literal in `tests/fleet/gate-verbs.test.ts:1165`. The extra "is it used" assertions exist because pinning a value nothing executes is the same hole one level up. |
| G16 | `image-assets.test.ts:378-435` (new `DOCKERFILE_DIRECTIVES`, `normaliseMode`, `tmpfilesViolations`), `:720-748` (rewritten negative control) | The tmpfiles checks are now a `violations()` in the shape `POLICIES` uses (entry-count, entry-shape, path, mode, ownership, and the Dockerfile build-time assert tie), and the mutation table runs THEM — each row naming the check that must reject it, plus a fifth row (a dropped field) and two accept-controls (comments/blanks, and the shipped file) | Verified: `tmpfilesEntries` is a pure `split/trim/filter/split` with no policy in it, so `.not.toEqual(good)` held for any implementation that does not return `good` for every input, and neither real assertion was ever run against a mutated entry. Also deduplicated: the inline comment-stripped Dockerfile read in the cross-copy test and in the new P2 test now both use the hoisted `DOCKERFILE_DIRECTIVES`, and the duplicated `^0+(?=\d)` regex is one `normaliseMode`. |

## False positives

| ID | Why it does not hold, with evidence |
|----|--------------------------------------|
| (brief, gate 2) | **"`fake-exedev.ts` has fleet consumers"** — it does not. `grep -rn "fake-exedev" --include=*.ts tests/ src/ scripts/` returns exactly three importers, all under `tests/providers/exedev/` (`setup-gate.test.ts:29`, `image-contract.test.ts:53`, `driver.test.ts:25`), plus a doc reference in `src/providers/exedev/transport.ts:32`. Nothing under `tests/fleet/` imports it. Gate 2 was run anyway; its failures are attributed below and none of them touch this fixture. |
| (brief, G9) | **"If this change breaks `image-contract.test.ts:1183`…"** — it does not, and no expectation there needs updating. `readBoxFile` checks `read.truncated` before `read.exitCode` (`transport.ts:181-184`), so a `{truncated: true, exitCode: 137}` read still classifies `oversized` and the assertion `/exceeds the transport read cap — refused unparsed/` is unchanged. Proven empirically below (38 pass with the old fake, 38 pass with mine, identical contract file). |

Every other finding in the brief (P1.1–P1.3, P2, G9, G10, G15, G16) was confirmed
against the real files before patching. None were refuted.

## Expectations the image-contract fixer must update (if any)

| file:line | current | new | which finding |
|-----------|---------|-----|---------------|
| — | — | **NONE** | — |

Nothing in `image-contract.test.ts` needs to change for either fixture edit.
Two things worth knowing:

1. `df210-marker-truncated` (`image-contract.test.ts:1183`) now runs against a
   `{truncated: true, exitCode: 137}` ExecResult instead of `{truncated: true,
   exitCode: 0}`. Same classification, same assertion, same result — but the
   case is now a real regression detector for `readBoxFile`'s
   truncated-before-exitCode ordering rather than a case that passed either way.
2. `fakeExeDev({ markersByImage })` now exists (off by default). The G10 proof
   test is **parked at the bottom of `image-assets.test.ts`** and marked as
   such in its docblock — it belongs beside gate B in your file. Move it when
   convenient; it needs no changes, only the imports `ExeDevDriver`,
   `DEFAULT_IMAGE_BUILD_ID`, `IMAGE_MARKER_PATH`, `imageMarkerFailure` (all from
   `driver.ts`), `readBoxFile` (from `transport.ts` — driver.ts does NOT
   re-export it), and `DEFAULT_IMAGE_MARKER` + `fakeExeDev` from the fixture.

## Gate output

### 1. `bun test tests/providers/exedev/`

Baseline BEFORE my edits (the three predicted wave-1 failures, and only those):

```
error: directive-set: DF1.10 adds exactly one line (ExecStart=/usr/local/bin/qds-engine run %i); pinning the set makes that addition a deliberate, visible change
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > every AC6 policy holds on the file as shipped [4.30ms]
error: expect(received).toEqual(expected)
(fail) DF2.10 AC6 — qds-run@.service ships the policy the AC states > no ExecStart — DF1.10 owns it, and its arrival must be a visible change [0.17ms]
error: AC6's named negative control: Restart=on-failure
(fail) DF2.10 AC6 — negative controls: each assertion rejects the wrong file > every mutation is rejected by exactly the policies named, and by no others [0.34ms]
 223 pass
 3 fail
 1276 expect() calls
```

AFTER (`/tmp/pr184-r4/w2-fixture.log`, filtered through the mandatory
`tr '\r' '\n' | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g'`):

```
 230 pass
 0 fail
 1327 expect() calls
```

(223 → 230: 3 repaired + 4 net new — the P2 replacement, the G15 fifth copy and
G16 rows land inside existing tests; the +4 are the G10 proof test and the
parallel contract fixer's additions.)

`image-assets.test.ts` alone: `15 pass / 0 fail / 108 expect() calls`, exit 0.

### 2. `bun test tests/fleet/`

```
(fail) approvers.ts — authentication (AC2/AC4, INV-APPROVE-2) > every fixture entry authenticates its documented sentinel token [7551.43ms]
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > loser teardown prices box hours into the injected cost ledger (DF2.8) [5016.05ms]
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > one loser's destroy failing never wedges disposal: logged, skipped, siblings still torn down [11173.35ms]
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > a hung loser teardown hits its deadline: disposal completes, the timeout is named, the lock survives [5619.43ms]
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > a FAILED probe is not a clean absence: an ssh-255 tick cannot reset a dead arm's corruption streak [2641.29ms]
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > a ready:false gate excludes the arm from the race entirely: setupFailed, left alive, siblings decide the winner (AC4 × AC5) [5007.34ms]
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > a THROWN gate error is an arm failure, not a race loss: classified armFailed, excluded from entrants, left alive
(fail) fleet fanout patterns (DF3.2 AC1-AC6, AC9) > race (AC5) > harvest failing during loser disposal logs loser-teardown-failed, leaves THAT box alive, and still disposes the sibling [6598.33ms]
 1051 pass
 8 fail
```

ATTRIBUTED — none are mine, and `tests/fleet/` does not import this fixture at
all (see False positives). That run was launched CONCURRENTLY with the exedev
suite on the same machine; the seven `patterns.test.ts` failures are all the
same run-lock temp-file race under load:

```
ENOENT: no such file or directory, open '/private/var/folders/.../fanouts/fan-20260902-2d0728.lock.…lktmp'
    at claim (/Users/steve/QDS-Factory/scripts/lib/run-lock.ts:820:10)
```

Re-run in isolation, both files together:

```
(fail) enrolApprover — the writer that makes the entropy assumption true (D9) > enrolment TRIMS the id but never CASE-FOLDS it — whitespace is normalized, case is identity [6023.07ms]
 160 pass
 1 fail
```

`patterns.test.ts` fully green in isolation. The remaining approvers failure is a
DIFFERENT test from the one that failed in the concurrent run (load-dependent —
these are multi-second KDF tests). `approvers.test.ts` run entirely alone:

```
 114 pass
 0 fail
 353 expect() calls
```

### 3. `bunx biome check tests/providers/exedev/`

```
Checked 8 files in 957ms. No fixes applied.
```

### 4. `bunx tsc --noEmit`

```
tests/fleet/e2e/tier1-attach-transport.live.test.ts(50,3): error TS6133: 'fleetCleanupProblems' is declared but its value is never read.
tests/fleet/e2e/tier1-attach-transport.live.test.ts(57,3): error TS6133: 'settleRun' is declared but its value is never read.
tests/fleet/e2e/tier1-attach-transport.live.test.ts(59,3): error TS6133: 'writeEvidenceQuietly' is declared but its value is never read.
tests/fleet/e2e/tier1-attach-transport.live.test.ts(121,11): error TS6133: 'destroyFailures' is declared but its value is never read.
tests/fleet/e2e/tier1-attach-transport.live.test.ts(123,9): error TS6133: 'finalBoxes' is declared but its value is never read.
tests/fleet/e2e/tier1-attach-transport.live.test.ts(295,19): error TS2304: Cannot find name 'writeEvidence'.
tsc-exit=2
```

**ZERO errors in either file I touched.** All six are in
`tests/fleet/e2e/tier1-attach-transport.live.test.ts` — the wave-1 live-e2e
fixer's file. The `TS2304: Cannot find name 'writeEvidence'` at :295 alongside
an unused `writeEvidenceQuietly` import at :59 looks like an incomplete rename
in that file and is worth flagging to whoever owns it; it is not mine to patch.

### 5. G10 — the default path is unchanged (proof)

The naive before/after is confounded: `image-contract.test.ts` is being edited
in parallel (`git diff --stat` = 219 changed lines), and its count moved 35 → 38
between my first and second runs for that reason alone. So the proof holds the
CONTRACT FILE FIXED and varies only the fixture:

```
# same working-tree image-contract.test.ts for both rows
fixture = git show HEAD:tests/providers/exedev/fixtures/fake-exedev.ts   →  38 pass  0 fail  551 expect() calls
fixture = my patched fake-exedev.ts                                      →  38 pass  0 fail  551 expect() calls
```

Byte-identical outcome, including the 551 expect() count. Mechanics (no git
index touched, restore verified by `cmp`):

```
mine-backup-ok        # cmp: my file == the backup taken before the swap
run-exit=0
RESTORED-ok           # cmp: working tree == my file again, after the swap
 38 pass
 0 fail
 551 expect() calls
```

That covers every current consumer of the fixture's default path:
`image-contract.test.ts` is the only file that uses `imageMarkerTruncated` at
all (`grep -rn imageMarkerTruncated tests/ src/ scripts/`), and the full
`tests/providers/exedev/` run above (230 pass / 0 fail) covers the other two
importers, `setup-gate.test.ts` and `driver.test.ts`.

## Decisions taken

1. **`[Install]` dropped from `expected` rather than set to `[]`.** An empty
   array would make `directive-set` report "unexpected section [Install]" only
   after the section came back and carried a directive; dropping the key makes
   the section's mere REAPPEARANCE the finding, which is what the unit's own
   comment (`qds-run@.service:100-113`) asks for. Fail-safe.
2. **`MUTATIONS[1]` re-anchored, not deleted.** The row is the file's headline
   negative control (the one a `content.includes("Restart=no")` test sails
   past). Its `rejectedBy` is unchanged, so the row still proves both policies
   can fail; only the anchor moved, and the reason is recorded in-place so the
   next `[Install]`-shaped edit does not silently re-break it.
3. **P2 asserts a trailing `\s` after `/etc/systemd/`.** Without it,
   re-narrowing the recursive target to `/etc/systemd/system/qds-run@.service`
   would still match the prefix and the replacement test would be green-by-luck
   in exactly the way the test it replaces was. Strict reading taken.
4. **G16 got a fifth mutation row (a dropped field) it was not asked for.**
   `tmpfilesViolations` returns early on a short entry precisely so the
   cross-copy test's destructure cannot compare `undefined` to `undefined`; a
   guard with no row exercising it is the same unexercised-assertion defect the
   finding is about. One row, no machinery.
5. **G10's knob keyed by image ref, not "derive a buildId".** A map is data the
   test supplies; a derivation would be the fake inventing an image registry
   nobody asked for. `null` means "that image bakes no marker", matching
   `FakeBoxConfig.imageMarker`'s existing `null` semantics rather than inventing
   a second spelling.
6. **G10's proof test uses gate B's two functions, not a gate cycle.**
   `setup-gate.ts:526,532` composes gate B out of exactly `readBoxFile` +
   `imageMarkerFailure`, so this asserts the identical logic in milliseconds
   instead of adding a ~20 s create→fill→gate round to a suite that currently
   runs in ~100 ms. It is parked in my file and flagged for relocation rather
   than written into the parallel fixer's file.
7. **`DOCKERFILE_DIRECTIVES` and `normaliseMode` hoisted.** Three call sites
   were about to carry the same comment-stripping read and the same
   `^0+(?=\d)` regex. Deletion over addition; no behaviour change.
8. **Nothing committed, staged, or pushed.** The one write outside my two files
   was the temporary fixture swap in step 5, restored and verified with `cmp`
   in the same command.
