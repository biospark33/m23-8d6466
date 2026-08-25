# W1g fix report — FM1: stampManifestLimit raise guard

## Disposition
FIXED (fail-closed monotonic raise guard) in `src/phase-engine/manifest.ts`; owned-file test coverage added in `tests/phase-engine/manifest.test.ts`. No commits/pushes.

## Behavior change
`stampManifestLimit(loaded, limitMicroUsd)` now refuses to RAISE an existing ceiling:

- Loaded manifest carries NO `limitMicroUsd` → first stamp lands any positive safe integer (unchanged).
- Requested value EQUAL to existing → allowed.
- Requested value LOWER than existing → allowed (downward-only clamp doctrine preserved; downstream consumers only ever tighten).
- Requested value HIGHER than existing → throws `ManifestError`: `refusing to raise limitMicroUsd from <existing> to <requested> above the admitted ceiling` — both values named.

The last-wins spread `{ ...manifest.manifest, limitMicroUsd }` is unchanged; the guard sits between it and the existing positive-safe-integer validation, which itself is byte-for-byte untouched (and still runs first). safeParse validation untouched.

Justification comment added inline per house style: a present ceiling is what admission GRANTED, so no second stamp may overwrite it upward past the ledger.

## GitNexus impact (run before edit)
`impact({target:"stampManifestLimit", direction:"upstream"})` → **HIGH risk**, epistemic exact, 5 impacted:
- d1 direct caller: `dispatch` (`src/fleet/dispatch.ts`) — processes Dispatch→AsText/SafeOrigin/AppendDispatchFailure/RedactKeyManagementUrls
- d2: `run` (`scripts/fleet.ts`), `runArms` (`src/fleet/fanout-primitive.ts`)
- d3: `fanout` (`src/fleet/fanout-primitive.ts`), `scripts/fleet.ts`

HIGH-risk warning surfaced to lead as required. Production blast radius verified EMPTY for this change:
- The only production caller is `src/fleet/dispatch.ts:2126`, a single stamp on `loaded` that was already passed through `stripAuthoredLimit` at `dispatch.ts:1343`, so the field is absent at stamp time — first-stamp path, unaffected by the guard.
- `scripts/fleet.ts` and `fanout-primitive.ts` reach it only through `dispatch`; neither calls `stampManifestLimit` directly (grep clean).

No changes needed to dispatch.ts. If wave 2 wants defense-in-depth anyway: none required for correctness.

## Test coverage added (tests/phase-engine/manifest.test.ts)
New `describe("stampManifestLimit — monotonic ceiling guard")` with 5 cases:
1. first stamp onto absent limit lands admitted value
2. re-stamp HIGHER refused, message names both values, input ceiling intact after refusal
3. re-stamp EQUAL passes
4. re-stamp LOWER passes (downward-only)
5. positive-safe-integer validation still precedes the guard (1.5 rejected)

Note: the task brief said the KNOWN-DEFECT tripwire lives in `tests/phase-engine/manifest.test.ts`; it does not (that file had zero stamp coverage before this fix). It lives in `tests/fleet/brief-schema.test.ts`.

## Wave-2 flips needed — exact titles (NOT my files; verified by running the suites)

### tests/fleet/brief-schema.test.ts — NOW RED (1 failure, confirmed):
- `"re-stamping is LAST-WINS and unguarded — a second stamp can RAISE the ceiling"` (line 1214) — flip to assert `stampManifestLimit(once, higher)` throws `/refusing to raise limitMicroUsd from/` naming both values; delete the KNOWN DEFECT comment block (lines 1215–1230), which says verbatim "the day a monotonic guard lands, this line goes red BY DESIGN".

Still green, no action:
- `"AC9a: the stamp WINS over an authored ceiling even with the strip skipped"` (line 1181) — stamps 250_000 over authored 9_000_000, i.e. LOWER; passes under the guard as written.
- `"serializeManifest does NOT require a stamp…"` (line 1191) — single stamp semantics unchanged; fine.

### tests/fleet/dispatch.test.ts — correction to the brief:
Grep + run show NO LAST-WINS raise tripwire here. Its stamp cases are all single-stamp end-to-end AC9a assertions ("AC9a: manifest stamped with limitMicroUsd = admittedCeilingMicroUsd" etc.) and all remain green under the guard because dispatch stamps exactly once post-strip. Nothing in dispatch.test.ts needs flipping.

## Commands + results
| Gate | Result |
|---|---|
| `bunx biome check src/phase-engine/manifest.ts tests/phase-engine/manifest.test.ts` | clean, 2 files |
| `bunx tsc --noEmit` | clean |
| `bun test tests/phase-engine/` | 601 pass, 0 fail |
| `bun test tests/fleet/brief-schema.test.ts` (blast-radius check) | 93 pass, 1 fail — only the line-1214 tripwire listed above |

Files touched (owned only): `src/phase-engine/manifest.ts`, `tests/phase-engine/manifest.test.ts`.
