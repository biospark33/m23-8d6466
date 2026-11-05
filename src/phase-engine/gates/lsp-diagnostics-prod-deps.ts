/**
 * P1.7 — production deps for the lsp_diagnostics gate.
 *
 * The gate module owns the ladder; this module owns the real collaborators:
 * the pi-lens MCP stdio client (resolved through PI_LENS_ROOT / repo-local /
 * global probe — never a PATH probe for the LSP itself), the declared timeout
 * classification (init 15 s before handshake, rpc 30 s ceiling after), the
 * ast-grep PATH probe (PATH *is* the right test there — not pi-lens-managed),
 * and the best-effort Hindsight waiver retain into `{repo}-dev-meta`.
 */
import { join } from "node:path";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { McpClient } from "../../../scripts/lib/mcp-stdio-client.ts";
import { resolvePiLens } from "../../../scripts/lib/pi-lens-harness.ts";
import { HindsightClient } from "../../hindsight/index.ts";
import { resolveProvisionedRepoBankId } from "../../hindsight/bank-provisioner.ts";
import type {
  DiagnosticEntry,
  LspGateDeps,
  WaiverEvent,
} from "./lsp-diagnostics-gate.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const INIT_TIMEOUT_MS = 15_000; // P0.6's LSP_INIT_TIMEOUT_S = 15 s
const RPC_CEILING_MS = 30_000; // per-file backstop (story table)
const TEST_SUITE_CEILING_MS = 120_000; // bounded test-pass fallback

function whichAsync(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", [bin], (err, stdout) => resolve(err || !stdout ? null : stdout.trim() || null)); // dp:ok empty which output means not-found — null is the availability verdict, not a blanked value
  });
}

/**
 * Production LspGateDeps. Throws loudly when pi-lens cannot be resolved — the
 * gate's own ladder treats an unavailable tool as the AC3 degradation path via
 * the deps' classification, but a resolve failure HERE is an operator-facing
 * configuration error, not a per-file language gap.
 */
export async function createProdLspGateDeps(
  repoSlug: string,
  /** The run root whose files changed — the pi-lens server cwd, the test-suite
   *  target, and the workspace the ast-grep scan runs in (INV-3's pinned root). */
  targetRoot: string,
): Promise<LspGateDeps> { // dp:ok a resolve/handshake throw is operator-facing and propagates; the Gate adapter's gatedBody catch fails the emit closed
  const install = resolvePiLens(REPO_ROOT);
  let client: McpClient | null = null;
  async function ensureClient(): Promise<McpClient> { // dp:ok same propagation posture
    if (client === null) {
      // Assign ONLY after a successful handshake — a failed init must not
      // memoize a poisoned client that later calls would RPC uninitialized.
      const c = new McpClient(install.server, targetRoot, process.env); // the server cwd is the run's pinned root (INV-3), not the factory checkout
      await c.init(INIT_TIMEOUT_MS);
      client = c;
    }
    return client;
  }
  return {
    async callLspDiagnostics(paths) {
      // Init failures classify as "init" (AC3a → the no-lsp fallback route),
      // RPC failures as "rpc" (the story table's blocked lsp-timeout). The
      // two phases are separated so each maps to its declared outcome.
      let c: McpClient;
      try {
        c = await ensureClient();
      } catch {
        return { text: "", timedOut: "init" };
      }
      try {
        const res = await c.call("pilens_lsp_diagnostics", { paths }, RPC_CEILING_MS);
        const text = (res.content ?? []).map((x) => x.text ?? "").join("\n"); // dp:ok missing text block folds to "" — the tool's text is the only payload and the parser tolerates empty
        return { text, timedOut: null };
      } catch {
        return { text: "", timedOut: "rpc" };
      }
    },
    astGrepAvailable: async () => (await whichAsync("ast-grep")) !== null,
    astGrepScan: async (files) => { // dp:ok every failure resolves [] (clean) — the ast-grep arm is advisory inside an already-degraded fallback
      const bin = await whichAsync("ast-grep");
      if (bin === null) return [];
      // argv hardening: `--` ends flag parsing; dash-leading entries are
      // rejected (a path starting with "-" could smuggle ast-grep flags). The
      // full degraded set goes in (≤ MAX_CHANGED_FILES upstream); slicing it
      // here would silently leave files unevaluated — fail-open.
      const safe = files.filter((f) => !f.startsWith("-"));
      if (safe.length === 0) return [];
      return new Promise((resolve) => {
        execFile(bin, ["scan", "json", "--", ...safe], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            resolve([]);
            return;
          }
          try {
            const parsed: DiagnosticEntry[] = JSON.parse(stdout).map(
              (h: { file?: string }) => ({
                file: typeof h.file === "string" ? h.file : "",
                line: 0,
                severity: "error",
                message: "ast-grep finding",
                source: "ast-grep",
              }),
            );
            resolve(parsed);
          } catch {
            resolve([]);
          }
        });
      });
    },
    // Test-pass fallback, REALLY wired: presence = a test script in
    // package.json or a non-empty conventional test dir; the runner is
    // `bun test` with a bounded ceiling in the TARGET root (the run's
    // changed-file project, not this factory repo).
    hasTestSuite: async () => {
      try {
        const pkg = JSON.parse(await fs.readFile(join(targetRoot, "package.json"), "utf8")) as {
          scripts?: { test?: unknown };
        };
        if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim() !== "") return true;
      } catch {
        /* no package.json — fall through to the dir probe */
      }
      for (const dir of ["test", "tests", "spec"]) {
        try {
          const entries = await fs.readdir(join(targetRoot, dir));
          if (entries.some((e) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(e))) return true;
        } catch {
          /* dir absent */
        }
      }
      return false;
    },
    runTestSuite: async () => { // dp:ok bun test's exit code is the verdict; execFile's timeout reject maps to non-zero = the fail-closed block
      // bun test exit code is the verdict: 0 = all green. Bounded by
      // TEST_SUITE_CEILING_MS (execFile timeout kills the child on overrun;
      // the reject path maps to a non-zero code = fail-closed block).
      return await new Promise<boolean>((resolve) => {
        execFile("bun", ["test"], { cwd: targetRoot, timeout: TEST_SUITE_CEILING_MS, maxBuffer: 16 * 1024 * 1024 }, (err) => {
          if (!err) return resolve(true);
          resolve(false); // non-zero exit OR spawn failure OR timeout — all block
        });
      });
    },
    retainWaiverEvent: async (event: WaiverEvent) => { // dp:ok best-effort by contract — persistBestEffort wraps this; a throw never flips the verdict (INV-DIAG-3)
      // Best-effort, env-gated (retain-best-effort posture): no configured
      // memory means no row and no gate change.
      if (process.env.HINDSIGHT_BASE_URL === undefined || process.env.HINDSIGHT_BASE_URL.trim() === "") return;
      const client = new HindsightClient();
      const banks = await client.listBanks();
      const bankId = resolveProvisionedRepoBankId(repoSlug, new Set(extractIds(banks)));
      if (bankId === null) return;
      await client.retain(
        `${bankId}-dev-meta` === bankId ? bankId : `${bankId}-dev-meta`,
        JSON.stringify({ kind: "waiver", ...event, timestamp: new Date().toISOString() }),
      );
      // dp:ok bank pair resolution mirrors retain-best-effort's family signature;
      // the -dev-meta sibling is where M3.1's family gates route meta rows.
    },
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

function extractIds(banks: unknown): string[] {
  const list = (banks as { banks?: Array<{ bank_id?: unknown }> } | undefined)?.banks ?? [];
  return list.map((b) => (typeof b.bank_id === "string" ? b.bank_id : "")).filter((s) => s !== "");
}
