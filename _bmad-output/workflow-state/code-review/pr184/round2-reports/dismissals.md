# PR #184 round-2 — dismissal verification

Scope: the 8 findings recorded under "Dismissed — verified false against real source"
(`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md:403-405`).
I verified each REFUTATION's factual premise against current source on `feature/df2.10`.
Read-only; no files modified; no full test suite run.

---

## D1 — in-box refusal colliding with the D pass-matcher

**Finding:** the new D-pre refusal in `assertions-in-box.sh` could match the pass-matcher and read as a pass.
**Recorded refutation:** the real `case` arms are `*"custom registry absent"*` and `*" models priced"`; the refusal matches neither.

**Evidence** (`src/providers/exedev/assertions-in-box.sh`):
- Line 270-271 — the pass-matcher, exactly as the refutation states:
  ```sh
  case "$d_scan" in
    *"custom registry absent"*|*" models priced") : ;;
  ```
- The two new refusals (lines 130 and 137) contain neither string. Line 137 ends
  `"…PI_VERSION moved without re-checking whether absence is still production-legal"`;
  line 130 ends `"…a runtime that will not identify itself"`.
- Stronger than the refutation itself: both refusals `emit D 0 …; exit 3` in the D-pre
  block (lines 125-140), **before** C runs and before `d_scan` is ever assigned — the
  `case` only ever inspects `$d_scan`, so the refusal text structurally cannot reach the
  matcher at all.
- Host side is text-blind: `setup-gate.ts:560-580` parses the script's stdout as JSON
  lines and trusts only the `ok` boolean (plus the exit-code/evidence coherence check),
  so no second, host-side text matcher exists for the note to collide with.

**Verdict: REFUTATION HOLDS.**

---

## D2 — `pi --version` parsed two contradictory ways

**Finding:** two parse sites assume contradictory output spellings (bare `0.84.4` vs prefixed `pi 0.84.4`).
**Recorded refutation:** real output is bare `0.84.4`; both spellings agree.

**Evidence:**
- Strict site — `oci/exedev/Dockerfile:277-279`:
  ```
  && pi_observed="$(pi --version)" \
  && [ "${pi_observed}" = "${PI_VERSION}" ] \
  ```
  passes only if output is exactly `0.84.4` (bare). The pinned image built and was
  live-booted, so this equality held at build time.
- Lenient site — `src/providers/exedev/assertions-in-box.sh:123`:
  `grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1` — accepts bare or prefixed.
- Direct raw capture: `tests/fleet/e2e/tier1-image-contract.live.test.ts:319` records
  `piRaw: piVer.stdout.trim().slice(0, 200)` from a live in-box `pi --version`, and both
  evidence files from 2026-09-01 (`_bmad-output/evidence/df3-e2e/2026-09-01-113654-t1-image-contract.json:85`,
  `…-114112-…:86`) record `"piRaw": "0.84.4"` — the output is literally bare.
- (Third parse site, `src/phase-engine/roster/validate.ts:712` `^\d+\.\d+\.\d+`, targets
  the HOST pi, a different binary, and also accepts bare output — no contradiction there
  either.)

Given bare output, the strict equality and the lenient grep agree; the parsers only
diverge on an output shape the substrate demonstrably does not produce, and the strict
one would fail the build (not silently mis-pass) if that ever changed.

**Verdict: REFUTATION HOLDS.**

---

## D3 — `readFileSync` used with no import

**Recorded refutation:** the import is present at `driver.ts:28`.

**Evidence** (`src/providers/exedev/driver.ts`):
- Line 28: `import { readFileSync, statSync } from "node:fs";`
- Usages at lines 391, 899, 1196 — all covered by that import.
- The other `driver.ts` (`src/providers/driver.ts`) contains **zero** occurrences of
  `readFileSync` (grep exit 1), so there is no second call site the refutation misses.

**Verdict: REFUTATION HOLDS.**

---

## D4 — four SKILL.md claims

**Recorded refutation:** all four confirmed by running the documented greps —
`liveGate` checks six env vars and never opens the roster; every tier argument in the
table matches.

**Evidence:**
- Six env vars — `tests/fleet/e2e/live-harness.ts:55-69`: `liveGate` checks
  `QDS_E2E_LIVE` (56), `QDS_E2E_TIER` (59), then `SUBSTRATE_ENV` (lines 41-46) =
  `QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`,
  `OPENROUTER_PROVISIONING_KEY`. 2 + 4 = six, exactly the six SKILL.md:56-58 names.
- Never opens the roster — the `QDS_EXEDEV_ROSTER` check is
  `(process.env[name] ?? "").trim() === ""` (line 62): presence only, no `readFileSync`/
  `open` in `liveGate`. The file is opened by `rosterModels()`
  (`src/providers/exedev/setup-gate.ts:169`, called at 354 "throws on a malformed roster —
  before any spend") — exactly as SKILL.md:58-61 says ("a bogus roster path sails through
  `liveGate()` and dies at setup").
- Tier arguments vs table (SKILL.md:69-75) — checked **every** `liveGate(` call site in
  `tests/fleet/e2e/`:
  - all eight tier-1 files (driver-lifecycle, provision-status, harvest ×2, teardown ×2,
    fanout-refusal, lock, approval-gate ×2, attach-transport) call `liveGate("1")` ✓
  - tier2-dispatch-engine, tier2-fanout-bestofn: `liveGate("2")` ✓
  - the two "misnamed" files — tier1-image-contract:108 and tier5-gate-steering:184 —
    call `liveGate("2")` exactly as row 3 warns ✓
  - all tier3 files (race, manystories ×2, expose-port, reaper ×2, remote-phases) and
    tier4-resident call `liveGate("2")`, consistent with SKILL.md:37
    ("`QDS_E2E_TIER=2 # … 2 for tiers 2/3/4`") ✓
  No call site contradicts the table.

**Verdict: REFUTATION HOLDS.** (The four claims are not individually enumerated in the
dismissal line, but every premise the refutation states checks out against source, and
the tier-argument sweep covered all 28 call sites, not a sample.)

---

## D5 — dependabot `github-actions` entry claimed missing

**Recorded refutation:** it exists.

**Evidence** (`.github/dependabot.yml`):
```yaml
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      actions:
        update-types: [minor, patch]
```
Present, weekly, grouped — alongside the npm, `/oci` docker and `/oci/exedev` docker
entries.

**Verdict: REFUTATION HOLDS.**

---

## D6 — `remediation.includes(secret)` claimed to be element-equality

**Finding:** the assertion `expect(err.remediation.includes(secret)).toBe(false)` was
claimed to be `Array.prototype.includes` (element equality), i.e. a secret embedded in a
longer remediation string would slip through.
**Recorded refutation:** `ProviderError.remediation` is `readonly remediation: string`,
so `.includes` is substring containment and the original assertion was right; a
serialized-form assertion was added beside it anyway.

**Evidence:**
- `src/providers/errors.ts:22`: `readonly remediation: string;` on `ProviderError`.
- The thrown class chains to it: `src/providers/exedev/transport.ts:21`
  `export class ExeDevDriverError extends ProviderError`, and the subclass constructor
  (`src/providers/driver.ts:91`) passes `remediation` straight through as a string.
- On a `string`, `.includes` is `String.prototype.includes` — substring containment. The
  original assertion therefore did test "secret appears anywhere in the remediation".
- The promised belt-and-braces addition exists:
  `tests/providers/exedev/image-contract.test.ts:686-687`:
  ```ts
  expect(caught?.remediation.includes(secret)).toBe(false);
  expect(JSON.stringify({ message: caught?.message, remediation: caught?.remediation }).includes(secret)).toBe(false);
  ```
  with the comment at 682-685 recording exactly this reasoning.

**Verdict: REFUTATION HOLDS.**

---

## D7 — B0 budget finding #1 (zero/negative timeout handed down)

**Finding (as recorded):** B0's second exec could receive a zero/negative budget (or
launch past the deadline).
**Recorded refutation:** `budgetFree()` has a 1 000 ms floor.

**Evidence** (`src/providers/exedev/setup-gate.ts`):
- Line 375: `const budgetFree = () => Math.min(assertTimeoutMs, Math.max(1_000, deadline - Date.now()));`
  — every free-phase call gets ≥ 1 000 ms, never zero or negative.
- B0 cannot even start past the deadline: assertion B is entered only through the
  `Date.now() >= deadline` guard at line 454, and B0 sits inside its `else`.
- The only paid step (C/D/E) does NOT use the floor: lines 544-556 read
  `remaining = deadline - Date.now()` and refuse the launch outright when
  `remaining <= 0`, then pass `Math.min(assertTimeoutMs, remaining)` — so the floor
  never converts into post-deadline spend (INV-2 preserved).
- `readBoxFile` (`transport.ts:127-…`) bounds both of B0's execs (`test -f`, `cat`) with
  the passed `deadlineMs` via `execTimed`, so the budget kills the ssh rather than
  abandoning it.

Note the floor's known, documented ceiling: free calls entered just before the deadline
can each run up to ~1 s past it (comment at lines 367-374 records this as deliberate —
free commands, no spend). That is the design the refutation defends, not a gap in it.

**Verdict: REFUTATION HOLDS.**

---

## D8 — B0 budget finding #2 (B0 consumes two budgets)

**Finding (as recorded):** B0 making two exec calls under the free-phase budget was
flagged as a budget overrun / departure from the per-assertion budget model.
**Recorded refutation:** assertion A also makes two calls per budget — the shape is the
established pattern, not a B0 anomaly.

**Evidence** (`src/providers/exedev/setup-gate.ts`):
- Assertion A, lines 406-411: two separate execs (`git rev-parse HEAD`, then
  `git status --porcelain`), each with its own fresh `budgetFree()` — the identical
  two-calls-per-assertion shape.
- B0, line 490: `readBoxFile(driver, vm, IMAGE_MARKER_PATH, budgetFree())`, and
  `readBoxFile` performs `test -f` then `cat` (transport.ts, "race-probe" /
  "race-read"), both bounded.
- The in-code comment at lines 472-477 records the same argument: "B0 spends TWO
  free-phase budgets (`test -f`, then `cat`), the same shape as A's two git calls —
  `budgetFree()`'s 1 s floor means neither can hand a zero or negative timeout down, and
  the only SPEND (the C/D/E launch) is still refused outright once the deadline passes."
- The whole-gate deadline is still honoured where it matters: the free-call count is
  fixed and small (~9 execs), and every paid call is refused after `deadline`.

**Verdict: REFUTATION HOLDS.**

---

## Summary

| # | Dismissal | Refutation premise | Verdict |
|---|-----------|--------------------|---------|
| D1 | in-box refusal vs D pass-matcher | case arms `*"custom registry absent"*` / `*" models priced"`; refusal matches neither (and exits before the case) | HOLDS |
| D2 | `pi --version` parsed two ways | raw live output is bare `0.84.4` (`piRaw` evidence); both parsers agree | HOLDS |
| D3 | `readFileSync` without import | import at `src/providers/exedev/driver.ts:28`; no use in the other driver.ts | HOLDS |
| D4 | four SKILL.md claims | liveGate checks exactly 6 env vars, never opens roster; all 28 `liveGate(` call sites match the tier table | HOLDS |
| D5 | dependabot `github-actions` entry missing | entry present in `.github/dependabot.yml` | HOLDS |
| D6 | `remediation.includes` = element equality | `readonly remediation: string` (`errors.ts:22`) → substring containment; serialized assertion added at image-contract.test.ts:687 | HOLDS |
| D7 | B0 zero/negative budget | `budgetFree()` floors at 1 000 ms (`setup-gate.ts:375`); B0 gated behind the line-454 deadline check; spend path refuses separately | HOLDS |
| D8 | B0 spends two budgets | assertion A makes the same two-calls shape (lines 406-411); each call individually bounded | HOLDS |

No refutation is BROKEN or PARTIAL. All eight dismissals stand as recorded; none of the
original findings is live. Two observations worth keeping (neither resurrects a
finding): D1's refutation is actually *understated* — the refusal exits before the
matcher structurally, which is stronger than "the strings don't match"; and D7's floor
permits free (unpaid) execs to overrun the wall deadline by up to ~1 s each, which is
the documented, comment-recorded design being defended, not an unnoticed side effect.
