# W2-A fix report — `image-contract.test.ts` + `fixtures/fake-exedev.ts`

Files edited (ONLY these two):

- `/Users/steve/QDS-Factory/tests/providers/exedev/image-contract.test.ts`
- `/Users/steve/QDS-Factory/tests/providers/exedev/fixtures/fake-exedev.ts`

No commits, no `git add`. No source-side gate weakened.

Gates: `bun test tests/providers/exedev/image-contract.test.ts` → **34 pass, 0 fail** ·
`bunx tsc --noEmit` → clean · `bunx @biomejs/biome check tests` → clean (164 files) ·
`bun test tests/providers/exedev/driver.test.ts tests/providers/exedev/setup-gate.test.ts`
(the other two consumers of the fixture I changed) → **114 pass, 0 fail**, including the two
timing tests flagged as known flakes.

---

## Part 1 — the three tests Wave 1 intentionally broke

| Test | Cause | Re-pin |
|---|---|---|
| `AC3 negative control: create() reads the DRIVER's field, never process.env` | C4's both-or-neither `image-pin-incomplete` | Both env call sites and the `process.env` mutation now set the **pair** (`QDS_EXEDEV_IMAGE` + `QDS_EXEDEV_IMAGE_BUILD_ID`), restored together in the same `finally` with `Reflect.deleteProperty`. `exeDevDriverFromEnv({}, …).image === DEFAULT_IMAGE_REF` unaffected. |
| `AC4: valid credential: in argv (the ratified D8 deviation) …` | C1's `registry-auth-unratified` | Constructed with `postureFile: writeRatifiedRegistryDeviation(dir)`. |
| `AC4: exe.dev stderr echoing the credential is redacted …` | same | Same fix, plus `captureLog(…, { expectThrow: true })`. |

The auditor's reading of the second one is right and the fix is the attestation, not a
relaxed gate: the test's own title said "the ratified D8 deviation" and its comment said the
path "requires a recorded ratification" while it constructed with no attestation and asserted
success. Supplying the record makes the title true.

New fixture `writeRatifiedRegistryDeviation(dir)` is **separate from** `writePostureAttestation`
on purpose — folding the ratification into the shared attestation would make every `setPublic`
test silently consent to the private-registry deviation too. Expiry is `2099-01-01` so the
suite cannot go red on a calendar date.

---

## Part 2 — findings, verdicts, and what landed

| Finding | Verdict | What changed |
|---|---|---|
| `captureLog` swallows the thunk's exception | **confirmed** | Rethrows unless `{ expectThrow: true }`. Two `{ lines }`-only callers now fail loudly if `create()` throws. |
| `newArgv()` returns `[]` ⇒ vacuous `.not.toContain` | **confirmed** | Throws a named error when no `ssh exe.dev new` reached the seam. The default-off test additionally asserts the **full** argv with `toEqual`, so the absence claim rides a positive shape. |
| `fake.creates[0]?.registryAuth` optional chaining | **confirmed** | All four sites are now whole-array `toEqual`, which also pins that no *extra* create happened. |
| The fake falls through to the HOST `/etc` for any verb but `test -f`/`cat` | **confirmed** | The path-matched branch now ends in exit 64 with a named "unsimulated verb (readBoxFile drift?)" stderr. It can no longer reach `spawnLocal`. |
| `DEFAULT_IMAGE_MARKER` hand-copies `piVersion`/`bunVersion` | **confirmed** | Now `PI_VERSION` imported from `scripts/build-exedev-image.ts` and `readBunPin(readFileSync(<repo>/package.json))`. The test's local `marker()` helper derives from `JSON.parse(DEFAULT_IMAGE_MARKER)` instead of carrying a *third* copy. |
| Fail-closed `why` regexes are supersets | **confirmed** | Each arm anchored to its own sentence (`/is not parseable JSON:/`, `/is not a JSON object/`, `/is missing or empty for: piVersion, bunVersion, builtAt, gitSha/`, `/is \d+ bytes, at or over the 4096-byte cap/`, `buildId "f{16}" != the repo pin "<pin>"`, …). A generic-note implementation now fails six of nine arms. |
| `unreadable`/`oversized` unreachable through the fake | **confirmed** | Three new `FakeBoxConfig` knobs — `imageMarkerProbeExit`, `imageMarkerCatExit`, `imageMarkerTruncated` — with ssh's own stderr spellings for 255/137. Both arms now covered. |
| D1/D2 transport-fault regression (fix-gate §3) | **added** | New test: probe 255 and `cat` 137 → `error.code === "image-marker-unreachable"`, message matches the exit-specific sentence, asserts it is **not** the absence sentence, `assertions === ["A","B"]`. |
| `remediation.includes(secret)` is element-equality | **FALSE POSITIVE** | `ProviderError.remediation` is `readonly remediation: string` (`src/providers/errors.ts:22`), so `.includes` is substring containment and the original assertion was correct. Kept it and added a serialized-form assertion beside it so the claim survives the field ever becoming a list. |
| `expect(fake.calls).toEqual([])` on a `beforeAll` fake | **confirmed** | That test now builds a local fake in a `try/finally`. |
| `evidenceDir` never `mkdirSync`'d | **confirmed** | Created alongside its two siblings. |
| 180 s across seven create→fill→gate cycles | **confirmed** | Now nine cycles at 600 s, with the reasoning in a comment. (Measured wall time for the whole file: ~33 s on an idle machine — the budget is headroom for a loaded one, which is the condition that truncated the loop.) |
| Q-4 needs a pinning test | **added** | `gate B does NOT compare imageRef: a mismatched ref with the right buildId PASSES` — a marker whose `imageRef` is a tenant-mirror ref with the correct `buildId`, asserted `ready === true`, `error === undefined`. |
| `isUnpinnedImage` mutable-tag case | **added** | Tag ⇒ `false` (it answers one question: is the pin still the all-zeros sentinel), plus the zero-argument spelling the publish gate actually calls. |
| `assertRegistryAuth` 512-byte arm | **added** | 513 bytes refused; **512 accepted** — the boundary is pinned in both directions, so a drift to `>=` is caught. |
| `IMAGE_REF_RE` uppercase / dotless-host-with-port | **added, refusal pinned** | Both refused. Uppercase in the *path* is the OCI rule (and the reason the remediation example is lowercase). Dotless-host-with-port (`registry:5000/team/img:v1`) is legal to docker but refused here; the comment states the rule being enforced ("a dotted host, or the literal `localhost`") so a future reader sees a decision, not an accident. `localhost:5000/...` remains asserted-accepted. |

### Also added (fix-driver §4–5)

- **AC4 ratification negative controls** — twelve arms against the exported
  `assertRegistryAuthDeviation` directly (absent file, unparseable file, no record, `null`,
  array, `scope: "repo"`, non-string scope, missing/unparseable/**passed** expiry, blank and
  missing `rotationOwner`), each asserting `registry-auth-unratified`, that the message names
  the file, that the remediation names the shape, and that neither echoes the canary. Then the
  complete record passing, the same gate firing from the constructor, and default-off proving
  the gate does **not** fire for the public path.
- **C3** `QDS_EXEDEV_REGISTRY_AUTH_FILE`: 0644 ⇒ `registry-auth-file-mode` with the octal mode
  named and no credential echoed; absent ⇒ `registry-auth-unreadable`; 0600 loads; and the
  file-loaded credential is **still** subject to the ratification gate (the indirection is not
  a way around it).
- **C4** both directions plus the empty-string ("unset") and whitespace (`image-build-id-invalid`) edges.
- **C5** explicit argument beats the environment.
- **C7** six `imageBuildId` shapes refused in the constructor, one accepted, `calls` empty.
- **C10** `qdsbot:pa#ss` refused (in the malformed table, with the truncation rationale).
- **C11** a tag-pinned driver emits exactly one `exedev.image_not_digest_pinned`; a
  digest-pinned one emits none. Uses a new `captureLogSync` because the emit is in the
  **constructor**.
- **C9** every `exedev.create*` line — including `create_failed` — carries `imageRef`,
  `imageDigest` and `imageBuildId`; `create_requested` carries `create_ms: 0`.
- **C2** a *rejecting* `FakeCommand`: `create-failed`, `[registry-auth redacted]`, neither the
  pair nor the secret in the message, and a `create_failed` line with `exitCode: null`,
  `status: "error"`, `registryAuthUsed: true`.
- **C8** stderr echoing **only** the password half is redacted (the existing test used the
  full-pair spelling only).
- **C12** the remediation is followable: its own example, with a real digest substituted,
  passes `assertImageRef`.
- The `debugCommands` now assert that the operator is given a way to read the file that
  refused them (`cat /etc/qds-image.json`), and `result.error.message === b.note` pins that
  the typed payload and the assertion note do not drift apart.

---

## One assertion I wrote and then corrected

The malformed-credential loop initially asserted "the refusal never echoes the password half"
for **every** row, including `["empty password", "qdsbot:"]`. `"...".includes("")` is true of
every string, so that row was a claim no implementation could satisfy — it failed, correctly,
and is now skipped with the reason recorded in a comment rather than special-cased into
passing. No source behaviour is implicated.

## No source/test conflict

Nothing in this file required weakening a Wave 1 gate. Every re-pin supplies what the source
now demands (a complete pin pair, a recorded ratification); every new test asserts the source's
stated behaviour rather than negotiating with it. The only finding I refused to act on is the
`remediation` one, and it is refuted by the type declaration rather than by preference.

## Not mine

No failure in `driver.test.ts` or `setup-gate.test.ts` in the verification run above (0 fail
across 114). `bun test tests/providers/exedev/image-contract.test.ts` is 34/34.
