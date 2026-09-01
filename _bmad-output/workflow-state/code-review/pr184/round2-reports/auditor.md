# Acceptance Audit — round 1 fix wave (41cb8dd..HEAD), DF2.10 (PR #184)

Scope: round 1's own changes only, audited against
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md`.

## F1 [MEDIUM] AC3's normative text still says "conditional" while the shipped spread is unconditional — and the round-1 record claims "the wording was corrected"

AC/invariant: AC3; audit category (d) story-text drift.

The code ships `--image` as an unconditional spread with an accurate comment
(`src/providers/exedev/driver.ts:629-633`: "`--image` is UNCONDITIONAL — the
constructor always assigns a pin"). Decision 3 in the round-1 section records
the choice and says "The wording was corrected instead"
(`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md:387`).
But the only wording corrected is the **code comment** (the diff replaces "Two
conditional spreads, same literal"). The spec's own normative text still says
the opposite in three places:

- `:24` (Overview): "`create()` gains two conditional argv spreads"
- `:69` (AC3 itself): "threads both flags as conditional spreads in the existing argv literal"
- `:342` (Verification table): "Edits are additive only (two conditional argv spreads, …)"

A reader of AC3 alone gets the wrong contract, and "the wording was corrected
instead" reads as though the spec was reconciled when it was not. The decision
itself is sound and honestly recorded; the correction claim is what does not
hold. (Story and code do NOT agree on what is implemented at the AC level; they
agree only in the addendum.)

## F2 [MEDIUM] AC4's deviation gate enforces terms the story never ratified — expiry must be machine-parseable AND in the future — and the story edit quietly upgrades "expiry" to "a live expiry"

AC/invariant: AC4, INV-IBOX-3; audit categories (b)/(d).

AC4's ratified terms (`df2-10…md:79-81`): the recorded deviation must *name*
"the PAT's `read:packages` scope, expiry and rotation owner". Naming — nothing
about the expiry's value.

The implemented gate (`src/providers/exedev/driver.ts:381-417`):

- `:406-407` — refuses any expiry `Date.parse` cannot read ("names no ISO-8601
  \"expiry\""), so a record naming an expiry as e.g. `2027-Q1` is refused.
  AC4 never required machine-parseability.
- `:411` — `if (expiresAt <= Date.now()) refuse(…)`: a recorded ratification
  with a passed expiry is refused outright. AC4 never ratified an
  expiry-in-the-past refusal; a ratification now silently stops working at a
  date, by construction.

Both are strictly stronger than the ratified terms. The direction is fail-safe
and the rationale in the code is reasonable — but the round-1 story edit files
this under "The three that were real defects" (`df2-10…md:362`) and describes
the gate as requiring "a live expiry", quietly rewording AC4's "expiry" without
flagging the strengthening. The six-item "Decision-needed — resolved
conservatively … listed for ratification" section (`:381-392`) is exactly where
this belonged and it is absent from it. Nothing ratified is skipped: postureFile
seam (`driver.ts:497-503`, matching AC4's "where this driver already reads
operator attestations"), scope naming, and rotation owner (`:413-416`) all
match.

## F3 [LOW] The deviation gate's least-privilege comment claims a refusal the code does not perform, and the "ISO-8601" message overclaims

AC/invariant: AC4; round-1-authored comment/code drift within the same function.

`src/providers/exedev/driver.ts:400-403` — comment: "a record naming a broader
one is a different deviation than the one INV-IBOX-3 contemplates." The check is
`scope.split(/[\s,]+/).includes("read:packages")`, so
`"repo, admin:org, read:packages"` passes: the gate requires `read:packages` be
*among* the named scopes and never refuses a broader grant. That matches AC4's
literal "naming" requirement (so it is not an AC violation) but the comment
asserts an enforcement that does not exist. Secondary: `:407`'s "names no
ISO-8601 \"expiry\"" — `Date.parse` accepts many non-ISO strings
(implementation-defined), so ISO-8601 is claimed, not enforced.

## F4 [LOW] Round 1 added error codes and an event the Observability Contract does not name, while editing the story everywhere else

AC/invariant: Observability Contract (`df2-10…md:151-153`); category (a)/(d) drift.

The contract enumerates the error triple's codes as `(image-invalid,
registry-auth-invalid, image-marker-mismatch)` and the create events as
`create_requested | create_shape | create_failed`. Round 1 introduced, without
touching those lines:

- `image-marker-unreachable` — the new transport-fault arm of the marker
  assertion itself (`src/providers/exedev/transport.ts:315`,
  `setup-gate.ts:493`), i.e. the exact surface the contract's code list covers;
- `registry-auth-unratified` (`driver.ts:383`), `image-build-id-invalid`
  (`driver.ts:~489`), `image-pin-incomplete`, `registry-auth-file-mode`
  (`driver.ts:1195-1220` region), `create-failed` (`driver.ts:646`);
- a new constructor-time event `image_not_digest_pinned` (`driver.ts:515`).

All additive and individually well-justified, but the contract — extensively
quoted by round 1's own fixes ("a field never evaluated reports 0",
`create_ms: 0`) — was left stating a narrower surface than the code emits. The
marker-unreachable split in particular changes what a consumer keying on
`image-marker-mismatch` sees for a gate-B refusal.

## F5 [LOW] The `...opts`-last reorder lets a caller split the image/buildId pin pair the both-or-neither guard exists to prevent

AC/invariant: INV-IBOX-2 ("the reference and its buildId are ONE pin" — the
guard's own words); interaction of two round-1 fixes.

`exeDevDriverFromEnv` now refuses a half-set env pair
(`src/providers/exedev/driver.ts:~1188-1196`, "BOTH-OR-NEITHER … half a pair is
… a guaranteed fleet-wide refusal") and then spreads `...opts` **last** so an
explicit argument beats the environment (`driver.ts:~1225-1232`). The guard
checks only the env vars: with both env vars set, a caller passing
`exeDevDriverFromEnv(env, { image: X })` gets `image` from opts and
`imageBuildId` from env — a mixed pin, producing exactly the fleet-wide gate-B
marker-mismatch the guard's comment declares impossible. Production is
unaffected — the registry factory passes no opts
(`src/providers/index.ts:138`, `exeDevDriverFromEnv()`); exposure is the
test/library seam only. Flagged because the guard's stated invariant is
defeated by the sibling fix in the same function.

## F6 [LOW] The df1-10 cross-reference overstates the deferral: "ten image-content items … all blocked on one fact" is wrong for #188 (and disagrees with df2-10's own count)

AC/invariant: audit question 5; category (d) on the df1-10 edit.

`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-10-in-box-phase-engine.md:131-141`
(new round-1 block): "DF2.10's code review (PR #184) found **ten** image-content
items it could not fix, **all blocked on one fact**: `deriveBuildId` hashes the
Dockerfile bytes and both systemd unit bytes…". Two misstatements:

- **#188 is not blocked on that fact.** Its blocker, per the issue itself and
  df2-10's own deferred bullet (`df2-10…md:397`), is "the real installed paths
  cannot be enumerated without a build"; `binary-licenses.json` and the
  build-script matcher are not `deriveBuildId` inputs (base digests ‖
  BUN_VERSION ‖ PI_VERSION ‖ Dockerfile ‖ unit files, `df2-10…md:210`), so
  fixing it moves no digest.
- **The count disagrees with the source story**: df2-10's deferral is "Five
  image-content findings" (`df2-10…md:396`); the #186 table row lists nine
  sub-items; "ten" matches neither.

The load-bearing parts of the cross-reference are accurate: issues #186/#187/#188
exist with matching titles and content (verified via `gh issue view`), the
"read #186 before writing the unit" instruction is sound, and the DoD checkbox
(`df1-10…md:202`) correctly binds them to the re-pin.

## Verified clean (with evidence)

- **AC1c error triple**: `imageMarkerFailure` returns `{code, message,
  remediation}` (`transport.ts:296-364`), threaded into `SetupGateResult.error`
  (`setup-gate.ts:94-98`, result assembly `:653-657`), `debugCommands` gained
  `cat /etc/qds-image.json` (`setup-gate.ts:648-650`). Payload, never a throw:
  the B0 rejection is caught at its call site (`setup-gate.ts:478-500`).
- **INV-IBOX-2 / audit Q4**: gate B compares **only** `marker.buildId`
  (`transport.ts:359`); `marker.imageRef` reported, never compared, with the
  decision made executable by
  `tests/providers/exedev/image-contract.test.ts:1143` ("a mismatched ref with
  the right buildId PASSES", asserts `ready: true`). Story INV-IBOX-2 text
  (`df2-10…md:174`) and decision 4 (`:388`) both match the code. #187's
  `transport.ts:360` citation is accurate.
- **Sub-timings**: `create_ms` on all three create events — `0` on
  `create_requested` per "never evaluated reports 0" (`driver.ts:616`), measured
  on both `create_failed` arms (`:643`, `:659`) and all `create_shape` arms
  (`:679, :688, :695`), each with `...imageFields()` so `imageDigest` rides the
  failure event. `boot_ready_ms` emitted at gate A, `0` on a failed A
  (`setup-gate.ts:426`). `marker_assert_ms` on the `gate_b0` line
  (`setup-gate.ts:498-499`). `requestId` reaches the marker assertion via
  `emitGate` (`setup-gate.ts:498`).
- **AC4 default-off**: the deviation gate runs only when `registryAuth` is
  supplied (`driver.ts:497-503`); public path carries no credential and no new
  refusal; credential appears in no `imageFields()` output (boolean
  `registryAuthUsed` only, `driver.ts:~575`).
