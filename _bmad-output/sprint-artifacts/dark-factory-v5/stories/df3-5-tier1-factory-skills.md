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
and flags themselves come from `src/fleet/verbs.ts` — the registry **DF3.1 AC6 creates** and its
"verb registry" DoD item makes the sole source for `fleet --help` — and a contract test parses every
fenced command in every skill file against that registry. A skill
that documents a verb or flag the CLI does not export fails the build.

## E2E Slice

**Demonstrable behavior:** Given the four skill files and the DF3.1 verb registry, When
`tests/fleet/skill-contract.test.ts` runs, it extracts every `fleet …` invocation from every
`.claude/skills/factory/*/SKILL.md` fenced block → resolves each verb and each flag against
`listVerbs()` → fails on the first unknown token, naming the file, line and token. Adding
`fleet dispatch --parallel 4` to a skill body while the registry exports `--fanout` turns the suite
red with `factory-dispatch/SKILL.md:41 unknown flag --parallel (did you mean --fanout?)`.

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
4. Given every file this story adds, When it is searched with the **fixed** case-insensitive pattern
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
| Fleet CLI | `scripts/fleet.ts` (DF3.1), invoked through the repo's package script | `fleet --help` exits `0` and renders the registry; this **is** the documented preflight |
| Verb registry | `src/fleet/verbs.ts` — **created by DF3.1 AC6** | `listVerbs()` is exported and consumed by both `--help` and the contract test — one source, not two |
| Fan-out verb | `fleet fanout` (DF3.2) | present in the registry before `factory-dispatch` documents it; absence fails AC1, not review |
| Decision verbs | `fleet approve` / `reject` / `attach` (DF3.4) | present in the registry before `factory-observe` documents them |

## Technical Notes

- **Thin skill, fat recipes** (orchestrator `SKILL.md:13-25`). The skill holds the judgment about which verb to
  run and how to read the result; the verb holds the knowledge. Re-implementing what a verb already
  does is forbidden because the verbs encode measured facts — mint ordering, the revocation gate,
  the teardown sequence — and a hand-rolled version drops one silently. If a verb is wrong, the fix
  is the verb, not a route around it. This is D3's rejected alternative stated as a build check.
- **The registry is the contract, and DF3.1's AC6 is what puts it there.** DF3.1 creates
  `src/fleet/verbs.ts` and exports `listVerbs()` to render `--help` (its "verb registry" DoD item);
  DF3.2 and DF3.4 register their own verbs into it under their DoD. This story adds a second
  consumer, not a second source. The contract test is the whole
  mechanism — there is no skill-linting framework, no schema for skill bodies, and no generated
  documentation. Roughly one regex, one resolve loop and an assertion.
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
  prompt text is never an authorization boundary, because a skill body is not a trust boundary.
- **INV-SKILL-3 (no hand-rolled privileged command):** no skill instructs the agent to compose a key
  mint, a key revoke, a VM destroy, an `ssh` into a box, or a git push. Those encode measured guards
  and a hand-rolled version drops one silently (orchestrator `SKILL.md:19-22`); they are reachable
  only through a registry verb.
- **INV-SKILL-4 (fail-closed on the unknown):** an unrecognised verb, a missing prerequisite, or a
  failing preflight ends in report-and-stop. No skill offers a workaround path, a fallback command,
  or a retry the CLI did not itself offer.
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

- [ ] **Impl:** four `SKILL.md` files under `.claude/skills/factory/`, each ≤200 lines, each naming
      its verbs in frontmatter `description` and holding judgment rather than command construction.
- [ ] **Impl:** `factory-guide` documents the one-command preflight (`fleet --help`) with
      report-and-stop on failure, and carries the single commercial-terms statement.
- [ ] **Contract (containment scope, AC7):** `factory-guide` states the v5.0 containment scope —
      BYOK direct-provider egress only, **no** per-VM egress allowlist on exe.dev, re-enters with the
      OCI driver (§8 step 7) — and cites DD-11; a test asserts all three clauses and the DD-11
      citation are present in that file and absent as capability claims from the other three.
- [ ] **Contract:** `listVerbs()` in `src/fleet/verbs.ts` is the sole source of verb and flag names
      for both `fleet --help` and the skill-contract test — no second list is introduced.
- [ ] **Integration:** the fan-out verb (DF3.2) and the decision verbs (DF3.4) resolve through the
      registry before any skill documents them; a missing verb fails AC1 rather than review.
- [ ] **Security:** no skill file carries a token or a hand-rolled mint/revoke/destroy/ssh/push
      command (INV-SKILL-1, INV-SKILL-3).
- [ ] **Test (unit):** frontmatter of each skill parses, `name` matches its directory, and
      `description` names at least one exported verb.
- [ ] **Test (unknown-token):** a fixture skill body containing `fleet dispatch --parallel 4`
      against a registry exporting `--fanout` fails with the file, line and offending token.
- [ ] **Test (pricing + containment lint):** every file this story adds is scanned with AC4's **six**
      fixed case-insensitive patterns → zero hits outside the two verbatim `factory-guide` allowlist
      entries; a fixture file containing `$0.40 per run` fails with `file:line` and the pattern id
      (INV-SKILL-5), and a fixture claiming `egress is allowlisted per VM` fails on pattern (f)
      (INV-SKILL-6).
- [ ] **Test (e2e demo — MANDATORY):** `tests/fleet/skill-contract.test.ts` extracts the documented
      command sequence from `factory-dispatch/SKILL.md` and `factory-observe/SKILL.md`, runs it
      against the `fake` driver, and asserts the `runId` printed by the dispatch command is the
      `runId` the observe command is invoked with — one automated run, no human in the loop. A
      Claude Code transcript exercising the same two skills is captured in the Dev Agent Record as
      **supporting evidence only**; it is never the passing criterion.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
