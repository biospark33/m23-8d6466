# W1-C fix report — `src/providers/exedev/driver.ts`

Cluster: 13 findings (C1–C13). **13 fixed, 0 false positives, 0 deferred.**
One item (C9's `boot_ready_ms`) is answered with a reasoned refusal to invent a
measurement rather than a code change — detailed under C9.

Only `src/providers/exedev/driver.ts` was edited. No commits, no `git add`.

---

## Verdicts

| ID | Verdict | What changed |
|----|---------|--------------|
| C1 | **fixed** | New exported `assertRegistryAuthDeviation(postureFile)`; called from the constructor immediately after `assertRegistryAuth`. |
| C2 | **fixed** | The whole `control()` call is wrapped; the rejection path now scrubs and emits `create_failed`. |
| C3 | **fixed** | `statSync(authFile).mode & 0o077` refusal in `exeDevDriverFromEnv`, before the read. |
| C4 | **fixed** | Both-or-neither refusal (`image-pin-incomplete`) in `exeDevDriverFromEnv`, naming the missing var. |
| C5 | **fixed** | `...opts` moved LAST — explicit argument now beats the environment. |
| C6 | **fixed** | Docstring says `QDS_EXEDEV_REGISTRY_AUTH_FILE`. |
| C7 | **fixed** | `imageBuildId` validated `/^[0-9a-f]{16}$/` in the constructor (`image-build-id-invalid`). |
| C8 | **fixed** | `redactRegistryAuth` scrubs the password half independently, pair-first. |
| C9 | **fixed** (partial by design) | All four image events route through `imageFields()`; `imageFields()` gains `imageBuildId`; `create_requested` reports `create_ms: 0`. `boot_ready_ms` NOT added — see below. |
| C10 | **fixed** | `#` added to the metacharacter class, with the truncation rationale in a comment. |
| C11 | **fixed** | `image_not_digest_pinned` emit in the constructor when `imageDigestOf(this.image) === null`. |
| C12 | **fixed** | Remediation example lowercased (`ghcr.io/owner/image@sha256:<64 hex>`). |
| C13 | **fixed** | `isUnpinnedImage`'s comment now states the *guarantee* (the workflow refuses to publish against a sentinel pin; the contract test refuses to merge one) and explicitly leaves the mechanism to the workflow. |

Every finding was located in the real file and verified before editing. The one
pre-refuted blind finding ("`readFileSync` used with no import") was not acted
on; the import is real, and it is now `readFileSync, statSync`.

---

## C1 — the AC4 attestation gate (the largest item)

AC4 verbatim: the private path "is refused unless the ratified deviation
INV-IBOX-3 requires is recorded where this driver already reads operator
attestations (`postureFile`), naming the PAT's `read:packages` scope, expiry and
rotation owner."

Implemented on the `setPublic` pattern (read `postureFile`, JSON.parse in a
try/catch, refuse on every incomplete shape), as a module-level exported
function so it is unit-testable without constructing a driver:

```ts
export function assertRegistryAuthDeviation(postureFile: string): void
```

Record shape read from the SAME `postureFile` `setPublic` uses:

```json
{
  "vmSharing": "admins-only",
  "registryAuthDeviation": {
    "scope": "read:packages",
    "expiry": "<ISO-8601>",
    "rotationOwner": "<owner or rota>"
  }
}
```

Refusal arms, all fail-closed, all code `registry-auth-unratified`:

1. the posture file is absent or unreadable;
2. it parses but carries no `registryAuthDeviation` object (a non-object, `null`
   and an array all refuse);
3. `scope` is not a string, or its whitespace/comma-separated tokens do not
   include `read:packages`;
4. `expiry` is not a `Date.parse`-able string;
5. **`expiry` is in the past** — a lapsed ratification is not a ratification,
   and the story's own note ("an expired PAT breaks *every* box create at once")
   is the argument for catching it at one box rather than at all of them;
6. `rotationOwner` is missing or blank.

Called from the constructor right after `assertRegistryAuth(opts.registryAuth)`,
so shape and ratification refuse at the same trust boundary, before any command
exists and before any box is paid for. `this.postureFile` is now assigned
*before* the `registryAuth` block (the only ordering change in the constructor).

Arm 5 is the one judgement call worth flagging: the AC says the record must
*name* the expiry, not that the expiry must be live. Enforcing it is the
fail-closed direction and makes the field load-bearing rather than decorative.
If the fleet decides a lapsed record should warn rather than refuse, that is a
one-line change in arm 5 — but the default should be refusal.

---

## C9 — `boot_ready_ms` is not added, deliberately

Repo-wide grep over `src/ tests/ scripts/ .github/` still returns zero hits, so
the finding is accurate. It is not fixed because **there is no honest place in
this file to measure it**: `create()` returns when the substrate has *named* the
VM, which is strictly before the box is bootable; boot readiness is what the
setup gate proves, in `setup-gate.ts` — a file this cluster does not own.

Emitting a constant `boot_ready_ms: 0` on every create event would satisfy the
letter of "a field never evaluated reports `0`" while creating a field that can
never be anything but zero — a measurement invented to pass a grep. The
contract's `0` rule is for a field some events evaluate and others do not
(`create_ms`, which is now correctly `0` on `create_requested`).

**Recommendation for the lead:** either the setup-gate owner emits
`boot_ready_ms` where boot readiness is actually established, or the
Observability Contract drops the field. Both are outside `driver.ts`.

---

## GitNexus blast radius

The workspace index predates this PR, so the new symbols (`exeDevDriverFromEnv`,
`assertRegistryAuth`, `assertImageRef`, `isUnpinnedImage`, `imageFields`,
`redactRegistryAuth`) resolve as *not found* — the index has not been rebuilt
since these landed. Reindexing is a ~10-minute repo-wide operation and would
race the four other agents editing this tree, so the fan-out for the new symbols
was established by exhaustive grep instead and is recorded as such.

| Symbol | Blast radius | Risk |
|--------|--------------|------|
| `ExeDevDriver` (class) | gitnexus: **22 impacted, 9 direct, 1 process (`scripts/pipeline-run-remote.ts:main`), 1 module (Scripts)**. Epistemic note from the tool: lower-bound — `copyFile` is an interface with 4 interface-level consumers not traced to the concrete symbol. | **MEDIUM** (not HIGH; `ExeDevDriver.create`'s own HIGH rating is unchanged — its signature is untouched and every edit inside it is additive) |
| `ExeDevDriver.create` | signature UNCHANGED. Edits are: one `try` around the existing `control()` call, one extra `create_failed` emit on the rejection arm, and field-set changes on three emits. No caller sees a new shape; the rejection type on the spawn-failure path becomes `ExeDevDriverError` instead of the raw runner error (strictly more typed, and the message is now scrubbed). | MEDIUM, additive |
| `exeDevDriverFromEnv` | grep: **1 production caller** — `src/providers/index.ts:12,138` (`registerDriver("exedev", () => exeDevDriverFromEnv())`, called with no arguments, so C4/C5 cannot affect it) — plus `tests/providers/exedev/image-contract.test.ts:35`. | LOW |
| `assertRegistryAuth` | grep: called from the constructor and `image-contract.test.ts:312`. Adding `#` only widens the refusal set. | LOW |
| `assertImageRef` | grep: constructor + `image-contract.test.ts:33`. Comment/remediation text only; the regex is untouched. | LOW |
| `isUnpinnedImage` | grep: `image-contract.test.ts:88,100,101` only — no production caller. Comment only. | LOW |
| `imageFields` / `redactRegistryAuth` | private methods, callers all inside this file. | LOW |
| `assertRegistryAuthDeviation` | new export, 1 caller (the constructor). | none |

No HIGH or CRITICAL symbol was edited in a signature-changing way, so there is
no risk warning to escalate.

---

## Verification

- `bunx tsc --noEmit` — **clean for `driver.ts`**. One error repo-wide, in
  another agent's file and not mine:
  `scripts/build-exedev-image.ts(105,44): error TS6133: 'tokenizeArgs' is declared but its value is never read.`
- `bunx @biomejs/biome check src` — **clean** ("Checked 108 files, no fixes applied").
- `bun test tests/providers/exedev/` — 182 pass, 1 todo, 12 fail, 3 errors.
  Of the 12, **3 are mine and intentional** (below). The other 9 are not:
  - 5 `setup gate — E2E chain` failures and 2 `AC1c` failures trace to
    `setup-gate.ts` / `transport.ts`, both of which were modified in the working
    tree by the parallel W1-D agent while this run executed. The AC1c body is
    proof: `b?.note` is now `{ code: "image-marker-mismatch", message, remediation }`
    — that is D3's payload fix landing, not anything in this cluster.
  - `copyFile is box → host` (timed out after 5000 ms) and
    `a re-fill switches to the existing branch` (timed out after 30000 ms), plus
    the "Unhandled error between tests" cross-talk (`Expected "run-output",
    Received "B"`), are load/dangling-process artifacts of several agents running
    suites concurrently — no assertion about behaviour this cluster changed.

---

# BEHAVIOUR CHANGES FOR THE TEST WAVE

Three currently-failing tests, all in
`tests/providers/exedev/image-contract.test.ts`, plus two gaps worth new
coverage. **All are intentional consequences of C1 and C4.**

### 1. `image-contract.test.ts:234` — "AC3 negative control: create() reads the DRIVER's field, never process.env"

**Now throws** `ExeDevDriverError` code `image-pin-incomplete`:
> `QDS_EXEDEV_IMAGE is set but QDS_EXEDEV_IMAGE_BUILD_ID is not — an image reference and its buildId are one pin (INV-IBOX-2) …`

Two call sites in that test set only the image:
- `:234` `exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: envOnly }, { run: fake.run })`
- `:236` `exeDevDriverFromEnv(process.env, { run: fake.run })` (the test sets
  `process.env.QDS_EXEDEV_IMAGE` at `:225`)

**New expected behaviour:** pass the pair. Both call sites need
`QDS_EXEDEV_IMAGE_BUILD_ID` alongside (any 16 lowercase hex, e.g.
`"abcdef0123456789"`, or `DEFAULT_IMAGE_BUILD_ID`), and `:225` must set the
paired `process.env` var too (and restore it in the same `finally` with
`Reflect.deleteProperty`, matching the existing pattern).
`exeDevDriverFromEnv({}, …).image === DEFAULT_IMAGE_REF` at `:241` is unaffected.

**Also re-pin, opposite direction:** `exeDevDriverFromEnv(env, opts)` precedence
reversed (C5). A test asserting the env wins over an explicit `opts.image` would
now fail; none exists today, and the new contract is **explicit argument wins**.

### 2. `image-contract.test.ts:328` — "valid credential: in argv (the ratified D8 deviation) — in NO log line and NO provenance field"

**Now throws at construction** — `ExeDevDriverError` code
`registry-auth-unratified`, because `new ExeDevDriver({ run, image, registryAuth })`
falls back to `postureFile = ".sandbox/exedev-posture.json"`, which does not exist
in the test environment.

The auditor's HIGH was precisely that this test **inverts the AC**: its own title
says "the ratified D8 deviation" and its comment says the path "requires a
recorded ratification", while it constructs with no attestation and asserts
success.

**New expected behaviour:** the test must supply a `postureFile` carrying a
complete `registryAuthDeviation`. Suggested fixture (in
`fixtures/fake-exedev.ts`, which the test wave owns — beside
`writePostureAttestation`, which should keep its current shape so `setPublic`
tests are untouched):

```ts
/** A posture file whose INV-IBOX-3 deviation is RATIFIED — AC4's private arm. */
export function writeRatifiedRegistryDeviation(dir: string): string {
  const path = join(dir, "exedev-posture-ratified.json");
  writeFileSync(path, `${JSON.stringify({
    vmSharing: "admins-only",
    attestedAt: "2026-08-15T00:00:00.000Z",
    registryAuthDeviation: {
      scope: "read:packages",
      expiry: "2099-01-01T00:00:00.000Z",   // far future: never expires the suite
      rotationOwner: "platform-oncall",
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return path;
}
```

Then `new ExeDevDriver({ run: fake.run, image: PINNED, registryAuth: VALID_AUTH, postureFile: writeRatifiedRegistryDeviation(dir) })`.
Everything the test asserts after construction (argv shape, no credential in any
line, `registryAuthUsed: true`) is unchanged and still passes.

### 3. `image-contract.test.ts:403` — "exe.dev stderr echoing the credential is redacted before it reaches the thrown error"

Same cause and same fix as #2 — the driver is constructed with `registryAuth` and
no attestation. Add the ratified `postureFile`. All redaction assertions still hold.

### 4. NEW coverage the fixes create (AC4's missing negative controls)

The AC4 gate now has refusal arms with no test. These are the negative controls
the auditor's HIGH implies:

- constructing with `registryAuth` and **no** posture file → `registry-auth-unratified`;
- posture file present, `vmSharing: "admins-only"`, but **no** `registryAuthDeviation` → refused;
- `registryAuthDeviation` present but `scope: "repo"` (not naming `read:packages`) → refused;
- `expiry` absent / not a date → refused;
- `expiry` in the **past** → refused (message names the expiry and says re-ratify or rotate);
- `rotationOwner` blank / absent → refused;
- complete record → constructs, and `--registry-auth` reaches argv.
- **The refusal must not echo the credential.** Same discipline as
  `assertRegistryAuth`'s test: assert `message`/`remediation` contain neither
  `VALID_AUTH` nor `CANARY_SECRET`. (It cannot today — the function never sees
  the credential — but that is worth pinning.)

`assertRegistryAuthDeviation` is exported, so all of the above can be tested
directly with a temp file, no driver needed.

### 5. NEW coverage for the other behaviour changes

- **C2 (thrown `control()`):** a `FakeCommand` that *rejects* with
  `` new Error(`spawn ssh new --registry-auth ${VALID_AUTH} failed`) `` — assert
  the thrown `ExeDevDriverError` is code `create-failed`, that its message
  contains `[registry-auth redacted]` and neither `VALID_AUTH` nor
  `CANARY_SECRET`, and that a `create_failed` line was emitted with
  `exitCode: null`, `status: "error"` and `registryAuthUsed: true`. Today's
  redaction test only covers the non-zero-exit shape.
- **C8 (password-half redaction):** stderr echoing **only** `CANARY_SECRET`
  (not `USER:PASS`) must still come back redacted. The existing test uses the
  full-pair spelling only.
- **C3 (0600):** `QDS_EXEDEV_REGISTRY_AUTH_FILE` pointing at a `0644` file →
  `ExeDevDriverError` code `registry-auth-file-mode`, message naming the octal
  mode; a `0600` file loads. (No test covers this env var at all today.)
- **C4 both directions:** buildId-only set → `image-pin-incomplete` naming
  `QDS_EXEDEV_IMAGE`; both set → constructs and both fields take.
- **C7:** `new ExeDevDriver({ imageBuildId: "" })` and `{ imageBuildId: " " }`
  and `{ imageBuildId: "NOTHEX" }` → `image-build-id-invalid`.
  `exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: <ref>, QDS_EXEDEV_IMAGE_BUILD_ID: " " })`
  → same code (the whitespace value is non-empty, so it reaches the constructor).
- **C10:** `assertRegistryAuth("qdsbot:pa#ss")` → `registry-auth-invalid`,
  value not echoed.
- **C11:** constructing with a **tag** image (e.g. via
  `exeDevDriverFromEnv({ QDS_EXEDEV_IMAGE: "ghcr.io/x/y:latest", QDS_EXEDEV_IMAGE_BUILD_ID: … })`)
  under `captureLog` emits one `exedev.image_not_digest_pinned` line; a
  digest-pinned image emits none. Note `captureLog` must wrap the
  **construction**, not just the create — the emit is in the constructor.
- **C9:** every `exedev.create*` line now carries `imageDigest` **and**
  `imageBuildId` (including `create_failed`, which previously carried neither);
  `create_requested` carries `create_ms: 0`. The existing loops at `:359-361`
  and `:377-381` can be tightened from `imageRef` to the full `imageFields()`
  set.
- **C12:** `assertImageRef` on the string inside its own remediation
  (`ghcr.io/owner/image@sha256:<64 hex>` with a real 64-hex digest) must NOT
  throw — the "the remediation is followable" pin.

### 6. Not a test change, but note for the W1-A/CI agent (C13)

`isUnpinnedImage`'s comment now claims the workflow **refuses to publish while
the pin is still a sentinel**, and deliberately does not name a step. That
guarantee is currently false until A12 lands in
`.github/workflows/publish-exedev-image.yml`. The two must land in the same PR.
