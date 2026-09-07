K2 already fixed on main (step-log.ts:328 `(e ?? {})`). Now fake-gate.ts.
Now checking remaining context: callers/usages for K6/K11/K12 and fake-gate tests.
All three files read. Main has already absorbed several fixes (df3-2/round-10 work). Analysis of the 12 findings against current source:

- **K2**: already fixed — `step-log.ts:328` `const err = (e ?? {})` guards the null rejection.
- **K7**: already fixed — `canonicalRepoSlug` (`issue-correlation.ts:72`) now folds ASCII-only via `replace(/[A-Z]/g, ...)` explicitly to match SQLite `lower()`, with a docstring covering exactly this divergence.
- **K4**: owned by cluster D — will verify only.
- K1, K3, K5, K6, K8, K9, K10, K11, K12: live, patching below.

Per CLAUDE.md, running gitnexus impact on the symbols I'm about to edit before touching them.
Now checking the reaper's retry/backoff schedule for the K1 horizon constant, and how dispatch builds issueId strings for K6 caller-surfacing.
Context gathered. Before editing, checking what the focal tests pin, plus remaining consumers.
Checking test expectations that could collide with planned fixes.
K2 is confirmed fixed on main; K7 fixed post-merge in `canonicalRepoSlug`. Now reading the `SetupGateResult` type (for the K11 structured channel) and the FakeDriver constructor (for unit tests), then batching edits.
All context gathered. Blast radius confirmed HIGH for `canonicalIssueId` (15 symbols, budget/reporting processes) and `isSubstrateFailure`/`fakeGate` (dispatch/fleet/fanout) — flagged for the report per CLAUDE.md; fixes below stay in the fail-safe direction. Pulling the last bits of context I need: dispatch's gate sanitization, test fixture helpers, and the gitnexus `rename`-free plain reads.
Now checking how dispatch sanitizes the gate result (K11 needs the classification moved off free text), then I'll batch the edits.
Checking `gateOpts`/dispatch test runIds and the cost-ledger test fixtures before writing edits.
All context gathered. Verified fixes already on main: **K2** (`step-log.ts:328` `(e ?? {})`) and **K7** (`canonicalRepoSlug` folds ASCII-only via `/[A-Z]/g`, docstring documents matching SQLite `lower()` exactly — issue-correlation.ts:55-69). Patching the nine live findings now.
Now the SQL-side mirror (K5 JS/SQL agreement) in `sqlCanonicalIssueId`.
The double-CASE would diverge from the JS regex on `##` shapes — the JS `^#[\s]*` folds exactly once. Simplifying to one pass.
Now the remaining cost-ledger edits: K6 (refuse malformed identities), K10 (null overrides), K8 (ingest taxonomy), K9 (collision check), K1 (over-cap warnings).
K10 next — `capForIssue`'s null-override regression.
Now K8 — wrap both ingest INSERT paths in the busy taxonomy, matching `admitIssue`'s treatment.
I referenced a nonexistent helper — simplifying to a direct comparison.
Now the same treatment for `ingestBoxHours` (K8), and K1's guard there too.
K1 — the fail-safe option: on box-hours ingest landing after its run's reservation cutoff, emit a structured over-cap warning rather than silently accepting.
That edit wasn't needed — the insert wrapper is already in place. Now fake-gate: K3, K11, K12.

For K11: `SUBSTRATE_MARK` currently rides assertion note free text that an injected gate or echoed box output can forge. The clean fail-safe fix: have the gate's own probes record substrate verdicts on a parallel structured channel inside the gate module (a WeakMap keyed by result object, since `SetupGateResult` carries no field), and make `isSubstrateFailure` read ONLY that channel — forged note text then classifies nothing.
Now the end of `fakeGate` — build the result, mark it (K11 channel write), and guard runId grammar (K12).
Now K3 — rework probe B so present-but-unreadable is distinguished from missing (mirroring item C's structure), plus thread the structured substrate flags through all three fs-touching probes.
Now verify the whole file compiles cleanly and check the `rawBody === "absent"` arm's template (dropped the needless parens), plus run biome + tsc.
The multiline `as` cast confused biome's fixer. Rewriting as an interface-typed local.
The `dispatch.ts`/`setup-gate.ts` errors come from sibling fixer agents editing the same worktree concurrently — not my files. Re-checking scoped to my two files.
Two integration points remain: box-hours warning should fire only for positive spend, and dispatch's spread `{...gate}` breaks WeakMap identity for K11.
Now the key question for K11: does `within("gate", ...)` return the same object identity the gate produced?
`within` passes the value through unchanged — object identity preserved. The WeakMap channel works. Now run focal tests.
All 4 failures are the old message-text pin — refusal semantics unchanged, message improved to name the grammar. Updating pins (flagging as broken-expectation edits).
All 113 cost-ledger tests pass. Now dispatch.test.ts (which exercises fakeGate + the substrate classification through real gates) and step-log tests.
Baseline is 128 pass / 0 fail, so all 5 failures are from the working tree. Three look like mine (the two gate-B wordings + the unreadable-manifest stub). Checking whether the other three (AC8 headroom ×2, concurrency) predate my edits or come from siblings' concurrent files.
Three failures are mine (gate-B wording + the exec-stub interception). The other three need attribution — testing by stashing only my files.
Confirmed: the 3 AC8/concurrency failures occur even with my cost-ledger/fake-gate changes stashed — they come from the `run-id-not-minted` registry edit in `dispatch.ts` (cluster F's F17 work, in progress by a sibling agent using this shared worktree). Those are not mine to fix. My 2 gate-B failures remain. Let me fix the tests for my real behavior change.
Now the unreadable-manifest test — its stub must match the new probe shape.
My gate-B failures are fixed — 125 pass, and the 3 remaining are the `run-id-not-minted` registry change (cluster F's F17, owned by another fixer in this shared worktree). Adding the K3 unit-level coverage: a fake-gate test that a forged `"substrate: "` in notes cannot reclassify (K11), and checking where fake-gate-only tests live. The 5 teardown tests need verifying too.
Exedev gates never emitted SUBSTRATE_MARK in notes (only fake-gate.ts references it), so their classification is unchanged. All existing tests pass. Per policy (test edits only for broken expectations), I'm not adding new test suites — flagging coverage gaps for wave 2 instead. Final validation pass.
All validation done. Sending the final report to the team lead.
