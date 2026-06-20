# P2.0: Toolchain Bootstrap

**Story Points:** 3

## Spec Reference

- QDS-MEM-003-IMPL §D.1 (vendored source map); §A (provenance), §A.4 (license)
- Epic entry gate: QDS-MEM-003-IMPL §0 / §D.5 (P2.0 needs P0.7)

## User Story

As a QDS platform engineer,
I want the pi-mem operational-memory substrate vendored, license-attributed, and pinned to an exact dual-runtime dependency set,
so that every downstream Phase-2 store/capture story builds on a reviewed, network-free, version-locked foundation (G2 — supply-chain integrity).

## Overview

This story establishes the Track-A vendor decision: it clones the ArtemisAI/pi-mem repository (remote, GitHub-only) into the QDS tree, using the local claude-mem v10.5.2 checkout at `/Users/steve/QDS-Factory-Old/claude-mem/` as the code-shape reference. It pins the dependency set to EXACT resolved versions (no `^`/`~`/`latest` anywhere) — `sqlite-vec` `0.1.9`, `@huggingface/transformers` `3.8.1`, `better-sqlite3` `12.6.2`, and `cron-lib` (`croner`, exact) — wires Bun/Node dual-runtime resolution, and authors `THIRD_PARTY_NOTICES.md` recording the full lineage. `onnxruntime` (onnxruntime-node/onnxruntime-web) is a TRANSITIVE dependency of transformers.js and is therefore NOT pinned separately; pinning `@huggingface/transformers` `3.8.1` plus the committed lockfile fixes the ONNX runtime transitively. The net-new artifacts are the provenance/notices file, the pinned `package.json` + committed lockfile, the vendored `vendor/pi-mem/**` tree, and the local ONNX model directory; no application logic ships here. Wiring closes with no stub/TODO: the tree compiles under both runtimes and the STRIP list (§D.2) is verifiably absent. The capability-named glue is the `vendor:verify` gate that asserts the per-event LLM path never entered the tree.

## E2E Slice

**Demonstrable behavior:** Run `bun run vendor:verify` (and `node` equivalent): the script reads each of the four pinned deps `{sqlite-vec, @huggingface/transformers, better-sqlite3, cron-lib}` from the committed lockfile and asserts the exact strings (`0.1.9`, `3.8.1`, `12.6.2`, croner-exact) with zero `^`/`~`/`latest`; loads the sqlite-vec extension and `select vec_version()` returns under both runtimes (Bun: `db.loadExtension(require('sqlite-vec').getLoadablePath())` on `bun:sqlite`; Node: `sqliteVec.load(db)` on `better-sqlite3`); confirms the local ONNX model directory is present; and a grep gate asserts the import specifier `@anthropic-ai/claude-agent-sdk`, the `query(` call-shape, `SDKAgent.ts`, the Chroma sync modules, IDE adapters, and transcript watcher are NOT in the vendored tree — printing `VENDOR OK`.

**Wiring closed:** On completion, the pi-mem substrate is vendored, attributed, and dual-runtime-pinned, and the STRIP list is provably excluded — using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real.

**Dependency edges (predecessors):** P0.7 (epic entry gate — SwarmClaw MCP bridge must exist before the Phase-2 substrate lands).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given the vendored substrate after import, When `vendor:verify` greps the vendored `vendor/pi-mem/` tree for the import specifier `@anthropic-ai/claude-agent-sdk` and the `query(` call-shape, plus the §D.2 STRIP paths (`worker/SDKAgent.ts`, `GeminiAgent`/`OpenRouterAgent`, `sdk/prompts.ts`, `sync/ChromaSync.ts`, `sync/ChromaMcpManager.ts`, `strategies/ChromaSearchStrategy.ts`, `cli/adapters/*`, `services/transcripts/*`) and the 5 SDKAgent caller files (`worker/ProcessRegistry.ts`, `worker/SessionManager.ts`, `worker/agents/ResponseProcessor.ts`, `worker/agents/ObservationBroadcaster.ts`, `worker/http/routes/SessionRoutes.ts`), Then zero matches are found and the script exits 0 — any single match (specifier, call-shape, path, or caller) exits non-zero and fails the gate.
2. Given the pinned `package.json` and committed lockfile, When dependencies are installed and `vendor:verify` reads the RESOLVED version strings from the lockfile, Then `sqlite-vec===0.1.9`, `@huggingface/transformers===3.8.1`, `better-sqlite3===12.6.2`, and `cron-lib` (croner) equals its exact pinned string — each asserted as an exact literal with zero `^`/`~`/`latest` floating ranges, and `onnxruntime` is present transitively (via transformers.js, NOT a top-level pin).
3. Given the sqlite-vec native extension, When it is loaded under Bun (`bun:sqlite`) and again under Node (`better-sqlite3` `12.6.2`), Then `select vec_version()` returns a non-null version string under both runtimes — this AC is BINDING (dual-runtime load is a gate condition, not a SPIKE-11 advisory): failure under either runtime fails the story.
4. Given the vendor import, When `THIRD_PARTY_NOTICES.md` is read, Then it records ArtemisAI/pi-mem lineage, claude-mem v10.5.2 ancestry, the import date, every vendored source file retains its original per-file license header, AND the recorded license type is asserted to be on the permissive allowlist `{MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0}` — a license outside the allowlist fails the gate (not merely "recorded").
5. Given a developer attempts to add a floating dependency range, re-introduce a STRIP-listed file, or vendor a non-allowlisted license, When `vendor:verify` runs in CI, Then the gate fails with a named diagnostic identifying the offending path, range, or license (regression guard against silent supply-chain drift).

## Technical Notes

- **Contracts/Schema:** No runtime schema (vendor story). The verification contract is the `vendor:verify` gate output:
  ```typescript
  // shape asserted by vendor:verify
  type VendorVerifyResult = {
    runtime: 'bun' | 'node';
    vecVersion: string | null;          // from select vec_version()
    onnxModelPath: string;              // pinned local dir, must exist
    pinnedDeps: Record<string, string>; // name -> exact resolved version (from lockfile)
    licenseViolations: string[];        // non-allowlisted licenses; MUST be []
    stripViolations: string[];          // STRIP paths/specifier/callers; MUST be []
  };
  ```
- **Pinned set (exact, from lockfile):** `{ "sqlite-vec": "0.1.9", "@huggingface/transformers": "3.8.1", "better-sqlite3": "12.6.2", "croner": "10.0.1" }`. `onnxruntime` (onnxruntime-node / onnxruntime-web) is transitive of `@huggingface/transformers` — fixed by the lockfile, not separately pinned.
- **Extension-load path per runtime:** Bun (`bun:sqlite`) loads via `new Database(...); db.loadExtension(require('sqlite-vec').getLoadablePath())`; Node loads via `better-sqlite3` + `require('sqlite-vec').load(db)`. The sqlite-vec native binary is platform-specific (`sqlite-vec-darwin-arm64` / `-linux-x64` etc., resolved as optional deps by the lockfile) — note the dev (darwin-arm64) vs CI/image (linux-x64) platform split in `THIRD_PARTY_NOTICES.md`.
- **cron-lib pin rationale:** pin `croner` NOW (single-source the choice for P2.7/P2.11 so both cron stories build on one pinned, Bun-verified library) rather than deferring to P2.7 — avoids two stories independently choosing/pinning a cron lib.
- **Created artifacts:** the vendored `vendor/pi-mem/**` tree and the local ONNX model directory (`models/Xenova/all-MiniLM-L6-v2/`, ~23MB, committed/vendored — not fetched) are net-new artifacts of this story.
- **Integration points (each wired & exercised in this story):**
  - ArtemisAI/pi-mem (remote clone) — vendored into repo; local `/Users/steve/QDS-Factory-Old/claude-mem/` = shape reference only.
  - pi-mono ExtensionAPI seam `/Users/steve/QDS-Factory-Old/pi-mono/packages/coding-agent/src/core/extensions/types.ts` — present in tree for P2.3/P2.5/P2.6 (not wired here).
  - swarmclaw `/Users/steve/swarmclaw/src/lib/server/embeddings.ts` + `memory/memory-db.ts` — working local sqlite+ONNX+FTS5 template that informs the pin set (Xenova/all-MiniLM-L6-v2, 384-dim, fp32).
- **Files / functions touched:** `package.json` (exact pins, dual-runtime engines), `THIRD_PARTY_NOTICES.md` (lineage + license + import date + platform-binary note), `scripts/vendor-verify.ts` (the gate), `vendor/pi-mem/**` (imported substrate with headers).
- **Guards/limits:** pinned exact versions only (no floating ranges); STRIP list (§D.2) MUST NOT be vendored — especially `SDKAgent.ts` (the per-event `@anthropic-ai/claude-agent-sdk` `query()` call) and its 5 callers (`worker/ProcessRegistry.ts`, `worker/SessionManager.ts`, `worker/agents/ResponseProcessor.ts`, `worker/agents/ObservationBroadcaster.ts`, `worker/http/routes/SessionRoutes.ts`); vendored code reviewed before merge; license restricted to permissive allowlist `{MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0}`; ONNX model (~23MB) vendored into repo/image, not fetched.

## Files to Modify

> ≤10 unique paths, one per line.
- `package.json`
- `THIRD_PARTY_NOTICES.md`
- `scripts/vendor-verify.ts`
- `vendor/pi-mem/README.md`
- `tests/vendor/vendor-verify.test.ts`
- `tests/vendor/strip-list-absent.test.ts`

## Security Invariants

> Concrete named invariants only — N/A NOT permitted when triggered.

- **INV-OM1:** Zero per-event LLM/HTTP — enforced negatively at the vendor boundary: the import specifier `@anthropic-ai/claude-agent-sdk` + `query(` call-shape, `worker/SDKAgent.ts` (+ GeminiAgent/OpenRouterAgent, sdk/prompts.ts), and its 5 callers (`worker/ProcessRegistry.ts`, `worker/SessionManager.ts`, `worker/agents/ResponseProcessor.ts`, `worker/agents/ObservationBroadcaster.ts`, `worker/http/routes/SessionRoutes.ts`) MUST NOT enter the tree; their absence is what makes per-event LLM egress impossible downstream.
- **INV-VEND1:** All external dependencies are pinned to exact versions with a committed lockfile — no floating `^`/`~`/`latest` ranges reach the build; the four pinned strings are `sqlite-vec 0.1.9`, `@huggingface/transformers 3.8.1`, `better-sqlite3 12.6.2`, `croner` (exact). `onnxruntime` is transitive of transformers.js, fixed by the lockfile.
- **INV-VEND2:** Vendored provenance is complete, license-permissive, and tamper-evident — `THIRD_PARTY_NOTICES.md` records lineage/license/import-date/platform-binary note, per-file license headers are retained, and every vendored license is on the permissive allowlist `{MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0}`; no un-attributed or non-allowlisted third-party source merges.

## Definition of Done

> 8–12 high-signal, story-specific boxes. NO project-wide CI filler.

- [ ] **Gate (P0.7):** epic-entry gate P0.7 (SwarmClaw MCP bridge) confirmed satisfied at the process level before this story merges — recorded in `THIRD_PARTY_NOTICES.md` / story preconditions.
- [ ] **Impl:** ArtemisAI/pi-mem vendored into `vendor/pi-mem/**` (created artifact); claude-mem v10.5.2 used as shape reference only; per-file license headers retained.
- [ ] **Impl:** `package.json` pins the exact set `sqlite-vec 0.1.9`, `@huggingface/transformers 3.8.1`, `better-sqlite3 12.6.2`, `croner` (exact) — no `^`/`~`/`latest`; `onnxruntime` noted as transitive (not separately pinned); Bun + Node engines declared; lockfile committed.
- [ ] **Impl:** local ONNX model directory `models/Xenova/all-MiniLM-L6-v2/` (~23MB) vendored as a created artifact (not fetched).
- [ ] **Impl:** `THIRD_PARTY_NOTICES.md` records ArtemisAI/pi-mem lineage, claude-mem v10.5.2 ancestry, license type, import date, and the platform-binary note (darwin-arm64 dev vs linux-x64 CI).
- [ ] **Contract:** `vendor:verify` emits a `VendorVerifyResult` with `stripViolations: []`, `licenseViolations: []`, exact `pinnedDeps` strings, and non-null `vecVersion` per runtime.
- [ ] **Integration:** sqlite-vec extension loads via the per-runtime path (Bun `getLoadablePath()` on `bun:sqlite`; Node `sqlite-vec.load(db)` on `better-sqlite3`) and `select vec_version()` returns under BOTH (binding); pinned local ONNX model directory present.
- [ ] **Security:** INV-OM1 enforced — import specifier `@anthropic-ai/claude-agent-sdk` + `query(` call-shape, STRIP list (§D.2) incl. SDKAgent + its 5 callers, Chroma sync/strategy, IDE adapters, transcript watcher all absent; INV-VEND1 (exact pins) + INV-VEND2 (permissive-license allowlist) enforced.
- [ ] **Test (unit):** `strip-list-absent.test.ts` greps the vendored `vendor/pi-mem/` tree for the import specifier, the `query(` call-shape, each STRIP path, and the 5 caller files asserting zero matches; floating-range detector asserts no `^`/`~`/`latest`; license detector asserts every dep license ∈ allowlist.
- [ ] **Test (e2e demo — MANDATORY):** Run `bun run vendor:verify` then the Node equivalent → both print `VENDOR OK`, report identical exact pinned versions (`0.1.9`/`3.8.1`/`12.6.2`/croner-exact), return a non-null `vec_version()`, confirm the ONNX model path, and report `stripViolations: []` + `licenseViolations: []`.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
