# FIX-SRC-FLEET

PR #184 · branch `feature/df2.10` · review round 4 · fixer scope: `src/fleet/fanout-primitive.ts`,
`src/providers/credentials.ts`, `tests/fleet/patterns.test.ts`, `tests/providers/credentials.test.ts`.

No commits, no staging, no push. Nothing outside the four owned files was edited.

## Patched

| ID | File:line | What changed | Why | gitnexus blast radius |
|----|-----------|--------------|-----|-----------------------|
| D1 | `src/fleet/fanout-primitive.ts:70-85` | New exported `PROBE_SKIP_TICKS_LIMIT = 6` with its own rationale block. | A skip needed a bound, but not MARKER_UNUSABLE_TICKS_LIMIT's bound: that constant's doc reasons from temp+rename making a parse failure PERMANENT, which is false of transport. Reusing it would have made its own doc a lie. | (new constant — no upstream) |
| D1 | `src/fleet/fanout-primitive.ts:722-748` (`runRace`) | `verdict === "skip"` now has its own consecutive counter (`skipTicks`) and abandons the arm as `armUnknown` at the limit, logging `event:"probe-unanswered"`. Both the `absent` and `unusable` branches clear the skip streak (a tick that reached the box proves the box answers); only `absent` clears the corruption streak, so the round-3 property is preserved. The armUnknown transition + its raceEvent were lifted into one local `giveUp` helper so both streaks abandon identically. | Confirmed real: `null` was written by neither `+1` nor `.delete`, so a permanently unreachable arm stayed `ready` forever and the race still ran to `DEFAULT_FANOUT_CEILING_MS` (1 h) with the fleet lock held. | **HIGH** — `runRace` upstream: 3 impacted, 1 direct, 3 processes (`fanout` src/fleet/fanout-primitive.ts, `runFanout` scripts/fleet.ts, `run` scripts/fleet.ts), modules Fleet (direct) + Scripts (indirect), epistemic `exact`. Warned: HIGH. |
| D1 | `src/fleet/fanout-primitive.ts:757-767, 808-815, 869-870` (`probeArm`) | Return type gains `"skip"`. The three no-evidence exits — non-clean `absent` (probeExit ≠ 1/undefined), `unreadable`, and the catch-all (timeout / any transport throw) — now return `"skip"` instead of `null`. `null` is left to exactly one caller-visible case: the settled-failed marker (`ok:false`), which decides the arm itself and stops polling it, so it must not be counted. Doc comment rewritten to describe what the code now does. | Same defect; this is the half that makes the counting possible. `if (verdict !== null) return verdict` is still the last branch, and `"skip"` is handled above it. | **LOW** — `probeArm` upstream: 3 impacted, 1 direct, 2 processes (`fanout`, `runFanout`), modules Fleet + Scripts, epistemic `exact`. (Its real radius is inherited through `runRace`, above — the DF3 race path.) |
| D2 | `src/fleet/fanout-primitive.ts:808` | `res.probeStderr` tail is now `JSON.stringify`'d, not raw-interpolated. | Confirmed. Box-controlled stderr into a logged `Error` message: `\n{"level":"info",…}` forges log records. `transport.ts:344` states the rule on the gate path. | (inside `probeArm`, above) |
| D2+ | `src/fleet/fanout-primitive.ts:814` | **Same fix applied to the sibling line the finding did not name** — the `unreadable` branch interpolated `res.stderr.trim().slice(0,200)` raw, identically box-controlled, on the identical logged path. | Root cause is one rule, not one line; a fix that left the second line raw would have left the forgery reachable through a failing `cat` instead of a failing `test -f`. One shared comment above both now states the rule. | (inside `probeArm`, above) |
| D3b | `src/providers/credentials.ts:361-383` (`mintRunKey`) | The `store.set` compensation path now logs the SUCCESSFUL `revokeAndVerify` too: `operation:"credential.mint_compensation"`, `status/outcome: "ok"`, `compensated: 1`, `keyHashPrefix`, and a real measured `mint_compensation_ms` (a new local `compStarted`). Same operation name and shape as the mint-timeout path's ok line (`credentials.ts:326-339`), so the two compensations aggregate as one. | Confirmed. Without it, a run whose live key was minted and immediately taken back reads in the log as "a live key was minted for it", forever — the mint line was the last word. Nothing else about the path changed: still best-effort, still rethrows the write failure as the reported cause. | **CRITICAL** — `mintRunKey` upstream: 9 impacted, 4 direct, 5 processes (`runCredentialLifecycle` src/providers/credentials.ts, `dispatch` src/fleet/dispatch.ts, `runDispatch` scripts/fleet.ts, `runCapHitDemo` + `main` scripts/cap-hit-demo.ts), modules Providers + Fleet + Scripts all direct, epistemic `exact`. **Warned: CRITICAL** — mitigated by the change being purely additive on an already-existing catch path: no signature change, no new outbound provider call, no change to the exception surface, no new branch. |
| D1 | `tests/fleet/patterns.test.ts:1268-1307` | New test: *"a box that NEVER answers is bounded: consecutive skips abandon the arm long before the ceiling"*. Both arms' presence probes exit 255 on every tick, forever. Asserts each vm is probed **exactly** `PROBE_SKIP_TICKS_LIMIT` times and no more, both arms end `armUnknown`, `winner === null`, wall clock < 5 s against a 10 s ceiling (unbounded, this run IS the 10 s ceiling), both boxes still exist and no `teardown.*` line was emitted (unknown ≠ loser), and exactly two `probe-unanswered` events name the abandonment as a dead box rather than as corruption. | The discriminator the finding asked for. It fails on round-3 code by three independent assertions (probe count, elapsed, event presence). | — |
| D3b | `tests/providers/credentials.test.ts:671-681` | Extended the existing *"a store write that fails AFTER the provider accepted the mint…"* test with the ok-line assertions (`outcome`, `runId`, `keyHashPrefix` present). Reused the test that already drives the exact path rather than adding a second one. | — | — |

## False positives

| ID | Why it does not hold, with evidence |
|----|-------------------------------------|
| **D3a** — "`redactSecrets` can be handed a non-string … `[object Object]` at best, a throw inside the catch at worst" | **Does not hold. This is the documented contract, and the suggested "fix" is the worse option.** `redactSecrets(text: unknown, keep?: string): string` (`src/providers/step-log.ts:225`) takes `unknown` **by design** and coerces internally through `asText` (`step-log.ts:196-203`), which is itself `try { return String(v) } catch { return "[unprintable]" }`. The whole body is additionally wrapped in `try/catch` returning `REDACTED` — with the rationale spelled out at `step-log.ts:263-269`: *"Fail SAFE, not fail open. Every caller is a catch block logging someone else's failure, so a throw escaping here would replace that failure with this function's own."* So the "throw inside the catch" cannot happen: neither a hostile `toString`, a `Symbol.toPrimitive`, nor a null-prototype value escapes. The `?? revErr` (not `?? String(revErr)`) idiom is explicitly mandated at `step-log.ts:383-386`: *"`?? e`, not `?? String(e)`: `redactSecrets` coerces (and `String` is itself throwable on a null-prototype value), so the whole message path … is normalized in exactly one place instead of at each of the four sinks."* `src/providers/fake-gate.ts:154-160` documents the same reasoning from the other side. The line the finding names (`credentials.ts:374`) is one of **three** identical sites — `:315` (mint-timeout compensation), `:374` (store-write compensation), `:678` (delivery compensation) — plus `:221`; coercing at any one of them would break the house rule and, per the cited comment, would introduce the throw the finding is worried about rather than remove it. `[object Object]` is also exactly what a `String(revErr)` coercion yields, so nothing is gained. **Not patched.** |

## Deviation text for the story fixer (D4/D5)

Verbatim, ready to paste into the story's Deviations section.

---

**Deviation 4 — `src/providers/credentials.ts` `mintRunKey`: compensation on a failed record write (DF2.3 code, not in Files to Modify).**

`mintRunKey` gained a compensation path on the `deps.store.set(runId, { keyHash })` failure branch: a
throwing store write now calls `revokeAndVerify(deps, res.hash)` before rethrowing the write failure as
the reported cause, and emits a `credential.mint_compensation` log event (`outcome: "error"` when the
revoke also fails, `outcome: "ok"` when it succeeds). The story states "no DF2.3 code is touched" and
`credentials.ts` is not in Files to Modify; this was not among the three recorded deviations.

It is justified and it stays: the "record the mint BEFORE judging the returned cap" ordering
(`credentials.ts:347-351`) protects every refusal that fires *after* `store.set`, but not `store.set`
itself. When that write throws, the key is LIVE at the provider and the run record — the only thing a
later `revokeRunKey` or `revokeQuietly` can read — was never written, so nothing downstream ever learns
the hash. The key survives the run spendable and unreachable: precisely the orphan the credential
lifecycle exists to prevent, and the one failure mode DF2.3's own INV-CRED invariants are written
against. The path mirrors the pre-existing mint-timeout compensation (`credentials.ts:289-344`) in shape,
operation name and best-effort semantics.

Behavioural surface changed, for the record: (a) new outbound provider traffic (DELETE + verify) on a
previously inert failure path — reached ONLY when `store.set` throws, i.e. a disk/record fault; (b) a new
log operation name, `credential.mint_compensation`, on this path (the name itself already existed on the
mint-timeout path, so no new sink or schema is introduced); (c) the exception surface is UNCHANGED — the
original store-write error is still what is thrown, and a failing compensation is swallowed and logged,
never substituted for it. Affected callers are every caller of `mintRunKey`, all of which reach it only
on the same failure: `runCredentialLifecycle` (`src/providers/credentials.ts:649`), `dispatch`
(`src/fleet/dispatch.ts`), `runDispatch` (`scripts/fleet.ts`), and `runCapHitDemo` / `main`
(`scripts/cap-hit-demo.ts`). gitnexus `impact({target:"mintRunKey", direction:"upstream"})`: 9 impacted
symbols, 4 direct, 5 affected processes, modules Providers + Fleet + Scripts all direct, risk CRITICAL.

Covered by `tests/providers/credentials.test.ts` — *"a store write that fails AFTER the provider accepted
the mint revokes the live key instead of orphaning it"*.

---

**Deviation 5 — `src/fleet/fanout-primitive.ts` `probeArm` and `src/providers/exedev/transport.ts`
`readBoxFile`: the round-2 deferral is no longer accurate.**

Round 2 recorded `probeArm` as DEFERRED — "Out of this PR's clusters; needs a fleet fix or issue". The
fix landed in this PR anyway, so that deferral text is false and must be replaced by this deviation. Two
behaviour changes ship to DF3's race path:

1. **Probe-exit classification and skip accounting (`probeArm` / `runRace`).** `readBoxFile` reports every
   non-zero presence probe as `{kind:"absent"}` and carries the probe's own exit. `probeArm` consulted
   neither, so a box answering 255 (ssh never connected) or 137 (SIGKILLed at the per-call budget) read as
   a CLEAN absence and reset the arm's corruption streak on every tick — the arm could never reach
   `MARKER_UNUSABLE_TICKS_LIMIT` and the race spun to the full `DEFAULT_FANOUT_CEILING_MS` (1 h) with the
   fleet lock held, which is the exact spin that limit exists to bound. `probeArm` now returns a distinct
   `"skip"` verdict for every no-evidence tick (non-clean absence, unreadable `cat`, timeout/transport
   throw), and `runRace` counts consecutive skips against a new `PROBE_SKIP_TICKS_LIMIT = 6`, abandoning
   the arm as `armUnknown` with a `probe-unanswered` event. A skip still never resets a genuine corruption
   streak; a tick that reaches the box still clears the skip streak. Abandoned arms are `armUnknown`, so
   they are never torn down on a guess (fail-safe for the box, INV-5 preserved). Covered by
   `tests/fleet/patterns.test.ts` — the ssh-255 discriminator test and the new
   *"a box that NEVER answers is bounded"* test.

2. **`readBoxFile` now prefers `driver.execTimed` when the driver exposes it** (`transport.ts:127-143`).
   `driver.exec` hard-codes `DEFAULT_EXEC_TIMEOUT_MS`, so `withTimeout` expiring only ABANDONED the ssh —
   the process kept running against the box for up to 120 s with its output discarded, past the very
   deadline the caller set. `execTimed` passes `deadlineMs` down to the spawn, so the budget KILLS the
   process. This is a real change in substrate-side process behaviour for every existing `readBoxFile`
   caller, not just the fan-out race: a probe that exceeds its budget now dies (and surfaces as exit 137)
   instead of lingering. `execTimed` is optional in the parameter type, so a structural fake exposing only
   `exec` still satisfies it and keeps the old abandon-only behaviour.

   Existing `readBoxFile` callers affected (full grep, `--include=*.ts`, node_modules excluded):
   - **Production (2, both import it directly from `transport.ts`; it is NOT re-exported by
     `src/providers/exedev/driver.ts`, `src/providers/driver.ts` or `src/providers/index.ts`, so this is
     the complete production surface):**
     - `src/fleet/fanout-primitive.ts:31` (import), call at `:761` inside `probeArm` — the DF3 race poller,
       one call per arm per poll tick.
     - `src/providers/exedev/setup-gate.ts:64` (import), call at `:507` — the DF2.10 image-marker read
       (`IMAGE_MARKER_PATH`) inside `setupGate`. Its comments at `:484-488` already document the
       `execTimed` routing and the 137-at-the-budget consequence, so that call site is aligned.
   - **Tests / fixtures (not callers of the production path, but they encode its shape):**
     - `tests/providers/exedev/read-box-file.test.ts` — the direct unit test; `:30` asserts the
       `execTimed`-preferred path is taken when available, `:52` covers the truncated-and-137 case.
     - `tests/providers/exedev/setup-gate.test.ts:866` — accounts for `readBoxFile`'s TWO seam calls
       (`test -f` then `cat`) in the gate's call ordering.
     - `tests/providers/exedev/fixtures/fake-exedev.ts:661-663, 725` — the fake models exactly those two
       execs and their double `shellQuote`; `:725` refuses an unsimulated verb touching
       `IMAGE_MARKER_PATH` (readBoxFile drift alarm).
     - `tests/fleet/patterns.test.ts:135, 1217` — the `RaceFakeDriver.probeExit` seam and the ssh-255 test
       both cite `readBoxFile`'s absent/probeExit contract.

   gitnexus `impact(direction:"upstream")` for the race path: `runRace` — 3 impacted, 1 direct, 3 affected
   processes (`fanout`, `runFanout`, `run`), risk **HIGH**; `probeArm` — 3 impacted, 1 direct, 2 affected
   processes (`fanout`, `runFanout`), risk LOW (its real radius is inherited through `runRace`).

---

## Gate output

**1. `bun test tests/fleet/`**

```
$ bun test tests/fleet/ > /tmp/pr184-r4/fleet-test.log 2>&1; echo "exit=$?"
exit=0

$ tr '\r' '\n' < /tmp/pr184-r4/fleet-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
(no matches — grep exit 1)

$ tail of the de-ANSI'd log:
 1054 pass
 24 todo
 0 fail
 7588 expect() calls
Ran 1078 tests across 33 files. [270.35s]
```

`find tests/fleet -name "*.test.ts"` = 33, of which `-name "*.live.test.ts"` = 19. All 33 files were
loaded (the run reports 33), and **no live test executed** — they are gated behind `QDS_E2E_LIVE` +
`QDS_E2E_TIER` (`liveGate(...)`, e.g. `tests/fleet/e2e/tier3-race.live.test.ts:4`), which was unset. The
lines in the log that look alarming (`[finally-destroy] DESTROY FAILED for e2e-leak-abc123`,
`run-record: log sink threw`, `steering inbox: skipped 1 message(s)`) are asserted-on stderr from the
harness's own negative-path tests, not failures.

Targeted re-run of the file I changed:

```
$ bun test tests/fleet/patterns.test.ts
 47 pass
 0 fail
```

**2. `bun test tests/providers/credentials.test.ts`**

```
bun test v1.4.0 (34cbb9a40)

 51 pass
 0 fail
 225 expect() calls
Ran 51 tests across 1 file. [2.90s]
```

**3. `bunx biome check` (my four files)**

```
Checked 4 files in 70ms. No fixes applied.
```

**4. `bunx tsc --noEmit`**

Zero errors in any file I touched (`grep -E "fanout-primitive|credentials|patterns.test"` over the output
returns nothing). 21 error lines total, all outside my scope and all in other fixers' territory:

```
tests/scripts/build-exedev-image.test.ts   12   (dockerfileArgDefault vs dockerfileArgDefaults, + keyof BuildIdInputs)
tests/scripts/exedev-bun-pin.test.ts        1   (same renamed export)
tests/fleet/e2e/tier3-reaper.live.test.ts   2
tests/fleet/e2e/tier2-fanout-bestofn.live.test.ts    1  (TS6133 unused 'evidencePath')
tests/fleet/e2e/tier2-dispatch-engine.live.test.ts   1  (TS6133 unused 'evidencePath')
```

The `dockerfileArgDefault` → `dockerfileArgDefaults` rename is a live break between `scripts/` and
`tests/scripts/` — flagging it for whoever owns those files.

## Behaviour changes other fixers must know about

1. **`probeArm`'s return type widened to `number | null | "unusable" | "absent" | "skip"`.** It is
   `async function`-private to `fanout-primitive.ts` (not exported), so nothing outside the file can
   break — but anyone editing `runRace`'s verdict switch must handle `"skip"` BEFORE the terminal
   `if (verdict !== null) return verdict`, or `"skip"` gets returned as a winner index.
2. **`null` from `probeArm` now means exactly one thing**: the settled-failed marker (`ok:false`), which
   has already reclassified the arm `armFailed` and removed it from polling. It is deliberately NOT
   counted by either streak. Do not reintroduce `return null` for a transport failure.
3. **New exported constant `PROBE_SKIP_TICKS_LIMIT = 6`** from `src/fleet/fanout-primitive.ts`. If anyone
   is mirroring fan-out caps elsewhere (`src/fleet/attach.ts:98` already mirrors
   `MARKER_UNUSABLE_TICKS_LIMIT` by comment), this is a second cap to be aware of. Attach's own polling was
   NOT changed.
4. **New race log event `event: "probe-unanswered"`** on `operation: "fleet.fanout.race"`, alongside the
   existing `marker-unusable`. Anything grepping race logs for abandonment reasons needs both. The live
   TIER-3 race test (`tests/fleet/e2e/tier3-race.live.test.ts:241`) currently keys on
   `race-probe-failed` / `race-probe-timeout` error codes — those are unchanged and still emitted per
   skipped tick, so it is unaffected, but whoever owns that file may want to assert the new terminal event.
5. **A permanently unreachable arm now ENDS the race early instead of running to the ceiling.** Any live
   or fake test that relied on "all arms dead ⇒ the run lasts `ceilingMs`" will now finish in
   ~6 poll intervals. `tests/fleet/patterns.test.ts`'s *"a hung exec skips its tick"* test (ceiling 1500 ms,
   per-call 25 ms) is one such: it still passes — its assertions are `>=` bounds and `armUnknown` — but it
   now terminates via the skip limit rather than the ceiling.
6. **Coupling to `readBoxFile` (`src/providers/exedev/transport.ts`, owned by another fixer): I depend on
   its signature and on `BoxFileRead`'s `probeExit`/`probeStderr` fields, and I did not edit it.**
   `probeArm` reads `res.probeExit` (`undefined` or `1` ⇒ clean absence; anything else ⇒ skip) and
   `res.probeStderr`. If those optional fields are removed or renamed, or if a non-clean probe stops being
   reported as `{kind:"absent"}`, the D1 bound silently reverts to "every absence is clean" and
   `tests/fleet/patterns.test.ts`'s ssh-255 test is the alarm. The `execTimed` preference inside
   `readBoxFile` is fine by me either way — it only makes the 137 case more likely, which is now counted.
7. **`src/providers/credentials.ts`**: the successful-compensation log line was added ONLY to the
   `store.set` path. The sibling `delivery_compensation` path (`credentials.ts:657-686`, inside
   `runCredentialLifecycle`) still logs only the FAILED compensation and has the identical gap. Left alone
   deliberately — out of this finding's scope, and it is DF2.3 code that this PR should not be widening
   further. Worth an issue.
