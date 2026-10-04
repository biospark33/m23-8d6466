# fix2-tests-legs — review round 2, wave C (legs test file)

Owner: fix-tests-legs. Scope: ONLY `tests/p0-9/legs.test.ts`. Not committed.

## Changes

### R2-022 — mint-record test is checkout-independent
The mint-record test asserted `documentIds.length > 0` against the repo's REAL
`.mulch/expertise` contents — pass/fail depended on the checkout. Now:
- Builds a deterministic tmp corpus (3 valid MulchExpertiseSchema entries —
  distinct domains, one with an empty concepts array) and injects it via
  `deps.expertiseDir` (the driver's existing seam).
- Pins the EXACT derived ids: `expect(ids).toEqual(CORPUS.map(e =>
  \`mulch-${dedupHash(e.domain, e.concepts).slice(0,16)}\`))` — the importer's
  own derivation over the fixture inputs, in corpus order (`dedupHash` imported
  from src/hindsight/mulch-importer.ts, same module the driver uses).
- Determinism (run2 equal), shape regexes (`^mulch-[0-9a-f]{16}$`,
  not-runId-shaped), resolved-repo-bank entry, and retain-body carriage checks
  all kept; the now-redundant `length > 0` assert dropped (toEqual subsumes it).

### R2-015 — origin pin flipped on landing (pre-approved one-liner)
fix2-drivers-cli's sanitizeOrigin migration landed mid-pass; the hindsight-live
trap test pin changed from `expect(ev.origin).toBe(origin)` to
`expect(ev.origin).toBe(sanitizeOrigin(origin))` with a comment naming the
trailing-slash reconstruction. Confirmed live failure before the flip
(`Expected "http://127.0.0.1:8888" / Received "http://127.0.0.1:8888/"`),
green after.

### No-change confirmations (from the earlier recon)
- negative-probes `downOrigin` trailing slash: zero pins in legs.test.ts — nothing to touch.
- R2-013 (down-URL any-HTTP fails the leg): existing ANSWERS-probe test green against it.
- R2-009 refused-unclassified branch: no text pins affected.
- R2-018 resolveRepoSlug migration (landed mid-pass): both idempotency tests and
  the provision fixtures stayed green on the existing `qds-factory` literal
  expectations — no expectation changes needed.

## Verification

- `bun test tests/p0-9/legs.test.ts`: **40 pass / 0 fail / 0 skips** (stable
  across three consecutive runs after the tree settled). Logs: /tmp/legs-r22*.log, /tmp/legs-final.log.
- `bunx @biomejs/biome check tests/p0-9/legs.test.ts`: clean.
- `bunx tsc --noEmit`: **0 errors repo-wide** (re-verified after fix2-drivers-cli
  settled their migration — an earlier poll caught one transient TS6133 unused
  `step` at idempotency-rerun.ts:182 in their in-flight file, fixed minutes
  later as `(_step, ...)`; zero tsc errors in legs.test.ts throughout).

## Transients observed (for the record)
fix2-drivers-cli's driver migration landed piecemeal during this pass; two
intermediate states briefly reddened the suite from THEIR files
(`basename is not defined` in provision-and-import.ts then idempotency-rerun.ts
— import stripped before call sites migrated). Both settled on their own; no
test expectations were changed to accommodate transients.
