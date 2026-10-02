# v6 Cross-Repo Contract — QDS-Factory ↔ Solstice/swarmclaw

**Date:** 2026-10-02
**Status:** ACTIVE — the binding contract for every v6 story that touches both repos
**Source:** charter `_bmad-output/sprint-artifacts/dark-factory-v6/2026-10-01-v6-derivation-session-INPUT.md` §5 (seed, formalized here) + research `R1`–`R5` in `_bmad-output/workflow-state/qds-sprint-planning/v6/research/`
**Decision authority:** DD-14+ register `docs/superpowers/specs/2026-10-02-v6-story-derivation-decisions.md`

---

## 0. The one-line rule

**Zeropoint code never enters the factory import graph.** Coupling exists at exactly three
surfaces, and nowhere else:

1. the CLI JSON contract (`Q1` discipline + the `factory_observe` extension, Z1),
2. pinned-rev / spec-seam fixtures (compile-time-faked, never imported),
3. live evidence files (`_bmad-output/evidence/`, scrubbed).

A CI-green factory with the Solstice checkout deleted from disk is the invariant. If any v6
story cannot be built under that rule, the story is wrong — fix the story.

**Citation marker (DD-28.8/28.26):** cross-repo file citations carry a `fork:` or
`solstice:` prefix — the reviewer's marker that the citation was verified against the OTHER
checkout and is unresolvable (by design) in this repo. Bare cross-repo cites are
checker findings when they are line-numbered code cites (`path.ext:N`, ext ∈ {ts, tsx, sh,
json, yaml, yml, md} — the checker's extension set and the only form it resolves;
`scripts/check-story-consistency.ts` exempts prefixed cites only). A path mention without a
line number carries nothing the checker can decide and stays on review. A bare `:N` (a
`(:119)`-style parenthetical) is not a cite form of its own — it is a continuation riding
its antecedent cite's path.

## 1. Contract-as-code (the Q1 discipline, extended)

Every verb-shape the fork adapter consumes stays pinned by the Q1 contract discipline
(Proven: SC1/SC2; carried by Z1 into the observe consumption surface):

- exact field-set pins — **missing AND extra fields fail by name**;
- literal `SCHEMA_VERSION` compared, never ranged;
- closed status enums (adding a member is a version bump, never a silent extension);
- the exit-code table (0–6, `src/fleet/verbs.ts` registry — 16 verbs, closed);
- the contract is the **only** code-level coupling; it moves only via a deliberate,
  both-sides-reviewed version bump (precedent: #380's identity-grammar finding).

Z1 owns the contract text. Z2 (fork-side `factory_observe` step kind) and Z3 (the live exit
round) consume it verbatim. When the contract text and any consumer disagree, the contract
text wins and the consumer is the bug.

## 2. E21 spec-seam fixtures (factory tests against seams AS WRITTEN in the E21 spec)

Factory stories that will run inside E21 Homes code against **fakes honoring the E21 seam as
the E21 spec defines it** — today's seam symbols, not a guessed future API:

| E21 gate | Seam (as written in the E21 spec) | Factory fake |
|---|---|---|
| S02b (in-flight) | `TURN_REFUSALS` vocabulary + `isHomeBackedAgent` predicate | fake Home-bot journal asserting turn-principal behavior |
| S03b (backlog) | the four `SOLSTICE_*_TOKEN` names + `writeProfileTokens` | fake profile-token writer asserting key removal |
| S05a/b (backlog) | `acp-approval-firewall.ts` approvals interception + the approvals inbox | fake inbox relay asserting **channel ≠ policy** (gate untouched) |
| schedules | durable wake = schedule-repository + watch-job-repository (**not** `enqueueSystemEvent` — in-memory, cap 20/session) | fake wake source with durable semantics |

Pattern: extend the proven SC2 **fake-CLI-journal** pattern to a fake Home-bot/gateway journal.
Result: factory CI is green **before, during, and after** E21 lands, and E21 slip costs v6
nothing but the gated stories' dev start.

**E21 status pins (2026-10-02, verified R4):** S02a is DONE (fork #699 + parent #531) — the
charter's "in-flight" listing is stale; S02b is the only in-flight gate; S01/S10a story-file
headers read stale "backlog" while the EPIC's Wave A records them merged — the EPIC is the
authority. Factory writers cite the EPIC, not the stale headers.

## 3. Pinned fork revs

- `SWARMCLAW_FORK_REV` constant + drift-alarm test **in the factory repo** (Z1); advanced
  only by a deliberate bump PR — mirrors the image-pin adoption ritual (`scripts/adopt-image-pin.ts`,
  #396–#398 precedent).
- Z2's fork PRs merge on **fork dev**; the factory pin bumps only at evidence rounds (a live
  round is the only thing that justifies moving the pin).
- The fork submodule in `/Users/steve/Solstice` tracks its own dev; the factory never imports
  from any Solstice path (rule §0).

## 4. CI-greenness invariant (restated for the checker era)

Zeropoint/swarmclaw code never appears in the factory import graph. The three legal couplings
(§0) are each mechanical: a JSON schema test, a fixture file, a scrubbed evidence JSON. The
story-consistency gate (`scripts/check-story-consistency.ts`) and CI enforce what they can;
review enforces the rest.

## 5. Counterpart stories, one contract text

Zeropoint-side work beyond E21's slate (the `factory_observe` step kind, trigger wiring, the
notify leg, factory bot profiles) is filed **in the solstice repo from this same derivation**,
classified **BUILD-IN-FORK** per E21 vocabulary. The factory story (Z2) carries the factory-repo
files; its Files-to-Modify section names fork-repo files explicitly and marks them BUILD-IN-FORK.
Factory points cover factory-repo work + joint rounds only.

## 6. Live rounds are the only real-behavior assertions

The live-round stories — M1.2 (T2), M2.3, Z3, and the protocol-driven A2/A3 rounds — are the
only places real cross-repo behavior is asserted. Binding on every one of them:

- the no-fakes hard rule (`*.live.test.ts`, `QDS_E2E_LIVE=1` + `QDS_E2E_TIER ∈ {1,2}` exactly;
  T3/4/5 are naming over TIER=2);
- worst-case spend printed **before** the round runs;
- operator GO gate — no live spend without it;
- keys and boxes cleaned in `finally`;
- evidence scrubbed → `_bmad-output/evidence/`.

## 7. Deploy coupling

The Vultr VPS deploy profile (Z4) **extends** the `vultr-deploy` template
(`/Users/steve/Solstice/.claude/worktrees/vultr-deploy` @ d0c513fa — `deploy/control-plane/`);
it does not treat the QDS runbook (`_bmad-output/plans/2026-09-30-vultr-vps-deploy-runbook.md`)
and the template as independent deployables. The control-plane compose today holds only
control-plane + caddy; Z4 **adds** the factory services (dedicated Hindsight 0.10.0, M2 memory
gateway, fleet CLI wrapper). The deployed wrapper owns `--driver exedev`; the fork never learns
the driver grammar. Port 18889 is never public (firewall 22/80/443 only).
