# fix-tests-legs — review round 1, wave C (legs test file)

Owner: fixer-tests-legs. Scope: ONLY `tests/p0-9/legs.test.ts` (untracked story file; not committed, per instruction).

## Changes

### F-017 — no test writes into the real closure dir
Rewrote `writeLegEvidence: live default = closure dir` into a pure routing test:
- `resolveEvidenceDir({mode:"live"})` === `LIVE_EVIDENCE_DIR` (imported from leg-lib) — no write.
- `resolveEvidenceDir({mode:"live", outDir: tmpdir})` === resolved explicit dir — explicit outDir wins over the live default, still no write.
- The single remaining write-path check is the MOCK reroute: one file into the shared `/tmp/p0-9-dev-rehearsal` dir, removed after (unchanged house pattern).
- The mock-refuses-closure-dir test keeps the THROWS case (throws before any write) and now also asserts the F-009 subdirectory spelling (`<closure>/sub`) throws via pure `resolveEvidenceDir`.
Net: zero `writeLegEvidence({mode:"live"})` calls remain in the file (grep-verified); routing + refusal coverage unchanged or stronger.

### F-026 — AC3 rollback-path fixture in `idempotency-rerun`
New test mirroring provision-and-import's rollback fixture (house pattern: stateful `makeProvisionClient`, tmp lock, `assertEvidenceContract` first):
- (a) `createFailsOn: [COLLECTIVE_BANK_ID]` — the third create fails after b1 (`qds-factory`) + b2 (`qds-factory-dev-meta`) landed. Asserts: leg ok:false exitCode 1; `provision-1` step recorded failed; `createdInAttempt` was exactly `[qds-factory, qds-factory-dev-meta]` at failure time (the post∖pre diff is the compensation source, never the provisioner's failed envelope); BOTH banks' compensating deletes issued; `deleteOutcomes` records each `"deleted"` (b1 included); `residue` `[]` (deletes succeeded — residue names only banks whose DELETE failed).
- (b) same create failure + `deleteFailsOn: ["qds-factory"]` — asserts `residue` `["qds-factory"]` exactly, `deleteOutcomes["qds-factory"] === "failed"`, and b2's delete still `"deleted"` (no short-circuit past a failed delete).
Fixture note: used the plain-client fresh path (provisionBanks order `[repo, -dev-meta, collective]` confirmed in bank-provisioner.ts:451; a 500 create returns `{ok:false}` leaving the partial roster in the diff) rather than a hand-rolled provisionImpl — same observable contract, and it exercises the driver's real provision path like the neighboring happy-path test.

### F-008 — hermetic-run signal in `auth-retired-check`
- Extended the main probe test: `measuredCount` is a number ≥ 1 when probes ran.
- New test: mock mode, NO fetchImpl/client injected → `outcome` matches `all-probes-skipped-hermetic`, `measuredCount === 0`, ok:true exitCode 0 (mock rehearsal records, does not gate), `dangerRetired === false`, all three `authOutcomes.*.measured === false` (skips honest, never faked), `containmentStatement` still present.

Also: header contract list updated (`deleteOutcomes` for provision+idempotency rollback, `measuredCount` for auth).

## Verification

- `bun test tests/p0-9/legs.test.ts`: **31 pass, 0 fail, 0 skips** (was 29; +2 new tests). Log: `/tmp/legs-r1.log`.
- `bunx tsc --noEmit`: exit 0.
- `bunx @biomejs/biome check tests/p0-9/legs.test.ts`: clean.
- No wave-B expectation fixes needed — existing 29 green on first run after edits, matching the driver fixer's report.
- No other files touched; nothing committed.
