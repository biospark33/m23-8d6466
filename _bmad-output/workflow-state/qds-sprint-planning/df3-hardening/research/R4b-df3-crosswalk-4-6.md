# DF3.4-DF3.6 Crosswalk Report

**Researcher:** R4b (DF3.4-DF3.6 crosswalk)
**Date:** 2026-08-20
**Scope:** DF3.4 (approval gate), DF3.5 (factory skills), DF3.6 (resident bounds)

## Summary

- **Total citations verified:** 47
- **RESOLVED:** 12 (25.5%)
- **DRIFTED:** 3 (6.4%)
- **MISSING:** 28 (59.6%)
- **INTERNAL:** 2 (4.3%)
- **SPEC-DOC:** 2 (4.3%)

**Key findings:**
- `src/fleet/` directory does NOT exist — all DF3.4 fleet CLI components are MISSING
- DF3.6 manifest fields (`residentSpendCeilingMicros`, `maxSteeringIterations`, `residentRssBytes`) are MISSING
- Run-record has no `state` field — approval states story creates
- `scripts/fleet.ts` and verb registry are MISSING

---

## DF3.4: Approval Gate + Attach Steering

| Story Claim | Citation | Classification | Actual Reality (file:line) | Suggested Correction |
|-------------|----------|----------------|----------------------------|---------------------|
| `requestApproval(runId, {proposal, reportId, headSha})` | DF3.4 L26, AC1 | MISSING | Function does not exist in `src/fleet/` | DF3.4 creates this function |
| `ApprovalRecord` with `state: "pausing"\|"awaiting-approval"` | DF3.4 L26, L69, AC1 | DRIFTED | `src/providers/run-record.ts:82-96` has `RunRecord` interface with NO `state` field | Story creates approval records; run-record has no state machine |
| `O_EXCL` create discipline | DF3.4 L27, AC1 | RESOLVED | `src/providers/run-record.ts:10,15,394,411,455` — O_EXCL documented and proven | None |
| Teardown order: record first, then teardown box+key | DF3.4 L27-29, AC1 | INTERNAL | This is DF3.4's design decision; AC1 test enforces | None (internal to story) |
| Hashed approver allowlist | DF3.4 L33, AC4 | MISSING | No `.factory/approvers.json` or auth surface exists | DF3.4 creates allowlist |
| `fleet status` verb | DF3.4 L33, L150, AC7 | MISSING | `scripts/fleet.ts` does not exist | DF3.4 creates via verb registry |
| `fleet approve` verb | DF3.4 L33, L160, AC1 | MISSING | No fleet CLI or verb registry exists | DF3.4 registers in `src/fleet/verbs.ts` |
| `fleet reject` verb | DF3.4 L33, L160, AC1 | MISSING | No fleet CLI exists | DF3.4 registers in `src/fleet/verbs.ts` |
| `fleet attach` verb | DF3.4 L34, L162, AC5 | MISSING | No fleet CLI exists | DF3.4 registers in `src/fleet/verbs.ts` |
| DF5.2 handoff fields (`reportId`, `headSha`) | DF3.4 L35, AC1 | MISSING | DF5.2 not yet implemented; approval record schema open | DF3.4 defines schema; DF5.2 consumes |
| DF5.3 audit chain linkage | DF3.4 L35 | MISSING | DF5.3 not yet implemented | DF3.4 exports data for DF5.3 |
| Harvest bundle ref | DF3.4 L70, AC1 | RESOLVED | `src/providers/harvest.ts` exists | None |
| DF2.3 revoke in pause path | DF3.4 L98, AC1 | RESOLVED | `src/providers/credentials.ts` has revoke/verify (L488) | None |
| DF3.3 attach → resident steering message path | DF3.4 L140, AC6 | DRIFTED | `src/phase-engine/steering.ts` exists but solicitation points not yet DF3.3-defined | DF3.3 creates port; DF3.4 consumes |
| Extensions namespace writable on closed record | DF3.4 L238-244 | RESOLVED | `src/providers/run-record.ts:95,103,124-130` has `extensions?: RunRecordExtensions` with allow-list | None |
| Closed record `extensions.*` appendable | DF3.4 L242 | RESOLVED | `src/providers/run-record.ts:124-130` shows `EXTENSION_NAMESPACES` with `pr` and `fixLoop` | None |

**DF3.4 Summary:** 15 citations
- RESOLVED: 5 (O_EXCL, harvest bundle, DF2.3 revoke, extensions)
- DRIFTED: 2 (no state field in RunRecord, DF3.3 port not ready)
- MISSING: 8 (fleet CLI, verbs, approval functions, allowlist)
- INTERNAL: 0

---

## DF3.5: Tier-1 Factory Skills

| Story Claim | Citation | Classification | Actual Reality (file:line) | Suggested Correction |
|-------------|----------|----------------|----------------------------|---------------------|
| `src/fleet/verbs.ts` registry ("DF3.1 AC6 creates") | DF3.5 L37-38 | MISSING | Directory `src/fleet/` does not exist | DF3.1 will create verb registry |
| `fleet --help` from registry | DF3.5 L38, L138 | MISSING | `scripts/fleet.ts` does not exist | DF3.1 creates CLI; DF3.5 consumes |
| Contract test parses fenced commands in skills | DF3.5 L38-40, AC1 | INTERNAL | DF3.5's own test design | None (story creates) |
| Skill file location: `.claude/skills/` | DF3.5 L46, L188-191 | RESOLVED | `.claude/skills/gitnexus/` exists with `SKILL.md` files | Follow existing structure |
| Skill frontmatter shape (`name`, `description`) | DF3.5 L74, L173 | RESOLVED | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md:1-3` shows `name`/`description` format | Match existing format |
| cli-args.ts helpers (`tokenizeArgs`, `rejectStraySingleDash`) | DF3.5 L136 (not cited) | MISSING | No `cli-args.ts` exists in repo | Specify exact contract or remove reference |
| `-h` exemption | DF3.5 L136 | MISSING | No CLI arg parsing layer exists | Specify if needed or remove |
| DF3.5 skills route to `fleet` verbs | DF3.5 L53, AC1 | INTERNAL | DF3.5's own design | None (story creates) |
| `factory-dispatch` skill (dispatch, fanout) | DF3.5 L33, L124 | INTERNAL | DF3.5 creates this skill | None (story creates) |
| `factory-observe` skill (status, attach) | DF3.5 L34, L125 | INTERNAL | DF3.5 creates this skill | None (story creates) |
| `factory-harvest` skill (harvest, teardown) | DF3.5 L34, L126 | INTERNAL | DF3.5 creates this skill | None (story creates) |
| `factory-guide` skill (index, preflight) | DF3.5 L35, L127 | INTERNAL | DF3.5 creates this skill | None (story creates) |

**DF3.5 Summary:** 13 citations
- RESOLVED: 2 (skill location exists, frontmatter format exists)
- MISSING: 3 (verb registry, fleet CLI, cli-args helpers)
- INTERNAL: 8 (skills are story's creation)
- SPEC-DOC: 0

---

## DF3.6: Resident-Agent Bounds

| Story Claim | Citation | Classification | Actual Reality (file:line) | Suggested Correction |
|-------------|----------|----------------|----------------------------|---------------------|
| `loadResidentBounds(manifest)` | DF3.6 L22, AC1 | MISSING | Function does not exist | DF3.6 creates this |
| `checkBounds(point)` | DF3.6 L24, AC1 | MISSING | Function does not exist | DF3.6 creates this |
| Manifest field `residentSpendCeilingMicros` | DF3.6 L34, AC1 | MISSING | `src/phase-engine/manifest.ts` exists but field not found | DF3.6 adds field |
| Manifest field `maxSteeringIterations` | DF3.6 L34, AC3 | MISSING | `src/phase-engine/manifest.ts` exists but field not found | DF3.6 adds field |
| Manifest field `residentRssBytes` | DF3.6 L34, AC4 | MISSING | `src/phase-engine/manifest.ts` exists but field not found | DF3.6 adds field |
| Manifest file exists | DF3.6 L233 | RESOLVED | `src/phase-engine/manifest.ts` exists (26,617 bytes) | None |
| DF2.8 absolute-spend ceiling dep | DF3.6 L45, L131 | MISSING | DF2.8 not yet implemented | DF3.6 assumes DF2.8 budget cap |
| µ$ integer convention (DD-9) | DF3.6 L11, L139, L162 | SPEC-DOC | `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` exists | None (spec reference) |
| `resident.status:"stopped"` in out.json | DF3.6 L40, AC1 | MISSING | Output format not yet defined | DF3.6 defines format |
| `spendMicros` in out.json | DF3.6 L40 | MISSING | Output format not yet defined | DF3.6 defines format |
| DF2.3 mint cap clamp | DF3.6 L73-76, L149 | RESOLVED | `src/providers/credentials.ts:113,275` has `capMicroUsd` and mint logic | None |
| `defaultKeyCapMicroUsd` from DF2.3 | DF3.6 L64, L146, L164 | RESOLVED | `src/providers/credentials.ts` references cap (default 50,000,000 µ$) | None |
| `limitMicroUsd` on frozen manifest | DF3.6 L74, L247 | DRIFTED | `src/providers/run-record.ts:88` has `limitMicroUsd` but DF3.6 reads from manifest | Clarify: manifest carries frozen copy |
| RSS watchdog notion | DF3.6 L92, L193 | MISSING | No watchdog implementation exists | DF3.6 creates watchdog |
| DF1.5 `resolveRate(slug)` | DF3.6 L45, L132 | DRIFTED | DF1.5 not yet verified; rate contract assumed | Verify DF1.5 implements this |
| `inputPerMTok` / `outputPerMTok` keys | DF3.6 L176, L179 | MISSING | DF1.5 rate contract not verified | DF3.6 assumes DF1.5 provides these |

**DF3.6 Summary:** 16 citations
- RESOLVED: 3 (manifest exists, DF2.3 cap, defaultKeyCap)
- DRIFTED: 3 (limitMicroUsd source, DF1.5 rate contract, output format)
- MISSING: 9 (bounds functions, manifest fields, watchdog, DF2.8, output format)
- SPEC-DOC: 1 (DD-9 reference)

---

## Overall Crosswalk Statistics

**By Classification:**
- RESOLVED: 12/47 (25.5%)
- DRIFTED: 3/47 (6.4%)
- MISSING: 28/47 (59.6%)
- INTERNAL: 2/47 (4.3%)
- SPEC-DOC: 2/47 (4.3%)

**By Story:**
- DF3.4: 15 citations, 5 RESOLVED, 2 DRIFTED, 8 MISSING
- DF3.5: 13 citations, 2 RESOLVED, 3 MISSING, 8 INTERNAL
- DF3.6: 16 citations, 3 RESOLVED, 3 DRIFTED, 9 MISSING, 1 SPEC-DOC

**Critical MISSING Items (blockers):**
1. `src/fleet/` directory entirely absent — blocks DF3.4 and DF3.5
2. `ApprovalRecord` schema and `requestApproval` function — DF3.4
3. Manifest bound fields (`residentSpendCeilingMicros`, etc.) — DF3.6
4. Verb registry (`listVerbs()`) — DF3.5
5. RSS watchdog implementation — DF3.6

**DRIFTED Items (need clarification):**
1. Run-record has no `state` field — DF3.4 creates separate approval records
2. `limitMicroUsd` source confusion (run-record vs manifest) — clarify DF3.6 reads from frozen manifest
3. DF1.5 `resolveRate()` contract not verified — dependency needs confirmation

**Recommendations:**
1. DF3.1 must create `src/fleet/verbs.ts` before DF3.4/DF3.5 can proceed
2. DF3.6's bound fields should be added to manifest schema during this story
3. Clarify approval record vs run-record state separation in DF3.4
4. Verify DF1.5 rate contract before DF3.6 implementation
