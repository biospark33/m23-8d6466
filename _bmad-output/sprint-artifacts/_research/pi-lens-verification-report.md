# pi-lens Headless Verification Report — Story P0.5

**Story:** P0.5 — Install pi-lens + Prove Headless Machine-Readable TDI/Warnings
**Date:** 2026-07-14 (revised; supersedes the 2026-07-11 draft)
**Host:** darwin arm64, `pi` 0.55.0, node v22.22.3, bun 1.2.22
**Verification script:** `scripts/pi-lens-verify.ts` (run: `bun scripts/pi-lens-verify.ts`)

All command output below is **real captured output** from a live run on this host
(`bun scripts/pi-lens-verify.ts`, exit 0). Trimmed JSON blocks are explicitly
labeled **excerpt** — they are shortened for readability, not fabricated.

This revision was produced alongside a substantial honesty pass on the harness
itself: the earlier draft over-reported (claimed 3/3 pass with no skips, claimed a
live Python/pyright proof, and described an emit-block as if observed). The revised
harness splits secret-scan into a live-detection check and a separate empirical
emit-block probe, and labels every ID as *observed* vs *derived*. Every claim below
is reconciled against that revised harness's actual output.

---

## 0. Version resolution (spec: v3.8.47)

| Item | Value |
|------|-------|
| Spec-pinned version | `3.8.47` |
| **Installed / resolved version** | **`3.8.69`** |
| Install location | `/Users/steve/.local/node-arm64/lib/node_modules/pi-lens` |
| `~/.pi/agent/settings.json` `packages` | `["npm:pi-lens", "npm:pi-gitnexus-plus@0.7.0"]` ✅ |
| `versionMismatch` (harness summary) | `true` (drift reported, non-fatal) |

**Version-drift note.** The host (and `settings.json`) has **pi-lens 3.8.69**
installed, not the spec's 3.8.47 — the registry has moved 22 patch versions past
the pin. Verification was run against the installed **3.8.69**, and every result
below is tagged with that version (the harness emits
`piLensVersion:"3.8.69", piLensVersionSpec:"3.8.47", versionMismatch:true` in its
summary, plus a non-fatal drift note). No re-pin to 3.8.47 was performed:
downgrading the host's shared global install is outside this story's file scope
(`scripts/` + report) and would risk the other Phase-0 pi tooling. If a hard
3.8.47 pin is required, run `pi install npm:pi-lens@3.8.47` after confirming no
Phase-0 sibling depends on 3.8.69 behavior.

---

## 1. Result summary (real script output, excerpt)

```
$ bun scripts/pi-lens-verify.ts
{
  "results": [ … 4 checks; see per-AC sections … ],
  "summary": {
    "piLensVersion": "3.8.69",
    "piLensRoot": "/Users/steve/.local/node-arm64/lib/node_modules/pi-lens",
    "piLensVersionSpec": "3.8.47",
    "versionMismatch": true,
    "strict": false,
    "pass": 3,
    "fail": 0,
    "skip": 1,
    "optionalSkip": 1,
    "notes": ["pi-lens version drift: spec pins 3.8.47, installed 3.8.69 (non-fatal)"]
  }
}
# exit 0
```

**3 pass, 0 fail, 1 skip (optional).** The single skip is AC2b (secret-scan
emit-block), which is marked `optional: true` because it depends on
gitleaks/trivy being installed on the host.

**Exit-code semantics (as implemented):**

- exit **0** iff there are no FAILs — skips are allowed (AC2b's optional skip
  still yields exit 0);
- exit **1** on any FAIL, or — under `--strict` / `CI` env — on any skip of a
  **non-optional** check (AC2b is optional, so `--strict` still exits 0 here);
- exit **2** on fatal harness error (e.g. pi-lens not found, MCP server crash).

---

## 2. Headless method (no live LLM)

A full Pi **agent** turn requires LLM auth, which is unavailable in this shell:

```
$ pi -p --mode json --no-session "reply OK"
{"type":"session","version":3,"id":"…","cwd":"/private/tmp"}
Error: Authentication failed for "anthropic". Credentials may have expired…
```

What this establishes, and the scope limit:

1. `--mode json` **does emit machine-readable JSON on stdout** (the `session`
   event above) with **no TUI** — the headless-emission integration point is
   confirmed independent of auth. **Scope:** this is the *session handshake only*.
   No diagnostic payload was ever observed via `--mode json` (the turn dies at
   auth before any tool runs), so DoD item 4 is only partially satisfied (§7).
2. For the tool-execution surfaces (lsp_diagnostics, secret-scan, warning
   aggregation) the harness drives the **pi-lens MCP server**
   (`dist/mcp/server.js`) over stdio JSON-RPC, using a minimal newline-framed
   JSON-RPC 2.0 client (`McpClient`). This is the *same engine* the Pi agent's
   tools call — reached headlessly, no LLM in the loop. The server child is
   spawned under an explicit **Node** runtime (`PILENS_NODE` override, else
   `node` on PATH, else `process.execPath` as last resort) — not bun — because
   pi-lens ships a Node package.

MCP tools exercised: `pilens_lsp_diagnostics`, `pilens_analyze`,
`pilens_turn_end` (plus `initialize`/JSON-RPC handshake).

**State containment (new in the revised harness):** the server is spawned with
`PILENS_DATA_DIR` pointed **inside** the temp work dir (plus
`PI_LENS_CONFIG_PATH` for a run-local config enabling the actionable-warnings
aggregator), so all pi-lens on-disk state is removed with the work dir — no more
`~/.pi-lens/projects/*pilens-verify*` orphans, and the user's global
`~/.pi-lens/config.json` is untouched.

---

## 3. AC → evidence map

### AC1 — structured LSP diagnostic + stable `aw:<hash>` ID — **PASS** (with an honest provenance caveat)

Fixture (generated at runtime): a TS file with a genuine type error
(`const wrong: string = add(1, 2)`). Driven via `pilens_lsp_diagnostics` (warm
LSP) → `pilens_analyze`. Real evidence (excerpt from the harness's AC1 check):

```json
{
  "diagnosticCount": 1,
  "lspStatus": "failed",
  "lspLatencyMs": 1211,
  "diagnostic": {
    "line": 4, "column": 7,
    "severity": "error", "semantic": "blocking",
    "tool": "lsp", "rule": "typescript:2322",
    "message": "Type 'number' is not assignable to type 'string'."
  },
  "stableId":       "aw:35344075b5",
  "idProvenance":   "derived+native-parity",
  "idReproducible": true,
  "nativeId":       "aw:35344075b5",
  "matchesNative":  true,
  "idObserved":     false,
  "warningFixtureDiagnostic": { "rule": "Pyright:reportUnusedImport", "severity": "warning", "fixable": false },
  "awHistoryEntries": 0
}
```

Framing, precisely:

- **`lsp_diagnostics` returns plain text; the structured array comes from
  `pilens_analyze`.** The tool literally named `pilens_lsp_diagnostics` returns a
  human-readable line (`L4:7: error[typescript] (2322): Type 'number' is not
  assignable to type 'string'.`). The structured `diagnostics[]` array above
  (`tool`, `rule`, `severity`, `line`, `column`, `message`) is returned by
  `pilens_analyze`. `lspStatus: "failed"` means the type-check found errors, not
  that tooling failed — the diagnostic is valid (see Findings §5.5).
- **The story's `tool_execution_end` → `JSON.stringify` contract path is NOT
  exercised.** That path belongs to a live Pi agent turn (LLM-gated). The harness
  reaches the same structured payload a different way: pi-lens's MCP server
  serializes the `details` object as a fenced ` ```json ` block appended to the
  tool's summary text (`dist/mcp/server.js:toolText`), and the harness parses
  that fence. Same data, different transport — documented, not hidden.
- **The `aw:<hash>` ID is DERIVED, not observed — `idObserved: false`.** The
  harness computes `aw:` + first 10 hex of
  `sha256(relFile|tool|source|code|rule|normMessage|line)`
  (`dist/clients/actionable-warnings.js:createActionableWarningId`, where
  `normMessage = message.replace(/\s+/g," ").trim().toLowerCase()`), proves it is
  deterministic (`idReproducible: true`), and proves **parity with pi-lens's own
  id function** by importing the native `createActionableWarningId` from the
  installed package (`nativeId === stableId`, `matchesNative: true`). But pi-lens
  did **not** emit this id itself for the TS2322 error: error-severity
  diagnostics are surfaced as blockers and are never fed to the
  actionable-warnings aggregator.
- **Why the observed-id probe came back empty (`awHistoryEntries: 0`).** The
  harness includes a second fixture — a Python file with an unused import, with
  `pyrightconfig.json` setting `reportUnusedImport: "warning"` — whose sole
  purpose is to probe for an id pi-lens *actually assigned* (read back from
  `actionable-warnings.jsonl` after `pilens_turn_end`). This run, the pyright
  fixture **did** surface a real severity-2 LSP diagnostic
  (`Pyright:reportUnusedImport`, see `warningFixtureDiagnostic`), but pi-lens
  assigned **no** `aw:` id at turn-end: the aggregator
  (`dist/clients/actionable-warnings.js`) additionally requires an LSP **code
  action** for the diagnostic, and this host's language servers provide none for
  it — OSS pyright ships no quick-fix for `reportUnusedImport`, and TypeScript
  has no warning-category diagnostics at all. (Dispatch-path warnings such as
  ruff can't be observed over this transport either: the MCP `pilens_analyze`
  path never records them into the warm runtime.) So the evidence for "stable
  `aw:<hash>` id" is: **derived id + native-function parity + determinism**, with
  `idObserved:false` recorded explicitly. The observed-id probe remains open,
  gated on an LSP that emits a code-action-bearing warning.

**Contract — structured diagnostic format (documented; sourced from captured evidence):**

| Field | Type | Example | Evidence status |
|-------|------|---------|-----------------|
| `line` / `column` | number (1-based) | `4` / `7` | captured |
| `severity` | `error` \| `warning` \| `info` | `error` | captured |
| `semantic` | `blocking` \| `warning` | `blocking` | captured |
| `tool` | source runner | `lsp` | captured |
| `rule` | `<Server>:<code>` | `typescript:2322`, `Pyright:reportUnusedImport` | captured |
| `message` | string | `Type 'number' is not assignable…` | captured |
| `fixable` | bool | `false` (pyright fixture) | captured for the warning fixture only; not present in the TS2322 evidence |
| `fixSuggestion` | string | quick-fix text | **source-known only** — not in any captured evidence this run |
| finding ID | `aw:<10-hex>` | `aw:35344075b5` | derived + native-parity (not pi-lens-observed) |

### AC2a — secret-scan **detection** (live, opengrep) — **PASS**

Fixture (generated at runtime, **synthetic** — never a real credential):

```
// synthetic test pattern, not a real key
// (shapes shown abstractly so this report never itself carries a key-shaped string)
const awsKey   = "AKIA" + "A".repeat(16);   // synthetic AWS access-key-id shape
const apiToken = "sk-"  + "a".repeat(40);   // synthetic OpenAI secret-key shape
```

Real detection (via warm LSP dispatch — secret rules attach as an auxiliary
scanner to the LSP runner; the harness `git init`s + stages the fixture dir
because opengrep's secret ruleset scopes to the git working tree, and polls
`pilens_analyze` up to 4× to get past opengrep's cold start). Harness evidence
(excerpt):

```json
{
  "detectedBy": "opengrep",
  "rule": "Semgrep:generic.secrets.security.detected-aws-access-key-id-value.detected-aws-access-key-id-value",
  "message": "AWS Access Key ID Value detected. This is a sensitive credential and should not be hardcoded here…",
  "line": 2,
  "severity": "warning",
  "matchedBy": "provenance (tool/rule family), not keyword regex",
  "git": { "available": true, "initOk": true, "stagedOk": true },
  "gitleaksOnPath": false,
  "trivyOnPath": false,
  "fixtureSecretsSynthetic": true
}
```

### AC2b — secret-scan **emit-block** on NFR-SEC-3 (empirical `pilens_turn_end` probe) — **SKIP (optional), NOT observed**

This is the honesty split: detection is proven live (AC2a), but the emit-block
was **NOT observed**. Harness evidence (excerpt):

```json
{
  "status": "skip",
  "optional": true,
  "emitBlockObserved": false,
  "detectionProvenLive": true,
  "turnEndExcerpt": "Turn-end over 3 file(s).\nNo turn-end advisory.\n…\"filesRegistered\": 3…",
  "gitleaksOnPath": false,
  "trivyOnPath": false,
  "blockMechanism": "runtime-turn.js: sessionSecrets (gitleaks+trivy ONLY) → blockerParts.push('🔴 STOP — hardcoded secrets detected'); opengrep findings enrich but never promote",
  "blockMechanismSourceVerified": true
}
```

- **Why no block fired:** `dist/clients/runtime-turn.js` pushes
  `🔴 STOP — hardcoded secrets detected` into `blockerParts` **only** from
  `sessionSecrets` — i.e. gitleaks + trivy findings. Bundled opengrep (ast-grep)
  findings merely *enrich* a blocker whose location already came from
  gitleaks/trivy; opengrep-only findings stay advisory-tier and never block by
  themselves. gitleaks/trivy are not installed on this host, so the turn-end
  output contains no blocker — hence skip, not pass.
- **What IS verified:** the block mechanism string and the `sessionSecrets`
  promotion path are present in the installed source
  (`blockMechanismSourceVerified: true`). The blocker report prints only
  `file:line — rule [sources]`, never the secret value.
- **To close this live:** install gitleaks or trivy on PATH (or run an
  LLM-backed agent turn), then re-run; the probe passes only when the `🔴 STOP`
  line is actually observed in turn-end output.

> **Spec-vs-impl discrepancy (flagged, NOT silently "confirmed"):** the story's
> literal `secret_detected` finding-type string **does not exist** in pi-lens
> 3.8.69. The old regex secrets-scanner (which likely emitted that type) was
> removed (commit `b8f368d`, per `secret-findings.js` header). Secrets are now
> surfaced via gitleaks/trivy/ast-grep/opengrep **rule IDs** (e.g.
> `generic.secrets.security.detected-aws-access-key-id-value`,
> `*-hardcoded-secret-*`). Detection behavior is present and proven live, but the
> AC/DoD wording (`secret_detected` finding type) does not match the
> implementation — DoD item 6 is recorded as **not met as literally worded** (§7),
> not redefined as satisfied.

### AC3 — warning-count readable as numeric from on-disk pi-lens artifact (FR-EX-8) — **PASS** (0-value fallback, reconciled)

Harness evidence (excerpt — paths shortened):

```json
{
  "projectDir": "/var/folders/…/pilens-verify-…/.pilens-data/…-pilens-verify-…",
  "artifactRead": "…/.pilens-data/…/cache/code-quality-warnings.json",
  "warningCount": 0,
  "fallbackReason": "actionable-warnings.jsonl absent (only appended when the aw: aggregator emits ≥1 warning at turn-end; headless TDI slash-command unavailable). Fell back to code-quality-warnings.json summary.warnings — the turn-delta warning-count proxy."
}
```

- **What is proven:** FR-EX-8's contract — a warning count **readable as a
  numeric value** from an on-disk pi-lens artifact, with an **explicit logged
  fallback reason** when the primary artifact is absent. The harness reads the
  primary NDJSON history `actionable-warnings.jsonl` first, then falls back to
  the turn-delta `cache/code-quality-warnings.json` (`summary.warnings`) with the
  reason string above.
- **Honest reconciliation of the demonstrated count (`0`):** the primary
  artifact has 0 entries because the aw: aggregator emitted nothing this run
  (see AC1 — no code-action-bearing warning exists for it to aggregate). And the
  fallback count is legitimately 0 for these fixtures: the TS2322 type error is
  `semantic: "blocking"` (a blocker, not a warning) and the opengrep secret
  finding, while warning-severity, is not part of the turn-delta warning count.
  So the *machinery* (numeric read + fallback + reason) is proven live; the
  *demonstrated value* is 0, not a positive count.
- **Containment:** note the `projectDir` lives under the temp dir's
  `.pilens-data/` — the revised harness contains all pi-lens state via
  `PILENS_DATA_DIR`, so the read above exercises the real resolution logic
  without littering `~/.pi-lens/projects/`.

> **Path finding (documented):** pi-lens's on-disk project data dir is
> **project-scoped** — default `~/.pi-lens/projects/<slug>/` (not the flat
> `~/.pi-lens/cache/` the spec names), unless a `<project>/.pi-lens/` dir already
> exists or `PILENS_DATA_DIR` is set (`dist/clients/file-utils.js`). The harness
> reproduces this resolution exactly.

---

## 4. Security invariants

- **INV-1** (secret-scan blocks emit, no secret reaches output): **detection
  confirmed live; block path source-verified, NOT exercised live.** The opengrep
  rule fires headlessly on the synthetic key (AC2a). The `🔴 STOP` blocker-push
  is verified in `dist/clients/runtime-turn.js` but was not observed in turn-end
  output because gitleaks/trivy are absent and opengrep-only findings never
  promote (AC2b). No secret value reaches any output in either path — the
  blocker names `file:line — rule [sources]` only. ⚠️ (partial)
- **INV-2** (LSP servers discovered from PATH only, no arbitrary binaries):
  confirmed by source (`dist/clients/lsp/server.js`). TS server: prefer
  `<root>/node_modules/.bin/typescript-language-server`, else PATH-resolved via
  `ensureTool("typescript-language-server", …)`. Python: prefer
  `node_modules/.bin/pyright-langserver`, else PATH `pyright-langserver --stdio`.
  All servers are launched by **named commands** from `LSP_SERVERS` specs; no
  arbitrary/user-supplied binary path is executed. ✅
- **Synthetic-secret hygiene:** fixtures are generated at runtime from string
  fragments (no key-shaped literal is ever committed to the repo); the temp dir
  is deleted after the run, and under `--keep` the secret fixture is
  overwritten-then-deleted so no key-shaped strings persist. ✅

---

## 5. Findings / discrepancies (spec vs pi-lens 3.8.69)

1. **Version drift** — installed 3.8.69, spec pins 3.8.47 (§0). Verified against
   3.8.69; drift is surfaced by the harness as a non-fatal note.
2. **Finding-type `secret_detected` does not exist** — rule-ID-based detection
   instead (AC2b note). Flagged as a spec-vs-impl discrepancy; the DoD item
   worded around `secret_detected` is recorded not-met, not redefined.
3. **Artifact path** — spec `~/.pi-lens/cache/actionable-warnings.json`; actual
   default `~/.pi-lens/projects/<slug>/`, and the *written* proxy is
   `cache/code-quality-warnings.json`; the aw: history is NDJSON
   `actionable-warnings.jsonl`, appended only when the aggregator emits ≥1
   warning. Handled via primary→fallback read with a logged reason (AC3).
4. **opengrep secret rules are git-working-tree scoped + cold-start racy** — a
   bare (non-git) temp dir yields 0 secret findings; `git init`/`git add` makes
   them fire. opengrep also runs as a warm auxiliary LSP server whose FIRST pass
   is a cold ~8s start (warms to ~1.3s), so a single analyze pass can race the
   cold start and miss the secret. The harness handles both: it `git init`s and
   stages the fixture dir AND polls `pilens_analyze` up to 4× until a secret
   surfaces — verified deterministic across consecutive runs.
5. **LSP cold latency exceeds NFR-PERF-6** — the warm `lspLatencyMs` observed in
   AC1 evidence is ~1.2–1.9s (1211ms in the quoted run), within the ≤3s p95
   target; **cold** starts (first-ever LSP boot, esp. pyright) exceed it. pi-lens
   itself writes a real `~/.pi-lens/latency.log` (structured JSON lines with
   `durationMs`) for p95 tracking. Guard note only; pi-lens augmentation is
   advisory (NFR-PERF-5), so this does not block a turn.
6. **`lsp.status: "failed"` with a valid diagnostic** — pi-lens marks the LSP
   runner "failed" when the file *has* type errors (the type-check "failed"),
   not when tooling failed; the diagnostic is still valid and returned. Not a bug.
7. **`--mode json` scope** — only the session-handshake event was observed on
   stdout before auth failure; no diagnostic payload has ever been seen via
   `--mode json`. All diagnostic validation went over the MCP stdio transport.

---

## 6. What runs live vs. source-verified

| Path | Live headless | Source-verified |
|------|:---:|:---:|
| `--mode json` stdout session-handshake emission (no TUI) | ✅ (handshake only) | |
| MCP server boot + JSON-RPC tools/call (Node runtime) | ✅ | |
| LSP type-error diagnostic (TS) — via `pilens_analyze` | ✅ | |
| LSP warning diagnostic (Python/pyright) | △ | ✅ (`lsp/server.js`) |
| `aw:<hash>` ID == pi-lens native fn (parity) | ✅ | ✅ |
| `aw:<hash>` ID **observed** (pi-lens-assigned, read back) | ❌ (`idObserved:false`, code-action gate) | |
| Secret **detection** (opengrep AWS key) | ✅ | |
| Secret **emit-block** (turn-end `🔴 STOP` blocker) | ❌ (needs gitleaks/trivy) | ✅ (`runtime-turn.js`) |
| Warning-count proxy on-disk read + fallback | ✅ (count demonstrated = 0) | |
| INV-2 PATH-only LSP discovery | | ✅ (`lsp/server.js`) |
| gitleaks/trivy session-scan secret path | ❌ (binaries not installed) | ✅ |
| Full `--mode json` agent e2e turn | ❌ (LLM auth unavailable) | |

**△ — the Python/pyright row, stated precisely:** there is **no dedicated Python
check** in the harness. The pyright fixture exists solely as AC1's observed-id
probe (§3 AC1). This run, pyright **did** launch live and return a real
severity-2 diagnostic (`Pyright:reportUnusedImport`) for that fixture — but the
harness asserts nothing Python-specific (no pass/fail check, no Python TDI
proof), and no `aw:` id was assigned to it. So the earlier draft's "Python TDI
live ✅" claim is downgraded: **pyright ran live as a fixture, but Python
headless TDI is not exercised as a check; PATH discovery for it is
source-verified only.**

---

## 7. DoD traceability (all 9 story checkboxes)

| # | DoD item | Status | Evidence |
|---|----------|--------|----------|
| 1 | pi-lens v3.8.47 installed via `pi install`; settings.json entry | **Partial (drift)** | `settings.json` `packages` contains `npm:pi-lens` ✅; installed version is **3.8.69**, not the pinned 3.8.47 — drift surfaced by the harness (`versionMismatch:true`), non-fatal, re-pin deferred (§0). |
| 2 | Verification script exercises `lsp_diagnostics`, secret-scan, warning-count proxy | **Met** | Revised `scripts/pi-lens-verify.ts` exercises all three (AC1, AC2a, AC3) plus the emit-block probe (AC2b). |
| 3 | `lsp_diagnostics` structured output format documented | **Met** | §3 AC1 contract table — with the corrected framing that the structured array comes from `pilens_analyze` and fields not in captured evidence (`fixSuggestion`) are source-tagged. |
| 4 | `--mode json` headless emission confirmed (machine-readable JSON, no TUI) | **Partial** | Only the **session-handshake event** was observed on stdout before LLM auth failure (§2). No diagnostic payload via `--mode json`; the diagnostic payload was validated over the MCP stdio transport instead. |
| 5 | LSP server auto-discovery from PATH confirmed for TypeScript and Python | **Partial** | **TS: live** — `typescript-language-server@5.3.0` resolved from PATH, real TS2322 diagnostic (AC1). **Python: not exercised live as a check** — pyright ran live only as the AC1 observed-id probe fixture (diagnostic surfaced, no assertion, no `aw:` id); PATH discovery source-verified (INV-2). Recorded as "TS live; Python not exercised live." |
| 6 | Secret-scan blocks emit on hardcoded key; finding type `secret_detected` confirmed | **Not met (as literally worded)** | Detection live (AC2a). Emit-block **not observed** (AC2b optional skip — gitleaks/trivy absent; opengrep-only findings never promote). `secret_detected` finding-type string **does not exist** in pi-lens 3.8.69 (rule-ID-based detection) — flagged as a spec-vs-impl discrepancy, not "confirmed." |
| 7 | TDI proxy path documented: on-disk read + logged fallback (FR-EX-8) | **Met** | AC3: numeric read from `cache/code-quality-warnings.json` with explicit `fallbackReason`; primary `actionable-warnings.jsonl` path documented. Demonstrated count is 0 — reconciled in §3. |
| 8 | Test: structured diagnostics parseable with stable IDs; warning count numeric; secret-scan blocks | **Partial** | Diagnostics parseable with a **derived** stable id proven by native-function parity (`idObserved:false` — not pi-lens-assigned); warning count numeric (0-value fallback); secret-scan **detects** live but **block not observed**. |
| 9 | **MANDATORY e2e:** Pi agent runs `--mode json`; stdout has structured diagnostics + warning count; secret-scan blocks | **NOT met** | Blocked on LLM auth (§2). No agent turn was run; no diagnostic or block was observed on `--mode json` stdout. Behavior was validated via the **same engine** (pi-lens MCP server) over stdio, but the mandatory `--mode json` agent demo itself remains open. |

**Net:** 3 met, 4 partial, 2 not met. The mandatory e2e demo (item 9) and the
literal secret-scan wording (item 6) are the hard blockers to "fully done."

---

## 8. Reproduce

**Preconditions (must be on PATH):** `bun` (1.2.22 used), `node` (v22.22.3 used),
`git`, `typescript-language-server@5.3.0`, `pyright-langserver` (pyright
1.1.410). pi-lens **3.8.69** installed globally (spec pins 3.8.47 — drift is
reported, non-fatal). Optional: `gitleaks`/`trivy` (absent here → AC2b skips).

```bash
bun scripts/pi-lens-verify.ts          # structured JSON on stdout
bun scripts/pi-lens-verify.ts --keep   # retain temp dir (synthetic secret fixture still scrubbed)
bun scripts/pi-lens-verify.ts --strict # skips of NON-optional checks fail the run (CI env implies --strict)
```

**Exit semantics:** exit 0 iff no FAIL (skips allowed); exit 1 on any FAIL, or on
a non-optional skip under `--strict`/`CI`; exit 2 on fatal error. Runtime is ~1–2
min due to LSP cold starts. Flags: `--json` (accepted; output is always JSON).
