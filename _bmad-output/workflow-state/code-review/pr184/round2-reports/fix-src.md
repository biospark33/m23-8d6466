# fix-src — round 2 fixes, src cluster (driver/transport/setup-gate/assertions-in-box + tests/providers/exedev)

Pre-flight constraint check: `assertions-in-box.sh` is NOT a `deriveBuildId` input — verified
against `scripts/build-exedev-image.ts:475-490` (inputs are baseDigests ‖ bunVersion ‖ piVersion ‖
dockerfile ‖ systemdFiles; the sh script appears nowhere in `gatherBuildIdInputs`). No file under
`oci/exedev/**` or `scripts/build-exedev-image.ts` was touched. `setupGate` and
`ExeDevDriver.create` signatures unchanged (additive edits only). gitnexus impact run on
`readBoxFile` (HIGH — fanout + setupGate), `imageMarkerFailure` (LOW), `exeDevDriverFromEnv`
(LOW); the HIGH is addressed under "Fix 11" below.

## DRIVER.TS

1. **FIXED** — Scope exclusivity (edge-src F2, blind-src F2, auditor F3). `driver.ts`
   `assertRegistryAuthDeviation`: scope now splits on `[\s,]+`, drops empties, and every token
   must be `read:packages` (non-empty list). Marked in-comment as a round-2 strengthening beyond
   AC4's literal "naming" terms, **pending story ratification**. Refusal message stays
   credential-free and now says "and no broader scope". Test: new refused case
   "the scope lists broader grants ALONGSIDE read:packages" (`repo admin:org read:packages
   <canary>`), canary doubling as leak input.

2. **FIXED** — Strict ISO-8601 expiry (blind-src F5, edge-src F11, auditor F3). Bare `Date.parse`
   replaced by `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$` THEN
   `Date.parse` (the regex admits 2030-13-45; parse is the second half, not a fallback).
   Date-only allowed (spec'd UTC midnight); date-times must carry Z/offset so the lapse instant is
   host-independent. Three distinct refusals now: absent ("names no expiry"), present-but-malformed
   (accurately worded — no longer "names no"), lapsed (unchanged). Ratification-pending comment on
   the arm. Tests: refused timezone-less date-time + engine-parseable-non-ISO ("March 1 2099");
   accepted date-only and explicit-offset spellings. **Needs story-ratification text** (see bottom).

3. **FIXED** — Expiry TOCTOU (blind-src F4). `create()` re-asserts
   `assertRegistryAuthDeviation(this.postureFile)` when `this.registryAuth` is set, before the
   request event / command build. One local file read per create; signature unchanged. A lapsed
   ratification now stops the NEXT create with the typed `registry-auth-unratified` refusal.

4. **FIXED** — Auth-file read (edge-src F8, blind-src F12). `exeDevDriverFromEnv` now opens ONCE
   with `O_RDONLY|O_NONBLOCK` (a FIFO with no writer returns instead of hanging the factory),
   `fstatSync(fd)` judges the very fd read: `isFile()` refusal (typed, `registry-auth-unreadable`,
   names the FIFO/device hang), mode refusal (unchanged code), NEW owner check
   (`stat.uid === process.getuid()` when getuid exists → `registry-auth-file-mode`), then
   `readFileSync(fd)` + `closeSync` in finally. Stat→read swap window removed.
   **SKIPPED (per triage)**: blind-src F12's non-POSIX arm — this factory targets macOS/Linux;
   `process.getuid` absence simply skips the owner arm, and the "synthetic st_mode" platform
   concern is out of scope (recorded here as directed).

5. **FIXED** — JSON parse-error echo (blind-src F14). The unreadable-attestation catch now
   distinguishes: `SyntaxError` → fixed "the attestation is not valid JSON" (no snippet — V8
   quotes file content); fs errors keep `e.message`. Paired with test a-F1 (canary now in the
   garbage file's bytes, so the scrub is falsifiable).

6. **SKIPPED (verified) + belt** — Empty-password redact garbage (blind-src F6). Verified:
   `this.registryAuth` is assigned in exactly one place (constructor, after `assertRegistryAuth`,
   driver.ts constructor `if (opts.registryAuth !== undefined)` block), and `assertRegistryAuth`
   refuses `secret.length === 0` ("password is empty") before that assignment; the
   `exeDevDriverFromEnv` path routes the file-loaded credential through the same constructor. A
   whitespace-only file trims to `""`, which fails the no-colon arm. So the empty-secret split
   cannot occur today. Belt added anyway in `redactRegistryAuth`: `secret.length === 0 → return
   text`, with a comment saying it is a belt, not a live path.

7. **FIXED (comment only)** — `#`-arm rationale (blind-src F1). Verified the whitespace arm DOES
   refuse spaces (`/\s/` before the metachar class) — the "unguarded space injection" half of F1
   is FALSE against real source. Verified the transport: create() ships the credential as its own
   argv element after `--registry-auth`; ssh joins argv, so the password sits mid-word glued to
   `USERNAME:`, where POSIX `#` does not comment. Comment rewritten: defense-in-depth against
   additional shell/quoting layers, explicitly noting the mid-word fact and that whitespace (the
   real splitter) is refused above. `#` refusal itself kept (harmless, conservative).

8. **FIXED** — create() catch relabeling (blind-src F7). Verified the catch swallowed everything.
   Now: `create_failed` event still emitted (observability preserved), then
   `if (e instanceof ExeDevDriverError) throw e;` (typed errors keep their code — same doctrine as
   the authFile catch), and non-Error rejections render via `String(e)` instead of "undefined".

9. **FIXED** — Mirror-recovery remediation (decisions.md action 3). Both `create-failed`
   remediation strings extended with "; if the failure is an image pull, mirror the pin (crane
   copy) and set QDS_EXEDEV_IMAGE + QDS_EXEDEV_IMAGE_BUILD_ID". Grep found NO existing test
   asserting those remediation strings (decisions.md's "update the tests asserting them" had no
   referent) — nothing to update; the strings are exercised through the create-failed tests'
   code/message asserts, which still pass.

10. **FIXED** — Both-or-neither on EFFECTIVE halves (edge-src F3, blind-src F8, auditor F5).
    Guard now computes `opts.image !== undefined || hasImage` vs same for buildId — opts beats
    env, the identical precedence the `...opts`-last spread applies. A caller completing the env
    half via opts is accepted; a caller splitting the pair via opts is refused. Comment states
    coverage honestly (factory only; direct `new ExeDevDriver({image})` remains the documented
    test seam). Message notes "(env, or its opts half)". Tests: both new cases added to the
    both-or-neither test. NOT fixed (out of triage scope, noting blind-src F8's secondary): an
    opts key explicitly set to `undefined` still clobbers env via spread — record for the story
    if wanted; it requires the caller to construct `{image: undefined}` deliberately.

Also (a-F2 second half): driver.ts:203's "the publish gate keys on this" comment corrected — the
workflow re-implements the sentinel check in bash and never calls `isUnpinnedImage`.

## TRANSPORT.TS / SETUP-GATE.TS

11. **FIXED** — Oversized-vs-transport misclassification (edge-src F1). Verified the kill path:
    `readBounded` calls `kill()` (SIGKILL → exit 137) AND sets `truncated`, and `sshCommand`
    surfaces the flag — so a cap-hit read was `{unreadable, 137}` → relabelled
    `image-marker-unreachable` ("re-create it") for a condition the type documents as permanent.
    `readBoxFile` now checks `truncated` BEFORE `exitCode !== 0`, with a comment naming the
    kill-path coupling and the one residual (a truncated-stderr failed cat also reads oversized —
    exotic, still fail-closed). gitnexus: `readBoxFile` is HIGH-fanout (fanout-primitive +
    setupGate); for fanout the change moves cap-killed reads from retryable "unreadable" to
    permanent "oversized", which is the direction `BoxFileRead`'s own doc demands. New unit test:
    truncated+exit137 → oversized (read-box-file.test.ts).

12. **FIXED** — Probe-exit classification (edge-src F7 first half). Implemented in
    `imageMarkerFailure` (NOT in readBoxFile — the `absent` union member still carries `probeExit`
    for the fanout caller, whose file is out of cluster): `absent` is a finding about the image
    only when `probeExit === 1` (or undefined, per the type's "absence is still absence without
    them"); 137/255 keep their named transport arms; any OTHER non-zero exit (143, 126, …)
    becomes `image-marker-unreachable` with "absence is unproven" wording. Unit-pinned (probeExit
    143 → unreachable; probeExit 1 → the absence finding) in image-contract.test.ts.
    **DEFERRED (out of cluster)**: edge-src F7 second half — `src/fleet/fanout-primitive.ts:744`
    `probeArm` still treats EVERY `kind:"absent"` as a clean streak-resetting read without
    consulting the new `probeExit` discriminator; an ssh-255 probe resets the corruption streak
    and a race can spin to its ceiling against a dead arm. Needs a fleet-cluster fix or an issue.

13. **FIXED** — B0 catch over-classification (blind-src F10, edge-src F6). Restructured: ONLY the
    `readBoxFile` await sits in the try; `imageMarkerFailure` runs outside it (a throw from it is
    now a loud host-side crash, not a "re-create the box" payload — per triage; it is a pure
    function that catches its own parser). The catch message no longer asserts "within the gate
    budget" (it cannot know that) — it quotes the actual rejection, `String(e)` fallback for
    non-Error rejections. Fail-closed direction preserved (still a `image-marker-unreachable`
    payload, VM alive).

14. **SKIPPED (verified)** — blind-src F11 (error attached when A failed). B0 runs only inside
    `if (assertions[0]?.ok === true)` (setup-gate.ts, B block guard), so `markerError` can only be
    set when A passed — and setting it always pushes B's failed item, making `firstFail.item ===
    "B"` whenever the error spread fires. The self-contradictory `failedItem:"A"` +
    marker `error` payload is unconstructible. Evidence: the `if (assertions[0]?.ok === true)`
    guard opening the B block.

15. **FIXED** — boot_ready_ms sentinel collision (edge-src F4). Pass arm clamped to
    `Math.max(1, Date.now() - gateStart)` with a comment naming both hazards (fake substrate
    settling under 1 ms → sentinel collision; NTP step → negative "measured-looking number").
    setup-gate.test.ts happy path now asserts `>= 1` on pass. Edge-src F5 (no carrier pre-A): no
    code change per triage — story documentation item (field rides gate_a by design; pre-A throws
    emit no gate_a line).

## ASSERTIONS-IN-BOX.SH (verified NOT a deriveBuildId input before editing)

16. **FIXED** — models_json empty fail-open (edge-src F9, blind-src F9 hole 2). `[ -z
    "$models_json" ]` guard after the derivation: emit D 0 + exit 3 ("could not derive the
    models.json path … refusing rather than reading a possibly-present registry as absent"). Note
    avoids both pass-shapes; exit-3-before-C is the host's controlled-stop shape (verified: the
    D-pre arms already exit 3 pre-C and the host matches item D without a C line).

17. **FIXED** — D-pre/D TOCTOU (blind-src F9 hole 1). `models_json_at_dpre` records the D-pre
    observation; D's absence arm now refuses ("models.json was present at D-pre and is absent now
    — the registry disappeared mid-gate") before granting the tolerance. The "Reaching here with
    the file absent means the series WAS reviewed" comment corrected to state the PROVIDED-clause.

18. **FIXED** — pi version parse (edge-src F10). Exact-line match first (`grep -xE`, what the
    measured factory binary prints), token-grep fallback only when no exact line exists ("pi
    X.Y.Z" prefix forms). Comment names the update-banner failure the preference prevents.

19. **FIXED** — Stale comments (blind-src F13, seams F7). (a) D-pre UNREVIEWED arm's
    "pass-matcher greps for" rationale rewritten: the note never reaches the `case "$d_scan"`
    matcher from this arm; the real constraint is the host-side test + human/dashboard greps, and
    the comment now says exactly that. (b) `pi -p` → curl corrected at all four sites: sh:282
    ("a real provider chat call reported usage cost.total"), sh:285 ("D: provider cost.total"),
    setup-gate.ts:16-18 header (curl chat call, NOT `pi -p`), fake-exedev.ts costTotal doc.
    setup-gate.test.ts's D-note regex updated to `^D: provider cost\.total …`; the
    `/cost\.total = inf/` assertion still matches the new refusal wording.
    Also the "Three other hand-written copies" inventory corrected (see b-F6).

## TESTS

- **a-F1 FIXED** — canary written INTO the garbage posture file's bytes (V8 SyntaxError quotes
  input) and into a refused scope value; scrub comments updated to state why they can now fail.
  Pairs with fix 5.
- **a-F2 FIXED** — `expect(isUnpinnedImage()).toBe(false)` added beside the agreement check;
  test comment and driver.ts:203 comment both corrected (workflow never calls the predicate).
- **a-F3 FIXED** — exactly-512 acceptance now exercised through the constructor (ratified
  posture), bare-function assert kept.
- **a-F4 FIXED** — both `imageDigest` log assertions use the literal
  `` `sha256:${"a1b2c3d4".repeat(8)}` ``, with the helper-as-its-own-oracle rationale.
- **a-F5 FIXED** — new unit test at `imageMarkerFailure`: exactly-cap content refused ("at or
  over"), cap-minus-1 passes (byte lengths asserted exactly; padded via gitSha). No new gate
  cycles.
- **a-F6 FIXED** — the tagged driver now `create()`s and the test asserts zero additional
  `image_not_digest_pinned` lines ("once per DRIVER, not per box").
- **a-F7 FIXED** — `expect(envBuildId).not.toBe(DEFAULT_IMAGE_BUILD_ID)` in the env test AND the
  precedence test.
- **a-F8 FIXED** — constructor scrub loop extended to `err.remediation` + serialized pair.
- **a-F9 FIXED** — remediation example extracted by `/ghcr\.io\/\S+@sha256:<64 hex>/` template
  match instead of slice-to-end.
- **a-F10 FIXED** — `chmodSync(loose, 0o644)` after the write (umask-proof), comment explains.
- **a-F11 FIXED** — `":password"` → `":pw-LEAKCANARY-EMPTYUSER"`, `"qds bot:password"` →
  `"qds bot:pw-LEAKCANARY-BADUSER"` (arms preserved, vocabulary constraint removed).
- **b-F1/b-F2 FIXED** — fake stderr shapes now real: `test -f` miss and SIGKILL(137) are EMPTY
  stderr; only ssh(255) speaks; a simulated failing `cat` (catExit set, non-transport) says
  `cat: …: Permission denied`. No test asserted the fictional strings (grepped); the D1/D2
  regression regexes match the gate's own wording, which never embedded them.
- **b-F3 FIXED** — the never-fall-through marker guard now THROWS a host-side Error instead of
  returning exit 64. Verified no test depends on the 64 path for the marker (grep). Comment
  updated honestly: the gate's B0 catch still converts it to a payload, but (with fix 13) the
  payload message now names the seam verbatim instead of a fictional shell failure.
- **b-F4 FIXED** — the divergence test slices driver.ts between
  `const STEERING_PROVISION_SCRIPT` and `].join(" && ")` (both markers asserted present) and runs
  the three regexes against only that slice.
- **b-F5 FIXED** — `imageMarkerTruncated` now serves `marker.slice(0, len/2)` (an unparseable
  prefix) with `truncated: true`, matching its own comment; existing truncated-case assertions
  unaffected (the oversized classification keys on the flag).
- **b-F6 + seams F6 FIXED** — "FOUR places" → THREE hand-typed (Dockerfile ARG, build-script
  const, PI_REVIEWED_SERIES), the fake noted as importing; same correction in
  assertions-in-box.sh's inventory comment; STUB_PI now prints `pi ${PI_VERSION}` (interpolated
  from the imported build-script constant) so a future models.json-absent fake test lands in the
  reviewed-series arm.
- **b-F7 FIXED** — the tautological `EXPECTED_ENV_FILE === /home/<User>/<KEY_ENV_FILE>` rebuild
  deleted; comment records why (same construction compared with itself); the real ties
  (EnvironmentFile equality, User === BOX_USER, KEY_ENV_FILE literal) remain.
- **b-F8 FIXED** — Dockerfile text comment-stripped (`#`-leading lines dropped) before the
  steering-tuple `toContain`; comment marks the read as read-only/never-edit (deriveBuildId
  input).
- **b-F9 FIXED** — round-4 test measures `postStallMs` (stall release → C/D/E launch arrival at
  the seam) and asserts `0 <= postStallMs < ROUND4_REMAINING_MS` before the `toContain("C")`, so
  a post-stall host hiccup is named in numbers instead of masquerading as the floor regression.

New behavior pins added beyond the report list: cap-kill → oversized (read-box-file.test.ts),
probeExit 143/1 classification (image-contract.test.ts), both-or-neither opts-completion and
opts-splitting cases (image-contract.test.ts), date-only/offset expiry acceptance.

## GATES

- `bunx tsc --noEmit`: **0 errors in this cluster**. Two errors exist in
  `tests/scripts/exedev-build-image` territory (`tests/scripts/build-exedev-image.test.ts:119,132`
  — TS2339 on `string|Buffer`); that file carries 242 inserted lines from a CONCURRENT fix agent
  (not touched by me; `git diff --stat` confirms) — flagged for fix-buildscript.
- `bunx @biomejs/biome check` on all 8 touched files: **clean** (one noUnusedTemplateLiteral I
  introduced was fixed).
- `bun test tests/providers/exedev/ tests/scripts/exedev-bun-pin.test.ts` →
  /tmp/fix-src-tests.log, de-CR'd + ANSI-stripped: **233 pass, 0 fail, exit 0**.
- `shellcheck assertions-in-box.sh`: identical finding set to HEAD (one pre-existing SC2016 info
  on the deliberate single-quoted python block) — no new findings.

## NEEDS STORY-RATIFICATION TEXT (for the story writer)

1. **AC4 scope EXCLUSIVITY** (fix 1): the gate now refuses a record naming any scope besides
   `read:packages`, strictly stronger than AC4's "naming" terms. Belongs in the
   "Decision-needed — resolved conservatively" list beside the expiry items.
2. **AC4 expiry grammar** (fix 2): expiry must be `YYYY-MM-DD` (UTC midnight) or a date-time
   with Z/±hh:mm offset — machine-parseable AND host-independent AND live. Auditor F2 already
   flagged the live-expiry strengthening as unlisted; the ratification entry should cover all
   three terms (parseable grammar, offset requirement, in-the-future).
3. **Per-create re-assertion** (fix 3): the deviation is now re-checked on every `create()`, so a
   ratification lapse stops the fleet at the next create — worth one story line.
4. **DEFERRED finding to carry**: `fanout-primitive.ts:744` ignores the new `probeExit`
   discriminator — every `absent` (including ssh-255) resets the corruption streak (edge-src F7
   second half). Out of this cluster; needs a fleet fix or issue.
5. **edge-src F5** (boot_ready_ms absent on pre-A throws): documented-by-design item for the
   story, per triage.
