# J1: JudgmentProvider Seam — the Adapter Boundary the Judgment Tier Already Obeyed

**Story Points:** 3
**Sprint:** v6a (Foundation, Wave 1 — one of the four zero-gate roots; the story that makes D-4's "future jev-like tier-1 systems swap in" a named seam instead of a hope)
**Status:** in-review (PR open; all DoD items met — live round fired 2026-10-09)

## Spec Reference

- **Charter** `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` — v6a table J1 row (:81, "mock + Jev-live probe" live tier, no deps); **D-4** (:18, adapter seam, typed ask, neutral-layer policy, "formalize, don't invent"); **D-5** (:19, LOCKED #3 superseded-refined); §2.3 ten-levels mapping (:55 — L4 arming and L5 routing are later consumers of THIS seam, which is why it lands first).
- **DD register (same PR):** `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md` **DD-21** — LOCKED #3 superseded-refined ("still no SDK, now behind the named seam"); L6 parked (host-side-placement conflict). This story implements DD-21's seam half; J2 implements its arming half.
- **Jev handoff** `_bmad-output/typesafe-integration/handoff.md` — §3 LOCKED #1/#2/#4–#12 hold **verbatim** (D-5 amends only #3's mechanism); §4 vendor facts binding; §8 guardrails verbatim.
- **Ancestry (merged, consumed unchanged):** JEV-1 (`_bmad-output/typesafe-integration/stories/jev-1-corpus-capture.md`) and JEV-2 (`…/jev-2-judgment-core.md`) built the modules this story re-arranges. Their ADR 0001 (`_bmad-output/typesafe-integration/adr/0001-egress-max-class-code-pinned.md`, ACCEPTED) is why `DEFAULT_MAX_EGRESS_CLASS` stays code-pinned — this story does not reopen it.
- **Seam half-exists (the formalization target):** `src/judgment/client.ts:98-279 (JudgmentClient)` — `judge()` (:133-223) already runs choke → ceiling → request → strict parse → envelope → emit for both modes; `mockResponse` (:286-315, `mockResponse()`) already short-circuits **the network only, never validation** (:164-171, the mock ternary + shared strict parse inside `judge()`). That mock leg is the adapter template; this story extracts the transport step (`post()`, :231-278) and pins the boundary, changing no behavior.

## User Story

As the operator who wants a second judgment vendor without re-proving the judgment tier,
I want the transport behind `judge()` to be a named, closed-registry `JudgmentProvider` seam with the egress/ceiling/envelope policy living at the seam,
so that a future jev-like tier-1 system is a code change plus contract-suite membership — never a fork of the policy.

## Overview

Extract the one pluggable step of `JudgmentClient.judge()` — **transport: `JudgmentRequest → raw response body`** — into a `JudgmentProvider` interface behind a **closed registry** seeded with exactly two adapter makers: `jev` (the moved `post()`, pinned `jev-1.13.0` over `src/lib/http.ts`) and `mock` (the moved `mockResponse`). Everything else stays in the seam client, which is the only place the neutral-layer policy runs: egress choke, stage ceiling admit/record, strict `makeJudgmentResponseSchema` parse, envelope build, provenance emit. An adapter cannot redact, cannot validate, cannot reach the wire *as a judgment* without having passed through the seam.

**What this does NOT deliver:** no new provider (the registry closes at two; D-4's "future systems swap in" is the seam, not a swap today); no stage-2 diff-hunk unlock (ZDR-gated, untouched); no config knob for the max egress class (ADR 0001 pins it in code); no SDK (package.json untouched — D-5); no in-box judgment calls (LOCKED #1 host-side placement); no open runtime plugin API (Technical Notes).

## E2E Slice

**Demonstrable behavior:** Given the merged judgment tier, When `bun test tests/judgment/` runs, Then one parameterized suite exercises **every registered adapter** through the same seam path — `judge(state, questions, {egressClass, ceiling})` → `JudgmentEnvelope{requestId, model: "jev-1.13.0", questions, answers, usage, latency_ms, egress_class, created_at}` — and a rogue transport returning garbage (wrong model literal, boolean `noul`, answer to an unasked id) is refused by the seam's strict parse with **no envelope and no provenance emit**, for every adapter including mock. Registry resolution is observable: `resolveProvider("jev")` and `resolveProvider("mock")` return the two registered adapter makers (the client constructs its mode's adapter from its own unchanged options); any other id refuses.

**Wiring closed:** On completion, both `scripts/judgment/observe-round.ts` (S1 observer) and `scripts/judgment/live-probe.ts` reach the wire (or the canned body) through the registry-resolved adapter, using only code merged by this story plus the landed judgment core. **No stub, no `TODO: wire later`.** `observe-round.ts` and `ab-report.ts` are unmodified — the recording-only posture (handoff §3.5) is untouched.

**Dependency edges (predecessors):** none in-table (v6a root; Wave 1 with Z1/G1/M2.1-dev). The landed JEV-1/JEV-2/JEV-3/JEV-4 substrate is a merged ancestor, not a sprint edge.

> **Not an edge — J2:** arming consumes corpus records and `computeReport`, not this seam's code. The J1→J2 edge is program ordering (DD-21: routing authority exists only over a seam-pinned judgment path), recorded there, not imported here.

## Acceptance Criteria

1. **(make-or-break — policy lives at the seam, not per-adapter)** Given the seam, When any registered adapter serves a response, Then the egress choke, ceiling admit/record, strict parse, envelope build and provenance emit ran in the seam client — asserted behaviorally: an adapter fed a body violating `makeJudgmentResponseSchema` produces no envelope and no side-channel file; structurally: `JudgmentProvider` exposes **only** `{ id, ask(request, requestId) }` — one method; no egress, ceiling, redaction or validation member exists on the interface, and the choke/ceiling/emit calls remain in `client.ts` ahead of every `ask()`. *Negative control: an adapter implementation that performs its own request-build, redaction or schema validation — shipping state without the choke, or accepting a body the seam never parsed — MUST fail this one.*
2. **The registry is closed and seeded with exactly two adapters.** `jev` (live transport: env-only `TYPESAFE_API_KEY` read once at client construction and handed only to this adapter's maker, per-instance `baseUrl`/`timeoutMs`/`retryDelayMs` bound from the client's **unchanged** options, `POST {baseUrl}/v1/systemone`, maxAttempts 2, retry 429/529 only, 401/422 fatal — the moved `post()` verbatim, including the `x-request-id` header and the `requestId` carried in every `JudgmentHttpError`) and `mock` (the moved `mockResponse`). Mode resolution order is preserved exactly (`TYPESAFE_MOCK === "1"` forces mock → constructor `mode` → default mock, INV-J5); unknown provider ids refuse. *Negative control: a runtime `registerProvider()` API or any registry mutation path outside the module's own constant MUST fail — extension is a code change plus contract-suite membership, the verbs.ts/`AUDIT_HOPS`/`EGRESS_CLASSES` idiom.*
3. **The drift alarm stays THE alarm.** `TYPESAFE_MODEL = "jev-1.13.0"` (`src/judgment/schemas.ts:21`) remains the single model literal; envelope and response schema literals are unchanged; `tests/judgment/typesafe-api-contract.json` remains the pin; `tests/judgment/contract.test.ts` gains a grep test asserting **no second model literal exists anywhere under `src/judgment/`** and that every registered adapter builds its request `model` through `TYPESAFE_MODEL`. *Negative control: a new model constant (e.g. a `jev-2` literal) wired into an adapter but not into the contract json MUST fail the suite by name.*
4. **One contract suite, run against every adapter.** Parameterized over the registry, for each adapter: the raw body passes `makeJudgmentResponseSchema(Object.keys(questions))`; `answers ⊆` asked ids holds; usage keys match the contract json; mock's canned bodies validate against the **same** schema live bodies must satisfy. *Negative control: mock diverging from jev contract behavior — a boolean `noul` (the 2026-09-22 live-probe drift catch, commit `c82ede44`), an unasked answer id, a missing usage key — MUST fail the same suite.*
5. **The fence and the layer graph survive the extraction.** `tests/judgment/fence.test.ts` (INV-J4 two-import fence) walks `src/judgment/` **recursively** — `adapters/` included — and stays green: adapters import only `../../lib/http.ts`-equivalents, `swarmclaw/log`, zod, and their own siblings. Zero new dependencies (D-5: still no SDK). `src/providers/` is untouched (R3 §9.2 layer rule).
6. **The Jev-live probe proves the adapter against the real endpoint.** `scripts/judgment/live-probe.ts` resolves `jev` **through the registry** (never a direct adapter import), keeps the INV-J5 double gate (`TYPESAFE_API_KEY` non-empty AND `QDS_LIVE_PROBE_CONFIRMED=1`, refused otherwise before any request), sends the one canonical machine-state request, diffs against the contract json, exits 2 naming drift. No offline test touches the network; mock stays the default everywhere (INV-J5). *Negative control: a probe path that bypasses the registry for a hand-constructed transport MUST fail; a probe that fires without the confirm env MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| `judge()` via the `mock` adapter (default) | in-scope | `tests/judgment/adapter-contract.test.ts` | — |
| `judge()` via the `jev` adapter (live, gated) | in-scope | `scripts/judgment/live-probe.ts` + evidence JSON | — |
| per-adapter contract suite membership | in-scope | `tests/judgment/adapter-contract.test.ts` | — |
| registering a future jev-like tier-1 provider | out-of-scope — the seam is the deliverable; the swap-in is a future code change + suite membership (D-4 names no second system) | — | first real tier-2 candidate |
| stage-2 `diff-hunk` egress / config-selected max class | out-of-scope — ZDR-gated (LOCKED #7) and code-pinned (ADR 0001); unchanged here | — | ZDR addendum work stream |
| in-box judgment calls | out-of-scope — LOCKED #1 host-side placement | — | L6 parked, DD-21 |
| SDK adoption | out-of-scope — D-5: still no SDK behind the seam | — | none |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| judgment core (client/schemas/egress/ceiling/emit/envelope) | `src/judgment/` (JEV-2, merged) | `bun test tests/judgment/` green before this story starts |
| corpus capture + observer | `scripts/corpus/`, `scripts/judgment/observe-round.ts` (JEV-1/JEV-3, merged) | `bun test tests/scripts/corpus/ tests/judgment/` green before and byte-identical after for `observe-round.ts` |

> No box, no LLM key and no TypeSafe spend are prerequisites of this story: everything above runs keyless in mock (INV-J5). The live probe is a single operator-gated round at the end.

## Technical Notes

- **Formalize, don't invent (D-4's own wording).** The interface is extracted from behavior that already exists and is already tested; today's `client.test.ts` suite is expected green with **additive-only** edits. If the extraction needs a behavior change to pass, the extraction is wrong.
- **The boundary shape is fixed by what the move must preserve.** Registry entries are adapter **makers** keyed by id (still a module-level closed constant — closure semantics unchanged): the client's constructor builds the mode's adapter from its existing options, so the per-instance `baseUrl`/`timeoutMs`/`retryDelayMs` overrides survive unchanged and `client.test.ts`'s no-wall-clock backoff tests stay green. `ask` takes the seam-minted `requestId` as its second argument — the moved `post()` puts it on the wire (`x-request-id`) and in every `JudgmentHttpError`, so an `ask(request)`-only signature would silently drop the correlation between wire call, envelope, side channel and house log. The key is read once (client constructor, INV-J1 unchanged) and passed only into the jev maker; the mock maker takes no config at all, which makes "no key path" a type fact, not a convention.
- **Rogue-transport negative controls have one legal injection path.** Garbage bodies reach the seam's strict parse only through the registered `jev` transport against a stubbed `baseUrl` (the existing `client.test.ts` mechanism); `mock` divergence (AC4) is caught by validating its canned bodies against the live schema inside the shared suite. There is deliberately **no test-only registry injection and no `registerProvider()`** — closure stays absolute, so every rogue case runs the same seam path the positive cases do.
- **Considered and rejected: an open `registerProvider()` runtime API.** It would let any caller add a transport that no contract test has ever run — the exact hole the per-adapter suite exists to close. Closed registry + membership test is the repo's own pattern (`verbs.ts` closed registry, frozen `AUDIT_HOPS`, `EGRESS_CLASSES`). Revisit only if a third adapter arrives with a real plugin need, as a new D-number.
- **Considered and rejected: a provider-mapped question schema.** Today's `Question` discriminated union is vendor-neutral in practice; mapping layers are untestable until a real second wire shape exists. The adapter receives `JudgmentRequest` verbatim and may translate internally.
- **Guards/limits:** all inherited, none minted — `DEFAULT_MAX_EGRESS_CLASS = "ac-prose"` (ADR 0001), `DEFAULT_STAGE_CEILING_INPUT_TOKENS = 1_000_000`, `DEFAULT_MAX_ATTEMPTS = 2`, `JUDGE_TIMEOUT_MS = 30_000`. The adapter interface adds no knobs because the policy is not the adapter's.
- **All other LOCKED decisions hold verbatim (D-5):** host-side placement; infrastructure-tier budget with the stage ceiling (the monthly bill alarm stays outside the repo, steve-owned in the vendor console); frozen `AUDIT_HOPS` + digest-stable side-channel detail; recording-only until measured; pinned model, never `jev-latest`; staged egress with ZDR-gated stage-2; no severity calibration; S1 is a pre-router; corpus capture first; A/B table behind every claim.
- **Region ownership:** `egress.ts`, `ceiling.ts`, `envelope.ts`, `emit.ts`, `schemas.ts` are the neutral layer — **byte-identical after** (zero-diff DoD item). `client.ts` loses its `post()` and `mockResponse` and gains registry resolution; its public surface (`JudgmentClient`, options, exports) is unchanged, so `observe-round.ts` compiles untouched.

## Observability Contract

- The house log line keeps its shape (`operation: "judge"`, `model`, `egressClass`, `status`) and gains one additive field: `provider` ∈ `jev | mock` — so logs distinguish which transport served a judgment without touching the envelope. `requestId` remains the correlation key into the provenance side-channel.
- The envelope is unchanged — `model` stays the vendor-pinned literal for both adapters (mock deliberately validates against the same literal; that identity is the point of the shared suite).
- Errors keep the existing typed codes (`egress_refused`, `ceiling_exceeded`, `http_<status>`, `judge_failed`); a registry refusal is a new typed `unknown-provider` code, refused before any request exists.
- Probe evidence: one timestamped JSON per live round under `_bmad-output/evidence/v6a/j1/` — spend printed before fire (cents-class; the jev-live-r1 precedent was $0.00223), scrubbed per house rules.

## Files to Modify

- `src/judgment/provider.ts` (new — `JudgmentProvider` interface, closed `JUDGMENT_PROVIDERS` registry, `resolveProvider`)
- `src/judgment/adapters/jev.ts` (new — the moved live transport, verbatim semantics)
- `src/judgment/adapters/mock.ts` (new — the moved `mockResponse`, verbatim)
- `src/judgment/client.ts` (refactor — transport extracted to the registry; orchestration and public surface unchanged)
- `src/judgment/index.ts` (adds only — export the provider surface)
- `scripts/judgment/live-probe.ts` (adds only — adapter resolved via registry; gate and drift ritual unchanged)
- `tests/judgment/provider.test.ts` (new — registry closure, resolution, `unknown-provider` refusal)
- `tests/judgment/adapter-contract.test.ts` (new — the parameterized per-adapter suite; the AC1/AC3/AC4 negative controls)
- `tests/judgment/contract.test.ts` (adds only — second-literal grep + registry membership pins)
- `tests/judgment/fence.test.ts` (adds only — recursive walk covering `adapters/`)
- `tests/judgment/probe-gate.test.ts` (adds the AC6 registry/evidence/argv arms; see Dev Agent Record deviations 5–6) — *added at implementation*
- `src/judgment/errors.ts` (new — see Dev Agent Record deviation 2) — *added at implementation*

## Security Invariants

- **INV-J1 (key containment, inherited):** `TYPESAFE_API_KEY` env-only, read once at client construction, never logged, never in an envelope or side-channel detail — and now provably scoped: the `jev` maker alone receives it and the made transport closes over it; the `mock` maker takes no config at all. Rotation is operator-owned (the key lives in the gitignored `.env`; handoff §8 owns containment, no story owns cadence) — unchanged by this story.
- **INV-J2 (egress discipline, inherited verbatim):** closed class list `machine-state | finding-text | ac-prose | diff-hunk`; stage-1 max `ac-prose` code-pinned (ADR 0001); `diff-hunk` hard-refused at the choke until an executed ZDR addendum; `redactSecrets` stays unbanned-but-unused (designed-fresh per-class redaction lives in `egress.ts`, untouched).
- **INV-J3 (provenance digest-stability, inherited):** answer values and confidence never enter the side-channel detail; re-emit divergence stays a typed `DigestDivergenceError`.
- **INV-J4 (two-import fence, extended):** the recursive fence keeps providers/audit/gate structurally unreachable from the judgment core, adapters included.
- **INV-J5 (mock default, spend-gated):** default adapter is mock; live requires key AND `QDS_LIVE_PROBE_CONFIRMED=1`; no real spend without explicit steve go (handoff §8).

## Definition of Done

- [x] **Impl:** registry + two adapters + seam extraction land with `client.ts`'s public surface unchanged and `observe-round.ts`/`ab-report.ts` unmodified (AC1, AC2).
- [x] **Contract:** `TYPESAFE_MODEL` is still the only model literal under `src/judgment/` (grep test), the contract json is untouched, and the drift alarm still fires by name on a planted second literal (AC3).
- [x] **Test (adapter contract):** one suite, parameterized over the registry, covers both adapters; each of the three negative controls (policy bypass, unregistered literal, mock divergence) has a named failing case in the suite (AC1, AC3, AC4).
- [x] **Test (registry closure):** a runtime registration attempt is impossible by construction and asserted impossible by test; `resolveProvider` refuses unknown ids typed (AC2).
- [x] **Security:** `git diff` shows zero changed lines in `egress.ts`, `ceiling.ts`, `envelope.ts`, `emit.ts`, `schemas.ts`; zero new entries in `package.json`; the recursive fence test is green (AC5, INV-J2/J4).
- [x] **Test (probe gate):** probe refuses without key or without `QDS_LIVE_PROBE_CONFIRMED=1` before building any request; the registry path is asserted (AC6).
- [x] **Integration:** `bun test tests/judgment/ tests/scripts/corpus/` green — existing suites pass with additive-only edits, proving behavior-identical extraction.
- [x] **Test (e2e demo — MANDATORY):** one operator-gated Jev-live probe round through the registered `jev` adapter — canonical machine-state call, contract diff clean, spend printed, evidence JSON under `_bmad-output/evidence/v6a/j1/`; offline suite stays keyless-green.

## Dev Agent Record

**Branch:** `feature/j1-judgmentprovider-seam` (qds-dev J1, 2026-10-08). BMad plugin absent on the host → qds-dev ran BMad-off (implementation HITL, TDD pre-check kept); the three review layers (blind hunter / edge-case hunter / acceptance auditor) were run as parallel sub-agents, three rounds before the PR.

**What landed.** `src/judgment/provider.ts` (interface `{ id, ask }`, frozen `JUDGMENT_PROVIDERS` of two makers, `resolveProvider` via `Object.hasOwn`, typed `UnknownProviderError` code `unknown-provider`); `adapters/jev.ts` (the moved `post()`, verbatim semantics) and `adapters/mock.ts` (the moved `mockResponse`, a zero-arg maker); `client.ts` resolves its mode's maker from the registry and keeps the whole neutral-layer policy ahead of the single `ask()`; the judge log line gains `provider`. Neutral layer (`egress/ceiling/envelope/emit/schemas.ts`), `package.json`, `bun.lock`, `observe-round.ts`, `ab-report.ts`, the contract json and `src/providers/` are byte-identical to `dev`; no buildId walk input moved (offline digest identical to `dev`'s).

**Deviations from the spec text (each justified, reviewed in rounds 1–3):**
1. **`index.ts` exports a narrower provider surface than "export the provider surface" implies** — `JUDGMENT_PROVIDER_IDS`, `UnknownProviderError` and the types, never `JUDGMENT_PROVIDERS`/`resolveProvider`. A made adapter's `ask()` skips the egress choke, the ceiling and the strict parse, so the makers stay seam-private. The probe (and `observe-round.ts`, unmodified) reach the wire through the registry inside `JudgmentClient`'s constructor — the E2E Slice's "registry-resolved adapter". Enforced by a repo-wide AST reach test (static/re-export/`import()`/`require()` edges + maker identifiers, resolver-normalized paths), a client-only registry test, and the probe's no-route test.
2. **`src/judgment/errors.ts` (new, not in Files to Modify)** — holds `JudgmentHttpError` (moved, re-exported from `client.ts` as the same class), `JudgmentSchemaError` (a 502 `JudgmentHttpError` subclass for strict-parse / non-JSON bodies) and `UnknownProviderError`. A leaf module, so the seam and the jev adapter share the errors without a `provider.ts ↔ adapters` import cycle.
3. **`JudgmentClient` gains `readonly providerId`** — additive; required by the Observability Contract's `provider` log field and the probe's pre-fire line. `readonly apiKey` stays public (pre-existing surface, unchanged by design).
4. **`client.ts` imports `DEFAULT_MAX_ATTEMPTS` from `adapters/jev.ts`** — a constant re-export so `contract.test.ts`'s existing import from `client.ts` is unchanged; the retry posture lives with the transport that owns it.
5. **`live-probe.ts` is more than "adds only"** — exit codes (gate 1, drift 2, other errors 1), the gate/drift messages and "gate refuses before any request exists" are unchanged and tested. Added: `--evidence-dir` (validated writable before the paid request; one ms+requestId-stamped key-free JSON per round — clean, drift, HTTP/transport error or post-response failure; a failed write dumps the record to stderr without changing the exit code), a pre-fire provider + spend line, a `ProbeOptions.provenanceDir` test seam, and argv validation (refused before the gate). **Drift is now `JudgmentSchemaError` only** — on `dev` any 502 (incl. a DNS failure or an upstream 502) exited 2 as CONTRACT DRIFT; now those are errors (exit 1) and only a body that arrived but is not contract-shaped is drift. Under `TYPESAFE_MOCK=1` the console verdict and evidence say MOCK / `transport: "mock"`, `endpoint: null`.
6. **Two pre-existing `probe-gate.test.ts` lines** now pass a tmp `provenanceDir` — on `dev` they wrote untracked files into the real `_bmad-output/judgment/provenance/`. Behaviour-preserving (the unmodified `dev` probe-gate suite also passes against this branch); `client.test.ts` has zero diff.

**Verification.** `bun test tests/judgment/ tests/scripts/corpus/ tests/scripts/judgment/` green; `bunx tsc --noEmit` 0; `bun run lint` exit 0; a 12-mutant negative-control battery (second model literal, `registerProvider`, mock boolean `noul`, mock missing usage key, adapter redaction import, adapter validation import, interface growth, adapter → `providers/`, probe registry bypass, barrel maker export, adapter dynamic import, literal hidden after a comment opener in a string) — every mutant killed by its named suite; full `bun test` introduces zero failures beyond `origin/dev`'s 34 pre-existing ones; the probe CLI runs as a real process (refuses without confirm; mock run prints MOCK).

**Live round (DoD e2e):** `TYPESAFE_API_KEY=... QDS_LIVE_PROBE_CONFIRMED=1 bun scripts/judgment/live-probe.ts --evidence-dir _bmad-output/evidence/v6a/j1` — operator-gated (handoff §8). **Fired 2026-10-09 14:42Z on operator go** (rebased onto `dev` a3e00f04): provider `jev` registry-resolved, transport live, contract diff **clean**, 1 judgment / 291 input + 21 output tokens, latency 275 ms, requestId `ced1d8eb-072a-4b69-99a2-b2e57440e630` — evidence `_bmad-output/evidence/v6a/j1/live-probe-20261009T144209651Z-ced1d8eb.json`, provenance `_bmad-output/judgment/provenance/ced1d8eb-….json`; key-free (grep-verified).

## Review Findings (post-merge)

*(appended by the review campaign)*

## Re-visit (2026-10-08)

- `src/judgment/client.ts:98-279` → `src/judgment/client.ts:98-279 (JudgmentClient)` — range exact on HEAD (class span; `judge()` at :133-223, `post()` at :231-278); symbol names appended so future drift is greppable.
- `:286-315` (`mockResponse()`) — verified, no change (function start :286, close :315).
- `:164-171` (mock ternary + shared strict parse, inside `judge()`) — verified, no change.
- `src/judgment/schemas.ts:21` (`TYPESAFE_MODEL`) — verified, no change.
- `src/judgment/adapters/` — absent on HEAD, matching the extraction plan (Files to Modify creates it).
