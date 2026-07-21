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

interface PiRunOutcome {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  exitCode: number | null;
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
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
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
      let text = "";
      let costUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
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
        const usage = (message?.usage ?? e.usage) as
          | Record<string, unknown>
          | null
          | undefined;
        // != null catches BOTH null and undefined — some events carry
        // usage: null, which `!== undefined` would let through to a TypeError.
        if (usage != null && typeof usage === "object") {
          const cost = usage.cost;
          if (typeof cost === "object" && cost !== null) {
            const total = (cost as Record<string, unknown>).total;
            if (typeof total === "number" && Number.isFinite(total)) costUsd = total;
          } else if (typeof cost === "number" && Number.isFinite(cost)) {
            costUsd = cost;
          }
          const inTok = usage.input ?? usage.inputTokens;
          const outTok = usage.output ?? usage.outputTokens;
          if (typeof inTok === "number") inputTokens = inTok;
          if (typeof outTok === "number") outputTokens = outTok;
        }
      }
      if (text === "" && stderr !== "") {
        log(`worker ${w.agentId} stderr tail: ${stderr.slice(-400)}`);
      }
      resolve({
        text,
        costUsd,
        inputTokens,
        outputTokens,
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
      say({
        type: "cost",
        agentId: w.agentId,
        model: `${w.provider}/${w.model}`,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        costUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
        timestamp: now(),
      });
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
      if (outcome.exitCode !== 0 || outcome.text === "") {
        log(`worker ${w.agentId} failed (exit ${outcome.exitCode})`);
        return { w, output: null };
      }
      const parsed = extractJsonObject(outcome.text);
      if (parsed === null) {
        log(`worker ${w.agentId} reply was not parseable JSON`);
        return { w, output: null };
      }
      say({ type: "worker_output", agentId: w.agentId, output: parsed });
      return { w, output: parsed };
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
  let leadSummary: string | null = null;
  if (lead !== undefined && responded.length > 0) {
    const sendSeq = ++comsSeq;
    say(comsEvent(sendSeq, "send", "harness", lead.agentId, workerSummaries.length, 0));
    const outcome = await runWorkerPi(
      {
        ...lead,
        prompt: `${lead.prompt}\n\nWorker replies to merge:\n${workerSummaries}\n\nSynthesize them into result.summary (one short paragraph).`,
      },
      awaitTimeoutMs,
    );
    say({
      type: "cost",
      agentId: lead.agentId,
      model: `${lead.provider}/${lead.model}`,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costUsd: outcome.costUsd,
      durationMs: outcome.durationMs,
      timestamp: now(),
    });
    const recvSeq = ++comsSeq;
    say(
      comsEvent(recvSeq, "receive", lead.agentId, "harness", outcome.text.length, outcome.durationMs),
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

await main();
