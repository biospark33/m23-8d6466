# DF3.1 + DF3.2 Fleet E2E Coverage Audit — Real vs Fake Matrix

Date: 2026-08-24. Triage of 6 agent reports (reports/*.md). All claims spot-verified by orchestrator.

## Headline

**Zero fleet-verb or DF3.2-pattern execution has ever touched a real exe.dev box, the real OpenRouter key API, or the real cost-ledger write path.** All 508 fleet tests run on FakeDriver (box = host tmpdir), FakeKeyApi (in-memory), RecordingLedger spies (no SQLite writes). What IS real today: host subprocesses, signal delivery, host git bundle ops, SQLite *reads*.

## Per-Verb / Per-Pattern Coverage

Legend: REAL e2e % = full flow proven against real exe.dev + real APIs. Host-real % = flow's substrate surfaces exercised for real on the host. Fully-faked % = flow segments running on doubles.

| DF3.1 verb | REAL e2e | Host-real | Fully-faked | Real surfaces in tests today | Evidence |
|---|---|---|---|---|---|
| **dispatch** | 0% | ~30% (spawn/signals) | ~70% (box, key mint/deliver, fill, gate, ledger) | Bun.spawn via FakeDriver.exec; SIGINT/SIGTERM groups; ordering record→box→key→fill→gate pinned | dispatch.test.ts:1982-2364, 2637-2860; verbs.test.ts:1917-2004 |
| **status** | 0% | ~20% (SQLite reads, lock probe) | ~80% (driver.list fake, join fake records) | real readonly cost-ledger.db reads via --dir; liveness probe | cli.test.ts:2546-2746, 3746-3814; verbs.test.ts:1406-1916 |
| **harvest** | 0% | ~50% (real git bundle create/verify/rev-parse on host) | ~50% (bundle from FakeDriver box; ledger spy) | genuine git bundle protocol tests | cli.test.ts:1700-1831 |
| **teardown** | 0% | ~40% (git bundle-verify probe, lock, signals, SQLite reads) | ~60% (FakeKeyApi spend/revoke/verify, FakeDriver.destroy) | teardown ordering pinned unit; lock discipline real | teardown.test.ts (1535 L); cli.test.ts:1801-2365, 2494-2746 |

| DF3.2 pattern | REAL e2e | Host-real | Fully-faked | Real surfaces in tests today | Evidence |
|---|---|---|---|---|---|
| **fan-out N** | 0% | ~25% (Bun.spawn lock races, SIGKILL barriers) | ~75% (RaceFakeDriver boxes, ledger spies) | subprocess lock choreography | fanout.test.ts:904-941; patterns.test.ts AC1-AC4 |
| **best-of-N** | 0% | ~10% | ~90% | — | patterns.test.ts AC6, records AC9 |
| **race** | 0% | ~10% (loser teardown rides real host git probe) | ~90% (planted marker = "first") | RaceFakeDriver | patterns.test.ts AC5:703+ |
| **rank** | 0% | ~15% (real SQLite fanout-record reads) | ~85% | rank over fixture records; 1 cli test reads real ledger | rank.test.ts (pure unit); cli.test.ts:3854-3946 |

## Substrate Surface × Fleet Test Files

| Surface | cli.test | dispatch.test | verbs.test | fanout.test | patterns.test | rank.test | brief-schema.test | fleet-lock.test |
|---|---|---|---|---|---|---|---|---|
| Real exe.dev box/API | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | n/a | n/a |
| Real model/LLM API | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | n/a |
| Real network/HTTP | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | n/a |
| Real host process | ✓ | ✓(via FakeDriver.exec) | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ |
| Real signals | ✓ SIGINT/SIGTERM | ✓ SIGKILL groups | ✓ | ✓ SIGINT/SIGKILL | ✗ | ✗ | ✗ | ✓ SIGKILL |
| Real git | ✓ bundle create/verify/rev-parse | ✗ | ✗ | ✗ | △ via FakeDriver.destroy probe | ✗ | ✗ | n/a |
| Real SQLite | △ reads real, writes spy | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a |
| Real ledger (CostLedger) | ✗ writes spy | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a |

## Untested Real Paths (build list for Phase 2)

Provider/substrate layer (src/providers):
1. `ExeDevDriver` real SSH paths — `create`/`list`/`destroy`/`exec`/`copyFile`/`expose`/`setPublic`/`whoami` via `ssh exe.dev` / `ssh <vm>.exe.xyz` / `scp` (exedev/driver.ts:148-474, transport.ts:51-79). Only the opt-in `QDS_EXEDEV_LIVE` setup-gate test can touch these; no artifact proves it ever ran.
2. `provisionAdmittedRun` INV-1 ordering on a real box (driver.ts:434-659).
3. `fillExeDev` real clone + pinned SHA branch (exedev/fill.ts:95-169); `setupGate` A–E on real box (exedev/setup-gate.ts:206-533).
4. `runCredentialLifecycle` vs real OpenRouter key API — mint POST, deliver to `/home/agent/app/.env`, spend capture `getKeyEntry`, revoke DELETE, verify list (credentials.ts:341-422, 594-676). `openRouterKeyApi` HTTP layer has zero integration tests.
5. Teardown full chain on real box: spend → artifacts → harvest bundle from box → revoke → verify → destroy → close (teardown.ts:392-472).
6. `reapRuns` vs real boxes (driver.ts:1115-1196).

Fleet layer (src/fleet + scripts):
7. `dispatch` verb e2e on real box (scripts/fleet.ts:1102-1131 driver resolution → full provision).
8. `status` verb against real box listing (fleet.ts:1725).
9. `harvest` verb: bundle created IN real box, copyFile out, verify (fleet.ts:1832).
10. `teardown` verb (`sandbox-teardown.ts:160`) end-to-end real, incl. real SQLite cost-ledger **write**.
11. DF3.2 `fanout` N real boxes — admission, per-arm cap, concurrency bound, fleet-lock across real arms, loser teardown.
12. DF3.2 `race` + `best-of-N` over real boxes; `rank` over real fanout records.

## Existing Live-Substrate Precedent (reusable for Phase 2)

- **Gate pattern**: `test.todoIf(!process.env.QDS_EXEDEV_LIVE)` + refuse-half-configured env guard — setup-gate.test.ts:538-565 (real ExeDevDriver whoami→create→fill→setup, INV-5 evidence-box discipline), cap-hit-demo.test.ts:978+ (real box, real capped key, `--driver exedev` subprocess spawn).
- **Env contract for live**: `QDS_EXEDEV_LIVE=1`, `QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`, `OPENROUTER_PROVISIONING_KEY` (secret). SSH auth delegated to local ssh agent/`~/.ssh` (transport.ts:57 TOFU `accept-new`); no interactive flow in driver code.
- **Driver switch**: `--driver exedev` flag or `$QDS_PROVIDER_DRIVER` (fleet.ts:1102, sandbox-teardown.ts:160). `rank` needs no driver.
- **Spend-bounded demo pattern**: scripts/cap-hit-demo.ts (cap µ$ + verdict artifact). DF2.4 live cap-hit DID run 2026-08-19 — run `df2-4-cap-hit-20260819-fc8f12`, spend 53,447 µ$ ≥ 50,000 cap, 403 refusal host-observed (sprint-status.yaml:121; JSON fragment in workflow-state/code-review/pr-118.partA.diff:29). Standalone evidence file not retained in `_bmad-output/evidence/`.
- **Real-model e2e precedent (engine layer, not fleet)**: df1-6/e2e-live-evidence.json ×2 runs — real runIds, real OpenRouter models (claude-haiku-4.5, deepseek-v3.2), costMicros 2670, changed files. Proves model-call substrate works from boxes.

## Corrections to Mission Briefing

1. "6 fleet test files" → **8** (15,855 lines).
2. "df2-4 has the live cap-hit demo" → evidence dir absent; demo lives as gated test `tests/providers/cap-hit-demo.test.ts` + ran live 2026-08-19 per sprint-status.yaml:121 (53,447 µ$). Briefing's "53,447 µ$" figure confirmed; artifact retention is the gap.
3. "exe.dev registration is INTERACTIVE (never automated)" → **driver code is fully non-interactive** (SSH TOFU `accept-new`, no oauth/device flow in src/). Interactivity, if any, is confined to one-time operator ssh/account setup outside the repo. Phase 2 preflight: `ExeDevDriver.whoami()` probe decides.
4. "real SQLite cost-ledger.db files in several pins" → reads only; **writes never real** in fleet tests.

## Agent Reports

- reports/fleet-map-1.md — cli.test.ts, fleet-lock.test.ts
- reports/fleet-map-2.md — dispatch.test.ts, verbs.test.ts
- reports/fleet-map-3.md — fanout/patterns/rank/brief-schema
- reports/substrate-code-a.md — exedev/* + driver resolution
- reports/substrate-code-b.md — driver contract, credentials, teardown, FakeDriver diff
- reports/evidence-audit.md — evidence inventory (53,447 correction above)
