# PR 123 Acceptance Audit — df3-1 Dispatcher Core Verbs

Auditor scope: story `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md` (9 ACs) + integration spec `_bmad-output/workflow-state/qds-dev/df3-1/integration-spec.md` (C1–C10, incl. amendment blocks), checked against pr123 source chunks (engine / fleet-rest / cli-a / cli-b / prov-a / prov-b). Test chunks were out of scope for this pass.

## Findings

**[MEDIUM]** `opts.runId` provenance is enforced by shape, not by mint origin — a forged but well-shaped id is accepted at runtime
- AC#/constraint violated: AC2 final clause — "a caller-invented `runId` (one never returned by `mintRunId()`) is rejected"; integration spec C1 — opts.runId "must satisfy assertValidRunId AND be a dispatcher-minted value; caller-invented → reject".
- Evidence: `chunk-engine.diff` (src/fleet/dispatch.ts) — line ~79 `MINTED_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/`; lines ~107–124 the `MintedRunId` brand is explicitly "the COMPILE-TIME half only"; lines ~1448–1478 the runtime check is `MINTED_RUN_ID_RE.test(opts.runId)` + `assertValidRunId`. Any caller able to bypass the type system (JS caller, `as MintedRunId` cast) can pass `qds-20260101-abc123` — shape-valid, never minted — and dispatch proceeds with it. Spec says reject; code accepts.
- Mitigating context (declared in code, not in the story): collisions with a real run are still caught by the step-4 `recordExists` fast path and step-6 `store.create` O_EXCL, so the practical exposure is squatting a *free* id, not hijacking a live one. DF3.2's actual contract (pre-mint via `mintRunId()` before the parallel section) is fully served. No registry of minted ids exists to check against, so this is the strongest feasible runtime enforcement — but it does not meet the AC's literal "rejected".

**[LOW]** Fake-gate honesty rule holds, but Decision 3's "five REAL `driver.exec` probes" overcounts — items D and E do not exec
- AC#/constraint violated: none materially; story Decision 3 / integration spec C7 wording mismatch ("five REAL `driver.exec` probes of the box's on-disk state").
- Evidence: `chunk-prov-b.diff` (src/providers/fake-gate.ts) lines ~1388–1510: only probes A (`exec ["true"]`), B (`exec cat pipeline.yaml`), and C (`exec stat .env`) run commands in the box; D ("stamped limitMicroUsd is a spendable positive integer") and E ("non-empty phases list") are structural reads of the manifest object B already fetched. The load-bearing rule — **no simulated verdicts** — is satisfied: nothing returns a stubbed `ready`, every verdict traces to real box state obtained by a real exec, failures carry per-item notes, and substrate failures are marked (`SUBSTRATE_MARK`) so exit-3 can be classified retryable. The in-code comment also documents why old item D ("manifest non-empty") was dead and replaced. Count of literal exec calls: three, not five.

**[LOW]** Post-mint downward clamp means the stamped/propagated cap can differ from the exact value handed to `mintRunKey`
- AC#/constraint violated: AC9b letter — run context carries `effectiveCeilingMicros` = "**the same value dispatch hands DF2.3's mint**, computed once here and propagated, never re-derived downstream."
- Evidence: `chunk-engine.diff` (src/fleet/dispatch.ts) lines ~1979–2008 hands `capMicroUsd: effectiveCeilingMicros` (= `decision.admittedCeilingMicroUsd`, DF2.8's `min(keyCap, remaining)`) to `mintRunKey`; lines ~2065–2077 then read back the provider-persisted `store.get(runId).limitMicroUsd` and compute `mintedCeilingMicros = Math.min(effectiveCeilingMicros, persistedCeilingMicros)`; lines ~2117–2146 stamp **both** `pipeline.yaml` (`stampManifestLimit`) and `run-context.json` (`effectiveCeilingMicros:` field) with `mintedCeilingMicros`. When the provider over-mints, the value crossing the boundary is lower than what was handed to the mint — a re-derivation at the dispatch layer the AC's "never re-derived" sentence does not carve out.
- Why LOW, not higher: the clamp is downward-only (never grants unreserved headroom), heavily justified in code (over-mint = provider authorizing spend the ledger never reserved; under-mint logged informationally, over-mint logged as error `mint-cap-over-request`), and AC9a's own text ("the **minted** `limitMicroUsd` is stamped") arguably demands exactly this figure. On the normal path (provider honors the cap) the values are identical and behavior is byte-for-byte as specified. Both carriers (manifest, run-context) always agree, so DF3.6's single-source rule and `pipeline-run.ts`'s reconcile-on-disagreement hold. Not declared in story or integration spec — flagging so the deviation is on record.

## Declared deviations verified as holding in code (not findings)

- **C1 overturn (compose primitives, never call createRun)** — verified: `createRun` keeps its own unconditional `checkHeadroom` + admission and now delegates its body to the extracted `provisionAdmittedRun`; `dispatch()` composes `provisionAdmittedRun` directly after its two dispatch-owned gates (`chunk-prov-b.diff` driver.ts ~591–950). N-arm fan-out makes exactly one `checkHeadroom(N)`.
- **DN1 expose/setPublic moved post-gate** — implemented verbatim: provisioning withholds `port`; expose/setPublic run at step 10 only after `gate.ready`, with speculative `ports` claim/retraction handling (`chunk-engine.diff` ~2329–2465).
- **Decision 4 superseded (shared lock module, not verbatim replication)** — `scripts/fleet.ts` imports acquire/release/mark/clear from net-new `scripts/lib/run-lock.ts`; release proves ownership; destructive-mark declines release mid-teardown; lock-refusal → exit 5, wedged cleanup → exit 6 (`chunk-cli-a.diff`, `chunk-cli-b.diff`). Strictly stronger than the original "replicated verbatim" text.
- **FTM deviation: `PipelineManifest.limitMicroUsd?: number`** — exactly the declared 1-line additive edit in `src/phase-engine/types.ts`; zod schema declares the field with `.int().positive().max(MAX_SAFE_INTEGER)`; `stripAuthoredLimit` closes the author-set-cap hole; `stampManifestLimit` refuses to return an unstamped manifest (AC9a refuse-if-absent producer side).
- **Gate refusal namespace** — new `gate` entry in `EXTENSION_NAMESPACES` (fields outcome/failedItem/assertionCode/failedAt) matches what dispatch writes on exit 3; record stays open, box alive.
- **requestId as core RunRecord field** — present (`CORE_FIELDS.requestId`, `RunRecord.requestId`), stamped best-effort on every path that can leave this dispatch's record, deliberately skipped on the run-id-race loser path (correct join-key direction).
- **RUN_ID_RE tightening** — RFC 1123 label grammar (both ends anchored) exported as `RUN_ID_RE`/`RUN_ID_MAX`, ending the 4-way duplication; `LEGACY_RUN_ID_RE` kept for reads; fleet layer delegates via `assertValidRunId` (no local copy).
- **withLock lost-update race fix** — `withLock(runId)` rework with contention reporting present in `chunk-prov-a.diff`.
- **C6 amended exit-code sets** — shipped registry declares dispatch `[0,1,2,3,5,6]`, status `[0,1,2,4]`, harvest `[0,1,2,4,5,6]`, teardown `[0,1,2,4,5,6]`, exactly matching the B8 + round-9 amendment block (base table's `[0,1,2,3,5]`/`[0,1,2,4]` is superseded in-spec, not violated).
- **C4 amendments** — `orphan` row `(orphan <vmName>)` parenthesised, recordless single-run probe with list-failure ≠ hit, `boxAlive?` tri-state, `listUnavailable`/`recordsSkipped` rows all present in `status.ts`.
- **AC1 round-5 unsafe-requestId refusals** — schema caps requestId at 128, refuses empty/blank/control chars (Cc/Zl/Zp/Cf incl. U+202E bidi and U+2028/29 terminators)/lone surrogates at exit 2, while non-v4-but-safe ids still pass schema and get re-minted (drop-rule intact). Non-string refused by zod type.
- **Observability contract** — 600_000 ms ceiling, 30_000 ms status list timeout (own wrapper, quota's 15 s not reused), sub-timings `validate_ms/mint_ms/create_ms/fill_ms/setup_gate_ms`, `appendDispatchFailure` on failures only, every log line carries requestId, rejected dispatch logs `runId: null` pre-mint, `FleetError` union widened to include 1 per B9, dispatch never calls `process.exit`, no `initiateSession` (D9), 64 KiB cap enforced by the CLI reader before JSON.parse.

## AC coverage table

| AC | Verdict |
|----|---------|
| AC1 validate-first, exit 2 names field, nothing provisioned; unsafe-requestId refusals | satisfied |
| AC2 dispatcher mints runId, sync ack, resolved requestId | partial — runtime runId provenance is shape-only (MEDIUM finding 1); everything else satisfied |
| AC3 gate failure → exit 3, assertionCode in payload, record open + box alive | satisfied (incl. extensions.gate record write, substrate-failure retryability) |
| AC4 status empty-fleet 0 / boxMissing / boxUnknown / exit-4 mutating nothing / orphan probe | satisfied (all round-3/round-5 amendments implemented) |
| AC5 harvest/teardown thin front doors, guards intact, no second retry loop | satisfied (delegates unmodified to `harvestRun`/`teardownSandbox`) |
| AC6 closed registry, --help renders from it, bidirectional parity | satisfied in source (registry-derived tokenizer + flag validation; the parity test itself lives in test chunks) |
| AC7 budget admission before record creation, exit 5 with DF2.8 payload, nothing provisioned | satisfied |
| AC8 headroom admission before record creation, list-unverified refuses, `{admitted:true}` suppresses | satisfied |
| AC9 cap hand-off both halves before tier 2 | satisfied (LOW finding 3: post-mint min-clamp narrows the propagated figure when a provider over-mints) |
| E2E demo (DoD) | satisfied-by-record — captured verbatim in story Dev Agent Record; all constituent pieces verified present in the diffs; live execution not re-run in this audit |

Bottom line: no CRITICAL or HIGH findings. One MEDIUM (AC2 runtime provenance gap, declared in code, collision-guarded), two LOW (probe-count wording; undeclared downward clamp on the propagated cap).
