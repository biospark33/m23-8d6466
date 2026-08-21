# Vendored upstream visualizer — provenance record (DF4.1 AC0)

Written by `scripts/vendor-visualizer.ts` at vendoring time. Never read as
input by the vendoring step itself — the pin is always an explicit input.

repo: https://github.com/disler/super-simple-software-factory
sha: de31374882e7a4e3e5b7bb9bd09e69dc2f779356
vendored: 2026-08-21T11:08:23.978Z
source_path: .claude/skills/sssf/apps/visualizer
files: 33

Files taken (relative to visualizer/):
- .oxlintrc.json
- index.html
- package.json
- public/logo.svg
- public/models/claude.png
- public/models/gemini.png
- public/models/kimi.png
- public/models/openai.png
- public/models/zai.png
- server/db.ts
- server/index.ts
- shared/types.ts
- src/App.vue
- src/components/DetailSection.vue
- src/components/PhaseDetail.vue
- src/components/PhaseDots.vue
- src/components/SessionCard.vue
- src/components/SessionTrace.vue
- src/components/SessionsList.vue
- src/components/StatChip.vue
- src/components/StatusChip.vue
- src/lib/api.ts
- src/lib/events.ts
- src/lib/format.ts
- src/lib/highlight.ts
- src/lib/markdown.ts
- src/lib/models.ts
- src/lib/router.ts
- src/lib/types.ts
- src/main.ts
- src/style.css
- tsconfig.json
- vite.config.ts

Excluded: `bun.lock` (the repo-root lockfile governs dependencies),
`dist/` and `node_modules/` (build outputs, never vendored).

## QDS-Factory divergence from upstream

This section is HAND-MAINTAINED. `scripts/vendor-visualizer.ts` copies upstream
files verbatim and cannot observe what is applied afterwards, so it asserts no
hardening — everything below is recorded by hand and must be updated whenever a
new category of divergence appears.

It is the delta inventory for a future re-vendor or upstream merge. Re-vendoring
OVERWRITES the tree (the copy step does not merge) and regenerating this file
drops this section, so read it before deleting `visualizer/`; the diffs
themselves live in git history on this branch (`git diff <ref> -- visualizer`).

Divergence is listed as **categories**, deliberately without line counts or
checksums — those go stale on the next commit.

**Files added by QDS-Factory** (not present upstream):
`server/auth.ts`, `test/auth.test.ts`, `test/routes.test.ts`,
`test/fixtures/trace-fixture.ts`, plus this file and `LICENSE.upstream`.

**Files removed from the vendored set**: `bun.lock` (see Excluded, above).

**Categories of modification to vendored files:**

1. **Token auth gate** — every route requires a bearer token; `server/auth.ts`
   and its `VizError` are new, and `server/index.ts` routes through them.
2. **Loopback bind** — the server binds `127.0.0.1` rather than all interfaces.
3. **Environment-variable namespacing** — upstream's generic names are prefixed
   so they cannot collide with the host process: `PORT` → `QDS_VIZ_PORT`
   (`vite.config.ts`), `SSSF_DB` → `QDS_VIZ_DB` (`server/index.ts`). The
   upstream default DB path (`adws/adw_data/sssf.db`) is gone with it.
4. **Data source swap: SSSF `sssf.db` → the DF1.4 trace store** — `server/db.ts`
   reads `<data_dir>/trace.db` (schema in `src/phase-engine/trace/schema.ts`),
   including its own column-existence probing for schema tolerance.
5. **Port-boundary renames** — `adw_id` → `request_id` throughout the server,
   shared types and client.
6. **Schema realignment to DF1.4** (`shared/types.ts`, `src/lib/types.ts`) — not
   only renames: `adw_name` dropped; `duration_ms` and `pipeline_name` added;
   `created_at` / `last_used_at` dropped from Envelope, GateResult and
   AgentSession. Vocabulary follows ("ADW process" → "pipeline").
7. **Prompts served from the trace store** — upstream read prompt text off the
   filesystem (`sessionsDir`); that plumbing is deleted and prompts come from
   the trace's `prompt` events. `PhaseDetail.vue`'s upstream `promptCache` Map
   is deleted with it.
8. **Integer micro-dollar costs end to end** — cost is an integer µ$ in the DB,
   the API and the client; the only float exists inside `fmtCost`
   (`src/lib/format.ts`) at display time.
9. **Events page contract rename** — `events` / `has_more` → `rows` / `hasMore`
   across `src/lib/api.ts`, `SessionCard.vue` and `SessionTrace.vue`.
10. **Poll gating** — `SessionTrace.vue` adds a watch that halts the polling
    interval once a session reaches a terminal status (upstream polled forever).
11. **Upstream bug fixes and lint conformance** — e.g. `fmtDuration` rounding
    (a 59.5s remainder rendered as `2m 60s`), `NaN` → `Number.NaN` and similar
    Biome-rule conformance.

12. **Dev-script guard for the mandatory startup token** (`package.json`) —
    the auth gate makes `QDS_VIZ_TOKEN` mandatory, so upstream's
    `dev:all` ("server & vite") left vite running against a server that had
    refused to bind, proxying to a dead API. The script now refuses up front
    with the remediation, and starts neither process. `server` and `preview`
    are unchanged: they already exit non-zero with a named `VIZ_TOKEN_MISSING`
    error and remediation text, which is the correct behaviour.

Upstream license: MIT — see LICENSE.upstream (copied verbatim from the upstream repo root).
