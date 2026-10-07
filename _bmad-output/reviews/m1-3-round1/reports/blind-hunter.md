# Blind Hunter — M1.3 round 1

Scope: judged `chunk-A-impl.diff`, `chunk-B-tests.diff`, `chunk-C-data-docs.diff` as a standalone artifact. No repo access beyond the diffs. Findings ordered by severity.

---

## 1. An empty probe set produces the exact "legitimate-looking 0.0" artifact the module's own header forbids — HIGH

Evidence: `scripts/memory/probe-schema.ts` `parseProbeSet` uses `z.array(ProbeSchema)` with **no minimum size**, so `[]` parses clean. `runProbeRecall` then: integrity gate loops zero probes → 0 violations → pass; canary passes; scoring loop no-ops; `hitRateAt5: perProbe.length === 0 ? 0 : ...` yields **0**; the artifact is still written with `labelIntegrity: "pass"`, and the CLI prints `hitRateAt5=0 probes=0` and exits 0.

The file header says: "Any gate refusal withholds the hit-rate artifact entirely — never a legitimate-looking 0.0." A wiped, truncated, or hand-emptied probe set is scored and emits a real-looking 0% recall evidence file. `MIN_PROBE_SET_SIZE` exists but only gates whether a median is emitted — it never refuses scoring. Ironically `scripts/dev/verify-test-slice.mjs` was written in this same diff specifically to close the "vacuous pass" hole for test slices ("a 0-match -t filter is a vacuous pass — this closes that hole"); the main instrument leaves the identical hole open. Fail-closed here means: refuse (or at minimum withhold the artifact) when `probes.length === 0`.

## 2. The driver-owned e2e verifier is not hermetic — its integrity gate reads the developer's real `.sandbox/audit.db` — MEDIUM

Evidence: `scripts/dev/verify-m13-e2e.ts` claims "stores are real CostLedger/audit-store instances seeded in the tmpdir … no network" and seeds a fixture audit.db. But it calls `runProbeRecall({ client, probeSetPath, evidenceDir, p09EvidenceDir })` — **`ProbeRecallDeps` has no `auditPath` field at all**, so inside `runProbeRecall` the mint merge calls `loadReceiptMintRecords()` with no argument → `process.env.QDS_AUDIT_DB ?? ".sandbox/audit.db"` — the developer's live audit db outside the tmpdir. (The same script's `runPrimingReport` call *does* pass `auditPath`, so the two runners in one verification read different audit dbs.)

Why it matters: the label-integrity refusal behavior the verifier "proves" depends on ambient machine state — receipts present on the dev machine silently widen the mint union; a locked or corrupt `.sandbox/audit.db` makes the branch gate crash; a fresh CI checkout exercises a different mint set than a dev box. The missing dep is the root cause; a branch-gate verifier must be hermetic.

## 3. A recall throw mid-scoring crashes uncleanly — no refusal, no diagnostic, undocumented exit code — MEDIUM

Evidence: `probe-recall.ts` wraps the canary retain/recall in try/catch with a full refusal diagnostic (exit 3), but the per-probe scoring loop (`for (const probe of probes) { … await deps.client.recall(...) … }`) has **zero error handling**. A single flaky probe recall (network blip, upstream 500) throws out of `runProbeRecall`, crashes the CLI with an unhandled rejection (bun exit 1), and writes neither a hit-rate artifact nor any diagnostic — after the canary gate already spent its retain.

Why it matters: the module's whole discipline is "refuse loudly with a named stage and a diagnostic file"; partial-failure mid-scoring is the *most likely* error case in a live run and it gets the least handling. The documented exit-code contract (0/2/3) has no slot for the most probable failure.

## 4. Latency telemetry can be, and in the committed evidence is, all zeros — the fallback reproduces the ambiguity it claims to fix — MEDIUM

Evidence: `probe-recall.ts`: "a 0 server figure and an absent one are indistinguishable, so a non-positive value falls back to the local wall-clock measure" (`recallMs = resp.durationMs > 0 ? resp.durationMs : Date.now() - started`). But `Date.now() - started` can itself be **0**, which is indistinguishable from the absent-server-figure case the fallback exists to avoid. The committed artifact `_bmad-output/evidence/memory/2026-10-07T15-51-44-573Z-hit-rate.json` proves it happens: all 23 probes have `recallMs: 0` and `medianRecallMs: 0`, while a second artifact 48 seconds later (`…15-52-32-492Z-…`) shows realistic 39–696 ms latencies for the identical probe set.

Why it matters: this project's own stated honesty contract is "absent, not 0" (it is in the dataNotes, the report header, and the committed mulch lore). `medianRecallMs: 0` in committed evidence is precisely a zero-fill masquerading as a measurement, and the unexplained provenance of the all-zero artifact (stub client? sub-ms localhost?) is committed with no distinguishing note. A `recallMs` of 0 should be recorded as unmeasured/absent, not averaged.

## 5. Corrupt or locked sqlite/ledger opens crash the whole report — inconsistent with the skip-and-note posture used one function up — MEDIUM

Evidence: `priming-report.ts` `readSideChannel` carefully try/catches per row and per file ("malformed rows are skipped (data, not code)"). But `readReceiptRunIds` does `new Database(path, { readonly: true })` with **no try/catch** — a corrupt, locked, or non-sqlite file at that path throws and kills `runPrimingReport` (CLI exit 1). Same for `CostLedger.openReadOnly` in the cost join, and `loadReceiptMintRecords` in `probe-schema.ts` (which propagates the throw into `runProbeRecall`'s integrity gate — a crash, not one of the documented refusals).

Why it matters: absent sources get graceful "absent, never created" handling, but *present-and-broken* sources — the more dangerous case — get a hard crash of the whole report instead of a dataNote. The error posture is asymmetric in exactly the wrong direction.

## 6. `dispatchFailures` counts every non-blank line as a "failure", and an unreadable log reads as zero — MEDIUM

Evidence: `priming-report.ts` `countDispatchFailures` returns `readFileSync(path).split("\n").filter(l => l.trim().length > 0).length` — it counts **lines**, named as **failures**. If the dispatch log ever contains a non-failure line (success, header, retry-in-progress), the metric over-counts silently. And the `catch { return 0 }` means a file that exists but can't be read is reported as **zero failures** — the comforting direction, not the honest one (a dataNote would be). The story record claims "read-only failure count (`dispatchFailures`), present only when the log exists" — the line-count semantics embedded in the name are unverifiable from the diff and untested: `dispatchLogPath` appears in zero tests in `tests/memory/probe-harness.test.ts`.

## 7. Committed failed-leg evidence contradicts its own compensation claims — MEDIUM

Evidence: `_bmad-output/evidence/p0-9-closure/2026-10-07T11-49-36-792Z-p0-9-provision-and-import-vrf9ks.json`: `provision` reports all three banks `"status": "created"`, `snapshot-post` counts 3, `createdInAttempt` lists all three — yet `deleteOutcomes` says `qds-factory-dev-meta` and `qds-collective` were `"already-gone"` (not deleted), while the same record asserts `unclaimedCreated: []` and `residue: []`. Either those two created banks were deleted by this attempt (outcomes should say `deleted`) or they lingered (`residue` should be non-empty). Both cannot be true.

Why it matters: this is the *prerequisite* evidence the whole M1.3 seed rests on. An artifact whose internal fields disagree about whether created resources were cleaned up is exactly the kind of record the "honest history" framing claims to forbid. (If "already-gone" is the local instance's response to deleting an empty bank, the record should say so.)

## 8. OpenRouter key-management URL with an embedded 64-hex key id is committed into evidence — MEDIUM

Evidence: the same `vrf9ks.json` `mintFailures` entries embed, verbatim and 45+ times: `https://openrouter.ai/workspaces/default/keys/<revoked-key-id-redacted>` — a workspace-scoped key-management URL containing the key's identifier. The story record claims "leak-checked to zero live keys", and the committed mulch lore says the shared evidence writer "self-fails the write if any secret-shaped token survives" and INV-PH-1 forbids "no credentials".

Why it matters: it is not the bearer token, but it is account-identifying third-party material pointing at a live billing workspace, committed to the repo 45 times. Whatever writer produced these leg JSONs either isn't the scrubbing evidence writer or its scrub patterns miss URLs. The "leak-checked to zero live keys" claim and the committed bytes disagree at the margin — which is exactly where leak claims fail.

## 9. Probe growth auto-generates near-tautological probes, mutating the measurement instrument as a side effect of running a report — MEDIUM

Evidence: `priming-report.ts` `growProbeSet` appends candidates with the fixed query template `"recall probe for document ${docId}"` — a query that literally contains the expected document's id. Also note the side channel already carries per-run `recalledDocumentIds`, so these ids are documents the engine *just recalled* for a different query — re-probing them with an id-naming query tests "can retrieval find a doc whose id appears in the query", not domain recall. `appendedProbes` is disclosed in the report, but the hits contributed by these probes are not distinguished from human-authored seeds in `hitRateAt5`.

Why it matters: the probe set is the instrument; the report — nominally a read-only observer — silently rewrites it with machine-generated, metric-inflating (or metric-deflating) probes that no human vetted. Over 30 cycles the seed probes' signal is progressively diluted by `cycle-*` auto-probes.

## 10. `growProbeSet` hardcodes `SEED_PROBE_BANK` while iterating per-bank sources — non-seed growth is silently dead — LOW

Evidence: `growProbeSet`'s `add(docId)` always constructs `bank: SEED_PROBE_BANK`, yet the p09 loop iterates `for (const [bank, ids] of loadP09MintRecords(...))` for *any* bank already present in the probe set. Candidates sourced from bank `foo`'s mint record are labeled as seed-bank probes; they only survive the integrity filter if the id happens to also be minted into the seed bank. The `[bank, ids]` binding is otherwise unused.

Why it matters: growth for non-seed banks is a silent no-op (or, in the accidental-overlap case, a mislabeled probe). A future multi-bank probe set grows only by luck. The dead binding is a smell that the per-bank loop was bolted on without following the data.

## 11. A probeId slug collision permanently bricks the harness with a sticky, unrecoverable refusal — LOW

Evidence: candidate probeIds are `cycle-${slugOf(docId)}`. Two distinct docIds can slug-collide (e.g. `mulch-A_1` vs `mulch-a-1`); both candidates pass the per-docId `candidates` map, both append, and the probe set now contains **duplicate probeIds**. Every subsequent `parseProbeSet` fails → every future `runProbeRecall` exits 2 forever, and `growProbeSet` itself returns 0 on the unparseable set — nothing ever repairs or reports the poisoned state beyond a dup-id list. Realistic mulch ids are hex, so collision is unlikely — but the failure mode is sticky corruption of a shared artifact with no recovery path.

## 12. Story record miscounts the test suite it cites as evidence — LOW

Evidence: the story's Dev Agent Record claims "43/43 (probe-schema 16, probe-recall 10, priming-report 14, harness-e2e 3)". The diff contains **44** `test()` calls: probe-schema 16, probe-recall **11** (rank-math, nothing-expected, null-docId, k=5, canary-before-scoring, canary-retain-error, canary-miss, integrity-refusal, happy-path, belowFloor, median-odd), priming-report 14, harness-e2e 3.

Why it matters: the count is the verification evidence. If the record can't count its own suite, the "43 red proven against missing modules" TDD claim inherits the same doubt (which 43?). Small, but this campaign exists to catch exactly this class of drift between record and artifact.

## 13. `verify-test-slice.mjs` has fragile summary parsing and an undefined-arg crash path — LOW

Evidence: (a) pass/fail counts come from the **first** `/^\s*(\d+)\s+pass\b/m` match over the entire combined stdout+stderr — any test's `console.log("  3 pass")` earlier in the stream is parsed as the bun summary; (b) the target collector pushes `args[i + 1]` with no bounds check — `--file` as the final argument pushes `undefined` into the spawn argv (spawn error, not the usage message); (c) the usage line `--file <path|dir...>` implies multi-value flags, but each `--file` consumes exactly one value. Also `spawnSync` timeout (15 min) leaves `res.status === null`; that path is handled only incidentally via `!== 0`.

## 14. Interim report artifacts are day-stamped and silently overwritten — contradicts the repo's own timestamped-evidence lore — LOW

Evidence: `runPrimingReport` writes `${day}-interim.json`/`.md` via `atomicReplaceFile` — multiple runs on one day overwrite (last-writer-wins), so same-day history of `cyclesToDate`/`checkpointEligible` is unrecoverable. The committed mulch lore states "Evidence artifacts land as timestamped JSON" — the sibling hit-rate artifacts in this very diff *are* millisecond-stamped, so the two artifact streams in one story follow opposite disciplines. A concurrent second invocation on the same day silently replaces the first's report.

## 15. Dead constant and dressed-up no-op assertions — LOW

Evidence: (a) `SLOW_QUERY_THRESHOLD_MS = 5_000` is exported from `probe-schema.ts` and used nowhere in the diff — a slow-query feature that doesn't exist, with a name implying it does; (b) `verify-m13-e2e.ts` line: `if (calls.some((c) => c.query.includes("qds-canary") === false && c.query === ""))` reduces to `c.query === ""` (the first clause is always true for the empty string) — a vacuous check written to look like a canary-guard; (c) `verify-m13-e2e.ts` `fail()` calls `process.exit(1)` without removing the mkdtemp tmpdir — every failed verification run leaks a directory; (d) `priming-report.ts`'s header sells a "Read-only posture" while the module writes the probe set and two report files — the header enumerates the read-only *sources* but never mentions the writes; (e) the test named "existing rows byte-identical (canonical form)" asserts `canonicalJson` equality — canonical equality, not byte equality; the file's raw bytes do change on every growth (re-serialization), so the name overstates the guarantee.

## 16. The canary perturbs the bank being measured, every scoring run — LOW

Evidence: `runProbeRecall` retains `CANARY_CONTENT` with `documentId: qds-canary` into `SEED_PROBE_BANK` — the same bank the probes score against — before every measurement. Replace-on-write keeps it to one document (the comment acknowledges this), but the instrument still permanently mutates the measured corpus: every hit-rate run adds/refreshes one synthetic document that can occupy a top-5 slot for near queries, and the committed `qds-factory-dev-meta` bank now permanently differs from a pristine bank by the canary. Disclosed in code comments, not in the artifact.

---

## Summary

16 findings: 1 HIGH, 8 MEDIUM, 7 LOW. The recurring theme is a gap between the diff's loudly stated honesty contract ("withhold, refuse, absent-not-zero") and its actual edges: vacuous 0.0 on an empty probe set (#1), non-hermetic branch-gate verification (#2), unhandled mid-scoring and corrupt-source crashes (#3, #5), committed zero-latency and self-contradicting evidence (#4, #7, #8), and an instrument that rewrites itself (#9). The happy path is solid; the campaign should focus triage on #1–#5 and the evidence artifacts #7–#8.
