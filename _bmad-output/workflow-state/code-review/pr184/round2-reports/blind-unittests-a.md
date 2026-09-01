# Blind adversarial review — chunk-unittests-a.diff

Scope: diff only (`tests/providers/exedev/image-contract.test.ts`, `tests/providers/exedev/read-box-file.test.ts`). Line references are diff-relative to /tmp/pr184-r2/chunk-unittests-a.diff.

## F1 [MEDIUM] Canary-scrub assertions in the ratification loop cannot fail

Location: diff lines 472–482 (test "AC4: the private path is REFUSED unless the INV-IBOX-3 deviation is RATIFIED").

Claim: `expect(err.message.includes(CANARY_SECRET)).toBe(false)` and the matching `err.remediation` check are constant-true. Inside this loop the function under test is `assertRegistryAuthDeviation(path)` — it receives only a filesystem path, and none of the posture files written by `posture()` (nor the garbage file, nor the paths themselves) contain `CANARY_SECRET`. No implementation of the gate, however leaky, could put the canary into these messages, because the canary does not exist anywhere in its input universe.

Failure scenario this misses: a real leaky future arm that "took the credential to explain itself" (the comment's own scenario) would necessarily change the call signature or read the credential from somewhere; this test would keep calling the one-argument form with canary-free inputs and keep passing. The scrub property here is asserted but not tested. (The constructor arm at diff lines 491–496 is fine — there the credential is actually supplied.)

## F2 [MEDIUM] The "default argument IS the shipped pin" assertion asserts boolean agreement, not identity

Location: diff lines 109–111 (`expect(isUnpinnedImage()).toBe(isUnpinnedImage(DEFAULT_IMAGE_REF))`).

Claim: the comment says this pins that the zero-arg default is the shipped pin. It pins only that the two calls agree on one boolean. The assertion passes when both are the sentinel, passes when both are non-sentinel, and passes when the default argument is a completely different non-sentinel reference (a tag, someone else's image, an empty string that happens not to be all-zeros). It can fail only in the single world where exactly one side is the all-zeros sentinel.

Failure scenario: the default parameter drifts to a stale hard-coded digest while `DEFAULT_IMAGE_REF` moves on. Publish workflow calls `isUnpinnedImage()` against the wrong pin; this test stays green. `expect(isUnpinnedImage()).toBe(false)` plus a direct identity check on the default would be falsifiable; this is not.

## F3 [MEDIUM] The 512-byte credential boundary is split across two different arms

Location: diff lines 385–387 (rejection case, via constructor), 399–405, and 413–416 (acceptance, via bare `assertRegistryAuth`).

Claim: the 513-byte rejection is exercised through `new ExeDevDriver({... registryAuth ...})`, but the exactly-512 acceptance — the half the comment says exists to catch a `>` → `>=` drift — is exercised only through the exported `assertRegistryAuth` function. If the constructor applies its own length check (or wraps the assert with a stricter one), the constructor can refuse a legal 512-byte credential while the suite stays green, because the acceptance was never asserted at the trust boundary every other case in this test uses.

Failure scenario: constructor grows `value.length >= 512` guard; 513 still refuses (test passes), `assertRegistryAuth` still accepts 512 (test passes), production constructor refuses a legal credential — exactly the regression the comment claims this boundary check prevents.

## F4 [MEDIUM] `imageDigest` log assertions compare the implementation to itself

Location: diff lines 596 and 643 (`expect(line.imageDigest).toBe(imageDigestOf(PINNED))`, and again on the `create_failed` line).

Claim: `imageDigestOf` is imported from the same source module as the driver. If the driver's log emission derives `imageDigest` via the same helper, the assertion is helper-output vs helper-output. A regression in `imageDigestOf` that returns `undefined`/`null` for every reference makes both sides equal (`undefined === undefined`) and the assertion passes while every create event silently loses its digest — the exact "silence an operator has to notice" the neighboring test claims to prevent.

Failure scenario: `imageDigestOf` regex breaks on the `@sha256:` split; logs carry `imageDigest: undefined`; test green. The expected value is knowable by hand in this test (`"sha256:" + "a1b2c3d4".repeat(8)"`) and should have been a literal.

## F5 [MEDIUM] The marker byte cap's boundary is never exercised — only its prose

Location: diff lines 791–796 (over-cap case, `IMAGE_MARKER_MAX_BYTES + 64` extra) and the message regex "is \d+ bytes, at or over the N-byte cap".

Claim: the only size case is far over the cap. There is no case at exactly `IMAGE_MARKER_MAX_BYTES` (which the message wording "at or over" asserts is refused) and none at `IMAGE_MARKER_MAX_BYTES - 1` (which must pass). The `>=` semantics of the cap exist in this suite only as a regex over an English sentence, not as an exercised behavior.

Failure scenario: the cap check drifts to `>` (off by one). Every message still says "at or over", the far-over case still refuses, the suite passes, and a marker at exactly the cap — the boundary the wording promises is refused — is accepted and parsed.

## F6 [LOW] "ANNOUNCED once" is only established for construction; a per-create re-announcement passes

Location: diff lines 314–336 (test "a TAG-pinned image is admitted and ANNOUNCED once…").

Claim: `toHaveLength(1)` is asserted over `captureLogSync` around construction only; `create()` is never called on the tagged driver. A driver that additionally emits `image_not_digest_pinned` on every `create()` — the log-noise regression the title's "once" exists to forbid — is unobservable by this test.

Failure scenario: the warn moves into (or is duplicated in) `create()`; fleet logs carry one warning per box instead of one per driver; test green.

## F7 [LOW] Env-precedence buildId is not guaranteed distinct from the default it must beat

Location: diff lines 218–245 (env override test, `envBuildId = "abcdef0123456789"`) and 297–311 (precedence test asserting `driver.imageBuildId === DEFAULT_IMAGE_BUILD_ID` against env `"abcdef0123456789"`).

Claim: the image half deliberately uses a "someone-else" reference to guarantee distinctness, but the buildId half uses a plausible 16-hex literal with no assertion that it differs from `DEFAULT_IMAGE_BUILD_ID`. If the constants coincide (now or after a rebuild that stamps that value), `expect(fromEnv.imageBuildId).toBe(envBuildId)` and the precedence assertion both become unable to distinguish env-won from arg-won.

Failure scenario: `DEFAULT_IMAGE_BUILD_ID` is or becomes `"abcdef0123456789"`; precedence for buildId inverts; both tests stay green. One line (`expect(envBuildId).not.toBe(DEFAULT_IMAGE_BUILD_ID)`) would close it.

## F8 [LOW] The new constructor-refusal scrub checks `message` only; `remediation` of the new cases is unchecked

Location: diff lines 399–411 (the per-case scrub `if (secret.length > 0) expect(err.message.includes(secret)…)`).

Claim: for the newly added cases (`qdsbot:pa#ss`, the 513-byte password), only `err.message` is scanned for the rejected secret. `err.remediation` — which a helpful implementation is most tempted to seed with "you passed `qdsbot:pa#ss`; write it as…" — is not checked in this loop. The separate test that does scan remediation and the JSON serialization (diff lines 546–558) iterates its own value list, which this diff does not show to include these new cases.

Failure scenario: refusal remediation for the over-length case echoes the oversized password to show the operator "what you passed"; 513 bytes of credential land in the remediation string; this loop passes.

## F9 [LOW] The "followable remediation" extraction fails a correct implementation on trailing prose

Location: diff lines 178–186 (`example.slice(example.indexOf("ghcr.io")).replace("<64 hex>", …)`).

Claim: the slice runs from the FIRST occurrence of "ghcr.io" to the END of the remediation string. Any remediation that (a) mentions a `ghcr.io/...` reference earlier in its prose (e.g., naming the shipped pin), or (b) has any text after the example — a closing period, a quote, a second sentence — produces an "example reference" polluted with prose, which `assertImageRef` rightly refuses, failing the test against a perfectly followable remediation. The test encodes an undocumented structural requirement ("the example is the last thing in the string and the only ghcr.io mention") rather than the property in its title.

Failure scenario: remediation is reworded to `"use a digest-pinned reference like ghcr.io/owner/image@sha256:<64 hex>."` — followable, correct, red suite.

## F10 [LOW] The 0644 fixture mode is subject to the process umask; the negative test evaporates under umask 077

Location: diff line 513 (`writeFileSync(loose, …, { mode: 0o644 })`).

Claim: `writeFileSync`'s `mode` is masked by the process umask at creation. On a hardened runner with `umask 077`, the "loose" file is created 0600; the driver correctly loads it, `refusal()` finds no throw, and the test fails — an environment-dependent red that reads as a driver bug, on the one test whose purpose is proving 0644 is refused. An explicit `chmodSync(loose, 0o644)` after the write is what actually pins the mode.

Failure scenario: CI image sets umask 077; this test (and only this test) flakes red on a correct implementation; the finding is triaged as a permissions regression in the driver.

## F11 [LOW] Two scrub "secrets" are the literal English word "password" — the check constrains vocabulary, not scrubbing

Location: diff lines 407–411 applied over the case list including `[":password"]` and `["qds bot:password"]` (context lines 377–378).

Claim: for those cases `secret` computes to the string `"password"`, so `expect(err.message.includes("password")).toBe(false)` forbids the refusal message from ever containing the word "password" — a message like "the password half may not be empty" fails the leak check despite leaking nothing. Conversely the check carries zero leak signal for these arms (matching the word proves nothing about the credential). The distinctive-canary discipline used elsewhere in the file (`ghp-LEAKCANARY-…`) was not applied to this loop's values.

Failure scenario: refusal messages are reworded to name "the password half" for clarity; two cases go red with no leak anywhere; the "fix" is to reword the error into something less clear, or to weaken the scrub loop.
