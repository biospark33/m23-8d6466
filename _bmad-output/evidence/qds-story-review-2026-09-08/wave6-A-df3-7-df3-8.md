# Wave 6 — Round-3 independent verification: DF3.7 + DF3.8

**Verifier:** fresh-eyes round-3 agent (no prior-round reports read; tracker per-finding
tables not read).
**Branch:** `feature/qds-story-review-remaining-v5-stories` @ `c72064f6`.
**Scope:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-7-approval-gate-bridge.md`,
`…/df3-8-host-completion-watcher.md`. Read-only on both.

**Method note.** Every claim below comes from opening the file named. Citations are by
symbol or section anchor. Where a story shows arithmetic I re-derived it. Where I assert a
grep found nothing, the same command carried a positive control on the same file.

---

## What I checked and found CORRECT (recorded so the lead can see the denominator)

These are the load-bearing claims I tried hardest to break and could not:

- **The shared classifier is real and shared.** `readMarkerVerdict` /
  `classifyMarkerRead` / `markerUnusableGivesUp` / `boxMarkerPath` /
  `BOX_MARKER_PATH_RE` / `MARKER_UNUSABLE_TICKS_LIMIT` (=3) / `PROBE_SKIP_TICKS_LIMIT` (=6)
  / `DEFAULT_POLL_INTERVAL_MS` (5 s) / `DEFAULT_PER_CALL_DEADLINE_MS` (10 s) /
  `DEFAULT_FANOUT_CEILING_MS` (1 h) all exist in `src/fleet/fanout-primitive.ts` with the
  signatures and values DF3.7 AC2 states. `MarkerVerdict` is exactly
  `absent | skip | unusable | settled` — four **verdicts**, not `BoxFileRead`'s four
  **kinds**. `fleet status` (`status.ts`, `inBoxState`) and the race poller (`probeArm`)
  both call `readMarkerVerdict(driver, vm, boxMarkerPath(runId), deadlineMs, runId)`. The
  signature DF3.7 AC2 writes is the shipped one.
- **The `absent` vs `skip` split.** `classifyMarkerRead`'s first branch is literally
  `if (res.probeExit === undefined || res.probeExit === 1) return { kind: "absent" }`,
  everything else `skip`. DF3.7 AC2(a) is exact.
- **`unreadable` is `unusable`, not a skipped tick**, and the docblock does say logging it
  as an unanswered probe "asserts the opposite of what happened". Exact.
- **`marker-read-budget-exhausted`** (`exitCode: -1`, no `cat` issued) is `unusable`.
  Exact.
- **`expectedRunId`** → `marker-run-mismatch` / `marker-run-id-invalid`; a JSON `null` or
  primitive body → `unusable`. Exact.
- **The 90 s arithmetic.** `PROBE_SKIP_TICKS_LIMIT × (DEFAULT_POLL_INTERVAL_MS +
  DEFAULT_PER_CALL_DEADLINE_MS)` = 6 × 15 000 = 90 000 ms. Correct.
- **`unitActivity`** is at `src/fleet/run.ts`, signature `(driver, vm, runId, timeoutMs)`,
  and its `default` branch's own comment is "Includes `unknown` (systemd's own word for a
  unit it has never loaded)". `failed` really is the only unambiguous terminal reading, and
  the docblock really does say "the unit simply sits `failed` and no marker is ever
  written". **AC2(d) survives the round-2 failure class it was written against.**
- **Path grammar.** `boxMarkerPath(runId)` = `boxRunRoot(runId)/journal/final.json` =
  `/run/qds-run/<runId>/journal/final.json` (`harvest.ts`, `BOX_RUN_ROOT = "/run"`), and
  the unit declares `RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace` +
  `RuntimeDirectoryPreserve=yes`. Host mirror and box writer agree with the **substrate**,
  not merely with each other. `runMarkerPath` really is withheld from
  `src/phase-engine/index.ts` (the barrel says so in a comment). AC4 is sound.
- **`scripts/pipeline-run.ts` contains `approval` zero times** — self-proving grep:
  `grep -c approval` = 0 with positive control `grep -c phase` = 227 over the same
  187 KB file.
- **`awaitDecision` has no production caller** — defined at `approval-gate.ts:2115`,
  referenced only inside that module's prose and in `tests/fleet/approval-gate.test.ts`.
- **DF3.8's Deviation 1 is CORRECT and I re-derived it.** `record-claim-refused` sits
  inside the **destroy** branch (`reaper.ts` ~`:805-811`). The three `stale-record` →
  **`teardown`** sites are at the `action:` lines `:537` (VM), `:580` (key), `:593`
  (record) — the story's inner cites point at the `action:` line, which is the
  load-bearing one, not the `class:` line one above it. I initially scored these as
  off-by-one and was wrong. `staleAfterMs` = `14_400_000` at `quota.ts:49`.
  `teardownSandbox(teardownDeps, unit.id)` at `:726`, no opts.
  `scripts/sandbox-reap.ts:7-9` is dry-run-unless-`--yes`. All exact.
- **`src/providers/reaper.ts` has zero lock references** — proven with a positive control
  (the same grep matched `teardownSandbox`, `staleAfterMs`, `aged` in the same file).
- **DF3.8 AC4(a)'s ordering premise.** `within("create", …)` wraps the whole of
  `provisionAdmittedRun` — `store.create`, the budget `store.set` **and** `driver.create`
  — per `dispatch.ts`'s own comment. So `createdAt` genuinely predates first boot and the
  naive comparison genuinely is inverted. The story's decision to cite this **by symbol
  rather than by line** because "that region also carries EEXIST/`run-id-in-use` handling
  and a line cite there rots" is verified true: `:2721-2790` is exactly that.
- **`src/fleet/index.ts` reaches `approval-gate.ts`.** The barrel star-exports 8 modules
  over `:8-20` (brief-schema, dispatch, status, verbs, fanout, fanout-primitive, rank,
  resident), and `status.ts:54` imports `expiredState` from `./approval-gate.ts`. DF3.7
  AC1's barrel clause is exactly right, and the fence-on-direct-specifiers-only rule is
  the right one: `run-completion.ts` → `reverify()` → `src/reverify/approval.ts:26` →
  `../fleet/approval-gate.ts` is the design.
- Verified minor cites: `approval-gate.ts:8-17` (`pausing` → teardown → promote),
  `:1124-1137` (`teardown_at_pause_ms` absent, not zero), `runner.ts:217/218/421/430/461`,
  `worktree.ts:293-299` (F064), `run-lock.ts:931-932` (the embedder note),
  `scripts/fleet.ts:4257` (inside `runDestructive`), `scripts/fleet.ts:1966-1985`
  ("must NOT abort the mint"), `scripts/sandbox-teardown.ts:230`,
  `dispatch.ts:2667` (`stampCorrelation`), `verbs.ts:73-74/86-90/117-124`,
  `transport.ts:128-138/140`, `qds-run@.service:58/158/160/169/277-289`. All good.
- **`scripts/lib/run-lock.ts` contains 2 NUL bytes on this branch** (`file` reports
  `data`; `grep -c export` returns **0**, which is the trap the brief named). Everything I
  assert about that file was read through Python, not grep. PR #238 still open.

---

## Findings

### W6-A-H1 — DF3.8 AC3's `markerWitnessed: true` branch is unreachable, and its DoD demands a test the AC's own negative control forbids

- **Severity:** HIGH · **Category:** `C3-structural`
- **Story/anchor:** DF3.8 § Acceptance Criteria AC3; § Definition of Done "Test (reaper
  interplay, AC3)"; DF3.7 § Files to Modify (`ChainOutcome.markerWitnessed`).
- **What the story says.** AC3: "there is exactly **one** point at which that can be
  observed: the record re-read **inside** the run lock (AC2b)… It is re-entered at the
  `reverify()` leg **only if this invocation had already witnessed the marker itself**
  before the collection, and is otherwise refused with a typed `completion-unwitnessed`
  payload."
- **Failure scenario.** Trace the specified order for one candidate: AC2(a) enumerates
  (record read + `driver.list`, **no marker read**) → AC2(b) `acquireRunLock` → AC2(b)
  "DF3.7 AC5's … refusal is evaluated **after** acquisition" → the `closedAt` re-read →
  only then `observeAndDriveChain(runId, {…, maxTicks: 1})`, which is where the single
  marker read lives. At the one specified observation point the invocation has **never**
  read the marker, so `markerWitnessed` is `false` by construction on every candidate.
  The `re-enter at the reverify() leg` arm therefore never fires, and
  `completion-unwitnessed` fires on 100 % of collected candidates. Post-DF2.11 it gets
  strictly worse, and the story says so itself: "the window narrows to *collected before we
  acquired the lock*" — which makes `markerWitnessed: true` provably impossible.
- **The trap.** DF3.8's DoD requires "a marker witnessed in this invocation re-enters at
  the `reverify()` leg without a second teardown", while AC3's own third negative control
  says an implementation "whose test for this arm hand-constructs a state its own
  enumeration can never reach … asserts nothing about the code path that fires in
  production" MUST fail. The only way to test the DoD item is the thing the AC forbids.
  A dev satisfies both only by inventing a second, unspecified `closedAt` re-read after
  the marker read.
- **Evidence.** DF3.8 AC2(a), AC2(b), AC3 read together; DF3.7 § Files to Modify's
  `ChainOutcome` union, whose `markerWitnessed` field DF3.7 says "is what DF3.8 AC3's
  `completion-unwitnessed` arm turns on" — a contract field with no producer of `true`.
  This is a **writer↔reader contract defect across the pair**, not a wording slip.
- **Fix direction.** Either (a) specify a **second** `closedAt` check between the chain's
  marker witness and its teardown leg — which is a real behavioural addition and belongs in
  DF3.7's `observeAndDriveChain`, not in the sweep — or (b) delete the two-branch structure:
  a collected record is always `completion-unwitnessed`, `ChainOutcome.markerWitnessed`
  is dropped from DF3.7, and the DoD item goes with it. (b) is smaller and matches what the
  code can actually observe.

### W6-A-H2 — DF3.8's entire "until DF2.11 lands" residue is dead on arrival under its own declared dependency graph

- **Severity:** HIGH · **Category:** `C3-structural`
- **Story/anchor:** DF3.8 § Dependency edges ("Not a predecessor … DF2.11"), AC2(e), AC3,
  AC6/DoD (`--help` warning "marked temporary, pending DF2.11"), INV-IBOX-18; DF3.7
  § Dependency edges and § Files to Modify (the `deps.runLock` ordering hedge);
  `sprint-status.yaml` DF3.7 row.
- **Failure scenario.** `sprint-status.yaml` records `DF3.7 deps: [DF1.10, DF2.2, DF2.10,
  **DF2.11**, DF3.1, DF3.4, DF5.1]` and `DF3.8 deps: [DF1.10, DF2.2, DF2.6, DF3.1,
  **DF3.7**]`. So DF2.11 ≺ DF3.7 ≺ DF3.8 **transitively and strictly**. By the time DF3.8
  enters development, `teardownSandbox` already takes a required `RunLockHandle` and
  `src/providers/reaper.ts` has already been changed by DF2.11 to acquire one. Every one of
  the following is then false at merge:
  - AC2(e)'s premise "`sandbox-reap --yes` … takes **no** run lock … A mutex cannot exclude
    a process that never looks at it";
  - AC2(e)'s three owed items, including a `--help` line the story ships **already
    obsolete**, telling operators not to reap while a sweep is in flight for a race
    DF2.11 has structurally closed;
  - AC3's "Once DF2.11 lands, the window narrows…" (it has already landed);
  - INV-IBOX-18's stated cost ("because the reaper calls `teardownSandbox` directly with no
    run lock (`:726`)").
  Meanwhile **nobody owns removing the temporary `--help` line** — DF2.11's story does not,
  DF3.8's Trigger Surface has no Follow-Up row for it, and DF3.7 does not. It is a
  permanently-false operator instruction. That is the campaign's named **orphaned-work**
  class arriving through a sequencing door.
- **The stories also disagree with each other.** DF3.8 says DF2.11 is "**Not** a
  predecessor … the sweep ships and is correct without it". DF3.7 lists DF2.11 as a hard
  predecessor edge and then *hedges it back* ("if DF2.11 has not merged when this story
  starts, the parameter is added anyway typed `string`"). The yaml carries no hedge. Three
  artifacts, three different edge strengths.
- **Fix direction.** Pick one. Either make DF2.11 a stated hard predecessor (delete DF3.7's
  hedge, delete DF3.8's AC2(e) residue, the temporary `--help` line and AC3's "once DF2.11
  lands" clause, and rewrite INV-IBOX-18's cost paragraph as "closed by DF2.11"), or make it
  soft in the yaml too and give the `--help` removal an owner and a Follow-Up row. Do not
  ship three readings.

### W6-A-M1 — a listable-but-unreachable box is a third permanently-non-progressing candidate the sweep neither bounds nor reports

- **Severity:** MEDIUM · **Category:** `C3-structural`
- **Story/anchor:** DF3.8 § Technical Notes "Guards/limits" ("The substrate produces **two**
  permanently-refusing cases"); AC2(a); AC6; § Observability Contract.
- **Failure scenario.** A box whose control plane still lists it `running` but whose sshd is
  dead / network-partitioned. AC2(a) admits it as a candidate every pass ("open record, live
  and **listable**"). Its one `maxTicks: 1` marker read returns `skip`
  (`classifyMarkerRead`: `probeExit === 255` → `skip`). DF3.7's `box-unreachable` refusal is
  terminal only "after **six** consecutive skips **and** at least 90 s since the last tick
  that reached the box" — with one tick per invocation and **nothing persisted** (DF3.8
  § Technical Notes "Contracts/Schema": "this story persists **nothing**"), the streak
  cannot ever reach 6. So the candidate resolves to `ChainOutcome{kind:"unsettled"}` and is
  counted in **`runs_unsettled`** — the same bucket as a perfectly healthy run still walking
  its phases. It sits at the head of the oldest-`createdAt`-first queue forever, costs two
  reads a tick, emits nothing actionable, and eventually ends at the reaper's witness-less
  collection: the exact outcome DF3.8 says it exists to end.
- **Evidence.** `classifyMarkerRead`'s `probeExit` branch; DF3.7 AC2(a)'s terminal
  condition; DF3.8 AC2(b) (`maxTicks: 1`) and Technical Notes (nothing persisted); the
  `sweep-complete` counter list, which has no `box_unreachable`.
- **Also:** DF3.8 AC6 lists `box-unreachable` among the per-run refusals that are "counted
  and reported on its own line", but it cannot occur at `maxTicks: 1` and has no counter.
  The story's own completeness claim — "The substrate produces **two** permanently-refusing
  cases" — is false; there are three.
- **Fix direction.** Give the sweep a one-tick unreachability disposition of its own: on a
  `skip` verdict, count it in a distinct `runs_box_unreachable` (not `runs_unsettled`),
  emit the typed `box-unreachable` line once per pass, and say plainly that it is
  **reported, not retired** (same posture as AC4(b)'s reboot arm, and for the same reason —
  a transport blip is not a death certificate). Then correct the "two cases" sentence.

### W6-A-M2 — DF3.7 AC5's "post-teardown by construction" rests on the wrong guard, and the case it excludes is one the story elsewhere admits is reachable

- **Severity:** MEDIUM · **Category:** `C2-semantic`
- **Story/anchor:** DF3.7 AC5 ("A `pausing` record is **post-teardown by construction** …
  `refuseLiveInfraOnDecidable`, `src/fleet/approval-gate.ts:1112-1123`, **refuses to
  promote** a record that 'is open and still names' a box or key").
- **What the code does.** `refuseLiveInfraOnDecidable` is called at exactly two sites —
  the **rebind** arm (`approval-gate.ts:1421`) and the **decide** arm (`:1986`). It is
  **never** called on the promote tail. Its own docblock says so: "INV-APPROVE-6 on EVERY
  route to the decidable window, **not only the promote tail** … **Unlike the promote
  tail**, this guard takes NO `teardown === undefined` condition." The promote-tail
  enforcement is a different guard (`approval-gate.ts:1568-1579`, "INV-APPROVE-6, ENFORCED
  rather than asserted"), and — unlike the one AC5 names — it *does* carry the
  `teardown === undefined` condition.
- **Failure scenario.** An operator hand-runs `scripts/reverify.ts` against a run whose box
  is still alive. DF3.7's own AC5 admits this caller is unfenced ("no lock covers that
  today, this story takes none"). `requestApproval` registers `pausing` **before** any
  teardown (`approval-gate.ts:8-17`), so the record is now `pausing` with a **live box** —
  the exact state AC5 says cannot exist. `fleet observe <run-id>` then takes AC5's
  `promoteStrandedPause` path, skips the observe and teardown legs "entirely", and calls
  `reverify()`. `reverify()`'s promote tail refuses (open record names `vmName`);
  `reverify()` catches it, flags `approval-request-failed`, and returns
  `{report, approval: null}` (`runner.ts`'s catch arm). The observer reports the chain as
  having run while the record is still `pausing`, the box is still alive and billing, and
  **`ChainOutcome` has no arm for "the chain ran and the gate refused"** — `driven` means
  the chain landed, `refused` means we refused before it.
- **Fix direction.** (1) Replace the guard name with the promote-tail site and drop "by
  construction": say `pausing` is post-teardown **on every path this story or DF3.8
  drives**, and that the hand-run path can leave a live-box `pausing`. (2) Add a
  `ChainOutcome` arm (or reuse `refused`) for a `reverify()` that returned
  `approval: null`, so the observer can print a typed `gate-refused-live-infra` payload
  naming `fleet teardown <runId>` instead of reporting a pause that did not happen.

### W6-A-M3 — "the marker's bytes are never echoed" is contradicted by the shared classifier both stories consume

- **Severity:** MEDIUM · **Category:** `C2-semantic`
- **Story/anchor:** DF3.7 § Observability Contract ("The marker's bytes are never echoed
  and no credential material is read or logged"); DF3.8 § Observability Contract (same
  sentence); DF3.7 INV-IBOX-15.
- **Failure scenario.** DF3.7's own event vocabulary requires `marker-unusable` and
  `marker-skip` lines. The only thing that distinguishes them is `MarkerVerdict.error`,
  and the shipped `classifyMarkerRead` builds those errors **out of the marker's bytes**:
  `marker-run-mismatch` → `` `final.json on this box names run ${JSON.stringify(marker.runId)}` ``;
  `marker-run-id-invalid` → `` `runId=${JSON.stringify(marker.runId)}` ``;
  `marker-unreadable` → `` `final.json carries ok=${JSON.stringify(marker.ok)}` `` and the
  raw `JSON.parse` exception, whose message embeds a content excerpt. A dev who honours the
  invariant literally logs `{event:"marker-unusable"}` with no `code` and no cause and the
  operator has nothing; a dev who logs the cause violates a stated security invariant.
- **The repo already answers this.** `probeArm` logs exactly these through
  `errText(...)` → `redactSecrets` (`fanout-primitive.ts`), and `run.ts`'s `boxText`
  fixes the redact-then-cap order for foreign text for the same reason.
- **Fix direction.** Restate as: the verdict's `code` and its `error` **redacted through
  `redactSecrets` and capped**, in the `probeArm`/`boxText` idiom; never the raw
  `res.content`. That is both truthful and stronger than the absolute sentence.

### W6-A-M4 — DF3.8 AC4's reboot inequality is dimensionally inconsistent, and so is the evidence field the revisit threshold is re-derived from

- **Severity:** MEDIUM · **Category:** `C3-structural`
- **Story/anchor:** DF3.8 AC4(a) and AC4(b); § Technical Notes "`/proc/uptime` is a file";
  DoD "Test (reboot measurement, AC4)".
- **Derived myself.** The story writes the test as
  `uptimeSeconds < (hostNow − createdAt) − PROVISION_LAG_MARGIN_MS`, three times (AC4a,
  AC4b, and the negative-control list). `hostNow − createdAt` is **milliseconds**;
  `PROVISION_LAG_MARGIN_MS` is milliseconds by its own name; `uptimeSeconds` is
  **seconds** by its own name and by `/proc/uptime`'s format. Taken literally, a healthy
  box up 3 600 s against a run 3 600 000 ms old satisfies the inequality by three orders of
  magnitude — i.e. **every box counts as rebooted**, which is precisely the inversion AC4(a)
  opens by saying it is fixing. The same mixing appears in the artifact spec: "the evidence
  JSON carries … the derived `(hostNow − createdAt) − uptimeSeconds`" — a ms minus a
  second. That derived value is the one thing AC4(c)'s revisit threshold is supposed to be
  re-argued from ("so the margin can be re-derived from data rather than re-argued"), so
  the mis-scaling propagates into the arc-retro decision, not just into one comparison.
- **Why it is not merely pedantic.** The DoD's positive case ("a never-rebooted box …
  counts **zero**") would catch a literal implementation, but nothing in the DoD covers the
  units of the persisted `(hostNow − createdAt) − uptimeSeconds` field, and AC4(c)'s
  threshold (2 distinct runs, or 2 %) is evaluated off the accumulated evidence set by a
  human at the retro.
- **Fix direction.** Write the comparison once, in one unit, and name it:
  `uptimeMs = Math.round(uptimeSeconds * 1000)`; reboot iff
  `uptimeMs < (hostNow − createdAt) − PROVISION_LAG_MARGIN_MS`; evidence field
  `provisionLagMs = (hostNow − createdAt) − uptimeMs`, alongside the raw `uptimeSeconds`
  as read.

### W6-A-M5 — DF3.7's single-run verb must take the run lock, and no AC, DoD item, Files-to-Modify entry or test in DF3.7 says so

- **Severity:** MEDIUM · **Category:** `C3-structural`
- **Story/anchor:** DF3.7 § Files to Modify (`run-completion.ts` parenthetical, and the
  `scripts/fleet.ts` entry); INV-IBOX-16; § Definition of Done.
- **Failure scenario.** DF3.7's normative statements are: `run-completion.ts` "acquires
  **no** lock", `deps.runLock` "is the caller's `RunLockHandle` (DF2.11), passed to
  `teardownSandbox` unchanged", and INV-IBOX-16's "The lock lives in the caller, never in
  this module". But the acquisition itself appears in **no AC**, is absent from the
  `scripts/fleet.ts` Files-to-Modify description ("adds only the `observe` block, the
  observer wiring and the typed refusal prints"), and has **no DoD checkbox and no test** —
  DF3.7's DoD only says the module "acquires **no** lock". A dev implementing DF3.7 to its
  DoD ships a verb that acquires nothing, has no `RunLockHandle` to put in `deps.runLock`,
  and (post-DF2.11) cannot compile the `teardownSandbox` call. The only test that would
  catch it is in **DF3.8's** DoD ("DF3.7's single-run `fleet observe <run-id>` still
  completes its chain while holding **its own** lock") — one story later. This is the
  campaign's orphan shape in its purest form: described by two stories, owned by neither's
  acceptance surface.
- **Related, same root:** DF3.7's declared exit table annotates 5 as
  "`run-engine-dead`, `approval-already-registered`, and **DF3.8's** run-lock refusal",
  attributing to DF3.8 a refusal DF3.7's own verb produces.
- **Fix direction.** Add to DF3.7 AC5 (or a new clause) that `fleet observe <run-id>`
  acquires `<runsDir>/<runId>.lock` via `acquireRunLock` **before** the pre-flight record
  read and passes the handle as `deps.runLock`; add the matching DoD item and one test;
  re-label exit 5's run-lock arm as this verb's, inherited by `--all`.

### W6-A-M6 — DF3.8 AC2(c)'s F106 failure scenario cannot happen, and the lock is not what preserves F106's precondition

- **Severity:** MEDIUM · **Category:** `C2-semantic`
- **Story/anchor:** DF3.8 AC2(c) negative controls; DF3.8 INV-IBOX-17; DF3.7 AC5 and
  INV-IBOX-16 (same claim).
- **What the story says.** "…an implementation that checks the extension before acquiring
  the lock lets **two overlapping cron ticks** both enter `reverify()` on the same run,
  turning `src/reverify/worktree.ts:319`'s pid guard (TECH_DEBT F106) **from latent to
  live**."
- **What the code does.** `withGuards` computes
  `const preexisting = new Set(descendants(processTableSync(), process.pid))` and
  `ours = (table) => descendants(table, process.pid).filter(pid => !preexisting.has(pid))`
  (`src/reverify/worktree.ts`). Both walk the ppid tree **from this process's own pid**.
  Two overlapping cron ticks are two **sibling** OS processes; neither's children are
  descendants of the other, so process A's guard can neither charge nor SIGKILL process B's
  children. `TECH_DEBT_AUDIT.md`'s F106 row states this explicitly: "Two concurrent
  `reverify()` calls **in one host process**… Currently unreachable — `reverify()`'s only
  production entry is `scripts/reverify.ts`, **one process per invocation**."
- **Consequence.** The per-run lock file — a cross-process mutex — is orthogonal to F106.
  What actually keeps F106 latent for this arc is AC2(a)'s **seriality inside the sweep
  process** (one candidate at a time), which the story states elsewhere and never connects
  to the invariant. Both stories therefore justify their central serialization invariant
  with a hazard the mutex does not address, and leave the property that *does* hold
  (seriality) unasserted as the F106 argument.
- **The real hazards of two overlapping ticks are still real and better ones:** two
  `teardownSandbox` calls on one box (DF2.11's data-loss case), two harvests into one
  `<runsDir>/<runId>.bundle`, two report appends, two `requestApproval` calls. Those the
  lock genuinely prevents.
- **Fix direction.** In both stories, re-point the F106 sentence: the lock prevents
  concurrent chains on one run (double teardown / double harvest / double approval
  request); F106's one-process-per-invocation precondition is preserved by AC2(a)'s
  **serial** pass, and any future concurrent-within-one-process caller re-opens F106
  regardless of the lock.

### W6-A-M7 — `sprint-status.yaml`'s DF3.7 and DF3.8 rows disagree with the merged story text in four places

- **Severity:** MEDIUM · **Category:** `C1-citation`
- **Story/anchor:** `_bmad-output/sprint-artifacts/sprint-status.yaml` rows `DF3.7:` and
  `DF3.8:`.
- **Header/points/tag/deps all match** (DF3.7 4 pts v5-S3 `deps: [DF1.10, DF2.2, DF2.10,
  DF2.11, DF3.1, DF3.4, DF5.1]`; DF3.8 4 pts v5-S3 `deps: [DF1.10, DF2.2, DF2.6, DF3.1,
  DF3.7]`). The **prose** does not:
  1. DF3.7's row still specifies **`fleet dispatch --await-completion`** as the delivered
     trigger. The story ships `fleet observe <run-id>` and puts `--await-completion`
     explicitly **out of scope** in its Trigger Surface. DF3.8's row already records the
     removal — so the yaml contradicts itself across two adjacent rows.
  2. DF3.7's row says the fence "fails the suite if `src/fleet/run-completion.ts` ever
     imports … **or `run-record.ts`**". AC1 now *permits* `run-record.ts` for
     `RunRecordStore`/`RunRecord` (AC5's pre-flight read needs it) and adds the **barrel**
     to the ban. The row's version would fail the correct implementation.
  3. DF3.7's row says "fan-out's **four-kind** classification"; the story's AC2 is emphatic
     that the four things are **verdicts**, "which are *not* `readBoxFile`'s four kinds".
  4. DF3.8's row cites `record-claim-refused (reaper.ts:750-756)` — the arm is at
     `:805-811` — and says this story "amend[s] DF3.7's INV-IBOX-16 openly … recorded as
     its Deviation 1 counterpart", while DF3.8 AC5 now says "this story is a **sanctioned
     caller, not an amendment** … no clause in DF3.7 is left to amend" and DF3.7 carries
     **no** deviations ("the next reviewer who needs one starts at Deviation 1").
- **Failure scenario.** The yaml row is what a fresh dev-agent reads first in
  `bmad-dev-story`. On row 1 they build a flag both stories forbid; on row 2 they write a
  fence that fails AC5's own implementation.
- **Fix direction.** Rewrite both rows' prose against the merged story text. Parent owns
  the edit.

### W6-A-L1 — DF3.7's "`completedAt` is optional on the wire" cites the wrong artifact and the shipped type contradicts it

- **Severity:** LOW · **Category:** `C1-citation`
- **Story/anchor:** DF3.7 § Technical Notes "Contracts/Schema".
- The story argues optionality from "`JournalFile.completedAt` is optional and
  `JSON.stringify` drops an `undefined` value (`src/phase-engine/journal.ts:309,381`)".
  `journal.ts:309` is `FileJournal.flush`'s conditional spread for the **journal file** at
  `$HOME` — a different artifact from the marker. The marker is written by
  `writeTerminalMarker` from a `RunOutcome`, and `RunOutcome` is
  `{ ok: boolean; completedAt: string }` — **required** (`src/phase-engine/types.ts:298-301`)
  — fed by `FileJournal.finish`, which always assigns `this.completedAt = new
  Date().toISOString()`. So the only production writer **always** emits three fields.
- **Why it still doesn't change the AC.** The operative instruction — decide on `ok` alone,
  never require `completedAt`, because the shipped classifier reads only `runId` and `ok` —
  is correct and is the right instruction regardless. Only the justification is false.
- **Fix direction.** Re-argue it from `classifyMarkerRead` (which reads exactly `runId` and
  `ok`) rather than from `JournalFile`, and note that the shipped writer always emits three
  fields so `completedAt?` is tolerance, not an expected shape.

### W6-A-L2 — DF3.8 cites the non-re-entrancy guard one line off, and disagrees with DF3.7's cite of the same line

- **Severity:** LOW · **Category:** `C1-citation`
- **Story/anchor:** DF3.8 AC2(b) ("`RunLockReentrantError`, `scripts/lib/run-lock.ts:66-79`,
  guard at `:952`") vs DF3.7 § Files to Modify / INV-IBOX-16 (`run-lock.ts:951`).
- Read through Python (grep is blind on this file — see the NUL note): the guard is
  `if (moduleState().held.has(lock)) throw new RunLockReentrantError(lock);` at **`:951`**.
  The class is declared at `:72` with its docblock opening at `:65-67`, so `:66-79` is
  serviceable; `:952` is one past the guard. Two stories, one line, two numbers.
- **Fix direction.** `:951` in both. (And note in the tracker that `scripts/lib/run-lock.ts`
  cannot be verified with `grep` until PR #238 merges.)

### W6-A-L3 — DF3.7 AC4's "no `QDS_*` path variable" is over-broad against the shipped unit

- **Severity:** LOW · **Category:** `C4-marginal`
- **Story/anchor:** DF3.7 AC4 ("DF2.10 AC6 ships an image and unit that set **no `QDS_*`
  path variable** (cited, not assumed)"); § Technical Notes (same).
- `oci/exedev/systemd/qds-run@.service` sets **two** `QDS_*` variables —
  `Environment=QDS_PI_CATALOG_DIR=/usr/local/share/qds/pi-catalog` (which is a path) and
  `Environment=QDS_TEAM_RUNNER=local` — and its own comment records that "DF2.10's AC6 had
  to be **NARROWED** to admit them", allow-listing exactly those two by name while
  `QDS_RUN_ROOT` and `QDS_STEERING_ROOT` stay forbidden and scan-enforced. AC4's operative
  property (`QDS_RUN_ROOT` unset in-box) is **true and enforced**; the sentence as written
  is not, and a dev writing the AC4 assertion literally would fail it against the shipped
  unit.
- **Fix direction.** "…sets no `QDS_RUN_ROOT` or `QDS_STEERING_ROOT`; the AC6 build scan
  allow-lists exactly `QDS_PI_CATALOG_DIR` and `QDS_TEAM_RUNNER` by name and fails on a
  third."

### W6-A-L4 — DF3.8's `sweep-complete` accounting identity double-counts

- **Severity:** LOW · **Category:** `C4-marginal`
- **Story/anchor:** DF3.8 § Observability Contract ("…which together account for
  `candidates_enumerated` minus any partial-pass remainder").
- The enumerated list mixes **disposition** buckets (`runs_observed`, `runs_unsettled`,
  `runs_engine_dead`, `runs_lost_to_reboot`, `lock_refused`, `completion_unwitnessed`) with
  **orthogonal measurements** (`box_reboot_after_dispatch`, `uptime_unknown`), which are
  properties a candidate carries *in addition to* its disposition. Summing all nine
  over-counts. `candidate-skipped` is an event with no counter, and (per W6-A-M1)
  `box-unreachable` has neither.
- **Fix direction.** State the identity over the disposition set only, name
  `box_reboot_after_dispatch` / `uptime_unknown` as measurements that cut across it (the
  story already does this for `runs_lost_to_reboot ⊂ box_reboot_after_dispatch`), and give
  `candidate-skipped` a counter or drop the event.

### W6-A-L5 — AC1's fence and AC5's refusal leave the approval-state vocabulary unsourced

- **Severity:** LOW · **Category:** `C4-marginal`
- **Story/anchor:** DF3.7 AC1 (fence) vs AC5 ("`awaiting-approval` **or terminal**").
- To decide "terminal", the implementer needs the state vocabulary. The one shared expiry
  rule is `expiredState`, which lives **inside** a fenced module (`approval-gate.ts`), and
  the barrel is fenced too — so both obvious reaches fail AC1. The unfenced source exists
  and is never named: `ApprovalState = "pausing" | "awaiting-approval" | "approved" |
  "rejected" | "timed-out"` in `src/reverify/approval.ts`, which `run-completion.ts` must
  import anyway to reach `reverify()`'s neighbourhood. Not applying `expiredState` is
  harmless here (an expired `awaiting-approval` and a `timed-out` both refuse), but the
  story should say so rather than leave a dev to discover it by failing the fence.
- **Fix direction.** Name `ApprovalState` from `src/reverify/approval.ts` in AC5, and add
  one sentence that `expiredState` is deliberately not applied because both readings refuse.

### W6-A-L6 — DF3.8 attributes the in-box boot/uptime anchor to DF1.11; it ships today

- **Severity:** LOW · **Category:** `C1-citation`
- **Story/anchor:** DF3.8 § Technical Notes "`/proc/uptime` is a file" ("DF1.11's
  per-engine-start `boot_id`/uptime row corroborates the same fact from inside the box and
  is cited, not required").
- The row exists **now**, in `scripts/pipeline-run.ts`: it reads
  `/proc/sys/kernel/random/boot_id` and `/proc/uptime` and emits
  `{event:"engine_boot_anchor", runId, requestId, boot_id, uptime_s}` into the engine log
  (pinned by `tests/phase-engine/pipeline-run.test.ts`). DF1.10 relocates that writer
  in-box; DF1.11 does not introduce it. The story's *substance* — corroboration only, and
  the sweep must work on a box whose engine never started, and the anchor is only visible
  after harvest — is correct and unaffected.
- **Fix direction.** Cite `scripts/pipeline-run.ts`'s `engine_boot_anchor` by symbol and
  note it moves in-box with DF1.10.

---

## Contract-integrity sweep (writer ↔ reader), explicit result

Checked **against the substrate**, not against the sibling story:

| Surface | DF3.7 (writer/owner) | DF3.8 (reader/caller) | Substrate | Verdict |
|---|---|---|---|---|
| marker path | `boxMarkerPath(runId)` | same, restated once | `boxRunRoot` + unit `RuntimeDirectory=qds-run/%i/journal` | **agree** |
| marker payload | `{runId, ok, completedAt?}` | identical | `writeTerminalMarker` emits 3 fields; `RunOutcome.completedAt` required | agree in effect; see **L1** |
| verdict vocabulary | `absent\|skip\|unusable\|settled` | consumed, not restated | `MarkerVerdict` | **agree** |
| liveness | only `failed` terminal | identical, restated once | `unitActivity`'s `default` covers `unknown` | **agree** |
| exit table | `[0,1,2,4,5,6]`, declared once | cited, `--all` mints none | `verbs.ts` registry is a DF3.5 contract | agree; see **M5** on the 5-arm attribution |
| lock ownership | caller, never in module | caller = `observe.ts` | `acquireRunLock` non-re-entrant at `:951` | agree; see **M5**, **M6**, **L2** |
| `deps` shape | `{driver, store, runsDir, hostRoot, runLock, maxTicks?, windowMs?}` | passes `runLock` + `maxTicks:1` | — | **agree** |
| `ChainOutcome.markerWitnessed` | "what DF3.8 AC3's arm turns on" | AC3's re-entry branch | — | **DISAGREE — W6-A-H1** |
| time domains | window ms; poll ms; deadline ms | `PROVISION_LAG_MARGIN_MS` vs `uptimeSeconds` | `/proc/uptime` is seconds | **DISAGREE — W6-A-M4** |
| DF2.11 sequencing | hard edge, then hedged | "not a predecessor" | yaml: hard, transitive | **DISAGREE — W6-A-H2** |

**Orphaned work found:** two. (1) DF3.8's temporary `sandbox-reap --yes` `--help` warning
has no removal owner (W6-A-H2). (2) DF3.8's Technical Notes state that
`scripts/lib/run-lock.ts:931-932`'s ponytail note "**is retired** rather than left standing
false" — an edit to `scripts/lib/run-lock.ts`, which appears in **neither** story's Files to
Modify and in **neither** DoD. Folded into W6-A-H2's fix direction; call it out separately
if the parent prefers a distinct id.

**Security invariants:** clean. Neither story touches credential mint, delivery or
redaction chokepoints; neither introduces a second key or a push credential in-box; the
marker payload carries no credential material and no artifact in either story can carry
`sk-or-`. `approval-gate.ts` / `approvers.ts` / `push.ts` stay read-only, the fence is on
direct specifiers and permits the `ApprovalPort` transitive path (which I confirmed is the
real edge: `runner.ts` → `approval.ts:26` → `approval-gate.ts`), and INV-APPROVE-6 is
inherited untouched. The single security-adjacent defect is **W6-A-M3**, an over-absolute
redaction sentence, not a leak.

**ADR conformance:** no BLOCKER. Appendix A is honoured literally by both stories — the
marker is a completion signal, no `extensions.approval` is written by either module, and
`requestApproval`'s sole production caller remains `runner.ts:461`. Appendix B is out of
scope for this pair and neither story reaches for it. No drift-rule conflict found: where
shipped code and story disagree (M2, L1, L3) the shipped code is right and the story is
what needs the edit, never the ADR.

---

## Convergence verdict

**DF3.7 — CONVERGED, with two edits.** Its findings are dominated by C1/C4 plus two
substantive items (**M2**, **M5**) that are one-clause and one-AC edits respectively, not
re-thinks. Every semantic claim I attacked hardest — the shared classifier, the four
verdicts, `absent` vs `skip`, `unreadable` as corruption, `expectedRunId`, the liveness
arm's `inactive`/`unknown` non-terminality, the `boxMarkerPath` derivation, the 90 s
arithmetic — is **correct against shipped code on a real run**. The round-2 failure class
(right citation, false semantics) does not survive in DF3.7's AC2 or AC4. Dev can start on
DF3.7 once M5 gives the lock acquisition an AC and M2's guard name is corrected.

**DF3.8 — NOT CONVERGED.** It carries a live C3 population, and the two HIGHs are not
patchable in place:
- **H1** is a dead AC branch whose DoD test is forbidden by the AC's own negative control.
  Fixing it requires deciding whether `observeAndDriveChain` gains a second `closedAt`
  check (a DF3.7 behavioural change) or the branch and DF3.7's `markerWitnessed` field are
  both deleted. That is a design decision, not a patch.
- **H2** invalidates AC2(e) wholesale, plus clauses in AC3, AC6, the DoD and INV-IBOX-18,
  and ships an operator-facing `--help` line that is false on the day it merges.
- **M1** shows the story's own completeness argument ("two permanently-refusing cases") is
  wrong, which means the sweep's bounding story needs re-deriving, not re-wording.

Roughly a third of DF3.8's acceptance surface — AC2(e), AC3's two-branch structure, AC4(a)'s
arithmetic, the Technical Notes' "two cases" bounding argument — needs rethinking. A fourth
patch round that only edits prose will produce a story that still has a dead AC and an
obsolete `--help` string.

**Confidence: high on DF3.8's non-convergence; moderate-high on DF3.7's convergence.**
I read every seam either story names in the shipped repo rather than trusting the story's
description of it, and I re-derived both numeric derivations myself. I was wrong once in
this pass (I scored the reaper's three `stale-record` cites as off-by-one before opening
the lines and finding they point at the `action:` line deliberately), which is the reason I
list the verified-correct set above at length: the true category distribution matters more
than the count, and DF3.7's is genuinely good. The residual uncertainty on DF3.7 is that I
could not execute the suite against unwritten modules — every DF3.7 finding is a
spec-level judgement about implementability, not an observed test failure.

**Category distribution:** C1 ×4 · C2 ×3 · C3 ×5 · C4 ×3. The C3 mass sits almost entirely
in DF3.8.
