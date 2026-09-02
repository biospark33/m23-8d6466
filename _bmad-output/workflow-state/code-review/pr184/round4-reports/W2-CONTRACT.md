# W2-CONTRACT

Wave-2 fixer, review round 4, PR #184 (`feature/df2.10`).
Exclusive file: `/Users/steve/QDS-Factory/tests/providers/exedev/image-contract.test.ts`
(198 insertions, 21 deletions; 35 → 38 tests; no source file, no fixture, no other test touched).

All eight findings were verified against the real file and the real source before patching.
**No false positives** — every one of G1, G2, G3, G4, G5, G11, G12, G13, G14 held.

## Patched

| ID | File:line | What changed | Why |
|----|-----------|--------------|-----|
| G1 | `image-contract.test.ts:1029-1039` (`"stderr echoing ONLY the password half is redacted too"`) | Added a positive anchor before the absence claim: `const failed = lines.find(l => l.operation === "exedev.create_failed")`, `expect(failed?.registryAuthUsed).toBe(true)`, `expect(failed?.status).toBe("error")`. | Held exactly as reported. `JSON.stringify([])` is `"[]"` — the canary-absence claim went green on a `create()` that emitted nothing, and the remaining three assertions are all about `err.message`. Now guarded the way its siblings at :927 / :987 are. MUTATION-PROVEN below. |
| G2a | `image-contract.test.ts:985-995` (`"…redacted before it reaches the thrown error"`) | Added `expect(err.message).toContain("exe.dev: unknown flag in: new --image ${PINNED} --registry-auth [registry-auth redacted] --json")` — the whole substrate sentence with only the credential excised. | "Secret absent + marker present" is satisfied by an implementation that replaces the entire stderr with the marker. Verified `redactRegistryAuth` (driver.ts:627-641) is an in-place `split/join`, so this is the coverage the implementation actually has — no over-claim. MUTATION-PROVEN. |
| G2b | `image-contract.test.ts:1046-1069` (NEW test `"no credential configured ⇒ substrate stderr rides through UNSCRUBBED — the redaction is scoped"`) | New negative arm: driver with no `registryAuth`, leaky stderr, asserts the full substrate sentence survives and `not.toContain("[registry-auth redacted]")`. | The three scrub tests had no negative case; a blanket-redacting driver passed all of them while destroying the diagnostic on the DEFAULT (public-image) path. MUTATION-PROVEN. |
| G3 | `image-contract.test.ts:1431-1442` (`"a mismatched marker refuses even when the box is otherwise perfect"`) | Added `expect(boxCmds.some(c => c.includes(IMAGE_MARKER_PATH))).toBe(true)` before the `chat/completions` absence claim. | Held. `boxCmds` is a filter on `a[1]` projecting `a[2]`; any argv drift empties it and the "not a cent was spent" claim — the test's whole point — passes vacuously. The marker-path anchor self-guards the same way the passing sibling at :1161 does, and is strictly stronger than `length > 0`. MUTATION-PROVEN. |
| G4a | `image-contract.test.ts:441-482` (NEW test `"the both-or-neither guard is the FACTORY's: a direct \`new\` may split the pair, and ANNOUNCES it"`) | Pins the asymmetry: factory refuses `image-pin-incomplete`; direct `new ExeDevDriver({image: PINNED})` succeeds with `imageBuildId === DEFAULT_IMAGE_BUILD_ID`; exactly one `exedev.image_override` line carrying both halves and the "gate B proves the box against THIS pair" rationale; the repo-pinned driver emits none; the buildId-only split fires it too. | Confirmed deliberate at `driver.ts:1315-1318` ("this guards the factory only; direct `new ExeDevDriver({ image })` remains legal as the documented test seam"). Roughly a dozen tests in the file depend on the seam and none said so. Wave 1's new `image_override` event (driver.ts:580-587) is what makes the seam non-silent, so the test pins the announcement as the price of the seam. |
| G4b | `image-contract.test.ts:1445-1477` (NEW test `"a SPLIT pin boots one image and is refused against the OTHER half's buildId"`) + `boxWithMarker` gained an optional third param `using: ExeDevDriver = driver` (:1276-1288) | Proves the consequence end-to-end through the REAL gate: a split-pin driver boots `PINNED`, the box HONESTLY reports that image's own `buildId`, gate B refuses `image-marker-mismatch`, and the note names both the box's build and the repo pin. | The parallel fixer's opt-in `markersByImage` knob was NOT yet in the fake when I wrote this, and it is not needed: the fake already lets the test configure the served marker directly, which expresses "an honest box that baked what it was told to boot" exactly. Uses `fake.creates` to confirm `--image PINNED` really rode the argv, so the refusal is attributable to the buildId half alone. |
| G5 | `image-contract.test.ts:1387-1393` (D1/D2 case table) + timeout `180_000 → 270_000` | Added row `{ id: "df210-marker-cat255", box: { imageMarkerProbeExit: 0, imageMarkerCatExit: 255 } }` asserting `image-marker-unreachable` / `/exit 255 — ssh connection failed or dropped mid-flight/`. | Held: the read leg tested only 137 (unreachable) and 1 (mismatch); 255 — ssh dropping between a successful `test -f` and the `cat` — was untested on the leg most likely to see it. Verified against `transport.ts:334-344, 366-373`: production classifies cat-255 correctly, so this pins real behaviour, not a bug. MUTATION-PROVEN. Timeout raised so a third ~20 s gate cycle cannot abort the loop before the new row runs. |
| G11 | `image-contract.test.ts:191-206` and :237-240 | Rewrote the rationale: `refusal()` carries the constructor-timing claim (nothing calls `create()`, so any throw is a construction throw, and a deferred validator fails `toBeInstanceOf`). The `local.calls` assertion is re-labelled as the narrower tripwire it actually is — a constructor that grew a substrate call of its own. | The old comment was backwards, as reported. See "Decisions taken". |
| G12 | `image-contract.test.ts:1152-1163` | `expect(Object.keys(EVERY_ASSERTION_ITEM).sort()).toEqual(["A"…"E"])` → `.toEqual(Object.keys(ASSERTION_CODE).sort())`, with the production-table assertion moved above it. | The old form compared a test-authored literal to a test-authored list — unfailable without editing line 1148. Derived from production, it fails the moment the union and the table disagree, under plain `bun test` (which does not typecheck). See "Decisions taken". |
| G13 | `image-contract.test.ts:829-853` | The two canary assertions are now scoped to arms whose INPUT actually carries the canary, derived by reading the arm's own file (`existsSync`/`readFileSync`), plus `expect(canaryArms).toBe(2)` so the scoping cannot silently degrade to zero. | Held: 13 of 15 arms had no canary anywhere in the input universe, so the assertions were constant-true. See "Decisions taken". |
| G14 | `image-contract.test.ts:911-918` | Added `chmodSync(tight, 0o600)` after the `writeFileSync`, matching the `loose` fixture 18 lines up. | Held. `writeFileSync`'s `mode` is umask-masked; under umask 0177/0277 the file is born 0400/0200 and an equality-style mode check would refuse a fixture this test calls acceptable. Fail-safe: pin the mode rather than trust the umask. |
| — | `image-contract.test.ts:24` | Import `existsSync`, `readFileSync` (for G13). | — |

## False positives

None. All eight findings reproduced against the real file, and every wave-1 claim in the brief
was verified against the real source before I relied on it:

| Wave-1 claim | Verified at |
|---|---|
| `create()` scrubs `ExeDevDriverError` messages through `redactRegistryAuth`, code/remediation preserved | `driver.ts:769-772` |
| `exeDevDriverFromEnv` strips undefined-valued `opts` keys before the guard and the spread | `driver.ts:1296-1300` |
| NEW `exedev.image_override`, fires on either half differing | `driver.ts:580-587` |
| NEW `registry-auth-file-oversized`; auth FILE not opened when `opts.registryAuth` is explicit | `driver.ts:1338`, `driver.ts:1386-1392` |
| `create_requested` + `create_failed` on a lapsed ratification | `driver.ts:732` inside the observed try, `driver.ts:750-754` |
| `readBoxFile` signature unchanged, ONE shared deadline | `transport.ts:152-166` |

The new `image_override` event did **not** break any existing assertion in my file: every log
assertion here filters by `operation` (`exedev.image_not_digest_pinned`, `startsWith("exedev.create")`)
or looks a line up by name — none asserts an exact line count or set around construction.

## Production defects found but NOT patched (I do not own `src/`)

1. **[MED] `imageMarkerFailure` classifies the two legs asymmetrically for non-137/255 exits —
   a SIGTERMed `cat` is reported as a finding about the image.**
   `transport.ts:354-363` (probe leg): *every* non-1 probe exit that is not 137/255 falls through to
   an explicit `image-marker-unreachable` ("not `test -f`'s clean miss, so absence is unproven"), with
   143 (a box shutting down) named in the comment as the motivating case.
   `transport.ts:366-373` (read leg): the same 143 gets `transportFault(...) ?? finding(...)`, i.e.
   code `image-marker-mismatch` with the note "could not be read (exit 143)". This file's own D1/D2
   test asserts at :1408 that `image-marker-mismatch` means "a finding ABOUT THE IMAGE" — so an
   operator whose box was SIGTERMed mid-read is handed an image finding and audits the pin, which is
   precisely the miscategorisation the probe leg was hardened against in the previous round.
   **I deliberately did not add a `imageMarkerCatExit: 143` row**: the only assertion I could write
   today would pin the wrong behaviour as correct. The fail-safe fix (owner of `transport.ts`) is to
   give the `unreadable` arm the same "any exit that is not `cat`'s ordinary refusal is unreachable"
   fallback the `absent` arm has, or — narrower — to add 143 to the named transport statuses.
   Both legs are fail-CLOSED today, so this is a diagnosis-quality defect, not a security hole.

2. **[LOW, informational] `bun test tests/providers/exedev/` flaked once under concurrent load.**
   First run (while the parallel fixer was mid-edit): 228 pass / 2 fail —
   `setup-gate.test.ts > round-4 regression: E rejects non-finite and boolean credit values`
   timed out at exactly 60005 ms (its own 60 s ceiling), and `image-assets.test.ts:800`
   (`markersByImage ON …`) failed in the parallel fixer's file. Re-running `setup-gate.test.ts`
   alone: **49 pass, 0 fail**. Final full-directory run: **230 pass, 0 fail**. Neither failure was
   mine; the setup-gate one is a real-work test on a 60 s budget that loses races against other
   `bun test` processes on the same machine. Flagging it because it will bite CI on a busy runner.

## Gate output

### 1. `bun test tests/providers/exedev/` (final, after all patches + all sources restored)

```
$ bun test tests/providers/exedev/ > /tmp/pr184-r4/w2-contract.log 2>&1; echo "exit=$?"
exit=0

$ tr '\r' '\n' < /tmp/pr184-r4/w2-contract.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
(no output)

bun test v1.4.0 (34cbb9a40)
 230 pass
 1 todo
 0 fail
 1327 expect() calls
Ran 231 tests across 6 files. [282.57s]
```

My file alone: `38 pass, 0 fail, 551 expect() calls` (was 35 tests before this round).

First (pre-restore, concurrent-load) run, reported for completeness — both failures attributed above:

```
(fail) setup gate — E2E chain (create → fill → setup) > round-4 regression: E rejects non-finite and boolean credit values (NaN passes isinstance; NaN <= 0 is false) [60005.44ms]
(fail) DF2.10 — the fake serves the marker of the image the box was created FROM > markersByImage ON: a wrong --image ref is refused by gate B — and OFF changes nothing [30.38ms]
   at tests/providers/exedev/image-assets.test.ts:800   ← parallel fixer's file, mid-edit
 228 pass / 1 todo / 2 fail
$ bun test tests/providers/exedev/setup-gate.test.ts     ← alone
 49 pass / 0 fail
```

### 2. `bunx biome check`

```
$ bunx biome check tests/providers/exedev/image-contract.test.ts
Checked 1 file in 557ms. No fixes applied.
```

### 3. `bunx tsc --noEmit`

```
$ bunx tsc --noEmit
tests/fleet/e2e/tier3-manystories.live.test.ts(47,3): error TS6133: 'writeEvidence' is declared but its value is never read.
```

Zero errors in `tests/providers/exedev/image-contract.test.ts`. The one error is in
`tests/fleet/e2e/tier3-manystories.live.test.ts` — wave-1 territory, not mine, flagged for its owner.

### 4. Mutation proofs

Every mutation was applied to a source file I do **not** own, run, then restored and verified
byte-identical by `diff` against a pre-mutation copy **and** by sha256. Working-tree `git diff` is
non-empty for `src/providers/exedev/` because wave 1's landed changes are uncommitted — so the
restoration proof is the hash, not `git diff` emptiness. Final hashes below match the pre-mutation
backups exactly.

#### G1 — drop the `create_failed` emit on the non-zero-exit path (`driver.ts:784-788`)

```
1035 |       const failed = lines.find((l) => l.operation === "exedev.create_failed");
1036 |       expect(failed?.registryAuthUsed).toBe(true);
                                              ^
error: expect(received).toBe(expected)
Expected: true
Received: undefined
(fail) DF2.10 AC4 … > stderr echoing ONLY the password half is redacted too [8.30ms]
 0 pass / 1 fail / 4 expect() calls
```

Before the patch this mutation left the test fully green: the three `err.message` assertions still
hold and `JSON.stringify([])` carries no canary.

#### G2a — blanket scrub (`redactRegistryAuth` returns the marker whenever a credential is set)

```
993 |       expect(err.message).toContain(
                                ^
error: expect(received).toContain(expected)
Expected to contain: "exe.dev: unknown flag in: new --image ghcr.io/…@sha256:a1b2…c3d4 --registry-auth [registry-auth redacted] --json"
Received: "ssh exe.dev new --name df210-auth-leak --image ghcr.io/…@sha256:a1b2…c3d4 exited 2: [registry-auth redacted]"
(fail) DF2.10 AC4 … > exe.dev stderr echoing the credential is redacted before it reaches the thrown error [3.72ms]
```

The two pre-existing assertions in that test (no secret, marker present) passed under the mutation —
which is the whole finding.

#### G2b — redaction fires with NO credential configured

```
1062 |       expect(err.message).toContain(substrateSays);
                                 ^
error: expect(received).toContain(expected)
Expected to contain: "exe.dev: unknown flag in: new --image ghcr.io/…@sha256:a1b2…c3d4 --json"
Received: "ssh exe.dev new --name df210-no-auth-scrub --image ghcr.io/…@sha256:a1b2…c3d4 exited 2: [registry-auth redacted]"
(fail) DF2.10 AC4 … > no credential configured ⇒ substrate stderr rides through UNSCRUBBED — the redaction is scoped [17.81ms]
```

#### G3 — gate B judges a constant instead of asking the box (`setup-gate.ts:526`)

Mutation: `markerRead = { kind: "content", content: <marker with buildId "0123456789abcdef"> }`,
so the refusal, the failed item and the note all stay exactly as the test expected.

```
1441 |     expect(boxCmds.some((c) => c.includes(IMAGE_MARKER_PATH))).toBe(true);
                                                                      ^
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) DF2.10 AC1c … > a mismatched marker refuses even when the box is otherwise perfect [2922.45ms]
```

Every other assertion in the test — including the old `chat/completions` absence claim — passed
under this mutation. That is exactly the vacuous-green the finding described.

#### G5 — the `cat` leg stops recognising ssh's 255 (`transport.ts:368`)

Mutation scoped to the read leg only (`transportFault(read.exitCode === EXEC_TRANSPORT_EXIT ? 1 : read.exitCode, …)`),
so the pre-existing probe-255 and cat-137 rows still pass:

```
1406 |       expect(result.error?.code, c.id).toBe("image-marker-unreachable");
                                              ^
error: df210-marker-cat255
Expected: "image-marker-unreachable"
Received: "image-marker-mismatch"
(fail) DF2.10 AC1c … > D1/D2 regression: a box that never ANSWERED is a transport fault, not a finding about the image [6979.22ms]
 0 pass / 1 fail / 27 expect() calls   ← the two pre-existing rows ran green first
```

The failure names the NEW row by id, and only that row.

#### Source restoration

```
$ diff /tmp/pr184-r4/driver.ts.bak     src/providers/exedev/driver.ts     && echo byte-identical
byte-identical
$ diff /tmp/pr184-r4/setup-gate.ts.bak src/providers/exedev/setup-gate.ts && echo byte-identical
byte-identical
$ diff /tmp/pr184-r4/transport.ts.bak  src/providers/exedev/transport.ts  && echo byte-identical
byte-identical

$ shasum -a 256 src/providers/exedev/{driver,setup-gate,transport}.ts
8d96fea1870285b2842490ee8dd95790196b268640ec8d7b954f50bb408e6669  src/providers/exedev/driver.ts
734428a73acd73de82e6d0acccccc36808ebe5ccca57e348771ebc387dbf4c14  src/providers/exedev/setup-gate.ts
7052304fabe5dbb520e6029578fd618ac26c0257ec819399266f4aef1941b32f  src/providers/exedev/transport.ts
```

(identical to the pre-mutation backups' hashes, printed at capture time above each mutation)

```
$ git diff --stat tests/providers/exedev/image-contract.test.ts
 tests/providers/exedev/image-contract.test.ts | 219 +++++++++++++++++++++++---
 1 file changed, 198 insertions(+), 21 deletions(-)
```

No commits, no staging, no push.

## Decisions taken

**G11 — KEEP the assertion, fix the rationale.**
`expect(local.calls).toEqual([])` cannot fail for the reason the old comment gave (the constructor
never invokes `run`, so the log is empty for every implementation that does not reach `create()`).
But it is not literally unfailable: it *does* catch a constructor that grows a substrate call of its
own — a registry pre-flight, an `ssh exe.dev whoami` probe — on the refusal path. That is a cheap,
real tripwire, so deleting it buys nothing. What was dangerous was the comment claiming it carried
the constructor-timing proof; a future reader would have trusted the wrong line. The comment now
says plainly that `refusal()` carries the timing claim (nothing calls `create()`, so any throw is a
construction throw, and a deferred validator fails `toBeInstanceOf`) and that `local.calls` is the
narrower reticence tripwire.

**G12 — DERIVE, don't delete.**
Deleting the line would have orphaned `EVERY_ASSERTION_ITEM`, and with it the compile-time
`Record<AssertionItem, true>` claim that a sixth letter breaks `bunx tsc`. Comparing it to
`Object.keys(ASSERTION_CODE).sort()` instead keeps the compile-time half alive AND gives it a
runtime half that can genuinely fail under plain `bun test`: add `F` to the union and the object
literal misses a key (tsc) and disagrees with the table (bun); add `F` to the table alone and the
runtime comparison fails on its own. The flat `["A"…"E"]` literal now sits only on the production
table's assertion, where it reads real state.

**G13 — SCOPE, don't arm.**
Arming the other thirteen arms means putting the canary into posture-file fields (`expiry`,
`rotationOwner`, the file path) that the refusal is *supposed* to echo — `assertRegistryAuthDeviation`
names the file and the rule to be actionable, and this file asserts that at :831-833. Arming them
would have turned a correct, actionable refusal into a red "leak", i.e. pinned the wrong contract.
So the assertions are scoped to arms whose input genuinely carries the canary, derived by reading
the arm's own file rather than from a second hand-maintained list — arming a future case is then
enough to cover it. `expect(canaryArms).toBe(2)` closes the hole that scoping opens: a future edit
that drops the canary out of both armed inputs turns the suite red instead of silently asserting
nothing. Exact `2` rather than `>= 2` on purpose — it is the count of arms the finding names, and a
drift in either direction is worth a look.

**G4 — fake knob not required.**
The parallel fixer's opt-in `markersByImage` knob had not landed in `fixtures/fake-exedev.ts` when I
wrote G4b, and the test does not need it: configuring the served marker directly expresses "an
honest box that baked exactly the image it was told to boot" precisely, and `fake.creates` proves
`--image PINNED` really rode the argv. No coordination debt either way — if the knob is preferred
later, the test's `fake.configure(...)` line is the only thing that changes. Their file now passes
in the final full-directory run (230 pass / 0 fail), so nothing of theirs is broken by mine and
nothing of mine by theirs.

**G5 cat-143 — reported, not pinned.** See "Production defects found but NOT patched" #1.
