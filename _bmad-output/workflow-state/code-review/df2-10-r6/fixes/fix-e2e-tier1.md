# F8 — tier-1 live tests (`tests/fleet/e2e/tier1-*.live.test.ts`)

Branch `fix/df2.10-review-round-6`. Nine files touched (`tier1-image-contract` does not
exist — the image-contract tier is `tier2-`, owned by a sibling fixer). No commit, no push.
`live-harness.ts` NOT touched. Live suite NOT run.

## Fixed

### P135 [HIGH] — nine single-shot `final-ls` sites → `fleetLeftovers`
`tier1-driver-lifecycle`, `tier1-provision-status`, `tier1-lock`, `tier1-harvest` (T1.3a +
T1.3b), `tier1-teardown` (T1.4), `tier1-attach-transport`, `tier1-approval-gate` (T1.7 + D8),
`tier1-registry-auth`.

Each site is now one line — `finalBoxes = (await fleetLeftovers(driver, [runId], evidence)).owned;`
— and the surrounding `try/catch` is gone, per wave 1's API note: the helper never throws, and
a failed listing returns `owned: undefined`, which `fleetCleanupProblems` already renders as
"the final fleet listing FAILED — an unmeasured fleet is never a clean one". `strays` is
deliberately NOT folded into any problems array.

Three findings close at once at every one of those sites: the missing lag poll (P135), the
backstop that reported a stray and never destroyed it (MED), and the account-wide verdict
(MED / R4).

Two sites needed a non-obvious ownership set:
- `tier1-driver-lifecycle` passes `[vm]`, not the `runIdFor` name: `vm` is deliberately reset
  to `""` after the body's own successful destroy, so at cleanup time the run owns nothing and
  anything listed is a stray. `[""]` matches no box name.
- `tier1-registry-auth` passes `[negVm, posVm]` against its own `sweeper` driver, keeping the
  run-scoping that file already had right and gaining the poll + the re-destroy it lacked.

### P136 [HIGH] — T1.5 (`tier1-fanout-refusal`) had no cleanup-time box check at all
The `before` listing was hoisted out of the `try` into a `baseline: Set<string> | undefined`,
and the `finally` now calls `fleetLeftovers` with a **delta predicate**
(`(n) => baseline !== undefined && !baseline.has(n)`), plus `fleetCleanupProblems([], finalBoxes)`
in the `settleRun` array.

The delta is the only ownership this test can have: a fanout that wrongly provisions names its
own arm boxes and this test never learns those names — which is exactly the edge reviewer's
prescribed fix ("a `destroyQuietly` for anything new since `before`"). `baseline === undefined`
means the listing on the line above the verb threw, so the verb never ran and nothing can be
ours — the predicate correctly owns nothing, and every box falls to the stray warning.
`ponytail:` comment records the ceiling: a concurrent operator's box created inside this test's
window reads as ours and is destroyed. That is the trade the skill's serial-round mandate
already assumes, and the alternative is the billing leak the check exists for.

### P139 [HIGH] — the three ghcr pre-flight `fetch`es had no timeout
All three carry `{ signal: AbortSignal.timeout(GHCR_PROBE_TIMEOUT_MS) }` (15 s), and the
constant's docstring carries the budget audit the finding asked for:

> 3 × 15 s probes + 300 s negative create + 300 s authenticated create + 60 s marker read
> = 705 s of body, leaving ~195 s of the 900 s ceiling for the `finally`.

That margin is what keeps the ceiling a fail-loud instead of a box-stranding schedule (the bun
timeout abort is the one path where the sweeper `finally` does not run).

### P125 [HIGH] — the two tests that never call `preflight()` now stamp their own provenance
- `tier1-registry-auth`: `setEffectiveImage({ image: privateRef, imageBuildId: DEFAULT_IMAGE_BUILD_ID }, …)`
  immediately above the evidence write. I used the structural literal rather than `posDriver`
  deliberately: `posDriver` is declared inside the `try` and does not exist when the negative
  leg fails, and the literal is the truthful stamp on **both** legs — they pin the same
  `privateRef`, one to be refused it and one to pull it authenticated.
- `tier1-teardown`'s D6: `setEffectiveImage(null, { note: "D6 lists key hashes only — no box is ever created" })`.

### [MED] the 300 s create budget was applied to every exec
`execTimeoutMs` is per-driver, so `posDriver` gave a one-line marker `cat` the same five
minutes as a cold pull. The create legs keep `CREATE_TIMEOUT_MS`; the marker read goes through
its own `new ExeDevDriver({ execTimeoutMs: MARKER_EXEC_TIMEOUT_MS })` (60 s — chosen under the
budget audit above, tighter than the 120 s driver default). `exec` addresses the box by name,
so the reader driver's image ref is irrelevant and it reads the very box the credential path
just created.

### [MED] the negative control can be defeated by a digest-level image cache
Recorded, not silently tolerated: the negative leg now times itself (`ms` in the
`negative-control` evidence entry), and `expect(negOutcome).toBe("threw")` carries a message
naming both causes in likelihood order — the package flipped public (nearly excluded by the
pre-flight probe that just positively proved it private) and a substrate digest-cache hit that
short-circuits the pull, in which case no credential was exercised either way — and pointing
at `negative-control.ms` vs `authenticated-create.createMs` as the evidence to read, with the
remediation (re-push the mirror under a distinct digest — rebuild, do not copy).

`ponytail:` note records that this reports rather than auto-diagnoses. Genuinely separating
the two wants a distinct-digest mirror or a substrate pull marker, neither of which is this
test's to build — and both blind and edge reports offer the same two options. The control
still fails closed; what changes is that the third inexplicable red does not end with the leg
being disabled.

### [LOW] evidence-write failures laundered through `destroyFailures`
Every one of the ten tests now has its own `writeProblems: string[]` (`d8WriteProblems` in D8),
passed to `writeEvidenceQuietly` and spread into the `settleRun` array. `destroyFailures` is
back to meaning only what `fleetCleanupProblems` renders it as — "cleanup failures: …", boxes
that would not die — so a secret-scrub refusal no longer matches tooling grepping that line
for leaks. On `tier1-registry-auth` this matters most: the write that fails there is most
likely the scrub refusal on its own credential material.

### [LOW] a missing bundle destroyed the evidence entry meant to diagnose it
`tier1-approval-gate` T1.7: the `provision` entry (carrying `harvest.outcome`) is pushed
FIRST; `statSync(bundlePath).size` is then read into `bundleBytes`, recorded in its own
`provision-bundle` entry, and asserted. On the INV-APPROVE-6 regression this block exists to
catch, the operator now reads `harvest: "…"` instead of a bare ENOENT thrown while evaluating
a `push` argument.

### [LOW] T1.8 double-reported its own box
`tier1-attach-transport`: the post-`finally` `ownBoxProblems` re-list is deleted. `runId` is
the box name (the body asserts `vm === runId`) and it is `fleetLeftovers`' ownership set, so
the same leak was producing two problem lines and a second `driver.list` round-trip — and the
deleted block also carried the no-retry lag flake the poll now absorbs. The rationale comment
is kept and rewritten to say where the check lives now.

### [LOW] D8 double-counted revoke failures
The hand-rolled `evidence.filter((p) => p.phase === "finally-revoke" && p.ok === false)` is
deleted; `fleetCleanupProblems(d8DestroyFailures, d8FinalBoxes, evidence)` folds them in.
T1.7 also gained the third argument (it had no revoke fold-in at all).

`tier1-teardown` T1.4 deliberately does NOT get the third argument: it already renders
`finally-revoke` through its own `unread(phase)` flatMap alongside `key-hash-delta-sweep` and
`finally-delta-revoke`, and passing `evidence` there would introduce exactly the double-report
this finding is about.

## False positives

None of the tier-1 findings were refuted — all were verified against real source before
patching. Two remedies were adopted only in part, recorded here rather than silently:

### blind-e2e-harness [LOW] "let `keyLeakProblems` own the revoke leg and drop the direct `revokeQuietly` call"
The **double-report** half is real and fixed (above). The prescribed remedy is not safe: the
direct `revokeQuietly` in T1.7/D8's `finally` is unconditional, while `keyLeakProblems`'
fallback fires only for a hash the account listing shows as SURVIVING — so on the path where
the listing itself fails, dropping the direct call would mean no revoke is attempted at all.
The redundant DELETE the finding objects to is idempotent ("already-gone") and costs one
provider call on a red round; the belt stays.

### edge-e2e-t1b-t2 — nothing on the "Checked and clean" list was touched
`settleRun` ordering, registration-before-provision, `liveGate` throwing rather than skipping,
`vm = ""` suppressing a double destroy, the `okExitCodes: [0, 6]` widening: all left alone.

### Observation, not patched (out of the reports' scope)
`tier1-attach-transport:277` and `tier1-approval-gate:577` assert account-wide in the **body**
(`expect(finalLs.filter(…e2e|qds…)).toEqual([])`) — the same false-red shape R4 removes from
the cleanup verdict, still present as a deliberate "round hygiene" assertion with its
"presumes no concurrent live round" comment. Neither report raised it; changing what a test
asserts is a decision, not a port. Flagging for the round's ratification list.

## Gates

```
$ bunx tsc --noEmit
exit=0            (clean — the five errors wave 1 reported in scripts/ and src/ are gone;
                   the other fixers cleared them)

$ bunx biome check tests/fleet/e2e/
Checked 21 files in 839ms. No fixes applied.

$ bun test tests/fleet/e2e/live-harness.test.ts
26 pass / 0 fail — Ran 26 tests across 1 file. [3.77s]
```

The live suite was NOT run (real boxes, real spend, `QDS_E2E_LIVE` unset), as instructed.
