# W2b — harden cli/fleet tests (review round 10, PR 123 / df3-1)

Files owned and touched: `tests/fleet/brief-schema.test.ts`, `tests/fleet/cli.test.ts`, `tests/fleet/verbs.test.ts` (`tests/fleet/helpers.ts` untouched — see skips). No source files edited. No commits/pushes.

## Task 1 — red-by-design tripwire flipped

- `brief-schema.test.ts`: "re-stamping is LAST-WINS and unguarded…" rewritten to assert `stampManifestLimit(once, 9_000_000)` **throws** `/refusing to raise limitMicroUsd from 500000 to 9000000/`, plus the refused-attempt-leaves-ceiling-intact check. Obsolete KNOWN DEFECT comment block deleted. Equal/lower arms NOT duplicated here — already exhaustive in `tests/phase-engine/manifest.test.ts:658-694` (monotonic describe); this file carries only the fleet-relevant raise refusal with a pointer comment.

## HIGH (blind-tests-t2)

- **Help-table ↔ REGISTRY binding** (`cli.test.ts`, exit-code-table test): new second direction — for EVERY `listVerbs()` entry, the printed table parsed back through the independent per-verb line parser must EQUAL the declared `exitCodes`. This binds declared-but-unprobed codes (dispatch 3 and 5) that observed-set pinning could never see, and it is not tautological despite the byte-equality pin above: both sides of that pin come from `renderHelp`, so only an independent parse catches a renderer that filters/hard-codes a subset.

## HIGH (edge-tests-mid T1) — open-world rewrite, `verbs.test.ts`

- `"listVerbs returns exactly 6 entries"` → `"listVerbs keeps every known verb"`: length pin dropped; contains-set of the six known verbs. A seventh additive verb no longer edits this file; a deletion still goes red.
- Exact-order pin in the same-set test → **subsequence** via a module-level `inOrder()` helper: relative order of known verbs held (which is what the shared-store probes need), insertion allowed anywhere.
- `--driver-required-every-verb` sweep → driven from each entry's own flag metadata (declares `--driver` ⇒ required:true + refusal probe); rank-style exemptions pinned as an explicit negative allowlist asserting the driver-less set is EXACTLY `["rank"]`; injected-`deps.driver`-without-flag positive pinned in the same case (`run(["status"], {store, driver})` exits 0).
- `EXPECTED_FLAGS` / `EXPECTED_EXIT_CODES` literals **kept**: they are keyed per verb and iterate a fixed verb list, so they are additive-safe; exactness per known verb is the DF3.5 contract shape and was explicitly preserved.

## MEDIUM

- **within() abandon containment**: race losers are recorded, their eventual rejection observed (`p.catch`), and a file-level `afterEach` bounded-joins them (5s window) before the next test starts, failing with `{drained:false}` naming the straggler count if one is still executing. Zero cost when nothing timed out (the normal path). In-process `run()` cannot be killed, so join-with-budget is the smallest containment that stops cross-test lock/tmpdir poisoning.
- **OK-arm harvest git isolation**: git helper now runs `-c commit.gpgsign=false -c tag.gpgsign=false` and sets `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env, so signing-configured or ident-less hosts neither fail nor passphrase-prompt (hang) on the fixture commit.
- **40–63-char secret-shaped band**: new case pinning that LEGAL ids in redaction's ≥40 band ride `run-not-found` VERBATIM on BOTH shapes (63-char hex digest-shaped; 61-char non-hex opaque), with the intent spelled out: verbatim is by design for digests (the long-token arm's readability exemption), and eaten-whole is a property of the GRAMMAR GATE for rejected arguments (pinned by the LONG_ID row), not of this typed-FleetError sink — behavior verified empirically against `scripts/fleet.ts` before pinning.
- **process.chdir(hostRepo)**: restore guarded (`if (process.cwd() !== originalCwd)`), finally-scoped as before, plus a comment naming the process-global-cwd / interleaved-suite risk. No runner change.
- **Excused-exit-code binding parser**: title search tries all three delimiters (`"` `` ` `` `'`), earliest match wins; body bounded by the next top-level `test(`/`it(` OR end-of-file when the excused case is the file's last (previously a false "no next-test boundary" missing-entry). Meta-test philosophy untouched.
- **DOCUMENTED_EXIT_CODES clamp anchoring**: `.exec` first-match → `matchAll` + `toHaveLength(1)`: a second clamp appearing anywhere in `scripts/fleet.ts` now turns red instead of silently deciding which site the table binds to.

## LOW — done

- live-holder tests: owned `sleep 30` holder kill moved into `try/finally` around the refusing invocation (both the teardown and harvest live-lock cases).
- orphan-row label inconsistency: label asserted off the row's OWN `vmName` (`(orphan ${orphan.vmName})`), aligning this case to the discipline stated in the ack-unwritable case ("vmName === runId is a FakeDriver naming convention").
- POSIX-precondition note added to the `cli.test.ts` file header (hard links, mode bits, SIGKILL-able children).
- empty-fleet stdout-empty: `Probe.stdoutEmpty` added; status's empty-fleet probe now asserts stdout is EXACTLY `""` (`stringContaining("")` would have been vacuous). Verified real CLI prints 0 bytes here.
- multi-segment repoSlug refused pin added to `brief-schema.test.ts` (`group/sub/repo` → `invalid_string` on repoSlug), guarding the deliberately-two-segment imported `REPO_SLUG_PATTERN`.
- injected deps.driver WITHOUT `--driver` flag coverage — folded into the driver-sweep test (see HIGH T1).

## Skipped (with reasons)

- `helpers.ts` module-scope fs I/O probe lazify (~:233-240): stale line ref — the file is 153 lines with no import-time fs I/O; nothing to lazify.
- local `isAlive` copy divergence (~:248-255): no local copy exists in my files; referenced in comments only.
- LOCK_HOST module-scope probe placement: already self-guarding (4-field layout assert, host-shape asserts, cleanup); relocation would be churn.
- `readUntilMarker` stranded queued read: already handled in place — `pending.catch(() => {})` plus `releaseLock` in `finally` (cli.test ~:283-299).
- joined-sinks final redaction: already separate — three distinct sink strings passed as varargs to `leakScan` (cli.test ~:3471-3473).
- `RUN_ID_RE` literal duplication → import: none exists; `verbs.test.ts` imports `RUN_ID_RE`/`RUN_ID_MAX` from source; cli.test regex strings are expected-value message pins, not rule copies.
- derived constants (96/12/13-40 band) derive-or-name-source comments: load-bearing ones already name their sources (`RUN_ID_ECHO_CHARS` at the band branch; `scripts/fleet.ts`'s own echo docblock); further renaming is churn — skipped.
- `goodLedger` remaining vs cap fixture: already distinguished — two-param `goodLedger(ceilingMicroUsd, capMicroUsd)` with a docblock naming the AC9b confusion; no consumer needs `remaining ≠ ceiling` — skipped (YAGNI).
- frozen-object deep-freeze nested assertion: lives in `tests/phase-engine/manifest.test.ts` (not mine); the redundant `Object.isFrozen` line was dropped from my rewritten tripwire because the guard throws before mutation.
- phases length-only → `toEqual`: brief-schema strip test already asserts `.phases).toEqual(...)`; no length-only phase assert in my files.
- try/catch sentinel → refusal/rejection helper idiom: no such sentinel present in my files.
- S28 freshness ±30min boundary: out of scope per instruction (`tests/phase-engine/pipeline-run.test.ts` is another agent's).

## Gates

- `bunx biome check` on all three touched files: clean.
- `bunx tsc --noEmit`: exit 0.
- `bun test tests/fleet/`: **528 pass, 9 todo, 0 fail**, 4650 expect() calls, 537 tests across 16 files (45.78s).
- INV-2 flake rerun solo: pass. `cli.test.ts` solo rerun: 127 pass / 0 fail.
