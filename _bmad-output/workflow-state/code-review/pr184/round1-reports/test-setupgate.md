# W2-B report — `setup-gate.test.ts`, `read-box-file.test.ts`

Files edited (ONLY these two):

- `/Users/steve/QDS-Factory/tests/providers/exedev/setup-gate.test.ts`
- `/Users/steve/QDS-Factory/tests/providers/exedev/read-box-file.test.ts`

No commits, no `git add`. Nothing under `src/`, `scripts/`, `oci/`, `.github/`, and neither
`image-contract.test.ts` nor `fixtures/fake-exedev.ts` was touched.

---

## Gate output

```
bun test tests/providers/exedev/setup-gate.test.ts tests/providers/exedev/read-box-file.test.ts
exit=0
 50 pass
 1 todo
 0 fail
```

`bunx tsc --noEmit` clean. `bunx @biomejs/biome check tests` — 164 files, no fixes applied.

---

## Verdicts

| Item | Verdict | What happened |
|---|---|---|
| 4 — `debugCommands` 4 → 5, marker command inserted third | **FALSE POSITIVE as a re-pin** (acted on as coverage) | Grepped every `debugCommands` reference in `tests/`: this file has only `length > 0` and `every(startsWith("ssh "))` (`:495-496`); `image-contract.test.ts:601` is also `length > 0`. **No index-based or length assertion exists to move.** But the new entry was asserted by nothing, so I pinned it by CONTENT — `some(c => c.includes(\`cat ${IMAGE_MARKER_PATH}\`))`, with `IMAGE_MARKER_PATH` imported, not re-typed. Content, not index: the list is allowed to grow. |
| 5 — `marker_assert` → `gate_b0`, `marker_assert_ms` survives | **FALSE POSITIVE as a re-pin** (acted on as coverage) | `grep -rn "marker_assert\|gate_b0" tests/` returns nothing outside my new assertions — no test matched the old item name, so nothing moved. Added the missing coverage inside the AC1 happy path: exactly one `exedev.gate` line with `item === "gate_b0"`, carrying BOTH `gate_b0_ms` and `marker_assert_ms` as numbers and `outcome: "ok"`, plus `events.some(e => e.item === "marker_assert") === false` so the old name cannot come back silently. |
| 8 — unreviewed-series refusal now fires BEFORE C | **CONFIRMED, and the AC2 test does still pass** — independently verified | Re-ran the existing AC2 test alone and in-file: green, as fix-gate said. It only inspected the `D` line, so it was green under BOTH orderings and proved nothing about the hoist. Added the assertion that does: `expect(parsed.map(r => r.item)).toEqual(["D"])` — a refusal emits ONLY the D line, no C line at all. That is the INV-2 claim (no C pings, no D provider call before the refusal) made falsifiable. |
| 9 — D7's unreportable-pi arm | **CONFIRMED, `(no current test)` → covered** | New test `DF2.10 D7: a pi that cannot report a version refuses D for THAT reason, not a phantom pin bump`. A `pi` stub that exists (so B passes) and prints nothing for `--version`, with an absent `models.json`. Asserts `note` matches `/could not report a pi version/`, exit 3, only the `D` line — and asserts the OTHER arm's diagnosis is absent (`not.toMatch(/UNREVIEWED|PI_VERSION moved/)`), which is the whole point of splitting the arms. |
| 10 — the `PI_REVIEWED_SERIES` binding | **CONFIRMED, `(no current test)` → covered** | See below. |
| 11 — `readBoxFile` prefers `execTimed` | **CONFIRMED, `(no current test)` → covered** | See below. |
| W2-B — AC2 consumes `f11-roster.yaml` it does not create | **CONFIRMED** | The roster was written by the F11 test body (a sibling TEST, not a hook), and F14 + AC2 both read it. `bun test -t "DF2.10 AC2"` ran the script with a missing roster. Fixed. |
| W2-B — the AC2 shell test inherits the host `OPENROUTER_API_KEY` | **CONFIRMED** | Fixed at the root, for all four direct-script spawns. |
| Both pre-existing timing flakes | **CONFIRMED, reproduced at pristine HEAD on this host** | Fixed. Evidence below. |

---

## The `PI_REVIEWED_SERIES` binding (the highest-value item)

`PI_VERSION` is now IMPORTED from `scripts/build-exedev-image.ts` (safe: that module guards its
entry with `if (import.meta.main) main()`, so importing it runs nothing), and three things hang
off it:

1. **The binding assertion** — a new test in the `defaults are the story's constants` describe
   reads `assertions-in-box.sh` and asserts
   `/^PI_REVIEWED_SERIES="([^"]*)"$/m` captures exactly `PI_VERSION.split(".").slice(0,2).join(".")`.
   Non-vacuous in both directions: a rename of the shell constant makes the capture `undefined`
   and the explicit `toBeDefined()` fails; a drifted value fails the equality. Verified the regex
   really captures on the current file (`bun -e … → "0.84"`), so it is not passing on a null match.
2. **The passing shim** — `installCurlShim`'s `pi` stub now echoes `${PI_VERSION}` instead of the
   literal `"0.84.4"`. After a pin bump this shim follows the real boxes.
3. **The refusing shim** — the AC2 stub's version is DERIVED, `UNREVIEWED_PI_SERIES` = one minor
   above the pin, so a bump can never turn the refusing shim into a reviewed one; the assertion
   that the note names the refused series is `toContain(UNREVIEWED_PI_SERIES)`, not `/0\.99/`.

Fourth copy noted and NOT bound: `fixtures/fake-exedev.ts`'s `DEFAULT_IMAGE_MARKER.piVersion`
(`fake-exedev.ts:105`) is still a hand-typed `"0.84.4"`. It is in the other agent's file — see
"For the fake's owner" below.

---

## Additions and re-pins, by file

### `setup-gate.test.ts`

- `PI_VERSION` / `IMAGE_MARKER_PATH` imports; `PI_SERIES`, `UNREVIEWED_PI_SERIES` derived.
- `ASSERTIONS_SCRIPT` — one module-level const replacing four identical inline
  `join(import.meta.dir, "…/assertions-in-box.sh")` re-typings.
- `writeShimRoster(dir)` — writes `f11-roster.yaml` and returns the path. Called by F11, F14,
  AC2 and the new D7 test, so **each of them creates what it consumes**. Verified:
  `bun test -t "DF2.10"` → 3 pass, 0 fail with no sibling test having run.
- `shimEnv(binDir, home)` — the spawn env for a direct script run, with
  `OPENROUTER_API_KEY: undefined`. Applied to ALL FOUR spawns (F11, F14, AC2, D7), not only the
  one the finding named: the script `. "$EnvFile"`s the key it actually uses
  (`assertions-in-box.sh:71`), so nothing legitimate needed the inherited one, and the leak was
  the same class in every copy. The round-6 empty-PATH spawn already passed a minimal env.
- AC1 now captures the gate's log lines through `setLogSink` and asserts the `gate_b0` line
  (item 5). Folded into AC1 rather than given its own test: a second full gate is a second fake
  box to provision and tear down for four assertions about one line — and the extra box measurably
  fed the teardown-hook timeout below.
- AC2: the derived-series assertions plus `items === ["D"]`.
- New: the D7 arm.
- INV-4/INV-5: the marker debug command.
- **`D10: a non-string requestId …` gained a `60_000` budget.** It creates a box and runs the gate
  to its first emission under bun's 5 s DEFAULT — measured failing at 5 018 ms at pristine HEAD on
  this host. Every sibling test that provisions a fake box already carries 60 s.
- **Hook budgets (`HOOK_TIMEOUT_MS = 60_000`) on the three `beforeAll`/`afterAll`s** that git-init
  a repo or `rm -rf` a tree holding one clone per fake box. This is the `(unnamed)` failure both
  fix-gate and my runs saw: bun's default HOOK timeout is 5 s, and the failure names nothing —
  a flake in the shape of a mystery. Probed the mechanism directly before trusting it: a 6 s
  `afterAll` fails bare and passes with an explicit `20_000`, and bun reports the bare one exactly
  as `(unnamed)`.

### `read-box-file.test.ts`

- `timedDriverOf` — the same structural fake with `execTimed` PRESENT, recording every
  `(argv, timeoutMs)`; its `exec` THROWS, so taking the untimed path is a failure, not a silent
  pass. New test asserts both calls (`test -f`, then `cat`) were handed the caller's `5_000`, not
  the transport's 120 000 ms default. The existing `driverOf({exec})` tests are untouched and
  still exercise the `exec` fallback.

---

## The timing flakes — before / after

**Attribution, measured on this host while the other agents' suites were running** (my two files
reverted with `git checkout --`, Wave 1's source left in place, then restored):

| | pass | fail | which |
|---|---|---|---|
| **pristine HEAD** | 41 | **5** | round-4 C/D/E floor · round-5 no-time-left · round-4 E non-finite (60 s timeout) · `(unnamed)` hook · D10 requestId |
| **with my diff** | 50 | 0 | — |

Both timing tests, the D10 test and the hook DO reproduce at pristine HEAD under load. My diff
removes all five and adds none.

**Why the suggested fix would not have worked, and what I did instead.** Widening the tax alone
does not widen round-4's window. Its condition is `0 < budget − REAL elapsed < 1000`, so the
tolerance on real execution time is 1 000 ms wide no matter what the tax is — the tax and the
budget cancel. I tried the proportional widening first (fixed 1 200 ms tax, budget 9 × 1 200 + 500)
and it **failed on the very first run**: `Received: [ "A", "B" ]`, i.e. C/D/E refused, because nine
real spawns on a loaded host overran the 500 ms of slack. Padding each call to a fixed duration
(so real time hides inside the tax) helps but still fails once any single call exceeds the tax.

The instrument that does hold states the condition directly: **the last taxed call before C/D/E
burns the clock DOWN to a known remaining time**. `ROUND4_BUDGET_MS = 15_000`,
`ROUND4_REMAINING_MS = 500`; the stall happens AFTER the seam returns, so it never eats any call's
own SIGKILL deadline. What the test proves is unchanged — the gate-script call saw
`1 ≤ timeoutMs < 1_000` — and it is now a function of the clock, not of the host. Two guards keep
it honest rather than merely green: `expect(seen.findIndex(c => c.gateScript)).toBe(TAXED_CALLS)`
fails loudly if a seam call is added or removed ahead of C/D/E (the arithmetic depends on the
count), and `expect(preCdeMs).toBeLessThan(ROUND4_BUDGET_MS - ROUND4_REMAINING_MS)` reports the
host's real consumption in numbers if a machine ever IS too slow, instead of a bare `toContain`.

Round-5's clock is frozen, so its failure was never virtual arithmetic: `budgetFree()` is handed to
the fake as a REAL deadline enforced with a SIGKILL, and a schedule that advances slowly starves
the LAST calls of real time (at 500 ms/call against a 4 500 ms budget, call 8 and call 9 both sat
on the 1 000 ms floor). `FROZEN_STEP_MS = 4_000` with the budget derived from it buys those calls
4-30 s of real time and **costs zero wall time** — the clock is frozen, nothing sleeps. The virtual
arithmetic is identical: nine steps consume exactly the budget, remaining is exactly 0 at C/D/E.

**Repeat runs** (`bun test … -t "C/D/E"`, which selects both timing tests):

```
run1 exit=0   2 pass  0 fail
run2 exit=0   2 pass  0 fail
run3 exit=0   2 pass  0 fail
```

Plus green in both full-file runs after the change (the last one 50 pass / 0 fail), and green in
the earlier full-file run where the only remaining failure was the pre-existing hook timeout.

---

## For the fake's owner (W2-A / `fixtures/fake-exedev.ts`)

No fake knob was needed for anything I did — flagging one thing that is theirs, not a request:

- `DEFAULT_IMAGE_MARKER.piVersion` (`fake-exedev.ts:105`) is the FOURTH hand-typed copy of the
  pinned pi version and is now the only unbound one. `PI_VERSION` is importable from
  `scripts/build-exedev-image.ts` with no side effects (`if (import.meta.main) main()`), so
  `piVersion: PI_VERSION` in the fake would close it. Cheap, and it belongs in that file.
- Unrelated to my cluster but named in fix-gate §3: reaching the `image-marker-unreachable` arm
  needs a fake knob for the probe's exit code (137/255). That regression test is W2-A's.

## Not done, deliberately

- No source-side change of any kind; nothing in Wave 1's diff conflicted with a test I needed.
- No `toHaveLength(5)` on `debugCommands`. Pinning the COUNT would make every future debug command
  a test edit while proving nothing; pinning the marker command by content proves the thing AC1c
  actually needs.
- The `(unnamed)` hook and the D10 budget are strictly speaking not on my work order, but both live
  in my file, both reproduce at pristine HEAD, and both are the same disease as the two named
  flakes — a load-driven failure that names nothing and gets muted.
