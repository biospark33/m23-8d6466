# Blind Hunter — pr135 chunk-engine-src.diff (steering.ts + journal/manifest/index)

Scope: `src/phase-engine/steering.ts` (new, 319 lines), additive hunks in `journal.ts`, `manifest.ts`, `index.ts`. No repo context consulted; all findings are diff-internal.

## Findings

### HIGH

1. **Per-term `Math.round` rounds typical per-call spend to zero — systematic undercount of `spendMicros`**
   `steering.ts` hunk, `meter` (diff lines ~344–349). `Math.round((clamp(usage.inputTokens) * rate.inputPerMTok) / 1_000_000)` rounds each call's spend to an integer per term. Trigger: a solicitation with 10,000 input tokens at $3/Mtok → `10000*3/1e6 = 0.03` → rounds to **0**. Every call in a run below ~0.5 units/term meters as zero, so `telemetry.spendMicros` stays 0 for the whole run while real spend accrues. Additionally the unit math is only self-consistent if `rate.*PerMTok` is denominated in µ$/MTok (comment says "usage × rate ÷ 1e6" yields µ$); if the rate is passed in the conventional $/MTok (e.g. `3`), the formula produces **dollars**, not µ$ — a 1e6 unit error that the integer rounding then masks by flooring to zero. Either the rate contract or the divisor is wrong, and the per-call (rather than cumulative) rounding guarantees loss even when units are right.

### MEDIUM

2. **`deps.rate` is never clamped — a NaN/Infinity rate breaks the integer invariant the comment claims to protect**
   `steering.ts`, `meter` (diff lines ~344–349). The comment states a poisoned *usage* "would otherwise turn spendMicros non-integer (JSON null) for the run" and clamps usage — but `Math.round(clamp(usage) * deps.rate.inputPerMTok / 1e6)` with `rate = NaN` or `Infinity` yields `NaN`, which poisons `spendMicros` for the run exactly as described. Rate is harness-supplied so it's trusted, but the defensive clamp is half-applied: same one-line guard should cover the product or the rate.

3. **`select_roster.phase` is never validated — fail-closed applies to `rosterId` only**
   `steering.ts` (diff lines ~417–422). The roster pick is checked against the closed `rosterIds` set ("An absent rosterIds is an EMPTY set… fail-closed"), but the directive's `phase` field — which names *which* phase the roster applies to — passes with any non-empty string. Trigger: resident replies `{"action":"select_roster","phase":"nonexistent_phase","rosterId":"<valid id>"}`; schema accepts, roster check accepts, `telemetry.directives` increments, and the runner receives a directive targeting a phase that doesn't exist. The engine "holds no engine state" so it cannot check phase membership itself, but the diff exports no closed phase set in `SolicitCtx` (only `rosterIds`) — the fail-closed invariant (INV-RES-2) has a hole exactly where the module's own comments claim it holds.

4. **`writeResident` "written once at run end" is unenforced — silent overwrite**
   `journal.ts` (diff lines ~67–71). `writeResident` unconditionally replaces `this.resident` and flushes. A second call (double run-end hook, retry of the finish path) silently discards the first telemetry block — including accumulated `spendMicros` and `tripwires` — with no error or merge. If once-only is the contract, the method should throw or no-op on a second write.

### LOW

5. **Journal doc claims `resident` is "present on every settled run" but the mechanism is optional**
   `journal.ts` (diff lines ~44–51). `JournalFile.resident?` is optional and only populated if someone calls `writeResident`; nothing in the diff guarantees the `status: "disabled"` block is written when no resident was armed. `finish()` builds the journal with `...(this.resident !== undefined ? ...)` — a settled run with no `writeResident` call has no `resident` key, contradicting the interface doc. Consumers keying on `resident.status` must handle absence anyway, making the documented invariant false.

6. **Concurrent `solicit` calls race on telemetry and status**
   `steering.ts`, `solicit` (diff lines ~372–429). No serialization: two overlapping solicitations both pass the `status !== "active"` gate, interleave `meter`/`telemetry.directives` mutations, and each can run its own 2-attempt caller loop (4 concurrent resident calls total, against the spirit of "never a third call"). One call setting `status = "degraded"` does not abort the other's in-flight loop. Assumption: the runner solicits sequentially; if so, document the requirement, because nothing in the exported contract enforces it.

7. **Malformed-correction prompt drops the steering point and all context**
   `steering.ts`, `malformedCorrectionPrompt` (diff lines ~290–297). The correction contains only harness text + the union instruction — the `SteeringPoint` and `promptContext` from the original render are gone. A stateless `ResidentCaller` answering the correction sees no indication of *what* it is steering (run_start vs run_end), biasing it toward a blind `proceed`/generic reply, and the module comments explicitly contemplate stateless callers. Behavior concern, not a safety hole (fail-closed still applies on a second malformed reply).

8. **`ResidentStatus` union exported with states this module can never produce**
   `steering.ts` (diff line ~192) + `createSteering` initial telemetry (line ~331). `"disabled"` and `"stopped"` are exported members, but `createSteering` always starts `"active"` and only ever sets `"degraded"`. Per the journal comment, `status: "disabled"` is expected "when no resident was armed" — so the caller must fabricate a `ResidentTelemetry` by hand to satisfy the journal contract, duplicating the shape outside the module that owns it. Contract gap visible across the two hunks.

9. **`lastDegradationReason` stores raw `err.message`; sanitization is read-side only**
   `steering.ts` (diff lines ~386–388, 434–436). `err.message` from the fleet caller is stored unsanitized and only `sanitizeForMessage`d in the getter. Any future consumer reaching for the internal binding (or a refactor that exposes it) leaks unsanitized text; the malformed path (`malformed reply: ${parsed.reason}`) is safe only because `parsed.reason` happens to be harness-authored today. Sanitize at write, consistent with the rest of the module's INV-2 discipline.

10. **`flush()` inside `writeResident` is fire-and-forget relative to `finish()`**
    `journal.ts` (diff lines ~67–71). `writeResident` flushes immediately, then `finish()` rebuilds and presumably rewrites the file including `resident`. If `flush` is async or partially failing, the intermediate flush is a wasted full-file write and a crash between the two leaves a journaled `resident` block on a run with no terminal marker. Assumption: `flush()` is the same synchronous full-rewrite used by every other op — if so, the extra flush is harmless but redundant.

## Checked and clear

- `truncateTailWithSuffix` surrogate loop correctly skips *leading low surrogates* of the kept tail (advancing `cutPoint`), budget math (`suffix.length + proseBudget === maxLength`) is exact, and `maxLength < 3` edge is handled without splitting a surrogate (… is BMP).
- `renderPrompt` reserves header + instruction + joiner before cutting; ceiling holds for the whole prompt, suffix included, in both truncated and untruncated paths.
- Malformed-attempt counter: attempt 1 malformed → one correction call; attempt 2 malformed → degrade. Matches "two malformed → degrade, never a third call (AC3)".
- `reject()` wraps `onTripwire` in try/catch and returns `PROCEED` — a throwing observer cannot convert a rejection into a thrown error; consistent with the never-throws contract.
- `parseReply`'s throwing-extractor path counts toward the malformed limit (not a separate class) — matches AC3.
- `manifest.ts` superRefine symmetric with the `command` check; `testCommand` refused on non-`code` kinds with a clear message. No logic error.
- `rejectionDetail` handles non-object `parsed` (null/primitive/array) safely via optional chaining.
