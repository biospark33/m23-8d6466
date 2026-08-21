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

All QDS-Factory modifications after this point — the token auth gate,
`adw_id` → `request_id` rename at the port boundary, prompts served from
the trace store, integer micro-dollar costs, loopback bind — are tracked
diffs in this repository, not part of the vendored tree.

Upstream license: MIT — see LICENSE.upstream (copied verbatim from the upstream repo root).
