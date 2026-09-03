# Provider Layer Driver Contract Audit (substrate-code-b)

**Scope**: driver.ts, credentials.ts, teardown.ts, fake-driver.ts (exedev excluded)

## 1. Driver Contract (src/providers/driver.ts)

### ProviderDriver Interface (lines 169-195)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `name` | `readonly string` | Registry name (e.g., "fake", "exe") |
| `create` | `(name: string, tag?: string) => Promise<ProviderVm>` | Provision a new VM/box |
| `list` | `(name?: string) => Promise<ProviderVm[]>` | List VMs (filterable by name) |
| `listWithAnomalies?` | `(name?: string) => Promise<ProviderVmListing>` | List + report skipped entries (optional additive) |
| `destroy` | `(vm: string) => Promise<void>` | Idempotent VM deletion |
| `expose` | `(vm: string, port: number) => Promise<string>` | Expose port, return URL |
| `setPublic` | `(vm: string) => Promise<void>` | Make VM publicly reachable |
| `whoami` | `() => Promise<string>` | Return provider account identity |
| `exec` | `(vm: string, argv: string[], stdin?: string) => Promise<ExecResult>` | Execute command in VM |
| `copyFile` | `(vm: string, remotePath: string, localPath: string) => Promise<void>` | Copy file FROM box TO host (one-way) |

### Supporting Types

- **ProviderVm** (106-119): `name`, `httpsUrl?`, `status?`, `tag?`
- **ExecResult** (121-125): `stdout`, `stderr`, `exitCode`
- **ProviderVmListing** (139-143): `vms: ProviderVm[]`, `skipped: string[]`
- **BoxFile** (198-201): `path`, `content` (for fillRun)
- **CreateRunOptions** (203-220): `runId`, `port?`, `issue?` (budget admission)
- **AdmittedBudget** (223-230): Budget admission facts
- **ProvisionedRun** (232-236): `record`, `vm`, `httpsUrl?`

### Key Functions (driver.ts)

- `driverListing` (266-281): Wrapper for `listWithAnomalies` with refusal for unverified listings
- `provisionAdmittedRun` (434-659): Record-first provisioning sequence (INV-1 invariant)
- `createRun` (698-722): Public create with headroom gate
- `fillRun` (728-754): Place files via exec stdin (box→host only)
- `setupRun` (840-847): Run provisioning steps
- `executeRun` (850-857): Run workload
- `observeRun` (860-867): Pull artifacts (box→host)
- `startVisualizer` (976-1016): Spawn DF4.2 visualizer server in-box
- `stopVisualizer` (1031-1085): Kill visualizer process
- `teardownRun` (1093-1105): Destroy box + close record
- `reapRuns` (1115-1196): Destroy unclaimed boxes with ownership proof

---

## 2. FakeDriver vs Real Contract (src/providers/fake-driver.ts)

### FakeDriver Implements (all contract methods)

- `name` (53): `"fake"`
- `create` (119-132): Creates directory + `.box.json` metadata
- `list` (134-136): Delegates to `listWithAnomalies`
- `listWithAnomalies` (145-267): Adds anomaly channel (skipped entries)
- `destroy` (270-274): Kills exec process tree + removes directory
- `expose` (276-284): Updates metadata ports, returns fake URL
- `setPublic` (286-290): Sets `public: true` in metadata
- `whoami` (292-294): Returns `QDS_FAKE_DRIVER_USER` or `"fake-operator"`
- `exec` (296-343): Spawns child process via `Bun.spawn` with process-group tracking
- `copyFile` (346-357): Copies from box to host with realpath escape protection

### FakeDriver Shortcuts/Stub Paths

- **Box shortcut**: Boxes are host directories under `root` (default `.sandbox/fake-boxes`), not remote VMs
- **Metadata shortcut**: Uses `.box.json` files instead of provider API calls
- **URL shortcut**: Returns `https://${vm}-${port}.fake.local` instead of real public URLs
- **Process shortcut**: Uses `Bun.spawn` locally instead of SSH/remote exec
- **Cleanup shortcut**: `rmSync` instead of provider destroy API

---

## 3. Credentials (src/providers/credentials.ts)

### Environment Variables Read

| Var | Purpose | Line |
|-----|---------|------|
| `OPENROUTER_PROVISIONING_KEY` | Provider API key for mint/revoke | 594 |
| `QDS_FAKE_DRIVER_USER` | Fake whoami override | (fake-driver only) |

### File Paths (Read/Write)

| Path | Operation | Purpose | Line |
|------|-----------|---------|------|
| `/home/agent/app/.env` | Write (stdin delivery) | Key delivery target | 51 |
| `KEY_ENV_FILE` | Constant | Delivery contract | 51 |
| `tmpdir()/qds-keyapi-*/body.json` | Write+shred | Temp storage for API responses | 649-671 |

### Secret Storage Paths

- **Mint**: Plaintext key returned in Promise, stored only in memory (line 211)
- **Delivery**: Written to `/home/agent/app/.env` (mode 600) via exec stdin (341-388)
- **Record**: Only `keyHash` persisted, never plaintext (308)
- **Shred**: Temp files overwritten with `randomBytes` + unlinked (676-697)

### Interactive/Device-Code Flows

- **None**: All credential operations are server-to-server HTTP
- **No OAuth**: Uses `Authorization: Bearer $OPENROUTER_PROVISIONING_KEY` (604)
- **No device code**: Direct API calls to `/keys` endpoints

### KeyAPI Contract (102-119)

| Method | Purpose |
|--------|---------|
| `createKey(name, limitUsd)` | Mint new key with cap |
| `getKeyEntry(hash, maxPages?)` | Get from authoritative list |
| `listAllKeys(maxPages)` | Paginated list (reports `truncated`) |
| `deleteKey(hash)` | Revoke key, returns HTTP status |

### Expiry/Refresh Logic

- **No expiry**: Keys have usage caps, not time expiry
- **No refresh**: Key is minted once, used, then revoked
- **Spend capture**: Read from list before DELETE (395-422)

---

## 4. Teardown (src/providers/teardown.ts)

### Real Substrate Touch Points (per step)

| Step | Action | Substrate Contact | File:line |
|------|--------|-------------------|------------|
| `stopVisualizer` | Kill in-box process | `driver.exec(vm, ["sh", "-c", script])` | 168 |
| `spend` | Read usage | `keyApi.getKeyEntry(hash)` → HTTP GET | 392-400 |
| `artifacts` | Pull files | `pullArtifacts` → `driver.exec` + `copyFile` | 407 |
| `harvest` | Git bundle | `gitRunner([...])` + `driver.exec` | 414-418 |
| `revoke` | Delete key | `keyApi.deleteKey(hash)` → HTTP DELETE | 426-428 |
| `verify` | List check | `keyApi.listAllKeys()` → HTTP GET | 435-437 |
| `destroy` | Remove box | `driver.destroy(vmName)` | 450-452 |
| `close` | Update record | `store.close(runId)` (local file) | 472 |

### Subprocess/External Calls

- **Git bundle verify probe** (229-269): `git init`, `git commit`, `git bundle create`, `git bundle verify` in temp dir
- **Visualizer stop** (168): Shell script via `driver.exec`

### HTTP Calls Summary

- **KeyAPI operations**: All go through `KeyApi` interface (credentials.ts)
  - GET `/keys` (list)
  - GET `/keys/{hash}` (entry)
  - DELETE `/keys/{hash}` (revoke)
  - POST `/keys` (mint - not called during teardown)

### Test Coverage (tests/providers/teardown.test.ts)

**Has real-substrate tests**: Yes (uses `RecordingDriver` wrapper around real driver)
**Has fake-only tests**: Yes (uses `FakeDriver` directly)

---

## 5. Zero Real-Substrate Coverage Gaps

Cross-referencing symbol names against `tests/` directory:

### Paths WITH real-substrate tests

| Symbol | Test File | Coverage |
|---------|-----------|----------|
| `teardownSandbox` | teardown.test.ts | ✅ Full end-to-end suite |
| `stopVisualizer` | teardown.test.ts | ✅ Ordering/failure tests |
| `captureSpend` | credentials.test.ts | ✅ FakeKeyApi tests |
| `revokeRunKey` | credentials.test.ts | ✅ FakeKeyApi tests |
| `verifyRevoked` | credentials.test.ts | ✅ List-based verification |
| `revokeAndVerify` | credentials.test.ts | ✅ DF2.6 orphan sweep |
| `deliverRunKey` | credentials.test.ts | ✅ Exec stdin delivery |
| `mintRunKey` | credentials.test.ts | ✅ Mint + validation |
| `driver.destroy` | driver-contract.test.ts | ✅ Via teardown suite |

### Paths with ONLY fake-substrate tests (no real exe.dev)

| Symbol | Gap |
|--------|-----|
| `provisionAdmittedRun` | ❌ Only tested via `createRun` with FakeDriver |
| `fillRun` | ❌ Only FakeDriver exec tests |
| `setupRun` | ❌ No dedicated test file |
| `executeRun` | ❌ Implicit via other tests |
| `observeRun` | ❌ Only FakeDriver copyFile tests |
| `startVisualizer` | ⚠️ Tests use mocked exec, not real exe.dev boxes |
| `runCredentialLifecycle` | ❌ Only FakeKeyApi tests |
| `reapRuns` | ⚠️ Tests use FakeDriver only |
| `driver.list` | ⚠️ FakeDriver tests only |
| `driver.expose` | ⚠️ FakeDriver tests only |
| `driver.setPublic` | ⚠️ FakeDriver tests only |

### Paths with ZERO test coverage

| Symbol | Coverage |
|--------|----------|
| `driverListing` | ❌ Not directly tested |
| `whoami` | ❌ Not directly tested |
| `openRouterKeyApi` HTTP layer | ❌ No integration tests (uses FakeKeyApi everywhere) |

---

## Summary

**Total driver contract methods**: 9 (including optional `listWithAnomalies`)
**FakeDriver implements**: All 9 (100%)
**FakeDriver shortcuts**: Boxes=dirs, URLs=fake, exec=local

**Critical real-substrate gaps**:
1. No integration tests against actual exe.dev API
2. `fillRun`/`setupRun`/`executeRun` have no real substrate tests
3. HTTP layer (`openRouterKeyApi`) is untested against real OpenRouter
4. `startVisualizer` only tested with mocked exec responses

**Teardown real touches**: 8 steps, 2x HTTP (list), 1x HTTP (delete), 3x driver.exec, 1x driver.destroy
