# fix2-drivers-cli — round-2 fix wave B, scope: drivers + CLI

Branch `feature/m1-1-dedicated-hindsight-vps`. Files touched (mine):
`scripts/p0-9/{hindsight-live,provision-and-import,idempotency-rerun,
round-trip-dedicated,negative-probes,auth-retired-check}.ts` +
`scripts/provision-hindsight-banks.ts` (adds-only, 0 removed lines vs HEAD,
verified) + `tests/provision-hindsight-banks.test.ts` (+8 tests). NOT touched:
`scripts/p0-9/leg-lib.ts` (wave A's surface, consumed as landed),
`tests/p0-9/legs.test.ts` (wave C's). No commits made.

Impact discipline: GitNexus' index predates the uncommitted round-1 driver
files (`impact` on checkBankPrefix/provisionOnce/provisionAttempt → "not
found"), so blast radius was established by caller analysis instead: every
touched symbol is driver-internal or an export consumed only by the two
in-scope test files. `detect_changes` (unstaged): risk LOW, affected_count 0,
no affected processes; changed symbols confined to the CLI/test files in
scope (the `src/hindsight/client.ts` hits are the other wave's).

## R2-002 — lock-staleness asymmetry (both provision-family legs)

provision-and-import + idempotency-rerun migrate `acquireFileLock` → leg-lib
`acquireHeartbeatLock(lockPath, {staleMs, holder})`, keeping each driver's
pid-aware staleness predicate as `holder`. The leg window now refreshes the
lock file's mtime (60s beats) while held, so a concurrent provisionBanks/CLI
run's 300s age-only steal never fires against a live window; release clears
the interval inside the wrapper. Both drivers' header docs updated.

## R2-003 (HIGH) — hindsight-live mock rehearsal not hermetic

`fetchImpl` default is now `deps.fetchImpl ?? (mode === "live" ?
globalThis.fetch : undefined)`. A mock run without an injected fetchImpl
records `health-probe: skipped-hermetic` and `shape-probe: skipped-hermetic`
(unmeasured, no network) and fails the leg honestly (exit 1 — nothing was
proven); the probe-bank lifecycle never runs on that path, so nothing is
created or stranded. Empirically verified:

```
{"ok":false,"exitCode":1,"origin":"http://127.0.0.1:18890/",
 "steps":["health-probe:skipped-hermetic","digest-identity:skipped-mock",
          "shape-probe:skipped-hermetic"]}
```

## R2-004 (HIGH) — CLI snapshot fails OPEN

Adds-only pattern: the legacy best-effort try/catch stays verbatim; when its
snapshot reads EMPTY (the ambiguous case — healthy empty roster vs swallowed
failure), main re-asks once through a new exported seam
`takeRerunSnapshot(client)`: a THROW prints the
`{ok:false, requestId, error:{code:"snapshot_failed", …}}` envelope and
exits 1; an answering roster keeps the fresh lane (emptiness is a
classification). Double listBanks cost is paid only on the ambiguous path —
a populated instance snapshots once.

## R2-005 — CLI rerun lanes mutate the roster with no lock

Both topologies' rerun path is now ONE added gate in main (placed before the
`--no-bridge-probe` fork) that wraps `rerunAwareProvision` in
`acquireHeartbeatLock(join(homedir(), ".hindsight", "provision.lock"),
{staleMs: LEG_LOCK_STALE_MS})` — the provisioner's own path (the helper's
rerun branch is unlocked by design, so the CLI wraps at the call site;
release in finally). Lock acquisition errors and a busy lock each print
their own envelope (`provision_lock_error` / `provision_lock_busy`) and
exit 1.

## R2-006 — auth-retired probe-bank create dead on the live path

Live `main()` now constructs `new HindsightClient({baseUrl, mode:"live"})`
(baseUrl threaded via `requireBaseUrl`, env-failure left to runLeg's
fatal-env evidence) and passes it as `deps.client`, so the probe-bank CREATE
runs on the box and cleanup prefers `client.deleteBank`. A create failure
remains its own recorded step; the refusal classes absorb the existence
confound.

## R2-007 — rerun-lane stdout envelopes off-contract

New exported `buildRerunEnvelope(repoSlug, requestId, result)` normalizes to
the committed `{ok, banks, requestId, mode, createdInAttempt}` (+ `error
{code:"provision_failed", message}` on failure; `banks` = the canonical
PUT-upsert roster). main prints it verbatim on the rerun gate.

## R2-008 — no timeout budget on hindsight-live raw paths

`PROBE_TIMEOUT_MS = 10_000` (sibling parity with auth-retired-check's
constant) AbortController budgets on the health probe AND both raw
retain/recall calls; an abort records `failed-timeout` (distinct from
`failed-transport`) and fails the leg — never a hang. Timers cleared in
`finally`.

## R2-009 — refused-unclassified narrated as ANSWERED

`buildContainmentStatement` gains an `answered` parameter and a fourth
verdict branch: measured + neither auth-refused, non-auth-refused, nor
answered → "Measured verdict: INCONCLUSIVE — …refused with an UNCLASSIFIED
status…neither retired nor answered…no verdict is asserted from an
unclassifiable refusal". `dangerRetired` stays false there (unchanged —
only `refused-auth` sets it).

## R2-011 — rerunAwareProvision consolidation gaps

- provision-and-import: `provisionAttempt`'s local provisionImpl fork is
  DELETED; the injected impl and the step recorder thread through the
  helper's opts (`provisionImpl` wins on the fresh path, `rec` records every
  step with its lane mode). It now also returns the helper's honest
  `createdInAttempt` (the R2-019 residue source).
- idempotency-rerun: `provisionOnce` is now the thin wrapper the directive
  sketches — snapshots existing-ids per run, calls the helper with
  `{provisionImpl?, rec→provision-<n> relabel, holdProvisionerLock:true}`,
  returns `{ok, createdInAttempt}`; the inline fork is gone.
- CLI: `onStep` threaded minimally (one `provision-step` JSON line per step
  on stderr; stdout stays envelope-only). Driver-side onStep is `rec` —
  leg-lib's onStep doc scopes it to non-driver callers; noted here in case
  the round-3 reviewer wants the literal opt on the drivers too.
- Shared-lane discarded probe POST: killed — the rerun gate issues NO
  bridge probe (the rerun branch never reads the verdict); realBridgeProbe
  now fires only on fresh lanes.

## R2-012 — prefix guard value ≠ minted value

`checkBankPrefix` (adds-only guards after the legacy prefix check): the
fixed collective id is refused (see R2-021), and a slug long enough to
truncate returns `safeRepoBase(repoSlug)` so the guard value IS the minted
value. The legacy `return {ok:true, bankId}` line is reached only when
truncation is a no-op.

## R2-013 — negative-probes counts any HTTP answer as unavailability proof

`downRefused` is set ONLY for transport-error/timeout classes
(408-timeout / fetch_failed / transport-error; a defensive `http_*` class
out of the raw-fetch catch is treated as answered). ANY HTTP response on the
down URL — even 5xx — records class `http_<status>`, marks the probe
unproven, and fails the leg. Evidence fields and header doc updated.

## R2-015 — unmasked origins in evidence

All six drivers + both evidence builders route recorded origins through
leg-lib `sanitizeOrigin` (`origin === "" ? "" : sanitizeOrigin(origin)` — an
unresolved origin stays empty); negative-probes' `downOrigin` too. NOTE
(scope): applied to provision-and-import/idempotency-rerun as well although
the wave split didn't list it there — the finding is repo-wide, the change
is one line per identical `finalize`, and no pins exist for those drivers'
origin values. The CLI prints no standalone origin field (only
forbiddenOrigin's diagnostic text names trap origins), so nothing to
sanitize there.

## R2-017 — optional listBanks yields vacuous green

`ListRecallClient.listBanks` is required (non-optional); both snapshot call
sites drop `?.`; a runtime `typeof !== "function"` check after client
construction is a fatal exit-2 refusal ("never a vacuous [] snapshot").

## R2-018 — repo-slug default divergence

round-trip-dedicated's literal `"qds-factory"` default is DELETED —
`assertQdsRepoSlug(resolveRepoSlug(process.env))`. provision-and-import +
idempotency-rerun migrate their inline `QDS_REPO_SLUG ?? basename(cwd)` onto
the same helper (behavior-identical; one default everywhere). Doc comments
updated.

## R2-019 — post-snapshot failure abandons compensation with residue:[]

provision-and-import: on snapshot-post failure, `ext.residue` := the
attempt's honest `createdInAttempt` (helper figure — [] under a failed
attempt, where the unavailable post∖pre diff stays the authority) plus a
`residueReason: "unconfirmed-delete…"` label; the step detail keeps the
abandonment reason. idempotency-rerun: same treatment on `post` failure
(attempt-1 creations) and `post2` failure (union of both attempts'
creations).

## R2-020 — mkdirSync outside the lock try

Both provision-family legs move `mkdirSync(dirname(lockPath))` INSIDE the
lock try — a file-shaped dirname or EACCES now resolves fatal LegEvidence
via the existing `rec("lock","fatal")` → `writeEvidenceOrStderr` path.

## R2-021 — collective id as repo slug at the CLI

Covered via the checkBankPrefix guard above (refusal message names the
`qds-collective-dev-meta` junk); leg-lib's `assertQdsRepoSlug` (wave A)
covers the drivers.

## Verification (four-pass, all green)

- `bun test tests/provision-hindsight-banks.test.ts` → exit 0, **54 pass /
  0 fail** (was 46; +8: snapshot fail-closed ×3, envelope ×3, collective +
  truncated-id ×2).
- Filtered legs blocks, final pass: `hindsight-live` 7/0, `provision-and-import`
  4/0, `idempotency-rerun` 2/0, `round-trip` 5/0, `negative-probes` 2/0,
  `auth-retired` 6/0 — all exit 0. No unfiltered legs.test.ts run (wave C's).
- `bunx tsc --noEmit` → exit 0 (one TS6133 fixed: unused `step` param in
  idempotency-rerun's relabeling recorder).
- `bunx @biomejs/biome check scripts/p0-9/
  scripts/provision-hindsight-banks.ts
  tests/provision-hindsight-banks.test.ts` → exit 0 (9 files, no fixes).
- Adds-only: `git diff HEAD -- scripts/provision-hindsight-banks.ts` →
  **0 removed lines** (pure additions, cumulative round-1+round-2).
- `detect_changes` (unstaged): risk LOW, 0 affected symbols/processes.

## Pin conflicts

- `tests/p0-9/legs.test.ts:732` — `expect(ev.origin).toBe(origin)` on the
  hindsight-live trap-origin test breaks under R2-015 (sanitizeOrigin's
  WHATWG reconstruction appends "/"). Flagged to fix-tests-legs up front;
  by the time my filtered run executed they had already updated the pin to
  `toBe(sanitizeOrigin(origin))` — RESOLVED, no open conflict.
- negative-probes' recorded `downOrigin` gains the same trailing slash —
  no pin existed; no conflict.
- No other conflicts: all six filtered blocks green without any legs.test.ts
  edit from me.

## Adds-only accommodations worth a reviewer's eye

- main()'s legacy rerun forks (both lanes) are now logically fresh-only —
  the added rerun gate returns first. They remain compiler-reachable (no
  biome noUnreachable issue) and are commented as fresh-only in the gate's
  block comment; deleting them would break the zero-removed-lines rule.
- R2-004's re-ask fires only when the legacy snapshot reads empty (see
  above) — the cost/ambiguity tradeoff is documented at the seam.
