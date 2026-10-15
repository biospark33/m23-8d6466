# J4 review round 2: Edge-Case Hunter (ECH2)

Diff: `git diff origin/dev...HEAD` (base 5b03a7b7, which includes J3). HEAD is 3f1d7e23.<br />
Focal runs:
- autonomy + observe-ontick + machine-state + steering: 200 pass, 0 fail, 21 s (`/tmp/j4-ech2.log`)
- cut-boundary alone: 5 pass, 4.7 s (`/tmp/j4-ech2-cut.log`)
- build-exedev-image: 45 pass, with the `348e5d4` pin green on the J3 base (`/tmp/j4-ech2-bid.log`)

After every run, `git status --porcelain --untracked-files=all -- _bmad-output/judgment .sandbox` was empty, and no `qds-j4-cut-*` or `l9-*` dirs were left in `os.tmpdir()`. Scratch probes are in `/tmp/ech2p/`.

## R1 verification (PATCH rows)

| Row | Verdict | Evidence |
|---|---|---|
| R1-01 | VERIFIED (caveat: ECH2-006) | `l9-repo-sweep-triage.ts:77-80`: with the default client (mode mock), records go to `<FACTORY_ROOT>/corpus/mock`. ab-report `--all` reads only top-level `*.jsonl`. |
| R1-02 | VERIFIED (caveat: ECH2-005) | `steering.ts:1398-1400` runs before the schema, at every point. It is reached only after `parseReply` succeeds, so fenced JSON, extra keys, `{"action":"compact","note":5}` and an array wrapper (balancedObject extracts the inner object) are all refused by origin. `Compact`, ` compact` and lookalikes such as `cоmpact` (Cyrillic о) fall to `rejectionDetail` and give `unrecognized action: <x>`, the same as pre-J4. A wrapper like `{"directive":{…}}` gives a schema reject, as it did pre-J4. The tripwire detail never reaches a resident prompt: the correction prompt is only for malformed replies, and grep finds no tripwire→promptContext path. |
| R1-04 | VERIFIED | The 10 s pair budget is real: `transport.ts:177-183` takes one absolute deadline for probe and cat. With the 40 s ask, the total is ≤ 50 s, under the 60 s tick deadline. `withCorpusLock` releases in `finally` (`host-pack.ts:477-485`). `RunLockReentrantError` and `TimeoutError` are mapped (`:403-405`). |
| R1-05 | VERIFIED as stated (fairness: ECH2-004) | `observe.ts:723-741`: the hook runs only when remaining ≥ 2×deadline, so after it at least 60 s of budget is left. A pass can still overrun only through a chain started just under budget, which is pre-existing behaviour. The hook adds nothing past budget−60 s. |
| R1-06 | VERIFIED for host-pack (L9 provenance: ECH2-006) | `host-pack.ts:136-148`. fleet is not compiled (`bun build --compile` covers only the box engine), so `import.meta.dir` is always a checkout. A run from another worktree writes into that worktree, which is the intended rule. |
| R1-07 | VERIFIED (armed caveat: ECH2-001) | `host-pack.ts:676-735`: misses and a held lock are kept, and keys are `runId/findingId`. |
| R1-08 | VERIFIED (caveats: ECH2-002, ECH2-003, ECH2-008) | Per-run shard, lock per shard, `l7StateRef` with tickKey excluded. The first-ever ask runs (`mine` is empty). A→B→A re-asks A (compared against the last record only), which is correct. A miss writes no record, so it never poisons the digest. |
| R1-09 | VERIFIED | `host-pack.ts:645`: only `status === "active"` asks. |
| R1-12 | VERIFIED | Register item (d) names `manifest_consistent` as provisional and provenance-only (`decisions.md:383`). |
| R1-13 | VERIFIED (caveat: ECH2-007) | `l9…:236-241` checks the key (path digest + brief digest + labeler) before the ask. A changed brief is re-asked. |
| R1-14 | VERIFIED | `host-pack.ts:345-347`. |
| R1-15 | VERIFIED (scope caveat: ECH2-009) | Not vacuous: a host-pack→L9 edge would fail module load in the child (non-zero exit), and the test also checks `existsSync` false after the rm. It took 4.7 s, and the tmp tree is removed in `finally`. `rmSync` removes the symlinks without following them, and `spawnSync` blocks, so the test timeout cannot skip the `finally`. |
| R1-16 | VERIFIED | `fleet-observe-pack.test.ts:78-114` injects all three dirs, and the no-pack case runs hook-free. |
| R1-17 | VERIFIED | `merge.ts` `appendRecord` → `TriageRecordSchema` only. A machine line in the file makes it fail loudly. |
| R1-19 | VERIFIED | `host-pack.ts:621-643`. |
| R1-20 | VERIFIED | `idPath` adds a `~digest` suffix. Non-finite scores are a miss and sort last in a total order. |
| R1-21 | VERIFIED | The walk is bounded by entry and depth limits, uses lstat, skips symlinks and skips node_modules and VCS dirs. |
| R1-23 | VERIFIED | `decisions.md:372-373` names both COPY-set files. The pin chain is 285156f→348e5d4, and the test is green. |
| R1-24 | VERIFIED | `host-pack.test.ts:812-860` (run green). |
| R1-25 | VERIFIED | Alias, `src/…` and absolute-path controls trip; real imports do not. |

No REGRESSED and no NOT-FIXED rows.

## Findings

### ECH2-001 [MED] Armed L8 re-admits a finding it already filtered (non-idempotent filter)
`src/autonomy/host-pack.ts:692` (`if (alreadyRecorded(...)) continue;`), `:733`
- Scenario: armed, pass 1 answers finding F as would-filter (it lands in `filtered` and is dropped). Pass 2 sees the same F. `alreadyRecorded` is true, so the loop `continue`s and F never enters `filtered`, so F comes back to deep adjudication. The armed result therefore depends on whether F was seen before. That `continue` also emits no line, so the per-finding record of the second pass is silent.
- Evidence: static reading. `filtered.add` happens only on the fresh-answer path (`:718`). Unreachable today because `PACK_SIGNALS_ARMED=false`, but this is the semantics the arming PR inherits.
- Fix: on already-recorded, look up the recorded disposition and noul from the existing record and apply the same `wouldFilter` rule. Alternatively, document fail-open-on-repeat explicitly. Emit an `already-recorded` line, as L9 does.

### ECH2-002 [LOW] L7 rename-aside fires on ANY read error, discarding a healthy shard's history
`host-pack.ts:417-423, 531-540`
- Scenario: `readCorpusOrThrow` wraps every error (EACCES, EMFILE/ENFILE, EIO), not just a torn or schema-invalid line, and l7Ask then renames the shard aside. A transient fd exhaustion (the suite already has a known EMFILE flake) moves a valid shard away. Its `state_ref` and duplicate history are lost, the next tick re-asks (paid in live mode), and the operator gets an `.unreadable-*` file that is not unreadable.
- Evidence: probe `/tmp/ech2p/probe.ts`, with `chmod 000` on a healthy shard. Output: `miss corpus-unreadable`, then the shard became `x-rx.jsonl.unreadable-<ts>`, then the same state gave `asked` again.
- Fix: rename only for a parse or schema failure, by distinguishing the `readLines` throw (SyntaxError or the "failed schema validation" error) from fs errnos. An fs errno should be a plain miss with no rename.

### ECH2-003 [LOW] L7 pre-ask read is lenient and its append is strict: one triage line in a shard means a paid ask every tick, misattributed `judge-failed`, and never set aside
`host-pack.ts:531` (`readCorpusRecords`, the union), `:570` (`appendMachineStateRecord`, strict), `:406`
- Scenario: a schema-valid triage line ends up in a run's shard. `appendRecord` permits this whenever the shard is empty or holds only triage lines, which is the misrouting R1-17 was about. The union reader accepts the line, the ask is paid, and then the strict append throws a plain Error. `missReason` reports that as `judge-failed`. There is no rename-aside, so the loop repeats every tick.
- Evidence: probe `/tmp/ech2p/probe2.ts` gave `t1/t2/t3 → miss judge-failed`, with judge call count 1, 2, 3.
- Fix: read the shard with `MachineStateRecordSchema` (the strict reader, matching the append) so the mismatch is a pre-ask `corpus-unreadable`. Or run the append's schema check before `judge`.

### ECH2-004 [LOW] R1-05 bounds the overrun but not fairness: hooks can still use about budget−120 s per pass
`src/fleet/observe.ts:723-731`
- Scenario: candidates run oldest-first, deterministically. With 14 or more unsettled residents whose hooks are slow (live ask near 40 s plus a 10 s read), cumulative hook time pushes the settled runs at the tail (waiting for teardown) into the last ≤120 s every pass. Pre-J4, an unsettled candidate cost about 20 s of reads. The tail is not skipped forever, but it gets only one or two chains per pass. With `wallClockBudgetMs` < 120 s the hook is skipped every time (fleet.ts never passes one, so this is test-only).
- Evidence: arithmetic. 25 × (20 s + 60 s) = 2000 s, against a 1200 s budget. Today the production hook is mock-only, so it is cheap.
- Fix: cap cumulative hook time per pass (for example ≤ budget/4, tracked in observe), or run hooks after the candidate loop with whatever budget remains.

### ECH2-005 [LOW] Tripwire detail drift: action-less or non-string-action replies now name `compact` in the journal row
`src/phase-engine/steering.ts:137-145`, `:467-476`
- Scenario: for `{}`, `{"action":5}`, `{"action":null}` or `{"directive":{…}}`, `rejectionDetail` falls through to `formatZodIssue`. Zod's discriminator message enumerates the union, so it now ends `… | 'abort' | 'compact'`. The `gate_bypass_attempt` row's detail therefore differs from pre-J4 and advertises `compact` in journal and harvest evidence. The parity test covers only a string unknown action (`frobnicate`).
- Evidence: `bun /tmp/ech2-zod.ts` printed `Invalid discriminator value. Expected 'proceed' | 'retry' | 'select_roster' | 'abort' | 'compact'`. It does not reach the resident (checked).
- Fix: when `action` is absent or not a string, emit a harness-authored detail that does not enumerate the union. Add `{}` and `{"action":5}` to the parity test.

### ECH2-006 [LOW] L9's default provenance is still cwd-relative, and a mode-less judge writes to the measured corpus
`l9-repo-sweep-triage.ts:181` (`new JudgmentClient({ provenanceDir: deps.provenanceDir })` with undefined → `DEFAULT_PROVENANCE_DIR`, cwd-relative), `:77-80`
- Scenario: the header says defaults anchor to FACTORY_ROOT "same rule as the pack core", but only the corpus dir is anchored. In addition, L9's `Judge` interface has no `mode`, so an injected structural judge without `corpusDir` resolves to the live, top-level measured corpus and writes `arm: jev` records there.
- Fix: `provenanceDir: deps.provenanceDir ?? resolve(FACTORY_ROOT, DEFAULT_PROVENANCE_DIR)`. Add `mode` to L9's `Judge` (as host-pack does), or default unknown to the mock dir.

### ECH2-007 [LOW] L9: already-recorded hotspots use up cap slots and fall out of the recorded would-order
`l9-repo-sweep-triage.ts:227, 236-241, 259`
- Scenario: (a) the `i >= MAX_HOTSPOTS_PER_CALL` index counts recorded, skipped entries, so once the top 50 are recorded, hotspots 51 and later are `capped` on every call and never asked. (b) Recorded hotspots get no `worthByPath` entry, so they sort as −1. After the first call, the logged `l9-triage-order` (L9's only signal) collapses towards the deterministic order and stops reflecting the recorded answers.
- Fix: count only issued asks against the cap. Seed `worthByPath` from the existing record (the `worth_brief=` value in its rationale, or a stored field).

### ECH2-008 [LOW] L7 dedupe and state-unchanged ignore `answer_mode`
`host-pack.ts:541-546`
- Scenario: mock and live records share one shard and one labeler. When live mode lands, an in-flight run whose last record is a mock answer for the same state skips the live ask (`state-unchanged`) for the rest of the run. Mid-run state is the seed (R1-03), so it stays unchanged.
- Fix: include `answer_mode` in the `mine` filter (or in `state_ref`).

### ECH2-009 [LOW] Cut-boundary test scope
`tests/autonomy/l9-cut-boundary.test.ts:60, 105-118`
- Scenario: (a) The child runs only `bun test tests/autonomy/`. There is no `tsc`, and the static edge walk scans `src/` and `scripts/` but not `tests/`, so a future test elsewhere that imports L9 breaks the real cut while this test stays green. (b) Every non-COPY top-level entry is symlinked, including writable `.sandbox`, `docs` and `config`. A future autonomy test writing ROOT-relative into those would write into the real repo. Today none does: the tree was clean after the runs.
- Fix: add `tests` to the edge walk (excluding the L9 test). Optionally run `bunx tsc --noEmit -p` in the child. Copy, or skip, `.sandbox` rather than symlinking it.

### Not findings (probed clean)
- **J3 interaction.** No shared lock: J3 uses `routing-log-writer` under the store's `.sandbox`, J4 uses `corpus-writer` per shard or corpus dir. No shared corpus path. No log-event collision: J3 emits `routing-decision`/`routing-skip`, J4 emits `l7-ask` and the other leg events. Both emit JudgmentClient's own `operation:"judge"` line, but no reader keys on it. Provenance ids are distinct: J3 uses the dispatch requestId, J4 a random id. One divergence is J3-owned: J3's router provenance is cwd-relative (`router.ts:510-516`) while J4's is FACTORY_ROOT, so one fleet process can write provenance into two roots. fleet.ts routing and the onTick wiring touch disjoint verbs (dispatch vs observe).
- **Shard path safety.** runIds pass `RUN_ID_RE` in observe's `acquireRunLock` before `onTick` runs, so `..`, `.` and an empty runId cannot reach `l7ShardDir`.
- **Concurrent sweeps on the same run.** They are serialized by observe's per-run lock. An orphaned hook cannot outlive its tick (≤ 50 s < 60 s).
- **Stale lock.** A SIGKILL mid-ask leaves `<shard>/corpus-writer.lock`, and that run's L7 then misses `corpus-locked` until an operator runs `rm`. The miss line does not say "stale". This is per-run only. A note, not a finding.
- **"Recording-only".** No path writes steering while unarmed, the resident compact is refused at every point, and nothing outside `solicit` parses `SteeringDirectiveSchema`.

**Verdict: R1 fixes hold (all 20 PATCH rows VERIFIED, 0 regressed). Fresh: 0 BLOCKER, 0 HIGH, 1 MED (armed-only L8 semantics), 8 LOW. Mergeable once ECH2-001 is fixed or explicitly documented. ECH2-002 and ECH2-003 are cheap hardening worth doing in the same pass.**
