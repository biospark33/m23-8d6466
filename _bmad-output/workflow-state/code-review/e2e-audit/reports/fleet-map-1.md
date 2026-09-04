# Fleet Test Audit: Substrate Surface Classification

## Mission
Classify substrate surfaces in `tests/fleet/cli.test.ts` and `tests/fleet/fleet-lock.test.ts` as REAL / FAKE / PARTIAL based on what each test suite actually exercises.

---

## Matrix: Suite × Surface

### tests/fleet/cli.test.ts (4741 lines)

| Suite / Test (describe/test) | Sandbox Box | Host Process | Signals | Git | SQLite | Network/HTTP | exe.dev API | Model/LLM API | Ledger | Line Refs |
|----------------------------|-------------|--------------|----------|-----|--------|--------------|-------------|---------------|--------|-----------|
| **Main CLI describe block** | FAKE | REAL | REAL | PARTIAL | REAL-read/FAKE-write | FAKE | FAKE | FAKE | FAKE | 412-4741 |
| `--help renders registry` | FAKE | - | - | - | - | - | - | - | - | 521 |
| `help text exit-code table` | FAKE | - | - | - | - | - | - | - | - | 565 |
| `every documented help path` | FAKE | - | - | - | - | - | - | - | - | 625 |
| `no repoRoot defaults to cwd` | FAKE | - | - | - | - | - | - | - | - | 643 |
| `no verb → exit 2 usage` | FAKE | - | - | - | - | - | - | - | - | 676 |
| `registry verb dispatchable` | FAKE | - | - | - | - | - | - | - | - | 688 |
| `non-registry verb refused` | FAKE | - | - | - | - | - | - | - | - | 700 |
| `per-verb flag grammar` | FAKE | - | - | - | - | - | - | - | - | 752-933 |
| `EVERY refusal is diagnostic` | FAKE | - | - | - | - | - | - | - | - | 831 |
| `unknown flag refused` | FAKE | - | - | - | - | - | - | - | - | 888 |
| `flag=value parsing` | FAKE | - | - | - | - | - | - | - | - | 898-956 |
| `unknown brief field → exit 2` | FAKE | - | - | - | - | - | - | - | - | 1040 |
| `brief over 64 KiB → exit 2` | FAKE | - | - | - | - | - | - | - | - | 1049-1082 |
| `brief exactly 64 KiB accepted` | FAKE | - | - | - | - | - | - | - | - | 1059-1093 |
| `--brief /dev/zero refused` | FAKE | REAL | - | - | - | - | - | - | - | 1112 |
| `--brief missing path names errno` | FAKE | - | - | - | - | - | - | - | - | 1127 |
| `stdin brief + --brief refused` | FAKE | REAL | - | - | - | - | - | - | - | 1135-1249 |
| `stdin brief cap enforced` | FAKE | REAL | - | - | - | - | - | - | - | 1277-1316 |
| `invalid JSON brief → exit 2` | FAKE | - | - | - | - | - | - | - | - | 1271 |
| `--port validation` | FAKE | - | - | - | - | - | - | - | - | 1386-1433 |
| `setup-gate failure → exit 3` | FAKE | - | - | - | - | - | - | - | - | 1439 |
| `over-budget issue → exit 5` | FAKE | - | - | - | - | - | - | - | FAKE | 1476 |
| `invalid run-id grammar` | FAKE | - | - | - | - | - | - | - | - | 1500 |
| `status unknown-runId → exit 4` | FAKE | - | - | - | - | - | - | - | - | 1590 |
| `status live box orphan → exit 0` | FAKE | - | - | - | - | - | - | - | - | 1609 |
| `teardown unknown-runId → exit 4` | FAKE | - | - | - | - | - | - | - | - | 1637 |
| **e2e: dispatch→harvest→teardown** | FAKE | - | - | FAKE | REAL | - | FAKE | - | FAKE | 1662 |
| `harvest bundle protocol` | FAKE | - | - | REAL | REAL | - | FAKE | - | FAKE | 1700-1800 |
| `teardown takes run lock` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 1801 |
| `stale lock refuses` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 1867 |
| `harvest takes same lock` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 1917 |
| `lock vanishes between claim/read` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 1969 |
| `teardown holds lock on failure` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 2025 |
| `teardown no keyHash → exit 6` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 2109 |
| `teardown succeeds but can't release lock → exit 6` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 2166 |
| `four REAL acquirers hammer lock` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 2211 |
| `O_EXCL fallback exclusive` | FAKE | REAL | - | - | - | - | FAKE | - | FAKE | 2269 |
| **signal releases lock** | FAKE | REAL | REAL | - | - | - | FAKE | - | FAKE | 2332 |
| **dispatch SIGINT/SIGTERM delivered** | FAKE | REAL | REAL | - | - | - | FAKE | - | FAKE | 2384-2492 |
| `fleet/sandbox-teardown exclude each other` | FAKE | - | - | - | REAL | - | FAKE | - | FAKE | 2494 |
| `--dir scopes cost ledger` | FAKE | - | - | - | REAL | - | FAKE | - | FAKE | 2550-2612 |
| `sandbox-teardown same ledger` | FAKE | - | - | - | REAL | - | FAKE | - | FAKE | 2612-2746 |
| `second teardown bills once` | FAKE | - | - | - | REAL | - | FAKE | - | FAKE | 2687 |
| `--dir reaches status verb` | FAKE | - | - | - | REAL | - | FAKE | - | FAKE | 2746 |
| `stdout closed pipe handling` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 2780-2872 |
| `write failure not broken pipe` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 2872-2954 |
| `failed teardown no harvest waiver` | FAKE | - | - | - | REAL | - | FAKE | - | FAKE | 3563-3579 |
| `--dir resolves fanouts` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 3737-3814 |
| `rank scores completed fan-out` | FAKE | - | - | - | REAL | - | FAKE | - | FAKE | 3854-3946 |
| `run() leaves signal handlers unchanged` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 3368 |
| `interactive terminal refusal` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 3449 |
| `process.env.LINK_FAILS_AS` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 219-228 |
| `process.env.QDS_FANOUTS_DIR` | FAKE | - | - | - | - | - | FAKE | - | FAKE | 3765-3785 |

### tests/fleet/fleet-lock.test.ts (134 lines)

| Suite / Test (describe/test) | Sandbox Box | Host Process | Signals | Git | SQLite | Network/HTTP | exe.dev API | Model/LLM API | Ledger | Line Refs |
|----------------------------|-------------|--------------|----------|-----|--------|--------------|-------------|---------------|--------|-----------|
| **stealJudgedReapMutex** | N/A | REAL | PARTIAL | - | - | - | - | - | - | 35-134 |
| `STALE observation never removes REPLACED mutex` | N/A | REAL (liveChild) | - | - | - | - | - | - | - | 57-91 |
| `LIVE reap-mutex holder never stolen on mtime` | N/A | REAL (liveChild) | - | - | - | - | - | - | - | 93-113 |
| `recycled-pid holder stolen at once` | N/A | REAL (liveChild) | - | - | - | - | - | - | - | 115-134 |

**Legend:**
- **REAL**: Uses the real production substrate
- **FAKE**: Uses a fake/stub/double (never touches production)
- **PARTIAL**: Some tests use real, others use fake
- **N/A**: Surface not applicable to this test suite
- **-**: Not exercised in this specific test

---

## What is Genuinely REAL

### cli.test.ts

1. **Host processes** (lines 1184-2365, 1284, 1344, 1718+):
   - Real `Bun.spawn()` child processes for lock holders, racers, signal delivery tests
   - Real `Bun.spawnSync()` for git operations in harvest tests
   - Process group management and tree killing tested via real subprocess hierarchies

2. **Signal delivery** (lines 2344-2492):
   - Real SIGINT/SIGTERM delivery to real child processes
   - Exit codes 130/143 verified (128 + signal number)
   - Signal handlers installed/uninstalled in real CLI process

3. **Git operations** (lines 1718-1831):
   - Real `git init`, `git commit`, `git bundle create`, `git bundle verify`
   - Real `git rev-parse` for tip resolution
   - Harvest bundle protocol tested with genuine git bundles

4. **SQLite reads** (lines 2586-2735, 2672, 2735, 4315):
   - Real cost-ledger.db files on disk
   - Real `new Database(..., {readonly: true})` reads
   - File-based ledger verification across runs

5. **Filesystem locks** (lines 72-93, 1801-2269):
   - Real lock file creation via `acquireRunLock()`
   - Real O_EXCL atomic creation tested
   - Real lock host token read from actual lock body

6. **Environment variables** (lines 219-228, 3765-3785):
   - Real process.env manipulation for LINK_FAILS_AS, QDS_FANOUTS_DIR, QDS_RUNS_DIR, QDS_FAKE_BOXES_DIR

### fleet-lock.test.ts

1. **Host processes** (lines 28, 76, 99, 122):
   - Real `liveChild()` spawns actual processes via `deadPid()` and `liveChild()`
   - Real process identity (PID + start time) verification

2. **Signals** (line 48):
   - Real SIGKILL delivery to cleanup children in afterEach

---

## Untested Real Paths (Substrate Surfaces NEVER Exercised for Real)

### cli.test.ts

1. **exe.dev API**: ZERO real exe.dev API calls. All driver operations use FakeDriver in temp directories.

2. **Model/LLM API**: ZERO real model calls. No Claude/OpenRouter/OpenAI traffic.

3. **Network/HTTP**: ZERO real HTTP/fetch calls. All network faked via FakeKeyApi.

4. **Real exe.dev sandbox boxes**: Never tested. All box operations use FakeDriver (host tmpdir, not remote VMs).

5. **Real CostLedger writes**: Ledger writes use RecordingLedger fakes (`goodLedger()`, `overBudgetLedger()`). Only reads touch real SQLite files.

6. **Real OpenRouter key API**: FakeKeyApi used everywhere. Never touches upstream.

7. **Real git clone/fetch**: Only git bundle verify/rev-parse tested. No clone, no fetch, no push operations.

### fleet-lock.test.ts

1. **Sandbox boxes**: N/A - this suite tests mutex judgments only, no driver involved

2. **Git operations**: None

3. **SQLite/ledgers**: None

4. **Network/APIs**: None

5. **exe.dev**: None

6. **Models**: None

---

## Imports from tests/providers

### cli.test.ts imports:

1. **`../../src/providers/fake-driver.ts`** (line 46):
   - `FakeDriver` class - complete fake implementation of ProviderDriver seam
   - Creates boxes as temp directories with `.box.json` metadata
   - `exec()` spawns real child processes with box dir as cwd
   - `copyFile()` does real file copies
   - **Fakes**: No remote VMs, no exe.dev API, all local filesystem

2. **`../providers/fixtures/fake-key-api.ts`** (line 47):
   - `FakeKeyApi` class - in-memory double of OpenRouter key API
   - Stores keys in `keys[]` array, plaintexts in Map
   - **Fakes**: No real HTTP calls, all CRUD operations in-memory
   - Configurable failure modes (404, 5xx, stale-list, etc.)

3. **`./helpers.ts`** (line 38, 55):
   - `RecordingLedger`, `goodLedger()`, `overBudgetLedger()` - ledger fakes
   - `deadPid()`, `liveChild()` - process corpse helpers
   - **Fakes**: Ledger operations record calls but don't touch real CostLedger SQLite

### fleet-lock.test.ts imports:

1. **`./helpers.ts`** (line 28):
   - `deadPid()`, `liveChild()` - process helpers shared across suites
   - `readOwnPidStartTime()` - reads /proc or platform equivalent for PID identity

---

## Environment-Gated Tests

### No env-gated tests found in either file

All tests run by default. No `skipIf()` or env-based test skipping detected. Some tests manipulate environment variables as part of their fixture setup (e.g., `LINK_FAILS_AS`, `QDS_FANOUTS_DIR`), but none are skipped based on env presence/absence.

---

## Summary

**REAL surfaces exercised:**
- Host processes (Bun.spawn)
- Signal delivery (SIGINT/SIGTERM/SIGKILL)
- Git bundle operations (partial - only verify/create/rev-parse)
- SQLite reads (cost-ledger.db readonly)
- Filesystem locks (O_EXCL, lock bodies)
- Environment variables

**FAKE surfaces (never real):**
- exe.dev API/VMs
- Model/LLM API calls
- HTTP/fetch calls
- OpenRouter key API
- CostLedger writes (use RecordingLedger fakes)

**PARTIAL surfaces:**
- Git: bundle operations real, clone/fetch untested
- SQLite: reads real, writes faked

Both files maintain strict discipline: fakes for production APIs, real for process/signal primitives, hybrid for persistence (real files, fake business logic).
