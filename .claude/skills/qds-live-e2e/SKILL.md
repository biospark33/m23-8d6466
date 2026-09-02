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
export QDS_E2E_TIER=2            # 1 for tier-1; 2 for EVERYTHING else — `liveGate` takes only "1"|"2"
export QDS_EXEDEV_REPO_URL=https://github.com/biospark33/QDS-Factory.git
export QDS_EXEDEV_SHA=$(git rev-parse HEAD)   # MUST be pushed — dispatch fill clones it
export QDS_EXEDEV_ROSTER=$PWD/config/rosters/roster.yaml
bun test tests/fleet/e2e/<tier-file>.live.test.ts
```

- A half-configured env makes `liveGate()` THROW (a hollow live-fire is a bug, not
  a skip). `ssh exe.dev whoami` must work first (interactive login is operator-only).
- `config/rosters/roster.yaml` is the roster, and the only one: it carries the
  proven-live T2 pair (lead `claude-haiku-4.5`, fixer `deepseek-v3.2`), gate C
  pings every model in it — two roles is the minimum that contract exercises —
  and it is what the passing DF2.10 round actually used.
  `qds-default.roster.yaml` beside it is DF1.5's three-role product default, not
  an e2e roster. Earlier drafts of this file and the
  `_bmad-output/workflow-state/code-review/e2e-audit/` handoffs name a
  `df16-e2e.roster.yaml`; **no such file has ever existed in this repo.**

- **Which path the setup gate opens depends on who calls it. Both callers are
  live in a round; this is one fact with two arms, not two competing claims:**

  | Caller | the roster path `driver.setup()` receives |
  |--------|-------------------------------------------|
  | production `fleet dispatch` (`src/fleet/dispatch.ts`, `loadManifestAndRoster`) | DERIVED — `dirname(manifestPath)/roster.yaml`, pre-checked host-side before a box is billed. `QDS_EXEDEV_ROSTER` is **not read on this path at all**. |
  | the live e2e harness (`preflight()` in `tests/fleet/e2e/live-harness.ts`) | `QDS_EXEDEV_ROSTER` verbatim → `ctx.rosterPath` → `driver.setup({ rosterPath })` (the one caller today is `tier2-image-contract.live.test.ts`). |

  So `QDS_EXEDEV_ROSTER` is **not inert** — keep exporting it — but it reaches
  the gate only through the harness arm. On that arm the failure lands one layer
  LATER than you would guess: `liveGate()` only checks the tier and that each of
  `QDS_E2E_LIVE`/`QDS_E2E_TIER`/`QDS_EXEDEV_REPO_URL`/`QDS_EXEDEV_SHA`/
  `QDS_EXEDEV_ROSTER`/`OPENROUTER_PROVISIONING_KEY` is non-empty; it never opens
  the path. The file is opened and parsed by the SETUP GATE (`rosterModels()` in
  `src/providers/exedev/setup-gate.ts`), which throws an unreadable-roster
  error — so a bogus `QDS_EXEDEV_ROSTER` sails through `liveGate()` and dies at
  setup, after a box may already exist. On the dispatch arm the same bogus value
  changes nothing: a broken `QDS_EXEDEV_ROSTER` with a valid `roster.yaml` beside
  the manifest runs green, which is why "I set the env var" is not evidence that
  the roster you think is in play is the one the gate read.
- `QDS_EXEDEV_SHA` must be a **pushed** commit containing any roster manifest the
  brief references (`config/rosters/*.pipeline.json` are delivered from the repo at
  that SHA). Commit + push new manifests BEFORE dispatching.

## The tiers

| Tier | Files (`tests/fleet/e2e/`) | What's real | Cost |
|------|------------------------------|-------------|------|
| 1 | tier1-{driver-lifecycle,provision-status,harvest,teardown,fanout-refusal,lock,approval-gate,attach-transport,registry-auth} | real boxes, real key API, shell no-ops | boxes only, 0 model spend |
| 2 | tier2-{dispatch-engine,fanout-bestofn,image-contract} | + real model calls in-box (image-contract's are the setup gates C/D/E it boots the pinned digest for) | ~50k µ$/key + box-hrs |
| 3 | tier3-{race,manystories,expose-port,reaper,remote-phases} | patterns, reaper, on-box phases via the remote shim | similar |
| 4 | tier4-resident | resident orchestrator: real dispatch brief → real pi steering on OpenRouter → journal telemetry | 1 dispatch key + 1 resident key + 1 box ≈ $0.10 worst |
| 5 (misnamed) | tier5-gate-steering | calls `liveGate("2")`, so it needs `QDS_E2E_TIER=2` — a `QDS_E2E_TIER=5` export THROWS | as tier 2 |

**The filename prefix is not the gate — read the call, not the name.** Every file
above tier-1 calls `liveGate("2")`; `liveGate` accepts only `"1"` or `"2"`, so
"tier 3/4/5" is a roster label, never an env value. Exactly one file's prefix
still lies: `tier5-gate-steering`, which needs `QDS_E2E_TIER=2` plus an explicit
spend go.

`tier1-image-contract` was RENAMED to `tier2-image-contract` on 2026-09-01 for
this reason — it calls `liveGate("2")` while `liveTodoOff()` keys only on
`QDS_E2E_LIVE`, so under the natural `QDS_E2E_LIVE=1 QDS_E2E_TIER=1 bun test
tests/fleet/e2e/tier1-*.live.test.ts` it RAN and threw `QDS_E2E_TIER is "1", not
"2"` at the end of a paid round. In a suite whose whole discipline is that a red
means something real, a red that is only a naming accident is a defect. A
tier-glob is only as honest as the prefixes; before running an unfamiliar file,
grep the FILE (an operand-less `grep -n 'liveGate('` reads stdin and hangs, which
reads as "no match"):

```bash
grep -n 'liveGate(' tests/fleet/e2e/<file>.live.test.ts
```

The argument is the tier, and it is the only authority on what a file costs.

`tier1-registry-auth` (DF2.10 AC4) additionally needs `QDS_E2E_REGISTRY_AUTH_FILE`
— a 0600 file `biospark33:<read:packages PAT>` — and the private mirror
`ghcr.io/biospark33/qds-exedev-private` holding the pin's digest. It THROWS
(never skips) when the file is missing, and its digest derives from
`DEFAULT_IMAGE_REF`, so a re-pin fails it loudly until the mirror is re-pushed.

Run order within a round: free things first (tsc, biome, gated-off load check),
then TIER-1, then paid tiers sequentially. Report per-test PROVEN/BROKEN with
verbatim failures.

## Evidence, and the harness contract every tier leans on

Evidence lands in `_bmad-output/evidence/df3-e2e/` — one redacted JSON per test
run, written PASS or FAIL from `finally`. The harness stamps two keys ahead of
the test's own payload:

- `writtenAt`.
- `image` — `{ref, buildId, overriddenBy, isRepoPin}`. **This is how you prove
  WHICH image a round tested.** `preflight()` captures it from the factory-built
  driver and `writeEvidence` stamps it from module state, so no tier has to
  remember to carry it. A round with `QDS_EXEDEV_IMAGE`/`QDS_EXEDEV_IMAGE_BUILD_ID`
  exported used to print one stderr line and record nothing, leaving evidence
  indistinguishable from a repo-pinned round; now `overriddenBy` names the
  variables and `isRepoPin:false` says the pin is not what was proven. A file
  whose `image` is `{note: "preflight did not run …"}` came from a test that
  builds its own driver (`tier1-registry-auth`) — read its payload, not the stamp.

The cleanup primitives in `tests/fleet/e2e/live-harness.ts` never throw out of a
`finally`, and every one RETURNS a verdict rather than only pushing into
`evidence` — nothing reads `evidence` during the run, so a record-only failure
ships green:

| primitive | verdict it returns |
|---|---|
| `destroyQuietly(driver, vm, evidence)` | `{ok:false, error}` on a failed box destroy, plus the remediation on stderr |
| `revokeQuietly(driver, store, runId, evidence)` | the one `void` primitive (belt-and-braces revoke); its verdict is the `finally-revoke` evidence entry, and an unreadable run record is `ok:false` there — never a clean revoke |
| `teardownQuietly(argv, opts, evidence, label)` | `fleet teardown` as cleanup: a rejection OR a non-zero exit becomes `{ok:false}`. `label` spreads BEFORE `phase`, so a caller cannot overwrite the discriminator the audit filters key off |
| `writeEvidenceQuietly(tag, name, payload, problems)` | the evidence write itself — including the secret-scrub REFUSAL, which used to throw out of the `finally` and take `settleRun` (and the body's real failure) with it |
| `fleetCleanupProblems(destroyFailures, finalBoxes)` | `finalBoxes === undefined` means the listing failed, and that is a problem: an unmeasured fleet is never a clean one |
| `keyLeakProblems(before, fallback, evidence)` | key-hash delta against the pre-run listing; revokes any survivor through the fallback FIRST, then reports — needing the fallback IS the defect, so it is still not a clean round |
| `settleRun(failure, problems)` | the ONE post-`finally` throw: attaches cleanup problems to the held body error and re-throws the ORIGINAL, so an engine regression is not overwritten by a leak report |

Auditing a round's evidence post-hoc: filter `phase === X && ok === false`. Every
arm of every primitive above records `ok`, so that filter is complete.

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
  hashes, `.sandbox/fleet.lock` absent or holder-dead.
- The key half is now MACHINE-CHECKED in most tiers: `keyLeakProblems` runs in the
  `finally` of tier2-{dispatch-engine,fanout-bestofn}, every tier3 file, tier4 and
  tier5, so a green run there already proves no key hash outlived it — a teardown
  that exits 0 without revoking FAILS the round instead of shipping green. That is
  a claim a green round could not make before. `grep -l keyLeakProblems
  tests/fleet/e2e/*.live.test.ts` is the live roster; for a file NOT in it (the
  tier-1 files and `tier2-image-contract`, as of 2026-09-01, several of which do
  mint) still compare `listedKeyHashes()` before/after by hand.
- Spend totals recorded (journal `resident.spendMicros`, teardown spend rows) and
  within caps.
