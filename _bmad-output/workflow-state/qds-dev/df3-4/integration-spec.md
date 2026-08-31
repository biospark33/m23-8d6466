# DF3.4 Integration Spec — Tier-1 Pre-PR Approval Gate + `attach` Steering

Derived from research wave 1 (R1 store/extensions, R2 approval seam, R5 teardown/creds landed
in full; R3 CLI chassis and R4 steering partially self-gathered on the main thread; R6 not run).

Status: **DRAFT — gated at Phase 3 HITL. Contains 1 BLOCKER-class and 3 HIGH items that
require a human decision before any code is written.**

---

## 1. The single most important finding

**DF5.1 already built the front half of AC1.** `src/reverify/approval.ts` ships a real, non-stub
`ApprovalPort` + `recordApprovalPort` adapter that already implements the AC1(a2) re-entry
matrix (create / rebind / pause-in-progress / already-decided) under a real O_EXCL lock with
proof-of-death PID reclamation. DF5.1's caller at `runner.ts:413-417` already passes `reportId`
and `headSha`.

So `requestApproval`'s registration + re-entry logic is **LIFT, not WRITE**.

What does **not** exist anywhere in the tree (verified by repo-wide grep, R2):
`submitDecision`, `awaitDecision`, `sweepExpired`, `fleet approve|reject|attach`, the approvers
allowlist, the status join, the steering drain/ack, and — critically — **the teardown-at-pause
sequence**. The adapter never writes `pausing` at all; it goes straight to `awaiting-approval`
with no teardown. AC1(b)/(c) is the real net-new core of this story.

`pausing` is READ by existing code but written by nothing.

---

## 2. Confirmed green — the three story-blocking risks all clear

| Risk | Verdict | Evidence |
|---|---|---|
| `driver.exec` accepts stdin | ✅ yes | `exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult>` — `src/providers/driver.ts:198`; fake driver parity at `fake-driver.ts:346` |
| `teardownSandbox` accepts `noHarvest` | ✅ yes | `src/providers/teardown.ts:95`, honored :367 and :411. Real signature `(deps, runId, opts)` — **deps first**, story spells it `(runId, opts)` |
| `approval` in `EXTENSION_NAMESPACES` | ✅ already registered | `src/providers/run-record.ts:198-211`, `schemaVersion: 1` |

AC6's transport is implementable exactly as specced. Story text needs mechanical signature fixes.

## 3. The three engine-owned solicitation points (AC6 drain seam)

`export type SteeringPoint = "run_start" | "post_gate_failure" | "run_end"` —
`src/phase-engine/steering.ts:38`. "There is no fourth." DF3.4 adds inbox-drain + ack-append at
these same three; no fourth point, no edit to a DF3.3-owned line.

DF3.6's seam is **already marked** at `steering.ts:339` (`SEAM DF3.6: checkBounds(point) wraps
here`) — DF3.4 must leave that structurally intact for DF3.6 to rebase last.

`DIRECTIVE_TEXT_CHAR_CEILING = 4_000` already exists (`steering.ts:33`) — this is the bound the
story says DF3.4 "consumes rather than re-implements". **It exists today; no interim needed.**

INV-APPROVE-5 (steering carries no privilege) is already structurally enforced: directives are a
closed `z.discriminatedUnion` (`SteeringDirectiveSchema`, :47) further narrowed per-point by
`POINT_ALLOWLIST` (:400). An attach message enters as *prompt context*, never as a directive —
it cannot become one without passing a schema it never touches.

---

## 4. Contract decisions requiring a human call

### D1 — `supersededReportIds: string[]` is NOT expressible today  ⚠️ HIGH

`FieldKind = "string" | "int" | "ports"` (`run-record.ts:48`); `ExtensionEntry` values are
`string | number` (:115-118). `ports` is int[] only. The registered field is **singular**
`supersededReportId`, and DF5.1 writes it (:203, :223), returns it in `ApprovalOutcome`, and
pins it in `tests/reverify/approval.test.ts:57,62` + `tests/reverify/runner.test.ts:446,450`.
DF5.2 does **not** read it.

Options: (a) keep singular, record a spec deviation, lose history past one rebind; (b) widen
`FieldKind` with a `"strings"` member — touches DF2.1's union, `assertKind`, and
`ExtensionEntry`; (c) encode the ordered list in one delimited string.

**Unresolved and load-bearing:** does `assertNoSecret` walk array elements? If not, (b) opens a
secret-shaped hole and eliminates itself. And does DF5.3's audit chain actually need full ordered
history, or tolerate last-superseded-only? R2 was killed before answering either.

### D2 — `assertNoSecret` will likely reject `bundlePath`  ⚠️ HIGH

Any string ≥40 chars, mixed-class over `[A-Za-z0-9+/=_.:-]`, is refused as key material — the
exact shape of a filesystem path. `SHAPE_EXEMPT_PATHS` (:496-503) exempts only `keyHash` + two
budget fields. Precedent for pre-shaping: `reverifyId` at `runner.ts:240-245`.

Note the lazy option: nothing downstream reads `bundlePath` today. AC1(a2) wants it only to
re-validate a rebind. Not registering it may be correct — needs a call.

### D3 — the story's locking instruction is wrong  ⚠️ HIGH

Story §Technical Notes says use "DF2.1's per-record PID lock". That lock is **private inside
`RunRecordStore.set`**; DF5.1's Deviation 4 records that taking it externally deadlocks. R1
confirms: `assertWritable()` sits inside `withLock` (:1399); the wait uses `Atomics.wait`
(:1985-1987) and **blocks the event loop** up to 5 s per contended write.

`withApprovalLock` (`approval.ts:87-174`) is the existing correct answer — O_EXCL, 5 s ceiling,
10 ms poll, reclaim only on proof of death (`process.kill(pid,0)` → ESRCH; EPERM must not
reclaim), atomic claim via `renameSync`. **Recommend: export/reuse it, do not reinvent.**

Corollary the story misses: teardown takes seconds-to-minutes. The lock must **not** be held
across teardown. Split: lock for the state transition only.

### D4 — 40-hex `headSha` validation does not exist  ⚠️ MEDIUM

`report.ts:90` is `z.string().min(1)`; `push.ts:225` is raw trimmed `git rev-parse` output. Only
tests use 40-char values. The story (:74) writes as if it were pinned. Net-new.

---

## 5. R5's teardown findings — one BLOCKER, two HIGH

**BLOCKER (R5-D) — resume vs the cost ledger.** A resumed run re-provisioned under the same
runId **loses its second box's hours**: `boxHoursEventId` keys on the frozen `closedAt`. The
story never says whether resume gets a new runId. This is a money-loss path and must be decided
before implementation.

**HIGH (R5-B) — the story mandates a redundant `revokeAndVerify`.** `teardownSandbox` *already
performs it*. The story both mandates a separate call and contradicts itself on its position
(story :97-98 vs :303-304). A redundant call converts a provider-list hiccup into a hard failure
of an already-successful pause. **Recommend: drop the separate call; let teardown own it.**

**HIGH (R5-C) — `key-unattributable` runs at pause.** Box present, no keyHash, record open.
DF3.1 fixed exactly this for `fleet teardown`; the pause path would re-introduce "paused
cleanly" printed over a possibly-live billing key.

**Ownership:** `src/providers/teardown.ts` has four claimants (DF2.5 writes, DF4.2, DF2.8, DF5.3)
and a fixed merge order. **DF3.4 is not one of them** — it consumes `teardownSandbox` as-is.
Achievable with zero edits since `noHarvest` already exists.

**MEDIUM cluster:** (E) pause must wire `costLedger` with `costLedgerOpts(store.dir)` or it
strands the dispatch reservation against the issue cap; (F) the startup resume path must
re-acquire the run lock or two resumers race; (G) pause needs
`markRunLockDestructive`/`clearRunLockDestructive`; (H) **pause CLOSES the record** (teardown
step 7) — extensions stay writable post-close (:1226-1230) but every core field freezes (:1240).
The story reads as if "paused" means "open"; it does not.

---

## 6. Store facts DF3.4 must obey (R1)

- **G7 — `list()` throws on any anomaly.** The expiry sweep and status join MUST use
  `listWithAnomalies()` and carry `skipped`/`skippedReasons` forward (as `status.ts:665` does).
  A sweep on `list()` dies wholesale on one unrelated bad `.json`.
- **G8 — timing out is a WRITE.** No `timed-out` writer exists anywhere. The sweep must hold the
  approval lock, re-read state under it, refuse to overwrite terminal, and tolerate ENOENT.
  Reference idiom: `fanout-primitive.ts:876-879`.
- **G5 — a `create: false` store cannot decide.** `fleet status` builds a read-only store when
  `--dir` is given (`scripts/fleet.ts:2212`). `approve`/`reject` must construct a **writable**
  store, which will `mkdir -p` + `chmod 0700` — copy the nonexistent-`--dir` guard at
  `scripts/fleet.ts:334-349`.
- **G10 — never change `set`/`setLocked`/`validateExtensions`.** `impact` on `set` reports
  CRITICAL: 12 impacted symbols, 5 direct, 7 processes. DF3.4 adds to `EXTENSION_NAMESPACES`
  and calls `set()`.
- **G6 — the lock timeout is an untyped `Error`.** Do not text-match it into a "rejected"
  outcome.
- **G4 — `state` is validated only as `"string"`.** No transitions enforced store-side. DF3.4
  owns the whole state machine; `src/pr/push.ts:258-299` is the downstream enforcer.
- **G9 — no deadline field.** Either add `expiresAt` (additive, no schemaVersion bump — the read
  path tolerates unfamiliar fields in a registered namespace, :638-645) or derive expiry from
  `requestedAt` + a policy constant and store nothing. **The derive option is the smaller diff.**
- **G11 — a CLI ext-write escape hatch already exists** (`scripts/run-record.ts:95-114`,
  `--ext <ns>.<field>=<value>`). If approval writes must go *only* through the guarded verb,
  note this hatch is already open.

---

## 7. What DF3.4 must NOT break (R2)

- The `ApprovalPort` signature; `ApprovalOutcome` widens only in lockstep with
  `ReverifyOutcome.approval` (`runner.ts:200-206`).
- The four outcome tags and four-way state machine — including "pausing and terminal are left
  byte-identical, no write".
- DF5.2's reader (`src/pr/push.ts:257-299`) accepts **only** `state === "approved"` and requires
  `approverId`, `decidedAt`, `reportId`, `headSha`, plus `decidedAt >= report.completedAt`.
  Refusal matrix pinned by `tests/pr/open-pr.test.ts:196-224`.
- The explicit `supersededReportId: ""` on a fresh request — `store.set` deep-merges
  field-by-field, so a stale value would otherwise survive under a new reportId.
- `reverifyId`'s lowercase-hyphenated grammar (`runner.ts:241-245`) — mixed case trips
  `assertNoSecret`.
- Report flags `approval-request-failed`, `approval-pause-in-progress`,
  `approval-already-decided`.
- `reverify()` never throwing past its typed outcome because approval failed.
- The approval lock's proof-of-death semantics — never reclaim on age alone.
- Suites: `tests/reverify/approval.test.ts`, `tests/reverify/runner.test.ts` (AC6 block),
  `tests/pr/open-pr.test.ts`.

**Note:** DF5.1's Deviation 2 — the item sprint-status says DF3.4 closes — is a **prose**
amendment to DF5.1's AC6 text, not code. The hardened `extensions.approval` shape is already
implemented.

---

## 8. CLI chassis (R3, partial — self-gathered)

`src/fleet/verbs.ts` — `listVerbs(): VerbEntry[]`, currently **6 entries** (dispatch, status,
harvest, teardown, fanout, rank). Entry shape:
`{ verb, summary, flags: [{name, required, valueType: "string"|"path"|"boolean"}], exitCodes }`.

The registry is a **CONTRACT**, not documentation: the CLI validates accepted flags against it,
and DF3.5's skill-contract test compares declared exit codes against what verbs actually return.
DF3.4 appends `approve`/`reject`/`attach` additively (DF3.2's `fanout`/`rank` are the precedent
for additive entries with no DF3.1-owned edit).

`--driver` is required on every verb (`assertDriverChosen`) — **except** `rank`, which takes no
driver because it reads records only. **Open question for the gate:** `approve`/`reject` are
pure record operations like `rank` and plausibly need no driver; `attach` clearly does. Not yet
confirmed against the exit-code table — R3 died before delivering it.

**Still missing from R3:** the full exit-code table as implemented, the `printError`/`refuse`
idiom, `writeAll`'s guards for INV-APPROVE-9, `status.ts`'s exact insertion seam and `StatusRow`
states, the stdin `isCharacterDevice` allow-list guard to copy for the approver token, and
whether a constant-time comparison helper exists anywhere.

---

## 9. Research coverage and confidence

| Track | Status | Weight |
|---|---|---|
| R1 store/extensions | ✅ full | high |
| R2 approval seam | ✅ full (follow-up on D1-D4 killed mid-flight) | high |
| R5 teardown/creds | ✅ full | high |
| R3 CLI chassis | ⚠️ partial — self-gathered registry + steering consts only | medium |
| R4 steering transport | ⚠️ partial — points, ceiling, driver sig confirmed; drain/ack seam detail missing | medium |
| R6 ref repos + tests | ❌ not run | none |

**Confidence ≈ 0.65** — below the 0.8 auto-approve threshold. Phase 3 HITL gate is **required**,
not skippable. Five agents died on a session limit (resets 21:30 ET); R3/R4/R6 need re-running
before implementation.
