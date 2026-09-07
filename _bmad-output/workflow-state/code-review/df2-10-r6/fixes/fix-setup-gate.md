# F5b — `setup-gate.ts` + `assertions-in-box.sh` + `setup-gate.test.ts`

Branch `fix/df2.10-review-round-6`. Three files touched, nothing else.

**14 fixed · 1 false positive · 1 flagged out-of-brief · gates pass**

---

## Fixed

### P101 [HIGH] `ready` computed from "no failed row", never "every row ran"
`src/providers/exedev/setup-gate.ts:699-724`

`const ready = firstFail === undefined;` → `const ready = firstFail === undefined && notRun.length === 0;`
(`notRun` is now computed above `ready` so it can feed it.)

Two dependent changes fall out:
- `...(ready ? {} : { failedItem: firstFail.item, … })` → `...(firstFail === undefined ? {} : …)`.
  Keying the spread on `ready` would have dereferenced `firstFail.item` on the new
  `ready:false && firstFail === undefined` shape — a TypeError out of the assembly.
- `failedItem`/`assertionCode` are therefore **absent** on a not-ran-only refusal. Verified
  `dispatch.ts:2957-2959` already omits both from the run record when undefined, and
  `dispatch.ts:3003` already names an assertion-less `ready:false` gate rather than printing
  "failed at item ?". The new shape lands on paths that were already written for it.

See **Behaviour changes for wave 2**.

### P84 [MED] `result.error` attached without checking `markerError` belongs to `firstFail`
`src/providers/exedev/setup-gate.ts:718-724`

`...(ready || markerError === null ? {} : { error: markerError })` →
`...(firstFail?.item === "B" && markerError !== null ? { error: markerError } : {})`.

The doc comment on `SetupGateResult.error` says "present iff the **failing** assertion carried a
typed refusal"; the code only checked that *some* typed refusal existed.

*Trigger caveat, recorded honestly:* the reviewer's stated trigger ("the diff shows no `aOk` guard
around the B block") is **wrong** — `setup-gate.ts:479` is `if (assertions[0]?.ok === true)`, so B0
cannot run after a failed A, and no A-fail + marker-error combination is reachable today. The fix
is kept anyway: it is one line, it makes the code match the contract the field documents, and the
guard is what stops the next reordering from silently violating it. Not counted as a false
positive because the defect (identity never checked) is real; only the reachability claim was.

### [LOW] Stale budget comment after the one-budget-for-the-pair change
`src/providers/exedev/setup-gate.ts:496-509`

Verified against `transport.ts:157-170`: `readBoxFile` takes ONE absolute deadline from the single
`budgetFree()` snapshot and splits it across `test -f` and `cat`, and it is `left()`'s `Math.max(1, …)`
— not `budgetFree()`'s 1 s floor — that stops a zero/negative timeout. Comment rewritten to say
exactly that, including the contrast with A (whose two git calls *do* take a fresh `budgetFree()`
each) and `readBoxFile`'s explicit "budget exhausted by the presence probe" naming.

### P102 [MED] the pi-version fallback re-opened the banner failure — refuses every box in the fleet
`src/providers/exedev/assertions-in-box.sh:160-200`

```sh
-  pi_full="$(printf '%s\n' "$pi_version_out" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
+  pi_full="$(printf '%s\n' "$pi_version_out" \
+    | sed -n 's/^pi[[:space:]]\{1,\}\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\).*$/\1/p' | head -1)"
```

Anchored to the version LINE. Executed proof of the old behaviour vs the new, on the reviewer's
own input:

```
$ printf 'A new version 0.99.0 is available (you have 0.84.4)\npi 0.84.4\n' | grep -oE '…' | head -1
0.99.0            # old — pi_series 0.99, D-pre refuses every box
$ printf '…same…' | sed -n 's/^pi[[:space:]]\{1,\}\(…\).*$/\1/p' | head -1
0.84.4            # new
```

POSIX BRE (`\{1,\}`, `[[:space:]]`) — works under both GNU and BSD sed.

### [LOW] The `timeout` fallback reintroduced the stall the block exists to prevent
`src/providers/exedev/assertions-in-box.sh:172-200`

The `command -v timeout` / bare-call pair is **gone**. There is now one always-bounded path, riding
`python3` — already a hard dependency asserted at the top of the script:

```sh
pi_version_out="$(python3 -c '
import subprocess, sys, tempfile
with tempfile.TemporaryFile("w+") as f:
    try:
        subprocess.run(["pi", "--version"], stdout=f, stderr=subprocess.DEVNULL, timeout=10)
    except Exception:
        pass
    f.seek(0)
    sys.stdout.write(f.read())
' 2>/dev/null)"
```

Two calls I made deliberately, both recorded in the source comment:

- **Not "refuse when `timeout` is absent"** (the report's first option). `timeout` is not on this
  repo's dev host (macOS: no `/usr/bin/timeout`, no `gtimeout`) and the fake substrate's hermetic
  PATH is `${box.bin}:/usr/bin:/bin` (`fixtures/fake-exedev.ts:499`), so a 125 dependency refusal
  would red every gate test in the suite and force an edit to another fixer's fixture file. The
  report's second option — bound the call ourselves — costs nothing and is strictly better on real
  boxes too (always bounded, never conditionally).
- **stdout to a temp FILE, not a captured pipe.** With `capture_output=True`, a stalled pi that
  forked leaves a grandchild holding the pipe's write end, and the drain `subprocess.run` performs
  after the kill blocks for the grandchild's whole lifetime — the bound would be no bound. Proven
  by execution against a 30 s stub with `timeout=3`: `elapsed=3 out=[]`.

Behaviour on a stall/crash/missing binary is unchanged in kind: empty output → the existing
fail-closed "could not report a pi version" arm.

### [LOW] A D-pre refusal emits `D` before `C` emits anything
`src/providers/exedev/assertions-in-box.sh:13-19` (header stdout contract)

The consumer half of this was already solved host-side — `SetupGateResult.notRun` exists precisely
for it and is asserted at `setup-gate.test.ts:458` (`notRun: ["C","E"]` on a D-pre refusal, in the
result *and* in the evidence artifact). What was missing was the script's own stdout contract,
which still said "one JSON line per executed assertion (C, D, E)" and read as an ordered stream.
Rewritten to state that lines are the executed ones only, not necessarily in letter order, that a
D-pre refusal emits a lone `D` with no `C` at all, and that a missing letter is "never ran", not
"failed".

Renaming the emitted letter to `D-pre` was rejected: `setup-gate.ts:605` gates on
`KNOWN = {A,B,C,D,E}` and drops anything else, so a `D-pre` line would be silently discarded and
the exit-3 would fall into the fail-closed arm. Emitting a synthetic `C skipped` line was rejected
for the reason the `notRun` docblock already gives — a fabricated C row ahead of a failed D
rewrites `assertionCode` 3 into 2 and sends dispatch to the wrong table.

### [MED] Untested branch: present registry + unreviewed series
`tests/providers/exedev/setup-gate.test.ts` — new
`"DF2.10: the version check is scoped to the ABSENT-registry arm — a PRESENT registry evaluates D normally on any series"`

Unreviewed pi (`UNREVIEWED_PI_SERIES`, derived one minor above the pin) + a present, fully-priced
`models.json` ⇒ D passes on the scan, `C/D/E` all emitted, exit 0, and the note carries neither
`UNREVIEWED` nor `custom registry absent`. Hoisting either D-pre refusal out of the
`if [ ! -f "$models_json" ]` guard now goes red here; before, all four pi tests stayed green.

### [MED] Zero coverage on the pi-version fallback
`tests/providers/exedev/setup-gate.test.ts` — new
`"DF2.10: the version FALLBACK reads the \`pi X.Y.Z\` prefix form off the version LINE, never the first semver in a banner"`

One shim falsifies both this finding and P102: banner first (`A new version <higher> is available`,
semver-shaped), the real version only in the `pi X.Y.Z` prefix form, **no bare-version line
anywhere**. Absent registry, so D must be granted the tolerance — which it can only be if the
INSTALLED version was read.

- Delete the fallback ⇒ `pi_full` empty ⇒ `could not report a pi version` ⇒ red.
- Un-anchor the fallback ⇒ reads `0.99.x` ⇒ `UNREVIEWED` ⇒ red.

Both failure modes are asserted separately so a red names which one it is.

### [MED] Three fail-closed arms of the script asserted by nobody
`tests/providers/exedev/setup-gate.test.ts` — three new tests

1. **empty `models_json`** and 2. **non-absolute `models_json`** — one loop, two tests
   (`"DF2.10: an empty|non-absolute models.json path derivation REFUSES D …"`). New
   `shimExpanduser(binDir, prints)` helper overwrites `installCurlShim`'s python3 symlink with a
   wrapper doubling **only** the `expanduser` invocation and exec'ing the real interpreter for
   everything else. Both tests plant a **present, fully-priced** registry, so the refusal must fire
   on the broken derivation alone; both assert exit 3, the named note, the absence of the
   `custom registry absent` pass-phrase, and `parsed.map(item) === ["D"]` (refused before C's spend).

   *Landmine hit while writing this:* both refusal notes quote the word "expanduser", so an
   argv-wide `case "$*"` match in the shim swallowed `emit`'s own invocation and the script exited
   3 having printed nothing at all. The shim matches on `$2` — the `-c` program — and says so.

3. **the absent-`timeout` degradation** — the branch no longer exists, so the test proves the
   property the branch was supposed to provide:
   `"DF2.10: a pi that STALLS on --version is bounded — the gate refuses D instead of burning the whole budget"`.
   A pi shim that `exec sleep 60`s (exec, not fork, so the bound's kill is complete and nothing is
   orphaned); asserts the named `could not report a pi version` refusal, exit 3, and
   `elapsedMs < 30_000` against a 10 s bound and a 60 s stall.

### [LOW] The happy path never asserts `notRun` is absent
`tests/providers/exedev/setup-gate.test.ts` — AC1 all-pass test

`expect(result.notRun).toBeUndefined()` on the result **and** on the parsed evidence artifact.
Absent, not `[]` — and now doubly load-bearing, since `ready` depends on the same emptiness.

### [LOW] `boot_ready_ms >= gate_a_ms` is a tautology
`tests/providers/exedev/setup-gate.test.ts` — AC1 all-pass test

Dropped, with a comment saying why: `gateStart <= t` and the two `Date.now()` reads in that order
make it unfalsifiable without also failing the `>= 1` line above it, and there is no independent
measure of the provisioning span at this seam to turn it into the check it looks like. Keeping a
control that cannot fail is worse than not having one.

### [LOW] Vacuous `preCdeMs`
`tests/providers/exedev/setup-gate.test.ts` — round-4 floor test

`expect(seen.findIndex((c) => c.gateScript)).toBe(TAXED_CALLS)` moved **above** the three timing
assertions (and removed from its old position). The report's alternative — initialise `preCdeMs`
to a sentinel — does not work: every sentinel below the bound passes it too. Noted in the comment.

### [LOW] The pi shims rot on a prerelease `PI_VERSION`
`tests/providers/exedev/setup-gate.test.ts:68-80`

Module-level guard, throwing before any test registers:

```ts
if (!/^\d+\.\d+\.\d+$/.test(PI_VERSION)) { throw new Error(…); }
```

Covers both halves the report names: the shims' bare-version `echo` silently sliding onto the
fallback, and `Number()` on a non-numeric minor making `UNREVIEWED_PI_SERIES` read `"1.NaN"`.

### [LOW] `writeShimRoster` leaves `f11-roster.yaml` behind
`tests/providers/exedev/setup-gate.test.ts:52-64` and all call sites

`writeShimRoster(dir)` → `writeShimRoster(dir, name)`, writing `${name}-roster.yaml`, and every
caller now `rmSync`s it in the same `finally` as its `binDir`/`envFile`/`homeDir`. Nine call sites
(five existing, four new).

---

## False positives

### [LOW] `PI_REVIEWED_SERIES` is a third hand-maintained copy with "no binding test"
`blind-oci-image.md`: *"No test is present in this diff, so nothing in the reviewed change enforces
the binding."*

**Refuted.** `tests/providers/exedev/setup-gate.test.ts:168-183` is exactly that test:

```ts
test("DF2.10 AC2: assertions-in-box.sh's PI_REVIEWED_SERIES tracks the pinned PI_VERSION", () => {
  const src = readFileSync(ASSERTIONS_SCRIPT, "utf8");
  const pinned = src.match(/^PI_REVIEWED_SERIES="([^"]*)"$/m);
  expect(pinned?.[1]).toBeDefined();
  expect(pinned?.[1]).toBe(PI_SERIES);          // PI_SERIES derived from the imported PI_VERSION
});
```

It greps the constant out of the shell file and compares it to the series of the imported TS pin,
and it asserts the constant still exists under that name. Bump `PI_VERSION` alone, or rename the
constant, and it is red. The reviewer was blind to the test file.

Not patched. The script's comment (`"the binding is a test's job, not this file's"`) now **names
the test**, so the next reader does not have to take the claim on trust — that is the whole edit.

---

## Noted, not fixed — out of brief

**P89 [MED] the marker gate over-claims "PROVES" (drift, not tamper)** — `blind-driver-src.md`
names two files: `transport.ts` (`imageMarkerFailure`) and **`setup-gate.ts:485`**
(`// ── B0 (DF2.10 AC1c): the box PROVES what it booted` and the "this proves the box that ACTUALLY
booted matches the pin" sentence at `:491`). My brief scoped me to exactly two findings from that
report and this is not one of them, and the F5a fixer who owns the finding cannot edit my file.
**The `setup-gate.ts` half will fall between us unless someone assigns it.** It is a two-sentence
prose change; I left it alone rather than override an explicit scoping decision.

---

## Impact analysis

`mcp__gitnexus__impact {target: "setupGate", direction: "upstream", repo: "/Users/steve/QDS-Factory"}`

```
impactedCount: 0 · risk: LOW · epistemic: "exact" · processes_affected: 0 · modules_affected: 0
```

**The index is under-reporting and I did not trust it.** Grep found the real consumers of the
symbol and of the result shape; each was read and checked by hand:

| consumer | reads | verdict |
|---|---|---|
| `src/providers/exedev/driver.ts:1187` | `setup()` → `setupGate(this, vm, opts)` | pass-through, unaffected |
| `src/fleet/dispatch.ts:2882` | `deps.setupGate ?? realSetupGate` | **the one that matters** — see below |
| `scripts/cap-hit-demo.ts:791,807,811` | `!setupResult?.ready` | `ready:false` ⇒ refuse; safe direction |
| `src/providers/fake-gate.ts:366` | builds its own `SetupGateResult` | never sets `notRun`; its own `ready` is untouched, no change needed |
| `tests/providers/exedev/setup-gate.test.ts` | 5 sites asserting `ready`/`notRun` | all checked, none flip — see below |

`dispatch.ts` was read line by line for the new shape and is already written for it:
- `:2934` strict-boolean guard on `ready` — unaffected.
- `:2943` `if (!gate.ready)` — a not-ran-only gate now takes the refusal path. Correct.
- `:2957-2959` `...(gate.failedItem === undefined ? {} : …)` — explicitly omits, "never defaulted".
- `:3003` names an empty/all-passing `assertions` on a `ready:false` gate instead of printing
  "failed at item ?".

Impact of the `error` identity gate: `markerError` is only ever set on a pushed failing `B` row, so
no currently-reachable payload changes shape.

---

## Behaviour changes for wave 2

> ### `setupGate` can now return `ready: false` with **no** `failedItem` and **no** `assertionCode`.

**What changed.** `ready` is now `firstFail === undefined && notRun.length === 0`. A gate that
previously reported `ready: true` while `notRun` was non-empty — every A–E row that never ran and
never pushed a failing row — now reports `ready: false`.

**What a live-e2e author must know:**

1. **`expect(result.ready).toBe(true)` is now strictly stronger.** It asserts all five of A–E
   executed, not merely that nothing failed. If a live test starts failing on `ready`, read
   `result.notRun` first — it names exactly which assertions never ran, and that is the new
   information, not a regression in the box.
2. **`failedItem` and `assertionCode` may be `undefined` on a `ready:false` result.** Any live
   assertion of the form `expect(result.assertionCode).toBe(N)` after a `ready:false` must not
   assume presence. They are deliberately absent rather than fabricated: there is no failed row to
   name, and inventing one would rewrite the code dispatch routes on.
   `dispatch.ts` handles this; ad-hoc test code may not.
3. **`result.error` now requires `failedItem === "B"`.** Previously any produced `markerError` was
   attached to any non-ready result. Not reachable today (B0 only runs after A passes, and a marker
   failure always pushes a failing B row), so no live artifact should change — but if a live test
   greps for `error.code === "image-marker-…"`, it now also implies `failedItem === "B"`.
4. **Evidence artifacts.** `.sandbox/setup-gate/<runId>.json` gains the same two properties. The
   happy path still carries no `notRun` key at all (asserted, not `[]`).
5. **No existing test flipped.** All five `ready`-asserting tests in `setup-gate.test.ts` were
   checked by hand: the three `ready:true` ones (AC1 all-pass, AC6 sentinel, E usage-null) all
   carry a complete A–E table, and every `ready:false` one has a real `firstFail`. 54/54 green.

> ### `assertions-in-box.sh` no longer uses coreutils `timeout`.

`pi --version` is bounded by a `python3` subprocess with `timeout=10` on **every** box, including
ones that have `timeout`. Real-box behaviour is unchanged in kind (a stall still yields the
"could not report a pi version" D-pre refusal) and is now bounded on boxes that previously were
not. Measured cost on the fake substrate: **+60 ms per gate run** (10 iterations: 1.894 s → 2.496 s),
i.e. noise against any live budget.

---

## Gates

All run from `/Users/steve/QDS-Factory` on `fix/df2.10-review-round-6`.

### `bun test tests/providers/exedev/setup-gate.test.ts`

```
$ bun test tests/providers/exedev/setup-gate.test.ts > /tmp/df210-review/f5b-test.log 2>&1; echo "exit=$?"
exit=0
$ tr '\r' '\n' < …f5b-test.log | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error|^ *[0-9]+ (pass|fail)"
 54 pass
 0 fail
```

(54, up from 49: five tests added.)

### `bun test tests/providers/exedev/`

```
 234 pass
 6 fail
```

**None of the six are mine.** Breakdown:

- **4 × `image-assets.test.ts`** — `DF2.10 AC6 — qds-run@.service …` (`every AC6 policy holds`,
  `no ExecStart`, `every mutation is rejected`, `the mutations are real`). `git diff --stat` on that
  path shows **75 insertions from another fixer** (`fix-oci-image`, actively editing `oci/exedev/*`
  and `image-assets.test.ts`). Not my files; not touched by me.
- **2 × `setup-gate.test.ts` 60 s timeouts under directory-wide load** — `AC6: a stale
  /tmp/PROVISION_READY is cleared` and `round-4 regression: E rejects non-finite and boolean credit
  values`. Both pass in the file's own run (54/54) and the first passes in isolation in 5.8 s.

  I did not take the second on trust. **Measured against baseline:** reverted
  `assertions-in-box.sh` to `HEAD`, ran that one test in isolation —

  ```
  HEAD script:  (fail) … [60013.75ms]   5 expect() calls
  my script:    (fail) … [60044.31ms]  10 expect() calls
  ```

  The timeout is **pre-existing** (it creates four fake boxes and runs four full gates against a
  60 s budget) and my version got twice as far in the same wall time. Script restored; `git diff
  --stat` confirms my version is back in place. Not introduced here, not in my finding list —
  flagging it as a real budget-sizing flake someone should size properly.

### biome

```
$ bunx biome check src/providers/ tests/providers/
Checked 62 files in 1770ms. No fixes applied.
```

### tsc

```
$ bunx tsc --noEmit; echo "tsc exit=$?"
tsc exit=0
```

### shell

```
$ sh -n src/providers/exedev/assertions-in-box.sh && echo "sh syntax ok"
sh syntax ok

$ shellcheck -s sh src/providers/exedev/assertions-in-box.sh
In src/providers/exedev/assertions-in-box.sh line 335:
d_scan="$(python3 -c '
                     ^-- SC2016 (info): Expressions don't expand in single quotes …
```

`SC2016` is **pre-existing and intentional** — verified against the base:

```
$ git show HEAD:src/providers/exedev/assertions-in-box.sh > /tmp/baseline-inbox.sh
$ shellcheck -s sh /tmp/baseline-inbox.sh 2>&1 | grep -oE "SC[0-9]+" | sort -u
SC2016
```

Same single code, same line, unchanged by this fix (the D-scan python body is single-quoted on
purpose — the comment above it says why). My new python block draws no new findings.
