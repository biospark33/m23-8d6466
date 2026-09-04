# DF3.5 Track A — Library/Dependencies Research

Date: 2026-08-31. Branch: `feature/df3.5`. Scope: research only — no dependencies added, no files
modified outside this document.

## 1. YAML / frontmatter-parsing dependency already present

**Yes. `yaml` v2 is a first-class runtime dependency — no new dependency is needed.**

- `package.json:40-43` — `"dependencies": { "yaml": "^2.9.0", "zod": "^3.24.0" }`. No `js-yaml`,
  no `gray-matter`, no `front-matter` anywhere in the manifest or `bun.lock` (lock shows `yaml`
  at `^2.9.0` at root, `^2.8.2` nested under the vendored pi package).
- Import sites (exact):
  - `cli-anything/src/index.ts:2` — `import { YAMLParseError } from "yaml";`
  - `cli-anything/src/manifest.ts:2` — `import { parse as parseYaml } from "yaml";`
  - `src/phase-engine/roster/schema.ts:32` — `import { parse as parseYaml } from "yaml";`
  - `scripts/lean-worker-benchmark.ts:36` — `import { parse as parseYaml, stringify as stringifyYaml } from "yaml";`
  - `scripts/cap-hit-demo.ts:27` — `import { parse } from "yaml";`
  - `src/hindsight/mulch-importer.ts:24` — `import { parse } from "yaml";`
  - `tests/providers/fixtures/loopy-workload.test.ts:3` — `import { parse } from "yaml";`
  - `tests/fleet/dispatch.test.ts:38` — `import * as YAML from "yaml";` (namespace style also in use)
- Recommendation for `tests/fleet/skill-contract.test.ts`: `import { parse as parseYaml } from "yaml";`
  is the dominant idiom; feed it the frontmatter text between the `---` fences (regex-extract the
  fence, YAML-parse the body — no gray-matter needed).

**Existing hand-rolled frontmatter parser (reference only, do NOT import):**
`pi-vs-claude-code-vendor/coms-core.ts:134-159` — `parseFrontmatter(raw)` splits on
`/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/` and parses `key: value` lines manually (with
quote-stripping). It lives in the vendored pi tree, is covered by `tests/vendor/coms-core.test.ts:101-133`,
and is scoped to `name`/`description`/`color`. For DF3.5 prefer `yaml`'s real parser — the skill
`description` values contain quoted colons and examples that the naive line parser would mangle.

## 2. How existing tests parse frontmatter / markdown

- Frontmatter: only `tests/vendor/coms-core.test.ts` exercises `parseFrontmatter` (see above); no
  test under `tests/` parses YAML frontmatter with the `yaml` package today.
- No existing test reads `SKILL.md` files. `.claude/skills/factory/` does **not exist yet**
  (`.claude/skills/` currently holds `gitnexus/`, `qds-live-e2e/`, `qds-sprint-planning/`,
  `using-exe-dev/`).
- Existing SKILL.md frontmatter shape (target format for DF3.5):
  `.claude/skills/gitnexus/gitnexus-cli/SKILL.md:1-4` —
  ```yaml
  ---
  name: gitnexus-cli
  description: "Use when the user needs to ... Examples: \"Index this repo\", ..."
  ---
  ```
  Two keys only: `name`, `description` (description is a double-quoted single line).
- Fenced-code-block extraction precedents (all regex-based, no markdown lib):
  - `tests/lsp-verify.test.ts:270-272` — test named `parses a fenced ```json block`, inline fixture
    string `'...\n\n```json\n{...}\n```'`.
  - `tests/scripts/mcp-stdio-client.test.ts:344-381` — `parseToolJsonText` extracts fenced
    ```` ```json ```` blocks, rejects unterminated fences and fenced arrays.
  - `tests/phase-engine/envelope-parse.test.ts:29` — `"fenced code block"` test for report JSON
    wrapped in prose or a fence.
- Pattern to reuse: a line-oriented scan or `/^```(\w*)\s*$([\s\S]*?)^```$/gm`-style regex; none of
  the existing helpers are exported for reuse, so the new test should carry its own small extractor
  (matches the repo's "three similar lines beat premature abstraction" style).

## 3. Test conventions

- **Runner: `bun:test`, uniformly.** 132/132 test files import from `"bun:test"`; zero `vitest`
  imports in `tests/`. Standard header:
  `import { describe, expect, test, beforeEach, afterEach, ... } from "bun:test";`
  (`test` is used more often than `it`; `describe(...)` blocks group cases).
- Imports of repo code use **relative paths with explicit `.ts` extension**, e.g.
  `tests/fleet/dispatch.test.ts:45` — `from "../../src/providers/quota.ts"`.
- Temp dirs: per-test `mkdtempSync(join(tmpdir(), "<prefix>-"))` from `node:fs` + `tmpdir()` from
  `node:os`, cleaned with `rmSync(dir, { recursive: true, force: true })` in `afterEach`/`afterAll`.
  Examples: `tests/lib/file-lock.test.ts:20`, `tests/hindsight/mulch-import.test.ts:108`,
  `tests/fleet/dispatch.test.ts:22-37`. **There is no shared temp-dir helper** — each file inlines it.
- Shared helpers exist per-area, not globally:
  - `tests/fleet/helpers.ts` — DF3.1 decision-shape ledger fakes (`RecordingLedger`, budget
    snapshots). Fleet-specific; the skill-contract test does not need it.
  - `tests/pr/helpers.ts`, `tests/providers/exedev/helpers.ts`, `tests/phase-engine/journal-test-util.ts`,
    `tests/gitnexus/harness.ts` — same pattern.
  - No `tests/helpers.ts` at the root.
- File-reading tests just use `readFileSync`/`readdirSync` against repo-relative paths resolved
  from `import.meta.dir` or `process.cwd()`; for DF3.5 the skill files are static repo files, so
  no temp dir is needed at all — read `.claude/skills/factory/*/SKILL.md` directly.
- Docblock convention: fleet test files open with a `/** ... */` banner listing story ID and
  coverage (see `tests/fleet/dispatch.test.ts:1-21`). Match it.
- AGENTS.md test rule: run via `bun test > /tmp/qds-test.log 2>&1` and extract failures with the
  `tr '\r' '\n' | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | grep -E "\(fail\)|^error"` pipeline —
  bun's carriage-return/ANSI progress output defeats plain grep.

## 4. Lint/format constraints on new files (`biome.json`)

- `biome.json` (root, schema 1.9.4):
  - `organizeImports.enabled: false` — import order is free.
  - `formatter.enabled: false` — **no enforced formatting**; match surrounding style by eye.
  - `linter.enabled: true`, `rules.recommended: true`, with only two relaxations:
    `suspicious.noExplicitAny: "off"`, `style.noNonNullAssertion: "off"`.
  - `files.ignore`: `node_modules`, `_bmad-output`, `.gitnexus`, `.claude`, `.swarm`, `docs`,
    `visualizer/**/*.vue`, `visualizer/dist` — note **`.claude` is ignored**, so the SKILL.md files
    are not linted (biome wouldn't lint Markdown anyway), but `tests/fleet/skill-contract.test.ts`
    IS linted (the `lint` script runs `bunx @biomejs/biome check ... tests ...`).
- Practical implications for the new test file: recommended-rule clean means no unused imports
  (`correctness/noUnusedImports`), no `var`, no `debugger`, template-literal/const preferences from
  the recommended set. Long regex literals are fine (formatter is off, no line-length rule).
- Tabs vs spaces: `src/` and vendored files use tabs (e.g. `coms-core.ts`); `tests/fleet/dispatch.test.ts`
  uses 2-space indent. Follow the 2-space style of the directory the file lands in (`tests/fleet/`).

## 5. Context7 MCP availability

**No Context7 MCP tool is available in this session** (tool inventory: Bash/Cron/Edit/FetchURL/Glob/
Grep/Read/ReadMediaFile/Skill/Task*/TodoList/WebSearch/Write only). No genuine library question
remains anyway — the `yaml` v2 API (`parse`, `YAMLParseError`) is already exercised in-repo at the
import sites listed in §1, which are the ground truth for version and idiom.

## DF3.5-specific pointers for the implementer

- Verb registry: `src/fleet/verbs.ts:70` — `export function listVerbs(): VerbEntry[]` (module doc
  at `:4` calls it "the closed verb registry — the sole source for --help"). The contract test
  imports this directly.
- Story spec: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-5-tier1-factory-skills.md`
  — AC1 (verb/flag resolution with `file:line` + did-you-mean), AC2 (frontmatter `name` == directory,
  `description` names routed verbs), AC4 (six fixed case-insensitive lint patterns (a)–(f) with two
  verbatim allowlisted exceptions in `factory-guide/SKILL.md`).
- Suggested test stack, all already in-repo: `yaml.parse` for frontmatter, a local regex fence
  extractor, `readdirSync`/`readFileSync` over `.claude/skills/factory/`, `listVerbs()` for
  resolution, `new RegExp(pattern, "i")` for the AC4 lint set.
