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

### Amendments (2026-07-13, PR #25 adversarial review)

- **D1 — Shared-secret IPC auth in `coms.ts`.** A per-session secret is
  generated at registration, stored in the `0700` registry entry, and required
  in every `PromptEnvelope`; receivers nack envelopes whose secret mismatches
  the registry record. This closes the "any local process can drive any agent"
  hole on the socket path. **Windows named-pipe transport is declared
  unsupported** — the extension fails fast on `win32` rather than running
  without filesystem-permission isolation. The threat model (same-user local
  attacker, registry disclosure, spoofed envelopes) is documented with the
  implementation.
- **D2 — `conversation_id` threaded end-to-end** in both `coms.ts` and
  `coms-net.ts`: envelope → inbound context → `sendMessage` details → echoed
  in the response envelope, so peers can correlate multi-turn exchanges.
- **DEC1 — Smoke test runs genuinely live via model override.** Anthropic OAuth
  tokens can expire, so the smoke test no longer depends on ambient pi auth for
  its live turn: set `PI_SMOKE_MODEL` (e.g.
  `openrouter/anthropic/claude-haiku-4.5`) to override the model for the run.
  AC1 is satisfied by **real registrations and real `agent_end` events** — no
  auth-deferral waiver, no in-process shape coverage counting as messages.

## Rationale

- **Lowest day-1 complexity (YAGNI).** Subprocess-RPC needs no extension, no
  sockets, and no shared registry. The JSON event stream is a stable, documented
  contract (`docs/json.md`: `session` header → `agent_start` → `message_*` →
  `agent_end`). Smoke test parsed 2/2 subprocess streams cleanly.
- **Both paths are real and verified where auth permits.** `coms.ts` loads on
  pinned `pi@0.55.0` with zero errors (AC3: `pi -e ./coms.ts --list-models`
  exit 0; 251 models listed at time of run, 2026-07-10 — the count tracks pi's
  catalog and will drift; reproduce via `pi -e ./coms.ts --list-models` or the
  `models_listed` field of the smoke-test report), and its registry contract
  round-trips (2 peers registered + discovered) and its `coms_send` envelope
  shape round-trips through JSON (registry/shape coverage only — not a live
  peer exchange) in the smoke test. The socket path is therefore *ready to
  promote*, not blocked, pending the live peer-exchange verification noted
  below.
- **Auth boundary drove the default, not viability.** A live model round-trip
  (subprocess `agent_end`, or a full socket `coms_send → coms_await`) requires pi
  auth, which was unavailable in the original build environment (oauth token
  expired, no API key in shell). The subprocess-RPC transport parse and the
  socket registry contract were both verified *without* a live turn on
  2026-07-10; the live turn was the only piece deferred (never faked). DEC1
  (above) has since closed that deferral: `PI_SMOKE_MODEL` overrides the model
  so the live turn runs against any provider with a working key, independent of
  expiring Anthropic OAuth. Subprocess-RPC still reaches useful behavior with
  the least additional surface, so it remains the pragmatic day-1 default.

## Coms contract (socket-coms verbs — as vendored)

`response_schema` is **parse-only**: on `agent_end` the receiver runs
`JSON.parse(lastAssistantText)` when a `response_schema` is present and returns
`error: "response not valid JSON"` on failure. It is **NOT** validated against the
schema (PRD §5.2; `coms.ts:2040-2052`).

| Verb | Signature | Behavior |
|------|-----------|----------|
| `coms_send` | `coms_send(target: string, prompt: string, conversation_id?: string, response_schema?: object)` | Sends a prompt envelope to a peer (`target` = peer name, scoped to project, or `session_id`, global). Returns a `msg_id` once the receiver acks. Throws if unreachable / hop limit reached. |
| `coms_await` | `coms_await(msg_id: string, timeout_ms?: number)` | Blocks until the reply for `msg_id` lands or the timeout fires. Default timeout **30 min** (`PI_COMS_TIMEOUT_MS = 1_800_000`, `coms.ts:42`). |
| `coms_get` | `coms_get(msg_id: string)` | Non-blocking poll; returns status `pending` \| `complete` \| `error` and (when complete) the response. |
| `coms_list` | `coms_list(project?: string, include_explicit?: boolean)` | Lists live peer agents (names, models, context usage). `project="*"` scans all projects; `include_explicit=true` reveals `--explicit` agents. |

Identity flags registered by the extension at load (`pi.registerFlag`): `--cname`,
`--purpose`, `--project`, `--color`, `--explicit`.

## Constraints

- **Pin:** `@mariozechner/pi-coding-agent@0.55.0` (host-installed; vendor
  `package.json` records the pin). Extension load verified against it (AC3 green).
- **Timeout:** `coms_await` default 30 min (`PI_COMS_TIMEOUT_MS = 1_800_000`,
  `coms.ts:42`). Override per-call via `timeout_ms`.
- **Relay:** `MAX_HOPS = 5` (`coms.ts:41`) — `coms_send` throws once the hop count
  reaches the limit.
- **INV-1 (test keys only):** the smoke test reads/writes/logs **no** API keys;
  the live turn selects its model via `PI_SMOKE_MODEL` and uses whatever auth
  pi already holds for that provider. No secrets in fixtures.
- **INV-2 (per-user socket scope):** registry files live under
  `~/.pi/coms/projects/<project>/agents/` (`COMS_DIR`, `coms.ts:40`, chmod
  `0700`). Sockets bind at `~/.pi/coms/sockets/<sessionId>.sock` when that path
  fits the 100-byte `sun_path` budget (`makeEndpoint`, `coms.ts:253-256`),
  otherwise at `$TMPDIR/pi-coms-<uid>/<sessionId>.sock` (`os.tmpdir()`, per-uid
  dir, `coms.ts:263`); the socket dir is chmod `0700` at bind time
  (`coms.ts:1131-1132`). Both locations are per-user. The smoke test
  writes only to an isolated per-run `PI_COMS_DIR` temp dir and never mutates
  the host registry — no cross-user leakage.
- **Live turn (DEC1):** the smoke test's live round-trip runs via model
  override — set `PI_SMOKE_MODEL` (e.g. `openrouter/anthropic/claude-haiku-4.5`)
  so AC1 does not depend on ambient (possibly expired) Anthropic OAuth. AC1 is
  green only on real registrations + real `agent_end` events.
- **Platform (D1):** socket-coms is POSIX-only. `coms.ts` fails fast on
  `win32` (`session_start`, `coms.ts:1035-1038` — named pipes lack
  filesystem-permission isolation for the shared secret); subprocess-RPC is
  unaffected and remains the cross-platform path.

## Evidence

Run `bun scripts/coms-smoke-test.ts` (structured JSON report; exit 0 only when
AC1 is backed by a real message exchange, not registry/shape coverage alone).
Per DEC1, run it live with a model override:

```sh
PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5 bun scripts/coms-smoke-test.ts
```

Run of record, 2026-07-10 (pre-DEC1, ambient pi auth unavailable):

```text
agents_registered: 4  (2 subprocess-RPC streams + 2 socket-coms peers)
messages_exchanged: 0  (no live coms_send/coms_await or agent_end round-trip —
                        pi auth unavailable in the build environment)
AC1 (>=2 agents, >=1 msg): false  — blocked on restored pi auth, not on either
                                     transport's viability
AC3 (extension loads, exit 0): true  (251 models listed at time of run;
                                      reproduce via `pi -e ./coms.ts --list-models`)
rpc_live_round_trip: SKIPPED — pi auth unavailable (superseded by DEC1's
                               PI_SMOKE_MODEL override; no waiver remains)
socket_envelope_shape_coverage: true — envelope shape round-trips through JSON;
                                        coverage only, does not count as a message
inv2_per_user_isolation: registry confined to per-run temp dir
```

Post-DEC1, the same command with `PI_SMOKE_MODEL` set exercises the live turn
for real: AC1 is green only when it is backed by real registrations and real
`agent_end` events — no auth-deferral waiver path remains.

AC1 was previously (incorrectly) reported `true` off a self-serialized,
in-process JSON round-trip on the socket-coms path that never touched a real
peer. That accounting bug is fixed (`socket_envelope_shape_coverage` no longer
contributes to `messages_exchanged`). This does not change the Decision above —
both transports' non-live behavior (extension load, registry contract, JSON
stream parsing) was independently verified either way.
