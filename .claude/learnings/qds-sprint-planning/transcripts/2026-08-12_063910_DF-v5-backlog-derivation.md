# 2026-08-12_063910_DF-v5-backlog-derivation.md

Session record for `/reflect` — Dark Factory v5 story derivation (qds-sprint-planning,
adapted for backlog derivation rather than single-epic planning). Condensed, role-marked,
faithful to the actual session flow; verbatim artifacts live in the repo (commit `97462d8`,
PR #101). Structured per the skill's transcript contract (role markers, .md).

---

system: SessionStart. Handoff from prior session: all pre-derivation gates CLOSED at ae2813e
(F6 live step-0 proof, F13 licensing CLEAR w/ conditions, F8 economics, F14 disposition
audit). Task: derive the new story backlog from the v5 design §8 build order, replacing the
retired 30-story superstructure. Full enterprise rigor, evidence-cited, waves of parallel
subagents, verifier pass before anything ships. Closed docs must not be modified.

user: tag you're it from last convo […full handoff with READ-FIRST list, conditions
register, known facts…] cont w full enterprise grade rigor. no shortcuts or bandaids

assistant: Invoked qds-sprint-planning skill. Read canonical skill + phase-3-wrap-up.md +
patterns.yml (SPL-001..SPL-024 loaded). Read all four input docs in full (design r2, F14
audit, gates report; F6 proof consumed via gates-report summary + path passed to writers).

assistant: Phase 0 decisions (orchestrator-owned): epic code **DF** after SPL-017 collision
check against sprint-status.yaml (existing codes phase-0/1/2 only — clean); stories to
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/` (phase-style named dir, NOT
sprint-N — repo uses phase-scoped dirs); IDs DF{step}.{n} keyed to §8 build-order steps;
DF6 = the "5+" feedback-loop slot. Drafted a ~30-story strawman slate for the sizing agent
to refine rather than letting research start unanchored.

assistant: Phase 1 — 5 parallel research agents (write-to-file, return path + abstract per
v1.3.0 token contract): R1 story template + atomicity constraints; R2 verbatim
surviving-clause extraction from the 10 RE-DERIVE story files; R3 code-asset/seam map; R4
SSSF/inkwell/pi external patterns; R5 dependency/sizing/waves (strawman inlined in its
prompt).

assistant: [FINDING — R5] Slate refined to **31 stories / 111 pts / 3 sprints**. Strawman
aggregate held exactly (111 vs 111) but shape changed: P1.4 merged into DF1.1 (v5 has no
declarative step-graph engine), DF2.7 cost-instrumentation split out (F8 condition 1 is a
sharply-bounded prerequisite), DF3.6 resident-agent bounds split from DF3.3 (tripwire
re-spec deserves its own test surface). **Critical path = provider track (30 pts), not the
phase engine (19 pts)** — contradicts instinct; staff provider first. F14's "30–45 pts
net-new" was a floor: gates report created 5 obligations (14 pts) postdating the audit,
and audit table cells each hid 5–6 subsystems. Actual net-new ≈ 70 pts.

assistant: [FINDING — R2, load-bearing] **The closed F14 audit's §3 clause labels do not
resolve against the source story files** for 8 of 10 RE-DERIVE stories. Three failure
modes: label drift (P1.6's schema is AC1 not AC3), nonexistent labels (P1.6 has 4 ACs;
audit cites AC5/AC6), and 28 "phantom" clauses whose text exists nowhere in the story set —
they are the design's §5.2 / PR #97 contract language, real requirements with the wrong
provenance. Plus one 10,000× unit contradiction (source `costCents` 500-default vs design
micro-dollars) and one inverted security doctrine (source P1.15 pushes from the box; D8
forbids). Root cause hypothesis (R2): audit §3 was written against the step-0 proof
artifact + design contract language, not the story files it cites.

assistant: Resolution without touching the closed audit: erratum DD-8/DD-9/DD-10 in the NEW
decision register (`docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`) —
writers consume R2's crosswalk only; phantom clauses authored FRESH under normal review
(never under the "survives verbatim, do not re-litigate" shield — that would launder 28
unreviewed requirements); micro-dollars win with the cap explicitly restated (5,000,000 µ$,
no numeric literal carried across the unit change); D8 host-side push wins. Register also
recorded DD-1..DD-7 disposing all seven audit-§6 coverage holes BEFORE writers spawned
(operator-CLI-only v5.0; DF6 slot; DF2.4 live cap-kill; OQ-4 owner + DF5.3 VOID retain
link; P0.7 amendment deferred to step 6; SwarmClaw = query chassis not front door) and two
boundary contracts (DF1.3↔P1.9, DF1.5↔P1.5).

assistant: Phase 2 — 16 writer agents, 3 sequential waves (6/6/4), MAX 2 stories each
(SPL-001/SPL-013 pre-flight: ceil(31/2)=16 ✅; flagship DF1.6 solo per R5). Prompts carried:
R1 template path, decision register (binding), R5 §6 twenty binding facts, pair-specific
R2/R3/R4 sections, atomicity constraints, dual-output contract. All 31 landed.

assistant: Phase 2.5 atomicity audit (dedicated agent): **0 BLOCK**, 3 advisory WARNs
(glob/dir entries in Files-to-Modify for DF4.1/DF4.2/DF5.5). Normative 182–199 lines vs
200 cap; all ≤5 SP; DOD ≤10 everywhere; zero blocker markers. Orchestrator had pre-scanned
mechanically (wc/grep) before spawning — cheap sanity layer.

assistant: Phase 3 Step 3.0/3.0.5 — domain-trigger grep across slate: auth (11 files),
secrets (20), migration (2), input (1) checklists fired; RLS none. shared_pattern_note
built from orchestrator grep pre-scan of drift-prone tokens (exitStatus enum, µ$ unit,
provider verbs, refs/sandbox spelling, module roots) — the pre-scan itself caught nothing
broken but armed the reviewers with a verified token list and flagged module-roots as a
suspect.

assistant: Step 3.1a — 16 per-story pipeline agents (review→fix→verify in own context,
Edit in place, max 3 iterations, JSON verdicts). **All converged HIGH=0 / MEDIUM≤3 in 2–3
iterations.** Real catches fixed in place: NET-NEW material smuggled under surviving-clause
banners (DD-8 violations in DF3.4 among others); `attach` as an unbounded unauthenticated
privilege surface (rewrote INV to "steering carries no privilege"); timeout-expiry
ordering allowing a late human approve to land; fixture-secret sentinel conventions
missing; per-story deps checked against R5 §2.

assistant: Step 3.1b — single cross-story agent with the surviving cross-boundary MEDIUMs
as an explicit work queue + full-slate sweep. **H=0 / M=0, 15 files reconciled.** Caught
classes per-story agents structurally cannot: headroom API drift (DF3.2 assumed
`headroom()→int`, owner DF2.6 defines `checkHeadroom(n)→object`); a TWO-WAY dangling
`fleet reap` deferral (DF2.6/DF2.3 deferred to DF3.1 which explicitly doesn't ship it —
and DF3.5 documented the verb in a way that would fail its own AC1 build check); 9 files
missing `**Sprint:**` headers (slate now 13/13/5 = R5 §3 exactly); ratified the DF4.1 auth
scheme decision surfaced by a per-story reviewer. Note: the queue misattributed the
"atomic reservation" offender to DF3.2; the cross-story agent verified and found DF2.6 was
the stale one — owner-wins rule needed the nuance "owner of the subsystem ≠ owner of the
description of another story's scope."

assistant: Wrap-up — epic index rebuilt from story files (writer Output-2 briefs lived only
in transcripts); sprint-status.yaml updated by agent (df1–df6 blocks, phase-1
superseded-per-f14 + per-story successor pointers, YAML parse-validated); detect_changes =
0 symbols / 0 processes (docs-only). HALTED at Story Review + Commit gates with full
disposition summary.

user: Yes, please commit and push to a new PR

assistant: Commit `97462d8` (57 files, +12,588) on docs/dark-factory-v5-design; PR #101 to
main with the adversarial iteration log in the body (skill requirement). Heredoc commit
message failed shell parse → used `git commit -F /tmp/file` (recurring pattern: long
multiline messages via file, not heredoc).

user: Can you handle SkillStep9 there in order to capture the learnable patterns?

assistant: This file.

---

## Candidate learnings for /reflect (with evidence pointers)

1. **[review-process] Verbatim-crosswalk extraction before writers, whenever an upstream
   disposition/audit table names surviving clauses.** F14 §3's labels didn't resolve (28
   phantoms, 1 unit contradiction, 1 inverted doctrine). The R2 agent turned a would-be
   requirement-laundering incident into three clean register decisions. Rule: writers never
   consume a clause-disposition table directly; a dedicated extraction agent quotes real
   source text with real labels/line numbers first, and phantom items route to
   fresh-authoring under normal review. Evidence: R2 §0/§11; register §5a (DD-8/9/10).

2. **[agent-orchestration] Background review agents must Write their structured verdicts to
   disk IN THE ORIGINAL PROMPT.** Verdict JSONs returned as final text are unreachable from
   the orchestrator (idle notifications carry no content; TaskOutput can't resolve teammate
   agents). Mid-flight SendMessage retrofit worked but raced. Writers were fine (files were
   the deliverable); reviewers weren't. Evidence: verdicts/ dir exists only because of the
   retrofit messages.

3. **[tooling-hygiene] Never `cd` in compound Bash calls — absolute paths only.** A
   persisted cwd from an earlier `cd X && …` made later relative checks report the stories
   dir missing and verdicts absent → false alarm, wasted turns, near-misdiagnosis.
   (Matches the harness's own guidance; now evidenced in-skill.)
   **ADDENDUM (CR review — narrowed invariant):** the actual failure was relying on a
   persisted working directory across calls, not `cd` itself. The precise rule: do not rely
   on a persisted working directory; use `git -C`, a subshell, or an explicit repository-root
   path for each check.

4. **[story-authoring] Writers targeting "≤200 normative" converge at 195–200, leaving zero
   review headroom.** Six files ended at exactly 200 after review passes; several MEDIUM
   fixes were declined purely for line budget. Instruct writers to target ≤185 so the
   adversarial loop has room to add invariants without cutting load-bearing text.

5. **[review-process] Keep the cross-story pass (3.1b) mandatory and feed it the per-story
   verdicts' surviving cross-boundary findings as an explicit work queue.** It caught
   owner-API drift, a two-way dangling deferral incl. a story failing its own AC, and a
   9-file template omission — classes structurally invisible to per-story agents. Also:
   verify queue attributions; one item blamed the wrong story (DF3.2 vs DF2.6).

6. **[story-authoring] Template must mandate a `**Sprint:**` header field.** 9 of 12 wave-1
   stories omitted it (later-wave prompts stated it explicitly; wave-1's didn't).
   Field-level omissions replicate per-wave — fix the template, not the prompts.

7. **[wave-strategy] Re-sum conditions registers when sizing against an older estimate.**
   F14's 30–45-pt net-new predated the gates report, whose conditions added 14 pts of
   stories (DF1.9/DF2.4/DF2.7/DF2.9/DF3.6). Estimate-as-floor, not range; and the
   dependency graph put the critical path on the provider track, not the "obvious" engine.

8. **[agent-orchestration] Orchestrator grep pre-scans (atomicity mechanicals,
   shared-pattern tokens, domain triggers) before spawning judgment agents.** Cheap, catches
   gross failures instantly, and turns the shared_pattern_note from assertion into
   verified data. Total campaign: ~45 subagents (5 research + 16 writers + 1 auditor + 16
   reviewers + 1 cross-story + 2 wrap-up), zero re-spawns needed.

9. **[tooling-hygiene] Long commit messages via `git commit -F <file>`, never heredoc** —
   heredoc-in-$( ) broke shell parse on special chars.
