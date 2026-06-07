# P1.15: `/qds` to a real PR — the assembled vertical slice produces the make-or-break artifact

**Story Points:** 4

## Spec Reference

- PRD §10 Phase-1 (the make-or-break flow F1) + §13 Phase-1 clauses 3–4; FR-OR-1, FR-OR-7, FR-EX-6
- Supporting: NFR-OBS-1 (run streams SSE + persists run log), NFR-OBS-3 (cross-component handoff logged w/ issue-id correlation), NFR-SAF-4 (no dirty-diagnostics emit)
- Phase exit gate: PRD §13 Phase-1 clauses 3 ("a DAG runs and reaches the Pi-team implement node … emits a single structured JSON result") and 4 ("A real PR is produced on a sample repo"). This story is the F1 make-or-break artifact.

## User Story

As the Operator,
I want a single `/qds <request>` to drive the assembled slice — intake → Seeds decompose → `qds-mkbrk` implement node → post-edit LSP gate → a REAL PR opened on a sample repo — with no manual hop in between,
so that the Phase-1 make-or-break artifact (G1: ≥1 real reviewed PR from a Telegram `/qds` with no human input except gated approvals) is produced mechanically end-to-end.

## Overview

This is the wiring-closure slice: it assembles already-built predecessors into ONE runnable path and adds the only net-new pieces needed to reach a PR — the `finalize` node that commits the implement node's `changed_files` to the run's worktree branch and opens the PR, plus the run-log persistence that correlates the PR to its originating issue (FR-OR-7). It cuts through Hermes (intake→Archon launch) → a minimal `qds-mkbrk` DAG authored by this story (4-node: `intake` → `implement` → `lsp-gate` → `finalize`; SSE-audited, worktree-isolated). The full 14-node PIV loop was killed per Warren decision (P1.4); this make-or-break path uses only the nodes needed to produce a real PR → implement bash node (`pi-team-launch.sh`, FR-EX-6 merged JSON) → post-edit `lsp_diagnostics` gate (P1.7) → `finalize` node (git commit + `gh pr create`). It is one atomic 4pt unit because the make-or-break artifact (a real PR) is not real until every assembled seam runs in sequence to a PR URL — splitting "open the PR" from "run the slice" would leave the PR as leftover wiring.

## E2E Slice

**Demonstrable behavior:** A single `/qds "<sample task>"` (via the FR-CM-1 intake; Hermes-gateway fallback if the Telegram plugin is unconfirmed — r4 §3) runs the full slice end-to-end and produces a real PR on the sample repo: the `qds-mkbrk` run reaches the implement node (single merged JSON result, FR-EX-6), passes the post-edit `lsp_diagnostics` gate (0 errors or logged waiver), the `finalize` node commits `changed_files` to the run's worktree branch and runs `gh pr create`, and the run log (captured SSE stream, FR-OR-7) records the PR URL correlated to the originating Paperclip issue id. The trigger emits, on success, a non-empty `pr_url` in the `finalize` node output.

**Wiring closed:** On completion of this story, `/qds "<sample task>"` produces a real open PR whose URL appears in the `finalize` node output AND in the persisted run log keyed to the originating issue id, using only code merged by this story (the `finalize` node + run-log persistence) plus its listed predecessors. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P1.3 (`/qds` intake → parent issue + Seeds decompose → Paperclip mirror), P1.6 (WarrenClient drives the run via `POST /api/workflows/{name}/run` and captures the SSE stream correlated to issue id), P1.7 (post-edit `lsp_diagnostics` refuse-to-emit gate). The PR review-comment fix loop is the SEPARATE successor (PRD §10 Phase-1 item 15), explicitly NOT part of this make-or-break exit.

## Acceptance Criteria

1. **(make-or-break)** Given P1.3/P1.6/P1.7 are done and the sample repo is clean, When a single `/qds "<sample task>"` fires with no human input, Then a real PR is open on the sample repo and the `finalize` node output contains a non-empty `pr_url` string that resolves to that PR (`gh pr view <pr_url>` exit 0). (Binary: `pr_url` non-empty AND the PR exists.) For the make-or-break demo, `executionPolicy` is set to auto-approve mode (no human gate). P1.10 handles the human-approval path separately.
2. Given the run completes, When an operator reads the persisted run log (FR-OR-7), Then the log contains the PR URL and the originating Paperclip issue id, and the two are correlated in one record (NFR-OBS-3) — the PR is traceable to its issue from the log alone.
3. Given the implement node's `lsp_diagnostics` reports unwaived errors on changed files, When the `finalize` node is reached, Then `finalize` does NOT commit or open a PR — the gate halts the run with a non-zero node result (no PR on a dirty diff; the guard fires, never a silent commit).
4. Given the slice runs, When the implement node emits, Then the `finalize` node commits exactly the implement node's `changed_files` set (no unrelated paths) to the run's own worktree branch (FR-OR-5 isolation), so the PR diff equals the merged-result changes. Verified by diffing `git diff-tree --no-commit-id -r HEAD` output against the declared `changed_files` set — the two must match exactly.

## Technical Notes

- **Contracts/Schema (JSON):** `finalize` node output = `{ pr_url: string|null, branch: string, commit_sha: string, changed_files: string[], halted_reason?: "dirty_diagnostics"|"no_changes"|"path_traversal"|"pr_create_failed:<exitcode>" }`. The run-log record (FR-OR-7 persisted SSE) carries `{ issueId, runId, pr_url, branch, commitSha, changedFiles: string[], startedAt: ISO8601, completedAt: ISO8601, finalizeStatus: "success"|"halted"|"pr_failed", sseCaptured: boolean }`. The `qds-mkbrk` DAG is defined in this story with 4 nodes: `intake` (Seeds decompose), `implement` (P1.6 merged JSON), `lsp-gate` (P1.7 diagnostics check), `finalize` (git commit + PR). This is NOT the killed P1.4 PIV loop — it is a minimal make-or-break path.
- **Integration points (each wired & exercised):** (1) `/qds` intake (P1.3) → parent issue + Seeds mirror; (2) WarrenClient (P1.6) launches `POST /api/workflows/qds-mkbrk/run` and consumes `GET /api/stream/__dashboard__` SSE — no separate launcher file needed, reuses P1.6's existing `WarrenClient.run()` method; (3) implement bash node → merged JSON `changed_files` (P1.6); (4) post-edit `lsp_diagnostics` gate (P1.7) precedes `finalize`; (5) `finalize` node: `git add <changed_files>` + commit on the run's worktree branch (FR-OR-5) + `gh pr create --draft`. Node-to-node data flow: Archon passes upstream node's JSON output to downstream nodes. `finalize` reads `implement_node_output.changed_files` from the implement node's stdout JSON; (6) SSE stream captured + persisted as the run log with `pr_url` ↔ `issueId` correlation (FR-OR-7).
- **Files / functions touched:** the `qds-mkbrk` workflow definition (add `finalize` node), `finalize-node.sh` (git commit + `gh pr create --draft`, reads implement node's `changed_files`), the run-log persistence sink that writes the captured SSE stream + `pr_url`/`issueId` correlation. Bash node rationale: Archon workflow nodes are bash scripts per P1.6 pattern. A TypeScript wrapper (`finalize-output.ts`) validates and structures the output for test consumption.
- **Guards/limits:** Worktree isolation: Archon creates an isolated git worktree per run (provided by P1.6 WarrenClient's run isolation). The `finalize` node operates within this worktree — no additional isolation code needed. `finalize` runs ONLY after the post-edit gate passes (P1.7); on a dirty/unwaived diagnostics result it halts (no commit). `gh pr create --draft` runs on the run's isolated worktree branch only (FR-OR-5) — never on a shared/main working tree. On `gh pr create` non-zero exit: set `pr_url=null`, `halted_reason="pr_create_failed:<exitcode>"`, log stderr to run log, and exit the finalize node non-zero. Common failures: auth expiry (exit 1), rate limit (exit 1 with message), branch already has PR (exit 1). The run is NOT retried — the operator inspects the run log. Sample repo: `QDS_SAMPLE_REPO` env var (default: the repository where QDS is configured, resolved from `$QDS_REPO_DIR`). The make-or-break demo runs against this repo on a feature branch.
- **Citation caveat:** File:line references are best-current-knowledge at spec time; the dev agent verifies exact locations at implementation.
- **Trigger path:** Primary path: Telegram → Hermes gateway. Fallback: CLI → Hermes direct (when Telegram plugin unavailable).

## Files to Modify

- `archon-workflows/qds-mkbrk/workflow.yaml`
- `archon-workflows/qds-mkbrk/finalize-node.sh`
- `scripts/qds-mkbrk/run-log-sink.ts`
- `scripts/qds-mkbrk/finalize-output.ts`
- `test/qds-mkbrk/telegram-to-pr.e2e.test.ts`
- `test/qds-mkbrk/finalize-gate.test.ts`

## Security Invariants

- **INV-1 (input/file):** The `finalize` node commits ONLY the implement node's emitted `changed_files` set — each path is validated against the run's worktree root and rejected if it escapes the worktree (no `..`/absolute-path traversal); the PR diff cannot include paths the team did not declare (FR-EX-6 / CORRECTNESS-C).
- **INV-2 (input/file + worktree isolation):** `git commit` and `gh pr create` operate on the run's own worktree branch (FR-OR-5) only — the slice never writes to a shared/main working tree, so concurrent runs cannot collide on the working state being PR'd. Worktree isolation is inherited from P1.6 WarrenClient and is not separately tested in this story; correctness is asserted by P1.6's own test suite.
- **INV-3 (auth):** `gh`/git push credentials are read from env/secret refs (`GH_TOKEN`/`GITHUB_TOKEN`), never hardcoded and never written to the `finalize` node output, the run log, or stderr (NFR-SEC-1); the PR is opened as a reviewed PR (not auto-merged), preserving the human/QA seam (R9).
- **INV-4 (input/file gate):** `finalize` is reachable only after the post-edit `lsp_diagnostics` gate passes (0 errors or logged waiver, P1.7/NFR-SAF-4) — a dirty-diagnostics diff can never reach a PR (no silent commit on errors).

## Definition of Done

- [ ] **Impl:** The `qds-mkbrk` DAG gains a `finalize` node that commits the implement node's `changed_files` to the run's worktree branch and runs `gh pr create --draft`, emitting a non-empty `pr_url` on success.
- [ ] **Impl:** The `finalize` node halts (no commit, no PR) with `halted_reason:"dirty_diagnostics"` when the post-edit gate (P1.7) reports unwaived errors.
- [ ] **Impl:** When `changed_files` is empty after the implement node, `finalize` exits with `halted_reason:"no_changes"` and does NOT commit or create a PR. Test path: unit test feeds an empty `changed_files` array to `finalize` and asserts the node result is halted with the expected reason.
- [ ] **Impl:** A single `/qds "<sample task>"` drives intake → Seeds decompose → implement node → post-edit gate → `finalize` with NO manual hop (Hermes-gateway fallback used if the Telegram plugin is unconfirmed — r4 §3).
- [ ] **Contract:** The `finalize` node output schema (`pr_url`/`branch`/`commit_sha`/`changed_files`/`halted_reason?`) and the run-log record (`issueId`/`runId`/`pr_url`/`branch`/`commitSha`/`changedFiles`/`startedAt`/`completedAt`/`finalizeStatus`/`sseCaptured`) are defined with field validation.
- [ ] **Integration:** The captured SSE stream (P1.6) is persisted as a retrievable run log (FR-OR-7) with the PR URL correlated to the originating Paperclip issue id (NFR-OBS-3).
- [ ] **Integration:** `finalize` commits exactly the implement node's `changed_files` set (no unrelated paths) on the run's isolated worktree branch (FR-OR-5).
- [ ] **Observability/Audit:** The run log records `pr_url` ↔ `issueId` in one record, so the PR is traceable to its issue from the log alone (feeds the P1.16 audit walk, hop 1).
- [ ] **Security:** INV-1 (changed-files-only, no traversal), INV-3 (gh/git creds never emitted), and INV-4 (no PR on dirty diagnostics) each enforced and tested. `finalize-node.sh` validates each path in `changed_files` starts with `$WORKTREE_ROOT/` and contains no `..` segments. Violations halt with `halted_reason:"path_traversal"`.
- [ ] **Test (unit/integration):** Covers the `finalize` halt-on-dirty-diagnostics path, the changed-files-only commit (unrelated paths excluded), and the run-log `pr_url`↔`issueId` correlation write.
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1: runs the full slice from one `/qds "<sample task>"`; asserts a real PR is open (`gh pr view <pr_url>` exit 0) and the `finalize` output `pr_url` is non-empty — proving the make-or-break artifact is produced end-to-end with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
