#!/usr/bin/env bun
/**
 * P1.7 MANDATORY e2e demo leg — live gated run (story DoD: never tick what did not run).
 *
 * DoD arms: (1) an agent edits a file with a TS error → emit blocked;
 * (2) fixed → waiver 0; (3) simulated no-LSP → fallback waiver.
 *
 * Arms 1-2 use a real pi agent (one-shot `pi -p`) and the PRODUCTION gate deps
 * (real pi-lens MCP stdio → tsserver). Arm 3 simulates ONLY callLspDiagnostics
 * (timedOut:"init"); ast-grep + the test pass stay real.
 *
 * Spend: worst-case ≈ $0.15 (two one-shot pi runs, haiku-class). Operator-approved
 * with the venue pick (Local Mac, small pi-agent spend). Venue: local Mac — where the
 * phase engine attaches gates in production.
 *
 * Evidence: _bmad-output/evidence/p1-7-closure/<ts>-p1-7-e2e-gate-demo-<rand5>.json,
 * written once, never edited after capture; driver fixes forward-only (p0-9-closure rule).
 *
 * Run: bun scripts/p1-7/e2e-leg.ts  (PI7_OPENROUTER_API_KEY in env)
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateLspDiagnosticsGate,
  type DiagnosticsGateResult,
  type LspGateDeps,
} from "../../src/phase-engine/gates/lsp-diagnostics-gate.ts";
import { createProdLspGateDeps } from "../../src/phase-engine/gates/lsp-diagnostics-prod-deps.ts";

const REPO = join(import.meta.dir, "..", "..");
const OUT_DIR = join(REPO, "_bmad-output", "evidence", "p1-7-closure");
const LEG = "p1-7-e2e-gate-demo";
const LEG_VERSION = "p1.7-e2e.1";
const PI_TIMEOUT_MS = 120_000;

interface ArmRecord {
  arm: "blocked" | "waiver-0" | "no-lsp-fallback";
  piRun?: { exit: number; stderrTail: string; stdoutTail: string };
  gate: DiagnosticsGateResult | null;
  verdict: "PROVEN" | "BROKEN" | "UNPROVEN";
  note?: string;
}

function randSuffix(n = 5): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join("");
}

/** Real pi agent edit: one-shot, json mode, explicit key (stored auth shadows env). */
async function piEdit(workspace: string, prompt: string, apiKey: string) {
  return await new Promise<{ exit: number; stdout: string; stderr: string }>((resolve) => {
    // spawn with stdin IGNORED: execFile's piped stdin stalls pi (no-TTY hang —
    // measured: 120 s to the kill with zero output; spawn+ignore answers).
    const c = spawn(
      "pi",
      // Explicit provider+model is REQUIRED with --api-key; the EXACT slug is
      // required because the pattern "claude-haiku-4.5" resolves to a :batch
      // adapter variant that 404s on the chat/completions endpoint (measured).
      ["-p", "--mode", "json", "--provider", "openrouter", "--model", "anthropic/claude-haiku-4.5", "--api-key", apiKey, prompt],
      { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let errS = "";
    c.stdout.on("data", (d: Buffer) => {
      out += d;
    });
    c.stderr.on("data", (d: Buffer) => {
      errS += d;
    });
    const t = setTimeout(() => {
      c.kill("SIGKILL");
      resolve({ exit: 124, stdout: out, stderr: `${errS}\n[leg: pi exceeded ${PI_TIMEOUT_MS} ms — killed]` });
    }, PI_TIMEOUT_MS);
    c.on("exit", (code, sig) => {
      clearTimeout(t);
      resolve({ exit: code ?? (sig ? 1 : 0), stdout: out, stderr: errS });
    });
  });
}

/** DoD arm 3's ONLY simulation: the LSP call; everything else stays prod deps. */
function withSimulatedNoLsp(real: LspGateDeps): LspGateDeps {
  return { ...real, callLspDiagnostics: async () => ({ text: "", timedOut: "init" }) };
}

async function main(): Promise<void> {
  const apiKey = process.env.PI7_OPENROUTER_API_KEY ?? "";
  if (apiKey === "") {
    console.error("PI7_OPENROUTER_API_KEY not set — refusing (spend discipline: explicit key, never persisted)");
    process.exit(2);
  }
  const startedAt = new Date().toISOString();
  const workspace = await mkdtemp(join(tmpdir(), "p1-7-e2e-"));
  const src = join(workspace, "src");
  const testsDir = join(workspace, "tests");
  await mkdir(src, { recursive: true });
  await mkdir(testsDir, { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p1-7-e2e", scripts: { test: "bun test" } }));
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
  await writeFile(
    join(testsDir, "auth.test.ts"),
    `import { sessionize } from "../src/auth.ts";\nimport { it, expect } from "bun:test";\nit("sessionize trims", () => { expect(sessionize("  a  ")).toBe("a"); });\n`,
  );
  const union = ["src/auth.ts"];
  const arms: ArmRecord[] = [];

  // ── Arm 1: agent edit carries the instructed error → gate blocks ----------
  // The agent STARTS from a clean file and its instructed edit INTRODUCES the
  // error: a real changed-file delta (a no-op replace would read as compliance
  // theater, and run 1 showed the agent no-ops on identical content).
  await writeFile(join(src, "auth.ts"), "export function sessionize(u: string): string {\n  return u.trim();\n}\n");
  const p1 = await piEdit(
    workspace,
    "Replace the ENTIRE content of src/auth.ts with EXACTLY these three lines and nothing else:\nexport function sessionize(u: string): string {\n  return undefinedHelper(u);\n}\nDo not fix the undefined name. Do not add imports. Do not touch other files. Then stop.",
    apiKey,
  );
  const after1 = await readFile(join(src, "auth.ts"), "utf8");
  const err1 = after1.includes("undefinedHelper");
  const deps1 = await createProdLspGateDeps("biospark33/p1-7-e2e-scratch", workspace);
  const g1 = err1 ? await evaluateLspDiagnosticsGate(deps1, { changedFiles: union }) : null;
  arms.push({
    arm: "blocked",
    piRun: { exit: p1.exit, stderrTail: p1.stderr.slice(-300), stdoutTail: p1.stdout.slice(-300) },
    gate: g1,
    verdict: err1 && g1 ? (g1.gateResult === "blocked" ? "PROVEN" : "BROKEN") : "UNPROVEN",
    ...(err1 ? {} : { note: "agent edit did not carry the instructed error — arm unproven, not failed" }),
  });

  // ── Arm 2: agent fixes → waiver 0 ------------------------------------------
  const p2 = await piEdit(
    workspace,
    "Edit src/auth.ts so it compiles: undefinedHelper does not exist. Replace the ENTIRE file content with EXACTLY these three lines and nothing else:\nexport function sessionize(u: string): string {\n  return u.trim();\n}\nDo not touch other files. Then stop.",
    apiKey,
  );
  const after2 = await readFile(join(src, "auth.ts"), "utf8");
  const clean2 = !after2.includes("undefinedHelper");
  const deps2 = await createProdLspGateDeps("biospark33/p1-7-e2e-scratch", workspace);
  const g2 = clean2 ? await evaluateLspDiagnosticsGate(deps2, { changedFiles: union }) : null;
  arms.push({
    arm: "waiver-0",
    piRun: { exit: p2.exit, stderrTail: p2.stderr.slice(-300), stdoutTail: p2.stdout.slice(-300) },
    gate: g2,
    // Honest dependency: "fixed → waiver 0" only counts if the error the
    // agent introduced in arm 1 was REALLY there (else the clean gate verdict
    // would be measuring an unedited file, not a fix).
    verdict: err1 && clean2 && g2 ? (g2.gateResult === "passed" && g2.waiver === 0 ? "PROVEN" : "BROKEN") : "UNPROVEN",
    ...(!err1 ? { note: "arm 1 never introduced the error — the clean gate verdict here would be unedited-file noise; arm unproven" } : (!clean2 ? { note: "agent fix did not land — arm unproven, not failed" } : {})),
  });

  // ── Arm 3: simulated no-LSP → real fallback (ast-grep + bun test) ----------
  const deps3 = withSimulatedNoLsp(await createProdLspGateDeps("biospark33/p1-7-e2e-scratch", workspace));
  const g3 = await evaluateLspDiagnosticsGate(deps3, { changedFiles: union });
  arms.push({
    arm: "no-lsp-fallback",
    gate: g3,
    verdict: g3.gateResult === "passed" && g3.waiverReason === "no-lsp" ? "PROVEN" : "BROKEN",
  });

  // ── Evidence: written once, scrubbed of the key, never edited after --------
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(OUT_DIR, `${stamp}-p1-7-e2e-gate-demo-${randSuffix()}.json`);
  const redact = (s: string): string => s.replaceAll(apiKey, "<redacted-key>");
  const evidence = {
    leg: LEG,
    legVersion: LEG_VERSION,
    mode: "live",
    ok: arms.every((a) => a.verdict === "PROVEN"),
    startedAt,
    writtenAt: new Date().toISOString(),
    venue: "local-mac (phase-engine production venue)",
    spendEstimateUsdWorstCase: 0.15,
    workspaceKept: join(workspace),
    arms: JSON.parse(redact(JSON.stringify(arms))) as ArmRecord[],
  };
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ leg: LEG, ok: evidence.ok, evidence: file }));

  // Workspace kept for forensics (arm failures name the pi stdout tails).
  console.error(`workspace kept: ${workspace}`);
}

void main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
