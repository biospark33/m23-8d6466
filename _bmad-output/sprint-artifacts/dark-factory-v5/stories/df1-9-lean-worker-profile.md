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
| Warm-cache parity between arms | same manifest, same roster, arms run back-to-back in one invocation | arm order and start timestamps recorded in the artifact; each arm asserts `n >= 3` |
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

- [ ] **Impl:** per-worker `lean` adds exactly `--no-extensions --no-skills` to the pi argv in
      `runWorkerPi`; `extensions` entries are appended as explicit `-e <path>`
- [ ] **Impl:** opt-in redacted raw-NDJSON capture per worker, gated on `QDS_TEAM_RAW_WORKER_DIR`,
      written mode `0600` into that dir; the JSON verdict artifact keeps `writeArtifactAtomic`
      unchanged — `cli-anything/src/team-events.ts` is not modified (enforces INV-1)
- [ ] **Contract:** `WorkerConfig` **and** `TeamRoleSchema` (`cli-anything/src/types.ts`) widened with
      `lean?`/`extensions?`, the latter still `.strict()`; a manifest carrying either key validates,
      one carrying an unrelated unknown key still fails; absent fields reproduce today's argv
      byte-for-byte
- [ ] **Integration:** manifest `lean:`/`extensions:` flow through the worker mapping in
      `cli-anything/src/runner.ts:539-543` into `QDS_AGENT_TEAM_CONFIG_JSON`
- [ ] **Security:** an `extensions` path outside the repo root is rejected before spawn, with the
      path echoed but never executed (see INV-2)
- [ ] **Test (unit):** argv assertions for lean-on, lean-off, and lean-on-with-two-`-e`-paths —
      the last proving explicit extensions survive `--no-extensions`
- [ ] **Test (default-off boundary):** a manifest with no `lean` key produces the exact
      9-element argv of `team-lead-driver.ts:129-141`; a diff of one element fails the test
- [ ] **Test (measurement integrity):** an arm stubbed to produce zero usage-bearing turns →
      harness exits non-zero, writes `hypothesisVerdict: "inconclusive"`, and emits no `ratio`
      field. An implementation that averages over the surviving arm MUST fail this test
- [ ] **Test (e2e demo — MANDATORY):** `npm run bench:lean-worker` on
      `cli-anything/manifests/lean-benchmark.yaml` produces `artifacts/lean-worker-benchmark.json`
      carrying both arms at `n >= 3`, mean first-turn input tokens per arm, `ratio`, `deltaTokens`
      and a `hypothesisVerdict` — recorded and reported whatever the number turns out to be

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
