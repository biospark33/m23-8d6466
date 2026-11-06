round 1 wave launched: blind/edge/verify/accept on 5576cb7e diff (1552 lines, 6 files)

## Round 1 findings — blind-hunter: 20
edge-case-hunter: 12 (11 edge + 1 claim)
acceptance-auditor: 9 (7 substantive + informational pin-file + LOW chimera-record)
verification-gap: pending

## Round 1 triage (44 raw → 32 entries; verified against sources)

PATCH (code fixes, 2 waves):
1. [high] verdict.status unconsumed — fresh rejected verdict eligible (blind+edge+verify, verified by demonstration). Fix: PASSING_STATUSES={"approved"} (fleet-result vocabulary, sc2-7 precedent), else verdict-rejected; unify fixtures.
2. [high] carrier probe rooted at hostRoot (target repo) — factory infra never arms (verify+blind). Fix: probe anchored to module URL (factory tree), policy file stays cwd/hostRoot.
3. [high] path normalization bypass (./, //, ..) vs never-list (blind+edge). Fix: real segment resolver.
4. [medium] case-insensitive host bypass of never-list (edge). Fix: casefold compare.
5. [medium] diffEntries/diffPaths divergence — entry absent from diffPaths skips never-check (edge). Fix: union in consult.
6. [medium] carrier probe: comment text passes, re-export missed, stub arms ON (blind+edge+accept). Fix: strip comments, both export forms, test file must reference symbol; residual limit documented.
7. [medium] future-dated producedAt passes; producedAt==rebasedAt passes (blind+edge). Fix: now seam; `<=`.
8. [medium] `**/` zero-segment infidelity vs fixloop matcher (blind; verified: fixloop = (?:[^/]+/)*). Fix: mirror exact algorithm.
9. [medium] empty diffEntries ⇒ eligible zero-change merge (edge). Fix: park out-of-scope-diff.
10. [medium] store.get/DI throw escapes consult block (blind+edge). Fix: try/catch fold (dispatch belt-and-braces precedent).
11. [medium] policy revoked mid-reverify TOCTOU (edge). Fix: re-read at decision-write arm.
12. [medium] consistency test literals (implPresent/settingOn/verdictBlockPresent unread) (accept+verify). Fix: derive from tree; readVerdictBlock reader.
13. [medium] absent-file pin contradicts the designed operator flip (accept). Fix: tree test = evaluateTreeConsistency from real inputs.
14. [low] eligible reasons [] vs satisfied requirements (accept). Fix: emit satisfied names.
15. [low] scope clause name: contract says "scope", impl emits class names (accept). Fix: map to "scope".
16. [low] UNKNOWN adr status mislabeled *-while-proposed (blind). Fix: explicit unknown, fail-closed.
17. [low] fenced-block Status false green (edge). Fix: strip fences.
18. [low] stateReason absent from consult event (blind). Fix: add policyState/stateReason when off.
19. [low] scope vocabulary fidelity comment-only (accept). Fix: text cross-check vs real strings.
20. [low] symlink dir bypass in tripwire (edge). Fix: follow dir symlinks.
21. [low] loader -dir-mode/-path arms untested (blind). Fix: portable arms + owner-arm note.
22. [low] chimera record unasserted; other-extension survival unasserted (accept+blind). Fix: chain-test asserts.
23. [low] fixture duplication drift (blind). Fix: sync-duty comment.
24. [low] writePolicy double-space one-liner (blind; confirmed). Fix: format.
25. [low] `as never` casts (blind). Fix: typed.
26. [low] committed policy.json in fixture vs posture (blind). Fix: fixture-only comment.

DAR (recorded, no code): reason = house-idiom constant, audit detail rides the consult event; eligible-then-vetoed = two-event audit trail (comment added in wave B).

FALSE (rejected with refutation): blind "ADR edited in place" (edits confined to status bullet + signature rows; verdict-block oracle proves byte-identity of all other lines); blind "DD-18 not in register" (story sanctions the ADR file as the ONLY docs edit; DD-19 unchanged ⇒ no addendum owed); blind "92 insertions wrong" (git numstat: 92/0).

Cross-wave contract (both waves implement identically): eligible ⇒ reasons = ["never-path-clear","scope-ok","verdict-fresh","policy-on"]; failing ⇒ contract clause names (never-path, scope, verdict-absent, verdict-stale, verdict-escalated, verdict-rejected, policy-off); QaVerdict passing status = "approved" everywhere.

## Round 2 findings — acceptance-auditor: 6 (1 vocabulary drift→DAR, 3 patch, 1 DAR, 1 informational)
blind-hunter: 16
verification-gap: 3 (2 gaps + 1 other; all verified w/ demonstrations)

## Round 2 triage (36 raw → 24 entries; edge's verified-claims list confirms r1 fixes held)

PATCH wave C (policy module + suite):
C1 [high] readVerdictBlock fail-open: parse the LEADING bolded disposition token, exclude REJECTED/NOT (blind+edge+accept converge)
C2 [high] ACCEPTED-arm checks nothing: accepted-without-verdict-block + accepted-while-clause1-rejected violations (blind+edge; AC1 recording protocol)
C3 [low] readVerdictBlock fence-strip (edge)
C4 [medium] rebasedAt omitted ⇒ verdict-stale (freshness needs a rebase anchor; blind+edge converge)
C5 [medium] escalated truthy-non-boolean passes (edge)
C6 [medium] src/audit node itself + drive/absolute/leading-.. spellings park (edge#1+#2, verify-other)
C7 [medium] deny-pass casefold, documented as deliberately-stricter divergence (blind+edge converge)
C8 [low] tripwire: module-URL anchor + scripts/ + dev:ino visited set (blind+edge)
C9 [low] adr2AcceptedOn calendar regex (cross-check-ADR part FALSE: spec rejects loader doc-parsing)
C10 [medium] verdict-future reason (blind#16) + verdict-rejected/verdict-future/consult-error recorded as sanctioned contract extensions (resolves accept#1)
C11 [low] audit-rowed hook comment on QaVerdict (accept#2)
C12 [low] named return type (blind#15)
C13 [low] v6a-invariant upgrade-cue comments (blind#10)

PATCH wave D (run-completion + chain test):
D1 [medium] fold emits auto-merge-consult-error event — no silent policy-present path (blind+edge converge)
D2 [high] revocation arm: consultContext deletes policy mid-chain ⇒ awaiting-approval, no mint (verify#1+blind#4)
D3 [high] throwing-consultContext arm: driven + parked + no mint + consult-error event (verify#2)
D4 [low] clause-5 attach-point comment at recordPolicyApproval (blind#3)
D5 [low] duplicate decidedAt assert dropped (blind#14)
D6 [low] guard comment sanctions the second policy read (accept#4)
D7 [contract] fixtures carry rebasedAt; consult-error event asserted in D3 arm

PATCH driver: buildId comment qualitative (blind#11/edge verified 138/0).

DAR: producer tripwire text-only limit (accept#5, self-documented); Files-to-Modify omission (accept#6, documented in place); vocabulary extensions recorded (C10).
GA9 actions: story file DAR+status ships pre-PR (blind#12); backlog entries for veto-window queue + consent surface (blind#13).
FALSE: ADR-in-place claim re-filed by edge — refuted again by the verdict-block oracle (byte-identity outside sanctioned status+signature rows).

## Round 3 findings — verify: 1 gap (mint-vs-human untested, patch) + 1 note | edge: 8 (7 patch + 1 low claim) | accept: 5 (drift-level, none AC-blocking) | blind: 15, tail pending

## Round 3 triage (29 raw → 18 entries; accept verdict: all six ACs mechanically satisfied, drift-level only)

PATCH wave E (policy module + suite):
E1 [high] never-list self-protection: += auto-merge-policy.ts, veto-window.ts (future carrier), allowlist-path.ts (the 0600 guard) — the policy brain is a gate surface; run-completion.ts NOT wholesale-added (would over-park every run; operator may tighten later — DAR note)
E2 [high] scope gate over the UNION (blind#2) + outside-root parked in evaluateDiffScope (blind#3+edge#1 — the dropped flag)
E3 [medium] verdict == null TypeError (edge#2)
E4 [medium] UNC //-prefix ⇒ outside (blind#4+edge#3)
E5 [medium] disposition cell = LAST table cell's bolded token, not first-anywhere (edge#6)
E6 [medium] unpaired-fence tails stripped in readAdrStatus + readVerdictBlock (edge#4+#5)
E7 [medium] symlinked FILE stat-resolved in the tripwire (blind#6+edge#7)
E8 [medium] QaVerdictStatus union + zod QaVerdictSchema, unparseable verdict ⇒ verdict-absent (blind#14+accept#2 — A2's extendable contract artifact)
E9 [low] escalated doc aligned to code (0/"" park) (blind#7)
E10 [low] "same-tick" → "same completion call, across the reverify await" (blind#8)
E11 [low] drop redundant link-store never-entry (blind#9)
E12 [low] ConsultResult single source (policyState; flat policyOff removed) (blind#11)
E13 [low] ACCEPTED-arm per-surface violation names (blind#12)
E14 [medium] adr2AcceptedOn <= today bound (now opt, default wall clock) (blind#13)

PATCH wave F (run-completion + chain test):
F1 [high] eighth arm: eligible consult + already-decided human outcome ⇒ human decision fields untouched, no policy:adr-2 (verify#1)
F2 [medium] ninth arm: deleted-to-absent policy at mint-time re-read (verify#2-adjacent, blind#10) + a verdict-rejected chain arm (blind#10)
F3 [contract] event reads policyState.stateReason (E12); fixtures updated

DRIVER: buildId digest re-derives after waves (blind#5 — standing ritual).
GA9 (story close): DAR records vocabulary extensions (accept#3), carrier-probe tripwire status (accept#1+verify note), never-list self-protection decision (E1), Files-to-Modify note (accept#4); story file DAR+status filled (accept#5); backlog anchors for veto-window queue + consent surface surfaced to operator (blind#15).
