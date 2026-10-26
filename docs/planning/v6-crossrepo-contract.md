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

## Z3 round record

The operator runbook for the v6 exit round (`tests/fleet/e2e/z3-exit-round.live.test.ts`, story
`z3-cross-repo-live-exit-round`), and the contract deltas the round's build observed. Each step
below is checked by the test's preflight or gates; the test refuses before any spend when a step
is missing.

### Prerequisites (all must hold before a GO)

- **Upstream blockers closed.** The test refuses FIRST, by name, while
  `Z3_UPSTREAM_BLOCKERS` (`scripts/z3/round-plan.ts`) is non-empty:
  - [#467](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/467): harvest
    persistence. The findings sidecar writer (`src/phase-engine/findings-sidecar.ts`) is
    merged, but it runs in the box: the exe.dev image must be re-published and its pin
    adopted before a live QA leg writes `journal/findings.json`.

  [#465](https://github.com/Quantum-Digital-Solutions/QDS-Factory/issues/465) (findings-only
  runs stranding in `pausing`) is fixed host-side and no longer listed. Unblocking is the code
  change that deletes the entry.
- A2, Z2 and M2.1 are done. The fork counterpart (`protocol-z3-exit-round.ts`,
  `scripts/solstice/z3-exit-round.ts`) is merged to the fork's `dev`. The T2 box image re-pin
  ritual has landed.
- The shared exe.dev account is **quiet** during the round. Cleanup charges every fresh box no
  round run claims as a possible leak.

### Fork container (rebuild + recreate, never just restart)

1. Rebuild the fork image from the merged counterpart rev. `scripts/solstice/z3-exit-round.ts`
   ships only inside the image. Label it with
   `--label org.opencontainers.image.revision=<that rev>`; the trigger leg cross-checks the label
   against `SWARMCLAW_FORK_REV`, and records `unverifiable-from-image` when the label is absent.
2. Mount this factory clone **read-write** at `/factory`. The gate journal, the run records, the
   ledger and the recall rows are all shared through it.
3. Write the gate's real CLI: `echo <abs path of the current fleet shim> > .sandbox/z3-gate/real-cli`.
   On the VPS profile this is `deploy/vps/fleet-wrapper.sh`. The shim must `cd` into the
   `/factory` clone and use the same runs dir the host reads (`QDS_RUNS_DIR` unset, which means
   `.sandbox/runs`). The fork's fleet child has no cwd of its own, and its env allowlist strips
   `QDS_RUNS_DIR`.
4. Set `SWARMCLAW_FACTORY_FLEET_CLI=/factory/scripts/z3/fleet-gate.sh` through a compose
   `environment:` override, then **recreate** the container (`docker compose up -d
   --force-recreate <fork service>`). A restart keeps the old env.
   `scripts/z3/fleet-gate.sh` is committed `100755` (the index mode is asserted by
   `tests/z3/fleet-gate.test.ts`), because the fork execFile()s it with
   `shell: false`.

`preflightFork()` refuses the round before the GO gate in any of these cases (the fork image must
carry bash, coreutils `timeout`, a fractional `sleep` and a writable `mktemp`):
- the env override is not in force;
- the wrapper or the real-cli is not executable inside the container;
- the container cannot write `/factory/.sandbox/z3-gate`;
- the fork CLI's `state` does not answer the contract.

### Memory: the agent token

Mint one M2.1 **host-class** agent token (verbs `reflect`) for the repo bank that dispatch's
recall reads. That bank is `resolveProvisionedRepoBankId(resolveBankId("<owner/name>"),
<existing banks>)`, the org-slug family; see the INV-Z3-6 delta below.

```bash
bun -e 'import { grantAgentToken, memgateDeps } from "./src/memgate/gateway.ts";
const t = grantAgentToken(memgateDeps(), { consumerClass: "host", banks: ["<repo bank>"], verbs: ["reflect"], requestId: "z3-round-token", name: "z3-exit-round" });
console.log(t.token)'
```

The snippet needs `MEMGATE_ADMIN_KEY` and `QDS_MEMGATE_SIGNING_KEY` exported (`memgateDeps()` refuses
without them), and must open the same ledger the round reads: `QDS_MEMGATE_LEDGER`, or the default
`.sandbox/memgate-ledger.db`. Export the token as `Z3_MEMGATE_AGENT_TOKEN`. Evidence records only its tokenId. No agent class
may `recall`, which is why the round's gateway assertion is a `reflect`.

### Round inputs

- **Participants:** `Z3_PARTICIPANTS` lists existing fork agent ids. `arm` refuses unknown ids.
- **Parking manifest:** `Z3_CODE_MANIFEST_PATH` must name a manifest whose completion chain
  parks at the approval gate, as SC2.7's did: `config/rosters/df53-demo.pipeline.json`, which
  parked at `awaiting-approval` in the 2026-09-30 exit chain.
- **Environment:**
  - Live gating: `QDS_E2E_LIVE=1` and `QDS_E2E_TIER=2`.
  - Substrate: `QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`,
    `OPENROUTER_PROVISIONING_KEY`.
  - Evidence and fork rev: `QDS_E2E_EVIDENCE_DIR=_bmad-output/evidence/v6-z3`,
    `SWARMCLAW_FORK_REV=<rebuilt rev>`.
  - Arm config: `QDS_REPO_SLUG=<owner/name>`, `Z3_QA_GROUP_CAP_USD`, `Z3_CODE_GROUP_CAP_USD`,
    `Z3_CODE_MANIFEST_PATH`, `Z3_CODE_INSTRUCTIONS` (≤ 600 chars), `Z3_PARTICIPANTS`,
    optional `Z3_SESSION_ID`.
  - Memory: `QDS_KG_GATEWAY_URL`, `Z3_MEMGATE_AGENT_TOKEN`, plus the host Hindsight env
    (`HINDSIGHT_BASE_URL` and the bearer token).
  - Overrides only: `Z3_FORK_CONTAINER` (default `swarmclaw-swarmclaw-1`), `Z3_FORK_CLI`,
    `Z3_FORK_WORKDIR`.

### GO, fire, evidence

1. Record the GO in `_bmad-output/evidence/v6-z3/operator-GO.json`, with these fields:
   - `who`;
   - `when`: at most 24 h old and NOT in the future (zero tolerance, so the GO always predates the fire);
   - `spendApproved.worstCaseUsd`: at least the printed total, which is the fleet caps plus the
     host-side gateway `reflect` allowance (`Z3_REFLECT_CALL_USD` × (QA legs + 2));
   - `swarmclawForkRev`: equal to `SWARMCLAW_FORK_REV`.

   **One GO per round:** the test runs its setup checks (crash gate, the z3 schedule snapshot)
   first, so a setup refusal never burns the GO. It then CONSUMES the GO, moving it to
   `<stamp>-operator-GO.consumed.json`, which is committed with the evidence as the round's GO
   record. A re-run finds no GO and refuses until a new one is recorded.
2. Run `bun test tests/fleet/e2e/z3-exit-round.live.test.ts`. The test runs these in order:
   - the blocker refusal, then the preflight (fork setup, plus one `reflect` probe through the
     gateway with the agent token);
   - the worst-case print, then the GO gate;
   - arm the crash gate, snapshot the z3 schedule ids, then arm the schedule. On ANY arm failure
     (exit, timeout, unparseable output) every z3 schedule not in the snapshot is disarmed and its
     runs are cancelled. That sweep runs TWICE: once at once, and once more after the in-container
     arm is dead by construction. Every fork CLI call runs under coreutils
     `timeout -s KILL`, 15 s inside the host timeout, because killing the `docker exec` client
     does not kill the in-container process. The arm's runAt lead (≈ 9 min) covers the 4 min
     arm timeout, the kill margin and the second sweep. The arm
     config carries `codePollTimeoutMs`, derived as the 300-minute round budget minus the QA legs'
     1 h fork deadlines (`codePollTimeoutFor`, 2 h); it covers `z3-code-run` and `z3-code-observe`;
   - check the caps read-back;
   - run the round.

   Budgets, written down in `Z3_LIVE_BUDGET` (`scripts/z3/live-round-wiring.ts`) and asserted by
   `tests/z3/wiring.test.ts`: pre-round (preflight, the gateway probe, the arm and its ≈ 9 min
   lead) + the round (300 min of fork step deadlines + 10 min of fork-heartbeat slack) + cleanup
   (the sum of its worst-case steps including the watcher's stand-down, about 86 min, on its own
   deadline) + a 10 min margin = the test timeout.

   Every path after arming disarms the schedule and aborts the gate. Disarm is followed by a
   fresh `state` re-read, because the fork's disarm has no cross-process lock, and every run
   carrying the scheduleId is cancelled. The round's own `finally` cancels, sweeps (including the
   cancel's `inFlightRequestIds`, attributed by request id), destroys and revoke-verifies.
3. After a failed round, check `state`. The crash window kills the fork as soon as the code submit
   is held, and restarts it only after the last host retain. A round that failed in between leaves
   the fork DOWN. In that case:
   - restart it (`docker start <fork container>`); the gate's `abort` file makes the replayed code
     submit exit 99, so it spends nothing;
   - `cancel <protocolRunId>` through the fork CLI and re-read `state` (the round's own cancel
     could not reach a dead fork);
   - remove `.sandbox/z3-gate/abort` before the next round (`arm()` also clears it).

   Red-round triage beyond Z3's own legs:
   - A QA leg failing with `submit-in-flight` (exit 5) was the fork poller replaying a still-running
     first submit (R3 E-3). The fork counterpart PR fixes it (`submitsInFlight` guard in
     `protocol-factory.ts`); seeing it again means the fork image predates that fix.
   - A schedule still unfired 4 min past its runAt is fork hibernation (`SOLSTICE_HIBERNATION`) or
     a stalled tick.
4. Commit the round's scrubbed evidence: every `-z3-*.json` plus the `-z3-round-manifest.json`,
   which a later audit uses to rebuild the registry. Then, from round provenance (Z1 AC5, never
   guessed):
   - add the `v6-z3/` rows to `_bmad-output/evidence/openrig-sc2/fork-rev-manifest.json`;
   - add `"v6-z3"` to `STAMPED_EVIDENCE_DIRS` in `scripts/swarmclaw-fork-pin.ts`.

   That is the pin-bump occasion Z1 names.

### Contract deltas observed

- **INV-Z3-6, bank ids.** The story requires "explicit `qds-` bank ids every call". Dispatch's
  recall reads the org-slug family (`resolveProvisionedRepoBankId(resolveBankId(slug))`, seam
  gap #11), which carries no `qds-` prefix for org-scoped slugs. The round therefore retains into
  that family, and the `qds-` check is delegated to `retainFindings`' dispatch-family guard
  (`src/qa/retain.ts`), which refuses any bank outside the repo's provisioned family. The
  round-side assertion checks `BankIdSchema` (`scripts/z3/assertions.ts` AC5).
- **AC4 double-booking surface.** AC4 names Z1's status/result surface. The round reads the cost
  ledger's `gate_admissions` and `budget_group_admissions` by request id, readonly, which is a
  stronger witness than `fleet status`/`result`, whose payload carries only `spendMicroUsd`.
- **The gateway assertion is a `reflect`.** No M2.1 agent grant class carries `recall` (host:
  reflect/retain; bot: consolidate), so a recall-shaped assertion could never authenticate.
  `reflect` is not read-only: it is LLM-backed bank work. It is exempt from the round's
  box-credential verb rule (`READ_ONLY_MEMORY_VERBS` classifies BOX credentials; this call is
  host-side), and its cost is budgeted (`Z3_REFLECT_CALL_USD` per call, inside what the GO must
  approve).
- **D-1, ADR-2 is ACCEPTED, and ON is unreachable.** `docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md`
  was accepted on 2026-10-15 (G1), but the story text still calls it PROPOSED. G1 shipped the
  fail-closed machinery: `src/fleet/auto-merge-policy.ts` (`readAutoMergePolicy`) and the
  `consultAutoMerge` consult in `src/fleet/run-completion.ts`, both fail-closed. ON is
  structurally unreachable until the clause-5 veto-window carrier (`enqueueVetoWindow`,
  `veto-window.ts` plus its suite) is in the tree; the loader returns `off` /
  `clause5-carrier-absent` without it. Z3 therefore still asserts park → human decision.
  - AC2 reads: **treating ADR-2 as license to auto-merge while ON is structurally unreachable (the
    clause-5 veto-window carrier `enqueueVetoWindow` is not in the tree) fails**.
  - INV-Z3-2 is asserted, not assumed: the trigger leg records the policy state from a read-only
    `readAutoMergePolicy` probe at the fire, and AC2 fails when the state is ON, unrecorded, or a
    decision carries the policy approver id (`policy:adr-2`).
