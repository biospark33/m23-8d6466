# Fleet Map Audit Report: Agent fleet-map-3

**Files audited:**
- `tests/fleet/fanout.test.ts` (946 lines)
- `tests/fleet/patterns.test.ts` (1488 lines)
- `tests/fleet/rank.test.ts` (615 lines)
- `tests/fleet/brief-schema.test.ts` (1356 lines)

**Date:** 2026-08-24

---

## Matrix: Suite × Substrate Surface

### fanout.test.ts (946 lines)

| Suite / Test Group (describe) | Sandbox Box | Host Process | Signals | Git | SQLite | Network/HTTP | exe.dev API | Model/LLM API | Ledger |
|-------------------------------|-------------|--------------|---------|-----|--------|--------------|------------|---------------|---------|
| FanoutRecordStore (AC9) - l190+ | **FAKE** (FakeDriver host-tmpdir) | none | none | none | none | none | none | none | none |
| readOwnPidStartTime - l415+ | none | none | none | none | none | none | none | none | none |
| FleetLock (AC8) - l444+ | none | **REAL** (Bun.spawn) | **REAL** (SIGINT/SIGTERM) | none | none | none | none | none | none |
| Subprocess SIGINT test - l900+ | none | **REAL** (Bun.spawn l904) | **REAL** (child.kill SIGINT l911) | none | none | none | none | none | none |
| Concurrent race barrier - l919+ | none | **REAL** (Bun.spawn l925, l929) | **REAL** (kill SIGKILL l941) | none | none | none | none | none | none |

**Line evidence for REAL subprocess usage:**
- l904: `const child = Bun.spawn(["bun", scriptPath, lockPath, "req-sigint-child"]);`
- l911: `child.kill("SIGINT");`
- l925: `const a = Bun.spawn(["bun", scriptPath, lockPath, "req-race-a"]);`
- l929: `const b = Bun.spawn(["bun", scriptPath, lockPath, "req-race-b"]);`
- l941: `a.kill("SIGKILL");`

### patterns.test.ts (1488 lines)

| Suite / Test Group (describe) | Sandbox Box | Host Process | Signals | Git | SQLite | Network/HTTP | exe.dev API | Model/LLM API | Ledger |
|-------------------------------|-------------|--------------|---------|-----|--------|--------------|------------|---------------|---------|
| fleet fanout patterns (DF3.2 AC1-AC6) - l230+ | **FAKE** (RaceFakeDriver host-tmpdir) | none | none | **REAL** (comment-only, see below) | none | none | none | none | **FAKE** (goodLedger spy) |
| validation (D9) - l337+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| admission (AC1) - l426+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| isolation/mint ordering (AC2/AC3) - l514+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| concurrency bound (K8) - l561+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| per-arm cap enforcement - l593+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| arm failure isolation (AC4) - l634+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| race (AC5) - l703+ | **FAKE** | none | none | **REAL** (implicit via FakeDriver.destroy) | none | none | none | none | **FAKE** |
| degenerate case/pin control (AC6/D9) - l1292+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| records (AC9) - l1353+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |
| single-operator enforcement (AC8) - l1437+ | **FAKE** | none | none | none | none | none | none | none | **FAKE** |

**Git references (REAL but implicit):**
- l885: `// The deadline must clear the REAL git bundle-verify probe teardown runs`
- l927: `// the injected deadline alone is 2s, plus a REAL git bundle-verify probe`
- l973: `// the loser's REAL teardown (git bundle-verify) rides the 2s deadline path`

**Note:** The "REAL git" refers to FakeDriver.destroy() which calls real `git bundle verify` on the host - this is real git exec but the box itself is fake (host tmpdir). The test uses this real git behavior to bound teardown timeouts but does not test exe.dev boxes.

### rank.test.ts (615 lines)

| Suite / Test Group (describe) | Sandbox Box | Host Process | Signals | Git | SQLite | Network/HTTP | exe.dev API | Model/LLM API | Ledger |
|-------------------------------|-------------|--------------|---------|-----|--------|--------------|------------|---------------|---------|
| rank (DF3.2 AC7) - l70+ | none | none | none | none | none | none | none | none | none |

**Pure unit test file** - uses local harness() fake with no external substrate.

### brief-schema.test.ts (1356 lines)

| Suite / Test Group (describe) | Sandbox Box | Host Process | Signals | Git | SQLite | Network/HTTP | exe.dev API | Model/LLM API | Ledger |
|-------------------------------|-------------|--------------|---------|-----|--------|--------------|------------|---------------|---------|
| brief-schema.ts (DF3.1 AC1, AC2, INV-2, C3) - l118+ | none | none | none | none | none | none | none | none | none |
| manifest stamp helpers (DF3.1 AC9a) - l972+ | none | none | none | none | none | none | none | none | none |
| repoUrl/repoSlug cross-check - l1259+ | none | none | none | none | none | none | none | none | none |

**Pure schema validation file** - Zod tests only, no substrate integration.

---

## What is Genuinely REAL

### By Surface

| Surface | Files With Real Usage | Line Evidence |
|---------|----------------------|---------------|
| **Sandbox box** | NONE | All use FakeDriver/RaceFakeDriver (host tmpdir) |
| **Host process** | `fanout.test.ts` | l904, l925, l929 (Bun.spawn for lock choreography) |
| **Signals** | `fanout.test.ts` | l911 (SIGINT delivery), l941 (SIGKILL) |
| **Git** | `patterns.test.ts` (implicit) | l885, l927, l973 comments note `git bundle verify` runs via FakeDriver.destroy |
| **SQLite** | NONE | No `new Database` or `cost-ledger.db` found |
| **Network/HTTP** | NONE | No `fetch` or http calls found |
| **exe.dev API** | NONE | No exe.dev API calls found |
| **Model/LLM API** | NONE | No LLM/model API calls found |
| **Ledger** | ALL (as spy) | All use RecordingLedger/goodLedger from `helpers.ts` (spy, not real CostLedger) |

**Note on "REAL git":** The patterns.test.ts comments about "REAL git bundle-verify" refer to the fact that FakeDriver.destroy() calls real `git bundle verify` on the host system. This is real git execution, but the boxes are still fake (host tmpdir directories), not real exe.dev VMs.

---

## Untested Real Paths (Substrate Surfaces NEVER Exercised)

| Surface | Files That Do NOT Exercise Real |
|---------|---------------------------------|
| **Real exe.dev sandbox boxes** | ALL 4 files - all use FakeDriver/RaceFakeDriver (host tmpdir) |
| **Real SQLite CostLedger database** | ALL 4 files - all use RecordingLedger spy from helpers.ts |
| **Real exe.dev API calls** | ALL 4 files - zero exe.dev API calls |
| **Real model/LLM API calls** | ALL 4 files - zero LLM API calls |
| **Network/HTTP fetch** | ALL 4 files - zero HTTP/fetch calls |
| **Real SIGTERM delivery (not SIGINT)** | ALL 4 files - only SIGINT tested (fanout.test.ts l911) |
| **Real process reaping beyond signal delivery** | patterns.test.ts, rank.test.ts, brief-schema.test.ts - only fanout.test.ts tests process lifecycle |

**Summary:** These are unit/integration tests over fake substrates. The only real substrate surfaces exercised are:
1. Host subprocess spawning (Bun.spawn) in `fanout.test.ts` for lock choreography
2. Signal delivery (SIGINT/SIGKILL) in `fanout.test.ts`
3. Host git execution (implicit via FakeDriver.destroy) noted in `patterns.test.ts` comments

---

## Imports from tests/providers

### helpers.ts (`tests/fleet/helpers.ts`)

**Imports and what they fake:**
- `RecordingLedger` - interface for ledger spy (l22-25)
- `goodLedger()` - admits-at-ceiling spy (l66-80)
- `overBudgetLedger()` - over-budget rejection spy (l83-93)
- `admitThrowsLedger()` - throws on admitIssue (l108-112)
- `closeThrowsLedger()` - throws on close (l120-128)
- `deadPid()` - spawns true subprocess for death proof (l144-148)
- `liveChild()` - spawns live `sleep 30` child (l151-153)

**Conclusion:** `helpers.ts` provides ledger spies (RecordingLedger variants) and process helpers for lock tests. All are fakes/spies, not real substrate.

### No other test provider imports

The 4 audited files do NOT import:
- `tests/providers/fixtures/*` (not used)
- `tests/fleet/fixtures/*` (none found)
- Any other shared fixture files

---

## Environment-Gated Tests

**No tests are env-gated or skipped by default.**

Searched for:
- `describe.skip` - none found
- `test.skip` - none found
- `skipIf` - none found
- `QDS_*` env vars used only for:
  - `QDS_FANOUTS_DIR` (fanout.test.ts l201-214) - tested but not gating
  - `QDS_QUOTA_LIMITS_FILE` (patterns.test.ts l486-507) - tested but not gating

All tests run by default with no env var requirements.

---

## Load-Flake Tests (K8/AC5 Family)

**No tests documented as load-flake-prone in these 4 files.**

The mission mentioned K8/AC5-family tests documented as load-flake-prone, but no such documentation was found in:
- `fanout.test.ts`
- `patterns.test.ts`
- `rank.test.ts`
- `brief-schema.test.ts`

The timeout values (20,000ms, 30,000ms, 40,000ms) suggest awareness of potential flakiness, but there are no explicit skipIf guards or load-flake warnings.

---

## Secret Redaction

**No secrets found in test files.**

No tokens, keys, or passwords discovered in the 4 audited files. The only secret-like string was a test fixture value (`qds-x https://openrouter.ai/api/v1/keys/s3cr3tvalue99` in rank.test.ts l421) which is a dummy test value, not a real secret.

---

## Summary

**FAKE dominance:** All 4 test files use fake substrate surfaces (FakeDriver, RecordingLedger spies) rather than real exe.dev infrastructure.

**REAL minority:** Only `fanout.test.ts` exercises real host subprocess spawning and signal delivery for fleet lock choreography. `patterns.test.ts` notes real git execution via FakeDriver.destroy but does not test exe.dev boxes directly.

**UNTESTED:** Real exe.dev VMs, SQLite CostLedger, exe.dev API, LLM APIs, and HTTP/network are never exercised in these 4 test files.
