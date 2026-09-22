# JEV-2: `src/judgment/` Core — Typed TypeSafe Client, Mock Mode, Egress Choke Point, Provenance Envelope

**Story Points:** 4
**Sprint:** TypeSafe (Jev) integration Wave 2 — branch `feature/jev-judgment-core` → `dev`
**Source of truth:** `_bmad-output/typesafe-integration/handoff.md` (§3 LOCKED, §4 vendor contract, §7 Wave 1, §8 guardrails)

## Spec Reference

- Handoff §1 mission (S-B), §3.2 (infrastructure-tier budget + stage ceiling), §3.3 (no SDK — `src/lib/http.ts` + zod, mirroring `src/hindsight/client.ts`), §3.4 (side-channel = FALLBACK side JSON log, digest-stable detail), §3.6 (pin `jev-1.13.0`, contract test), §3.7 (typed egress classes; stage-2 hunks HARD-GATED), §3.8 (redaction designed fresh, never reuse `redactSecrets` as-is)
- Handoff §4 vendor facts — endpoint, request/response/error contract, rate limits, 1.13 jaggedness list
- Handoff §11 gate resolution 2 — `src/judgment/` imports ONLY `src/lib/http.ts` + `src/swarmclaw/log.ts`; side-channel emit is the §3.4 FALLBACK (the real side channel needs a banned provider-file edit). The fence binds repo-internal imports; `zod` (external) is obviously allowed.
- Layering: `cap-rejection.ts` header rule (R3 §9.2) — the new module sits beside `src/hindsight/`, above providers. The Wave-3 observer lives under `scripts/` (imports `src/judgment/` + `scripts/corpus/` without tripping this story's two-import fence — the fence binds `src/judgment/` itself, not its callers)
- Sibling: **JEV-1** (corpus schema) — independent; no shared file. **JEV-3** (S1 observer) is the sole Wave-3 consumer of this client

## User Story

As the factory operator,
I want a house-idiom, strictly-typed TypeSafe client that runs every wave green in mock mode with no key and records exactly what it sent and spent,
so that semantic judgment can be wired into review triage without a vendor SDK, without uncontrolled spend, and without trusting an unvalidated response shape.

## Overview

`src/judgment/` (new flat `src/` domain, hindsight-shaped): `client.ts` (a `JudgmentClient` on `httpRequest`/`HttpPolicy` with `mode: "live" | "mock"`), `schemas.ts` (strict zod request/response/error), `egress.ts` (the choke point), `envelope.ts` (provenance type), `ceiling.ts` (stage breaker), `emit.ts` (side-channel). `HindsightClient` (~466 LOC) is the reference for all four idioms this mirrors: zod `safeParse` on every body, canned schema-valid mock bodies validated through the same request path, `log()` line shape, env-only key.

**POST-retry is deliberate and safe here.** The credentials.ts precedent (idempotent-verb-only retries) exists because replaying a non-idempotent write can double-charge or double-create. These POSTs are read-only judgments — the same questions replayed yield the same answers, no server-side state, no charge beyond input tokens already accounted in `usage` — so the client sets `maxAttempts: 2` with `retryOn` limited to **429/529 only** (handoff §4), `retryAfterMs` for the delay. 401/422 are fatal on the first attempt. This divergence from the idempotent-verb default is stated at the call site, not inherited silently.

Mode resolution order: `TYPESAFE_MOCK=1` forces mock (overrides everything) — forced mock applies iff the env value is exactly the string `"1"`; any other value, including `"0"`, is ignored; else the constructor `mode` option; else default `mock`. Live mode additionally requires a non-empty `TYPESAFE_API_KEY`, else the constructor throws. Mock mode returns deterministic canned schema-valid answers through the **same** validation path as live bodies — zero network, no key required. This diverges from hindsight's constructor-option-only mock; deliberate (handoff §11): every wave must run green with no env key at all.

## E2E Slice

**Demonstrable behavior:** With `TYPESAFE_MOCK=1` and no `TYPESAFE_API_KEY`, `new JudgmentClient().judge(state, questions)` resolves a strictly-validated `{requestId, model, questions, answers, usage, latency_ms, egress_class, created_at}` envelope with zero network, writes the digest-stable side-channel entry keyed by `requestId` under `_bmad-output/judgment/provenance/`, and logs one house-shaped line.

**Wiring closed:** On completion of this story, `bun test tests/judgment/` exercises the client end-to-end in mock mode (validate → canned answer → envelope → choke point → ceiling → emit) using only code merged by this story. No stub, no `TODO: wire later`. The live call path is the same code with `mode: "live"`; the contract test pins that path's schema + model id so upstream drift fails loudly. No sibling story is required.

**Dependency edges (predecessors):** None — standalone. (JEV-3 consumes the client; JEV-1's corpus schema is untouched by this story.)

## Acceptance Criteria

1. **(make-or-break)** Given `TYPESAFE_MOCK=1` and **no** `TYPESAFE_API_KEY` in the environment, When `bun test tests/judgment/` runs, Then every test is green with zero network egress and the envelope's `model` is exactly `"jev-1.13.0"`, proving the whole core runs keyless by default.
2. Given a live-mode client with a key from `TYPESAFE_API_KEY` env at construction only, When the API returns 429 then 200, Then exactly one retry occurs honoring `retry-after` (capped at `MAX_RETRY_AFTER_MS`) and the envelope carries observed `usage`; when it returns 401 or 422, Then it throws once, naming the status, with no retry, and the thrown error carries the response body text (truncated) for field-level diagnosis, mirroring `HindsightHttpError`.
3. Given a question set whose state is classified `diff-hunk`, When the egress choke point is invoked at stage-1, Then it throws the HARD-GATE error naming the ZDR-addendum precondition (§3.7) before any request is built; `machine-state`, `finding-text` and `ac-prose` pass at stage 1.
4. Given a response body that is missing a required field, carries an unknown top-level key, or answers a question id that was not asked, When the client parses it, Then validation fails with the zod path and no envelope is constructed (strict schema, answers ⊆ questions).
5. Given the stage ceiling breaker configured at a stage-level token ceiling, When cumulative observed `usage` in a stage crosses it, Then further judgment calls refuse in that stage (typed refusal, not a hang), with no per-run budget admission anywhere (§3.2 — infrastructure tier).
6. Given any completed call, When the side-channel emit runs, Then exactly one file keyed by `requestId` lands under `_bmad-output/judgment/provenance/` whose `detail` is digest-stable and carries no volatile answer values or confidence — those ride the log line only. Given the same subject re-emitted, When the digest is identical, Then the second write is a no-op; if it is different, the emit throws a typed `DigestDivergenceError`.
7. Given a log call, When it fires, Then the line matches the house `log()`/`LogEntry` shape used by the hindsight client (no bespoke logger, no `console.log`).
8. Given the repo's frozen surfaces, When `detect_changes()` runs before commit, Then no `AUDIT_HOPS`, `gate-runner.ts`, `classifyRunExit`, `classifyDiffScope` or provider-layer symbol is touched.

## Trigger Surface

| Trigger | Status | E2E Test |
| --- | --- | --- |
| `JudgmentClient` mock call (`TYPESAFE_MOCK=1`) | in-scope | `tests/judgment/client.test.ts` |
| Live-mode retry arms (429/529 backoff; 401/422 fatal) via a `globalThis.fetch` stub harness (hindsight suite idiom) | in-scope | `tests/judgment/client.test.ts` |
| Mock/live resolution order (`TYPESAFE_MOCK=1` overrides `mode`; live-without-key throws) | in-scope | `tests/judgment/client.test.ts` |
| Strict response schema + answers⊆questions rejection | in-scope | `tests/judgment/schemas.test.ts` |
| Egress class validation + diff-hunk hard gate + per-class redaction | in-scope | `tests/judgment/egress.test.ts` |
| Stage ceiling breaker refuse | in-scope | `tests/judgment/ceiling.test.ts` |
| Side-channel emit digest-stability | in-scope | `tests/judgment/emit.test.ts` |
| Upstream API drift alarm (pinned model + response shape) | in-scope — the ONE suite meant to fail loudly on drift | `tests/judgment/contract.test.ts` |
| S1 observer calls / corpus record writes | out-of-scope — JEV-3 | — |
| Real API spend | out-of-scope — requires steve's explicit go in chat (§8) | — |

## Technical Notes

- **Build against (verified):** `httpRequest`, `HttpPolicy`, `HttpResult`, `retryAfterMs`, `MAX_RETRY_AFTER_MS` in `src/lib/http.ts`; `log`/`newRequestId`/`LogEntry` in `src/swarmclaw/log.ts`; `HindsightClient`/`HindsightHttpError` in `src/hindsight/client.ts` (`mockBody` there is private precedent to copy, not an import); contract pattern `tests/gitnexus/{gitnexus-cli-contract.json,cli-contract.ts,contract.test.ts}` — **pattern only; the existing gitnexus contract files are never modified.**
- **Vendor contract (§4):** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`. Request `{model: "jev-1.13.0", state, questions}` where `state` accepts `string | object | array` (the caller's serialization choice) and `questions` is a map discriminated on `type`, with per-type `criteria` shapes — **not** one loose `criteria?` free-for-all: `choice` requires `criteria` as a map of ≤255 options; `score` requires `criteria` as an ordered array of 2–10 levels; `noul` takes `criteria` optionally as `{true?, false?}`. Response `{model: z.literal("jev-1.13.0"), answers: {<qid>: {type, noul | choice+probabilities+confidence | score+legend+probabilities+confidence}}, usage: {input_tokens, output_tokens}}` — the response `model` is pinned `z.literal("jev-1.13.0")`, the only automated model-identity guard, consistent with the strict posture (an upstream repoint fails validation rather than flowing through). Billing is input-token-only: cost = `input_tokens × $0.042/Mtok`. All of these shapes are pinned in `tests/judgment/typesafe-api-contract.json` alongside the model id. All parsed with `.strict()` zod schemas; body treated as `unknown` until `safeParse` passes (INV-HM5 idiom). Strict-at-runtime is a deliberate divergence from the hindsight precedent: this is a recording-only client — a refused judgment is safer than an unparsed one — and that availability cost is accepted until the first live round.
- **Request-size budgets (§4 — documented, not enforced):** the client documents the 64k tokens/request and 32k state+longest-question limits; `warnWhenStateCharsOver` (default ~100k chars) logs a house-shaped warning when a state plausibly exceeds budget. Pre-flight state sizing is owned by JEV-3 — boundary note for the observer.
- **Envelope (exported zod schema + type):** `{requestId, model: "jev-1.13.0", questions, answers, usage, latency_ms, egress_class, created_at}` — `latency_ms: number`, measured around `judge()` (feeds the §3.12 A/B latency metric). Provenance rides with the answer set so any later consumer can state what was sent, to which model, at what cost.
- **Egress choke point (`egress.ts`, §3.7/§3.8):** one function validates `egress_class ∈ {machine-state, finding-text, ac-prose, diff-hunk}`, refuses unknown classes, enforces the stage-1 ceiling (`finding-text` + `ac-prose` max; `diff-hunk` throws the hard gate). The stage-1 max class is code-pinned, not config-selected — a deliberate deviation from §3.7's "config selects max class", recorded in ADR 0001 (ACCEPTED): `_bmad-output/typesafe-integration/adr/0001-egress-max-class-code-pinned.md` (max class is code-pinned per stage; the config knob ships with stage-2 ZDR work), and redacts **per class with its own designed rules**. Do NOT import or reuse `redactSecrets` (`src/providers/step-log.ts`) as the scrubber — it is a targeted pattern redactor, lossy both ways (§3.8, the `audit/chain.ts` join-slug lesson), and importing it would also violate the module's two-import fence.
- **Stage ceiling (`ceiling.ts`, §3.2):** a stage is one `JudgmentCeiling` instance held by the caller for the stage's process lifetime; the cumulative counter is in-memory (a per-process breaker — acceptable for batch workloads). Refusal over the token ceiling is typed and in-stage: `judge()` refuses with a `CeilingExceededError` carrying observed-vs-ceiling. No per-run budget admission, no `extensions.budget` interaction, no provider-layer call. The ceiling value is a constructor/config value, not a hardcoded constant — **shipped default: 1,000,000 cumulative request input tokens per stage** (a circuit breaker against runaway loops, not cost control; 1M input tokens ≈ $0.042 at $0.042/Mtok).
- **Side-channel emit (`emit.ts`, §3.4 FALLBACK):** layout pinned — exactly one JSON file per `requestId` under `_bmad-output/judgment/provenance/` (renamed from `envelopes/`, which read as envelope storage; overridable dir for tests). Re-emit semantics: writing a second entry whose digest is identical is a no-op; a different digest for the same `requestId` throws a typed `DigestDivergenceError`. `detail` fields are digest-stable: model, egress class, question ids/types, usage, timestamps — never answer values or confidence. Fidelity note (§3.4): this FALLBACK logs; it does not alarm — digest divergence is a tested property of `emit.ts` (AC-6), not a store-level tamper alarm; §3.4's `divergent` alarm belongs to the real store channel, which this story does not touch. Reason this shape exists: the real run-record side channel requires an `EXTENSION_NAMESPACES` allow-list edit in `src/providers/run-record.ts`, which is a banned provider edit (§11 resolution 2).
- **Contract test (`tests/judgment/contract.test.ts` + `tests/judgment/typesafe-api-contract.json`):** mirrors the gitnexus contract trio's structure — a checked-in contract file pinning the model id and the strict response-shape description, and a test asserting the client's pinned constant and zod schemas match it exactly (unknown-key tolerance = zero). This is the one suite whose loud failure means "contract json and schemas diverged — reconcile in one commit." Honest limitation: this test never touches the wire, so it cannot by itself detect upstream drift; the wire check is `scripts/judgment/live-probe.ts` — one canonical minimal request, run only when `TYPESAFE_API_KEY` is set AND steve has said go (§8), which diffs the live response against `typesafe-api-contract.json` and exits 2 naming the drift. The re-calibration ritual is documented in the contract file header: re-verify against docs.typesafe.ai/models.md (append `.md` for raw markdown), then update contract + schemas + pin in one commit, then re-run the probe.
- **Unit tests:** `tests/judgment/{client,schemas,egress,ceiling,emit}.test.ts` + fixtures. Retry arms tested via a `globalThis.fetch` stub harness (hindsight suite idiom), no real fetch; `JudgmentClientOptions` gains a test-only `retryDelayMs` override so the backoff delay is a test knob (no wall-clock sleeps). All green keyless.
- **Files touched:** `src/judgment/{client,schemas,egress,envelope,ceiling,emit,index}.ts` (new); `scripts/judgment/live-probe.ts` (new); `tests/judgment/*` (new). **No `src/` file outside `src/judgment/` is modified.** package.json untouched (§3.3).
- **Cite symbols, never line numbers.** `impact()` before any edit to an existing symbol (there should be none); `detect_changes()` before commit; expected scope = new files only.
- Tests tee to a log: `bun test tests/judgment/ > /tmp/qds-test.log 2>&1`; full-suite runs always tee (repo CLAUDE.md).

## Security Invariants

- INV-J1: **`TYPESAFE_API_KEY` is env-only at client construction** — never hardcoded, never logged, never placed in an envelope, a side-channel detail, a corpus record, or a log line. This client performs NO env diagnostics — the key is read once at construction and never echoed; no masking helper is needed or imported.
- INV-J2: **No diff hunks or third-party bot prose in stage-1 egress** (handoff §8): only lead-authored finding text and AC prose pass the choke point; bot-comment text stays behind the feedback-run INV-7 fence. The test is declaration-discipline, not content sniffing: a fixture DECLARING `diff-hunk` at stage 1 is refused with the ZDR-gate error, and an unknown or absent egress class is refused likewise. Content-level hunk detection is out of scope — the fence is owned by the JEV-3 state builder, which declares each state's class at the seam.
- INV-J3: **Digest-stable side-channel detail** — volatile fields (answer values, confidence) never enter `detail`, so a re-emit of the same subject can never read as `divergent` (the tamper-alarm bug class credentials.ts hit 3×).
- INV-J4: **Frozen surfaces untouched** — `AUDIT_HOPS`, gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope`, the provider layer; enforced by the two-import fence (`src/lib/http.ts` + `src/swarmclaw/log.ts` only) asserted by a grep test.
- INV-J5: **Mock is the default; no real spend without `TYPESAFE_API_KEY` set AND steve's explicit go in chat** (§8). This story ships no caller that sets live mode.

## Definition of Done

- [ ] **Impl:** `JudgmentClient` on `httpRequest`/`HttpPolicy` — live + mock modes, 429/529-only retry with `retryAfterMs`, fatal 401/422, POST-replay safety rationale stated at the call site.
- [ ] **Impl:** egress choke point (class validation, stage-1 max, diff-hunk hard gate, per-class redaction designed fresh), stage ceiling breaker, side-channel emit, house-shaped logging.
- [ ] **Contract:** strict zod request/response schemas + exported envelope schema; answers ⊆ questions enforced; pinned `jev-1.13.0` constant sourced from `tests/judgment/typesafe-api-contract.json`.
- [ ] **Integration:** mock-mode envelope flows client → choke point → ceiling → emit with zero network and no key (the make-or-break path).
- [ ] **Observability:** one log line per call in the `LogEntry` shape + one digest-stable side-channel entry keyed by `requestId`.
- [ ] **Security:** INV-J1..J5 each covered by a named test (key-absence, diff-hunk-declaration refusal, unknown/absent-class refusal, digest stability, import fence, mock-default).
- [ ] **Test (upstream-drift alarm):** `tests/judgment/contract.test.ts` fails loudly when the contract json and the schemas diverge; existing `tests/gitnexus/` files unmodified.
- [ ] **Guard (wire probe, steve-gated):** `scripts/judgment/live-probe.ts` sends one canonical minimal request only when `TYPESAFE_API_KEY` is set AND steve has said go in chat (§8), diffs the live response against `tests/judgment/typesafe-api-contract.json`, and exits 2 naming the drift; the in-repo contract pin states plainly that it never touches the wire.
- [ ] **Test:** `bun test tests/judgment/` green keyless in mock mode; `tsc` + `biome` clean; full-suite run teed to `/tmp/qds-test.log`; `detect_changes()` shows zero touched symbols outside `src/judgment/` + `tests/judgment/`.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
