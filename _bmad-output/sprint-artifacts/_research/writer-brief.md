# QDS-Factory v4 — Story Writer Brief (read first)

You are a story-writing agent for the QDS-Factory v4 "Dark Code Factory" sprint plan.
Produce ENTERPRISE-GRADE, END-TO-END story spec files (Markdown — NOT code).

## Non-negotiable constraints (operator-mandated)

1. **Story points: 3 or 4. Hard cap.** If your assigned story feels >4pts, you have mis-scoped it — tighten the slice, do NOT exceed 4. Flag in your receipt if it genuinely cannot fit.
2. **Every story is an END-TO-END VERTICAL SLICE with NO leftover wiring.** The story ships a demonstrable capability using only code it merges. No `TODO: wire later`, no stub another story must finish to make THIS behavior real. Genuine predecessors are **dependency edges** (listed), not unfinished wiring inside the story. Include the standardized **Wiring closed** assertion (see template).
3. **Stack:** TypeScript/Node + Postgres + CLI + multi-agent (Archon DAG, Pi 0.55.0 teams, Paperclip control plane @ localhost:3100, Hermes manager). Contracts = **Zod / TS types / JSON / SQL DDL** (NOT Python/Pydantic).
4. **DOD: 8–12 high-signal checkboxes.** No project-wide CI filler (no "lint clean / tests pass / typecheck"). Categories: Implementation · Testing (incl. one mandatory **e2e-demo** box that asserts the exit-criterion) · Contracts/Schema · Observability/Audit · Security Invariants (when triggered) · Integration.
5. **Normative content ≤200 lines** (excl. Dev Agent Record). **`## Files to Modify` ≤10 paths.**
6. **`## Security Invariants` is MANDATORY and non-empty when ANY security-trigger applies** (auth, secrets/env, migration/schema, input/file, tenant, cost/budget). `N/A` is FORBIDDEN when triggered — write concrete named invariants. Your assigned row lists the triggers.

## Required sections (exact order — must pass the Phase-2.5 atomicity audit)

Use the skeleton in `_research/r1-story-template.md` verbatim:
`# {ID}: {Title}` (+ **Story Points:** line) → `## Spec Reference` → `## User Story` → `## Overview` → `## E2E Slice` (+ Wiring closed assertion + dependency edges) → `## Acceptance Criteria` (≥3 Given/When/Then; tag one **[make-or-break]**, binary) → `## Technical Notes` → `## Files to Modify` → `## Security Invariants` (when triggered) → `## Definition of Done` (8–12) → `## Dev Agent Record` (empty placeholder).

## Ground-truth sources (READ as needed — do NOT invent APIs/columns/paths)

- `_research/r1-story-template.md` — the skeleton + worked E2E example. **Copy it.**
- `_research/r2-fr-nfr-pack.md` — verbatim FR/NFR text. Cite your story's FR/NFR ids in `## Spec Reference`.
- `_research/r3-arch-contracts-schemas.md` — layers, audit chain, 3-site env patch (file:line), real schemas (`heartbeat_runs`, `cost_events`/`createCostEventSchema`, Seeds `.seeds/issues.jsonl`, Paperclip `issues`/`agents`/`approvals`, plugin-install API). Use REAL columns/endpoints.
- `_research/r4-external-deps-contracts.md` — versions + load-bearing call shapes (Pi coms, pi-lens, Paperclip REST, Archon DAG, Seeds/Mulch, Hindsight, GitNexus, model routing).
- The PRD itself: `/Users/steve/QDS-Factory/_bmad-output/planning-artifacts/prd-qds-factory-v4.md` — read the §/FR ranges your row references for exact exit-criterion wording.

## Honesty about UNVERIFIED / blocked facts (from R4 — reflect, do not paper over)

- **Telegram plugin: BLOCKED on creds** → Hermes-gateway fallback. Stories touching Telegram (P0.8, P1.10) MUST carry the fallback as an explicit AC/Technical-Note, not assume the plugin works.
- **pi-lens TDI is TUI-only**; headless path = read `~/.pi-lens/` artifacts or warning-count proxy + §9.3 fallback flag. P0.5/P1.7 must spec the fallback.
- **Hindsight local stack: blocked on env** (OpenSSL/arch) — direction is self-host, round-trip unproven. P0.9 must spec cloud-vs-self-host decision (OQ-4) + the round-trip as the proof.
- **coms live round-trip** needs an API key (only the contract-loads is proven). 
- **Cost emission gap:** Pi has ZERO Paperclip integration; `pi-team-launch.sh` (not yet on disk) is the SOLE `cost_events` emitter. There is **no `cost` column on `issues`** — per-issue cost = `SUM(cost_events.costCents) WHERE issueId=:id`. OpenRouter `/generation` cost shape unverified → fallback `heartbeat_runs.usageJson` (estimated, flagged).
- **Archon env patch** already spike-proven on branch `qds/env-patch-spike`, base SHA `536584db` — P0.1 is "productionize + non-regression gate", not greenfield.

## Output protocol (DUAL OUTPUT)

1. **Write** the full story file to `_bmad-output/sprint-artifacts/phase-{0|1}/stories/{slug}.md` using the `Write` tool.
2. **Return** to the orchestrator a COMPACT receipt per story (≤120 words each): `{id} | {slug}.md | pts | normative-line-count | #DOD boxes | #files | security-invariants present? (Y/N + why) | 1-line of the make-or-break AC`. Do NOT paste the full story back.

Match the A6 enterprise quality bar: precise, testable, spec-referenced, no hand-waving.
