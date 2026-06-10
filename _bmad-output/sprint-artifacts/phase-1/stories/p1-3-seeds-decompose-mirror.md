# P1.3: Seeds-Decompose -> GitHub Issue Mirror (Authority Split)

**Story Points:** 4

## Spec Reference

- PRD §6, §7; FR-MG-3, FR-CP-3
- Phase exit gate: PRD §13 Phase 1 clause 3

## User Story

As a QDS factory operator,
I want Seeds decomposition to persist stories locally and mirror them as GitHub sub-issues,
so that decomposition authority lives in Seeds while assignment/execution authority lives in SwarmClaw, with no duplication.

## Overview

When the Dev Manager receives a decompose request, it invokes Seeds to generate story decomposition. Seeds persists stories to `.seeds/issues.jsonl` as the authoritative source for story definitions, dependencies, and acceptance criteria. A one-directional mirror then writes each story as a GitHub sub-issue via `gh issue create` with a `seeds-mirror` label. SwarmClaw owns assignment and execution tracking; Seeds owns decomposition structure. The mirror is read-only from GitHub's perspective: edits to GitHub issues do not flow back to Seeds.

## A2A Dispatch Contract

The Seeds agent registers with the A2A delegation layer (P1.1) with agentId `qds-seeds`, `agentType: "service"` (per the P1.1 enum extension), `endpointUrl: "http://localhost:${process.env.SWARMCLAW_A2A_PORT || 3100}/a2a"`, and `capabilities: ["qds.decompose"]`. The endpointUrl follows the local-only Transport Contract enforced by P1.1 INV-4. Callers invoke decompose via P1.1's A2A delegation: `a2a.delegate({ targetAgentId: "qds-seeds", params: { task: "decompose", sessionId, repo } })` (both the Dev Manager and Seeds agent share the CLI-Anything harness, which dispatches internally by agentId). P1.1's Transport Contract carries the task payload in `params.task`. Seeds-specific parameters (`sessionId`, `repo`) are nested alongside the task indicator. The A2A layer routes by targetAgentId — the task field is informational for the Seeds agent's internal dispatch. `repo` is optional and defaults to the session's repository if omitted. The Seeds handler resolves `repo` from the session context when not provided. The agentId `qds-seeds` conforms to P0.7's agentId regex `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$`.

## E2E Slice

**Demonstrable behavior:** Given an intake issue exists, a decompose A2A call produces: (1) `.seeds/issues.jsonl` appended with N story entries (each with id, title, dependencies, acceptance criteria), (2) N GitHub sub-issues created under the parent intake issue, each labeled `seeds-mirror`, (3) the response contains counts and mappings. No dependency or assignment data is duplicated in GitHub beyond a reference.

**Wiring closed:** On completion of this story, a decompose call yields Seeds-persisted stories and GitHub-mirrored sub-issues with a strict one-directional flow, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P1.2 (intake creates GitHub issue), P0.9 (Hindsight memory banks operational).

## Acceptance Criteria

1. **(make-or-break)** Given an intake session exists with a parent GitHub issue, When `a2a.delegate({ targetAgentId: "qds-seeds", params: { task: "decompose", sessionId: "{id}" } })`, Then `.seeds/issues.jsonl` is appended with >= 1 story entry and each story has a corresponding GitHub sub-issue linked to the parent issue.
2. Given Seeds stories are persisted, When the mirror runs, Then each GitHub sub-issue contains the Seeds story ID in its body, title matches the Seeds story title, and label `seeds-mirror` is applied. Dependency edges are stored ONLY in `.seeds/issues.jsonl`, not in GitHub metadata. Dependency edges are also persisted to the Hindsight `resolveBankId(repoSlug)` memory bank so that cross-environment and multi-worktree consumers can query the dependency graph without requiring access to the local `.seeds/` file.
3. Given a GitHub sub-issue is edited by a user, When the next decompose call runs, Then the Seeds entries are NOT overwritten by GitHub content (Seeds is authoritative; mirror is one-directional).
4. Given a valid A2A delegate request with `targetAgentId: "qds-seeds"` and `params.task: "decompose"`, Then the Seeds agent receives the request via P1.1's routing and returns decomposition results with `{ seedsCount, mirroredCount, mappings }`.
5. Given a decomposed story containing a bash code block with `rm -rf /`, the sanitized output replaces the code block with `[code block removed: bash]` and preserves all prose content.
6. Given a decomposed story with no executable content, the sanitized output is identical to the input (passthrough).
7. Given a decompose request that would produce > 20 stories, When Seeds processes the request, Then exactly 20 stories are persisted and the response includes `{ truncated: true, generatedCount: N, persistedCount: 20 }`.

## Technical Notes

- **Contracts/Schema:** Seeds story entry: `{ id: string (seeds-{uuid}), title: string, description: string (max 2000 characters — longer descriptions are truncated with `[truncated, N chars total]` suffix, matching P1.6's convention), dependencies: string[], acceptanceCriteria: string[] (min 1 item — empty arrays rejected with 400), storyPoints: number (z.number().int().min(1).max(8) — matching the DoD constraint), mirroredIssueNumber: number | null }`. Stored as JSONL (one JSON object per line) in `.seeds/issues.jsonl`. GitHub sub-issue body: `Seeds ID: {id}\n\n{description}`. Mirror response: `{ seedsCount: number, mirroredCount: number, mappings: Array<{seedsId, issueNumber}>, truncated?: boolean, generatedCount?: number, persistedCount?: number, failures?: Array<{ seedsId: string | null, storyIndex: number, error: string }> }`. `mirroredCount` counts only successfully created GitHub issues (mappings entries where `mirroredIssueNumber` is not null). Failed mirrors appear in `mappings` with `mirroredIssueNumber: null` and in `failures`. When the GitHub mirror repository truncates content (e.g., large stories), `mirroredCount` reflects the actual number of stories written, not the requested count. Callers should compare `mirroredCount` to the input count to detect truncation. Two truncation scenarios: (a) >20 stories produced by decomposition → `truncated: true`, compare `persistedCount` to `generatedCount`; (b) GitHub API truncation → compare `mirroredCount` to `seedsCount`. These are independent — both can occur simultaneously.
- **Integration points:** Seeds decomposition module (generates stories), `.seeds/issues.jsonl` (persistence), `gh issue create` (mirror), GitHub parent issue (link via `--body` reference or sub-issue API). The GitHub mirror feature requires the `gh` CLI to be installed and authenticated. If `gh` is not available, mirror operations fail with error code -32018. The Seeds service should check `gh` availability at startup and log a warning if it is missing. Each `gh issue create` invocation has a 30-second timeout. If GitHub API responds with 429 (rate limiting), the mirror pauses for the indicated retry-after duration (max 60s) before retrying once. Total mirror phase timeout: 5 minutes. Failures beyond this are logged and the mirror phase reports partial failure. Hindsight `resolveBankId(repoSlug)` memory bank (store decomposition summary AND dependency edges for recall — dependency edges are written to Hindsight alongside `.seeds/issues.jsonl` to ensure cross-environment availability; `.seeds/issues.jsonl` remains the authoritative local source but Hindsight serves as the shared query layer).
- **Bank ID resolution:** Seeds calls `resolveBankId(process.env.REPO_SLUG)` (defined in P0.9) to obtain the project bank ID. Stories and dependency edges are stored in bank `resolveBankId(repoSlug)`. The literal `{repo}` placeholder is never used at runtime — all bank references resolve through `resolveBankId()`.
- **JSONL write atomicity:** Stories are buffered in memory and written as a single append operation per batch (atomic at the application level). If the append fails, the entire batch is rolled back: `seedsCount` reflects only successfully persisted stories, and the failed stories are reported in `failures`. JSONL write failure returns -32000 (Internal error) with the response including `failures` array. This is unexpected and not given its own code.
- **Files / functions touched:** Seeds decomposition handler, `.seeds/issues.jsonl` writer, GitHub mirror service, decompose A2A handler, decompose validation schema.
- **Sub-issue linking strategy:** Sub-issue linking uses `gh issue create` with body-reference links (not the native GitHub Sub-Issues API). The `issues:write` scope is sufficient for this approach. Each story issue includes a body reference to the parent issue (e.g., `Parent: #N`). Native sub-issue API integration is a Phase 2 enhancement.
- **Guards/limits:** Maximum 20 stories per decomposition. Decompose requests are not idempotent. A client timeout followed by a retry produces duplicate stories in the JSONL file. Dedup is the caller's responsibility — callers should use a unique `requestId` and check for existing stories with the same ID before re-decomposing. Each story title <= 280 chars. `.seeds/issues.jsonl` is append-only; no in-place mutation of existing entries. Mirror is best-effort: if GitHub API fails for one sub-issue, remaining sub-issues still created; failed mirrors logged with `mirroredIssueNumber: null`. `mirroredIssueNumber` is always present in the JSONL entry. It is `null` until mirror operation completes. After successful mirror, set to GitHub issue number. `.seeds/issues.jsonl` size is monitored but not enforced in Phase 1. Operational note: JSONL files exceeding 10 MB should be archived to `.seeds/seeds-archive-YYYY-MM-DD.jsonl` (using the archive date) and a fresh file started; readers querying local story definitions (e.g., SwarmClaw, Seeds handler) must traverse the active `.seeds/issues.jsonl` and any `.seeds/seeds-archive-*.jsonl` files (glob-matched) for complete history. Compaction is a Phase 2 concern — Phase 1 documents the append-only contract and the 10 MB operational threshold. No automatic rotation in this story. The JSONL file is written by a single process (the Seeds decomposer). Concurrent writes to the same file are not supported. The 10 MB archival threshold check and rename are not atomic — the decomposer holds an implicit single-writer lock by design. If an archive file for the current date already exists, the new events are appended to the existing archive (not overwritten). Archive filename format: `seeds-archive-YYYY-MM-DD.jsonl`. Append behavior ensures no data loss from multiple archival events on the same day. Archive files matching `seeds-archive-*.jsonl` are only created by the Seeds decomposer. The glob pattern assumes no other process writes matching files to `.seeds/`.

## Files to Modify

- `src/dev-manager/handlers/decompose.ts`
- `src/seeds/writer.ts`
- `src/seeds/schema.ts`
- `src/integrations/github/mirror-service.ts`
- `tests/e2e/seeds-decompose-mirror.test.ts`

## Security Invariants

- INV-1: Seeds story content sanitized before GitHub mirror and Hindsight storage (see Sanitization Contract below).
- INV-2: `.seeds/issues.jsonl` is `.gitignore`d (not tracked in version control) and written with file permissions 0600 at runtime via `fs.chmod` after every write batch. File permissions are verified and enforced at the start of each batch, regardless of whether the file was created by this process or pre-exists from a prior run. This ensures that a pre-existing file with loose permissions (e.g., created by another process or manually) is immediately corrected. No world-readable factory data. Git does not preserve restrictive permissions — the file must be excluded from tracking to enforce this invariant.
- INV-3: Mirror operation uses a dedicated GitHub token scoped to `issues:write` on the target repo only; no broader repo permissions.

## Sanitization Contract

Decomposed story output is sanitized before Hindsight storage and GitHub issue creation. The posture is **deny-by-default**: only an explicit safe set of language tags is permitted in fenced code blocks; all others are stripped.

1. **Fenced code blocks — deny-by-default**: Fenced code blocks with language tags not in the explicit safe set (`typescript`, `json`, `yaml`, `mermaid`, `sql`, `graphql`, `css`, `html`, `xml`, `diff`, `plaintext`) are stripped and replaced with `[code block removed: {language}]`. The safe set is configurable via the environment variable `SEEDS_SANITIZATION_SAFE_LANGUAGES` (comma-separated; default: `typescript,json,yaml,mermaid,sql,graphql,css,html,xml,diff,plaintext`). All other language tags (including `shell`, `bash`, `powershell`, `ruby`, `perl`, `python`, `php`, `lua`, `sh`, `exec`, `go`, `java`, `c`, `cpp`, `rust`, etc.) are stripped to prevent code injection through story content. Preserve the fence markers and language tag for traceability.
2. **Inline shell constructs**: Strip inline code (single-backtick spans) containing path traversal patterns (`..`, `~`), shell operators (`&&`, `||`, `;`, `$()`, backticks), parameter expansion (`${}`), pipes (`|`), newline injection (`\n`, `\r`), heredoc markers (`<<`, `<<<`), redirect operators (`>`, `<`, `>>`, `<<<`), and network URLs in code context. Replace with `[inline code sanitized]`. The inline code strip list is deny-by-default for shell metacharacters. Any inline code containing characters that could influence shell execution is stripped.
3. **HTML injection**: Strip HTML `<script>`, `<iframe>`, `<object>`, `<embed>` tags and their contents. Replace with `[html tag removed: {tag}]`. Rule 3 applies to all prose content. Fenced code blocks in the safe set (including `html`) are preserved verbatim — the consumer's rendering pipeline is responsible for sanitizing HTML code block content. For GitHub Issues rendering, fenced HTML blocks are not executed. Consumers in other contexts (e.g., custom dashboards) must sanitize before rendering.
4. **Preserve safe content**: Non-executable markdown (headers, lists, prose, mermaid diagrams, tables) and code blocks in the safe set are preserved verbatim. Mermaid `click` directives are preserved as an accepted risk. The safe set includes `mermaid` because mermaid diagrams are critical for architecture visualization. Consumers must sanitize `click` directives if rendering in a non-GitHub context.
5. **Passthrough for clean input**: Given a decomposed story with no executable content, the sanitized output is identical to the input.

## Dependency Edge Schema

Each dependency in the `dependencies[]` array of a Seeds story is persisted as a separate Hindsight entry in the `resolveBankId(repoSlug)` memory bank using the following schema:

```typescript
const DependencyEdgeSchema = z.object({
  sourceStoryId: z.string().regex(/^seeds-[0-9a-f-]+$/),
  targetStoryId: z.string().regex(/^seeds-[0-9a-f-]+$/),
  dependencyType: z.enum(["blocks", "depends_on", "related_to", "parallel_with"]),
  sessionId: z.string(),
  createdAt: z.string().datetime(),
});
```

AC2's reference to Hindsight storage of dependency edges is satisfied by this schema. Each dependency edge is queryable by `sourceStoryId`, `targetStoryId`, or `sessionId` through the Hindsight memory bank's standard retrieval interface.

> Dependency edges are stored as JSONL entries. Querying by dependency type requires full scan and filter. For Phase 2, consider adding metadata tags or an index for common query patterns (e.g., `blocks`, `depends_on`).

> `parallel_with` indicates stories that are explicitly safe to run concurrently (no shared state or dependencies).

## Decompose Error Code Taxonomy

- `-32600`: Invalid Request — malformed JSON-RPC envelope
- `-32602`: Invalid params — missing/invalid sessionId, decompose payload
- `-32000`: Internal error — unexpected decomposition failure
- `-32014`: Session not found — sessionId does not exist
- `-32015`: Session not in intake status — decompose requires intake status
- `-32016`: Decomposition failed — no stories generated (empty result)
- `-32017`: Mirror failure — one or more GitHub issues failed to create. Covers both partial (some stories failed) and total (all stories failed) mirror failures.
- `-32018`: CLI unavailable — gh CLI not found or not authenticated.

> Error codes `-32014` through `-32018` are Seeds-specific. Standard JSON-RPC codes apply for protocol errors. A2A-level errors (`-32010` through `-32013`) from P1.1 may propagate if delegation fails.

## Observability Contract

- Every decompose operation logs: `{ requestId, operation, sessionId, timestamp, duration, status }`
- `requestId` propagates from P1.1 A2A layer
- Errors include: `{ code, message, stack?: string }`
- Decompose timing: `parse_ms`, `story_count`, `mirror_latency_ms`, `jsonl_write_ms`
- Mirror partial failures logged per-issue: `{ issueIndex, githubStatus, error }`

## Definition of Done

- [ ] **Impl:** Seeds agent registers with P1.1 A2A layer with agentId `qds-seeds`, agentType `"service"`, endpointUrl `http://localhost:${SWARMCLAW_A2A_PORT || 3100}/a2a`, and capabilities `["qds.decompose"]` during startup; registration conforms to P1.1's registration schema.
- [ ] **Impl:** Decompose handler receives A2A task "decompose" routed via P1.1's `a2a.delegate({ targetAgentId: "qds-seeds" })` and validates sessionId exists and is in "intake" state.
- [ ] **Impl:** Seeds stories generated and appended to `.seeds/issues.jsonl` with full schema (id, title, dependencies, acceptanceCriteria, storyPoints).
- [ ] **Impl:** Each story mirrored as GitHub sub-issue with `seeds-mirror` label and Seeds ID in body.
- [ ] **Impl:** Response returns `{ seedsCount, mirroredCount, mappings }` with seedsId-to-issueNumber map.
- [ ] **Contract:** Seeds story schema validated: id format `seeds-{uuid}`, dependencies reference valid seeds IDs, storyPoints in [1, 8], acceptanceCriteria must contain at least one item (empty acceptance criteria arrays are rejected with 400).
- [ ] **Contract:** `.seeds/issues.jsonl` is append-only; existing entries never mutated by subsequent decompose calls.
- [ ] **Integration:** Parent intake issue linked to sub-issues (via body reference or GitHub sub-issue API).
- [ ] **Integration:** Partial mirror failure does not block remaining sub-issues; failures logged with `mirroredIssueNumber: null`.
- [ ] **Test (write failure):** JSONL write failure → verify `failures` array populated with correct structure.
- [ ] **Test (description truncation):** Decompose a story with description exceeding 2000 characters → verify output truncated to 2000 chars with `[truncated, N chars total]` suffix.
- [ ] **Test (guard):** Seeds startup with `gh` not on PATH → verify warning logged and mirror operations return error code -32018 on decompose attempt.
- [ ] **Security:** Story content sanitized before GitHub API call per Sanitization Contract (5 test cases: bash code block removal, inline shell construct strip, HTML tag strip, passthrough for clean input, mixed content with all rule types).
- [ ] **Test (sanitization):** Decompose a story containing `powershell`, `ruby`, `bash` code blocks → verify all are replaced with `[code block removed: {language}]`. Verify `typescript` and `json` blocks are preserved.
- [ ] **Security:** `.seeds/` added to `.gitignore`; `.seeds/issues.jsonl` written with `chmod 0600` after every write batch (not just first write — pre-existing files with loose permissions are corrected); permissions enforced at runtime since Git does not preserve them.
- [ ] **Test (unit):** Seeds writer validates schema and rejects invalid entries.
- [ ] **Test (e2e demo — MANDATORY):** Run decompose on intake session → verify `.seeds/issues.jsonl` has entries → verify GitHub sub-issues exist with correct titles and labels → verify dependency data is ONLY in Seeds, not duplicated in GitHub → verify dependency edges are also queryable from the Hindsight `resolveBankId(repoSlug)` bank.
- [ ] **Test (guard):** Decompose request producing > 20 stories truncates to 20 with `{ truncated: true, generatedCount: N, persistedCount: 20 }` in response.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
