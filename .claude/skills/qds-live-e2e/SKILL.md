---
name: qds-live-e2e
description: Run live (no-fakes) end-to-end E2E testing rounds for QDS-Factory fleet/phase-engine code against real exe.dev boxes and real OpenRouter spend. Use this skill whenever the user mentions e2e, end-to-end, live testing, live-fire, "no mocks/stubs/fakes", TIER-1/TIER-2/TIER-3/TIER-4 tests, QDS_E2E_LIVE, running the live suite, pre-merge verification rounds, or asks "test it live" / "another rigorous round" / "prove it on the real substrate" in this repository — even if they don't name a tier.
---

# QDS Live E2E Rounds

The repo's `bun test` suites run on fakes by design (FakeDriver, FakeKeyApi, fake pi
fixtures). Live rounds prove the real substrate: real `ssh exe.dev` boxes, real
OpenRouter keys with µ$ caps, real model calls. This skill is the operating procedure.

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
   live fanout test.** Reasons in gotchas #4/#5.

## Gating and env contract

Every live test is `test.todoIf(!process.env.QDS_E2E_LIVE)` — a plain `bun test`
pays nothing. A live run needs all of:

```bash
export QDS_E2E_LIVE=1
export QDS_E2E_TIER=2            # 1 for tier-1; 2 for EVERYTHING else — `liveGate` takes only "1"|"2"
export QDS_EXEDEV_REPO_URL=https://github.com/Quantum-Digital-Solutions/QDS-Factory.git
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

| Tier label | Files (`tests/fleet/e2e/`) | What's real | Cost |
|------|------------------------------|-------------|------|
| 1 | `tier1-*` | real boxes, real key API, shell no-ops | boxes only, 0 model spend |
| 2 | `tier2-*`, `df36b-*`, `fix-loop-verdict` | + real model calls in-box (setup gates C/D/E, dispatch solicitations). `tier2-reboot-arm` mints no key and dispatches nothing, but a rebooting box is a full-substrate act | ~50k µ$/key + box-hrs |
| 3 | `tier3-*` | patterns, reaper, on-box phases via the remote shim | similar |
| 4 | `tier4-resident` | resident orchestrator: real dispatch brief → real pi steering on OpenRouter → journal telemetry | 1 dispatch key + 1 resident key + 1 box ≈ $0.10 worst |
| 5 (label only) | `tier5-gate-steering` | calls `liveGate("2")` | as tier 2 |
| — | `sc2-*` | gated by `liveTodoOff()` only — no `liveGate` call, so `QDS_E2E_TIER` is not checked; read the file's spend estimate test | per file |

The roster is `ls tests/fleet/e2e/*.live.test.ts`; do not trust a table, including
this one.

**The filename prefix is not the gate — read the call, not the name.**
`liveGate` accepts only `"1"` or `"2"`, so "tier 3/4/5" is a label, never an env
value (`QDS_E2E_TIER=5` THROWS). A file can call it with a tier its prefix does
not suggest (`tier3-reaper` calls both `"1"` and `"2"`), and `liveTodoOff()` keys
only on `QDS_E2E_LIVE`, so a tier glob runs every matched file and a mismatched
one throws `QDS_E2E_TIER is "1", not "2"` at the end of a paid round. Before
running an unfamiliar file, grep the FILE (an operand-less `grep -n 'liveGate('`
reads stdin and hangs, which reads as "no match"):

```bash
grep -n 'liveGate(' tests/fleet/e2e/<file>.live.test.ts
```

The argument is the tier, and it is the only authority on what a file costs.

`tier1-registry-auth` (DF2.10 AC4) additionally needs `QDS_E2E_REGISTRY_AUTH_FILE`
— a 0600 file `biospark33:<read:packages PAT>` — and the private mirror
`ghcr.io/quantum-digital-solutions/qds-exedev-private` holding the pin's digest. It THROWS
(never skips) when the file is missing, and its digest derives from
`DEFAULT_IMAGE_REF`, so a re-pin fails it loudly until the mirror is re-pushed.

## Pin adoption and the mirror — run live rounds POST-adoption

A merge touching walked image sources (`src/**`, Dockerfile COPY set) moves the
image; the pin must follow through a ritual, and a live round's `image` stamp is
only meaningful against the tree it ran from. The sequence, cheapest order:

1. **Don't pre-publish from a feature branch.** The publish workflow refuses a
   real (non-dry) run off `dev`/`main` by environment branch policy — in-PR
   adoption is not a legal path. Declare pairing debt in-test instead
   (the `buildIdFileInputs` literal moves to the branch tree's walk with a
   debt comment; DF1.10 playbook), let the merge trigger the publish.
2. **The publish run's gate B failure is the ritual working.** It prints
   paste-ready `DEFAULT_IMAGE_REF` / `DEFAULT_IMAGE_BUILD_ID` lines — extract
   with `gh run view <id> --log | grep -A2 'export const DEFAULT_IMAGE'`.
   NEVER hand-compute the digest or the buildId; the workflow is the only
   source. A real publish also PRUNES the ungated tag, so the digest may not
   resolve until the healing run — mirror re-push waits for it.
3. **Adopt on `dev` directly, one commit**: run
   `bun scripts/adopt-image-pin.ts <workflow-run-id>`, which rewrites every pin
   literal from the gate log (driver REF + BUILD_ID, the Dockerfile TOFU ARGs,
   the test's measuredDefault copies, the tracked-inputs digest). Do not
   hand-edit the walk literal to the published digest: it is the offline
   file-input hash, never the image digest. Pushing the adoption commit IS the
   healing run (driver.ts is in `on.push.paths` but excluded from SOURCE_PATHS,
   so it rebuilds the same src_sha byte-identical and gate B closes green).
4. **Re-push the private mirror from the new digest** (`docker buildx
   imagetools create --tag …qds-exedev-private:build-<id> <public>@sha256:…`),
   verify with `imagetools inspect` that the digest resolves an OCI manifest.
5. **Only then run the paid tiers** — with `QDS_EXEDEV_SHA` = the pushed tree that
   carries the new pin, so `isRepoPin:true` in the evidence means the round
   proved the image the tree ships.

Cheap side-check when a digest test reds and you don't know which side moved:
recompute the walk offline (~15 lines: import `buildIdFileInputs` from
`scripts/build-exedev-image.ts`, filter `git ls-files`, sha256 over the sorted
name→hash map) on the suspect tree AND on clean dev — the pair of values names
the drift without any bisect.

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
  exported records `overriddenBy` naming the variables and `isRepoPin:false`,
  so the evidence says the repo pin is not what was proven. A file
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
| `writeEvidenceQuietly(tag, name, payload, problems)` | the evidence write itself — including the secret-scrub REFUSAL, which would otherwise throw out of the `finally` and take `settleRun` (and the body's real failure) with it |
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

## Gotchas: host environment and fleet verbs

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

## Gotchas: long runs, box I/O, and test authoring

10. **A tool-level timeout kill is the same leak as a background kill.** Live
    test ceilings (7,000 s+) far exceed any 10-minute shell cap; healthy runs
    are minutes, but if the wrapping shell call DIES at its own timeout the
    test process dies with it — `finally` never runs, the box keeps billing.
    Run each live file in its own foreground call at the max timeout, and on
    any timeout hit: `ssh exe.dev ls --json` and destroy survivors by hand
    before anything else.
11. **Strict `toBe` on box stdout: normalize ONCE, in the helper.** `cat`-style
    output carries a trailing newline; a reboot-arm round once red'd a
    HEALTHY box because its `leg()` helper trimmed the copy pushed to evidence
    but returned the RAW stream — evidence said canonical, the assert compared
    `…exedev$\n`. One normalization point, both consumers read the same
    string; a helper that shapes data for recording must return the SAME shape
    it recorded.
12. **`steering-channel-unprovisionable` with ssh 255 "closed by remote host"
    at CREATE time is retry-class**, same family as the documented mid-dispatch
    drop: the box was mid-boot when the provision script's ssh died. The
    failing round's `finally` still destroyed cleanly (verified in evidence +
    `ls --json`). Rerun once in isolation before investigating further.
13. **CI-only flakes reproduce in a container, not on the dev mac.** A
    linux/amd64 signal-timing race (SIGINT-delivery test, 1-in-8 in CI, 0-in-
    hundreds locally) reproduced 1-in-13 under `docker run --platform
    linux/amd64 -v $PWD:/repo -w /repo oven/bun:<bun-version from .github/workflows/ci.yml> sh -c 'bun test <file>
    -t "<test name>"'` looped in shell. When the payload is needed, add a
    temporary `console.error` of the raw values at the failing line, loop
    until it fires, capture, REVERT the instrumentation — the raw bytes name
    the root cause in one shot where inference from a diff render does not.
14. **A new `.live.test.ts` file must pass the offline #210 static-mirror
    sweep** (`bun test tests/fleet/e2e/`, free): every executable line hitting
    a box path (`/run/steering`, `pipeline.yaml`, …) or a status literal
    needs a `live-mirror: <owner>` comment on the line or the one above —
    including TITLE and evidence-note strings. Run the offline sweep when
    authoring, not at the paid round.
15. **If `.unlazy/<story>/status.log` exists, read it (and the story's
    filed-not-fixed notes) BEFORE re-doing an owed item.** The ledger records
    items already closed and the digest-playbook precedents (which literal is
    the walk, which is the pin).

## Gotchas: env sourcing, sandboxing, sqlite

Measured evidence for these lives in
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-11-teardown-lock-readonly-ledger.md`
§"Live E2E — round 6".

16. **Env sourcing = the hollow-green trap.** `liveTodoOff()` keys ONLY on
    `QDS_E2E_LIVE` (`liveTodoOff()` in `live-harness.ts` — `QDS_E2E_TIER` is not consulted), so a `bun test`
    invocation launched without the env exports turns every live file into a `todoIf` suite:
    **0 pass / 0 fail, exit 0** — a misconfigured run that reads as green. Rule: after every live invocation, assert the output contains **≥1
    `(pass)`**; exit 0 with zero passes is a MISCONFIGURED run, never a pass.
17. **Sandboxed shells break the substrate.** A seatbelt/sandbox wrapper denies the file
    locking and tmpdir creation sqlite WAL needs — measured as `mkdtemp` EPERM on
    `/var/folders/...` and `SQLITE_IOERR_VNODE`-class failures that do not reproduce
    unsandboxed. Live rounds (and any test that touches WAL, locks, or spawns subprocesses)
    run in an **unsandboxed shell**.
18. **Generated-subprocess scripts: import discipline.** A common red is
    a script written to disk and spawned that is missing imports (`writeFileSync`,
    `existsSync`) or carried a double-quoted import placeholder — `""path""` — produced by
    substituting `from "#PLACEHOLDER#"` with `JSON.stringify(x)` inside a template literal.
    Rule: a generated script gets its imports COUNTED against a grep before spawn, or takes a
    smoke-run first; never trust a heredoc/template you cannot lint.
19. **Boxless live tests must stamp `setEffectiveImage(null, { note })`** or F16/P125 refuses
    the evidence write — and the refusal is correct: an unstamped write would inherit a stale
    image claim from process state. `T1.8`'s stamp ("T1.8 never creates a box — the substrate
    is the host filesystem + real process timing") and D6 are the shapes to copy.
20. **bun:sqlite same-process poison** (#248, closed): after THIS process has readonly-attached
    a db whose writer is later SIGKILLed with the `-shm` deleted, a SAME-process write open of
    that file fails `SQLITE_IOERR_VNODE`, while a **fresh process** opens, checkpoints, and
    reads the crashed writer's bytes without complaint. Bisected live across four probe shapes.
    Production is unaffected — the healing writer is always another process (a teardown,
    `qds cost`) — so heal in a subprocess; the reasoning lives in the comment at the site
    (`tier1-ledger-readonly.live.test.ts`, the "healer is a FRESH PROCESS" block).
21. **The sweep's account-janitor arm under a scratch window.** `sandbox-reap --yes` with an
    isolated runs dir + a small `staleAfterMs` revokes any aged account key unnamed by that
    store. The `sbx-` prefix defense makes non-factory keys `foreign` → report-only (proven
    live, twice, against 7 named keys including ZeroPointAI/Sift/Hermes), but e2e-era `sbx-`
    orphans WILL be collected — that is the tool working, not a leak. Snapshot
    `listedKeyHashes()` before the leg and assert only that YOUR runs' keys are never touched;
    the round's one collected orphan was an aged factory key the scratch store could not name.

## Failure triage protocol

When a live test fails:

1. Read the evidence JSON first (`_bmad-output/evidence/df3-e2e/<latest>-*`) —
   every test writes phases verbatim, including refusal envelopes and stderr
   tails. If the workspace was kept (`workspace kept for forensics`), the leg
   dirs hold journals, session files, and artifacts.
2. Classify: product regression vs test defect vs environment. Latent test
   defects (wrong exit assert, env-coupled brief slug, wrong lock filename
   polled) are common; check old passing evidence first — it proves them
   without touching code.
3. Rerun a suspected flake once in isolation before investigating further.
4. Fix test defects with the source cited in the comment (old evidence, line
   numbers). Run `bunx tsc --noEmit` + `bun run lint` (the CI gates),
   GitNexus `detect_changes` before committing, and push — live dispatch needs
   the SHA on the remote.
5. Deferred product findings get a detailed GitHub issue immediately (operator
   rule): see #138 (sandbox pollution/lock leak), #139 (spinner leak),
   #140 (rate-source ordering).

## Before declaring the round done

- Every tier file run green at least once on the final SHA; evidence files exist
  for each.
- Full `bun test` clean run completed with nothing else running, captured to a
  log and read per CLAUDE.md's `tr`/`perl`/`grep` recipe (expect the
  documented pre-existing/environmental failures — name them, don't hide them).
- No leaked boxes (`driver.list()` empty of `e2e-*`/`qds-*`), no unrevoked key
  hashes, `.sandbox/fleet.lock` absent or holder-dead.
- The key half is now MACHINE-CHECKED in most tiers: `keyLeakProblems` runs in the
  `finally` of tier2-{dispatch-engine,fanout-bestofn}, every tier3 file, tier4 and
  tier5, so a green run there already proves no key hash outlived it — a teardown
  that exits 0 without revoking FAILS the round instead of shipping green.
  `grep -l keyLeakProblems tests/fleet/e2e/*.live.test.ts` is the roster of
  machine-checked files; files that mint no key are absent from it. The cheap
  and complete check is a `listedKeyHashes()` snapshot taken BEFORE the round and
  compared at the end, which covers every file regardless of what the grep
  returns.
- Spend totals recorded (journal `resident.spendMicros`, teardown spend rows) and
  within caps.
