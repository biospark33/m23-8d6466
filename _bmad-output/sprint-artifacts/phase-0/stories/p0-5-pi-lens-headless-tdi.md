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

Cuts through Pi-team execution → pi-lens QA surface → DAG node output. pi-lens v3.8.47 emits machine-readable JSON in `--mode json`/`--mode rpc` (confirmed, OQ-2), but **TDI is a TUI slash-command (`/lens-tdi`), not a headless flag** (R4). So the slice proves which of two headless sources is real and wires exactly one into the gate: (a) read on-disk `~/.pi-lens/` history/review artifacts for a numeric TDI, or (b) the §9.3 fallback — pi-lens warning count via `--mode rpc` as a labelled proxy with the fallback flag set. Either way the gate gets a stable-ID warning/finding stream. One atomic 4pt unit because install + headless run + verdict + wiring + fallback-flag are not demonstrable separately.

## E2E Slice

**Demonstrable behavior:** After `pi install npm:pi-lens` (v3.8.47), a headless probe runs `--mode json` then `--mode rpc` against a noop target. The QA-gate adapter `qa-gate.ts:resolveTdiSignal()` returns a single JSON object `{ source: "tdi_artifact" | "warning_proxy", tdi: number|null, warningCount: number, findings: [{id,severity}], fallbackInEffect: boolean }` — `findings[].id` stable across re-runs of the same target. If no numeric TDI is obtainable headless, `source="warning_proxy"`, `fallbackInEffect=true`, and the §9.3 flag is persisted.

**Wiring closed:** On completion of this story, running `qa-gate.ts:resolveTdiSignal()` against the noop produces the machine-readable signal object above (real TDI or labelled proxy, with `fallbackInEffect` and the OQ-2 verdict recorded) using only code merged by this story. No stub, no `TODO: wire later`, and no sibling story is required to make this behavior real. Predecessors, if any, are dependency edges (listed below), not unfinished wiring inside this story.

**Dependency edges (predecessors):** None — standalone (pi-lens v3.8.47 + `--mode json`/`rpc` proven in the Phase-0 spike are reference, not a code dependency).

## Acceptance Criteria

> ≥3 scenarios, Given/When/Then. Exactly one tagged (make-or-break) and binary.

1. **(make-or-break)** Given pi-lens v3.8.47 installed and a noop target, When `resolveTdiSignal()` runs the headless probe (`--mode json` then `--mode rpc`), Then it returns a JSON object whose `warningCount` is a non-negative integer and whose `findings[].id` values are byte-identical across two consecutive runs of the same target, AND exactly one of `{tdi is a number, fallbackInEffect===true}` holds (never both null, never silent).
2. Given a numeric TDI is readable from a `~/.pi-lens/` artifact, When the probe resolves, Then `source==="tdi_artifact"`, `tdi` is a number, `fallbackInEffect===false`, and no §9.3 flag is set.
3. Given headless TDI is unobtainable (TUI-only), When the probe resolves, Then `source==="warning_proxy"`, `tdi===null`, `fallbackInEffect===true`, the §9.3 fallback flag is persisted, and the OQ-2 verdict row is written — the signal is never dropped silently (guard fires, no silent continue).

## Technical Notes

- **Contracts/Schema:** Zod `tdiSignalSchema` = `{ source: z.enum(["tdi_artifact","warning_proxy"]), tdi: z.number().nullable(), warningCount: z.number().int().nonnegative(), findings: z.array(z.object({ id: z.string().min(1), severity: z.enum(["info","warn","error"]) })), fallbackInEffect: z.boolean() }`. JSON decision record `oq2-verdict.json` = `{ oq: "OQ-2", verdict: "tdi_headless"|"proxy_fallback", decidedAt: ISO8601, probe: { jsonExit, rpcExit }, fallbackFlag: boolean }`.
- **Integration points (each wired & exercised in this story):** `pi install npm:pi-lens` install step; headless probe spawns `pi --mode json -p` / `pi --mode rpc` (non-interactive, no TUI per R4); artifact read of `~/.pi-lens/` history/review JSON; `--mode rpc` warning-count parse for the proxy path; the §9.3 `fallbackInEffect` flag persisted alongside the QA-gate config and read by the node emit path.
- **Files / functions touched:** `qa-gate.ts:resolveTdiSignal`, `pi-lens-probe.ts:runHeadlessProbe`/`readPiLensArtifact`/`countRpcWarnings`.
- **Guards/limits:** probe spawn carries a wall-clock cap; on probe non-zero exit or timeout the resolver returns `source="warning_proxy", fallbackInEffect=true` (fail-toward-proxy, never throw-and-skip the gate).

## Files to Modify

> ≤10 unique paths.

- `qds-factory/src/qa/pi-lens-probe.ts`
- `qds-factory/src/qa/qa-gate.ts`
- `qds-factory/src/qa/schemas/tdi-signal.schema.ts`
- `qds-factory/config/oq2-verdict.json`
- `qds-factory/scripts/install-pi-lens.sh`
- `qds-factory/test/qa/pi-lens-probe.test.ts`
- `qds-factory/test/qa/qa-gate.e2e.test.ts`

## Security Invariants

> input/file triggers: pi-lens secret-scan surface + parsing untrusted `~/.pi-lens/` JSON artifacts.

- **INV-1 (no secret leak):** pi-lens secret-scan (NFR-SEC-3) runs on the probe target; the resolver surfaces only finding IDs + severities + counts — no secret value, file content, or scanned source line is written to `findings[]`, stdout, logs, or any persisted artifact.
- **INV-2 (safe artifact parse):** `~/.pi-lens/` artifacts are read read-only and parsed via `JSON.parse` inside a try/catch; a malformed/oversized/absent artifact yields the proxy path (`fallbackInEffect=true`), never an unhandled exception, partial object, or arbitrary code execution.
- **INV-3 (non-silent fallback):** the warning/TDI signal can never be silently empty — every resolve sets exactly one of `tdi:number` or `fallbackInEffect:true`; a dropped signal is impossible by construction (schema-validated before return), so the gate cannot pass on a missing quality signal.

## Definition of Done

> 8–12 high-signal, story-specific boxes.

- [ ] **Impl:** `install-pi-lens.sh` installs/pins pi-lens v3.8.47 (`pi install npm:pi-lens`) and verifies the registry entry.
- [ ] **Impl:** `runHeadlessProbe` executes `--mode json` then `--mode rpc` against a noop and captures exit codes + JSON output.
- [ ] **Impl:** `resolveTdiSignal` prefers a `~/.pi-lens/` artifact TDI, else computes the `--mode rpc` warning-count proxy and sets `fallbackInEffect`.
- [ ] **Contract:** `tdiSignalSchema` (Zod) added with field-level validation; resolver output validated against it before return.
- [ ] **Integration:** the resolved signal is wired into the QA gate's node-emit path and the §9.3 `fallbackInEffect` flag is read there (not just produced).
- [ ] **Observability:** `oq2-verdict.json` records the OQ-2 verdict (`tdi_headless`/`proxy_fallback`), probe exit codes, decision date, and fallback flag.
- [ ] **Security:** INV-1 enforced — assert no secret value/source line appears in `findings`, logs, or the verdict record (NFR-SEC-3).
- [ ] **Security:** INV-2 enforced — malformed/absent `~/.pi-lens/` artifact resolves to the proxy path without throwing.
- [ ] **Test (unit/integration):** covers both branches (artifact-TDI present → `tdi_artifact`; artifact absent → `warning_proxy`) plus the timeout guard path.
- [ ] **Test (e2e demo — MANDATORY):** runs `resolveTdiSignal()` against the real noop; asserts stable `findings[].id` across two runs and that exactly one of `{tdi:number, fallbackInEffect:true}` holds — proves wiring closed.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
