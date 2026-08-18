# DF2.5 Design Brief — Bundle Harvest + Tested Teardown

Implementation contract distilled from: story df2-5, arch spec §3.4/§5.2/§5.3/§6, DD-8/9/10,
inkwell harvest.just/teardown.just/reap.just extraction, verified git 2.54/tar semantics
(empirically checked), and current code (DF2.1/2.2/2.3 as merged at PR #114).

This file is authoritative for signatures. Where it and the story disagree on a mechanical
detail, the story wins; flag the disagreement in the Dev Agent Record.

## Files (exhaustive — story list)

| File | Action |
|---|---|
| `src/providers/harvest.ts` | NEW — harvest + artifacts pull + tar validator |
| `src/providers/teardown.ts` | NEW — six-step orchestrated teardown |
| `src/providers/index.ts` | EDIT — add `export * from "./harvest.ts"` + `export * from "./teardown.ts"` |
| `scripts/sandbox-teardown.ts` | NEW — CLI: `<run-id> [--no-harvest]` and `harvest <run-id>` |
| `tests/providers/harvest.test.ts` | NEW |
| `tests/providers/teardown.test.ts` | NEW |
| `tests/providers/fixtures/git-fixture.ts` | NEW |

Nothing else. No driver.ts edits (DF2.1 `teardownRun` stays as-is; DF2.5's function has a
different name). No schema changes. No new deps (yaml+zod only; tar parsing is hand-rolled).

## Shared shapes

```ts
// harvest.ts
export class HarvestError extends Error {
  readonly code: string;        // machine-readable, also the log `code`
  readonly remediation: string; // literal next command, env-var NAMES only
}

/** Injectable host-git runner — tests spy ordering + inject failures. */
export type GitRunner = (argv: readonly string[], cwd: string) => Promise<ExecResult>;
export const bunGitRunner: GitRunner; // default: Bun.spawn(argv, {cwd, stdout/stderr pipe, stdin ignore})

export interface HarvestDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
  requestId?: string;
  /** Host repo the fetch lands in. Default: process.cwd(). Must be a git repo. */
  gitCwd?: string;
  gitRunner?: GitRunner;
  /** Overrides `.sandbox/runs` root (tests). Default: store.dir's parent? NO — default ".sandbox/runs" via DEFAULT_RUNS_DIR semantics; see Paths. */
  runsDir?: string;
  /**
   * In-box repo workdir. DF2.2's fill clones to `/home/agent/src` (DEFAULT_FILL_WORKDIR);
   * the 12-field record cannot carry it, so it is a deps knob. Tests pass "app".
   */
  workdir?: string;
}

export type HarvestResult =
  | { outcome: "harvested"; count: number; tip: string }
  | { outcome: "none" };

export async function harvestRun(deps: HarvestDeps, runId: string): Promise<HarvestResult>;
```

```ts
// teardown.ts
export interface TeardownDeps {
  driver: ProviderDriver;
  store: RunRecordStore;
  /** Required iff the record carries keyHash (fail-closed otherwise, code "provisioning-key-missing"). */
  keyApi?: KeyApi;
  requestId?: string;
  gitCwd?: string;
  gitRunner?: GitRunner;
  runsDir?: string;
  workdir?: string;
}

export interface TeardownOptions { noHarvest?: boolean }

export async function teardownSandbox(
  deps: TeardownDeps, runId: string, opts: TeardownOptions = {},
): Promise<void>;
```

`teardownSandbox` throws `TeardownError` (same shape as HarvestError) on any abort; every
abort prints/logs the literal next command. Never resolves "ok" on a partial teardown.

## Paths (fixed)

- Host bundle: `<runsDir>/<run-id>.bundle` — `runsDir` default: `DEFAULT_RUNS_DIR` (`.sandbox/runs`, resolve the same way the store does: `process.env.QDS_RUNS_DIR ?? ".sandbox/runs"`).
- In-box bundle: `harvest.bundle` at BOX ROOT (relative path — exedev's `assertBoxPathSafe`
  rejects leading `/`, so inkwell's `/tmp/harvest.bundle` cannot cross the seam). The remote
  script runs inside `<workdir>` and writes `../harvest.bundle`.
- In-box artifacts tarball: `harvest-artifacts.tgz` at BOX ROOT (same rule; script writes
  `../harvest-artifacts.tgz` from inside `<workdir>`).
- Host artifacts dir: `<runsDir>/<run-id>-artifacts/` (inkwell naming; spec leaves this
  implementer's call — RECORDED DECISION). Absent artifacts ⇒ dir must not exist afterwards.
- Fetch destination ref: `refs/sandbox/<run-id>` ONLY.
- In-box branch: `sbx/<run-id>` (created by fill; harvest backfills with `git branch` if
  missing — ref-only, no checkout, safe mid-run — lifted from inkwell).

## HARVEST — step sequence (harvestRun)

Preconditions (throw HarvestError, box untouched):
1. `rec = store.get(runId)` — missing record: code `no-record`, remediation = create command hint.
2. `rec.vmName` — missing: code `no-vm` ("FILL never completed"), but this is a NO-OP class
   per inkwell prerequisites (missing vm_name/commit_sha ⇒ exit 0 "nothing to harvest") —
   return `{outcome:"none"}`. Same for missing `rec.commitSha`.
3. Host git repo present: `git rev-parse --show-toplevel` in gitCwd fails ⇒ `no-host-repo`.

Step A — in-box protocol (one `driver.exec`, script on STDIN):
```
exec(vm, ["bash","-s","--", base, `sbx/${runId}`], REMOTE_SCRIPT)
```
REMOTE_SCRIPT (translate inkwell harvest.just:54-83; `$1`=base sha, `$2`=branch;
`cd "$WORKDIR"` where WORKDIR is interpolated into the script text from deps.workdir —
default `/home/agent/src`; stdout = exactly one protocol line):
```bash
set -euo pipefail
base="$1"; branch="$2"
cd WORKDIR 2>/dev/null || { echo "NOREPO"; exit 0; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "NOREPO"; exit 0; }
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1 || git branch "$branch" >&2
count=$(git rev-list --count "$base..refs/heads/$branch")
if [ "$count" -eq 0 ]; then echo "NOCOMMITS"; exit 0; fi
git bundle create ../harvest.bundle "$base..refs/heads/$branch" >&2 || { echo "BUNDLEFAIL"; exit 0; }
tip=$(git rev-parse "refs/heads/$branch")
printf 'OK %s %s\n' "$tip" "$count"
```
- `NOREPO` → `{outcome:"none"}` (run never got a repo; log it).
- `NOCOMMITS` → `{outcome:"none"}`, log `harvested: none`, NO bundle file left host-side
  (AC4). rev-list non-zero exit (bad base sha in-box) = real failure (script dies, exec
  exitCode != 0) → HarvestError `bundle-create-failed` with stderr.
- `BUNDLEFAIL` → HarvestError `bundle-create-failed`.
- `OK <tip> <count>` → proceed. Non-zero exec exit without a known protocol line →
  HarvestError `remote-protocol` (include trimmed stderr; NEVER stdout beyond the protocol line).
- Time this step → `bundle_create_ms`.
- IMPORTANT (inkwell L80): unknown base in-box makes rev-list fail — that is a REAL failure
  here, distinct from AC2 (which is host-side verify). Both exit non-zero; AC2 names the sha.

Step B — copy: `driver.copyFile(vm, "harvest.bundle", hostBundlePath)` (box-root relative —
the seam's path guard rejects absolutes) → `transfer_ms`.
Failure → HarvestError `bundle-copy-failed`, box alive.

Step C — cap + verify (host): `statSync(hostBundlePath).size > 512 MiB` → HarvestError
`bundle-over-cap` (file KEPT for inspection — inkwell keeps the bundle on verify failure).
Then `git bundle verify <hostBundlePath>` via gitRunner in gitCwd → `verify_ms`.
- exit != 0 → parse stderr `/^error: ([0-9a-f]{40,64})/m` → HarvestError `missing-prerequisite`
  naming the sha(s) (AC2). Other failures → `bundle-verify-failed` (include stderr).
- VERIFY STRICTLY BEFORE FETCH (INV-2).

Step D — fetch: `git fetch --force <hostBundlePath> "refs/heads/sbx/<run-id>:refs/sandbox/<run-id>"`
via gitRunner in gitCwd → `fetch_ms`. Failure → `fetch-failed` (bundle kept). `--force` makes
re-harvest update in place (AC5). Refspec targets `refs/sandbox/<run-id>` ONLY.

Artifacts (NOT gated on commits; runs even when outcome is "none"):
Step E — in-box tar: one exec (WORKDIR interpolated from deps.workdir, default
`/home/agent/src` — same knob as Step A):
```bash
set -eu
cd WORKDIR 2>/dev/null || { echo NOARTIFACTS; exit 0; }
P=$(ls -d specs app_docs adws/adw_data/ssmf.db run.log trace.db 2>/dev/null || true)
[ -z "$P" ] && { echo NOARTIFACTS; exit 0; }
tar czf ../harvest-artifacts.tgz $P
echo TARBUILT
```
(Entry list = inkwell's set; `adws/adw_data/ssmf.db` — keep inkwell's literal name; ALSO try
`trace.db` at repo root and `artifacts/` — final list: `specs app_docs adws/adw_data/ssmf.db
trace.db run.log`.) Exit 0 + `NOARTIFACTS` → log `artifacts: none`, ensure no host dir,
continue. `TARBUILT` → copyFile down (remotePath `harvest-artifacts.tgz`) to
`<runsDir>/<run-id>-artifacts.tgz` (staging file) → validate → extract → rm staging tgz.
Non-zero exit (tar missing, etc.) → HarvestError
`artifacts-failed` (real failure, INV-5).
- All of E → `artifacts_ms`.
- gzip chosen (inkwell used plain cf; czf halves transfer; validator handles both — sniff
  `1f 8b`).

FAILURE SEMANTICS: any HarvestError thrown from harvestRun aborts teardown BEFORE revoke
(AC3) — box alive, record open, remediation printed.

RECORD: harvest writes NOTHING to the record. No store.set calls anywhere in harvest.ts.
(The bundle file's presence is the record.)

### Tar validator (inside harvest.ts, INV-3 — verified offsets, GNU tar manual)

Two-pass over the staging tgz:
- Pass 1 (validate): `createReadStream` → sniff gzip magic `1f 8b` → pipe through
  `zlib.createGunzip()` (or raw passthrough) → 512-byte block accumulation:
  - header block: magic at 257 === `ustar` (accept `ustar\0` and `ustar  \0` GNU? NO —
    reject non-ustar; bsdtar/GNU both emit ustar) ; name = prefix(345,155)+"/"+name(0,100)
    trimmed NULs; size = octal at 124 (12 bytes); typeflag at 156.
  - REJECT (HarvestError `tar-unsafe-entry`, nothing extracted): typeflag not in
    {'0','\0','5'} (i.e. hardlink '1', symlink '2', char '3', block '4', fifo '6', and
    anything else); name or linkname absolute, containing `..`, or empty.
  - skip `ceil(size/512)` data blocks.
  - Count summed uncompressed entry sizes; running decompressed byte count; EITHER past
    512 MiB → `tar-over-cap` (bomb defense: `stream.destroy(err)` in the data handler).
  - Require a 512-byte all-zero EOF block before stream end; else `tar-truncated`.
  - Reject if not valid gzip when magic claimed it / garbage when plain (`tar-invalid`).
- Pass 2 (extract): re-read; `rmSync(destDir, {recursive:true, force:true})` then
  `mkdirSync(destDir, {recursive:true, mode:0o700})`; write regular files via
  `openSync(..., "wx", 0o600)` walking created dirs (dirs from typeflag '5' AND implicit
  parents); entries with duplicate paths → `tar-unsafe-entry` (no overwrite).
- Received-bytes cap: staging tgz file size > 512 MiB → `tar-over-cap` BEFORE pass 1.

Bun 1.2.22 gotchas (verified): `events.once(em, ["end","close"])` array form never resolves —
await single events; `createReadStream().destroy(cb)` callback never fires after natural EOF —
use plain `.destroy()`. POC lives at /tmp/df25-tar-parse (may still exist — consult it).

### Observability (every line via `log()` from ../swarmclaw/log.ts)

- operation `harvest.bundle_create|transfer|verify|fetch|artifacts` — fields:
  `{requestId, runId, step, driver, timestamp, durationMs, outcome}` + sub-timing keys
  `bundle_create_ms|transfer_ms|verify_ms|fetch_ms|artifacts_ms`.
- errors: `status:"error"`, `error:{code, message}` — NEVER key material.
- `harvested: {count}` or `harvested: none` outcome field on a summary line.

## TEARDOWN — teardownSandbox (fixed relative order)

Preflight (all before ANY mutation; box untouched):
1. `store.get(runId)` — throws → print remediation, rethrow `no-record`.
2. Record closed already (`closedAt` set) → log all steps `outcome:"skipped"`, return
   (idempotent re-run; first-close-wins already applied).
3. `git bundle verify` availability probe: mkdtemp → `git init -q` → one
   `--allow-empty` commit → `git bundle create probe.bundle --all` → `git bundle verify
   probe.bundle` → cleanup. Any failure → TeardownError `bundle-verify-unavailable`,
   exit non-zero, box untouched (AC6). (Functional probe — proves the actual capability,
   no stderr text matching.)
4. `--no-harvest` set → log line `teardown.harvest_waived` (the waiver goes to the RUN LOG
   = observability log stream + CLI stdout, NEVER the record).

Steps (log each: ran | skipped | failed; subsequence order is the contract):
1. **spend** — `rec.keyHash` absent → log skipped ("no key was ever minted"), continue.
   Present → require `deps.keyApi` (else TeardownError `provisioning-key-missing`);
   `captureSpend(deps, runId)` (DF2.3 — it writes `spendMicroUsd` itself; DO NOT
   double-write). Failure → abort (record open, box alive) — spend unreadable after
   revoke, but a failed read is still fail-closed per INV-5.
2. **artifacts** — harvest.ts artifacts-only export: `pullArtifacts(deps, runId)` (exported
   from harvest.ts; harvestRun calls it as its last step too). Failure → abort.
3. **harvest** — `noHarvest` → skipped (waiver logged). Else `harvestRun(deps, runId)`;
   throw → abort BEFORE revoke/destroy (AC3): box alive, record open, remediation printed.
4. **revoke** — `rec.keyHash` absent → skipped. Else `revokeRunKey(deps, runId)`
   ("revoked" | "already-gone" both OK; throw aborts — key may be live).
5. **verify** — `verifyRevoked(deps, runId)` (list-authoritative). Throw (incl.
   `list-unverified`) → abort, box alive (INV-5: never mark torn-down unverified).
6. **destroy** — `driver.destroy(rec.vmName ?? runId)` (drivers confirm internally:
   exedev re-lists; fake rmSync). Throw = unconfirmed → abort, record open (AC6).
   Key file shred NOTE: no host-side key file exists in this architecture (DF2.3 delivers
   via stdin; in-box `.env` dies with the box; DF2.3 owns shred) — destroy IS the shred.
   RECORDED DEVIATION vs story wording; DF2.3's header comment agrees.
7. **close** — `store.close(runId)` LAST. (`extensions` writable post-close; we write none.)

Step order in tests: SUBSEQUENCE assertions over recorded call order (spend → revoke →
destroy, close last) — never equality against a fixed array (four-claimant contract).

## CLI — scripts/sandbox-teardown.ts

Follow scripts/run-record.ts shape exactly: shebang `#!/usr/bin/env bun`,
`import.meta.main` → setLogSink(stderr), exported `parseArgs` + `run(argv, out): number`,
`parseValueFlags` from `./lib/cli-args.ts`.

Grammar: `[harvest] <run-id> [--no-harvest] [--driver <name>] [--dir <runs-dir>] [--help]`.
- `harvest <run-id>` → harvestRun only. Exit 0 on harvested/none; 1 + remediation on error.
- default → teardownSandbox. On TeardownError/HarvestError: print `!! <code>: <message>` +
  `next: <remediation>` to out, exit 1.
- `--driver` default `process.env.QDS_PROVIDER_DRIVER ?? "fake"`; `resolveDriver(name,
  {requestId})` from ../src/providers/index.ts.
- `--dir` / `$QDS_RUNS_DIR` → RunRecordStore dir.
- Build keyApi lazily: `rec = store.get(runId)` first; `rec.keyHash` present →
  `openRouterKeyApi()` (throws `provisioning-key-missing` with remediation before anything
  is mutated). No keyHash → omit keyApi (works offline).
- gitCwd = process.cwd().

## TESTS — exact case list

### tests/providers/fixtures/git-fixture.ts
Export (extract + generalize the inline pattern in tests/providers/exedev/driver.test.ts:236+):
```ts
export async function runLocal(argv: string[]): Promise<string>  // throws on non-zero
export interface GitRepo { dir: string; run(argv: string[]): Promise<string>; ... }
export async function makeOriginRepo(opts?: {commits?: number}): Promise<{originDir, baseSha, shas: string[]}>
export async function cloneIntoBox(driver, vm, originDir, workdir?): Promise<void>
  // git clone file://<originDir> <workdir> via driver.exec; then nothing else.
```
mkdtemp `qds-df25-` roots; caller cleans (return dir; tests rmSync in finally).

### tests/providers/harvest.test.ts (map AC → test)
1. AC1 happy: 3-commit branch → harvested {count:3}; `git rev-list --count refs/sandbox/<id>`
   in host repo = 3; host `status --porcelain` byte-identical before/after; `branch -a`
   unchanged; operator branch/tag refs unchanged (capture `git for-each-ref` before/after,
   diff must show ONLY `refs/sandbox/<id>` addition); bundle file exists.
2. AC1 range: bundle header contains `-<base>` prerequisite line (read first KB of bundle
   file, assert `/^-<sha>/m` and NOT `--all` semantics: bundle ref line is exactly
   `refs/heads/sbx/<id>`).
3. AC2 non-descendant: box branch off unrelated root → harvest throws `missing-prerequisite`,
   message contains the sha; NO ref under refs/sandbox/ (for-each-ref diff empty); exit
   non-zero. A `--all` bundle impl MUST fail this (the unrelated-root commits cannot verify
   against host base).
4. AC4 empty: branch at base → `{outcome:"none"}`; no ref; NO `.bundle` file on host; log
   contains `harvested: none`.
5. AC5 idempotent re-harvest: after first harvest, box commits 2 more → harvest again →
   `--force` updates ref in place (rev-list count 5); artifacts re-pulled to same paths;
   second artifacts extraction leaves no stale extra files.
6. INV-1: box `git remote get-url origin` via driver.exec = `file://...` (no userinfo);
   `ls ~/.git-credentials` etc absent (exec `test -e` checks: `~/.git-credentials`,
   `.git/config` contains no `credential`/`url.*@` — grep); origin repo for-each-ref
   unchanged by harvest (negative control: nothing was pushed).
7. INV-2 ordering: spying gitRunner records argv sequence → `bundle verify` call strictly
   before `fetch` call; fetch argv contains refspec `refs/heads/sbx/<id>:refs/sandbox/<id>`
   and `--force`; injected verify failure (runner returns exit 1 for verify) → throws, and
   NO fetch call was made.
8. INV-3 tar: hand-crafted evil tgzs (reuse git-semantics POC fixture builders —
   `../` entry, absolute symlink, hardlink typeflag '1', char device '3', fifo '6', gzip
   bomb over 512 MiB cap (test uses a low injected cap — make the 512 MiB a const and let
   tests pass a smaller one? NO — cap fixed; bomb test crafts ~600 MiB uncompressed of
   zeros /dev/zero-streamed — cheap: tar of one 600MiB sparse… simpler: gz of 600 MiB
   zeros is ~600KB — build in-test via zlib.gzipSync of zero-filled header+data — POC has
   the builder) → each: throws `tar-unsafe-entry`/`tar-over-cap`, dest dir ABSENT/empty.
   Truncated (no EOF block) → `tar-truncated`. Prefix-field long name → parses full name.
9. Record-untouched: run FULL harvest on a keyed record → record JSON key set identical
   before/after (deep-equal on parsed minus nothing).
10. NOREPO: box without repo → `{outcome:"none"}`.

### tests/providers/teardown.test.ts
1. DoD order: RecordingDriver + FakeKeyApi + call-order capture array; assert subsequence
   [captureSpend-ish marker, revoke, destroy, close-last] — implement by wrapping
   deps.driver/keyApi/store methods to push labels; assert `indexOf` ordering + close last.
2. AC3: harvest failure injected (gitRunner verify fails) → teardown throws; box dir still
   on disk (FakeDriver box exists); FakeKeyApi still has key (not revoked); record open.
3. AC4 path: zero-commit run → teardown completes; record closed; `harvested: none` logged.
4. AC6 preflight: gitRunner makes the availability probe fail → throws
   `bundle-verify-unavailable`, box alive, record open, NO driver mutation calls at all.
5. AC6 unconfirmed destroy: driver.destroy throws → record open, key revoked but verify
   ran (allowed), box "alive" (fake destroyed? no — injected destroy throws BEFORE
   rmSync: wrapper that throws) → record open, failure logged.
6. INV-4: spend captured before revoke (order test); `spendMicroUsd` present in closed
   record; key file: no host key file exists — assert none created under runsDir
   (deviation test).
7. `--no-harvest`: waiver log line `teardown.harvest_waived` present; record key set
   unchanged by waiver; harvest NOT called (no refs/sandbox ref created even though box
   had commits); teardown completes, record closed.
8. Idempotent re-run: teardown twice → second run all-skipped, exit ok, closedAt unchanged
   (first-close-wins).
9. No-key run: no keyHash → spend/revoke/verify skipped; completes; works with keyApi
   omitted (TypeScript: deps without keyApi).
10. SCRIPT e2e (trigger surface): `Bun.spawn(["bun", "scripts/sandbox-teardown.ts",
    runId], {cwd: hostRepo, env: {...process.env, QDS_RUNS_DIR, QDS_FAKE_BOXES_DIR,
    QDS_PROVIDER_DRIVER: "fake"}})` → exit 0, record closed. Same for `harvest <run-id>`
    subcommand (no key) → exit 0 `harvested: <n>`.
11. E2E DEMO (DoD, MANDATORY): real throwaway repo + FakeDriver + FakeKeyApi: create run
    (store + FakeDriver.create + fill: clone file:// origin at base into box, branch
    sbx/<id>, 3 in-box commits via driver.exec), mint key via FakeKeyApi + set record
    keyHash, run FULL teardownSandbox → assert: `git rev-list --count refs/sandbox/<id>`=3;
    `git status --porcelain` empty; `git branch --list` unchanged; closed record has
    `spendMicroUsd` set; key absent from FakeKeyApi list; box dir gone; bundle file
    present; artifacts dir present (build specs/run.log in box first). Capture output in
    Dev Agent Record.

Test conventions: `bun:test`, mkdtemp `qds-df25-*` cleanup in finally, `setLogSink`
capture arrays, per-test timeouts `}, 30_000)`, `leakScan`-style argv scan (never key
plaintext). tsconfig: `noUncheckedIndexedAccess`, imports carry `.ts`. Biome: no formatting
enforcement, but keep style matching neighbors.

## Boundaries (hard)

- NO writes to the run record from harvest (schema closed; extensions unused here).
- NO ledger rows (DF2.8), NO fleet sweep (DF2.6), NO audit events (DF5.3), NO host-side
  re-verify/PR (DF5.1/2.2), NO `fleet` subcommands (DF3.1).
- NO substrate-specific command in harvest.ts/teardown.ts — only `driver.exec`/`copyFile`/
  `destroy` (D7). Host-side git via GitRunner is host-toolchain, allowed.
- Errors never carry key material; remediation references env-var NAMES only.
- Every step idempotent; missing-piece = normal path.

## Verified deviations register (Dev Agent Record material)

1. "Key file shredded" (story step 6) — no host-side key file exists (DF2.3 delivers via
   exec stdin; plaintext lives only in shredded mint temp + in-box .env). Destroy is the
   shred. DF2.3's header already reserves shred ownership.
2. `captureSpend` writes `spendMicroUsd` itself (DF2.3) — teardown adds no write.
3. Artifacts host dir `.sandbox/runs/<run-id>-artifacts/` — implementer's choice (inkwell
   naming), spec does not pin.
4. In-box artifacts list: inkwell's `specs app_docs adws/adw_data/ssmf.db run.log` +
   `trace.db` (DF1.4's store location TBD by its in-box writer — probe all, tar what
   exists; absence of ALL = `artifacts: none`).
