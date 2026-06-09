# P1.3: Seeds-Decompose -> GitHub Issue Mirror (Authority Split)

**Story Points:** 4

## Spec Reference

- PRD §6, §7; FR-MG-3, FR-CP-3
- Phase exit gate: PRD §13 Phase 1 clause 3

## User Story

As a QDS factory operator,
I want Seeds decomposition to persist stories locally and mirror them as GitHub issue comments or sub-issues,
so that decomposition authority lives in Seeds while assignment/execution authority lives in SwarmClaw, with no duplication.

## Overview

When the Dev Manager receives a decompose request, it invokes Seeds to generate story decomposition. Seeds persists stories to `.seeds/issues.jsonl` as the authoritative source for story definitions, dependencies, and acceptance criteria. A one-directional mirror then writes each story as a GitHub sub-issue (or comment on the parent intake issue) via `gh issue create` with a `seeds-mirror` label. SwarmClaw owns assignment and execution tracking; Seeds owns decomposition structure. The mirror is read-only from GitHub's perspective: edits to GitHub issues do not flow back to Seeds.

## E2E Slice

**Demonstrable behavior:** Given an intake issue exists, a decompose A2A call produces: (1) `.seeds/issues.jsonl` appended with N story entries (each with id, title, dependencies, acceptance criteria), (2) N GitHub sub-issues created under the parent intake issue, each labeled `seeds-mirror`, (3) the response contains counts and mappings. No dependency or assignment data is duplicated in GitHub beyond a reference.

**Wiring closed:** On completion of this story, a decompose call yields Seeds-persisted stories and GitHub-mirrored sub-issues with a strict one-directional flow, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P1.2 (intake creates GitHub issue), P0.9 (Hindsight memory banks operational).

## Acceptance Criteria

1. **(make-or-break)** Given an intake session exists with a parent GitHub issue, When POST /api/a2a with method "qds.decompose" and `{ "sessionId": "{id}" }`, Then `.seeds/issues.jsonl` is appended with >= 1 story entry and each story has a corresponding GitHub sub-issue linked to the parent issue.
2. Given Seeds stories are persisted, When the mirror runs, Then each GitHub sub-issue contains the Seeds story ID in its body, title matches the Seeds story title, and label `seeds-mirror` is applied. Dependency edges are stored ONLY in `.seeds/issues.jsonl`, not in GitHub metadata.
3. Given a GitHub sub-issue is edited by a user, When the next decompose call runs, Then the Seeds entries are NOT overwritten by GitHub content (Seeds is authoritative; mirror is one-directional).

## Technical Notes

- **Contracts/Schema:** Seeds story entry: `{ id: string (seeds-{uuid}), title: string, description: string, dependencies: string[], acceptanceCriteria: string[], storyPoints: number, mirroredIssueNumber: number | null }`. Stored as JSONL (one JSON object per line) in `.seeds/issues.jsonl`. GitHub sub-issue body: `Seeds ID: {id}\n\n{description}`. Mirror response: `{ seedsCount: number, mirroredCount: number, mappings: Array<{seedsId, issueNumber}> }`.
- **Integration points:** Seeds decomposition module (generates stories), `.seeds/issues.jsonl` (persistence), `gh issue create` (mirror), GitHub parent issue (link via `--body` reference or sub-issue API). Hindsight {repo} bank (optional: store decomposition summary for recall).
- **Files / functions touched:** Seeds decomposition handler, `.seeds/issues.jsonl` writer, GitHub mirror service, decompose A2A handler, decompose validation schema.
- **Guards/limits:** Maximum 20 stories per decomposition. Each story title <= 280 chars. `.seeds/issues.jsonl` is append-only; no in-place mutation of existing entries. Mirror is best-effort: if GitHub API fails for one sub-issue, remaining sub-issues still created; failed mirrors logged with `mirroredIssueNumber: null`.

## Files to Modify

- `src/dev-manager/handlers/decompose.ts`
- `src/seeds/writer.ts`
- `src/seeds/schema.ts`
- `src/integrations/github/mirror-service.ts`
- `tests/e2e/seeds-decompose-mirror.test.ts`

## Security Invariants

- INV-1: Seeds story content sanitized before GitHub mirror (strip executable markdown, code fences in titles).
- INV-2: `.seeds/issues.jsonl` is `.gitignore`d (not tracked in version control) and written with file permissions 0600 at runtime via `fs.chmod` after each append; no world-readable factory data. Git does not preserve restrictive permissions — the file must be excluded from tracking to enforce this invariant.
- INV-3: Mirror operation uses a dedicated GitHub token scoped to `issues:write` on the target repo only; no broader repo permissions.

## Definition of Done

- [ ] **Impl:** Decompose handler receives A2A method "qds.decompose" and validates sessionId exists and is in "intake" state.
- [ ] **Impl:** Seeds stories generated and appended to `.seeds/issues.jsonl` with full schema (id, title, dependencies, acceptanceCriteria, storyPoints).
- [ ] **Impl:** Each story mirrored as GitHub sub-issue with `seeds-mirror` label and Seeds ID in body.
- [ ] **Impl:** Response returns `{ seedsCount, mirroredCount, mappings }` with seedsId-to-issueNumber map.
- [ ] **Contract:** Seeds story schema validated: id format `seeds-{uuid}`, dependencies reference valid seeds IDs, storyPoints in [1, 8].
- [ ] **Contract:** `.seeds/issues.jsonl` is append-only; existing entries never mutated by subsequent decompose calls.
- [ ] **Integration:** Parent intake issue linked to sub-issues (via body reference or GitHub sub-issue API).
- [ ] **Integration:** Partial mirror failure does not block remaining sub-issues; failures logged with `mirroredIssueNumber: null`.
- [ ] **Security:** Story content sanitized before GitHub API call (strip executable markdown from titles).
- [ ] **Security:** `.seeds/` added to `.gitignore`; `.seeds/issues.jsonl` written with `chmod 0600` after each append; permissions enforced at runtime since Git does not preserve them.
- [ ] **Test (unit):** Seeds writer validates schema and rejects invalid entries.
- [ ] **Test (e2e demo — MANDATORY):** Run decompose on intake session → verify `.seeds/issues.jsonl` has entries → verify GitHub sub-issues exist with correct titles and labels → verify dependency data is ONLY in Seeds, not duplicated in GitHub.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
