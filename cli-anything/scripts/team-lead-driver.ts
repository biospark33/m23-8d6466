#!/usr/bin/env bun
/**
 * P0.3 team lead driver — the subprocess-RPC runtime for a Research-Trio run
 * (OQ-1: subprocess-RPC is the proven zero-infra transport; Appendix D).
 *
 * Selected by `QDS_TEAM_RUNNER=local` in the harness (mirrors warren's own
 * WARREN_RUNTIME=local|k8s runtime-provider pattern): instead of dispatching
 * the lead through a warren server, the harness spawns this driver, which
 * plays the lead role directly:
 *
 *   1. reads worker role configs from QDS_AGENT_TEAM_CONFIG_JSON;
 *   2. spawns one REAL `pi` subprocess per worker (`--provider/--model` from
 *      the role config — mixed providers are the point);
 *   3. treats each prompt dispatch / structured reply as one coms exchange
 *      (subprocess-RPC), emitting `coms` events (send + receive per worker);
 *   4. emits a `cost` event per worker turn (from pi usage when available);
 *   5. validates + emits each worker's structured reply as `worker_output`;
 *   6. merges and emits the `merged` event, then exits 0.
 *
 * Output protocol: NDJSON on stdout, parsed by runTeamManifest. Logs → stderr.
 * INV-1: provider keys ride the inherited env; never argv, never logged.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

interface WorkerConfig {
  agentId: string;
  provider: string;
  model: string;
  prompt: string;
}

const say = (o: unknown): void => {
  console.log(JSON.stringify(o));
};
const log = (m: string): void => {
  console.error(`team-lead-driver: ${m}`);
};

const now = (): string => new Date().toISOString();

function comsEvent(
  i: number,
  direction: "send" | "receive",
  from: string,
  to: string,
  payloadSize: number,
  durationMs: number,
): Record<string, unknown> {
  return {
    type: "coms",
    request_id: `rpc-${i}`,
    session_id: `team-${process.pid}`,
    phase_id: "dispatch_task",
    channel: `${from}:${to}`,
    direction,
    sender_agent: from,
    receiver_agent: to,
    payload_size: payloadSize,
    duration_ms: durationMs,
    timestamp: now(),
  };
}

/**
 * The `cost` NDJSON event for ONE pi subprocess invocation (DF2.7).
 *
 * Both emit sites (worker and lead) go through here, so the wire shape cannot
 * drift between them and there is exactly one accounting path: the numbers the
 * budget guard reads are the numbers the ledger reads (INV-COST-2).
 */
function costEvent(
  agentId: string,
  model: string,
  outcome: PiRunOutcome,
): Record<string, unknown> {
  return {
    type: "cost",
    agentId,
    model,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    cacheReadTokens: outcome.cacheReadTokens,
    cacheWriteTokens: outcome.cacheWriteTokens,
    costUsd: outcome.costUsd,
    turnCount: outcome.turnCount,
    unpricedTurns: outcome.unpricedTurns,
    durationMs: outcome.durationMs,
    timestamp: now(),
  };
}

/** Extract the last JSON object embedded in a pi reply (fenced or bare). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidates: string[] = [];
  if (fenced !== null) {
    for (const block of fenced) {
      candidates.push(block.replace(/```(?:json)?\s*/, "").replace(/```\s*$/, ""));
    }
  }
  // Balanced-brace scan (string-aware) instead of greedy first-{...last-}:
  // "{"a":1} text {"b":2}" must yield each object, not one invalid blob.
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            candidates.push(text.slice(i, j + 1));
            i = j; // resume outer scan past this object
            break;
          }
        }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Session-cumulative usage for ONE pi subprocess invocation (DF2.7).
 *
 * Reset boundary: the invocation. Each `runWorkerPi` call starts these at zero
 * and the `cost` event it emits reports that invocation's own total. A resumed
 * `--session-id` therefore produces TWO cost events, each complete for its own
 * invocation; the run's true total is their SUM — which is exactly what
 * DF2.8's ledger sums over, and is only correct because no event restates
 * another's spend.
 */
export interface PiUsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Assistant turns observed, priced or not — including one per turn that
   * started and never ended (a truncated stream). */
  turnCount: number;
  /** Turns whose usage was missing or malformed — a known-partial record. */
  unpricedTurns: number;
}

export interface PiHarvest extends PiUsageTotals {
  text: string;
}

interface PiRunOutcome extends PiUsageTotals {
  text: string;
  durationMs: number;
  exitCode: number | null;
}

const ZERO_USAGE: PiUsageTotals = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turnCount: 0,
  unpricedTurns: 0,
};

/**
 * A finite, non-negative number, else null.
 *
 * A negative token or cost value is malformed input, never a credit: treating
 * one as a decrement would let a cumulative accumulator move backwards and let
 * the budget guard under-report spend (INV-COST-1/3).
 */
function finiteNonNegative(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Read one turn's priced usage out of a pi `usage` block, or null if any
 * priced field is absent or malformed (→ the turn is unpriced, INV-COST-5).
 *
 * Observed shape (pi 0.55.x/0.84.x, real session corpus):
 *   { input, output, cacheRead, cacheWrite, totalTokens,
 *     cost: { input, output, cacheRead, cacheWrite, total } }
 * The cache fields are camelCase, and every field is a PER-TURN DELTA — pi's
 * own `addUsageToTotals` sums per-message usage to derive session totals.
 * Alternative spellings are accepted defensively; a missing cache field is
 * reported as 0 and never synthesized from residuals.
 */
function readTurnUsage(usage: Record<string, unknown>): Omit<
  PiUsageTotals,
  "turnCount" | "unpricedTurns"
> | null {
  const rawCost = usage.cost;
  const costUsd =
    typeof rawCost === "object" && rawCost !== null
      ? finiteNonNegative((rawCost as Record<string, unknown>).total)
      : finiteNonNegative(rawCost);
  const inputTokens = finiteNonNegative(usage.input ?? usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.output ?? usage.outputTokens);
  if (costUsd === null || inputTokens === null || outputTokens === null) return null;
  const rawRead = usage.cacheRead ?? usage.cacheReadTokens ?? usage.cache_read_input_tokens;
  const rawWrite =
    usage.cacheWrite ?? usage.cacheWriteTokens ?? usage.cache_creation_input_tokens;
  const cacheReadTokens = rawRead == null ? 0 : finiteNonNegative(rawRead);
  const cacheWriteTokens = rawWrite == null ? 0 : finiteNonNegative(rawWrite);
  if (cacheReadTokens === null || cacheWriteTokens === null) return null;
  return { costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * Harvest assistant text + session-cumulative usage from one pi `--mode json`
 * NDJSON stream (DF2.7 — was per-event ASSIGNMENT, which reported the final
 * turn and under-counted every multi-turn run).
 *
 * Usage is accumulated on `message_end` ONLY. pi emits the same assistant
 * message — and the same `usage` object — on `message_start`,
 * every `message_update` and `turn_end`, and replays the whole message list in
 * `agent_end`; accumulating on any of those double-counts (INV-COST-3), which
 * would kill healthy runs early at the budget guard. `toolResult` usage is
 * excluded: pi documents it as "not part of main LLM context accounting".
 *
 * Exported for test (and to keep exactly ONE accumulator per agent per run —
 * the budget decision and the emitted totals read the same value, INV-COST-2).
 */
export function harvestPiStream(stdout: string): PiHarvest {
  let text = "";
  const totals: PiUsageTotals = { ...ZERO_USAGE };
  // Assistant messages that started but never ended. The timeout path SIGKILLs
  // pi mid-message (`child.kill("SIGKILL")` below), so the stream can stop
  // after message_start + N message_updates with no message_end. The provider
  // still bills those turns: counting them as unpriced is what stops a
  // truncated stream from being emitted as a COMPLETE cost record — which is
  // the runaway-worker case, i.e. exactly where the guard must not fail open.
  // A counter rather than a flag: whether pi can hold two messages open at
  // once is not something this parser should have to assume.
  let openMessages = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const e = event as Record<string, unknown>;
    // message_end events carry the assistant message; agent_end carries
    // the final message list. Collect text blocks from either shape.
    const message = (e.message ?? e.assistantMessage) as
      | Record<string, unknown>
      | undefined;
    const role = message?.role;
    // A missing role is treated as assistant: fixtures and non-pi producers
    // omit it, and pi's own message-bearing events are assistant messages.
    const isAssistant = typeof role !== "string" || role === "assistant";
    // Text comes from ASSISTANT messages only, on the same rule as usage. A
    // toolResult's content is tool output, not the worker's reply — letting it
    // through would hand `extractJsonObject` a file body or a bash result, and
    // if that happened to be JSON it would be emitted as the worker's
    // structured `worker_output` (changedFiles and all).
    if (isAssistant) {
      const content = message?.content;
      const blockTexts: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            // Concatenate: an LLM reply may span multiple text blocks
            // (e.g. around tool calls) — overwriting keeps only the last.
            blockTexts.push((block as Record<string, unknown>).text as string);
          }
        }
      }
      if (blockTexts.length > 0) text = blockTexts.join("\n");
    }

    // Strict on the way UP, permissive on the way DOWN. A role-less
    // message_start must not increment: if its matching message_end turns out
    // to carry an explicit non-assistant role, the decrement is skipped and
    // the counter leaks, marking every tool-using run partial forever.
    if (e.type === "message_start" && role === "assistant") openMessages++;
    if (e.type !== "message_end") continue;
    if (!isAssistant) continue;
    if (openMessages > 0) openMessages--;
    totals.turnCount++;
    // != null catches BOTH null and undefined — some events carry
    // usage: null, which `!== undefined` would let through to a TypeError.
    const usage = message?.usage ?? e.usage;
    if (usage == null || typeof usage !== "object" || Array.isArray(usage)) {
      totals.unpricedTurns++;
      continue;
    }
    const turn = readTurnUsage(usage as Record<string, unknown>);
    if (turn === null) {
      // Fail closed: an unmeasured turn is never priced at $0 and never
      // credited against accumulated spend (INV-COST-5).
      totals.unpricedTurns++;
      continue;
    }
    totals.costUsd += turn.costUsd;
    totals.inputTokens += turn.inputTokens;
    totals.outputTokens += turn.outputTokens;
    totals.cacheReadTokens += turn.cacheReadTokens;
    totals.cacheWriteTokens += turn.cacheWriteTokens;
  }
  totals.turnCount += openMessages;
  totals.unpricedTurns += openMessages;
  return { text, ...totals };
}

/** Run one worker pi subprocess in --mode json and harvest text + usage. */
function runWorkerPi(w: WorkerConfig, timeoutMs: number): Promise<PiRunOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const schemaInstruction =
      'Reply with ONLY a JSON object of the shape {"changedFiles": string[], "result": {"summary": string}} — changedFiles is MANDATORY (use [] when no files changed). No prose outside the JSON.';
    const child = spawn(
      "pi",
      [
        "--provider",
        w.provider,
        "--model",
        w.model,
        "--mode",
        "json",
        "--no-session",
        "-p",
        `${w.prompt}\n\n${schemaInstruction}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    // StringDecoder: a multi-byte UTF-8 char split across chunk boundaries
    // would corrupt under per-chunk toString (Gemini #40, medium).
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (d: Buffer) => {
      stdout += stdoutDecoder.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += stderrDecoder.write(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    // Spawn failure (missing pi binary, resource limits) emits `error`; with
    // no listener the whole driver crashes (Gemini #40, high). Resolve
    // gracefully so one broken worker degrades to partial, not to lead death.
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`worker ${w.agentId} spawn error: ${err.message}`);
      resolve({
        text: "",
        ...ZERO_USAGE,
        durationMs: Date.now() - started,
        exitCode: null,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      // pi --mode json emits NDJSON events; harvest assistant text + usage.
      const harvest = harvestPiStream(stdout);
      const { text } = harvest;
      if (text === "" && stderr !== "") {
        log(`worker ${w.agentId} stderr tail: ${stderr.slice(-400)}`);
      }
      resolve({
        ...harvest,
        durationMs: Date.now() - started,
        exitCode: code,
      });
    });
  });
}

async function main(): Promise<void> {
  const configRaw = process.env.QDS_AGENT_TEAM_CONFIG_JSON;
  if (configRaw === undefined) {
    log("QDS_AGENT_TEAM_CONFIG_JSON not set");
    process.exit(64);
  }
  let workers: WorkerConfig[];
  let lead: WorkerConfig | undefined;
  try {
    const parsed = JSON.parse(configRaw) as {
      workers?: WorkerConfig[];
      lead?: WorkerConfig;
    };
    workers = parsed.workers ?? [];
    lead = parsed.lead;
  } catch {
    log("QDS_AGENT_TEAM_CONFIG_JSON is not valid JSON");
    process.exit(64);
    return;
  }
  if (workers.length === 0) {
    log("no workers configured");
    process.exit(64);
  }
  // Bounded parse (F25): bare Number() turns a malformed PI_COMS_TIMEOUT_MS
  // into NaN, and setTimeout(NaN) fires at ~0ms — every worker is killed
  // instantly. A value > 2^31-1 overflows setTimeout's signed 32-bit ms
  // field, which Node treats as 1ms (TimeoutOverflowWarning) — the same
  // instant-kill symptom. Accept only integers in [1, 2_147_483_647], else
  // fall back to the 4 min default.
  const awaitTimeoutRaw = Number(process.env.PI_COMS_TIMEOUT_MS ?? 240_000);
  const awaitTimeoutMs =
    Number.isInteger(awaitTimeoutRaw) &&
    awaitTimeoutRaw >= 1 &&
    awaitTimeoutRaw <= 2_147_483_647
      ? awaitTimeoutRaw
      : 240_000;

  log(`dispatching ${workers.length} workers (subprocess-RPC)`);
  let comsSeq = 0;
  const results = await Promise.all(
    workers.map(async (w) => {
      const sendSeq = ++comsSeq;
      say(comsEvent(sendSeq, "send", "lead", w.agentId, w.prompt.length, 0));
      const outcome = await runWorkerPi(w, awaitTimeoutMs);
      say(costEvent(w.agentId, `${w.provider}/${w.model}`, outcome));
      const recvSeq = ++comsSeq;
      say(
        comsEvent(
          recvSeq,
          "receive",
          w.agentId,
          "lead",
          outcome.text.length,
          outcome.durationMs,
        ),
      );
      const unpricedTurns = outcome.unpricedTurns;
      if (outcome.exitCode !== 0 || outcome.text === "") {
        log(`worker ${w.agentId} failed (exit ${outcome.exitCode})`);
        return { w, output: null, unpricedTurns };
      }
      const parsed = extractJsonObject(outcome.text);
      if (parsed === null) {
        log(`worker ${w.agentId} reply was not parseable JSON`);
        return { w, output: null, unpricedTurns };
      }
      say({ type: "worker_output", agentId: w.agentId, output: parsed });
      return { w, output: parsed, unpricedTurns };
    }),
  );

  const responded = results.filter((r) => r.output !== null);
  const workerSummaries = responded
    .map((r) => {
      const result = (r.output as Record<string, unknown>).result;
      const summary =
        typeof result === "object" && result !== null
          ? (result as Record<string, unknown>).summary
          : undefined;
      return `${r.w.agentId}: ${typeof summary === "string" ? summary : "(no summary)"}`;
    })
    .join(" | ");

  // Lead merge turn: a REAL LLM call on the lead's own provider/model (the
  // Anthropic side of the mixed-provider demo), synthesizing the worker
  // replies. If the lead call fails, fall back to the mechanical concat so a
  // flaky lead model cannot zero out otherwise-good worker results.
  //
  // INV-COST-5: `cost` is emitted once per pi subprocess, so the host has no
  // in-flight per-turn signal to kill on — the enforceable granularity is the
  // NEXT paid subprocess spawn. A worker that reported unpriced turns leaves
  // the cumulative total known-partial (under-counted), and INV-COST-3 forbids
  // spending further against a total the budget guard cannot trust. So the
  // paid lead merge is refused and the run falls back to the mechanical
  // concat — the same degradation a flaky lead model already gets.
  const unpricedWorkers = results.filter((r) => r.unpricedTurns > 0);
  let leadSummary: string | null = null;
  if (lead !== undefined && responded.length > 0) {
    if (unpricedWorkers.length > 0) {
      log(
        `refusing paid lead merge: cumulative cost is partial (unpriced turns from ${unpricedWorkers
          .map((r) => r.w.agentId)
          .join(", ")}); falling back to concat`,
      );
    } else {
      const sendSeq = ++comsSeq;
      say(comsEvent(sendSeq, "send", "harness", lead.agentId, workerSummaries.length, 0));
      const outcome = await runWorkerPi(
        {
          ...lead,
          prompt: `${lead.prompt}\n\nWorker replies to merge:\n${workerSummaries}\n\nSynthesize them into result.summary (one short paragraph).`,
        },
        awaitTimeoutMs,
      );
      say(costEvent(lead.agentId, `${lead.provider}/${lead.model}`, outcome));
      const recvSeq = ++comsSeq;
      say(
        comsEvent(
          recvSeq,
          "receive",
          lead.agentId,
          "harness",
          outcome.text.length,
          outcome.durationMs,
        ),
      );
      if (outcome.exitCode === 0 && outcome.text !== "") {
        const parsed = extractJsonObject(outcome.text);
        const result = parsed?.result;
        const summary =
          typeof result === "object" && result !== null
            ? (result as Record<string, unknown>).summary
            : undefined;
        leadSummary = typeof summary === "string" ? summary : outcome.text.slice(0, 2000);
      } else {
        log(`lead merge call failed (exit ${outcome.exitCode}); falling back to concat`);
      }
    }
  }

  // A worker that produced no parseable reply is left unsettled at the
  // harness (its await slot times out → partial). The lead still merges what
  // it holds and exits 0 — the harness decides the top-level exitStatus.
  say({
    type: "merged",
    result: {
      summary: leadSummary ?? workerSummaries,
      workerSummaries,
      respondedWorkers: responded.map((r) => r.w.agentId),
      models: [
        ...(lead !== undefined ? [`${lead.provider}/${lead.model}`] : []),
        ...workers.map((w) => `${w.provider}/${w.model}`),
      ],
    },
  });
  process.exit(0);
}

// Guarded so the harvest seam above can be imported by tests without the
// driver spawning subprocesses and calling process.exit as a side effect.
// `bun cli-anything/scripts/team-lead-driver.ts` (the buildTeamSpawn argv)
// still runs main exactly as before.
if (import.meta.main) await main();
