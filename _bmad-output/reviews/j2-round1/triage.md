# J2 review round 1 — findings triage (2026-11-04)

Diff: `git diff dev...HEAD` @ `c56bde45` (3600 lines). Layers: blind-hunter (14), edge-case-hunter (14), verification-gap (4+2-other, pre-verified), acceptance-auditor (5). Convergent findings grouped by root cause. Verdicts rendered by the driver after code verification (vergap findings pre-verified per its evidence rules).

## Survivors — to fix this round

| ID | Src | Verdict | Finding | Fix |
|---|---|---|---|---|
| F1 | accept+edge+blind | high | `entryProblem` validates only seq/prev_digest/from/to/sign_off — `at` + `evidence` unvalidated; `from===to` no-op flips and armed-genesis verify ok → malformed flip routes (AC3 "well-formed chained entry" hole) | validate `at` ISO + full `evidence` shape (6 fields, thresholds 5 numbers) + genesis `from==="recording-only"` + `from!==to`; tamper tests for each |
| F2 | vergap+blind | high | `parseDispositionProbability` never pinned against producer `rationaleFrom` (observe-round) — clause-format drift silently kills the dismiss lane with all tests green; docblock mis-cites parseIsRealDefect | cross-pin test (agrees≡outcomeAgrees idiom) + docblock fix + exponent-form fail-safe assert |
| F3 | accept | medium | DoD "not-eligible on the real corpus" untested in-suite (gates ran it; suite never does) | suite test: default dirs, exit 0 + not-eligible |
| F4 | edge+blind+vergap | medium | route-round absent corpus shard → empty manifest exit 0 (readLines returns [] on missing, merge.ts:133-134); typo'd round routes nobody silently | existsSync guard → exit 2 naming the missing shard (merge.ts untouched — corpus scripts consumed, never edited) |
| F5 | edge+blind | medium | main-body fs/parse errors escape uncaught (exit 1 + stack) in route-round (only parseArgs wrapped), confirm-outcome, arm-thresholds appends — violates 0/2 exit contract | wrap main bodies → exitWithFailure 2 |
| F6 | edge | medium | route-round rerun under a different armed head silently overwrites the manifest — prior routing provenance lost | refuse exit 2 when existing manifest's armed_digest differs (same digest = idempotent overwrite) |
| F7 | edge+blind | medium | evaluateGate dedupes `confirmed` by recordKey but cluster totals count corpus instances — duplicate corpus line splits the verdict's units | dedupe corpus records by recordKey before clustering |
| F8 | vergap | medium | AC4 "no live judgment path" is only a name-blocklist regex — misses router.ts/provider.ts/client.ts exports (demonstrated: live re-judge ships green) | import-edge allowlist test for route-round (fence.test.ts idiom): only node:*, ../lib/cli-args.ts, ../corpus/{merge,schema}.ts, ../../src/judgment/arm-gate.ts |
| F9 | vergap | medium | countedCorpusDigest determinism rests on unpinned `.sort()` — removing it fails no test | order-invariance test (shuffled inputs → same digest) |
| F10 | vergap | medium | torn outcomes.jsonl line untested in both CLIs (arm-state torn-write IS tested) | malformed-line tests: confirm + dry-run → exit 2, file byte-unchanged |
| F11 | edge | medium | conflicting outcome entries (hand-edited store) silently shrink the counted population | verdict gains `unresolved_outcome_keys=N` gap line + test |
| F12 | edge | low | clause `p=97` (outside [0,1]) passes ≥0.90 → wrongly candidate | partition requires 0≤p≤1, else deep |
| F13 | edge+blind | low | shard membership substring `/-r./` admits foreign `*-round-notes.jsonl` | strict grammar `/^(\d+\|x)-r\d+\.jsonl$/` (x = backfill form, corpusFilePath's null rendering) |
| F14 | edge+blind | low | `Number()` coercion: `0x10`/`1e2`/`" 5"` pass as --pr/--round | strict `/^\d+$/` parse, both CLIs |
| F15 | edge | low | whitespace-only finding_id/labeler/outcome_source pass min(1) → keys that never join, silently uncounted | trim refines in OutcomeRecordSchema (driver-owned adds-only region) |
| F16 | blind+vergap | low | countedCorpusDigest hashes JSON.parse key order — cosmetic reorder changes the digest | fixed literal key order serialization (ArmStateEntry precedent) |
| F17 | edge+blind | low | exported wilsonLowerBound: n=0 / agreed>n → silent NaN (evaluateGate guards; future callers won't) | throw on invalid inputs |
| F18 | accept | low | non-jev/absent-clause manifest entries carry non-jev rationale under AC4's "the jev rationale" field | omit rationale (optional) when no recorded jev clause answers the record |
| F19 | edge | low | commit message over-claims: "--arm/--unarm refuse unless eligible AND pair" — unarm is pair-gated, not eligibility-gated (story-correct) | amend wording at final commit (unpushed) |
| F20 | blind | low | lifecycle-demo.json flip object indistinguishable from a production arming | evidence JSON gains explicit demo-scope marker; e2e rerun regenerates |

## Rejected — with refutation

| Src | Claim | Refutation |
|---|---|---|
| blind#7 | hash chain has no anchor; full rewrite honored — docblock oversells | story Technical Notes :76 accepts exactly this ("an attacker who rewrites the whole log consistently can forge state — accepted, because the log lives in the operator's repo at 0600-equivalent trust"); changing the model would contradict the spec, and editing the spec is not a fix |
| blind#2 | `recordKey` delimiter collision (`a\|b`) merges distinct tuples | grammar is the corpus's LOCKED idempotence key (schema.ts:154-157), pre-existing and shared by merge/backfill; changing it violates the story's adds-only constraint on schema.ts and re-opens settled corpus decisions. Recorded as an observed limitation of the inherited grammar, not a J2 defect |
| blind#10 (main claim) | `p=1e-7` exponent form → not-recorded → deep silently | **REFUTED BY IMPLEMENTATION — triage verdict reversed post-fix-verification:** the pre-fix regex `[0-9]+(?:\.[0-9]+)?` on "p=1e-7" matched "1" and stopped at "e" → parsed p=1 ≥ 0.90 → a tiny-confidence DISMISS routed to the CANDIDATE lane. The driver's "outcome-identical" refutation was wrong (it assumed the clause failed to parse; it silently mis-parsed). Fixed under F2 with a trailing boundary `(?![0-9.eE])` — exponent/non-plain-decimal clauses are now genuinely not-recorded → deep; the F2 cross-pin test asserts the exponent case end-to-end. Logged as a triage-error correction, not a reviewer error — blind#10's drift concern was directionally right |
| accept#4 | J4 machine-state shard would crash the gate loudly | the code comment pins this as intended loud-refusal; J4 naming contract is J4's to land. Info only |
| accept#5 | demo harness not merged (.unlazy untracked) | DoD requires the lifecycle run + evidence JSON — both satisfied; the harness is driver tooling, the lifecycle itself runs from merged CLIs. Info only |
