# R3 — DF3.1 Playbook (Track C: completed similar story)

Source material: `_bmad-output/workflow-state/qds-dev/df3-1/state.yaml`, `integration-spec.md` (716 ln incl. corrections/amendments), `research/*.md` (7 files), `stories/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md` review rounds 2–9, `git log main` + `git show 7b65a09|fb786d8 --stat`. Compiled 2026-08-23.

---

## 1. The wave plan that worked

From `df3-1/state.yaml` checkpoints (all timestamps 2026-08-21 → 2026-08-23):

```
phase0-validation      story HITL check, deps verified on main, no open PRs
phase1-branch          cut feature/* from main; pre-existing dirty files EXCLUDED from PR
                       (df3-1 had them too; df3-2 has 18 — same precedent applies)
phase2-research        6 parallel tracks → research/*.md, confidence scored (0.95, auto-approved)
phase3-gate            HITL gate
phase4-wave0           architect agent drafts integration-spec.md (decisions D1–Dn),
                       THEN orchestrator verifies every claim against source and appends
                       corrections C1–C10 ("where the sketch conflicts, THESE WIN")
phase4-wave1           agents A/B/C in PARALLEL TDD on disjoint modules, each writing source
                       + its own test file against A/B/C's locked exports
phase4-wave1-result    A green, C green, **B died post-tests leaving a defective dispatch.test.ts**
phase4-agent-D         relaunched NARROWER than dead B: dispatch.ts + scripts/fleet.ts +
                       cli.test.ts + e2e demo, only AFTER A+B+C merged (imports real exports,
                       not spec guesses)
phase5                 push, PR #123, then BMAD adversarial review rounds 2→9 to green gates
```

**Why the B-failure recovery worked** — three structural choices, replicate all:

1. **B wrote dispatch.test.ts against the SPEC, not against compiled siblings.** When B died, its defective test file was disposable; A and C kept shipping because nothing consumed B mid-flight. Keep wave-1 dependencies strictly acyclic (A's schema/manifest ← B ← C independent).
2. **Relaunch narrowed, never retried whole.** Dead B's scope (dispatch + CLI + e2e) became Agent D's smaller scope, sequenced after the merge so D reads real exports. Do not respawn a dead agent with its original prompt.
3. **The orchestrator corrected the architect, not vice-versa.** The architect's D1 was flat wrong (`createRun` runs `checkHeadroom` unconditionally — no `{admitted:true}` skip possible). Only a direct source read by the orchestrator caught it. Wave0 is not done until every D-decision cites verified `file:line`.

## 2. integration-spec.md section structure (the format to mirror)

Order matters; this exact skeleton survived 9 review rounds as the normative contract:

1. **Module Contracts** — one fenced TypeScript block per module (`brief-schema.ts`, `dispatch.ts`, `status.ts`, `verbs.ts`, `index.ts`, `scripts/fleet.ts`, additive-edit modules). Sketches carry doc comments that encode the AC numbers and call-ordering rationale inline. Sketches are *drafts* — expect corrections to supersede them.
2. **Locked Decisions (D1–Dn)** — each: bolded **Verdict** + **Evidence** bullet list of `file.ts:line` citations + locked field/constant tables. One decision per architectural fork (admission architecture, schema fields, fake-path behavior, stamping mechanism, key seam, status join, exit-code map, registry shape, trace-store ownership, test-plan mapping).
3. **Executive Summary** — one dense paragraph restating every verdict.
4. **CORRECTIONS (orchestrator-verified, dated)** — appended after the summary, numbered C1–Cn, opening line "These corrections were verified by direct source reads… Where the sketch above conflicts, THESE WIN." C-last is always the **wave plan**: who writes what, FTM boundaries, mandatory GitNexus impact before shared-file edits.
5. **AMENDED notes** — review-round findings append `> AMENDED (review Bx/round-n)` blockquotes *inside* the affected C/D section rather than rewriting history. These become normative (e.g., DN1 moved expose/setPublic after the setup gate; B6 added the `orphan` row state; B8 widened exit-code sets). DF3.2 should keep this append-only amendment discipline from day one — it ended recurring bot flags in round 9 ("ends the recurring bot flag without touching runtime semantics").

For DF3.2 the fork-list to decide as D-items: fleet.lock protocol (claim/steal/release semantics), fan-out headroom batching (one `checkHeadroom(N)` — C1 constraint inherited), best-of-N selection + loser disposal, race semantics, pattern-file schema, registry entries for new verbs + per-verb exit sets, `.sandbox/` layout under the lock.

## 3. Research-track takeaways (df3-1/research/)

| File | Takeaway |
|------|----------|
| `trackA-context7.md` | zod v3 idioms: `.strict()` rejects unknown keys; `.uuid()` accepts ALL versions — strict v4 needs regex. Small but prevented an AC1 bug. |
| `trackB-codebase.md` | **Most valuable downstream.** Full DF2.x API surface with line numbers. Its KEY INSIGHT (createRun runs `checkHeadroom(1)` unconditionally, no skip option, driver.ts not editable under FTM) directly produced correction C1, overturning the architect's D1. Without it wave1 would have built dispatch on an impossible seam. |
| `trackC-examples.md` | Reuse inventory: `newId(slug)` IS `mintRunId`; CLI DI-seam pattern (`XxxDeps` interface, `run(argv, Partial<Deps>)`); O_EXCL 0600 create precedent; RUN_ID_RE grammar + 63-char cap. |
| `trackC2-indydevdan.md` | Doctrine-only lift: inkwell's `runs_table.py` three-state status doctrine ("a failed lookup must never render as every VM destroyed") → live/boxMissing/boxUnknown. Confirmed brief-schema is NET-NEW (no verbatim lift). MIT attribution template included. |
| `trackD-specs.md` | Spec constraints: ExitStatus import-only from cli-anything/types.ts (never redeclare); retry single-owner rule; µ$ integer discipline; note the $5-vs-$50 default-cap discrepancy between DF2.8 and credentials.ts. |
| `trackE-deps.md` | Dependency interfaces (correlation/tracer). **Meta-lesson: this agent died twice of context overflow** — dependency-surface enumeration needs the narrowest brief of any track. |
| `trackF-consumers.md` | Downstream contracts DF3.3–DF3.6 verified compatible up front — zero conflicts found later. Cheap insurance; repeat for DF3.2's consumers (whoever consumes best-of-N results and the fleet lock). |

## 4. Review-history lessons applicable to DF3.2

Rounds recorded in `sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md` (round 2 L457, r3 L539, r4 L686, r5 L904, r6 L1131, r8 L1400, r9 L1557). No D016–D020 exist anywhere — `.claude/learnings/qds-dev/patterns.yml` does not exist (only `qds-sprint-planning/` learnings); `workflow-state/code-review/round10/` is PR #116 (df1-6), unrelated. The recurring-pattern ledger lives in the story file itself.

### 4.1 Lock lifecycle races (recurred in rounds 3, 5, 6, 8, 9 — five consecutive rounds)

DF3.2 owns `.sandbox/fleet.lock`: a NEW cross-process, cross-RUN lock. Every per-run-lock bug below will replay at fleet scope unless designed out up front:

- **Release destroying a live holder's body.** Unconditional `rmSync(claimed)` after a failed `linkSync` put-back deleted the only link to a lock a live holder owned → two invocations both entered teardown (double revoke, double destroy). Rule: remove a lock body ONLY when the put-back landed or the path was legitimately re-claimed; park failures as `.orphan.<pid>.<hex>.tmp` (r8/r9: orphans must be named so `cleanStaleTemps` NEVER sweeps them — the round-9 fix was exactly that parked evidence self-destructing via a swept `.tmp` name).
- **SIGINT stranding the lock forever.** Signal handler installed *after* `linkSync`, `held.set` *after* `rmSync+fsyncDir` — a signal in that window left a lock no handler would ever clear; harvest/teardown refused permanently while the box billed. Rule: install handler FIRST, register hold immediately after the claim primitive returns.
- **Same-pid foreign body wedge (r8 HIGH).** A dead thread sharing our pid held the lock; `isAlive` stayed true so steal logic refused for process lifetime, burning LOCK_TIMEOUT_MS on every later write while billing. Fix: age-based steal (`OWN_LOCK_GRACE_MS` 60 s) for own-pid foreign bodies, with the **re-entrancy check hoisted ABOVE the grace check** so a long enclosing write can't steal its own outer claim.
- **Staleness misclassification family (r5/r6):** unknown-host and pre-host bodies never stale; out-of-range pid is NOT "dead"; empty body ≠ stale; pid reuse vs genuine re-entrancy distinguished by the lock-body NONCE, not pid alone. Wait budgets on monotonic `performance.now()`, never wall clock (NTP).
- **Cleanup failures must be non-retryable exits.** A successful teardown that failed to release its lock was downgraded to exit 1 `transient` → automation retried forever into `run-locked`. Exit **6** exists for exactly this ("cleanup failed on an otherwise-successful path", classified `logic`); harvest/teardown/dispatch all declare 5 (`run-locked`) and 6 in their registries now.
- **Throw mid-critical-section released the lock `markRunLockDestructive` exists to hold** (r6): `releaseRunLock` ignored the mark; new contract — refuse while marked, explicit clear on clean completion, `{force:true}` override.
- **Stale prefetch poisoning (r9 HIGH, cost-ledger but same shape):** caching `{record:undefined}` / `{error}` verdicts and acting on them inside the transaction expired LIVE reservations → cap fail-open. Rule: cache successful reads only; miss or cached-error re-reads live UNDER the lock. Any DF3.2 fleet-lock fast path must obey this.

### 4.2 Reap/ownership refusal (r8)

Destroy decisions rested on rows carrying no ownership evidence (exe.dev ls has no tag field) → either destroy-on-guess of a co-tenant or silent stop. Fail-safe direction shipped: `reapRuns` partitions unclaimed boxes BEFORE destroying anything and refuses wholesale via `unownedVmReapRefusal` (`reap-vms-unowned`, naming each spared box). For DF3.2 best-of-N loser disposal: never destroy a loser box on name-shape inference; partition-then-refuse with named spares.

### 4.3 Concurrency races directly relevant to fan-out (r9 HIGH)

Two concurrent dispatches sharing an explicit runId both reached provisioning; the LOSER's catch ran correlation-stamping before EEXIST classification and overwrote the WINNER's join key via patch-merge. Fix: skip stamping on the EEXIST/run-id-in-use arm. DF3.2's fan-out/race verbs are precisely the workload that makes this class frequent — every catch-block side effect must be ordered AFTER outcome classification, and regression tests must FORCE overlap deterministically (r9: natural scheduler interleaving made a lost-race test pass vacuously until a headroom-seam barrier forced it; the ledgerFactory seam is synchronous so the barrier goes at the only await before O_EXCL). Also r3: `admitIssue` `ON CONFLICT DO NOTHING` returned `admitted:true` with a fresh ceiling while discarding the reservation — check `changes === 0` for idempotency.

### 4.4 Secret-redaction sinks (every round 3–9; ~15 distinct leaks)

The invariant that finally held: **one chokepoint, redact BEFORE slice/bound, applied to EVERY string leaving the process** — message, remediation, payload leaves, refusal echoes, operator stdout, log lines, error paths (`asUsage` copied `.message` verbatim; `report` attached raw `.stack`). Specific traps DF3.2 will hit:
- Duplicate private log helpers bypass the chokepoint (credentials.ts had its own `timed`; hardening step-log alone closed nothing).
- Sub-floor-length secrets (13–39 chars) pass the 40-char redaction floor with no URL trigger — bounded echo forms needed for short values (r9 `storeRunIdRefusal`).
- Box-chosen strings (gate debugCommands, teardownCommand, assertion labels) reach operator sinks raw — escape like sibling fields.
- `bounded()` must redact BEFORE slicing (r8 CC-9: pre-fix leaked the credential-shaped argv HEAD verbatim).
- Blank exposure URL (`""`/whitespace) published a public box with no locator — guard past `=== undefined` to trim-empty.
- INV-6 URL regex + never log key material (keyHash only) remain baseline.

### 4.5 Witness freshness (r8)

Stale or author-planted dispatch witness must not set the spend ceiling: ±30-min symmetric freshness binding (future mtimes count as stale); stale-witness-only → ceiling absent + structured warn; declared-limit path refuses even a number-agreeing stale pair. Temporal binding over id-match because dispatcher writes two distinct ids. DF3.2's fleet.lock/pattern files are the next author-writable artifacts — state the assumption where two-copies-must-agree is claimed.

### 4.6 Other transferable categories

- **Fail-open listings (r5/r6):** `list()` silently skipping malformed entries meant the reaper built its destroy-set from incomplete data and killed a live box. `list()` refuses when anything was skipped; anomaly channel is opt-in, not safety. Applies to DF3.2 enumerating fan-out members.
- **Output-write failures rewriting exit codes (r5/r6/r9):** final `logVerb` outside try; cleanup finallys writing raw instead of EPIPE-tolerant emit; conversely emit swallowing EPIPE for the dispatch ack orphaned a live box (`fleet dispatch | head -0` exited 0). Ack-unwritable = exit 6.
- **Validation-before-side-effects (r6):** store constructor mkdir/chmod ran before brief validation → invalid input re-permissioned an existing dir. Read-mode `{create:false}` added; status uses it. DF3.2: acquire the fleet lock only after argument/schema validation.
- **Strict grammars must not govern read paths (r3):** tightened RUN_ID_RE applied to reads turned ONE legacy filename into a fleet-wide `status` outage. Strict for creation; legacy-tolerant reads reporting anomalies.
- **Comments asserting invariants the code dropped (r3 theme):** recurring shape across rounds — audit comment/code agreement in review.
- **Tests:** mutation-verify every new assertion goes RED against pre-fix source; import constants (LOCK_TIMEOUT_MS, grace windows) rather than mirroring literals + value-lock the derivation; `UnexpectedSuccessError` sentinel beats try/catch; signal-delivery coverage drives real children through the preload-patched install seam (zero-coverage handlers were "deletable-green").

## 5. Round-8/9 fix footprints (what the bug categories actually touched)

`git show fb786d8 --stat` (r8, 25 files, +1666/−299): `scripts/fleet.ts`, `scripts/pipeline-run.ts`, `src/fleet/{dispatch,status}.ts`, `src/providers/{cost-ledger,driver,fake-driver,fake-gate,reaper,run-record}.ts`, `src/providers/exedev/driver.ts`, + tests incl. `tests/providers/run-record.test.ts` (+198) and `tests/fleet/dispatch.test.ts` (+315).

`git show 7b65a09 --stat` (r9, 16 files, +1874/−210): `scripts/fleet.ts`, `src/fleet/{brief-schema,dispatch,status}.ts`, `src/providers/{cost-ledger,run-record}.ts`, `src/providers/exedev/setup-gate.ts`, + tests (`cli.test.ts` +533, `dispatch.test.ts` +578).

Read: the lock machinery lives in **`src/providers/run-record.ts`** (+181/+132 across r8/r9) and the verb front door **`scripts/fleet.ts`**; the money interactions land in **cost-ledger.ts**. DF3.2's fleet.lock should live beside the hardened run-record lock primitives and REUSE them (claim/steal/park/orphan-naming/monotonic budgets/destructive-mark) rather than mint a second lock implementation — the entire §4.1 list is already encoded there post-#123.

## 6. Recommended wave plan for DF3.2

Mirror df3-1 with these adjustments:

- **wave0**: architect drafts integration-spec.md (D1–Dn per the §2 skeleton; fleet-lock protocol as its own D-item citing run-record.ts's hardened primitives) → orchestrator verifies EVERY D against source → append C-corrections including the C-last wave plan.
- **wave1** (parallel TDD, acyclic): A = pattern/schema module + manifest/store additive edits (mandatory GitNexus impact first) · B = fan-out/best-of-N/race core verbs consuming A's exports · C = fleet-lock module + status extensions. B must depend on the SPEC only (the lesson from B's death).
- **agent-D** after A+B+C merge: index/scripts front door + cli/e2e tests + demo capture. Narrower-than-original scope if any wave1 agent dies; relaunch post-merge, never retry whole.
- **Review posture**: expect the §4 categories to resurface; pre-write the tests that pin them (lock-grace steal young/aged/re-entrant, orphan parking unswept, EEXIST stamp-skip, forced-overlap fan-out barrier, redact-before-bound, exit-6 non-retryability, fail-open list refusal).
