# DF5.3: Audit Chain Extended to Credential, Box, Bundle and Re-Verify Links

**Story Points:** 6
**Sprint:** v5-S3 (observability, audit, and the loop)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §6 item 4 (central
  append-only run/audit log, host-side, surviving box destruction; gate-evidence trace; cost ledger
  with per-run attribution; PR bodies carrying run correlation ids), §6 item 6 (F10), §5.3, §8 step 5
- Decision register: v5 §4 **D8** (mint→cap→use→revoke→verify; central append-only audit log), **D7**
- Derivation decisions: `2026-08-11-v5-story-derivation-decisions.md` **DD-4** + **§4 row 3** (retain
  link recorded VOID), **DD-7** (SwarmClaw is the HTTP home if one is needed), **DD-8**, **DD-9**
- Surviving clauses: R2 §8 — `p1-16-audit-chain-pr.md:29, :30, :31, :32, :36, :39, :51-53, :63`.
  **NET-NEW per R2 §11 items 19 and 21** (the audit-walk CLI, immutable link references) are authored
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
link-worthy event happens — key mint, deliver, revoke, revocation-verify, box create through reap,
bundle verification. `walkAuditChain` resolves ten hops by joining those rows against records
predecessors already write: DF1.4's trace session, DF2.8's ledger, DF2.1's run record, DF3.4's
approval, DF5.1's re-verify record, DF5.2's PR. The spine is host-side only; in-box evidence attaches
as a *claim* and never satisfies a hop (F10), and the memory hop is recorded **VOID** pending step 6.
`bun scripts/qds-audit.ts <ref>` prints the walk. It is an operator-side command by construction:
every store it reads is host-local, so there is no CI job in v5.0 (Trigger Surface).

**"Reconstructable" is defined once, for both halves of this contract:** an operator on the host, given
only a merged PR URL and read access to `.sandbox/` and `refs/sandbox/`, can obtain a ten-hop chain per
contributing runId in which every hop is a typed non-null outcome, every emitted link row's
`evidence_digest` still matches its artefact, and the run satisfies
`reverify.completedAt ≤ approval.decidedAt ≤ pr.createdAt`. No network access beyond the single GitHub PR
read at hop 1; no in-box access; no re-execution of any underlying action. DF5.3 produces this; DF5.4-C9
asserts it field by field.

## E2E Slice

**Demonstrable behavior:** Given a merged PR on branch `qds/qds-20260811-a3f19c` produced by DF5.2,
When the operator runs `bun scripts/qds-audit.ts https://github.com/qds/demo/pull/57`, it resolves
PR→run→issue, run→cost (a µ$ total and the `perRole` map as the ledger actually holds it),
run→credential (four timestamped rows — `mint` (`credentials.ts:244`, carrying the applied
`limitMicroUsd` cap as a **field of the mint row**, since the cap is an argument to mint and not an
event of its own), `deliver` (`:514`), `revoke` (`:595`), `verify-revoked` (`:652`) — each carrying
`key_hash`, never key material), run→box, run→bundle, run→re-verify, run→approval, run→gate evidence, and
run→memory as `{ status: "void", reason: "OQ-4 …" }` — ten hops, zero nulls, exit `0`, under 30 s.

**Wiring closed:** On completion of this story, a PR is walkable back to every host-side record that
authorized it using only code merged by this story plus the durable records its predecessors already
write. No stub, no `TODO: wire later`. DF5.4's gate calls this walker; it does not complete it.

**Dependency edges (predecessors):** DF1.4, DF1.8, **DF1.10**, DF2.1, DF2.3, DF2.5, **DF2.6**, DF2.8,
DF3.4, DF5.1, DF5.2 (R5 §2) — the full set, because this story edits four DF2.x-owned files and
resolves records those stories write. **DF1.10 is a direct edge**: since it merged (2026-09-06) the
trace DB hops 2 and 9 resolve against is written *inside the box* and reaches the host only through
DF2.5's artifacts pull (see Infra Prerequisites). **DF2.6 is a direct edge**: hop 5's box lifecycle
runs through `reap`, whose emitter lives in the reaper. P1.11/P1.12's retain-receipt edge is
**degraded to VOID**, not satisfied (R5 §5.3, DD-4).

*Scope note on the shared files: each edit adds one `recordAuditLink(...)` emit at an existing event
site, **plus one seam field per deps interface** — `recordAuditLink?: (link: AuditLink) => void` on
`CredentialDeps` (`credentials.ts:144`), `HarvestDeps` (`harvest.ts:372`), `TeardownDeps`
(`teardown.ts:94`) and `SweepDeps` (`reaper.ts:140`). The seam, not a direct import, is mandatory:
`src/providers/*` takes no ambient dependencies, and importing `src/audit/*` there would invert the
direction DF4.2 established with `src/providers/viz-guard.ts`. No logic or control flow in those files
changes and no existing field is touched, so there is no double-implementation risk with their owning
stories — but the seam widening IS a signature change to four foreign-owned exported interfaces, and
every production call site and every `tests/providers/` fake is threaded in this story. **An unwired
seam must be loud, not silent: `recordAuditLink` is required (not optional) at the
`provisionAdmittedRun` (`driver.ts:549`), `teardownSandbox` (`teardown.ts:463`) and
`runCredentialLifecycle` (`credentials.ts:685`) composition sites, so a caller that forgets it fails to
typecheck rather than producing a linkless run.* This seam threading, the harvest-boundary hop
semantics (AC6) and the authorizing-record digest coverage are why this story is 6 points, not 4.

## Acceptance Criteria

1. **(make-or-break)** Given a PR produced by DF5.2 for a completed run, When the walker is invoked
   with the PR URL, branch name, or runId, Then all ten hops (Technical Notes) resolve to a **typed,
   non-null hop outcome**: either a resolved record carrying a stable ID, or one of the two
   complete-compatible typed statuses — `{ status: "void", reason }` (hop 10 only) and
   `{ status: "not-applicable", reason }` (AC5). Any other value — `null`, `undefined`, an omitted hop,
   `unlinked` (AC3), `evidence-not-harvested` (AC6), `order-violation` (AC7) or a broken hop (AC2) —
   fails this AC. The returned chain is an object **keyed by contributing runId**,
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
   `unlinked` is a **broken** outcome: it fails the chain and exits non-zero, exactly like an
   unresolvable hop (INV-AUDIT-6). It is typed separately from a generic broken hop only so the
   diagnostic can name the emitter that should have written it. A chain containing any `unlinked` hop
   is never reported complete. **Only `void` (hop 10) and `not-applicable` (AC5) are
   complete-compatible.** *Negative control: an implementation exiting 0 on an `unlinked` hop MUST
   fail this AC.*
4. Given the walk, Then total wall clock is under **30 seconds** with a 3-second per-hop ceiling, and
   a hop exceeding its ceiling fails closed as `hop-timeout` rather than reported resolved
   (`p1-16-audit-chain-pr.md:32`; budget defended in Technical Notes).
5. Given a healthy run where a hop is legitimately absent — a run whose ledger carries no `tokens`
   rows because the DF2.7→ledger bridge is **declared, not wired** (F001, issue #157;
   `cost-ledger.ts:941-949`), so hop 3's `perRole` holds the single literal `"box-hours"` key and
   `hasTokenRows` is `false` — Then the hop resolves with that shape and the chain is complete; a
   `readRunCost` returning `hasEvents: false` (no rows at all) is a **broken** hop, not a zero-spend
   one (`cost-ledger.ts:729-730`). A hop that is genuinely inapplicable resolves to a typed
   `{ status: "not-applicable", reason }`, never a null; a chain resolving only
   `void`/`not-applicable` hops is **broken**, never vacuous. Hop 8 (approval) is
   **never** `not-applicable` for a PR-bearing run: DF5.2's INV-PR-5 means no PR exists without an
   approval, so an absent approval on a run that has a PR is a broken hop, not an inapplicable one.
   *Negative control: an implementation that only passes when `perRole` carries more than one key —
   or that reports `hasEvents: false` as a complete zero-spend hop — MUST fail this AC.*
6. Given a run whose artifacts pull failed (the non-fatal teardown arm, `teardown.ts:279-287`) or whose
   box rebooted before harvest, When the walker resolves hops 2 and 9, Then each resolves to
   `{ status: "evidence-not-harvested", reason, evidencePath }` naming the expected
   `<runsDir>/<runId>-artifacts` path, the chain is reported **incomplete with a named cause and a
   non-zero exit** — never complete, and never as a generic broken hop that reads as a missing link.
   *Negative control: an implementation that reports these two hops identically to a never-emitted link
   MUST fail this AC.*
7. Given a resolved chain, When the walker checks monotonicity, Then within each contributing runId the
   emitted link rows are non-decreasing in `occurred_at` in their lifecycle order — credential
   `mint ≤ deliver ≤ revoke ≤ verify-revoked`, box `create ≤ fill ≤ setup ≤ execute ≤ observe ≤ teardown ≤ reap`,
   bundle `verify ≤ fetch` — and the whole run satisfies
   `reverify.completedAt ≤ approval.decidedAt ≤ pr.createdAt` (the ordering DF5.4-C6/C7 assert, on the same
   host clocks). A violation is a named broken hop `order-violation` with both timestamps and a non-zero
   exit. *Negative control (`tests/audit/chain.test.ts`): a chain whose revoke precedes its mint MUST fail
   this AC; an implementation asserting presence only passes and MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/qds-audit.ts <pr-url\|branch\|runId> [--json]` operator CLI | in-scope | `tests/scripts/qds-audit.test.ts` | an installed `qds` entry point is a separate story — `package.json` declares no `bin` and every operator surface in this repo is `bun scripts/<name>.ts` |
| `recordAuditLink` called from each event's own emitter: DF2.3 `credentials.ts` (`mintRunKey` `:244` / `deliverRunKey` `:514` / `revokeRunKey` `:595` / `verifyRevoked` `:652`), DF2.1 `driver.ts` (`createRun` `:905`, `fillRun` `:935`, `setupRun` `:1066`, `executeRun` `:1076`, `observeRun` `:1086`), DF2.5 `harvest.ts` (bundle verify + fetch) and `teardown.ts` (`teardownSandbox` `:463`), DF2.6 `reaper.ts` (`sweep` `:391`) | in-scope | `tests/audit/link-store.test.ts` | — |
| CI chain verification on merged factory PRs | out-of-scope — the walk asserts against host-only stores (`audit.db`, `cost-ledger.db`, `.sandbox/`) that no GitHub runner has; a CI job could only ever assert a broken chain | — | none in v5.0 — re-enters if the host stores gain a remote query surface (DD-7) |
| `walkAuditChain` invoked as a gate clause | out-of-scope | — | DF5.4 |
| HTTP chain-query surface on the SwarmClaw chassis (DD-7) | out-of-scope | — | DF5.5 |
| Memory retain-receipt hop against a live Hindsight bank | out-of-scope (VOID, DD-4) | — | §8 step 6 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Host-side link store `.sandbox/audit.db` (resolved `QDS_AUDIT_DB ?? .sandbox/audit.db`, dir mode 0700, file 0600 — the `CostLedger` constructor at `cost-ledger.ts:885-921` is the pattern to copy) | `bun:sqlite`, bundled with the project's bun toolchain — no new dependency | schema migrated idempotently (`CREATE TABLE/TRIGGER IF NOT EXISTS`, serialized with `BEGIN IMMEDIATE` + `busy_timeout`) during the first `recordAuditLink` (write-time init) only; the walker opens read-only and **never** migrates — an uninitialized store (zero `recordAuditLink` calls) fails the walk closed with a named broken hop per INV-AUDIT-6; host-side so it survives box destruction (§6 item 4) |
| DF2.8 cost ledger `.sandbox/cost-ledger.db` (`DEFAULT_COST_LEDGER_FILE`, `cost-ledger.ts:448`, overridable by `QDS_COST_LEDGER_FILE`, `:875`) · DF1.4 **harvested** trace DB · DF2.1 run record | host `bun:sqlite` store · `<runsDir>/<runId>-artifacts/…/trace.db` (pulled out of the box by DF2.5's `pullArtifacts`, `harvest.ts:1068`) · `<runsDir>/<runId>.json` via `resolveRunsDir()` (`run-record.ts:1178`) | the cost hop constructs `new CostLedger({ path })` and calls its `readRunCost(runId)` **method** (`cost-ledger.ts:1335`) — DF2.8 exports the class, not a free function — run-keyed, never the issue-scoped `readIssueCost`, so a run dispatched without an issue still resolves hop 3, and never a second SUM. **The constructor is not read-only** (`cost-ledger.ts:885-921`: `mkdirSync` 0700, `chmodSync` 0700, `new Database()` which CREATES the file when absent, `chmodSync` 0600, `PRAGMA journal_mode = WAL`, `db.exec(SCHEMA)`), so the walker asserts `existsSync(ledgerPath)` **before** constructing and resolves hop 3 as a named broken hop when the ledger is absent — it never lets the read path create the store it is auditing. **The trace DB is an artefact of a completed harvest, not a live host store: hops 2 and 9 first resolve `runId → record.requestId` (`run-record.ts:139`), then join the trace DB on `request_id` (`trace/schema.ts:35` `sessions`, `:84-85` `gate_results` — both keyed on `request_id`, not `run_id`).** A run whose artifacts pull failed (`teardown.ts:279-287`, non-fatal by design) or whose box rebooted before harvest (tier-2 placement ADR `:81-82`, measured: `/run` is tmpfs and a reboot wipes it) resolves hops 2 and 9 as `{ status: "evidence-not-harvested", reason, evidencePath }` — a *named, typed* outcome distinct from a broken hop, because the loss is a recorded teardown outcome, not a missing link. The run record is resolvable by runId at walk time, and an unreadable record is a named broken hop, never a skipped one |
| DF5.1 re-verify record · DF3.4 approval record · DF5.2 PR record · GitHub PR body read | host-side artifacts written by those stories; GitHub API with the host-side token | each read read-only by path — the walker asserts presence and identity and never re-runs the underlying action; the token is checked by name only and never reaches a diagnostic or the chain object (INV-AUDIT-2) |

## Technical Notes

- **Hop table (NET-NEW per DD-8).** The source's 8 hops (`p1-16-audit-chain-pr.md:36`) re-aimed and
  extended to ten; hops 4–7 are the v5 links the source story could not know:

  | # | Hop | Join key / evidence | Origin |
  |---|-----|--------------------|--------|
  | 1 | PR → run | branch `qds/{runId}` + runId in PR body | DF5.2 |
  | 2 | run → issue | `(repo_slug, issue_id)` on the **harvested** trace `sessions` row, reached `runId → record.requestId → sessions.request_id` (`trace/schema.ts:34-35`, PK'd on `request_id`); `evidence-not-harvested` per AC6 when the artifacts pull failed | DF1.8 / DF1.4 / DF1.10 |
  | 3 | run → cost | `new CostLedger({path}).readRunCost(runId)` — µ$ total plus the `perRole` map, keyed by run, not issue. **Until the DF2.7→ledger token bridge is wired (F001 / issue #157), the only rows a production run writes are `kind='box_hours'`, so `perRole` legitimately contains the single literal key `"box-hours"` and `hasTokenRows` is `false`** (`cost-ledger.ts:722-723`). The hop reports `perRole` verbatim and additionally surfaces `hasTokenRows`; it never asserts a multi-role split, and it never reads `hasEvents: false` as "spent nothing" (`cost-ledger.ts:729-730`). **The single-key shape is dated, not permanent: DF2.12 wires per-role token attribution at the dispatcher and closes #157**; when it lands, `perRole` carries real roles and `hasTokenRows` is `true`, with no change to this hop's contract — it already reports the map verbatim | DF2.8 |
  | 4 | run → credential | `key_hash`; `mint` / `deliver` / `revoke` / `verify-revoked` events. There is no `cap` event — the cap is an argument to mint, carried as the mint row's `detail_json.limitMicroUsd` | DF2.3 links |
  | 5 | run → box | create→fill→setup→execute→observe (`driver.ts:905,935,1066,1076,1086`) → teardown (`teardown.ts:463`) → reap (`reaper.ts:391`) | DF2.1/DF2.5/DF2.6 links |
  | 6 | run → bundle | the bundle at `<runsDir>/<runId>.bundle` (`harvest.ts:18-19` — its presence IS the record; DF2.1's schema stays closed), this story's own `bundle-verify` link row, and `refs/sandbox/<run-id>` | DF2.5 link |
  | 7 | run → re-verify | host-side test + gate results that authorized the PR | DF5.1 |
  | 8 | run → approval | approver id, decision, `decidedAt` | DF3.4 |
  | 9 | run → gate evidence | **harvested** `gate_results` rows (`trace/schema.ts:84-93`), joined on `request_id`, attached as claims; `evidence-not-harvested` per AC6 when the artifacts pull failed | DF1.4 / DF1.10 |
  | 10 | run → memory | retain receipt — **VOID** | *(step 6)* |

- **Hop 10 is recorded VOID (BINDING — DD-4, register §4 row 3):** `{ hop: "memory-retain-receipt",
  status: "void", reason: "OQ-4 unresolved — Hindsight has never booted on this host (arm64
  libpq/openssl@3; :8888 collides with a local Jupyter); step-6 memory wiring is outside the v5
  horizon" }` — P0.11's convention (`gate-runner.ts:167-178`): recorded for traceability, resolver
  never invoked, excluded from the verdict. A *typed outcome*, never a null, omission or stub probe.
  The string is defined **once** as `export const OQ4_VOID_REASON` in `src/audit/index.ts` and imported
  by `scripts/df5-lights-on-gate.ts`, so DF5.4-V1's `void_reason` is byte-identical by construction
  rather than by claim.
- **Link schema:** `audit_links { link_id PK, run_id, repo_slug, request_id, hop, event, subject_id,
  subject_kind, evidence_path, evidence_digest, detail_json, occurred_at, recorded_at }` — all but
  `subject_*`, `evidence_*`, `detail_json` are `NOT NULL`, and `UNIQUE (run_id, hop, event,
  COALESCE(subject_id, '<none>'))` (via a generated column) makes a redelivered emit a no-op
  on the sentinel, not on distinct NULLs (NULLs are distinct in a SQLite UNIQUE index) (`INSERT … ON CONFLICT DO NOTHING`), never an update.
  `evidence_digest` (SHA-256 of the artifact) makes a link **immutable** (R2 §11 item 21): a
  rewritten artifact stops matching, and the hop reports `evidence-mismatch`.
- **Digest coverage is asymmetric, and this story closes the gap for the authorizing records.** Only hops 4,
  5 and 6 have emitted link rows. Hops 7 (DF5.1 `ReverifyReport`), 8 (DF3.4 `extensions.approval`) and 1
  (DF5.2 `extensions.pr`) are the records that *authorize* the PR and are the highest-value tamper targets,
  so the walker emits a **first-observation digest link** for each on its first successful walk
  (`hop`, `subject_id`, `evidence_digest`, `ON CONFLICT DO NOTHING`) and, on every later walk, compares the
  stored digest and reports `evidence-mismatch` on a difference. This is the one write the walker makes and
  it is append-only into `audit_links` — the store the walker already owns (Guards/limits). It is **not** a
  retroactive lifecycle link and does not violate AC3/INV-AUDIT-4: the recorded event is *"the walker
  observed this artefact at this digest at this time"*, which is true at the moment it is written.
- **The cap has no event site of its own:** `mintRunKey` validates `capMicroUsd` (`credentials.ts:261-278`)
  and passes it straight into `createKey` (`:286`). It is recorded as the mint row's
  `detail_json.limitMicroUsd`. Emitting a separate `cap` row would manufacture a link for an event that
  never occurred — INV-AUDIT-4.
- **Ten hops *per contributing runId*, and why the return shape is a map (DF6.1b reciprocal).** The
  ten hops above are the hop set for **one** run, and `walkAuditChain` returns them keyed by
  contributing runId. This story's walker resolves exactly one key: the parent run it reaches from
  the ref at hop 1 — a PR with no fix attempts has one contributor, so the default is a single-entry
  map, not a bare hop list. **DF6.1b** (fix-loop verdict + attempt budget — DF6.1 was split into
  DF6.1a/DF6.1b on 2026-09-08, and DF5.3 is an edge of **DF6.1b** only) extends `src/audit/chain.ts`
  **additively**: it reads the parent record's `extensions.fixLoop.fixOutcome` — a `string`-kind field
  (`run-record.ts:216`; `ExtensionValue = string | number | string[]`, `:151`) whose JSON payload
  carries the fix run ids — and adds one key per fix runId, each resolving the same ten hops. If
  DF6.1b needs a first-class array it registers a `strings`-kind field in its own story; **this story
  registers nothing.** It adds **no hop**, changes **no** hop definition, join key, evidence rule or
  exported signature, and each fix run emits its own links at this story's event sites — so DF6.1b's
  "adds only" claim and this story's ownership of the hop table are the same statement read from two
  sides. Merge order: DF6.1b lands **after** this story (both v5-S3), so this story is written against
  the single-key case and nothing here waits on DF6.1b.
- **Host-side spine (INV-AUDIT-5):** hops 1–8 resolve only against host-side records; hop 9's in-box
  trace rows attach as `evidence: { kind: "claim" }` — what the PR *asserted*; hop 7 *earned* it.
  In-box evidence is a claim in both halves of this contract. DF5.3 hop 9 attaches it as
  `{ kind: "claim" }`; DF5.4-C3/C4 assert its integrity, never its truth. The truth layer is DF5.1's
  host-side re-verify — DF5.3 hop 7, DF5.4-C6 (ADR `:61-64`).
- **Reciprocity with DF5.4.** DF5.3 owns the ten-hop table and the three emitted link families (hops 4, 5, 6);
  DF5.4-C9 is the **only** clause that reads `audit_links`, so C9 asserts link-row presence for those three
  hops by name, not merely the walker's exit code. DF5.4-C1 (channel) and C3 (team) assert stages with no hop
  here **by design** — the hop table is the walk from a merged PR back through the records that *authorized*
  it, and dispatch/team execution are upstream of authorization. Neither story adds a hop or a clause without
  the other's row changing in the same PR. **The `--json` payload is a two-story wire format, so it has
  one owner: DF5.3 exports `ChainReport` from `src/audit/index.ts` — beside `OQ4_VOID_REASON`, the shared
  export surface this pair already uses — and DF5.4-C9 imports the type rather than parsing shape by
  hand. A second export point would re-create the drift. Neither story changes the shape without the
  other's row changing in the same PR.**
- **The 30-second budget, defended not inherited** (R2 §8): 8 hops became 10, but every added hop
  reads local SQLite or JSON and only hop 1 hits the network — 30 s holds, 3 s per-hop, fail-closed.
- **Guards/limits:** the walker opens the trace DB and every JSON record read-only and writes nothing
  outside `audit_links`; the cost ledger is the one store whose library has **no read-only open path**,
  so its existence is asserted before construction (see Infra Prerequisites).
  Diagnostics cap at 2,000 chars **including** truncation suffix; `detail_json` 8 KiB/row; files `0600`.
- **Deviation/assumption:** DF5.1/DF5.2 are authored concurrently; this story reads their records by
  path and identity only, claiming no field beyond `runId`; a renamed path is fixed in this resolver.

## Observability Contract

- Every walk logs `{ requestId, runId, repoSlug, hop, status, durationMs, outcome }`; every
  `recordAuditLink` logs the same keys plus `{ event, subjectKind }`.
- `requestId` on the run record (`run-record.ts:139`, a core field) is the dispatch correlation id and
  is the walker's runId→trace-session key (the trace `sessions` table is PK'd on `request_id`,
  `trace/schema.ts:34-35`). **On gate and approval EVENT streams the cross-process join key is
  `dispatchRequestId`, NOT `requestId`** — `requestId` there is the emitting context's own id
  (`run-record.ts:285-292`; `approval-gate.ts:1209,1225`; `scripts/fleet.ts:1805,1911`). Hops 8 and 9
  join on `dispatchRequestId`; joining them on `requestId` resolves zero rows on a CLI-dispatched run and
  can resolve a **foreign** run's rows under concurrent dispatch. *A test asserting hop 8/9 resolution
  under two concurrent dispatches from one CLI session is mandatory (see DoD).* Errors include
  `{ code, message, remediation }`, the last being the literal next command.
- Sub-timings: `per_hop_ms` keyed by hop name, plus `pr_fetch_ms`; a hop that did not run reports 0.

## Files to Modify

- `src/audit/link-store.ts`
- `src/audit/chain.ts`
- `src/audit/index.ts`
- `src/providers/credentials.ts`
- `src/providers/driver.ts`
- `src/providers/harvest.ts`
- `src/providers/teardown.ts`
- `src/providers/reaper.ts`
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
- [ ] **Contract:** `bun scripts/qds-audit.ts <ref>` prints per-hop status and exits `0` complete / `1` broken, and
      `--json` emits the whole chain object typed as the exported **`ChainReport`** — the map keyed by
      contributing runId, each hop's typed status and, for hops 4/5/6, the emitted `audit_links` row
      ids. DF5.4-C9 imports `ChainReport` and asserts against it; the exit code alone is not the
      contract.
- [ ] **Integration:** link rows emitted at event time by each event's own emitter — `credentials.ts`
      (`mint`/`deliver`/`revoke`/`verify-revoked`), `driver.ts` (box transitions), `harvest.ts`,
      `teardown.ts`, `reaper.ts` (`reap`) — each through its own `*Deps` seam, required at the three
      composition sites named in the Scope note.
- [ ] **Security:** hop 10 recorded VOID with its reason per DD-4, excluded from the verdict
      (INV-AUDIT-6); a redaction test asserts no key material, token or plaintext reaches any hop,
      diagnostic or log line (INV-AUDIT-2).
- [ ] **Test (unit):** a complete run resolves ten hops per contributing runId with zero nulls — one
      key, the parent run — the memory hop typed `void`, the cost hop reporting a µ$ total and the
      `perRole` map as the ledger actually holds it (`{"box-hours": N}` with `hasTokenRows: false`
      until the F001/#157 bridge is wired).
- [ ] **Test (broken hop):** a PR body with no runId → hop 1 named with expected/actual/diagnostic
      and a non-zero exit; an implementation returning the other nine as "complete" MUST fail.
- [ ] **Test (in-box-evidence negative control):** DF5.1's re-verify record absent but the in-box gate
      results green → hop 7 broken (INV-AUDIT-5); an implementation reading the in-box results as
      authority passes the happy path and MUST fail this test.
- [ ] **Test (immutability + retroactive-link rejection):** `UPDATE`/`DELETE` on a link row aborts;
      a tampered artifact yields `evidence-mismatch`; a run with no links resolves `unlinked`, fails
      the chain and exits non-zero — an implementation exiting 0 on it MUST fail this test (AC3).
- [ ] **Test (cross-run join negative control, `tests/audit/chain.test.ts`):** two runs dispatched from
      one `scripts/fleet.ts` session; hop 8 and hop 9 of each resolve **only** that run's rows. An
      implementation joining on `requestId` resolves the CLI's id for both and MUST fail this test.
- [ ] **Test (authorizing-record tamper, `tests/audit/chain.test.ts`):** a walk records digests for hops
      1, 7 and 8; editing the `ReverifyReport` verdict and re-walking yields `evidence-mismatch` on hop 7
      and a non-zero exit. An implementation digesting only hops 4–6 passes the happy path and MUST fail
      this test.
- [ ] **Test (ordering, `tests/audit/chain.test.ts`):** a chain whose `revoke` row precedes its `mint`
      row, and a run whose `approval.decidedAt` precedes its `reverify.completedAt`, each yield
      `order-violation` and a non-zero exit (AC7).
- [ ] **Test (e2e demo — MANDATORY):** walk a real merged factory PR and capture the printed chain as
      an artifact — ten hops, the VOID memory hop with its OQ-4 reason, a µ$ cost total, under 30 s.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
