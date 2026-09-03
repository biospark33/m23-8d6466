## P0.9 — Hindsight Bank Provisioning + Retain→Recall→Reflect Round-Trip + Mulch Import

Implements story P0.9 (`_bmad-output/sprint-artifacts/phase-0/stories/p0-9-hindsight-banks-mulch.md`). Depends on P0.7 (SwarmClaw MCP bridge, merged in PR #34).

### What
- **`src/hindsight/`** — `schemas` (Zod: BankId, Retain/Recall/Reflect/Consolidate payload+response, MulchExpertise; `resolveBankId`), `client` (HindsightClient REST wrapper), `bank-provisioner` (3 banks, idempotent, collision loop, single-flight lock w/ stale recovery), `mulch-importer` (YAML/JSON/JSONL → JSONL, NFC dedup, quotas), `round-trip-verifier` (full lifecycle).
- **`scripts/`** — `provision-hindsight-banks.ts`, `import-mulch-expertise.ts` (CLI, JSON envelopes, non-zero exit on failure).
- **`.mulch/expertise/`** — real seed expertise files (qds-foundations.yaml, swarmclaw.json).
- **Tests** — 102 hindsight-suite + 7 CLI + 5 bridge integration, all green. tsc strict + biome clean.

### Acceptance criteria
- **AC-1 make-or-break**: retain→recall→reflect→consolidate round-trip proven through SwarmClaw's **real `/invoke` bridge** via a new `fake-hindsight-mcp` MCP fixture (`tests/swarmclaw/fixtures/`). Post-consolidation recall confirms content preservation.
- **AC-3**: valid-but-nonexistent `bank_id` recall → **HTTP 502** (bridge maps a non -32601/-32602 error to 502).
- **AC-2/6/7, AC-4/AC-5**: Mulch import + recall-by-concept; provisioner error envelopes -32001/-32002 when bridge unavailable; recall latency logging.
- **INV-HM1…HM6** all enforced: env-only bearer token via `maskEnv`, `bank_id` safeParse pre-call (-32003), symlink/path-traversal + subdir rejection (INV-HM3), tenant isolation (INV-HM4), defensive-parse + AbortController cleared in finally (INV-HM5), single-flight `provision.lock` with PID + stale-lock recovery (INV-HM6).

### Spec deviations (documented in code + commit; forced by live-server reality)
1. **Bank-scoped REST endpoints.** The story lists flat paths (`/v1/default/recall`); the real Hindsight OpenAPI (`/hindsight-docs`) is **bank-scoped** (`POST /v1/default/banks/{id}/memories` and `/recall`, `/reflect`, `/consolidate` under the bank), and bank create is `PUT /v1/default/banks/{id}`. The story's flat paths 404 on a live server — `client.ts` uses the bank-scoped paths.
2. **Auth header** is `Authorization: Bearer <HINDSIGHT_API_KEY>` (OpenAPI), not `X-API-Key`.
3. **No live-server tests.** `hindsight-local-mcp` stdio is broken on this host (missing LLM key + x86_64 psycopg2 on arm64) and Docker Hindsight tenant auth returns 401. All tests mock `fetch` and drive the bridge against the deterministic `fake-hindsight-mcp` fixture. CI has zero live-Hindsight dependency.

### How it was built
QDS-dev workflow with waves of parallel sub-agents: Wave 1 research (5 agents) → Wave 2a foundation (schemas+client) → Wave 2b (4 parallel verticals: provisioning, import, verifier, bridge fixture) → Wave 3 adversarial self-review (found + fixed 9 bugs: 64-char bank-id overflow breaking INV-HM2, -32005 taxonomy overload, stale-lock unrecoverability, duck-typed fd close, brittle error classification, INV-HM3 subdir symlink, listBanks-failure collision masking, errno conflation, CLI bank-id validation) → cleanup → gates.

### Verification
- `bun test tests/hindsight/ tests/import-mulch-expertise.test.ts` → **102 pass / 0 fail**
- `bunx tsc --noEmit` → clean (strict + noUncheckedIndexedAccess)
- `bunx @biomejs/biome check` → clean
- `detect_changes` (gitnexus) → no existing symbols modified (all new files)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
