# Fix wave B — CLI + client (fixer-cli-client, round 1, scope m1-1)

Files touched (only): `scripts/provision-hindsight-banks.ts`,
`src/hindsight/client.ts`, `tests/hindsight/client.test.ts`,
`tests/provision-hindsight-banks.test.ts`. No commit made.

## Per-finding disposition

### F-003 (HIGH) + F-013 (LOW) — checkHindsightBaseUrl hardened — FIXED
- `checkHindsightBaseUrl` now imports `forbiddenOrigin` from
  `scripts/p0-9/leg-lib.ts` (single source — same normalization and
  :8888/:18889 suffix + URL-port matching the six leg drivers gate on) and
  refuses trap origins with a **distinct code `base_url_trap`** (documented
  choice: operators and tests can tell "did not set it" apart from "set it
  to the wrong instance"; the union on the false branch was widened — every
  line of the function is uncommitted story addition, so this is
  adds-only-safe).
- Whitespace-only values are refused as `base_url_required`
  ("unset/empty/whitespace-only"; the message retains the pinned substrings
  `127.0.0.1:8888`, `§6.4`, `AC1`).
- Returns the CHECKED (normalized: trimmed, trailing slashes stripped)
  value; main threads it via a one-line env writeback
  (`process.env.HINDSIGHT_BASE_URL = baseUrlCheck.baseUrl`) placed before
  the client construction. Mechanism note: the construction line
  `new HindsightClient({ baseUrl: process.env.HINDSIGHT_BASE_URL })` is
  COMMITTED code (untouchable under adds-only), so the writeback is how
  "the checked value is the used value / single env read" is achieved
  additively — process-local, main() exits right after. The
  discard-and-reread divergence is gone.

### F-025-CLI (HIGH) — rerun-aware provisioning, BOTH lanes — FIXED
- New exported pure seam `isRerunProvision(existingBankIds, repoSlug)`:
  true iff the snapshot contains the base id leg-lib `safeRepoBase`
  (resolveBankId + ≤52-char truncation, same derivation as the provisioner
  resolver) would land on. A suffixed junk id (`qds-factory-2`) is NOT the
  base.
- main() takes a pre-provision snapshot via `client.listBanks()` +
  leg-lib `extractBankIds` (provisioner-tolerance extractor — a stricter
  reader would silently flip reruns to the fresh lane on shape variance).
  listBanks transport failure yields an empty snapshot → fresh path →
  `provisionBanks` owns the failure envelope (-32002); the snapshot can
  never turn a provision refusal into an unhandled crash.
- Dedicated lane (`--no-bridge-probe`): fork via `isRerunProvision` —
  base absent → `provisionBanks` verbatim (unchanged envelope/behavior);
  base present → leg-lib `rerunAwareProvision` (imported, single source:
  PUT-upsert of the canonical roster [base, base-dev-meta, qds-collective],
  no junk `-2` bank). The rerun envelope carries `mode:
  "reupsert-existing"` + `raw.roster` — mode recorded in the printed
  result, so the second run's output proves the demo rather than merely
  passing.
- Shared (bridge-probe) lane: an inserted rerun block BEFORE the committed
  fresh-path tail applies the same discipline (same roster, same helper).
  The probe still fires first (shared-lane identity); its verdict gates
  only the fresh branch — the rerun branch upserts our own existing roster
  and creates nothing, so AC-4's not-registered gate (a first-provision
  control, legitimately skipped by the dedicated lane under DD-17) does not
  apply. The committed fresh tail (`realBridgeProbe` + `provisionBanks`
  verbatim) is untouched and still serves the first run — this is how both
  lanes became rerun-aware with zero removed lines (an unconditional
  early-return block would have made the committed tail statically
  unreachable and failed tsc).

### F-014 (LOW) — parseArgs no longer mutates the caller's argv — FIXED
- The splice loop (uncommitted addition — freely rewritable) is replaced
  with `argv = argv.filter(token => token !== "--no-bridge-probe")` plus a
  `hadBoolFlag` capture. parseValueFlags receives the filtered copy; the
  caller's array is never touched (pinned by a new test).
- Mechanism note: the `parseValueFlags(argv, {` call line is COMMITTED, and
  biome's `noParameterAssign` (recommended, repo config) forbids the
  parameter rebind — resolved with a one-line
  `// biome-ignore lint/style/noParameterAssign:` suppression carrying the
  rationale in place (same house pattern as the repo's existing
  `biome-ignore lint/performance/noDelete:` comments). The alternative —
  a local variable handed to the value-flag walk — would require editing
  the committed call line (one removed line). Suppression chosen to keep
  the adds-only gate at zero.
- Grammar unchanged: `--no-bridge-probe=true` still throws unknown-flag;
  bare bool still parses; multiple occurrences still collapse to one flag.

### F-015 (LOW) — deleteBank success:false — FIXED
- 2xx body with `success === false` (explicit false only — missing key and
  non-object bodies fall through) now throws
  `HindsightHttpError(502, "delete refused by server", requestId)`; the
  existing catch rethrows it (502 ≠ 404). Documented as defensive
  (INV-HM5-style): the 0.10.0 wire never does this per Track A, but the
  method's own narrowing concedes shape uncertainty and a refused delete
  reported as `{deleted:true}` would poison AC3 compensation accounting.
- Kept semantics pinned by a new test: numeric `deleted_count: 0` →
  already-gone; non-numeric `deleted_count` (including string `"0"`) →
  field absent, `deleted:true`.
- Blast-radius check: the p0-9 drivers consume deleteBank through injected
  structural fakes; no `success:false` delete body exists anywhere in the
  repo — the new throw cannot fire in their suites.

### F-016 (LOW) — test fetch/env restore — VERIFIED, DISMISSED (no patch)
The blind-hunter claim (assignments at client.test.ts:~399 and provision
test:~464 lack restore) is CONTRADICTED by source; the edge-case-hunter's
no-finding is correct. Evidence from reading both files:
- `tests/hindsight/client.test.ts:102-104` — a FILE-SCOPE
  `afterEach(() => { globalThis.fetch = originalFetch; })` runs after
  EVERY test in the file, covering both the mock-mode describe's sentinel
  assignment (its own beforeEach at 393-400, which ALSO has a paired
  afterEach at 401-403) and the deleteBank mock test's inline assignment
  (~line 540). `HINDSIGHT_BEARER_TOKEN` assignments are try/finally +
  `delete`-wrapped (349-378, 469-489). There are NO SWARMCLAW_* env
  assignments in client.test.ts at all.
- `tests/provision-hindsight-banks.test.ts:26-38` — a FILE-SCOPE
  afterEach restores `globalThis.fetch` AND deletes SWARMCLAW_BASE_URL /
  SWARMCLAW_MCP_SERVER_ID / SWARMCLAW_AUTH_TOKEN, covering every fetch/env
  assignment in the file including the `resolveProbe(false)` test the blind
  hunter cited; the HINDSIGHT_BASE_URL describe has its own afterEach
  (336-339).
The blind hunter read local diff context and missed the file-scope hooks
(both restore blocks sit outside the hunks it cited). No gap; nothing
patched.

## New/updated tests (both test files owned by this wave)
- client.test.ts: `success:false` → 502 throw (status/message/requestId
  pinned); string `"0"` deleted_count → absent-branch pin.
- provision test: trap refusals (`:8888` exact, padded + trailing-slash
  spelling, `:18889`) all → `base_url_trap`; whitespace-only →
  `base_url_required`; padded valid origin → ok with normalized echo;
  parseArgs no-mutation (caller array intact + result correct);
  `isRerunProvision` fork (base present / empty snapshot / junk-suffixed id
  / resolver-derived base, unresolved spelling does not flip).
- No existing expectation needed changing — the hardened guard keeps every
  pinned substring and the ok-path echo identical.
- Coverage note: "exit 1 + no client construction" for the trap and the
  PUT-upsert roster behavior are main()/leg-lib behavior respectively —
  main is not injectable (house pattern: pinned at the exported seam the
  file already uses), and the roster discipline is leg-lib
  rerunAwareProvision's own tested contract (tests/p0-9 — deliberately not
  run by this wave).

## Gates (focal only; tests/p0-9 and other suites NOT run)
- `bun test tests/hindsight/client.test.ts` → exit 0, **31 pass / 0 fail**
- `bun test tests/provision-hindsight-banks.test.ts` → exit 0, **46 pass / 0 fail**
- `bunx tsc --noEmit` → **0 errors** (repo-wide)
- `bunx @biomejs/biome check src/hindsight/client.ts scripts/provision-hindsight-banks.ts tests/hindsight/client.test.ts tests/provision-hindsight-banks.test.ts` → **clean, exit 0**

## Adds-only confirmation (git diff vs HEAD, working tree)
- `scripts/provision-hindsight-banks.ts`: **+278 / −0** — zero removed lines.
- `src/hindsight/client.ts`: **+81 / −0** — zero removed lines.
- `tests/hindsight/client.test.ts`: +116 / −0.
- `tests/provision-hindsight-banks.test.ts`: +231 / −1 — the single
  removed line is the test-file import list being widened (same edit the
  pre-existing story diff already contained; test files are exempt from the
  adds-only instruction).
- The script's ONE lint suppression (`noParameterAssign`, F-014) and the
  env writeback (F-013) are the two mechanisms that kept the committed
  `parseValueFlags(argv, …)` and `new HindsightClient({ baseUrl: env })`
  lines untouched; both carry their rationale inline.
