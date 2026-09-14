# Wave 8 — Round-3 convergence verification, DF3.7 + DF3.8 (verifier A)

Scope: exactly `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-7-approval-gate-bridge.md` and
`df3-8-host-completion-watcher.md`, read fully, every named symbol/path/flag/constant/exit-code/table
column opened and verified at source in this working tree (branch
`feature/wave7-seam-ownership-rework`, HEAD `581539a4`, stories uncommitted on top). No prior campaign
report, tracker, wave evidence or seam-ownership table was opened. Read-only: nothing modified.

Method notes: every "grep returns zero" claim in this report carries a positive control on the same
file (noted inline). All arithmetic re-derived by hand.

---

## Verified CORRECT (attacked, could not break)

These are the load-bearing claims both stories rest on. Every one was opened at source, not accepted
from a docstring summary.

**Marker substrate (both stories).** `writeTerminalMarker` (`src/phase-engine/journal.ts:347`) writes
`{ runId, ok, completedAt }` at 0600 via unique-temp + `renameSync` (`journal.ts:357-387`); payload
matches both stories' contract exactly. `runMarkerPath` (`:129`) = `<base>/qds-run/<runId>/journal/final.json`,
`runMarkerRoot` (`:97`), `unidentifiedMarkerPath` (`:157`), `assertRunIdPathComponent` (`:110-123`) —
all four line cites in DF3.7 are exact. `journal.ts:60-63` does record "Since DF1.10 AC7 there is no
production writer EITHER" verbatim. Positive control for the "no production writer" reading: the
comment exists at the cited lines.

**Classifier contract (both stories).** `readMarkerVerdict(driver, vm, markerPath, deadlineMs, expectedRunId?)`
at `src/fleet/fanout-primitive.ts:983-990` — the 5-argument call shape both stories cite is the real
signature, and the 5th parameter is `expectedRunId`, confirming DF3.7 AC2(b)'s "expectedRunId is
passed on every read" is a real parameter, not a story invention. `MarkerVerdict`
(`fanout-primitive.ts:784-788`) is exactly `absent | skip | unusable | settled` with `settled{ok:boolean}` —
the four-verdict vocabulary DF3.7 declares and DF3.8 restates is verbatim correct, and it is *not*
`readBoxFile`'s kind union, exactly as DF3.7 AC2 claims.

**Classifier semantics (DF3.7 AC2).** Every branch DF3.7 enumerates exists and behaves as described:
probe exit `undefined`/`1` → `absent`; any other probe exit → `skip` (`:834-846`); `unreadable` →
`unusable` (`:873-877`); `oversized` → `unusable` (`:879-883`); a `BoxFileRead` kind this build does
not classify → `skip`/`marker-read-unclassified` (`:890-896`) — DF3.7's parenthetical "and `skip`
likewise covers a `BoxFileRead` kind this build does not classify" is literally implemented;
unparseable body → `unusable` (`:903`); `null`/primitive body → `unusable` (`:912-918`);
present-but-non-string `runId` → `unusable`/`marker-run-id-invalid` (`:931-939`, unconditional on the
caller passing an id — DF3.7's claim is right); foreign `runId` → `unusable`/`marker-run-mismatch`
(`:940-950`); `cat`-never-issued → `unusable`/`marker-read-budget-exhausted` (`:856-861`); non-boolean
`ok` → `unusable` (`:952-959`). The docblock sentence "logged as `probe-unanswered`, which asserts the
opposite of what happened" exists verbatim at `:866`.

**Constants and arithmetic (DF3.7 Technical Notes, AC2a).** `DEFAULT_POLL_INTERVAL_MS = 5_000`,
`DEFAULT_PER_CALL_DEADLINE_MS = 10_000`, `DEFAULT_FANOUT_CEILING_MS = 3_600_000`,
`MARKER_UNUSABLE_TICKS_LIMIT = 3`, `PROBE_SKIP_TICKS_LIMIT = 6` — all five values correct. Re-derived:
`6 × (5_000 + 10_000) = 90_000 ms = 90 s`, matching DF3.7's "(90 s on the AC5 defaults)" and matching
fan-out's own docblock at `:85-90` ("six probes that each burn their whole per-call deadline take
6 × (poll + deadline) ≈ 90 s"). The section heading DF3.7 quotes — "INV-6 finite caps (imported
constants — never mirrored literals)" — exists verbatim at `fanout-primitive.ts:44`.

**`boxMarkerPath` env-immunity (DF3.7 AC4).** `boxMarkerPath` (`fanout-primitive.ts:742-744`) is
`` `${boxRunRoot(runId)}/journal/final.json` `` — it reads no environment variable, so DF3.7's "immune
to it by construction rather than by a start-up check" is literally true of the body. `BOX_MARKER_PATH_RE`
exists (`:754`). The quoted historical-defect docblock ("every `test -f` went to the wrong in-box
path, missed cleanly, and `fleet status` reported a whole fleet as `running` regardless of what the
runs had done") exists verbatim at `:733-735`. Fan-out imports no `runMarkerPath` (grep over
`fanout-primitive.ts` returns only `boxMarkerPath`); `runMarkerPath`/`writeTerminalMarker` are
deliberately withheld from `src/phase-engine/index.ts` (comment at `:19`).

**Liveness arm (DF3.7 AC2d, inherited by DF3.8).** `unitActivity` at `src/fleet/run.ts:437`; returns
`active` / `failed` / `inactive` / `unknown`; the `default` branch comment "Includes `unknown`
(systemd's own word for a unit it has never loaded)" is verbatim at `run.ts:477`. `fleet status` shares
the seam: import at `src/fleet/status.ts:35`, call at `status.ts:1309` — both cites exact, and
`status.ts:1311` maps `failed` → `engine-failed`, corroborating that `failed` is the one terminal
reading. Positive control for `unitActivity` being shared: it is found in both files.

**Approval gate surface (DF3.7 AC1/AC5, INV-IBOX-14).** `src/reverify/approval.ts:26` does
`import { requestApproval as gateRequestApproval, type GateDeps } from "../fleet/approval-gate.ts"` —
cite exact. `ApprovalState` (`approval.ts:28`) = `pausing | awaiting-approval | approved | rejected |
timed-out`; DF3.7's terminal set (`approved | rejected | timed-out`) is correct.
`src/fleet/status.ts:54` is `import { expiredState } from "./approval-gate.ts";` — verbatim.
`requestApproval`'s sole production caller is `src/reverify/runner.ts:461`; `scripts/reverify.ts:33`
is the sole production `reverify()` entry — both cites exact. `scripts/pipeline-run.ts` contains the
string `approval` **zero** times (positive control: `pipeline` matches 27 lines in the same file).
`awaitDecision` (`approval-gate.ts:2492`) has no production caller — grep over `src/` and `scripts/`
returns only docblock mentions and the definition (positive control: it *is* found).

**The import-fence rationale is factually sound (DF3.7 AC1 / INV-IBOX-14).** This was the claim most
likely to be wrong and it held. `src/fleet/index.ts:8-20` star-exports exactly eight fleet modules
(brief-schema, dispatch, status, verbs, fanout, fanout-primitive, rank, resident) including `status.ts`;
`approval-gate.ts` is **not** re-exported by the barrel. `status.ts:54` is the only import of
`approval-gate.ts` anywhere in `src/fleet/` (grep over the directory returns exactly one file).
Critically, `src/fleet/run.ts` imports `dispatch.ts` (`:110`) and `brief-schema.ts` (`:105`) and
`fanout-primitive.ts` (`:118`) — and none of those import the gate — so the story's asymmetry (ban the
barrel, permit `run.ts` for `unitActivity`) is coherent under its own "it pulls the gate into the
import graph" rationale, not merely asserted. `RunRecord` is exported from
`src/providers/run-record.ts:124`, so the permitted `RunRecordStore`/`RunRecord` import is real.

**INV-APPROVE-6 (DF3.7 AC5, INV-IBOX-14).** The comment "INV-APPROVE-6, ENFORCED rather than
asserted" is at `src/fleet/approval-gate.ts:1823`, and the guard at `:1837` is
`if ((rec.vmName !== undefined || rec.keyHash !== undefined) && rec.closedAt === undefined && deps.teardown === undefined)`
→ throw. So DF3.7's "refuses to promote a record whose body still names a box or key while no
`teardown` seam is provided, so a promoted `pausing` record cannot still own live infrastructure" is
exactly the shipped behaviour, and it is what makes the story's admitted exception (a hand-run
`scripts/reverify.ts` against a live box) land on the `gate-refused` arm rather than promoting a live
box. `refuseLiveInfraOnDecidable` exists at `:1259`; the R5-C keyHash guard at `:1810`. Both names
DF3.7 cites are real.

**`reverify()` composition (DF3.7 AC5 DoD "zero driver.exec").** `runner.ts:217`
`const hostRoot = deps.hostRoot ?? process.cwd();`; `:218` `resolveRunsDir(deps.runsDir)`; `:421`
`if (report.verdict !== "green") return { report, approval: null };`; `:430` `const port =` with
`recordApprovalPort(..., { bundleDir: runsDir })` — no `teardown` in the deps, confirming "the
production port is built with no `teardown` seam at `src/reverify/runner.ts:430`"; `:436-460` is the
bound-reportId/resume-arm block DF3.7 quotes ("`pausing` never expires and nothing else promotes it,
so the run would be stranded for good" is verbatim there). The DoD's "zero `driver.exec` calls issued"
test is not just satisfiable, it is a *sharp* test: `ReverifyDeps` carries no `driver` at all
(`:217-221`), so any `driver.exec` on the promote path can only have come from the observe or teardown
leg the story forbids.

**Gate timing honesty (both stories).** The claim "the gate omits `teardown_at_pause_ms` rather than
zeroing it" is TRUE — `approval-gate.ts:1857-1863` times it only when the seam exists and leaves the
field absent otherwise. (The *citation* is wrong; see W8-A-4.)

**Reaper interplay (DF3.7 AC3 / DF3.8 Deviation 1, AC2e, AC3, header follow-up).** Substantively all
correct: `record-claim-refused` (`reaper.ts:881`) sits inside the `unit.type === "destroy"` branch
(`:871`), so "guards destroy only" is right; an open record past `staleAfterMs` classifies
`stale-record` → `teardown` at three sites, one per enumeration loop (VM `:586`, key `:629`, record
`:642`, `aged` defined `:560`, `staleAfterMs` read `:474`); `teardownSandbox(teardownDeps, unit.id, h)`
is called with no opts (`:793`) and `teardownSandbox` harvests (`teardown.ts:832` `harvestRun`,
`:733` `closedAt`) — so "harvest, destroy, revoke, `closedAt`, and **no `reverify()`**" is correct.
`staleAfterMs: 14_400_000` at `src/providers/quota.ts:49` — cite exact. `scripts/sandbox-reap.ts` is
dry-run unless `--yes`. Since DF2.11 the reaper's teardown runs under `withRunLock` (`:793`), and the
**revoke unit is genuinely unlocked** (`:889-893` — no `withRunLock`), so the DF3.8 header's issue-#244
premise is correct. `scripts/sandbox-teardown.ts` acquires at `:234`.

**Run-lock primitives (both stories, AC5/AC2/INV-IBOX-16/17).** `RunLockedError` at
`scripts/lib/run-lock.ts:54` with the `stale` flag (`:64`) and the `rm ${lockPath}` remediation for the
dead-holder case (`:70`) — DF3.8's `:54-64` cite is exact and its "distinguishes them and carries the
`rm` line" is right. `RunLockReentrantError` at `:81`, thrown by
`if (moduleState().held.has(lock)) throw new RunLockReentrantError(lock);` at `:1008`, which is at the
head of `acquireRunLock` (`:991`) — DF3.8's description is exact. `acquireRunLock` returns the
*resolved* path branded `RunLockHandle` (`:1007`, `:1025`, brand at `:974`) — DF3.8's "returns the
resolved lock path, which is the value DF2.11 brands as `RunLockHandle`" is correct, as is "its `held`
map and signal-release handler are process-global" (`moduleState()` on `globalThis` via
`Symbol.for`, `:120-128`; `installSignalRelease` `:278`; `process.on("exit", …)` `:344`). The ponytail
note DF3.8 quotes is verbatim at `:988-989`: "ponytail: library callers bypass the lock — the CLIs are
the operator surface. / Upgrade trigger: an embedder (not a CLI) becomes a supported caller."

**F106 (DF3.7 AC5 / INV-IBOX-16, DF3.8 AC2e/AC5, INV-IBOX-17).** `F106` does not exist in `src/` or
`docs/` (positive control: `F064` is found in both places, and `grep -c "re-verify"
src/reverify/worktree.ts` = 11). It exists in `TECH_DEBT_AUDIT.md:317`, and that row cites
`src/reverify/worktree.ts:319` and states precisely the precondition both stories attribute to it —
"Two concurrent `reverify()` calls in one host process would let a guard trip in one run kill the
other's children … **Currently unreachable** — `reverify()`'s only production entry is
`scripts/reverify.ts`, one process per invocation … It becomes real the moment a second caller
exists". Both stories' citation and their "F106 is narrowed, not retired" framing are correct.

**Verb/exit surface (both stories).** `verbs.ts:74` `summary: "Mint a run handle and provision a
sandbox"` (cited `:73-74`, correct); `:88-89` "this registry is a CONTRACT — DF3.5's skill-contract
test compares these against what the verbs actually return, and a generated skill drops an undeclared
code into its default branch" (cited `:86-90`, correct); DF3.1's exit-5 mapping text "5 = the run lock
refused, so the verb never ran — 'refused before provisioning'" is at `verbs.ts:129-131`.
`scripts/fleet.ts` `runDestructive` is defined at `:4659` and takes the lock at `:4809`; `fleet
dispatch`'s acquisition is genuinely non-fatal — "must NOT abort the mint" verbatim at `:2148`, the
`acquireRunLock` in a `try` with a swallowed `printError` at `:2153-2162`.

**Dispatch ordering (DF3.8 AC4a).** `store.create(opts.runId)` at `src/providers/driver.ts:571`
("Record first. If this throws (EEXIST, bad id) no box is ever created.") precedes
`driver.create(...)` at `:724`. `dispatch.ts:2861-2863` states explicitly that
"`within("create", …)` wraps the whole of `provisionAdmittedRun` — `store.create`, the budget
`store.set` AND `driver.create`". DF3.8's choice to cite by symbol rather than line for this region is
sound and its reasoning ("that region also carries EEXIST/`run-id-in-use` handling and a line cite
there rots") is verified by the fact that line numbers in this file *do* rot (see W8-A-6).

**Other confirmed substrate.** `oci/exedev/systemd/qds-run@.service`: `:58` `Type=simple`, `:169`
`Restart=no`, `:158` `RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace`, `:160`
`RuntimeDirectoryPreserve=yes`, and the no-`[Install]` block at `:277-289` including the quoted
"an ENABLED instance is pulled in by multi-user.target on EVERY subsequent boot" at `:279-281` — every
cite in that cluster is exact, and the file is 289 lines so `:277-289` is the whole block.
`src/fleet/run.ts:1-11` states "start the in-box phase engine and RETURN … never holds the run";
`run.ts:509` is `const rec = deps.store.get(runId);` — the read-only claim holds. `dispatch.ts:63-66`
carries the DoD "no substrate command string under `src/fleet/`" verbatim. `engine_boot_anchor` is
emitted by `scripts/pipeline-run.ts` (`:358`, `:403`). The image build scan allow-lists exactly
`QDS_PI_CATALOG_DIR` and `QDS_TEAM_RUNNER` by name and refuses `QDS_RUN_ROOT`/`QDS_STEERING_ROOT`
(`tests/providers/exedev/image-assets.test.ts:72`, `:369-370`) — DF3.7 AC4's "(cited, not assumed)"
holds. `scripts/pipeline-run-remote.ts` is deleted. ADR `:101-102` is the product claim verbatim;
Appendix A is at `:129`; Consequence 4's Appendix-A clarification at `:116`. Probe JSON exists.
`src/fleet/approvers.ts`, `src/pr/push.ts`, `src/providers/run-record.ts` all exist, so the four
zero-changed-lines targets are real files. The four new test files both stories declare as
deliverables do not exist yet, as expected.

**Writer ↔ reader contract between the pair (checked against the substrate, not against each other).**

| Contract field | Producer (DF3.7) | Consumer (DF3.8) | Verified against |
|---|---|---|---|
| marker path + payload | `{runId, ok, completedAt?}` at `/run/qds-run/<runId>/journal/final.json` | restates identically | `journal.ts:129,347-388`; `unidentifiedRunRoot` → `/run` in-box |
| verdict vocabulary | `absent \| skip \| unusable \| settled`, `settled{ok}` | identical | `fanout-primitive.ts:784-788` |
| liveness arm | only `failed` terminal; `inactive`/`unknown` non-terminal, skip-streak | restated identically | `run.ts:466-480`, `status.ts:1309-1313` |
| exit table | `[0, 1, 2, 4, 5, 6]` declared once on the `observe` descriptor | "the exit table is DF3.7's, cited and not restated"; `--all` adds no code | `verbs.ts:88-89` contract test |
| lock ownership | module acquires nothing; caller's `RunLockHandle` in `deps.runLock` | sweep acquires itself, passes handle + `maxTicks: 1` | `run-lock.ts:991-1031`, `teardown.ts:507-531` |
| `deps` shape | `{ driver, store, runsDir, hostRoot, runLock, maxTicks?, windowMs? }` | "DF3.7's Files to Modify defines both" — matches | DF3.7 Files to Modify |
| refusal codes | `run-completion-unobserved` (window), `run-engine-dead`, `box-unreachable`, `approval-already-registered`, `gate-refused-live-infra` | consumes unchanged; mints `completion-unwitnessed` and `run-lost-to-reboot` as *new* codes, never reusing DF3.7's | distinct concepts, distinct codes, no collision |
| `pausing` handling | non-refusal → `promoteStrandedPause` | "AC5's pre-flight refusal (which does **not** refuse `pausing`)" | `approval-gate.ts:1837` guard makes the live-box case safe |
| `closedAt` candidate filter | "what makes a *driven* run non-repeatable is `closedAt`" | AC2(a) candidates = `closedAt` unset | consistent |
| INV-IBOX-16 | corrected to "at most one automatic caller at a time, each holding the per-run invocation lock", three sanctioned callers | claims to be one of the three, takes the lock, does not amend | consistent |

No field has a producer in one story and a consumer in the other that does not line up.

---

## Findings

### W8-A-1 — DF3.8 requires cross-pass retirement of a `run-engine-dead` candidate that its own no-persistence contract makes unimplementable
**Severity: HIGH · Category: C3-structural · Story: DF3.8, AC4(d) + DoD "Test (reboot measurement, AC4)"**

Failure scenario: an implementer takes AC4(d) literally — "reported once per pass … and **excluded
from subsequent enumeration** on the strength of that re-derived reading (nothing persisted)" — and
the DoD's stronger form, "counted in `runs_engine_dead` … and **retired** from later passes". Both
require state that survives the process. But the same story's Technical Notes "Contracts/Schema" says
"this story persists **nothing**. No observation record, no sweep cursor, no field on DF2.1's run
record", AC5 requires "one bounded pass, a typed exit, no PID file … nothing that stays resident",
and INV-IBOX-19 keeps the *no new state* limb "literally". Since the sweep is one process per cron
tick, an in-process retirement set dies with the pass: the `failed` run is re-enumerated and
re-refused on every subsequent tick, which is precisely the outcome AC4(d)'s own negative control names
as the failure — "parks the arc's most common dead run at the head of an oldest-first queue and reports
every tick as healthy with `runs_observed: 0`". The Technical Notes "Guards/limits" paragraph repeats
the claim ("an engine that started and died is retired by AC4(d)'s `run-engine-dead` arm … which is
what keeps this paragraph's ordering argument true in practice") and, one clause later, gives the
reboot arm the "costs one pass's two reads per tick until an operator acts" fate — the fate the
`failed` arm also gets under no-persistence, which the paragraph's contrast is written to deny.

Evidence: only the in-pass reading is implementable. The story never says which it means, and its
negative control asserts the cross-pass behaviour it also forbids. Either AC4(d) needs the in-pass
scoping stated, or it needs a retirement mechanism the no-persistence invariant permits.

### W8-A-2 — DF3.8's serialization DoD assigns the sweep's lock refusal an exit code its own AC6 forbids
**Severity: MEDIUM · Category: C3-structural · Story: DF3.8, DoD "Test (serialization, AC2)" vs AC6 / AC2(c) / DoD "Impl"**

Failure scenario: the DoD bullet reads "a busy lock is a counted skip at exit 5 while a **stale** one
is its own remediated outcome". AC6 says the opposite and says it three ways: "a per-run refusal —
… a busy or stale lock — is **counted and reported on its own line**, never the sweep's exit code",
"a partial pass that hit `max-candidates-per-pass` or the wall-clock budget still exits **0**", and "a
sweep that drove **zero** runs exits **0**". AC2(c) agrees ("records as a counted `lock-refused` skip
inside a pass that still exits 0"), as does the DoD Impl bullet ("`--all` maps **every** per-run
outcome to a counted skip and exits 0 for any pass that completed"), as does DF3.7's exit-table note
("the `--all` sweep inherits the same mapping but counts a refusal as a skip instead of an exit").
Two acceptance tests written from the two DF3.8 clauses cannot both pass: the exit-5 test fails a
correct sweep, and the exit-0 test fails the implementation the exit-5 clause demands. This is a local
self-contradiction, not a writer↔reader gap — DF3.7 and DF3.8's ACs agree.

Evidence: `scripts/fleet.ts` `runDestructive`'s exit-5 mapping is a *single-run-verb* mapping; nothing
in the tree gives `--all` a per-run exit.

### W8-A-3 — Both stories' reaper citation cluster points at the wrong enumeration loops
**Severity: MEDIUM · Category: C1-citation · Stories: DF3.7 AC3; DF3.8 Deviation 1 (Spec Reference)**

Failure scenario: an implementer verifying DF3.7 AC3's claim (or DF3.8 Deviation 1's restatement)
opens the cited lines and lands in the wrong code. `aged()` is cited at `reaper.ts:510` — it is
defined at `reaper.ts:560`, and `:510` is the tail of an unrelated comment block. The three
classification sites are cited as "`:531-539` VM, `:575-582` key, `:587-595` record" (DF3.7) with
"VM-side at `:537`, key-side at `:580`, record-side at `:593`" (DF3.8) — the actual sites are VM
`:586`, key `:629`, record `:642` (`stale = aged(...)` at `:581`/`:625`/`:637`). Worse, the pin-point
cites land in genuinely wrong code: `:537` is inside the keyHash-`mismatchRunIds` loop, `:580` is the
`leaked-vm` continue, and `:593` is the `sbx-` prefix guard at the head of the *key* loop — so a
reader who trusts the pin-points concludes the record-side site is in the key enumeration. Also in
this cluster: `record-claim-refused` cited `reaper.ts:805-811`/`:808` (actual `:881`), the
`teardownSandbox` call cited `:726` (actual `:793`), and DF3.8's "the limit read at `:424`" (actual
`:474`). Every *substantive* claim in the cluster verified true (see the verified-CORRECT section);
only the addresses are wrong.

Evidence: `grep -n "aged\|stale-record\|record-claim-refused\|teardownSandbox\|staleAfterMs"`
`src/providers/reaper.ts`.

### W8-A-4 — Both stories cite the wrong region of `approval-gate.ts` for the `teardown_at_pause_ms` rule
**Severity: MEDIUM · Category: C1-citation · Stories: DF3.7 Spec Reference + Observability Contract; DF3.8 Observability Contract**

Failure scenario: both stories cite `src/fleet/approval-gate.ts:1124-1137` as authority for "the gate
omits `teardown_at_pause_ms` rather than zeroing it (deferred item D8)" (DF3.7 Observability Contract)
and, in DF3.7's Spec Reference, for "after the box is already torn down". Lines `:1121-1134` are the
docblock of `readApprovalIfPresent` — the tolerant corrupt-poll reader and its `MAX_CORRUPT_POLLS`
bound, an unrelated mechanism. The rule the stories are citing lives at `:1857-1863` ("Timed only when
the seam EXISTS. `teardown_at_pause_ms` is absent — not zero — when no teardown was owed"), with the
`PauseTimings` field declared at `:1287`. An implementer who goes to `:1124-1137` to check the D8
behaviour finds a corruption bound and concludes the cite is decorative.

Evidence: `grep -n "teardown_at_pause_ms" src/fleet/approval-gate.ts` → `:1278, :1287, :1857, :1863`.

### W8-A-5 — DF3.7's `fanout-primitive.ts` citation cluster is stale by 41–67 lines (constants by 1)
**Severity: MEDIUM · Category: C1-citation · Story: DF3.7 (Spec Reference, AC2, AC4, Technical Notes)**

Failure scenario: every symbol name is right, so nothing breaks — but every line address in the
marker region is wrong, and the story leans on these cites as evidence, not as decoration. Drift
table (cited → actual in this tree):

| Cited | Actual | Symbol / text |
|---|---|---|
| `:701` | `:742` | `boxMarkerPath` |
| `:713` | `:754` | `BOX_MARKER_PATH_RE` |
| `:773` | `:816` | `classifyMarkerRead` |
| `:774-803` | `:834-846` | probe-exit → `skip` logic |
| `:805-834` | `:863-872` | the docblock quoting "asserts the opposite of what happened" (at `:866`) |
| `:891-899` | `:940-950` | `marker-run-mismatch` |
| `:925` | `:983` | `readMarkerVerdict` |
| `:959` | `:1026` | `markerUnusableGivesUp` |
| `:1046` | `:1111` | `boxMarkerPath(armRunId)` in the race |
| `:1216` | `:1268` | `probeArm` |
| `:685-700` | `:727-741` | the "every `test -f` went to the wrong in-box path" docblock |
| `:52` | `:53` | `DEFAULT_POLL_INTERVAL_MS` |
| `:55` | `:56` | `DEFAULT_PER_CALL_DEADLINE_MS` |
| `:58` | `:59` | `DEFAULT_FANOUT_CEILING_MS` |
| `:68` | `:69` | `MARKER_UNUSABLE_TICKS_LIMIT` |
| `:101` | `:102` | `PROBE_SKIP_TICKS_LIMIT` |

The two-range split (constants off by exactly 1, functions off by 41–67) shows two separate drift
events, i.e. the cites were written against an older file and never re-checked. The `:685-700` cite is
the most costly: DF3.7 uses it both as the historical-defect citation for AC4 and as the evidence that
"fan-out deliberately does not import it at all", and `:685-700` is the tail of the arm-outcome loop
plus `classifyArmFailure`.

Evidence: `grep -n "export function boxMarkerPath\|export async function readMarkerVerdict\|…"` on
`src/fleet/fanout-primitive.ts`.

### W8-A-6 — DF3.8's `scripts/fleet.ts` cites point at unrelated regions
**Severity: MEDIUM · Category: C1-citation · Story: DF3.8 (Spec Reference, AC2c)**

Failure scenario: "taken at `scripts/fleet.ts:4257` in `runDestructive`" — `runDestructive` is
declared at `:4659` and its `acquireRunLock` call is at `:4809`; `:4257` is a comment about
`readOnlyStore` in an unrelated handler. "(`scripts/fleet.ts:1966-1985` — 'a refusal here must NOT
abort the mint')" — `:1966-1985` is the `DestructiveState` interface and `runDispatch`'s prologue; the
quoted sentence is at `:2148` and the swallowing `try`/`catch` around `acquireRunLock` at
`:2153-2162`. Both claims verified true; both addresses wrong. Note that DF3.8 *itself* argues (AC4a)
that line cites in `dispatch.ts` rot and should be by-symbol — the same argument applies to the file
it cites by line here.

Evidence: `grep -n "runDestructive\|acquireRunLock\|must NOT abort the mint" scripts/fleet.ts`.

### W8-A-7 — DF3.8's exit-5 mapping cite lands on the wrong verb descriptor
**Severity: LOW · Category: C1-citation · Story: DF3.8 (Spec Reference, AC2c, AC6)**

`src/fleet/verbs.ts:117-124` is cited for DF3.1's "exit 5 = 'the run lock refused, so the verb never
ran'" and for the quoted phrase "refused before provisioning". That text is at `:129-131`, on the
`harvest` descriptor; `:117-124` is the tail of the `status` descriptor (whose exit-5 is the
records-integrity guard — a *different* exit-5 meaning) plus `harvest`'s opening lines. An implementer
who reads `:107-118` gets status's exit-5 semantics and could carry the wrong meaning into `observe`.
DF3.7's own Files to Modify states the mapping correctly without a cite.

### W8-A-8 — `stampCorrelation` cited 114 lines away from its definition
**Severity: LOW · Category: C1-citation · Stories: DF3.7 Observability Contract; DF3.8 Observability Contract**

Both stories cite `src/fleet/dispatch.ts:2667` for `stampCorrelation`. It is defined at `:2781` (call
sites `:2818`, `:2844`, `:2917`); `:2667` is inside a `defaultKeyCapMicroUsd` comment. The claim —
"read off the run record's correlation stamp (`stampCorrelation` …)" — is correct; the address is not.

### W8-A-9 — `sandbox-reap` dry-run cite points at the Usage block
**Severity: LOW · Category: C1-citation · Story: DF3.7 AC3 (DF3.8 Deviation 1 restates it without a fresh cite)**

`scripts/sandbox-reap.ts:7-9` is the `Usage:` block; the statement both stories are actually
attributing to it — "Dry-run by default … `--yes` applies" — is at `:13-16`. Six lines off, claim
correct.

### W8-A-10 — DF3.7's observation window has no default, though every other number in the story is given a value
**Severity: LOW · Category: C4-marginal · Story: DF3.7 (Technical Notes "Guards/limits") + DF3.8 (Guards/limits)**

"The **observation window** is therefore this story's only new number, named in code rather than
implied. It is operator-settable on the verb and has to be" — the seam shape is fully specified
(`windowMs?` in `deps`, `maxTicks` unset ⇒ poll to `windowMs`), but no default value and no default
source is named anywhere in either story, while every *inherited* constant is given its exact value.
DF3.8 explicitly handles the analogous gap for `PROVISION_LAG_MARGIN_MS` ("set from the first live
e2e's own observed lag with a stated multiple") and for the sweep interval; DF3.7 leaves `windowMs`'s
default to the implementer. Not misleading — an operator-settable knob with a documented override
cannot break an AC — but the story is inconsistent about which numbers it prices.

### W8-A-11 — DF3.7's bare "`:101-102`" reads as a `src/` cite but means the ADR
**Severity: LOW · Category: C4-marginal · Story: DF3.7 (Trigger Surface)**

The `--await-completion` out-of-scope row cites `src/fleet/verbs.ts:73-74` and `src/fleet/run.ts:1-11`
and then says "inverts the ADR's own product claim (`:101-102`)". `run.ts:101-102` is an import
comment; the product claim is at
`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md:101-102` (verbatim, verified). DF3.8 cites
the same range explicitly against the ADR file and is unambiguous; DF3.7's bare range after two
`src/` cites is not. An implementer who resolves it against `run.ts` finds nothing and moves on.

### W8-A-12 — `box-unreachable` / `run-engine-dead` are same-named events on two producers with different shapes
**Severity: LOW · Category: C4-marginal · Stories: DF3.7 Observability Contract; DF3.8 Observability Contract + AC6**

DF3.7's observer emits `event: "box-unreachable"` carrying `marker_poll_ms` (terminal, after six skips
+ 90 s); DF3.8's sweep emits `event: "box-unreachable"` carrying `sweep_ms` (per-pass disposition, at
`maxTicks: 1`, where DF3.7's streak can never fill). DF3.8's "this story mints no second vocabulary for
a line DF3.7's code writes" is true of the vocabulary and false of the *emitters* — the sweep does emit
a `box-unreachable` line DF3.7's module can never produce at `maxTicks: 1`. Distinguishable by field
shape, so an operator reading a line loses nothing; an aggregator keying on `event` alone would conflate
a terminal streak with a per-pass report.

---

## Category × severity

| Category | BLOCKER | HIGH | MEDIUM | LOW | Total |
|---|---|---|---|---|---|
| C1-citation | 0 | 0 | 3 (W8-A-3, W8-A-4, W8-A-5) | 4 (W8-A-6→W8-A-9) | 7 |
| C2-semantic | 0 | 0 | 0 | 0 | 0 |
| C3-structural | 0 | 1 (W8-A-1) | 1 (W8-A-2) | 0 | 2 |
| C4-marginal | 0 | 0 | 0 | 3 (W8-A-10, W8-A-11, W8-A-12) | 3 |
| **Total** | **0** | **1** | **4** | **7** | **12** |

Notable absence: **no C2-semantic findings.** Every substantive claim either story makes about shipped
code — the classifier's full verdict mapping, the lock primitives' non-reentrancy and stale/busy
distinction, INV-APPROVE-6's enforcement, the reaper's `stale-record`→`teardown` witness-less
collection, `reverify()`'s no-`driver` port, the `stampCorrelation` join key, the `within("create")`
ordering, the image env allow-list, F106's scope — is true of this tree. The residue in this pair is
address accuracy (C1) and two self-consistency seams inside DF3.8 (C3), not wrong mechanics.

---

## Convergence verdicts

### DF3.7 — `df3-7-approval-gate-bridge.md` — **CONVERGED** (confidence: high)
Residue: stale line citations (W8-A-4, W8-A-5, W8-A-8, W8-A-9, W8-A-11) and one unpriced knob
(W8-A-10); its one ambiguous lock sentence ("No lock is held across teardown (the gate's own rule)")
is resolvable against AC5/DoD/INV-IBOX-16, which say four times in four places that the caller holds
the run lock across the chain, and `teardownSandbox`'s handle check is path-only
(`teardown.ts:522`) so the charitable reading costs nothing. Nothing here is a wrong mechanism.

### DF3.8 — `df3-8-host-completion-watcher.md` — **NOT CONVERGED** (confidence: high)
Residue: two self-contradictions at its own seams that an implementer cannot satisfy simultaneously —
AC4(d)'s cross-pass retirement of `run-engine-dead` against the story's own no-persistence/single-pass
invariant (W8-A-1, HIGH), and the serialization DoD's "counted skip at exit 5" against AC6's "never
the sweep's exit code" (W8-A-2, MEDIUM) — plus the same stale-cite debt as DF3.7 (W8-A-3, W8-A-4,
W8-A-6, W8-A-7, W8-A-8) and one event-vocabulary collision (W8-A-12). The mechanics and the
writer↔reader contract are sound; the two ACs are not.
