# F9 — tier-2 live tests (`tier2-image-contract`, `tier2-fanout-bestofn`, `tier2-dispatch-engine`)

Branch `fix/df2.10-review-round-6`. Three files touched, nothing else. No commit, no push.
The live suite was NOT run (real money, `QDS_E2E_LIVE` unset).

All three files call `preflight("2")`, so the P125 provenance stamp is set for them — no
`setEffectiveImage` wiring was needed. Verified by reading, per the harness report's item 4.

## Fixed

### [HIGH] P134 — both file budgets were below the sum of their own inner ceilings
`tier2-fanout-bestofn.live.test.ts` `2_400_000 → 6_480_000`, `tier2-dispatch-engine.live.test.ts`
`1_800_000 → 6_000_000`, each with a ceiling-priced audit comment in the
`tier2-image-contract` style at the bottom of the `test.todoIf(...)` call. Arithmetic below.

### [HIGH] P135/P127 — the hand-rolled 5 × 8 s `final-ls` polls are gone
All three files now call `fleetLeftovers`:

- `tier2-dispatch-engine`: `finalBoxes = (await fleetLeftovers(ctx.driver, [runId, vmName], evidence)).owned;`
- `tier2-fanout-bestofn`: `[...armVms, ...armRunIds]` — on the refusal path the id recovery sets
  `armVms = armRunIds`, so the union is exactly what this run can own.
- `tier2-image-contract`: `[runId]`, not `[vm]`. `vm` is set to `runId` inside the try and is `""`
  only when the body died before that line; `runId` is the name `create` was called with either
  way, so it is the honest ownership claim and it covers the `vm === ""` case the old comment
  named but could not handle.

Surrounding try/catch dropped at all three sites (the helper is total; a local catch would swallow
the `owned: undefined` → "unmeasured fleet" problem). `strays` is NOT folded into any problems array.

### [HIGH] P140 — `expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF)` deleted
`tier2-image-contract.live.test.ts`. Verified against source before deleting: `preflight` builds
`exeDevDriverFromEnv()` with no opts (`live-harness.ts:108`); `buildExeDevDriverFromEnv` strips
undefined-valued opts and derives image/buildId from `QDS_EXEDEV_IMAGE` /
`QDS_EXEDEV_IMAGE_BUILD_ID`; the constructor falls back to `DEFAULT_IMAGE_REF` /
`DEFAULT_IMAGE_BUILD_ID` (`driver.ts:549,551`); and the loop three lines above asserts both
variables are *exactly* empty (stricter than the factory's own `.trim()` test). Constant-vs-constant.

Both lines and the false "GENUINELY falsifiable since #189" paragraph are replaced by a comment
that says why there is no assertion there, so the next editor does not re-add it. The falsifiable
coverage is untouched (`expect(marker.buildId).toBe(DEFAULT_IMAGE_BUILD_ID)`), and `create`'s
evidence entry still records `ctx.driver.image` verbatim.

### [MED] unguarded `new RunRecordStore(...)` inside the two tier-2 `finally` blocks
Both files now build it above the call, in its own try, defaulting to `undefined`:

```ts
let recordStore: RunRecordStore | undefined;
try {
  if (workspace !== "") recordStore = new RunRecordStore({ dir: join(workspace, "runs") });
} catch (e) {
  evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
}
```

`undefined` is the truthful fallback: `keyLeakProblems` then reports the delta without a
record-backed fallback revoke and says so (P132's wording).

### [LOW] `hashesBefore` is account-wide
All three files. Attribute first, then hand `keyLeakProblems` a baseline it cannot false-red on:
`ours` = the hash(es) this run's record(s) name (plus `mintedHash` in `tier2-image-contract`, which
mints in-process and therefore knows its own hash independently of the record); everything else in
the account delta is pushed as a `key-hash-delta-foreign` evidence entry and folded into the
baseline. Signature of `keyLeakProblems` unchanged — the whole fix is at the call site, as the
harness report asked.

Guarded: if the attribution listing throws (including `listedKeyHashes`' D6 truncation refusal) the
baseline stays `hashesBefore`, i.e. the pre-existing account-wide behaviour, which can only report
more, never less.

Stated cost, in the comment at each site: a key this run minted whose hash never reached its record
now warns instead of failing. `mintRunKey` persists `keyHash` into the record before its own later
refusals can throw (`credentials.ts`), so the uncovered window is the record write itself. This is
deliberately the same report-wide/act-narrow posture wave 1 chose for stray boxes (R4).

### [LOW] `Number("")` passes the marker-bytes check
`tier2-image-contract`: `expect(markerStat.stdout.trim()).toMatch(/^\d+$/);` added ahead of the
`Number.isFinite` / `toBeLessThan` pair.

### [LOW] a `store.create` throw became a phantom key leak
`tier2-image-contract`: the store is built into a local, `create(runId)` runs, and only then is it
published to the `finally`-visible `store`. An undefined store is the truthful state when no record
exists — `revokeQuietly` no longer dies ENOENT and reports `finally-revoke ok:false` on a run that
provably minted nothing. The `finally`'s "gated on the STORE ALONE, never on `mintedHash`" argument
is unaffected: `create` precedes the mint.

### tier35 [LOW] — `finally-revoke ok:false` folded in via the new third argument
All three files pass `evidence` to `fleetCleanupProblems`, and `tier2-image-contract`'s hand-rolled
`revoke failures: ${JSON.stringify(bad)}` IIFE is deleted so it does not double-report. Checked that
this cannot manufacture a false red: `revokeQuietly` early-returns without an evidence entry when
the record carries no `keyHash`, and `revokeRunKey` returns `"already-gone"` (→ `ok: true`) for a
key the teardown verb already revoked — `ok: false` is reachable only from a throw.

## Budget arithmetic

Both new numbers are priced at DECLARED CEILINGS, never at typical latency, and both audits are
in-file so the constraint travels with the code. The load-bearing asymmetry, stated in both
comments: an **inner** ceiling firing is SAFE (it rejects into the catch and the `finally` still
runs); the **file** budget firing is the one path that skips the `finally` entirely and leaves real
boxes billing and minted keys live. So the fail-safe direction for the file budget is up.

**T2.1 `tier2-dispatch-engine` — 1_800_000 → 6_000_000**

| leg | ceiling |
|---|---|
| ls-before, 1 control ls @120 | 120 s |
| dispatch verb `timeoutMs: 1_200_000` | 1 200 s |
| box-live ls @120 | 120 s |
| 4 in-box `driver.exec` @ `DEFAULT_EXEC_TIMEOUT_MS` 120 | 480 s |
| engine: 2 × `execTimed(…, 540_000)` + the 30 s inter-attempt wait | 1 110 s |
| commit-fix exec @120 | 120 s |
| `scratchClone` (real clone, no in-file ceiling) allowance | 180 s |
| harvest `timeoutMs: 300_000` | 300 s |
| teardown `timeoutMs: 300_000` | 300 s |
| post-teardown `listedKeyHashes` + control ls, allowance | 240 s |
| ledger + record reads (local) | 10 s |
| **body** | **4 180 s** |
| `teardownQuietly` `timeoutMs: 180_000` | 180 s |
| `destroyQuietly`, 1 control rm @120 | 120 s |
| `fleetLeftovers` 5 × (ls 120 + 8 s wait) + destroy pass + re-list | 880 s |
| key-attribution listing, allowance | 120 s |
| `keyLeakProblems` delta list + fallback revoke + recheck list | 360 s |
| evidence + `rmSync` | 10 s |
| **finally** | **1 670 s** |
| **total** | **5 850 s → 6 000 000 ms** |

**T2.2 `tier2-fanout-bestofn` — 2_400_000 → 6_480_000**

| leg | ceiling |
|---|---|
| ls-before @120 | 120 s |
| fanout verb `timeoutMs: 1_800_000` | 1 800 s |
| boxes-live ls @120 | 120 s |
| rank verb `timeoutMs: 60_000` | 60 s |
| arm work, 2 × `driver.exec` @120 | 240 s |
| `scratchClone` allowance | 180 s |
| harvest, 2 arms × 300_000 | 600 s |
| teardown, 2 arms × 300_000 | 600 s |
| per-arm verify, 2 × (`listedKeyHashes` + control ls), allowance | 480 s |
| ledger + record reads (local) | 10 s |
| **body** | **4 210 s** |
| `teardownQuietly`, 2 arms × 180_000 | 360 s |
| `destroyQuietly`, 2 × control rm @120 | 240 s |
| `fleetLeftovers` 5 × (ls 120 + 8 s wait) + 2-arm destroy pass + re-list | 1 000 s |
| key-attribution listing, allowance | 120 s |
| `keyLeakProblems` delta list + 2 fallback revokes + recheck list | 480 s |
| evidence + `rmSync` | 10 s |
| **finally** | **2 210 s** |
| **total** | **6 420 s → 6 480 000 ms** |

**Why both are higher than the report's ≈4 200 000 estimate.** The report priced only the four
`runFleet`/`execTimed` ceilings the finding named. Two whole legs are missing from that sum and are
real declared ceilings: T2.1's engine leg is `execTimed(…, 540_000)` **twice** plus a 30 s wait
(1 110 s — more than the harvest and teardown ceilings combined), and every `driver.list` /
`driver.exec` in both bodies carries `DEFAULT_EXEC_TIMEOUT_MS` 120 s. The `finally` is also bigger
than the report's ≈900 s allowance now that `fleetLeftovers` polls 5 × (120 + 8) s and the
attribution listing has been added — the two changes this round made to those blocks.

**T2.3 `tier2-image-contract` — 2_880_000 → 4_320_000 (not in the findings; consequence of my own
edits).** Its existing audit priced the whole `finally` at a 660 s lump covering destroy + revoke +
evidence. This round added `fleetLeftovers` (≈880 s), the key-attribution listing (≈120 s) and
counted `keyLeakProblems` explicitly (≈360 s) — 2 820 → 4 180 s. Leaving the audit stale while
growing the block it prices is precisely the failure that audit exists to prevent, so the number and
the table moved together. Each of the three audits now carries an explicit
"whoever adds a cleanup step must add its ceiling here" line.

## False positives

None. Every tier-2 finding was checked against source before patching, and all held:

- P140 verified through `preflight` → `exeDevDriverFromEnv` → `buildExeDevDriverFromEnv` → the
  constructor's `??` fallbacks, plus the env loop's exact-empty assertion.
- The `new RunRecordStore` MED verified against `run-record.ts`'s write-mode constructor
  (`assertDirMode0700` → `chmodSync`, `assertExclusiveCreateSupported`, `cleanStaleTemps`).
- The `store.create` LOW verified against `revokeQuietly` (`store.get(runId)` is inside the try but
  its ENOENT still lands as `finally-revoke ok:false`, which the new third-arg fold-in now renders
  as a problem line — so leaving it would have gone from cosmetic to a reported cleanup failure).
- The report's "Checked and clean" list was left alone, including `pollBootId`'s budget arithmetic,
  the AC6 negative control, `okExitCodes: [0, 6]` and registration-before-provision.

One thing I did **not** do: `keyLeakProblems`' fallback still cannot revoke a foreign hash, and
nothing in this round tries to. Revoking a key a concurrent operator minted is worse than warning
about it — the same call wave 1 made for stray boxes.

## Gates

```
$ bunx tsc --noEmit
tests/fleet/e2e/tier1-registry-auth.live.test.ts(67,3): error TS6133: 'fleetLeftovers' is declared but its value is never read.
tests/fleet/e2e/tier1-registry-auth.live.test.ts(71,3): error TS6133: 'setEffectiveImage' is declared but its value is never read.
tests/fleet/e2e/tier1-registry-auth.live.test.ts(92,7): error TS6133: 'MARKER_EXEC_TIMEOUT_MS' is declared but its value is never read.
```
**Zero errors in my three files.** The three above are in `tier1-registry-auth.live.test.ts`, which
belongs to `fix-e2e-tier1` and was mid-edit while I ran the gate (unused imports it has staged but
not yet used). Reported, not filtered — that fixer still has to clear them before the round is green.
The five `scripts/build-exedev-image.ts` / `src/providers/index.ts` errors the harness report saw are
already gone.

```
$ bunx biome check tests/fleet/e2e/
Checked 21 files in 1155ms. No fixes applied.
```
