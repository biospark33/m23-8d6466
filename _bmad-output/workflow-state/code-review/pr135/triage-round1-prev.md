# PR 135 review triage — 2026-08-27

7/7 layers reported (blind-src, blind-tests-a/b, edge-src, edge-tests-a/b, auditor).
~141 raw findings → deduped/verified below. Verified against source by lead:
- blind-src CRITICAL (abort run_start → ok:true) = FALSE POSITIVE: journal.finish computes `ok = rows.length > 0 && every success && accepted` (journal.ts:137); zero-phase abort run is ok:false, exit 1.
- blind-src HIGH (unbounded retry if retries undefined) = FALSE POSITIVE: manifest schema defaults retries (manifest.ts:73 `.default(MIN_RETRIES)`).
- blind-src MED (manifest strings unsanitized in prompt) = REAL: phase `name` is `z.string().min(1)` only (manifest.ts:64); pipelineId validated but name/runId interpolation raw.

## PATCH — Wave 1 (source clusters)

### Cluster A — src/phase-engine/steering.ts (+ steering.test.ts)
- A1 [HIGH] select_roster fail-open when ctx.rosterIds undefined (steering.ts:263 `!== undefined &&`) → treat missing as empty set, reject. (edge-tests-a)
- A2 [MED] meter() no finite guard — NaN/Infinity/negative poisons spendMicros for the run (JSON null, ceiling bypass) → clamp non-finite/negative to 0. Tests: NaN + negative + Infinity cases. (edge-src, edge-tests-a, blind-src)
- A3 [MED] throwing onTripwire observer breaks "never throws" contract, converts valid directive → proceed in runner → wrap in try/catch + test. (edge-tests-a, blind-tests-a)
- A4 [LOW] parseReply/safeParse callee throw escapes solicit (contract: never throws) → wrap parse in try/catch, treat as malformed. (blind-src)
- A5 [MED] degradation cause discarded entirely (timeout vs ENOENT vs persist-fail indistinguishable) → record sanitized reason (tripwire row or telemetry field). (edge-src, blind-src)
- A6 [LOW] malformed correction prompt doesn't restate union members — stateless caller's 2nd attempt blind → append DIRECTIVE_INSTRUCTION to correction prompt. (edge-src)
- A7 [MED] head-truncation drops NEWEST context (accepted guidance cut first) → truncate context lines tail-first (instruction head + newest context survive). Test: multi-line over-ceiling context, assert newest line survives. (edge-src, blind-src, blind-tests-a)
- A8 [LOW] KNOWN_ACTIONS duplicates schema literals → single const source feeding both. (blind-src)
- A9 [LOW] test: µ$ rounding tie case (x.5) e.g. 1115×100000/1e6=111.5. (blind-tests-a)
- A10 [LOW] test: select_roster rejection asserts single attempt (calls()===1). (blind-tests-a)
- A11 [LOW] test: malformed-counter reset across solicits (recover in solicit A; single malformed in solicit B still gets correction attempt). (blind-tests-a)
- A12 [LOW] test: steeringIterations two consecutive retries → {build:2} (increment not overwrite). (blind-tests-a)
- A13 [LOW] test: missing/wrong-typed required fields on known actions ({action:"retry"} no guidance etc.) — pin schema strictness. (blind-tests-a)
- A14 [LOW] test: correction-attempt metering (malformed then valid → spendMicros reflects both replies). (blind-tests-a)

### Cluster B — src/fleet/resident.ts (+ resident.test.ts, fleet fixture)
- B1 [MED] redact(stderr.slice(-400)) truncates BEFORE redacting — partial secret survives (repo rule: redact full, then cut) → `redact(stderr).slice(-400)`. (edge-src)
- B2 [MED] runId unvalidated into file paths — traversal for session file + artifacts → validate `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` in startResident (throw). (edge-src, blind-src)
- B3 [MED] redaction binds only 2 key names + child inherits full env → expand bound key set (GITHUB_TOKEN, GH_TOKEN, GIT_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, PI_API_KEY, generic *KEY/*TOKEN/*SECRET common names) for bindRedact + stderr redaction. (edge-src, blind-src)
- B4 [MED] QDS_RESIDENT_TIMEOUT_MS read from process.env, ignoring opts.env seam → read (opts.env ?? process.env); also clamp upper bound to 600_000 (24.8-day hang admits no bound). (edge-src, blind-src + edge-src budget note)
- B5 [LOW] Math.max(1, ...) dead armor → remove. (blind-src)
- B6 [LOW] ENOENT → "transient" misclassification (permanent misconfig) → "logic". Behavior change — update resident.test.ts expectation. (blind-src)
- B7 [LOW] exitStatus() reports "transient" for never-ran resident → null default (lastExit ?? null). (auditor F10, blind-src)
- B8 [MED] reply-persist failure degrades resident AND loses metered spend (call already billed) → best-effort reply persist (catch + stderr note, still return reply). Prompt persist stays fail-closed. Behavior change — flag. (blind-src)
- B9 [LOW] stop() race window (stop before current=proc misses child) → `stopped` flag checked at top of call (throw "resident stopped"). (edge-src, blind-src)
- B10 [LOW] slug double-strip asymmetry, no vendor/model validation → validate remainder shape, refuse garbage slug. (blind-src)
- B11 [LOW] test: env cleanup `= undefined` stores string "undefined" → delete keys. (edge-tests-a, blind-tests-a)
- B12 [LOW] test: stop() discrimination — set QDS_RESIDENT_TIMEOUT_MS high, assert rejection arrives fast (elapsed « timeout) so no-op stop() fails the test. (blind-tests-a HIGH)
- B13 [LOW] test: string briefs ("   " empty; non-empty spawns) — briefIsEmpty string branch coverage. (edge-tests-a)
- B14 [LOW] test: session continuity behavioral (two calls append same session; new runId fresh session) — add session-append to fake-pi-resident if needed. (blind-tests-a)
- B15 [LOW] fixture: NaN coercion of QDS_FAKE_PI_INPUT/OUTPUT → throw clear error. (edge-tests-a, blind-tests-a)
- B16 [LOW] fixture: piEnv inherits developer-shell fixture knobs → scrub QDS_FAKE_PI_*/FAKE_RESIDENT_* from child env. (blind-tests-a)
- B17 [LOW] test: replace self-referential TEST_SOURCES key assertion with DEFAULT_RESIDENT_SLUG toBe. (blind-tests-a)

### Cluster C — scripts/pipeline-run.ts (+ manifest.ts, pipeline-run.test.ts)
- C1 [HIGH] gated retry loop ignores bodyCtx.signal.aborted — post-settlement zombie loop re-spawns command+resident, mutates journal after terminal marker → `if (bodyCtx.signal.aborted) throw err;` first in catch. (edge-src)
- C2 [MED] resident_directive via writeGateEvent fabricates gate_results row passed=0 + event type outside closed TraceEventType → write as tracer.trace({type:"log", name:"resident_directive"}) like tripwire/rosterChoice precedent. (edge-src, blind-src)
- C3 [MED] abort at post_gate_failure leaves no journal/trace record (reason dropped) → write trace row for accepted abort directive. (blind-src)
- C4 [MED] pipelineId/runId/phase names interpolated raw into resident prompt (name is min(1) string — \n injection forges instruction lines) → sanitizeForMessage each. (blind-src)
- C5 [MED] RateError refuses whole run (spec: refuses the RESIDENT; INV-RES-5 fail-coward-toward-determinism) → catch RateError at arming → status disabled + stderr warning + tripwire row naming cause; run proceeds deterministic. Behavior change — flag; startResident throw contract unchanged. (auditor F3, blind-src)
- C6 [MED] credential-shaped brief values not refused at resident boundary (INV-RES-3/DOD-Security) → apply manifest.ts CREDENTIAL_FIELD/CREDENTIAL_VALUE scan to witness brief values → refuse run naming the field. (auditor F5)
- C7 [MED] observability `model` missing from resident_solicit line (load-bearing for D4 cost eval) → thread slug through SolicitCtx/arming into log line. (auditor F7)
- C8 [LOW] telemetry snapshot shallow-copies live tripwires/steeringIterations arrays → deep-snapshot in residentTelemetryOf. (blind-src)
- C9 [LOW] fs.writeSync partial write → loop till written (or best-effort with count check). (blind-src)
- C10 [LOW] closedRosterIds catch silently widens rejection to everything → stderr note when roster load fails. (blind-src)
- C11 [LOW] testCommand on non-code phase schema-legal, silently unenforced → manifest superRefine: forbid testCommand when kind !== "code". (edge-src)
- C12 [LOW] unreadable brief witness silently lands disabled (env fault wearing AC4's clothes) → stderr warning line in readResidentBriefSource catch. (blind-src)

## PATCH — Wave 2 (e2e + fixtures, after source settles)

### Cluster D — tests/phase-engine/resident-e2e.test.ts + fixtures + usage.test.ts
- D1 [HIGH] e2e reads host ~/.pi/agent/models.json (custom registry unsteered; EACCES→all 6 fail; priced-off host drift) → pin QDS_PI_MODELS_JSON to nonexistent path in spawnRunner env. (edge-tests-a, edge-tests-b; empirically reproduced)
- D2 [HIGH] TMPDIR-unset → counter divergence (test resets /tmp path, fixture writes / root path; 5/6 fail) + fixed-name shared counter in global TMPDIR → set TMPDIR: legDir in spawnRunner env; stateFile() reads same single source; per-leg cleanup. (edge-tests-b, blind-tests-a/b; empirically reproduced)
- D3 [HIGH] runner proc never killed (timeout orphans tree) + stdout piped never drained (64KB pipe deadlock) → try/finally proc.kill if !exited; drain stdout alongside stderr (or "ignore"); budget-ms below test timeout. (edge-tests-b, blind-tests-b, edge-tests-a)
- D4 [HIGH] arming test no negative control (content-free witness + requestId → must NOT arm) → add disabled leg. (blind-tests-b)
- D5 [HIGH] usage.test.ts whole-file steering exemption, no compensating count pin → assert exactly 2 `/ 1_000_000` in steering.ts (meter's two terms). (edge-tests-b, blind-tests-b)
- D6 [MED] telemetry test never asserts exitCode===0 → add first-line assert. (edge-tests-b, blind-tests-b)
- D7 [MED] spendMicros type-only check (off-by-1e6 passes) → assert > 0 and bounded by witness ceiling; exact value if deterministic. (blind-tests-b)
- D8 [MED] proceed leg: directivesRejected===0 + directives===3 partition (directives + directivesRejected === solicitation count). (blind-tests-b)
- D9 [MED] degraded-path e2e (FAKE_RESIDENT_EXIT=3 → exitStatus "logic", run completes deterministic). (edge-tests-a)
- D10 [MED] fake-resident exitCode clobber (missing -p exit 2 overwritten to 0) + hang-mode skips session marker (invocation index shift) → fix fixture ordering/guard. (edge-tests-a, blind-tests-a)
- D11 [MED] redaction actually asserted: fake OPENROUTER_API_KEY in spawnRunner env, assert absent from persisted prompt artifacts. (blind-tests-b)
- D12 [MED] timing-allowlist hand-closed → suffix/regex-based timing detection (Ms$|_ms$|At$) so future timing fields don't flake AC1a. (blind-tests-b)
- D13 [MED] retry-authorization negative leg (effectiveCeilingMicros: 0 → no retry, run stops). (blind-tests-b)
- D14 [LOW] journal read surfaces stderr on crash-before-journal. (edge-tests-a/b, blind-tests-b)
- D15 [LOW] jsonLines filter on event==="resident_solicit" BEFORE find. (edge-tests-b)
- D16 [LOW] "exit 1" regex bounded (/exit 1\b/). (blind-tests-b)
- D17 [LOW] arming >= 2 → toBe(3). (blind-tests-b)
- D18 [LOW] walkKeys/segmentsOf canary (detector detects "ratio"). (blind-tests-b)
- D19 [LOW] 0600 assertion portability → assert no group/other bits. (edge-tests-a, blind-tests-b)
- D20 [LOW] toEqual + stable() redundancy → keep one. (blind-tests-b)
- D21 [LOW] stripped() deletes resident at all depths → top-level only. (edge-tests-a)
- D22 [LOW] pi-catalog fixture cacheWrite align with TEST_SOURCES (0.018). (blind-tests-a)

## DEFER (real, not actionable this round)
- Steering solicitation wall-clock absent from requiredBudgetMs admission math (edge-src MED) — DF3.6 owns bounds/projection.
- post_gate_failure wired for code phases only; agent phases never solicited at point 2 (auditor F2 HIGH) — engine retry-loop wiring, follow-up story; record deviation.
- select_roster has no engine-defined effect (auditor F1 HIGH) — deviation ledger #3, DF1.6 surface; record.
- retry guidance reaches no executor (auditor F6) — story amendment.
- Sub-timings (prompt_render_ms etc.) absent (auditor F7 part) — escape hatch documented ("durationMs authoritative").
- pi session file unredacted duplicate (blind-src MED) — pi-owned file format.
- full prompt on argv visible in ps (blind-src MED) — pi CLI contract.
- journal version stays 1.0.0 with additive resident field (edge-src LOW) — 4+ test pins + cross-story blast radius; bump belongs with a journal-schema story.
- artifacts accumulate unbounded in journal dir (edge-src LOW) — retention policy ops.
- session/artifact reuse when same runId re-dispatched (edge-src LOW).
- gate-note redaction bound to secret-free childEnv (edge-src LOW) — pre-existing PF-2 pattern.
- roster closed-set global (union) not per-phase (blind-src LOW) — DF3.6/DF1.6.
- gate_bypass_attempt cause for roster rejections (blind-src LOW) — spec's closed 3-cause union.
- accepted-but-inapplicable directives counted (edge-src LOW, blind-src MED) — AC5 telemetry semantics as specced ("count of accepted").
- abort skips run_end solicitation (auditor F8 LOW) — spec amendment note.
- testCommand composition silently switches on for future manifests (auditor F12) — note in story.
- valid-roster-selection application untested e2e (blind-tests-b MED part).

## DISMISS (false positive / noise / verified handled — with evidence)
- blind-src CRITICAL abort ok:true — journal.ts:137 `rows.length > 0 &&` refuses empty-ok. VERIFIED.
- blind-src HIGH retries-undefined infinite loop — manifest.ts:73 default. VERIFIED.
- blind-src LOW formatZodIssue sanitization trust — edge-tests-a verified types.ts sanitizes path+message.
- blind-src LOW rounding drift — DD-9 spec'd per-term rounding.
- blind-src LOW _injectRateSources module-global — codebase precedent (_injectRunner), test seam.
- blind-src LOW accepted-flag spend jump on rejected replies — observability nuance, cumulative spendMicros authoritative.
- edge-src LOW TOCTOU brief double-read — informational, prompt-context only.
- blind-tests-a HIGH counter/steering-attribution confound — spec's own E2E slice design (fails once, engine-authorized retry).
- blind-tests-b LOW CORE_FIELDS 13 pinned in e2e — intentional snapshot (dev record).
- auditor F9 files-budget — test-support files only.
- auditor F11 roster-driven wording — deviation ledger #1 verified correct.
- blind-tests-a LOW enabled() cast — assertion narrowing idiom.
- agent_end double-count concern (blind-tests-a MED part) — harvestPiStream message_end-only verified; exact-spend assertion added as D7 instead.
