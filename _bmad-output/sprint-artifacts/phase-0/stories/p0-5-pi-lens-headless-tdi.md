# P0.5: Headless pi-lens TDI/warning source wired to the QA gate

**Story Points:** 4

## Spec Reference

- PRD §6.4 (Execution — pi-lens), §9.3 (Headless-TDI dependency & logged fallback); FR-EX-5, FR-EX-8
- Phase exit gate: PRD §13 Phase-0 clause 4 — "pi-lens runs headless and EITHER emits a turn-end report with TDI + stable finding IDs, OR the logged warning-count proxy fallback is recorded with the §9.3 fallback flag set."
- Answers OQ-2 (headless pi-lens TDI) with a recorded verdict in the §12 decision log.

## User Story

As the QA-gate lead,
I want a machine-readable TDI/warning signal from headless pi-lens (real numeric TDI or the logged warning-count proxy) wired into the node QA gate,
so that the L1/L4/L5 yield curve has a real, non-silent quality source (G3 accountability / G4 self-improvement).

## Overview

Cuts through Pi-team execution → pi-lens QA surface → DAG node output. pi-lens v3.8.47 emits machine-readable JSON via `pi lens --mode json --target <path>` / `pi lens --mode rpc --target <target>` (confirmed, OQ-2), but **TDI is a TUI slash-command (`/lens-tdi`), not a headless flag** (R4). So the slice proves which of two headless sources is real and wires exactly one into the gate: (a) read on-disk `$PI_LENS_HOME` (default `~/.pi-lens/`) history/review artifacts for a numeric TDI, or (b) the §9.3 fallback — pi-lens warning count via `pi lens --mode rpc --target <target>` as a labelled proxy with the fallback flag set. Either way the gate gets a stable-ID warning/finding stream. One atomic 4pt unit because install + headless run + verdict + wiring + fallback-flag are not demonstrable separately.

## E2E Slice

**Demonstrable behavior:** After `pi install npm:pi-lens` (v3.8.47), a headless probe runs `pi lens --mode json --target <noop-path>` then `pi lens --mode rpc --target <noop-path>` against the noop target (a temp directory containing one empty `_noop.ts` file — see fixture `test/fixtures/_noop.ts`). The QA-gate adapter `qa-gate.ts:resolveTdiSignal()` returns a single JSON object `{ source: "tdi_artifact" | "warning_proxy", tdi: number|null, warningCount: number, findings: [{id,severity}], fallbackInEffect: boolean }` — `findings[].id` stable across re-runs of the same target. If no numeric TDI is obtainable headless, `source="warning_proxy"`, `fallbackInEffect=true`, and the §9.3 flag is persisted.

**Wiring closed:** On completion of this story, running `qa-gate.ts:resolveTdiSignal()` against the noop produces the machine-readable signal object above (real TDI or labelled proxy, with `fallbackInEffect` and the OQ-2 verdict recorded) using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone (`pi lens --mode json --target` / `pi lens --mode rpc --target` proven in the Phase-0 spike are reference, not a code dependency).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break — AC-1a: signal completeness)** Given pi-lens v3.8.47 installed and the noop target (a temp directory containing one empty `_noop.ts` file — fixture `test/fixtures/_noop.ts`), When `resolveTdiSignal()` runs the headless probe (`pi lens --mode json --target <noop-path>` then `pi lens --mode rpc --target <noop-path>`), Then it returns a JSON object whose `warningCount` is a non-negative integer AND exactly one of `{tdi is a number, fallbackInEffect===true}` holds (never both null, never silent).
2. **(AC-1b: stable finding IDs)** Given the same noop target, When `resolveTdiSignal()` runs twice consecutively, Then `findings[].id` values are byte-identical across both runs.
3. Given a numeric TDI is readable from a `$PI_LENS_HOME` (default `~/.pi-lens/`) artifact, When the probe resolves, Then `source==="tdi_artifact"`, `tdi` is a number, `fallbackInEffect===false`, and no §9.3 flag is set.
4. Given headless TDI is unobtainable (TUI-only), When the probe resolves, Then `source==="warning_proxy"`, `tdi===null`, `fallbackInEffect===true`, the §9.3 fallback flag is persisted, and the OQ-2 verdict row is written — the signal is never dropped silently (guard fires, no silent continue).

**Precedence rule (artifact vs. probe):** When the `$PI_LENS_HOME` artifact is present and readable (even with `tdi===0`), `source==="tdi_artifact"` regardless of the RPC probe exit code. RPC non-zero alone never overrides a valid artifact. Only an absent or unreadable artifact triggers the proxy path (AC-4). This ensures a deterministic, non-contradictory resolution: the artifact path is always preferred when available.

## Technical Notes

- **Function signature:** `resolveTdiSignal(): TdiSignal` where `TdiSignal = z.infer<typeof tdiSignalSchema>`.
- **Contracts/Schema:** Zod `tdiSignalSchema` = `{ source: z.enum(["tdi_artifact","warning_proxy"]), tdi: z.number().nullable(), warningCount: z.number().int().nonnegative(), findings: z.array(z.object({ id: z.string().min(1), severity: z.enum(["info","warn","error"]) })), fallbackInEffect: z.boolean() }`. JSON decision record `oq2-verdict.json` = `{ oq: "OQ-2", verdict: "tdi_headless"|"proxy_fallback", decidedAt: ISO8601, probe: { jsonExit, rpcExit }, fallbackInEffect: boolean }`.
- **Integration points (each wired & exercised in this story):** `pi install npm:pi-lens` install step; headless probe spawns `pi lens --mode json --target <path>` / `pi lens --mode rpc --target <target>` (non-interactive, no TUI per R4); artifact read of `$PI_LENS_HOME` (default `~/.pi-lens/`) history/review JSON — artifact path: `$PI_LENS_HOME/cache/actionable-warnings.json` (pi-lens writes at `turn_end` with `aw:<hash>` IDs; TDI is adapter-computed from findings via the weighted formula `tdi = (info × 1) + (warn × 5) + (error × 20)` — see Guards/limits for full specification); `pi lens --mode rpc --target <target>` warning-count parse for the proxy path; the §9.3 `fallbackInEffect` flag persisted alongside the QA-gate config and read by the node emit path.
- **Exit code semantics:** `pi lens --mode rpc` non-zero exit → probe failure, `fallbackInEffect=true`, `warningCount=0`. Zero exit with empty JSON → proxy path with `warningCount=0` (legitimate "no warnings" result).
- **Severity mapping:** pi-lens v3.8.47 uses `advisory|warning|error` in RPC output. The adapter maps `advisory→info`, `warning→warn`, `error→error`. Verified at dev time.
- **Files / functions touched:** `qa-gate.ts:resolveTdiSignal`, `pi-lens-probe.ts:runHeadlessProbe`/`readPiLensArtifact`/`countRpcWarnings`.
- **Guards/limits:** `PI_LENS_HOME` env var (default: `~/.pi-lens/`) — Docker containers MUST set this explicitly to a writable path. Probe spawn carries a wall-clock cap of `PROBE_TIMEOUT_MS` env var (default: `30000` ms); on probe non-zero exit or timeout the resolver returns `source="warning_proxy", fallbackInEffect=true` (fail-toward-proxy, never throw-and-skip the gate). Gate failure threshold: `QDS_TDI_WARN_THRESHOLD` env var (default: 10). When `warningCount >= QDS_TDI_WARN_THRESHOLD && source === "warning_proxy"`, the QA gate refuses emit. TDI-artifact path (`tdi:number`) bypasses this threshold — only the proxy path is gated. Probe spawn: single retry with 2s backoff on non-zero exit. Two consecutive failures → `fallbackInEffect=true`.
- **TDI aggregation:** The `tdi` value on the artifact path is computed by the adapter from `$PI_LENS_HOME/cache/actionable-warnings.json` using the formula `tdi = (info × 1) + (warn × 5) + (error × 20)`, where `info`/`warn`/`error` are counts of findings at each severity level in the artifact. This is an adapter-computed field — pi-lens does not emit TDI as a standalone numeric value; the adapter reads the pre-computed findings array from the artifact and applies the weighted sum. On the proxy path (`source="warning_proxy"`), `tdi` is `null` and `warningCount` is used instead.
- **Probe sequencing:** Both probes (`pi lens --mode json --target <path>` and `pi lens --mode rpc --target <target>`) always run sequentially (JSON first, then RPC). The artifact TDI is checked only after both probes complete. This ordering ensures the RPC proxy path is always available as a fallback if the artifact path yields no TDI.
- **`fallbackInEffect` persistence:** The `fallbackInEffect` boolean is persisted as a top-level field within the existing `data/oq2-verdict.json` file (i.e., `oq2-verdict.json` gains `"fallbackInEffect": true|false` alongside its existing fields). No separate config file is introduced. The QA-gate node-emit path reads this field directly from the verdict file.
- **`tdi===0` on artifact path:** When the artifact path yields zero warnings, `tdi: 0` is a legitimate signal (no quality issues detected), NOT a fallthrough to the proxy path. The resolver returns `{ source: "tdi_artifact", tdi: 0, fallbackInEffect: false }`. Only an absent or unreadable artifact triggers the proxy fallback.

## Files to Modify

> ≤10 unique paths.

- `qds-factory/src/qa/pi-lens-probe.ts`
- `qds-factory/src/qa/qa-gate.ts`
- `qds-factory/src/qa/schemas/tdi-signal.schema.ts`
- `qds-factory/data/oq2-verdict.json`
- `qds-factory/scripts/install-pi-lens.sh`
- `qds-factory/test/fixtures/_noop.ts`
- `qds-factory/test/qa/pi-lens-probe.test.ts`
- `qds-factory/test/fixtures/mock-actionable-warnings.json`
- `qds-factory/test/qa/qa-gate.e2e.test.ts`

## Security Invariants

> input/file triggers: pi-lens secret-scan surface + parsing untrusted `$PI_LENS_HOME` JSON artifacts.

- **INV-1 (no secret leak):** pi-lens reviews MAY surface secret-adjacent findings; the resolver surfaces only finding IDs + severities + counts — no secret values, file content, or scanned source lines are exposed in `findings[]`, stdout, logs, or any persisted artifact (NFR-SEC-3).
- **INV-2 (safe artifact parse):** `$PI_LENS_HOME` artifacts are read read-only and parsed via `JSON.parse` inside a try/catch; a malformed/oversized/absent artifact yields the proxy path (`fallbackInEffect=true`), never an unhandled exception, partial object, or arbitrary code execution.
- **INV-3 (non-silent fallback):** the warning/TDI signal can never be silently empty — every resolve sets exactly one of `tdi:number` or `fallbackInEffect:true`; a dropped signal is impossible by construction (schema-validated before return), so the gate cannot pass on a missing quality signal.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `install-pi-lens.sh` installs/pins pi-lens v3.8.47 (`pi install npm:pi-lens`) and verifies the registry entry.
- [ ] **Impl:** Script verifies version via `pi list` output matching `pi-lens@3.8.47`; exits non-zero on mismatch.
- [ ] **Impl:** `runHeadlessProbe` executes `pi lens --mode json --target <noop-path>` then `pi lens --mode rpc --target <noop-path>` against the noop target (temp dir with one empty `_noop.ts`) and captures exit codes + JSON output.
- [ ] **Impl:** `resolveTdiSignal` prefers a `$PI_LENS_HOME` artifact TDI, else computes the `pi lens --mode rpc --target <target>` warning-count proxy and sets `fallbackInEffect`.
- [ ] **Contract:** `tdiSignalSchema` (Zod) added with field-level validation; resolver output validated against it before return.
- [ ] **Integration:** the resolved signal is wired into the QA gate's node-emit path and the §9.3 `fallbackInEffect` flag is read there (not just produced).
- [ ] **Observability:** `data/oq2-verdict.json` records the OQ-2 verdict (`tdi_headless`/`proxy_fallback`), probe exit codes, decision date, and fallback flag.
- [ ] **Security:** INV-1 enforced — assert no secret value/source line appears in `findings`, logs, or the verdict record (NFR-SEC-3).
- [ ] **Security:** INV-2 enforced — malformed/absent `$PI_LENS_HOME` artifact resolves to the proxy path without throwing.
- [ ] **Test (unit/integration):** covers both branches (artifact-TDI present → `tdi_artifact`; artifact absent → `warning_proxy`) plus the timeout guard path. AC-3 (artifact path with zero warnings → `source==="tdi_artifact"`, `tdi===0`) tested via synthetic artifact fixture `test/fixtures/mock-actionable-warnings.json` containing an empty findings array.
- [ ] **Test (e2e demo — MANDATORY):** runs `resolveTdiSignal()` against the noop target (temp dir with `_noop.ts`); asserts AC-1a (exactly one of `{tdi:number, fallbackInEffect:true}` holds) and AC-1b (stable `findings[].id` across two runs) — proves wiring closed.
- [ ] **Config:** `PROBE_TIMEOUT_MS` env var (default: `30000`) enforced in `runHeadlessProbe` — probe subprocess killed on timeout, resolver falls to proxy path.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
