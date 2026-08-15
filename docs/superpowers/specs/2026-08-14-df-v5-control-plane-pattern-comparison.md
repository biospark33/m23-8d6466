# DF-v5 vs the "Control Plane Pattern" — Pillar Comparison

**Date:** 2026-08-14
**Status:** NOTE — non-binding analysis. No story ACs changed, no design-doc D-numbers amended.
**Branch:** `docs/dark-factory-v5-design`
**Source:** "Why Multi-Agent Pipelines Fail for Complex Analytics (And Control Plane Pattern That Replaces Them)" — ZS Associates pharma-analytics case study (text reviewed in-session; no archived URL). Its three pillars: (1) deterministic signal queue, (2) centralized single-agent reasoning ownership, (3) knowledge-graph control plane bounding hypothesis traversal.
**Companion doc:** `2026-08-14-df-v5-autonomy-horizon-review.md` (whether self-healing / autonomous triggering belongs in v5's horizon, and under what pattern).

---

## 1. Framing — different problems, applied honestly anyway

The article's pattern targets **diagnostic analytics**: anomaly → root-cause localization → driver attribution → action. QDS-Factory v5 is a **pull-driven lights-out software factory**: issue → sandboxed construction → host re-verify → reviewed PR (`2026-08-11-dark-factory-v5-architecture-design.md:14-19`). The pillars therefore map unevenly — by design, not by omission. Where the mismatch is itself the finding, this note says so rather than scoring v5 down for solving a different problem.

## 2. Pillar scorecard

| Pillar | v5 posture | Verdict |
|---|---|---|
| **1. Deterministic signal queue** — anomaly detection is pure code; the LLM only wakes to investigate a pre-verified signal | Determinism is pervasive for *result integrity*: fail-default phases (DF1.1, `epics-and-stories-dark-factory-v5.md:47`), the envelope adapter making code results indistinguishable from agent reports (DF1.2, `:68`), numeric cap-kill outranking agent self-report (DF2.4, `:276`), host re-verify computed only from fetched git objects (DF5.1, `:583`). But there is **no anomaly/signal layer at all** — runs are pulled (operator dispatches, DD-1 operator-CLI-only, `2026-08-11-v5-story-derivation-decisions.md:38`), not pushed. The resident agent runs per-dispatch unconditionally. | **Does not try.** The factory's "signal" is the operator. The article's cost lever — LLM sleeps until code is sure a problem exists — is unexploited. See §5. |
| **2. Centralized reasoning ownership** — ONE agent owns the diagnostic lifecycle; sub-agents return raw facts, never opinions | D2 explicitly rejects single-orchestrator designs (`2026-08-11-dark-factory-v5-architecture-design.md:296` — "operator becomes the bottleneck; no isolation"). Three tiers by design; tier-3 workers ship diffs (structured `MergedOutput`: `changedFiles`, `agentOutputs`, `comsLog`), not raw facts. | **Deliberate contradiction.** v5 bets on isolation (one run = one box = one key = one record) + audit trail, not single-brain context continuity. See §4 — the bet is defensible and in one respect stronger. |
| **3. KG control plane** — every graph edge a valid hypothesis path; agent constrained to traverse edges, never inventing relationships | GitNexus is a real, hard-mandated code KG: `CLAUDE.md:16-27` makes impact-before-edit and rename-via-graph the project's only MUST/NEVER clauses; graph freshness is a sequencing gate (`src/gate/assertions/p0-10-gitnexus.ts`). But it bounds **edits**, not **hypotheses**. The word "hypothesis" appears nowhere in the v5 design corpus. An agent may confabulate "the build broke because of X" without traversing any edge; the graph catches careless edits, not invented causal chains. | **Mechanics yes, semantic intent no.** GitNexus is a code-graph control plane that prevents careless edits; it is not a reasoning scaffold that prevents invented relationships. |

## 3. Where v5 exceeds the article's bar

The article still trusts **one agent's judgment** (a single main agent owns the lifecycle). v5 trusts **no agent's judgment** for control:

- **Engine-owns-control beats agent-owns-control.** The tier-2 resident agent "steers, never holds gate authority" — for any directive sequence the journal's phase order, gate verdicts, and status promotions must be identical to the `--no-resident` control run (DF3.3 make-or-break, `epics-and-stories-dark-factory-v5.md:446`); actions outside the closed union are `.strict()`-rejected (`:447`); the engine, not the agent, enforces the resident's own bounds (F12, `2026-08-11-dark-factory-v5-architecture-design.md:343-345`).
- **Result-integrity by code, post-hoc.** DF5.1's host re-verify computes its verdict only from fetched git objects + host toolchain — the box could not have written the evidence (`:583`). The article bounds the reasoning *shape* to prevent a wrong conclusion from forming; v5 verifies the *conclusion* by code after the fact (`verdictConsistent` even refutes self-contradicting review envelopes without reading the diff, `:69`). Different route to a related goal — and it composes: nothing prevents v5 from adding shape constraints later.
- **Three independent loop bounds vs the article's one.** DF1.3 `(R+1)×(P+1)` send ceiling per phase; DF3.6 resident iteration/RSS/spend bounds; DF6.1 two-strike human escalation. The article has max traversal depth + a significance threshold.
- **Token containment is material, not hand-waved.** Integer µ$ append-only ledger with refusal-before-spawn (DF2.8, DD-9 default cap 5,000,000 µ$), per-run key cap minted at `min(defaultKeyCap, remainingMicroUsd)` (DF2.3), resident spend ceiling strictly below the run key cap (DF3.6). The article names "token blowout" abstractly.

## 4. Verdict on the multi-agent bet

The article's core failure mode — context-handoff decay across a chain of judgment-holding agents, producing disconnected downstream actions — is real, and v5 is structurally exposed to a variant of it (tier-3 team → NDJSON harvest → host re-verify → human approval → PR spans several context boundaries). v5's mitigation is different in kind: the SQLite trace store (DF1.4) and the 10-hop audit chain (DF5.3) reconstruct the run from immutable records rather than from any agent's memory. Coherence is achieved by *evidence continuity*, not *context continuity*. That trade is sound for a construction factory, where the artifact (the diff) is itself machine-verifiable. It would NOT be sound for a diagnostic system whose output is a causal narrative — which is exactly where the article's pattern earns its keep.

## 5. The one real blind spot: the diagnosis arc

v5's *construction* arc is rigorously bounded. v5's *diagnosis* arc is not.

DF6.1 (`epics-and-stories-dark-factory-v5.md:681-697`) is the sole event-driven surface: a bot review comment on a factory-produced PR triggers a bounded fix run (two attempts, then human escalation — never a third). The run-level bounds are solid. But inside the run, when CI fails, nothing bounds the tier-3 team's root-cause search: no deterministic pre-filter decides *what* failed before the LLM wakes, and no graph constraint forces hypotheses to follow real code relationships. An agent can free-associate "build broke because of X" and burn sends chasing an invented cause within its retry budget.

Both of the article's levers apply here, and both are cheap because the infrastructure already ships:

1. **Deterministic CI-failure triage (Pillar 1, applied to DF6.1).** A pure-code step between the webhook and the dispatch: parse the CI failure output → classify the failure type → query GitNexus (`impact`/`context` on the failing symbol) for its real callers and affected processes → attach a structured signal envelope to the fix-run brief. The LLM receives a pre-verified signal with named suspects, not raw log noise. Reuses: the trace store (DF1.4), the envelope contract (DF1.2), GitNexus MCP tools — no new subsystem.
2. **GitNexus as hypothesis-bound for the fix diagnosis (Pillar 3, applied to DF6.1).** The same graph that already bounds *edits* (`CLAUDE.md` MUST clauses) should bound the *diagnosis that precedes the edit*: the fix-run brief requires root-cause hypotheses to be grounded in graph edges (failing symbol → callers → affected processes), and the review gate checks that the diagnosed cause is consistent with the triage signal. This is a framing extension of existing rules, not new infrastructure.

**Explicitly non-binding:** these are candidate amendments to DF6.1's spec, recorded here and in the companion horizon review. Adopting them means editing the story ACs through the normal review flow — nothing in this note changes the backlog.

## 6. Conclusion

v5 does not satisfy the article, and mostly should not try: it solves a different problem, and on containment (engine-owned control, post-hoc code verification, layered budgets) it is in places more rigorous than the pattern it is being measured against. The article's genuine contribution to v5 is narrow and actionable: the *investigation* slice of the feedback loop is currently unbounded, and the fix — signal triage + graph-bounded diagnosis — reuses infrastructure that already exists.
