# Secrets (Encryption / KMS / Vault) Invariants Checklist

> **Triggered by:** `encryption`, `secret`, `secrets`, `KMS`, `vault`
> in story or epic text.
> **Loaded by:** Phase 3 wrap-up step (`steps/phase-3-wrap-up.md` §3.0).
> **Used as:** `also_consider` input to the Phase 3 adversarial review.

When a story handles secrets, encryption keys, or KMS/Vault material,
every one of the items below must be addressable from the story spec
alone. If the spec cannot answer "yes, the story covers this," it is a
HIGH finding.

**N/A is acceptable for conditional items** (those scoped with phrases
like "For signing keys", "Any secret persisted to the database",
"Stories that change frontend code", or "If the story implements
rotation") **only when the story spec explicitly documents why the
item does not apply** (e.g., "no signing keys used", "no DB-persisted
secrets in this story", "backend-only change"). A silent omission on
a conditional item is still a HIGH finding.

## Logging / observability invariants

- [ ] **No secrets in logs.** The story explicitly states that
      secret values are never logged — including in DEBUG mode,
      tracebacks, OpenTelemetry spans, or HTTP request/response
      dumps. Structured loggers redact known-secret fields by name.
- [ ] **No secrets in error messages.** Validation errors that
      reference a secret-bearing field surface the field NAME and
      a non-revealing reason, never the value. (`"api_key: invalid
      format"` is fine; `"api_key 'sk-abc123' is invalid"` is not.)
- [ ] **No secrets in metrics labels.** Metric labels are bounded-
      cardinality and never include raw secret values or
      principal-bearing tokens.

## Key-rotation invariants

- [ ] **Rotation cadence stated.** Each secret class (API keys,
      signing keys, encryption-at-rest keys) has a documented
      rotation cadence in the story or in a linked secrets
      register.
- [ ] **Rotation mechanism is automated or operator-runbook'd.**
      The story specifies *how* rotation happens — KMS automatic
      rotation, Vault transit rotation, or an operator runbook
      step. "Rotate manually" without a runbook reference is a HIGH
      finding.
- [ ] **Dual-key window during rotation.** For signing keys, the
      story describes a dual-key validation window so in-flight
      tokens signed with the old key remain valid until they
      expire naturally.

## Storage / injection invariants

- [ ] **Env-only injection (no on-disk plaintext).** Secrets are
      injected via environment variables (or secret-store-backed
      runtime fetch) — never committed to the repo, never written
      to a plaintext config file at deploy time, never baked into
      a Docker image layer.
- [ ] **Secret reference is indirect.** Configuration files
      reference a secret BY NAME (`api_key: "env:ANTHROPIC_API_KEY"`
      or `vault:secret/data/anthropic#api_key`), not by value.
- [ ] **Encryption at rest for stored secrets.** Any secret
      persisted to the database (user-provided API keys, OAuth
      tokens, webhook signing secrets) is encrypted at rest using a
      KMS-managed key. The encryption envelope, KMS key ID, and
      decryption code path are documented in the story.
- [ ] **Least-privilege access.** Stories document which services /
      roles can read each secret class via IAM / RBAC policy
      references. Secrets are scoped to the minimum necessary
      principals — no org-wide, overly permissive, or wildcard
      policies. Cross-service access is explicit, named, and
      auditable.

## Boundary-crossing invariants

- [ ] **Outbound URL redaction.** Webhooks, external API calls, and
      retry payloads that may contain user-supplied secrets are
      filtered before being recorded in any persistent store
      (logs, audit, message-queue dead-letter).
- [ ] **No secrets in client bundles.** Stories that change frontend
      code must explicitly state that no server-side secrets reach
      the client. Public values (publishable keys, anon keys) use
      the framework's public-exposure convention (for example,
      `NEXT_PUBLIC_` in Next.js, `VITE_` in Vite, `PUBLIC_` in
      SvelteKit) and are listed in the story.
- [ ] **No secrets in URL/query string.** Secrets are passed in
      headers or request bodies — never in query parameters
      (which are logged by proxies and browser history).

## Test invariants

- [ ] **Redaction test.** At least one unit test asserts that a
      log line emitted while a known-secret-bearing field is in
      scope does not contain the secret value.
- [ ] **Fixture secrets are obviously fake.** Test fixtures use
      sentinel values like `test-secret-{uuid4}` or `sk-test-XXXX`
      — never copy-pasted real keys.
- [ ] **Rotation test.** If the story implements rotation, a test
      exercises the dual-key window (old key still validates,
      new key validates, both reject after old key's TTL).

## Cross-story invariants

- [ ] **Single secrets-backend per environment.** All stories in the
      batch agree on the secrets backend (KMS / Vault / SSM
      Parameter Store / 1Password Connect / etc.). Mixing two
      backends without an explicit migration plan is a HIGH
      finding.
- [ ] **Consistent naming for secret env vars.** All stories use
      the same naming convention (e.g. `{SERVICE}_{PURPOSE}_KEY`),
      no drift across story authors.
