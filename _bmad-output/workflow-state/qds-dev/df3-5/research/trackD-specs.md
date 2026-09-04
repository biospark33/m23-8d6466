# Track D — Spec Review (DF3.5 Tier-1 Factory Skills)

**Date:** 2026-08-31 · **Track:** D (spec review) of qds-dev Phase 2 research wave · **Story:**
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-5-tier1-factory-skills.md`

All quotes verbatim with `file:line`. Line numbers for spec docs are from the working-tree files
listed; line numbers for upstream skills are from the local clones under
`/Users/steve/reference-repos/` (both MIT, (c) 2026 IndyDevDan).

---

## 0. Headline findings (read first)

1. **R4 does NOT contain the excerpts the story calls binding.** The story (Spec Reference,
   lines 21–22) says *"The excerpts quoted in `R4-external-patterns.md` are the **binding** text
   for this story"* — but `R4-external-patterns.md` contains **no** quote of "THIN SKILL, FAT
   RECIPES", "volunteered state is guessed state", or the orchestrator `:19-22`/`:33-36` passages
   (verified by case-insensitive grep over the whole file). R4 quotes inkwell *cookbook and just-file*
   material (§3.5/§3.6), not the two SKILL.md files. **The actual binding text resolves cleanly in
   the local clones** (§4 below) — every line anchor in the story is substantively exact there, which
   the P12 fix-wave verdict also recorded ("Verified against the live reference repo … all three
   citations are substantively exact", `_bmad-output/workflow-state/qds-sprint-planning/df-v5/verdicts/P12.json`).
2. **The story's "not present on this host" note is stale.** Story lines 18–22 say the `INK/`
   checkout "is **not present on this host**". Both upstream repos **are** cloned at
   `/Users/steve/reference-repos/super-simple-software-factory` and
   `/Users/steve/reference-repos/inkwell-agent-sandboxes-and-software-factory`. The `INK/` anchors
   are openable today; treat the story note as historical, not as a blocker.
3. Inkwell's vendored `.claude/skills/sssf/SKILL.md` is **byte-identical** to
   super-simple-software-factory's `.claude/skills/sssf/SKILL.md` (both 76 lines; the
   `:28` "volunteered state" line matches in both).

---

## 1. Architecture design doc — binding spec text

Source: `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` (r2).

### §5.1 tier 1 (lines 315–321)

> ```text
> TIER 1 — COCKPIT (operator machine)
>   Claude Code (Max sub) + factory skills
>   └─ fleet dispatcher CLI (TS, tested): dispatch | fanout N | status | attach | harvest | teardown
>        │  provider-driver interface (create/fill/setup/execute/observe/teardown/reap)
>        ├──────────────► exe.dev driver          (hosted tier: mid-market)
>        └──────────────► OCI driver              (client-VPC tier: enterprise; Firecracker/Kata option)
> ```

Note: the design's tier-1 verb list includes `reap` at the *driver* layer; DF3.5's Trigger Surface
records that v5.0 exports no `fleet reap` (orphan reaper is DF2.6's `scripts/sandbox-reap.ts`, and
no skill documents it as a verb).

### §8 step 3 (lines 450–451)

> 3. **Fleet dispatcher + tier-1 skills** (dispatch, fan-out N, status, attach, harvest,
>    teardown, reap). Best-of-N becomes code.

### §8 step 7 (lines 456–457)

> 7. **OCI driver** when the first enterprise conversation demands it (image contract
>    defined in step 2 so no rework).

### §4 decision D3 (line 300, decision-register row)

> | D3 | **Tier 1 = Claude Code (Max subscription) driving a *code* fleet dispatcher via skills.** Dispatcher is tested TS, not prompt-glue. | Frontier intelligence at near-zero marginal cost for the operator; deterministic dispatch (disler's fleet layer is an un-coded bash cookbook — a gap we close with real code). Client deployments provision their own Claude auth. **Review caveat (F8):** commercial/hosted operation cannot rest on a personal Max subscription — consumer terms don't cover running a paid service; tier-1 unit economics must be re-run at API pricing before the hosted tier is priced (pre-derivation gate, §8). | Agent-improvises-fleet-commands (drops measured guards silently — disler's own skill forbids it). |

### §6 item 3 — Data containment (lines 382–388) — the containment/egress clause DD-11 scopes

> 3. **Data containment:** enterprise tier runs entirely inside the client boundary;
>    hosted tier uses BYOK with direct provider egress + provider-side ZDR (never a
>    third-party managed gateway until logging is contractually answered). Per-box
>    egress allowlists are **DEFERRED to the OCI driver (§8 step 7, see DD-11);
>    exe.dev exposes no per-VM egress control today**, so for v5.0 the hosted-tier
>    guarantee is scoped to direct-provider egress and must not be sold as an
>    allowlist. The policy re-enters once the OCI driver owns the network namespace.

Also relevant, §6 item 5 (lines 392–394):

> 5. **Blast-radius honesty:** sandboxes contain spend and credentials; egress policy
>    contains data; agents inside run with skip-permissions *because* the box, not
>    instead of it. No claim of containment we can't enforce in code.

---

## 2. Story-derivation decision register — binding text

Source: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`.

### DD-1 — operator-CLI-only channel (line 46)

> | DD-1 | **#1 Channel layer has no build-order step** | **DECIDED: operator-CLI-only for v5.0.** Tier 1 is Claude Code + the tested fleet-dispatcher CLI; the operator is the channel. No channel story is derived. OQ-3 stays BLOCKED-on-creds; the Hermes fallback stays recorded-only. Channel↔factory bridge re-enters at a future vX derivation with working credentials, as a DF3-adjacent sub-epic. Writers must not assume Telegram intake anywhere. |

### DD-11 — egress deferral (line 96)

> | **DD-11** | **Per-box egress policy (D8 / design §6.3) — DEFERRED to the OCI driver (§8 step 7).** exe.dev exposes no per-VM egress control today, so no v5.0 story can enforce it. The §6.3 data-containment claim is therefore **scoped to BYOK direct-provider egress** for v5.0 and **must not be sold as an allowlist**; DF3.5's factory-guide wording carries that scope caveat. The policy re-enters with the OCI driver, where the network namespace is ours. |

### DD-8 — writers consume R2, never audit §3 directly (line 85)

> | **DD-8** | **Writers consume R2 §1–§11, never audit §3 directly.** True surviving clauses paste verbatim from R2's quoted source text (real labels + line numbers). Items R2 marks NET-NEW are authored **fresh** in their mapped successor story, cited to design §5.2 / PR #97 / the gates report — not under the "survives verbatim, do not re-litigate" banner — and get full adversarial review like any new material. |

DD-8 does not directly bear on DF3.5 (net-new story, no surviving clauses), but it governs how any
quoted ancestry in the skill files must be attributed.

### §5 row "F8 condition 2 + R6" (line 68)

> | F8 condition 2 + R6: tier-1 priced at API rates only; org-owned-API-key-only for client deployments; Commercial Terms §A.1 is the load-bearing grant | Constraint on **DF2.8** + **DF3.5** wording (no Max-derived rate anywhere) |

### Appendix finding FF13 — exit-code 6 taxonomy freeze (lines 137–141, deferred-seam register)

> - **FF13 — exit code 6 carries two meanings** (fleet verbs: "cleanup after success failed";
>   dispatch ack-unwritable: "neither"). The registry NOTE documents the split; DF3.5's skill
>   contract test inherits it. Direction when unified: split into distinct codes OR scope 6 to
>   "work landed, reporting failed" everywhere and give ack-unwritable its own number — pick
>   BEFORE DF3.5 generates skills, after that the taxonomy is frozen into generated artifacts.

**Constraint beyond the story file:** if a skill body explains exit code 6, it must carry the split
(both meanings) as the registry NOTE documents it — the taxonomy freezes once DF3.5 lands.

---

## 3. R5 §6 — binding facts

Source: `_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md`,
§6 "Known facts writers must NOT contradict" (header at line 396).

### Fact 10 (lines 451–456, verbatim)

> 10. **Commercial Terms §A.1 is the load-bearing pricing argument.** There is **no blanket "no
>     commercial use" clause** in the Consumer Terms — the argument is the **absence of grant**: the
>     permission to "power products and services Customer makes available to its own customers and end
>     users" exists only in §A.1. §13 stipulates injunctive relief, making it commercially forced.
>     Client-deployed tier-1 = **org-owned API key under Commercial Terms**, always. **No Max-derived
>     rate may appear in any commercial floor.**

### Fact 17 (lines 487–488, verbatim)

> 17. **No push credential in any box; PR creation is host-side** (D8). Exactly one secret per box: a
>     spend-capped, per-run, revocation-verified LLM key.

Fact 17 is the binding source behind AC2's "no `git push` instruction" clause and INV-SKILL-3.

---

## 4. Upstream skill verification — R4's claimed excerpts vs the local clones

The story's four `INK/` anchors resolve in the **inkwell** clone
(`/Users/steve/reference-repos/inkwell-agent-sandboxes-and-software-factory/.claude/skills/`).
Verification result: **all four are substantively exact.**

### 4.1 "THIN SKILL, FAT RECIPES" — `sssf-sandbox-orchestrator/SKILL.md:13-25` ✅

> ```
> ## The one governing principle: THIN SKILL, FAT RECIPES
>
> **Every action you take should be a `just` command a human could type.** The recipes hold the
> knowledge; this skill holds the judgment about which one to run and how to read the result.
>
> - Dropping to `ssh <vm>.exe.xyz '...'` or `curl` to **inspect** is fine and expected — that is what
>   `just sbx run cmd <id> '<cmd>'` exists for, and reading a log or a table needs no ceremony.
> - Re-implementing what a recipe already does is not. Never hand-roll a key mint, a revoke, an
>   `ssh exe.dev new`, a `share port`, or a detached `nohup` launch. Those encode measured facts
>   (mint order, the revocation gate, the proxy retarget, the three detachment pieces) and a
>   hand-rolled version drops one of them silently.
> - If a recipe is wrong, **fix the recipe** and say so. Do not route around it.
> ```

The story's paraphrase ("never hand-roll a key mint, a revoke, an `ssh`; if a recipe is wrong, fix
the recipe") matches `:20-24` exactly. The `:15-16` line — "The recipes hold the knowledge; this
skill holds the judgment about which one to run and how to read the result" — is the direct ancestor
of the story Overview's "Each skill body holds judgment — which verb, how to read the exit code,
when to stop — and nothing else."

### 4.2 Orchestrator `:19-22` (AC2's citation) ✅

Lines 18–23 (the two bullets above): inspection via raw `ssh`/`curl` is "fine and expected";
re-implementing a recipe is not — "Never hand-roll a key mint, a revoke, an `ssh exe.dev new` …
Those encode measured facts … and a hand-rolled version drops one of them silently." Matches AC2's
forbidden-composition list (ssh, curl, key-mint, key-revoke, VM-destroy; `git push` added per D8 —
that word is ours, not upstream's).

### 4.3 Orchestrator `:33-36` (AC5's citation) ✅

> ```
> **Preflight is one command.** Run it before the first phase; any failure means report and stop,
> never work around a missing prerequisite by hand.
>
> ```bash
> just sbx manage doctor
> ```
> ```

(`:33-34` the doctrine sentence, `:36-38` the fenced preflight.) This is the exact
report-and-stop-on-preflight-failure shape AC5 and `factory-guide`'s DoD item encode with
`fleet --help`.

### 4.4 "Volunteered state is guessed state" — `sssf/SKILL.md:28` ✅ (both clones, byte-identical)

> - **Volunteered state is guessed state.** An orchestrator that improvised a status board queried a `runs` table and a `payload` column — neither exists (`sessions`, `payload_json`). The spec that would have said so is `references/observability.md`, one lazy read away. Probing to look prepared is how you end up confidently wrong in your first message.

Sibling bullets at `:29-30` ("It spends the context the real task needs … It is stale on arrival")
and the orchestrator rule at `sssf/SKILL.md:42`:

> - Observe by querying `adws/adw_data/sssf.db` (WAL — reads never block writers) **when observing is the task**. This is a capability, not a startup step: query it to follow a run you launched or one the engineer asked about, never to volunteer a status report nobody requested.

And `sssf/SKILL.md:43`:

> - Report phase status plainly: name, owner, status, error if any.

### 4.5 What R4 *does* contain on the inkwell skills (for completeness)

- `R4-external-patterns.md:911-913` — verbatim quote of
  `INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/teardown_and_reap.md:6`:
  > **Status, honestly: teardown and reap are written but have NOT been run.** Five of the six phases…
  (Confirmed verbatim in the local clone: the cookbook's blockquote reads "teardown and reap are
  written but have NOT been run. Five of the six phases were verified end to end on a live VM on
  2026-08-04. Teardown is the sixth and is unexercised.")
- `R4-external-patterns.md:923-928` — teardown's 7-step order (see §6 below).
- `R4-external-patterns.md:856-891` — the exe.dev seam (~6 command shapes) and the
  verified/unverified response-shape honesty pattern.

---

## 5. Skill-file structure conventions worth lifting

From `sssf-sandbox-orchestrator/SKILL.md` (151 lines), `sssf/SKILL.md` (76 lines),
`sandbox-exe-dev/SKILL.md`, `herdr/SKILL.md` (inkwell); cross-checked against this repo's existing
`.claude/skills/gitnexus/*/SKILL.md` and `.claude/skills/qds-live-e2e/SKILL.md`.

**Frontmatter keys:**
- Upstream uses `name`, `description`, `argument-hint` (orchestrator, sssf, herdr carry
  `argument-hint`; sandbox-exe-dev does not). Our repo's loader convention (gitnexus, qds-live-e2e)
  uses **`name` + `description` only** — the story's AC2 pins exactly these two ("a `name` matching
  its directory and a `description` naming the verbs it routes to"). Do **not** import
  `argument-hint`; it would fail the story's frontmatter assertion shape.
- Upstream `description` formula worth copying: "<what it drives>. Use when the user says X, Y, Z.
  Keywords - a, b, c." — this is the description-keyword auto-invocation surface the story's
  Trigger Surface names.

**Section layout (orchestrator, in order):** title + one-paragraph scope → **one governing
principle** ("THIN SKILL, FAT RECIPES") → **Dependencies** ("references … rather than duplicating
them … Read them; do not quote them", `:28-31`) → **preflight** (one command, report-and-stop) →
capability/credential-boundary table → **drive surface** (command table: Command | What it does,
with per-command behavioral caveats like "**Never teardown.**", "Idempotent.", "Dry run by
default.") → **Cookbooks** lazy-load table (Activity | When to read | File) → **References**
(deep specs, read on demand) → **Hard rules** (numbered, bolded rule name, 2–4 lines each).

**Report-and-stop phrasing, liftable nearly verbatim:**
- `:33-34` — "any failure means report and stop, never work around a missing prerequisite by hand."
- `:106-107` — "A failure **reports, stops, and leaves the VM alive**."
- Hard rule 3 (`:142-144`) — "**A gate failure means STOP and diagnose, never destroy.** … Re-running
  setup is safe."
- Hard rule 6 (`:150-151`) — "**Report the run id every time.** It is the only handle the next
  phase, the next session, and `teardown` have." (Direct ancestor of DF3.5's Observability Contract
  runId-chaining bullet.)
- `:100-101` — "use that string, not the one you typed" (the run id the CLI prints is the handle —
  matches the story's "carry the `runId` the verb printed into every follow-up verb").

**How recipes are referenced:** never inlined — a markdown-link table with a "when to read" column
("lazy-load the one the request calls for", `:109`), plus the Dependencies doctrine: "a copy pasted
here would be a second source of truth that goes wrong quietly" (`:30-31`). For our skills the
analogue is: the verb registry is the source of truth; skill bodies name verbs, never restate flag
semantics beyond what the registry/`--help` owns.

**Doctrine directly liftable into our four skills:**
1. Thin-skill/fat-recipes governing principle → thin-skill/fat-**CLI** (AC2, INV-SKILL-3).
2. "Fix the recipe, do not route around it" → "fix the verb/registry, never hand-roll" (INV-SKILL-3).
3. Preflight = one command, failure = report-and-stop (AC5; `fleet --help`).
4. Unknown request → consult the index and stop: sssf/SKILL.md's routing-table laziness +
   "volunteered state is guessed state" → factory-observe/factory-guide should never volunteer
   status nobody asked for, and AC3's "run `fleet --help` and stop, not guess the nearest verb".
5. Numbered "Hard rules" section as the containment list — maps to our INV-SKILL-* invariants.
6. Per-command table caveats ("Idempotent.", "The only destructive recipe.", "Dry run by default.")
   → per-verb caveats in factory-observe/factory-harvest.
7. Never-decide-teardown (hard rule 1, `:134-138`): "Report what the run produced, what it cost,
   and recommend — the human decides. … **`harvest` is the exception you may run freely** — it only
   reads the box and only writes `refs/sandbox/`, so run it as soon as a run commits rather than
   letting the commits wait on a teardown decision." Directly shapes factory-harvest: harvest early
   and freely; teardown only on an explicit human decision.

**Not present upstream (do not import):** no dispatch/observe/harvest-shaped guidance exists in
inkwell's `sandbox-exe-dev` (a provider-CLI surface doc — the `sbx→exedev` mapping table) or `herdr`
(terminal multiplexer). The only observe-shaped upstream doctrine is sssf/SKILL.md:42-43 (above)
plus `cookbooks/observe_and_report.md` ("makes a mounted sandbox watchable from **outside**,
without reaching in").

**MIT attribution template** (both repos, identical LICENSE header):

> MIT License — Copyright (c) 2026 IndyDevDan

Suggested per-skill footer (matches the repo's existing vendored-attribution style, e.g.
`pi-vs-claude-code-vendor/DIVERGENCE.md`): "Skill structure and doctrine adapted from
indydevdan/super-simple-software-factory and
indydevdan/inkwell-agent-sandboxes-and-software-factory, MIT License, (c) 2026 IndyDevDan."

---

## 6. Teardown ordering and observe/attach guidance — what the specs pin down

### Teardown order — "spend → harvest → revoke → kill → close" is real, and binding-shaped

- **Orchestrator `SKILL.md:97`** (the drive-surface table row for teardown):
  > | `just sbx lifecycle teardown RUN_ID [--no-harvest]` | spend → artifacts → **harvest** → revoke → destroy → close. **The only destructive recipe.** |
- **R4 §3.6 (`R4-external-patterns.md:923-928`)** expands the 7 steps:
  > - **`teardown <run-id> [--no-harvest]`** — 7 steps: capture spend → pull artifacts (`specs`,
  >   `app_docs`, `sssf.db`, `run.log` via one `tar` round trip) → harvest commits (failure aborts) →
  >   revoke key → destroy VM → close record + shred key file → gate on key absence from the list.
  >   Idempotent by construction, every step individually guarded …
  >   (`:17-19`). **The only file allowed to destroy a VM** (`:11`).
- **Design §5.3 (lines 362–364)** states the same order at the architecture level:
  > teardown:
  > spend captured, key revoked + verified, box destroyed, record closed → audit log + cost
  > ledger updated → memory capture into Hindsight banks.
  (Design puts harvest *before* the teardown phase in the data flow — "harvest: ranged git bundle +
  artifacts tar + trace db → tier-1 verifies bundle … → opens PR … → teardown" — consistent with the
  orchestrator: harvest happens, at the latest, inside teardown before revoke/destroy.)
- **Never-chain rule:** orchestrator hard rule 1 (`:134-138`, quoted in §5 above) and R4:930-931:
  > **`mount <run-id>`** (`INK/just/sandbox/mount.just:11-19`) chains create → fill → setup → observe
  > and **stops there by design**: "teardown is ALWAYS an explicit separate decision, never chained."
  Also the cookbook (`teardown_and_reap.md:10-12`): "Every failure path in create / fill / setup /
  execute / observe prints the teardown command and **leaves the box alive** — that is an offer,
  not a recommendation."

**Consequence for factory-harvest wording:** document the order as
spend → artifacts → harvest → revoke → destroy → close; state that harvest may run freely and early
(non-destructive, idempotent); state that teardown is the only destructive verb and is never chained
off dispatch or offered as a workaround on failure; note v5.0 has no `fleet reap` verb (reaper is
DF2.6's script — Trigger Surface row 3).

### factory-observe `status`/`attach` guidance

- Never volunteer state: `sssf/SKILL.md:28` + `:42` (quoted in §4.4) — observe **when asked**,
  report plainly ("name, owner, status, error if any", `:43`).
- **Attach carries no privilege** — DF3.4 INV-APPROVE-5
  (`df3-4-approval-gate-attach-steering.md:313-315`):
  > - **INV-APPROVE-5 (steering carries no privilege):** an `attach` message is **guidance text only**
  >   (DF3.3's directive rule): it can never approve, reject, skip or reorder a gate, and never raises a
  >   spend ceiling or steering-iteration bound — DF3.6's bounds are immutable mid-run, so attach grants …
- **Attach refusal states** — DF3.4 AC5 (`df3-4-approval-gate-attach-steering.md:155-158`): given a
  run in `pausing` or `awaiting-approval`, "attach is refused `run-not-attachable`". Factory-observe
  should name this refusal rather than imply attach always lands.
- Approver token on stdin (DF3.5 AC6 already encodes; binding source DF3.4 INV-APPROVE-6).

---

## 7. Spec text constraining skill wording beyond the story file

1. **FF13 (derivation appendix, lines 137–141):** exit code 6 has two meanings; DF3.5 inherits the
   split and freezes it into generated artifacts. Any exit-code table in a skill must carry both
   meanings or cite the registry NOTE.
2. **DD-9 (derivation §5a, line 86):** cost unit is integer micro-dollars (µ$), default cap
   5,000,000 µ$ ($5.00). If any skill mentions spend caps, it must use µ$ — and AC4's lint already
   forbids quoting dollar rates, so the safest wording names the cap as "the run's spend cap" and
   routes numbers to `fleet status` output.
3. **DD-8 (line 85):** DF3.5 is net-new — nothing in the skills may be presented as "survives
   verbatim" ancestry from retired stories; cite design §5.2 / D3 / DD-11 instead.
4. **Derivation §6 writer ground rules (line 106):** "exe.dev claims carry [VERIFY]
   vendor-single-origin flags; no AC assumes a compliance artifact (SOC 2/DPA/SLA) exists" — skills
   must not assert exe.dev compliance properties.
5. **Design §6.5 (lines 392–394):** "No claim of containment we can't enforce in code" — the
   umbrella clause behind AC7/INV-SKILL-6.
6. **R5 fact 20 (lines 498-500):** SSSF/inkwell systems are REFERENCE ONLY — skills may lift
   doctrine/structure, never direct an operator to run upstream `just` recipes or ADW scripts.
7. **Story staleness to flag at implementation:** (a) the `INK/`-not-cloned note (lines 18–22) is
   obsolete — the repos are at `/Users/steve/reference-repos/`; (b) the claim that the binding
   excerpts live in `R4-external-patterns.md` is inaccurate — they live in the upstream clones
   (verified above); R4 carries cookbook/just-file excerpts only. Neither affects the ACs' content.

---

## 8. Verdict

**Specs are internally consistent and sufficient to author the four skills.** Every line anchor the
story cites resolves verbatim in the local clones (§4); D3/DD-1/DD-11/F8-c2+R6/R5-f10/R5-f17 all
say what the story says they say. The two story-file inaccuracies (R4-as-binding-source claim;
"not present on this host") are provenance bookkeeping, not spec defects — but a dev agent that
takes the story literally will grep R4, find nothing, and stall; this document is the correction.
Lift the orchestrator's section layout, report-and-stop phrasing, hard-rules format, and
teardown-order doctrine; keep our own two-key frontmatter; attribute MIT (c) 2026 IndyDevDan.
