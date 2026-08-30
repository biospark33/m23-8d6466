# R1 (track A — library docs): zod + Bun subprocess facts for DF3.3

Story: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-3-resident-orchestrator-agent.md`
Scope: closed `.strict()` SteeringDirective schema, bounded LLM/subagent call facts.
Sources: package.json / bun.lock, Context7 (`/websites/v3_zod_dev`, v3 docs), repo greps.

## 1. Installed zod version

- `package.json:35` — `"zod": "^3.24.0"` (only root-level dependency alongside `yaml`).
- `bun.lock:679` — resolves **`zod@3.25.76`**. Root workspaces (`bun.lock:8`, `bun.lock:25`) all pin `^3.24.0`.
- **Major = v3.** Every repo import is the classic v3 entrypoint `import { z } from "zod"`
  (e.g. `src/hindsight/schemas.ts:22`, `src/pr/repos.ts:14`, `src/phase-engine/agents/envelope-parse.ts:12`).
  Zero imports of `zod/v4` anywhere in `src/` or `scripts/` (grep confirmed empty).
- Caveat: zod 3.25.x dual-publishes a v4 API under the `zod/v4` subpath — it is available in
  `node_modules` but unused here. **Implement against the v3 API only** (`.strict()`, `z.discriminatedUnion`
  semantics below are the v3 ones; v4 renamed `.strict()` to `z.strictObject` and changed error codes).
- Related transitive: `zod-to-json-schema@3.25.2` (`bun.lock:681`, peer `zod ^3.25.28 || ^4`) — used by
  pi-ai, not by our source.

## 2. `.strict()` on object schemas (zod v3, per Context7 v3 docs)

- `z.object({...}).strict()` returns a new ZodObject with `unknownKeys: "strict"`: parsing input
  containing keys not in the shape **fails** (safeParse → `success:false`; parse → throws ZodError).
  Doc form: `person.strict().parse({ name: "bob dylan", extraKey: 61 }) // throws ZodError`.
- Chainable and idempotent with the other object transforms (`.pick/.omit/.extend/.merge/.partial`
  all still available; `.merge`/`.extend` after `.strict()` produce strip-mode results unless re-strict'ed).
- `.strip()` resets to the default (silently drop unknown keys); `.catchall(schema)` instead validates
  unknown keys against a schema — neither is wanted for a closed directive union.
- **Failure shape:** issue `code: "unrecognized_keys"` with `keys: string[]` naming the offending keys.
  The repo already relies on exactly this: `src/phase-engine/types.ts:89` ("`.strict()` schema's
  `unrecognized_keys` issue embeds the raw offending key"), `src/phase-engine/manifest.ts:669`
  (sanitization of the issue), `src/fleet/brief-schema.ts:458` ("z.strict() produces
  unrecognized_keys with empty path but named keys"), `src/phase-engine/phases/test-results.ts:208`
  (comment: agent params object is `.strict()` too).

## 3. `z.discriminatedUnion` + `.strict()` composition (the SteeringDirective question)

- v3 signature: `z.discriminatedUnion(discriminator, options)` where `options` is an **array of
  ZodObject** each carrying a literal value for the shared discriminator key. Parse checks the
  discriminator first, then runs the selected member's own object parse. `.options` exposes the
  member array (also the documented way to merge two DUs: `[...A.options, ...B.options]`).
- **`.strict()` does NOT exist on the discriminated union itself** — `z.discriminatedUnion(...)`
  returns a `ZodDiscriminatedUnion`, not a `ZodObject`, so there is no union-level `.strict()` call.
  The closed-ness composition in v3 is **member-level**: each option is declared
  `z.object({ action: z.literal("proceed"), ... }).strict()`. The discriminator-selected member's
  `unknownKeys: "strict"` then applies to that variant's parse — this is how you get the closed union.
- Error behavior that maps 1:1 onto AC2:
  - Reply with `action` outside the four literals → issue `code: "invalid_union_discriminator"`
    (context lists the valid options). The rejected action name itself is read off the raw reply
    (`input.action`) before/independent of the ZodError — same "structured issues + raw field names,
    never raw model text interpolated into prompts" discipline as `src/phase-engine/agents/envelope-parse.ts:7-10`.
  - Reply with a known `action` plus an extra field → member parse emits `unrecognized_keys`
    with the named keys (§2 shape).
  - `z.union` (used at `src/gate/assertions/p0-7-mcp-bridge.ts:62`) is the wrong tool here: it
    returns aggregate `invalid_union` with per-option sub-errors and tries options in order —
    noisier rejections, no discriminator fast-path, no clean "which action was named" signal.
- Literal + enum mixing: the four member shapes match the story's union exactly —
  `{action:"proceed"}`, `{action:"retry", guidance}`, `{action:"select_roster", phase, rosterId}`,
  `{action:"abort", reason}`, each plus optional `note`. `z.literal` per member on `action`
  is required by discriminatedUnion (a `z.enum` on the discriminator key is not a valid member pattern).

## 4. `safeParse` error shape (zod v3)

- `schema.safeParse(data: unknown)` → `{ success: true; data: T } | { success: false; error: ZodError }`.
  Never throws; `error.errors` is a **deprecated alias** of `error.issues` — use `.issues`.
- `error.issues: Array<{ code: string; path: (string|number)[]; message: string; expected?; received?; keys?; options? }>`:
  - `invalid_type` carries `expected`/`received` (e.g. `{code:"invalid_type", expected:"string", received:"number", path:["name"], message:"Expected string, received number"}`).
  - `unrecognized_keys` carries `keys: string[]` (path is empty — see `src/fleet/brief-schema.ts:458`).
  - `invalid_union_discriminator` carries the valid `options` list.
- `error.format()` → nested object with `_errors` arrays per node (e.g. `{ name: { _errors: ["Expected string, received number"] } }`).
- `error.flatten()` → `{ formErrors: string[]; fieldErrors: Record<string, string[]> }` (v3 also has this).
- Async: `safeParseAsync` / alias `.spa` — not needed for a synchronous directive parse.
- House precedent for consuming issues structurally: `src/phase-engine/agents/envelope-parse.ts`
  (imports `type ZodIssue` at `:12`, returns structured issues + required-field list to the
  correction prompt).

## 5. `z.infer`

- `type SteeringDirective = z.infer<typeof SteeringDirectiveSchema>` — works on
  ZodDiscriminatedUnion exactly as on objects (v3 infers the discriminated member union).
- House hardening pattern worth copying: compile-time mirror assertion
  `src/phase-engine/agents/envelope-parse.ts:56-58` —
  `type Equals<A,B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;`
  then `AssertTrue<Equals<z.infer<typeof Schema>, HandWrittenType>>` — makes any field drift a
  `tsc --noEmit` error rather than silent divergence. SteeringDirective has no pre-existing
  hand-written type to mirror, so this is optional; if the journal block type is hand-written,
  mirror it.

## 6. House `.strict()` style (grep `src/`, 2026-08-27)

Every closed schema in this repo is `z.object({...}).strict()` chained on the literal, with a doc
comment stating why it is closed, consumed via safeParse-style structured issues — never a bare
throwing `parse()` at a trust boundary:

1. `src/phase-engine/agents/envelope-parse.ts:34-47` — **the closest analog**: DF1.2's Envelope,
   a closed `.strict()` schema for parsing *model replies* (exactly the resident-directive job),
   optional fields via `.optional()`, closed enum for status.
2. `src/phase-engine/manifest.ts:113-120` — `PhaseAgentSchema`, chained `.strict()`, closed
   identity fields (this is also `params.agent`, cited by `test-results.ts:208`).
3. `src/phase-engine/roster/schema.ts:127-131` — `RoleSchema`/`DefaultsSchema` inline `.strict()`.
4. `src/reverify/report.ts:54-78, 113` — five `.strict()` objects; `:81` documents the rule
   ("`.strict()` is the DOD's 'an undeclared field is rejected by the report layer'").
5. `src/pr/repos.ts:32, 36` and `src/phase-engine/manifest.ts:80, 120, 153` — same chain shape.

Conclusion: for `src/phase-engine/steering.ts` declare the four member objects `.strict()` inside a
`z.discriminatedUnion("action", [...])` (or, if member-level strict is judged insufficiently visible,
four `.strict()` members is still the only v3 way — there is no union-level `.strict()`).

## 7. Bun.spawn house pattern — process with timeout + stdout capture

Two tiers exist in the repo:

**Tier 1 — native timeout (recommended for the resident's bounded call):**
`src/providers/exedev/transport.ts:64-77` — Bun.spawn has built-in `timeout` + `killSignal` options:
```ts
const proc = Bun.spawn({
  cmd, env: process.env,
  stdin: opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
  stdout: "pipe", stderr: "pipe",
  timeout: Math.max(1, opts?.timeoutMs ?? defaultTimeoutMs),
  killSignal: "SIGKILL",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
]);
```
No manual race/AbortSignal needed; `timeout` (ms) + `killSignal: "SIGKILL"` bound the call, and
`new Response(proc.stdout).text()` is the house stdout-capture idiom. `src/phase-engine/roster/validate.ts:607`
uses the same `Bun.spawn(["pi", ...args])` shape for spawning the pi CLI — precedent if the resident
is spawned as a pi subprocess rather than an in-process SDK call.

**Tier 2 — AbortSignal + capped reads (only if abort propagation matters):**
`src/phase-engine/phases/test-results.ts:165-237` — env-scrubbing of provider keys before spawn
(`:177-181`, drops `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` — directly relevant if the resident
process must NOT inherit the orchestrator's keys, though DF2.3 delivers the per-run key INTO the
box so in-box spawning inverts this), capped stream reads (`readCapped`, `:192-193`), SIGTERM→grace→
SIGKILL ladder (`:218-237`). Documented runtime ceiling (ponytail notes `:171-176`, `:222-225`):
Bun.spawn has **no detached/process-group option** — only the lead pid is signalled.

Other conventions:
- `Bun.spawn` takes an **argv array, never a shell string** (`src/providers/harvest.ts:182-184`;
  `src/providers/exedev/driver.ts:435`).
- `Bun.spawn` **throws ENOENT synchronously** when the binary is absent — it does not exit non-zero
  (`src/pr/github.ts:182`, tested at `tests/swarmclaw/agent-mcp-registration.test.ts:258`). The
  resident's "unreachable" degradation path (AC3) must catch the spawn throw, not just check exitCode.
- Driver-level wrapper precedent: `execTimed(vm, argv, timeoutMs, stdin?)` at
  `src/providers/exedev/driver.ts:451` (ssh path; the timeout+SIGKILL contract is documented at
  `src/providers/exedev/transport.ts:47-49`).
- `tests/helpers.ts:74` — test fixture spawn shape (`["sleep","600"]`, all streams ignored).

## Recommendations for the implementer

1. `SteeringDirectiveSchema = z.discriminatedUnion("action", [proceed, retry, select_roster, abort])`
   with each member `z.object({...}).strict()`; `note: z.string().optional()` inside each member.
2. Parse with `safeParse`; on failure read the rejected action from the raw reply (pre-parse) for the
   `residentTripwire` row, and the issue `code` (`invalid_union_discriminator` vs `unrecognized_keys`
   vs `invalid_type`) for `cause`/`detail` — never interpolate raw model text (envelope-parse INV-2 discipline).
3. Type via `z.infer<typeof SteeringDirectiveSchema>`; export it for the journal/telemetry types.
4. If the resident is a subprocess, copy `transport.ts:64-77` verbatim (`timeout`+`killSignal:"SIGKILL"`+
   `Response(proc.stdout).text()`); remember spawn-throw = ENOENT = "unreachable" → degrade (AC3).
5. Do NOT import `zod/v4` — repo is 100% v3-entrypoint (`zod@3.25.76`, `bun.lock:679`).
