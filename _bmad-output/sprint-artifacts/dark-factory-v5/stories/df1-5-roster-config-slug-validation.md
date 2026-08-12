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

<!-- Empty placeholder — filled during development. -->
