<!-- Split out of review-round-7.md so a directory listing shows every round. Content unchanged. -->

# DF3.6b — code review round 9 — CodeRabbit's Major on attribution, and the correction it forced

**Date:** 2026-09-19 · One finding, accepted; its two proposed remedies verified unavailable; and it
exposed a false claim round 7's report had made.

**The finding.** "A graceful own-limit allocation failure can increment `oom` and leave
`memory.peak` near the bound without killing pi. If a later global OOM kills pi, `oom_kill` also
increments because it counts kills by any OOM killer. All three factors then pass, although
`memory.max` did not kill the process. Classify this state as ambiguous, or add an attribution
signal." **Correct, and it identifies a state the peak floor was claimed to close.**

**What two independent kernel-source reviews established:**

1. **The two states are byte-identical in every readable file.** Both terminate as `oom>=1,
   `oom_kill>=1`, `oom_group_kill>=1`, `peak≈bound`, `current≈0`. `memory.events.local` equals
   `memory.events` on a childless leaf (`memcg_memory_event()` propagates UPWARD only), and
   `oom_group_kill` is credited by `mem_cgroup_get_oom_group()` to the highest ancestor setting
   `oom.group` — which for a global OOM, with no ancestor setting it, is still this leaf. So
   **"classify as ambiguous" is not implementable**: there is no field whose value differs, and the
   classification would swallow every true kill and destroy AC1.
2. **The peak floor never discriminated anything here.** `oom > 0` means the failing charge was
   about to cross the limit; that charge is never added to `memory.current`; `memory.peak` is
   monotonic and never reset (reset API is 6.11+). So `oom > 0` **implies** `peak >= bound - slack`.
   The narrowing was always done by `oom`, which excludes the plain global victim. **This report's
   round-7 follow-up finding 1 claimed the third fact "closes it"; that was wrong**, and the wrong
   version reached the story, the code comment and a PR comment before it was caught.
3. **The one true attribution signal exists and is not reachable.** `mem_cgroup_print_oom_context()`
   logs `oom_memcg=<path>` for a memcg-limit kill versus `global_oom` for a global one. Unreachable
   for `User=exedev`: `CAP_SYSLOG` is required under `kernel.dmesg_restrict=1` (Debian/Ubuntu
   default — the node's permissive mode bits mislead; the capability check is what refuses), and
   journald ACLs the kernel journal to groups a service user is not in. Buying it costs an ambient
   capability plus a log-parsing and time-correlation path, to remove a residual whose cost is a
   mislabel. A `poll()` watcher on `memory.events` was also rejected: kernfs notifications coalesce
   when the reader has not drained, so on a thrashing box — the only condition where this arises —
   it wakes with both counters already moved and reports a true kill, failing hardest in the case it
   exists to catch.

**Blast radius, traced through the code rather than assumed.** A false positive writes
`status:"stopped"` / `exitStatus:"overflow"` / one `watchdog_kill` row and stops the spawn; a false
negative writes `status:"degraded"`, no row, and the run-down refresh fills `exitStatus` from the
process probe as `"transient"`. **Both are terminal for the resident** — the status gate is
`telemetry.status !== "active"` and nothing after construction ever writes `"active"` back, so
`"degraded"` ends participation exactly as `"stopped"` does. Neither moves a phase, a gate, a budget
or the exit code. The difference is evidentiary, and the cost falls on D4's demotion count. A false
negative is not evidence-free either: the fleet `resident_cgroup` line still carries `rssPeakBytes`,
`residentRssBytes` and `oomKilled:false` on fd-2.

**Two facts that make the residual acceptable rather than merely tolerated.** `oomKilled` is a
LABEL, never a control — it gates no allocation and admits no unbounded call, so a mislabel costs
reporting accuracy and not containment; and in the residual state `oom >= 1` is TRUE and
unforgeable, so the row is over-specific rather than fabricated. Stopping the resident is the
correct action for the fact that IS proven; only the identity of the final killer is not.

**The remedy would also cost more than the residual.** To be worth anything an "ambiguous" state has
to be journal-readable, which means widening two closed unions neither owned by this story —
`ResidentStatus` (DF3.3's AC5 forbids a fourth value) and `ResidentTripwire["cause"]` (DF3.6a's) —
and at the gate it still resolves to one of the two existing dispositions. It adds a name, not
information.

**Disposition: finding ACCEPTED, remedies DECLINED with reasons, residual recorded as ruling 9.**
The peak conjunct is kept — it is free, it catches a self-contradictory reading, and it stops being
implied the moment the leaf gains children with smaller limits. The comment and the story now call
it a consistency check rather than the discriminator, and state the residual precisely: a global OOM
that kills a resident whose leaf had **already registered its own `oom` event and survived it**. The
precondition is narrower than "a resident near its bound", and that distinction is stated so the
residual's reach is not overread.
