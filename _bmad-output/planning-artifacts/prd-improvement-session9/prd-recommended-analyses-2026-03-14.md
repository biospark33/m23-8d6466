# PRD Recommended Analyses — QDS Engineer v2

**Date:** 2026-03-14
**Context:** Post-SWOT, pre-architecture. Analyses ordered by impact and workflow phase.

---

## High Priority (Pre-Architecture)

### 1. FR Dependency Graph & Critical Path Analysis

The PRD has a sequencing section, but it doesn't fully map which FRs are blocked by which others beyond the top-level implementation order. A formal dependency graph would expose hidden blockers — e.g., how many FRs depend on Phase Boundary Protocol being correct before they can be implemented. This directly informs sprint planning sequencing and identifies where a wrong design decision cascades most widely.

### 2. Assumption Validation Inventory

The PRD carries several load-bearing assumptions that are never validated: Pi SDK actually supports GLM-5 at the claimed latency/cost profile, Overstory's SQLite concurrency handles 15 agents without contention, CopilotKit + AG-UI can be integrated into a React 19 + Vite stack, the `gh` CLI supports all required PR operations. These assumptions underpin entire FR clusters. An explicit validation inventory — listing each assumption, the FRs it supports, and a test/spike to confirm it — would dramatically reduce architecture risk.

### 3. NFR Conflict & Feasibility Analysis

The 40 NFRs were written somewhat independently. Some may conflict: NFR5 (30fps with 12 xterm.js panels) + NFR25 (16GB RAM minimum) + NFR17 (15 concurrent SQLite agents) on a developer laptop are all hitting the same hardware simultaneously. A conflict analysis would identify which NFRs need relaxation, ordering, or explicit mitigation before architecture commits to them.

### 4. Security Threat Model (STRIDE)

The PRD has strong security NFRs (NFR9-NFR13, NFR33) but no threat model. For a system that: acts as a git actor on production codebases, holds API credentials, runs autonomous agent processes, accepts commands via Telegram, and creates PRs — STRIDE modeling would surface threats the NFRs don't address. Particularly relevant: spoofing (Telegram auth), tampering (learning records, meta-optimization journals), information disclosure (credentials in logs).

---

## Medium Priority (Informs Architecture)

### 5. Epic Decomposition Readiness Review

Are the 145 MVP FRs granular enough to decompose into implementable stories without ambiguity? The PRD has a scoping-to-FR mapping, but some FRs (FR28, FR32, FR77) are multi-faceted enough that two developers could interpret them differently. A readiness review flags FRs that need splitting or clarification before architecture translates them into epics.

### 6. Integration Contract Analysis

The integration map (Pi SDK, GitHub `gh` CLI, Overstory, Telegram Bot API, CopilotKit, AG-UI) identifies touchpoints but doesn't define contracts. What are the exact API shapes, failure modes, and versioning commitments for each? Especially Pi SDK and AG-UI — these are the two highest-uncertainty integrations and both are load-bearing for core differentiators.

### 7. Cost Model Validation

The ~3-5% quality pipeline cost claim is the economic foundation of the "quality feels free" value proposition. This should be validated with actual Pi SDK pricing for GLM-5 on a representative story (typical token volume across BMAD + 5 QA waves) before it becomes a committed success metric. If the actual cost is 15-20%, the differentiation claim changes significantly.

---

## Lower Priority (Pre-Growth)

### 8. Competitive Landscape Update

The PRD's competitive analysis reflects the market as of early 2026. Given market velocity, a quarterly refresh — particularly watching for new agent frameworks, Cursor's roadmap, and GitHub Copilot Workspace capabilities — would keep the positioning honest.

### 9. Go/No-Go Decision Framework

What objective criteria would cause the team to not proceed with an MVP launch, or to pivot the scope mid-development? Defining this upfront (e.g., "if Pi SDK GLM-5 cost exceeds X, defer economy-tier routing to Growth and pin to Sonnet") prevents scope debates under pressure from becoming subjective.

### 10. User Acceptance Criteria Review

The FRs have acceptance criteria, but for the most complex capabilities (Phase Boundary Protocol context isolation, Factory Learning injection, meta-optimization auto-revert), verifying the ACs are actually testable in a 2-developer environment without specialized harnesses is worth a pass before implementation begins.

---

## Recommended Sequencing

| If your next step is... | Start with... |
|-------------------------|---------------|
| Architecture document | #1 FR Dependency Graph, #2 Assumption Validation |
| Managing implementation risk | #3 NFR Conflicts, #7 Cost Model Validation |
| Security review | #4 STRIDE Threat Model |
| Sprint planning | #5 Epic Decomposition Readiness, #1 FR Dependency Graph |
