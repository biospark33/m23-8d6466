#!/usr/bin/env bun
/**
 * LSP provision + diagnostics/navigation verification harness (Story P0.6).
 *
 * Proves that a warm per-worktree LSP server, reached through pi-lens's
 * machine-readable surfaces, delivers live diagnostics and semantic navigation
 * for a target repo WITHOUT a live LLM. Like its P0.5 sibling
 * (`scripts/pi-lens-verify.ts`, whose discipline this mirrors per the story's
 * Wave 1 Reuse Mandate) it drives the pi-lens MCP server (`dist/mcp/server.js`)
 * over stdio JSON-RPC: the same engine a Pi agent's tools call, reached
 * headlessly.
 *
 * Exercised (AC → check):
 *   AC1  Diagnostics reflect an UNCOMMITTED edit, not a stale index. A baseline
 *        diagnostic count is captured BEFORE the edit; after the edit the check
 *        asserts the new error rule appears AND the count changed
 *        (baselineN → postEditN negative control), then measures warm latency
 *        p95 over ≥20 samples (NFR-PERF-6, ≤3 s). WARM = after the server has
 *        returned its first non-empty diagnostic response. The cold start is
 *        amortized once per worktree session and recorded as advisory, never a
 *        failure (NFR-PERF-5).
 *   AC2  `pilens_lsp_navigation` go-to-definition resolves a cross-file symbol
 *        to the correct file/line/character.
 *   AC2b A definition whose URI falls OUTSIDE the worktree root (TypeScript's
 *        bundled lib.*.d.ts) is returned as real locations and flagged
 *        `external:true` by a URI-prefix check — a HARNESS-layer convention,
 *        not a native LSP field. Never silently coerced to an empty array.
 *   AC3  A file in a language with no LSP server degrades gracefully: a warning
 *        in the response payload, no crash, no hang. The on-disk artifact half
 *        of the assertion is recorded as observed-or-not, never assumed.
 *   AC3a A server that accepts the connection but never answers `initialize`
 *        must time out (bounded), log `lsp_init_timeout`, and yield a graceful
 *        payload. Proven against a purpose-built hang-server fixture, which
 *        exercises the HARNESS invariant "every RPC has a deadline".
 *   AC4  Batch diagnostics over `paths: [a, b]` return findings keyed per file,
 *        and a per-file failure yields PARTIAL results — the failing entry
 *        reports its failure while the other file still returns findings.
 *
 * Containment: the MCP server is spawned with `PILENS_DATA_DIR` pointed INSIDE
 * the temp work dir, so all PROJECT-SCOPED pi-lens on-disk state dies with the
 * work dir. One global exception, inherited from P0.5: pi-lens's latency
 * telemetry appends to `~/.pi-lens/latency.log`, keyed on PI_LENS_HOME rather
 * than PILENS_DATA_DIR; the harness reads it (as the story's named p95 source)
 * and intentionally leaves it in place.
 *
 * Output: structured JSON on stdout ({ results: Check[], summary }).
 * Exit 0 iff no FAIL (skips allowed; under --strict or CI a skip of a
 * NON-optional check also exits non-zero). Exit 2 on a fatal error before
 * checks start.
 *
 * Flags: --json (accepted; output is always JSON), --keep (retain the temp
 *        dir), --strict (skips of non-optional checks fail the run; CI env
 *        implies --strict).
 *
 * Run:  bun scripts/lsp-verify.ts [--json] [--keep] [--strict]
 */

import {
  execFile,
  execFileSync,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Check, createChecklist } from "./lib/harness-notes.ts";
import {
  McpClient,
  type McpToolResult,
  parseToolJson,
  parseToolJsonText,
  toolText,
} from "./lib/mcp-stdio-client.ts";
import {
  canonicalize,
  compareVersions,
  harnessNotes as notes,
  isInside,
  p95,
  projectDataDir,
  resolvePiLens,
} from "./lib/pi-lens-harness.ts";

// Re-exported so tests keep a single import site for the harness surface.
export { compareVersions, p95, parseToolJsonText, resolvePiLens };

/**
 * Async (not `spawnSync`): a synchronous spawn would block the event loop, so
 * no timeout could preempt it — neither this harness's own nor the SIGTERM the
 * Phase-0 gate sends when it invokes this script through `runVerifier`. The
 * agent probe budgets 300 s per attempt over 3 attempts, so a blocking spawn
 * made the harness unkillable for up to 900 s and the gate along with it
 * (#66, #72).
 */
const execFileAsync = promisify(execFile);

/**
 * `execFileAsync` with the child's stdin closed immediately.
 *
 * REQUIRED for `pi`, not cosmetic. `spawnSync` hands the child a stdin that is
 * already at EOF, but async `execFile` leaves that pipe OPEN — so a prompt-mode
 * turn blocks waiting for input that never arrives and burns its entire 300 s
 * budget, three attempts deep (measured: 39 s -> 2133 s before this line).
 * Closing stdin restores exactly the synchronous behaviour.
 */
function execFilePi(
  file: string,
  args: string[],
  opts: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  const p = execFileAsync(file, args, opts);
  p.child.stdin?.end();
  return p;
}

/** Shape execFile attaches to its rejection: a non-zero exit sets numeric `code`. */
interface ExecFileError extends Error {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/** pi-lens floor the story mandates. Installed-below-floor is reported, never fatal. */
const MIN_PI_LENS_VERSION = "3.8.69";

/** NFR-PERF-6: warm `lsp_diagnostics` p95 budget. */
const WARM_P95_BUDGET_MS = 3_000;

/** Warm samples required before a p95 is claimed (story AC1: ≥20). */
const WARM_SAMPLE_TARGET = 20;

/**
 * How many of those samples must be provably live (fresh marker) and
 * substantive (the diagnostic actually rendered) before a p95 is claimed.
 *
 * Set to the same 95% the statistic itself tolerates: demanding 20/20 would let
 * one transient debounce race fail an AC that 19 samples genuinely proved,
 * while a simple majority would let real cache-serving slip through.
 */
const WARM_VALID_SAMPLE_FLOOR = Math.ceil(0.95 * WARM_SAMPLE_TARGET);

/**
 * TS2322 as pi-lens actually renders it — `error[typescript] (2322):` or
 * `typescript:2322`. Deliberately not a bare /2322/ over the response blob.
 */
const TS2322_RENDERED = /\(2322\)|typescript:2322/;

/** Bounded re-query budget for a warm sample to reflect the latest edit. */
const WARM_FRESHNESS_TIMEOUT_MS = 10_000;

/**
 * Diagnostic line numbers pi-lens reports, from its rendered form
 * `L<line>:<col>: severity[tool] (rule): message`. Used to tell a FRESH
 * response from a stale replay: the harness moves the error to a known line
 * each iteration, so the reported line is an observable freshness token.
 *
 * EVERY rendered line is scanned rather than only the first — the fixture emits
 * more than one finding and pi-lens does not guarantee ordering, so a
 * first-match-only read would leave the freshness count at 0 on a healthy
 * server.
 *
 * `matching` narrows to lines whose rendering matches a rule, and the freshness
 * caller MUST pass it. The fixture's secondary ast-grep finding sits at
 * `expectedLine + 1`, which is exactly the NEXT iteration's expectedLine — so
 * an unfiltered scan would accept a stale response as fresh whenever the
 * previous revision's secondary finding happens to land on the line this
 * iteration is waiting for.
 */
export function extractReportedLines(text: string, matching?: RegExp): number[] {
  const out: number[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*L(\d+):\d+:/);
    if (!m?.[1]) continue;
    if (matching && !matching.test(line)) continue;
    out.push(Number(m[1]));
  }
  return out;
}

/**
 * AC3a: bounded `initialize` deadline. Env-overridable, seconds.
 *
 * Validated rather than trusted: `Number()` yields NaN for garbage, and Node
 * clamps a NaN/zero/negative `setTimeout` delay to 1ms — which would fire the
 * real MCP handshake deadline almost instantly, abort every AC, and report the
 * misconfiguration as an opaque "server timed out" failure.
 */
const LSP_INIT_TIMEOUT_S = ((): number => {
  const raw = process.env.LSP_INIT_TIMEOUT_S;
  if (raw === undefined) return 15;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    notes.push(`LSP_INIT_TIMEOUT_S=${JSON.stringify(raw)} is not a positive number — falling back to 15s`);
    return 15;
  }
  return parsed;
})();

// ---------------------------------------------------------------------------
// pi-lens install resolution
// ---------------------------------------------------------------------------

// The resolver (`PI_LENS_ROOT` → repo-local `node_modules/pi-lens` → global
// probe) now lives in `lib/pi-lens-harness.ts` so every harness shares one env
// contract (#55). Re-exported above; `tests/lsp-verify.test.ts` imports it
// from this module.

// ---------------------------------------------------------------------------
// Check plumbing
// ---------------------------------------------------------------------------

interface LspCheck extends Check {
  /**
   * Where the CHECK's contract is narrower than the story's AC as literally
   * worded, the check may pass while the story-level AC is only partial. P0.5
   * set this precedent for its AC1 (derived-vs-observed id) rather than
   * silently redefining the gap as satisfied; same discipline here.
   */
  storyLevelStatus?: "met" | "partial";
  /** Why the story-level status differs from the check status. */
  storyLevelNote?: string;
}

const { checks, record } = createChecklist<LspCheck>();

/**
 * Read pi-lens's global latency telemetry (`~/.pi-lens/latency.log`, NDJSON) and
 * return the `durationMs` of every LSP-runner record for files under `root` that
 * was written after `sinceMs`. This is the story's NAMED p95 source; the
 * harness's own wall-clock samples are recorded alongside it, and the evidence
 * labels which one each number came from.
 */
function readLatencyLogSamples(root: string, sinceMs: number): { path: string; samples: number[] } {
  const p = path.join(os.homedir(), ".pi-lens", "latency.log");
  const out: number[] = [];
  // Separator-aware + symlink-resolved, for the same reason flagExternal is:
  // two mkdtemp roots can share a prefix (`lsp-verify-abc` / `lsp-verify-abcd`),
  // and a bare startsWith would fold another run's samples into this one's.
  const rootCanonical = canonicalize(root);
  if (!fs.existsSync(p)) return { path: p, samples: out };
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return { path: p, samples: out };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type !== "runner" || rec.runnerId !== "lsp") continue;
    const filePath = typeof rec.filePath === "string" ? rec.filePath : "";
    if (!filePath || !isInside(canonicalize(filePath), rootCanonical)) continue;
    const ts = typeof rec.ts === "string" ? Date.parse(rec.ts) : Number.NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const d = rec.durationMs;
    if (typeof d === "number" && Number.isFinite(d)) out.push(d);
  }
  return { path: p, samples: out };
}

/**
 * Extract diagnostic records from a pi-lens tool result, tolerating both
 * observed shapes: `pilens_analyze`'s `{ diagnostics: [...] }` and
 * `pilens_lsp_diagnostics`'s per-file envelope. Returns the array plus the key
 * it was found under, so the artifact can record WHICH surface produced it
 * (P0.5 caveat 1: the structured payload came from pilens_analyze, not
 * pilens_lsp_diagnostics).
 */
export function extractDiagnostics(json: Record<string, unknown> | undefined): {
  diagnostics: Array<Record<string, unknown>>;
  sourceKey?: string;
} {
  if (!json) return { diagnostics: [] };
  for (const key of ["diagnostics", "findings", "results"]) {
    const v = json[key];
    if (Array.isArray(v)) return { diagnostics: v as Array<Record<string, unknown>>, sourceKey: key };
  }
  // Batch envelope: { files: [{ path, diagnostics: [...] }] }
  const files = json.files;
  if (Array.isArray(files)) {
    const flat = files.flatMap((f) => {
      const d = (f as Record<string, unknown>)?.diagnostics;
      return Array.isArray(d) ? (d as Array<Record<string, unknown>>) : [];
    });
    return { diagnostics: flat, sourceKey: "files[].diagnostics" };
  }
  return { diagnostics: [] };
}

/** Per-file entries of a batch diagnostics result, keyed by file path (AC4). */
export function extractBatchByFile(json: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!json) return undefined;
  const files = json.files;
  if (Array.isArray(files)) {
    const byFile: Record<string, unknown> = {};
    for (const f of files) {
      const rec = f as Record<string, unknown>;
      const key = typeof rec.filePath === "string" ? rec.filePath : typeof rec.path === "string" ? rec.path : undefined;
      if (key) byFile[key] = rec;
    }
    return Object.keys(byFile).length > 0 ? byFile : undefined;
  }
  return undefined;
}

export interface BatchFileEntry {
  /** Diagnostic lines attributed to this file. */
  diagnostics: Array<{ line: number; column: number; severity: string; rule?: string; message: string }>;
  /** Present when the batch reported this path under "File errors:". */
  error?: string;
}

/**
 * Parse `pilens_lsp_diagnostics`' BATCH surface, which in 3.8.71 is
 * human-readable text with no JSON envelope of any kind:
 *
 *   Files checked: 3
 *   Total diagnostics: 2
 *   Concurrency: 8
 *
 *   File errors:
 *   /abs/path/nope.ts: path not found
 *
 *   Auxiliary findings (2):
 *   /abs/path/app.ts:4:23: error[ast-grep] (rule-id): message
 *
 * Per-file keying (AC4) is therefore DERIVED by this harness from the text, not
 * read from a structured field — recorded as such in the evidence. Returns an
 * entry for every file mentioned in either section, so a per-file failure sits
 * alongside a healthy file's findings (the PARTIAL, non-atomic contract).
 */
export function parseBatchDiagnosticsText(text: string): {
  byFile: Record<string, BatchFileEntry>;
  filesChecked?: number;
  totalDiagnostics?: number;
} {
  const byFile: Record<string, BatchFileEntry> = {};
  const entry = (file: string): BatchFileEntry => {
    const existing = byFile[file];
    if (existing) return existing;
    const created: BatchFileEntry = { diagnostics: [] };
    byFile[file] = created;
    return created;
  };

  const filesCheckedMatch = text.match(/^Files checked:\s*(\d+)/m);
  const totalMatch = text.match(/^Total diagnostics:\s*(\d+)/m);

  let inFileErrors = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^File errors:/i.test(line)) {
      inFileErrors = true;
      continue;
    }
    // Any other section header ends the File errors block.
    if (/^[A-Z][^:]*\s*(\(\d+\))?:$/.test(line) || /^(No diagnostics found|Total diagnostics|Files checked|Concurrency)/i.test(line)) {
      inFileErrors = false;
      if (!/^File errors:/i.test(line)) continue;
    }

    // A diagnostic line: <path>:<line>:<col>: <severity>[<tool>] (<rule>): msg
    const diag = line.match(/^(.*?):(\d+):(\d+):\s*(\w+)(?:\[([^\]]+)\])?\s*(?:\(([^)]*)\))?\s*:?\s*(.*)$/);
    if (diag?.[1] && !inFileErrors) {
      const [, file, l, c, severity, tool, rule, message] = diag;
      entry(file as string).diagnostics.push({
        line: Number(l),
        column: Number(c),
        severity: severity as string,
        rule: rule ? `${tool ?? ""}:${rule}` : tool,
        message: (message ?? "").trim(),
      });
      continue;
    }

    if (inFileErrors) {
      // "<path>: <reason>" — split on the FIRST colon-space. pi-lens builds
      // these as `${file}: ${reason}` and a path never contains ": ", whereas a
      // reason easily can ("permission denied: access denied"), which a
      // lastIndexOf split would fold into the path and break the file key.
      const idx = line.indexOf(": ");
      if (idx > 0) {
        entry(line.slice(0, idx)).error = line.slice(idx + 2).trim();
      }
    }
  }

  return {
    byFile,
    filesChecked: filesCheckedMatch?.[1] ? Number(filesCheckedMatch[1]) : undefined,
    totalDiagnostics: totalMatch?.[1] ? Number(totalMatch[1]) : undefined,
  };
}

/**
 * URI-prefix check against the worktree root — the story's `external:true`
 * convention (AC2b). This is a HARNESS-layer flag, NOT a native LSP field: the
 * server returns real locations whose uri may point into node_modules or a
 * bundled lib.*.d.ts, and this only labels them.
 */
export function flagExternal(
  locations: Array<Record<string, unknown>>,
  worktreeRoot: string,
): Array<Record<string, unknown>> {
  const rootResolved = canonicalize(worktreeRoot);
  return locations.map((loc) => {
    const uri = typeof loc.uri === "string" ? loc.uri : undefined;
    let filePath = typeof loc.filePath === "string" ? loc.filePath : undefined;
    if (!filePath && uri?.startsWith("file:")) {
      try {
        filePath = fileURLToPath(uri);
      } catch {
        filePath = undefined;
      }
    }
    // Unknown path => cannot prove it is inside the worktree; label it external
    // rather than silently claiming local.
    const external = filePath === undefined || !isInside(canonicalize(filePath), rootResolved);
    return { ...loc, external };
  });
}

/**
 * Recursively scan pi-lens's project artifact dir for any of `signals`,
 * returning which files matched. Bounded in depth and file size so a large
 * cache directory cannot stall the run.
 */
export function scanArtifactsForSignal(
  dir: string,
  signals: readonly string[],
  maxDepth = 3,
): { found: boolean; matches: string[]; scanned: number } {
  const matches: string[] = [];
  let scanned = 0;
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        // Skip anything implausibly large for a text artifact.
        if (fs.statSync(full).size > 2_000_000) continue;
        const content = fs.readFileSync(full, "utf8");
        scanned++;
        if (signals.some((s) => content.includes(s))) matches.push(full);
      } catch {
        /* unreadable/binary artifact — not a signal source */
      }
    }
  };
  walk(dir, 0);
  return { found: matches.length > 0, matches, scanned };
}

/** Navigation envelope locations (pi-lens `locations[]`), else empty. */
function navLocations(json: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const locs = json?.locations;
  return Array.isArray(locs) ? (locs as Array<Record<string, unknown>>) : [];
}

// ---------------------------------------------------------------------------
// AC3a — hang-server probe (harness deadline invariant)
// ---------------------------------------------------------------------------

/**
 * Spawn a fixture "language server" that accepts the connection and reads
 * stdin forever WITHOUT ever answering `initialize`, then drive a properly
 * LSP-framed initialize at it under a bounded deadline. Proves the harness
 * invariant "every RPC has a deadline": the probe returns a graceful-degradation
 * payload with an `lsp_init_timeout` marker instead of hanging.
 *
 * Scoped honestly: this exercises the HARNESS's deadline, not pi-lens's
 * internal LSP client. The evidence records that distinction.
 */
async function probeInitTimeout(
  workDir: string,
  timeoutMs: number,
): Promise<{
  timedOut: boolean;
  elapsedMs: number;
  payload: Record<string, unknown>;
  logLine: string;
  error?: string;
}> {
  const serverPath = path.join(workDir, "hang-server.cjs");
  // Reads stdin, never writes: an accept-but-never-respond server. Speaks the
  // same newline-framed JSON-RPC stdio transport McpClient expects, so it
  // stands in for a server that connects but never completes the handshake.
  fs.writeFileSync(serverPath, "process.stdin.resume();\nsetInterval(() => {}, 1 << 30);\n");

  // Drive it through the REAL McpClient — the same class, the same rpc()
  // deadline, that every other check in this harness uses. An earlier version
  // raced a throwaway setTimeout instead, which proved only that a second,
  // parallel timeout implementation worked; this exercises the actual code path.
  const started = Date.now();
  const client = new McpClient(serverPath, workDir, { ...process.env });
  let timedOut = false;
  let error: string | undefined;
  try {
    await client.init(timeoutMs);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    // The deadline firing is the expected outcome; anything else is not a
    // timeout and must not be reported as one.
    timedOut = /timed out/i.test(error);
  } finally {
    client.close();
  }
  const elapsedMs = Date.now() - started;
  const logLine = `lsp_init_timeout server=hang-server.cjs timeoutMs=${timeoutMs} elapsedMs=${elapsedMs}`;
  // Graceful-degradation payload shape: a warning, never a thrown crash.
  const payload = {
    degraded: true,
    reason: "lsp_init_timeout",
    warning: `LSP server did not answer initialize within ${timeoutMs}ms — diagnostics unavailable for this server`,
    diagnostics: [] as unknown[],
  };
  return { timedOut, elapsedMs, payload, logLine, error };
}

// ---------------------------------------------------------------------------
// DoD — `--mode json` agent e2e probe
// ---------------------------------------------------------------------------

/**
 * Run `pi -p --mode json --no-session "reply OK"` and report what was actually
 * observed on stdout. Mirrors P0.5 §2: the handshake event proves headless
 * machine-readable emission with no TUI, but a full agent turn needs LLM auth,
 * so the mandatory demo is recorded deferred rather than claimed.
 */
interface AgentToolCall {
  toolName: string;
  args?: Record<string, unknown>;
  result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> };
  isError?: boolean;
}

interface AgentProbeResult {
  piFound: boolean;
  piVersion?: string;
  command: string;
  handshakeObserved: boolean;
  toolPayloadObserved: boolean;
  diagnosticsToolCall?: AgentToolCall;
  navigationToolCall?: AgentToolCall;
  agentToolNames: string[];
  attempts: number;
  errorReflected: boolean;
  definitionResolved: boolean;
  definitionResolvedCrossFile: boolean;
  exitCode: number | null;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  reason: string;
}

/**
 * The agent's tool choice is sampled, not deterministic: a turn sometimes stops
 * after `pi_lens_activate_tools` without invoking the LSP tools. Since this is
 * the story's MANDATORY demo, attempt it more than once before recording a
 * deferral — a single unlucky sample is not evidence that the capability is
 * missing.
 */
const AGENT_PROBE_ATTEMPTS = 3;

async function probeAgentModeJson(
  cwd: string,
  piLensExtension: string,
  libFile: string,
): Promise<AgentProbeResult> {
  let last: AgentProbeResult | undefined;
  for (let attempt = 1; attempt <= AGENT_PROBE_ATTEMPTS; attempt++) {
    const result = await probeAgentModeJsonOnce(cwd, piLensExtension, libFile, attempt);
    last = result;
    // Stop as soon as the demo is fully satisfied, or when retrying cannot help
    // (pi missing / auth failure / a killed run).
    if ((result.toolPayloadObserved && result.errorReflected && result.definitionResolved) || !result.piFound) {
      return result;
    }
  }
  return last as AgentProbeResult;
}

async function probeAgentModeJsonOnce(
  cwd: string,
  piLensExtension: string,
  libFile: string,
  attempt: number,
): Promise<AgentProbeResult> {
  const prompt =
    "You have pi-lens tools available. If a tool-activation step is required, " +
    "perform it FIRST and then CONTINUE — activating the tools is not the task. " +
    "You must actually invoke BOTH of the following tools before replying:\n" +
    "1) lsp_diagnostics on app.ts\n" +
    "2) lsp_navigation with EXACTLY these arguments: " +
    "{ operation: 'definition', path: 'app.ts', line: 1, symbol: 'add' }. " +
    "Line 1 is the import statement — do NOT navigate from the usage on line 3, " +
    "which only resolves back to the import binding in the same file.\n" +
    "Report verbatim what each tool returned. Do not answer from inspection of " +
    "the file — the tool results themselves are the required output.";
  const args = ["-p", "--mode", "json", "--no-session", "-e", piLensExtension, prompt];
  const command = `pi ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;
  const empty: AgentProbeResult = {
    piFound: false,
    command,
    handshakeObserved: false,
    toolPayloadObserved: false,
    agentToolNames: [],
    attempts: attempt,
    errorReflected: false,
    definitionResolved: false,
    definitionResolvedCrossFile: false,
    exitCode: null,
    stdoutExcerpt: "",
    stderrExcerpt: "",
    reason: "`pi` is not on PATH, so the agent demo could not be attempted",
  };

  let piVersion: string | undefined;
  try {
    piVersion = (
      await execFilePi("pi", ["--version"], { encoding: "utf8", timeout: 15_000 })
    ).stdout.trim();
  } catch {
    return empty;
  }

  // A non-zero exit is a NORMAL outcome here (pi dies at LLM auth), so it must
  // keep the captured output. Only a kill — timeout or maxBuffer — or a spawn
  // failure makes the capture untrustworthy; that lands in the `error` branch
  // below rather than escaping to main()'s catch as a synthetic "AC?" failure.
  let proc: { stdout: string | null; stderr: string | null; status: number | null; error?: Error };
  try {
    const res = await execFilePi("pi", args, {
      cwd,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    proc = { stdout: res.stdout, stderr: res.stderr, status: 0 };
  } catch (err) {
    const e = err as ExecFileError;
    const exited = typeof e.code === "number";
    proc = {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      status: exited ? (e.code as number) : null,
      // execFile's own message on a kill is "Command failed: <the entire
      // prompt>", which buries the cause. Report the cause instead; the
      // captured output is already carried in stdoutExcerpt/stderrExcerpt.
      error: exited
        ? undefined
        : new Error(
            e.killed === true
              ? `killed by the 300000ms timeout or the 32 MiB output cap (${String(e.code ?? "no code")})`
              : (e.message ?? String(err)).slice(0, 300),
          ),
    };
  }
  if (proc.error) {
    // ENOBUFS (maxBuffer) / ETIMEDOUT: the child was KILLED and stdout is
    // truncated. Parsing it anyway would under-report the tools that ran and
    // record the misleading "agent made no lsp_diagnostics call".
    return {
      ...empty,
      piFound: true,
      piVersion,
      exitCode: proc.status,
      stdoutExcerpt: (proc.stdout ?? "").slice(0, 300),
      stderrExcerpt: (proc.stderr ?? "").slice(0, 300),
      reason: `the agent turn was terminated before completion (${proc.error.message}); captured output is truncated`,
    };
  }

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";

  // The stream is NDJSON: one event object per line.
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* partial/among non-JSON output */
    }
  }
  const handshakeObserved = events.some((e) => e.type === "session");
  const toolEnds = events.filter((e) => e.type === "tool_execution_end") as unknown as AgentToolCall[];
  const toolStarts = events.filter((e) => e.type === "tool_execution_start") as unknown as AgentToolCall[];
  const agentToolNames = [...new Set(toolStarts.map((t) => t.toolName).filter(Boolean))];

  const diagnosticsToolCall = toolEnds.find((t) => /lsp_diagnostics/.test(t.toolName ?? ""));
  const navigationToolCall = toolEnds.find((t) => /lsp_navigation/.test(t.toolName ?? ""));

  const diagText = diagnosticsToolCall?.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  const diagDetails = diagnosticsToolCall?.result?.details;
  const detailDiagnostics = Array.isArray(diagDetails?.diagnostics)
    ? (diagDetails.diagnostics as Array<Record<string, unknown>>)
    : [];
  // The uncommitted type error must be reflected in the AGENT-visible payload.
  const errorReflected =
    TS2322_RENDERED.test(diagText) || detailDiagnostics.some((d) => String(d.code ?? "") === "2322");

  const navText = navigationToolCall?.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  const navDetails = navigationToolCall?.result?.details;
  const libBase = path.basename(libFile);
  const navBlob = `${navText}\n${JSON.stringify(navDetails ?? {})}`;
  const navEnvelope = parseToolJsonText(navText);
  // A definition was genuinely resolved: the tool succeeded AND returned at
  // least one location. An empty/errored navigation still fails the demo.
  const definitionResolved =
    navigationToolCall !== undefined &&
    navigationToolCall.isError !== true &&
    (Number(navEnvelope?.resultCount ?? 0) > 0 || /"result"\s*:\s*\[\s*\{/.test(navBlob));
  // Stricter signal: did it resolve ACROSS files to lib.ts? Recorded, not
  // required — the agent may navigate from the usage, whose correct TypeScript
  // answer is the import binding in app.ts (a same-file hop).
  const definitionResolvedCrossFile = navBlob.includes(libBase);

  const toolPayloadObserved = diagnosticsToolCall !== undefined;
  const authFailed = /Authentication failed|credentials may have expired|unauthorized/i.test(`${stdout}\n${stderr}`);

  return {
    piFound: true,
    piVersion,
    command,
    handshakeObserved,
    toolPayloadObserved,
    diagnosticsToolCall,
    navigationToolCall,
    agentToolNames,
    attempts: attempt,
    errorReflected,
    definitionResolved,
    definitionResolvedCrossFile,
    exitCode: proc.status,
    stdoutExcerpt: stdout.slice(0, 300),
    stderrExcerpt: stderr.slice(0, 300),
    reason: authFailed
      ? "the agent turn terminated at LLM authentication before any tool executed"
      : toolPayloadObserved
        ? "agent turn completed with an lsp_diagnostics tool execution"
        : `the agent turn produced no lsp_diagnostics tool call (exit ${proc.status}; tools seen: ${agentToolNames.join(", ") || "none"})`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * F081: the fixture and client every AC gate runs against. Each gate is its
 * own `async function acN(ctx)` below, so the try/catch/finally in main() is
 * the only state they share — before the split, all six gates plus their
 * fixture setup and teardown were one unbroken 639-line function.
 */
interface LspVerifyCtx {
  client: McpClient;
  work: string;
  appFile: string;
  libFile: string;
  unsupportedFile: string;
  appWithTypeError: string;
  gitState: { available: boolean; initOk: boolean; committedOk: boolean };
  runStartedMs: number;
  git: (args: string[]) => boolean;
  pl: ReturnType<typeof resolvePiLens>;
}

async function ac1(ctx: LspVerifyCtx): Promise<void> {
  const { client, work, appFile, appWithTypeError, gitState, runStartedMs, git } = ctx;
  // --- AC1: cold start, baseline, uncommitted edit, warm p95 --------------
  // Cold start is amortized ONCE per worktree session (NFR-PERF-6) and
  // recorded as advisory, never a failure (NFR-PERF-5).
  const coldStarted = Date.now();
  const coldResult = await client.call(
    "pilens_lsp_diagnostics",
    { path: appFile, cwd: work, severity: "all", serverScope: "primary" },
    120_000,
  );
  const coldMs = Date.now() - coldStarted;
  const coldText = toolText(coldResult);

  // Baseline (pre-edit) diagnostic count for the stale-index control.
  const baselineResult = await client.call(
    "pilens_analyze",
    { file: appFile, cwd: work },
    90_000,
  );
  const baselineJson = parseToolJson(baselineResult);
  const baseline = extractDiagnostics(baselineJson);
  const baselineN = baseline.diagnostics.length;

  // The UNCOMMITTED edit: introduce a genuine TS2322 on disk, never committed.
  fs.writeFileSync(appFile, appWithTypeError);

  const postEditResult = await client.call(
    "pilens_analyze",
    { file: appFile, cwd: work },
    90_000,
  );
  const postEditJson = parseToolJson(postEditResult);
  const postEdit = extractDiagnostics(postEditJson);
  const postEditN = postEdit.diagnostics.length;
  const newDiag = postEdit.diagnostics.find(
    (d) => d.tool === "lsp" && /2322/.test(`${d.rule ?? ""}${d.code ?? ""}`),
  );
  // The edit must be visible to git as uncommitted — proves "not a stale
  // index" is about live buffer state, not a re-read of a committed file.
  const editUncommitted = gitState.committedOk
    ? (() => {
        try {
          return (
            execFileSync("git", ["-C", work, "status", "--porcelain", "--", "app.ts"], {
              encoding: "utf8",
            }).trim().length > 0
          );
        } catch {
          return false;
        }
      })()
    : undefined;

  // Warm latency samples. WARM = after the first non-empty diagnostic
  // response, which the post-edit call above just produced.
  const warmSamples: number[] = [];
  // A fast response that returned NOTHING is not a valid latency sample —
  // it would let a broken/idle server fake p95 compliance. Count how many
  // warm responses actually reported the injected type error.
  let warmSubstantive = 0;
  // ...and a fast response that merely REPLAYED a cached analysis is not a
  // valid sample either: re-querying an unchanged file 20 times cannot
  // distinguish "warm live re-query" from "cache hit". So every iteration
  // rewrites app.ts with a DISTINCT type error, forcing a real re-analysis,
  // and asserts the response carries that iteration's own symbol.
  let warmFreshlyAnalyzed = 0;
  // How many samples needed more than one query before the response caught
  // up with the edit. Directly observed, and a real finding in its own
  // right: pi-lens can serve a stale diagnostic to a rapid re-query.
  let warmStaleFirstResponse = 0;
  const warmFirstNonEmptyObserved = postEditN > 0;
  if (warmFirstNonEmptyObserved) {
    for (let i = 0; i < WARM_SAMPLE_TARGET; i++) {
      // Move the error to a DISTINCT line each iteration. The reported line
      // is then an observable freshness token: a stale replay carries the
      // previous iteration's line. (The TS2322 message itself never names
      // the variable, so a marker symbol would be invisible in the output.)
      const padding = i % 7;
      const expectedLine = 3 + padding;
      fs.writeFileSync(
        appFile,
        [
          'import { add } from "./lib";',
          "",
          ...Array.from({ length: padding }, () => ""),
          `const total: string = add(1, ${i});`,
          "export const parsed = JSON.parse('{}');",
          "export const out = total;",
          "",
        ].join("\n"),
      );
      // Measure time-to-FRESH-result, re-querying until the response
      // reflects this revision. That is the latency NFR-PERF-6 is about:
      // how long until a warm server tells the truth about the current
      // buffer — not how fast it can replay a stale answer.
      const t0 = Date.now();
      let text = "";
      let fresh = false;
      let attempts = 0;
      while (Date.now() - t0 < WARM_FRESHNESS_TIMEOUT_MS) {
        attempts++;
        const warm = await client.call(
          "pilens_lsp_diagnostics",
          { path: appFile, cwd: work, severity: "all", serverScope: "primary" },
          60_000,
        );
        text = toolText(warm);
        if (extractReportedLines(text, TS2322_RENDERED).includes(expectedLine)) {
          fresh = true;
          break;
        }
      }
      warmSamples.push(Date.now() - t0);
      if (attempts > 1) warmStaleFirstResponse++;
      // Scoped to the diagnostic's rule/code rendering — pi-lens emits
      // `L3:7: error[typescript] (2322): …`. A bare /2322/ over the whole
      // blob would also match a byte offset or a line:column pair and
      // inflate the "substantive" count.
      if (TS2322_RENDERED.test(text)) warmSubstantive++;
      if (fresh) warmFreshlyAnalyzed++;
    }
    // Restore the canonical single-error revision so later checks (AC4)
    // assert against a known file state.
    fs.writeFileSync(appFile, appWithTypeError);
  }
  const harnessP95 = p95(warmSamples);
  const latencyLog = readLatencyLogSamples(work, runStartedMs);
  const logP95 = p95(latencyLog.samples);

  const staleIndexControlMet = newDiag !== undefined && postEditN !== baselineN;
  // p95 is asserted only with enough warm samples that actually returned the
  // diagnostic; short of that the check records "not measured" rather than
  // claiming compliance from empty-but-fast responses.
  const p95Measured =
    warmSamples.length >= WARM_SAMPLE_TARGET &&
    warmSubstantive >= WARM_VALID_SAMPLE_FLOOR &&
    warmFreshlyAnalyzed >= WARM_VALID_SAMPLE_FLOOR &&
    harnessP95 !== undefined;
  const p95Met = p95Measured && (harnessP95 as number) <= WARM_P95_BUDGET_MS;

  record({
    ac: "AC1",
    name: "diagnostics reflect the uncommitted edit (stale-index control) within the warm p95 budget",
    status: staleIndexControlMet && p95Met ? "pass" : "fail",
    reason: staleIndexControlMet
      ? p95Measured
        ? undefined
        : `warm p95 NOT measured: ${warmSamples.length}/${WARM_SAMPLE_TARGET} samples collected; ${warmSubstantive} rendered the injected TS2322 and ${warmFreshlyAnalyzed} carried their own iteration marker (proving a live re-analysis rather than a cached replay), against a floor of ${WARM_VALID_SAMPLE_FLOOR}${warmFirstNonEmptyObserved ? "" : "; no non-empty diagnostic response, so the WARM window never opened"}`
      : `stale-index control failed: baselineN=${baselineN}, postEditN=${postEditN}, TS2322 diagnostic ${newDiag ? "found" : "NOT found"} after the uncommitted edit`,
    evidence: {
      // The story's baselineN → postEditN negative control.
      baselineN,
      postEditN,
      countChanged: postEditN !== baselineN,
      newDiagnostic: newDiag
        ? { line: newDiag.line, column: newDiag.column, severity: newDiag.severity, tool: newDiag.tool, rule: newDiag.rule, message: newDiag.message }
        : undefined,
      editUncommitted,
      git: gitState,
      // NFR-PERF-6 / NFR-PERF-5.
      coldStartMs: coldMs,
      coldStartAdvisoryOnly: true,
      coldStartExceedsBudget: coldMs > WARM_P95_BUDGET_MS,
      warmDefinition: "after the server's first non-empty diagnostic response",
      warmSampleCount: warmSamples.length,
      warmSampleTarget: WARM_SAMPLE_TARGET,
      warmSamplesReportingTheError: warmSubstantive,
      warmSamplesFreshlyAnalyzed: warmFreshlyAnalyzed,
      warmSamplesWithStaleFirstResponse: warmStaleFirstResponse,
      warmSampleValidity:
        "each warm iteration moves the type error to a DISTINCT line, then re-queries until the reported line matches — so the sample measures time-to-FRESH-result, and a cached replay cannot be counted. `warmSamplesReportingTheError` additionally rules out fast-and-empty responses.",
      staleResponseFinding:
        warmStaleFirstResponse > 0
          ? `OBSERVED: ${warmStaleFirstResponse}/${WARM_SAMPLE_TARGET} warm samples returned a STALE diagnostic (the previous revision's line) on the first query after an edit, and needed a re-query to catch up. Diagnostics do reflect uncommitted edits (AC1's core claim holds — see the baselineN→postEditN control), but not necessarily on the first query following a rapid successive edit. Recorded because a single-query harness would have silently reported the stale answer as current.`
          : "no stale first-response observed this run",
      warmSamplesMs: warmSamples,
      warmP95Ms: harnessP95,
      warmP95BudgetMs: WARM_P95_BUDGET_MS,
      warmP95Source: "harness wall-clock around each pilens_lsp_diagnostics call",
      warmP95Met: p95Met,
      latencyLogPath: latencyLog.path,
      latencyLogSampleCount: latencyLog.samples.length,
      latencyLogP95Ms: logP95,
      latencyLogNote:
        "cross-check only; ~/.pi-lens/latency.log records pi-lens's INTERNAL lsp-runner durationMs, which excludes MCP transport overhead the harness wall-clock includes",
      // C1: which surface actually yielded the structured findings array.
      structuredSurface: postEdit.sourceKey ? "pilens_analyze" : "(no structured array observed)",
      structuredSourceKey: postEdit.sourceKey,
      lspDiagnosticsSurfaceText: coldText.slice(0, 300),
    },
  });
}

async function ac2(ctx: LspVerifyCtx): Promise<void> {
  const { client, work, appFile, libFile } = ctx;
  // --- AC2: go-to-definition resolves cross-file --------------------------
  // Origin is the IMPORT binding on line 1 (`import { add } from "./lib"`),
  // whose definition lives in lib.ts line 1 — a genuine cross-FILE hop.
  // Navigating from the *usage* on line 3 instead resolves to the import
  // binding inside app.ts, which is correct TypeScript behavior but only a
  // same-file hop, so it would not exercise this AC.
  // pi-lens's navigation input is 1-BASED (dist/tools/lsp-navigation.js).
  const defResult = await client.call(
    "pilens_lsp_navigation",
    { operation: "definition", path: appFile, line: 1, symbol: "add", cwd: work },
    60_000,
  );
  const defJson = parseToolJson(defResult);
  const defLocs = flagExternal(navLocations(defJson), work);
  // Symlink-resolved compare, for the same macOS /var → /private/var reason
  // canonicalize() exists: a raw path compare would miss a correct hit.
  const libFileCanonical = canonicalize(libFile);
  const libHit = defLocs.find(
    (l) => typeof l.filePath === "string" && canonicalize(l.filePath) === libFileCanonical,
  );
  // Native LSP wire shape, returned alongside the normalized envelope.
  const defNative = Array.isArray(defJson?.result)
    ? (defJson.result as Array<Record<string, unknown>>)
    : [];

  record({
    ac: "AC2",
    name: "lsp_navigation go-to-definition resolves a cross-file symbol to the correct location",
    status: libHit ? "pass" : "fail",
    reason: libHit
      ? undefined
      : `definition did not resolve to lib.ts (${defLocs.length} location(s) returned)`,
    evidence: {
      request: { operation: "definition", path: "app.ts", line: 1, symbol: "add", indexBase: "1-based (pi-lens input contract)" },
      resultCount: defJson?.resultCount,
      ok: defJson?.ok,
      status: defJson?.status,
      locations: defLocs,
      resolvedTo: libHit
        ? { filePath: libHit.filePath, range: libHit.range, external: libHit.external }
        : undefined,
      // C2: the OBSERVED wire shape, recorded rather than assumed. BOTH
      // shapes are present in one envelope — the story's asserted native
      // 0-indexed Location[] IS available, under `result`.
      observedLocationShape:
        "pi-lens envelope { tool, operation, ok, status, filePath, resultCount, result, locations[], notes?, hints?, errors?, metadata }",
      nativeWireShape:
        "`result` = native LSP Location[] — { uri, range: { start: { line, character }, end } }, 0-INDEXED, exactly the story's C2 contract",
      normalizedShape:
        "`locations` = pi-lens presentation layer — { uri, filePath, range }, 1-INDEXED (lsp-structured-output.js adds +1)",
      nativeResultSample: defNative[0],
      normalizedSample: defLocs[0],
      indexBaseDelta:
        defNative[0] && defLocs[0]
          ? "same location reported twice: `result` 0-indexed, `locations` 1-indexed — off-by-one between them is BY DESIGN, not a bug"
          : undefined,
    },
  });
}

async function ac2b(ctx: LspVerifyCtx): Promise<void> {
  const { client, work, appFile } = ctx;
  // --- AC2b: external definition surfaces explicitly ----------------------
  // `JSON.parse` on line 4 resolves into TypeScript's bundled lib.*.d.ts,
  // which lives OUTSIDE the worktree root.
  const extResult = await client.call(
    "pilens_lsp_navigation",
    { operation: "definition", path: appFile, line: 4, symbol: "parse", cwd: work },
    60_000,
  );
  const extJson = parseToolJson(extResult);
  const extLocs = flagExternal(navLocations(extJson), work);
  const externalHit = extLocs.find((l) => l.external === true);

  record({
    ac: "AC2b",
    name: "external definition returns real locations flagged external:true (never coerced to empty)",
    status: extLocs.length > 0 && externalHit ? "pass" : extLocs.length === 0 ? "fail" : "fail",
    reason:
      extLocs.length === 0
        ? "no locations returned for an external definition — the surface coerced to empty instead of returning the real out-of-worktree Location[]"
        : externalHit
          ? undefined
          : "locations returned but none resolved outside the worktree root; the external path was not exercised",
    evidence: {
      request: { operation: "definition", path: "app.ts", line: 4, symbol: "parse" },
      locationCount: extLocs.length,
      locations: extLocs,
      externalFlagProvenance:
        "HARNESS-layer URI-prefix check against the worktree root — NOT a native LSP field and NOT emitted by pi-lens",
      worktreeRoot: work,
      coercedToEmpty: extLocs.length === 0,
    },
  });
}

async function ac3(ctx: LspVerifyCtx): Promise<void> {
  const { client, work, unsupportedFile } = ctx;
  // --- AC3: graceful degradation for an unsupported language --------------
  const degradedResult = await client.call(
    "pilens_lsp_diagnostics",
    { path: unsupportedFile, cwd: work, severity: "all" },
    60_000,
  );
  const degradedText = toolText(degradedResult);
  const degradedJson = parseToolJson(degradedResult);
  // A warning in the RESPONSE PAYLOAD: any explicit no-server/unsupported
  // signal, rather than a crash or a silent empty pass.
  const payloadWarned =
    /no (lsp |language )?server|unsupported|not supported|no diagnostics available|skipped/i.test(degradedText) ||
    degradedJson?.status === "unsupported";
  const noCrash = degradedResult.isError !== true;
  // The on-disk half: recorded as observed-or-not, never assumed.
  const projectDir = projectDataDir(work);
  const artifactDirExists = fs.existsSync(projectDir);
  const artifactFiles = artifactDirExists
    ? (() => {
        try {
          return fs.readdirSync(projectDir);
        } catch {
          return [];
        }
      })()
    : [];
  // Actually READ the artifacts for the degradation signal. A previous
  // revision reported `artifactWarningObserved: artifactFiles.length > 0`,
  // which asserted only that unrelated bookkeeping files existed — the
  // field name claimed far more than the check did.
  const artifactScan = scanArtifactsForSignal(projectDir, [path.basename(unsupportedFile), "no LSP server", "unavailable"]);

  record({
    ac: "AC3",
    name: "unsupported-language file degrades gracefully (payload warning, no crash, no hang)",
    status: noCrash && payloadWarned ? "pass" : "fail",
    reason: noCrash
      ? payloadWarned
        ? undefined
        : "no explicit no-server/unsupported warning found in the response payload"
      : "the tool call returned an error result instead of degrading gracefully",
    evidence: {
      file: path.basename(unsupportedFile),
      noCrash,
      payloadWarned,
      responseExcerpt: degradedText.slice(0, 400),
      // Artifact assertion: recorded as observed, not assumed. pi-lens uses a
      // per-project dir (~/.pi-lens/projects/<slug>/), contained here via
      // PILENS_DATA_DIR — the flat ~/.pi-lens/cache/ the spec names does not exist.
      projectArtifactDir: projectDir,
      projectArtifactDirExists: artifactDirExists,
      projectArtifactFiles: artifactFiles,
      // Honest split: the payload half is asserted (and gates this check);
      // the artifact half is REPORTED as observed-or-not. AC3 says "the
      // harness asserts both", so when the signal is absent from the
      // artifacts that shortfall is stated here rather than glossed.
      artifactSignalObserved: artifactScan.found,
      artifactSignalMatches: artifactScan.matches,
      artifactFilesScanned: artifactScan.scanned,
      artifactAssertionStatus: artifactScan.found
        ? "asserted — the degradation signal was located in the on-disk artifacts"
        : "NOT asserted — pi-lens wrote no degradation signal into the project artifacts this run; only the payload half of AC3 is proven, and this check does not claim otherwise",
    },
  });
}

async function ac3a(ctx: LspVerifyCtx): Promise<void> {
  const { client, work, libFile, pl } = ctx;
  // --- AC3a: bounded initialize (harness deadline invariant) --------------
  const initProbe = await probeInitTimeout(work, LSP_INIT_TIMEOUT_S * 1_000);
  const boundedWithinTolerance = initProbe.elapsedMs <= LSP_INIT_TIMEOUT_S * 1_000 + 5_000;

  record({
    ac: "AC3a",
    name: "harness RPC deadline fires on a server that never answers initialize (bounded, logged, graceful)",
    status: initProbe.timedOut && boundedWithinTolerance ? "pass" : "fail",
    storyLevelStatus: "partial",
    storyLevelNote:
      "AC3a as worded says `lsp_diagnostics` runs and the harness times out. What is proven is the harness's OWN McpClient.rpc deadline — the same code path every other check's tool calls use — firing against an accept-but-never-respond server. pi-lens's INTERNAL LSP-client init timeout is not exercised: driving it would require pi-lens to adopt the hang-server as its configured language server, which its PATH-based LSP_SERVERS resolution does not expose. The harness invariant (every RPC carries a deadline) is met; the pi-lens-internal half is open.",
    reason: initProbe.timedOut
      ? boundedWithinTolerance
        ? undefined
        : `deadline overshot: elapsed ${initProbe.elapsedMs}ms against a ${LSP_INIT_TIMEOUT_S * 1_000}ms budget`
      : "the hang-server probe did not time out — the deadline did not fire",
    evidence: {
      lspInitTimeoutS: LSP_INIT_TIMEOUT_S,
      timedOut: initProbe.timedOut,
      elapsedMs: initProbe.elapsedMs,
      logged: initProbe.logLine,
      gracefulPayload: initProbe.payload,
      scope:
        "proves the HARNESS invariant (every RPC carries a deadline) against a purpose-built accept-but-never-respond fixture; it does NOT exercise pi-lens's internal LSP client timeout",
      framing:
        "newline-framed JSON-RPC 2.0 written to the fixture's stdin — the same McpClient transport every other check uses (NOT LSP Content-Length framing)",
    },
  });

  // --- DoD: mandatory `--mode json` agent e2e demo (LLM-auth-gated) -------
  // The story requires this to be "explicitly recorded as deferred-or-met
  // (mirrors P0.5 §7)". P0.5 found `--mode json` emits the session
  // handshake on stdout with no TUI, then dies at LLM auth before any tool
  // runs. Probe the same thing so the status is OBSERVED here, not
  // inherited on faith — and record it as an optional skip when auth is
  // unavailable rather than pretending the demo ran.
  const agentProbe = await probeAgentModeJson(work, path.join(pl.root, "dist", "index.js"), libFile);
  const e2eMet = agentProbe.toolPayloadObserved && agentProbe.errorReflected && agentProbe.definitionResolved;
  record({
    ac: "DoD-e2e",
    name: "MANDATORY `--mode json` Pi-agent e2e demo: lsp_diagnostics reflects the uncommitted error, lsp_navigation resolves the definition",
    status: e2eMet ? "pass" : "skip",
    // Optional ONLY in the sense that it is environment-gated (LLM auth):
    // when auth is unavailable the run degrades to a recorded deferral
    // rather than a red build, exactly as P0.5 did.
    optional: true,
    reason: e2eMet
      ? undefined
      : `DEFERRED, not met: ${agentProbe.reason}. Headless machine-readable emission with no TUI is confirmed (session handshake observed: ${agentProbe.handshakeObserved}). Every other claim in this run was validated over the pi-lens MCP stdio transport — the same engine the agent's tools call, but a different transport, and not a substitute for this demo.`,
    evidence: {
      piBinaryFound: agentProbe.piFound,
      piVersion: agentProbe.piVersion,
      command: agentProbe.command,
      extensionLoaded: path.join(pl.root, "dist", "index.js"),
      handshakeObserved: agentProbe.handshakeObserved,
      agentToolNames: agentProbe.agentToolNames,
      attempts: agentProbe.attempts,
      attemptPolicy: `up to ${AGENT_PROBE_ATTEMPTS} attempts — the agent's tool choice is sampled, so one turn that stops after activation is not evidence the capability is absent`,
      // The AGENT-facing tool names are `lsp_diagnostics` / `lsp_navigation`
      // — the story's wording. The `pilens_`-prefixed names are the MCP
      // server's surface for the same engine.
      toolNamingNote:
        "agent-facing extension tools are named `lsp_diagnostics` / `lsp_navigation`; the MCP server exposes the same engine as `pilens_lsp_diagnostics` / `pilens_lsp_navigation`",
      errorReflected: agentProbe.errorReflected,
      definitionResolved: agentProbe.definitionResolved,
      definitionResolvedCrossFile: agentProbe.definitionResolvedCrossFile,
      definitionScopeNote: agentProbe.definitionResolvedCrossFile
        ? "the agent navigated from the import binding, resolving ACROSS files to lib.ts"
        : "the agent navigated from the usage, whose correct TypeScript answer is the import binding in app.ts — a same-file hop. The cross-file hop is proven independently by AC2 over the MCP transport.",
      diagnosticsToolResult: agentProbe.diagnosticsToolCall?.result,
      navigationToolArgs: agentProbe.navigationToolCall?.args,
      navigationToolText: agentProbe.navigationToolCall?.result?.content?.map((c) => c.text ?? "").join("\n")?.slice(0, 600),
      exitCode: agentProbe.exitCode,
      stdoutExcerpt: agentProbe.stdoutExcerpt,
      stderrExcerpt: agentProbe.stderrExcerpt,
      contractPathNote:
        "this exercises the `tool_execution_end` → structured `details` path that P0.5 could NOT reach (its host had no working LLM auth); P0.5 recorded the equivalent DoD item as NOT met",
      precedent: "mirrors P0.5 report §2 and §7 DoD item 9",
    },
  });
}

async function ac4(ctx: LspVerifyCtx): Promise<void> {
  const { client, work, appFile, libFile } = ctx;
  // --- AC4: batch diagnostics, per-file keyed, partial on per-file failure -
  const missingFile = path.join(work, "does-not-exist.ts");
  const batchResult = await client.call(
    "pilens_lsp_diagnostics",
    { paths: [appFile, libFile, missingFile], cwd: work, severity: "all" },
    120_000,
  );
  const batchText = toolText(batchResult);
  const batchJson = parseToolJson(batchResult);
  // 3.8.71's batch surface is TEXT ONLY — no JSON envelope. Prefer a
  // structured envelope if a future version emits one, else derive the
  // per-file keying from the text (recorded as derived, not read).
  const structuredByFile = extractBatchByFile(batchJson);
  const parsedBatch = parseBatchDiagnosticsText(batchText);
  const byFile: Record<string, unknown> = structuredByFile ?? parsedBatch.byFile;
  const keyingProvenance = structuredByFile ? "structured `files[]` envelope" : "DERIVED by the harness from the text surface";

  const appEntry = byFile[appFile] as { diagnostics?: unknown[] } | undefined;
  const missingEntry = byFile[missingFile] as { error?: string } | undefined;
  const perFileKeyed = appEntry !== undefined;
  // PARTIAL, not atomic: the good file still reports findings even though a
  // sibling path in the same batch could not be read.
  const goodFileStillReported = Array.isArray(appEntry?.diagnostics) && appEntry.diagnostics.length > 0;
  const failingFileReportedItsFailure = typeof missingEntry?.error === "string" && missingEntry.error.length > 0;

  record({
    ac: "AC4",
    name: "batch diagnostics return per-file results and stay PARTIAL when one file fails",
    status: perFileKeyed && goodFileStillReported && failingFileReportedItsFailure ? "pass" : "fail",
    storyLevelStatus: "partial",
    storyLevelNote:
      "AC4 as worded requires SEQUENTIAL per-file `textDocument/diagnostic` RPCs. pi-lens instead exposes `paths` with a `concurrency` bound over DISTINCT server groups, processing files that share one server one-at-a-time against it. The AC's INTENT — per-file keying with partial results on per-file failure — is met and proven live; the literal sequencing requirement is not the tool's contract. Recorded as a spec-vs-impl gap rather than redefined as satisfied.",
    reason: !perFileKeyed
      ? "the batch response could not be keyed per file"
      : !failingFileReportedItsFailure
        ? "the unreadable path did not report its own failure — a per-file failure must surface, not vanish"
        : goodFileStillReported
          ? undefined
          : "the healthy file returned no findings alongside the failing one — the batch behaved atomically, not partially",
    evidence: {
      requestedPaths: [path.basename(appFile), path.basename(libFile), path.basename(missingFile)],
      perFileKeyed,
      keyingProvenance,
      fileKeys: Object.keys(byFile),
      filesChecked: parsedBatch.filesChecked,
      totalDiagnostics: parsedBatch.totalDiagnostics,
      healthyFileDiagnosticCount: Array.isArray(appEntry?.diagnostics) ? appEntry.diagnostics.length : undefined,
      healthyFileDiagnostics: appEntry?.diagnostics,
      missingFileEntry: missingEntry,
      failingFileReportedItsFailure,
      partialNotAtomic: goodFileStillReported && failingFileReportedItsFailure,
      // Spec-vs-impl: the story says SEQUENTIAL per-file RPCs. pi-lens's
      // actual contract is bounded concurrency ACROSS servers, with files
      // sharing one server processed one at a time against that server.
      observedBatchContract:
        "pilens_lsp_diagnostics accepts `paths` with `concurrency` bounding DISTINCT LSP server groups run in parallel; files sharing one server are processed one at a time against it (dist/tools/lsp-diagnostics.js). Same-language batches are therefore sequential per server, which satisfies the story's intent, but the tool is not literally one-RPC-per-file-in-series.",
      responseExcerpt: batchText.slice(0, 300),
    },
  });
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const strict = process.argv.includes("--strict") || !!process.env.CI;
  const repoRoot = path.resolve(import.meta.dir, "..");
  const pl = resolvePiLens(repoRoot);
  if (compareVersions(pl.version, MIN_PI_LENS_VERSION) < 0) {
    notes.push(
      `pi-lens ${pl.version} is below the story's ${MIN_PI_LENS_VERSION} floor (non-fatal; results tagged with the installed version)`,
    );
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-verify-"));
  // Contain ALL project-scoped pi-lens state inside the work dir.
  const pilensDataDir = path.join(work, ".pilens-data");
  process.env.PILENS_DATA_DIR = pilensDataDir;

  // Everything past this point runs inside the cleanup try — fixture creation
  // included. An earlier revision started the try only at the MCP-client spawn,
  // so a throw during fixture setup (ENOSPC on a write, say) leaked the temp
  // dir entirely.
  try {

  // --- fixture worktree ------------------------------------------------------
  // A minimal but REAL TypeScript project: pi-lens resolves the TS server from
  // the worktree, so the fixture needs a tsconfig for the server to index it.
  const libFile = path.join(work, "lib.ts");
  const appFile = path.join(work, "app.ts");
  const unsupportedFile = path.join(work, "fixture.zzlang");
  fs.writeFileSync(
    path.join(work, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true } },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    libFile,
    ["export function add(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"),
  );
  // Baseline app.ts is CLEAN — the type error is introduced later, uncommitted,
  // so the baselineN → postEditN delta is a real stale-index negative control.
  const appClean = [
    'import { add } from "./lib";',
    "",
    "const total = add(1, 2);",
    "export const parsed = JSON.parse('{}');",
    "export const out = total;",
    "",
  ].join("\n");
  const appWithTypeError = [
    'import { add } from "./lib";',
    "",
    "const total: string = add(1, 2);",
    "export const parsed = JSON.parse('{}');",
    "export const out = total;",
    "",
  ].join("\n");
  fs.writeFileSync(appFile, appClean);
  fs.writeFileSync(unsupportedFile, "this file is in a language with no LSP server on PATH\n");

  // git init + commit the CLEAN state so the later edit is genuinely
  // uncommitted — the whole point of AC1's stale-index control.
  const gitState = { available: false, initOk: false, committedOk: false };
  const git = (args: string[]): boolean => {
    try {
      execFileSync("git", ["-C", work, ...args], {
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "lsp-verify", GIT_AUTHOR_EMAIL: "lsp-verify@local", GIT_COMMITTER_NAME: "lsp-verify", GIT_COMMITTER_EMAIL: "lsp-verify@local" },
      });
      return true;
    } catch {
      return false;
    }
  };
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    gitState.available = true;
  } catch {
    notes.push("git not available on PATH — the fixture cannot be committed; the AC1 edit is still uncommitted-by-construction");
  }
  gitState.initOk = gitState.available && git(["init", "-q"]);
  gitState.committedOk =
    gitState.initOk && git(["add", "-A"]) && git(["commit", "-q", "-m", "baseline (clean)", "--no-gpg-sign"]);

  const runStartedMs = Date.now();
  const clientEnv = { ...process.env, PILENS_DATA_DIR: pilensDataDir };
  {
    const client = new McpClient(pl.server, work, clientEnv);
    try {
      await client.init(LSP_INIT_TIMEOUT_S * 1_000);

      const ctx: LspVerifyCtx = {
        client,
        work,
        appFile,
        libFile,
        unsupportedFile,
        appWithTypeError,
        gitState,
        runStartedMs,
        git,
        pl,
      };
      await ac1(ctx);
      await ac2(ctx);
      await ac2b(ctx);
      await ac3(ctx);
      await ac3a(ctx);
      await ac4(ctx);
    } catch (err) {
      // A rejected call must not escape to main().catch (exit 2, no
      // machine-readable output): record a synthetic failed check so the JSON
      // summary still emits with the failure counted (exit 1).
      record({
        ac: "AC?",
        name: "unexpected probe failure during AC execution",
        status: "fail",
        reason: err instanceof Error ? err.message : String(err),
        evidence: { stack: err instanceof Error ? err.stack : undefined },
      });
    } finally {
      client.close();
    }
  }
  } finally {
    // `pilensDataDir` is always inside `work`, and projectDataDir()'s slug
    // generator strips every character outside [A-Za-z0-9-] (so it can produce
    // neither `..` nor a separator). Removing `work` therefore already removes
    // all pi-lens project state — a second rmSync on the resolved project dir
    // would be provably dead code, so it is not attempted.
    if (!keep) {
      // Degrade a cleanup failure to a note. pi-lens grandchildren may still be
      // writing into `work` at teardown, and an EBUSY/ENOTEMPTY race here would
      // otherwise escape main() → exit 2, discarding checks that already passed.
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch (err) {
        notes.push(
          `temp dir cleanup failed for ${work}: ${err instanceof Error ? err.message : String(err)} — remove it manually`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  const pass = checks.filter((c) => c.status === "pass").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const skip = checks.filter((c) => c.status === "skip").length;
  const nonOptionalSkip = checks.filter((c) => c.status === "skip" && !c.optional).length;
  const summary = {
    piLensVersion: pl.version,
    piLensRoot: pl.root,
    piLensSource: pl.source,
    piLensVersionFloor: MIN_PI_LENS_VERSION,
    belowVersionFloor: compareVersions(pl.version, MIN_PI_LENS_VERSION) < 0,
    lspInitTimeoutS: LSP_INIT_TIMEOUT_S,
    warmP95BudgetMs: WARM_P95_BUDGET_MS,
    strict,
    pass,
    fail,
    skip,
    optionalSkip: skip - nonOptionalSkip,
    notes,
  };
  process.stdout.write(`${JSON.stringify({ results: checks, summary }, null, 2)}\n`);
  // exitCode (not process.exit) so a backpressured stdout pipe drains first.
  process.exitCode = fail > 0 || (strict && nonOptionalSkip > 0) ? 1 : 0;
}

// Guarded so tests can import resolvePiLens without self-executing main().
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`lsp-verify fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  });
}
