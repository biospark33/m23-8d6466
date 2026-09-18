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
only a merged PR URL and read access to `.sandbox/` (and, for corroboration only, `refs/sandbox/` — no hop's verdict depends on resolving a ref), can obtain a ten-hop chain per
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
site, **plus one seam field per deps interface** — `recordAuditLink: (link: AuditLink) => void` — a
**required** field on `CredentialDeps` (`credentials.ts`), `HarvestDeps` (`harvest.ts`),
`TeardownDeps` (`teardown.ts`) and `SweepDeps` (`reaper.ts`), and `provisionAdmittedRun`,
`teardownSandbox`, `runCredentialLifecycle` and `harvestRun` accept (or narrow to) those interfaces
as declared, so a construction missing the field fails **at compile time**, at every caller, not at
run time for the first unthreaded one. The seam, not a direct import, is mandatory:
`src/providers/*` takes no ambient dependencies, and importing `src/audit/*` there would invert the
direction DF4.2 established with `src/providers/viz-guard.ts`. No logic or control flow in those files
changes and no existing field is touched, so there is no double-implementation risk with their owning
stories — but the seam widening IS a signature change to four foreign-owned exported interfaces, and
every production call site and every `tests/providers/` fake is threaded in this story. **An unwired
seam must be loud, not silent: `recordAuditLink` is required (not optional) at the
`provisionAdmittedRun`, `teardownSandbox`, `runCredentialLifecycle` **and `harvestRun`** composition
sites — `harvestRun` is its own composition surface, not one `TeardownDeps` happens to supply: its
bundle-verify and bundle-fetch emits live on `HarvestDeps`, and it is called from three sites today — `scripts/fleet.ts`'s harvest verb (a `const tdeps: TeardownDeps`
construction), `scripts/sandbox-teardown.ts` (also a `TeardownDeps` construction), and
`teardown.ts`'s internal harvest step — **all three flow `TeardownDeps`, whose `recordAuditLink`
is required**, so the script-level sites get their compile-time loudness from that interface;
`HarvestDeps` carries its own required field because `harvestRun` is its own composition surface —
its bundle-verify and bundle-fetch emits live on `HarvestDeps`, and `teardown.ts`'s artifacts step
forwards a `HarvestDeps` view verbatim (DF1.10 AC4) — plus DF3.7's later production caller.
A caller that forgets the seam
fails to typecheck rather than producing a run whose hop 6 is `unlinked` and whose lights-on gate is
red forever.*** The `driver.ts` threading is smaller than it first
looks — only `provisionAdmittedRun` and `fillRun` are live sites, and the driver-side seam carrier is
stated rather than implied: a new **required** `recordAuditLink` field on `provisionAdmittedRun`'s named
options type, and a new trailing **required** options argument on `fillRun` — signature changes whose
existing production callers, the dispatch fill step and `scripts/cap-hit-demo.ts`, are threaded in this story
alongside every test file and fake the threading touches — enumerated in the Files list's
threading row — so the compile-time-fail property covers the
driver-side sites exactly as it covers the four `*Deps` interfaces — never a module-level ambient import, which
would violate the no-ambient-dependencies rule above — but `src/fleet/dispatch.ts` gains
the `setup-gate` emit — new work in a file this story's Files to Modify owns. That
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
   resolved. **When hop 1 resolves no runId the single key falls back to the PR URL, or to the raw
   ref** — a lookup key, never a claim: `RunChain.runId` stays `null` on that path, and a consumer
   (DF5.4-C9) that reads `Object.keys(report.runs)` as run ids must test `runId !== null` first.
   That fallback exists only on the broken-chain paths such a consumer is meant to inspect. Hop 10 — Hindsight's **retain receipt** — is typed
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
5. Given a healthy run, Then hop 3 resolves the ledger **as it actually holds it**: since DF2.12
   wired the DF2.7→ledger token bridge (the ledger's `ingestCostEvent` is the only writer of
   `kind='tokens'` rows and both `teardownSandbox` ingest points call it through
   `ingestHarvestedTokensIfWired`), `perRole` carries real role buckets alongside the literal
   `"box-hours"` key and `hasTokenRows` is `true`. A ledger holding box-hours rows only
   (`hasTokenRows: false` — the pre-bridge or frozen-fixture shape) resolves identically complete:
   the single-key shape is tolerance, never an expectation; a
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
   the PR opens — verified at `src/pr/push.ts`'s preflight), so a millisecond-equal pair is a red gate on a PR DF5.2 lawfully admitted — the
   remedy is to tighten `push.ts`, never to loosen this chain's comparison. **The tightening is
   owned, not wished for: this story lands it** (Files to Modify: `src/pr/push.ts`, DF5.2-owned —
   the preflight's boundary refusal widens from `decided < completed` to `decided <= completed`,
   refusal code and message unchanged), on the same consumer-owns-new-work-in-a-done-story's-file
   precedent this story already set with the `src/fleet/dispatch.ts` `setup-gate` emit. DF5.4-C6/C7
   assert the same strict pair, so the chain, the gate and the admission rule agree from one merge. A violation is a
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
| Host-side link store `.sandbox/audit.db` (resolved `QDS_AUDIT_DB ?? .sandbox/audit.db`, **dir mode 0700 on creation only — never widened and never narrowed if the directory already exists** (amended in review round 3: the unconditional `chmodSync(dir, 0o700)` this row originally copied was proven to chmod `/tmp` when `QDS_AUDIT_DB` pointed under it, and then to refuse every dispatch; only the directory this call created is chmodded), file 0600 **applied at creation** so the store is never briefly world-readable under a permissive umask — the `CostLedger` constructor's side-effect list is the pattern to copy, **except its `PRAGMA journal_mode = WAL`: this store stays on SQLite's default `DELETE` journal**, so it leaves no `-wal`/`-shm` siblings and DF5.4's "the gate wrote nothing but its report and these rows" file-set assertion can be **exact** rather than carrying a transient-sidecar exception list — an exception on a byte-identical assertion is where a real difference hides. `audit_links` is append-only, low-volume and read once per walk, so it has no throughput reason to want WAL, and DF2.11's "**Named ceiling — a read-only open of a WAL database**" bullet records the other half of the cost: a WAL database cannot be opened read-only without writing a `-shm`. **And the opener copies DF2.11's no-create discipline and then closes the hole a held-fd-only comparison leaves, because `bun:sqlite`'s `new Database(path)` creates the file when absent — the identical defect DF2.11 chartered against, one store over:** the walker's read-write open is (1) preceded by a no-create `openSync(path, "r")` probe that throws a typed `audit-store-absent` while **holding** the fd and recording its `fstatSync(fd).ino`; (2) followed by `new Database(path, {})` — an open **by path**, which can land on a different inode than the one probed if the store is removed or replaced in the window between probe and open (the held fd keeps the probed inode alive but does not pin the path, so comparing the held fd's inode to itself can never fire); (3) the opened database is therefore **bound to the probed inode before any digest write**: with the probe fd still held, the opener takes a second `openSync(path, "r")` on the same path and compares its `fstatSync(fd).ino` against the recorded probe inode — a mismatch (replace-and-restore across the window) or a failed re-open (removal across the window) throws `audit-store-identity-changed`, closes every fd and the database, and writes nothing; only verified identity proceeds to any first-observation digest row) | `bun:sqlite`, bundled with the project's bun toolchain — no new dependency | schema migrated idempotently (`CREATE TABLE/TRIGGER IF NOT EXISTS`, serialized with `BEGIN IMMEDIATE` + `busy_timeout`) during the first `recordAuditLink` (write-time init) only; the walker opens read-**write** — it appends first-observation digest rows, see Technical Notes — but **never** migrates and **never creates**: it asserts the schema is present and fails the walk closed with a named broken hop per INV-AUDIT-6, and the no-create opener means an uninitialized store (zero `recordAuditLink` calls) is a typed `audit-store-absent` refusal, never a zero-byte file the read path materialised; host-side so it survives box destruction (§6 item 4) |
| DF2.8 cost ledger `.sandbox/cost-ledger.db` (`DEFAULT_COST_LEDGER_FILE`, overridable by `QDS_COST_LEDGER_FILE`) · DF1.4 **harvested** trace DB · DF2.1 run record | host `bun:sqlite` store · `<runsDir>/<runId>-artifacts/trace/trace.db` (pulled out of the box by DF2.5's `pullArtifacts`, `harvest.ts:1068`; the `trace/` prefix is load-bearing — see Technical Notes) · `<runsDir>/<runId>.json` via `resolveRunsDir()` (`src/providers/run-record.ts`) | the cost hop opens the ledger through **DF2.11's `CostLedger.openReadOnly({ path })`** and calls its `readRunCost(runId)` **method** — DF2.8 exports the class, not a free function — run-keyed, never the issue-scoped `readIssueCost` — the hop is about *this run's* spend, not the issue's, and it never re-SUMs. **This buys no tolerance of an issue-less run:** `extensions.budget` is written only when the dispatch carries an issue ref (`src/providers/driver.ts:572`; `src/providers/run-record.ts:220-221`), and `ingestBoxHoursIfAttributed` writes no box-hours row without a string `repoSlug`/`issueId` (`teardown.ts`), so an issue-less run has zero ledger rows, `hasEvents` is `false`, and AC5 makes hop 3 a **broken** hop. That is intended and matches DF5.4-C1: a run nothing admitted is a run nothing capped, and it is not a run this chain can vouch for. **The ordinary constructor is not read-only** (the `CostLedger` constructor: `mkdirSync` 0700, `chmodSync` 0700, `new Database()` which CREATES the file when absent, `chmodSync` 0600, `PRAGMA journal_mode = WAL`, `db.exec(SCHEMA)`), so the walker opens through **DF2.11's `CostLedger.openReadOnly({ path })`** and never lets the read path create the store it is auditing. Not an `existsSync` pre-check: DF2.11 specifies a **no-create `openSync(path, "r")`** that throws `ledger-absent`, holding the fd open and comparing `fstatSync(fd).ino` against the probed inode to throw `ledger-identity-changed` on a replace-and-restore (DF2.11's "**`openReadOnly` is a static factory on the same class**" bullet). Hop 3 resolves as a named broken hop on either code, and on DF2.11's typed hot-WAL refusal `ledger-wal-recovery-required` (DF2.11's "**Named ceiling — a read-only open of a WAL database**" bullet — SQLite cannot open a WAL database read-only without writing a `-shm`). **The trace DB is an artefact of a completed harvest, not a live host store: hops 2 and 9 first resolve `runId → record.requestId` (`requestId`, `src/providers/run-record.ts`), then join the trace DB on `request_id` (`trace/schema.ts:35` `sessions`, `:86` `gate_results.request_id` — the store is keyed on `request_id` throughout, never on `run_id`).** A run whose artifacts pull failed (`teardown.ts:279-287`, non-fatal by design) or whose box rebooted before harvest (tier-2 placement ADR `:81-82`, measured: `/run` is tmpfs and a reboot wipes it) resolves hops 2 and 9 as `{ status: "evidence-not-harvested", reason, evidencePath }` — a *named, typed* outcome distinct from a broken hop, because the loss is a recorded teardown outcome, not a missing link. The run record is resolvable by runId at walk time, and an unreadable record is a named broken hop, never a skipped one |
| DF5.1 re-verify record · DF3.4 approval record · DF5.2 PR record · GitHub PR body read | host-side artifacts written by those stories; GitHub API with the host-side token | each read read-only by path — the walker asserts presence and identity and never re-runs the underlying action; the token is checked by name only and never reaches a diagnostic or the chain object (INV-AUDIT-2) |

## Technical Notes

- **Hop table (NET-NEW per DD-8).** The source's 8 hops (`p1-16-audit-chain-pr.md:36`) re-aimed and
  extended to ten; hops 4–7 are the v5 links the source story could not know:

  | # | Hop | Join key / evidence | Origin |
  |---|-----|--------------------|--------|
  | 1 | PR → run | branch `qds/{runId}` + runId in PR body | DF5.2 |
  | 2 | run → issue | `(repo_slug, issue_id)` on the **harvested** trace `sessions` row, reached `runId → record.requestId → sessions.request_id` (`src/phase-engine/trace/schema.ts` — `sessions` PK'd on `request_id` — **plus the `ALTER TABLE` additions in `src/phase-engine/trace/migrations.ts`, which is where the two join columns come from**: `sessions.repo_slug TEXT` and `sessions.issue_id INTEGER`, both nullable — DF1.8's own comment: "a bare DF1.4 run carries NULL `repo_slug`"). The coercion rule is stated once: `String(sessions.issue_id)` compared against the canonicalised record value, because the column is INTEGER while `extensions.budget.issueId` is a registered `"string"` — an uncoerced `42 === "42"` reports a broken correlation on a healthy run. A NULL correlation splits by **which side is null** (amended in review round 3 — the implementation is fail-closed and this row now says so): when the **record** carries `extensions.budget.repoSlug`/`issueId` but the harvested `sessions` row is NULL/NULL, the hop resolves `{ status: "not-applicable", reason: "bare run carries no issue correlation (DF1.8 nullability)" }` on a walk reached by runId — the trace is corroboration only, so its nullability is not a chain failure. When the **record itself** carries no correlation, the hop is `broken`: the record is hop 2's authority, and a walker that called a run correlated on no evidence would vouch for an issue link that was never admitted. On the PR-rooted walk neither arises, because admission required the issue ref; `evidence-not-harvested` per AC6 when the artifacts pull failed | DF1.8 / DF1.4 / DF1.10 |
  | 3 | run → cost | `CostLedger.openReadOnly({path}).readRunCost(runId)` (DF2.11) — µ$ total plus the `perRole` map, keyed by run, not issue. **Since DF2.12 the DF2.7→ledger token bridge is wired** (the ledger's `ingestCostEvent` is the only writer of `kind='tokens'` rows, and both `teardownSandbox` ingest points call it through `ingestHarvestedTokensIfWired`), so a healthy production run's `perRole` carries real role buckets alongside `"box-hours"` and `hasTokenRows` is `true`. The hop reports `perRole` verbatim and additionally surfaces `hasTokenRows`; it never asserts a multi-role split, and it never reads `hasEvents: false` as "spent nothing". **The single-key shape survives as tolerance, never expectation** — a ledger holding box-hours rows only (a pre-bridge or fixture run) resolves identically complete, with no change to this hop's contract. (DF2.12 wired the bridge; it did not close all of #157 — the issue's deferred money-loop residuals remain open and are no predecessor of this story.) | DF2.8 |
  | 4 | run → credential | `key_hash`; `mint` / `deliver` / `revoke` / `verify-revoked` events. There is no `cap` event — the cap is an argument to mint, carried as the mint row's `detail_json.limitMicroUsd` | DF2.3 links |
  | 5 | run → box | `create` (`provisionAdmittedRun`, `src/providers/driver.ts:549` — the site `src/fleet/dispatch.ts`'s create step actually calls; `createRun` `:905` is exercised by `scripts/cap-hit-demo.ts`'s create arm, by `tests/fleet/approval-gate.test.ts`, by `tests/providers/quota.test.ts` and `tests/providers/driver-contract.test.ts`'s option constructions, and by `tests/fleet/e2e/tier1-provision-status.live.test.ts`) → `fill` (`fillRun`, `src/providers/driver.ts:935`, called at the dispatch fill step) → `setup-gate` (DF3.1's setup gate at the dispatch setup step — **not** `setupRun`, `src/providers/driver.ts:1066`, which has zero production callers: its only callers are in `tests/providers/driver-contract.test.ts`) → `teardown` (`teardownSandbox` in `teardown.ts`) → `reap` (`sweep` in `reaper.ts`, **`not-applicable` on the ordinary path — see AC5**). `execute` and `observe` are **not** host-side events post-DF1.10: the engine runs in-box under the systemd unit (ADR consequence 2) and its output leaves through DF2.5's tar, so `executeRun`/`observeRun` (`src/providers/driver.ts:1076,:1086` — demo-only, and test-only-caller respectively: one `observeRun` call in `tests/providers/driver-contract.test.ts`) are not emit sites and no link is manufactured for them (INV-AUDIT-4) | DF2.1/DF2.5/DF2.6 links |
  | 6 | run → bundle | the bundle at `<runsDir>/<runId>.bundle` (`harvest.ts:18-19` — its presence IS the record; DF2.1's schema stays closed) and this story's own `bundle-verify` link row — **the decisive evidence, sufficient alone**: the walker re-checks the bundle's digest against the row and carries no git-dir seam, so hop 6 never resolves a ref; `refs/sandbox/<run-id>` is **corroborating only** (the ref-vs-bundle identity is DF5.4-C5's assertion, through the frozen fixture's bare `refs.git` and never the operator's working repo); a bundle-fetch failure resolves `evidence-not-harvested` naming `<runsDir>/<runId>.bundle` per AC6, never `unlinked` — a harvest loss is not a missing link | DF2.5 link |
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
  and passes it straight into `createKey`. It is recorded as the mint row's
  `detail_json.limitMicroUsd`. Emitting a separate `cap` row would manufacture a link for an event that
  never occurred — INV-AUDIT-4.
- **Ten hops *per contributing runId*, and why the return shape is a map (DF6.1b reciprocal).** The
  ten hops above are the hop set for **one** run, and `walkAuditChain` returns them keyed by
  contributing runId. This story's walker resolves exactly one key: the parent run it reaches from
  the ref at hop 1 — a PR with no fix attempts has one contributor, so the default is a single-entry
  map, not a bare hop list. **DF6.1b** (fix-loop verdict + attempt budget — DF6.1 was split into
  DF6.1a/DF6.1b on 2026-09-08, and DF5.3 is an edge of **DF6.1b** only) extends `src/audit/chain.ts`
  **additively**: it reads the parent record's `extensions.fixLoop.fixOutcome` — a `string`-kind field
  (`fixLoop.fixOutcome`, `src/providers/run-record.ts`; `ExtensionValue = string | number | string[]`) whose JSON payload
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
- `requestId` on the run record (`src/providers/run-record.ts`, a core field) is the dispatch correlation id and
  is the walker's runId→trace-session key (the trace `sessions` table is PK'd on `request_id`,
  `trace/schema.ts:34-35`).
- **Hops 8 and 9 read stores, not streams, and both are per-run.** Hop 8 reads `extensions.approval`
  (`extensions.approval`, `src/providers/run-record.ts`) out of the run's own `<runsDir>/<runId>.json` — a lookup by runId with no
  join. Hop 9 reads the **harvested, per-run** trace DB and joins `gate_results.request_id`
  (`trace/schema.ts:86`) to `record.requestId`, which DF1.10 guarantees is the same value: the dispatch
  `requestId` reaches the in-box engine through the unit environment and is stamped on every trace row.
  Cross-run contamination is impossible because each run's trace DB is created by the tracer's
  `openWriter` at `<dataDir>/trace.db` — the in-box data dir is the per-run run root's `trace/`
  directory, never a shared `/run/trace/` — and harvested into that run's own `<runsDir>/<runId>-artifacts/`
  (`harvest.ts:1068`).
  **`dispatchRequestId` is a LOG key, not a column, and the walker never uses it.** It exists only on
  `fleet`'s gate-event and `approval-gate`'s pause LOG lines (in `src/fleet/approval-gate.ts` and
  `scripts/fleet.ts`), where it disambiguates the emitting context's `requestId` from the
  run's (`src/providers/run-record.ts:285-292`). No store the walker opens has such a column; an implementation that
  looks for one resolves zero rows. **The `extensions.approval` registration docblock in
  `src/providers/run-record.ts` closes with the sentence "`dispatchRequestId` is the cross-process
  join, and DF5.3 joins on it" — that sentence is STALE and contradicts this contract.** No
  `dispatch_request_id` column exists in any store the walker opens (the identifier appears only on
  those log lines; the stores join on `request_id`). The comment belongs to the run-record owner and
  is flagged here for its owner, not edited by this story (`src/providers/run-record.ts` is not in
  Files to Modify) — trust this contract, not that comment.
- Errors include `{ code, message, remediation }`, the last being the literal next command.
- Sub-timings: `per_hop_ms` keyed by hop name, plus `pr_fetch_ms`; a hop that did not run reports 0.

## Files to Modify

- `src/audit/link-store.ts`
- `src/audit/chain.ts`
- `src/audit/index.ts`
- `src/providers/credentials.ts`
- `src/providers/driver.ts` — the four `*Deps`/options widenings of the Scope note, **plus `CreateRunOptions` gains the same required `recordAuditLink`** (W12B-1): `createRun` is an internal production caller of `provisionAdmittedRun` (the demo path's own composition), so it threads the field verbatim through its options — no no-op sink, no widening that swallows the loudness; `cap-hit-demo.ts`'s create arm constructs `createRun`'s options and is threaded by the blast-radius row below
- `src/providers/harvest.ts`
- `src/providers/teardown.ts`
- `src/providers/reaper.ts`
- `src/fleet/dispatch.ts` (the `setup-gate` emit — a composition root importing `recordAuditLink` directly)
- `src/pr/push.ts` (DF5.2-owned; **one comparison tightened**: the preflight's `decided < completed`
  refusal becomes `decided <= completed`, so the admission rule matches AC7's strict chain —
  ownership rationale in AC7; no other line of the preflight changes)
- `scripts/fleet.ts` and `scripts/sandbox-teardown.ts` (threading the now-required `HarvestDeps.recordAuditLink` at their existing `harvestRun` call sites — see the Scope note)
- **the threading's blast radius, owned here (W10B-1, extended W12B-2):** **production** — `src/fleet/fanout-primitive.ts` (the fan-out race's internal `TeardownDeps` construction threads the field at its construction site) and `scripts/sandbox-reap.ts` (its full `SweepDeps` assembly at the `sweep()` call supplies it; `SweepDeps`' field rides the reaper's orphan-path emitter); **and the reaper's internal credential-deps literal is the one named no-op sink (W14B-3):** the reaper's `revokeAndVerify` path runs under a run-less step context (the `runId: null` lives in `credentials.ts`'s internals), and `audit_links.run_id` is NOT NULL — a run-less revocation has no hop to serve, so INV-AUDIT-4's no-manufactured-links rule names that literal's `recordAuditLink` a deliberate no-op rather than pretending an emit exists; `scripts/cap-hit-demo.ts` (whose create arm constructs **`createRun`'s** options and whose run arm gains the trailing `fillRun` argument); **tests** — `tests/providers/`: `fake-driver`, `driver-contract`, `exedev/fill`, `exedev/setup-gate`, `exedev/driver`, `budget-gate`, `harvest`, `teardown`, `credentials`, `df2-11-teardown-race`, `reaper`, `quota`; `tests/fleet/`: `run`, `attach`, `dispatch`, `verbs`, `gate-verbs`, `patterns`, `approval-gate` (its inline `TeardownDeps` literal); `tests/fleet/e2e/`: `live-harness`, `tier1-approval-gate.live`, `tier1-provision-status.live`, `tier2-image-contract.live` — each threaded in this story. The list's completion criterion is the typecheck itself: a required field the Files list mandates but whose breakage no row owns would make the story unbuildable as written, and the breaking compile **is** the typecheck-loudness guarantee working, not a regression.
- `scripts/qds-audit.ts`
- `scripts/pipeline-run.ts` — **DF1.8-owned; added in review round 3 after the acceptance audit
  flagged it as undeclared.** `src/fleet/dispatch.ts` writes a versioned `correlation` witness
  (the `repoSlug`/`issueId` pair) into `run-context.json`, and this file is its in-box reader:
  `witnessCorrelationBeside` carries the correlation into the trace `sessions` row so hop 2 has
  something to **corroborate** against. Ownership rationale, stated because the refusals are
  in-box and therefore expensive: hop 2's *authority* is the run record, never this row, so no
  AC's verdict depends on the plumbing — which is why a **present-but-malformed** correlation
  (half a pair, bad field types, a witness `requestId` that disagrees with `--request-id`) is a
  hard refusal, while an **environment** fault reading the witness (EACCES/EIO, a symlinked
  witness) degrades to a bare session plus a `run_correlated` `recorded:false` line. A forged
  correlation must not silently become a session row; a box's disk problem must not destroy a run
  that has already spent. Any further behavior change to this reader belongs to DF1.8's owner.
- `tests/audit/link-store.test.ts`
- `tests/audit/chain.test.ts`
- `tests/scripts/qds-audit.test.ts`

## Security Invariants

- **INV-AUDIT-1 (repo scoping):** the walker reads only stores and records within the run's own
  `repo_slug` scope — no cross-repo, no cross-tenant read. Identity is `(repo_slug, issue_id)`, never
  an issue number alone: `#42` exists in every repo the factory touches.
- **INV-AUDIT-2 (no secret material in the chain or its diagnostics):** the GitHub token, the
  `OPENROUTER_PROVISIONING_KEY` and **minted key material** never appear; credential hops carry
  `key_hash` and an 8-char hash prefix only (a deliberate divergence from the reaper's 12-hex
  `keyHashPrefix` — that prefix disambiguates live credentials for reaping; this one only makes
  leaked-row correlation harder, and neither is secret material) — `p1-16:52` extended to credential events.
- **INV-AUDIT-3 (cost granularity, µ$ per DD-9):** this is a **ceiling, not a capability claim** — the
  cost hop reports aggregated micro-dollar totals and the `perRole` map at whatever granularity the
  ledger holds (since DF2.12, real role buckets beside the `"box-hours"` key; the single-key shape
  remains tolerated), and **never** raw
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

- [x] **Impl:** `recordAuditLink` writes append-only rows with
      `UNIQUE (run_id, hop, event, COALESCE(subject_id, '<none>'))` **via a generated column** — the
      literal form from the Technical Notes, never the bare `subject_id` column, because NULLs are
      distinct in a SQLite UNIQUE index and a bare column lets a redelivered subject-less emit
      duplicate — plus `ON CONFLICT DO NOTHING` and an `evidence_digest` computed at emit time.
- [x] **Impl:** `walkAuditChain(ref)` accepts a PR URL, branch name or runId and resolves the ten
      hops in the Technical Notes table **per contributing runId**, returning a map keyed by that
      runId — one entry, the parent run, for every ref this story can be handed.
- [x] **Contract:** `bun scripts/qds-audit.ts <ref>` prints per-hop status and exits on the BINDING
      three-valued matrix (amended in review round 3, and the matrix DF5.4-C9's harness branches on):
      **`0`** a `ChainReport` was produced and the chain is COMPLETE · **`1`** a `ChainReport` was
      produced and the chain is INCOMPLETE · **`2`** no report was produced — a usage error, any
      `ChainWalkError`, or any environment fault during the walk (a missing runs dir, an unopenable
      or corrupt store, an unreadable ledger, a `gh` read that throws). An environment fault must
      never be reported as "the audit chain is broken": exit 1 strictly means walked-and-incomplete,
      never "the tool could not look". And
      `--json` emits the whole chain object typed as the exported **`ChainReport`** — the map keyed by
      contributing runId, each hop's typed status and, for hops 4/5/6, the emitted `audit_links` row
      ids. DF5.4-C9 imports `ChainReport` and asserts against it; the exit code alone is not the
      contract.
- [x] **Integration:** link rows emitted at event time by each event's own emitter — `credentials.ts`
      (`mint`/`deliver`/`revoke`/`verify-revoked`), `driver.ts` (`provisionAdmittedRun` =
      `create`, `fillRun` = `fill`), `src/fleet/dispatch.ts` (`setup-gate`), `harvest.ts`
      (bundle verify + fetch), `teardown.ts` (`teardownSandbox`) and `reaper.ts` (`reap`, orphan
      path only) — each through its own `*Deps` seam, required at the four composition sites named in
      the Scope note, **except `src/fleet/dispatch.ts`, which is a composition root and imports
      `recordAuditLink` directly**. No emit at `createRun`/`setupRun`/`executeRun`/`observeRun`: they are demo-only or
      zero-caller, and `execute`/`observe` are in-box post-DF1.10.
- [x] **Security:** hop 10 recorded VOID with its reason per DD-4, excluded from the verdict
      (INV-AUDIT-6); a redaction test asserts no key material, token or plaintext reaches any hop,
      diagnostic or log line (INV-AUDIT-2).
- [x] **Test (unit):** a complete run resolves ten hops per contributing runId with zero nulls — one
      key, the parent run — the memory hop typed `void`, the cost hop reporting a µ$ total and the
      `perRole` map as the ledger actually holds it — production-shaped post-DF2.12
      (`hasTokenRows: true`, real role buckets beside `"box-hours"`), with a `hasTokenRows: false`
      fixture case retained to pin the tolerance as tolerance, never the expectation.
- [x] **Test (broken hop):** a PR body with no runId → hop 1 named with expected/actual/diagnostic
      and a non-zero exit; an implementation returning the other nine as "complete" MUST fail.
- [x] **Test (in-box-evidence negative control):** DF5.1's re-verify record absent but the in-box gate
      results green → hop 7 broken (INV-AUDIT-5); an implementation reading the in-box results as
      authority passes the happy path and MUST fail this test.
- [x] **Test (immutability + retroactive-link rejection):** `UPDATE`/`DELETE` on a link row aborts;
      a tampered artifact yields `evidence-mismatch`; a run with no links resolves `unlinked`, fails
      the chain and exits non-zero — an implementation exiting 0 on it MUST fail this test (AC3).
- [x] **Test (per-run isolation, `tests/audit/chain.test.ts`):** two runs whose artifacts dirs sit side
      by side under one `<runsDir>`; hop 9 of each resolves **only** the `gate_results` rows in its own
      `<runId>-artifacts/trace/trace.db`, and hop 8 of each reads only its own record's
      `extensions.approval`. An implementation that globs `<runsDir>/*-artifacts/**/trace.db`, or
      resolves the approval by `requestId` rather than by runId, MUST fail this test.
- [x] **Test (hot-WAL recovery, `tests/audit/chain.test.ts`):** a fixture artifacts dir carrying a
      non-empty `trace.db-wal`, no `-shm`, and a `gate_results` row reachable only through the WAL; hop 9
      resolves that row and the artifacts directory is byte-identical afterwards. An implementation
      opening the artifacts copy in place — read-only or read-write — MUST fail this test.
- [x] **Test (the walker never creates the store it audits):** a walk against a host whose
      `.sandbox/audit.db` is **absent** refuses `audit-store-absent` and leaves the file absent
      afterwards — checked by asserting the path still does not exist, not by inspecting logs. An
      implementation whose read-write open materialises a zero-byte `audit.db` before any schema
      assertion MUST fail this test; so must one whose DoD fixture always ships an `audit.db`, hiding
      the create branch from the harness (the fixture carries no `audit.db` precisely so the branch
      runs). **Two identity-window controls ride the same harness:** a walk whose `audit.db` is
      **swapped for a different file after the no-create probe and before the SQLite open** refuses
      `audit-store-identity-changed`, writes no digest row into the replacement, and leaves the
      replacement byte-identical; one whose `audit.db` is **removed in the same window** refuses the
      same code, recreates nothing, and ends with the path absent. An opener whose identity check
      compares the probe fd's own inode to itself — a comparison that cannot fire — MUST fail both.
- [x] **Test (authorizing-record tamper, `tests/audit/chain.test.ts`):** a walk records digests for hops
      1, 7 and 8; editing the **bound** `ReverifyReport`'s `verdict` **in place** and re-walking yields
      `evidence-mismatch` on hop 7 and a non-zero exit, while **appending a lawful second report does
      not**, and neither does a lawful `closedAt`/`spendMicroUsd` write to the run record. An
      implementation digesting the whole `.jsonl` or the whole `<runId>.json` passes the first case and
      MUST fail the second and third.
- [x] **Test (ordering, `tests/audit/chain.test.ts`):** a chain whose `revoke` row precedes its `mint`
      row, and a run whose `approval.decidedAt` precedes its `reverify.completedAt`, each yield
      `order-violation` and a non-zero exit (AC7).
- [x] **Test (admission-rule strictness, AC7):** an approval whose `decidedAt` **equals** its bound
      report's `completedAt` is refused `approval-precedes-report` by `pushVerifiedSha`'s preflight —
      equality no longer opens a PR. An implementation leaving `push.ts` non-strict passes every
      chain test and MUST fail this one; so must one that loosens the chain's comparison to match
      the old admission rule instead of tightening the rule (AC7's remedy is one-directional).
- [ ] **Test (e2e demo — MANDATORY):** walk a real merged factory PR and capture the printed chain as
      an artifact — ten hops, the VOID memory hop with its OQ-4 reason, a µ$ cost total, under 30 s.
      **The one box still open.** Deferred by operator; handoff prompt ready at
      `_bmad-output/plans/df5-3-live-e2e-handoff.md` (creates a scratch repo in the org, produces
      the first real factory PR through dispatch → reverify → approval → push → merge, then walks
      it). The fifteen boxes above were ticked in review round 3 after their coverage was verified
      in-tree; this one cannot be ticked without spending real money on a real box, which is the
      operator's call, not the reviewer's.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->

## Status

`in-progress` — code review **round 3** complete (PR #258, 2026-09-17). Rounds 1 and 2
landed as `7bb6c221` / `c6800cfa`; round 3 ran 15 parallel reviewers over an 11-chunk
diff and patched 93 findings across 11 fix clusters. Full suite green (5,972 pass / 0
fail), `bunx tsc --noEmit` and `bunx biome check` clean, `detect_changes` blast radius
confined to this story's own modules. Fifteen of the sixteen DoD boxes are now ticked;
the MANDATORY live e2e demo remains **deferred by operator** (handoff at
`_bmad-output/plans/df5-3-live-e2e-handoff.md`), so the story is not `done`.

## Review Findings

Adversarial review round 1 on PR #258 — 12 parallel reviewers (3 blind-hunter, 7
edge-case/test, 2 acceptance auditors) over a chunked `git diff origin/dev`
(5,083 insertions / 173 deletions, 52 files). 118 raw findings → 97 after dedupe.
Fixed in two waves (7 source clusters, then 7 test clusters) plus four follow-up
rounds raised by the agents against each other.

### Patched — HIGH

- [x] [Review][Patch] Hop 8's strict authorization ordering was skipped ENTIRELY when `pr.createdAt` was absent — fail-OPEN on AC7 [src/audit/chain.ts]. The whole conjunction, including the `reverify.completedAt < approval.decidedAt` half that needs no PR timestamp, was gated on all three stamps. `ghFetchPull` never fetches `createdAt`, so a PR-URL walk whose record carries no `extensions.pr` enforced NOTHING and reported `complete: true`. Each pairwise constraint now has its own guard; a stamp the constraint needs but cannot find is a named `broken` hop. A second cause was found while fixing: `prEntry` was assigned only on hop 1's SUCCESS paths, so any post-fetch hop-1 failure left hop 8 blind to a `createdAt` sitting in the record it also reads.
- [x] [Review][Patch] Tamper detection on hops 1/7/8 was defeated by editing the field that FORMS the subject id [src/audit/chain.ts]. `authorizingDigest` keyed its prior-row lookup on `subjectId`, so rewriting `extensions.approval.approverId` changed the key, found no prior, appended a NEW first-observation row and resolved clean. Priors are now matched on `(hop, walk-observed)` alone; a differently-keyed prior for a singular hop reports `evidence-mismatch` with new `expectedSubjectId`/`actualSubjectId` fields.
- [x] [Review][Patch] `ghFetchPull` never drained `stderr`, so a chatty `gh` deadlocked the walk with no working ceiling [src/audit/chain.ts]. Once the pipe buffer filled, `proc.exited` never settled; the per-hop ceiling is measured after `fn()` returns and the total ceiling only between hops. stderr is now drained concurrently, redacted and capped into the `pr-fetch-failed` message, and the spawn has a real kill-on-timeout.
- [x] [Review][Patch] `canonicalJson` and `JSON.stringify` disagreed on an `undefined` object member, producing a PERMANENT false `evidence-mismatch` [src/audit/link-store.ts, src/providers/driver.ts]. Live sites: harvest's `{ tip: stepA.tip }` and teardown's `{ closedAt }`. The store is append-only with RAISE(ABORT) triggers, so the row could never be corrected. Both canonicalisers now drop `undefined` members; `detail_json` is persisted with the canonicaliser so the stored bytes are the exact digest preimage.
- [x] [Review][Patch] `openAuditStore` chmod'd the store's PARENT DIRECTORY unconditionally [src/audit/link-store.ts]. `QDS_AUDIT_DB=/tmp/audit.db` chmod'd `/tmp` to 0700; a bare filename chmod'd the CWD. PROVEN live to refuse every dispatch with `audit-store-unavailable: EPERM … chmod '/tmp'`. Only a directory the call actually created is chmod'd now, with a regression test that dispatches against a pre-existing unowned parent.
- [x] [Review][Patch] A lawful re-harvest made hop 6 permanently `evidence-mismatch` [src/providers/harvest.ts, src/audit/chain.ts]. The bundle link's `subjectId` was the constant path, so the second harvest collided on the UNIQUE key and was dropped while the FILE was overwritten — the walker then recomputed a digest that could never match the frozen `detail.sha256`. Subjects now carry the generation (`<bundlePath>#<sha256>` / `#<tip>`); the walker takes the newest row per event and digest-checks every row.
- [x] [Review][Patch] The `teardown` link was emitted after the irreversible close, outside every step, on a path that could never re-run [src/providers/teardown.ts]. A store refusal turned a fully successful teardown into a reported failure attributed to no step, and the operator's re-run short-circuited at the first-close-wins guard BEFORE the emit — so hop 5 reported `unlinked` forever. The emit moved inside the `close` step, and a healing emit was added to the first-close-wins arm.
- [x] [Review][Patch] The `reap` emit could throw mid-sweep after `driver.destroy` succeeded [src/providers/reaper.ts]. The generic catch then pushed `destroy-failed` while the unit was still in `executed.destroy` — one report counting a box as destroyed AND as failed, with a remediation sending the operator after a box that no longer exists. Now wrapped per-unit; a store fault logs and the sweep continues.
- [x] [Review][Patch] `createRun` dropped `correlation.requestId`, and emitters invented one via `newRequestId()` [src/providers/{credentials,driver,harvest,teardown,reaper}.ts]. An invented join key is the same class of fabricated evidence as an invented `repoSlug` — and the walker JOINs `sessions.request_id` on it, so it is a FALSE correlation, not a weak one. All four emitters now take the id from the record alone and skip when it is absent (CONTRACT C5 option (c)); `provisionAdmittedRun`'s `create` keeps `opts.requestId` as its primary source, because the record provably has no stamp at that point.
- [x] [Review][Patch] One run's hop-5 links used two different `repoSlug` sources [src/fleet/dispatch.ts, src/providers/driver.ts]. `create` derived it from the record; `fill` and `setup-gate` used the dispatch-local variable, so an unattributed run emitted `fill` + `setup-gate` with no `create` — a set the chain reads as "the box was filled before it was created". Dispatch now derives one record-sourced slug and all three sites skip together.
- [x] [Review][Patch] Any non-`ChainWalkError` fault exited 1, colliding with "the chain is broken" [scripts/qds-audit.ts]. VERIFIED: a mistyped `--runs-dir` gave exit 1 with 0 bytes on stdout, so a CI gate branching `1 → parse the report` parsed nothing and an environment fault was indistinguishable from a real audit break. Exit 1 is now reachable only from a produced ChainReport.
- [x] [Review][Patch] `issueId` was cast `as number` with no type check, and the digits-only regex was used as a CONVERSION condition rather than a validation GATE [scripts/pipeline-run.ts]. `" 1"`, `"+1"`, `"1.0"`, `"1e3"` fell through as raw strings; `repoSlug` and `issueUrl` both had explicit refusals while the co-equal half of the INV-RUN-3 pair had none. Now a gate applying `--issue`'s own test character-for-character.
- [x] [Review][Patch] Hop 2 stopped producing AC6's `evidence-not-harvested` and the hop table's `not-applicable` [src/audit/chain.ts]. Resolved by keeping the record as authority (stronger than the spec, per INV-AUDIT-5) while restoring both spec statuses. **One deviation remains, deliberately**: a record carrying no `extensions.budget` correlation returns `broken` where the hop-2 row says `not-applicable` — the fail-closed reading.

### Patched — MEDIUM / LOW (summary)

- [x] [Review][Patch] `rowsByEvent` silently kept only the LAST row per event, dropping lawful duplicates from both the digest and order checks [src/audit/chain.ts].
- [x] [Review][Patch] An unparseable `occurred_at` silently DISABLED the ordering check — the cheapest way to switch it off. Now a write-time refusal (canonical UTC ISO required) plus a read-side `broken` for rows already on disk.
- [x] [Review][Patch] Hops 4/5/6 never checked `recordError`, so an unreadable record produced the false claim "the reaper never collected this run".
- [x] [Review][Patch] `ChainWalkError` could never escape `walkAuditChain` — `timed`'s catch-all flattened it, making `pr-fetch-failed` unreachable and the CLI's handler dead code.
- [x] [Review][Patch] Neither ceiling could interrupt a hop; both were measured after the fact. Hops now race a real timer, `hop-timeout` no longer overwrites a `broken`, and a `budget: "hop" | "total"` discriminator distinguishes the two exhaustion causes.
- [x] [Review][Patch] The walker stamped `occurred_at = now()` for events that happened days earlier, into an append-only store that sorts by that column.
- [x] [Review][Patch] Unbounded reads: the whole bundle buffered to feed a hasher (the emitter already streams), and an unbounded `gate_results` scan for 50 rows.
- [x] [Review][Patch] `ON CONFLICT DO NOTHING` silently discarded a DIVERGENT re-emit and logged `status: "ok"`; divergence is now read back and logged `outcome: "divergent"` / `status: "error"` without throwing.
- [x] [Review][Patch] The walk opened the CREATING-and-MIGRATING constructor for its digest writer, so a store removed mid-walk was silently recreated and migrated. It now appends through the one inode-verified handle.
- [x] [Review][Patch] `audit-store-corrupt` was unreachable dead code — `bun:sqlite`'s `new Database()` is lazy, so corruption surfaced on the first statement, outside the classifying catch, reaching callers as a bare `SQLiteError` no one could narrow on.
- [x] [Review][Patch] `canonicalJson` flattened `Date` and every `toJSON` carrier to `{}` — silent EVIDENCE LOSS with a digest faithfully attesting to the empty object. Both copies now honour `toJSON`, ordered BEFORE the array branch (they had drifted onto opposite sides, which would have made an array carrying `toJSON` digest differently in each).
- [x] [Review][Patch] `BigInt` and cyclic `detail` escaped as raw `TypeError`s; both are now typed `audit-link-invalid` at the store boundary.
- [x] [Review][Patch] Dispatch's `auditStore?.record(...)` silently swallowed links before the open and threw into a CLOSED handle after it — the two failure modes exactly inverted from the comments. Also: the handle leaked on every provisioning refusal, and the fan-out runs up to 8 dispatches per process.
- [x] [Review][Patch] Single-dash flags were silently DROPPED by the CLI, so `-runs-dir=/fixtures` walked the developer's real `.sandbox/`; repeated flags silently last-won; empty flag values resolved to CWD; `run()` called `process.exit`, making the exit matrix undrivable in-process.
- [x] [Review][Patch] `admittedCeilingBeside` echoed witness bytes into the engine log unsanitized and unbounded — and it is the reader that actually FIRES, shadowing the branch whose sanitisation was documented as protecting this path (INV-RUN-5, pre-existing).
- [x] [Review][Patch] The witness reader degraded SILENTLY to "predates the field" on a structurally malformed witness, never checked its own `requestId` against the invocation's, and aborted an already-paid in-box run on a transient sqlite fault.
- [x] [Review][Patch] `approval-precedes-report` said "before" for the equality case the AC7 tightening introduces, and shared its branch with the unparseable-timestamp case; the latter is now its own `approval-timestamp-unparseable` refusal. The refusal CODE and the `<=` strictness are unchanged.
- [x] [Review][Patch] Audit-store close policy unified across four CLIs (guarded, reported, and feeding the exit decision); `cap-hit-demo`'s unguarded `finally` had been discarding a completed run's result.
- [x] [Review][Patch] `fleet observe` and the fan-out materialised `audit.db` unconditionally, against the file-set discipline `sandbox-reap` states one file over.
- [x] [Review][Patch] Type/contract tidying: `keyHash`/`keyHashPrefix` escaped the exported `HopOutcome` via spread; `RunChain.runId` held a PR URL when hop 1 resolved no run; `earlier`/`later` meant opposite things in hop 8 vs hops 4/5/6; `FillRunAuditOptions.repoSlug` was optional, letting a caller compile a silently `unlinked` hop.

### Patched — test defects (the suites that would not have caught the above)

- [x] [Review][Patch] **The fleet suite was writing REAL rows into the operator's live `.sandbox/audit.db`.** Measured: 3,528 rows, of which 3,502 carry the fixture slug `owner/repo`, co-resident with the 26 rows from the real DF5.3 round. Six suites were offending (not the one named in review), ~1,038 rows per full run. All now isolate `QDS_AUDIT_DB` per test. **The existing debris was NOT touched** — the table has append-only triggers, so pruning means copying the 26 real rows to a fresh store. Operator's call.
- [x] [Review][Patch] `unlinked`, the chain's core failing status, had ZERO positive coverage — mutation-proven that reclassifying it as chain-COMPLETE left the suite green.
- [x] [Review][Patch] `firstDigestMismatch`, the only tamper guard on hops 4/5/6, was unreachable by every fixture — mutation-proven that `return undefined` as its first line broke no test.
- [x] [Review][Patch] The second strict authorization boundary (`decidedAt === pr.createdAt`) was never asserted — mutation-proven that relaxing it to `<=` left the suite green.
- [x] [Review][Patch] Nothing asserted dispatch emits ANY audit link; the `run-box.create` and `run-box.fill` emits were asserted by no test in the repository; `cap-hit-demo`'s ~30 lifecycle tests were audit-blind; the live harness dropped every credential and bundle link the live rounds exist to prove.
- [x] [Review][Patch] Redaction tests asserted against env values the code under test never reads (tautologies passing on empty output); `keyHashPrefix` assertions were prefixes of a full hash the same output already contained; `proc.exitCode ?? 1` converted a CRASHED CLI into the exact value three tests assert.

### False positives — rejected with evidence

- [x] [Review][Dismiss] "Duplicate `revoke`/`verify-revoked` rows on a teardown re-run." The re-emit carries the same `(run_id, hop, event, subject_key)` — `subjectId` is `rec.keyHash`, unchanged — so `ON CONFLICT DO NOTHING` collapses it. A comment now says so at the site.
- [x] [Review][Dismiss] "`createRun` drops `correlation.requestId`." `CreateRunOptions` has no `correlation` field and no call site passes one; the only requestId-ish field is unreachable behind `assertAdmissionNotDelegated`.
- [x] [Review][Dismiss] "The reaper emit abandons the loop." The per-unit `try`/`catch` is INSIDE the loop; the sweep always continued. The double-counting half of that finding was real and was fixed.
- [x] [Review][Dismiss] "`recordAuditLink` is spread after `...seams`, so an injected test seam is overridden." `DispatchDeps` declares no such field; the suggested fix would not compile.
- [x] [Review][Dismiss] "`sha256File` uses the `node:fs` sync trio with no import added" — blind reviewer without repo access; the imports are present.
- [x] [Review][Dismiss] "The reaper fixture should seed a box name distinct from the runId." Structurally impossible: the emit looks the record up BY VM NAME and `readRecord` refuses a record whose `runId` differs from its filename stem. The real half (an unasserted `detail` shape) was fixed.
- [x] [Review][Dismiss] "Assert exactly one captured `run-box.teardown` after both calls." That would red-flag the healing emit, which is emitted unconditionally by design. The real invariant — two emits, ONE row key, equal field-for-field bar timestamps — is pinned instead.

### Deferred

- [x] [Review][Defer] The audit-store WRITER CLIs have no `--audit-db` flag; only the reader got one — deferred to DF5.4-C9, which is the story that needs the frozen fixture. Complete inventory of bare `openAuditStore()` call sites recorded in the review report, including `src/fleet/dispatch.ts`, which a writer-CLI flag alone would not reach.

### Pre-existing / environmental notes

- The `buildIdFileInputs` walked-input digest pin was **already stale on this branch before the review** — verified by re-running against a clean `HEAD` with the working tree stashed. DF5.3 edited Dockerfile-COPY'd inputs and never re-pinned, which would have left `dev` red on merge. No reviewer could see it: the file is not in the PR's diff. Re-pinned last, after the final fixer landed, per the test's own same-commit ritual. It is the FILE-INPUT hash, not the published image digest — no republish is owed and `DEFAULT_IMAGE_REF` is untouched.
- `bun:sqlite`'s `Database.close()` does not release the underlying file descriptor (probed directly on bun 1.4.0, survives `close()`, `close(true)` and `Bun.gc(true)`). The close-on-refusal fix is still correct and necessary; the in-code comment overstates what closing buys in fd terms.
- A dropped `reap` link surfaces only as a log line — `SweepReport` has no non-fatal channel, so a JSON-consuming cron/CI reader cannot see it. Inventing a public shape was out of scope for a review round.
- `sanitizeForMessage` is a control-character escaper, not a redactor. The INV-RUN-5 fix bounds log-forging and unbounded echo; it does not redact a token PREFIX that a JSON parse error quotes. Closing that residual means dropping the parse-error echo entirely.
- Whole-suite runs on a loaded machine produce ~26 spurious 5000ms timeouts (git fixtures, gitnexus CLI spawns). All verified green in isolation. Focal suites: 4,344 pass.

---

## Review Findings — round 3

Adversarial review round 3 on PR #258 — 15 parallel reviewers (6 blind-hunter, 8 edge-case/test,
1 acceptance auditor) over an 11-chunk diff of `origin/dev...HEAD` plus the uncommitted round-3
working tree (13,110 lines; no chunk over 1,524). ~205 raw findings → 112 after dedupe → **93
patched, 6 confirmed false positives, 9 deferred, 7 dismissed**, applied by 11 fix agents over two
waves (source clusters first, then tests, so test-expectation updates saw final behavior). Triage
ledger: `/tmp/pr258/triage.md`; per-cluster write-ups: `/tmp/pr258/fixes/*.md`.

Gates: `bun test` **5,972 pass / 0 fail**; `bunx tsc --noEmit` clean; `bunx biome check` clean;
`detect_changes` → 234 changed symbols, 96 affected processes, **all inside this story's own
modules** (audit hops 4–9 + `walkAuditChain`, dispatch/fanout/destructive fleet verbs, credential
lifecycle, teardown, sweep, `provisionAdmittedRun`, the `qds-audit` CLI). CRITICAL risk level is
the known `provisionAdmittedRun`/`fillRun` hub this story was always going to touch.

### Patched — the load-bearing ones

- [x] [Review][Patch] **A timed-out hop kept running and mutated the walk it had already lost.** `timed`'s `Promise.race` had no cancellation, so an abandoned hop-1 continuation assigned `runId`/`prUrl`/`prEntry`/`boundReport` *after* the `ChainReport` was assembled and could reach `writer.record()` after the walk's `finally` closed the store. On a branch ref that produced a report showing `pr-run: hop-timeout` beside eight `resolved` hops for a run the PR was never shown to be correlated to. Hops now check a liveness flag before any shared-state write, and first-observation rows are queued and flushed once, only for a hop that did not time out. [src/audit/chain.ts]
- [x] [Review][Patch] **Tamper detection for hops 1/7/8 was permanently, silently off.** `authorizingDigest`'s empty `catch {}` swallowed the store's `audit-link-invalid` refusal for any non-canonical stamp — and GitHub's second-precision `extensions.pr.createdAt` is exactly that, so the everyday case wrote NO first-observation row, every later walk found no prior and repeated the failure forever, and an edited `extensions.pr` resolved clean at exit 0. The same catch swallowed `audit-store-identity-changed`, i.e. the store being replaced mid-walk reported as a clean hop. Stamps are now normalised before the write and a store refusal is a typed `broken` hop. [src/audit/chain.ts]
- [x] [Review][Patch] **The ceiling check overwrote the two outcomes that name detected tampering.** The post-hoc guard excluded only `broken` and `hop-timeout`, so a slow hop that found `evidence-mismatch` or `order-violation` had its diagnosis — and its expected/actual digest pair — replaced by a timing label. Inverted: only `resolved` is ever overwritten. [src/audit/chain.ts]
- [x] [Review][Patch] **Per-event `newestOf` ordering reported a false `order-violation` on the lifecycles the code calls lawful.** A re-mint, a re-provision or a re-harvest that repeats a prefix event without repeating its suffix made `newestOf(mint) > newestOf(deliver)` and broke a healthy chain — reintroducing, in the ordering pass, the exact permanent-false-mismatch class the hop-6 comment says the newest-row rule exists to prevent. Replaced with a backwards generation select: a violation is reported only when an event has no instance at or before its successor. [src/audit/chain.ts]
- [x] [Review][Patch] **The write path had no error taxonomy, and its remediation told operators to destroy evidence.** `SqliteAuditStore`'s constructor assigned `this.db` before the `try` that closes it and threw raw driver errors from four unguarded steps (`chmodSync` EPERM, the first PRAGMA on a truncated file, `BEGIN IMMEDIATE` SQLITE_BUSY at up to 8 concurrent fan-out arms on a DELETE-journal whole-file lock, and `prepare` on a drifted schema) — leaking a live handle plus its lock each time. Dispatch then printed the fixed hint *"fix or clear the store path"* for a merely-corrupt store the walk path guards with *"do NOT delete or overwrite — it may still hold recoverable evidence"*, and the destructive advice is the one an operator hits first because it blocks every run. One `try`, handle closed on every path, always a typed `AuditStoreError`; all five composition roots now forward a real `remediation`. [src/audit/link-store.ts, src/fleet/dispatch.ts, scripts/{sandbox-reap,sandbox-teardown,fleet,cap-hit-demo}.ts]
- [x] [Review][Patch] **An audit-store fault made teardown impossible — box billing forever, with the prescribed remedy being the blocked operation.** The revoke emit sits before destroy and propagated, so a full disk aborted teardown with the box live; the re-run took the identical path and failed identically, while the sibling sites' remediation said "tear the run down". Teardown-path emits (`revoke`, `verify-revoked`, `teardown`) now take the reaper's posture — catch, log `providers.audit-link-dropped`, continue. Mint and deliver stay fail-loud; nothing is billing yet at mint. [src/providers/{credentials,teardown}.ts]
- [x] [Review][Patch] **An audit hiccup revoked a key that had been delivered correctly.** `runCredentialLifecycle`'s catch has exactly one interpretation of a throw from `deliverRunKey` — "a minted key must never outlive a failed delivery" — so a transient store refusal from the *emit* destroyed a key sitting correctly in the box and reported the audit error as the delivery failure. Separately, a throwing `mint` emit dropped `res.key` (the only copy of the plaintext) while `mintRunKey` is called OUTSIDE that try, leaving a live spend-capable key with nothing holding it. Both fixed. [src/providers/credentials.ts]
- [x] [Review][Patch] **The ordinary teardown-retry path raised the store's tamper alarm.** The `revoke` link carried `outcome` in its digested `detail`, so a retry after an abort (provider now 404s → `already-gone`) re-emitted the same subject with a different digest and logged `divergent` / `status: "error"`. The delivery-failure compensation added two more. The four credential links' `detail` now depends only on replay-stable facts; `outcome`/`compensation` live on the step log, where they already were. [src/providers/credentials.ts]
- [x] [Review][Patch] **The healing teardown emit wrote a retroactive link (AC3 / INV-AUDIT-4).** `emitAuditLink` hard-coded `occurredAt = now`, so when the original emit never landed the sole surviving row stamped the teardown at re-run time — possibly days late — on the column `linksForRun` sorts by, `firstOrderProblem` compares and AC7's hop-5 constraint is evaluated on. `emitAuditLink` gained an optional `occurredAt`; the healing arm passes `rec.closedAt`, and the arm is now gated on evidence the box is actually gone rather than on `closedAt` alone (a record closed without a destroy used to emit a link vouching for a live box). [src/providers/{driver,teardown}.ts]
- [x] [Review][Patch] **`qds-audit` scored environment faults against the chain.** An absent or corrupt store, an unopenable ledger, a missing `gh`, or a `gh` returning non-JSON all produced a confident `chain: BROKEN` report at exit 1 — a false accusation against the PR under audit, and precisely what the CLI header forbids. The walker now rethrows those as a typed `ChainWalkError("walk-environment-fault")`; exit 1 strictly means walked-and-incomplete. [src/audit/chain.ts, scripts/qds-audit.ts]
- [x] [Review][Patch] **`--json` could truncate silently under exit 0.** Every `writeSync` ignored its short-write return, so a report over the pipe buffer left the DF5.4-C9 harness half a JSON object with a success code — and EPIPE from `| head` turned a COMPLETE chain into exit 2. Routed through the repo's existing drain-until-written helper. [scripts/qds-audit.ts]
- [x] [Review][Patch] **`--help` matched raw argv, so a usage typo exited 0.** `<ref> --ledger --help` (a value flag missing its value) printed help and returned the code that means "a ChainReport was produced and the chain is COMPLETE"; `--json --help` also broke the stdout-is-only-the-report guarantee. Help is now detected after tokenization and goes to stderr under `--json`. [scripts/qds-audit.ts]
- [x] [Review][Patch] **An in-box environment fault killed an already-paid run.** The witness reader treated only ENOENT as absence, so an EACCES/EIO — or a symlinked `run-context.json`, which the hardened reader refuses with no errno at all — escaped to the top-level catch and exited 2 after provisioning, fill and key delivery. Split per the conservative reading: environment faults degrade to a bare session plus a `recorded:false` line; a present-but-malformed correlation keeps the hard refusal, because a forged correlation must not silently become a session row. The degraded-path `startSession` fallback (previously unguarded, and able to write a second session row for the same requestId) is now wrapped. [scripts/pipeline-run.ts]
- [x] [Review][Patch] **INV-RUN-5 did not hold.** `sanitizeForMessage` is a control-character escaper, not a redactor, and `resolveRunCorrelation`'s message ends `(got "…")` — so a token-shaped `repoSlug` under the 200-char cap rode into the engine log verbatim and into DF2.5's harvest tar. Measured, then closed: a new `witnessEcho` = `redactSecrets` → `sanitizeForMessage` → bound, at all 8 witness echo sites. Redaction runs first, because sanitizing first escapes the bytes the redactor matches on. (The round-1 note below recorded this residual as accepted; round 3 closes it.) [scripts/pipeline-run.ts]
- [x] [Review][Patch] **`push.ts` checked timestamp parseability but not canonicality.** `report.completedAt` is validated only as `z.string().min(1)`, and `Date.parse` reads an offsetless stamp as LOCAL time while `decidedAt` is always canonical UTC — so east of UTC the `decided <= completed` guard *admitted* an approval that in fact preceded its report, the exact defeat the AC7 tightening exists to prevent. Both stamps now refuse unless `new Date(x).toISOString() === x`, under their own code. The `<=` strictness and the `approval-precedes-report` code are unchanged; the equality case gained the actionable remediation it lacked. [src/pr/push.ts]
- [x] [Review][Patch] INV-AUDIT-1 was enforced on hop 2 and nowhere else — hops 4/5/6 accepted any row `linksForRun` returned and never compared its `repo_slug` against the record's, so a row appended under a foreign slug for the same runId satisfied them unchallenged and could displace the genuine row. Now a fail-closed `broken`. [src/audit/chain.ts]
- [x] [Review][Patch] The walk could CREATE the store it swears it never creates: the post-inode-check `new Database(path)` opens with create-on-open, so an unlink in that window materialised an empty file the refusal path left on disk — which the next `openAuditStore()` adopted as a legitimately-empty chain (INV-AUDIT-6). Now `{ readwrite: true }`, verified to refuse rather than create. [src/audit/link-store.ts]
- [x] [Review][Patch] `rowToLink`'s bare `JSON.parse` let one malformed row throw an untyped `SyntaxError` that broke SIX hops with an opaque diagnostic — permanently, since the store is append-only and the row can never be removed. Now a typed `audit-store-corrupt` naming the `link_id`, with an inspection command and an explicit do-NOT-delete. `hop` is narrowed against `AUDIT_HOPS` on read instead of blind-cast. [src/audit/link-store.ts]
- [x] [Review][Patch] `SqliteAuditReader.record` mapped every non-typed failure to `audit-store-identity-changed` ("the store this walk verified is gone"), so a 5-second lock contention or a full disk read as evidence tampering and invited the operator to discard an intact chain. Classified properly — and while testing, a real discriminator bug surfaced: the unlinked-inode signature is *not* reliably the readonly-database message (macOS reports a bare `disk I/O error`), so the check is now filesystem-based. [src/audit/link-store.ts]
- [x] [Review][Patch] `HOP_EVENT_VOCABULARY[link.hop]` was a prototype-chain lookup — `hop: "toString"` returned a function, the `undefined` guard missed, and the fail-loud path produced a raw `TypeError` that the catch above then misreported as a replaced store. [src/audit/link-store.ts]
- [x] [Review][Patch] One non-empty predicate (C-3) now guards `runId`, `repoSlug` **and** `requestId` at every emit site. `requestId` was guarded with `=== undefined`, so `""` took the emit arm, hit the store's non-empty check and threw `audit-link-invalid` AFTER the attested action — key minted, key delivered, box created, files landed. `fillRun`'s own comment documented this failure for `repoSlug` and the hardening had been applied to that field only. `FillRunAuditOptions.requestId` is now `string | undefined` so absence is statable rather than forcing a fabricated join key. [src/providers/*.ts, src/fleet/dispatch.ts]
- [x] [Review][Patch] The `repoSlug`-absent skip was silent in four of five emitters, though the doc comment promises a line an operator can grep and names `providers.audit-link-skipped` as the way to find every skip in a run. [src/providers/*.ts]
- [x] [Review][Patch] `cap()` now redacts at the single chokepoint (C-4), so every diagnostic in the walker — record errors, trace errors, ledger errors, the generic hop catch-all, and the box-controlled `sessions`/`gate_results` strings — is redacted, not just `gh` stderr. The module header's claim to be the redaction boundary is now true. [src/audit/chain.ts]
- [x] [Review][Patch] `closeAuditStore()` set `auditStoreClosed = true` even when the store was never opened, so a pre-open refusal degraded the mis-ordered-emit hard error into the silent dropped-link line the comment says the story does not sanction. One-line reorder. [src/fleet/dispatch.ts]
- [x] [Review][Patch] `fleet observe`'s lazy open relocated its failure onto a teardown that had already succeeded — the first open ran from inside `emitTeardownLink`, after destroy, revoke, close and the ledger ingest. Now a reported degradation. Also: `cap-hit-demo` closed the store while its signal handlers were still live (and never unregistered them on the throw path), so a late SIGINT reported a failed cleanup for a teardown that landed. [scripts/{fleet,cap-hit-demo}.ts]
- [x] [Review][Patch] Smaller, all confirmed: the `gh` child leaked when `readBounded` rejected; hop 1's two competing timers made the same input produce two different outcomes; `ghFetchPull` parsed `gh` stdout with no parse or shape guard and ignored its own truncation flag; `msOf` accepted naive-local stamps, making hop 8's ordering host-timezone dependent; the hot-WAL copy order was reversed so a mid-copy checkpoint can no longer lose the rows it exists to recover; `existsSync`→open TOCTOU degraded a lawful post-harvest deletion into "unhandled walk error"; bundle digests compared case-sensitively; `recordBroken`'s `"absent"` arm was unreachable, so a missing record made hop 5 emit a confident false "not provably torn down"; hop 2 required `issueId` to be a `string` while the trace side coerces a number; the store file existed at the umask default between create and `chmod 0600`; `faultOf` matched against a string containing the caller-controlled path; both immutability triggers used `RAISE(ABORT)` (statement-scoped) rather than `ROLLBACK`; `linkExists("<none>")` collided with every subject-less row; the DELETE journal mode was asserted in a comment only; `sha256File` and `emitBundleLink` could fail a bundle verify that had already passed (the latter by calling a helper that *mkdirs* just to build a subject string); and `teardown.ts`'s `deps.requestId` swap had split one teardown's credential step lines across three correlation ids for a laundering risk this PR had already removed.

### False positives — pushed back with evidence

- [x] [Review][Dismiss] "The `=> void` seam silently accepts a Promise-returning binding, so every `try/catch` around `emitAuditLink` is dead code." The only bindings are `SqliteAuditStore.record` / `SqliteAuditReader.record`, both synchronous — `bun:sqlite` is a sync API. No async binding exists or can be introduced without a compile error at the store. Theoretical.
- [x] [Review][Dismiss] "`redactSecrets(x.message ?? e)` hands a raw non-string to a string function from inside a `finally`." Inverted: `redactSecrets(text: unknown)` coerces through a guarded `asText` and wraps its whole body in `try/catch → REDACTED`; it cannot throw. The "correct" siblings the finding pointed at (`String(e)`) are the ones that can. Patching as suggested would have *introduced* the hazard.
- [x] [Review][Dismiss] "`auditCanonicalJson` should drop function/symbol object members to match `JSON.stringify`." Caught by this PR's own drift alarm: `link-store.ts`'s `canonicalJson` renders them as `null` too, and `tests/providers/audit-emit.test.ts` pins that agreement deliberately. Fixing only the `driver.ts` copy manufactures the permanent `evidence-mismatch` on an append-only store that the reviewer was quoting. Reverted with a comment; changing the semantics is a coordinated three-module change, not a one-file fix.
- [x] [Review][Dismiss] "`sandbox-teardown` leaks the store handle on a lock refusal." `acquireRunLock` is inside the guarded region, so every early return already closes it. The *file-set* half of the finding was real and is now stated in the comment.
- [x] [Review][Dismiss] "`LEGACY_RUN_ID_RE` is unanchored or `/g`-flagged, so `qds-audit ../../etc/passwd` escapes `runsDir`." It is `/^[a-z0-9][a-z0-9-]*$/` — anchored, non-global, and its character class cannot emit `/`, `\` or `.`. Neither the traversal nor the stateful-`lastIndex` claim holds. The cross-module drift risk is real, so a local `safeRunId()` guard was added anyway.
- [x] [Review][Dismiss] "`tier1-teardown.live.test.ts`'s `recordAuditLink` wiring is dead." True but not a defect to remove: `revokeAndVerify` is emit-free BY CONSTRUCTION — the one sanctioned no-op sink (INV-AUDIT-4, W14B-3). Replaced with a comment naming the invariant, so the next reader does not assume that path is linked.

### Deferred — recorded, not patched

- [x] [Review][Defer] A read-only walk mode. A 0444 store, a read-only mount, or a copy made per the store's own `audit-store-unreadable` remediation still cannot be walked, because the attach is unconditionally read-write even when the walk appends nothing. The `{ readwrite: true }` change above makes a later `{ readonly: true }` mode a one-flag edit. → DF5.4.
- [x] [Review][Defer] A divergent redelivery is detected, logged `status: "error"` and dropped, so DF5.4's gate — which consumes the store, not stdout — cannot see a contradiction the store exists to expose. Landing it as a companion row needs a new event in the hop vocabulary, which is a contract change this story does not own.
- [x] [Review][Defer] `fillRun`'s subject is the bare vm name, so a second fill collides on the UNIQUE key and hop 5 vouches for a stale `fileCount`. Re-keying `subject_key` retro-invalidates existing rows on an append-only store; production calls `fillRun` once per dispatch. Needs a migration story.
- [x] [Review][Defer] No `PRAGMA user_version` schema-version gate, so an older table is silently adopted by `CREATE TABLE IF NOT EXISTS` (and if it lacks the UNIQUE constraint, dedup and divergence detection go dead). The *safety* half is covered — column drift is now a typed `audit-store-schema-absent` at open, never a raw error at first write.
- [x] [Review][Defer] A `bunfig.toml` `[test] preload` defaulting `QDS_AUDIT_DB` to a per-process temp path, so forgetting `useTempAuditStore()` degrades to a shared temp store rather than the operator's real one. Repo-wide test infra. Every known leak is closed today; the *guard* still has no guard.
- [x] [Review][Defer] The store-side partial unique index on `(run_id, hop)` for the walk-observed event, which would make the INSERT conflict rather than a pre-read the signal for the SINGULAR invariant on hops 1/7/8. The walker half landed: more than one prior is now itself a typed `broken` naming every row, instead of nominating whichever sorted first — which mattered, because `occurredAt` is the subject's own stamp, so a backdated tampered subject sorted first and was reported as the legitimate expectation.
- [x] [Review][Defer] `fleet`'s destructive verbs open the store unconditionally, materialising `audit.db` on an invocation that may record nothing. Documented rather than restructured — and while documenting it the premise was found *false* for unattributed records, which take the C-3 skip door and emit nothing at all. Recorded at the site as accepted residue.
- [x] [Review][Defer] Two `sandbox-reap` behaviours this round introduced have no test anywhere: the typed `audit-store-unreadable` + `next:` line on an unopenable store, and `audit-link-misordered` letting the sweep unit finish. New coverage, not a repair of something this wave broke — flagged rather than silently added or dropped.

### Test-layer findings, patched

- [x] [Review][Patch] **Two more suites were writing real rows into the operator's live `.sandbox/audit.db`** — the same class round 1 found and fixed in six others, re-opened because this PR made two more scripts audit composition roots. `tests/providers/cap-hit-demo.test.ts` spawned `scripts/cap-hit-demo.ts` with `cwd: REPO_ROOT` and no `QDS_AUDIT_DB`, so the child chmodded and ran `BEGIN IMMEDIATE` + a schema exec on the live 1.7 MB store on every run; `tests/providers/teardown.test.ts` inherited an exported `QDS_AUDIT_DB` straight into `sandbox-teardown`, which opens eagerly before it reads any record. Both now use `useTempAuditStore()`, and `cap-hit-demo` was added to that helper's MANDATORY-roots list. Verified after the full gate: the live store's mtime never moved.
- [x] [Review][Patch] **The live-harness audit wiring was asserted by nothing.** `liveAuditLinksFor` had zero callers in any tier test — reverting all six `recordAuditLink` seams to `() => {}` passed the fast suite *and* a full paid live round, which is exactly the defect the harness docblock says the change exists to fix. A TIER-1 test now asserts the links that round actually performed, and the write/read paths are exercised in a temp store without touching a money path.
- [x] [Review][Patch] **The new sealed-store tests failed — not skipped — under root, i.e. in Docker CI**, because `chmodSync(…, 0o500)` does not stop uid 0. Re-induced at a seam that fails for root too (a parent that is a regular file → ENOTDIR).
- [x] [Review][Patch] **The `/tmp` regression test could permanently narrow `/tmp` to 0700 on a root CI container** and never restored it, burying the one assertion that named the real bug under unrelated failures for the rest of the job. `modeBefore` was already captured; it is now restored in the `finally`.
- [x] [Review][Patch] **The build-id pin moved again** — two walked COPY inputs this round (`scripts/pipeline-run.ts`, `src/fleet/dispatch.ts`), measured against the live walk rather than inferred. Re-adopted LAST, on the same tree the close gate ran.
- [x] [Review][Patch] Coverage the reviewers proved absent: `fillRun`'s `audit-link-write-failed` path (the fix this PR makes — the create half was pinned, the fill half was not, so reverting it left the suite green); the `still-listed` revoke arm where the key is **still live** and no `verify-revoked` row may vouch for it; `setup-gate` asserted ABSENT on the gate-failure path; a `record()` throw on an OPEN store mid-dispatch; a `reap` link row (never seeded, so the whole resolved-with-reap branch and the ` <= reap` ordering edge shipped untested); a hop whose promise never settles (every timeout test used a blocking sleep or a faked clock, so "fail-closed" — which is about the hop that *hangs* — was never exercised); a truncated JSONL line from the append-only reverify writer; and the zero-gate-rows boundary.
- [x] [Review][Patch] Assertions that could not fail: the INV-AUDIT-2 log checks asserted only inside a loop over a possibly-empty array; the clone-token check had no positive control, so it passed if the value never reached the report at all; `canonicalJson`'s code-unit key ordering was pinned by no fixture, so a locale-sensitive comparator passed the whole suite — which on an append-only store is a permanent unfixable mismatch between an emitting and a walking host; the emit-side drift alarm never pinned the canonical-UTC stamp format the store *requires*; `expect(auditDb.path()).toContain(…)` was a pure accessor on the helper's own state, leaving the leak guard inert; `occurredAt === recordedAt` at five sites restated one local assigned to both fields; and the concurrency test almost never contended (two cold `bun` starts, no barrier, no assertion that contention occurred) so it passed with `busy_timeout` deleted.
- [x] [Review][Patch] Hygiene with teeth: the file-wide INV-AUDIT-4 sweep asserted *before* cleanup, so one failure leaked the global log sink and every `mkdtemp` git fixture and left the next test re-inspecting stale entries; `spawnAudit` resolved its runtime through `PATH` (the sibling suite uses `process.execPath` precisely so a suite that rewrites `PATH` cannot decide which runtime runs the code under test); the 16-case refusal table was one sequential loop, so the first failure hid fifteen behind minutes of re-spawning; create-path mode assertions were vacuous under a restrictive umask; and the `=` argv grammar — a branch that bypasses the tokenizer's own empty-value refusal — had no coverage at all.

### Pre-existing / environmental notes — round 3

- `sanitizeForMessage` is still a control-character escaper, not a redactor. Round 1 recorded the credential residual as accepted; round 3 measured it (`(got "sk-or-v1-…")` surviving whole under the 200-char cap) and closed it with `witnessEcho`. The round-1 note below is superseded on that point.
- The story's own `Files to Modify` list did not own `scripts/pipeline-run.ts`, though the PR adds 389 lines and three in-box run-aborting refusals to it. A row with an ownership rationale was added rather than reverting the work: hop 2's authority is the run record, never the in-box `sessions` row, so no AC's verdict depends on that plumbing — which is what justifies degrading on an environment fault while still refusing a forged correlation.
- The hot-WAL copy is now ordered `-wal` first, then `.db`, so a checkpoint landing between the two leaves a stale WAL against a newer `.db` that already contains the rows — SQLite ignores it and nothing is lost. A fully atomic snapshot needs a harvest-time change, not a walker one: `VACUUM INTO` needs a connection to the source, and a WAL database with no `-shm` cannot be opened read-only, so taking one would write into the artifacts directory the walk is forbidden to touch.
- `bun:sqlite`'s `Database.close()` still does not release the underlying fd (unchanged from round 1); the close-on-refusal work is correct regardless.
