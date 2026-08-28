# R2 — The existing approval seam (DF5.1 + DF5.2), mapped exactly

Read-only survey, branch `feature/df3-4-approval-gate-attach-steering`.
Everything below is what is ON DISK today. DF3.4 must conform to it, not invent.

---

## 1. The `ApprovalPort` seam — `src/reverify/approval.ts`

The whole public type surface, verbatim (`src/reverify/approval.ts:21-41`):

```ts
export type ApprovalState = "pausing" | "awaiting-approval" | "approved" | "rejected" | "timed-out";

const TERMINAL: ReadonlySet<string> = new Set(["approved", "rejected", "timed-out"]);

export interface ApprovalRequest {
  proposal: string;
  /** THE report's `reverifyId` — the approval binds to one report, not a run. */
  reportId: string;
  /** THAT report's `headSha` — the second value DF5.2 re-checks before pushing. */
  headSha: string;
}

export type ApprovalOutcome =
  | { outcome: "requested" }
  | { outcome: "rebound"; supersededReportId: string }
  | { outcome: "pause-in-progress" }
  | { outcome: "already-decided"; state: string };

export interface ApprovalPort {
  requestApproval(runId: string, req: ApprovalRequest): Promise<ApprovalOutcome>;
}
```

**ONE method.** No `submitDecision`, no `awaitDecision`, no `sweepExpired` — those four names
appear ONLY in the DF3.4 story text, nowhere in `src/`, `tests/`, `scripts/` or `docs/`.

Re-exported as public API from `src/reverify/index.ts:21-27`:

```ts
export {
  recordApprovalPort,
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  type ApprovalState,
} from "./approval.ts";
```

Module header (`approval.ts:1-14`) states the contract explicitly:

> DF5.1 is the SINGLE OWNER of the `requestApproval` caller … When DF3.4 lands its own
> implementation it replaces the ADAPTER, not the caller: the state machine below is
> caller-side contract.

---

## 2. The adapter DF3.4 replaces — `recordApprovalPort`, `approval.ts:176-231`

```ts
export function recordApprovalPort(store: RunRecordStore): ApprovalPort {
  return {
    async requestApproval(runId: string, req: ApprovalRequest): Promise<ApprovalOutcome> {
      return withApprovalLock(store.dir, runId, () => {
        const existing = store.get(runId).extensions?.approval;
        const state = existing?.state;

        // Created O_EXCL before teardown, not yet promoted (DF3.4). Neither
        // rebound nor requested against: DF3.4's resume path is what clears it.
        if (state === "pausing") return { outcome: "pause-in-progress" };
        if (typeof state === "string" && TERMINAL.has(state)) {
          return { outcome: "already-decided", state };
        }

        const requestedAt = new Date().toISOString();
        if (state === "awaiting-approval") {
          // REBIND, never a second create: a re-run of reverify must not brick
          // the run on a record bound to a superseded report.
          const supersededReportId = String(existing?.reportId ?? "");
          store.set(runId, {
            extensions: {
              approval: {
                state: "awaiting-approval",
                proposal: req.proposal,
                reportId: req.reportId,
                headSha: req.headSha,
                requestedAt,
                supersededReportId,
              },
            },
          });
          return { outcome: "rebound", supersededReportId };
        }

        store.set(runId, {
          extensions: {
            approval: {
              state: "awaiting-approval",
              proposal: req.proposal,
              reportId: req.reportId,
              headSha: req.headSha,
              requestedAt,
              // `set()` deep-merges the namespace field-by-field, so an omitted
              // key retains whatever a prior cycle left there. This is a fresh
              // request, not a rebind — explicitly clear supersededReportId
              // rather than leave a stale value from an earlier rebind visible
              // under this new reportId.
              supersededReportId: "",
            },
          },
        });
        return { outcome: "requested" };
      });
    },
  };
}
```

### What is REAL behavior (must be preserved) vs placeholder

| Behavior | Verdict |
|---|---|
| Four-way state machine: `pausing` → pause-in-progress; terminal → already-decided; `awaiting-approval` → rebind; absent → requested | REAL, contract, tested in `tests/reverify/approval.test.ts` AND `tests/reverify/runner.test.ts:346+` |
| Rebind writes new `reportId`/`headSha` and records displaced id in `supersededReportId` | REAL |
| Fresh request explicitly writes `supersededReportId: ""` because `store.set` deep-merges per field | REAL, subtle, easy to lose |
| Cross-process lock around the read-decide-write | REAL |
| Storage location `RunRecord.extensions.approval` | REAL, and DF5.2 depends on it |
| Fields written: only `state, proposal, reportId, headSha, requestedAt, supersededReportId` | Placeholder-ish: DF3.4 adds `approverId/decidedAt/reason` and whatever else it registers |
| `pausing` is READ but NEVER WRITTEN anywhere in the repo | Placeholder — DF3.4 owns writing it (before teardown) and clearing it (resume) |
| Decide side (`approve`/`reject`, allowlist, expiry, teardown-at-pause) | Does not exist at all |

---

## 3. The caller (DF5.1 AC6) — `src/reverify/runner.ts:401-438`

Precondition: report already sealed and appended to disk, and `report.verdict === "green"`.

```ts
  if (report.verdict !== "green") return { report, approval: null };

  // A writable store: `store` above may be the read-only (`create: false`) one,
  // and the approval write needs a store that can create.
  const port =
    deps.approval ?? recordApprovalPort(deps.store ?? new RunRecordStore({ dir: runsDir }));
  // The approval request is the LAST thing and it is caught: the green report
  // is already on disk, and a failed request must leave a report that SAYS so
  // rather than throwing past `reverify`'s typed outcome (AC4). DF5.2 gates on
  // the approval state, so no approval means no PR either way.
  let approval: ReverifyOutcome["approval"];
  try {
    approval = await port.requestApproval(runId, {
      proposal: `open a PR for run ${runId} at ${report.headSha}`,
      reportId: report.reverifyId,
      headSha: report.headSha,
    });
  } catch (e) {
    flags.push("approval-request-failed");
    const flagged = seal(nondeterministic);
    appendReport(reverifyDir, flagged);
    step("approval", Date.now() - startedMs, {
      outcome: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return { report: flagged, approval: null };
  }
  if (approval.outcome === "pause-in-progress" || approval.outcome === "already-decided") {
    // The flag belongs on the report, so re-seal and append the corrected one.
    const flag = approval.outcome === "pause-in-progress" ? "approval-pause-in-progress" : "approval-already-decided";
    flags.push(flag);
    const flagged = seal(nondeterministic);
    appendReport(reverifyDir, flagged);
    step("approval", Date.now() - startedMs, { outcome: approval.outcome });
    return { report: flagged, approval };
  }
  step("approval", Date.now() - startedMs, { outcome: approval.outcome });
  return { report, approval };
```

- YES, it already passes `reportId` (= `report.reverifyId`) and `headSha` (= `report.headSha`).
- Injection seam: `ReverifyDeps.approval?: ApprovalPort` (`runner.ts:52`). DF3.4's adapter plugs
  in here (or replaces the default in the `??` chain at `runner.ts:405-406`).
- `ReverifyOutcome.approval` (`runner.ts:200-206`) is the `ApprovalOutcome` union inlined + `| null`.
  Widening `ApprovalOutcome` means widening that too.
- Flags emitted on the report today: `approval-request-failed`, `approval-pause-in-progress`,
  `approval-already-decided`. These are DF5.1's, already asserted in
  `tests/reverify/runner.test.ts:393,430`.

---

## 4. DF5.2's reader — `src/pr/push.ts:257-299` (inside `preflight`)

Verbatim, the whole approval block:

```ts
  // ── 3. DF3.4's approval, bound to THAT report ──
  const approval = record.extensions?.approval;
  if (approval === undefined) {
    throw new PrRefusalError("approval-missing", `run ${runId} carries no approval record`, { reportPath: rp });
  }
  if (approval.state !== "approved") {
    throw new PrRefusalError("approval-not-approved", `approval for ${runId} is ${String(approval.state)}, not approved`, {
      reportPath: rp,
    });
  }
  const approverId = String(approval.approverId ?? "");
  const decidedAt = String(approval.decidedAt ?? "");
  if (approverId === "" || decidedAt === "") {
    throw new PrRefusalError("approval-incomplete", `approval for ${runId} carries no approverId/decidedAt`, {
      reportPath: rp,
    });
  }
  if (String(approval.reportId ?? "") !== report.reverifyId) {
    throw new PrRefusalError(
      "approval-report-mismatch",
      `approval for ${runId} is bound to report ${String(approval.reportId)}, not ${report.reverifyId}`,
      { reportPath: rp },
    );
  }
  if (String(approval.headSha ?? "") !== headSha) {
    throw new PrRefusalError(
      "approval-sha-mismatch",
      `approval for ${runId} is bound to sha ${String(approval.headSha)}, not ${headSha}`,
      { reportPath: rp },
    );
  }
  // An approval of an EARLIER verdict never authorizes a later re-harvest, so
  // the decision must post-date the report it claims to authorize. Both stamps
  // are host clocks (DF5.1 and DF3.4 both write host-side), so they compare.
  const decided = Date.parse(decidedAt);
  const completed = Date.parse(report.completedAt);
  if (!Number.isFinite(decided) || !Number.isFinite(completed) || decided < completed) {
    throw new PrRefusalError(
      "approval-precedes-report",
      `approval for ${runId} was decided at ${decidedAt}, before report ${report.reverifyId} completed at ${report.completedAt}`,
      { reportPath: rp },
    );
  }
```

### Required read shape (the hard contract)

Read at `record.extensions.approval` (flat, `ExtensionEntry` — string/number values only):

| Field | Requirement | Refusal if violated |
|---|---|---|
| `state` | must be exactly `"approved"` | `approval-not-approved` |
| `approverId` | non-empty string | `approval-incomplete` |
| `decidedAt` | non-empty, `Date.parse`-able, **>= `report.completedAt`** | `approval-incomplete` / `approval-precedes-report` |
| `reportId` | `=== report.reverifyId` of the LAST report line | `approval-report-mismatch` |
| `headSha` | `=== git rev-parse refs/sandbox/<runId>` right now | `approval-sha-mismatch` |
| namespace present at all | else | `approval-missing` |

`headSha` compared against `push.ts:225`: `const headSha = probe.exitCode === 0 ? probe.stdout.trim() : "";`
(raw `git rev-parse --verify --quiet refs/sandbox/<runId>^{commit}` output).

Only `approverId` and `decidedAt` propagate further — into `Preflight.approval`
(`push.ts:107, 341`) → `renderBody` (`src/pr/open-pr.ts:271`, `src/pr/body.ts:31,105`:
`Approved by: ${approverId} at ${decidedAt}`). `reportId`/`headSha` are re-derived from the
report/git, not taken from the approval, once past the gate.

Refusal states pinned by test (`tests/pr/open-pr.test.ts:196-214`): absent, `awaiting-approval`,
wrong `reportId`, wrong `headSha`, and (`:216+`) `decidedAt` before `completedAt`.

---

## 5. `ReverifyReport`, `reverifyId`, `headSha`

`ReverifyReport` — `src/reverify/report.ts:117-140`, readonly interface:
`{ reverifyId, runId, requestId, headSha, baseSha, verdict: "green"|"red"|"error", reason?,
startedAt, completedAt, durationMs, checks, testResults, flags, discrepancies, claimed,
toolchain, timings, failure?, nondeterministic?, noTestSuite? }`.
Verdict is computed inside `sealReport`; there is no deserialization path that accepts one.

`reverifyId` minted at `src/reverify/runner.ts:241-245`:

```ts
  // Lowercase and hyphenated on purpose: this id is written into the run
  // record as `extensions.approval.reportId`, and DF2.1's `assertNoSecret`
  // refuses any long mixed-case alphanumeric there as suspected key material.
  const reverifyId =
    `rv-${runId}-${started.toISOString().replace(/[:.]/g, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
```

**`headSha` 40-hex validation DOES NOT EXIST anywhere.**
- `report.ts:90`: `headSha: z.string().min(1)` — length only.
- `push.ts:225`: raw trimmed `git rev-parse` output.
- Only tests use 40-char values (`"a".repeat(40)` in `tests/reverify/approval.test.ts:26`).
If DF3.4 wants a 40-hex assertion it is NEW code, not a reuse. Flagged as ambiguous — the DF3.4
story (line 74) asserts "the 40-hex sha" as if pinned.

**Superseding logic already exists** (`approval.ts:194,203,223`): a single `supersededReportId`
string, `""` on fresh request, previous `reportId` on rebind, surfaced in the outcome
`{ outcome: "rebound", supersededReportId }`. DF3.4 reuses this, it does not need to invent it.

---

## 6. The existing approval lock — `withApprovalLock`, `approval.ts:57-174`

- Path: `<store.dir>/<run-id>.approval.lock` (i.e. next to the run records, NOT under
  `.sandbox/approvals/`).
- `writeFileSync(..., { flag: "wx", mode: 0o600 })`, content `${process.pid}:${randomUUID()}`.
- `LOCK_TIMEOUT_MS = 5_000`, `LOCK_POLL_MS = 10`, `LOCK_STALE_MS = 10_000` (deliberately 2×
  timeout — at exactly the timeout a waiter would steal every lock the instant it gave up).
- Reclaim requires **proof of death** (`process.kill(pid, 0)` → `ESRCH`), never age alone; EPERM
  means alive-but-other-user and must NOT reclaim.
- Atomic claim via `renameSync(lockPath, claimPath)`; `ENOENT` means another racer won → retry.
  Content compared to the pre-rename read; on mismatch the captured live replacement is written
  back. Once `claimed = true`, ANY error fails closed (`approval.ts:158`) rather than retrying.
- Released in `finally` with `rmSync(lockPath, { force: true })`.
- Reason it is a SEPARATE lock (`approval.ts:43-50`): `RunRecordStore.set` is atomic but its lock
  is private and taken *inside* `set`; taking the store's own lock would deadlock.

Tests: `tests/reverify/approval.test.ts` "approval lock" describe block — dead-holder steal,
live-holder-not-reclaimed-by-age, replacement-lock-not-destroyed, concurrency.

**DF3.4 reuses or replaces?** The DF3.4 story says "DF2.1's per-record PID lock (atomic replace
guarded by the lock)" — but that lock is private to `RunRecordStore.set` and cannot wrap a
read-decide-write from outside. `withApprovalLock` is the working answer to exactly that problem.
Recommendation: **reuse it** (export it or move it into DF3.4's module). Flagged: the story's
wording implies a lock that is not externally usable.

---

## 7. Full hit list for the searched identifiers

`.sandbox/approvals/` — **ZERO hits** in `src/`, `tests/`, `scripts/`, `docs/`. Only referenced as
a rejected alternative in DF5.2's story (`df5-2-host-side-pr-creation.md:~292`).

`submitDecision`, `awaitDecision`, `sweepExpired` — **ZERO hits** outside the DF3.4 story file
(`df3-4-approval-gate-attach-steering.md:49,94,116,322,345`).

`fleet approve` / `fleet reject` — **ZERO** verbs registered. `scripts/fleet.ts` has no approve or
reject. Only prose in `src/reverify/approval.ts:7`.

`requestApproval`:
- `src/reverify/approval.ts:2,5,40,178`
- `src/reverify/runner.ts:413`
- `src/providers/run-record.ts:189` (comment)
- `tests/reverify/approval.test.ts:33,38,54,55,79,100,114,128,129,156,176,216,293,328`
- `tests/reverify/runner.test.ts:35,346,406`

`awaiting-approval`:
- `src/reverify/approval.ts:21,191,198,213`
- `src/providers/run-record.ts:195`
- `src/pr/…` — none directly; `tests/pr/open-pr.test.ts:199` uses it as the refusal fixture
- `tests/reverify/approval.test.ts:33,42,59,116,135`; `tests/reverify/runner.test.ts:451`

`approval-pause-in-progress` / `approval-already-decided`:
- `src/reverify/runner.ts:430` (both, ternary)
- `tests/reverify/runner.test.ts:393,430`

`pausing` — `src/reverify/approval.ts:21,185`; `src/providers/run-record.ts:195`;
`tests/reverify/approval.test.ts:74`. **Never written by any production code.**

`timed-out` (approval sense) — `src/reverify/approval.ts:21,23`;
`src/providers/run-record.ts:195`; `tests/reverify/approval.test.ts:87`. No expiry sweeper exists.

Approval lock — `src/reverify/approval.ts:87-174`; tests `tests/reverify/approval.test.ts:140+`.

---

## 8. The registered namespace — `src/providers/run-record.ts:187-211`

```ts
  /**
   * DF3.4's pre-PR approval gate, registered here so DF5.1 — the single owner
   * of the `requestApproval` CALLER — can bind a green host verdict to a
   * decision. `reportId` is a `ReverifyReport.reverifyId` and `headSha` is that
   * same report's head: the approval binds to one report, not to a run in
   * general, and `supersededReportId` records the report a rebind displaced.
   *
   * States: `pausing` (created before teardown, not yet promoted),
   * `awaiting-approval`, then terminal `approved` / `rejected` / `timed-out`.
   * DF3.4 owns the decide side and may extend these fields.
   */
  approval: {
    schemaVersion: 1,
    fields: {
      state: "string",
      proposal: "string",
      reportId: "string",
      headSha: "string",
      requestedAt: "string",
      supersededReportId: "string",
      approverId: "string",
      decidedAt: "string",
      reason: "string",
    },
  },
```

Constraints DF3.4 inherits from DF2.1 (`run-record.ts`):
- `FieldKind = "string" | "int" | "ports"` (`:48`). `ports` is `int[]`. **There is no `string[]`.**
- `ExtensionEntry` values are `string | number` (`:115-118`) — flat, no nesting.
- Write path is exact-match allow-listed: unknown field → `unknown key: extensions.approval.X`
  (`:648`). Read path tolerates newer `schemaVersion` + unfamiliar fields (`:638-645`), so
  DF3.4 adding fields is backward-safe for readers.
- Every written string passes `assertNoSecret` (`:528-564`): secret prefixes at token boundary;
  and a value >= 40 chars that is mixed-class (`[a-z]` AND `[A-Z]` AND `\d`) over charset
  `[A-Za-z0-9+/=_.:-]` is REJECTED. URLs (`scheme://`) exempt. `SHAPE_EXEMPT_PATHS` is only
  `keyHash`, `extensions.budget.repoSlug`, `extensions.budget.issueId`.
- `extensions` stays writable after `closedAt` (`:1227`) — the pause-after-teardown path works.
- `set()` deep-merges the namespace field-by-field (`:608-655`, `structuredClone(existing)`), so
  an omitted key retains its previous value. This is why the adapter clears `supersededReportId`
  explicitly.

---

## 9. DF5.1 story — AC6 and Deviations 1-2
(`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-1-host-side-reverify.md`)

AC6 in the trigger surface (`:105`, `:107`): `requestApproval(runId, { proposal, reportId, headSha })`
called on a green verdict is IN SCOPE for DF5.1; "Deciding the approval (approve/reject intake,
record write, teardown-at-pause)" is OUT of scope → DF3.4.

Technical note `:130-133`: "**Approval binding, named once:** `ApprovalRecord.reportId` **is**
`ReverifyReport.reverifyId`, and `ApprovalRecord.headSha` is that same report's `headSha`. Those
are the two values AC6 passes into `requestApproval(...)`, and the two DF5.2 re-checks before it
pushes — the approval is bound to one report, not to a run in general."

**Deviation 1** (`:247-252`): DF3.4 was not implemented; per operator decision DF5.1 shipped the
caller behind `ApprovalPort` + a RunRecord-backed adapter so AC6 is exercised end to end.
"DF3.4 replaces the **adapter**, not the caller." Registering the `approval` namespace was
required for that adapter; gitnexus impact on that symbol was **LOW, 0 upstream dependents**.
"DF3.4 may extend the field set."

**Deviation 2** (`:253-257`) — the one DF3.4 closes:
> **AC6 wording vs DF3.4's hardened design.** AC6 describes a separate `ApprovalRecord` created
> `O_EXCL`; DF3.4's 2026-08-20 hardening moved approval state into `runRecord.extensions.approval`
> (namespace registration, PID lock, writable-after-close). Built against the **predecessor's**
> shape per operator decision. AC6's prose should be amended to match; the state machine it
> specifies (`pausing` untouched, `awaiting-approval` rebound atomically with the superseded id
> recorded, terminal left alone) is implemented verbatim.

Listed as an open follow-up (`:329`): "AC6 prose amendment per Deviation 2."
So DF3.4 lands the storage decision that is already IMPLEMENTED (extensions.approval), and the
amendment is a prose fix to DF5.1's AC6 text — the code already agrees.

Deviation 4 (`:264-267`) documents the separate `O_EXCL` approval lock and why the store's own
lock could not be used.

Follow-ups (`:324-329`): "**DF3.4** replaces `recordApprovalPort` with its own adapter and owns
the decide side. The caller contract in `approval.ts` is what it must satisfy."

---

## 10. Conflicts between the DF3.4 story text and what exists — FLAGGED, not guessed

1. **`supersededReportIds: string[]` (DF3.4 story `:205-208`) is UNWRITABLE today.**
   `FieldKind` has no `string[]`, `ExtensionEntry` values are `string | number`, and `assertKind`'s
   array branch accepts integers only. The existing registered field is singular
   `supersededReportId: "string"`, and `ApprovalOutcome`'s `rebound` variant carries a singular
   `supersededReportId: string` that `runner.ts` and both test suites consume. Options: keep
   singular (smallest diff, no schema surgery), or extend `FieldKind` with a string-array kind
   (touches DF2.1's core validator), or store a delimited string. Decision needed.

2. **`bundlePath`, `requestId`, `expiresAt` (DF3.4 story `:204-205`) are NOT registered.**
   Additive registration in `EXTENSION_NAMESPACES.approval` is required or the write throws
   `unknown key: extensions.approval.bundlePath`. Additive is LOW risk (read path tolerates it).
   Watch `assertNoSecret`: a `bundlePath` >= 40 chars that happens to be mixed-class over
   `[A-Za-z0-9+/=_.:-]` (a path IS in that charset) will be rejected as suspected key material.

3. **The 40-hex `headSha` validation the story assumes does not exist.** New work.

4. **"DF2.1's per-record PID lock" cannot guard a read-decide-write from outside** — it is private
   to `RunRecordStore.set`. `withApprovalLock` exists precisely for this. Reuse recommended.

5. **`src/fleet/approval-gate.ts` (DF3.4 DOD `:322`) vs `src/reverify/approval.ts`.** The port
   type and the `ApprovalOutcome` union are currently exported from `src/reverify/index.ts` and
   imported by `runner.ts`. If the implementation moves to `src/fleet/`, the TYPE must either stay
   put or the reverify import must be updated; a duplicate type declaration would silently fork
   the contract.

---

## 11. What DF3.4 must NOT break

- The `ApprovalPort` interface signature — `runner.ts:52` and `tests/reverify/runner.test.ts:25,33,405`
  type against it. `ApprovalOutcome` may be WIDENED only if `ReverifyOutcome.approval`
  (`runner.ts:200-206`) is widened in lockstep.
- The four-way state machine and its exact outcome tags: `requested`, `rebound` (+
  `supersededReportId`), `pause-in-progress`, `already-decided` (+ `state`).
- Storage at `RunRecord.extensions.approval`, flat string/number fields, registered namespace.
- The five fields `src/pr/push.ts` reads: `state === "approved"`, non-empty `approverId`,
  non-empty parseable `decidedAt` >= `report.completedAt`, `reportId === report.reverifyId`,
  `headSha === git rev-parse refs/sandbox/<runId>`.
- The explicit `supersededReportId: ""` on a fresh request (deep-merge defeat).
- `reverifyId`'s lowercase-hyphenated grammar — changing it trips `assertNoSecret`.
- Report flags `approval-request-failed`, `approval-pause-in-progress`, `approval-already-decided`.
- `reverify()` never throws past its typed outcome because of an approval failure
  (`runner.ts:412-427`).
- The lock's proof-of-death semantics: never reclaim on age alone, fail closed after `claimed`.
- Existing suites: `tests/reverify/approval.test.ts`, `tests/reverify/runner.test.ts` (AC6 block),
  `tests/pr/open-pr.test.ts` (approval refusal matrix).
