# T3 Live-Proof Audit — Test List (FINAL DRAFT, ready for next session)

Status: READY. Synthesized from four parallel recon briefs
(`recon/race.md`, `recon/stories-port.md`, `recon/reaper.md`,
`recon/phase-engine.md` — committed beside this file) plus session ground
truth in `e2e-run-report.md` §TIER-2 FINAL (T2.1+T2.2 PROVEN at `4804765`).
Executor: fresh-context session. No new features — prove shipped code on real
substrate; every discovered product gap is either fixed pre-test (F15b) or
filed as a story proposal (in-box executor).

## Spend protocol (NON-NEGOTIABLE, unchanged)

1. BEFORE each costing run: print keys × capMicroUsd + boxes × est hours +
   worst-case total in µ$ AND dollars → HALT for operator's explicit "go".
2. Defaults: capMicroUsd = 50,000/key; box ≤ 1h @ 230,000 µ$/h. F15 rule: any
   fan-out declares its aggregate via `perIssueOverrides` (ceiling ≥ n×cap) or
   refuses exit-5 pre-mint — by design.
3. Solo runs only (F9 load-flake family); one documented retry per flake.
4. Evidence records ACTUAL vs cap per run (`writeEvidence` secret-scrub).
5. After EACH test and at session end: `ssh -o BatchMode=yes exe.dev ls --json`
   shows ZERO qds-*/e2e-* boxes; orphaned `sbx-qds-*` keys swept via
   listAllKeys+deleteKey and verified absent (session precedent: 51 revoked).

## Session-known constraints inherited by every T3 test

- Fleet lock: ONE fan-out at a time host-wide; the verb holds
  `.sandbox/fleet.lock` across its ENTIRE run INCLUDING a race poll window —
  schedule an exclusive execution window; stale locks need pid-check + rm.
- Fresh-box pi stalls: one bounded warmup/retry (measured).
- Harvest counts COMMITS on sbx/<runId> — commit verified work pre-harvest or
  harvest reports "none".
- Cold-box B flake measured once on a probe box (first `pi --list-models`
  fetch timeout); B passed 6/6 in real gates. Watch, don't defensive-code.

## Product fixes required BEFORE their tests (small, mutation-first)

### PF-1 (pre: T3.2) — F15 multi-issue bug [CONFIRMED by recon]

`fanout-primitive.ts` F15 block reads ONLY `briefList[0]`: for many-stories
briefs with DIFFERENT issueIds it is wrong twice — (a) OVER-REFUSAL (demands
n×cap headroom on arm 0's issue though arm 0 bills only cap against it) and
(b) UNDER-PROTECTION (arms 1..n-1 issues never checked → budget-exceeded
mid-allSettled after arm 0 provisioned — the exact hazard F15 was built to
kill). Correct shape: group briefList by canonical (repoSlug, issueId);
require Σ(groupCount × cap) headroom PER GROUP; refusal names EVERY group's
override line. RED tests: two-brief/two-issue over-refusal probe + grouped
refusal payload. ~30 LOC in the block + tests. T3.2's P1 probe doubles as the
live proof of the fix.

### PF-2 (with T3.5) — code-phase stdout relayed to stderr and dropped from
the journal value ({exitCode} only, pipeline-run.ts:120-128,:523): return a
bounded stdout tail on the value so step outputs become queryable. Cheap,
unblocks future rank scoring. Fold into T3.5's shim work.

## Tests

### T3.1 — race pattern LIVE (~$0.14–0.22 expected / $0.56 worst)

The only deterministic race-deciding lever on real substrate is MARKER
ARRIVAL TIME (setupGate delay structurally cannot decide it — poller starts
only after ALL arms settle; rosters are provenance labels only).

Flow (full detail in recon/race.md §3):
1. Verb subprocess `fanout --pattern race --n 2 --roster lead,fixer --pin
   <sha> --brief b.json --cap-micro-usd 50000`; cost-config with
   perIssueOverrides = 2×cap; QDS_RUNS_DIR isolated. Harness needs a
   spawn-without-await variant of runFleet.
2. Poll driver.list() until both boxes exist; read local fan-*.json to map
   arm→runId. FAST ARM := ARM 0 (index-order probing makes even a mistimed
   double-marker agree on arm 0).
3. Retry-until-exit-0 (≤3 min hard bound): write `{"ok":true}` to
   `/run/journal/final.json` on arm 0's box — exercises real probe→copyFile→
   parse→first-writer-claim.
4. Poll local record until winner !== null; assert winner === 0; await verb
   exit 0.
5. Best-effort late marker on arm 1 (harmless; lostRace flip is unconditional
   for non-winner ready entrants).

Assert: exactly one "ready" line; N−1 lostRace; ZERO setupFailed/armFailed/
armUnknown; record `{winner:0, closedAt set, rankedAt NULL}` (contrast
best-of-n auto-rank); winner box alive, losers DESTROYED BY THE PRIMITIVE;
loser records closedAt set + spend ∈ (0,cap]; **loser-ledger rows through the
REAL lazy hook** (kind='box_hours' per loser, unpriced=0, priced>0 — the DF2.8
proof unit tests only faked); aggregate ≤ 2×cap; exactly one "won" event, zero
cross-process events. Test finally tears down the WINNER (primitive disposes
losers only). Cheap add-on: `fleet rank` afterwards stamps rankedAt while
winner stays null.

Mitigations (from recon §4): hard-bound marker retries then abort (poller at
ceiling holds the fleet lock 1h with both boxes billing); exclusive window;
fail loudly naming any non-ready arm.

### T3.2 — many-stories LIVE + F15 probes (~$0.33 worst happy path)

Command shape: `fanout --pattern many-stories --n 2 --brief briefs.json`
(NO --roster, NO --pin — both exit-2 refusals are themselves assertions).
Roster still applies PER ARM via each brief's own manifestPath
(dispatch.ts roster-beside rule).

Happy path: BOTH briefs share Quantum-Digital-Solutions/QDS-Factory#46 → override 100,000.
Assert: both arms ready; record pin===null; arms carry distinct briefHashes
(recompute sha256 in-test) and NO rosterId key; per-arm records carry EACH
brief's own commitSha; harvest+teardown both; NO auto-rank/scores line.

Zero-spend negative probes: --roster refused; --pin refused; brief-count≠n
refused; n=1 legal.

- **P1 ($0)** after PF-1: two briefs, DIFFERENT issues A/B, override only
  {"…#A": cap} → expect exit 5 naming repo#A needing 100,000 with available
  50,000 — proves grouped arithmetic (pre-fix this exact probe is the RED).
- **P2 (costed ≤$0.11, optional)**: overrides {A:100k, B:10k} → demonstrates
  grouped protection refusing BEFORE mints instead of mid-flight partial
  fan-out.

### T3.3 — expose/port LIVE (~$0.11 worst)

⚠️ SECURITY (recon-confirmed): successful --port dispatch ends with the WHOLE
BOX world-reachable — `share port` + `share set-public`, derived
https://<vm>.exe.xyz carries NO auth, and THERE IS NO UN-SHARE: teardown's
destroy is the only retraction. Mitigations are mandatory in the docstring:
unguessable runId-named box, serve ONE unguessable static marker line from
tmp, minutes-short ack→teardown window, destroy-in-finally, evidence keeps
identifiers only.

Flow: dispatch --port 8123 → ack httpsUrl === derived form (no port suffix);
record ports===[8123] + verbatim httpsUrl; on-box python3 http.server serving
the marker; HOST curl accepts ANY response carrying the marker (share routing
is [VERIFY]-marked — don't hard-pin 200); teardown → curl FAILS (that failure
is the only retract assertion that exists). Negative variant worth $0: absent
`.sandbox/exedev-posture.json` vmSharing=admins-only → dispatch fails AT
setPublic post-expose (box alive, NOT public) — itself the posture-gate proof.

### T3.4 — orphan reservation expiry + sandbox-reap LIVE (≈$0 model spend)

Two-part, real clock, real kills (full anatomy in recon/reaper.md):

Design A — ledger lazy expiry ($0 model): isolated QDS_RUNS_DIR +
QDS_COST_LEDGER_FILE; watcher polls gate_admissions (WAL readers see commits)
and SIGKILLs the dispatcher between admission-commit and store.create
(milliseconds wide — LOOP attempts until row-present ∧ record-absent; report
window width as a finding if unwinnable after N tries; NEVER hand-insert db
rows). Negative control BEFORE 6 min: fresh ids same issue ⇒ young+ENOENT
still reserves. Wait ≥360 s (ADMISSION_GRACE_MS 60s + SKEW_MARGIN 300s).
Dispatch #2 ⇒ admitted:true with reservedMicroUsd EXCLUDING the orphan
ceiling while issueBudgetSnapshot still includes it (lazy-only contrast).
Clean-ENOENT expiry is silent-by-design — numbers are the pass.

Design B — active reaper: kill landing after store.create leaves OPEN record
(+box+key); quota-limits JSON with staleAfterMs=60_000 via
QDS_QUOTA_LIMITS_FILE (real knob) pointed ONLY at scratch dir; wait; `bun
scripts/sandbox-reap.ts --driver exedev --yes` ⇒ stale-record→teardown rows,
exit 0; ledger side confirms teardown's priced box_hours retires the
reservation. Final sweep clean.

Safety notes: SIGKILL strands NO fleet lock (plain dispatch holds neither
lock); WAL recovery discards uncommitted frames (worst case no row — retry);
never SIGKILL during sandbox-reap --yes itself.
FINDING to log regardless: `reapRuns` (driver.ts:1201-1282) has ZERO
production callers — dead code contradicting its own docstring; the ACTIVE
reaper is scripts/sandbox-reap.ts. Planning should delete or wire it (story
amendment candidate).

### T3.5 — manifest phases executing ON THE BOX (small-shim) (~$0.11 worst)

Recon verdict: the chain is MISSING, not hidden — `scripts/pipeline-run.ts`
has ZERO production invocations (tests only); nothing invokes it post-dispatch
(dispatch ends at stamp+ack, dispatch.ts:2657-2698); the box image has NO
bun/node (measured exit 127, TIER-1 F1); the executor binary is never
delivered (fill ships pipeline.yaml + run-context.json only). The unused
`QDS_TEAM_RUNNER=local` env line awaits a consumer that never shipped.

T3 scope = shim path (A): `scripts/pipeline-run-remote.ts` (~150-250 LOC
host-side) — fetch the DELIVERED stamped manifest off-box (proves the stamp
rode out), drive Run/walkPhases with a body factory whose `code` bodies exec
`sh -c <cmd>` ON THE BOX in $HOME/src via driver.exec, FileJournal to records
dir, QDS_RUN_ROOT marker, witness reconciliation unchanged. Add a third
manifest phase writing+committing a tracked marker file. Include PF-2 (stdout
tail on phase values). Assert: journal rows ordered+settled ok + terminal
marker under QDS_RUN_ROOT/<runId>; harvest bundle carries the marker file
(git show refs/sandbox/<runId>:…); effectiveCeilingMicros ==
limitMicroUsd; spend ≤ cap; teardown/box-gone/key-revoked. Honest label:
phases execute ON THE BOX orchestrated FROM THE HOST — all production paths,
no fake substrate.

**STORY PROPOSAL for planning (not T3 scope):** the real product promise is
an IN-BOX executor — `bun build --compile` single binary delivered at fill,
exec'd with `. $HOME/app/.env`, journal+marker under /run, harvest extended
to pull /run artifacts (closes gap G5: harvest probes repo-relative trace.db
while tracer writes /run/trace), plus the dispatch_task-in-box decision
(buildTeamSpawn hardcodes bun). Name suggestion: DF1.10 "In-Box Manifest
Executor" or amend DF1.6. Until that story lands, DF6.1's briefing (already
written) correctly tells dev to drive pi directly.

## Execution order & approval gates

| Order | Run | Worst µ$ | Gate |
|---|---|---|---|
| 0 | PF-1 fix + focal RED→GREEN (host-side, $0) | 0 | — |
| 1 | T3.2 happy + negatives + P1 ($0 probes first) | 330,000 | halt → GO |
| 2 | T3.1 race | 560,000 | halt → GO |
| 3 | T3.5 shim build ($0) then live | 110,000 | halt → GO |
| 4 | T3.3 expose (posture-negative $0 first) | 110,000 | halt → GO |
| 5 | T3.4 reaper A+B | ≈ cents | halt → GO |
| 6 | P2 optional (post-PF-1 live proof) | 110,000 | halt → GO |

Session worst-case envelope if everything runs: ≈ **$1.22**; realistic ≈
**$0.50–0.70**. Each gate prints keys×cap + boxes×hours + totals and halts.

## Deliverables per test

Committed live test + evidence JSON (actual-vs-cap spend) + run-report §T3
verdict matrix + story Dev Agent Record entries + leak sweep transcript.
detect_changes scoped before every commit; biome/tsc/bun gates green.

## Open questions carried to operator/planning

1. Steps-producer ownership → briefed INTO df6-1 story (2026-08-25 section);
   rank scoring stays decorative until DF6.1 emits step outputs.
2. tokensRows gap (`ingestCostEvent` zero callers) → product wiring decision;
   observability must budget off spendMicroUsd until wired.
3. In-box executor story (T3.5 proposal B) → planning to name/scope.
4. Dead `reapRuns` → delete-or-wire amendment.
