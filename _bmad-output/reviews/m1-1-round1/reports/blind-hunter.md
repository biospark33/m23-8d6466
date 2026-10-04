# Blind Hunter — Cynical Review (round 1, M1.1 diff)

Input: `/tmp/m1-review-diff.txt` only. Every finding below is provable from the diff itself; anything not provable is labeled SPECULATION.

- **Live-mode HindsightClient constructed WITHOUT the trap-checked baseUrl — client traffic goes to the silent 127.0.0.1:8888 default (or unchecked env), not the resolved origin** — HIGH — `scripts/p0-9/hindsight-live.ts:254`, `scripts/p0-9/provision-and-import.ts:547`, `scripts/p0-9/idempotency-rerun.ts:344`
  All three drivers resolve + trap-check `baseUrl`, then never hand it to the client:
  ```
  const client = (deps.client ?? new HindsightClient(mode === "live" ? {} : { mode: "mock" })) as ProbeClient;
  ```
  (identical shape in provision-and-import.ts:547 and idempotency-rerun.ts:344). The diff's own documentation defines the consequence: leg-lib says "the HindsightClient constructor silently falls back to `DEFAULT_BASE_URL = http://127.0.0.1:8888`" — the exact wrong-instance trap. On a live run without an injected client, `createBank`/`deleteBank`/`listBanks`/`retain` hit an origin that was never trap-checked (constructor default, or env if the constructor reads it — either way NOT the deps.baseUrl the driver verified), while the raw `fetchImpl` calls use `${baseUrl}`. Two different origins in one leg; a `deps.baseUrl` override is silently ignored by the client. The hindsight-live header's claim "No connection host:port literal in this file — the origin always arrives via deps/env and is trap-checked (leg-lib forbiddenOrigin) before any use" is false for this path. Contrast `round-trip-dedicated.ts` and `negative-probes.ts`, which both do it correctly: `new HindsightClient({ baseUrl, mode: ... })` — the inconsistency proves the omission is a bug, not a convention. In provision-and-import this is the entire provision/import/compensation flow.

- **forbiddenOrigin port-suffix match is bypassed by a trailing slash, path, or whitespace** — HIGH — `scripts/p0-9/leg-lib.ts:99-109`
  ```
  const FORBIDDEN_ORIGIN_PORT_SUFFIXES = [":8888", ":18889"] as const;
  ...
  if (origin.endsWith(suffix)) {
  ```
  `"http://127.0.0.1:8888/"` (trailing slash), `"http://127.0.0.1:8888/mcp"`, or `"http://127.0.0.1:8888 "` (trailing space) all fail `endsWith(":8888")` and pass the trap. `requireBaseUrl` (leg-lib.ts:241) makes this worse: it validates `url.trim() === ""` but **returns the untrimmed value**, so `"http://127.0.0.1:8888 "` clears both the emptiness check and the trap check and becomes the client's origin. A trailing-slash base URL is a routine ops mistake; the result is the exact wrong-instance write class the whole INV-MEM-1 apparatus exists to prevent, with the guard reporting itself satisfied. The test suite pins `:18888` not tripping but never tests trailing-slash/path/whitespace variants. Parsing the URL and comparing `port` would close it.

- **auth-retired-check never creates its probe bank — `dangerRetired` can be vacuously true (bank-missing refusal misread as auth refusal)** — MEDIUM — `scripts/p0-9/auth-retired-check.ts:227`
  ```
  const probeBankId = `qds-probe-${deps.now?.() ?? Date.now()}`;
  ...
  const retainProbe = await rawCall(f, unauthUrl, "POST", noAuth, {...});
  ```
  The driver POSTs retains/recalls to `/v1/default/banks/qds-probe-<ts>/memories` and finally-DELETEs the bank, but contains no `createBank` anywhere. The diff's own Track A notes establish that this Hindsight does not uniformly require bank existence (recall on a missing bank answers 200-empty; profile 404s). If retain to a nonexistent bank is refused for existence reasons, `unauthenticated.measured && !unauthenticated.answered` → `dangerRetired: true` — a false "0.8.6 danger retired" verdict attributed to auth. Compare hindsight-live, which explicitly `createBank`s its disposable probe bank before probing it. Either create the bank or document why nonexistence cannot confound the measurement.

- **negative-probes' extractBankIds is strictly weaker than its two siblings — the zero-banks proof can be vacuously green** — MEDIUM — `scripts/p0-9/negative-probes.ts:87-106`
  ```
  const list = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" && Array.isArray((raw as { banks?: unknown }).banks) ? ((raw as { banks: unknown[] }).banks as unknown[]) : [];
  ... typeof (entry as { bank_id?: unknown }).bank_id === "string"
  ```
  Only the `banks` key and the `bank_id` field are understood. provision-and-import.ts:1375 and idempotency-rerun.ts:1972 both mirror "bank-provisioner.ts extractExistingBankIds tolerance ({banks:[{bank_id|bankId|id}]}, {banks:[string]}, bare arrays; `name` only when schema-valid)" — handling `items`/`data`/`bankId`/`id`/`name`. If the live API returns camelCase `bankId` (or `items`), negative-probes snapshots are `[]` both times, `rosterUnchanged` is vacuously true, and the leg's headline claim ("The zero-banks claim is diffed, not assumed") is unproven while the same payload diffs correctly in the other drivers. Three divergent copies of the same function in one diff is itself the evidence.

- **auth-retired-check exits 0 (green) on a fully-skipped hermetic run — green by vacuity** — MEDIUM — `scripts/p0-9/auth-retired-check.ts:392`
  ```
  const ok = cleanup.outcome !== "failed";
  ```
  With no injected fetchImpl in mock mode: every probe is `skipped`, `cleanup` is `{outcome: "skipped"}` (no transport, no client), `ok` is true, `exitCode` 0. The header's own contract says "Exit: 0 probes recorded (whatever they measured)" — zero probes were recorded. Contrast negative-probes, which deliberately fails its equivalent path ("skipped … and therefore unproven → leg fails"). An unmeasured auth-retired run that CI reads as pass is the opposite of "measured, never assumed".

- **writeLegEvidence's mock-in-closure-dir refusal is exact-path-only — subdirectories (and lexically different paths/symlinks) escape it** — MEDIUM — `scripts/p0-9/leg-lib.ts:192`
  ```
  if (deps.mode === "mock" && dir === path.resolve(LIVE_EVIDENCE_DIR)) {
  ```
  `outDir = <closure-dir>/anything` resolves to a child of the closure dir, `!==` the closure dir, and is honored — mock evidence lands inside the closure tree the policy says "means live VPS-day evidence". `path.resolve` is lexical, so a symlinked or differently-cased spelling of the closure dir also slips past (SPECULATION on runtime layout, but the lexical-comparison gap is provable). The round-trip prereq scan only reads the top level, but the policy being enforced is about the closure dir's meaning, not just its top level.

- **Compensation is bank-level only — a failed import on the rerun path leaves partial retains in pre-existing canonical banks, unrecorded** — MEDIUM — `scripts/p0-9/provision-and-import.ts:1742-1754`
  ```
  if (failed && createdInAttempt.length > 0) {
      for (const bankId of createdInAttempt) {
  ```
  On a rerun (reupsert-existing mode) `createdInAttempt` is empty by construction, so a mid-import failure (`mintFailures` set, `failed = true`) deletes nothing — correct per the diff rule — but the partially-retained Mulch documents now sit in the canonical roster banks with `residue: []` and no step naming them. The header's AC3 claim "on any failure the driver deletes EXACTLY that set" is true only because the set is empty; memory-level rollback (or at least a residue/naming treatment for partial documents) is absent.

- **INV-MEM-1 qds- prefix guard exists in the CLI but not in the drivers that also create banks** — MEDIUM — `scripts/p0-9/provision-and-import.ts:1699`, `scripts/p0-9/idempotency-rerun.ts:2113`
  ```
  const repoSlug = process.env.QDS_REPO_SLUG ?? basename(process.cwd());
  ```
  The CLI refuses `--repo-slug myrepo` with `bank_prefix_violation` "before any client is constructed" (checkBankPrefix, provision-hindsight-banks.ts:94-108), yet the P0.9 drivers feed `QDS_REPO_SLUG` (or cwd basename) straight into `provisionBanks`/`createBank` with no prefix check — `QDS_REPO_SLUG=myrepo` provisions `myrepo`, `myrepo-dev-meta` against the invariant "every bank id explicit and qds--prefixed" that this same diff documents as a story Security Invariant. Same invariant, one entrypoint guarded, the bank-creating entrypoints unguarded.

- **`deps.baseUrl === ""` accepted by three of six drivers — inconsistent with the trim-guard pattern the other three implement** — LOW — `scripts/p0-9/round-trip-dedicated.ts:2420-2427`, `scripts/p0-9/negative-probes.ts:2733-2740`, `scripts/p0-9/auth-retired-check.ts:3217-3224`
  ```
  let baseUrl = deps.baseUrl;
  if (baseUrl === undefined) { ... requireBaseUrl ... }
  ```
  hindsight-live, provision-and-import, and idempotency-rerun all gate on `deps.baseUrl !== undefined && deps.baseUrl.trim() !== ""`; these three only check `!== undefined`, so an empty-string dep skips the fail-closed env path, passes `forbiddenOrigin("")` (null), and reaches `new HindsightClient({ baseUrl: "" })` or raw `/v1/...` URLs. Whether "" falls back to the client default is not visible in the diff (SPECULATION on constructor behavior), but the divergence from the sibling drivers' own guard is provable.

- **CLI guard's resolved value is discarded — client re-reads env instead of using the checked baseUrl** — LOW — `scripts/provision-hindsight-banks.ts:194-212`
  ```
  const baseUrlCheck = checkHindsightBaseUrl();
  if (!baseUrlCheck.ok) { ... return 1; }
  ...
  const client = new HindsightClient({ baseUrl: process.env.HINDSIGHT_BASE_URL });
  ```
  `baseUrlCheck.baseUrl` is never used; the env is read a second time for construction. Nothing between the two reads mutates env in this code, so it is redundancy rather than a live TOCTOU — but the guarded value should be the value used.

- **parseArgs mutates the caller's argv in place** — LOW — `scripts/provision-hindsight-banks.ts:51-56`
  ```
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i] === "--no-bridge-probe") { argv.splice(i, 1); out.noBridgeProbe = true; }
  }
  ```
  A parse function with an output side effect on its input array. The comment defends it ("Both call sites hand parseArgs a fresh array"), which is true today and false for any future caller that passes a shared array. Filtering to a new array would be the same length.

- **deleteBank compares `count === 0` before narrowing to number, and ignores the body's `success` field** — LOW — `src/hindsight/client.ts:~208-215`
  ```
  if (count === 0) { return { deleted: false, alreadyGone: true, bankId, deletedCount: 0 }; }
  return { deleted: true, alreadyGone: false, bankId, ...(typeof count === "number" ? { deletedCount: count } : {}) };
  ```
  The code's own `typeof count === "number"` guard concedes `deleted_count` may not be a number — yet a string `"0"` fails `count === 0` and is classified `deleted: true` with no `deletedCount`. Likewise a 200 body `{success:false}` (the documented DeleteResponse carries `success`) is reported as `deleted: true`; `success` is never read. Edge-case misclassification, not a mainline break.

- **Test hygiene: globalThis.fetch and SWARMCLAW_* env set without restore** — LOW — `tests/hindsight/client.test.ts:399-407`, `tests/provision-hindsight-banks.test.ts:464-486`
  ```
  globalThis.fetch = (async () => { throw new Error("mock mode MUST NOT call fetch"); }) as ...
  ```
  (no restore in a finally), and `recordingUrls(urls)` assignments plus `process.env.SWARMCLAW_BASE_URL`/`SWARMCLAW_MCP_SERVER_ID` set in the `resolveProbe(false)` test with no cleanup. Order-dependent pollution for any later test in the same process; the new env-guard describes elsewhere in this same diff show the authors know the restore pattern (`afterEach` delete / `finally` restore) — it just isn't applied here.

- **Test writes a fabricated mode:"live" fixture into the REAL closure evidence dir** — LOW — `tests/p0-9/legs.test.ts:3860-3877`
  ```
  liveFile = writeLegEvidence({ mode: "live" }, "p0-9-test-fixture", baseEvidence("p0-9-test-fixture", "live"));
  ... finally { if (liveFile !== "") rmSync(liveFile, { force: true }); }
  ```
  The lib's own policy: the closure dir "means live VPS-day evidence" and fake evidence there is "precisely the mock-stands-in-for-live confusion the policy exists to prevent". A crash between write and finally leaves a synthetic live-stamped file in the closure tree. The `p0-9-test-fixture` slug and the prereq scan's `-p0-9-hindsight-live` name filter limit the blast radius, but the test violates the invariant it sits next to.

- **Duplicated constants/helpers across the six drivers — drift already visible inside this diff** — LOW — `scripts/p0-9/round-trip-dedicated.ts:2338-2345` (private `LIVE_EVIDENCE_DIR` "mirrors leg-lib's private LIVE_EVIDENCE_DIR"), `MAX_BASE_LEN`/`safeRepoBase` duplicated in provision-and-import.ts:1580-1586 and idempotency-rerun.ts:2022-2028 ("Mirror of bank-provisioner MAX_BASE_LEN"), `makeRecorder`/`finalize` copied verbatim into three drivers, and three divergent `extractBankIds` (see the negative-probes finding). leg-lib exists precisely to stop six drivers drifting, and the diff ships pre-drifted copies of the very functions it centralizes.

- **maskTail covers only three credential shapes — narrower than the INV-HM1 claim** — LOW — `scripts/p0-9/leg-lib.ts:685-697`
  ```
  .replace(/(\bbearer\s+)\S+/gi, "$1***")
  .replace(/(\bx-api-key\b["']?\s*[=:]\s*["']?)\S+/gi, "$1***")
  .replace(/(\b(?:HINDSIGHT_BEARER_TOKEN|HINDSIGHT_API_KEY)\b["']?\s*[=:]\s*["']?)\S+/gi, "$1***")
  ```
  A bare token in any other position — query string (`?token=…`), an arbitrary JSON field, a `Basic` header — passes through into recorded body tails. The lib comment claims "tokens never land in recorded evidence tails (INV-HM1)". Whether any real response carries a token that way is SPECULATION; the gap between the claim and the three regexes is not.

- **Rerun path assumes any same-named base bank is "ours"** — LOW (SPECULATION on deployment) — `scripts/p0-9/provision-and-import.ts:1642-1644`
  ```
  const base = safeRepoBase(repoSlug);
  if (!existingBankIds.includes(base)) { ...provisionBanks... }
  ```
  Presence of `base` is treated as "this leg's own earlier run created it", so a genuinely foreign bank that happens to hold the same id gets PUT-upserted into instead of disambiguated (the first-run resolver's `-2..-11` loop exists for exactly that). The comment states the assumption; nothing verifies it.

Clean dimensions: no resource leaks found (every lock/timer/AbortController is released in a finally; probe banks are finally-deleted); no unhandled-promise or crash-path gaps found in the drivers (every `runLeg` resolves `LegEvidence` including fatals); the exit-code contract (0/1/2) is consistently implemented and pinned by tests; the CLI bool-flag grammar and its `=value` rejection are correct and tested.
