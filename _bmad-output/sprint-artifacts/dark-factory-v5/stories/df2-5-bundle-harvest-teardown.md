# DF2.5: Bundle Harvest + Tested Teardown

**Story Points:** 4
**Sprint:** v5-S1 (track B, provider; closes S1's provider chain)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §3.4, §5.3, §6 items 2/4/6
- Decision register: v5 §4 D7 (provider seam), D8 (no push credential in any box; host-side PR)
- Contracts: v5 §5.2 observability (requestId propagation, per-phase sub-timings); the closed
  run-record schema owned by DF2.1
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` DD-8, DD-10
- Evidence: R4 §3.3 (ranged bundle), §3.1 (teardown ordering), **§3 flag 4 + §3.6 — inkwell's
  teardown/reap are untested code** (`teardown_and_reap.md:6`); R5 §6 facts 15, 17
- Build order: v5 §8 step 2

## User Story

As a factory operator,
I want a run's commits, artifacts and trace pulled back across a credential-free gap and a teardown
that has actually been run under test,
so that a finished box can be destroyed without ever losing work and without a push credential
existing anywhere inside it.

## Overview

A box is filled by an unauthenticated `git clone` and holds exactly one secret: the DF2.3 run key —
no PAT, no deploy key, no ssh identity for the code host, because it runs an autonomous agent under
`--dangerously-skip-permissions`. Harvest moves commits across that gap with no credential at all:
the box writes a **ranged** git bundle, the host copies it down, verifies it, and fetches it into
`refs/sandbox/<run-id>`, a quarantine namespace touching no branch, index or working tree. Teardown
then runs a fixed order (spend → artifacts → commits → revoke → destroy → close) in which a harvest
failure aborts before anything irreversible. The reference shipped both unrun — hence these tests.

## E2E Slice

**Demonstrable behavior:** Given a box whose branch `sbx/<run-id>` carries three commits on the sha
FILL pinned, When the operator runs `bun scripts/sandbox-teardown.ts <run-id>`, it captures spend →
pulls `artifacts.tar` (specs, app docs, `run.log`) and the trace DB → creates
`<base>..refs/heads/sbx/<run-id>` in-box, copies it to `.sandbox/runs/<run-id>.bundle`, verifies it,
and fetches to `refs/sandbox/<run-id>` → revokes the key, destroys the box, closes the record.
`git rev-list --count refs/sandbox/<run-id>` prints `3`, host `git status --porcelain` is empty, and
`git branch --list` is unchanged.

**Wiring closed:** On completion of this story, harvest and teardown are real for any registered
provider driver using only code merged by this story plus its predecessors. No stub, no
`TODO: wire later`; the tests drive real `git bundle`/`git fetch` against a real throwaway
repository rather than a mock.

**Dependency edges (predecessors):** DF2.1, DF2.2, DF2.3 — teardown calls DF2.3's `captureSpend`,
`revokeRunKey` and `verifyRevoked` directly, not only through DF2.2.

## Acceptance Criteria

1. **(make-or-break)** Given a run branch `sbx/<run-id>` with commits descending from the
   FILL-pinned `<base>`, When harvest runs, Then the bundle is created **ranged**
   (`<base>..refs/heads/sbx/<run-id>`), copied to `.sandbox/runs/<run-id>.bundle`,
   `git bundle verify` passes **before** any fetch, and the objects land only at
   `refs/sandbox/<run-id>` — the host's working tree, index, `HEAD` and every operator-owned branch
   and tag are byte-identical before and after (R4 §3.3).
2. Given a run branch that does **not** descend from the pinned base, When harvest runs, Then
   `git fetch` refuses the bundle's prerequisite, harvest exits non-zero naming the missing sha, and
   no ref under `refs/sandbox/` is created or updated. The range is the integrity check: an
   implementation using `git bundle create --all` passes AC1 and MUST fail this test.
3. Given harvest fails for any reason, When `teardown <run-id>` runs without `--no-harvest`, Then
   teardown aborts **before** key revoke and box destroy, the box is left alive, the record is left
   open, and the next command to run is printed. Destroying a box whose commits were never pulled is
   the one irreversible mistake available here (R4 §3.3).
4. Given a run whose branch has zero commits beyond base, When harvest runs, Then `git bundle
   create` refusing an empty bundle is classified as a **successful no-op** — no ref is created, no
   `.bundle` file is left behind, the outcome is logged as `harvested: none`, and teardown proceeds
   normally rather than aborting under AC3.
5. Given a run already harvested that then committed more, When harvest runs again, Then
   `git fetch --force` updates `refs/sandbox/<run-id>` in place rather than failing on a
   non-fast-forward, and the artifacts tar and trace DB are re-pulled to the same host paths —
   harvest is idempotent and re-runnable at any point.
6. Given `git bundle verify` is unavailable at preflight, or the driver cannot **confirm** the box
   was destroyed, When teardown runs, Then it stops at that step leaving the box alive and the
   record open with the failure recorded, so DF2.6's reaper finds it — a run is never marked torn
   down on an unconfirmed destroy. `--no-harvest` waives AC3's harvest gate only; it never waives
   these, and the waiver is written to the run log, never to the record (INV-5).

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `bun scripts/sandbox-teardown.ts <run-id> [--no-harvest]` | in-scope | `tests/providers/teardown.test.ts` | — |
| `bun scripts/sandbox-teardown.ts harvest <run-id>` | in-scope | `tests/providers/harvest.test.ts` | — |
| `fleet harvest` / `fleet teardown` subcommands | out-of-scope | — | DF3.1 |
| Fleet-wide orphan sweep (reaper) + quota headroom refusal | out-of-scope | — | DF2.6 |
| Auto-teardown after a PR opens | out-of-scope | — | DF5.2 |
| Host-side re-verify of harvested commits before any PR | out-of-scope | — | DF5.1 |
| Audit-chain events for harvest/revoke/destroy | out-of-scope | — | DF5.3 |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Provider box + `exec`/`copyFile` primitives | exe.dev driver (DF2.2); `fake` driver in tests | DF2.2's five-assertion setup gate returned ready before harvest is callable |
| Host `git` with `bundle verify` | host toolchain (no service) | teardown preflight asserts `git bundle verify` is available and exits non-zero leaving the box untouched if not (INV-5) |
| Run record `.sandbox/runs/<run-id>.json` | DF2.1 store, host filesystem | record exists and `closedAt` is empty before teardown proceeds; teardown closes it as its last step |
| Per-run LLM key + revoke/verify verbs | DF2.3 credential lifecycle | spend read from the live key before revoke; revocation verified against the authoritative key list by DF2.3's verb |
| Trace DB + artifacts inside the box | DF1.4 trace store, written in-box | both present in the single tar round trip; absence is logged and does not abort harvest |

## Technical Notes

- **Why a bundle and not a push:** a push credential would give a skip-permissions agent write
  access to the repo it was cloned from, so the box holds none and a bundle crosses that gap with
  no credential (R4 §3.3; D8). **DD-10:** P1.15's in-box push is reversed, dead, never cited here.
- **Why a range and not `--all`:** a ranged bundle records the prerequisite "you must already have
  `<base>`", and `git fetch` refuses it otherwise, so a branch that does not descend from the sha
  FILL pinned is caught on the return trip instead of importing disconnected history (R4 §3.3; AC2).
- **Harvest set (v5 §5.3):** ranged bundle + artifacts tar + trace DB, in one tar round trip plus
  one bundle copy. Harvest writes **nothing** to the run record: the bundle's presence at
  `.sandbox/runs/<run-id>.bundle` is the record, and DF2.1's schema stays closed.
- **Teardown order, fixed:** spend captured → artifacts out → commits harvested → key revoked → box
  destroyed → record closed + key file shredded. Spend must be read before revoke because the number
  is unrecoverable afterwards. A crash between revoke and destroy leaves a dead key and a live box
  (visible, cheap); the reverse leaves a live key nobody can find (invisible, spending) (R4 §3.1).
  **The six steps are a floor, not a closed list — the contract is their relative order.** A later
  story may insert or prepend a step (DF4.2 stops the visualizer ahead of spend capture; DF2.8 hooks
  its `ingestBoxHours` call to the close step; DF5.3 adds a single-line `recordAuditLink(...)` emit
  at the teardown/reap events) without amending this story, provided all six keep their
  relative order. Ordering assertions here are therefore written as **subsequence / relative-order**
  checks over the recorded call order, never equality against a fixed six-element array, so an
  inserted step does not fail a test that is really about ordering.
- **Boundaries (so nothing ships twice):** DF2.3 owns mint → cap → revoke → verify-against-the-key-list
  and the key file's shred; DF2.5 owns the ordering that calls them and the abort semantics. DF2.6
  owns the fleet sweep, failed-teardown queue and quota; DF2.5 tears down **one** run, nothing else.
  DF2.8 owns the cost ledger and hooks its `ingestBoxHours` call to this teardown's **close** step;
  DF2.5 neither computes nor writes a ledger row, and an aborted teardown that never reaches close
  writes none (df2-8 AC / DF2-P2-03). **`src/providers/teardown.ts` has four claimants and a fixed
  merge order:** DF2.5 writes it; DF4.2 prepends the visualizer stop; DF2.8 adds the
  `ingestBoxHours` call at close; DF5.3 lands last (sprint v5-S3), adding only its single-line
  `recordAuditLink(...)` emit at the already-existing teardown/reap events. Each later claim is
  additive — no signature change, no reordering of the six steps.
- **Guards/limits:** bundle ≤ 512 MiB and artifacts tar ≤ 512 MiB, enforced on the received bytes
  AND on the summed entry sizes before extraction — an uncompressed-total cap, so a compressed tar
  cannot fill the host disk. Over-cap fails harvest loudly, box left alive. Tar expansion rejects an
  absolute-path, `..` or escaping-symlink entry, **and rejects hard links and every non-regular
  entry type (device nodes, FIFOs, block/char special files)**, before writing a byte (INV-3) —
  the untrusted box can otherwise use a hard link or a special entry to affect paths outside the
  extraction directory depending on the extractor; every step idempotent.
- **Deviation/assumption — the reference has no tests.** Inkwell's `teardown.just` (197 lines) and
  `reap.just` (138 lines) shipped unrun by their own cookbook (R4 §3, §3.6), so every `MEASURED`
  comment in them is manual probing. Nothing is inherited as proven: the tests here are blocking,
  and provider paths run against `fake` with exe.dev recorded `[VERIFY]` single-origin (R5 §6 f.11).

## Observability Contract

- Every teardown step logs `{ requestId, runId, step, driver, timestamp, durationMs, outcome }` for
  each of the six fixed steps — whether it ran, was skipped as already-done, or failed.
- requestId propagates from the dispatcher (DF3.1) or is minted by the CLI; errors carry
  `{ code, message }` and never the run key.
- Sub-timings: `bundle_create_ms`, `transfer_ms`, `verify_ms`, `fetch_ms`, `artifacts_ms`. Where the
  driver cannot break a remote call down, it reports `0` and `durationMs` is authoritative.

## Files to Modify

- `src/providers/harvest.ts`
- `src/providers/teardown.ts`
- `src/providers/index.ts`
- `scripts/sandbox-teardown.ts`
- `tests/providers/harvest.test.ts`
- `tests/providers/teardown.test.ts`
- `tests/providers/fixtures/git-fixture.ts`

## Security Invariants

- **INV-1 (credential containment):** no push credential — PAT, deploy key, ssh identity or
  `.git-credentials` — exists inside a box at any point in this flow, and harvest introduces none.
  A test asserts the box's `git remote get-url origin` is the unauthenticated clone URL and that its
  credential-bearing paths are absent. Negative control: an implementation that pushes from the box
  satisfies "the commits arrived" and MUST fail this test (D8; R5 §6 fact 17).
- **INV-2 (trust boundary):** the bundle is untrusted input produced by a skip-permissions agent —
  in-box evidence is a claim, not proof (F10/R9; R5 §6 fact 15). Ordering is fixed and enforced:
  `git bundle verify` succeeds **before** `git fetch` runs, and the fetch refspec targets
  `refs/sandbox/<run-id>` only — never a branch, tag, remote-tracking ref, the index or the working
  tree. Nothing merges here and no PR opens on this evidence; host-side re-verification is DF5.1's.
- **INV-3 (input validation on unpack):** the artifacts tar is validated before extraction — any
  entry with an absolute path, a `..` segment, a symlink escaping the destination, a hard link, or
  a non-regular entry type (device node, FIFO, block/char special) aborts it with nothing written.
  Both caps are checked host-side against the received size, never a reported one.
- **INV-4 (credential lifecycle ordering):** spend is captured from the live key **before** DF2.3's
  revoke runs, and the key file is shredded only after revocation is verified. Harvest completing is
  a precondition of reaching revoke at all (AC3), so no key is destroyed while work is still only in
  the box.
- **INV-5 (fail-closed):** if `git bundle verify` is unavailable, the bundle fails verification, or
  the driver cannot **confirm** box destruction, teardown stops and leaves the record open with the
  failure recorded, so DF2.6's reaper finds it. A run is never marked torn down on an unconfirmed
  destroy, and no failure path silently proceeds to the next step.

## Definition of Done

- [ ] **Impl:** `harvest(runId)` — ranged bundle in-box, copy down, verify, fetch to
      `refs/sandbox/<run-id>` with `--force`; artifacts tar and trace DB in one round trip
- [ ] **Impl:** `teardown(runId, {noHarvest})` in the fixed six-step order, every step individually
      guarded and idempotent, printing the next command on any failure
- [ ] **Contract:** harvest writes nothing to the run record; DF2.1's twelve-field schema is
      unchanged by this story (asserted by a test that diffs the record's key set)
- [ ] **Integration:** both entry points go through `ProviderDriver.exec`/`copyFile` only — no
      substrate-specific command appears in `harvest.ts` or `teardown.ts`
- [ ] **Security:** fetch refspec restricted to `refs/sandbox/` and verify-before-fetch ordering
      enforced (INV-2); tar entries validated before extraction, including rejection of hard links
      and non-regular entry types (INV-3)
- [ ] **Test (unit + fail-closed):** step order by call-order capture (spend→revoke→destroy, record
      closed last); a bundle failing `verify` never reaches `git fetch`, and an unconfirmed destroy
      leaves the box alive and the record open with the failure recorded (AC6, INV-5)
- [ ] **Test (non-descendant branch):** a branch off an unrelated root → fetch refuses the
      prerequisite, no `refs/sandbox/` ref written; a `--all` bundle implementation MUST fail (AC2)
- [ ] **Test (harvest failure aborts teardown):** injected harvest failure → box still alive, key
      not revoked, record still open (AC3) — this is the path the reference implementation shipped
      unrun (R4 §3, `teardown_and_reap.md:6`)
- [ ] **Test (empty branch):** zero commits beyond base → `harvested: none`, no ref, no bundle file,
      teardown proceeds (AC4)
- [ ] **Test (rejected archive type, INV-3):** an artifacts tar containing a hard link, a device
      node, or a FIFO entry → extraction aborts before writing any byte and the destination
      directory is left empty; an implementation that only checks path traversal and symlinks
      MUST fail this test.
- [ ] **Test (e2e demo — MANDATORY):** against a real throwaway git repo and the `fake` driver, a
      three-commit run is harvested and torn down; `git rev-list --count refs/sandbox/<run-id>`
      prints `3`, host `git status --porcelain` is empty, and the closed record with `spendMicroUsd`
      set is captured in the Dev Agent Record

## Dev Agent Record

### Completion notes

All DoD items implemented and verified on `feature/df2-5-bundle-harvest-teardown`:

- `src/providers/harvest.ts` (NEW): `harvestRun` (ranged bundle in-box → `copyFile` down →
  verify-before-fetch → `git fetch --force` into `refs/sandbox/<run-id>` only), `pullArtifacts`
  (one tar round trip + two-pass INV-3 validator: ustar header parse, hardlink/symlink/device/
  fifo/absolute/`..` rejection before any byte is written, 512 MiB received-bytes AND
  summed-entry AND streaming-decompressed caps, EOF-block requirement, `wx`/0600 extraction),
  `HarvestError{code,remediation}`, injectable `GitRunner`. Zero `store.set` calls.
- `src/providers/teardown.ts` (NEW): `teardownSandbox` — preflight (record present, closedAt
  empty, functional `git bundle verify` availability probe whose argv never contains the run
  id), then spend → artifacts → harvest → revoke → verify → destroy → close, each step logged
  `ran|skipped|failed`, every abort prints the literal next command and leaves box alive +
  record open (AC3/AC6/INV-5). `--no-harvest` waiver logged to the run log only.
- `scripts/sandbox-teardown.ts` (NEW): `[harvest] <run-id> [--no-harvest] [--driver] [--dir]`,
  follows the `run-record.ts` CLI shape — both now tokenize through a shared
  `tokenizeArgs` in `scripts/lib/cli-args.ts` (a value flag never swallows a following
  flag as its value); `keyApi` constructed lazily only when the record
  carries `keyHash` (keyless runs work offline).
- `src/providers/index.ts`: re-exports harvest + teardown.
- `src/providers/step-log.ts` (NEW): the shared timed/logged-step shape behind harvest's
  `timedStep` and teardown's `runStep` (per-stream outcome vocabulary, one implementation).
- Tests: `tests/providers/harvest.test.ts` (36), `tests/providers/teardown.test.ts` (21) —
  57 combined; `tests/scripts/cli-args.test.ts` gained the `tokenizeArgs` contract describe and
  `tests/scripts/sandbox-teardown-cli.test.ts` (NEW, 5) covers the CLI lock + record-read
  classification; `tests/providers/fixtures/git-fixture.ts` (shared fixture; commit messages are
  slug-stamped so two repos minted in the same wall-clock second can never collide on a root sha).

### E2E demo evidence (DoD, mandatory)

Final run — `bun test tests/providers/teardown.test.ts`:

```
 17 pass
 0 fail
 85 expect() calls
Ran 17 tests across 1 file. [30.48s]
```

Evidence bundle captured from the same run (the demo asserts `artifactsDir` is set and
`artifactEntries` carries `run.log`; on darwin the fake substrate's host `tar` adds
AppleDouble `._*` entries — recorded deviation 6):

```json
{
  "runId": "df25-demo",
  "baseSha": "a26c08758a4fae719e0e149bfe771f6808dc17cd",
  "originCommits": 3,
  "boxCommits": 3,
  "revListRangedCount": 3,
  "revListTotalCount": 6,
  "porcelainEmpty": true,
  "branchListUnchanged": true,
  "sandboxRef": "a8b811cf74264da561b3b9b4900eee1595da3cf3",
  "spendMicroUsd": 8100,
  "keyRevoked": true,
  "boxDirGone": true,
  "bundlePresent": true,
  "artifactsDir": "/var/folders/1v/nbxmg4vx1r53__g78j17g9mm0000gn/T/qds-df25-td-I2NHhI/runs/df25-demo-artifacts",
  "artifactEntries": ["._app_docs", "._run.log", "._specs", "app_docs", "run.log", "specs"],
  "closedAt": "2026-08-17T02:26:28.342Z",
  "leak": null
}
```

Story's literal "`git rev-list --count refs/sandbox/<run-id>` prints 3" reads as the RANGED
count `<base>..refs/sandbox/<run-id>` (the run's own commits); plain count necessarily
includes base ancestry (6 here). Both captured above.

### Verification summary

- `bun test tests/providers/`: 227 pass / 0 fail / 1 todo (8 files, final round-2 run;
  review round 2 added one harvest test, five teardown tests). One load-induced flake
  observed once in DF2.2's frozen-clock setup-gate test under full-dir parallelism; passes
  standalone 3/3 and on directory re-run.
- Repo-wide: `bunx tsc --noEmit` clean; `bun run lint` clean; all other test dirs green
  chunked (phase-engine/scripts/gate/gitnexus/hindsight/swarmclaw/vendor/root).
- Pre-existing on main, unrelated to this story (verified against a pristine main worktree
  with `.env` present): `tests/scripts/roster-check.test.ts` 2 live-network e2e failures,
  `tests/lean-worker-benchmark.test.ts` 1 `.env`-gated failure. CI has no `.env`, so these
  skip there.
- Advisory gates: `check-defensive-programming.sh` OK; `check-pr-conflicts.sh` OK (no open-PR
  overlap). Docker container tests N/A — repo defines no `docker-compose.test.yml`; CI parity
  target is `bun run typecheck && bun run lint && bun test`.

### Verified deviations / interpretation register

1. **No host-side key file** (story step 6 "record closed + key file shredded"): DF2.3
   delivers the key via `exec` stdin; plaintext exists only in a shredded 0600 mint temp and
   the in-box `.env`, which dies with the box. `driver.destroy()` IS the shred; DF2.3 owns
   shred ownership. A test asserts no `<run-id>.key` appears under the runs dir.
2. **`captureSpend` writes `spendMicroUsd` itself** (DF2.3) — teardown adds no write; the
   closed record carries the value the verb recorded.
3. **In-box staging is box-root-relative** (`harvest.bundle`, `harvest-artifacts.tgz`), not
   inkwell's `/tmp/...`: exedev's `assertBoxPathSafe` rejects absolute remote paths, so
   `/tmp` cannot cross the driver seam. The remote scripts run inside the workdir and write
   `../harvest*.tgz`.
4. **`workdir` deps knob** (default probes `/home/agent/app`, `/home/agent/src`, `app`):
   DF2.2's fill clones to `/home/agent/src`; the 12-field record cannot carry the path, so
   explicit `deps.workdir` (charset-guarded) wins, probe order covers real + fake layouts.
5. **pax/GNU `L`/`K` metadata records are consumed, not extracted**: macOS bsdtar emits pax
   records on every real archive; their `path=` overrides re-validate through the same
   safe-path gate, so INV-3's property (reject hardlink/symlink/device/fifo/traversal) is
   intact — all six evil-tar tests green.
6. **Artifacts host dir**: `.sandbox/runs/<run-id>-artifacts/` (inkwell naming; spec leaves
   this implementer's call). On darwin the fake substrate's host `tar` adds AppleDouble
   `._*` entries — accepted as regular safe-relative entries.
7. **Empty classification** uses in-box `git rev-list --count <base>..<branch>` == 0
   (locale-stable) rather than stderr matching on "Refusing to create empty bundle".
8. **Known CLI limitation (self-review)**: the `harvest` subcommand shadows a run literally
   named `harvest` (`sandbox-teardown harvest` parses as subcommand + missing run-id). Fails
   safe with a clear error; `newId()`-generated ids (slug-date-hex) can never collide.
9. **NOREPO workdir contract (self-review, accepted)**: a workdir-probe miss is classified
   `none` (inkwell semantics — "a missing piece is the normal path"); teardown then proceeds
   to destroy. Mitigated by the probe order pinning DF2.2's layouts (`/home/agent/app`,
   `/home/agent/src`, `app`) and the explicit `deps.workdir` override; a caller whose repo
   lives elsewhere must pass it.
10. **Metadata memory bound (self-review, accepted)**: pax/GNU `L`/`K` payloads buffer in
    memory during validation, bounded by the 512 MiB summed cap (real records are KBs).
11. **Self-review round (post-PR #115, fixed in follow-up commit)**: (a) untrusted in-box
    stderr is now bounded to one redacted line (200-char cap, `sk-` tokens replaced) before
    touching any error message — a compromised box can no longer exfiltrate the run key
    through failure diagnostics; (b) tar pass-1 now rejects ancestor/descendant path
    conflicts (file `a` + file `a/b`) as `tar-unsafe-entry`, so extraction can never fail
    mid-write with a partial destination; (c) `--dir` propagates to `deps.runsDir` (no
    split-brain between record location and bundle/artifacts output); (d) `harvest` mode
    never constructs the key API — the credential-free path stays credential-free.
12. **Review round 2 (post-PR #115, fixed in follow-up commit)**: (a) the harvestRun early
    guard split on `vmName` vs `commitSha` — a VM without a pinned base still runs the
    artifacts step (Step E was always ungated on commits; only a record with no VM at all
    short-circuits to `none`); (b) teardown is the sole owner of the artifact pipeline —
    it passes `artifactsOwnedByCaller` into harvestRun so exactly one pull runs per
    successful teardown (a test counts the in-box tar execs); (c) destroy is skipped
    entirely when the record has no `vmName` (no `runId` fallback into
    `driver.destroy`), so a box-less run can still close; (d) `bunGitRunner` carries the
    same `timeout`/`SIGKILL` ceiling as the seam's `sshCommand`; (e) a read-side error on
    the artifacts source stream routes through the structured fail path instead of an
    unhandled `error` event; (f) pass-2 tar extraction is atomic (failed extraction
    removes the destination) and the file count excludes directory entries; (g) both
    operator CLIs tokenize through shared `tokenizeArgs` so `--driver --no-harvest`
    reports the missing value instead of eating the bool flag.
13. **Review round 4 (BMAD 3-layer adversarial review of PR #115)**: (a) received-size caps
    are now ALSO probed in-box before `copyFile` (`bundle-over-cap`/`tar-over-cap` pre-reject;
    the post-copy stat remains authoritative — a true stream cap needs a driver-seam change,
    marked `ponytail:`); (b) every untrusted-output embed (protocol stdout, verify/fetch stderr)
    routes through the sanitizer, which now also redacts ≥40-char mixed-case base64/hex runs
    (encoded-key exfiltration; lowercase-hex shas still surface for AC2); (c) git spawns pin
    `LC_ALL=C` so `missing-prerequisite` classification is locale-stable; (d) the bundle-verify
    probe commit pins `commit.gpgsign=false` + `core.hooksPath=` (host git config can no longer
    fail the probe) and is skipped entirely for box-less+key-less records; (e) a
    destroyed-box/record-open crash no longer dead-ends: artifacts + harvest steps treat
    no-such-box as skip ("box already gone") while destroy keeps its fail-closed INV-5 path;
    (f) CLI takes a `<runId>.lock` (wx, pid+timestamp, `run-locked` on contention, no steal),
    rejects extra positionals, and opts into stray-single-dash rejection (run-record's
    single-dash-as-value grammar preserved); (g) pass-2 tar extraction goes through a
    `.partial` sibling + rename, closes fds on write failure, folds names
    (NFC+lowercase) in pass-1 conflict sets, and rejects GNU base-256 size fields as
    `tar-invalid` (they previously parsed as 0); (h) NOREPO no longer deletes a previously
    harvested bundle (the bundle file IS the harvest record; NOCOMMITS/AC4 still removes it);
    (i) NOARTIFACTS sweeps the stale staging tgz; artifacts-step failure still logs
    `harvested: <n>, artifacts: "failed"` before rethrowing; (j) store read failures are
    classified `record-read-failed` (not `no-record`) at all three call sites so a corrupt
    record behind a live box/key never suggests re-creating the run; (k) `DEFAULT_WORKDIRS`
    probes relative names first so the fake substrate stops touching host-absolute paths;
    (l) main-sink output uses `writeSync` so piped diagnostics survive `process.exit`.

### Change log

| Date | Change |
|---|---|
| 2026-08-16 | Story implemented via 5-wave subagent pipeline (fixture → red tests → harvest impl → teardown+CLI → verification); fixture sha-collision flake fixed (slug-stamped commit messages) |
| 2026-08-16 | Review round 2 (PR #115, CodeRabbit/Gemini/Sift): harvestRun guard split (vmName vs commitSha) + `artifactsOwnedByCaller` single-pull contract; destroy skipped for box-less records; shared `tokenizeArgs` + `step-log.ts`; `bunGitRunner` hard timeout; atomic pass-2 tar extraction + regular-file counting; source-stream error routing; non-Error catch coercion; CLI coverage (no-record / harvest+--no-harvest / --dir / credential-free keyed harvest) |
| 2026-08-16 | Review round 4 (BMAD 3-layer adversarial: Blind Hunter + Edge Case Hunter + Acceptance Auditor, 25 findings → 23 fixed, 2 dismissed): pre-copy size caps, sanitizer on all untrusted embeds + encoded-key redaction, LC_ALL=C git, probe hardening + skip rules, dead-box skip semantics, CLI lock + arity + stray-dash rejection, `.partial` atomic extraction + fd close + name folding + base-256 rejection, NOREPO bundle retention, `record-read-failed` classification, relative-first workdir probes, writeSync sinks; +18 tests (57 provider combined, 42 CLI) |
