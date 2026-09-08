# Verify A — DF3.7 (Approval-Gate Bridge) + DF3.8 (Host-Side Completion Watcher)

**Reviewer:** verify-A (adversarial pre-dev, first read, beginner's mind)
**Date:** 2026-09-08 · **Branch:** `dev` @ `fa7d0e2`
**Files under review:**
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-7-approval-gate-bridge.md` (147 lines)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-8-host-completion-watcher.md` (155 lines)

**Method:** every file path, symbol and line number in both stories was opened and read.
The ADR (including Appendices A and B), `sprint-status.yaml`, and the shipped code at
`src/fleet/{fanout-primitive,status,run,verbs,index,approval-gate,dispatch}.ts`,
`src/phase-engine/journal.ts`, `src/providers/{reaper,teardown,quota,run-record,driver}.ts`,
`src/providers/exedev/transport.ts`, `src/reverify/{runner,approval,worktree}.ts`,
`scripts/{fleet,reverify,sandbox-reap,sandbox-teardown}.ts`, `scripts/lib/run-lock.ts` and
`oci/exedev/systemd/qds-run@.service` were read at the cited lines.

**Counts:** 3 BLOCKER · 5 HIGH · 6 MEDIUM · 3 LOW · 6 artifact-consistency disagreements.

**What is right, said once so it is not re-litigated:** Appendix A's completion-marker reading
is correctly carried by both stories with no story-local deviation (ADR `:145-151` demanded
exactly that, and both comply). The four-verdict/four-kind distinction (DF3.7 AC2) is a faithful
reading of `classifyMarkerRead` (`fanout-primitive.ts:773-911`) — including the `unreadable`-is-
not-a-skip rule (`:820-834`) and the `expectedRunId` mismatch arm (`:891-899`). `boxMarkerPath`
vs `runMarkerPath` (AC4) is correct and the shipped defect it cites is real
(`fanout-primitive.ts:685-700`). `writeTerminalMarker`'s payload and `completedAt`'s wire-
optionality are correct (`journal.ts:305-311, 375-388`). DF3.8 AC4(a)'s claim that `store.create`
stamps `createdAt` before `driver.create()` is **verified** in `provisionAdmittedRun`
(`src/providers/driver.ts` — `store.create` at rel. line 23, `driver.create` at rel. line 176);
the naive-comparison inversion is a real defect and the margin is the right shape. Neither story
puts a secret on argv, echoes marker bytes, weakens redaction, or adds a push credential in-box.

---

## BLOCKERs

### V-DF3.7-B1 — `pausing` recovery is promised by AC3/AC5 and is unreachable through the chain AC1 mandates
**Severity:** BLOCKER
**Where:** `df3-7-approval-gate-bridge.md:69` (AC3, "including for a record left at `pausing` by a
crashed chain: AC5 enters that record rather than refusing it, so `fleet observe <run-id>` is the
escape and no hand-run `scripts/reverify.ts` is required") and `:71` (AC5, "`pausing` is explicitly
NOT a refusal … Refusing it would strand for good exactly the run the resume arm was built to
save"), against `:67` (AC1, "the host runs the **existing** chain — harvest → teardown →
`reverify()`") and `:101` (Technical Notes ordering).

**Defect.** A record only reaches `pausing` *after* the box is destroyed. The story says so itself
at `:101`: "marker → host observes → harvest/destroy/revoke/`closedAt` → `reverify()` green →
`requestApproval` → `pausing`". The gate enforces it — `refuseLiveInfraOnDecidable`
(`src/fleet/approval-gate.ts:1119-1121`) refuses to promote a record that "is open and still names
[a box/key]", and ADR Appendix A (`:138-139`) records that `requestApproval`'s only production
caller "is host-side and runs *after* teardown". So a stranded `pausing` record has `closedAt`
set, no VM, and no tmpfs marker. AC5 then instructs the observer *not* to refuse it and to start
the chain. The chain's first act is `readMarkerVerdict(driver, vm, boxMarkerPath(runId), …)`
against a VM that no longer exists: every probe fails, every tick is `skip`
(`fanout-primitive.ts:939-941` catches the transport failure as `skip`), the marker is never
`settled`, and the run exits AC3's `run-completion-unobserved` at exit 1 having never called
`reverify()`. The gate's resume arm (`src/reverify/runner.ts:436-460`, correctly quoted by the
story) is real, but this story ships no path to it. **Both AC5 branches strand the run**: refusing
strands it (as AC5 says), and entering strands it too (as AC5 does not say). The DoD line that
tests this — `:141`, "a **`pausing`** record is entered and promoted (an implementation that
refuses it MUST fail)" — is unsatisfiable, and the only way to make it pass is a FakeDriver test
that plants a settled marker on a box the production path has already destroyed, i.e. a false green.

**Failure scenario.** Operator runs `fleet observe r-42`. Chain harvests, tears down, `reverify()`
returns green, `requestApproval` registers `pausing`, host is SIGKILLed before promotion. Record:
`closedAt` set, `extensions.approval.state = "pausing"`, box gone. Operator re-runs
`fleet observe r-42` (the remediation AC3 prints). AC5 does not refuse. The observer polls a dead
box for the whole observation window (operator-settable, sized past 1 h per `:103`), burning the
window, then prints `run-completion-unobserved` — "the host never saw it" — for a run whose gate
state is one `store.set` from `awaiting-approval`. The run is stranded for good, which is the
outcome AC5 exists to prevent.

**Fix recipe.** The chain needs a documented second entry point, and DF3.8 AC3 already assumes one
exists ("re-entered at the `reverify()` leg"). Make it explicit in DF3.7. Replace the AC5 clause at
`:71` beginning "**`pausing` is explicitly NOT a refusal**" through "…was built to save." with:

> **`pausing` is explicitly NOT a refusal, and it does not enter the marker poll either.** A
> `pausing` record is post-teardown by construction (`:101`; `approval-gate.ts:1119-1121` refuses to
> promote a record still naming live infrastructure), so its box and its tmpfs marker are already
> gone and polling `boxMarkerPath(runId)` against it can only produce `skip` ticks. On a `pausing`
> record `observeAndDriveChain` therefore **skips the observe and teardown legs entirely and calls
> `reverify(runId, {hostRoot, runsDir})` directly** — the gate compares the bound reportId
> byte-for-byte (`src/reverify/runner.ts:436-460`) and promotes. This is the same `reverify()`-leg
> re-entry DF3.8 AC3 names for its reaper-collected arm; it is ONE mechanism with two callers, not
> two. *Negative controls, all MUST fail: an implementation that refuses `pausing`, which strands
> the run; one that runs the marker poll on a `pausing` record, which polls a destroyed box to the
> window ceiling and reports `run-completion-unobserved` for a run one `store.set` from the pause;
> and one that runs `teardownSandbox` a second time on a `closedAt` record.*

And replace the DoD item at `:141` with: "a record carrying `awaiting-approval` or a terminal state
refuses the chain; a **`pausing`** record skips the observe and teardown legs and is promoted by
`reverify()`'s resume arm with **zero** `driver.exec` calls issued (asserted on the FakeDriver's
call log — an implementation that polls the marker first MUST fail)".

---

### V-CC-B1 — `unitActivity` reads `inactive`/`unknown` for a dispatched-but-not-yet-started run; DF3.7 AC2(d) makes that terminal and DF3.8's sweep enumerates exactly those runs
**Severity:** BLOCKER (cross-story)
**Where:** `df3-7…md:68` AC2(d) ("**`failed` or `inactive` with no marker is terminal, not late**")
and `df3-8…md:79` AC2(a) ("Candidates are records with `closedAt` unset whose box is live and
listable") + `df3-8…md:81` AC4(b) ("a box rebooted *before* the engine ever started has an active
unit and a legitimately absent marker, which is why all three readings are required").

**Defect.** `unitActivity` maps systemd's words (`src/fleet/run.ts:466-480`), and the `default`
branch's own comment says it "Includes `unknown` (systemd's own word for a unit it has never
loaded)". A box that `fleet dispatch` provisioned but `fleet run` has not yet started has no loaded
`qds-run@<runId>.service` instance, so `systemctl is-active` answers `inactive` or `unknown` — never
`active`. That box is nonetheless a perfect DF3.8 AC2(a) candidate: record open, box live, box
listable. DF3.7 AC2(d) then classifies the `inactive` reading as **terminal** `run-engine-dead`
("nothing will ever write that marker"), which is false for a run that simply has not been started
yet. The sweep therefore terminally refuses every run sitting in the ordinary dispatch→run window —
the window DF6.1a's E2E slice and every two-command operator flow depend on.

DF3.8 AC4(b) compounds it with a factually inverted premise. It asserts that a never-started run is
protected by the `active` reading. It is not: after a reboot the unit is not merely stopped, it is
*never loaded again*, because DF2.10 ships the unit with **no `[Install]` section** deliberately
(`oci/exedev/systemd/qds-run@.service:277-289`, cited by AC4(b) itself for the opposite conclusion)
and `Restart=no` (`:169`). So a rebooted, never-started run reads reboot-confirmed **+** absent
marker **+** non-`active` unit and is fired at by AC4(b)'s terminal `run-lost-to-reboot` arm — the
one arm AC4(b)'s own negative control ("one that fires this arm on a reboot alone … kills a run
whose engine started after the reboot") claims the third reading prevents. The third reading
prevents nothing here.

**Failure scenario.** Operator: `fleet dispatch --driver exedev` → box `r-77` provisioned,
`createdAt` stamped. Operator is interrupted before `fleet run r-77`. Their `cron` line
`fleet observe --all` fires 5 minutes later. `r-77` is enumerated (open record, live box), the
sweep takes its lock, marker absent, `unitActivity` → `inactive`. The sweep emits terminal
`run-engine-dead`, tells the operator to run `systemctl status qds-run@r-77.service` on a unit that
was never started, and — per DF3.8 AC6 — counts it as a benign skip. The operator then runs
`fleet run r-77`; the run walks fine; but every tick has already been telling them it is dead.
Worse variant: the box reboots at minute 3, so the reading is reboot-confirmed + absent marker +
non-`active`, and DF3.8 AC4(b) refuses it **terminally** and excludes it from every subsequent pass,
for a run that would have started perfectly.

**Fix recipe.** Both halves need a "has this run ever been started?" discriminator, and the record
already carries one (DF1.10's `fleet run` is what makes the unit exist). In DF3.7 `:68` AC2(d),
replace "**`failed` or `inactive` with no marker is terminal, not late**: the unit is `Type=simple`
with `Restart=no`" with:

> **`failed` is terminal. `inactive` is terminal ONLY for a run this host has already started**:
> `unitActivity` returns `inactive` (or `unknown` — `run.ts:476-479`, "systemd's own word for a unit
> it has never loaded") both for an engine that exited and for a unit `fleet run` never started, and
> the unit carries no `[Install]` section (`qds-run@.service:277-289`), so a reboot returns a
> started run to the never-loaded reading too. The observer therefore reads the run record's
> start stamp first and refuses `run-engine-dead` only when the record says the unit was started;
> for a record with no start stamp it refuses the distinct, non-terminal
> `{ code: "run-never-started", … }` naming `fleet run <runId>` as the remediation. The unit is
> `Type=simple` with `Restart=no` (`:58`, `:169`), so for a started run nothing will ever write
> that marker.

*(If DF1.10's record carries no such stamp, this is a DF1.10 seam DF3.7 must declare as a
predecessor requirement rather than infer — flag it to the arc owner; do not resolve it by
heuristic.)*

In DF3.8 `:81` AC4(b), delete the sentence "a box rebooted *before* the engine ever started has an
active unit and a legitimately absent marker, which is why all three readings are required" and
replace with: "a box rebooted before the engine ever started reads `inactive`/`unknown` too — the
unit has no `[Install]` section (`qds-run@.service:277-289`) so it is never re-loaded — which is why
the three readings are NOT sufficient and the arm additionally requires DF3.7 AC2(d)'s
`run-never-started` discriminator to be absent. A run with no start stamp is `run-never-started`,
never `run-lost-to-reboot`." Add the matching negative control and a DoD line asserting a
dispatched-but-unstarted candidate survives a full sweep unrefused-terminally.

---

### V-CC-B2 — `observeAndDriveChain(runId, deps)`'s contract is unspecified at exactly the three seams DF3.8 must use, and DF3.8 forbids itself from adding them
**Severity:** BLOCKER (cross-story)
**Where:** `df3-7…md:118` (Files to Modify — "The exported entry is
`observeAndDriveChain(runId, deps): Promise<ChainOutcome>`") and `:103`, against `df3-8…md:113`,
`:127`, `:79` AC2(b), `:80` AC3, `:83` AC6.

**Defect.** DF3.7 names one exported symbol and one return type and specifies neither `deps` nor
`ChainOutcome`. DF3.8 then depends on three things that can only live in that unspecified surface,
while its own Files-to-Modify (`:127`) states `src/fleet/run-completion.ts` is "**not modified**":

1. **The poll bound.** DF3.7 `:103` says the observation window "is operator-settable **on the
   verb**" and "is the **foreground form's**, and DF3.8's sweep deliberately does not inherit it".
   DF3.8 `:113` requires "Each candidate gets **one** marker read and, on `absent`, **one** liveness
   probe, then the sweep moves on", and explains correctly that inheriting the window "would park
   one run's lock for hours and serialise the whole pass". Both are right about the requirement and
   neither states the mechanism. If the window is the verb's, the shared module has no knob; if it
   is `deps`', DF3.7 must say so. As written the sweep cannot get one-tick behaviour without editing
   the module it is forbidden to edit.
2. **`hostRoot`.** DF3.7 `:104` requires the chain to pass `hostRoot` "**explicitly**" into
   `reverify()`; DF3.8 `:83` AC6 requires the sweep to resolve it "once, before any candidate is
   driven" and pass it "explicitly into every chain call". That is a `deps.hostRoot` field on
   `observeAndDriveChain` and neither story declares it.
3. **The witness signal.** DF3.8 `:80` AC3 turns on "whether this invocation had already witnessed
   the marker itself before the collection". The marker read is inside DF3.7's module, so the
   sweep can only learn this from `ChainOutcome` — which is undefined. There is also no
   `reverify()`-leg entry point on the module (see V-DF3.7-B1), so AC3's "re-entered at the
   `reverify()` leg" names an entry that does not exist.

**Failure scenario.** Dev implements DF3.7 exactly as written: `observeAndDriveChain(runId, {driver,
store, runsDir, hostRoot})` with a module-constant window sized past 1 h. Dev implements DF3.8:
enumerates 12 candidates oldest-first, takes `r-01`'s lock, calls in. `r-01` has not settled. The
call blocks for the full window holding `r-01`'s lock. The pass's wall-clock budget (DF3.8 `:113`)
is checked "between candidates" and is never reached because there is no second candidate. The next
`cron` tick finds `r-01` locked and skips it, and the 11 runs behind it — including three that
settled an hour ago — are never reached. The sweep reports `runs_observed: 0` and exits 0 on every
tick. This is the exact starvation DF3.8's oldest-first ordering paragraph argues it has prevented.

**Fix recipe.** Add to DF3.7's Files-to-Modify entry at `:118`, after "`Promise<ChainOutcome>`":

> Its `deps` are `{ driver, store, runsDir, hostRoot, maxTicks?, windowMs? }` — `hostRoot` is
> **required**, resolved and asserted a git worktree by the caller before any box is touched
> (`:104`), never discovered inside `reverify()`; and the poll bound is the caller's, expressed as
> `maxTicks` (default unset = poll to `windowMs`). `fleet observe <run-id>` passes the operator's
> window; DF3.8's sweep passes `maxTicks: 1` (`df3-8…md:113` — a sweep is not a wait). A
> module-constant window that neither caller can override MUST fail DF3.8's serialisation test.
> `ChainOutcome` is a discriminated union the caller can count and log without re-deriving:
> `{ kind: "driven"; markerOk: boolean; chainMs: number }` · `{ kind: "unsettled"; verdict:
> MarkerVerdict; markerWitnessed: false }` · `{ kind: "refused"; code: string; message: string;
> remediation: string; markerWitnessed: boolean }`. `markerWitnessed` is what DF3.8 AC3's
> `completion-unwitnessed` arm turns on; it is **never** persisted and means "witnessed by THIS
> invocation" (`df3-8…md:80`).

And add a second exported entry for the post-teardown legs (see V-DF3.7-B1's fix), cited by DF3.8
AC3 rather than restated there.

---

## HIGH

### V-CC-H1 — DF2.11 makes `teardownSandbox` take a required `RunLockHandle`; DF3.7 ships the 8th caller with no handle and no DF2.11 edge
**Severity:** HIGH (cross-story)
**Where:** `df3-7…md:59` (Dependency edges — DF2.11 absent), `:118` (`observeAndDriveChain` "acquires
no lock"), `df3-8…md:79` AC2(e) and `:136` INV-IBOX-18, against
`sprint-status.yaml:168` ("teardownSandbox takes a **REQUIRED** branded `RunLockHandle` … so an
unlocked call **FAILS TO COMPILE** — 7 direct callers exist today across 3 modules and **DF3.7 was
about to add an eighth** … Consumers: DF3.7, DF3.8 (AC2e)").

**Defect.** `teardownSandbox(deps, runId, opts)` is `src/providers/teardown.ts:463` and today takes
no handle. DF2.11 is `ready-for-dev` in the same sprint and changes that signature to require a
branded handle. DF3.7's chain calls `teardownSandbox` and DF3.7 deliberately holds no lock — the
handle exists only in the *caller* (`scripts/fleet.ts`'s `observe` block, or `src/fleet/observe.ts`).
So the handle must be threaded through `deps` into `run-completion.ts`. DF3.7 does not mention
DF2.11, does not list it as an edge, and does not put a handle in `deps`. DF3.8 discusses DF2.11 at
length (AC2(e), INV-IBOX-18) but only as the story that closes the *reaper* race — it never notices
that the same change breaks the module it calls. Whichever of DF2.11/DF3.7 lands second breaks the
build.

**Failure scenario.** DF2.11 merges first (it has no dependency on DF3.7). DF3.7's dev writes
`await teardownSandbox(tdeps, runId)` per its own AC1 "composes … without re-implementing any step",
and `tsc` fails with a missing required argument the story never mentions. The dev's cheapest fix is
to acquire the lock inside `run-completion.ts` — which is precisely what DF3.8 AC2(b) and DF3.7's
INV-IBOX-16 forbid, and which breaks every sibling caller with `RunLockReentrantError`
(`scripts/lib/run-lock.ts:72-78, :951`).

**Fix recipe.** Add DF2.11 to DF3.7's dependency edges at `:59` and add to `:118`:

> `deps` carries the caller's `runLock: RunLockHandle` (DF2.11) and passes it to `teardownSandbox`
> unchanged. The module still acquires **nothing** — holding a handle and taking a lock are
> different acts, and the handle is what makes "the caller already holds `<runsDir>/<runId>.lock`"
> a *compile-time* precondition instead of a docblock one. **Ordering:** if DF2.11 has not merged
> when this story starts, the parameter is added anyway and typed `string`, and DF2.11 narrows it
> to the brand — this story is the eighth caller `sprint-status.yaml:168` names.

Add the matching sentence to DF3.8 `:112` (Region ownership) so the sweep's `acquireRunLock` return
value is explicitly the handle it passes down.

### V-DF3.7-H1 — the skip streak is counted and nothing is specified to happen when it fills
**Severity:** HIGH
**Where:** `df3-7…md:68` AC2(a) ("`skip` resets nothing and is counted on its own, deliberately laxer
streak against **`PROBE_SKIP_TICKS_LIMIT`** (=6, `:101`)") and DoD `:138` ("a probe exit of 255 is
`skip` … and counts against `PROBE_SKIP_TICKS_LIMIT`").

**Defect.** For `unusable`, AC2(a) states the terminal disposition ("after which the run is abandoned
to AC3's arm rather than polled to the window ceiling"). For `skip`, it states only that a counter
increments. No AC, no DoD item and no exit-code row says what a filled skip streak produces. This
is the "asserts a mechanism *exists* rather than that it *fires*" defect class exactly: an
implementation that increments a variable and never reads it satisfies every word of AC2(a) and DoD
`:138`, and the negative control ("one that treats `probeExit: 255` as a clean absence resets the
streak on every tick of a dead box") also passes, because that implementation does not reset the
streak — it simply never acts on it.

**Failure scenario.** Box's ssh dies at minute 4 of a 90-minute window. Every tick is `skip`. The
streak reaches 6 at ~30 s and keeps climbing to ~1000. The observer polls a dead box for 86 more
minutes, then reports `run-completion-unobserved` at exit 1 — "transient, the run may settle on a
later invocation" — sending automation into an unbounded retry against a box that stopped answering
an hour and a half ago, while it bills.

**Fix recipe.** In AC2(a), after "(=6, `:101`); a transport failure is often transient where a parse
failure is permanent." insert:

> A **filled** skip streak is terminal for this invocation and typed:
> `{ code: "box-unreachable", message, remediation }` naming the box, the run and the last probe's
> `code`/exit, at **exit 1** (transient — the box may answer a later invocation), leaving the box
> alive and listable and mutating no record field. It is a distinct code from AC3's
> `run-completion-unobserved`, which means "the window expired while the box kept answering
> `absent`"; conflating the two tells an operator the host never looked when in fact the box never
> answered. *Negative control, MUST fail: an implementation that increments the skip streak and
> never reads it, which polls an unreachable box to the window ceiling while it bills and passes
> every "255 is not a clean absence" test.*

Add the matching DoD line and add `box-unreachable` to the Observability `event` enum at `:112`.

### V-DF3.7-H2 — `PROBE_SKIP_TICKS_LIMIT` is imported out of the corroboration regime that makes it safe
**Severity:** HIGH
**Where:** `df3-7…md:103` ("`PROBE_SKIP_TICKS_LIMIT`'s own wall-clock reasoning (`:85-93`) is priced
against it") and AC2(a) at `:68`.

**Defect.** The story imports the constant and its wall-clock reasoning but not the caveat that
immediately follows it in the same docblock. `fanout-primitive.ts:91-99` says: "Because the fast end
of that range is short, this limit alone cannot tell a dead box from a dead HOST — one wifi/VPN/DNS
blip fails every arm at once … `runRace` therefore **only applies the limit when SOMETHING answered
on the same tick** (or when the starved arm is the last undecided one …). Abandoning is fail-safe
for the BOX … but it is not fail-safe for the RUN, **which is why it needs corroboration**." A
single-run observer has exactly one arm and therefore *no* corroboration ever — it permanently
occupies the "last undecided arm" fallback the docblock treats as the degenerate case. The story's
own cite range `:85-93` straddles the start of that paragraph without engaging it.

**Failure scenario.** Operator's wifi drops for 35 seconds during an eight-hour unattended run.
Six consecutive fast-failing probes (`ssh: connect … Connection refused` returns in well under a
second, per `:83-85`) fill the streak inside 30 s. With V-DF3.7-H1's fix applied the observer
abandons a perfectly healthy run; without it, it does nothing at all. Neither is correct.

**Fix recipe.** In Technical Notes `:103`, replace the `PROBE_SKIP_TICKS_LIMIT` clause with:

> `PROBE_SKIP_TICKS_LIMIT` (=6) is imported as the constant but **not** as fan-out's disposition:
> `runRace` only applies it with corroboration from another arm (`fanout-primitive.ts:91-99` — "one
> wifi/VPN/DNS blip fails every arm at once … it is not fail-safe for the RUN, which is why it needs
> corroboration"), and a single-run observer has no second arm to corroborate against. This story
> therefore applies the limit **against wall-clock, not tick count**: the skip streak is terminal
> only after `PROBE_SKIP_TICKS_LIMIT` consecutive skips **and** at least
> `PROBE_SKIP_TICKS_LIMIT × (DEFAULT_POLL_INTERVAL_MS + DEFAULT_PER_CALL_DEADLINE_MS)` (= 90 s on
> the AC5 defaults, the slow end of the docblock's own range) has elapsed since the last tick that
> reached the box. The constant is still imported, never mirrored; what is local to this story is
> the *disposition*, and it is stated here rather than inherited by accident. *Negative control,
> MUST fail: an implementation that abandons a healthy run after six sub-second probe failures —
> a 30 s wifi blip — which is fan-out's un-corroborated arm applied where nothing can corroborate.*

### V-DF3.8-H1 — AC6, AC2(c) and DoD `:142` give three different answers for exit 5 in a sweep
**Severity:** HIGH
**Where:** `df3-8…md:83` AC6 ("in a sweep, a per-run refusal — `completion-unwitnessed`,
`run-lost-to-reboot`, `run-engine-dead`, a busy or stale lock — is a **counted skip**, never the
sweep's exit code … Only a failure to complete the pass itself is non-zero"); `:79` AC2(c) ("the
losers get `RunLockedError` → **DF3.1's exit 5**, a counted skip and not a sweep failure"); `:142`
DoD ("reusing that verb's declared exit table unchanged (**5 = lock refused or a terminal per-run
refusal**, 0 = a pass that completed …)").

**Defect.** AC6 says a per-run lock refusal never becomes the sweep's exit code. AC2(c) says it maps
to exit 5 *and* is a counted skip — exit 5 of what process, given the sweep is the only process?
DoD `:142` says 5 **is** the sweep's code for a lock refusal or "a terminal per-run refusal",
directly contradicting AC6. A dev implementing to DoD `:142` writes a sweep that exits 5 the first
time any candidate's lock is busy; a dev implementing to AC6 writes one that exits 0. The
skill-contract test (`src/fleet/verbs.ts:86-91`) compares the declared table against what the verb
returns, so the two implementations produce different contract evidence and one of them will be
"fixed" by weakening the test.

**Failure scenario.** Two `cron` ticks overlap (the interval is derived from `staleAfterMs`, and
DF3.8 `:113` admits the pass duration is not bounded by a duration). Tick B finds every candidate
locked by tick A. Under DoD `:142` tick B exits 5 on a healthy fleet; the operator's `cron` mails
them a failure on a benign overlap and, per AC6's own reasoning, "trains the operator to ignore the
schedule".

**Fix recipe.** AC6 is correct and AC2(c)/DoD `:142` are wrong. In AC2(c) at `:79`, replace "the
losers get `RunLockedError` → **DF3.1's exit 5**, a counted skip and not a sweep failure" with:
"the losers get `RunLockedError`, which the **single-run** form `fleet observe <run-id>` reports as
DF3.1's exit 5 ('refused before provisioning', `verbs.ts:117-124`) and which the **sweep** records
as a counted `lock-refused` skip inside a pass that still exits 0 (AC6) — the exit code belongs to
the invocation, and a sweep's invocation did not fail." In DoD `:142`, replace "5 = lock refused or
a terminal per-run refusal, 0 = a pass that completed, including an empty one and a partial one"
with "the single-run form maps a lock refusal and every terminal per-run refusal to 5; `--all` maps
**every** per-run outcome to a counted skip and exits 0 for any pass that completed, including an
empty one and a partial one — an implementation that lets one busy lock decide the sweep's exit
code MUST fail".

### V-DF3.8-H2 — `run-engine-dead` gets the benign-skip treatment that AC4(b)'s own negative control condemns, while the rarer `run-lost-to-reboot` gets the terminal arm
**Severity:** HIGH
**Where:** `df3-8…md:83` AC6 (lists `run-engine-dead` among "counted skip"), `:81` AC4(b) ("one that
folds `run-lost-to-reboot` into the benign skip count reports a permanently unobservable run as
healthy on every tick"), `:113` (the oldest-first starvation argument), `:122` (counters:
`runs_observed`, `box_reboot_after_dispatch`, `runs_lost_to_reboot`, `uptime_unknown` — no
engine-dead counter).

**Defect.** AC4(b) builds an entire terminal arm, a dedicated counter and three negative controls
around the *reboot* case, on the correct reasoning that a permanently-unobservable candidate at the
head of an oldest-first queue starves the tail and reads as healthy. It then hands the **more
common** permanently-unobservable case — an engine that started, walked three phases and died
(`Type=simple`, `Restart=no`, `qds-run@.service:169`, so the marker never appears) — the exact
disposition it just condemned: a benign counted skip, with no counter on `sweep-complete`, no
retirement from the candidate set, and no once-per-pass reporting. `:113` then leans on AC4(b) for
the whole starvation argument ("The one permanently-refusing case the substrate actually produces —
a box rebooted after dispatch — is what AC4(b)'s `run-lost-to-reboot` arm retires"). "The one" is
wrong; a dead engine is the other, and it produces no reboot signal at all.

**Failure scenario.** `r-03`'s engine OOMs at phase 4 on Monday. Record open, box live and listable,
marker absent, `unitActivity` → `failed`, uptime long (no reboot). It is the oldest candidate, so
oldest-first puts it first on every pass. Every tick costs one marker read plus one liveness probe
on it, it is counted in nothing, and the `sweep-complete` line reads
`{runs_observed: 0, box_reboot_after_dispatch: 0, runs_lost_to_reboot: 0, uptime_unknown: 0}` — a
perfectly healthy-looking sweep. It bills until an operator runs `sandbox-reap --yes`, which
collects it witness-less: the outcome this story's Spec Reference (`:12`) says it exists to end.

**Fix recipe.** In AC6 at `:83`, remove `run-engine-dead` from the counted-skip enumeration. In
AC4(b) at `:81`, after the `run-lost-to-reboot` sentence, add:

> The same disposition applies to DF3.7 AC2(d)'s **`run-engine-dead`**, which is the *more common*
> permanently-unobservable candidate — an engine that started and died leaves `Restart=no`
> (`qds-run@.service:169`) and no marker will ever appear, with no reboot signal to detect it by. It
> is reported **once per pass** with its typed payload, counted in its own `runs_engine_dead`
> counter on the `sweep-complete` line, and re-derived and re-refused each pass at the cost of that
> pass's two reads — never a benign skip. *Negative control, MUST fail: an implementation that
> retires `run-lost-to-reboot` but folds `run-engine-dead` into the benign skip count, which parks
> the arc's most common dead run at the head of an oldest-first queue and reports every tick as
> healthy.*

Add `runs_engine_dead` to `:122` and `run-engine-dead` to the `event` enum at `:120`, and extend the
AC4 DoD line at `:148` to cover it.

---

## MEDIUM

### V-DF3.7-M1 — `record-claim-refused` cited at `reaper.ts:750-756`; the actual arm is `:805-811`
**Severity:** MEDIUM · **Where:** `df3-7…md:69` (AC3).
`src/providers/reaper.ts:747-753` is the **`ownership-recheck-refused`** failure (the
`driver.list()` non-array arm). `record-claim-refused` is at `:806-811`, code string at `:808`,
guarded by `claimed !== undefined && claimed.closedAt === undefined` at `:805`. DF3.8 `:12` carries
the correct cite (`:808`) and its Deviation 1 explicitly exists to correct this sentence — but
DF3.7 was never edited, so the wrong cite survives in the story an implementer reads first. A dev
following it lands in an unrelated arm and concludes the sparing behaviour does not exist.
**Fix:** at `:69`, replace "`src/providers/reaper.ts:750-756`" with "`src/providers/reaper.ts:805-811`".

### V-DF3.7-M2 — `stale-record` → `teardown` cited at `reaper.ts:480-487`, which is the key-list enumeration error
**Severity:** MEDIUM · **Where:** `df3-7…md:69` (AC3, "classifies `stale-record` → `teardown`
(`reaper.ts:480-487`, `:534-544`)").
`:480-492` is the `listAllKeys` failure → `SweepError("list-unverified")` and has nothing to do with
staleness. The real classification sites are `:531-539` (VM loop), `:575-582` (key loop) and
`:587-595` (record loop); `aged()` is `:510` and the limit is read at `:424`. `:534-544` is close
enough to the VM loop to be usable; `:480-487` is not.
**Fix:** replace "(`reaper.ts:480-487`, `:534-544`)" with "(`reaper.ts:510` `aged()`; three
classification sites — `:531-539` VM, `:575-582` key, `:587-595` record)".

### V-DF3.8-M1 — "two sites" is three, and ":575-595 record-side" spans the key loop
**Severity:** MEDIUM · **Where:** `df3-8…md:12` ("`:531-541` VM-side, `:575-595` record-side — two
sites, `:579` and `:592`").
There are **three** `stale-record` → `teardown` classifications, in three separate loops:
`:531-539` (VM, action at `:537`), `:575-582` (**key**, action at `:580`) and `:587-595` (record,
action at `:593`). The story's `:575-595` range silently merges the key loop and the record loop and
labels the pair "record-side"; the cited line `:579` is inside the **key** loop. A dev writing the
AC3 test from this will build a fixture that reaches two of the three arms and conclude the third
cannot fire.
**Fix:** replace with "`:531-539` VM-side (`:537`), `:575-582` key-side (`:580`), `:587-595`
record-side (`:593`) — **three** sites, one per enumeration loop".

### V-CC-M1 — AC1's stated reason for banning the fleet barrel is factually wrong
**Severity:** MEDIUM (cross-story) · **Where:** `df3-7…md:67` (AC1, "`src/fleet/index.ts` (the
barrel, which star-exports both the gate's neighbours and `status.ts` — `src/fleet/index.ts:8-20`)")
and `:126` (INV-IBOX-14, "or the `src/fleet/index.ts` barrel that star-exports them"), inherited by
`df3-8…md:78` AC1 and `:135` INV-IBOX-17 "verbatim".

**Defect.** `src/fleet/index.ts` is 20 lines and star-exports exactly eight modules:
`brief-schema`, `dispatch`, `status`, `verbs`, `fanout`, `fanout-primitive`, `rank`, `resident`.
It does **not** export `approval-gate.ts` or `approvers.ts`, and `export * from "./status.ts"`
re-exports status's own exports, not its imports — so `requestApproval` is not reachable through
the barrel at all. What *is* true, and is the real reason the barrel is worth banning, is that
`src/fleet/status.ts:54` **imports** `expiredState` from `./approval-gate.ts`, so the barrel drags
the gate module into the import graph. The ban is defensible; the sentence justifying it is not,
and a test author who writes the assertion the story describes ("the barrel re-exports the gate's
symbols") will write a test that fails on the real barrel and then be weakened — the precise
"weakened until it catches nothing" failure AC1's own negative control warns about.

**Fix.** In `:67` and `:126`, replace "(the barrel, which star-exports both the gate's neighbours and
`status.ts` — `src/fleet/index.ts:8-20`)" with "(the barrel — `src/fleet/index.ts:8-20` — which
star-exports eight fleet modules including `status.ts`, and `status.ts:54` imports `expiredState`
from `approval-gate.ts`, so naming the barrel pulls the gate module into this module's import graph
even though the barrel re-exports none of the gate's own symbols)". Adjust DF3.8 `:78`/`:135`
identically, since both say "verbatim".

### V-CC-M2 — the two Observability Contracts describe the same code path with divergent vocabularies, and DF3.8 has no counter for the common case
**Severity:** MEDIUM (cross-story) · **Where:** `df3-7…md:112` (`event ∈ run-complete |
marker-absent | marker-skip | marker-unusable | run-engine-dead | run-completion-unobserved`) vs
`df3-8…md:120` (`event ∈ run-observed | candidate-skipped | lock-refused | completion-unwitnessed |
run-lost-to-reboot | sweep-complete`) and `:122` (counters).

**Defect.** DF3.8 calls DF3.7's module, so DF3.7's module emits DF3.7's events under a sweep. The
sweep's own enum shares not one member with them, and `run-completion-unobserved` — which is what
DF3.7's chain returns on every candidate that has not settled, i.e. the **majority outcome of every
sweep** — appears in neither DF3.8's enum nor its counters. `sweep-complete` carries
`runs_observed`, `box_reboot_after_dispatch`, `runs_lost_to_reboot`, `uptime_unknown`; a pass over
30 candidates of which 28 are simply still running reports `runs_observed: 2` and no denominator.
An operator cannot tell that sweep from one where 28 candidates errored.
**Fix.** Add to DF3.8 `:120`: "plus every event DF3.7's module emits on the invocation's own channel,
unchanged — this story mints no second vocabulary for a line DF3.7's code writes." Add
`candidates_enumerated` and `runs_unsettled` to the `sweep-complete` counters at `:122`, and state
that `runs_observed + runs_unsettled + runs_engine_dead + runs_lost_to_reboot + lock_refused +
completion_unwitnessed + uptime_unknown_terminal` accounts for `candidates_enumerated` minus the
partial-pass remainder.

### V-DF3.8-M2 — putting `acquireRunLock` in `src/fleet/observe.ts` trips a documented upgrade trigger in the lock module, unmentioned by either story
**Severity:** MEDIUM · **Where:** `df3-8…md:112` ("`src/fleet/observe.ts` is new and this story's
own, and it is where `acquireRunLock` is called") and `:11` ("the per-run invocation lock
`scripts/fleet.ts` already takes for run-scoped verbs").

**Defect.** `scripts/lib/run-lock.ts:931-932` carries an explicit ceiling: "**ponytail:** library
callers bypass the lock — the CLIs are the operator surface. **Upgrade trigger: an embedder (not a
CLI) becomes a supported caller.**" `src/fleet/observe.ts` is a library module under `src/`, not a
CLI, and it is a supported caller. That is the trigger, verbatim. Secondary facts the story should
state rather than leave a dev to discover: `acquireRunLock` returns a `string` (the resolved lock
path) — the value DF2.11 will brand (see V-CC-H1) — it keys `held` on `globalThis` and installs a
process-global signal-release handler (`:938-951`), and it is currently imported only from
`scripts/`, so `src/fleet/observe.ts` would be the first `src/ → scripts/lib/` import of it.

**Fix.** In `:112` after "it is where `acquireRunLock` is called", add: "This is the upgrade trigger
`run-lock.ts:931-932` names — 'library callers bypass the lock … an embedder (not a CLI) becomes a
supported caller' — and this story is that embedder, so the note is retired rather than left
standing false. `acquireRunLock` returns the resolved lock path (`:934`, `:950`), which is the value
DF2.11 brands as `RunLockHandle` and which this story passes into DF3.7's `deps.runLock`; its `held`
map and signal-release handler are process-global (`:938-951`), which is what makes serial
acquire/release across a pass safe in one process and is why the pass is serial (AC2a)."

---

## LOW

### V-DF3.7-L1 — `run-lock.ts:952` is off by one
`df3-7…md:118` and `:128` cite "`acquireRunLock` is not re-entrant (`scripts/lib/run-lock.ts:952`)".
The guard is `:951` (`if (moduleState().held.has(lock)) throw new RunLockReentrantError(lock);`);
`:952` is `reapStaleTemps(runsDir, runId)`. DF3.8 `:79` cites "guard at `:952`" identically. Fix
both to `:951`.

### V-DF3.7-L2 — `writeTerminalMarker` cited at its write statement, not its declaration
`df3-7…md:11` cites "`writeTerminalMarker` (`:381`)". `:381` is the `fs.writeFileSync` payload line
inside the function; the declaration is earlier. Harmless for a reader who greps the symbol, but
the story's other symbol cites are declaration lines, so this one reads as a different kind of
reference. Fix to the declaration line.

### V-DF3.7-L3 — AC2(a)'s verdict enumeration is incomplete against the shipped classifier
`df3-7…md:68` enumerates `unusable` as "unreadable at `cat`, oversized, unparseable, non-boolean
`ok`, or a `runId` naming another run". The shipped `classifyMarkerRead` also produces `unusable`
for `marker-read-budget-exhausted` (`exitCode: -1`, no `cat` ever issued — `:813-819`),
`marker-run-id-invalid` (present-but-non-string `runId` — `:882-889`) and a JSON body that parses
to `null` or a primitive (`:869-875`); and it produces `skip` for `marker-read-unclassified` (an
unknown `BoxFileRead` kind — `:847-852`). No behavioural consequence — the story consumes the
function rather than re-deriving it, which is exactly what AC2 requires — but the enumeration reads
as exhaustive and is not. Add "…, a `cat` that was never issued because the presence probe spent the
whole shared budget, a present-but-non-string `runId`, or a body that parses to `null`/a primitive"
and note that `skip` also covers a `BoxFileRead` kind this build does not classify.

---

## Artifact-consistency sweep — `sprint-status.yaml` vs the story headers

Points and sprint tags **agree** in both directions: DF3.7 = 4 pts / v5-S3 / `ready-for-dev`
(`sprint-status.yaml:184`, story `:3-4`); DF3.8 = 4 pts / v5-S3 / `ready-for-dev` (`:185`, story
`:3-4`). No disagreement there. Six other disagreements, all in the yaml's per-story comment:

| # | Disagreement | yaml | story | Authoritative |
|---|---|---|---|---|
| A1 | **DF3.7 dependency edges** | `deps: [DF1.10, DF3.4, DF5.1]` (`:184`) | `DF1.10, DF2.2, DF2.10, DF3.1, DF3.4, DF5.1` (`:59`) | **Story.** DF3.1 owns `verbs.ts`/`scripts/fleet.ts`, which DF3.7 edits; DF2.2 owns `readBoxFile`, which AC2 consumes; DF2.10 ships the unit and the no-`QDS_*` guarantee AC4 rests on (and `sprint-status.yaml:170` itself says DF2.10 "guarantees no QDS_RUN_ROOT … which is what … DF3.7's AC4 rest[s] on"). The yaml contradicts its own DF2.10 line. **Also add DF2.11** per V-CC-H1. |
| A2 | **DF3.8 dependency edges** | `deps: [DF1.10, DF2.6, DF3.1, DF3.7]` (`:185`) | adds **DF2.2** (`:65`, and an Infra Prereq at `:105` for both the marker and `/proc/uptime`) | **Story.** `readBoxFile` is a hard consumption edge. |
| A3 | **DF3.7's trigger** | "`fleet dispatch --await-completion` polls the in-box terminal marker" (`:184`) | `--await-completion` on `dispatch` or `run` is **out-of-scope**, and would "invert the ADR's own product claim (`:101-102`)"; the verb is `fleet observe <run-id>` (`:81`, `:78`) | **Story.** The yaml predates the operator's DF3.8 chartering, and its own DF3.8 line (`:185`) already calls the `--await-completion` shape the gap DF3.8 exists to close. Self-contradictory yaml. |
| A4 | **The import fence's scope** | "fails the suite if `run-completion.ts` ever imports approval-gate.ts, approvers.ts, push.ts **or run-record.ts**" (`:184`) | `run-record.ts` is **permitted** for `RunRecordStore`/`RunRecord`, and a whole-module ban "would forbid" AC5's pre-flight read (`:67`) | **Story.** The yaml's version makes AC5 unimplementable. |
| A5 | **Deviation status** | "CORRECTION OF RECORD, **carried as the story's Deviation 1**" (`:184`); DF3.8 "amending DF3.7's INV-IBOX-16 openly (sanctioned **second** automatic caller … recorded as its Deviation 1 counterpart)" (`:185`) | DF3.7 "carries **no** story-local deviations … the next reviewer who needs one starts at Deviation 1" (`:108`); DF3.8 sanctions **three** callers and "satisfies rather than amends" (`:82`, `:116`) | **Story**, and behind it the **ADR**: Appendix A (`:145-151`) explicitly removed the deviations from both stories precisely because "two stories carrying a standing deviation against the very ADR that unwinds a deviation is self-defeating". The yaml is the last place the retired deviations still live. |
| A6 | **`record-claim-refused` line cite** | "record-claim-refused (**reaper.ts:750-756**)" (`:185`) | DF3.7 `:69` repeats the same wrong cite; DF3.8 `:12` has the correct `:808` | **DF3.8's story text.** Actual arm: `:805-811`. Fix the yaml and DF3.7 together (V-DF3.7-M1). |

Recommendation: the yaml comments on `:184` and `:185` should be rewritten against the merged
story text rather than patched clause by clause — A3, A4 and A5 are all fossils of the pre-Appendix-A
draft, and leaving them is how the next reviewer re-derives a deviation the operator already retired.

---

## Where I believe a previous reviewer was wrong

1. **DF3.8's Deviation 1 corrected DF3.7's reaper prose in DF3.8's own file and never touched
   DF3.7.** DF3.8 `:116` states the correction "asks for" a one-clause edit to DF3.7's AC3 arm
   citation; that edit was never made, so DF3.7 `:69` still carries `:750-756` and still names the
   destroy-guarding arm. A correction recorded only in the *other* story is not a correction —
   it is the shape ADR `:19-23` names as how the original silent deviation happened. (V-DF3.7-M1.)
2. **The reviewer who wrote AC1's barrel clause asserted a re-export relationship without opening
   `src/fleet/index.ts`.** The barrel is 20 lines and does not export the gate. The ban survives on
   a different (correct) rationale, but the sentence is false and DF3.8 inherits it "verbatim".
   (V-CC-M1.)
3. **The reviewer who hardened AC5's `pausing` clause reasoned correctly about the gate's resume arm
   and never asked whether the chain can reach it.** `runner.ts:436-460` is quoted accurately; the
   conclusion drawn from it is unreachable because `pausing` is post-teardown. (V-DF3.7-B1.)
4. **AC4(b)'s "a box rebooted before the engine ever started has an active unit" was written without
   reading `unitActivity`'s `default` branch**, whose own comment names systemd's "unknown" for a
   never-loaded unit — and it contradicts the no-`[Install]` policy the same AC cites two clauses
   earlier. (V-CC-B1.)
5. **A previous pass got the `--await-completion` → `fleet observe` change right in both stories and
   left it wrong in the yaml**, which is now the only artifact describing a trigger surface both
   stories declare out-of-scope. (A3.)

## Unattended-autonomy claim (ADR `:101-102`)

**Delivered, bounded, and honestly bounded — with one gap.** DF3.8 `:34-40` states its own limits
without being asked to ("this story does not make the *host* unattended, it removes the requirement
that the host stay attached **for the duration of the run**"), and that is the correct reading of
`:101-102`, which is about runs surviving *host disconnect*, not about the host being absent. The
pair does deliver it: the engine runs in-box under systemd, the host may exit, and a later
invocation drives the chain. The gap is not in the claim but in V-CC-B1 and V-DF3.8-H2 — as
specified, the sweep terminally refuses dispatched-but-unstarted runs and silently starves on
engine-dead ones, so the *unattended* path is the one that breaks first while the attended
single-run path (where an operator knows they started the run) mostly works. That inverts the ADR's
priority and is why both are BLOCKER/HIGH rather than MEDIUM.
