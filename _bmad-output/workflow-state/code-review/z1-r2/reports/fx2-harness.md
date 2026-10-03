# fx2-harness — round z1-r2 fix report

File touched: `tests/fleet/e2e/sc2-harness.ts` (only file).

## R2-04 (MED) — deep-scan caller-stamp guard
Added local helper `hasSwarmclawForkRevDeep` (depth-capped at 10 to guard cyclic payloads) just above `writeEvidence`, and a guard after the existing top-level check. The guard throws the same class of error as the top-level guard, naming the nested stamp and the false-drift risk: "payload carries a nested swarmclawForkRev — the writer owns the stamp at any depth; a caller-supplied stamp would launder a recorded rev and false-fire the drift finder". Matches the alarm's recursive read depth.

## R2-10 (MED) — honest stamp-freshness comment
One line added directly above the stamping line: the stamp records the pin at write time only; if the fork advanced without a bump PR, the manifest row's rev (which must equal the pin post-pin) forces the bump — stamp freshness is enforced by the alarm's row check, not here.

## R2-14 (LOW) — null named in guard message
Guard message ternary now checks `payload === null` first, so a null payload renders "got null" instead of "got object".

## Untouched / intact
- Signatures, filenames, stamp semantics, existing top-level guard, and `wx` collision behavior unchanged. Top-level guard retained (it reports the exact stamped value); the deep guard supplements it.
- Existing cyclic-payload unit path (live-harness.test.ts:216) unaffected: the depth-capped scan passes cyclic objects through and they still fail at stringify as before.

## Verification
`bun test tests/fleet/e2e/` → 63 pass, 53 todo, 0 fail (exit 0).
Manual sanity: nested-stamp payload and null payload both throw with the new messages; throws precede any disk write, so no evidence pollution.
