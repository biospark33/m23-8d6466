# P1.12: Mulch house-style prime-before / record-after — the house-style loop on a run

**Story Points:** 3

## Spec Reference

- PRD §4.6 (Mulch prime injection) + §6.5; FR-MEM-5
- Supporting: NFR-OBS-3 (handoff logged with issue-id correlation), NFR-PERF-5 (advisory augmentation, non-blocking)
- Phase exit gate: PRD §13 Phase-1 clause 10 — "house-style context is primed from Mulch pre-execution and reusable expertise is recorded post-run." (FR-MEM-5)

## User Story

As the Hermes Dev manager assembling the implement node's context for a `{repo}` run,
I want house-style context primed from Mulch BEFORE the Pi team executes and reusable expertise recorded back to Mulch AFTER the run,
so that node agents write in the repo's established house style and each run sharpens that style for the next (G3 — reusable expertise compounds), closing the house-style loop across runs.

## Overview

This slice cuts through Hermes (context assembly + post-run hook) → the Mulch CLI (`/usr/local/bin/ml`, package `@os-eco/mulch-cli` v0.10.7, verbs `prime` / `record`) → the Pi-team implement node's primed system prompt (`--context-path` → `--append-system-prompt`, §4.6) → the repo's `.mulch/expertise/<domain>.jsonl` store. PRE-execution, `ml prime` for the run's repo emits the house-style context that the launcher folds into `--context-path` (judgment roles get the full slice; the constrained Implementer a minimal one — §4.6/NFR-PERF-5). POST-run, `ml record` persists the run's reusable expertise to the repo-scoped `.mulch/expertise/`. It is one atomic 3-pt unit because the house-style loop is not demonstrable until BOTH halves work on the same run — a prime that reaches the prompt AND a record that lands in `.mulch/` and is reusable by the next prime — splitting them leaves a half-loop. Mulch (house-style, file-store) is a distinct store from Hindsight (run-memory, P1.11); priming is additive to the Hindsight prime, not a replacement. Mulch `record` (writes to `.mulch/expertise/`) and Hindsight `retain` (writes to Hindsight bank) are distinct operations on separate stores — 'record' always refers to Mulch, 'retain' always refers to Hindsight. Note: W1 resolved CLI argument discovery (P1.12-B2) and domain derivation (P1.12-B3) — the original 3-pt estimate accounts for the now-specified CLI surface.

## E2E Slice

**Demonstrable behavior:** A `qds-piv-loop` run on a `{repo}` issue (1) invokes `ml prime` for `{repo}` BEFORE the implement node executes and the emitted house-style text appears in the node's system prompt, and (2) invokes `ml record` AFTER the run so a new reusable-expertise entry is appended to `{repo}`'s `.mulch/expertise/<domain>.jsonl`, retrievable by a subsequent `ml prime` on the same repo.

**Wiring closed:** On completion of this story, a real run primes house-style context from `ml prime` into the implement node's system prompt before execution AND records reusable expertise via `ml record` into `{repo}`'s `.mulch/expertise/<domain>.jsonl` after, with the recorded entry visible to the next `ml prime`, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.9 (Mulch pinned at `/usr/local/bin/ml`, package `@os-eco/mulch-cli` 0.10.7; `prime`/`record`/`learn` verbs confirmed; the repo's `.mulch/expertise/` store initialized), P1.6 (the Pi-team implement node exists and accepts a primed system prompt via `--context-path` / `--append-system-prompt`). The Hindsight run-memory prime/retain is the SEPARATE sibling story **P1.11** (different store, dependency-independent — not wired here).

## Acceptance Criteria

1. **(make-or-break)** Given a `qds-piv-loop` run for a `{repo}` issue, When the run executes end-to-end, Then `ml prime` runs for `{repo}` BEFORE the implement node (its house-style text appears in the node's system prompt) AND after the run a NEW reusable-expertise entry is present in `{repo}`'s `.mulch/expertise/<domain>.jsonl` that was not there before. (Binary: prime text in the system prompt before node exec AND a new `.mulch/expertise` record after.)
2. Given the post-run `ml record` succeeded, When a subsequent `ml prime` runs on the same `{repo}`, Then the recorded entry is reflected in that next prime's output (the expertise is reusable across runs, not write-only).
3. Given `ml prime` returns no/empty house-style context (fresh repo) OR the Mulch CLI exits non-zero on prime, When the launcher assembles `--context-path`, Then the node proceeds with the rest of its context and a logged warning (Mulch prime is advisory/non-blocking, NFR-PERF-5) — never a hang, never a halt.
4. Given a run for `{repoA}`, When `ml record` fires, Then the expertise is written ONLY to `{repoA}`'s `.mulch/expertise/` and a subsequent `ml prime` for `{repoB}` returns NONE of `{repoA}`'s recorded entries — no cross-repo leak.

## Technical Notes

- **Contracts/Schema (CLI + JSONL):** Mulch is the binary `/usr/local/bin/ml` from package `@os-eco/mulch-cli` v0.10.7 — invoked as a subprocess. The `.mulch/expertise/` store is repo-local and travels with the repo.
- **CLI Interface (P1.12-B2 resolution — concrete flags, output format, exit codes):**
  - `ml prime [domain]`
    - **Purpose:** Emits house-style context text for the given domain (or ALL domains when `domain` is omitted — matches P0.9-H2 behavior).
    - **Arguments:** `[domain]` — optional; when provided, restricts output to a single domain's expertise; when omitted, merges context from all domains found in `.mulch/expertise/`.
    - **Reads:** `.mulch/expertise/<domain>.jsonl` (all JSONL files in the `.mulch/expertise/` directory matching the domain filter).
    - **Output:** The wrapper always invokes `ml prime` with `--json` (see subprocess invocation below). Output is a JSON object: `{ context: string, facts: string[], domain: string, expertise_count: number }`. When no expertise file exists for the domain, `ml prime` emits `{ context: "", facts: [], domain: "<domain>", expertise_count: 0 }` with exit code 0 — empty result, not an error. The wrapper extracts the `context` field and appends it to `--context-path`. Plain-text mode (omitting `--json`) is not used by the wrapper but remains available for manual CLI invocation.
    - **Exit codes:** 0 = success (output is always valid JSON; `context` may be empty with `expertise_count: 0` when no expertise exists — wrapper treats empty `context` as "no expertise available" and proceeds with an advisory warning per NFR-PERF-5); 1 = CLI error (invalid arguments, missing required fields — logged as error, run proceeds); 2 = parse error while reading `.jsonl` (malformed lines skipped, wrapper logs error and proceeds with whatever valid entries were parsed). Exit codes ≥1 are non-fatal — Mulch is advisory per NFR-PERF-5.
    - **Subprocess invocation (wrapper):** `child_process.execFile('/usr/local/bin/ml', ['prime', domain, '--json'], { cwd: repoWorktreeRoot, timeout: 5000, env: redactedEnv })` — bounded 5s timeout (NFR-PERF-5 advisory), repo-scoped cwd ensures `.mulch/` is read from the correct worktree, redacted env strips secrets (INV-3). On timeout (Node.js `err.killed === true`), the wrapper logs 'Mulch prime timed out after Ns' and proceeds identically to a non-zero exit — advisory warning, run continues.
  - `ml record <domain> --type <type> "content"`
    - **Purpose:** Appends a reusable-expertise entry to the repo's `.mulch/expertise/<domain>.jsonl`.
    - **Arguments:** `<domain>` (required) — the expertise domain slug; `--type <type>` (required) — one of `convention | pattern | failure | decision | reference | guide`; `"content"` (required positional) — the expertise text. Optional: `--source <source-ref>` — a reference string (e.g., commit SHA, issue URL) recorded in the `evidence` field.
    - **Reads:** No input files (creates/updates output only).
    - **Output:** Creates `.mulch/expertise/` directory if absent. Appends one JSONL entry to `.mulch/expertise/<domain>.jsonl`. The CLI handles file locking and schema validation internally (P0.9-B2 resolution).
    - **JSONL entry format (written by `ml record`, not by this story's code):** `{ id: string (auto-generated, e.g. "mx-3f8a2b"), type: string, domain: string, content: string, resolution?: string, evidence: { commit?: string, issue?: string }, tags: string[], classification: string, recorded_at: string (ISO-8601), outcomes: object[] }`. The wrapper does NOT write JSONL directly — it invokes `ml record` which handles schema validation and file locking.
    - **JSONL file format and durability rules:** The `.mulch/expertise/<domain>.jsonl` file is one JSON object per line (standard JSONL). Each line is a self-contained entry. The file is append-only — `ml record` appends to the end, never rewrites. Blank lines are ignored on read. Malformed lines (invalid JSON) are skipped by `ml prime` with a debug log (exit code 2 per the CLI spec). The file encoding is UTF-8. Maximum line length: 64KB (entries exceeding this are truncated by `ml record` with a warning).
    - **Wrapper-level record payload schema (P1.12-H3):** Two distinct schemas apply — the **CLI arguments schema** (what the wrapper passes to `ml record`) and the **persisted JSONL schema** (what `ml record` writes to disk). **CLI arguments schema:** the wrapper invokes `ml record <domain> --type <type> "content" [--source <source-ref>]`, passing `--source` as a string (e.g., a commit SHA or issue URL). **Persisted JSONL schema:** `ml record` internally decomposes the `--source` string into the persisted `evidence` object: `{ commit?: string, issue?: string }`. The persisted entry shape is `{ id: string, type: string, domain: string, content: string, resolution?: string, evidence: { commit?: string, issue?: string }, tags: string[], classification: string, recorded_at: string (ISO-8601), outcomes: object[] }`. The wrapper does NOT write JSONL directly — it invokes `ml record` which handles the string→object decomposition, ID generation, validation, and file locking internally. The transformation from CLI `--source` string to JSONL `evidence` object occurs inside `ml record`, not in the wrapper.
    - **Batch mode:** `ml record <domain> --batch <file>` reads a JSON array of records and atomically writes them. Used by P0.9 for initial import; P1.12 uses single-record invocations for post-run capture.
    - **Exit codes:** 0 = success (entry appended); 1 = write error (disk full, permissions — log error, proceed with warning, never halt the run).
    - **Subprocess invocation (wrapper):** `child_process.execFile('/usr/local/bin/ml', ['record', domain, '--type', type, content], { cwd: repoWorktreeRoot, timeout: 3000, env: redactedEnv })` — bounded 3s timeout, repo-scoped cwd ensures write lands in the correct worktree's `.mulch/`. On timeout (Node.js `err.killed === true`), the wrapper logs 'Mulch record timed out after Ns' and proceeds identically to a non-zero exit — advisory warning, run continues.
  - **Fallback when Mulch binary is absent (P1.12-H4):** If `/usr/local/bin/ml` is not found (ENOENT) or is not on PATH, the wrapper logs a warning and continues with an empty prime result — equivalent to `ml prime` returning no expertise. The run does NOT fail — Mulch is best-effort context enrichment. Exit class: `"logic"` (the run still proceeds without Mulch context). If `ml record` fails (binary missing, write error, timeout), the wrapper logs and continues — recorded facts are not critical-path and must never block run completion. This matches P0.9's "Mulch is enhancement, not make-or-break" convention and NFR-PERF-5 (advisory, non-blocking).
- **Domain derivation (P1.12-B3 resolution):** The `<domain>` value used in `.mulch/expertise/<domain>.jsonl` is derived from the repo slug: `org-repo` (slashes replaced with hyphens, lowercased). Example: `biospark33/QDS-Factory` → `biospark33-qds-factory`. This matches the Hindsight `bank_id` slug convention from P0.9 (where `{repo}` is used as the bank identifier). Derivation happens in the Mulch wrapper at invocation time — the wrapper receives the repo's `org/repo` identifier, normalizes it to a domain slug, and passes it as the `<domain>` argument to both `ml prime` and `ml record`. Alternatively, the domain can be overridden via an explicit `--domain <name>` flag on the wrapper (not on `ml` itself — the wrapper translates its own flag to the positional `<domain>` argument). The domain slug is also used as the JSONL filename, ensuring 1:1 correspondence between the Hindsight bank namespace and the Mulch expertise namespace for the same repo.
- **Integration points (each wired & exercised):** (1) `ml prime <domain> --json` PRE-execution → wrapper parses JSON output, extracts `context` field → appends to launcher `--context-path` → `--append-system-prompt` (P1.6 surface; judgment roles full, constrained Implementer minimal — §4.6); (2) `ml record <domain> --type <type> "content"` POST-run → appends entry to `.mulch/expertise/<domain>.jsonl`; (3) the prime→inject and record handoffs logged with issue-id correlation (NFR-OBS-3).
- **Files / functions touched:** the Mulch prime step (run `ml prime`, fold into context bundle), the post-run `ml record` hook, the Mulch CLI wrapper (subprocess invoke + repo-scoped cwd), the empty/non-zero-prime fallback path.
- **Guards/limits:** `ml prime` is advisory and non-blocking (NFR-PERF-5) — bounded so it never blocks node dispatch; on empty/error it degrades to a logged warning and proceeds.
- **Record deduplication (P1.12-M2):** `ml record` does NOT deduplicate by content — each invocation appends one entry. Deduplication is the caller's responsibility. The wrapper checks whether the run's output contains genuinely new expertise before invoking `ml record` (comparing against the current prime output to avoid recording what was already known). If the wrapper has no new expertise to record, it skips the `ml record` call entirely. This prevents the JSONL file from growing unbounded with duplicate entries across runs.
- **Mulch failure exit_class (P1.12-M4):** When `/usr/local/bin/ml` is not found (ENOENT) or `ml prime`/`ml record` fails, the run's exit_class is `"logic"` — the run completes successfully without Mulch context. Mulch failures are never `"transient"` — there is no retry. If Mulch is missing, it stays missing for the entire run.
- **P1.11+P1.12 context-path merge ordering:** P1.12 `ml prime` runs AFTER P1.11 Hindsight recall. P1.12 appends Mulch expertise to the `--context-path` file that P1.11 already populated with recalled memories. Use `--append-system-prompt` or equivalent to avoid overwriting P1.11's context. The launcher must compose the final system prompt by concatenating P1.11's Hindsight output with P1.12's Mulch output — never replace. (W0 CC-6 ordering note — verified present.)
- **How `ml prime` output folds into `--context-path` (P1.12-H2):** The wrapper invokes `ml prime` with `--json`, reads stdout, parses the JSON, extracts the `context` field, and appends that string to the Pi-team's `--context-path` file (appended, not overwritten — see P1.11 ordering above). The `facts` array is NOT passed as context; it is informational only (available for logging or debugging). Plain-text mode (without `--json`) is not used by the wrapper.

## Files to Modify

- `scripts/mulch/prime-step.ts`
- `scripts/mulch/record-on-finish.ts`
- `scripts/mulch/cli.ts`
- `scripts/mulch/context-fold.ts`
- `config/mulch.config.ts`
- `test/mulch/prime-record.e2e.test.ts`
- `test/mulch/tenant-isolation.test.ts`

## Security Invariants

- **INV-1 (tenant):** `ml prime` and `ml record` are scoped to the run's own `{repo}` (repo-local `.mulch/expertise/` via the repo cwd/worktree); a run for `{repoA}` MUST NOT prime from or record into `{repoB}`'s expertise store — no cross-repo read or write (AC-4).
- **INV-2 (tenant):** Recorded expertise is repo-scoped and travels with the repo; a subsequent `ml prime` for a different repo returns none of another repo's entries (no cross-repo leak via a shared/global Mulch path).
- **INV-3 (secrets/input):** The house-style text folded into `--context-path` and the recorded expertise are sanitized — no secret value (API keys, tokens, `PAPERCLIP_API_KEY`) is ever written into the Mulch store or the primed prompt; the Mulch subprocess inherits a redacted env, not raw credentials.

## Definition of Done

- [ ] **Impl:** The Mulch prime step runs `ml prime` for the run's `{repo}` BEFORE the implement node and folds the house-style output into the launcher `--context-path`.
- [ ] **Impl:** The record-on-finish hook runs `ml record` after the run, appending a reusable-expertise entry to `{repo}`'s `.mulch/expertise/<domain>.jsonl`.
- [ ] **Impl:** Empty/fresh-repo prime and a non-zero `ml prime` exit both degrade to a logged warning and proceed (advisory, NFR-PERF-5) — never a hang or halt.
- [ ] **Contract:** The Mulch CLI wrapper invokes the pinned binary `/usr/local/bin/ml` from `@os-eco/mulch-cli` 0.10.7 (`prime`/`record`) as a subprocess; the `.mulch/expertise/<domain>.jsonl` append shape is honored.
- [ ] **Integration:** The `ml prime` output demonstrably reaches the implement node's system prompt (`--context-path` → `--append-system-prompt`, P1.6 surface), and the `ml record` entry is reusable by the next prime (AC-2).
- [ ] **Observability/Audit:** The prime→inject and record handoffs are logged with issue-id correlation (NFR-OBS-3).
- [ ] **Security:** INV-1/INV-2 (tenant: prime/record scoped to own `{repo}`, no cross-repo read or write) and INV-3 (no secret in the store or prompt) each enforced and tested.
- [ ] **Test (unit/integration):** Covers the empty/non-zero-prime proceed-with-warning path AND the record→next-prime reuse round-trip (AC-2). Test must also cover: `.mulch/expertise/<domain>.jsonl` contains malformed JSON lines — `ml prime` logs parse errors (exit code 2) and the wrapper proceeds with whatever valid entries it could parse. If `.mulch/expertise/` directory is missing entirely, `ml prime` returns exit code 0 with empty JSON `{context:"",facts:[],domain:"<domain>",expertise_count:0}` — advisory proceed with warning. If `.mulch/` exists but is a file instead of a directory, the wrapper logs the error and proceeds with empty context; concurrent record: two concurrent `ml record` calls for the same domain do not corrupt the JSONL file — both entries appear, no partial/truncated lines. File locking is handled by `ml record` internally (P0.9-B2), but this test validates it in the run-loop context.
- [ ] **Test (tenant isolation):** A `ml prime` for `{repoB}` returns none of `{repoA}`'s recorded entries (INV-1/INV-2).
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1 trigger: runs a real `qds-piv-loop` run; asserts `ml prime` text is in the node system prompt before exec AND a new `.mulch/expertise` record exists after — proving the house-style loop primes + persists with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
