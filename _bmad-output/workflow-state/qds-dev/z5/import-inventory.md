# Z5 import inventory (Track B, measured 2026-10-13, branch feature/z5-chassis-fate)

Every claim below is backed by a grep actually run against the working tree. Commands quoted with their result counts.

Baseline greps:
- `grep -rln "from ['\"].*swarmclaw/log" src scripts tests` → **88 files** (src 31, scripts 12, tests 45 — matches the known approx counts exactly)
- `grep -rln "swarmclaw/log" src scripts tests` → **92 files** (88 importers + 4 mention-only files: tests/fleet/e2e/memory-combined.live.test.ts, tests/helpers.ts, tests/judgment/fence.test.ts, tests/scripts/qds-cost.test.ts)
- `grep -rn "swarmclaw/log" src scripts tests` → **97 lines**: 88 import-from lines (one per importer) + 9 non-import lines (§4)

Sources measured: `src/swarmclaw/log.ts` (60 lines; exports `interface LogEntry`, `function setLogSink`, `let logSink` (mutable live binding), `function log`, `function newRequestId`; `logMuted` is module-private). `src/swarmclaw/mcp/tool-bridge.ts:158` `export function maskEnv(...)`.

---

## §1 DIRECT `swarmclaw/log` IMPORTERS — 88 files (src 31 / scripts 12 / tests 45)

Path depths for the rewrite: every `src/**` file imports `"../swarmclaw/log.ts"` or `"../../swarmclaw/log.ts"` → becomes `"../lib/log.ts"` / `"../../lib/log.ts"` (same depth, `swarmclaw` → `lib`). Scripts/tests use `"../src/swarmclaw/log.ts"` etc. → `"../src/lib/log.ts"`. No import inverts depth, so every rewrite is a same-arity segment swap.

### src/ — 31 files

| Dir | File:line | Imported symbols |
|---|---|---|
| src/providers | driver.ts:20 | log, newRequestId |
| src/providers | fake-driver.ts:24 | log, newRequestId |
| src/providers | harvest.ts:58 | log, newRequestId |
| src/providers | run-record.ts:39 | log, newRequestId |
| src/providers | quota.ts:24 | log, newRequestId |
| src/providers | reaper.ts:25 | log, newRequestId |
| src/providers | teardown.ts:41 | log, newRequestId |
| src/providers | cost-ledger.ts:52 | log, newRequestId |
| src/providers | cost-ledger-bridge.ts:40 | log |
| src/providers | step-log.ts:12 | log |
| src/providers | index.ts:19 | log, newRequestId |
| src/providers | credentials.ts:25 | log, newRequestId |
| src/providers | exedev/driver.ts:29 | log, newRequestId |
| src/providers | exedev/setup-gate.ts:53 | log |
| src/providers | exedev/fill.ts:24 | log |
| src/fleet | fanout.ts:23 | log |
| src/fleet | fanout-primitive.ts:41 | log |
| src/fleet | dispatch.ts:87 | log |
| src/fleet | submit.ts:33 | log |
| src/fleet | status.ts:12 | log, newRequestId |
| src/fleet | observe.ts:44 | log |
| src/fleet | approval-gate.ts:90 | log |
| src/fleet | run-completion.ts:51 | log |
| src/fleet | retain-best-effort.ts:49 | log |
| src/audit | chain.ts:66 | log, newRequestId |
| src/audit | link-store.ts:44 | log, newRequestId |
| src/judgment | client.ts:30 | log, newRequestId, type LogEntry |
| src/reverify | report.ts:22 | log, newRequestId |
| src/hindsight | nightly-consolidate.ts:50 | log, newRequestId, type LogEntry |
| src/learning | weekly-reflect.ts:40 | log, type LogEntry |
| src/memgate | schemas.ts:17 | log, type LogEntry |

### scripts/ — 12 files

| File:line | Imported symbols |
|---|---|
| cap-hit-demo.ts:55 | log, newRequestId, setLogSink |
| qds-audit.ts:74 | log, newRequestId, setLogSink |
| sandbox-reap.ts:55 | newRequestId, setLogSink |
| qds-cost.ts:61 | setLogSink |
| run-record.ts:31 | newRequestId, setLogSink |
| sandbox-teardown.ts:43 | newRequestId, setLogSink |
| qds-kpi.ts:64 | log, newRequestId, setLogSink |
| fleet.ts:142 | log, logSink, setLogSink, newRequestId, type LogEntry (only `logSink` importer anywhere) |
| fix-run.ts:126 | log, newRequestId |
| memory-weekly.ts:89 | setLogSink |
| judgment/live-probe.ts:59 | newRequestId |
| e2e/memory-negative-probes.ts:52 | type LogEntry (import type) |

### tests/ — 45 files

| Dir | File:line | Symbols |
|---|---|---|
| tests/providers (16) | cost-ledger.test.ts:53 | setLogSink |
| | df2-11-teardown-race.test.ts:37 | setLogSink, type LogEntry |
| | index.test.ts:10 | type LogEntry, setLogSink |
| | teardown.test.ts:27 | setLogSink, type LogEntry |
| | cap-hit-demo.test.ts:29 | setLogSink, type LogEntry |
| | step-log.test.ts:10 | setLogSink, type LogEntry |
| | harvest.test.ts:59 | setLogSink, type LogEntry |
| | credentials.test.ts:18 | setLogSink, type LogEntry |
| | quota.test.ts:24 | type LogEntry, setLogSink |
| | cost-ledger-bridge.test.ts:27 | setLogSink, type LogEntry |
| | fake-driver.test.ts:39 | setLogSink |
| | driver-registry.test.ts:24 | type LogEntry, setLogSink |
| | reaper.test.ts:33 | setLogSink, type LogEntry |
| | exedev/image-contract.test.ts:44 | setLogSink |
| | exedev/setup-gate.test.ts:23 | setLogSink |
| | exedev/driver.test.ts:22 | setLogSink |
| tests/fleet (15) | status.test.ts:22 | type LogEntry, setLogSink |
| | dispatch.test.ts:70 | type LogEntry, setLogSink |
| | approval-gate.test.ts:30 | setLogSink, type LogEntry |
| | verbs.test.ts:69 | setLogSink, type LogEntry |
| | dispatch-memory-seam.test.ts:50 | type LogEntry, setLogSink |
| | patterns.test.ts:43 | type LogEntry, setLogSink |
| | observe.test.ts:28 | setLogSink |
| | fanout-primitive.test.ts:40 | setLogSink, type LogEntry |
| | dispatch-swarm-wiring.test.ts:28 | setLogSink, type LogEntry |
| | cli.test.ts:65 | type LogEntry, setLogSink |
| | run.test.ts:65 | type LogEntry, setLogSink |
| | gate-verbs.test.ts:23 | setLogSink, type LogEntry (file ALSO needs the §4 line-1954 body edit) |
| | run-completion.test.ts:42 | setLogSink |
| | e2e/tier1-approval-gate.live.test.ts:42 | setLogSink |
| | e2e/tier1-ledger-readonly.live.test.ts:50 | setLogSink |
| tests/memory (2) | kg-recall-teardown.test.ts:34 | setLogSink, type LogEntry |
| | kg-recall-e2e-demo.test.ts:42 | setLogSink, type LogEntry |
| tests/memgate (2) | gateway.test.ts:39 | setLogSink, type LogEntry |
| | lifecycle.test.ts:29 | setLogSink, type LogEntry |
| tests/judgment (2) | adapter-contract.test.ts:33 | setLogSink, type LogEntry |
| | client.test.ts:22 | setLogSink, type LogEntry |
| tests/audit (2) | link-store.test.ts:63 | type LogEntry, setLogSink |
| | chain.test.ts:50 | setLogSink |
| tests/scripts (2) | qds-audit.test.ts:32 | log, setLogSink, type LogEntry |
| | memory-negative-probes.test.ts:26 | type LogEntry (import type) |
| tests/reverify (1) | report.test.ts:23 | type LogEntry, setLogSink |
| tests/learning (1) | weekly-reflect.test.ts:42 | type LogEntry (import type) |
| tests/hindsight (1) | nightly-consolidate.test.ts:56 | type LogEntry (import type) |
| tests/fixloop (1) | cli.test.ts:51 | setLogSink, type LogEntry |

### OUT OF SCOPE TREE but LIVE importers of the file being deleted (story misses these)

`grep -rn "swarmclaw/log" visualizer cli-anything` + package.json check:

| File:line | Nature | Why it matters |
|---|---|---|
| **visualizer/deploy.ts:36** | `import { log, newRequestId } from "../src/swarmclaw/log.ts";` (static import) | Breaks `bun run typecheck:visualizer` (visualizer/tsconfig.json includes server/**) and any runtime use. NOT covered by root `tsc --noEmit` (root tsconfig includes only src/scripts/tests/pi-vs-…). |
| **visualizer/test/deploy.test.ts:443** | `const { setLogSink } = await import("../../src/swarmclaw/log.ts");` (dynamic) | package.json test script is `bun test tests visualizer cli-anything …` — visualizer IS in the `bun test` scope; both dynamic imports fail at runtime after deletion. |
| **visualizer/test/deploy.test.ts:469** | same dynamic import, second test | as above |

Both files must be rewritten to `../src/lib/log.ts` / `../../src/lib/log.ts` or the story's "delete, no shim" step fails CI.

---

## §2 TRIO-VIA-STDIO-TRANSPORT CONSUMERS — 23 files

Re-export being removed (src/swarmclaw/mcp/stdio-transport.ts:18): `export { log, logSink, newRequestId, setLogSink, type LogEntry } from "../log.ts";`. Note line 17 is stdio-transport's OWN import `import { log, newRequestId } from "../log.ts";` — after the move this becomes `"../../lib/log.ts"` (file at src/swarmclaw/mcp/). Its header comment (lines 11–16) also references `../log.ts` in prose (not caught by the AC3 "swarmclaw/log" grep — stale-comment risk).

Counting grep: `grep -rln 'from ["'\''][^"'\'']*stdio-transport' src scripts tests` → **23 files**. CAUTION: the string grep `grep -rln 'swarmclaw/mcp/stdio-transport' src scripts tests` returns only **18** — it misses the 5 src/swarmclaw-internal importers whose specifiers are relative (`./mcp/stdio-transport.ts`, `../mcp/stdio-transport.ts`) and don't contain the substring "swarmclaw/". The story's known list missed these 5 entirely.

### PURE trio imports — 17 files (whole line re-points to ../../lib/log.ts or ../src/lib/log.ts; no split)

| File:line | Symbols from stdio-transport |
|---|---|
| src/hindsight/round-trip-verifier.ts:40 | log, newRequestId |
| src/hindsight/run-retain.ts:24 | log |
| src/hindsight/mulch-importer.ts:27 | log, newRequestId, type LogEntry |
| src/hindsight/client.ts:21–24 | log, newRequestId, type LogEntry (multi-line import; file also gets §3 maskEnv edit) |
| src/hindsight/kg-context.ts:33 | log |
| src/hindsight/bank-provisioner.ts:22–25 | log, newRequestId, type LogEntry (multi-line) |
| src/swarmclaw/index.ts:16 | log, newRequestId (from `./mcp/stdio-transport.ts` → becomes `../../lib/log.ts`) |
| src/swarmclaw/routes/agents.ts:5 | log, newRequestId (same) |
| scripts/provision-hindsight-banks.ts:91 | setLogSink (from `../src/…` → `../src/lib/log.ts`) |
| tests/hindsight/kg-context.test.ts:16 | setLogSink, type LogEntry |
| tests/hindsight/memory-round-trip.test.ts:13 | setLogSink, type LogEntry |
| tests/hindsight/run-retain.test.ts:24 | setLogSink, type LogEntry |
| tests/hindsight/bank-provisioning.test.ts:24 | setLogSink, type LogEntry |
| tests/hindsight/mulch-import.test.ts:17 | setLogSink, type LogEntry |
| tests/hindsight/client.test.ts:25 | setLogSink, type LogEntry |
| tests/swarmclaw/e2e-demo.test.ts:24 | type LogEntry, setLogSink |
| tests/providers/run-record.test.ts:27 | setLogSink |

### MIXED imports — MUST SPLIT (trio symbols → ../../lib/log.ts; transport machinery stays on stdio-transport.ts) — 6 files

| File:line | Trio symbols | Transport machinery in same import |
|---|---|---|
| **src/swarmclaw/routes/mcp-servers.ts:10–16** | newRequestId | buildSubprocessEnv, CommandValidationError, JsonRpcError, StdioTransport, validateCommand (file also gets §3 maskEnv edit) |
| **src/swarmclaw/store/mcp-store.ts:16** | log, newRequestId | type StdioTransport |
| **src/swarmclaw/mcp/tool-bridge.ts:11–16** | log, newRequestId | JsonRpcError, type StdioTransport (extraction source; edited anyway by the maskEnv move) |
| **tests/hindsight/bridge-round-trip.test.ts:21** | type LogEntry, setLogSink | StdioTransport |
| **tests/swarmclaw/mcp-stdio-transport.test.ts:3–13** | setLogSink | buildSubprocessEnv, CommandValidationError, JsonRpcError, resolveCommandAllowlist, resolveEnvAllowlist, resolveNpxPackageAllowlist, StdioTransport, validateCommand (file separately imports ToolBridge/resolveInvokeTimeout/resolveToolCacheTtl from tool-bridge — line 14, unaffected) |
| **tests/swarmclaw/agent-mcp-registration.test.ts:5** | type LogEntry, setLogSink | StdioTransport |

Corrections to the story's known list: src/hindsight is 6 modules (confirmed); scripts 1 (confirmed); test files are 11 not "~11" — tests/hindsight ×7 (kg-context, memory-round-trip, run-retain, bridge-round-trip, bank-provisioning, mulch-import, client — one more than the "×5(+kg-context,run-retain)" reading), tests/swarmclaw ×3 (confirmed), tests/providers/run-record (confirmed). ADDITIONALLY 5 src/swarmclaw-internal importers the story missed: index.ts, routes/agents.ts, routes/mcp-servers.ts, store/mcp-store.ts, mcp/tool-bridge.ts. Nobody imports `logSink` from stdio-transport (the only logSink importer is scripts/fleet.ts:142, direct).

---

## §3 MASKENV IMPORTERS — 2 files (0 tests, 0 scripts)

`grep -rn "maskEnv" src scripts tests` → 12 lines, all in 3 src files. Importers of `maskEnv` from tool-bridge:

| File:line | Import line |
|---|---|
| src/hindsight/client.ts:26 | `import { maskEnv } from "../swarmclaw/mcp/tool-bridge.ts";` → becomes `"../lib/mask-env.ts"` |
| src/swarmclaw/routes/mcp-servers.ts:19 | inside the big multi-line tool-bridge import (lines 17–28: assertInvokeResultWithinCap, **maskEnv**, MCPInvokeErrorResponseSchema, MCPInvokeSchema, MCPResultTooLargeError, MCPTestResponseSchema, resolveInvokeTimeout, ToolBridge, toSnakeArgs, validateArgsAgainstInputSchema) — SPLIT: maskEnv out to `"../../lib/mask-env.ts"`, the rest stays |

Non-import references (same grep): definition at src/swarmclaw/mcp/tool-bridge.ts:158 (moves verbatim); usages src/hindsight/client.ts:747 and src/swarmclaw/routes/mcp-servers.ts:140 (no change); docblock prose src/hindsight/client.ts:10, 17 (line 17 says "`maskEnv` from tool-bridge.ts" — becomes stale, consider updating to mask-env.ts alongside the import rewrite). **No test file imports or references maskEnv anywhere** (grep over tests/ → 0 lines) — confirmed, contrary to the task's "also list any TEST files" hint: there are none.

---

## §4 NON-IMPORT MENTIONS of the string "swarmclaw/log" — 9 lines in 6 in-scope files

`grep -rn "swarmclaw/log" src scripts tests | grep -v 'from ["'\'']'` → **9 lines**. `grep -rn "swarmclaw/log" src/gate` → **0** (src/gate = assertions/, gate-runner.ts, verifier-child.ts — clean). All 9 must be scrubbed for AC3:

| File:line | Content | Nature | Otherwise touched by the move? |
|---|---|---|---|
| src/judgment/client.ts:9 | `* src/lib/http.ts + src/swarmclaw/log.ts repo-internally — the two-import` | docblock | YES — its import line 30 is rewritten (§1) |
| tests/helpers.ts:11 | `* `swarmclaw/log.ts` → `step-log.ts` into module load…` | docblock | NO — otherwise untouched; comment-only edit |
| tests/judgment/fence.test.ts:4 | `* `src/judgment/` imports ONLY `src/lib/http.ts` + `src/swarmclaw/log.ts`` | docblock | NO — otherwise untouched |
| tests/judgment/fence.test.ts:18 | `const ALLOWED_REPO_IMPORTS = new Set(["../lib/http.ts", "../swarmclaw/log.ts"]);` | **string literal in body (const)** — must become `"../lib/log.ts"` or the fence fails the moment src/judgment/client.ts is re-pointed | NO import of its own |
| tests/judgment/fence.test.ts:40 | `test("every module imports only http.ts, swarmclaw/log.ts, zod, or its own siblings", …` | test-name string | NO |
| tests/judgment/fence.test.ts:130 | `test("every module at every depth imports only http.ts, swarmclaw/log.ts, zod, node:, or src/judgment/ itself", …` | test-name string | NO |
| tests/scripts/qds-cost.test.ts:738 | `// `QDS_LOG_VERBOSE=1` because src/swarmclaw/log.ts mutes the JSONL sink` | comment | NO — otherwise untouched |
| tests/fleet/gate-verbs.test.ts:1954 | `const LOG_TS = JSON.stringify(path.join(import.meta.dir, "../../src/swarmclaw/log.ts"));` | **body constant (LOG_TS path)** — this is a live path used to munge stack traces; after the move it must point at src/lib/log.ts or the test's log-source matching breaks | YES — its import line 23 is also rewritten (§1) |
| tests/fleet/e2e/memory-combined.live.test.ts:855 | `// streams under NODE_ENV=test (swarmclaw/log.ts:30) — which bun test` | comment | NO — otherwise untouched |

Out-of-scope-tree mentions (AC3 doesn't cover these; flag for story hygiene): visualizer/server/index.ts:399 (docblock "predicate as src/swarmclaw/log.ts's"), cli-anything/src/env.ts:15 (docblock "Mirrors src/swarmclaw/log.ts's logMuted()"), visualizer/test/deploy.test.ts:443+469 (dynamic imports — LIVE code, see §1), oci/exedev/Dockerfile:315 (comment, see §6), README.md:95, TECH_DEBT_AUDIT.md:299, docs/superpowers/plans/2026-09-23-rig-swarm-phase-s1.md:463, docs/superpowers/plans/2026-08-28-tech-debt-remediation.md:1751 (docs — historical, safe to leave).

---

## §5 SRC/LIB HOME CONVENTIONS

src/lib contains exactly two files: `http.ts` (5590 B), `file-lock.ts` (8873 B). **No index.ts barrel** (`ls src/lib/index.ts` → not found).

| Property | src/lib/http.ts | src/lib/file-lock.ts |
|---|---|---|
| Header | Multi-paragraph `/** … */` docblock opening "One `fetch` contract for the whole repo (F063)." — states WHY the module exists (N modules had drifted) | Same style: "One O_EXCL advisory file lock (F062)." |
| Imports | **ZERO** — fully dependency-free, not even node: builtins | Only node: builtins (node:crypto randomUUID; node:fs readFileSync/renameSync/rmSync/statSync/writeFileSync) |
| Exports | Named only: `interface HttpPolicy`, `interface HttpResult`, `const MAX_RETRY_AFTER_MS`, `function retryAfterMs`, `async function httpRequest` | Named only: `interface StaleCheck`, `interface FileLockOptions`, `function isPidDead`, `function lockHolderPid`, `async function acquireFileLock` |
| No default exports, no barrels, per-decision JSDoc on each exported member | | |

Test-import convention: direct relative path, no barrel — `grep -rn 'lib/http' tests | head -5` → tests/judgment/client.test.ts:12 `import { MAX_RETRY_AFTER_MS } from "../../src/lib/http.ts";` (plus fence.test.ts prose refs). file-lock has a dedicated tests/lib/file-lock.test.ts; src importers use `"../lib/file-lock.ts"`. **Fits the story claims: http.ts is dependency-free, file-lock.ts is node-builtin-tier.** src/lib/log.ts (zero imports) and src/lib/mask-env.ts (zero imports — maskEnv body uses only Object.keys) both land at or below the existing dependency tier.

---

## §6 AC5 DOCKERFILE CHECK

oci/exedev/Dockerfile engine stage (lines 277–355):

```
279:COPY src/fleet/ src/fleet/
280:COPY src/lib/ src/lib/          ← directory-level, already staged
281:COPY src/phase-engine/ src/phase-engine/
…
352:COPY src/swarmclaw/ src/swarmclaw/   ← directory-level, already staged
```

Both `src/lib` and `src/swarmclaw` are **directory-level COPY entries** (`COPY src/lib/ src/lib/` style) — NOT file enumerations. Moving log.ts swarmclaw→lib requires **zero Dockerfile COPY changes**: both endpoints of the move are inside already-staged directories (the file shrinks src/swarmclaw/ by one file and grows src/lib/ by one, and directory COPYs absorb that). Line 315 is a comment ("src/swarmclaw/ — the structured log sink; imported as ../swarmclaw/log.ts from nine files under src/fleet/") that becomes factually stale (fleet now imports ../../lib/log.ts) but has no build effect — optional comment refresh.

- `grep -c "swarmclaw" scripts/build-exedev-image.ts` → **0** (no "swarmclaw/log", no "tool-bridge", no path strings). Clean.
- `grep -n "swarmclaw/log\|tool-bridge" src/providers/exedev/driver.ts` → only hit is driver.ts:29, the log import already counted in §1 (which becomes `"../../lib/log.ts"`). **No tool-bridge references.** Clean.

---

## §7 DELTA TABLE — measured vs story snapshot

Snapshot claimed: 27 src modules (providers 15, fleet 8, audit 2, judgment/client 1, reverify 1), 8 scripts, 39+6 test files, hindsight 4 modules via re-export.

| # | Snapshot | Measured | Evidence |
|---|---|---|---|
| 1 | src 27 modules | **31** | §1 src table: providers 15 ✓, fleet **9** ✗, audit 2 ✓, judgment 1 ✓, reverify 1 ✓, + **hindsight/nightly-consolidate, learning/weekly-reflect, memgate/schemas** (3 modules absent from snapshot) |
| 2 | fleet 8 | **9** (submit.ts:33 missed by snapshot; also run-completion, retain-best-effort are recent-looking) | §1 src/fleet rows |
| 3 | scripts 8 | **12** | §1 scripts table (qds-kpi, fix-run, memory-weekly, judgment/live-probe, e2e/memory-negative-probes, cap-hit-demo — several beyond 8) |
| 4 | tests 39+6 | **45 direct** (39+6=45 arithmetic holds) | §1 tests table |
| 5 | hindsight 4 modules via re-export | **6 via re-export** (round-trip-verifier, run-retain, mulch-importer, client, kg-context, bank-provisioner) **+1 direct** (nightly-consolidate.ts:50) = 7 hindsight modules total | §2 pure-trio table + §1 |
| 6 | (absent) | **5 src/swarmclaw-internal stdio-transport importers** the snapshot missed: index.ts:16, routes/agents.ts:5, routes/mcp-servers.ts:10–16, store/mcp-store.ts:16, mcp/tool-bridge.ts:11–16. mcp-servers/mcp-store/tool-bridge are MIXED (split); index/agents are pure trio | §2; the substring grep undercounts because their specifiers are relative |
| 7 | (absent) | **visualizer/deploy.ts:36 static import + visualizer/test/deploy.test.ts:443,469 dynamic imports** — live breakage: `bun test` scope includes visualizer (package.json: `"test": "bun test tests visualizer cli-anything …"`), typecheck:visualizer covers deploy.ts. Root tsc does NOT cover it (tsconfig include = src/scripts/tests/pi-vs only) — would slip past the static gates | §1 out-of-scope table |
| 8 | (absent) | stdio-transport.ts line **17** (its own `import { log, newRequestId } from "../log.ts"`) must re-point to `"../../lib/log.ts"` when line 18 is deleted, else the transport itself stops compiling | §2 preamble |
| 9 | (absent) | scripts/fleet.ts:142 is the only `logSink` importer repo-wide (mutable `export let` binding moves verbatim) | §1 scripts table |
| 10 | (absent) | maskEnv has ZERO test importers; only 2 src importers (hindsight/client.ts:26, routes/mcp-servers.ts:19) | §3 |

Grand totals for the rewrite: 88 in-scope direct importers + 23 stdio-transport re-export consumers (6 needing splits) + 2 maskEnv importers (1 needing a split) + 9 non-import mention lines + 2 stdio-transport self-lines (17, 18) + 3 visualizer import sites ≈ **127 edit sites across ~115 distinct files** (overlap: hindsight/client.ts, routes/mcp-servers.ts, tool-bridge.ts, gate-verbs.test.ts each counted in two categories).

INVENTORY TOTALS: direct-log-importers=88 (src 31 / scripts 12 / tests 45, +1 visualizer static +2 visualizer dynamic out of scope), trio-via-transport=23 (17 pure, 6 split; snapshot knew 18), maskenv-importers=2 (0 tests), non-import-mentions=9 (in-scope lines; +8 out-of-scope incl. Dockerfile comment)
