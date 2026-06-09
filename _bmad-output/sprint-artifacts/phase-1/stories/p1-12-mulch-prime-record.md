# P1.12: Mulch Prime/Record Wiring via CLI-Anything Harness

**Story Points:** 3

## Spec Reference

- PRD §5.2; FR-MEM-5

## User Story

As a dev manager,
I want house-style context primed from Mulch expertise files before execution and reusable expertise recorded after,
so that each run carries the project's accumulated style and conventions and contributes back to the expertise store.

## Overview

Before a protocol step executes, the CLI-Anything harness calls `mulch prime` to load house-style context from `.mulch/expertise/<domain>.jsonl` files into the Pi agent's working context. After the step completes, the harness calls `mulch record` to persist new reusable expertise (patterns, conventions, corrections) back to the expertise store. Mulch CLI at `/usr/local/bin/mulch` v0.6.3 provides three verbs: `prime` (load context), `record` (persist expertise), `learn` (batch consolidation). The prime/record loop ensures house-style consistency across runs and accumulates project-specific knowledge over time.

## E2E Slice

**Demonstrable behavior:** A protocol step for issue #42 starts. CLI-Anything harness runs `mulch prime --domain typescript --json` and loads house-style entries (naming conventions, import ordering, error-handling patterns) from `.mulch/expertise/typescript.jsonl` into the Pi agent context. After the step executes and the agent followed the house style, the harness runs `mulch record --domain typescript --content "prefer const assertions for readonly objects" --source issue-42` to persist the new pattern. On the next run, `mulch prime` returns the accumulated expertise including the new entry.

**Wiring closed:** On completion of this story, the house-style loop (prime → execute → record) primes and persists expertise across runs using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.9, P1.6

## Acceptance Criteria

1. **(make-or-break)** Given a protocol step is about to execute, When the CLI-Anything harness primes the agent context, Then it runs `mulch prime --domain <domain> --json` and the returned expertise entries are injected into the Pi agent's working context.
2. Given a protocol step has completed and produced new reusable expertise, When the harness records, Then it runs `mulch record --domain <domain> --content <content> --source <issue-N>` and the entry is appended to `.mulch/expertise/<domain>.jsonl`.
3. Given `mulch prime` returns no entries for a domain, When the context is injected, Then the step proceeds without house-style context and no error is raised — empty expertise is not a failure.
4. Given the Mulch CLI binary is not found at `/usr/local/bin/mulch`, When the harness attempts to prime, Then the step proceeds without primed context, a `waiver.reason: 'mulch-unavailable'` is logged, and the record step is skipped.

## Technical Notes

- **Contracts/Schema:** `mulch prime --domain <domain> --json` returns: `{ entries: MulchEntry[] }`. `MulchEntry { id: string, domain: string, content: string, source: string, recorded_at: ISO8601 }`. `mulch record --domain <domain> --content <string> --source <string>` returns: `{ id: string, domain: string, status: 'recorded' }`. Store path: `.mulch/expertise/<domain>.jsonl` (one JSON object per line).
- **Integration points:** Mulch CLI at `/usr/local/bin/mulch` v0.6.3; CLI-Anything harness (wraps `warren run`); `.mulch/expertise/` directory in repo root; SwarmClaw protocol phase executor for prime/record hooks.
- **Files / functions touched:** `src/mulch/mulch-client.ts` (CLI wrapper for prime/record), `src/mulch/prime-phase.ts` (pre-execution prime wiring), `src/mulch/record-phase.ts` (post-execution record wiring), `src/protocol/phase-executor.ts` (prime/record hooks integration), `src/models/mulch-entry.ts` (schemas).
- **Guards/limits:** Prime timeout: 10s. Record timeout: 5s. Content max for record: 2000 characters. Domain names: lowercase alphanumeric + hyphens, max 64 chars.

## Files to Modify

- `src/mulch/mulch-client.ts`
- `src/mulch/prime-phase.ts`
- `src/mulch/record-phase.ts`
- `src/protocol/phase-executor.ts`
- `src/models/mulch-entry.ts`

## Security Invariants

- INV-MULCH-1: Record entries are appended to `.mulch/expertise/<domain>.jsonl` — no mutation or deletion of existing entries by the harness.
- INV-MULCH-2: Record `--source` parameter must reference an issue number — no anonymous expertise writes.
- INV-MULCH-3: Mulch CLI path is restricted to `/usr/local/bin/mulch` — no arbitrary binary execution.

## Definition of Done

- [ ] **Impl:** Pre-execution prime: `mulch prime --domain <domain> --json` loads expertise entries into Pi agent context
- [ ] **Impl:** Post-execution record: `mulch record --domain <domain> --content <content> --source <issue-N>` persists expertise
- [ ] **Impl:** Empty prime result → step proceeds without house-style context, no error
- [ ] **Impl:** Mulch CLI unavailable → proceed without prime, log `waiver.reason: 'mulch-unavailable'`, skip record
- [ ] **Contract:** `MulchEntry` schema defined; `mulch prime` and `mulch record` CLI contracts documented
- [ ] **Integration:** Mulch CLI v0.6.3 at `/usr/local/bin/mulch`; `.mulch/expertise/` store; CLI-Anything harness hooks
- [ ] **Security:** Append-only expertise store; source-tagged records; restricted CLI path
- [ ] **Test (unit):** Prime returns entries and injects context; record appends to jsonl; empty prime → proceed; CLI missing → waiver; record source validation
- [ ] **Test (e2e demo — MANDATORY):** Full protocol run where `mulch prime` loads TypeScript expertise, agent follows house style, `mulch record` persists new pattern; next run's `mulch prime` returns the accumulated expertise including the newly recorded entry
