# Session 13 Handoff Prompt — Orchestrator Decision Closure + Guidance Lift ADRs

**Date:** 2026-04-11
**From:** Session 12 (bias-stripped ruflo evaluation; orchestrator re-confirmation)
**To:** New conversation for ADR authoring, doc amendments, and code-lift manifest updates
**Goal:** Execute the 5 concrete next steps from session 12's findings without re-running the evaluation
**Primary reference:** `_bmad-output/planning-artifacts/session12-ruflo-evaluation-findings.md` — read this first

---

## Copy-Paste This Block as Your First Message to the New Conversation

```text
I'm picking up QDS Factory work from session 12. Session 12 did a bias-stripped
re-evaluation of overstory vs ruflo as the agent orchestration base, using
structural graph queries via `npx gitnexus cypher` against KuzuDB indexes of
both repos. The decision landed: keep overstory as base, lift
@claude-flow/guidance into Factory Core as the enforcement layer, do not adopt
ruflo. Full evidence and rationale is in:

  _bmad-output/planning-artifacts/session12-ruflo-evaluation-findings.md

Read that document end-to-end before doing anything else. It contains the
bias-stripped invariant re-derivation (Part A), structural evidence from
Cypher queries (Part B), the rubric scores (Part C), the decision (Part D),
corrections to prior analysis (Part E), the 5 concrete next steps (Part F),
the cold-start reading list (Part G), operational environment facts (Part H),
and open questions (Part I).

After reading, also read these persistent memory files:
  <repo-root>/memory/qds_orchestrator.md  (user-local Claude memory)
  <repo-root>/memory/gitnexus_cypher.md   (user-local Claude memory)

Your job this session is to execute all 5 concrete next steps from Part F:

  Step 1: Author ADR-033 (or next free number) closing the orchestrator
          re-evaluation question, referencing session12 findings as evidence.
  Step 2: Author ADR-034 specifying the @claude-flow/guidance lift into
          Factory Core, with scope decisions on which of the 32 files to
          lift, which to defer, and which to drop. Reference session12
          findings Part B for the structural coupling analysis and Part F
          Step 2 for the tier-1/tier-2/drop file classification I proposed.
  Step 3: Author ADR-035 specifying the hook engine strategy (dual-plane:
          retain edge-plane hooks-deployer unchanged + add in-process Factory
          Core engine; do NOT lift @claude-flow/hooks wholesale — verified
          coupling to ReasoningBank stack).
  Step 4: Update _bmad-output/implementation-artifacts/code-lift-manifest.md
          and code-lift-gap-analysis.md with the new guidance lift entry and
          risk entries per session12 Part F Step 4.
  Step 5: Targeted correction pass through architecture-v2.md to disambiguate
          mechanism from invariant wherever the conflation creates decision
          ambiguity. Do NOT rewrite the whole doc — this is surgical.

Before starting, verify operational environment:
  - Check ADR numbering in session10-amendments file so the new ADRs don't
    collide with existing numbers
  - Confirm indexes are fresh: `npx gitnexus list` should show overstory
    (indexed 2026-04-11) and ruflo (indexed 2026-04-11)
  - Check current git branch and create session13/orchestrator-decision-closure
    (or similar) branch before editing artifacts

Follow the session12 recommendations on scope decisions in ADR-025:
  (a) Full lift of compiler/gates/proof/ledger/retriever/continue-gate/memory-gate
      (tier 1, ~8 files)
  (b) Drop wasm-kernel.ts (defer WASM hot path)
  (c) Defer evolution.ts + optimizer.ts (premature A/B benchmarking)
  (d) Likely keep adversarial.ts (prompt-injection defense, small and
      self-contained)
  (e) Defer trust.ts decision until spike (634 LOC, adds state complexity)
  (f) Defer temporal.ts + uncertainty.ts (long-horizon modeling, not MVP)

But re-evaluate these if your own reading of the guidance source changes
the calculus. The tier proposals are educated guesses from session12's
structural analysis, not gospel.

For the hook engine ADR-035, resist the temptation to lift @claude-flow/hooks
wholesale. The session12 cypher analysis confirmed it drags ReasoningBank
(v3/@claude-flow/memory/src/hnsw-index.ts, v3/@claude-flow/embeddings, 
v3/@claude-flow/neural/src/reasoning-bank.ts). The accepted architecture is
dual-plane per ADR-035: (1) retain overstory's hooks-deployer.ts unchanged
as the edge plane (generates bash scripts for Claude Code / Pi runtime guards),
(2) build a separate ~400 LOC in-process Factory Core hook engine in
factory-core/src/hooks/ that gates/evaluators from ADR-034 bind against.
Do NOT extend hooks-deployer.ts — leave it as overstory upstream's domain.

Conventions:
  - Commit style: `<action>: <summary>\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
  - No force-push, no commits to main, no destructive git ops without
    explicit user approval
  - Work branch: session13/<description>
  - ADRs live in _bmad-output/planning-artifacts/architecture-v2-session12-amendments.md
    (create if missing) or extend the existing session10-amendments file —
    check which pattern session 11 followed
  - Planning artifacts never go in the repo root; always under
    _bmad-output/planning-artifacts/ or _bmad-output/implementation-artifacts/

Anti-patterns to avoid:
  - Re-running the ruflo evaluation from scratch (session 12 already did it;
    the findings doc is authoritative)
  - Editing architecture-v2.md beyond the targeted correction pass in Step 5
  - Lifting ruflo code into factory-core/ without an ADR authorizing the
    specific files
  - Treating overstory mechanisms (tmux, worktrees, mail.db) as invariants
    in new ADR text — session12 Part A explicitly reclassified these as
    implementation choices
  - Creating new files at the repo root (per root CLAUDE.md rules)

When you finish each step, update the task list (use TaskCreate/TaskUpdate)
and pause for user review before moving to the next step. Steps 1-3 are
independent ADRs and can be drafted in parallel if you spawn subagents via
the Task tool, but the user will probably want to review each before moving
on. Steps 4 and 5 are dependent on steps 1-3 being approved.

Work in imperial, bulletproof, PhD-level mode. This is enterprise
architecture work — the artifacts you produce here are going to be the
reference for every story in the factory pipeline from this point forward.
Cite file paths + line numbers when referencing code. Use tables for
decisions with alternatives. Justify every choice structurally, not by
argument from authority.

Start by reading the findings doc. Then confirm you understand the 5
steps and ask any blocking clarifying questions before touching artifacts.
```

---

## Why This Handoff Works (Meta)

**The findings document does the heavy lifting.** Everything the new conversation needs to execute is in `session12-ruflo-evaluation-findings.md` — invariants, structural evidence, rubric, decision, corrections, step-by-step instructions, reading list, environment facts, open questions. The handoff prompt above is just the pointer + execution directives.

**Persistent memory catches long-horizon bleed.** `qds_orchestrator.md` and `gitnexus_cypher.md` will be auto-loaded if a future session re-opens either question. Even if the findings doc gets archived, the core decision and the tooling pattern survive in the memory layer.

**No structural re-derivation required.** The hardest intellectual work of session 12 was re-reading 7,416 lines of PRD/architecture docs with bias stripped and running 20+ Cypher queries. Session 13 should never need to repeat either. If it does, something went wrong with the findings doc.

**Scope is bounded and ordered.** Five numbered steps with explicit acceptance criteria. No "and while you're at it..." slippage. The user can review step-by-step rather than being handed a giant commit at the end.

**Anti-patterns are explicit.** The most likely failure mode is "new conversation redoes the analysis because it doesn't trust the old one." The handoff prompt explicitly forbids that and points at the structural evidence as authoritative.

**Environment checks first.** Before any artifact edits: verify ADR numbering collision, confirm indexes are fresh, check git branch. Catches the boring operational issues before they derail the substantive work.

---

## What Session 13 Should Look Like at the End

A clean git branch `session13/orchestrator-decision-closure` containing:

1. New ADR-033, ADR-034, ADR-035 written into the amendments file (or a new `architecture-v2-session12-amendments.md`)
2. `code-lift-manifest.md` with a new "Ruflo — @claude-flow/guidance Extraction" section
3. `code-lift-gap-analysis.md` with 2 new risk entries
4. `architecture-v2.md` with targeted annotations or rewrites in places that conflated mechanism with invariant (scope-limited — no rewrite)
5. Optionally: a new Story 1.9 (or next free number) in `epics-and-stories.md` for the guidance lift spike
6. A session 13 handoff document for the next session (Session 14 would start implementation of the guidance lift spike)

No factory-core/ code changes yet. This is a planning session, not an implementation session. Implementation starts in session 14+ after the ADRs are approved.

---

**End of handoff prompt. The new conversation's first action is: read `session12-ruflo-evaluation-findings.md` end-to-end.**
