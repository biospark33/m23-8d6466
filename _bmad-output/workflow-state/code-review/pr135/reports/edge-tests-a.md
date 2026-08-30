# Edge Case Hunter — tests/phase-engine/steering.test.ts + tests/fleet/resident.test.ts (+ fixtures)

Chunks reviewed in full: `chunk-steering-test.diff` (495 lines), `chunk-resident-test.diff` (693 lines). Cross-checked against `src/phase-engine/steering.ts` (319 lines), `src/fleet/resident.ts` (332 lines), `src/phase-engine/types.ts` (`sanitizeForMessage`/`formatZodIssue`), `cli-anything/scripts/team-lead-driver.ts` (`harvestPiStream`), `cli-anything/src/redact.ts`, `src/phase-engine/roster/validate.ts` (`resolveRate`/`toMicrosPerMTok`), and `tests/phase-engine/fixtures/fake-resident.ts`.

## Findings

### MEDIUM — No truncation-boundary tests at exactly the ceiling; two defensive branches of `truncateTailWithSuffix` have zero coverage
- Real code: `src/phase-engine/steering.ts:136-154` (`truncateTailWithSuffix`), `:156-164` (`renderPrompt` budget math).
- Tests: `tests/phase-engine/steering.test.ts:424-462` probe only 20 000-char and 24 025-char contexts. No case at exactly `budget`, `budget ± 1`, or whole-prompt length 15 999 / 16 000 / 16 001.
- Consequences that would pass green today:
  - An off-by-one that needlessly truncates a context of exactly `budget` chars (or fails to cut at `budget + 1` while staying `<= PROMPT_CHAR_CEILING` by luck of header/instruction length drift) is undetected — every existing assertion is `toBeLessThanOrEqual`, which tolerates an under-long prompt.
  - The surrogate-safe cut loop (`steering.ts:146-152`, cutPoint advancing past a low surrogate) is never exercised — no test context contains an astral character at the cut point. A regression splitting a surrogate pair would emit a lone surrogate into the prompt undetected.
  - The `proseBudget < 0` minimal-marker branch (`steering.ts:140-144`) is unreachable via `renderPrompt` (budget is ~15.5 k), but is exported-behavior-adjacent dead weight that no test pins either way.
- Trigger: change `<= maxLength` to `< maxLength` in `truncateTailWithSuffix` — all tests still pass.

### MEDIUM — stderr redact-then-slice(-400) error path has no coverage; no fake-pi mode can produce it
- Real code: `src/fleet/resident.ts:283-288` — on nonzero exit the FULL stderr is redacted, then the last 400 chars are thrown in the error message, with an explicit comment that cutting before redacting can leak a secret fragment split at the boundary.
- Fixture: `tests/fleet/fixtures/fake-pi-resident.ts:54-55` — `fail` mode does a bare `process.exit(3)` with empty stderr. No mode writes a secret (or a >400-char body with a secret straddling the -400 cut) to stderr.
- Test: `tests/fleet/resident.test.ts:486-499` asserts only `rejects.toThrow()` + `exitStatus "logic"` — it would pass if the redact call were deleted entirely.
- Trigger: drop `redact()` from the nonzero-exit throw, or reorder to slice-then-redact; every test stays green while a pi error containing `OPENROUTER_API_KEY` leaks into the thrown message.

### MEDIUM — `piEnv` scrub misses the resident's own env knobs: developer-shell `QDS_RESIDENT_TIMEOUT_MS` / `QDS_PI_BIN` leak into child env
- Test code: `tests/fleet/resident.test.ts:77-83` — the scrub regex is `/^(QDS_FAKE_PI_|FAKE_RESIDENT_)/` and the comment claims it stops "a developer's shell settings" leaking into the child, but `QDS_RESIDENT_TIMEOUT_MS` and `QDS_PI_BIN` are exactly the env knobs `src/fleet/resident.ts:95-100,204` reads, and they pass straight through the spread.
- Trigger: run the suite with `QDS_RESIDENT_TIMEOUT_MS=1` (or `=300000`) in the shell — every test that doesn't set its own override (harvest, garbage, ENOENT, persistence, session continuity) silently runs with a 1 ms / 5 min solicitation timeout. A 1 ms value flakes spawn-startup-bound tests; a huge value turns the hang-mode timeout test (`resident.test.ts:351-363`) into a multi-minute hang instead of 500 ms — and the `afterEach` `delete` only removes values the test itself set, not inherited ones.

### MEDIUM — Concurrent `caller.call()` clobbers the single `current` slot; no test exercises or forbids it
- Real code: `src/fleet/resident.ts:212` (`let current`), `:257` (`current = proc`), `:319-330` (`stop()` reads `current` once).
- Two overlapping calls (nothing in `ResidentCaller`'s contract or in `steering.ts`'s loop prevents the engine from awaiting two solicits concurrently in a future DF3.4+ wiring) → the second call overwrites `current`; `stop()` SIGKILLs only the newest process and the elder runs to its native timeout; both calls also race `lastExit` and append to the SAME `--session` file concurrently (real pi would interleave JSONL writes).
- Tests: the suite is strictly sequential — no test asserts either "calls are serialized" or "concurrent calls are rejected". Trigger: `Promise.all([spawn.caller.call(P), spawn.caller.call(P)])` then `stop()` — one child leaks.

### LOW — The never-throws contract is not defended (or tested) against a caller that resolves a reply without `usage`
- Real code: `src/phase-engine/steering.ts:271` — `meter(reply.usage)` sits OUTSIDE the try that guards `parseReply` (`:273-279`). A JS (untyped) caller resolving `{ raw: "..." }` with no `usage` throws `TypeError` out of `solicit`, violating the documented "Never throws" contract (`steering.ts:110-112`).
- The tests clearly considered this fault family — `steering.test.ts:297-319` builds a getter that throws on `raw` access — but probed only the extractor route, leaving the meter route bare. Trigger: swap the scripted caller for one returning `{ raw }` only.

### LOW — Redundant constant pin: `toBe(2)` immediately after `toBe(MAX_MALFORMED_ATTEMPTS)`
- `tests/phase-engine/steering.test.ts:256-258` — line 257 (`expect(s.calls()).toBe(2)`) adds nothing over line 256 except baking the constant's current value into a second assertion; a deliberate, reviewed change of `MAX_MALFORMED_ATTEMPTS` to 3 breaks this test even though the contract under test ("exactly N calls, never N+1") still holds.

### LOW — Slug-shape validation edges untested: bare model without `/`, and three-part ids
- Real code: `src/fleet/resident.ts:197` rejects when `modelArg` has no `/` or has an empty segment.
- Tests (`resident.test.ts:278-291`) cover `openrouter/`, `openrouter//x`, `/` — but not a plain `"deepseek-v4-flash-0731"` (the story's display name — the exact mistake the source comment at `resident.ts:29-35` warns about), nor `"a/b/c"` (all segments non-empty → PASSES validation and becomes rate key `openrouter/a/b/c`; whether that is intended is unpinned). Trigger: someone "fixes" validation to require exactly two segments, or removes the `/` requirement — no test reacts either way.

### SPECULATIVE-LOW — fake-pi-resident's NDJSON decoys may not match real pi 0.55.0 event shapes
- `tests/fleet/fixtures/fake-pi-resident.ts:71-88` emits `message_start`/`message_update` decoys with a full `usage` block under `message.usage` and a `toolResult` with top-level `usage`. This faithfully guards `harvestPiStream`'s message_end-only rule (`team-lead-driver.ts:312`) against the shape the fixture author IMAGINED; I could not verify offline whether pi 0.55.0's `message_update` actually carries `usage` in that position. If real pi never puts usage on non-terminal events, the decoy proves less than its comment ("the decoys prove the harvest reads message_end only (INV-COST-3)") claims against the real stream. Similarly `garbage` mode (non-NDJSON stdout, exit 0) is not a real pi failure mode — a real malformed directive arrives as valid NDJSON whose message_end text is non-JSON, and that path IS covered separately via `QDS_FAKE_PI_TEXT`, so `garbage` only exercises `harvestPiStream`'s skip-non-JSON-lines guard.

## Checked and NOT findings (grounded)
- `sanitizeForMessage("spawn ENOENT\n")` → `"spawn ENOENT\\n"` (`types.ts:77-84`, JSON.stringify-based) — the `lastDegradationReason` assertion at `steering.test.ts:351` is correct, not a pinned bug.
- `Math.round(111.5) === 112` — the half-up metering assertion is correct JS semantics.
- stop()-race: `call()` runs synchronously through `Bun.spawn` + `current = proc` before its first await, so `call(); await stop()` ordering in `resident.test.ts:411-414` is deterministic, not racy.
- `resolveRate` on the injected `usd-per-mtok` 0.08/0.18 → `Math.round(0.08e6)=80_000` / `180_000` — the `toEqual` rate assertions are exact and stable (rounding inside `toMicrosPerMTok` absorbs float dust).
- EPIPE: not applicable — prompts ride argv (`-p`), stdin is `"ignore"` (`resident.ts:242`); the 16 000-char ceiling keeps argv under ARG_MAX.
- The `tests/phase-engine/fixtures/fake-resident.ts` spawned by the steering smoke test exists on disk and honors `FAKE_RESIDENT_REPLIES`/`FAKE_RESIDENT_USAGE` as the test drives it.
