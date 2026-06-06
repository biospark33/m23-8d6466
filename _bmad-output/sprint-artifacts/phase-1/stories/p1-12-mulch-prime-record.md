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

This slice cuts through Hermes (context assembly + post-run hook) → the Mulch CLI (`/usr/local/bin/mulch` v0.6.3, verbs `prime` / `record`) → the Pi-team implement node's primed system prompt (`--context-path` → `--append-system-prompt`, §4.6) → the repo's `.mulch/expertise/<domain>.jsonl` store. PRE-execution, `mulch prime` for the run's repo emits the house-style context that the launcher folds into `--context-path` (judgment roles get the full slice; the constrained Implementer a minimal one — §4.6/NFR-PERF-5). POST-run, `mulch record` persists the run's reusable expertise to the repo-scoped `.mulch/expertise/`. It is one atomic 3-pt unit because the house-style loop is not demonstrable until BOTH halves work on the same run — a prime that reaches the prompt AND a record that lands in `.mulch/` and is reusable by the next prime — splitting them leaves a half-loop. Mulch (house-style, file-store) is a distinct store from Hindsight (run-memory, P1.11); priming is additive to the Hindsight prime, not a replacement.

## E2E Slice

**Demonstrable behavior:** A `qds-piv-loop` run on a `{repo}` issue (1) invokes `mulch prime` for `{repo}` BEFORE the implement node executes and the emitted house-style text appears in the node's system prompt, and (2) invokes `mulch record` AFTER the run so a new reusable-expertise entry is appended to `{repo}`'s `.mulch/expertise/<domain>.jsonl`, retrievable by a subsequent `mulch prime` on the same repo.

**Wiring closed:** On completion of this story, a real run primes house-style context from `mulch prime` into the implement node's system prompt before execution AND records reusable expertise via `mulch record` into `{repo}`'s `.mulch/expertise/<domain>.jsonl` after, with the recorded entry visible to the next `mulch prime`, using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.9 (Mulch pinned at `/usr/local/bin/mulch` 0.6.3 — a private CLI, NOT an npm package; `prime`/`record`/`learn` verbs confirmed; the repo's `.mulch/expertise/` store initialized), P1.6 (the Pi-team implement node exists and accepts a primed system prompt via `--context-path` / `--append-system-prompt`). The Hindsight run-memory prime/retain is the SEPARATE sibling story **P1.11** (different store, dependency-independent — not wired here).

## Acceptance Criteria

1. **(make-or-break)** Given a `qds-piv-loop` run for a `{repo}` issue, When the run executes end-to-end, Then `mulch prime` runs for `{repo}` BEFORE the implement node (its house-style text appears in the node's system prompt) AND after the run a NEW reusable-expertise entry is present in `{repo}`'s `.mulch/expertise/<domain>.jsonl` that was not there before. (Binary: prime text in the system prompt before node exec AND a new `.mulch/expertise` record after.)
2. Given the post-run `mulch record` succeeded, When a subsequent `mulch prime` runs on the same `{repo}`, Then the recorded entry is reflected in that next prime's output (the expertise is reusable across runs, not write-only).
3. Given `mulch prime` returns no/empty house-style context (fresh repo) OR the Mulch CLI exits non-zero on prime, When the launcher assembles `--context-path`, Then the node proceeds with the rest of its context and a logged warning (Mulch prime is advisory/non-blocking, NFR-PERF-5) — never a hang, never a halt.
4. Given a run for `{repoA}`, When `mulch record` fires, Then the expertise is written ONLY to `{repoA}`'s `.mulch/expertise/` and a subsequent `mulch prime` for `{repoB}` returns NONE of `{repoA}`'s recorded entries — no cross-repo leak.

## Technical Notes

- **Contracts/Schema (CLI + JSONL):** Prime = `mulch prime` (repo-scoped, emits house-style text folded into `--context-path`); record = `mulch record` (appends to `.mulch/expertise/<domain>.jsonl`, the verified store shape — r4 §6). Mulch is the binary `/usr/local/bin/mulch` 0.6.3 — invoked as a subprocess, NEVER `npm install mulch` (the npm name is an unrelated project). The `.mulch/expertise/` store is repo-local and travels with the repo.
- **Integration points (each wired & exercised):** (1) `mulch prime` PRE-execution → output folded into the launcher `--context-path` → `--append-system-prompt` (P1.6 surface; judgment roles full, constrained Implementer minimal — §4.6); (2) `mulch record` POST-run → `.mulch/expertise/<domain>.jsonl`; (3) the prime→inject and record handoffs logged with issue-id correlation (NFR-OBS-3).
- **Files / functions touched:** the Mulch prime step (run `mulch prime`, fold into context bundle), the post-run `mulch record` hook, the Mulch CLI wrapper (subprocess invoke + repo-scoped cwd), the empty/non-zero-prime fallback path.
- **Guards/limits:** `mulch prime` is advisory and non-blocking (NFR-PERF-5) — bounded so it never blocks node dispatch; on empty/error it degrades to a logged warning and proceeds.

## Files to Modify

- `scripts/mulch/prime-step.ts`
- `scripts/mulch/record-on-finish.ts`
- `scripts/mulch/cli.ts`
- `scripts/mulch/context-fold.ts`
- `config/mulch.config.ts`
- `test/mulch/prime-record.e2e.test.ts`
- `test/mulch/tenant-isolation.test.ts`

## Security Invariants

- **INV-1 (tenant):** `mulch prime` and `mulch record` are scoped to the run's own `{repo}` (repo-local `.mulch/expertise/` via the repo cwd/worktree); a run for `{repoA}` MUST NOT prime from or record into `{repoB}`'s expertise store — no cross-repo read or write (AC-4).
- **INV-2 (tenant):** Recorded expertise is repo-scoped and travels with the repo; a subsequent `mulch prime` for a different repo returns none of another repo's entries (no cross-repo leak via a shared/global Mulch path).
- **INV-3 (secrets/input):** The house-style text folded into `--context-path` and the recorded expertise are sanitized — no secret value (API keys, tokens, `PAPERCLIP_API_KEY`) is ever written into the Mulch store or the primed prompt; the Mulch subprocess inherits a redacted env, not raw credentials.

## Definition of Done

- [ ] **Impl:** The Mulch prime step runs `mulch prime` for the run's `{repo}` BEFORE the implement node and folds the house-style output into the launcher `--context-path`.
- [ ] **Impl:** The record-on-finish hook runs `mulch record` after the run, appending a reusable-expertise entry to `{repo}`'s `.mulch/expertise/<domain>.jsonl`.
- [ ] **Impl:** Empty/fresh-repo prime and a non-zero `mulch prime` exit both degrade to a logged warning and proceed (advisory, NFR-PERF-5) — never a hang or halt.
- [ ] **Contract:** The Mulch CLI wrapper invokes the pinned binary `/usr/local/bin/mulch` 0.6.3 (`prime`/`record`) as a subprocess (NEVER `npm install`); the `.mulch/expertise/<domain>.jsonl` append shape is honored.
- [ ] **Integration:** The `mulch prime` output demonstrably reaches the implement node's system prompt (`--context-path` → `--append-system-prompt`, P1.6 surface), and the `mulch record` entry is reusable by the next prime (AC-2).
- [ ] **Observability/Audit:** The prime→inject and record handoffs are logged with issue-id correlation (NFR-OBS-3).
- [ ] **Security:** INV-1/INV-2 (tenant: prime/record scoped to own `{repo}`, no cross-repo read or write) and INV-3 (no secret in the store or prompt) each enforced and tested.
- [ ] **Test (unit/integration):** Covers the empty/non-zero-prime proceed-with-warning path AND the record→next-prime reuse round-trip (AC-2).
- [ ] **Test (tenant isolation):** A `mulch prime` for `{repoB}` returns none of `{repoA}`'s recorded entries (INV-1/INV-2).
- [ ] **Test (e2e demo — MANDATORY):** Fires AC-1 trigger: runs a real `qds-piv-loop` run; asserts `mulch prime` text is in the node system prompt before exec AND a new `.mulch/expertise` record exists after — proving the house-style loop primes + persists with wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
