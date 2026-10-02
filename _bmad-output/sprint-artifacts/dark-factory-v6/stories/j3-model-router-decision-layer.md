# J3: Model-Router Decision Layer — Dispatch Picks a Tier, and the Pick Is Provable

**Story Points:** 5
**Sprint:** v6b — Autonomy (judgment tier; E21-independent, runs on v6a artifacts only)
**Status:** ready-for-dev — pre-dev campaign (qds-story-review) runs before any dev lane starts

> **Decision of record (NET-NEW — flag for the DD-14+ register, Jev-register note):** the tier **applied** at dispatch is picked
> by the deterministic composite score — weights in code. The cheap Jev L5 ask's tier answer is **recorded as a recommendation**,
> never applied in v6b: D-5 holds the Jev LOCKED set verbatim, including "recording-only until measured". M3.2's weekly
> reflect→PROPOSE (operator-applied, FR-LEARN-30 shape) is therefore the only route by which a Jev recommendation ever becomes an
> applied routing change. Arming remains J2's gated business (milestones + operator sign-off, DD-21).
> **Flex-cut of record (charter :106):** J3 is the SECOND named cut — past the pre-authorized trigger (headroom ~52 (register
> DD-14a note); cut order per DD-26(4); this numeric trigger is derived, proposed for the operator to pin at review)
> this story moves whole to v7; the residue is stated in Technical Notes, decided now, not mid-sprint.

## Spec Reference

- Charter `2026-10-01-v6-derivation-session-INPUT.md` — §3 v6b J3 row; §2.3 ten-levels mapping (L3 composite scoring → dispatch prioritization + pre-dispatch risk tier; L5 intent/model routing → v4 FR-LEARN-30 successor); §0 D-4 (JudgmentProvider seam — "adapter pattern so future jev-like tier-1 systems swap in") + D-5 (LOCKED set holds verbatim).
- `_bmad-output/planning-artifacts/prd-qds-factory-v4.md:420` (FR-LEARN-30, verbatim in R1) — weekly-propose-never-auto-apply; the v4 `qds-model-router` config concept is realized here as weights-in-code, not a config file.
- Jev handoff §3 — LOCKED #1 (host-side), #5 (recording-only), #7 (egress classes), #9 (no severity calibration), #10 (S1 is a pre-router): consumed via D-5, cited not restated.
- Sibling contracts consumed unmodified: **J1**'s `JudgmentProvider` seam (interface + per-adapter contract tests) — the router enters the seam through the seam client's public `judge()` imported via the `src/judgment` barrel (index.ts), never a deep `src/judgment/client.ts` or `src/judgment/adapters/*` import, never a direct `ask()` call outside the seam client, and never a concrete adapter import; **M1.2**'s harvest-time idempotent-retain path (P2.8 fold: stable dated `documentId`, `updateMode: "replace"`).
- `docs/superpowers/specs/2026-08-14-df-v5-autonomy-horizon-review.md` §4.3 standing rule (deterministic signal first — code, not an LLM, decides; the L3 score IS that signal).
- R3 facts: `src/judgment/` surface, `EnvelopeSchema`/`TYPESAFE_MODEL` drift alarm, `EGRESS_CLASSES`, roster resolution `resolveSlug` (`src/phase-engine/roster/schema.ts:226-258`), dispatch roster parse (`src/fleet/dispatch.ts:83`).

## User Story

As the operator paying per token across model tiers,
I want dispatch to pick each story's tier from a deterministic code-owned score — with the cheap Jev router's independent recommendation recorded beside it, envelope provenance attached —
so that every tier selection is explainable and re-derivable from its own log line today, and M3.2's weekly reflect mines decisions instead of folklore.

## Overview

`src/judgment/router.ts` (new, beside the existing judgment modules) runs once per dispatch, between brief validation and manifest assembly: it scores host-side dispatch features with named-weight constants (the L3 composite), maps the score to a story-shape and a pre-dispatch risk tier, and the shape + score pick the **applied** model tier from a code-owned tier table. One cheap Jev ask — through J1's seam client (`JudgmentClient.judge()`, imported via the `src/judgment` barrel, the seam's only public door) and nothing else — records the L5 recommendation for the same shape; applied tier, recommendation, score components, and the envelope's `requestId` land as one `.sandbox/routing-log.jsonl` line, and the envelope itself goes to the existing provenance side channel. At harvest the decision summary retains idempotently into `{baseId}-dev-meta` (M3.1's `*-meta` family — the dev lane is the router's consumer, v4 `:575`) through M1.2's path.

**What this does not deliver, stated before an AC implies otherwise:** no arming (J2 owns measured thresholds + operator sign-off), no calibration, no auto-applied config (M3.2 proposes; the operator applies), no new verb or flag, no audit-chain hop, nothing in-box (LOCKED #1), and no gate authority of any kind — a routing decision never gates code entry, which stays fleet-only (charter §6).

## E2E Slice

**Demonstrable behavior:** Given two dispatches of the same repo whose brief/manifest features straddle a named weight boundary, When each dispatch runs with the fake driver and `TYPESAFE_MOCK=1` (the INV-J5 default — no key, no spend), Then each writes exactly one `.sandbox/routing-log.jsonl` line `{ workKey|issueId, runId, shape, risk_tier, applied_tier, score: {<feature>: value…}, jev_recommendation, jev_requestId, jev_skipped?, created_at }`; the applied tier rides the roster's role→model resolution through the unchanged validator; the Jev envelope sits in `_bmad-output/judgment/provenance/` under the logged `jev_requestId`; and a harvest retains one idempotent `{baseId}-dev-meta` document per decision.

**Wiring closed:** On completion of this story, every dispatch produces a re-derivable tier decision — score, shape, applied tier, recorded recommendation, provenance — using only code merged by this story plus J1's seam and M1.2's retain path. **No stub, no `TODO: wire later`.** The M3.2 reflect that *reads* the log is out of scope by construction (its own story).

**Dependency edges (predecessors):** J1 — direct: the seam is the only Jev door. M1.2 — direct: the idempotent-retain helper and its dated-`documentId` discipline.

> **Not an edge — J2:** nothing here consumes or awaits calibration milestones; the applied path consumes no Jev numeric (AC1), so J2's unlock changes nothing in this module. **Not an edge — M3.2:** it reads `.sandbox/routing-log.jsonl` read-side; the log schema is this story's owned contract. The charter's M3.2 row carries no J3 dep — that is exactly why the log exists as a standalone artifact.

## Acceptance Criteria

1. **(make-or-break — one door, and the door is the seam; the pick is code)** Given any dispatch, When the router runs, Then the **applied** tier is a pure function of the named-weight composite score over host-side features, and the Jev recommendation is obtained **only** through the seam client's public `judge()` imported via the `src/judgment` barrel (index.ts) — the choke/ceiling/strict-parse/envelope/provenance policy is non-delegable and lives in the seam client ahead of every `ask()` (DD-28.11), so `ask()` alone could never mint the envelope + `jev_requestId` this AC requires. *Negative controls, all four MUST fail:* an implementation importing the seam client deeply (`src/judgment/client.ts` directly, or any `src/judgment/adapters/*` module / concrete adapter) instead of the barrel export re-couples the router to jev-the-vendor and defeats D-4's swap-in seam while passing every behavior test; one that calls the provider's `ask()` directly outside the seam client bypasses the non-delegable neutral-layer policy (no choke, no envelope, no provenance emit) and MUST fail; one whose applied tier reads any Jev answer field (`choice`, `confidence`, `probabilities`) treats uncalibrated confidence as J2-style arming — recording-only (D-5, LOCKED #5) holds verbatim and this story's v6b applied path consumes **zero** Jev numerics; one that writes a routing decision for a SUCCESSFUL ask without the envelope emitted to the provenance side channel and its `requestId` on the log line ships an unprovable pick (the envelope + `requestId` requirement binds the ask-succeeded path ONLY — a skipped or failed ask proceeds deterministically per AC2 with `jev_skipped: {reason}` and owes no Jev provenance); and one reading the weights or the tier table from any env/config surface instead of the named constants in `router.ts` MUST fail — config invites silent drift with no alarm, and this story's only weight invariant is determinism + re-derivability (AC3).
2. **The Jev ask can never fail a dispatch, and the log never lies about it.** Given a dispatch whose Jev ask times out, errors, or is skipped, When the router completes, Then dispatch proceeds on the deterministic tier and the log line records `jev_recommendation: null` plus `jev_skipped: {reason}` — exactly one log line per dispatch either way, appended under a single-writer posture (the corpus-lock idiom — `acquireRunLock` on the log dir, `CORPUS_LOCK_ID` precedent — so two concurrent dispatches never interleave or drop a line; the whole-file temp+rename dance is NOT the append idiom here), never rewritten. *Negative control: an implementation whose router throw aborts dispatch, or delays the mint ordering to make room for the ask, MUST fail — a cents-class ask sitting on the critical path of a billable verb is the exact failure this AC forbids.*
3. **The pick is re-derivable from the line alone.** Given one routing-log line, Then the logged feature values plus the in-code weights reproduce `shape`, `risk_tier`, and `applied_tier` exactly (a test re-derives the tier from logged components for every fixture dispatch); features are enumerated host-side dispatch inputs (brief/manifest metrics, roster shape, prior-outcome rates from `.sandbox/runs/`), and each weight is a named constant with a stated derivation. *Negative control: an implementation whose log line omits any score component — the tier then resting on inputs no log can show — MUST fail this one.*
4. **The applied tier reaches the box only through the validated roster surface.** Given the router's tier, When dispatch applies it, Then it overrides the roster's role→model resolution from a code-owned tier table **before** the unchanged `src/phase-engine/roster/validate.ts` validation, so a tier naming an invalid `(provider, model)` pair is refused exactly like a hand-written one; the override carries through manifest assembly and a round-trip test proves it reaches the engine (the config-drop trap class). *Negative control: an implementation applying the tier as a post-validation env override, or by editing brief prose, bypasses the DF1.5-validated shape and MUST fail.*
5. **Harvest retains the decision idempotently, digest-stable.** Given a harvested run with routing decisions, Then one `{baseId}-dev-meta` document per decision retains via M1.2's path with stable baseId `routing-<runId>` and `documentId = "routing-<runId>-dev-meta"` (the `{baseId}-dev-meta` family convention M3.1's `*-meta` family uses) and `updateMode: "replace"` (P2.8 fold), carrying shape, applied tier, recommendation, and outcome linkage — with no envelope volatile fields (answers, confidence, latency) in any digest-stable emit (INV-J3). *Negative controls, both MUST fail: a re-harvest creating a second document (non-idempotent), and a volatile field entering a digest-stable row — the divergent-tamper alarm class DF5.3 exists to prevent.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| dispatch-time routing decision (score → applied tier + recorded Jev recommendation) | in-scope | `tests/judgment/router.test.ts` | — |
| Jev ask unavailable/skipped → deterministic tier + `jev_skipped` | in-scope | `tests/judgment/router.test.ts` | — |
| tier applied via roster-resolution override, carried to the engine (round-trip) | in-scope | `tests/fleet/dispatch-router.test.ts` | — |
| harvest-time idempotent meta-bank retain of decisions | in-scope | `tests/judgment/router.test.ts` (M1.2 retain seam) | — |
| M3.2 reading the log / proposing tuning | out-of-scope — M3.2's story; this log schema is its read contract | — | M3.2 |
| J2 arming: recommendation calibrated into an applied pick | out-of-scope — J2's gate (milestones + operator sign-off, DD-21); the applied-path pivot is a register decision, not a story edit | — | J2 |
| operator per-dispatch tier override flag | out-of-scope — no charter row; deferred until M3.2 produces proposals worth overriding | — | none scheduled |
| new audit-chain hop for routing decisions | out-of-scope — `AUDIT_HOPS` frozen (DF5.3); the JSONL + provenance side channel are the store | — | none |
| in-box model selection of any kind | out-of-scope — LOCKED #1 host-side placement | — | none |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| `JudgmentProvider` seam | J1 (`src/judgment/`, per-adapter contract tests) | `bun test tests/judgment/` green before this story starts |
| dispatch fake-driver path | `src/fleet/dispatch.ts` | `bun test tests/fleet/dispatch.test.ts` green before start; green again after with the adds-only hook the only delta |
| idempotent-retain helper | M1.2 (P2.8 fold, `{baseId}-dev-meta`) | M1.2's retain tests green; consumed, never re-implemented |
| mock Jev | `TYPESAFE_MOCK=1` default (INV-J5) | default mode; **no live Jev spend is a prerequisite** — an optional live probe (cents-class, `TYPESAFE_API_KEY` + `QDS_LIVE_PROBE_CONFIRMED=1`) stays operator-gated per Jev §8 |

> Not a prerequisite: any box, any T2 round, any E21 lane. J3 is lane-2 (R5 §4.2) and depends on v6a artifacts only.

## Technical Notes

- **One ask per dispatch, one stage, one ceiling.** The router holds its own `JudgmentCeiling` instance (1M input tokens, the stage default); egress class `ac-prose` (the ask ships brief prose + manifest facts; no diff hunks exist at dispatch — pre-code by construction — so the stage-2 ZDR gate is untouched). The ask runs through the seam client's public `judge()` imported via the `src/judgment` barrel — never a deep `client.ts`/`adapters/*` import, never a direct `ask()` outside the seam client, never a concrete adapter import — because the choke, ceiling admit, strict parse, envelope build and provenance emit are non-delegable seam-client policy (DD-28.11) and only `judge()` returns the envelope + `requestId` this story logs. Vendor mean latency ~220ms and cents-class cost (jev-live-r1) are why a per-dispatch recorded recommendation is affordable without batching.
- **Ordering against dispatch, written so a dev does not re-derive it.** The router runs after brief validation and before manifest assembly (the tier must ride the roster into the box), and sits **off** the mint/admission ordering — `runCredentialLifecycle` in `src/providers/credentials.ts` is untouched, and a router failure folds to the deterministic tier + `jev_skipped` (AC2), never an exit-code change. The wiring shape is pinned against the box import-closure trap: `src/judgment/` is NOT in the box COPY set, and `dispatch.ts` sits outside both build entries' import closures today — so a static judgment import would be silently tolerated until any closure growth reds the box build, and the obvious fix (COPY `src/judgment/`) violates host-side placement (INV-JR-1). The dispatch hook is therefore a **typed dep with a no-op default** (`router?: RoutingHook` on `DispatchDeps`, the existing injection surface), and the real router is wired host-side in `scripts/fleet.ts` — the same file the harvest-side retain add already touches. `src/fleet/dispatch.ts` changes are **adds-only** (hot shared path; region ownership as DF3.8 stated it; **coordinated with M2.2's adds-only memory-key provision-leg region on the same file — DD-28.26(5)**); `src/fleet/verbs.ts` is untouched (no new verb, no new flag, exit table unchanged).
- **The dispatch edit moves the image — the re-pin is owed, and it batches.** `src/fleet/` is in the box COPY set (`oci/exedev/Dockerfile`), and any byte change to a copied file moves `deriveBuildId` (DF3.8 precedent: a comment-only diff moved the image). This story's adds-only dispatch edit therefore owes the full re-pin ritual at merge — ops-gated, zero agent spend until operator GO (charter §6) — and batches into the once-only wave-0 ritual per DD-28.2 + DD-28.26(4) (tree M1.2 + J3 + J4 + A2), so v6b pays once. The harvest-side retain add rides `scripts/fleet.ts` (M1.2's landed seam) — outside the COPY set, no additional image move.
- **Contracts/Schema — `.sandbox/routing-log.jsonl` is this story's owned contract.** One JSON line per dispatch; the AC1 field set is registered adds-only; strict-parse at read; consumers (M3.2, A5) read and never write. `jev_requestId` is the join key to the provenance side channel; the envelope is never inlined into the line.
- **Weights in code, deliberately not config.** A config file would invite silent drift with no alarm; named constants with per-weight derivations get named by tests. The drift-alarm pattern belongs to pinned vendor contracts (`TYPESAFE_MODEL`); weights get the cheaper invariant: determinism + re-derivability (AC3).
- **Flex-cut residue, stated now.** If the second cut fires (J3 → v7): the shipped behavior reverts to the status-quo roster (the adds-only dispatch hook is the single revert point); no routing log exists; M3.2 reflects on A5 KPIs alone, and A5's routing dimension reports absent-not-0. No orphan readers — M3.2/A5 must tolerate the log's absence by their own specs.
- **Considered and rejected: applying the Jev recommendation today.** It would make the router feel "real" sooner but violates D-5's recording-only limb (holding verbatim), and the applied-path pivot would then ride a story edit instead of a register decision. The unlock lives in DD-21 (J2's milestones + operator sign-off); revisit there, measured — not here.

## Observability Contract

- Per dispatch: one **house log** line (J1's `operation:"judge"` convention — distinct from `.sandbox/routing-log.jsonl`, this story's owned decision log): `{ requestId, runId, event: "routing-decision" | "routing-skip", router_ms, shape, risk_tier, applied_tier, jev_ask_ms? }`. The house log's `requestId` is the Jev envelope id — the same value carried as `jev_requestId` on the `.sandbox/routing-log.jsonl` line — and is **absent on skip paths** (no ask, no envelope, no id). `routing-skip` carries `reason ∈ features-unavailable` — no runtime disable switch is scoped (the flex-cut revert point is the dispatch hook itself; a compiled-out hook emits no line, which is correct, not a skip). `jev_ask_ms` (and any ask sub-timing) is **absent, not `0`, when the ask was skipped** — `0` is a lie shaped exactly like an instantaneous ask.
- `jev_skipped` reasons on the log line are enumerated: `timeout | vendor-error | ceiling-exceeded | egress-refused | provider-unavailable` — never free-text.
- No `TYPESAFE_API_KEY` material in any line (INV-J1, inherited); errors carry `{ code, message, remediation }`; envelope volatile fields ride the provenance side channel only (INV-J3); the pinned `TYPESAFE_MODEL` literal stays THE drift alarm (envelope, untouched).

## Files to Modify

- `src/judgment/router.ts` (new — composite score, named weights, tier table, seam-mediated ask, log-line writer; the only substantial new module)
- `src/judgment/index.ts` (adds-only — barrel export of the router's public surface)
- `src/fleet/dispatch.ts` (adds-only — the typed `router?: RoutingHook` dep on `DispatchDeps` (no-op default) plus its single invocation between brief validation and manifest assembly, with the typed skip fold; no `src/judgment` import, static or dynamic; re-pin owed, see Technical Notes)
- `src/phase-engine/roster/schema.ts` (adds-only — the tier-override input to role→model resolution; hand-written rosters unchanged)
- `scripts/fleet.ts` (adds-only at M1.2's landed harvest-retain seam — include the run's routing-decision summary in the retained payload; **not** in the box COPY set, no image move. `src/providers/harvest.ts` is the box-side evidence module, COPY-set (`oci/exedev/Dockerfile:344`), and is NOT touched)
- `tests/judgment/router.test.ts` (new — determinism, re-derivability, seam fence, recording-only, degradation, idempotent retain)
- `tests/fleet/dispatch-router.test.ts` (new — adds-only ordering + tier round-trip carry through validation)

## Security Invariants

- **INV-JR-1 (host-side placement — LOCKED #1):** the router, its ask, and its log live host-side; no new module enters the box COPY set. What this does not fence, said plainly: the adds-only `dispatch.ts` edit is inside the COPY set and owes the ops-gated re-pin (Technical Notes) — the harvest-side retain add lives in `scripts/fleet.ts`, outside the COPY set; the invariant bounds *where judgment runs*, not the ritual shipping it triggers.
- **INV-JR-2 (recording-only — D-5, LOCKED #5, verbatim):** no Jev answer gates anything; the applied path consumes no Jev numeric; fleet stays the only code-entry path (charter §6) — a routing decision never gates code entry, and the only route to an applied recommendation is M3.2's PROPOSE → operator apply.
- **INV-JR-3 (provenance — INV-J3 inherited verbatim):** envelope volatile fields never enter digest-stable emits; the side channel carries the envelope; the log line carries `requestId` only.
- **INV-JR-4 (frozen stores untouched):** `AUDIT_HOPS` (`src/audit/link-store.ts`), gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope`, and the provider layer import rules are byte-identical; routing decisions ride the JSONL + provenance side channel, never the audit chain.
- **INV-JR-5 (key discipline — INV-J1 inherited verbatim):** the API key never hardcoded, logged, or in-box; mock is the default everywhere; live spend needs explicit operator GO (Jev §8).

## Definition of Done

- [ ] **Impl:** `src/judgment/router.ts` — named weights, code-owned tier table, determinism asserted on identical inputs; the applied tier is a pure function of the score (AC1, AC3).
- [ ] **Contract:** `.sandbox/routing-log.jsonl` strict schema, adds-only, one crash-safe line per dispatch, `jev_requestId` → provenance envelope join (AC1, AC2).
- [ ] **Integration:** the adds-only dispatch hook lands between brief validation and manifest assembly; the roster override round-trips through unchanged `validate.ts` to the engine (AC4).
- [ ] **Test (seam fence):** a grep fence asserts `router.ts` imports `JudgmentClient` from the `src/judgment` barrel (index.ts) and invokes its `.judge()` method (the barrel-exported client class — the method-based contract AC1 and the Overview name; there is no barrel-exported `judge()` function) — a deep `src/judgment/client.ts` or `src/judgment/adapters/*` import, any concrete adapter import, or any direct `ask()` call outside the seam client MUST fail.
- [ ] **Test (recording-only):** the applied path consumes no Jev answer field — an implementation feeding `choice`/`confidence`/`probabilities` into the pick MUST fail (AC1).
- [ ] **Test (degradation):** timeout, vendor-error, ceiling-exceeded, egress-refused, and provider-unavailable paths all proceed on the deterministic tier with enumerated `jev_skipped` reasons; `jev_ask_ms` absent-not-0; the mint ordering unchanged (AC2).
- [ ] **Test (log integrity under concurrency):** two concurrent fake-driver dispatches produce exactly two strict-parseable `.sandbox/routing-log.jsonl` lines — never an interleave, never a dropped line (AC2's corpus-lock single-writer posture, `acquireRunLock`).
- [ ] **Test (import-closure fence):** a grep fence asserts `src/fleet/dispatch.ts` contains no `src/judgment` import, static or dynamic — any such import MUST fail; the router reaches dispatch only as the typed `RoutingHook` dep wired host-side in `scripts/fleet.ts`.
- [ ] **Test (provenance):** envelope emitted to the side channel per ask; `requestId` on the line; volatile fields excluded from every digest-stable emit; re-derivation of tier from logged components passes for all fixtures (AC3, AC5).
- [ ] **Test (retain):** the `routing-<runId>-dev-meta` document (baseId `routing-<runId>`) retains idempotent on re-harvest via M1.2's path (AC5).
- [ ] **Security:** zero-diff on `AUDIT_HOPS`, gate-runner verdict logic, `classifyRunExit`, `classifyDiffScope`; no key material in any log; mock-default asserted; re-pin coordinated (not fired) — its firing stays ops-gated.
- [ ] **Test (e2e demo — MANDATORY):** fixture-seeded `.sandbox` + two fake-driver dispatches of different shapes → two distinct log lines with re-derivable tiers, provenance envelopes present, idempotent meta documents retained. **Explicitly non-live:** no box, no spend — J3 sits outside R5 §4.3's live-round list, and a seeded fixture is legitimate evidence here because every behavior under test is host-side.

## Dev Agent Record

*(written at implementation time, not at spec time.)*
