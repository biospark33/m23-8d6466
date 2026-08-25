# PR 123 review — triage ledger (review round 10, story df3-1)

Sources: 12 reviewer reports (`reports/*.md`). Normalized + deduped. Dismissals verified against source.
Baseline (pre-fix working tree): tsc clean, biome clean, focal suites 2077 pass / **2 pre-existing fails**:
1. `qds-cost CLI > full view … complete run` (env-sensitive)
2. `fleet-busy race refusal creates NO loser cost ledger (INV-2)` — **timeout @5000ms**, known parallel-load flake signature.
Neither attributable to review fixes; final gate compares against this baseline.

Decision-needed findings resolved FAIL-SAFE/CONSERVATIVE per operator pre-authorization (no halts):
- DA1: amend story AC2 wording (declare shape-only provenance deviation) instead of building a mint-registry subsystem.
- FM1: refuse ceiling RAISE on re-stamp (fail-closed) instead of allowing last-wins raise.
- FC1: align EPIPE-on-completion to exit 6 (matches existing ENOSPC/EBADF and dispatch-EPIPE doctrine).
Deferred items = documented tradeoffs/design-residuals; changing them was judged higher-risk than leaving them. Each carries its rationale inline.

## Legend
PATCH = fix this round · DEFER = real, not actionable now (rationale given) · DISMISS = false-positive/noise (verification noted)

## Cluster W1a — src/fleet/dispatch.ts
| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| DF1 | HIGH | blind | PATCH | Non-string `ctxGate.teardownCommand` crashes `refuse()` itself; retry-refuse crashes again → raw exit 1, total AC4 evidence loss. Fix at choke point: `typeof === "string"` guard mirroring `errorRemediation`. |
| DF2 | MED | blind+edge | PATCH | `refuse()` payload rebuilds `debugCommands`/`teardownCommand` from raw gate result — skips `escapeText` (newline forgery rides payload), `redactDeep` on truthy non-array ships scalar where `unknown[]` expected. Thread call-site-sanitized values or apply guards in `refuse`. |
| DF3 | MED | blind | PATCH | Gate assertion ELEMENTS unguarded: `{assertions:[null]}` throws in `.find/.map` → exit-3 downgraded to exit-1 `dispatch-failed`, evidence severed. Element filter/coercion at slice time. |
| DF4 | LOW | edge | PATCH | Truthy non-boolean `gate.ready` ("no", 1) passes gate — undefended seam field vs typed-unknown standard everywhere else. Strict boolean check. |
| DF5 | LOW | blind | PATCH | `recordExists` treats `null` absence-sentinel as "exists" → every mint bricks as `run-id-unmintable`. Accept undefined OR null as absent. |
| DF6 | LOW | blind | PATCH | Abandoned `expose` that later FAILS leaves phantom `ports:[port]` claim permanently (retraction exemption covers started-and-failed). Retract claim on abandoned-rejection. |
| DF7 | LOW | blind | PATCH | EEXIST→`run-id-in-use` hinges on exact `error.path === store.path(runId)` equality; representation mismatch misclassifies as provision-failed. Compare resolved forms. |
| DF8 | LOW | blind | DEFER | Shared-runId race: FleetError-arm stamps correlation onto winner's record. Race-on-race, narrow, documented; deferred-stamp redesign risks more than it fixes. |
| DF9 | LOW | blind | PATCH | `httpsUrl` store-write failure after ports claim → record has port without locator forever. Best-effort URL-write retry in catch before rethrow. |
| DF10 | LOW | blind | PATCH | `invalid-request-id` message interpolates `deps.requestId` via bare stringify without `escapeText` — the one third-party-shaped interpolation missing it. |
| DF11 | MED | edge | PATCH | Roster size check fstat-snapshot TOCTOU: concurrent append between fstat and readFileSync slurps unbounded bytes synchronously outside every deadline. Re-fstat after read / capped read; refuse if >ROSTER_MAX_BYTES. |
| DF12 | MED | edge | PATCH | Post-gate timeout refuses fully-proven run with generic "tear the run down" remediation — re-spend hazard the port branch already fixed for its case. When step==="post-gate", remediation says run is gate-proven; inspect/ack manually first. |
| DF13 | MED | edge | DEFER | maxVms admission lockless read TOCTOU (two dispatches overshoot ceiling). Documented in-code as deliberate; quota-layer intent reservation owed to DF2.6 scope. |
| DF14 | LOW | edge | DEFER | Shared-runId loser holds duplicate ceiling reservation until winner closes. Fail-safe direction (under-admission), zero production callers pass opts.runId today. |
| DF15 | LOW | edge | PATCH | `storeRunIdRefusal` ≥40-char branch overclaims "no full-length copy anywhere": hex-digest-exempt echoes survive. Apply `runIdEcho` unconditionally. |
| DF16 | LOW | edge | PATCH | `lateEffectRemediation` switch omits deliver/fill/clone/gate steps — late landings get generic advice while material may land in billable box. Add step-aware entries. |
| DF17 | LOW | edge | DISMISS | safeOrigin ≥16-char label over-redaction. Verified argued in-file as deliberate security-vs-cosmetics trade; over-redaction is the safe direction. |
| DF18 | LOW | edge | PATCH | Caller-supplied relative `deps.dispatchLogPath` used unresolved (cwd-dependent) — default path is resolve()d; apply same rule. |
| DF19 | LOW | edge | DEFER | Non-monotonic clock seam (NTP step aborts healthy dispatch; negative durations). Documented ponytail upgrade path (monotonic seam). |
| DF20 | INFO | edge | DISMISS | Dead exitCode-4 union member in dispatch — dispatch correctly never emits 4; no defect. |
| DA1 | MED | auditor | PATCH(story) | AC2 "caller-invented runId rejected" is shape-only at runtime (brand compile-time; regex runtime). Collision-guarded so exposure = squatting free ids. FAIL-SAFE resolution: amend story/integration-spec AC2 text with declared-deviation note (round-10 amendment), matching round-5 precedent; no mint-registry subsystem. |

## Cluster W1b — src/fleet/status.ts, src/fleet/brief-schema.ts
| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| FF1 | HIGH | blind | PATCH | `Promise.race` loser (wedged `driver.list()`) settles later unobserved → process-level unhandled rejection crash AFTER classification. Attach no-op `.catch` to losers (both listWithTimeout and retry attempt). |
| FF2 | HIGH | blind | DEFER | Brief can tie attacker-controlled repoUrl host to trusted slug (path-only refine) — code-execution-under-trusted-budget. Self-documented residual explicitly deferred to DF5.2 allowlist design; not fixable locally without inventing that design. |
| FF3 | MED | blind | PATCH | Raw substrate `box.name` interpolated into `record-read-failed` remediation (forged-log-line class); sibling orphanRow uses safeName. Route through safeName. |
| FF4 | MED | blind | PATCH | Sort tie-break uses `localeCompare` (locale-dependent row churn) though comparator's own comment bans it for timestamps. Code-unit `<`/`>` compare. |
| FF5 | MED | blind | PATCH | `safeUrl` drops userinfo but passes `javascript:`/`file:` schemes into clickable rows — outbound half of INV-CRED-1 missing scheme arm. Enforce https(s)-only. |
| FF6 | MED | blind | PATCH | `requestId`/`closedAt` copied unsanitized into rows while siblings sanitized ("parseability ≠ printability"). Sanitize both. |
| FF7 | MED | blind | DISMISS | repoSlug length bound — VERIFIED bounded: `REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/`. |
| FF8 | LOW | blind | PATCH | `sanitizeLabel` off-by-one: max-length input yields max+1 units (ellipsis appended after full slice). Slice to max−1 before appending. |
| FF9 | LOW | blind | PATCH | `statusAll` element-shape guard admits arrays (`typeof [] === "object"`) → garbage rows. Require plain object. |
| FF10 | LOW | blind | PATCH | Over-long valid ISO `createdAt` truncated with ellipsis → Date.parse NaN → sorts +Infinity among failure rows. Parse before/without truncation artifact. |
| FF11 | LOW | blind | DISMISS | Two fleet-level rows share `runId:"(fleet)"`. Cosmetic; states differ; reshaping output keys risks consumers/tests for zero behavioral gain. |
| FF12 | LOW | blind | PATCH | Store exception text embedded verbatim in `record-store-unreadable`/`record-read-failed` messages — producer-side sanitization doctrine applied everywhere else. Sanitize `$e.message`. |
| FF13 | LOW | blind | DEFER | Exit-code-6 semantic split (cleanup-after-success vs ack-unwritable) recorded unresolved in registry NOTE. Unifying = contract change across verbs; documented. |
| FF14 | LOW | blind | DEFER | Duplicate box name collapses last-wins in join Map. Self-documented ceiling with named upgrade path (substrate already broken addressing in that case). |
| FF15 | LOW | blind | DISMISS | `driver.list(name)` prefix-match fear — VERIFIED FakeDriver filters directory names exactly; contract is exact-match. |
| FF16 | LOW | blind | PATCH | `statusRun` interface doc reserves `skippedRecords` for readable-record-with-skips case; construction site only sets it ENOENT/orphan. Align behavior to doc (surface the caveat) or correct docstring — pick behavior-side if cheap. |

## Cluster W1c — scripts/fleet.ts
| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| FC1 | MED | blind | PATCH | EPIPE swallowed in `emit` → harvest/teardown completion line lost but exit 0. Same info-loss coded as 6 for ENOSPC/EBADF and for dispatch-ack EPIPE. BEHAVIOR CHANGE: classify completion-line EPIPE as 6 (flagged for wave-2 test updates). |
| FC2 | MED | blind | PATCH | `--help` on real verb logs CC-9 line indistinguishable from successful execution (dashboards count phantom teardown success). Add discriminating field (e.g. `help:true` / phase marker). |
| FC3 | MED | blind | PATCH | Refusal envelopes echo UNBOUNDED argv-derived strings (200 KB paste lands verbatim in stderr/log) while same file caps other sinks at 96 chars via `bounded()`. Bound every argv echo in envelopes. |
| FC4 | MED | blind | PATCH | `markRunLockDestructive` unguarded: partial mark write + released lock + exit-1-retry-me ⇒ wedged refusals forever. Mirror the guarded clear-side (exit 6 cleanup-failed). |
| FC5 | MED | blind | PATCH | `readBriefFile`/statSync classify transient errnos (EMFILE/ENFILE/EAGAIN) as permanent usage exit 2, bypassing the file's own RETRYABLE_ERRNOS doctrine. Route through it → exit 1 transient. |
| FC6 | MED | blind | DISMISS | status missing-record exit-4 gap — VERIFIED: `statusRun` raises `run-not-found` (status.ts:624); AC4 exit-4 mapping satisfied. |
| FC7 | LOW | blind | PATCH | `invalid-brief` embeds raw JSON.parse message unredacted — third foreign-text entry point past the two the module claims are all. redactSecrets+bound it. |
| FC8 | LOW | blind | PATCH | Legit U+FFFD in brief bypasses injected-reader byte-cap re-measure (presence-test conflates corrupt vs legit). Unconditional byte re-measure of decoded length. |
| FC9 | LOW | blind | PATCH | `-h --help` slips duplicate-bool guard (raw-string scan pre-normalization). Normalize aliases before dup-check. |
| FC10 | LOW | blind | PATCH | SIGINT mid-dispatch logs `runId:null` even after record persisted (await hasn't resolved). Additive `onMinted` hook (or equivalent) so handler reports minted id. |
| FC11 | LOW | blind | PATCH | `setLogSink` wired only under import.meta.main — embedders/tests calling run() get default sink, violating stderr-JSON-lines contract. Wire sink inside run(). |
| FC12 | LOW | blind | DEFER | records-skipped → exit 2 conflates corrupt-state with usage typo. Taxonomy redesign out of scope; payload already distinguishes; reasoning documented in-file. |
| FC13 | LOW | blind | PATCH(verify) | `parseValueFlags(..., {help:[HELP]})` passes HELP PROSE (renderHelp output!) into a token-list option. Inspect semantics: likely dead config (never matches) — remove or replace with the actual `"--help"` token; do NOT introduce process.exit behavior. |
| FC14 | LOW | blind | PATCH | No cross-verb flag-type-conflict check: flag boolean in one verb + valued in another lands in BOTH grammars. Add dev-time registry-build validation refusing conflicts. |

## Cluster W1d — scripts/lib/run-lock.ts, sandbox-teardown.ts, pipeline-run.ts, lib/cost-ledger-opts.ts, scripts/qds-cost.ts
| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| FR1 | MED | edge | PATCH | `releaseRunLock` success path unguarded `rmSync`: release already succeeded but EACCES/EIO reports `lock-release-failed` exit 1 (downgrades completed teardown) + permanent `.rescue` litter. Guard/swallow post-success errno; preserve failure semantics only when release genuinely incomplete. |
| FR2 | MED | edge | PATCH | sandbox-teardown lacks fleet's F5 closedAt-based auto-release: completed-close-then-throw wedges lock until manual rm (fleet exits 6 idempotent for identical state). Port F5 policy — module header demands no drift. |
| FR3 | MED | edge | PATCH | Self-pid "provably stale" unsound under dual path spellings (symlink/case-insensitive): `held.has(lock)` misses alias, pid===self marks LIVE lock stale and advises rm mid-destruction. realpath/inode identity check before treating self-pid as proof of death. |
| FR4 | MED | edge | PATCH | Malformed/unreadable cost-config blocks teardown of BILLING boxes; remediation doesn't mention `$QDS_COST_CONFIG_FILE` override. Name the override in remediation (fail-closed preserved; closedAt relief arrives via FR2). |
| FR5 | LOW | edge | DEFER | Default-layout trailing-segment heuristic answers "ends with /.sandbox/runs?" not "is default layout". Changing detection risks relocating existing ledgers — worse than documented imprecision. |
| FR6 | LOW | edge | PATCH | `envPath` rejects whitespace-only override but passes padded paths verbatim (ledger opens at literal-space filename). Trim returned value. |
| FR7 | LOW | edge | PATCH | "Refuse having touched NOTHING" comment false: constructor mkdir/chmod/probe/sweep happens first. Correct the comment; make chmod 0700 conditional (skip when perms already ≤0700) if trivially safe, else document. |
| FR8 | LOW | edge | PATCH | Throwing `out()` inside catch replaces real error, skips mapped exit (EPIPE-from-reporter destroys classification). Guard reporting writes (writeStderr-style) so original error survives. |
| FR9 | LOW | edge | DEFER | Same-condition diagnostics land on different streams/formats per exit path across CLIs. Cross-CLI observability refactor — out of scope. |
| FR10 | LOW | edge | PATCH | Future-dated lock bodies defeat implausible-hold hint for hours/days (age clamped 0). Clamp future timestamps beyond skew bound so hint fires; stay fail-closed. |
| FR11 | LOW | edge | PATCH | Failed signal re-raise latches `unwinding` forever → later Ctrl-C dead-lettered, unstoppable CLI. Reset latch when re-raise throws so next signal retries. |
| FR12 | LOW | edge | PATCH | Hostname-change stranded locks: foreign-host refusal lacks the aging/recycled-pid nudge same-host branch gets. Add held-Ns guidance text (behavior unchanged). |
| FR13 | LOW | edge | PATCH | Declared-cap path validates witness CONTENT before FRESHNESS (witness-only path orders correctly) — stale witness reported with wrong diagnosis. Reorder checks. |
| FR14 | LOW | edge | DEFER | Witness double-lstat TOCTOU between presence/staleness and content read. S28 temporal binding explicitly advisory; widening acknowledged residual. |
| FR15 | LOW | edge | PATCH | Empty-body refusal remediation fights itself in one sentence ("rm once holder unknown is gone" + walk-back). Dedicated empty-body wording; machine-readable flags untouched. |
| FP6 | LOW | blind | PATCH | qds-cost restates records-dir resolution chain instead of calling exported `resolveRunsDir` — split-brain risk the helper's docstring warns about. Call the helper. |
| FP7 | LOW | blind | PATCH | qds-cost existsSync→open race materializes EMPTY ledger → confident zero-spend report exit 0. Open read-only/no-create so race errors instead of lying. |
| FP11 | LOW | blind | PATCH | `--dir=` empty value accepted → empty base dir resolution. Refuse empty value at parse time like missing. |

## Cluster W1e — src/providers/cost-ledger.ts, run-record.ts, credentials.ts, reaper.ts
| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| FP1 | HIGH | blind | PATCH | admitIssue: transient record-read FAULT past grace window expires a LIVE run's reservation (drop from reservedMicroUsd) → concurrent dispatch granted full headroom on top of live exposure = overspend. Distinguish errno: statSync exists-and-non-empty or transient errno ⇒ keep counting/refuse; only structural absence expires. Money-path: preserve BEGIN IMMEDIATE semantics; add boundary tests in-cluster. |
| FP2 | MED | blind | PATCH | Reaper ownership predicate uses STRICT RUN_ID_SHAPE while record paths honor LEGACY_RUN_ID_RE — factory-owned tagged box with legacy id classifies foreign, never reaped, bills forever. Ownership test accepts legacy-shape+our-tag (still requiring factory tag). |
| FP3 | MED | blind | DEFER | Close→price race is fixed 6-min wall-clock bet; slower recovery re-grants headroom then late box-hours exceeds cap. Retirement-rule redesign risks admission wedging (opposite failure); documented tradeoff — needs design, not local patch. |
| FP4 | MED | blind | PATCH | credentials.ts error paths invoke `redactSecrets` unguarded + feed non-strings (`(e ?? {})`) — redactor throw REPLACES the real credential/compensation failure. safeRedact-style wrap (pattern exists in cap-hit-demo) + string coercion. |
| FP5 | LOW | blind | PATCH | Spend predicate slug column-side folds lower() only, no TRIM — padded historical raw-slugs drop out of SUM (under-count, cap-bypass direction). Extend column-side to mirror issue-id canonicalization incl. trim. |
| FP8 | LOW | blind | DEFER | Same-pid steal after 60s grace converts debugger/SIGSTOP pause into lost-update. Documented deliberate wedge-breaker; removing it reintroduces permanent wedges. |
| FP9 | LOW | blind | DEFER | Put-back (linkSync) failure vacates lock path for ALL contenders until operator restores parked bytes. Needs flock-fallback/refuse-all mechanism = design work. |
| FP10 | LOW | blind | DEFER | cleanStaleTemps 60s same-pid rule eats paused sibling's in-flight temp. Same grace-family trade as FP8. |
| FP12 | LOW | blind | DEFER | Fresh create retry within 5s tombstone grace gets raw EEXIST (availability blip on crash-recovery path). Correctness fine; shortening grace risks stealing genuine in-flight creates. |

## Cluster W1f — src/providers/driver.ts, fake-driver.ts, fake-gate.ts, step-log.ts, exedev/
| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| FB1 | MED | edge | PATCH | Mid-sequence `store.set` failures (vmName/ports write :606-613; httpsUrl confirm :649) escape as RAW errno errors — everything else in create() is ProvisionRefusedError-classified. Wrap both sites into the module's refused-error taxonomy (remediation-bearing). |
| FB2 | MED | edge | PATCH | `address()` throws raw TypeError on null URL (JS-lie boundary) BEFORE vmName recorded; whitespace-padded URL tested-trimmed-but-returned-original. Typed refusal for null/non-string; return trimmed value. |
| FB3 | MED | edge | PATCH | `isSubstrateFailure` crashes on non-array `assertions` from injected gate (`{}.some`/`"boom".some`) — defeats fail-closed classifier with a crash. Array.isArray guard → false. |
| FB4 | MED | edge | PATCH | Negative exitCode (signal-killed probe, `-15` convention) falls through every arm → manifest-verdict misclassification (do-not-retry) instead of SUBSTRATE_MARK. Add negative-value arm → substrate-marked. |
| FB5 | LOW | edge | PATCH | `driverListing` fallback puts prose sentence in `skipped[]`; refusal then counts prose as a listing entry with misleading guidance. Structured entry + adjusted guidance. |
| FB6 | LOW | edge | PATCH | `displayName` escapes C0/DEL only — Unicode format/bidi controls (U+202E etc.) ride into log lines (half-closed log-injection). Extend class to Cf/Zl/Zp aligning with brief-schema doctrine. |
| FB7 | LOW | edge | DEFER | Path-exemption 32-char segment cap over-redacts legit long segments. Loosening redaction = wrong direction; conservative leave. |
| FB8 | LOW | edge | DEFER | One bad entry stalls fleet-wide reaping indefinitely. Deliberate heavily-documented fail-closed; cap/grace would weaken the invariant. |
| FB9 | LOW | edge | PATCH(test) | Lock-timeout predicate is message-string match away from destructive rollback arm. Add two-sided pin test asserting BOTH predicate match and throw-site string (test lives in tests/providers/run-record.test.ts → coordinate with W2c; W1f writes it, W2c owns further edits there). |
| FB10 | LOW | edge | DEFER | exedev setup-gate never inspects limitMicroUsd (fake side does). pipeline-run reconcile backstop VERIFIED real; substrate gate item = feature work beyond review-fix scope. |
| FB11 | LOW | edge | DISMISS | ASCII-only slug folding residual — VERIFIED unreachable: REPO_SLUG_PATTERN bars such slugs at dispatch; exposure = hand-edited ledger rows only (self-documented). |
| FB12 | LOW | edge | PATCH | Fake-gate item C reports wrong-TYPE .env (directory) as mode mismatch → sends operator to chmod instead of re-fill. Probe type (%F) and emit accurate detail. |

## Cluster W1g — src/phase-engine/manifest.ts
| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| FM1 | MED(t3 tripwire) | edge-tests | PATCH | `stampManifestLimit` re-stamp is LAST-WINS and can RAISE the ceiling (spread order, no monotonic guard) — certified-green KNOWN-DEFECT tripwire proves the hazard open. FAIL-SAFE: second stamp with HIGHER value throws ManifestError (equal/lower allowed — lower preserves downward-only clamp doctrine). Update manifest.test.ts expectations in-cluster; dispatch.test.ts tripwires ("re-stamping is LAST-WINS…") flagged for W2a flip. |

## Wave 2 — test hardening (after source settles)
| id | sev | source | owner | work |
|----|-----|--------|-------|------|
| WT1 | HIGH | blind-tests-t1 | W2a | Structured refusal-line assertion missing ~12 families (:400,:748,:775,:805,:896,:1114,:1171,:1198,:1217,:2321,:3952,:4047) contradicting "shared minimum" claim. Add helper calls. |
| WT2 | HIGH | blind-tests-t2 | W2b | Help-table binding never requires codes 3/5(/1) present — bind printed table to REGISTRY-declared exitCodes per verb, not observed set. |
| WT3 | HIGH | edge-tests-mid | W2b | Closed-world registry assertions (exactly-4/order-pin/driver-required-every-verb) break on additive registry (now 6 verbs; rank has no --driver BY DESIGN). Open-world rewrite: contains-set + subsequence order + requirement sweep filtered by verb-declared flags. |
| WT4 | HIGH | blind-tests-prov | W2c | budget-gate CostLedger opened at library-default path (repo's real sandbox ledger!) — isolate via mkdtemp+explicit path; fixes money-row leakage + wrong-reason greens. |
| WT5–WT14 | MED | various | owners | t1: exactly-at-cap mint boundary; gate-B invalid-JSON arm; A/C probes driven via REAL path; createKey-throw mid-provision; cross-runId concurrency TOCTOU; abandoned-step stall-margin hardening. t2: within() abandon containment (lock poisoning); git -c commit.gpgsign=false isolation; 40–63-char secret-band case; process.chdir safety note. t3: excused-exit-code parser robustness; DOCUMENTED_EXIT_CODES anchor/matchAll; S28 ±30min inclusive boundary case. t4: tripwire flips for FM1 (dispatch.test). t5a: SQL reservation predicate matchAll+count; grace/close-retirement exact-boundary cases; cap-hit leak scan whole stream; driver-contract clean-listing positive per shape; visualizer double-encoded/backslash/uppercase traversal encodings; truncated-JSON quarantine test. |
| WT15+ | LOW | various | owners | Selective LOW additions: abandonedLine window, FIFO skip visibility, cwd-coupling isolation, record-posture pin, exit-code asserts, exactly-max roster, expiry boundary, requestId sequential reuse, UnexpectedSuccess guard in expectRosterRefusal, budget==cap, fixture naming; live-holder try/finally, readUntilMarker stranded read, LOCK_HOST placement, RUN_ID_RE import reuse, derived constants, vmName===runId consistency, sinks-separate assertion, POSIX precondition note, injected-driver-no-flag coverage; goodLedger remainingMicroUsd, module-probe isolation, isAlive copy unify, empty-fleet stdout assert, sentinel→refusal helper, deep-freeze nested assert, tracer WAL loosen, multi-segment slug pin, phases toEqual, perf-timing loosen, bare toThrow pinning, ppid→liveForeignPid unify, rounding straddle, aggregate overflow, JSON-escaped PEM, derive-from-import constants, dist fixture cleanup, racing-title honesty. |
| FB9 | LOW | edge | W2c | (listed above — executed by W1f; W2c must not clobber) |

## Dismissal count: 8 (DF17, DF20, FF7, FF11, FF15, FC6, FB11, plus FC13 folded into PATCH-verify)
## Deferred count: 17 (DF8, DF13, DF14, DF19, FF2, FF13, FF14, FC12, FR5, FR9, FR14, FP3, FP8, FP9, FP10, FP12, FB7, FB8, FB10 — 19 entries; see tables)
