#!/usr/bin/env bun
/**
 * pi-lens headless verification harness (Story P0.5).
 *
 * Proves pi-lens's machine-readable, non-interactive surfaces WITHOUT a live LLM:
 * it drives the pi-lens MCP server (`pi-lens-mcp`) over stdio and reads on-disk
 * artifacts directly. A full Pi *agent* turn needs LLM auth (unavailable in CI /
 * this shell), but the MCP server IS the same engine the agent's tools call, so
 * every tool path below is the real thing, just reached headlessly.
 *
 * Exercised (AC → check):
 *   AC1  lsp_diagnostics  — real LSP type error, structured JSON, stable aw:<hash> id.
 *        The error-severity fixture proves derived-id determinism + parity with
 *        pi-lens's OWN id function. A warning-severity pyright fixture +
 *        pilens_turn_end additionally PROBES for an id pi-lens actually assigned
 *        (read back from actionable-warnings.jsonl); evidence labels the id as
 *        "observed" or "derived+native-parity only" — never faked.
 *   AC2a secret-scan detection (live) — opengrep flags the synthetic hardcoded secret.
 *   AC2b emit-block (NFR-SEC-3) — EMPIRICAL probe: pilens_turn_end output is
 *        inspected for the '🔴 STOP — hardcoded secrets' blocker. Pass ONLY if
 *        observed; otherwise skip with the source-verified reason (gitleaks/trivy
 *        absent → opengrep-only findings stay advisory, never promoted to blockers).
 *   AC3  warning-count    — numeric count read from the on-disk project artifact
 *        (actionable-warnings.jsonl primary, cache/code-quality-warnings.json
 *        fallback with an explicit FR-EX-8 fallbackReason).
 *
 * Containment: the server is spawned with PILENS_DATA_DIR pointed INSIDE the temp
 * work dir (plus PI_LENS_CONFIG_PATH for a run-local config enabling the
 * actionable-warnings aggregator), so all PROJECT-SCOPED pi-lens on-disk state is
 * removed with the work dir — no ~/.pi-lens/projects/*pilens-verify* orphans.
 * One global exception: pi-lens's latency telemetry appends to
 * ~/.pi-lens/latency.log, keyed on PI_LENS_HOME (not PILENS_DATA_DIR — see
 * dist/clients/latency-logger.js → file-utils.js:getGlobalPiLensDir); the
 * harness intentionally leaves that log in place.
 *
 * Output: structured JSON results on stdout ({ results: Check[], summary }).
 * Exit 0 iff every non-skipped check passed (under --strict or CI, any skip of a
 * NON-optional check also exits non-zero).
 *
 * Flags: --json (accepted, output is always JSON), --keep (retain the temp dir;
 *        the synthetic-secret fixture is STILL scrubbed — overwritten then
 *        deleted — so no key-shaped strings persist), --strict (skips of
 *        non-optional checks fail the run; CI env implies --strict).
 *
 * Env:   PI_LENS_ROOT — explicit pi-lens install root, tried before the
 *        repo-local `node_modules/pi-lens` and the global probe (one resolver,
 *        one env contract, shared with `scripts/lsp-verify.ts`).
 *
 * Run:  bun scripts/pi-lens-verify.ts [--json] [--keep] [--strict]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Check, createChecklist } from "./lib/harness-notes.ts";
import { McpClient, parseToolJson } from "./lib/mcp-stdio-client.ts";
import {
  harnessNotes as notes,
  type PiLensInstall,
  projectDataDir,
  resolvePiLens as resolvePiLensAt,
} from "./lib/pi-lens-harness.ts";

/** pi-lens version the story pins. Drift is reported, never fatal. */
const SPEC_PI_LENS_VERSION = "3.8.47";


// ---------------------------------------------------------------------------
// pi-lens install resolution
// ---------------------------------------------------------------------------

/** This repo's root — the `node_modules/pi-lens` candidate the resolver probes. */
const REPO_ROOT = path.resolve(import.meta.dir, "..");

/**
 * Thin binding of `lib/pi-lens-harness.ts`'s resolver to this repo's root, so
 * this harness honours the SAME order as every other one: `PI_LENS_ROOT` →
 * repo-local → global. It previously called the global probe directly, which
 * ignored `PI_LENS_ROOT` and made the harness fatal on hosts where the
 * override was the only install (#55).
 *
 * Kept as a named export because `tests/pi-lens-verify.test.ts` imports it
 * from this module.
 */
export function resolvePiLens(): PiLensInstall {
  return resolvePiLensAt(REPO_ROOT);
}

// ---------------------------------------------------------------------------
// aw:<hash> id — pi-lens's stable finding id (dist/clients/actionable-warnings.js)
// Reproduced here so we can assert the structured LSP diagnostic maps to a stable
// id: aw: + first 10 hex of sha256(relFile|tool|source|code|rule|message|line).
// ---------------------------------------------------------------------------

function createActionableWarningId(args: {
  cwd: string;
  filePath: string;
  tool?: string;
  source?: string;
  code?: string | number;
  rule?: string;
  message: string;
  line?: number;
}): string {
  const rel = path.relative(args.cwd, args.filePath).replace(/\\/g, "/");
  const relOrAbs = rel && !rel.startsWith("..") ? rel : args.filePath;
  // pi-lens normalizes message (collapse whitespace, trim, lowercase) before
  // hashing — mirror it exactly (dist/clients/actionable-warnings.js).
  const normMessage = args.message.replace(/\s+/g, " ").trim().toLowerCase();
  const parts = [
    relOrAbs,
    args.tool ?? "",
    args.source ?? "",
    String(args.code ?? ""),
    args.rule ?? "",
    normMessage,
    String(args.line ?? ""),
  ];
  const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 10);
  return `aw:${hash}`;
}

/**
 * Import pi-lens's OWN createActionableWarningId from the installed package and
 * run it on the same args, so we can prove our local reproduction matches the
 * real contract. Returns undefined if the internal module can't be imported
 * (e.g. bundled differently in a future version) — the caller then falls back
 * to a shape-only assertion.
 */
async function deriveNativeId(
  root: string,
  args: Parameters<typeof createActionableWarningId>[0],
): Promise<string | undefined> {
  try {
    const mod = await import(
      path.join(root, "dist", "clients", "actionable-warnings.js")
    );
    const fn = mod.createActionableWarningId as typeof createActionableWarningId | undefined;
    return typeof fn === "function" ? fn(args) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * pi-lens's aw: aggregator is gated to warning severity + a code action, and the
 * per-turn history is NDJSON: <projectDataDir>/actionable-warnings.jsonl, one
 * line per warning, carrying the assigned id as `warningId`
 * (dist/clients/actionable-warnings.js:appendActionableWarningsHistory).
 */
function readActionableWarningsHistory(projectDir: string): {
  path: string;
  entries: Array<Record<string, unknown>>;
} {
  const p = path.join(projectDir, "actionable-warnings.jsonl");
  if (!fs.existsSync(p)) return { path: p, entries: [] };
  try {
    const entries = fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== undefined);
    return { path: p, entries };
  } catch {
    return { path: p, entries: [] };
  }
}

/**
 * Provenance-based secret-finding matcher (pi-lens families, not keyword soup):
 * an auxiliary opengrep diagnostic, or a rule/code from the known secret rule
 * families (Semgrep `*.secrets.*`, `hardcoded-secret`, `detected-...-key`).
 */
function isSecretDiagnostic(d: Record<string, unknown>): boolean {
  if (d.tool === "opengrep") return true;
  const ruleAndCode = `${d.rule ?? ""} ${d.code ?? ""}`;
  return /\.secrets\.|hardcoded-secret|detected-[\w-]+-key/i.test(ruleAndCode);
}

// ---------------------------------------------------------------------------
// Check plumbing
// ---------------------------------------------------------------------------

const { checks, record } = createChecklist<Check>();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const strict = process.argv.includes("--strict") || !!process.env.CI;
  const pl = resolvePiLens();
  if (pl.version !== SPEC_PI_LENS_VERSION) {
    notes.push(`pi-lens version drift: spec pins ${SPEC_PI_LENS_VERSION}, installed ${pl.version} (non-fatal)`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-verify-"));
  // Contain ALL pi-lens on-disk state inside the temp work dir: the server is
  // spawned with PILENS_DATA_DIR pointing here, and this process's env is set
  // too so projectDataDir() below resolves to the same contained location.
  const pilensDataDir = path.join(work, ".pilens-data");
  process.env.PILENS_DATA_DIR = pilensDataDir;
  // Run-local pi-lens config: enables the actionable-warnings aggregator (off by
  // default — lens-config.js resolvePiLensFlag) so turn-end actually assigns
  // aw: ids we can read back. PI_LENS_CONFIG_PATH keeps the user's global
  // ~/.pi-lens/config.json untouched.
  const pilensConfigPath = path.join(work, "pi-lens-config.json");
  fs.writeFileSync(
    pilensConfigPath,
    JSON.stringify({ actionableWarnings: { enabled: true, includeLspCodeActions: true } }),
  );

  const tsFile = path.join(work, "type-error.ts");
  const secretFile = path.join(work, "leak.ts");
  const warnFile = path.join(work, "unused-import.py");
  // pi-lens's opengrep secret detector scopes to the git working tree, so the
  // fixture dir must be a git repo with the files staged for secret rules to fire.
  // Record git availability/staging explicitly — the checks below surface it.
  const gitState = { available: false, initOk: false, stagedOk: false };
  const git = (args: string[]): boolean => {
    try {
      execFileSync("git", ["-C", work, ...args], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    gitState.available = true;
  } catch {
    notes.push("git not available on PATH — secret-scan fixture cannot be staged; AC2a will skip");
  }
  gitState.initOk = gitState.available && git(["init", "-q"]);

  // AC1 fixture: a genuine TS type error (error severity → structured LSP diag).
  fs.writeFileSync(
    tsFile,
    [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "const wrong: string = add(1, 2);",
      "export const out = wrong;",
      "",
    ].join("\n"),
  );

  // AC1 observed-id fixture: a WARNING-severity, fixable diagnostic — the only
  // kind pi-lens's aw: aggregator assigns ids to. TS has no warning-category
  // diagnostics at all, so use pyright (on PATH): reportUnusedImport=warning
  // yields LSP severity 2 for the unused import below.
  fs.writeFileSync(path.join(work, "pyrightconfig.json"), JSON.stringify({ reportUnusedImport: "warning" }));
  fs.writeFileSync(warnFile, ["import os", "", "def main() -> int:", "    return 1", ""].join("\n"));

  // AC2 fixture: obviously-synthetic hardcoded secrets (never a real credential).
  // Generated at runtime so no secret-shaped string is ever committed.
  const fakeAws = `AKIA${"A".repeat(16)}`; // synthetic AWS-key shape
  const fakeSk = `sk-${"a".repeat(40)}`; // synthetic OpenAI-key shape
  fs.writeFileSync(
    secretFile,
    [
      "// synthetic test pattern, not a real key",
      `const awsKey = "${fakeAws}";`,
      `const apiToken = "${fakeSk}";`,
      "export { awsKey, apiToken };",
      "",
    ].join("\n"),
  );

  // Stage fixtures so opengrep's secret ruleset (git-working-tree scoped) sees them.
  gitState.stagedOk = gitState.initOk && git(["add", "-A"]);

  const clientEnv = { ...process.env, PILENS_DATA_DIR: pilensDataDir, PI_LENS_CONFIG_PATH: pilensConfigPath };
  try {
    const client = new McpClient(pl.server, work, clientEnv, "p0-5-verify");
    try {
      await client.init();

      // --- AC1: lsp_diagnostics (pure LSP path) ------------------------------
      // Warm the LSP server, then run the per-edit dispatch (LSP + linters) which
      // returns the structured diagnostics array.
      await client.call("pilens_lsp_diagnostics", { path: tsFile, cwd: work, severity: "all" }, 60_000);
      const analyzeTs = await client.call("pilens_analyze", { file: tsFile, cwd: work }, 60_000);
      const tsJson = parseToolJson(analyzeTs);
      const tsDiags = (tsJson?.diagnostics as Array<Record<string, unknown>>) ?? [];
      const lspDiag = tsDiags.find((d) => d.tool === "lsp");

      // Warm + register the warning fixture (pilens_analyze registers the file
      // into turn-state, which pilens_turn_end's aw: aggregation consumes).
      // Bounded: a cold pyright start may lag — aggregation re-queries LSP at
      // turn-end anyway, so this only needs to register + warm, not to observe.
      // The result IS kept to document (in AC1 evidence) whether the fixture's
      // warning-severity diagnostic surfaced at all.
      const analyzeWarn = await client.call("pilens_analyze", { file: warnFile, cwd: work }, 90_000);
      const warnDiags = (parseToolJson(analyzeWarn)?.diagnostics as Array<Record<string, unknown>>) ?? [];
      const warnLspDiag = warnDiags.find((d) => d.tool === "lsp" && d.severity === "warning");

      // --- AC2a: secret-scan detection (live, opengrep) -----------------------
      // pi-lens's secret detector (opengrep) attaches as an AUXILIARY warm LSP
      // server to the dispatch LSP runner (dist/clients/dispatch/runners/lsp.js).
      // Its FIRST pass on a file is a cold ~8s start that can return before the
      // secret rules finish, so poll pilens_analyze until a secret surfaces (the
      // server is warm — ~1.3s — after the first pass). Bounded retry keeps the
      // check deterministic instead of racing opengrep's cold start.
      let secretDiags: Array<Record<string, unknown>> = [];
      let secretHit: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 4 && !secretHit; attempt++) {
        await client.call("pilens_lsp_diagnostics", { path: secretFile, cwd: work, severity: "all" }, 60_000);
        const analyzeSecret = await client.call("pilens_analyze", { file: secretFile, cwd: work }, 60_000);
        secretDiags = (parseToolJson(analyzeSecret)?.diagnostics as Array<Record<string, unknown>>) ?? [];
        secretHit = secretDiags.find(isSecretDiagnostic);
      }
      const onPath = (bin: string): boolean =>
        !!process.env.PATH?.split(":").some((p) => fs.existsSync(path.join(p, bin)));
      const gitleaksAvail = onPath("gitleaks");
      const trivyAvail = onPath("trivy");

      // --- Shared turn-end: drives aw: aggregation (AC1 observed-id probe),
      // the emit-block probe (AC2b), and the on-disk warning count (AC3). ----
      const turnEnd = await client.call("pilens_turn_end", { cwd: work, files: [tsFile, secretFile, warnFile] }, 90_000);
      const turnEndText = turnEnd.content?.map((c) => c.text ?? "").join("\n") ?? "";
      const projectDir = projectDataDir(work);
      const awHistory = readActionableWarningsHistory(projectDir);

      // AC1 observed-id probe: find an aw: id pi-lens ACTUALLY assigned to one
      // of our fixtures in its own NDJSON history, and check our independent
      // derivation from the entry's own fields equals it.
      const awEntry =
        awHistory.entries.find((e) => path.resolve(String(e.filePath ?? "")) === warnFile) ??
        awHistory.entries.find((e) => String(e.filePath ?? "").startsWith(work));
      const awDerived = awEntry
        ? createActionableWarningId({
            cwd: work,
            filePath: String(awEntry.filePath),
            tool: awEntry.tool as string | undefined,
            source: awEntry.source as string | undefined,
            code: awEntry.code as string | undefined,
            rule: awEntry.rule as string | undefined,
            message: String(awEntry.message ?? ""),
            line: awEntry.line as number | undefined,
          })
        : undefined;
      const idObserved = awEntry !== undefined && awDerived === awEntry.warningId;

      if (lspDiag && String(lspDiag.rule ?? "").length > 0) {
        // Derive the stable aw:<hash> id the actionable-warnings aggregator would
        // assign to this LSP diagnostic and prove it's deterministic (re-derive ==).
        const ruleStr = String(lspDiag.rule);
        const colonIdx = ruleStr.indexOf(":");
        const idArgs = {
          cwd: work,
          filePath: tsFile,
          tool: "lsp",
          source: "typescript",
          code: colonIdx >= 0 ? ruleStr.slice(colonIdx + 1) : undefined,
          message: String(lspDiag.message),
          line: Number(lspDiag.line),
        };
        const id1 = createActionableWarningId(idArgs);
        const id2 = createActionableWarningId(idArgs);
        // Parity: our reproduction must equal pi-lens's OWN id function for the
        // same inputs — otherwise "stable aw:<hash>" is only self-consistent, not
        // the real contract. Import the native function from the resolved package.
        const nativeId = await deriveNativeId(pl.root, idArgs);
        const shape = /^aw:[0-9a-f]{10}$/.test(id1);
        const parity = nativeId === undefined || nativeId === id1;
        record({
          ac: "AC1",
          name: "lsp_diagnostics structured output with stable aw:<hash> id",
          status: id1 === id2 && shape && parity ? "pass" : "fail",
          evidence: {
            diagnosticCount: tsDiags.length,
            lspStatus: (tsJson?.lsp as Record<string, unknown>)?.status,
            lspLatencyMs: (tsJson?.lsp as Record<string, unknown>)?.durationMs,
            diagnostic: {
              line: lspDiag.line,
              column: lspDiag.column,
              severity: lspDiag.severity,
              semantic: lspDiag.semantic,
              tool: lspDiag.tool,
              rule: lspDiag.rule,
              message: lspDiag.message,
            },
            stableId: id1,
            idProvenance: idObserved ? "observed" : "derived+native-parity",
            idReproducible: id1 === id2,
            nativeId: nativeId ?? "(pi-lens fn not importable — shape-only check)",
            matchesNative: parity,
            // Observed id: pi-lens's OWN assignment read back from
            // actionable-warnings.jsonl. Never faked — absent stays absent.
            idObserved,
            observedId: idObserved ? awEntry?.warningId : undefined,
            observedMatchesDerived: idObserved ? true : undefined,
            observedSource: idObserved ? awHistory.path : undefined,
            warningFixtureDiagnostic: warnLspDiag
              ? { rule: warnLspDiag.rule, severity: warnLspDiag.severity, fixable: warnLspDiag.fixable }
              : undefined,
            awHistoryEntries: awHistory.entries.length,
            idNotObservedReason: idObserved
              ? undefined
              : awEntry !== undefined
                ? `pi-lens assigned ${String(awEntry.warningId)} but our derivation from the entry fields gave ${awDerived} — id-input drift between pi-lens internals and this harness.`
                : warnLspDiag
                  ? `the warning fixture DID produce a severity-2 LSP diagnostic (${String(warnLspDiag.rule)}, fixable=${String(warnLspDiag.fixable)}), but pi-lens assigned no aw: id at turn-end (${awHistory.entries.length} entries): the aggregator (actionable-warnings.js) additionally requires an LSP CODE ACTION for the diagnostic, and this host's language servers provide none for it — OSS pyright ships no quick-fix for reportUnusedImport, and TypeScript has no warning-category diagnostics at all. Dispatch-path warnings (e.g. ruff) can't be observed either: the MCP pilens_analyze path never records them into the warm runtime (clients/mcp/analyze.js). Derived id + native-function parity remain the evidence.`
                  : `no warning-severity LSP diagnostic surfaced for the fixture this run and pi-lens assigned no aw: id (${awHistory.entries.length} entries). Derived id + native-function parity remain the evidence.`,
          },
        });
      } else {
        record({
          ac: "AC1",
          name: "lsp_diagnostics structured output with stable aw:<hash> id",
          status: "fail",
          reason: "no LSP-origin diagnostic returned",
          evidence: { rawSummary: analyzeTs.content?.[0]?.text?.slice(0, 300) },
        });
      }

      // --- AC2a: secret-scan detection (live) ---------------------------------
      if (secretHit) {
        record({
          ac: "AC2",
          name: "secret-scan detects hardcoded secret (live, opengrep)",
          status: "pass",
          evidence: {
            detectedBy: secretHit.tool, // opengrep (bundled Semgrep secret rules)
            rule: secretHit.rule,
            message: secretHit.message,
            line: secretHit.line,
            severity: secretHit.severity,
            matchedBy: "provenance (tool/rule family), not keyword regex",
            git: gitState,
            gitleaksOnPath: gitleaksAvail,
            trivyOnPath: trivyAvail,
            fixtureSecretsSynthetic: true,
          },
        });
      } else {
        // TODO(goal): provision git on the verification host so AC2a (this
        // skip branch) runs live instead. AC2b still skips without gitleaks/
        // trivy. Kept as a code comment, NOT in the `reason` string below —
        // that text is operator-facing and should say what happened and why,
        // not carry a developer work item.
        record({
          ac: "AC2",
          name: "secret-scan detects hardcoded secret (live, opengrep)",
          status: "skip",
          reason:
            `no secret finding surfaced for the synthetic fixture (git=${JSON.stringify(gitState)}, gitleaksOnPath=${gitleaksAvail}, trivyOnPath=${trivyAvail}). opengrep's secret ruleset scopes to the git working tree; without git init+staging the bundled scanner sees nothing.`,
          evidence: {
            scannedDiagnostics: secretDiags.length,
            git: gitState,
            gitleaksOnPath: gitleaksAvail,
            trivyOnPath: trivyAvail,
            fixtureSecretsSynthetic: true,
          },
        });
      }

      // --- AC2b: emit-block on NFR-SEC-3 (EMPIRICAL probe) ---------------------
      // runtime-turn.js pushes '🔴 STOP — hardcoded secrets detected' into
      // blockerParts ONLY from sessionSecrets — gitleaks + trivy findings.
      // Bundled opengrep (ast-grep) findings merely ENRICH a blocker whose
      // location already came from gitleaks/trivy; opengrep-only findings stay
      // advisory. So the block is observable here only when gitleaks/trivy ran.
      // Verify the mechanism in the INSTALLED source, then probe turn-end output.
      const runtimeTurnSrc = (() => {
        try {
          return fs.readFileSync(path.join(pl.root, "dist", "clients", "runtime-turn.js"), "utf8");
        } catch {
          return "";
        }
      })();
      const blockMechanismSourceVerified =
        runtimeTurnSrc.includes("🔴 STOP — hardcoded secrets detected") && runtimeTurnSrc.includes("sessionSecrets");
      const stopMatch = turnEndText.match(/🔴 STOP[^\n]*hardcoded secrets[^\n]*/i);
      const emitBlockObserved = stopMatch !== null;

      record({
        ac: "AC2",
        name: "secret-scan emit-block on NFR-SEC-3 (empirical pilens_turn_end probe)",
        status: secretHit && emitBlockObserved ? "pass" : "skip",
        optional: true, // depends on gitleaks/trivy being installed on the host
        reason: emitBlockObserved
          ? undefined
          : secretHit
            ? `emit-block NOT observed in turn-end output: gitleaks/trivy are not installed (gitleaksOnPath=${gitleaksAvail}, trivyOnPath=${trivyAvail}), and runtime-turn.js promotes ONLY gitleaks/trivy sessionSecrets to the '🔴 STOP' blocker — the opengrep detection above is advisory-tier and never blocks by itself. Block mechanism ${blockMechanismSourceVerified ? "verified" : "NOT found"} in installed source (dist/clients/runtime-turn.js).`
            : "secret detection did not fire (see AC2a), so the emit-block probe is not meaningful",
        evidence: {
          emitBlockObserved,
          blockerEvidence: stopMatch?.[0],
          detectionProvenLive: !!secretHit,
          turnEndExcerpt: turnEndText.slice(0, 300),
          gitleaksOnPath: gitleaksAvail,
          trivyOnPath: trivyAvail,
          blockMechanism:
            "runtime-turn.js: sessionSecrets (gitleaks+trivy ONLY) → blockerParts.push('🔴 STOP — hardcoded secrets detected'); opengrep findings enrich but never promote",
          blockMechanismSourceVerified,
        },
      });

      // --- AC3: warning-count from on-disk artifact (FR-EX-8) ------------------
      // pi-lens 3.8.x writes the aw: history as NDJSON at
      // <projectDataDir>/actionable-warnings.jsonl (one line per warning), NOT a
      // cache/actionable-warnings.json. Primary = derive the count from that
      // JSONL; fall back to the turn-delta cache/code-quality-warnings.json with
      // an explicit reason (FR-EX-8).
      const proxy = readWarningProxy(projectDir);
      record({
        ac: "AC3",
        name: "warning-count readable as numeric from on-disk pi-lens artifact (FR-EX-8)",
        status: proxy.count !== undefined ? "pass" : "fail",
        evidence: {
          projectDir,
          artifactRead: proxy.artifact,
          warningCount: proxy.count,
          fallbackReason: proxy.fallbackReason,
        },
        reason: proxy.count === undefined ? "no readable warning-count artifact on disk" : undefined,
      });
    } catch (err) {
      // A rejected client.call or any other probe failure must not escape to
      // main().catch (exit 2, no machine-readable output): record a synthetic
      // failed check so the JSON summary below still emits with the failure
      // counted (exit 1). client.close() still runs in the finally.
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
  } finally {
    if (keep) {
      // --keep hygiene: scrub the synthetic-secret fixture (overwrite, then
      // delete) so no key-shaped strings persist in the retained temp dir. The
      // work dir AND its pi-lens project data (incl. actionable-warnings.jsonl)
      // are kept — --keep exists to inspect them.
      try {
        fs.writeFileSync(secretFile, "// scrubbed by pi-lens-verify --keep\n");
        fs.rmSync(secretFile, { force: true });
      } catch {
        /* best-effort scrub */
      }
    } else {
      // Belt-and-suspenders: also remove pi-lens's project data dir for this
      // work dir even if something escaped the contained PILENS_DATA_DIR (it
      // normally lives inside `work`, so this is redundant with the removal).
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(projectDataDir(work), { recursive: true, force: true });
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
    piLensVersionSpec: SPEC_PI_LENS_VERSION,
    versionMismatch: pl.version !== SPEC_PI_LENS_VERSION,
    strict,
    pass,
    fail,
    skip,
    optionalSkip: skip - nonOptionalSkip,
    notes,
  };
  process.stdout.write(`${JSON.stringify({ results: checks, summary }, null, 2)}\n`);
  // Set exitCode (not process.exit) so a backpressured stdout pipe drains first.
  process.exitCode = fail > 0 || (strict && nonOptionalSkip > 0) ? 1 : 0;
}

/**
 * Warning-count reader (FR-EX-8): primary artifact is pi-lens's NDJSON history
 * <projectDataDir>/actionable-warnings.jsonl (one line per warning — count the
 * entries). Fallback is the turn-delta cache/code-quality-warnings.json with an
 * explicit fallbackReason, since headless TDI is a TUI-only slash-command with
 * no CLI flag.
 */
function readWarningProxy(projectDir: string): {
  count?: number;
  artifact?: string;
  fallbackReason?: string;
} {
  const history = readActionableWarningsHistory(projectDir);
  if (fs.existsSync(history.path) && history.entries.length > 0) {
    return { count: history.entries.length, artifact: history.path };
  }
  const fallback = path.join(projectDir, "cache", "code-quality-warnings.json");
  if (fs.existsSync(fallback)) {
    try {
      const data = JSON.parse(fs.readFileSync(fallback, "utf8"));
      const count = countFrom(data);
      if (count !== undefined) {
        const historyState = fs.existsSync(history.path) ? "has 0 entries" : "absent";
        return {
          count,
          artifact: fallback,
          fallbackReason: `actionable-warnings.jsonl ${historyState} (only appended when the aw: aggregator emits ≥1 warning at turn-end; headless TDI slash-command unavailable). Fell back to code-quality-warnings.json summary.warnings — the turn-delta warning-count proxy.`,
        };
      }
    } catch {
      /* fall through */
    }
  }
  return {
    fallbackReason: `no warning-count artifact found in ${projectDir} (checked actionable-warnings.jsonl, cache/code-quality-warnings.json)`,
  };
}

/** Extract a numeric warning count from the fallback artifact shape. */
function countFrom(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const summary = d.summary as Record<string, unknown> | undefined;
  if (summary && typeof summary.warnings === "number") return summary.warnings;
  if (typeof d.count === "number") return d.count;
  if (Array.isArray(d.warnings)) return d.warnings.length;
  return undefined;
}

// Guarded so tests can import resolvePiLens without self-executing main()
// (import.meta.main is Bun's entry-point check — true only when run directly).
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`pi-lens-verify fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  });
}
