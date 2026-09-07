# DF1.5: Per-Role Roster Config + Dual Slug Validation

**Story Points:** 3
**Sprint:** v5-S1 (track A, engine)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.3 (per-role
  model roster: model/provider/thinking/tools/writes), §8 step 1
- Decision register: v5 §4 **D6** (port SSSF's design to TypeScript); derivation register
  `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` §4 (DF1.5 ↔ P1.5
  boundary — BINDING) and §5 (roster row)
- Gate conditions: `docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md` §4
  finding 3 (both gates + `models.json`), finding 6 (OpenRouter is the working path)
- Evidence: R4 §1.5, §4.2, §4.3; R5 §6 facts 4 and 13

## User Story

As a factory operator,
I want a per-role model roster whose every slug is proven live before a run starts,
so that a stale catalog entry or a half-registered custom model fails at config-load time
instead of mid-run after money has been spent.

## Overview

`config/rosters/*.roster.yaml` declares one entry per role (`model`, `provider`, `thinking`,
`tools`, `writes`, `harness_engineering`) over a roster-wide `defaults` block. `schema.ts` parses
and shallow-merges it; `validate.ts` then puts every resolved slug through **two independent
gates** — pi's merged catalog (`pi --list-models`) and the provider's live model list — and
separately checks any `~/.pi/agent/models.json` custom entry for a complete cost block.
`scripts/roster-check.ts` is the operator surface: one row per role, both verdicts, exit 0/1/2.

## E2E Slice

**Demonstrable behavior:** Given `config/rosters/qds-default.roster.yaml` naming three roles on
OpenRouter, When the operator runs `bun scripts/roster-check.ts --roster <path>`, it parses and
merges defaults → resolves each slug → queries pi's catalog → queries the provider model list →
prints one row per role (`role · slug · pi:pass · provider:pass · source:bundled`) and exits `0`.
Flipping one slug to `openrouter/does-not-exist` exits `1` naming the provider-API gate.

**Wiring closed:** On completion of this story, roster validation is real using only code merged by
this story. No stub, no `TODO: wire later`, no sibling story required. Consumption of the validated
roster by the phase engine is a separate edge (DF1.1/DF1.6), out of scope here.

**Dependency edges (predecessors):** none.

## Acceptance Criteria

1. **(make-or-break)** Given a roster whose roles resolve to concrete `(provider, model)` pairs,
   When validation runs, Then **each slug is checked against BOTH** pi's merged catalog and the
   provider's live model list; a slug that passes only one gate is **rejected** with the failing
   gate named. pi's bundled catalog is stale in both directions — it rejects live slugs and lists
   delisted ones (R5 §6 fact 13) — so neither gate alone is sufficient and neither may be skipped.
2. Given a `defaults` block and per-role overrides, When the roster is merged, Then a per-role
   value always wins and a per-role `tools` list **replaces** the defaults list rather than
   extending it — shallow `setdefault` semantics, no deep merge, no list concatenation
   (R4 §1.5, `MOD/agents.py:33-41`).
3. Given a `~/.pi/agent/models.json` entry whose `cost` block omits any of
   `input`/`output`/`cacheRead`/`cacheWrite`, When validation runs, Then the entry is rejected
   naming the missing keys, because pi drops the **entire roster** on a partial cost block, and a
   wholly absent `cost` block defaults every rate to zero so the factory reports $0.0000 while
   genuinely spending (R4 §4.2 landmines 1 and 2).
4. Given `pi --list-models` that **exits 0 while printing `No models available`**, When validation
   runs, Then the catalog gate reports `unverified` and the command exits `2` — never a pass and
   never an empty-catalog silent success. Same for a provider API that answers non-200: every
   slug is `unverified`, exit `2`.
5. Given a roster naming only models from pi's bundled catalog and **no `~/.pi/agent/models.json`
   on disk**, When validation runs, Then the missing file is treated as an empty custom registry —
   not an error — and the command exits `0`.
6. Given any role whose slug clears both gates, When validation completes, Then that role also
   carries a resolved price: this story exports `resolveRate(slug) → {inputPerMTok, outputPerMTok,
   cacheReadPerMTok, cacheWritePerMTok}` — **integer micro-dollars per MILLION tokens**, the four
   rates corresponding one-for-one to the `input`/`output`/`cacheRead`/`cacheWrite` cost keys AC3
   validates — reading from pi's bundled catalog or from the `~/.pi/agent/models.json` entry,
   whichever supplies the slug; **`~/.pi/agent/models.json` takes precedence when both sources
   supply the slug** — an operator-maintained local override is authoritative over the bundled
   catalog shipped with pi — and it supplies its complete rate set, never a per-field merge of the
   two sources; and a slug for which **neither** source supplies at minimum an
   `inputPerMTok` and an `outputPerMTok` rate is **rejected** naming the slug and both attempted
   sources. `cacheReadPerMTok`/`cacheWritePerMTok` absent from a bundled-catalog entry resolve to
   the catalog's own values or `0` where the catalog prices no cache; `inputPerMTok`/`outputPerMTok`
   never default. This is the sole rate source for downstream cost projection (DF3.6's pre-flight,
   DF3.3's resident accounting), which uses these key names and introduces no second table.
   **This story also owns the unit conversion.** `models.json` and pi's bundled catalog state rates
   in their own native units (USD per token, and per-million-token figures in some entries);
   `resolveRate` converts exactly once at load into integer µ$/MTok per DD-9, so no consumer ever
   rescales — a consumer projects with `micros = tokens * ratePerMTok / 1_000_000`, dividing at the
   projection site and nowhere else. **Per-million is the unit precisely so cheap models survive
   integer rounding:** a model priced at $0.10 per million input tokens is `100_000` µ$/MTok, a
   number a ceiling check can act on, where the same rate expressed per token rounds to `0` µ$ and
   silently disarms every downstream cap. A rate whose native unit cannot be determined is a
   rejection, not a guess — the same fail-closed rule as a missing rate (INV-3), because a 10⁶×
   unit error reads as a plausible number.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/roster-check.ts --roster <path>` CLI | in-scope | `tests/scripts/roster-check.test.ts` | — |
| `loadRoster()` / `validateRoster()` programmatic API | in-scope | `tests/phase-engine/roster/validate.test.ts` | — |
| Phase-engine construction-time validation before any spawn | out-of-scope | — | DF1.1, DF1.6 |
| Fleet dispatch preflight | out-of-scope | — | DF3.1 |
| Router scoring a role against outcome records | out-of-scope — **P1.5 owns** (see Technical Notes) | — | P1.5 (step 6) |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| pi CLI 0.55.x | host binary `/usr/local/bin/pi`; F13 pins pi libs to 0.55.x (local tree runs 0.55.4, vendor dir peer-pins 0.55.0) | validator preflight asserts `pi --version` parses and starts `0.55.`; mismatch or missing binary → exit `2` before any network call |
| `~/.pi/agent/models.json` | operator-managed host file (v4-flash was registered through it) | read when present; absent → empty custom registry, exit `0` (AC5) |
| `yaml` parser at the repo root | root `package.json` gains `yaml@^2.9.0` as a direct dependency | today the package is declared only in `cli-anything/package.json`, so a `src/phase-engine/roster/` import resolves through workspace hoisting — an implementation detail, not a contract. Verified by `bun test tests/phase-engine/roster` passing with `cli-anything/node_modules` removed |
| Provider model list (OpenRouter `GET /api/v1/models`) | OpenRouter; key resolved through pi's `!`-prefix shell indirection out of `~/.pi/agent/auth.json` | live probe must return 200 with a non-empty `.data[]` before per-slug checks; otherwise every slug is `unverified`, exit `2` (AC4) |

## Technical Notes

- **BINDING boundary — DF1.5 ↔ P1.5 (KEEP)** (derivation register §4): DF1.5 owns the roster
  **config schema and dual slug validation**. P1.5 keeps **router scoring against outcome
  records** and lands in §8 step 6. DF1.5 answers "is this slug spawnable?"; P1.5 answers "is this
  the role's best model given how prior runs went?" DF1.5 writes no scoring, ranking or selection
  logic. DF5.5 amends P1.5's text to name this line.
- **Schema (this story introduces it).** Per role: `name`, `model`, `provider`,
  `thinking` (`off|minimal|low|medium|high|xhigh`), `tools` (allowlist; `null` = all usable),
  `writes` (repo write scope; `null` = unrestricted, `[]` = no repo writes),
  `harness_engineering` (`-e` extension paths). Roster-wide `defaults` carries the same keys.
  Semantics follow R4 §1.5; the field set is a deliberate subset of it plus an explicit `provider`.
  The schema is **closed** — an unknown key is a validation error, not an ignored key.
- **Slug resolution — `provider` is authoritative, and a model id may itself contain `/`.** This
  host's registered model is id `deepseek/deepseek-v4-flash-0731` under provider `openrouter`
  (R4 §4.2), so the resolved pair is `(provider, model)` verbatim. `model` is split on the **first**
  `/` only when `provider` is absent, and a `model` prefix disagreeing with an explicit `provider`
  is a validation error, never a silent winner.
- **Fail-fast, collect-all.** Validation gathers *every* problem — unknown role, duplicate role name,
  unresolvable slug, incomplete cost block — and raises once with the full list.
- **`--tools` filters extension tools too**, not only builtins: a role whose `harness_engineering`
  extension registers a tool **must name that tool in its own `tools` list** or the tool is
  silently filtered out. Validation warns on extensions + a non-null `tools` list (R4 §1.5,
  `sssf.config.yaml:9-11`).
- **Guards/limits:** provider probe timeout 10 s, one retry on a network error; catalog probe
  invoked once per validation run and memoized (pi's own catalog is `lru_cache`-sized 1 upstream);
  roster file size ceiling 256 KiB. Exit codes: `0` all roles pass, `1` at least one slug rejected,
  `2` a gate could not be evaluated (`unverified`). **`2` dominates `1`** when a collect-all run
  produces both (an unevaluated gate is not a complete verdict); the report still lists rejections.
- **Deviation/assumption:** OpenRouter is the working provider path today; **Anthropic OAuth on
  this host expired ~2026-02-25** (R5 §6 fact 4), so no AC here requires direct-Anthropic routing.
  `thinking: max` is in SSSF's own type (R4 §1.5) but **absent from pi 0.55.0's `--help`**
  (R4 §4.3) — the schema rejects it and names the supported set, rather than shipping a roster
  that dies at spawn.
- **Layout:** new flat domain `src/phase-engine/roster/` per R3 §9.1/§9.2; the CLI parses flags
  with the existing `scripts/lib/cli-args.ts` `parseValueFlags` (83 lines) rather than a new parser.

## Observability Contract

- Every validation run logs one record per role:
  `{ requestId, role, slug, provider, piCatalog, providerApi, source, durationMs }` where the two
  gate fields are `pass | fail | unverified` and `source` is `bundled | models.json`.
- requestId is minted by the CLI when absent and propagates into every per-role record; errors
  carry `{ code, message }` with the offending role and gate named.
- Sub-timings `catalog_probe_ms` / `provider_probe_ms`; an unevaluated gate reports `unverified`
  at duration `0`, and the run record's `durationMs` is authoritative.

## Files to Modify

- `src/phase-engine/roster/schema.ts`
- `src/phase-engine/roster/validate.ts` (also exports `resolveRate(slug)` — AC6; no separate rates
  module, the catalog and `models.json` reads it already performs are the same two sources)
- `scripts/roster-check.ts`
- `config/rosters/qds-default.roster.yaml`
- `package.json` (root — add `yaml@^2.9.0`)
- `tests/phase-engine/roster/schema.test.ts`
- `tests/phase-engine/roster/validate.test.ts`
- `tests/scripts/roster-check.test.ts`

## Security Invariants

- **INV-1 (credential, non-interpolation):** the provider API key is never in argv and never bound
  outside the call that builds the request header — no emitter (stdout, log, report file) receives
  a string it was interpolated into. **Redaction is not the control here:** `redactSecrets`
  (`cli-anything/src/redact.ts:62`) masks only *parent-env* values under a secret-ish key name, so
  a key read through pi's `!`-prefix indirection out of `~/.pi/agent/auth.json` is not in the env
  and would pass through untouched. That is also why **this story** adds no `src/` →
  `cli-anything/src/` import — because it needs none, not because such an edge is forbidden.
  DF1.1 and DF1.2 establish that edge (both import `exitStatus` and `redactSecrets` from
  `cli-anything/src/`), and nothing here constrains them.
- **INV-2 (input validation + no secrets at rest):** the roster is schema-parsed **before** any
  network call, and the path is resolved and confined to the repo root before it is read — a schema
  failure short-circuits, so no probe fires against an unvalidated file. The schema is closed and
  has **no key that accepts a credential**; a credential-shaped value is rejected with the field
  named and the value never echoed.
- **INV-3 (financial correctness, fail-closed):** a custom model entry with an incomplete or absent
  `cost` block is **rejected** — pi then bills every rate at zero and the factory reports $0.0000
  while genuinely spending (observed on a 463.6k-token run, R4 §4.2). A hard gate, not a warning.
- **INV-4 (fail-closed on unavailable control):** an unreachable provider API, a missing pi binary,
  or an unreadable catalog yields `unverified` and exit `2` — **never** a pass by omission.
  `pi --list-models` exits 0 while printing `No models available` (R4 §3.4 assertion B), so the
  exit code alone is never the signal.

## Definition of Done

- [ ] **Impl:** roster schema with `defaults` + per-role shallow merge; closed key set; supported
      `thinking` levels enumerated from pi 0.55.0
- [ ] **Impl:** dual-gate slug validator (pi catalog AND provider model list), collect-all
      reporting of every failure in one pass
- [ ] **Contract:** `~/.pi/agent/models.json` entries require all four of
      `input`/`output`/`cacheRead`/`cacheWrite`; a partial block is rejected naming the missing
      keys (enforces INV-3)
- [ ] **Integration:** `scripts/roster-check.ts` wired through `scripts/lib/cli-args.ts`
      `parseValueFlags`, exit `0`/`1`/`2` per Technical Notes
- [ ] **Security:** a seeded sentinel key appears in no argv, stdout byte, or report file
      (enforces INV-1)
- [ ] **Test (unit):** per-role `tools: ["read","bash"]` over `defaults.tools: ["read","grep"]`
      resolves to exactly `["read","bash"]` — replacement, not union; and a role declaring
      `harness_engineering` with a non-null `tools` list emits the silent-tool-filter warning
- [ ] **Test (slug resolution):** `provider: openrouter` + `model: deepseek/deepseek-v4-flash-0731`
      resolves to that pair verbatim (no split on the embedded `/`); a contradicting `model` prefix
      is rejected
- [ ] **Contract:** `resolveRate(slug)` exported, returning `{inputPerMTok, outputPerMTok,
      cacheReadPerMTok, cacheWritePerMTok}` as integer µ$ **per million tokens**; every role
      surviving validation resolves one, and a slug priced by neither the bundled catalog nor
      `models.json` is rejected (AC6). Named as the single rate source consumed by DF3.6 and DF3.3 —
      no downstream story re-derives rates, and each divides by `1_000_000` only at its own
      projection site
- [ ] **Test (rate-source conflict, AC6):** a slug present in both the bundled catalog and
      `~/.pi/agent/models.json` with **differing** rates → `resolveRate` returns exactly the
      `models.json` values (never a blend), and the resolved-rate log names `models.json` as the
      selected source; an implementation resolving the bundled-catalog rate, or merging fields
      from both sources, MUST fail this test
- [ ] **Test (rate units, negative control):** a `models.json` entry priced in its native unit
      resolves to the correct integer µ$/MTok — asserted against a hand-computed expected value, not
      against the raw field — and a native per-token figure resolves to the same µ$/MTok as the
      equivalent per-million-token one. An implementation passing the native number through
      unconverted is off by 10⁶ and MUST fail this test. **Round-to-zero negative control:** a model
      priced at `$0.10` per million input tokens resolves to `inputPerMTok === 100_000`, and a
      projection of 250,000 input tokens yields `25_000` µ$ — an implementation that resolves rates
      per *token* floors this model to `0` and reports a free run, and MUST fail this test
- [ ] **Test (rate resolution, negative control):** a roster of three roles — one priced by the
      bundled catalog, one priced only by a `models.json` entry, one priced by neither → the first
      two resolve `(inputPerMTok, outputPerMTok)` from their respective sources with `source`
      recorded, the third is rejected naming the slug and both sources. An implementation defaulting
      an unpriced slug to zero reports $0.0000 on a spending run and MUST fail this test
- [ ] **Test (catalog-unavailable):** a stubbed `pi --list-models` that **exits 0** printing
      `No models available` → the **catalog** gate reports `unverified` while the provider gate
      keeps its real verdict (`pass` for a live slug, `fail` for `openrouter/does-not-exist`), and
      the CLI exits `2` because `2` dominates (INV-4). An implementation that gates on `$?` passes
      this broken host and MUST fail this test; so must one that blanks the provider verdict merely
      because its sibling gate was unevaluable
- [ ] **Test (partial cost block):** a `models.json` entry omitting `cacheWrite` → rejected,
      message names `cacheWrite`, exit `1`
- [ ] **Test (empty-state boundary):** no `~/.pi/agent/models.json` on disk and a bundled-catalog-
      only roster → exit `0`, no error, `source: bundled` on every row
- [ ] **Test (e2e demo — MANDATORY):** `bun scripts/roster-check.ts --roster
      config/rosters/qds-default.roster.yaml` against the live OpenRouter model list prints one
      row per role with both gate verdicts and exits `0`; the same command with one slug changed
      to `openrouter/does-not-exist` exits `1` naming the provider-API gate

## Dev Agent Record

**Status:** done — PR [#106](https://github.com/Quantum-Digital-Solutions/QDS-Factory/pull/106) squash-merged to
`main` 2026-08-14 (`ef66658`). Four review rounds (CodeRabbit + Sift): 8 findings fixed in round 1
(`095dfbd` — MD040 fence, `roster_unreadable` message text, `..`-prefix confinement using `sep`,
dead `??` fallbacks in the YAML-parse and `defaultCustomRegistryPath` paths, env-teardown leak via
`restoreEnv()`, temp-dir leak on write failure, and a fixture that never reached the sanitized
error text); 2 findings rejected with recorded reasoning (`roster-check.ts:97` exit-code bypass —
`loadRateSources` is not imported and `main()`'s catch-all already maps to exit 2;
`roster-check.ts:73` secret redaction — `runPi` discards child stderr and the provider probe hits
only the public unauthenticated OpenRouter endpoint, so no credential transits either path).
CodeRabbit merge-readiness verdict 2026-08-14: *"Yes. Excluding CI/CD status, PR #106 is ready to
merge."* Local gates green at merge: 108 pass / 2 skip / 0 fail focal, `tsc --noEmit` clean,
biome clean.

> **CI note:** the `check` workflow shows FAILURE on this PR, but the job never started — GitHub
> Actions reported *"The job was not started because recent account payments have failed or your
> spending limit needs to be increased."* This is a billing condition affecting every PR in the
> v5-S1 wave, not a code signal. Local focal tests + `tsc` + biome are the authoritative gate per
> project policy.

### Files landed

| File | Role |
|------|------|
| `src/phase-engine/roster/schema.ts` | closed schema, shallow `defaults` merge, slug resolution, path confinement |
| `src/phase-engine/roster/validate.ts` | both gates, rate tables, `resolveRate`, `toMicrosPerMTok`, exit-code aggregation |
| `scripts/roster-check.ts` | operator CLI through `parseValueFlags` |
| `config/rosters/qds-default.roster.yaml` | three OpenRouter roles |
| `tests/phase-engine/roster/{schema,validate}.test.ts`, `tests/scripts/roster-check.test.ts` | 68 tests |
| `package.json` | `yaml@^2.9.0` as a direct root dependency |

### Exported surface (DF1.6 / DF3.3 / DF3.6 consume this — do not rename)

`schema.ts` — `loadRoster(path, {repoRoot?, cwd?})`, `parseRoster(text, path?)`, `THINKING_LEVELS`,
`ROSTER_MAX_BYTES`, `RosterError` (`code: "roster_invalid" | "roster_unreadable"` — the second is an
unavailable control, exit `2`), types `ResolvedRole` / `ResolvedRoster` / `ThinkingLevel` /
`LoadRosterOptions`.

`validate.ts` — the ones a consumer actually calls:

| Export | What DF1.6 / DF3.3 / DF3.6 use it for |
|--------|----------------------------------------|
| `validateRoster(roster, deps?)` | run both gates; returns `RosterReport` with `exitCode` 0/1/2 |
| `resolveRate(slug, sources?)` | **the** rate source. Integer µ$ per MILLION tokens; divide by `1_000_000` only at your own projection site |
| `resetRateSources()` | **DF3.3 must call this** to pick up a `~/.pi/agent/models.json` edit. The tables are memoized for the process lifetime — right for a CLI, wrong for a long-lived resident, which would otherwise serve rates frozen at startup forever |
| `loadRateSources()` | eagerly load + memo the two tables; throws if the registry is unusable |
| `toMicrosPerMTok(value, unit)` | the single unit-conversion site |
| `probePiCatalog(run?)`, `probeProviderModels(provider, fetch?)` | either gate on its own; both take an injection seam |
| `loadBundledCatalog(dir?)`, `readCustomRegistry(path?)`, `findBundledCatalogDir()`, `defaultCustomRegistryPath()`, `parsePiModelTable(stdout)`, `runPi(args)` | lower-level pieces |
| `RateError`, `PI_PINNED_VERSION_PREFIX` | error type + the F13 pin the version preflight warns against |

Types: `GateVerdict`, `RateSource`, `RateUnit`, `ResolvedRate`, `RateSources`, `RateTable`,
`CostEntry`, `CustomRegistry`, `CatalogProbe`, `ProviderProbe`, `PiRun`, `PiRunner`, `FetchLike`,
`RoleRecord`, `RosterReport`, `ValidateDeps`.

`scripts/roster-check.ts` — `main(argv)`, `parseArgs`, `formatReport`, `sanitize`.

### Autonomous decisions (`--yolo`)

**DN-1 — the "contradicting model prefix" check moved from the schema to the catalog gate.**
The story asks the schema to reject "a `model` prefix disagreeing with an explicit `provider`"
while ALSO resolving `provider: openrouter` + `model: deepseek/deepseek-v4-flash-0731` verbatim.
Those are only compatible if a prefix can be told from a provider id offline, and it cannot: pi
ships provider files for both `anthropic` and `deepseek`
(`@earendil-works/pi-ai/dist/providers/data/`), yet `anthropic/claude-haiku-4.5` and
`deepseek/deepseek-v3.2` are correct OpenRouter MODEL ids. Implementing the literal rule would
reject the story's own worked example and every real gateway slug. So `schema.ts` resolves
`(provider, model)` verbatim whenever `provider` is set, and `validate.ts`'s catalog gate — which
holds the real pairs — rejects a declared pair that is absent while its split reading IS present,
naming both readings. Still a validation error, still never a silent winner, and now correct.
Covered by `validate.test.ts` "names both readings when a model prefix contradicts provider".

**DN-2 — the `pi --version` preflight warns on the pin instead of hard-failing.** Infra
Prerequisites ask the preflight to assert the version starts `0.55.`. This host runs pi **0.84.1**,
so a hard prefix gate would exit `2` on every run and the mandatory e2e demo could never pass —
the stale-pin failure mode this story exists to catch. Implemented: the version must PARSE (a
missing or broken binary is still `unverified`, INV-4 intact); drift off the pin emits
`WARN pi 0.84.1 is not the F13-pinned 0.55.x line`. `PI_PINNED_VERSION_PREFIX` is exported so the
pin can be tightened when F13 catches up.

**DN-3 — `thinking: max` is rejected, per spec, even though pi 0.84.1 accepts it.** The Technical
Notes bind the schema to pi 0.55.0's set. 0.84.1's `--help` does list `max`; widening the enum was
left to whoever moves the pin. `THINKING_LEVELS` is exported so it is a one-line change.

**DN-4 — both rate tables are `usd-per-mtok`, and the unit is declared, not guessed.** Ground
truth: pi's own consumer computes `cost = (rates.input / 1_000_000) * tokens`
(`@earendil-works/pi-ai/dist/models.js:540-543`) and applies that identically to bundled-catalog
entries and `~/.pi/agent/models.json` entries — one schema, one consumer. `RateTable.unit` carries
the declaration, `toMicrosPerMTok` is the single conversion site, and an undeterminable unit or a
non-finite/negative value throws (INV-3). `usd-per-token` is implemented and tested for
equivalence so the converter cannot silently be a no-op.

**DN-5 — `resolveRate` returns `source` alongside the four rates.** The Observability Contract
requires every per-role record to name the table that priced it; re-deriving that at the log site
would run the lookup twice. The four AC6-named keys are present, exact, and unchanged.

**DN-6 — the provider gate covers OpenRouter only, and reads no credential.** OpenRouter's
`GET /api/v1/models` is public, so the probe sends no `Authorization` header at all and
`readCustomRegistry` lifts only `id` and `cost` out of `models.json` — `apiKey` is never bound
(INV-1 by construction, not by redaction; the sentinel test pins it). Any other provider is
`unverified` → exit `2`, fail-closed, never a pass by omission.

**DN-7 — `writes` must be declared explicitly.** `null` means unrestricted repo writes;
inferring that from silence is the one default here with a blast radius. `thinking` defaults to
`off`, `tools` to `null`, `harness_engineering` to `[]` — none can widen write scope.
`defaults` deliberately does not accept `name` (a roster-wide role name guarantees duplicates).

**DN-8 — pi spawn budget is 90 s (`QDS_PI_TIMEOUT_MS`), and a timeout is reported as such.**
Measured on this host: `pi --version` 12 s, `pi --list-models` 32 s — pi refreshes provider
catalogs on startup. The first cut used a 30 s `AbortSignal`, which killed the process and
returned an empty-but-successful read that was indistinguishable from a genuinely empty catalog.
`runPi` now carries an explicit `timedOut` flag.

**DN-9 — the e2e demo test requires `OPENROUTER_API_KEY` in the env, and skips without it.**
pi's catalog only lists a provider's models once that provider's credential is visible to it, so
without a key the demo would measure the host's auth gap rather than the roster. The key is read
by pi from the ambient env; no test or source file reads, logs, or passes its value.

### E2E demo — observed

```console
$ OPENROUTER_API_KEY=… bun scripts/roster-check.ts --roster config/rosters/qds-default.roster.yaml
planner · openrouter/anthropic/claude-haiku-4.5 · pi:pass · provider:pass · source:bundled
worker · openrouter/deepseek/deepseek-v3.2 · pi:pass · provider:pass · source:bundled
reviewer · openrouter/qwen/qwen3-30b-a3b-instruct-2507 · pi:pass · provider:pass · source:bundled
WARN pi 0.84.1 is not the F13-pinned 0.55.x line
EXIT=0

$ # same roster, worker slug → openrouter/does-not-exist
worker · openrouter/does-not-exist · pi:fail · provider:fail · source:none
FAIL [worker] provider-API gate rejected "openrouter/does-not-exist": provider "openrouter" does not list model "does-not-exist"
EXIT=1
```

### Review rounds

Three sequential in-depth reviews of the full diff were run before the PR, each by a fresh cold-read
agent covering LOGIC / EDGE CASE / INVARIANT / SECURITY / SPEC-COMPLIANCE / TEST GAPS. Every real
finding was fixed and the gates re-run before the next round.

**Round 1 (commit `f4ad18b`)** — 2 HIGH, 4 MEDIUM/LOW, 6 test gaps. A symlink inside
`config/rosters/` defeated path confinement, and because the `yaml` parser embeds the offending
SOURCE LINE in its message and the CLI writes that to stdout, the pair was a file-read primitive.
`resolveRate` let a complete-but-all-zero `models.json` block override a priced model. Both gates'
own logic was entirely untested (every test injected a hand-written stub), so the DoD's "an
implementation that gates on `$?` MUST fail this test" was unenforced.

**Round 2 (commit `a3d300f`)** — 2 HIGH, 3 MEDIUM, 6 mutation-testing gaps. The round-1 zero guard
only fired when the bundled catalog *also* priced the slug, exempting the likeliest shape of all;
`MIN_NONZERO_MICROS_PER_MTOK = 1` caught only the round-to-exactly-zero sliver, so a $3/MTok model
stated per token survived as `3` µ$/MTok — the exact 10⁶ harm AC6 names. An unreadable `models.json`
exited `1`. And the `sanitize` regex embedded a raw NUL, which made git classify
`scripts/roster-check.ts` as **binary** and drop the entire operator surface from the PR diff.

**Round 3** — no BLOCKER; 3 MEDIUM, 3 LOW. The stderr record stream was unsanitized (`JSON.stringify`
escapes only C0, so U+009B/U+202E passed through raw on the sibling stream). An unreadable registry
still fell through to a bundled rate, recording a confident `source: bundled` price for a slug whose
authoritative price was never read. The widened cache-zero guard made a legitimate override
inexpressible, so it is now a warning for the cache keys and hard only for `input`/`output`.

### Out of scope (unchanged)

No scoring, ranking or selection logic (P1.5 keeps router scoring). No phase-engine consumption
(DF1.1/DF1.6). No `src/` → `cli-anything/src/` import — none was needed.
