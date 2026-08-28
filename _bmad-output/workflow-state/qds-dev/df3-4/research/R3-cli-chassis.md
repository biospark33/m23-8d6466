# R3 — DF3.1 fleet CLI chassis (read-only survey for DF3.4)

Branch `feature/df3-4-approval-gate-attach-steering`. Files read in full:
`src/fleet/verbs.ts` (216 L), `src/fleet/status.ts` (802 L), `scripts/fleet.ts` (2813 L),
`src/fleet/index.ts` (20 L); skimmed `src/fleet/dispatch.ts` (2977 L),
`scripts/lib/run-lock.ts` (1150+ L), `src/fleet/fanout-primitive.ts`, `src/fleet/brief-schema.ts`,
`src/providers/step-log.ts`, `src/swarmclaw/log.ts`, `tests/fleet/verbs.test.ts`,
`tests/fleet/cli.test.ts`.

> Tooling note: `grep` treats `scripts/lib/run-lock.ts` as binary (a fixture string in it
> carries a lone surrogate / control byte). Use `grep -a` on that file or you get silent
> empty results.

---

## 1. The verb REGISTRY (`src/fleet/verbs.ts`)

### Types (verbs.ts:30-41)

```ts
export interface VerbFlag {
  name: string;
  required: boolean;
  valueType: "string" | "path" | "boolean";
}

export interface VerbEntry {
  verb: string;
  summary: string;
  flags: VerbFlag[];
  exitCodes: number[];
}
```

`listVerbs(): VerbEntry[]` (verbs.ts:49-178) returns a literal array — **6 entries today**:
`dispatch`, `status`, `harvest`, `teardown` (DF3.1) then `fanout`, `rank` (DF3.2, appended
without editing a DF3.1 entry — that is the precedent DF3.4 must copy).

`renderHelp(registry: VerbEntry[]): string` (verbs.ts:186-216) is the ONLY place `--help`
content lives. Per entry it emits `  <verb padEnd(10)> <summary>`, then one indented line
per flag `        --name (valueType, required|optional)`, then
`        Exit codes: a, b, c`, then a blank line; the whole thing `.trimEnd()`ed.
There is deliberately no per-verb help — every `--help`/`-h`/`help` argv answers with the
same global string and `tests/fleet/cli.test.ts:855-880` pins that byte-for-byte.

### Verbatim entry to copy (`harvest`, verbs.ts:91-107)

```ts
    {
      verb: "harvest",
      summary: "Pull bundle + artifacts from a box",
      flags: [
        { name: "--driver", required: true, valueType: "string" },
        { name: "--dir", required: false, valueType: "path" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // 5 = the run lock refused, so the verb never ran — "refused before
      // provisioning", and nothing was mutated. Not 1: `logVerb` stamps 1
      // `transient` ("retry me"), and for a STALE lock nothing will ever clear
      // it, so automation retried forever. See scripts/fleet.ts `acquireRunLock`.
      // 6 = cleanup failed on an otherwise-successful path (ledger close or run-lock
      // release). Distinct from 1 because it is NOT retryable: the work succeeded and
      // a retry only re-hits the wedged lock. See scripts/fleet.ts `cleanupFailed()`.
      exitCodes: [0, 1, 2, 4, 5, 6],
    },
```

And `rank` (verbs.ts:152-176) is the precedent for a verb with **no `--driver`**:

```ts
    {
      verb: "rank",
      summary: "Score a completed best-of-N fan-out (advisory; emits scores, tie, rationale)",
      flags: [
        { name: "--dir", required: false, valueType: "path" },
        { name: "--steps-json", required: false, valueType: "path" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      exitCodes: [0, 1, 2, 4, 6],
    },
```

### How DF3.4 appends `approve` / `reject` / `attach` without touching a DF3.1 line

Insert three object literals **between `rank`'s closing `},` (verbs.ts:176) and the array's
`];` (verbs.ts:177)**. Nothing else in `verbs.ts` changes. Consequences that fall out for
free (all registry-derived — no second list to edit):

- `--help` renders the new verbs (`HELP = renderHelp(listVerbs())`, fleet.ts:126).
- `VALUE_FLAGS` / `BOOL_FLAGS` (fleet.ts:153-167) are derived unions over every verb's
  flags, so the tokenizer splits new flags correctly with no edit.
- `parseArgv`'s per-verb `allowed` set (fleet.ts:664-673) refuses every undeclared flag on
  the new verbs automatically, and refuses the new flags on old verbs.
- `tests/fleet/verbs.test.ts:263-276` ("listVerbs keeps every known verb") is explicitly
  OPEN-WORLD — a 7th/8th/9th verb needs no test edit. `tests/fleet/cli.test.ts:709-713`
  loops `listVerbs()` and requires each declared code to appear on that verb's printed
  help line, so the new entries are covered as soon as they exist.

Hard registry constraints DF3.4 must satisfy:

1. **Every entry declares `{ name: "--help", required: false, valueType: "boolean" }`** —
   `tests/fleet/verbs.test.ts:317` asserts it per verb, and the module-level invariant at
   fleet.ts:209-213 refuses to START if `--help`/`-h` are not derived booleans.
2. **No flag name may have two `valueType`s across verbs.** `flagTypeConflicts()`
   (fleet.ts:180-201) runs at module load and `throw`s at import time on a conflict.
   So e.g. `--token` must be `"string"` everywhere it appears.
3. **No flag name may match `/admit|headroom|budget|ceiling|skip|force|bypass/i`** —
   `tests/fleet/verbs.test.ts:234-262` (F6). So `--force-approve`, `--skip-gate` are
   forbidden spellings.
4. `exitCodes` must contain `0` and `2` (verbs.test.ts:314-316) and every value must be in
   `DOCUMENTED_EXIT_CODES` = `[0,1,2,3,4,5,6]`, which the test derives from `report()`'s
   literal clamp in `scripts/fleet.ts` (verbs.test.ts:201-232).
5. Positionals are NOT registry flags (verbs.ts:7-9, C6) — `approve <run-id>` is per-verb
   CLI grammar, checked inside the verb block.

### Callers of `listVerbs` (GitNexus `context`)

`scripts/fleet.ts` (module scope, `parseArgv`, `run`), `tests/fleet/verbs.test.ts`,
`tests/fleet/cli.test.ts`. No other production consumer. `src/fleet/index.ts:11`
star-exports `./verbs.ts`.

---

## 2. `scripts/fleet.ts` — parsing, dispatch, help, exit codes

### Arg parsing pipeline

`run(argv, out, deps?, err = out): Promise<number>` (fleet.ts:1159-1169). Order:

1. fleet.ts:1312-1314 — wire the hardened stderr log sink for embedders (only if the sink
   is still `BOOT_LOG_SINK` and not muted under `bun test`).
2. fleet.ts:1315-1362 — the ONE pre-tokenization read: `argv[0] === "help"`. Validates
   "no flags after `help`", "at most one `<verb>`", "verb must be in the registry", then
   `emit(HELP, true)` and `finish(..., 0, undefined, "help")`.
3. fleet.ts:1364-1396 — `parseArgv(argv)`; a throw is rendered through `report(note, e)`
   and still logs a CC-9 line with a best-effort re-tokenized verb name.
4. fleet.ts:1397-1421 — `parsed.help === true` ⇒ print HELP, exit 0, `phase: "help"`.
5. fleet.ts:1422-1426 — destructure; `briefPath = flags.get("--brief")`,
   `dir = flags.get("--dir")`, `storeOpts`.
6. Verb blocks in file order: `dispatch` (1429-1697), `fanout` (1700-2039),
   `rank` (2041-2182), then the shared tail:

```ts
2184  // status / harvest / teardown all take an optional-or-required runId.
2185  const runIdArg = positionals[1];
2186  const driverName = flags.get("--driver");
2187  const requestId = newRequestId();
2189  // ── status ─────────────────────────────────────────────────────────────
2190  if (verb === "status") { … }
2276  // ── harvest / teardown (AC5 …) ─────────────────────────────────────────
```

**Dispatch of a verb is a straight `if (verb === "…") { … return finish(...); }` chain, not
a handler table.** There is no `handler(argv, deps)` signature in the registry — the
`VerbEntry` carries no function. DF3.4's three verbs are therefore three new
`if (verb === "approve") { … }` blocks. The lazy placement is **immediately before
`// ── harvest / teardown` at fleet.ts:2276**, i.e. after `runIdArg`/`driverName`/`requestId`
are in scope (2184-2187) — that reuses the shared runId positional and requestId with zero
edits to DF3.1 lines. `attach` (if it takes a `--port`-ish or steering payload) can sit in
the same place.

`parseArgv` internals (fleet.ts:564-675):

- `tokenizeArgs(argv, { valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS, rejectStraySingleDash: true })`
  (`scripts/lib/cli-args.ts:116-135`) → `{ positionals, flagTokens, bools }`. Throws are
  wrapped as `usageError(bounded(msg), HELP)`.
- Duplicate-bool guard over raw argv with `-h` canonicalized to `--help` (fleet.ts:591-598).
- Boolean-given-a-value guard (`--no-harvest=true` ⇒ `"--no-harvest takes no value"`,
  fleet.ts:605-609).
- `parseValueFlags(flagTokens, { flags: VALUE_FLAGS, onValue, help: [HELP] })`
  (`cli-args.ts:50`) with a duplicate-value-flag refusal (fleet.ts:619).
  **`help:` is TEXT, not a token list**, and MUST stay unreachable — `parseValueFlags`
  answers a `--help` match with `writeSync` + `process.exit(0)`.
- `bools.has("--help")` ⇒ `{ help: true, verb? }` (fleet.ts:648) — only AFTER the value
  grammar has run.
- Unknown verb ⇒ `new FleetError(2, "unknown-verb", …)` (fleet.ts:660).
- Per-verb `allowed` set from `entry.flags` (fleet.ts:664-673).

### EXIT CODE table — as implemented

Header (fleet.ts:9-26) plus every site that actually produces a code:

| Code | Meaning (as implemented) | Produced at |
|---|---|---|
| 0 | success | `finish(..., 0)` on each verb's happy path |
| 1 | run/provider failure — the SUBSTRATE, retryable. `logVerb` stamps `exitStatus: "transient"` | `report()` generic branch (fleet.ts:539); `status` when a `listUnavailable` row is present (fleet.ts:2270); `FleetError(1, "record-store-unreadable" \| "record-read-failed")` (status.ts:642, 781); `FleetError(1, "run-id-check-failed")` (dispatch.ts:243) |
| 2 | usage/schema — permanently wrong, never retry | `usageError()` (fleet.ts:263); `unknown-verb`; `invalid-run-id`; `brief-too-large` / `brief-unreadable` / `invalid-brief` / `brief-stdin-timeout`; `--port` not a TCP port; `invalid-list-timeout` (status.ts:232); `status` when `skippedRecords` is non-empty (fleet.ts:2270 — 2 WINS over `listFailed`'s 1); `report()`'s fallback for an off-table `FleetError.exitCode` (fleet.ts:482); `report()` for a PERMANENT errno (fleet.ts:539) |
| 3 | setup-gate failure, assertion code in the payload | `dispatch` only (dispatch.ts:2682 area) |
| 4 | run-not-found | `FleetError(4, "run-not-found")` — status.ts:752, fleet.ts:2367 |
| 5 | refused BEFORE provisioning; the payload `code` names the guard | run-lock acquire refusal → `FleetError(5, e.code…)` (fleet.ts:2426); `record-read-failed` on harvest/teardown (fleet.ts:2382); fanout `fleet-busy` / `no-headroom` |
| 6 | the verb's own work LANDED but the invocation could not finish or report it, and no retry can change that | `cleanupFailed()` (fleet.ts:2629-2631); `ack-unwritable` (fleet.ts:1670); `reportCompletion() === false` (fleet.ts:2471-2475, 2589-2611); `help-unwritable` (1359, 1413); `lock-mark-failed` (2556); `keyUnattributable \|\| !markCleared \|\| !reportedLanding` (2611); `lock-held` / `lock-released-work-landed` (2698, 2726); `finish()` folding `outputIncomplete` (fleet.ts:1264) |
| 129 / 130 / 143 | 128+SIGHUP/SIGINT/SIGTERM — **outside the table on purpose** (fleet.ts:21-25). `exitStatus: "signalled"`. | dispatch's interrupt handlers (fleet.ts:1475-1514); harvest/teardown's `verbInterruptHandler` (fleet.ts:2440-2447) |

`report()` (fleet.ts:462-540) clamps a `FleetError.exitCode` to `1..6`, falling back to **2**
(not 1) — `tests/fleet/verbs.test.ts:201-232` parses that literal clamp out of the source
and derives `DOCUMENTED_EXIT_CODES` from it, so widening the table means widening that
clamp AND the test follows automatically. Floor is 1: `new FleetError(0, …)` would let a
refusal report success.

**⚠ AMBIGUITY / BLOCKER for DF3.4 (INV-APPROVE-9).**
`FleetError`'s constructor (dispatch.ts:205-216) types `exitCode` as **`1 | 2 | 3 | 4 | 5`** —
there is **no `new FleetError(6, …)` anywhere in the repo** (verified by grep over `src/`
and `scripts/`). Exit 6 is only ever produced by CLI-local `code = 6` assignments and by
`finish()`'s `outputIncomplete` fold. So DF3.4 must reach 6 the same way harvest/teardown
do — `reportCompletion(...) ? 0 : 6`, or `code = 6` inside the verb block — and must NOT
try to throw it. Widening the union at dispatch.ts:207 would be an edit to a DF3.1-owned
line. Flagging rather than deciding.

---

## 3. Refusal / error idiom

### `FleetError` (src/fleet/dispatch.ts:205-216)

```ts
export class FleetError extends Error {
  constructor(
    public readonly exitCode: 1 | 2 | 3 | 4 | 5,
    public readonly code: string,
    message: string,
    public readonly remediation: string,
    public readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FleetError";
  }
}
```

ONE class, owned by `dispatch.ts`. `status.ts:23` imports it and deliberately does NOT
re-export it (status.ts:16-22 explains: the barrel star-exports both modules).

### `usageError` (fleet.ts:263-265)

```ts
function usageError(message: string, remediation: string): FleetError {
  return new FleetError(2, "usage", message, remediation);
}
```

### `printError` (fleet.ts:390-400)

```ts
function printError(
  err: (s: string) => void,
  code: string,
  message: string,
  remediation?: string,
  payload?: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = { ...(payload ?? {}), code, message };
  if (remediation !== undefined) line.remediation = remediation;
  err(`${JSON.stringify(line)}\n`);
}
```

Envelope order matters: payload spread FIRST so a typed payload can never overwrite
`code`/`message`. **`printError` does NOT redact** — deliberately (fleet.ts:385-388): the
messages this file composes echo argv, and `redactSecrets` eats any ≥40-char opaque token.
Redaction happens at the three places FOREIGN text enters: `asUsage` (fleet.ts:443),
`report`'s untyped branch (fleet.ts:506-532), and `ingestBriefJson`'s parse-failure embed.

### The three sanitizers — exact signatures and where each MUST be applied

| Helper | Signature / location | Apply to |
|---|---|---|
| `redactSecrets` | `export function redactSecrets(text: unknown, keep?: string): string` — `src/providers/step-log.ts:225`. Takes `unknown`, never throws (fails closed to a placeholder). | ANY text this CLI did not compose: driver/credential-client `.message`, `.stack`, `cause.message`, errno text. Sites: `asUsage` (443), `report` (506, 510, 516, 532), `bounded` (1127), every `printError` message that interpolates `errText(e)` / `x.message`. |
| `sanitizeLabel` | `export function sanitizeLabel(text: string, max: number): string` — `src/fleet/brief-schema.ts:173`. STRIPS `\p{Cc}\p{Zl}\p{Zp}\p{Cf}`, repairs lone surrogates → U+FFFD, caps to `max` UTF-16 units with a `…`. `max < 1` ⇒ `""`. Takes `string` (not `unknown`). | Store- and substrate-supplied strings **at the producer**, never per consumer. Sites: `safeName`/`safeDiagnostic`/`sanitizeOptional`/`safeUrl` in status.ts (150-216), `recordsSkippedRow` (523), `rowForRecord` (385-413), the CLI's records-skipped envelope (fleet.ts:2253, `max` 512). **This is the log-forgery fix the DF3.1 review produced** — a box named `"box\nFLEET teardown ok"` reached `orphanRow`'s `runId` interpolation raw. |
| `escapeText` | `function escapeText(text: unknown): string` — `src/fleet/dispatch.ts:590`. `JSON.stringify(...)` minus the wrapping quotes; `"«unprintable»"` on throw. **NOT exported.** | dispatch.ts-internal only: zod issue text, `CorrelationError.message`, exedev gate `note`/`debugCommands`/`teardownCommand`. Always composed as `redact(escapeText(x))` (dispatch.ts:1029, 1376, 2687). |
| `bounded` | `function bounded(s: string \| undefined): string` — fleet.ts:1125-1129. `redactSecrets` FIRST, then cap at `MAX_ECHO = 96` with `…(N chars)`. `undefined` ⇒ `"(none)"`. **CLI-local, not exported.** | Every **argv-derived** echo: refusal messages that quote a flag/verb/dir/port, and the `runId`/`verb` fields of the CC-9 log line (applied once inside `logVerb`, fleet.ts:1086-1087). |

Order rule stated twice in the source and worth repeating for DF3.4: **redact first, then
cap.** Capping first slices a pasted credential across the 96-char boundary into halves no
redaction rule matches (fleet.ts:1116-1123, dispatch.ts:264-266).

`asUsage<T>(build: () => T): T` (fleet.ts:425-445) — wrap every provider-layer construction
(`resolveDriver`, `new RunRecordStore`, `openRouterKeyApi`, `new CostLedger`) so its bare
`Error` becomes an exit-2 envelope instead of a retryable exit 1 — **except** when
`e.code ∈ RETRYABLE_ERRNOS` (fleet.ts:448:
`["ENOSPC","EDQUOT","EIO","EBUSY","EMFILE","ENFILE","EAGAIN","ETIMEDOUT"]`), which rethrows
raw. Its inverse `PERMANENT_ERRNOS` (fleet.ts:459:
`["EACCES","EPERM","ENOTDIR","EISDIR","ENOENT","EROFS","ELOOP","EBADF"]`) makes `report()`
return 2 instead of 1 for OS-classified runtime errnos (EPIPE/EAGAIN excluded).

There is **no `refuse()` function in the fleet CLI**. `refuse(lock, holder)` exists only in
`scripts/lib/run-lock.ts:487` (private, returns `RunLockedError | undefined`).
`RunLockedError` (run-lock.ts:54-64) carries `readonly code = "run-locked"` and a
`remediation` — the CLI maps it at fleet.ts:2426: `throw new FleetError(5, e.code, e.message, e.remediation)`.

---

## 4. On-exit write discipline (INV-APPROVE-9) — reuse, do not re-implement

### `writeAll` (fleet.ts:2765-2773) — the primitive

```ts
function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error(`fd ${fd} accepted 0 of ${buf.length - off} bytes`), { code: "EAGAIN" });
    off += n;
  }
}
```

Guards: short-write loop (`writeSync` can write short — a truncated ack is worse than a
slow one); a **zero-length return is NOT a retryable short write** — it is a non-blocking
fd refusing bytes, and looping would spin forever while the run lock is held and the box
bills, so it is surfaced as a synthetic `EAGAIN`. It does NOT swallow EPIPE — the caller
decides.

### `writeBestEffort` (fleet.ts:2783-2789) — the diagnostic wrapper

```ts
function writeBestEffort(fd: number, s: string): void {
  try {
    writeAll(fd, s);
  } catch {
    // Nothing left to report it to.
  }
}
```

### Wiring (fleet.ts:2791-2804)

```ts
if (import.meta.main) {
  try {
    setLogSink((entry) => { writeBestEffort(2, `${JSON.stringify(entry)}\n`); });
    process.exit(await run(process.argv.slice(2), (s) => writeAll(1, s), undefined, (s) => writeBestEffort(2, s)));
  } catch (e) { … writeBestEffort(2, stack …); process.exit(1); }
}
```

stdout = `writeAll(1, …)` (failures are real). stderr = `writeBestEffort(2, …)` (never
changes an outcome). The same posture is duplicated once, on purpose, in
`scripts/lib/run-lock.ts:388-400` (`writeStderr`, best-effort, used from a
`process.on("exit")` handler).

### The four in-`run()` write wrappers DF3.4 must route through — not `out`/`err` directly

- `note(s)` (fleet.ts:1180-1186) — `err()` inside a try/catch. Every `printError` in a
  verb block passes `note`, never `err`.
- `emit(s, failOnEpipe = false)` (fleet.ts:1225-1247) — plain OUTPUT. EPIPE silent unless
  `failOnEpipe`; EAGAIN/EWOULDBLOCK sets `outputIncomplete = true` and prints ONE
  `stdout-truncated` envelope; everything else rethrows.
- `reportCompletion(...lines: string[]): boolean` (fleet.ts:1281-1295) — **the helper for
  a line that reports work already done.** Emits each line with `failOnEpipe = true`; on
  any failure prints a `completion-unwritable` envelope to stderr and returns `false`. The
  caller then does `code = ok ? 0 : 6`. **This is the exact seam for INV-APPROVE-9.**
- `finish(rid, v, runId, code, exitStatusOverride?, phase?)` (fleet.ts:1256-1264) —
  `logVerb`, plus `code === 0 && outputIncomplete ? 6 : code`. **Every verb must return
  through `finish`, never a bare number.**

The dispatch ack is the ONE stdout write that bypasses `emit` (fleet.ts:1657-1671): it
calls `out()` directly and maps any failure to `ack-unwritable` + code 6, because its
`runId` is the only handle on a live billing box. If DF3.4's `attach` returns a handle of
comparable value, that is the precedent; otherwise `reportCompletion` is the right one.

---

## 5. `src/fleet/status.ts` — assembly pipeline and the DF3.4 seams

### Types

```ts
export interface StatusRow {
  runId: string;
  state: "live" | "boxMissing" | "boxUnknown" | "closed" | "orphan" | "listUnavailable" | "recordsSkipped";
  requestId?: string;   // absent on `orphan` rows and ONLY there
  vmName?: string;
  httpsUrl?: string;
  boxAlive?: boolean;   // tri-state, set only on `closed`
  createdAt?: string;   // absent on `orphan` rows and ONLY there
  closedAt?: string;
  spendMicroUsd?: number;
  limitMicroUsd?: number;
  skippedRecords?: string[];
}

export interface StatusDeps {
  driver: { list(name?: string): Promise<ProviderVm[]> };
  store: RunRecordStore;
  listTimeoutMs?: number;
}
```

**7 states, not 5** — confirmed (status.ts:32). The spec's five are the RUN states
(`live`, `boxMissing`, `boxUnknown`, `closed`, `orphan`); the extra two are FLEET-level
rows that describe the listing itself, both carrying
`runId = FLEET_ROW_ID` = `"(fleet)"` (status.ts:480, parenthesised so it can never collide
with `RUN_ID_RE`'s `[a-z0-9-]`):

- `listUnavailable` (`listUnavailableRow()`, status.ts:496-498) — `driver.list()` failed or
  timed out. Emitted unconditionally on that path, because with no open records
  `boxUnknown` would produce an empty row set indistinguishable from a healthy fleet.
- `recordsSkipped` (`recordsSkippedRow(skipped)`, status.ts:518-524) —
  `listWithAnomalies().skipped` non-empty; `skippedRecords: skipped.map(safeName)`.

`orphan` rows use `runId: \`(orphan ${safeName(vm.name)})\`` (status.ts:466-472), same
parenthesising trick.

### `statusAll(deps): Promise<StatusRow[]>` (status.ts:594-689) — the pipeline

1. `resolveTimeoutMs(deps)` (229-240): `deps.listTimeoutMs ?? 30_000`, non-finite or ≤0 ⇒
   `FleetError(2, "invalid-list-timeout")`, clamped to `MAX_LIST_TIMEOUT_MS = 2_147_483_647`.
2. **600-648** — `listing = deps.store.listWithAnomalies()` inside a try, with a deep SHAPE
   guard (records is an array, skipped is an array, every element is a non-array object
   with `string` `runId`/`createdAt` and absent-or-string `vmName`/`httpsUrl`/`requestId`/
   `closedAt` — `RECORD_TEXT_FIELDS`, status.ts:586). Any failure ⇒
   `FleetError(1, "record-store-unreadable", …, safeDiagnostic(e))`.
3. **652** — `const boxes = await listOwnedBoxes(deps, timeoutMs)` — unconditional (a
   closed record's box can still be alive, and the union must see unclaimed boxes).
   `listOwnedBoxes` (305-340) runs `listOwnedBoxesOnce` under ONE deadline across both
   attempts, with a named-lookup→unfiltered retry, returning `Map<string, ProviderVm> | null`
   (`null` ⇒ "the substrate could not be asked"). `listOwnedBoxesOnce` (342-362) filters by
   `typeof v?.name === "string" && v.name.length > 0 && isOwnedVm(v)`.
   `isOwnedVm` (108-110): `vm.tag === undefined || vm.tag === SBX_OWNERSHIP_TAG` —
   **untagged ⇒ ours** (fail-safe; exedev's `ls --json` carries no tag field).
4. **655-660** — `rows = records.map(rec => { const row = rowForRecord(rec, boxes);
   pinSortInstant(row, rec.createdAt); return row; })`.
5. **665** — `if (listing.skipped.length > 0) rows.push(recordsSkippedRow(listing.skipped));`
6. **667-684** — `if (boxes === null) rows.push(listUnavailableRow())` **else** the orphan
   sweep: build `claimed` from every record's `runId` and `vmName`, then
   `for (const [name, vm] of boxes) if (!claimed.has(name)) rows.push(orphanRow(vm));`
7. **686** — `rows.sort(byCreatedAtDesc)` (553-578; numeric instants from the `sortInstants`
   WeakMap, absent/unparseable ⇒ `+Infinity` = sorts FIRST, `runId` code-unit tie-break).
8. **688** — `return rows;`

### How `boxMissing` is decided — `rowForRecord(rec, boxes)` (status.ts:373-427)

```ts
const names = rec.vmName === undefined ? [rec.runId] : [rec.vmName, rec.runId];
const box = boxes === null ? undefined : names.map((n) => boxes.get(n)).find((b) => b !== undefined);
…
if (rec.closedAt !== undefined) return { ...base, state: "closed", closedAt: …,
  ...(boxes === null ? {} : { boxAlive: box !== undefined }) };
if (boxes === null) return { ...base, state: "boxUnknown" };
return { ...base, state: box === undefined ? "boxMissing" : "live" };
```

So: `closedAt` set ⇒ `closed` (with tri-state `boxAlive`); else no listing ⇒ `boxUnknown`;
else box found under EITHER `vmName` or `runId` ⇒ `live`, not found ⇒ `boxMissing`.
The join is on runId **and** vmName because `createRun` names the box after the run id and
persists `vmName` only after `driver.create()` returns.

### `statusRun(deps, runId): Promise<StatusRow>` (status.ts:706-802)

`assertFleetRunId(runId)` → `resolveTimeoutMs` → `store.get(runId)`. On throw: consult the
driver first (a box may be billing), then ENOENT ⇒ `orphanRow(box)` if a box answers, else
`FleetError(4, "run-not-found")` with a four-armed remediation; any other read failure ⇒
`FleetError(1, "record-read-failed")`. On success (798-801):

```ts
const filter = rec.vmName === undefined || rec.vmName === rec.runId ? rec.runId : undefined;
const boxes = await listOwnedBoxes(deps, timeoutMs, filter);
return rowForRecord(rec, boxes);
```

### EXACT seams for DF3.4 — (a) approval join, (b) lazy expiry sweep

The cheapest shape that edits **zero** DF3.1 lines is a new module (e.g.
`src/fleet/approval-status.ts`) exporting a decorator over the rows, appended to the barrel
as a new `export * from "./approval-status.ts";` line in `src/fleet/index.ts` (that file's
DF3.2 and DF3.3 additions at lines 12-20 are exactly this precedent), plus **inserted**
lines in the CLI's status block. Concretely:

- **(a) approval-extension join.** `scripts/fleet.ts:2214-2215` is:
  ```ts
  const rows = runIdArg === undefined ? await statusAll(statusDeps) : [await statusRun(statusDeps, runIdArg)];
  for (const row of rows) emit(`${JSON.stringify(row)}\n`);
  ```
  Insert a new statement **between 2214 and 2215** that maps `rows` through the decorator
  (`const decorated = await joinApprovals(rows, …); for (const row of decorated) …`) — but
  note the `for` loop on 2215 is itself a DF3.1 line, so the strictly-additive form is to
  decorate IN PLACE (`rows.splice`/reassign a `let`) or to name the decorated array and
  accept a one-token edit on 2215. **Flagging: an in-place decoration of the same array
  variable is the only shape that touches literally nothing; declaring `const rows` at 2214
  means DF3.4 must either mutate the array's elements or change `const`→`let`.**
  Inside `status.ts` itself, the analytically clean seam is the return points —
  status.ts:688 (`return rows`) and status.ts:801 (`return rowForRecord(...)`) — but both
  are DF3.1-owned lines, so decorating outside is preferred.
- **(b) lazy expiry sweep.** Must run BEFORE the rows are read so an expired approval is
  not reported live. Two candidate seams, both outside status.ts:
  1. in the CLI status block, between `assertRecordsDirUsable` (fleet.ts:2201) and the
     `statusAll`/`statusRun` call (2214) — a pure insertion into the middle of the try;
  2. inside the new approval store's read path (R1's territory), so every reader sweeps.
     Cheaper and race-free; prefer it unless R1 says otherwise.
- **StatusRow extension.** Adding `approval?: {...}` / `expiresAt?: string` as new optional
  fields at the END of the interface (after status.ts:77) is additive. **Widening the
  `state` union on status.ts:32 is an EDIT of a DF3.1 line** — if DF3.4 needs an 8th state
  it must either carry it in a new optional field instead, or get an explicit waiver.
  Flagging; do not decide unilaterally.
- Whatever fields are added must be sanitized at the PRODUCER (`sanitizeLabel`) like every
  other row string — status.ts:519-523 states the rule and the CLI reads `skippedRecords`
  straight back out of the row into an envelope (fleet.ts:2243-2263).

---

## 6. Secrets from STDIN, never argv (DF2.3 INV-CRED-3)

### The allow-list guard to copy — `assertOneBriefSource` (scripts/fleet.ts:867-879)

```ts
function assertOneBriefSource(briefPath: string): void {
  let st: ReturnType<typeof fstatSync>;
  try {
    st = fstatSync(0);
  } catch {
    return; // no fd 0 at all — nothing was attached
  }
  if (st.isCharacterDevice() || st.isSocket()) return;
  throw usageError(
    `--brief ${bounded(briefPath)} was given AND a brief was redirected onto stdin`,
    "pass the brief exactly one way: `--brief <path>`, or on stdin with no --brief",
  );
}
```

The doctrine (fleet.ts:834-866, worth reading in full before copying): the test is fd 0's
**TYPE**, not `isTTY` — cron/systemd/containers put stdin on `/dev/null`. It is an
ALLOW-LIST, closed set, so the next stdio type nobody has thought of is refused by default.
Benign and complete: character device (`/dev/null`, a tty), a closed fd 0 (`fstat` throws
EBADF), and a **socket** (what fd 0 is under any Node/Bun parent spawning with
`stdio: "pipe"` — refusing sockets broke every programmatic `--brief` caller). Refused:
fifo, regular file, anything else — both are deliberate attachments.

### The bounded stdin reader — `readCappedStdin` (fleet.ts:687-740)

Streams `Bun.stdin.stream().getReader()`, refusing AS IT STREAMS (`bytes > MAX_BRIEF_BYTES`
⇒ `FleetError(2, "brief-too-large")`) so `yes |` cannot OOM. **Each read races a
`STDIN_BRIEF_TIMEOUT_MS = 120_000` window** — including the first read and the post-last-chunk
wait for EOF — so a parent that pipes stdin and never closes the write end is refused with
`FleetError(2, "brief-stdin-timeout")` instead of hanging. On any throw it
`await reader.cancel().catch(() => {})` before rethrowing. The TTY case is refused earlier
by `ingestBriefJson` (fleet.ts:904-906): `if (process.stdin.isTTY) throw usageError("no brief on stdin", …)`.

### The one existing TOKEN-from-stdin reader — `readHostToken` (src/pr/github.ts:180-204)

```ts
export async function readHostToken(): Promise<string | null> {
  let keychain: string | null = null;
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "qds-factory-github", "-w"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code === 0 && out.trim().length > 0) keychain = out.trim();
  } catch {
    // No keychain on this host. Fall through to stdin; never surface the error,
    // which on some platforms carries the argv this call was made with.
  }
  if (keychain !== null) return keychain;

  // A piped stdin is the documented non-keychain path: `… | bun scripts/open-pr.ts <run-id>`.
  if (process.stdin.isTTY) return null;
  const piped = (await Bun.stdin.text()).trim();
  return piped.length > 0 ? piped : null;
}
```

Its docstring states the invariant verbatim: *"Never argv (it would show in `ps`, DF2.3
INV-CRED-3) and never `process.env` — an env-resident token is inherited by every child this
process spawns … It is held for the duration of one call and never cached to disk."*
Its seam is declared at `src/pr/push.ts:93` ("Reads the host token. Defaults to
keychain-then-stdin; never env, never argv") and its no-token refusal at `push.ts:314`.

**Recommendation for DF3.4's approver-token read:** `readHostToken` is the semantic
precedent (keychain → stdin, never argv/env) but its stdin arm is UNBOUNDED
(`Bun.stdin.text()`) and gates only on `isTTY`. The fleet CLI's own guards are strictly
stronger. The lazy composition that satisfies both: `assertOneBriefSource`'s fd-0 type
allow-list (inverted — the token verb WANTS a fifo/regular-file/pipe and must refuse a tty
or `/dev/null`), plus a `readCappedStdin`-shaped bounded read with its own small cap and
the same per-read stall timeout. Do not add a `--token` value flag; the registry test's
F6 vocabulary does not forbid it, but INV-CRED-3 does.

No other stdin credential path exists. Every other `stdin` hit in `src/` is the DRIVER's
`exec(vm, argv, stdin?)` channel (`src/providers/driver.ts:198`, `credentials.ts:342-385`
`deliverScript`), i.e. secrets going TO a box, not read FROM an operator.

---

## 7. Constant-time comparison

**Exists, but outside `src/fleet/`.** There is no fleet-side helper.

- `visualizer/server/auth.ts:15` — `import { createHash, randomBytes, timingSafeEqual } from "node:crypto";`
- `visualizer/server/auth.ts:83-87`:
  ```ts
  /** sha256 both sides, then compare the fixed 32-byte digests — length never leaks. */
  function constantTimeEqual(a: string, b: string): boolean {
    const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
    return timingSafeEqual(digest(a), digest(b));
  }
  ```
  **Not exported** — module-private to the visualizer server.
- `pi-vs-claude-code-vendor/coms-core.ts:236-243` — a vendored copy that checks length
  first (`timingSafeEqual` requires equal-length buffers), pinned by
  `tests/vendor/coms-core.test.ts:168`. Vendored code; do not import.
- `visualizer/test/auth.test.ts:526` documents why the digest form is used: a
  `timingSafeEqual` over raw strings throws on unequal lengths, which itself leaks length.

**For DF3.4:** the digest-then-compare form at `visualizer/server/auth.ts:84-87` is the
repo's idiom and the one to replicate (three lines; do not import across the
`visualizer/`↔`src/` boundary, and do not use bare `===` on an approver token).

---

## 8. Observability — the CC-9 contract

### The per-invocation line — `logVerb` (fleet.ts:1056-1098)

```ts
function logVerb(
  requestId: string,
  verb: string,
  runId: string | undefined,
  startedAt: number,
  code: number,
  exitStatusOverride?: VerbExitStatus,
  phase: "complete" | "help" = "complete",
): number
```

emits, via `log()`:

```ts
{ requestId, operation: `fleet.${verb}`, agentId: null, timestamp: new Date().toISOString(),
  duration: durationMs, durationMs, status: code === 0 ? "ok" : "error",
  runId: runId === undefined ? null : bounded(runId), verb: bounded(verb), phase,
  exitCode: code,
  exitStatus: exitStatusOverride ?? (code === 0 ? "success" : code === 1 ? "transient" : "logic") }
```

`type VerbExitStatus = ExitStatus | "signalled"` (fleet.ts:1054). `phase: "help"` exists so
a help request is never counted as a completed verb execution. **Both `runId` and `verb` are
`bounded()` at this ONE site** — do not re-cap at call sites, and do not bypass `logVerb`.

Always reached through `finish(...)` (fleet.ts:1256-1264), which folds `outputIncomplete`
into a 6. Every verb block ends `return finish(requestId, verb, runIdArg, code);`.

### `log` / `LogEntry` / `newRequestId` (src/swarmclaw/log.ts)

```ts
export interface LogEntry {
  requestId: string; operation: string; agentId: string | null; timestamp: string;
  duration: number; status: "ok" | "error";
  error?: { code: string; message: string; stack?: string };
  [k: string]: unknown;                       // ← how extra fields ride
}
export let logSink: (entry: LogEntry) => void = …;   // overridable; muted under bun test
export function log(entry: LogEntry): void { logSink(entry); }
export function newRequestId(): string { return crypto.randomUUID(); }
```

`logSink`'s default swallows EPIPE. The CLI replaces it with
`writeBestEffort(2, JSON.stringify(entry) + "\n")` both for `import.meta.main` (fleet.ts:2794)
and, since round 10, for embedders when the sink is still `BOOT_LOG_SINK` (fleet.ts:1312-1314).

### `requestId` propagation

- `dispatch`: **the BRIEF owns it** —
  `const requestId = resolveBriefRequestId(briefJson) ?? newRequestId()` (fleet.ts:1552),
  INV-4-bis; then threaded into `resolveDriver(name, { requestId })`,
  `new RunRecordStore({…, requestId })` and `DispatchDeps.requestId`.
- status / harvest / teardown: `const requestId = newRequestId()` once at fleet.ts:2187,
  then into `resolveDriver`, `RunRecordStore` and `TeardownDeps.requestId` (fleet.ts:2459).
- Refusal paths with no id yet mint one at the `finish` call
  (`finish(newRequestId(), …)`, fleet.ts:1345, 1359, 1361, 1395, 1413, 1420).
- The row-level join key is `StatusRow.requestId`, taken straight off the record and
  sanitized to `MAX_REQUEST_ID = 128` (status.ts:385).

### Sub-event lines and `*_ms` sub-timings

- `src/fleet/fanout-primitive.ts:836-857` is the fleet-side pattern:
  ```ts
  function armLine(requestId: string, fanoutId: string, fields: Record<string, unknown>): void {
    emitLine({ requestId, operation: "fleet.fanout.arm", fanoutId, ...fields });
  }
  function raceEvent(requestId: string, fanoutId: string, fields: Record<string, unknown>): void {
    emitLine({ requestId, operation: "fleet.fanout.race", fanoutId, ...fields });
  }
  function emitLine(fields: Record<string, unknown>): void {
    try {
      log({ agentId: null, timestamp: new Date().toISOString(),
            duration: typeof fields.durationMs === "number" ? (fields.durationMs as number) : 0,
            status: fields.error === undefined ? "ok" : "error",
            ...fields } as Parameters<typeof log>[0]);
    } catch { /* a raising sink must never replace the caller's real outcome. */ }
  }
  ```
  Note: **every `log()` in this layer is wrapped in try/catch** (dispatch.ts:1505-1508 says
  so explicitly — an unguarded sink throw turned a healthy dispatch into a bare exit 1).
- Sub-timing naming is **snake_case `*_ms`** and rides `LogEntry`'s index signature.
  Live examples: `src/providers/index.ts:91` `driver_call_ms`; `src/providers/run-record.ts:1878`
  `record_write_ms`; `src/providers/exedev/setup-gate.ts:270,578` `gate_ms`;
  `src/providers/credentials.ts:299,572` `mint_compensation_ms` / `delivery_compensation_ms`;
  `src/providers/reaper.ts:121` a whole `timings: { list_vms_ms, list_keys_ms, read_records_ms, reap_ms }`;
  `src/swarmclaw/mcp/tool-bridge.ts:410-411` `invoke_duration_ms` / `stdio_latency_ms`.
  The camelCase `durationMs` (alongside the schema's `duration`) is the WHOLE-operation
  field only. So DF3.4 should emit e.g. `approval_check_ms`, `expiry_sweep_ms` as snake_case
  siblings, and keep `durationMs`/`duration` for the verb total.

---

## Ambiguities flagged (decisions NOT made here)

1. **`FleetError` cannot express exit 6** (`exitCode: 1|2|3|4|5`, dispatch.ts:207). DF3.4's
   INV-APPROVE-9 must produce 6 via `reportCompletion(...) ? 0 : 6` / `code = 6`, as
   harvest and teardown do. Widening the union edits a DF3.1 line.
2. **Widening `StatusRow.state`** (status.ts:32) is an in-place edit of a DF3.1 line;
   appending optional FIELDS after status.ts:77 is not. If DF3.4 needs a new state, it
   needs a ruling.
3. **`scripts/fleet.ts:2214` is `const rows = …`** — decorating with the approval join
   without any edit requires mutating elements in place; naming a new array means changing
   2214 or 2215 by one token.
4. **Do `approve`/`reject`/`attach` require `--driver`?** The doctrine (verbs.ts:16-28,
   `assertDriverChosen` fleet.ts:274-280) is that every verb does, with `rank` as the ONE
   exception because it consumes no driver. If `attach` talks to a box it must require it;
   if `approve`/`reject` only touch records, `rank` is the precedent for omitting it — and
   omitting means also NOT calling `assertDriverChosen`.
5. **Flag naming.** `flagTypeConflicts` (module-load throw) forbids one name with two
   `valueType`s across verbs; the F6 test forbids any name matching
   `/admit|headroom|budget|ceiling|skip|force|bypass/i`.

---
---

# R3 ADDENDUM — second pass

The first pass (above) died before reporting. This pass re-read
`scripts/fleet.ts` and `src/fleet/status.ts` in full and answers the items the
first pass left open or did not cover: the exit-code declarations for the three
new verbs, the **definitive** `--driver` verdict (ambiguity #4 above), the
`verbs.ts` code-6 taxonomy NOTE, the `--dir` guard / store-construction
confirmation, and a sharper AC7 seam that supersedes §5's "decorate outside
status.ts" proposal.

Everything above stands unless explicitly corrected here. Two corrections:

- **§5 step 2's line reference.** `listWithAnomalies()` is called at
  **`status.ts:602`** (and again at `status.ts:546` inside `skippedRecordNames`).
  `status.ts:665` is the `recordsSkippedRow` push, not the call. The peer's
  substantive claim — `list()` throws on any anomaly, `listWithAnomalies()`
  carrying `{records, skipped}` is the correct call — is **confirmed**; only the
  line number was off.
- **§5's AC7 seam.** Decorating rows outside `status.ts` cannot cleanly satisfy
  AC7. See A4 below.

---

## A1. The `verbs.ts` code-6 taxonomy conflict — quoted, and resolved

The first pass established that `FleetError` cannot express 6. The conflict the
lead asked about is recorded at **`src/fleet/verbs.ts:72-78`**, verbatim:

```
      // NOTE, not resolved here: fleet.ts's own header defines 6 as "the verb
      // succeeded but a CLEANUP after it did not (ledger close / lock release)".
      // An unwritable ack is neither — it is the verb's own OUTPUT failing after
      // the billable work landed. The shared property that makes 6 right is that
      // it is NOT retryable (retrying dispatch provisions a second box), which
      // is the same reason it is not 1. Widening that definition is a taxonomy
      // change and belongs with the CLI's table, not here.
```

**It is already resolved in `fleet.ts`'s header** — the NOTE is stale relative to
`scripts/fleet.ts:15-19`, which explicitly enumerates output failure as a 6:

```
 * 6 is deliberately wider than "a cleanup failed": the ledger would not close,
 * the run lock would not release, the ack for a LIVE box could not be written,
 * a torn-down run's key cannot be attributed to revoke it, stdout refused part
 * of the output. The shape they share is "already done, still needs an
 * operator" — where 1 means "nothing landed, retrying is the right move".
```

**DF3.4 should adopt the header's definition and not re-litigate it.** The
header's phrase "already done, still needs an operator" already covers
approve/reject's landed-decision-but-unreportable case. If DF3.4 wants to close
the loose end cheaply, deleting the stale NOTE from `verbs.ts` is a comment-only
change — but that IS a DF3.1-owned line, so leave it and cite the header instead.

**Also confirmed: there is no exit 7.** `grep -rn "exit(7)\|code = 7\|exitCode: 7"`
over `scripts/fleet.ts` and `src/fleet/` returns nothing. The table is 0-6,
closed, plus 129/130/143 which `fleet.ts:21-25` puts outside it on purpose.

## A2. Exit codes `approve` / `reject` / `attach` should DECLARE

Registry constraints these satisfy: contains 0 and 2 (verbs.test.ts:314-316);
every value ∈ `DOCUMENTED_EXIT_CODES = [0,1,2,3,4,5,6]`.

### `approve` and `reject` → `[0, 1, 2, 4, 5, 6]`

Identical to `harvest`/`teardown`, and each code is forced by the table:

- **0** — the decision was recorded.
- **1** — the SUBSTRATE failed while writing. An ENOSPC/EIO/EDQUOT out of
  `store.set` is in `RETRYABLE_ERRNOS` (`fleet.ts:448`), so `asUsage` rethrows it
  raw and `report`'s generic branch returns 1 (`fleet.ts:539`). 1 = `transient` =
  "retry me" is the correct read: the record write genuinely did not land.
- **2** — usage/schema: a run id failing `assertFleetRunId`, an extra positional,
  a flag the registry does not declare (`fleet.ts:664-673`), no token attached to
  stdin, a malformed `--report-id`. Also the `--dir` guard (see A3).
- **4** — run-not-found, from the `getRecord` probe → `notFound` (`fleet.ts:2362-2385`).
- **5** — refused before mutating anything. Three guards land here:
  the run lock is held (`fleet.ts:2426`
  `if (e instanceof RunLockedError) throw new FleetError(5, e.code, e.message, e.remediation)`);
  `record-read-failed` re-typed from 1 to 5 (`fleet.ts:2380-2383`); and the two
  DF3.4-specific guards — the approval is not in `awaiting-approval` state, and
  the approver token does not match.
  **5, not 2, for a token mismatch.** Both classify `logic` (non-retryable) in
  `logVerb`, so retry semantics are identical — the difference is the envelope.
  `usageError`'s default remediation is `HELP`, the flag list, and the flag list
  is not the remediation for a bad token; this is the same argument `asUsage`
  makes at `fleet.ts:436-438` ("the flag list is not the remediation for
  ENOSPC"). 5's declared contract — "refused before provisioning (payload code
  says which guard fired)", nothing mutated — is exactly a rejected token, and it
  lets the payload carry `code: "approver-token-mismatch"` for automation.
- **6** — the decision LANDED and something after it did not: the run lock would
  not release (`cleanupFailed()`, `fleet.ts:2629-2631`), or the confirmation line
  would not print (`reportCompletion(...) ? 0 : 6`, plus `finish`'s
  `outputIncomplete` fold at `fleet.ts:1264`). **Mandatory** for any verb that
  both mutates and prints.
- **No 3.** 3 is the setup gate's, and it is dispatch-only — the only sites are
  `dispatch.ts:2580`, `:2596`, `:2680`, all `refuse(3, "setup-gate-invalid" |
  "setup-gate-failed", …)`.

### `attach` → `[0, 1, 2, 4, 5, 6]`

- **0 / 2 / 4** as above.
- **1** — the driver could not be listed or the box could not be reached. A
  substrate failure IS retryable; this is `status`'s `listUnavailable → 1`
  reasoning (`fleet.ts:2216-2231`) applied one verb over.
- **5** — refused before acting: the run is closed, has no `vmName`, or exposes
  no `httpsUrl`/port to attach to. Nothing was mutated in any of those cases.
- **6** — **mandatory even though attach mutates nothing.** `finish` folds an
  EAGAIN-refused stdout into 6 for *every* verb that would otherwise return 0
  (`fleet.ts:1264` `code === 0 && outputIncomplete ? 6 : code`). This is exactly
  why `rank` declares 6 despite provisioning nothing — `verbs.ts:170-174`:
  ```
      // 6 = the ranking LANDED (record read, scores computed, rankedAt stamped)
      // and the result line would not print — the shared `finish` folds an
      // EAGAIN-refused stdout into 6 exactly as it does for dispatch/fanout.
  ```
  Any new verb that prints and can return 0 MUST declare 6, or DF3.5's
  skill-contract test sees an undeclared code.

**Recommendation on the run lock for `attach`: do not take one.** `attach`
mutates nothing, and holding `<runsDir>/<runId>.lock` for the duration of a
session blocks every later harvest/teardown of that run — `RunLockedError`'s
remediation (`run-lock.ts:60-62`) would tell the operator to "wait for that
invocation to finish", for an invocation that may never finish. If `attach` is
one-shot (prints connection details and exits) the question is moot; **not
established** which it is — I found no DF3.4 spec file under
`_bmad-output/workflow-state/qds-dev/df3-4/`.

## A3. `scripts/fleet.ts:334-349` — the `--dir` guard, and both peer claims CONFIRMED

### The guard, verbatim (`fleet.ts:334-350`)

```ts
function assertRecordsDirUsable(dir: string | undefined, injected: RunRecordStore | undefined): void {
  if (dir === undefined || injected !== undefined) return;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch (e) {
    // `bounded`: `--dir $(head -c 200000 /dev/urandom)` is refused, but the
    // refusal must not echo all of what the operator typed (round 10 — every
    // argv-derived echo in an envelope goes through the same cap as a log
    // field; redact-first is bounded's own order).
    throw usageError(
      `--dir ${bounded(dir)} does not exist: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
      "point --dir at the records directory the run was dispatched with — this verb never creates one",
    );
  }
  if (!st.isDirectory()) throw usageError(`--dir ${bounded(dir)} is not a directory`, "point --dir at the records directory");
}
```

Exit **2, not 4** — `fleet.ts:324-327`: "4 is 'that RUN does not exist', which
presumes a records directory to have looked in; a `--dir` that is not there is
the invocation being wrong". Skipped for an injected store; the DEFAULT dir is
deliberately never checked (bootstrap).

### Claim (i): `fleet status` builds a READ-ONLY store when `--dir` is given — CONFIRMED

`scripts/fleet.ts:2212`:

```ts
      const store = deps?.store ?? asUsage(() => new RunRecordStore({ ...storeOpts, create: dir === undefined, requestId }));
```

reasoning at `fleet.ts:2202-2211`:

```
      // `create: dir === undefined`. status only ever READS (statusAll/statusRun
      // call `get` and `list`), and a read-mode store skips the mkdir AND the
      // chmod — so `fleet status --dir /srv/existing` stops re-permissioning an
      // operator's directory to 0700 just to look at it. The DEFAULT directory
      // keeps its writable store … harvest/teardown deliberately do NOT do this
```

### Claim (ii): a `create: false` store cannot write — CONFIRMED

`src/providers/run-record.ts:857-871`:

```ts
  private assertWritable(): void {
    if (this.writable) return;
    throw new Error(
      `run record store for ${this.dir} was opened read-only (create: false); construct it without create: false to write`,
    );
  }
```

set at `run-record.ts:810` `this.writable = o.create ?? true;`, short-circuiting
to `assertReadable()` at `811-814` (which stats only — never creates, never
re-permissions).

### Claim (iii): a WRITABLE store mkdirs + chmods 0700 — CONFIRMED, and does MORE

`run-record.ts:815-824`:

```ts
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is ignored when the directory already exists, and masked by
    // umask when it does not — set it explicitly, then verify (INV-5).
    chmodSync(this.dir, 0o700);
    const dirMode = statSync(this.dir).mode & 0o777;
    if (dirMode !== 0o700) {
      throw new Error(`run records dir ${this.dir} is mode 0${dirMode.toString(8)}, not 0700`);
    }
    this.assertExclusiveCreateSupported();
    this.cleanStaleTemps();
```

Note the last two lines: a writable store also probes O_EXCL/`link(2)` and
**sweeps stale temps**. Three side effects a refused invocation must not cause,
not one.

### The four store-construction sites, and the pattern approve/reject must copy

| Site | Construction | Purpose |
|---|---|---|
| `fleet.ts:1578-1585` | `new RunRecordStore({ ...storeOpts, requestId })` else `unusedStore(...)` | dispatch: writable, only for a brief that can mint |
| `fleet.ts:2212` | `new RunRecordStore({ ...storeOpts, create: dir === undefined, requestId })` | status: read-only for a named `--dir` |
| `fleet.ts:2349-2358` | `new RunRecordStore({ ...storeOpts, ...(dir === undefined ? {} : { create: false }), requestId })` | harvest/teardown: the read-mode **probe** store |
| `fleet.ts:2402-2406` | `const writable = asUsage(() => new RunRecordStore({ ...storeOpts, requestId })); verbStore = writable; store = writable;` | harvest/teardown: the writable store, built ONLY after the record probe passed |

**`approve`/`reject` must copy the harvest/teardown TWO-STORE pattern
(`fleet.ts:2337-2406`), not status's single read-only store**, in this order:

1. `assertFleetRunId(runIdArg)` — RAW, not `bounded` (`fleet.ts:2319-2327`:
   the assert owns the bound; capping first produces two contradicting lengths).
2. `assertRecordsDirUsable(dir, deps?.store)` — **before** any store is built.
3. build the `create: false` probe store for a named `--dir`.
4. `getRecord({ store }, runIdArg)` → `notFound(e)`: exit 4 for `no-record`,
   exit 5 for `record-read-failed`.
5. **only now** build the writable store.
6. `acquireRunLock(store.dir, runIdArg, "fleet approve")`; `RunLockedError` →
   `FleetError(5, …)`.
7. write `extensions.approval`.
8. `reportCompletion(...)`; release in the `finally` with `cleanupFailed()`.

The rationale, verbatim (`fleet.ts:2338-2344`):

```
    // Round 11 (auditor F3 residual): the constructor used to be built WRITABLE
    // unconditionally, so `fleet teardown <typo> --dir /shared/existing` chmod'd
    // that operator-named directory to 0700 (and swept its stale temps) before
    // the exit-4 probe could refuse — mutating the thing a refused invocation
    // promised it had not touched.
```

**approve/reject do NOT need the destructive mark.**
`markRunLockDestructive`/`clearRunLockDestructive` (`run-lock.ts:356-372`) and
the whole `destructiveInFlight` apparatus (`fleet.ts:2279-2298`, `2651-2728`)
exist for the window where a box may be half-destroyed. A single record write has
no half-state a later invocation could inherit. Plain acquire/release +
`cleanupFailed()` is correct and is the smaller diff.

**One enabling fact:** extensions stay writable after a record is closed —
`run-record.ts:1226-1228`:

```
      if (key === "extensions") {
        // `extensions` stays writable after close: closure freezes the run's own
```

which is what makes approving a run whose box was already torn down possible.

**The `approval` namespace is ALREADY REGISTERED** in
`EXTENSION_NAMESPACES` (`src/providers/run-record.ts`), naming DF3.4 as the owner
of the decide side:

```ts
  approval: {
    schemaVersion: 1,
    fields: {
      state: "string", proposal: "string", reportId: "string", headSha: "string",
      requestedAt: "string", supersededReportId: "string", approverId: "string",
      decidedAt: "string", reason: "string",
    },
  },
```

Its docstring: *"States: `pausing` (created before teardown, not yet promoted),
`awaiting-approval`, then terminal `approved` / `rejected` / `timed-out`. DF3.4
owns the decide side and may extend these fields."* The namespace is **FLAT** —
`ExtensionEntry` fields are typed `string | number` (`run-record.ts:115-118`), so
no nested objects and no arrays. There is **no `tokenHash` field**; persisting one
means extending `EXTENSION_NAMESPACES`, which is R1's territory — **not
established** whether R1 has planned it.

## A4. AC7 — the exact interception, superseding §5's decorator proposal

### Where `boxMissing` is decided — one line

`src/fleet/status.ts:426`, the terminal return of `rowForRecord`:

```ts
  return { ...base, state: box === undefined ? "boxMissing" : "live" };
```

Reached only when `rec.closedAt === undefined` (else 407-420) and
`boxes !== null` (else 424). Both entry points route through it —
`statusAll:656` and `statusRun:801` — which is why ONE insertion covers both.

### The seam: insert between `status.ts:420` and `status.ts:422`

i.e. after the `}` closing the `closed` branch and before the
`// No list ⇒ no evidence` comment. This position:

- runs AFTER `base` is built (`status.ts:380-403`), so the row keeps
  `requestId`/`vmName`/`createdAt`/spend/limit;
- takes precedence over BOTH `boxUnknown` (424) and `boxMissing`/`live` (426);
- does **not** override `closed` (407-420) — deliberate: a closed record over a
  live box is the still-billing case (`StatusRow.boxAlive`, `status.ts:44-53`)
  and must stay visible;
- **inserts lines only. It edits none.**

Shape (illustrative — R2 owns the predicate):

```ts
  // DF3.4 AC7 (additive): a run paused at the approval gate has NO box BY
  // DESIGN — the pause runs teardown before it promotes the record — so
  // boxMissing/boxUnknown is a lie about a run behaving exactly as intended.
  // A LIVE box still wins: unattributed spend outranks the pause, which is the
  // same over-report-never-under-report doctrine `isOwnedVm` states.
  if (box === undefined && isAwaitingApproval(rec)) {
    return { ...base, state: "awaiting-approval", ...approvalFields(rec) };
  }
```

**Why not §5's "decorate the rows outside status.ts".** A post-hoc decorator in
`scripts/fleet.ts` would have to rewrite `state` from `boxMissing` to
`awaiting-approval` after the fact, which means the decision logic lives in the
CLI while the state machine lives in `status.ts` — and `statusRun`'s row returns
through a different path than `statusAll`'s, so the decorator has to be applied
at two call sites (`fleet.ts:2214`) or duplicated. §5 also flagged that
`const rows` at `fleet.ts:2214` makes even that non-additive. The single
insertion in `rowForRecord` is smaller, covers both entry points, and puts the
branch where every other state verdict already lives.

### The ONE unavoidable edit to a DF3.1-owned line

`StatusRow.state`'s union at **`status.ts:32`** must gain `"awaiting-approval"`.
There is no additive way around a TypeScript string-literal union, and §5's
fallback ("carry it in a new optional field instead") does not satisfy AC7 as
written — AC7 says the run must *report* `awaiting-approval`, *never*
`boxMissing`, and a row whose `state` still reads `boxMissing` with an extra
field beside it has not done that.

It is a one-token widening that changes no existing behaviour, and it has
precedent: the same union already grew past AC4's five run states to absorb the
two fleet-level rows. **Recommendation: take the waiver, flag it in the PR
description, and do not build a parallel type to route around it** — a second
union that must be kept in sync with the first is strictly worse than one token.

### (b) The lazy expiry sweep — a REAL conflict the story must resolve

`fleet status` builds a **read-only** store when `--dir` is given
(`fleet.ts:2212`), and a `create: false` store throws on every write
(`run-record.ts:857-871`). **So a sweep that PERSISTS
`awaiting-approval → timed-out` cannot run inside `fleet status` on the `--dir`
path at all.** Three options:

1. **(recommended) Derive expiry in status; persist it in approve/reject.**
   Status reports `timed-out` when `requestedAt + TTL < now` without writing
   anything; `approve`/`reject` — which hold writable stores AND the run lock —
   do the authoritative persisted promotion. Keeps `fleet.ts:2212` untouched,
   keeps status's contract (`status.ts:693`: "Mutates NOTHING when not found —
   the driver is read, never written"), needs no second store, and uses the same
   inserted block as (a). The consequence to document: two operators see
   `timed-out` before any record says so. That is what "lazy expiry" means and it
   is fine for a read verb.
2. Give status a writable store — **reintroduces** the exact regression DF3.1
   removed in round 11 (chmod'ing an operator's `--dir` to 0700 just to look at
   it). Do not.
3. Build a second writable store on demand — two constructions plus a probe,
   which `fleet.ts:2208-2211` explicitly rejects as a design.

§5's option 2 ("inside the new approval store's read path, so every reader
sweeps") is only viable if that read path never writes on the status path — i.e.
it collapses into option 1. Worth confirming with R1.

## A5. Definitive verdict on `--driver` (resolves ambiguity #4)

### `assertDriverChosen`, verbatim (`scripts/fleet.ts:267-280`)

```ts
/**
 * NO verb defaults to a driver. `fleet teardown <id>` with no --driver used to
 * "destroy" a FAKE box, print `torn down`, exit 0 and close the record while
 * the real box kept billing; `fleet dispatch` minted a fake run a CI script
 * believed it had provisioned. An injected driver (tests, embedders) is an
 * explicit choice already, so it satisfies the requirement without the flag.
 */
function assertDriverChosen(verb: string, driverName: string | undefined, injected: ProviderDriver | undefined): void {
  if (driverName !== undefined || injected !== undefined) return;
  throw usageError(
    `${verb} requires --driver <name>`,
    "pass --driver fake for a local dry run, or the provider driver to act on the real fleet",
  );
}
```

### Callers — complete list

| Site | Verb |
|---|---|
| `scripts/fleet.ts:1522` | `dispatch` |
| `scripts/fleet.ts:1729` | `fanout` |
| `scripts/fleet.ts:2199` | `status` |
| `scripts/fleet.ts:2331` | `harvest` **and** `teardown` (shared tail, `assertDriverChosen(verb, …)`) |
| — | `rank` deliberately absent (`fleet.ts:2056-2058`) |

The exemption, verbatim (`fleet.ts:2056-2058`):

```
      // NO assertDriverChosen here BY DESIGN (the registry gives rank no
      // --driver): rank reads fan-out records and step output, never a box, so
      // the B8 fake-driver hazard cannot arise.
```

and `verbs.ts:25-28`:

```
 * DF3.2's ONE exception proves the rule: `rank` takes no `--driver` because no
 * driver exists to choose — it reads fan-out records and step output only, so
 * requiring a flag nothing consumes would train operators to paste magic
 * values. It is also why rank is absent from assertDriverChosen's callers.
```

### VERDICT

**`approve` / `reject`: NO `--driver`. Definitive.** The hazard the guard exists
to prevent (B8 — a verb silently acting on a FAKE box while the real one bills)
is *structurally unreachable* for a verb that reads and writes one record's
`extensions.approval` namespace and touches no box and no key. `rank` is the
precedent and the reasoning transfers word for word. Concretely:

- do **not** declare `--driver` in their registry entries at all — `rank`'s
  shape, where the flag is absent, not `required: false`. Declaring it
  `required: false` would be worse than either: `verbs.ts:16-21` says a
  `required: false` `--driver` is "how DF3.5 would generate a skill whose every
  call exits 2";
- do **not** call `assertDriverChosen`;
- **add a comment at the call-free site mirroring `fleet.ts:2056-2058`.** The
  absence is exactly the kind of thing a later reviewer "fixes", and `rank` had
  to carry the same comment for the same reason.

**The one condition that flips this:** if `approve` ever *resumes* or
*re-provisions* the run rather than only recording the decision, it touches a box
and the B8 hazard is live again. Per the story framing, DF3.4's approve is a
record operation.

**`attach`: YES, `--driver` required — confirmed.** Attach resolves a live box;
with no `--driver` it resolves against the fake driver and prints connection
details for a box that does not exist while the real one bills — literally the
teardown regression in `assertDriverChosen`'s own docstring. Call it **at the top
of the verb, before any store construction**, matching `fleet.ts:2331`'s
placement and its stated reason (`fleet.ts:2329-2330`): "Before the lock and
before the record read: a refusal here has mutated nothing, so there is no lock
to release and no box left half-torn-down."

## A6. The stdin guard — copy the predicate, INVERT the branch

§6 above has the guard and the doctrine. The point that must not be lost, because
getting it backwards is a functional bug:

- `assertOneBriefSource` answers *"was a **second** source attached?"* — chardev
  or socket ⇒ **nothing attached** ⇒ it is safe to use `--brief`.
- DF3.4's approve/reject ask *"was a **token** attached?"* — the **same set**
  means the **opposite verdict**: chardev (a tty, `/dev/null` under
  cron/systemd/containers) or socket (what fd 0 is under any Node/Bun parent
  spawning with `stdio: "pipe"` — the parent's unattended default) or EBADF ⇒
  **no token was attached** ⇒ refuse exit 2. A fifo or a regular file ⇒ the
  caller deliberately attached something ⇒ read it.

Same closed set, same classification, opposite branch. Write it as its own
named function so the two verdicts are visibly distinct, and keep the closed-set
posture (an stdio type nobody has thought of ⇒ refused).

Use the `fstat`-based predicate, **not** `process.stdin.isTTY`. `isTTY` catches
only the interactive case; `fleet.ts:842-845` is explicit that a CLI run from
cron, systemd or a container has stdin on `/dev/null` and no tty.

Reader: reuse `readCappedStdin`'s *shape* (cap enforced AS IT STREAMS, every read
racing a stall window, `reader.cancel()` on refusal) but **not its constants** —
`MAX_BRIEF_BYTES` is 64 KiB, absurd for a token, and `STDIN_BRIEF_TIMEOUT_MS` is
120 s. A dedicated small byte cap and a much shorter stall window are correct.

One more enforcement point worth naming: **the registry itself blocks a
`--token` flag.** `parseArgv`'s per-verb allow-list (`fleet.ts:664-673`) refuses
any flag the entry does not declare, so `fleet approve <id> --token sk-…` exits 2
before reaching any code path. That is the right backstop — but the token has
*already* landed in argv and therefore in `ps` output by then, so the refusal is
not a substitute for documenting stdin as the only channel.

## A7. Token handling — do not rely on redaction

`redactSecrets` blanks ≥40-char opaque tokens and known prefixes; a **short**
approver token passes through it untouched. So:

- the token must never reach ANY sink — not the envelope, not a log field, not a
  status row, not even redacted or as a prefix;
- what MAY be logged is a derived non-secret: the digest, or nothing at all;
- `approverId` / `decidedAt` / `reason` / `proposal` read back off
  `extensions.approval` and rendered into a row or a sentence are **store-supplied
  text** and need `sanitizeOptional(value, MAX)` at the producer — the same
  treatment `requestId` and `createdAt` get at `status.ts:385` and `status.ts:400`.
  A raw newline in `reason` forges an operator line exactly as `safeName`'s
  docstring describes (`status.ts:165-175`);
- `reject --reason "…"` is argv on the way IN ⇒ `bounded()` before it reaches a
  log field; it becomes store-supplied on the way OUT ⇒ `sanitizeLabel` there.
  Both, at both boundaries — they are different sinks with different owners
  (`fleet.ts:2325-2327` makes exactly this distinction for the run id).

## A8. Correction to §8's requestId guidance for the new verbs

`logVerb`'s `requestId` is the **invocation's** id, not the run's —
`fleet.ts:1690-1695` is explicit that dispatch emits its own resolved/ready/
refused lines for the RUN while the CC-9 line is the invocation's.

So for approve/reject/attach: mint with `newRequestId()` like the other id-taking
verbs (`fleet.ts:2187`), and **additionally** emit the run's own
`rec.requestId` (`RunRecord.requestId`, `run-record.ts:108`, INV-4-bis) as a
separate field so the approval joins the run's stream. Do **not** substitute the
record's id for `logVerb`'s — adding a field is additive; substituting one
changes the join key's meaning.

On sub-timings: `logVerb` emits no `timings` key today, and adding one means
changing `finish`/`logVerb`'s signature — DF3.1-owned. The lazy alternative,
already precedented, is a **second, separate** log line from the new verb block
(`fanout-primitive.ts:836-857`'s `armLine`/`raceEvent`/`emitLine` shape, quoted
in §8), carrying `approval_check_ms` / `expiry_sweep_ms` / `box_resolve_ms` as
snake_case siblings. Every such `log()` call must be wrapped in try/catch — a
raising sink must never replace the caller's real outcome.

The nesting rule for a `timings` object, verbatim (`dispatch.ts:995-998`):

```
        // Nested, not spread: `timings` is a `Record<string, number>`, so a
        // spread lets a future `phase("status", …)` overwrite `status`,
        // `runId` or `exitStatus` with a number and no compile error.
        timings: { ...timings },
```

## A9. Still not established

- Whether R1 plans a `tokenHash` field on `EXTENSION_NAMESPACES.approval` (no
  slot exists today).
- The exact "is this run awaiting approval" predicate — R2 owns the state
  machine. The A4 seam is agnostic to it.
- Whether `attach` is interactive or one-shot. The no-lock recommendation in A2
  assumes it does not hold the run lock.
- Whether DF3.4's steering transport is in-process or over a socket, which sets
  how much `escapeText` surface exists. R4 owns it.
