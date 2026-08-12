# Pre-Derivation Gates Report — F6 / F13 / F8

**Date:** 2026-08-11 (evidence timestamps span into 2026-08-12 UTC)
**Against:** `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` (r2) §8 pre-derivation gates
**Prior gate:** F14 CLOSED at commit `c06320e` (`2026-08-11-story-disposition-audit.md`)
**Method:** three waves — (1) F6 prep + F13 research in parallel, (2) F6 live execution in the main
session + F8 economics from the measured cost events, (3) one fresh-context adversarial verifier per
gate, with every verifier discrepancy either fixed in the evidence or carried here explicitly. Nine
subagents total. No story file was touched; no derivation was started.

---

## 1. F6 — Step-0 PROOF (executable DoD, design §8.0)

### Verdict: **CLOSED** ✅ (verifier: all four clauses CONFIRMED)

The live run executed 2026-08-12T00:51:09Z on the only proven path (`QDS_TEAM_RUNNER=local` →
`team-lead-driver.ts` subprocess teams), per the §8.0 DoD verbatim — no reinterpretation, no
weakening.

**Evidence artifact:** `_bmad-output/sprint-artifacts/_research/f6-step0-proof-2026-08-11.json`
(raw NDJSON inline, merged JSON, per-agent cost events, full diff, suite outputs, seed manifest,
verifier record). Scratch workspace `/Users/steve/scratch/f6-step0-proof/` (outside the repo, not
committed).

**Setup:** scratch clone of QDS-Factory at `c06320e`; seeded bug = removal of the KMP
terminal-position guard in `cli-anything/src/redact.ts:113` (`longestPrefixSuffix`) — a real
documented past regression (secret leak at the truncation boundary), deterministically failing
exactly one test (`redact.test.ts:150`), recorded in a seed manifest committed 17m12s **before**
the run (verifier-checked against the reflog). Team: lead + fixer = `anthropic/claude-sonnet-4.6`,
analyst = `deepseek/deepseek-v4-flash-0731` (operator-directed model), all via OpenRouter.

| DoD clause | Result | Evidence |
|---|---|---|
| 1. Suite green after the team's diff | **PASS** | Post-run 150 pass / 0 fail (one 149/1 result whose 533-vs-534 expect signature proves it was NOT the seeded test — attributed by inference to the pre-documented AC3 timing flake; DoD single rerun used; verifier ran 4 further suites, all green). Team diff = the one-line guard restore, **byte-identical to the pre-seed source**, written 50s into the run (mtime-proven — refutes any pre-fixed hypothesis). Test file untouched. |
| 2. NDJSON parses end-to-end, zero malformed | **PASS** | 12/12 events (6 coms, 3 cost, 2 worker_output, 1 merged) through the real `parseTeamEventLine` AND the verifier's independent contract checks. |
| 3. Merged JSON validates against the step-output schema | **PASS** | Exact 9-field `MergedOutput` set, `exitStatus: success` (CC-1 5-value enum), `partial: false`, explicit `error: null`, comsLog cross-checked field-for-field against raw events. |
| 4. Cost events sum to a nonzero total | **PASS** | $0.04912262, independently recomputed to the last digit. |

**Attempt accounting (full honesty):** the first live attempt was killed ~4.5 min in and its
evidence discarded — the raw-NDJSON tee shim leaked into the worker process tree, so `bun test`
fixture subprocesses contaminated the evidence log (clauses 2/4 unmeasurable). That was an
apparatus flaw, not a DoD observation; the shim was fixed to strip itself from PATH, the clone was
reset to the seeded commit and re-verified 149/1, and attempt 2 is the first valid observation.
The DoD's one-rerun allowance was spent on the suite flake in clause 1, exactly once. Contaminated
log preserved in the scratch workspace.

**Verifier scope caveats (carried, not fixed):** (a) worker-b's analysis partly read the answer
key via git history (the seed commit is visible in the clone's log) — no DoD clause requires blind
diagnosis, but F6 must not be over-cited as proof of blind diagnostic capability; (b) exactly one
worker exercised the edit-and-test path (worker-b was prompt-restricted to read-only analysis) —
F6 proves the team runtime executes code-editing work end-to-end, not multi-worker concurrent
editing; (c) three artifact misattributions found by the verifier were corrected in the artifact
(index.ts mode flip was operator setup, not a worker; the lead's "no file change needed" summary
sentence is factually wrong and now annotated; AC3 flake identity downgraded to inference).

**Versions of record:** pi 0.55.0 (`@mariozechner/pi-coding-agent`), bun 1.2.22, vendored coms
pinned to disler `0ed11f44` — the ~3-week pi/coms drift since the 2026-07-20 N=1 research run is
hereby covered by a fresh code-editing proof at current versions.

**Operational findings for derivation (measured, load-bearing):**
- **pi fixed overhead ≈ 37K input tokens/turn** (system prompt + auto-loaded extensions/skills,
  measured directly and triangulated at 39–42K cache-read tokens/turn from cost residuals). This
  is 78–88% of every agent's bill on the proven path.
- **Cost events are final-turn-only.** `runWorkerPi` overwrites usage per message event; emitted
  tokens are the last turn's, and `costUsd` is the last turn's `cost.total`. Session-cumulative
  truth requires provider billing. Direct input to the P1.13 ledger re-derivation.
  **Addendum (CR review hardening):** summed per-turn telemetry — even after DF2.7 driver-side
  accumulation — is instrumentation, not proof of provider billing. It must be reconciled against
  actual provider billing (including cache rates, retries, and billing adjustments) before any
  result feeds pricing or the DF2.8 cost ledger.
- **pi's bundled model catalog is stale in both directions** (rejects live slugs, lists delisted
  ones). Custom models need `~/.pi/agent/models.json` (schema reverse-engineered and working —
  v4-flash-0731 was registered this way). Any roster config story must validate slugs against
  BOTH pi's catalog and the provider.
- The local anthropic OAuth credential is expired (~2026-02-25); all-Anthropic-direct rosters are
  blocked on this host until `/login anthropic` is re-run interactively.

---

## 2. F13 — pi redistribution licensing (design R7, gate on §8 step 2 OCI image contract)

### Verdict: **CLEAR — with three binding CONDITIONS** ✅ (verifier: confirmed, one condition widened)

The enterprise tier may ship pi + vendored coms inside an OCI image into client VPCs. No copyleft,
no unlicensed-core blocker. The earlier BLOCKED alarm on the vendored coms provenance was
**refuted on primary evidence**: the local disler clone predates the 2026-05-08 commit
(`3ce16391a1`, "pi 2 pi coms and net coms") that added BOTH the MIT LICENSE and the coms files;
live GitHub at the pinned vendored commit `0ed11f44` carries `LICENSE` (MIT © 2026 IndyDevDan,
byte-identical to `pi-vs-claude-code-vendor/LICENSE`'s first 21 lines) and both
`extensions/coms.ts` + `extensions/coms-net.ts`. The vendored provenance record **exceeds** MIT
requirements.

**Per-package facts (installed tree + npm packuments + upstream repos, verifier-spot-checked
including published-tarball extraction):**

| Package | License | Text shipped? | Verdict |
|---|---|---|---|
| @mariozechner/pi-coding-agent 0.55.0 | MIT (field; monorepo root LICENSE © 2025 Mario Zechner at earendil-works/pi) | **No** | CLEAR + attribution condition |
| @mariozechner/pi-agent-core / pi-ai / pi-tui 0.55.x | MIT (same monorepo; license field stable across all 235–313 published versions) | **No** (tarballs verified LICENSE-less) | CLEAR + attribution condition |
| @mariozechner/jiti 2.6.5 | MIT © Pooya Parsa (upstream jiti re-publish) | **Yes** | CLEAR as-is |
| @mariozechner/clipboard (+platform binaries) | npm field MIT; **no license text anywhere in the chain** (fork AND parent repo unlicensed) | No | **Drop** (optionalDependency; never loads headless anyway) |
| vendored coms.ts / coms-net.ts / themeMap.ts @ 0ed11f44 | MIT © 2026 IndyDevDan | Yes (vendored LICENSE + `_provenance`) | CLEAR |
| @mariozechner/pi-proxy | **no license, all 132 versions** | — | BLOCKED — ensure never pulled in |
| @mariozechner/pi | n/a | — | Wrong package (vLLM pods CLI) — exclude by name |

**Conditions (bind the §8 step-2 OCI image contract, not story-derivation start):**

1. **Third-party NOTICE file generated into the image — WIDENED by the verifier:** the installed
   tree has **fifteen** packages shipping no license text, not five. Must include the MIT text +
   copyright lines for the four pi packages (© 2025 Mario Zechner) and the other LICENSE-less MIT
   deps (`@tokenizer/token`, `data-uri-to-buffer`, `degenerator`, `eastasianwidth`, `netmask`),
   **plus the full Apache-2.0 license text** for `@aws-sdk/credential-provider-http`,
   `@aws-sdk/credential-provider-login`, `@aws-sdk/nested-clients` — Apache-2.0 §4(a) is an
   affirmative duty to give every recipient a copy, the strictest obligation in the tree. The
   NOTICE generation must **re-sweep the actual OCI tree post-build** (the fifteen-package list
   shifts with `--omit=optional` and provider selection).
   **Addendum (CR review hardening):** the twelve packages named above plus
   `@mariozechner/clipboard` total thirteen, not fifteen — this report does not enumerate the
   exact fifteen-package set. DF2.9 must derive the exact set from the post-build OCI tree,
   require the corresponding license/NOTICE artifact for every member, and fail the build with
   exit `2` if any required artifact is missing; do not treat this report's count as authoritative.
2. **Build with `--omit=optional`** to drop `@mariozechner/clipboard` and its native binaries
   (no authoritative license text exists anywhere in its chain; it is genuinely optional and
   display-gated so a headless VPC container never loads it).
3. **Fix the `pi-vs-claude-code-vendor/coms.ts:14-15` header** falsely claiming pi-mono origin
   (the coms files are original IndyDevDan work; pi-mono's full 1,528-entry tree contains zero
   coms paths). Audit hygiene, not a legal defect — the LICENSE file discharges attribution — so
   it does **not** gate ship, but it sits in the file most likely to be audited. One file only;
   coms-net.ts is clean.

**Also recorded:** Apache-2.0 NOTICE-propagation applies to the larger deps (`openai`,
`@google/genai`, `@mistralai/mistralai`, `@aws-sdk/*`, `@anthropic-ai/sandbox-runtime`);
`glob`/`minimatch` are BlueOak-1.0.0 (permissive, OSI-approved, flag proactively for reviewers);
QDS-Factory's local tree runs pi libs at 0.55.4 while the vendor dir peer-pins 0.55.0 — pin before
building the audited image.

---

## 3. F8 — Unit economics at API rates (design D3 caveat, R6, §8)

### Verdict: **CLOSED for derivation — with two binding CONDITIONS before any price sheet** ✅
(verifier: "arithmetically sound"; every recomputed figure reproduced)

### 3.1 Rate ground truth (live-fetched 2026-08-12, verifier re-fetched)

- **claude-sonnet-5 = $2/$10 per MTok, standard and permanent.** The pricing page states
  verbatim that the launch-introductory $2/$10 "is now the standard price" and the scheduled
  $3/$15 increase "will not occur." (A cached 2026-06-24 reference claiming otherwise was
  formally REFUTED by the verifier's live fetch — settled.) Cache: write 1.25×/2× (5m/1h),
  read 0.1×. Batch 50%. haiku-4.5 $1/$5; opus-5 $5/$25; fable-5 $10/$50; sonnet-4.6 $3/$15.
- OpenRouter: deepseek-v4-flash-0731 $0.08/$0.18, **cache read $0.016/MTok (0.2×, verified from
  the live models API — deepseek's cache multiplier differs from Anthropic's 0.1×)**;
  deepseek-v3.2 ~$0.25–0.27/$0.40; glm-4.7 $0.40/$1.75; qwen3-coder $0.30/$1.00.
- exe.dev (live /pricing 2026-08-12): Personal $20/mo — 50 VMs, 100GB pooled disk, 200GB
  transfer, 2vCPU/8GB; Team $25/user/mo; Reserved Cloud Pool $35.84/hr (512 vCPU/2TB); overages
  disk $0.08/GB/mo, transfer $0.05/GB. **All figures single-origin (vendor page)** — the design
  doc's "re-verified" wording should not be read as double-sourcing; R11's [VERIFY] posture
  stands for anything beyond the raw prices.
- Max: 20x tier **$200/mo** (verbatim from an Anthropic-controlled support page — closes that
  [VERIFY]); 5x $100 consistent. "Price and plans are subject to change at Anthropic's
  discretion" — no contractual floor.

### 3.2 The terms basis, restated accurately (supersedes D3's wording)

There is **no blanket "no commercial use" clause** in the Consumer Terms. The defensible chain:

1. **Absence of grant (load-bearing):** the affirmative permission to "power products and
   services Customer makes available to its own customers and end users" exists **only** in
   Commercial Terms §A.1 — no analogue in the Consumer Terms, which the Commercial Terms
   expressly disclaim for consumer offerings. A personal Max sub was never granted the right,
   independent of how any prohibition is read.
2. Consumer §3.2's **compete limb** ("products or services that compete with our Services") is
   engaged on its face by a hosted agentic coding factory, given Anthropic sells Claude Code.
   The resale limb is weak; the compete limb is not.
3. Consumer §3.7 restricts automated access "except… via an Anthropic API Key"; the Claude
   Code carve-out covers the subscriber's own use, not exposing that capability to third
   parties.
4. **§13 stipulates injunctive relief for §3 breaches — the downside is a shutdown order, not a
   back-bill.** This makes the decision commercially forced regardless of legal ambiguity.

Operator's own dev use of Max on their own machine: clearly permitted (Claude Code is the
product as sold). Client-deployed tier (R6, tightened): **an org-owned API key under Commercial
Terms is the only supported tier-1 configuration**; the client is the Anthropic Customer; the
operator never routes through its own credential in client deployments; onboarding captures the
§D.2/§D.3 pass-throughs (including the §D.3 Users-notification duty, discharged via the R9/F10
re-verification evidence) and records which terms the client is on. Counsel needed on: account
sharing's reach, the §3.2 compete question, and the incorporated Usage Policy. (Engineering
planning input, not legal advice.)

### 3.3 The numbers (per-run floor on the proven path)

All LLM figures at API rates; [M]=measured, [E]=estimate, [V]=verify.

| Quantity | Value | Basis |
|---|---|---|
| pi per-turn fixed overhead | **37,279 tok [M]**, cached (39–42K residual-triangulated across two rate cards) | The dominant term: **78–88% of every agent's bill** |
| Per-run floor (1 dispatch, lead+2 workers, warm) | **$0.015 (all-cheap) / $0.14 (cheap-worker) / $0.43 (all-frontier)** [E] | Validated mid-bracket against the F6 billing bracket $0.049–0.91 [M] |
| Tier-1 cockpit share per run (API rates) | **$0.04–0.60 [E]** (opus-5 cached sessions $0.42–1.79 ÷ 3–10 runs; verifier-corrected low end) | Output tokens are 70% of the cached session cost — cache cannot touch them; thinking bills as output |
| Per-story (5 phases, 3–6 dispatches, ≤2 retries [P1.19 AC5 — surviving clause], resident agent, VM) | **$0.12–3.99 [E]**, central $0.92 (cheap-worker) / $2.38 (all-frontier) | Best-of-N multiplies team+VM linearly |
| VM | Reserved Pool $0.14/box-hr; Personal $20/mo collapses at fan-out (2GB disk/box at 50 VMs; overage $32/mo > plan) [V single-origin] — **Addendum (CR review):** 50 × 2GB = 100GB is exactly the pooled-disk plan limit as stated in §3.1, so this figure does not itself demonstrate a $32/mo overage; the actual per-box footprint driving that overage is unverified and needs re-derivation. | VM is 4–33% of a story depending on roster — noise until tokens optimize, then the floor |
| Cache regime | Warm↔cold = 1.5–2× swing; the F6 path is **already warm** — cold is the downside risk, elimination (−81–86% via --no-extensions/--no-skills, untested) is the lever | |
| Roster | All-frontier → all-cheap = **27×**; the sonnet lead alone is 92% of a cheap-worker run | |

**Max-vs-API delta, stated for the record:** Max at realistic operator volume is a 3–8× discount
with a hard throughput ceiling at ~one operator's capacity — **non-extrapolable to hosted volume
by construction**. No Max-derived rate appears in the commercial floor (verifier-confirmed
clean). If it leaked: cheap runs' margin sign inverts and the dominant cost variable (output
tokens) is never priced at all.

**D4 tripwire finding (design feedback, pre-derivation):** the 15%-of-run-total resident-agent
tripwire is a **ratio trap** — every team-cost optimization mechanically pushes the resident
agent toward demotion; on the all-cheap roster even a v4-flash resident trips at N=2 steering
turns while a frontier roster tolerates 65. Re-specify as the absolute per-run spend ceiling F12
already mandates (smaller change), or normalize against a fixed reference roster. Also: the
ratio's denominator must include the tier-1 API share or it fires early. D2's "Max-subscription
economics at tier 1" wording needs an inline pointer to the D3/F8 caveat.

### 3.4 Conditions (bind the hosted-tier price sheet, not story derivation)

1. **Instrument before pricing:** `team-lead-driver.ts` must accumulate usage across turns and
   emit `cacheRead`/`cacheWrite`/turn-count (today: final-turn-only overwrite — the 20.4×
   campaign-window gap between the $0.049 event sum and $1.00 billing is dominated by the killed
   attempt + smokes, but attempt-2's true cost is only bracketed [$0.049, ~$0.91]). One
   instrumented re-run re-derives the floor from session-cumulative truth. This single change
   collapses the model's two biggest error bars and directly serves the P1.13 ledger
   re-derivation.
2. **Close the open [VERIFY]s named in the evidence** before a price sheet ships: Max overflow
   billing semantics; cockpit token profile (instrument one real dispatch session, sweep OUTPUT
   tokens); the Usage Policy; Team/Enterprise seat terms; v4-flash cache-write rate; exe.dev
   figures remain vendor-single-origin.

---

## 4. Cross-gate findings register (inputs to story derivation)

1. **The 37K pi overhead is the factory's #1 cost lever** — 78–88% of the bill on the proven
   path. A "lean worker profile" (no extensions/skills for tier-3 workers) is a candidate step-1
   story with a measured 5–6× payoff hypothesis.
2. **Cost-event semantics are final-turn-only** — P1.13's re-derivation must source
   session-cumulative usage or provider billing, never the current event stream.
3. **Model roster validation needs both gates** (pi catalog + provider API) plus the
   `models.json` custom-entry mechanism — feeds the P1.5 roster schema alignment.
4. **D4 tripwire re-spec** (ratio trap → absolute ceiling per F12) should land in the derived
   tier-2 stories.
5. **F6 scope honesty:** proven = one fixer worker editing code + running tests through the
   full NDJSON/merge/schema pipeline with a read-only analyst and a verifying lead. Multi-worker
   concurrent editing remains unproven; the P1.19-descendant fix-loop story should carry that.
6. **Anthropic OAuth expired on this host** — direct-Anthropic rosters blocked until interactive
   re-login; OpenRouter routing is the working path today.

---

## FINAL: Story derivation is **GO**. ✅

F14 CLOSED (commit `c06320e`) · **F6 CLOSED** (live DoD run, verifier-confirmed 4/4 clauses) ·
**F13 CLEAR-with-CONDITIONS** (conditions bind the §8 step-2 OCI image contract — NOTICE
generation, `--omit=optional`, header fix — none block derivation start) · **F8 CLOSED for
derivation** (model verified arithmetically sound; two conditions bind the hosted-tier price
sheet, not derivation). Nothing in §8's gate list remains open against starting story derivation
from the build order. D5's basis (the proven team runtime) is now proven for code-editing work at
current pi/coms versions, N=1 clean.
