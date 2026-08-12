# R4 — External Reference & Adopted-Pattern Research

**Scope:** concrete, citable source material for the patterns D6 and D8 adopt (SSSF phase
engine + trace schema + visualizer; inkwell credential lifecycle), plus the pi facts behind
DF1.9 (lean worker profile) and DF1.5 (roster schema).

**Method:** every claim below was read out of the local clones. No web search was used except
where explicitly marked. Line numbers are from these paths:

| Short name | Absolute path |
|---|---|
| `SSSF/` | `<home>/reference-repos/super-simple-software-factory/.claude/skills/sssf/` |
| `INK/` | `<home>/reference-repos/inkwell-agent-sandboxes-and-software-factory/` |
| `MOD/` | `SSSF/templates/adws/adw_modules/` (the SSSF engine) |
| `VIZ/` | `SSSF/apps/visualizer/` |

**Note on which copy to cite.** Inkwell vendors the SSSF engine at `INK/adws/adw_modules/`.
Twelve of sixteen modules are byte-identical to the SSSF templates. Four differ — `agent_pi.py`
(286 → 321), `agents.py` (300 → 313), `permissions.py` (185 → 256), `quality.py` (240 → 246).
**Cite `MOD/` as canonical**; the one delta that matters for story writing is called out in §1.8.

**Verdict up front: every pattern the v5 design doc cites was located in the local clones.**
No unfindable claims. Details in §5.

---

## 1. SSSF — the phase engine (feeds DF1)

### 1.1 The phase primitive: one contextmanager, status defaults to `fail`

`MOD/runner.py:72-111` is the whole thing. `Run.phase(params)` is a single `@contextmanager`
serving all three phase kinds (`engineer`, `agent`, `code`) — there is no per-kind subclass and
no phase registry.

The "success must be earned" property is enforced in two independent places:

- **The persisted default.** `MOD/data_types.py:63` — `status: PhaseStatus = "fail"` on the
  `Phase` model, and `MOD/tracer.py:33` — `status TEXT DEFAULT 'fail'` in the `phases` DDL. A row
  that is written and never updated reads as failed.
- **The control flow.** `MOD/runner.py:88-103` catches `BaseException` (not `Exception`), sets
  `phase.status = "fail"`, finalizes the session, and re-raises. Only the `else:` branch at
  `:104-111` — a clean exit with no exception at all — writes `success`.

Agent phases carry a third requirement enforced one level down: `ph.call()` at
`MOD/runner.py:36-39` delegates to `agents.execute`, which raises on an unparseable envelope
(`MOD/agents.py:277-280`), on gate violations after retries (`:163-165`), on a permission breach
(`:178-186`), and on `envelope.status != "success"` (`:214-215`). Any of those propagates out of
the `yield` and lands in the `except` branch.

**The run-level outcome is a separate question from the phase-level one.** `MOD/runner.py:114-142`
(`Run.finish`) takes `accepted:` as an explicit argument and ANDs it with "every phase succeeded":

```python
phases_ok = bool(self.phases) and all(p.status == "success" for p in self.phases)
ok = phases_ok and accepted
```

The docstring at `:117-129` explains why, and it is worth reading before writing DF1's acceptance
criteria: a test phase that ran the suite *did its job* even when the suite came back red, so the
**phase** succeeds while the **run** must not. This replaced a `succeeded` property whose side
effects wrote the session status and printed the banner before the caller's `and test.passed` was
ever evaluated — producing runs recorded green in the db, the terminal, and the UI while exiting 1.
`finish()` settles the db row, the banner, and the exit code in one call so the three cannot disagree.

**Signal-safety.** `MOD/session.py:21-35` converts SIGTERM and SIGINT into `SystemExit`, so a
`kill` closes the session (`ok=False`) and its process rows instead of leaving the trace claiming
work is in flight that is already dead.

### 1.2 Description legibility validation

`MOD/data_types.py:31-53` — a pydantic `@field_validator` on `PhaseParams.description` that
rejects two things:

1. **Empty/whitespace-only** (`:46-48`).
2. **An echo of the phase name** (`:49-52`): `text.rstrip(".").casefold() == name.replace("_", " ").casefold()`.
   So `commit_plan: "Commit the plan"` is rejected.

The rationale at `:35-42` is the acceptance criterion a DF1 story should carry: the description is
the *only* sentence the trace, the console, and the phase block in the UI ever show about intent —
everything else is ids, statuses, and timings. It is a **construction-time** error on purpose: it
fires before the phase opens, not after a run is already in the trace.

### 1.3 The envelope adapter pattern (the sharpest idea in the codebase)

Deterministic subprocess results are wrapped as envelopes indistinguishable from agent reports, so
**one repair-loop code path serves both agent failures and code failures**. Three instances:

| Adapter | Type | Adapter fn | What it wraps |
|---|---|---|---|
| Quality | `VerifyOutput` (`MOD/data_types.py:237-248`) | `quality.as_envelope` (`MOD/quality.py:193-211`) | lint / typecheck / build / test runs |
| Changes | `ChangesOutput` (`MOD/data_types.py:222-235`) | `changes.as_envelope` (`MOD/changes.py:87-103`) | a `git diff` against a resolved base |

The docstrings state the invariant twice, near-identically (`MOD/data_types.py:240-244`,
`MOD/quality.py:196-199`):

> Agents hand each other typed envelopes; code blocks return `QualityResult`. This is the adapter,
> so a failing lint or test run flows back into the builder through exactly the same door a tester
> agent's report used to — **the ADW script is the only thing that knows the difference.**

Concretely, in `SSSF/templates/adws/adw_plan_build_test.py:62-67`, the fix phase passes
`previous=quality.as_envelope(test, "tests")` into an `AgentCall` — the builder receives it through
the identical `previous:` slot that carried the planner's `PlanOutput`.

Two details worth porting verbatim:

- **`QualityCheckResult.output_tail`** (`MOD/data_types.py:158-163`) carries the tail of
  stdout+stderr *verbatim and unparsed* inside the envelope, because "the builder cannot open a log
  file it was never handed." Deliberately raw: every runner formats failures differently and a
  generic parser would be confidently wrong. Bounded at `TAIL_CHARS = 4_000` (`MOD/quality.py:46`)
  so a runaway stack trace cannot swamp the next agent's context. The full log is always at
  `output_artifact`.
- **A failing block does NOT fail the phase** (`MOD/quality.py:216-219`): "The runner did its job;
  the CODE is what failed." This is the phase/run distinction of §1.1 applied at the block level.

### 1.4 Gates with evidence — pass AND fail recorded

A gate is `gate(envelope, run) -> GateReport`. The report holds **one check per item examined**,
and violations are *derived*, never authored:

```python
# MOD/data_types.py:264-283
class GateReport(BaseModel):
    checks: list[GateCheck] = Field(default_factory=list)
    def check(self, item, ok, note="") -> "GateReport":   # appends and returns self
    @property
    def violations(self) -> list[str]:                     # the failed checks, as "item: note"
    @property
    def passed(self) -> bool:                              # not self.violations
```

`GateCheck` (`:252-261`) is `{item, ok, note}` where `note` is the evidence — `"exists, 2.1KB"`,
`"exit 0"` — and on a failed check doubles as the reason sent back to the agent.

Both halves are persisted. `MOD/tracer.py:241-249` (`gate_row`) writes `violations_json` **and**
`checks_json` to `gate_results`; `MOD/agents.py:154-158` emits a `gate_pass`/`gate_fail` event
carrying `attempt`, `violations`, and `checks`. The payoff, stated at `MOD/gates.py:5-6`: *a green
gate says WHAT it verified instead of only that it passed.*

The shipped gate library (`MOD/gates.py`) is small and all mechanical:

| Gate | Line | Checks |
|---|---|---|
| `artifacts_exist` | `:27-33` | every declared artifact exists on disk, with its size as evidence |
| `files_non_empty` | `:36-44` | declared artifacts are non-zero (existence is the other gate's job) |
| `json_parses` | `:47-58` | `.json` artifacts parse; the note names the parsed type |
| `diff_matches_claims` | `:61-68` | every file claimed changed exists |
| `verdict_consistent` | `:71-95` | **the self-consistency check** — see below |
| `tests_pass(command)` | `:98-108` | gate *factory*: the shell command must exit 0; on failure the last 1000 chars ride along as the note |

**Self-consistency on review envelopes** (`MOD/gates.py:71-95`) is the one to lift carefully. It
judges the envelope **against itself**, never the code:

- `approved vs blocking` — an approval that ships blocking items is refuted.
- `approved vs findings` — an approval with unmet `ReviewFinding.met == false` requirements is refuted.
- `rejection names a problem` — `approved=false` with no blocking item and no unmet requirement is refuted.

Docstring at `:74-77`: "an approval that ships blocking items, or a rejection that names no problem,
is a claim the harness can refute **without reading a line of the diff**." The `ReviewOutput` shape
it operates on is at `MOD/data_types.py:107-120`.

Design boundary, stated at `MOD/gates.py:8`: **gates check what is mechanically checkable; plan
quality is a reviewer's job.**

### 1.5 Per-role model roster YAML (feeds DF1.5)

**Schema** — `AgentConfig` at `MOD/data_types.py:304-322`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | str | required | resolution key |
| `coding_agent` | `"pi" \| "claude_code"` | `"pi"` | `claude_code` is **rejected at validation** (`MOD/agents.py:61-63`) |
| `model` | str | `"google/gemini-3.6-flash"` | `provider/id`; resolved against pi's merged catalog |
| `thinking` | str | `"medium"` | `off\|minimal\|low\|medium\|high\|xhigh\|max` |
| `color` | str | `""` | hex swatch for this agent's lane in the UI |
| `purpose` | str | `""` | one line, surfaced in the envelope record |
| `prompt_engineering` | `{system, user}` | required | paths to `system.md` / `user.md` |
| `harness_engineering` | `list[str]` | `[]` | pi extension paths, passed as `-e` |
| `tools` | `list[str] \| None` | `None` | allowlist; `None` = all tools usable |
| `writes` | `list[str] \| None` | `None` | **repo write scope** — see §1.7 |

`ConfigDefaults` (`:325-338`) adds two roster-wide keys with no per-agent equivalent:
`protected_files` (default `["adws/adw_modules/", "adws/adw_sssf_config/", "adws/adw_*.py"]`) and
`data_dir` (default `"adws/adw_data"`). `ObservabilityConfig` (`:341-343`) carries `db` and
`poll_ms` (default 500).

**Merge semantics are shallow and explicit** — `MOD/agents.py:33-41`:

```python
for agent in raw.get("agents", []) or []:
    for key in ("coding_agent", "model", "thinking", "color", "tools", "writes"):
        if key in defaults:
            agent.setdefault(key, defaults[key])
    agent.setdefault("harness_engineering", defaults.get("harness_engineering", []))
```

`setdefault` — so a per-agent value always wins, and a per-agent `tools:` **replaces** the roster
list rather than extending it. There is no deep merge and no list concatenation anywhere.

**Fail-fast validation** — `MOD/agents.py:52-73` (`validate`) collects *all* problems before
raising: unknown agent name, unimplemented `coding_agent`, missing prompt file on disk, and an
unresolvable/ambiguous model pattern. Every ADW calls it before `session.ensure`, so nothing spawns
against a half-valid config.

**Reference rosters.** The template roster is `SSSF/templates/sssf.config.yaml` (five agents:
planner, builder, scout, reviewer, documenter — **no tester agent**, see §1.6). Inkwell ships five
swappable rosters at `INK/adws/adw_sssf_config/`: `sssf.config.yaml`, `sssf.frontier.config.yaml`,
`sssf.open-weights.config.yaml`, `sssf.top-speed.config.yaml`, `sssf.deepestseek.config.yaml`. Each
header states the design claim explicitly (`INK/adws/adw_sssf_config/sssf.frontier.config.yaml:4-6`):
*"Nothing here but the roster changes. Same ADW scripts, same prompts, same gates, same trace:
swapping this file in is the whole migration."*

**Gotcha to encode as an AC.** `SSSF/templates/sssf.config.yaml:9-11`: `--tools` filters extension
and custom tools too, not just builtins. An agent whose `harness_engineering` extension registers a
tool **must name that tool in its own `tools` list** or the extension loads and its tool is silently
filtered out. The planner and scout entries (`:59-62`, `:98-101`) demonstrate this with the four
`subagent_*` tools.

### 1.6 The no-tester-agent rule

`SSSF/templates/sssf.config.yaml:103-104`: *"No tester agent: running the suite is a known command,
so it is a kind=`code` phase over `adw_modules/quality.py`."* The rationale is in
`MOD/quality.py:177-183`: "An agent rediscovering the runner on every run costs a fortune to learn
what a subprocess already knows; the repair loop is unchanged, because a failure still reaches the
builder through `as_envelope`."

### 1.7 Permission fingerprinting (git change-set before/after, rollback)

`MOD/permissions.py`. The module docstring (`:1-30`) is the argument for the whole design and should
be quoted into the DF1 story:

> `tools:` is a capability list, not a sandbox, and two holes make it unenforceable on its own:
> `bash` runs anything — a builder handed bash to run a test suite can also run `git checkout adws/`,
> **which is not hypothetical: one did**, discarding uncommitted changes to the very quality check it
> was about to be judged by. And `write` reaches any path, not just the one report file.

Mechanism:

- **`snapshot(run)`** (`:50-68`) fingerprints the working tree: `git diff HEAD --numstat` gives
  tracked paths their `insertions,deletions` counts (so an edit to an *already-dirty* file still
  registers), and `git ls-files --others --exclude-standard` lists untracked paths as `"untracked"`.
  Gitignored paths never appear, which is why the session runtime under `data_dir` needs no special case.
- **`changed_paths(before, after)`** (`:71-74`) — every path whose state differs: *appeared, vanished,
  or was rewritten.* Comparing change-**sets** rather than watching for writes is what catches the
  `git checkout` case: a path modified before the agent ran and clean afterwards has been **reverted,
  and a reversion is a modification** (`:19-22`).
- **`permitted(path, agent, cfg)`** (`:127-135`) — precedence is: session runtime first (always
  writable), then the agent's own `writes` list, then `protected_files` (deny), then
  `writes is None` (unrestricted) vs `[]` (no repo writes). **Naming a path in `writes` is what
  unlocks a protected one** (`:131-132`).
- **Glob semantics** (`:77-99`) — a hand-rolled translator where `*` stops at `/` and `**` crosses
  directories. `fnmatch` was rejected because it would let `adws/adw_*.py` match
  `adws/adw_data/sessions/x/y.py`. A trailing `/` is a directory prefix; anything else is an exact path.
- **`always_writable(cfg)`** (`:110-124`) grants `data_dir/` to every agent, from config rather than
  from `.gitignore`: "an agent's ability to record its work must not hang on a gitignore entry that
  someone can delete." So `writes: []` means read-only **with respect to the repo, never mute**.
- **`enforce(...)`** (`:163-185`) snapshots again, computes breaches, **rolls back** each one, and
  raises `PermissionBreach` naming every offending path and what happened to it. Returns the
  legitimately-touched paths so the trace records what an agent *actually* touched rather than only
  what it claimed (`MOD/agents.py:187-190` writes these as a `paths_touched` log event).
- **`_roll_back`** (`:138-160`) is deliberately conservative in the SSSF version: a path that was
  *already dirty* when the agent started is left exactly as it is, because "discarding it to tidy up
  would be the same harm this module exists to prevent, committed by the cleanup instead of the
  agent." When the agent reverted an engineer's uncommitted work the outcome string is
  `"REVERTED-BY-AGENT (uncommitted work lost, cannot restore)"`.

**A breach is NOT a gate violation** (`:23-25`): gates are for work an agent can be asked to redo;
a breach cannot be corrected by re-prompting because the write already happened. It aborts the phase.

**Where it sits in the call sequence** (`MOD/agents.py:140-190`): `tree_before = permissions.snapshot(run)`
is taken at `:142`, **before the first send**, and every send in the phase — first prompt, JSON
retries, gate corrections — is measured against that one baseline. `enforce` runs at `:179`, *after
every send is done and before the envelope is accepted*: "an agent does not get to report success on
a phase in which it wrote somewhere it was not allowed to."

**Known ceiling (undisclosed in SSSF's own docs, and load-bearing for DF).** The fingerprint is
**whole-tree**, so two concurrent runs in one repo see each other's writes as breaches. This is the
structural reason the v5 architecture's "one run = one box = one key = one record" holds — it is not
a nice-to-have, it is the mitigation.

### 1.8 Inkwell's `permissions.py` delta — recovery-aware breach handling

`INK/adws/adw_modules/permissions.py` (256 lines vs SSSF's 185) adds a materially better failure
mode, and the DF port should take **inkwell's** version:

- `preserve(run, tree)` (`:153-176`) captures the **bytes** of every already-dirty path before an
  agent runs, bounded by `PRESERVE_MAX_BYTES = 1 << 20` (`:57`). Best-effort: a path that vanishes
  or is too large keeps the old behaviour.
- `_restore(...)` (`:178-189`) puts those bytes back, turning the worst case from "reported, gone"
  into "put back."
- `RECOVERED = {"deleted", "rolled back", "restored"}` (`:49`) and `RECOVERED_LIMIT = 3` (`:53`):
  when **every** offending path was put back and there were at most three of them, the tree is
  byte-for-byte what it would have been had the agent stayed in scope — so the run continues,
  loudly, instead of aborting. Rationale at `:243-247`: *"Aborting is about damage, not about the
  rule. A scratch file redirected into the repo should not kill a 13-phase run."* More than three is
  "a pattern, not an accident, and stops being forgiven" (`:51-52`).

`enforce` gains an optional `preserved:` parameter (`:220-221`), so the signature change is
backward-compatible.

### 1.9 Dual retry discipline

Two independent, separately-bounded retry loops, both re-entering the **same** agent session.

**Loop A — JSON parse retries.** `MOD/agents.py:24` sets `JSON_FIX_ATTEMPTS = 2`.
`_parse_with_retries` (`:267-287`) loops `range(1, JSON_FIX_ATTEMPTS + 2)`; each failure persists an
**invalid** envelope row (`:275-276`, so the bad output is in the trace) and re-sends a correction
naming the exact pydantic error and the required field list (`:284-287`). Exhaustion raises
`RuntimeError`. The JSON extractor itself (`_extract_json`, `:253-264`) tolerates fenced code blocks
and prose around the object.

**Loop B — gate-violation retries.** `MOD/agents.py:148-173`, bounded by the **per-phase**
`PhaseParams.retries` (`MOD/data_types.py:29`, default 0). Every gate runs every attempt; each
report is written to `gate_results` and emitted as an event *with its attempt number*. On violations
it sends:

```
Your previous response failed validation:
- <violation>
...
Fix these problems, then re-emit ONLY your Report JSON.
```

and then **re-runs Loop A on the corrected response** (`:173`). So the two loops nest: gate
corrections can each spend up to `JSON_FIX_ATTEMPTS` parse retries. Exhaustion raises `GateFailure`
(`:27-28`, `:163-165`).

**Same-session re-entry.** `_agent_session_id` (`:228-232`) returns the existing session id from
`run.agent_map` **only when the model matches**, otherwise mints `sssf-{adw_id}-{agent}-{new_id(4)}`.
Every send in a phase reuses that id, and `MOD/agent_pi.py:223` passes it as `--session-id`, which
"creates-or-continues" — so running and continuing an agent are the same call, on the same context
window (`MOD/agent_pi.py:5-6`).

**Usage accumulates; occupancy does not.** This is the asymmetry to get right, stated at
`MOD/agents.py:106-108`:

> Parse retries and gate corrections re-enter the SAME pi session, so **the last send is the one
> whose context occupancy is current** — while spend is the opposite: **every send costs, so usage
> accumulates across all of them.**

Implemented as: a `spent = UsageBreakdown()` accumulator merged on every send (`:110`, `:135`),
versus a `latest` pointer overwritten on every send (`:109`, `:136`) and read once at `:194`. The
`agent_end` event (`:204-212`) therefore carries **phase totals** for tokens/cost — "a retried phase
paid for every attempt" (`:206-207`) — alongside the last send's `context_tokens`/`context_window`.

### 1.10 UsageBreakdown and the cache economics

`MOD/data_types.py:388-433`. Mirrors pi's `usage` shape one-for-one so the numbers reconcile with
what pi itself reports.

Fields: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens`, `total_tokens`, and a parallel `*_cost` float for each of the first four plus
`total_cost`.

Three semantics that a DF port must preserve or the ledger will be wrong:

1. **`input` EXCLUDES cache reads** (`:392-394`), which bill at their own cheaper rate. Add them to
   learn the size of the prompt that was sent.
2. **`reasoning_tokens` is NOT a fifth component** (`:400-403`). Measured across every session on
   disk: reasoning is always ≤ output, and the four components always sum to `totalTokens`. So
   reasoning is the thinking **share of output**, billed at the output rate. Report it nested under
   output, never added to it.
3. **`merge(other)`** (`:430-433`) sums field-wise — "a phase that retries spends more than once."

`add_turn(usage, total_tokens)` (`:411-428`) folds one pi `message_end` usage object;
`total_tokens` is passed in rather than re-derived because the caller already computes it pi's way.

**The derived read/write split** — `VIZ/server/db.ts:335-360` (`usage()`) — is the analysis layer
worth copying wholesale. It is computed from `agent_end` payloads rather than stored, so every run
already in the db gets the split with no migration. The comment at `:329-333` is the number that
sells the feature:

> `total_tokens` is a SPEND number: every turn re-sends the whole conversation, so **an 86k
> conversation over 49 turns bills millions.** These two say what actually moved.

and the crucial exclusion at `:351-353`:

```ts
// RAW reads only: material entering the context for the first time, billed either as
// uncached input or as a cache write. Cache reads are the same tokens served again on
// later turns — counting them here would rebuild the very inflation this split exists to expose.
read    += (u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0);
written += u.output_tokens ?? 0;
```

**Context occupancy** is a different quantity again — `MOD/data_types.py:443-447` and
`MOD/agent_pi.py:93-106`. `_context_tokens` mirrors pi's own `calculateContextTokens`
(pi's `core/compaction/compaction.ts`), which is what pi compacts against and shows in its footer:
prefer the provider's `totalTokens`, else sum `input + output + cacheRead + cacheWrite`. **Cache
reads count here — cached prompt is still prompt.** Occupancy is read off the last *valid* assistant
turn: `MOD/agent_pi.py:272-275` skips turns whose `stopReason` is `aborted` or `error`, because
"an aborted or errored turn reports usage you can't trust, so it must not overwrite a good reading."

`context_window` comes from `MOD/agent_pi.py:108-117`: `~/.pi/agent/models.json` first, then pi's
merged `--list-models` catalog, then `0` = unknown (the UI draws no bar rather than a misleading
empty one).

### 1.11 Tool-call normalization (needed for the trace's tool_call events)

`ToolCallTracker` at `MOD/agent_pi.py:141-205` folds pi's three-event tool stream (`toolCall`
content block → `tool_execution_start`/`_update`/`_end`) into **one normalized record per completed
call**, emitted at `_end` because only the end carries the result. The record carries the call's
real span (`started_at`/`ended_at`), which the tracer writes to **columns** so the UI lays tool calls
on a time axis without parsing payload JSON.

Clip limits are deliberately generous (`MOD/agent_pi.py:26-28`): `RESULT_SNIPPET_CHARS = 20_000`,
`ARG_VALUE_CHARS = 20_000` ("the UI scrolls, it must not be handed cut-off data"),
`LABEL_CHARS = 80` for the one-line human name (`bash: ls -la src`, built by `_label` at `:131-138`
from `PRIMARY_ARGS = ("command", "path", "file_path", "pattern", "query", "url")`).

### 1.12 The pi subprocess contract (informs DF1's driver port)

`MOD/agent_pi.py:208-286` (`run`). Command shape at `:218-230`:

```
pi -p --mode json --provider <p> --model <id> --thinking <lvl>
   --session-id <id> --session-dir <dir> --system-prompt <text>
   [--tools a,b,c] [-e <ext>]... <prompt>
```

Two hard-won details:

- **`stdin=subprocess.DEVNULL` is mandatory** (`MOD/agent_pi.py:237-243`). Inheriting the parent's
  stdin makes pi see a non-TTY and sit forever waiting for piped input that never arrives. "That
  failure is silent and total: no request goes out, no bytes come back, and the ADW blocks on a read
  loop with nothing to read. Observed as a run that sat idle at 0% CPU with an empty raw_output.jsonl."
- **Streaming is solved by construction** (`:249-278`): the loop reads `process.stdout` line by line,
  writes+flushes each to `raw_output.jsonl` ("events land on disk as they happen"), parses it, and
  forwards to `on_event` — so the tracer inserts into SQLite *while the agent is still working*,
  never batched at phase end.
- `on_spawn(pid)` / `on_exit(pid)` bracket the child (`:208-216`) so a hung coding agent is a pid
  the trace can name, rather than one you hunt for in `ps`.

`resolve_model(pattern)` (`:67-90`) resolves against pi's **merged** catalog (`pi --list-models`,
cached with `@lru_cache(maxsize=1)` at `:43`), which already merges built-in providers with
`~/.pi/agent/models.json`. It accepts an exact `provider/id`, then a unique exact suffix match, then
a unique substring match, and **raises on ambiguity** rather than picking one.

---

## 2. SSSF — trace schema and visualizer (feeds DF1 trace + DF4 visualizer)

### 2.1 The seven-table schema

`MOD/tracer.py:17-90` is the literal DDL — this is the artifact to port, and the reference doc
`SSSF/references/observability.md:48-128` restates it with per-column commentary. **The reference
docs were verified accurate against the implementation** during this research; the design doc's note
that this is "rare and valuable" holds.

| Table | Lines | Primary key | Purpose |
|---|---|---|---|
| `sessions` | `:18-27` | `adw_id` | one row per run: request, status, engineer, timings, `total_tokens`/`total_cost`, `archived` |
| `phases` | `:28-37` | `phase_id` | `seq`, `name`, `kind`, `owner`, `description`, `status DEFAULT 'fail'`, `attempt`, `retries`, `error` |
| `events` | `:38-48` | `event_id` | `parent_id` for span nesting, `type`, `name`, `payload_json`, `tokens`, `started_at`/`ended_at` |
| `envelopes` | `:49-59` | `envelope_id` | `agent`, `output_type`, `payload_json`, `valid`, `attempt` — **invalid attempts are kept** |
| `gate_results` | `:60-70` | autoinc `id` | `attempt`, `gate`, `passed`, `violations_json`, **`checks_json`** |
| `processes` | `:71-79` | autoinc `id` | `kind` (`adw`\|`agent`), `pid`, `command`, `ended_at NULL = believed alive` |
| `agent_sessions` | `:80-89` | `(adw_id, agent)` | `coding_agent`, `model`, `color`, `session_id`, `context_tokens`, `context_window` |

Notes that matter for the port:

- **`processes` exists because a hung agent emits nothing** (`MOD/tracer.py:176-182`,
  `references/observability.md:130`): no events, no tokens, no output — exactly when you need its
  pid, and `ps` cannot tell you which `adw_id` it belongs to. `command` is stored "so a recycled pid
  is not killed by mistake" (`:77`). `session_finish` calls `processes_end_all` (`:165`).
- **`sessions.archived`** is review triage set by the UI, **never by a run** (`:26`).
- **`agent_sessions` carries context, not events**, because the lane wants one number per agent — the
  latest — and a session running the same agent twice overwrites it (`:255-258`).
- **`sessions.adw_name`** chains joined ADWs in run order, `" + "`-separated (`:147-154`).
- **`max_phase_seq`** (`:206-216`): a joined run *continues* the sequence rather than restarting at 1,
  which would collide on both `seq` (breaking ordering) and `phase_id` (silently overwriting through
  the upsert conflict clause).

**Event types** (`MOD/data_types.py:359`, tabulated at `references/observability.md:13-27`):
`phase_start`, `agent_start`, `tool_call`, `handoff`, `gate_pass`, `gate_fail`, `log`, `agent_end`,
`phase_end`, `error`. **`tool_call` is the only event that spans time** — it fills both `started_at`
and `ended_at`; every other type is a point and leaves `ended_at` NULL
(`MOD/data_types.py:364-368`, `observability.md:44`).

**Dual write.** `MOD/tracer.py:123-136` writes every event to JSONL **and** SQLite, in that order.
"Files are the raw record; `sssf.db` is the queryable mirror the UI polls" (`:1-6`). Losing the db
loses nothing that cannot be rebuilt from files.

### 2.2 WAL configuration

`MOD/tracer.py:108-112` — writer side:

```python
self.conn = sqlite3.connect(self.db_path, isolation_level=None)   # autocommit
self.conn.execute("PRAGMA journal_mode=WAL;")
self.conn.execute("PRAGMA synchronous=NORMAL;")
self.conn.execute("PRAGMA busy_timeout=5000;")
```

Reader side, `VIZ/server/db.ts:77-93`: opened `{ readonly: true }`, then `busy_timeout=5000` and
`synchronous=NORMAL` are set, and `journal_mode` is **asserted, not set** — a readonly connection
cannot change it — with a `console.warn` when it is not WAL.

`references/observability.md:136-146` states the rule as "open **every** connection — writer and
reader — with these three pragmas," and notes concurrent writers are fine given one small transaction
per event plus `busy_timeout`.

### 2.3 Additive migrations

`MOD/tracer.py:92-120`. The mechanism is a flat list of `(table, column, decl)` triples applied via
`PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN`:

```python
MIGRATIONS = [("agent_sessions", "color", "TEXT"),
              ("gate_results", "checks_json", "TEXT"),
              ("sessions", "adw_name", "TEXT"),
              ("agent_sessions", "context_tokens", "INTEGER"),
              ("agent_sessions", "context_window", "INTEGER"),
              ("sessions", "archived", "INTEGER DEFAULT 0")]
```

Rationale at `:92-93`: `CREATE TABLE IF NOT EXISTS` never revisits an existing table, so additive
changes need an explicit `ALTER`. There is no version number and no down-migration.

**The reader must cope with a db that predates a column.** `VIZ/server/db.ts:97-124` —
`hasColumn`/`optionalColumn` probe `PRAGMA table_info` and substitute `NULL AS <column>`, which reads
downstream as "this db predates the column." The probe **re-runs while the column is missing** and
**latches once seen** (`:107-110`), because the tracer's `ALTER` can land while the server is
serving — a startup-only check would keep returning NULL for the rest of the process even after the
data arrived. This is a small, high-value pattern for DF4.

### 2.4 Rowid-cursor polling

`VIZ/server/db.ts:362-384` is the entire live-tail mechanism:

```sql
SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
       payload_json, tokens, started_at, ended_at
  FROM events
 WHERE adw_id = ? AND rowid > ?
 ORDER BY rowid
 LIMIT ?
```

returning `{events, cursor: last rowid, has_more: events.length === limit}`. Limits: `DEFAULT_LIMIT
= 500`, `MAX_LIMIT = 1000` (`:32-33`), clamped by `clamp()` (`:415-418`).

The docstring at `:363-365` states the reuse claim: **"Rowid cursor, insertion order, bounded page —
the same mechanism serves the live tail and lazy-paged history."** Which is why there is no separate
replay path (`references/observability.md:158`).

Client side: `SessionTrace.vue:84` and `SessionCard.vue:65,73` both `setInterval(..., 500)`, matching
`observability.poll_ms`. The card polls **only while the run is `running`** (`SessionCard.vue:30,65`).

**No push transport at all** (`MOD/tracer.py:4`, `VIZ/server/index.ts:6-7`,
`references/observability.md:150`): no ingest endpoint, no WebSocket, no backfill or dedup logic. The
data path is always `agents → sqlite → web ui`.

### 2.5 Visualizer structure

**Stack** (`VIZ/package.json`): Vue 3.5 + Vite 7 + `bun:sqlite`, `lucide-vue-next` for icons,
`@fontsource/play`. Dev deps: oxlint, vue-tsc, TypeScript 5.7. Scripts: `dev` (vite),
`server` (bun), `build` (`vue-tsc --noEmit && vite build`), `typecheck`, `lint`.
**No test script and no test files** — this is the gap DF4 must close.

**Server** (`VIZ/server/index.ts`, 213 lines): `Bun.serve` with a `routes` object.
Endpoints — all GET and read-only except one:

| Route | Line | Notes |
|---|---|---|
| `GET /api/health` | `:116` | `{ok, db, journal_mode, sessions}` |
| `GET /api/sessions?limit=` | `:126` | L1 list; embeds phases + agents so the cards cost no extra request |
| `GET /api/sessions/:adw_id` | `:128` | L2: session + usage + phases + agents in one shot |
| `POST /api/sessions/:adw_id/archive` | `:135-147` | **the only write** — one column, `sessions.archived` |
| `GET /api/sessions/:adw_id/events?after=&limit=` | `:149` | the polling route |
| `GET /api/sessions/:adw_id/envelopes` | `:159` | |
| `GET /api/sessions/:adw_id/gates` | `:163` | |
| `GET /api/sessions/:adw_id/agents/:agent/prompts` | `:167-191` | reads `system.md`/`user.md` off disk; the db has no copy |

**Three drill levels** are encoded in the hash router — `VIZ/src/lib/router.ts:3`:

```
#/                        → L1 sessions list
#/<adw_id>                → L2 swim-lane waterfall trace
#/<adw_id>/<phase_id>     → L3 phase detail panel open
```

Component sizes (a realistic port estimate for DF4): `PhaseDetail.vue` 1265, `SessionTrace.vue` 858,
`SessionCard.vue` 472, `App.vue` 131, `SessionsList.vue` 96, plus `PhaseDots/StatChip/StatusChip/
DetailSection` at 55–88 each. Shared types `VIZ/shared/types.ts` 306 lines. Libs: `events.ts` 131,
`markdown.ts` 120, `format.ts` 92, `api.ts` 78, `highlight.ts` 54, `router.ts` 41, `models.ts` 29.
**≈3,991 lines total.**

L3 (`PhaseDetail.vue`) is where the compiled prompts, gate evidence, and the cost breakdown table
render — the three things that make the trace auditable rather than decorative.

### 2.6 Where auth is ABSENT — the DF4 hardening surface

**Verified by exhaustive grep across `VIZ/server/`, `VIZ/src/lib/api.ts`, and `VIZ/vite.config.ts`:
there is no authentication, no authorization, no session concept, no CORS policy, and no bind-address
restriction anywhere in the visualizer.**

Specifically, a hardening story must add:

1. **No authn/authz on any route.** `VIZ/server/index.ts:113-192` — the `routes` object has no
   middleware, no bearer-token check, no cookie. `VIZ/src/lib/api.ts` issues bare `fetch()` calls
   with no `Authorization` header anywhere.
2. **The one write endpoint is unauthenticated.** `POST /api/sessions/:adw_id/archive`
   (`index.ts:135-147`) lets any caller flip `sessions.archived` on any run.
3. **`Bun.serve` is started with `{ port, routes, fetch }` only** (`index.ts:113-115`) — no
   `hostname`, so it binds `0.0.0.0`. Combined with #1 this means anything that can route to the
   port reads the whole trace.
4. **The trace contains the compiled system and user prompts** (`index.ts:167-191`) and full envelope
   payloads. Treat the endpoint as disclosing prompt IP and any secret that leaked into a prompt.
5. **No rate limiting, no request size limits, no audit of reads.**

**What already exists and should be kept** (so the port does not regress it):

- **Path-traversal defence in depth.** `SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/` (`index.ts:63`) rejects
  anything that is not a plain identifier *outright rather than sanitizing it* (`:58-62`), plus a
  second `startsWith(db.sessionsDir + sep)` prefix check at `:177-179`, plus a third for the static
  file server at `:96-97`.
- **`safely()` handler wrapper** (`:44-56`) so a malformed query returns 500 rather than taking the
  server down mid-run.
- **`cache-control: no-store`** on every JSON response (`:35`).
- **Read connection is genuinely readonly** (`db.ts:77`); the single writer is opened lazily on its
  own connection only when someone clicks archive (`db.ts:138-150`).

**Deployment context for the threat model.** Inkwell exposes this port publicly:
`INK/just/sandbox/lifecycle/observe.just:113` starts the visualizer on 4600 inside the sandbox, and
`:162-167` verifies that `https://<vm>.exe.xyz:4600/` returns 307/401 anonymously — i.e. it relies
**entirely on exe.dev's proxy auth gate** for access control, with a comment at `:174-177` noting
"only ONE port can ever be anonymous." Remove that proxy (as the OCI/self-hosted enterprise tier
does) and the visualizer is wide open. DF4's auth story is therefore a **blocker for the enterprise
tier**, not a polish item.

---

## 3. Inkwell — credentials, run record, harvest, provider seam (feeds DF2)

### 3.1 Credential lifecycle — command shapes

**Phase ordering is the whole design.** `INK/just/sandbox/lifecycle/create.just:8-14`:

> Strict order: **record → VM → key.**
> *record first* — a crash anywhere after leaves teardown a handle to work from.
> *VM before key* — a failed mint orphans a VM: cheap, and visible in `ssh exe.dev ls`. A failed VM
> after a mint orphans a key that **spends money invisibly.**

Generalized in `teardown.just:8-11` as: *spend captured → artifacts out → commits harvested → key
revoked → VM destroyed.* "A crash between revoke and destroy leaves a dead key and a live VM
(visible, cheap). The reverse leaves a live key nobody can find (invisible, spends)."

**Mint with a $50 cap** — `create.just:22` is exactly the line the design doc cites:

```bash
LIMIT="50.00"   # dollars on the OpenRouter key; the only knob CREATE has
```

Overridable via `--limit N`, validated as a number at `:33-35`. The mint itself is `:133-136`:

```bash
CODE="$(curl -sS -o "$BODY" -w '%{http_code}' https://openrouter.ai/api/v1/keys \
    -H "Authorization: Bearer $OPENROUTER_PROVISIONING_KEY" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"name": "sbx-%s", "limit": %s}' "$RUN_ID" "$LIMIT")")"
```

Five secret-handling properties in that block worth turning into ACs:

- **The provisioning key is host-only.** Existence is checked at `create.just:44-47`; the value is
  "never printed, never written to a VM, never passed over ssh." `fill.just:6-7`, `setup.just:12-16`,
  `execute.just:16-18`, and `observe.just:9-11` each restate that they never read it.
- **The `sbx-` prefix is load-bearing** (`create.just:128-129`): it is how `reap` distinguishes
  managed keys from the engineer's personal ones. "Never mint without it."
- **The response body is a `mktemp` file (0600), shredded on every exit path** via an EXIT trap
  (`create.just:70-79`, `:132`).
- **The secret is written to disk by python, which prints only the hash** (`create.just:146-164`):
  `os.open(path, O_WRONLY|O_CREAT|O_TRUNC, 0o600)`. "The key never reaches stdout, a log, or a shell
  variable. It also stays out of the JSON record, which is greppable and gets shown in reports."
- **The record stores `key_hash`, never the key** (`create.just:167`).

**Delivery via stdin, never argv** — `fill.just:147-151` (the design doc cites `:147`, which is the
first line of the explanatory comment; the code is `:150-151`):

```bash
# printf is a builtin and cat reads stdin: the key never appears in argv on
# either side, so it never shows up in ps. umask before the redirect so the
# file is never briefly world-readable.
printf 'OPENROUTER_API_KEY=%s\n' "$RUNTIME_KEY" \
    | ssh "$HOST" 'umask 077 && cat > app/.env && chmod 600 app/.env'
```

Verified without echoing it back: `ENV_STAT=$(ssh "$HOST" 'stat -c "%a %s" app/.env')` (`:154-155`).

**Revoke + verify against the key LIST** — `teardown.just:142-196`. Two parts:

*Revoke* (`:150-156`): `DELETE $API/keys/$KEY_HASH`, treating `2xx` as revoked, **`404` as
already-gone (idempotent re-run)**, and anything else as a hard failure that leaves the VM alone.

*The gate* (`:178-196`) — and this is the measured finding the design doc quotes:

```bash
# MEASURED: right after a successful DELETE, GET /api/v1/key still returns 200
# for the dead key. The LIST is the authoritative view. Never gate on /key.
```

So the gate re-lists `GET /api/v1/keys` and asserts `KEY_HASH` is **absent** from
`.data[].hash`. On failure it prints the manual `curl -X DELETE` and exits 1.

`reap.just:121-137` applies the identical gate fleet-wide, with the same comment: *"Same gate as
teardown, for the same measured reason: the LIST is authoritative."*

**Spend is captured BEFORE the key dies** (`teardown.just:73-100`) — "after DELETE the number is
unrecoverable." Primary source is `GET /api/v1/key` with the *runtime* key (verified shape
`{"data":{"usage":0.0081,"limit":50.0,...}}`); the fallback for a re-run after the key file was
shredded reads `usage` per hash out of the provisioning LIST (`:86-91`).

**Shred at close** (`teardown.just:169-175`): `shred -u` where available, `rm -Pf` on macOS,
`rm -f` last so a re-run never fails on an already-removed file.

**The fleet backstop** — `reap.just`. "OpenRouter keys have no native TTL, so a teardown that never
ran leaves a key spending forever" (`:4-6`). Selection is a three-way join of key list × VM list ×
run records, done in python because "not a thing to write in jq" (`:49`). Safety model:

- **Nothing without the `sbx-` prefix is ever considered** (`:8-9`, `:60-61`): "The engineer's
  personal keys carry NO prefix (verified: mac-mini-agent, OAuth: localhost, m4 global, benchy) and
  deleting one is unrecoverable."
- **The prefix is re-asserted at the point of deletion, not just at selection** (`:106-110`):
  "Defence in depth… A bug upstream must not be able to reach a personal key."
- **Dry run by default**; `--yes` to actually delete (`:97-101`).
- **An unreadable run record is a hard exit, not a skip** (`:69-73`) — "an unreadable record is a key
  nobody can account for."
- Known gap, honestly marked (`:41-42`): whether `GET /keys` paginates is UNVERIFIED — observed 4 keys
  with no pagination envelope.

### 3.2 Run-record discipline

`INK/sandbox_mount/host/run_record.py`, 274 lines, **stdlib only on purpose** (`:22-23`): "this runs
on the host before any toolchain exists and must never be the reason a teardown cannot start."

CLI surface (`:10-17`): `create | get | set | close | list | path | new-id`.

**Closed schema** (`:43-56`) — twelve fields: `run_id, vm_name, https_url, key_hash, limit, spend,
session_id, commit_sha, ports, pid, created_at, closed_at`. Unknown keys are **rejected**, not
written (`:139-141`), "because every field is referenced by name somewhere in the six phases, so a
typo in a `set` is a silent data loss bug." `IMMUTABLE = ("run_id", "created_at")` (`:60`).

**O_EXCL create** (`:99-105`):

```python
# O_EXCL, not `if target.exists()`: overwriting a live record orphans that
# run's key, and the check-then-write window is exactly when a retrying
# phase would land.
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
```

**Atomic replace** (`:180-184`): write to `.json.tmp`, then `os.replace` — "a crash mid-write leaves
the old record, not half of one."

**Unreadable = hard error** (`:163-177`): `list_runs` raises rather than skipping a malformed record.
"Loud, not skipped. `reap` walks this list to find keys nobody revoked; a record quietly dropped for
being malformed is a key that quietly keeps spending."

**Per-field coercion, not "try JSON first"** (`:66`, `:187-197`): `{"ports": "json", "pid": "int",
"limit": "float", "spend": "float"}` — "because a `commit_sha` of 5734129 is a string that happens to
parse as a number."

**Idempotent close, first-close-wins** (`:150-160`): "teardown is retryable and the moment that
matters is when the key actually died."

**Run-id generation** (`:78-88`): `<slug>-<YYYYMMDD>-<6 hex>`, generated never supplied — "The run id
becomes the VM name and the VM name becomes a public URL, so a collision is not a local annoyance —
it is two runs fighting over one hostname." Hostname-validity is re-checked in `create.just:54-60`
(regex plus a 63-char limit).

**Shell-friendly output** (`:200-209`): `get <id> <field>` prints the bare value; an unset field
prints an empty line, so **emptiness is the real check** — which is exactly how `setup.just:36-38`
distinguishes "CREATE never finished" from "FILL never finished."

### 3.3 Ranged git-bundle harvest into `refs/sandbox/<run-id>`

`INK/just/sandbox/manage/harvest.just`. Two design arguments in the header, both load-bearing:

**Why a bundle and not a push** (`:6-14`): the sandbox is filled by a public, unauthenticated
`git clone` and holds one disposable OpenRouter key and **no git credential of any kind** — no PAT,
no deploy key, no ssh identity. "That is deliberate: the box runs an autonomous agent under
`--dangerously-skip-permissions`, and a push credential would give that agent write access to the
repo it was cloned from. A bundle moves commits across that gap with no credential at all."

**Why a range and not `--all`** (`:16-19`): `git bundle create f <base>..<branch>` packs only the
objects the run introduced — KB, not MB. **The more useful half is the prerequisite:** a ranged
bundle records "you must already have `<base>`", and `git fetch` **refuses** it otherwise. So a run
branch that does not descend from the sha FILL pinned is caught here instead of importing
disconnected history. *A free integrity check on the return trip.*

Flow: remote `git bundle create /tmp/harvest.bundle "$base..refs/heads/$branch"` (`:71`) → `scp` to
`.sandbox/runs/<id>.bundle` (`:86`) → **`git bundle verify` BEFORE fetching** (`:90-96`) → `git fetch
--force "$BUNDLE" "refs/heads/$BRANCH:refs/sandbox/$RUN_ID"` (`:100`).

Three properties to carry into DF2:

- **It only ever writes refs under `refs/sandbox/`** — never the working tree, index, or any branch
  the operator owns (`:26-27`).
- **Idempotent**: `--force` so a re-harvest of a run that committed more updates the ref rather than
  refusing a non-fast-forward (`:98-99`).
- **Not a seventh phase** (`:21-23`): it writes nothing to the run record — "the bundle's existence
  at `.sandbox/runs/<id>.bundle` IS the record… The schema stays closed."

The run branch it harvests is created in `fill.just:74-90` as `sbx/<run-id>`, at whatever HEAD
already is — "it adds no commit, changes no file, and leaves the tree byte-identical," so setup
assertion A still passes. On a re-fill it **switches to the existing branch, never re-creates it**:
"Its commits ARE the run's output."

`teardown.just:123-140` runs harvest by default and **a harvest failure ABORTS the teardown** before
revoke and destroy: "destroying a VM whose commits were never pulled is the one irreversible mistake
available in this file." `--no-harvest` is the explicit opt-out.

### 3.4 The five-assertion setup gate

`INK/just/sandbox/lifecycle/setup.just`, invoked as `just sbx lifecycle setup <run-id> [CONFIG]`.
Runs provision → sentinel → gate. **Never destroys the VM on failure** (`:8-10`, `:48-58`): "a gate
that auto-destroys throws away the evidence." `gate_fail()` prints the three debug commands and the
teardown command, then exits 1.

| # | Assertion | Lines | What it actually proves |
|---|---|---|---|
| **A** | **git integrity by content** | `:90-120` | `HEAD` prefix-matches the recorded `commit_sha` **and `git status --porcelain` is empty**. Motivated by a measured failure: "an unsynced golden-VM clone produced **5,641 zero-byte files and reported success**, and truncation shows up as ` M path`." |
| **B** | **pi model registry loaded** | `:122-145` | `command -v pi` first (else "command not found" is one non-empty line a naive check passes), then `pi --list-models` non-empty **and** not containing `no models available` — because **`pi --list-models` EXITS 0 while printing "No models available"**, so `$?` must never be trusted. |
| **C** | **live model ping, per roster** | `:169-201` | Parses `model:` values out of the *active* config, strips the `openrouter/` pi-provider prefix, and POSTs a real `chat/completions` ping per model with `provider:{zdr:true, data_collection:"deny"}`. Accepts `content` **or** `reasoning` — "Reasoning models answer with content=null and the text under `.reasoning`. Accepting only `.content` here produces false failures." |
| **D** | **cost table loaded** | `:205-243` | Two halves. (1) A real `pi -p --mode json` call must report `cost.total > 0`. (2) `~/.pi/agent/models.json` must have a non-zero `cost.input` for **every** model. |
| **E** | **credit remaining** | `:245-255` | `GET /api/v1/key`, with remaining **computed** as `limit - usage` rather than read from a `limit_remaining` field "so this cannot break on a field name we have not verified." `null` limit = uncapped. |

**Assertion D is the single most valuable one to port**, and its comment (`:205-217`) is the story
justification verbatim:

> `adw_modules/agent_pi.py` reads `usage.cost.total` straight out of pi, and **pi defaults every rate
> to ZERO when models.json carries no `cost` block. A factory in that state runs fine and reports
> $0.0000 forever while genuinely spending. Observed: a 463.6k-token run logged $0.0000.**
>
> An earlier version diffed `/api/v1/key` usage before and after the pings; **that is the WRONG
> INSTRUMENT and it false-failed this gate on the first live mount** — four 250-token pings round to
> $0 in that endpoint, so a correctly configured sandbox looked broken. A real pi call on the cheapest
> roster model reports cost 4.3e-05 for one sentence, which is small but unambiguously > 0.

And the schema landmine at `:234-236`: **pi's models.json schema requires ALL FOUR of
`input`/`output`/`cacheRead`/`cacheWrite`. A partial cost block fails validation and pi then drops
THE ENTIRE ROSTER, not just that model.**

Three structural properties:

- **C/D/E run as ONE script inside the sandbox** (`:147-151`) so the runtime key never crosses the
  wire and the gate exercises the sandbox's own egress, not the host's.
- **The roster is an ARGUMENT, not an environment variable** (`:18-24`) — a measured bug: C used to
  read `$SSSF_CONFIG` from the remote environment, but **`ssh host 'cmd'` carries no environment at
  all**, so every fan-out arm was gated against models it would never call. "The gate passed and told
  you nothing."
- **Distinct exit codes** map to distinct failures (`:257-271`): 2 = C, 3 = D.
- The sentinel is cleared **before** provisioning (`:61-65`) so a re-run cannot find the previous
  run's `/tmp/PROVISION_READY` and declare victory before provision ran.

### 3.5 The exe.dev seam — the provider-driver surface

**The design doc's "~6 command shapes across 5 just files (~30 lines)" is accurate.** Exhaustive grep
of `INK/just/` and `INK/sandbox_mount/` gives exactly six control-plane shapes:

| # | Command shape | Call sites |
|---|---|---|
| 1 | `ssh exe.dev new --name <id> --tag <tag> --json` | `create.just:85` |
| 2 | `ssh exe.dev ls [<name>] --json` | `create.just:110`, `teardown.just:64`, `reap.just:45`, `manage/list.just:22` |
| 3 | `ssh exe.dev rm <vm>` | `teardown.just:161` |
| 4 | `ssh exe.dev share port <vm> <port>` | `observe.just:130` |
| 5 | `ssh exe.dev share set-public <vm>` | `observe.just:131` |
| 6 | `ssh exe.dev whoami` | `manage/mod.just:29` (a doctor/preflight check) |

Five files carry the *operational* five (create, teardown, reap, list, observe); the sixth
(`whoami`) is the preflight in `manage/mod.just`. **Everything else is plain `ssh <vm>.exe.xyz "<cmd>"`
and `scp`** — i.e. generic SSH, not a provider API: `fill.just:43,151,154`, `setup.just:43`,
`execute.just:91`, `observe.just:48,83,113`, `harvest.just:54,86`, `teardown.just:108`,
`run/mod.just:42,86`.

**Implication for DF2's driver interface:** the provider abstraction needs roughly `create(name, tag)
→ {vm_name, https_url}`, `list([name]) → [{vm_name, https_url, …}]`, `destroy(vm)`,
`expose(vm, port)`, `setPublic(vm)`, `whoami()`, plus an `exec(vm, cmd, stdin)`/`copyFrom(vm, path)`
pair that a plain SSH implementation satisfies. That is the entire surface.

**The vendored `exedev` CLI is a red herring for the seam.** `INK/.claude/skills/sandbox-exe-dev/`
ships a 2,242-line Python CLI (`exedev init/vm/exec/files/share/browser` + `doctor`/`whoami`) that
**none of the just recipes call** — they use raw `ssh` throughout. It is useful as documentation of
exe.dev's full surface (the `sbx`→`exedev` mapping table at `SKILL.md:82-102`), not as the port
target.

**Response-shape honesty, and the pattern to copy.** `create.just:87-89` marks the `new --json` key
names **UNVERIFIED** ("only `ls --json` was observed: `{"vms":[{vm_name,https_url,ssh_dest,...}]}`"),
accepts several plausible shapes, and **falls back to re-reading from the one verified shape**
(`:108-119`) rather than guessing. `https_url` derivation from `<name>.exe.xyz` is separately marked
"Measured" (`:121-122`). A DF2 driver should carry the same explicit verified/unverified split.

**[VERIFY-vendor] — all exe.dev behavioural claims here are single-origin.** Everything above comes
from inkwell's own comments plus the vendored skill doc; none of it was independently confirmed
against exe.dev. Claims to re-verify before they harden into acceptance criteria:

- All `*.exe.xyz` share one gateway host key with a wildcard `known_hosts` entry
  (`create.just:172-173`, repeated in four files).
- A fresh VM proxies port 8000 by default (smallest EXPOSEd port ≥ 1024) — `observe.just:126-128`.
- **Only ONE port can ever be anonymous**; ports 3000–9999 are auto-forwarded but auth-gated
  (`observe.just:159-161`, `:175-177`).
- `POST https://exe.dev/exec` is capped at 30s / 64KB, which is why the CLI uses SSH
  (`SKILL.md:52`, `:310`).
- `ANTHROPIC_BASE_URL=https://llm.int.exe.xyz` is a key-free gateway (`run/mod.just:81-86`,
  `provision.sh:180`).
- Boot ~2s; VMs never expire and bill until `kill` (`SKILL.md:17`, `:47`, `:135`).
- Host-key fingerprint `SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo` (`SKILL.md:29`).

### 3.6 Teardown scripts shipped unrun

**Confirmed verbatim** at `INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/teardown_and_reap.md:6`:

> **Status, honestly: teardown and reap are written but have NOT been run.** Five of the six phases…

So `teardown.just` (197 lines) and `reap.just` (138 lines) — the two files that actually delete money
and infrastructure — are **untested code** in the source repo. This is not a reason to reject the
pattern; it is a reason DF2's teardown/reap stories must carry executable tests as blocking ACs,
since the reference implementation has none. It also means every "MEASURED" comment inside those two
files (notably the `/api/v1/key`-returns-200-for-dead-keys finding at `teardown.just:179-180`) is a
claim from the author's manual probing, not from a run of this script.

For completeness on what they do:
- **`teardown <run-id> [--no-harvest]`** — 7 steps: capture spend → pull artifacts (`specs`,
  `app_docs`, `sssf.db`, `run.log` via one `tar` round trip) → harvest commits (failure aborts) →
  revoke key → destroy VM → close record + shred key file → gate on key absence from the list.
  Idempotent by construction, every step individually guarded, "because a run can die anywhere — VM
  but no key, key but no VM, a record with neither. A missing piece is the normal path, not an error"
  (`:17-19`). **The only file allowed to destroy a VM** (`:11`).
- **`reap [--yes]`** — fleet-wide orphan sweep, described in §3.1.
- **`mount <run-id>`** (`INK/just/sandbox/mount.just:11-19`) chains create → fill → setup → observe
  and **stops there by design**: "teardown is ALWAYS an explicit separate decision, never chained."

---

## 4. pi 0.55.0 facts (feed DF1.9 lean profile, DF1.5 roster)

**Verified on this host: `/usr/local/bin/pi`, `pi --version` → `0.55.0`.**

### 4.1 `--no-extensions` and `--no-skills` — BOTH EXIST ✅

From `pi --help` on this host, verbatim:

```
  --tools <tools>                Comma-separated list of tools to enable (default: read,bash,edit,write)
                                 Available: read, bash, edit, write, grep, find, ls
  --no-tools                     Disable all built-in tools
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
```

Four separate discovery-disable levers, each with a short alias, plus **`--no-extensions` still
honours explicit `-e` paths** — which is exactly the shape a lean worker profile needs: kill ambient
discovery, keep the one extension the role actually requires (`coms-net.ts` for a tier-3 worker).

**SSSF does not use any of them.** `MOD/agent_pi.py:218-230` builds the command with `--tools` and
`-e` only. So "lean profile" is genuinely new surface for the DF port, not a port of existing behaviour.

**Provenance of the 5–6× hypothesis.** The claim originates in
`<workspace>/docs/superpowers/specs/2026-08-11-pre-derivation-gates-report.md:228-230`:

> The 37K pi overhead is the factory's #1 cost lever — 78–88% of the bill on the proven path. A "lean
> worker profile" (no extensions/skills for tier-3 workers) is a candidate step-1 story with a
> **measured 5–6× payoff hypothesis.**

and the supporting table row at `:193`:

> Cache regime | Warm↔cold = 1.5–2× swing; the F6 path is **already warm** — cold is the downside
> risk, elimination (**−81–86% via `--no-extensions`/`--no-skills`, untested**) is the lever

**Read carefully: the report itself marks the elimination figure "untested."** The measured part is
the 37,279-token per-turn fixed overhead (`:189`, `[M]`, "39–42K residual-triangulated across two
rate cards") representing 78–88% of every agent's bill. The 5–6× is a *hypothesis* about what
removing it would yield, not a measurement of having removed it. **DF1.9 should be written as a
measurement story whose deliverable is the A/B number, with the 5–6× as the hypothesis under test —
not as an optimization story that assumes the payoff.**

### 4.2 `~/.pi/agent/models.json` custom-model schema

The file exists on this host and holds exactly the v4-flash registration:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "apiKey": "!python3 -c \"import json;print(json.load(open('<home>/.pi/agent/auth.json'))['openrouter']['key'])\"",
      "models": [
        {
          "id": "deepseek/deepseek-v4-flash-0731",
          "name": "DeepSeek: DeepSeek V4 Flash (0731)",
          "reasoning": true,
          "cost": { "input": 0.08, "output": 0.18, "cacheRead": 0.016, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        }
      ]
    }
  }
}
```

Schema, provider level: `baseUrl`, `api` (here `"openai-completions"`), `apiKey`. **The `!` prefix on
`apiKey` runs a shell command and uses its stdout** — a credential-indirection mechanism worth noting
for DF2, since it means the key need not sit in `models.json` itself.

Model level: `id`, `name`, `reasoning` (bool), `cost{input, output, cacheRead, cacheWrite}` (per
million tokens), `contextWindow`, `maxTokens`.

Two consumers in SSSF confirm the contract:

- `MOD/agent_pi.py:108-117` (`context_window`) reads
  `providers.<provider>.models[].contextWindow` by matching `id`, falling back to the
  `pi --list-models` catalog, then `0`.
- `MOD/agent_pi.py:67-90` (`resolve_model`) notes that pi's catalog **merges** built-ins with this
  file, "which lets SSSF target direct providers such as `openai/gpt-5.6-terra` without re-registering
  built-in models locally."

**The two rate-table landmines, restated because DF1.5 must encode both:**

1. **All four cost keys are required.** `INK/just/sandbox/lifecycle/setup.just:234-236`: a partial
   cost block fails pi's schema validation and **pi drops the entire roster**, not just that model.
   (Note `"cacheWrite": 0` above — present with value zero, not omitted.)
2. **A missing `cost` block defaults every rate to zero and the factory silently reports $0.0000**
   while genuinely spending (`setup.just:205-212`, observed on a 463.6k-token run).

### 4.3 Other pi CLI facts relevant to the port

- `--model` accepts `provider/id` **and** an inline thinking level: `sonnet:high`.
- `--thinking` levels from `--help`: `off, minimal, low, medium, high, xhigh` — **note `max` is
  absent from pi 0.55.0's help text**, though SSSF's `AgentConfig.thinking` comment
  (`MOD/data_types.py:308`) and the config YAMLs list it. Worth a one-line check before a roster ships
  `thinking: max`.
- `--mode json` is what SSSF tails; `rpc` also exists (the mode `agent-team`/burrow uses).
- `--session-id` is not in the help text but is the flag SSSF passes (`MOD/agent_pi.py:223`);
  `--session <path>`, `--session-dir <dir>`, `--no-session`, `--continue/-c`, `--resume/-r` are listed.
- `PI_CODING_AGENT_DIR` overrides session storage (default `~/.pi/agent`). SSSF also honours
  `PI_PATH` and `PI_MODELS_PATH` (`MOD/agent_pi.py:22-24`).
- pi's default tool set is `read,bash,edit,write` — **`grep`, `find`, `ls` are OFF by default**, which
  is why every SSSF roster names them explicitly (`SSSF/templates/sssf.config.yaml:17-19`).

---

## 5. Verification register — design-doc claims vs. what was found

**All located. No unfindable claims.**

| Design-doc claim | § | Status | Primary citation |
|---|---|---|---|
| Phase contextmanager; status defaults to fail | 3.3 | ✅ | `MOD/runner.py:72-111`; `MOD/data_types.py:63`; `MOD/tracer.py:33` |
| Descriptions validated for legibility at construction | 3.3 | ✅ | `MOD/data_types.py:31-53` |
| Envelope adapter — deterministic results indistinguishable from agent reports | 3.3 | ✅ | `MOD/quality.py:193-211`; `MOD/data_types.py:237-248`; `MOD/changes.py:87-103` |
| Gates record pass AND fail; green gate says what it verified | 3.3 | ✅ | `MOD/data_types.py:264-283`; `MOD/tracer.py:241-249` |
| Self-consistency checks on review envelopes | 3.3 | ✅ | `MOD/gates.py:71-95` |
| Per-role roster YAML: model/provider/thinking/tools/writes, defaults + shallow merge | 3.3 | ✅ | `MOD/data_types.py:304-338`; `MOD/agents.py:33-41` |
| Permission fingerprinting; catches reversions not just writes | 3.3 | ✅ | `MOD/permissions.py:50-74`, `:19-22` |
| Dual retry discipline; usage accumulated, occupancy from last send | 3.3 | ✅ | `MOD/agents.py:24, 106-137, 148-173, 267-287` |
| 7-table schema (named exactly) | 3.3 | ✅ | `MOD/tracer.py:17-90` |
| WAL; additive migrations; rowid-cursor polling | 3.3 | ✅ | `MOD/tracer.py:108-120`; `VIZ/server/db.ts:362-384` |
| Vue 3 + Bun read-only server, three drill levels | 3.3 | ✅ | `VIZ/package.json`; `VIZ/server/index.ts`; `VIZ/src/lib/router.ts:3` |
| Reference docs verified accurate against the tracer | 3.3 | ✅ | `SSSF/references/observability.md:48-128` ≡ `MOD/tracer.py:17-90` |
| Needs auth, tests, Bun-API audit | 3.3 | ✅ | §2.6 — zero auth anywhere; no test script/files in `VIZ/` |
| Quality blocks ship as `echo` placeholders that exit 0 | 3.3 | ✅ | `MOD/quality.py:49-52`, `:144` |
| "Commits on false green" — **narrowed**: a real guard exists | §4 note | ✅ narrowed | Guard at `adw_plan_build_test.py:69-70` + `run.finish(accepted=…)` `:76`. Residual: `quality.test()` is a placeholder, so `test.passed` is vacuously true in a stamped-but-unedited repo |
| Whole-tree fingerprints ⇒ unsafe for concurrent runs in one repo | 3.3 | ✅ | `MOD/permissions.py:50-68` (`git diff HEAD` over the whole tree) |
| pi-only; `claude_code` rejected at config validation | 3.3 | ✅ | `MOD/agents.py:61-63` |
| $50 cap at `create.just:22` | 3.4 | ✅ **exact line** | `INK/just/sandbox/lifecycle/create.just:22` |
| stdin key delivery, never argv, at `fill.just:147` | 3.4 | ✅ (comment `:147-149`, code `:150-151`) | `INK/just/sandbox/lifecycle/fill.just:147-151` |
| Revoke verified against the authoritative key LIST | 3.4 | ✅ | `teardown.just:178-196`; `reap.just:121-137` |
| Single-key endpoint returns 200 for deleted keys — "they measured it" | 3.4 | ✅ (source comment says MEASURED) | `teardown.just:179-180` |
| Ranged bundles into `refs/sandbox/<run-id>` | 3.4 | ✅ | `harvest.just:39, 71, 100` |
| Box never holds a push credential (`--dangerously-skip-permissions`) | 3.4 | ✅ | `harvest.just:6-14`; `run/mod.just:86` |
| Every failure path leaves the VM alive and prints the next command | 3.4 | ✅ | `create.just:12-14, 71-79`; `setup.just:48-58`; `observe.just:13-15`; `execute.just:12-14` |
| Run records O_EXCL-created, atomically replaced, unreadable = hard error | 3.4 | ✅ | `run_record.py:99-105, 180-184, 163-177` |
| Five-assertion setup gate (git integrity by content, live ping, cost table, credit) | 3.4 | ✅ | `setup.just:90-255` |
| Teardown shipped unrun — "their own cookbook" | 3.4 | ✅ **verbatim** | `INK/.claude/skills/sssf-sandbox-orchestrator/cookbooks/teardown_and_reap.md:6` |
| Best-of-N unimplemented: 214-line cookbook + a bash loop | 3.4 | ✅ | `cookbooks/fan_out_n.md` = 214 lines |
| Vendored exedev CLI unused by the recipes beside it | 3.4 | ✅ | zero `exedev` invocations in `INK/just/`; recipes use raw `ssh` |
| exe.dev seam ≈ 6 command shapes / 5 just files / ~30 lines | 3.4 | ✅ | §3.5 — 6 shapes; 5 operational files + 1 preflight |
| `--no-extensions` / `--no-skills` exist (the lean-profile lever) | §3.3 gates report | ✅ **CONFIRMED** | `pi --help` on this host, pi 0.55.0 |
| 5–6× lean-profile payoff | §3.3 gates report | ⚠️ **hypothesis, self-marked untested** | `pre-derivation-gates-report.md:193, 228-230` |

### Flags for the story writers

1. **`--no-extensions` / `--no-skills` are real** — DF1.9 has a concrete lever. Four disable flags
   exist (`-ne`, `-ns`, `-np`, `--no-themes`), and `-ne` still honours explicit `-e` paths, so a lean
   profile can keep `coms-net.ts` while killing ambient discovery.
2. **The 5–6× is the only load-bearing number in this report that is not measured.** Its own source
   marks the elimination figure "untested." Write DF1.9 so the deliverable is the measurement.
3. **Cite inkwell's `permissions.py`, not SSSF's**, for the DF1 permission story — the
   preserve/restore/`RECOVERED_LIMIT` behaviour (§1.8) is a strictly better failure mode and the
   signature change is backward-compatible.
4. **Inkwell's teardown and reap are untested code.** DF2's teardown/reap stories need executable
   tests as blocking ACs; there is nothing upstream to inherit.
5. **All exe.dev behavioural claims are `[VERIFY-vendor]`** — single-origin from inkwell's comments
   and its vendored skill doc. The seven listed in §3.5 should not harden into ACs unverified.
6. **`thinking: max`** appears in SSSF config comments but **not** in pi 0.55.0's `--help`. Cheap to
   check; expensive if a roster ships with it.
