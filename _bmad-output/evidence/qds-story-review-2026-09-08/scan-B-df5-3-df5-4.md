# Scan B — DF5.3 (Audit Chain Extended) + DF5.4 (Lights-On Exit Gate)

**Wave:** INITIAL SCAN, QDS story-review campaign 2026-09-08
**Reviewer:** adversarial pre-development spec reviewer (dependency-pair B)
**Stories:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-3-audit-chain-extended.md` (4 pts),
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-4-lights-on-gate.md` (3 pts)
**Both last touched:** 2026-08-12. **Nothing was edited by this scan.**

Drift rule applied: *shipped code wins unless the shipped code contradicts the ADR.* Every finding below
was resolved by opening the named file, not by trusting either story's description of it.

Baseline reality established during this scan (all verified by read):

- `src/audit/` **does not exist** — DF5.3 is greenfield for its own modules. Correct, not a defect.
- **DF1.10 (In-Box Phase Engine) and DF1.11 (In-Box Steering Executor) are `done`** (2026-09-06 PR #216;
  2026-09-07/08 PRs #232/#233/#234/#236/#237). The ADR's restoration arc has SHIPPED for the engine.
  Both specs predate this by ~4 weeks and neither names either story.
- **DF3.7 (Approval-Gate Bridge) and DF3.8 (Host-Side Completion Watcher) are `ready-for-dev`.** They own
  the completion → harvest → teardown → reverify chain.
- The trace store now lives **in-box** at tmpfs `/run/trace/trace.db` and reaches the host only inside
  teardown's artifacts tar, extracted to `<runsDir>/<runId>-artifacts` (`src/providers/harvest.ts:1069`).

---

## DF5.3 — Verified-correct elements (SACRED — must not be regressed by later fix waves)

1. **`gate-runner.ts:167-178` VOID convention citation** (`df5-3:18`, `:124-128`) — verified: VOID clauses
   settle up front, `check` is never invoked, `pass:false`, excluded from the verdict.
2. **`gate-runner.ts:324-326` all-void-is-FAIL citation** (`:198`) — verified verbatim:
   `const live = results.filter(r => r.status !== "void"); overall = live.length > 0 && live.every(pass)`.
3. **INV-AUDIT-5 (host-side spine; in-box evidence is a claim)** (`:192-194`) — this is the single most
   ADR-correct paragraph in either story. It is exactly R9's two-layer doctrine
   (ADR `:61-64`), it names the right negative control (resolving hop 7 from in-box gate results MUST
   fail its test), and it pre-dates the ADR by 19 days while agreeing with it. Do not weaken it.
4. **`p1-16-audit-chain-pr.md` line citations** — `:29`/`:30`/`:31`/`:32` (AC1–AC4), `:36`
   (the 8-hop Contracts/Schema line), `:39` (Guards/limits "written at the point of creation, not
   retroactively"), `:51-53` (INV-1..3), `:63` (DoD correlation-keys-at-creation). All resolve to the
   claimed content.
5. **`refs/sandbox/<run-id>` as the bundle landing ref** (`:118`) — verified: harvest's fetch refspec is
   `refs/heads/sbx/${runId}:refs/sandbox/${runId}` (`tests/providers/harvest.test.ts:695`) and the fetch
   lands nowhere else (`harvest.ts:1-20` header, INV-2).
6. **Hop 1's join key** (`:113`) — `extensions.pr` carries exactly `prUrl`/`prNumber`/`createdAt`
   (`run-record.ts:216`), written at creation and never retroactively. DF5.2 owns and documents this
   shape for DF5.3's first hop. Correct.
7. **`key_hash` is a non-secret provider identifier** (INV-AUDIT-2, `:186`) — verified against
   `credentials.ts:249-256`, which persists `keyHash` in the plaintext run record deliberately and puts
   the full hash in a remediation string. Carrying `key_hash` in an audit row is safe.
8. **`SECRET_PREFIXES` / `assertNoSecret` already exist** (`run-record.ts:569,685`) and cover `sk-`,
   `ghp_`, `ghs_`, `gho_`, `ghu_`, `ghr_` with ARRAY RECURSION. INV-AUDIT-2's redaction test has a
   ready-made shared list — reuse it, do not author a second one (the file's own docblock at `:565-568`
   says a second copy is the half that drifts).
9. **The 30 s / 3 s-per-hop budget defence** (`:149-150`) is honest: only hop 1 hits the network.
10. **Hop 10 VOID with a typed `{status,reason}`** (`:65`, `:124-128`) is the right shape and matches
    P0.11's convention. OQ-4 is still BLOCKED-on-env per sprint-status P0.9.

## DF5.3 — Findings

| ID | Sev | Location | Defect |
|---|---|---|---|
| DF5.3-B1 | **BLOCKER** | `df5-3:103`, `:114`, `:121` | Hops 2 and 9 resolve against a trace store that is no longer host-side |
| DF5.3-B2 | **BLOCKER** | `df5-3:42`, `:103`, `:115`, AC5 `:80-82` | Hop 3's "µ$ total + per-role split" is unobtainable — the token bridge is declared-not-wired |
| DF5.3-H1 | HIGH | `df5-3:103`, `:115` | `readRunCost` is a class method, not a module export, and constructing the ledger WRITES |
| DF5.3-H2 | HIGH | `df5-3:92`, `:117`, `:170-173` | Emitter file map points at the wrong files for box lifecycle and reap |
| DF5.3-H3 | HIGH | `df5-3:53-56` | "No exported signature changes" is false — the 4-pt estimate rests on it |
| DF5.3-H4 | HIGH | `df5-3:42`, `:92`, `:116` | There is no "cap" credential event site to hook |
| DF5.3-H5 | HIGH | `df5-3:160` | `requestId` join contradicts shipped code, which names `dispatchRequestId` *in DF5.3's own name* |
| DF5.3-M1 | MEDIUM | `df5-3:102-103` | `<host_data_dir>` exists nowhere in the codebase |
| DF5.3-M2 | MEDIUM | `df5-3:141` | `extensions.fixLoop.fixOutcome` is a `string`, not an object with `.runIds` |
| DF5.3-M3 | MEDIUM | `df5-3:75-76` vs `:60-68`, `:80-85`, `:196-198` | `unlinked` is unclassified — complete or broken? |
| DF5.3-M4 | MEDIUM | `df5-3:60-63` vs `:80-82`, `:122` | AC1's "non-null record with a stable ID" contradicts AC5/hop-10's status objects |
| DF5.3-M5 | MEDIUM | `df5-3:134-135` | `evidence_digest` immutability never covers the three authorizing records |
| DF5.3-M6 | MEDIUM | `df5-3:41`, `:91` | `qds audit` is not an invocable command in this repo |
| DF5.3-L1 | LOW | `df5-3:118` | Hop 6's "verification record" does not exist — harvest writes nothing to the run record |
| DF5.3-L2 | LOW | `df5-3:50` | Dependency edges omit DF1.10 / DF1.11 |

---

### DF5.3-B1 — BLOCKER — Hops 2 and 9 resolve against a trace store that is no longer host-side

**Location:** `df5-3-audit-chain-extended.md:103` (Infra Prerequisites row 2), `:114` (hop 2), `:121` (hop 9).

**Defect.** The Infra row names *"DF1.4 trace session | `src/phase-engine/trace/`"* and asserts *"all three
resolvable by runId at walk time, and an unreadable record is a named broken hop."* `src/phase-engine/trace/`
is a **source module directory**, not a store — it holds `schema.ts`, `tracer.ts`, `reader.ts`,
`migrations.ts`, `pragmas.ts`, `journal-bridge.ts`. Since DF1.10 merged (2026-09-06), the actual trace DB is
written **inside the box** at tmpfs `/run/trace/trace.db` (`df1-10:126-128`: *"tmpfs `/run`: … `trace/{trace.db,events.jsonl}` at 0700"*)
and reaches the host **only** through teardown's artifacts tar, extracted to
`join(runsDir, `${runId}-artifacts`)` (`src/providers/harvest.ts:1069`). Two further mismatches the story
does not survive: the `sessions` table is keyed on `request_id` (`src/phase-engine/trace/schema.ts:34-35`,
PRIMARY KEY `request_id`), **not** on `run_id`, so "resolvable by runId" requires an unstated
runId→requestId hop through the run record's `requestId` core field (`run-record.ts:132-142`); and hop 9's
`gate_results` rows (`schema.ts:84-93`) are likewise in that harvested DB.

**Failure scenario.** A lights-on run completes in-box and opens a PR. Teardown's artifacts step is
**deliberately non-fatal** so revoke+destroy always run — `teardown.ts:283-286` literally logs *"the
artifacts pull failed and teardown CONTINUED to revoke+destroy on purpose … This run's artifact bundle is
lost."* The box is destroyed. Alternatively the box reboots before harvest and tmpfs `/run/trace` is wiped
(ADR `:81-82`, measured: *"`/run` is tmpfs and **a reboot wipes `/run/steering`**"*). Either way hops 2 and 9
are permanently unresolvable. Per INV-AUDIT-6 the walker exits non-zero and names a broken hop — so
`qds audit` reports a forged/broken chain for a run that genuinely succeeded, and DF5.4-C9 goes red with it.
The operator has no way to tell "this chain was never emitted" from "the evidence was legitimately lost at
the harvest boundary".

**Fix recipe.** Replace the Infra Prerequisites row-2 first cell and third cell:

> | DF2.8 cost ledger `.sandbox/cost-ledger.db` (`DEFAULT_COST_LEDGER_FILE`, overridable by `QDS_COST_LEDGER_FILE`) · DF1.4 **harvested** trace DB · DF2.1 run record | host `bun:sqlite` store · `<runsDir>/<runId>-artifacts/…/trace.db` (pulled out of the box by DF2.5's `pullArtifacts`, `harvest.ts:1069`) · `<runsDir>/<runId>.json` via `resolveRunsDir()` | the cost hop constructs `new CostLedger({ path })` and calls its `readRunCost(runId)` method (`cost-ledger.ts:1335`) — run-keyed, never `readIssueCost`, never a second SUM. **The trace DB is an artefact of a completed harvest, not a live host store: hops 2 and 9 first resolve `runId → record.requestId` (`run-record.ts:132`), then join the trace DB on `request_id`.** A run whose artifacts pull failed (`teardown.ts:283-286`, non-fatal by design) or whose box rebooted before harvest (ADR `:81-82`) resolves hops 2 and 9 as `{ status: "evidence-not-harvested", reason, evidencePath }` — a *named, typed* outcome distinct from a broken hop, because the loss is a recorded teardown outcome, not a missing link. |

Add a new AC (renumber the rest):

> 6. Given a run whose artifacts pull failed (the non-fatal teardown arm, `teardown.ts:283-286`) or whose
>    box rebooted before harvest, When the walker resolves hops 2 and 9, Then each resolves to
>    `{ status: "evidence-not-harvested", reason, evidencePath }` naming the expected
>    `<runsDir>/<runId>-artifacts` path, the chain is reported **incomplete with a named cause and a
>    non-zero exit** — never complete, and never as a generic broken hop that reads as a missing link.
>    *Negative control: an implementation that reports these two hops identically to a never-emitted link
>    MUST fail this AC.*

Add `DF1.10` to the dependency edge line at `:50`.

---

### DF5.3-B2 — BLOCKER — Hop 3's per-role split is unobtainable; the token bridge is declared, not wired

**Location:** `df5-3:42` (E2E slice, *"run→cost (a µ$ total plus per-role split)"*), `:103`, `:115`,
AC5 `:80-82`, DoD `:217-218`.

**Defect.** `CostLedger.ingestCostEvent` is the **only** writer of `kind='tokens'` rows and has **zero
callers outside `tests/`**. Its own docblock says so (`src/providers/cost-ledger.ts:961-975`): *"the ONLY
writer of `kind='tokens'` rows, and (F001) a writer with no caller outside `tests/`. The DF2.7 `CostEvent`s
that `cli-anything/src/runner.ts` produces are consumed by that runner's own in-process budget guard and are
never handed to this method."* `TECH_DEBT_AUDIT.md:212` (F001) records this as **Critical**, closed only to
the extent of making the gap loud (`emitTokenBridgeState()`), with the residual explicitly open: *"the
bridge is **declared, not wired** … Token spend still sits outside every per-issue cap"* — deferred to
issue **#157**. Consequently a completed run's ledger contains **only `box_hours` rows**, and
`readRunCost(runId).perRole` is `{ "box-hours": N }` (`cost-ledger.ts:720-726`: *"box-hours surface under
the literal `\"box-hours\"` key"*). **There is no per-role split to report.**

AC5 (`:80-82`) then gets the world exactly backwards: it posits *"a run with no `box_hours` row because the
box never reached `execute`, so hop 3's cost total carries token spend only."* The shipped system produces
the mirror image and only the mirror image — box-hours and nothing else. The AC's worked example is
unproducible, so the AC is untestable against a real run.

**Failure scenario.** Dev implements hop 3 faithfully. The mandatory e2e (`:226-227`, *"a µ$ cost total"*)
runs against a real merged factory PR. `readRunCost` returns `{ totalMicroUsd: <box hours>, perRole: { "box-hours": N }, hasTokenRows: false }`.
The dev either (a) declares the per-role split satisfied by a single `box-hours` key — the demo prints a
"per-role split" with no roles in it, and the DoD item is signed off on a vacuous surface; or (b) writes the
AC5 fixture by hand-inserting `tokens` rows no production path can write, pinning a shape production cannot
produce — the exact fixture escape DF3.4's live round caught (sprint-status DF3.4: *"The escape was the
FIXTURES — `pausedRec()` never set `closedAt`, testing a shape production cannot produce"*).

**Fix recipe.** Rewrite the hop-3 table cell (`:115`) and AC5's worked example. Replacement for `:115`:

> | 3 | run → cost | `new CostLedger({path}).readRunCost(runId)` — µ$ total plus the `perRole` map, keyed by run, not issue. **Until the DF2.7→ledger token bridge is wired (F001 / issue #157), the only rows a production run writes are `kind='box_hours'`, so `perRole` legitimately contains the single literal key `"box-hours"` and `hasTokenRows` is `false`.** The hop reports `perRole` verbatim and additionally surfaces `hasTokenRows`; it never asserts a multi-role split, and it never reads `hasEvents:false` as "spent nothing" (`cost-ledger.ts:727-740`). | DF2.8 |

Replacement for AC5's worked example (`:80-82`):

> 5. Given a healthy run where a hop is legitimately absent — a run whose ledger carries no `tokens` rows
>    because the DF2.7→ledger bridge is unwired (F001, issue #157), so hop 3's `perRole` holds the single
>    `"box-hours"` key and `hasTokenRows` is `false` — Then the hop resolves with that shape and the chain
>    is complete; a `readRunCost` returning `hasEvents: false` (no rows at all) is a **broken** hop, not a
>    zero-spend one. …

Then delete *"a µ$ total plus per-role split"* from the E2E slice (`:42`) and DoD (`:218`), replacing both
with *"a µ$ total and the `perRole` map as the ledger actually holds it"*.

---

### DF5.3-H1 — HIGH — `readRunCost` is a class method, and constructing the ledger writes

**Location:** `df5-3:103`, `:115` (*"DF2.8's **exported** `readRunCost(runId)`"*).

**Defect.** `grep "^export" src/providers/cost-ledger.ts` shows no `export function readRunCost`. It is a
**method** on `class CostLedger` (`cost-ledger.ts:1335`), reachable only by constructing one. The
constructor (`cost-ledger.ts:874-935`) performs, in order: `mkdirSync(dir, { recursive: true, mode: 0o700 })`,
`chmodSync(dir, 0o700)`, `new Database(this.path)` (**creates the file when absent**),
`chmodSync(this.path, 0o600)` when new, `db.exec("PRAGMA journal_mode = WAL;")` (creates `-wal`/`-shm`), and
`db.exec(SCHEMA)`. There is **no read-only open path**. DF5.3's Guards/limits (`:151`) claims *"the walker
opens every store read-only, writing nothing outside `audit_links`"* — false for the cost hop as specified.

**Failure scenario.** Operator runs `qds audit <pr-url>` from a checkout with no `.sandbox/cost-ledger.db`.
Hop 3 creates the ledger, applies the schema, and reports `hasEvents:false`. The walk then either calls
that a zero-spend run (INV-COST-6's exact prohibition) or a broken hop — while having silently created a
store the operator will later ingest real money into, whose provenance is a read-only audit tool.

**Fix recipe.** In `:103` replace *"the cost hop calls DF2.8's exported `readRunCost(runId)`"* with:

> the cost hop constructs `new CostLedger({ path })` and calls its `readRunCost(runId)` **method**
> (`cost-ledger.ts:1335`) — DF2.8 exports the class, not a free function. **The constructor is not
> read-only** (`cost-ledger.ts:886-931`: `mkdirSync` 0700, creates the DB when absent, `chmodSync` 0600,
> `PRAGMA journal_mode = WAL`, `db.exec(SCHEMA)`), so the walker asserts `existsSync(ledgerPath)` **before**
> constructing and resolves hop 3 as a named broken hop when the ledger is absent — it never lets the read
> path create the store it is auditing.

And amend Guards/limits (`:151`) to: *"the walker opens the trace DB and every JSON record read-only and
writes nothing outside `audit_links`; the cost ledger is the one store whose library has no read-only open
path, so its existence is asserted before construction (see Infra Prerequisites)."*

---

### DF5.3-H2 — HIGH — The emitter file map points at the wrong files

**Location:** `df5-3:92` (Trigger Surface), `:117` (hop 5 origin), `:170-173` + `:211-212` (Files to Modify / DoD).

**Defect.** Two of the four named emitter files do not own the events attributed to them.

- **`src/providers/run-record.ts` (create/fill/setup/execute/observe transitions)** — `RunRecordStore`
  exposes only `path`, `lockPath`, `create`, `get`, `set`, `close`, `list`, `listWithAnomalies`
  (`run-record.ts:1465,1481,1486,1604,1614,1653,1687,1723`). The box lifecycle verbs are
  `createRun` (`driver.ts:905`), `fillRun` (`:935`), `setupRun` (`:1066`), `executeRun` (`:1076`),
  `observeRun` (`:1086`) — all in **`src/providers/driver.ts`**, plus `provisionAdmittedRun`
  (`driver.ts:549`) which composes them.
- **`teardown.ts` (teardown/reap)** — `teardown.ts` exports `teardownSandbox` (`:463`) and nothing named
  reap. Reap is `sweep()` in **`src/providers/reaper.ts:391`**.

**Failure scenario.** Dev follows Files to Modify literally, hooks `recordAuditLink` into `RunRecordStore.set`
because that is the only transition-shaped method in the named file, and emits one undifferentiated link per
field write — an audit trail with no lifecycle verbs in it. Hop 5's join
(`create→fill→setup→execute→observe→teardown→reap`) then has nothing to resolve, and `reap` has no emitter
at all. Under DF5.3-M3's unresolved `unlinked` semantics this can walk green.

**Fix recipe.** Replace Trigger Surface row 2 (`:92`):

> | `recordAuditLink` called from each event's own emitter: DF2.3 `credentials.ts` (mint/deliver/revoke/verify-revoked), DF2.1 `driver.ts` (`createRun`/`fillRun`/`setupRun`/`executeRun`/`observeRun`, `driver.ts:905,935,1066,1076,1086`), DF2.5 `harvest.ts` (bundle verify + fetch) and `teardown.ts` (`teardownSandbox`, `:463`), DF2.6 `reaper.ts` (`sweep`, `:391`) | in-scope | `tests/audit/link-store.test.ts` | — |

Files to Modify: replace `src/providers/run-record.ts` with `src/providers/driver.ts` and **add**
`src/providers/reaper.ts`. Update the DoD Integration item (`:211-212`) to the same list. Add DF2.6 to the
dependency edges at `:50`.

---

### DF5.3-H3 — HIGH — "No exported signature changes" is false, and it is load-bearing for the estimate

**Location:** `df5-3:53-56` (the Scope note).

**Defect.** The scope note reads: *"every edit to `credentials.ts`, `run-record.ts`, `harvest.ts` and
`teardown.ts` is a single-line `recordAuditLink(...)` emit at an existing event site. No logic, control flow
or exported signature in those files changes, so there is no double-implementation risk with their owning
stories — only a merge-order dependency."* This is the argument for a 4-point estimate against four
foreign-owned files, and it does not hold. Every one of those modules is written against an injected deps
object — `CredentialDeps` (`credentials.ts:144`), `HarvestDeps`, `TeardownDeps` (`teardown.ts:94`),
`SweepDeps` (`reaper.ts:140`) — precisely so `src/providers/*` takes no ambient dependencies. A
`recordAuditLink` call has exactly two shapes, and both violate the note:

(a) hard-import `src/audit/link-store.ts` into `src/providers/*`, inverting the dependency direction the
repo deliberately established with `src/providers/viz-guard.ts` (added in DF4.2 specifically as a
"provider-seam dependency inversion", per sprint-status DF4.2); or
(b) add an optional `recordAuditLink?:` seam field to each `*Deps` interface — which **is** an exported
signature change to four foreign-owned exported interfaces, and requires threading the seam through every
call site and every fake in `tests/providers/`.

Option (b) also creates a silent-failure surface the story never addresses: an unwired optional seam means
links are simply not emitted, and DF5.3-M3's undefined `unlinked` semantics then decide whether that walks
green.

**Failure scenario.** The story is estimated and scheduled at 4 points on the strength of this note. Dev
opens `credentials.ts`, discovers the deps pattern, and either takes option (a) — landing an architectural
inversion in a review round that will reject it — or option (b) and spends the sprint threading a seam
through four `*Deps` interfaces, their production call sites in `src/fleet/*` and `scripts/fleet.ts`, and
every fake, on a story budgeted for "single-line emits".

**Fix recipe.** Replace `:53-56` with:

> *Scope note on the shared files: each edit adds one `recordAuditLink(...)` emit at an existing event site,
> **plus one optional seam field per deps interface** — `recordAuditLink?: (link: AuditLink) => void` on
> `CredentialDeps` (`credentials.ts:144`), `HarvestDeps`, `TeardownDeps` (`teardown.ts:94`) and `SweepDeps`
> (`reaper.ts:140`). The seam, not a direct import, is mandatory: `src/providers/*` takes no ambient
> dependencies, and importing `src/audit/*` there would invert the direction DF4.2 established with
> `src/providers/viz-guard.ts`. No logic or control flow in those files changes and no existing field is
> touched, so there is no double-implementation risk with their owning stories — but the seam widening IS a
> signature change to four foreign-owned exported interfaces, and every production call site and every
> `tests/providers/` fake is threaded in this story. **An unwired seam must be loud, not silent: `recordAuditLink`
> is required (not optional) at the `provisionAdmittedRun`, `teardownSandbox` and `runCredentialLifecycle`
> composition sites, so a caller that forgets it fails to typecheck rather than producing a linkless run.***

Re-point the estimate: 4 → **6** points.

---

### DF5.3-H4 — HIGH — There is no "cap" credential event to hook

**Location:** `df5-3:42` (*"four timestamped rows"*), `:92`, `:116` (*"mint/cap/revoke/verify events"*),
DoD `:211-212`.

**Defect.** `src/providers/credentials.ts` exports six lifecycle functions: `mintRunKey` (`:244`),
`deliverRunKey` (`:514`), `captureSpend` (`:535`), `revokeRunKey` (`:595`), `revokeAndVerify` (`:607`),
`verifyRevoked` (`:652`). **There is no cap operation.** The cap is an *argument to mint*:
`const capMicroUsd = deps.capMicroUsd ?? defaultKeyCapMicroUsd` (`:262`), validated for positivity and
lossless µ$↔USD round-trip (`:263-281`), then passed into the single call
`deps.keyApi.createKey(name, microsToUsd(capMicroUsd))` (`:287`). There is no distinct moment at which a cap
is applied and therefore no event site at which a cap link could be emitted "at the moment of the event"
(AC3, `:73-76`). Meanwhile `deliverRunKey` — the one step that actually moves key material across the
trust boundary into `$HOME/app/.env` — is the event DF5.3 does **not** name.

**Failure scenario.** Dev implements four credential emits and cannot find a cap site. The likely resolution
is to emit two rows from `mintRunKey` (`event:"mint"` and `event:"cap"` with the same `occurred_at`),
manufacturing a link for an event that never happened — which is precisely INV-AUDIT-4's forged-chain
prohibition (*"a chain assembled retroactively is forged"*) arriving through the front door. The
`UNIQUE (run_id, hop, event, …)` constraint will not catch it; the two rows differ on `event`.

**Fix recipe.** Global replace `mint/cap/revoke/verify` with `mint/deliver/revoke/verify-revoked` at `:92`,
`:116` and `:211-212`, and rewrite the E2E slice clause at `:42`:

> run→credential (four timestamped rows — `mint` (`credentials.ts:244`, carrying the applied
> `limitMicroUsd` cap as a **field of the mint row**, since the cap is an argument to mint and not an event
> of its own), `deliver` (`:514`), `revoke` (`:595`), `verify-revoked` (`:652`) — each carrying `key_hash`,
> never key material)

Add to Technical Notes: *"The cap has no event site of its own: `mintRunKey` validates `capMicroUsd`
(`:262-281`) and passes it straight into `createKey` (`:287`). It is recorded as the mint row's
`detail_json.limitMicroUsd`. Emitting a separate `cap` row would manufacture a link for an event that never
occurred — INV-AUDIT-4."*

---

### DF5.3-H5 — HIGH — The `requestId` join contradicts shipped code, in DF5.3's own name

**Location:** `df5-3:160-162` (Observability Contract).

**Defect.** The story says: *"`requestId` propagates from the dispatch that created the run record — DF1.8's
**resolved** value, which every downstream record carries."* The shipped code says the opposite, and names
DF5.3 while doing so. `src/providers/run-record.ts:285-292`, in the `EXTENSION_NAMESPACES.approval`
docblock:

> *"The dispatch id reaches gate events under the key `dispatchRequestId`, NOT `requestId` — this line used
> to say 'carried onto every gate event', which read as a claim about the `requestId` field and is the
> opposite of what the emitters do. `requestId` on a gate event is the EMITTING context's own id (the CLI's
> per-invocation one; the gate's, which is the run's because the gate is a library call), so the two keys
> can hold different values in one stream. **`dispatchRequestId` is the cross-process join, and DF5.3 joins
> on it.**"*

Corroborated at `src/fleet/approval-gate.ts:1157,1185,1209,1225,1342` and `scripts/fleet.ts:3136-3143`
(*"`dispatchRequestId` joins DF5.3 depends on included"*). This correction was written **after** DF5.3 was
authored, precisely because the earlier prose read the way DF5.3 still reads.

**Failure scenario.** Dev implements hop 8 (approval) and hop 9 (gate evidence) by joining the emitted
JSONL/gate event stream on `requestId`. On a run dispatched through `scripts/fleet.ts`, gate events carry
the CLI's per-invocation `requestId`, which is not the run's. The join resolves zero rows → hop 8 or 9 is
reported broken on a healthy run; or, on a host running two concurrent dispatches from one CLI session, it
resolves the **wrong run's** rows and reports a complete chain built from another run's approval. The
second outcome is a false-green audit chain — the worst possible failure for this story.

**Fix recipe.** Replace `:160-162`:

> - `requestId` on the run record (`run-record.ts:132-142`, a core field) is the dispatch correlation id and
>   is the walker's runId→trace-session key (the trace `sessions` table is PK'd on `request_id`,
>   `trace/schema.ts:34-35`). **On gate and approval EVENT streams the cross-process join key is
>   `dispatchRequestId`, NOT `requestId`** — `requestId` there is the emitting context's own id
>   (`run-record.ts:285-292`; `approval-gate.ts:1209,1225`; `scripts/fleet.ts:3136-3143`). Hops 8 and 9 join
>   on `dispatchRequestId`; joining them on `requestId` resolves zero rows on a CLI-dispatched run and can
>   resolve a **foreign** run's rows under concurrent dispatch. *A test asserting hop 8/9 resolution under
>   two concurrent dispatches from one CLI session is mandatory (see DoD).*

Add a DoD item:

> - [ ] **Test (cross-run join negative control):** two runs dispatched from one `scripts/fleet.ts` session;
>       hop 8 and hop 9 of each resolve **only** that run's rows. An implementation joining on `requestId`
>       resolves the CLI's id for both and MUST fail this test.

---

### DF5.3-M1 — MEDIUM — `<host_data_dir>` does not exist

**Location:** `df5-3:102`, `:103`.

`grep -rn "host_data_dir\|hostDataDir" --include=*.ts` returns **zero hits**. The shipped defaults are
`DEFAULT_COST_LEDGER_FILE = ".sandbox/cost-ledger.db"` (`cost-ledger.ts:448`, overridable by
`QDS_COST_LEDGER_FILE`, `:875`) and `DEFAULT_RUNS_DIR = ".sandbox/runs"` via `resolveRunsDir()`
(`run-record.ts:1154,1178`, overridable by `QDS_RUNS_DIR`).

**Failure scenario.** Dev invents a `<host_data_dir>` resolver and places `audit.db` somewhere no other
component looks, then wonders why `cost-ledger.db` is not beside it.

**Fix.** Replace `<host_data_dir>/audit.db` with `.sandbox/audit.db` (resolved through the same
`resolveRunsDir()`-style chain: `QDS_AUDIT_DB ?? .sandbox/audit.db`, dir mode 0700, file 0600 — the
`CostLedger` constructor at `cost-ledger.ts:886-905` is the pattern to copy) and `<host_data_dir>/cost-ledger.db`
with `.sandbox/cost-ledger.db` (`DEFAULT_COST_LEDGER_FILE`, `QDS_COST_LEDGER_FILE`).

---

### DF5.3-M2 — MEDIUM — `extensions.fixLoop.fixOutcome` is a string, not an object

**Location:** `df5-3:141`.

The story says DF6.1 *"reads the parent record's `extensions.fixLoop.fixOutcome.runIds`"*. The registered
namespace is `fixLoop: { schemaVersion: 1, fields: { fixContext: "string", fixOutcome: "string" } }`
(`run-record.ts:216`), and `ExtensionValue = string | number | string[]` (`:151`). `fixOutcome` is a scalar
string; `.runIds` is not a valid field path. **Fix:** *"reads the parent record's `extensions.fixLoop.fixOutcome`
— a `string`-kind field (`run-record.ts:216`) whose JSON payload carries the fix run ids — and adds one key
per fix runId. If DF6.1 needs a first-class array it registers a `strings`-kind field in its own story; this
story registers nothing."*

---

### DF5.3-M3 — MEDIUM — `unlinked` is unclassified: complete or broken?

**Location:** AC3 `:75-76`, against AC1 `:60-68`, AC5 `:80-85`, INV-AUDIT-6 `:196-198`.

AC3 introduces a third hop outcome — *"a run whose links were never emitted resolves those hops as
`unlinked` naming the emitter"* — and nothing in the story says whether an `unlinked` hop makes the chain
complete or broken. AC1 requires every hop to resolve "to a non-null record with a stable ID". AC5
enumerates only `void` and `not-applicable` as complete-compatible. INV-AUDIT-6 says an unresolvable hop is
a named broken hop with a non-zero exit. `unlinked` is none of these three.

**Failure scenario.** DF5.3's emit wave lands in a PR that is merged after the walker (the story itself
admits a merge-order dependency, `:56`). Every run before that merge has no `audit_links` rows. Dev, having
read AC3 as a *tolerated* outcome, returns `unlinked` for hops 4/5/6 and exit 0. `qds audit` prints a
"complete" chain for a run whose credential, box and bundle links were never written — and DF5.4-C9, which
asserts nothing but the exit code (DF5.4-H3), goes green. The lights-on gate then certifies an audit chain
that contains no audit links.

**Fix.** Append to AC3: *"`unlinked` is a **broken** outcome: it fails the chain and exits non-zero, exactly
like an unresolvable hop (INV-AUDIT-6). It is typed separately from a generic broken hop only so the
diagnostic can name the emitter that should have written it. A chain containing any `unlinked` hop is never
reported complete. **Only `void` (hop 10) and `not-applicable` (AC5) are complete-compatible.** Negative
control: an implementation exiting 0 on an `unlinked` hop MUST fail this AC."*

---

### DF5.3-M4 — MEDIUM — AC1's record shape contradicts AC5 and hop 10

**Location:** AC1 `:60-63`, against AC5 `:80-82` and hop 10 `:122-128`.

AC1: *"**all ten hops** … resolve to a non-null record with a stable ID."* AC5 and hop 10 resolve to typed
status objects (`{ status: "not-applicable", reason }`, `{ status: "void", reason }`) that have neither a
record nor an ID. E2E slice `:44` says "zero nulls", which does not disambiguate: a status object is not a
null, but it is also not "a record with a stable ID".

**Fix.** Replace AC1's clause with: *"Then all ten hops resolve to a **typed, non-null hop outcome**: either
a resolved record carrying a stable ID, or one of the two complete-compatible typed statuses —
`{ status: "void", reason }` (hop 10 only) and `{ status: "not-applicable", reason }` (AC5). Any other value
— `null`, `undefined`, an omitted hop, `unlinked` (AC3), or a broken hop (AC2) — fails this AC."*

---

### DF5.3-M5 — MEDIUM — `evidence_digest` never protects the records that actually authorize the PR

**Location:** `:129-135` (Link schema), `:224-225` (DoD immutability test).

`evidence_digest` is a column on `audit_links`, and `recordAuditLink` is only called at the credential, box,
bundle and reap sites — hops 4, 5 and 6. Hops 1, 2, 3, 7, 8, 9 and 10 have **no link row and therefore no
digest**. So DF5.2's `extensions.pr`, DF5.1's `ReverifyReport` and DF3.4's `extensions.approval` — the three
records that actually authorize the PR, and the ones an adversary would edit — are never digest-protected.
The user story's promise (*"a walk over immutable records"*, `:25`) is delivered for the box and the bundle
and withheld for the authorization.

**Failure scenario.** An operator edits `.sandbox/reverify/<run-id>.jsonl` to flip a red verdict to green,
or hand-writes an `extensions.approval` block. `qds audit` walks ten hops, zero nulls, exit 0. The chain
certifies a PR nobody approved and nothing re-verified. `evidence-mismatch` never fires because those hops
have no digest to mismatch.

**Fix.** Add to Technical Notes after `:135`:

> **Digest coverage is asymmetric, and this story closes the gap for the authorizing records.** Only hops 4,
> 5 and 6 have emitted link rows. Hops 7 (DF5.1 `ReverifyReport`), 8 (DF3.4 `extensions.approval`) and 1
> (DF5.2 `extensions.pr`) are the records that *authorize* the PR and are the highest-value tamper targets,
> so the walker emits a **first-observation digest link** for each on its first successful walk
> (`hop`, `subject_id`, `evidence_digest`, `ON CONFLICT DO NOTHING`) and, on every later walk, compares the
> stored digest and reports `evidence-mismatch` on a difference. This is the one write the walker makes and
> it is append-only into `audit_links` — the store the walker already owns (Guards/limits). It is **not** a
> retroactive lifecycle link and does not violate AC3/INV-AUDIT-4: the recorded event is *"the walker
> observed this artefact at this digest at this time"*, which is true at the moment it is written.

Add a DoD item: *"**Test (authorizing-record tamper):** a walk records digests for hops 1, 7 and 8; editing
the `ReverifyReport` verdict and re-walking yields `evidence-mismatch` on hop 7 and a non-zero exit. An
implementation digesting only hops 4–6 passes the happy path and MUST fail this test."*

---

### DF5.3-M6 — MEDIUM — `qds audit` is not an invocable command

**Location:** `:41` (E2E slice), `:91` (Trigger Surface), `:210` (DoD Contract), and DF5.4 `:93`, `:113`.

`package.json` declares **no `bin`** and no `qds` script. Every operator surface in this repo is
`bun scripts/<name>.ts` — `scripts/qds-cost.ts`, `scripts/fleet.ts`, `scripts/open-pr.ts`,
`scripts/reverify.ts`, `bun scripts/phase0-exit-gate.ts`. Files to Modify correctly names
`scripts/qds-audit.ts`; the prose does not.

**Fix.** Replace every `qds audit <ref>` with `bun scripts/qds-audit.ts <ref>` in `:41`, `:91`, `:210`, and
in DF5.4 `:93` and `:113`. If an installed `qds` entry point is wanted, it is a separate story — say so in
the Trigger Surface Follow-Up column.

---

### DF5.3-L1 / DF5.3-L2 — LOW

- **L1** (`:118`) — hop 6's *"verification record"* does not exist. `harvest.ts:18-19`: *"Harvest writes
  NOTHING to the run record: the bundle's presence at `<runsDir>/<run-id>.bundle` is the record, and DF2.1's
  schema stays closed."* Replace with: *"the bundle at `<runsDir>/<runId>.bundle` (`harvest.ts:18-19` — its
  presence IS the record; DF2.1's schema stays closed), this story's own `bundle-verify` link row, and
  `refs/sandbox/<run-id>`."*
- **L2** (`:50`) — dependency edges omit **DF1.10** (hops 2/9 now resolve from harvested in-box evidence)
  and **DF2.6** (reap emitter, per DF5.3-H2). DF1.11 is not needed as an edge — the steering channel is not
  in the hop table.

---

## DF5.4 — Verified-correct elements (SACRED)

1. **Every P0.11 chassis citation is exact.** `GateAssertion:45`, `GateCheckOutcome:39`, `runGate:144`,
   `RunGateOptions:130`, VOID `:167-178`, SKIP-is-not-a-pass `:211-212`, no-live-assertions-is-FAIL
   `:324-326`, `GateReport:88`, `GateReportSchema:117`, non-blocking-check `:66-68`, required `prd_clause`
   `:51`. All eleven checked against `src/gate/gate-runner.ts` — all correct. This is the best-cited section
   in either story.
2. **`tests/gate/phase0-exit-gate.test.ts` has exactly 45 `test(` cases** at the suite indent. The "45
   cases" figure (`:18`, `:91`) is right.
3. **`scripts/phase0-exit-gate.ts` is a faithful template** for what `:199-200` describes: clause-map header
   (`:10-22`), `parseValueFlags` for `--report`/`--help` (`:80-86`), `buildAssertions()` with
   `GateAssertionSchema` validation and duplicate-id rejection (`:90-120`), rendered table (`:129-154`),
   terminal `PHASE_0_GATE: PASS|FAIL` (`:152`), exit 0/1 via `process.exitCode` and 2 on fatal (`:166,:174`).
4. **The pure-auditor pattern exists at `src/gate/assertions/p0-3-mixed-model.ts`** — `MixedModelAudit:42`,
   `auditMixedModelRun:56`, `mixedModelAssertions:89`. The `:142-145` prescription is real, not aspirational.
5. **`src/gate/assertions/lib/verdict.ts` is genuinely additive-extensible** (51 lines,
   `checkRequiredAcs` + `isOutcome`), and its own docblock argues for hoisting shared logic there rather
   than copying per module — exactly what `:143-145` asks. Correct.
6. **The budget arithmetic holds.** 11 live clauses = 1 preflight + 10 main; 10 main at concurrency 4 = 3
   pool waves; 4 × 60 s = 240 s inside a 300 s total. The chassis's total-budget expiry marks unsettled
   assertions `fail` while leaving VOID clauses settled (`gate-runner.ts:159-161,291-301`), so the margin
   claim is sound.
7. **C6's clock discipline is exactly right and is corroborated by shipped code.**
   `run-record.ts:186-215` (the `pr` namespace docblock) says verbatim that `createdAt` is a HOST stamp,
   *"never GitHub's `created_at`, whose server clock is not comparable"*, and that *"DF5.4-C6 orders
   re-verify-precedes-PR by comparing host clocks only"*. It also documents that on the two adopt paths
   `createdAt` is a FIRST-OBSERVATION time — later than true creation, i.e. **conservative for C6**. INV-GATE-4's
   negative control (`:188-190`) is correctly specified.
8. **C8's shape-not-mapping contract is right.** DF5.2 AC2 emits `Issue: unresolved` rather than omitting
   the line specifically so C8 is assertable (`df5-2:75`). P1.3 is out of the v5 slate. Correct.
9. **`.sandbox/reverify/<run-id>.jsonl`** (`:92`) — verified: `src/reverify/report.ts:10` and `:313`
   (`join(dir, \`${runId}.jsonl\`)`), `scripts/reverify.ts:9`.
10. **`refs/sandbox/<run-id>`** (`:92`, C5) — verified, as for DF5.3.
11. **`ReverifyReport.completedAt`** (`:110`, `:119`) — verified: `src/reverify/report.ts:139-148`
    (`reverifyId`, `headSha`, `completedAt` all present on the exported interface).
12. **All `p1-17-phase1-exit-gate.md` citations resolve**: `:30` (per-clause FAIL with assertion id /
    expected / actual / diagnostic), `:31` (determinism), `:35` (G4 non-mutating read-only pattern),
    `:38` (5-min total / 60 s per assertion / read-only), `:48-50` (INV-1..3).
13. **The P0.11 edge is coherent despite the gate's FAIL verdict.** sprint-status P0.11 is `status: done`
    with `PHASE_0_GATE: FAIL (7 pass / 2 fail / 1 skip / 2 void)`; P1.1-R5-3 already ruled the gate
    *"DELIVERED BUT NON-BLOCKING … the red verdict does not hold P1.1"*. DF5.4 reuses the **runner**, never
    P0.11's clause set, and never edits `gate-runner.ts` (`:51`). The dependency is sound. (One LOW below
    asks the story to say this explicitly.)

## DF5.4 — Findings

| ID | Sev | Location | Defect |
|---|---|---|---|
| DF5.4-B1 | **BLOCKER** | `df5-4:92` | `.sandbox/approvals/<id>.json` does not exist — approval lives in `extensions.approval` |
| DF5.4-B2 | **BLOCKER** | `df5-4:107`, `:108` vs `:186-190` | C3 and C4 assert in-box claims as proof, contradicting INV-GATE-4 and the ADR |
| DF5.4-B3 | **BLOCKER** | `df5-4:93`, `:114`, `:175-177`, `:207` | C10 writes: `new CostLedger()` creates dir + DB + schema. INV-GATE-1 is false as specified |
| DF5.4-H1 | HIGH | `df5-4:46-47` vs `:72-73`, `:193`, `:219-221` | E2E slice and the mandatory DoD e2e contradict AC4/INV-GATE-5 on fail-vs-skip |
| DF5.4-H2 | HIGH | `df5-4:93`, `:114`, `:126`, `:205` | `readRunCost` is a class method, not an export (mirror of DF5.3-H1) |
| DF5.4-H3 | HIGH | `df5-4:93`, `:113` | C9 asserts only an exit code — it pins nothing about the ten hops |
| DF5.4-H4 | HIGH | `df5-4:53-57` | Dependency edges omit DF1.10, DF1.11, DF2.5-direct, DF3.7, DF3.8 |
| DF5.4-H5 | HIGH | `df5-4:42`, `:92`, `:147-148`, `:171` | "The lights-on run of record" has no producer and is not producible today |
| DF5.4-M1 | MEDIUM | `df5-4:92`, `:93` | `<host_data_dir>` exists nowhere |
| DF5.4-M2 | MEDIUM | `df5-4:105` | C1 names no evidence path — unfalsifiable, and duplicates P1 |
| DF5.4-M3 | MEDIUM | `df5-4:111` | No clause orders approval `decidedAt` before PR `createdAt` |
| DF5.4-M4 | MEDIUM | `df5-4:106` | C2's "record closed" is satisfied by a paused, never-approved run |
| DF5.4-L1 | LOW | `df5-4:53` | The P0.11 edge should say "chassis reuse, not verdict" in one line |
| DF5.4-L2 | LOW | `df5-4:129-132` | The VOID reason is claimed identical to DF5.3's and is not |

---

### DF5.4-B1 — BLOCKER — `.sandbox/approvals/<id>.json` does not exist

**Location:** `df5-4:92` (Infra Prerequisites, run-of-record path list); consumed by C7 (`:111`) and
transitively by C9.

**Defect.** `grep -rn "sandbox/approvals" --include=*.ts` returns **zero hits**. DF3.4's approval record is
the DF2.1 run record's registered `extensions.approval` namespace (`run-record.ts:296-330`,
`schemaVersion: 2`, fields `state`, `proposal`, `reportId`, `headSha`, `requestId`, `expiresAt`,
`requestedAt`, `supersededReportIds`, `approverId`, `decidedAt`, `reason`, with `retired: { supersededReportId: "supersededReportIds" }`).
DF5.2's own merge record states this in terms (sprint-status DF5.2): *"DF3.4 is still NOT implemented:
approval is read from the DF2.1-registered `extensions.approval` namespace, **not** `.sandbox/approvals/<run-id>.json`."*
So the story names a path that has been known-wrong since 2026-08-26 and was never corrected.

**Failure scenario.** The Infra row's contract is *"every path resolved at gate start; a missing path is
`skip` with the path named — red, never silently green."* Dev implements exactly that. On every run — every
healthy run, forever — `.sandbox/approvals/<runId>.json` is absent, C7 returns `skip` naming a path that
will never exist, and per AC4/`gate-runner.ts:211-212` the gate is red. The lights-on gate can never go
green, and the red names a filesystem path rather than the real defect. Worse, because SKIP is
indistinguishable from a genuinely unreadable approval, the operator loses the one signal C7 exists to give.

**Fix recipe.** In `:92` delete `.sandbox/approvals/<id>.json` from the path list and replace the row's
second cell with:

> `<runsDir>/<runId>.json` (the DF2.1 run record — carries `extensions.approval`, `extensions.pr`,
> `extensions.budget`, `extensions.gate`; `resolveRunsDir()`, `run-record.ts:1178`),
> `.sandbox/reverify/<run-id>.jsonl`, `.sandbox/cost-ledger.db`, `.sandbox/audit.db`, `<runsDir>/<runId>-artifacts/`
> (the harvested in-box evidence), `refs/sandbox/<run-id>`

And rewrite C7 (`:111`):

> | `DF5.4-C7` | main | approval | `extensions.approval` (`run-record.ts:296-330`) carries a terminal
> `state: "approved"` with `approverId` and `decidedAt`, and `decidedAt` is **strictly after** the
> re-verify's `ReverifyReport.completedAt` and **strictly before** `extensions.pr.createdAt` — host clocks
> throughout. There is no `.sandbox/approvals/` file and there never was (DF5.2 merge record); a clause
> reading one can only ever `skip`. (EVIDENCE) | DF3.4 |

Add a DoD test: *"**Test (approval evidence location):** a fixture whose `extensions.approval.state` is
`approved` passes C7; a fixture with an approval-shaped `.sandbox/approvals/<runId>.json` and **no**
`extensions.approval` fails C7. An implementation reading the filesystem path MUST fail this test."*

---

### DF5.4-B2 — BLOCKER — C3 and C4 assert in-box claims as proof, contradicting INV-GATE-4 and the ADR

**Location:** clause map `:107` (C3), `:108` (C4), against INV-GATE-4 `:186-190` and ADR `:61-64`.

**Defect.** INV-GATE-4 is unambiguous: *"every clause asserts against host-side records; in-box trace and
gate results are **claims, not proof** (F10, §6 item 6, R5 §6 fact 15)."* Two of the ten main clauses assert
exactly in-box gate results as pass conditions:

- **C4** — *"phase-engine gate evidence recorded for a pass **and** a fail"*, owner DF1.2/DF1.4.
- **C3** — *"merged envelope validates, NDJSON parsed with zero malformed lines, cost events sum non-zero"*,
  owner DF1.6.

Since DF1.10 merged (2026-09-06, PR #216), the phase engine, its gate evaluation, its envelope handling and
its trace writes **all execute inside the box**. The evidence lands on tmpfs `/run/trace/trace.db` plus ext4
`$HOME` artefacts (`df1-10:126-128`) and reaches the host only inside teardown's artifacts tar, extracted to
`<runsDir>/<runId>-artifacts` (`harvest.ts:1069`). The story was written 2026-08-12 against a host-side
engine; nothing in it acknowledges the move.

This is not a naming slip. It is the ADR's central doctrine collapsing. ADR `:61-64`: *"R9's two-layer
evidence doctrine — R9 exists **because** gates run in-box and emit claims; host re-verify (DF5.1) is the
second, independent layer. Option 1's use of R9 as an argument *for* host-side inverted the doctrine:
moving the first layer host-side collapses both layers into one trust domain."* A lights-on gate that treats
the first layer's output as a green pass condition has done the same collapse from the other end: it makes
the box's own claim about itself sufficient. And it is the more dangerous direction, because the gate's
whole purpose is to be the authority that says the factory is finished.

Note the asymmetry with DF5.3: DF5.3's INV-AUDIT-5 (`:192-194`) gets this **right** — hop 9's in-box trace
rows attach as `evidence: { kind: "claim" }`, *"what the PR asserted; hop 7 earned it."* The two halves of
one contract disagree on the ADR's central rule. See CC-B1.

**Failure scenario.** A box's in-box engine is compromised, or simply buggy: it writes a `gate_results` row
with `passed = 1` for a gate that did not run. DF5.1's host re-verify is not asked about that gate (it re-runs
tests and gates host-side and produces its own `ReverifyReport` — a *different* artefact, asserted by C6).
C4 reads the harvested `gate_results` row, sees `passed = 1` alongside a `passed = 0` row, and returns
`pass`. The gate prints `DF_GATE: PASS`, exit 0, §8 step 6 begins — on the strength of a claim the box made
about itself. Nothing in the eleven clauses ever contradicts it.

**Fix recipe.** Rewrite C3 and C4 as **claim-integrity** clauses and say so in the clause map:

> | `DF5.4-C3` | main | team | the **harvested** merged envelope (`<runsDir>/<runId>-artifacts/…`) is present, parses, and carries zero malformed NDJSON lines — a claim-integrity assertion: it proves the box's claim *arrived intact*, never that its content is true. C6 is what earns the truth. | DF1.6 |
> | `DF5.4-C4` | main | gates | the **harvested** trace DB (`<runsDir>/<runId>-artifacts/…/trace.db`) carries `gate_results` rows for both a pass and a fail, joined on the run record's `requestId` (`trace/schema.ts:84-93`, PK'd on `request_id`) — a claim-integrity assertion under INV-GATE-4: **in-box gate results are claims and can never be the proof that a gate passed.** The proof is C6's host-side re-verify. | DF1.2/DF1.4 |

Extend INV-GATE-4 (`:186-190`) with:

> **C3 and C4 are the two clauses whose subject is an in-box claim, and they are typed as such.** They assert
> that the claim was produced and harvested intact — never that it is true. No clause may be satisfied by an
> in-box artefact standing as proof of its own content (ADR `:61-64`: the two layers must not collapse into
> one trust domain). *An implementation in which a green `gate_results.passed = 1` row can carry C4 to `pass`
> without C6 independently green MUST fail C4's test.*

Add a DoD test:

> - [ ] **Test (two-layer doctrine negative control):** a fixture whose harvested `gate_results` rows are all
>       green but whose DF5.1 `ReverifyReport` is `red` → the gate is FAIL, named on `DF5.4-C6`, and `C4`'s
>       `pass` does not rescue it. An implementation that treats an in-box green as proof of a passed gate
>       returns PASS and MUST fail this test.

Add `DF1.10` to the dependency edges (see DF5.4-H4).

---

### DF5.4-B3 — BLOCKER — C10 writes; INV-GATE-1's "only write is the report file" is false

**Location:** `:93` (Infra row 3, *"`readRunCost` is an in-process read-only call, no subprocess"*),
`:114` (C10), `:175-177` (INV-GATE-1), `:207` (DoD Security).

**Defect.** INV-GATE-1: *"the gate never dispatches a run, provisions a box, mints or revokes a credential,
opens a PR, or writes to a bank or the ledger; **its only write is the report file**."* C10 reaches
`readRunCost` through `class CostLedger`, whose constructor (`src/providers/cost-ledger.ts:874-935`) does,
before any read is possible:

```
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
...
db = new Database(this.path);          // creates the file when absent
if (isNew) chmodSync(this.path, 0o600);
db.exec("PRAGMA journal_mode = WAL;"); // creates -wal and -shm
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(SCHEMA);                       // CREATE TABLE ... on the ledger
```

There is no read-only open path on the class and no free `readRunCost` function to call instead
(DF5.4-H2). So "read-only, in-process, no subprocess" is two-thirds true and the load-bearing third is false.

**Failure scenario.** An operator runs the lights-on gate on a host or checkout where `.sandbox/cost-ledger.db`
is absent — a fresh clone, a relocated `QDS_COST_LEDGER_FILE`, a CI-like sandbox. C10 **creates** the ledger,
chmods its directory to 0700, and writes the DF2.8 schema into it. `readRunCost` then returns
`{ hasEvents: false, totalMicroUsd: 0 }`, C10's "non-zero µ$ total" assertion fails, the gate goes red — so
this is not a false green, and that is the only mercy here. What has happened is that a tool whose single
declared invariant is "I write only my report" has silently created a **money ledger**, and a subsequent
real `ingestBoxHours` now runs against a file whose provenance is a read-only audit gate. INV-GATE-1 as
written would be asserted by a test that passes while the violation happens, because the test will check
"the gate wrote no PR / no bank / no dispatch" and never "the gate created no file".

**Fix recipe.** Rewrite the C10 half of Infra row 3 (`:93`):

> `readRunCost` is a **method on `class CostLedger`** (`cost-ledger.ts:1335`), not a module-level export, and
> **the constructor is not read-only** (`cost-ledger.ts:886-931`: `mkdirSync` 0700, `chmodSync`,
> `new Database()` which CREATES the file when absent, `chmodSync` 0600, `PRAGMA journal_mode = WAL`,
> `db.exec(SCHEMA)`). C10 therefore asserts `existsSync(ledgerPath)` **first** and returns `skip` naming the
> path when it is absent — it never constructs the ledger it is auditing. No subprocess either way.

Amend INV-GATE-1 (`:175-177`):

> **INV-GATE-1 (read-only):** the gate never dispatches a run, provisions a box, mints or revokes a
> credential, opens a PR, or writes to a bank or the ledger (`p1-17:48`); **its only write is the report
> file, and that includes creating no file it merely intended to read.** DF2.8's `CostLedger` constructor
> creates and schema-initialises its database when absent (`cost-ledger.ts:886-931`), so C10 existence-checks
> before constructing. Stateful capabilities are verified through recorded evidence from prior runs.

Amend the DoD Security item (`:206-208`) to:

> - [ ] **Security:** … the gate writes nothing outside the report path (INV-GATE-1) — **asserted by
>       snapshotting the full file list under `.sandbox/` and `<runsDir>` before and after a gate run and
>       requiring byte-identical sets**, not by inspection. An implementation that constructs `CostLedger`
>       against a missing ledger creates `.sandbox/cost-ledger.db`, `-wal` and `-shm` and MUST fail this test.

---

### DF5.4-H1 — HIGH — The E2E slice and the mandatory DoD e2e contradict AC4 and INV-GATE-5

**Location:** `:46-47` (E2E slice) and `:219-221` (DoD MANDATORY e2e), against AC4 `:72-73` and
INV-GATE-5 `:191-193`.

**Defect.** E2E slice: *"**Deleting DF5.1's re-verify record** and re-running prints `DF5.4-C6 … fail`
naming the missing evidence, then `DF_GATE: FAIL`, exit `1`."* AC4: *"Given a clause whose evidence cannot
be read or evaluated, Then it returns **`skip`** with a named reason and the gate is red."* INV-GATE-5:
*"Unreadable evidence yields **`skip`** naming reason and path — red, never green."* A deleted
`.sandbox/reverify/<run-id>.jsonl` is the canonical unreadable-evidence case. The demonstration therefore
demands `fail` for the exact input the ACs demand `skip` for. The mandatory DoD e2e (`:219-221`, *"delete one
evidence file and capture the FAIL report naming that clause"*) inherits it — "FAIL report" is ambiguous
between `overall: "FAIL"` (correct either way) and the clause's own status (contested).

**Failure scenario.** Dev writes C6 to return `{ pass: false }` on a missing file so the mandatory e2e
prints `fail`. That resolver now cannot distinguish "the re-verify never ran" from "the re-verify ran red"
from "the file is there but the JSON is corrupt" — and, because it is the pattern the e2e blessed, it gets
copied into C5, C7, C8, C10. The chassis's deliberate fail/skip distinction (`gate-runner.ts:8-13`,
`:208-215`) — the thing P0.11 exists to preserve, written specifically because *"Phase-0's verification
history is full of probe-passes that were not acceptance"* — is erased across the whole clause set. The gate
is still red, so nothing goes false-green; what is lost is diagnosability, permanently and by construction.

**Fix recipe.** Replace `:46-47`:

> Deleting DF5.1's re-verify record and re-running prints `DF5.4-C6 … skip` naming the missing
> `.sandbox/reverify/<run-id>.jsonl` path (unreadable evidence is `skip`, not `fail` — AC4, INV-GATE-5,
> `gate-runner.ts:208-215`), the gate is **red**, stdout terminates `DF_GATE: FAIL`, exit `1`. Replacing
> that record with one whose `verdict` is `red` prints `DF5.4-C6 … fail` — the distinction the chassis
> exists to keep.

Replace the DoD e2e item (`:219-221`):

> - [ ] **Test (e2e demo — MANDATORY):** run the gate against the recorded lights-on run, capturing the
>       report (eleven `pass`, `DF5.4-V1` `void` with reason, `DF_GATE: PASS`, exit `0`); then **twice**
>       more — once with the re-verify record **deleted** (`DF5.4-C6` `skip`, path named, `DF_GATE: FAIL`,
>       exit `1`) and once with it **present but `red`** (`DF5.4-C6` `fail`, verdict named, `DF_GATE: FAIL`,
>       exit `1`). An implementation collapsing these two into one status MUST fail this item.

---

### DF5.4-H2 — HIGH — `readRunCost` is a class method, not a module export

Mirror of DF5.3-H1, restated at `:93`, `:114`, `:126`, `:205` (*"C10 reads through DF2.8's exported
`readRunCost(runId)`, never a second SUM"*). The "never a second SUM" half is correct and worth keeping. The
"exported" half is wrong: `cost-ledger.ts:1335` is a method on `class CostLedger`. Fix as in DF5.4-B3's
Infra-row replacement; also amend the DoD line at `:205` to *"C10 reads through `new CostLedger({path}).readRunCost(runId)`
(`cost-ledger.ts:1335`), after an existence check, never a second SUM."*

---

### DF5.4-H3 — HIGH — C9 asserts only an exit code

**Location:** `:93` (*"its exit code asserted"*), `:113` (*"`qds audit <pr>` returns a complete chain, exit 0"*).

**Defect.** C9 is the only clause in the set that touches DF5.3's `audit_links` store at all, and it is
specified as a subprocess exit-code check. It pins nothing about the ten hops, nothing about which hops
resolved, nothing about the credential/box/bundle link rows DF5.3 exists to emit. Its truth value is
entirely delegated to DF5.3's own definition of "complete" — which, per DF5.3-M3, is currently undefined for
`unlinked` hops.

**Failure scenario.** DF5.3 ships with `unlinked` treated as a tolerated outcome (DF5.3-M3's live risk, since
nothing in DF5.3 forbids it). `bun scripts/qds-audit.ts <pr>` exits 0 on a run with **no credential link rows
at all**. C9 goes green. No other clause reads `audit_links`. The lights-on gate certifies that the extended
audit chain works, on evidence that the chain is empty. This is the pair's single largest false-green
surface.

**Fix recipe.** Replace C9 (`:113`):

> | `DF5.4-C9` | main | audit | `bun scripts/qds-audit.ts <pr-url>` exits `0` **and** its JSON output is
> parsed by the clause: exactly one contributing-runId key, exactly ten hops under it, **zero** hops with
> status `broken` / `unlinked` / `hop-timeout` / `evidence-mismatch`, hop 10 `void`, and the credential
> (hop 4), box (hop 5) and bundle (hop 6) hops each carrying at least one emitted `audit_links` row id —
> the three hops DF5.3's `recordAuditLink` emitters own and the only ones no other clause covers. The exit
> code alone is not the assertion. | DF5.3 |

Add a DoD test: *"**Test (C9 depth):** a chain whose hop-4 credential links were never emitted → C9 fails,
even when the walker exits 0. An implementation asserting only the exit code passes and MUST fail this test."*
Add `--json` to the `scripts/qds-audit.ts` contract in DF5.3's DoD (`:210`) so C9 has something to parse.

---

### DF5.4-H4 — HIGH — Dependency edges are stale in a load-bearing way

**Location:** `:53-57`.

Declared: **DF5.1, DF5.2, DF5.3, DF3.1, DF3.4, P0.11**, with DF1.2/DF1.4/DF1.6/DF2.1/DF2.2/DF2.5/DF2.8
declared reachable *"transitively through the six direct predecessors"*. Missing:

- **DF1.10** (`done`) — C3 and C4's evidence is produced by the in-box engine it shipped and delivered by the
  harvest path it extended (`df1-10:166`: *"`src/providers/harvest.ts` … **extends only** `artifactsScript`'s
  source set with the absolute in-box paths"*). Without DF1.10 there is no `trace.db` in the tar for C4 to read.
- **DF1.11** (`done`) — steering/ack lifecycle; relevant only if a clause ever asserts the round trip. Optional.
- **DF2.5 as a direct edge** — the transitive-through-DF3.1 claim was true when the engine was host-side and
  the artifacts tar carried only bundle-adjacent files. Post-DF1.10 the tar is the delivery mechanism for
  C3's and C4's evidence, which makes DF2.5's `pullArtifacts` a *direct* dependency of two clauses.
- **DF3.7 and DF3.8** (both `ready-for-dev`) — they own completion-marker polling and the
  harvest → teardown → reverify composition (sprint-status DF3.7, DF3.8). See DF5.4-H5.

**Fix.** Replace `:53-57` with: *"**Dependency edges (predecessors):** DF5.1, DF5.2, DF5.3, DF3.1, DF3.4,
**DF1.10**, **DF2.5**, **DF3.7**, **DF3.8**, P0.11. (DF1.2, DF1.4, DF1.6, DF2.1, DF2.2 and DF2.8 are reached
transitively — the clause map's Owner column, not this line, is the authority on which story owns which
evidence. DF1.10 and DF2.5 are **direct**: since the tier-2 restoration (ADR 2026-08-31, DF1.10 merged
2026-09-06) C3's and C4's evidence is written in-box and reaches the host only via DF2.5's `pullArtifacts`.
DF3.7/DF3.8 are direct because they produce the run of record — see Infra Prerequisites.)"*

Update the sprint-status DF5.4 `deps:` list to match.

---

### DF5.4-H5 — HIGH — "The lights-on run of record" has no producer and is not producible today

**Location:** `:42` (E2E slice), `:92` (Infra row 2), `:147-148` (*"Every clause asserts against the frozen
run of record"*), `:171` (`tests/gate/fixtures/df5-run-of-record.json`).

**Defect.** Every one of the eleven live clauses asserts against "one completed lights-on run's host-side
evidence", and the story never says who produces it, how, or what must have merged first. Today it is not
producible end-to-end:

- **DF3.7** (`--await-completion` polling of the in-box terminal marker) and **DF3.8** (the host-side sweep
  that finds finished-but-unobserved runs) are both `ready-for-dev`. Until DF3.7 lands, reaching the
  approvable pause requires the host to stay connected for the whole run — and DF3.8 exists precisely
  because that contradicts the ADR's product claim that runs survive host disconnect (sprint-status DF3.8).
- **DF3.4's merge record** states REAL teardown wiring at `reverify/runner.ts` is **still owed** as a
  follow-up, and that the resolution was fail-closed (refuse to promote an open record owning a `vmName`
  with no teardown seam) rather than actual wiring.
- The fixture `tests/gate/fixtures/df5-run-of-record.json` is a single JSON file, but the run of record spans
  a run record, a `.jsonl` re-verify log, a SQLite ledger, a SQLite trace DB inside a harvested artifacts
  directory, a git ref, and `audit.db`. One JSON fixture cannot stand in for that, and the story gives no
  fixture-generation procedure.

**Failure scenario.** Dev picks the story up, builds eleven clause resolvers and their unit tests against
`df5-run-of-record.json`, then reaches the MANDATORY e2e (`:219-221`) and discovers there is no run of record
to point it at and no way to make one without DF3.7. The e2e is deferred "until the arc lands"; the story
merges with its make-or-break AC undemonstrated — which is exactly the P0.5/P0.9 pattern that got two
stories downgraded from `done` under issue #51.

**Fix recipe.** Add a fourth Infra Prerequisites row:

> | **Producer of the run of record** | DF3.7 `fleet dispatch --await-completion` (in-box marker poll → harvest → teardown → reverify) or DF3.8's host-side sweep; both `ready-for-dev` as of 2026-09-08 | **This story cannot demonstrate AC1 until DF3.7 has merged.** The run of record is a real completed lights-on run captured once and frozen: run record, `.sandbox/reverify/<id>.jsonl`, `.sandbox/cost-ledger.db`, `.sandbox/audit.db`, `<runsDir>/<runId>-artifacts/` and `refs/sandbox/<run-id>` are copied into `tests/gate/fixtures/df5-run-of-record/` as a **directory**, not a single JSON file, and `--runs-dir`-style seams point the gate at it. Capturing it is a step of this story's e2e, recorded in the Dev Agent Record. |

Change Files to Modify `:171` from `tests/gate/fixtures/df5-run-of-record.json` to
`tests/gate/fixtures/df5-run-of-record/` (directory), and add
`scripts/dev/capture-run-of-record.ts` (the freeze tool). Add the sequencing sentence to the Overview:
*"This is the sprint-3 exit gate for the whole DF backlog and is scheduled **last** — after DF3.7 and DF3.8,
which produce the run it asserts against."*

---

### DF5.4-M1 — MEDIUM — `<host_data_dir>` does not exist

`:92`, `:93`. Same as DF5.3-M1: zero hits in the codebase. Replace with `.sandbox/cost-ledger.db`
(`DEFAULT_COST_LEDGER_FILE`, `cost-ledger.ts:448`) and `.sandbox/audit.db`.

---

### DF5.4-M2 — MEDIUM — C1 names no evidence and duplicates the preflight

**Location:** `:104` (P1), `:105` (C1).

C1: *"dispatch entered via the operator CLI with a schema-validated brief and a returned runId (DD-1)"*,
owner DF3.1. The brief is validated in-process at dispatch time (`src/fleet/brief-schema.ts`); nothing
durable records *"the brief validated"*. Meanwhile P1 already asserts *"the run of record exists, is
readable, names a runId."*

**Failure scenario.** A broken implementation of C1 that checks only `record.runId !== undefined` passes —
and that is verbatim what P1 already checks. C1 contributes nothing, and the DoD's mutant test
(`:209-210`, "red on a mutant with the asserted field removed") passes trivially because removing `runId`
also breaks P1. The gate reports eleven green clauses of which one is a tautology.

**Fix recipe.** Either name a durable artefact or convert C1 to something falsifiable. Recommended
replacement for `:105`:

> | `DF5.4-C1` | main | channel | the run record carries a `requestId` (`run-record.ts:132-142`) and an
> `extensions.budget` block with `repoSlug`, `issueId` and a non-zero `admittedCeilingMicroUsd`
> (`run-record.ts:219-234`) — the durable evidence that dispatch went through DF3.1's operator CLI and
> DF2.8's admission gate rather than being hand-created. A record with a `runId` and no `extensions.budget`
> fails: a run nothing admitted is a run nothing capped. | DF3.1/DF2.8 |

If the brief itself must be asserted, DF3.1 has to persist a brief digest — that is a DF3.1 change and does
not belong in this story; record it as a Deviation instead of inventing evidence.

---

### DF5.4-M3 — MEDIUM — No clause orders approval before the PR

**Location:** `:110` (C6), `:111` (C7).

C6 orders `ReverifyReport.completedAt` < `extensions.pr.createdAt`. C7 orders `decidedAt` >
`completedAt`. **Nothing orders `decidedAt` < `createdAt`.**

**Failure scenario.** A run whose approval was recorded *after* the PR opened satisfies both clauses:
`completedAt` < `createdAt` (C6 green) and `decidedAt` > `completedAt` (C7 green), with
`decidedAt` > `createdAt`. That is a PR opened before anyone approved it — the precise violation of DF5.2's
INV-PR-5 that DF5.3 AC5 (`:83-85`) leans on (*"no PR exists without an approval"*). The lights-on gate
would certify it.

**Fix.** Already folded into the C7 replacement in DF5.4-B1: add *"and **strictly before**
`extensions.pr.createdAt`"*. Add a DoD test: *"**Test (approval-precedes-PR ordering):** a fixture whose
`decidedAt` falls after `extensions.pr.createdAt` → C7 fails, even though C6 is green."*

---

### DF5.4-M4 — MEDIUM — C2's "record closed" is satisfied by a paused, never-approved run

**Location:** `:106`.

C2 requires *"record closed with `spendMicroUsd`"*. DF3.4's merge record documents that **a paused record IS
closed**: *"a paused record IS closed (teardown sets `closedAt` before the promote), so the AC7 branch
sitting after the `closedAt` check was unreachable and `fleet status` reported `closed`."* So `closedAt !== undefined`
is true of a run that paused at the approval gate and was never approved, never re-verified, never PR'd.

**Failure scenario.** A run of record is captured from a paused-and-abandoned run. C2 goes green on
`closedAt` + `spendMicroUsd`. C6/C7/C8 are the clauses that would catch it — but under DF5.4-H1's current
E2E wording they may `skip`, and under B1 C7 skips regardless. C2 contributes a green to a run that never
finished.

**Fix.** Replace the tail of C2 (`:106`): *"…, record closed (`closedAt`) **with a terminal
`extensions.approval.state` of `approved` — `pausing` and `awaiting-approval` are also closed records
(DF3.4: teardown sets `closedAt` before the promote), so `closedAt` alone does not mean the run finished** —
and a non-zero `spendMicroUsd` (`credentials.ts:535` `captureSpend`)."*

---

### DF5.4-L1 / DF5.4-L2 — LOW

- **L1** (`:53`) — add one clause to the dependency-edge line so a dev does not try to green P0.11 first:
  *"P0.11 is a **chassis-reuse** edge, not a verdict edge: `PHASE_0_GATE` is currently FAIL on upstream
  Phase-0 evidence (sprint-status P0.11) and that verdict does not gate this story, which reuses `runGate`
  and never P0.11's clause set (P1.1-R5-3 precedent)."*
- **L2** (`:129-132`) — the story claims *"It states the same reason as DF5.3's VOID memory hop"*, but the
  two strings differ: DF5.3 `:125-127` carries the parenthetical *"(arm64 libpq/openssl@3; :8888 collides
  with a local Jupyter)"* and DF5.4 does not. Either make them byte-identical or drop the claim. Recommended:
  make DF5.4's string identical to DF5.3's and add a cross-story test asserting equality (cheap, and it is
  the only mechanical guard the pair has against reason-string drift).

---

## Cross-story contract findings (DF5.3 ↔ DF5.4)

### CC-B1 — BLOCKER — The two halves disagree on the ADR's two-layer evidence doctrine

DF5.3 gets it right; DF5.4 gets it wrong. DF5.3's INV-AUDIT-5 (`df5-3:192-194`) types hop 9's in-box trace
rows as `evidence: { kind: "claim" }` and states the negative control explicitly (*"An implementation
resolving hop 7 from the in-box gate results instead of DF5.1's host-side re-verify record MUST fail its
test"*). DF5.4-C4 (`df5-4:108`) asserts precisely those in-box gate results as a **pass condition**, in a
story whose own INV-GATE-4 (`:186-190`) forbids it. One contract, two trust models. Whichever half a dev
reads first determines whether the lights-on gate can be satisfied by a box's claim about itself.

**Fix:** adopt DF5.3's model into DF5.4 via the C3/C4 rewrite in DF5.4-B2, and add the cross-story sentence
to both stories: *"In-box evidence is a claim in both halves of this contract. DF5.3 hop 9 attaches it as
`{ kind: \"claim\" }`; DF5.4-C3/C4 assert its integrity, never its truth. The truth layer is DF5.1's
host-side re-verify — DF5.3 hop 7, DF5.4-C6 (ADR `:61-64`)."*

---

### CC-B2 — BLOCKER — Nothing DF5.3 emits is asserted by anything but an exit code

This is the emitter↔asserter drift the pairing exists to catch.

`recordAuditLink` writes rows for **hops 4, 5 and 6 only** (credential, box lifecycle, bundle). Hops 1, 2, 3,
7, 8, 9, 10 are resolved by joining predecessor records and emit no link. On the asserting side:

| DF5.3 emits | DF5.4 clause that reads `audit_links` |
|---|---|
| hop 4 — credential (mint/deliver/revoke/verify-revoked) | **none** — Trigger Surface `:85` puts the credential path out of scope; C9's exit code only |
| hop 5 — box lifecycle | **none** — C2 reads the *run record*, not the links |
| hop 6 — bundle | **none** — C5 reads `refs/sandbox/<run-id>` and the bundle, not the links |

And in the other direction: **C1** (channel) and **C3** (team envelope) assert stages that have **no hop** in
DF5.3's ten-hop table, which the story nevertheless presents as the complete authorization walk (`:22-25`:
*"every host-side record that authorized it"*).

**Failure scenario.** DF5.3 merges with its four emitters unwired at a composition site (an easy miss under
DF5.3-H3's seam threading, and silently tolerated under DF5.3-M3's undefined `unlinked`). Every subsequent
run has an empty `audit_links` table. DF5.4 runs: C2 green (run record intact), C5 green (bundle and ref
intact), C9 green (walker exits 0 on `unlinked` hops). `DF_GATE: PASS`. The lights-on gate certifies an
audit chain with zero audit links in it, and no clause in the set could have noticed.

**Fix:** (a) the C9 depth rewrite in DF5.4-H3, which makes C9 assert hop-4/5/6 link-row presence; (b)
DF5.3-M3's ruling that `unlinked` is broken; (c) add to DF5.3's Technical Notes a reciprocity paragraph
mirroring the DF6.1 one already there:

> **Reciprocity with DF5.4.** DF5.3 owns the ten-hop table and the three emitted link families (hops 4, 5, 6);
> DF5.4-C9 is the **only** clause that reads `audit_links`, so C9 asserts link-row presence for those three
> hops by name, not merely the walker's exit code. DF5.4-C1 (channel) and C3 (team) assert stages with no hop
> here **by design** — the hop table is the walk from a merged PR back through the records that *authorized*
> it, and dispatch/team execution are upstream of authorization. Neither story adds a hop or a clause without
> the other's row changing in the same PR.

---

### CC-M1 — MEDIUM — DF5.4 asserts an ordering DF5.3's chain cannot express

DF5.4-C6 and C7 assert host-clock ordering (re-verify → approval → PR). DF5.3's `audit_links` schema
(`df5-3:129-133`) carries `occurred_at` and `recorded_at`, and **no AC, DoD item or invariant uses either
for ordering**. The chain's completeness is purely a presence check. So the pair's asserting half believes
causal ordering is what makes an authorization real, and the pair's emitting half — the one whose user story
promises *"the re-verify that earned it, the approval that released it, the key that paid for it"*
(`df5-3:23-25`) — never checks it.

**Failure scenario.** A chain resolves ten hops in causally impossible order: revoke before mint, bundle
verified before the box was filled, approval before re-verify. `qds audit` prints "complete", exit 0. C9
(pre-fix) goes green. Only C6/C7 catch the re-verify/approval half, and nothing at all catches the
credential/box/bundle half.

**Fix.** Add DF5.3 AC6 (renumber after DF5.3-B1's new AC):

> Given a resolved chain, When the walker checks monotonicity, Then within each contributing runId the
> emitted link rows are non-decreasing in `occurred_at` in their lifecycle order — credential
> `mint ≤ deliver ≤ revoke ≤ verify-revoked`, box `create ≤ fill ≤ setup ≤ execute ≤ observe ≤ teardown ≤ reap`,
> bundle `verify ≤ fetch` — and the whole run satisfies
> `reverify.completedAt ≤ approval.decidedAt ≤ pr.createdAt` (the ordering DF5.4-C6/C7 assert, on the same
> host clocks). A violation is a named broken hop `order-violation` with both timestamps and a non-zero
> exit. *Negative control: a chain whose revoke precedes its mint MUST fail this AC; an implementation
> asserting presence only passes and MUST fail.*

---

### CC-M2 — MEDIUM — "The chain is reconstructable" means two different things

DF5.3 defines it operationally (`:60-68`): a map keyed by contributing runId, every hop of every key resolved
to a typed non-null outcome, exit 0 — reconstructable **by the operator, from host-local stores, asserted by
the walker's own ACs**. DF5.4-C9 defines it as *"returns a complete chain, exit 0"* — reconstructable **by
the gate, from a subprocess exit code**. Neither story states who the reconstructor is, what inputs they are
allowed, or what an independent party could verify. P1.16's AC1 (`p1-16:29`) — the source clause both
inherit — said only *"the walker returns a complete chain object with all 8 hops resolved"*, so neither
inherited an answer.

**Fix.** Add one shared definition to both Overviews, verbatim:

> **"Reconstructable" is defined once, for both halves of this contract:** an operator on the host, given
> only a merged PR URL and read access to `.sandbox/` and `refs/sandbox/`, can obtain a ten-hop chain per
> contributing runId in which every hop is a typed non-null outcome, every emitted link row's
> `evidence_digest` still matches its artefact, and the run satisfies
> `reverify.completedAt ≤ approval.decidedAt ≤ pr.createdAt`. No network access beyond the single GitHub PR
> read at hop 1; no in-box access; no re-execution of any underlying action. DF5.3 produces this; DF5.4-C9
> asserts it field by field.

---

### CC-M3 — MEDIUM — Both halves share the same two phantom symbols

`<host_data_dir>` (DF5.3 `:102`, `:103`; DF5.4 `:92`, `:93`) and *"DF2.8's **exported** `readRunCost`"*
(DF5.3 `:103`, `:115`; DF5.4 `:93`, `:114`, `:126`, `:205`). Neither exists. A fix wave that corrects one
story and not the other re-opens exactly the drift this pairing exists to close. **Fix both in the same PR**,
and add the corrected forms to the campaign's verified-correct list so a later wave cannot regress them.

---

### CC-M4 — MEDIUM — The VOID reason strings are claimed identical and are not

DF5.3 `:125-127` vs DF5.4 `:129-131`; DF5.4 `:132` asserts *"It states the same reason as DF5.3's VOID
memory hop."* They differ by the parenthetical *"(arm64 libpq/openssl@3; :8888 collides with a local
Jupyter)"*. No behavioural consequence today, but the claim is false and any test written to it fails.
**Fix:** make them byte-identical (take DF5.3's longer form, which carries the actual OQ-4 diagnosis) and add
a shared-constant note so the string is defined once in code, e.g. `export const OQ4_VOID_REASON` in
`src/audit/index.ts`, imported by `scripts/df5-lights-on-gate.ts`.

---

## Candidate PROPOSED ADR amendments (operator decision — not resolved here)

I found **no case where shipped code contradicts the ADR.** Every drift in this pair is spec-side: the two
stories describe a pre-ADR, host-side world, and the shipped code is ADR-consistent. Two items are worth the
operator's attention anyway, neither as an ADR amendment:

1. **`CostLedger` has no read-only open path** (`src/providers/cost-ledger.ts:874-935`). Any host-side
   verifier that wants to *read* spend must construct — and constructing creates the directory, the DB, the
   WAL files and the schema. The ADR's second evidence layer is supposed to be an *independent* verifier; a
   verifier that mutates the store it verifies is weakly independent. This does not contradict any ADR
   clause, so it is a **code follow-up**, not an amendment: add a `readOnly?: boolean` constructor option
   that opens with SQLite's read-only flag and refuses when the file is absent. DF5.3-H1 and DF5.4-B3 are
   specced to work around its absence; the workaround is correct but the seam is the better fix.
2. **F001 / issue #157 — the DF2.7→ledger token bridge is declared, not wired**
   (`TECH_DEBT_AUDIT.md:212`; `cost-ledger.ts:961-975`). Design §6 item 4 promises *"cost ledger with
   per-run attribution"*; today the ledger has only box-hours attribution and token spend sits outside every
   per-issue cap. DF5.3 hop 3 and DF5.4-C10 are the first two consumers to trip over it. This is a **design-doc
   accuracy** matter and an open issue, not an ADR amendment — but if the operator wants hop 3's per-role
   split to be real, #157 becomes a hard predecessor of DF5.3 and the pair grows by whatever #157 costs.

---

## Structural proposals

1. **Re-point DF5.4 to the end of v5-S3.** It is the sprint-3 exit gate for the whole DF backlog, and its
   run of record cannot exist until DF3.7 and DF3.8 merge (DF5.4-H5). Sequence it after them, explicitly, in
   both the story and `sprint-status.yaml`.
2. **Re-point both stories' dependency edges.** DF5.3 `:50` gains **DF1.10** and **DF2.6**; DF5.4 `:53` gains
   **DF1.10**, **DF2.5** (direct), **DF3.7**, **DF3.8**. Mirror both into `sprint-status.yaml`. Note DF5.5
   (the KEEP-repoint chore) depends on DF5.3 and will need these edges settled first.
3. **Re-estimate DF5.3 from 4 → 6 points.** The "single-line emits, no signature changes" premise that
   justified 4 does not hold (DF5.3-H3): the story threads a new seam through four foreign-owned `*Deps`
   interfaces plus every production call site and fake, and now also owes the harvest-boundary hop semantics
   (DF5.3-B1) and the authorizing-record digest coverage (DF5.3-M5).
4. **Re-estimate DF5.4 from 3 → 5 points.** Three BLOCKERs are structural (approval evidence relocation,
   the C3/C4 doctrine rewrite, the ledger-write invariant), and the run-of-record fixture is a directory
   capture with its own tooling, not a JSON file.
5. **Do not split or merge either story.** The emitter/asserter split is the right seam and both stories are
   coherent units. What they lack is a shared contract paragraph — CC-B2's reciprocity note and CC-M2's
   shared "reconstructable" definition, added to both — which is cheaper and more durable than a merge.
6. **Fix both halves in one PR per cross-story finding.** CC-M3 is the standing hazard: every cross-story
   finding here (CC-B1, CC-B2, CC-M1, CC-M2, CC-M3, CC-M4) touches both files, and a wave that fixes one
   file at a time re-creates the drift this scan exists to close.

---

## Severity counts

| Story | BLOCKER | HIGH | MEDIUM | LOW | Total |
|---|---|---|---|---|---|
| DF5.3 | 2 | 5 | 6 | 2 | 15 |
| DF5.4 | 3 | 5 | 4 | 2 | 14 |
| Cross-story | 2 | 0 | 4 | 0 | 6 |
| **Total** | **7** | **10** | **14** | **4** | **35** |
