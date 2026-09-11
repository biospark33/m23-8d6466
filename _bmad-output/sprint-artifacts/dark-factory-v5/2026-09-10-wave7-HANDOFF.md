# HANDOFF — QDS story-review campaign → Wave 7 (2026-09-10)

**Written for a fresh session.** Everything needed is on disk. Written by the Wave-6 session
after DF2.11 landed; every claim below was verified against the tree at `dev` `b896eab4`,
not carried forward from a previous handoff — the last handoff contained two wrong claims,
both of which this campaign's own rule (open the file) caught. Expect this one to be wrong
somewhere too. Verify before acting.

---

## 1. The rule that outranks everything

> **Open the file before ratifying anything.** Never rule from an agent's description, a
> summary, a symbol name, or your own inference. Never relay a finding to a fix agent —
> point them at the report.

This rule was broken **six times by parents across this campaign**, including twice by the
Wave-6 session itself (reporting DF2.13's citations "correct" from the commit's authorship
instead of opening the file; a `+26` displacement estimated as "+20" inside the very
docstring warning about it). **Cite by symbol or section anchor, never by line number** —
505 line citations survived the rule's adoption, and one commit displaced 12 of them at once.

**Five-plus subagents overruled a parent and were right every time.** When one pushes back
with evidence, check the evidence.

---

## 2. Where the campaign stands

| Wave | Findings | Character |
|---|---|---|
| Scan 0–4 | 135 | C1 — citation accuracy (wrong paths/symbols/lines) |
| Verify 5 | 125 | C2 — citations right, **semantics false** (cited code never runs on a real run) |
| Verify 6 | 90 | **C3 — the spec is not self-consistent at its own seams** (31 = 34%; C4-marginal only 13 = 14%) |

**Verdict, delivered and standing: NOT CONVERGED. A fourth prose-patch round is
explicitly ruled out.** The C3 class is substantially *iatrogenic*: orphaned work across
seams the campaign cut, residues dead from edges the campaign added, a number derived
wrongly three times. More patching generates more of the same. The answer is
**seam-ownership rework** (§5), then re-verify.

Full analysis: tracker §"Wave 6 result". Evidence: `_bmad-output/evidence/qds-story-review-2026-09-08/wave6-{A..E}-*.md`.

### What landed since Wave 6 (all verified on `dev`)

- **DF2.11 DONE** — `teardownSandbox` takes a required branded `RunLockHandle`
  (unlocked call fails to compile), `CostLedger.openReadOnly()` refuses absent/creates
  nothing. **Round-6 live verification green on real substrate, zero model spend** — all
  five scope legs proven (story §"Live E2E — round 6", evidence `_bmad-output/evidence/df3-e2e/2026-09-10-*`).
  Six in-story review rounds; sixth pin adoption rode the round.
- **The image-republish debt is SETTLED.** Seventh pin adoption `706366c5`
  (DEFAULT_IMAGE_REF → `13061e0f…`, buildId `a6278c4510cfc539`, gate B of run
  34536729175, first green build off the ea6c3f5c exeuntu base) + live boot proof
  `b896eab4` (tier1-driver-lifecycle, isRepoPin:true). The struck-through debt paragraph
  in `build-exedev-image.test.ts` records this.
- PRs #238 (run-lock NULs), #239 (wave-6 + gate), #240 (buildId adoption) all merged.
  Branches pruned. Local state: `dev` clean, in sync, only `dev`+`main` local.

### Slate (recomputed from rows, not the meta block — always recompute)

**42 stories / 169 pts. Done 31 / 128. Remaining 11 / 41 pts, all `ready-for-dev`:**
DF2.12 3 · DF2.13 3 · DF3.6a 3 · DF3.6b 3 · DF3.7 4 · DF3.8 4 · DF5.3 6 · DF5.4 5 ·
DF5.5 3 · DF6.1a 4 · DF6.1b 3.

---

## 3. Read order

| # | Artifact | Why |
|---|---|---|
| 1 | **This file** | |
| 2 | `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-08-remaining-stories-pre-dev-review-tracker.md` | Campaign source of truth: ground rules, rulings, wave-6 section, parent-error log |
| 3 | `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` | ACCEPTED **incl. Appendices A and B** — binding |
| 4 | `_bmad-output/evidence/qds-story-review-2026-09-08/wave6-*.md` | The five Wave-6 reports — every C3 finding with evidence and fix direction |
| 5 | `_bmad-output/sprint-artifacts/sprint-status.yaml` | Slate + per-story notes (authoritative on status) |
| 6 | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` | §4 D2–D8, §5.1–5.3, §6.2 |

---

## 4. The job, in order

### (i) Dev DF2.12 and DF2.13 now — they do NOT wait on the nine

Both converged (Wave-6 verifier E, high confidence, defects independently re-verified at
source). Both fix live defects in merged code: DF2.12 arms the disarmed D4 tripwire
(`ingestCostEvent` has zero non-test callers — a tier-2 demotion control is undecidable);
DF2.13 makes `defaultKeyCapMicroUsd` an enforced bound instead of a docstring. Use the
`qds-dev` skill. Branch convention: prefix `feature/` base `dev` target `dev`.

**Landing DF2.12 retires C3 mass for free** — DF3.6a's ceiling arithmetic depends on token
rows existing. Landing DF2.11 already retired W6-A-H2's whole "until DF2.11 lands" section.

### (ii) Wave 7 — seam-ownership rework of the nine remaining specs

NOT a prose patch round. Per split pair and per contract, produce a **seam-ownership
table**: every deliverable, file, call site, flag, AC, test and edit listed **once**, with
**exactly one owner**. Then reconcile each spec to its table. The C3 archetypes to kill,
each verified at source during Wave 6:

- **Orphaned work** — described by both halves, owned by neither, green in both DoDs.
  Archetype W6-D-B1 (BLOCKER): DF6.1a ends "Invocation 2 exits"; DF6.1b opens a 15-min CI
  window "measured from `pushVerifiedSha`'s return" *inside* invocation 2, and its
  `fix-run.ts` "adds only" list omits the poll call site — `ci-status.ts` declared,
  never called. Also B-H2 (`.sandbox/reverify/` has no path seam; C9's subprocess reads
  the dev's real repo), A-M5 (DF3.7's verb must take the run lock — invariant with no
  owning AC).
- **Branches unreachable by the story's own ordering** — A-H1: at AC3's single permitted
  observation point the marker hasn't been read, so `markerWitnessed` is always false and
  `completion-unwitnessed` fires 100%; DF3.7's `ChainOutcome.markerWitnessed` has no
  producer of `true`. Also C-B2, D-H5.
- **Residues dead on arrival** — anything conditioned "until DF2.11 lands" is now moot:
  the edge was DF2.11 ≺ DF3.7 ≺ DF3.8 and DF2.11 has landed. Three artifacts stated three
  edge strengths; reconcile to one (the yaml's).
- **Declared scope forbidding required edits** — D-H6: `GitHubApi` has four methods, none
  lists PR review comments; `src/pr/github.ts` not in Files to Modify.

**DF3.6a special case — stop deriving the number.** The spend ceiling is wrong a THIRD
time, same family: the derivation charges `spent` at the projected 504 µ$ rate while
`meter(reply.usage)` (`src/phase-engine/steering.ts`) sums *actual* usage (binds near
call 82 with the repo's fake resident, not 16). Worse, the story contradicts itself:
§"The refusal is driven by the projection, never by metered spend" vs the predicate
`spent + projected > effectiveCeiling`. **You cannot patch a number to settle a
disagreement the story has with itself about its metering basis.** Resolve the design
question first (which operand is metered, which projected, and what the 504 µ$ fixture
price means against in-box catalog prices), then let the arithmetic follow. Also open:
C-H2 (fail-closed `loadResidentBounds` refuses every existing manifest, including
`--no-resident` runs — INV-BND-5 violation) and C-B4 (no producible trigger for the
memory-bound AC). Check DF2.12's landed token rows before re-deriving anything.

### (iii) Re-verify (Wave 8) after the rework

Fresh verifiers, no recipes, category classification as in Wave 6. Convergence target:
C4-dominant residue.

---

## 5. Settled rulings — do not re-litigate

| Ruling | Decision |
|---|---|
| Drift rule | Shipped code wins **unless it contradicts the ADR** → BLOCKER + PROPOSED amendment, never spec'd around |
| ADR amendments | Appendices A + B ACCEPTED, binding |
| RSS mechanism | cgroup v2 `MemoryMax=` under `Delegate=memory`, **direct cgroup-fs write, NOT `systemd-run --scope`** (engine is `User=exedev` in a *system* unit; `--scope` needs polkit → silent run-time failure on a box). **No sampler retained** — `memory.peak` is the kernel high-water mark |
| DF5.1's `ps`-sampled ceiling | **Stays open** — host-side, possibly darwin; two problems, two kernels |
| Fix-scope | Deny-list stays **broad**; nothing in fix scope may participate in verifying the fix (`scripts/**` contains `reverify.ts`); terminal states `out-of-scope-diff` (charges) vs `scope-requires-privilege` (charges zero, escalates) |
| Spend chain | `residentSpendCeilingMicros ≤ capMicroUsd (mint-time) ≤ defaultKeyCapMicroUsd`; middle term re-homed, DF2.13 adds the upper bound |
| Code follow-ups | Land as planned stories, not drive-by patches |
| Deviations | Never story-local against an ACCEPTED clause — ADR appendix at an operator gate |

---

## 6. Tools and mechanisms now in place

- **`scripts/check-story-consistency.ts`** (`bun scripts/...`, gated by
  `tests/scripts/story-consistency.test.ts` under plain `bun test`): slate arithmetic,
  header↔yaml, epics-index membership, dep edges, citations (past-EOF + ambiguous bare
  basenames). **Fails for not-yet-done stories; reports done ones as info.** Currently
  green (42/169). No npm alias — `package.json` is a Dockerfile COPY input.
- **Image pin discipline**: any edit to a COPY-walked path (`src/fleet/`, `scripts/lib/`,
  `package.json`, …) moves the buildId literal in
  `tests/scripts/build-exedev-image.test.ts` — *including comment-only edits*. The test
  fails and names the ritual. Republish → adopt via `publish-exedev-image.yml`, gate B
  prints the pair; three sites, one commit.
- **GitNexus contract**: the `type` field was adopted (2026-09-08) as
  `z.string().optional()` on symbol/process-symbol shapes after root-causing at the emit
  site (BM25 rows carry no `type`, vector rows do; our indexes were silently BM25-only
  until the arch-guard fix). Pin stays 1.6.9. **The alarm is the ritual's tripwire —
  red means follow `CLAUDE.md`, not loosen the schema.**
- **Self-proving greps**: any "grep returns zero" claim pairs with a positive control on
  the same file; control fails ⇒ **unproven**, never clean. (Mandatory over
  `scripts/lib/run-lock.ts` historically; NULs now escaped.)

**GitNexus index is STALE** (indexed at `fa7d0e26`, dev is at `b896eab4`). Reindex first:
`bash scripts/install-gitnexus-plus.sh` — never a bare `gitnexus analyze`.

---

## 7. Parent-owned queue (small; do these yourself)

1. **Tick DF2.11's DoD image-repin checkbox** (story file, the "Image re-pin (INHERITED
   DEBT)" item): completion is documented in the story's round-6 record and by the
   seventh-pin adoption `706366c5` + boot proof `b896eab4`. An unticked box in a done
   story is drift; the checker does not gate done stories.
2. **Done-story citations (102 info findings)** are reported not gated by the checker —
   triage opportunistically, not as a wave.
3. **Reindex GitNexus** (above) before any `impact`/`context` work.
4. Open dependabot PRs exist; not this campaign's business.

---

## 8. What NOT to do

- **No fourth prose-patch round.** The verdict is seam-ownership rework.
- **No editing done stories' dev records** beyond factual nits like §7.1.
- **No new stories without a named owner for every deliverable** — orphaned work is the
  named defect class.
- **No line-number citations** in anything you write. Symbol or section anchor.
- **Do not brief verifiers with fix recipes or author self-doubts** — the Wave-5 seal
  failed *because it was stale*: both sealed items had already been found and closed by
  Wave 5. If you want a calibration test, first verify it is still un-found.
- **Do not assume a fixed finding is fixed.** DF3.6a's ceiling was wrong after two fix
  rounds; the contract test stayed red after its own fix commit; the embeddings test
  failed on the branch that fixed the guard. Fixes inherit the defect class.

---

## 9. Campaign ledger (for pattern-matching, not nostalgia)

- Six parent errors caught by subagents; five-plus overrules, all correct on inspection.
- The same slate-count drift appeared in **six artifacts** before the checker existed.
- One commit (`287c036c`) displaced 12 citations at once — 7 never updated, 5 updated
  from an eyeballed hunk size. The docstring warning about it committed one about itself.
- Wave 6 found the campaign's own fix commits generating the defect class they fixed.
  That is why the gate shipped instead of another review round.

Everything above the marker is the record; below it is the work.
