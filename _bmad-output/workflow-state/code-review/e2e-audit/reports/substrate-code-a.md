# ExeDev Driver Real Path Audit

## Scope
Read-only audit of real exe.dev driver code paths in `src/providers/exedev/` (~1330 lines).

**Files read:**
- `src/providers/exedev/driver.ts` (543 lines)
- `src/providers/exedev/transport.ts` (85 lines)
- `src/providers/exedev/fill.ts` (169 lines)
- `src/providers/exedev/setup-gate.ts` (533 lines)

**Supplemental:** Grep-only analysis of `scripts/fleet.ts` and `scripts/sandbox-teardown.ts` for driver construction patterns.

---

## 1. Code Path Mapping

| Code Path | file:line | Description |
|-----------|-----------|-------------|
| **Auth/Credential Load** | `driver.ts:108-112` | Constructor reads `postureFile` option (default: `.sandbox/exedev-posture.json`) for VM-sharing attestation. No SSH credentials loaded here — SSH uses local `~/.ssh` config via `ssh` command. |
| **Box Create** | `driver.ts:148-205` | `create(name, tag)` → `ssh exe.dev new --name <name> [--tag <tag>] --json`. Parses `vm_name` from response, falls back to `ls` verification, derives `https://<name>.exe.xyz` URL. |
| **Box Exec** | `driver.ts:416-427` | `exec(vm, argv, stdin)` → `ssh <vm>.exe.xyz <command>`. POSIX-quotes argv elements via `shQuote()`, delegates to injected `ExeCommand` seam. |
| **Box Destroy/Status** | `driver.ts:325-336` | `destroy(vm)` → `ssh exe.dev rm <vm>`. Idempotent: re-queries `ls` on failure to confirm VM already gone. `list()` at `driver.ts:207-209`. |
| **Key Mint** | N/A (not in driver) | Keys are minted by `src/providers/credentials.ts` (`openRouterKeyApi()`), NOT by the exedev driver. Driver receives key delivery path, never the key itself. |
| **Key Revoke** | N/A (not in driver) | Key revocation is NOT an exedev driver operation. Reaping destroys the VM; key lifecycle is external. |
| **HTTP Transport** | `driver.ts:123-125` | `derivedUrl(vm)` returns `https://<vm>.exe.xyz`. Used by `create` fallback and `expose`. No HTTP client in driver — only derivations. |
| **Fill (Clone)** | `fill.ts:95-169` | `fillExeDev(driver, vm, opts)` → Git clone via `driver.exec()`. Validates repo URL (no userinfo), checks existing workdir, clones or fetches, creates `sbx/<runId>` branch at pinned SHA. |
| **Setup Gate** | `setup-gate.ts:206-533` | `setupGate(driver, vm, opts)` → Five assertions (A-E). Clears sentinel, writes `QDS_TEAM_RUNNER=local` to env file, runs in-box script for C/D/E (pi registry, live pings, cost table, credit check). |
| **Copy File** | `driver.ts:461-474` | `copyFile(vm, remotePath, localPath)` → `scp -q <vm>:<remotePath> <localPath>`. Validates remote path grammar before interpolation. |
| **Expose Port** | `driver.ts:338-355` | `expose(vm, port)` → `ssh exe.dev share port <vm> <port>`. Returns derived URL, logs `verified: "derived"`. |
| **Set Public** | `driver.ts:362-390` | `setPublic(vm)` → reads `postureFile`, asserts `vmSharing === "admins-only"`, then `ssh exe.dev share set-public <vm>`. Refuses without attestation. |
| **Whoami** | `driver.ts:393-405` | `whoami()` → `ssh exe.dev whoami`. Requires non-empty stdout (exit 0 alone is insufficient). Returns account name. |

---

## 2. Environment Variables & Credentials

### Driver-Respected Env Vars

| Env Var | Purpose | file:line | Secret? |
|---------|---------|-----------|---------|
| `QDS_PROVIDER_DRIVER` | Default driver name for fleet CLI verbs | `fleet.ts:1253`, `sandbox-teardown.ts:160` | No |
| `QDS_EXEDEV_LIVE` | Test gate for live-fire tests | `setup-gate.test.ts:538` | No |
| `QDS_EXEDEV_REPO_URL` | Live-fire test: clone source | `setup-gate.test.ts:546` | No |
| `QDS_EXEDEV_SHA` | Live-fire test: pinned commit | `setup-gate.test.ts:547` | No |
| `QDS_EXEDEV_ROSTER` | Live-fire test: roster path | `setup-gate.test.ts:548` | No |
| `FAKE_EXEDEV_CONFIG` | Fake substrate config (tests only) | `fake-exedev.ts:381` | No |

### Credential Files/Paths (NOT secrets, these are configs)

| Path | Purpose | file:line | Secret? |
|------|---------|-----------|---------|
| `.sandbox/exedev-posture.json` | VM-sharing attestation (`vmSharing: "admins-only"`) | `driver.ts:109` | No (operator record, not credential) |
| `/home/agent/app/.env` | Box-side env file (key delivery path, key value REDACTED) | `setup-gate.ts:236`, `driver.ts:47` | **YES — contains key** (driver never reads this file; only writes `QDS_TEAM_RUNNER=local` to it) |
| `/home/agent/src` | Default fill workdir (git clone target) | `fill.ts:40` | No |
| `/tmp/PROVISION_READY` | Stale sentinel path (cleared by gate) | `setup-gate.ts:115` | No |

### Interactive Registration

**No interactive registration flows exist in the exedev driver.** Grep for `interactive\|register\|login\|device\|oauth` in `src/providers/exedev/` yielded only:
- `transport.ts:57` — Comment about "non-interactive agents" and `StrictHostKeyChecking=accept-new` for SSH TOFU (Trust On First Use). The driver is explicitly non-interactive; SSH host-key acceptance is automated to avoid blocking on first contact.

**SSH Authentication:** The driver does NOT manage SSH credentials. It delegates to the local `ssh` command, which uses the user's SSH agent or `~/.ssh/config` — outside the driver's scope.

---

## 3. ExeDev Driver Methods & Test Coverage

### Driver Methods (from `ExeDevDriver` class)

| Method | Tests Invoke Real Implementation? | Test Evidence |
|--------|-----------------------------------|---------------|
| `create(name, tag?)` | **NO** — Tests use `FakeDriver` via injected substrate | `driver.test.ts:76-111` uses `new ExeDevDriver({ run: fakeRun })` |
| `list(name?)` | **NO** | `driver.test.ts:94` uses fake substrate |
| `listWithAnomalies(name?)` | **NO** | No direct test invocation; internal to `list()` |
| `destroy(vm)` | **NO** | `driver.test.ts` no coverage; `teardown.test.ts` uses `FakeDriver` |
| `expose(vm, port)` | **NO** | No direct tests |
| `setPublic(vm)` | **NO** | `driver.test.ts:137-147` uses fake substrate, posture file mocked |
| `whoami()` | **NO** | `driver.test.ts:60` checks existence only |
| `exec(vm, argv, stdin?)` | **NO** | `driver.test.ts:202-223` uses fake substrate |
| `execTimed(vm, argv, timeoutMs, stdin?)` | **NO** | Indirect coverage via `setupGate` tests with fake driver |
| `fill(vm, opts)` | **NO** | `setup-gate.test.ts:59-151` uses fake substrate |
| `setup(vm, opts)` | **NO** | `setup-gate.test.ts:214+` uses fake substrate |
| `copyFile(vm, remotePath, localPath)` | **NO** | No direct tests |
| `boxHost(vm)` | **YES** (trivial) | `driver.test.ts:60` type-check only; returns hostname string |

**Live-fire test exception:** `setup-gate.test.ts:538-565` runs a single `todoIf(!process.env.QDS_EXEDEV_LIVE)` test that constructs a `new ExeDevDriver()` (real) and calls `whoami()`, `create()`, `fill()`, `setup()`. However:
- This test is **skipped by default** (requires `QDS_EXEDEV_LIVE` env var)
- When run, it requires `OPENROUTER_PROVISIONING_KEY` (a different secret, for key API)
- This is an **integration/evidence test**, not unit coverage

**Conclusion:** Unit tests use `FakeDriver` (in-memory filesystem) exclusively. The real `ExeDevDriver` (with `sshCommand()` substrate) is only exercised in opt-in live-fire tests.

---

## 4. Driver Construction in Scripts

### Driver Resolution Pattern

**Registry:** `src/providers/index.ts:124-128`
```typescript
registerDriver("fake", () => new FakeDriver());
registerDriver("exedev", () => new ExeDevDriver());
```

**Resolution:** `resolveDriver(name)` throws on unknown names, wraps resolved driver in observability proxy.

### Fleet CLI Verbs (`scripts/fleet.ts`)

| Verb | Env Var / Flag | Resolution | file:line |
|------|----------------|-------------|-----------|
| `dispatch` | `--driver <name>` flag, else `$QDS_PROVIDER_DRIVER`, else required | `fleet.ts:1102-1131` — `resolveDriver(driverName, { requestId })` inside `asUsage()` | 1102 (flag read), 1131 (resolve) |
| `fanout` | `--driver <name>` flag, else `$QDS_PROVIDER_DRIVER`, else required | `fleet.ts:1274-1411` — `resolveDriver(driverName, { requestId: fanRequestId })` | 1274, 1411 |
| `status` | `--driver <name>` flag, else `$QDS_PROVIDER_DRIVER`, else required | `fleet.ts:1725-1726` — `resolveDriver(driverName, { requestId })` | 1725, 1726 |
| `harvest` | `--driver <name>` flag, else `$QDS_PROVIDER_DRIVER`, else required | `fleet.ts:1832-1834` — `resolveDriver(driverName, { requestId, runId })` | 1832, 1834 |
| `rank` | No driver (reads records, no substrate) | N/A | 1589 comment |
| `teardown` | `--driver <name>` flag, else `$QDS_PROVIDER_DRIVER`, else required | `sandbox-teardown.ts:160` — `resolveDriver(driverName ?? process.env.QDS_PROVIDER_DRIVER ?? "fake")` | 160 |

### Fake vs Real Selection

- **Default:** `--driver` flag MUST be provided (asserted at `fleet.ts:204-208`). No implicit default.
- **Env fallback:** If `--driver` omitted, reads `$QDS_PROVIDER_DRIVER`. If both absent, verb **refuses** with error message.
- **Test mode:** Scripts/tests inject `deps.driver` directly, bypassing `resolveDriver`.
- **Real driver:** `resolveDriver("exedev")` → `new ExeDevDriver()` → uses `sshCommand()` (real SSH substrate via `Bun.spawn`).
- **Fake driver:** `resolveDriver("fake")` → `new FakeDriver()` → in-memory filesystem (`/tmp/fake-boxes`).

### Command Seam Injection

**Real path** (`transport.ts:51-79`):
```typescript
export function sshCommand(defaultTimeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS): ExeCommand {
  return async (argv, opts) => {
    const cmd = argv[0] === "ssh" || argv[0] === "scp"
      ? [argv[0], "-o", "StrictHostKeyChecking=accept-new", ...argv.slice(1)]
      : argv;
    const proc = Bun.spawn({ cmd, env: process.env, stdin: ..., timeout: ..., killSignal: "SIGKILL" });
    // ...
  };
}
```

**Fake path** (`tests/providers/exedev/fixtures/fake-exedev.ts`):
- Implements `ExeCommand` signature
- Manipulates in-memory filesystem under `/tmp/fake-boxes/<vm>/`
- No network calls

---

## 5. Summary

**Real exe.dev driver paths:**
1. **Box lifecycle:** `create()` → `list()` → `destroy()` via SSH to `exe.dev` control plane
2. **Box access:** `exec()`, `execTimed()`, `copyFile()`, `expose()` via SSH/SCP to `<vm>.exe.xyz`
3. **Fill:** `fill()` → `git clone` over SSH to box, pinned SHA checkout, branch creation
4. **Setup gate:** `setup()` → five assertions (git integrity, pi registry, live pings, cost table, credit check) with in-box script execution
5. **Observability:** All primitives wrapped in logging proxy (`src/providers/index.ts:62-118`)

**Secrets handled:** NONE directly. Driver receives NO credentials. Key delivery is out-of-band (DF2.3). SSH auth is delegated to local `ssh` binary.

**Interactive flows:** NONE. Driver is fully non-interactive. SSH TOFU automated via `StrictHostKeyChecking=accept-new`.

**Test gap:** Unit tests exercise `FakeDriver` only. Real `ExeDevDriver` only covered by opt-in live-fire tests (`QDS_EXEDEV_LIVE`).

**Env-driven switches:**
- `--driver <name>` flag (primary)
- `$QDS_PROVIDER_DRIVER` env var (fallback)
- No `EXEDEV_*` substrate switch — driver name IS the switch

---

**Audit complete.** READ-ONLY — no files modified.
