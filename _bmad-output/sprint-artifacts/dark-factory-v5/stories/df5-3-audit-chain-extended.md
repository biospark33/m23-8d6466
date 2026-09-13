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
`reverify.completedAt < approval.decidedAt < pr.createdAt` (strict — equality is a violation). No network access beyond the single GitHub PR
read at hop 1 **when the ref is a PR URL or branch; invoked with a runId — the form DF5.4-C9 uses against the frozen fixture — hop 1 resolves locally from the run record's `extensions.pr` (the same entry hop 1 digests) and the walk performs no network access at all**; no in-box access; no re-execution of any underlying action. DF5.3 produces this; DF5.4-C9
asserts it field by field.

## E2E Slice

**Demonstrable behavior:** Given a merged PR on branch `qds/qds-20260811-a3f19c` produced by DF5.2,
When the operator runs `bun scripts/qds-audit.ts https://github.com/qds/demo/pull/57`, it resolves
PR→run→issue, run→cost (a µ$ total and the `perRole` map as the ledger actually holds it),
run→credential (four timestamped rows — `mint` (`mintRunKey`, carrying the applied
`limitMicroUsd` cap as a **field of the mint row**, since the cap is an argument to mint and not an
event of its own), `deliver` (`deliverRunKey`), `revoke` (`revokeRunKey`), `verify-revoked` (`verifyRevoked`) — each carrying
`key_hash`, never key material), run→box, run→bundle, run→re-verify, run→approval, run→gate evidence, and
run→memory as `{ status: "void", reason: "OQ-4 …" }` — ten hops, zero nulls, exit `0`, under 30 s.

**Wiring closed:** On completion of this story, a PR is walkable back to every host-side record that
authorized it using only code merged by this story plus the durable records its predecessors already
write. No stub, no `TODO: wire later`. DF5.4's gate calls this walker; it does not complete it.

**Dependency edges (predecessors):** DF1.4, DF1.8, **DF1.10**, DF2.1, DF2.3, DF2.5, **DF2.6**, DF2.8,
**DF2.11**, DF3.4, DF5.1, DF5.2 (R5 §2) — the full set, because this story edits four DF2.x-owned files and
resolves records those stories write. **DF1.10 is a direct edge**: since it merged (2026-09-06) the
trace DB hops 2 and 9 resolve against is written *inside the box* and reaches the host only through
DF2.5's artifacts pull (see Infra Prerequisites). **DF2.6 is a direct edge**: hop 5's box lifecycle
runs through `reap`, whose emitter lives in the reaper. **DF2.11** supplies
`CostLedger.openReadOnly()`, which hop 3 needs to read the ledger without creating it. P1.11/P1.12's retain-receipt edge is
**degraded to VOID**, not satisfied (R5 §5.3, DD-4).

*Scope note on the shared files: each edit adds one `recordAuditLink(...)` emit at an existing event
site, **plus one seam field per deps interface** — `recordAuditLink?: (link: AuditLink) => void` on
`CredentialDeps` (`credentials.ts`), `HarvestDeps` (`harvest.ts`), `TeardownDeps`
(`teardown.ts`) and `SweepDeps` (`reaper.ts`). The seam, not a direct import, is mandatory:
`src/providers/*` takes no ambient dependencies, and importing `src/audit/*` there would invert the
direction DF4.2 established with `src/providers/viz-guard.ts`. No logic or control flow in those files
changes and no existing field is touched, so there is no double-implementation risk with their owning
stories — but the seam widening IS a signature change to four foreign-owned exported interfaces, and
every production call site and every `tests/providers/` fake is threaded in this story. **An unwired
seam must be loud, not silent: `recordAuditLink` is required (not optional) at the
`provisionAdmittedRun`, `teardownSandbox`, `runCredentialLifecycle` **and `harvestRun`** composition
sites — `harvestRun` is its own composition surface, not one `TeardownDeps` happens to supply: its
bundle-verify and bundle-fetch emits live on `HarvestDeps`, and it is called from
`scripts/fleet.ts` and `scripts/sandbox-teardown.ts` today (DF3.7 adds a fourth caller on the
production path), none of which flows through `TeardownDeps` — so a caller that forgets the seam
fails to typecheck rather than producing a run whose hop 6 is `unlinked` and whose lights-on gate is
red forever.*** The `driver.ts` threading is smaller than it first
looks — only `provisionAdmittedRun` and `fillRun` are live sites — but `src/fleet/dispatch.ts` gains
the `setup-gate` emit, which is new work in a file this story did not originally touch. That
threading, the harvest-call-site threading in `scripts/fleet.ts`/`scripts/sandbox-teardown.ts`, the
harvest-boundary hop semantics (AC6), the temp-dir WAL recovery and the
authorizing-record digest coverage are why this story is 6 points, not 4.

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
   one (`hasTokenRows`, on `readRunCost`'s return shape in `cost-ledger.ts`). A hop that is genuinely inapplicable resolves to a typed
   `{ status: "not-applicable", reason }`, never a null. **The box-lifecycle `reap` event is the
   canonical `not-applicable` case:** the reaper "reaps what nobody owns" (`src/providers/reaper.ts`
   module header), and a run torn down
   through `teardownSandbox` leaves no VM, no key and a closed record, so no `RowClass`
   (`paired`, `leaked-vm`, `leaked-key`, `stale-record`, `paired-pending`,
   `key-age-unavailable`, `foreign`) ever selects it and `sweep` never touches it. Hop 5 therefore
   resolves `reap` as `{ status: "not-applicable", reason: "record closed through teardownSandbox; the
   reaper collects only unowned units (the RowClass union)" }` when the record carries `closedAt` and no
   live VM, and as an emitted link only on the orphan path. *Negative control: an implementation that
   reports `unlinked` for `reap` on a cleanly torn-down run MUST fail this AC.* A chain resolving only
   `void`/`not-applicable` hops is **broken**, never vacuous. Hop 8 (approval) is
   **never** `not-applicable` for a PR-bearing run: DF5.2's INV-PR-5 means no PR exists without an
   approval, so an absent approval on a run that has a PR is a broken hop, not an inapplicable one.
   *Negative control: an implementation that only passes when `perRole` carries more than one key —
   or that reports `hasEvents: false` as a complete zero-spend hop — MUST fail this AC.*
6. Given a run whose artifacts pull failed (the non-fatal teardown arm, `teardown.ts`) or whose
   box rebooted before harvest — or, for hop 6, whose bundle is absent at walk time for one of the
   **reachable** causes: deleted after a lawful harvest (the operator disk-cleanup case), or a
   `noHarvest` teardown (`teardownSandbox`'s pause-path option, a live production call from
   `approval-gate.ts`) with no earlier `harvestRun` — When the walker resolves
   hops 2, 6 and 9, Then each resolves to
   `{ status: "evidence-not-harvested", reason, evidencePath }` naming the expected path —
   `<runsDir>/<runId>-artifacts` for hops 2 and 9, `<runsDir>/<runId>.bundle` for hop 6, which
   `harvestRun`'s `verify` and `fetch` steps produce, a different mechanism from `pullArtifacts` — the chain is reported **incomplete with a named cause and a
   non-zero exit** — never complete, and never as a generic broken hop that reads as a missing link.
   One cause is structurally unreachable and the story says so rather than speccing it: an
   **in-flight** bundle verify/fetch failure aborts teardown before revoke/destroy (`runBoxStep`'s
   own contract: every harvest failure except artifacts aborts), so it cannot produce a walkable PR —
   the reachable losses are the two above. (Wave 6 caught the earlier text leaning on a `fetchBundle`
   symbol that exists nowhere in the tree, with the independence claim running the wrong way.)
   *Negative control: an implementation that reports these two hops identically to a never-emitted link
   MUST fail this AC.*
7. Given a resolved chain, When the walker checks monotonicity, Then within each contributing runId the
   emitted link rows are non-decreasing in `occurred_at` in their lifecycle order — credential
   `mint ≤ deliver ≤ revoke ≤ verify-revoked`, box `create ≤ fill ≤ setup-gate ≤ teardown` (plus
   `≤ reap` only when a `reap` link exists at all — see AC5), bundle `verify ≤ fetch`. Those are
   non-decreasing (`≤`): two link rows may legitimately share a millisecond stamp. **The
   authorization chain is strict:** the run satisfies
   `reverify.completedAt < approval.decidedAt < pr.createdAt` — the ordering DF5.4-C6/C7 assert, on the
   same host clocks, and equality is a violation, because an ordering that cannot distinguish the
   re-verify from the decision has not demonstrated the decision followed the evidence. **This
   strictness is a deliberate strengthening over shipped code, recorded as such:** `push.ts`'s
   enforcement on the same boundary is non-strict (`decided < completed` refuses; equality passes and
   the PR opens), so a millisecond-equal pair is a red gate on a PR DF5.2 lawfully admitted — the
   remedy is to tighten `push.ts`, never to loosen this chain's comparison. A violation is a
   named broken hop `order-violation` with both timestamps and a non-zero exit. *Negative control (`tests/audit/chain.test.ts`): a chain whose revoke precedes its mint MUST fail
   this AC; an implementation asserting presence only passes and MUST fail.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/qds-audit.ts <pr-url\|branch\|runId> [--json] [--runs-dir <dir>] [--audit-db <path>] [--ledger <path>] [--reverify-dir <dir>]` operator CLI — the four path seams are part of this story's surface, because DF5.4-C9 invokes the walker against a frozen fixture copy and hop 7's `.sandbox/reverify/` has no environment seam to inherit (`src/reverify/runner.ts` resolves it from `hostRoot`/cwd only); a walker whose stores cannot be redirected cannot be pointed at a fixture without reading the developer's real `.sandbox/` | in-scope | `tests/scripts/qds-audit.test.ts` | an installed `qds` entry point is a separate story — `package.json` declares no `bin` and every operator surface in this repo is `bun scripts/<name>.ts` |
| `recordAuditLink` called from each event's own emitter: DF2.3 `credentials.ts` (`mintRunKey` / `deliverRunKey` / `revokeRunKey` / `verifyRevoked`), DF2.1 `driver.ts` (`provisionAdmittedRun` = `create`, `fillRun` = `fill`) and DF3.1 `src/fleet/dispatch.ts` (`setup-gate`), DF2.5 `harvest.ts` (bundle verify + fetch, on `HarvestDeps`) and `teardown.ts` (`teardownSandbox`), DF2.6 `reaper.ts` (`sweep`, orphan path only) | in-scope | `tests/audit/link-store.test.ts` | — |
| CI chain verification on merged factory PRs | out-of-scope — the walk asserts against host-only stores (`audit.db`, `cost-ledger.db`, `.sandbox/`) that no GitHub runner has; a CI job could only ever assert a broken chain | — | none in v5.0 — re-enters if the host stores gain a remote query surface (DD-7) |
| `walkAuditChain` invoked as a gate clause | out-of-scope | — | DF5.4 |
| HTTP chain-query surface on the SwarmClaw chassis (DD-7) | out-of-scope | — | DF5.5 |
| Memory retain-receipt hop against a live Hindsight bank | out-of-scope (VOID, DD-4) | — | §8 step 6 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Host-side link store `.sandbox/audit.db` (resolved `QDS_AUDIT_DB ?? .sandbox/audit.db`, dir mode 0700, file 0600 — the `CostLedger` constructor's side-effect list is the pattern to copy, **except its `PRAGMA journal_mode = WAL`: this store stays on SQLite's default `DELETE` journal**, so it leaves no `-wal`/`-shm` siblings and DF5.4's "the gate wrote nothing but its report and these rows" file-set assertion can be **exact** rather than carrying a transient-sidecar exception list — an exception on a byte-identical assertion is where a real difference hides. `audit_links` is append-only, low-volume and read once per walk, so it has no throughput reason to want WAL, and DF2.11's "**Named ceiling — a read-only open of a WAL database**" bullet records the other half of the cost: a WAL database cannot be opened read-only without writing a `-shm`. **And the opener copies DF2.11's no-create discipline, because `bun:sqlite`'s `new Database(path)` creates the file when absent — the identical defect DF2.11 chartered against, one store over:** the walker's read-write open is preceded by a no-create `openSync(path, "r")` probe that throws a typed `audit-store-absent` while holding the fd, the held fd's `fstatSync(fd).ino` is re-checked against the probed inode to throw `audit-store-identity-changed` on a replace-and-restore across the open window, and only then does `new Database(path, {})` open the store that provably already existed) | `bun:sqlite`, bundled with the project's bun toolchain — no new dependency | schema migrated idempotently (`CREATE TABLE/TRIGGER IF NOT EXISTS`, serialized with `BEGIN IMMEDIATE` + `busy_timeout`) during the first `recordAuditLink` (write-time init) only; the walker opens read-**write** — it appends first-observation digest rows, see Technical Notes — but **never** migrates and **never creates**: it asserts the schema is present and fails the walk closed with a named broken hop per INV-AUDIT-6, and the no-create opener means an uninitialized store (zero `recordAuditLink` calls) is a typed `audit-store-absent` refusal, never a zero-byte file the read path materialised; host-side so it survives box destruction (§6 item 4) |
| DF2.8 cost ledger `.sandbox/cost-ledger.db` (`DEFAULT_COST_LEDGER_FILE`, `cost-ledger.ts:448`, overridable by `QDS_COST_LEDGER_FILE`, `:875`) · DF1.4 **harvested** trace DB · DF2.1 run record | host `bun:sqlite` store · `<runsDir>/<runId>-artifacts/trace/trace.db` (pulled out of the box by DF2.5's `pullArtifacts`, `harvest.ts:1068`; the `trace/` prefix is load-bearing — see Technical Notes) · `<runsDir>/<runId>.json` via `resolveRunsDir()` (`src/providers/run-record.ts:1178`) | the cost hop constructs `new CostLedger({ path })` and calls its `readRunCost(runId)` **method** (`cost-ledger.ts:1335`) — DF2.8 exports the class, not a free function — run-keyed, never the issue-scoped `readIssueCost` — the hop is about *this run's* spend, not the issue's, and it never re-SUMs. **This buys no tolerance of an issue-less run:** `extensions.budget` is written only when the dispatch carries an issue ref (`src/providers/driver.ts:572`; `src/providers/run-record.ts:220-221`), and `ingestBoxHoursIfAttributed` writes no box-hours row without a string `repoSlug`/`issueId` (`teardown.ts:488-494`), so an issue-less run has zero ledger rows, `hasEvents` is `false`, and AC5 makes hop 3 a **broken** hop. That is intended and matches DF5.4-C1: a run nothing admitted is a run nothing capped, and it is not a run this chain can vouch for. **The ordinary constructor is not read-only** (`cost-ledger.ts:885-921`: `mkdirSync` 0700, `chmodSync` 0700, `new Database()` which CREATES the file when absent, `chmodSync` 0600, `PRAGMA journal_mode = WAL`, `db.exec(SCHEMA)`), so the walker opens through **DF2.11's `CostLedger.openReadOnly({ path })`** and never lets the read path create the store it is auditing. Not an `existsSync` pre-check: DF2.11 specifies a **no-create `openSync(path, "r")`** that throws `ledger-absent`, holding the fd open and comparing `fstatSync(fd).ino` against the probed inode to throw `ledger-identity-changed` on a replace-and-restore (DF2.11's "**`openReadOnly` is a static factory on the same class**" bullet). Hop 3 resolves as a named broken hop on either code, and on DF2.11's typed hot-WAL refusal `ledger-wal-recovery-required` (DF2.11's "**Named ceiling — a read-only open of a WAL database**" bullet — SQLite cannot open a WAL database read-only without writing a `-shm`). **The trace DB is an artefact of a completed harvest, not a live host store: hops 2 and 9 first resolve `runId → record.requestId` (`src/providers/run-record.ts:139`), then join the trace DB on `request_id` (`trace/schema.ts:35` `sessions`, `:86` `gate_results.request_id` — the store is keyed on `request_id` throughout, never on `run_id`).** A run whose artifacts pull failed (`teardown.ts:279-287`, non-fatal by design) or whose box rebooted before harvest (tier-2 placement ADR `:81-82`, measured: `/run` is tmpfs and a reboot wipes it) resolves hops 2 and 9 as `{ status: "evidence-not-harvested", reason, evidencePath }` — a *named, typed* outcome distinct from a broken hop, because the loss is a recorded teardown outcome, not a missing link. The run record is resolvable by runId at walk time, and an unreadable record is a named broken hop, never a skipped one |
| DF5.1 re-verify record · DF3.4 approval record · DF5.2 PR record · GitHub PR body read | host-side artifacts written by those stories; GitHub API with the host-side token | each read read-only by path — the walker asserts presence and identity and never re-runs the underlying action; the token is checked by name only and never reaches a diagnostic or the chain object (INV-AUDIT-2) |

## Technical Notes

- **Hop table (NET-NEW per DD-8).** The source's 8 hops (`p1-16-audit-chain-pr.md:36`) re-aimed and
  extended to ten; hops 4–7 are the v5 links the source story could not know:

  | # | Hop | Join key / evidence | Origin |
  |---|-----|--------------------|--------|
  | 1 | PR → run | branch `qds/{runId}` + runId in PR body | DF5.2 |
  | 2 | run → issue | `(repo_slug, issue_id)` on the **harvested** trace `sessions` row, reached `runId → record.requestId → sessions.request_id` (`src/phase-engine/trace/schema.ts` — `sessions` PK'd on `request_id` — **plus the `ALTER TABLE` additions in `src/phase-engine/trace/migrations.ts`, which is where the two join columns come from**: `sessions.repo_slug TEXT` and `sessions.issue_id INTEGER`, both nullable — DF1.8's own comment: "a bare DF1.4 run carries NULL `repo_slug`"). The coercion rule is stated once: `String(sessions.issue_id)` compared against the canonicalised record value, because the column is INTEGER while `extensions.budget.issueId` is a registered `"string"` — an uncoerced `42 === "42"` reports a broken correlation on a healthy run. A NULL correlation on a walk reached by runId resolves `{ status: "not-applicable", reason: "bare run carries no issue correlation (DF1.8 nullability)" }`; on the PR-rooted walk this cannot arise, because admission required the issue ref; `evidence-not-harvested` per AC6 when the artifacts pull failed | DF1.8 / DF1.4 / DF1.10 |
  | 3 | run → cost | `CostLedger.openReadOnly({path}).readRunCost(runId)` (DF2.11) — µ$ total plus the `perRole` map, keyed by run, not issue. **Until the DF2.7→ledger token bridge is wired (F001 / issue #157), the only rows a production run writes are `kind='box_hours'`, so `perRole` legitimately contains the single literal key `"box-hours"` and `hasTokenRows` is `false`** (`cost-ledger.ts:722-723`). The hop reports `perRole` verbatim and additionally surfaces `hasTokenRows`; it never asserts a multi-role split, and it never reads `hasEvents: false` as "spent nothing" (`cost-ledger.ts:729-730`). **The single-key shape is dated, not permanent: DF2.12 wires per-role token attribution at the dispatcher and closes #157**; when it lands, `perRole` carries real roles and `hasTokenRows` is `true`, with no change to this hop's contract — it already reports the map verbatim | DF2.8 |
  | 4 | run → credential | `key_hash`; `mint` / `deliver` / `revoke` / `verify-revoked` events. There is no `cap` event — the cap is an argument to mint, carried as the mint row's `detail_json.limitMicroUsd` | DF2.3 links |
  | 5 | run → box | `create` (`provisionAdmittedRun`, `src/providers/driver.ts:549` — the site `src/fleet/dispatch.ts:2683` actually calls; `createRun` `:905` is exercised only by `scripts/cap-hit-demo.ts:518`) → `fill` (`fillRun`, `src/providers/driver.ts:935`, called at `dispatch.ts:2986`) → `setup-gate` (DF3.1's setup gate at `dispatch.ts:3023` — **not** `setupRun`, `src/providers/driver.ts:1066`, which has zero callers repo-wide) → `teardown` (`teardown.ts:463`) → `reap` (`reaper.ts:391`, **`not-applicable` on the ordinary path — see AC5**). `execute` and `observe` are **not** host-side events post-DF1.10: the engine runs in-box under the systemd unit (ADR consequence 2) and its output leaves through DF2.5's tar, so `executeRun`/`observeRun` (`src/providers/driver.ts:1076,:1086`, demo-only and zero-caller respectively) are not emit sites and no link is manufactured for them (INV-AUDIT-4) | DF2.1/DF2.5/DF2.6 links |
  | 6 | run → bundle | the bundle at `<runsDir>/<runId>.bundle` (`harvest.ts:18-19` — its presence IS the record; DF2.1's schema stays closed), this story's own `bundle-verify` link row, and `refs/sandbox/<run-id>`; a bundle-fetch failure resolves `evidence-not-harvested` naming `<runsDir>/<runId>.bundle` per AC6, never `unlinked` — a harvest loss is not a missing link | DF2.5 link |
  | 7 | run → re-verify | the **bound** `ReverifyReport` — the one whose `reverifyId` equals `extensions.approval.reportId` (`extensions.approval`'s shape in `src/providers/run-record.ts`), selected from the append-only `.sandbox/reverify/<runId>.jsonl` (`src/reverify/report.ts`, which legitimately holds several: `appendReport` is called at each `runner.ts` verdict site). Its host-side test + gate results are what authorized the PR. Never the last line — and the divergence from `report.ts`'s own module header (which names the last line authoritative *for DF5.2*) is deliberate and stated: a superseded report or a red final report breaks last-line selection, so the audit chain selects the bound report instead; a report listed in `extensions.approval.supersededReportIds` is never the subject, and a `reportId` resolving to no line is a named broken hop citing both the id and the path | DF5.1 |
  | 8 | run → approval | approver id, decision, `decidedAt` | DF3.4 |
  | 9 | run → gate evidence | **harvested** `gate_results` rows (`src/phase-engine/trace/schema.ts`, the `gate_results` table), joined on `request_id`, attached as claims; `evidence-not-harvested` per AC6 when the artifacts pull failed | DF1.4 / DF1.10 |
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
  `evidence_digest` makes a link **immutable** (R2 §11 item 21): a rewritten subject stops matching and
  the hop reports `evidence-mismatch`. It is the SHA-256 of the **canonicalised subject record, never of
  the containing file**, because every containing file here is mutable by design: hops 1 and 8 live
  inside one `<runsDir>/<runId>.json` that teardown (`closedAt`), `captureSpend` (`spendMicroUsd`,
  `credentials.ts`) and DF5.2 all write after the fact, and hop 7 is one line of an append-only
  `.sandbox/reverify/<runId>.jsonl` that `appendReport` (`src/reverify/report.ts:317`, called at
  `src/reverify/runner.ts:290,418,469,481`) extends on every re-verify. The digested subject is therefore: hop 1 →
  the `extensions.pr` entry alone; hop 7 → the single `ReverifyReport` object identified by
  `subject_id = reverifyId`; hop 8 → the `extensions.approval` entry alone; hops 4/5/6 → the emitted
  link's own `detail_json`. Canonicalisation is `JSON.stringify` over recursively key-sorted values, so
  key order cannot forge a mismatch. Digesting a whole file would make a lawful `closedAt` write or a
  lawful second re-verify report an `evidence-mismatch` that INV-AUDIT-4's triggers make
  uncorrectable. `evidence_path` still names the containing file for the operator; `subject_id` names
  the record inside it.
- **The harvested trace DB may carry a hot WAL and has no shm — read it through a copy, never in
  place.** `harvest.ts:184-212` ships `trace/trace.db` **and** `trace/trace.db-wal`
  (`BOX_RUN_SOURCES`, `:215-216`), deliberately omitting `trace.db-shm`, because the completion marker
  does not imply a checkpoint and `tracer.close()`'s `PRAGMA wal_checkpoint(TRUNCATE)` is guarded; the
  in-box best-effort checkpoint at `harvest.ts:631-639` is explicitly allowed to fail. A read-only open
  cannot rebuild the shm, so it either refuses or silently reads the pre-WAL snapshot — the snapshot
  missing exactly the rows describing how the run ended, which is what hops 2 and 9 exist to read. A
  read-write open in place creates `trace.db-shm` inside the artifacts directory, which the reader has
  no business writing to. **Therefore: copy `trace.db` and, if present, `trace.db-wal` into a private
  temp dir (`mkdtempSync`, 0700, removed in a `finally`), open the copy read-write so SQLite recovers
  the WAL, read, then discard the whole temp dir.** The artifacts directory is never written and the
  recovered rows are complete. *A reader that opens `<runsDir>/<runId>-artifacts/trace/trace.db`
  directly — read-only or otherwise — MUST fail its test, with one fixture carrying a non-empty `-wal`
  and no `-shm` and a `gate_results` row reachable only through it.*
  **The `trace/` prefix is load-bearing:** the same tar also carries the checkout's own `trace.db` at
  the artifacts root (`BOX_WORKDIR_SOURCES`, `harvest.ts:245`), which holds no `gate_results` table.
  `harvest.ts:174-182` names this collision as the express reason the prefix is not flattened. *A
  resolver that globs for `trace.db` rather than resolving `trace/trace.db` MUST fail its test, with a
  fixture containing both.*
- **Digest coverage is asymmetric, and this story closes the gap for the authorizing records.** Only hops 4,
  5 and 6 have emitted link rows. Hops 7 (DF5.1 `ReverifyReport`), 8 (DF3.4 `extensions.approval`) and 1
  (DF5.2 `extensions.pr`) are the records that *authorize* the PR and are the highest-value tamper targets,
  so the walker emits a **first-observation digest link** for each on its first successful walk
  (`hop`, `subject_id`, `evidence_digest`, `ON CONFLICT DO NOTHING`) and, on every later walk, compares the
  stored digest and reports `evidence-mismatch` on a difference. This is the one write the walker makes and
  it is append-only into `audit_links` — the store the walker already owns (Guards/limits). It is **not** a
  retroactive lifecycle link and does not violate AC3/INV-AUDIT-4: the recorded event is *"the walker
  observed this artefact at this digest at this time"*, which is true at the moment it is written.
  **This write is what makes DF5.4's gate non-read-only, and DF5.4's INV-GATE-1 names it explicitly
  rather than being quietly false.** The digest link is append-only into `audit_links` only — never into
  any store the chain asserts about — and its first observation establishes a **baseline** rather than
  detecting a prior tamper. C9's `evidence-mismatch` assertion is therefore a **second-and-later**-walk
  guarantee, which is why DF5.4's tamper test walks twice.
- **The cap has no event site of its own:** `mintRunKey` validates `capMicroUsd` (`credentials.ts`)
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
  (`src/providers/run-record.ts:216`; `ExtensionValue = string | number | string[]`, `:151`) whose JSON payload
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
- **Guards/limits:** the walker reads the trace DB through the temp-dir copy above and never touches
  the artifacts directory; every JSON record is opened read-only; the only store it writes is
  `audit_links`, append-only. The cost ledger is opened through **`CostLedger.openReadOnly({ path })`**
  and its three typed refusals — `ledger-absent` (the no-create probe), `ledger-identity-changed`
  (the held-fd inode mismatch) and `ledger-wal-recovery-required` (the hot-WAL ceiling) — are hop 3's
  named broken-hop causes; a bare `existsSync` pre-check plus the writing constructor is exactly the
  check-then-open race DF2.11's negative control exists to fail (see Infra Prerequisites).
  Diagnostics cap at 2,000 chars **including** truncation suffix; `detail_json` 8 KiB/row; files `0600`.
- **Deviation/assumption:** DF5.1/DF5.2 are authored concurrently; this story reads their records by
  path and identity only, claiming no field beyond `runId`; a renamed path is fixed in this resolver.
- **Nothing is deferred out of this story.** Every review finding raised against it through wave 5c is
  resolved in the text above.

## Observability Contract

- Every walk logs `{ requestId, runId, repoSlug, hop, status, durationMs, outcome }`; every
  `recordAuditLink` logs the same keys plus `{ event, subjectKind }`.
- `requestId` on the run record (`src/providers/run-record.ts:139`, a core field) is the dispatch correlation id and
  is the walker's runId→trace-session key (the trace `sessions` table is PK'd on `request_id`,
  `trace/schema.ts:34-35`).
- **Hops 8 and 9 read stores, not streams, and both are per-run.** Hop 8 reads `extensions.approval`
  (`src/providers/run-record.ts:299-315`) out of the run's own `<runsDir>/<runId>.json` — a lookup by runId with no
  join. Hop 9 reads the **harvested, per-run** trace DB and joins `gate_results.request_id`
  (`trace/schema.ts:86`) to `record.requestId`, which DF1.10 guarantees is the same value: the dispatch
  `requestId` reaches the in-box engine through the unit environment and is stamped on every trace row.
  Cross-run contamination is impossible because each run's trace DB is created at `/run/trace/trace.db`
  (`tracer.ts:369`) and harvested into that run's own `<runsDir>/<runId>-artifacts/`
  (`harvest.ts:1068`).
  **`dispatchRequestId` is a LOG key, not a column, and the walker never uses it.** It exists only on
  `fleet`'s gate-event and `approval-gate`'s pause LOG lines (`approval-gate.ts:1209,1225`;
  `scripts/fleet.ts:1805,1911`), where it disambiguates the emitting context's `requestId` from the
  run's (`src/providers/run-record.ts:285-292`). No store the walker opens has such a column; an implementation that
  looks for one resolves zero rows.
- Errors include `{ code, message, remediation }`, the last being the literal next command.
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
- `src/fleet/dispatch.ts` (the `setup-gate` emit — a composition root importing `recordAuditLink` directly)
- `scripts/fleet.ts` and `scripts/sandbox-teardown.ts` (threading the now-required `HarvestDeps.recordAuditLink` at their existing `harvestRun` call sites — see the Scope note)
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
- **INV-AUDIT-3 (cost granularity, µ$ per DD-9):** this is a **ceiling, not a capability claim** — the
  cost hop reports aggregated micro-dollar totals and the `perRole` map at whatever granularity the
  ledger holds (today a single `"box-hours"` key; real roles once DF2.12 lands), and **never** raw
  per-token billing detail that could leak pricing tiers.
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
      (`mint`/`deliver`/`revoke`/`verify-revoked`), `driver.ts` (`provisionAdmittedRun` =
      `create`, `fillRun` = `fill`), `src/fleet/dispatch.ts` (`setup-gate`), `harvest.ts`
      (bundle verify + fetch), `teardown.ts` (`teardownSandbox`) and `reaper.ts` (`reap`, orphan
      path only) — each through its own `*Deps` seam, required at the four composition sites named in
      the Scope note, **except `src/fleet/dispatch.ts`, which is a composition root and imports
      `recordAuditLink` directly**. No emit at `createRun`/`setupRun`/`executeRun`/`observeRun`: they are demo-only or
      zero-caller, and `execute`/`observe` are in-box post-DF1.10.
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
- [ ] **Test (per-run isolation, `tests/audit/chain.test.ts`):** two runs whose artifacts dirs sit side
      by side under one `<runsDir>`; hop 9 of each resolves **only** the `gate_results` rows in its own
      `<runId>-artifacts/trace/trace.db`, and hop 8 of each reads only its own record's
      `extensions.approval`. An implementation that globs `<runsDir>/*-artifacts/**/trace.db`, or
      resolves the approval by `requestId` rather than by runId, MUST fail this test.
- [ ] **Test (hot-WAL recovery, `tests/audit/chain.test.ts`):** a fixture artifacts dir carrying a
      non-empty `trace.db-wal`, no `-shm`, and a `gate_results` row reachable only through the WAL; hop 9
      resolves that row and the artifacts directory is byte-identical afterwards. An implementation
      opening the artifacts copy in place — read-only or read-write — MUST fail this test.
- [ ] **Test (the walker never creates the store it audits):** a walk against a host whose
      `.sandbox/audit.db` is **absent** refuses `audit-store-absent` and leaves the file absent
      afterwards — checked by asserting the path still does not exist, not by inspecting logs. An
      implementation whose read-write open materialises a zero-byte `audit.db` before any schema
      assertion MUST fail this test; so must one whose DoD fixture always ships an `audit.db`, hiding
      the create branch from the harness (the fixture carries no `audit.db` precisely so the branch
      runs).
- [ ] **Test (authorizing-record tamper, `tests/audit/chain.test.ts`):** a walk records digests for hops
      1, 7 and 8; editing the **bound** `ReverifyReport`'s `verdict` **in place** and re-walking yields
      `evidence-mismatch` on hop 7 and a non-zero exit, while **appending a lawful second report does
      not**, and neither does a lawful `closedAt`/`spendMicroUsd` write to the run record. An
      implementation digesting the whole `.jsonl` or the whole `<runId>.json` passes the first case and
      MUST fail the second and third.
- [ ] **Test (ordering, `tests/audit/chain.test.ts`):** a chain whose `revoke` row precedes its `mint`
      row, and a run whose `approval.decidedAt` precedes its `reverify.completedAt`, each yield
      `order-violation` and a non-zero exit (AC7).
- [ ] **Test (e2e demo — MANDATORY):** walk a real merged factory PR and capture the printed chain as
      an artifact — ten hops, the VOID memory hop with its OQ-4 reason, a µ$ cost total, under 30 s.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
