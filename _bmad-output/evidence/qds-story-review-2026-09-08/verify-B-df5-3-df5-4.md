# Verify-B — DF5.3 (audit chain) ↔ DF5.4 (lights-on gate)

**Reviewer:** verify-B (dependency-pair, emitter↔asserter reciprocity)
**Date:** 2026-09-08 · **Branch:** `dev` @ `fa7d0e2` · **Mode:** read-only, no edits
**Scope:**
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-3-audit-chain-extended.md`
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-4-lights-on-gate.md`

**Counts:** BLOCKER 7 · HIGH 8 · MEDIUM 6 · LOW 2 (23 total)

---

## 0. Method and what was actually opened

Every citation in both stories was resolved against shipped source, not against the
story's description of it. Files read in full or in cited range:

`src/gate/gate-runner.ts` (full), `src/gate/verifier-child.ts`, `src/gate/assertions/lib/verdict.ts`,
`src/gate/assertions/p0-3-mixed-model.ts`, `scripts/phase0-exit-gate.ts`,
`src/providers/{credentials,driver,harvest,teardown,reaper,cost-ledger,run-record,budget-gate}.ts`,
`src/phase-engine/trace/{schema,tracer,migrations,reader}.ts`, `src/fleet/{approval-gate,dispatch}.ts`,
`src/reverify/{report,runner}.ts`, `scripts/fleet.ts`,
`docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (full, incl. Appendices A and B),
`docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` (D8 `:305`, §6 item 4 `:389`,
item 6 `:395`, §8 step 5 `:454`, R9 `:488`, F10 `:531`),
`docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` (DD-4 `:50`, DD-7 `:53`, DD-8 `:86`,
DD-9 `:87`), `_bmad-output/sprint-artifacts/sprint-status.yaml`.

**`src/audit/` does not exist** — confirmed (`ls src/audit/` → No such file or directory). The prior
finding is correct. `scripts/qds-audit.ts`, `scripts/df5-lights-on-gate.ts` and
`scripts/dev/capture-run-of-record.ts` likewise do not exist. All three are net-new here, correctly.

**Citation accuracy is unusually good and should be recorded as such.** ~40 file:line citations were
resolved by reading. Exactly one is off by one line (V-DF5.3-L1). The chassis citations
(`gate-runner.ts` `:39 :45 :51 :66-68 :77 :88 :117 :130 :144 :167-178 :208-215 :211-212 :324-326`),
the credentials event sites (`:144 :244 :286 :514 :535 :595 :652 :685`), `cost-ledger.ts:448 :722-723
:729-730 :885-921 :941-949 :1335`, `run-record.ts:139 :151 :216 :228-238 :285-292 :299-315 :1178`,
`teardown.ts:94 :279-287 :463`, `harvest.ts:18-19 :372 :1018/:1068`, `reaper.ts:140 :391`,
`driver.ts:549 :905 :935 :1066 :1076 :1086`, `trace/schema.ts:34-35 :84-93` are all **exact**.
The defects below are not citation rot. They are defects of *reasoning about what the cited code does
on a real run* — which is a harder and more dangerous class.

Also verified byte-identical between the two files (no drift):
- the shared `"Reconstructable" is defined once` paragraph (df5-3:38-44 ↔ df5-4:41-47) — identical modulo line wrap;
- the `OQ4_VOID_REASON` literal (df5-3:182-186 ↔ df5-4:167-169) — identical modulo line wrap.
The Reciprocity paragraphs differ in wording but not in content; that is fine (each is written from its
own side) and no finding is raised.

---

## BLOCKERS

### V-DF5.3-B1 — Hop 5's box-lifecycle event set names four functions that no production dispatch calls. The happy path can never produce a complete chain.

**Severity:** BLOCKER
**File:** `df5-3-audit-chain-extended.md:149` (Trigger Surface row 2), `:174` (hop 5), `:314-317` (DoD Integration)

**Defect.** Hop 5 is specified as `create→fill→setup→execute→observe→teardown→reap`, with emitters at
`driver.ts` `createRun :905`, `fillRun :935`, `setupRun :1066`, `executeRun :1076`, `observeRun :1086`.
Four of those five have **no production caller**:

```
createRun   → scripts/cap-hit-demo.ts:518 only (a demo script)
fillRun     → src/fleet/dispatch.ts:2986  ✅ real
setupRun    → ZERO callers anywhere in src/ or scripts/
executeRun  → scripts/cap-hit-demo.ts:757, :937 only
observeRun  → ZERO callers anywhere in src/ or scripts/
```

The real host-side lifecycle is in `src/fleet/dispatch.ts`:

```
:2377  within("headroom", …)
:2683  provisionAdmittedRun(…)          ← this is "create", not createRun
:2986  within("fill",  () => fillRun(…)) ← the only listed emitter that fires
:3023  within("gate",  …)                ← DF3.1's setup gate, not setupRun
```

`execute` and `observe` moved **into the box** with DF1.10 (ADR consequence 2; the engine runs under
the per-run systemd unit and its output leaves via DF2.5's tar, not via `observeRun`). There is no
host-side execute or observe step left to emit at.

**Concrete failure.** On a healthy merged-PR run the walker finds link rows for `fill` and `teardown`
and nothing else. AC3 (`:104-112`) types a never-emitted link as `unlinked`, and states `unlinked` is a
**broken** outcome that fails the chain and exits non-zero. Therefore:
- DF5.3's own E2E slice (`:48-55`, "ten hops, zero nulls, exit `0`, under 30 s") is **unachievable**;
- DF5.3 AC1 can never pass on real evidence;
- DF5.4-C9 (`df5-4:131`) requires zero `unlinked` hops → **the lights-on gate is red forever**.

The story already half-knows this: the Scope note (`:78-81`) requires the emit at
`provisionAdmittedRun` (`driver.ts:549`) — the site that actually runs — while the hop table and
Trigger Surface still name `createRun :905`. That internal disagreement is the tell.

**Fix recipe.** Replace the hop 5 row (`:174`) with:

> | 5 | run → box | `create` (`provisionAdmittedRun`, `driver.ts:549` — the site `src/fleet/dispatch.ts:2683` actually calls; `createRun :905` is exercised only by `scripts/cap-hit-demo.ts`) → `fill` (`fillRun`, `driver.ts:935`, called at `dispatch.ts:2986`) → `setup-gate` (DF3.1's setup gate at `dispatch.ts:3023` — **not** `setupRun`, `driver.ts:1066`, which has zero callers repo-wide) → `teardown` (`teardown.ts:463`) → `reap` (`reaper.ts:391`, **`not-applicable` on the ordinary path — see AC5 and V-DF5.3-B2**). `execute` and `observe` are **not** host-side events post-DF1.10: the engine runs in-box under the systemd unit (ADR consequence 2) and its output leaves through DF2.5's tar, so `executeRun`/`observeRun` (`driver.ts:1076,:1086`) are not emit sites and no link is manufactured for them (INV-AUDIT-4). | DF2.1/DF2.5/DF2.6 links |

and replace the Trigger Surface `driver.ts` clause (`:149`) with:

> DF2.1 `driver.ts` (`provisionAdmittedRun` `:549` = `create`, `fillRun` `:935` = `fill`) and DF3.1
> `src/fleet/dispatch.ts:3023` (`setup-gate`)

and correct the DoD Integration bullet (`:314-317`) to name the same four sites.

---

### V-DF5.3-B2 — `reap` is a backstop event that never fires for a healthy run; requiring it as a hop-5 link breaks every clean chain.

**Severity:** BLOCKER
**File:** `df5-3-audit-chain-extended.md:174` (hop 5), `:137` (AC7 lifecycle order), `:149` (Trigger Surface), `:314-317` (DoD)

**Defect.** `src/providers/reaper.ts:2-4` states the reaper's purpose: *"the fleet-wide backstop —
enumerate everything, classify it by the three-way join (VM × key × record on the derived runId), and
**reap what nobody owns**."* Its classification set is `paired | leaked-vm | leaked-key |
stale-record` (`:92`, assigned at `:531`, `:575`, `:587`). A run that was torn down by its own
`teardownSandbox` leaves **no VM, no key, and a closed record** — the sweep classifies nothing and
reaps nothing. `sweep` (`reaper.ts:391`) never touches it.

**Concrete failure.** Same shape as B1 and it compounds it: even after B1's fix, requiring a `reap`
link makes hop 5 `unlinked` on every successfully-torn-down run → chain broken → C9 red. AC7's
mandated non-decreasing order `create ≤ fill ≤ setup ≤ execute ≤ observe ≤ teardown ≤ reap` is
likewise unsatisfiable, since three of its seven terms are absent by construction.

**Fix recipe.** In the hop 5 row (as rewritten in B1) `reap` is already marked. Add to AC5
(`df5-3:118-127`), after the sentence ending "…never a null":

> The box-lifecycle `reap` event is the canonical `not-applicable` case: `reaper.ts:2-4` reaps only
> what nobody owns, and a run torn down through `teardownSandbox` leaves no VM, no key and a closed
> record, so a healthy run is never swept. Hop 5 therefore resolves `reap` as
> `{ status: "not-applicable", reason: "record closed through teardownSandbox; the reaper collects only
> leaked-vm / leaked-key / stale-record units (reaper.ts:92)" }` when the record carries `closedAt` and
> no live VM, and as an emitted link only on the orphan path. *Negative control: an implementation that
> reports `unlinked` for `reap` on a cleanly torn-down run MUST fail this AC.*

and amend AC7's lifecycle order (`:137`) to
`create ≤ fill ≤ setup-gate ≤ teardown` (plus `≤ reap` only when a `reap` link exists).

---

### V-DF5.3-B3 — Hop 3's stated rationale is false against shipped code: an issue-less run has zero ledger rows, and AC5 declares that a broken hop.

**Severity:** BLOCKER
**File:** `df5-3-audit-chain-extended.md:160` (Infra Prereq row 2), interacting with `:118-127` (AC5)

**Defect.** The Infra Prereq row asserts:

> "…calls its `readRunCost(runId)` **method** … run-keyed, never the issue-scoped `readIssueCost`,
> **so a run dispatched without an issue still resolves hop 3**"

That conclusion does not follow, and is false. Trace the writers:

1. `src/providers/driver.ts:571` — `provisionAdmittedRun` writes `extensions.budget` **only**
   `if (opts.budget !== undefined)`.
2. `src/providers/run-record.ts:220-221` — `budget` is *"written by `createRun` when the dispatch
   carries an issue ref."*
3. `src/providers/teardown.ts:482-502` — `ingestBoxHoursIfAttributed` reads
   `rec.extensions?.budget?.{repoSlug,issueId}` and **returns `false` without writing any row** unless
   both are strings (`:493-494`).
4. `src/providers/cost-ledger.ts:961` — `ingestCostEvent`, the only writer of `kind='tokens'` rows,
   has **zero non-test callers** (F001 / #157; documented at `cost-ledger.ts:17-18`, `:1438`, `:1458`).

So a run dispatched **without** an issue ref writes **no ledger row of either kind**, and
`readRunCost(runId)` returns `hasEvents: false`. DF5.3 AC5 (`:120`) says: *"a `readRunCost` returning
`hasEvents: false` (no rows at all) is a **broken** hop, not a zero-spend one."* Hop 3 is broken; the
chain is broken; C9 is red.

The choice of `readRunCost` over `readIssueCost` is still correct — but for a *different* reason
(one run's spend, not one issue's), and it buys no tolerance of issue-less runs.

**Cross-check:** DF5.4-C1 (`df5-4:123`) already takes the opposite and correct position — *"A record
with a `runId` and no `extensions.budget` fails: a run nothing admitted is a run nothing capped."*
The pair must agree, and DF5.4 is the one that matches shipped behaviour.

**Fix recipe.** Replace the clause at `df5-3:160` reading
"run-keyed, never the issue-scoped `readIssueCost`, so a run dispatched without an issue still resolves hop 3, and never a second SUM"
with:

> run-keyed, never the issue-scoped `readIssueCost` — the hop is about *this run's* spend, not the
> issue's, and it never re-SUMs. **This buys no tolerance of an issue-less run:** `extensions.budget`
> is written only when the dispatch carries an issue ref (`driver.ts:571`; `run-record.ts:220-221`),
> and `ingestBoxHoursIfAttributed` writes no box-hours row without a string `repoSlug`/`issueId`
> (`teardown.ts:488-494`), so an issue-less run has zero ledger rows, `hasEvents` is `false`, and
> AC5 makes hop 3 a **broken** hop. That is intended and matches DF5.4-C1: a run nothing admitted is a
> run nothing capped, and it is not a run this chain can vouch for.

---

### V-DF5.3-B4 — The Observability Contract mandates joining hops 8 and 9 on `dispatchRequestId`, a key that exists in no store the walker reads, and contradicts the story's own hop table and its own preceding sentence.

**Severity:** BLOCKER
**File:** `df5-3-audit-chain-extended.md:252-260` (Observability Contract), `:333-335` (DoD cross-run join test); contradicts `:171` (hop 2), `:177` (hop 8), `:178` (hop 9)

**Defect.** `dispatchRequestId` is a **log field only**. Exhaustive repo search:

```
src/fleet/approval-gate.ts:1157,1185,1209,1225,1342,1399,1481,1521   ← emitPause() log entry
scripts/fleet.ts:1805,1880,1911,2060,2758,2795,2851,3136,3143,4016,4029 ← gateEvent() log entry
src/providers/run-record.ts:285,291                                  ← the docstring describing the above
```

There is **no column named `dispatchRequestId`** in any store the walker reads. The trace store's
seven tables (`src/phase-engine/trace/schema.ts:34,47,62,74,84,94,102` — `sessions`, `phases`,
`events`, `envelopes`, `gate_results`, `processes`, `agent_sessions`) are keyed on `request_id`
throughout. The run record has `requestId` (`run-record.ts:139`) and nothing else.

Now the two hops in question:

- **Hop 8 (approval).** Its evidence is `extensions.approval` (`run-record.ts:299-315`) inside
  `<runsDir>/<runId>.json`, reached **by runId**. DF5.4-C7 says the same. There is no join to perform
  and no stream to read. The paragraph invents a hazard for a lookup that does not exist.
- **Hop 9 (gate evidence).** Its evidence is `gate_results` rows in the **harvested, per-run** trace
  DB, and the hop table (`:178`) says explicitly *"joined on `request_id`"*. DF1.10 `:157` establishes
  the identity: *"`requestId` propagates from DF3.1's dispatch through the unit's environment onto
  every engine event … so a status row joins an in-box trace row without a second key."* Hence
  `record.requestId === sessions.request_id === gate_results.request_id`.

The stated hazard — *"can resolve a **foreign** run's rows under concurrent dispatch"* — is
**structurally impossible** for hop 9: the trace DB is created per run at `/run/trace/trace.db`
(`tracer.ts:369`) and harvested per run into `<runsDir>/<runId>-artifacts/` (`harvest.ts:1068`,
`BOX_RUN_SOURCES` `:215-216`). One run's artifacts dir contains only that run's rows.

**Worse, the paragraph contradicts itself two sentences apart.** `:253-255` states requestId "is the
walker's runId→trace-session key (the trace `sessions` table is PK'd on `request_id`)". `:255-258`
then states hops 8 and 9 must **not** use it. Hop 2 and hop 9 read the same database on the same
column.

**Concrete failure.** The mandated DoD test at `:333-335` — *"An implementation joining on `requestId`
resolves the CLI's id for both and MUST fail this test"* — declares the **correct** implementation a
failure. A developer following the spec either writes an unimplementable join against a nonexistent
column, or writes an unsatisfiable test and then weakens the spec to make it pass. Both outcomes are
worse than no clause.

**Fix recipe.** Replace `df5-3:255-260` (from "**On gate and approval EVENT streams…**" through
"…*(see DoD).*") with:

> **Hops 8 and 9 read stores, not streams, and both are per-run.** Hop 8 reads `extensions.approval`
> (`run-record.ts:299-315`) out of the run's own `<runsDir>/<runId>.json` — a lookup by runId with no
> join. Hop 9 reads the **harvested, per-run** trace DB and joins `gate_results.request_id`
> (`trace/schema.ts:86`) to `record.requestId`, which DF1.10 `:157` guarantees is the same value: the
> dispatch `requestId` reaches the in-box engine through the unit environment and is stamped on every
> trace row. Cross-run contamination is impossible because each run's trace DB is created at
> `/run/trace/trace.db` (`tracer.ts:369`) and harvested into that run's own
> `<runsDir>/<runId>-artifacts/` (`harvest.ts:1068`).
> **`dispatchRequestId` is a LOG key, not a column, and the walker never uses it.** It exists only on
> `fleet`'s gate-event and `approval-gate`'s pause LOG lines (`approval-gate.ts:1209,1225`;
> `fleet.ts:3136,4029`), where it disambiguates the emitting context's `requestId` from the run's
> (`run-record.ts:285-292`). No store the walker opens has such a column. An implementation that looks
> for one resolves zero rows.

and replace the DoD item at `:333-335` with a test that is satisfiable and still guards the real risk:

> - [ ] **Test (per-run isolation, `tests/audit/chain.test.ts`):** two runs whose artifacts dirs sit
>       side by side under one `<runsDir>`; hop 9 of each resolves **only** the `gate_results` rows in
>       its own `<runId>-artifacts/trace/trace.db`, and hop 8 of each reads only its own record's
>       `extensions.approval`. An implementation that globs `<runsDir>/*-artifacts/**/trace.db` or
>       resolves the approval by `requestId` rather than by runId MUST fail this test.

---

### V-CC-B1 — DF5.4's INV-GATE-1 ("its only write is the report file") is false: C9 invokes DF5.3's walker, which by design WRITES into `.sandbox/audit.db`.

**Severity:** BLOCKER · **Cross-story**
**Files:** `df5-3-audit-chain-extended.md:196-204` (digest coverage), `:241-243` (Guards/limits) ↔
`df5-4-lights-on-gate.md:217-222` (INV-GATE-1), `:131` (C9), `:255-257` + `:258-264` (DoD)

**Defect.** DF5.3 states plainly that the walker writes:

> "the walker emits a **first-observation digest link** for each on its first successful walk
> (`hop`, `subject_id`, `evidence_digest`, `ON CONFLICT DO NOTHING`) … **This is the one write the
> walker makes**" (`:199-203`)

DF5.4-C9 invokes exactly that walker: `bun scripts/qds-audit.ts --json <pr-url>` (`:131`, `:111`,
DoD `:255-256`). DF5.4 then asserts:

> "**its only write is the report file, and that includes creating no file it merely intended to
> read**" (`:218-219`)

and requires it be proven by **"snapshotting the full file list under `.sandbox/` and `<runsDir>`
before and after a gate run and requiring byte-identical sets"** (`:260-262`).

DF5.4 never mentions the walker's write. Nowhere in the story is `audit.db` exempted.

**Concrete failure, two limbs.**

(a) *The invariant and its own test are mutually unsatisfiable.* `.sandbox/audit.db` is opened
read-write and rows are inserted during the gate run. If the store follows the `CostLedger` pattern
DF5.3 tells it to copy (`cost-ledger.ts:885-921`, which sets `PRAGMA journal_mode = WAL`), the
read-write open creates `.sandbox/audit.db-wal` and `-shm`. Whether they survive the connection close
is an SQLite implementation detail nobody should be betting a BLOCKER invariant on. Meanwhile the gate
has demonstrably mutated a store it audits — which is precisely the R9 two-layer collapse DF2.11 was
chartered to prevent for the cost ledger (sprint-status DF5.4 note: *"a verifier that mutates what it
verifies is not R9's independent second layer"*). The same argument applies verbatim to `audit.db`
and was not applied.

(b) *C9's tamper detection is vacuous on the run that matters.* C9 requires zero hops with status
`evidence-mismatch`. But on the gate's **first** run against a given run of record the walker has no
stored digest for hops 1/7/8 — it *mints* the baseline, then compares against it. The clause the
story sells as tamper detection cannot detect tampering that predates the first walk, which for a
frozen fixture is all tampering.

**Fix recipe.** Two changes, one per story.

In `df5-4:217-222`, replace INV-GATE-1's first sentence with:

> **INV-GATE-1 (read-only, with one named and bounded exception):** the gate never dispatches a run,
> provisions a box, mints or revokes a credential, opens a PR, or writes to a bank or the ledger
> (`p1-17:48`). Its only writes are (i) the report file and (ii) the append-only first-observation
> digest rows that DF5.3's walker inserts into `.sandbox/audit.db` when C9 invokes it
> (`df5-3` Technical Notes, "Digest coverage is asymmetric"). That second write is **into the audit
> store itself, never into any store the gate asserts about**, is `INSERT … ON CONFLICT DO NOTHING`
> against a table whose `BEFORE UPDATE`/`BEFORE DELETE` triggers `RAISE(ABORT)` (INV-AUDIT-4), and
> creates no file the gate merely intended to read. Everything else is read-only, and DF2.8's ordinary
> `CostLedger` constructor creates and schema-initialises its database when absent
> (`cost-ledger.ts:885-921`), so C10 reads through DF2.11's `openReadOnly()`, which refuses rather than
> creates.

and amend the DoD item at `:258-264` to:

> - [ ] **Security:** … the gate writes nothing outside the report path and `.sandbox/audit.db`
>       (INV-GATE-1) — **asserted by snapshotting the full file list under `.sandbox/` and `<runsDir>`
>       before and after a gate run and requiring the sets to differ by nothing except the report path
>       and, transiently, `.sandbox/audit.db-wal`/`-shm`**; the `audit_links` row count may only
>       increase and no existing row may change (queried before and after). An implementation that uses
>       the writing `CostLedger` constructor against a missing ledger creates
>       `.sandbox/cost-ledger.db`, `-wal` and `-shm` and MUST fail this test. An implementation that
>       mutates or deletes an existing `audit_links` row MUST fail this test.

In `df5-3:196-204`, add after "…which is true at the moment it is written.":

> **This write is what makes DF5.4's gate non-read-only, and DF5.4's INV-GATE-1 names it explicitly
> rather than being quietly false.** The digest link is therefore append-only into `audit_links` only —
> never into any store the chain asserts about — and its first observation establishes a baseline
> rather than detecting a prior tamper. C9's `evidence-mismatch` assertion is a **second-and-later**
> walk guarantee, and DF5.4's tamper test walks twice for exactly that reason.

---

### V-CC-B2 — Digesting the *file* that carries hops 1, 7 and 8 makes `evidence-mismatch` fire on the ordinary run lifecycle.

**Severity:** BLOCKER · **Cross-story**
**Files:** `df5-3-audit-chain-extended.md:189-195` (link schema), `:196-204` (digest coverage), `:336-339` (DoD tamper test) ↔ `df5-4-lights-on-gate.md:131` (C9)

**Defect.** The link schema carries exactly one `evidence_path` and one `evidence_digest` per row, and
the digest is defined as *"SHA-256 of the artifact"* (`:194`). The story then digests hops 1, 7 and 8.
Resolve what "the artifact" is for each against shipped code:

| Hop | Artefact the story names | What it actually lives inside | Who else writes that file after a walk |
|---|---|---|---|
| 7 | DF5.1 `ReverifyReport` | one **line** in `.sandbox/reverify/<runId>.jsonl` (`src/reverify/report.ts:10`, `:313`) | `appendReport` on **every** re-verify — `runner.ts:290, :418, :469, :481` |
| 8 | DF3.4 `extensions.approval` | a sub-object of `<runsDir>/<runId>.json` | any later `store.set` on that record |
| 1 | DF5.2 `extensions.pr` | the **same** `<runsDir>/<runId>.json` | teardown's `closedAt`; `captureSpend`'s `spendMicroUsd` (`credentials.ts:586`); the reaper |

**Concrete failure.** Walk a run once — say, DF5.4's first gate run, or an operator running
`qds-audit.ts` before the PR merges. The walker records digests. Then any perfectly legitimate
subsequent write lands:

- a second re-verify appends a line to the `.jsonl` (which is the *normal* path when the first report
  was red or superseded — `extensions.approval.supersededReportIds` exists precisely because this
  happens), so the file digest changes → **hop 7 `evidence-mismatch`, permanently**;
- `captureSpend` writes `spendMicroUsd` or teardown writes `closedAt` to the run record → the file
  digest changes → **hops 1 and 8 `evidence-mismatch`, permanently**.

AC1 makes `evidence-mismatch` a broken hop; the chain fails and exits non-zero; DF5.4-C9 requires zero
`evidence-mismatch` hops → **gate red, permanently, with no remediation short of deleting audit rows
that INV-AUDIT-4 triggers forbid deleting.** The append-only immutability guarantee and the
whole-file digest are in direct conflict: the store cannot be corrected once poisoned.

**Fix recipe.** Replace `df5-3:194-195` (from "`evidence_digest` (SHA-256 of the artifact)…") with:

> `evidence_digest` is the SHA-256 of the **canonicalised subject record**, never of the containing
> file, because every containing file here is mutable by design: hops 1 and 8 live inside one
> `<runsDir>/<runId>.json` that teardown (`closedAt`), `captureSpend` (`credentials.ts:586`) and DF5.2
> all write after the fact, and hop 7 is one line of an append-only
> `.sandbox/reverify/<runId>.jsonl` that `appendReport` (`report.ts:317`, called at
> `runner.ts:290,418,469,481`) extends on every re-verify. The digested subject is therefore:
> hop 1 → the `extensions.pr` entry alone; hop 7 → the single `ReverifyReport` object identified by
> `subject_id = reverifyId`; hop 8 → the `extensions.approval` entry alone; hops 4/5/6 → the emitted
> link's own `detail_json`. Canonicalisation is JCS (RFC 8785) so key order cannot forge a mismatch.
> Digesting a whole file would make a lawful `closedAt` write or a lawful second re-verify report an
> `evidence-mismatch` that INV-AUDIT-4's triggers make uncorrectable. `evidence_path` still names the
> containing file for the operator; `subject_id` names the record inside it.

and amend the DoD tamper test (`:336-339`) to say "editing the bound `ReverifyReport`'s `verdict`
**in place** (not appending a new report) and re-walking yields `evidence-mismatch` on hop 7; **appending
a lawful second report does NOT**, and an implementation digesting the whole `.jsonl` fails on the
second case and MUST fail this test."

---

### V-CC-B3 — The harvested trace DB ships with an uncheckpointed `-wal` and deliberately no `-shm`. A read-only open cannot recover it; a read-write open creates a file the gate "merely intended to read". Neither story mentions any of it.

**Severity:** BLOCKER · **Cross-story**
**Files:** `df5-3-audit-chain-extended.md:160` (Infra Prereq), `:171` (hop 2), `:178` (hop 9), `:241-243` (Guards) ↔ `df5-4-lights-on-gate.md:126` (C4), `:218-219` (INV-GATE-1)

**Defect.** `src/providers/harvest.ts:184-212` is unusually explicit about this, and both stories
missed it:

> "`trace.db-wal` rides along because **the marker does NOT imply a checkpointed DB**. … Anything that
> harvests on seeing the marker (DF3.7's completion observer) can therefore arrive while the tail of
> the run is still in `trace.db-wal`; and `tracer.close()` is deliberately guarded so that even a clean
> exit does not guarantee the checkpoint ran. **Taking `trace.db` alone yields a database missing the
> rows describing how the run ended.**"
>
> "`trace.db-shm` is **deliberately NOT here**, and its absence is load-bearing rather than an
> oversight. … Shipping db + wal and **letting sqlite rebuild the index** is strictly safer than
> shipping a snapshot of the index itself."

The in-box `PRAGMA wal_checkpoint(TRUNCATE)` at `harvest.ts:631-640` is best-effort and explicitly
*"allowed to fail (no sqlite3 on the box, a busy writer) and must not become a harvest failure."*

So `<runsDir>/<runId>-artifacts/trace/trace.db` may arrive with a hot WAL and no shm. SQLite must
create the `-shm` to read a hot WAL. That means:

- **Read-only open** (what DF5.3 Guards `:242` and DF5.4 INV-GATE-1 `:218` both mandate): SQLite
  cannot create the shm. Depending on flags it either **refuses** (`SQLITE_CANTOPEN` /
  `SQLITE_READONLY_RECOVERY`) or, under `immutable=1`, **silently reads the pre-WAL snapshot** —
  i.e. reads a DB *"missing the rows describing how the run ended"*, which is precisely the
  `gate_results` rows hop 9 and C4 exist to assert. A green C4 against a truncated DB is the worst
  outcome available: a two-layer-doctrine clause passing on evidence it never actually read.
- **Read-write open:** SQLite creates `<runId>-artifacts/trace/trace.db-shm` (and rewrites
  `trace.db`), which is a file the gate *"merely intended to read"* — violating INV-GATE-1's literal
  text and failing DF5.4's own file-set snapshot test (`:260-262`).

Neither story contains the strings `wal`, `shm` or `checkpoint`.

**Fix recipe.** Add a new Technical Notes bullet to **both** stories (identical text; DF5.3 owns it,
DF5.4 cites it):

> - **The harvested trace DB may carry a hot WAL and has no shm — read it through a copy, never in
>   place.** `harvest.ts:184-212` ships `trace/trace.db` **and** `trace/trace.db-wal`, deliberately
>   omitting `trace.db-shm`, because the completion marker does not imply a checkpoint and
>   `tracer.close()`'s `PRAGMA wal_checkpoint(TRUNCATE)` is guarded; the in-box best-effort checkpoint
>   at `harvest.ts:631-640` is explicitly allowed to fail. A read-only open cannot rebuild the shm, so
>   it either refuses or silently reads the pre-WAL snapshot — the snapshot missing exactly the rows
>   describing how the run ended. A read-write open in place creates `trace.db-shm` inside the
>   artifacts directory, which the reader has no business writing to.
>   **Therefore: copy `trace.db` and, if present, `trace.db-wal` into a private temp dir
>   (`mkdtempSync`, 0700, removed in a `finally`), open the copy read-write so SQLite recovers the WAL,
>   read, then discard the whole temp dir.** The artifacts directory is never written and the recovered
>   rows are complete. A reader that opens `<runsDir>/<runId>-artifacts/trace/trace.db` directly —
>   read-only or otherwise — MUST fail its test, with one fixture carrying a non-empty `-wal` and no
>   `-shm` and a `gate_results` row reachable only through it.

Then in `df5-3:242` change "the walker opens the trace DB … read-only" to "the walker reads the trace
DB through the temp-dir copy above and never touches the artifacts directory", and add the matching
DoD test to both stories.

---

## HIGH

### V-CC-H1 — `≤` vs `<`: the shared "Reconstructable" definition and DF5.3 AC7 accept equal timestamps; DF5.4-C6/C7 reject them.

**Severity:** HIGH · **Cross-story**
**Files:** `df5-3:42`, `df5-4:44-45` (the shared paragraph, verified byte-identical); `df5-3:138-139` (AC7) ↔ `df5-4:128` (C6), `:129` (C7)

The paragraph both stories declare *"defined once, for both halves of this contract"* says:

> "the run satisfies `reverify.completedAt ≤ approval.decidedAt ≤ pr.createdAt`"

DF5.3 AC7 repeats `≤`. DF5.4-C6 says **"strictly before"**, `ReverifyReport.completedAt <
extensions.pr.createdAt`. DF5.4-C7 says **"strictly after"** and **"strictly before"**. DF5.4 thus
contradicts the paragraph it copied verbatim, three lines above its own clause map.

**Failure.** On equal host timestamps — plausible where `extensions.pr.createdAt` is a
first-observation stamp taken on the adopt path (`run-record.ts:209-212`) — DF5.3's chain is complete
and C9 passes while C6/C7 fail. Gate red on a lawful run, with two clauses of the same gate disagreeing
about the same three timestamps.

**Fix.** Pick one and propagate. Recommend **strict** (it is the stronger F10 guarantee and the one
DF5.4's tests are written against): change `≤` to `<` in both copies of the shared paragraph
(`df5-3:42`, `df5-4:44-45`) and in DF5.3 AC7 (`:138-139`), and add to AC7: *"equality is a violation:
an ordering that cannot distinguish the re-verify from the decision has not demonstrated the decision
followed the evidence."*

### V-CC-H2 — Neither story says *which* `ReverifyReport`, and there are usually several.

**Severity:** HIGH · **Cross-story**
**Files:** `df5-3:176` (hop 7), `:327-329` (DoD) ↔ `df5-4:128` (C6), `:135-140`, `:273-276` (DoD)

`.sandbox/reverify/<runId>.jsonl` is append-only (`report.ts:10`) and `readReports(dir, runId)`
returns an **array** (`report.ts:402`). `appendReport` is called at `runner.ts:290, :418, :469, :481`
— retries, non-determinism flags and error seals all append. The run record's
`extensions.approval` carries `reportId` and `supersededReportIds` (`run-record.ts:299-315`) precisely
because an approval binds to **one** report, not to a run.

Both stories say "the `ReverifyReport`" as though singular. An implementation reading the last line can
fail a lawfully-approved run (last report red), or pass a run whose approval bound a *different,
superseded* report — which is a genuine two-layer-doctrine hole: the truth layer would be a report
nothing approved.

**Fix.** In `df5-4:137-139` (the C6 bullet), replace "DF5.1's `ReverifyReport.completedAt`" with:

> the **bound** `ReverifyReport` — the one whose `reverifyId` equals `extensions.approval.reportId`
> (`run-record.ts:299-315`), selected from the append-only `.sandbox/reverify/<runId>.jsonl`
> (`report.ts:10`, which holds one line per re-verify and legitimately holds several). Its
> `completedAt`, never the last line's. A report listed in `extensions.approval.supersededReportIds`
> is never the ordering input, and a `reportId` that resolves to no line in the file is a `skip`
> naming both the id and the path.

and make the same substitution in `df5-3:176` (hop 7) and in both stories' relevant DoD items.

### V-CC-H3 — `<runsDir>/<runId>-artifacts/…/trace.db` is ambiguous: the tar carries two files by that name, and harvest documents the collision.

**Severity:** HIGH · **Cross-story**
**Files:** `df5-3:160`, `:171`, `:178` ↔ `df5-4:109`, `:126`

`harvest.ts` ships **two** trace databases into one artifacts directory:

- `BOX_RUN_SOURCES` (`:213-218`) → `trace/trace.db` — the phase engine's, the one holding `gate_results`;
- `BOX_WORKDIR_SOURCES` (`:245`) → `trace.db` at the artifacts root — inkwell's checkout DB.

`harvest.ts:176-182` documents this as the express reason the `trace/` prefix is not flattened:
*"Flattening `trace/trace.db` to `trace.db` (the obvious reading) would collide with the checkout's
own `trace.db`."* Both stories write the path with an ellipsis (`…/trace.db`), which is exactly the
"obvious reading" the code warns against.

**Failure.** A resolver globbing for `trace.db` finds the checkout DB first, which has no
`gate_results` table at all → hop 9 / C4 resolve as broken (best case) or as an empty-but-present
result (worst case, if the reader tolerates a missing table).

**Fix.** Replace every `…/trace.db` occurrence with the literal path
`<runsDir>/<runId>-artifacts/trace/trace.db`, and add once per story:

> The `trace/` prefix is load-bearing: the same tar also carries the checkout's own `trace.db` at the
> artifacts root (`harvest.ts:245`), which holds no `gate_results` table. `harvest.ts:176-182` names
> this collision explicitly. A resolver that globs for `trace.db` rather than resolving
> `trace/trace.db` MUST fail its test, with a fixture containing both.

### V-DF5.4-H1 — C4 requires `gate_results` rows "for both a pass and a fail". A clean run need never fail a gate.

**Severity:** HIGH
**File:** `df5-4-lights-on-gate.md:126`

C4 asserts *"`gate_results` rows for **both a pass and a fail**"*. Nothing guarantees a lights-on run
of record contains a gate failure — a run whose gates all pass first time produces only `passed = 1`
rows. Because the run of record is **captured once and frozen** (`:110`), a clean capture makes C4
permanently red with no remedy except deliberately inducing a gate failure into the fixture, which is
fabricating evidence to turn a gate green — the exact posture INV-GATE-3 forbids in the VOID direction.

It is also an emitter↔asserter asymmetry: DF5.3 hop 9 attaches `gate_results` rows as claims with no
pass/fail-diversity requirement.

**Fix.** Replace C4's "carries `gate_results` rows for both a pass and a fail" with:

> carries at least one `gate_results` row for the run, every row's `passed` column being a literal `0`
> or `1` (never NULL — INV-GATE-5 positive assertion) and every row joining to the run record's
> `requestId`

and, if the discriminating property is genuinely wanted, move it where it belongs — into
`tests/gate/df5-assertions.test.ts` as a **unit** test of the pure auditor against a synthetic
two-row fixture, not into a clause asserted against the frozen run of record.

### V-DF5.4-H2 — C10 compares a box-hours total against an OpenRouter key cap.

**Severity:** HIGH
**File:** `df5-4-lights-on-gate.md:132` (C10), `:144-152`

C10 asserts *"a non-zero µ$ total at or under cap"* and names no cap. Resolve the two quantities:

- `readRunCost(runId)` sums rows where `kind IN ('tokens','box_hours')` (`cost-ledger.ts:334`,
  `:1335`). Per F001/#157 — which C10's own paragraph acknowledges at `:150-152` — a production run's
  ledger carries `box_hours` rows **only**. So the total is exe.dev box time.
- The only cap in scope is `extensions.budget.admittedCeilingMicroUsd`, documented at
  `run-record.ts:221-222` as *"the one clamped ceiling handed to DF2.3's mint"* — an **OpenRouter key**
  cap. The key's actual spend is `spendMicroUsd` (written by `captureSpend`, `credentials.ts:586`),
  which C10 does not read.

Comparing box-hours against a key cap is not a bound; it passes or fails for reasons unrelated to
either control. And "non-zero" additionally re-imports V-DF5.3-B3: an issue-less run has a zero total.

**Fix.** Replace C10's Asserts cell with:

> `CostLedger.openReadOnly({path}).readRunCost(runId)` (DF2.11's read-only seam over
> `cost-ledger.ts:1335`) reports `hasEvents: true` and a non-zero µ$ total — the run's **box-hours**
> spend, which is all the ledger holds until the F001/#157 bridge lands (`cost-ledger.ts:17-18`) — and,
> **separately**, the record's `spendMicroUsd` (`credentials.ts:586`, the *key's* spend) is at or under
> `extensions.budget.admittedCeilingMicroUsd` (`run-record.ts:221-222`, the cap actually handed to
> DF2.3's mint). The two are different meters and the clause never compares one against the other's
> ceiling. An absent ledger is a `skip` naming the path, never a created file.

### V-DF5.4-H3 — Frozen SQLite fixtures cannot carry 0600/0700 under git; C10 (and any `audit.db` read) is red on every fresh clone.

**Severity:** HIGH
**File:** `df5-4-lights-on-gate.md:110`, `:212` (fixture directory), `:132` (C10); also `df5-3:159` (`audit.db` modes)

`tests/gate/fixtures/df5-run-of-record/` is specified to contain `.sandbox/cost-ledger.db` and
`.sandbox/audit.db` as committed fixture files. **Git records only the executable bit** — not 0600, not
directory 0700. On a fresh clone or in CI they check out as 0644 under 0755.

The shipped `CostLedger` path asserts both: dir mode must be exactly 0700 (`cost-ledger.ts:887-893`,
throws `ledger-dir-mode`) and file mode exactly 0600 (`:909-916`, throws `ledger-file-mode`). DF5.3
specifies the same posture for `audit.db` (`df5-3:159`: "dir mode 0700, file 0600 — the `CostLedger`
constructor at `cost-ledger.ts:885-921` is the pattern to copy"). Whether DF2.11's `openReadOnly()`
retains the mode checks is **unstated in DF5.4** — and if it drops them, that is a security relaxation
DF2.11 has not been told to make.

**Failure.** C10 throws or skips on every machine that has not manually chmod'd the fixture, so the
gate is red in CI and green only on the author's box — the exact class of "green on my machine"
defect an exit gate exists to catch. AC3 (determinism) is also violated across environments.

**Fix.** Add to the run-of-record Infra Prereq row (`:110`):

> **Fixture file modes are restored at test setup, never assumed from git.** Git preserves only the
> executable bit, so the committed `cost-ledger.db` and `audit.db` check out 0644 under 0755 while the
> shipped ledger path asserts dir 0700 (`cost-ledger.ts:887-893`) and file 0600 (`:909-916`). The test
> harness copies the fixture directory into a `mkdtempSync` scratch dir and `chmod`s it to 0700/0600
> before the gate runs, and the gate is pointed at the scratch copy through the `--runs-dir`-style
> seams. This also keeps the frozen fixture immutable across runs (Guards/limits). **DF2.11's
> `openReadOnly()` retains the mode assertions** — a read-only seam that drops them would silently
> relax a shipped security posture, which is a DF2.11 change and not this story's to assume.

### V-CC-H4 — DF5.4-C9 pins "exactly one contributing-runId key"; DF6.1b makes that false, and DF5.4 has no edge to DF6.1b.

**Severity:** HIGH · **Cross-story**
**Files:** `df5-4:131` (C9) ↔ `df5-3:209-223` (the map shape), sprint-status `:203`, `:212`

DF5.3 is explicit that `ChainReport` is a map keyed by contributing runId, and that **DF6.1b** adds one
key per fix runId (`df5-3:213-219`). DF5.4-C9 hard-codes *"exactly one contributing-runId key"*.

Ordering: sprint-status `:212` has DF6.1b deps `[DF6.1a, DF5.3]`, v5-S3; DF5.4 `:203` is *"SCHEDULED
LAST in the sprint"*. DF6.1b will very likely have merged before DF5.4's gate is first run. DF5.4's
edge list (`df5-4:65-74`, sprint-status `:203`) does **not** include DF6.1b, so nothing forces anyone
to revisit C9.

**Failure.** A run of record whose PR went through one fix attempt produces two keys → C9 fails →
gate red for a *more* thoroughly verified run than the single-key case. And DF5.3's stated
reciprocity rule ("neither story changes the shape without the other's row changing in the same PR")
is silently broken by a third story.

**Fix.** Replace C9's first assertion with:

> **at least one** contributing-runId key, the parent run reached at hop 1 among them (a PR with no
> fix attempts has exactly one — DF6.1b adds one key per fix runId, `df5-3` Technical Notes "Ten hops
> *per contributing runId*"), **exactly ten hops under every key**, …

and add to `df5-4:65-74`: *"DF6.1b is not a predecessor but is a **shape** edge: it widens
`ChainReport` from one key to N. C9 is written against the map, not against the single-key case, so
DF6.1b lands without touching this clause."*

### V-DF5.3-H1 — Internal contradiction on the walker's open mode for `audit.db`.

**Severity:** HIGH
**File:** `df5-3-audit-chain-extended.md:159` (Infra Prereq) vs `:196-204` + `:241-243`

`:159`: *"the walker opens read-only and **never** migrates."*
`:203`: *"**This is the one write the walker makes** and it is append-only into `audit_links`."*
`:242`: *"writes nothing outside `audit_links`"* — i.e. it does write to `audit_links`.

A read-only handle cannot INSERT. One of the two must go, and V-CC-B1 already establishes that the
write is intended.

**Fix.** In `:159`, replace "the walker opens read-only and **never** migrates" with:

> the walker opens read-**write** (it appends first-observation digest rows — see Technical Notes) but
> **never migrates**: it asserts the schema is present and fails the walk closed with a named broken
> hop when it is not (INV-AUDIT-6), so an uninitialized store (zero `recordAuditLink` calls) can never
> be created by the read path

---

## MEDIUM

### V-DF5.4-M1 — `void_reason` is not a field the chassis puts in the report; AC1 and the parity test assert against something that cannot exist without editing `gate-runner.ts`.

**Severity:** MEDIUM
**File:** `df5-4-lights-on-gate.md:79-80` (AC1), `:288-289` (DoD), `:196-197`; against `gate-runner.ts:77-86`, `:88-94`, `:167-178`

`void_reason` is a field of `GateAssertion` (input, `gate-runner.ts:74`). It is **not** a field of
`GateAssertionResult` (`:77-86`) or `GateReport` (`:88-94`). The chassis renders it into `detail`:
`detail: \`VOID — ${a.void_reason}\`` (`:174`). `GateReportSchema` (`:117-128`) has no such key, and
being a non-strict `z.object` it would silently strip one.

DF5.4 says at `:63` it *"never edits `gate-runner.ts`"*, so the field cannot appear.

**Fix.** In AC1 (`:80`) replace "`DF5.4-V1` is recorded with its `void_reason`" with
"`DF5.4-V1` is recorded `void` with `detail` equal to `` `VOID — ${OQ4_VOID_REASON}` `` — the chassis
renders `void_reason` into `detail` (`gate-runner.ts:174`); `GateAssertionResult` has no `void_reason`
field (`:77-86`) and this story does not add one". Amend the DoD parity item (`:288-289`) the same way:
*"`DF5.4-V1`'s report `detail` equals `` `VOID — ${OQ4_VOID_REASON}` `` with `OQ4_VOID_REASON` imported
from `src/audit/index.ts` (DF5.3) — asserted equal, not retyped; a copied string literal MUST fail."*

### V-DF5.3-M1 — Hop 6 has no `evidence-not-harvested` arm, though its evidence can be lost the same way.

**Severity:** MEDIUM
**File:** `df5-3-audit-chain-extended.md:175` (hop 6), `:128-134` (AC6)

AC6 gives hops 2 and 9 a typed `evidence-not-harvested` outcome for a failed artifacts pull. Hop 6's
evidence — the bundle at `<runsDir>/<runId>.bundle` and the ref `refs/sandbox/<run-id>` — comes from a
**different** harvest path (`fetchBundle`, not `pullArtifacts`), so it survives the artifacts-pull
failure at `teardown.ts:279-287`. But the bundle fetch can fail on its own, and hop 6 then has only
`unlinked` or a generic broken hop — reporting a *harvest loss* as a *missing link*, which is exactly
the confusion AC6 exists to prevent.

**Fix.** Extend AC6's first line to "When the walker resolves hops 2, 6 and 9", and add to the hop 6
row: *"a bundle-fetch failure resolves `{ status: "evidence-not-harvested", reason, evidencePath }`
naming `<runsDir>/<runId>.bundle` — distinct from the artifacts-pull loss that hits hops 2 and 9,
because the bundle rides `fetchBundle` and not `pullArtifacts`."*

### V-DF5.4-M2 — C5's evidence is a git ref in the host repo, which the frozen fixture directory cannot hold and no named seam reaches.

**Severity:** MEDIUM
**File:** `df5-4-lights-on-gate.md:127` (C5), `:110`, `:212`

C5 asserts the bundle was *"fetched to `refs/sandbox/<run-id>`"* — a ref inside the host repo's `.git`,
resolving to an object in that repo's object store. `:212` lists "git ref" as a member of
`tests/gate/fixtures/df5-run-of-record/`, but a ref file is a 40-hex line that means nothing without
the object it names, and `:110` names only *"`--runs-dir`-style seams"*. There is no git seam.

Consequence: C5 is either untestable against the frozen fixture (AC3 determinism fails across
machines) or it silently asserts against the developer's working repo, which is a live path the
Guards/limits rule forbids.

**Fix.** Add to `:110`: *"C5's ref evidence is frozen as a bare bundle plus its ref name; the capture
tool writes `refs/sandbox/<run-id>` into a bare repo at
`tests/gate/fixtures/df5-run-of-record/refs.git`, and the gate takes a `--git-dir` seam alongside
`--runs-dir`. The gate never resolves a ref in the operator's working repo."* Add `--git-dir` to the
DoD flag list at `:250-251`.

### V-DF5.4-M3 — The E2E slice's delete-the-re-verify-record arm names only C6, but three clauses change.

**Severity:** MEDIUM
**File:** `df5-4-lights-on-gate.md:55-59` (E2E slice), `:290-294` (DoD e2e)

Deleting `.sandbox/reverify/<run-id>.jsonl` strands more than C6:
- **C6** → `skip` (as stated);
- **C7** → its ordering input (`ReverifyReport.completedAt`) is gone → `skip` under INV-GATE-5;
- **C9** → DF5.3 hop 7 resolves broken (`df5-3:327-329` requires exactly this), the walker exits
  non-zero, so C9 fails.

The described output is incomplete, and a test written to the description would fail on C7 and C9.

**Fix.** Amend `:55-58` to: *"…prints `DF5.4-C6 … skip` naming the missing `.sandbox/reverify/<run-id>.jsonl`
path, `DF5.4-C7 … skip` (its ordering input is gone) and `DF5.4-C9 … fail` (DF5.3 hop 7 is broken and
the walker exits non-zero); the gate is **red**…"* and mirror it in the DoD item.

### V-DF5.3-M2 — DF5.3 and DF5.4 disagree about whether an issue-less run is legitimate.

**Severity:** MEDIUM (the underlying fact is BLOCKER-graded at V-DF5.3-B3; this is the reciprocity half)
**File:** `df5-3:160` ↔ `df5-4:123` (C1)

DF5.4-C1 makes an issue-less run permanently red. DF5.3's Infra Prereq says an issue-less run still
resolves. Both cannot hold. **DF5.4 is right** and its reason is the better one: `extensions.budget` is
the durable evidence of admission, and a run nothing admitted is a run nothing capped. Resolve by
applying V-DF5.3-B3's fix; no change is needed on DF5.4's side.

### V-DF5.3-M3 — `setupRun` has zero callers repo-wide; threading a seam through it is maintenance on dead code.

**Severity:** MEDIUM
**File:** `df5-3-audit-chain-extended.md:149`, `:263-276` (Files to Modify)

`grep -rn 'setupRun(' src/ scripts/` returns only the definition (`driver.ts:1066`). The real `setup`
evidence is DF3.1's setup gate at `dispatch.ts:3023`, which is also what DF5.4-C2 asserts (*"`setup`
gate green"*). Subsumed by V-DF5.3-B1's fix; called out separately so the point-estimate rationale
(`:82`, "the seam threading … is why this story is 6 points") is re-checked against the corrected
site list — the `driver.ts` threading is smaller than stated, and the `dispatch.ts` emit is new work
the story does not currently list in Files to Modify.

---

## LOW

### V-DF5.3-L1 — Off-by-one citation.

**File:** `df5-3-audit-chain-extended.md:160`

Cites "`:84-85` `gate_results` — both keyed on `request_id`". Line 84 is
`CREATE TABLE IF NOT EXISTS gate_results (`, line 85 is `id INTEGER PRIMARY KEY`; `request_id TEXT NOT
NULL` is line **86**. The `:84-93` citation used at `:178` and in DF5.4-C4 is exact. Change `:84-85`
to `:84-86`.

### V-CC-L1 — sprint-status.yaml's own header note contradicts its own 2026-09-08 block.

**File:** `_bmad-output/sprint-artifacts/sprint-status.yaml:16-18`

The "Most recent note" block (dated 2026-09-03) still reads *"DF5.3 (4pt)"* and *"DF5.3 gates a
separate 11-pt chain (DF6.1 6 -> DF5.4 3 / DF5.5 2)"*. The 2026-09-08 block at `:54-58` supersedes all
three numbers (DF5.3 4→6, DF5.4 3→5, DF6.1 split into DF6.1a 4 + DF6.1b 3) and `:65-66` reconciles the
41-story / 166-point slate.

**Authoritative artifact:** the 2026-09-08 block and the per-story rows at `:202-203`, because they are
dated later, they reconcile arithmetically both ways at `:65-66`, and they match the story headers.
The 2026-09-03 note is stale history and should be drained to `sprint-status-history.md` per the file's
own stated convention at `:4-6`. **No story-vs-status disagreement exists** (see next section) — this
is purely intra-status.

---

## Artifact consistency sweep (story headers ↔ sprint-status.yaml)

| Field | DF5.3 story | sprint-status `:202` | Verdict |
|---|---|---|---|
| Points | 6 (`:3`) | `points: 6` | ✅ |
| Sprint | v5-S3 (`:4`) | `# v5-S3` | ✅ |
| Status | (not stated in story) | `ready-for-dev` | ✅ n/a |
| Deps | DF1.4, DF1.8, DF1.10, DF2.1, DF2.3, DF2.5, DF2.6, DF2.8, DF3.4, DF5.1, DF5.2 (`:61-62`) | identical 11-edge set | ✅ **exact** |

| Field | DF5.4 story | sprint-status `:203` | Verdict |
|---|---|---|---|
| Points | 5 (`:3`) | `points: 5` | ✅ |
| Sprint | v5-S3 (`:4`) | `# v5-S3` | ✅ |
| Status | (not stated in story) | `ready-for-dev` | ✅ n/a |
| Deps | DF5.1, DF5.2, DF5.3, DF3.1, DF3.4, DF1.10, DF2.5, DF3.7, DF3.8, DF2.11, P0.11 (`:65-66`) | identical 11-edge set | ✅ **exact** |

**No story↔status disagreement was found on either story** — points, sprint tag and dependency edges
all reconcile exactly. The only inconsistency is intra-`sprint-status.yaml` (V-CC-L1). Both stories
also correctly reflect that DF2.11 and DF2.12 are new and unbuilt: DF5.4 declares DF2.11 as a direct
edge and names `CostLedger.openReadOnly()` as its deliverable (`:66-69`, `:111`, `:146-148`, `:220-222`),
and DF5.3 correctly describes DF2.12 as future work that changes nothing in hop 3's contract (`:172`).
Both match sprint-status `:168-169`.

---

## Reciprocity ledger (the assignment's specific question)

| Direction | Verdict |
|---|---|
| Every link DF5.3 emits has a DF5.4 assertion? | ✅ Hops 4/5/6 link families ← C9 asserts row-id presence by name (`df5-4:131`). The walker's digest links (hops 1/7/8) ← C9's zero-`evidence-mismatch` clause. Nothing emitted is unasserted. |
| Does DF5.4 assert a stage DF5.3 does not emit? | ✅ Declared and reasoned, not accidental: C1 (channel) and C3 (team) are upstream of authorization, stated identically in both files' Reciprocity paragraphs. Correct. |
| Could an empty `audit_links` table walk the gate green? | ✅ **No.** C9 requires ≥1 row id on each of hops 4/5/6; DF5.3 AC3 makes a never-emitted link `unlinked` = broken = exit 1; INV-AUDIT-6 forbids a vacuous chain. This is the pair's strongest joint. |
| Is the `--json` wire format single-owner? | ✅ `ChainReport` exported once from `src/audit/index.ts` (DF5.3), imported by C9, with a DoD item making a locally re-declared shape a typecheck failure (`df5-4:284-285`). `OQ4_VOID_REASON` likewise, and the two literals are **byte-identical** (verified). Good. |
| Two-layer doctrine — does DF5.3 type in-box evidence as a claim? | ✅ Hop 9 attaches `{ kind: "claim" }`; INV-AUDIT-5 makes resolving hop 7 from in-box gate results a mandatory test failure (`:327-329`). |
| Does DF5.4 assert an in-box claim as a pass condition? | ✅ **No** in prose — C3/C4 are typed claim-integrity, INV-GATE-4 carries the negative control (`:239-241`). ⚠️ But V-CC-B3 means C4 can pass against a **silently truncated** trace DB, which is a doctrine hole by a different route: a claim-integrity clause that never read the claim. |
| Does the gate write anything but its report? | ❌ **Yes** — V-CC-B1. C9's walker writes to `.sandbox/audit.db`, unacknowledged. |
| Can the gate *create* an artifact it merely intended to read? | ❌ **Yes, by two routes.** The ledger route is closed (DF2.11 `openReadOnly()`, correctly specified). The **trace-DB route is open**: recovering a hot WAL creates `trace.db-shm` in the artifacts dir (V-CC-B3). |
| Schema closure | ✅ Both respect it. DF5.3 adds no run-record field (hop 6 leans on the bundle's presence per `harvest.ts:18-19`; DF6.1b's `fixOutcome` is an existing `string` field, `run-record.ts:216`), and `audit_links` is a **new** host-side store, not a change to DF1.4's 7 tables (verified: `sessions`, `phases`, `events`, `envelopes`, `gate_results`, `processes`, `agent_sessions`). |
| Harvest boundary | ⚠️ `audit.db` and the cost ledger are host-side and survive box destruction ✅. But the trace DB is a tmpfs artefact reaching the host only through teardown's tar — handled for *loss* (AC6) and **not** handled for *WAL-truncation* (V-CC-B3), which is the subtler and more dangerous half. |
| Security invariants | ✅ No route for `sk-or-` material found. INV-AUDIT-2 restricts credential hops to `key_hash` + an 8-char prefix, consistent with `credentials.ts:257` and `reaper.ts:16-19` (`keyHashPrefix`, first 12 hex). Append-only enforced by `BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT)` triggers with a DoD test. One-secret-per-box untouched by either story. INV-GATE-2 covers the report side. **No security finding.** ⚠️ One adjacent note: V-CC-B2's fix must not weaken INV-AUDIT-4 — digesting a sub-record rather than a file changes *what* is immutable, not *whether* rows are. |

---

## What a previous reviewer got right, and one thing to re-check

- **"`src/audit/` does not exist" — CONFIRMED.** Also confirmed absent: `scripts/qds-audit.ts`,
  `scripts/df5-lights-on-gate.ts`, `scripts/dev/capture-run-of-record.ts`.
- **The DF5.4 re-estimate (sprint-status `:203`) is substantively correct** on both BLOCKERs it names:
  `.sandbox/approvals/` genuinely does not exist (approval is `extensions.approval`,
  `run-record.ts:299-315`), and the `CostLedger` constructor genuinely creates/mutates
  (`cost-ledger.ts:885-921`, read line by line). Both fixes landed correctly in the story.
- **One thing to re-check:** that same re-estimate's fix to C3/C4 — hardening them into
  claim-integrity clauses — **introduced** V-DF5.4-H1 (C4's "both a pass and a fail" requirement,
  which a clean run cannot satisfy) and left V-CC-B3 (the WAL/shm hole) untouched, so C4 can still
  pass without having read the rows it claims to assert. The doctrine fix was right in principle and
  incomplete in mechanism.
- **Do not "fix" the citations.** They are accurate to an unusual degree (one off-by-one in ~40). The
  defects here are all of the form *"the cited code does not do on a real run what the story assumes
  it does"* — B1 (four uncalled functions), B2 (a backstop treated as a lifecycle step), B3 (a
  conditional writer), B4 (a log key mistaken for a column), B3/CC-B3 (a documented WAL caveat). Any
  fix pass that only re-verifies line numbers will land on none of them.

---

## Recommended resolution order

1. **V-DF5.3-B1 + B2** together — they rewrite the same hop-5 row, AC3/AC5/AC7 and the Trigger Surface.
   Nothing else can be validated until hop 5 is producible.
2. **V-CC-B3** — the trace-DB read strategy; it changes hop 2, hop 9, C4 and both read-only invariants.
3. **V-CC-B2** then **V-CC-B1** — the digest subject, then the invariant that admits the write.
4. **V-DF5.3-B4** — the Observability/DoD join correction (self-contained).
5. **V-DF5.3-B3 / V-DF5.3-M2** — one edit on DF5.3, none on DF5.4.
6. HIGHs H1–H4 and the DF5.4-specific H1–H3, then MEDIUM/LOW.

Six of the seven BLOCKERs change the acceptance criteria, not merely the prose. None is resolvable by
the implementer at dev time without a spec decision.
