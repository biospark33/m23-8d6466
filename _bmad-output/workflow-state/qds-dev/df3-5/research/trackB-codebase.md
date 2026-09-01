# DF3.5 Track B — Codebase Exploration

Date: 2026-08-31. Branch: feature/df3.5. Researcher: Track B subagent.

Scope: the exact contracts DF3.5's four SKILL.md files and
`tests/fleet/skill-contract.test.ts` must target: `src/fleet/verbs.ts`,
`scripts/fleet.ts`, existing SKILL.md conventions, the fleet test harness, and
toolchain coverage of `.claude/skills/`.

---

## 1. `src/fleet/verbs.ts` (461 lines — read in full)

### 1.1 Interface shapes (verbatim)

```ts
export interface VerbFlag {
  name: string;
  required: boolean;
  valueType: "string" | "path" | "boolean";
  /**
   * One sentence of grammar `{name, required, valueType}` cannot express —
   * today only `attach --message`'s `-` stdin sentinel (DF3.4 deferred item D2).
   * ... (ADDITIVE and OPTIONAL by design; NOT a description field) ...
   */
  note?: string;
}

export interface VerbEntry {
  verb: string;
  summary: string;
  flags: VerbFlag[];
  exitCodes: number[];
}
```

- `VerbFlag`: `name` (dashed flag, e.g. `"--driver"` — positionals like runId
  are per-verb CLI grammar, NOT registry flags), `required` (a claim about the
  INVOCATION), `valueType` ∈ `"string" | "path" | "boolean"`, and optional
  `note` (only for a value whose behaviour differs from its declared
  `valueType`; 4 flags carry one today, listed below).
- `VerbEntry`: `verb`, `summary` (one line), `flags`, `exitCodes` (the codes
  the verb may return; the skill-contract test is expected to compare these
  against what the verbs actually return — the registry header calls this out
  explicitly).

### 1.2 Registered verbs (11 entries, in declaration order)

| verb | flags (name — required?) | exitCodes |
|------|--------------------------|-----------|
| `dispatch` | `--driver` REQ string · `--brief` opt path · `--dir` opt path · `--port` opt string (range-checked 1–65535) · `--help` opt bool | `[0,1,2,3,5,6]` (no 4) |
| `status` | `--driver` REQ · `--dir` opt path · `--help` opt bool | `[0,1,2,4]` |
| `harvest` | `--driver` REQ · `--dir` opt path · `--help` opt bool | `[0,1,2,4,5,6]` |
| `teardown` | `--driver` REQ · `--dir` opt path · `--no-harvest` opt bool · `--help` opt bool | `[0,1,2,4,5,6]` |
| `fanout` | `--driver` REQ · `--pattern` REQ string · `--n` REQ string (positive int, range-checked) · `--pin` opt · `--roster` opt · `--cap-micro-usd` opt string · `--brief` opt path · `--fanouts-dir` opt path · `--dir` opt path (deprecated alias of `--fanouts-dir`, F049, one release) · `--help` opt bool | `[0,1,2,5,6]` (no 4) |
| `rank` | `--fanouts-dir` opt path · `--dir` opt path (deprecated alias) · `--steps-json` opt path · `--help` opt bool — **NO `--driver`** | `[0,1,2,4,6]` (no 5) |
| `approve` | `--dir` opt path **with note** (dual-purpose: allowlist host root AND runs dir) · `--approver` REQ string (token arrives on STDIN, never argv — no `--token` flag exists) · `--reason` opt string · `--help` opt bool — **NO `--driver`** | `[0,1,2,4,5,6]` |
| `reject` | same argv block as `approve` (`--dir` with the same note, `--approver` REQ, `--reason` opt, `--help` opt) — **NO `--driver`** | `[0,1,2,4,5,6]` |
| `attach` | `--driver` REQ (reaches INTO the box, unlike approve/reject) · `--dir` opt path · `--message` opt string **with note** (value `-` or omitting the flag reads stdin) · `--help` opt bool | `[0,1,2,4,5,6]` |
| `enrol` | `--approver` REQ string · `--dir` opt path **with note** (allowlist HOST ROOT, not a runs dir) · `--out` opt path **with note** (token JSON written mode 0600 instead of stdout) · `--rotate` opt bool **with note** (invalidates the current token immediately) · `--help` opt bool — **NO `--driver`** | `[0,1,2,5,6]` (no 4) |
| `unlock` | `--dir` opt path · `--force` opt bool **with note** (removes a live holder's lock) · `--help` opt bool — **NO `--driver`, NO `--approver`** | `[0,1,2,5,6]` (no 4) |

Correcting the table count: the registry holds **11 entries**: dispatch,
status, harvest, teardown (DF3.1), fanout, rank (DF3.2), approve, reject,
attach, enrol, unlock (DF3.4). D2 (`VerbFlag.note?`) is the only item
identified as deferred into DF3.5; it closed 2026-08-28.

**`--driver` rule:** `required: true` on dispatch, status, harvest, teardown,
fanout, attach. Absent entirely (not optional — absent) on rank, approve,
reject, enrol, unlock, because those verbs consume no driver and
`assertDriverChosen` is deliberately skipped for them. The registry comments
warn that declaring `--driver` optional (rather than required or omitted) is
"how DF3.5 would generate a skill whose every call exits 2" — skill commands
must always pass `--driver <name>` on driver-taking verbs and never on the
five driverless ones.

**Every verb declares `--help` (boolean, optional).** `-h` is a CLI-side alias
normalized to `--help`; it is NOT a registry flag (a test pins that no entry
declares `-h`).

**`note`-carrying flags (7 flags across 5 verbs, all on DF3.4 verbs):**
`approve --dir`, `reject --dir` (identical note text), `attach --message`,
`enrol --dir`, `enrol --out`, `enrol --rotate`, `unlock --force` —
`attach --message` was the original D2 case.

### 1.3 One full example verb entry (verbatim, comments trimmed)

```ts
{
  verb: "dispatch",
  summary: "Mint a run handle and provision a sandbox",
  flags: [
    { name: "--driver", required: true, valueType: "string" },
    { name: "--brief", required: false, valueType: "path" },
    { name: "--dir", required: false, valueType: "path" },
    { name: "--port", required: false, valueType: "string" },
    { name: "--help", required: false, valueType: "boolean" },
  ],
  exitCodes: [0, 1, 2, 3, 5, 6],
},
```

### 1.4 `renderHelp` signature

```ts
export function renderHelp(registry: VerbEntry[]): string
```

Output format: `Usage: fleet <verb> [options]`, blank line, `Verbs:`, then per
entry `  ${verb.padEnd(10)} ${summary}`, per flag
`        ${flag.name} (${flag.valueType}, ${required ? "required" : "optional"})${note ? " — " + note : ""}`
(the note stays on the flag's OWN line — a second line would parse as a
phantom flag), then `        Exit codes: ${entry.exitCodes.join(", ")}` and a
blank separator. Result is `.trimEnd()`ed — NO trailing newline, NO
per-verb-help trailer. `listVerbs(): VerbEntry[]` returns a fresh literal array
each call.

---

## 2. `scripts/fleet.ts` (4293 lines; header, interfaces, and tails read; middle grepped)

### 2.1 Invocation

Shebang `#!/usr/bin/env bun`; invoked as `bun scripts/fleet.ts <verb>
[positionals] [--flags]`. Entry block (verbatim, end of file):

```ts
if (import.meta.main) {
  try {
    // stdout = output only; diagnostics stream as JSON lines on stderr.
    setLogSink((entry) => {
      writeBestEffort(2, `${JSON.stringify(entry)}\n`);
    });
    process.exit(
      await run(
        process.argv.slice(2),
        (s) => writeAll(1, s),
        undefined,
        (s) => writeBestEffort(2, s),
      ),
    );
  } catch (e) {
    const stack = (e as Error)?.stack;
    writeBestEffort(2, `${stack ?? (e as Error)?.message ?? String(e)}\n`);
    process.exit(1);
  }
}
```

Library entry point (what tests call in-process):

```ts
export async function run(
  argv: readonly string[],
  out: (s: string) => void,
  deps?: Partial<FleetDeps>,
  err: (s: string) => void = out,   // defaults to `out`; import.meta.main binds it to stderr
): Promise<number>
```

`FleetDeps` (required when a full deps object is built; tests pass Partial):

```ts
export interface FleetDeps
  extends Omit<DispatchDeps, "driver" | "keyApi" | "store" | "ledgerFactory" | "requestId" | "port"> {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  ledgerFactory: () => LedgerLike;
  readBrief: () => Promise<string>;
  authenticate?: (hostRoot: string, approverId: string) => Promise<ApproverAuth>;
  enrol?: (hostRoot: string, approverId: string, file?: string,
           opts?: { rotate?: boolean; dir?: string }) => ApproverEnrolment;
  /* + attach ack ceiling/poll seams, and inherited DispatchDeps seams:
     repoRoot, quotaLimits, clock, timeoutMs, dispatchLogPath, setupGate,
     lockPath */
}
```

An injected `deps.driver` is the ONLY way to satisfy the `--driver`
requirement without the flag (`assertDriverChosen(verb, driverName,
deps?.driver)` — fleet.ts:320; a missing driver exits 2 with remediation
"pass --driver fake for a local dry run, or the provider driver to act on the
real fleet").

### 2.2 `--help` rendering

Module level: `const HELP = renderHelp(listVerbs());` (fleet.ts:147) — the one
global help string, used for ALL of `--help`, `-h` (aliased to `--help` before
parsing), bare `help`, and as the default remediation on usage errors. There
is NO per-verb help: every `--help`/`-h`/`help` argv answers with the same
string, printed to stdout with exit 0. Help is resolved from PARSED flags only
after the value grammar runs (a `--dir --help` fat-finger is a usage error,
not help). Bare `fleet` (no verb) is exit 2 usage, not help.

### 2.3 Exit-code conventions (verbatim from the file header)

> Exit codes (this CLI's own table, F3): 0 success · 1 run/provider failure ·
> 2 usage/schema · 3 setup-gate failure (assertion code in the payload) ·
> 4 run-not-found · 5 refused before provisioning (payload code says which
> guard fired) · 6 the verb's own work LANDED but the invocation could not
> finish it or report it, and no retry can change that.

Additional rules:
- 6 has two meanings, both CLI-only by construction (`FleetError.exitCode` is
  typed `1|2|3|4|5`; the CLI's own output/cleanup failures are folded to 6 by
  `finish`/`cleanupFailed()`):
  - **General:** billable work landed and the CLI's own OUTPUT or CLEANUP
    failed after it (decision record Q11).
  - **Dispatch-specific:** the box is LIVE and the ack could not be written to
    stdout (e.g. `fleet dispatch | head -0`). This is the one case where the
    registry names teardown as the required next step to stop billing.
- 130/143 sit OUTSIDE the table: 128+SIGINT/SIGTERM shell convention; only
  `dispatch` installs signal handlers.
- 3 is dispatch-only (setup gate); no other verb declares it.
- Code-to-exit mapping is clamped: `report()` returns
  `Number.isInteger(e.exitCode) && e.exitCode >= 1 && e.exitCode <= 6 ? e.exitCode : 2`.

### 2.4 Error output shape

`FleetError` (src/fleet/dispatch.ts:233, verbatim):

```ts
export class FleetError extends Error {
  constructor(
    public readonly exitCode: 1 | 2 | 3 | 4 | 5,
    public readonly code: string,
    message: string,
    public readonly remediation: string,
    public readonly payload?: Record<string, unknown>,
  ) { ... }
}
```

Renderer (scripts/fleet.ts:441, verbatim):

```ts
function printError(
  err: (s: string) => void,
  code: string,
  message: string,
  remediation?: string,
  payload?: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = { ...(payload ?? {}), code, message };
  if (remediation !== undefined) line.remediation = remediation;
  err(`${JSON.stringify(line)}\n`);
}
```

So stderr carries one JSON line per error:
`{ ...payload, code: string, message: string, remediation?: string }` —
`remediation` is ABSENT (never empty-string) when there is none. stdout is
pure command output (ack JSON, status rows); ALL diagnostics — error envelopes
and the structured log — are stderr JSON lines. Messages/remediations pass
through `redactSecrets` before printing. Untyped throws become exit 1
`transient` ("retry me").

Driver resolution: `resolveDriver(name, ctx)` in src/providers/index.ts:36
throws a bare `Error("unknown provider driver: <name> (registered: ...)")`
which `asUsage` converts to exit 2. Registered names: `"fake"` (→
`new FakeDriver()`) and `"exedev"` (index.ts:127-131).

---

## 3. Existing SKILL.md conventions

### 3.1 `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md`

Frontmatter (verbatim):

```yaml
---
name: gitnexus-impact-analysis
description: "Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: \"Is it safe to change X?\", \"What depends on this?\", \"What will break?\""
---
```

Two keys only: `name` (bare scalar, matches the directory name) and
`description` (double-quoted single-line scalar; inner quotes escaped; long —
one line, NOT a YAML multiline/folded block). `gitnexus-exploring/SKILL.md` is
identical in shape (`name: gitnexus-exploring`, one double-quoted description
line).

Body conventions: `# <Title>` H1; `## When to Use` with a bullet list of
trigger phrases; `## Workflow` and `## Checklist` as **plain fenced blocks
with NO language tag** (```` ``` ````) containing numbered steps / `- [ ]`
items; `## Understanding Output` / `## Risk Assessment` as Markdown tables;
`> ` blockquote for the stale-index tip; tool invocations shown inside the
untagged fences (`impact({target: "X", direction: "upstream"})`), NOT as
tagged code blocks.

### 3.2 `.claude/skills/qds-live-e2e/SKILL.md`

Frontmatter:

```yaml
---
name: qds-live-e2e
description: Run live (no-fakes) end-to-end E2E testing rounds for QDS-Factory fleet/phase-engine code against real exe.dev boxes ... — even if they don't name a tier.
---
```

Same two keys; here `description` is an UNQUOTED single-line scalar (very
long, one physical line). So the repo tolerates both quoted and unquoted
single-line descriptions; no `---`-style folded multiline descriptions appear
in either family.

Body conventions: `# QDS Live E2E Rounds` H1; `##` sections (Hard rules,
Gating and env contract, The tiers, Gotchas…, Failure triage protocol);
numbered hard rules in bold; **language-tagged fenced blocks ARE used here**
(```` ```bash ```` for the env-export snippet); tables with `---` separators;
paths/flags in backticks; gotchas as a numbered list with bold lead-ins.

Summary for DF3.5: frontmatter = exactly `name:` + single-line `description:`
(quoted or unquoted); body = H1 title, `##` sections, fenced blocks (gitnexus
family untagged, qds-live-e2e uses ```bash) — so fenced `fleet …` commands in
the new skills should sit in `bash`-tagged or untagged fences consistently,
because the contract test will parse every fenced `fleet` command.

---

## 4. `tests/fleet/` — harness and fake-driver mechanism

### 4.1 Files

`approval-gate.test.ts`, `approvers.test.ts`, `attach.test.ts`,
`brief-schema.test.ts`, `cli.test.ts` (6222 lines — the big CLI suite),
`dispatch.test.ts`, `e2e/` (live tiers, `*.live.test.ts`, gated by
`QDS_E2E_LIVE`), `fanout.test.ts`, `fixtures/`, `fleet-lock.test.ts`,
`gate-verbs.test.ts`, `helpers.ts`, `patterns.test.ts`, `rank.test.ts`,
`resident.test.ts`, `verbs.test.ts`. All use `bun:test`
(`import { describe, expect, test, beforeEach, afterEach } from "bun:test"`).

### 4.2 Fake-driver dispatch (no real spend, no subprocess)

The dominant pattern is IN-PROCESS: import `run` and `FleetDeps` from
`../../scripts/fleet.ts` and call it with injected deps and captured sinks:

```ts
import { run, type FleetDeps } from "../../scripts/fleet.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun } from "../../src/providers/driver.ts";
```

From `tests/fleet/cli.test.ts:562-612` (verbatim, the canonical helper):

```ts
function deps(briefJson: string): Partial<FleetDeps> {
  return {
    driver: new FakeDriver(boxesDir),
    keyApi: new FakeKeyApi(),
    store: new RunRecordStore(runsDir),
    ledgerFactory: () => goodLedger(),
    readBrief: async () => briefJson,
    repoRoot: dir,                              // injected containment root (no chdir)
    lockPath: join(dir, ".sandbox", "fleet.lock"), // per-tmpdir fleet lock
  };
}
const runCli = (argv: readonly string[], d?: Partial<FleetDeps>): Promise<number> =>
  run(argv, out, d, errOut);
```

Key facts for DF3.5's test author:
- `--driver fake` on argv AND/OR an injected `deps.driver` both work;
  injection satisfies `assertDriverChosen` without the flag. `"fake"` is a
  real registered driver name (`registerDriver("fake", () => new FakeDriver())`,
  src/providers/index.ts:127), and `FakeDriver` honours
  `QDS_FAKE_BOXES_DIR` (cli.test.ts sets it per-tmpdir along with
  `QDS_RUNS_DIR`, saved/restored around each test).
- Provisioning goes through `provisionAdmittedRun` (production sequence from
  src/providers/driver.ts) so no test recomputes box naming; FakeDriver names
  the box after the run id (`vmName === runId`).
- Ledgers are faked via `tests/fleet/helpers.ts`: `goodLedger()`,
  `overBudgetLedger()`, `admitThrowsLedger()`, `closeThrowsLedger()` — a
  `RecordingLedger` that records `admitIssue` args and `closeCalls`.
- Keys via `FakeKeyApi` (`tests/providers/fixtures/fake-key-api.ts`).
- Env vars touched by suites: `QDS_RUNS_DIR`, `QDS_FAKE_BOXES_DIR`,
  `QDS_COST_CONFIG_FILE` (deleted), saved and restored in afterEach.
- Refusal assertion idiom: a `refusal(work, exitCode, code)` narrowing helper
  over the shared `rejection` combinator in `tests/helpers.ts`.

### 4.3 Spawning `scripts/fleet.ts` as a real subprocess

Exists but is the exception, used only where fd 0 behaviour is the subject.
`tests/fleet/gate-verbs.test.ts` (D2 describe) runs attach/approve cases as
"a real subprocess with a real empty pipe" because fd 0 cannot be attached
in-process. `tests/fleet/approvers.test.ts:848` shows the spawn idiom:
`Bun.spawn([process.execPath, "-e", "...import the module..."], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })`.
For DF3.5's skill-contract test (pure parsing of SKILL.md against
`listVerbs()`) no subprocess is needed — `verbs.test.ts` and `cli.test.ts`
import `listVerbs`/`renderHelp` directly, and `cli.test.ts:667` pins
`expect(helpText).toBe(`${renderHelp(listVerbs())}\n`)` — note the CLI appends
its own `\n` to the trimEnd()ed renderHelp output.

---

## 5. Toolchain coverage of `.claude/skills/`

- **biome**: EXCLUDED. `biome.json` `files.ignore` includes `".claude"` (also
  `node_modules`, `_bmad-output`, `.gitnexus`, `.swarm`, `docs`,
  `visualizer/**/*.vue`, `visualizer/dist`).
- **tsc**: EXCLUDED. `tsconfig.json` `include` is
  `["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts", "pi-vs-claude-code-vendor/**/*.ts"]`
  — `.claude` matches neither include nor exclude; SKILL.md files are not
  TypeScript anyway.
- Consequence: nothing but DF3.5's own `tests/fleet/skill-contract.test.ts`
  (which WILL be tsc/biome-covered under `tests/**`) checks the skill files.

---

## 6. `listVerbs` callers (GitNexus MCP unavailable — Grep used)

GitNexus MCP tools are not available to this subagent; Grep over the repo
gives the caller set:

- `scripts/fleet.ts`: :111 (import), :147 (`HELP = renderHelp(listVerbs())`),
  :164 (`REGISTRY_FLAGS = listVerbs().flatMap(v => v.flags)`), :209
  (`flagTypeConflicts(listVerbs())` startup validation), :754 (per-verb entry
  lookup), :1544 (extra-positional check against known verbs).
- `src/fleet/verbs.ts`: definition (:70) and docstring references.
- Tests: `tests/fleet/cli.test.ts` (import :54; verb-set pin :399/:646/:823;
  help byte-equality :667/:765/:1131; per-verb flag sweeps :748/:867/:922;
  exit-code pins :2501/:6209), `tests/fleet/verbs.test.ts` (import :29; ~15
  use sites including "listVerbs keeps every known verb" :358, EXPECTED_FLAGS
  parity :719, renderHelp pins :2289), `tests/fleet/gate-verbs.test.ts` (:20,
  :182 — pins that approve/reject declare NO `--driver`).

Prior research note on record
(`_bmad-output/workflow-state/qds-dev/df3-4/research/R3-cli-chassis.md`):
GitNexus `context({name:"listVerbs"})` there reported upstream LOW, 3
callers/3 direct, 1 process — consistent with the above (CLI + 2 test files at
that time).

---

## 7. DF3.5-relevant gotchas surfaced during exploration

1. **`--driver` polarity is per-verb and load-bearing**: required on 6 verbs,
   FORBIDDEN on 5 (rank, approve, reject, enrol, unlock — they declare no
   `--driver` at all, so passing one is an unknown-flag exit 2). The skill
   files must get this right per verb; the contract test will catch it.
2. **Positionals are NOT registry flags**: `fleet status <id>`,
   `fleet teardown <id>`, `fleet approve <run-id>` etc. take a runId
   positional the registry never mentions. A naive "resolve every token
   against the registry" test must parse positionals per-verb, not reject
   them. `fleet help` is dispatchable but absent from `listVerbs()` (pinned
   by verbs.test.ts:2310) — a skill documenting `fleet help` would fail a
   strict verb-resolution test.
3. **`--dir` is verb-dependent**: runs dir on dispatch/status/harvest/
   teardown/attach; deprecated alias of `--fanouts-dir` on fanout/rank (F049,
   one release); allowlist host root (+ runs dir) on approve/reject; allowlist
   host root only on enrol. Skills should prefer `--fanouts-dir` on
   fanout/rank.
4. **Token/message on stdin, never argv**: approve/reject take `--approver`
   but the token arrives on fd 0; `attach --message -` (or an omitted
   `--message`) reads stdin. Skills must not invent a `--token` flag — one
   exists nowhere.
5. **Exit 6 is real and declared** on 7 of 10 verbs; 3 is dispatch-only; 4 is
   absent on dispatch/fanout/enrol/unlock; 5 absent on status/rank. The
   per-verb `exitCodes` arrays in §1.2 are the normative table.
6. **`fleet dispatch --no-harvest`-style success-at-6**: a `--no-harvest`
   teardown legitimately exits 6 (`harvest_waived`) — qds-live-e2e gotcha #6;
   skills must not teach "0 = success" simplistically.
7. Bare `fleet` with no verb is exit 2 (usage), NOT help; only
   `fleet --help` / `-h` / `help` print help (exit 0).
