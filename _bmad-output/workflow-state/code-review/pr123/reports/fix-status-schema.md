# Fix report — W1b: status.ts + brief-schema.ts (PR 123, round 10)

Branch `feature/df3-2-fanout-best-of-n`. Files touched: `src/fleet/status.ts`, `src/fleet/brief-schema.ts` only.
`tests/fleet/cli.test.ts` NOT edited (owned by another agent). No commits/pushes.

## Impact analysis (run before edits, per CLAUDE.md)

- `sanitizeLabel`: **HIGH** — 13 impacted (fanout, statusAll, dispatch, scripts/fleet run). Conservative: signature unchanged; only the over-length branch differs (output strictly shorter than before). No caller can depend on the removed extra unit; verified below.
- `statusAll`, `statusRun`, `listWithTimeout`, `safeUrl`: LOW.

## Per-finding disposition

### FF1 HIGH — Promise.race loser unhandled rejection — FIXED
`listWithTimeout` now pins the loser: `void listing.catch(() => {})` attached to the `driver.list()` promise before the race. Covers BOTH call sites named in the finding (the direct attempt and the ~269 retry) because both route through `listWithTimeout`. The timer half needs no pin — `Promise.race` subscribes to every entrant, so its rejection is always observed.

### FF3 MED — raw box.name in record-read-failed remediation — FIXED
``The box ${safeName(box.name)} is STILL LIVE…`` in `statusRun`. Same producer-side rule as `orphanRow`.

### FF4 MED — localeCompare tie-break — FIXED
Code-unit `<`/`>` comparison (`aId < bId ? -1 : aId > bId ? 1 : 0`) in `byCreatedAtDesc`, per the comparator's own anti-ICU comment.

### FF5 MED — safeUrl scheme arm — FIXED (https strictly)
`parsed.protocol !== "https:" ⇒ undefined`, before the userinfo check. `URL.protocol` is normalized lowercase so `HTTPS://` passes, matching the brief schema's case-insensitive intent.
Fixture check done: the only `http://` occurrences in tests/fleet are brief-schema REFUSAL cases (`brief-schema.test.ts:422,637`); every status-row fixture URL is `https://…fake.local`. No test depends on http passthrough.
**BEHAVIOR CHANGE (intentional, safe direction):** an `http://` or `javascript:`/`file:` provider httpsUrl is now OMITTED from rows instead of rendered as a clickable link.

### FF6 MED — requestId / closedAt unsanitized — FIXED
- `requestId`: `sanitizeOptional(rec.requestId, MAX_REQUEST_ID)`. `MAX_REQUEST_ID = 128` is now exported from `brief-schema.ts` (same pattern as `MAX_URL`, which exists for exactly this reason — imported, not restated).
- `closedAt`: `sanitizeLabel(rec.closedAt, MAX_TIMESTAMP)` at the closed-row construction.
- `sanitizeOptionalName` replaced by the generic `sanitizeOptional(text, max)` (it had exactly one call site).
Plain-ASCII values pass through byte-identical, so `verbs.test.ts`'s `toBe("req-costs")` and parseable-closedAt assertions are unaffected (suite green).

### FF8 LOW — sanitizeLabel off-by-one — FIXED
`capped.slice(0, max - 1) + "…"`, plus a `max < 1 ⇒ ""` guard (without it, `slice(0, -1)` would mean "everything but the last unit" at that bound). Verified: 65-char input at max 64 → exactly 64 units ending "…"; 200-char at 128 → 128 units. New invariant: result ≤ `max` UTF-16 units (was ≤ `max + 1`). No dedicated sanitizeLabel cap-behavior test existed to update.

### FF9 LOW — element-shape guard admits arrays — FIXED
`Array.isArray(rec)` added to the `listing.records.some(…)` guard.
**BEHAVIOR CHANGE (intentional):** a store answering with array elements now exits 1 `record-store-unreadable` instead of rendering garbage rows with undefined ids — consistent with the existing refusal-not-drop doctrine documented at that guard.

### FF10 LOW — truncation artifact feeding the comparator — FIXED
Parse-before-truncate via a module-level `sortInstants = new WeakMap<StatusRow, number>()`: `pinSortInstant(row, rec.createdAt)` stores `Date.parse` of the RAW record value in `statusAll`; `byCreatedAtDesc` prefers the pinned instant and falls back to parsing the (bounded) display string for unpinned rows (orphans/fleet rows — absent there anyway). Rows stay plain JSON-serializable objects; CLI output byte-identical. Display string remains capped at MAX_TIMESTAMP.

### FF12 LOW — exception text verbatim in typed messages — FIXED
New `safeDiagnostic(e)` = `sanitizeLabel((e as Error|null)?.message ?? String(e), MAX_DIAGNOSTIC=512)` applied at both sites (`record-store-unreadable`, `record-read-failed` message). Safe direction: strips control chars, caps length; keeps filename + reason together at 512.

### FF16 LOW — skippedRecords doc vs construction — DOCSTRING CORRECTED (chose doc fix)
Behavior left as-is: surfacing a caveat ROW where `statusRun` currently throws exit-4 `run-not-found` would change CLI exit contracts — not cheap. The `StatusRow.skippedRecords` docstring now names the exact carrier ("the one `statusRun` row whose verdict those files could contradict — the `orphan` row returned when this run's record is missing while a live box answers to its id") and states that every other statusRun exit carries the same caveat in the remediation instead.

### Deferred / dismissed (untouched, per instructions)
FF2 (repoUrl host vs slug → DF5.2 allowlist), FF13, FF14: DEFERRED. FF7, FF15: DISMISSED by triage; not modified.

## cli.test.ts breakage

NONE. Full-suite result includes `tests/fleet/cli.test.ts` passing with these changes.

## Commands + results

| Command | Result |
|---|---|
| `bunx biome check src/fleet` | Checked 9 files, no diagnostics — PASS |
| `bunx tsc --noEmit` | exit 0 |
| `bun test tests/fleet/` | 512 pass / 9 todo / 1 fail (55s) |
| `bun -e` spot-checks | FF8 cap lengths exact (64/128); short input untouched |

(The gate string `tests/fleet/status*` matches no file — there is no dedicated status unit-test file; status coverage lives in `verbs.test.ts` + `cli.test.ts`, both green.)

## Observed failure OUTSIDE my scope

`tests/fleet/brief-schema.test.ts > manifest stamp helpers (DF3.1 AC9a) > re-stamping is LAST-WINS and unguarded — a second stamp can RAISE the ceiling` fails (reproduces solo). It exercises `stampManifestLimit` in `src/phase-engine/manifest.ts:772`, which is MODIFIED IN THE WORKTREE by another agent in this wave (`git status` shows `src/phase-engine/manifest.ts` + `tests/phase-engine/manifest.test.ts` modified — not my diff). Not mine to touch; flagging for the lead.
