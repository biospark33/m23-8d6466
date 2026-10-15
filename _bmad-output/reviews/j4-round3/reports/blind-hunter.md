# J4 Round 3 — Blind Hunter

Scope: code portion of /tmp/j4-r3.diff (scripts/corpus/*, scripts/fleet.ts, src/autonomy/host-pack.ts, src/autonomy/l9-repo-sweep-triage.ts, src/fleet/observe.ts, src/phase-engine/steering.ts, tests). Review artifacts, story, and spec files were not read.

## Verified clean (claims checked against code)

- **observe onTick after lock release**: `pendingTick` is recorded only in the unsettled arm (observe.ts ~756). The hook runs after the `finally` that calls `releaseRunLock` (observe.ts ~825). A throw, rejection, or timeout is caught and logged. Counters are untouched.
- **Budgets**: the per-call deadline is 60 s (`ON_TICK_DEADLINE_MS`). Two guards skip the hook: fewer than 2× deadline remaining in the pass, or the pass-level hook share (0.25 of the pass budget) already spent. The production hook stays inside its deadline: `readBoxFile` gives the probe+cat pair one 10 s budget (transport.ts:177), and `l7Ask` caps the judge call at 40 s with `withTimeout`. Total ≤ ~50 s, under 60 s, so observe does not abandon the production hook.
- **Corpus lock**: `withCorpusLock` releases in `finally` on every path, including the deadline path. A lock left by process exit is released by run-lock's `process.on("exit")` handler. A reentrant acquire in the same process, or a lock held by another process, becomes a `corpus-locked` miss.
- **Orphaned promises**: `withTimeout` attaches a no-op catch before the race (timeout.ts), so there are no unhandled rejections.
- **Shard path**: `l7ShardDir` sanitizes the runId. `MACHINE_STATE_ID_RE` requires a leading alphanumeric, so `..` cannot reach `l7Ask`. Hook runIds have already passed `acquireRunLock`'s strict `RUN_ID_RE`. No traversal path.
- **Journal format**: the journal is a single JSON document, flushed atomically with tmp+rename (journal.ts), so `JSON.parse` of the whole file is correct despite the `.jsonl` name.
- **Mock default**: `JudgmentClient` defaults to mock (client.ts:102). Production `observeTickHookFor(undefined)` makes no paid asks.
- **steering**: a resident-originated `compact` is refused before the schema accepts it, at every point. The `replaceAll` strip is exact because `compact` is the last union member.
- **Tests**: tests use mkdtemp dirs, except the case in BH3-005.

## Findings

### BH3-001 [LOW] `deterministicOrder` comparator is not a total order for NaN scores
`src/autonomy/host-pack.ts:381-383`. `b.score - a.score || pathCmp` gives NaN for a NaN score, or for `Infinity - Infinity`. NaN is falsy, so those pairs fall through to the path comparison while other pairs compare by score. The comparator is then intransitive, and `orderSweepHotspots`, documented as returning "the deterministic order", can return an order that depends on the input order. The L9 copy already fixed this with `sk()` (l9-repo-sweep-triage.ts:1188-1196). The core copy did not.
Fix: use the same non-finite → `-Infinity` key in host-pack, or reuse one shared comparator.

### BH3-002 [LOW] L8 holds the shared corpus lock for N × 40 s, with no total bound
`src/autonomy/host-pack.ts:713-772`. `l8Prefilter` takes `CORPUS_LOCK_ID` on the corpus dir and keeps it for the whole findings loop. Each ask is capped at `l7AskDeadlineMs` (40 s), but the number of findings is not capped. With 30 slow findings, the lock is held for about 20 min. Every other corpus writer is refused rather than queued: `merge.ts` main, `observe-round`, and the L9 ranker on the same mock dir. L9's `rank()` has the same shape (up to 50 asks at about 2×30 s each, l9:1277-1324). No production caller exists today, so this is LOW.
Fix: cap findings per call (like `MAX_HOTSPOTS_PER_CALL`), or take the lock only around read-dedupe-append and ask outside it.

### BH3-003 [LOW] A record-build failure after a paid ask is classified `judge-failed`, and L8 re-asks it on every pass
`src/autonomy/host-pack.ts:719-724, 745-760` (L7 is the same at 589-602). The pre-ask checks cover only `author` and text length. `lens` goes into `label` (`z.string().min(1)`) and `diff_context_ref` without validation. A finding with `lens: ""` passes the pre-ask checks, gets a real answer, and then `TriageRecordSchema.parse` throws a ZodError. `missReason` maps that to `judge-failed`, which is misleading. No record lands, so `recordedFor` never finds the finding, and the next call pays for the same ask again, indefinitely. An L7 envelope whose `created_at` fails `isoTimestamp` follows the same loop, and `state-unchanged` cannot stop it because nothing was recorded.
Fix: validate `lens` before the ask. Give post-answer parse/append failures their own miss reason, e.g. `record-invalid`.

### BH3-004 [LOW] After an `ask-deadline` miss, the abandoned judge can still complete, paid and unrecorded, and the next tick re-asks
`src/autonomy/host-pack.ts:580-584`. When `withTimeout` fires, the lock is released, but `client.judge` keeps running. If a live 429 reply carries a Retry-After longer than about 10 s, attempt 1 (15 s) plus the delay plus attempt 2 can exceed 40 s. The call then finishes after the deadline: provenance is emitted and the cost is paid, with no corpus record. With no record there is no `duplicate` or `state-unchanged` short-circuit, so every later tick under sustained throttling pays again. Today this is mock-only in the CLI (the header documents R1-22), so it is LOW.
Fix (at arming): pass an AbortSignal into `judge`, or cap the Retry-After delay so attempts plus delay stay ≤ `L7_ASK_DEADLINE_MS`.

### BH3-005 [LOW] The R2-19 injected-pack test leaves the corpus dirs on their real-tree defaults
`tests/autonomy/fleet-observe-pack.test.ts:150-158`. The injected `judgmentPack` sets only `provenanceDir` and `readBoxFile`. `machineStateCorpusDir` and `corpusDir` therefore resolve to `FACTORY_ROOT/_bmad-output/judgment/corpus/...`, against the `PackDeps` contract ("Tests MUST set it"). The test writes nothing only because the stub returns `absent`. If someone edits the stub to return a seeded journal, the test would write into the repo.
Fix: also set `machineStateCorpusDir` and `corpusDir` to tmp dirs.

## Counts
BLOCKER 0 · HIGH 0 · MED 0 · LOW 5

**Verdict: APPROVE.** No reachable defect on the production path, which is the mock-default, unarmed L7 hook. The LOWs are hardening items for the unwired L8/L9 legs and for arming.
