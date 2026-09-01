# R9 — Approval-Gate Bridge (input to story DF3.7)

Research for the writer of DF3.7 "Approval-Gate Bridge", per
`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` Consequence 4
("awaiting marker in-box, host polls; gate stays host-owned").
Repo `/Users/steve/QDS-Factory`, branch `feature/df1-10-tier2-placement-adr`, read-only.

---

## 0. HEADLINE — the premise the ADR bullet rests on is not what the code does

**The phase engine has never touched the approval gate, and the gate has no
engine-side leg to break.** Three independent facts establish this:

1. `requestApproval` has **zero call sites in the CLI and zero in the engine**. Its
   sole production caller is `src/reverify/runner.ts:461` (`port.requestApproval`),
   reached from `scripts/reverify.ts:33` — a *host-side, out-of-box operator command*.
   The gate's own header says so verbatim: "`requestApproval` has zero call sites in
   the CLI — the pause happens inside reverify" (`src/fleet/approval-gate.ts:1170-1172`).
2. `scripts/pipeline-run.ts` contains the string `approval` **zero times**, and
   imports nothing from `src/fleet/approval-gate.ts`, `src/reverify/`, or
   `src/providers/run-record.ts`. Grep of every import in `scripts/pipeline-run.ts:46-99`
   and all of `src/phase-engine/`: the only `src/providers/*` edges are
   `bounded-exec.ts` (`gates/command-gate.ts:17`, `phases/test-results.ts:37`,
   `roster/validate.ts:34`) and `exedev/driver.ts`+`transport.ts` in the *remote shim*
   (`scripts/pipeline-run-remote.ts:39,41`). `src/phase-engine/steering.ts:538` states
   the rule explicitly: "the engine imports no provider or fleet code".
3. The gate runs **after the box is already dead**. `approval-gate.ts:1131-1136`:
   "`reverify()` is host-side out-of-box and runs AFTER DF2.5 has already torn the box
   down, so the port it builds carries no teardown seam". Confirmed by
   `src/reverify/runner.ts:430` — the production port is built with `{bundleDir: runsDir}`
   and **no `teardown`**; a repo-wide `grep "teardown:"` returns no `GateDeps` call site
   (also recorded at `_bmad-output/evidence/df3-4-review-round-6/auditor.md:19`).

**Consequence for DF3.7.** The `pausing → teardown → awaiting-approval` ordering
(`approval-gate.ts:8-17`) is *not* a live-box ordering in the shipped system: by the time
`requestApproval` runs, the record already carries `closedAt` and the teardown seam is
absent by design (D8). The gate is therefore **already immune to engine placement**. What
actually breaks when the engine moves in-box is one tier up: **nothing on the host learns
that the run finished**, so nothing triggers the harvest → teardown → reverify → gate
chain. That, not "the engine pauses at the gate", is what the bridge has to carry.

The ADR's own wording is compatible with this reading ("in-box engine writes an awaiting
marker; host polls; gate ownership unchanged") — but a writer who reads "awaiting marker"
as `extensions.approval.state = "awaiting-approval"` will build the wrong thing. **The
marker is a run-completion / hand-back marker, not an approval state.** DF3.7 must say so
in one sentence or the story will be mis-implemented.

---

## 1. The current gate flow, end to end

### 1.1 Who calls what

```
(host) bun scripts/pipeline-run.ts …            ← engine; NO gate, NO record, NO harvest
(host) fleet teardown <run>                     ← scripts/fleet.ts:4177 teardownSandbox(tdeps, id, {noHarvest})
                                                   harvest (DF2.5) → destroy → revoke → closedAt
(host) bun scripts/reverify.ts <run>            ← scripts/reverify.ts:33 → reverify()
         src/reverify/runner.ts:212 reverify()
           … checks, appendReport …
           :417  if (report.verdict !== "green") return   ← RED/ERROR never reach the gate
           :430  port = recordApprovalPort(store, {bundleDir: runsDir})   ← no teardown seam
           :456  bound = store.get(runId).extensions?.approval
           :461  port.requestApproval(runId, {proposal, reportId, headSha})
             src/reverify/approval.ts:116 → refuseHollowBundle() → gateRequestApproval()
               src/fleet/approval-gate.ts:1241 requestApproval → :1280 pauseRun
(host) fleet approve|reject <run> --approver …  ← scripts/fleet.ts:2755 verb block
           :2916 sweepExpired  → :2937 submitDecision (approval-gate.ts:1911)
(host) DF5.2 push                               ← src/pr/push.ts, reads extensions.approval
```

`scripts/pipeline-run-remote.ts:5-13` states the missing link outright: "nothing invokes
the phase engine after dispatch". So even today the engine leg and the gate leg are joined
only by an operator typing two more commands. **DF3.7 inherits an unwired seam, not a wired
one it must re-route.**

### 1.2 `pauseRun` (`approval-gate.ts:1280-1636`) — the state machine

Under `withApprovalLock` (`:194`), one read-decide-write picks an arm from the record's
current `extensions.approval.state`:

| arm | condition | writes | outcome |
|---|---|---|---|
| **resume** (AC1(c)) | `state === "pausing"` AND `existing.reportId === reportId` byte-equal | `assertBundlePresent(…, "resume")` `:1382`; restamp `requestedAt`/`expiresAt`/`requestId` `:1385-1402` | `requested`, `promote: true` |
| **pause-in-progress** | `state === "pausing"`, different reportId | nothing | `pause-in-progress` |
| **already-decided** | `expiredState(existing, at)` ∈ TERMINAL `:1408` | nothing | `already-decided` |
| **rebind** (AC1(a2)) | effective `awaiting-approval` `:1411` | `assertBundlePresent(…,"rebind")`; `refuseLiveInfraOnDecidable` `:1421`; append displaced id to `supersededReportIds` `:1464-1477` | `rebound` + derived `supersededReportId` `:1486` |
| **stale re-present** | incoming reportId already in `supersededReportIds` `:1439` | throws `approval-report-stale` | throw |
| **unrecognized state** | none of the above `:1495-1503` | nothing | throw |
| **fresh register** | no extension | `state:"pausing"`, proposal, reportId, headSha, requestId, requestedAt, expiresAt, `supersededReportIds: []` `:1506-1527` | `requested`, `promote: true` |

Then, **outside** the lock (`:1549-1635`):

- `ctx.state = "pausing"` — the record says `pausing` on disk from here on `:1553`.
- **R5-C guard** `:1561-1566`: open record with `vmName` but no `keyHash` → throw (a
  minted key may be live and unrevokable).
- **INV-APPROVE-6 no-seam guard** `:1582-1595`: open record naming `vmName` *or* `keyHash`
  with `deps.teardown === undefined` → throw. This is the guard that keeps the shipped
  seam-less reverify port honest.
- **Teardown, outside the lock** `:1601-1609`, fenced by `withTeardownClaim` `:1683`
  (pid-fenced `<runsDir>/<runId>.teardown.claim`, `CLAIM_TIMEOUT_MS = 300_000` `:148`).
  Lock is deliberately never held across teardown (`:52-55`).
- **Promote** `:1613-1633`: retake the lock, re-read, promote **only** from `pausing`;
  losing the race returns `pause-in-progress`, never a false `requested`.

`emitPause` (`:1229-1228`… precisely `:1204-1228`) fires from a `finally` in
`requestApproval` `:1241-1250` — exactly one `event: "pause"` line per call, carrying
`requestId` (= the run's dispatch id, since the gate is a library call) and
`dispatchRequestId`.

### 1.3 The pid-fenced approval lock

`withApprovalLock(dir, runId, body)` — `approval-gate.ts:194-…`, path
`<runsDir>/<runId>.approval.lock`, mode `0600`, content `${pid}:${uuid}` `:207`.
`assertExistingRunId(runId)` runs **before** the path is built `:200` (path-traversal
fence). `LOCK_TIMEOUT_MS = 15_000` `:129` (3× the store's own 5 s `Atomics.wait`),
`LOCK_POLL_MS = 10` `:130`, `LOCK_STALE_MS = 30_000` `:138`. Reclaim doors (`:91-107`):
provably-dead holder (`isLockHolderDead`, ESRCH only, `:156-163`), a **zero-byte /
pid-less** lock past `LOCK_STALE_MS`, or `fleet unlock --force`
(`reclaimApprovalLock` `:632`, CLI `scripts/fleet.ts:3395`). Acquisition is
open(`wx`)→write→`fstat` inode→**re-verify identity through the path** `:260-281`; release
is inode-fenced. Sleep is accumulated (`sleptMs`) as a belt against backward clock steps.

`withTeardownClaim` uses the *same* file protocol with a looser reclaim rule (`:1652-1668`):
wrongly reclaiming it degrades to a concurrent teardown, never to a broken mutex; a
**non-empty pid-less** claim (`0:<uuid>` poison marker) is deliberately *not* reclaimable.

### 1.4 Run-record approval namespace (v2)

`src/providers/run-record.ts:239-315`. `extensions.approval`, `schemaVersion: 2`, fields:
`state, proposal, reportId, headSha, requestId, expiresAt, requestedAt,
supersededReportIds (strings), approverId, decidedAt, reason`, plus
`retired: { supersededReportId: "supersededReportIds" }` `:314`.

Three constraints DF3.7 must respect and must not "fix":

- **No `bundlePath`, by design** `:267-280`. Harvest writes nothing to the record; the
  bundle's presence at `<runsDir>/<runId>.bundle` *is* the record
  (`src/providers/harvest.ts:18-19`, path built at `:442`). The gate re-validates by
  existence (`assertBundlePresent` `approval-gate.ts:1075`), and the port adds a
  zero-bytes refusal (`src/reverify/approval.ts:98-113`, `refuseHollowBundle`).
- `supersededReportIds` is append-only and **shed oldest-first** past
  `STRINGS_MAX_ELEMENTS` (256) rather than throwing (`approval-gate.ts:1451-1462`).
- States: `pausing` → `awaiting-approval` → terminal `approved`/`rejected`/`timed-out`
  `:295-296`.

### 1.5 Decide side and `push.ts` report selection

`submitDecision` (`approval-gate.ts:1911`) sweeps expiry internally, re-applies
`assertBundlePresent(…, "decide")` `:1980` and `refuseLiveInfraOnDecidable`, and
compare-and-sets under the lock. CLI arms at `scripts/fleet.ts:2755-3030`; the
`gateEvent` emitter is `scripts/fleet.ts:2710-2753` and carries `dispatchRequestId`.

`src/pr/push.ts:240-260`: the extension is read **before** report selection because it
picks which report is authoritative. A set `approval.reportId` **outranks recency**
(`:255-262`) — the resume strand leaves the record `approved` bound to the *stranded* id
while a newer report sits last in the JSONL, so recency-selection would refuse
`approval-report-mismatch` on every successful resume, permanently. Duplicated bound ids
bind to the **latest** match (`.at(-1)`). Refusal ladder at `:296-335`:
`approval-missing` → `approval-not-approved` → `approval-incomplete` →
`approval-report-mismatch` → `approval-sha-mismatch` → `approval-precedes-report`.

### 1.6 Bundle handling at pause

**Nothing is harvested at pause.** The teardown seam's signature is
`(runId, opts: { noHarvest: true })` (`approval-gate.ts:849`, `:1686`) — `noHarvest` is
hard-coded `true` in the type, and `src/providers/teardown.ts:475,519` skips the harvest
steps. The bundle already exists (harvest ran during the ordinary teardown that produced
`closedAt`), and the gate only ever *checks its existence*. `teardown_at_pause_ms` is
**absent, not zero**, when no teardown was owed (`PauseTimings`, `:1131-1141`, deferred
item D8) — "emitting `0` instead would be a lie shaped exactly like an instantaneous
teardown".

---

## 2. Which calls break when the engine moves in-box

**Direct answer: none of the gate calls, because the engine makes none.**

Complete enumeration of `src/fleet/*` and `src/providers/*` value imports reachable from
`scripts/pipeline-run.ts` and `src/phase-engine/**`:

| importer | module | cross-machine when engine moves? |
|---|---|---|
| `scripts/pipeline-run.ts:88` | `src/fleet/attach.ts` (`ACKS_READ_CAP_BYTES`, `acksPath`, `localSteeringInbox`) | **YES** — this is DF1.10/#181's problem, not DF3.7's |
| `scripts/pipeline-run.ts:89` | `src/fleet/resident.ts` (`startResident`, `DEFAULT_RESIDENT_SLUG`) | **YES** — the resident story's problem |
| `src/phase-engine/gates/command-gate.ts:17`, `phases/test-results.ts:37`, `roster/validate.ts:34` | `src/providers/bounded-exec.ts` | no — pure local exec helper, moves with the engine |
| `scripts/pipeline-run-remote.ts:39,41` | `exedev/driver.ts`, `transport.ts` | the shim is retired by the in-box engine story |
| — | `src/fleet/approval-gate.ts` | **no import exists** |
| — | `src/providers/run-record.ts` | **no import exists** |

So DF3.7's blast radius on the engine side is **zero existing call sites**. It is a *new*
seam, not a re-route. `src/phase-engine/steering.ts:538` is the invariant to preserve: the
engine imports no provider or fleet code — a bridge that makes the engine `import
{ RunRecordStore }` would violate it and drag the whole record schema into the box.

---

## 3. Bridge design constraints, and the resume path that determines the shape

### 3.1 There is no run-resume. Approval authorizes a *push*, not a continuation.

This is the single most important finding for the bridge's shape. Trace it:

- "Resume" in the gate vocabulary means **resuming a stranded `pausing` extension**
  (AC1(c), `approval-gate.ts:14-17`, arm at `:1380-1404`) — re-running teardown and
  promoting to `awaiting-approval`. It resumes *the pause*, not the run.
- After `fleet approve`, the next actor is **DF5.2 `src/pr/push.ts`**, which opens a PR
  from `refs/sandbox/<runId>` on the host. It never dispatches a box, never re-runs a
  phase, never re-enters the engine.
- `src/fleet/attach.ts:405-414` states the terminal fact: every approval state plus any
  `closedAt` record is "over"; the box is gone and steering has nowhere to go.
- `scripts/fleet.ts:3605-3612`: the operator remediation for a decided run is
  "dispatch a **new** run to act on this guidance" — a *new* runId, not a resumed one.

**Therefore the ADR's worry — "box DIES, engine process dies with it; is that compatible
with pausing → teardown → awaiting?" — resolves cleanly: yes, and it is already the
shipped case.** The box dying is a *precondition* of reaching the gate, not a hazard to it.
The in-box engine process is not expected to survive, be resumed, or be told the decision.

DF3.7 should state this as a non-goal in one line, because "resume after approval" is the
obvious wrong thing for a writer to spec.

### 3.2 What the marker actually has to carry

The host needs to learn one fact — *the in-box run reached its terminal phase* — plus
enough to act on it. Everything downstream (harvest, teardown, reverify, gate) already
exists host-side and is keyed on `runId` alone.

Placement candidates, with the precedents:

- **`/run/…`** — tmpfs, **wiped by reboot** (measured; ADR §substrate, issue #180). A
  completion marker that a reboot erases turns a finished run into a hung one. Reject
  unless #180's `tmpfiles.d` fix is a hard dependency *and* the marker is re-derivable.
- **`$HOME`** (ext4 `/dev/vda`, persists across reboot — ADR §substrate). This is where
  the capped per-run key already lives (`$HOME/app/.env`, 0600) and where harvest already
  stages (`harvest.bundle`, box-root relative, `src/providers/harvest.ts:21-23`). **This is
  the lazy correct answer**: the marker rides the same disk and the same harvest pull that
  already exist.
- **New file** — mode `0600`, matching the steering channel's `umask 077` precedent
  (`src/fleet/attach.ts:204-205`) and the lock files' `0o600`.

Observation mechanism, cheapest first:

1. **`driver.exec` read** — the precedent is already in the tree:
   `scripts/pipeline-run-remote.ts:52-59` `fetchBoxFile()` does `cat` over `driver.exec`
   and treats a non-zero exit as a refusal, never as empty bytes. The attach ack poll
   (`src/fleet/attach.ts:293-294`) does the same with a byte cap
   (`ACKS_READ_CAP_BYTES`, `tail -c`). A completion poll is the same shape.
2. `fleet status` polling — `src/fleet/status.ts` is a *read* surface (`create: false`
   store, `assertWritable` throws on write, `:888-892`). It can *render* a marker but
   cannot drive the harvest chain.
3. A fleet watcher daemon — **there is no daemon in this design** and the gate says so
   explicitly (`approval-gate.ts:2111-2113`: "a poll, not a watcher. There is no daemon in
   this design (the story is explicit)"). A watcher would be a new architectural element;
   DF3.7 should not introduce one.

**Recommended bridge shape (one sentence for the story):** the in-box engine writes a
terminal marker to a persistent `$HOME` path at `0600` on its last phase; the host's
existing dispatch/teardown leg polls it by bounded `driver.exec` read with the same
"non-zero exit is a refusal" rule as `fetchBoxFile`, and on observing it runs the
**unchanged** host chain — harvest → teardown → reverify → `requestApproval`. No gate
function changes; no new state; no daemon.

### 3.3 Ordering compatibility

The `pausing → teardown → awaiting-approval` invariant is untouched because the marker sits
*strictly before* the whole sequence. Order on the wire:

```
in-box engine terminal phase → marker written (persistent, 0600)
host observes marker
host: harvest (DF2.5) → destroy → revoke → closedAt        ← box dies here, as today
host: reverify() → green
host: requestApproval → pausing → (no teardown owed) → awaiting-approval
```

The box's death is *upstream* of `pausing`, exactly as in the shipped flow. The one
scenario worth an AC: **the marker is written but the host never observes it** (host
disconnect, operator walks away). The box then sits alive and billing with a finished run.
That is precisely what the orphan reaper is for — see §5.

---

## 4. Ack provenance and the decision flow back

**Nothing flows back into a box.** After `submitDecision`, the only consumer is
`src/pr/push.ts` on the host (§1.5). There is no engine that needs to know, and no fresh
box is dispatched.

`supersededReportId` retirement — current state, stated precisely because the writer will
otherwise re-derive it wrong:

- The **record** stores `supersededReportIds` (plural, ordered oldest-first),
  `schemaVersion: 2`, with `retired: { supersededReportId: "supersededReportIds" }`
  (`run-record.ts:299-315`). The scalar is *retired*, not merely unregistered
  (`:257-265`) — dropping it from `fields` alone left pre-DF3.4 records carrying a value
  the merge re-persisted beside the array, i.e. two disagreeing sources of truth.
- The **port's published `ApprovalOutcome.supersededReportId`** (singular,
  `src/reverify/approval.ts:39`) is *unchanged and derived per call*
  (`approval-gate.ts:1464`, returned `:1486`): "the id THIS rebind displaced" is a
  per-call fact, not record state.

**requestId join-key — the round-10 MED is resolved, not open.** Two distinct keys, by
design and documented on both emitters:

- `requestId` = the **emitting context's own** id (the CLI's per-invocation id; the gate's,
  which coincides with the run's dispatch id because the gate is a library call).
- `dispatchRequestId` = the **run's dispatch id**, on *every* gate event, and the key
  DF5.3 joins on cross-process.

Rationale at `scripts/fleet.ts:2695-2708` ("it is the ONLY id that is the same on both
sides of the gate … before this field there was no key it could join on") and
`approval-gate.ts:1176-1189`; the record-side note is `run-record.ts:285-293`. Emission
rules: `""` and `undefined` are both **omitted**, never nulled
(`scripts/fleet.ts:2735-2741`), and the gate's own line uses the literal `"unknown"`
rather than minting a random id (`approval-gate.ts:1213-1216`).

**A separate round-10 contradiction IS closed and the writer should not re-raise it.**
PR-150's `edge-engine.md:5` found the resume arm unreachable: reverify mints a fresh
`reverifyId` per invocation, so a byte-equal reportId never occurred and every crash-resume
took `pause-in-progress`. The fix landed at `src/reverify/runner.ts:456-460` — the runner
now reads the bound extension and re-presents `bound.reportId` when
`bound.state === "pausing"`, falling back to the fresh id otherwise. `push.ts:241-262`'s
bound-outranks-recency selection is the downstream half of that same fix.

**Implication for DF3.7:** if the bridge ever adds a *second* caller of `requestApproval`
(it should not need one), it inherits the same reportId-binding discipline, and it would
also make `src/reverify/worktree.ts:319` (TECH_DEBT F106 — the pid guard is only safe
because `reverify()` has exactly one production entry, one process per invocation) go from
latent to live. **A second concurrent reverify caller is a hidden cost the story must
either avoid or price in.**

---

## 5. Timers and expiry with a dead box

- **`expiresAt` / `awaiting-approval` expiry.** `DEFAULT_TIMEOUT_MS = 24 h`
  (`approval-gate.ts:774`), `MIN_TIMEOUT_MS = 60_000` `:775`, `MAX_TIMEOUT_MS = 365 d`
  `:784`; clamped, never refused (`resolveTimeoutMs` `:1892`). Stamped at register/rebind/
  resume from `lockedAt` (`:1328-1334`).
- **`pausing` never expires** — `expiredState` `:893-906`, guard at `:897-899`: "the box
  may still be mid-teardown, and a run that never reached `awaiting-approval` was never
  awaiting anybody." An unparseable `expiresAt` also does **not** expire (`:900-904`).
- **Lazy sweep, no daemon.** `sweepExpired` (`:2080-2092`) is called only from the
  approve/reject verb (`scripts/fleet.ts:2916`, emitting `event: "timeout"` with
  `expiry_sweep_ms`), and `submitDecision` sweeps internally as well (`fleet.ts:2910`).
  `fleet status` **derives** expiry without persisting it, because its store is
  `create: false` (`src/fleet/status.ts:885-892`, `:562-575`) — so a record on disk can
  read `awaiting-approval` while status renders `timed-out`. Both are correct; the
  disagreement is documented, and DF3.7 must not "reconcile" it.
- **`awaitDecision`** (`:2115-2159`) is a poll (default 1 s, floor `LOCK_POLL_MS`), returns
  a *derived* timeout when `expiresAt` has passed with no writer, and throws
  `CorruptApprovalRecordError` after `MAX_CORRUPT_POLLS = 10` consecutive unparseable
  reads (`:957`, `:990`). It has **no production caller** — tests only.
- **Orphan reaper (DF2.6).** `src/providers/reaper.ts` classifies, then re-checks ownership
  immediately before destroy (`:690-760`). Two arms matter to the bridge:
  `record-recheck-failed` (unreadable record ⇒ fail closed, do not destroy) and
  `record-claim-refused` `:749-756` (a box that was record-less/closed at classification but
  is now claimed by an **open** record is *not* destroyed). Reaping is keyed on
  `closedAt`/ownership, **not** on approval state — so a run stuck in `pausing` with an open
  record and a live box is protected from the reaper and will keep billing.
- **A dead box under `awaiting-approval` is the normal, safe case**: the promotion cannot
  happen unless the record is closed or a teardown seam ran (INV-APPROVE-6, `:1582-1595`),
  and `refuseLiveInfraOnDecidable` `:1112-1122` re-enforces it on rebind and on decide.
- **The new expiry hazard DF3.7 introduces** is the *marker* one: an in-box run that
  finishes while the host is away leaves a live box with an open record, no `closedAt`, no
  approval extension at all — invisible to every approval timer (there is no extension to
  expire) and protected from the reaper by `record-claim-refused`. **This needs an AC.**
  The cheapest honest answer is the existing orphan-age path plus a marker timestamp the
  host can age; inventing a second expiry clock inside the gate would be new state in a
  CRITICAL-blast-radius module.

---

## 6. What DF3.7 must NOT touch, and the minimal seam

### Out of scope
- **Attach steering / the box inbox+acks round trip** (#181, #180, Deviation 12). That is
  the re-chartered DF1.10's, per ADR Consequence 2. Touching
  `src/fleet/attach.ts:80-90` (`BOX_STEERING_ROOT_SH`, `inboxPath`, `acksPath`) or
  `src/phase-engine/steering.ts` from this story collides head-on with it.
- **Key lifecycle / credential minting** — `src/providers/credentials.ts`, the capped
  per-run key, `keyHash`. The gate only *reads* `keyHash` in two guards (`:1562`, `:1114`).
- **`src/pr/push.ts` beyond what the bridge needs — which is nothing.** The bridge does not
  change which report is authoritative, does not change binding, does not change the
  refusal ladder.
- **The gate's state machine, lock protocol, expiry semantics, and event contract.** All
  unchanged.
- **`awaitDecision`** — no production caller; do not wire one to "let the engine wait".
  That is the shape that would require a box→host channel, and none exists.

### The minimal seam
`src/fleet/approval-gate.ts` was CRITICAL blast radius at round 8, and this story should
close with **zero lines changed in it**. The seam is:

1. **One writer, in the engine**: a terminal marker at a persistent, `0600` box path —
   ideally the engine's *existing* terminal-marker/journal write extended with a durable
   location, not a new subsystem. (`scripts/pipeline-run.ts` already lands "journal rows and
   the terminal marker" under a records dir — `pipeline-run-remote.ts:12-13`; in-box that
   dir becomes box-local and harvestable per design §5.3.)
2. **One reader, host-side**, in the fleet leg that already owns the box: a bounded
   `driver.exec` read modelled on `fetchBoxFile` (`pipeline-run-remote.ts:52-59`) and the
   attach ack poll's byte cap (`attach.ts:293-294`).
3. **No third thing.** On observing the marker the host runs the chain that already exists.

If the story ends up editing `approval-gate.ts`, `run-record.ts`'s approval namespace, or
`push.ts`, that is a signal the bridge has been mis-scoped as "teach the gate about boxes"
rather than "tell the host the run is done".

### Open questions for the writer (decide in the story, do not leave implicit)
1. Marker path and durability: `$HOME`-persistent, or `/run` + a hard dependency on #180's
   `tmpfiles.d` fix? (Recommend `$HOME`; `/run` re-introduces the reboot hole.)
2. Who polls — the dispatch leg that owns the box, or a new `fleet` verb the operator runs?
   (Recommend the former; a new verb is another manual step in a chain that already has two.)
3. The marker-written-but-never-observed AC (§5, last bullet): which existing timer covers
   it, and what does `fleet status` render for that run in the meantime?
4. Does the marker carry the engine's exit status, or only "terminal reached"? Only the
   latter is needed — reverify re-judges the tree host-side and DF5.1 owns the verdict —
   and the smaller payload keeps the marker out of the trust path.
