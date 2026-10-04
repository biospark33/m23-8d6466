# Fix report — fixer-leglib (round 1, wave A)

Scope honored: ONLY `scripts/p0-9/leg-lib.ts` touched (622 lines). ZERO edits
to `tests/p0-9/legs.test.ts` were needed — every existing leg-lib assertion
still passes against the hardened behavior (the pinned `requireBaseUrl` input
was already slash-free; the pinned `maskTail` strings were re-walked against
the new patterns and are idempotent under them). Nothing committed
(`scripts/p0-9/` + `tests/p0-9/` are untracked new files on this branch).

## Changes and per-finding disposition

### F-001 — forbiddenOrigin / requireBaseUrl hardening — FIXED
New private `normalizeOrigin()` (trim + strip trailing `/` repeatedly) shared
by both entry points. `forbiddenOrigin` now runs ONE trap-port table through
TWO documented layers:
1. normalized-suffix match (preserves the documented "any origin that ENDS in
   these port suffixes is a trap hit" semantic — including scheme-less
   spellings like `hindsight-qds:8888` where `new URL` reports no port);
2. `new URL(normalized).port` comparison, derived from the same table —
   closes the path/query-suffix bypass (`http://127.0.0.1:8888/mcp`,
   `?q=1`).
The task offered "normalize-then-suffix OR new-URL-port"; each alone leaves a
hole the finding explicitly names (suffix-only misses `/mcp`; URL-port-only
misses scheme-less spellings AND would regress the pinned
`http://hindsight-qds:8888` trap), so the composite is implemented with the
reasoning documented on the function. Unparseable origins fall through to
layer 1's verdict. The refusal message now carries both the raw and
normalized spelling. `requireBaseUrl` returns the NORMALIZED value (checked
value = used value).
Verified at runtime: `…:8888/`, `…:8888/mcp`, `" …:8888 "`, `…:8888?q=1`,
`…:18889/x` all trap; `…:18890`, `…:18890/`, `…:18890/v1`, no-port,
`:18888` all pass; `requireBaseUrl("  …:18890/  ")` → `…:18890`.

### F-009 — mock-in-closure-dir refusal — FIXED
`isInsideClosureDir()`: realpath both sides when they exist
(`realPathIfReachable`), separator-aware prefix check — `<closure>/sub` is
now refused, not just the exact path; symlinked/differently-spelled
candidates realpath to the same canonical dir and are refused. Verified:
`resolveEvidenceDir({mode:"mock", outDir: <closure>/sub})` throws /mock/;
an explicit scratch dir is honored.

### F-017 (export part) — FIXED
`LIVE_EVIDENCE_DIR` is now exported. New exported pure
`resolveEvidenceDir(deps: {mode; outDir?}): string` — explicit outDir
resolved verbatim (mock + inside-closure-dir REFUSED here), else
live→LIVE_EVIDENCE_DIR / mock→MOCK_REHEARSAL_DIR. `writeLegEvidence`
routes through it (one policy site); the F-017 follow-up test can now assert
routing + refusal without writing anything into the closure tree.

### F-018 (hoist part) — FIXED (additive; drivers migrate next wave)
- `extractBankIds(raw: unknown): string[]` — mirrors
  `src/hindsight/bank-provisioner.ts extractExistingBankIds` tolerance
  exactly (bare arrays; `{banks|items|data:[…]}`; per-entry
  `bank_id|bankId|id|string`; `name` only when `BankIdSchema`-valid);
  returns an array because drivers diff before/post snapshots. Runtime-checked
  against all six shapes.
- `safeRepoBase(repoSlug)` + `export const MAX_BASE_LEN = 52` — mirror of the
  provisioner's derivation (64 − len("-11") − len("-dev-meta")), cited.
- `rand6()` — the existing loop-guarded version, now exported (F-018's
  "unguarded rand6 x2" drift closes when drivers import it).
- `PROBE_DOWN_URL_DEFAULT = "http://127.0.0.1:9"` — story-cite comment (AC1's
  no-host:port-literal rule names leg-lib as the sanctioned home; loopback
  discard port; env-overridable at the call site via `QDS_PROBE_DOWN_URL`).

### F-021 — FIXED (by the PROBE_DOWN_URL_DEFAULT hoist above)

### F-022 (helper) — FIXED
`scanLiveShapePrereq(deps: {mode; outDir?}): {ok: true; file?: string} |
{ok: false; reason: string}` — semantics mirrored EXACTLY from
round-trip-dedicated.ts's private copy (same name filter
`*-p0-9-hindsight-live*.json`, same sort+reverse newest-first scan, same
parse-and-check-mode loop, byte-identical reason strings naming the DoD
ordering rule and the AC2 control) so its migration is mechanical. Mock mode
short-circuits `{ok:true}`. The ok-branch keeps round-trip's `file` field
(structural superset of the specified `{ok:true}`); the scan dir is
realpath-tolerant per the task. Runtime-checked: mock exempt / absent →
DoD-ordering reason / live-stamped → ok / only-mock-stamped → AC2 reason.

### F-025 (helper) — FIXED
`rerunAwareProvision(client: ProvisionClient, repoSlug, opts)` (+ exported
`RerunAwareProvisionOpts` / `RerunAwareProvisionResult`):
- fresh (resolved base absent from `opts.existingBankIds`) → `provisionBanks`
  verbatim (imported from `../../src/hindsight/bank-provisioner.ts`);
  `bridgeProbe` passes through; `noLock:true` is passed exactly when
  `opts.holdProvisionerLock` (F-005's hold-the-provisioner's-own-lock
  pattern);
- rerun (base present) → PUT-upsert `[base, base-dev-meta, COLLECTIVE_BANK_ID]`
  via `client.createBank`; `COLLECTIVE_BANK_ID` is IMPORTED from
  bank-provisioner (it is exported there) and re-exported from leg-lib so
  migrating drivers need one import;
- mode recorded per step via optional `opts.rec` (driver Rec) and always
  present on the return — never silent;
- base resolved via `resolveBankId` + `safeRepoBase` discipline.
Return shape is the specified `{mode, createdInAttempt, raw}` PLUS an `ok`
field — without it a caller cannot distinguish a failed provision (the
drivers' `provisionAttempt` carries ok); flagged here as a deliberate
superset. `createdInAttempt` is the provisionBanks roster on fresh-ok, `[]`
on rerun (the PUTs target pre-existing ids — documented on the type).
Runtime-checked all four paths: rerun-ok (exact roster, per-step mode),
fresh-ok (roster + createdInAttempt), fresh-failed (`ok:false`, raw = the
-32005 envelope), rerun-failed (`ok:false`, raw carries the roster).

### F-030 — FIXED
`writeEvidenceOrStderr(leg, payload, outDir?)`:
`{path, fellBack:false}` on success; on ANY throw from `writeLegEvidence`
the payload is dumped to stderr as ONE JSON line and `{path:"", fellBack:
true}` returns without rethrowing — an instance-mutating run never loses its
outcomes/residue to the evidence-write failure. Runtime-checked via a
closure-subdir refusal (the F-009 hardening supplies the throw).

### F-005 (stale-window part) — FIXED (additive)
`export const LEG_LOCK_STALE_MS = 900_000` with the edge-case-hunter M1
cite (the provisioner's 300s was derived for 3 banks × consolidate timeout;
the leg window adds a full corpus import). `LegDeps` gains optional
`lockStaleMs?: number`. Drivers consume both next wave.

### F-004 (helper) — FIXED
`assertQdsRepoSlug(repoSlug): string` — resolves via `resolveBankId`,
refuses non-`qds-`-prefixed results by throwing an Error whose message
carries code `bank_prefix_violation` + the INV-MEM-1 cite (message text
mirrors the CLI's `checkBankPrefix`), returns the resolved suffix-safe base
(`safeRepoBase`). Runtime-checked ok-path + violation path.

### F-019 — FIXED
`maskTail` gains three patterns beyond the original three shapes:
`Basic <cred>` headers; credential query params
(`[?&](…token|key|secret|password|credential…)=`); generic
credential-shaped assignments in ANY field position (JSON bodies, env dumps —
keys/names survive, values masked). During the four-pass defect hunt the
generic rule's `\S+` was caught gobbling past `&`/quote boundaries — on
compact JSON (`{"token":"a","status":"created"}`) it would have eaten the
remaining shape keys and degraded the exact evidence F-028's amendment
derives from; the value matcher is now `[^&\s"']+` (same stop class the
query rule uses). Boundary documented: scheme-less `Authorization: <raw>`
header positions remain unmasked (the three header rules are the header
contract; the generic rule targets field/assignment positions — adding
`authorization` to the generic list was tried and REJECTED because it
re-masked `authorization: bearer ***` into `authorization: *** ***`,
breaking a pinned assertion for zero safety gain). Runtime-checked: query
param masked mid-URL, `access_key` field masked, Basic masked,
`{"bank_id":…}` NOT over-masked, compact-JSON sibling keys survive.

## Deliberately NOT done (out of scope / next wave)
- Driver migration onto the hoisted helpers (F-002/F-029 baseUrl threading,
  F-006 driver extractor swap, F-024 recorder hoist) — additive-only per
  instructions; drivers currently import none of the new symbols, verified by
  the clean tsc pass.
- The two-layer origin approach is a documented composite of the two offered
  options (rationale above) — flagging for the diff reviewer's attention.

## Gate outputs (focal, per instructions)
- `bun test tests/p0-9/legs.test.ts -t "leg-lib"` → **7 pass / 0 fail / 22
  filtered** (0 expectation updates required).
- `bunx tsc --noEmit` → **0 errors** (whole repo, including other fixers'
  concurrent in-flight edits).
- `bunx @biomejs/biome check scripts/p0-9/leg-lib.ts` → **clean** ("Checked
  1 file … No fixes applied").
- Unfiltered suites NOT run, per instructions. `detect_changes()`/`impact()`
  could not be used: the GitNexus index predates this branch's new files
  (`scripts/p0-9/leg-lib.ts` → "Target not found"); grep blast radius stood
  in — 6 drivers + tests/p0-9/legs.test.ts import leg-lib, all changes
  hardening or additive. Nothing committed, so no pre-commit gate applies.

## Known deviation
`leg-lib.ts` is 622 lines, over the global ≤500 style rule. The task's file
scope (leg-lib.ts only) forbids splitting; the review wave's citation-bearing
doc comments are load-bearing for the next waves' mechanical migrations.
Redundant prose was trimmed where it duplicated `resolveEvidenceDir`'s policy
doc. If the overage matters, the natural split next wave is
`leg-lib.ts` (traps/masking/evidence) + `leg-lib-roster.ts`
(extractBankIds/safeRepoBase/rerunAwareProvision/scanLiveShapePrereq).
