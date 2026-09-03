# R6 — Disler Source Extraction (Track F, story DF3.2)

Sources:
- INK = `/Users/steve/reference-repos/inkwell-agent-sandboxes-and-software-factory`
- SSSF = `/Users/steve/reference-repos/super-simple-software-factory`

All line numbers verified against the working trees as cloned 2026-08-11 (file mtimes).

---

## VERDICT on "un-coded bash cookbook" claim

**CONFIRMED.** The fan-out / best-of-N loop exists ONLY as bash embedded in prose
(`INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md:33-50`). A full sweep of
both repos (`*.sh *.py *.ts *.js *.just` for `fan.?_?out|best.?of|bestof|race|rank|score|parallel.*arm`)
found zero executable fan-out/ranking code:

- Every `best-of-N` hit in real code is a *comment* explaining why infrastructure exists:
  - `INK/just/sandbox/manage/list.just:3` — "This is the half of best-of-N that is not 'launch N sandboxes'"
  - `INK/just/sandbox/lifecycle/teardown.just:74` and `INK/sandbox_mount/host/run_record.py:65` — "This is what makes best-of-N comparable: same prompt, N models, cost beside result."
  - `INK/just/sandbox/lifecycle/execute.just:25`, `setup.just:21` — fan-out mentioned only as context for prompt-path/config handling.
- The only other "fanout" occurrences are the cookbook itself and the rendered spec diagram
  (`INK/specs/sandbox-mount-system.html:805` — an `<img>` of the fan-out figure; no code).
- SSSF has no sandbox/fleet layer at all (it is the in-repo factory: adw templates + skills). Its one
  "fan out" hit is planner-prompt prose about subagent recon
  (`SSSF/.claude/skills/sssf/templates/prompt_engineering/planner/system.md:19`) — unrelated.
- **No rank formula exists anywhere in either repo.** Grep for `0.6|0.4|weight|passRate|pass_rate|fileCoverage|score|rank`
  over all code returns nothing resembling a weighted quality score. DF3.2's
  `testPassRate*0.6 + uniqueFileCoverage*0.4` is a QDS invention with no source echo.

What DOES exist in code is the per-run infrastructure the cookbook loop drives (see §5). The fleet
layer itself — mint ids, loop arms, pin commits, execute detached, collect, compare — is exactly what
the story claims: an un-coded bash cookbook.

### Counter-philosophy flag (load-bearing for DF3.2 review)

The source explicitly refuses numeric ranking:

> `fan_out_n.md:136-140`: "`just sbx manage list` gives you state, VM liveness and spend for every
> run. There is no single ranked table beyond that — `just sbx manage harvest <id>` each arm and
> diff the refs against each other with plain git, **which is the honest comparison anyway: the code
> is the artifact, not a score.**"

DF3.2's weighted score contradicts this stance rather than lifting it. That may be fine (QDS needs a
machine-pickable winner where disler had a human diffing refs), but the story should say so — a
reviewer who checks the source will find disler's stated reason for NOT scoring arms.

---

## 1. fan_out_n.md — complete logical structure

File: `INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/fan_out_n.md` (214 lines). Sections in order:

### Isolation argument (:1-22)
- :3-4 thesis: "Best-of-N means **N separate sandboxes**. One run, one VM, one runtime key, one
  working tree, one git state, one set of ports."
- :8-10 the failure it prevents: five agents on one machine fight over one working directory, one
  dev-server port, one git state; running N agents inside a single sandbox "reintroduces exactly that
  collision — you have paid for a VM and bought nothing."
- Four things isolation buys (:12-21):
  - **Spend attribution** (:14-15): one runtime key per sandbox makes "same prompt, N models, cost
    beside result" a rankable table; shared key = one number nobody can decompose.
  - **Blast radius** (:16-17): `--limit` caps a single arm at its own budget; one key for N arms lets
    one runaway arm spend all of it.
  - **The commit graph** (:18-19): SSSF commits plan/code/docs separately; two agents interleaving
    one repo's history makes the teardown `git bundle` unreadable.
  - **The gate** (:20): gate assertions A/B/C/D/E describe ONE sandbox's health; no per-agent version.
- :22 slogan: "Getting one sandbox right is what makes N free. N is a loop over the same six phases."

### Id-minting race (:26-32)
- :26-28: "**Mint the run id yourself and pass it through the phases. Do not use `just sbx mount`
  for fan-out**: `mount` recovers the generated id by reading the newest record out of
  `run_record.py list`, which is correct for one run and a race under concurrency."
- :30-31: "`just sbx lifecycle create` only generates a new id when the argument does not already end
  in `-<6 hex>`, so an id from `new-id` is used verbatim."

The race is real in code: `INK/just/sandbox/mount.just:15`
```bash
ID=$(sandbox_mount/host/run_record.py list | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["run_id"])')
```
(newest record under concurrent creates = wrong arm). And the verbatim-pass-through regex lives at
`INK/just/sandbox/lifecycle/create.just:53-55`:
```bash
RUN_ID="{{RUN_ID}}"
if [[ ! "$RUN_ID" =~ -[0-9a-f]{6}$ ]]; then
    RUN_ID="$("$RR" new-id "$RUN_ID")"
fi
```

### Core bash loop (:33-50) — VERBATIM

```bash
#!/usr/bin/env bash
set -euo pipefail
RR=sandbox_mount/host/run_record.py

PROMPT="add a word-count badge to the editor footer"
PIN=$(git rev-parse HEAD)          # one commit for every arm — this is the control variable
ARMS=(sssf.config.yaml sssf.frontier.config.yaml)

for i in "${!ARMS[@]}"; do
  ID=$("$RR" new-id "bestof-$i")
  just sbx lifecycle create "$ID" --limit 10     # per-arm ceiling, not the $50 default
  just sbx lifecycle fill   "$ID" "$PIN"         # pin every arm to the same sha or the comparison is noise
  just sbx lifecycle setup  "$ID"                # gate; on failure it STOPS and leaves this arm's VM alive
  just sbx lifecycle observe "$ID"
  echo "$ID ${ARMS[$i]}" >> /tmp/fanout.map
done
```

### Parallelization guidance (:52-55)
Phases are ~12s cold per arm, mostly network wait, so backgrounding each arm's chain is fine. Two
constraints: (a) `create` is the only phase that mints, so id generation must stay OUTSIDE the parallel
section; (b) a gate failure in one arm must not abort the others — run each chain in its own subshell
and collect exit codes.

### Failed-arm rule (:57-58)
"**A failed arm stays up.** `just sbx lifecycle setup` never destroys. Read `debug_a_failed_gate.md`,
fix, re-run `just sbx lifecycle setup <id>` for that arm only."

### Then execute (:60-69)
```bash
while read -r ID CFG; do
  just sbx lifecycle execute "$ID" "$PROMPT"      # detached; returns a pid, recorded
done < /tmp/fanout.map
```
`execute` returns immediately; watch via `just sbx run cmd <id> 'tail -f run.log'` or the observability
URLs printed by observe. `/tmp/fanout.map` is the arm registry — the un-coded precursor of a fleet roster.

### Where per-run variance lives (:71-128) — "three places, and nowhere else"
- :73-74 design principle: "Everything else stays inside the codebase — that is what keeps this
  orchestrator a set of recipes instead of an agent system."
- **1. The prompt** (:76-79): "if the prompts differ, you are not comparing models, you are comparing
  prompts." Also :25-26 of execute.just — a prompt PATH is the better fan-out handle because every arm
  then provably runs the same bytes.
- **2. `SSSF_CONFIG` — the roster** (:81-116). NOTE: the cookbook says (:87-89) "`just sbx lifecycle
  execute` does not take a config argument… **The right fix is to teach `execute` a config flag rather
  than route around it.**" — **that fix has since LANDED in code**: `execute.just:48` is now
  `execute RUN_ID PROMPT CONFIG="" ADW="sdlc" *EXTRA:` with trailing-`--config` argparse semantics
  documented at `execute.just:25-31`. Cookbook is stale vs code. Interim ssh workaround with four
  load-bearing details (:94-104): env var BEFORE nohup; `--shell bash --shell-arg -c` (zsh not in image);
  all three detachment pieces or ssh never returns; `\$!` expanded by remote shell. Gate caveat
  (:114-116): assertion C pings the DEFAULT roster regardless — an off-roster arm's models were never gated.
- **3. The model** (:118-128): ids are `provider/id`, pi splits on FIRST slash
  (`openrouter/google/gemini-3.6-flash`). Any new model MUST land in
  `sandbox_mount/guest/models.json.tmpl` with all four cost fields (`input`,`output`,`cacheRead`,
  `cacheWrite`); a partial cost block fails pi schema validation and drops THE ENTIRE ROSTER → gate B fails.

### The control: commit pin (:130-134)
"`just sbx lifecycle fill <id> <sha>` pins the arm. Hold it constant across arms or the comparison has
two variables. `commit_sha` is recorded from what actually got checked out, never from what was asked
for, and FILL gates that they match." (Loop comments at :39 and :45.)

### Ranking approach (:136-167)
No ranked table by design (see counter-philosophy flag above). Column sources table (:142-149):

| Column | Source |
|---|---|
| run id, vm, limit, spend, closed | `.sandbox/runs/<id>.json` via `run_record.py list` |
| commit | run record `commit_sha` (input) + run's own commits in the teardown bundle (output) |
| model (per agent) | trace db `agent_sessions.model` |
| tokens, cost, status, request | trace db `sessions.total_tokens`, `total_cost`, `status`, `request` |

Per-arm reads (:151-163): `run_record.py list`; sqlite against each VM's trace db (`select adw_id,
status, total_tokens, round(total_cost,4) from sessions…`); live spend via
`curl https://openrouter.ai/api/v1/key -H "Authorization: Bearer $(cat .sandbox/runs/<id>.key)"`.
Spend semantics (:165-167): written by TEARDOWN from the key's own usage read before revocation —
authoritative and unrecoverable after the key dies, which is why teardown reads it first
(`teardown.just:73-95`; fallback path recovers spend from the provisioning LIST by key hash at :87-92).

### Golden-VM cp fast path, N>=3 (:169-207) — caution section
- Timings (:171-172): cold mount ~12s (1.9s boot + 2.6s clone + toolchain + deps); warm `cp` 0.37s
  server-side, ~1s wall. Noise at N=2; matters at N>=3.
- :174 "**`sync` THEN `cp`. Always.**"
- :176-179 snippet: `ssh <golden>.exe.xyz 'sync'` then `ssh exe.dev cp <golden> <run-id> --json`.
- The measured failure (:181-183): "An unsynced `cp` produced **5,641 zero-byte files and reported no
  error**. The clone looked complete: files existed, `just --list` exited 0, and thousands of them were
  empty. That is precisely why gate A checks `git status --porcelain` rather than that files exist."
- `exedev vm snapshot` does NOT sync (:185-187); patch listed but not landed.
- What still runs after a cp (:189-200): FILL still runs (clone is stale by definition; detects existing
  `app/.git`, fetches, fast-forwards `--ff-only` so it can never reset over commits an earlier run
  produced); SETUP still runs (provision.sh idempotent; "the gate matters *more* here"); CREATE differs
  (cp already created the VM; no golden variant of create exists today).
- Costs (:202-203): golden VM bills continuously while idle and drifts to the toolchain of its build day.
- Status (:205-207): "This whole path is unexercised… Treat the first one as an experiment, not an
  optimization."

### Cleanup (:209-214)
"N sandboxes means N live VMs and N live keys, all billing until someone decides otherwise. Nothing
expires and nothing auto-destroys." → explicit teardown per arm (`teardown_and_reap.md`), plus
`just sbx manage reap` (dry run by default) as backstop for arms whose teardown never ran.

---

## 2 & 3. Skill inventory (one-line summaries)

Skill root: `INK/.claude/skills/sssf-sandbox-orchestrator/`. Governing principle (SKILL.md:13):
**THIN SKILL, FAT RECIPES** — the skill routes, justfiles do the work. SKILL.md:119 routes
"'Spin up N and pick a winner' | best-of-N, three variants, diff the runs" → `cookbooks/fan_out_n.md`.

Cookbooks (`cookbooks/`):
| File | One-liner |
|---|---|
| `fan_out_n.md` | Best-of-N: N sandboxes, self-minted ids, pinned sha, per-arm limit, map-file registry; ranking = git-diff refs, not scores |
| `mount_one.md` | `just sbx mount <task>` chains create→fill→setup→observe and STOPS (never tears down); phases individually callable for debugging |
| `execute_work.md` | Three non-interchangeable drivers: `run cmd` (sync), `lifecycle execute` (detached SDLC, returns pid), `run agent` (resumable Claude Code session); direct vs agent-mediated kickoff paths |
| `access_a_running_sandbox.md` | Flow A shell-in via ssh pane; Flow B join the in-box agent via `ssh -t` + `claude --resume` on the recorded session_id |
| `observe_and_report.md` | Six idempotent steps making a mounted box watchable from outside without reaching in; re-running never stacks a second server on a port |
| `debug_a_failed_gate.md` | Gate failure REPORTS, STOPS, leaves the VM alive — evidence is on the box; first rule: do not tear down, read the box; `gate_fail()` prints failed assertion + three starting commands |
| `teardown_and_reap.md` | Teardown is the only destroyer, always an explicit human decision, never chained; status note: teardown/reap WRITTEN BUT NEVER RUN (5 of 6 phases verified 2026-08-04) |
| `just_command_model.md` | One justfile, two layers (OUT-sandbox orchestration vs IN-sandbox execution) separated by which credential each needs; boundary enforced by just's import semantics |

References (`references/`):
| File | One-liner |
|---|---|
| `phases.md` | The six-phase contract; layer membership decided by ONE question — what credential does it need |
| `run_record.md` | `.sandbox/runs/<id>.json` is the ONLY state shared across phases; lose the record → unrevokable key burning credit; closed schema, stdlib-only implementation |
| `models.md` | OpenRouter provisioning key mints disposable per-run keys (`sbx-<id>`, $50 default) revoked at teardown by hash; portability-over-BYOK rationale; ZDR notes |
| `gotchas.md` | Every trap measured on live hardware with the guard column showing what's actually in code (e.g. `--env` writes profile.d read only by interactive shells, never by `ssh vm "cmd"`) |
| `kickoff_paths.md` | Direct (host fires factory) vs agent-mediated lanes; when to pick which |

---

## 4. super-simple-software-factory — equivalent concepts

SSSF is the IN-SANDBOX half: no VM/fleet concept, no spend records. Its equivalents:

- **Run identity**: `SSSF/.claude/skills/sssf/templates/adws/adw_modules/utils.py:41-42`
  ```python
  def new_id(length: int = 8) -> str:
      return secrets.token_hex(length // 2)
  ```
  vs INK's richer `<slug>-<YYYYMMDD>-<6hex>` (`run_record.py:78-88`). Pin-or-create semantics:
  `adw_modules/session.py:38-39` `ensure(cfg, adw_id)` — "pinned ids for repeatable runs"; omitted, a
  fresh id is minted and printed so the next ADW picks it up. Same philosophy as INK's
  pass-the-id-yourself rule.
- **Artifacts**: per-adw data dir `{data_dir}/sessions/{adw_id}/events.jsonl` (session.py:40-41); doc
  convention `app_docs/<adw_id>_<slug>.md` (data_types.py:126). Phase rows carry
  `status: PhaseStatus = "fail"  # success must be earned` (data_types.py:63).
- **Rank-formula echo: NONE.** No testPassRate / coverage / weighted score anywhere in SSSF. Its
  "quality" module (`adw_modules/quality.py`) runs deterministic commands (lint/typecheck/build per
  `QualityCheckSpec`, data_types.py:131-139) — pass/fail gates, not scores. DF3.2's formula has no
  ancestor here either.
- **Envelope pattern** worth noting for arm-result shape: every agent returns
  `status: success|fail, summary, artifacts[], notes_for_next_agent` (data_types.py:72-78) — a clean
  minimal contract for what an arm hands back to the dispatcher.

---

## 5. LIFT CANDIDATES (ranked by value)

### L1 — The core loop, verbatim (HIGH)
`fan_out_n.md:33-50` (quoted in §1 above). This IS DF3.2's fleet dispatcher seed: mint id outside the
loop, create with per-arm ceiling, fill with pinned sha, gated setup, observe, append to registry map.
Lift into implementation as the reference sequence and into tests as the expected phase-ordering
contract (create→fill→setup→observe per arm, registry write last).

### L2 — The id-minting race paragraph + mount.just:15 (HIGH)
`fan_out_n.md:26-32` + `mount.just:15`. The exact bug class DF3.2's dispatcher must not reintroduce:
deriving ids from "newest record" breaks under concurrency. Pair with `run_record.py:78-88`
(`new_run_id`: slug-date-hex, collision = hostname fight) as the reference minting implementation, and
`create.just:53-55` for the `-<6 hex>` suffix-means-verbatim convention.

### L3 — Record-integrity patterns from run_record.py (HIGH)
- Closed schema rejecting unknown keys: `run_record.py:43-56,140-143` ("a typo in a `set` is a silent
  data loss bug").
- O_EXCL create refusing to clobber: `run_record.py:99-105` — "overwriting a live record orphans that
  run's key, and the check-then-write window is exactly when a retrying phase would land."
- Atomic tmp+os.replace write: `run_record.py:180-184`.
- Loud-not-skipped malformed-record handling: `run_record.py:170-176` — "a record quietly dropped for
  being malformed is a key that quietly keeps spending."
- First-close-wins idempotent close: `run_record.py:150-160`.
Directly liftable if QDS RunRecord/arm-state lacks any of these.

### L4 — Failed-arm rule + gate philosophy (HIGH)
`fan_out_n.md:57-58` ("A failed arm stays up") + `debug_a_failed_gate.md` header ("reports, stops, and
leaves the VM running… a gate that auto-destroys throws away the evidence"). Lift as DF3.2 test cases:
failed arm remains inspectable; re-run targets that arm only; dispatcher collects other arms' exit
codes instead of aborting (:52-55).

### L5 — Commit-pin discipline (MEDIUM-HIGH)
`fan_out_n.md:39` ("this is the control variable"), :45 ("pin every arm to the same sha or the
comparison is noise"), :132-134 (record what ACTUALLY got checked out; FILL gates input==output).
Test material: all arms share one base sha; mismatch between requested and checked-out sha is a hard fail.

### L6 — Spend-before-revoke cost attribution (MEDIUM)
`teardown.just:73-95` + comment at :74. Read per-arm cost from the key BEFORE destroying it; number is
unrecoverable after; provisioning-list-by-hash fallback (:87-92). Maps to QDS CostLedger finalization
order in the fleet teardown path.

### L7 — Parallelization constraints (MEDIUM)
`fan_out_n.md:52-55`: minting stays outside the parallel section; each arm chain in its own subshell;
collect exit codes; a gate failure must not abort sibling arms. Concurrency-shape tests for the dispatcher.

### L8 — Reap prefix safety model (MEDIUM)
`reap.just:1-9`: "The sbx- prefix is the entire safety model… Nothing without that prefix is ever
considered", dry-run by default, `--yes` to apply. Lift for any QDS bulk-cleanup verb: namespace-tagged
resources only, dry-run default.

### L9 — Harvest-as-bundle integrity check (MEDIUM)
`harvest.just:6-19`: no push credential ever enters the box; RANGED bundle (base..branch) so `git fetch`
REFUSES a bundle whose branch does not descend from the pinned sha — "Free integrity check on the
return trip." If DF3.2 collects arm outputs, ranged-bundle ancestry checking is the pattern.

### L10 — Golden-VM zero-byte caution (LOW-MEDIUM, test gold)
`fan_out_n.md:174-207`: sync-then-copy mandatory; unsynced copy yields 5,641 zero-byte files WITH exit
0 — so health checks must assert content (`git status --porcelain`), never existence. Great fixture for
any worktree/clone fast-path test in QDS.

### L11 — Arm-result envelope (LOW-MEDIUM)
SSSF `data_types.py:72-78` EnvelopeBase (`status/summary/artifacts/notes_for_next_agent`) plus
data_types.py:63 `"success must be earned"` default-fail. Minimal shape for what each arm reports back.

### L12 — Prompt-path handle (LOW)
`execute.just:18-25`: pass a prompt PATH not inline text during fan-out so every arm provably runs the
same bytes; `utils.resolve_prompt()` treats existing paths as file contents. Determinism-of-inputs test.

---

## Patterns DF3.2's story missed

1. **Cookbook-vs-code drift is itself evidence FOR coding the fleet layer.** The cookbook (:87-89)
   still says `execute` takes no config argument and prescribes an ssh workaround with four fragile
   load-bearing details (:94-104); the fix since landed (`execute.just:48` CONFIG param, trailing
   --config argparse semantics at :25-31) but the prose was never updated. Prose recipes rot against
   code; DF3.2 turning the cookbook into tested code is the durable version of exactly this lesson.
2. **Per-arm budget ceiling as a first-class arm parameter** (`--limit 10` vs the $50 default,
   fan_out_n.md:44): blast-radius isolation per arm, not just per run. If DF3.2's arms don't carry
   their own cost ceiling, the source considers that a regression.
3. **Gate blindness under roster variance** (:114-116): the health gate pings only the default
   roster's models, so a variant-config arm passes setup with ungated models. Any DF3.2 analog (arm
   using a non-default provider/model) inherits this hole unless the dispatcher re-gates per arm.
4. **The honest-comparison stance** (:136-140): disler ranks by diffing refs, "the code is the
   artifact, not a score." DF3.2's numeric formula should cite-and-justify its departure (machine
   picking requires a scalar; document that this is a deliberate break from the source).
5. **Unexercised-path honesty as a doc convention**: both teardown_and_reap.md and the golden-VM
   section carry explicit "written but never run / treat the first one as an experiment" status
   banners. Cheap to lift into DF3.2 docs for any path the story ships unverified.
