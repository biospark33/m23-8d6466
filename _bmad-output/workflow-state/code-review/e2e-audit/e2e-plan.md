# DF3 Fleet Live E2E Plan — TIER-1 (real substrate, zero model spend) + TIER-2 (live fire)

Date: 2026-08-24. Companion to e2e-coverage.md (same dir). Approved by operator (matrix read).

## Goal

Discharge the never-proven real paths (e2e-coverage.md "Untested Real Paths" 1-12) with live tests that bind to real observable state. Outcome = per-test PROVEN/BROKEN verdict + redacted evidence artifacts, so a follow-up session can fix what's broken.

## Branch & placement

- Branch: `feature/df3-2-fanout-best-of-n` (work extends DF3.2's proof; fanout/rank verbs only exist on this branch — PR #128 open). Do NOT branch off main (missing DF3.2 code).
- Tests: `tests/fleet/e2e/` named `*.live.test.ts` + shared helper `tests/fleet/e2e/live-harness.ts`.
- Evidence out: `_bmad-output/evidence/df3-e2e/` (one JSON per test run, redacted).
- Repo dirt warning: working tree has unrelated modified/untracked files (cli-anything/, skills, artifacts/). Never stage them.

## Gating (copy the proven pattern)

Follow `tests/providers/exedev/setup-gate.test.ts:538` + `tests/providers/cap-hit-demo.test.ts:978`:

- `test.todoIf(!process.env.QDS_E2E_LIVE)` on every live test.
- Master env: `QDS_E2E_LIVE=1`, tier: `QDS_E2E_TIER=1|2`.
- Substrate env (reuse DF2.2 contract): `QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`, `OPENROUTER_PROVISIONING_KEY` (SECRET — never print/echo/log its value; presence-check only).
- Guard clause in each test: if tier-relevant env is half-configured, THROW "refusing to run a hollow live-fire" (never silently skip-and-pass).
- Normal `bun test` / CI: tests are todo, zero cost, zero creds.

## Helper contract (live-harness.ts)

1. `preflight()` — `new ExeDevDriver().whoami()`; fail fast with the exact operator remediation string if ssh/exe.dev unreachable. Presence-check (not value-print) all env vars; return `{ repoUrl, sha, rosterPath, evidenceDir }`.
2. `mintCappedKey(capMicroUsd)` — real OpenRouter mint via credentials.ts path, LOW cap; returns keyHash only (plaintext stays in memory, delivered to box via existing lifecycle, never logged).
3. `writeEvidence(name, payload)` — JSON to `_bmad-output/evidence/df3-e2e/<date>-<name>.json`; scrub pass: assert no `sk-or-`, no `OPENROUTER_PROVISIONING_KEY` value, no plaintext key; boxIds/runIds/costs/keyHash allowed.
4. `ledgerRows(dir)` — readonly `new Database(cost-ledger.db, {readonly:true})` read helper (pattern exists: cli.test.ts:2586-2735).
5. `runFleet([...argv])` — Bun.spawn `bun scripts/fleet.ts <verb> ...` returning exit code + stdout/stderr (real CLI subprocess, no in-process shortcuts).

Hard rule: NO fakes in `*.live.test.ts`. A FakeDriver/FakeKeyApi/RecordingLedger import there is a bug. Assertions bind to: vm present/absent in `driver.list()` output, CLI exit codes, real SQLite rows, host-side `git bundle verify` success, keyApi list showing key revoked.

## TIER-1 — real exe.dev boxes, real key API, zero model spend

Workload = shell no-ops (`node --version`, `uname -a`, `git --version`). Keys minted with tiny caps and NEVER used for model calls → $0 model spend. Box-hours are the only cost.

| # | Test | Covers paths | Core assertions |
|---|---|---|---|
| T1.1 | `tier1-driver-lifecycle.live.test.ts` | (1) driver SSH paths | whoami non-empty; create → vm in `list()`; exec `node --version` exit 0 + real stdout; copyFile box→host content matches; destroy → vm ABSENT from list(); evidence JSON has vm name + timestamps |
| T1.2 | `tier1-dispatch-status.live.test.ts` | (2)(7)(8) dispatch+status verbs | `scripts/fleet.ts dispatch --driver exedev` (brief with no-op workload — see OQ-1) exit 0; run record on disk; vm in list; `status` exit 0 + run state; SQLite ledger row exists (admit) |
| T1.3 | `tier1-harvest.live.test.ts` | (9) + real in-box git | exec in box: `git init/commit/bundle create`; `harvest` verb exit 0; bundle on host; host `git bundle verify` exit 0 |
| T1.4 | `tier1-teardown.live.test.ts` | (5)(10) full teardown chain | mint capped key (real POST, cap ≤ 5000 µ$, unused); `teardown` verb exit 0; keyHash ABSENT from `listAllKeys()` (revoked+verified); vm ABSENT from list; real SQLite ledger row updated/closed; second teardown idempotent-or-refused per verb contract |
| T1.5 | `tier1-fanout-rank.live.test.ts` | (11)(12) DF3.2 fanout N=2 no-op arms | `fanout` verb (or fanout API) with N=2 real boxes, no-op arms; both arms' vms created; winner + loser teardown → loser vm ABSENT, winner harvested; `rank` verb over resulting records exit 0 with real scores; FanoutRecord JSON has both runIds |
| T1.6 | `tier1-lock.live.test.ts` | (7) concurrency on real substrate | two concurrent `dispatch` invocations same runs dir → exactly one succeeds, other refused with lock diagnostic (host-real already, now with real driver in path) |

Every T1 test: `finally`-teardown discipline (destroy box even on failure), evidence written PASS or FAIL, failures reported verbatim (assertion diff + stderr) — no catch-and-pass.

## TIER-2 — full live fire, real model spend (EXPLICIT per-run approval)

| # | Test | Covers | Notes |
|---|---|---|---|
| T2.1 | `tier2-dispatch-engine.live.test.ts` | (3)(4) + real model calls | Real pi-team run in box (roster: reuse DF1.6 pattern — lead claude-haiku-4.5, fixer deepseek-v3.2 free/low-tier slugs via `config/rosters/`); capped key; one seeded-fix scenario (df1-6 pattern); assert changed files + real cost events > 0 µ$; harvest + teardown complete the loop |
| T2.2 | `tier2-fanout-bestofn.live.test.ts` | (11)(12) with real model arms | N=2 real model arms, best-of-N selection on real outputs, rank over real costs |

Budget protocol (NON-NEGOTIABLE):
- Before ANY tier-2 run: print estimate = keys × capMicroUsd + boxes × estimated hours; state hard cap (default `capMicroUsd=50000` per key = $0.05 worst case, boxHour ≤ 1h per box).
- HALT for operator "go" with the number stated. No approval → no run.
- TIER-2 tests additionally refuse if `QDS_E2E_TIER !== "2"`.
- Evidence records actual spend (spendMicroUsd from key entry before revoke) vs cap.

## Implementation order

1. Recon (inline, cheap): read `scripts/fleet.ts` verb flag grammar + `src/fleet/brief-schema.ts` workload fields → resolve OQ-1/OQ-2 below; read `tests/providers/cap-hit-demo.test.ts` live-test structure for the subprocess-spawn pattern.
2. `live-harness.ts` + T1.1 (proves driver substrate + harness). Run live. Fix harness-only issues.
3. T1.2-T1.6 sequentially, run each live as built. Product bugs on real paths: capture verbatim in findings report + GitHub-issue-ready note; do NOT hack around, do NOT fake. Only fix forward when root cause is small and obvious (with gitnexus `impact()` first per repo rules).
4. Gates: `bun test tests/fleet/ tests/providers/` (all green incl. 508 focal), new e2e skipped-by-default verified (runs as todo), `bunx biome check`, `bunx tsc --noEmit`, gitnexus `detect_changes()` (scope must stay in fleet/e2e + evidence).
5. Commit (own files only) on `feature/df3-2-fanout-best-of-n`, push.
6. TIER-2 with per-run approval; evidence + spend recorded.
7. Final deliverable: `_bmad-output/workflow-state/code-review/e2e-audit/e2e-run-report.md` — per test PROVEN/BROKEN, verbatim failures, bugs list (what's working / what's not), evidence links. Update both story Dev Agent Records + sprint-status.yaml only for DOD items actually discharged.

## Open questions (resolve in recon step 1, before writing tests)

- OQ-1: Does the dispatch brief schema support a no-op workload (explicit command / skip-engine), or does dispatch always imply fill+setup+engine? If always-engine: T1.2/T1.5 use `createRun`-level API with no-op exec instead of the full verb, and the verb-level no-op assertion moves to T2.1. Decide from brief-schema.ts, don't guess.
- OQ-2: Does setup gate assertion D (live pings) cost model money? If yes, TIER-1 skips the gate step (driver-level fill only) and the gate runs only in T2.1 where spend is approved. Check setup-gate.ts:206-533 for what D actually pings.
- OQ-3: exe.dev box pricing model (box-hours billed?) — reflect in TIER-1 estimate line; operator confirms once.

## Hard rules (carried from mission)

- No mocking to green in `*.live.test.ts`; a fake there is a bug.
- Never print/leak `OPENROUTER_PROVISIONING_KEY` or key plaintexts — logs, evidence, PR comments.
- Report failures verbatim; if exe.dev or model provider unavailable → report + halt, never silently substitute fakes.
- Spend amount + cap stated BEFORE any costing run.
- Repo rules: gitnexus `impact()` before any symbol edit; `detect_changes()` before commit; reindex only via `bash scripts/install-gitnexus-plus.sh`.
