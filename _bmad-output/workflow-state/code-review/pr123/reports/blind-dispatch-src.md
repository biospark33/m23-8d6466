# Blind review — src/fleet/dispatch.ts (core dispatcher)

Reviewed from the unified diff alone, no repo context. Findings ordered by severity; line refs are to `src/fleet/dispatch.ts` (derived from the diff hunks).

---

**[HIGH] Non-string `ctxGate.teardownCommand` crashes `refuse()` itself, and the retry-refuse crashes again — raw untyped throw, total loss of AC4 evidence**
- `src/fleet/dispatch.ts:837` (payload tail of `refuse`), reached from the gate-failure call site at `src/fleet/dispatch.ts:2279`
- Trigger: an injected/decomposed gate (`deps.setupGate` is a documented seam; DF3.2 fan-out composes gates too) returns `{ ready: false, teardownCommand: 123 }` (or an object/array — anything truthy and non-string). The `!gate.ready` branch guards only `?? undefined`, so it calls `refuse(3, …)`. Inside `refuse`, `redact(ctxGate.teardownCommand)` invokes `text.replace(...)` on a non-string → TypeError thrown *from inside `refuse`*. The FleetError is never constructed; the TypeError is caught by the outer steps-6–10 catch, which calls `refuse(1, "dispatch-failed", …)` — and *that* call reads the same `ctxGate.teardownCommand` in its payload tail and throws the same TypeError again, this time out of the catch handler itself. Result: no dispatch-log entry, no structured line, no `runId`/`vmName` on anything — a bare CLI exit 1 with a stack trace. This is precisely the failure mode (seam TypeError → exit-1 downgrade → lost evidence) the file defends against at every other gate-field read (`Array.isArray` on `assertions`/`debugCommands`, object-shape guard on `gateResult`); this one read was missed, and because it sits in `refuse`'s choke point it poisons *every* refusal fired after `ctxGate` is set, including the fallback exit-1 conversion. A `typeof x === "string"` guard (mirroring `errorRemediation`'s pattern) fixes it at the choke point.

**[MEDIUM] `refuse()` payload rebuilds `debugCommands`/`teardownCommand` from the raw gate result, discarding the call site's sanitization — control-character forgery rides the payload, and non-array `debugCommands` ships as a scalar**
- `src/fleet/dispatch.ts:833` (`debugCommands: redactDeep(ctxGate.debugCommands)`)
- Trigger: gate returns `{ ready: false, debugCommands: "\nFLEET dispatch ok runId=fake" }`. The `!gate.ready` call site dutifully builds `Array.isArray`-checked, `escapeText`-mapped copies and uses them in its *remediation* — but the payload it hands `refuse` does not contain `debugCommands`, so `refuse`'s tail supplies them from `ctxGate` directly. `redactDeep` applies secret redaction only; `escapeText` (the control-char/newline guarantee the same comment block declares mandatory for "the debug/teardown COMMAND strings") is never applied on this path. The forged line reaches the CLI-printed payload and the dispatch-log JSON verbatim. Additionally, `redactDeep` on a truthy non-array (string) returns a *string* where every consumer expects `unknown[]` — the exact shape-lie the call site's `Array.isArray` guard exists to prevent, reintroduced one layer down. The sanitized locals at the call site should be threaded into the payload (or the same array/type guards applied inside `refuse`).

**[MEDIUM] Gate assertion *elements* are unguarded — a `null`/primitive entry throws out of `.find`/`.map`, downgrading exit-3 to exit-1 `dispatch-failed`**
- `src/fleet/dispatch.ts:2291` (`gateAssertions.find((a) => !a.ok)`), also `src/fleet/dispatch.ts:2309-2311` (`.map`)
- Trigger: seam returns `{ ready: false, assertions: [null] }` (or `["probe"]`). The array-ness of `assertions` is checked, but element shape is not: `!a.ok` on `null` throws TypeError, escaping the `!gate.ready` block to the outer catch → exit-1 `dispatch-failed` with a generic message. Every piece of assertion evidence the exit-3 refusal exists to carry (failedItem, assertionCode, notes, the record's `extensions.gate` write already committed) is severed from the operator-facing outcome — the identical downgrade the surrounding commentary documents as the motivation for the array guards two lines above. One `typeof a === "object" && a !== null` filter (or a `String(a.ok)`-style coercion) at slice time fixes it.

**[LOW] `recordExists` treats a `null` "absent" sentinel as "record exists" — every mint bricks as `run-id-unmintable`**
- `src/fleet/dispatch.ts:548` (`return store.get(runId) !== undefined;`)
- Trigger: a store implementation signalling absence by returning `null` (legal at a JS boundary; the docstring itself worries about `undefined`-sentinel stores). `null !== undefined` is `true`, so every id reports taken: self-mint retries 5 ids then refuses exit-1 `run-id-unmintable` blaming a "day's worth of ids"; an explicit `opts.runId` refuses exit-2 `run-id-in-use`. Dispatch is bricked against an empty run directory. `!== undefined && !== null` (or a falsy check) closes it.

**[LOW] Phantom port claim is permanent when an abandoned `expose` subsequently *fails* — the retraction exemption covers started-and-failed too**
- `src/fleet/dispatch.ts:2450` (`if (!portOpened && !(e instanceof FleetError && e.code === "dispatch-timeout"))`)
- Trigger: `store.set(ports:[port])` succeeds inside the thunk, `driver.expose` hangs past the deadline → `dispatch-timeout` → exemption keeps the claim (correct so far). The abandoned call then lands and *rejects* (`abandoned-step-failed` logs it, but nothing revisits the record). The port never opened, yet the record advertises `ports: [port]` until teardown — port-keyed reapers and `fleet status` act on a port the box does not have. The comment's coverage argument ("never-started ⇒ no claim written") addresses the other sub-case only; started-then-failed leaves the phantom standing. Needs the `abandoned-step-*` handler (or a follow-up) to retract the claim when the late result is a rejection.

**[LOW] EEXIST→`run-id-in-use` classification hinges on exact string equality of `error.path` and `store.path(runId)` — a representation mismatch misclassifies the race as exit-1 `provision-failed`**
- `src/fleet/dispatch.ts:1886` (`errno.path === deps.store.path(runId)`)
- Trigger: a store that opens records via a relative path (or normalizes separators differently than `store.path` returns) yields `error.path !== store.path(runId)` for a *genuine* run-id collision → falls to the `provision-failed` arm: exit 1, "retryable substrate condition", operator chases a substrate fault while the real cause is a duplicate id. The comment acknowledges the inverse residual (pathless provider EEXIST); this is the mirror case. Cheap hardening: compare `resolve()`d forms or basename-match.

**[LOW] `FleetError` arm of the create catch stamps this dispatch's `requestId` onto a record it may not own under the shared-runId race**
- `src/fleet/dispatch.ts:1840-1843` (`if (e instanceof FleetError) { stampCorrelation(); throw e; }`)
- Trigger: two dispatches share an explicit `opts.runId`; the loser's `store.create` is slow enough that `within("create")` fires its deadline *before* the EEXIST surfaces (abandon-not-cancel). The catch sees `FleetError` (the timeout) and stamps immediately — onto the *winner's* record under the same id — inverting the INV-4-bis join key exactly as the EEXIST arm below labors to avoid. Narrow (race-on-race), and the later EEXIST rejection hits the rejection handler (no stamp), but the merge-patch damage is already done. Gating the stamp on a post-timeout `recordExists` + ownership read, or deferring it to the abandoned-settlement handler, would close it.

**[LOW] Store-write failure for `httpsUrl` (between the `ports` claim and the URL write) leaves the record asserting a port with no locator**
- `src/fleet/dispatch.ts:2416` (`deps.store.set(runId, { httpsUrl: ctxHttpsUrl })`)
- Trigger: `expose` resolves with a usable URL, the `ports:[port]` write succeeded, then this write throws (transient EACCES/SQLITE_BUSY). `portOpened` is `true`, so the inner catch retains the claim; the outer catch converts to exit-1 `dispatch-failed`. Record now permanently reads `ports:[port]` with no `httpsUrl` — the exact "port without address" inconsistency the surrounding machinery exists to prevent, via the one write nobody retried. Best-effort retry of the URL write in the catch (before rethrow) would close it.

**[LOW] `deps.requestId` echoed via bare `JSON.stringify` without `escapeText` on the `invalid-request-id` path**
- `src/fleet/dispatch.ts:1148` (`deps.requestId ${JSON.stringify(deps.requestId)} is not a strict UUID v4`)
- Trigger: a caller passes `deps.requestId` containing newlines/terminal escapes → rides verbatim (post-`redact`, which is a secret filter, not an escaper) into stderr, the structured line, and the payload. Mitigated by the module's own stance that `DispatchDeps` is trusted caller configuration (same argument as `repoRoot`), and the value is bounded by nothing — hence LOW, but it is the one third-party-shaped interpolation in the file that skipped the `escapeText` treatment applied everywhere else.

---

### Checked and found sound (notable negatives)

- Timeout arithmetic (`MAX_TIMEOUT_MS` clamp, `remaining()` floor/non-finite fail-closed, per-step `within` pre-check + thunk-before-side-effect) is coherent end to end.
- The expose retraction matrix (never-started timeout / abandoned timeout / post-resolve failure / `expose-no-url`) is internally consistent apart from finding 5.
- Downward-only mint-ceiling clamp (`min(admitted, persisted)`) with over-mint alerted as `status:"error"` is correct; the `no-ceiling` guard's stranded reservation is documented and genuinely unreachable today.
- Ledger `close()` in `finally` correctly neither masks the gate outcome nor turns success into failure, and names the flush-lost overcommit risk.
- Collision loop (`MINT_RETRIES`), `ctxRunId` nulling on `run-id-unmintable`, and `ctxProvisionAttempted` gating of teardown advice eliminate the stale-teardown-command class.
- Secret handling: `redact` composing `redactSecrets`, URL-first ordering, `errorMessage`'s uncoerced fallback, and the fixed-message `key-delivery-failed` sink are all correctly layered; no plaintext-key path to any sink found in the visible logic.
- `$`-safe function replacer in `storeRunIdRefusal`, and the ≥40-char boundary between the splice and suffix strategies, match the documented `redactSecrets` floor.
