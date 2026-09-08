# Wave 6 — Round-3 independent verification: DF5.3 + DF5.4

**Scope:** `df5-3-audit-chain-extended.md`, `df5-4-lights-on-gate.md`
**Branch:** `feature/qds-story-review-remaining-v5-stories` @ `c72064f6`
**Method:** every symbol, table, path, flag and exit code either story names was opened in this repo.
Prior-round evidence reports were not read. Citations below are by symbol / section anchor.

---

## What was verified and holds

Recorded so the finding list is not read as the whole picture.

- **Gate chassis.** Every `gate-runner.ts` citation in DF5.4 is exact: `GateCheckOutcome:39`,
  `GateAssertion:45`, `prd_clause:51`, the no-`spawnSync` note `:66-68`, `GateAssertionResult:77-86`,
  `GateReport:88`, `GateReportSchema:117-128`, `RunGateOptions:130`, `runGate:144`, VOID `:167-178`,
  `detail: \`VOID — ${a.void_reason}\`` at `:174`, skip `:208-215`/`:211-212`, all-void FAIL `:324-326`,
  the "SKIP is NOT a pass" header `:8-13`. DF5.4-AC1's claim that `void_reason` exists on the
  *assertion* input but on neither `GateAssertionResult` nor `GateReportSchema` is **correct**, and the
  DoD's negative control against a `void_reason` report field is well-aimed.
- **Budget arithmetic.** 1 preflight + 10 live main at concurrency 4 = 4 waves × 60 s = 240 s inside
  a 300 s total. Correct, and the clause map really does contain 11 live + 1 void.
- **`cost-ledger.ts`.** `:448` `DEFAULT_COST_LEDGER_FILE`, `:875` `QDS_COST_LEDGER_FILE`, `:1335`
  `readRunCost`, `:722-723` `perRole`/box-hours, `:729-730` `hasEvents`, `:941-949` the F001 docstring,
  and `:885-921` — which begins **exactly** at `mkdirSync` and ends **exactly** at `db.exec(SCHEMA)`.
  The enumerated side effects (mkdir 0700 → chmod 0700 → `new Database()` creates → chmod 0600 →
  `PRAGMA journal_mode = WAL` → schema exec) are all there. This is a good citation.
- **`run-record.ts`.** `:139` `requestId`, `:151` `ExtensionValue`, `:216` `fixLoop` (`fixOutcome` really
  is `"string"` kind), `:228-238` `budget`, `:299-315` `approval`, `:285-292` the `dispatchRequestId`
  warning, `:1178` `resolveRunsDir`. All exact.
- **Emitter reachability (the round-2 defect class).** `provisionAdmittedRun` is at `driver.ts:549` and
  is really called at `dispatch.ts:2683` — which passes the full `budget: {repoSlug, issueId, …,
  admittedCeilingMicroUsd}` block, so DF5.4-C1's evidence exists on a production dispatch. `fillRun`
  `driver.ts:935` is really called at `dispatch.ts:2986`. The setup-gate call is at `dispatch.ts:3023`.
  `teardownSandbox` is at `teardown.ts:463` exactly; `ingestBoxHoursIfAttributed`'s two string guards
  are at `teardown.ts:493-494`, inside the cited `:488-494`. `harvest.ts:1068` is exactly
  `const dest = join(runsDir, \`${runId}-artifacts\`)`. `sweep` is at `reaper.ts:391`; `reaper.ts:2-4`
  really says "reap what nobody owns".
- **Approval is not a dead branch.** `approval-gate.ts:2004-2015` mints `decidedAt` and writes
  `{state, approverId, decidedAt, reason}` into `extensions.approval`, driven by a live operator verb
  (`scripts/fleet.ts:3152`). DF3.4 is `done`. DF5.4-C7 and DF5.3 hop 8 have a real writer.
- **`gate_results` is not vacuous-safe.** `schema.ts:84-93` is exactly the `gate_results` CREATE and
  `request_id` is exactly `:86`; `passed INTEGER` carries **no** `NOT NULL`, so DF5.4-C4's
  "never NULL" is a real assertion, not a tautology. C4's explicit refusal to demand pass/fail
  diversity against a frozen fixture is correct reasoning.
- **Two-story contract integrity.** `ChainReport` has one owner (`src/audit/index.ts`, DF5.3 Files to
  Modify) and one importer; `OQ4_VOID_REASON` likewise; the reason strings in the two stories are
  byte-identical; the hop table ↔ clause map reciprocity paragraph is stated identically on both sides;
  C9's "at least one contributing-runId key / exactly ten hops under every key" is written against the
  map, so DF6.1b widens it without touching the clause. No drift found across this seam.
- **`src/audit/` does not exist** — correct, DF5.3 creates it. `src/gate/assertions/lib/verdict.ts`
  exists; `verifier-child.ts:33` is exactly `evidence?: Record<string, unknown>;`;
  `scripts/lib/cli-args.ts` really exports `parseValueFlags`; `scripts/phase0-exit-gate.ts` really
  declares only `flags: ["--report"]`, so DF5.4's four-flag surface is correctly scoped as net-new.

Greps asserting absence below are paired with a positive control on the same file. No file in scope
carried the `run-lock.ts` NUL-byte pathology.

---

## Findings

### W6-B-H1 — the walker CREATES `.sandbox/audit.db`, falsifying INV-GATE-1
**Severity:** HIGH · **Category:** `C3-structural`
**Where:** DF5.3 § *Infra Prerequisites*, row 1 (host-side link store); DF5.4 § *Security Invariants*,
INV-GATE-1; DF5.4 DoD *Security* (file-set snapshot).

DF5.3 specifies that the walker "opens read-**write** … but **never** migrates: it asserts the schema
is present and fails the walk closed … so an uninitialized store (zero `recordAuditLink` calls) can
**never be created by the read path**."

**That conclusion is asserted with no mechanism, and the default mechanism contradicts it.**
`bun:sqlite`'s `new Database(path)` creates the file when absent — the story itself says so about the
ledger, quoting `cost-ledger.ts:885-921` ("`new Database()` which CREATES the file when absent"). A
read-write open of a missing `audit.db` therefore materialises a zero-byte database **before** any
schema assertion can run. This is the identical defect that caused DF2.11 to be chartered, one store
over: the stories reason at length about not letting the gate create the ledger and leave the audit
store — the one store the gate actually writes — with no no-create discipline at all.

**Failure scenario.** Operator clones the repo on a fresh host, runs
`bun scripts/df5-lights-on-gate.ts --report r.json` against the fixture. `.sandbox/audit.db` is absent
(no `recordAuditLink` has ever run on this host). C9 shells out to `qds-audit.ts`, which opens the
audit store read-write; SQLite creates `.sandbox/audit.db`. INV-GATE-1's "creates no file the gate
merely intended to read — which is the operative half of this invariant" is now false in production.
The DoD's file-set snapshot does **not** catch it, because the harness copies a fixture that *already
contains* `audit.db`, so the create branch never fires under test.

**Fix direction.** Give the audit store the same opener DF2.11 ratified for the ledger: a no-create
`openSync(path, "r")` probe throwing a typed `audit-store-absent`, then `new Database(path)`, with the
held-fd inode re-check. State it in DF5.3's Infra row and reference it from INV-GATE-1. Add a DoD test
that runs the gate with `audit.db` **absent** and requires the file to still be absent afterwards.

---

### W6-B-H2 — orphaned work: nothing owns the path seams `scripts/qds-audit.ts` needs to read a fixture
**Severity:** HIGH · **Category:** `C3-structural`
**Where:** DF5.3 § *Trigger Surface* row 1; DF5.4 § *Infra Prerequisites* "Producer of the run of
record" and DoD *Impl* (flag list).

DF5.4 freezes the run of record into `tests/gate/fixtures/df5-run-of-record/`, copies it into a
`mkdtempSync` scratch dir, and says "`--runs-dir`-style seams point the gate at it", declaring
`--report`/`--help`/`--runs-dir`/`--git-dir`. C9 then invokes **a subprocess**:
`bun scripts/qds-audit.ts --json <pr-url>`. DF5.3's Trigger Surface declares that CLI's entire surface
as `<pr-url|branch|runId> [--json]` — **no path flags**.

Of the five stores the walk reads, three have env seams (`QDS_AUDIT_DB`, `QDS_COST_LEDGER_FILE`,
`QDS_RUNS_DIR`) and one has none: `.sandbox/reverify/` resolves as
`deps.reverifyDir ?? join(hostRoot, DEFAULT_REVERIFY_DIR)` with `hostRoot = deps.hostRoot ??
process.cwd()` (`src/reverify/runner.ts:217,220`; `DEFAULT_REVERIFY_DIR` at `report.ts:310`) — cwd-only,
no environment variable. Neither story says the gate sets env for the subprocess, and neither story
owns adding flags to `qds-audit.ts`. This is green in both DoDs and done by neither.

**Failure scenario.** The dev implements both stories literally. `bun test tests/gate/` runs the gate
against the scratch fixture; C9's subprocess resolves `.sandbox/reverify/<runId>.jsonl` against the
**test process's cwd** — the developer's real repo — where that run does not exist. Hop 7 resolves
broken, C9 fails, and the DoD e2e item ("eleven `pass` … `DF_GATE: PASS`, exit `0`") cannot go green
on any machine. Worse on a machine that *does* have a same-named run: the gate silently asserts
against the wrong evidence and passes.

**Fix direction.** DF5.3 owns the CLI, so DF5.3 adds `--runs-dir`, `--audit-db`, `--ledger` and
`--reverify-dir` to `qds-audit.ts`'s Trigger Surface and Files-to-Modify, and DF5.4-C9's row names the
flags it passes. Add one DoD assertion: the gate run leaves the developer's real `.sandbox/` untouched
(this is already half-specified by the file-set snapshot, which today snapshots the *real* `.sandbox/`).

---

### W6-B-H3 — C8 and C9 require live GitHub reads against a fixture the story calls "frozen"
**Severity:** HIGH · **Category:** `C3-structural`
**Where:** DF5.4 clause map rows `DF5.4-C8` and `DF5.4-C9`; § *Infra Prerequisites* row 3
("GitHub PR read for the PR clause"); § *Technical Notes* → *Guards/limits*; AC3.

`Guards/limits` states: "Every clause asserts against the **frozen run of record**: a gate must be safe
to re-run, and a live path costs money and mutates." AC3 requires bit-identical repeat results. But:

- **C8** asserts the PR body's shape (`Issue:` line, runId, cost summary). `EXTENSION_NAMESPACES.pr`
  (`run-record.ts:214`) registers exactly three fields — `prUrl`, `prNumber`, `createdAt`. **The body is
  not on disk anywhere.** C8 can only read it from GitHub.
- **C9** invokes the walker with `<pr-url>`, and DF5.3 hop 1 is "PR → run: branch `qds/{runId}` +
  runId in PR body" with the story's own admission "No network access beyond the single GitHub PR
  read at hop 1".

So two of eleven live clauses depend on a network call, a valid host-side token, and a third-party PR
still existing with an unedited body. The `refs.git` bare repo and the ledger checkpoint were both
added precisely so the fixture would be self-contained; the PR body was not.

**Failure scenario.** Six months on, `gh repo delete` has removed the demo repo (DF5.2's row already
records exactly such a cleanup owed on `biospark33/qds-df52-e2e`, issue #133), or CI has no token.
C8 returns `skip`, C9 returns `fail` on hop 1, the gate is red, and nothing in the system is broken.
AC3's determinism is machine- and network-dependent — the same defect the story explicitly names and
forbids for `refs/sandbox/` ("resolving one would make AC3's determinism machine-dependent").

**Fix direction.** Freeze the PR body too: `scripts/dev/capture-run-of-record.ts` writes
`pr-body.txt` into the fixture, C8 reads it through a `--pr-body` seam, and C9 invokes the walker with
the **runId** (hop 1 then resolves `extensions.pr` locally — which is already the digest subject DF5.3
defines for hop 1, so no hop semantics change). Keep the live PR read as an out-of-scope row in the
Trigger Surface if a live variant is still wanted.

---

### W6-B-H4 — the "an unwired seam must be loud" rule skips the composition site that owns hop 6
**Severity:** HIGH · **Category:** `C3-structural`
**Where:** DF5.3 § *E2E Slice* → *Scope note on the shared files*; DoD *Integration*.

The scope note makes `recordAuditLink` **required** at exactly three composition sites:
`provisionAdmittedRun` (`driver.ts:549`), `teardownSandbox` (`teardown.ts:463`) and
`runCredentialLifecycle` (`credentials.ts:711`, cited as `:685` — see W6-B-M1). The bundle
`verify` + `fetch` emits, however, live in **`harvestRun`** (`harvest.ts:760`), whose steps are
`"bundle_create" | "transfer" | "verify" | "fetch" | "artifacts"` (`HarvestStep`, `harvest.ts:415`).
`harvestRun` is called from three sites today — `teardown.ts:692` (covered, since `TeardownDeps`
flows in), **`scripts/fleet.ts:4466`** and **`scripts/sandbox-teardown.ts:240`** — and DF3.7 will add
a fourth on the production `dispatch → poll → harvest → teardown` path. None of those three is in the
required list, and `HarvestDeps.recordAuditLink?` is declared optional.

This matters more than the other seams because hop 6 is one of the **exactly three** hops
(4 credential / 5 box / 6 bundle) that DF5.4-C9 asserts emitted `audit_links` row ids for.

**Failure scenario.** DF3.7 lands its harvest call site building `HarvestDeps` without
`recordAuditLink`. Typecheck passes (the field is optional). Every run then produces a chain whose hop
6 is `unlinked` → AC3 makes it a broken hop → the walker exits non-zero → C9 fails → the lights-on gate
is red forever, and the diagnostic names a bundle that is sitting on disk perfectly fine.

**Fix direction.** Add `harvestRun` to the required-seam list (making `recordAuditLink` required on
`HarvestDeps` at its own composition sites, not only where `TeardownDeps` happens to supply it), and
name `scripts/fleet.ts` / `scripts/sandbox-teardown.ts` in *Files to Modify*. Note this is also a
scope increase DF5.3's 6-point estimate did not price.

---

### W6-B-M1 — every `credentials.ts` line citation in both stories is off by +26
**Severity:** MEDIUM · **Category:** `C1-citation`
**Where:** DF5.3 § *E2E Slice*, *Scope note*, *Trigger Surface* row 2, *Infra Prerequisites* row 2,
*Technical Notes* ("The cap has no event site"), DoD *Integration*; DF5.4 clause rows `C2` and `C10`.

Actual positions in `src/providers/credentials.ts`:

| Story says | Actual | Symbol |
|---|---|---|
| `:144` | **`:170`** | `export interface CredentialDeps` |
| `:244` | **`:270`** | `mintRunKey` |
| `:261-278` | **`:287-304`** | `capMicroUsd` validation |
| `:286` | **`:312`** | the `deps.keyApi.createKey(name, …)` call |
| `:514` | **`:540`** | `deliverRunKey` |
| `:535` | **`:561`** | `captureSpend` |
| `:574` | **`:600`** | `const spendMicroUsd = usdToMicros(...)` |
| `:595` | **`:621`** | `revokeRunKey` |
| `:652` | **`:678`** | `verifyRevoked` |
| `:685` | **`:711`** | `runCredentialLifecycle` |

Uniform +26 shift — consistent with `287c036c` ("fix(credentials)+docs: re-home the spend-ceiling
chain"), a **fix-round commit on this very branch** that moved the file and did not re-anchor the two
consumer stories. Every fact is right; every pointer is wrong. This is the campaign's dominant defect
class regenerated by the campaign's own remediation.

**Fix direction.** Re-anchor all ten. Better: cite `mintRunKey` / `deliverRunKey` / `revokeRunKey` /
`verifyRevoked` / `runCredentialLifecycle` / `captureSpend` by symbol name — they are top-level exports
and need no line number to be unambiguous.

---

### W6-B-M2 — the `df2-11:` citation cluster points at the wrong paragraphs
**Severity:** MEDIUM · **Category:** `C1-citation`
**Where:** DF5.3 § *Infra Prerequisites* row 2; DF5.4 § *Infra Prerequisites* rows 2 and 3, clause row
`C10`, § *Technical Notes* ("What C6, C8 and C10 may assert against").

The **substance** is right — I read `df2-11-teardown-lock-readonly-ledger.md` and `openReadOnly` really
is a static factory doing a no-create `openSync(path, "r")` → `ledger-absent`, holding the fd for an
`fstatSync(fd).ino` re-check → `ledger-identity-changed`, then `new Database(path, {readonly: true})`
with no `mkdirSync`, no `chmodSync`, no mode assertion, no pragma and no `db.exec(SCHEMA)`, plus a
typed hot-WAL refusal. The **pointers** are not:

| Story says | Actual content at that line | Where the claim really lives |
|---|---|---|
| `df2-11:270-282` (openSync + inode probe) | `:270` is the **run-lock** half ("`scripts/reverify.ts` still takes no run lock (F106…)") | `:283-291` |
| `df2-11:286` (no chmod/pragma/schema exec) | `:286` is "**Never a bare `existsSync`.** `{ readonly: true }` closes the *creation* half…" | `:294-295` |
| `df2-11:291-305` (hot-WAL refusal) | `:291` is the tail of the identity-race paragraph | `:301-310` |
| `df2-11:306` (0700/0600 stay on the write path) | `:306` is "…is exactly the independence DF5.4 needs and does not have" | not at `:306` |
| `df2-11:426` (same claim) | `:426` is INV-LOCK-1: "No boolean, no environment variable and no convention substitutes for it" | not at `:426` |
| `df2-11:169-170` (negative control on read-path mode assertions) | `:169-170` is the **write-refusal** control: the three write methods throw `ledger-readonly` before touching the DB | a different control |

DF5.4's Infra row 2 leans on `df2-11:169-170` to argue a 0644 git-checked-out fixture is fine. The
conclusion holds (I confirmed `openReadOnly` runs no mode assertion), but the cited negative control
does not support it, so the argument is unbacked as written.

**Fix direction.** Re-anchor, or cite by DF2.11's bullet headings ("**`openReadOnly` is a static
factory on the same class**", "**Named ceiling — a read-only open of a WAL database**"), which is what
this campaign's own rule prescribes. Also: DF2.11 names the WAL code `ledger-wal-recovery-required`;
DF5.4-C10 names `ledger-absent` and `ledger-identity-changed` literally but leaves the third
descriptive — worth naming it too, since C10's `skip` reason is asserted in a test.

---

### W6-B-M3 — `DF5.4-C2` asserts "setup gate green" against a namespace written only on failure
**Severity:** MEDIUM · **Category:** `C3-structural`
**Where:** DF5.4 clause map row `DF5.4-C2`; § *Security Invariants* INV-GATE-5; § *Infra
Prerequisites* row 2 (which lists `extensions.gate` among what the run of record carries).

C2 asserts "box `create`d, `fill`ed at a pinned SHA, **`setup` gate green**, record closed …".
`EXTENSION_NAMESPACES.gate` (`run-record.ts:321-324`) is documented as "**DF3.1 AC3: the setup gate's
refusal, written by the fleet dispatcher when the gate fails**", and there is exactly one write site
(`dispatch.ts:3070`), on the failure branch. On a healthy run `extensions.gate` **is absent**.

So the only record-side evidence for "setup gate green" is the *absence* of a field — which
INV-GATE-5 in this same story forbids: "every asserted field is checked positively (`!== 0`,
`!== false`, a status literal) so an absent field fails rather than reading as satisfied."

**Failure scenario.** A dev implements C2 as `record.extensions?.gate === undefined`. A run record
truncated to `{runId, createdAt}` by a partial write passes that check — the clause reads a *missing
record* as a green gate. Conversely a strict reading of INV-GATE-5 makes C2 unimplementable, because
no positive field exists to check.

Note the two other halves of C2 *are* positively assertable: `commitSha` is a core field
(`run-record.ts:97`) and `spendMicroUsd` likewise, so only the gate half is affected.

**Fix direction.** Either drop "setup gate green" from C2 and say why (green leaves no durable trace —
the same reasoning C1 already applies to DF3.1's un-persisted brief digest), or state that the
evidence is a *negated* field and carve it out of INV-GATE-5 explicitly with a companion positive
guard (e.g. require `closedAt` **and** `commitSha` present **and** `extensions.gate` absent). Do not
leave the clause naming an assertion its own invariant forbids.

---

### W6-B-M4 — `DF5.4-C3` passes on an empty envelope
**Severity:** MEDIUM · **Category:** `C3-structural`
**Where:** DF5.4 clause map row `DF5.4-C3`.

C3 asserts the harvested merged envelope "is present, parses, and carries **zero malformed NDJSON
lines**". A zero-line file is present, parses, and has zero malformed lines. **It passes.**

This is the archetype the brief names, and it is inconsistent with C3's own sibling: C4 explicitly
requires "**at least one** `gate_results` row" and reasons carefully about why *diversity* is the thing
it must not demand. C3 got the "no malformed" half and not the "at least one" half.

**Failure scenario.** The in-box team run produces no envelopes at all (roster misconfiguration, every
`dispatch_task` refused, or a harvest that tarred an empty `envelopes/` directory). The envelope file
is created empty by the merge step. C3 → `pass`. The gate reports the team stage green on a run where
no agent produced anything. C4 would catch the gate stage, but C3 is the only clause covering team
execution — DF5.3 has no hop there by design ("dispatch/team execution are upstream of
authorization"), so nothing else backstops it.

**Fix direction.** Add "**and at least one well-formed line**" to C3, and add a mutant to the DoD's
per-clause unit test: an empty envelope file must make C3 red. (The DoD's existing mutant recipe —
"red on a mutant with the asserted field removed" — does not generate this case, because there is no
field to remove.)

---

### W6-B-M5 — DF5.3's `Guards/limits` still carries the pre-DF2.11 answer, contradicting its own Infra row
**Severity:** MEDIUM · **Category:** `C1-citation` (stale text surviving a fix round)
**Where:** DF5.3 § *Technical Notes* → *Guards/limits*, last sentence.

> "The cost ledger is the one store whose library has **no read-only open path**, so its existence is
> asserted before construction (see Infra Prerequisites)."

Both halves are now false, and the pointer goes to the paragraph that says so. DF5.3's own Infra row 2
states the walker opens through `CostLedger.openReadOnly({path})` — so the library *does* have a
read-only path — and explicitly forbids the other half: "**Not an `existsSync` pre-check**: DF2.11
specifies a **no-create `openSync(path, "r")`**…". A dev who reads Guards/limits (the section headed
"guards") and implements `existsSync(path)` then `new CostLedger({path})` ships exactly the
check-then-open race DF2.11's negative control exists to fail — and it will still pass every
absent-ledger test.

**Fix direction.** Rewrite the sentence to point at `openReadOnly` and its three typed refusals. This
is one stale paragraph left behind when the rest of the story was updated; it is worth calling out
because it is the *only* place in DF5.3 that a dev looking for guard rules would naturally read first.

---

### W6-B-M6 — `fetchBundle` does not exist, and hop 6's "fails independently" rationale is wrong
**Severity:** MEDIUM · **Category:** `C2-semantic`
**Where:** DF5.3 AC6 and § *Technical Notes* hop table row 6.

AC6: "for hop 6, whose bundle fetch failed … `<runsDir>/<runId>.bundle` for hop 6, **which rides
`fetchBundle` and not `pullArtifacts` and so fails independently**".

`grep -rn "fetchBundle" src/ scripts/ tests/` returns **0** (positive control: `bundle` matches 43× in
`harvest.ts` alone). There is no such symbol. The real shape is `harvestRun` (`harvest.ts:760`) with an
internal step enum `"bundle_create" | "transfer" | "verify" | "fetch" | "artifacts"`
(`HarvestStep`, `harvest.ts:415`); verify is `git bundle verify` and fetch is
`git fetch --force <hostBundle> refs/heads/<branch>:refs/sandbox/<runId>`, both inside that function.

The *conclusion* — bundle loss is a different event from artifacts loss — is true, but the
*independence claim is backwards*. `runArtifactsStep` (`teardown.ts:218`) is the wrapper that makes an
artifacts failure non-fatal; `runBoxStep`'s docstring states the opposite for harvest:
"**Every OTHER harvest failure still aborts before revoke/destroy (AC3)**". A bundle verify/fetch
failure therefore **aborts teardown**: the record stays open, revoke/destroy never run, the run never
closes, DF5.1 never re-verifies, DF3.4 never approves, DF5.2 never opens a PR.

**Failure scenario (for the AC as written).** A dev builds AC6's hop-6 negative control by simulating
"a run whose bundle fetch failed" end to end, and cannot produce one that also has a merged PR — the
state AC6 describes is unreachable from a real run. Meanwhile the *reachable* hop-6 loss cases are not
described: (a) the bundle file deleted after the fact (disk cleanup — the realistic operator case),
and (b) `teardownSandbox(deps, runId, {noHarvest: true})`, which is a **live production call** at
`approval-gate.ts:1875` on the pause path, so hop 6's evidence depends on an *earlier* explicit
`harvestRun` having run (`scripts/fleet.ts:4466`, or DF3.7's).

**Fix direction.** Replace `fetchBundle` with `harvestRun`'s `verify`/`fetch` steps by name. Re-write
AC6's hop-6 cause to the reachable ones: bundle absent at `<runsDir>/<runId>.bundle` after a lawful
harvest, or a `noHarvest` teardown with no prior harvest. State that an in-flight bundle failure aborts
teardown and so cannot produce a walkable PR — that is a *stronger* statement and worth keeping.

---

### W6-B-M7 — hop 2's join columns are not in the cited DDL, are nullable, and disagree in type
**Severity:** MEDIUM · **Category:** `C1-citation` + `C2-semantic`
**Where:** DF5.3 § *Technical Notes* hop table row 2; § *Security Invariants* INV-AUDIT-1.

Hop 2 joins on "`(repo_slug, issue_id)` on the **harvested** trace `sessions` row … (`trace/schema.ts:34-35`,
PK'd on `request_id`)". `schema.ts:34-46` is the `sessions` CREATE and its columns are
`request_id, request, status, engineer, started_at, ended_at, duration_ms, total_tokens, total_cost,
pipeline_name, archived`. **Neither `repo_slug` nor `issue_id` is there.** They are added by DF1.8 via
`ALTER TABLE ADD COLUMN` in `src/phase-engine/trace/migrations.ts` (`MIGRATIONS` entries
`["sessions","repo_slug","TEXT"]`, `["sessions","issue_id","INTEGER"]`), which neither story names.
The `:34-35` citation supports only the PK claim.

Two live consequences beyond the pointer:

1. **Nullability.** DF1.8's own comment: "All nullable: a bare DF1.4 run carries NULL `repo_slug`".
   Hop 2 has no rule for a NULL correlation — is that `broken`, `unlinked`, or `not-applicable`? AC1
   admits only four outcomes and hop 2 is not one of AC5's `not-applicable` cases, so a dev must guess.
2. **Type mismatch.** `sessions.issue_id` is **INTEGER**. `extensions.budget.issueId` is registered
   `"string"` (`run-record.ts:232`) and the ledger canonicalises it as a string
   (`canonicalIssueId`). INV-AUDIT-1 makes `(repo_slug, issue_id)` *the* identity, and DF5.4-C1
   asserts the string form on the record. Nothing states the coercion.

**Failure scenario.** Hop 2 resolves a session row, then a later comparison against
`extensions.budget.issueId` does `sessions.issue_id === record.extensions.budget.issueId` — `42 === "42"`
is `false`. The hop reports a broken correlation on a perfectly healthy run, and the diagnostic
("expected 42, actual 42") is unreadable.

**Fix direction.** Cite `migrations.ts` beside `schema.ts:34-35`; state the coercion rule once
(`String(sessions.issue_id)` against the canonicalised record value) and the NULL outcome.

---

### W6-B-M8 — DF5.3's `sprint-status.yaml` row omits `DF2.11`
**Severity:** MEDIUM · **Category:** `C1-citation` (artifact consistency)
**Where:** `_bmad-output/sprint-artifacts/sprint-status.yaml` `DF5.3:` row vs DF5.3 § *E2E Slice* →
*Dependency edges*.

Story: "DF1.4, DF1.8, **DF1.10**, DF2.1, DF2.3, DF2.5, **DF2.6**, DF2.8, **DF2.11**, DF3.4, DF5.1,
DF5.2" — twelve edges.
YAML: `deps: [DF1.4, DF1.8, DF1.10, DF2.1, DF2.3, DF2.5, DF2.6, DF2.8, DF3.4, DF5.1, DF5.2]` —
eleven. **`DF2.11` is missing.**

This is not cosmetic. DF2.11 (`ready-for-dev`, unbuilt) supplies `CostLedger.openReadOnly()`, which
hop 3 requires and which does not exist; the story says so twice. DF5.4's row *does* carry DF2.11, so
the two consumers of the same seam disagree. A scheduler reading the YAML can start DF5.3 before
DF2.11 exists, at which point hop 3 has no read-only opener and the dev's only options are the
writing constructor (creating the ledger the walk audits — the DF5.4 BLOCKER already recorded in that
story's own YAML comment) or blocking.

Everything else checks: DF5.3 6 pts / `ready-for-dev` / v5-S3, DF5.4 5 pts / `ready-for-dev` / v5-S3
and its eleven deps match the story line exactly. Points, status and sprint tag all agree with the
headers.

**Fix direction.** Add `DF2.11` to the DF5.3 row. Parent owns the edit.

---

### W6-B-L1 — strict `<` on `reverify.completedAt → decidedAt` is stronger than the shipped guard
**Severity:** LOW · **Category:** `C2-semantic`
**Where:** DF5.3 § *Overview* + AC7; DF5.4 § *Overview* + clause row `DF5.4-C7`.

Both stories define reconstructability as `reverify.completedAt < approval.decidedAt < pr.createdAt`,
"(strict — **equality is a violation**)", and C7 asserts `decidedAt` "**strictly after**" the report's
`completedAt`. The shipped enforcement in `src/pr/push.ts` is non-strict on that boundary:

```
if (!Number.isFinite(decided) || !Number.isFinite(completed) || decided < completed) {
  throw new PrRefusalError("approval-precedes-report", …)
}
```

`decided === completed` **passes** `push.ts` and the PR opens; C7 would then fail the gate on a run
DF5.2 lawfully published. In practice the two stamps are separated by a human approval decision, so
the window is theoretical — which is why this is LOW, not higher. But the drift rule says shipped code
wins unless the ADR says otherwise, and the ADR is silent here.

**Fix direction.** Keep the strictness (the argument for it in AC7 is sound) but record it as a
deliberate strengthening over `push.ts`'s `<`, with one sentence noting that a
millisecond-equal pair is a red gate on a PR DF5.2 admitted, and that the remedy is to tighten
`push.ts` rather than to loosen C7. One line; do not leave the divergence undocumented.

---

### W6-B-L2 — residual small line drift
**Severity:** LOW · **Category:** `C1-citation`

- **`reaper.ts:90-93`** (DF5.3 AC5, twice): `RowClass` is declared at **`:91-93`**; `:90` is blank.
  All seven class literals are inside the cited range, so the fact survives.
- **`cost-ledger.ts:722-723`** (DF5.3 hop 3, DF5.4-C10) is cited for "`perRole` … and `hasTokenRows`
  is `false`". `:722-723` is the `perRole` field and its box-hours docstring; **`hasTokenRows` is at
  `:738`**. Half the citation is unsupported.
- **`trace/schema.ts`** is written without its directory in both stories; the file is
  `src/phase-engine/trace/schema.ts`. Consistent between the two stories, so no drift — but a dev
  grepping `trace/schema.ts` from repo root finds nothing.

---

### W6-B-L3 — the bound-report rule silently overrides a shipped docstring
**Severity:** LOW · **Category:** `C4-marginal`
**Where:** DF5.3 hop 7; DF5.4 § *Technical Notes* → C6.

Both stories insist the ordering input is the **bound** report (`reverifyId === extensions.approval.reportId`)
and "**never the last line**". `src/reverify/report.ts:10-11` says the opposite in its module header:
"Reports persist append-only at `.sandbox/reverify/<run-id>.jsonl`, one record per line, **the last line
authoritative for DF5.2**." The stories' reasoning is better than the docstring's (a superseded report
or a red final report both break last-line selection), and the two are not strictly in conflict —
different consumers — but a dev who opens `report.ts` first will implement last-line.

**Fix direction.** One clause in each story: "`report.ts`'s header names the last line authoritative
*for DF5.2*; the audit chain and this gate deliberately select the bound report instead, for the
reason above."

---

### W6-B-L4 — DoD says "each through its own `*Deps` seam" while listing a file with no seam
**Severity:** LOW · **Category:** `C4-marginal`
**Where:** DF5.3 DoD *Integration*.

The item lists `src/fleet/dispatch.ts:3023` among emit sites and closes "— each through its own
`*Deps` seam, required at the three composition sites named in the Scope note." The Scope note names
exactly four `*Deps` interfaces (`CredentialDeps`, `HarvestDeps`, `TeardownDeps`, `SweepDeps`) and
`dispatch.ts` is not among them. Dispatch is the composition root and may import `src/audit/*`
directly — the `src/providers/*` no-ambient-dependency rule does not reach it — but the DoD as
written asks for a seam that the story never defines.

**Fix direction.** "…each through its own `*Deps` seam, except `src/fleet/dispatch.ts`, which is a
composition root and imports `recordAuditLink` directly."

---

### W6-B-L5 — `extensions.gate` listed among what a healthy run of record carries
**Severity:** LOW · **Category:** `C4-marginal`
**Where:** DF5.4 § *Infra Prerequisites*, "Run of record" row.

The row says the run record "carries `extensions.approval`, `extensions.pr`, `extensions.budget`,
`extensions.gate`". A green run carries no `extensions.gate` (see W6-B-M3). Harmless on its own but it
is the sentence that makes M3's clause look supportable.

---

## Category and severity distribution

| | BLOCKER | HIGH | MEDIUM | LOW | total |
|---|---|---|---|---|---|
| `C1-citation` | 0 | 0 | 4 (M1, M2, M5, M8) | 1 (L2) | 5 |
| `C2-semantic` | 0 | 0 | 1 (M6) | 1 (L1) | 2 |
| `C3-structural` | 0 | 4 (H1–H4) | 2 (M3, M4) | 0 | 6 |
| `C4-marginal` | 0 | 0 | 0 | 3 (L3, L4, L5) | 3 |
| **total** | **0** | **4** | **7** | **5** | **16** |

M7 spans `C1` and `C2`; it is counted once under `C1` (its pointer defect is the primary one) and its
type-mismatch half is the `C2` component. No finding was inflated to reach a count; the ten "verified
and holds" items above are a genuine majority of what was checked, and several — the chassis citation
set, `cost-ledger.ts:885-921`, the three `dispatch.ts` emit sites, the approval writer — are the exact
places where round 2 found rot in other stories and where these two are clean.

---

## Convergence verdict

**Not converged — but this is one focused patch, not a fourth broad round.** Confidence: high.

The C3 population is live (6 of 16, including all four HIGHs), which by the brief's own rule reads as
"rethink rather than patch". I do not think that reading is right here, and the reason is that the six
C3s are **not six independent model errors**. Four of them (H2, H3, and by extension H1's untested
create path) are one gap wearing four hats: *DF5.4 declares a frozen, self-contained run of record, and
then specifies clauses that reach outside it* — to a live GitHub PR body (H3), to a walker with no path
seams (H2), and to a real `.sandbox/` that the file-set snapshot then measures (H1's blind spot). Close
that one gap — freeze the PR body, add four flags to `qds-audit.ts`, give `audit.db` DF2.11's no-create
opener — and all four resolve together. The remaining two (M3, M4) are single-clause defects in the
clause map, each fixed by one added conjunct.

What is *not* wrong is the part a fourth round would be for. The emitter↔asserter contract is sound in
both directions: `ChainReport` and `OQ4_VOID_REASON` have one owner and one import point, the VOID
reason strings are byte-identical, the reciprocity paragraph is stated identically on both sides, C9 is
correctly written against the runId-keyed map so DF6.1b widens it without editing the clause, and the
"C1 and C3 assert stages with no hop by design" argument is correct — I checked it against the
substrate rather than against the other story, and dispatch/team execution genuinely are upstream of
the authorization walk. The two-layer doctrine is honoured: C3 and C4 are explicitly typed as
claim-integrity, C6 is the truth layer, and the DoD's two-layer negative control (all-green in-box
`gate_results` + red `ReverifyReport` → gate FAIL) is a real test that a doctrine-collapsing
implementation fails. That is the ADR R9 property these stories exist to protect, and it survives.

The C1 cluster (5 findings) deserves its own note, because it is the round-2 lesson recurring at the
meta level: **W6-B-M1's uniform +26 shift was introduced by commit `287c036c`, a fix commit on this
branch.** A remediation round moved `credentials.ts` and left ten citations in two consumer stories
pointing into the gap. The `df2-11:` cluster (M2) is the same shape against a story rather than a file.
Until stories cite exported symbols by name rather than by line, each fix round will keep minting fresh
C1s at roughly the rate it retires them — and DF5.3 alone carries ~60 line citations. That is a
process finding, not a story finding, but it is the one with the best return.

**Recommendation:** one targeted pass over the four HIGHs and M3/M4 (all bounded paragraph edits, no
re-split, no ownership change), plus a mechanical re-anchor of M1/M2/M5/M8. Then start development.
Do not re-open the hop table, the clause map's shape, or the DF5.3/DF5.4 split — all three are sound.
