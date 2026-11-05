/**
 * P1.7 — post-edit lsp_diagnostics gate.
 *
 * Runs pi-lens's `lsp_diagnostics` over the changed-file union (ONE `paths`
 * invocation per freshness round — P1.7-L4), re-queries for freshness (AC6),
 * and runs the degradation ladder:
 *
 *   LSP answers (fresh) ── errors? ──► BLOCKED (INV-DIAG-1, waiver 0)
 *        │                                   no waiverReason
 *        └─ pi-lens reports no server / init timeout ──► ast-grep + test-pass
 *             ast-grep missing AND no test suite ──► BLOCKED `no-evaluator`
 *
 * Freshness proxy (documented choice): the gate has no pre-edit snapshot, so
 * "fresh" = two consecutive parsed responses with identical per-file
 * diagnostic sets, at least one re-query apart. A stale-first response (the
 * PRE-edit revision, P0.6 measured 9-of-20) then differs from its successor,
 * forcing the re-query; stability across the interval is the observable
 * "reflects the edit". If stability is not reached inside the 10 s deadline
 * the gate fails CLOSED with `stale-diagnostics` — it never passes on a read
 * it could not confirm.
 *
 * Availability (AC3) is pi-lens's own resolve/start result, never a PATH
 * probe: the gate branches on what `callLspDiagnostics` reports (file errors
 * / init timeout), never on `which typescript-language-server`. PATH is the
 * availability test only for the ast-grep fallback binary (not
 * pi-lens-managed) — that probe lives inside `astGrepAvailable`.
 *
 * All waiver events (waiver > 0) are persisted best-effort through
 * `retainWaiverEvent` (INV-DIAG-2); a persistence failure never flips the
 * verdict (INV-DIAG-3: the result is computed once and returned unchanged).
 *
 * Reuses `parseBatchDiagnosticsText` (scripts/lsp-verify.ts, P0.6) for
 * per-file keying — never a second parser.
 */
import { parseBatchDiagnosticsText } from "../../../scripts/lsp-verify.ts";
import type { Gate, GateContext } from "./library.ts";
import { GateReport } from "./report.ts";

// --- Schema (story Technical Notes, flat waiver pair per P1.7-R5-1) ---------

export type WaiverReason = "no-lsp" | "no-evaluator" | "stale-diagnostics" | "lsp-timeout";

export interface DiagnosticEntry {
  file: string;
  line: number;
  severity: "error" | "warning";
  message: string;
  source: "lsp" | "ast-grep";
}

export interface DiagnosticsGateResult {
  passed: boolean;
  gateResult: "passed" | "blocked";
  waiver: number;
  waiverReason?: WaiverReason;
  diagnostics: DiagnosticEntry[];
  gateVersion: string;
}

export const LSP_GATE_VERSION = "p1.7.1";

/** Story guard: changed-file union capped at 50 files per run. */
export const MAX_CHANGED_FILES = 50;
/** P0.6's ceiling, reused deliberately (Freshness contract). */
export const FRESHNESS_DEADLINE_MS = 10_000;
/** Freshness re-query interval (Freshness contract). */
export const FRESHNESS_INTERVAL_MS = 250;
/** P0.6's LSP init window (AC3a). */
export const LSP_INIT_TIMEOUT_S = 15;
/** Per-file hard ceiling after successful startup (defensive backstop). */
export const LSP_RPC_CEILING_MS = 30_000;

// --- Injectable collaborators ------------------------------------------------

/** What one `lsp_diagnostics` invocation returns. `timedOut` classifies the
 *  two declared timeout outcomes (story table); the DEP owns the timers — the
 *  MCP wrapper that resolves pi-lens and speaks stdio — so the gate stays
 *  pure ladder logic. */
export interface LspCallResult {
  text: string;
  timedOut: null | "init" | "rpc";
}

export interface WaiverEvent {
  reason: WaiverReason;
  files: string[];
  diagnostics: DiagnosticEntry[];
  gateVersion: string;
}

export interface LspGateDeps {
  /** ONE tool invocation carrying `paths` (P1.7-L4); the dep adds waitMs/
   *  concurrency/serverScope and enforces the 30 s RPC ceiling + init window. */
  callLspDiagnostics(paths: string[]): Promise<LspCallResult>;
  /** PATH probe for the ast-grep binary ONLY (AC3: it is not pi-lens-managed). */
  astGrepAvailable(): Promise<boolean>;
  /** ast-grep scan over the degraded files; [] = clean. */
  astGrepScan(files: string[]): Promise<DiagnosticEntry[]>;
  /** Test-pass fallback; `hasTestSuite() === false` is the vacuous pass (P1.7-V1). */
  hasTestSuite(): Promise<boolean>;
  runTestSuite(): Promise<boolean>;
  /** INV-DIAG-2 persistence — best-effort, never flips the verdict. */
  retainWaiverEvent(event: WaiverEvent): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

// --- Core evaluation ---------------------------------------------------------

function result(
  passed: boolean,
  waiver: number,
  waiverReason: WaiverReason | undefined,
  diagnostics: DiagnosticEntry[],
): DiagnosticsGateResult {
  return {
    passed,
    gateResult: passed ? "passed" : "blocked",
    waiver,
    ...(waiverReason !== undefined ? { waiverReason } : {}),
    diagnostics,
    gateVersion: LSP_GATE_VERSION,
  };
}

/** Parsed per-file snapshot used as the freshness comparator. */
type Snapshot = string;

function snapshotOf(text: string): Snapshot {
  const { byFile } = parseBatchDiagnosticsText(text);
  const files = Object.keys(byFile).sort();
  return JSON.stringify(files.map((f) => [f, byFile[f]?.diagnostics ?? []]));
}

function entryOf(file: string, d: { line?: number; severity?: string; message?: string }): DiagnosticEntry {
  const severity = d.severity === "error" ? "error" : "warning";
  return {
    file,
    line: typeof d.line === "number" ? d.line : 0,
    severity,
    message: typeof d.message === "string" ? d.message : "",
    source: "lsp",
  };
}

function diagnosticsFromText(text: string): DiagnosticEntry[] {
  const { byFile } = parseBatchDiagnosticsText(text);
  const out: DiagnosticEntry[] = [];
  for (const [file, entry] of Object.entries(byFile)) {
    for (const d of entry.diagnostics ?? []) {
      out.push(entryOf(file, d as { line?: number; severity?: string; message?: string }));
    }
  }
  return out;
}

/** Files pi-lens reports it could not evaluate (AC3 availability signal). */
function fileErrorsFromText(text: string): string[] {
  const out: string[] = [];
  let inFileErrors = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^File errors:/i.test(line)) {
      inFileErrors = true;
      continue;
    }
    if (inFileErrors) {
      if (!line) break;
      out.push(line);
    }
  }
  return out;
}

async function persistBestEffort(deps: LspGateDeps, event: WaiverEvent): Promise<void> {
  try {
    await deps.retainWaiverEvent(event);
  } catch {
    /* INV-DIAG-2 is best-effort; INV-DIAG-3 keeps the verdict immutable */
  }
}

/**
 * The ladder, over the changed-file union. See module doc for the ladder and
 * the freshness proxy.
 */
export async function evaluateLspDiagnosticsGate(
  deps: LspGateDeps,
  input: { changedFiles: string[] },
): Promise<DiagnosticsGateResult> { // dp:ok a dep throw propagates; gatedBody's catch fails the check closed
  const changed = input.changedFiles.slice(0, MAX_CHANGED_FILES);

  // --- one LSP verdict for the union, with freshness (AC6) -----------------
  let text: string;
  let timedOut: LspCallResult["timedOut"];
  let fresh = false;
  let prevSnapshot: Snapshot | null = null;
  const start = deps.now();
  // At least one round always runs; freshness = two identical snapshots one
  // interval apart. A single changed file still needs the confirming re-query.
  let rounds = 0;
  for (;;) {
    const call = await deps.callLspDiagnostics(changed);
    text = call.text;
    timedOut = call.timedOut;
    rounds += 1;
    if (timedOut !== null) break; // timeout outcomes skip freshness — declared below
    const snap = snapshotOf(text);
    if (prevSnapshot !== null && snap === prevSnapshot) {
      fresh = true;
      break;
    }
    prevSnapshot = snap;
    if (deps.now() - start + FRESHNESS_INTERVAL_MS > FRESHNESS_DEADLINE_MS) break;
    await deps.sleep(FRESHNESS_INTERVAL_MS);
  }

  // --- declared timeout outcomes (story table) -----------------------------
  if (timedOut === "rpc") {
    const out = result(false, 1, "lsp-timeout", []);
    await persistBestEffort(deps, { reason: "lsp-timeout", files: changed, diagnostics: [], gateVersion: LSP_GATE_VERSION });
    return out;
  }
  if (timedOut === "init") {
    // AC3a: LSP treated as unavailable → the whole union degrades to fallback.
    return evaluateFallback(deps, changed, 1, "no-lsp");
  }
  if (!fresh) {
    // AC6 fail-closed: freshness not confirmed inside the deadline.
    const out = result(false, 1, "stale-diagnostics", diagnosticsFromText(text));
    await persistBestEffort(deps, { reason: "stale-diagnostics", files: changed, diagnostics: out.diagnostics, gateVersion: LSP_GATE_VERSION });
    return out;
  }

  // --- fresh result: INV-DIAG-1 --------------------------------------------
  const diagnostics = diagnosticsFromText(text);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    return result(false, 0, undefined, diagnostics);
  }

  // --- pi-lens-reported unavailability (AC3) → fallback for those files ----
  const fileErrors = fileErrorsFromText(text);
  if (fileErrors.length > 0) {
    return evaluateFallback(deps, fileErrors, 1, "no-lsp");
  }

  return result(true, 0, undefined, diagnostics);
}

/**
 * The ast-grep + test-pass fallback (AC3/AC4/AC5/V1) for `degraded` files.
 * `reason` is why the LSP was unavailable (`no-lsp` or, when the LSP path is
 * entirely absent, `no-evaluator` is derived below from the evaluator census).
 */
async function evaluateFallback(
  deps: LspGateDeps,
  degraded: string[],
  waiver: number,
  reason: WaiverReason,
): Promise<DiagnosticsGateResult> { // dp:ok same fail-closed posture via gatedBody's catch
  const astOk = await deps.astGrepAvailable();
  const tests = await deps.hasTestSuite();

  if (!astOk && !tests) {
    // AC5 fail-closed: no evaluator at all.
    const out = result(false, waiver + 1, "no-evaluator", []);
    await persistBestEffort(deps, { reason: "no-evaluator", files: degraded, diagnostics: [], gateVersion: LSP_GATE_VERSION });
    return out;
  }

  let diagnostics: DiagnosticEntry[] = [];
  let passed = true;
  if (astOk) {
    diagnostics = await deps.astGrepScan(degraded);
    if (diagnostics.some((d) => d.severity === "error")) passed = false;
  }
  if (passed && tests) {
    passed = await deps.runTestSuite();
  }

  if (!passed) {
    const out = result(false, waiver, reason, diagnostics);
    await persistBestEffort(deps, { reason, files: degraded, diagnostics, gateVersion: LSP_GATE_VERSION });
    return out;
  }
  return result(true, waiver, reason, diagnostics);
}

// --- Gate adapter ------------------------------------------------------------

/**
 * The `Gate` for `gatedBody`: examines `envelope.changedFiles` and maps the
 * evaluation to a `GateReport`. Deps default to the production set (real
 * pi-lens MCP client) — tests inject fakes.
 */
export function createLspDiagnosticsGate(deps: LspGateDeps): Gate {
  return {
    name: "lsp-diagnostics-gate",
    async run(envelope: unknown, _ctx: GateContext) { // dp:ok gatedBody's catch converts a throw into a failed check
      const changed = (envelope as { changedFiles?: string[] } | undefined)?.changedFiles ?? [];
      const r = await evaluateLspDiagnosticsGate(deps, { changedFiles: changed });
      const report = new GateReport();
      report.check(
        `waiver=${r.waiver}${r.waiverReason !== undefined ? ` (${r.waiverReason})` : ""}`,
        r.passed,
        `${r.diagnostics.length} diagnostic(s)`,
      );
      return report;
    },
  };
}
