# J2 review round 2 — findings triage (2026-11-04)

Diff: `git diff dev...HEAD` @ `7cd3f34c` (4183 lines, post-round-1 fixes). Layers: blind-hunter (18), edge-case-hunter (11), verification-gap (3 + 3 other, pre-verified), acceptance-auditor (2 + 5 notes). Convergent findings grouped. Verdicts rendered by the driver after verification (vergap pre-verified).

## Already fixed before triage closed (driver, verified)

| ID | Src | Finding | Resolution |
|---|---|---|---|
| R2-A | accept+blind+vergap+edge (all four) | F20 evidence scope marker missing from the COMMITTED artifact — round-1 fix edited the harness but the node rerun skipped already-met gate N3, so the file never regenerated | root-caused; e2e manually rerun → marker present (grep=1); commit pending in this round's fix commit. Round-1 "all survivors fixed" claim was false for exactly one artifact — corrected here |

## R2-F2 (fixed ahead of triage — acceptance-auditor finding)

Manifest dropped the jev rationale for jev records whose clause exists but fails the strict parse (the exponent case routed deep with no rationale). Fixed: rationale presence keys on `arm==="jev" && r.rationale` — clause parseability gates the lane, not the rationale (route-round.ts:156-159, test updated, suite 20/20).

## Survivors — to fix this round

| ID | Src | Verdict | Finding | Fix |
|---|---|---|---|---|
| R2-B | blind | medium | "recordKey join authority" test is vacuous — asserts schema recordKey on a literal, never the gate's private keyOf; grammar divergence undetectable (round-1 dropped survivor, driver consolidation error) | export keyOf from arm-gate; adversarial equivalence pin vs schema recordKey incl x-form nulls; delete the vacuous assertion |
| R2-C | blind+edge | medium | manifest rewrite guard keys only on armed_digest — same digest + changed shard silently overwrites with a different partition (provenance loss one step removed) | refuse exit 2 when prior manifest JSON differs under the same digest |
| R2-D | blind+edge+vergap | medium | both CLIs pre-drop blank lines before verifyArmStateLog → its blank-line refusal is dead code; interior blank (torn double-append) silently tolerated | drop only the single trailing empty element; interior blanks reach the verifier; test feeds a blank line |
| R2-E | blind | medium | countedCorpusDigest covers outcome entries only — the corpus dispositions that decide agreement are unwitnessed; two corpora differing only in dispositions share one corpus_digest | include the joined corpus rows (recordKey + disposition) in the digest input |
| R2-F | blind+accept | low | conflict refusal says "resolve explicitly" but names no procedure; only exit is an unvalidated hand-edit | refusal message states the exact resolution steps (hand-edit outcomes.jsonl removing the losing duplicate, then re-confirm); operator docs note in PR body |
| R2-G | blind | medium | confirm-outcome never checks the recordKey exists in the corpus — typo'd finding-id writes a never-joining entry, silently uncounted | precheck the join: refuse exit 2 naming the key when no corpus record matches |
| R2-H | blind | low | absent/typo'd --corpus-dir swallowed as empty → "0/200" misdiagnoses a path typo as a data gap (asymmetric with route-round's F4) | existsSync guard → exit 2 naming the absent dir |
| R2-I | blind | medium | evidenceProblem validates shape, not ranges: confirmed=2.5/-3, agreed>confirmed, rate=5, ci_lower=17, negative thresholds all verify | ranges: confirmed/agreed non-negative ints, agreed≤confirmed, rate/ci_lower ∈ [0,1] or "n/a", thresholds finite positive |
| R2-J | blind+edge | low | wilsonLowerBound z unguarded: z=0 → point estimate sold as LB; z<0 → bound above p̂ | throw unless Number.isFinite(z) && z>0 |
| R2-K | blind | low | ArmStateEntry accepts arbitrary extra top-level fields — a future writer's added field ships green and is chain-frozen | exact top-level key set in entryProblem |
| R2-L | blind | low | route-round --pr parse lacks isSafeInteger (confirm-outcome has it) — 20-digit pr fails later as unrelated error | align parsePositiveInt |
| R2-M | blind | low | outcomes readers report line numbers post-blank-filter — error names the wrong physical line | track physical line numbers while skipping blanks; test with leading blank |
| R2-N | blind | low | canonicalOutcomeEntry docblock calls raw-JSON.parse hashing "the bug" while the chain deliberately does exactly that (any byte change = new digest, fail-closed) | docblock states both policies and why they differ |
| R2-O | blind+edge | medium | zero-byte shard passes existsSync → empty manifest exit 0; truncation indistinguishable from an empty round | refuse exit 2 naming the zero-record shard |
| R2-P | vergap | low | F14 fix tested --pr only in route-round; --round validation can be lost silently | mirror the both-flags loop |
| R2-Q | vergap | medium | F15 trim refines have NO test — deleting the refines fails nothing (fix unrepeated); padded " F1" passes trim().length and never joins | schema refine tightened to s === s.trim(); CLI + schema refusal tests |
| R2-R | vergap | medium | F8 import allowlist copied only the static scanner — import()/require() edges bypass the AC4 pin (J1 added allSpecifiers for exactly this) | extend the scanner with the dynamic regexes |
| R2-S | vergap | low | brittle no-stack assertion /\bat \S/ false-fails on any clean message containing " at <path>" | use the /\n\s*at\s/ idiom |
| R2-T | blind | low | two tests leak mkdtemp dirs (no rmSync) | cleanup in finally |

## Rejected — with refutation

| Src | Claim | Refutation |
|---|---|---|
| blind#8 | answer_mode is trusted, unverifiable — mis-attestation undetected | AC5's design IS operator attestation at confirm time ("answer_mode ∈ live\|mock is attested at confirm time"); the modes split prints on every verdict making padding visible, which is the §7.8 counter-metric the story chose. Cross-checking cost fields would re-impute provenance the spec deliberately leaves to attestation. Spec-false |
| blind#15 | triplicated DEFAULT_JUDGMENT_DIR / near-identical outcomes readers / duplicated test helpers = drift sites | real observation, but the fix is a structural refactor (new shared module) beyond a direct correction — the repo's script idiom is self-contained CLIs (merge.ts/ab-report.ts precedent). Recorded as tech-debt note, not this story's defect |

## Acceptance-auditor notes recorded (no action)

- unresolved_outcome_keys blocking eligibility: intended (F11 accepted shape, Goodhart-safe).
- armStateEntryDigest hashing raw parse output: intentional fail-closed; docblock clarified under R2-N.
- AC5 conflict resolution is a hand-edit by design; procedure now named in the refusal (R2-F) and PR docs.
- route-round partitioning every shard record incl frontier-arm → deep: matches AC4's letter.
- Charter §6 / LOCKED #10 / INV-ARM-1/2 verified holding; arm-gate imports node:crypto only (stricter than fence allowance).
