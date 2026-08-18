# DF2.4 Design Brief — research conclusions (Phase 2→4 injection)

Confidence 0.97 (A 1.0 · B 1.0 · C 0.9 · D 1.0 · E 0.9 · F 1.0). Baseline `bun test tests/providers/` GREEN (267 pass / 1 todo / 0 fail).

## Verified composition surface (lift from merged DF stories — write NO new credential/teardown code)

| Need | Verb (verbatim signature) | Source |
|---|---|---|
| Record | `new RunRecordStore(dir)`, `store.create(runId)`, `store.set`, `store.get`, `store.close(runId)` | run-record.ts:367-538 |
| Run id | `newId("df2-4-cap-hit", now)` → `<slug>-<YYYYMMDD>-<6hex>` | run-record.ts:159 |
| Mint | `mintRunKey(deps, runId)` with `deps.capMicroUsd = 50_000` (µ$; converts to `0.05` USD at HTTP boundary) | credentials.ts:182 |
| Deliver | `deliverRunKey(deps, vmName, key)` → stdin, 0600 `/home/agent/app/.env` | credentials.ts:340 |
| Spend | `captureSpend(deps, runId)` → µ$ int (provisioning LIST entry `usageUsd`; host-side; the mandated-unchanged DF2.3 verb) | credentials.ts:361 |
| Revoke+verify | teardown steps 4-5 call `revokeRunKey`/`verifyRevoked` (list-absence proof) | credentials.ts:395,452 |
| Teardown | `teardownSandbox(deps, runId, {})` — six steps + aborts, UNCHANGED | teardown.ts:197 |
| Box | `driver.create(name)` → `driver.fill(vm, {runId, repoUrl, commitSha})` → `driver.setup(vm, {runId, rosterPath, commitSha, ...})` → five-assertion gate | exedev/driver.ts:354-360, setup-gate.ts:187 |
| Workload | `executeRun(driver, vm, argv, stdin?)` → raw `ExecResult{stdout,stderr,exitCode}` — non-zero exit is DATA | driver.ts:222 |
| Key API client | `openRouterKeyApi()` (env `OPENROUTER_PROVISIONING_KEY`) | credentials.ts:555 |

## OpenRouter facts (live, doc-verified)

- `POST /keys {name:"sbx-<runId>", limit: <USD dollars>}` → `{data:{hash,limit,usage}, key}` — plaintext key returned ONCE.
- Cap rejection on `POST /chat/completions`: **HTTP 402** `{"error":{"code":402,"message":"Insufficient credits..."}}`.
- `GET /key` (runtime key): `{data:{usage, limit, limit_remaining}}` in USD dollars.
- µ$ conversion ONLY at HTTP boundary via `usdToMicros/microsToUsd` (DD-9; DF2.3 owns it — demo never converts).

## classifyRunExit — the ONE new mechanism (src/providers/cap-rejection.ts)

```ts
classifyRunExit({ inBoxExit, usageMicroUsd, capMicroUsd, providerCapRejected, terminationProvenance })
  → { exitStatus: ExitStatus; killOrigin: "provider-cap" | "wall-clock" | "host-error" | null; verdict: "demonstrated-input" | ... }
```
- overflow iff `usageMicroUsd ≥ capMicroUsd` AND `providerCapRejected` AND `terminationProvenance ∉ {"wall-clock","host-error"}`; killOrigin "provider-cap".
- Every other usage≥cap case → inconclusive-lean: keep inBoxExit, killOrigin = terminationProvenance.
- Demo-level verdict mapping (script): `demonstrated` / `inconclusive:{wall-clock-first|cap-below-first-turn|no-rejection|no-live-account|host-error}`.
- **ExitStatus type**: mirror the 5-value CC-1 union LOCALLY (providers tree has ZERO cli-anything imports — keep it that way; story AC5 rationale). Test file imports BOTH and asserts mirror == EXIT_STATUSES (drift guard). phase-engine/types.ts:14 is the legacy precedent, NOT followed here.
- Pure function, no I/O — fully unit-testable.

## providerCapRejected + terminationProvenance — host-produced only

- After workload terminates, BEFORE revoke (key still live): host re-probe = one `POST /chat/completions` (cheap model, max_tokens minimal) with retained runtime key. 402 → `providerCapRejected: true`, verbatim status recorded. Any other outcome → false. Probe failure to issue → false (→ inconclusive).
- terminationProvenance: `wall-clock` (900_000 ms ceiling fired), `host-error` (host call path failed), `provider-cap` (re-probe rejected), `null` (workload self-exited).
- NOTHING read from box output. turnsCompleted is the only in-box figure, `source:"in-box"`, can only downgrade (AC4).

## scripts/cap-hit-demo.ts shape (composition only)

`bun scripts/cap-hit-demo.ts [--cap <µ$>] [--roster <path>]` (+ `--driver`, `--dir`, `--budget-cap`, `--ceiling`, `--repo-url/--sha` for live; defaults from env).
Flow: requestId=`crypto.randomUUID()` → record create → mint (cap=--cap, default 50_000) → create box → fill → setup gate (assert ready; E asserts credit headroom) → deliver key → loopy workload via executeRun under wall-clock race (900_000 ms) → re-probe + captureSpend → classifyRunExit → write artifact → teardownSandbox (every verdict) → final report.
- Logging: `timedLoggedStep`/`timed` conventions — `{requestId, runId, step, keyHashPrefix, durationMs, outcome}` to stderr sink; sub-timings mint_ms/setup_ms/workload_ms/reprobe_ms/capture_spend_ms/teardown_ms.
- Args via `scripts/lib/cli-args.ts` (tokenizeArgs/parseValueFlags); errors `!! <code>: <msg>` + `next: <literal command>`.
- Inner controls recorded not enforced: `--budget-cap 40_000`, `--ceiling 30_000` → artifact fields runBudgetCapMicros/residentSpendCeilingMicros (DF3.6/DF2.8 not in loop).
- Artifact: `.sandbox/evidence/df2-4-cap-hit-<runId>.json` (dir 0700/file 0600, atomic tmp+rename, sibling-of-runs NOT inside `.sandbox/runs/` — RunRecordStore.list() bricks on strays). Fields: capMicroUsd, spendMicroUsd, turnsCompleted(+source), rejectionStatus (redacted), exitStatus, killOrigin, revocationVerified, closedAt, verdict(+reason), runId, keyHashPrefix... wait — keyHash full? DF2.1 stores keyHash in record (hash is not key material; teardown.just echoes hashes freely). Keep `keyHash` (record-identifying), never the key.
- Redaction (AC5): reimplement under `src/providers/` — run-key-as-input redactor: replace every ≥8-char substring occurrence of the key in the rejection body with `[REDACTED]` (boundary rule from redact.ts:23-27 MIN=8). Scan artifact with leakScan-style every-8-char-substring check → zero hits.

## Workload fixture (net-new — nothing liftable anywhere, verified)

`tests/providers/fixtures/loopy-workload.yaml`: prompt that never terminates ("Count aloud from 1 upward, one number per line. Never stop, never summarize."), model `deepseek/deepseek-v4-flash-0731`, non-termination markers. Unit test asserts shape + non-terminating intent (contains explicit never-stop instruction, no turn cap). In-box argv: `pi -p --mode json <prompt>` (roster model), long-running; host kills at wall-clock if provider cap never fires.

## Tests (TDD — write FIRST)

1. `tests/providers/cap-rejection.test.ts` — classifier truth table (transient/logic/lead_failure × cap-hit → overflow; missing providerCapRejected → NOT overflow; wall-clock/host-error provenance → NOT overflow; usage<cap → inBoxExit passthrough; CC-1 mirror sync).
2. `tests/providers/cap-hit-demo.test.ts` — script-level with FakeDriver+FakeKeyApi substrate: happy path (fake key api exhaustible → cap hit, 402 re-probe) → artifact schema exact key-set; self-report trap (box claims transient / box output claims cap-reject → re-probe false → inconclusive); wall-clock-first → inconclusive + teardown invoked; turnsCompleted 0 → cap-below-first-turn; teardown invoked on EVERY verdict incl. host-error; record gains no field (key-set diff); leak scan; fixture non-termination.
   Live: `test.todoIf(!QDS_EXEDEV_LIVE)` + half-set-env refusal (setup-gate.test.ts:522-535 convention).
3. Fake substrate extension: FakeKeyApi needs a cap-rejecting chat endpoint seam for the probe — add `chatComplete?(key, model)` knob to fake-key-api.ts IF absent (scope: tests/fixtures, allowed).

## Evidence + DoD

- Live run gated by env (QDS_EXEDEV_LIVE + repo/sha/roster + OPENROUTER_PROVISIONING_KEY). Real spend ≤ $0.05 + one request overshoot.
- Artifact → committed `_bmad-output/sprint-artifacts/dark-factory-v5/evidence/df2-4-cap-hit.md` (discharges audit §6 hole 6 / DD-6).
- If live impossible: verdict `inconclusive`/`no-live-account`, record in Dev Agent Record, never fake-claim.

## Guardrail plan

GR-001 ok (branch cut). GR-002 scope: story Files-to-Modify + fake-key-api knob (tests/fixtures — sibling precedent DF2.5 extended fixtures). GR-003 TDD strict: test files first, red, then impl. GR-005: tsc+lint+bun test green before complete.
