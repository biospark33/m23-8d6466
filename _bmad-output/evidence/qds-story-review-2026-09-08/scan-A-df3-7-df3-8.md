# Scan A — DF3.7 (Approval-Gate Bridge) + DF3.8 (Host-Side Completion Watcher)

**Wave:** INITIAL SCAN, QDS story-review campaign 2026-09-08
**Reviewer scope:** dependency-pair A — the writer↔reader contract (DF3.7 composes the observe
primitive + chain; DF3.8 calls it from a detached sweep). Both stories held in one context to catch
drift a one-story-per-agent reviewer cannot see.
**Repo state reviewed:** branch `dev` @ `fa7d0e26`. Neither `src/fleet/run-completion.ts` nor
`src/fleet/observe.ts` exists yet; both stories are pre-development.
**Drift rule applied:** shipped code wins unless the shipped code contradicts the ADR. No shipped
code was found to contradict the ADR in this pair's blast radius, so every conflict below resolves
against the SPEC.

---

## 0. Method / what was actually read

Every file, symbol and line number cited by either story was opened. Reads performed:

`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (all 146 lines, twice) ·
`src/phase-engine/journal.ts` (marker derivation + `writeTerminalMarker`) ·
`src/fleet/fanout-primitive.ts` (constants, `boxMarkerPath`, `classifyMarkerRead`,
`readMarkerVerdict`, `markerUnusableGivesUp`, `runRace`, `probeArm`) ·
`src/providers/exedev/transport.ts` (`readBoxFile`, `BoxFileRead`) ·
`src/providers/harvest.ts` (`BOX_RUN_ROOT`, `boxRunRoot`) ·
`src/fleet/status.ts` (marker read + unit-liveness arm) · `src/fleet/run.ts` (`unitActivity`,
`RUN_UNIT_PREFIX`) · `src/fleet/verbs.ts` (verb registry + exit tables) ·
`scripts/fleet.ts` (dispatch lock, `runDestructive` lock, verb routing) ·
`scripts/lib/run-lock.ts` · `src/reverify/runner.ts` + `src/reverify/approval.ts` +
`src/reverify/worktree.ts` · `src/fleet/approval-gate.ts` (cited region) ·
`src/providers/reaper.ts` + `src/providers/quota.ts` · `src/providers/teardown.ts` ·
`src/fleet/dispatch.ts` (cited region) · `oci/exedev/systemd/qds-run@.service` (whole file) ·
`_bmad-output/.../df1-10-in-box-phase-engine.md` ACs · both story files in full.

---

## 1. DF3.7 — Verified-correct elements (SACRED — must not be regressed by later fix waves)

These were checked against shipped code and are **right**. A later fix wave that "corrects" any of
these is introducing a regression.

| # | Element | Evidence |
|---|---------|----------|
| V1 | **The gate stays host-side and this story writes zero lines of it.** ADR `:94-95` says exactly this; the story's INV-IBOX-14 and AC1 enforce it. | ADR `:94-95`; story `:117` |
| V2 | **Correction of record is TRUE.** `requestApproval`'s only production caller is `src/reverify/runner.ts:461`; the port is built with no `teardown` seam at `runner.ts:430`; `scripts/pipeline-run.ts` contains `approval` zero times. Verified by read. | `src/reverify/runner.ts:430,461` |
| V3 | **Deviation 1 is the correct reading of the ADR.** "Awaiting marker" in Consequence 4 predates the audit; implementing it as a run-**completion** marker is what the ADR's own "host polls; gate ownership unchanged" requires. No ADR conflict. | ADR `:95`; story `:10,:99` |
| V4 | **`ok` must not be fed to reverify (AC2c).** `runner.ts:421` returns before the gate only on its *own* non-green verdict. An `ok:false` run whose tree re-verifies green legitimately reaches the pause. The two-layer doctrine (ADR "In-box placement is load-bearing" §5, R9) is preserved exactly. | `src/reverify/runner.ts:421` |
| V5 | **`teardown_at_pause_ms` / `chain_ms` absent-not-zero.** The gate really does omit it rather than zero it, for the reason quoted. | `src/fleet/approval-gate.ts:1124-1137` |
| V6 | **`MARKER_UNUSABLE_TICKS_LIMIT = 3` and `DEFAULT_PER_CALL_DEADLINE_MS = 10_000` at `fanout-primitive.ts:68` and `:55`.** Both line cites exact. | `src/fleet/fanout-primitive.ts:55,68` |
| V7 | **`DEFAULT_FANOUT_CEILING_MS` (1 h) is race-shaped and must not be inherited.** True: `:58`, and an unattended run routinely outlives it. Rejecting it is correct. | `src/fleet/fanout-primitive.ts:58` |
| V8 | **`readBoxFile` is DF2.2-owned and no `sh -c` string may be built under `src/fleet/`.** Confirmed as a live DoD, restated in `transport.ts`'s docblock and `fanout-primitive.ts:934`. | `src/providers/exedev/transport.ts:127-135` |
| V9 | **A non-zero `cat` is a refusal, never empty bytes (AC2b).** Shipped `BoxFileRead` models this as `unreadable{exitCode,stderr}`, distinct from `content`. | `transport.ts:130-139` |
| V10 | **The `$HOME`-persistent marker rejection is right for the stated reason**, and is *doubly* right now: `RuntimeDirectoryPreserve=yes` in the unit already makes the marker outlive the engine, so persistence buys only reboot survival, which AC3 handles. | `oci/exedev/systemd/qds-run@.service` (`RuntimeDirectoryPreserve=yes`) |
| V11 | **No security-invariant breach.** The marker carries no credential material; nothing is written in-box; no secret reaches argv; `/proc/uptime` (DF3.8) is non-sensitive; one-secret-per-box (§6.2) is untouched. | whole-story read |
| V12 | **`awaitDecision` has no production caller and must not gain one.** Confirmed. | `src/fleet/approval-gate.ts` |
| V13 | **AC6's no-doubles rule (FakeDriver may not be sole evidence for AC1).** Correct and consistent with DF3.4 AC6. | story `:67` |

---

## 2. DF3.7 — Findings

| ID | Sev | Location |
|----|-----|----------|
| DF3.7-B1 | BLOCKER | story `:9`, `:38`, `:86`, `:132` — marker path |
| DF3.7-B2 | BLOCKER | story `:65` (AC4) — `runMarkerPath()` on the host leg |
| DF3.7-B3 | BLOCKER | story `:23`, `:36`, `:73`, `:110`, `:124` — `--await-completion` on the wrong verb |
| DF3.7-B4 | BLOCKER | story `:63` (AC2) — four-kind classification contradicts shipped `classifyMarkerRead` |
| DF3.7-B5 | BLOCKER | story `:63` (AC2a), `:64` (AC3) — no liveness arm; cannot tell "running" from "engine died" |
| DF3.7-H1 | HIGH | story `:96` — "fan-out has no poll-interval constant" is false |
| DF3.7-H2 | HIGH | story `:98` — image-side amplifier is FIXED, not "filed, not fixed" |
| DF3.7-H3 | HIGH | story `:66` (AC5) — refusing on `pausing` breaks the gate's shipped resume arm |
| DF3.7-H4 | HIGH | story `:88`, `:123` — `reverify()` needs a host-repo cwd; never stated |
| DF3.7-H5 | HIGH | story `:62` (AC1) — the import fence as worded is not falsifiable |
| DF3.7-M1 | MEDIUM | story `:11`, `:12`, `:62`, `:65`, `:95` — five stale/incorrect line cites |
| DF3.7-M2 | MEDIUM | story `:93`, `:132` — `completedAt` is optional on the wire |
| DF3.7-M3 | MEDIUM | story `:110`, `:124` — no exit code named for `run-completion-unobserved` |
| DF3.7-M4 | MEDIUM | story `:76`, `:113` — live-test tier grammar |
| DF3.7-L1 | LOW | story `:54` — dependency edges incomplete |

### DF3.7-B1 — BLOCKER — the marker path in this story does not exist

**Where:** `df3-7-approval-gate-bridge.md:9` ("`/run` is tmpfs"), `:38` ("writes
`/run/journal/final.json`"), `:86` ("a real in-box run leaves `/run/journal/final.json`"), `:132`.

**Defect.** The story names the completion marker `/run/journal/final.json` in four places. The
shipped path is **`/run/qds-run/<runId>/journal/final.json`**. This changed under #217 F-D1 (DF1.10
round 1) and is now load-bearing in five independent places: `runMarkerRoot()` returns
`path.join(unidentifiedRunRoot(), "qds-run", runId)` (`src/phase-engine/journal.ts:97-100`);
`runMarkerPath()` appends `journal/final.json` (`:129-131`); the unit declares
`RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace`
(`oci/exedev/systemd/qds-run@.service`); the host-side mirror is
`boxRunRoot(runId) = "/run/qds-run/" + runId` (`src/providers/harvest.ts:112-127`); and the shape is
pinned by a regex, `BOX_MARKER_PATH_RE = /\/run\/qds-run\/[^/"\\\s'"]+\/journal\/final\.json/`
(`src/fleet/fanout-primitive.ts:713`). `<base>/journal/final.json` still exists in the codebase but
means something else entirely: `unidentifiedMarkerPath()` (`journal.ts:157-159`), the **pre-F-D1
shared root reserved for invocations that carry no run identity at all**, whose whole purpose is to
fail closed with `ENGINE_MARKER_FOREIGN` on a second unnamed invocation.

**Failure scenario.** Dev implements against the spec. `run-completion.ts` probes
`/run/journal/final.json`. On a real box that path is either absent (the normal case — the engine
wrote to the per-run root) or it is the *unidentified* shared marker left by some other unnamed
invocation. In the first case the observer polls to its window ceiling on every run and emits
`run-completion-unobserved` for runs that finished 40 minutes ago; the operator concludes the in-box
engine is broken. In the second case the observer reads a stranger's `ok` and drives harvest →
teardown → reverify → gate on a run that never settled — the exact wrong-marker defect DF1.10 round
1 closed.

**Fix recipe.** Replace every occurrence of `/run/journal/final.json` in this story with
`/run/qds-run/<runId>/journal/final.json`. Concretely:

- `:9` → `` — `/run` is tmpfs and a reboot wipes it; `$HOME` on ext4 persists; systemd is PID 1 ``
  (unchanged, but add: "the marker lives at `/run/qds-run/<runId>/journal/final.json`, per-run since
  #217 F-D1 — the shared `/run/journal/final.json` layout is retired and now belongs exclusively to
  `unidentifiedMarkerPath()`, `src/phase-engine/journal.ts:157`").
- `:38` → `` When DF1.10's engine settles and writes `/run/qds-run/<runId>/journal/final.json`
  (`{runId, ok:true, completedAt}`, 0600, by temp+rename), ``
- `:86` → `` a real in-box run leaves `/run/qds-run/<runId>/journal/final.json` readable through
  `driver.exec` ``
- Add to Technical Notes: "The path is created by the unit's
  `RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace` and survives the engine's exit because of
  `RuntimeDirectoryPreserve=yes` — so the marker is readable after the run settles and until the box
  is destroyed or rebooted."

---

### DF3.7-B2 — BLOCKER — AC4 mandates the one derivation the codebase forbids on the host leg

**Where:** `df3-7-approval-gate-bridge.md:65` (AC4), `:11`, `:125` (DoD contract line).

**Defect.** AC4 says the marker path is "the **single derivation** `runMarkerPath()` on both legs …
unset [`QDS_RUN_ROOT`] in the host process that computes the path to read", and makes an ambient
`QDS_RUN_ROOT` a start-up refusal. The shipped codebase has already solved this problem the other
way and left two docblocks explaining why the spec's way is wrong.

`src/fleet/fanout-primitive.ts:686-700`, on `boxMarkerPath`:

> Where THIS run's marker lives INSIDE the box … derived from `harvest.ts`'s `boxRunRoot(runId)` and
> deliberately **NOT** from `runMarkerPath()`. `runMarkerPath()` derives its base from the HOST's
> `QDS_RUN_ROOT` … journal.ts names this exact hazard: an ambient `QDS_RUN_ROOT` in an operator's
> shell, a test runner or a shell profile must not redirect a BOX probe. **It did**: every `test -f`
> went to the wrong in-box path, missed cleanly, and `fleet status` reported a whole fleet as
> `running` regardless of what the runs had done.

`src/providers/harvest.ts:116-127` reaches the same conclusion independently, and
`src/fleet/status.ts:21-24` states it a third time at its import. `journal.ts:60-67` closes the loop:
"`harvest.ts`'s `BOX_RUN_ROOT` is a host-side literal that deliberately does NOT call this function".
So there are **three derivations of one grammar by design**, kept honest by
`assertRunIdPathComponent` (`journal.ts:110-123`) and pinned by
`tests/fleet/fanout-primitive.test.ts`. AC4's "single derivation on both legs" is not a stricter
version of this — it is the defect this structure was built to prevent, and AC4's start-up refusal is
a weaker, run-time re-invention of a fix that is already structural and unbypassable.

**Failure scenario.** Dev implements AC4 literally: `run-completion.ts` calls `runMarkerPath(runId)`
and refuses at start-up if `process.env.QDS_RUN_ROOT` is set. `bun test` sets `QDS_RUN_ROOT` (that is
the seam's declared purpose, `journal.ts:52-59`), so the unit suite for the observer must either
unset it — hiding the very path bug it is testing — or the observer refuses inside its own suite.
Worse in production: a *fourth* derivation of the box path now exists in `src/fleet/`, so a future
edit to `boxRunRoot` silently leaves the observer behind, and the three-way agreement test does not
cover it.

**Fix recipe.** Replace AC4 in full with:

> 4. **(the marker path is derived once, host-side, from the box-side mirror)** Given the marker
>    path, Then the observer computes it as **`boxMarkerPath(runId)`**
>    (`src/fleet/fanout-primitive.ts:701`), the same host-side derivation `fleet status`
>    (`src/fleet/status.ts:1296`) and the fan-out race (`:1044`) already use, and **never** as
>    `runMarkerPath()` — which reads the HOST's `QDS_RUN_ROOT` and is correct only for code running
>    IN the box (the engine writing the marker). This is not a preference: an ambient
>    `QDS_RUN_ROOT` redirecting a box probe is a shipped, measured defect
>    (`fanout-primitive.ts:686-700` — "`fleet status` reported a whole fleet as `running` regardless
>    of what the runs had done"), and `boxMarkerPath` is immune to it by construction rather than by
>    a start-up check. The grammar agreement across the three derivations is enforced by
>    `assertRunIdPathComponent` and pinned by `tests/fleet/fanout-primitive.test.ts`; this story adds
>    no fourth derivation. A reboot before observation destroys the tmpfs marker and the run lands in
>    AC3's arm. *Negative controls, both MUST fail: an implementation calling `runMarkerPath()`
>    host-side, which polls a host-shaped path against a box and reads `absent` forever under any
>    ambient `QDS_RUN_ROOT`; and one that inlines its own `/run/qds-run/...` literal, which is a
>    fourth derivation the three-way agreement test does not cover.*

Also update DoD `:125` to name `boxMarkerPath`, and delete the now-moot ambient-`QDS_RUN_ROOT`
start-up-refusal clause from `:125` and from `:112`'s test list.

---

### DF3.7-B3 — BLOCKER — `--await-completion` is attached to a verb that does not start the run

**Where:** `df3-7-approval-gate-bridge.md:23`, `:36`, `:73`, `:110`, `:111`, `:124`.

**Defect.** The story's entire delivery surface is `fleet dispatch --await-completion`. **`fleet
dispatch` does not start the in-box engine.** It mints a run handle and provisions a sandbox
(`src/fleet/verbs.ts:74`, summary: "Mint a run handle and provision a sandbox"); a grep for
`qds-run`, `systemctl`, or any unit start in `src/fleet/dispatch.ts` returns nothing. The engine is
started by a **separate verb**, `fleet run <run-id>` (DF1.10 AC1), whose module docblock
(`src/fleet/run.ts:1-11`) reads:

> `fleet run <run-id>` does exactly one thing to a box that dispatch already provisioned and the
> setup gate already passed: it starts DF2.10's `qds-run@<runId>.service` instance. It never walks a
> phase, never holds the run, and never waits for the engine to finish. The engine's completion is
> observed by a DIFFERENT verb … **wiring any of that in here is what would make the host hold a run
> whose whole point is that it does not.**

So the specified flag is on the wrong verb, and the obvious relocation (`fleet run
--await-completion`) is explicitly refused by the shipped module it would land in — and by the ADR
clause the arc exists to serve (`:101-102`, "what host-side can never deliver — runs that survive
host disconnect — is the product").

**Failure scenario.** Dev ships `fleet dispatch --await-completion`. Operator runs it. Dispatch
provisions the box, the flag's observer starts polling `boxMarkerPath(runId)`, and no engine has been
started because nothing ran `fleet run`. The observer polls the full operator-set window (hours, by
design — the story explicitly rejects the 1 h fan-out ceiling as too short), then exits with
`run-completion-unobserved`, leaving a live billing box. The live e2e in AC6 would either encode the
same bug or quietly insert a `fleet run` call the story never specifies, at which point the flag on
`dispatch` is decorative and the composition is untested in the shape it ships.

**Fix recipe.** Two options; recommend (a).

**(a) — recommended.** Move the delivery surface to a new bounded, **exiting** verb and let DF3.8
extend it, which also removes DF3.8's edit to this story's module (see CC-A2):

- `:23` Overview → "`fleet observe <run-id>` observes one box's terminal marker and, on seeing it,
  runs the chain the operator runs by hand today."
- `:73` Trigger Surface row → `| \`fleet observe <run-id>\` | in-scope | \`tests/fleet/run-completion.test.ts\` | — |`
- `:110-111` Files to Modify → `src/fleet/verbs.ts` adds the **`observe` verb descriptor with its
  full exit table** (0, 1, 2, 4, 5, 6 — see DF3.8-H4), `scripts/fleet.ts` adds the `observe` block.
- Add to E2E Slice `:36`: "Given a run started by `fleet run <run-id>` (DF1.10 AC1 — the host process
  has already returned), When `fleet observe <run-id>` is invoked, Then …"
- Add a Trigger Surface out-of-scope row: `| a \`--await-completion\` flag on \`fleet dispatch\` or
  \`fleet run\` | out-of-scope — \`dispatch\` starts no engine (\`verbs.ts:74\`) and \`run\`'s
  contract is "start the unit and return" (\`src/fleet/run.ts:1-11\`); a flag that makes either hold
  the run inverts the ADR's own product claim (\`:101-102\`) | — | none |`

**(b) — if the operator insists on a foreground flag.** Put it on `fleet run` and amend
`src/fleet/run.ts`'s docblock in the same PR, stating that the flag is opt-in and that the default
shape is unchanged. This costs a change to a merged story's stated contract and should be an operator
decision, not a dev's.

---

### DF3.7-B4 — BLOCKER — AC2's "four-kind classification" contradicts the shipped classifier

**Where:** `df3-7-approval-gate-bridge.md:63` (AC2), `:24-27` (Overview), `:128` (DoD).

**Defect.** AC2 specifies its own mapping from `BoxFileRead`'s four kinds to observer behaviour. The
shipped classifier is `classifyMarkerRead` / `readMarkerVerdict`
(`src/fleet/fanout-primitive.ts:753-943`), which DF1.10 AC5 **requires** the fan-out poller and
`fleet status` to share *as code, not by inspection*. It produces a **`MarkerVerdict` with four
verdicts that are not the four kinds** — `absent | skip | unusable | settled` — and the mapping is
"about what the reading PROVES rather than which leg produced it". AC2 disagrees on three points:

1. **`unreadable`.** AC2: "`unreadable` (present at test, failed at `cat`) is a **skipped tick with
   no state change**." Shipped: `unreadable` → **`unusable`** (counts toward
   `MARKER_UNUSABLE_TICKS_LIMIT`), `fanout-primitive.ts:805-834`, with a docblock that rebuts the
   spec's reading directly: *"The box answered TWICE on this tick, so this is emphatically not 'no
   evidence' and must not be counted as an unanswered probe — an arm abandoned this way used to be
   logged as `probe-unanswered`, which asserts the opposite of what happened."*
2. **`absent`.** AC2: `absent` unconditionally means "not finished yet" and resets the streak.
   Shipped: only `probeExit === undefined || probeExit === 1` is a clean absence; every other
   non-zero probe exit (255 = ssh never connected, 137 = SIGKILLed at budget) is **`skip`** —
   *"Treating those as a clean read RESET the arm's corruption streak on every tick, so a dead arm
   could never reach MARKER_UNUSABLE_TICKS_LIMIT"* (`:770-784`).
3. **`skip` and its own limit do not exist in AC2 at all.** Shipped has a second, separate streak:
   `PROBE_SKIP_TICKS_LIMIT = 6` (`:101`), deliberately laxer than the unusable limit, with a stated
   reason (a transport failure is often transient; a temp+rename parse failure is permanent). AC2
   mentions one limit.

AC2 also never requires passing `expectedRunId`, which is the **host-side half of DF1.10 round 1's
marker-identity fix**: `readMarkerVerdict(driver, vm, path, deadline, runId)` returns `unusable /
marker-run-mismatch` for a foreign marker (`:880-901`), and `fleet status` passes it
(`status.ts:1296`). The story's own Technical Notes `:98` discuss marker identity but treat it purely
as an in-box engine refusal.

**Failure scenario.** Dev implements AC2 as written and re-derives the classification inside
`run-completion.ts` (which AC2's phrasing invites — it enumerates the mapping rather than naming the
function). Box A's marker becomes unreadable at `cat` (EACCES after a permission change, or EIO). The
observer records a skipped tick, resets nothing, counts nothing, and polls that box to the full
operator-set window — hours — while it bills. Separately, a box whose ssh drops answers `absent` with
`probeExit: 255` on every tick; the observer treats it as a clean "not finished yet" and polls a dead
box to the ceiling. Both are the exact failures the shipped streaks were added to bound, reintroduced
in a second copy the fan-out test suite does not cover. And with no `expectedRunId`, a duplicate box
name (which `reportDuplicateBoxNames` exists because it happens) lets another run's marker drive
harvest → teardown → reverify → gate on this run.

**Fix recipe.** Replace AC2 with an AC that **consumes** the shared classifier rather than restating
it:

> 2. **The observation contract is the shipped classifier, consumed as code, not restated.** The
>    observer reads through **`readMarkerVerdict(driver, vm, boxMarkerPath(runId), deadlineMs, runId)`**
>    (`src/fleet/fanout-primitive.ts:925`) — the same function `fleet status` (`status.ts:1296`) and
>    the fan-out race (`:1044`) use, which DF1.10 AC5 requires the callers to share as code rather
>    than agree on by inspection. It re-derives no mapping of its own. <br />**(a)** `absent` means
>    *not finished yet* and resets the unusable streak; `skip` (the probe produced no reading — ssh
>    255, SIGKILL 137, timeout) resets nothing and is counted on its own streak against
>    `PROBE_SKIP_TICKS_LIMIT` (=6, `:101`); `unusable` (unreadable at `cat`, oversized, unparseable,
>    non-boolean `ok`, or a `runId` that names another run) is counted against
>    `MARKER_UNUSABLE_TICKS_LIMIT` (=3, `:68`) via `markerUnusableGivesUp` (`:958`), after which the
>    run is abandoned to AC3's arm rather than polled to the window ceiling; `settled` carries a
>    boolean `ok`. <br />**(b)** `expectedRunId` is **passed on every read**: a marker naming a
>    different run is `unusable`, never `settled`. Omitting it re-opens the wrong-box defect
>    `classifyMarkerRead`'s docblock records ("a record whose id collided with a live box owned by
>    another record read THAT box's marker and reported `ok` for a run that never started").
>    <br />**(c)** `ok:false` is a settled-but-failed run and the chain still harvests and tears down
>    — but `ok` is **not a veto and is never fed to reverify** [rest of existing AC2(c) unchanged].
>    *Negative controls, all MUST fail: an implementation that re-derives the four-kind mapping
>    inside `run-completion.ts` forks the one classifier DF1.10 AC5 requires be shared, and drifts
>    the moment `fanout-primitive.ts` changes; one that treats an EACCES `unreadable` as a skipped
>    tick polls a box to the window ceiling while it bills; one that treats `probeExit: 255` as a
>    clean absence resets the streak on every tick of a dead box; and one that omits `expectedRunId`
>    drives the chain from a foreign run's marker.*

Update `:24-27` (Overview) and DoD `:128` to match, and add `markerUnusableGivesUp` and
`PROBE_SKIP_TICKS_LIMIT` to the "reused unmodified" list at `:11-12`.

---

### DF3.7-B5 — BLOCKER — the observer cannot distinguish "still running" from "the engine died", and shipped code already can

**Where:** `df3-7-approval-gate-bridge.md:63` (AC2a), `:64` (AC3), `:78` (the `fleet status`
out-of-scope row), `:103` (event vocabulary).

**Defect.** AC2(a) makes `absent` mean, unconditionally, *not finished yet*. AC3 then makes window
expiry mean *the host never observed it* (`run-completion-unobserved`). Between them the story has no
representation for the case that the shipped substrate makes **common**, and the shipped code has
already solved:

`oci/exedev/systemd/qds-run@.service` declares `Type=simple` and **`Restart=no`**. `src/fleet/run.ts:405-421`,
on `unitActivity`:

> `fleet run` needs it because `systemctl start` exiting 0 does NOT mean the engine started:
> `qds-run@.service` is `Type=simple`, so systemd calls the unit started the instant the process is
> FORKED, and everything after the fork — `deriveInBoxArgv` throwing on an unreadable
> `run-context.json`, a non-positive `budgetMs`, an unset HOME, a box dispatch never finished
> furnishing — is invisible to that exit status. **With `Restart=no` the unit simply sits `failed`
> and no marker is ever written.**
>
> `fleet status` needs it because an **ABSENT marker means four different things** (never started,
> died after the fork, box rebooted so tmpfs `/run` was wiped, marker harvested) and only one of them
> is "still walking its phases". **Absence alone is the reading that made a run report `running`
> forever.**

`fleet status` consumes `unitActivity` for exactly this (`status.ts:33-36` imports it from `run.ts`;
the `unit-activity-unknown` arm at `status.ts:1182-1203`). DF3.7's observer, as specified, is
therefore **strictly weaker than the read surface it declares out of scope at `:78`** — and the story
declares `fleet status` out of scope as a *driver of the chain*, which is right, while
inadvertently excluding its *primitive*, which is wrong.

**Failure scenario.** A box's `/home/exedev/app/.env` arrives late (DF2.3 delivery race — the unit's
own `AssertPathExists=` comment says this race is real and observed). `fleet run` exits 0; the unit
fails the assertion; `Restart=no` means it never retries; no marker is ever written. The DF3.7
observer sees `absent` on every tick for the entire operator-set window — hours — then exits with
`{code: "run-completion-unobserved", message: …}`, whose remediation per AC3 is "the box is alive and
listable, re-run to re-observe". The operator re-runs. It polls for hours again. The observer's own
event vocabulary (`:103`) has no term for "the engine is dead" — `marker-absent` is the only thing it
can emit. Meanwhile the box bills, and the run is unrecoverable because `Restart=no` means nothing
will ever write that marker.

**Fix recipe.** Add a liveness arm to AC2 and a distinct terminal outcome. Insert as AC2(d) (and
renumber the ACs' negative controls accordingly):

> <br />**(d) An absent marker is disambiguated by the unit's own liveness, never by absence alone.**
> On an `absent` verdict the observer probes `unitActivity(driver, vm, runId, deadlineMs)`
> (`src/fleet/run.ts:437`) — the same one-probe seam `fleet run` and `fleet status` share, so the
> three verbs can never disagree about whether one unit is up. `active` means *still walking phases*
> and the poll continues. **`failed` or `inactive` with no marker is terminal, not late**: the unit
> is `Type=simple` with `Restart=no` (`oci/exedev/systemd/qds-run@.service`), so nothing will ever
> write that marker, and the observer stops immediately with a typed
> `{ code: "run-engine-dead", message, remediation }` naming the box, the run and
> `systemctl status qds-run@<runId>.service`. `unknown` (the probe gave no readable answer) neither
> continues nor terminates on its own: it is counted on the `skip` streak of AC2(a). The box is left
> **alive and listable** on every one of these arms (INV-5); nothing is destroyed on a liveness
> reading. *Negative controls, both MUST fail: an implementation that polls an absent marker to the
> window ceiling without ever asking whether the unit is up reports `run-completion-unobserved` — "the
> host never saw it" — for a run whose engine died forty minutes in, sending the operator to debug the
> host; and one that treats `unitActivity` returning `unknown` as `failed` abandons a healthy run on
> one dropped ssh.*

Add `run-engine-dead` to the event vocabulary at `:103`
(`event ∈ run-complete | marker-absent | marker-unusable | run-engine-dead | run-completion-unobserved`),
add `src/fleet/run.ts`'s `unitActivity` to the "Reused unmodified" list at `:11`, add a DoD test line,
and add a Trigger Surface in-scope row. Note this is *reuse*, not new code: `run.ts` imports nothing
from `status.ts` or from the new module, so there is no cycle.

---

### DF3.7-H1 — HIGH — "Fan-out has no poll-interval constant to inherit" is false

**Where:** `df3-7-approval-gate-bridge.md:96`.

**Defect.** The story states: *"Fan-out has **no** poll-interval constant to inherit — `probeArm`
simply re-reads per tick — so the interval and the **observation window** are this story's only two
new numbers."* Shipped: `export const DEFAULT_POLL_INTERVAL_MS = 5_000;` at
`src/fleet/fanout-primitive.ts:52`, under the section header *"INV-6 finite caps (imported constants
— never mirrored literals)"*. `runRace` reads it via `deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS`.

**Failure scenario.** Dev mints a second poll-interval constant in `run-completion.ts` because the
spec says there is nothing to inherit. The repo now has two poll intervals for the same in-box marker
under a header that forbids exactly that; a later tuning edit to one leaves the other behind, and
`PROBE_SKIP_TICKS_LIMIT`'s wall-clock reasoning (`fanout-primitive.ts:84-90`, which prices six ticks
against "the AC5 defaults") is silently wrong for this caller.

**Fix recipe.** Replace the sentence at `:96` with:

> Fan-out's `DEFAULT_POLL_INTERVAL_MS` (5 s, `src/fleet/fanout-primitive.ts:52`) is **imported, not
> re-minted** — the section it lives under is headed "imported constants — never mirrored literals",
> and `PROBE_SKIP_TICKS_LIMIT`'s own wall-clock reasoning (`:84-90`) is priced against it. The
> **observation window** is therefore this story's only new number, and it is operator-settable on
> the flag: fan-out's `DEFAULT_FANOUT_CEILING_MS` (1 h, `:58`) is race-shaped and an unattended run
> routinely outlives it, so inheriting it would silently abandon exactly the runs this story exists
> for.

Also update `:112`'s test list and the DoD to name the imported constant.

---

### DF3.7-H2 — HIGH — the image-side amplifier this story calls "filed, not fixed" has been fixed

**Where:** `df3-7-approval-gate-bridge.md:98`, item (2).

**Defect.** The story states: *"The image-side amplifier is filed, not fixed: `RuntimeDirectory=journal
trace` uses **literals in a template unit**, so every instance shares `/run/journal` and
`RuntimeDirectoryPreserve=yes` carries run A's marker into run B — held closed today by the
TypeScript runId comparison alone … Until that lands, 'the marker at this path belongs to this run' is
a *code* property, not a filesystem one, which is exactly why AC4's refusal of an ambient
`QDS_RUN_ROOT` on the observing host stays load-bearing."*

The shipped unit declares `RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace`, and its own
docblock records the fix:

> PER-INSTANCE SINCE #217 F-D1 (image half): the template unit used LITERALS (both directories at the
> top of /run), so every instance shared one journal tree and Preserve=yes carried run A's terminal
> marker into run B's tmpfs — the image-side amplifier of the marker-identity defect DF1.10 round 1
> closed in TypeScript. **The directories are now keyed by `%i`, the instance name, which is the
> runId: two units can no longer share a root by construction.**

The unit even names this story: *"no QDS_* path variable bridges them, because INV-IBOX-13 (DF1.11)
and **AC4 (DF3.7)** forbid the unit from naming the run root and the AC6 scan enforces that."*

**Failure scenario.** Not a runtime failure — an argumentation failure that props up DF3.7-B2. AC4's
"single derivation on both legs + ambient-env refusal" is justified in this paragraph by a defect that
no longer exists. A dev who reads it treats AC4 as load-bearing and implements the wrong derivation
(DF3.7-B2), then defends it in review by quoting this paragraph.

**Fix recipe.** Replace item (2) of `:98` with:

> (2) **The image-side amplifier is CLOSED, not filed.** `RuntimeDirectory=journal trace` used
> literals in a template unit, so every instance shared `/run/journal` and
> `RuntimeDirectoryPreserve=yes` carried run A's marker into run B. The unit now declares
> `RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace` (#217 F-D1, image half), so "the marker at
> this path belongs to this run" is a **filesystem** property as well as a code one, and
> `Preserve=yes` is now what makes the marker readable *after* the engine exits rather than a
> cross-run leak. The engine derives the same tree from its sole argv (`runMarkerRoot(runId)`) and no
> `QDS_*` path variable bridges the two — the unit's own docblock cites AC4 of this story for that
> rule, and DF2.10's AC6 build-time scan enforces it.

Then adjust AC4 per DF3.7-B2 (its rationale changes from "the code property is all we have" to "the
box path is derived host-side by `boxMarkerPath`, immune to a host env by construction").

---

### DF3.7-H3 — HIGH — AC5's pre-flight refusal on *any* approval state kills the gate's shipped `pausing` resume arm

**Where:** `df3-7-approval-gate-bridge.md:66` (AC5), `:130` (DoD), and inherited verbatim by DF3.8
AC2(b).

**Defect.** AC5: *"Given a run whose record already carries `extensions.approval` in **any** state
(`pausing`, `awaiting-approval`, or terminal), When the observer would start the chain, Then it
refuses instead."* But `pausing` is precisely the state `reverify()` is built to **recover**, and it
never expires. `src/reverify/runner.ts:434-460`:

> A STRANDED `pausing` extension (a crash between registration and promotion) re-presents the
> reportId it is already BOUND to, not this report's fresh reverifyId: the gate's resume arm (AC1(c))
> compares byte-for-byte, and a fresh id would return `pause-in-progress` on every retry — **`pausing`
> never expires and nothing else promotes it, so the run would be stranded for good.**

**Failure scenario.** The chain crashes (Ctrl-C, host power loss, an OOM) between `requestApproval`
registering `pausing` and promoting to `awaiting-approval`. The record now carries
`extensions.approval.state = "pausing"`. AC5 makes the observer — and, via DF3.8's inheritance, the
sweep — refuse this run **forever**. Nothing else promotes a `pausing`, it never expires, and DF5.2's
push gates on `awaiting-approval`. The run is permanently stranded at exactly the state the gate
shipped a resume arm to rescue, and the only escape is a hand-run `scripts/reverify.ts` — which AC5
itself notes is unfenced and which no remediation string tells the operator to run.

**Fix recipe.** Replace the first sentence of AC5 with:

> 5. Given a run whose record already carries `extensions.approval` in a state that is
>    **`awaiting-approval` or terminal**, When the observer would start the chain, Then it refuses
>    instead, with a typed `{code: "approval-already-registered", …}` naming the state.
>    **`pausing` is explicitly NOT a refusal**: it is the stranded state `reverify()`'s resume arm
>    exists to recover (`src/reverify/runner.ts:434-460` — "`pausing` never expires and nothing else
>    promotes it, so the run would be stranded for good"), and the gate compares the bound reportId
>    byte-for-byte, so re-entering the chain on a `pausing` record re-presents the bound id and
>    promotes. Refusing it would strand for good exactly the run the resume arm was built to save.
>    This is a **cheap pre-flight refusal, not a mutual exclusion** [rest of AC5 unchanged].
>    *Negative controls, all MUST fail: an implementation that starts the chain on a record already
>    carrying `awaiting-approval` or a terminal state passes a naive "is it awaiting?" test; one that
>    **refuses** on `pausing` leaves a run stranded forever with no operator-visible remediation; and
>    one that claims to fence the manual caller MUST name the lock it takes.*

DF3.8 AC2(b) and its DoD line `:145` inherit this and must be re-pointed at the corrected wording.

---

### DF3.7-H4 — HIGH — `reverify()` re-verifies the *host's cwd*, and neither the flag nor the chain says so

**Where:** `df3-7-approval-gate-bridge.md:88` (Infra Prereq "host chain"), `:123` (DoD Impl).

**Defect.** `reverify(runId, deps)` resolves its tree as `hostRoot = deps.hostRoot ?? process.cwd()`
(`src/reverify/runner.ts:217`) and its runs directory as `resolveRunsDir(deps.runsDir)` (`:218`). The
story treats `reverify()` as a step with no environmental precondition. It has two: a host git
checkout at the right sha as cwd (or an explicit `hostRoot`), and a runs directory. This matters
immediately for DF3.7 (the flag's process cwd is wherever the operator invoked it) and *critically*
for DF3.8 (a cron tick's cwd is `$HOME` by default — see DF3.8-H1).

**Failure scenario.** Operator runs the observing verb from `~/` rather than the repo. The chain
harvests, tears down the box, then calls `reverify()`, which builds a worktree from a cwd that is not
a git repo. `reverify` returns `verdict: "error"`, `runner.ts:421` returns before the gate, and the
run **never reaches an approvable pause** — but the box is already destroyed and `closedAt` is set,
so it is not re-runnable either. That is a strictly worse outcome than the reaper's witness-less
collection DF3.8 exists to end, and the story's AC1 ("the record reaches `awaiting-approval` through
that path alone") would pass in CI (which runs from the repo root) and fail in the field.

**Fix recipe.** Add to Technical Notes, Guards/limits:

> **`reverify()`'s two environmental preconditions, stated because the chain composes it rather than
> re-implements it.** `reverify(runId, deps)` resolves `hostRoot = deps.hostRoot ?? process.cwd()`
> (`src/reverify/runner.ts:217`) and `runsDir` via `resolveRunsDir` (`:218`). The chain therefore
> passes `hostRoot` **explicitly** — the repo root the verb was invoked against, resolved and
> asserted to be a git worktree **before** harvest runs, not discovered after teardown has already
> destroyed the box. A cwd that is not a repo is a **start-up refusal**
> (`{code: "reverify-host-root-unusable", …}`), never a `verdict: "error"` after the box is gone: at
> that point the run has `closedAt` set, no bundle path back to a pause, and no box to re-run
> against.

Add a DoD line: `**Test (chain preconditions, AC1):** a cwd that is not a git worktree refuses at
start-up with no box touched; an implementation that discovers it inside `reverify()` — after
harvest and teardown — MUST fail.` Add an Infra Prereq lifecycle-hook clause naming it.

---

### DF3.7-H5 — HIGH — AC1's import fence, as worded, is not falsifiable and may be unsatisfiable

**Where:** `df3-7-approval-gate-bridge.md:62` (AC1), `:117` (INV-IBOX-14), `:127` (DoD Security).

**Defect.** AC1 requires "a **static import fence**: `src/fleet/run-completion.ts` imports none of
those four modules, asserted by a grep test". Three problems the AC does not resolve:

1. **Transitive reach is unavoidable and intended.** The chain calls `reverify()`, which imports
   `recordApprovalPort` from `src/reverify/approval.ts:26`, which imports `requestApproval` from
   `../fleet/approval-gate.ts`. The gate *is* reached — through DF5.1's port seam, which is the whole
   design. A fence that greps transitively fails on the correct implementation.
2. **The barrel.** `src/fleet/index.ts` star-exports both `approval-gate.ts` and `status.ts`
   (`status.ts:44-51` documents the star-export coupling). An observer that imports anything from
   `src/fleet/index.ts` — a natural thing to do — pulls the gate's bindings in. The AC must say the
   fence is on *direct module specifiers* and that the barrel is also fenced.
3. **`run-record.ts`'s "approval-extension block" is not a module.** The fence can exclude the
   *module* `src/providers/run-record.ts`, but the observer legitimately needs `RunRecordStore` from
   it to read the record for AC5's pre-flight. As written, AC1 forbids the import AC5 requires.

**Failure scenario.** Dev writes the grep test naively (any occurrence of the four filenames). It
fails on the correct implementation because of (3), so the dev weakens it to "no occurrence of
`approval-gate`" — which passes on an implementation that reaches the gate through the barrel. The
"provably, not by a reviewer's eye" claim in INV-IBOX-14 becomes a test that catches nothing, which
is worse than no test because the DoD's Security box is now checked.

**Fix recipe.** Replace AC1's fence clause with:

> … enforced at test time by a **static import fence** over `src/fleet/run-completion.ts`'s own
> direct import specifiers: it imports **`src/fleet/approval-gate.ts`, `src/fleet/approvers.ts`,
> `src/pr/push.ts`** and **`src/fleet/index.ts`** (the barrel, which star-exports the gate) not at
> all, and imports `src/providers/run-record.ts` **only** for `RunRecordStore`/`RunRecord` — never
> for any symbol that writes the approval extension. The fence is on **direct specifiers, not
> transitive reach**: the chain calls `reverify()`, which reaches the gate through DF5.1's
> `ApprovalPort` seam (`src/reverify/approval.ts:26`), and that path is the design. Asserted by a
> grep test in the repo's own idiom (DF3.6's `src/phase-engine/` DoD grep). *Negative controls, both
> MUST fail: an implementation that writes `extensions.approval.state = "awaiting-approval"` from the
> bridge, which bypasses `pauseRun`'s bundle, R5-C and INV-APPROVE-6 guards; and a fence written to
> match transitively, which fails on the correct implementation and will be weakened until it catches
> nothing.*

Mirror the wording into INV-IBOX-14 `:117` and DoD `:127`, and into DF3.8 AC1 which extends this
fence "verbatim".

---

### DF3.7-M1 — MEDIUM — five stale or incorrect source citations

**Where and correction:**

| Story line | Cite | Actual |
|---|---|---|
| `:11` | `readBoxFile` at `src/providers/exedev/transport.ts:116-123` | `:140` (the docblock starts `:127`) |
| `:12` | "`probeArm` / `runRace` (`src/fleet/fanout-primitive.ts:660-800`)" | `probeArm` is `:1194`, `runRace` is `:998`; `:660-800` is `classifyArmFailure` + `classifyMarkerRead` |
| `:62` | "fan-out's direct `runMarkerPath()` import with the barrel withholding it, `src/fleet/fanout-primitive.ts:670`" | **False.** Fan-out imports `boxMarkerPath`/`boxRunRoot` and explicitly does *not* use `runMarkerPath` (`:686-700`). `:670` is unrelated. `runMarkerPath` is withheld from the barrel (`src/phase-engine/index.ts:19-33`) — that half is true |
| `:65`, `:95` | "the host-side shim sets it in-process today (`scripts/pipeline-run-remote.ts:210`)" | **The file does not exist.** Deleted by DF1.10 AC7; `journal.ts:60-63` records that there is no production writer of `QDS_RUN_ROOT` any more |
| `:95` | "`tests/fleet/e2e/tier3-remote-phases.live.test.ts` asserts the marker under `<recordsDir>/<runId>/journal/final.json` (`:154`)" | That assertion is gone; `:148-160` is `markerPollCeilingMs`. The whole "retiring that shim flips the assertion, which makes it DF1.10's edit" paragraph is moot |

**Fix recipe.** Correct each cite; delete the `pipeline-run-remote.ts` sentences from `:65` and `:95`
(they are the sole justification for AC4's ambient-env refusal, which DF3.7-B2 removes anyway);
delete the last two sentences of the "Region ownership" bullet at `:95` and replace with: "There is
no host-side shim left to retire — `scripts/pipeline-run-remote.ts` was deleted by DF1.10 AC7, and
`journal.ts:60-63` records that `QDS_RUN_ROOT` now has no production writer at all. This story
carries its own live test."

---

### DF3.7-M2 — MEDIUM — `completedAt` is optional on the wire; the story states it as a required field

**Where:** `:93` ("the marker is `{ runId: string, ok: boolean, completedAt: string }` and nothing
else"), `:38`, `:132`.

**Defect.** `writeTerminalMarker` serialises
`{ runId, ok: outcome.ok, completedAt: outcome.completedAt }` (`journal.ts:381`) and
`JournalFile.completedAt` is declared `completedAt?: string`. `JSON.stringify` **drops** an
`undefined` value, so a settled run whose outcome carries no `completedAt` produces
`{"runId":"…","ok":true}` — a valid, settled marker with two fields. The shipped classifier reads
only `runId` and `ok` and is correct for this; a validator built from the story's stated contract is
not.

**Fix recipe.** `:93` → "the marker is `{ runId: string, ok: boolean, completedAt?: string }` and
nothing else. `completedAt` is **optional on the wire**: `JournalFile.completedAt` is optional and
`JSON.stringify` drops an `undefined` value (`src/phase-engine/journal.ts:381`), so a settled marker
may carry two fields. The observer decides on `ok` alone — the shipped classifier
(`classifyMarkerRead`) reads exactly `runId` and `ok` — and a validator that requires `completedAt`
would classify a legitimately settled run as `unusable` and abandon it at the streak limit."

---

### DF3.7-M3 — MEDIUM — no exit code is named for `run-completion-unobserved`

**Where:** `:64` (AC3), `:110`, `:124`.

**Defect.** AC3 requires "the command exits with a typed `{code, message, remediation}` payload" but
names no exit code. `fleet dispatch`'s declared table is `[0,1,2,3,5,6]` — **no 4** (`verbs.ts:98`).
DF3.5's skill-contract test compares declared codes against what the verb actually returns
(`verbs.ts:85-90`), so an undeclared code fails that suite; and `FleetError.exitCode` is constrained
to 1..5 (`verbs.ts:96`). DF3.8 by contrast names 5 and 0 explicitly.

**Fix recipe.** Under DF3.7-B3's recommended relocation to a `fleet observe <run-id>` verb, declare
the full table in the AC and in `verbs.ts`. Add to AC3: "The exit code is **1** (`transient` — the
run may settle on a later invocation and re-observing is the remediation), declared on the verb's
`exitCodes` table in `src/fleet/verbs.ts` so DF3.5's skill-contract test sees it. `run-engine-dead`
(AC2d) is **5** — refused before anything was mutated, and identical on every retry, so not 1."

---

### DF3.7-M4 — MEDIUM — the live test's tier name does not match the repo's tier grammar

**Where:** `:76`, `:113`, `:132`.

**Defect.** The story names `tests/fleet/e2e/tier3-run-completion.live.test.ts`. The shipped tier-3
files are `tier3-expose-port`, `tier3-manystories`, `tier3-race`, `tier3-reaper`,
`tier3-remote-phases` — multi-box / host-orchestration rounds. A single run's in-box-engine →
completion chain matches the tier-2 family (`tier2-in-box-engine.live.test.ts`,
`tier2-dispatch-engine.live.test.ts`, `tier2-reboot-arm.live.test.ts`). Tier selection drives real
spend and gating in the `qds-live-e2e` skill, so the name is not cosmetic.

**Fix recipe.** Rename to `tests/fleet/e2e/tier2-run-completion.live.test.ts` in all three places, or
state in Technical Notes why this round belongs in tier 3. Same applies to DF3.8's
`tier3-observe-detached.live.test.ts` — that one arguably *is* tier 3 (two invocations, detachment),
so state the distinction rather than leaving both at tier 3 by default.

---

### DF3.7-L1 — LOW — dependency edges are incomplete

**Where:** `:54` — "Dependency edges (predecessors): DF1.10, DF3.4, DF5.1."

**Defect.** The story edits `src/fleet/verbs.ts` and the `scripts/fleet.ts` dispatch block (both
**DF3.1-owned**, per the story's own `:95`), consumes `readBoxFile` (**DF2.2**), and AC4 rests on the
image shipping no `QDS_*` path variable and on the unit's `RuntimeDirectory` (**DF2.10**). DF3.8
declares DF3.1 as an edge for the same reason; DF3.7 does not.

**Fix recipe.** `:54` → "**Dependency edges (predecessors):** DF1.10, DF2.2, DF2.10, DF3.1, DF3.4,
DF5.1."

---

## 3. DF3.8 — Verified-correct elements (SACRED)

| # | Element | Evidence |
|---|---------|----------|
| V1 | **The `record-claim-refused` → `stale-record` correction is substantively RIGHT.** That arm guards `destroy` only; an aged open record classifies `stale-record` → `teardown`, and the reaper calls `teardownSandbox` with no opts — harvest, destroy, revoke, `closedAt`, **no `reverify()`, no gate**. Verified. (Line cites are wrong — see DF3.8-H3 — the substance is not.) | `reaper.ts:536`, `:579`, `:592`, `:726`; `teardown.ts:463` |
| V2 | **`staleAfterMs` default is 14_400_000 ms / 4 h at `src/providers/quota.ts:49`.** Line cite exact. | `quota.ts:44-50` |
| V3 | **`sandbox-reap` is dry-run unless `--yes`; `staleAfterMs` is a threshold applied at sweep time (`aged()`), never a timer that fires.** So "there is no scheduled reaper to outrun" and "the box bills until an operator acts" are both true. The refusal-to-claim-a-race is correct and honest. | `scripts/sandbox-reap.ts:7-9,45-51`; `reaper.ts:424,510` |
| V4 | **`acquireRunLock` is genuinely not re-entrant**, and `fleet dispatch` genuinely holds the same per-run lock from `store.create` through the verb's `finally`, and its acquisition is genuinely non-fatal on refusal. All three facts verified; only the line numbers are stale. AC2(b)'s conclusion — the lock may not be pushed into the shared composition — is correct **for the dispatch-hosted shape**. | `run-lock.ts:952`, `:66-79`; `scripts/fleet.ts:1825-1831`, `:1966-1985`, `:1839` |
| V5 | **`RunLockedError` distinguishes stale from busy and carries the `rm` line.** AC2(d)'s demand that a stale refusal be its own outcome is correct and implementable. | `run-lock.ts:46-66` |
| V6 | **Exit 5 = "the run lock refused, so the verb never ran" is a real, documented mapping** with a stated reason for not being 1. Reusing it rather than minting a code is right. | `src/fleet/verbs.ts:116-124`; `scripts/fleet.ts:4257-4271` |
| V7 | **AC4(a)'s inversion catch is real and important.** `store.create` does precede `driver.create()` in `provisionAdmittedRun`, so a first boot always postdates `createdAt` and the naive comparison counts every box as rebooted. The margin, the duration-not-timestamp framing (no clock skew), and the `uptime_unknown` bucket are all correct. | `src/fleet/dispatch.ts` (`within("create", …)` wraps `store.create`, budget `store.set` and `driver.create`) |
| V8 | **`/proc/uptime` through `readBoxFile` adding zero `sh -c` strings under `src/fleet/`** is correct and matches the DoD it cites. | `transport.ts:127-135` |
| V9 | **AC5's "no daemon" posture and the rejection of a resident host watcher** are correct and consistent with the ADR: a resident process on a closed laptop is as absent as a cron tick on one. | story `:114` |
| V10 | **AC6's "an empty sweep exits 0"** is right for the stated reason. | story `:82` |
| V11 | **AC7's insistence that the detachment be produced by `fleet run` and not by backgrounding a host process** is correct and matches `src/fleet/run.ts:1-11` exactly. | `src/fleet/run.ts:1-11` |
| V12 | **DF3.2 `FleetLock` is correctly excluded** — it is the single-operator mutex fan-out takes across a whole race; per-run granularity is right here. | `src/fleet/fleet-lock.ts`; `fanout-primitive.ts:41` |
| V13 | **AC3's refusal to grant the reaper a reprieve** is correct: a reprieve removes the only bound the bill has and edits a merged story's classifier. | story `:79`, `:94` |
| V14 | **INV-IBOX-19's "named threshold with a named owner and review point"** is genuinely good spec hygiene and should survive every later wave. | story `:136` |

---

## 4. DF3.8 — Findings

| ID | Sev | Location |
|----|-----|----------|
| DF3.8-B1 | BLOCKER | story `:9` — inherits DF3.7's B1/B2/B4/B5 as "FINAL, consumed unchanged" |
| DF3.8-B2 | BLOCKER | story `:78` (AC2), `:134` (INV-IBOX-17) — the reaper takes no run lock, so the mutex does not exclude it |
| DF3.8-B3 | BLOCKER | story `:80` (AC4), `:78` (AC2a) — a rebooted box is a permanent candidate the sweep can never retire |
| DF3.8-H1 | HIGH | story `:62`, `:128`, `:141` — the documented cron line must set cwd, or `reverify()` verifies the wrong tree |
| DF3.8-H2 | HIGH | story `:78` (AC2c) — the two-observer exclusion argument depends on DF3.7 staying on `fleet dispatch` |
| DF3.8-H3 | HIGH | story `:12`, `:110`, `:115` — every reaper line cite in the "Correction of record" is wrong |
| DF3.8-H4 | HIGH | story `:111`, `:141` — the `observe` exit table is under-specified against DF3.5's contract test |
| DF3.8-H5 | HIGH | story `:79` (AC3) vs `:78` (AC2a) — the `completion-unwitnessed` arm is unreachable under the stated candidate filter |
| DF3.8-M1 | MEDIUM | story `:11`, `:12`, `:78`, `:80`, `:111` — eight stale line cites |
| DF3.8-M2 | MEDIUM | story `:112` — max-candidates-per-pass bounds count, not wall clock |
| DF3.8-M3 | MEDIUM | story `:80` (AC4a) — `hostNow` read-time is unspecified |
| DF3.8-L1 | LOW | story `:64` — dependency edges |

### DF3.8-B1 — BLOCKER — inherits DF3.7's defective contract and declares it FINAL

**Where:** `df3-8-host-completion-watcher.md:9` — *"**Contract surface (FINAL, consumed unchanged):**
`df3-7-approval-gate-bridge.md` — the marker `{runId, ok, completedAt}`, the bounded `readBoxFile`
observe primitive with its four-kind classification, AC3's unobserved arm …, AC5's pre-flight
refusal, and **INV-IBOX-14/15**, which this story inherits verbatim."*

**Defect.** Everything inherited here is defective at source: the marker path (DF3.7-B1), the host-leg
derivation (B2), the four-kind classification (B4), the missing liveness arm (B5), the `pausing`
refusal (H3), the optional `completedAt` (M2). Declaring it FINAL means DF3.8 cannot be fixed
independently and a fix wave that repairs DF3.7 leaves DF3.8 pointing at superseded text.

**Failure scenario.** Fix wave repairs DF3.7 (marker path, `boxMarkerPath`, `readMarkerVerdict`,
liveness arm). DF3.8 still says "four-kind classification" and "FINAL, consumed unchanged". A dev
implementing DF3.8 second reads the inherited description, re-derives the four-kind mapping in
`observe.ts` because that is what the contract surface says, and forks the classifier the arc has one
of.

**Fix recipe.** Do not repair DF3.8's inherited text in place — **re-point it** after DF3.7 is fixed.
Replace `:9` with:

> **Contract surface (consumed unchanged, as CORRECTED by the 2026-09-08 review):**
> `df3-7-approval-gate-bridge.md` — the marker `{runId, ok, completedAt?}` at
> `/run/qds-run/<runId>/journal/final.json`; the bounded observe primitive built on
> `readMarkerVerdict(driver, vm, boxMarkerPath(runId), deadlineMs, runId)` with its four **verdicts**
> (`absent | skip | unusable | settled`) and their two streaks; the `unitActivity` liveness arm that
> distinguishes a dead engine from a late one; AC3's unobserved arm; AC5's pre-flight refusal (which
> does **not** refuse `pausing`); and INV-IBOX-14/15. **This story consumes DF3.7's module; it
> restates none of that mapping.** INV-IBOX-16 is inherited on two of its three limbs and openly
> amended on the third (AC5).

Sequencing requirement: **DF3.8 must not enter development until DF3.7's rewrite is merged into the
story file.** Record that in the tracker.

---

### DF3.8-B2 — BLOCKER — the reaper takes no run lock, so the mutex this story pays for does not exclude the one process AC3 is about

**Where:** `df3-8-host-completion-watcher.md:78` (AC2), `:134` (INV-IBOX-17), `:110` (Technical Notes
ordering).

**Defect.** AC2 and INV-IBOX-17 build the story's entire safety argument on the per-run invocation
lock: "one run at a time, each under the per-run invocation lock taken by `observe.ts`". AC3 then
reasons about the reaper collecting a record mid-sweep and concludes the answer is a typed
`completion-unwitnessed` refusal. **The reaper takes no run lock.** `grep -rn acquireRunLock src/
scripts/` returns only `scripts/sandbox-teardown.ts:230`, `scripts/fleet.ts:1976` (dispatch mint) and
`:4257` (`runDestructive` — harvest/teardown), and `src/fleet/fanout.ts:168` (the fanout-record lock).
`src/providers/reaper.ts` calls `teardownSandbox` **directly** (`:726`), not through
`sandbox-teardown.ts`, so it bypasses the lock entirely.

**Failure scenario.** `fleet observe --all` acquires the run lock for run R, reads R's marker
(`settled`), and enters the chain: harvest starts. In parallel the operator (or another terminal)
runs `sandbox-reap --yes`. R's record is past `staleAfterMs`, so it classifies `stale-record` →
`teardown` and calls `teardownSandbox(deps, R)` — **while the sweep is mid-harvest on the same box,
holding a lock the reaper never looks at.** Two concurrent `teardownSandbox` calls on one run: two
harvests racing for `<runsDir>/<R>.bundle`, two `driver.destroy` calls, two key revocations, two
`closedAt` writes. The sweep's chain then calls `reverify()` against a bundle that may be
half-written by the loser. AC3's premise — that losing the race yields "a typed refusal, not a
synthesized pause" — holds only if the sweep loses *before it starts*; mid-chain it is data
corruption, and the story asserts the opposite ("this story changes not one reaper input" is true and
sufficient for the *classifier*, but not for the *concurrency*).

**Fix recipe.** This cannot be specced around inside DF3.8's stated scope ("`src/providers/reaper.ts`
is byte-identical after"), because the fix is one line **in the reaper**. Two honest options; flag
both to the operator:

**(a) — recommended, and it is a scope amendment, not a reprieve.** Amend AC3 to permit exactly one
reaper edit: the reaper's `teardown` action acquires the per-run invocation lock before calling
`teardownSandbox`, and reports a `run-locked` refusal as a *counted skip* on that unit. This does not
touch a single classifier input — `staleAfterMs`, the arms, the report shape and the dry-run posture
are unchanged — so the "no reprieve" invariant survives; what changes is that the reaper stops being
the one destructive path in the repo that ignores the mutex every other destructive path takes
(`sandbox-teardown.ts:230`, `fleet.ts:4257`). Replace AC3's opening clause with:

> 3. Given DF2.6's `stale-record` → `teardown` arm … Then this story changes **no reaper
>    classifier input**: no `staleAfterMs` edit, no suppression file, no reprieve, and the
>    classification, report shape and dry-run posture are byte-identical. It makes **one**
>    concurrency change, which is not a reprieve: the reaper's `teardown` action acquires the same
>    per-run invocation lock every other destructive path in the repo already takes
>    (`scripts/sandbox-teardown.ts:230`, `scripts/fleet.ts:4257`) before calling `teardownSandbox`
>    (`src/providers/reaper.ts:726`), and a `RunLockedError` is a **counted skip** on that unit, not a
>    sweep failure — the run dies on the next `--yes` pass instead. Without it the mutex AC2 pays for
>    excludes every caller except the one AC3 is about: the reaper calls `teardownSandbox` directly
>    and would tear a box down under a sweep that is mid-harvest on it, producing two harvests racing
>    for one bundle, two destroys and two `closedAt` writes. *Negative control: an implementation
>    that leaves the reaper unlocked passes every single-process test and corrupts a bundle the first
>    time an operator runs `sandbox-reap --yes` during a sweep.*

Update Infra Prereqs `:105` (the reaper is no longer "byte-identical after" — it is "classifier
byte-identical; one lock acquisition added, asserted by `tests/providers/reaper.test.ts`") and DoD
`:144` and `:146` accordingly.

**(b)** Leave the reaper untouched and state the residue explicitly in INV-IBOX-18, in the same voice
the story already uses for the F106 residue: "the mutex excludes every automatic caller of the chain
and does **not** exclude `sandbox-reap --yes`, which calls `teardownSandbox` directly with no run
lock (`reaper.ts:726`). A sweep mid-chain on a run the operator reaps concurrently races two
teardowns on one box. This is narrowed by nothing and is not closed by this story." This is honest
but ships a known corruption path; (a) is one line and closes it.

**Note for the operator:** this is not an ADR conflict. Nothing in the ADR speaks to the reaper's
locking. It is a shipped-code gap that DF3.8's own safety argument surfaces.

---

### DF3.8-B3 — BLOCKER — a rebooted box becomes a permanent candidate the sweep measures and then discards

**Where:** `df3-8-host-completion-watcher.md:78` (AC2a, the candidate filter), `:80` (AC4b),
`:112` (max-candidates-per-pass reasoning), `:136` (INV-IBOX-19).

**Defect.** The story establishes all three facts and connects none of them:

1. AC2(a): candidates are "records with `closedAt` unset whose box is live and listable", enumerated
   oldest-`createdAt`-first, every pass, from scratch (nothing is persisted, `:109`).
2. AC4: the sweep **detects** `box_reboot_after_dispatch` on every candidate.
3. AC4(b): *"It measures the window, not a loss — a reboot destroys a marker only if one had already
   been written, and the story claims exactly that much."*

But the shipped substrate makes a post-dispatch reboot **terminal for the run**, whether or not a
marker was written. `/run` is tmpfs (probe, ADR `:81-82`), so the marker is gone; and the unit has
**no `[Install]` section, deliberately** — its docblock: *"an ENABLED instance is pulled in by
multi-user.target on EVERY subsequent boot, re-walking phases whose git commits and LLM spend already
happened … Nothing enables an instance today"* — combined with `Restart=no`. So after a reboot the
engine does not restart, and no marker will ever exist for that run.

Meanwhile `:112`'s starvation argument explicitly rests on candidates leaving the set: *"because a
driven run gains `closedAt` and leaves the candidate set, the next tick makes progress; **a candidate
that refuses every pass does not**, so enumeration is ordered oldest-`createdAt`-first and the
partial-pass line names the count left behind." A rebooted run is precisely a candidate that refuses
every pass — and, being the oldest, it sits at the head of the ordering the story chose to prevent
starvation.

**Failure scenario.** Box for run R reboots 20 minutes after dispatch (exe.dev boxes do reboot — the
image's growfs/tmpfs boot contract exists because they do). R's record stays open; the box is live and
listable; R is a candidate forever. Every sweep tick: enumerate R (oldest first), acquire its run
lock, read `absent` from `boxMarkerPath(R)`, read `/proc/uptime`, count `box_reboot_after_dispatch`,
emit a line, release, move on. Twenty ticks later the evidence JSON has twenty reboot lines for one
run (which AC4(c) correctly anticipates and defines the denominator for) and the operator has been
told nothing actionable. R burns two box round-trips per tick indefinitely, at the head of a
`max-candidates-per-pass` budget, potentially starving the tail the ordering was chosen to protect.
The run never reaches a pause and never will; the only thing that ends it is the reaper's
witness-less collection — the exact outcome this story exists to end.

**Fix recipe.** Give the reboot detection a terminal arm. Amend AC4(b) and add a new clause:

> <br />**(b) It measures the window, and on a candidate it also DECIDES.** A reboot destroys a
> marker only if one had already been written, so the *counter* claims exactly that much and is not
> reported as a confirmed loss. But for the candidate in hand the reboot is **terminal regardless**:
> `/run` is tmpfs so any marker is gone, and the unit has `Restart=no` and **no `[Install]` section**
> (`oci/exedev/systemd/qds-run@.service` — "an ENABLED instance is pulled in by multi-user.target on
> EVERY subsequent boot, re-walking phases whose git commits and LLM spend already happened"), so no
> engine will restart and no marker will ever appear. A candidate with a confirmed reboot
> (`uptimeSeconds < (hostNow − createdAt) − PROVISION_LAG_MARGIN_MS`) **and** an absent marker
> **and** `unitActivity` not `active` is therefore refused terminally with a typed
> `{ code: "run-lost-to-reboot", message, remediation }` naming the box, the run and
> `fleet teardown <runId>` — and is **excluded from subsequent candidate enumeration on the strength
> of that reading, not on a persisted flag** (nothing is persisted; the reading is re-derived and
> re-refused every pass, at the cost of one pass's reads, and the refusal is reported once per pass
> rather than counted as a benign skip). The box is left **alive and listable** with its `$HOME`
> evidence intact (INV-5) — the refusal is the operator's cue to harvest and tear down, not this
> story's licence to destroy. `uptime_unknown` is never this arm: an unmeasured box stays a candidate.
> *Negative controls, all MUST fail: an implementation that counts the reboot and keeps the run as a
> live candidate forever burns two box reads per tick at the head of the oldest-first ordering and
> starves the tail the ordering exists to protect, while the operator is told nothing actionable —
> the run then ends at the reaper's witness-less collection, which is the outcome this story exists to
> end; one that folds `run-lost-to-reboot` into the benign skip count reports a permanently
> unobservable run as healthy on every tick; and one that **destroys** the box on this arm violates
> INV-5 and INV-IBOX-18.*

Add `run-lost-to-reboot` to the event vocabulary at `:119`, add a counter beside
`box_reboot_after_dispatch` on the `sweep-complete` line, add a DoD test line under AC4, and update
`:112`'s starvation paragraph to note that this arm is what keeps the "candidate that refuses every
pass" case bounded in practice. Note this arm **requires** DF3.7-B5's `unitActivity` addition — a
reboot alone must not be terminal for a box that was rebooted *before* the engine ever started and
whose unit is now active.

---

### DF3.8-H1 — HIGH — the documented cron line must set cwd, or every scheduled tick reverifies the wrong tree

**Where:** `:62` ("this story ships a verb and documents a cron line"), `:128`, `:141` ("the
documented cron line in `--help`").

**Defect.** Per DF3.7-H4, `reverify()` resolves `hostRoot = deps.hostRoot ?? process.cwd()`
(`runner.ts:217`). A `cron` job's working directory is `$HOME` on every mainstream cron
implementation; `launchd` agents inherit `/`. The story's whole delivery is "a verb and a documented
cron line", and that line is the one artefact whose correctness is entirely the story's
responsibility.

**Failure scenario.** Operator pastes the `--help` cron line into their crontab. Every tick runs from
`$HOME`. A run settles; the sweep enumerates it, acquires the lock, witnesses the marker, and drives
the chain: harvest succeeds, teardown destroys the box and sets `closedAt`, then `reverify()` builds
a worktree from `$HOME` — not a git repo, or worse, *some other* repo. Verdict `error`,
`runner.ts:421` returns before the gate, no approval is registered. The run is now closed, its box
destroyed, with no pause and no path back. **Every scheduled run in the fleet ends this way**, and the
sweep reports `runs_observed: 1` per tick, which reads as success. This is strictly worse than the
reaper's witness-less collection the story exists to end: at least that one is honest about having no
witness.

**Fix recipe.** Add to AC6 (or a new AC clause) and to the Technical Notes:

> The `--help` cron line **names the working directory explicitly** and the verb **refuses at
> start-up** if it is not a git worktree: `reverify()` resolves its tree as `process.cwd()`
> (`src/reverify/runner.ts:217`), and cron runs from `$HOME` while launchd runs from `/`. The
> documented line is
> `*/N * * * * cd /path/to/QDS-Factory && bun scripts/fleet.ts observe --all --driver exedev >> ~/.qds/observe.log 2>&1`,
> and the sweep resolves `hostRoot` once, asserts it, and passes it explicitly into every chain call —
> **before** any candidate is driven, never discovered after a teardown has already destroyed a box.
> *Negative control: a verb that discovers an unusable host root inside `reverify()` has already
> harvested, destroyed the box and set `closedAt`; every scheduled run then ends closed with no pause
> and no path back, while the sweep reports `runs_observed` per tick and reads as healthy. MUST fail.*

Add a DoD line: `**Test (host root, AC6):** a sweep invoked from a non-repo cwd refuses at start-up
with zero boxes touched and zero records mutated.`

---

### DF3.8-H2 — HIGH — AC2(c)'s two-observer exclusion argument collapses if DF3.7 moves off `fleet dispatch`

**Where:** `:78` (AC2c).

**Defect.** AC2(c) decides the two-observer case: *"A live foreground `--await-completion` observer
wins by holding the dispatch invocation's lock; the sweep loses at `acquireRunLock` with
`RunLockedError` → DF3.1's exit 5."* This is true **only** because `fleet dispatch` happens to hold
the per-run lock from `store.create` through its `finally` (verified: `scripts/fleet.ts:1976`,
released `:1839`). Per DF3.7-B3, `--await-completion` cannot live on `fleet dispatch` — dispatch does
not start the engine. And on `fleet run`, the natural alternative, **no run lock is taken at all**:
verb routing sends `run` to `runRun(ctx)` (`scripts/fleet.ts:1732`), which is a different path from
`runDestructive` (`:4112`) where the `acquireRunLock` at `:4257` lives. So under the relocation, the
exclusion is not "the sweep loses at the lock" — it is "neither observer holds anything".

**Failure scenario.** DF3.7 ships `--await-completion` on `fleet run` (fix option (b) of B3). A cron
tick fires while the foreground observer is polling. The sweep acquires the run lock (nobody holds
it), witnesses the marker, and enters the chain. The foreground observer, holding nothing, witnesses
the same marker one tick later and enters the chain too. Two concurrent
harvest→teardown→`reverify()` sequences on one run: two worktrees, `worktree.ts:319`'s pid guard goes
from latent to live (which AC2's own negative control names as the thing to prevent), two teardowns,
two `requestApproval` calls. AC2's headline guarantee is void, and every test in the story passes
because they all run one process at a time.

**Fix recipe.** Resolve jointly with DF3.7-B3. Under B3's recommended fix (both stories deliver
`fleet observe`, DF3.7 the single-run form and DF3.8 `--all`), the lock is taken by the same
`observe.ts` code path in both cases and AC2(c) becomes trivially true and *stronger* than written.
Rewrite AC2(c) as:

> <br />**(c) Two observers, one run — decided by one lock, not by two conventions.** Both the
> single-run form (`fleet observe <run-id>`, DF3.7) and the sweep (`fleet observe --all`) acquire the
> **same** per-run invocation lock through the **same** `observe.ts` code path before any pre-flight
> read; the loser gets `RunLockedError` → DF3.1's exit 5, a counted skip and not a failure, and
> re-observes idempotently on the next tick. There is no shape in which one observer holds a lock the
> other does not look at. The one honest residue is unchanged and is not this story's to close: a
> hand-run `scripts/reverify.ts` takes no run lock, and `fleet dispatch`'s own acquisition is
> deliberately non-fatal on refusal (`scripts/fleet.ts:1966-1985` — "a refusal here must NOT abort
> the mint"), so F106 is narrowed, not retired.

If instead the operator takes B3 option (b) (flag on `fleet run`), AC2(c) must say: "`fleet run` takes
**no** run lock (`scripts/fleet.ts:1732` routes to `runRun`, not to `runDestructive` where the
acquisition at `:4257` lives), so the foreground observer must acquire it itself, in the same
`observe.ts`/`run-completion.ts` entry the sweep uses" — otherwise there is no mutex at all.

---

### DF3.8-H3 — HIGH — every reaper citation in the "Correction of record" is wrong

**Where:** `:12` (Correction of record), `:110` (Technical Notes ordering), `:115` (Deviation 1),
`:79` (AC3).

**Defect.** The correction's evidentiary weight *is* its citations, and all five miss:

| Story cite | Claim | Actual |
|---|---|---|
| `reaper.ts:750-756` | `record-claim-refused` arm | `:808` |
| `reaper.ts:480-487` | `stale-record` → `teardown`, VM-side | `:530-541` |
| `reaper.ts:534-544` | record-side | `:575-595` (two sites: `:579`, `:592`) |
| `reaper.ts:671` | `teardownSandbox` with no opts | `:726` |
| `reaper.ts:459` | threshold applied at sweep time | `:424` (`staleAfterMs` read) and `:510` (`aged`) |

**The substance is correct** (see V1) — a reviewer who checks the lines will find unrelated code
(`:480-487` is key-list enumeration; `:750-756` is the actions cap) and may reject a correction that
is right.

**Fix recipe.** Correct all five cites in `:12`, `:110`, `:115` and `:79`. Specifically `:12` →
"…`record-claim-refused` arm (`src/providers/reaper.ts:808`). That arm guards **destroy** only. An
**open** record older than `staleAfterMs` classifies `stale-record` → **`teardown`**
(`:530-541` VM-side, `:575-595` record-side), and the reaper calls `teardownSandbox` with no opts
(`:726`) … `staleAfterMs` is a threshold applied at whatever moment a sweep runs (`aged()`,
`reaper.ts:510`, from the limit read at `:424`), never a clock that fires."

Also correct DF3.7's `:64`, which carries the same wrong `reaper.ts:750-756` / `:480-487` /
`:534-544` / `quota.ts:49` set (only the `quota.ts:49` cite is right).

---

### DF3.8-H4 — HIGH — the `observe` verb's exit table is under-specified against DF3.5's contract test

**Where:** `:111`, `:141`, `:82` (AC6).

**Defect.** The story names exit 5 (lock refused) and 0 (empty sweep) and nothing else. `verbs.ts` is
a **contract**: its docblock (`verbs.ts:85-90`) records that "DF3.5's skill-contract test compares
these against what the verbs actually return, and a generated skill drops an undeclared code into its
default branch". The story's own ACs imply at least four more codes: 2 (usage — bad flags), 4 (no
such run record, for `fleet observe <run-id>`), 1 (transient — DF3.7's `run-completion-unobserved`),
6 (output/cleanup failed after billable work, which a sweep that drove a chain can absolutely hit),
plus the new `completion-unwitnessed` (AC3), `run-engine-dead` (DF3.7-B5) and `run-lost-to-reboot`
(DF3.8-B3). And a **partial pass** (AC-level: `max-candidates-per-pass` exceeded) needs a code that is
not 0 and not a failure.

**Fix recipe.** Add to AC6:

> The verb's exit table is declared in full on `src/fleet/verbs.ts`'s `observe` descriptor —
> `exitCodes: [0, 1, 2, 4, 5, 6]` — because that registry is a contract DF3.5's skill-contract test
> compares against what the verb returns (`verbs.ts:85-90`), and an undeclared code lands in a
> generated skill's default branch. The mapping: **0** = the pass completed, including a pass that
> drove zero runs **and** a partial pass that hit `max-candidates-per-pass` (a partial pass is a
> counted, logged outcome, not a failure — the next tick makes progress); **2** = usage; **4** = no
> such run record (`fleet observe <run-id>` only); **5** = the run lock refused, so nothing ran —
> and, for the single-run form, the terminal per-run refusals `completion-unwitnessed`,
> `run-engine-dead` and `run-lost-to-reboot`, all of which are identical on every retry; **1** =
> transient, the run may settle on a later tick (`run-completion-unobserved`); **6** = a chain landed
> and the CLI's own output or cleanup failed after it. In a `--all` sweep a per-run refusal is a
> **counted skip**, never the sweep's exit code — only a failure to complete the pass itself is.

---

### DF3.8-H5 — HIGH — AC3's `completion-unwitnessed` arm is unreachable under AC2(a)'s candidate filter

**Where:** `:79` (AC3) vs `:78` (AC2a).

**Defect.** AC2(a): candidates are "records with `closedAt` **unset** whose box is live and
listable". AC3: "a record the reaper already closed is re-entered at the `reverify()` leg **only if
this invocation witnessed the marker itself**, and is otherwise refused with a typed
`completion-unwitnessed` payload". A record the reaper closed has `closedAt` **set** and its box
**destroyed** — so it is not a candidate and the sweep never looks at it. The refusal arm can only
fire on a record that was a candidate at enumeration time and became closed *during* the pass, i.e.
the mid-sweep race — which DF3.8-B2 shows the mutex does not actually exclude.

**Failure scenario.** Dev implements the candidate filter and then cannot find a code path that
reaches `completion-unwitnessed`, so writes a test that constructs the state by hand and asserts the
refusal — a test that passes on an implementation whose enumeration can never produce that state.
Meanwhile the *real* case (reaper closes R mid-chain) is unhandled: the chain is already past the
witness and inside `reverify()`, and there is no arm at all.

**Fix recipe.** State the reachability explicitly in AC3 and make the arm about the *re-read inside
the lock*, which is the only place it can fire:

> … What is load-bearing is being **correct when it loses**, and there is exactly one point at which
> that can be observed: the record re-read **inside** the run lock (AC2b). A record that was a
> candidate at enumeration and reads `closedAt` set at that re-read was collected between the two
> — by the reaper, or by a concurrent `fleet teardown`. It is re-entered at the `reverify()` leg
> **only if this invocation had already witnessed the marker itself** before the collection, and is
> otherwise refused with a typed `completion-unwitnessed` payload naming the collection. A record
> closed *before* enumeration is never a candidate at all (AC2a) and this arm does not concern it —
> the sweep has no witness for it and never will, and reconstructing one from a bundle is what
> INV-IBOX-18 forbids. This story persists no observation record, so "witnessed" means witnessed by
> the running invocation. *Negative controls, three MUST fail: an implementation that routes any
> closed record carrying a bundle into the gate promotes a run killed mid-flight on evidence no
> marker ever witnessed; one that grants finished boxes a reaper reprieve; and one whose test for
> this arm hand-constructs a state its own enumeration can never reach, which asserts nothing about
> the code path that fires in production.*

If DF3.8-B2 fix (a) is taken (reaper acquires the lock), also note that the window narrows to
"collected before we acquired", which makes the arm cleanly reachable and testable by taking the lock
in a second process.

---

### DF3.8-M1 — MEDIUM — eight stale line citations

| Story line | Cite | Actual |
|---|---|---|
| `:11` | `acquireRunLock` at `scripts/fleet.ts:3856` | `:4257` (`runDestructive`) |
| `:11` | `readBoxFile` at `transport.ts:123` | `:140` |
| `:11` | exit-5 mapping `verbs.ts:117-124` | correct |
| `:78`, `:111` | `RunLockReentrantError` at `run-lock.ts:64-77` | `:66-79` |
| `:78` | reentrancy guard at `run-lock.ts:951` | `:952` |
| `:78` | `RunLockedError` stale/busy at `run-lock.ts:57-64` | `:46-66` |
| `:78` | dispatch holds the lock, `scripts/fleet.ts:1760-1766`, taken at `:1908` | comment `:1825-1831`, taken `:1976`, released `:1839` |
| `:78`, `:134` | non-fatal acquisition, `scripts/fleet.ts:1905-1918` | `:1966-1985` |
| `:80` | `store.create` before `driver.create`, `src/fleet/dispatch.ts:2787-2788` | that region is EEXIST/`run-id-in-use` handling; the ordering fact lives in `provisionAdmittedRun`'s `within("create", …)` wrapper — cite that symbol, not a line |

**Fix recipe.** Correct each. For the last one, prefer a symbol cite over a line cite:
"`store.create` stamps `createdAt` **before** `driver.create()` boots the VM — both run inside
`provisionAdmittedRun`'s `within("create", …)` span (`src/fleet/dispatch.ts`), which is why a first
boot always postdates `createdAt`."

---

### DF3.8-M2 — MEDIUM — `max-candidates-per-pass` bounds a count, not the wall clock

**Where:** `:112`.

**Defect.** The story mints `max-candidates-per-pass` "so one pass cannot run unboundedly long against
a large fleet". It bounds the **number** of candidates, not the time. Each candidate costs a marker
read (up to `DEFAULT_PER_CALL_DEADLINE_MS` = 10 s) plus a `/proc/uptime` read (another 10 s) plus, if
settled, a whole harvest → teardown → `reverify()` chain — and `reverify()` runs a test suite. A pass
of 20 candidates where 3 settle can run for a long time, serially (AC2a: "one at a time, never
concurrently"), holding one run lock at a time. On a cron with an interval shorter than the pass, two
sweeps overlap; the second loses on every lock and reports every candidate as a skip.

**Fix recipe.** `:112` → "… and a **max-candidates-per-pass** so one pass cannot examine an unbounded
number of runs. It bounds a **count, not a duration**: each candidate costs up to two
`DEFAULT_PER_CALL_DEADLINE_MS` reads and, if settled, a full chain including `reverify()`'s test
suite, all serially (AC2a). The pass therefore also carries a **wall-clock budget**, checked between
candidates: exceeding either is the same counted, logged partial pass. Overlapping sweeps are safe by
the lock (AC2c) but wasteful, so the documented cron interval is stated to exceed the observed
worst-case pass in the live e2e's own evidence, in the same voice `PROVISION_LAG_MARGIN_MS` is set."

---

### DF3.8-M3 — MEDIUM — `hostNow` read-time is unspecified in the uptime arithmetic

**Where:** `:80` (AC4a).

**Defect.** `uptimeSeconds < (hostNow − createdAt) − PROVISION_LAG_MARGIN_MS`. In a serial pass the
`/proc/uptime` read for candidate 20 can happen many minutes after the pass started. If `hostNow` is
sampled once per pass, the last candidates' `(hostNow − createdAt)` is understated relative to their
own read and the comparison drifts *toward* false negatives (missed reboots) — or, if sampled once at
the start and the pass is long, toward false positives for a box read early. The story does not say
when `hostNow` is read.

**Fix recipe.** Add to AC4(a): "`hostNow` is sampled **immediately before each candidate's
`/proc/uptime` read**, never once per pass: a serial pass can span minutes and a per-pass `hostNow`
drifts the comparison against every candidate but the first. The evidence JSON carries the raw
`hostNow`, `createdAt` and `uptimeSeconds` per box alongside the derived
`(hostNow − createdAt) − uptimeSeconds` so the margin can be re-derived from data."

---

### DF3.8-L1 — LOW — dependency edges

**Where:** `:64`.

`deps: [DF3.1, DF3.7, DF2.6, DF1.10]`. Add **DF2.2** — the story reads `/proc/uptime` through
`readBoxFile` and lists it as an Infra Prereq (`:104`) but not as an edge. DF2.10 is implicit through
DF1.10 and needs no separate edge here.

---

## 5. Cross-story contract findings (DF3.7 ↔ DF3.8)

### CC-A1 — BLOCKER — writer and reader agree with each other and both disagree with the substrate

Both stories name the marker `/run/journal/final.json` (DF3.7 `:9,:38,:86,:132`; DF3.8 `:45`). Shipped
is `/run/qds-run/<runId>/journal/final.json`. This is the pair's defining failure mode: the writer↔reader
contract is *internally consistent* and *externally wrong*, so no amount of cross-checking the two
stories against each other would have caught it — only a read of `journal.ts:97-131` and the unit
file does. Fix both together (DF3.7-B1); do not fix one and leave the other.

### CC-A2 — BLOCKER — "FINAL, consumed unchanged" is false in both directions

DF3.8 `:9` declares DF3.7's contract FINAL. DF3.8 then requires **an edit to DF3.7's module**
(`:126`: `run-completion.ts` "adds only a lock-agnostic re-entrant entry point") and **two one-clause
edits to DF3.7's text** (`:115`: the AC3 arm citation and the INV-IBOX-16 clause). Meanwhile DF3.7's
INV-IBOX-16 (`:119`) already forward-references DF3.8's amendment. The two stories are mutually
referential and neither is FINAL.

**Fix recipe.** Co-specify the entry-point signature **now**, in DF3.7, so DF3.8 edits nothing:

- DF3.7 `:109` Files to Modify → "`src/fleet/run-completion.ts` (new — the bounded observer and the
  chain composition. It **acquires no lock**, by construction and from day one: `acquireRunLock` is
  not re-entrant (`scripts/lib/run-lock.ts:952`) and every caller — this story's single-run verb and
  DF3.8's sweep — takes the lock itself before calling in. The exported entry is
  `observeAndDriveChain(runId, deps): Promise<ChainOutcome>`, and it is a **precondition**, asserted
  in its docblock, that the caller already holds `<runsDir>/<runId>.lock`.)"
- DF3.8 `:126` Files to Modify → "`src/fleet/run-completion.ts` (DF3.7-owned) — **not modified**.
  DF3.7 ships `observeAndDriveChain` lock-agnostic by construction; this story calls it with the run
  lock already held."
- DF3.7 `:119` INV-IBOX-16 → state the amendment as already made, rather than as a forward reference:
  "the invariant is 'at most one automatic caller at a time, each holding the per-run invocation
  lock', **not** 'exactly one caller'. DF3.8 is the sanctioned second caller and pays for it with the
  mutex; the lock lives in the caller, never in this module."

### CC-A3 — HIGH — "re-observing is idempotent because the marker is the state" is false after the chain runs

DF3.7 AC3 `:64` asserts idempotence unconditionally; DF3.8 AC2(c) `:78` leans on it
("the next tick re-observes idempotently") and `:109` builds the whole no-persistence design on it
("the marker remains the state and every sweep is a fresh read; that is what makes `--all` safely
re-entrant").

The claim holds **only on the unobserved arm** — window expiry with the box still alive. Once the
chain runs, teardown destroys the box (`teardownSandbox`: harvest → destroy → revoke → `closedAt`), so
the marker is gone with it. What makes a *driven* run non-repeatable is not the marker but `closedAt`
excluding it from the candidate set (AC2a). Two different mechanisms, presented as one.

**Fix recipe.** DF3.7 `:64` → "… and is safely re-runnable: **on this arm** the box is still alive and
the marker still there, so re-observing is idempotent because the marker is the state. (Once the chain
has run, the marker is gone with the box; what makes a driven run non-repeatable is `closedAt`, not
the marker — see DF3.8 AC2a's candidate filter.)" DF3.8 `:109` → "the marker is the state **for a run
the chain has not yet driven**, and `closedAt` is the state for one it has; between them every sweep
is a fresh read with nothing persisted."

### CC-A4 — BLOCKER — the pair cannot distinguish "run completed" / "box died" / "marker never written", and the primitive already exists

This is the assignment's central question and the answer is: **as specified, no.** Both stories model
exactly two outcomes — marker settled, or window expired. The shipped substrate produces at least
five states an observer meets: settled; still walking; engine died after the fork (`Type=simple` +
`Restart=no` → no marker, ever); box rebooted (tmpfs wiped + no `[Install]` → no marker, ever, and no
restart); box unreachable. `unitActivity` (`src/fleet/run.ts:437`) exists precisely to collapse the
middle three, its docblock enumerates them by name, and `fleet status` already consumes it
(`status.ts:33-36`, `:1182-1203`). Neither story mentions it.

Fixes are filed per-story as **DF3.7-B5** (liveness arm) and **DF3.8-B3** (terminal reboot arm); they
must land together — B3's terminal refusal is unsafe without B5's `unitActivity` reading, because a
box rebooted *before* the engine started has an active unit and a legitimately absent marker.

### CC-A5 — HIGH — the two time domains do not compose

DF3.7 mints an operator-settable **observation window** (deliberately longer than 1 h, `:96`).
DF3.8 mints a **sweep interval** derived from `staleAfterMs` and a **max-candidates-per-pass**, and
inherits DF3.7's window (`:112`: "the unusable-tick limit and observation window from DF3.7"). But a
sweep is *not* a wait: DF3.8's candidates are runs that have **already settled** (or not), and a sweep
that inherits a multi-hour observation window would hold one run's lock for hours on a run that has
not settled, serialising the entire pass behind it (AC2a: one at a time) — and the next cron tick would
find every other candidate locked.

**Fix recipe.** State in DF3.8 `:112` that the sweep uses a **single-read window, not DF3.7's polling
window**:

> The observation window is the one bound this story does **not** inherit. DF3.7's window is a
> foreground *wait* for a run that has not settled yet, deliberately sized past the 1 h fan-out
> ceiling; a sweep is not a wait. Each candidate gets **one** marker read and, on `absent`, **one**
> liveness probe, then the sweep moves on — a run that has not settled is simply a candidate again on
> the next tick, which is what makes `--all` re-entrant. Inheriting DF3.7's window would park one
> run's lock for hours and serialise the whole pass behind a run that had not finished (AC2a drives
> candidates one at a time), and the next tick would find every remaining candidate locked.

Add a matching sentence to DF3.7's Guards/limits: "The window is the foreground form's, and DF3.8's
sweep deliberately does not inherit it — see DF3.8 AC2a."

### CC-A6 — MEDIUM — exit-code grammar is specified on one side only

DF3.7 names no exit code at all (M3); DF3.8 names 5 and 0 (H4). Both add to DF3.1-owned tables that
DF3.5's skill-contract test pins. Under the recommended structural fix both stories ship the same
verb, so the table must be declared **once**, in DF3.7, and DF3.8 must add only whatever `--all`
introduces (nothing, if partial passes exit 0). Record the whole table in DF3.7 per DF3.8-H4's text
and have DF3.8 cite it rather than restate it.

### CC-A7 — MEDIUM — the observability keys join, but one field is missing on the DF3.7 side

DF3.7 emits `{requestId, runId, event, marker_poll_ms}` with `requestId` = `dispatchRequestId`
(`:104`). DF3.8 emits `{requestId, runId, event, sweep_ms}` with the sweep's **own** `requestId`,
while each driven run's chain "continues to carry its `dispatchRequestId` onto the gate's `pause`
event" (`:120`). For that join to work, DF3.7's chain must **accept** a `dispatchRequestId` distinct
from the invoking process's `requestId` — the sweep did not dispatch the run and cannot mint it. The
sweep must read it off the run record. Neither story says where it comes from.

**Fix recipe.** DF3.7 `:104` → "`requestId` propagates from the invocation onto every observer line;
the **chain** separately carries the run's own `dispatchRequestId`, read off the run record's
correlation stamp (`stampCorrelation`, `src/fleet/dispatch.ts`), which is what the gate's `pause`
event carries. The two are the same value when the observer runs inside the dispatching invocation
and different when a DF3.8 sweep drives the run — so the join key is the record's, never the
invocation's." DF3.8 `:120` → cite that sentence rather than assert the join.

### CC-A8 — VERIFIED CORRECT — security invariants

Checked and clean across the pair: the marker carries `{runId, ok, completedAt?}` and no credential
material; nothing is written into the box by either story; `/proc/uptime` is non-sensitive; no
secret reaches argv (both read through `readBoxFile`, whose command strings are built in the
providers layer); §6.2 one-secret-per-box is untouched (neither story mints or moves a key); no
`sk-or-` material can enter harvested artifacts through anything either story adds; redaction is not
weakened in transit (marker bytes are explicitly never echoed, both `:103`/`:119`). The tmpfs/reboot
interaction is *addressed* by both (DF3.7 AC3, DF3.8 AC4) — incompletely, per DF3.8-B3, but declared
rather than assumed. **Do not regress these.**

### CC-A9 — VERIFIED CORRECT — ADR conformance

Both stories keep the approval gate host-side, change zero lines of `approval-gate.ts`, and write no
`extensions.approval` field — which is ADR `:94-95` implemented exactly ("in-box engine writes an
awaiting marker; host polls; gate ownership unchanged"). Deviation 1 (the marker is a *completion*
signal, not an approval state) is the correct reading of that clause given the audit finding that the
engine never called the gate, and is honestly recorded in both stories. No shipped code in this
pair's blast radius contradicts the ADR.

---

## 6. Candidate PROPOSED ADR amendment (operator decision — not resolved here)

**One, and it is editorial rather than substantive.**

**PROPOSED-ADR-A1 — amend Consequence 4's "awaiting marker" to "completion marker".**
ADR `:115`: *"**Approval-gate bridge** — awaiting marker in-box, host polls; gate stays host-owned."*
Both DF3.7 (`:10`, `:99`) and DF3.8 (`:9`) implement this as a run-**completion** marker and record
the difference as Deviation 1, on the grounds that the 2026-08-31 audit established the engine never
called the gate and the ADR's own "host polls; gate ownership unchanged" requires the completion
reading. **This is correct.** But the result is that two stories now carry a standing, story-local
deviation against an ACCEPTED ADR clause — precisely the shape (a deviation recorded in a working
document rather than surfaced to the operator) that the ADR's own forensic section classifies as how
the original silent deviation happened (ADR `:19-23`: "recorded in dev workflow state, never surfaced
to a story deviation ledger, PR body, or operator gate").

Recommended amendment text, as an ADR appendix (the ADR is ACCEPTED; this is a clarification, not a
re-decision):

> **Appendix A (2026-09-08) — Consequence 4 clarification.** "Awaiting marker" in Consequence 4 was
> written before the 2026-08-31 audit established that the phase engine has never called the approval
> gate (`requestApproval`'s sole production caller is `src/reverify/runner.ts:461`, host-side and
> after teardown). The marker the in-box engine writes is therefore a run-**completion** signal
> (`{runId, ok, completedAt?}` at `/run/qds-run/<runId>/journal/final.json`), never an approval state,
> and the host's poll triggers the existing harvest → teardown → re-verify → gate chain rather than
> reading an approval. "Gate ownership unchanged" is unaffected and remains the binding clause. No
> re-decision; the Decision, the five load-bearing mechanisms and the Re-opening criteria stand.

**No other ADR amendment is required by this pair.** In particular, DF3.8's claim that it amends
DF3.7's INV-IBOX-16 is a *story* invariant, not an ADR clause, and needs no ADR action (see CC-A2 for
the story-side fix). DF3.8-B2 (the unlocked reaper) is a shipped-code gap, not an ADR conflict.

---

## 7. Structural proposal

**Re-point the delivery surface; keep both stories; adjust points.**

**The problem.** DF3.7's only user-visible artefact is `fleet dispatch --await-completion`, and
`fleet dispatch` does not start the engine (DF3.7-B3). The natural relocation, `fleet run`, is refused
by the shipped module's own contract ("never waits for the engine to finish … wiring any of that in
here is what would make the host hold a run whose whole point is that it does not",
`src/fleet/run.ts:1-11`) and by the ADR clause DF3.8 quotes (`:101-102`). So DF3.7 as scoped ships a
shape the arc exists to eliminate.

**The proposal.**

- **DF3.7 keeps its module and loses its flag.** It ships `src/fleet/run-completion.ts`
  (`observeAndDriveChain`, lock-agnostic by construction) plus the single-run verb
  `fleet observe <run-id>`, with the full exit table declared once in `verbs.ts`. Everything valuable
  in DF3.7 — the observe primitive, the chain composition, the import fence, INV-IBOX-14/15, the
  liveness arm — survives intact. What dies is one flag on the wrong verb.
- **DF3.8 adds `--all`, the sweep, the lock discipline and the reboot counter to the same verb.** Its
  edit to DF3.7's module disappears entirely (CC-A2), AC2(c)'s exclusion becomes trivially true and
  stronger (DF3.8-H2), and the exit table is inherited rather than restated (CC-A6).

**Why not merge into one story.** The two halves have genuinely different risk profiles — DF3.7 is
"compose four existing steps correctly", DF3.8 is "enumerate, serialise and measure a fleet" — and the
merge would be an 8-10 point story with one live e2e covering both. Keep them split; make DF3.7 a hard
predecessor (it already is) and add the sequencing note from DF3.8-B1.

**Re-sizing.**
- **DF3.7: 4 → 5 points.** The liveness arm (DF3.7-B5) is real new work: a second probe per tick, a
  new terminal outcome with its own exit code, and a live test that has to *produce* a failed engine
  start on a real box (the `EnvironmentFile` assertion path is the cheap way).
- **DF3.8: 4 → 5 points.** DF3.8-B3's terminal reboot arm and DF3.8-B2's reaper lock acquisition are
  both new, and B2 crosses a story boundary (a `tests/providers/reaper.test.ts` change) the current
  scope forbids.

**Dependency edge changes.**
- DF3.7: `[DF1.10, DF3.4, DF5.1]` → **`[DF1.10, DF2.2, DF2.10, DF3.1, DF3.4, DF5.1]`**.
- DF3.8: `[DF3.1, DF3.7, DF2.6, DF1.10]` → **`[DF1.10, DF2.2, DF2.6, DF3.1, DF3.7]`**.

**Nothing should be killed.** Both stories are load-bearing for the arc's product claim, and DF3.8 is
the one that makes "runs that survive host disconnect" true. Its honest bounding of that claim
(`:33-40` — "this story does not make the *host* unattended, it removes the requirement that the host
stay attached for the duration of the run") is the best-written paragraph in the pair and must survive
every fix wave verbatim.
