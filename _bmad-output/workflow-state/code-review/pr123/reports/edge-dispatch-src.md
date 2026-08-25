# Edge Case Hunt — src/fleet/dispatch.ts (PR123 chunk-engine.diff)

Reviewer: Edge Case Hunter (dispatch core). All line refs verified against the real
`src/fleet/dispatch.ts` (2517 lines), plus `cost-ledger.ts`, `credentials.ts`,
`step-log.ts`, `run-record.ts`, `driver.ts`, `quota.ts`, `manifest.ts`, `roster/schema.ts`,
`fake-gate.ts`, `setup-gate.ts`, `verbs.ts`, `scripts/fleet.ts`.

No CRITICAL or HIGH found. The pipeline's crash/compensation posture is unusually
defended; what remains is concurrency gaps the code itself documents as accepted,
TOCTOU residuals, and invariant overclaims.

---

**[MEDIUM] Roster size check is a fstat-snapshot TOCTOU — a concurrently appended roster.yaml defeats the 256 KiB bound and hangs dispatch in an unbounded sync read**
- `src/fleet/dispatch.ts:1404-1421` (`openSync` O_NONBLOCK → `fstatSync(fd)` → size check → `readFileSync(fd,"utf8")`)
- Trigger: hostile/compromised checkout path plants `roster.yaml`; another process appends gigabytes between `fstatSync` (line 1413 size test) and `readFileSync` (line 1421). The read slurps to EOF regardless of the snapshot size, is fully synchronous, and runs OUTSIDE every `within()` deadline — no timer can fire. Same wedge class the FIFO guard and `ROSTER_MAX_BYTES` were added for, surviving by volume-race instead of by type. `parseRoster(text, path)` takes pre-read content (`src/phase-engine/roster/schema.ts:202`) so it re-imposes no ceiling either.
- Fix shape: re-fstat the handle after the read and refuse if `bytesRead > ROSTER_MAX_BYTES`, or read capped (`read` with a length limit).

**[MEDIUM] Post-gate wall-clock expiry refuses a fully proven run with "tear the run down" — the exact re-spend hazard this file says it fixed for the no-port case**
- `src/fleet/dispatch.ts:2362` (`if (remaining() <= 0) throw timedOut("post-gate", { gateReady: true })`), remediation composed at `:913-935`
- Trigger: gate is the longest await; a box whose five probes finish at ~600 s returns `ready`, then the port branch samples an exhausted ceiling and refuses exit-1 with remediation `tear the run down: bun scripts/fleet.ts teardown <id>`. The run is byte-for-byte complete except expose/ack; the operator's natural teardown-and-retry destroys a gate-proven box and re-spends the admission — the precise failure the port-branch comment (lines ~2340-2352) describes eliminating for the `port === undefined` case. `gateReady:true` rides the payload but not the remediation text.
- Fix shape: when `step === "post-gate"`, remediation should distinguish "run is proven; inspect/ack manually before destroying" from the generic teardown advice.

**[MEDIUM] Fleet-ceiling admission is a lockless read — two concurrent dispatches both pass `checkHeadroom` and overshoot `maxVms`**
- `src/fleet/dispatch.ts:1542` + design note at `:1728-1753`; `src/providers/quota.ts:5` confirms "checkHeadroom is a READ, not a lock"
- Trigger: two dispatches enter step 5 within one `driver.list()` round trip while `liveVms === ceiling - 1`; both see `allowed: true`, both reach `driver.create`, ceiling exceeded by N-1. The ledger's orphan window closes the MONEY half of this race but explicitly not the BOX half. Documented in-code as deliberate (providers-layer fix owed to DF2.6); reported because it is a live double-provision interleaving today, bounded only by reaper pricing.
- Fix shape: quota-layer intent reservation mirroring `admitIssue`.

**[LOW] Loser of a shared-`opts.runId` race permanently holds a duplicate ceiling reservation until the winner tears down + grace cutoff**
- `src/fleet/dispatch.ts:1857-1866` (catch comment: "this layer cannot retire it"); retirement rule at `src/providers/cost-ledger.ts:1416-1434`
- Trigger: two concurrent dispatches pass the step-4 fast path with the same explicit id; loser gets exit-2 `run-id-in-use` but its `gate_admissions` row resolves against the WINNER's open record, so it counts against `(repoSlug, issueId)` headroom for the winner's entire lifetime plus `ADMISSION_SKEW_MARGIN_MS`. Fail-safe direction (under-admission, never overspend), and currently latent (no production caller passes `opts.runId` — `scripts/fleet.ts:1233` passes none), but repeated losers starve the issue's cap while the winner lives.

**[LOW] `storeRunIdRefusal`'s ≥40-char branch overclaims "no full-length copy anywhere" — hex-digest-shaped and fragmented argv echoes survive verbatim**
- `src/fleet/dispatch.ts:241-257`; exemption source `src/providers/step-log.ts:117`, `:151` (`HEX_DIGEST_RE`)
- Trigger A: operator pastes a ≥40-char lowercase-hex value (a git SHA, sha256) into the run-id position. `redactSecrets`' hex-digest exemption keeps the store's embedded echo intact AND `runIdSupplied` appends a second copy — contradicting the docstring's "leaving no full-length copy anywhere". Benign content class, broken stated invariant. Trigger B: a ≥40-char value with no contiguous 40-char `LONG_TOKEN_RE` run (spaces/unicode separators) survives every arm verbatim too.
- Fix shape: apply `runIdEcho` unconditionally instead of branching on the 40-char floor.

**[LOW] Gate seam result: truthy non-boolean `ready` passes the gate — the one seam field left undefended**
- `src/fleet/dispatch.ts:2238` (`if (!gate.ready)`); contrast the null/object guard at `:2227` and Array-ness guards at `:2284-2295`
- Trigger: injected `deps.setupGate` returns `{ ready: "no", ... }` (or `1`, or `"false"`): truthy garbage sails through as a PASS and the run proceeds to public exposure unproven, while every OTHER field of the same object is defended as `unknown`. Inconsistent with the module's own stated standard ("typed `unknown` on the way out of `within`"). DI-seam trust boundary keeps severity low.

**[LOW] Box-controlled `debugCommands`/`teardownCommand` reach the FleetError payload redacted but NOT control-char escaped**
- `src/fleet/dispatch.ts:838-845` (refuse payload spread: `redactDeep(ctxGate.debugCommands)`, `redact(ctxGate.teardownCommand)`); escapeText doctrine at `:474-480`
- Trigger: exedev gate builds these strings from box-side state; a `\nFLEET dispatch ok runId=fake` inside one reaches the payload with secrets stripped but newline forgery intact — while the SAME strings in the gate-failure call site's message/remediation get `escapeText` (`:2305`). Contained today because every sink serializes (`printError` JSON.stringify at `scripts/fleet.ts:327`, dispatch-log JSONL, structured log), but it violates the file's own "one implementation for third-party text" rule and breaks if any sink ever prints payload leaves raw.

**[LOW] Pathless EEXIST misclassifies provider box-name collisions as do-not-retry `run-id-in-use`**
- `src/fleet/dispatch.ts:1893-1910`
- Trigger: dir-box driver `mkdir` over a leftover box directory (reachable after an abandoned-create timeout) reports EEXIST with no `path` → exit-2 `logic`, remediation "omit runId for a fresh one", while the true state is this dispatch's own record + a retryable substrate condition; operator moves on, record stays OPEN with its reservation outstanding. Documented residual ("needs a typed provider error") — flagged so it isn't lost.

**[LOW] Malformed brief `requestId` is dropped-not-rejected: retries of the same brief mint a fresh correlation each time; stale-but-valid ids are honoured verbatim**
- `src/fleet/dispatch.ts:1135-1170` (drop rule), `src/phase-engine/issue-correlation.ts:148` (accept rule)
- Trigger: tier-1 agent retries a brief whose `requestId` has a typo → each attempt gets a NEW uuid, so AC4 dispatch-log rows for the failed attempts join to nothing the retry can find. Conversely a valid v4 id recycled from a prior run is accepted as-is (client-supplied correlation is the contract), joining a new run to old rows. Both are documented AC1 behavior; flagged as the operational cost of drop-not-reject across restarts/retries.

**[LOW] Abandoned-step remediation table omits `deliver`, `fill`, `clone`, `gate` — late landings of those steps get generic advice**
- `src/fleet/dispatch.ts:899-917` (`lateEffectRemediation` switch)
- Trigger: deadline fires during `clone`; the abandoned call lands afterward and repo material appears inside a billable box AFTER the operator was told the dispatch failed — the refusal's remediation names only teardown/status, never "a clone may still complete". `create`/`mint`/`expose`/`setPublic` got step-aware text precisely for this; the other four awaited steps did not.

**[LOW] `safeOrigin`'s 16-char host-label rule redacts legitimate origins; IPv6 hosts lose their whole address**
- `src/fleet/dispatch.ts:366-372`; `linkSafe` residual documented at `:434-449`
- Trigger: management URL host `boxes.us-west-2.exedev.internal` → label `us-west-2` survives but any single ≥16-char label (common first labels, punycode, full IPv6 as one label) collapses to `«redacted»`, leaving an origin the operator cannot identify. Cosmetic-vs-security tradeoff already argued in-file; noted for the record.

**[LOW] Caller-supplied relative `deps.dispatchLogPath` is used unresolved — cwd-dependent, the exact defect the default-path fix describes**
- `src/fleet/dispatch.ts:663-667`
- Trigger: `deps.dispatchLogPath = "dispatch-log.jsonl"` writes wherever the process started, while the computed default is explicitly `resolve()`d against `store.dir` (the comment at `:654-662` documents why cwd-dependence was the bug). One `resolve()` short of its own rule.

**[LOW] Non-monotonic clock seam: NTP step mid-provision aborts a healthy dispatch; negative durations logged**
- `src/fleet/dispatch.ts:873-876` (`remaining()`), ponytail note at `:859-863`
- Trigger: `deps.clock` default `Date.now()`; a backward step makes `left > timeoutMs` (harmless) but a forward step past the deadline refuses mid-provision and abandons a call that was succeeding. Also `refuse`'s `durationMs` goes negative on a backward step. Documented upgrade path (monotonic seam) — acknowledged, not new.

**[INFO] `FleetError.exitCode` admits 4 but nothing in dispatch emits it, and the dispatch verb table doesn't declare it**
- `src/fleet/dispatch.ts:136-146` (union includes 4); `src/fleet/verbs.ts:76` (`exitCodes: [0, 1, 2, 3, 5, 6]`)
- A future thrower reaching for the dead union member would emit a code off the verb's declared contract; `report()` (`scripts/fleet.ts:396`) passes any integer ≤6 straight through. Dead union member invites undocumented taxonomy drift. No current bug.

**[INFO] Verified non-findings (checked, sound)**
- Cap hand-off chain units: `capMicroUsd` → `microsToUsd` → `createKey(limitUsd)` → provider answer → `usdToMicros` round-trip (`credentials.ts:68-75,236-248,330-337`); over-mint clamped DOWNWARD-only via `Math.min` (`dispatch.ts:2086`), zero/negative/huge ceilings guarded safe-int>0 (`:1693-1716`).
- `repoUrl`↔`repoSlug` mismatch IS closed at schema level (`brief-schema.ts:415` `repoSlugOfUrl` refine) — clone target and billing identity cannot diverge.
- Manifest traversal: candidate realpath'd + beneath-root + O_NOFOLLOW in `manifest.ts:209-260,507-531`; absolute `manifestPath` outside `repoRoot` refused.
- Concurrent same-issue double-spend: ledger orphan window + skew margin (`cost-ledger.ts:167,190`) count in-flight reservations toward `reservedMicroUsd`.
- Crash between record→box→key: INV-1 ordering enforced inside `provisionAdmittedRun` (`driver.ts:456,563`); correlation stamped best-effort from create-failure and abandoned-success paths; teardown commands gated on `ctxProvisionAttempted` so pre-provision refusals never name another run's id.
- Expose retraction logic (`:2455-2472`): ports claim kept exactly for abandoned-timeout and post-resolve failures, retracted otherwise — traced all four interleavings, consistent.
- `existsSync`→O_NONBLOCK-open→fstat-handle FIFO/EISDIR guard (`:1404-1414`) is correct for planted FIFOs and directories.
