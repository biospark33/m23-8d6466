# M3.2 round 0 — driver self-review (qds-dev Phase 5 sub-agent, bugs-only triage)
Date: 2026-10-11 · Scope: full branch diff vs dev · Reviewer: m32-selfreview (sonnet)

| # | Sev | Cat | Where | Finding | Disposition |
|---|-----|-----|-------|---------|-------------|
| 1 | MED | LOGIC | scripts/memory-weekly.ts:376 | exit-2 envelopes never printed (0 bytes on config refusal) — silent crontab no-op under redirect | FIXED: stderr envelope on code 2 + spawned no-env test asserting stderr JSON config-refusal |
| 2 | MED? | EDGE | weekly-reflect.ts:279 | fresh-empty bank: reflect insights[] fails client min(1) safeParse → REFLECT_UNPARSEABLE, banksOk=0, red run | DOCUMENTED (kept): honest red — M1.2 retain flow + M3.1 consolidate guarantee non-empty banks before weekly ever fires; client schema frozen (M1.1-owned), not widened. Posture comment added at REFLECT_UNPARSEABLE |
| 3 | LOW | DESIGN | weekly-reflect.ts:188 | retry byte-identity depends on reflect determinism; drift ⇒ PROPOSAL_DIVERGENT | WONTFIX-by-design: alarm-not-silent is the story's C7 posture; documented in header |
| 4 | LOW | EDGE | weekly-reflect.ts:229 | superseded lacks stamp ordering (later-stamp ids can be marked superseded) | FIXED: strictly-earlier stamps only + out-of-order re-fire test |
| 5 | LOW | INVARIANT | weekly-reflect.test.ts:294 | fence omits gate/ writer paths; raw-port scan covers 3 entry files not full closure | FIXED: WRITER_PATHS+SPECIFIER add boundary-anchored gate/ (src/gate = frozen gate machinery); port scan now closure-wide (client.ts exempt as M1.1-owned forward client — its absence asserted-and-corrected: presence is M2.1 architecture, default neutralized by fail-closed HINDSIGHT_BASE_URL) |
| 6 | LOW | LOGIC | compose.ts:169-205 | rationale/suggested_change embed names without safeName severity filter | FIXED: embed() = safeName-or-redacted at every prose site + hostile-name test |
| 7 | LOW | EDGE | compose.ts:41,191 | status:"ok" records can seed a "failure class" skill-update | FIXED: SUCCESS_CLASS_RE filter + ok-records-compose-nothing test |
| 8 | LOW | EDGE | store write race | overlapping same-firedAt fires last-writer-wins | WONTFIX: weekly cadence + firedAt is a pinned seam; documented |
| 9 | LOW | EDGE | header crontab line | shell opens redirect before job mkdir on fresh host | FIXED: header note — provisioning must create .sandbox/proposals/ (0700) |

Clean: PROPOSE ceiling (no writer reachable), store discipline (wx 0600/fsync/rename, byte-compare), env fail-closed order, token hygiene, budget placement, transitive fence walk, checksum exclusion, genuine spawn e2e.
