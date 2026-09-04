# T3 LIVE-PROOF HANDOFF — SESSION 4 (fresh context; trust nothing, verify everything)

MISSION: finish the T3 live-proof audit per
_bmad-output/workflow-state/code-review/e2e-audit/t3-test-plan.md.
Remaining: land the T3.4 product fix + uncommitted test, decide T3.4a, then the
final §T3 report. Standing operator policy: enterprise grade rigor, no
shortcuts/bandaids/assumptions; product-real fixes at root cause; if the TEST
design was wrong, fix the test and say so; EVERY live run needs a fresh GO
after printing keys×cap + boxes×est-hours + worst µ$ and $.

## Repo/branch state (2026-08-26 ~16:05 EDT)

- Repo /Users/steve/QDS-Factory. Work ONLY on feature/df3-2-fanout-best-of-n
  (PR #128). OTHER AGENTS WORK THIS TREE CONCURRENTLY — `git branch
  --show-current` at start; NEVER stage unrelated dirt; commit only files you
  touched. Last push: 7e47279.
- Commits this session (all pushed, tree clean of my work at handoff):
  - fc21f8b fix(df3-2): PF-3 — race poller reads marker via exec cat
  - 6c1064a test(df3-2): T3.1 race live test reads gate outcomes
  - 889e4c1 fix(df3-2): T3.5 remote-phase shim — HOME resolution, argv re-quoting, manifest budget
  - 7e47279 test(df3-2): T3.3 expose/port live — assert the SERVED marker
  - 2b94456 fix(df3-2): T3.4b — reaper teardown prices box_hours (costLedger
    wiring) + reaper live test (PRODUCT FIX + tier3-reaper.live.test.ts;
    reaper.test.ts 32/32, impact LOW, detect_changes scope-verified before
    commit)
- Substrate clean at handoff: 0 boxes, 0 orphan qds-* keys (verified).
- `cd` PERSISTS between Bash calls in the harness — TWO runs were wasted
  launching from a scratch dir. Always `cd /Users/steve/QDS-Factory` (or use
  absolute paths) before launching anything.

## DONE this session — do NOT redo (evidence in _bmad-output/evidence/df3-e2e/)

1. PF-3 LANDED (fc21f8b): probeArm reads the marker via exec `cat` on the
   same channel as `test -f` (ExeDevDriver.copyFile is box-relative and
   refused the absolute /run path — race undecidable pre-fix). Unit seam:
   RaceFakeDriver answers cat in-memory; ONLY the presence probe counts/
   fires onProbe (counting cat too shifted every probe-number dance +1 and
   let same-tick plants overwrite the marker). 4 race tests bumped to 20s
   (10s ceilings / real git teardowns vs bun's 5s default).
2. T3.1 race COMPLETE-GREEN att7 (evidence 2026-08-26-154346): both gates
   ready, marker planted on lowest-index gate-READY arm, winner 0 claimed on
   real substrate, loser destroyed BY THE PRIMITIVE, DF2.8 lazy ledger row
   priced 3716 µ$ unpriced=0, spend 73 µ$ ≤ 100k, rank stamped, 0 boxes/keys
   after. att6 root cause (see findings) was the gate-B pi-registry flake —
   the test now reads .sandbox/setup-gate/<runId>.json and branches:
   full-field = whole surface; single-entrant = sole-entrant claim + INV-5
   (failed arm box AND key alive); both-failed = named substrate flake.
3. T3.5 remote-phases COMPLETE-GREEN run9 (evidence 2026-08-26-182443):
   3 phases exec'd on-box (echo/true/git-commit marker), all exit 0, PF-2
   stdout tails in steps.json, journal = one pretty-printed JSON object in a
   ".jsonl"-named file (engine convention — parse the WHOLE body), money
   identity delivered==witness==record==50000 µ$, harvest bundle carries
   t3_phase_marker.txt via refs/sandbox/<runId>, teardown clean. Fixed on the
   way: manifest runBudgetMs 60000→150000 (requiredBudgetMs = Σ(retries+1)×
   (PARSE_FIX_ATTEMPTS+1)×maxDuration + phases×ROUTING_MARGIN = 135000);
   shim shellQuote'd literal "$HOME" (resolved once via boxHome now); shim
   cmd.join(" ") flattened argv (now per-element shellQuote — reproduced live
   on a debug box: dash "printf: usage" exit 2, empty marker file); test
   spawns the shim DIRECTLY (runFleet routes argv[0] through fleet.ts →
   unknown-verb usage exit 2); --budget-ms must be ≥ manifest runBudgetMs.
4. T3.3 expose/port COMPLETE-GREEN run5 (evidence 2026-08-26-185732):
   negative = posture file absent → dispatch exit 1 posture-attestation-missing,
   port claim retained, box alive, anonymous URL serves exe.dev LOGIN
   REDIRECT that ECHOES the requested path (assert served-body prefix
   `t3-expose <token>` absence — NEVER curl exit code); positive = served the
   unguessable marker anonymously, teardown → 307 auth page (same
   body-absence assert), 0 boxes/keys after. Positive leg retries ONCE on
   exit 3 (gate-B flake) with teardown+destroy; finally sweeps leftover
   qds-*/e2e-* boxes with revokeQuietly.
5. T3.4b sandbox-reap COMPLETE-GREEN run4 (evidence 2026-08-26-193343):
   stale OPEN record → reap --yes → teardown → box_hours row PRICED 8170 µ$
   unpriced=0, box destroyed, key revoked, exit 0. This PROVED the product
   fix above (pre-fix: teardown 1 but ZERO cost_events rows).
6. T3.4a — NOT green. See IN FLIGHT.

## IN FLIGHT — T3.4a (orphan reservation lazy expiry). DECIDE, then finish.

Design: SIGKILL a real dispatch in the window between the ledger admission
COMMIT and run-record create; then (1) young-control refusal, (2) after
360s+grace lazy expiry a fresh dispatch on the SAME issue admits.

MEASURED (runs 1-6, evidence 2026-08-26-19*"-t3-4a-orphan-expiry.json"):
- The window is ~1-3 ms on this host: run-record.create fires ~1 ms after the
  admission row (durationMs 0-2, timestamps adjacent). A 5 ms poll caught it
  ONCE in 13 attempts (run2); run6 went 6/6 kill-too-late in 32 s.
- Fixes already in the test: ledgerTry (tolerates schema-init window +
  SQLITE_CANTOPEN), scratch ledger at join(runsDir,"cost-ledger.db") — the
  REAL contract (db INSIDE records dir, cost-config.json its SIBLING, no
  QDS_COST_* env overrides), cleanup teardowns run with the same env,
  issue #48 ceiling 3×CAP (150k) because retirement prices each too-late
  attempt's REAL box lifetime against the issue FOREVER (fake-driver proof:
  run1 priced 231 µ$, run2 admission ceiling 49769), keep-workspace-on-fail.
- NEXT MOVES (pick with operator):
  a) Tighten the catch: busy-loop poll with ONE persistent readonly WAL
     connection (no per-poll open), proc.kill() on first row sight, raise
     attempts to 10-12. Cumulative odds still luck-based.
  b) If (a) still can't land in ≤2 runs: RECLASSIFY as a finding — the
     orphan window is ~1 ms wide on production-speed hosts, i.e. practically
     unlandable; the lazy-expiry code path is then proven by unit tests only
     and T3.4a documents the window width as the deliverable (the test's own
     comment already says "unwinnable window = REPORT the width, don't fake
     it"). DO NOT hand-insert rows or slow product code — that forfeits
     production-path standing.
- Fake-driver retirement chain verified end-to-end in /tmp (workspace
  deleted): dispatch→teardown→dispatch ADMITS (retirement works when
  teardown prices). Fake-driver gotchas for local repro: fleet verbs need
  `</dev/null` stdin (else "brief redirected onto stdin" exit 2), repoUrl
  must be the real allowlisted github URL, run from REPO_ROOT so manifestPath
  resolves beneath repoRoot.

## Gate-B pi-registry flake ledger (for the findings/report)

Fresh-box `pi --list-models` can still be initializing at gate time: "No
models available. Use /login" while a sibling box created 2 s apart passes
A–E. Fail-closed by design (DF2.2) → setupFailed exit 3, box ALIVE (INV-5).
Occurrences: T3.2 12:41 ×2 (previously "unexplained"), T3.1 att6 (arm 0),
T3.3 run3. ~4/16 gates ≈ 25% per-attempt on 2-arm runs. Substrate-level
(box image/pi init) — NOT our code. Possible product hardening (PLANNING
decision, not audit scope): a bounded wait/retry for B only (B itself spends
nothing).

## Run env + traps (hard-won this session)

- QDS_E2E_LIVE=1 QDS_E2E_TIER=2 QDS_EXEDEV_REPO_URL=https://github.com/biospark33/QDS-Factory.git
  QDS_EXEDEV_SHA=$(git rev-parse HEAD AFTER push) QDS_EXEDEV_ROSTER=$PWD/config/rosters/df16-e2e.roster.yaml
  OPENROUTER_PROVISIONING_KEY from .env (SECRET — never print).
- Launch LONG tests nohup … > /tmp/x.log 2>&1 & then poll. macOS has no GNU
  timeout. exe.dev skill: .claude/skills/using-exe-dev (ssh exe.dev lobby;
  <vm>.exe.xyz direct). Repo is PRIVATE → in-box https clone fails; fill is
  host-cred bundle-push (F4).
- runFleet = `bun scripts/fleet.ts <argv>` (fleet VERBS only); scripts/*.ts
  shims need direct Bun.spawn. dispatch takes NO --cap-micro-usd (fanout
  only); dispatch cap = config defaultCapMicroUsd.
- Post-test + post-session sweep: `ssh -o BatchMode=yes exe.dev ls --json` →
  zero qds-*/e2e-*; orphan keys via bun -e openRouterKeyApi().listAllKeys(5)
  filter /qds-20260826/ then deleteKey (precedent: sbx-qds-20260826-d9052a
  revoked 16:05). T3.4a kill-window orphans can be NAMELESS — the test's
  finally now sweeps-destroys every leftover qds-* box.
- Stale .sandbox/fleet.lock → verify holder pid dead → rm. exe.dev billing:
  `ssh exe.dev billing plan --json` (lapse precedent at 12:03 this week).

## Deliverables (final, after T3.4a decision)

§T3 in _bmad-output/workflow-state/code-review/e2e-audit/e2e-run-report.md:
verdict matrix PROVEN/BROKEN per T3.1-T3.5 + verbatim failures, spend table
actual-vs-cap per test incl. EVERY attempt, coverage delta, findings ledger.
Findings list (compiled, ready to paste):
1. PF-3 copyFile-vs-marker-path (FIXED fc21f8b).
2. /run marker write needs sudo-capable writer (root:root, uid 1000) — in-box
   executor story input.
3. Gate-B fresh-box pi-registry init race (substrate; see ledger above).
4. Reaper teardown never priced box_hours — SweepDeps.costLedger was missing
   (FIXED this session, PROVEN live 8170 µ$; commit pending).
5. reapRuns dead code (driver.ts:1201-1282, zero production callers).
6. briefHash = sha256 of Zod-PARSED brief in SCHEMA key order.
7. exe.dev proxy semantics: private VM answers anonymous with login redirect
   ECHOING the path; destroyed VM hostname still 307s — assert served-body,
   never curl exit codes.
8. Ledger retirement semantics: priced spend consumes issue headroom forever
   (reservation retires, money doesn't come back).
9. T3.4a window width ~1-3 ms (pending final decision above).
Story Dev Agent Record entries (df3-2 story) for live-discharged DOD;
sprint-status dated note; commit+push; PR #128 comment ONLY with operator
approval in-session. PF-3 + reaper costLedger are PR-visible PRODUCT changes
— call out.

## Spend ledger (µ$, from evidence; reconcile in the report)

- Prior sessions (handoff est): T3.2 arc ≈25-35k; T3.1 att1-5 ≈150-200k;
  probes/diag ≈10-15k.
- This session: T3.1 att6 ≈80-90k (2 boxes 10.5 min), att7 ≈15k (73 µ$ tokens
  + 3716 box + fractional); T3.5 r1 $0 + r2-r7 ≈5k each + debug box ≈12k +
  r9 ≈5k ≈42k; T3.3 r1 ≈5k, r2 ≈5k, r3 ≈8k (leak cleaned), r4 ≈10k, r5
  (142 s, 2 dispatches) ≈12k ≈40k; T3.4 r1-r3 ≈25k (full dispatch legs +
  attempts), r4 ≈12k (4b full + 4a attempts), r5 $0 (usage refusals), r6
  ≈8k (6 kill attempts + teardowns).
- Session total ≈ 220-270k µ$; mission total ≈ 405-500k µ$ (~$0.50). Caps
  never approached 100k per-test aggregate.
