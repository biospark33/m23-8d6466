# DF3.4 Deferred Remediation — tracking document

**Created:** 2026-08-29 · **Origin:** `bmad-code-review` round 6 on PR #150 (`9f09a87`, `4d362bd`)
**Owner:** rolling, one session per group · **Status:** 7 / 11 complete (Session C closed 2026-08-29)

Nine items were deferred out of review round 6 with reasons recorded. This document
is the single source of truth for closing them. Each session picks up one group,
closes it to enterprise standard, updates this file, and hands off to the next.

**Raw review artifacts** (18 agent reports + triage ledger) are preserved at
`_bmad-output/evidence/df3-4-review-round-6/`. Read `triage.md` there for the full
142→61 finding ledger, and `auditor.md` for the AC-by-AC coverage table.

---

## Ground rules — apply to every session, no exceptions

1. **No fakes in the proof.** The unit suites run on `FakeDriver`/`FakeKeyApi` by
   design and that stays. But every item below must ALSO be proven against the real
   substrate — real filesystem with real mode bits and real uids, real subprocess
   spawns with real exit codes, real exe.dev boxes and real OpenRouter keys where
   the item touches them. A mock proving a mock is not a proof. Where a property
   genuinely cannot be proven live (e.g. a second uid on a single-user host), say so
   explicitly in the session report — an honest gap beats a fake green.
2. **Read `.claude/skills/qds-live-e2e/SKILL.md` before any live round.** Spend
   protocol, the `QDS_E2E_LIVE` gate contract, and eight hard-won gotchas
   (cwd drift, pi auth shadowing, the leaked `.sandbox/fleet.lock`, exit codes as a
   table not 0-or-bad) live there. Ignoring gotcha #4 blocked three separate rounds.
3. **Spend gate.** Any TIER ≥ 2 run: print the worst-case estimate (keys × cap +
   box-hours) and get an explicit operator "go" BEFORE dispatching. Default cap
   50 000 µ$/key. Every key revoked in `finally`, every box destroyed in `finally`,
   and assert `final-ls` shows zero `e2e-*`/`qds-*` boxes.
4. **Gates before every commit:** `bun test` (full, nothing else running — see
   gotcha #5), `bunx tsc --noEmit`, `bunx biome check src/ scripts/ tests/`,
   `detect_changes` with the blast radius reviewed symbol-by-symbol. All four green
   or the session does not commit.
5. **Branch convention:** `feature/<slug>`, base `dev`, target `dev`. `dev` → `main`
   is a periodic promote only.
6. **Impact analysis before editing any function, class or method**
   (`impact({target, direction:"upstream"})`), and GitNexus `query` for an unfamiliar
   execution flow. **Grep is not a fallback.** It cannot see the call graph, so a
   grep-derived "LOW" is not a weaker answer than an impact-derived one, it is an
   unfounded one — and CLAUDE.md's rule is unconditional. If the index is stale, run
   the canonical reindex (`bash scripts/install-gitnexus-plus.sh`, never a bare
   `gitnexus analyze`). If impact analysis still cannot run after that, **stop the
   edit** and say why; do not proceed on grep and do not report a risk level.
   *(The D3 reindex that once blocked this landed in 79eeeb9 — the blocker is gone.)*
7. **Root-cause, not symptom.** If a fix belongs in a shared callee, put it there —
   one guard in the shared function beats a guard in every caller.
8. **No new abstractions without a second caller.** These are nine small, sharp
   fixes. Resist building a framework for them.

---

## Status board

| ID | Item | Sev | Session | Status |
|----|------|-----|---------|--------|
| D3 | GitNexus index stale + corrupted | tooling | A | ☑ |
| D1 | `pause` gate event never emitted; `record_write_ms` absent | MED | A | ☑ |
| D2 | `--message -` undeclared sentinel; `VerbFlag` cannot express it | MED | A | ☑ |
| D4 | `src/pr/repos.ts` allowlist has NO dir-mode, ownership, isFile or containment check | **HIGH** | B | ☑ |
| D7 | `submitDecision` raw ENOENT on a nonexistent run | LOW | B | ☑ |
| D5 | `FleetError.exitCode` typed `1\|2\|3\|4\|5` vs `report()`'s 1–6 | LOW | C | ☑ |
| D6 | `listedKeyHashes()` discards `truncated` — key-leak check unsound | MED | C | ☑ |
| D8 | AC1(b) teardown ordering is vacuous in the only shipped caller | spec | D | ☑ |
| D9 | `hashToken` single-round sha256, no work factor | LOW | D | ☑ |
| D10 | `approvers.ts` still has its own copy of the path guard D4 extracted | consistency | **D** (rider re-assigned by C) | ☑ |
| D11 | `LOCK_ABANDON_MS` reclaims a lock whose holder may still be executing | MED | **D** | ☑ |

**Status: 11 / 11 complete — the backlog is CLOSED (Session D, 2026-08-29).**

Session D closed D10 (the rider, once a real `dev` merge put both files in one
tree), D11 (the age-only abandon door REMOVED, `fleet unlock` added as the
operator remedy), D8 (AC1(b)/INV-APPROVE-6 amended to option (a), proven live at
TIER-1) and D9 (scrypt with versioned entries, plus `fleet enrol` — the writer
that makes the entropy assumption true rather than documented). It also triaged
CodeRabbit's post-Session-C review: two real bugs fixed, one Critical rejected in
writing as a false positive, one CI failure identified as GitHub Actions billing.

**Historic note.** D5 closed by DECIDING NOT to widen — the finding is real,
its prescribed remedy was wrong; see its Outcome block. D6 closed with a real truncated
response from the real OpenRouter API.

**D10 was NOT in scope for Session C and is re-assigned to Session D** — its merge
precondition was re-checked as the session's first act and is still unmet (both #169 and
#150 are OPEN; neither `src/providers/allowlist-path.ts` nor `src/fleet/approvers.ts` is
on `dev`). That is row 2 of the rider table in the Session plan. **D11 was not reached**
and is handed to Session D whole rather than half-done, as its own section instructs.

---

## Session plan

Four sessions, ordered by what unblocks what. Do not reorder A before B without
reading D3's note — the reindex is a tool every later session depends on.

- **Session A — Unblock downstream.** D3 → D1 → D2. DF5.3 cannot join approvals
  without D1; DF3.5 generates skill contracts from the registry D2 fixes. Ends with
  a TIER-1 live approval-gate round proving the pause event on a real box.
- **Session B — Security.** D4 (own branch, own PR) + D7. Real-filesystem
  authorization proof.
- **Session C — Correctness.** D5 + D6. Ends with a TIER-1 live round proving the
  key-accounting truncation is loud, not silent. **Plus D10 if — and only if —
  its merge precondition is met by then** (see below).
- **Session D — Design decisions.** D8 + D9. Needs a real end-to-end reverify run
  (box → teardown → reverify → gate) and a real allowlist migration. **Carries
  D10 if Session C could not.**

### D10 is a different KIND of item, and the session count does not absorb it

Every other item in this backlog is gated on WORK — a previous session finishing
something. **D10 is gated on a MERGE**, which no session controls: it needs both
#169 (D4) and #150 on `dev`, or `dev` merged into #150's branch, so that
`src/providers/allowlist-path.ts` and `src/fleet/approvers.ts` sit in one tree.
That is an operator action, not a session's.

So D10 is deliberately assigned as a **rider, not a session's anchor**:

| When the precondition is met | Who closes D10 |
|------------------------------|----------------|
| Before or during Session C | Session C, as its closer after D5 + D6 |
| Before or during Session D | Session D, as its closer after D8 + D9 |
| Not by the end of Session D | A standalone follow-up, opened as a GitHub issue at Session D's close so it cannot evaporate with the backlog |

**Neither C nor D may drop its own items to make room for D10**, and neither may
report itself complete while silently skipping it — the whole point of D4's
extraction is undone if the second copy in `approvers.ts` is left standing
indefinitely. If a session cannot close D10, it says so explicitly and re-assigns
it in the row above.

**Do not attempt D10 by cherry-picking or by merging the two branches locally to
create the tree.** The delegation must be reviewed against the real merged
result; assembling that tree by hand is how a behaviour-preserving change stops
being one.

---

## D3 — GitNexus index is stale and partially corrupted

**Severity:** tooling (blocks the quality of every other item's impact analysis)
**Session:** A · **Do first in the session.**

### What is wrong

The index does not contain this branch's symbols and its existing entries are
partially garbage. Observed during round 6:

- `impact({target:"authenticateApprover"})` → `Target not found` (the module is new
  on the branch). Same for `readCappedToken`, `submitDecision`, `awaitDecision`.
- `impact({target:"withApprovalLock"})` resolved to its **pre-DF3.4 location**
  (`src/reverify/approval.ts`), not `src/fleet/approval-gate.ts` where it now lives.
- `detect_changes` returned symbol names that are text fragments, not identifiers:
  `"d dependency su"`, `"Wave 2 (e2e + fixture"`, `"ft) — DD-1 is "`, `"/fleet/Gap re"`,
  and several whose `id` is a run of NUL bytes.

Consequence: every fixer in round 6 fell back to grep, and CLAUDE.md's mandatory
`impact` step degraded to a formality. A stale index that answers confidently is
worse than no index.

### Acceptance criteria

- [ ] Reindex via the canonical script ONLY: `bash scripts/install-gitnexus-plus.sh`.
      **Never a bare `gitnexus analyze`** — it skips the transient `.gitnexusignore`
      negation and silently degrades `tests/gitnexus/graph-queries.test.ts` to `(skip)`.
- [ ] `impact` resolves `authenticateApprover`, `readCappedToken`, `submitDecision`,
      `awaitDecision`, `attachToRun`, `requestApproval` to their **real** files on
      this branch.
- [ ] `detect_changes` returns no symbol name that is a prose fragment or NUL run.
- [ ] `bun test tests/gitnexus/` green. If the contract suite fails, that is the
      **drift alarm working** — follow the upgrade ritual in CLAUDE.md (review the
      named drifted fields, confirm intent against upstream, adopt schema + bump
      `expectedCliVersion` + reindex stamp in ONE commit). Do not silence it.
- [ ] `.gitnexus/cli-version.json` stamped; installed version == pinned version, or
      the discrepancy is explained in the session report.

### Verification (real, no fakes)

`bun test tests/gitnexus/` spawns the real CLI against the real index — that is the
proof. Additionally run `impact` on the six symbols above and paste the real output
into the session report.

### Risk

If corruption survives a clean reindex, it is an upstream bug: capture a minimal
repro and file it upstream before adopting anything. Do not hand-edit the index.

### Outcome — CLOSED 2026-08-28 (Session A)

A clean reindex fixed it. No upstream bug: the corruption was staleness, not a
CLI defect.

`bash scripts/install-gitnexus-plus.sh` (the canonical path — no bare analyze):

```console
gitnexus: /Users/steve/.local/node-arm64/bin/gitnexus (1.6.9)
pi-gitnexus-plus already installed — skipping install.
Repository indexed successfully (55.1s)
13,522 nodes | 28,001 edges | 641 clusters | 300 flows
version stamp: .gitnexus/cli-version.json (installed 1.6.9, pinned 1.6.9)
Indexed commit: 24632ed / Current commit: 24632ed / Status: ✅ up-to-date
```

- **Symbol resolution, all six, real files on this branch.** `authenticateApprover`
  → `src/fleet/approvers.ts` (was `Target not found`), `readCappedToken` →
  `src/fleet/approvers.ts`, `submitDecision` / `awaitDecision` →
  `src/fleet/approval-gate.ts`, `attachToRun` → `src/fleet/attach.ts`.
  **`withApprovalLock` now resolves to `src/fleet/approval-gate.ts`**, not its
  pre-DF3.4 home in `src/reverify/approval.ts` — the specific corruption this
  item was filed for. `requestApproval` returns `status: "ambiguous"` with 5
  ranked candidates (gate function, adapter, port method, two test doubles);
  that is the tool working, not drift — disambiguate with
  `target_uid: "Function:src/fleet/approval-gate.ts:requestApproval"`.
- **No prose-fragment or NUL symbol names.** Proven against a REAL diff, not an
  empty one: `detect_changes({scope:"all"})` over this session's 10 changed files
  returned 22 symbols, every one a real identifier
  (`bounded`, `gateEvent`, `requestApproval`, `renderHelp`, `VerbEntry`,
  `EXTENSION_NAMESPACES`, `stepBase`, …). The first run of the session was
  against a clean tree and returned `changed_count: 0` — that would have been a
  vacuous pass, so the acceptance evidence is the post-change run.
- `bun test tests/gitnexus/` — contract suite 8/8 green on the first run, so
  **no drift, no ritual needed**; installed 1.6.9 == pinned 1.6.9. The functional
  suite flaked once under machine load (`graph-queries.test.ts` AC-1, a real
  `gitnexus impact` subprocess exceeding bun's 5 s default) and passed **16/16 in
  isolation in 17.45 s**. That is skill gotcha #5 verbatim, not a product fault.

**Note for later sessions:** the analyze runs **without `--embeddings`** — the
script's `darwin/x64` branch fires on this host (issue #74), so the graph is
BM25-only and `query()` can miss symbol-name-only hits. `impact`/`context`/
`detect_changes` are unaffected. `.gitnexus/cli-version.json` is gitignored
runtime evidence, not a committed record.

---

## D1 — The `pause` gate event is never emitted

**Severity:** MED · **Session:** A · **Blocks:** DF5.3

### What is wrong

`gateEvent`'s event union in `scripts/fleet.ts` declares
`"pause" | "approve" | "reject" | "timeout" | "refused" | "attach"`, but **no call
site anywhere passes `"pause"`** — a declared event with no producer. The
Observability Contract also names four sub-timings; `teardown_at_pause_ms` and
`record_write_ms` are emitted nowhere by the gate (`record_write_ms` exists in
`src/providers/run-record.ts:2119` and `src/pr/open-pr.ts`, unrelated paths).

It cannot be fixed in the CLI: `requestApproval` has **zero call sites** in
`scripts/fleet.ts`. The pause happens inside reverify
(`src/reverify/runner.ts:406-413`). So the line must come from
`src/fleet/approval-gate.ts`, which today imports only `node:*`,
`../providers/run-record.ts` and `../reverify/approval.ts` types.

**Why it was deferred:** giving that module a logger is a new dependency edge into a
deliberately narrow surface — an architecture decision, not a review patch.

**Why it matters:** DF5.3 is specified to join approvals on `requestId` across every
gate event. The pause is the one event this story's E2E slice is built around and it
produces no structured line at all.

### The decision to make first

Two defensible shapes — pick one deliberately, record the reasoning:

1. **Inject a logger seam into `GateDeps`** (`onEvent?: (e) => void`), CLI and
   reverify each pass their own. Keeps `approval-gate.ts` dependency-free, matches
   the seam style already used for `teardown`/`bundleDir`, and is testable without a
   logger. Costs: every caller must remember to wire it (the same silent-default trap
   that produced the teardown gap — mitigate by making the absence observable).
2. **Import the logger directly.** Simpler, guaranteed to fire, but couples a leaf
   security module to the logging stack and makes it harder to unit-test.

Recommendation: **(1)**, with the caveat that the default must not be silently inert
— follow the `teardown` lesson from round 6 and make an unwired seam detectable.

### Acceptance criteria

- [ ] A `pause` event is emitted on the real pause path with the contract's fields:
      `{ requestId, runId, event, state, approverId?, durationMs, outcome }`.
- [ ] `record_write_ms` is emitted by the gate.
- [ ] `teardown_at_pause_ms` is emitted **or** explicitly recorded as unmeasurable
      with the reason (in the shipped caller teardown happens upstream — see D8).
- [ ] `requestId` on the pause line joins to the same run's other gate events.
- [ ] The declared `gateEvent` union has a producer for every member, asserted by a
      test that would fail if a member lost its producer.
- [ ] No secret material reaches the log line (`assertNoSecret` parity).

### Verification (real, no fakes)

TIER-1 live round, `tests/fleet/e2e/tier1-approval-gate.live.test.ts` on a real
exe.dev box. Assert the structured pause line appears in the real captured output
with a `requestId` matching the later `approve` line. Evidence JSON to
`_bmad-output/evidence/df3-e2e/`. Boxes only, zero model spend.

### Outcome — CLOSED 2026-08-28 (Session A)

#### The architecture decision: DIRECT LOGGER IMPORT, not a `GateDeps` seam

The doc recommended the seam. **Taken the other way, deliberately**, because the
premise the recommendation rested on — "a new dependency edge into a deliberately
narrow surface" — is factually wrong:

1. **The edge already exists.** `approval-gate.ts` imports
   `src/providers/run-record.ts` as a VALUE, and that module imports
   `src/swarmclaw/log.ts` at its line 41. Nothing was added to the graph.
2. **Every sibling does it directly.** `src/fleet/dispatch.ts:58`,
   `src/fleet/fanout.ts:35`, `src/fleet/fanout-primitive.ts:36`, and eleven
   modules under `src/providers/`.
3. **The testability objection is also false.** `log.ts` is a leaf with zero
   imports and ships `setLogSink` expressly "so tests can capture logs
   deterministically". Every assertion below reads through it.
4. **Decisive — the caveat in this doc was the right one.** A seam with an
   optional default is precisely the shape that produced the round-6 teardown
   gap. The defect being fixed IS a declared event with no producer; an
   inert-by-default seam rebuilds that exact class one layer up.

Cost: **zero public surface change.** `GateDeps` is untouched, so no caller has
to be taught anything and none can forget.

#### What shipped

- **`src/fleet/approval-gate.ts`** — `emitPause()` plus a `PauseCtx` threaded
  through. `requestApproval` is now a thin wrapper whose `finally` emits, over a
  new module-private `pauseRun()` holding the unchanged body. The `finally` is
  the point: all four outcomes AND every throw produce exactly one line, and no
  future return path can be added that silently produces none.
  - Split as a top-level callee rather than a nested closure **so the diff stays
    reviewable** — nesting would have re-indented ~250 unchanged lines.
- **Sub-timings.** `record_write_ms` is summed across the `store.set` calls this
  pause performs (register/rebind + promote), matching `run-record.ts`'s own
  meaning of that field. `teardown_at_pause_ms` is emitted **only when the seam
  actually ran**; see the honest gap below.
- **The join key, which did not exist.** AC4 asks the pause's `requestId` to join
  the run's other gate events. It could not: the pause is emitted inside a
  reverify process and every decision comes from a separate `fleet
  approve`/`reject` invocation, and `scripts/fleet.ts` correctly documents that
  its `requestId` is per-INVOCATION. So the root-cause fix was to give the
  streams a key that means the same thing on both sides — `dispatchRequestId`,
  the run's dispatch correlation id — and put it on **every** gate event
  (`gateEvent` in the CLI now carries it for approve/reject/timeout/refused from
  the record it already reads, and for attach from `attachToRun`'s result).
  `requestId` keeps its existing meaning on both sides; on the pause line the two
  coincide because a library call has no invocation of its own.
- **`src/providers/step-log.ts`** — `bounded`'s body (redact-then-cap) moved here
  as `boundedEcho`/`MAX_ECHO`, because `src/` cannot import from `scripts/` and
  the gate needed the identical rule for its id echo. `scripts/fleet.ts:bounded`
  is now a one-line delegation; **~30 call sites unchanged**. Second caller, so
  the shared callee is earned, not speculative.
- **`src/providers/run-record.ts`** — corrected the approval-schema comment that
  said `requestId` is "carried onto every gate event". It reads as a claim about
  the `requestId` field and is the opposite of what the emitters do; that
  contradiction is what made this decision take three passes to get right.

#### Verification

- `tests/fleet/approval-gate.test.ts` — new `D1 — the pause gate event` describe,
  7 cases through the real sink: the contract fields; **exactly one** line per
  call; `teardown_at_pause_ms` absent-not-zero without a seam and ≥ the real
  elapsed time with one; a throw still emitting `status:"error"` with the
  recoverable `state:"pausing"`; the INV-APPROVE-6 refusal reported rather than
  swallowed; each non-promoting outcome reporting the state the RECORD is in; the
  **whole field set pinned** (a proposal shaped like `sk-or-v1-…` provably cannot
  reach the line); and a record with no dispatch id logging `requestId:"unknown"`
  with the join key OMITTED rather than invented.
- `tests/fleet/gate-verbs.test.ts` — `gateEvent union ↔ producers`, the AC that a
  member can never again lose its producer. Reads the real source both ways
  (declared ⊆ produced and produced ⊆ declared), the same technique
  `verbs.test.ts` uses to bind `DOCUMENTED_EXIT_CODES` to `report()`'s real
  clamp. **Negative control run:** renaming the emitter's `event: "pause"` to
  `"pausex"` turned it red naming the event; source restored and re-verified.

#### Live evidence — TIER-1 PASS on a real exe.dev box

`_bmad-output/evidence/df3-e2e/2026-08-29-012459-t1-7-approval-gate.json`
(run id `e2e-t17-mtdp7223ixto`, 1 pass / 0 fail, 44 assertions, 22.5 s).

Real pause line, over a real box destroy + real key revoke:

```json
{"requestId":"3f2a1c7e-9b4d-4e2a-8f61-0c5d7a9b1e34","operation":"fleet.pause",
 "status":"ok","runId":"e2e-t17-mtdp7223ixto","event":"pause",
 "state":"awaiting-approval","outcome":"requested",
 "dispatchRequestId":"3f2a1c7e-9b4d-4e2a-8f61-0c5d7a9b1e34",
 "record_write_ms":5,"teardown_at_pause_ms":8454}
```

Real `approve` line, from a **separate `fleet approve` subprocess**:

```json
{"requestId":"187427dc-a50b-45d1-a81d-abfd27a32671","operation":"fleet.approve",
 "event":"approve","dispatchRequestId":"3f2a1c7e-9b4d-4e2a-8f61-0c5d7a9b1e34",
 "outcome":"decided","state":"approved","decision_wait_ms":2}
```

The join holds (`dispatchRequestId` identical) **and** the negative half is
asserted: the two invocations' own `requestId`s genuinely differ, which is why
the join needed its own key. `teardown_at_pause_ms: 8454` is a real 8.45 s
destroy-and-revoke, not a fixture. Cleanup: `final-ls: []`, `leaked: []`,
revoke `already-gone`, `ssh exe.dev ls` → `No VMs found` before and after.
Spend: 1 box for ~22 s, one key minted at a 5 000 µ$ cap and revoked by the
pause before any call could reference it ⇒ **$0 model spend**.

**The first live run FAILED, and it was a test defect** — logged here because the
skill's triage protocol says to classify before touching code. `gateLine()` read
the subprocess's **stdout**; `scripts/fleet.ts` routes its JSONL to **stderr** so
fd 1 carries only the verb's output. The evidence file for that run
(`…-012337-…json`) shows the correct line sitting in stderr on both the attach
and approve phases — provable from the artifact before any edit. Product side was
already green on that run. Fixed in the helper, with the reason and the artifact
cited in its comment.

#### HONEST GAP — `teardown_at_pause_ms` is unmeasurable on the shipped path

It is emitted here only because the **live test** passes a real teardown seam.
The one shipped production caller (`recordApprovalPort` at
`src/reverify/runner.ts:406`) passes none, because reverify is host-side
out-of-box and DF2.5 has already destroyed the box — so on that path there is
nothing at the gate to measure and the field is **absent, deliberately, rather
than `0`** (a zero is indistinguishable from an instantaneous teardown). This is
the D8 reconciliation, and D8 must decide whether the field belongs in the
contract at all or is documented as gate-owned-teardown-only. AC bullet 3 is
satisfied by the "explicitly recorded as unmeasurable with the reason" branch,
not by the emit.

---

## D2 — `--message -` is an undeclared sentinel

**Severity:** MED · **Session:** A · **Blocks:** DF3.5

### What is wrong

`fleet attach --message -` switches to a stdin read. The verb registry declares
`--message` as a plain `{name, required, valueType}` string with no mention of the
sentinel, so `fleet --help` and any DF3.5-generated skill present `-` as an ordinary
value — and the literal one-character message `-` is unsendable.

It cannot simply be dropped: the story specifies it verbatim
(`df3-4-approval-gate-attach-steering.md:138`, AC5) and the epic repeats it. It
cannot be declared either: `VerbFlag` is the closed shape DF3.5's skill-contract test
compares against, and `renderHelp` prints only those three fields.

### Acceptance criteria

- [ ] `VerbFlag` gains an optional descriptive field (e.g. `note?: string`) — an
      **additive** change that does not break the existing contract comparison.
- [ ] `renderHelp` surfaces it, so `fleet attach --help` tells an operator what `-` does.
- [ ] DF3.5's skill-contract test is updated in the same commit, or verified
      tolerant of the additive field. **Check this before writing code** — if the
      contract test is exact-match, coordinate with DF3.5's owner rather than
      unilaterally widening a shape another story compares against.
- [ ] The exact-flag-table snapshots added in round 6 (`tests/fleet/verbs.test.ts`)
      still pass or are updated deliberately.
- [ ] Decide and record: is the literal message `-` reachable at all (e.g. via
      `--message` from stdin), or is it accepted as unsendable? Either is fine;
      silence is not.

### Verification (real, no fakes)

Real subprocess: `bun scripts/fleet.ts attach --help` and assert the rendered text.
Real `--message -` invocation with a real pipe on stdin. No live box required —
this is a registry/help-surface change — but the CLI must be spawned for real, not
called in-process, for the help-rendering assertion.

### Outcome — CLOSED 2026-08-28 (Session A)

#### The external dependency: RESOLVED, no coordination needed

**DF3.5 is `ready-for-dev`, not implemented** (`sprint-status.yaml:168`). There is
no skill-contract test in the repo to be exact-match against — no
`.claude/skills/factory-*` exists, and the only consumers of `listVerbs()` are
`tests/fleet/cli.test.ts` and `tests/fleet/verbs.test.ts`, both DF3.1/DF3.4-owned.
So the additive widening is entirely within our ownership. **Checked before
writing code, as the AC required.**

What DF3.5's owner inherits: `VerbFlag` now has an optional `note?: string`. A
flag without one is byte-identical to before, so a three-column consumer is
unaffected; a generated skill that surfaces the note gets the `-` sentinel right.

#### The `-` question, decided and recorded: THE LITERAL `-` IS REACHABLE

The old registry comment claimed the sentinel "costs the one message that is
literally `-`". That is **wrong**, and the correction is now in the note itself
because an operator who believes a message is unsendable will not try the one
invocation that sends it. `scripts/fleet.ts` reads stdin when
`messageFlag === undefined || messageFlag === "-"` — so **omitting the flag reads
stdin too**, and `printf -- '-' | fleet attach <run-id> --driver <d>` sends the
one-character message `-`. (So does `--message -` with `-` on stdin.) The
sentinel costs nothing at all.

#### What shipped

- `src/fleet/verbs.ts` — `VerbFlag.note?: string`, documented as **not** a
  general description field: it exists for a value whose behaviour differs from
  its declared `valueType`, where `(string, optional)` would actively mislead.
  `--message` carries the only one.
- `renderHelp` appends ` — <note>` to that flag's **own line**. Deliberately not a
  second line: the flag block is parsed line-per-flag, so a wrapped note would
  become a phantom flag.

#### The round-6 snapshots, updated deliberately (all three)

They were exact-match and they went red, which is them working:

1. `verbs.test.ts` `each verb has exact shape` — pinned `["name","required",
   "valueType"]`. Now enumerates the closed set `{name, required, valueType,
   note?}` rather than loosening to "contains the three", so a `--token` flag or
   a free-text `description` column still cannot arrive unnoticed. Plus new
   guards: a note may not be empty (a dangling em dash) and may not contain a
   newline (the phantom-flag case).
2. `verbs.test.ts` `EXPECTED_FLAGS.attach` — the note is pinned **verbatim**,
   like every other column. It is what `--help` and any generated skill tell an
   operator, so silently rewording it is the same drift class as flipping
   `required`.
3. `verbs.test.ts` `expectFlagLines` — the rendered-line pairing now includes the
   note, so a note rendering under the wrong flag fails.

#### Verification — real subprocesses, real shell pipes

New `D2 —` describe in `tests/fleet/gate-verbs.test.ts`, 4 cases, all out of
process via `sh -c '… | exec bun scripts/fleet.ts …'` — a **genuine FIFO on fd 0**,
not `Bun.spawn({stdin:"pipe"})`'s socket, because the property is what an
operator's shell does:

- `fleet attach --help` → exit 0, note present on `--message`'s own line
  alongside `(string, optional)`.
- `--message -` with an **empty** pipe → exit 2 `attach requires a message`.
  If `-` were taken as the message it would be non-empty and pass; the refusal
  IS the proof that stdin was read instead.
- `--message -` with 4 001 piped chars → exit 2 naming `--message is 4001 chars`:
  positive evidence the piped bytes became the message.
- no flag, `printf -- '-'` piped → gets **past** the intake guard entirely and
  refuses on the record (exit 5, `run-not-attachable`, `state: "no-box"`), which
  is the proof that the literal `-` was accepted.

Note the `--driver fake` on those rows is inert to what they prove — every
refusal fires in the message-intake block, after the record read and before
`attachToRun` touches a driver. Stated in the test.

---

## D4 — `src/pr/repos.ts` repo allowlist is missing every path guard

**Severity:** HIGH (authorization) · **Session:** B · **Own branch, own PR**

### What is wrong

`resolveRepoEntry` (`src/pr/repos.ts:87-120`) decides which repositories the factory
will open a PR against. It checks **only the file's mode bits**:

```ts
const path = resolve(hostRoot, file);        // no containment check
st = statSync(path);                          // no isFile() check
if ((st.mode & 0o077) !== 0) refuse(...)      // no dir check, no ownership check
```

Compared to `src/fleet/approvers.ts` **after** round 6, it is missing all four
guards that were just added there — and it is missing the containing-directory check
that `approvers.ts` had even *before* round 6. Concretely:

- **No directory check at all.** A group- or world-writable containing directory lets
  an attacker replace the whole allowlist: `mv evil.json .factory/repos.json`. A
  0600 file inside a 0777 directory is not a control.
- **No ownership check.** Running as root, an allowlist owned by an unprivileged
  local uid is authoritative — root reads through 0600 regardless of owner.
- **No `isFile()` check.** A FIFO at the path reports mode 0600 and `readFileSync`
  blocks forever with no timeout.
- **No containment.** `resolve(hostRoot, file)` discards `hostRoot` when `file` is
  absolute and honours `../` when relative; nothing asserts the result is under
  `hostRoot`.

Impact: the allowlist decides the **push target**. Controlling it redirects the
factory's PRs to a repository the attacker owns.

### Acceptance criteria

Lift the round-6 pattern from `src/fleet/approvers.ts` — do not reinvent it, and
**consider extracting the shared guard** if the two implementations would otherwise
diverge again (this is exactly the "one guard in the shared callee" case; a third
allowlist would make it certain). Weigh that against coupling `src/pr/` to
`src/fleet/`; a small shared module under `src/providers/` may be the right home.

- [ ] Ancestor walk from the allowlist's directory up to and including `hostRoot`,
      refusing any group- or world-writable component, naming the offender.
- [ ] Ownership check on the file and every walked directory: self-owned or
      root-owned only, guarded by `process.getuid?.()` so a platform without it
      degrades to mode-only rather than throwing.
- [ ] `st.isFile()` asserted **before** the mode check (a FIFO reports 0600 as
      readily as a file, so mode-first still reaches `readFileSync` and blocks).
- [ ] Lexical containment: the resolved path must be under the resolved `hostRoot`.
- [ ] Every new arm is a **refusal** (fail-closed), carries `securityEvent: true`,
      and leaks no path the operator cannot see.
- [ ] Refusal codes/messages follow the existing `PrRefusalError("allowlist", …)`
      shape; downstream must not need a `switch` update.
- [ ] Check whether `resolveRepoEntry`'s callers surface the new refusals with a
      usable exit code and remediation.

### Verification (real, no fakes)

Real filesystem, real mode bits, real `mkdtemp` roots — no `fs` mocking:

- [ ] Real 0777 ancestor above a correct 0700 dir ⇒ refused, offender named.
- [ ] Real FIFO (`mkfifo`) at the allowlist path ⇒ refused, does **not** hang
      (assert with a real timeout).
- [ ] Real absolute-path and real `../` escapes ⇒ refused.
- [ ] Real BOM-prefixed and real schema-invalid files ⇒ the existing refusals still fire.
- [ ] Ownership: on a single-uid host the foreign-owner arm may be unprovable.
      Prove what is provable (self-owned accepted, root-owned accepted) and **state
      the gap explicitly** rather than faking a uid.
- [ ] Confirm the happy path still works end-to-end — a real `fleet`/PR-path
      invocation against a correctly-provisioned allowlist, so the hardening is not
      proven only by its refusals.

### Outcome — CLOSED 2026-08-29 (Session B) · commit `483a3e3` · **PR #169**

All four guards shipped. Every acceptance box above is ticked, and the one the
plan expected to be unprovable turned out to be provable.

#### The branch-topology discovery that shaped the fix

`src/pr/repos.ts` is **byte-identical on `dev` and on #150's branch**, so D4
branched cleanly off `dev` — the HIGH fix reaches `dev` without waiting for
#150, which is what "own branch, own PR" was for.

But **`src/fleet/approvers.ts` does not exist on `dev`.** It is DF3.4 and
arrives with #150. So the "second caller" that would earn the extraction is not
on D4's base branch. Three options were weighed and the operator chose (b):

- **(a)** guard inline in `repos.ts` — smallest diff, but knowingly ships the
  duplication D4 is *about*, and makes the later unify "extract + convert both".
- **(b) chosen** — extract to `src/providers/allowlist-path.ts`, `repos.ts`
  delegates, `approvers.ts` adopts later (**D10**). The guard exists exactly
  once from day one; the module carries one caller until #150 merges.
- **(c)** stack the PR on #150 — cleanest end state, but blocks a HIGH
  authorization fix behind a 59-file PR.

Because of (b), the shared module's logic was lifted **verbatim** from
round-6-hardened `approvers.ts` — including its refusal-code suffixes — so D10
is a behaviour-preserving delegation rather than a rewrite. Codes are
`${codePrefix}-path|-dir-mode|-owner|-unreadable|-mode`, which reproduces
`approver-allowlist-*` exactly; those are pinned by
`tests/fleet/approvers.test.ts` and must not move.

#### What shipped

- **`src/providers/allowlist-path.ts`** (new) — `readGuardedFile(hostRoot, file,
  spec)`. Home is `src/providers/` because it is neutral: `src/pr/` importing
  `src/fleet/`, or the reverse, is an edge between peers for a filesystem check
  belonging to neither. A caller supplies only prose (`codePrefix`, `label`,
  `defaultFile`, `contentHint`, `consequence`); **every threshold is fixed in
  the callee so no caller can weaken one.** The BOM strip both callers had
  independently moved here too.
- **`src/pr/repos.ts`** — delegates. `precondition` stays `"allowlist"` on every
  arm, so no downstream `switch` changed (`detect_changes`: **0 affected
  processes**). The specific guard rides in `failingChecks`, the field that
  already exists to name a failed check and is rendered by
  `renderRefusalComment`.
- The `isFile()`-before-mode ORDER is called out at the arm as load-bearing, so
  a future tidy-up cannot reorder it back into the fifo hang.

#### Verification — real filesystem, zero `fs` mocking

`tests/providers/allowlist-path.test.ts` (21 cases) + 3 caller-level cases in
`tests/pr/open-pr.test.ts`.

- Real 0777 ancestor above a correct 0700 dir ⇒ refused, **offender named**, and
  the innocent 0700 directory below it is asserted *not* named.
- Real `mkfifo` ⇒ refused, proven inside a real 10 s wall-clock deadline **in a
  subprocess**. A synchronous block cannot be raced in-process, and the exit
  code (0, not a signal) is what distinguishes "refused" from "hung and shot".
- Real absolute-path and real `../` escapes ⇒ refused. Plus a real
  **prefix-sibling** directory (`<root>-evil`), the containment off-by-one a
  `startsWith` without the trailing separator admits.
- Real BOM and schema-invalid files ⇒ existing refusals still fire.
- **Happy path**, plus a 0755/0750 deployment layout — the case that catches an
  over-tight guard. Every refusal test would still pass if the guard refused
  unconditionally.
- Caller level: a group-writable ancestor refuses the PR with
  `failingChecks: ["repo-allowlist-dir-mode"]`, a `chmod go-w` remediation, a
  logged `securityEvent`, and **no ref on the bare remote**; and the refusal is
  asserted **not** posted as an issue comment, so host paths and uids never
  reach GitHub.

#### The expected gap that was NOT a gap

The plan said the foreign-owner arm was "very likely unprovable on a single-uid
host". **It is provable, for real** — macOS ships service-account-owned
directories with clean write bits (`/var/db/lockdown`, uid 213, mode 0701), so
the refusal is exercised against a genuine third uid with no sudo and no
fabricated uid. Root-owned-accepted is proven against a real root-owned
directory and a real root-owned 0600 file. All three fixtures are discovered at
runtime and `skipIf`-guarded, so another host degrades to a stated skip rather
than a false green.

#### HONEST GAP — the file-level foreign-owner arm

No foreign-owned **regular file** at 0600 exists on this host, so that specific
arm is proven only through the **directory** arm. Both evaluate the identical
`ownedElsewhere` predicate, so the logic is covered; the file-level call site is
not independently exercised. Not faked, not silently skipped — written down.

---

## D7 — `submitDecision` throws a raw storage error on a nonexistent run

**Severity:** LOW · **Session:** B

### What is wrong

`submitDecision` reads via `readApproval` → `store.get`, which does **not** catch
ENOENT — unlike `readApprovalIfPresent`, used by `sweepExpired` and `awaitDecision`.
So `fleet approve --run <typo>` surfaces
`unreadable run record run-typo.json: ENOENT` rather than the classified
`{outcome:"not-decidable", state:"absent"}` an *existing* run with no approval
namespace gets. A typo'd run id is the most ordinary operator error on this verb.

Round 6 **pinned the current behaviour** in a test rather than changing it (the
fixer correctly refused to change source from a test-hardening brief). Two readers
in one module with deliberately different ENOENT postures is at minimum worth a
comment; the asymmetry looks accidental.

### Acceptance criteria

- [ ] Decide deliberately: classify the missing run as a refusal, **or** document
      why the throw is correct here and the asymmetry intentional.
- [ ] If classified: the CLI maps it to the documented no-record exit code (4) with
      a remediation naming the run id, and the round-6 test pinning the throw is
      updated in the same commit.
- [ ] The lock taken on the way in is still released either way (round 6 pinned this
      — keep it pinned).

### Verification (real, no fakes)

Real store on a real temp dir with a genuinely absent record; real `bun scripts/fleet.ts approve`
subprocess asserting the real exit code and the real stderr text.

### Outcome — CLOSED 2026-08-29 (Session B) · lands on PR #150

**Decision: the throw is CORRECT and the asymmetry is INTENTIONAL. No behaviour
changed.** Taken on evidence, not on reading — the premise this item rests on is
false.

#### The premise was wrong, and a real subprocess is what settled it

The item states `fleet approve --run <typo>` surfaces
`unreadable run record run-typo.json: ENOENT`. **It does not.** A real
invocation, real 0600 allowlist, real token on a real pipe:

```console
$ printf %s "$TOKEN" | bun scripts/fleet.ts approve run-typo --approver alice --dir <store>
{"code":"run-not-found","message":"no run record for run-typo",
 "remediation":"check the id (fleet status) — nothing was mutated"}
EXIT=4
```

Exit **4**, the documented no-record code, with a remediation naming the id.
The verb block calls `assertRunExists` **before** `submitDecision` is reached,
so the library throw is a backstop for a precondition the shipped caller already
guarantees. Round 6 added that guard; this item was filed from reading
`submitDecision` in isolation.

#### Why classifying it would have made things WORSE

`not-decidable` maps to exit **5** in the CLI. 5 means "a guard fired before
anything was mutated"; 4 means "that run does not exist" — a distinction
`scripts/fleet.ts` documents explicitly. Loosening `readApproval` would answer
the most ordinary operator error on this verb, a typo, with the wrong code.

The real reason the two readers differ is the one nobody wrote down: the
tolerant reader exists for the **pollers**. `sweepExpired` and `awaitDecision`
observe a record repeatedly over time, where absence is an ordinary observation.
`submitDecision` performs one compare-and-set against a record the caller named,
where absence is a broken precondition.

#### What shipped

- **`src/fleet/approval-gate.ts`** — the reasoning above now sits on
  `readApproval` and `readApprovalIfPresent`, with the real exit-4 envelope
  quoted, so the next reader does not re-open this. **Comment-only; zero
  non-comment lines changed** in either function.
- **`tests/fleet/gate-verbs.test.ts`** — the gap round 6 actually left. It
  pinned the *library* throw; **nothing pinned what an operator gets.** A real
  `fleet approve` subprocess against a genuinely absent run now asserts exit 4,
  `code: "run-not-found"`, the id in the message, `fleet status` in the
  remediation, that `ENOENT`/`unreadable run record` never appear, and that
  neither a record nor a lock is left behind.
  - **Negative control run:** deleting `assertRunExists(probe, runIdArg)` from
    the approve block turns it red — the absent run lands on exit **2**, a
    usage refusal telling an operator to check flags that were fine. Source
    restored and re-verified byte-identical.
  - The test enrols a REAL approver with a REAL token on a REAL 0600 allowlist,
    because the CLI defers reporting a missing run until after authentication on
    purpose (so exit codes cannot enumerate run ids). With a bad token the verb
    correctly answers 5 and would prove nothing.
  - `hashToken` is used for the fixture rather than a hand-rolled sha256 — it is
    exported precisely so a fixture and the check cannot drift on the formula.
- The round-6 pin in `tests/fleet/approval-gate.test.ts` keeps asserting the
  throw AND the lock release, with a comment pointing at the CLI-level proof.

---

## D5 — `FleetError.exitCode` cannot express exit 6

**Severity:** LOW · **Session:** C

### What is wrong

`FleetError.exitCode` is typed `1|2|3|4|5` (`src/fleet/dispatch.ts:207`) while
`report()` accepts and documents 1–6. That mismatch is **why** round 6 had to express
the attach append failure as a returned result rather than a typed throw — the
library layer literally cannot throw an exit-6 refusal.

### Acceptance criteria

- [ ] Widen to `1|2|3|4|5|6` — at **BOTH** sites. Session B found a second one
      the original write-up missed: `src/fleet/dispatch.ts:207` (the `FleetError`
      constructor) **and `src/fleet/dispatch.ts:918`** (the local `refuse` helper
      inside the same module, which declares the identical union independently).
      `grep -rn "1 | 2 | 3 | 4 | 5" src/ scripts/ tests/` returns exactly those
      two and is the check that they both moved. Widening only :207 leaves the
      helper unable to express 6 and the finding half-open.
- [ ] Audit every `FleetError` construction and every `report()` arm for consistency
      after widening — this is a one-token change with a wide read surface, so the
      value is in the audit, not the edit.
- [ ] Decide whether `attachToRun`'s `send-failed` result should now become a typed
      throw. **Do not change it reflexively** — the result shape carries a `reason`
      the remediation branches on, which a bare exit code would lose.

### Verification (real, no fakes)

Real subprocess invocations asserting real exit codes for each of 1–6 on the paths
that produce them. Round 6 left `ONLY_REACHABLE_ELSEWHERE` in
`tests/fleet/verbs.test.ts` binding each unprobed code to a named behavioural case —
read it first; the goal is to shrink it, not to duplicate it.

### Outcome — CLOSED 2026-08-29 (Session C) · lands on PR #150

**Decision: DO NOT WIDEN. The union's narrowness is the guard, not the bug.** The
finding is real; its prescribed remedy was wrong. Same shape as Session B's
CodeRabbit lock finding, and taken on evidence rather than on reading — as the
operator explicitly confirmed before any code was written, because this deviates
from a ticked acceptance box rather than from a recommendation.

#### What the audit found, and why it inverted the AC

The AC assumed `FleetError` *should* be able to carry 6. Three facts say otherwise:

1. **Nothing wants 6.** All 35 `new FleetError(...)` constructions across
   `rank.ts`, `dispatch.ts`, `fleet-lock.ts`, `status.ts`, `fanout-primitive.ts`
   and `scripts/fleet.ts` pass a literal in `{1,2,4,5}` (3 arrives via
   `refuse(3, …)`). **Zero pass 6.**
2. **6 is produced somewhere else entirely.** All 9 exit-6 sites are
   `return finish(…, 6)` in `scripts/fleet.ts` — every one on a success path,
   not one a throw.
3. **The decisive one: exit 6 needs TWO outputs.** `scripts/fleet.ts`'s header
   defines 6 as "the verb's own work LANDED but the invocation could not finish
   it or report it". So every real 6 site emits the completion line on stdout
   through `reportCompletion` — the *only* record that the work landed — **and**
   a diagnostic on stderr naming the leftover. A thrown `FleetError` routes
   through `report()`, which renders the error envelope and nothing else. **A
   thrown 6 would destroy the landed-work record that exit 6 exists to
   preserve.** It is self-contradictory within one frame besides: a function
   that throws has by definition not completed the work a 6 asserts DID complete.

`throw new FleetError(6, …)` is refused by `tsc` today. Widening deletes that
guard and makes the *obvious* way to signal 6 silently wrong. The narrowing is
also the house pattern, not an oversight: `fanout-primitive.ts:135` declares
`2 | 5`, `roster/validate.ts:154` declares `0 | 1 | 2`.

So the actual defect D5 names is a **missing rationale on a load-bearing type** —
nothing in the source said the narrowness was deliberate, and `report()`'s `<= 6`
reads like a contradiction, which is why it got filed. That is what shipped.

#### What shipped — comment-only in source, plus a drift alarm

- **`src/fleet/dispatch.ts`** — the reasoning above on the `FleetError` class,
  and on `refuse`'s independently-declared union (the second site Session B
  found missing from the original write-up), noting that `refuse` is narrower in
  KIND as well as range: everything it builds is logged `phase: "refused"`,
  `status: "error"`, so a 6 there would record a refusal of work that completed.
- **`scripts/fleet.ts`** — why `report()`'s ceiling stays 6 though the type stops
  at 5: `e` arrives as `unknown`, so the bound is a RUNTIME check that must still
  refuse a 6 built by a JS caller or through a cast. Lowering it to match would
  trade a real defence for cosmetic symmetry.
- **Both edits are comment-only, proven mechanically**: zero non-comment added
  lines and zero deleted lines across both files (48 insertions, all comments).
- **`tests/fleet/verbs.test.ts`** — a new drift alarm beside the existing
  `DOCUMENTED_EXIT_CODES` clamp test. Pins both unions as an exact array (so a
  THIRD refusal helper with its own copy also reds), and scans every `.ts` under
  `src/` and `scripts/` for a `new FleetError(6`. The second half is not
  redundant with `tsc`: a widening alone is inert until something throws a 6, and
  `new FleetError(6 as 1, …)` reaches a 6 past the type without touching either
  declaration.

#### Verification — real subprocesses, and the two-output contrast

`tests/fleet/gate-verbs.test.ts`, new `D5 —` describe, 4 cases out of process.
The proof is a real exit-6 site, reached with `--driver fake` resolved from argv
through the real `resolveDriver`:

```console
$ bun scripts/fleet.ts teardown qds-… --driver fake --dir <store>
EXIT=6
stdout: torn down: qds-…            ← the work LANDED
stderr: {"code":"key-unattributable"} ← the leftover
```

Both halves, one invocation. The contrast is the other half of the proof: real
refusals (exit 2 usage, exit 4 run-not-found) print **0 bytes** on stdout — and a
refusal is exactly what a thrown `FleetError` produces. Plus the control, without
which the exit-6 assertion is vacuous: the same teardown with nothing left over
is exit **0** on the same completion line.

**What this adds over the in-process probes already in `verbs.test.ts`** (which
assert code 6 with `torn down:` and `key-unattributable`): those call `run()` and
assert its RETURN VALUE. These assert the real PROCESS STATUS, which is all an
operator and their `|| alert` ever see. Every other real-subprocess exit code in
that file is a refusal (2, 4, 5); **6 — the code D5 is about — had none.**

**Four negative controls, each run red then restored:** widening the class union
(`Expected "1|2|3|4|5", Received "1|2|3|4|5|6"`), widening `refuse`'s union,
`new FleetError(6 as 1, …)` (caught by the source scan, naming the file), and
deleting the teardown exit-6 fold (`Expected: 6, Received: 0`).

#### `ONLY_REACHABLE_ELSEWHERE` was NOT shrunk, and that is deliberate

The AC asked to shrink it. It cannot be shrunk honestly, and faking one would be
worse than leaving it:

- **teardown's exit 6 is not in it at all** — already probed directly at
  `verbs.test.ts:412` with both stdout and stderr asserted. Nothing to remove.
- The remaining exit-6 excuses (fanout, rank, approve, reject, attach) exist
  because `verbs.test.ts`'s shared `invoke()` is **in-process** and cannot inject
  a throwing stdout sink. Removing an excuse only helps if the code becomes
  probeable **in that file's own in-process table**, which it does not. Making
  them subprocess-probeable means restructuring the probe table for every verb —
  far beyond a LOW item, and it would trade a working binding for churn.
- Each excuse is already bound to a real named test that the checker asserts
  still exists, so the coverage is real either way.

**A genuinely new probe technique was found and is recorded for later use:** a
real EPIPE (`bun scripts/fleet.ts --help | (exec true)` → `PIPESTATUS[0]=6`,
3 runs of 3) reaches exit 6 through `failOnEpipe` without any throwing-sink rig.
That is the lever a future session would pull to make those five excuses
probeable out of process, if it ever restructures the table.

#### `attachToRun`'s `send-failed` was NOT converted to a throw

As the AC warned. The audit gives the reason independently: all four
`attach-not-acked` reasons map to the same exit 6, and what differs is the
REMEDIATION the CLI branches on via `res.reason`. A bare exit code loses it — and
the result shape is *correct* here for the same structural reason the rest of
this item rests on: the message may already be in the box, so the work may have
landed, and a throw asserts it did not.

---

## D6 — `listedKeyHashes()` discards `truncated`

**Severity:** MED (test soundness on a real-money path) · **Session:** C

### What is wrong

`listedKeyHashes()` in `tests/fleet/e2e/live-harness.ts` calls
`keyApi.listAllKeys(10)`. The `10` is **pages**, not entries, and `KeyApi`'s
interface documents the contract explicitly — it "either follows pages to exhaustion
or reports `truncated: true`; absence is never inferred from a partial page"
(`src/providers/credentials.ts:104-106`). `listedKeyHashes` **discards `truncated`**.

So on an account with more than 10 pages of keys, both the leak baseline and the
delta are computed over a **partial population**, and a leaked key can hide in the
unlisted remainder. Round 6 made the leak delta assert (it previously only
serialized) — which means the check now *looks* authoritative while still being
unsound at scale.

### Acceptance criteria

- [ ] `listedKeyHashes()` propagates `truncated`.
- [ ] A truncated listing **fails the test loudly** rather than silently
      under-reporting. A key-leak check that cannot see the whole population must
      refuse to render a verdict — silence here means "we did not look", which is
      the opposite of what an empty `leaked` array claims.
- [ ] The failure message tells the operator exactly what to do (raise the page
      bound / prune the account).
- [ ] Audit for the same discard elsewhere: `grep -rn "listAllKeys" tests/ src/`.

### Verification (real, no fakes)

Real OpenRouter API against the real account. If the account has fewer than 10 pages
(likely), prove the guard by lowering the bound in the test — `listAllKeys(1)`
against an account with more than one page produces a **real** truncated response
from the real API, and the assertion must fail loudly. That is a real proof, not a
stubbed one. Then restore the production bound and confirm green. Fold into a
TIER-1 round; zero model spend.

### Outcome — CLOSED 2026-08-29 (Session C) · lands on PR #150

Fixed at the root, and proven against the real API. The finding was accurate as
written — unlike D5's and D7's, its premise held up exactly.

#### The audit first: PRODUCTION was already sound, the harness was the only reader that wasn't

`grep -rn "listAllKeys" tests/ src/` — every production caller honours the
contract, which is what makes this a test-soundness item rather than a live
credential leak:

| Site | Posture |
|------|---------|
| `credentials.ts:501` `verifyHash` | throws `list-unverified` on `truncated` (AC4) |
| `reaper.ts:387` | `if (res.truncated) throw` before classifying |
| `credentials.ts:258` orphan sweep | guarded by `if (!truncated)` |
| `credentials.ts:784` `getKeyEntry` | propagates `truncated` to its caller |
| **`live-harness.ts:306`** | **discarded it** |

The unit suites (`teardown/credentials/reaper.test.ts`) also destructure only
`.entries`, but they drive `FakeKeyApi` with ≤4 keys at `maxPages: 20`, so the
fake cannot truncate — sound by construction, and `fake-key-api.ts:47` has an
explicit truncating mode for the tests that want one. Left alone deliberately
rather than churned.

#### Why the direction of the unsoundness made this urgent

Every leak assertion in `tests/fleet/e2e/` is `not.toContain(hash)` — which a
PARTIAL list satisfies **spuriously**, because the hash may sit in the pages
nobody read. An empty `leaked` array would mean "we did not look" while claiming
"nothing leaked". Round 6 made that delta assert, which left it looking
authoritative while still unsound at scale.

#### What shipped — one throw in the shared callee, zero call-site churn

`tests/fleet/e2e/live-harness.ts`:

- `listedKeyHashes()` now destructures `truncated` and **throws** on it. Throwing
  rather than returning `{hashes, truncated}` is the root-cause shape: a returned
  flag puts the guard back in all **13 call sites across 9 live suites** and
  rebuilds exactly the inert-by-default trap D1 was filed for, where the one
  caller who forgets is the one that reports a false green. It is also the
  posture production already takes on this same fact.
- The bound is now **`MAX_VERIFY_PAGES`** (20), imported from
  `src/providers/credentials.ts`, not the local literal `10`. The harness
  verifies the same population the factory does, and a second magic number is
  how the test's ceiling ended up quietly lower than production's.
- The refusal names both real remedies (raise `MAX_VERIFY_PAGES`, or prune the
  account) and the exact `curl` to see the page count by hand.
- `maxPages` is a parameter ONLY so the guard is provable against the real API.
  It cannot weaken the check: `listAllKeys` proves exhaustion only by reaching an
  EMPTY page, so a LOWER bound can only make it throw — the fail-closed
  direction — and never return a partial set.

**All 13 call sites are untouched**: the parameter has a default, so
`detect_changes` reports `0 affected processes` for the change.

#### Live verification — TIER-1, real OpenRouter API, ZERO boxes and ZERO spend

`tests/fleet/e2e/tier1-teardown.live.test.ts`, new `D6` case. Evidence:
`_bmad-output/evidence/df3-e2e/2026-08-29-195647-t1-6-key-list-truncation.json`
(1 pass / 0 fail) — the run on the FINAL shipped source, after the biome rewrite
of the refusal message. Three earlier artifacts with the same stem exist from the
first green, the negative control and its restore; the NC one is stamped
`"outcome": "FAIL"` because its tree was deliberately sabotaged, and only the
`195647` file describes the code that ships.

```json
{ "phase": "full-listing",      "ok": true, "bound": 20, "count": 7 }
{ "phase": "truncated-listing", "bound": 1, "threw": true,
  "message": "key-list-truncated: the provider key list did not enumerate within
              a 1-page budget, … MUST NOT report a leak verdict. …" }
```

**Real, not stubbed.** `listAllKeys` proves exhaustion only by reaching an empty
page, so a bound of 1 cannot prove it for any account holding at least one key —
the provider genuinely returns a truncated walk and the guard genuinely throws on
it. A stubbed `truncated: true` would prove the assertion fires, never that the
API produces the condition. The mechanism differs slightly from what the AC
predicted (it is the walk-to-empty-page rule, not an account with >1 page of
keys), which makes it **deterministic** rather than dependent on account size.

**Negative control, run live:** replacing the guard with the old discard turned
the case red (`Received: undefined` — nothing thrown); restored and re-verified
green. The stated precondition (`full.size > 0`) is asserted, not assumed, so an
empty account fails loudly instead of leaving the guard silently unprovable.

Zero boxes provisioned, zero keys minted, zero model calls — two real GETs
against `/keys`. No spend gate was required (that is TIER ≥ 2).

#### Session A's live evidence: the ceiling was real, and the greens were SOUND

The handoff asked for this explicitly. Measured against the real account:
**7 keys, `truncated: false` at a 20-page budget** — and it was already
`truncated: false` at the old bound of 10, since 7 entries fit in page 0 and page
1 comes back empty. So every `leaked: []` in `_bmad-output/evidence/df3-e2e/`,
including Session A's TIER-1 round, was computed over the **whole** population
and is sound. The defect was latent, not active: it would have started lying only
once the account grew past the bound, silently and with no signal — which is
precisely why it was worth closing before that happened rather than after.

---

## D8 — AC1(b)'s teardown ordering is vacuous in the only shipped caller

**Severity:** spec reconciliation · **Session:** D

### What is wrong — and what is NOT wrong

Round 6's auditor filed this as a BLOCKER: teardown was unwired, so a run could be
promoted to `awaiting-approval` with a live box and a live key. The fail-closed guard
shipped in `9f09a87` (refuse to promote an open record owning a `vmName` when no
teardown seam is provided) closes the security hole.

**Subsequent verification changed the picture.** `src/reverify/runner.ts:2-5` states
reverify is "host-side out-of-box re-verification … the first host-side step **after**
DF2.5 fetches a run's commits". DF2.5 is teardown. So in the only shipped caller the
box is already gone and `closedAt` is set by the time the gate is reached — the new
guard never fires there, and the pre-existing behaviour was **safe, not broken**.

The residue is a **spec-vs-reality mismatch**, not a vulnerability:

- AC1(b) and INV-APPROVE-6 describe a three-step order (`register pausing` → real
  teardown → promote) in which the gate owns teardown. In practice teardown happens
  upstream in DF2.5 and the gate is called afterwards, so the ordering the AC
  specifies is **vacuous** on the shipped path.
- `src/reverify/approval.ts`'s comment says "the fleet verb passes the real one" —
  referring to a verb that does not exist. There is no CLI pause path.
- Consequently `teardown_at_pause_ms` (D1) has nothing to measure on that path.

### Acceptance criteria

This is a decision, not a patch. Do not write code until it is made.

- [ ] Establish empirically whether ANY caller reaches the gate with a live box.
      Trace every path to `requestApproval` and record the record state at each.
- [ ] Then choose and record:
      **(a)** Amend AC1(b)/INV-APPROVE-6 to state that teardown is DF2.5's and the
      gate's obligation is to REFUSE a run that still owns one (what now ships) — the
      honest reading if no caller ever holds a box; or
      **(b)** Wire a real teardown for a caller that genuinely needs it, if one exists.
- [ ] Either way, correct the stale "the fleet verb passes the real one" comment.
- [ ] Reconcile D1's `teardown_at_pause_ms` with the outcome.
- [ ] Keep the fail-closed guard regardless. It costs nothing on the shipped path
      and is the only thing standing between a future caller and the original hole.

### Verification (real, no fakes)

A real end-to-end run: real box → real dispatch → real DF2.5 teardown → real
host-side reverify → real gate. Assert the record's `vmName`/`closedAt`/`keyHash` at
the moment `requestApproval` is entered. This is the only way to settle (a) vs (b)
factually rather than by reading comments. TIER-2 (real model spend) — **spend gate
applies, get an explicit go.**

### Outcome — CLOSED 2026-08-29 (Session D) · **option (a)** · lands on PR #150

#### The empirical question, answered exhaustively before anything was written

Every non-test reference to `requestApproval` in `src/` and `scripts/`:

```console
$ grep -rn "requestApproval" src/ scripts/ --include=*.ts | grep -v "^tests/"
src/reverify/runner.ts:413:    approval = await port.requestApproval(runId, {   ← THE ONLY CALL
src/reverify/approval.ts:75:    requestApproval: (runId, req) => gateRequestApproval(...)  ← the adapter
src/fleet/approval-gate.ts:671:export async function requestApproval(...)      ← the definition
…all remaining hits are comments.
```

**One caller.** `src/reverify/runner.ts:413`, through
`recordApprovalPort(deps.store ?? new RunRecordStore({dir: runsDir}))` — no
`opts`, therefore no `teardown` seam and no `bundleDir`. And reverify is
host-side out-of-box re-verification that runs AFTER DF2.5. So **no shipped
caller reaches the gate with a live box**, and AC1(b)'s three-step ordering is
vacuous on the shipped path.

#### The decision: (a)

AC1(b) and INV-APPROVE-6 were amended in
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md`
(both sites carry an `AMENDED, D8 (Session D)` block). The gate's obligation is
stated as what it now enforces — REFUSE to promote an open record that still
owns a `vmName` when no teardown seam was supplied — while the (b) step remains
specified for a future caller that genuinely holds a box. **The fail-closed guard
is kept**, exactly as this item's last acceptance box requires: it costs nothing
on the shipped path and is the only thing between a future caller and the
original hole.

#### The stale comment was ALREADY gone

The item asks to correct `src/reverify/approval.ts`'s "the fleet verb passes the
real one". `grep -rn "the fleet verb passes the real one" src/ scripts/ tests/`
returns nothing — Session A's D1 work replaced that block with an accurate one
(`approval.ts:59-71`), which now explains that the default port is "safe by
refusal, not by assumption". Verified rather than assumed, and recorded as
already-done rather than re-done.

#### `teardown_at_pause_ms` reconciled (the item's fourth box)

D1's emit is CORRECT as shipped and needed no change: the field is present only
when `deps.teardown` actually ran, and is ABSENT — never `0` — otherwise. D8's
finding is what makes that absence meaningful rather than an omission, and the
live test below asserts the absence directly. Session A's "HONEST GAP —
`teardown_at_pause_ms` is unmeasurable on the shipped path" is hereby resolved:
it is not unmeasurable, it is **correctly not emitted**, and that is now pinned.

#### Live verification — TIER-1, ZERO MODEL SPEND

**Spend gate:** the operator authorised "TIER-1 first, escalate only if needed".
It was not needed. D8's chain does not require a model call: the box, the
teardown and the gate are all real without one, and the `reverify()` verdict
pipeline is DF5.1's subject rather than D8's question. Worst case incurred:
**one exe.dev box for the length of one teardown, zero model spend**, key minted
at a 5000 µ$ cap and never used for a chat call.

`tests/fleet/e2e/tier1-approval-gate.live.test.ts`, new case: *"D8: the shipped
port (no teardown seam) reaches the gate AFTER DF2.5 — record closed, and NO
teardown at the gate"*. Real box → real `fleet teardown` subprocess (full DF2.5
chain: spend capture → artifacts → harvest → revoke → verify → destroy → close +
priced ledger row) → the record read AT GATE ENTRY → the gate entered through
`recordApprovalPort(store)`, constructed byte-identically to `runner.ts`'s.

Asserted: `closedAt` defined, `vmName` still NAMED (which is why the guard must
test `closedAt` and not merely `vmName`), `keyHash` present, the box absent from
a real `driver.list()`, the key absent from a real `listedKeyHashes()`, the pause
promoting to `awaiting-approval`, and — the assertion the item turns on —
`Object.hasOwn(pauseEvent, "teardown_at_pause_ms") === false`.

**RESULT: PASS**, 2026-08-29T21:57:42Z, run `e2e-d8-mtex8hr2atdm`, SHA `3d70c38`.
Evidence: `_bmad-output/evidence/df3-e2e/2026-08-29-215742-d8-shipped-port-gate.json`

```jsonc
// the record AT GATE ENTRY — D8's literal question, answered by a real record
{ "phase": "record-at-gate-entry",
  "vmName": "e2e-d8-mtex8hr2atdm",
  "closedAt": "2026-08-29T21:57:38.248Z",     // ← the box was ALREADY gone
  "keyHash": "5e24f5a018f3b6d49c1540d27393d28761f7aa091f35eddc6eef10384c634d41" }

{ "phase": "gate", "outcome": "requested" }   // promoted; the guard did not fire

// the pause event — note what is NOT here
{ "operation": "fleet.pause", "event": "pause", "status": "ok",
  "state": "awaiting-approval", "outcome": "requested",
  "record_write_ms": 3 }                       // ← and NO teardown_at_pause_ms
```

The real DF2.5 chain ran first and is in the same evidence file: harvest `none`
(no repo in this box by design), `credential.revoke` 734 ms, `credential.verify`
395 ms, `provider.destroy` 2912 ms, `run-record.close`, and a priced ledger row
of **661 µ$ box-hours**. `fleet teardown` exit **0** in 7550 ms.

**Round hygiene, asserted not assumed:** `final-ls` stray `e2e-*`/`qds-*` boxes
**0**; account key count **7** with D8's hash **absent** (the same 7 Session C
recorded, so the account has not grown and `MAX_VERIFY_PAGES` still has
headroom); `.sandbox/fleet.lock` absent. Gotcha #4 fired once BEFORE the round —
a leaked lock from the full-suite run, holder pid 56429 verified dead with `ps`
before removal.

**Spend: ZERO model spend.** One box for ~90 s (661 µ$ of box-hours), one key
minted at a 5000 µ$ cap and revoked without ever being used for a chat call.

**HONEST GAP, stated rather than glossed.** `reverify()`'s own verdict pipeline
is not executed in this leg, so it does not prove reverify produces a green
report; it proves the ORDERING claim, which is what D8 asks. Driving a green
verdict live needs a real verify plan against harvested commits, which is DF5.1's
surface and a materially larger build. Escalating to TIER-2 would NOT have closed
this gap — the blocker is the verify plan, not model spend — which is why the
escalation the operator pre-authorised was not requested.

---

## D9 — `hashToken` is single-round sha256 with no work factor

**Severity:** LOW (given current threat model) · **Session:** D

### What is wrong

`hashToken` computes `sha256(salt + ":" + token)` — one round, no work factor. The
salt prevents cross-entry reuse and rainbow tables but adds no cost. If the allowlist
is captured (host backup, snapshot, a committed `.factory/`), an operator-chosen
passphrase is offline-crackable at billions of guesses per second.

Currently LOW because tokens are documented as high-entropy and machine-minted —
but **nothing in the code enforces or verifies that**, which is the actual gap.

### Acceptance criteria

Ordered by cost. (1) may be sufficient; do not do (2) reflexively.

- [ ] **(1) Enforce the assumption instead of documenting it.** Require a minimum
      entropy/length at enrolment so a passphrase cannot be enrolled. Cheap, no
      migration, removes the precondition the LOW rating depends on.
- [ ] **(2) If a work factor is still wanted:** scrypt/argon2 with a versioned entry
      shape (`{v, salt, hash}`), a read path accepting both versions, and a documented
      rehash-on-next-use path. Changing the formula invalidates **every enrolled
      allowlist** — this needs a migration story, an operator-facing note, and a
      rollback plan, not a review patch.
- [ ] Whichever is chosen: `constantTimeEqual`'s no-length-leak property (round 6
      found it asserted only for boolean equality) must remain genuinely tested.

### Verification (real, no fakes)

Real allowlist files on a real filesystem: enrol, authenticate, and — if (2) — prove
a v1 entry still authenticates after the upgrade and is rehashed to v2 on next use.
Real subprocess `fleet approve` end-to-end with a real token over real stdin.

### Outcome — CLOSED 2026-08-29 (Session D) · **(1) AND (2), with (1) rebuilt** · lands on PR #150

#### The stated AC could not be implemented as written, and that is the finding

> **(1) Enforce the assumption instead of documenting it.** Require a minimum
> entropy/length at enrolment so a passphrase cannot be enrolled. Cheap, no
> migration…

**There was no enrolment.** Nothing in `src/` or `scripts/` ever wrote
`.factory/approvers.json` — `grep -rn "approvers.json" scripts/ src/` finds one
hit and it is a remediation string. The allowlist was hand-authored JSON, and
`hashToken`'s only production call site was verification. So the assumption was
unenforceable not because the check was missing but because the *place to put it*
did not exist.

**And a length check would not have been the property anyway.** Length is not
entropy: `correct horse battery staple` passes any minimum a human would write
and is still offline-guessable. Entropy cannot be measured from a string handed
to you; it can only be GUARANTEED by generating one. This is the fourth instance
of the ruling Session D was told to expect — a deferred item's stated remedy can
be wrong even when its finding is right (D7's premise was false, D5's diagnosis
was inverted, D9's remedy was unbuildable). **The operator was asked and chose
the long-term-correct route explicitly**, before any code was written.

#### What shipped — the writer AND the work factor

**(2), the work factor.** Entries are now a union:

```ts
// legacy, still accepted: { salt, hash }                       ← sha256(salt ":" token)
// v2:  { v: 2, salt, hash, N, r, p }                           ← scrypt
```

- `scryptToken(salt, token, params)` — `scryptSync`, `KEY_LEN` 32, defaults
  `SCRYPT_PARAMS = {N: 2^15, r: 8, p: 1}` (~100 ms, ~32 MiB). The budget is set
  by what this path IS: one verification per `fleet approve`, invoked by a human.
  100 ms is invisible there and is four to five orders of magnitude dearer per
  guess than one sha256 round.
- **The parameters are DATA, stored per entry, not constants read at verify
  time.** That is the whole point of versioning: raising the cost later must not
  invalidate everything enrolled at the old cost, so verification recomputes with
  the entry's own `N/r/p`. A build hard-coding today's `N` silently fails to
  verify every entry written by tomorrow's.
- The schema bounds them on BOTH sides. A floor (`N ≥ 2^12`, power of two)
  because `{v:2, N:2}` is a v2 label over no work factor; a ceiling (`N ≤ 2^20`,
  `r ≤ 32`, `p ≤ 16`) because `scryptSync` allocates ~`128·N·r` — an entry
  claiming `N: 2^30` is a 137 GB allocation on the verify path, i.e. a
  denial of service written into a config file. Both are `-invalid` schema
  refusals BEFORE any scrypt call.
- `salt` goes in as scrypt's own salt argument, so the separator hazard
  `hashToken` documents cannot arise at all — the two are distinct parameters,
  not concatenated text.

**(1) rebuilt as the thing it should have been: `mintApproverToken()` +
`enrolApprover()` + `fleet enrol`.** The factory now MINTS the credential —
32 bytes from `randomBytes`, base64url — so high entropy is guaranteed by
construction rather than asserted in a comment. The plaintext is returned,
printed once, and never stored or logged.

`enrolApprover` reads through the SAME `readGuardedFile` it writes through (an
enrolment that skipped the ancestor walk would launder an attacker's entries
through a trusted verb), distinguishes "file absent, first enrolment on this
host" by STATTING the resolved path rather than trusting the refusal code
(`-unreadable` also covers EACCES/EIO, and treating those as "start fresh" would
replace an allowlist this process could not read), refuses an unparseable file
rather than overwriting it (it may hold entries this verb cannot see), and writes
via `openSync(tmp, "wx", 0o600)` + `renameSync` — atomic, and 0600 from birth
because `writeFileSync`'s `mode` is masked by umask and can land 0644.

#### There is NO legacy path, because there was never anything to be compatible with

**This reverses a decision made earlier in this same session, on evidence that
its premise was false.** The first cut of D9 shipped an accept-and-warn path for
v1 entries, argued as "refusing them outright would invalidate every allowlist
already on disk at upgrade time, turning a hardening change into an outage". The
operator challenged the follow-up plan, and the premise was checked instead of
defended:

```console
$ git cat-file -e origin/dev:src/fleet/approvers.ts   →  ABSENT
$ git cat-file -e origin/main:src/fleet/approvers.ts  →  ABSENT
$ ls .factory/approvers.json ~/.factory/approvers.json →  neither exists
$ grep -rn "hashToken(" src/ scripts/ tests/          →  every remaining site is a TEST
```

**The approver allowlist has never shipped.** `src/fleet/approvers.ts` reaches
`dev` for the first time with PR #150 — the very PR introducing the scrypt form.
So there are no deployed v1 allowlists to break, the outage the compatibility
path prevented cannot occur, and shipping it would have meant merging a
deprecation surface for a format that only ever existed inside the PR that
introduced it, plus an issue to delete it later.

That is the same class of error this backlog kept finding, this time in my own
work: **D7's premise was false, D5's diagnosis was inverted, D9's stated remedy
was unbuildable — and D9's compatibility argument was reasoning about a
deployment that does not exist.** A premise that sounds right is not evidence.

**So the legacy path is DELETED, not deprecated.** Removed: `LegacyEntrySchema`,
`hashToken` (no production caller once v1 is gone, and an exported crypto helper
with no caller is an invitation to write an entry nothing will verify), the
`entryMatches` version dispatch, the `legacyHash` field on `ApproverAuth`, and
the CLI's rotation warning. `EntrySchema` IS the v2 schema; the read path accepts
exactly one shape. Every fixture — the checked-in `approvers.json` (both
approvers), `gate-verbs.test.ts`'s D7 fixture, and the TIER-1 live test's
allowlist — is v2.

The version NUMBER is kept at 2 rather than renumbered to 1. It costs nothing,
and an entry that states which KDF produced it is what makes the NEXT change a
migration instead of a guess — which is the property that survives even though
this particular migration turned out to be unnecessary.

**This closed #171 outright** rather than scheduling the telemetry counter and
migration window it asked for: the issue's premise went with the code.

#### `constantTimeEqual` — the round-6 gap closed (the item's third box)

Round 6 found it asserted only for boolean equality, which the obvious BROKEN
repair (`if (a.length !== b.length) return false`) also satisfies. The new test
compares `"a"` against 100 000 bytes: `timingSafeEqual` throws `RangeError` on
unequal-length buffers, so returning `false` instead of throwing is only possible
if both sides were digested to a fixed width first. That throw is the observable
proxy for a timing property no CI can measure reliably, and it is stated as such.

#### Verification — real filesystem, real subprocesses, real stdin

- `tests/fleet/approvers.test.ts`: **90 pass**. A NEW independent v2 oracle
  (`v2EntryFor` calls `scryptSync` directly, never `scryptToken` — a helper that
  called the production function would agree with it even if both were wrong)
  deliberately at `N = 2^12`, so "verification reads the entry's own parameters"
  is asserted by the tests passing at all.
- Both approvers in the checked-in fixture are v2, as is every other allowlist
  any test writes — there is one shape and the fixtures say so.
- `tests/fleet/gate-verbs.test.ts`, *"a REAL minted token authenticates a REAL
  `fleet approve` over REAL stdin"*: a real `bun scripts/fleet.ts enrol`
  subprocess in a real tmpdir mints the token; the allowlist is asserted 0600, v2,
  and **not to contain the plaintext**; a second real subprocess spends it on
  `fleet approve` with the token on real fd 0 and the record really carries
  `state: "approved"`. Nothing in that chain is faked — which is the point, since
  D9's finding was that nothing enforced "machine-minted" because nothing minted.
- A clean decision writes no advisory to stderr at all, which is now assertable
  precisely because there is one entry shape and nothing to advise about.

---

## D10 — `approvers.ts` still carries its own copy of the guard D4 extracted

**Severity:** consistency (the divergence D4 was filed for, one merge away from
recurring) · **Session:** C or later · **Opened by:** D4, Session B

### What is wrong

D4 put the shared path guard in `src/providers/allowlist-path.ts` and pointed
`src/pr/repos.ts` at it. `src/fleet/approvers.ts` still has its own inline copy,
because it does not exist on `dev` — it arrives with PR #150 — so it could not be
converted on D4's branch. Until it is, there are two copies again, which is the
precise condition D4 exists to end.

### Preconditions — do NOT start before both are true

- [ ] **PR #169 (D4) is merged to `dev`**, so `src/providers/allowlist-path.ts`
      exists there.
- [ ] **PR #150 is merged to `dev`**, or `dev` has been merged into #150's
      branch, so both files sit in one tree.

### Precondition re-checked at the START of Session C — STILL UNMET

Run as the session's first act, before any scope was chosen:

```console
$ git fetch origin dev
$ git cat-file -e origin/dev:src/providers/allowlist-path.ts
fatal: path 'src/providers/allowlist-path.ts' does not exist in 'origin/dev'
$ git cat-file -e origin/dev:src/fleet/approvers.ts
fatal: path 'src/fleet/approvers.ts' exists on disk, but not in 'origin/dev'
$ gh pr view 169 --json state  →  OPEN     (483a3e3, MERGEABLE)
$ gh pr view 150 --json state  →  OPEN     (3094521, MERGEABLE)
```

Both PRs still open, neither file on `dev`. **D10 was therefore NOT in Session
C's scope**, per the rider table's row 2 — it is re-assigned to **Session D**,
which must re-check the same two commands before starting it. Session C did not
drop D5 or D6 to make room for it, and is not reporting itself complete while
silently skipping it: this is the explicit statement the rider table requires.

Nothing was cherry-picked and no merged tree was assembled by hand, as this
item's own instruction forbids.

### UPDATE — #169 MERGED after Session C closed · precondition now HALF met

The operator merged PR #169 at **2026-08-29T20:38:14Z**, merge commit `6e877db`
into `dev`; the `feature/df4-allowlist-path-guards` branch was verified
fully-contained (`git merge-base --is-ancestor 483a3e3 origin/dev`) and then
deleted locally, remotely and from remote-tracking. Re-checked immediately
after:

```console
$ git cat-file -e origin/dev:src/providers/allowlist-path.ts   →  ON dev  (#169 landed)
$ git cat-file -e origin/dev:src/fleet/approvers.ts            →  ABSENT  (still needs #150)
```

So **D10 is still NOT startable, but the remaining blocker is now #150 itself**
rather than two independent merges. Two ways to satisfy it, both legitimate per
this item's own text:

1. **#150 merges to `dev`** — then both files sit in one tree and D10 is a cheap
   closer.
2. **`dev` is merged INTO #150's branch** — now sufficient *on its own*, which it
   was not before, because `allowlist-path.ts` is on `dev`. This is the route
   that does not depend on #150 landing first.

Session D must still run the two `git cat-file` commands itself rather than
trust this snapshot.

### Acceptance criteria

- [ ] `authenticateApprover` delegates to `readGuardedFile` with
      `codePrefix: "approver-allowlist"`, `label: "approver allowlist"`,
      `defaultFile: DEFAULT_APPROVERS_FILE`, `contentHint: "mapping each
      approverId to its {salt, hash}"`, `consequence: "every decision is
      refused"`.
- [ ] **Every existing refusal CODE is unchanged.** `tests/fleet/approvers.test.ts`
      pins `approver-allowlist-{unreadable,mode,dir-mode,owner,path,invalid}`;
      the first five come from the shared callee's suffixes and the sixth stays
      in `approvers.ts` (parse is the caller's, only the caller knows the schema).
      **If any of those five change, the delegation is wrong — do not update the
      test to match.**
- [ ] The guards inside `approvers.ts` are DELETED, not left as a second layer.
      Two guards that must agree are the same defect one level down.
- [ ] `authenticateApprover`'s own arms — empty-id, unknown-approver with the
      case-insensitive near-match hint, `constantTimeEqual` — are untouched.
      They are not path guards and do not belong in the shared callee.

### Known cosmetic drift, already accepted

The shared callee emits ONE `consequence` clause where `approvers.ts` had two
near-identical variants ("with no allowlist…" vs "with no readable allowlist…").
Nothing pins those strings — only `not a regular file` is asserted, and it is
preserved verbatim. Do not add a second spec field to reproduce the variance.

### Verification (real, no fakes)

`bun test tests/fleet/approvers.test.ts` must go green with **no test edits**.
That is the whole proof: the suite was written against the pre-extraction
behaviour, so an unedited green run is what makes this a behaviour-preserving
delegation rather than a rewrite. If a test needs changing, stop and find out why.

### Outcome — CLOSED 2026-08-29 (Session D) · lands on PR #150

**The precondition was met by ROUTE 2, and it was met with a real merge.**
Session D's first act, before any scope was chosen:

```console
$ git fetch origin dev
$ git cat-file -e origin/dev:src/providers/allowlist-path.ts   →  PRESENT  (#169 landed)
$ git cat-file -e origin/dev:src/fleet/approvers.ts            →  ABSENT   (still needs #150)
$ gh pr view 150 --json state  →  OPEN (1cf6df1, MERGEABLE)
$ gh pr view 169 --json state  →  MERGED 2026-08-29T20:38:14Z (6e877db)
```

So `git merge origin/dev` into this branch — the route D10's own text calls
"sufficient on its own" now that `allowlist-path.ts` is on `dev`. Clean merge, 7
commits, 15 files. Nothing was cherry-picked and no tree was assembled by hand.

**What shipped.** `authenticateApprover` lost 147 lines and gained a call:

```ts
const read = readGuardedFile(hostRoot, file, {
  codePrefix: "approver-allowlist",
  label: "approver allowlist",
  defaultFile: DEFAULT_APPROVERS_FILE,
  contentHint: "mapping each approverId to its {salt, hash}",
  consequence: "every decision is refused",
});
if (!read.ok) return { ok: false, refusal: read.refusal };
const { path, text: raw } = read;
```

Containment, the ancestor walk, ownership, the regular-file check, the mode
guard and the read all moved. `approver-allowlist-invalid` stayed, because the
parse is the caller's — only this module knows the schema. The BOM strip was
DELETED rather than kept as a harmless double-strip: the shared callee already
does it for both callers, and a no-op that reads as load-bearing is worse than
no code.

**Verification — the whole proof, exactly as this item specified it:**

```console
$ git diff --stat tests/            # (empty — no test edits)
$ bun test tests/fleet/approvers.test.ts
 73 pass
Ran 73 tests across 1 file. [704.00ms]
```

73/73 green with a byte-identical test file. All five shared refusal codes
(`-path`, `-dir-mode`, `-owner`, `-unreadable`, `-mode`) are produced by the
shared callee and the suite that pins them never noticed the swap, which is
what makes this a delegation rather than a rewrite.

**The accepted cosmetic drift is real and was NOT papered over.** Two
remediation strings differ from the pre-extraction wording ("pass a path under
…" vs "pass an allowlist path under …"; "with no readable file" vs "with no
allowlist"). Nothing pins them, `not a regular file` is preserved verbatim, and
no second spec field was added to reproduce the variance — as this item's own
"Known cosmetic drift" section instructs.

---

## The approval-lock release — a CodeRabbit finding, fixed in Session B

Not a D-item; filed by CodeRabbit at 11:26:46Z on 2026-08-29 against `8019611`,
which is Session A's own follow-up round. Triaged first, per the session brief.

**Finding CONFIRMED. Its proposed remedy REJECTED, in writing.**

CodeRabbit's headline was "do not discard a captured successor lock after
`EEXIST`". That does not fix the stated failure: by the time the `EEXIST` branch
runs, the successor's lock is already off-path and the third waiter already
holds `lockPath`. Deleting or keeping the captured file changes only whether a
stale `.release.*` file is littered.

**The root cause is one line earlier.** The release did
`renameSync(lockPath, releasePath)` **unconditionally** and only then looked at
whose bytes it had captured. That vacates `lockPath` for the duration of a
rename plus a read — and *that vacancy* is what lets a third waiter in.

**Fix: fence on IDENTITY, and never take the file away to ask.** Acquire now
creates the lock with `openSync(lockPath, "wx")` and records `fstatSync(fd).ino`
— the inode of the file this call created, measured on its own fd, so no
replacement can be measured instead. Release removes `lockPath` only when it
still resolves to that inode **and** still carries this acquisition's content.
Otherwise it touches nothing. Net **deletion** of the capture/restore dance.

Both checks are required because they fail independently, and the conjunction is
the fail-safe direction: the inode catches replacement (a real reclaim renames
the old lock away and creates a fresh one, so a successor is ALWAYS a new
inode), the content catches in-place mutation (which preserves the inode — no
code path does it, but `echo > lock` does, and the round-6 assertion was written
against exactly that shape).

**Residual, stated not glossed:** a reclaim landing between the `statSync` and
the `rmSync` would still see a successor's lock unlinked. That window is two
adjacent syscalls where the old one spanned a rename, a read and a write. POSIX
has no unlink-if-inode primitive to close it outright, and reaching it requires
the abandon door to have fired — which already means mutual exclusion was
deliberately surrendered.

**Proven RED first.** The EEXIST interleaving needs process scheduling to
reproduce, so the test pins its root fact instead, which is deterministic:
identity. `the release never TOUCHES a successor's lock — same inode, not merely
same bytes` failed against the pre-fix release with
`Expected: 359808228, Received: 359808229` — the successor's lock really was
destroyed and recreated even on the path that "worked". A release that never
removes a file it does not own cannot vacate the path, so pinning the inode
pins the whole class.

**A latent test defect the round-6 test surfaced, and the lesson.** The round-6
test simulates a reclaim with an in-place overwrite, which keeps the inode — so
the first version of the fix turned it red. The simulation, not the fix, was
unfaithful: a real reclaim always produces a new inode. That is what drove the
conjunction rather than deleting an inconvenient assertion to fit the change.

---

## D11 — `LOCK_ABANDON_MS` reclaims a lock whose holder may still be executing

**Severity:** MED (correctness, concurrency) · **Session:** C or D · **Opened by:**
CodeRabbit on `5ed7eb6`, 2026-08-29T12:49:45Z · **This is a DESIGN DECISION, not
a patch — do not write code until it is made.**

### What is wrong

Session B fenced the lock RELEASE on identity, which removed the vacancy that
let a third waiter in. CodeRabbit's follow-up escalates one level and is
**correct to**: the residual window Session B documented in the source is not
really a release bug at all. It is a symptom of the `age > LOCK_ABANDON_MS`
door, which reclaims a lock from a holder that **may still be running
`body()`**.

Once that door fires, mutual exclusion is already gone — two processes are
inside the critical section by design, and no amount of release fencing changes
that. Session B's own comment says exactly this ("reaching it requires the
abandon door to have fired, which already means mutual exclusion was
deliberately surrendered"), which is the admission that the guard is placed at
the wrong layer.

The remaining window is narrow (a `statSync` and an `rmSync`, where the
pre-Session-B code spanned a rename, a read and a write) but it is real: a
successor replacing the lock between those two calls is still unlinked by the
resumed original holder.

### Why the door exists — do not remove it without answering this

`LOCK_ABANDON_MS` is the escape hatch for the case where death can NEVER be
proven: a recycled pid. Without it, a lock whose holder died and whose pid was
reused by an unrelated process is held forever, and every later verb for that
run refuses `fleet-busy` until an operator intervenes by hand. Removing the door
outright trades a rare concurrency window for a guaranteed permanent wedge.
That is not obviously the better trade and must be argued, not assumed.

### The decision to make

- [ ] **Establish empirically whether the abandon door has EVER fired.** Grep
      the real evidence under `_bmad-output/evidence/` and any operator logs for
      a reclaim on the age disjunct rather than on proof-of-death. If it has
      never fired in practice, options (b) and (c) get much cheaper.
- [ ] Then choose and record ONE:
      **(a) Lease protocol.** The holder re-checks it still owns the lock
      (inode + content) immediately before each mutating step inside `body()`,
      and aborts if it does not. This makes reclaim SAFE rather than merely
      narrow, and is the only option that actually restores mutual exclusion.
      Cost: `withApprovalLock`'s contract grows a "you may be evicted" clause
      every caller must honour, and `body()` becomes abort-able mid-flight.
      **(b) Remove the age-only door.** Reclaim only on proven death. Simple and
      provably safe, at the price of a permanent wedge on a recycled pid.
      Mitigation to price in: a documented `fleet unlock <run-id>` verb, which
      the repo does not have.
      **(c) Keep it, bound it, and say so.** Accept the window as the documented
      cost of never wedging, and make the abandon path LOUD — a structured log
      line naming both holders, so a real occurrence is visible rather than
      inferred. Cheapest, and honest, but it does not close anything.
- [ ] Whichever is chosen, `withApprovalLock`'s header must state the mutual
      exclusion guarantee it actually provides. Today it implies a stronger one
      than it delivers, which is how three review rounds each found a different
      symptom of the same design.

### Do NOT

- Do not add a fourth layer of fencing to the release. Three rounds have now
  patched that function; the release is not where this lives.
- Do not silently narrow the window further and call it closed. The window is a
  consequence, and a narrower consequence is still a consequence.

### Verification (real, no fakes)

Whichever option is chosen, the proof is REAL PROCESSES, not simulated content
swaps in one process — Session B's tests simulate a reclaim by writing the file,
which is faithful for the release but cannot exercise a genuinely concurrent
holder. Spawn two real `bun` subprocesses against one real lock directory with a
real backdated mtime (`utimesSync`), and assert what each observes. For (a),
the evicted holder must abort rather than complete its mutation.

### Outcome — CLOSED 2026-08-29 (Session D) · **option (b)** · lands on PR #150

**⚠ HIGH-risk edit, warned before it was made.** `impact({target:"withApprovalLock",
direction:"upstream"})` → **22 upstream symbols, risk HIGH**, 4 direct callers
(`requestApproval`, `submitDecision`, `sweepExpired`, the test file) across 2
execution flows (`scripts/fleet.ts:run`, `submitDecision`) and 3 modules. The
change direction is the mitigation: it makes the lock STRICTER, never looser.

#### The empirical question, answered first

**The abandon door has never fired.** It did not exist before review round 6 —
`_bmad-output/evidence/df3-4-review-round-6/fix-gate.md` item 10 is the commit
that ADDED it, as a fix for a different finding — so there is no run, log or
evidence file in which it could have. That made (b) and (c) much cheaper than
the item anticipated, exactly as its first checkbox predicted.

#### The decision: (b), and why not (a)

Both (a) and (b) restore mutual exclusion. (b) restores it **structurally** — a
lock is only ever reclaimed from a provably-dead holder, so two processes cannot
be inside `body()` at all — while (a) restores it **by contract**: every caller
of `withApprovalLock`, now and forever, must honour a "you may be evicted"
clause and make `body()` abortable mid-flight. A guarantee that depends on six
current callers and every future one remembering a clause is weaker than one
that cannot be violated, and (a) also keeps the door that produced three
distinct review findings. With the door gone, (a)'s lease protocol has nothing
left to protect against and would be pure ceremony.

(c) was rejected on the item's own terms: it "does not close anything", and this
was the third round on one design.

**The price is paid explicitly, not hidden.** Removing the door means a holder
whose pid the OS recycled onto an unrelated live process wedges that run's
approval verbs forever. That is the recycled-pid case the door existed for, and
the answer is now `fleet unlock <run-id>` — an operator action that is loud,
auditable, and bounded to one run, replacing an invisible one-hour timer that
made the same decision on the operator's behalf and could be wrong.

#### What shipped

- `LOCK_ABANDON_MS` and the `|| age > LOCK_ABANDON_MS` disjunct: **deleted**.
  Reclaim is now `if (pid !== undefined && isLockHolderDead(pid))` — proof of
  death, full stop. Age remains a precondition for *looking*, never a reason to
  act.
- `withApprovalLock`'s header now **states the guarantee it actually provides**,
  which is the item's third acceptance box: "while one process holds this lock,
  no other enters `body()` for the same runId UNLESS the holder is PROVABLY DEAD
  or an operator has explicitly reclaimed it with `fleet unlock --force`" — plus
  the price (a recycled pid wedges that run) in the same block.
- `reclaimApprovalLock(dir, runId, force)` in `approval-gate.ts` — NOT in the
  CLI. The lock's path grammar, content format, liveness predicate and identity
  fence all live in one module; a CLI that learned the lock file's shape would
  be the second copy of exactly what D4/D10 exist to prevent. It reuses
  `assertExistingRunId` (this builds a path and then DELETES it, so an
  unvalidated id is an arbitrary-unlink primitive) and fences the removal on
  **inode AND content**, the same conjunction the release uses.
- `fleet unlock <run-id> [--force]` — registry entry, CLI block, exit codes
  `[0,1,2,4,5,6]`. `absent` and `reclaimed` are both exit 0 (a run with no lock
  is the HEALTHY answer to "is this run wedged?"); a live-or-unreadable holder
  without `--force` is exit 5; `assertRunExists` runs BEFORE the lock is touched
  so a typo'd id is 4 rather than a cheerful "no lock here".
- The `fleet-busy` timeout message no longer tells operators to delete files out
  of the runs directory by hand — it names the verb.
- **No authentication on `unlock`**, argued in the source: `approve` authenticates
  because it authorizes a DECISION; this removes a lock file, and anyone who can
  reach the directory can already `rm` it. A token check would be theatre that
  trains operators to keep a token in reach for janitorial work.

#### The release fence STAYS, and is now load-bearing for a different reason

Session B's inode+content fence was justified by the abandon door. With the door
gone it is what makes `--force` safe: when an operator evicts a live holder, that
holder's release sees a different inode and correctly touches nothing. The source
comments were rewritten to say so rather than left claiming a defunct rationale.

#### Verification — TWO REAL PROCESSES, and PROVEN RED FIRST

The item demanded real subprocesses against one real lock dir with a real
backdated mtime, and that a simulated holder proves only the simulation.

`tests/fleet/approval-gate.test.ts`, `a GENUINELY CONCURRENT holder is not
evicted by age — two real processes, one real lock`: process A really acquires
and parks INSIDE `body()`; the parent backdates the real lock file to 2 hours
via `utimesSync`; process B really tries to acquire.

**Proven RED against the pre-D11 code.** With the door temporarily restored:

```console
$ bun test tests/fleet/approval-gate.test.ts -t "GENUINELY CONCURRENT"
896 |       expect(seen).toContain("REFUSED:");
error: expect(received).toContain(expected)
Expected to contain: "REFUSED:"
Received: "ENTERED\n"
(fail) a GENUINELY CONCURRENT holder is not evicted by age — two real processes, one real lock
```

`ENTERED` is two real processes inside one critical section — the defect, live,
not argued. With the door removed B is refused, A keeps its own lock byte- and
inode-identical, and A then releases normally (proving the refusal was mutual
exclusion working, not a deadlock).

The companion test "`fleet unlock --force` evicts a live holder, and that
holder's release touches the successor's lock" spawns a THIRD real process as
the successor and asserts the evicted holder's release leaves the successor's
inode intact.

```console
$ bun test tests/fleet/approval-gate.test.ts
 92 pass
Ran 92 tests across 1 file. [21.61s]
```

#### A defect this work's own test found

`lock_age_ms` could be **negative** (`-0.85 ms` observed on macOS): `mtimeMs` is
the filesystem's clock and can land marginally ahead of `Date.now()` for a file
just written. Clamped at the source (`Math.max(0, …)`) rather than by loosening
the assertion — a negative age is nonsense in the one field an operator reads to
decide whether to force. It is age-for-DISPLAY only and never a reclaim
condition, so the clamp cannot widen anything.

#### Registry contract fallout, handled rather than suppressed

Adding a verb reddened six registry-derived contract tests. Each was extended,
none weakened. The one worth recording: `F6 composition: no verb exposes an
admission-skip flag` matches `/admit|headroom|budget|ceiling|skip|force|bypass/i`
and `--force` hits it. The regex was **not** relaxed. An exemption keyed to
`"unlock --force"` (verb AND flag, so `--force` on any other verb still reds)
was added with the argument in the test: that guard is about bypassing ADMISSION
gates — headroom, budget, dispatch's `{admitted:true}` seam — which decide
whether work with a cost may start. `unlock --force` starts nothing, provisions
nothing and spends nothing; it overrides a liveness proof, is exit-5 refused
without the flag, and is strictly safer than the automatic eviction it replaced.
A check that the exempted flag still EXISTS was added, so a stale exemption
cannot silently re-open the hole.

---

## Session handoff protocol

Every session ends by doing all five, in order:

1. **Update this file.** Tick the status board, and under each closed item append a
   `### Outcome` block: what shipped, the commit SHA, the gate results verbatim, the
   live evidence path, and anything discovered that changes a LATER item's plan.
2. **Record honest gaps.** Anything unprovable on the available substrate is written
   down as unprovable, with the reason. Never a fake green.
3. **Run the full gate** (rule 4) and commit with a message stating which D-items closed.
4. **Push to the feature branch, open/update the PR, request CodeRabbit re-review.**
5. **Write the next session's handoff prompt** into a new `## Handoff — Session <X>`
   section at the bottom of this file, with the same rigor as Session A's below:
   full situational awareness, exact file:line anchors, the ground rules, the
   acceptance criteria, and the live-verification plan. Then give it to the operator.

If a session cannot finish its group, it hands off mid-group with the remaining
acceptance boxes unticked and a note on exactly where it stopped and why.

---

## Session A — gates (one commit closes D3 + D1 + D2)

Run on the final tree, verbatim:

| Gate | Result |
|------|--------|
| `bun test` (full) | **4117 pass / 8 skip / 20 todo / 1 fail**, 17 515 assertions, 4146 tests across 133 files, 607.5 s |
| `bunx tsc --noEmit` | **0 errors** |
| `bunx biome check src/ scripts/ tests/` | **266 files checked, no fixes applied** |
| `detect_changes({scope:"all"})` | 22 symbols / 10 files, aggregate `critical`; blast radius reviewed symbol-by-symbol below |
| `detect_changes({scope:"compare", base_ref:"main"})` | **809 symbols / 61 files, aggregate `critical`, 32 affected processes.** See the regression note below — the raw count is not the review. |
| TIER-1 live | **1 pass / 0 fail**, real exe.dev box, `leaked: []`, `final-ls: []` |

**Regression blast radius vs `main` (the check CLAUDE.md actually asks for).**
`scope:"all"` only ever sees the working tree, so it answers "what did this
session touch", never "what does this branch change". The `compare` run is the
regression review, and its 809 is mostly not code: **562 of the 809 changed
symbols are Markdown/YAML sections** under `_bmad-output/`, and only **247 are
`src/`, `scripts/` or `tests/`** — of which **150 are production symbols**,
concentrated exactly where DF3.4 lives:

| File | Changed symbols |
|------|-----------------|
| `src/fleet/approval-gate.ts` | 43 |
| `src/fleet/attach.ts` | 33 |
| `src/fleet/approvers.ts` | 16 |
| `scripts/fleet.ts` | 15 |
| `src/phase-engine/steering.ts` | 14 |
| `src/providers/run-record.ts` | 11 |
| `src/fleet/status.ts` | 7 |
| `scripts/pipeline-run.ts`, `src/fleet/verbs.ts`, `src/providers/step-log.ts` | 3 each |
| `src/reverify/approval.ts` | 2 |

Nothing outside DF3.4's declared surface appears, which is the property this
check exists to prove. Two caveats recorded rather than buried: `main` is not
this PR's merge base — PR #150 targets `dev` — so the comparison also carries
whatever `dev` is ahead of `main` by; and the aggregate `critical` grade is
driven by `validateExtensions`/`assertWellFormed` sitting on the `run` /
`teardownRun` / `submitDecision` / `awaitDecision` / `reapRuns` paths, which is
a statement about where those functions SIT, not about the size of the edits to
them.

### The one failure is PRE-EXISTING, and that was proven, not assumed

`tests/fleet/cli.test.ts` → `a fleet-busy race refusal creates NO loser cost
ledger (INV-2: the money file follows admission)` — times out at its own 20 s
bound. It failed on **both** full-suite runs, so it was not treated as a flake:

- `bun test tests/fleet/cli.test.ts` **with** this session's diff: 154 pass / 1 fail (20005 ms).
- `git stash push src/ scripts/ tests/`, same file on the **pristine** `24632ed`:
  **154 pass / 1 fail (20002 ms)** — identical. Then `git stash pop`.
- The same test passes in **162 ms** under `-t` isolation.

So it is environmental/pre-existing, not a regression from this work. Host load
averages were 8–17 throughout (Docker VM, WebKit, two other agent CLIs) and the
disk is 98 % full — skill gotcha #5's exact profile. **It is not fixed here and
it is not hidden**: it is a fleet-lock-contention case in the suite, and it wants
its own investigation (it is the third distinct symptom of issue #138).

### Blast radius, symbol by symbol

Verified against `git diff`, not inferred from the tool's labels:

- `scripts/fleet.ts:bounded` — body delegated to `boundedEcho`; the removed and
  added lines are byte-identical, same `redactSecrets`, same `MAX_ECHO = 96`.
  Its two affected processes (`Handler → RedactKeyManagementUrls`, `→ AsText`)
  are the redactor chain it already called.
- `scripts/fleet.ts:run`, `:gateEvent` — one additive key. No control flow moved.
- `src/fleet/approval-gate.ts:requestApproval` — wrapper + `pauseRun` split, plus
  the emit. The `Const:` entries (`headSha`, `store`, `proposal`, `pollMs`) are
  gitnexus attributing consts inside the relocated body.
- `submitDecision`, `awaitDecision`, `decisionOf`, `writeTimeout`,
  `resolveTimeoutMs`, `stepBase`, `StepCtx`, `StepLogLabels`,
  `EXTENSION_NAMESPACES` — reported `touched` from **line-offset shift only**;
  the non-comment diff shows zero changes in any of them.
- `src/fleet/verbs.ts:VerbEntry`, `listVerbs`, `renderHelp` — the additive `note`.


---

## Session B — gates

Two commits, on two branches, because D4 is a HIGH authorization finding on a
different subsystem than #150 and had to reach `dev` independently.

| Gate | D4 — `483a3e3` on `feature/df4-allowlist-path-guards` (PR #169 → dev) | D7 + lock — on `feature/df3-4-approval-gate-attach-steering` (PR #150) |
|------|------|------|
| `bun test` (full) | **3853 pass / 8 skip / 19 todo / 0 fail**, 16 346 assertions, 3880 tests / 129 files, 587.7 s | **4122 pass / 8 skip / 20 todo / 1 fail**, 4151 tests / 133 files, 596.8 s |
| `bunx tsc --noEmit` | **0 errors** | **0 errors** |
| `bunx biome check src/ scripts/ tests/` | **259 files, no fixes applied** | **266 files, no fixes applied** |
| `detect_changes({scope:"all"})` | 3 symbols / 3 files / **low** / **0 affected processes** | 11 symbols / 4 files / `high` aggregate / 10 affected processes — see below |

### The one failure is the SAME pre-existing one Session A documented

`tests/fleet/cli.test.ts` → `a fleet-busy race refusal creates NO loser cost
ledger (INV-2: the money file follows admission)`, timing out at its own 20 s
bound. Verified, not assumed:

- `bun test tests/fleet/cli.test.ts` **with** this session's diff: **155 pass / 0 fail**.
- `git stash push src/ scripts/ tests/`, same file on pristine `8019611`:
  **155 pass / 0 fail**. Then `git stash pop`.

So it reproduces **only under full-suite contention**, and behaves identically
with and without this session's diff. Session A proved the same test fails under
full-suite conditions on pristine `24632ed`. Third distinct symptom of issue
#138; not fixed here and not hidden.

### A SECOND failure appeared and was FIXED, not excused

The first full run on #150's branch also failed `attach with NO --message at all
is a usage refusal`. Proven pre-existing at `8019611` the same way (identical
5003 ms timeout on a stashed tree), and it is **a latent test defect**, not a
product fault: it called `run()` in process with the flag absent, which makes the
CLI read the REAL fd 0 (`Bun.stdin.stream()`, `scripts/fleet.ts:741` — there is
no seam). Its outcome therefore depended on whatever stdin the person running
`bun test` happened to have; under a fd 0 that stays open with no data it blocked
and died on bun's 5 s timeout. **That is why it passed in Session A's full run
and failed here against identical source.** It is now a real subprocess with a
real empty pipe, in the `D2 —` describe where its `--message -` sibling lives.
`gate-verbs.test.ts`: 68 pass / 0 fail, and the file dropped 6.34 s → 1.46 s.

### Blast radius, symbol by symbol — verified against `git diff`, not the labels

**D4** — `resolveRepoEntry` and `refuse` genuinely changed.
`DEFAULT_REPOS_FILE` is reported `touched` from **adjacency only**: its
declaration is byte-identical and the new spec const simply sits below it. New
files carry no prior symbols. `0 affected processes` is the AC's "downstream
must not need a `switch` update", measured rather than asserted.

**D7 + lock** — the aggregate `high` is misleading and the non-comment diff
proves it. Stripping comments, **every changed line is inside
`withApprovalLock`** plus one import:

- `withApprovalLock` — genuinely changed: fd-based create recording `ownIno`,
  and a release that fences on inode + content. Net deletion.
- `readApproval`, `readApprovalIfPresent` — **zero non-comment lines changed.**
  All 10 affected processes are driven by these two, so the `high` grade is a
  statement about where they SIT (the `submitDecision`/`awaitDecision` paths),
  not about any behaviour change. Same caveat Session A recorded.
- `nowOf` (×2), `state`, `expiresAt`, `capText`, `expiredState`,
  `requestApproval`, `GateDeps` — line-offset shift only; not one appears in the
  non-comment diff.

`impact({target:"resolveRepoEntry"})` **LOW**, 7 impacted / 2 direct.
`impact({target:"withApprovalLock"})` **LOW**, 6 impacted / 3 direct — signature
unchanged, internals only. No HIGH or CRITICAL to warn on.

### Also landed: a rule so a 10-minute suite is never run blind again

`bun test` output must be captured to a file, with the CR/ANSI strip a raw bun
log silently needs (a plain `grep '(fail)'` over one matches nothing and reads as
"no failures"). This cost a full re-run in this session. **`AGENTS.md` had
drifted to a strict subset of `CLAUDE.md`** — missing the branch convention and
the live-e2e pointer as well — and is now byte-identical rather than a second,
staler source of truth.

### No live tier was run

Neither item needs a box: D4 is a filesystem authorization guard and D7 is a CLI
exit code. Zero spend, no keys minted, no boxes provisioned. `.sandbox/fleet.lock`
checked and absent before the suite runs.

---

## Session C — gates

One commit closes D5 + D6, on `feature/df3-4-approval-gate-attach-steering` (PR #150).

| Gate | Result |
|------|--------|
| `bun test` (full) | **4127 pass / 8 skip / 21 todo / 1 fail**, 4157 tests across 133 files, 810.5 s |
| `bunx tsc --noEmit` | **0 errors** |
| `bunx biome check src/ scripts/ tests/` | **266 files checked, no fixes applied** |
| `detect_changes({scope:"all"})` | 13 symbols / 7 files, aggregate `high`, 9 affected processes — reviewed symbol-by-symbol below |
| TIER-1 live (D6) | **1 pass / 0 fail**, real OpenRouter API, **0 boxes, 0 keys minted, $0 spend** |

Biome flagged 3 errors on the first run — all three mine, `useTemplate` /
`noUnusedTemplateLiteral` on the concatenated refusal message in
`live-harness.ts`. Rewritten as one template literal (whose embedded newlines are
wanted anyway: it is read off a failing test's output), then re-verified green
along with a re-run of the live D6 case.

### The one failure is the SAME pre-existing one Sessions A and B documented

`tests/fleet/cli.test.ts` → `a fleet-busy race refusal creates NO loser cost
ledger (INV-2: the money file follows admission)`, timing out at its own 20 s
bound (**20009.59 ms**). Verified, not assumed, by the protocol the handoff
specifies:

- `bun test tests/fleet/cli.test.ts` **with** this session's diff: **155 pass / 0 fail**.
- `git stash push src/ scripts/ tests/`, same file on the pristine tree:
  **155 pass / 0 fail** — identical. Popped, and the working tree verified
  byte-identical afterwards (`8 files changed, 341 insertions(+), 24 deletions(-)`
  before and after).

So it reproduces only under full-suite contention and behaves identically with
and without the diff — the third distinct symptom of issue #138. Not fixed here,
not hidden. Host conditions matched skill gotcha #5 exactly: load average
**13.31** and disk **98 % full** at suite start.

(The `error: log boom` / `error: callback boom` lines in the log are deliberate
test fixtures — intentional throws — not failures.)

### Blast radius, symbol by symbol — verified against `git diff`, not the labels

The `high` aggregate is misleading in exactly the way Session B's D7 was, and the
non-comment diff proves it. **Exactly ONE symbol genuinely changed behaviour, and
it is in a test harness.**

- `listedKeyHashes` (`live-harness.ts`) — **genuinely changed**: reads
  `truncated`, throws on it, bound moved to `MAX_VERIFY_PAGES`, `maxPages`
  parameterised with a default. `impact` **MEDIUM**, 9 direct (the 9 live suites
  that import it), **0 affected processes**. The default is why all 13 call sites
  are untouched.
- `report` (`scripts/fleet.ts`); `FleetError`, `FleetError.constructor#5`,
  `FleetError.exitCode`, `FleetError.code`, `FleetError.remediation`, `refuse`
  (`src/fleet/dispatch.ts`) — **comment-only**, proven mechanically: the diff of
  both files contains **zero non-comment added lines and zero deleted lines**
  (48 insertions, all comments). The properties report `touched` because the new
  comment sits inside the class body.
- `assertFleetRunId`, `dispatch` (`src/fleet/dispatch.ts`) — **line-offset shift
  only**; neither appears in the non-comment diff.
- `ledgerRows`, `destroyQuietly`, `revokeQuietly` (`live-harness.ts`) —
  line-offset shift only; they sit below `listedKeyHashes`.
- All 9 affected processes are driven by `refuse`/`dispatch`/`FleetError`, so the
  `high` grade is a statement about where those symbols SIT (the dispatch and
  `within` paths), not about any behaviour change. Same caveat Sessions A and B
  recorded.

**`impact({target:"FleetError"})` returns CRITICAL** (43 impacted / 28 direct) and
is reported here as CLAUDE.md requires. It is a statement about the class's
centrality, not about this edit: the change to it is a comment.

### Triage of open review comments — nothing outstanding

Checked before starting, as the handoff requires. The latest CodeRabbit review
comment on #150 is `2026-08-29T12:49:45Z` (the D11 escalation, already folded into
this document by `3094521`). HEAD `3094521` is `19:21Z`, so **nothing was filed
against Session B's final diff**. #169 has no review comments at all — CodeRabbit
was rate-limited (`Review limit reached`) and never produced one, which is worth
knowing before that PR merges.

---

## Session D — gates, triage, and the CodeRabbit round

### CodeRabbit's post-Session-C review — triaged BEFORE any scope was chosen

Session C reported "nothing outstanding", and that was true when it looked. The
bot produced a full review at **2026-08-29T20:33:52Z**, after Session C's HEAD
commit. The triage, in the shape Session B established — a finding can be REAL
while its suggested remedy is WRONG, and a Critical can be neither:

| Finding | Verdict | Action |
|---|---|---|
| `tests/fleet/e2e/tier1-approval-gate.live.test.ts:511` — a failed key-hash delta leaves `leaked` empty and the assertion PASSES (Major) | **REAL, and it undermined D6's own close** | FIXED as suggested. `listedKeyHashes` throws on truncation (D6) and the `catch` swallowed it into evidence, so "we could not look" reported as "nothing leaked" — the exact defect D6 was filed for, sitting inside D6's own proof. `deltaError` is now asserted beside `leaked`. |
| `src/fleet/approval-gate.ts:479` — do not expire `pausing` in `fleet status` (Minor) | **REAL** | FIXED at the ROOT. `approvalRowFields` re-implemented expiry and derived `timed-out` for BOTH paused states, while `expiredState` deliberately never expires `pausing`, `submitDecision` answers `not-decidable` and `sweepExpired` writes nothing — so an operator was shown a terminal state no verb would ever settle. `status.ts` now imports `expiredState`; one rule, two readers. Reachable and PERSISTENT, not theoretical: a crashed teardown leaves `pausing` on disk by design. Proven RED first (`Received: "timed-out"`). |
| `tests/phase-engine/steering.test.ts:853` — duplicate `const seen` / `let queued` / `inbox`; "TypeScript rejects these declarations" (**Critical**) | **FALSE POSITIVE, rejected in writing** | Lines 853/865/1061/1281/1286 are five DIFFERENT tests; each declaration is in its own `test()` callback scope or its own object literal. `bunx tsc --noEmit` is clean and has been all session. The bot flattened lexical scopes. No change. |
| `_bmad-output/workflow-state/qds-dev/df3-4/state.yaml:566` — `# REPO ROOT …` is INSIDE the quoted scalar (Minor) | **REAL** | FIXED. Any consumer reading `gate_commands.cwd` got a nonexistent directory. |
| Story `:504` — `[Review][Decision]` parses as an undefined MD reference link (MD052) | **REAL, cosmetic** | FIXED (code span). |
| Story `:599` — record the observability remediation | **REAL** | Satisfied by D8's `AMENDED` blocks, which record the resolution in that same file. |
| `R4-steering-transport.md:30`, `R5-teardown-creds.md:446` / `R8-gating-checks.md:190` — mark superseded premises | **REJECTED, with reason** | Dated RESEARCH ARTIFACTS under `workflow-state/…/research/`: point-in-time inputs to a decision, not current guidance. Editing them rewrites the record of what was known when the decision was made. The superseding decisions live in the story and in this document, which is where a reader is sent. |

**CI `check` is FAILING on PR #150 and it is NOT the code:**
`The job was not started because recent account payments have failed or your
spending limit needs to be increased` — GitHub Actions billing. **Operator
action required**, flagged rather than worked around.

### Gates

```console
$ bunx tsc --noEmit                       → clean, exit 0
$ bunx biome check src/ scripts/ tests/   → Checked 268 files in 416ms. No fixes applied.
```

**`bun test`, run 1 — 4171 pass / 8 fail / 8 skip / 22 todo, 4209 across 134 files [786.73s]**

The 8 failures are NOT the documented INV-2 one (which did not fire this run),
so they were investigated rather than excused — "pre-existing is where an
investigation starts, not where it ends".

Every one of the 8 timed out at **~5000 ms**, bun's default per-test bound:

```
(fail) AC5 … an allowlist pointed OUTSIDE hostRoot is refused        [5059.83ms]
(fail) P1.3 … the mirror index translates a run's issue …            [5117.18ms]
(fail) P1.3 … an absent index falls back …                           [5012.34ms]
(fail) AC-1 … gitnexus_impact — 'registerSwarmClawAgent' upstream …  [5023.02ms]
(fail) AC-2 … nonexistent symbol query returns a valid QueryResult   [5010.01ms]
(fail) AC-3 … context on an unknown symbol returns not-found         [5013.75ms]
(fail) INV-GN1 & INV-GN3 … no indexed file path is absolute …        [5014.66ms]
(fail) INV-GN1 & INV-GN3 … query/context result file paths …         [5021.49ms]
```

Five spawn the gitnexus CLI and two spawn `git push` — the I/O-heavy subprocess
tests gotcha #5 names by name. The host was at **load average 16.63** with a
WebKit content process pinned at 93% CPU (a browser outside this session's
control, not killed).

**Verified by the documented protocol rather than by assertion** — the same two
files, in isolation, against the identical working tree:

```console
$ bun test tests/pr/open-pr.test.ts tests/gitnexus/
 65 pass
 0 fail
Ran 65 tests across 3 files. [113.46s]
```

All 8 pass. **And the full suite was then re-run end to end under lower load:**

```console
$ bun test
 4179 pass
 8 skip
 22 todo
 0 fail
Ran 4209 tests across 134 files. [721.43s]
```

**Zero failures** — including `tests/fleet/cli.test.ts`'s INV-2 fleet-busy race
case, the failure Sessions A, B and C each documented as pre-existing (issue
#138). So this session's gate is a genuinely clean full-suite run rather than a
clean-except-for-a-known-flake one, and the run-1 failures are confirmed
environmental by two independent re-runs rather than by argument.

**Re-run once more after the legacy-path deletion** (the `#171`-closing change
described in D9's Outcome):

```console
$ bun test
 4173 pass
 8 skip
 22 todo
 1 fail          ← gitnexus_impact … [5073.83ms]
Ran 4204 tests across 134 files. [852.40s]
```

4204 rather than 4209 because five tests were deleted with the format they
tested. The single failure is the same family again — a gitnexus CLI spawn at
bun's 5 s bound, load average 12.69 — and it is not even the same TEST that
failed in run 1, which is itself the tell: `tests/gitnexus/` alone failed 3
different cases on one pass and then went **24 pass / 0 fail** on an immediate
retry with no change in between. A defect does not move.

The diff is not implicated: `tests/pr/open-pr.test.ts` exercises
`src/pr/repos.ts` → `readGuardedFile`, neither of which this session edited (both
arrived from `dev` with #169's merge), and the gitnexus suite touches no source
this session changed.

### Blast radius, reviewed symbol by symbol against `git diff`

The one HIGH-risk edit was **`withApprovalLock`** — `impact(upstream)` reported
22 upstream symbols, 4 direct callers (`requestApproval`, `submitDecision`,
`sweepExpired`, the test file), 2 execution flows (`scripts/fleet.ts:run`,
`submitDecision`), 3 modules — and it was warned BEFORE the edit, not after. The
mitigation is the change's DIRECTION: the lock becomes strictly harder to take
from a live holder, so every caller's guarantee strengthens and none weakens.
`authenticateApprover` was LOW (2 direct callers), and D10's delegation carries
its own stronger proof: the suite that pins all five refusal codes passes
unedited.

`src/fleet/status.ts` gained one import edge (`expiredState`), checked for a
cycle in both directions: `approval-gate.ts` does not import `status.ts`.


### Follow-up issues opened at close

The backlog ends here, so anything still open needed an issue or it would
evaporate with the document. Two were genuinely created by this session's work;
**D10 did NOT need one** (its rider table's row 3 applies only if D10 was still
blocked at close, and it was closed).

- **[#170] D8 residual — no live leg drives `reverify()` to a green verdict.**
  The honest gap from D8's Outcome, written up with what IS proven, what is not,
  and why TIER-2 would not have closed it.
- **[#171] D9 follow-up — CLOSED the same day, by deletion.** It asked for a
  telemetry counter and a migration window before refusing legacy v1 entries.
  Checking the premise showed the allowlist has never shipped (`approvers.ts` is
  on neither `dev` nor `main`), so there was nothing to migrate: the legacy path
  was deleted outright and the issue's premise went with it. See D9's Outcome.

**Not an issue, but an operator action:** PR #150's CI `check` job is failing on
GitHub Actions **billing** ("recent account payments have failed or your spending
limit needs to be increased"), not on anything in this branch.

---

## Handoff — Session D

Copy the block below into a fresh conversation.

---

Work the QDS-Factory DF3.4 deferred-remediation backlog, **Session D** — the last
one. Repo root `/Users/steve/QDS-Factory`, branch
`feature/df3-4-approval-gate-attach-steering`.

**READ FIRST, IN THIS ORDER**

1. `_bmad-output/plans/2026-08-29-df3-4-deferred-remediation.md` — this tracking
   document, the single source of truth. Read ALL of it, including the seven
   `### Outcome` blocks. Four rulings you will be asked to apply again:
   - when a shared callee is earned (D1's `boundedEcho`, D4's `readGuardedFile`,
     D6's throw inside `listedKeyHashes`);
   - what "additive" must mean when another story compares against a shape (D2);
   - **that a deferred item's stated premise may be false — D7's was, and D5's
     diagnosis was inverted outright.** Only a real subprocess revealed D7's; only
     an audit of every construction site revealed D5's. Verify against a running
     system before you fix;
   - **a ticked acceptance box can still be wrong.** D5's AC said "widen at BOTH
     sites"; the right answer was not to widen at all. When the evidence inverts
     an AC, STOP and get the operator's call in writing before building — do not
     decide it silently, and do not follow it silently either.
2. `.claude/skills/qds-live-e2e/SKILL.md` — **mandatory**, because D8 needs a
   TIER-2 round with REAL MODEL SPEND. Gotcha #4 (leaked `.sandbox/fleet.lock`)
   and #5 (suite-under-load flakes) have now cost time in four consecutive
   sessions.
3. `src/fleet/approval-gate.ts` around `requestApproval`/`emitPause`, and
   `src/reverify/runner.ts:406` — D8's whole question is which callers reach the
   gate with a live box.
4. `src/fleet/approvers.ts` `hashToken` + `constantTimeEqual` before D9, and
   `tests/fleet/approvers.test.ts` before D10.

**SITUATION**

Backlog is **7 / 11**. D3/D1/D2 closed in Session A; D4/D7 in Session B; D5/D6 in
Session C. Four remain: **D8, D9, D10, D11.**

PR state (updated after Session C closed):

- **#169** — **MERGED** into `dev` at 2026-08-29T20:38:14Z, merge commit `6e877db`.
  D4, the HIGH authorization fix. Its branch was verified fully-contained and then
  deleted locally, remotely and from remote-tracking. **It merged with NO CodeRabbit
  review** — the bot was rate-limited and never produced one — so
  `src/providers/allowlist-path.ts` and `tests/providers/allowlist-path.test.ts` are
  now on `dev` having had human review only. Worth a read if you touch that module
  for D10.
- **#150** (`feature/df3-4-approval-gate-attach-steering` → `dev`) — **OPEN**,
  head `1b126fa`. DF3.4 plus Sessions A, B and C. This is your branch.

**GitNexus is reliable.** `impact()` resolves this branch's symbols to their real
files, so ground rule 6 is in force — run it, do not fall back to grep. Caveat
unchanged: the index is BM25-only on this host (no `--embeddings`, issue #74), so
`query()` can miss symbol-name-only hits; `impact`/`context`/`detect_changes` are
unaffected.

**Before you start:** triage review comments filed after `3094521` / `483a3e3`
(`gh pr view 150 --comments`, `gh pr view 169 --comments`). Session C found
nothing outstanding, but Session C's own commit is new. Session B's shape is the
one to copy: **a finding can be real while its suggested remedy is wrong** — the
lock finding was exactly that and became D11; D5 was the same class again.

**SESSION D SCOPE — four items, and they will not all be cheap.**

Recommended order, with the reasoning so you can override it deliberately:

1. **D10's precondition check FIRST — it is two commands and it decides scope.**
   ```bash
   git fetch origin dev
   git cat-file -e origin/dev:src/providers/allowlist-path.ts && echo "D4 landed"
   git cat-file -e origin/dev:src/fleet/approvers.ts && echo "DF3.4 landed"
   ```
   **As of this handoff the FIRST is present and the SECOND is not** — #169
   merged, #150 has not. So D10 is not startable as the tree stands, but the only
   remaining blocker is #150 itself.

   You have a route Session C did not: **merging `dev` into this branch is now
   sufficient on its own**, because `allowlist-path.ts` is already on `dev`. That
   is explicitly allowed by D10's own precondition ("or `dev` has been merged into
   #150's branch, so both files sit in one tree") and it does not require #150 to
   land first. It is also a merge you may want anyway, to keep this branch from
   drifting further behind `dev`.

   Both present ⇒ D10 is a cheap closer, take it. Still blocked at session close ⇒
   **D10 is not yours**; say so explicitly and open it as a GitHub issue, which is
   what the rider table's row 3 requires so it cannot evaporate with the backlog.
   Do NOT cherry-pick, and do NOT assemble the merged tree by hand — a real merge
   is fine, a hand-built one is what the item forbids.
2. **D11 — MED, a DESIGN DECISION, and the one I would not defer again.** It is
   the third distinct symptom of one design, and three review rounds have each
   patched the release instead. **Do not make it four.** Read D11's section for
   the three costed options and why the door exists at all (a recycled pid can
   never be proven dead, so removing the door trades a rare window for a
   guaranteed permanent wedge). Its verification demands **two real `bun`
   subprocesses against one real lock directory with a real backdated mtime
   (`utimesSync`)** — Session B's tests simulate a reclaim by writing the file in
   one process, which is faithful for the release but cannot exercise a
   genuinely concurrent holder.
3. **D8 — spec reconciliation, and the only item needing REAL MODEL SPEND.**
   Partly pre-decided: `teardown_at_pause_ms` is emitted by `emitPause` only when
   `deps.teardown` actually ran, and is deliberately ABSENT (not `0`) otherwise,
   because the one shipped caller (`recordApprovalPort`,
   `src/reverify/runner.ts:406`) passes no seam. Live evidence shows it at
   **8454 ms** when a real seam IS passed. That is the empirical half of "does ANY
   caller reach the gate with a live box": **the live TEST does; no shipped caller
   does.** What remains is the decision (a) vs (b) and the stale comment fix.
   **TIER-2 ⇒ the spend gate applies: print the worst-case estimate, get an
   explicit operator "go" BEFORE dispatching.**
4. **D9 — LOW.** Do (1) (enforce the entropy assumption at enrolment) before
   reaching for (2) (a work factor), which invalidates every enrolled allowlist
   and needs a migration story, an operator note and a rollback plan.

**NON-NEGOTIABLE STANDARDS**

- Enterprise-grade, long-term-correct. No band-aids. No abstraction without a
  second caller — but when there IS one, the logic goes in the shared callee.
- **Root-cause, not symptom.** Check every caller before editing a function.
- **NO FAKES IN THE PROOF.** D8's substrate is a real box → real dispatch → real
  DF2.5 teardown → real host-side reverify → real gate. D11's is two real
  processes. A simulated concurrent holder proves the simulation.
- **Honest gaps beat fake greens.** Session A wrote one for
  `teardown_at_pause_ms`; Session B for the file-level foreign-owner arm; Session
  C stated why `ONLY_REACHABLE_ELSEWHERE` could not be honestly shrunk. Do the
  same rather than inventing a pass.
- **Capture `bun test` output to a file** — CLAUDE.md requires it:
  ```bash
  bun test > /tmp/qds-test.log 2>&1
  tr '\r' '\n' < /tmp/qds-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
  ```
  The `tr`/`perl` step is not optional: bun writes CRs and ANSI colour, so a
  plain `grep '(fail)'` over a raw log matches nothing and reads as "no failures".
- Impact analysis before editing any function; warn on HIGH/CRITICAL.
- Gates before any commit: full `bun test`, `bunx tsc --noEmit`,
  `bunx biome check src/ scripts/ tests/`, `detect_changes` with the blast radius
  reviewed **symbol by symbol against `git diff`** — symbols report `touched` from
  line-offset shift or adjacency alone, and comment-only edits drive a `high`
  aggregate over ten processes for zero behaviour change (Session B's D7 and
  Session C's D5 are both worked examples).
- Branch convention: `feature/` prefix, base `dev`, target `dev`.

**THE ONE KNOWN PRE-EXISTING FAILURE**

`tests/fleet/cli.test.ts` → `a fleet-busy race refusal creates NO loser cost
ledger (INV-2: the money file follows admission)`, timing out at its own 20 s
bound, **under full-suite contention only**. It passes 155/155 when the file runs
alone, with or without a diff — Session C verified both halves again. If you see
exactly that one, verify it the same way (`git stash push src/ scripts/ tests/`,
run the file, `git stash pop`, then confirm the tree is restored) and report it.
Third symptom of issue #138.

**Any other failure is yours.** Session B's second failure looked pre-existing
too — it reproduced on the pristine base commit — and turned out to be a fixable
environment-coupled test defect. "Pre-existing" is where an investigation starts,
not where it ends.

**VERIFICATION PLAN (real, no fakes)**

- **D11:** two real `bun` subprocesses, one real lock dir, real backdated mtime
  via `utimesSync`; assert what EACH observes. For option (a), the evicted holder
  must abort rather than complete its mutation.
- **D8:** a real end-to-end run — real box → real dispatch → real DF2.5 teardown →
  real host-side reverify → real gate — asserting the record's
  `vmName`/`closedAt`/`keyHash` at the moment `requestApproval` is entered. That
  is the only way to settle (a) vs (b) factually rather than by reading comments.
- **D9:** real allowlist files on a real filesystem: enrol, authenticate, and — if
  (2) — prove a v1 entry still authenticates after the upgrade and is rehashed to
  v2 on next use. Real `fleet approve` subprocess with a real token over real
  stdin.
- **D10:** `bun test tests/fleet/approvers.test.ts` green with **NO test edits**.
  That is the whole proof. If a test needs changing, the delegation is wrong —
  stop and find out why.
- Spend protocol for any TIER ≥ 2: worst-case estimate printed, explicit operator
  "go", every key revoked in `finally`, every box destroyed in `finally`,
  `final-ls` asserted empty.

**SESSION D ENDS WITH**

1. This tracking doc updated: status board ticked, an `### Outcome` block under
   each closed item with the commit SHA, verbatim gate results, evidence paths,
   and every honest gap.
2. Full gate green, commit naming which D-items closed, ending with
   `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
3. Push, update the PR, post a summary comment, request CodeRabbit re-review.
4. **A GitHub issue for anything still open** — the backlog ends here, so an
   unclosed item with no issue simply disappears. D10 specifically, per its rider
   table.

**WHAT SESSIONS A–C LEARNED THAT CHANGES THESE ITEMS**

- **Exit 6 is a RETURN, never a throw** (D5). It means "the work LANDED but the
  invocation could not finish or report it", and every 6 site emits TWO outputs —
  the completion line through `reportCompletion` AND a stderr diagnostic. A
  thrown `FleetError` renders only the envelope. `FleetError.exitCode` stays
  `1|2|3|4|5` at BOTH declarations and `tests/fleet/verbs.test.ts` now reds if
  either widens or if anything constructs a `FleetError(6`. If D8 or D9 needs to
  report landed-work-with-a-leftover, **return it and let the verb fold it** —
  do not throw it.
- **A real EPIPE reaches exit 6 without a throwing-sink rig**:
  `bun scripts/fleet.ts <verb> … | (exec true)` → `PIPESTATUS[0]=6`. That is the
  lever for making `ONLY_REACHABLE_ELSEWHERE`'s five remaining exit-6 excuses
  probeable out of process, if a session ever restructures `verbs.test.ts`'s
  in-process probe table. Session C did not, and said why.
- **`listedKeyHashes()` now THROWS on a truncated listing** (D6) and takes an
  optional `maxPages` defaulting to `MAX_VERIFY_PAGES`. Any live test that cannot
  enumerate the whole key population now fails loudly instead of reporting a
  false `leaked: []`. The real account currently holds **7 keys, `truncated:
  false` at 20 pages**, so D8's TIER-2 round has plenty of headroom — but if you
  see `key-list-truncated`, the account has grown and needs pruning, not a
  raised bound.
- **`teardown_at_pause_ms` is D8's, and half-decided already** — see the scope
  note above. Whatever D8 decides, D1's emit must be reconciled with it.
- **`hashToken` has a second consumer**: `tests/fleet/gate-verbs.test.ts`'s D7
  fixture. If D9 changes the formula the fixture follows automatically (which is
  the point of using the exported function), but D9's option (2) versioned-entry
  migration must account for it.
- **`dispatchRequestId` is the gate-event join key**, on every gate event.
  Producers: `emitPause` (`src/fleet/approval-gate.ts`) and `gateEvent`
  (`scripts/fleet.ts`). `tests/fleet/gate-verbs.test.ts`'s `gateEvent union ↔
  producers` reds if a declared member loses its producer.
- **`src/providers/` is the established neutral home** when two peer subsystems
  need the same logic — `boundedEcho`/`MAX_ECHO` in `step-log.ts`, the shared
  path guard in `allowlist-path.ts`. Reach for it before coupling `src/pr/` to
  `src/fleet/` in either direction.
- **An in-process test that lets the CLI read fd 0 is broken by construction.**
  `scripts/fleet.ts` reads `Bun.stdin.stream()` with no seam, so such a test
  depends on the ambient stdin of whoever ran `bun test`. Use the `cli()`
  subprocess helpers in `tests/fleet/gate-verbs.test.ts` with an explicit pipe.

---

## Handoff — Session C

Copy the block below into a fresh conversation.

---

Work the QDS-Factory DF3.4 deferred-remediation backlog, **Session C**.

**READ FIRST, IN THIS ORDER**

1. `_bmad-output/plans/2026-08-29-df3-4-deferred-remediation.md` — this tracking
   document, the single source of truth. Read ALL of it, including Sessions A
   and B's five `### Outcome` blocks. Three rulings there you will be asked to
   apply again: when a shared callee is earned (D1's `boundedEcho`, D4's
   `readGuardedFile`), what "additive" must mean when another story compares
   against a shape (D2), and **that a deferred item's stated premise may simply
   be false — D7's was, and only a real subprocess revealed it.**
2. `.claude/skills/qds-live-e2e/SKILL.md` — **mandatory**, because D6 ends in a
   live round against the real OpenRouter account. Gotcha #4 (leaked
   `.sandbox/fleet.lock`) and #5 (suite-under-load flakes) have now cost time in
   three consecutive sessions.
3. `src/providers/credentials.ts:104-106` — the `KeyApi` contract D6 says is
   being violated. Read the contract before reading the violation.
4. `tests/fleet/verbs.test.ts`'s `ONLY_REACHABLE_ELSEWHERE` before touching D5.
   The goal is to SHRINK it, not duplicate it.

**SITUATION**

Two PRs are open and they are independent:

- **#169** (`feature/df4-allowlist-path-guards` → `dev`) — D4, the HIGH
  authorization fix. Commit `483a3e3`.
- **#150** (`feature/df3-4-approval-gate-attach-steering` → `dev`) — DF3.4 plus
  Sessions A and B's work.

Backlog is **5 / 10**. D3, D1, D2 closed in Session A; D4, D7 in Session B; D10
is new, opened by D4.

**GitNexus is reliable** — `impact()` resolves this branch's symbols to their
real files, so ground rule 6 is in force: run it, do not fall back to grep.
Caveat unchanged: the index is BM25-only on this host (no `--embeddings`, issue
#74), so `query()` can miss symbol-name-only hits; `impact`/`context`/
`detect_changes` are unaffected.

**Before you start:** CodeRabbit was asked for a full re-review of both #169 and
#150. Check `gh pr view 169 --comments` and `gh pr view 150 --comments` and
triage anything filed against Session B's diff first. Note the shape Session B
used: a finding can be **real while its suggested remedy is wrong** — the lock
finding was exactly that. Verify every finding against source, fix the real ones,
and dismiss the rest in writing with the source cited.

**SESSION C SCOPE — D5, then D6, then D11 if there is room. D10 only if its merge
precondition is met (checked below, it was NOT at Session B's close).**

- **D5 — LOW, one token with a wide read surface.** `FleetError.exitCode` is
  typed `1|2|3|4|5` (`src/fleet/dispatch.ts:207`) while `report()` accepts and
  documents 1–6. That mismatch is WHY round 6 had to express the attach append
  failure as a returned result rather than a typed throw. **There are TWO
  declaration sites, not one** — Session B found the write-up had missed
  `src/fleet/dispatch.ts:918`, the local `refuse` helper, which declares the
  identical union independently. `grep -rn "1 | 2 | 3 | 4 | 5" src/ scripts/
  tests/` returns exactly those two and is the check that both moved. **The value
  is in the audit, not the edit** — widen both, then read every `FleetError`
  construction and every `report()` arm. Do NOT reflexively convert
  `attachToRun`'s `send-failed` result into a throw: its `reason` field is what
  the remediation branches on, and a bare exit code loses it.

- **D6 — MED, test soundness on a real-money path.** `listedKeyHashes()` in
  `tests/fleet/e2e/live-harness.ts` calls `keyApi.listAllKeys(10)`. The `10` is
  **pages, not entries**, and `listedKeyHashes` **discards `truncated`**. So on
  a large account both the leak baseline and the delta are computed over a
  partial population and a leaked key can hide in the unlisted remainder. Round
  6 made the leak delta assert, which means it now *looks* authoritative while
  still being unsound at scale.
  - A truncated listing must **fail loudly**, not under-report. A key-leak check
    that cannot see the whole population must refuse to render a verdict —
    silence means "we did not look", which is the opposite of what an empty
    `leaked` array claims.
  - Audit for the same discard elsewhere: `grep -rn "listAllKeys" tests/ src/`.
  - **Session A's live evidence is implicated.** Its TIER-1 round asserts
    `leaked: []` from this very function, and every green leak check in
    `_bmad-output/evidence/df3-e2e/` shares that ceiling. Say so in the outcome
    block — whether those greens were sound depends on the real account's page
    count, which D6's live round is what actually measures.

- **D11 — MED, and a DESIGN DECISION. Do not write code until it is made.**
  CodeRabbit escalated Session B's lock fix: the residual `statSync`→`rmSync`
  window is not a release bug, it is a symptom of the `age > LOCK_ABANDON_MS`
  door reclaiming a lock from a holder that may still be running `body()`. Once
  that door fires mutual exclusion is already gone by design. **Three review
  rounds have each patched the release; do not make it four.** Read D11's
  section for the three costed options and why the door exists at all (a
  recycled pid can never be proven dead). If Session C runs out of room, hand
  D11 to Session D rather than half-doing it.

- **D10 — check the precondition FIRST, it is one command.** At Session B's
  close **both #169 and #150 were still OPEN**, so `src/providers/allowlist-path.ts`
  is NOT on `dev` and D10 was OUT OF SCOPE. Re-check:
  `git fetch origin dev && git cat-file -e origin/dev:src/providers/allowlist-path.ts`
  and the same for `origin/dev:src/fleet/approvers.ts`. Both present ⇒ D10 is a
  good closer for this session. Either absent ⇒ D10 is not yours; say so
  explicitly and re-assign it per the rider table in the Session plan section.

**NON-NEGOTIABLE STANDARDS**

- Enterprise-grade, long-term-correct. No band-aids. No abstraction without a
  second caller — but when there IS one, the logic goes in the shared callee.
- **Root-cause, not symptom.** Check every caller before editing a function.
- **NO FAKES IN THE PROOF.** D6's substrate is the real OpenRouter API against
  the real account. A stubbed `truncated: true` proves the assertion fires, not
  that the API ever produces it.
- **Honest gaps beat fake greens.** Session A wrote one for
  `teardown_at_pause_ms`; Session B wrote one for the file-level foreign-owner
  arm. Do the same.
- **Capture `bun test` output to a file** — `CLAUDE.md` now requires it. A bare
  run whose failure names scroll off costs a second 10-minute run, and a plain
  `grep '(fail)'` over a raw bun log silently matches nothing.
- Impact analysis before editing any exported symbol; warn on HIGH/CRITICAL.
- Gates before any commit: full `bun test`, `bunx tsc --noEmit`,
  `bunx biome check src/ scripts/ tests/`, `detect_changes` with the blast
  radius reviewed **symbol by symbol against `git diff`** — many symbols report
  `touched` from line-offset shift or adjacency alone, and comment-only edits
  can drive a `high` aggregate over ten processes for zero behaviour change
  (Session B's D7 is the worked example).

**THE ONE KNOWN PRE-EXISTING FAILURE**

`tests/fleet/cli.test.ts` → `a fleet-busy race refusal creates NO loser cost
ledger (INV-2: the money file follows admission)`, timing out at its own 20 s
bound, under full-suite contention only. It passes 155/155 when the file runs
alone, with or without a diff. If you see **exactly** that one, verify it the
same way (`git stash push src/ scripts/ tests/`, run the file, pop) and report
it. **Any other failure is yours** — and note Session B's second failure looked
pre-existing too and turned out to be a fixable environment-coupled test defect,
so "pre-existing" is a starting point for the investigation, not its conclusion.

**VERIFICATION PLAN (real, no fakes)**

- **D5:** real subprocess invocations asserting real exit codes on the paths that
  produce each of 1–6. Shrink `ONLY_REACHABLE_ELSEWHERE` by the codes you can now
  probe directly; whatever remains stays bound to a named behavioural case.
- **D6:** real OpenRouter API, real account. If the account has fewer than 10
  pages (likely), prove the guard by **lowering the bound** — `listAllKeys(1)`
  against an account with more than one page produces a **real** truncated
  response from the real API, and the assertion must fail loudly. That is a real
  proof, not a stubbed one. Then restore the production bound and confirm green.
  Fold into a TIER-1 round; zero model spend, boxes only.
- Spend protocol applies to any TIER ≥ 2: print the worst-case estimate, get an
  explicit operator "go", revoke every key in `finally`, destroy every box in
  `finally`, assert `final-ls` is empty.

**SESSION C ENDS WITH**

1. This tracking doc updated: status board ticked, an `### Outcome` block under
   D5 and D6 with the commit SHA, verbatim gate results, evidence paths, and
   every honest gap.
2. Full gate green, commit naming which D-items closed, ending with
   `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
3. Push, update the PR, post a summary comment, request CodeRabbit re-review.
4. A `## Handoff — Session D` section (D8 + D9) appended with this same rigor.

**WHAT SESSIONS A AND B LEARNED THAT CHANGES LATER ITEMS**

- **D10 is blocked on a MERGE, not on work — a dependency class this backlog has
  not had before.** It cannot start until #169 AND #150 are both on `dev` (or
  `dev` is merged into #150's branch), and no session controls that; it is an
  operator action. Read the "D10 is a different KIND of item" table in the
  Session plan section: D10 is a **rider**, closed by whichever of C or D first
  finds the precondition met, and opened as a GitHub issue at Session D's close
  if neither could. **Do not drop D5 or D6 to make room for it, and do not report
  Session C complete while silently skipping it** — say which row of that table
  applies. Its acceptance test is that `tests/fleet/approvers.test.ts` goes green
  with **no test edits**; if a test needs changing, the delegation is wrong.
  **Check the precondition FIRST** (`git log origin/dev --oneline | grep -i
  allowlist-path`, or just look for `src/providers/allowlist-path.ts` on `dev`) —
  it is one command, and knowing the answer at the start of the session is what
  decides whether D10 is in scope at all.
- **D8 is partly pre-decided.** `teardown_at_pause_ms` is emitted by `emitPause`
  only when `deps.teardown` actually ran, and is deliberately ABSENT (not `0`)
  otherwise, because the one shipped caller (`recordApprovalPort`,
  `src/reverify/runner.ts:406`) passes no seam. Live evidence shows it at 8454 ms
  when a real seam IS passed. That is the empirical half of D8's "does ANY caller
  reach the gate with a live box": the live TEST does, no shipped caller does.
- **D9 gets a new neighbour.** `hashToken` is now also used by
  `tests/fleet/gate-verbs.test.ts`'s D7 fixture. If D9 changes the formula, that
  fixture follows automatically — which is the point of using the exported
  function — but the versioned-entry migration in D9's option (2) must account
  for it.
- **`dispatchRequestId` is the gate-event join key**, on every gate event. Two
  producers: `emitPause` (`src/fleet/approval-gate.ts`) and `gateEvent`
  (`scripts/fleet.ts`). `tests/fleet/gate-verbs.test.ts`'s `gateEvent union ↔
  producers` goes red if a declared member loses its producer.
- **`boundedEcho`/`MAX_ECHO` live in `src/providers/step-log.ts`**, and the
  shared path guard lives in `src/providers/allowlist-path.ts`. `src/providers/`
  is the established neutral home when two peer subsystems need the same logic —
  reach for it before coupling `src/pr/` to `src/fleet/` in either direction.
- **An in-process test that lets the CLI read fd 0 is broken by construction.**
  `scripts/fleet.ts:741` reads `Bun.stdin.stream()` with no seam, so any such
  test depends on the ambient stdin of whoever ran `bun test`. Use the `cli()`
  subprocess helper in `tests/fleet/gate-verbs.test.ts` with an explicit pipe.

---

## Handoff — Session B

Copy the block below into a fresh conversation.

---

Work the QDS-Factory DF3.4 deferred-remediation backlog, **Session B**.

**READ FIRST, IN THIS ORDER**

1. `_bmad-output/plans/2026-08-29-df3-4-deferred-remediation.md` — this tracking
   document, the single source of truth. Read ALL of it, including Session A's
   three `### Outcome` blocks: they record two rulings you will be asked to apply
   again (when a shared callee is earned, and what "additive" has to mean when
   another story compares against a shape).
2. `.claude/skills/qds-live-e2e/SKILL.md` — mandatory before any live round.
   Gotcha #4 (leaked `.sandbox/fleet.lock`) bit Session A too; the holder pid was
   dead and `rm` was the documented fix.
3. `_bmad-output/evidence/df3-4-review-round-6/triage.md` — the 142→61 ledger
   these items were deferred out of.
4. `src/fleet/approvers.ts` **in full** before touching D4. It is the pattern you
   are lifting, and it is the round-6 hardened version — the one that fixed a
   guard which walked only ONE ancestor.

**SITUATION**

PR #150 (`feature/df3-4-approval-gate-attach-steering` → `dev`) is open. Session A
landed D3 + D1 + D2 on it: the GitNexus reindex, the `pause` gate event and its
cross-process `dispatchRequestId` join (proven TIER-1 live on a real exe.dev box),
and `VerbFlag.note` declaring `attach --message`'s `-` stdin sentinel. Gates at
that commit: 4117 pass / 1 pre-existing fail (proven pre-existing against the base
commit — see "Session A — gates"), tsc 0, biome clean.

**GitNexus is now reliable.** `impact()` resolves this branch's symbols to their
real files, so ground rule 6 is back in force — run it, do not fall back to grep.
Caveat: the index is BM25-only on this host (no `--embeddings`, issue #74), so
`query()` can miss symbol-name-only hits; `impact`/`context`/`detect_changes` are
unaffected.

**SESSION B SCOPE — D4, then D7.**

- **D4 — HIGH, authorization.** `resolveRepoEntry` (`src/pr/repos.ts:87`) decides
  which repository the factory opens a PR against, and checks **only the file's
  mode bits**. Anchors: `resolve(hostRoot, file)` at `:88` (no containment),
  `statSync(path)` at `:98` (no `isFile()`), `(st.mode & 0o077) !== 0` at `:105`
  (no directory check, no ownership check). Refusals go through
  `PrRefusalError("allowlist", …, {securityEvent: true})` (`:48-60`) — keep that
  shape so no downstream `switch` needs updating.
  - **Own branch, own PR.** It is a HIGH authorization finding on a different
    subsystem than PR #150; do not bury it in a 12-file DF3.4 PR.
  - The pattern to lift, with current line anchors:
    `src/fleet/approvers.ts` — lexical containment `:164-167`, the ancestor walk
    up to and including `hostRoot` `:191-233` (`0o022`, WRITE bits, not an exact
    0700 — read the comment at `:200`), the `process.getuid?.()` ownership guard
    `:220`, `st.isFile()` **before** the mode check `:268`, mode `:279`.
  - **The `isFile()`-before-mode ordering is load-bearing**, not style: a FIFO
    reports 0600 as readily as a file, so mode-first still reaches
    `readFileSync` and blocks with no timeout.
  - **On extracting a shared guard:** Session A's precedent is
    `src/providers/step-log.ts`'s `boundedEcho` — the body moved to a shared
    callee at the moment a genuine second caller appeared, and the original call
    site became a one-line delegation so no call sites churned. Apply the same
    test here: if the two implementations would otherwise diverge (they already
    did — that is this finding), extract. Weigh the home carefully:
    `src/pr/` importing `src/fleet/` is the wrong direction, and
    `src/providers/` is the neutral one both already depend on.

- **D7 — LOW, deliberate decision.** `submitDecision` reads through
  `readApproval` (`src/fleet/approval-gate.ts:361`) which does NOT catch ENOENT,
  while `readApprovalIfPresent` (`:366`) does and is what `sweepExpired` and
  `awaitDecision` use. So `fleet approve --run <typo>` surfaces a raw
  `unreadable run record …: ENOENT` where an EXISTING run with no approval
  namespace gets the classified `{outcome:"not-decidable", state:"absent"}`
  (`:810`). Round 6 PINNED the current behaviour rather than changing it. Decide
  deliberately and record it; if you classify, map it to exit 4 with a
  remediation naming the run id and update the round-6 pin in the same commit.
  Either way the lock must still be released — round 6 pinned that, keep it.

**NON-NEGOTIABLE STANDARDS**

- Enterprise-grade, long-term-correct. No band-aids. No abstraction without a
  second caller — but when there IS one, put the logic in the shared callee.
- **NO FAKES IN THE PROOF.** D4 is a filesystem authorization guard, so the proof
  is a real filesystem: real `mkdtemp` roots, real `chmod`, real `mkfifo`, real
  mode bits. No `fs` mocking anywhere in D4's tests.
- Where something cannot be proven on this substrate, **say so**. The
  foreign-owner arm is very likely unprovable on a single-uid host: prove
  self-owned-accepted and root-owned-accepted, and state the gap. Session A left
  a written gap for `teardown_at_pause_ms`; do the same rather than a fake green.
- Gates before any commit: full `bun test`, `bunx tsc --noEmit`,
  `bunx biome check src/ scripts/ tests/`, `detect_changes` with the blast radius
  reviewed symbol by symbol. All four green or no commit — **except** the known
  pre-existing `cli.test.ts` fleet-busy timeout documented in "Session A —
  gates". If you see exactly that one, verify it against the base commit the way
  Session A did (`git stash push src/ scripts/ tests/`, run the file, pop) and
  report it; if you see any OTHER failure, it is yours.
- Branch convention: `feature/` prefix, base `dev`, target `dev`.

**VERIFICATION PLAN (real, no fakes)**

- Real 0777 ancestor above a correct 0700 dir ⇒ refused, offender named.
- Real `mkfifo` at the allowlist path ⇒ refused, and **does not hang** — assert
  with a real timeout, because a passing-by-blocking test looks identical to a
  hang until CI dies.
- Real absolute-path and real `../` escapes ⇒ refused.
- Real BOM-prefixed and real schema-invalid files ⇒ the existing refusals still fire.
- **The happy path still works end to end** — a real invocation against a
  correctly-provisioned allowlist, so the hardening is not proven only by its
  refusals. This is the one that catches an over-tight guard.
- D7: a real store on a real temp dir with a genuinely absent record, and a real
  `bun scripts/fleet.ts approve` **subprocess** asserting the real exit code and
  the real stderr text. Session A's `D2 —` describe in
  `tests/fleet/gate-verbs.test.ts` has a ready-made `sh -c` subprocess helper
  with a genuine FIFO on fd 0 — reuse its shape.
- No live box is required for either item. If you run any live tier anyway, the
  spend protocol in the skill applies.

**SESSION B ENDS WITH**

- This tracking doc updated: status board ticked, an `### Outcome` block under D4
  and D7 with the commit SHA, verbatim gate results, and every honest gap.
- Commit, push, open the D4 PR (and update #150 if D7 lands there), request
  CodeRabbit re-review.
- A `## Handoff — Session C` section (D5 + D6) appended with this same rigor.

**THINGS SESSION A LEARNED THAT CHANGE LATER ITEMS**

- **D8 is now partly pre-decided.** `teardown_at_pause_ms` is emitted by
  `emitPause` only when `deps.teardown` actually ran, and it is deliberately
  ABSENT (not `0`) otherwise — because the one shipped caller
  (`recordApprovalPort` at `src/reverify/runner.ts:406`) passes no seam. D8 must
  decide whether the field belongs in the Observability Contract at all or is
  documented as gate-owned-teardown-only. The live evidence
  (`…-012459-t1-7-approval-gate.json`) shows it at 8454 ms when a real seam IS
  passed, which is the empirical half of D8's "does ANY caller reach the gate
  with a live box" question: the live TEST does, no shipped caller does.
- **D6 gets a nearby ally.** Session A's live round asserts `leaked: []` from
  `listedKeyHashes()` — the very function D6 says is unsound at scale. Every
  green leak check in `_bmad-output/evidence/df3-e2e/` shares that ceiling.
- **`dispatchRequestId` is now the gate-event join key** and is on every gate
  event. If Session C or D adds one, carry it; `emitPause` in
  `src/fleet/approval-gate.ts` and `gateEvent` in `scripts/fleet.ts` are the two
  producers, and `tests/fleet/gate-verbs.test.ts`'s `gateEvent union ↔ producers`
  will fail if a member loses a producer.
- **`boundedEcho`/`MAX_ECHO` now live in `src/providers/step-log.ts`.** Any new
  refusal or log line that echoes an operator-supplied id should use it rather
  than a third copy of redact-then-cap.
