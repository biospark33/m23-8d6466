# Blind Hunter — Round 2 (M2.3 combined memory live round)

Diff reviewed: `/tmp/m23-review/full-r2.diff` (1851 lines; 8 files — 2 new source/test files, 1 roster fixture, plus evidence/Dockerfile/sprint-status/timeout tweaks). Findings below are provable from the diff text alone; file:line references are into the NEW files.

## Findings

- **Primary in-box recall verdict is echoable — the marker the assertion greps for is handed to the worker inside the task text** — **HIGH** — `tests/fleet/e2e/memory-combined.live.test.ts:689` (task text at :419-420, impossibility claim at :650-653)
  - Evidence: task `"Step 1: call the kg_recall tool exactly ONCE with bank \"${base}\" and query \"${marker}\" ... result.summary states how many memories came back and quotes one line of the returned data verbatim"`; verdict `expect(markerHits.length).toBeGreaterThan(0);` over `payloadText(p).includes(round.marker)`; comment: `"a worker that never obtained the marker content cannot satisfy it — this seam owns the kg_recall verdict."`
  - Why wrong: `marker` is interpolated into the very task text the worker receives, so any worker output that echoes its own query (`query was "<marker>"`) satisfies `includes(round.marker)` with **zero** memories returned. A no-refusal / empty-recall round green-lights: refusals and truncations are only pushed to evidence, never judged ("RECORD-ONLY ... the trace-db primary below"), so nothing else in the leg fails on empty results. The comment's impossibility claim is false, and this seam is stated to own the verdict.

- **"Staged roster ≡ committed fixture" assertion is tautological; the drift it claims to prevent is never checked** — **MEDIUM** — `tests/fleet/e2e/memory-combined.live.test.ts:458` (copy at :389, existence-only check at :382-386)
  - Evidence: `copyFileSync(fixture, join(rosterDir, "roster.yaml"));` then `expect(sha256Hex(readFileSync(join(rosterDir, "roster.yaml"), "utf8"))).toBe(sha256Hex(readFileSync(fixture, "utf8")));` with comment `"keeps the staged gate-read roster and the in-box-loaded one from drifting"`.
  - Why wrong: the staged file is a copy of the same `fixture` path the assertion reads back — the comparison can never fail (dead assertion). The in-box `spec.roster` load reads the tree at `ctx.sha`; the only pre-spend check on that copy is `git cat-file -e ${ctx.sha}:${ROSTER_FIXTURE_REL}` — **existence, not content**. A working-tree fixture edited after the pinned SHA passes every gate while the box loads a different roster — exactly the drift the comment claims this assert prevents.

- **Evidence-write failures are silently dropped on failing legs (L1 and L2)** — **LOW** — `tests/fleet/e2e/memory-combined.live.test.ts:550-551` and `:729-730`
  - Evidence: in both legs' tails: `if (failure !== undefined) throw failure;` followed by `if (evidenceProblems.length > 0) throw new Error(evidenceProblems.join("; "));`
  - Why wrong: when a leg fails **and** its evidence write refused (the secret-survivor path in `writeM23Evidence`), the evidence problem is lost — the original error is thrown first and the `evidenceProblems` branch is unreachable. Only stderr ever saw it. L3 handles this correctly by feeding `problems` into `settleRun`; L1/L2 do not.

- **Hygiene verdict is blind to control chars on unparseable `[kg-recall]` lines** — **LOW** — `tests/fleet/e2e/memory-combined.live.test.ts:635` (parser catch at :282-286)
  - Evidence: `kgRecallEvents` computes `rawControlChars` for every candidate line, but the catch path pushes `{ event: "unparseable", line: line.slice(0, 120) }` — discarding the computed flag; the verdict is `hygiene: events.every((e) => e.event.rawControlChars !== true)`, which sees `undefined !== true` → passes.
  - Why wrong: a control-char-laden torn line — precisely the case the F10 hygiene check exists to catch — is recorded as "unparseable" AND passes the hygiene check; the check can never fail on torn lines.

- **Roster grants the credential-carrying fixer `src/`+`tests/` write access while the round's task forbids any modification** — **LOW** — `config/rosters/memory-live.roster.yaml:35` vs `tests/fleet/e2e/memory-combined.live.test.ts:420`
  - Evidence: roster, under the banner `# Least privilege on a box holding a memory credential (story binding)`, sets `writes: ["src/", "tests/"]` for the fixer role (the role the DD-16 pair enters); the dispatch_task text instructs `"Work strictly alone and modify nothing in the repository."`
  - Why wrong: the file's own stated binding is least privilege for the role holding the memory credential, yet that role's `writes` is overridden upward from the `defaults: writes: []` with no task that can use it — the grants contradict both the task text and the fixture's stated principle in the same diff.

## Checked, no finding

- Probe battery classification ladder (`fireProbe`): 2xx → not-refused, in-set `error.code` → refusal, else transport-class — direction correct; consistent with INV-M3-2 (200 = answer, never refusal).
- `allRefused` composition, `EXPECTED_REASONS` mapping, probe order, and the 4-mint count (keyA, keyB, ttl, revoked — no-auth mints none) all line up with the unit test's assertions.
- TTL wait loop under both real and injected stepping clocks: `while (now() < deadline)` with wall-clock cap; first-check-exit math for `CLOCK_STEP_MS = 10_000` vs `TTL + SKEW = 10_000` checks out (loop exits on `==`).
- Battery cleanup ordering: `revokeAll` (per-token catch, deduped) before `deps.ledger.close()` in `finally`; unit test's post-battery "already-gone" expectations are reachable via the stub's separate handle on the same ledger path.
- L3 audit-order assertions use first-occurrence `findIndex` with a preceding `>= 0` guard on `revokeAt` before the `>` comparisons.
- L3 `finally` backstops each guarded on their own armed ids; `bodyTeardownOk` is set before the AC7 audit walk, so a late assertion failure cannot trigger a duplicate teardown.
- L2/L3 hollow-leg guards (`ctx === undefined || runId === "" || ...`) precede every use of the destructured round state.
- Timeout arithmetic: leg ceilings [2.7M, 2.4M, 3.6M] ms sum to 8.7M ms; per-verb timeouts (1.2M dispatch, 300s run/settle/harvest/reharvest/teardown, 180s backstop, ~30s battery cap) nest inside their leg ceilings; `BOX_WORST_MICRO_USD` derivation matches the constants.
- Dockerfile re-pin: new `OPENRIG_TREE_SHA256` value matches the hash quoted in the added refusal comment; comment internally consistent.
- `failure-recovery.test.ts` timeout fix: comment arithmetic (2s + 4s retry ladder > 5s bun default) is consistent with the change; options-before-fn placement matches the runner signatures used elsewhere in the diff.
- Secret-scrub paths (`scrubDeep`, `writeM23Evidence` gate, CLI `mgrun-` self-fail with payload suppression) contain no obvious inversion or bypass — the CLI's catch-path stderr dump is of the already-gate-passed payload.
