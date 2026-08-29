# DF3.4 Deferred Remediation — tracking document

**Created:** 2026-08-29 · **Origin:** `bmad-code-review` round 6 on PR #150 (`9f09a87`, `4d362bd`)
**Owner:** rolling, one session per group · **Status:** 0 / 9 complete

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
6. **Impact analysis before editing any exported symbol** (`impact({target, direction:"upstream"})`).
   **Blocked today by D3** — until the reindex lands, fall back to grep and SAY SO
   in the report rather than reporting a false LOW.
7. **Root-cause, not symptom.** If a fix belongs in a shared callee, put it there —
   one guard in the shared function beats a guard in every caller.
8. **No new abstractions without a second caller.** These are nine small, sharp
   fixes. Resist building a framework for them.

---

## Status board

| ID | Item | Sev | Session | Status |
|----|------|-----|---------|--------|
| D3 | GitNexus index stale + corrupted | tooling | A | ☐ |
| D1 | `pause` gate event never emitted; `record_write_ms` absent | MED | A | ☐ |
| D2 | `--message -` undeclared sentinel; `VerbFlag` cannot express it | MED | A | ☐ |
| D4 | `src/pr/repos.ts` allowlist has NO dir-mode, ownership, isFile or containment check | **HIGH** | B | ☐ |
| D7 | `submitDecision` raw ENOENT on a nonexistent run | LOW | B | ☐ |
| D5 | `FleetError.exitCode` typed `1\|2\|3\|4\|5` vs `report()`'s 1–6 | LOW | C | ☐ |
| D6 | `listedKeyHashes()` discards `truncated` — key-leak check unsound | MED | C | ☐ |
| D8 | AC1(b) teardown ordering is vacuous in the only shipped caller | spec | D | ☐ |
| D9 | `hashToken` single-round sha256, no work factor | LOW | D | ☐ |

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
  key-accounting truncation is loud, not silent.
- **Session D — Design decisions.** D8 + D9. Needs a real end-to-end reverify run
  (box → teardown → reverify → gate) and a real allowlist migration.

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

---

## D5 — `FleetError.exitCode` cannot express exit 6

**Severity:** LOW · **Session:** C

### What is wrong

`FleetError.exitCode` is typed `1|2|3|4|5` (`src/fleet/dispatch.ts:207`) while
`report()` accepts and documents 1–6. That mismatch is **why** round 6 had to express
the attach append failure as a returned result rather than a typed throw — the
library layer literally cannot throw an exit-6 refusal.

### Acceptance criteria

- [ ] Widen to `1|2|3|4|5|6`.
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
