# 2026-08-31 df-inbox-arc planning session (DF2.10/DF1.10/DF1.11/DF3.7/DF3.8)

user: Resume DF1.10 planning at Phase 2 per df1-10-a HANDOFF; operator flagged a significant deviation from the original plan during DF3 dev, strongly leaning original intention; demanded a deep multi-angle dive (git, memory, substrate) before proceeding.

assistant: Ran three parallel forensic Explore agents (design-intent, git-trace, feasibility) + own memory trace. Findings that reversed the prior session's decision:
- design-intent: D4/§5.1 committed resident+engine IN-BOX (operator's explicit decision; code-only tier 2 declined by user); "placement is flexible" had zero textual support; option-1's R9 argument inverted the doctrine (R9 pairs in-box gates with DF5.1 host re-verify); HANDOFF falsification criterion F1 fired.
- git-trace: deviation was SILENT — DF3.3's spec said in-box in 3 places, shipped host-side Bun.spawn, zero deviation-ledger entry across 7 review rounds; every later acknowledgement worded as stopgap owed to DF1.10; never ratified at any gate.
- feasibility: "in-box impossible" premise substantially UNMEASURED — bun never probed (the "verified live T1.1 bun" memory record was a FABRICATED CITATION; F1 measured node only); /run-tmpfs-wipe never measured; exe.dev supports --image/--setup-script and the driver just never passes them.
Operator ruled: restore original in-box design, probe first, no interim transport work.

assistant: Live probe (qds-probe-boxenv, ~$0.000025, box destroyed, key revoked): systemd IS PID 1 with enabled units restarting at boot; bun absent but installs in seconds and persists; /run/steering wiped by real reboot (first measurement — #180 premise); pi is a compiled ELF (resolves pi-without-node paradox; precedent for compiled engine); pi 0.84.4 answered a real OpenRouter solicitation in 2.17s (no stall). All falsification gates cleared. ADR written+merged (PR #182), HANDOFF §3 superseded, #180/#181 amendment comments posted.

assistant: qds-sprint-planning run df-inbox-arc-a: Phase 1 = 5 parallel researchers (R6 image, R7 engine relocation, R8 steering, R9 gate bridge, R10 deps/wrapup) writing reports to workflow-state, returning paths only. Load-bearing corrections FROM RESEARCH: R7 — production fill clones the CUSTOMER repo (engine delivery net-new); R9 — the engine NEVER called the approval gate (gate runs post-teardown via reverify; DF3.7 reshaped to run-completion signal); R8 — with engine in-box, #181 needs almost no new steering code (localSteeringInbox was the right implementation on the wrong machine); R10 — DF1.10-renumbering collision pinned by a test; supervision fold; INV-IBOX ranges; land-#182-first branch strategy.

assistant: Phase 2 = 2 writers x 2 stories; Phase 2.5 audit (0 BLOCK, 1 WARN); Phase 3 = 4 per-story adversarial pipelines (0 HIGH final, 52+ fixes; DF3.7 pipeline surfaced the host-disconnect arc gap) + cross-story pass (10-item queue). Operator chartered DF3.8 (watcher) at the review gate to close the host-disconnect gap; DF3.8 pipeline required two one-clause DF3.7 amendments (INV-IBOX-16 second-caller; reaper stale-record→teardown witness-less collection) — applied by orchestrator. Wrap-up: 3 commits (DF3.4 drift, DF6.2 drift, arc), totals 37 stories/151 pts, S3 capacity warning 25→56, PR #183.

## Learnings worth extracting
- research-sources: forensic triple (design-doc verbatim audit + git timeline + substrate feasibility) caught a fabricated memory citation and an inverted doctrine that a single research pass had missed. Probe-before-charter converted 4 folklore facts into measurements for ~30 min box time.
- wave-strategy: writers consumed only report PATHS; orchestrator context stayed lean across 20+ agents.
- sprint-planning: a planning artifact almost ratified an unapproved architecture deviation retroactively (option 1). Deviation-vs-design checks belong in story review, not only code review.
- story-estimation: relocation stories (engine in-box) size at 8 SP ceiling; steering rode down from "new transport" to 5 SP once placement was fixed at the root.
- agent-allocation: per-story pipeline subagents + one cross-story pass converged in ≤3 iterations each; DF3.8's pipeline correctly demanded amendments to a FINAL sibling rather than editing it silently.
