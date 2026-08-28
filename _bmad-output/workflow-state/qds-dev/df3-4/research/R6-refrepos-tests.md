# R6 — Reference repos (IndyDevDan / disler) + QDS-Factory test conventions

Track R6 for DF3.4 (Tier-1 pre-PR approval gate + `fleet attach` steering).
Read-only survey. Written 2026-08-28, branch `feature/df3-4-approval-gate-attach-steering`.

---

# PART A — the reference repos

## A0. Inventory (what actually exists)

| Repo | Substance | Verdict |
|---|---|---|
| `/Users/steve/reference-repos/super-simple-software-factory` | README.md + LICENSE + 9 SVGs + `.claude/skills/sssf/**` (the same skill bundle that ships inside the inkwell repo). **No standalone application code.** | CONFIRMED README+images+skill-bundle only. Nothing new beyond what inkwell already carries. |
| `/Users/steve/reference-repos/sssf-demo` | `.claude/skills/qds-dark-factory/**` — a byte-level rename of `.claude/skills/sssf/**` — plus `adws/` (identical module set) and `adws/adw_data/sessions/*` (two recorded run artifacts: `envelope.json`, `raw_output.jsonl`, `pi_sessions/*.jsonl`, `context_handoff/plan.md`). | Duplicate of inkwell's `adws/`. Only genuinely new content is the **recorded session artifacts**, useful as example envelope/NDJSON shapes, not as code. |
| `/Users/steve/reference-repos/inkwell-agent-sandboxes-and-software-factory` | The substantial one. `adws/` (3502 LoC Python), `apps/inkwell` (a demo Node app), `specs/`, `app_docs/`, `ai_docs/`, and three skill bundles: `sssf`, `sssf-sandbox-orchestrator`, `sandbox-exe-dev`, `herdr`. | The only repo worth mining, and see below — the DF3.4-shaped parts are largely absent. |

**Language reality check, stated plainly.** `adws/` is **Python 3 (uv single-file scripts, pydantic
data types)**. DF3.4 is **TypeScript on Bun**. Nothing in `adws/` is liftable verbatim into
`src/fleet/*.ts`. Every A-section verdict below is bounded by that fact before any other
consideration.

---

## A1. Human-in-the-loop / approval / review-gate patterns

**Finding: there is no human-in-the-loop anywhere in these repos.**

Exhaustive grep across `adws/**` and `.claude/skills/**` for `input(`, `click.confirm`, `getpass`,
`await_human`, `wait_for_human`, `manual`, `pause`:

- Zero blocking human prompts.
- Zero pauses before an irreversible action.
- The word "approve" appears **only** as an LLM reviewer's self-reported envelope field.

The closest thing is an **agent-vs-agent** review gate:

- `adws/adw_modules/data_types.py:118` — `approved: bool = False` on `ReviewOutput`. This is a
  *model's* verdict emitted in its report JSON, not an operator's decision.
- `adws/adw_modules/gates.py:71-95` — `verdict_consistent(envelope, run)`. The most interesting
  single function in the repo for DF3.4, and it is still not an approval gate. It checks a review
  envelope against **itself**:
  ```python
  report.check("approved vs blocking", not (approved and blocking), ...)
  report.check("approved vs findings", not (approved and unmet), ...)
  report.check("rejection names a problem", approved or bool(blocking or unmet), ...)
  ```
  Its docstring is the transferable idea: *"an approval that ships blocking items, or a rejection
  that names no problem, is a claim the harness can refute without reading a line of the diff."*
- `adws/adw_simple_sdlc.py:122` — `if review.approved or i == MAX_REVISION_LOOPS: break`
- `adws/adw_simple_sdlc.py:144-147` — the commit phase is guarded by
  `phases_ok and suite_green and review is not None and review.approved`, described as
  *"Land the code only now: green suite, approved review"*.
- `adws/adw_build_review.py:66-67` — `run.finish(accepted=review is not None and review.approved,
  reason=f"the reviewer never approved after {MAX_REVISION_LOOPS} revision(s)")`

**Verdict: CONCEPT ONLY.** Three ideas are worth carrying into DF3.4's decision record, none of
them as code:

1. **A decision record must refute itself.** `verdict_consistent` is a self-consistency check on a
   decision object. DF3.4's approval record should carry the same property: an `approved:true`
   record that also names blockers is malformed and must be rejected at write time, not trusted.
2. **Success must be earned.** `adws/adw_modules/runner.py:88-105` — every phase defaults to `fail`
   and only a clean exit flips it. `runner.py:114-142` (`finish`) explicitly separates "every phase
   passed" from "the run's acceptance criterion held", with a long docstring about a bug where a
   `succeeded` **property with side effects** wrote the DB status and printed the banner before the
   caller's `and test.passed` was evaluated — the trace read green while the exit code was 1.
   Directly relevant to DF3.4: the approval-gate decision must be settled in one call that fixes the
   record, the console output, and the exit code together, so the three cannot disagree.
3. **A killed run still closes its own record.** `adws/adw_modules/session.py:21-35`
   (`_finalize_when_killed`) installs SIGTERM/SIGINT handlers that convert the signal to
   `SystemExit` so the trace is finalized instead of left reading `running` forever. If `fleet
   attach` holds an open steering session, the same reasoning applies — a Ctrl-C on the attach
   process must not leave a pending-approval record reading `awaiting`.

---

## A2. Approver allowlist / operator authentication / token-hash

**Finding: nothing. There is no notion of an operator identity anywhere in these repos.**

The one allowlist-shaped module is `adws/adw_modules/permissions.py` (256 LoC), and it allowlists
**paths an agent may write**, not **people who may approve**. It is worth reading anyway — it is the
best-written file in the reference set:

- `permissions.py:65-83` — `snapshot(run)` fingerprints every path the working tree differs on
  (`git diff HEAD --numstat` + `git ls-files --others --exclude-standard`).
- `permissions.py:86-89` — `changed_paths(before, after)` = every path whose fingerprint differs.
  The docstring explains why comparing change-sets (rather than watching writes) is what catches a
  rogue `git checkout adws/`: *"a path that was modified before the agent ran and is clean
  afterwards has been reverted, and a reversion is a modification."*
- `permissions.py:92-114` — `_glob()`, a hand-rolled translator where `*` stops at `/` and `**`
  crosses directories, written *because* `fnmatch` silently widens every pattern.
- `permissions.py:142-150` — `permitted(path, agent, cfg)`: session runtime first, then the agent's
  own list, then what is protected. `None` = unrestricted, `[]` = read-only, `[...]` = only these.
- `permissions.py:220-256` — `enforce()` rolls back what it can and only raises `PermissionBreach`
  for what it cannot (`RECOVERED = {"deleted", "rolled back", "restored"}`, `RECOVERED_LIMIT = 3`).

The **hash-as-revocation-handle** idea does appear, but for API keys, not approvers:
`.claude/skills/sssf-sandbox-orchestrator/references/run_record.md:29` — field 4 `key_hash`,
*"Without it the key is **unrevokable**. This is the revocation handle — not the key."* and the
secret is held in a sibling `0600` file (`run_record.md` "The secret is NOT in the JSON"), never in
the greppable JSON.

**Verdict: NOT APPLICABLE** for the approver allowlist itself. The `_glob` translator is
LIFTABLE WITH ADAPTATION *if* DF3.4 ever needs pattern-matched approver identities (it almost
certainly should not — an approvers.json is an exact-match list). The `key_hash` /
secret-in-a-sibling-0600-file split is **already implemented** in QDS-Factory
(`src/providers/run-record.ts`, `src/providers/credentials.ts`) — this repo is where it came from,
so there is nothing left to lift.

---

## A3. Mid-run STEERING of an agent

**Finding: no message injection, no inbox/outbox, no NDJSON message queue, no ack protocol, no
dedupe-by-message-id. None of it exists.**

What does exist is a **synchronous, in-process correction loop** — the agent finishes its turn, the
harness judges the envelope, and the correction is sent as the *next* prompt on the *same* session:

- `adws/adw_modules/agents.py:112-138` — the `send()` closure builds a `PiRequest` carrying a stable
  `session_id`; every send in the phase reuses it.
- `adws/adw_modules/agents.py:151-177` — the gate-correction loop. On violations:
  ```python
  correction = ("Your previous response failed validation:\n- "
                + "\n- ".join(violations)
                + "\n\nFix these problems, then re-emit ONLY your Report JSON.")
  result = send(correction)
  ```
  With the header comment at `agents.py:106-108`: *"Parse retries and gate corrections re-enter the
  SAME pi session, so the last send is the one whose context occupancy is current — while spend is
  the opposite: every send costs, so usage accumulates across all of them."*
- `adws/adw_modules/agents.py:233-236` — `_agent_session_id()`:
  ```python
  entry = run.agent_map.get(agent.name)
  if entry and entry.get("model") == agent.model:
      return entry["session_id"]           # rejoin the existing context window
  return f"sssf-{run.adw_id}-{agent.name}-{new_id(4)}"
  ```
  Session ids are persisted to `<session_dir>/agent_map.json` (`runner.py:56-63`) so a *later
  process* can rejoin the same context window. This is a **resume** primitive, not an **attach**
  primitive: it works between turns, never during one.
- `adws/adw_modules/agent_cc.py:5` documents the Claude Code equivalent
  (`claude -p --output-format stream-json --resume <session_id>`); the module is a stub.
- `adws/adw_modules/agent_pi.py:257` — `"--session-id", request.session_id` in the pi argv.

NDJSON is present but **outbound only**: `agent_pi.py` reads pi's stdout event stream, and
`adw_modules/tracer.py:4` states *"No push transport — the flow is always: agents -> sqlite -> web
ui."* There is no inbound channel of any kind.

**Verdict: CONCEPT ONLY, and a weak one.** The transferable point is negative and worth stating in
the DF3.4 spec: this factory deliberately steers **between turns via a resumed session id**, never
mid-turn. If DF3.4's `fleet attach` needs true mid-run injection, there is no prior art here to lean
on and the design is net-new. QDS-Factory's own `src/fleet/resident.ts` (DF3.3) is far closer to the
target than anything in these repos.

---

## A4. State-machine / decision-record patterns

The strongest section for DF3.4, but almost all of it is **already in QDS-Factory** — it was lifted
in earlier stories.

- `.claude/skills/sssf-sandbox-orchestrator/references/run_record.md` — a 12-field **closed schema**
  at `.sandbox/runs/<run-id>.json`. Load-bearing rules, all of which QDS-Factory's
  `src/providers/run-record.ts` already implements:
  - **Closed schema**: *"a typo in a `set` would be silent data loss — unknown keys are rejected
    rather than written."*
  - **Immutable identity fields**: `run_id` and `created_at`; `set` refuses them.
  - **A terminal state expressed as a nullable timestamp**: field 12, `closed_at` —
    *"**Non-null means the key is revoked.** This is what distinguishes a live run from an orphan."*
  - **`O_EXCL` at 0600 on create**: *"overwriting a live record orphans that run's key, and the
    check-then-write window is exactly when a retrying phase would land."*
  - **Atomic updates**: `tmp` + `os.replace`, *"so a crash mid-write leaves the old record, not half
    of one."*
  - **Per-field coercion, not "try JSON first"**: `ports` → JSON, `pid` → int, `limit`/`spend` →
    float, everything else stays a string, *"`5734129` is a string that happens to parse as a
    number."*
- Orphan/expiry sweeping lives in `.claude/skills/sssf-sandbox-orchestrator/cookbooks/
  teardown_and_reap.md` — again already realized in QDS-Factory (`tests/fleet/e2e/tier3-reaper.live.test.ts`,
  the DF3-era orphan-expiry work).
- **Idempotent first-decision-wins**: does **not** exist in these repos in any form. The closest
  primitive is `O_EXCL`-on-create, which is a *creation* race guard, not a *decision* race guard.

**Verdict: NOT APPLICABLE (already lifted).** The record patterns above are the ancestors of
`src/providers/run-record.ts`; re-lifting them would be re-implementing what DF3.4 will import. The
one idea DF3.4 should *deliberately* borrow the shape of, and which is NOT present upstream, is
first-decision-wins — the natural expression of it in this lineage is the same `O_EXCL` trick
applied to the decision file rather than the record file (an approval and a rejection racing to
`link()` the same decision path; the loser reads back the winner's verdict and reports it rather
than overwriting).

---

## A5. The `adws/` modules, one line each

Support modules (`adws/adw_modules/`), by size:

| Module | LoC | What it does | DF3.4 relevance |
|---|---:|---|---|
| `data_types.py` | 447 | Every pydantic model: envelopes, `AgentConfig`, `SSSFConfig`, `Phase`, `GateReport`. `ReviewOutput.approved` at :118. | Low — shape reference only |
| `agent_pi.py` | 321 | Spawns the pi coding agent, parses its NDJSON stdout, extracts usage from `message_end` only. | **Medium** — same NDJSON-from-pi problem DF3.3 solved in TS |
| `agents.py` | 313 | Config load/validate + `execute()`: prompt render → send → parse-retry → gate loop → permission enforce → envelope persist. | **Medium** — the gate/correction loop shape |
| `tracer.py` | 271 | Every event to JSONL **and** SQLite as it happens; no push transport. | Low — QDS has journals |
| `permissions.py` | 256 | Post-hoc write-allowlist enforcement by working-tree diff, with rollback. | **Medium** — best-written file here; concept only |
| `quality.py` | 246 | Deterministic lint/typecheck/build blocks for the demo app. | None |
| `runner.py` | 142 | The `Run` object + the one `phase()` context manager; `finish()` reconciles DB/banner/exit. | **Medium** — the "success must be earned" + one-call-settles-three-things idea |
| `console.py` | 131 | One narrative, two destinations (terminal + tracer). | None |
| `git_helper.py` | 120 | `_git()` wrapper: branch, commit_all, merge_base, diff_{files,stat,counts,text}. **No push, no PR.** | Low |
| `gates.py` | 108 | `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`, `verdict_consistent`, `tests_pass(cmd)` factory. | **High (concept)** — `verdict_consistent` |
| `changes.py` | 103 | Composes git diff plumbing into a `ChangeSet` for the documenter. | None |
| `utils.py` | 77 | `new_id`, `now_iso`, `ensure_dir`, `engineer_name`. | None |
| `session.py` | 50 | `ensure(cfg, adw_id)` pin-or-create + SIGTERM/SIGINT finalization. | **Medium** — signal finalization |
| `prompts.py` | 21 | `{{placeholder}}` substitution into system/user prompt files. | None |
| `agent_cc.py` | 15 | Claude Code interface — **a stub**. Documents `--resume <session_id>`. | None |

Workflow entrypoints (`adws/adw_*.py`), one line each:

| Script | LoC | One-liner |
|---|---:|---|
| `adw_prompt.py` | 44 | The smallest ADW: one agent, one prompt, traced end-to-end |
| `adw_build.py` | 45 | One-shot implementation |
| `adw_plan.py` | 45 | One-shot planning |
| `adw_scout.py` | 45 | Read-only recon |
| `adw_quality.py` | 49 | Lint, typecheck, build |
| `adw_plan_build.py` | 55 | planner → envelope → builder |
| `adw_build_review.py` | 76 | Implement, then confirm it is what was asked for (bounded revision loop) |
| `adw_document.py` | 76 | Write up the work just done, from the diff |
| `adw_build_test.py` | 79 | Implement, then verify; failures flow back into the builder |
| `adw_plan_build_test.py` | 86 | The full starter chain |
| `adw_plan_build_test_quality.py` | 98 | Full agent chain plus deterministic quality |
| `adw_simple_sdlc.py` | 183 | plan → build → test → review → document, three commits, three authors |

**None of the twelve has an approval phase, a human phase, or a PR phase.**

---

## A6. PR-creation gating: what stands between a green run and an opened PR?

**Nothing, because they never open a PR.** Grep for `gh pr`, `pull request`, `create_pr` across
`adws/**` and every skill bundle: zero hits in code. `git_helper.py` exposes
`create_branch`/`commit_all` and no push.

This is a stated design decision, not an omission. `.claude/skills/sssf-sandbox-orchestrator/
references/phases.md:154-155`:

> OpenRouter runtime key — no PAT, no deploy key, no ssh identity, nothing that could push. That is
> the point: the box runs an autonomous agent under `--dangerously-skip-permissions`, and a push [...]

and `phases.md:165`, the "Bundle over push" trade-off row:

> a push is durable the instant the ADW commits, which a bundle is not — but the gap closes once you
> harvest on completion. Not worth a GitHub App, a private key, JWT signing and a ruleset. The
> branch naming is the only expensive-to-change decision and `sbx/<run-id>` is correct under both,
> so this does not foreclose pushing later

Their answer to "what stands between a green run and an opened PR" is: **the sandbox has no
credential capable of pushing.** The work comes home as a git bundle harvested to the host, and a
human does whatever they want with it locally.

**Verdict: NOT APPLICABLE, but strategically informative.** It is the strongest architectural
statement in the reference set and it is the *opposite* of DF3.4's premise. DF3.4 is building the
gate that upstream avoided needing by removing the capability. Worth one sentence in the story spec:
we are choosing capability + gate over no-capability, so the gate is now load-bearing in a way it
never was upstream, and `approvers.json` + the decision record are the entire security surface.

---

## A7. Part A summary verdict

**Little is liftable. Here is why:**

1. Wrong language: `adws/` is Python, DF3.4 is TypeScript/Bun. Zero verbatim lift is possible.
2. Wrong problem: the reference factory has **no human in the loop at all** — every "approval" is
   one model judging another model's envelope.
3. Wrong problem again: it has **no steering channel** — corrections are the next prompt on a
   resumed session, sent after the turn ends.
4. Wrong problem a third time: it **never opens a PR**, by design, and solves the safety question by
   withholding push credentials rather than by gating.
5. The parts that *are* DF3.4-adjacent (closed-schema run records, `key_hash` as revocation handle,
   atomic `tmp`+rename writes, `O_EXCL` create, orphan sweeping) were **already lifted into
   QDS-Factory in earlier DF stories**. Re-mining them yields nothing new.

**Net: zero LIFTABLE VERBATIM. One LIFTABLE WITH ADAPTATION (marginal, probably skip). Four CONCEPT
ONLY.** The concepts worth a line each in the DF3.4 spec:

- `gates.py:71-95` `verdict_consistent` — a decision record must be refutable against itself.
- `runner.py:114-142` `finish` — one call settles the record, the console, and the exit code, so
  they cannot disagree.
- `session.py:21-35` `_finalize_when_killed` — a killed attach must still close its own state.
- `run_record.md` field 12 — a terminal state is best expressed as a nullable timestamp whose
  non-null-ness *is* the invariant.

**Do not budget DF3.4 as a port. Budget it as net-new TypeScript that borrows four sentences of
design reasoning.**

---

# PART B — QDS-Factory test conventions

## B7. `tests/fleet/helpers.ts` — every export

File is 192 lines. **`rejection()` and `refusalLines` are NOT in it** — see the corrections below.

```ts
export interface AdmitCall { input: AdmissionInput; capMicroUsd: number; keyCapMicroUsd: number }
export interface RecordingLedger extends LedgerLike { readonly admitCalls: AdmitCall[]; closeCalls: number }
export interface BudgetSnapshot { ceilingMicroUsd: number; spentMicroUsd: number; reservedMicroUsd: number }

export function goodLedger(
  ceilingMicroUsd?: number,           // default: defaultKeyCapMicroUsd
  capMicroUsd?: number,               // default: ceilingMicroUsd
  budgetSnapshot?: BudgetSnapshot,
): RecordingLedger

export function overBudgetLedger(): RecordingLedger
export function admitThrowsLedger(): RecordingLedger
export function closeThrowsLedger(): RecordingLedger

export const ADMIT_THROW_MESSAGE = "ledger admitIssue failed"
export const CLOSE_THROW_MESSAGE = "ledger close failed"

export async function deadPid(): Promise<number>       // spawns `true`, polls isAlive up to 2s
export function liveChild(): Bun.Subprocess            // `sleep 30`, caller kills on teardown
```

Private (not exported): `function recordingLedger(defaultCapMicroUsd, decide)`.

House details worth copying:
- `admitCalls.push({ input: structuredClone(input), ... })` (`helpers.ts:60`) — snapshot, never the
  live reference, so a caller that mutates its argument afterwards cannot make a wrong call read as
  right.
- `deadPid()` polls `isAlive` (imported from `scripts/lib/run-lock.ts`) 100×20 ms after
  `proc.exited` resolves and **throws** if the pid is still alive at 2 s, calling that a test
  infrastructure bug rather than tolerating a TOCTOU flake.

### Correction 1 — `rejection()` lives in `tests/helpers.ts`, not `tests/fleet/helpers.ts`

`tests/fleet/helpers.ts:150-153` is a tombstone comment recording the move. The real definition is
`/Users/steve/QDS-Factory/tests/helpers.ts`:

```ts
export async function rejection(work: Promise<unknown>): Promise<Error>
export function liveForeignPid(): { pid: number; stop: () => void }
```

The hardening the task description refers to is real and is at `tests/helpers.ts:43-47`:

```ts
if (!(settled.raw instanceof Error)) {
  throw new Error(
    `expected a rejection with an Error, got ${typeof settled.raw}: ${Bun.inspect(settled.raw)}`,
  );
}
```

Two reasons documented in its header, both load-bearing for DF3.4 tests:
- It is **not** `await expect(p).rejects.toThrow(…)`: bun's `rejects` matcher returns `undefined`,
  so the `await` yields a single microtask tick and lets the work under test race whatever the test
  asserts next — typically reading back the record the failed call was supposed to leave behind.
  **DF3.4 will assert exactly that shape** ("the refused approval left no decision file"), so use
  `rejection()`.
- `tests/helpers.ts` imports **nothing from `src/`** on purpose. `tests/fleet/helpers.ts`
  value-imports `defaultKeyCapMicroUsd` from `src/providers/credentials.ts`, which drags
  `credentials.ts` → `swarmclaw/log.ts` → `step-log.ts` into module load for every suite that
  touches the file. Keep new cross-layer helpers in `tests/helpers.ts`.

### Correction 2 — `refusalLines` is a local, not a shared helper

It is a **file-local function inside `tests/fleet/dispatch.test.ts:270`**, not exported from
anywhere:

```ts
function refusalLines(): LogEntry[] { … }
```

Used 15× within that one file (`:286, :733, :1748, :2242, :2477, :2615, :2683, :2760, :3093, :3918,
:4181, :4956` …). The DF3.4-relevant sibling is `refusal()` in **`tests/fleet/verbs.test.ts:75-88`**
— also file-local — which is the pattern to copy for a new refusal assertion:

```ts
async function refusal(
  work: Promise<unknown>,
  exitCode: FleetError["exitCode"],
  code: string,
): Promise<FleetError> {
  const err = await rejection(work);
  expect(err).toBeInstanceOf(FleetError);
  const typed = err as FleetError;
  expect(typed.exitCode).toBe(exitCode);
  expect(typed.code).toBe(code);
  return typed;
}
```

Its docblock explains the layering rule: everything above the type narrowing belongs in
`rejection()`; this keeps only the `FleetError` columns.

---

## B8. House style — `resident.test.ts` and `verbs.test.ts`

### Imports

```ts
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
```

- **`test`, never `it`.** Zero `it(` in the fleet suite.
- `bun:test` first, then `node:fs` / `node:os` / `node:path` (named imports, alphabetized within the
  braces), then `src/` and `scripts/` imports, then test-local fixtures.
- **Every import carries the `.ts` extension** (`"../../src/fleet/resident.ts"`).
- `type` imports are inlined into the value import (`import { run, type FleetDeps } from …`).
- Import from the **one owner**, never a re-export barrel. `verbs.test.ts:30-32` documents why:
  `FleetError` comes from `src/fleet/dispatch.ts` because `status.ts` stopped re-exporting it — a
  duplicate star export through the barrel breaks the day `status.ts` declares its own class of that
  name.
- **Constants are IMPORTED from source, never mirrored** (`resident.test.ts:6-7`). This is stated as
  a rule in the file header. `verbs.test.ts` goes further: `LOCK_HOST` is *derived at module load*
  by acquiring a real lock in a tmpdir, reading the host token back out, and releasing it
  (`verbs.test.ts:100-107`), because a hand-written token that drifts from the source collapses two
  distinct branches into one that says nothing.

### File header

Every file opens with a block comment naming the story, the module(s) under test, and an enumerated
list of what is covered — plus the load-bearing *why* for any non-obvious fixture choice. See
`resident.test.ts:1-9`, `verbs.test.ts:1-23`, `cli.test.ts:1-25`. `cli.test.ts:19-24` even records a
POSIX precondition (hard links, mode bits, SIGKILL-able children) so a red run on FUSE/SMB/Windows
is read as environmental rather than as a regression.

### `describe` / `test` shape

`describe` strings **name the acceptance criterion**, not the function:

```ts
describe("AC4 — empty brief disables the resident before any spawn", () => {
  test.each([null, undefined, {}, ""])("brief %j → {disabled:true}, zero spawn attempts", (empty) => { … });
  test("whitespace-only string brief disables; a non-empty string spawns", async () => { … });
});
```

- `test.each([...])("… %j …", (x) => …)` for table cases.
- Test names assert an outcome (`→ {disabled:true}, zero spawn attempts`), not a behaviour label.
- Inline comments justify the *negative* half of an assertion (`resident.test.ts:111-113`: rate
  sources deliberately unusable so the disabled check must fire FIRST).

### Temp dirs

Two shapes coexist; pick by scope.

**Module-scoped root + per-case subdirs** (`resident.test.ts:33-35, 91-93`):

```ts
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-3-resident-")));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function caseDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpRoot, `${name}-`)));
}
```

`realpathSync` around `mkdtempSync` is mandatory on macOS (`/var` → `/private/var`); a path compared
without it fails on the symlink, not the logic.

**Per-test dir in `beforeEach` / `afterEach`** (`verbs.test.ts:521-539`, `cli.test.ts`, the majority):

```ts
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "qds-verb-exit-")); … });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
```

Prefix convention: `qds-<area>-<what>-` for per-test dirs, `df<story>-<module>-` for module roots.

### Records dir

Never the repo's `.sandbox/`. Always constructed under the case tmpdir:

```ts
driver = new FakeDriver(join(dir, "boxes"));
store  = new RunRecordStore({ dir: join(dir, "runs") });
```

Fixtures provision through **`provisionAdmittedRun`** (`src/providers/driver.ts`) — the production
sequence that names the box after the run id and writes `vmName` back — *"so no test recomputes a
box-naming formula the factory does not use"* (`verbs.test.ts:20-22`).

### Env isolation

**Save → override → restore, always in `afterEach`** (`verbs.test.ts:518-539`):

```ts
let savedDirs: Record<string, string | undefined>;
beforeEach(() => {
  savedDirs = {
    QDS_RUNS_DIR: process.env.QDS_RUNS_DIR,
    QDS_FANOUTS_DIR: process.env.QDS_FANOUTS_DIR,
  };
  process.env.QDS_RUNS_DIR = join(dir, "sandbox-runs");
  process.env.QDS_FANOUTS_DIR = join(dir, "fanouts");
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedDirs)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});
```

Two gotchas the suite has already paid for:

1. **`process.env.X = undefined` stores the string `"undefined"` under Bun and stays truthy.** You
   must `delete`. `resident.test.ts:103-108` carries the biome suppression for it:
   ```ts
   // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
   delete process.env.QDS_RESIDENT_TIMEOUT_MS;
   ```
2. **Scrub the developer's shell out of any child env.** `resident.test.ts:75-86` `piEnv()` strips
   `/^(QDS_FAKE_PI_|FAKE_RESIDENT_)/` plus `QDS_RESIDENT_TIMEOUT_MS` and `QDS_PI_BIN` from
   `process.env` *before* the spread, so a shell `QDS_RESIDENT_TIMEOUT_MS=1` cannot flake every
   spawn-bound test.

Module-level seams are reset in hooks too: `_injectRateSources(TEST_SOURCES)` in `beforeEach`,
`_injectRateSources(null)` in `afterEach` (`resident.test.ts:98-102`).

### Standing up a fake driver box

```ts
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { goodLedger } from "./helpers.ts";

const driver = new FakeDriver(join(dir, "boxes"));   // state on disk under the case tmpdir
const store  = new RunRecordStore({ dir: join(dir, "runs") });
```

To vary only the ownership evidence while keeping provisioning real, wrap rather than replace —
`verbs.test.ts:118-127` `retagged(driver, tag)` maps `driver.list()`'s output and strips/rewrites
`tag`.

### Standing up a fake pi

An **argv-compatible executable fixture**, spawned as the bin (shebang + `chmodSync(fakePi, 0o755)`
in `beforeEach`), driven entirely by env:
`tests/fleet/fixtures/fake-pi-resident.ts` (113 lines). Modes via `QDS_FAKE_PI_MODE`:
`ok` | `hang` | `fail` | `garbage` | `flood` | `stderr-secret`. It writes
`{argv, env.OPENROUTER_API_KEY, promptPrePersisted}` to `QDS_FAKE_PI_RECORD` on start, which is how
tests assert both the argv contract and "zero spawn attempts" (assert the record file does **not**
exist). The `ok` mode emits **decoy** `message_start`/`message_update`/`toolResult` events carrying
usage 9999 before the one real `message_end`, so a harvest that reads anything but `message_end` is
caught (INV-COST-3).

### Invoking a CLI verb — in-process (the default)

`scripts/fleet.ts` exports `run` with an injectable deps object and **two separate sinks**:

```ts
export async function run(
  argv: readonly string[],
  out: (s: string) => void,
  deps?: Partial<FleetDeps>,
  err: (s: string) => void = out,   // defaults to `out`; import.meta.main binds it to stderr
): Promise<number>
```

House wrapper (`verbs.test.ts:541-560`), and the reason it exists:

```ts
async function invoke(argv: string[], deps: Partial<FleetDeps>):
  Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const code = await run(argv, (s) => void outChunks.push(s), deps, (s) => void errChunks.push(s));
  return { code, out: outChunks.join(""), err: errChunks.join("") };
}
```

> Passing `() => {}` for each threw away the only evidence that "exits 2 naming the offending field"
> is anything more than an exit code: a refactor that returned the right code and printed nothing,
> or printed the envelope onto stdout — poisoning the JSON lines a caller pipes `fleet status` into
> — was indistinguishable.

`cli.test.ts` uses the same idea under the name `runCli`. **Always capture both streams.**

### Invoking a CLI verb — as a subprocess (only when the process boundary IS the claim)

`cli.test.ts:1456-1460, 1499-1520` — reserved for stdin plumbing, TTY/pipe semantics, signal
handling, and real-fd behaviour:

```ts
const fleetPath = join(import.meta.dir, "../../scripts/fleet.ts");
const proc = Bun.spawn(["bun", fleetPath, "dispatch", "--driver", "fake"], {
  cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
```

`cli.test.ts:1285-1320` documents at length why `Bun.spawn({stdin: "pipe"})` gives a **socket**, not
a pipe, and wraps a `sh -c` variant when a real pipe is required. `Bun.spawnSync` is used for git
plumbing inside fixtures (`cli.test.ts:1930`), always with `-c commit.gpgsign=false -c
tag.gpgsign=false`.

**Rule of thumb for DF3.4:** an approval gate's refusal envelopes, exit codes and decision-record
side effects are all in-process claims — use `invoke`/`run`. Only reach for `Bun.spawn` if
`fleet attach`'s steering transport genuinely needs a second process (it probably does, for the
attach side).

---

## B9. `tests/fleet/fixtures/` — current inventory

**One file only:**

| File | LoC | Shape |
|---|---:|---|
| `tests/fleet/fixtures/fake-pi-resident.ts` | 113 | Executable (shebang `#!/usr/bin/env bun`, chmod 0755 by the suite). Env-driven mode switch, writes a JSON record on start, emits NDJSON on stdout. Consumed by `resident.test.ts` via `bin: fakePi`. |

DF3.4's `tests/fleet/fixtures/approvers.json` will be the **first data fixture** in this directory —
everything here so far is executable. Nearby precedent for data fixtures:

- `tests/providers/fixtures/` — `df2-4-demo.roster.yaml`, `df2-4-models.json`, `loopy-workload.yaml`
  (data) alongside `fake-key-api.ts`, `fleet-state.ts`, `git-fixture.ts`, `leak-scan.ts`,
  `recording-driver.ts` (code). Note `loopy-workload.test.ts` also sits in there.
- `tests/phase-engine/fixtures/` — `dispatch-roster.yaml`, `dispatch-task-ndjson.jsonl`,
  `pipeline.qds-factory.json`, `pipeline.resident.json`, `review-envelopes.json`, `pi-catalog/`,
  plus `fake-resident.ts`, `test-command-output.ts`.

Convention observed: data fixtures are named `<story>-<subject>.<ext>` or plain `<subject>.<ext>`;
JSON data fixtures (`review-envelopes.json`, `df2-4-models.json`) are read with
`readFileSync(join(import.meta.dir, "fixtures", "…"), "utf8")` and `JSON.parse`d in the test, never
imported. Do the same for `approvers.json` — importing it would let bun's module cache share one
mutable object across suites.

---

## B10. `tests/fleet/e2e/` and live gating

14 `*.live.test.ts` files (4343 LoC incl. harness) + `live-harness.ts` (373 LoC).

`live-harness.ts` exports:

```ts
export const REPO_ROOT      // resolve(import.meta.dir, "../../..")
export const EVIDENCE_DIR   // <root>/_bmad-output/evidence/df3-e2e
export function liveGate(tier: "1" | "2"): void      // THROWS on a half-configured env
export function liveTodoOff(): boolean
export interface LiveCtx
export async function preflight(tier: "1" | "2" = "1"): Promise<LiveCtx>
export function runIdFor(label: string): string
export function writeEvidence(name: string, payload: Record<string, unknown>): string  // scrubs
export interface RunFleetResult
export async function runFleet(...)
export interface SpawnedFleet
export function spawnFleet(...)
export async function scratchClone(repoUrl: string, sha: string, parentDir: string): Promise<string>
export async function mintCappedKey(...)
export async function listedKeyHashes(): Promise<Set<string>>
export function ledgerRows<T>(recordsDir: string, sql: string, ...params: (string|number)[]): T[]
export async function destroyQuietly(driver: ExeDevDriver, vm: string, evidence: Record<string, unknown>[]): Promise<void>
export async function revokeQuietly(...)
export function tmpWorkspace(label: string): string
```

Private: `scrubText`, `scrubDeep` (used by `writeEvidence`, which self-fails if any `sk-or-`
survives).

**Gating:** every live test is `test.todoIf(!process.env.QDS_E2E_LIVE)`, so a plain `bun test` pays
nothing. `liveGate(tier)` **throws** rather than skips on a half-configured env — a hollow live-fire
is a bug, not a skip.

### `qds-live-e2e` skill — operating procedure (≤15 lines)

1. Live rounds prove the real substrate: real `ssh exe.dev` boxes, real OpenRouter keys with µ$ caps.
2. **No fakes in a `*.live.test.ts`** — any `FakeDriver`/`FakeKeyApi`/fake-pi import there is a bug.
3. **Spend protocol:** before any TIER ≥ 2, print worst-case (keys × cap + box-hours) and get an
   explicit operator "go". Default cap 50 000 µ$/key.
4. Every key minted is revoked in `finally`; every box destroyed in `finally`; assert `final-ls`
   shows zero `e2e-*`/`qds-*` boxes.
5. `OPENROUTER_PROVISIONING_KEY` lives in the repo-root `.env` — bun auto-loads it **from repo cwd
   only**. Never print key values; evidence goes through `writeEvidence()`'s scrub.
6. **Never** run the full `bun test` suite in parallel with live tiers, or before a live fanout test.
7. Env contract: `QDS_E2E_LIVE=1`, `QDS_E2E_TIER=1|2`, `QDS_EXEDEV_REPO_URL`,
   `QDS_EXEDEV_SHA=$(git rev-parse HEAD)` (**must be pushed**), `QDS_EXEDEV_ROSTER=…`.
8. Then: `bun test tests/fleet/e2e/<tier-file>.live.test.ts`.
9. Tiers: 1 = boxes only, 0 spend · 2 = + real model calls (~50k µ$/key) · 3 = patterns/reaper/remote
   phases · 4 = resident orchestrator (~$0.10 worst).
10. Run order within a round: free things first (tsc, biome, gated-off load check), then TIER-1, then
    paid tiers sequentially.
11. Evidence: one redacted JSON per run into `_bmad-output/evidence/df3-e2e/`, written PASS **or**
    FAIL from `finally`. Report per-test PROVEN/BROKEN with verbatim failures.
12. Exit codes are a table, not 0-or-bad: teardown 0 = success, **6 = `harvest_waived` success**,
    5 = lock refusal, 4 = no-record, 2 = validation refusal.
13. Known environmental traps: repo-cwd fleet lock leaked by the full suite (#138 — check
    `.sandbox/fleet.lock`, `rm` if the holder pid is dead); host pi auth shadowing via
    `~/.pi/agent/auth.json` (spawn under isolated `HOME`); `QDS_PI_CATALOG_DIR` needed on
    global-npm hosts (#140); shell cwd drift.
14. Triage a failure: read the evidence JSON first → classify (product regression / test defect /
    environment) → rerun a suspected flake once in isolation → fix test defects citing the source.
15. Done = every tier green on the final SHA, full `bun test` clean with nothing else running, no
    leaked boxes, no unrevoked key hashes, spend recorded and within caps.

---

## B11. Gate commands (verified on this branch, 2026-08-28)

**All three must run with `/Users/steve/QDS-Factory` as cwd.** `bunx`, `bun test` and
`scripts/fleet.ts` all resolve relative paths **and `.env`** from the current cwd; a stray `cd`
produces `Module not found "scripts/fleet.ts"` or a silently missing provisioning key
(qds-live-e2e gotcha #1).

```bash
cd /Users/steve/QDS-Factory

# tests — whole suite
bun test

# tests — one file (see note)
bun test ./tests/fleet/verbs.test.ts

# typecheck (strict + noUncheckedIndexedAccess; root tsconfig)
bunx tsc --noEmit

# lint (biome 1.9.4, linter only — formatter is disabled in biome.json)
bunx @biomejs/biome check .
# single file / touched files:
bunx @biomejs/biome check tests/fleet/helpers.ts src/fleet/approval.ts
```

`package.json` scripts wrapping these:

```json
"test":      "bun test",
"typecheck": "bunx tsc --noEmit",
"lint":      "bunx @biomejs/biome check src scripts tests cli-anything pi-vs-claude-code-vendor visualizer oci 2>/dev/null || bunx @biomejs/biome check ."
```

`biome.json` — formatter **disabled**, `organizeImports` **disabled**, ignores `node_modules`,
`_bmad-output`, `.gitnexus`, `.claude`, `.swarm`, `docs`, `visualizer/**/*.vue`. Rules:
`recommended: true` with `suspicious.noExplicitAny: off` and `style.noNonNullAssertion: off`.

### Note on the `./` prefix — measured, not assumed

I ran both forms on this branch (bun 1.4.0):

```
bun test tests/fleet/fleet-lock.test.ts    → 7 pass, 0 fail, 1 file
bun test ./tests/fleet/fleet-lock.test.ts  → 7 pass, 0 fail, 1 file
```

Both worked here. `bun test`'s positional args are **filter patterns** matched against test file
paths, not declared file arguments — a bare `tests/fleet/verbs.test.ts` happens to match exactly one
file, so it behaves as a path by coincidence of the pattern. The `./` prefix is still the form to
write: it is unambiguous, it is what the repo's own docs and the qds-live-e2e skill use, and a bare
argument that matches zero or several files fails in a way ("Ran 0 tests") that is easy to misread as
a green run.

### Must not be excluded

`CLAUDE.md` (Upgrading the gitnexus CLI): `tests/gitnexus/` runs under plain `bun test` and must
**never** be excluded from a gate — `tests/gitnexus/contract.test.ts` is the drift alarm and
excluding it disarms it.

### Pre-commit

Per `CLAUDE.md`: run `impact({target, direction:"upstream"})` before editing any symbol and
`detect_changes()` before committing (`detect_changes({scope:"compare", base_ref:"main"})` for
regression review).

### Branch convention

`prefix=feature/ base=dev target=dev`. As of 2026-08-28 `dev` is the integration base — **all**
feature/fix PRs merge into `dev`; `dev` → `main` is a periodic promote/sync PR only.

---

## B12. `tests/reverify/approval.test.ts` — read in full (335 lines)

The closest existing analogue to DF3.4's state machine. Its header states the
relationship outright:

> *"DF5.1 is the SINGLE OWNER of the `requestApproval` caller. The port is the seam
> **DF3.4 lands behind**; the state machine asserted here is the caller-side contract
> that must hold whichever adapter is plugged in."*

Mirrored in `src/reverify/approval.ts:1-13`: *"Deciding that approval — the `fleet
approve` / `fleet reject` intake, the approver allowlist, teardown-at-pause — is
DF3.4's and lives behind this port… When DF3.4 lands its own implementation it
replaces the ADAPTER, not the caller."*

### Setup idiom — a factory + `try`/`finally`, NOT `beforeEach`

This suite is the one exception to the `beforeEach`/`afterEach` house pattern in B8.
There is **no `beforeEach`, no `afterEach`, and no env var touched anywhere** — the
store takes its dir by constructor arg, so there is nothing to isolate.

```ts
import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";        // NOTE: namespace form, not the fleet suites' named imports
import * as os from "node:os";
import * as path from "node:path";

function store(): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rv-runs-"));
  return {
    dir,
    store: new RunRecordStore({ dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const req = (reportId: string, headSha = "a".repeat(40)) => ({
  proposal: "open a PR for run-1", reportId, headSha,
});
```

Every test body is `const s = store(); try { … } finally { s.cleanup(); }`. Records
are built through the **real store** (`s.store.create("run-1")`, then
`s.store.set("run-1", { extensions: { approval: {…} } })`) — never by writing JSON by
hand. Sha fixtures are `"a".repeat(40)` / `"b".repeat(40)` / `"c".repeat(40)`.
The namespace-import form (`fs.readFileSync`) is required here because four tests
`spyOn(fs, "…")`, which cannot intercept a destructured named import.

### Every behavior it pins — DF3.4 must not break any of these

`describe("recordApprovalPort")` — the four-outcome re-entry matrix:

| # | Test (line) | Pinned |
|---|---|---|
| 1 | first green verdict registers an awaiting-approval record (33) | `outcome === "requested"`; `extensions.approval.state === "awaiting-approval"`; `.reportId === "rv-1"`. |
| 2 | a second green verdict **REBINDS**, creating no second one (49) | `out` **`toEqual`** `{ outcome: "rebound", supersededReportId: "rv-1" }` — exact, no extra keys. Record: state stays `awaiting-approval`, `reportId` → `"rv-2"`, `headSha` → `"b".repeat(40)`, and **`supersededReportId` is SINGULAR** — a string `"rv-1"`, not an array, not accumulated across rebinds. |
| 3 | a `pausing` record is left **byte-identical** and no request is made (68) | `out` `toEqual` `{ outcome: "pause-in-progress" }`; `fs.readFileSync(s.store.path("run-1"), "utf8")` is compared before/after and must be **identical bytes** — not "equivalent JSON". |
| 4 | a terminal record is not rebound (87, `test.each(["approved"],["rejected"],["timed-out"])`) | `out` `toEqual` `{ outcome: "already-decided", state }`; record byte-identical. |
| 5 | works on a **CLOSED** record (109) | `s.store.close("run-1")` then request → `"requested"` + `awaiting-approval`. **The pause happens after teardown** — `extensions.approval` must stay writable after `closedAt`. |
| 6 | concurrent requests serialize (122) | `Promise.all` of two → `outs.map(o => o.outcome).sort()` `toEqual` `["rebound","requested"]`; exactly one binding survives; final `reportId ∈ {rv-a, rv-b}`; state `awaiting-approval`. |

Shapes DF3.4 inherits (`src/reverify/approval.ts:21-40`):

```ts
export type ApprovalState = "pausing" | "awaiting-approval" | "approved" | "rejected" | "timed-out";
const TERMINAL: ReadonlySet<string> = new Set(["approved", "rejected", "timed-out"]);

export interface ApprovalRequest { proposal: string; reportId: string; headSha: string }

export type ApprovalOutcome =
  | { outcome: "requested" }
  | { outcome: "rebound"; supersededReportId: string }
  | { outcome: "pause-in-progress" }
  | { outcome: "already-decided"; state: string };
```

Record fields written by the adapter: `state, proposal, reportId, headSha,
requestedAt` (+ `supersededReportId` on rebind). DF5.2 additionally **requires**
`approverId` + `decidedAt` on an approved record — see B13.

`describe("approval lock")` — the cross-process lock at
`<runsDir>/<runId>.approval.lock`, body format `` `${pid}:${nonce}` ``. Constants
(`src/reverify/approval.ts:55-66`): `LOCK_TIMEOUT_MS = 5_000`, `LOCK_POLL_MS = 10`,
`LOCK_STALE_MS = 2 × LOCK_TIMEOUT_MS`. It is a **separate file from the store's own
row lock** — the store takes its own lock inside `set`, so reusing it would deadlock.

| # | Test (line) | Pinned |
|---|---|---|
| 7 | a DEAD holder's lock is stolen once stale (143) | `spawnSync(process.execPath, ["--version"])` for a **provably** dead pid (blocks until exit — "proof of death, not guesswork"); backdate 60 s with `fs.utimesSync(lock, old, old)` → `"requested"`, lock file gone. |
| 8 | a LIVE holder's lock is **not** reclaimed by age alone (164) | own `process.pid` + backdated 60 s → rejects `/approval lock .* held for over/`, lock still exists. A suspended-but-live holder must still block. `}, 15_000)`. |
| 9 | a replacement lock racing between the ownership check and removal is **NOT destroyed** (185) | `spyOn(fs, "readFileSync")` injects a live replacement exactly once, when the dead content is read. The rename-based reclaim must detect the content mismatch and put it back. Lock survives holding `liveContent`. `spy.mockRestore()` in a `finally`. |
| 10 | a restore failure after a successful claim **fails CLOSED, not open** (232) | Three spies: `readFileSync` (inject replacement), `renameSync` (sets a `pastRename` flag), `writeFileSync` (throws `EIO` once past the rename). Rejects `/approval lock reclaim: failed to restore/`, and critically **`s.store.get("run-1").extensions?.approval` is `undefined`** — `body()` never ran. Exactly one `.claim.` leftover file in the dir holds the replacement content, recoverable by hand. |
| 11 | a FRESH lock is waited on, then times out rather than stolen (323) | empty lock file, no backdating → rejects `/approval lock .* held for over/`. |

> **DF3.4 constraints falling out of B12.** `fleet approve`/`reject` replaces the
> *adapter*, so all eleven remain contract:
> 1. It must take the **same** `<runsDir>/<runId>.approval.lock` — a CLI path that
>    takes a different lock voids tests 6-11 for the CLI, which is the path an
>    operator actually uses.
> 2. `supersededReportId` stays **singular**. Do not "improve" it into a history array.
> 3. `pausing` and terminal records stay **byte-identical** — no touch, no re-serialize,
>    no key reordering.
> 4. It must work on a **CLOSED** record (the whole point of teardown-at-pause).
> 5. Reclaim failures **fail closed**: no approval record written as a side effect.

---

## B13. `tests/pr/open-pr.test.ts:196-224` — the approval refusal matrix

The block itself, verbatim:

```ts
test.each([
  ["absent", null],
  ["not approved", { state: "awaiting-approval" }],
  ["bound to another report", { reportId: "rv-someone-else" }],
  ["bound to another sha", { headSha: "0".repeat(40) }],
])("an approval %s refuses with nothing pushed", async (_label, over) => {
  const runId = `run-appr-${String(_label).replace(/[^a-z]+/g, "")}`;
  const host = await makeHost(runId);
  defaultAllowlist(host);
  makeRecord(host, runId, over === null ? { approval: null } : {});
  const report = writeReport(host, runId);
  if (over !== null) approve(host, runId, report, over as Record<string, string>);

  const out = await openPullRequest(runId, deps(host));
  expect(out.ok).toBe(false);
  if (out.ok) return;                                          // narrowing, not control flow
  expect(out.refusal.failedPrecondition).toStartWith("approval-");
  expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
});
```

Immediately after (216-224), the fifth case: `"an approval decided BEFORE the report
it would authorize refuses"` → `failedPrecondition === "approval-precedes-report"`,
constructed by passing `{ decidedAt: new Date(Date.parse(report.completedAt) -
60_000).toISOString() }` — same report, same sha, **only the clock is wrong**.

Two house idioms visible here and worth copying: `if (out.ok) return;` after
`expect(out.ok).toBe(false)` is **type narrowing**, not a skip; and every "nothing was
pushed" claim is proved by reading the **bare remote's actual refs**
(`remoteRefs(host)`), never a mock's call log.

### The full matrix — six codes, from `src/pr/push.ts:257-299`

DF3.4's written approval records must satisfy every one of these:

| Code | Precondition that triggers it | src |
|---|---|---|
| `approval-missing` | `record.extensions?.approval === undefined` | push.ts:260 |
| `approval-not-approved` | `approval.state !== "approved"` | push.ts:263 |
| `approval-incomplete` | `String(approval.approverId ?? "") === ""` **or** `String(approval.decidedAt ?? "") === ""` | push.ts:270 |
| `approval-report-mismatch` | `String(approval.reportId ?? "") !== report.reverifyId` | push.ts:276 |
| `approval-sha-mismatch` | `String(approval.headSha ?? "") !== headSha` — the sha `refs/sandbox/<runId>` resolves to **now**, not at approval time | push.ts:283 |
| `approval-precedes-report` | `!Number.isFinite(Date.parse(decidedAt))` **or** `!Number.isFinite(Date.parse(report.completedAt))` **or** `decided < completed` | push.ts:295 |

**Ordering is observable and load-bearing.** The `approval-*` checks are stage 3,
running after the `reverify-*` stage (`reverify-missing`, `reverify-red`,
`reverify-sha-mismatch`) and before the repo allowlist stage 4 (`no-repo-slug`, …).
A record failing two preconditions reports the earlier one.

**Two constraints on `fleet approve` specifically:**

1. `src/pr/push.ts:288-291` — *"Both stamps are host clocks (DF5.1 and DF3.4 both
   write host-side), so they compare."* **`fleet approve` MUST stamp `decidedAt` from
   the HOST clock**, and it must be ≥ the report's `completedAt`. A box clock, or a
   clock read before the report sealed, produces `approval-precedes-report`.
2. `approval-incomplete` means an approve that writes `state:"approved"` **without
   both `approverId` and `decidedAt` is not an approval** — it is a record that
   refuses at PR time, silently, much later.

The reference writer to match is `tests/pr/helpers.ts:182-202`:

```ts
export function approve(host: Host, runId: string, report: ReverifyReport,
                        over: Partial<Record<string, string>> = {}): void {
  host.store.set(runId, { extensions: { approval: {
    state: "approved",
    proposal: `open a PR for run ${runId}`,
    reportId: report.reverifyId,
    headSha: report.headSha,
    requestedAt: report.completedAt,
    approverId: "steve",
    decidedAt: new Date(Date.parse(report.completedAt) + 1_000).toISOString(),
    ...over,                    // the `over` spread LAST is what makes the test.each matrix work
  }}});
}
```

---

## B14. Restricted-mode fixtures and how MODE is asserted

Answering the B9 follow-up: **yes, there is an existing fixture with restricted-mode
semantics, and it is a much closer match to `approvers.json` than any fixture in
`tests/fleet/fixtures/` — it is a JSON allowlist written at 0600 with the mode as a
defaulted parameter.** `tests/pr/helpers.ts:105-125`:

```ts
export function writeAllowlist(
  host: Host,
  entries: Record<string, { remote: string; baseBranch: string; authorLogin: string }> | null,
  mode = 0o600,
): string {
  const dir = join(host.root, ".factory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "repos.json");
  if (entries === null) return path;          // `null` ⇒ return the path, create NO file
  writeFileSync(path, JSON.stringify({ version: 1, repos: entries }));
  chmodSync(path, mode);                      // separate chmod — see below
  return path;
}

export function defaultAllowlist(host: Host, mode = 0o600): string {
  return writeAllowlist(host,
    { [REPO_SLUG]: { remote: REMOTE_URL, baseBranch: BASE_BRANCH, authorLogin: AUTHOR_LOGIN } }, mode);
}
```

Four things to copy verbatim for `approvers.json`:
1. **`{ version: 1, … }` envelope** — the loader can refuse an unversioned file.
2. **`entries === null` ⇒ absent-file case**, returning the path so the test can still
   assert on it. That is how the `approval-missing`-shaped negative is built.
3. **`mode` as a trailing defaulted parameter**, so one call site proves the happy
   path and another widens it to `0o644` to prove the loader REFUSES.
4. **`writeFileSync` then a separate `chmodSync`** — `writeFileSync`'s `mode` option is
   masked by the process umask, so it cannot guarantee 0600. The explicit `chmod`
   after the write is the only form that is actually tight.
   (`tests/providers/exedev/setup-gate.test.ts:48` uses the same `(…, mode = 0o600)`
   parameter shape for `deliverKey`.)

Also worth copying: `tests/pr/helpers.ts:51-54` writes `.factory/` into
`.git/info/exclude` so a stray `git add -A` in a test cannot commit the allowlist and
a later `git checkout` cannot delete it out from under the suite.

### How tests assert on file MODE

Always **`statSync(p).mode & 0o777`** — never a bare `.mode`, which carries the file
type bits:

```ts
expect(statSync(join(dir, "run-a.json")).mode & 0o777).toBe(0o600);                 // run-record.test.ts:113
expect(stat.mode & 0o777).toBe(0o600);                                             // cap-hit-demo.test.ts:161  (file)
expect(dirStat.mode & 0o777).toBe(0o700);                                          // cap-hit-demo.test.ts:163  (dir)
expect(statSync(join(dir, ".sandbox", "cost-ledger.db")).mode & 0o777).toBe(0o600); // cost-ledger.test.ts:528
expect(statSync(join(dir, ".sandbox")).mode & 0o777).toBe(0o700);                   // cost-ledger.test.ts:529
```

One deliberately tolerant variant where the substrate legitimately differs
(`cost-ledger.test.ts:519-520`):

```ts
const mode = statSync(ledgerPath).mode & 0o777;
expect(mode === 0o600 || mode === 0o400).toBe(true);
```

**The companion-directory rule.** Secrets-adjacent files live at **0600 inside a 0700
directory, and both are asserted** — see the cost-ledger pair above, and
`tests/providers/exedev/fixtures/fake-exedev.ts:288-301`, which creates every fixture
dir with `mkdirSync(root, { recursive: true, mode: 0o700 })`.

> **DF3.4:** assert the `approvers.json` file at 0600 **and** its parent dir at 0700,
> and add a widened-mode case (`0o644`, and `0o640`) proving the loader refuses rather
> than warns. A mode check that only tests the happy path is a mode check that never
> fails.

---

## B15. Mutation verification — tooling or discipline?

**Manual discipline. There is NO tooling.** Stated plainly because it changes how
DF3.4 must budget its time.

Searched `package.json`, `.github/workflows/ci.yml`, `scripts/`, and the whole tree
for `stryker`, `mutmut`, or any mutation runner: **zero hits**. There is no
`bunfig.toml` at the repo root either. Every occurrence of "mutation-verified" in the
repo is **prose in `_bmad-output/` story and review documents**, describing a manual
practice:

- `_bmad-output/workflow-state/qds-dev/df3-2/integration-spec.md:731` — *"Every new
  assertion mutation-verified RED against pre-fix source"*
- `_bmad-output/workflow-state/qds-dev/df3-2/research/R3-df31-playbook.md:104` —
  *"mutation-verify every new assertion goes RED against pre-fix source; import
  constants (LOCK_TIMEOUT_MS, grace windows) rather than mirroring literals +
  value-lock the derivation; `UnexpectedSuccessError` sentinel beats try/catch"*
- `_bmad-output/workflow-state/qds-dev/df3-3/research/R3-examples.md:48-49` — cites it
  as *"repo doctrine in DF3.2 round 5b"*
- `_bmad-output/workflow-state/qds-dev/df3-3/wave0-spec.md:227` — *"mutation-verified
  RED against pre-fix source **where feasible**"* (the one place it is hedged)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-1-dispatcher-core-verbs.md:1336`
  — *"Additions are mutation-verified — each was confirmed to go RED against the
  pre-fix source."*
- `_bmad-output/evidence/df3-2/pr128-triage.md:217` — *"Both fixes mutation-verified
  RED pre-fix. 508/508 focal."*

**The procedure DF3.4 should follow**, since nothing automates it:

1. Write the assertion.
2. Revert (or hand-mutate) the exact source line it targets — flip a comparison, drop
   a guard, return early.
3. Run the focal file: `bun test ./tests/fleet/<file>.test.ts`.
4. Confirm it goes **RED**, and that the failure message names the right thing.
5. Restore the source; confirm GREEN.
6. Record the mutation and the observed failure in the story's test-evidence section.

Two supporting conventions that make step 4 meaningful, both already house style:

- **Import constants from source, never mirror literals** — a test that hardcodes
  `5_000` still passes after `LOCK_TIMEOUT_MS` changes, so the mutation never shows.
  Where the constant is module-private, **probe it off a real artifact** the way
  `verbs.test.ts:88-106` reads the lock host token out of a real lock.
- **Comment the assertion with the bug it replaces**, citing `file:line` or old
  evidence. `tier1-lock.live.test.ts:43-50` is the model: it names the wrong artifact
  the barrier used to poll, the date the defect was found, and why the old version
  passed on timing luck.

