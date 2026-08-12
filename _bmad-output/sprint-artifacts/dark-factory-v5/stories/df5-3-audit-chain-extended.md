# DF5.3: Audit Chain Extended to Credential, Box, Bundle and Re-Verify Links

**Story Points:** 4
**Sprint:** v5-S3 (observability, audit, and the loop)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §6 item 4 (central
  append-only run/audit log, host-side, surviving box destruction; gate-evidence trace; cost ledger
  with per-run attribution; PR bodies carrying run correlation ids), §6 item 6 (F10), §5.3, §8 step 5
- Decision register: v5 §4 **D8** (mint→cap→use→revoke→verify; central append-only audit log), **D7**
- Derivation decisions: `2026-08-11-v5-story-derivation-decisions.md` **DD-4** + **§4 row 3** (retain
  link recorded VOID), **DD-7** (SwarmClaw is the HTTP home if one is needed), **DD-8**, **DD-9**
- Surviving clauses: R2 §8 — `p1-16-audit-chain-pr.md:29, :30, :31, :32, :36, :39, :51-53, :63`.
  **NET-NEW per R2 §11 items 19 and 21** (`qds audit` CLI, immutable link references) are authored
  fresh against design §6 item 4, not inherited. Item 20 (CI verification of merged factory PRs) is
  **not taken** in v5.0 — see the Trigger Surface row.
- VOID convention: P0.11 chassis `src/gate/gate-runner.ts:167-178`; binding facts R5 §6 **15–18**

## User Story

As an enterprise reviewer asked to trust an autonomous factory with a client's codebase,
I want one command that walks a merged PR back through every host-side record that authorized it —
the re-verify that earned it, the approval that released it, the key that paid for it,
so that "the factory did this" is a walk over immutable records rather than an assertion.

## Overview

`recordAuditLink` appends one immutable row to a host-side `audit_links` store the moment each
link-worthy event happens — key mint, cap, revoke, revocation-verify, box create through reap,
bundle verification. `walkAuditChain` resolves ten hops by joining those rows against records
predecessors already write: DF1.4's trace session, DF2.8's ledger, DF2.1's run record, DF3.4's
approval, DF5.1's re-verify record, DF5.2's PR. The spine is host-side only; in-box evidence attaches
as a *claim* and never satisfies a hop (F10), and the memory hop is recorded **VOID** pending step 6.
`qds audit <ref>` prints the walk. It is an operator-side command by construction: every store it
reads is host-local, so there is no CI job in v5.0 (Trigger Surface).

## E2E Slice

**Demonstrable behavior:** Given a merged PR on branch `qds/qds-20260811-a3f19c` produced by DF5.2,
When the operator runs `qds audit https://github.com/qds/demo/pull/57`, it resolves PR→run→issue,
run→cost (a µ$ total plus per-role split), run→credential (four timestamped rows carrying `key_hash`,
never key material), run→box, run→bundle, run→re-verify, run→approval, run→gate evidence, and
run→memory as `{ status: "void", reason: "OQ-4 …" }` — ten hops, zero nulls, exit `0`, under 30 s.

**Wiring closed:** On completion of this story, a PR is walkable back to every host-side record that
authorized it using only code merged by this story plus the durable records its predecessors already
write. No stub, no `TODO: wire later`. DF5.4's gate calls this walker; it does not complete it.

**Dependency edges (predecessors):** DF1.4, DF1.8, DF2.1, DF2.3, DF2.5, DF2.8, DF3.4, DF5.1, DF5.2
(R5 §2) — the full set, because this story edits four DF2.x-owned files and resolves records those
stories write. P1.11/P1.12's retain-receipt edge is **degraded to VOID**, not satisfied (R5 §5.3,
DD-4). *Scope note on the shared files: every edit to `credentials.ts`, `run-record.ts`,
`harvest.ts` and `teardown.ts` is a single-line `recordAuditLink(...)` emit at an existing event
site. No logic, control flow or exported signature in those files changes, so there is no
double-implementation risk with their owning stories — only a merge-order dependency.*

## Acceptance Criteria

1. **(make-or-break)** Given a PR produced by DF5.2 for a completed run, When the walker is invoked
   with the PR URL, branch name, or runId, Then **all ten hops** (Technical Notes) resolve to a
   non-null record with a stable ID. The returned chain is an object **keyed by contributing runId**,
   each key carrying that run's own ten-hop set; this story's walker always produces exactly one key —
   the parent run reached at hop 1 — and "the chain is complete" means every hop of every key
   resolved. Hop 10 — Hindsight's **retain receipt** — is typed
   `{ status: "void", reason }` per the P0.11 VOID convention pending step 6 (DD-4). *Negative
   controls: returning `null`, omitting the memory hop, or calling a chain complete while a hop is
   absent MUST fail this AC.*
2. Given a broken correlation key — no runId in the PR body, a runId with no session row, a
   `key_hash` with no revoke row — Then the walker names the **specific** broken hop with
   `{ hop, expected, actual, diagnostic, evidencePath }` and exits non-zero; it never returns a
   partial chain reported as complete, and never fails silently (`p1-16-audit-chain-pr.md:31`).
3. Given the credential events and box-lifecycle transitions, When each occurs, Then its link row is
   written **by its emitter at the moment of the event, never retroactively**
   (`p1-16-audit-chain-pr.md:39, :63`); a run whose links were never emitted resolves those hops as
   `unlinked` naming the emitter, and no link is ever synthesized by inference from end state.
4. Given the walk, Then total wall clock is under **30 seconds** with a 3-second per-hop ceiling, and
   a hop exceeding its ceiling fails closed as `hop-timeout` rather than reported resolved
   (`p1-16-audit-chain-pr.md:32`; budget defended in Technical Notes).
5. Given a healthy run where a hop is legitimately absent — a run with no `box_hours` row because the
   box never reached `execute`, so hop 3's cost total carries token spend only — Then it resolves to a
   typed `{ status: "not-applicable", reason }`, not a null, and the chain is complete; a chain
   resolving only `void`/`not-applicable` hops is **broken**, never vacuous. Hop 8 (approval) is
   **never** `not-applicable` for a PR-bearing run: DF5.2's INV-PR-5 means no PR exists without an
   approval, so an absent approval on a run that has a PR is a broken hop, not an inapplicable one.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `qds audit <pr-url\|branch\|runId>` operator CLI (`scripts/qds-audit.ts`) | in-scope | `tests/scripts/qds-audit.test.ts` | — |
| `recordAuditLink` called from each event's own emitter: DF2.3 `credentials.ts` (mint/cap/revoke/verify), DF2.1 `run-record.ts` (create/fill/setup/execute/observe transitions), DF2.5 `harvest.ts` (bundle verification) and `teardown.ts` (teardown/reap) | in-scope | `tests/audit/link-store.test.ts` | — |
| CI chain verification on merged factory PRs | out-of-scope — the walk asserts against host-only stores (`audit.db`, `cost-ledger.db`, `.sandbox/`) that no GitHub runner has; a CI job could only ever assert a broken chain | — | none in v5.0 — re-enters if the host stores gain a remote query surface (DD-7) |
| `walkAuditChain` invoked as a gate clause | out-of-scope | — | DF5.4 |
| HTTP chain-query surface on the SwarmClaw chassis (DD-7) | out-of-scope | — | DF5.5 |
| Memory retain-receipt hop against a live Hindsight bank | out-of-scope (VOID, DD-4) | — | §8 step 6 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Host-side link store `<host_data_dir>/audit.db` | `bun:sqlite`, bundled with the project's bun toolchain — no new dependency | schema migrated idempotently (`CREATE TABLE/TRIGGER IF NOT EXISTS`, serialized with `BEGIN IMMEDIATE` + `busy_timeout`) during the first `recordAuditLink` (write-time init) only; the walker opens read-only and **never** migrates — an uninitialized store (zero `recordAuditLink` calls) fails the walk closed with a named broken hop per INV-AUDIT-6; host-side so it survives box destruction (§6 item 4) |
| DF2.8 cost ledger `<host_data_dir>/cost-ledger.db` · DF1.4 trace session · DF2.1 run record | host `bun:sqlite` store · `src/phase-engine/trace/` · `.sandbox/runs/<id>.json` | the cost hop calls DF2.8's exported `readRunCost(runId)` — run-keyed, never the issue-scoped `readIssueCost`, so a run dispatched without an issue still resolves hop 3 — and never a second SUM; all three resolvable by runId at walk time, and an unreadable record is a named broken hop, never a skipped one |
| DF5.1 re-verify record · DF3.4 approval record · DF5.2 PR record · GitHub PR body read | host-side artifacts written by those stories; GitHub API with the host-side token | each read read-only by path — the walker asserts presence and identity and never re-runs the underlying action; the token is checked by name only and never reaches a diagnostic or the chain object (INV-AUDIT-2) |

## Technical Notes

- **Hop table (NET-NEW per DD-8).** The source's 8 hops (`p1-16-audit-chain-pr.md:36`) re-aimed and
  extended to ten; hops 4–7 are the v5 links the source story could not know:

  | # | Hop | Join key / evidence | Origin |
  |---|-----|--------------------|--------|
  | 1 | PR → run | branch `qds/{runId}` + runId in PR body | DF5.2 |
  | 2 | run → issue | `(repo_slug, issue_id)` on the session row | DF1.8 / DF1.4 |
  | 3 | run → cost | DF2.8's `readRunCost(runId)` — µ$ total + per-role split, keyed by run, not issue | DF2.8 |
  | 4 | run → credential | `key_hash`; mint/cap/revoke/verify events | DF2.3 links |
  | 5 | run → box | create→fill→setup→execute→observe→teardown→reap (DF2.1 verbs) | DF2.1/DF2.5 links |
  | 6 | run → bundle | verification record + `refs/sandbox/<run-id>` | DF2.5 link |
  | 7 | run → re-verify | host-side test + gate results that authorized the PR | DF5.1 |
  | 8 | run → approval | approver id, decision, `decidedAt` | DF3.4 |
  | 9 | run → gate evidence | phase + gate results, attached as claims | DF1.4 |
  | 10 | run → memory | retain receipt — **VOID** | *(step 6)* |

- **Hop 10 is recorded VOID (BINDING — DD-4, register §4 row 3):** `{ hop: "memory-retain-receipt",
  status: "void", reason: "OQ-4 unresolved — Hindsight has never booted on this host (arm64
  libpq/openssl@3; :8888 collides with a local Jupyter); step-6 memory wiring is outside the v5
  horizon" }` — P0.11's convention (`gate-runner.ts:167-178`): recorded for traceability, resolver
  never invoked, excluded from the verdict. A *typed outcome*, never a null, omission or stub probe.
- **Link schema:** `audit_links { link_id PK, run_id, repo_slug, request_id, hop, event, subject_id,
  subject_kind, evidence_path, evidence_digest, detail_json, occurred_at, recorded_at }` — all but
  `subject_*`, `evidence_*`, `detail_json` are `NOT NULL`, and `UNIQUE (run_id, hop, event,
  COALESCE(subject_id, '<none>'))` (via a generated column) makes a redelivered emit a no-op
  on the sentinel, not on distinct NULLs (NULLs are distinct in a SQLite UNIQUE index) (`INSERT … ON CONFLICT DO NOTHING`), never an update.
  `evidence_digest` (SHA-256 of the artifact) makes a link **immutable** (R2 §11 item 21): a
  rewritten artifact stops matching, and the hop reports `evidence-mismatch`.
- **Ten hops *per contributing runId*, and why the return shape is a map (DF6.1 reciprocal).** The
  ten hops above are the hop set for **one** run, and `walkAuditChain` returns them keyed by
  contributing runId. This story's walker resolves exactly one key: the parent run it reaches from
  the ref at hop 1 — a PR with no fix attempts has one contributor, so the default is a single-entry
  map, not a bare hop list. DF6.1 (PR-feedback fix loop) extends `src/audit/chain.ts` **additively**:
  it reads the parent record's `extensions.fixLoop.fixOutcome.runIds` and adds one key per fix runId,
  each resolving the same ten hops. It adds **no hop**, changes **no** hop definition, join key,
  evidence rule or exported signature, and each fix run emits its own links at this story's event
  sites — so DF6.1's "adds only" claim and this story's ownership of the hop table are the same
  statement read from two sides. Merge order: DF6.1 lands **after** this story (both v5-S3), so this
  story is written against the single-key case and nothing here waits on DF6.1.
- **Host-side spine (INV-AUDIT-5):** hops 1–8 resolve only against host-side records; hop 9's in-box
  trace rows attach as `evidence: { kind: "claim" }` — what the PR *asserted*; hop 7 *earned* it.
- **The 30-second budget, defended not inherited** (R2 §8): 8 hops became 10, but every added hop
  reads local SQLite or JSON and only hop 1 hits the network — 30 s holds, 3 s per-hop, fail-closed.
- **Guards/limits:** the walker opens every store read-only, writing nothing outside `audit_links`.
  Diagnostics cap at 2,000 chars **including** truncation suffix; `detail_json` 8 KiB/row; files `0600`.
- **Deviation/assumption:** DF5.1/DF5.2 are authored concurrently; this story reads their records by
  path and identity only, claiming no field beyond `runId`; a renamed path is fixed in this resolver.

## Observability Contract

- Every walk logs `{ requestId, runId, repoSlug, hop, status, durationMs, outcome }`; every
  `recordAuditLink` logs the same keys plus `{ event, subjectKind }`.
- `requestId` propagates from the dispatch that created the run record — DF1.8's **resolved** value,
  which every downstream record carries. Errors include `{ code, message, remediation }`, the last
  being the literal next command.
- Sub-timings: `per_hop_ms` keyed by hop name, plus `pr_fetch_ms`; a hop that did not run reports 0.

## Files to Modify

- `src/audit/link-store.ts`
- `src/audit/chain.ts`
- `src/audit/index.ts`
- `src/providers/credentials.ts`
- `src/providers/run-record.ts`
- `src/providers/harvest.ts`
- `src/providers/teardown.ts`
- `scripts/qds-audit.ts`
- `tests/audit/link-store.test.ts`
- `tests/audit/chain.test.ts`
- `tests/scripts/qds-audit.test.ts`

## Security Invariants

- **INV-AUDIT-1 (repo scoping):** the walker reads only stores and records within the run's own
  `repo_slug` scope — no cross-repo, no cross-tenant read. Identity is `(repo_slug, issue_id)`, never
  an issue number alone: `#42` exists in every repo the factory touches.
- **INV-AUDIT-2 (no secret material in the chain or its diagnostics):** the GitHub token, the
  `OPENROUTER_PROVISIONING_KEY` and **minted key material** never appear; credential hops carry
  `key_hash` and an 8-char hash prefix only — `p1-16:52` extended to credential events.
- **INV-AUDIT-3 (cost granularity, µ$ per DD-9):** the cost hop reports aggregated micro-dollar
  totals and the per-role split — never raw per-token billing detail that could leak pricing tiers.
- **INV-AUDIT-4 (append-only, written at creation):** rows are immutable, enforced by `BEFORE UPDATE`
  / `BEFORE DELETE` triggers that `RAISE(ABORT)`, with no update or delete statement in the module.
  Links are emitted at event time, never backfilled — a chain assembled retroactively is forged.
- **INV-AUDIT-5 (host-side spine; in-box evidence is a claim):** no hop may be satisfied by evidence
  produced inside a box (F10, R5 §6 fact 15). An implementation resolving hop 7 from the in-box gate
  results instead of DF5.1's host-side re-verify record MUST fail its test.
- **INV-AUDIT-6 (fail closed, never vacuous):** an unreadable store, unresolvable hop or digest
  mismatch yields a named broken hop and a non-zero exit — never a partial chain called complete. A
  chain resolving only `void`/`not-applicable` hops is broken, mirroring the chassis rule that a gate
  with no live assertions is FAIL (`gate-runner.ts:324-326`).

## Definition of Done

- [ ] **Impl:** `recordAuditLink` writes append-only rows with
      `UNIQUE (run_id, hop, event, COALESCE(subject_id, '<none>'))` **via a generated column** — the
      literal form from the Technical Notes, never the bare `subject_id` column, because NULLs are
      distinct in a SQLite UNIQUE index and a bare column lets a redelivered subject-less emit
      duplicate — plus `ON CONFLICT DO NOTHING` and an `evidence_digest` computed at emit time.
- [ ] **Impl:** `walkAuditChain(ref)` accepts a PR URL, branch name or runId and resolves the ten
      hops in the Technical Notes table **per contributing runId**, returning a map keyed by that
      runId — one entry, the parent run, for every ref this story can be handed.
- [ ] **Contract:** `qds audit <ref>` prints per-hop status and exits `0` complete / `1` broken.
- [ ] **Integration:** link rows emitted at event time by each event's own emitter — `credentials.ts`
      (mint/cap/revoke/verify), `run-record.ts` (box transitions), `harvest.ts`, `teardown.ts`.
- [ ] **Security:** hop 10 recorded VOID with its reason per DD-4, excluded from the verdict
      (INV-AUDIT-6); a redaction test asserts no key material, token or plaintext reaches any hop,
      diagnostic or log line (INV-AUDIT-2).
- [ ] **Test (unit):** a complete run resolves ten hops per contributing runId with zero nulls — one
      key, the parent run — the memory hop typed `void`,
      the cost hop reporting a µ$ total plus per-role split.
- [ ] **Test (broken hop):** a PR body with no runId → hop 1 named with expected/actual/diagnostic
      and a non-zero exit; an implementation returning the other nine as "complete" MUST fail.
- [ ] **Test (in-box-evidence negative control):** DF5.1's re-verify record absent but the in-box gate
      results green → hop 7 broken (INV-AUDIT-5); an implementation reading the in-box results as
      authority passes the happy path and MUST fail this test.
- [ ] **Test (immutability + retroactive-link rejection):** `UPDATE`/`DELETE` on a link row aborts;
      a tampered artifact yields `evidence-mismatch`; a run with no links resolves `unlinked`.
- [ ] **Test (e2e demo — MANDATORY):** walk a real merged factory PR and capture the printed chain as
      an artifact — ten hops, the VOID memory hop with its OQ-4 reason, a µ$ cost total, under 30 s.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
