# DF-v5 Autonomy Horizon Review — Should the Factory Self-Trigger?

**Date:** 2026-08-14
**Status:** NOTE — proposed recommendation, not a decision. Extends D1/D2/D4/DD-1; amends none of them. Adoption of any item below goes through the normal design-doc decision flow as new D-numbers.
**Branch:** `docs/dark-factory-v5-design`
**Companion doc:** `2026-08-14-df-v5-control-plane-pattern-comparison.md` (pillar-by-pillar comparison against the external "control plane pattern" article; source of the diagnosis-arc blind spot referenced below).

---

## 1. The question

Is self-healing / autonomous triggering in v5's horizon? If yes, what control-plane pattern governs it, so that expansion is a designed extension rather than silent scope growth?

## 2. Current state (as decided)

- **DD-1 pins v5.0 to operator-CLI-only** (`2026-08-11-v5-story-derivation-decisions.md:38`): "Tier 1 is Claude Code + the tested fleet-dispatcher CLI; the operator is the channel. No channel story is derived." The Telegram intake (OQ-3) is BLOCKED-on-creds and explicitly deferred. The factory is pull-driven by decision, not by omission.
- **DF6.1 is the sole event-driven surface** (`epics-and-stories-dark-factory-v5.md:681-697`): a bot review comment on a factory-produced PR triggers a bounded fix run. Its *run-level* bounds are solid — signature-validated webhook before any state transition, dispatch pinned to the PR branch head, host appends commits (never force-push), two failures then human escalation, never a third run.
- **Its *internal* diagnosis arc is unbounded** — the companion comparison note's §5: no deterministic pre-filter decides what failed before the LLM wakes, and no graph constraint forces root-cause hypotheses to follow real code relationships. This is the gap any autonomy expansion would inherit and amplify.

## 3. Trigger candidates, if the horizon ever expands

Each candidate is assessed against the pattern argued for in §4: a deterministic signal layer gating it, and the existing budget/containment stack applying unchanged.

| Candidate | Deterministic signal layer that would gate it | Containment (unchanged stack) |
|---|---|---|
| **CI failure on a factory PR** (DF6.1's own webhook, hardened) | Pure-code triage: parse required-check failure output → classify failure type → GitNexus `impact`/`context` on the failing symbol → structured signal envelope in the fix brief (comparison note §5.1) | DF6.1 two-strike escalation; DF2.8 µ$ ledger; DF3.6 resident bounds |
| **Backlog draining** (auto-dispatch next story when capacity frees) | Admission function over run records + quota ledger: `checkHeadroom(n)` plus ready-story query against the backlog index — no LLM decides a run is warranted | DF2.6 orphan reaper; DF2.8 refusal-before-spawn; one run = one box = one key (R8) |
| **Telegram intake** (OQ-3, already deferred) | Message *is* the operator signal; the deterministic layer is identity + signature validation and brief-schema conformance before any dispatch | Same as any operator dispatch; plus per-channel rate caps if multi-tenant |
| **Flaky-test triage** | Stats over the trace store: failure-rate thresholds per test across runs — pure code decides "flaky" before an LLM investigates | Bounded single-run fix budget; escalation to human on inconclusive signal |

Common shape: **code decides a run is warranted; the LLM only ever investigates or executes against a pre-verified signal.** None of these require the single-agent reasoning pattern the comparison note rejects for v5 — they require the *signal discipline*, which composes with the existing three-tier architecture.

## 4. Recommendation (proposed, not decided)

1. **v5.0 stays pull-driven.** No change to DD-1. The operator-as-channel decision remains correct for the current milestone: the product's value proposition is a reviewed, audited, costed PR — the audit chain (DF5.3) currently terminates in a human approval gate (DF3.4) by design.
2. **DF6.1 remains the single sanctioned event surface, hardened before any expansion.** Adopt the two amendments from the comparison note §5 — deterministic CI-failure triage and graph-bounded fix diagnosis — as the precondition for trusting any future event surface. They are cheap (reuse DF1.4 trace store, DF1.2 envelopes, GitNexus) and they close the one arc where the factory currently reasons unbounded.
3. **Any future autonomous trigger follows one pattern, codified as a decision when the first one is adopted:** deterministic signal first (code, not an LLM, decides a run is warranted — the §3 table's gate for that trigger), graph-bounded diagnosis where investigation is needed, existing gates/budgets/escalation unchanged. Expansion enters the design doc as new D-numbers through the normal review flow — never as quiet scope growth in a story AC.

## 5. Why not adopt the article wholesale

The companion comparison note §4 covers this in full; summary: v5's artifact is a machine-verifiable diff, so coherence-by-evidence (immutable trace + audit chain + host re-verify) is the right containment for construction. The article's single-agent continuity and hypothesis-graph are earned in *diagnostic* systems whose output is a causal narrative. v5 needs exactly the slice of the article that governs DF6.1's diagnosis arc — signal discipline and graph-bounded investigation — and none of the rest.
