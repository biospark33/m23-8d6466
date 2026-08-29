# DF3.4 Deferred Remediation — tracking document

**Created:** 2026-08-29 · **Origin:** `bmad-code-review` round 6 on PR #150 (`9f09a87`, `4d362bd`)
**Owner:** rolling, one session per group · **Status:** 3 / 9 complete (Session A closed 2026-08-28)

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
| D5 | `FleetError.exitCode` typed `1\|2\|3\|4\|5` vs `report()`'s 1–6 | LOW | C | ☐ |
| D6 | `listedKeyHashes()` discards `truncated` — key-leak check unsound | MED | C | ☐ |
| D8 | AC1(b) teardown ordering is vacuous in the only shipped caller | spec | D | ☐ |
| D9 | `hashToken` single-round sha256, no work factor | LOW | D | ☐ |
| D10 | `approvers.ts` still has its own copy of the path guard D4 extracted | consistency | C or D (rider) | ☐ |
| D11 | `LOCK_ABANDON_MS` reclaims a lock whose holder may still be executing | MED | C or D | ☐ |

**Status: 5 / 11 complete.** D10 is NEW, opened by D4 — see its Outcome block for why it
could not be closed in the same session. D11 is NEW, opened by CodeRabbit against
Session B's lock fix; it is a DESIGN DECISION and deliberately not a patch.

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
