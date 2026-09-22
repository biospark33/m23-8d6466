# PR 123 review — triage ledger (review round 10, story df3-1)

Date: 2026-08-24. Sources: reviewer reports. Dismissals verified against source.

## Legend

PATCH = fix this round · DEFER = real, not actionable now · DISMISS = false-positive

## Cluster W1a — src/fleet/dispatch.ts

| id | sev | sources | disposition | finding |
|----|-----|---------|-------------|---------|
| DF1 | HIGH | blind | PATCH | Non-string `ctxGate.teardownCommand` crashes `refuse()` itself; raw exit 1, total AC4 evidence loss. |
| DF2 | MED | blind+edge | PATCH(story) | AC2 "caller-invented runId rejected" is shape-only at runtime. |
| DF3 | MED | blind | DEFER | Brief can tie attacker-controlled repoUrl host to trusted slug; deferred to DF5.2 allowlist design. |
| DF4 | LOW | edge | DISMISS | repoSlug length bound — VERIFIED bounded by `REPO_SLUG_PATTERN`. |
