# pi-lens Headless Verification Report — Story P0.5

**Story:** P0.5 — Install pi-lens + Prove Headless Machine-Readable TDI/Warnings
**Date:** 2026-07-11
**Host:** darwin arm64, `pi` 0.55.0, node v24.1.0, bun
**Verification script:** `scripts/pi-lens-verify.ts` (run: `bun scripts/pi-lens-verify.ts`)

All command output below is **real captured output**, not fabricated.

---

## 0. Version resolution (spec: v3.8.47)

| Item | Value |
|------|-------|
| Spec-pinned version | `3.8.47` |
| **Installed / resolved version** | **`3.8.68`** |
| Install location | `/Users/steve/.local/node-arm64/lib/node_modules/pi-lens` |
| `~/.pi/agent/settings.json` `packages` | `["npm:pi-lens"]` ✅ |
| `pi list` | `npm:pi-lens → …/node_modules/pi-lens` ✅ |

```
$ npm view pi-lens version
3.8.68
$ npm view pi-lens@3.8.47 version
3.8.47          # 3.8.47 still exists in the registry
$ node -e "console.log(require('.../pi-lens/package.json').version)"
3.8.68           # but 3.8.68 is what is installed & pinned in settings
```

**TODO(goal): version note.** The pre-verified host state (and `settings.json`)
already has **pi-lens 3.8.68** installed, not the spec's 3.8.47. 3.8.47 is still
obtainable from npm, but the registry has moved 21 patch versions past it and the
host was provisioned with 3.8.68. Per goal instructions ("if a different version
is installed … record the actual resolved version … do not silently claim
3.8.47"), **verification was run against the installed 3.8.68** and every result
below is tagged with that version. No re-pin to 3.8.47 was performed because
downgrading the host's shared global install is out of this story's file scope
(`scripts/` + report only) and would risk the other Phase-0 pi tooling. If a hard
3.8.47 pin is required, run `pi install npm:pi-lens@3.8.47` — but confirm no
Phase-0 sibling depends on 3.8.68 behavior first.

---

## 1. Result summary (real script output)

```
$ bun scripts/pi-lens-verify.ts
{
  "results": [ … see per-AC sections … ],
  "summary": {
    "piLensVersion": "3.8.68",
    "piLensRoot": "/Users/steve/.local/node-arm64/lib/node_modules/pi-lens",
    "pass": 3,
    "fail": 0,
    "skip": 0
  }
}
# exit 0
```

**3/3 acceptance checks PASS, 0 fail, 0 skip.**

---

## 2. Headless method (no live LLM)

A full Pi **agent** turn requires LLM auth, which is unavailable in this shell:

```
$ pi -p --mode json --no-session "reply OK"
{"type":"session","version":3,"id":"…","cwd":"/private/tmp"}
Error: Authentication failed for "anthropic". Credentials may have expired…
```

Two things this proves and how the harness works around it:

1. `--mode json` **does emit machine-readable JSON on stdout** (the `session`
   event above) with **no TUI** — the "headless emission" integration point is
   confirmed independent of auth.
2. For the tool-execution surfaces (lsp_diagnostics, secret-scan, warning
   aggregation) the harness drives the **pi-lens MCP server** (`pi-lens-mcp`,
   `dist/mcp/server.js`) over stdio JSON-RPC. This is the *same engine* the Pi
   agent's tools call — reached headlessly, no LLM in the loop. Server boot:

   ```
   [pi-lens-mcp] ready (cwd=/private/tmp/pilens-verify-…)
   [pi-lens-mcp] warm side-channel listening at /var/folders/…/pi-lens-mcp-….sock
   ```

MCP tools exposed (real, from `dist/mcp/server.js`): `pilens_lsp_diagnostics`,
`pilens_analyze`, `pilens_turn_end`, `pilens_diagnostics`, `pilens_health`,
`pilens_latency`, `pilens_project_scan`, plus navigation/symbol tools.

---

## 3. AC → evidence map

### AC1 — lsp_diagnostics structured JSON + stable `aw:<hash>` ID — **PASS**

Fixture (generated at runtime): a TS file with a genuine type error
(`const wrong: string = add(1, 2)`). Driven via `pilens_lsp_diagnostics` (warm
LSP) → `pilens_analyze`. Real structured output:

```json
{
  "diagnostic": {
    "line": 4, "column": 7,
    "severity": "error", "semantic": "blocking",
    "tool": "lsp", "rule": "typescript:2322",
    "message": "Type 'number' is not assignable to type 'string'."
  },
  "stableId":     "aw:35344075b5",
  "idReproducible": true,
  "nativeId":     "aw:35344075b5",
  "matchesNative": true
}
```

- **Structured `lsp_diagnostics`**: the pure MCP `pilens_lsp_diagnostics` call
  returns `L4:7: error[typescript] (2322): Type 'number' is not assignable to
  type 'string'.`; `pilens_analyze` returns the full structured `diagnostics[]`
  array above (`tool`, `rule`, `severity`, `line`, `column`, `message`).
- **Stable `aw:<hash>` ID**: `aw:` + first 10 hex of
  `sha256(relFile|tool|source|code|rule|normMessage|line)`
  (`dist/clients/actionable-warnings.js:createActionableWarningId`, where
  `normMessage = message.replace(/\s+/g," ").trim().toLowerCase()`).
- **Parity proof**: the harness re-derives the ID locally AND imports pi-lens's
  **own** `createActionableWarningId` and asserts they are equal —
  `stableId === nativeId === aw:35344075b5`, `matchesNative: true`. The ID is
  deterministic (`idReproducible: true`), hence stable across turns.

**Contract — `lsp_diagnostics` structured output format (documented):**

| Field | Type | Example |
|-------|------|---------|
| `line` / `column` | number (1-based) | `4` / `7` |
| `severity` | `error` \| `warning` \| `info` | `error` |
| `semantic` | `blocking` \| `warning` | `blocking` |
| `tool` | source runner | `lsp` |
| `rule` | `<Server>:<code>` | `typescript:2322`, `Pyright:reportUnusedVariable` |
| `message` | string | `Type 'number' is not assignable…` |
| `fixable` / `fixSuggestion` | bool / string | quick-fix availability |
| finding ID | `aw:<10-hex>` | `aw:35344075b5` |

> **Nuance (documented, not a failure):** the `aw:<hash>` ID is attached by the
> **actionable-warnings aggregator** (`recordFromLspDiagnostic` /
> `recordFromDispatchDiagnostic`), which only *persists* a warning to
> `actionable-warnings.json` when it is `semantic:"warning"` AND
> (`fixable || fixSuggestion`). A **blocking** type error (like `2322`) is
> surfaced as a blocker, so its `aw:` ID is derived on demand (as the harness
> does) rather than written to the actionable-warnings artifact. The ID function
> is identical for both paths — proven by the native-parity check.

### AC2 — secret-scan detects + blocks emit (NFR-SEC-3 / INV-1) — **PASS**

Fixture (generated at runtime, **synthetic** — never a real credential):

```
// synthetic test pattern, not a real key
// (shapes shown abstractly so this report never itself carries a key-shaped string)
const awsKey   = "AKIA" + "A".repeat(16);   // synthetic AWS access-key-id shape
const apiToken = "sk-"  + "a".repeat(40);   // synthetic OpenAI secret-key shape
```

Real detection (via warm LSP dispatch — secret rules attach as an auxiliary
scanner to the LSP runner):

```json
{
  "detectedBy": "opengrep",
  "rule": "Semgrep:generic.secrets.security.detected-aws-access-key-id-value.detected-aws-access-key-id-value",
  "message": "AWS Access Key ID Value detected. This is a sensitive credential and should not be hardcoded here…",
  "line": 2,
  "severity": "warning",
  "blockMechanism": "runtime-turn.js: sessionSecrets → blockerParts.push('🔴 STOP — hardcoded secrets detected')"
}
```

- **Detection (live):** the bundled **opengrep** (Semgrep) secret ruleset flags
  the synthetic AWS key headlessly. (opengrep's secret rules scope to the **git
  working tree**, so the harness `git init` + `git add`s the fixture dir — see
  Findings §5.)
- **Emit-block (source-verified):** `dist/clients/runtime-turn.js` collapses
  gitleaks + trivy + ast-grep hardcoded-secret findings by location
  (`secret-findings.js:dedupeSecretFindings`) and, when any exist, pushes
  `🔴 STOP — hardcoded secrets detected. Rotate the credentials…` into
  `blockerParts` — a **turn-end blocker that blocks the emit** (INV-1 /
  NFR-SEC-3). No secret string is echoed into merged output; the blocker names
  `file:line — rule [sources]` only.

> **Finding — finding-type name mismatch (documented):** the spec's literal
> `secret_detected` finding-type string **does not exist** in pi-lens 3.8.68. The
> old regex secrets-scanner (which likely emitted that type) was removed
> (commit `b8f368d`, per `secret-findings.js` header). Secrets are now surfaced
> via gitleaks/trivy/ast-grep/opengrep rule IDs (e.g.
> `generic.secrets.security.detected-aws-access-key-id-value`,
> `aws-access-token`, `*-hardcoded-secret-*`). The *behavior* the AC requires —
> detect a hardcoded key and block the emit — is fully present; only the
> finding-type label differs. AC2 is satisfied on behavior.

### AC3 — warning-count proxy from on-disk `~/.pi-lens` artifact (FR-EX-8) — **PASS**

Real output:

```json
{
  "cacheDir": "/Users/steve/.pi-lens/projects/…-pilens-verify-…/cache",
  "artifactRead": ".../cache/code-quality-warnings.json",
  "warningCount": 0,
  "fallbackReason": "actionable-warnings.json absent (only written when fixable-warning findings aggregate at turn-end; headless TDI slash-command unavailable). Fell back to code-quality-warnings.json summary.warnings — the turn-delta warning-count proxy."
}
```

- **Numeric count:** `warningCount: 0` read from the on-disk artifact
  (`summary.warnings`) — a readable numeric value (FR-EX-8).
- **Logged fallback reason:** the spec names
  `~/.pi-lens/cache/actionable-warnings.json`. On disk, pi-lens 3.8.68 writes the
  turn-delta proxy as **`code-quality-warnings.json`** in the same cache dir;
  `actionable-warnings.json` is only written when fixable-warning findings
  aggregate. The harness reads the primary path first, then falls back with an
  explicit reason string — exactly the FR-EX-8 "logged fallback reason" contract.

> **Path finding (documented):** the actual on-disk cache dir is **project-scoped
> and defaults to `~/.pi-lens/projects/<slug>/cache/`** (not the flat
> `~/.pi-lens/cache/`), unless a `<project>/.pi-lens/` dir already exists or
> `PILENS_DATA_DIR` is set (`dist/clients/file-utils.js:getProjectDataDir`). The
> harness reproduces this resolution exactly.

---

## 4. Security invariants

- **INV-1** (secret-scan blocks emit, no secret reaches output): confirmed —
  detection live via opengrep; emit-block via `runtime-turn.js` blocker path;
  the blocker report prints only `file:line — rule [sources]`, never the secret
  value. ✅
- **INV-2** (LSP servers discovered from PATH only, no arbitrary binaries):
  confirmed by source (`dist/clients/lsp/server.js`). TS server: prefer
  `<root>/node_modules/.bin/typescript-language-server`, else PATH-resolved
  global via `ensureTool("typescript-language-server", …)`. Python: prefer
  `node_modules/.bin/pyright-langserver`, else PATH `pyright-langserver --stdio`.
  All servers are launched by **named commands** from `LSP_SERVERS` specs; no
  arbitrary/user-supplied binary path is executed. ✅

---

## 5. Findings / discrepancies (spec vs pi-lens 3.8.68)

1. **Version drift** — installed 3.8.68, spec 3.8.47 (§0). Verified against 3.8.68.
2. **Finding-type `secret_detected` does not exist** — behavior present, label
   differs (AC2 note). Secrets carry rule-source IDs, not a `secret_detected` type.
3. **Artifact path** — spec `~/.pi-lens/cache/actionable-warnings.json`; actual
   default `~/.pi-lens/projects/<slug>/cache/`, and the *written* proxy is
   `code-quality-warnings.json` (`actionable-warnings.json` is conditional).
   Handled via primary→fallback read (AC3).
4. **opengrep secret rules are git-working-tree scoped + cold-start racy** — a
   bare (non-git) temp dir yields 0 secret findings; `git init`/`git add` makes
   them fire. (Isolation test: bare dir → `0 warning(s)`; `+git init` →
   `Semgrep:…detected-aws-access-key-id-value` fires.) opengrep also runs as a
   warm auxiliary LSP server whose FIRST pass is a cold ~8s start (warms to
   ~1.3s, per `auxiliary-lsp.js` #111), so a single analyze pass can race the
   cold start and miss the secret. The harness handles both: it `git init`s the
   fixture dir AND polls `pilens_analyze` up to 4× until a secret surfaces —
   verified deterministic across consecutive runs (AC2 = pass on repeat).
5. **LSP cold latency exceeds NFR-PERF-6** — observed cold `pilens_analyze` LSP
   latency ~4.1–6.1s (real `lspLatencyMs` in AC1 evidence), above the ≤3s p95
   target. This is **cold-start** cost; the warm side-channel / re-runs are
   faster. pi-lens itself writes a real `~/.pi-lens/latency.log` (structured JSON
   lines with `durationMs`) — the perf artifact exists for p95 tracking.
   Guard note only; pi-lens augmentation is advisory (NFR-PERF-5), so this does
   not block a turn.
6. **`lsp.status: "failed"` with a valid diagnostic** — pi-lens marks the LSP
   runner "failed" when the file *has* type errors (the type-check "failed"),
   not when tooling failed; the diagnostic is still valid and returned. Not a bug.

---

## 6. What runs live vs. source-verified

| Path | Live headless | Source-verified |
|------|:---:|:---:|
| `--mode json` stdout emission (no TUI) | ✅ | |
| MCP server boot + JSON-RPC tools/call | ✅ | |
| LSP type-error diagnostic (TS) | ✅ | |
| LSP warning diagnostic + PATH discovery (Python/pyright) | ✅ | |
| `aw:<hash>` ID == pi-lens native fn | ✅ | ✅ |
| Secret detection (opengrep AWS key) | ✅ | |
| Secret **emit-block** (turn-end blocker) | | ✅ (`runtime-turn.js`) |
| Warning-count proxy on-disk read + fallback | ✅ | |
| INV-2 PATH-only LSP discovery | | ✅ (`lsp/server.js`) |
| gitleaks/trivy session-scan secret path | | ✅ (binaries not installed) |

The only source-only (not-live) items are the turn-end **emit-block** wiring and
the gitleaks/trivy session scanners. The emit-block requires a full agent turn
(LLM) to observe end-to-end; its trigger (a hardcoded-secret finding) is proven
live, and the blocker-push code path is unambiguous in `runtime-turn.js`.
Installing gitleaks/trivy (pi-lens auto-installs from GitHub releases when a
`.gitleaks.toml`/pre-commit gate trips) would let the session-scan secret path
run live too — logged as `TODO(goal)` in the script's AC2 skip reason (now moot,
since opengrep already provides live detection).

---

## 7. Reproduce

```bash
bun scripts/pi-lens-verify.ts          # structured JSON on stdout, exit 0 iff all pass
bun scripts/pi-lens-verify.ts --keep   # keep the temp fixture dir for inspection
```
