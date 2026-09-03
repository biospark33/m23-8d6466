# F5a — `driver.ts` / `transport.ts` / `image-contract.test.ts` / `read-box-file.test.ts`

Branch `fix/df2.10-review-round-6`. No commits, no pushes. Only my four files touched.

---

## Fixed

### `src/providers/exedev/transport.ts`

| id | finding | where | change |
|----|---------|-------|--------|
| **P81 [HIGH]** | `parseImageMarker` interpolates the raw V8 `JSON.parse` SyntaxError — box-controlled bytes, unescaped, into a logged note, `result.error.message` and the evidence artifact | `transport.ts:299-315` (`parseImageMarker`'s catch) | `refuse(\`is not parseable JSON: ${JSON.stringify((e as Error).message.slice(0, 200))}\`)`. Took the `JSON.stringify` + slice arm of the pre-decided call rather than the fixed sentence: it is the SAME rule `tail()` applies to box-controlled stderr twelve lines down, it neuters newlines/ANSI, and it keeps the operator's diagnostic. (The fixed-sentence form belongs to `assertRegistryAuthDeviation`, where the quoted bytes could be a SECRET; here they are the box's own public marker, which this function already `JSON.stringify`s at the mismatch arm.) Comment states the distinction. |
| edge [MED, dup of P81] | same | same | same |
| edge [LOW] | `left()`'s 1 ms floor blames the box for the caller's spent budget | `transport.ts:170-183` | New arm before the read leg: `if (until - Date.now() <= 0) return { kind: "unreadable", exitCode: -1, stderr: "read budget exhausted by the presence probe (N ms shared by both legs)" }`. `exitCode: -1` because no process ever ran. Disposition unchanged (fail-closed at both call sites, still `image-marker-unreachable`); only the sentence gets honest. The 1 ms clamp survives for the merely-tight case, and its comment now says it is a clamp, not a diagnosis. |
| edge [LOW] | `read.truncated` is `stdout \|\| stderr`, so an oversized stderr on a FAILED `cat` permanently condemns a fanout arm | `transport.ts:191-212` | Oversized now requires `read.truncated && read.stdout.length > 0`; a truncated-stderr failure falls through to `unreadable` **with its exitCode and stderr** (retryable, diagnosable) instead of `oversized` → `fanout-primitive.ts:817` → "unusable" → given up as corrupt. Truncated-with-empty-stdout-and-exit-0 still returns `oversized` (fail-closed, cannot loop). Narrower than the report's fix — it reaches the same goal without changing `ExecResult` or the `BoxFileRead` union, so no other caller moves. |
| blind [LOW] | `IMAGE_MARKER_MAX_BYTES` documented as a "read cap" but enforced AFTER the whole read | `transport.ts:234-253` | Behaviour kept, prose made honest (pre-decided call). Retitled "POST-READ refusal ceiling"; says outright that the bytes are already in host memory, that the memory bound is `EXEC_MAX_OUTPUT_BYTES`'s job alone, and that what this buys is "never PARSED, never compared, never quoted into a note". Names `REGISTRY_AUTH_FILE_MAX_BYTES` as the genuine read-cap shape by contrast. |
| edge [LOW] + blind [MED, transport half] | gate B is a drift detector, not a tamper control; the comment reads as an integrity guarantee | `transport.ts:322-337` (`imageMarkerFailure` docblock) | Behaviour kept, prose made honest (pre-decided call). Added "DETECTS DRIFT, NOT TAMPERING" paragraph: the marker is authored by the subject of the assertion, and the `buildId` an attacker must forge is printed by the build script and quoted back in this function's own refusal text. Names what would close it (host-side digest attestation at pull, recorded with the create event) and says this gate is not it. (The `setup-gate.ts` "PROVES" half is `fix-setup-gate`'s.) |
| edge [LOW] | parse-failure message repeats the marker path (`B: /etc/qds-image.json: /etc/qds-image.json is not …`) | `transport.ts:~430` | Fixed in the WRAPPER, not in `parseImageMarker`: `message: \`B: ${err.message}\`` instead of `\`${prefix}: …\``. `parseImageMarker` keeps the path in its own message so a DIRECT caller (the parse table in `image-contract.test.ts`) still gets a message with a subject. |
| blind [LOW] | duplicate `EXEC_KILLED_EXIT` / `EXEC_TRANSPORT_EXIT` in two modules | `transport.ts:256-265`, `driver.ts:33-42` + `:104-112` | `driver.ts` now IMPORTS the exported pair; its private copies are deleted. Both comments updated (`transport.ts` no longer says "collapse them when that module is next in scope"; `driver.ts` keeps the provision-script rationale beside the import). |
| blind [LOW, partial] | `readBoxFile` silently degrades to the untimed `exec` when `execTimed` is absent | `transport.ts:130-140` | See **False positives** — the "silent degrade for a real driver" half is refuted. Comment now records the refutation in place, so the next reader does not re-raise it. |

### `src/providers/exedev/driver.ts`

| id | finding | where | change |
|----|---------|-------|--------|
| edge [MED] | every factory/constructor refusal emits **zero** log lines — `instrument()` wraps only the RETURNED driver, so the first box of a fanout dies on a bare exception | `driver.ts:1329-1372` | `exeDevDriverFromEnv` is now a thin observed wrapper around `buildExeDevDriverFromEnv` (body split out only to avoid indenting the whole seam). One `exedev.driver_construct_failed` line — requestId, typed `code`, message, no credential — then the error is rethrown untouched. Covers factory refusals AND the `new ExeDevDriver` refusals beneath them, which is the production path (`src/providers/index.ts:138`). |
| edge [MED] | `redactRegistryAuth` guards a zero-length secret but not a one-character one — `split("x")` shreds the create-failed stderr into confetti | `driver.ts:373-382` (`assertRegistryAuth`) | Floor raised to 8 bytes: `if (secret.length < 8) refuse("password is shorter than 8 bytes")`, kept AFTER the empty check so "password is empty" keeps its specific message. The length-0 belt in `redactRegistryAuth` stays. Comment states this is a REDACTION property, not a strength claim. |
| edge [MED] | `--image` is unconditional, so an unpullable digest is a fleet-wide create failure routed into the never-destroy path | `driver.ts:~845-860` | New `exedev.image_pull_failed` event emitted BESIDE `create_failed` when the (already redacted) substrate stderr matches `/\b(pull\|manifest\|unauthorized\|denied\|not found\|no such image\|toomanyrequests)\b/i`. Additive only — nothing branches on it here; it is the fact a fanout needs to circuit-break on instead of burning N boxes against a registry that is down. |
| blind [MED] | `create()`'s rejection path cannot distinguish "no box" from "a box may be live and unowned" | `driver.ts:~795-815` | `create_failed` now carries `mayExist`. `true` on the rejection arm (command issued, no answer — an exec timeout or transport abort after exe.dev accepted the `new` leaves a billing box, and `exitCode: null` was shape-identical to a spawn ENOENT); `false` on the non-zero-exit arm (the substrate ANSWERED and refused). Unknown reports the fail-safe reading: sweeping a name that was never created is a no-op, the reverse is an invisible box. |
| edge [LOW] | `stat.size` is 0 for procfs regular files, so the pre-read byte ceiling is bypassed | `driver.ts:~1470-1490` | `readFileSync(fd)` → bounded `readSync(fd, Buffer.alloc(MAX + 1), 0, MAX + 1, 0)`. One byte over the ceiling is read on purpose so an oversized file is DETECTED rather than silently truncated into a plausible credential; a distinct `registry-auth-file-oversized` message names the understated stat size. The fstat ceiling survives as the early refusal. |
| edge [LOW] | a zero-byte / whitespace-only credential file refuses with the wrong reason | `driver.ts:~1505-1518` | After `raw.trim()`, an empty result throws `registry-auth-unreadable` "is empty (or holds only whitespace)" instead of falling through to `assertRegistryAuth("")` → "found no ':' separator" for a value that is not there (in a message that withholds values by design). Still value-free. |
| blind [LOW] | `isUnpinnedImage` uses `endsWith`, so a tag can trip the sentinel | `driver.ts:206-217` | `imageDigestOf(ref) === \`sha256:${UNPINNED_DIGEST}\``. A legal tag ending in 64 zeros is no longer "unpinned"; a tag pin returns `null` from `imageDigestOf`, which is the honest "not a digest, so not the digest sentinel". Test added for the tag case. |
| edge [LOW] | `isUnpinnedImage` is never consulted on the runtime path — a sentinel OVERRIDE boots with only the generic `image_override` line | `driver.ts:~648-672` | New `exedev.image_sentinel` event (status `error`) in the constructor when `isUnpinnedImage(this.image)`. ANNOUNCED, not refused, because `UNPINNED_DIGEST`'s own docblock requires the sentinel to still CONSTRUCT (the bootstrap publish run needs exactly that). Comment states why refusal is the wrong lever here. |
| blind [LOW] | a date-only `expiry` lapses at UTC midnight, so a same-day ratification is already refused | `driver.ts:~487-497` | `const lapsesAt = expiryStr.length === 10 ? expiresAt + 86_400_000 : expiresAt;` — a date-only value means "valid THROUGH that day". Date-time forms name an instant and are compared as written. |
| blind [LOW] | `redactRegistryAuth` never scrubs the bare username while the doc claims "BOTH spellings are scrubbed" | `driver.ts:~660-690` | Behaviour kept, prose made honest (pre-decided call). "BOTH SECRET-BEARING spellings"; states outright that the bare username is deliberately NOT scrubbed, and why — it is a short `[A-Za-z0-9._-]` token (`qdsbot`), and splitting the message on it shreds every unrelated occurrence, the same confetti failure the new length floor prevents. |
| blind [LOW] | the credential is loaded into memory before the ratification gate can refuse it | `driver.ts:~1415-1430` | `assertRegistryAuthDeviation(given.postureFile ?? DEFAULT_POSTURE_FILE)` now runs BEFORE the credential file is opened. Setting `QDS_EXEDEV_REGISTRY_AUTH_FILE` IS the intent to take the private path, so the gate has everything it needs there. New `DEFAULT_POSTURE_FILE` const so the factory and the constructor share one spelling. Constructor and per-create re-assertions unchanged. |
| edge [MED, comment half] | `image_override` "announced once" is announced once per RESOLUTION, with `runId: null` | `driver.ts:~620-636` | Behaviour kept; comment now says "once per DRIVER CONSTRUCTION — not once per fleet", names `resolveDriver`'s non-memoization as the cause, and states that `runId: null` at construction is honest (no run exists) while the Observability Contract's join key is supplied by `imageFields` on every create event. The duplication fix is `src/providers/index.ts`'s — see **Cross-file needs**. |

### `tests/providers/exedev/image-contract.test.ts`

| id | finding | change |
|----|---------|--------|
| **P82 [HIGH]** | the file-loaded credential is never proven to reach the driver or argv (`not.toThrow()` was the only happy-path assertion) | Test is now `async`. Binds the returned driver, drives `await loaded.create("df210-auth-file")`, and asserts the whole parsed create `{ name, image: DEFAULT_IMAGE_REF, registryAuth: VALID_AUTH }` **and** the full `newArgv(fake)`. `expect(fake.calls).toEqual([])` relocated above the create, where it still means something. This also covers the trim claim positively (an untrimmed `\n` would show up in `fake.creates`). |
| **P83 [HIGH]** | `DEFAULT_IMAGE_BUILD_ID` has no "still a placeholder" merge gate though gate B keys on it | `expect(DEFAULT_IMAGE_BUILD_ID).not.toMatch(/^0{16}$/)` added to the same never-skip DoD test, with the reasoning inline. |
| [MED] | `Object.keys(EVERY_ASSERTION_ITEM).sort()).toEqual(Object.keys(ASSERTION_CODE).sort())` cannot fail | Restructured to two assertions that BOTH can fail: `items = Object.keys(EVERY_ASSERTION_ITEM).sort()` → `expect(items).toEqual(["A".."E"])` (the title's claim; a sixth `AssertionItem` forces a sixth key via `Record<AssertionItem, true>` under tsc and then fails here at runtime), then `expect(Object.keys(ASSERTION_CODE).sort()).toEqual(items)`. **Deviation from the report's literal fix**: deleting the second line outright would have left `EVERY_ASSERTION_ITEM` unreferenced, and this repo runs tsc with `noUnusedLocals` (TS6133), so it would not compile. Deriving the letter list from the record keeps it load-bearing and removes the tautology. |
| [MED] | `expect(marker.buildId).toBe(DEFAULT_IMAGE_BUILD_ID)` is a same-source comparison | **Confirmed**: `fixtures/fake-exedev.ts:131-142` interpolates `DEFAULT_IMAGE_BUILD_ID` into `DEFAULT_IMAGE_MARKER`. It was X === X. Now asserts the literal `"3cf094fb6990ed66"` on both sides, with a comment saying this literal must move with the pin — it is the only place the fixture-vs-pin agreement is falsifiable, and every gate-B happy path below passes by construction without it. |
| [MED] | `df210-marker-perfect` lacks the distinctness guard its siblings carry | `const wrongBuild = "0123456789abcdef"; expect(wrongBuild).not.toBe(DEFAULT_IMAGE_BUILD_ID);` and the note assertion switched from `toMatch(/0123.../)` to `toContain(wrongBuild)`. Same guard added to `other` in the tenant test. |
| [MED] | two absence claims about paid traffic rest on an un-anchored `boxCmds` projection; the nine-arm fail-closed table makes no spend claim at all | New describe-level `boxCommands(runId)` helper that ASSERTS the marker-read anchor before returning the projection (so an empty array from a shape drift fails loudly instead of satisfying every absence claim). Called from the passing test, the `perfect` test, **and every arm of the fail-closed table** — `expect(boxCommands(c.id).some(d => d.includes("chat/completions")), c.id).toBe(false)`. |
| [LOW] | `expect(isUnpinnedImage()).toBe(isUnpinnedImage(DEFAULT_IMAGE_REF))` is strictly weaker than the line under it | Deleted (the report's "deletion is the honest option"). Kept the flat `expect(isUnpinnedImage()).toBe(false)` and added the new tag-not-sentinel case. |
| [LOW] | `expect(err.remediation.length).toBeGreaterThan(0)` is near-vacuous | → `expect(err.remediation, why).toMatch(/ghcr\.io\/\S+@sha256:<64 hex>/)` — the very template the "remediation is FOLLOWABLE" test then proves the validator accepts. |
| [LOW] | a raw control character (0x07) is embedded in a source string literal | Spelled as ``. Comment explains why the raw byte survives nothing. |
| [LOW] | `newArgv` returns the FIRST create, not the only one | Now `filter` + throws on `> 1` with a message naming the fix, alongside the existing throw on `0`. |
| [LOW] | `refusal()` accepts an async thunk and reports the wrong reason | Runtime guard: captures the return value, and if it `instanceof Promise` attaches a no-op `.catch` (so the rejection cannot fail an unrelated later test) and throws a message naming the misuse. **The report's typed fix does not work** — TypeScript's void-return rule makes `() => Promise<never>` assignable to `() => void`; the docblock now says so. |
| [LOW] | cleanup is skipped on one failure path in the env negative control | `expect(envBuildId).not.toBe(DEFAULT_IMAGE_BUILD_ID)` moved inside the `try`. |
| [LOW] | the tenant test runs `setup()` twice against one box and one evidence dir | Added the discriminating assertions: `strict.error?.code === "image-marker-mismatch"` and the B note containing BOTH `other` and `DEFAULT_IMAGE_BUILD_ID`. |
| — | (new, to cover the new behaviour) | Two tests added: "a FACTORY refusal emits …" (asserts `exedev.driver_construct_failed` for both an `image-pin-incomplete` factory refusal and an `image-build-id-invalid` constructor refusal, and silence on success) and "the all-zeros SENTINEL as an OVERRIDE is ANNOUNCED …" (asserts `exedev.image_sentinel`, and that the repo-pinned driver says nothing). `mayExist` asserted on both `create_failed` arms. New `assertRegistryAuth` arm "password under 8 bytes". |
| — | (fixture repair forced by the 8-byte floor) | `["command substitution", "qdsbot:$(id)"]` → `"qdsbot:pw-$(id)-x"` and `["comment character", "qdsbot:pa#ss"]` → `"qdsbot:pa#ssword"`. Both were 5-byte secrets and would otherwise have been refused for LENGTH, leaving the charset rule each arm names untested. Comment records why. |
| — | (test repair forced by the ratification-first change) | The `"absent"` auth-file arm now passes `postureFile: ratified`, or it would refuse `registry-auth-unratified` and the unreadable-file rule would go untested. New `"empty"` arm added beside it. |

### `tests/providers/exedev/read-box-file.test.ts`

| id | finding | change |
|----|---------|--------|
| edge-fleet [LOW] | `expect(call.timeoutMs).toBeGreaterThan(0)` cannot fail (`left()` is `Math.max(1, …)`) | Dropped; replaced with `expect(seen[0]?.timeoutMs).toBeGreaterThan(4_900)` — this fake returns instantly, so the probe must get essentially the whole budget, which a halved or hard-coded per-leg deadline breaks. |
| edge-fleet [LOW] | zero-margin timing assertion `toBeLessThanOrEqual(5_000 - 60)` against `await Bun.sleep(60)` | → `expect(seen[1]).toBeLessThan(seen[0])` — the actual property, with no integer-millisecond edge. |
| — | (new, covering the two transport behaviour changes) | "no budget left at the read leg is NAMED, not blamed on the box" (driven with `deadlineMs: 0`, the deterministic spelling — see the note in the test about why an overrunning probe cannot reach that state) and "a FAILED cat whose stderr breached the cap is unreadable, not permanently oversized". |

---

## False positives

**1. blind [LOW] `imageFields`' `runId` may be silently overwritten by `emit`'s hardcoded `runId: null`.**
Refuted against real source. `emit` (`driver.ts:~730-742`) is:
```ts
log({ requestId: …, operation: …, agentId: null, timestamp: …, duration: 0,
      status: outcome, runId: null, driver: this.name, ...fields });
```
`...fields` spreads **after** `runId: null`, so `imageFields`' `runId: name` wins. The reviewer flagged it as unverifiable from the diff, and also proposed "assert the merged event shape in a test that goes through `emit`" — that test **already exists**: `image-contract.test.ts` asserts `expect(line.runId).toBe("df210-auth-1")` for every `exedev.create*` line captured through the real log sink. Nothing to fix.

**2. blind [LOW] `readBoxFile` silently degrades to "abandon" whenever `execTimed` is absent — "a refactor that drops the method from a real driver degrades silently rather than failing to compile".**
The stated consequence is refuted for the production path. `fill.ts:269` and `setup-gate.ts:401/412/413/428/429/558/567/600` call `driver.execTimed(...)` **unconditionally** — a real driver that lost the method dies with a TypeError long before it reaches `readBoxFile`. The remaining case is the documented, deliberately blessed one (a structural fake with only `exec`), which the type's own comment already blesses. Fixed the prose rather than the code: the docblock now records the refutation in place so the next round does not re-raise it. Adding a `log` import to the LOW module for a test-only branch would be new coupling for no production benefit.

**3. edge [LOW] `IMAGE_REF_RE` admits an out-of-range port** — dismissed as **X4** in triage; not touched.

Round 4's **B10** (`tarUnescape` surrogate) and **D3a** (`redactSecrets` non-string) were not re-raised and are not touched.

---

## Impact analysis (gitnexus, `direction: upstream`, `includeTests: true`)

| symbol | impacted | risk | processes |
|--------|----------|------|-----------|
| `parseImageMarker` | 5 | LOW | none |
| `readBoxFile` | 14 | **HIGH** | `fanout`, `dispatch`, `runDispatch`, `setupGate` |
| `imageMarkerFailure` | 2 | LOW | none (ambiguous resolve, both candidates same file/count) |
| `assertRegistryAuth` | 1 | LOW | none |
| `assertRegistryAuthDeviation` | 19 | **HIGH** | `dispatch`, `ExeDevDriver.constructor`, `provisionAdmittedRun` |
| `exeDevDriverFromEnv` | 43 | MEDIUM | none (9 direct) |
| `isUnpinnedImage` | 1 | LOW | none |
| `ExeDevDriver.create` | 29 | **HIGH** (lower-bound; interface with 7 impls) | `runCapHitDemo`, `provisionAdmittedRun`, `dispatch`, `runDispatch` |

**HIGH blast radius — how each fix was kept narrow:**

- **`readBoxFile` (HIGH, fanout + dispatch + setupGate).** No signature change, no new `BoxFileRead` arm, no `ExecResult` change. The two edits only re-route inputs *within* the existing fail-closed union: a budget-exhausted read that used to reach `unreadable` via SIGKILL now reaches `unreadable` directly, and a truncated-stderr failure moves from `oversized` (permanent) to `unreadable` (retryable) — which is strictly LESS destructive for `fanout-primitive.ts:817`'s `MARKER_UNUSABLE_TICKS_LIMIT`. Verified: `tests/providers/exedev/setup-gate.test.ts` 54/54 pass, and every marker/race test in `tests/fleet/patterns.test.ts` passes when run individually.
- **`assertRegistryAuthDeviation` (HIGH).** Not changed in signature or in any refusal arm. One comparison relaxed (date-only expiry now lapses at end-of-UTC-day instead of its first instant) — strictly fewer false refusals, no new acceptance shape. The new *caller* in `exeDevDriverFromEnv` runs the same gate earlier, so no path reaches a credential read that would not already have been refused.
- **`ExeDevDriver.create` (HIGH, lower-bound).** Signature, argv and both throw shapes unchanged. Purely additive observability: two new event fields (`mayExist`) and one new event (`image_pull_failed`) beside the existing `create_failed`. Nothing branches on either.

**`DEFAULT_IMAGE_REF` / `DEFAULT_IMAGE_BUILD_ID` declarations were NOT reformatted** — both `export const` lines are byte-identical to `main`, so `verify-image-pin.yml`'s grep and `publish-exedev-image.yml`'s occurrence count are unaffected. (Verify with `git diff -U0 src/providers/exedev/driver.ts | grep -c 'DEFAULT_IMAGE_REF ='` → 0.)

---

## Cross-file needs

For **`fix-fleet-src`** (owns `src/providers/index.ts`):

1. **Memoize the exedev factory** (or the whole `resolveDriver` result per name). `REGISTRY.get(name)` + `factory()` on every call means (a) `image_override` / `image_not_digest_pinned` / the new `image_sentinel` fire once per RESOLUTION, so a fanout resolving per box emits N copies, and (b) the registry credential file is re-opened, re-read and re-parsed N times per fanout, each copy left to the GC — and a PAT rotation mid-fleet becomes a hard failure at box k+1. I fixed the observability half in `driver.ts` (there IS now a `driver_construct_failed` line for that refusal); the duplication itself can only be fixed at the registry.
2. **Pass `ctx.requestId` into `exeDevDriverFromEnv`'s opts** at `index.ts:138`. Today the driver mints its own `newRequestId()` because the registry constructs with no options, so the constructor-time `image_override` line carries a propagation id present in nothing else. My new `driver_construct_failed` line has the same limitation and will inherit the fix for free — it already reads `opts.requestId` first.
3. FYI, not a request: `assertRegistryAuthDeviation` now runs one frame earlier inside `exeDevDriverFromEnv` (before the credential file is opened). If R5's "move the both-or-neither / auth-file gates onto the create path" lands in `index.ts`, that ordering moves with it; nothing in my change depends on where the factory is called from.

For **`fix-buildscript`** (owns `tests/providers/exedev/fixtures/fake-exedev.ts`): no change needed. Noting only that `DEFAULT_IMAGE_MARKER` interpolating `DEFAULT_IMAGE_BUILD_ID` (`fake-exedev.ts:134`) is now pinned from my side by a literal in `image-contract.test.ts` — if the fixture ever stops deriving from the constant, that literal is where it will surface.

---

## Behaviour changes for wave 2

Live-tier tests (F8/F9/F10) should know:

1. **`assertRegistryAuth` now refuses a password shorter than 8 bytes** (`registry-auth-invalid`, "password is shorter than 8 bytes"). Any live fixture using a short credential will refuse at construction.
2. **`create_failed` carries a new `mayExist` boolean**, and a pull-shaped substrate refusal additionally emits `exedev.image_pull_failed`. Any test asserting the exact create-failure event *shape* (rather than fields) will see the extra key/line. `tier1-registry-auth` is the likely consumer.
3. **`exedev.driver_construct_failed`** is emitted for every `exeDevDriverFromEnv` refusal, and **`exedev.image_sentinel`** for a sentinel-digest image. Both are `status: "error"` — a live harness that fails a round on "any error-status line" will now trip on a deliberate refusal test.
4. **A date-only `registryAuthDeviation.expiry` is now valid THROUGH that day** (was: refused from its UTC midnight). A live posture file written with today's date now works.
5. **A truncated-stderr `cat` failure classifies as `unreadable`, not `oversized`** — the fanout race will now RETRY that arm instead of giving it up as corrupt. Bounded by `PROBE_SKIP_TICKS_LIMIT` as before.

---

## Gates

```
$ bun test tests/providers/exedev/image-contract.test.ts tests/providers/exedev/read-box-file.test.ts
exit=0
 47 pass
 0 fail
 627 expect() calls
Ran 47 tests across 2 files. [384.04s]

$ bun test tests/providers/exedev/setup-gate.test.ts        # exercises readBoxFile / imageMarkerFailure
exit=0
 54 pass
 0 fail

$ bun test tests/providers/exedev/image-contract.test.ts tests/providers/exedev/read-box-file.test.ts \
           tests/providers/exedev/driver.test.ts tests/providers/exedev/sh-quote.test.ts \
           tests/fleet/patterns.test.ts
 220 pass
 1 fail        # tests/fleet/patterns.test.ts — NOT MINE, see below

$ bunx biome check src/providers/ tests/providers/
Checked 62 files in 1880ms. No fixes applied.

$ bunx tsc --noEmit | grep -E "src/providers/exedev|tests/providers/exedev"
(no output — 0 errors in my files)
```

**Not mine, verified:**

- `tests/fleet/patterns.test.ts` — `git diff --stat` shows **297 insertions across `src/fleet/fanout-primitive.ts` + `tests/fleet/patterns.test.ts`** from `fix-fleet-src`, both mid-edit. Failure counts changed between runs (3 → 1 → 8) and **every failing test passes when run individually** (`bun test tests/fleet/patterns.test.ts -t "…"` → 1 pass, 0 fail). The failing test bodies contain no reference to `readBoxFile`, `imageMarker`, or `ExeDevDriver`.
- `tests/fleet/dispatch*.test.ts`, `tests/fleet/approvers*.test.ts` — 5 s / 120 s timeouts under the loaded full-suite run; `src/providers/credentials.ts` and `src/providers/index.ts` are concurrently modified by `fix-fleet-src`.
- `tests/providers/exedev/image-assets.test.ts` (`DF2.10 AC6 — qds-run@.service`) — `oci/exedev/*` + that test are `fix-oci-image`'s (F4); `src/providers/exedev/assertions-in-box.sh` and `setup-gate.ts` are `fix-setup-gate`'s.
- `tests/scripts/build-exedev-image.test.ts` + `scripts/build-exedev-image.ts` tsc errors (`LicenseTableProblems`) — `fix-buildscript`'s (F1), mid-edit.
- `tests/fleet/patterns.test.ts` TS6133 (`chmodSync`, `MARKER_UNUSABLE_TICKS_LIMIT` unused) — same file, `fix-fleet-src`'s.
