# Edge Case Hunter — M1.3 round 1 (feature/m1-3-recall-measurement-harness vs dev)

Scope: chunk-A-impl.diff, chunk-B-tests.diff, chunk-C-data-docs.diff — changed lines only, traced into the upstream contracts they call (client, ledger, link-store, run-lock, fs-atomic).

---

## HIGH

### 1. A recall error mid-scoring loop escapes `runProbeRecall` unclassified
- **Severity:** HIGH
- **Trigger:** Any probe recall (probe i of N) rejects — network blip, 5xx, timeout — after Gate 2 passed.
- **Current behavior:** `await deps.client.recall(...)` at `scripts/memory/probe-recall.ts:185` has no try/catch; the rejection propagates out of `runProbeRecall`. No hit-rate artifact (accidentally correct), but also no `ok:false` result, no diagnostic, and the CLI main's `res.stage` dispatch never runs — the process dies with bun's unhandled-rejection output and an unclassified exit code (not 2/3). Probes 1..i-1 were already recalled and their measurements are silently discarded.
- **Expected behavior:** Catch per-probe (or whole-loop) recall errors and return `{ok:false, stage:"canary"|"scoring", reason}` in the same refusal shape — canary-stage errors are already handled exactly this way at `probe-recall.ts:146-152`; scoring-stage errors deserve the same treatment.
- **Evidence:** scripts/memory/probe-recall.ts:183-206 (scoring loop, no guard), vs probe-recall.ts:143-152 (canary guard).

### 2. A `listBanks` error at the label-integrity gate escapes as an unhandled crash
- **Severity:** HIGH
- **Trigger:** `deps.client.listBanks()` rejects at Gate 1 (bank endpoint down, auth failure) — the most likely real-instance failure mode.
- **Current behavior:** `await deps.client.listBanks()` at `scripts/memory/probe-schema.ts:170` is unguarded; `runProbeRecall` line 126 awaits `checkLabelIntegrity` without a try. The "label-integrity refusal (exit 2, violations on stderr)" contract is not honored — the process crashes with an unclassified exit and no refusal payload.
- **Expected behavior:** Wrap the Gate 1 client call; map a listBanks rejection to `{ok:false, stage:"label-integrity", reason}` (or a new stage) so every refusal is one of the two contracted shapes.
- **Evidence:** scripts/memory/probe-schema.ts:170, scripts/memory/probe-recall.ts:126.

---

## MEDIUM

### 3. Present-but-unreadable cost ledger crashes the whole report instead of a dataNote
- **Severity:** MEDIUM
- **Trigger:** `existsSync(ledgerPath)` is true but `CostLedger.openReadOnly` throws — file is not a ledger, schema mismatch, deleted in the existsSync→open window, or `readRunCost` refuses (INV-COST-6 unqueryable).
- **Current behavior:** `scripts/memory/priming-report.ts:307` and `:147` are unguarded. The throw kills `runPrimingReport` entirely: receipt coverage, outcome table, checkpoint flag — everything is lost, not just the cost section. The module's own contract (header, lines 265-266: "a section with no data is omitted with a dataNote, never zero-filled") is only implemented for the *absent* file; the *unreadable* file has no path.
- **Expected behavior:** try/catch around the open + per-run cost reads; on failure set `costTable = undefined` and push a dataNote naming the ledger error.
- **Evidence:** scripts/memory/priming-report.ts:304-318, 145-149.

### 4. Under-lock probe-set read is unguarded — a corrupt file under the lock kills the report
- **Severity:** MEDIUM
- **Trigger:** Between the pre-lock read and the lock acquisition, another writer (or an operator) replaces `probe-set.json` with non-JSON, or readFileSync fails (EACCES/ENOENT) under the lock.
- **Current behavior:** The pre-lock equivalent at `scripts/memory/priming-report.ts:198` is wrapped in try/catch and returns 0; the under-lock read at `:258` (`parseProbeSet(JSON.parse(readFileSync(...)))`) has no parse/read guard — the throw escapes `runPrimingReport` (lock is released via finally, but no report artifacts are written at all). Inconsistent handling of the identical input at the two reads of the same file.
- **Expected behavior:** Mirror the pre-lock guard: catch read/parse failure under the lock, return 0 (append nothing), let the report proceed.
- **Evidence:** scripts/memory/priming-report.ts:253-268 vs 196-203.

### 5. Growth can append duplicate probeIds, producing a probe set its own parser refuses
- **Severity:** MEDIUM
- **Trigger:** Two distinct candidate docIds whose `slugOf` outputs collide (e.g. `mulch/a b` and `mulch-a-b` both → `mulch-a-b`), both absent from the existing set. Side-channel `recalledDocumentIds` are free-form wire strings, so non-canonical ids are reachable.
- **Current behavior:** Candidates are deduped by docId (`scripts/memory/priming-report.ts:211-216`), but `probeId` is derived from `slugOf(docId)` (`:213`) and neither the survivor filter (`:246-252`) nor the under-lock `toAppend` filter (`:259-264`) dedupes on probeId between candidates. Both appends land → the file now contains two probes with the same probeId → the *next* `runProbeRecall` refuses at Gate 0 with "duplicate probeIds" (`probe-schema.ts:52`), i.e. growth corrupts the set for its primary consumer.
- **Expected behavior:** Dedupe `toAppend` on probeId (or make the derived probeId collision-safe) so the written set always re-parses clean.
- **Evidence:** scripts/memory/priming-report.ts:209-264; refusal site scripts/memory/probe-schema.ts:47-53.

### 6. Probe-writer lock failure is fatal to the entire metrics report
- **Severity:** MEDIUM
- **Trigger:** The 5s poll deadline expires on a long-held lock, or `acquireRunLock` throws a non-retryable error (e.g. `assertValidRunId` on the lock id, or an errno out of claim).
- **Current behavior:** `scripts/memory/priming-report.ts:240-255` rethrows after the deadline; the exception propagates out of `runPrimingReport` — the operator gets no report at all (no cyclesToDate, no checkpointEligible, no artifacts) because an *auxiliary append* could not get a lock. Partial-failure ordering: the report's core deliverable dies with the optional one.
- **Expected behavior:** Catch the growth failure, record `appendedProbes: 0` plus a dataNote ("probe growth skipped: lock contention"), and still emit the report.
- **Evidence:** scripts/memory/priming-report.ts:239-277 (lock loop + finally), 322-329 (call site, unguarded).

### 7. Empty probe set parses as valid and produces a scored-looking 0.0 hit-rate artifact
- **Severity:** MEDIUM
- **Trigger:** `probe-set.json` contains `[]` (fresh checkout before seeds land; a growth run that emptied nothing but was seeded empty).
- **Current behavior:** `parseProbeSet` (`scripts/memory/probe-schema.ts:41-53`, `z.array(ProbeSchema)` with no `.min()`) accepts the empty array; integrity passes vacuously (0 violations); the canary runs; scoring writes an artifact with `probes: 0, hits: 0, hitRateAt5: 0, belowFloor: true` (`probe-recall.ts:199-217, 234`). `MIN_PROBE_SET_SIZE` only suppresses the median — it is not a floor. This is exactly the "legitimate-looking 0.0" the module header forbids (`probe-recall.ts:23-24`).
- **Expected behavior:** Refuse (or gate) when `probes.length === 0` — a scored aggregate over zero probes should be a refusal, not a pass artifact with a 0.0 rate.
- **Evidence:** scripts/memory/probe-schema.ts:40-53; scripts/memory/probe-recall.ts:199-206, 214-217.

### 8. Readonly audit-db open races existsSync: TOCTOU delete or non-sqlite file crashes the readers
- **Severity:** MEDIUM
- **Trigger:** `audit.db` deleted between `existsSync` and `new Database(path, {readonly:true})`, or the path exists but is not a SQLite database (partial write, wrong file placed there).
- **Current behavior:** `scripts/memory/probe-schema.ts:108-109` and `scripts/memory/priming-report.ts:131-132` check-then-open with no try around the constructor. bun:sqlite readonly on a missing file raises SQLITE_CANTOPEN; on a garbage file, SQLITE_NOTADB. Both escape `runProbeRecall` Gate 1 / `runPrimingReport` as unhandled crashes — the "data, not code: skip malformed" doctrine applied everywhere else in these readers is not applied to the open itself.
- **Expected behavior:** try/catch around the open + query; on failure return the empty map/set (data absent) — the readers are already documented as best-effort join sources.
- **Evidence:** scripts/memory/probe-schema.ts:106-134; scripts/memory/priming-report.ts:129-141.

---

## LOW

### 9. Empty `concepts` entry sends `tags: []` — an unmeasured wire shape on the changed line
- **Severity:** LOW
- **Trigger:** A corpus entry with `concepts: []` (explicitly valid per `MulchExpertiseSchema`, `src/hindsight/schemas.ts:250-251`: "empty concepts array = untagged but valid entry").
- **Current behavior:** The changed hunk sends `tags: entry.concepts` (`scripts/p0-9/provision-and-import.ts:334`). The 0.10.0 item-level tags shape was measured live with non-empty arrays only; `tags: []` is unmeasured — same 422 class the hunk's own comment documents. One such entry fails the retain → mulch-import step fails → that bank's mint record comes back empty, and every probe for the bank then phantom-refuses at Gate 1.
- **Expected behavior:** Skip or guard entries with empty concept arrays (or measure `tags: []` against the pinned instance before trusting it).
- **Evidence:** scripts/p0-9/provision-and-import.ts:326-338 (hunk); src/hindsight/schemas.ts:244-253.

### 10. `loadP09MintRecords` "latest writtenAt wins" misorders on non-ISO or offset timestamps; ties are silent
- **Severity:** LOW
- **Trigger:** Two ok:true files for one bank where `writtenAt` uses a non-Z offset or mixed formatting (`+02:00` vs `Z`, unpadded), or two files carry byte-identical `writtenAt`.
- **Current behavior:** Winner selection is a raw string compare, `prev >= at` (`scripts/memory/probe-schema.ts:93`) — lexicographic, not chronological — and an exact tie keeps the lexicographically-first filename's record (the `>=` skips the later file). Deterministic, but the winner is not guaranteed to be the actually-latest mint, and a mint set with fewer/older ids surfaces downstream as phantom-probe violations with no hint the mint reader picked the wrong file.
- **Expected behavior:** Parse `writtenAt` with `Date.parse` and compare epoch millis (fall back to name order only on unparseable stamps), and/or note ties.
- **Evidence:** scripts/memory/probe-schema.ts:76, 88, 93.

### 11. Side-channel `latencyMs` accepts `Infinity`/negative; means propagate NaN/Infinity into the report
- **Severity:** LOW
- **Trigger:** A row whose `latencyMs` is `1e999` (JSON.parse → `Infinity`) or a negative number — both pass `typeof === "number"` (`scripts/memory/priming-report.ts:109`).
- **Current behavior:** `latencyGroup` (`:140-142`) sums and divides: `meanLatencyMs` becomes `Infinity` (or negative), serialized verbatim into the interim JSON/md. The "data, not code" skip only covers malformed JSON, not out-of-domain numbers.
- **Expected behavior:** `Number.isFinite(latencyMs) && latencyMs >= 0` in the shape check; skip the row otherwise.
- **Evidence:** scripts/memory/priming-report.ts:104-112, 140-142.

### 12. verify-m13-e2e: tmpdir leaked on failure, and probe-recall reads the repo's real `.sandbox/audit.db`
- **Severity:** LOW
- **Trigger:** (a) any `fail()` exit; (b) `runProbeRecall` inside the verifier.
- **Current behavior:** (a) `rmSync` runs only on the success path (`scripts/dev/verify-m13-e2e.ts:193`); every failed assertion leaves a `qds-m13-e2e-*` tmpdir behind. (b) `ProbeRecallDeps` has no `auditPath`, and the verifier sets no `QDS_AUDIT_DB`, so Gate 1's `loadReceiptMintRecords()` resolves the default `.sandbox/audit.db` — the developer's real sandbox db, outside the tmpdir the header claims ("stores are real CostLedger/audit-store instances seeded in the tmpdir"). Read-only today and only widening the mint union, but the sandbox claim is false for that join.
- **Expected behavior:** Wrap the body so `fail()` also removes the tmpdir; set `QDS_AUDIT_DB` into the tmpdir (or add an `auditPath` dep) before running probe-recall.
- **Evidence:** scripts/dev/verify-m13-e2e.ts:25-28, 193; scripts/memory/probe-recall.ts:30-38 (no auditPath in deps); probe-schema.ts:104-108.

### 13. Same-millisecond artifact stamp collision silently overwrites evidence
- **Severity:** LOW
- **Trigger:** Two `runProbeRecall` runs (or a run plus a canary-failure from another bank run) writing to the same evidenceDir within one millisecond — or any caller injecting a fixed `now()` and reusing the dir.
- **Current behavior:** `stampOf(now())` (`scripts/memory/probe-recall.ts:96-98, 226`) has no run-unique component; `atomicReplaceFile` then replaces the first run's `*-hit-rate.json` with the second's, with no trace of the overwritten artifact.
- **Expected behavior:** Add a nonce/pid suffix (the fs-atomic temp grammar already does this for temps) or refuse to overwrite an existing stamped artifact.
- **Evidence:** scripts/memory/probe-recall.ts:95-98, 224-226, 234.

### 14. Artifact/diagnostic writes are unguarded — an unwritable evidence dir turns a refusal into a crash
- **Severity:** LOW
- **Trigger:** evidenceDir or reportsDir not writable (permissions, disk full) at the canary-diagnostic write, the hit-rate artifact write, or the report writes.
- **Current behavior:** `atomicReplaceFile` throws (`scripts/memory/probe-recall.ts:167, 234`; `scripts/memory/priming-report.ts:349-350`) and the throw escapes: the canary-miss path never returns its contracted `{ok:false, stage:"canary", diagnosticPath}` (the diagnostic write precedes the return), and a fully-scored run dies after all 23 recalls with nothing written and no classification.
- **Expected behavior:** Guard the refusal-path write so a diagnostic-write failure still yields the refusal result; for the artifact path, either guard or accept and document the crash — but the canary-diagnostic path contradicts its own refusal contract today.
- **Evidence:** scripts/memory/probe-recall.ts:155-176 (diagnostic write before return), 226-236; scripts/memory/priming-report.ts:344-351.

---

Handled-and-discarded (verified, not reported as findings): duplicate-runId dedupe incl. mtime ties (`readSideChannel` name tiebreak), `null`/absent `documentId` in scoring, rank>5 boundary, `checkpointEligible` 29/30 boundary, canary retain/recall error → refusal, absent ledger → dataNote + stays absent, absent recall/p09 dirs → empty maps, malformed side-channel rows and ok:false P0.9 records → skipped, probe-set read/parse failure → label-integrity refusal, `--min-pass 0`/NaN in verify-test-slice, spawnSync timeout → nonzero status path, `dispatchFailures` absent-log → 0, `slugOf("")` → `"doc"`.
