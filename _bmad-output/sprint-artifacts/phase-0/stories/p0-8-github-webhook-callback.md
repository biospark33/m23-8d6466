# P0.8: Register GitHub Webhook + Prove Callback Fires SwarmClaw Agent Session

**Story Points:** 3

## Spec Reference

- PRD §8 (SwarmClaw Protocol Engine), §9 (CLI-Anything / Warren); FR-CP-9, FR-CM-1
- Phase exit gate: PRD §13 Phase 0 clause 8

## User Story

As a QDS dev agent orchestrator,
I want a GitHub push webhook to automatically trigger a SwarmClaw agent session run,
so that code pushes initiate agent work without manual intervention (G3 — agent-driven delivery loop).

## Overview

This story registers a webhook in SwarmClaw (`POST /api/webhooks`), configures it for GitHub `push` events, and wires the inbound `POST /api/webhooks/{id}` handler to validate the HMAC-SHA256 signature and enqueue a session run on the registered agent. The session run record is created in the SwarmClaw session store with status `pending`. This is a 3-point unit because it builds on P0.7's agent registry and adds exactly one new surface: webhook ingestion → session enqueue.

## E2E Slice

**Demonstrable behavior:** Register a webhook via `POST /api/webhooks` with source `github`, events `["push"]`, and a target agent_id. Simulate `POST /api/webhooks/{id}` with a valid GitHub push payload and HMAC signature. Verify SwarmClaw creates a session run record (status: `pending`) for the configured agent.

**Wiring closed:** On completion of this story, a GitHub push payload posted to the webhook endpoint produces an enqueued session run using only code merged by this story and its predecessor P0.7. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.7 (agent must be registered before webhook can target it).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given a registered agent (P0.7) and a registered webhook (source: `github`, events: `["push"]`, agent_id set, secret configured), When `POST /api/webhooks/{id}` is called with a valid GitHub push payload and `X-Hub-Signature-256` header matching the secret, Then SwarmClaw creates a session run record with `status: "pending"`, `agent_id` matching the webhook config, and `trigger: { source: "github", event: "push", payload: <normalized> }`.
2a. Given a registered webhook with a configured secret, When `POST /api/webhooks/{id}` is called with NO `X-Hub-Signature-256` header, Then the response is HTTP 401 with body `{ error: "missing_signature" }` and no session run is created.
2b. Given a registered webhook with a configured secret, When `POST /api/webhooks/{id}` is called with an invalid `X-Hub-Signature-256` header (wrong secret, malformed prefix, odd-length hex, or non-hex chars), Then the response is HTTP 401 with body `{ error: "invalid_signature" }` and no session run is created.
3. Given a registered webhook, When `POST /api/webhooks/{id}` is called with a valid signature but the event type (e.g., `issues`) does not match the webhook's configured events `["push"]`, Then the response is HTTP 200 with body `{ ignored: true, reason: "event_not_subscribed" }` and no session run is created — never 500 for an unsubscribed event.
4. Given two concurrent POSTs to `/api/webhooks/{id}` with identical push payload `after` SHA within 60 s, Then exactly one session_run is created (HTTP 201) and the second receives the same `session_run_id` (HTTP 200, body `{ deduplicated: true, session_run_id: <existing> }`).
5. Given a registered webhook that has already processed a delivery with `X-GitHub-Delivery: <uuid>`, When the same `X-GitHub-Delivery` UUID is re-posted within 10 minutes, Then the response is HTTP 409 with body `{ error: "duplicate_delivery" }` and no new session run is created.
6. Given SwarmClaw is draining on SIGTERM with an in-flight session-run create, When the process receives SIGTERM, Then the HTTP listener drains (in-flight HTTP requests get 503 per P0.7 pattern), pending session-runs are finalized pre-exit or marked `failed` with `trigger.received_at` preserved, and a 12 s watchdog bounds total shutdown.
7. Given a registered webhook and an inbound `POST /api/webhooks/{id}` with `X-GitHub-Event: ping`, When the request is otherwise valid, Then the response is HTTP 200 with body `{ ok: true, event: "ping" }` and no session run is created.

## Technical Notes

### P0.7 Contract Reference (hardened, merged)

This story consumes P0.7's SwarmClaw HTTP + MCP bridge. The following are CANONICAL as-merged contracts this story must not contradict:
- **Body cap:** `MAX_BODY_BYTES = 1_048_576` (1 MB), enforced on content-length AND chunked read; over-cap → HTTP 413 `{error:"payload too large"}` + `connection: close`, BEFORE route handlers run (`src/swarmclaw/index.ts`).
- **requestId:** UUID-strict `x-request-id` header (regen on invalid), propagated via `_meta.requestId` on tools/call, echoed on every response incl. 413/404/500.
- **invoke error shape:** `MCPInvokeErrorResponseSchema = {jsonrpc:"2.0", error:{code:number, message:string, data?:{field?,violation?,requestId:string}}, id}`. HTTP map: `-32601` (unknown tool) / `-32602` (invalid params) → 400; everything else → 502. (`-32603` = internal/transport.)
- **invoke timeout:** default 120 s, clamped [60 s, 3600 s] (`SWARMCLAW_INVOKE_TIMEOUT_MS`).
- **shutdown:** listener stopped first (`server.stop(true)`), then `shutdownAll`, 12 s force-exit watchdog; in-flight registrations killable.

### Wave 1 Reuse Mandate

P0.8 reuses the following P0.7 primitives verbatim rather than re-implementing them:
- **Body cap enforcement** — `/api/webhooks/{id}` relies on P0.7's `MAX_BODY_BYTES` pipeline (content-length + chunked read), not a bespoke size check. See INV-WH-body for the cross-story 5 MB override dependency.
- **`x-request-id` propagation** — inbound UUID is validated/ regenerated by P0.7's middleware, then flows into `session_run.request_id`, CC-9 log entries, and 201/401/200 response headers. P0.8 does NOT re-validate the UUID.
- **Shutdown lifecycle** — P0.8 inherits P0.7's `server.stop(true)` → `shutdownAll` → 12 s watchdog sequence; webhook session-run finalize hooks into the same drain window. See INV-WH-shutdown.

### Cross-story dependency (P0.8-H2)

P0.8 requires P0.7 to expose a per-route body-cap override (5 MB for `/api/webhooks/{id}`). Additive/backward-compatible (default stays 1 MB). Tracked as a P0.7 follow-up + PROPOSED ADR; until then webhook payloads >1 MB are rejected 413 at the SwarmClaw boundary before HMAC validation. DoD item depends on the P0.7 capability. (This story does NOT edit P0.7 — the parent campaign handles that separately.)

- **Contracts/Schema:**
  ```typescript
  // POST /api/webhooks
  const RegisterWebhookSchema = z.object({
    source: z.enum(["github", "generic"]),
    events: z.array(z.string()).min(1),
    agent_id: z.string(),          // must exist in agent store
    secret: z.string().min(16),    // HMAC key — stored encrypted (AES-256-GCM or secrets manager)
    config: z.record(z.unknown()).optional(),
  });

  // Inbound webhook payload (GitHub)
  const GitHubPushPayloadSchema = z.object({
    ref: z.string(),
    repository: z.object({
      full_name: z.string(),
      html_url: z.string().url(),
    }),
    commits: z.array(z.object({
      id: z.string(),
      message: z.string(),
      author: z.object({ name: z.string(), email: z.string().email() }),
    })),
    sender: z.object({ login: z.string() }),
  });

  // Session run record
  const SessionRunSchema = z.object({
    id: z.string().uuid(),
    agent_id: z.string(),
    status: z.enum(["pending", "running", "completed", "failed"]),
    request_id: z.string().uuid(),  // P0.8-M1: propagated from inbound x-request-id (UUID-validated, else regen per P0.7)
    trigger: z.object({
      source: z.string(),
      event: z.string(),
      payload: z.record(z.unknown()),
      received_at: z.string().datetime(),
    }),
    created_at: z.string().datetime(),
  });
  ```

- **Integration points (each wired & exercised in this story):**
  - SwarmClaw `/api/webhooks` endpoint — webhook registration
  - SwarmClaw `/api/webhooks/{id}` endpoint — inbound webhook ingestion
  - HMAC-SHA256 signature validation middleware
  - SwarmClaw session store — session run creation
  - Agent store — lookup of target agent_id (from P0.7)

- **Files / functions touched:**
  - `src/swarmclaw/routes/webhooks.ts` — POST register, POST ingest
  - `src/swarmclaw/middleware/hmac-validator.ts` — signature validation
  - `src/swarmclaw/store/session-store.ts` — session run CRUD
  - `src/swarmclaw/services/webhook-dispatcher.ts` — event → session enqueue logic
  - `src/swarmclaw/store/webhook-store.ts` — webhook config storage

- **Guards/limits:**
  - HMAC signature validation timeout: 2 seconds
  - Maximum payload size: 5 MB (GitHub webhook limit)
  - Maximum webhooks per SwarmClaw instance: 128
  - Session run dedup: same push SHA within 60 seconds is idempotent (returns existing session_run_id)

## Files to Modify

> ≤10 unique paths, one per line.
- `src/swarmclaw/routes/webhooks.ts`
- `src/swarmclaw/middleware/hmac-validator.ts`
- `src/swarmclaw/store/session-store.ts`
- `src/swarmclaw/services/webhook-dispatcher.ts`
- `src/swarmclaw/store/webhook-store.ts`
- `src/swarmclaw/index.ts`
- `tests/swarmclaw/webhook-ingestion.test.ts`
- `tests/swarmclaw/hmac-validation.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-WH1:** Webhook secret is stored encrypted (AES-256-GCM with a server-managed key, or in a secrets manager); at verification time the plaintext is decrypted into a `Buffer` (not a JavaScript string — V8 strings are immutable and cannot be manually zeroed), used to compute the HMAC for the inbound payload via `Buffer`-based `crypto.createHmac`, then immediately overwritten with `buffer.fill(0)` after comparison. The payload is also processed as `Buffer` throughout the HMAC pipeline to avoid string intermediaries. The plaintext secret is never persisted to disk unencrypted, is never logged, and is never held as a JavaScript `string` at any point during verification.
- **INV-WH2:** HMAC-SHA256 validation parses the `sha256=` prefix from `X-Hub-Signature-256`, hex-decodes both the inbound and computed signatures into equal-length `Buffer`s (length checked first, then `crypto.timingSafeEqual`, which throws on length mismatch), to prevent timing side-channel attacks. Malformed headers (missing `sha256=` prefix, odd-length hex, non-hex chars) are rejected with 401 BEFORE the timing-safe compare is attempted.
- **INV-WH-body:** Inbound body cap on `/api/webhooks/{id}` is 5 MB (GitHub webhook limit), enforced via P0.7's per-route body-cap override (cross-story dependency — see callout above). Until that override lands, payloads >1 MB are rejected 413 at the SwarmClaw boundary (`MAX_BODY_BYTES = 1_048_576`) BEFORE HMAC validation. The 413 carries `x-request-id` per P0.7.
- **INV-WH-shutdown:** Session-run create is interruptible. On SIGTERM the HTTP listener drains (in-flight HTTP requests get 503 per P0.7 pattern), pending session-runs are finalized pre-exit or marked `failed` with `trigger.received_at` preserved, and a 12 s watchdog bounds total shutdown.
- **INV-WH6:** Inbound `x-request-id` (UUID-validated by P0.7, else regen) propagates into `session_run.request_id`, CC-9 log entries, and 201/401/200 response headers. P0.8 does not re-validate the UUID.
- **INV-WH7:** Delivered `X-GitHub-Delivery` UUIDs are tracked with a 10-min TTL; replays are rejected with 409 `{error:"duplicate_delivery"}`.
- **INV-WH8:** Dedup map for push SHA uses a synchronous check-then-insert (mirrors P0.7 `mcp-store` reserve pattern) with a 60 s TTL sweep.
- **INV-WH9:** Event routing reads `X-GitHub-Event` header; `ping` → 200 `{ok:true,event:"ping"}` (no session-run); events not in webhook's `events[]` → 200 `{ignored:true,reason:"event_not_subscribed"}`.
- **INV-WH3:** Inbound payload is validated against `GitHubPushPayloadSchema` before any processing — malformed payloads are rejected with 400 before touching the session store.
- **INV-WH4:** The webhook secret must be at least 16 characters; registration with shorter secrets returns 400.
- **INV-WH5:** `agent_id` in webhook registration is validated against the agent store — referencing a non-existent agent returns 404, preventing orphaned webhook configurations.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** `POST /api/webhooks` registers a webhook with source, events, agent_id, and encrypted secret; returns 201
- [ ] **Impl:** `POST /api/webhooks/{id}` validates HMAC-SHA256 signature, normalizes payload, checks event subscription, and creates a session run record
- [ ] **Impl:** Session run record contains trigger metadata (source, event, normalized payload, timestamp) and status `pending`
- [ ] **Contract:** Zod schemas for `RegisterWebhookSchema`, `GitHubPushPayloadSchema`, `SessionRunSchema` validated on all routes
- [ ] **Integration:** HMAC middleware → event matcher → session store create — full chain wired and exercised
- [ ] **Security:** INV-WH1 through INV-WH9 enforced — encrypted secret storage, timing-safe comparison (with `sha256=` prefix + hex-decode length guard), payload validation, agent_id lookup, x-request-id propagation, dedup, replay rejection, event routing
- [ ] **Cross-story dependency (P0.8-H2):** Blocked on P0.7 per-route body-cap override (5 MB for `/api/webhooks/{id}`). Until P0.7 ships that override, the webhook happy-path test must use payloads ≤1 MB; a follow-up test at the 1–5 MB range is gated on the P0.7 capability landing
- [ ] **Test (unit/integration):** Valid webhook + valid signature → session run created; invalid signature → 401; unsubscribed event → 200 ignored
- [ ] **Test (guard):** Non-existent webhook ID returns 404; non-existent agent_id in registration returns 404; duplicate push within 60s returns existing session
- [ ] **Test (e2e demo — MANDATORY):** Register agent (P0.7) → register webhook → POST push payload with valid HMAC → query session store → assert session run exists with correct agent_id, status `pending`, and trigger metadata
