/**
 * TypeSafe wire probe (JEV-2, handoff §3.6 + §8) — the ONLY code in this
 * story that touches the wire, and the honest counterpart to the in-repo
 * contract pin (tests/judgment/contract.test.ts never sees the network).
 *
 * Sends ONE canonical minimal machine-state request (ADR 0001: the probe
 * ships machine-state only — no finding text, no hunks), diffs the live
 * response against tests/judgment/typesafe-api-contract.json, and exits 2
 * naming the drift. Spend is steve-gated (§8):
 *
 *   TYPESAFE_API_KEY must be set AND QDS_LIVE_PROBE_CONFIRMED=1
 *
 * The env var is the go flag (chosen over an argv flag for the same idiom as
 * TYPESAFE_MOCK; documented here). Nothing else in the repo invokes this
 * script, and no test runs it against the network — the pure gate, the
 * contract diff and the mock-mode main are unit-tested
 * (tests/judgment/probe-gate.test.ts); `main` is exported so the coverage
 * gate's per-file floor can score the wire-adjacent assembly in-process,
 * with TYPESAFE_MOCK=1 keeping every one of those tests off the wire.
 *
 * Usage:  TYPESAFE_API_KEY=... QDS_LIVE_PROBE_CONFIRMED=1 bun scripts/judgment/live-probe.ts [--evidence-dir <dir>]
 *
 * v6 J1: the probe reaches the wire through the JudgmentProvider registry —
 * `resolveProvider(PROBE_PROVIDER)` refuses an unregistered id, and the
 * live-mode client resolves that same registered `jev` adapter; the probe
 * never imports an adapter module or hand-builds a transport. The serving
 * provider is printed before fire with the spend line, and `--evidence-dir`
 * writes one timestamped, key-free evidence JSON per round (J1 evidence lives
 * under _bmad-output/evidence/v6a/j1/). Under TYPESAFE_MOCK=1 the evidence
 * honestly records `transport: "mock"`.
 *
 * Re-calibration ritual on drift (also in the contract json header):
 * re-verify against docs.typesafe.ai/models.md, then update the contract
 * json + src/judgment/schemas.ts + the client pin in ONE commit, then re-run
 * this probe.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JudgmentClient,
  JudgmentHttpError,
  resolveProvider,
  TYPESAFE_API_URL,
  TYPESAFE_MODEL,
  type JudgmentEnvelope,
  type JudgmentProviderId,
} from "../../src/judgment/index.ts";
import contract from "../../tests/judgment/typesafe-api-contract.json";

const CONFIRM_ENV = "QDS_LIVE_PROBE_CONFIRMED";

/** The registered adapter this probe proves against the real endpoint (J1 AC6). */
export const PROBE_PROVIDER: JudgmentProviderId = "jev";

/** argv: only `--evidence-dir <dir>`; anything else refuses (no silent typo). */
function parseArgs(argv: readonly string[]): { evidenceDir?: string } {
  const out: { evidenceDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--evidence-dir" && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      out.evidenceDir = argv[++i];
    } else {
      throw new Error(`unknown argument ${JSON.stringify(a)} — usage: live-probe.ts [--evidence-dir <dir>]`);
    }
  }
  return out;
}

/** UTC compact stamp for the evidence filename, e.g. 20261008T171500Z. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Pure gate — steve's explicit go is mandatory before any wire call (§8). */
export function probeGate(
  env: Record<string, string | undefined> = process.env,
): { ok: true } | { ok: false; reason: string } {
  if (!env.TYPESAFE_API_KEY || env.TYPESAFE_API_KEY.length === 0) {
    return { ok: false, reason: "TYPESAFE_API_KEY is not set — no key, no wire (INV-J5)" };
  }
  if (env[CONFIRM_ENV] !== "1") {
    return {
      ok: false,
      reason: `${CONFIRM_ENV} is not "1" — real spend needs steve's explicit go (handoff §8)`,
    };
  }
  return { ok: true };
}

/** The canonical minimal request — machine-state class only, one noul question. */
export function canonicalRequest(): {
  state: string;
  questions: { probe_ok: { type: "noul"; instructions: string } };
  egressClass: "machine-state";
} {
  return {
    state: "live-probe: canonical machine-state request (connectivity + contract check)",
    questions: { probe_ok: { type: "noul", instructions: "Answer true if this request reached you intact." } },
    egressClass: "machine-state",
  };
}

function drift(message: string): never {
  console.error(`[live-probe] CONTRACT DRIFT — ${message}`);
  console.error(
    "[live-probe] ritual: re-verify docs.typesafe.ai/models.md, then update tests/judgment/typesafe-api-contract.json + src/judgment/schemas.ts + the client pin in ONE commit, then re-run this probe.",
  );
  process.exit(2);
}

/** Exported for tests/judgment/probe-gate.test.ts — the diff is pure, so the
 * contract's drift arms are pin-able without a wire. */
export function diffEnvelope(env: JudgmentEnvelope): void {
  if (env.model !== contract.model) drift(`model is "${env.model}", contract pins "${contract.model}"`);
  if (Object.keys(env.questions).join(",") !== Object.keys(canonicalRequest().questions).join(",")) {
    drift("question ids were not echoed as asked");
  }
  const answer = env.answers.probe_ok;
  if (!answer || answer.type !== "noul" || !("noul" in answer)) {
    drift(`noul answer shape is ${JSON.stringify(answer ?? null)}, contract pins ${JSON.stringify(contract.response.answerShapes.noul.keys)}`);
  }
  for (const key of contract.response.usageKeys) {
    if (!(key in env.usage)) drift(`usage is missing "${key}"`);
  }
}

/** Exported for tests/judgment/probe-gate.test.ts (fetch-stubbed or TYPESAFE_MOCK=1 — never the network). */
export async function main(argv: readonly string[] = []): Promise<void> {
  const args = parseArgs(argv);
  const gate = probeGate();
  if (!gate.ok) {
    console.error(`[live-probe] refusing to run: ${gate.reason}`);
    process.exit(1);
  }

  // Registry first: an unregistered PROBE_PROVIDER refuses typed here,
  // before any request exists. The live-mode client resolves the same entry.
  resolveProvider(PROBE_PROVIDER);
  console.log(`[live-probe] endpoint ${TYPESAFE_API_URL}, model pin ${TYPESAFE_MODEL}`);
  const req = canonicalRequest();
  const client = new JudgmentClient({ mode: "live" });
  const transport = client.providerId === PROBE_PROVIDER ? "live" : "mock";
  console.log(
    `[live-probe] provider ${client.providerId} (registry-resolved, transport ${transport}); spend: 1 request, ${req.state.length}-char machine-state, cents-class at most (jev-live-r1: 108 requests = $0.00223)`,
  );
  let env: JudgmentEnvelope;
  try {
    env = await client.judge(req.state, req.questions, { egressClass: req.egressClass });
  } catch (e) {
    if (e instanceof JudgmentHttpError && e.status === 502) {
      // A strict-parse failure IS the drift — name it, exit 2.
      drift(e.message);
    }
    throw e;
  }
  diffEnvelope(env);
  console.log("[live-probe] contract matches. envelope:");
  console.log(JSON.stringify(env, null, 2));
  console.log(`[live-probe] observed usage: ${env.usage.input_tokens} input / ${env.usage.output_tokens} output tokens`);
  console.log("[live-probe] provenance entry written under _bmad-output/judgment/provenance/");

  if (args.evidenceDir) {
    // Scrubbed by construction: the envelope carries no state text and no
    // key; nothing env-derived beyond the provider id is written.
    const evidence = {
      round: "live-probe",
      at: env.created_at,
      provider: client.providerId,
      transport,
      endpoint: TYPESAFE_API_URL,
      contractPin: contract.model,
      contractDiff: "clean",
      spend: { requests: 1, input_tokens: env.usage.input_tokens, output_tokens: env.usage.output_tokens },
      envelope: env,
    };
    mkdirSync(args.evidenceDir, { recursive: true });
    const file = join(args.evidenceDir, `live-probe-${stamp(new Date(env.created_at))}.json`);
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    console.log(`[live-probe] evidence written: ${file}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`[live-probe] failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
