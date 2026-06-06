# P0.3: `pi-team-launch.sh` mixed-model team emits one merged JSON node-output

**Story Points:** 4

## Spec Reference

- PRD §6.4 (Execution — Pi team / coms / pi-lens); FR-EX-3, FR-EX-6 (with FR-EX-1, FR-EX-2 exercised as launch+coms substrate)
- PRD §4.6 (`pi-team-launch.sh` stdout protocol); §5.5 Phase-0 item 3
- Phase exit gate: PRD §13 Phase-0 clauses 1 ("`pi-team-launch.sh "refactor X" ./ctx` returns a single merged JSON object on stdout") and 2 ("Run logs show ≥2 named agents exchanging ≥2 coms … messages")

## User Story

As an Operator standing up the Dark Code Factory execution layer,
I want a launcher that runs a guarded 3-agent mixed-model Pi team and emits exactly one merged JSON object to stdout,
so that an Archon bash node has a single live entry point that yields one structured node-output from a real team (G1 lights-out execution; G2 auditability).

## Overview

This slice authors `pi-team-launch.sh` (does NOT exist on disk — §5.5 item 3 / R4 §5) and cuts vertically through: launcher CLI → 3 named `pi` subprocesses (`--cname <run-id>-<role>`, mixed providers: 1 Anthropic-native judgment role + 2 OpenRouter constrained roles, GLM + Kimi) → in-node coms exchange → lead schema-validates each worker reply (coms `response_schema` is parse-only, §4.6/R4 §1) → lead merges into a single JSON object with mandatory `changed_files: string[]` → launcher validates the merged object and writes it (and ONLY it) to stdout; all logs/diagnostics go to stderr (Archon captures stdout verbatim as node output, `dag-executor.ts:1361-1368`). Hard guards (budget/turn/wall-clock/`coms_await` timeout) are spawned-and-owned here but the loopy-kill PROOF is the dependent slice P0.4. This is one atomic 4-pt unit because the merged-JSON-to-stdout capability is not demonstrable until launch + coms + lead-validation + merge + stdout-discipline all run together; splitting any leaves leftover wiring.

## E2E Slice

**Demonstrable behavior:** `pi-team-launch.sh --task "refactor X" --context-path ./ctx --archetype C --role-model architect=anthropic/claude-opus-4 --role-model impl=openrouter/z-ai/glm-4.6 --role-model reviewer=openrouter/moonshotai/kimi-k2 --budget-cap-cents 50 --turn-cap 12 --wall-clock-cap-ms 480000` runs a live 3-agent mixed-model team; stdout is exactly ONE JSON object parseable by `jq -e .` carrying `changed_files` (string[]), `result`, `partial` (bool), `exit_class`; the stderr log shows ≥2 named agents (`<run-id>-architect`, `<run-id>-impl`, …) exchanging ≥2 coms messages.

**Wiring closed:** On completion of this story, `pi-team-launch.sh --task "refactor X" --context-path ./ctx …` produces a single `jq`-parseable merged JSON object on stdout (with `changed_files: string[]`) and a stderr log evidencing ≥2 named agents exchanging ≥2 coms messages, using only code merged by this story (the launcher script, the lead merge+validate logic, the per-role spawn/cname wiring). No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** P0.1 (Archon env patch — supplies the per-node `env` channel the bash node uses to pass `--role-model`/cap flags downstream; reference contract here, exercised when wired under a DAG). P0.2 (vendored `coms.ts` + recorded OQ-1/OQ-5 in-node-architecture decision — the launcher consumes whichever path P0.2 selected: socket-coms or subprocess-RPC).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a live API key for the Anthropic role and an OpenRouter key for the GLM/Kimi roles, When `pi-team-launch.sh --task "refactor X" --context-path ./ctx --archetype C --role-model architect=anthropic/claude-opus-4 --role-model impl=openrouter/z-ai/glm-4.6 --role-model reviewer=openrouter/moonshotai/kimi-k2 --budget-cap-cents 50 --turn-cap 12 --wall-clock-cap-ms 480000` is run, Then **stdout contains exactly one JSON object** (`jq -e 'has("changed_files") and (.changed_files|type=="array")' ` exits 0; `jq -e . | wc -l` confirms a single top-level value), AND the stderr run-log shows **≥2 distinct `--cname` agents exchanging ≥2 coms messages** (grep for ≥2 `coms_send`/`coms_await` lines naming ≥2 `<run-id>-<role>` identities).
2. Given each of the three roles uses its assigned provider, When the lead receives each worker's `coms_await` reply, Then the lead **explicitly schema-validates** the reply before accepting it (parse-only coms ⇒ lead validates, §4.6/R4 §1); a reply missing the mandatory `changed_files: string[]` field causes the lead to re-request or **fail the node as a logic error** (logged `exit_class:"logic"`), never silently accept it.
3. Given the lead-merged object fails the launcher's final merged-schema validation, When the launcher is about to write stdout, Then the launcher **writes nothing to stdout and exits non-zero** (no partial/invalid JSON ever reaches the node-output channel), with the validation failure logged to stderr.

## Technical Notes

- **Contracts/Schema:** Merged-output JSON contract (the node-output) = `{ changed_files: string[] (set-union of all workers, mandatory), result: object, partial: boolean, exit_class: "transient"|"overflow"|"logic", waivers: object[] }`. Each worker `response_schema` MUST carry `changed_files: string[]` (omission = node failure, CORRECTNESS-C). Express as a TS/Zod contract used by the lead validator and the launcher final-gate validator. Backward-compat: net-new file, no existing node-output consumers to break.
- **Integration points (each wired & exercised in this story):** (1) per-role `pi` subprocess spawn with `--cname <run-id>-<role>` (extension flag `coms.ts:536`; fallback chain frontmatter `name:` → `agent-<6chars>`); (2) `--role-model <role>=<provider/model>` repeatable, GLM/Kimi forced via `openrouter`, Anthropic native (R4 §9 — Pi natively supports ONLY anthropic+openrouter); (3) in-node coms exchange via the P0.2-selected path; (4) lead per-reply schema validation → launcher final merged-object validation → single stdout write (Archon captures stdout verbatim `dag-executor.ts:1361-1368`, logs→stderr `:1370-1378`); (5) `--append-system-prompt` per-role system prompts; (6) `--context-path` carries the Mulch/Seeds bundle.
- **Files / functions touched:** new `scripts/pi-team-launch.sh` (orchestrates spawn/cname/role-model/stdout-discipline); new `src/launcher/merge-output.ts` (lead merge + Zod validate); new `src/launcher/output-contract.ts` (Zod schema + TS type).
- **Guards/limits:** `--budget-cap-cents`, `--turn-cap`, `--wall-clock-cap-ms` (MUST be ≤ the bash node's own `timeout`, `dag-node.ts:181`), `coms_await` per-call timeout (`PI_COMS_TIMEOUT_MS`, default 30 min `coms.ts:32`; TDD-Trio recommended start 8 min). Guards are spawned/owned by the launcher process here; the loopy-prompt KILL PROOF is P0.4 (this story wires the guards; P0.4 demonstrates the kill).
- **HONESTY (R4):** coms live 2-agent round-trip needs a paid LLM turn + API key (only contract-load is proven). This story's make-or-break AC is the live-confirm — it cannot pass without keys present; if keys are absent at run time, the slice is blocked-on-creds and that is recorded, not papered over.

## Files to Modify

- `scripts/pi-team-launch.sh`
- `src/launcher/output-contract.ts`
- `src/launcher/merge-output.ts`
- `src/launcher/spawn-role.ts`
- `tests/launcher/merge-output.test.ts`
- `tests/launcher/e2e-mixed-model.test.ts`

## Security Invariants

> Triggers: secrets/env, cost/budget. Concrete named invariants only.

- **INV-1 (secrets/env):** API keys (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) are read from the environment / env-merge passed in by the bash node (`env: { ...process.env, ...node.env }`), **never** hardcoded in `pi-team-launch.sh` or written to stdout, the merged JSON, or any logged line (NFR-SEC-1). The launcher redacts any value matching a key pattern before logging to stderr.
- **INV-2 (secrets/env, stdout discipline):** Only the validated merged JSON object is written to stdout; all subprocess logs, coms traces, and diagnostics go to **stderr** — no secret-bearing subprocess log can leak onto the node-output channel.
- **INV-3 (cost/budget):** Every Pi role's spend is bounded by the launcher-owned `--budget-cap-cents`; the launcher passes per-role caps into each subprocess and never delegates the cap to the agent (the agent cannot lift its own ceiling). Cap-enforcement under a loopy prompt is the dependent proof in P0.4.
- **INV-4 (provider routing):** GLM/Kimi roles are forced through `openrouter` (never a forged "anthropic" provider for a non-Anthropic model), so per-role provider attribution stays truthful for the downstream `cost_events` emitter.

## Definition of Done

- [ ] **Impl:** `pi-team-launch.sh` spawns 3 roles as distinct `pi` subprocesses, each named `--cname <run-id>-<role>` with its `--role-model <provider/model>` and `--append-system-prompt`.
- [ ] **Impl:** Lead role schema-validates each worker `coms_await` reply (parse-only coms ⇒ explicit validation), re-requests or fails-as-logic-error on an invalid/`changed_files`-missing reply.
- [ ] **Impl:** Launcher writes ONLY the validated merged JSON to stdout; all else to stderr; non-zero exit + no stdout on final-validation failure.
- [ ] **Contract:** Zod schema + TS type for the merged node-output (`changed_files: string[]` mandatory union, `result`, `partial`, `exit_class`, `waivers`) added with field-level validation.
- [ ] **Integration:** `--role-model` mixed-provider wiring exercised — 1 Anthropic-native + 2 OpenRouter (GLM, Kimi) roles each run on their assigned provider in a real launch.
- [ ] **Integration:** In-node coms exchange wired over the P0.2-selected path (socket-coms or subprocess-RPC), with ≥2 named agents exchanging ≥2 messages evidenced in the stderr log.
- [ ] **Security:** No secret value appears in stdout, the merged JSON, or stderr logs (redaction verified); per-role budget cap injected by the launcher, not delegated.
- [ ] **Observability:** stderr run-log records each named agent identity (`<run-id>-<role>`), each coms message, and the chosen per-role provider/model for later audit-chain hop 8.
- [ ] **Test (unit/integration):** `merge-output` validator accepts a valid 3-worker union and rejects a reply missing `changed_files` (logic-error path) and an over-cap/invalid merged object (no-stdout path).
- [ ] **Test (e2e demo — MANDATORY):** Fires `pi-team-launch.sh --task "refactor X" --context-path ./ctx …` with live keys; asserts stdout is exactly one `jq`-parseable JSON object carrying `changed_files: string[]` AND the stderr log shows ≥2 named agents exchanging ≥2 coms messages (proves §13 Phase-0 clauses 1+2, wiring closed). If keys are absent the test records BLOCKED-on-creds rather than a false pass.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
