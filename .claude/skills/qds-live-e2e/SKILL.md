---
name: qds-live-e2e
description: Run live (no-fakes) end-to-end E2E testing rounds for QDS-Factory fleet/phase-engine code against real exe.dev boxes and real OpenRouter spend. Use this skill whenever the user mentions e2e, end-to-end, live testing, live-fire, "no mocks/stubs/fakes", TIER-1/TIER-2/TIER-3/TIER-4 tests, QDS_E2E_LIVE, running the live suite, pre-merge verification rounds, or asks "test it live" / "another rigorous round" / "prove it on the real substrate" in this repository — even if they don't name a tier.
---

# QDS Live E2E Rounds

The repo's `bun test` suites run on fakes by design (FakeDriver, FakeKeyApi, fake pi
fixtures). Live rounds prove the real substrate: real `ssh exe.dev` boxes, real
OpenRouter keys with µ$ caps, real model calls. This skill is the operating procedure
distilled from the 2026-08-24/25/26 rounds and the 2026-08-28 TIER-4 round.

## Hard rules

1. **No fakes in live tests.** Any `FakeDriver`/`FakeKeyApi`/fake-pi import in a
   `*.live.test.ts` file is a bug. Config integers copied for parity (rate tables)
   are acceptable when documented in a comment; usage/spend substrate is never faked.
2. **Spend protocol is non-negotiable.** Before any TIER ≥ 2 run: print the
   worst-case estimate (keys × cap + box-hours), get an explicit operator "go".
   Default cap 50 000 µ$/key. Every key minted is revoked in `finally`; every box
   destroyed in `finally`; assert `final-ls` shows zero `e2e-*`/`qds-*` boxes.
3. **Secrets.** `OPENROUTER_PROVISIONING_KEY` lives in the repo root `.env` (bun
   auto-loads it **from repo cwd only** — see gotcha #1). Never print/echo key
   values. Evidence goes through `writeEvidence()`'s scrub, which self-fails if any
   `sk-or-` survives.
4. **Never run the full `bun test` suite in parallel with live tiers, or before a
   live fanout test.** Reasons in gotchas #4/#5 — this caused three separate
   blockages on 2026-08-28.

## Gating and env contract

Every live test is `test.todoIf(!process.env.QDS_E2E_LIVE)` — a plain `bun test`
pays nothing. A live run needs all of:

```bash
export QDS_E2E_LIVE=1
export QDS_E2E_TIER=2            # 1 for tier-1, 2 for tiers 2/3/4
export QDS_EXEDEV_REPO_URL=https://github.com/biospark33/QDS-Factory.git
export QDS_EXEDEV_SHA=$(git rev-parse HEAD)   # MUST be pushed — dispatch fill clones it
export QDS_EXEDEV_ROSTER=$PWD/config/rosters/roster.yaml
bun test tests/fleet/e2e/<tier-file>.live.test.ts
```

- A half-configured env makes `liveGate()` THROW (a hollow live-fire is a bug, not
  a skip). `ssh exe.dev whoami` must work first (interactive login is operator-only).
- `config/rosters/roster.yaml` is the roster, and the only one: it is the file the
  setup gate reads BESIDE the dispatch manifest (`dispatch.ts`:
  `dirname(manifestPath)/roster.yaml`), it carries the proven-live T2 pair (lead
  `claude-haiku-4.5`, fixer `deepseek-v3.2`), and gate C pings every model in it —
  two roles is the minimum that contract exercises. It is what the passing DF2.10
  round actually used. `qds-default.roster.yaml` beside it is DF1.5's three-role
  product default, not an e2e roster. Earlier drafts of this file and the
  `_bmad-output/workflow-state/code-review/e2e-audit/` handoffs name a
  `df16-e2e.roster.yaml`; **no such file has ever existed in this repo** — and
  the failure lands one layer LATER than you would guess. `liveGate()` only
  checks the tier and that each of `QDS_E2E_LIVE`/`QDS_E2E_TIER`/
  `QDS_EXEDEV_REPO_URL`/`QDS_EXEDEV_SHA`/`QDS_EXEDEV_ROSTER`/
  `OPENROUTER_PROVISIONING_KEY` is non-empty; it never opens the path. The file
  is opened and parsed by the SETUP GATE (`rosterModels()` in
  `src/providers/exedev/setup-gate.ts`), which throws an unreadable-roster
  error — so a bogus roster path sails through `liveGate()` and dies at setup,
  after a box may already exist.
- `QDS_EXEDEV_SHA` must be a **pushed** commit containing any roster manifest the
  brief references (`config/rosters/*.pipeline.json` are delivered from the repo at
  that SHA). Commit + push new manifests BEFORE dispatching.

## The tiers

| Tier | Files (`tests/fleet/e2e/`) | What's real | Cost |
|------|------------------------------|-------------|------|
| 1 | tier1-{driver-lifecycle,provision-status,harvest,teardown,fanout-refusal,lock,approval-gate,attach-transport} | real boxes, real key API, shell no-ops | boxes only, 0 model spend |
| 2 | tier2-{dispatch-engine,fanout-bestofn} | + real model calls in-box | ~50k µ$/key + box-hrs |
| 2 (misnamed) | tier1-image-contract, tier5-gate-steering | both call `liveGate("2")` despite the prefix — real OpenRouter calls, spend approval required | as tier 2 |
| 3 | tier3-{race,manystories,expose-port,reaper,remote-phases} | patterns, reaper, on-box phases via the remote shim | similar |
| 4 | tier4-resident | resident orchestrator: real dispatch brief → real pi steering on OpenRouter → journal telemetry | 1 dispatch key + 1 resident key + 1 box ≈ $0.10 worst |

**The filename prefix is not the gate — read the call, not the name.** Two files
spend money despite their prefixes: `tier1-image-contract` (DF2.10's boot
contract; setup gates C/D/E make real OpenRouter calls, so labelling it tier-1
would have been a false zero-spend claim) and `tier5-gate-steering` both call
`liveGate("2")` and need `QDS_E2E_TIER=2` plus an explicit spend go. Before
running an unfamiliar file, grep the FILE (an operand-less `grep -n 'liveGate('`
reads stdin and hangs, which reads as "no match"):

```bash
grep -n 'liveGate(' tests/fleet/e2e/<file>.live.test.ts
```

The argument is the tier, and it is the only authority on what a file costs.

Run order within a round: free things first (tsc, biome, gated-off load check),
then TIER-1, then paid tiers sequentially. Evidence lands in
`_bmad-output/evidence/df3-e2e/` (one redacted JSON per test run, written PASS or
FAIL from `finally`). Report per-test PROVEN/BROKEN with verbatim failures.

## TIER-4 specifics (resident orchestrator)

Read `tests/fleet/e2e/tier4-resident.live.test.ts` before touching this tier. The
load-bearing setup facts:

- One dispatch serves three legs (S28 witness freshness is ±30 min): L1 control
  (`--no-resident`), L2 steered (armed), L3 degraded (`QDS_RESIDENT_TIMEOUT_MS=50`).
- Each leg carries its own copy of the delivered pair under `<leg>/delivered/` —
  `pipeline-run.ts` refuses a manifest resolving outside `--run-root` (INV-1).
- The resident's key is minted SEPARATELY (create the record row first —
  `mintRunKey` reads `<id>.json` and a missing row is an ENOENT throw).
- Armed legs run pi under an **isolated HOME** (see gotcha #2) with
  `QDS_PI_CATALOG_DIR` pointed at `tests/phase-engine/fixtures/pi-catalog`
  (rates mirror host `models.json`; gotcha #3).
- Model output is nondeterministic: assert ENGINE invariants conditional on the
  directive actions observed (an abort ⇒ `ok:false` + fail transition; a healthy
  run ⇒ same promotion/gate sequence as the control). The per-point allowlist
  firing on a real model ("retry has no steering effect at run_end" tripwire) is a
  PASS shape, not a failure.

## Gotchas that cost real time on 2026-08-28

1. **Shell cwd silently drifts.** `bun scripts/fleet.ts …` and `bunx` resolve
   relative paths and `.env` from the CURRENT cwd. A stray `cd /tmp` makes every
   invocation fail with `Module not found "scripts/fleet.ts"` or a missing
   provisioning key. Run `pwd` when anything resolves weirdly; use absolute paths.
2. **Host pi auth shadowing.** pi resolves `~/.pi/agent/auth.json`'s openrouter
   entry OVER the `OPENROUTER_API_KEY` env var. A dead stored key ⇒ every call
   401s "User not found", pi exits 0 with EMPTY content, steering fail-closed
   degrades. Fix shape: spawn pi with an isolated `HOME` containing a copy of
   `~/.pi/agent/models.json` and NO `auth.json` (the model slug resolves only
   through that custom registry). In-box pi is unaffected (no auth.json there).
3. **No bundled catalog on global-npm hosts.** `loadBundledCatalog()` throws
   before the custom registry is consulted ⇒ resident degrades `rate_unresolved`
   even though models.json prices the slug (issue #140). Set `QDS_PI_CATALOG_DIR`.
4. **The full suite leaks a repo-cwd fleet lock** (issue #138). Any `bun test`
   leaves `.sandbox/fleet.lock` potentially held; live fanout verbs then refuse
   exit 5 `fleet-busy` for up to 1h (`FLEET_LOCK_STALE_MS`). Before a live
   fanout/tier-2+ run: check `.sandbox/fleet.lock`; if the holder pid is dead
   (`ps -p <pid>`), `rm` it. Also expect abandoned race records in
   `.sandbox/fanouts/` after every suite run — pre-existing, not your regression.
5. **Suite-under-load flakes are environmental.** With machine load high (or disk
   ~98% full), the suite fails dozens of I/O-heavy tests at bun's 5s default
   timeout (pr/open-pr, gitnexus CLI spawns, reverify worktrees). Check
   `uptime`, `ps aux -r` for stray spinners (issue #139: a leaked
   `bun hang-test.ts` burned 934 CPU-minutes), and disk before blaming the diff.
   Rerun the suite with NOTHING else running for the real verdict.
6. **Exit codes are a table, not 0-or-bad.** Teardown: 0 = full success,
   **6 = `harvest_waived` success** (a `--no-harvest` teardown legitimately exits
   6 — asserting `toBe(0)` on it is wrong). 5 = lock refusal (run-locked /
   fleet-busy), 2 = validation refusal, 4 = no-record. An exit-6 teardown on a
   succeeded test body is NOT a VM leak.
7. **Manifest budget math.** `requiredBudgetMs = Σ (retries+1) ×
   (PARSE_FIX_ATTEMPTS+1) × maxDurationMs + n × ROUTING_MARGIN_MS` — a manifest
   whose declared `runBudgetMs` is below that is refused at dispatch
   (`manifest-rejected`), and the runner's `--budget-ms` must be ≥ `runBudgetMs`.
8. **Witness/requestId matching.** Pass `--request-id` equal to the fetched
   `run-context.json`'s requestId (mismatch = DF3.1 refusal). Witness freshness is
   the file's mtime, ±30 min.
9. **GateEvent phaseIds are attempt-qualified** (`<runId>:<attempt>:<phase>`) —
   project the last colon segment when comparing gate sequences across legs.

## Failure triage protocol

When a live test fails:

1. Read the evidence JSON first (`_bmad-output/evidence/df3-e2e/<latest>-*`) —
   every test writes phases verbatim, including refusal envelopes and stderr
   tails. If the workspace was kept (`workspace kept for forensics`), the leg
   dirs hold journals, session files, and artifacts.
2. Classify: product regression vs test defect vs environment. The 2026-08-28
   round's first three TIER-1 failures were ALL latent test defects (wrong exit
   assert, env-coupled brief slug, wrong lock filename polled) — each provable
   from old passing evidence before touching code.
3. Rerun a suspected flake once in isolation before investigating further.
4. Fix test defects with the source cited in the comment (old evidence, line
   numbers). Run `bunx tsc --noEmit` + `bunx biome check` on touched files,
   GitNexus `detect_changes` before committing, and push — live dispatch needs
   the SHA on the remote.
5. Deferred product findings get a detailed GitHub issue immediately (operator
   rule): see #138 (sandbox pollution/lock leak), #139 (spinner leak),
   #140 (rate-source ordering).

## Before declaring the round done

- Every tier file run green at least once on the final SHA; evidence files exist
  for each.
- Full `bun test` clean run completed with nothing else running (expect the
  documented pre-existing/environmental failures — name them, don't hide them).
- No leaked boxes (`driver.list()` empty of `e2e-*`/`qds-*`), no unrevoked key
  hashes (compare `listedKeyHashes()` before/after), `.sandbox/fleet.lock` absent
  or holder-dead.
- Spend totals recorded (journal `resident.spendMicros`, teardown spend rows) and
  within caps.
