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
2. Given a registered webhook with a configured secret, When `POST /api/webhooks/{id}` is called with an invalid or missing `X-Hub-Signature-256` header, Then the response is HTTP 401 with body `{ error: "invalid_signature" }` and no session run is created.
3. Given a registered webhook, When `POST /api/webhooks/{id}` is called with a valid signature but the event type (e.g., `issues`) does not match the webhook's configured events `["push"]`, Then the response is HTTP 200 with body `{ ignored: true, reason: "event_not_subscribed" }` and no session run is created — never 500 for an unsubscribed event.

## Technical Notes

- **Contracts/Schema:**
  ```typescript
  // POST /api/webhooks
  const RegisterWebhookSchema = z.object({
    source: z.enum(["github", "generic"]),
    events: z.array(z.string()).min(1),
    agent_id: z.string(),          // must exist in agent store
    secret: z.string().min(16),    // HMAC key — stored hashed
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

- **INV-WH1:** Webhook secret is stored encrypted (AES-256-GCM with a server-managed key, or in a secrets manager); at verification time the plaintext is decrypted, used to compute the HMAC for the inbound payload, then zeroed from memory immediately after. The plaintext secret is never persisted to disk unencrypted and is never logged.
- **INV-WH2:** HMAC-SHA256 validation uses `crypto.timingSafeEqual` to prevent timing side-channel attacks on signature comparison.
- **INV-WH3:** Inbound payload is validated against `GitHubPushPayloadSchema` before any processing — malformed payloads are rejected with 400 before touching the session store.
- **INV-WH4:** The webhook secret must be at least 16 characters; registration with shorter secrets returns 400.
- **INV-WH5:** `agent_id` in webhook registration is validated against the agent store — referencing a non-existent agent returns 404, preventing orphaned webhook configurations.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO lint/tests/typecheck filler.

- [ ] **Impl:** `POST /api/webhooks` registers a webhook with source, events, agent_id, and hashed secret; returns 201
- [ ] **Impl:** `POST /api/webhooks/{id}` validates HMAC-SHA256 signature, normalizes payload, checks event subscription, and creates a session run record
- [ ] **Impl:** Session run record contains trigger metadata (source, event, normalized payload, timestamp) and status `pending`
- [ ] **Contract:** Zod schemas for `RegisterWebhookSchema`, `GitHubPushPayloadSchema`, `SessionRunSchema` validated on all routes
- [ ] **Integration:** HMAC middleware → event matcher → session store create — full chain wired and exercised
- [ ] **Security:** INV-WH1 through INV-WH5 enforced — encrypted secret storage, timing-safe comparison, payload validation, agent_id lookup
- [ ] **Test (unit/integration):** Valid webhook + valid signature → session run created; invalid signature → 401; unsubscribed event → 200 ignored
- [ ] **Test (guard):** Non-existent webhook ID returns 404; non-existent agent_id in registration returns 404; duplicate push within 60s returns existing session
- [ ] **Test (e2e demo — MANDATORY):** Register agent (P0.7) → register webhook → POST push payload with valid HMAC → query session store → assert session run exists with correct agent_id, status `pending`, and trigger metadata
