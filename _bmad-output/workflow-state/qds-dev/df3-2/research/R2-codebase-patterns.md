# R2 — Codebase Patterns (Track B) for DF3.2 fanout/rank

Researched 2026-08-23 against main @ f1aa4db. Everything below is read off the
working tree, with file:line anchors. Story: `df3-2-fanout-best-of-n.md`
(`_bmad-output/sprint-artifacts/dark-factory-v5/stories/`).

---

## 1. Composition map — every symbol DF3.2 imports

### 1.1 From `src/fleet/dispatch.ts` (2,517 lines)

| Symbol | Line | Signature / shape |
|---|---|---|
| `dispatch` | 633 | `async function dispatch(brief: unknown, deps: DispatchDeps, opts: { admitted?: boolean; runId?: MintedRunId } = {}): Promise<DispatchResult>` |
| `mintRunId` | 319 | `function mintRunId(): MintedRunId` — wraps `newId("qds")` from run-record.ts. **Exported.** Fan-out mints all N ids through this before the parallel section. |
| `MintedRunId` | 117 | `string & { readonly [mintedRunIdBrand]: true }` — nominal brand, compile-time only. Runtime backstop: `MINTED_RUN_ID_RE = /^qds-\d{8}-[a-f0-9]{6}$/` (:74) re-checks any `opts.runId`. Fan-out ids minted via `mintRunId()` are branded natively — no cast needed. |
| `FleetError` | 131 | `constructor(exitCode: 1\|2\|3\|4\|5, code: string, message: string, remediation: string, payload?: Record<string, unknown>)` — the ONLY refusal type; `src/` throws, the CLI renders. |
| `DispatchDeps` | 261 | see §1.2 |
| `DispatchResult` | 310 | `{ runId: string; requestId: string; state: "ready"; vmName: string; httpsUrl?: string }` — the ack object, one JSON line on stdout. |
| `LedgerLike` | 259 | `Pick<CostLedger, "config" \| "admitIssue" \| "close">` — structural slice for DI fakes. |
| `GateOpts` | 304 | `{ runId: string; commitSha: string; requestId: string }` |
| `assertFleetRunId` | 155 | `(runId: unknown) => asserts runId is string` — delegates to the store's grammar; exit-2 `invalid-run-id`. |
| `resolveBriefRequestId` | 335 | `(parsedBrief: unknown): string \| undefined` — strict-UUID-v4-or-drop rule. |
| `fakeGate` (re-export) | 62 | re-exported from `src/providers/fake-gate.ts` so callers import it from the fleet module. |

**The fan-out seam is already named in dispatch.ts.** Two places:

- `:1530` — "AC8: skipped only under `{ admitted: true }` (DF3.2's single
  `checkHeadroom(N)`)." So the make-or-break is: fan-out calls
  `checkHeadroom(driver, N, limits)` **once**, then passes
  `dispatch(brief, deps, { admitted: true, runId })` per arm. The budget gate
  (`assertWithinBudget`) still runs per arm — by design.
- `:1438-1470` — "the shape check is for the ids that are built at runtime and
  cast in (the CLI, **DF3.2's fan-out**)". Explicit `opts.runId` per arm is the
  supported path; a re-dispatch under a taken id refuses exit-2
  `run-id-in-use` (:1505-1512, and the concurrent EEXIST arm :1844-1896).
- `:1719-1721` — the ledger orphan window is deliberately NOT closed with a
  global lock because it "would serialise DF3.2's N-arm fan-out". Do not add a
  ledger-side lock; the story's `.sandbox/fleet.lock` is the only serialization
  point (§4).

`within()` (:996) is a **closure inside `dispatch`, not exported**. DF3.2's
poller needs its own per-call deadline; reuse `withTimeout` from
`src/providers/timeout.ts:52` — `async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T>` (throws `TimeoutError {what, ms}`; attaches a no-op catch to the loser so no unhandled rejection). `LIST_TIMEOUT_MS = 15_000` is the sibling constant. This is the exact mechanism the story's 10_000 ms per-call deadline wants.

### 1.2 `DispatchDeps` (dispatch.ts:261-302) — the injection surface

```ts
export interface DispatchDeps {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  repoRoot?: string;                       // INV-1 manifest containment root; default process.cwd(); TRUSTED CONFIGURATION — never brief-derived
  ledgerFactory: () => LedgerLike;         // the ONLY way the budget gate touches storage
  quotaLimits?: LoadedQuotaLimits;
  port?: number;
  requestId?: string;                      // pre-resolved correlation id (INV-4-bis)
  clock?: () => number;                    // wall clock seam (test)
  timeoutMs?: number;                      // default 600_000, max 2_147_483_647 (:91)
  dispatchLogPath?: string;                // defaults beside store.dir
  setupGate?: (driver, vm, opts: GateOpts) => Promise<SetupGateResult>;  // test seam
}
```

Fan-out composes one `DispatchDeps` per arm (fresh `runId`, shared
`driver`/`keyApi`/`ledgerFactory` are fine — each `dispatch()` call opens and
closes its own ledger via `ledgerFactory()`).

### 1.3 Error taxonomy (F3 table, scripts/fleet.ts:9-13 header)

Exit codes: **0** success · **1** run/provider failure (retryable, `transient`)
· **2** usage/schema (`logic`) · **3** setup-gate failure · **4** run-not-found
· **5** refused before provisioning · **6** landed but unreportable/wedged
cleanup (NOT retryable). 128+SIGINT/SIGTERM sit outside the table on purpose.

Fleet codes observed in dispatch.ts (kebab-case, one code one meaning):
`timeout-invalid`, `port-invalid`, `invalid-brief`, `invalid-request-id`,
`correlation-rejected`, `correlation-failed`, `manifest-rejected`,
`roster-missing`, `roster-path-unsafe`, `roster-rejected`,
`run-id-not-minted`, `invalid-run-id`, `record-read-failed`, `run-id-in-use`,
`run-id-unmintable`, `headroom-failed`, `no-headroom`, `budget-exceeded`,
`ledger-failed`, `admission-failed`, `no-ceiling`, `provision-failed`,
`key-delivery-failed`, `setup-gate-invalid`, `setup-gate-failed`,
`dispatch-timeout`, `expose-no-url`, `dispatch-failed`.

Rule for DF3.2: a provider's own `.code` goes in the **payload**
(`providerCodePayload`, dispatch.ts:610), never into `FleetError.code`.
`fleet-busy` (AC8) follows the same shape: `new FleetError(5, "fleet-busy", msg, remediation)`.

### 1.4 Timing / observability

- `timings: Record<string, number>` + `phase(name, ms)` closure (:659-662);
  keys `validate_ms`, `create_ms`, `mint_ms`, `fill_ms`, `setup_gate_ms`.
  Emitted nested on every structured line (`timings: { ...timings }` — nested,
  deliberately NOT spread, :806-808).
- Structured lines via `log()` from `src/swarmclaw/log.ts`:
  `{ requestId, operation: "fleet.dispatch", agentId: null, timestamp: ISO, duration, durationMs, status, error?, runId, verb, phase, exitStatus }`.
  Phases: `resolved` / `ready` / `refused` / `abandoned` / `admitted` /
  `minted` / `request-id-overridden`. CLI's own line: `operation: fleet.<verb>`,
  `phase: "complete"` (fleet.ts:659-679 `logVerb`).
- requestId propagation: CLI does `resolveBriefRequestId(briefJson) ??
  newRequestId()` (fleet.ts:1024), builds store+driver with it, passes
  `deps.requestId`; dispatch re-validates and stamps it on the record.

---

## 2. `src/fleet/verbs.ts` — registry shape (153 lines)

```ts
export interface VerbFlag { name: string; required: boolean; valueType: "string" | "path" | "boolean"; }
export interface VerbEntry { verb: string; summary: string; flags: VerbFlag[]; exitCodes: number[]; }
export function listVerbs(): VerbEntry[]   // currently "Exactly 4 entries" per its own docstring
export function renderHelp(registry: VerbEntry[]): string  // the ONLY --help source
```

Full template entry, verbatim (verbs.ts:44-73):

```ts
    {
      verb: "dispatch",
      summary: "Mint a run handle and provision a sandbox",
      flags: [
        { name: "--driver", required: true, valueType: "string" },
        { name: "--brief", required: false, valueType: "path" },
        { name: "--dir", required: false, valueType: "path" },
        // The only route to DispatchDeps.port, hence the only way the ack can
        // carry an httpsUrl. "string": the CLI range-checks it as 1-65535.
        { name: "--port", required: false, valueType: "string" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // 6 = the box is LIVE and the ack could not be written to stdout
      // (`fleet dispatch … | head -0` closes the pipe before the line lands).
      ...
      exitCodes: [0, 1, 2, 3, 5, 6],
    },
```

**Where fanout/rank slot in:** appended to the array literal in `listVerbs()`
(verbs.ts:43-115). Everything downstream is registry-driven — no second edit
needed:

- `scripts/fleet.ts:123-137` derives the tokenizer's VALUE_FLAGS/BOOL_FLAGS
  from `listVerbs().flatMap(v => v.flags)`.
- `parseArgv` (fleet.ts:497-509) resolves the verb entry and refuses any flag
  not in `entry.flags` (exit 2, "does not take <flag>").
- `renderHelp` renders new entries automatically.
- `--driver` must be `required: true` on both new verbs (the registry docstring
  at verbs.ts:17-24 states why: no verb defaults to a driver).
- Numeric flags are `valueType: "string"` with CLI range checks, exactly like
  `--port` (fleet.ts:954-967: `/^[1-9]\d{0,4}$/` then integer range).
- **verbs.test.ts enforces bidirectional exit-code coverage** (header lines
  8-11; implementation ~:878-903): every code a new verb returns must be in its
  `exitCodes` and vice versa (bar a documented allowlist). Declaring
  `exitCodes: [0, 1, 2, 4, 5, 6]` for `fanout` and `[0, 1, 2, 4]`-class for
  `rank` requires matching test probes.
- Update the "Exactly 4 entries" docstring when adding entries (it is a
  contract claim tests pin).

---

## 3. `scripts/fleet.ts` (1,612 lines) — CLI patterns to copy

- **Entry:** `export async function run(argv: readonly string[], out: (s) => void, deps?: Partial<FleetDeps>, err: (s) => void = out): Promise<number>` (:712). `import.meta.main` block (:1590) wires `writeAll(1, …)` / stderr and `process.exit`. Tests call `run()` directly with captured sinks.
- **`FleetDeps`** (:154-161): `extends Omit<DispatchDeps, "driver"|"keyApi"|"store"|"ledgerFactory"|"requestId"|"port">` then re-declares those as required + adds `readBrief: () => Promise<string>`. **This is the repo DI idiom** — inherit optional seams so a seam added to DispatchDeps is reachable without a second edit; add new seams (lock dir, poll interval) the same way.
- **Arg parsing:** `tokenizeArgs(argv, { valueFlags, boolFlags, rejectStraySingleDash: true })` then `parseValueFlags(flagTokens, { flags, onValue, help })` from `scripts/lib/cli-args.ts` (exports at :37/:50/:90/:116/:140/:196). Duplicate flags refuse (`--dir given more than once`, :473); bool `=`-form refuses; `-h` normalizes to `--help` (:137, :452). Help short-circuits to `{ help: true, verb? }` (:490).
- **Verb dispatch:** sequential `if (verb === "…")` blocks inside `run()` (:883 dispatch, :1162 status, :1236+ harvest/teardown). Each block: positional/arity checks → `assertDriverChosen` (:175) → build deps under `asUsage(() => …)` (:320, maps bare provider-constructor throws to exit-2 usage, retryable-errno passthrough via `RETRYABLE_ERRNOS` :343) → try/catch → `return finish(requestId, verb, runId, code)`.
- **Brief input:** `readBrief` seam (:973-986). Default: `--brief <path>` → `readBriefFile` (:533; regular-file + 64 KiB cap proven on the open descriptor) else `readCappedStdin` (:514; streams and refuses AS IT READS past `MAX_BRIEF_BYTES = 64*1024`, :114). `assertOneBriefSource` (:634) refuses `--brief` + redirected stdin. TTY stdin refused (:982). Then `JSON.parse` → exit-2 `invalid-brief` envelope (:1010-1019).
- **Output formatting:** stdout carries OUTPUT ONLY, one JSON line per item — status prints `emit(\`${JSON.stringify(row)}\\n\`)` per row (:1187); dispatch ack is one raw JSON line (:1123, deliberately not through `emit` — EPIPE on the ack is exit 6 `ack-unwritable`). **Fan-out's "one ack line per arm" fits the status-row idiom exactly**: one `JSON.stringify` line per arm outcome on stdout, diagnostics as JSON envelopes on stderr.
- **Exit codes:** the verb returns the number; `report()` (:346) maps `FleetError.exitCode` (clamped 1..6, off-table → 2) and any untyped throw → 1 with redacted stack/cause. `finish` (:794) folds `outputIncomplete` into 6 and calls `logVerb`.
- **Lock precedent for AC8:** `scripts/lib/run-lock.ts` — `acquireRunLock(runsDir, runId, holder): string` (:671, O_EXCL body file `<pid> <host> <ISO> <nonce>`), `releaseRunLock(lock, {force?})` (:807), `RunLockedError` (:53, carries code/message/remediation → CLI maps to exit 5 at :1332), `markRunLockDestructive`/`clearRunLockDestructive` (:258/:272), `releaseHeldRunLocks` (:305). Staleness is pid-liveness based; the story's 3_600_000 ms stale-after for `.sandbox/fleet.lock` is a simpler time-based variant of the same mechanics — reuse this module's body-file + refuse pattern keyed on a fleet-level name.

---

## 4. Brief schema + manifest handling

`src/fleet/brief-schema.ts` (462 lines) — `BriefSchema = z.strictObject({...})`
(:280-418) with fields, and ONLY these:

`repoSlug` (REPO_SLUG_PATTERN + no-dot-segment) · `issueId` (int >0 ≤
MAX_ISSUE_ID) · `issueUrl?` (https-only, no userinfo, capped MAX_URL=2048) ·
`commitSha` (`/^[0-9a-f]{40}$/`) · `requestId?` (loose, capped 128, no control
chars) · `manifestPath` (relative, capped 1024, no `..`) · `repoUrl`
(https-only, must name the same repo as repoSlug via the cross-refine :415).

**Clarifications the task asked for:**

- **pin** — there is no `pin` brief field. The pin IS `commitSha` (40-hex,
  already schema-enforced). The story's "per-arm pins" (many-stories) means
  per-arm briefs each carrying their own `commitSha`; best-of-N/race pin every
  arm to one SHA and the CLI rejects differing pins (story :217-222).
- **rosterId** — not a brief field. It is an optional per-arm field of the
  fan-out record: `arms: [{ arm, runId, rosterId?, briefHash }]` (story AC7,
  :162). Rosters themselves are read from `roster.yaml` beside the manifest via
  `parseRoster(yaml, path)` from `src/phase-engine/roster/schema.ts` (bounded
  by `ROSTER_MAX_BYTES` = 256 KiB; dispatch.ts:1341-1436 shows the full
  pre-provision roster validation pattern).
- **changedFiles / testResults** — NOT in briefs. They come from the arm's
  step output (DF1.6 merged output: `testResults {passed, failed}`,
  `testsExecuted` flag) and feed `rank`'s score
  (`testPassRate*0.6 + uniqueFileCoverage*0.4`, story :125-130). `rank` joins
  the run record (`spendMicroUsd`, `commitSha`) with the step output; it
  authorizes nothing.

Exported helpers: `sanitizeLabel(text, max)` (:173), `MAX_URL` (:254),
`ROOT_FIELD_LABEL` (:443), `extractZodErrorField(error: z.ZodError): string`
(:445), `type Brief` (:420).

Manifest handling (dispatch.ts:1269-1335, 2110-2143):
`loadManifest(manifestPath, callerBudgetMs, repoRoot)` → `stripAuthoredLimit`
→ after mint `stampManifestLimit(loaded, mintedCeilingMicros)` →
`serializeManifest(stamped)` — all from `src/phase-engine/manifest.ts`. The
stamped manifest + `run-context.json` are the two files `fillRun` places in
every box. Fan-out arms get this for free by calling `dispatch()`.

Fan-out record `.sandbox/fanouts/<fanout-id>.json` written O_EXCL: the
mechanism precedent is `RunRecordStore.create` (O_EXCL `wx`, the authoritative
run-id arbiter — dispatch.ts:1844-1887 leans on it). Arm extension:
`store.set(runId, { extensions: { fanout: { schemaVersion: 1, fanoutId, arm } } })`
— the store merges patches; `schemaVersion` required of every namespace (story :438).

**Race completion marker** — `src/phase-engine/journal.ts:38-50`:

```ts
export function runMarkerRoot(): string { return process.env.QDS_RUN_ROOT ?? "/run"; }
/** The fixed in-box completion signal DF3.2's host-side poller keys on (AC7). */
export function runMarkerPath(): string { return path.join(runMarkerRoot(), "journal", "final.json"); }
```

`FileJournal.finish()` writes `JournalFile { version, runId, ok, completedAt?,
phases, gateEvents }` — `ok: true` ⇒ win, `ok: false` ⇒ `armFailed` (story
:102, :191). The poller composes `driver.exec(vm, …)` probe +
`driver.copyFile(vm, markerPath, hostTmp)`; per-call 10_000 ms deadline via
`withTimeout`; 5_000 ms poll tick; 3_600_000 ms overall ceiling.

---

## 5. Providers

### `resolveDriver` — `src/providers/index.ts:35`

```ts
export function resolveDriver(name: string, ctx: ResolveContext = {}): ProviderDriver
// ResolveContext { requestId?: string; runId?: string }
```

Registry: `registerDriver(name, factory)` (:21), `registeredDrivers()` (:25).
Registered: `"fake"` → `new FakeDriver()` (:124), `"exedev"` (:128). Unknown
name throws a bare `Error("unknown provider driver: …")` — the CLI wraps in
`asUsage` → exit 2. Every resolved driver is wrapped in an `instrument` Proxy
(:62) that logs `{requestId, operation: provider.<verb>, …, driver_call_ms}`
for the PRIMITIVES set (:50-60: create, list, listWithAnomalies, destroy,
expose, setPublic, whoami, exec, copyFile). Pass `{ requestId }` so fan-out
arms' driver lines join the fan-out correlation id.

`ProviderDriver` interface — `src/providers/driver.ts:169-195`:
`name`, `create(name, tag?)`, `list(name?)`, `listWithAnomalies?()`,
`destroy(vm)`, `expose(vm, port): Promise<string>`, `setPublic(vm)`,
`whoami()`, `exec(vm, argv, stdin?): Promise<ExecResult>`,
`copyFile(vm, remotePath, localPath)`. `ExecResult = { stdout, stderr, exitCode }`.

### FakeDriver — `src/providers/fake-driver.ts` — verdict for AC5 race testing: **READY**

Full capability list:

- **exec** (:296): spawns a REAL child process (`Bun.spawn`) with `cwd = <box
  dir>`, `env: process.env` (live view — runtime `process.env` changes are
  seen), detached process-group leader, returns `{stdout, stderr, exitCode}`.
  So `driver.exec(vm, ["sh", "-c", "test -f …"])` and `cat …` probes are real.
  Requires the box to exist (`readMeta` throws otherwise) and box names to pass
  `assertValidRunId`.
- **copyFile** (:346): box → host, `realpath`-guarded against symlink escape.
  Reads `/run/journal/final.json` (or any in-box path) to a host tmp — exactly
  the AC5 read half.
- **create** (:119): mkdirs the box dir lazily (mode 0700), writes
  `.box.json` meta. **Boxes are plain host directories** — a race test plants
  the marker directly at `join(fakeDriver.root, vmName, "journal",
  "final.json")` (root defaults `.sandbox/fake-boxes` or `QDS_FAKE_BOXES_DIR`,
  :28/:81; tests pass `new FakeDriver(join(dir, "boxes"))`).
- **expose/setPublic** (:276/:286): meta writes; URL `https://<vm>-<port>.fake.local`.
- **destroy** (:270): kills the exec tree, `rmSync` recursive.
- Does it "simulate final.json markers"? Not built in — and none is needed:
  the marker path resolves through `runMarkerRoot()` which honors
  `QDS_RUN_ROOT`, and `QDS_RUN_ROOT` is documented (journal.ts:31-36, story
  :191) as the **host-test-only override**. Because `FakeDriver.exec` passes
  `env: process.env`, setting `process.env.QDS_RUN_ROOT = boxDir` in the test
  makes the poller's marker path land inside the fake box; or the poller probes
  a path the test planted directly. Timing control: the test writes (or
  doesn't write) the marker file whenever it wants — `Bun.sleep` in the test
  gives deterministic first/loser ordering. No latency hooks exist on the
  driver; for a "call overruns the 10 s per-call deadline" test, wrap the
  driver in a Proxy that delays `exec` (the DI seam makes this trivial —
  `DispatchDeps.driver` is just an object).

Caveats: absolute `/run/…` is not writable on darwin dev hosts, so tests must
use `QDS_RUN_ROOT` or plant via `join(root, vm, "journal", "final.json")` with
a poller probe path composed from the same helper; `fakeGate` (:fake-gate.ts)
runs five REAL probes (A-E) via `driver.exec` — for fan-out tests that don't
want gate latency, inject `deps.setupGate` returning an instant-ready
`SetupGateResult` (shape: `{ready, failedItem?, assertionCode?,
assertions[{item, ok, note}], debugCommands[], teardownCommand, vm}`).

---

## 6. Test patterns (`tests/fleet/*.test.ts`)

- **No exported cross-file "build deps" helper exists.** Each suite defines a
  local `deps(overrides)` closure. The canonical template is
  `tests/fleet/dispatch.test.ts:238-247`:

```ts
function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    driver,                       // new FakeDriver(join(dir, "boxes"))  — beforeEach :179
    keyApi,                       // new FakeKeyApi()                     — :180
    store,                        // new RunRecordStore(join(dir, "runs"))— :178
    ledgerFactory: () => goodLedger(),
    repoRoot: dir,                // the per-test mkdtemp containment root
    ...overrides,
  };
}
```

  Lifecycle: module-level `tmpRoot = realpathSync(mkdtempSync(...))` (:132)
  swept in `afterAll`; per-test `dir`/`outsideDir` mkdtemp in `beforeEach`
  (:175-181), removed in `afterEach` (:198-202). Log capture:
  `restoreLog = setLogSink((e) => entries.push(e))` (:188).
- **The shared fixture file for fleet tests is `tests/fleet/helpers.ts`** —
  ledger fakes `goodLedger(ceilingMicroUsd?, capMicroUsd?)`,
  `overBudgetLedger()`, `admitThrowsLedger()`, `closeThrowsLedger()`,
  `RecordingLedger {admitCalls, closeCalls}` (snapshots `input` via
  structuredClone). DF3.2's new fakes (fanout-record store fake, delayed
  drivers) belong beside these, and the story's `RecordingLedger` pattern
  ("RECORDS what it was asked") is the template. `rejection()` combinator
  lives in `tests/helpers.ts` (moved there deliberately — helpers.ts:130-133).
- **KeyApi double:** `tests/providers/fixtures/fake-key-api.ts` — `FakeKeyApi`
  with controllable pagination/DELETE-status/zero-usage knobs.
- **CLI tests:** `tests/fleet/cli.test.ts` — `runCli = (argv, d?) =>
  run(argv, out, d, errOut)` (:486) keeps stdout/stderr sinks apart;
  `reset()/text()` capture helpers; e2e demo dispatch → status → teardown on
  the fake driver.
- **verbs tests:** bidirectional exit-code coverage (observed codes through the
  parser vs declared `exitCodes`, ~:878-903); `renderHelp` proved with a
  synthetic registry so real names can't leak.
- **Negative-test idiom:** `UnexpectedSuccessError` + `failUnreachable()`
  (dispatch.test.ts:88-105) so a swallowed `expect.unreachable()` can't
  misreport; `expectSingleRefusalLine(code)` (:278-285) as the shared minimum
  structured-line assertion.
- **Clock seam:** `stepClock()` (:143-151) — a clock that only moves when the
  test advances it (a constant offset is inert because dispatch baselines off
  the same seam).
- **Story DoD names the new file:** `tests/fleet/patterns.test.ts` for the
  three per-pattern E2Es (story :173).

---

## 7. GitNexus

`context({name: "dispatch"})`: exactly ONE production caller —
`scripts/fleet.ts run()` (plus tests). Outgoing calls: the providers
primitives (`provisionAdmittedRun`, `mintRunKey`, `deliverRunKey`,
`assertWithinBudget`, `checkHeadroom`) and phase-engine loaders. Processes:
proc_16/17/59/222 (dispatch redaction/text families). Blast radius for DF3.2
is **zero edits to dispatch.ts if fan-out composes `dispatch()` as-is** — which
the module's own comments anticipate (§1.1). Per repo CLAUDE.md: run
`impact({target, direction: "upstream"})` before any symbol edit and
`detect_changes()` before commit; `rename` (never find-and-replace) for renames.

---

## 8. Repo idioms to copy

1. **Module-header JSDoc prose** stating invariants (INV-N/AC-N references) and
   what the module does NOT own (ownership fences: "DF2.6 owns the ceiling…").
2. **Errors:** throw `FleetError(exitCode, kebab-code, message, remediation,
   payload)` from src; the CLI renders. Provider `.code`/`.remediation` ride
   the payload (`providerCodePayload`/`errorRemediation` pattern).
3. **Redaction at sinks:** `redactSecrets` from `src/providers/step-log.ts`
   everywhere foreign text becomes output; `«redacted»` placeholder; bounded
   echoes (`bounded()` fleet.ts:706, `runIdEcho`, `escapeText`).
4. **DI over module mocks:** deps objects with optional seams + `??` defaults;
   `bun:test` `mock()`/`spyOn` only at true seams.
5. **Structured logs:** one line per phase via `log({...})`, guarded in
   try/catch — "a sink failure is never the run's failure".
6. **JSON-lines stdout**, JSON envelopes on stderr; `writeAll` for short-write
   safety; EPIPE/EAGAIN tolerance with exit-6 semantics for landed work.
7. **`ponytail:` comments** name accepted ceilings and upgrade paths.
8. **CLAUDE.md style rule:** files under ~500 lines (dispatch.ts at 2,517 is
   the acknowledged outlier); fanout.ts and rank.ts as separate modules fits.
9. **Fail-closed everywhere:** absence named (`null`/`undefined`), never a
   fabricated default; unverifiable reads refuse.

## 9. Gaps / decisions for the implementer

- `within()` is not reusable — use `withTimeout` (providers/timeout.ts) for the
  poller's 10 s per-call bound; the 5 s tick loop is fanout-local.
- No existing fanout-record store — model on `RunRecordStore`'s O_EXCL create
  + patch-merge `set`; the story fixes the path (`.sandbox/fanouts/`).
- No time-based stale lock exists (run-lock is pid-liveness based); AC8's
  3_600_000 ms stale-after is new but small — copy run-lock.ts's body-file
  shape (`<pid> <host> <ISO> <nonce>`) and add an age check on acquire.
- `listVerbs()` docstring claims "Exactly 4 entries" — update with the new
  verbs, and add verbs.test.ts probes for the new exit-code sets.
- `rank` needs the DF1.6 step-output shape (`testResults`, `testsExecuted`,
  `changedFiles`) — that lives in the phase engine's merged output, not the
  run record; the join key is `runId` (story :224-226).
