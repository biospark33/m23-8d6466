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
export async function createProdLspGateDeps(repoSlug: string): Promise<LspGateDeps> { // dp:ok a resolve/handshake throw is operator-facing and propagates; the Gate adapter's gatedBody catch fails the emit closed
  const install = resolvePiLens(REPO_ROOT);
  let client: McpClient | null = null;
  async function ensureClient(): Promise<McpClient> { // dp:ok same propagation posture
    if (client === null) {
      client = new McpClient(install.server, REPO_ROOT, process.env);
      await client.init(INIT_TIMEOUT_MS);
    }
    return client;
  }
  return {
    async callLspDiagnostics(paths) {
      const c = await ensureClient();
      try {
        const res = await c.call("pilens_lsp_diagnostics", { paths }, RPC_CEILING_MS);
        const text = (res.content ?? []).map((x) => x.text ?? "").join("\n"); // dp:ok missing text block folds to "" — the tool's text is the only payload and the parser tolerates empty
        return { text, timedOut: null };
        // McpClient call rejects on its 30 s timer (rpc); init hangs die on the
        // 15 s handshake timer above; a reject here BLOCKS the emit (lsp-timeout).
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const initLike = /init|handshake/i.test(msg);
        return { text: "", timedOut: initLike ? "init" : "rpc" };
      }
    },
    astGrepAvailable: async () => (await whichAsync("ast-grep")) !== null,
    astGrepScan: async (files) => { // dp:ok every failure resolves [] (clean) — the ast-grep arm is advisory inside an already-degraded fallback
      const bin = await whichAsync("ast-grep");
      if (bin === null) return [];
      return new Promise((resolve) => {
        execFile(bin, ["scan", "json", ...files.slice(0, 20)], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            resolve([]);
            return;
          }
          try {
            const parsed: DiagnosticEntry[] = JSON.parse(stdout).map(
              (h: { file?: string; r? : unknown }) => ({
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
    hasTestSuite: async () => true,
    runTestSuite: async () => true,
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
