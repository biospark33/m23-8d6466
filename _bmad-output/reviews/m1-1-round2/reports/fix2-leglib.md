# fix2-leglib — round-2 fix wave A, scope: scripts/p0-9/leg-lib.ts

Branch `feature/m1-1-dedicated-hindsight-vps`. Files touched:
`scripts/p0-9/leg-lib.ts` + the leg-lib describe block of
`tests/p0-9/legs.test.ts` (pin updates where behavior changed + new unit
tests). No commits made. All nine assigned findings implemented.

## R2-001 (HIGH) — scanLiveShapePrereq accepts FAILED live evidence

`scanLiveShapePrereq` now requires `parsed.ok === true` in addition to
`parsed.mode === "live"`. A live-mode run that fatal'd or failed still
writes `mode:"live"` evidence; the gate previously passed on it (the AC1
ordering control was one failed first run from vacuous). The fall-through
reason string now names both requirements: `…none stamped mode:"live" AND
ok:true — a FAILED live shape-check run (or a mock-stamped prereq) cannot
gate a live leg: the AC1 ordering gate proves the shape check PASSED, not
merely ran…`. Function doc comment extended. All existing
`writePrereqFixture`-based driver tests already stamp `ok: true`, so no
driver-block pins changed.

## R2-002 (HIGH) — lock-staleness asymmetry (900s leg window vs 300s provisioner steal)

New export `acquireHeartbeatLock(lockPath, opts: {staleMs, heartbeatMs?,
holder?})` wrapping `src/lib/file-lock.ts` `acquireFileLock`:

- acquires with `isStale = opts.holder ?? ({ageMs}) => ageMs >= opts.staleMs`
  (`holder` lets a driver substitute its pid-aware predicate);
- on success reads the lock's `<pid>:<nonce>` content once, then a
  `setInterval` (default 60_000ms) refreshes the file's **mtime only** via
  `utimesSync` — content is never rewritten, so `trySteal`'s claim
  re-verification and `releaseOwn`'s content check still see exactly this
  acquisition's lock. The touch is content-verified first: a taken-over
  lock is never refreshed (read → compare → utimes);
- the interval is `unref?.()`-guarded (no event-loop pin if the runtime
  supports it); release clears the interval BEFORE the inner release, so
  taken-over paths (where the inner release throws) never leak the timer.

Doc comment records WHY: the provision family shares one lock path with
two staleness budgets; a live heartbeat keeps the mtime young so the
provisioner's 300s age-only steal never fires against a held leg window.
Drivers migrate next wave — this wave delivers the primitive + tests.

Tests (leg-lib block, real short-interval timing, no fake timers): mtime
advances while held and content is byte-identical; a provisioner-style
thief (`isStale: ageMs >= 100` after 120ms with 25ms beats) returns null
(the asymmetry, closed); the contrast test reproduces the bug — the same
age-steal DOES take a bare `acquireFileLock` hold, and the original
holder's release then throws `/taken over/`; release removes the lock
file. Full-file `bun test` exits 0 → no dangling timers.

## R2-010 (MED) — closure-dir refusal escape on darwin case-insensitivity

`isInsideClosureDir` now compares case-insensitively (both the equality
and the `sep`-anchored prefix) when `process.platform === "darwin" ||
"win32"`, exact otherwise. This covers the lexical-fallback branch where
the candidate does not exist yet and `realpathSync` cannot canonicalize
the spelling — the exact case where APFS later case-folds the `mkdir`
onto the real `p0-9-closure` dir. Doc comment softened per R2-023: the
residual ceiling is a pre-planted symlink at a nonexistent path steering
the lexical fallback; the real defense is mkdir UNDER the resolved dir.
New platform-gated test (`skipIf` non-darwin/win32): a
`P0-9-CLOSURE/not-yet-created-sub` outDir is refused in mock mode.

## R2-011-helper — rerunAwareProvision: provisionImpl, onStep, honest createdInAttempt

- `RerunAwareProvisionOpts` gains `provisionImpl?: (opts: ProvisionOptions)
  => Promise<ProvisionResult>` (wins over `provisionBanks` on the fresh
  path — verified by capturing the opts it receives) and
  `onStep?: (step: {label, mode, ok, detail?}) => void`, fired at every
  point `rec` records (fresh ok/failed/failed-thrown, per-bank rerun
  ok/failed-thrown, rerun final ok), with `label: "provision"` and the
  lane's mode.
- Rerun-success `createdInAttempt` = roster members ABSENT from
  `existingBankIds` (a recreated `-dev-meta` is a creation, honestly
  reported). Failure paths still report `[]` — the caller's post∖pre diff
  is the authority under failure. The result-interface doc records this.
  Fresh path unchanged.
- Tests: fresh lane with injected impl (asserts the override ran, banks
  propagated, onStep fired); rerun with `-dev-meta` missing reports
  exactly `["qds-factory-dev-meta"]`; full-roster rerun reports `[]`.

## R2-014 (LOW) — maskTail over-masking and value-class truncation

Field-name matchers rebuilt on exact `\b`-anchored words
(`CREDENTIAL_FIELD_WORDS = api_key|apikey|authorization|bearer|
credential|key|password|secret|token`): `keyword`, `monkey`, `keynote`
no longer mask; all nine required words do (JSON keys `"apiKey"`
case-insensitively, hyphenated `X-Api-Key` via the `key` word boundary).
Quoted values now mask whole, to the closing quote
(`"apiKey":"ab&cd"` → `"apiKey":"***"`; single-quoted too; an unclosed
quote masks to end of string). Unquoted values keep the
`[^\s,&"']+` class with the ceiling documented in the doc comment
(exotic unquoted `&`/whitespace-containing values partially masked).
Query params (`?token=…`) keep `&` as the delimiter by design and use
the exact-word list. HINDSIGHT_* rules got the same quoted/unquoted
treatment.

Behavior-change pin updates (the only existing pins touched): the three
header lines now double-mask the scheme word because
`authorization`/`bearer` are field words — `Authorization: Bearer
sekrit-token-123` → `Authorization: *** ***` (fail-closed direction;
also closes the previously documented `Authorization: <raw>` gap).
Everything else in the old pin set is byte-identical.

## R2-015 (LOW) — sanitizeOrigin

New export `sanitizeOrigin(origin: string): string`: URL-parse, clear
`username`/`password`, reconstruct (WHATWG reconstruction appends `/`
when the input had no path — documented); unparseable input degrades to
`"***"` rather than passing through verbatim. Drivers route their
`LegEvidence.origin` and probe origins through it next wave.

## R2-016 (LOW) — forbiddenOrigin layer order

Layers reordered: when the input parses as a WHATWG URL the decision is
made on `url.port` ONLY; the normalized-suffix layer runs ONLY for input
the URL parser rejects. Fixes the false refusal of
`http://127.0.0.1:18890/prefix:8888` (dedicated port, trap-looking path
tail). The edge-hunter-verified catch-sets are preserved and now pinned
in a new adversarial-table test: path-suffix elision
(`http://127.0.0.1:8888/../x`), leading-zero port (`:08888`), userinfo
(`http://safe@127.0.0.1:8888/`), IPv6 (`[::1]:8888`,
`[::ffff:127.0.0.1]:18889`), trim/slash-strip, and raw unparseable
`127.0.0.1:8888` / `127.0.0.1:18889` spellings. Clean set pinned:
`http://127.0.0.1:18890/prefix:8888`, `http://[::8888]` (host, no
port), `:18888`. Documented residual: a scheme-less spelling that
parses as an OPAQUE URL (`hindsight-qds:8888` → scheme, empty port)
takes the port-only verdict and passes — acceptable because an opaque
URL cannot serve as a fetch base, so no wrong-instance write path runs
through it.

## R2-018-helper — resolveRepoSlug

New export `resolveRepoSlug(env): string` = `env.QDS_REPO_SLUG ??
path.basename(process.cwd())` — the ONE default. Drivers migrate next
wave.

## R2-021 (LOW) — assertQdsRepoSlug refuses the collective id

`assertQdsRepoSlug` now throws (error code `collective_id_slug:`) when
`resolveBankId(repoSlug) === COLLECTIVE_BANK_ID`, before the prefix
check. The message names the reason: the fixed collective roster id is
not a repo base; as a slug it takes the rerun lane permanently and mints
`qds-collective-dev-meta` junk. Catches normalization variants
(`QDS_Collective` → resolves to the same id). Prefix-gate behavior
otherwise unchanged.

## Verification (four-pass, all green)

- `bun test tests/p0-9/legs.test.ts -t "leg-lib"` → exit 0, 16 pass /
  0 fail (was 7 tests; +8 new, 1 extended, maskTail pins updated).
- Full unfiltered `bun test tests/p0-9/legs.test.ts` → exit 0, 40 pass /
  0 fail — process exits cleanly, no dangling heartbeat timers.
- `bunx tsc --noEmit` → exit 0 (repo-wide).
- `bunx @biomejs/biome check scripts/p0-9/leg-lib.ts
  tests/p0-9/legs.test.ts` → exit 0 (one `useRegexLiterals` fix applied:
  the non-interpolated HINDSIGHT unquoted rule became a regex literal).
- Collateral check (not required, cheap): `bun test
  tests/provision-hindsight-banks.test.ts` → exit 0, 46 pass / 0 fail —
  the CLI suite that consumes `rerunAwareProvision` is unaffected by the
  honest-`createdInAttempt` change.

Not done here (per wave split): driver/CLI migration onto
`acquireHeartbeatLock`, `sanitizeOrigin`, `resolveRepoSlug`,
`provisionImpl`/`onStep` (next wave); R2-023 (dismissed), R2-025/R2-026
(deferred) untouched.
