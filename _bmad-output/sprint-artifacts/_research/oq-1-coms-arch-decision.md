# OQ-1: Pi In-Node Coms Architecture Decision

**Status:** DECIDED
**Date:** 2026-07-10
**Story:** p0-2-coms-vendor-decision
**Spec refs:** PRD §4.6 (Pi team coms contract), FR-EX-1, FR-EX-2, G1; PRD §13 Phase-0 clause 2

## Context

QDS-Factory runs teams of Pi agents that must exchange messages peer-to-peer
with structured replies (FR-EX-1, FR-EX-2). Two substrates are available on
pinned `pi@0.55.0`:

1. **Socket-coms** — the vendored `coms.ts` extension. Agents bind a per-session
   unix socket and register in a per-project registry under
   `~/.pi/coms/projects/<project>/agents/<name>.json`. Peers discover each other
   via the registry and exchange `prompt`/`response` envelopes over the sockets.
   Loaded with `pi -e ./coms.ts`.
2. **Subprocess-RPC** — spawn `pi --mode json -p "<prompt>"` (or `--mode rpc` for
   a persistent stdin/stdout channel) and parse pi's JSON event stream. No
   extension, no sockets, no shared registry; the parent process orchestrates.

This story vendors the coms extensions, smoke-tests both substrates on the pinned
runtime, and records which is the day-1 default.

### Vendor provenance

- **Source:** `https://github.com/disler/pi-vs-claude-code`
- **Path:** `extensions/` → `coms.ts`, `coms-net.ts` (+ local `themeMap.ts` import)
- **Commit:** `0ed11f44932fdef29bd98467700019762298f50d` (2026-07-10T16:09:59Z)
- **Vendored to:** `pi-vs-claude-code-vendor/` (see its `package.json` `_provenance`)
- Pi runtime pin `@mariozechner/pi-coding-agent@0.55.0` is enforced by the host
  install (`/usr/local/bin/pi` → `.../pi-coding-agent@0.55.0`) and recorded in the
  vendor `package.json` `peerDependencies` / `engines`.

## Options

### Option A — Socket-coms (`coms.ts`) as primary substrate

Symmetric peer-to-peer: any registered agent can `coms_send` to any peer and
`coms_await` the reply; N agents form a live mesh discoverable via `coms_list`.

- **Pros:** true peer-to-peer; live pool widget; hop-limited relay (`MAX_HOPS=5`);
  long-lived agents; structured `response_schema` capture on `agent_end`.
- **Cons:** requires a booted interactive/RPC pi session per agent (the
  `session_start` lifecycle that binds the socket + writes the registry only fires
  once a session initializes, which needs valid auth); more moving parts (sockets,
  registry files, keepalive/ping cycles); per-user socket scope must be respected.

### Option B — Subprocess-RPC (`pi --mode json -p`) as primary substrate

Parent-orchestrated star: the orchestrator spawns pi subprocesses and reads their
JSON event streams; agents do not talk to each other directly.

- **Pros:** zero extra code (no `coms.ts` needed); trivially observable (one JSON
  line per event); no shared mutable state; easiest to sandbox and reason about;
  works headless.
- **Cons:** no direct peer-to-peer (all traffic routes through the parent); each
  `-p` invocation is a fresh process (no persistent agent identity unless
  `--mode rpc` is used); structured replies are the parent's responsibility.

## Decision

**Subprocess-RPC (`pi --mode json -p` / `--mode rpc`) is the day-1 default.**
**Socket-coms (`coms.ts`) is a vendored, load-verified, viable alternative**
promoted when true peer-to-peer messaging between long-lived agents is required.

## Rationale

- **Lowest day-1 complexity (YAGNI).** Subprocess-RPC needs no extension, no
  sockets, and no shared registry. The JSON event stream is a stable, documented
  contract (`docs/json.md`: `session` header → `agent_start` → `message_*` →
  `agent_end`). Smoke test parsed 2/2 subprocess streams cleanly.
- **Both paths are real and verified where auth permits.** `coms.ts` loads on
  pinned `pi@0.55.0` with zero errors (AC3: `pi -e ./coms.ts --list-models`
  exit 0, 251 models listed), and its registry contract round-trips (2 peers
  registered + discovered, `coms_send` envelope round-tripped with a parse-only
  reply) in the smoke test. The socket path is therefore *ready to promote*, not
  blocked.
- **Auth boundary drove the default, not viability.** A live model round-trip
  (subprocess `agent_end`, or a full socket `coms_send → coms_await`) requires pi
  auth, which was unavailable in the build environment (oauth token expired, no
  API key in shell). The subprocess-RPC transport parse and the socket registry
  contract were both verified *without* a live turn; the live turn is the only
  piece deferred (marked `skip` + `TODO(goal): pi auth unavailable`, never faked).
  Subprocess-RPC reaches useful behavior with the least additional surface once
  auth is restored, so it is the pragmatic day-1 default.

## Coms contract (socket-coms verbs — as vendored)

`response_schema` is **parse-only**: on `agent_end` the receiver runs
`JSON.parse(lastAssistantText)` when a `response_schema` is present and returns
`error: "response not valid JSON"` on failure. It is **NOT** validated against the
schema (PRD §5.2; `coms.ts:1502`).

| Verb | Signature | Behavior |
|------|-----------|----------|
| `coms_send` | `coms_send(target: string, prompt: string, conversation_id?: string, response_schema?: object)` | Sends a prompt envelope to a peer (`target` = peer name, scoped to project, or `session_id`, global). Returns a `msg_id` once the receiver acks. Throws if unreachable / hop limit reached. |
| `coms_await` | `coms_await(msg_id: string, timeout_ms?: number)` | Blocks until the reply for `msg_id` lands or the timeout fires. Default timeout **30 min** (`PI_COMS_TIMEOUT_MS = 1_800_000`, `coms.ts:32`). |
| `coms_get` | `coms_get(msg_id: string)` | Non-blocking poll; returns status `pending` \| `complete` \| `error` and (when complete) the response. |
| `coms_list` | `coms_list(project?: string, include_explicit?: boolean)` | Lists live peer agents (names, models, context usage). `project="*"` scans all projects; `include_explicit=true` reveals `--explicit` agents. |

Identity flags registered by the extension at load (`pi.registerFlag`): `--cname`,
`--purpose`, `--project`, `--color`, `--explicit`.

## Constraints

- **Pin:** `@mariozechner/pi-coding-agent@0.55.0` (host-installed; vendor
  `package.json` records the pin). Extension load verified against it (AC3 green).
- **Timeout:** `coms_await` default 30 min (`PI_COMS_TIMEOUT_MS = 1_800_000`,
  `coms.ts:32`). Override per-call via `timeout_ms`.
- **Relay:** `MAX_HOPS = 5` (`coms.ts:31`) — `coms_send` throws once the hop count
  reaches the limit.
- **INV-1 (test keys only):** the smoke test reads/writes/logs **no** API keys; the
  deferred live turn uses whatever auth pi already holds. No secrets in fixtures.
- **INV-2 (per-user socket scope):** socket + registry files live under
  `~/.pi/coms/` (chmod `0700`), per-user. The smoke test writes only to an
  isolated per-run `PI_COMS_DIR` temp dir and never mutates the host registry —
  no cross-user leakage.
- **Auth gate (open follow-up):** a live end-to-end message round-trip on either
  path awaits restored pi auth. Tracked as `TODO(goal): pi auth unavailable` in
  `scripts/coms-smoke-test.ts` (`rpc_live_round_trip` auto-skips, never fakes).

## Evidence

Run `bun scripts/coms-smoke-test.ts` (structured JSON report, exit 0 on pass):

```
agents_registered: 4  (2 subprocess-RPC streams + 2 socket-coms peers)
messages_exchanged: 1  (socket-coms coms_send envelope round-trip)
AC1 (>=2 agents, >=1 msg): true
AC3 (extension loads, exit 0): true  (251 models listed)
rpc_live_round_trip: SKIPPED — TODO(goal): pi auth unavailable
inv2_per_user_isolation: registry confined to per-run temp dir
```
