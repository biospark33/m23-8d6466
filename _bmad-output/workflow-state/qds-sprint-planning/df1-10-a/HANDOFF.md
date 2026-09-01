# HANDOFF — DF1.10 story authoring (qds-sprint-planning run, paused at Phase 1→2 gate)

Paste target: a fresh Claude Code session in `/Users/steve/QDS-Factory` (branch `dev`).
This document is the complete state of the investigation. Read it fully before acting.

---

## 0. THE TASK

Author **ONE** new story — **DF1.10 "In-Box Steering Executor + Channel Lifecycle"** — via the
`qds-sprint-planning` skill (canonical definition: `.claude/commands/skill`
`.claude/commands/skills/qds-sprint-planning.md`; reference resources: `.claude/skills/qds-sprint-planning/`).

- Output story file: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-10-in-box-steering-executor.md`
- Branch convention: `feature/` prefix, base `dev`, target `dev` (per CLAUDE.md)
- **Spec only — no code in the planning run**
- Skill workflow position: **Phase 0 done, Phase 1 done (5 research reports on disk),
  architecture fork decided (option 1, see §3) — Phase 2 writer NOT yet spawned.**
- Remaining gates: Story Review (non-skippable), Commit Confirmation (non-skippable).
- Operator standard: full enterprise-grade rigor, no shortcuts, no bandaids; apply
  `/ponytail` discipline (root-cause over symptom, fewest moving parts, no speculative machinery).

Workflow-state dir: `_bmad-output/workflow-state/qds-sprint-planning/df1-10-a/`
(research/ has R1–R5; HANDOFF.md is this file; verdicts/ will hold Phase 3 outputs).

---

## 1. BACKSTORY — where DF1.10 came from (verified via git + memory)

**DF1.10 was NOT in the original plan.** The 2026-08-11 Dark Factory v5 derivation
(`docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`,
`2026-08-11-dark-factory-v5-architecture-design.md` §8) contains zero mentions. DF1's original
slate = 8 stories (DF1.1–DF1.6, DF1.8, DF1.9 — numbering skips 7; no 10). Sprint-status header:
31 stories / 123 pts.

**It was born mid-DF3.4 on 2026-08-28** (commit `c5ebde3`, "feat(fleet): DF3.4 tier-1 pre-PR
approval gate + attach steering"). DF3.4's own research discovered its spec assumed an
**in-box engine that does not exist**:

- `scripts/pipeline-run-remote.ts:5-19` carries the honest label: "the box image carries no
  bun/node, so `pipeline-run.ts` cannot run in-box … orchestrated FROM THE HOST. HONEST LABEL:
  this is NOT the in-box executor (**proposed story DF1.10**)". The name was coined here — as a
  placeholder for a premise gap, not a chartered story.
- **Same commit contains the counter-finding.** `W3C_DEVIATION_load_bearing`: "THE ENGINE NEEDS
  NO DRIVER. This dissolves the in-box-engine premise gap rather than working around it —
  **no DF1.10 required**." Evidence: zero driver/vm references at the pipeline-run wiring site;
  precedent `journal.ts:197-210` writes run markers with plain host-side fs.
  **The sprint record is therefore torn**: one finding says DF1.10 is dissolved by design;
  the close-out issues say DF1.10 owns the seam. §5 of this handoff resolves the tear; the story
  must carry that resolution as an ADR-grade disposition.

**Then reality landed (2026-08-30/31):**

- `789be54` extended the live e2e suite onto DF3.4 (T1.8 attach transport, T5.1 full gate chain).
  On a real exe.dev box, `fleet attach` **always** exits 6 `no-ack` — and that was recorded as the
  HONEST PASS shape, because faking the engine leg to get an ack violates the no-fakes rule
  (memory obs #99441: "Production Has No In-Box Phase Executor — fleet attach Ack Is Honestly
  Impossible").
- `377f576` provisioned the steering channel at box birth (`/run` is unwritable to the exec user).
- Rounds 8 (`47afa33`) and 10 (`6522d91`) of bmad-code-review hardened the transport and, at
  round-10 close-out, recorded **Deviation 12** (memory obs #100303): AC6's attach→fold→ack round
  trip cannot close on the shipped substrate — `fleet attach` appends to the BOX's
  `/run/steering/inbox.ndjson` while the engine drains a HOST-local inbox. Two filesystems, no
  mount between them. **Issues #180 and #181 were filed naming DF1.10 as owner.**
- PR #150 (DF3.4) **merged into dev 2026-08-31T19:41:26Z** (verified via gh). Note: the
  sprint-status.yaml DF3.4 line still says `status: review` — drift, third instance of this
  pattern; also DF6.2 has a merged story file (PR #136) with no yaml line, and the header tally
  (23/93) is stale (real count 25/103 before DF1.10).

**Why now:** the seam degrades the live-e2e story every day it stays open — T1.8 must keep
asserting `attach-not-acked`/`no-ack` as PASS, i.e. the shipped substrate cannot prove the
round trip DF3.4's AC6 promised.

---

## 1.5 THE DESIGN-VS-SHIPPED MAP (operator's 3-tier model — verified 2026-08-31)

Operator's understanding, CONFIRMED as the original design intent:
- Design doc `2026-08-11-dark-factory-v5-architecture-design.md` Decision register:
  **D2** "Three-tier orchestration: local Claude Code cockpit → sandbox fleet → in-box
  execution." **D3** tier 1 = cockpit + code fleet dispatcher (outside sandboxes). **D4**
  tier 2 = "resident orchestrator agent **per sandbox**, operating a deterministic TS phase
  engine" (§5 diagram line ~324 draws it inside the sandbox tier). **D5** tier 3 = pi teams
  via `team-lead-driver.ts` (the agents the resident controls).
- D4's tripwires (F7): any of {resident token spend >15% p50, agent bypassed/reordered a
  gate, §5.2 watchdog kills the same steering loop twice} → demote tier 2 to code-only
  dispatch. The design doc treats the resident's PLACEMENT as flexible; the invariant is the
  deterministic engine.

SHIPPED reality (measured; DF3.3/DF3.4):
| Tier | Design | Shipped |
|---|---|---|
| 1 cockpit + dispatcher | host | host ✓ |
| 2 sandbox + resident + engine | resident+engine INSIDE sandbox | sandbox ✓; brain is NOT in-box — resident = host-side `Bun.spawn` of pi (`src/fleet/resident.ts` ≈:448, `QDS_PI_BIN --provider openrouter --mode json --no-tools`); engine = host-side `scripts/pipeline-run.ts`. Box cannot run either: no bun/node, no supervisor |
| 3 pi teams (agents) | in-box | in-box ✓ (`QDS_TEAM_RUNNER`, workers spawn on box) |

The resident exists (one per run, cheap model, three steering solicitation points) but is a
HOST process steering OVER the `driver.exec` transport. DF3.4/DF3.6 specs silently assumed the
original picture; DF3.4's research honest-labeled the gap and pivoted ("host-side engine +
driver.exec transport is exactly what the injected-port design assumes"). DF3.6's "manifest
load inside the box" clause (df3-6 story ≈:105-112) is the same wrong assumption, still
unfixed in its spec — flag to operator, do NOT fix in DF1.10.

**DF1.10's place on this fault line:** option 1 (transport-backed port impl) codifies the
host-side brain as deliberate and puts CHANNEL STATE in-box; the `createSteering(deps)` port
keeps a future full tier-2-as-designed migration (engine in-box) cheap — swap the port
implementation, callers unchanged. The literal daemon would have been a partial step toward
the original placement with none of its payoff (resident still host-side → mere relay). The
FULL original design (engine in-box) is a separate multi-story arc (compiled/portable engine,
image changes, supervision) — explicitly NOT DF1.10.

---

## 2. THE TWO ISSUES DF1.10 CLOSES

**#181 (HIGH) — AC6 in-box ack round trip (Deviation 12).**
`fleet attach <id>` writes the BOX's `/run/steering/inbox.ndjson` via SSH exec; the phase-engine
steering leg drains a HOST-local inbox (`localSteeringInbox`, wired `scripts/pipeline-run.ts`
≈:1816-1836). The "message reaches the tier-2 resident agent and is acked" round trip cannot
close. Issue's own closing shape (verbatim): *"resident consumes /run/steering/inbox.ndjson
on-box and writes /run/steering/acks.ndjson; engine leg reads/writes through the transport
instead of the host file; then a live test can pin the full attach → fold → ack loop on real
infrastructure."*

**#180 (MED) — steering channel lost on VM reboot.**
Channel provisioned once at box birth (`create()` → `sudo install -d /run/steering`,
`src/providers/exedev/driver.ts` ≈:87-92). `/run` is tmpfs — reboot remounts and silently wipes
it; a resident box regresses to `attach` `send-failed` for life with no convergence mechanism.
Suggested shape: on first `send-failed` per box, re-run idempotent provisioning + verify chain
before reporting fault; count re-provisions in telemetry so a reboot loop is visible.

---

## 3. THE DECIDED ARCHITECTURE — ⚠️ SUPERSEDED 2026-08-31 ⚠️

> **This section is RESCINDED.** The confidence pass was run as a three-agent forensic
> audit (design-intent, git-trace, feasibility) plus a live box-environment probe.
> Falsification criterion **F1 fired** (the design doc DOES commit to in-box tier-2 —
> §1.5's "placement is flexible" claim has no textual basis) and the substrate premises
> ("no bun", "no supervisor", "/run wipe") were found unmeasured or false (systemd is
> PID 1; bun installs in seconds; `--image`/`--setup-script` exist on our plan).
> The operator ruled: **restore the original in-box design** via a staged arc.
> Authoritative record: `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`;
> evidence: `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json`.
> The text below is preserved verbatim as part of the decision record.

### (superseded) option 1 — ratified by operator, pending confidence pass

**Decision: transport-backed port implementation. NO in-box daemon.**

"Executor" is redefined honestly: the executor of steering ingestion **against the in-box
channel** — it runs where the engine runs (host), and every read/write crosses the `driver.exec`
transport so channel state lives in exactly ONE place: the box's `/run/steering/`. Scope:

1. **TransportSteeringInbox** — the injected `SteeringInbox` port's real implementation:
   drain/tail over `driver.exec` (box-relative paths — `copyFile` refuses absolute box paths,
   DF3.4 Deviation 4), ack append via exec (APPEND_SCRIPT-shaped, stdin payload), dedupe seed
   reads the box ack tail over the transport (today `readSteeringAckedIds` reads the host-local
   file — must move).
2. **Engine leg rewired** — `localSteeringInbox` retired; the `createSteering` call site in
   `pipeline-run.ts` receives the transport impl.
3. **Channel lifecycle (#180)** — idempotent re-provision on first send-failed (reuse
   `provisionSteeringChannel`'s script — it is private + birth-only today, `driver.ts`
   ≈:275,284,308) + verify chain + re-provision telemetry counter (journal resident block is a
   CLOSED key set — counters go to trace/driver-emit sidecar, not the journal block).
4. **Live e2e inversion** — attach → fold → ack pinned on a real box; `attach-acked` becomes
   the PASS shape; the "honest no-ack" fixtures (tier1:31-39, tier5:18-28) retire; exit-6
   `no-ack` becomes a genuine failure.
5. **ADR-grade disposition** — resolve the W3C-finding-vs-Deviation-12-vs-#181-wording tear
   (§5); prepare an amendment comment for #181 (issue author = operator).

**Rationale (the load-bearing chain):**

- **The fold — the only thing that matters — is host-side regardless.** The resident is a
  host-side `Bun.spawn` (`src/fleet/resident.ts` ≈:448). An in-box process would be a relay
  between two files feeding a host consumer: two consumers of one channel, split-brain ack
  semantics (consumption-time vs engine-observed), one more artifact to ship/version, zero new
  capability.
- **No supervision exists in-box.** No systemd, no bun/node, pidfiles die with tmpfs, pi
  extensions only live while pi lives. A daemon that dies silently mid-run recreates exactly
  the "regresses for life with no convergence mechanism" failure #180 complains about, one
  level down. #180's own complaint indicts the daemon option.
- **R9 doctrine already answers trust:** in-box evidence = claims, not proof; host re-verify
  owns truth (design doc R9/F10). Parsing in-box instead of host-side buys no trust property —
  engine is the trust anchor either way.
- **The port seam exists for exactly this.** `src/phase-engine/steering.ts` takes the inbox as
  an injected port on `createSteering(deps)` and may not import fleet code (module boundary,
  `steering.ts:12-13`). DF3.4 shipped the socket; only the implementation is missing. One
  implementation at the port, all callers route through it.
- **#181's own closing-shape sentence describes option 1** ("engine leg reads/writes through
  the transport instead of the host file; then a live test can pin the full attach → fold → ack
  loop on real infrastructure"). The "resident consumes on-box" clause encodes the same wrong
  assumption DF3.4's spec made (in-box resident) — measured false (see §4).
- **Long-term optionality preserved:** if the sprint later moves the resident in-box (design
  doc's tier-3 "in-box execution" end-state, D2), the port absorbs it — swap the implementation,
  callers unchanged. Nothing is foreclosed.

**Falsification criteria — what would flip this to the literal in-box daemon:**

- (F1) The design doc commits to an in-box resident as a NEAR-TERM end-state with a concrete
  supervision plan (not the vague tier-3 aspiration). → re-open.
- (F2) A real in-box supervisor exists on the exe.dev box image (systemd/init/supervisord).
  → re-open. (R4 measured the image: POSIX sh, python3, curl, git, pi — no bun/node, exit 127.
  Verify no init system.)
- (F3) Correctness requires the fold to happen in-box (e.g., a doctrine change where in-box
  ack must be consumption-time to count). Today it does not — DF3.4's ack-provenance machinery
  is engine-side by design.
- (F4) #181's author rejects the amendment reading on re-read. → escalate to operator.

**Confidence pass owed before Phase 2 (the "be more sure" items — run these as a focused
verification sweep, ideally one read-only deep-dive agent per SPL-020):**

- (V1) Read `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.2/§6
  + D2/D4/R9 IN FULL and confirm tier-3 "in-box execution" is aspiration, not committed
  near-term plan, and that the deterministic-engine-owns-gates doctrine (D4) is as summarized.
- (V2) Confirm from the box image definition / driver scripts that no init/supervisor exists
  (R4 measured the live box; re-verify from source artifacts, not just runtime probes).
- (V3) Verify the `createSteering(deps)` port shape + module boundary still match
  (`steering.ts:12-13` no-fleet-imports rule) and that a driver-backed inbox can be injected
  at the `pipeline-run.ts` call site without a layering violation (steering.ts cannot import
  fleet code — the impl must live fleet-side and be passed in; confirm the composition root
  has a driver in scope there — W3C finding claimed zero driver refs at that site; if true,
  the wiring must thread the driver THROUGH, which is a real Files-to-Modify line, not a
  hand-wave).
- (V4) Confirm ack-semantics choice: engine-observed-write acks (engine appends ack over
  transport after folding) vs consumption-time acks (in-box consumer writes). Check DF3.4's
  ack-provenance counter semantics and the no-double-delivery property (retries mint fresh
  messageIds — a re-send after a landed-but-unacked line double-delivers today; the transport
  impl + dedupe seed must close that hole, and the story must say how).
- (V5) Draft the #181 amendment comment text (issue author = operator biospark33) and the
  story's ADR disposition; confirm #180's trigger set (first send-failed per box) is the right
  re-provision trigger vs (also) drain-side healing.

If V1–V5 all confirm option 1 → proceed to Phase 2 without re-asking the operator (decision is
ratified). If any falsification criterion fires → STOP and escalate with evidence.

---

## 4. RESEARCH STATE — five reports on disk (read them; do not re-derive)

Dir: `_bmad-output/workflow-state/qds-sprint-planning/df1-10-a/research/`
Confidence ≈ 0.9 (code-measured, live-box-measured, contradictions surfaced). Crosswalk agent
NOT triggered (SPL-025: no "surviving verbatim" audit table in scope).

**R1-story-template.md — story FORMAT (authoritative for the writer):**
- 12-section skeleton: `# DFn.m: Title` + exactly two header fields (`**Story Points:**`,
  `**Sprint:** v5-S2 (band note)`) — NO Status/Dependencies header fields; then Spec Reference,
  User Story, Overview, E2E Slice, Acceptance Criteria, Trigger Surface, Infra Prerequisites,
  Technical Notes, Observability Contract, Files to Modify, Security Invariants, Definition of
  Done, Dev Agent Record (placeholder only).
- **No `_bmad-output/epics.md` exists** (0 of 32 DF stories reference one). `sprint-status.yaml`
  is the index; its `:104` comment makes the story's Sprint header authoritative.
- Observability Contract section REQUIRED (31/31 DF stories carry it — overrides the generic
  skill's "12-Factor Track A" section). DoD = exactly 10 high-signal boxes, ending with
  `**Test (e2e demo — MANDATORY):**` (31/32 stories).
- Spec Reference = Shape B (issue/code citations), modeled on df6-2:5-11 — cite #181, #180,
  `pipeline-run-remote.ts:5-19`, `src/phase-engine/steering.ts`, DF2.1 `driver.exec`, DF3.3's
  three solicitation points, DF3.4 Deviation 12 + round-8/10 follow-ups.
- AC style: decimal 1–7; AC1 `**(make-or-break …)**`; sub-arms `**(a)/(a2)/(b)/(c)**` with
  `<br />`; italic negative controls ending "MUST fail this one". Invariant namespace:
  `INV-IBOX-N` (CRED/BND/APPROVE/RES/RV/POLICY taken; IBOX free).
- E2E Slice = three bold lead-ins (`Demonstrable behavior:` / `Wiring closed:` with the verbatim
  "No stub, no `TODO: wire later`" / `Dependency edges (predecessors):`) + optional
  `**Not an edge —**` blockquote (right place to exclude `ExeDevDriver.exec` changes — CRITICAL
  blast radius, round-8 deferred).
- Writer budget **≤185 normative lines** (SPL-027); the four exemplar stories ran 246–376 and
  were BLOCKed >250 then operator-overridden — do NOT repeat that; hit the budget.
- Live-E2E culture encodes as: mandatory DoD checkbox + no-channel-double negative-control
  clause (df3-4:159-171). Stories never promise a tier.

**R2-steering-spec.md — normative contract:**
- 30 clauses C1–C30 from #180/#181, DF3.4 story (envelope `{messageId, requestId, runId,
  message, sentAt}`; exec-only transport; 0700 dir / 0600 files; 30s ack ceiling; read caps),
  design doc (R9/F10), DF3.3 (three solicitation points, INV-RES-*), DF3.6 (bounds).
- Inherited invariants: INV-APPROVE-1..9, INV-RES-1..5, DF3.6's three bounds, plus round-10
  findings behaving as de-facto invariants (AT1s ack-read exit-3 `unreachable` semantics, AT3s
  acks-file mutual exclusion, S1 ownRunId always-on cross-run filter, S2/S4, P2).
- 10 AC seeds incl. the make-or-break live TIER-2 `attach-acked` + re-pointing the two honest
  no-ack PASS shapes. Non-goals: DF3.6 bounds work, approval-gate surface, ledger keys.
- 10 candidate ACs listed in the report; contradictions flagged per clause.

**R3-code-surface.md — the seam map (file:line for everything):**
- Deciding fact: the two legs run on different machines. Attach writes the BOX's inbox
  (`src/fleet/attach.ts` ≈:430-580, exec + stdin); the only consumer `localSteeringInbox`
  (≈attach.ts:658-764) is host-local fs wired at `scripts/pipeline-run.ts` ≈:1816-1836; box
  cannot run it (`pipeline-run-remote.ts:6-7`).
- Gaps: no transport-backed SteeringInbox impl; no on-box executor (prior art `startVisualizer`
  `driver.ts` ≈:1110-1160 needs bun; only in-box pi precedent is hand-rolled sh, tier5:328); no
  box-side lock primitive (acks.lock is host pid-file based); **no re-provision path**
  (`provisionSteeringChannel` private, birth-only, driver.ts ≈:275,284,308); no re-provision
  telemetry (only `emit("steering_provision")` at birth).
- Landmines the story must guard: live e2e PASS shapes pin no-ack/exit-6 and must invert;
  `telemetry.status` is a one-way latch (degraded never reverts; drain deliberately runs before
  the gate); retries mint fresh `messageId`s (double-delivery); `send-failed` may have landed
  the line already; `copyFile` refuses absolute box paths (Deviation 4); journal resident block
  is a closed key set (new counters → trace/driver-emit sidecar).
- Exact envelope/ack/provision script text, all mode bits (0700 dir, 0600 files), every
  ceiling/timer constant, and the test-coverage hole (no test proves a box-written message is
  folded+acked on that same box).

**R4-inbox-runtime.md — substrate facts + options table:**
- Live box measured: POSIX sh, python3, curl, git, pi. **No bun/node (exit 127).** `/run` is
  root-owned tmpfs; channel exists only via sudo at create; wiped by any reboot.
- pi extension option rejected: extensions run only while a pi process runs; nothing keeps pi
  alive in-box; plus measured pi 0.84.x stall family.
- Closest "runs over time" precedent is the T3.5 host-driven shim (`pipeline-run-remote.ts`) —
  explicitly NOT the in-box executor.
- Recommendation = option (d) transport-backed host-driven inbox. Sharpest open question =
  literal-vs-sufficient reading of #181 (resolved in §3/§5) + ack-truth location (dedupe seed
  must read the box tail over transport).

**R5-dependency-wrapup.md — deps, sprint math, wrap-up surface:**
- **Deps: `[DF2.2, DF3.1, DF3.3, DF3.4]`** — all merged, zero open predecessors.
  DF1.1 excluded (engine touch is at DF3.3's port, same as DF3.4 did); DF2.1 excluded +
  keep-out (closed run record — telemetry rides DF3.3's journal block); DF3.6 kept OUT
  (different component/test surface; record as telemetry boundary note, not an edge).
- **Tag: `v5-S2`** late/unslotted addition (DF6.2 form + DF1.8 precedent). S3-capacity flip
  recorded as cheap — no edge moves.
- **SP: 5** — three disjoint file clusters (on-box→transport executor, driver re-provision,
  engine-leg rewiring) + mandatory live round trip > DF3.3's 4; no new contract/authz surface
  < DF3.4's 6.
- Wrap-up = exactly 5 artifacts: (1) story file; (2) `sprint-status.yaml` — 5 edits (new story
  line in repo format; `df1.points` 32→37; header totals 32/128 + S2=55/S3=25; atomicity-audit
  pointer; header note); (3) `sprint-status-history.md` drain+append; (4) NEW
  `dark-factory-v5/atomicity-audit-2026-08-31.md` in the 2026-08-20 report format;
  (5) NO spec-doc entries (closed records, no per-story index), NO CLAUDE.md edit (no status
  line exists). Exact proposed yaml line: R5 report §6.
- Branch `feature/df1-10-in-box-steering-executor`, base/target `dev`; PR title
  `DF1.10: …`; commits `feat(df1-10): …`.
- Drive-by drift to surface at wrap-up (operator-visible, not silent): DF3.4 yaml still
  `review` though PR #150 merged into dev 2026-08-31T19:41:26Z; DF6.2 missing yaml line;
  header tally stale (23/93 vs real 25/103).

---

## 5. RESOLUTION OF THE TORN RECORD (the ADR disposition the story must carry)

Three positions exist in the sprint record:
1. `W3C_DEVIATION_load_bearing` (c5ebde3): "THE ENGINE NEEDS NO DRIVER … no DF1.10 required."
2. Deviation 12 / #181: DF1.10 owns the round trip; worded as an on-box consumer.
3. The measured substrate (R3/R4): resident host-side, no bun/node, no supervisor, /run tmpfs.

**Resolution adopted:** Position 1 was right about the architecture (engine needs no driver
*for its journal/markers*) and wrong about the consequence — Deviation 12's host-local drain
left the PORT without a real implementation, so the round trip genuinely does not close and
DF1.10 is needed. Position 2's substance (close the round trip through the transport; live e2e
pins it) is adopted; its letter ("resident consumes on-box") is corrected — the resident has
been host-side since DF3.3 (`Bun.spawn`), and the design doc's D4 doctrine makes the engine,
not any in-box process, the deterministic trust anchor. DF1.10 therefore delivers the
transport-backed port implementation and records this three-way reconciliation as an in-story
ADR-grade deviation note, plus an amendment comment on #181 at dev time.

---

## 6. REMAINING WORKFLOW (in order)

1. **Confidence pass V1–V5** (§3) — read-only; fold any deltas into §3's decision. If a
   falsification criterion fires → STOP, escalate to operator with evidence.
2. **Phase 2** — spawn ONE writer agent (SPL-001: ≤2 stories/agent) with the five R-report
   PATHS + one-line abstracts (paths, not bodies — v1.4.0 token contract), the format rules
   (R1), the decided architecture (§3), deps/tag/SP (R5), and the dual-output requirement.
   NOTE: dual output = story file + a brief epic summary, but DF track has NO epics.md — the
   brief summary's consumer is the sprint-status.yaml story line (R5 §6 has the exact shape).
3. **Phase 2.5 atomicity audit** — mechanical greps + 8 checks
   (`.claude/skills/qds-sprint-planning/steps/phase-2-5-atomicity-audit.md`); report to
   `dark-factory-v5/atomicity-audit-2026-08-31.md`; HALT on BLOCK without operator override.
   Watch: title has one `+` connector (check 5 allows ≤1); normative size ≤200 (writer budget
   ≤185 leaves headroom); Security Invariants REQUIRED (story touches file handling, exec
   transport, capability-adjacent surfaces — keyword classes fire).
4. **Phase 3 step 0 adversarial pipeline** — one self-contained per-story pipeline subagent
   (`.claude/skills/qds-sprint-planning/steps/phase-3-wrap-up.md` §3.1a): loads domain
   checklists (expect: input-invariants; possibly auth/secrets — scan triggers), iterates
   review→fix→verify in its own context, Edits the story in place, converges at
   HIGH==0 AND MEDIUM≤3, **Writes its JSON verdict to
   `workflow-state/qds-sprint-planning/df1-10-a/verdicts/df1-10.json`** (SPL-026) BEFORE
   returning. Then ONE cross-story consistency agent (§3.1b) over story + sprint-status.yaml
   (verdicts/cross-story.json). Shared-pattern note (§3.0.5) grounded in greps of the story +
   DF3.4/DF3.3 story headers. Orchestrator aggregates by data only; HALT on surviving HIGH or
   MEDIUM>3 → disposition table to operator.
5. **Story Review gate (non-skippable)** — present the converged story to the operator.
6. **Wrap-up** — the 5 artifacts (R5 §2 list); include the drive-by drift corrections as
   operator-visible line items, not silent fixes.
7. **Commit Confirmation gate (non-skippable)** → branch `feature/df1-10-in-box-steering-executor`
   from `dev`, commit `feat(df1-10): write enterprise-grade story` (+ drift fixes as separate
   clearly-labeled commits if approved), push, PR → `dev` with the adversarial-review iteration
   log in the body.
8. **Save session transcript** to
   `.claude/learnings/qds-sprint-planning/transcripts/2026-08-31_HHMMSS_DF1-10-planning.md`.
9. Run the skill's Verification Rules (post-planning checks) and report results.

---

## 7. OPERATOR STANDING ORDERS

- Full enterprise-grade rigor. No shortcuts, no bandaids. Ponytail discipline applies: the
  lazy fix IS the root-cause fix — one implementation at the port, not a second consumer next
  to the first; skip speculative machinery (no daemon, no relay, no config surface); mark any
  deliberate simplification in the story explicitly.
- Never weaken an invariant to fit a budget; if budget vs rigor conflicts, split the story.
- The story must carry the ADR disposition (§5) and the falsification record (§3) — future
  readers must be able to re-open the decision from the story text alone.
- Sprint-status.yaml edits are operator-visible; drift corrections (DF3.4 status, DF6.2 line,
  tally) need explicit approval, not silent rides.
