# fixer W1a — round 10, PR 123 (df3-1), src/fleet/dispatch.ts

Branch `feature/df3-2-fanout-best-of-n`. All fixes confined to
`src/fleet/dispatch.ts`. `tests/fleet/dispatch.test.ts` needed NO green-keeping —
all 113 tests pass on the source-only diff; the file is untouched.

GitNexus impact before edits: `impact({target:"dispatch", target_uid:
"Function:src/fleet/dispatch.ts:dispatch", direction:"upstream"})` → risk LOW,
4 impacted (direct callers: `fanout-primitive.ts:fanout`, `scripts/fleet.ts:run`).
No HIGH/CRITICAL warning. `detect_changes()` skipped: no commit occurs, and the
shared worktree carries parallel teammates' unstaged edits that would pollute
attribution.

## Dispositions

| ID | Verdict | Fix |
|----|---------|-----|
| DF1 | FIXED | Choke point in `refuse`'s payload tail (~line 849): `teardownCommand` now requires `typeof === "string"`, else the locally composed fallback (`errorRemediation`'s rule); non-strings can no longer reach `redact`'s `.replace`, so the gate refusal, the outer catch's fallback refuse, and all AC4 evidence survive a hostile gate result. |
| DF2 | FIXED | Same choke point: `debugCommands` requires `Array.isArray`, elements mapped through `redact(escapeText(cmd))`; `teardownCommand` gets `redact(escapeText(...))`. Newline forgery can no longer ride the payload/JSON log from either field; truthy non-array `debugCommands` falls back to the composed status command instead of shipping a scalar where `unknown[]` is expected. |
| DF3 | FIXED | Assertion slice (~line 2388): array elements filtered `(a): a is AssertionResult => a !== null && typeof a === "object"` at slice time, so `{assertions:[null]}` no longer throws out of `.find`/`.map` and downgrade exit-3 → exit-1 is closed. Non-object elements are dropped (evidence list shrinks by garbage entries only). |
| DF4 | FIXED | Strict boolean check inserted after the object-shape guard (~line 2326): `typeof gate.ready !== "boolean"` → exit-3 `setup-gate-invalid` with payload `{returned: <typeof>}`, mirroring the sibling refusal's shape and wording. `"no"`, `1`, etc. can no longer dispatch on an unproven gate. |
| DF5 | FIXED | `recordExists` (~line 563): returns `record !== undefined && record !== null` — a null absence-sentinel store no longer bricks every mint with `run-id-unmintable`. Doc comment updated to name both sentinels. |
| DF6 | FIXED | `within` gained optional 4th param `onAbandonedFailure(e)`, invoked (guarded, best-effort) in the abandoned rejection handler after `logAbandoned`; the expose call site passes a retractor writing `ports: []`. Abandoned-then-failed exposes no longer leave a phantom port claim forever; abandoned-then-SUCCEEDED still keeps it (the claim's original purpose). |
| DF7 | FIXED | EEXIST classification (~line 1971): compares `resolve(errno.path)` vs `resolve(store.path(runId))`, falling back to basename match; relative/symlink-differing representations no longer misclassify as exit-1 `provision-failed`. Pathless/null-path EEXIST arms unchanged. |
| DF9 | FIXED | Expose catch (~line 2563): when the post-expose URL write never landed but the URL is known and usable, one best-effort retry of `store.set(runId,{httpsUrl})` runs before rethrow. Guarded on `portOpened && !httpsUrlPersisted && non-blank string`, so `expose-no-url` never writes garbage over the absence it refuses for. Residual (accepted): if the retry also fails, the port-without-locator state persists, but vmName/port ride the payload and INV-5 keeps the box inspectable. |
| DF10 | FIXED | `invalid-request-id` message (~line 1215): `deps.requestId "${escapeText(deps.requestId)}"` replaces bare `JSON.stringify` — the last third-party-shaped interpolation without the escaper. Quotes kept so benign values read as before. |
| DF11 | FIXED | Roster block (~line 1484): content slurped into a local, then RE-FSTAT of the same handle plus `content.length > ROSTER_MAX_BYTES || after.size > ROSTER_MAX_BYTES` refusal. An append landing between fstat and read is caught before `parseRoster`; both figures named in the message. The slurp itself is inherently unbounded until a capped read exists (noted ceiling, not attempted — bigger change than the finding asks). |
| DF12 | FIXED | `timedOut` remediation chain (~line 967): new `step === "post-gate"` arm composes "the setup gate PASSED — this run is fully provisioned and proven; inspect it … and ack manually BEFORE destroying anything, then tear it down only if confirmed dead". Generic teardown arm unchanged for every other step. |
| DF15 | FIXED (variant) | `storeRunIdRefusal` (~line 246): the 40-char floor branch is GONE. Keyed instead on whether the store's echo SURVIVED REDACTION: splice `runIdEcho` over `redact(raw)` when the echo is still present (short ids AND hex-digest-exempt ones — the leak); keep redacted text + `runIdSupplied` suffix when the redactor already ate it. See BEHAVIOR CHANGES for why literal "splice pre-redact" was rejected. |
| DF16 | FIXED | `lateEffectRemediation` gains `clone` / `fill` / `deliver` / `gate` cases with step-aware ABANDONED text naming what may still land in the billable box. |
| DF18 | FIXED | `dispatchLog` (~line 672): `resolve()` applied over `deps.dispatchLogPath ?? computed-default` — caller-supplied relative paths get the same rule as the default. |

Deferred untouched per instructions: DF8, DF13, DF14, DF19. DF17 dismissed.

## BEHAVIOR CHANGES (operator-visible)

1. **DF15**: ≥40-char hex-digest run-id arguments (previously leaked verbatim by
   the digest-exempt arm) now come back bounded (`12-char head… (N chars)`)
   everywhere the store's echo appeared. Non-hex long ids and management URLs
   keep byte-for-byte their previous output — verified against the three pinned
   invalid-run-id tests, which pass unchanged.
2. **DF12**: a post-gate `dispatch-timeout` remediation no longer says "tear the
   run down"; it instructs inspect + manual ack first. Payload (`step`,
   `gateReady`) unchanged.
3. **DF2/DF1**: a gate supplying non-string `teardownCommand` or non-array
   `debugCommands` now yields the locally composed fallback commands in the
   payload instead of a crash (or a mistyped scalar). Valid gates unchanged.
4. **DF4**: gates returning truthy non-boolean `ready` move from silent pass
   (provisioned onward) to exit-3 `setup-gate-invalid`.
5. **DF16**: timeout refusals at clone/fill/deliver/gate carry step-specific
   ABANDONED remediation text instead of the generic teardown line.
6. **DF18**: a relative `deps.dispatchLogPath` appears resolved (absolute) in
   stderr fallback messages; write location unchanged (fs already resolved
   against cwd implicitly).
7. **DF6/DF9**: record states converge (no phantom ports on abandoned-failed
   expose; one retry to keep port+URL paired).

## Gates

| Command | Result |
|---------|--------|
| `bunx biome check src/fleet/dispatch.ts tests/fleet/dispatch.test.ts` | clean (no diagnostics) |
| `bunx tsc --noEmit` | clean for `src/fleet/dispatch.ts`; 1 unrelated error in `scripts/lib/run-lock.ts(405)` — another agent's in-flight edit, not mine, not touched |
| `bun test tests/fleet/dispatch.test.ts` | **113 pass, 0 fail** (816 expect calls) |
| `bun test tests/fleet/{fanout,verbs,rank,patterns}.test.ts` (bonus) | first run 3 fails (documented parallel-load flake territory), solo rerun **180 pass, 0 fail** |

No commits, no pushes.
