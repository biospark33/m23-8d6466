# OQ-1: Pi In-Node Coms Architecture Decision

**Status:** DECIDED
**Date:** 2026-07-13
**Amended 2026-07-13:** D1 IPC-auth hardening recorded (secret echo on
responses, 0600 registry files, replay tombstones, best-effort chmod
reconciled); Evidence refreshed with the post-remediation live run of record;
OQ-5 (pi 0.55.0 vs coms.ts 0.73+ version skew) section added.
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
  vendor `package.json` `peerDependencies`.

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
  the registry record (constant-time compare, so a same-user attacker can't
  probe the secret byte-by-byte). This closes the "any local process can drive
  any agent" hole on the socket path. **Windows named-pipe transport is
  declared unsupported** — the extension fails fast on `win32` rather than
  running without filesystem-permission isolation.
  - **Residual threat model (honest scope):** the secret scheme stops
    accidental cross-project driving and raises the bar for casual local
    tampering. It does **not** defend against a determined same-user process:
    such an attacker can read their own `0700` registry dir, harvest the
    secrets, and forge envelopes. Per-user filesystem permissions are the
    primary boundary; the secret is defense-in-depth on top.
  - **Follow-ups now implemented:** responses carry a secret echo verified
    constant-time on the sender side — a harvested `msg_id` alone can't forge
    a reply, and mismatches are audit-logged as `forged_response`
    (`handleResponse`, ~`coms.ts:1223-1243`); registry *files* are chmod
    `0600`, not just the `0700` dir (~`coms.ts:482, 510`); fulfilled `msg_id`s
    are tombstoned for 1h so replays can't inject a second turn
    (`fulfilledMsgIds`, ~`coms.ts:1005, 1060-1087`).
  - **Chmod behavior (reconciled):** all chmods are **best-effort** — a chmod
    failure is tolerated, not fail-fast, because the `0700` directory is the
    primary boundary and the `0600` file mode only hardens against permissive
    umasks or pre-existing dirs. (Any earlier "POSIX fail-fast" claim for
    chmod is withdrawn; only the `win32` platform check fails fast.)
- **D2 — `conversation_id` threaded end-to-end** in both `coms.ts` and
  `coms-net.ts`: envelope → inbound context → `sendMessage` details → echoed
  in the response envelope, so peers can correlate multi-turn exchanges.
- **DEC1 — Smoke test runs genuinely live via model override.** Anthropic OAuth
  tokens can expire, so the smoke test no longer depends on ambient pi auth for
  its live turn: set `PI_SMOKE_MODEL` (e.g.
  `openrouter/anthropic/claude-haiku-4.5`) to override the model for the run.
  AC1 is satisfied per its OR-clause — "**`coms_send` → `coms_await` succeeds,
  or subprocess-RPC JSON parse succeeds**" — by **real registrations and real
  `agent_end` events**: no auth-deferral waiver, no in-process shape coverage
  counting as messages. The 2026-07-13 run of record (Evidence below)
  satisfied **both** clauses: the socket live round-trip passed with
  `PI_SMOKE_STRICT=1` making it gating, and 2/2 subprocess-RPC `agent_end`
  round-trips completed.

## Rationale

- **Lowest day-1 complexity (YAGNI).** Subprocess-RPC needs no extension, no
  sockets, and no shared registry. The JSON event stream is a stable, documented
  contract (`docs/json.md`: `session` header → `agent_start` → `message_*` →
  `agent_end`). Smoke test parsed 2/2 subprocess streams cleanly (2026-07-13
  run of record: `rpc_stream_parse` ok).
- **Both paths are real and verified.** `coms.ts` loads on pinned `pi@0.55.0`
  with zero errors (AC3: `pi -e ./coms.ts --list-models` exit 0 with a
  non-empty model listing — 251 models at the 2026-07-13 run; the count tracks
  provider catalogs and drifts, so no pass/fail evidence hinges on the frozen
  number — reproduce via `pi -e ./coms.ts --list-models` or the `models_listed`
  field of the smoke-test report). On the socket path, the 2026-07-13 run of
  record exercised a **live peer exchange**: 2 peers registered by coms.ts's
  own `session_start`, a `coms_send` acked, and `coms_await` returned the
  reply (`"pong"`) with a real `agent_end` on the sender's stream — see the
  Evidence run of record below. The socket path is therefore *ready to
  promote*, not blocked.
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

`response_schema` is **parse-only**: on `agent_end` the receiver first unwraps
a ```` ```json ```` code fence if the assistant text is wrapped in one, then
runs `JSON.parse` when a `response_schema` is present, returning
`error: "response not valid JSON"` on failure. It is **NOT** validated against
the schema (PRD §5.2; `agent_end` handler, ~`coms.ts:2629-2635`). Response
envelopes carry the receiver's `secret` echo (verified constant-time by the
original sender; `secretEqual` ~`coms.ts:359`, `handleResponse`
~`coms.ts:1231-1243`) and the prompt's `conversation_id`.

| Verb | Signature | Behavior |
|------|-----------|----------|
| `coms_send` | `coms_send(target: string, prompt: string, conversation_id?: string, response_schema?: object)` | Sends a prompt envelope (carrying the target's registry `secret`) to a peer. `target` resolution precedence (`resolveTarget`, ~`coms.ts:2103`): **name within the caller's project → `session_id` across all projects → name across all projects**. Returns a `msg_id` once the receiver acks. Throws if unreachable, if the target has no registry secret, or once the hop limit is reached. |
| `coms_await` | `coms_await(msg_id: string, timeout_ms?: number)` | Blocks until the reply for `msg_id` lands or the timeout fires. Default timeout **30 min** (`PI_COMS_TIMEOUT_MS = 1_800_000`, `coms.ts:50`). Unknown `msg_id` returns an **error result** (`details.error = "unknown msg_id"` — not a throw); timeout resolves with an error result (`details.error = "timeout"`); a second concurrent `coms_await` on the same `msg_id` throws. On success the result details include `conversation_id` (D2). |
| `coms_get` | `coms_get(msg_id: string)` | Non-blocking poll; returns status `pending` \| `complete` \| `error` and (when complete) the response. Unknown `msg_id` returns status `error`. Result details include `conversation_id` when present. |
| `coms_list` | `coms_list(project?: string, include_explicit?: boolean)` | Lists live peer agents (names, models, context usage). `project="*"` scans all projects; `include_explicit=true` reveals `--explicit` agents. |

Fixed limits and env knobs: `MAX_HOPS = 5` is a **fixed constant**
(`coms.ts:49`; prompts with `hops >= MAX_HOPS` are nacked) — not env-tunable.
`PI_COMS_TIMEOUT_MS` (default 30 min) is the **sender-side** `coms_await`
default. `PI_COMS_TURN_DEADLINE_MS` (default 30 min, `coms.ts:54`) is the
**receiver-side** deadline: an injected turn that never completes (session
abort, `sendMessage` no-op after ack) is pruned from the inbound queue after
it (~`coms.ts:1793`), so a dead turn can't leak its entry.

Identity flags registered by the extension at load (`pi.registerFlag`): `--cname`,
`--purpose`, `--project`, `--color`, `--explicit`.

## Constraints

- **Pin:** `@mariozechner/pi-coding-agent@0.55.0` (host-installed; vendor
  `package.json` records the pin). Extension load verified against it (AC3 green).
- **Timeout:** `coms_await` default 30 min (`PI_COMS_TIMEOUT_MS = 1_800_000`,
  `coms.ts:50`). Override per-call via `timeout_ms`. Receiver-side turn
  deadline `PI_COMS_TURN_DEADLINE_MS` (default 30 min, `coms.ts:54`).
- **Relay:** `MAX_HOPS = 5` (`coms.ts:49`, fixed constant) — `coms_send`
  throws once the hop count reaches the limit.
- **INV-1 (scoped child env + redaction; no test-key sandbox):** the smoke test
  uses pi's **ambient configured auth** — the live turn selects its model via
  `PI_SMOKE_MODEL` (consumed by the parent, passed as `--model`, never
  forwarded to children) and uses whatever auth pi already holds for that
  provider; there is no test-key sandbox. Primary mitigation: spawned pi
  children receive a **scoped env allowlist** (`smokeChildEnv()` in
  `scripts/coms-smoke-test.ts`) — basics
  (PATH/HOME/USER/LOGNAME/SHELL/TERM/LANG/LC_*/TMPDIR/TMP/TEMP), the
  per-spawn `PI_COMS_DIR`/`PI_COMS_TIMEOUT_MS` knobs, and **only the provider
  key the selected model needs** (google forwards both `GOOGLE_API_KEY` and
  `GEMINI_API_KEY`) — so unrelated live API keys never enter child processes.
  Fallback: when no provider key can be identified (no `PI_SMOKE_MODEL`,
  unknown provider prefix, or the key is unset), children get the full parent
  env; the choice is disclosed per-run via the report's `env_scope` field.
  Residual caveat: `HOME` is forwarded, so pi's on-disk credential store
  under `~/.pi` remains readable by the child — env-var scoping does not
  sandbox file-based auth. Redaction of captured output (`redact()`; report
  field `"redaction": "env-secret-values"`) remains defense-in-depth. No
  secrets appear in fixtures.
- **INV-2 (per-user socket scope):** registry files live under
  `~/.pi/coms/projects/<project>/agents/` (`COMS_DIR`, `coms.ts:45`, dir
  chmod `0700`, registry files chmod `0600`, both best-effort). Sockets bind
  at `~/.pi/coms/sockets/<sessionId>.sock` when that path fits the 100-byte
  `sun_path` budget (`makeEndpoint`, ~`coms.ts:310-328`), otherwise at
  `$TMPDIR/pi-coms-<uid>/<sessionId>.sock` (`os.tmpdir()`, per-uid dir,
  ~`coms.ts:325-327`); the socket dir is chmod `0700` at bind time
  (~`coms.ts:1551-1552`). Both locations are per-user. The smoke test
  writes only to an isolated per-run `PI_COMS_DIR` temp dir and never mutates
  the host registry — no cross-user leakage.
- **Live turn (DEC1):** the smoke test's live round-trip runs via model
  override — set `PI_SMOKE_MODEL` (e.g. `openrouter/anthropic/claude-haiku-4.5`)
  so AC1 does not depend on ambient (possibly expired) Anthropic OAuth. AC1 is
  green only on real registrations + real `agent_end` events; the strict gate
  is the default (socket live round-trip gating; `PI_SMOKE_STRICT=0` waives it
  with a loud `pass_with_waiver` flag) — the 2026-07-13 run of record passed
  in strict mode.
- **Platform (D1):** socket-coms is POSIX-only. `coms.ts` fails fast on
  `win32` (`session_start`, ~`coms.ts:1430` — named pipes lack
  filesystem-permission isolation for the shared secret); subprocess-RPC is
  unaffected and remains the cross-platform path.
- **coms-net server redelivery contract:** client-side fulfilled-`msg_id`
  tombstones expire after 1h (`fulfilledMsgIds` in `coms-net.ts`). The hub
  server must therefore not redeliver a prompt beyond that 1h window — or, if
  its replay window is longer, deliveries must carry a delivery epoch so
  clients can dedupe past the tombstone TTL. Within the window, redelivered
  prompts are deduped by the tombstone set and never inject a second turn.

## OQ-5 — pi 0.55.0 vs coms.ts 0.73+ version skew

**Decision:** the vendored `coms.ts`/`coms-net.ts` load and run on pinned
`pi@0.55.0`; the `pi@0.55.0` pin stands. No pi upgrade to match coms.ts's
0.73+ comment target is required for Phase 0.

**Evidence:** the AC3 extension-load checks in the 2026-07-13 smoke run of
record — `pi -e ./coms.ts --list-models` and `pi -e ./coms-net.ts
--list-models` both exit 0 with a non-empty model listing (251 models at time
of run) and no extension-load errors on stderr. The smoke test now asserts
this explicitly (`ac3_extension_loads_coms`, `ac3_extension_loads_coms_net`).

**Residual risk:** coms.ts's upstream comments target pi 0.73+; the vendored
copy is verified against 0.55.0 only. Re-verify (extension load + smoke run)
on any pi upgrade.

## Evidence

Run `bun scripts/coms-smoke-test.ts` (structured JSON report; exit 0 only when
AC1 is backed by a real message exchange, not registry/shape coverage alone).
Per DEC1, run it live with a model override; `PI_SMOKE_STRICT=1` additionally
makes the socket live round-trip gating:

```sh
PI_SMOKE_STRICT=1 PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5 bun scripts/coms-smoke-test.ts
```

Run of record, 2026-07-10 (pre-DEC1, ambient pi auth unavailable) —
**superseded by the 2026-07-13 run below; kept for history only:**

```text
agents_registered: 4  (2 subprocess-RPC streams + 2 socket-coms peers)
messages_exchanged: 0  (no live coms_send/coms_await or agent_end round-trip —
                        pi auth unavailable in the build environment)
AC1 (>=2 agents, >=1 msg): false  — blocked on restored pi auth, not on either
                                     transport's viability
AC3 (extension loads, exit 0): true  (non-empty model listing; 251 models at
                                      time of run — count drifts with provider
                                      catalogs; reproduce via
                                      `pi -e ./coms.ts --list-models`)
rpc_live_round_trip: SKIPPED — pi auth unavailable (superseded by DEC1's
                               PI_SMOKE_MODEL override; no waiver remains)
socket_envelope_shape_coverage: true — envelope shape round-trips through JSON;
                                        coverage only, does not count as a message
inv2_per_user_isolation: registry confined to per-run temp dir
```

Run of record, 2026-07-13 (post-remediation; `PI_SMOKE_STRICT=1
PI_SMOKE_MODEL=openrouter/anthropic/claude-haiku-4.5`) — raw JSON:
`_bmad-output/sprint-artifacts/_research/oq-1-smoke-run-2026-07-13.json`:

```text
agents_registered: 4  (2 subprocess-RPC streams + 2 socket-coms peers)
messages_exchanged: 3
pass: true
gate_note: "PI_SMOKE_STRICT=1: socket_live_round_trip is gating"
redaction: "env-secret-values"
checks (all ok):
  pi_version_pin: "found \"0.55.0\""
  ac3_extension_loads_coms: "exit=0, header=true, models_listed=251"
  ac3_extension_loads_coms_net: "exit=0, header=true, models_listed=251"
  socket_peer_b_ready: "smoke-b accepting connections on its advertised endpoint"
  rpc_stream_parse: "2/2 subprocess JSON streams opened & parsed"
  rpc_live_round_trip: "2 agent_end round-trip(s) with assistant text"
  socket_registry_two_agents: "2 peers registered by coms.ts session_start in
    isolated PI_COMS_DIR (smoke-a pid 67865, smoke-b pid 67837)"
  inv2_per_user_isolation: "registry confined to
    /var/folders/1v/nbxmg4vx1r53__g78j17g9mm0000gn/T/coms-smoke-tnd13m/coms;
    dir mode=700 uid=501"
  socket_envelope_shape_coverage: shape coverage only — does not count toward
    messages_exchanged/AC1
  socket_live_round_trip: "coms_send acked (msg_id 01KXEJW2EB7B3ZN3XY8TFH3T69),
    coms_await returned \"pong\", agent_end with assistant text in smoke-a's stream"
ac_map:
  AC1 (>=2 agents, >=1 msg — coms_send→coms_await OR subprocess-RPC parse):
    true — both clauses satisfied on this run
  AC3 (extension loads, coms.ts): true
  AC3 (extension loads, coms-net.ts): true
```

Post-DEC1, the same command with `PI_SMOKE_MODEL` set exercised the live turn
for real on 2026-07-13: AC1 is green, backed by real registrations and real
`agent_end` events — no auth-deferral waiver path remains.

**Disclosure — `bAnswered: false` in the 2026-07-13 run of record:** the
socket round-trip verdict rests on smoke-a's stream — `coms_send` acked,
`coms_await` returned `"pong"`, and a real `agent_end` with assistant text
landed on the sender's stream. The `bAnswered` field is a **best-effort
B-side heuristic** that watches smoke-b's own stream for its answering turn;
on pi 0.55.0 it did not match the `agent_end` message shape and recorded
`false` despite the successful round trip (internal-consistency finding from
review round 4, where the detector was hardened). The gating signal is and
remains the A-side evidence above; `bAnswered` is diagnostic only.

AC1 was previously (incorrectly) reported `true` off a self-serialized,
in-process JSON round-trip on the socket-coms path that never touched a real
peer. That accounting bug is fixed (`socket_envelope_shape_coverage` no longer
contributes to `messages_exchanged`). This does not change the Decision above —
both transports' non-live behavior (extension load, registry contract, JSON
stream parsing) was independently verified either way.
