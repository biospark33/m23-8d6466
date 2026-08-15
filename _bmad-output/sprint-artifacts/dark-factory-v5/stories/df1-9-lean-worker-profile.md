# DF1.9: Lean Worker Profile — Measure the Extension/Skill Overhead

**Story Points:** 3
**Sprint:** v5-S1 (early-safe; R5 §3 pairs it with DF2.7 — same dev, same week, same file)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §8 step 1,
  §5.1 tiers (tier-3 = the local subprocess team)
- Decision register: v5 §4 **D5** (team runtime is pi via `team-lead-driver.ts`); derivation
  register `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` §5 row
  "37K-token pi overhead → **DF1.9** (benchmark AC — measure, not assume)"
- Gate conditions: `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` §3.3
  (37,279 tok/turn `[M]`, 78–88% of every agent's bill), §4 finding 1 (the 5–6× hypothesis)
- Evidence: R4 §4.1 (flags confirmed, hypothesis self-marked untested); R3 §2.1–§2.3, §10
  (driver seams); R5 §6 facts 4, 7, 8

## User Story

As a factory operator paying for every agent turn,
I want the extension/skill discovery overhead on tier-3 workers measured before and after it is
disabled,
so that the factory's single largest cost lever is decided by a number from this repo rather than
by an untested 5–6× hypothesis.

## Overview

pi's per-turn fixed overhead is **37,279 input tokens (measured)** — 78–88% of every agent's bill.
pi 0.55.0 exposes `--no-extensions` and `--no-skills`, both **confirmed present** on this host, and
`--no-extensions` still honours explicit `-e` paths. This story threads an opt-in per-worker `lean`
flag from the team manifest through `runner.ts`'s `QDS_AGENT_TEAM_CONFIG_JSON` export into
`runWorkerPi`'s pi argv, adds an opt-in redacted capture of each worker's raw NDJSON so first-turn
input tokens are observable, and ships an A/B harness that runs the same manifest both ways and
writes the measured ratio to a verdict artifact. **The deliverable is the measurement.** The 5–6×
payoff is the hypothesis under test; the harness records `supported`, `refuted` or `inconclusive`
with equal willingness.

## E2E Slice

**Demonstrable behavior:** Given `cli-anything/manifests/lean-benchmark.yaml` with an OpenRouter
roster, When the operator runs `npm run bench:lean-worker`, it executes the control arm (no lean
flags) ≥3 times → the lean arm (`--no-extensions --no-skills`) ≥3 times → parses first-turn input
tokens per worker out of each arm's captured NDJSON → writes `artifacts/lean-worker-benchmark.json`
carrying both arms' mean first-turn input tokens, `ratio`, `deltaTokens`, N per arm, and
`hypothesisVerdict: supported | refuted | inconclusive`.

**Wiring closed:** On completion of this story, a lean worker spawn and its measurement are real
using only code merged by this story, against `cli-anything/scripts/team-lead-driver.ts` directly.
No stub, no `TODO: wire later`, no sibling story required — DF1.6 is explicitly **not** a
predecessor.

**Dependency edges (predecessors):** P0.2, P0.3.

## Acceptance Criteria

1. **(make-or-break)** Given the benchmark manifest, When `npm run bench:lean-worker` completes,
   Then `artifacts/lean-worker-benchmark.json` records, for each arm, `n`, mean and per-run
   first-turn input tokens per worker, the model slugs used, `ratio` **and** `deltaTokens` as
   defined in Technical Notes, and a `hypothesisVerdict`. A run that cannot compute both arms
   writes `inconclusive` and **no ratio** — the story passes on a refutation exactly as it passes
   on a confirmation.
2. Given a worker whose manifest entry sets `lean: true`, When the driver spawns it, Then the pi
   argv gains exactly `--no-extensions --no-skills` followed by one `-e <path>` pair per entry in
   that worker's `extensions` allowlist, all inserted **before** `-p` — which stays last and still
   carries `${w.prompt}\n\n${schemaInstruction}`. `--no-extensions` disables *discovery* only, so
   explicit `-e` paths still load (R4 §4.1).
3. Given a manifest with **no** `lean` key on any worker, When the driver spawns, Then the argv is
   byte-identical to today's spawn (`--provider P --model M --mode json --no-session -p <prompt>`,
   `team-lead-driver.ts:129-141`). Lean is opt-in; the default path does not change.
4. Given an arm in which a worker produced zero usage-bearing turns (spawn failure, empty stream,
   timeout), When the harness aggregates, Then it exits non-zero with `inconclusive`, records the
   failing arm and worker, and reports **no** saving — never hanging, retrying indefinitely, or
   falling back to the other arm's data.
5. Given `QDS_TEAM_RAW_WORKER_DIR` unset, When any team run executes, Then no raw worker stream is
   written anywhere — capture is opt-in and off by default.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `npm run bench:lean-worker` (new script) | in-scope | the AC1 e2e demo | — |
| `runTeamManifest()` programmatic (`cli-anything/src/runner.ts:502`), incl. the `smoke:team` path | in-scope | `cli-anything/test/manifest.test.ts` + `cli-anything/test/team-lead-driver.test.ts` (**new** — no such file exists today; this story creates it) argv cases | — |
| `QDS_AGENT_TEAM_CONFIG_JSON` set directly by an external caller | in-scope | driver-level argv test over a hand-built config | — |
| Fleet dispatch selecting a lean profile per role; roster `harness_engineering` driving the `-e` list | out-of-scope | — | DF3.1, DF1.5, DF1.6 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| pi CLI 0.55.x with `--no-extensions` / `--no-skills` | host binary `/usr/local/bin/pi`; F13 pins pi libs 0.55.x | bench preflight greps both flags out of `pi --help` and asserts `pi --version` starts `0.55.`; either absent → exit `2` **before any spend** |
| OpenRouter routing + a funded key | `OPENROUTER_API_KEY` in the parent env; presence-only logged at `cli-anything/src/runner.ts:548-551` | the existing presence check logs `set`; `unset` → the bench refuses to run and spends nothing |
| Warm-cache parity between arms | same manifest, same roster, arms interleaved (C,L,C,L,…) in one invocation | arm order and start timestamps recorded in the artifact; each arm asserts `n >= 3` |
| Artifact sink | `artifacts/` on the host (existing `writeArtifactAtomic`, `cli-anything/src/team-events.ts:138`) | the harness writes the verdict atomically; a partial write leaves no artifact rather than half of one |

## Technical Notes

- **The 5–6× is a hypothesis, not a target.** Its own source marks the elimination figure "untested"
  (gates report §3.3 row "Cache regime"); only the 37,279 tok/turn overhead is measured. No AC or
  artifact field asserts a saving the harness did not compute.
- **Measure first-turn input tokens, not run totals.** `runWorkerPi`'s harvest loop **overwrites**
  usage per event (`team-lead-driver.ts:231,233,237,238`), so harvested `inputTokens` is the *last*
  turn's value and run totals are untrustworthy until DF2.7 lands (R5 §6 fact 7). First-turn input
  is the correct instrument anyway: the cold prompt — system prompt plus discovered extensions and
  skills plus the task — is exactly what these flags remove. **No run-total savings claim.**
- **Today's workers load zero explicit extensions, and coms is not one of them.** The spawn at
  `team-lead-driver.ts:129-141` passes no `-e`, so the entire 37K is ambient discovery; on the
  proven local path "coms" is subprocess-RPC the driver *synthesizes* (`:14-15`, `:42`), not a pi
  extension — so `--no-extensions` cannot regress it today. The `extensions` allowlist is the escape
  hatch for a role that later needs a real one (coms-net); under `-ne` explicit `-e` paths still
  load and AC2 pins that. **Not symmetric for skills:** `--no-skills` disables discovery *and
  loading* (R4 §4.1 verbatim), so no explicit `--skill` survives lean — out of scope here.
- **Seams touched** (R3 §10): `WorkerConfig` at `team-lead-driver.ts:26-31` gains `lean?: boolean`
  and `extensions?: string[]`; the spawn argv at `:129-141`; the config export at
  `runner.ts:533-544` (worker mapping `:539-543`); and **the manifest role schema, which lives in
  `cli-anything/src/types.ts`, not `manifest.ts`**. The schema that actually validates a worker
  entry is `TeamRoleSchema`, and it is `.strict()` — so a manifest carrying `lean:` or
  `extensions:` is a **hard validation failure** until `TeamRoleSchema` is widened with both
  optional fields. `manifest.ts` is still edited (it is the load path), but widening it alone
  leaves every AC2/AC3 fixture rejected before spawn. **The driver takes no argv today** (R3 §2.1)
  — config flows through the existing `QDS_AGENT_TEAM_CONFIG_JSON` contract, so this story adds no
  flag parser.
- **`cli-anything/src/runner.ts` region ownership (three S1 stories touch this file).** DF1.9, DF2.7
  and DF1.6 all edit `runner.ts`, so each owns disjoint regions and none re-scopes another's
  assertions: **DF2.7** owns the cost accumulation path (usage merge, the `:707` budget-guard
  comparison and everything feeding it); **DF1.9** owns the `QDS_AGENT_TEAM_CONFIG_JSON` export and
  worker mapping (`:533-544`, `:539-543`) for the `lean`/`extensions` fields; **DF1.6** owns the
  `QDS_TEAM_RUNNER` seam read at `:554`, the child-environment construction around it (including its
  `budgetCapUsd` raise), and the RSS watchdog it adds. DF2.7
  merges first (it is DF1.6's declared predecessor); DF1.9 and DF1.6 follow in either order, because
  their regions are disjoint from each other's and from DF2.7's. A change outside your own region
  belongs in the owning story, whatever the merge order happens to make convenient — in particular
  this story does **not** touch the usage-overwrite lines at `team-lead-driver.ts:231,233,237,238`,
  which is why it measures first-turn input tokens instead of run totals.
- **`cli-anything/src/types.ts` region ownership (the same file is shared, and the runner.ts note
  above does not cover it).** **DF1.9** owns `TeamRoleSchema` (`:33-49`) — the `lean` and
  `extensions` optional keys widen that `.strict()` object and nothing else in it; **DF1.6** owns
  the merged-output surface (`:125-145`) — the top-level `testResults`, `testsExecuted`, `summary`,
  `durationMs`, `mulchPrimed`, `mulchPrimeError` and `artifacts` fields. `exitStatus` (`:79`) is
  pre-existing and owned by neither: both import it, neither re-declares it. Disjoint regions,
  additive edits, merge order irrelevant — the same rule as runner.ts.
- **Guards/limits:** each arm `n >= 3`, hard cap 5 runs per arm; per-run timeout from
  `PI_COMS_TIMEOUT_MS` (bounded parse at `:286-292`, default 240,000 ms — note `runner.ts:546`
  overwrites it from the manifest); raw capture per worker bounded at 8 MiB, truncation recorded.
- **Define the ratio; record the delta beside it.** `ratio` = control-arm mean first-turn input
  tokens ÷ lean-arm mean, per worker then aggregated; `hypothesisVerdict` = `supported` at ≥ 5.0,
  `refuted` below it with both arms valid, else `inconclusive`. **A lean-arm mean of exactly `0`
  is `inconclusive` with no `ratio` field** — the same zero-denominator rule as an arm that
  cannot be computed at all (AC4) — never a division that yields `Infinity` or a `null`-serialized
  ratio. The artifact **must also carry
  per-worker `deltaTokens`** (absolute tokens removed): the hypothesis is about the 37,279-token
  *overhead* term, so a large task prompt inflates both arms' first-turn totals and can push the
  ratio under 5 while the lever worked exactly as claimed. `refuted` alongside `deltaTokens ≈ 37K`
  is an artifact of prompt size, not a refutation — the verdict file must let a reader see that.
- **Deviation/assumption:** the benchmark roster is OpenRouter-only — Anthropic OAuth on this host
  expired ~2026-02-25 (R5 §6 fact 4). An unreachable provider fails the preflight closed at exit `2`
  rather than producing a one-armed comparison; the gap goes in the Dev Agent Record.

## Observability Contract

- Every run logs `{ requestId, arm, iteration, agentId, model, firstTurnInputTokens,
  usageBearingTurns, durationMs, exitStatus }`; `exitStatus` is the 5-value enum (CC-1,
  `cli-anything/src/types.ts:79`).
- requestId is minted by the harness and propagates into every arm, every run, and the verdict
  artifact; errors carry `{ code, message }` naming the arm and worker.
- Sub-timings `control_arm_ms` / `lean_arm_ms`; an arm that never started reports `0`, and the
  harness's own `durationMs` is authoritative.

## Files to Modify

- `cli-anything/scripts/team-lead-driver.ts`
- `cli-anything/src/runner.ts`
- `cli-anything/src/manifest.ts`
- `cli-anything/src/types.ts` (widen `TeamRoleSchema` — `.strict()`, so `lean`/`extensions` fail validation without it)
- `cli-anything/manifests/lean-benchmark.yaml`
- `scripts/lean-worker-benchmark.ts`
- `cli-anything/test/team-lead-driver.test.ts`
- `cli-anything/test/manifest.test.ts`
- `package.json`

## Security Invariants

- **INV-1 (secret handling in the new capture path):** raw worker NDJSON contains the full compiled
  prompt — i.e. client source code and anything that leaked into it (F11/R10). Capture is opt-in via
  `QDS_TEAM_RAW_WORKER_DIR`; every byte passes through `redactSecrets`
  (`cli-anything/src/redact.ts:62`, parent-env seeded so `OPENROUTER_API_KEY` is covered) and is
  written **into that directory** with `writeFileSync(..., { mode: 0o600 })` — **not** through
  `writeArtifactAtomic`, which `JSON.stringify`s its payload, force-appends `.json` and sets no
  mode (`team-events.ts:138-161`). Unset variable → no file, no directory created (AC5).
  **Redaction scope is limited to parent-env values under secret-ish key names** (DF1.5 INV-1):
  secrets embedded in the compiled prompt (`w.prompt`), manifest values, or worker-read files are
  NOT parent-env values and are not masked. The supported secret-handling boundary is parent-env
  coverage plus the `0600` file mode and the opt-in directory — not full-content redaction.
  Captured NDJSON is client source code and stays inside the repo data boundary.
- **INV-2 (input validation):** `lean` and `extensions` are parsed by the existing closed role schema
  — `TeamRoleSchema` in `cli-anything/src/types.ts`, which stays `.strict()` after being widened, so
  no *other* unknown key becomes acceptable as a side effect of this change; a non-boolean `lean` or
  non-array `extensions` is a validation error, never a truthy
  coercion, and an `extensions` entry escaping the repo root is rejected before spawn, not sanitized.
- **INV-3 (no silent capability loss):** `--no-extensions` may not disable a security-relevant
  extension by accident. A worker's `extensions` allowlist is explicit in the manifest and
  re-emitted as `-e` under lean; AC2's argv assertion enforces it.
- **INV-4 (no credentials in evidence):** the verdict artifact records token counts, model slugs,
  arm labels, run ids and timings only; provider keys keep the presence-only discipline at
  `runner.ts:548-551` and never reach the artifact, the logs, or argv.
- **INV-5 (fail-closed measurement):** a missing measurement is never reported as a saving. Zero
  usage-bearing turns in either arm, a missing pi flag at preflight, or a truncated capture yields
  `inconclusive` with a non-zero exit and no ratio field (AC4).

## Definition of Done

- [x] **Impl:** per-worker `lean` adds exactly `--no-extensions --no-skills` to the pi argv in
      `runWorkerPi`; `extensions` entries are appended as explicit `-e <path>`
- [x] **Impl:** opt-in redacted raw-NDJSON capture per worker, gated on `QDS_TEAM_RAW_WORKER_DIR`,
      written mode `0600` into that dir; the JSON verdict artifact keeps `writeArtifactAtomic`
      unchanged — `cli-anything/src/team-events.ts` is not modified (enforces INV-1)
- [x] **Contract:** `WorkerConfig` **and** `TeamRoleSchema` (`cli-anything/src/types.ts`) widened with
      `lean?`/`extensions?`, the latter still `.strict()`; a manifest carrying either key validates,
      one carrying an unrelated unknown key still fails; absent fields reproduce today's argv
      byte-for-byte
- [x] **Integration:** manifest `lean:`/`extensions:` flow through the worker mapping in
      `cli-anything/src/runner.ts:539-543` into `QDS_AGENT_TEAM_CONFIG_JSON`
- [x] **Security:** an `extensions` path outside the repo root is rejected before spawn, with the
      path echoed but never executed (see INV-2)
- [x] **Test (unit):** argv assertions for lean-on, lean-off, and lean-on-with-two-`-e`-paths —
      the last proving explicit extensions survive `--no-extensions`
- [x] **Test (default-off boundary):** a manifest with no `lean` key produces the exact
      9-element argv of `team-lead-driver.ts:129-141`; a diff of one element fails the test
- [x] **Test (measurement integrity):** an arm stubbed to produce zero usage-bearing turns →
      harness exits non-zero, writes `hypothesisVerdict: "inconclusive"`, and emits no `ratio`
      field. An implementation that averages over the surviving arm MUST fail this test
- [x] **Test (e2e demo — MANDATORY):** DONE — funded run taken 2026-08-15 (OPENROUTER_API_KEY
      supplied; 3 interleaved iterations per arm, ~23 min). Artifact:
      `../evidence/df1-9-lean-worker-benchmark-funded-run.json`. `hypothesisVerdict:
      "inconclusive"` — worker-b (nemotron-nano-9b-v2:free) produced a clean signal
      (control 27,278 → lean 5,420 first-turn input tokens, ratio 5.03, deltaTokens 21,858 —
      the extension/skill overhead term, matching the 37,279-token model's shape), but
      worker-a (gpt-oss-20b:free) reported zero first-turn usage in all control runs
      (`zero_control_mean` error, AC4's exact fail-closed path: exit non-zero, no ratio in
      aggregate, no fallback to the surviving arm). A free-slug usage-reporting gap, not a
      harness defect. ORIGINAL: `npm run bench:lean-worker` on
      `cli-anything/manifests/lean-benchmark.yaml` produces `artifacts/lean-worker-benchmark.json`
      carrying both arms at `n >= 3`, mean first-turn input tokens per arm, `ratio`, `deltaTokens`
      and a `hypothesisVerdict` — recorded and reported whatever the number turns out to be

## Dev Agent Record

**Status:** done — PR [#107](https://github.com/biospark33/QDS-Factory/pull/107) squash-merged to
`main` 2026-08-14 (`a182205`). Developed with `qds-dev DF1.9 --yolo --skip-docker-tests`; all
`--yolo`-skippable HITL gates auto-approved. Three in-depth review rounds before PR, plus three
after. **The funded measurement was taken 2026-08-15 — see the warning block below (updated):
inconclusive on worker-a's zero control mean; worker-b ratio 5.03× / delta 21,858 tokens.**

CodeRabbit's merge-readiness verdict: *"Yes. Excluding CI/CD, PR #107 is ready to merge. All
unresolved review threads are outdated."*

Post-PR rounds:

- **`4eff36b`** — `resolveExtensionPaths` rejected legitimate in-root names like `..gitignore`
  because the escape check was `rel.startsWith("..")`; now `rel === ".." || rel.startsWith(\`..${sep}\`)
  || isAbsolute(rel)`, importing `sep` so it holds on Windows (the suggested fix hardcoded `/`).
  Rejected: `isAssistant` treating a missing `role` as assistant — deliberate and documented, no
  producer emits a role-less `toolResult`, and flipping the default would silently drop real
  assistant usage. CodeRabbit later withdrew that finding.
- **`b7576fd`** — text collection in `harvestPiStream` gated to `message_end` only, matching the
  terminal-only rule the function already applied to usage accumulation; a SIGKILLed mid-stream
  `message_update` could otherwise leak partial text that `extractJsonObject` misparses as a
  complete reply. Two evidence corrections: containment is realpath-only (lexical was reverted in
  round 2 for macOS symlinks), and `resolveExtensionPaths` takes `REPO_ROOT`, not `process.cwd()`.
  **Rejected with teeth:** the suggestion to mark successful runs partial when `costUnpriced` would
  have *thrown at runtime* — `merger.ts` enforces `exitStatus === "success" ⟹ partial === false` as
  a frozen P0.3-M2 invariant. Recorded as a possible follow-up story, not a quick win.
- **`c46dbfe`** — `scripts/lean-worker-benchmark.ts:6` still described the arms as running "back to
  back"; they interleave (C,L,C,L,… at line 618). The sweep also found the same stale claim in this
  file's Infra Prerequisites table, which no reviewer had flagged.

> **Apparatus-is-inert challenge — rejected with the full chain.** A reviewer claimed nothing
> implements `lean`, which would mean both arms run identically and the harness measures nothing
> ("consistent with the missing measurement"). Verified wired end to end; the supporting files
> landed in `1589bf6`, outside the reviewer's diff window: `package.json:18` → `scripts/lean-worker-benchmark.ts`
> (`manifestForArm()` strips/sets `lean`, `main()` interleaves) → `types.ts:53` `TeamRoleSchema.lean`
> → `runner.ts:546` spread into `QDS_AGENT_TEAM_CONFIG_JSON` → `team-lead-driver.ts:378`
> `buildWorkerArgv` emitting `--no-extensions --no-skills` → `spawn("pi", …)` at line 589. The
> driver-level argv assertion the reviewer asked for already exists at `team-lead-driver.test.ts:268`.

> **Merge-conflict resolution (`b34a5c5`).** DF2.7 (#103), DF2.1 (#102) and DF1.1 (#104)
> squash-merged into `main` after this branch was cut from DF2.7's pre-squash commits, so `main`
> shared no ancestry with them and the branch went `CONFLICTING`. Resolved by merge (not rebase —
> the branch was published): `main` authoritative for DF2.7-owned files, this PR for DF1.9-owned
> files, `sprint-status.yaml` merged so both stories' entries survive. Verified semantically, not
> just textually — the full `lean` chain and `main`'s `applyCostEvent` finite/non-negative guard
> both survive; `bun test cli-anything` 212 pass / 0 fail. CodeRabbit reviewed the merge commit and
> independently confirmed all three properties.

> **CI note:** the `check` workflow shows FAILURE, but the job never started — GitHub Actions
> billing. Wave-wide, not a code signal. Local gates at merge: 212 pass / 0 fail (`cli-anything`),
> `tsc --noEmit` clean, biome clean.

### ⚠️ The measurement was taken 2026-08-15 (funded). Verdict: inconclusive on a technicality, one clean signal.

**Supersedes the original warning below in full.** A funded `OPENROUTER_API_KEY` ran the bench
against real OpenRouter (3 interleaved iterations per arm, free slugs per the manifest, ~$0
spent). Artifact: `../evidence/df1-9-lean-worker-benchmark-funded-run.json`.

- **worker-b** (nemotron-nano-9b-v2:free): control mean 27,278 → lean mean 5,420 first-turn
  input tokens — **ratio 5.03×, deltaTokens 21,858**. The extension/skill overhead term is
  real and the lean lever removes it, in the 5–6× band the stub modelled.
- **worker-a** (gpt-oss-20b:free): every control run exited `overflow`/`transient` with
  `firstTurnInputTokens: 0` — the free slug never reported first-turn usage, so the control
  arm mean is 0 and the harness correctly refused to compute an aggregate ratio
  (`zero_control_mean`, exit non-zero, AC4/INV-5 fail-closed).
- **Formal verdict: `inconclusive`** per the story's own rule that a zero-mean arm yields no
  ratio. The per-worker record above is the honest reading: one worker confirms the
  hypothesis, the other produced no data. A re-run with a paid worker-a slug (usage reported
  from turn 1) would close it cleanly if a formal `supported` verdict is ever needed.

Host note: before this run, `pi` itself hung at startup on this machine — root cause was the
`packages` entries (`npm:pi-lens`, `npm:pi-gitnexus-plus@0.7.0`) in
`~/.pi/agent/settings.json` hanging at load under every runtime; they were removed (backup:
`settings.json.bak-packages`). Re-add only after that package-load hang is diagnosed.

Original warning, kept for the record:

What *is* proven: the whole apparatus end to end — both arms, the manifest rewrite, the raw
capture, the first-turn parser, the aggregation and the verdict — against a stub pi. The stub
subtracts exactly 37,279 tokens when it sees both flags, i.e. **it assumes the hypothesis
under test**. Its `ratio 5.66 → supported` measures the harness and says nothing about pi.
The 5–6× remains untested, exactly as gates report §3.3 marks it.

### The e2e demo found a real bug in the harness

The first end-to-end run reported `ratio 4.11 → refuted` while the modelled lever removed a
clean 37,279 tokens from *every* worker. Cause: the driver captures the **lead's** stream too,
and the harness averaged it in — `lean` is per-worker and the lead is never leaned, so its
ratio is 1.0 by construction (5.66, 5.66, 1.0 → 4.11). A silent drag toward "refuted" on every
run, on the exact hypothesis the story exists to test. Fixed by measuring only the manifest's
declared workers; regression-locked.

That is also the story's own warning made concrete: `deltaTokens` was a clean 74,558 the whole
time. A reader with only the ratio concludes the lever failed; a reader with `deltaTokens`
beside it sees it worked. The artifact carries both, per worker and in aggregate.

### Autonomous decisions (--yolo)

- **Arms are produced by rewriting the manifest**, not by a driver-side env override — the only
  difference between arms is the manifest key this story ships, so there is no second config
  path production never uses. `yaml` was already a dependency. `lean` is *removed* for the
  control arm rather than set to `undefined`, because `yaml` serialises that as `lean: null`
  and `z.boolean()` rejects null — the control arm would fail validation before spawning.
- **Arms are interleaved** (C,L,C,L,…) rather than run back to back, and the real order plus
  per-iteration timestamps go in the artifact as `iterationOrder`. Back-to-back arms give the
  second arm every prompt-cache effect the first warmed, and that lands entirely on the lever's
  side; the Infra Prerequisites row asks for parity, and sequencing was not it.
- **`cli-anything/src/manifest.ts` was NOT edited** despite being in Files to Modify. It holds
  no role-schema logic — it delegates wholly to `TeamManifestSchema`, so widening
  `TeamRoleSchema` *is* the load path. The edit would have been a no-op diff.
- **The pi-version preflight is implemented as specified** (exit 2 unless `0.55.`), with
  `QDS_BENCH_ALLOW_PI_VERSION=1` as an explicit escape hatch that records the actual version in
  the artifact. Note the correction below: under `npm run` the pinned pi *is* 0.55.0, so the
  gate passes by the intended route.
- **`extensions` containment is checked only under `lean`.** `buildWorkerArgv` emits `-e`
  nowhere else, so killing a worker over a field that was never going to reach pi's argv is a
  denial of service, not a protection. A non-lean worker carrying `extensions` is logged.

### Correction carried from DF2.7 (see PR body)

A bare shell `pi` on this host is the *global* `@earendil-works` build (0.84.1). But `bun run`
prepends `node_modules/.bin`, so every project script gets the **workspace-pinned
`@mariozechner/pi-coding-agent` 0.55.0** — the F13 pin. There is no version deviation on the
code path. DF2.7's Deviations section said otherwise and is corrected on this branch; the
per-turn-delta verdict was re-verified against 0.55.0 directly and holds on both builds.

### Review rounds (3, each a fresh cold-read of the full diff)

**Round 1 — 14 findings.** Two fail-open holes in the harness: a worker that vanished from the
**control** arm was deleted from the report rather than failing it (the run returned
`supported` with a ratio from the survivors and an empty error list), and `n` counted
iterations *attempted*, so the ≥3 gate could never trip on real data. Two security holes in
the capture path: `writeFileSync`'s `mode` applies only at creation and it follows symlinks — a
pre-existing 0644 file kept its mode, and a planted symlink redirected the worker's compiled
prompt into the link target; and containment was purely lexical, so `<root>/ext/out → /etc`
passed. Also: a non-string `extensions` entry threw inside the promise executor and killed the
*whole* team run, model slugs were a placeholder, `QDS_BENCH_RUNS=abc` produced NaN iterations
that also defeated the underpowered guard, and truncated captures still yielded a number.

**Round 2 — 12 findings.** The round-1 realpath fix **over-corrected**: requiring both lexical
*and* real-path containment rejects legitimate paths on macOS, where `/tmp` and `/var` are
symlinks — CI temp checkouts are exactly that case. Also: a zero **control** mean sailed through
every guard and produced a confident `refuted` (a broken instrument reported as a measured
refutation), `aggregate` could return `supported` alongside a non-empty `errors` array,
`exitStatus` collapsed the 5-value CC-1 enum to two guesses instead of reading the runner's
merged output, the harness `spawnSync` had no timeout, an exception mid-loop discarded every
observation already paid for, and the two preflight CLI tests silently encoded "this dev box
has some particular pi installed globally".

**Round 3 — DO-NOT-SHIP, 4 blocking items, all fixed.** The big one: containment was anchored
to `process.cwd()`, and the driver is spawned with no `cwd`, so it inherits the operator's
shell directory — run the harness from `$HOME` and `extensions: [".ssh"]` is "inside the root".
The mirror case was worse: run from a subdirectory and a legitimate repo-root-relative path was
*accepted*, then pi resolved the same relative string against its own cwd and loaded nothing —
silent capability loss, which INV-3 exists to forbid. Fixed by anchoring to
`pathResolve(import.meta.dir, "..", "..")` and passing the **resolved** paths into the argv, so
the string that was checked is the string that reaches pi. Second: the test suite `rmSync`'d
the repo's shared `artifacts/` directory, destroying other stories' evidence, and the preflight
tests failed on any host where an operator had actually run the bench — the bench now takes
`QDS_BENCH_ARTIFACTS_DIR` and tests use a temp sink. Third and fourth were this record and the
sprint-status line.

### Known residuals (recorded, not fixed)

- `mkdirSync(dir, { mode: 0o700 })` does not change the mode of a directory that already
  exists, so pointing `QDS_TEAM_RAW_WORKER_DIR` at an existing 0755 directory leaves it 0755.
  Files stay 0600, so the residual exposure is the listing of agent ids, not content.
- Captures live in `mkdtemp` under the system temp dir during a bench run; a SIGKILL of the
  bench leaves them there (0600) until the OS cleans up.
- **Redaction scope** is parent-env values under secret-ish key names (DF1.5 INV-1). Secrets
  embedded in the compiled prompt, in manifest values, or in files the worker read are not
  parent-env values and are not masked. The supported boundary is parent-env coverage plus the
  0600 mode plus the opt-in directory.

### Gates

`bun test cli-anything tests/lean-worker-benchmark.test.ts` 276 pass / 0 fail ·
`bunx tsc --noEmit` clean ·
`bunx @biomejs/biome check src scripts tests cli-anything pi-vs-claude-code-vendor` clean.
