# HANDOFF — QDS story-review campaign, 2026-09-08

Insurance artifact. Written mid-campaign so a fresh session can resume without
re-deriving anything. If the originating session is still alive and its fix agents are
still addressable, **prefer continuing there** — see "What a handoff actually costs".

---

## One-paragraph state

A `/qds-story-review` campaign is hardening the seven Dark-Factory-v5 stories that were
still `ready-for-dev`. They had never been read against the substrate that now exists,
because all seven predate the 2026-08-31 tier-2 placement ADR and/or the merges of
DF1.10, DF1.11 and DF2.10. Scan found **135** findings; waves 0–4 resolved all of them;
fresh-eyes verification (Wave 5) then found **125 more**, including cases where a fix was
wrong in the same category as the defect it replaced. Wave 5b (BLOCKERs + HIGHs of those
125) is **in flight**. Four commits are on `feature/qds-story-review-remaining-v5-stories`.

**Headline finding, unchanged by anything since: no shipped code contradicts the ADR.**
All 260 findings are spec-side drift against ADR-consistent code.

## Read these, in order

1. `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-08-remaining-stories-pre-dev-review-tracker.md`
   — the campaign's source of truth: ground rules, pairing plan, all 135 scan findings
   indexed by ID, eight cross-cutting themes, ratified rulings, the parent-error log, and
   the sealed Wave-5 calibration.
2. `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` — ACCEPTED, **including
   Appendices A and B**, which this campaign added and which are binding.
3. `_bmad-output/evidence/qds-story-review-2026-09-08/` — ten agent reports (5 scan +
   5 verification), ~10k lines. Every finding carries file+line, a failure scenario and a
   literal fix recipe. **The tracker indexes these; it does not duplicate them.**
4. `_bmad-output/sprint-artifacts/sprint-status.yaml` — slate is 41 stories / 166 pts,
   30 done / 125.

## Operator rulings — already decided, do not re-litigate

| Ruling | Decision |
|---|---|
| Scope | The 7 stories still `ready-for-dev` (DF3.6, DF3.7, DF3.8, DF5.3, DF5.4, DF5.5, DF6.1) |
| Drift rule | Shipped code wins **unless the code contradicts the ADR** → then BLOCKER + PROPOSED ADR amendment, never spec'd around |
| Boundaries | Full authority to re-split and re-point |
| ADR amendments | Both ACCEPTED and written (Appendices A + B) |
| RSS mechanism | cgroup v2 `MemoryMax` under `Delegate=memory`; **no sampler retained, even for telemetry** |
| Code follow-ups | Land as planned stories (DF2.11, DF2.12), not drive-by patches |
| Wave 5 findings | Full cycle — 5b + 5c + a **third** independent verification (Wave 6) |
| Ruling rigor | **Open the file before ratifying anything.** Non-negotiable; see below |

## The rule that matters most

**Verify against source before ratifying any mechanism, function name, threshold or
behavioural claim. Never rule from an agent's description or your own inference.**

This was adopted after four parent-caused BLOCKERs, all the same shape. The worst:
a sibling agent described a guard as an "`existsSync` workaround", the parent relayed
that description into an authoring brief, and the resulting spec would have **deleted a
documented TOCTOU fix** (`scripts/qds-cost.ts:270-300` is a no-create `openSync` +
`fstatSync` inode probe whose fd is held open across construction — not an existence
check). Nobody in the chain opened the file.

Corollary, learned the same way: **do not relay findings to fix agents.** Point them at
the verifier's report and let them read it.

## Live agents (die with the originating session)

`fix-A` (DF3.7+DF3.8) · `fix-B` (DF5.3+DF5.4) · `fix-C` (DF3.6a+DF3.6b) ·
`fix-D` (DF6.1a+DF6.1b) · `fix-E` (DF5.5+DF2.11+DF2.12) — all mid-Wave-5b.
Five `scan-*` and five `verify-*` agents are idle; their output is on disk.

Each fix agent holds a **sacred verified-correct list** and its own prior reasoning.
Those lists are in the scan reports; the reasoning is only partly there.

## What a handoff actually costs

Not tokens — the durable state (commits + tracker + 10 evidence reports) is complete and
a fresh session can reconstruct the campaign from it. What is lost is the fix agents'
judgment context: what they already checked and dismissed, why they chose X over Y, and
five arbitration outcomes where a subagent overruled the parent and was right. A new
session respawns them cold and re-litigates settled ground.

**Therefore:** hand off at a wave boundary (after 5b or 5c completes, before the next
dispatch), never mid-wave.

## Wave 5b — in flight

Fix all BLOCKERs + HIGHs from each `verify-*` report. Priorities named per agent:

- **fix-D** — `V-CC-B4` first: **credential egress.** `cli-anything/src/redact.ts`'s
  `redactSecrets(text, parentEnv)` redacts by exact env-value match with zero pattern
  knowledge, and `readHostToken` deliberately keeps the GitHub token out of `process.env`
  — so the invariant protecting the token blinds the redactor to it. As specified,
  DF6.1b's escalation could post a credential to a public PR. Correct function is
  `src/providers/step-log.ts:225`. **Two exported functions share the name
  `redactSecrets` with opposite security properties — this is a standing footgun and is
  logged as an unfiled code follow-up.**
- **fix-C** — the cgroup placement wrapper **fails open** (a failed write falls through to
  `exec` and runs pi unbounded); the spend ceiling has been derived wrongly **twice**;
  `lastMemory()` does not close; DF3.6b is the sole holdout on the Appendix B correction.
- **fix-B** — every BLOCKER is *"the cited code doesn't do on a real run what the story
  assumes"* behind accurate citations. Hop-5 emitters have no non-test callers; `reap`
  never fires on a healthy run; the harvested `trace.db` wal/shm catch-22.
- **fix-A** — two BLOCKERs are parent rulings backfiring (`unitActivity` made terminal on
  `inactive` starves the dispatch→run window; `observeAndDriveChain`'s `deps`/
  `ChainOutcome` unspecified), plus the DF2.11 required-handle collision.
- **fix-E** — the TOCTOU probe above; amendment G already applied with stale line refs;
  DF2.12's e2e demo unexercisable on the `fake` driver.

## Parent-owned queue (not delegated — do these yourself)

1. Six stale `sprint-status.yaml` comments on DF3.7/DF3.8, including Deviation 1s that
   ADR Appendix A retired.
2. **DF2.12's title says "at the Dispatcher"** — the placement the ACCEPTED ADR forbids
   and the story's own notes refute. Rename in the yaml row and anywhere it propagated.
3. DF5.5's yaml `deps` include `DF6.1b`; only `DF6.1a` is a real scheduling edge.
4. `epics-and-stories-dark-factory-v5.md` has **no** row for DF2.11, DF2.12, DF3.6a/b or
   DF6.1a/b.
5. `sprint-status.yaml` header note `:16-18` still says "DF5.3 (4pt)" and "DF6.1 6 →
   DF5.4 3 / DF5.5 2".
6. DF5.5 has no `**Status:**` line.
7. File the `redactSecrets` name-collision code follow-up.

## Then

**Wave 5c** — MEDIUMs and LOWs from the Wave-5 reports. **Wave 6** — a third independent
verification, fresh agents, uncoupled from every fix recipe. Expect materially fewer
findings; if not, that is the signal to stop and rethink the specs rather than keep
patching. This repo's own history says 2–3 more rounds is normal (DF3.4 took 10, DF5.2
took 18, the v4 campaign 8).

## Do not

- Re-brief verifiers with fix recipes, or with the sealed calibration items in the
  tracker. Wave 5's value is beginner's mind; the calibration only works unbriefed.
- Edit `sprint-status.yaml` from a fix agent — parent owns it, always.
- Let two owners write one edit. The campaign named a defect class for this: work
  **orphaned** between two stories, described by both and owned by neither.
- Trust a line citation without opening the file. Prefer symbol and section anchors —
  three agents converged on that independently after line refs drifted mid-session.
