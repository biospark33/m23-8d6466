# R1 — QDS-Factory v4 Story Template & End-to-End Vertical-Slice Standard

**Audience:** Phase-2 writing agents for the v4 sprint-planning run.
**Use:** Paste the skeleton in §3, fill every section, then self-check against §1 (E2E standard), §2 (DOD categories), and §4 (worked micro-example). A story that cannot satisfy §1 is not a story — it is two stories plus a dependency edge.

**System under planning:** TypeScript/Node + Postgres + CLI + 4-layer multi-agent orchestration (Paperclip control plane → Hermes managers → Archon `qds-piv-loop` DAG → Pi teams, with pi-lens gating, Seeds dependency store, Hindsight memory, Telegram HITL). **No frontend track.** Contracts are **Zod schemas / TypeScript types / JSON message contracts / SQL DDL** — NOT Pydantic.

---

## 1. The End-to-End Vertical-Slice Standard (the quality bar)

Every v4 story ships **one working capability with no leftover wiring**. This is the single most important rule and overrides every other convenience.

### 1.1 What "end-to-end vertical slice" means here

A story is an E2E vertical slice iff, **on the story's own completion**, its capability is **demonstrable end-to-end** by a concrete trigger that exercises every integration point the story touches:

- a **command runs** (e.g. `pi-team-launch.sh "…" ./ctx` returns a single merged JSON object on stdout), OR
- a **DAG node executes** (the Archon node runs and emits a single structured JSON result into node output), OR
- a **message round-trips** (a `coms_send` → `coms_await` exchange completes within its timeout, or a Telegram approve tap resumes a paused run), OR
- an **audit hop resolves** (the §8.1 chain walks epic → Seeds → Paperclip issue → cost_events → approvals → heartbeat_runs → Archon run → Pi team → pi-lens → Hindsight with **no missing hop** for the surface this story adds), OR
- a **row/ledger entry lands and is queryable** (a `cost_events` row is written and per-issue spend is readable; a migration applies and the table is queryable).

The slice is "vertical" because it cuts through **schema → executor/logic → integration → observable result**, however thin. It is **not** a horizontal layer (e.g. "add the schema field" with no executor wiring is NOT a slice).

### 1.2 "Wiring closed" — the precise definition

**"No leftover wiring" means:** at the moment this story is marked done, there exists **no stub, no `// TODO: wire later`, no dangling integration point, and no behavior gated on a sibling story** for THIS story's exit-criterion to be real. Every integration point the story touches (schema field consumed, port called, event subscribed, ledger row written, env var read by the subprocess) is **connected and exercised within this story**. If the demonstrable trigger in §1.1 fires and produces the asserted result **using only code merged by this story**, wiring is closed.

A genuine prerequisite is **not** leftover wiring — it is a **dependency edge** to a *separate, already-defined* predecessor story. The test: *"If predecessor X is done, does THIS story's trigger work end-to-end with nothing left to connect?"* If yes → dependency edge (fine). If "no, because another story still has to finish wiring up what I built" → **the slice is broken; re-cut.**

### 1.3 The standardized "wiring closed" assertion (copy verbatim into every `## E2E Slice`)

> **Wiring closed:** On completion of this story, `{TRIGGER}` produces `{OBSERVABLE RESULT}` using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

Fill `{TRIGGER}` with the exact command/node/message/hop and `{OBSERVABLE RESULT}` with the exact stdout/row/state. Keep it to those two-to-three sentences.

### 1.4 The make-or-break Acceptance Criterion

Exactly one AC per story is the **binary make-or-break** clause — the same shape as the PRD §13 per-phase gates (each clause independently pass/fail). It must restate the §1.3 trigger as a Given/When/Then whose Then is a single observable, machine-checkable fact (stdout equals, row exists, exit code non-zero, no missing hop). Mark it **(make-or-break)**.

---

## 2. Definition of Done — categories & guidance (8–12 boxes, high-signal only)

**Hard cap 8–12 boxes.** Per atomicity-audit check 4, **do NOT pad with project-wide CI invariants** (`lint clean`, `tests pass`, `typecheck`, `format`, `mypy`/`tsc clean as a generic gate`) — those are CI guarantees, not story DOD. Every box must be **story-specific and verifiable**. Draw from these categories (not all are required every story; pick what the slice actually touches):

| Category | What goes here | Trigger to include it |
|----------|----------------|------------------------|
| **Implementation** | The concrete code/behavior delivered (node/handler/script/migration applied). | Always (2–4 boxes). |
| **Testing** | Unit/integration tests for the new behavior **PLUS the e2e demonstration box** that fires the §1.3 trigger and asserts the observable result. | Always — the e2e box is mandatory (2–4 boxes). |
| **Contracts / Schema** | Zod schema / TS type / JSON message contract / SQL DDL added or changed, with field-level validation; backward-compat noted. | When a contract/schema/DDL changes (1–3 boxes). |
| **Observability / Audit** | Structured emit, SSE/heartbeat trace, `cost_events` row, audit-hop reconstructability, pi-lens/TDI surface. | When the story touches a run, cost, or the audit chain (1–3 boxes). |
| **Security Invariants** | Budget/turn/time guard enforced, secrets not leaked, env-merge non-regression, authz/approval gate, tenant/RLS, migration safety. | When §2.x security keywords are triggered — then ≥1 box AND a populated `## Security Invariants` section (N/A is NOT allowed). |
| **Integration** | The specific port/event/ledger/subprocess wired and exercised: Seeds↔Paperclip sync, StatePort/ToolPort, env injected into bash node, Telegram round-trip, Hindsight retain/recall. | Always for an E2E slice (1–3 boxes) — this is where "wiring closed" is proven. |

**Security keyword classes (verbatim from the atomicity audit — keep in sync):** RLS/row-level security/policy · migration/DDL/schema change/alembic · auth/authentication/authorization/RBAC/capability/scope/permission · encryption/secrets/KMS/vault/credential · PII/personal data/GDPR/HIPAA · payment/billing/financial/PCI · tenant/multi-tenancy/cross-tenant · upload/file handling/deserialization/parse. **For v4 also treat as triggers:** budget/cost cap, env injection into a subprocess, audit-chain hop, worktree isolation. When any fire → `## Security Invariants` must contain **concrete named invariants**, never `N/A`.

---

## 3. The copy-ready story skeleton

> Paste from the line below to the end of §3. Fill every `{…}`. Keep normative content ≤200 lines. Delete instructional `> …` quote lines before shipping.

```markdown
# {STORY_ID}: {Title (≤1 "and"; one concern)}

**Story Points:** {3 or 4}   <!-- HARD CAP 3–4. If it feels like 5+, split and add a dependency edge. -->

## Spec Reference

- PRD §{N} ({section name}); FR-{XX-N}{, NFR-{YY-N}}
- Phase exit gate: PRD §13 Phase {P} clause {k} (if this slice satisfies a named gate clause)
> Reference real IDs from prd-qds-factory-v4.md. The make-or-break AC should map to a §13 gate clause where one exists.

## User Story

As a {persona — Operator / Dev|QA|Maint manager / Pi worker / external stakeholder},
I want {capability},
so that {value tied to a G1–G4 goal}.

## Overview

{3–8 lines: the technical shape of the slice — which layer(s) it cuts through
(Paperclip / Hermes / Archon DAG / Pi team / pi-lens / Seeds / Hindsight /
Postgres), the key pattern, and why this is one atomic 3–4pt unit.}

## E2E Slice

**Demonstrable behavior:** {The single trigger — a command run / DAG node exec /
message round-trip / audit-hop resolve / ledger row — and the exact observable
result.}

**Wiring closed:** On completion of this story, {TRIGGER} produces {OBSERVABLE
RESULT} using only code merged by this story. No stub, no `TODO: wire later`, and
no sibling story is required to make this behavior real. Predecessors, if any, are
dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** {Story IDs this slice assumes are done, or "None — standalone".}

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given {precondition}, When {the §1.3 trigger fires},
   Then {single observable machine-checkable fact — stdout equals / row exists /
   exit code / no missing hop}.
2. Given {…}, When {…}, Then {…}.
3. Given {failure/guard path}, When {…}, Then {guard fires — non-zero exit /
   halt / gate, never silent continue}.

## Technical Notes

- **Contracts/Schema:** {Zod schema / TS type / JSON message contract / SQL DDL —
  field names + validation. Note backward-compat for existing rows/nodes.}
- **Integration points (each wired & exercised in this story):** {port/event/
  ledger/subprocess — e.g. env merged into `executeBashNode`, `cost_events` FK→issue,
  Seeds→Paperclip idempotent sync, `coms_send/await`, Telegram inline button,
  Hindsight retain/recall.}
- **Files / functions touched:** {key symbols, e.g. `dag-executor.ts:executeBashNode`.}
- **Guards/limits:** {budget/turn/wall-clock/coms_await timeout if relevant.}

## Files to Modify

> ≤10 unique paths. Absolute or repo-relative, one per line.

- `{path/one.ts}`
- `{path/two.ts}`
- `{...}`

## Security Invariants

> REQUIRED & non-empty when any security keyword (§2) is triggered. Concrete named
> invariants only — `N/A` is NOT permitted when triggered. If genuinely no security
> surface is touched, the section may be omitted entirely (do not write a stub N/A).

- {INV-1: e.g. "env injection is a MERGE `{...process.env, ...node.env}` — a node
  with no `env` still inherits parent `PATH`/credentials (non-regression)."}
- {INV-2: e.g. "the loopy-prompt path terminates via budget/turn guard with non-zero
  exit; credits are not exhausted."}
- {INV-3: e.g. "no secret value is written to stdout, logs, or the Hindsight bank."}

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO `lint/tests/typecheck` filler.
> Categories: Implementation · Testing (incl. e2e demo) · Contracts/Schema ·
> Observability/Audit · Security Invariants (if triggered) · Integration.

- [ ] **Impl:** {behavior delivered}
- [ ] **Impl:** {…}
- [ ] **Contract:** {Zod/TS/JSON/DDL added with field validation}
- [ ] **Integration:** {specific port/event/subprocess wired AND exercised}
- [ ] **Observability:** {structured emit / cost_events row / audit hop resolves}
- [ ] **Security:** {one concrete invariant enforced — if triggered}
- [ ] **Test (unit/integration):** {covers the new behavior + a guard path}
- [ ] **Test (e2e demo — MANDATORY):** {fires the §1.3 trigger; asserts the
      observable result; proves wiring closed}

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
```

---

## 4. Worked micro-example (calibration: a sample infra slice)

> Illustrative only — shows the `## E2E Slice` block for the per-node env-patch capability (PRD §4.4 / §13 Phase-0 clause 5). Writers: copy the *shape*, not the content.

**# I-ENV.1: Per-node `env` injection into the Archon bash node**

**Story Points:** 3

**## E2E Slice**

**Demonstrable behavior:** A trivial Archon bash node carrying a per-node `env: { QDS_PROBE: "x7" }` runs via `POST /api/workflows/{name}/run`; the subprocess echoes `$QDS_PROBE` into node output, which equals `x7`. A second bash node with **no** `env` field still echoes an inherited parent-env value (`$PATH` non-empty).

**Wiring closed:** On completion of this story, running the two-node `qds-env-probe` workflow produces node output `QDS_PROBE=x7` for the env-bearing node and a non-empty `PATH` for the bare node, using only code merged by this story (schema field at `dag-node.ts`, merge at `dag-executor.ts:executeBashNode`, widened options type at `@archon/git exec.ts`). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone (Phase-0 env-patch spike `qds/env-patch-spike` is reference, not a code dependency).

> Note the slice cuts all three edit sites (schema + executor + type) in ONE story because the capability is not demonstrable until all three compile and run together — splitting them would leave leftover wiring. The non-regression (bare node still inherits env) is the second AC and a Security Invariant (merge, not assignment).

---

## 5. Quick self-audit before submitting a story (mirrors Phase-2.5)

- [ ] SP is 3 or 4 (not 5+). Title has ≤1 "and".
- [ ] All §3 mandatory sections present in order (see receipt).
- [ ] `## E2E Slice` contains the verbatim "Wiring closed:" assertion with real {TRIGGER}/{RESULT}.
- [ ] ≥3 ACs; exactly one tagged **(make-or-break)** and binary.
- [ ] `## Files to Modify` present, ≤10 paths.
- [ ] `## Security Invariants` populated (concrete, no `N/A`) **iff** a keyword is triggered.
- [ ] DOD is 8–12 boxes incl. the mandatory **e2e demo** box; no CI-invariant filler.
- [ ] Normative content ≤200 lines; `## Dev Agent Record` empty placeholder present.
- [ ] No `⛔` / `pending sign-off` / `TBD on` markers.
```

