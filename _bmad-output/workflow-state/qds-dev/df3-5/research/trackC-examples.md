# DF3.5 Phase-2 Research — Track C: Example Analysis (completed-story precedents)

**Date:** 2026-08-31 · **Branch:** feature/df3.5 · **Scope:** DF3.1/DF3.2/DF3.4 Dev Agent Record
conventions, fake-driver e2e helper patterns, integration-spec items naming DF3.5, and every
item explicitly deferred INTO DF3.5.

---

## 1. Dev Agent Record conventions (df3-1, df3-2, df3-4)

### Common skeleton

All three story files keep the spec sections untouched and append implementation evidence under
`## Dev Agent Record`, followed by one `## Review Findings — round N` section per adversarial
review round. No story carries an explicit "Agent Model" field — agent provenance is recorded
only as prose in the record header.

### DF3.1 (`stories/df3-1-dispatcher-core-verbs.md:369-440`) — the canonical template

- **Header:** `**Implemented:** 2026-08-21, branch \`feature/df3-1-fleet-dispatcher-core-verbs\`,
  waves of parallel subagents (research ×7 → architect → 3 TDD implementation agents →
  orchestrator finish).`
- **Files list:** `**Files (11 at implementation; 23 after review round 2 — see "Declared FTM
  deviations" ...):**` then one bullet per file, each tagged `(net-new)` / `(additive)` /
  `(additive, **FTM deviation — 1 line**)` with a one-line description carrying `file:line`
  citations. The header sentence itself was corrected in-place when the original claim proved
  false (the correction is left in the text, not silently rewritten).
- **Decisions:** `**Decision 1 (D1 overturned, verified against source — CORRECTED 2026-08-21,
  review round 2):**` … numbered Decision blocks; superseded decisions keep the ORIGINAL text
  quoted in italics and are marked `SUPERSEDED <date>, review round N`.
- **Tests line:** `**Tests:** \`tests/fleet/\` 84/84 green · full \`tests/providers/ +
  tests/phase-engine/\` 1106 green (one first-run usage.test.ts env flake did not reproduce on
  rerun; passes solo) · \`bunx tsc --noEmit\` clean · \`bunx biome check\` clean (12 files) ·
  advisory gates OK ...` — counts, flake dispositions, and every gate on ONE line.
- **E2E demo block:** `**E2E demo (DoD, fake driver, captured verbatim):**` — a fenced
  `console` block with literal `$ bun scripts/fleet.ts dispatch --driver fake < brief.json →
  exit 0` lines and the raw JSON acks, followed by a prose sentence on what the logs showed.
  The DoD checkbox (story :365-367) requires exactly these three outputs "captured in the Dev
  Agent Record".
- **Research provenance:** one line pointing at `_bmad-output/workflow-state/qds-dev/df3-1/`.
- **Review rounds:** `## Review round 2 — BMAD adversarial code review, 2026-08-21` opens with a
  `**Method.**` paragraph (N parallel review agents over chunked PR diff, raw→deduped→
  patched/deferred/dismissed tallies), then themed subsections, then checkbox ledgers.

### DF3.2 (`stories/df3-2-fanout-best-of-n.md:317-376`)

- Record organized **per wave**: `### Wave 2, agent D — CLI wiring + verb registration + e2e
  demo (2026-08-23)`.
- **Landed (this wave):** is a `| File | Change |` table (one row per touched file, test files
  included).
- **Gate evidence:** one paragraph: scoped counts, full-suite counts `3308 pass / 8 skip /
  1 fail` with the one fail proven pre-existing by stash-and-rerun, tsc/biome, GitNexus impact
  + detect_changes. A later "Story-evidence reconciliation" addendum reconciles per-wave counts
  against the single close-gate run.
- `### MANDATORY e2e demo (DOD) — captured verbatim` — fenced block of `===== COMMAND:` entries
  with verbatim stdout, ending with a derived summary (`.sandbox/runs — three CLOSED records
  with three DISTINCT keyHash values`). Notes the demo was driven "through the real CLI front
  door (`scripts/fleet.ts run()` — the exact function `import.meta.main` binds to argv)".

### DF3.4 (`stories/df3-4-approval-gate-attach-steering.md:377-500`)

- No "Implemented/Files/Tests" preamble; instead fixed subsections:
  - `### Deviations from the story spec` — a `| # | What the story says | What we built |
    Evidence |` table (9 rows), every Evidence cell carrying `file:line` proof, evidence "is
    code, not reasoning".
  - `### Guardrail waiver — Scope Enforcement (High), ACCEPTED` — Item / Why unavoidable /
    Why it is safe / Precedent.
  - `### Scope-list gap`, `### Boundary conditions — stated, not coded around`,
    `### Documented ceilings, not defects`, `### Sprint-level issue — raised, not fixed`,
    `### Reference-repo liftability` (honest "nothing rated liftable" + per-repo proof greps),
    `**The real reuse is in-repo**` (numbered reuse list with `file:line`).
- Review rounds 6→10 each open with the same method paragraph
  (`10 parallel reviewers … 142 raw findings → 61 unique … Final gate: **4090 pass / 0 fail**
  (4134 tests, 133 files), \`tsc\` 0, \`biome\` clean …`) and use the checkbox ledger:
  `- [x] [Review][Patch|Decision|Defer|Dismiss] <one line>`.
- Each round ends with a `**Gates (final):**` / `**Verification:**` line; round 10 ends with
  `**Acceptance audit:**` (AC-by-AC VERIFIED/PARTIAL with clause citations) and `**Follow-up
  GitHub issues**` (#180, #181).

**Convention summary for DF3.5's Dev Agent Record:** header with date/branch/wave provenance →
files list (net-new/additive tags, per-file one-liners) → numbered Decision blocks with
corrections left in place → single Tests line with counts + flake dispositions + tsc/biome/
detect_changes → `E2E demo (DoD, fake driver, captured verbatim)` fenced console block →
research-provenance pointer; review rounds appended as dated `## Review Findings` sections with
method paragraph, `[Review][Patch/Defer/Dismiss]` ledger, final gates line.

---

## 2. Fake-driver e2e helper patterns (exact files)

### (a) In-process CLI runner — `tests/fleet/cli.test.ts` (DF3.1, the primary precedent)

- Describe block `scripts/fleet.ts (DF3.1 CLI)` at `tests/fleet/cli.test.ts:515`.
- **Run the CLI:** `runCli = (argv, d?) => run(argv, out, d, errOut)` (`cli.test.ts:612`) —
  calls `run()` imported from `scripts/fleet.ts` directly (the exact function
  `import.meta.main` binds to argv); never spawns a process.
- **Fake driver injection:** `deps(briefJson)` (`cli.test.ts:562-590`) builds
  `Partial<FleetDeps>`: `new FakeDriver(boxesDir)`, `new FakeKeyApi()`,
  `new RunRecordStore(runsDir)`, `ledgerFactory: () => goodLedger()` (from
  `tests/fleet/helpers.ts:81`), `readBrief: async () => briefJson`, `repoRoot: dir`,
  `lockPath: join(dir, ".sandbox", "fleet.lock")`. `beforeEach` (`cli.test.ts:526-552`) mkdtemps
  per case and redirects `QDS_RUNS_DIR` / `QDS_FAKE_BOXES_DIR`; `afterEach` restores env and
  `rmSync`s the tmpdir.
- **Capture stdout:** three arrays (`cli.test.ts:519-523`): `captured` (interleaved, what a
  terminal shows), `outOnly` (stdout only), `errCaptured` (stderr only); sinks `out`/`errOut`
  push into them; `reset()` clears; `text()` joins.
- **Parse a runId:** `const { runId } = JSON.parse(captured.find((l) =>
  l.includes("runId")) as string) as { runId: string }` — `cli.test.ts:1915` (also :1956,
  :1047).
- **Dispatch→…→teardown chain:** `test("e2e: dispatch → harvest → teardown, …")`
  `cli.test.ts:1908-1944`: dispatch (exit 0) → parse runId → `reset()` →
  `runCli(["harvest", "--driver", "fake", "--dir", runsDir, runId], shared)` → `reset()` →
  `runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)` →
  `expect(text()).toContain(\`torn down: ${runId}\`)`. Shares ONE `deps` object across verbs so
  store/driver state carries over.
- **Declared-exit-code contract binding:** `test("the help text's per-verb exit-code table is
  bound to codes the CLI really returns")` (`cli.test.ts:684+`) — drives each verb to each of
  its registry-declared codes via a `record(verb, argv, deps)` helper. This is the closest
  existing shape to DF3.5's skill-contract test.

### (b) Out-of-process real spawn — `tests/fleet/gate-verbs.test.ts` (DF3.4, D2 describe)

- `describe("D2 — attach --message and its `-` stdin sentinel, out of process")` at
  `gate-verbs.test.ts:1814`.
- Helper `cli(args, pipe?)` (`:1820-1837`): builds
  `exec bun ${q(CLI)} ${args.map(q).join(" ")}`, spawns
  `Bun.spawn(["sh", "-c", pipe ? \`${pipe} | ${cmd}\` : cmd], { cwd: REPO, env: childEnv(),
  stdout: "pipe", stderr: "pipe" })`, then
  `const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(),
  new Response(proc.stderr).text()])`. Shell-quote helper `q()` at `:1817`. Piping goes through
  a REAL `sh -c` FIFO because `Bun.spawn({stdin:"pipe"})` delivers a socket, which is not what
  an operator's shell does (`cli.test.ts:1341-1359` documents the same finding).
- Used when the property under test is the process exit code or fd-0 behaviour, which an
  in-process `run()` call cannot observe.

### (c) Registry exact-shape snapshots — `tests/fleet/verbs.test.ts`

- `EXPECTED_FLAGS` / `EXPECTED_EXIT_CODES` tables, per-verb `each verb has exact shape` pin,
  `expectFlagLines` render pairing (updated deliberately for `VerbFlag.note?`, round-6 D2
  closure). DF3.5's contract test must stay byte-compatible with these pins.

### (d) Live harness — `tests/fleet/e2e/live-harness.ts` (NOT for fake driver)

- `runFleet()` (`:184`), `spawnFleet()` (`:279`), `runFleetWithToken()` (`:232`),
  `preflight()`/`liveGate()` — used only by the `QDS_E2E_LIVE`-gated `tier*-*.live.test.ts`
  files. Not applicable to DF3.5's fake-driver DoD e2e, but its `runFleet` subprocess shape is
  the precedent if the skill-contract test wants real spawns.

**Recommendation implied by precedents:** DF3.5's mandatory e2e (story `df3-5` :243-246) can
run entirely in-process via pattern (a) — parse the documented command line out of the SKILL.md
bodies, feed argv to `runCli`, share one `deps()` across dispatch and observe, and assert the
parsed runId equals the positional passed to observe. Pattern (b) is needed only if the test
must prove the spawned-process exit codes.

---

## 3. Integration-spec items naming DF3.5 (df3-1 + df3-4)

### `_bmad-output/workflow-state/qds-dev/df3-1/integration-spec.md`

- **C6 (:659-695) — the registry shape IS DF3.5's contract.** The historical
  entry shape was `{verb, summary, flags:[{name,required,valueType}], exitCodes}`
  with "no extra keys". The current closed shape widens the flag object to
  `{name, required, valueType, note?}` (`VerbFlag.note?` is additive and
  optional). DF3.5's contract test consumes this widened shape. Amendments that
  are normative for DF3.5:
  - Exit codes are per-verb and MUST be read from each verb's OWN declared set, not a shared
    one: status `[0,1,2,4]`, harvest `[0,1,2,4,5,6]`, teardown `[0,1,2,4,5,6]`, dispatch
    `[0,1,2,3,5,6]` (round-9 amendment added `6` = "landed but unreportable" to dispatch).
  - `--driver` is `required: true` on all four DF3.1 verbs (B2 amendment): "A generated DF3.5
    skill built from a registry that called `--driver` optional would exit 2 on every call."
- **C4/B6 amendment (:493-495) — StatusRow truth list.** "`orphan`" state plus optional
  `createdAt`, `boxAlive?`, and round-9's `listUnavailable` / `recordsSkipped` row states are
  "normative now; DF3.5's contract test must be written against this list, not the original
  four."

### `_bmad-output/workflow-state/qds-dev/df3-4/integration-spec.md`

- **:194-200 — registry-as-contract, additive entries.** "The registry is a **CONTRACT**, not
  documentation: the CLI validates accepted flags against it, and DF3.5's skill-contract test
  compares declared exit codes against what verbs actually return. DF3.4 appends
  `approve`/`reject`/`attach` additively (DF3.2's `fanout`/`rank` are the precedent for
  additive entries with no DF3.1-owned edit)."
- **:202-205 — the `--driver` exemption question.** `rank` takes no driver (reads records
  only); `approve`/`reject` were an open question, `attach` clearly does. **Resolved
  downstream:** df3-4 state.yaml :896-900 records that approve/reject were briefly unreachable
  BOTH ways ("the DF3.5 hazard realized") and the final posture was fixed by W5b — DF3.5's
  skills must take each verb's declared flag table from the registry, never assume `--driver`.

### `_bmad-output/workflow-state/qds-dev/df3-4/state.yaml`

- `:27` — `downstream_blocked_on_this: [DF3.5, DF5.3, DF5.4, DF6.1]`.
- `:686-691` — the fd-0 allowlist accepts FIFO/regular-file/**socket** precisely because "it
  would break DF3.5, which ships factory skills over this exact CLI … A generated skill spawns
  programmatically." DF3.5 skills may therefore pipe tokens/messages from any programmatic
  parent (Bun/Node `stdio:'pipe'` sockets included) — do not document TTY-only instructions.
- `:899` — "BOTH DIRECTIONS - the DF3.5 hazard realized" (approve/reject unreachable with and
  without `--driver`); closed by W5b. The hazard class — a registry/CLI drift that a generated
  skill hits first — is exactly what DF3.5's contract test exists to catch.

---

## 4. Items deferred INTO DF3.5

### From `_bmad-output/plans/2026-08-29-df3-4-deferred-remediation.md` — D2 (the only one)

- Status board (:61): `| D2 | \`--message -\` undeclared sentinel; \`VerbFlag\` cannot express
  it | MED | A | ☑ |` — **CLOSED 2026-08-28 (Session A)** (:465). It was labelled
  `**Blocks:** DF3.5` (:429).
- What DF3.5 inherits (:476-478, verbatim conclusion): "`VerbFlag` now has an optional
  `note?: string`. A flag without one is byte-identical to before, so a three-column consumer
  is unaffected; a generated skill that surfaces the note gets the `-` sentinel right."
- The closed key set is `{name, required, valueType, note?}` — `tests/fleet/verbs.test.ts`
  `each verb has exact shape` enumerates it exactly (no free-text `description` column can
  arrive unnoticed), pins the `--message` note **verbatim** ("the value `-` reads the message
  from stdin", `gate-verbs.test.ts:1839`), and forbids empty/newline-bearing notes.
- The `-` question is DECIDED (:480-489): the literal one-character message `-` IS reachable —
  omitting `--message` also reads stdin, so `printf -- '-' | fleet attach <run-id> --driver <d>`
  sends `-`. Skills must not document `-` as unsendable.
- `renderHelp` appends ` — <note>` on the flag's OWN line (a wrapped second line would parse as
  a phantom flag) — relevant if DF3.5's skills quote `--help` output.
- Also plan :99: "DF3.5 generates skill contracts from the registry D2 fixes."
- No other item in the plan (D1, D3–D11) names DF3.5 as owner or consumer.

### From the df3-4 story file itself — the exact deferral text

`df3-4-approval-gate-attach-steering.md:622`, under `### Deferred (pre-existing or out of
scope)`, verbatim:

> - [x] [Review][Defer] `--message -` is an undeclared stdin sentinel. It cannot be dropped
>   (the story specifies it verbatim) and cannot be declared (`VerbFlag` is the closed shape
>   DF3.5's skill-contract test compares against). Surfacing it in `--help` needs a
>   `VerbFlag.note?` field — a contract-shape change owned by DF3.5.

Note the `[x]` and the remediation plan's Session-A closure: the shape change already LANDED
(`src/fleet/verbs.ts` carries `note?: string`). `--message` was the original D2 case and remains
one of several note-bearing flags (7 flags across 5 verbs today). What remains DF3.5's obligation
is only to **write its contract test against the widened closed set** and to have
`factory-observe`'s attach documentation render the note (or at least the sentinel behaviour)
correctly.

---

## 5. Verdict

- **Dev Agent Record format** is settled and DF3.5 should clone DF3.1's skeleton (Implemented
  header → Files with net-new/additive tags → numbered Decisions → one-line Tests counts →
  fenced verbatim e2e console block → research-provenance pointer), appending per-round
  `## Review Findings` sections with the `[Review][Patch/Defer/Dismiss]` ledger.
- **Fake-driver e2e helpers already exist and are directly reusable:** in-process
  `runCli`/`deps()` pattern at `tests/fleet/cli.test.ts:515-618` + runId parse idiom at
  `cli.test.ts:1915`; out-of-process `cli()` spawn at `tests/fleet/gate-verbs.test.ts:1814-1837`
  if process-level exit codes must be asserted; registry snapshots at `tests/fleet/verbs.test.ts`
  are the exact-match pins the new skill-contract test must not drift from.
- **Explicitly deferred INTO DF3.5:** exactly ONE item — DF3.4 review-round-6 D2
  (`--message -` sentinel / `VerbFlag.note?`). It is already CLOSED on the source side; DF3.5's
  residual obligations are (1) write `skill-contract.test.ts` against the closed set
  `{name, required, valueType, note?}`, (2) document the `-` stdin sentinel correctly in
  `factory-observe` (the literal `-` IS sendable by omitting the flag), (3) honor the
  per-verb exit-code sets and `--driver` requiredness exactly as the registry declares them
  (df3-1 C6/C4 amendments, df3-4 :194-205), including `rank`'s no-driver exemption and the
  socket-safe stdin rule for generated skills.
