# DF4.1 — adversarial review round on PR #124

Run a full adversarial review of PR **#124** (`feature/df4-1-visualizer-port`, story DF4.1 —
Visualizer Port + Tunneled Auth Gate), fix **every** finding including LOW, then commit, push,
comment, and request a CodeRabbit re-review.

**Pre-authorization (no halts):** the user pre-approves the whole run. "Apply every patch" is
pre-selected. Any decision-needed finding resolves to the **fail-safe / conservative** option
(deny over allow, fail-closed over degrade, narrower scope over broader) and is surfaced in the
final report. Never stop to ask.

---

## 0. Fixed facts — do not re-derive

| Thing | Value |
|---|---|
| Repo root | `~/Development/QuantumDigitalSolutions/_product/QDS-Factory` |
| PR / branch | `#124` / `feature/df4-1-visualizer-port` (base `main`) |
| Story file | `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df4-1-visualizer-port-auth.md` |
| Sprint status | `_bmad-output/sprint-artifacts/sprint-status.yaml` |
| Spec | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` (§3.3, §5.1, §6 cl.7, §8 step 4; D6/D10, R10, F11) |
| Workdir | `<scratchpad>/df4-1-review/` (never inside the repo tree) |
| Transcript dir | `~/.claude/projects/-Users-i3creations-Development-QuantumDigitalSolutions--product-QDS-Factory/<session>/subagents/` |
| Diff size | 8363 lines, 51 files, +7816/-21 |

Round number `k` = (count of existing `### Review Round` headings in the story file) + 1.
GitHub identity: **all** git/gh operations run as `i3creations`. `gh pr create` is not used here.

---

## 1. Skills and sources — what to read, and why

**Read these before spawning anything:**

1. `~/.claude/skills/qds-code-review/SKILL.md` — **method reference only, do not run it as-is.**
   Take from it: Phase 1 bot-comment collection commands (three sources: inline comments, review
   bodies, issue comments), the DOD verification table, and the disagreement/pushback format.
   Do **not** use its Phase 2 fan-out: it hands agents the full diff, which is what killed 3/3
   subagents on the 5492-line round-5 diff. The chunked wave in §3 replaces it.
2. `~/.claude/skills/qds-dev/SKILL.md` §"Definition of Done" — the gates DF4.1 must still pass
   after the fixes land, so the final gate in §6 matches what the dev skill demanded.
3. `.claude/skills/gitnexus-impact-analysis/SKILL.md` — required by repo `CLAUDE.md`
   before any symbol edit.

**Reference repos (cloned locally — read, never modify):**

1. **`~/Development/AI-Tools/disler/super-simple-software-factory`**
   — clone HEAD is `de31374882e7a4e3e5b7bb9bd09e69dc2f779356`, the **exact SHA pinned in
   `visualizer/PROVENANCE.md`**. Upstream visualizer source lives at
   `.claude/skills/sssf/apps/visualizer/`.
   **Why it matters:** most of `visualizer/src/**`, `visualizer/server/db.ts` and
   `visualizer/shared/types.ts` are vendored verbatim from this tree. Diffing our file against
   `.claude/skills/sssf/apps/visualizer/<same path>` is the **only** way to separate "upstream
   code we adopted" from "our hardening delta". Reviewers who skip this diff will file upstream
   style, upstream naming and upstream Vue idiom as DF4.1 defects — that is the single largest
   false-positive source in this PR.
2. **`~/Development/AI-Tools/disler/inkwell-agent-sandboxes-and-software-factory`**
   — specifically `apps/inkwell/server.ts` and `apps/inkwell/server.test.ts`.
   **Why it matters:** it is the second, independent precedent for a Bun.serve factory server and
   its test shape. Use it to judge whether `visualizer/server/index.ts` and `visualizer/test/*`
   diverge from a working pattern for a reason, and to check we did not reinvent route/test
   structure that already exists upstream. Note inkwell relies on exe.dev's proxy for auth and has
   **no** in-process gate — so it is a structural reference, never an auth reference (F11/R10
   forbid its posture).

**Vendoring rule (binding, applies to reviewers and fixers):**
A file listed in `visualizer/PROVENANCE.md` "Files taken" is vendored.
- Reviewers: tag every finding on a vendored file as `[VENDORED]` and state whether the defect
  exists in the upstream file at `de31374` or was introduced by our delta. Upstream-only defects
  are still reportable when they violate F11/R10 or AC0–AC7, but they are hardening decisions,
  not regressions.
- Fixers: editing a vendored file changes the re-vendor no-op-diff guarantee in **AC0**. If a fix
  must touch one, it must also be recorded in the hardening/patch section of
  `visualizer/PROVENANCE.md`, and `scripts/vendor-visualizer.ts` must still be re-runnable
  without clobbering it. If it cannot be, that is a **finding to report**, not a fix to force.

---

## 2. Build and chunk the diff — before spawning anything

```bash
R=~/Development/QuantumDigitalSolutions/_product/QDS-Factory
W=<scratchpad>/df4-1-review; mkdir -p "$W"
git -C "$R" fetch origin feature/df4-1-visualizer-port main
git -C "$R" diff origin/main...origin/feature/df4-1-visualizer-port > "$W/pr124.diff"; wc -l "$W/pr124.diff"
```

Always `git -C "$R"` with pathspecs — plain `cd` + relative pathspec produced empty chunk files
last round.

**Chunk map (measured, in diff lines). Hard ceiling ~2100 per agent; target ≤1500:**

| Chunk file | Pathspec | Lines |
|---|---|---|
| `chunk-server.diff` | `visualizer/server visualizer/shared` | 1546 |
| `chunk-detail.diff` | `visualizer/src/components/PhaseDetail.vue visualizer/src/components/DetailSection.vue visualizer/src/components/PhaseDots.vue` | 1416 |
| `chunk-trace.diff` | `visualizer/src/components/SessionTrace.vue visualizer/src/components/SessionCard.vue visualizer/src/components/SessionsList.vue visualizer/src/components/StatChip.vue visualizer/src/components/StatusChip.vue` | 1626 |
| `chunk-clientlib.diff` | `visualizer/src/lib visualizer/src/App.vue visualizer/src/main.ts visualizer/src/style.css` | 1020 |
| `chunk-tests.diff` | `visualizer/test` | 1220 |
| `chunk-vendor.diff` | `scripts/vendor-visualizer.ts visualizer/PROVENANCE.md visualizer/LICENSE.upstream visualizer/package.json visualizer/vite.config.ts visualizer/tsconfig.json visualizer/index.html visualizer/.oxlintrc.json` | 457 |
| `chunk-rootcfg.diff` | `package.json biome.json bun.lock oci/license-texts` | 501 |

**Excluded from review chunks** (generated / binary / evidence — never hand to an agent):
`_bmad-output/evidence/**`, `_bmad-output/workflow-state/**`, `*.db`, `visualizer/public/**`
(PNG/SVG), `bun.lock` body. Story file and `sprint-status.yaml` go to the auditor only.

Re-verify each chunk's `wc -l` after writing. If a chunk exceeds 2100, split it further before
spawning — never after a death.

---

## 3. Review wave — one message, 8 agents

Reviewer prompts **inline the method**; they load no skills. Each returns Markdown only.

| Agent | Input | Repo access |
|---|---|---|
| `blind-server`, `blind-detail`, `blind-trace`, `blind-clientlib` | its chunk file only, via Read with `offset`/`limit` | **none** — no Grep, no repo Read |
| `edge-server`, `edge-tests` | its chunk + repo read + the two reference repos in §1 | read-only |
| `vendor-parity` | `chunk-vendor.diff` + `visualizer/PROVENANCE.md` + upstream tree at `de31374` | read-only |
| `auditor` | story file path + spec path + `chunk-server.diff` | read-only; **greps** targeted spec sections, never reads a spec whole |

Reviewer method (inline into every prompt): cynical read; assume the author was clever and wrong;
hunt edge cases — empty/absent/oversized input, auth bypass by route shape or method, path
traversal on the static branch, timing-unsafe token compare, SQL built by concatenation, unbounded
row reads, `Bun.serve` hostname regressions, error bodies that leak prompts (F11), missing
`await`, unhandled rejection, resource leak on early return, test asserting the mock not the
behavior. Reviewers must **not** propose diffs — only findings.

**Finding format (every agent, no exceptions):**
```
### [SEV] <title>
file: <repo-relative path>:<line-in-file-if-known> (diff-relative: <n>)
vendored: yes|no
trigger: <exact input/state that makes it fail>
consequence: <what breaks>
```
`SEV` ∈ `BLOCKER | HIGH | MEDIUM | LOW`. Line numbers from a chunk file are **diff-relative** —
say so, and fixers re-locate in real source.

**Also collect existing bot findings** before triage: CodeRabbit/Gemini comments already on #124,
via the three sources from `qds-code-review` Phase 1 (inline comments, review bodies, issue
comments). Unresolved bot findings enter triage as peers of the wave findings.

**Silent-mailbox recovery** — results may arrive as empty `idle_notification`s. If a finished
agent's findings never land as a message:
```bash
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' \
  ~/.claude/projects/-Users-i3creations-Development-QuantumDigitalSolutions--product-QDS-Factory/<session>/subagents/agent-<name>-*.jsonl \
  | tail -c 12000
```
If an agent dies on context anyway: halve **that one** chunk and respawn only it.

---

## 4. Triage

Normalize → dedupe → classify. Write the ledger to `$W/triage.md` before any fix agent spawns.

- **Dedupe key** = (real source file, symbol or nearest function, failure mode). Merge cross-layer
  duplicates and keep the most specific statement; record merged IDs.
- **Classify** each as `PATCH` / `DEFER` / `DISMISS`.
- **Every DISMISS must be verified against real source** (open the file, not the diff) and carry a
  one-line reason. Unverified dismissals are not allowed.
- **DEFER is allowed only** for: out-of-PR-scope pre-existing defects, and DF4.2-owned scope
  (tests inventory, per-box deploy). Everything else in scope is `PATCH`, LOW included.
- Flag scope creep explicitly: no new dependencies, no refactor beyond the finding, no renames
  outside `gitnexus rename`.

---

## 5. Fix waves — disjoint clusters, no commits

One agent per **disjoint** file cluster (source + its own tests together). Two agents must never
be able to touch the same file.

- **Wave 1 (source):** `visualizer/server` + `visualizer/shared` · `PhaseDetail`-group ·
  `SessionTrace`-group · `visualizer/src/lib` + `App.vue`/`main.ts`/`style.css` ·
  `scripts/vendor-visualizer.ts` + `PROVENANCE.md` · root config.
- **Wave 2 (tests, after wave 1 settles):** `visualizer/test/**` hardening + fixture checks —
  runs second so test expectations see final behavior. Wave 1 fixers **must** report every
  intentional behavior change into wave 2's brief.

Each fixer:
1. Re-locate the finding in real source (reviewer lines are diff-relative — do not trust them).
2. Verify the finding reproduces. If it does not, report **false positive** with evidence; do not
   patch to be safe.
3. Run `impact({target:"<symbol>", direction:"upstream"})` before editing any symbol; stop and
   report if HIGH/CRITICAL.
4. Apply the smallest correct fix. Honor the vendoring rule in §1.
5. Run its focal checks: `bun test <its test paths>`, `bunx tsc --noEmit`,
   `bun run typecheck:visualizer`, `bunx @biomejs/biome check <its touched files>`.
6. **No commits, no pushes, no branch operations.** Return a patch report.

---

## 6. Final gate — you run it yourself, not an agent

```bash
bun test                       # full suite
bunx tsc --noEmit
bun run typecheck:visualizer
bun run lint
bun run notice:sweep           # DF2.9 consumer — AC0 vendored tree must still sweep clean
```
Then:
- Re-run the vendoring step against the pinned inputs (`VENDOR_VISUALIZER_REPO=https://github.com/disler/super-simple-software-factory`,
  `VENDOR_VISUALIZER_SHA=de31374882e7a4e3e5b7bb9bd09e69dc2f779356`) into a **temp dir** and confirm
  AC0's no-op-diff claim still holds against our hardening. If it cannot hold, that is a reported
  finding, not a silent fix.
- `detect_changes({scope:"compare", base_ref:"dev"})` — blast radius must stay inside DF4.1's own
  modules. Any out-of-scope symbol is fallout: fix it or explain it in the report.
- If behavior changed, regenerate `_bmad-output/evidence/df4-1/e2e-demo.json` and re-run the E2E
  slice from the story (token gate → 401 on no credential → loopback bind → phase detail renders).

Fix all fallout before closing. A red gate is never "explained away".

---

## 7. Close

1. Append `### Review Round <k>` to the story file: checked-off patch items, false positives with
   pushback reasoning, deferred items with owner (DF4.2 / pre-existing), pre-existing notes.
2. Update the story `Status` line and `sprint-status.yaml` if status changed.
3. Re-run `detect_changes` pre-commit.
4. Commit as `i3creations`: `fix(df4-1): review round <k> — <one-line summary>`.
5. Push to `feature/df4-1-visualizer-port`.
6. `gh pr comment 124` with: fixes table (severity · file · what changed), false-positive pushback
   section, gate results block, deferred list, and `@coderabbitai review`.

---

## Appendix — constraints earned the hard way (do not relax)

- Chunk ceiling ≈2100 diff lines: ≤2056-line chunks all survived round 5; a 5492-line full diff
  killed 3/3 agents.
- Transcript extraction (§3) is the recovery path for the silent-mailbox failure, not optional.
- Source-clusters-then-tests wave order exists to avoid the test/source stomp conflict.
- `git -C <repo-root>` on every pathspec split — `cd` + relative pathspec yields empty diffs.
