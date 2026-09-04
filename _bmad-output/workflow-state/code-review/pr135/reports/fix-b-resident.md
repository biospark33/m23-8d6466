# Cluster B fix report — src/fleet/resident.ts (+ test + fixture) — 2026-08-27

Files touched: `src/fleet/resident.ts`, `tests/fleet/resident.test.ts`, `tests/fleet/fixtures/fake-pi-resident.ts`. Nothing else. No commit, no push.

## Verdict table

| Item | Verdict | Notes |
|---|---|---|
| B1 | fixed | `redact(stderr).slice(-400)` — redact full, then cut. Comment names the command-gate rule. |
| B2 | fixed | `RESIDENT_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` checked at top of `startResident`, before mkdir/resolveRate; clear error names the grammar and why (runId becomes file names). Local to resident.ts: the store's `assertValidRunId` grammar (RFC 1123 label) is narrower than the artifact grammar. |
| B3 | fixed | `bindRedact` binds the explicit `SECRET_ENV_KEYS` set (GITHUB_TOKEN, GH_TOKEN, GIT_TOKEN, AWS_*, PI_API_KEY, plus the original two) AND every `SECRET_KEY_RE`-shaped key from the child env. Existing `redactSecrets`/`SECRET_KEY_RE` reused — no new redactor. |
| B4 | fixed | `solicitTimeoutMs(childEnv)` reads `(opts.env ?? process.env)`; upper bound clamped to `MAX_RESIDENT_TIMEOUT_MS = 600_000`. |
| B5 | fixed | `Math.max(1, …)` removed; timeout computed once at start (`timeoutMs`). |
| B6 | fixed **[BEHAVIOR CHANGE]** | Bun.spawn sync throw (ENOENT) now sets `lastExit = "logic"`. Test at tests/fleet/resident.test.ts ("missing binary (ENOENT)") updated to assert "logic". |
| B7 | fixed **[BEHAVIOR CHANGE]** | `exitStatus()` returns `lastExit` (null before any call). `ResidentSpawn.exitStatus(): Promise<ExitStatus \| null>`. `scripts/pipeline-run.ts:1411` assigns into the null-tolerant resident block (`exitStatus: ExitStatus \| null`, steering.ts:96); e2e accepts `null \|\| string` (resident-e2e.test.ts:365). tsc clean. |
| B8 | fixed **[BEHAVIOR CHANGE]** | Reply persist wrapped in try/catch → `console.error` note (dispatch-task `[tag]` convention) + reply/usage still returned (metering survives). Prompt persist unchanged (fail-closed, pre-execution). New test "B8: reply persist failure is best-effort" drives EISDIR on the reply artifact only and asserts `{raw, usage}` + `"success"`. |
| B9 | fixed | `stopped` flag set in `stop()`, checked first in `call()` ("resident stopped: …"). Test "stop() BEFORE any call" asserts rejection + zero spawns. |
| B10 | fixed | After prefix handling, `modelArg` must contain "/" with no empty segment; clear error. Test covers `openrouter/`, `openrouter//x`, `/`. |
| B11 | fixed | `afterEach` uses `delete process.env.*` with the repo-standard `// biome-ignore lint/performance/noDelete: unsetting env vars requires delete` (same string as tests/swarmclaw/*, tests/hindsight/*). |
| B12 | fixed | stop() test sets `QDS_RESIDENT_TIMEOUT_MS = "30000"` and asserts `performance.now() - startedAt < 10_000`, so a no-op stop() (call surviving to the 30 s timeout) fails the test. |
| B13 | fixed | "whitespace-only string brief disables; a non-empty string spawns" — covers both string branches of `briefIsEmpty`. |
| B14 | fixed | Fixture appends one `called\n` line to the `--session <path>` file per invocation (~6 lines). Test asserts 2 calls → 2 lines in run-cont's file, and a second runId neither grows run-cont's file nor shares it. |
| B15 | fixed | Fixture `toCount()` throws `fake-pi: QDS_FAKE_PI_INPUT="garbage" is not a non-negative integer` at startup instead of silently NaN-ing. |
| B16 | fixed | `piEnv()` scrubs `^QDS_FAKE_PI_` / `^FAKE_RESIDENT_` keys from the inherited env before the `over` spread. |
| B17 | fixed | `expect(DEFAULT_RESIDENT_SLUG).toBe("deepseek/deepseek-v4-flash-0731")` replaces the self-referential TEST_SOURCES keys assertion. |

17/17 fixed, 0 false positives, 0 unresolved.

## Behavior-change flags (wave 2 + lead)

1. **B6 — ENOENT now exitStatus `"logic"`** (was `"transient"`). Any consumer branching on transient-vs-logic sees the new value for a missing pi binary. resident.test.ts expectation updated; e2e (resident-e2e.test.ts:365) is type-tolerant.
2. **B7 — `exitStatus()` is `null` for a never-solicited resident** (was `"transient"`). `ResidentSpawn` interface widened to `Promise<ExitStatus | null>`; pipeline-run's resident block was already `ExitStatus | null` and null-tolerant.
3. **B8 — reply-persist failure no longer degrades the call.** The caller gets `{raw, usage}` and a stderr note is printed; the reply artifact may be absent from persistDir on a write fault. Prompt persistence is still fail-closed (a test asserting prompt-fail → throw still passes).

## Impact analysis (GitNexus)

`impact({target: "startResident"})` / `impact({target: "bindRedact"})` on repo QDS-Factory → **target not found**: the GitNexus index predates the PR-135 working tree (startResident/bindRedact are new on this branch, uncommitted). Blast radius verified by direct grep instead:

- `startResident`/`ResidentSpawn` consumed only by `scripts/pipeline-run.ts` (import :86, arming :1259-1270, `exitStatus()` await :1411 — assigned into the null-tolerant block). `bunx tsc --noEmit` passes, covering that call site.
- `bindRedact` is module-private to resident.ts (grep: no external references).
- `exitStatus` type consumer: `ResidentTelemetry.exitStatus` (steering.ts:96) already `ExitStatus | null` — no downstream type change.

## Verification

```
bun test tests/fleet/resident.test.ts
  26 pass, 0 fail, 90 expect() calls   (was 16 tests / 4 describes before)

bunx biome check src/fleet/resident.ts tests/fleet/resident.test.ts tests/fleet/fixtures/fake-pi-resident.ts
  Checked 3 files in 7ms. No fixes applied.   (exit 0)

bunx tsc --noEmit
  (no output)   (exit 0)
```

`bun test tests/fleet/` full dir: 607 pass / 0 fail (one earlier run showed a single flaky fail on the 60 s fallback-hang leg under parallel agent load — that leg's test budget was widened 70 s → 150 s; re-run clean, two consecutive green).

## Notes for wave 2 / lead (outside my files)

- `bun test tests/phase-engine/resident-e2e.test.ts` currently fails 1/6: the demo leg expects `"type": "resident_directive"` in gateEvents (resident-e2e.test.ts:269-272), but cluster C's C2 moved that event to a `tracer.trace({type:"log"})` row. That expectation update belongs to cluster D (wave 2); my three files neither cause nor touch it — verified by the failure surviving with and without my changes stashed.
- A transient `residentModel` tsc error in scripts/pipeline-run.ts appeared mid-run and was resolved concurrently by fix-C (C7); final tsc is clean.
