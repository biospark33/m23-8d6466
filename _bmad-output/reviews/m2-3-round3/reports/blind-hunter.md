# Blind Hunter — M2.3 review ROUND 3 (confirmation round)

Scope: `/tmp/m23-review/full-r3.diff` only (~1934 lines). No project context consulted. Target: what remains after rounds 1–2, and regressions the round-2 fixes introduced.

## Findings

### 1. MEDIUM — L3 `finally`: unguarded `fleetLeftovers` / `keyLeakProblems` calls can abort the cleanup chain, skipping the "UNskippable" probe battery, the evidence write, workspace removal, and `settleRun`

`tests/fleet/e2e/memory-combined.live.test.ts:938` (`finalBoxes = (await fleetLeftovers(...)).owned;`) and `:950` (`keyProblems = await keyLeakProblems(...)`).

Both are plain `await` calls with no try/catch, sitting in L3's `finally` **ahead of** the AC5 battery (`:960`), the `m23-revoke-verified` evidence write (`:990`), the `rmSync` of both workspaces (`:1002-1003`), and `settleRun` (`:1005`). Every other fallible step in that finally is individually guarded (`teardownQuietly`, `destroyQuietly`, per-bank delete in its own try/catch, the store construction in its own try/catch, the battery in its own try/catch) — these two are not. If the driver listing or the account key listing throws (transient API failure is exactly when a cleanup path runs), the finally throws out of itself: the box/key/bank verdicts already collected in `destroyFailures`/`bankProblems` never reach `settleRun`, the probe battery — documented "fires in the finally on EVERY exit path" — never fires, evidence for the whole round is never written, and the workspace directories leak. The AC5 "cannot be skipped" invariant is structurally false for this exit path. Wrap the two calls (or the whole pre-battery sweep) so the battery and `settleRun` are reached on every path, mirroring the guard pattern used three lines above.

### 2. MEDIUM — worker_output primary seam reads only top-level `summary`/`output`, but the round's own task brief words the reply as `result.summary`; if the payload nests, both green-path asserts are dead-on-arrival

`tests/fleet/e2e/memory-combined.live.test.ts:737-738`:

```ts
const payloadText = (p: Record<string, unknown>): string =>
  [p.summary, p.output].filter((s): s is string => typeof s === "string").join("\n");
```

The task text planted in the manifest (`:426` area) instructs the worker: *"finish with the required JSON reply whose **result.summary** states how many memories came back…"*. If the driver's `worker_output.payload_json` stores that reply verbatim, the top-level key is `result` (an object) and `payloadText` is `""` for every payload — then `expect(markerHits.length).toBeGreaterThan(0)` (`:753`) and `expect(docIdHits.length).toBeGreaterThan(0)` (`:754`) both fail on a fully green round, and the R2 dual-requirement fix converts every success into a failure. Nothing in the diff validates the key names (no sample payload, no live run evidence for this test yet — sprint-status shows M2.3 still in-progress), so the seam keys are unproven in both directions. Secondary fragility on the same seam: `DOC_ID_FRAMING = '"documentId":"m23-prime-'` (`:743`) is byte-exact (no whitespace, exact key spelling) and the "quote one line verbatim" step is executed by an LLM that may re-serialize with a space or different key order — the framing leg can false-fail independent of recall health. Pin the seam to the actual harvested payload shape (or match `documentId` whitespace-insensitively) before the live round spends money proving this the hard way.

### 3. LOW — LD degrade control drops evidence-write problems on the failure path (no composite rethrow)

`tests/fleet/e2e/memory-combined.live.test.ts:341-349`. The catch block calls `writeM23EvidenceQuietly(..., problems)` and then `throw e`. The `if (problems.length > 0) throw ...` check (`:349-350`) sits **after** the try/catch, so it only executes on the success path. When the test itself failed *and* the failure-path evidence write also failed (the only write that runs on that path), the evidence loss is silently dropped from the thrown surface — exactly the masking that L1/L2's composite rethrow (`:739-743`, `:943-947`) exists to prevent, and this test predates none of that machinery. Only the stderr line remains. Apply the same problems-lead/cause-rides composite here.

### 4. LOW — `keyLeakProblems` empty-baseline guard conflates "account genuinely has zero keys" with "baseline unmeasured"

`tests/fleet/e2e/memory-combined.live.test.ts:947-951`. The guard is `round.hashesBefore.size === 0` → push `"key baseline unavailable — L1 threw before listedKeyHashes; key-leak check UNMEASURED"`. Two problems: (a) an account that legitimately lists zero keys at baseline (fresh/fully-revoked account) takes the same path — a completely green round fails with a problem claiming L1 threw; (b) the message asserts a cause it cannot know. Since `listedKeyHashes` is the second statement in L1's try, "threw before" is only one of two possible worlds (the other being an honest empty list). The conservative fail-closed direction is fine; the false attribution and the false positive on a legitimately empty account are not. Distinguish "listedKeyHashes threw" (record the thrown error) from "it returned an empty set" (baseline valid, leak delta trivially clean).

### 5. LOW — torn `[kg-recall]` lines discard the `rawControlChars` measurement, so the hygiene record can read `true` while the torn line itself carried control chars

`tests/fleet/e2e/memory-combined.live.test.ts:277-287` (`kgRecallEvents`). `rawControlChars` is computed on every marker line (`:279-283`) but is only attached on the successful parse push (`:283`); the torn-line push (`:286`) emits `{ event: "unparseable", line: … }` without it. A line torn *because* of a raw control char — precisely the F10 concern the field exists to catch — therefore never registers in `hygiene: events.every((e) => e.event.rawControlChars !== true)` (`:384`), which reads vacuously `true`. The unparseable count does catch the tear via `evidenceProblems` (`:398-400`), so this is a record-fidelity gap, not a lost verdict — but the hygiene field is misleading by construction for exactly the lines it cares about. Include the pre-computed flag in the unparseable push.

### 6. LOW — CLI evidence self-fail gate can false-positive on its own published `mintedTokenIds`; the CLI happy path is untested

`scripts/e2e/memory-negative-probes.ts:408-420` builds the evidence payload including `mintedTokenIds: result.mintedTokenIds` (`:414`), then `:423-427` refuses to write and exits 1 if the serialized payload contains the literal `mgrun-` (the documented key-material prefix). If token ids share the `mgrun-` prefix with key material (common for mint/secret pairs — the diff never shows `src/memgate`'s id format), every CLI run self-fails at the scrub gate, exits 1, and the standalone leg can never produce evidence or a green exit — the gate meant to catch *material* leaks eats the *identifier*. Nothing in the unit suite would catch it: the only CLI test is the missing-env exit-2 path (`tests/scripts/memory-negative-probes.test.ts:252-267`); there is no full-env CLI run asserting exit 0 and a written evidence file. Either assert the token-id shape is `mgrun-`-free at the source, exclude ids from the gate's scope, or add the happy-path CLI test.

### 7. LOW — roster-check preflight treats a spawn failure (`exitCode === null`) as "warn + proceed"

`tests/fleet/e2e/memory-combined.live.test.ts:479-489`. The wiring throws only on `exitCode === 1`; every other outcome is folded into `unevaluable on this host (exit ${rosterCheck.exitCode}) — pre-fire runbook step stands`. `Bun.spawnSync` returns `exitCode: null` when the child was killed by a signal or could not spawn (bun binary missing, ENOENT). That is not "the host lacks the live-provider half" (the sanctioned exit-2 case the comment describes) — it is the preflight never having run at all, and it proceeds on the box round with nothing but a stderr note. A crashed gate should be distinguishable from a skipped gate in the pushed evidence object too (the evidence only records the verdict string).

### 8. LOW — `row.runId` asserted to equal the request id: unvalidated field-naming assumption on the side-channel seam

`tests/fleet/e2e/memory-combined.live.test.ts:562` (`expect(row.runId).toBe(round.requestId)`), against a row read from `${round.requestId}.json` (`:555`). The assert assumes the M1.2 `RecallRow` field named `runId` carries the *request* id. If the field carries the fleet run id (the name suggests it), a green round fails here. Same class of unvalidated-seam assumption as finding 2 — no sample row, no live evidence in the diff — and notably the LD degrade control (`:324-332`) asserts `primed`/`directive` but pointedly not `runId`, so nothing in this diff corroborates the field's content.

## Checked clean (no findings)

- **Budget arithmetic**: `LEG_TOTAL_MS` = 2.7M + 2.4M + 3.6M = 8,700,000 ms; `LEG_TOTAL_HOURS` ≈ 2.4167 → printed "2.42 h" ✓; `BOX_WORST_MICRO_USD` = ceil(2.4167 × 230,000) = 555,834 ✓; worst-case print (555,834 + 50,000)/1e6 = "$0.61" ✓; the three `LEG_CEILINGS_MS` entries match the three test timeouts exactly ✓; `--timeout-ms 960000` > `runBudgetMs 900_000` (60 s headroom) < runFleet's 1,200,000 parent timeout ✓; the runBudgetMs comment's claim is consistent with the observed R2-001 fact (600,000 refused ⇒ multiplier K=3 fits: 242,000 × 3 = 726,000 ≤ 900,000), though K itself is outside the diff.
- **cat-file blob roster comparison**: the staged-vs-SHA compare is genuinely non-tautological (working-tree `copyFileSync` vs `cat-file blob ${sha}:path`, both hashed as UTF-8 strings — identical bytes ⇒ identical hashes, BOM/CRLF preserved on both sides); the bare-SHA probe precedes the path probe so fetch errors read as fetch errors; redundant `-e` + `blob` is belt-and-suspenders, not a bug.
- **Roster-check ordering**: it runs pre-dispatch, so its throw is genuinely pre-box-spend; the staged roster is byte-identity-proven equal to the SHA blob the in-box `spec.roster` load will read, so checking the staged copy is sound.
- **Composite rethrows (L1/L2)**: problems-lead with `cause: failure`, failure-only, problems-only — all three orderings correct; both finallys only call the quiet writer.
- **Unparseable-line problems (L2)**: `unparseable` placeholders can't collide with the `kg_recall.*` filters; the count flows to `evidenceProblems`; `hygiene` can't be poisoned by placeholders (covered by finding 5 for a different reason).
- **`revokeAll` sync-in-finally**: `revokeRunMemoryKey` is called synchronously and each token is individually try/caught; dedup via `Set`; the already-revoked probe key correctly reads "already-gone" (asserted).
- **Battery `allRefused`**: demands outcome-count match AND per-probe named reason; reason:null (transport-class) correctly fails it; the 200-on-no-auth negative control correctly flips to `refused:false` and is asserted by the stub test.
- **Clock stepping in tests**: CLOCK_STEP_MS=10s per read spans the 5 s TTL+5 s skew window on the first poll check; 1 h backstop TTL survives the ~15 reads one battery makes; cap is wall-clock so a frozen injected clock can't hang.
- **Probe-bank cleanup on early L1 failure**: ids are pushed to `banksWeCreated` immediately after each create resolves, and L3's finally deletes them even when L1/L2 failed hollow; no bank is deleted that was never confirmed created.
- **DD-16 forensics asserts are non-vacuous**: presence of both pair members is asserted, not just absence of foreigns.
- **Receipt dedup**: length==1 asserted pre-reharvest, subjectId asserted, post-reharvest length==1 re-asserted, divergent-alarm asserted absent on an explicitly un-muted stream.
- **Audit ordering asserts**: sentinel −1 indices fail `toBeGreaterThan` correctly; exactly-once counts re-asserted in the walk.
- **roster `writes: []`**: consistent with the manifest's no-write task and the schema comment; not contradicting any added line (the roster comment's "phases are code-kind" wording vs the dispatch_task middle phase is a doc nit only).
- **Dockerfile re-pin**: new tree SHA matches the quoted refusal message verbatim; provenance narrative is internally consistent (operator-verifiable externally, no internal contradiction).
- **sprint-status**: ready-for-dev → in-progress is a plain status flip; no other line touched.
- **failure-recovery timeout**: `{ timeout: 600_000 }` options-object form is the same pattern this diff's own unit suite uses; the 600 s ceiling exceeds the ~6 s retry ladder with the documented runner semantics; no diff-provable defect.
