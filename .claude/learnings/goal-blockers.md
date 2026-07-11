# /goal Blockers Log

## Potential blockers identified at pre-flight (2026-07-11)

### ENV-1: `warren` binary not on PATH (affects P0.1)
- `command -v warren` → not found; mdfind found nothing outside Library.
- Mitigation: P0.1 worker instructed to (a) attempt to locate/install warren, (b) if unavailable, use a PATH-shim `warren` executable in test fixtures for integration tests + `TODO(goal)` marker for real-warren validation.

### ENV-2: `pi-vs-claude-code-vendor/` tree missing (affects P0.2)
- Story spec references vendored `coms.ts` + `coms-net.ts` in `pi-vs-claude-code-vendor/` — not present in repo (known gap since Jun 6 review).
- Mitigation: P0.2 worker instructed to vendor from upstream source (search GitHub/npm); if the upstream cannot be located → hard BLOCKER, story skipped.

### ENV-3: API keys not exported in orchestrator shell
- ANTHROPIC_API_KEY / OPENROUTER_API_KEY / ZAI_API_KEY unset. pi CLI may auth via its own config/keychain.
- Mitigation: workers verify live-call paths; tests requiring live keys marked `skip` + `TODO(goal)`.
