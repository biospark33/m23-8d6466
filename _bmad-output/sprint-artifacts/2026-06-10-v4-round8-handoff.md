# Round 8 Handoff — QDS-Factory v4 Pre-Dev Adversarial Review

## What's Done

**Initial scan complete.** 7 parallel PhD-level adversarial reviewers analyzed the top 7 QDS-Factory v4 sprint stories. All findings are collated into the tracker document. Your job: execute Waves 0–5 to resolve every finding and harden the stories for dev.

## Where the Tracker Lives

```
_bmad-output/sprint-artifacts/2026-06-10-v4-round8-pre-dev-adversarial-review.md
```

This is your single source of truth. Read it FIRST. It contains:
- Status Dashboard with per-severity and per-story counters
- 9 cross-cutting themes (CC-R8-1 through CC-R8-9)
- Tracker tables: 6 BLOCKERs, 25 HIGHs, 41 MEDIUMs, 30 LOWs (102 total)
- Per-story full findings with concrete fix recipes
- Verified-correct elements (do NOT undo these)
- Session log (append-only)

## The 7 Story Files (edit targets)

| Story | File |
|---|---|
| P0.7 | `_bmad-output/sprint-artifacts/phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md` |
| P0.9 | `_bmad-output/sprint-artifacts/phase-0/stories/p0-9-hindsight-banks-mulch.md` |
| P0.3 | `_bmad-output/sprint-artifacts/phase-0/stories/p0-3-mixed-model-demo.md` |
| P1.1 | `_bmad-output/sprint-artifacts/phase-1/stories/p1-1-dev-manager-a2a.md` |
| P1.3 | `_bmad-output/sprint-artifacts/phase-1/stories/p1-3-seeds-decompose-mirror.md` |
| P1.4 | `_bmad-output/sprint-artifacts/phase-1/stories/p1-4-protocol-template.md` |
| P1.6 | `_bmad-output/sprint-artifacts/phase-1/stories/p1-6-pi-team-protocol-step.md` |

## What to Do (Wave-by-Wave)

### Wave 0 — Cross-Cutting (9 themes, fixes span ≥2 stories)
Resolve CC-R8-1 through CC-R8-9 first. Each touches multiple stories. **Bundled-by-story-file dispatch**: 7 parallel subagents, one per story file. When a CC splits across stories, each subagent handles its story's portion.

**Priority CCs:**
1. **CC-R8-1** (RegisterAgentSchema divergence) — Add `agentType?` and `endpointUrl?` to P0.7's schema; P1.1 makes both required
2. **CC-R8-2** (agentType enum) — Add `"service"` to P1.1's enum; P1.3 specifies it for qds-seeds
3. **CC-R8-3** (resolveBankId) — Fix trailing-hyphen to loop; document collision risk in P0.9
4. **CC-R8-4** (SSRF) — Add INV-4 to P1.1: hostname must be localhost
5. **CC-R8-5** (CC-9 gaps) — Add observability to P1.4; add sessionId/phaseId/timestamp to P0.3
6. **CC-R8-6** (mapping table) — Reconcile P0.3's "cross-agent" to P1.4's "summarize"
7. **CC-R8-7** (Mulch bank) — Reconcile P0.9 AC-2 to match AC-6/Technical Notes
8. **CC-R8-8** (SIGKILL) — Add 5s grace→SIGKILL to P0.7 AC6 and P1.6 INV-3
9. **CC-R8-9** (Bank ID edges) — Document resolveBankId validation requirements

### Wave 1 — BLOCKERs (6 items)
After Wave 0, P0.7-B3 and P0.9-B1 should be partially/fully resolved. Remaining:
- P0.7-B1: Expand AC7 args validation test coverage
- P0.7-B2: Add npx package allowlist
- P1.6-B1: Add `mulchPrimed: boolean` to success output schema
- P1.6-B2: Add Hindsight-unreachable behavior spec

### Wave 2 — HIGHs (25 items minus Wave 0 resolutions)
Per-story parallel subagents. Each reads the tracker finding + fix recipe, applies the edit.

### Wave 3 — MEDIUMs (41 items)
Same pattern. These are test/observability/config gaps.

### Wave 4 — LOWs (30 items)
Single bundled subagent. LOWs are 1-2 line edits — process each story sequentially.

### Wave 5 — Verification (7 parallel fresh-eyes verifiers)
**Non-skippable.** Spawn 7 verifiers that re-run the adversarial review WITHOUT being briefed on fix recipes. They will find 30-50% additional findings (this is the campaign working correctly).

### Wave 5b — Re-fix Wave-5 BLOCKERs/HIGHs
### Wave 5c — Re-fix Wave-5 MEDIUMs/LOWs

## Critical Rules

1. **Bundled-by-story-file dispatch.** One subagent per story file per wave. Never two agents editing the same .md file simultaneously.
2. **Parent-only tracker writes.** Subagents return reports. You (the parent) update the tracker.
3. **Read the fix recipe verbatim.** Don't "improve" it — if you disagree, surface it.
4. **Verified-correct elements are sacred.** Do NOT regress any item in that section.
5. **No TODO/FIXME comments.** A fix resolves the finding or escalates with a written reason.
6. **Match the existing writing style.** These are detailed spec docs — match the comment density, naming, and idiom.
7. **No severity-lowering for convenience.** A BLOCKER stays a BLOCKER.
8. **Don't skip LOWs.** Full-rigor mandate through all severities.

## How to Start

1. Read the tracker at `_bmad-output/sprint-artifacts/2026-06-10-v4-round8-pre-dev-adversarial-review.md`
2. Read the QDS Story Review skill at `/Users/steve/.claude/skills/qds-story-review/` (references subagent prompt templates, tracker format, guardrails)
3. Dispatch Wave 0 — 7 parallel subagents, one per story file, each handling that story's portion of CC-R8-1 through CC-R8-9
4. After Wave 0 completes, update the tracker and dispatch Wave 1

## Expected Outcome

When complete: 7 hardened story spec files, a tracker with all 102 findings at ✅ DONE (or ⏭️ DEFERRED with written ADR), and zero or more ADR amendments in PROPOSED state for user review.

## Architecture Context (for cross-checking)

- **SwarmClaw**: Protocol engine + agent registry + MCP bridge (P0.7)
- **CLI-Anything**: Harness translating protocol steps to Warren invocations (P0.3)
- **Warren**: Pi agent execution runtime with manifest-driven config (`.canopy/agent.json`)
- **PI extensions**: agent-team.ts, pi-pi.ts, coms-net.ts, agent-chain.ts, cross-agent.ts
- **Hindsight**: Memory bank system (retain/recall/reflect/consolidate) (P0.9)
- **Mulch**: Expertise import for agent priming with JSONL storage and NFC dedup
- **A2A**: JSON-RPC 2.0 transport between agents via local HTTP POST (P1.1)
- **Seeds**: Story decomposition with JSONL persistence and GitHub mirror (P1.3)
- **Protocol template**: 5-phase orchestration (dispatch→parallel→compare→decide→summarize) (P1.4)
- **Pi-team dispatch**: Warren harness + structured JSON capture + exit code mapping (P1.6)
