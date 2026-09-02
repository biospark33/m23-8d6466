# W3-TRANSPORT

## Verdict (patched / false positive) and the rule you chose

**PATCHED.** The finding HOLDS, and the reporting fixer's *preferred* option — the
symmetric one — is the correct one. I took it, and explicitly rejected the narrow
"add 143 to the named statuses" alternative.

### The rule

> **Exit 1 is the only status either leg produces as its own clean answer. Every
> other non-zero exit is `image-marker-unreachable`.**

One rule, both legs, stated once in prose above the arms.

Why exit 1 is the right pivot on the READ leg specifically (the thing I had to
verify before taking symmetry over a special case):

- `cat`'s ordinary refusal of a file it cannot read — missing, `EACCES`, a
  directory — is exit **1**, in GNU coreutils and busybox alike; both collapse
  every read failure onto 1. There is no `cat` exit code other than 1 that is a
  statement about the file's contents.
- Every other non-zero exit on that leg is a signal or a remote shell that never
  ran `cat` at all: 137 (SIGKILL at the exec budget), 255 (ssh down), 143
  (SIGTERM from a box shutting down), 126/127 (the remote `sh` could not run
  `cat`). None of them says anything about what the box booted.

**The legitimate case the rule had to preserve, and does:** `imageMarkerCatExit: 1`
(`df210-marker-unreadable`, `image-contract.test.ts:1304`) is still
`image-marker-mismatch` with the note `could not be read (exit 1)` — a `cat` that
exits 1 on a path `test -f` just said exists IS a real statement about the file
(the foreign image's root-only 0600 marker this arm exists for). That is now the
*only* thing that reaches the read leg's `finding()`, and there is a comment on it
saying so. Verified green in gate 1.

**Why not the narrow fix.** Adding 143 to `EXEC_KILLED_EXIT`/`EXEC_TRANSPORT_EXIT`
buys exactly one release. The named pair cannot enumerate 126, 127, 141, or the
next signal a substrate change introduces; `not exit 1` cannot miss one. The named
pair now survives **only** to give 137/255 their own specific operator sentence —
it no longer decides the classification on either leg.

Both legs were already fail-CLOSED and still are; this is a diagnosis-quality fix,
not a security one, exactly as reported.

## Patched

| File:line | What changed | Why | gitnexus blast radius |
|---|---|---|---|
| `src/providers/exedev/transport.ts:326-349` | Replaced the two half-arguments with ONE prose block stating the rule for both legs, naming the exits it covers (137/255/143/126/127) and recording *why* the previous enumerate-the-signals shape aged badly | Mandate item 3: unify the rule, argue it in one place, in the file's voice | `imageMarkerFailure` upstream: **LOW**, 2 impacted — d=1 `setupGate` (`setup-gate.ts:532`, CALLS, conf 0.85), d=2 `tests/providers/exedev/setup-gate.test.ts`. 1 module (Exedev), 3 flows (`SetupGate → Run` / `→ ExeDevDriverError` / `→ InvalidRunIdError`). **No HIGH/CRITICAL — no warning owed.** |
| `src/providers/exedev/transport.ts:350-368` | `transportFault` (returned `MarkerFailure \| null`, named pair decides) → `neverAnswered(exitCode, stderr, why)` (always returns a `MarkerFailure`; the named pair only *overrides the sentence*). Hoisted `PROBE_THE_BOX` (remediation was duplicated verbatim) and `tail()` (the `JSON.stringify(trim().slice(0,200))` log-forgery guard was inlined 3×, with its rationale attached to only one) | The classification decision moves out of the status list; the log-forgery guard now has one home and one comment | same symbol, same radius |
| `src/providers/exedev/transport.ts:382-392` | **THE FIX.** Read leg: `if (read.exitCode !== 1) return neverAnswered(...)`, was `transportFault(...) ?? finding(...)`. Exit 143 now yields `image-marker-unreachable` with `read exited 143 — not \`cat\`'s ordinary refusal (exit 1), so the marker was never read` | A SIGTERMed `cat` was reported as `image-marker-mismatch` — a finding ABOUT THE IMAGE (`image-contract.test.ts:1408`) — sending the operator to audit a pin the evidence is silent on | same symbol, same radius |
| `src/providers/exedev/transport.ts:369-380` | Absent leg rewritten onto the same `neverAnswered` helper; its 20-line local argument deleted (now covered by the unified block above). Message and classification byte-for-byte unchanged | Symmetry has to be visible in the code, not just claimed in a comment — both legs now call one function | same symbol, same radius |
| `tests/providers/exedev/image-contract.test.ts:1386-1398` | Added the withheld row `df210-marker-cat143` (`{ imageMarkerProbeExit: 0, imageMarkerCatExit: 143 }`) to the D1/D2 table, asserting the corrected classification via the loop's existing `image-marker-unreachable` + `NOT evidence about the image this box booted` + `not /did not boot a factory image/` + remediation assertions, with a `why` regex pinning the new sentence | The row the wave-2 fixer withheld because it did not own `src/` | Test file; no production consumers |
| `tests/providers/exedev/image-contract.test.ts:1424-1430` | Timeout **left at 270_000**, comment updated: four cycles now, and the budget is justified by a MEASUREMENT rather than a row count | Mandate item 4 said measure, not guess — see below | — |

### The timeout: measured, not guessed

Measured the whole D1/D2 test (all four cycles) in isolation before touching the
budget:

```
$ time bun test tests/providers/exedev/image-contract.test.ts -t "D1/D2 regression"
real    0m13.066s
 1 pass / 0 fail / Ran 1 test across 1 file. [13.06s]
```

13.1 s wall for four cycles. The previous fixer's ~20 s/cycle is the pessimistic
loaded figure; even at that rate four cycles is 80 s against a 270 s budget —
~3× headroom. **Raising it to 360 s would have been the guess.** Left at 270 s and
wrote the measurement into the comment so the next person raises it on evidence.
Confirmed under the full-file run (gate 1) too: no timeout.

### Fixture: no change needed

`fake-exedev.ts:718-730` already serves an arbitrary `imageMarkerCatExit`; 143
falls into its `else` branch and yields `cat: /etc/qds-image.json: Permission
denied\n` — a realistic stderr for the new row, and the exit code is what the
classification turns on. Not my file, and it did not need to be.

## Mutation proof

Method note: the first attempt used `git stash push -- transport.ts`, which
reverts the file to **HEAD** and therefore also unwound wave-1/2's *uncommitted*
`readBoxFile` shared-deadline work — more than my change, so an impure mutation.
It also hit `ENOSPC` (see Environment below). Redone **surgically**: only my own
`unreadable` hunk was reverted to the pre-fix shape, everything else in the file
left alone.

### 1. Mutated — read leg reverted to the pre-fix "named pair only, image finding otherwise"

```ts
  if (read.kind === "unreadable") {
    // MUTATION: the pre-fix read leg — named pair only, image finding otherwise.
    if (read.exitCode === EXEC_KILLED_EXIT || read.exitCode === EXEC_TRANSPORT_EXIT) {
      return neverAnswered(read.exitCode, read.stderr, "");
    }
    return finding(`${prefix} could not be read (exit ${read.exitCode}): ${tail(read.stderr)}`);
  }
```

```
$ bun test tests/providers/exedev/image-contract.test.ts -t "D1/D2 regression"
exit=1
bun test v1.4.0 (34cbb9a40)
tests/providers/exedev/image-contract.test.ts:
1413 |       const opts = await boxWithMarker(c.id, c.box);
1414 |       const result = await driver.setup(c.id, opts);
1415 |       expect(result.ready, c.id).toBe(false);
1416 |       expect(result.failedItem, c.id).toBe("B");
1417 |       expect(result.assertionCode, c.id).toBe(ASSERTION_CODE.B);
1418 |       expect(result.error?.code, c.id).toBe("image-marker-unreachable");
                                              ^
error: df210-marker-cat143
Expected: "image-marker-unreachable"
Received: "image-marker-mismatch"
      at <anonymous> (/Users/steve/QDS-Factory/tests/providers/exedev/image-contract.test.ts:1418:40)
(fail) DF2.10 AC1c — gate B against the fake box (the real setupGate) > D1/D2 regression: a box that never ANSWERED is a transport fault, not a finding about the image [4096.48ms]
 0 pass
 37 filtered out
 1 fail
 36 expect() calls
Ran 1 test across 1 file. [4.40s]
```

The new row fails **on the reported defect verbatim** — the SIGTERMed `cat`
arriving as `image-marker-mismatch`, a finding about the image — and it is the
*only* row that fails, so it is pinning my change and nothing else. The three
pre-existing rows (ssh255 / kill137 / cat255) still pass under the mutation,
which is the proof that they never covered this.

### 2. Restored

```
$ shasum -a 256 src/providers/exedev/transport.ts
e615c266ffa5898fadcb39bfbec1a8fd20ce5658763aa9bd4e189c65ce353378  src/providers/exedev/transport.ts
$ diff -q /tmp/pr184-r4/transport.fixed.ts src/providers/exedev/transport.ts
RESTORE OK: byte-identical to the fixed file

$ bun test tests/providers/exedev/image-contract.test.ts -t "D1/D2 regression"
exit=0
bun test v1.4.0 (34cbb9a40)
 1 pass
 37 filtered out
 0 fail
 41 expect() calls
Ran 1 test across 1 file. [3.72s]
```

`e615c266ffa5898fadcb39bfbec1a8fd20ce5658763aa9bd4e189c65ce353378` is the hash
taken **before** the mutation and again **after** the restore — identical, and
`diff -q` against the saved copy confirms byte-for-byte. (The same hash also
appears in the earlier stash round-trip, which round-tripped cleanly and was
popped: `Dropped refs/stash@{0}`. Working tree is intact; nothing of anyone
else's was lost.)

## Gate output

### 1. `bun test tests/providers/exedev/`

```
$ bun test tests/providers/exedev/ > /tmp/pr184-r4/w3-transport.log 2>&1; echo "exit=$?"
exit=0
$ tr '\r' '\n' < /tmp/pr184-r4/w3-transport.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"
(no output — zero matches)

 230 pass
 1 todo
 0 fail
 1336 expect() calls
Ran 231 tests across 6 files. [99.16s]
```

`setup-gate.test.ts`'s 60 s-budget test did **not** time out on this run — no
re-run in isolation was needed.

### 2. `bun test tests/fleet/`

```
 1059 pass
 24 todo
 0 fail
 7614 expect() calls
Ran 1083 tests across 33 files. [208.30s]
```

Clean. The `probeArm` consumers of `readBoxFile` are unaffected — I did not touch
`readBoxFile`; the change is confined to `imageMarkerFailure`, whose only
production consumer is `setupGate`. (The lines above the summary — `fleet-lock:
parked a foreign body`, `[finally-destroy] DESTROY FAILED`, `EVIDENCE WRITE
FAILED: Maximum call stack size exceeded` — are pre-existing deliberate
stdout from negative-path tests asserting those very messages, not failures;
`0 fail` is the verdict.)

### 3. `bunx biome check src/providers/exedev/ tests/providers/exedev/`

```
Checked 12 files in 31ms. No fixes applied.
biome exit=0
```

### 4. `bunx tsc --noEmit`

```
tsc exit=0
```

Repo-clean. Nothing to report.

## Environment note (not a code finding, but it cost a run)

The first mutation run died with `ENOSPC: no space left on device, mkdtemp` at
`image-contract.test.ts:1210` — the volume was down to **172 MiB free**, which
reads as a test failure but is not one. Reclaimed to 1.0 GiB before proceeding,
from two unambiguously regenerable places only:

- **390 leaked `qds-*` mkdtemp directories** in `$TMPDIR` — the suite's own
  leftovers from runs whose `afterAll` never fired. Worth someone's attention:
  a `beforeAll` that throws (as this one did) leaves `tempDir` undefined and the
  `afterAll` then dies on `rmSync(undefined)` — visible in the failing log as
  `TypeError: path must be a string or TypedArray` at
  `image-contract.test.ts:1233`. Out of my file scope and not a review finding,
  so not patched; flagging it because it is the mechanism that filled the disk.
- `~/Library/Caches/Homebrew/downloads`.

Nothing in the repo, no user data, and no other agent's work was touched.

## Compliance

- gitnexus `impact` run on `imageMarkerFailure` (the only symbol edited) **before**
  editing: LOW, 2 impacted, no HIGH/CRITICAL. No other symbol was edited —
  `neverAnswered`/`tail`/`PROBE_THE_BOX` are new local closures inside
  `imageMarkerFailure`, and `transportFault` was a local closure with no external
  reachability.
- Exclusive-file discipline held: only `src/providers/exedev/transport.ts` and
  `tests/providers/exedev/image-contract.test.ts` modified.
  `_bmad-output/sprint-artifacts/` untouched.
- No `git commit`, no `git add`, no `git push`. (One `git stash push`/`pop` pair,
  fully round-tripped and hash-verified above.)
