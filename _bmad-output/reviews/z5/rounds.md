# Z5 bmad-code-review rounds — evidence (2026-10-13/14)

## Round 1 — 4 layers (blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor) on dev...HEAD

26 findings → triage: 11 patch groups (all fixed in round 1), 4 defer, 9 rejected.
Full triage + dispositions: story file, "Review Findings" section.
Notable fixes: dormancy guard hardened (barrel exemption narrowed to clause (a);
visualizer/ walk; log-via-transport rule 4; origin .d.ts/index resurrection;
multiline dynamic-destructure clause capture; template-literal ceiling);
tests/swarmclaw/mask-env.test.ts added (direct INV-SC5 units); stale docblocks
scrubbed (hindsight/client, tool-bridge); provenance-note corrections; bash-3.2
portability comment rationale corrected.
Contract amendments: r8 (owned set +1, comment allowances 1.1.1/1.1.3).

## Round 2 — same 4 layers on the post-round-1 diff (2,664 lines), instructed to honor round-1 triage

15 findings → triage: 10 fixes (all applied), 2 defer, 3 dup/rejected.
- VG: tests/ walk under rules 1/2/4 (rule 3 production-only) — the stale-merge
  log-via-transport hole; ACCEPTED, implemented (plus string-literal span
  awareness the extension forced).
- ECH: star/namespace clause tightening for rules 2/4 — ACCEPTED; logMuted added
  to LOG_CLAUSE (enforces stdio-transport's own header claim); rule-4 resolved
  arm pinned; naming negative control now asserts the formatted failure message;
  walk breadth made live (.js/.jsx/.mjs/.cjs); __proto__ key-loss PINNED as
  inherited-from-origin behavior, behavioral fix DEFERRED (verbatim-move mandate).
- BH: header citation untracked (.unlazy) → made self-contained; visualizer/
  test-carve-out documented; tool-bridge header half-truth completed (routes AND
  hindsight); provenance-note contradiction reworded; portability comment garden
  path fixed.
- AA: visualizer/server/index.ts:399 stale old-home comment scrubbed (accepts
  the round-1 patch class; amends C10 scope exclusion for that line) — r9,
  owned set 127→128. BG3-class truth item: nine re-export consumers (spec said six).
- DEFERS recorded: maskEnv __proto__ behavioral fix (successor story), README.md
  old-home section (C10 scope), bash-walk automation gap (r6), two-lexer
  consolidation (separate refactor).

## Stop decision

Per the standing contract (fix ALL incl LOWs in rounds 1-2; may stop after any
round where only LOWs remain): round 2's findings were fixed or deliberately
deferred in round 2; the remaining open items are the recorded defers. STOPPING
after round 2. Final verification: node-1.1 ALL MET 13/13 (three consecutive
clean passes on the shipping tree), BG1 pass-set OK 8030/12/15 with 14 markers
strict subset of baseline, 0 new failures.
