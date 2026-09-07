# PR 123 Review Round 11 — Triage Ledger

31 agents (9 blind source, 9 edge source, 12 test, 1 auditor). Raw findings: raw/*.md.
Verification rule: line numbers diff-relative for blind agents — fixers MUST locate in current main source first; a finding already fixed by post-merge work (df3-2/round-10) = report as [POST-MERGE-CHANGED], no patch.
User directive: fix ALL severities incl LOW. Decision-needed → fail-safe/conservative option + surface in final report.

## POST-MERGE-CHANGED (already fixed on main — verify, then dismiss; list in PR comment)
- dispatch.ts: hex ≥40 run-id echo; refuse() non-string teardownCommand/debugCommands; gate.ready truthy; gate.assertions null elements; phantom ports claim (onAbandonedFailure); httpsUrl one-shot write loss (in-catch repair); roster capped read; recordExists null; driver.ts address()/setRecord mid-sequence/legacy-grammar/displayName; cost-ledger orphan-guard recordStructurallyAbsent + slug column trim; fake-gate assertions-array/negative-exit/.env-dir; run-lock own-pid realpath proof, clock-skew clamp, env trim, self-kill dead-letter, release-rm error, empty-lock wording; fleet.ts F5 teardown wedge, EPIPE failOnEpipe, embedded log sink, argv echo caps; status.ts requestId/closedAt sanitize, safeDiagnostic, https-only safeUrl, abandoned list catch, shape guard, sanitizeLabel off-by-one, sortInstants/localeCompare. Source refs in raw/r2-edge-dispatch-b.md, r2b-edge-*.md.

## CLUSTER F — src/fleet/dispatch.ts + src/fleet/status.ts + verbs.ts (fleet-core)
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| F1 | MEDIUM | invalid-brief payload leaf (attacker field name) unescaped — redact-only, not escapeText | r1-blind-dispatch-a |
| F2 | MEDIUM | clock read `now() - wallStart` outside try/catch in refuse + logAbandoned → uncaughtException via deadline setTimeout | r1-blind-dispatch-a |
| F3 | LOW | unbounded issues array echo in invalid-brief payload | r1-blind-dispatch-a |
| F4 | LOW | URL_IN_TEXT_RE swallows trailing punctuation → whole-URL over-redaction | r1-blind-dispatch-a |
| F5 | LOW | assertFleetRunId blanket catch mislabels programmer error as operator invalid-run-id | r1-blind-dispatch-a |
| F6 | LOW | runIdEcho non-string arm unbounded+unredacted (live, dispatch.ts:198-202) | r1-blind-dispatch-a + r2b-edge-dispatch-a |
| F7 | HIGH | cross-process fleet-ceiling TOCTOU — in-process closed (singleFlight), cross-process open, self-documented deferral to quota-layer | r1-blind-dispatch-b |
| F8 | MEDIUM | shared-runId race loser double-books issue-cap reservation, no retirement | r1-blind-dispatch-b |
| F9 | MEDIUM | over-mint: key live at provider figure above admitted ceiling, manifest clamped only — self-documented | r1-blind-dispatch-b |
| F10 | LOW | expose non-string main path TypeError instead of expose-no-url refusal (dispatch.ts:2639 live) | r1-blind-dispatch-b + r2b-edge-dispatch-a |
| F11 | LOW | blanket FleetError rethrow arms assume refusal already logged | r1-blind-dispatch-b |
| F12 | LOW | pathless-EEXIST misclassified run-id-in-use (do-not-retry) | r1-blind-dispatch-b |
| F13 | LOW | hardcoded "(256 KiB)" beside ROSTER_MAX_BYTES drifts if constant changes | r1-blind-dispatch-b |
| F14 | LOW | empty-array debugCommands suppresses fallback status command (dispatch.ts:911-913 live) | r2b-edge-dispatch-a |
| F15 | LOW | listTimeoutMs > 2^31-1 inverts to ~immediate timeout (status.ts:210-221 live; dispatch.ts guards this class) | r2b-edge-fleet-rest |
| F16 | LOW | unbounded skipped-filename join in run-not-found remediation (status.ts:751 live) | r2b-edge-fleet-rest |
| F17 | MEDIUM | runId provenance shape-only — auditor F1: process-local minted-id registry in mintRunId() closes it | r1b-auditor |

## CLUSTER C — scripts/fleet.ts (CLI)
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| C1 | HIGH | --brief refused when stdin pipe/socket (every programmatic caller) — allow-list fixed false-allow, kept false-refuse | r1-blind-fleetcli |
| C2 | MEDIUM | dispatch never takes per-run lock; harvest/teardown can destroy box mid key-mint (key-unattributable window) | r1-blind-fleetcli |
| C3 | MEDIUM | runtime fs errors → exit 1 transient forever-retry (report untyped branch never passes asUsage errno table) | r1-blind-fleetcli |
| C4 | MEDIUM | corrupt run record in harvest/teardown → untyped transient envelope; status wraps same as record-read-failed | r2b-edge-fleetcli |
| C5 | MEDIUM | harvest/teardown chmod a named --dir 0700 before exit-4 probe (status uses create:false) — auditor F3 residual | r2b-edge-fleetcli + r1b-auditor |
| C6 | HIGH | SIGHUP kills dispatch mid-provision with no envelope/guidance (ssh drop) — handlers only SIGINT/SIGTERM | r2b-edge-fleetcli |
| C7 | MEDIUM | interrupted harvest/teardown logs no CC-9 structured line (every-verb-logs contract) | r2b-edge-fleetcli |
| C8 | LOW | `fleet help <garbage>` bypasses all argv validation, exit 0 | r1-blind-fleetcli + r2b-edge-fleetcli |
| C9 | LOW | stdin brief read no timeout when parent never closes pipe (pre-provision hang) | r2b-edge-fleetcli |
| C10 | LOW | skippedRecords payload unbounded/unredacted echo | r1-blind-fleetcli (verify main) |
| C11 | LOW | help emit outside try on both help paths → raw stack on ENOSPC | r1-blind-fleetcli (verify main) |
| C12 | LOW | -h + --help alias pair evades duplicate-flag guard | r1-blind-fleetcli (verify main) |
| C13 | LOW | 130/143 stamped exitStatus "logic" in CC-9 line contradicting header | r1-blind-fleetcli (verify main) |

## CLUSTER L — scripts/lib/run-lock.ts + scripts/lib/cost-ledger-opts.ts
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| L1 | MEDIUM | signal unwind releases all locks before re-raise proven lethal (survived-signal double-teardown) | r1-blind-cli-lib (verify main: dead-letter half fixed) |
| L2 | MEDIUM | failed release permanently unretryable; retry reports success no-op (held.delete before completion) | r1-blind-cli-lib (verify main) |
| L3 | MEDIUM | host-blind cleanStaleTemps (run-record ctor sweep) rmSync's remote run-lock claim temp → victim linkSync ENOENT raw | r2-edge-cli-lib LIVE |
| L4 | LOW | fsyncDir closeSync unguarded in finally (run-lock.ts:161) | r2-edge-cli-lib LIVE |
| L5 | HIGH | ledger relocation orphans existing accounting for non-default store dirs (no migration of old sibling ledger) | r1-blind-cli-lib (verify main) |
| L6 | MEDIUM | per-store-dir cap split, one shared config — N dirs × cap admitted, no dispatch-time warning | r1-blind-cli-lib |
| L7 | LOW | hostTag folding collisions re-enable remote-temp reaping accident | r1-blind-cli-lib |
| L8 | LOW | dual module instance defeats reentrancy guard + pid-is-ours proof | r1-blind-cli-lib |
| L9 | LOW | unreadable lock renders identically to empty in operator output | r1-blind-cli-lib |
| L10 | LOW | full directory readdir scan on every acquire | r1-blind-cli-lib |

## CLUSTER K — src/providers/cost-ledger.ts + step-log.ts + fake-gate.ts
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| K1 | MEDIUM | retirement window: closed-record retirement re-grants headroom; late teardown ingest (>360s) lands over-cap | r1-blind-prov-cost (verify main) |
| K2 | MEDIUM | timedLoggedStep dereferences err.code on null rejection (credentials.ts timed got (e ?? {}), this sink didn't) | r1-blind-prov-cost (verify main) |
| K3 | MEDIUM | fake-gate pipeline.yaml unreadable classified non-substrate; .env identical condition substrate — inconsistent | r1-blind-prov-cost (verify main) |
| K4 | MEDIUM | reaper sweep predicate widened: tag sole discriminator for non-generated names → destroy strangers' qds-sbx-tagged boxes (reaper.ts:422 via isFactoryOwnedVm) | r2b-edge-prov-cost LIVE |
| K5 | LOW | "# 42" trim-then-strip folds to " 42" distinct identity | r1-blind-prov-cost |
| K6 | LOW | malformed issue ids (42x, -1) mint unnameable full-cap identities | r1-blind-prov-cost |
| K7 | LOW | JS toLowerCase (Unicode) vs SQLite lower() (ASCII) slug fold divergence | r2b-edge-prov-cost LIVE |
| K8 | LOW | ingest paths surface raw untyped driver errors (no ledgerBusyError taxonomy) | r2b-edge-prov-cost LIVE |
| K9 | LOW | same-tick distinct events collapse via digest conflict | r2b-edge-prov-cost LIVE |
| K10 | LOW | capForIssue throws on perIssueOverrides:null (in-code arm regressed) | r1-blind-prov-cost (verify main) |
| K11 | LOW | SUBSTRATE_MARK free-text forgery reclassifies manifest failure retryable | r1-blind-prov-cost |
| K12 | LOW | runId unescaped into operator-run debug/teardown command strings (fake-gate) | r2b-edge-prov-cost LIVE |

## CLUSTER R — src/providers/run-record.ts
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| R1 | MEDIUM | hung creator dual-owns id via rename-aside tombstone clear; record bytes land in swept .tomb temp | r1b-blind-prov-record |
| R2 | MEDIUM | releaseLock rename catch treats every errno as already-gone → self-held lock wedges store forever | r1b-blind-prov-record |
| R3 | MEDIUM | live sibling's lock stolen after 60s hold → overlapping setLocked drops field (INV-4 failure) | r1b-blind-prov-record |
| R4 | MEDIUM | wall-clock olderThan sweeps live in-flight state on NTP step/pause | r1b-blind-prov-record |
| R5 | MEDIUM | whole-directory list() refusal on single newer-schema record — fleet-wide reap/status outage (only listWithAnomalies callers escape) | r1b-blind-prov-record |
| R6 | MEDIUM | extensions.budget repoSlug/issueId shape-exemption persists >40-char secret-bearing slug indefinitely | r1b-blind-prov-record |
| R7 | MEDIUM | ownerless lock body wedges record permanently — no grace/corpse bound (run-record.ts:1330) | r2b-edge-prov-record LIVE |
| R8 | MEDIUM | truncated (non-zero) create crash artifact unrecoverable + bricks list() for whole dir | r2b-edge-prov-record LIVE |
| R9 | LOW | clearCreateTombstone restore failure leaves live bytes under sweepable name | r2b-edge-prov-record |
| R10 | LOW | fsyncDir closeSync unguarded (run-record.ts:1835) | r2b-edge-prov-record |
| R11 | LOW | createUnlogged bare rmSync cleanup error replaces real write error | r1b-blind-prov-record |
| R12 | LOW | parkAside orphans never reaped | r1b-blind-prov-record |
| R13 | LOW | fsync not platform-probed while link is | r1b-blind-prov-record |
| R14 | LOW | contradictory docstrings on id supply | r1b-blind-prov-record |

## CLUSTER D — src/providers/driver.ts + fake-driver.ts + exedev/* + quota.ts + reaper.ts
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| D1 | HIGH | reap verb hard-fails on ANY unclaimed grammar-conforming box incl. strangers' — reap never succeeds on exedev while debris exists | r1-blind-prov-drivers (verify main) |
| D2 | MEDIUM | budget-write rollback failure swallowed with zero signal (driver.ts:557-565 empty catch, no code/remediation) | r2-edge-prov-drivers LIVE |
| D3 | MEDIUM | headroom gate reads lossy list(); skipped rows undercount population → admits over quota (quota.ts:211) | r2-edge-prov-drivers + r1-blind-prov-drivers LIVE |
| D4 | MEDIUM | RUN_ID_SHAPE grammar duplicated — silent drift kills all reaping | r1-blind-prov-drivers |
| D5 | MEDIUM | destructive rmSync rollback gated on message-prefix string match (isRecordLockTimeout) — silent drift → deletes live writer's record | r1-blind-prov-drivers |
| D6 | MEDIUM | FakeDriver listing drops 63-char hostname cap (mock drift / changed anomaly behavior) | r1-blind-prov-drivers (verify main) |
| D7 | LOW | partial-destroy results lost when mid-sweep destroy throws | r2-edge-prov-drivers |
| D8 | LOW | reapRuns destroy loop no per-call budget (hung driver hangs sweep) | r2-edge-prov-drivers |
| D9 | LOW | roster stat-then-read TOCTOU + bare fs errors escape gate contract (setup-gate.ts:154-161) | r2-edge-prov-drivers |
| D10 | LOW | non-string requestId crashes gate instead of documented fallback (setup-gate.ts:224) | r2-edge-prov-drivers |
| D11 | LOW | FakeDriver error shapes drift from driver contract (raw fs errors, no code/remediation) | r2-edge-prov-drivers |
| D12 | LOW | anomaly strings stringify full row before truncation (event-loop block) | r2-edge-prov-drivers + r1-blind-prov-drivers |
| D13 | LOW | list_excluded_foreign_name logs unredacted provider free text | r2-edge-prov-drivers + r1-blind-prov-drivers |
| D14 | LOW | actionTimeoutMs accepted unvalidated (0/negative/NaN → immediate timeout) | r2-edge-prov-drivers |
| D15 | LOW | neverPublicDriver wrapper drops listWithAnomalies | r2-edge-prov-drivers |
| D16 | LOW | unreachable guard in destroy loop reads load-bearing | r1-blind-prov-drivers |

## CLUSTER E — scripts/pipeline-run.ts + phase-engine/* + qds-cost.ts
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| E1 | HIGH | stale-witness fallback spawns above admitted ceiling (undeclared-limit branch) — comment justification false for admissions < $0.50 | r2-edge-engine + r1-blind-engine (dup merged) LIVE |
| E2 | MEDIUM | unreadable witness (EACCES lstat) misclassified "vanished" → uncapped run instead of refuse (fail-open) | r2-edge-engine LIVE |
| E3 | MEDIUM | >30min fill-to-read gap hard-refuses every stamped dispatch (availability cliff; ledger reservation stays open) | r2-edge-engine |
| E4 | MEDIUM | case canonicalization strands pre-existing mixed-case ledger rows — retroactive cap reset (no migration/case-insensitive query) | r1-blind-engine (verify main) |
| E5 | LOW | duplicate --dir silently last-wins (qds-cost) | r2-edge-engine |
| E6 | LOW | empty QDS_RUNS_DIR resolves money files off cwd | r2-edge-engine |
| E7 | LOW | async stderr write before process.exit drops warning | r2-edge-engine |
| E8 | LOW | FileJournal left unclosed on cap-reconciliation refusal | r1-blind-engine |
| E9 | LOW | manifest "stamp did not land" guard unreachable, comment premise wrong | r1-blind-engine |

## CLUSTER T1 — tests/fleet (cli.test.ts, verbs.test.ts, dispatch.test.ts)
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| T1-1 | MEDIUM | wall-clock race barrier no proof racers reached it (cli.test.ts:2436) — pair-barrier seam pattern exists (63531aa) | r3-t-cli-b |
| T1-2 | MEDIUM | excused-code tripwire accepts any toBe(N) token (verbs.test.ts:1102) | r3-t-verbs-a |
| T1-3 | MEDIUM | cross-verb flag sweep hardcoded 3-flag list, stale vs fanout/rank flags (verbs.test.ts:1540) | r3b-t-verbs-b |
| T1-4 | MEDIUM | statusRun orphan skippedRecords arm untested (status.ts:730) | r3b-t-verbs-b |
| T1-5 | MEDIUM | timer-audit refusal arm swallows unexpected success (dispatch.test.ts:3284) | r3b-t-dispatch-b |
| T1-6 | MEDIUM | no test hangs the GATE step (longest await in dispatch) | r3b-t-dispatch-b |
| T1-7 | MEDIUM | headroom-failure refusal line under-asserted (toHaveLength(1) only) | r3b-t-dispatch-b |
| T1-8 | LOW | post-gate dispatch-timeout omits refusal-line + ledger-close checks | r3b-t-dispatch-b |
| T1-9 | LOW | harvest "completed" never verified (exit-6 test) | r3-t-cli-b |
| T1-10 | LOW | box-destroy asserted via runId not vmName | r3-t-cli-b |
| T1-11 | LOW | listener-count test adds no kill power | r3-t-cli-b |
| T1-12 | LOW | synthetic exit-codes pinned by bare toContain("7") | r3-t-verbs-a |
| T1-13 | LOW | test name overclaims "never looks for a roster" | r3-t-dispatch-a |
| T1-14 | LOW | ceiling-ARMED assertion piggybacks port re-sample | r3-t-dispatch-a |
| T1-15 | LOW | e2e teardown ack read from merged sink | r3-t-cli-a |
| T1-16 | LOW | within() losing promise unhandled | r3-t-cli-a |
| T1-17 | LOW | assertFleetRunId redaction units never reach downstream sinks | r3-t-dispatch-c |
| T1-18 | LOW | headroom failure provoked via injectable half not production trigger | r3-t-dispatch-c |

## CLUSTER T2 — tests/providers + tests/scripts
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| T2-1 | MEDIUM | 1.0s margin on 360s expiry boundary = flake vector (cost-ledger.test.ts:1247) → ±10s | r3-t-prov-a |
| T2-2 | MEDIUM | keep-in-URL + deep-link arm ordering never composed (step-log.test.ts) | r3-t-prov-b |
| T2-3 | MEDIUM | skippedReasons parallel-array alignment only exercised at index 0 | r3-t-prov-b |
| T2-4 | MEDIUM | lock-release-failed path untested after rewrite (sandbox-teardown-cli.test.ts:979) | r3-t-script |
| T2-5 | HIGH | driver-contract reap branch tolerant per driver — destroy arm proven only on fake (driver-contract.test.ts:239-265) | r3b-t-prov-c |
| T2-6 | MEDIUM | dead "silently spared" assertion branch unreachable (driver-contract.test.ts:257) | r3b-t-prov-c |
| T2-7 | MEDIUM | destroyed-not-contains skipped when refusal fires (driver-contract.test.ts:174) | r3b-t-prov-c |
| T2-8 | MEDIUM | budget-gate zero-creates assertions self-fulfilling via helper ordering | r3b-t-prov-c |
| T2-9 | LOW | 7/15 SECRET_PREFIXES rows unpinned (test.each available) | r3-t-prov-b |
| T2-10 | LOW | root vacuous pass: silent return instead of visible skip | r3-t-prov-b |
| T2-11 | LOW | stderr monkeypatch restored only via finally (kill leaks) | r3-t-prov-b |
| T2-12 | LOW | source-regex SQL NULL-safety pin = change-detector noise | r3-t-prov-a |
| T2-13 | LOW | "concurrent" TOCTOU tests sequential, serialization claim carried by one probe | r3-t-prov-a |
| T2-14 | LOW | append-side concurrency never exercised | r3-t-prov-a |
| T2-15 | LOW | stale test name references removed createRun path | r3b-t-prov-c |

## CLUSTER T3 — tests/phase-engine + visualizer
| ID | Sev | Finding | Source |
|----|-----|---------|--------|
| T3-1 | MEDIUM | source-regex test pins layout not behavior (pipeline-run.test.ts:1012) | r3-t-engine-viz |
| T3-2 | LOW | S28 freshness window value unpinned | r3-t-engine-viz |
| T3-3 | LOW | static-branch auth gate only missing-credential arm tested | r3-t-engine-viz |
| T3-4 | LOW | real dist/ fixture leak on hard kill | r3-t-engine-viz |
| T3-5 | LOW | doubled /** comment opener (auth.test.ts:711) | r3-t-engine-viz |
| T3-6 | LOW | brief-schema: bare .toThrow() overclaims; prototype-pollution unfalsifiable; wrong-type coverage gaps | r3b-t-fleet-bs |
