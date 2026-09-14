# Seam-ownership table — Unit B: DF5.3 (emitter/walker) + DF5.4 (gate/asserter)

Wave 7 rework artifact. Worklist: `wave6-B-df5-3-df5-4.md`. Seam: `ChainReport` + `OQ4_VOID_REASON`
exported from `src/audit/index.ts` (DF5.3 owns), imported by DF5.4-C9. Verifier's structural verdict:
the four HIGHs are one gap wearing four hats — *DF5.4 declares a frozen, self-contained run of record,
then specifies clauses that reach outside it* (live PR body H3, seam-less walker H2, real `.sandbox/`
measured by the file-set snapshot H1, unowned `harvestRun` composition sites H4). Closing that one gap
resolves all four.

## Ownership

| # | Deliverable | Owner (exactly one) |
|---|---|---|
| O1 | `src/audit/{link-store,chain,index}.ts` — the walker, the ten-hop table, `ChainReport`/`OQ4_VOID_REASON` exports | DF5.3 |
| O2 | The audit store's **no-create opener** (`openSync(path, "r")` probe → `audit-store-absent`, held-fd inode re-check → `audit-store-identity-changed`) — the DF2.11 ledger discipline, one store over | DF5.3 |
| O3 | `scripts/qds-audit.ts` CLI surface incl. the path seams `--runs-dir --audit-db --ledger --reverify-dir` (and runId invocation resolving hop 1 locally) | DF5.3 |
| O4 | The `recordAuditLink` seam fields + required composition sites: `provisionAdmittedRun` (its named options type), `teardownSandbox`, `runCredentialLifecycle`, **`harvestRun` (its own `HarvestDeps` sites, incl. `scripts/fleet.ts` + `scripts/sandbox-teardown.ts` threading), and `fillRun` — a new trailing **required** options argument on `fillRun` (`src/providers/driver.ts`), threaded at the dispatch fill step, `scripts/cap-hit-demo.ts`, and every `tests/providers/` fake** | DF5.3 |
| O5 | The frozen fixture's `pr-body.txt` capture (in `scripts/dev/capture-run-of-record.ts`) | DF5.4 |
| O6 | `src/gate/assertions/df5-{execution,boundary,accounting}.ts` + the driver | DF5.4 |
| O7 | C8's PR-body read — **through the frozen `pr-body.txt` via the gate's `--pr-body` seam**, never live GitHub | DF5.4 |
| O8 | C9's walker invocation — **by runId**, flags threaded from the gate's own seams; the live-PR-read variant stays an out-of-scope Trigger Surface row | DF5.4 |
| O9 | The file-set snapshot's "real `.sandbox/` untouched" assertion (snapshot the dev's real `.sandbox/` before/after) | DF5.4 |
| O10 | `scripts/dev/capture-run-of-record.ts` + `refs.git` bare repo | DF5.4 |
| O11 | `sprint-status.yaml` DF5.3 row (`DF2.11` dep edge) | parent (W6-B-M8) |

## Reconciliations applied (Wave 6 → spec)

| Finding | Disposition |
|---|---|
| W6-B-H1 (C3) | **No-create opener specified** (O2): the walker's read-write open is preceded by the no-create probe and inode re-check, so an absent `audit.db` is `audit-store-absent`, never created. INV-GATE-1 references it; DoD gains the absent-file-stays-absent test. |
| W6-B-H2 (C3) | **Path seams owned** (O3/O8/O9): four flags on `qds-audit.ts`, C9's row names them, DoD asserts the dev's real `.sandbox/` is untouched. |
| W6-B-H3 (C3) | **The fixture became self-contained** (O5/O7/O8): PR body frozen at capture, C8 reads it through `--pr-body`, C9 invokes the walker by runId so hop 1 resolves locally — no network, no token, no third-party PR lifetime dependency. Live PR read demoted to an out-of-scope row. |
| W6-B-H4 (C3) | **`harvestRun` joined the required-seam list** (O4): `recordAuditLink` required on `HarvestDeps` at its own composition sites; `scripts/fleet.ts` + `scripts/sandbox-teardown.ts` named in Files to Modify; the unpriced scope is folded into the 6-point rationale sentence. |
| W6-B-M1 (C1) | All `credentials.ts` line citations stripped; `mintRunKey`/`deliverRunKey`/`revokeRunKey`/`verifyRevoked`/`runCredentialLifecycle`/`captureSpend` cited by symbol. |
| W6-B-M2 (C1) | `df2-11` citations re-anchored to DF2.11's bullet headings; DF5.4-C10 additionally names `ledger-wal-recovery-required`. |
| W6-B-M3 (C3) | **C2's gate-green assertion made honest**: negated-field carve-out (`closedAt` + `commitSha` present, `extensions.gate` absent) recorded explicitly against INV-GATE-5, with the run-of-record row corrected (a healthy run carries no `extensions.gate`). |
| W6-B-M4 (C3) | **C3 gained the "at least one well-formed line" conjunct** + the empty-envelope mutant in the DoD's per-clause test. |
| W6-B-M5 (C1) | DF5.3's Guards/limits stale sentence rewritten to `openReadOnly` + its three typed refusals — the one paragraph a dev reads first for guard rules. |
| W6-B-M6 (C2) | `fetchBundle` (a symbol that does not exist) replaced by `harvestRun`'s `verify`/`fetch` steps; hop-6's reachable loss causes named (bundle absent after lawful harvest; `noHarvest` teardown with no prior harvest — the live pause-path call); the stronger true statement kept: an in-flight bundle failure aborts teardown, so it cannot produce a walkable PR. |
| W6-B-M7 (C1+C2) | Hop 2 cites `src/phase-engine/trace/migrations.ts` beside the schema; the `String(sessions.issue_id)` coercion rule stated once; a NULL correlation resolves `not-applicable` naming DF1.8's nullability comment. |
| W6-B-M8 (C1) | `DF2.11` added to the yaml DF5.3 row (parent). |
| W6-B-L1 (C2) | Strictness kept; the divergence from `push.ts`'s non-strict `<` recorded in one sentence (remedy: tighten `push.ts`, never loosen C7 — **owned by DF5.3**, landing in DF5.3's own PR so the admission rule and the chain agree from one merge). |
| W6-B-L2 (C1) | `RowClass`/`hasTokenRows` cited by symbol; `trace/schema.ts` given its directory. |
| W6-B-L3 (C4) | Both stories note `report.ts`'s header names the last line authoritative *for DF5.2*; the audit chain and the gate deliberately select the bound report. |
| W6-B-L4 (C4) | DoD Integration states the `dispatch.ts` composition-root exception explicitly. |
| W6-B-L5 (C4) | Run-of-record row no longer lists `extensions.gate` as present on a healthy run. |
