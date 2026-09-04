# F7 — `tests/fleet/e2e/live-harness.ts` + `live-harness.test.ts`

Branch `fix/df2.10-review-round-6`. Two files touched, nothing else. No commit, no push.

## Fixed

### P125 [HIGH] — the F16 provenance stamp was order-dependent module state
`live-harness.ts:148-193` (`effectiveImage` + new `setEffectiveImage`), `:214-249` (`writeEvidence`), `:118-125` (`preflight`).

- `let effectiveImage: Record<string, unknown> | undefined` — no more `{ note: "preflight did not run" }` default.
- New exported `setEffectiveImage(source, detail?)`. `preflight` now calls it instead of assigning inline.
- `writeEvidence` **refuses** (throws, before `mkdirSync`) when the stamp is unset, with a message naming all three remedies.
- The stamp is **consumed by every write attempt**, success or failure. This is the half that actually fixes the bug the finding describes: refusing-when-unset alone does not stop `tier1-registry-auth` inheriting the *previous file's* stamp in one `bun test` process. Consume-on-write makes a forgetting test fail closed identically whether it runs alone or after twenty others.
- Consumed on failure too (not only success) — otherwise a test whose evidence write blew up lends its provenance to the next test, which is P125 again. (Caught by the unit suite: the cyclic-payload test leaked its stamp into the next one on the first run.)

### P126 [HIGH] — cleanup problems reached the thrown error and the console unscrubbed
`live-harness.ts` `settleRun` (`:1000-1030`) and `teardownQuietly` (`:790-810`).

- `settleRun`: `const cleanup = problems.map(scrubText)` at the top; both renderings (the appended `[cleanup] …` block and the `the test body passed but cleanup did not: …` throw) use it, as does the stderr write.
- `teardownQuietly`: `scrubText` on the returned `error` in both the non-zero-exit and the throw arms, and on the `stderrTail` evidence field. Scrubbing at the source *and* at the render, deliberately — this is the one feeder carrying raw subprocess stderr.
- Pinned by `settleRun: cleanup problems are SCRUBBED before they reach the thrown message (P126)`, which puts an `sk-or-v1-…` in a teardown-shaped problem line and asserts it comes out `[REDACTED-KEY]` on both the green-body and red-body arms.

### P127 [HIGH] + P128 + R4 — new `fleetLeftovers` helper
`live-harness.ts:735-860`. See **API for wave 2** for the signature. One helper carrying all three fixes:

- **Bounded-retry poll** — 5 × 8 000 ms by default (the two tier-2 files' measured values), against the 25 s+ `r7-T-h1` destroy lag. Breaks on attempt 1 when nothing owned is listed, so a clean round pays nothing.
- **Report wide, act narrow (R4)** — only names the run **owns** reach `owned` (the failing verdict). Every other `e2e-`/`qds-` box goes to `strays`: an evidence entry plus a clearly-labelled `[final-ls] WARNING (does NOT fail this run)` stderr line. Strays are never destroyed — this run cannot prove it owns them, and killing a concurrent round's live box is worse than reporting it.
- **P128** — owned survivors are `destroyQuietly`'d **after** the poll and **before** the verdict, then re-listed; only what survives *that* is reported.
- A listing failure returns `owned: undefined`, which `fleetCleanupProblems` already renders as "an unmeasured fleet is never a clean one".
- Total: every listing is guarded, `destroyQuietly` is total, the stderr write is in its own `try`. Safe as a bare `await` in a `finally`.

### P129 [MED] — a payload key named `image` could erase the provenance stamp
`live-harness.ts:238-242`. Spread order inverted: `{ ...payload, writtenAt, image }`. Harness-owned fields win, matching the rule `teardownQuietly` already applies to `label`. Pinned by a unit test that passes `{ image: "a payload key that must NOT win" }` and reads the written file back.

### P130 [LOW] — a non-Error body failure dropped every cleanup problem to stderr
`live-harness.ts:1020-1024`. That arm now throws `new Error(\`${scrubText(String(failure))}\n[cleanup] …\`, { cause: failure })` — both facts in the thrown value, original reachable as `cause`. The Error arm is unchanged (see P131).

### P131 [LOW] — `settleRun` mutates the caught error in place — *fixed differently from the suggested remedy*
`live-harness.ts:1005-1019`. I did **not** adopt "throw a new Error with the original as `cause`" for the `Error` arm: the whole documented point of `settleRun` is that the **original object** is re-thrown so bun renders its own matcher output and the operator reads the regression, not a wrapper — and the existing `expect(threw).toBe(body)` pins it. Instead the two real risks the finding names are closed directly:

- **matcherResult desync** (a reporter re-rendering from `matcherResult` would never print the appended text): the `[cleanup] …` line is now written to **stderr on both arms**, unconditionally, so the leak never depends on how the reporter renders.
- **double-append**: guarded by `if (!failure.message.includes(line))`, asserted in the P126 test.

### P132 [LOW] — `keyLeakProblems` claimed a fallback revoke had been attempted when it had not
`live-harness.ts:940-975`. `attemptedRevoke` is tracked; with no `runIds`/`store` the message is now "…and NO record-backed fallback revoke was available (no runIds/store were passed), so nothing has been attempted" instead of "after the harness fallback revoke". The flag also lands in both `key-hash-delta-recheck` evidence entries.

### P133 [MED] — `live-harness.test.ts` spawned 60 s subprocesses and dirtied the repo evidence dir
`live-harness.test.ts:40-53`, `:181`, `:198`.

- `writeEvidence` now honours `QDS_E2E_EVIDENCE_DIR`; the unit file sets it to a `mkdtemp` dir at module load and `afterAll`-removes it. The fast suite no longer creates or writes into `_bmad-output/evidence/df3-e2e`.
- The two real `bun scripts/fleet.ts` refusal spawns keep their subprocess (that is the point of the test) but drop from `60_000` to a named `REFUSAL_SPAWN_CEILING_MS = 15_000`. The spawn exits in ~1 s; whole file now runs in 1.7 s.
- I did **not** rename the file or change the glob. `*.live.test.ts` vs `live-harness.test.ts` is a selection question that spans the runner config and the skill — out of my two files, and renaming would break every `import … from "./live-harness.ts"` reviewer reference mid-round. Flagging it rather than doing it.

### Rule 2 / P138 — `keyLeakProblems` made total
`live-harness.ts:880-900`. Body extracted to `keyLeakProblemsInner`; the exported wrapper try/catches into `["the key-leak check itself FAILED (…) — an unmeasured key population is never a clean one"]` plus a `key-hash-delta ok:false` evidence entry. Pinned by a test that throws **synchronously** out of `list` (the one shape the existing inner guard does not see as a rejection). This closes wave 2's P138 at the callee, so the seven tier-3–5 `finally` blocks need no per-site `try/catch`.

### tier35 [LOW] — `finally-revoke ok:false` folded into the verdict for all sites, not just T5.1
`live-harness.ts:706-733`. `fleetCleanupProblems` takes an optional third arg `evidence` and folds `phase === "finally-revoke" && ok === false` entries into a `revoke failures: <runId>: <error>` problem line. Two-arg callers are unaffected.

### tier35 [MED] — the `settleRun` contract, pinned
`live-harness.test.ts` — new `settleRun: the three-way contract …` test asserting exactly what the finding asked for: `settleRun(err, [])` throws `err`; `settleRun(undefined, ["x"])` throws; `settleRun(err, ["x"])` throws `err` with the problems attached; and `settleRun(undefined, [])` is the **only** returning case. Seven costly live tests deleted their `throw e` and rest entirely on this.

## API for wave 2

Everything below is **additive**. No existing signature changed, so nothing in the twelve live tests breaks by omission — `tsc --noEmit` reports zero errors under `tests/fleet/e2e/`. But two things you **must** wire up, and one you must not double-report.

### 1. `fleetLeftovers` — replaces all twelve single-shot `final-ls` sites (P127/P128/P135/R4)

```ts
export interface FleetLeftoverReport {
  owned: string[] | undefined; // this run's survivors → feed to fleetCleanupProblems
  strays: string[];            // everything else → already warned about, do NOT fail on it
}

export async function fleetLeftovers(
  driver: ExeDevDriver,
  owns: readonly string[] | ((name: string) => boolean),
  evidence: Record<string, unknown>[],
  opts?: { maxAttempts?: number; retryDelayMs?: number; prefixes?: readonly string[] },
): Promise<FleetLeftoverReport>;
```

Replace this (the line that appears at twelve sites):

```ts
try {
  const final = (await ctx.driver.list()).map((b) => b.name).filter((n) => n.startsWith("e2e-") || n.startsWith("qds-"));
  evidence.push({ phase: "final-ls", fleetBoxes: final });
  finalBoxes = final;
} catch (e) {
  evidence.push({ phase: "final-ls", ok: false, error: (e as Error).message });
}
```

with this:

```ts
finalBoxes = (await fleetLeftovers(ctx.driver, [vm], evidence)).owned;
```

Notes:
- **Drop the surrounding `try/catch`** — `fleetLeftovers` never throws, and it already pushes the `final-ls` / `final-ls-retry` / `finally-destroy` evidence entries. A listing failure comes back as `owned: undefined`, which `fleetCleanupProblems` renders as the "unmeasured fleet" problem. Keeping your own catch would swallow that.
- `owns` takes a **predicate** for the `create-shape-unresolved` case where the run never learned the box's name: `fleetLeftovers(ctx.driver, (n) => n.startsWith(fanoutId), evidence)`. For multi-arm tiers pass the array: `[...armVms, runId]`.
- Defaults are the measured ones: `maxAttempts: 5`, `retryDelayMs: 8_000`, `prefixes: ["e2e-", "qds-"]`. **tier2-fanout-bestofn and tier2-dispatch-engine should delete their hand-rolled 5×8 s loops** and call this — same numbers, same `final-ls-retry` phase.
- Also closes **P136** for T1.5 (which has no cleanup-time box check at all): one line in its `finally`.
- The **strays** half is already handled inside the helper (evidence + a `[final-ls] WARNING` stderr line). Do not fold `strays` into your problems array — that is exactly the account-wide false red R4 removes. If a test genuinely wants a stray to be fatal, that is a new decision, not a port.

### 2. `setEffectiveImage` — REQUIRED for the two tests that never call `preflight()` (P125)

```ts
export function setEffectiveImage(
  source: { readonly image: string; readonly imageBuildId: string } | null,
  detail?: { overriddenBy?: readonly string[]; note?: string },
): void;
```

**`writeEvidence` now THROWS if this was not set for the current test.** `preflight()` calls it for you. Exactly two tests do not call `preflight` and **will fail their evidence write until you wire this up** (a cleanup problem via `writeEvidenceQuietly`, so the round goes red with everything else already torn down — but red):

- **`tier1-registry-auth.live.test.ts`** (`liveGate("1")` at :84, builds `new ExeDevDriver({ image: privateRef, … })` and `exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: privateRef, … })`). Call once before the evidence write, with the driver whose image the round actually proved:
  ```ts
  setEffectiveImage(posDriver, { note: `AC4 negative leg booted ${privateRef} unauthenticated` });
  ```
  (a plain `{ image, imageBuildId }` literal works too — it is structurally typed.)
- **`tier1-teardown.live.test.ts`'s D6** (`liveGate("1")` at :329, boots no box at all, calls raw `writeEvidence` at :377). This one takes the null form — "no image" is a true provenance claim; an inherited one is not:
  ```ts
  setEffectiveImage(null, { note: "D6 lists key hashes only — no box is ever created" });
  ```

The stamp is **consumed by each write**, so a test that writes evidence twice must stamp twice. No current test does.

### 3. `fleetCleanupProblems` — optional third arg (tier35 LOW)

```ts
export function fleetCleanupProblems(
  destroyFailures: readonly string[],
  finalBoxes: string[] | undefined,
  evidence?: readonly Record<string, unknown>[],
): string[];
```

Pass `evidence` to get `finally-revoke ok:false` entries folded in as a `revoke failures: …` problem — the fold-in T5.1 was doing by hand and the other eleven were missing.

**T5.1 must drop its hand-rolled block** if you pass `evidence` there, or it double-reports:
```ts
const revokeFailures = evidence.filter((p) => p.phase === "finally-revoke" && p.ok === false);
if (revokeFailures.length > 0) problems.push(…);   // ← delete this, pass `evidence` instead
```
Same applies to D8's `revokeFailures` filter in `tier1-approval-gate.live.test.ts`.

### 4. `keyLeakProblems` is now TOTAL — P138 needs no per-site fix

It cannot throw. Do **not** add `try { keyProblems = await keyLeakProblems(...) } catch …` to the seven tier-3–5 `finally` blocks; a failure comes back as a problem string. (Its signature is unchanged.)

### 5. Not mine, still open for you

- **`hashesBefore` is account-wide** (edge-e2e-t1b-t2 LOW). The R4 split I built is for **boxes**. The key half is unchanged: a hash minted by a concurrent operator still reads as this run's leak and still renders "STILL LIVE". Triage files that under F9, and the fix wants the delta intersected with hashes attributable to this run's records — that needs decisions about the tier-2 call sites, not just the callee. `keyLeakProblems`'s signature is untouched, so nothing I did conflicts with it.
- **File-selection globs** — `live-harness.test.ts` still sits beside `*.live.test.ts` under a name a `tests/fleet/e2e/*.test.ts` glob picks up. Flagged, not changed (see P133).

## False positives

### "`keyLeakProblems` is an unguarded `await` … a network 5xx/timeout rejection escapes the `finally`" — the stated trigger does not hold
`blind-e2e-tier35.md` HIGH #3 / P138. **The named path was already guarded.** In the pre-fix code, `listOnce()` was called only inside `const list = async () => { try { return { hashes: await listOnce() } } catch (e) { return { error: … } } }`, and the only other `await` in the body was `revokeQuietly`, which is documented and unit-tested as total. A provider 5xx from the key listing therefore produced `{ error }` → a problem string, not a rejection — the consequences the finding lists (held failure discarded, `writeEvidenceQuietly` skipped, `settleRun` unreachable) could not occur via that route.

I hardened it anyway, per the pre-decided call in rule 2: a *synchronous* throw from `list` (as opposed to a rejection) did escape, the totality was a property of the implementation rather than a contract, and putting the guard in the callee is what stops the seven live tests each growing their own. So: finding's remedy adopted, finding's stated trigger recorded as refuted.

### `settleRun`'s "Checked and clean" list — nothing on it was touched
Per rule 3 I left all of `edge-e2e-t1b-t2.md`'s clean list alone: `settleRun`'s ordering (the original error is still the thing re-thrown, identity-equal), registration-before-provision, `liveGate` throwing rather than skipping, `pollBootId`'s budget arithmetic. The only `settleRun` behaviour changes are the scrub, the always-on stderr line, the double-append guard and the non-Error wrap — the ordering contract is unchanged and is now pinned by a test.

## Gates

```
$ bun test tests/fleet/e2e/live-harness.test.ts
exit=0
 26 pass
Ran 26 tests across 1 file. [1.69s]
```
(26 tests, up from 15. Whole file now 1.7 s; it was up to 120 s of spawn ceilings before.)

```
$ bunx biome check tests/fleet/
Checked 37 files in 327ms. No fixes applied.
```

```
$ bunx tsc --noEmit
scripts/build-exedev-image.ts(1167,5): error TS2741: Property 'platform' is missing in type '{ baseDigests: string[]; bunVersion: string; piVersion: string; dockerfile: Buffer<ArrayBufferLike>; systemdFiles: { name: string; bytes: Buffer<ArrayBufferLike>; }[]; }' but required in type 'BuildIdInputs'.
scripts/build-exedev-image.ts(2109,17): error TS2554: Expected 1 arguments, but got 0.
src/providers/index.ts(15,10): error TS6133: 'ExeDevDriver' is declared but its value is never read.
tests/scripts/build-exedev-image.test.ts(54,3): error TS2741: Property 'platform' is missing in type '{ baseDigests: string[]; bunVersion: string; piVersion: string; dockerfile: string; systemdFiles: { name: string; bytes: string; }[]; }' but required in type 'BuildIdInputs'.
tests/scripts/build-exedev-image.test.ts(158,11): error TS2741: Property 'platform' is missing in type '{ baseDigests: 0; bunVersion: 0; dockerfile: 0; piVersion: 0; systemdFiles: 0; }' but required in type 'Record<keyof BuildIdInputs, 0>'.
```

**Zero errors in `tests/fleet/e2e/`** — all twelve live test files still type-check against the changed harness, which is what this gate was for. The five errors above are in files I do not own and did not touch (`git status` shows `scripts/build-exedev-image.ts` and `src/providers/index.ts` modified by other in-flight fixers this round; the `tests/scripts/build-exedev-image.test.ts` errors follow from their `BuildIdInputs` change). Reporting them rather than filtering them out: whoever owns `fix-buildscript` / `fix-driver-transport` still has to clear them before the round's gate is green.

The live suite was NOT run (real money, `QDS_E2E_LIVE` unset), as instructed.
