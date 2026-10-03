# fx-harness — z1-r1 fix report

File: `tests/fleet/e2e/sc2-harness.ts` (only file touched)

## GitNexus impact (pre-edit, per CLAUDE.md)

`impact({target: "writeEvidence", direction: "upstream", repo: "QDS-Factory"})` — first call ambiguous (two `writeEvidence` symbols: sc2-harness.ts:359 and live-harness.ts:477); disambiguated with `target_uid`. Result: **0 upstream impacted, risk LOW, epistemic exact**. Cross-checked by grep: no in-repo caller passes non-object payloads — every caller routes through `writeEvidenceQuietly` with object literals.

## Verdict table

| Finding | Verdict | Change |
|---|---|---|
| F-002 (MED) | FIXED | Guards added before the stamp spread |
| F-022 (LOW) | FIXED | `writeFileSync` now `{ flag: "wx" }` + EEXIST wrap naming the path |

## Diff summary (adds-only; no signature, filename-format, or existing-behavior rewrite)

1. **F-002** — non-null/non-Array plain-object guard throws `evidence payload must be a plain object — got <typeof|Array>`; caller-supplied-stamp guard throws `payload already carries swarmclawForkRev=<value> — the writer owns the stamp; a caller-supplied stamp would launder a recorded rev`. Stamp then spreads as before.
2. **F-022** — write wrapped in try/catch: `flag: "wx"` makes a same-millisecond same-name collision EEXIST; rethrown as `evidence write collision: <path> already exists (same-millisecond same-name write)`. Other errors propagate untouched.
3. Comment: 2 added lines covering the caller-stamp-ownership policy and the collision behavior (existing 4-line AC7 comment preserved).

## Behavior-change flags

- **writeEvidence now throws** on non-plain-object payloads, caller-supplied `swarmclawForkRev`, and filename collisions — previously all three silently produced corrupt/laundried/truncated evidence. All current callers pass object literals (verified by grep over tests/ + scripts/), so no caller is broken today; the throws arm future misuse.
- No other behavior change. Filename format, signature, stamp semantics, scrub gate unchanged.

## Verification

`bun test tests/fleet/e2e/` → exit 0, **63 pass / 0 fail** (116 tests across 36 files; live legs TODO as expected — run proves the module loads and suite stays green). Plus read-back of the edited region.
