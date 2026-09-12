# DF2.13: Per-Run Key Cap Wired from the Admission Budget

**Story Points:** 3

**Status:** in-review

**Sprint:** v5-S3

## Spec Reference

- **Provenance — operator ruling of 2026-09-08 (c): re-home the middle term, do not invent a
  control.** Six story files and one production docstring asserted the ceiling chain
  `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`. `runBudgetCapMicros`
  is declared **only** at `scripts/cap-hit-demo.ts:97,148`, annotated there as *"Inner control: run
  budget cap (artifact field only)"* and documented at `:1305` behind `--budget-cap` as *"Run budget
  cap (artifact field only, default 40000)"*. It is written into DF2.4's evidence JSON
  (`_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-4-cap-hit.md:35`) and **enforces
  nothing**. The middle term therefore named a control that did not exist. The bound it reached for
  is real, and its enforcement point already ships, so the term is re-homed to the mint-time cap:

      residentSpendCeilingMicros  ≤  capMicroUsd (mint-time, per run)  ≤  defaultKeyCapMicroUsd
         DF3.6a, engine-enforced,        provider-enforced, per run,        provider ceiling
         in-box, a CLAIM under R9        OUTSIDE the trust boundary         on the above

- **Scope correction, stated up front because it changes what this story builds.** The *derivation*
  the ruling asks for — "mint at `min(remaining issue budget, a per-run policy ceiling)`, taking the
  remaining budget from DF2.8's admission path" — **already ships end to end** on the production
  dispatch path, and this story does not rebuild it. What does **not** ship is the third term:
  nothing anywhere bounds the mint-time cap by `defaultKeyCapMicroUsd`. The "backstop" is a
  docstring. This story makes it an enforced bound and pins the shipped derivation against
  regression. See the Overview for the trace and the Technical Notes for the measurement.
- Predecessor stories, cited not modified: `df2-3-credential-lifecycle.md` (the mint/cap/deliver/
  revoke/verify lifecycle and `defaultKeyCapMicroUsd`), `df2-8-cost-ledger-budget-cap.md` (the
  per-issue admission cap, its reservation accounting and `admittedCeilingMicroUsd`)
- Downstream consumer whose spec asserts the chain: `df3-6a-resident-spend-iteration-bounds.md`
  (`residentSpendCeilingMicros` = 8,000 µ$ per run in its Technical Notes; the spend chain,
  stated verbatim in its dependencies record; the effective-ceiling clamp
  `min(residentSpendCeilingMicros, limitMicroUsd)` in its derivation — cite it by grep anchor
  `effectiveCeiling`, not by line: Wave-7 rework owns that file and every number in it moves)
- Decision register: **DD-9** (integer micro-dollars; float USD only at a wire boundary),
  **INV-CRED-1** (an uncapped key must never be minted-and-kept), **F004** (the cap is a ceiling,
  not a suggestion), **INV-COST-6** (under-admitting is the safe direction)

## User Story

As the operator who funds every token a box spends,
I want the ceiling on a run's key to be derived from the budget that admitted it and bounded by a
backstop the code actually enforces,
so that no dispatch can mint a key for more money than the factory has a provider-side limit for,
and the one number that survives to the provider is the one the ledger reserved against.

## Overview

**What already ships, verified by reading the path.** The production dispatch mints at the admitted
ceiling today. The trace, every hop confirmed in source:

| Hop | Site | What it does |
|-----|------|--------------|
| 1 | `dispatch.ts:2451-2455` | `assertWithinBudget(ledger, { repoSlug, issueId, runId, requestId }, deps.capMicroUsd)` |
| 2 | `budget-gate.ts:79-85` | resolves the per-issue cap via `capForIssue`, calls `ledger.admitIssue(input, cap, keyCapMicroUsd)`; `keyCapMicroUsd` defaults to `defaultKeyCapMicroUsd` when the caller passes nothing |
| 3 | `cost-ledger.ts` `admitIssue` | inside `BEGIN IMMEDIATE`: `remainingMicroUsd = cap − (spentMicroUsd + reservedMicroUsd)`, then `ceiling = Math.min(keyCapMicroUsd, remainingMicroUsd)`, returned as `admittedCeilingMicroUsd` and written to the `gate_admissions` row |
| 4 | `dispatch.ts:2533` | `const effectiveCeilingMicros = decision.admittedCeilingMicroUsd` |
| 5 | `dispatch.ts:1646` | `mintRunKey({ …, capMicroUsd: effectiveCeilingMicros }, runId)` |
| 6 | `credentials.ts` | `const capMicroUsd = deps.capMicroUsd ?? defaultKeyCapMicroUsd` |

So `min(remaining issue budget, per-run policy ceiling)` is the shipped formula, the remaining
budget comes from the admission that reserved it, and there is no second budget authority. The
ruling's rationale — *a second independent budget authority could disagree with the admission
decision* — is already satisfied by construction, and this story must not introduce one.

**What does not ship — the gap this story exists to close.** `defaultKeyCapMicroUsd = 50_000_000`
is described in its own docstring as the *"ceiling on what `mintRunKey` may request"*. **Nothing
compares anything to it.** Every guard on the path bounds the cap by something else:

- `dispatch.ts:2425-2438` refuses a `capMicroUsd` that is not a positive integer **≤
  `Number.MAX_SAFE_INTEGER`** — not ≤ the backstop.
- `admitIssue` refuses a `keyCapMicroUsd` that is not a positive integer — no upper bound.
- `capForIssue` returns a `perIssueOverrides` value with no upper bound; `loadCostConfig`'s
  `assertMicros` bounds it by the safe-integer range only.
- `mintRunKey`'s pre-mint validation ladder refuses a non-positive, non-integer or
  non-round-tripping cap — no upper bound.

Consequence, reachable with configuration alone and no code change: an operator who sets a
`perIssueOverrides` entry of `900_000_000` and dispatches with `--cap 900000000` mints a live
provider key with a **$900** hard limit. Every layer approves it, and each is individually correct
— the bound simply is not anyone's job. The backstop is documentation, and the top term of the
chain the whole ruling turns on is unenforced.

**The change.** One comparison, at the one place that already holds the cap and the constant:
`mintRunKey` refuses a `capMicroUsd` above `defaultKeyCapMicroUsd` with the same `cap-invalid`
class its two sibling refusals use. Reuse, not new mechanism: the guard block, the error class, the
remediation shape and the round-trip check are all already there — this adds a fourth condition to
a validation ladder that ships. Plus the regression pins that make hops 1–6 assertable rather than
true-by-inspection, and the correction of one stale comment that misdescribes the path.

## E2E Slice

**Demonstrable behavior — the derived cap reaches the provider.** Given a cost config whose issue
cap for `owner/repo#42` is `5_000_000` µ$ and a ledger already holding `4_000_000` µ$ of priced
spend and no outstanding reservations, When `dispatch` is run for that issue with no `--cap`, Then
`admitIssue` returns `admittedCeilingMicroUsd: 1_000_000` (`min(50_000_000, 5_000_000 − 4_000_000)`),
`mintRunKey` is called with exactly `capMicroUsd: 1_000_000`, the fake key API records a
`createKey(name, 1.0)` call — one dollar, converted once at the HTTP boundary — and the run record's
`limitMicroUsd` reads `1_000_000`. The run mints at the **remainder**, not at the policy ceiling and
not at the backstop.

**Demonstrable behavior — the backstop bites.** Given the same issue with a `perIssueOverrides`
entry of `900_000_000` µ$ and a dispatch passing `--cap 900000000`, When dispatch runs, Then
`mintRunKey` refuses with `CredentialLifecycleError { code: "cap-invalid" }` naming both the
requested cap and `defaultKeyCapMicroUsd`, `deps.keyApi.createKey` is recorded **zero** times, no
key exists at the provider, and the refusal names the backstop in its remediation. On today's
`main` this dispatch mints a live $900 key.

**Wiring closed:** on completion, all three terms of `residentSpendCeilingMicros ≤ capMicroUsd ≤
defaultKeyCapMicroUsd` have an enforcement point that runs — the first inside the box (DF3.6a, a
claim under R9), the second and third at the mint, outside the trust boundary. No stub, no
`TODO: wire later`. The mint-time refusal is total: it covers `dispatch`, `scripts/cap-hit-demo.ts`
and any future caller, because it lives in the shared function rather than in each caller.

**Dependency edges (predecessors):** **DF2.3** (owns `mintRunKey`, `defaultKeyCapMicroUsd` and the
cap-validation ladder this story extends) and **DF2.8** (owns `admitIssue`,
`admittedCeilingMicroUsd` and the remaining-budget computation this story consumes unmodified).
Both are `done`.

**Downstream consumer (not a predecessor): DF3.6a.** Its `loadResidentBounds` asserts the chain that
this story makes true. **DF3.6a must not implement against the chain until this lands** — until
then its top term names a bound no code enforces, and a loader asserting it would be asserting a
property of the configuration rather than of the system. DF3.6a is not blocked from *starting*; it
is blocked from treating `capMicroUsd ≤ defaultKeyCapMicroUsd` as a fact.

## Acceptance Criteria

1. **(make-or-break — the derived cap is what reaches the mint)** Given a ledger whose remaining
   headroom for the dispatched issue is strictly less than the per-run policy ceiling, When
   `dispatch` runs, Then the `capMicroUsd` argument `mintRunKey` receives is **exactly**
   `decision.admittedCeilingMicroUsd`, equal to `min(keyCapMicroUsd, remainingMicroUsd)` where
   `remainingMicroUsd = capForIssue(...) − (spentMicroUsd + reservedMicroUsd)`, and the same value
   is the `ceiling_micro_usd` on the `gate_admissions` row this dispatch wrote. Asserted by spying
   the `capMicroUsd` reaching `mintRunKey` and reading the row back, in
   `tests/fleet/dispatch.test.ts`. *Negative control, MUST fail: an implementation that recomputes
   the ceiling from the ledger at mint time instead of propagating the decision's own output — it
   can disagree with the row that reserved the money, which is the second budget authority the
   ruling forbids.*
2. Given an issue whose remaining budget (`1_000_000` µ$) is **below** the per-run policy ceiling
   (`50_000_000` µ$), When the run is dispatched, Then it mints at `1_000_000` µ$ — the smaller
   value — and `keyApi.createKey` is called with `1.0` USD. Given the reverse (remaining
   `40_000_000` µ$, policy ceiling `10_000_000` µ$ via `--cap`), Then it mints at `10_000_000` µ$.
   `tests/providers/budget-gate.test.ts` covers the decision; `tests/fleet/dispatch.test.ts` covers
   the value that survives to the mint. *Negative control, MUST fail: an implementation using `max`,
   or one that ignores either operand.*
3. **(the round trip — a derived cap must survive the dollar-denominated API or be refused)** Given
   a derived cap that does **not** satisfy `usdToMicros(microsToUsd(cap)) === cap`, When `mintRunKey`
   is called with it, Then it refuses with `CredentialLifecycleError { code: "cap-invalid" }` before
   `keyApi.createKey` is reached, and `createKey` is recorded **zero** times. This is a real risk
   introduced by deriving rather than configuring: a configured cap is a round literal an author
   chose, while `cap − spent − reserved` is an arbitrary integer nobody inspected, so the guard at
   `credentials.ts` moves from theoretical to load-bearing. The test asserts both arms — a
   derived remainder such as `4_837_211` µ$ round-trips and mints, and a cap at a magnitude where
   the division/multiplication loses precision refuses. *Negative control, MUST fail: an
   implementation that clamps or rounds the derived cap to make it round-trip — silently minting a
   key for a different amount than the ledger reserved is the exact failure the refusal prevents.*
4. **(make-or-break — the backstop is enforced, not documented)** Given `capMicroUsd` strictly
   greater than `defaultKeyCapMicroUsd`, When `mintRunKey` is called, Then it refuses with
   `CredentialLifecycleError { code: "cap-invalid" }` whose message names **both** the requested cap
   and `defaultKeyCapMicroUsd`, and whose remediation names the backstop as the thing to raise;
   `keyApi.createKey` is recorded **zero** times and no run record is written. The check sits in the
   existing validation ladder in `mintRunKey`, **before** the mint call, so it covers every caller
   including `scripts/cap-hit-demo.ts`. Asserted in `tests/providers/credentials.test.ts`.
   *Negative controls, both MUST fail: the shipped `main` behaviour — `dispatch` with a
   `perIssueOverrides` entry and a `--cap` of `900_000_000` mints a live $900 key and this test must
   go red against it; and an implementation placing the bound in `dispatch.ts`'s
   `:2425-2438` argument validation only, which leaves `cap-hit-demo.ts:618` and every future
   caller unbounded — the guard must be in the shared function, not in one caller.*
5. **(the negative control the ruling names — an underivable budget refuses, it does not fall back)**
   Given a dispatch for which the admission budget cannot be derived — `ledgerFactory()` throws, the
   ledger file is unreadable, or `admitIssue` raises `CostLedgerError` — When dispatch runs, Then it
   **refuses** (`refuse(5, "admission-failed" | "ledger-failed", …)`, `dispatch.ts:2466-2492`),
   nothing is provisioned, and `mintRunKey` is never reached. Given an admitted decision whose
   `admittedCeilingMicroUsd` is non-positive or not a safe integer, Then dispatch refuses
   `no-ceiling` (exit 5, `dispatch.ts:2577-2590`) before the record and box exist. In **no** path
   does an absent or underivable budget result in a mint at `defaultKeyCapMicroUsd`. *Negative
   control, MUST fail: any implementation reading `deps.capMicroUsd ?? defaultKeyCapMicroUsd` as the
   dispatch-path fallback — a silent fall back to the 50,000,000 backstop when the budget is
   unknown is the precise failure this story exists to remove. The `??` at `credentials.ts`
   stays, because it serves callers that legitimately have no ledger (the demo), but a test pins
   that the dispatch path never exercises it: the `capMicroUsd` reaching `mintRunKey` from
   `dispatch` is always defined.*
6. **(the ordering, asserted where all three are visible)** Given a mint on the dispatch path, When
   `mintRunKey` validates its cap, Then `capMicroUsd ≤ defaultKeyCapMicroUsd` holds by AC4 and is
   asserted there — the one place that can see both. The **lower** bound
   `residentSpendCeilingMicros ≤ capMicroUsd` is **not** asserted at the mint, and the reason is
   recorded rather than left as an omission: it is legitimately violated by design when an issue is
   nearly exhausted (remaining `5_000` µ$ against a resident ceiling of `8_000` µ$), which is the
   *exemption* DF2.3 and DF2.8 both already state for the remainder-capped mint. DF3.6a owns that
   term and **clamps** rather than refuses — the effective resident ceiling is
   `min(residentSpendCeilingMicros, limitMicroUsd)` (`df3-6a:153`). So the chain reads `≤`
   throughout, the top bound is enforced at the mint, the bottom is enforced in-box by clamping, and
   no test asserts an unconditional `resident ≤ cap` that a legal near-exhaustion state would
   falsify. *Negative control, MUST fail: an implementation refusing the mint when
   `capMicroUsd < residentSpendCeilingMicros` — it would refuse every legitimate remainder-capped
   dispatch and turn a working clamp into a fleet outage.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `mintRunKey` backstop refusal (`capMicroUsd > defaultKeyCapMicroUsd`) | in-scope | `tests/providers/credentials.test.ts` | — |
| `mintRunKey` round-trip refusal exercised with a **derived** cap | in-scope | `tests/providers/credentials.test.ts` | — |
| Derived cap propagated `admitIssue` → `mintRunKey`, pinned | in-scope | `tests/fleet/dispatch.test.ts` | — |
| `min(keyCap, remaining)` both directions | in-scope | `tests/providers/budget-gate.test.ts` | — |
| Underivable-budget refusal; dispatch never mints at the backstop | in-scope | `tests/fleet/dispatch.test.ts` | — |
| Stale comment at `dispatch.ts:2548-2576` (upgrade trigger 1 already fired) | in-scope (comment only) | — | — |
| `scripts/cap-hit-demo.ts` minting at `--cap` with no ledger in the loop | in-scope — inherits AC4's bound, behaviour otherwise unchanged | `tests/providers/cap-hit-demo.test.ts` | — |
| DF3.6a's `loadResidentBounds` asserting the chain | out-of-scope | — | DF3.6a, blocked on this story |
| Bounding `perIssueOverrides` by `defaultKeyCapMicroUsd` at config load | out-of-scope — **narrowed, not retired**: AC4 bounds the mint, which is the money event. A config-load bound would refuse earlier and more legibly. | — | Owner: DF2.8. Filed, unscheduled. |
| Retiring `runBudgetCapMicros` from `scripts/cap-hit-demo.ts` | out-of-scope — it is a correct evidence-artifact field; only its use as an *invariant* term was wrong | — | none scheduled |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Host-side ledger `.sandbox/cost-ledger.db` | `bun:sqlite`, bundled with the project toolchain — **no new dependency** | `admitIssue`'s `BEGIN IMMEDIATE` serialization and its reservation accounting are consumed **unmodified**; this story adds no query and no column |
| Cost config `.sandbox/cost-config.json` | host filesystem, `loadCostConfig` | `defaultCapMicroUsd` (5,000,000 µ$) and `perIssueOverrides` are read through the shipped `capForIssue`; no new config key is introduced |
| Provider key API (`POST /api/v1/keys`) | OpenRouter; `fake` key API in tests | unchanged — the refusal fires **before** the call, so a refused mint makes no request; `createKey` recorded zero times is the assertion |
| Provider box + `exec` | exe.dev driver (DF2.2); `fake` driver in tests | unchanged — this story touches no driver call and no box-side behaviour |

## Technical Notes

- **The derivation is reused whole; no new budget authority.** `admitIssue` computes
  `remainingMicroUsd = cap − (spentMicroUsd + reservedMicroUsd)` inside the same `BEGIN IMMEDIATE`
  transaction that writes the reservation, so the number is consistent with the row by
  construction. `admittedCeilingMicroUsd = Math.min(keyCapMicroUsd, remainingMicroUsd)` is that
  decision's own output, and `dispatch.ts:2533` propagates it rather than recomputing. Any
  implementation that re-reads the ledger at mint time reintroduces exactly the disagreement the
  serialized admission exists to prevent — including on the replay path, where `admitIssue`
  deliberately hands back **the ceiling already on the row** rather than a freshly computed one.
- **Why the bound belongs in `mintRunKey` and not in `dispatch`.** `mintRunKey` has **three direct
  call sites** (`src/fleet/dispatch.ts`, `scripts/cap-hit-demo.ts`, and `runCredentialLifecycle`
  inside `credentials.ts` itself — verified 2026-09-10; W6-E-L11 recorded that the earlier "four
  callers" conflated direct callers with the ~9 transitively impacted symbols impact analysis
  reports, `risk: CRITICAL`). A bound in
  `dispatch.ts`'s argument validation covers one of them; a bound in the shared function covers all
  of them and every future one. It is also the smaller diff — one condition added to an existing
  ladder versus a check duplicated per caller — and the ladder already holds both operands. The
  correction strengthens the argument: `runCredentialLifecycle` is a third uncovered path.
- **`defaultKeyCapMicroUsd` becomes load-bearing, and that is the point.** Today it is a default
  operand (`credentials.ts`) and a documented intent. AC4 makes it an enforced ceiling while
  leaving it the default, so the two roles the constant plays are both real: *"what you get if you
  ask for nothing"* and *"the most you may ask for"*. Raising the backstop stays a one-line code
  change with a test that names it, which is the correct amount of friction for the number that
  bounds every key the factory can mint.
- **The `??` at `credentials.ts` stays.** `scripts/cap-hit-demo.ts:618` mints through
  `mintRunKey` directly at `--cap` with no ledger in the loop, **by design** — a cap-kill demo mints
  exactly the cap it advertises, and DF2.4's Technical Notes record that deliberately. Removing the
  default would break that caller for no gain, because AC5's protection is a property of the
  *dispatch path* (where `capMicroUsd` is always defined and a ledger failure refuses), not of the
  defaulting expression. AC5 pins that property directly instead of removing the `??`.
- **Stale comment, corrected as part of this story.** `dispatch.ts:2548-2576` states *"dispatch
  never passes `keyCapMicroUsd`, so it is `defaultKeyCapMicroUsd`, a positive literal"*, and lists
  as ponytail **upgrade trigger 1**: *"dispatch starts passing `keyCapMicroUsd` to
  `assertWithinBudget`"*. That trigger has **already fired** — `:2454` passes `deps.capMicroUsd`
  (DF3.2/DD-9, documented at `:474-483`). The `no-ceiling` arm at `:2577` is therefore **reachable**
  whenever a caller supplies `--cap`, so the comment's unreachability argument — which is why the
  arm strands its reservation without a compensating release — no longer holds on its own terms.
  This story corrects the comment to say so and records the stranded-reservation consequence
  (the orphan window retires it, `ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS`). **It does not
  add the compensating release**: `admitIssue`'s contract deliberately offers no release, that is
  DF2.8's decision to revisit, and the orphan guard already bounds the exposure. Naming a live
  hazard accurately is in scope; redesigning the reservation contract is not.
- **Units (DD-9), unchanged.** Caps are integer micro-dollars everywhere in this story. The single
  conversion is `microsToUsd(capMicroUsd)` at `credentials.ts`, into `keyApi.createKey`. AC3
  guards the inverse. The F004 over-grant check compares in the **USD** domain before
  rounding, and its correctness depends on the requested cap round-tripping cleanly — which is why
  AC3 is an acceptance criterion and not a nicety.
- **What a "per-run policy ceiling" is, concretely.** It is `keyCapMicroUsd`: `deps.capMicroUsd`
  when dispatch is given one, otherwise `defaultKeyCapMicroUsd` via `assertWithinBudget`'s default
  parameter (`budget-gate.ts:82`). No new configuration key is introduced. Under the shipped
  defaults the issue cap (5,000,000 µ$) is an order of magnitude below the backstop (50,000,000 µ$),
  so `remainingMicroUsd` is the binding operand on an ordinary dispatch and the policy ceiling binds
  only when an operator passes `--cap`.
- **The band this closes, measured rather than asserted.** DF3.6a holds the resident at 8,000 µ$
  (`df3-6a:286`). Under the **shipped default** config a run's key is capped at the issue remainder,
  at most 5,000,000 µ$ — a **625×** band, not the 6,250× a comparison against the raw backstop
  suggests, because the issue cap binds first. The 6,250× figure is reachable only with a
  `perIssueOverrides` entry at or above the backstop; **above** it, today, the band is unbounded,
  which is the finding AC4 closes. The band itself is not a defect — a run legitimately spends more
  than one resident session — but it is unbounded above without AC4, and that is.

## Observability Contract

| Event | Fields | Sink |
|-------|--------|------|
| Mint refused — cap above backstop | `operation: "credential.mint"`, `status: "error"`, `error.code: "cap-invalid"`, `runId`, `requestId`, `outcome: "error"`, `mint_ms` | step log (`timed`, `credentials.ts`) — the existing `credential.<step>` error line; **no new log shape** |
| Mint accepted at a derived ceiling | existing `fleet.dispatch` mint line — `keyHash`, `capMicroUsd` (`dispatch.ts:1665`) | dispatch structured log — **unchanged**; it already carries the cap because *"a key is live"* and *"it can spend N µ$"* are different sizes of incident |
| Admission decision | existing `admitIssue` observability line (DF2.8 owns it — **do not double-log**, `budget-gate.ts:9`) | cost-ledger log |

No new log event is introduced. The refusal rides the `credential.mint` error line that every other
`mintRunKey` refusal already uses, so an operator greps one code (`cap-invalid`) for all four
cap-validation failures and reads the message to tell them apart.

## Files to Modify

| File | Change |
|------|--------|
| `src/providers/credentials.ts` | `mintRunKey`: add the `capMicroUsd > defaultKeyCapMicroUsd` refusal to the existing pre-mint validation ladder, before the `createKey` call. Update the `defaultKeyCapMicroUsd` docstring to state that the backstop is now enforced at the mint and name this story — and in the same edit, drop the docstring's own stale `:261`/`:281` self-citations (W6-E-M8: three generations of one wrong number; the paragraph keeps its lesson, loses the numbers). |
| `src/fleet/dispatch.ts` | Comment only (`:2548-2576`): correct the stale *"dispatch never passes `keyCapMicroUsd`"* claim and the already-fired upgrade trigger 1; state the `no-ceiling` arm's reachability and why the reservation is left to the orphan window. No behavioural change. |
| `tests/providers/credentials.test.ts` | AC3 (both round-trip arms, with a derived cap), AC4 (backstop refusal + `createKey` zero times + the caller-placement negative control). |
| `tests/fleet/dispatch.test.ts` | AC1 (the `capMicroUsd` reaching `mintRunKey` equals `admittedCeilingMicroUsd` and the `gate_admissions` row), AC2 (both directions of the `min`), AC5 (underivable budget refuses; the dispatch path never reaches the `??` default). |
| `tests/providers/budget-gate.test.ts` | AC2 at the decision layer — `min(keyCap, remaining)` with each operand binding in turn. |

`src/providers/cost-ledger.ts` and `src/providers/budget-gate.ts` are **read, not modified**: the
derivation ships and this story consumes it.

## Security Invariants

- **INV-CAP-1 (new, this story).** No key is minted with a cap above `defaultKeyCapMicroUsd`. The
  check lives in `mintRunKey`, before `keyApi.createKey`, so it holds for every caller and no
  caller can opt out. Raising the ceiling requires a code change with a test that names it.
- **INV-CRED-1 (DF2.3, unchanged).** An uncapped key is never minted-and-kept. The new refusal fires
  *before* the mint, so it never creates the orphan INV-CRED-1 guards against — unlike the
  post-mint `uncapped-key` and `mint-ceiling-mismatch` refusals, which deliberately record the
  hash first (`credentials.ts`) precisely because a key already exists by then. **The new
  check must sit with the pre-mint guards, not the post-mint ones**; placing it after the
  `createKey` call would mint the very key the bound exists to prevent and then need compensation.
- **INV-COST-6 (DF2.8, unchanged).** Under-admitting is the safe direction. Both operands of the
  `min` and the new upper bound move the cap **down** only; nothing in this story can raise a
  ceiling.
- **F004 (DF2.3, unchanged).** The cap is a ceiling, not a suggestion: a provider echo above the
  request is still refused at `credentials.ts`, in the USD domain, before rounding.
- **INV-4 (DF2.3, unchanged).** The plaintext key exists in the mint return and nowhere else. This
  story adds a refusal path that runs before any key exists, and logs no new field.
- **Trust boundary, restated.** Two of the three ceiling terms are enforced **outside** the box
  (the mint-time cap and the backstop, both host-side, both provider-enforced). The third —
  `residentSpendCeilingMicros` — is enforced **inside** the box by the engine and is a CLAIM under
  R9, not evidence. This story does not move that boundary and does not let an in-box number
  influence a host-side cap.

## Definition of Done

- [ ] **Impl:** `mintRunKey` refuses `capMicroUsd > defaultKeyCapMicroUsd` with
      `CredentialLifecycleError { code: "cap-invalid" }`, in the pre-mint validation ladder, with a
      message naming both values and a remediation naming the backstop.
- [ ] **Impl:** `defaultKeyCapMicroUsd`'s docstring states the backstop is enforced at the mint and
      no longer describes an assertion nobody performs.
- [ ] **Impl:** `dispatch.ts:2548-2576`'s stale comment corrected — upgrade trigger 1 recorded as
      fired, the `no-ceiling` arm recorded as reachable, the reservation's orphan-window retirement
      named. No behavioural change on that path.
- [ ] **Contract:** no new config key, no new log event, no new ledger column or query. The
      admission derivation is consumed unmodified.
- [ ] **Test (unit):** AC4 backstop refusal, with `keyApi.createKey` recorded **zero** times and no
      run record written.
- [ ] **Test (unit):** AC3 both arms — a derived remainder that round-trips mints; one that does not
      refuses before `createKey`.
- [ ] **Test (integration):** AC1/AC2 — the `capMicroUsd` reaching `mintRunKey` equals
      `decision.admittedCeilingMicroUsd` and the `gate_admissions` row, with each operand of the
      `min` binding in turn.
- [ ] **Test (negative control):** AC5 — an underivable budget refuses (exit 5) and never mints; the
      dispatch path never exercises `credentials.ts`'s `?? defaultKeyCapMicroUsd`.
- [ ] **Test (negative control):** the shipped `main` behaviour — a `perIssueOverrides` entry and a
      `--cap` of `900_000_000` minting a live $900 key — **fails** AC4.
- [ ] **Test (negative control):** an implementation placing the bound in `dispatch.ts` only
      **fails** AC4's coverage of `scripts/cap-hit-demo.ts`.
- [ ] **Regression:** `bun test tests/providers/ tests/fleet/` green, captured to a log per
      `CLAUDE.md` (never a bare `bun test`); `tsc --noEmit` clean.
- [ ] **Docs:** DF3.6a notified that the chain's top term is now enforced and it may implement
      against it.

## Dev Agent Record

Implemented 2026-09-12 on `feature/df2-13-per-run-key-cap-from-admission-budget` (cut from `dev` at
45f9af76). Orchestration: /qds-dev pipeline + /unlazy ledger (`.unlazy/df2-13/GATES.md`, 12 gates,
evidence recorded per gate). All citations below are by symbol.

### Impl

- **`mintRunKey` (src/providers/credentials.ts):** fourth and final pre-mint guard —
  `capMicroUsd > defaultKeyCapMicroUsd` → `CredentialLifecycleError("cap-invalid")`, message
  `capMicroUsd ${capMicroUsd} exceeds the backstop defaultKeyCapMicroUsd (${defaultKeyCapMicroUsd}) —
  refusing to mint a key above the provider ceiling`, remediation: lower to the admission's remaining
  budget, or raise `defaultKeyCapMicroUsd` "— a code change that owes a test naming it" (INV-CAP-1).
  Sits after the round-trip guard, before the `createKey` call; boundary is inclusive (exactly
  50_000_000 mints). NOT placed among the post-mint guards (INV-CRED-1: those fire after a live key
  exists).
- **`defaultKeyCapMicroUsd` docstring:** now states the backstop is ENFORCED at the mint (INV-CAP-1,
  every caller inherits, raising it is a code change + test); the "wiring it from the admission
  budget is DF2.13" sentence replaced by the shipped state; the stale-citation confession paragraph
  kept its lesson and lost the `:261`/`:281` numbers; `scripts/cap-hit-demo.ts:97,148` → symbol
  citation (`runBudgetCapMicros`, the `--budget-cap` option — artifact field, enforces nothing). No
  line numbers remain in the docstring.
- **`dispatch.ts`:** comment-only addition to the `no-ceiling` block (verified by diff: 13 inserted
  comment lines, zero code), documenting the NEW downstream mint-time `cap-invalid` refusal.
  Review-round-1 correction: that refusal is NOT a `no-ceiling`-equivalent stranding. A `no-ceiling`
  fires before `store.create`, so its stranded reservation is an absent record the orphan guard
  retires after `ADMISSION_GRACE_MS + ADMISSION_SKEW_MARGIN_MS` (~6 min); the mint-time
  `cap-invalid` fires AFTER `provisionAdmittedRun` has written an OPEN run record and created a
  LIVE BILLABLE box, and `classifyReservation` counts unclosed records (cost-ledger.ts,
  `closedAt === undefined` → "count"), so the orphan guard never retires it — headroom returns only
  at teardown close (plus grace), and the box bills until an operator tears the run down.
  Reachability, corrected: the knob is `--cap-micro-usd` (`DispatchDeps.capMicroUsd`, B1-bounded by
  MAX_SAFE_INTEGER only) AND the config issue cap minus committed spend must also clear the
  backstop — against the shipped `defaultCapMicroUsd` of 5_000_000 µ$, `--cap-micro-usd
  900_000_000` alone admits at 5M and mints fine. Observable, corrected: the refusal surfaces as
  the `fleet.dispatch` error line with `payload.providerCode` "cap-invalid" (exit 1, the generic
  key-delivery-failed text — `CredentialLifecycleError` is not a `FleetError`, so its
  message/remediation do not survive the catch), not as a `no-ceiling` (exit 5) line. No
  behavioural change on that path.
- **Contract held:** no new config key, no new log event, no ledger column or query;
  `cost-ledger.ts` and `budget-gate.ts` byte-untouched.

### Deviations from story prose (all recorded, none silent)

1. **The stale comment was already partially corrected before this story ran.** The story's
   Technical Notes quote a comment state ("dispatch never passes `keyCapMicroUsd`…") that a
   2026-09-08 Wave-6 correction had already fixed: upgrade trigger 1 is recorded as FIRED (DF3.2)
   and COMPENSATED in the file this story modified. What remained genuinely stale was the absence
   of any mention of DF2.13's new mint-side refusal — added (see above).
2. **"The `no-ceiling` arm recorded as reachable" — NOT written, because it is false.** Ground
   truth, verified in `cost-ledger.ts` `admitIssue`: the replay branch runs only after the
   `committed >= cap` and `remainingMicroUsd <= 0` gates, and clamps `ceiling = min(prior.ceiling,
   remainingMicroUsd)`; B1 bounds `deps.capMicroUsd` to a positive safe integer; the default is a
   positive literal. The arm is UNREACHABLE from `dispatch` on every path, fresh or replay — the
   in-file Wave-6 argument survives. The story's reachability example ("whenever a caller supplies
   `--cap`") is contradicted by B1. AC5's test of the arm stands (it is exercised through the
   ledger seam); the comment records the arm's true status.
3. **AC1's row read-back lives in `tests/providers/budget-gate.test.ts`, not `dispatch.test.ts`.**
   Dispatch tests drive `RecordingLedger` (tests/fleet/helpers.ts), which has no rows to read; the
   real-ledger proof opens the sqlite file after `close()` and asserts the `gate_admissions` row's
   `ceiling_micro_usd` === the decision's `admittedCeilingMicroUsd`. The seam-stand-in note is
   commented at the dispatch-level AC1 test.
4. **`cap-hit-demo` AC4 asserts observable inheritance, not a rejection:** `runCapHitDemo` catches
   every `mintRunKey` error into `finishEarly("mint-failed")` and never rethrows, so a
   `rejects.toThrow` assertion could never go green. The test pins `artifact.reason ===
   "mint-failed"`, the `demo.mint` error log with `error.code: "cap-invalid"`, and zero keyApi
   POSTs — still failing red against an unguarded mint for the right reason (dispatch-only
   placement negative control).
5. **The lossy round-trip literal is `4_503_599_627_370_485`** (2^52−11, odd), not 2^52+1: the
   story-suggested candidate actually round-trips under the source's real order
   (`usdToMicros` does `Math.round(usd * MICRO_PER_USD)` — multiply first). Verified against the
   source-faithful expression; derivation cited in a test comment.
6. **Self-review finding RECEIVED and REJECTED with cause (guard order).** Review raised LOW: a cap
   both over-backstop and non-round-tripping (`Number.MAX_SAFE_INTEGER`) takes the round-trip arm
   and never produces the backstop message; suggested moving the backstop guard above the
   round-trip guard. Rejected: every integer ≤ the 50_000_000 backstop round-trips exactly (≤ 50
   dollars with 6 decimals fits in ≤ 26 mantissa bits), so below the backstop the round-trip guard
   would be DEAD CODE — the guard exists precisely for arbitrary-magnitude derived remainders,
   whose magnitudes are exactly the over-backstop ones. The current order (integer → round-trip →
   backstop) keeps both guards live and load-bearing; the overlap case is served by the honest
   round-trip message and pinned by the pre-existing `MAX_SAFE_INTEGER` round-trip test. INV-CAP-1
   holds under either order (the refusal is the conjunction; no mint above the backstop in any
   path).
7. **(Review round 1) The Observability Contract's row 1 premise is false — no `credential.mint`
   error line exists for this refusal.** All pre-mint guards (integer, round-trip, backstop) throw
   BEFORE `timed`, so no credential-level log line ever rides a `mintRunKey` refusal — and that was
   true of the pre-existing guards too (no `mintRunKey` refusal has ever surfaced on
   `runCredentialLifecycle`). Real observables: the `fleet.dispatch` error line with
   `payload.providerCode` "cap-invalid" (dispatch path), the `demo.mint` error line (demo path),
   nothing credential-level. Recorded, not patched: emitting a credential-level line for pre-mint
   refusals would add a log event, violating the story's own "no new log event" contract.
8. **(Review round 1) AC4's "no run record is written" is credentials-seam wording and misdescribes
   the dispatch path.** On dispatch, `deps.store.set(runId, { requestId })` runs before
   `mintAndDeliverKey`, so a request-only record (no keyHash) exists when the mint refuses. The
   tests assert the correct seam observable (`keyHash` undefined); the spec sentence's dispatch-path
   reading is false.

### Tests (all named with AC markers for grep)

- `tests/providers/credentials.test.ts`: AC4 backstop refusal (90_000_000 and 900_000_000 —
  `createKey` recorded zero times, no keyHash written, message names both values, remediation names
  the backstop), AC4 inclusive boundary (exactly 50_000_000 mints at 50.0 USD), AC3 derived
  remainder 4_837_211 round-trips and mints exactly, AC3 lossy derived cap refuses pre-mint.
- `tests/fleet/dispatch.test.ts`: AC1 the mint is asked for the decision's ceiling (1.0 — not the
  issue cap 5.0, not the backstop 50.0; the AC5 never-at-backstop pin rides here), AC2 both
  directions of the `min` (remainder binds without `--cap`; policy ceiling binds with one),
  AC5×3 underivable-budget refusals (`admission-failed` raw throw / `ledger-failed` typed
  `CostLedgerError` / `budget-exceeded` refused decision) — every arm: no box, no mint, zero run
  records.
- `tests/providers/budget-gate.test.ts`: AC2 remainder-binds (4_000_000 spent of 5_000_000 admits
  at 1_000_000 under the 50M backstop), AC2 policy-ceiling-binds (untouched issue, 50M cap, 10M
  keyCap admits at 10_000_000), AC1 the gate_admissions row carries the admitted ceiling (raw
  read-back after `close()`).
- `tests/providers/cap-hit-demo.test.ts`: AC4 the bound is minted-not-dispatch-only (shared-function
  inheritance through the demo's own catch).

### Verification evidence

- **Negative control (red), captured BEFORE the guard landed** (`/tmp/df213-red3.log`): exactly 2
  fail / 90 pass — the two AC4 refusal tests, failing because the unguarded mint SUCCEEDED. The
  story's make-or-break "must go red against shipped `main` behaviour" is proven, not asserted.
- Post-guard: credentials+cap-hit-demo 92 pass / 0 fail; dispatch+budget-gate 158 pass / 0 fail
  (derivation pins undisturbed); full suite + tsc — see the PR's CI and `.unlazy/df2-13/GATES.md`
  (G11 gate) for the tee'd full-suite log.
- **Impact (CLAUDE.md duty):** `mintRunKey` upstream = CRITICAL, 9 symbols / 5 processes —
  matching the story's recorded W6-E-L11 analysis. Every real caller enumerated
  (`dispatch.ts` `mintAndDeliverKey`, `scripts/cap-hit-demo.ts` `runCapHitDemo`, in-module
  `runCredentialLifecycle`, live-harness `mintCappedKey` at 5_000 µ$): all pass caps at or below
  the backstop, so the CRITICAL radius is realized only by the new intentional refusals — which is
  the story's point.
- **`detect_changes()`**: 6 changed files; changed symbols exactly `dispatch` (comment-only),
  `mintRunKey`, `defaultKeyCapMicroUsd` (docstring), `SBX_KEY_PREFIX` (hunk-adjacent, unchanged) +
  2 test helpers. Affected processes: 3 dispatch log flows (comment), 3 `runCredentialLifecycle`
  flows (the guard). Risk HIGH — expected for a CRITICAL-radius symbol; every affected flow
  accounted for above.

## Review Findings

**Round 1 — adversarial review 2026-09-12.** 7 reviewers (3 blind, 3 edge, 1 acceptance auditor).
Tally: 11 PATCHED / 2 DEFERRED / 12 DISMISSED. CodeRabbit re-review pending; story stays in-review.

- **PATCHED (11).** P1 the mint refusal's message/remediation names `min(remaining, backstop)`
  rather than implying the backstop alone binds (HIGH). P2 AC3's lossy test pins the round-trip
  guard's distinguishing message, not just the shared `cap-invalid` code (HIGH). P6 the dispatch
  comment rewritten to verified facts (MED — the pre-rewrite text claimed the stranded reservation
  aged out like a `no-ceiling`; see the Dev Agent Record's `dispatch.ts` bullet and deviations 7-8).
  P7 new AC4 dispatch test driving admission → mint-time `cap-invalid` → exit-1
  key-delivery-failed, plus the stranded box and the OPEN record it leaves behind (MED). P9 the
  default-keyCap binding half pinned in budget-gate (MED). P3/P4/P5/P8/P10/P11 (LOW: just-above
  boundary 50_000_001, demo `--cap` help notes, timeout comment, AC5 quote, row-uniqueness assert,
  try/finally).
- **DEFERRED (2).** Fanout `--cap-micro-usd` CLI upper bound ($1M) vs the enforced backstop —
  config-load bounding is DF2.8's filed follow-up, not this story's knob. The dispatch catch
  discards `CredentialLifecycleError`'s message/remediation (only `providerCode` survives) — an
  error-shape contract change, out of scope.
- **DISMISSED (12), verified, not argued.** NaN passes the backstop predicate — the integer guard
  throws first. Stale-citation claims (`admittedCeilingMicroUsd`, `--budget-cap`, the caller
  roster) — all verified real in source. Spy hygiene — `beforeEach` recreates keyApi/driver/store.
  Config/log isolation — per-test dirs. AC2 leg weakness — the min direction is pinned at the gate
  layer. Red-control conflation — the auditor re-verified: 2 fail = both AC4 tests. AC1 literal
  wording — disclosed as deviation 3.

Negative-control evidence re-verified: `/tmp/df213-red3.log` = 2 fail (both AC4 tests) / 90 pass
against unguarded source.
