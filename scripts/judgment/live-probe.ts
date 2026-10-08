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
 * v6 J1: the probe reaches the wire only through the JudgmentProvider
 * registry — the live-mode client resolves its transport there, and the
 * client's mode is the round's transport (`live` = the registry's `jev`
 * adapter). It never imports an adapter module or hand-builds a
 * transport (the adapter makers are not even public). The serving provider
 * is printed before fire with the spend line; `--evidence-dir` (validated
 * writable BEFORE the paid request) gets one timestamped, key-free evidence
 * JSON per round — clean, drift, HTTP/transport error or post-response
 * failure alike. Only a body that arrived but is not contract-shaped
 * (JudgmentSchemaError) is DRIFT (exit 2); a transport failure or upstream
 * 502 is an error (exit 1). J1's round:
 *
 *   TYPESAFE_API_KEY=... QDS_LIVE_PROBE_CONFIRMED=1 bun scripts/judgment/live-probe.ts --evidence-dir _bmad-output/evidence/v6a/j1
 *
 * Evidence `transport` is the client's mode (ground truth): under
 * TYPESAFE_MOCK=1 it records `mock` with no endpoint.
 *
 * Re-calibration ritual on drift (also in the contract json header):
 * re-verify against docs.typesafe.ai/models.md, then update the contract
 * json + src/judgment/schemas.ts + the client pin in ONE commit, then re-run
 * this probe.
 */

import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PROVENANCE_DIR,
  JudgmentClient,
  JudgmentHttpError,
  JudgmentSchemaError,
  TYPESAFE_API_URL,
  TYPESAFE_MODEL,
  type JudgmentEnvelope,
  type JudgmentProviderId,
} from "../../src/judgment/index.ts";
import { newRequestId } from "../../src/swarmclaw/log.ts";
import contract from "../../tests/judgment/typesafe-api-contract.json";

const CONFIRM_ENV = "QDS_LIVE_PROBE_CONFIRMED";

/**
 * The registered adapter this probe proves against the real endpoint (J1
 * AC6). The live-mode client resolves it from the closed registry; the probe
 * names it in the pre-fire line so a round is attributable.
 */
export const PROBE_PROVIDER: JudgmentProviderId = "jev";

const USAGE = "usage: live-probe.ts [--evidence-dir <dir>]";

/** argv: only `--evidence-dir <dir>`, at most once; anything else refuses (no silent typo). */
function parseArgs(argv: readonly string[]): { evidenceDir?: string } {
  const out: { evidenceDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== "--evidence-dir") throw new Error(`unknown argument ${JSON.stringify(a)} — ${USAGE}`);
    if (out.evidenceDir !== undefined) throw new Error(`--evidence-dir given twice — ${USAGE}`);
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("-")) throw new Error(`--evidence-dir needs a directory value — ${USAGE}`);
    out.evidenceDir = v;
    i++;
  }
  return out;
}

/** UTC compact stamp with milliseconds, e.g. 20261008T171500123Z. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, "");
}

/**
 * Validate the evidence dir BEFORE the paid request (create it, prove it is a
 * writable directory) and return the writer. A write that still fails after
 * the spend prints the record to stderr and does NOT throw — the round's own
 * exit code (0 clean / 2 drift / 1 error) must survive an evidence failure.
 */
function prepareEvidence(dir: string): (record: Record<string, unknown>, requestId: string) => void {
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`--evidence-dir ${dir} is not a directory`);
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
  return (record, requestId) => {
    const text = `${JSON.stringify(record, null, 2)}\n`;
    const file = join(dir, `live-probe-${stamp(new Date())}-${requestId.slice(0, 8)}.json`);
    try {
      writeFileSync(file, text, { flag: "wx" });
      console.log(`[live-probe] evidence written: ${file}`);
    } catch (e) {
      console.error(`[live-probe] evidence write failed (${(e as Error).message}) — record follows:\n${text}`);
    }
  };
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

/** The first contract drift in an envelope, or null — pure, so main can record it before exiting. */
function contractDrift(env: JudgmentEnvelope): string | null {
  if (env.model !== contract.model) return `model is "${env.model}", contract pins "${contract.model}"`;
  if (Object.keys(env.questions).join(",") !== Object.keys(canonicalRequest().questions).join(",")) {
    return "question ids were not echoed as asked";
  }
  const answer = env.answers.probe_ok;
  if (!answer || answer.type !== "noul" || !("noul" in answer)) {
    return `noul answer shape is ${JSON.stringify(answer ?? null)}, contract pins ${JSON.stringify(contract.response.answerShapes.noul.keys)}`;
  }
  for (const key of contract.response.usageKeys) {
    if (!(key in env.usage)) return `usage is missing "${key}"`;
  }
  return null;
}

/** Exported for tests/judgment/probe-gate.test.ts — the diff is pure, so the
 * contract's drift arms are pin-able without a wire. */
export function diffEnvelope(env: JudgmentEnvelope): void {
  const d = contractDrift(env);
  if (d) drift(d);
}

/** Test-only: tests point the side channel at a tmp dir instead of the real one. */
export interface ProbeOptions {
  provenanceDir?: string;
}

/** Exported for tests/judgment/probe-gate.test.ts (fetch-stubbed or TYPESAFE_MOCK=1 — never the network). */
export async function main(argv: readonly string[] = [], opts: ProbeOptions = {}): Promise<void> {
  const args = parseArgs(argv);
  const gate = probeGate();
  if (!gate.ok) {
    console.error(`[live-probe] refusing to run: ${gate.reason}`);
    process.exit(1);
  }

  const provenanceDir = opts.provenanceDir ?? DEFAULT_PROVENANCE_DIR;
  const req = canonicalRequest();
  // The transport comes from the closed registry inside the client; the
  // client's mode is ground truth for what this round actually is.
  // One id for the whole round: wire x-request-id, envelope, side channel,
  // house log AND the evidence file — even when the failure is not HTTP.
  const requestId = newRequestId();
  const client = new JudgmentClient({ mode: "live", provenanceDir, requestId });
  const transport = client.mode;
  // Evidence dir proven writable BEFORE the paid request.
  const writeEvidence = args.evidenceDir ? prepareEvidence(args.evidenceDir) : undefined;

  console.log(`[live-probe] endpoint ${TYPESAFE_API_URL}, model pin ${TYPESAFE_MODEL}`);
  console.log(
    `[live-probe] provider ${client.providerId} (registry-resolved, transport ${transport}; probe proves ${PROBE_PROVIDER}); spend: 1 judgment (at most ${DEFAULT_MAX_ATTEMPTS} wire attempts on 429/529), ${req.state.length}-char machine-state, cents-class at most (jev-live-r1: 108 requests = $0.00223)`,
  );
  // Scrubbed by construction: no state text, no key, nothing env-derived
  // beyond the provider id. A mock round names no endpoint it never touched.
  const base = {
    round: "live-probe",
    provider: client.providerId,
    transport,
    endpoint: transport === "live" ? TYPESAFE_API_URL : null,
    contractPin: contract.model,
  };

  let env: JudgmentEnvelope;
  try {
    env = await client.judge(req.state, req.questions, { egressClass: req.egressClass });
  } catch (e) {
    // Only a received-but-not-contract-shaped body is DRIFT; a transport
    // failure or an upstream 502 shares the status but not the meaning.
    const isDrift = e instanceof JudgmentSchemaError;
    const err = e as Error;
    // Every failed round is recorded — HTTP, transport, drift, or a
    // post-response failure (e.g. the provenance emit) after a paid request.
    writeEvidence?.(
      {
        ...base,
        at: new Date().toISOString(),
        contractDiff: isDrift ? `drift: ${err.message}` : `error: ${e instanceof JudgmentHttpError ? `http_${e.status}` : err.name}`,
        error: { name: err.name, message: err.message, ...(e instanceof JudgmentHttpError ? { status: e.status } : {}) },
        spend: { judgments: 1, maxWireAttempts: DEFAULT_MAX_ATTEMPTS },
        envelope: null,
      },
      requestId,
    );
    // A strict-parse / non-JSON failure IS the drift — name it, exit 2.
    if (isDrift) drift(err.message);
    throw e;
  }
  const d = contractDrift(env);
  writeEvidence?.(
    {
      ...base,
      at: env.created_at,
      contractDiff: d ? `drift: ${d}` : "clean",
      spend: {
        judgments: 1,
        maxWireAttempts: DEFAULT_MAX_ATTEMPTS,
        input_tokens: env.usage.input_tokens,
        output_tokens: env.usage.output_tokens,
      },
      envelope: env,
    },
    requestId,
  );
  if (d) drift(d);
  console.log(
    transport === "live"
      ? "[live-probe] contract matches. envelope:"
      : "[live-probe] contract matches (MOCK transport — TYPESAFE_MOCK=1 — NOT live evidence). envelope:",
  );
  console.log(JSON.stringify(env, null, 2));
  console.log(`[live-probe] observed usage: ${env.usage.input_tokens} input / ${env.usage.output_tokens} output tokens`);
  console.log(`[live-probe] provenance entry written under ${provenanceDir}/`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`[live-probe] failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
