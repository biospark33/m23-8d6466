# PR #185 — Blind review findings: factory skills chunk

Scope reviewed: `.claude/skills/factory/factory-{dispatch,guide,harvest,observe}/SKILL.md` (all new files, from `chunk-skills.diff` only).

## [MEDIUM] The exit-6 `--no-harvest` / `teardown.harvest_waived` rule is restated in three skills, two of which don't own teardown

- file:line: `.claude/skills/factory/factory-dispatch/SKILL.md:103-105`, `.claude/skills/factory/factory-observe/SKILL.md:99-107`, `.claude/skills/factory/factory-harvest/SKILL.md:71-77`
- trigger: Any future change to teardown's exit-6 semantics (e.g. the waived-harvest stdout marker is renamed, or exit 6 gains a third meaning). Three copies of the same contract rule must be edited in lockstep; the usual outcome is one copy drifting. It is also odd that dispatch itself says "(factory-harvest owns that table)" while still restating the rule inline, and that factory-observe — which never covers `teardown` at all — restates it with no ownership attribution.
- fix: Keep the full rule only in factory-harvest (the declared owner). In dispatch and observe, replace the restatement with a one-line pointer ("on a `--no-harvest` teardown, exit 6 has a success sub-case — see factory-harvest"), or drop it from observe entirely since observe never routes to teardown.

## [MEDIUM] stdin conventions are asserted but never shown — `attach --message -` and the approve/reject token will hang or be executed inconsistently

- file:line: `.claude/skills/factory/factory-observe/SKILL.md:56-60` (attach), `:79-95` (approve/reject token), `.claude/skills/factory/factory-guide/SKILL.md:81-82` (hard rule 4)
- trigger: An agent runs `bun scripts/fleet.ts attach <runId> --driver fake --message -` exactly as printed. The skill says the message is read from stdin (or when the flag is omitted entirely) but never shows the pipe/heredoc form and gives no timeout or abort guidance — executed interactively, the command blocks on stdin indefinitely. Same gap for approve/reject: guide rule 4 and observe both say the approver token "is supplied by the operator on stdin at invocation time", yet the approve/reject examples show no stdin redirect at all. Two agents will plausibly do different things (interactive prompt vs. pipe vs. refusing to run).
- fix: Show one canonical invocation per stdin consumer, e.g. `echo "$MSG" | bun scripts/fleet.ts attach <runId> --driver fake --message -` (or a heredoc), and state what happens/what to do if stdin is a TTY. For approve/reject, show where the token enters the command line (e.g. `... --approver <id> <<< "$TOKEN"` or "the verb prompts on stdin").

## [LOW] "Carry it into every follow-up verb" has an ambiguous referent for fanout

- file:line: `.claude/skills/factory/factory-dispatch/SKILL.md:64-68`
- trigger: After a fanout, the skill says fanout "prints a fanoutId plus one JSON line per arm" and then "Carry it into every follow-up verb". "It" reads as the runId, but factory-guide (`SKILL.md:46-48`) says `fleet rank` takes the **fanoutId**, not a runId — so the correct handle depends on the follow-up verb (arm runId for status/harvest/teardown, fanoutId for rank). An agent following dispatch's sentence literally will try to rank by runId.
- fix: Split the sentence: "Carry each arm's runId into per-run verbs (status/harvest/teardown); carry the fanoutId for `fleet rank`."

## [LOW] dispatch contradicts its own "never restates flag semantics" principle in the same breath

- file:line: `.claude/skills/factory/factory-dispatch/SKILL.md:16-18` and `:38-40`
- trigger: The governing principle says the skill "never restates flag semantics beyond [the registry]" and the fanout paragraph says these are "details the registry owns and this skill does not repeat" — then immediately states `--cap-micro-usd` semantics ("per-arm cap in integer micro-dollars") and mentions `--n` ranges and `--pin` vs commitSha. If the registry changes the cap's unit or arity, this line becomes stale documentation the skill promised not to carry.
- fix: Reduce to a pure pointer: "fanout takes `--n`, `--roster`, `--pin`, and `--cap-micro-usd`; read their semantics from `--help`." Drop the inline semantics, or drop the "never restates" claim.

## [LOW] Real-driver substitution is only spelled out in observe; dispatch/harvest examples can be cargo-culted with `--driver fake` against real work

- file:line: `.claude/skills/factory/factory-dispatch/SKILL.md:54-61`, `.claude/skills/factory/factory-harvest/SKILL.md:30-31,46-48`; contrast `.claude/skills/factory/factory-observe/SKILL.md:46-48`
- trigger: Dispatch's canonical examples all use `--driver fake` ("the local no-spend driver") but never say "substitute the real driver for a real dispatch". Observe explicitly says to substitute the driver the run was dispatched with; harvest sidesteps it with `<driver>` placeholders. An operator asking to "dispatch the real brief" can get a no-spend fake run from an agent copying the canonical form.
- fix: Add one line to dispatch's Commands section: "for a real run, substitute the operator's driver for `fake` — `fake` provisions nothing." (verify) Confirm against the registry whether `fake` is even accepted alongside real drivers, or whether the default differs.

## [LOW] (verify) Cross-references to external design docs/invariants may be stale or unverifiable from this PR

- file:line: `.claude/skills/factory/factory-guide/SKILL.md:11` ("DF3.1 verb registry", in a df3-5 PR), `:56-68` (Commercial Terms §A.1, DF2.8, DD-11, "v5.0", "exe.dev", "OCI driver design §8 step 7"), `.claude/skills/factory/factory-observe/SKILL.md:62` ("DF3.4 INV-APPROVE-5"), `:89-92` ("DF2.3 INV-CRED-3", "INV-SKILL-2"), `.claude/skills/factory/factory-harvest/SKILL.md:60` ("v5.0 exports no `fleet reap` verb"), `:71-73` ("pinned by the verb contract tests `tests/fleet/verbs.test.ts`")
- trigger: These name specific documents, invariant IDs, and a test file that a reader (or a future editor) must be able to resolve. If e.g. DD-11 or INV-APPROVE-5 were renamed, or `tests/fleet/verbs.test.ts` doesn't pin the exit-6 split as claimed, the skills cite authority that doesn't exist. Not checkable from the diff alone.
- fix: Edge reviewer: confirm `src/fleet/verbs.ts` exports `listVerbs()`, that `tests/fleet/verbs.test.ts` exists and pins the exit-6/`teardown.harvest_waived` behavior, and that DF2.3/DF2.8/DF3.1/DF3.4/DD-11 designations resolve in `docs/decisions` or equivalent. If the registry genuinely dates from DF3.1, consider dropping the version label ("the fleet verb registry") so it doesn't read as stale next release.

## [LOW] Exit-3 coverage asymmetry is fine but invisible outside dispatch

- file:line: `.claude/skills/factory/factory-dispatch/SKILL.md:85` ("setup-gate failure … (dispatch only)"), `.claude/skills/factory/factory-harvest/SKILL.md:65-77`, `.claude/skills/factory/factory-observe/SKILL.md:99-107`
- trigger: Exit 3 is documented only in dispatch's table, marked "(dispatch only)". Harvest and observe list their codes without mentioning 3 at all — neither "declares 3" nor "3 is out of contract here". Unlike dispatch (which explicitly says a 4 is out-of-contract for dispatch/fanout) and observe (which explicitly says 5/6 are out-of-contract for status), harvest never states what to do with an undeclared code.
- fix: Add the same out-of-contract sentence to harvest's exit-code list ("a 3 from harvest/teardown is outside contract; report it, do not interpret it") for symmetry, or drop the parenthetical and centralize the full code table in one skill.

## Clean (checked, no finding)

- Frontmatter: all four files have valid-looking quoted YAML with `name` matching the directory name and a non-empty `description`; no schema violations visible.
- Cross-skill verb/flag consistency: `status`/`attach` require `--driver`, `approve`/`reject` forbid it (stated identically in guide and observe); `fleet rank` takes fanoutId and no `--driver` (guide) consistent with dispatch's "rank's job" pointer; `src/fleet/verbs.ts` + `bun scripts/fleet.ts --help` cited uniformly as the registry source in all four files.
- Exit-code tables are mutually consistent where they overlap: 4 = run-not-found only where declared (harvest/teardown/status), dispatch/fanout explicitly exclude it; 5 = refused-before-mutation everywhere; the dispatch-exit-6 → teardown exception is stated identically in dispatch (`:91-98`) and harvest hard rule 1 (`:87-92`), both requiring explicit operator confirmation.
- Security posture: no credentials in skill bodies, deliberate no-`--token`-flag rationale (argv/history leak), approver token on stdin only, teardown gated on explicit operator decision in every skill that mentions it, no destructive hand-rolled commands, repeated "report-and-stop, never work around" failure handling. No secret-leak or unguarded-destruction findings.
- Shell portability: no GNU-only flags, no unportable constructs; all commands are `bun scripts/fleet.ts ...` invocations consistent with the repo layout.
- Copy-paste staleness: no leftover df3-4-as-current-story names, wrong PR numbers, or foreign skill names; the IndyDevDan attribution footer is uniform across all four files.
- No logic errors found in the JSON/YAML shapes shown (`{fanoutId, arm, runId, outcome}`, `{ code, message, remediation }` are used consistently across skills).
