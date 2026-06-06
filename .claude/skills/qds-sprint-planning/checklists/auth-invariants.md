# Auth (AuthN / AuthZ / RBAC / Capability) Invariants Checklist

> **Triggered by:** `auth`, `authn`, `authz`, `rbac`, `capability`,
> `authentication`, `authorization` in story or epic text.
> **Loaded by:** Phase 3 wrap-up step (`steps/phase-3-wrap-up.md` §3.0).
> **Used as:** `also_consider` input to `bmad-review-adversarial-general`.

When a story touches authentication, authorization, RBAC, or capability
gating, every one of the items below must be addressable from the story
spec alone. If the spec cannot answer "yes, the story covers this," it
is a HIGH finding.

## Capability-gating invariants

- [ ] **Every protected endpoint declares its capability.** Each new
      route, agent tool, or chat tool lists the explicit capability
      string (e.g. `proposal:write`, `rfp:export`) the caller must
      hold. "Authenticated user" is NOT a capability — it is a
      precondition.
- [ ] **Capability gate runs before any side effect.** The
      capability check occurs before any database write, external
      API call, or token mint. Lazy / post-effect checks are a HIGH
      finding.
- [ ] **No bypass on the read path.** Read endpoints carry their own
      capability gate or scope-binding — reads do not silently fall
      through to "anyone in the tenant."

## Scope-binding invariants

- [ ] **Tenant binding is server-derived.** The tenant
      discriminator (`graph_id`) is resolved from the session /
      token on the server — never trusted from a request parameter.
      Endpoints that accept tenant ID from the request body are a
      HIGH finding unless the value is then cross-checked against
      the session-bound tenant.
- [ ] **Resource ownership re-verified per request.** For mutations
      on a specific resource (e.g. `PATCH /rfps/{id}`), the story
      spec calls out the ownership re-check (`row.graph_id ==
      session.graph_id AND (row.owner == principal OR principal has
      capability X)`).
- [ ] **No principal escalation via parameter.** If the request body
      or path includes a principal identifier (`user_id`,
      `actor_id`), the story specifies that the server **ignores**
      it in favor of the session-bound principal — unless the
      caller holds an explicit `act_as` capability.

## Session / token invariants

- [ ] **Session revocation path exists.** The story describes how an
      invalidated session (logout, password reset, capability
      revoked) propagates to in-flight requests within a bounded
      lag. A token whose capability set is mutated mid-flight must
      either re-check or be re-issued.
- [ ] **Token expiry is enforced server-side.** No story relies on
      client-side expiry. Every token check verifies `exp` against
      the current time on the server.
- [ ] **No long-lived bearer tokens in URLs.** If the story
      introduces a token-bearing query string (download links,
      magic links), the token is single-use, short-lived (<= 1
      hour), and bound to the principal who minted it.

## RBAC-hierarchy invariants (when story touches RBAC)

- [ ] **Role-to-capability mapping is explicit.** The story lists
      the capabilities added or removed for each affected role.
      "Admins get more permissions" is not specific enough.
- [ ] **Default-deny stance.** New routes / tools default to denied
      and explicitly enumerate the roles that may access them — not
      the reverse (default-allow + denied roles).
- [ ] **Role assignment is auditable.** Adding or revoking a role
      from a user emits an audit-log event. The event schema is
      defined in the story.

## Cross-story invariants

- [ ] **Single capability vocabulary.** All stories in the batch
      use the same capability strings (no `proposal_write` in one
      story and `proposal:write` in another). Cross-story drift is
      a HIGH finding.
- [ ] **One source of truth for the capability registry.** All
      capability constants are defined in a single module and
      imported — not redefined per story.

## Test invariants

- [ ] **Negative-auth test per endpoint.** Each protected endpoint
      in the story has a test asserting that a principal without
      the required capability gets a 403 (not 404, not 500).
- [ ] **Tenant-isolation probe.** At least one integration test
      sets `graph_id` to a foreign tenant and asserts the endpoint
      rejects the request or returns zero rows — not application
      data from the wrong tenant.
- [ ] **Expired-token probe.** At least one test exercises an
      expired session/token and asserts a 401, not silent fallback.
