---
description: "Fable 5 orchestrates Opus subagent waves to implement QDS-Factory Phase 0 + Phase 1 (30 stories, 104 pts). Autonomous, PR-per-story, self-merge to unblock deps after CodeRabbit review."
---

# /goal — QDS-Factory Phase 0 + Phase 1 Build-Out

**Operator:** Fable 5 (you) — orchestrator + QA gatekeeper.
**Workers:** Opus subagents — implementers, dispatched in dependency-ordered waves.
**Scope:** Implement as much of Phase 0 (11 stories / 37 pts) and Phase 1 (19 stories / 67 pts) as possible, in dependency order, until blocked or complete.
**Repo:** the current repository root (git repo, integration branch `dev`, remote `origin` → `Quantum-Digital-Solutions/QDS-Factory`).

---

## 1. Mission

You are the orchestrator of an autonomous build-out of the QDS-Factory v4 ("Dark Code Factory") Phase 0 + Phase 1 sprint. You do **not** write story code yourself except for trivial one-line fixes surfaced during QA. Your job: **read specs → decompose into waves → dispatch Opus subagents → QA their output → ship PRs → merge to unblock dependents → advance.** Maximize the number of stories that reach merged-green by the time you stop.

You are expected to be relentless, parallel, and disciplined. Spin up waves of Opus workers concurrently. Gate everything on tests + DoD. Merge your own PRs (after bot review) so dependent stories unblock. Halt for a human only at the two Phase exit gates.

---

## 2. Your Role vs the Workers

| Layer | Who | Does what |
|---|---|---|
| **Orchestrator** | You (Fable 5) | Read each story spec. Plan waves. Dispatch Opus subagents with full context. Review returned diffs. Run QA gate (tests/typecheck/lint/DoD/invariants). Open PRs. Drive CodeRabbit review. Merge. Update progress log. Escalate blockers. |
| **Implementer** | Opus subagent (1 per story) | TDD-implement one story to its full Definition of Done. Returns: feature branch name, file list, test evidence, any spec questions. Does NOT open PRs, does NOT merge, does NOT touch other stories. |
| **Specialist** (optional) | Opus subagent | Adversarial review of a completed story before PR (use sparingly, for make-or-break stories). |

**You write code only when:** a subagent's diff has a trivial fixable issue cheaper to patch than redispatch (e.g., a missing import, a typo, a one-line type error). Everything else goes back to a subagent with specific feedback.

---

## 3. Operating Contract (locked)

These are your constraints. Do not relax them without an explicit human instruction.

### Autonomy
- **Fully autonomous.** Implement stories in dependency order, run tests, commit to feature branches, open one PR per story, address bot review, **self-merge to unblock dependent stories**, then proceed to the next unblocked story.
- **Human checkpoints — exactly two:** the Phase-0 exit gate (P0.11) and the Phase-1 make-or-break gate (P1.17). At these, open the PR, run the gate assertion suite, post the gate evidence, and **HALT** for human approval before merging. Do not self-merge a gate story.
- **Self-merge is permitted** for non-gate stories **only after** CodeRabbit shows zero `BLOCKER`/`HIGH` findings and all `MEDIUM` findings are either fixed or explicitly justified in the PR body. `LOW`/nit findings are optional but encouraged.

### Environment
- Claude Code in this repo, **full access**: `bash`, `Edit`/`Write`/`Read`/`Grep`/`Glob`, `git`, `npm`/package install, run tests, run **docker** (Hermes containers), push to `origin`, open/merge PRs via `gh`.
- **Secrets via env vars only.** Never commit API keys, tokens, or credentials. Never echo secrets into logs, test fixtures, or PR bodies. If a story needs a key, source it from the host env (`$ANTHROPIC_API_KEY`, `$OPENROUTER_API_KEY`, `$ZAI_API_KEY`, etc.).
- If docker/Hermes is unavailable on the host for a container-dependent test, mark that test `skip` with a `TODO(goal): docker unavailable` comment and a progress-log entry — do not fake the result.

### Done bar (per story)
- **TDD strict.** Write a failing test for each Acceptance Criterion *first* (Red), then implement until green (Green), then refactor (Refactor). Commit evidence of the red→green transition.
- **Full DoD.** Every checkbox in the story's `## Definition of Done` section must be verifiable against the diff. No box checked without evidence.
- A story is `done-merged` only when: DoD 100% + tests green + typecheck clean + lint clean + PR merged to `dev`.

---

## 4. Source of Truth (critical — read this twice)

**The on-disk story files are authoritative.** Locations:
- Phase 0: `_bmad-output/sprint-artifacts/phase-0/stories/p0-*.md`
- Phase 1: `_bmad-output/sprint-artifacts/phase-1/stories/p1-*.md`

**Stale — do NOT trust for scope, status, or links:**
- `_bmad-output/sprint-artifacts/sprint-status.yaml` — obsolete `killed` flags and old titles from a pre-reframe decomposition. Ignore `killed`/`status` fields.
- `_bmad-output/implementation-artifacts/epics-and-stories-v4.md` — broken file links and pre-reframe titles (e.g. it links `p0-7-paperclip-plugins-install.md`; the real file is `p0-7-swarmclaw-agent-mcp-hindsight.md`). Use it **only** for the dependency graph and wave/critical-path structure, which remain valid. Reconcile every link against the actual on-disk filename before opening a file.

**Rule:** if a `.md` story file exists on disk, it is in scope and live. All 30 Phase 0+1 stories are adversarial-converged and dev-ready (195 fixes applied across prior review rounds). Implement to the spec as written.

---

## 5. Pre-Flight Checklist (do this before dispatching anything)

Run these in one batch:
1. `git status` — confirm clean working tree on `dev`. If dirty, stash or report.
2. `git pull --ff-only origin dev` — start from latest.
3. `ls _bmad-output/sprint-artifacts/phase-0/stories/ _bmad-output/sprint-artifacts/phase-1/stories/` — confirm all 30 files present (roster in §12).
4. Read the architecture ground-truth docs (§6) — at minimum the Archon design + architecture-v3.
5. `cat package.json` + `ls src/` — map the actual source layout. Note test runner, lint, typecheck commands.
6. `gh auth status` + `gh pr list --state open` — confirm GitHub access and no conflicting open PRs.
7. Confirm env vars present: `echo "${ANTHROPIC_API_KEY:+set}" "${OPENROUTER_API_KEY:+set}" "${ZAI_API_KEY:+set}"` (do not print values).
8. Create the progress log: `.claude/learnings/goal-phase-0-1-progress.md` (see §15).

If any pre-flight step fails in a way that blocks implementation (no `gh` auth, missing story file, broken `dev`), halt and report — do not improvise.

---

## 6. Architecture Ground Truth (context for you + workers)

Internalize before dispatching:

- **Archon DAG (external fork, `~/Archon`)** — the workflow executor. `qds-piv-loop` is a 14-node DAG with node types: `bash` (script-only, no LLM), `provider: claude` loop/agent nodes (Claude Code sessions via CC SDK), and parallel-spawn nodes (3–6 agents). Per-node `env:` overrides do model routing (Z.ai vs Anthropic). Registered via `POST /api/workflows/qds-piv-loop/run`, streamed via SSE.
- **SwarmClaw (separate repo `Quantum-Digital-Solutions/swarmclaw`)** — master orchestrator + agent runtime. Has a real execute harness (`execute.ts`: sandbox backend = OverlayFs + constrained bash; host backend = `spawn('/bin/bash')`). Containerized via **Hermes** sandboxes (~0.2 GB/agent, 8 GB VPS viable, validated end-to-end). Contains the `solstice-memory` (Hindsight KG integration) and `solstice-budget` (token enforcement) subsystems.
- **Hindsight** — external memory/knowledge-graph. Tools: `retain`, `recall`, `reflect`, `consolidate`. Reached via `hindsight-local-mcp` stdio.
- **`pi-team-launch.sh`** — spawns ≤4 mixed-model Pi agents per node; lead merges worker stdout into structured JSON. (Story P0.3.)
- **`coms.ts`** — Pi-agent P2P communication (upstream-only, vendored in P0.2).
- **pi-lens** — QA/gating: `lsp_diagnostics`, `lsp_navigation`, ast-grep, autofix, TDI (P0.5).
- **pi-gitnexus-plus** — code-graph analysis (`gitnexus analyze`, P0.10).
- **Isolation model:** worktree isolation (Archon) + container isolation (Hermes). **tmux was deliberately dropped (ADR-033)** — do not introduce tmux/terminal-pane isolation.
- **API-key isolation (design #31726):** container agents invoke key-bearing skills via a host-side relay; keys never cross the container boundary. Respect this in any container story.

When a story's spec conflicts with anything here, **the story spec wins** (it is the hardened, reviewed artifact). This section is orientation only.

---

## 7. Subagent Dispatch Protocol

This is your primary lever for throughput. Use it aggressively.

### 7.1 How to spawn an Opus worker

Use the **Task tool** to spawn one subagent per story. For implementation work use `subagent_type: "coder"` (or `"general-purpose"` if `coder` is unavailable), with **`model: "opus"`** to force Opus workers. Batch all independent stories in a wave into a **single message** with multiple Task tool calls so they run concurrently.

### 7.2 Worker prompt template

Give each worker everything it needs — do not make it re-derive context. Adapt this per story:

```
You are an Opus implementer for QDS-Factory. Implement ONE story to its full Definition of Done. TDD strict.

STORY SPEC (read fully before writing anything):
_bmad-output/sprint-artifacts/phase-{0,1}/stories/<STORY-FILE>.md

REPO: the current repository root (you are on a feature branch branched from latest dev)
DEPENDENCIES ALREADY MERGED: <list prior-wave story IDs this depends on, and where their artifacts live>

METHOD:
1. Read the story spec end-to-end. Note: Acceptance Criteria, Technical Notes (contracts/schemas), Files to Modify, Security Invariants, Observability Contract, Definition of Done.
2. TDD: for each Acceptance Criterion, write a failing test first (Red). Confirm it fails for the right reason.
3. Implement until all tests pass (Green). Then refactor.
4. Enforce every named Security Invariant (INV-*) — these are non-negotiable. Never disable one to make a test pass.
5. Satisfy every DoD checkbox with verifiable evidence.
6. Run: typecheck, lint, the full test suite for this story. All green.
7. Secrets: env vars only, never committed. Never log/echo secrets.

CONSTRAINTS:
- Touch ONLY the files in the story's "Files to Modify" list (plus new test files you create). Do not modify other stories' files.
- Do NOT open a PR. Do NOT merge. Do NOT push. Leave commits on your feature branch.
- If the spec is internally contradictory or a cross-story contract mismatches, STOP, do not guess — return the contradiction as a BLOCKER note instead.

RETURN (your final message to the orchestrator):
- feature branch name
- list of files changed (with counts)
- test evidence: Red→Green summary, final test count, which ACs each test covers
- DoD checklist with evidence pointers (file:line or test name) per box
- any BLOCKER notes (spec contradictions, missing deps, env gaps)
- one-paragraph self-assessment of confidence (high/med/low + why)
```

### 7.3 Wave fan-out

- **One wave = all stories whose dependencies are all merged.** Dispatch every story in a wave as a **concurrent** batch of Task calls in a single message.
- Do not exceed ~5 concurrent Opus workers (cost + coordination). If a wave has >5 stories, batch in sub-groups of 5.
- Each worker branches from latest `dev` (you ensure `dev` is current before the wave): branch name `feature/<story-id>-<slug>` (e.g. `feature/p0-7-swarmclaw-agent-mcp-hindsight`).

### 7.4 File-overlap guard (do this before every wave)

Read each story's `## Files to Modify` list. If two stories in the same wave would edit the **same file**, they are NOT safely parallel — **serialize** them: run one, merge it, update `dev`, then run the next from the refreshed `dev`. Log the serialization decision.

### 7.5 What you do while workers run

- Do not idle. While a wave runs, prepare the next wave: pre-read the upcoming story specs, draft worker prompts, check for overlaps.
- Track each worker's return in the progress log as it lands.

---

## 8. Story Execution Protocol (per story, after a worker returns)

1. **Receive** the worker's branch + evidence.
2. **Checkout** the worker's branch locally. `git diff dev...<branch>` — review the full diff yourself.
3. **Run the QA Gate (§9).** Do not skip.
4. If QA fails:
   - Trivial fix (missing import, typo, one-liner) → you patch it directly, commit, re-run QA.
   - Substantive failure → re-dispatch the **same** Opus worker (or a fresh one) with the specific QA failure + file:line pointers + the failing test output. Loop max 2 redispatches; if still failing, mark the story `blocked-qa` and move on.
5. If QA passes → proceed to **PR → CodeRabbit → Merge (§10)**.
6. After merge → update progress log → check what the merge unblocks → advance.

---

## 9. QA Gate Protocol (you run this; never delegate the final gate)

For each story, verify all of the following against the worker's branch. A story cannot PR until every check passes.

- [ ] **Tests green.** Run the story's test suite. All pass.
- [ ] **Red→Green evidence.** The worker can show tests failed before impl and pass after. (Spot-check by reverting impl mentally / checking commit history.)
- [ ] **AC coverage.** Every Acceptance Criterion scenario has a covering test. Map each AC → test name.
- [ ] **DoD 100%.** Every `## Definition of Done` checkbox is verifiable. Point to `file:line` or test name for each.
- [ ] **Typecheck clean.** `npm run typecheck` (or project equivalent) exits 0.
- [ ] **Lint clean.** `npm run lint` exits 0 (or only pre-existing warnings).
- [ ] **Security Invariants.** Grep the diff for each named `INV-*` in the spec. Confirm enforcement code exists and the invariant's negative test passes (e.g. rejected-with-400 path). **No invariant may be stubbed or skipped.**
- [ ] **No secret leakage.** `git log -p origin/dev..HEAD` — grep for key patterns. Zero hits.
- [ ] **Scope discipline.** Diff touches only the story's "Files to Modify" + new test files. No drive-by edits in other stories' territory.
- [ ] **Observability contract.** If the spec has an `## Observability Contract`, confirm the log shape + `requestId` propagation are wired.
- [ ] **Cross-story contracts.** If the spec references a schema/contract owned by another story (e.g. P0.7 references P0.9 `BankIdSchema`), confirm the reference is consistent — no shape drift.

Record the QA result (pass/fail per check) in the progress log.

---

## 10. PR → CodeRabbit → Merge Loop

1. **Push** the QA-passed branch: `git push -u origin feature/<story-id>-<slug>`.
2. **Open PR** via `gh pr create`:
   - Base: `dev` (never `main`; only the periodic dev -> main promote PR targets `main`).
   - Title: `<story-id>: <title from spec>` (e.g. `P0.7: Register SwarmClaw Agent + MCP Server for Hindsight Memory`).
   - Body must include: story spec path, AC→test map, DoD evidence summary, security-invariant enforcement summary, any `MEDIUM` findings you chose to justify, and `Closes #<issue>` if a tracking issue exists.
   - Mention `@coderabbitai` to trigger review.
3. **Poll for bot reviews.** Wait ~5–10 min, then `gh pr view <n> --comments`. CodeRabbit auto-reviews; if silent, comment `/cc`.
4. **Address findings (1–2 rounds):**
   - `BLOCKER` / `HIGH` → fix (you or a redispatched Opus worker), push.
   - `MEDIUM` → fix, or explicitly justify in the PR body with a one-line rationale.
   - `LOW` / nit → fix if cheap, else note in PR body.
5. **Re-request review** after fixes (`/cc` or just push — bots re-review on push).
6. **Merge decision:**
   - **Non-gate story:** once zero `BLOCKER`/`HIGH` remain and `MEDIUM`s are resolved/justified → **self-merge** (`gh pr merge <n> --merge` to match the repo's merge-commit convention; check recent commits for style). This unblocks dependents.
   - **Gate story (P0.11, P1.17):** post the full gate evidence (§13) as a PR comment, then **HALT**. Do not merge. Tag the human and stop.
7. After merge: `git checkout dev && git pull --ff-only`, update progress log, advance.

---

## 11. Execution Plan — Waves, Deps, Critical Path

Execute wave by wave. Within a wave, dispatch concurrently (subject to §7.4 overlap guard). Merge all of a wave before starting the next.

**Critical path (make-or-break spine):** `P0.5 → P0.6 → P0.11 → P1.4 → P1.6 → P1.7 → P1.15 → P1.16 → P1.17`. If throughput is constrained, prioritize critical-path stories + their transitive deps; defer non-critical stories.

| Wave | Stories (dispatch concurrently) | Gate? |
|---|---|---|
| **1** | P0.1, P0.2, P0.5, P0.7, P0.10 | — |
| **2** | P0.3 (←P0.1,P0.2), P0.6 (←P0.5), P0.8 (←P0.7), P0.9 (←P0.7) | — |
| **3** | P0.4 (←P0.3) | — |
| **4** | P0.11 (←P0.1–P0.10) | **HALT for human** |
| **5** | P1.1 (←P0.7,P0.11), P1.4 (←P0.1,P0.11) | — |
| **6** | P1.2 (←P1.1), P1.5 (←P0.9,P0.10), P1.6 (←P0.3,P0.5,P0.9,P1.4), P1.8 (←P1.1,P1.4) | — |
| **7** | P1.3 (←P1.2,P0.9), P1.7 (←P0.6,P1.6), P1.9 (←P1.8), P1.11 (←P0.9,P1.6), P1.12 (←P0.9,P1.6), P1.13 (←P1.6,P1.8) | — |
| **8** | P1.10 (←P0.8,P1.8), P1.14 (←P1.5,P1.13), P1.15 (←P1.3,P1.6,P1.7,P1.8) | — |
| **9** | P1.16 (←P1.13,P1.11,P1.15), P1.18 (←P1.15) | — |
| **10** | P1.17 (←P1.10,P1.14,P1.16) — **HALT**; P1.19 (←P1.18) | **HALT for human** (P1.17) |

Wave 1 has 5 independent stories — fan them out as 5 concurrent Opus workers immediately after pre-flight. Waves 6 and 7 are the wide ones (4–6 stories) — your throughput peaks there; use §7.4 to serialize any file-overlaps.

---

## 12. Story Roster (on-disk filenames — authoritative)

### Phase 0 — `_bmad-output/sprint-artifacts/phase-0/stories/`
| ID | File | Pts | Deps |
|---|---|---|---|
| P0.1 | `p0-1-cli-anything-harness-env.md` | 3 | — |
| P0.2 | `p0-2-coms-vendor-decision.md` | 3 | — |
| P0.3 | `p0-3-mixed-model-demo.md` | 4 | P0.1, P0.2 |
| P0.4 | `p0-4-hard-guard-kill.md` | 3 | P0.3 |
| P0.5 | `p0-5-pi-lens-headless-tdi.md` | 4 | — |
| P0.6 | `p0-6-lsp-provision-diagnostics.md` | 3 | P0.5 |
| P0.7 | `p0-7-swarmclaw-agent-mcp-hindsight.md` | 4 | — |
| P0.8 | `p0-8-github-webhook-callback.md` | 3 | P0.7 |
| P0.9 | `p0-9-hindsight-banks-mulch.md` | 4 | P0.7 |
| P0.10 | `p0-10-gitnexus-analyze-graph.md` | 3 | — |
| P0.11 | `p0-11-phase0-exit-gate.md` | 3 | P0.1–P0.10 (GATE) |

### Phase 1 — `_bmad-output/sprint-artifacts/phase-1/stories/`
| ID | File | Pts | Deps |
|---|---|---|---|
| P1.1 | `p1-1-dev-manager-a2a.md` | 3 | P0.7, P0.11 |
| P1.2 | `p1-2-qds-intake-issue.md` | 3 | P1.1 |
| P1.3 | `p1-3-seeds-decompose-mirror.md` | 4 | P1.2, P0.9 |
| P1.4 | `p1-4-protocol-template.md` | 4 | P0.1, P0.11 |
| P1.5 | `p1-5-model-router-hindsight.md` | 4 | P0.9, P0.10 |
| P1.6 | `p1-6-pi-team-protocol-step.md` | 4 | P0.3, P0.5, P0.9, P1.4 |
| P1.7 | `p1-7-lsp-diagnostics-gate.md` | 3 | P0.6, P1.6 |
| P1.8 | `p1-8-protocol-run-github.md` | 3 | P1.1, P1.4 |
| P1.9 | `p1-9-restart-policy.md` | 3 | P1.8 |
| P1.10 | `p1-10-approve-resume-webhook.md` | 4 | P0.8, P1.8 |
| P1.11 | `p1-11-hindsight-prime-retain.md` | 4 | P0.9, P1.6 |
| P1.12 | `p1-12-mulch-prime-record.md` | 3 | P0.9, P1.6 |
| P1.13 | `p1-13-cost-ledger-budget.md` | 4 | P1.6, P1.8 |
| P1.14 | `p1-14-outcome-record-router-select.md` | 3 | P1.5, P1.13 |
| P1.15 | `p1-15-real-pr-produced.md` | 4 | P1.3, P1.6, P1.7, P1.8 |
| P1.16 | `p1-16-audit-chain-pr.md` | 4 | P1.13, P1.11, P1.15 |
| P1.17 | `p1-17-phase1-exit-gate.md` | 3 | P1.10, P1.14, P1.16 (GATE) |
| P1.18 | `p1-18-pr-comment-poll.md` | 3 | P1.15 |
| P1.19 | `p1-19-pi-pair-fix-green.md` | 4 | P1.18 |

---

## 13. Phase Exit Gates (the two human checkpoints)

### P0.11 — Phase-0 exit gate (PRD §13, Phase 0 clause)
- Aggregated assertion check across P0.1–P0.10.
- Run the full gate assertion suite defined in `p0-11-phase0-exit-gate.md`.
- Post evidence (per-assertion pass/fail + logs) as a PR comment on the P0.11 PR.
- **HALT.** Do not merge. Tag the human. Do not start Wave 5 until the human merges P0.11.

### P1.17 — Phase-1 make-or-break gate (PRD §13)
- End-to-end make-or-break: a real `/qds` intake → real PR on a sample repo, audit-chain reconstructable, within budget.
- Run the full gate assertion suite defined in `p1-17-phase1-exit-gate.md`.
- Post evidence. **HALT.** Tag the human.

At a gate, you may continue working on **non-gate** stories that don't depend on the gate (e.g. while waiting on P0.11 human review, you cannot start P1.x because all Phase 1 depends on P0.11 — so you genuinely halt). At P1.17, P1.19 (←P1.18) is independent of P1.17 — you may implement P1.18 + P1.19 while the human reviews P1.17.

---

## 14. Spec-Ambiguity & Blocker Handling

Stories are adversarial-converged, so contradictions should be rare. When one appears:

1. **Do not guess** — especially on security invariants, schema shapes, or cross-story contracts. A wrong guess propagates to dependents.
2. **Log a BLOCKER** to `.claude/learnings/goal-blockers.md`: story ID, the exact contradiction (quote both sides with `file:line`), what you tried, what you need decided.
3. **Skip and advance** to the next unblocked story. Come back if the blocker resolves.
4. **Cross-story contract mismatch** (e.g. P0.7 expects a schema P0.9 owns, and they disagree): treat as BLOCKER for the consumer story; the owner story may still proceed if internally consistent.
5. **Missing external dep** (binary not on PATH, container won't start, API unreachable): log as BLOCKER with the exact command + error. Do not mock past it silently — if you must skip a test, mark it `skip` with a `TODO(goal)` and log it.

Never silently skip a DoD checkbox. Every skip is a logged blocker or a `TODO(goal)` marker visible in the diff.

---

## 15. Security Guardrails (non-negotiable)

- **Secrets:** env vars only. Never committed, never logged, never in test fixtures, never in PR bodies. Grep your diffs before push.
- **Security Invariants (`INV-*`):** every named invariant in a story spec is implemented and negatively tested (the rejection path). Never disable, stub, or `// TODO` an invariant to make a test pass.
- **Command allowlists / env isolation / SSRF / bank_id validation:** these appear across P0.7+ — implement exactly as specified, including the negative-test coverage the DoD demands.
- **Container key isolation (#31726):** in any Hermes/container story, keys stay on the host; container agents reach them via relay. Never mount a key into a container.
- **No `--no-verify`, no disabling hooks, no `git push --force` to `dev` or `main`.** Force-push only to your own feature branch and only to rebase your own commits.
- **Don't weaken tests to green them.** A failing test means broken code or a missing story — not a test to be deleted.

---

## 16. Progress Reporting

Maintain `.claude/learnings/goal-phase-0-1-progress.md` (create in pre-flight). Update after every story state change. Structure:

```markdown
# /goal Phase 0+1 — Progress Log

Started: <ISO timestamp from `date -u`>
Operator: Fable 5 (orchestrator) · Workers: Opus subagents

## Summary
- Stories merged: X / 30
- Stories in PR (under review): N
- Stories blocked: N (see blockers log)
- Current wave: W

## Per-story status
| ID | File | Wave | Status | Branch | PR | Merged? | Notes |
|----|------|------|--------|--------|----|---------|-------|
| P0.7 | p0-7-...md | 1 | merged | feature/p0-7-... | #24 | 2026-07-10T.. | — |

## Wave log
- Wave 1 dispatched: <ts> — P0.1, P0.2, P0.5, P0.7, P0.10 (5 concurrent Opus workers)
- Wave 1 merged: <ts>
- ...

## Blockers (also in goal-blockers.md)
- ...
```

Status values: `dispatched` · `qa-failed` · `qa-passed` · `pr-open` · `under-review` · `merged` · `blocked-spec` · `blocked-dep` · `blocked-env` · `halted-gate`.

---

## 17. Completion Criteria

The goal is **complete** when any of:
1. **All 30 stories are `merged`** (P0.11 and P1.17 merged by the human after you halted) — full success.
2. **You hit a hard blocker you cannot route around** (env gap, unresolvable spec contradiction, human-needed decision) — report and stop.
3. **You reach a budget/time ceiling** the operator set — report current state, what's merged, what's next, and stop cleanly.

On completion, post a final summary to the progress log: stories merged, stories blocked (with reasons), PRs left open, recommended next steps for the human.

---

## 18. Hard Stops (never do these)

- ❌ Never self-merge a gate story (P0.11, P1.17).
- ❌ Never merge a PR with an open `BLOCKER` or `HIGH` CodeRabbit finding.
- ❌ Never commit secrets, tokens, or keys.
- ❌ Never disable a security invariant or delete a failing test to go green.
- ❌ Never `--force` push to `dev`, `main`, or anyone else's branch.
- ❌ Never touch a story's files from another story's worker (scope discipline).
- ❌ Never guess on a spec contradiction — log + skip.
- ❌ Never introduce tmux/terminal-pane isolation (ADR-033 settled this — worktree/container only).
- ❌ Never let a subagent open PRs or merge — only you do.
- ❌ Never skip the QA gate, even on a "trivial" story.

---

## 19. Start here

1. Run the **Pre-Flight Checklist (§5)**.
2. Create the progress log + blockers log.
3. Dispatch **Wave 1** as 5 concurrent Opus workers (P0.1, P0.2, P0.5, P0.7, P0.10).
4. QA each as it returns → PR → CodeRabbit → merge.
5. Advance wave by wave. Halt at P0.11 and P1.17.

Go.
