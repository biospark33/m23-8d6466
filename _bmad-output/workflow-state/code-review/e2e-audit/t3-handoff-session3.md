# T3 LIVE-PROOF HANDOFF — SESSION 3 (fresh context; trust nothing, verify everything)

MISSION: Execute the T3 live-proof audit per
_bmad-output/workflow-state/code-review/e2e-audit/t3-test-plan.md — no new
features; prove shipped code on real substrate. Order: PF-3 stabilize+commit →
T3.1 att6 → T3.5 → T3.3 → T3.4 (+optional P2) → final §T3 report.
"Enterprise grade rigor, no shortcuts or bandaids" is standing operator
policy: product-real fixes at root cause; if the TEST design was wrong, fix
the test and say so.

## Repo/branch state (2026-08-26 ~10:45 EDT)

- Repo /Users/steve/QDS-Factory. Work ONLY on feature/df3-2-fanout-best-of-n
  (PR #128). Last push: e586da2. OTHER AGENTS WORK THIS TREE CONCURRENTLY —
  `git branch --show-current` at start; NEVER stage unrelated dirt; commit
  only files you touched. `git fetch origin && git log --oneline
  HEAD..origin/main` — merge if main moved.
- UNCOMMITTED working-tree changes that are MINE and must land (verify with
  `git status; git diff` before building on them):
  - src/fleet/fanout-primitive.ts — PF-3 fix (probeArm reads marker via
    exec `cat`, not copyFile; removed tmp/rmQuiet + unused imports)
  - tests/fleet/patterns.test.ts — PF-3 regression test (strict-copyFile
    fake), RaceFakeDriver exec seam rework (in-memory cat answer, real
    test -f), timeout bumps 20_000 on K8/planted-marker/one-loser tests
  - tests/fleet/e2e/tier3-race.live.test.ts — diagnostic winner-poll
    (marker probe + arm-record snapshots every ~30s + verb-stderr capture
    on timeout); sudo marker write
  - tests/fleet/e2e/tier3-expose-port.live.test.ts — NEW, gates green, never run live
  - tests/fleet/e2e/tier3-reaper.live.test.ts — NEW, gates green, never run live

## DONE this arc (do NOT redo; evidence in _bmad-output/evidence/df3-e2e/)

- PF-1/F15b (commit b8da988): grouped per-issue headroom; 3 RED→GREEN unit
  tests; live P1 probe GREEN (2-brief/2-issue exit-5 naming #46 need 100k).
- T3.2 many-stories COMPLETE-GREEN: probes 16 asserts (roster-forbidden,
  pin-mismatch, brief-count, n=1); happy path 52 asserts
  (evidence 2026-08-26-131544-t3-2-manystories.json): both arms ready,
  distinct briefHashes (NOTE: briefHash = sha256 of Zod-PARSED brief in
  SCHEMA key order — write brief literals in schema order), pin null, no
  rosterId, no auto-rank, harvest+teardown both, spend 146 µ$ tokens +
  14,279 µ$ box-hours ≤ 100k cap. (5 attempts: stale-lock fleet-busy;
  exe.dev billing lapse; unexplained setupFailed×2 @157s — log as residual;
  briefHash key-order test bug; green.)
- T3 kit (commit e586da2): PF-2 stdout tails in pipeline-run.ts (4 KiB,
  focal 33/33); scripts/pipeline-run-remote.ts shim (~190 LOC: fetch
  delivered manifest+witness off-box → production loadManifest+runContextFrom
  → phases exec ON BOX via driver.exec → journal/marker/steps.json host-side
  under <recordsDir>/<runId>/); config/rosters/t3.pipeline.json (3 code
  phases: echo/true/marker-commit); tier3-race + tier3-remote-phases live
  tests; spawnFleet harness variant.
- exe.dev event: plan lapsed ~12:03 EDT ("Choose a plan" on `new`) —
  operator resubscribed ~12:30 (Individual, active, 50 VMs). If `new` fails
  again: `ssh exe.dev billing plan --json`.

## IN FLIGHT — PF-3 (product bug, root-caused LIVE, fix written, unit seam mid-stabilize)

MEASURED 2026-08-26 (fan-20260826-f04c3c + 2 earlier attempts, evidence
2026-08-26-142851-t3-1-fanout-race.json): race poller probeArm called
driver.copyFile(vm, "/run/journal/final.json") — ExeDevDriver.assertBoxPathSafe
REFUSES absolute paths ("remote-path-invalid") → every read tick failed →
race spun to ceiling with marker present+readable 10 min (diagnostics in
evidence: markerProbe {"ok":true} every 30s, both arms acked). FakeDriver's
permissive copyFile hid it in unit tests.

Fix (in tree, unit-PF-3-test went RED→GREEN): probeArm execs
`cat <shellQuoted markerPath>` — same channel as its presence `test -f`; no
driver path-safety surface changed.

CURRENT BLOCKER (finish FIRST): full-suite patterns.test.ts run has 7 fails
— load/timeout family under concurrent-agent CPU contention (5s bun default;
several race tests + K8 were bumped to 20_000; "corruption counting
CONSECUTIVE" and "ok:false marker" tests failed an ASSERT at least once —
verify whether real regression or load; the in-memory cat seam in
RaceFakeDriver is the suspect area: `cat` answered from readFileSync,
`test -f` stays a real spawn). Sequence: (1) run `bun test
tests/fleet/patterns.test.ts` twice; (2) any repeat assert-fail → debug solo
with -t; (3) get 0 fail twice; (4) biome+tsc; (5) detect_changes; (6) commit
PF-3 (fanout-primitive.ts + patterns.test.ts + tier3-race diag edits) and
PUSH. Then T3.1 live att6.

## Live runs remaining (each: fresh GO after printing keys×cap + boxes×est-hours + worst µ$ and $)

1. T3.1 race att6 — worst 560k µ$ (2 keys×50k + 2 boxes ≤1h@230k). GO was
   granted for att1–5 this session; envelope consumed so far ≈ 4 failed
   attempts × (2 arms gate-chat ~150-300 µ$ tokens + 2 boxes × ~5-11 min ≈
   20-45k µ$ box-hours each) — estimate ≈ 150-200k µ$ total. ASK FRESH.
   Test is ready (diag version). With PF-3 landed it should claim winner=0.
   Traps: exclusive fleet-lock window (verb holds it the WHOLE run incl.
   poll); stale .sandbox/fleet.lock → verify holder pid dead → rm; marker
   write NEEDS `sudo -n` (/run is root:root, exedev uid 1000, passwordless
   sudo measured); verb subprocess holds lock 1h at ceiling if marker
   unreadable — the test's 600s bound + kill covers it.
2. T3.5 remote phases — worst 280k µ$ (1 key + 1 box ≤1h; plan est $0.11).
   Test tier3-remote-phases.live.test.ts ready; run AFTER T3.1's lock frees.
   Asserts: journal rows ordered ok, steps.json PF-2 tails, terminal marker,
   money identity (delivered stamp == witness == record limit), harvest
   bundle carries t3_phase_marker.txt via `git show refs/sandbox/<runId>:…`,
   spend ≤ cap, teardown clean.
3. T3.3 expose/port — worst ≈ 560k µ$ for its TWO dispatches (plan said
   ~110k for one; my test does negative posture + positive = 2 boxes+2 keys,
   short-lived). Test ready incl. mandatory security mitigations (docstring).
   NOTE: test writes .sandbox/exedev-posture.json
   {"vmSharing":"admins-only"} for the positive leg and RESTORES/removes it
   in finally — if it dies mid-run, clean the file by hand.
4. T3.4 reaper A+B — ≈ cents. Test ready (tier3-reaper.live.test.ts):
   A = SIGKILL-in-window loop + young-refusal control + 6-min lazy expiry
   ($0); B = staleAfterMs=60_000 via QDS_QUOTA_LIMITS_FILE + sandbox-reap
   --yes. Log the reapRuns dead-code finding (driver.ts:1201-1282, ZERO
   production callers — active reaper is scripts/sandbox-reap.ts).
5. P2 optional (costed ≤110k): grouped under-protection live demo.

## Run env (per live test)

QDS_E2E_LIVE=1 QDS_E2E_TIER=2 QDS_EXEDEV_REPO_URL=https://github.com/biospark33/QDS-Factory.git
QDS_EXEDEV_SHA=$(git rev-parse HEAD AFTER push — NEVER typed/partial)
QDS_EXEDEV_ROSTER=$PWD/config/rosters/df16-e2e.roster.yaml
OPENROUTER_PROVISIONING_KEY sourced from .env (SECRET — never print).
Launch LONG tests with nohup … > /tmp/x.log 2>&1 & (a session restart KILLED
att2 mid-run once and leaked 2 boxes + 2 keys — recovered via ssh rm +
listAllKeys/deleteKey by name).

## After EACH test + at session end

`ssh -o BatchMode=yes exe.dev ls --json` → ZERO qds-*/e2e-* boxes (names at
vms[].dns_name minus .exe.xyz); sweep orphan keys via openRouterKeyApi
listAllKeys+deleteKey matching runId in key name (precedent this arc: 2
revoked). Orphan-key check snippet is in this session's transcript; pattern:
bun -e with src/providers/credentials.ts openRouterKeyApi().

## Deliverables (final)

§T3 in _bmad-output/workflow-state/code-review/e2e-audit/e2e-run-report.md
(verdict matrix PROVEN/BROKEN + verbatim failures, spend table actual-vs-cap
per test incl. ALL T3.1 attempts, coverage delta, findings ledger: PF-3
copyFile-vs-marker-path, /run root-owned marker write needs privileged
writer (in-box executor story input), reapRuns dead code, unexplained
12:41 setupFailed×2, briefHash schema-order contract). Story Dev Agent
Record entries (df3-2 story) for live-discharged DOD; sprint-status dated
note; commit+push; PR #128 comment ONLY with operator approval in-session.
Final message: verdict matrix, total session spend µ$+$, remaining gaps,
demo-ready verdict. PF-1/PF-3/PF-2 are PR-visible product changes — call out.

## Session spend so far (from evidence; reconcile at end)

- T3.2 arc: 5 attempts ≈ 25-35k µ$ total (146 µ$ tokens + 14.3k box-hours on
  final green; failed attempts mostly fractional boxes).
- T3.1 att1-5: ≈ 150-200k µ$ (5× two fractional boxes + gate chat; evidence
  files 132906/135739/141226/142851 + killed att2 unrecoverable — estimate).
- Probes/diag (perms probe box, diag dispatch): ≈ 10-15k µ$.
