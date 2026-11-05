#!/usr/bin/env bun
/**
 * P0.9 leg `round-trip-via-bridge` (transport re-homed; story M1.1 AC2 + AC5).
 *
 * The make-or-break Hindsight round trip — retain → recall → reflect →
 * consolidate → post-consolidation recall — on the DEDICATED instance, driven
 * exclusively by `verifyRoundTrip` (src/hindsight/round-trip-verifier.ts, the
 * story-locked authority; this driver never re-implements a lifecycle step).
 *
 * Clause map:
 *   - AC2 live path: the round trip ALWAYS runs on the live client. An
 *     injected `deps.client` is used VERBATIM (the DI-shape negative control:
 *     evidence must carry the injected collaborator's distinctive memoryId,
 *     surfaced through `RoundTripOk.matchedMemoryId` from the recall match —
 *     a driver that swapped in its own mock client could not surface it);
 *     otherwise a `HindsightClient` is constructed on the resolved,
 *     trap-checked baseUrl (F-002) with `mode:"live"` on the live path (never
 *     the mock short-circuit) and `mode:"mock"` for a rehearsal run.
 *   - Ordering, machine-checked (story DoD: "the hindsight-live shape check
 *     ran BEFORE the round-trip leg"): LIVE mode refuses (exit 2) unless a
 *     `*-p0-9-hindsight-live*.json` stamped `mode:"live"` already exists —
 *     enforced by the leg-lib scanLiveShapePrereq helper (F-022 hoist). A
 *     mock-stamped prereq is rejected too — mock evidence cannot gate a live
 *     leg (AC2 negative control). MOCK rehearsal is exempt from the prereq.
 *   - AC5: writes the closure plan's own filename slug
 *     `…-p0-9-round-trip-via-bridge.json` (driver-name mapping is recorded in
 *     the plan's annotation block; the plan's ACs stay byte-identical).
 *   - F009 / observability contract: evidence carries the HOST-side
 *     `recallMs` (verifier `durations.recall`) and the server's own
 *     `serverRecall` side by side at top level; `slowQuery` is a flag on the
 *     result, never folded into pass/fail. Durations are absent (not 0) when
 *     the round trip failed before measuring them. F-024: every p0-9-leg
 *     stderr line is captured (masked) into the evidence stderrTail.
 *   - Env discipline: `HINDSIGHT_BASE_URL` read BY NAME, fail-closed via
 *     leg-lib `requireBaseUrl` (the client's silent 127.0.0.1:8888 default is
 *     the shared-sidecar/tenant wrong-instance trap, runbook §6.4); trap
 *     ports refused via `forbiddenOrigin`; `deps.baseUrl === ""` is treated
 *     as unset (F-029). No host:port connection literals.
 *   - F-004: the round-trip bank id resolves through leg-lib assertQdsRepoSlug
 *     (INV-MEM-1 qds- prefix gate) — a non-qds- resolution is a fatal refusal.
 *
 * Output: one timestamped evidence JSON (openrig-sc2 idiom via leg-lib
 * `writeEvidenceOrStderr`; live → `_bmad-output/evidence/p0-9-closure/`; on
 * write failure the payload lands on stderr, F-030) plus
 * `{event:"p0-9-leg"}` JSON lines on stderr.
 * Exit: 0 round trip ok / 1 round trip failed / 2 fatal refusal (env guard,
 *      wrong-instance trap, missing or mock-stamped live prereq, non-qds slug).
 * Run: bun scripts/p0-9/round-trip-dedicated.ts
 *      (HINDSIGHT_BASE_URL required; HINDSIGHT_LEG_MODE=mock for rehearsal;
 *       QDS_REPO_SLUG optional — defaults to the cwd basename via leg-lib
 *       resolveRepoSlug, R2-018: one default across every driver)
 */
import {
  assertQdsRepoSlug,
  forbiddenOrigin,
  legLog,
  maskTail,
  requireBaseUrl,
  resolveRepoSlug,
  sanitizeOrigin,
  scanLiveShapePrereq,
  writeEvidenceOrStderr,
  type LegDeps,
  type LegEvidence,
  type LegMode,
  type LegStepRecord,
} from "./leg-lib.ts";
import { HindsightClient } from "../../src/hindsight/index.ts";
import {
  verifyRoundTrip,
  type RoundTripResult,
} from "../../src/hindsight/round-trip-verifier.ts";

/** The closure plan's own leg slug (evidence filename component). */
const LEG = "p0-9-round-trip-via-bridge";

/** Driver-local deps: leg-lib's bundle (partial — env fills the gaps) plus this leg's optional overrides. */
type RoundTripDeps = Partial<LegDeps> & { content?: string; query?: string };

/** F-024: one p0-9-leg line emitted AND captured (the evidence stderrTail's source). */
type Log = (entry: { step?: string; bankId?: string; durationMs?: number; outcome: string }) => void;

function makeLog(leg: string, logLines: string[]): Log {
  return (entry) => {
    logLines.push(JSON.stringify({ event: "p0-9-leg", leg, ...entry }));
    legLog({ leg, ...entry });
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** F-001/F-002 companion: a deps-carried origin gets the env path's trim + slash-strip (checked value = used value). */
function normalizeOriginValue(origin: string): string {
  let s = origin.trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Fatal-refusal evidence (exit 2) — runLeg resolves evidence for every outcome. */
function fatalEvidence(
  mode: LegMode,
  origin: string,
  outcome: string,
  stepName: string,
  log: Log,
  logLines: string[],
): LegEvidence {
  log({ outcome: "fatal" });
  return {
    leg: LEG,
    mode,
    ok: false,
    outcome,
    steps: [{ step: stepName, outcome: "fatal", detail: outcome }],
    // R2-015: userinfo-stripped when an origin was resolved; "" stays "".
    origin: origin === "" ? "" : sanitizeOrigin(origin),
    exitCode: 2,
    stdoutTail: "",
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
  };
}

/**
 * The leg body. Pure w.r.t. the network unless the collaborator is injected:
 * `deps.client` short-circuits client construction; without it a live run
 * constructs a real HindsightClient against the resolved origin (the
 * sanctioned VPS-day path). Resolves LegEvidence for EVERY outcome including
 * fatal refusals (exitCode 2).
 */
export async function runLeg(deps: RoundTripDeps = {}): Promise<LegEvidence> {
  const mode: LegMode = deps.mode ?? "live";
  const logLines: string[] = [];
  const log = makeLog(LEG, logLines);

  // --- baseUrl: deps override ("" ≡ unset, F-029), else env BY NAME, fail-closed ---
  let baseUrl = deps.baseUrl;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    try {
      baseUrl = requireBaseUrl(process.env as Record<string, string | undefined>);
    } catch (e) {
      return fatalEvidence(mode, "", `fatal: ${errMessage(e)}`, "env", log, logLines);
    }
  } else {
    baseUrl = normalizeOriginValue(baseUrl);
  }
  const trap = forbiddenOrigin(baseUrl);
  if (trap !== null) {
    return fatalEvidence(mode, baseUrl, `fatal: ${trap}`, "env", log, logLines);
  }

  // --- ordering prereq (live only; mock rehearsal exempt) — leg-lib F-022 ---
  if (mode === "live") {
    const scan = scanLiveShapePrereq({
      mode,
      ...(deps.outDir !== undefined ? { outDir: deps.outDir } : {}),
    });
    if (!scan.ok) {
      return fatalEvidence(mode, baseUrl, scan.reason, "prereq", log, logLines);
    }
    log({ step: "prereq", outcome: "ok" });
  }

  // --- client: injected verbatim, else constructed (live ⇒ mode live) ------
  const client: HindsightClient =
    deps.client !== undefined
      ? (deps.client as HindsightClient)
      : new HindsightClient({ baseUrl, mode: mode === "live" ? "live" : "mock" });

  // F-004: the bank id routes through the shared INV-MEM-1 prefix gate.
  // R2-018: the slug default is leg-lib resolveRepoSlug (QDS_REPO_SLUG ??
  // cwd basename) — the ONE default every driver shares; the old literal
  // "qds-factory" let a renamed checkout verify a bank nobody provisioned.
  let bankId: string;
  try {
    bankId = assertQdsRepoSlug(resolveRepoSlug(process.env as Record<string, string | undefined>));
  } catch (e) {
    return fatalEvidence(mode, baseUrl, `fatal: ${errMessage(e)}`, "bank-id", log, logLines);
  }

  log({ outcome: "start", bankId });

  // --- the authority: verifyRoundTrip (never a second implementation) ------
  let rt: RoundTripResult;
  try {
    rt = await verifyRoundTrip({
      client,
      bankId,
      ...(deps.content !== undefined ? { content: deps.content } : {}),
      ...(deps.query !== undefined ? { query: deps.query } : {}),
    });
  } catch (e) {
    // verifyRoundTrip maps every op error into RoundTripErr; an escape here is
    // a driver-level fault and fails the leg (exit 1), never a silent green.
    const msg = errMessage(e);
    log({ outcome: "fail" });
    return {
      leg: LEG,
      mode,
      ok: false,
      outcome: `fail: verifyRoundTrip threw outside its error envelope: ${msg}`,
      steps: [{ step: "retain", outcome: `fail ${msg}` }],
      origin: sanitizeOrigin(baseUrl), // R2-015: userinfo-stripped
      exitCode: 1,
      stdoutTail: "",
      stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
      writtenAt: new Date().toISOString(),
      bankId,
    };
  }

  // --- evidence: the verifier's result VERBATIM + the pinned projections --
  const steps: LegStepRecord[] = rt.ok
    ? [
        { step: "retain", outcome: "ok", durationMs: rt.durations.retain },
        { step: "recall", outcome: "ok", durationMs: rt.durations.recall },
        { step: "reflect", outcome: "ok", durationMs: rt.durations.reflect },
        { step: "consolidate", outcome: "ok", durationMs: rt.durations.consolidate },
        { step: "post_consolidate_recall", outcome: "ok", durationMs: rt.durations.postRecall },
      ]
    : [
        {
          step: rt.step,
          outcome: `fail ${rt.error.code}: ${rt.error.message}`,
        },
      ];
  for (const s of steps) {
    log({
      step: s.step,
      bankId,
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      outcome: s.outcome.startsWith("ok") ? "ok" : "fail",
    });
  }

  const outcome = rt.ok
    ? "pass: round trip ok — five steps via verifyRoundTrip (the authority), client live"
    : `fail: round trip failed at step "${rt.step}": ${rt.error.code} — ${rt.error.message}`;
  log({ outcome: rt.ok ? "ok" : "fail" });

  return {
    leg: LEG,
    mode,
    ok: rt.ok,
    outcome,
    steps,
    origin: sanitizeOrigin(baseUrl), // R2-015: userinfo-stripped
    exitCode: rt.ok ? 0 : 1,
    stdoutTail: "",
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
    bankId,
    roundTrip: rt,
    // F009 projections at top level; absent (never 0) when the trip failed
    // before the initial recall was measured.
    ...(rt.ok
      ? {
          recallMs: rt.durations.recall,
          serverRecall: rt.durations.serverRecall,
          slowQuery: rt.slowQuery,
        }
      : {}),
  };
}

/**
 * Thin main: env → deps → runLeg → evidence → stderr path line → exitCode.
 * exitCode (not process.exit) so a backpressured stderr pipe drains first.
 * F-030: a failing evidence write dumps the payload to stderr and exits fatal.
 */
async function main(): Promise<void> {
  const mode: LegMode = process.env.HINDSIGHT_LEG_MODE === "mock" ? "mock" : "live";
  const ev = await runLeg({ mode });
  const { path: file, fellBack } = writeEvidenceOrStderr(LEG, ev);
  if (!fellBack) process.stderr.write(`${file}\n`);
  process.exitCode = fellBack ? 2 : ev.exitCode;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${LEG} fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
  });
}
