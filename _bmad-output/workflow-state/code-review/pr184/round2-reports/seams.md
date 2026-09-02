# PR #184 round-2 seam audit — cross-cluster claims (branch feature/df2.10, HEAD f10880c)

Method: every changed file's comments/strings naming another cluster's file, constant, workflow
step, env var, or behavior was opened on BOTH sides and verified against today's source. Shared
contracts checked: `DEFAULT_IMAGE_REF`/`DEFAULT_IMAGE_BUILD_ID`/`IMAGE_MARKER_*`, the marker's six
keys (Dockerfile jq ↔ `parseImageMarker` ↔ fake `DEFAULT_IMAGE_MARKER` — all agree), the 4096-byte
cap (Dockerfile `-lt 4096` ↔ transport `>=` exclusive ↔ live test `toBeLessThan` — all agree),
`deriveBuildId`'s input set vs workflow `SOURCE_PATHS` (all five inputs covered: dockerfile+systemd
+base-digest via `oci/exedev`, piVersion via the build script, bunVersion via `package.json`), the
fake's anchored `new` matcher vs `create()`'s argv order (agree, incl. `--tag`/`--registry-auth`
positions), error codes thrown vs asserted (all nine codes match), workflow `BUILD_DIR`/evidence
paths vs the script (agree), and the b45b72f/f10880c changes vs every untouched live-test caller.

## F1 [HIGH] #189 is closed and the harness says callers assert the destroy verdict — 8 untouched live tests ignore it AND their own fallback leak assertion is swallowed by their own catch

- Harness side: `tests/fleet/e2e/live-harness.ts:474-482` — `destroyQuietly`'s docblock: "it must
  also not be ONLY recorded (#189) … Callers accumulate the returned verdict and assert on it AFTER
  their try/finally (the tier1-image-contract pattern), so a failed destroy can fail the run".
  `tests/fleet/e2e/live-harness.test.ts:16-18` pins the same claim ("a leaked billing box shipped a
  green test" — past tense).
- Caller side (untouched by round 1, verdict discarded): `tier2-dispatch-engine.live.test.ts:322`,
  `tier2-fanout-bestofn.live.test.ts:288`, `tier3-race.live.test.ts:429`,
  `tier3-manystories.live.test.ts:375`, `tier3-remote-phases.live.test.ts:197`,
  `tier3-reaper.live.test.ts:259,335,344,471,478`, `tier3-expose-port.live.test.ts:169,257,267`,
  `tier4-resident.live.test.ts:534` — every one is a bare `await destroyQuietly(...)`.
- The backstop that looks like it covers them does not: in each of those files the final leak
  assertion sits INSIDE the try whose catch converts it to evidence. Concretely
  `tier2-dispatch-engine.live.test.ts:340-342`:
  `expect(final).toEqual([]); // a leak is a failure even when the test already failed` followed by
  `} catch (e) { evidence.push({ phase: "final-ls-error", … }); }` — the AssertionError from the
  `expect` is caught by that catch and becomes a `final-ls-error` evidence entry. Same shape at
  `tier2-fanout-bestofn:304-306`, `tier3-race:443-445`, `tier3-manystories:389-391`,
  `tier3-remote-phases:201-203`, `tier3-reaper:349/483-485`, `tier3-expose-port:286-289`,
  `tier4-resident:538-540`. The comment on the line is contradicted by the block it lives in.
- Failure scenario: any tier-2/3/4 body passes; the finally's `destroyQuietly` fails (rm-failed, or
  the measured 25 s+ substrate listing lag outlasting the 5×8 s poll); verdict discarded, `expect`
  swallowed → **green test, box billing** — the exact outcome b45b72f's message says can no longer
  happen ("teardown can no longer skip the destroy") and issue #189 was closed on. Only
  tier1-image-contract (`:512-513,559`, consumes the verdict), tier1-attach-transport
  (`:311-320`, post-finally `ownBoxAbsent`), and tier5-gate-steering (`:701-714,761`, post-finally
  `t51BoxAbsence`) actually render a box verdict that can fail the run.
- Note: the swallowed-expect shape predates round 1; the seam is that round 1/b45b72f fixed one
  caller, wrote a harness contract claiming the pattern, and closed #189 — leaving the other eight
  callers documented-as-fixed while unchanged.

## F2 [MEDIUM] Test docstring and story record claim the publish workflow "computes BOTH sides" of the buildId gate with `deriveBuildId` — the workflow computes neither side with it

- Test side: `tests/scripts/build-exedev-image.test.ts:57-63` — "the publish workflow's 'the pushed
  buildId IS the repo pin' check computes BOTH sides with this same function — so an input silently
  dropped from the hash is invisible to every gate at once". Repeated in the story record:
  `_bmad-output/.../df2-10-factory-owned-boot-image.md` ("Test hardening" bullet, line ~388: "the
  publish workflow computes **both** sides of its 'pushed buildId == repo pin' check with it").
- Workflow side: `.github/workflows/publish-exedev-image.yml:270-272` reads the expected side by
  grepping the `DEFAULT_IMAGE_BUILD_ID` string constant out of driver.ts (a value a human pasted),
  and `:485-495` reads the actual side by `docker run --entrypoint cat …/etc/qds-image.json | jq
  .buildId` from the pushed image. `deriveBuildId` executes only inside
  `scripts/build-exedev-image.ts` at build time; the workflow never invokes it, on either side.
- Also wrong in its conclusion: an input silently dropped from the hash is NOT invisible to every
  gate — the digest half of the same gate step (`:515`) still moves, because the dropped input still
  changes the image bytes. The buildId equality re-checks nothing about inputs; it checks that the
  pasted constant matches the marker.
- Failure scenario: a maintainer trusting this rationale treats the buildId equality as an
  input-coverage proof (e.g. relaxes the digest comparison for the D7 tenant-mirror case, "the
  buildId re-derives the inputs anyway") and the gate silently stops pinning bytes.

## F3 [MEDIUM] image-contract.test.ts claims `isUnpinnedImage()`'s default-arg spelling is "the spelling the publish workflow calls it with" — the workflow never calls it

- Test side: `tests/providers/exedev/image-contract.test.ts:156-158` — "The default argument IS the
  shipped pin — the spelling the publish workflow calls it with, which has no test above."
  `expect(isUnpinnedImage()).toBe(isUnpinnedImage(DEFAULT_IMAGE_REF))`.
- Workflow side: `.github/workflows/publish-exedev-image.yml:300-305` implements the sentinel check
  as an independent bash string compare against the literal
  `sha256:0000…0000` — it cannot and does not call the TS predicate. driver.ts:203's "the publish
  gate keys on this" has the same softness; driver.ts:287-291 (in the workflow) is honest about the
  parallel implementation ("`isUnpinnedImage`'s comment names THIS workflow… This is that refusal").
- Failure scenario: someone changes `isUnpinnedImage`'s semantics (say, treating a tag pin as
  unpinned) believing the workflow inherits it; the workflow's private bash copy diverges silently
  and the two "gates" answer differently for the same driver.ts. Nothing binds the two beyond these
  comments — one of which is false.

## F4 [MEDIUM] Observability Contract says every create() event logs `runId` — the driver hardcodes `runId: null` on every create event

- Story side: `_bmad-output/.../df2-10-factory-owned-boot-image.md:151` — "Every `create()` logs
  `{ requestId, runId, event, imageRef, imageDigest, registryAuthUsed }`".
- Driver side: `src/providers/exedev/driver.ts:580-592` — `emit()` sets `runId: null`
  unconditionally; the box name rides as `vm` (`:616,643,659,679,688,695`) and nothing restores
  `runId`. (There is also no `event` field — the discriminator is `operation:
  "exedev.create_requested|create_shape|create_failed"`, a tolerable renaming; the null `runId` is
  not.) The unit suite never asserts `runId` on create events
  (`image-contract.test.ts:733-745` checks imageRef/imageDigest/imageBuildId/registryAuthUsed only),
  so nothing pins either reading.
- Failure scenario: the contract's own stated purpose — "a boot regression joins to its image digest
  without a second key" — fails for anyone joining create events by `runId` per the contract: every
  create line joins to null. (vm == runId in fleet flows, but the contract names the field.)

## F5 [LOW] tier3-expose-port's revoke sweep: dead catch, stale comment, and routine no-record sweeps now emit the exact `finally-revoke ok:false` shape the harness says tests must fail on

- Caller side (untouched): `tests/fleet/e2e/tier3-expose-port.live.test.ts:268-272` —
  `try { await revokeQuietly(ctx.driver, store, vm, evidence); } catch { /* record may predate the
  key mint — nothing to revoke */ }`.
- Harness side (b45b72f): `live-harness.ts:502-509,514-533` — `revokeQuietly` "never throws,
  including on a missing/half-written run record (#189)"; an unreadable record is now recorded as a
  `finally-revoke ok:false` verdict "(the post-finally assertions in the live tests fail on it)".
- Mismatches: (a) the catch is dead code and its comment describes the deleted throw path; (b) in
  this caller an absent record is the EXPECTED case (the sweep runs over every listed `qds-*`/
  `e2e-*` box, most of which have no record in this test's workspace store), so every routine sweep
  now writes `finally-revoke ok:false, error: "unreadable run record …"` into evidence —
  indistinguishable from a genuinely failed revoke, and exactly the phase/shape tier1's post-finally
  assertion pattern (`tier1-approval-gate:868-870`) fails a test on. Copying that pattern here (the
  natural next hardening step) false-fails every run with any unrecorded leftover.
- Verified NOT a bug: passing `vm` where the parameter is `runId` is safe — the fleet names boxes
  after run ids (`src/providers/driver.ts:646`: `driver.create(opts.runId, SBX_OWNERSHIP_TAG)`), so
  vm == runId for every box this sweep can see.
- Same dead-catch shape in `tier5-gate-steering.live.test.ts:727-731`: its `catch` pushes a
  `finally-revoke-error` phase that can no longer occur, making the post-finally assertion at
  `:762` (`finally-revoke-error` entries `.toEqual([])`) permanently vacuous.

## F6 [LOW] "The pinned pi version is hand-typed in the test fake" — it is imported there now; the fake's hand-typed pi version is a different one (0.55.0)

- Test/script side: `tests/providers/exedev/setup-gate.test.ts:168-176` — "hand-typed in FOUR
  places — … the test fake's marker …"; `src/providers/exedev/assertions-in-box.sh:111-115` —
  "Three other hand-written copies of the pinned version exist — … and the test fake".
- Fixture side: `tests/providers/exedev/fixtures/fake-exedev.ts:123-128` imports `PI_VERSION` and
  `readBunPin` from the build script (a round-1 fix; `image-contract.test.ts:996-998` documents it:
  "the fixture imports piVersion/bunVersion from where the build stamps them"). What IS still
  hand-typed in the fake is `STUB_PI`'s `print("pi 0.55.0")` (`:158,172`) — a version no factory box
  runs. Today it is unreachable from D-pre (the fake always writes `models.json`, so the
  version-conditional arm never fires), but any future fake-driven test of the models.json-absent
  arm gets `pi series 0.55 is UNREVIEWED` instead of the arm it meant to test.
- Two comments across the seam assert a binding topology (four hand-typed copies) that round 1
  itself changed; the next PI_VERSION bump audit will chase a copy that no longer exists and miss
  the one that does.

## F7 [LOW] Assertion D's refusal note names `pi -p` as the instrument the script's own header says it rejected

- Script side: `src/providers/exedev/assertions-in-box.sh:189-194` — "D's instrument is the
  provider's own usage.cost from a real curl chat call (same seam as C), NOT `pi -p`: pi's node
  streaming client stalls nondeterministically…". `d_total` is indeed read from the curl response
  (`:195-226`).
- Same file, the emitted evidence: `:282` — `emit D 0 "a real pi -p call reported cost.total =
  $d_total …"` and `:285` — `emit D 1 "D: pi cost.total $d_total > 0; …"`. The gate header carries
  the same stale claim: `src/providers/exedev/setup-gate.ts:17` — "D cost table loaded — real
  `pi -p --mode json` cost.total > 0". The fixture keeps a third copy:
  `fake-exedev.ts:53` — "`cost.total` a `pi -p --mode json` run reports (D's first half)".
- Failure scenario: an operator triaging a live D failure follows the note to debug pi's streaming
  client (the measured 2026-08-19 stall the comment warns about) when the failing call was curl →
  OpenRouter — the misdirection this round's B0 transport-fault split was specifically written to
  prevent elsewhere.

## Checked and clean (for the record)

- driver.ts sentinel comment (`:183-199`) now correctly says the workflow publishes then refuses to
  go green (the hand-caught seam bug — verified fixed).
- Workflow `SOURCE_PATHS` (`:213`) vs `on.push.paths` (`:59-72`): in lockstep minus driver.ts,
  exactly as both comments claim; driver.ts is trigger-only and not a source path.
- Workflow pin grep vs driver.ts formatting: the `tr '\n' ' '` flatten handles the wrapped
  `DEFAULT_IMAGE_REF` declaration; no earlier text in driver.ts matches either grep pattern, so
  `head -1` takes the real constants.
- Marker contract three ways (Dockerfile `:275-292` jq keys, `parseImageMarker` transport.ts:265,
  fake `DEFAULT_IMAGE_MARKER`): identical six keys; byte cap exclusive at all three sites.
- Fake `new` matcher (fake-exedev.ts:528) vs `create()` argv (driver.ts:624-639): flag order
  identical, `--image` mandatory both sides.
- `image-assets.test.ts` four-copy steering tuple (tmpfiles ↔ driver script ↔ attach.ts ↔
  Dockerfile stat): all bound by real assertions, verified present on each side.
- Workflow exit-code classifier vs build script: `die(1)` on pushed-digest mismatch and `die(2)` on
  registry read failure both land in the classifier arm whose text names them.
- b45b72f's `preflight` → `exeDevDriverFromEnv`: matches `src/providers/index.ts:138` (production
  registers the same factory); tier1-image-contract's precondition comments (`:117-135`) are
  accurate. Harness `boxExec`/`fetchBoxFile` still build bare `new ExeDevDriver()` but only for
  `exec` (image-independent) — no seam.
- f10880c `boot_ready_ms`: rides gate_a with 0-on-failure, matching the story contract line 153 and
  the round-1 deferral note verbatim; unit test asserts both arms.
- tier1-teardown/approval-gate/image-contract post-#189 comments all match the new revokeQuietly/
  destroyQuietly semantics (verdicts consumed; `keyWasMinted` gating consistent with the early
  return).
