# LSP Provision + Diagnostics/Navigation Verification Report — Story P0.6

**Story:** P0.6 — Provision Target-Repo LSP + Prove Active Diagnostics/Navigation
**Date:** 2026-07-24
**Host:** darwin arm64, `pi` 0.81.1, node v24.15.0, bun 1.3.13
**Verification script:** `scripts/lsp-verify.ts` (run: `bun scripts/lsp-verify.ts`, or `npm run verify:lsp`)
**Unit tests:** `tests/lsp-verify.test.ts` (36 unit tests + 1 skippable live integration test, no pi-lens required)

All output below is **real captured output** from a live run on this host
(exit 0). Trimmed JSON is labeled **excerpt** — shortened for readability, never
fabricated. This report mirrors the honesty discipline P0.5 established in
`pi-lens-verification-report.md`: every claim is tagged *observed* vs *derived*,
and where a check's contract is narrower than the AC as literally worded, the
story-level status is recorded as **partial** rather than silently redefined as
satisfied.

---

## 0. Provisioning + version resolution

| Item | Value |
|------|-------|
| Story floor | pi-lens ≥ `3.8.69` |
| **Installed / resolved version** | **`3.8.71`** (`belowVersionFloor: false`) |
| Resolution source | `PI_LENS_ROOT` (harness reports `piLensSource`) |
| `typescript-language-server` | `5.3.0`, auto-provisioned per-worktree by pi-lens |
| LSP servers spawned | `typescript`, `ast-grep`, `typos`, `opengrep` |

**Provisioning finding (differs from P0.5).** P0.5's report was produced on a
different host (`/Users/steve/...`) where pi-lens was a *global* install listed
in `~/.pi/agent/settings.json`. On **this** host pi-lens is **not** globally
installed and is **not** in that `packages` list. P0.6 therefore extends the
install resolution rather than assuming a global: `scripts/lsp-verify.ts`
resolves pi-lens from, in order, (1) `PI_LENS_ROOT`, (2) repo-local
`node_modules/pi-lens`, (3) P0.5's global probe (imported and reused, not
duplicated). The resolved source is recorded in every run's summary so the
provenance of a green run is auditable.

`typescript-language-server` is **not** on the host PATH; pi-lens auto-installs
and resolves it per-worktree (`sessionstart.log`: `auto-install ensure
typescript-language-server`). This satisfies the story's "warm per-worktree LSP
server" premise without a global toolchain mutation.

---

## 1. Result summary (real script output, excerpt)

```console
$ bun scripts/lsp-verify.ts
{
  "results": [ … 7 checks; see per-AC sections … ],
  "summary": {
    "piLensVersion": "3.8.71",
    "piLensSource": "PI_LENS_ROOT",
    "piLensVersionFloor": "3.8.69",
    "belowVersionFloor": false,
    "lspInitTimeoutS": 15,
    "warmP95BudgetMs": 3000,
    "strict": false,
    "pass": 7, "fail": 0, "skip": 0, "optionalSkip": 0,
    "notes": []
  }
}
# exit 0
```

**7 pass, 0 fail, 0 skip.**

**Exit-code semantics (as implemented):**

- exit **0** when there are no FAILs (default mode: skips allowed);
- exit **1** on any FAIL — including a mid-run probe failure, which is recorded
  as a synthetic failed check so the JSON summary still emits — or, under
  `--strict` / `CI`, on any skip of a **non-optional** check;
- exit **2** on a fatal error *before* checks start (e.g. pi-lens unresolvable).

---

## 2. Headless method

Two transports are exercised, deliberately:

1. **pi-lens MCP server over stdio JSON-RPC** (`dist/mcp/server.js`), driven by a
   minimal newline-framed client (`McpClient`) — the same engine the Pi agent's
   tools call, reached without an LLM. Tools used: `pilens_lsp_diagnostics`,
   `pilens_lsp_navigation`, `pilens_analyze`.
2. **A real Pi agent turn** under `pi -p --mode json --no-session -e <pi-lens>`
   — the story's MANDATORY e2e demo (§7 DoD). **This host has working LLM auth
   (provider `fifer-ai`), so unlike P0.5 the demo actually ran.**

**Tool-naming finding.** The AGENT-facing extension tools are named exactly as
the story words them — `lsp_diagnostics` and `lsp_navigation`. The `pilens_`
prefix (`pilens_lsp_diagnostics`, `pilens_lsp_navigation`) is the **MCP
server's** surface for the same engine. Both were observed live; the harness
records `agentToolNames` from the agent turn to prove it.

**State containment.** The MCP server is spawned with `PILENS_DATA_DIR` inside
the temp work dir, so all project-scoped pi-lens state dies with the work dir.
**Global exception**, inherited from P0.5: latency telemetry appends to
`~/.pi-lens/latency.log`, keyed on `PI_LENS_HOME` rather than `PILENS_DATA_DIR`;
the harness reads it as the story's named p95 source and leaves it in place.

---

## 3. AC → evidence map

### AC1 — diagnostics reflect the uncommitted edit, within the warm p95 budget — **PASS (check) / PARTIAL (story level: first-response freshness)**

Fixture: a committed-clean `app.ts`, then a genuine TS2322 written to disk and
**never committed** (`git status --porcelain` non-empty → `editUncommitted: true`).

**Stale-index negative control (the `baselineN → postEditN` requirement):**

```json
{
  "baselineN": 2,
  "postEditN": 3,
  "countChanged": true,
  "editUncommitted": true,
  "newDiagnostic": {
    "line": 3, "column": 7,
    "severity": "error", "tool": "lsp",
    "rule": "typescript:2322",
    "message": "Type 'number' is not assignable to type 'string'."
  }
}
```

The new error rule appears **and** the count changed — the diagnostic reflects
the uncommitted buffer, not a stale index.

**Latency (NFR-PERF-6), excerpt:**

```json
{
  "coldStartMs": 1682,
  "coldStartAdvisoryOnly": true,
  "coldStartExceedsBudget": false,
  "warmDefinition": "after the server's first non-empty diagnostic response",
  "warmSampleCount": 20,
  "warmSamplesReportingTheError": 20,
  "warmSamplesFreshlyAnalyzed": 20,
  "warmSamplesWithStaleFirstResponse": 9,
  "warmP95Ms": 427,
  "warmP95BudgetMs": 3000,
  "warmP95Met": true,
  "warmSamplesMs": [11,323,427,324,420,321,419,325,317,420,322,420,318,428,321,427,316,419,318,419],
  "latencyLogSampleCount": 2,
  "latencyLogP95Ms": 3545
}
```

**p95 = 427 ms against a 3 000 ms budget.** Cold start 1 682 ms, amortized once
per worktree session and advisory-only (NFR-PERF-5).

> **Sample-validity finding — and a real pi-lens behavior worth recording.**
> An earlier revision of this harness re-queried an *unchanged* file 20 times
> and measured a p95 of **24 ms**. That number was not trustworthy: it could not
> distinguish a live warm re-query from a cached replay. The harness now moves
> the type error to a **distinct line** each iteration and re-queries until the
> reported line matches, so each sample measures **time-to-fresh-result**.
>
> Doing so surfaced the behavior directly: **9 of 20 samples returned a STALE
> diagnostic — the previous revision's line — on the first query after an edit**,
> and needed a re-query to catch up.
>
> **The measured contract is therefore explicitly *time-to-fresh-result*, not
> first-response freshness**, and the two must not be conflated:
>
> | Property | Status |
> |---|---|
> | A settled `lsp_diagnostics` query reflects the uncommitted edit | **proven** (`baselineN → postEditN`, unambiguous) |
> | Time from edit until a query reflects it, p95 | **proven ≤ 3 s** (427 ms) |
> | A *single* `lsp_diagnostics` call immediately after an edit returns current diagnostics | **DISPROVEN** — 9/20 returned the prior revision |
>
> The retry-until-fresh loop is part of what this harness measures and is
> documented as such; callers that issue one query and trust it (e.g. a post-edit
> gate like P1.7) must implement the same re-query, or accept a stale read.
> AC1 is therefore recorded as story-level **partial**: its latency and
> stale-index halves are met, its implied first-response freshness is not.
>
> **Divergence from `~/.pi-lens/latency.log`, stated plainly.** The log yielded
> only **2** samples (p95 3 545 ms) for this run, against the story's "≥20 warm
> `durationMs` samples sourced from `~/.pi-lens/latency.log`". The log records
> pi-lens's internal `lsp` **runner** durations for `pilens_analyze` dispatches
> (cold/first passes), not the 20 warm `pilens_lsp_diagnostics` tool calls the
> harness makes. The p95 claim above therefore rests on **the harness's
> equivalent timing record** — the alternative the AC explicitly permits — and
> the log figure is reported alongside as a cross-check, not suppressed.

**Contract C1 — which surface yields the structured findings array:**
`structuredSurface: "pilens_analyze"`. This **confirms P0.5's caveat**:
`pilens_lsp_diagnostics` returns a human-readable line
(`L3:7: error[typescript] (2322): …`), while the structured `diagnostics[]`
array comes from `pilens_analyze`. The agent-facing `lsp_diagnostics` tool
additionally carries a structured `details` object (see §5).

| Field | Type | Example | Evidence status |
|-------|------|---------|-----------------|
| `line` / `column` | number (1-based in text render) | `3` / `7` | captured |
| `severity` | `error` \| `warning` \| `info` | `error` | captured |
| `tool` | source runner | `lsp` | captured |
| `rule` | `<server>:<code>` | `typescript:2322` | captured |
| `message` | string | `Type 'number' is not assignable…` | captured |
| stable `aw:<hash>` id | `aw:<10-hex>` | — | **not observed** (P0.5's aggregator code-action gate; not re-litigated here) |

### AC2 — go-to-definition resolves cross-file — **PASS**

Origin is the **import binding** on line 1 of `app.ts`. (Navigating from the
*usage* on line 3 resolves to the import binding inside `app.ts` — correct
TypeScript behavior, but only a same-file hop, so it would not exercise this AC.
That was a real defect in the harness's first revision, found and fixed.)

**Contract C2 — both wire shapes are present in one envelope:**

```json
{
  "resultCount": 1,
  "nativeResultSample": {
    "uri": "file:///…/lib.ts",
    "range": { "start": { "line": 0, "character": 16 }, "end": { "line": 0, "character": 19 } }
  },
  "normalizedSample": {
    "uri": "file:///…/lib.ts",
    "filePath": "/…/lib.ts",
    "range": { "start": { "line": 1, "character": 17 }, "end": { "line": 1, "character": 20 } },
    "external": false
  }
}
```

- `result` = **native LSP `Location[]`**, `{ uri, range }`, **0-indexed** —
  exactly the story's C2 contract.
- `locations` = pi-lens's presentation layer, `{ uri, filePath, range }`,
  **1-indexed** (`dist/tools/lsp-structured-output.js` adds +1).
- The off-by-one between them is **by design**, not a bug. The story's
  "native `Location[]`, 0-indexed" wording describes `result`; the earlier
  assumption that `locations` was the native shape was wrong and is corrected here.
- Navigation **input** is **1-based** (`operation`, `path`, `line`, `character`,
  `symbol`) — note `operation`, not the story's `action`.

### AC2b — external definition surfaces explicitly — **PASS**

`JSON.parse` resolves into TypeScript's bundled `lib.es5.d.ts`, outside the
worktree root:

```json
{
  "locationCount": 1,
  "coercedToEmpty": false,
  "locations": [{
    "uri": "file:///…/node_modules/typescript/lib/lib.es5.d.ts",
    "filePath": "/…/node_modules/typescript/lib/lib.es5.d.ts",
    "range": { "start": { "line": 1162, "character": 5 } },
    "external": true
  }]
}
```

Real out-of-worktree locations are returned — **never coerced to an empty
array**. `external: true` is a **harness-layer** URI-prefix check against the
worktree root, **not** a native LSP field and **not** emitted by pi-lens; the
evidence says so in `externalFlagProvenance`.

> **Symlink finding.** The check canonicalizes both sides through
> `fs.realpathSync` before comparing. On macOS `os.tmpdir()` yields
> `/var/folders/...` while the language server (and the Pi agent turn, §5)
> report the real `/private/var/folders/...` for the **same** file — a raw
> prefix compare mislabels every in-worktree definition as external. Observed
> live in the agent-turn evidence, not hypothetical.

### AC3 — graceful degradation for an unsupported language — **PASS (payload half asserted; artifact half NOT asserted)**

```json
{
  "noCrash": true,
  "payloadWarned": true,
  "responseExcerpt": "Primary LSP: confirmed clean.\n\nLSP unavailable for /…/fixture.zzlang: no LSP server configured; ready=0/0.. No diagnostics were collected.",
  "projectArtifactFiles": ["cache", "turn-state.json"],
  "artifactSignalObserved": false,
  "artifactFilesScanned": 2,
  "artifactAssertionStatus": "NOT asserted — pi-lens wrote no degradation signal into the project artifacts this run; only the payload half of AC3 is proven, and this check does not claim otherwise"
}
```

The **payload** half is a real assertion and gates the check. The **artifact**
half — AC3's "and appended to `~/.pi-lens/projects/<slug>/` artifacts … the
harness asserts both" — is **not met**: the harness recursively reads the
project artifacts and finds no degradation signal. An earlier revision reported
`artifactWarningObserved: true` computed as `artifactFiles.length > 0`, i.e.
merely "the directory is non-empty" — that overstated what was checked and was
corrected.

> **Path finding (confirms P0.5).** pi-lens's project data dir is
> **project-scoped** — `~/.pi-lens/projects/<slug>/` (contained here via
> `PILENS_DATA_DIR`), *not* the flat `~/.pi-lens/cache/` the spec names.

### AC3a — bounded `initialize`, `lsp_init_timeout`, graceful payload — **PASS (check) / PARTIAL (story level)**

```json
{
  "lspInitTimeoutS": 15,
  "timedOut": true,
  "elapsedMs": 15037,
  "logged": "lsp_init_timeout server=hang-server.cjs timeoutMs=15000 elapsedMs=15037",
  "gracefulPayload": { "degraded": true, "reason": "lsp_init_timeout", "warning": "…", "diagnostics": [] }
}
```

An accept-but-never-respond fixture server is driven through the **real
`McpClient`** — the same class and the same `rpc()` deadline every other check's
tool calls use. The deadline fires at 15 037 ms against a 15 000 ms budget and
yields a graceful payload; nothing hangs.

> **Story-level PARTIAL.** AC3a as worded says `lsp_diagnostics` runs and the
> harness times out. What is proven is the **harness invariant** — every RPC
> carries a deadline. pi-lens's **internal** LSP-client init timeout is *not*
> exercised: driving it would require pi-lens to adopt the hang-server as its
> configured language server, which its PATH-based `LSP_SERVERS` resolution
> does not expose. (An earlier revision raced a throwaway `setTimeout` that
> touched neither pi-lens *nor* `McpClient`; that was strictly weaker and was
> replaced.)

### AC4 — batch diagnostics, per-file keyed, partial on per-file failure — **PASS (check) / PARTIAL (story level)**

Request: `paths: [app.ts, lib.ts, does-not-exist.ts]`.

```json
{
  "filesChecked": 3,
  "perFileKeyed": true,
  "keyingProvenance": "DERIVED by the harness from the text surface",
  "healthyFileDiagnosticCount": 2,
  "missingFileEntry": { "diagnostics": [], "error": "path not found" },
  "partialNotAtomic": true
}
```

The healthy file returns its findings **while** the unreadable path reports its
own failure — PARTIAL, not atomic, exactly as the AC requires.

> **Surface finding.** In 3.8.71 the batch response is **human-readable text
> with no JSON envelope at all**. Per-file keying is therefore **derived by this
> harness** from that text (`parseBatchDiagnosticsText`), not read from a
> structured field — recorded in `keyingProvenance` rather than presented as
> observed structure. The parser is directly unit-tested (§6).
>
> **Story-level PARTIAL.** AC4 mandates **SEQUENTIAL** per-file
> `textDocument/diagnostic` RPCs. pi-lens instead exposes `paths` with a
> `concurrency` bound over **distinct server groups**, processing files that
> share one server one-at-a-time against it. The AC's **intent** — per-file
> keying with partial results — is met and proven live; the literal sequencing
> requirement is not the tool's contract. Recorded as a spec-vs-impl gap.

---

## 4. Security invariants

- **INV-1** (user-level permissions, worktree scope): ✅ All children are
  spawned with `spawn()` defaults — same OS user, no elevation. pi-lens resolves
  language servers by **named command** from its `LSP_SERVERS` specs
  (source-verified in `dist/clients/lsp/server.js`, consistent with P0.5's
  INV-2 finding); no arbitrary binary path is executed. The only harness-authored
  executable is `hang-server.cjs`, written to a fixed name inside the
  `mkdtemp` work dir with no untrusted input in its path.
- **INV-2** (no secret values in diagnostic payloads): ⚠️ **narrowed claim — no
  secrets observed in this fixture; secret-safety is NOT proven in general.**
  What is actually established: (a) the evidence artifact is emitted via
  `JSON.stringify`, which escapes control characters (including ESC), so a
  crafted path or message cannot inject ANSI escapes or break the JSON — this
  is an *injection* property, **not** a secrecy property; (b) the child's
  environment is not copied into any evidence field; (c) this run's fixture
  contains no credentials, so none appeared.
  What is **not** established: diagnostic messages and file paths are
  reproduced verbatim into the artifact, so a secret embedded in a path,
  identifier, or diagnostic message **would** be emitted. There is no redaction
  layer and no negative test for one. P0.5 further recorded that pi-lens's
  upstream secret emit-block is environment-gated (needs gitleaks/trivy in
  `sessionSecrets`) and was never observed firing. A harness run against a repo
  containing real secrets should be treated as capable of surfacing them.
- **State hygiene:** ✅ project-scoped pi-lens state is contained under
  `PILENS_DATA_DIR` inside the work dir and removed with it; all fixture
  creation now runs inside the cleanup `try` so a mid-setup throw cannot leak
  the temp dir. `McpClient.close()` escalates SIGTERM → SIGKILL after a 2 s
  grace period so a stalled server cannot outlive the run.

---

## 5. MANDATORY e2e demo (`--mode json` Pi agent turn) — **MET**

This is the item P0.5 recorded as **NOT met** (its host had no working LLM
auth). On this host it ran for real.

```json
{
  "command": "pi -p --mode json --no-session -e <pi-lens>/dist/index.js \"…\"",
  "handshakeObserved": true,
  "agentToolNames": ["pi_lens_activate_tools", "lsp_diagnostics", "lsp_navigation"],
  "errorReflected": true,
  "definitionResolved": true,
  "exitCode": 0
}
```

`lsp_diagnostics` tool result (excerpt) — note the structured `details` object,
i.e. the `tool_execution_end` contract path P0.5 could not reach:

```json
{
  "content": [{ "type": "text",
    "text": "Primary LSP (typescript): 1 diagnostic.\n\nL3:7: error[typescript] (2322): Type 'number' is not assignable to type 'string'.\n" }],
  "details": {
    "filePath": "/private/var/folders/…/app.ts",
    "primaryServerId": "typescript",
    "primaryDiagnosticsCount": 1,
    "diagnostics": [{ "line": 2, "character": 6, "severity": 1,
                      "message": "Type 'number' is not assignable to type 'string'.",
                      "source": "typescript", "code": 2322 }]
  }
}
```

`details.diagnostics[]` is **0-indexed** (`line: 2, character: 6` for the error
rendered as `L3:7`) — the native LSP convention, consistent with C2's `result`.

`lsp_navigation` (excerpt) resolved the definition to `lib.ts`:

```json
{ "tool": "lsp_navigation", "operation": "definition", "ok": true,
  "status": "success", "resultCount": 1,
  "result": [{ "uri": "file:///private/var/folders/…/lib.ts", "range": { … } }] }
```

Both halves of the story's e2e slice — diagnostics reflecting an uncommitted
type error, and navigation resolving a definition — are proven through a real
agent turn on the machine-readable `--mode json` stdout, no TUI.

> **This check is nondeterministic, and that is handled rather than hidden.**
> The agent's tool choice is sampled: observed failure modes across runs include
> stopping after `pi_lens_activate_tools` without invoking anything, and
> navigating from the *usage* on line 3 instead of the import on line 1. The
> harness therefore (a) pins the exact navigation arguments in the prompt, and
> (b) retries up to **3 attempts** before recording a deferral — one unlucky
> sample is not evidence the capability is absent. `attempts` is reported in the
> evidence so a retried pass is never presented as a first-try pass. When LLM
> auth is unavailable the check degrades to an OPTIONAL skip (a recorded
> deferral), never a red build — matching P0.5's treatment.
>
> **`definitionResolved` vs `definitionResolvedCrossFile`.** The demo requires
> that navigation *resolved a definition* — the tool succeeded and returned at
> least one location; an empty or errored navigation still fails. Whether the
> agent happened to pick the cross-FILE origin is recorded separately as
> `definitionResolvedCrossFile` and is **not** required here, because
> navigating from the usage has a correct TypeScript answer (the import binding
> in `app.ts`, a same-file hop). The cross-file hop is proven independently and
> deterministically by **AC2** over the MCP transport, where the harness — not
> the model — chooses the origin.

---

## 6. Test coverage

`tests/lsp-verify.test.ts` — **36 unit tests, 0 fail**, none requiring pi-lens:

| Target | Cases |
|---|---|
| `p95` (nearest-rank) | empty, single, 20-sample rank, order-independence, 1-vs-2 outliers |
| `compareVersions` | numeric-not-lexical (`3.8.9` < `3.8.69`), missing components, **pre-release ranks below release** |
| `flagExternal` | in-worktree, node_modules, outside-root, **sibling-prefix trap**, URI-derived path, unresolvable → external, field preservation, never-empty |
| `parseBatchDiagnosticsText` | real captured batch text, partial-not-atomic, **error reason containing `": "`**, section-header termination, clean case, empty input |
| `parseToolJsonText` | fenced block, bare envelope, human-readable line, bare array not coerced, malformed |
| `extractBatchByFile` | `filePath`/`path` keys, failing+healthy coexistence, non-batch input |

The live integration test skips (never fails) when no pi-lens resolves, so CI
without a provisioned install stays green.

---

## 7. DoD traceability

| # | DoD item | Status | Evidence |
|---|----------|--------|----------|
| 1 | Warm typescript-language-server provisioned; cold-start measured and amortized | **Met** | §0; `coldStartMs: 1682`, amortized once per worktree session, advisory-only |
| 2 | Verification script exercises `lsp_diagnostics` (uncommitted edit) + `lsp_navigation` (known symbols) | **Met** | §3 AC1, AC2, AC2b |
| 3 | **C1** `lsp_diagnostics` output schema documented + which surface yields the structured array | **Met** | §3 AC1 contract table; `structuredSurface: "pilens_analyze"`, confirming P0.5's caveat. Stable `aw:` id **not observed** (recorded, not faked) |
| 4 | **C2** `lsp_navigation` schema documented; native `Location[]` 0-indexed; `external:true` via URI-prefix check | **Met** | §3 AC2 — **both** shapes captured: native `result` 0-indexed, `locations` 1-indexed; provenance of `external` stated |
| 5 | Version: artifact records installed pi-lens version | **Met** | §0 — `3.8.71`, above the `3.8.69` floor; resolution source recorded |
| 6 | Integration: diagnostics reflect uncommitted edits; `baselineN → postEditN` control; navigation resolves cross-file | **Met** | §3 AC1 (`2 → 3`, `editUncommitted: true`), AC2 |
| 7 | Integration: graceful degradation for unsupported language (payload **and** artifacts) | **Partial** | §3 AC3 — payload half asserted; **artifact half NOT asserted** (no degradation signal written by pi-lens this run) |
| 8 | Test: ≤3 s p95 warm; navigation resolves; **every RPC has a deadline** | **Met** | §3 AC1 (p95 **427 ms**), AC2, AC3a |
| 9 | Test: strict-gating — exit 0 iff no FAIL; optional-skip distinguished; CI implies `--strict`; `--mode json` demo recorded deferred-or-met | **Met** | §1 exit semantics; §5 demo recorded **MET** |
| 10 | **MANDATORY e2e:** Pi agent `lsp_diagnostics` on uncommitted error + `lsp_navigation` definition; latency ≤3 s p95 warm | **Met** | §5 — real agent turn, both tools, `errorReflected` + `definitionResolved` |

**Net (DoD checkboxes): 9 met, 1 partial** — DoD 7, the artifact half of AC3.

**Net (story-level acceptance criteria): 2 fully met, 4 partial.** These two
counts measure different things and are reported separately rather than
averaged, because a probe passing its own contract is not the same as an AC
being satisfied as written:

| AC | Check verdict | Story-level | Gap |
|---|---|---|---|
| AC1 | pass | **partial** | time-to-fresh proven; single-call first-response freshness disproven (9/20 stale) |
| AC2 | pass | met | — |
| AC2b | pass | met | — |
| AC3 | pass | **partial** | payload half asserted; artifact half not written by pi-lens |
| AC3a | pass | **partial** | harness RPC deadline proven; pi-lens-internal LSP init timeout not exercised |
| AC4 | pass | **partial** | per-file keying + partial results proven; literal sequential-RPC wording is not the tool's contract |

---

## 8. Spec-vs-impl discrepancies (story wording vs pi-lens 3.8.71)

1. **`lsp_navigation` input** — story says `{ action, file, line, character }`;
   actual is `{ operation, path, line, character, symbol, … }`, **1-based**.
   `action` → `operation`, `file` → `path`.
2. **`lsp_diagnostics` input** — story says `{ file, dir?, batch? }`; actual is
   `{ path?, paths?, severity?, concurrency?, waitMs?, serverScope? }`.
   `batch` → `paths`.
3. **Batch is not literally sequential** — bounded concurrency across distinct
   server groups; same-server files are serialized against that server (AC4).
4. **Batch surface is text-only** — no JSON envelope; per-file keying is derived
   by the harness (AC4).
5. **`locations[]` is 1-indexed**, not the native 0-indexed wire shape; the
   native shape is available in parallel under `result` (AC2).
6. **Artifact path** — `~/.pi-lens/projects/<slug>/`, not the flat
   `~/.pi-lens/cache/` (confirms P0.5).
7. **Tool naming** — agent-facing `lsp_diagnostics` / `lsp_navigation` (as the
   story words them) vs MCP `pilens_`-prefixed names for the same engine.
8. **pi-lens is not globally installed on this host** — contrary to the story's
   "(installed)" note, which reflected P0.5's different machine (§0).

---

## 9. Known limitations

- **Stale first response after a rapid edit** — 9/20 warm samples (§3 AC1).
  Documented behavior, not a harness defect; the p95 figure measures
  time-to-fresh-result and already absorbs it.
- **`latency.log` yields far fewer samples than the AC's ≥20** (2 this run); the
  p95 rests on the harness's equivalent timing record, which the AC permits.
- **AC3 artifact half unproven** — pi-lens wrote no degradation signal to disk.
- **AC3a does not exercise pi-lens's internal LSP init timeout.**
- **AC2b is proven live for one external call site**; the general
  never-coerce-to-empty property is covered by unit tests.
- **Cold start is a single sample per run**; "amortized once per worktree
  session" is true by construction of a one-shot harness, not measured across
  two real sessions.
- **The mandatory agent e2e demo is LLM-sampled**, so it can require retries
  (up to 3) and its `definitionResolvedCrossFile` signal varies run to run. The
  deterministic proof of every underlying capability is the MCP-transport checks
  (AC1–AC4); the agent demo proves the capability is reachable through a real
  agent turn, not that a given turn is reproducible.

---

## 10. Reproduce

**Preconditions:** `bun`, `node`, `git` on PATH; pi-lens ≥ 3.8.69 resolvable via
`PI_LENS_ROOT`, repo-local `node_modules/pi-lens`, or a global install. `pi`
with working LLM auth for the §5 e2e demo (absent auth, that check records a
deferral instead of failing).

```bash
npm run verify:lsp                    # structured JSON on stdout
bun scripts/lsp-verify.ts --keep      # retain the temp work dir
bun scripts/lsp-verify.ts --strict    # non-optional skips fail the run (CI implies --strict)
bun test tests/lsp-verify.test.ts     # 36 unit tests, no pi-lens needed

LSP_INIT_TIMEOUT_S=15                 # bounded initialize deadline (validated; bad input → 15s + a note)
PI_LENS_ROOT=/path/to/pi-lens         # explicit install override
```

Runtime ≈ 55 s (LSP cold start, 20 freshness-gated warm samples, a 15 s
init-timeout probe, and one live agent turn).
