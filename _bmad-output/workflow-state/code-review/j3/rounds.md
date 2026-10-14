# J3 bmad-code-review rounds — findings, triage, dispositions

Round 1 (4 layers: blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor): 23 findings
→ 19 patched (fix waves A/B/C + driver), 1 false (roster-warnings flatten — parseRoster:397 derives
warnings from roles itself; applyTierOverride mirrors the producer), 3 DAR notes. Details in git
history of this branch's test/source diffs; highlights: headless workKey→runId, write-side schema
guard, corrupt-line scrub, hook wall cap, roster-drift carry guard + absent-roster fold, capped
re-reads, log store-rooted at dirname(store.dir), QDS_JUDGMENT_PROVENANCE_DIR env override (the
QDS_AUDIT_DB idiom), wiring structural pins with teeth, retain logDir, readRoutingLog
{runId-needle, parse cap}, deriveRoutingContext exported + fold coverage, RISK_LIFT_THRESHOLD named,
.judge( fence assertion, dispatch-level concurrency test, cli/q1/skill-contract probe rooting.

Round 2 (same 4 layers on the post-fix diff): blind 14 / edge 7 / verify 3 / accept 4 findings.
Patched (waves D/E/F + driver): schema_version on the log line; readRoutingLog byte ceiling +
tail-keeping cap; carry reuses the guard's parse (single parse); over-ceiling at carry folds
(routing-roster-over-ceiling) instead of refusing a provisioned run; existsSync→statSync TOCTOU
folded; routingOptions.logDir honored (was dead); ROUTING_HOOK_WALL_MS 60s→300s with corrected
derivation (cap must sit above the ask's own 2×30s+Retry-After chain so a slow ask folds INSIDE
runRouting and the line still lands — only a true wedge reaches the cap); wall-cap sync-throw
prints the note; deriveRoutingContext roster read capped + Number.isFinite spend guard;
brief_path_mentions scans the whole brief (slice removed — the cap lives in FEATURE_CAPS
saturation); TIER_QUESTION prose derived from TIER_TABLE; fixture shape vocabulary fixed;
skill-contract chdir try/finally; q1 tmpdir cleanup; cli env-branch assertion;
deriveRoutingContext brief-mentions + spend assertions; wall-cap-through-hook test.

DEFERRED (recorded): retain leg's 10s wall cap untested (needs a wall-const seam; the untested twin
retainRunOutcomeBestEffort is the house norm; bounded by HindsightClient's own HTTP budget).

## Sanctioned interpretations (Dev Agent Record notes)
1. **routing-skip house line**: carries a FRESH non-Jev requestId (LogEntry requires the field;
   the JEV envelope id is what is absent — no ask, no envelope, no Jev id) and, on ask-skips, the
   enumerated jev reason (grep-friendly); the contract's `features-unavailable` reason exists as
   the stderr routingHouseError code. M3.2's consumer reads the .sandbox LINE (jev_skipped), not
   the house log.
2. **Lock-timeout line drop**: after 2×5s the line is lost with one loud house error; appending
   without the lock is the named torn-line bug class and is never done. Enumerated loss path.
3. **Wall-cap line drop (r2)**: with the cap at 300s (> the ask's own worst chain), the cap firing
   means runRouting is wedged outside the ask; the drop is loud (stderr + throw). Same class as 2.
4. **Applied-vs-folded semantics**: the .sandbox line records the PICKED tier at hook time; a later
   carry fold never rewrites it (append-only). Application is evidenced by the carry artifacts
   (gate copy, .qds/roster.yaml, repointed spec.roster) and the carry-skip house lines carry the
   runId; M3.2 joins on those.
5. **Files outside Files-to-Modify** (sanctioned): tests/judgment/fence.test.ts (allowed-set
   amendment, AC2's lock idiom needs the src/lib lock), tests/phase-engine/roster-override.test.ts
   (new — AC4's unit home), tests/fleet/cli.test.ts + q1-contract.test.ts + skill-contract.test.ts
   (necessitated fallout of arming the production hook: fixtures + probe rooting), and
   tests/fleet/fleet-routing-retain.test.ts (new — the retain suite lives beside the harness it
   reuses; the story's Trigger Surface named tests/judgment/router.test.ts for retain coverage;
   coverage relocated, not duplicated).
6. **Retain leg mirrors M1.2's helper rather than importing it**: the run-outcome builder is
   run-record-shaped; J3's payload is a different shape. The substrate upsert, family-signature
   bank resolution, and receipt posture ARE consumed; the scaffolding (env gate, wall cap, guarded
   lines) is copied per the house's cycle-avoidance rule (retain-best-effort.ts header).
7. **One-active-roster assumption**: dispatch's model is one ACTIVE roster beside the manifest (the
   gate pre-check reads exactly that file). The carry repoints dispatch_task phases naming THAT
   roster; phases naming other roster files are left untouched (r2 accept finding resolved by the
   conditional repoint).
