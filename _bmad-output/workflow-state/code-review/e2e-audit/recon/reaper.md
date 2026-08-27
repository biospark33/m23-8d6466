# RECON BRIEF — DF2.6 Orphan Reaper Live-Proof Design

Repo /Users/steve/QDS-Factory, branch `feature/df3-2-fanout-best-of-n`. Read-only recon, nothing edited.

## 1. Mechanism

Two distinct reapers:

### (A) Ledger-side orphan expiry (the aged-reservation expiry)

- `gate_admissions` writer: `CostLedger.admitIssue` INSERT at `src/providers/cost-ledger.ts:1615-1621` (`ON CONFLICT(request_id,run_id) DO NOTHING`), inside the `decide.immediate()` txn (`:1370`, `:1704`). Table DDL + append-only triggers (RAISE ABORT on UPDATE/DELETE) `:306-325`.
- Sole production call chain: `scripts/fleet.ts` dispatch verb → `src/fleet/dispatch.ts:1682` `assertWithinBudget` → `src/providers/budget-gate.ts:85` `ledger.admitIssue`. createRun's own gate was DELETED (refusal `assertAdmissionNotDelegated`, `src/providers/driver.ts:771-778`) — exactly one admission site.
- "Aged": `decided_at` older than `graceCutoff = Date.now() − ADMISSION_GRACE_MS (60_000, cost-ledger.ts:182) − ADMISSION_SKEW_MARGIN_MS (300_000, :206)` ⇒ **6 min real time**, computed in-txn at `:1428`. Unparseable/future `decided_at` counts young (`:1460-1467`).
- Classification (`:1487-1553`): `readRunRecord` undefined (=ENOENT; wiring maps store ENOENT→undefined, `scripts/fleet.ts:861-870`) + aged ⇒ **SILENT expire**, bare `continue` at `:1554` — NO log line, `reservedMicroUsd` just drops. throw+young ⇒ rethrow, refuses THIS dispatch (`:1499`). throw+aged ⇒ `recordStructurallyAbsent` (`:1765-1776`): legacy-grammar miss | statSync ENOENT | 0-byte file ⇒ expire WITH log code `reservation-unresolvable-expired` (`:1535-1551`); other errno/non-empty file ⇒ held, code `reservation-unresolvable-held` (`:1512-1529`).
- `runsDir` seam: stats `join(this.runsDir, \`${runId}.json\`)` `:1771`. Wired via `makeLedgerFactory` `scripts/fleet.ts:850-874` (`runsDir: store.dir`; round-10 fix comment `:855`); teardown twin `:2183-2200`.
- Other retirement arms in same loop: priced>0 `cost_event` retires (`:1409-1412`); `closedAt <= graceCutoff` retires (`:1569-1575`).

### (B) Fleet-side reaper

- `reapRuns`: `src/providers/driver.ts:1201-1282` — destroys boxes no OPEN record claims (claim by runId+vmName `:1249-1254`; refuses unverified VM listing `:1239`, unverified records `:1242-1247`, unproven ownership `:1270-1271`).
- **KEY FINDING: `reapRuns` has ZERO callers in src/ or scripts/.** Docstring says "Lifecycle verb `reap`" (`driver.ts:1194`) but the verb registry is exactly dispatch/status/harvest/teardown/fanout/rank (`src/fleet/verbs.ts listVerbs`) — NO reap verb is wired.
- The ACTIVE CLI reaper is `bun scripts/sandbox-reap.ts [--yes] [--driver <name>]` → `sweep()` `src/providers/reaper.ts:301+`. Dry-run default, `--yes` applies; whoami preflight before ANY deletion; refuses whole run on unreadable record or partial VM/key listing. Stale threshold = `limits.staleAfterMs`, default 14_400_000 ms = 4h (`src/providers/quota.ts:47`), overridable via `QDS_QUOTA_LIMITS_FILE` env (REAL config knob). Classifies leaked-vm→destroy, stale-record→teardown (sharedActionRunId), leaked-key→revoke; record-less key with unparseable age ⇒ report, never revoke.

## 2. Production trigger

Ledger-side expiry is **LAZY-ONLY**: evaluated solely inside the NEXT `admitIssue` for the SAME canonical `(repoSlug, issueId)`. No timer/cron/loop/CLI. `issueBudgetSnapshot` (`cost-ledger.ts:1221-1262`) does NOT apply the orphan guard or grace cutoff — counts ALL unsettled reservations — so it over-reports vs what admitIssue will count.

⇒ "Proven live" means a second REAL admission after 6 min observes headroom restored. Observable = decision #2's `reservedMicroUsd` excluding the orphan ceiling (+ contrast vs snapshot which still includes it). Clean-ENOENT orphans produce NO "expired" log line — silence + numbers is pass; the logged code only fires on tombstone/corrupt arm.

## 3. Live test design (real substrate, real clock)

No clock seam on admitIssue (bare `Date.now` `:1428`/`:1460`; `deps.now` only in sweep, `reaper.ts:304`). `ADMISSION_GRACE_MS` is an exported const, not env-tunable. Waiting 6 min is the only production-path option — acceptable.

Kill window anatomy: admission COMMIT → finally `ledger.close()` (`dispatch.ts:1725-1727`) → step 6 `provisionAdmittedRun` (~`dispatch.ts:1856`) → `store.create` record-first (`driver.ts:502`, INV-1) → budget-extension set → `driver.create` (slow, real substrate). The [admission-commit → record-rename] gap is all-local, MILLISECONDS wide.

### Design A — ledger expiry proof ($0 model)

1. Isolated scratch dirs: `QDS_RUNS_DIR` + `QDS_COST_LEDGER_FILE` (honored by `costLedgerOpts`, `scripts/lib/cost-ledger-opts.ts`; default ledger `.sandbox/cost-ledger.db`, `cost-ledger.ts:394`). Never shared `.sandbox`.
2. Real `fleet dispatch` #1, tiny cap (T2 precedent capMicroUsd 50_000/arm), SIGKILL between commit and store.create. Timing aid: watcher polls `gate_admissions` in the ledger db (WAL readers see committed rows immediately), kills on first row for our requestId; still racy ⇒ LOOP attempts until state achieved: row present AND `<runsDir>/<runId>.json` absent. Unlucky attempts either refused pre-admission ($0) or left record+box → Design B cleanup. If ms-window unwinnable after N tries, REPORT THE WINDOW WIDTH as the finding; do NOT hand-insert db rows (forfeits production-path standing). Production rollback at `driver.ts:508-524` manufactures exactly this orphan (non-lock budget-write failure ⇒ rmSync of record after commit) but EIO can't be triggered live.
3. Negative control BEFORE 6 min elapse: fresh ids, same issue ⇒ young+ENOENT still reserves (`reserve(row.ceiling)` `:1576`) — proves the window real.
4. Wait ≥360 s from `decided_at`. Dispatch #2 again ⇒ expect admitted:true, `reservedMicroUsd` WITHOUT orphan ceiling; snapshot still showing it (lazy-only contrast). Pass = admission succeeds against a cap the orphan previously consumed.

### Design B — leak remediation (the half with an active trigger)

Kill landing after store.create leaves OPEN record (+live box, post-mint a live sbx-* key). Write quota-limits JSON with `staleAfterMs` e.g. 60_000, point `QDS_QUOTA_LIMITS_FILE` at it (real knob), wait >threshold, run `bun scripts/sandbox-reap.ts --driver <real> --yes`: expect stale-record→teardown rows, exit 0. Then confirm ledger side: teardown's box_hours ingest writes priced row ⇒ reservation retires via the `:1409-1412` arm — assert that too. Final sweep: fleet status + provider VM list + key list clean; sandbox-reap dry-run reports empty.

## 4. Safety

- SQLite WAL + busy_timeout 5000 (`cost-ledger.ts:752-754`), mode 0600 propagates to -wal/-shm (`:742`). SIGKILL mid-txn: standard WAL recovery discards uncommitted frames ⇒ worst case NO row (retry). Post-commit kill durable-safe.
- Locks: plain `dispatch` holds NEITHER `.sandbox/fleet.lock` NOR a per-run lock. FleetLock is fanout-only (`new FleetLock` `src/fleet/fanout-primitive.ts:262`; path `.sandbox/fleet.lock` `fleet-lock.ts:32`, stale 3_600_000 ms `:35`; reclaim requires age AND dead/mismatched owner `:379`, serialized under `<path>.reap` `:354-362`). `acquireRunLock` is for status/teardown/harvest verbs (`scripts/fleet.ts:2108`) and fanout-record (`src/fleet/fanout.ts:187`). So SIGKILLing a single dispatch strands NO lock — no stale-reclaim interplay unless routed through fanout (then killed leader's lock reclaimed by two-part test; safe).
- Hazards: (i) kill between store.create and budget-set ⇒ OPEN+BUDGETLESS record — production only cleans this when the write THROWS (rmSync rollback `driver.ts:508-524`), not on SIGKILL; leftover is cap-conservative (ceiling counts while OPEN) but never prices; remediate via B. (ii) kill mid driver.create ⇒ half-provisioned box; teardown falls back to runId-named destroy (`driver.ts:1184-1190`); reapRuns claims both names (`:1202-1206`) — recoverable. (iii) never SIGKILL during sandbox-reap --yes itself. (iv) aggressive staleAfterMs limits file must point ONLY at scratch runs dir, else it classifies real fleet records stale.

## 5. Spend estimate

Model ≈ $0: admission/provision make zero model calls; kills land pre-agent-spawn; engine gate-C ping (commit 1f2830d) fires only deeper in pipeline. If dispatch #2 reaches a worker turn, one tiny ping — avoidable by tearing down right after ack.
Substrate: only attempts reaching driver.create leave a box; ≤10 attempts × minutes + one 6-min idle wait + B-cleanup ⇒ well under 1 fractional box-hour, cents-level. Fake-driver rehearsal $0, identical ledger code — tune kill-loop there first; headline proof stays real substrate.

---

*Caveat: ~-marked cites (dispatch step-6 entry ~`:1856`, reaper `aged` closure ~`:404`) approximate from sed windows; all load-bearing constants/branch cites read directly.*
