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
 * Usage:  TYPESAFE_API_KEY=... QDS_LIVE_PROBE_CONFIRMED=1 bun scripts/judgment/live-probe.ts
 *
 * Re-calibration ritual on drift (also in the contract json header):
 * re-verify against docs.typesafe.ai/models.md, then update the contract
 * json + src/judgment/schemas.ts + the client pin in ONE commit, then re-run
 * this probe.
 */

import {
  JudgmentClient,
  JudgmentHttpError,
  TYPESAFE_API_URL,
  TYPESAFE_MODEL,
  type JudgmentEnvelope,
} from "../../src/judgment/index.ts";
import contract from "../../tests/judgment/typesafe-api-contract.json";

const CONFIRM_ENV = "QDS_LIVE_PROBE_CONFIRMED";

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

/** Exported for tests/judgment/probe-gate.test.ts (run under TYPESAFE_MOCK=1). */
export async function main(): Promise<void> {
  const gate = probeGate();
  if (!gate.ok) {
    console.error(`[live-probe] refusing to run: ${gate.reason}`);
    process.exit(1);
  }

  console.log(`[live-probe] endpoint ${TYPESAFE_API_URL}, model pin ${TYPESAFE_MODEL}`);
  const req = canonicalRequest();
  const client = new JudgmentClient({ mode: "live" });
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
  console.log("[live-probe] provenance entry written under _bmad-output/judgment/provenance/");
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`[live-probe] failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
