# DF3.5: Tier-1 Claude Code Factory Skills over the Tested Fleet CLI

**Story Points:** 2
**Sprint:** v5-S2 (fleet band)

## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 tier 1, §8 step 3
- Decision register: v5 §4 **D3** (tier 1 = Claude Code driving a *code* fleet dispatcher via
  skills; rejected alternative: "agent-improvises-fleet-commands — drops measured guards silently")
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
  **DD-1** (operator-CLI-only channel), §5 row "F8 condition 2 + R6"
- Binding facts: R5 §6 fact **10** (Commercial Terms §A.1 is the load-bearing grant; client-deployed
  tier-1 = org-owned API key; **no Max-derived rate in any commercial floor**), fact **17**
- Source pattern (file:line): `INK/.claude/skills/sssf-sandbox-orchestrator/SKILL.md:13-25`
  ("THIN SKILL, FAT RECIPES" — never hand-roll a key mint, a revoke, an `ssh`; if a recipe is wrong,
  fix the recipe) and `INK/.claude/skills/sssf/SKILL.md:28` ("volunteered state is guessed state")
- **`INK/` alias expansion:** `INK/` is the operator's alias for the upstream `sssf` skill checkout,
  which is **not present on this host** — the `:line` anchors above are unopenable until it is cloned
  (`git clone <sssf-upstream> INK/`, upstream URL recorded in the derivation research bundle). The
  excerpts quoted in `R4-external-patterns.md` are the **binding** text for this story; the `INK/`
  anchors are provenance. A missing checkout is never grounds for re-deriving a clause from memory.

## User Story

As the factory operator working inside Claude Code,
I want skills that route me to the right tested `fleet` verb and help me read its result, rather
than an assistant that composes fleet commands from memory,
so that the guards measured into the CLI cannot be dropped by a plausible-looking improvisation.

## Overview

Four skills sit on top of DF3.1/DF3.2/DF3.4's CLI: `factory-dispatch` (dispatch, fanout),
`factory-observe` (status, attach), `factory-harvest` (harvest, teardown), and
`factory-guide` (the index, the preflight, and the commercial-terms statement). Each skill body
holds judgment — which verb, how to read the exit code, when to stop — and nothing else. The verbs
and flags themselves come from **DF3.1's verb registry** (`src/fleet/verbs.ts`) — the registry DF3.1
creates under its AC6 and its "verb registry" DoD item makes the sole source for `fleet --help`
— and a contract test parses every fenced command in every skill file against that registry. A skill
that documents a verb or flag the CLI does not export fails the build.

## E2E Slice

**Demonstrable behavior:** Given the four skill files and DF3.1's verb registry, When
`tests/fleet/skill-contract.test.ts` runs, it extracts every `fleet …` invocation from every
`.claude/skills/factory/*/SKILL.md` fenced block → resolves each verb and each flag against
`listVerbs()` → fails on the first unknown token, naming the file, line and token. Adding
`fleet dispatch --parallel 4` to a skill body while the registry exports `--fanout` turns the suite
red with `factory-dispatch/SKILL.md:41 unknown flag --parallel`.

**Wiring closed:** On completion of this story, an operator invokes a factory skill in Claude Code
and every command it reaches for is a verb the CLI actually exports and a test actually covers,
using only files merged by this story plus the verb registry DF3.1 ships under its AC6 (and the
`fanout`/`rank`, `approve`/`reject`/`attach` entries DF3.2 and DF3.4 register into it). No stub, no
`TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** DF3.1, DF3.2, DF3.4.

**Sprint-compression note (DF3.2 is the named first cut):** R5 §3 names DF3.2 the first story cut if
v5-S2 must compress, so DF3.5's dependency on it is soft by construction: if DF3.2 is unmerged,
`factory-dispatch` documents `dispatch` only and says nothing about `fanout` — and AC1 is what
enforces that, since a `fleet fanout` command in a skill body fails against a registry that does not
export the verb. No skill file is edited to "wait for" DF3.2, and none documents a verb ahead of it.

## Acceptance Criteria

1. **(make-or-break)** Given the four factory skill files, When the skill-contract test runs, Then
   every `fleet` invocation in every fenced block resolves to a verb **and** a flag set exported by
   `listVerbs()` in `src/fleet/verbs.ts`; an unknown verb, an unknown flag, or a required flag
   omitted fails with `file:line` and the offending token. *Negative control: a skill that
   documents a plausible-but-absent flag passes a naive "does the file mention `fleet`" check and
   MUST fail this test.*
2. Given each skill file, When it is loaded, Then its frontmatter carries a `name` matching its
   directory and a `description` naming the verbs it routes to, and its body contains **no**
   instruction to compose an `ssh`, `curl`, key-mint, key-revoke, VM-destroy or `git push` command
   directly — those route through a verb or not at all (orchestrator `SKILL.md:19-22`; D8 for push).
3. Given a verb fails, When a skill body describes the response, Then it instructs
   report-and-stop with the CLI's own `remediation` line — never a hand-rolled workaround and never
   a retry the CLI did not offer. Given a verb the operator names that does not exist, Then the
   skill instructs the agent to run `fleet --help` and stop, not to guess the nearest verb.
4. Given the four factory skill files and the contract test file, When each is searched with the **fixed** case-insensitive pattern
   set below, Then the match count is **zero** — the lint has patterns, so it can neither pass
   vacuously nor be argued about at review time:
   <br />(a) `\$\s*\d+(\.\d+)?\s*(\/|\bper\b)\s*(run|story|pr|task|issue|box|hour|month|seat)` —
   a per-unit price claim;
   <br />(b) `\b(max|pro)\b[^.\n]{0,20}\b(plan|subscription|tier|account)\b` — a
   consumer-subscription tier named as the entitlement;
   <br />(c) `\bsubscription\b[^.\n]{0,60}\b(covers|includes|entitles|permits|allows|is enough for)\b`
   — a subscription asserted to authorize work;
   <br />(d) `\b\d+(\.\d+)?\s*(usd|\$|dollars?)?[^.\n]{0,20}\bper\b[^.\n]{0,20}\b(million|mtok|1m|1,000,000)\b[^.\n]{0,10}\btokens?\b`
   — a token rate quoted in a skill file;
   <br />(e) `\b(client|customer)s?\b[^.\n]{0,60}\b(personal|individual|my|your own)\b[^.\n]{0,20}\b(account|subscription|plan)\b`
   — personal entitlement stretched over client work;
   <br />(f) `\b(egress|outbound|network)\b[^.\n]{0,40}\b(allowlist|allow-list|whitelist|restricted|locked[ -]down|firewalled|confined)\b`
   — a per-box network-containment claim the v5.0 substrate cannot enforce (DD-11).
   <br />Exactly **two** allowlisted exceptions exist, each matched verbatim and only in
   `factory-guide/SKILL.md`: *"Client deployments run on an org-owned API key under Commercial Terms
   §A.1."* (patterns a–e) and the AC7 containment-scope sentences (pattern f). Any other line
   matching any pattern fails the build with `file:line` and the pattern id
   (R5 §6 fact 10; DD-11). *Negative control: a file quoting "$0.40 per run" passes an
   assert-no-hits-of-the-empty-pattern-set lint and MUST fail this one.*
5. Given `factory-guide`, When an operator starts a session, Then the documented preflight is a
   single command whose failure means report-and-stop; a missing prerequisite is never worked
   around by hand (orchestrator `SKILL.md:33-36`).
6. Given a run in `awaiting-approval`, When a skill describes approving it, Then it routes to
   `fleet approve` and states that the approver token is supplied by the operator on stdin — no
   skill file contains, embeds, or offers to generate an approver token (stdin delivery: DF3.4
   INV-APPROVE-6; the authorization itself stays in DF3.4's gate, INV-APPROVE-2).
7. **(containment scope is stated, not implied — DD-11)** Given `factory-guide/SKILL.md`, When it is
   read, Then it states the v5.0 data-containment scope explicitly and cites **DD-11**: containment
   in v5.0 is **BYOK direct-provider egress only** — the box talks to the model provider on the run's
   own capped key and nothing routes through a shared account; there is **no per-VM egress allowlist
   on exe.dev**, because the substrate exposes no per-VM egress control today; the policy **re-enters
   with the OCI driver** (design §8 step 7), where the network namespace is ours. The wording is the
   scope caveat, never a sales claim: no skill file describes the box's network as allow-listed,
   restricted, or confined, and AC4's pattern (f) is what enforces that against every file but this
   allowlisted statement. *Negative control: a `factory-guide` that says only "runs are network
   isolated" satisfies a "mentions containment" check and MUST fail this one.*

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `/factory-dispatch` skill invocation (dispatch, fanout) | in-scope | `tests/fleet/skill-contract.test.ts` | — |
| `/factory-observe` skill invocation (status, attach) | in-scope | `tests/fleet/skill-contract.test.ts` | — |
| `/factory-harvest` skill invocation (harvest, teardown — v5.0 exports no `fleet reap`, so the orphan reaper is DF2.6's `scripts/sandbox-reap.ts` and no skill documents it as a verb) | in-scope | `tests/fleet/skill-contract.test.ts` | — |
| `/factory-guide` skill invocation (index, preflight, terms) | in-scope | `tests/fleet/skill-contract.test.ts` | — |
| Description-keyword auto-invocation by Claude Code | in-scope | frontmatter assertion in the same test | — |
| MCP tool surface for the fleet verbs | out-of-scope | — | none in v5.0 — the CLI is the surface (D3) |
| Visualizer link from an observe skill | out-of-scope | — | DF4.1 |
| Chat/webhook invocation of any skill | out-of-scope | — | none in v5.0 — **DD-1** decides operator-CLI-only |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| Skill loader | Claude Code on the operator machine, reading `.claude/skills/factory/*/SKILL.md` | each file parses as valid frontmatter + body; asserted by the contract test, not by hand-loading |
| Fleet CLI | `scripts/fleet.ts` (DF3.1), invoked as `bun scripts/fleet.ts` (matching DF3.1's documented invocation surface) | `fleet --help` exits `0` and renders the registry; this **is** the documented preflight |
| Verb registry | `src/fleet/verbs.ts` — **created by DF3.1 AC6** | `listVerbs()` is exported and consumed by both `--help` and the contract test — one source, not two |
| Fan-out verb | `fleet fanout` (DF3.2) | present in the registry before `factory-dispatch` documents it; absence fails AC1, not review |
| Decision verbs | `fleet approve` / `reject` / `attach` (DF3.4) | present in the registry before `factory-observe` documents them |

## Technical Notes

- **The registry is the contract, and DF3.1's AC6 is what puts it there.** DF3.1 creates
  `src/fleet/verbs.ts` and exports `listVerbs()` to render `--help` (its "verb registry" DoD item);
  DF3.2 and DF3.4 register their own verbs into it under their DoD. This story adds a second
  consumer, not a second source. The contract test is the whole mechanism — there is no
  skill-linting framework, no schema for skill bodies, and no generated documentation. Roughly
  one regex, one resolve loop and an assertion.
- **Guards/limits:** each `SKILL.md` body stays under 200 lines; the contract test parses fenced
  blocks only (prose mentioning a verb name is not a command); flags are matched exactly, so a
  renamed flag in DF3.1 breaks the skills at build time rather than at 2am.
- **Commercial wording (R5 §6 fact 10, gates-report F8 condition 2):** the operator's own Claude
  Code subscription is a tier-1 convenience for *this* repo's work. Any client deployment runs on an
  **org-owned API key under Commercial Terms §A.1** — the load-bearing grant is the permission to
  "power products and services Customer makes available to its own customers and end users", which
  exists only in §A.1. No Max-derived rate appears anywhere in these files, and no file quotes a
  per-run price at all; pricing lives with the cost ledger (DF2.8), not in a skill.
- **Containment wording (DD-11 — this story is the named encoding site).** DD-11 defers per-box
  egress policy (D8 / design §6.3) to the OCI driver at §8 step 7, because exe.dev exposes no per-VM
  egress control today and no v5.0 story can enforce one. It assigns the scope caveat to *this*
  story's `factory-guide`, so AC7 encodes it: the §6.3 containment claim is scoped to **BYOK
  direct-provider egress** for v5.0 and **must not be sold as an allowlist**. This is the same shape
  as the commercial-terms statement — one file states it once, and a fixed lint pattern (AC4(f))
  stops any other file from restating it as a capability.
- **Deviation/assumption:** skill frontmatter keys (`name`, `description`) follow the loader's
  current shape, matching the repo's existing `.claude/skills/gitnexus/*/SKILL.md`. If the loader
  changes shape, the frontmatter assertion is the thing that fails, which is the intent — the test
  is the tripwire for both halves of the contract.

## Observability Contract

- The skills add no runtime of their own: every observable event is the CLI's, already emitting
  `{ requestId, runId, verb, durationMs, outcome }` from DF3.1.
- Each skill body instructs the operator to carry the `runId` the verb printed into every follow-up
  verb, so the requestId chain stays joined across a multi-step session; errors are reported with
  the CLI's `{ code, message, remediation }` verbatim rather than paraphrased.
- Sub-timings: none introduced. The contract test reports `skills_parsed`, `commands_checked`.

## Files to Modify

- `.claude/skills/factory/factory-dispatch/SKILL.md`
- `.claude/skills/factory/factory-observe/SKILL.md`
- `.claude/skills/factory/factory-harvest/SKILL.md`
- `.claude/skills/factory/factory-guide/SKILL.md`
- `tests/fleet/skill-contract.test.ts`
- *(read-only, consumed unmodified from DF3.1: `src/fleet/verbs.ts`, `scripts/fleet.ts` — this story
  adds a second **consumer** of `listVerbs()`, never a second source)*

## Security Invariants

- **INV-SKILL-1 (no secret in a skill):** no skill file contains a credential, an approver token, a
  provisioning key, or an example that echoes one. Secrets are referenced **by variable name only**
  and are always supplied by the operator over stdin (DF2.3 INV-CRED-3, DF3.4 INV-APPROVE-6).
- **INV-SKILL-2 (authorization stays in code):** the approval check lives in DF3.4's gate. A skill
  may route to `fleet approve` and may not carry, cache, generate or infer an approver token —
  prompt text is never an authorization boundary, because a skill body is not a trust boundary. The
  hashed allowlist (`.factory/approvers.json`, DF3.4 AC4) is the auth surface; skills never bypass it.
- **INV-SKILL-3 (no hand-rolled privileged command):** no skill instructs the agent to compose a key
  mint, a key revoke, a VM destroy, an `ssh` into a box, or a git push. Those encode measured guards
  and a hand-rolled version drops one silently; they are reachable only through a registry verb.
  The `thin-skill-fat-recipes` pattern is enforced by the contract test — any skill body reaching for a
  privileged operation directly fails against the empty verb registry (D3's rejected alternative).
- **INV-SKILL-4 (fail-closed on the unknown):** an unrecognised verb, a missing prerequisite, or a
  failing preflight ends in report-and-stop (R3 FAIL-CLOSED DISCIPLINE). No skill offers a workaround
  path, a fallback command, or a retry the CLI did not itself offer.
- **INV-SKILL-5 (commercial containment):** no Max-subscription-derived rate appears in any file
  this story adds, and no file implies a personal subscription covers client work. Client
  deployments are stated once, in `factory-guide`, as org-owned API key under Commercial Terms §A.1
  (R5 §6 fact 10).
- **INV-SKILL-6 (containment is scoped, never oversold):** no skill file claims the box's network is
  allow-listed, restricted or otherwise confined. v5.0 containment is BYOK direct-provider egress
  only; the substrate offers no per-VM egress control, and the policy re-enters with the OCI driver
  (DD-11). The scope is stated once, in `factory-guide` (AC7), and AC4's pattern (f) is what keeps a
  future edit from restating it anywhere as a capability.

## Definition of Done

- [x] **Impl:** four `SKILL.md` files under `.claude/skills/factory/`, each ≤200 lines, each naming
      its verbs in frontmatter `description` and holding judgment rather than command construction.
- [x] **Impl:** `factory-guide` documents the one-command preflight (`bun scripts/fleet.ts --help`) with
      report-and-stop on failure, and carries the single commercial-terms statement.
- [x] **Contract (containment scope, AC7):** `factory-guide` states the v5.0 containment scope —
      BYOK direct-provider egress only, **no** per-VM egress allowlist on exe.dev, re-enters with the
      OCI driver (§8 step 7) — and cites DD-11; a test asserts all three clauses and the DD-11
      citation are present in that file and absent as capability claims from the other three.
- [x] **Contract:** `listVerbs()` in `src/fleet/verbs.ts` is the sole source of verb and flag names
      for both `fleet --help` and the skill-contract test — no second list is introduced.
- [x] **Integration:** the fan-out verb (DF3.2) and the decision verbs (DF3.4) resolve through the
      registry before any skill documents them; a missing verb fails AC1 rather than review.
- [x] **Security:** no skill file carries a token or a hand-rolled mint/revoke/destroy/ssh/push
      command (INV-SKILL-1, INV-SKILL-3).
- [x] **Test (unit):** frontmatter of each skill parses, `name` matches its directory, and
      `description` names at least one exported verb.
- [x] **Test (unknown-token):** a fixture skill body containing `fleet dispatch --parallel 4`
      against a registry exporting `--fanout` fails with the file, line and offending token.
- [x] **Test (pricing + containment lint):** the four factory skill files and the contract test
      file are scanned with AC4's **six**
      fixed case-insensitive patterns → zero hits outside the two verbatim `factory-guide` allowlist
      entries; a fixture file containing `$0.40 per run` fails with `file:line` and the pattern id
      (INV-SKILL-5), and a fixture claiming `egress is allowlisted per VM` fails on pattern (f)
      (literal string substituted — see Deviation 1) (INV-SKILL-6).
- [x] **Test (e2e demo — MANDATORY):** `tests/fleet/skill-contract.test.ts` extracts the documented
      command sequence from `factory-dispatch/SKILL.md` and `factory-observe/SKILL.md`, runs it
      against the `fake` driver, and asserts the `runId` printed by the dispatch command is the
      `runId` the observe command is invoked with — one automated run, no human in the loop. A
      Claude Code transcript exercising the same two skills is captured in the Dev Agent Record as
      **supporting evidence only**; it is never the passing criterion.

## Dev Agent Record

**Implemented:** 2026-09-01, branch `feature/df3.5` (cut from dev@7806bbe post-PR-#183), via the `/qds-dev` workflow: Phase-2 six-track parallel research wave (reports in `_bmad-output/workflow-state/qds-dev/df3-5/research/`), Phase-4 TDD in two subagent waves (Wave 1: contract test RED first; Wave 2: four skill files in parallel), Phase-5 adversarial self-review + fixer round. GitNexus reindexed via the canonical `scripts/install-gitnexus-plus.sh` (CLI 1.6.9 == pinned).

**Implementation files (6):**
- `.claude/skills/factory/factory-dispatch/SKILL.md` (net-new, 133 lines): dispatch/fanout routing judgment; registry-verbatim exit-code table; exit-6 dispatch/fanout split.
- `.claude/skills/factory/factory-observe/SKILL.md` (net-new, 144 lines): status/attach + approve/reject routing with operator-stdin approver token (AC6, DF2.3 INV-CRED-3); attach = guidance only (INV-APPROVE-5).
- `.claude/skills/factory/factory-harvest/SKILL.md` (net-new, 114 lines): harvest freely / teardown as explicit separate decision; verb owns the settle→harvest→revoke→destroy→close order; no `fleet reap` documented.
- `.claude/skills/factory/factory-guide/SKILL.md` (net-new, 91 lines): index, one-command preflight (`bun scripts/fleet.ts --help`, report-and-stop), the verbatim Commercial Terms §A.1 sentence, and the AC7 containment scope with DD-11 citation (3 clauses).
- `tests/fleet/skill-contract.test.ts` (net-new, 41 tests after review round 1): the whole mechanism — discovery+frontmatter, AC1 fence/verb/flag resolution against `listVerbs()`, AC2/INV-SKILL-3 prohibited-command scan, AC4 six-pattern frozen lint with line-exact allowlists, AC7 clause assertions, AC6 approval routing + token-shape heuristic, non-vacuity pins, and the MANDATORY DoD e2e (documented dispatch→status sequence run in-process against the fake driver, runId chain asserted).
- `tests/gitnexus/cli-contract.ts` (ONE schema adoption, user-approved; tightened in review round 1): `DefinitionStrict` — startLine/endLine optional in the schema, with superRefine invariants: spans both-present-or-both-absent on every definition, `File:`-node definitions must currently carry NO span, symbol definitions must carry one (alarm trips on a shape change in either direction, verified live). Required because the canonical reindex at 7806bbe surfaced pre-existing content drift (query "SwarmClaw routes" now returns `File:`-node definitions without line spans; CLI version unchanged at 1.6.9).

*Count reconciliation:* `detect_changes` (below, pre-commit) reports 4 files / 7 symbols because it counts only symbol-carrying files; the four `SKILL.md` files are markdown and carry no symbols, which reconciles "Implementation files (6)" with the 4-file `detect_changes` count.

**Workflow artifacts:**
- `_bmad-output/workflow-state/qds-dev/df3-5/guardrail-log.yaml` — GR-002 override record for the `tests/gitnexus/cli-contract.ts` schema adoption.

**Decision 1 (invocation contract):** fenced commands use `bun scripts/fleet.ts <verb>` (bare `fleet <verb>` also accepted); `<runId>` is the literal placeholder the e2e substitutes; one command per line.

**Decision 2 (frontmatter):** exactly `name` + single-line `description`, matching `.claude/skills/gitnexus/*/SKILL.md`; upstream sssf's `argument-hint` deliberately NOT imported.

**Decision 3 (registry is read-only):** DF3.5 added a second CONSUMER of `listVerbs()`, never a second source; `src/fleet/verbs.ts` and `scripts/fleet.ts` untouched. DF3.4's deferred D2 (`VerbFlag.note?`) was already closed 2026-08-28 (Session A, `_bmad-output/plans/2026-08-29-df3-4-deferred-remediation.md:427-536`) — the contract test tolerates the closed flag shape `{name, required, valueType, note?}`.

**Decision 4 (MIT attribution):** doctrine/structure lifted from indydevdan/super-simple-software-factory + inkwell-agent-sandboxes-and-software-factory (local clones at /Users/steve/reference-repos/, both MIT (c) 2026 IndyDevDan); each skill carries the attribution footer. Ponytail verdict from DF3.1 trackC2 held: doctrine lifted, no Python re-port.

**Decision 5 (enrol/unlock/rank undocumented):** no skill documents enrol/unlock (gate administration, not an operator flow the story scopes) or fences `rank` (named in prose as the fanout scorer). The contract test pins that documented verbs resolve; it does not require full registry coverage.

### Deviations from the story spec

| # | What the story says | What we built | Evidence |
|---|---------------------|---------------|----------|
| 1 | DoD's pricing+containment lint item: "a fixture claiming `egress is allowlisted per VM` fails on pattern (f)". | The test uses the substitute fixture "egress is restricted to an allowlist per VM", which pattern (f) does match, with an honest comment in the test. | AC4 froze the patterns verbatim and `\ballowlist\b` rejects the `-ed` inflection, so the DoD's literal negative-control string CANNOT match (f) — executed proof, review finding 6. The DoD's INTENT (a per-VM containment capability claim fails on (f) with file:line + pattern id) is satisfied; the literal string is not. Story-owner ruling requested at review: amend the DoD string or the pattern in a future story — both are frozen here. |
| 2 | Spec Reference claims `R4-external-patterns.md` carries the binding INK skill excerpts and that `INK/` "is not present on this host". | All four INK anchors resolved verbatim against the local clones, which were the source of truth; no clause was re-derived from memory. | Verified 2026-09-01 (research trackD): R4 contains no such excerpts, and both indydevdan repos ARE cloned locally (/Users/steve/reference-repos/) — orchestrator SKILL.md:13-25 THIN SKILL FAT RECIPES, :19-22, :33-36; sssf SKILL.md:28 byte-identical in both repos. |
| 3 | GR-002 scope: story files limited to FTM. | `tests/gitnexus/cli-contract.ts` schema adoption (user-approved, logged in `_bmad-output/workflow-state/qds-dev/df3-5/guardrail-log.yaml`). | Without it the repo's own drift alarm stays red on dev@7806bbe after the AGENTS.md-mandated reindex — pre-existing content drift, not caused by this story (see Files). |
| 4 | AC4 and the DoD lint item read "every file this story adds" is scanned with the six frozen patterns. | The AC4 suite scans the four factory skill files plus the contract test file itself; AC4/DoD wording amended to name that set. | Two research/state docs under `_bmad-output/workflow-state/qds-dev/df3-5/research/` match frozen patterns (b) and (f) as **negated caveats** (they quote the caveats as negations), so scanning them would false-positive without negation-aware handling. The intent of INV-SKILL-5/6 — no capability/price claims in agent-executable docs — is unviolated. |

**Tests:** contract suite 30/30 green (was 19 pre-review) · `bun test tests/gitnexus/` 32/32 green post-adoption · `bunx biome check` clean · `bunx tsc --noEmit` clean · `./scripts/dev/check-defensive-programming.sh --base origin/dev` OK · `./scripts/dev/check-pr-conflicts.sh --base origin/dev` OK. Full suite (final re-run, post-review-fixes, 2026-09-01): **4764 pass / 0 fail / 8 skip / 24 todo across 158 files** (exit 0) — includes the adopted gitnexus drift alarm and the 30-test contract suite. Flake disposition: `tests/gitnexus/` AC-1 timeouts observed under machine load avg 14 (raw CLI query 2.6s standalone vs 5s test timeout); green at load ~7 on re-run — environmental, not contractual. `detect_changes` (pre-commit, AGENTS.md): 4 files / 7 symbols / 0 affected processes / risk LOW — every entry inside DF3.5's surface plus the logged Deviation-3 adoption.

**Review round 1 (pre-PR adversarial self-review, executed probes):** 10 findings → 3 blockers (allowlist over-exemption ×2, shell-chaining AC1 evasion) + 4 hardening (tilde fences, prohibited-command anchoring, non-vacuity, short-flag/missing-value) ALL fixed in one fixer wave, each proven RED-then-GREEN with new negative controls (30 tests total); finding 6 became Deviation 1; findings 8/10 covered by fixes/comment. Skill files: zero defects found — flags, required sets and exit-code tables verified accurate against `src/fleet/verbs.ts`.

**E2E demo (DoD, fake driver, mandatory):** `tests/fleet/skill-contract.test.ts` › "DoD e2e (MANDATORY)" — extracts the fenced dispatch command from `factory-dispatch/SKILL.md` and the `<runId>` status command from `factory-observe/SKILL.md`, runs both in-process against FakeDriver/FakeKeyApi/goodLedger (`tests/fleet/cli.test.ts:562-612` pattern), and asserts the runId dispatch printed is the runId status was invoked with (observed runId `qds-20260901-857fd1`, exit 0 both). Passing criterion is the automated test. The Claude Code transcript (supporting evidence only per the DoD) was not captured: development ran in a non-Claude-Code CLI host where Skills are not auto-invoked; the skill files are loader-ready (frontmatter shape matches the repo's existing gitnexus skills) and the contract test is the tripwire for loader shape per the story's Deviation/assumption note.

---

## Hardening Revision — 2026-08-20

**Revision summary:** Verb registry cross-citation corrected to DF3.1's contract ("DF3.1's registry"
as a cross-story dependency). Skills location cites existing `.claude/skills/` structure. R3
FAIL-CLOSED doctrine encoded in security invariants. DOD verified at 10 high-signal items (no trim
needed). Commercial terms and containment wording preserved per R5 §6 fact 10 and DD-11.
**Campaign fixes 2026-08-20:** DF3.5-L1.
as a cross-story dependency). Skills location cites existing `.claude/skills/` structure. R3
FAIL-CLOSED doctrine encoded in security invariants. DOD verified at 10 high-signal items (no trim
needed). Commercial terms and containment wording preserved per R5 §6 fact 10 and DD-11.

## Review Findings — round 1 (PR #185, 2026-09-01)

Seven-agent review wave (blind ×3, edge ×3, auditor ×1) over chunked diff; 31 unique findings after
dedupe, all resolved. Fixed in `fix(df3-5): review round 1` on this branch.

**Patched — skills (`.claude/skills/factory/`):**
- [x] F1 HIGH `rank` ownership contradiction guide↔dispatch — guide bullet fixed; `fleet rank` documented as unwrapped registry verb (fanoutId, no `--driver`)
- [x] F2 HIGH exit-6 dual meaning — explicit stdout-parse disambiguation (`teardown.harvest_waived`) added to harvest, dispatch, observe
- [x] F3 MED harvest exit-5 "refused before provisioning" → run-lock wording
- [x] F4 MED `status` arg order unified (positional-then-flags, canonical per CLI usage strings)
- [x] F5 MED guide "referenced by variable name only" → stdin-at-invocation, no flag/env var
- [x] F6 LOW guide `fleet --help` → `bun scripts/fleet.ts --help`
- [x] F7 LOW "The three skills (index)" → "The three sibling skills (index)"
- [x] F8 LOW dispatch exit-5 guard codes → real codes (budget-exceeded, no-headroom, headroom-failed; fleet-busy is fanout-only)
- [x] F9 LOW observe exit table: exit-1 row added; `status` declares only 0/1/2/4
- [x] F10 LOW observe miscited INV-APPROVE-6 → DF2.3 INV-CRED-3
- [x] F11 LOW harvest "frozen by the registry NOTE" → pinned by verb contract tests
- [x] F12 LOW harvest "stderr carries one JSON line" → "a JSON envelope line"
- [x] F13 LOW dispatch runId-handle claim split for fanout (fanoutId + per-arm runIds)

**Patched — tests (`tests/fleet/skill-contract.test.ts`, 30 → 41 tests):**
- [x] F14 HIGH pattern-(f) guide exemption now exact-line verbatim allowlist + appended-claim negative control
- [x] F15 MED commercial lint also scans newline-flattened copy (wrap evasion closed) + split-line control
- [x] F16 MED AC6 approval assertions scoped to the approval-decision section slice
- [x] F17 MED invocation-surface coverage: bun-prefix, `$` prompt, `--flag=value`, help exemption, did-you-mean suffix (6 new fixture tests)
- [x] F18 MED vm-destroy pattern now bidirectional + control
- [x] F19 MED `&&`-hiding closed: all line segments re-scanned even when line doesn't lead with a fleet command + control
- [x] F20 LOW exact-inventory test asserts zero non-directory entries
- [x] F21 LOW parseAckRunId robust try-parse scan
- [x] F22 LOW quoting documented as rejected surface + pin test (no splitter, conservative)
- [x] F23 LOW §A.1 exemption path proven by direct unit test
- [x] F24 LOW redundant INV-SKILL-6 test kept with clarifying comment (fail-safe: no deletion)
- [x] F25 LOW prohibited-scan header comment downgraded to per-line reality (no behavior change)

**Patched — gitnexus (`tests/gitnexus/cli-contract.ts`):**
- [x] F26 MED superRefine hardened: spans both-present-or-both-absent on every definition; File-node span-addition trips the alarm (intentional alarm tightening)

**Patched — story/record (this file):**
- [x] F29 MED AC4/DoD scan scope wording names the actual scanned set (Deviation 4)
- [x] F30 LOW DoD item annotated "(literal string substituted — see Deviation 1)"
- [x] F31 LOW detect_changes 4-vs-6 reconciled (SKILL.md files carry no symbols)
- [x] F32 LOW DoD preflight literal → `bun scripts/fleet.ts --help`
- [x] F33 LOW Dev Record line counts updated to post-fix reality (133/144/114/91)
- [x] F34 LOW E2E-slice narrative `(did you mean --fanout?)` dropped (unreachable at levenshtein 7)

**False positives dismissed (verified against source):** none among patched; blind-review caveats
("could not verify registry/run contracts") were confirmed clean by the edge reviewers — suite 41/41 green.

**Deferred — pre-existing, out of PR scope:**
- `.gitnexus/cli-version.json` is gitignored while the AGENTS.md ritual says "land stamp in same commit" — repo-governance conflict predating this PR.
- `tests/gitnexus/` CLI-subprocess 5s timeouts under host load — pre-existing flake (green at normal load; green in this round's final gate).

**Gates (final, this round):** `bun test tests/fleet/ tests/gitnexus/` 1118 pass / 0 fail; biome clean;
tsc --noEmit clean; `detect_changes` 7 files / 9 symbols, 0 affected processes, risk low, all inside DF3.5 surface.
