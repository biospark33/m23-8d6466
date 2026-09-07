# Round 10 Triage Ledger — PR 116 (df1-6)

Wave: 10 agents (blind ×3, edge ×6, auditor ×1). Auditor: ALL 7 ACs PASS, INV-1..5 PASS, 0 findings.
edge-core: 0 findings. edge-cli: 0 findings (verified clean).
Raw findings ≈ 38 → 19 patch (8 source + 11 test), 22 dismissed (verified against source), 0 decision-needed, 0 defer.

## Source patches (wave 1)

| ID | Sev | Finding | Location | Fix |
|----|-----|---------|----------|-----|
| S1 | HIGH | `runResult.exitStatus` used without union validation — garbage status ("pwned") propagates into `finalExitStatus`, envelope, partialOutput.message (BC2+BC5) | dispatch-task.ts:402-417 | Guard with EXIT_STATUS_SET/isExitStatus; unknown → warn + fail-safe `lead_failure` |
| S2 | MEDIUM | `QDS_RUN_ROOT=""` flows into loadRoster + ~180 s dual-gate BEFORE line-234 refusal — expensive work before cheap refusal (BC3) | dispatch-task.ts:164 | Hoist empty-runRoot refusal before roster load (same D14 message) |
| S3 | LOW | `readCapped` null stream → confusing `TypeError: .getReader of null` (BA4) | test-results.ts:67 | Add `stream === null` to early-return guard |
| S4 | LOW | parseInt test counts not safe-integer-guarded — >MAX_SAFE_INTEGER silently imprecise (EA3) | test-results.ts:~390 | `Number.isSafeInteger` → else treat clause as parse failure (fail-closed null) |
| S5 | LOW | Empty/whitespace prompt passes explicit undefined/null check → misleading ZodError downstream (EA2) | roster-adapter.ts:101-106 | Extend check to `prompt.trim().length === 0` with clear message |
| S6 | LOW | `onUnwatchable` callback not wrapped in try/catch — throwing callback = unhandled rejection + silent poll death (log/onEscalate ARE wrapped) (BCli5) | watchdog.ts:266 | Wrap mirroring onEscalate pattern |
| S7 | LOW | phase.ts metrics extraction relies on cast; wants explicit object narrowing (BC4) | phase.ts:~138 | Add `typeof outcome.value === "object" && outcome.value !== null` to narrowing |
| S8 | LOW | Artifact-name control-char regex excludes \x0a/\x0d then separate newline check — redundancy unexplained (BC7) | dispatch-task.ts:~767 | Comment why newline check is separate (clearer error message) |

## Test patches (wave 2)

| ID | Sev | Finding | Location | Fix |
|----|-----|---------|----------|-----|
| T1 | HIGH | Empty-`QDS_RUN_ROOT=""` refusal branch has zero test coverage (ET1a; pairs with S2) | dispatch-task.test.ts | New test: env `QDS_RUN_ROOT=""` → logic refusal, zero spawns |
| T2 | HIGH | Manifest mkdir failure path untested (ET1b) | dispatch-task.test.ts | New test: block `.qds-manifests` with a file → logic refusal |
| T3 | MEDIUM | Invalid durationMs guard (clamp 0 + warn) untested — only valid values exercised (ET1d) | dispatch-task.test.ts | New test: Infinity/NaN/negative → durationMs 0 |
| T4 | MEDIUM | Artifacts symlink test lacks win32 skipIf (changedFiles test at 731 has it, artifacts at 743 doesn't) (ET1c) | dispatch-task.test.ts:743 | Add skipIf guard |
| T5 | LOW | Typo `sk-test-key-longough` (ET1e) | dispatch-task.test.ts:640 | Fix to `sk-test-key-long-enough` |
| T6 | LOW | Artifact assertions index-based (`[0]`,`[1]`) — order is implementation detail (ET1f) | dispatch-task.test.ts:818-821 | find-by-name instead of index |
| T7 | MEDIUM | Defaults asserted with toBeDefined instead of exact values (ET2a) | roster-adapter.test.ts:329-332 | Assert 0.5 / 5 / 300_000 / 240_000 |
| T8 | LOW | Sampler failure-counter reset (2 fails → success → 2 fails, never unwatchable) untested (TC4) | watchdog.test.ts | New test |
| T9 | LOW | Abort graceful-exit0 test doesn't assert watchdog killOrigin stayed null (TC9) | runner-integration.test.ts:592-608 | Add assertion |
| T10 | MEDIUM | Budget kill near-threshold boundary untested (exact vs +ε) (TC10) | runner-integration.test.ts | New boundary tests |
| T11 | LOW | Per-line cap exact boundary untested (line exactly 2048 kept; 2049 dropped) (TC14) | runner-integration.test.ts | New boundary tests |

## Dismissed (verified against source)

- EA1/BA7 jest clause order under-reports failed — FALSE: `else if` chains off `clause[2]==="passed"`, both orders assign both counts (test-results.ts:390-401 verified).
- BA1 roster duplicate role names slip through — FALSE: dispatch passes `workerRoleNames = roles.slice(1).map(r=>r.name)`; roster-level dup names → dup workerRoleNames → RA3 guard throws.
- BA2 invalid worker status → transient — documented round-5 fail-safe design, tests pin it.
- BA3 readCapped post-race text mutation — WHATWG streams: `cancel()` resolves pending reads `{done:true}`; loop exits cleanly; `text` is string snapshot at return. Partial-multibyte on timeout path = documented "accept partial data".
- BA5 abort-then-exit arms uncleared timer — FALSE: `readerSettled` guard in `exited.then` returns before arming.
- BA6 parseInt NaN — `\d+` capture cannot produce NaN (round-8 pushback precedent).
- BA8/BA9/BA10 — reviewer's own analysis concludes behavior correct/fail-closed; misuse-is-caller-bug.
- BC1 onRunFacts/onTeamEvent concurrency race — JS single-threaded, callbacks sequential by contract; speculative future runner.
- BC6 single `%2e` — decodes to `.` (single-dot segment), cannot traverse; post-decode `..` check guards.
- BCli1 abort TOCTOU "fragile" — re-check after addEventListener makes it functional (rounds 5/9); style opinion.
- BCli2/BCli4 SIGKILL fires post-stop — W1 intentional: "SIGKILL leg survives stop()" (round-7 fix, in-code comment).
- BCli3 killOrigin cleared on ESRCH — documented intentional: watchdog "did not actually kill it".
- TC1 constants tautology — intentional pin pattern (round-5 precedent).
- TC2 SIGTERM test could kill own group — escalation tests use real detached children (`child.pid!`); `process.pid` tests never escalate (injected samplers, no signal sent).
- TC3 stop-during-grace split — covered: R9 test + perl SIGTERM-ignore escalation tests (no stop() called) + round-8 stop-during-grace SIGKILL survival.
- TC5 threshold+1 escalation missing — covered: line 226/237 always-over sampler (`DEFAULT_THRESHOLD_BYTES + 1`) + round-8 exact-threshold no-escalation.
- TC6 abort during grace untested — watchdog takes no signal; covered by composition (stop-during-grace + classify precedence tests).
- TC8 escalation test uses process.pid — FALSE: line 226 uses real detached child.
- TC11 merger redactDeep only identity-tested — FALSE: real-redact INV-3 test exists (merger.test.ts:243).
- TC13 win32 sampler fallback — platform out of scope (round-6 precedent: targets macOS + Linux CI).
- TC7 python fallback for perl skips — CI platforms ship perl; skip guards correct as-is; defer to platform story.
- ET2b adapter-guard test title clarity — comment-opinion only; direct adapter test exists.

## Decision-needed

None. No ambiguous fixes; conservative fail-safe option selected for S1 (unknown → lead_failure).

## Baseline (pre-fix)

Engine root: 1940 pass / 3 fail (bench + 2 live-gate — all environmental, need API keys/network) / 6 skip. CLI: 281 pass / 0 fail / 4 skip (perl guards).
