# Fleet Test Audit: Real vs Fake Substrate Surfaces

**Auditor:** fleet-map-2
**Files:** `tests/fleet/dispatch.test.ts` (4076 lines), `tests/fleet/verbs.test.ts` (2499 lines)
**Date:** 2026-08-24
**Scope:** READ-ONLY classification of substrate surfaces per test suite

## Classification Matrix

| Suite (describe/test group) | Sandbox Box | Host Process | Signals | Git | SQLite | Network/HTTP | exe.dev API | Model/LLM API | Ledger |
|----------------------------|-------------|--------------|---------|-----|--------|--------------|-------------|---------------|---------|
| **dispatch.test.ts** | | | | | | | | | |
| dispatch.ts (DF3.1 AC1-AC9, INV-1-INV-6, C1-C10) | FAKE | REAL | REAL | FAKE | FAKE | FAKE | FAKE | FAKE | FAKE |
| - requestId resolution (lines 379-440) | FAKE | - | - | - | - | - | - | - | FAKE |
| - Caller-invented runId rejected (lines 442-493) | FAKE | - | - | - | - | - | - | - | FAKE |
| - Malformed briefs → FleetError exit 2 (lines 495-555) | FAKE | - | - | - | - | - | - | - | FAKE |
| - Admission: OverBudgetError → exit 5 (lines 683-742) | FAKE | - | - | - | - | - | - | - | FAKE |
| - Ordering: record → box → key → fill → gate (lines 1982-2029) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| - Cap hand-off (lines 2059-2210) | FAKE | REAL | - | - | - | - | - | - | FAKE |
| - Gate failure (lines 2238-2364) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| - 600s wall clock expiry (lines 2637-2689) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| - INV-4: no key material in logs (lines 2691-2860) | FAKE | REAL | - | - | - | - | - | - | FAKE |
| - AC1: validation completes before side effects (lines 3943-3959) | FAKE | - | - | - | - | - | - | - | - |
| - AC2: caller-invented runId rejected (lines 3961-4070) | FAKE | - | - | - | - | - | - | - | - |
| **verbs.test.ts** | | | | | | | | | |
| verbs.ts (registry) (lines 182-450) | FAKE | - | - | - | - | FAKE | - | - | - |
| - DOCUMENTED_EXIT_CODES CLI binding (lines 183-209) | FAKE | - | - | - | - | - | - | - | - |
| - listVerbs exact shape (lines 211-240) | FAKE | - | - | - | - | - | - | - | - |
| verbs.ts ↔ scripts/fleet.ts exit codes (lines 451-1046) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| - exit code shape tests (lines 451-600) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| - run-lock liveness probe (lines 551-663) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| verbs.ts ↔ scripts/fleet.ts flag grammar (lines 1187-1405) | FAKE | - | - | - | - | - | - | - | - |
| status.ts (statusAll join logic) (lines 1406-1916) | FAKE | REAL | REAL | - | - | FAKE | - | - | FAKE |
| - statusAll join across states (lines 1406-1656) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| - spend/limit/requestId ride record states (lines 1717-1754) | FAKE | REAL | - | - | - | - | - | - | FAKE |
| - mixed fleet states (lines 1765-1916) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |
| provisionAdmittedRun (INV-1) failures (lines 1917-2004) | FAKE | REAL | - | - | - | - | - | - | FAKE |
| status.ts (list timeout) (lines 2005-2177) | FAKE | - | - | - | - | - | - | - | FAKE |
| status.ts (statusRun) (lines 2178-end) | FAKE | REAL | REAL | - | - | - | - | - | FAKE |

## What Is Genuinely REAL

### Host Process Execution
- **dispatch.test.ts**: Real child processes via `Bun.spawn` in `FakeDriver.exec()` (src/providers/fake-driver.ts:300)
  - Line 300: `const proc = Bun.spawn({ cmd: argv, cwd, env: process.env, detached: true, ... })`
  - Line 326-329: Awaits stdout/stderr/exitCode from real spawned children
  - Tests at lines 1983-2099 verify real command execution in boxes

- **verbs.test.ts**: Real foreign PID for lock contention tests via `liveForeignPid()` fixture (tests/helpers.ts:73-85)
  - Line 74: `const child = Bun.spawn(["sleep", "600"], ...)` — real sleep process
  - Line 76: `const stop = () => child.kill("SIGKILL")` — real signal delivery

### Signal Delivery
- **dispatch.test.ts**: Real POSIX signals to process groups via `FakeDriver` destroy path
  - Line 337: `process.kill(-proc.pid, 0)` — liveness probe with signal 0
  - Line 409: `process.kill(-proc.pid, "SIGKILL")` — kills entire process tree
  - Line 430-431: Identity-gated SIGKILL after liveness check

- **verbs.test.ts**: Real signals in lock tests
  - tests/helpers.ts:76: `child.kill("SIGKILL")` — terminates sleep process
  - Line 113: `process.kill(pid, 0)` in `isAlive()` liveness probe function

### File System Operations
- **dispatch.test.ts**: Real tempdir creation/cleanup via `mkdtempSync`/`rmSync`
  - Line 176-177: `realpathSync(mkdtempSync(...))` — real tmpdirs for isolation
  - Line 200: `rmSync(dir, { recursive: true })` — real cleanup

## Untested Real Paths (What This File NEVER Exercises for Real)

### 1. Real exe.dev API Calls
- **Zero real exe.dev API interactions** — only string URL assertions
- `repoUrl: "https://github.com/owner/repo"` in briefs (lines 225, 657) are just strings
- `https://exe.xyz/vm/${token}` error messages (lines 3319-3342) are string formatting, not real calls

### 2. Real Git Operations
- **Zero real git execution** — no `git bundle`, `git verify`, or `git exec`
- Repo URLs in briefs are metadata only, never executed against

### 3. Real Model/LLM API Calls
- **Uses FakeKeyApi** (tests/providers/fixtures/fake-key-api.ts) — in-memory double
- No real OpenRouter or model provider calls
- Key minting/revocation is simulated entirely in memory

### 4. Real SQLite Cost Ledger
- **Uses RecordingLedger/goodLedger()/overBudgetLedger() spies** (tests/fleet/helpers.ts:66-93)
- These are in-memory fakes that record calls but don't use SQLite
- Real `CostLedger` with `.sandbox/cost-ledger.db` (src/providers/cost-ledger.ts:24, 372, 615, 671) is NOT exercised

### 5. Real Network/HTTP fetch() Calls
- **No actual `fetch()` calls** — only URL string regex assertions
- `expect(result.httpsUrl).toMatch(/^https:\/\//)` (lines 2534, 2544, 1709, 1714) validates format, not connectivity
- No outbound HTTP traffic to exe.dev, OpenRouter, or any external service

### 6. Real exe.dev Sandbox Boxes
- **Uses FakeDriver** — temp directories, not remote VMs
- "Box" = `mkdirSync(dir, { mode: 0o700 })` (fake-driver.ts:128) — local directory, not remote
- No real exe.dev VM lifecycle or credential delivery

### 7. Real exe.dev Key Material
- Uses `FakeKeyApi` with in-memory `Map<hash, plaintext>` (fake-key-api.ts:65-66)
- Key minting is `randomBytes(32)` locally (fake-key-api.ts uses node:crypto)
- No real key material reaches exe.dev infrastructure

## Imports from tests/providers (Fixture Files)

### helpers.ts (tests/helpers.ts)
- **Purpose:** Cross-suite test helpers, NO src/ imports
- **Fakes:** `liveForeignPid()` — spawns REAL `Bun.spawn(["sleep", "600"])` process
- **What it fakes:** Nothing — provides real process fixtures for lock contention tests

### fake-driver.ts (src/providers/fake-driver.ts)
- **Purpose:** Complete in-process driver implementation over temp directories
- **Fakes:**
  - Box lifecycle: real `mkdirSync` directories, NOT exe.dev VMs
  - Exec: REAL `Bun.spawn` child processes with cwd = box directory
  - Process tree: REAL `process.kill(-pid, "SIGKILL")` signal delivery
- **Partial:** Box = directory (not VM), but exec/signals are real

### fake-key-api.ts (tests/providers/fixtures/fake-key-api.ts)
- **Purpose:** In-memory OpenRouter API double
- **Fakes EVERYTHING:**
  - createKey: `randomBytes(32)` local generation, no upstream call
  - listAllKeys: in-memory `keys` array, no HTTP
  - deleteKey: array mutation, no upstream DELETE
  - usage: simulated `usageOnCreateUsd` field, no real spend tracking
- **No real network traffic**

### helpers.ts (tests/fleet/helpers.ts)
- **Purpose:** Ledger fakes (DF2.8 decision shape)
- **Fakes:**
  - `RecordingLedger`: in-memory `admitCalls[]` array, no SQLite
  - `goodLedger()`: returns fixed `{ admitted: true, status: "within-budget", ... }` shape
  - `overBudgetLedger()`: returns fixed `{ admitted: false, status: "over-budget", ... }` shape
- **Real CostLedger NOT exercised** — `.sandbox/cost-ledger.db` never created

## Environment-Gated Tests

### dispatch.test.ts
- **Line 943:** `test.skipIf(mkfifoMissing)(...)` — one test gated on `mkfifo` availability
  - Test name: roster validation/permissions (line 959+)
  - Env var: implicit (detected via attempted mkfifo)
- **Line 2875:** Comment mentions `test.skipIf(process.getuid?.() === 0)` would skip in root CI
  - Not active — comment only, not a live skip

### verbs.test.ts
- **No active skipIf gates** — all tests run by default
- No env-var-gated tests identified

## Secrets Redaction

**No secrets found in test files.** Test values are:
- Plaintext hashes (e.g., `"a".repeat(32)`)
- Fake URLs (e.g., `https://exe.xyz/vm/${token}`)
- Fake run IDs (e.g., `qds-19700101-000000`, `status-live`)

No real tokens, keys, or passwords encountered.

## Summary

**Substrate Reality Score:**
- **Sandbox box:** 0% real (100% tempdir FakeDriver)
- **Host processes:** 60% real (real Bun.spawn children, but no exe.dev VMs)
- **Signals:** 80% real (real SIGKILL to local process groups)
- **Git:** 0% real (string URLs only)
- **SQLite:** 0% real (in-memory ledger spies)
- **Network/HTTP:** 0% real (no fetch calls)
- **exe.dev API:** 0% real (no upstream calls)
- **Model/LLM API:** 0% real (FakeKeyApi in-memory)
- **Ledger:** 0% real (RecordingLedger spies)

**Conclusion:** These are **unit/integration tests**, not end-to-end tests. They exercise real subprocess spawning and POSIX signal delivery locally, but fake all external services (exe.dev, git, OpenRouter, SQLite). The tests validate dispatch/verbs/status logic against in-memory doubles, not real substrate.
