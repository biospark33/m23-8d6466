# HANDOFF — QDS story-review campaign → Wave 6

**Written for a fresh session.** Everything needed is on disk. Handing off *here* is deliberate,
not a fallback: Wave 6 is a verification wave, and verification demands beginner's mind. The
outgoing session has 260 findings of investment in these specs and cannot judge convergence
neutrally. You can. That is the point.

---

## Your job, in one sentence

Run **Wave 6** — a third independent verification of eleven story specs — and then make one call:
**have these specs converged, or do they need rethinking rather than a fourth patch round?**

---

## 1. The rule that matters more than any finding

> **Open the file before ratifying anything.** Never rule from an agent's description, a summary,
> or your own inference. Never relay a finding to a fix agent — point them at the report and let
> them read it.

This is not process hygiene. In this campaign it produced, in order: four BLOCKERs, a spec that
would have **deleted a shipped TOCTOU fix** (a sibling agent called a guard an "`existsSync`
workaround", the parent relayed that phrasing into an authoring brief, nobody opened
`scripts/qds-cost.ts` — it is a no-create `openSync` + held-fd inode probe closing a
replace-and-restore race), and a near-miss **credential egress** (a ruling named a redaction *step*
instead of a *function*, and two exported functions share the name `redactSecrets` with opposite
security properties).

The outgoing parent broke this rule four times **after adopting it**, most recently inside the very
comment that fixes a stale claim — citing a line number that its own edit had displaced twenty lines
earlier. Expect to break it too. Build the check in rather than trusting yourself.

**Corollary, converged on independently by three agents:** cite by **symbol or section anchor**, not
by line. Line citations were the single most common defect across ten agent reports, and the
campaign kept generating fresh ones while fixing them.

---

## 2. Read these, in order

| # | Artifact | Why |
|---|---|---|
| 1 | `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-08-remaining-stories-pre-dev-review-tracker.md` | Campaign source of truth: ground rules, all findings indexed by ID, eight cross-cutting themes, ratified rulings, the parent-error log, the **sealed Wave-5 calibration** |
| 2 | `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` | ACCEPTED. **Including Appendices A and B**, added by this campaign, binding |
| 3 | `_bmad-output/evidence/qds-story-review-2026-09-08/` | Ten agent reports (5 scan + 5 verify), ~10k lines. Every finding: file+line, failure scenario, literal fix recipe |
| 4 | `_bmad-output/sprint-artifacts/sprint-status.yaml` | Slate: **42 stories / 169 pts**, 30 done / 125 |
| 5 | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` | §4 D2–D8, §5.1–5.3, §6.2 |

Git: branch `feature/qds-story-review-remaining-v5-stories`, six commits off `dev`.
Also open: **PR #238** (`fix/run-lock-nul-bytes` → `dev`), unmerged.

---

## 3. Where the campaign got to

| Wave | Findings | Character |
|---|---|---|
| Scan (0–4) | **135** | citation accuracy — wrong paths, symbols, line numbers |
| Verify (5) | **125** | citations *right*, **semantics false** — cited code never runs on a real run |
| **Verify (6)** | **?** | ← your job |

**Headline, unchanged by anything since: no shipped code contradicts the ADR.** All 260 findings are
spec-side drift against ADR-consistent code. The in-box restoration arc built what it was told to.

**The category shift between waves is the campaign's most useful result.** Wave 5's verifier B put
it exactly: citations verified accurate to an unusual degree (~40 checked, one off-by-one), yet
*every* BLOCKER was "the cited code doesn't do on a real run what the story assumes" — hop-5's audit
emitters have no non-test callers; `reap` never fires on a healthy run; `unitActivity` returns
`inactive` for a box in the dispatch→run window. **A pass that re-checks line numbers finds none of
it.** Brief your verifiers to trace call paths.

**A fix wave can be wrong in the same category as the defect it replaces.** DF3.6a's spend ceiling
was derived wrongly *twice*. Do not assume a fixed finding is fixed.

---

## 4. Wave 6 — what to run

Five verifiers, **fresh agents**, none briefed with any fix recipe. Suggested pairing (contract-based,
so writer↔reader drift lands in one agent's context):

| Agent | Owns | Contract |
|---|---|---|
| A | DF3.7 + DF3.8 | 3.7 writes the in-box completion marker; 3.8 polls it host-side |
| B | DF5.3 + DF5.4 | 5.3 emits audit links; 5.4's gate asserts them; shared `ChainReport` wire format |
| C | DF3.6a + DF3.6b | split pair; a = spend/iteration bounds, b = cgroup memory bound |
| D | DF6.1a + DF6.1b | split pair, `attemptSha` seam; autonomous fix loop against a real PR |
| E | DF5.5 + DF2.11 + DF2.12 + **DF2.13** | the repoint chore + the four newest stories |

Brief each to: read the ADR **including both appendices**; read the shipped code for every seam named
(open it, don't trust the spec's description); apply the drift rule (**shipped code wins unless the
code contradicts the ADR** → then BLOCKER + candidate ADR amendment, never spec'd around); hunt
cross-story contract drift, internal contradictions, unfalsifiable ACs, and **split integrity** for
the two split pairs (content *orphaned* — described by one half, owned by neither — is a named defect
class here); and run an **artifact-consistency sweep** (story header vs `sprint-status.yaml`: sprint
tag, points, status, deps — a tag disagreed with the yaml for eight days because nobody checked).

Use GitNexus over grep: `mcp__gitnexus__query` / `context` / `impact`. Index rebuilt at `fa7d0e2`
**with embeddings** — see §7.

---

## 5. SEALED — do not brief your verifiers with this

The DF6.1 author self-identified two spots where it judged an unbriefed reviewer more reliable than
itself. **They were deliberately withheld from Wave 5 and must stay withheld from Wave 6.** They are
a calibration test *of the verification*, and briefing them destroys the measurement.

1. **`commentsDigest` is defined post-redaction**, so changing `redactSecrets` makes every historical
   digest unreproducible.
2. **DF6.1a AC1's locality negative control** asserts the control without specifying how a test
   *proves* locality — structurally the same gap that let the tier-2 deviation survive seven review
   rounds.

Both are already stated in the story text, so a verifier reading the file can find them.
**If Wave 6 finds them independently → the verification is real and its other findings carry weight.
If it misses them → raise them yourself, and weight Wave 6's clean bill accordingly.**

---

## 6. Reading the result — the call you have to make

- **Converged** → findings are marginal: wording, redundant assertions, tightenings. Dev can start.
- **Not converged** → a *third* structural class appears. Then the answer is **not** a fourth patch
  round. Say so plainly and recommend rethinking the specs.

This repo's history (DF3.4: 10 rounds; DF5.2: 18; the v4 campaign: 8) says more rounds is normal.
**Normal and converging are not the same thing.** Judge the category, not the count.

One caveat the outgoing session would apply to itself: this campaign found the same ADR-arc drift in
**four separate artifacts**, and each time it looked like the last one. Weight a single quiet round
accordingly.

---

## 7. Parent-owned queue (do these yourself; do not delegate)

1. **PR #238 is OPEN, not merged.** Until it lands, `scripts/lib/run-lock.ts` still reports
   `file: data` on `dev` and grep returns nothing against it. DF2.11 carries an unverifiable
   `ponytail:` marker claim pending that merge (owner: whoever merges #238).
2. **N7 (MEDIUM):** `tests/fleet/e2e/tier2-dispatch-engine.live.test.ts:397` cites
   `cost-ledger.ts:753` for `ingestCostEvent`; it is `:961`. Same file carries three `tokensRowsGap`
   live-tier assertions that go stale silently if DF2.12 lands without a live round.
3. **MEDIUM:** `dispatch.ts:2548-2576` documents "dispatch never passes `keyCapMicroUsd`" as an
   unfired upgrade trigger. It **fired** at `:2454` (DF3.2), so the `no-ceiling` arm at `:2577` is
   reachable and its unreachability argument for stranding a reservation no longer holds.
4. Off-by-one run-lock citations in DF3.8 `:79` and DF3.7 `:128`.
5. **Add DF2.13's section to the epics index** (`_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md`).
   The index was resynced this session — it had been at 31 stories / 123 pts and missing the entire
   in-box restoration arc — but DF2.13 was authored after that pass.
6. **A CI consistency check.** This campaign found the same ADR-arc drift in `sprint-status.yaml`,
   the story files, the epics index, **and a merged story**. That is not four mistakes; it is one
   missing mechanism. Propose it as a story **once convergence is established, not before.**

---

## 8. Rulings already made — do not re-litigate

| Ruling | Decision |
|---|---|
| Drift rule | Shipped code wins **unless the code contradicts the ADR** → BLOCKER + PROPOSED amendment |
| ADR amendments | Appendices A + B **ACCEPTED** and written |
| RSS mechanism | cgroup v2 `MemoryMax` under `Delegate=memory`; **no sampler retained, even for telemetry** (`memory.peak` is a kernel high-water mark). Direct cgroup-fs write, **not** `systemd-run --scope` (the engine is `User=exedev` in a *system* unit; `--scope` needs polkit it cannot get non-interactively and would fail **silently at run time on a box**) |
| DF5.1's ceiling | **Stays open.** Its re-verify runs host-side on a possibly-darwin machine; cgroups are Linux-only. Two problems, two kernels |
| Fix-scope | Deny-list stays **broad** (a false deny costs one escalation; a false allow lets an agent edit the file that would have caught it). **Nothing in the fix scope may include any artifact that participates in verifying the fix** — `scripts/**` contains `scripts/reverify.ts`. Terminal states split: `out-of-scope-diff` (agent error, charges) vs `scope-requires-privilege` (correct refusal, charges zero, escalates) |
| Spend chain | Middle term **re-homed** to the mint-time `capMicroUsd`, not invented. DF2.13 adds the missing **upper bound** |
| Code follow-ups | Land as planned stories, not drive-by patches |

---

## 9. Durable patterns this campaign produced

- **Self-proving greps.** Any "grep returns zero matches" assertion pairs with a **positive control
  on the same file** — one pattern that MUST match. Control fails ⇒ report **unproven**, never
  **clean**. (Adopted after two raw NUL bytes made grep silently return nothing for every pattern
  while two stories asserted over that exact file. Also defends against a moved file, wrong path,
  wrong flags, wrong cwd.)
- **Amend, never silently rewrite.** ADR appendices, register amendments, story corrections all
  record what was there and why it changed. Struck-through, not deleted.
- **Delete an illustration rather than update it.** A count sitting beside its own authoritative
  source can only go stale — that is *why* the epics index needed fixing.
- **Orphaned work between two stories is a defect class.** Described by both, owned by neither,
  green in both DoDs. Check it wherever an edit is handed across a story boundary.

---

## 10. What you are NOT inheriting

Eleven agents die with the outgoing session. Their *reasoning* was deliberately written into the
story text — the standard the DF6.1 author set: *"if a fix only makes sense with my scan report open,
it's a weak fix."* The arbitration history, rulings and parent-error log are in the tracker. The
findings are in the evidence directory.

**Five times a subagent overruled the parent and was right.** Expect your agents to do the same.
When one pushes back with evidence, check the evidence — do not defend the instruction.
