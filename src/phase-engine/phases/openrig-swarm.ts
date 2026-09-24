/**
 * The rig_swarm phase body: one OpenRig swarm INSIDE the box, booted, fed its
 * objective, polled to settlement, torn down. Research doc §5.6 + §9a.
 *
 * Ordering invariants (each carries a test):
 *  - keys read BEFORE any daemon/box state changes;
 *  - teardown ALWAYS runs (finally), AFTER cost emission, on done / abort /
 *    timeout / throw — a swarm has no natural stop (§9a finding 1);
 *  - the body settles (never fails) on the timeout fallback so the composed
 *    testCommand gate still renders a verdict.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify } from "yaml";
import type { PhaseBody, PhaseBodyContext } from "../phase.ts";
import type { PhaseSpec, RigMemberSpec, RigSpec } from "../types.ts";
// The exact trace-event shape (`Parameters<…>[0]`, never re-spelled): the
// pipeline runner passes its real `Tracer`, whose `trace` parameter is
// narrower than a bare `Record<string, unknown>` — a wide param here made
// the real Tracer structurally UNassignable to the dep.
import type { Tracer } from "../trace/tracer.ts";
import { emitSeatCosts, parseSeatSessionJsonl } from "./openrig-cost.ts";

export const SWARM_POLL_INTERVAL_MS = 15_000;
export const SWARM_GATE_MARGIN_MS = 60_000;
export const DEFAULT_OPENRIG_HOME = ".openrig";
// Task 5 owns this name in src/providers/credentials.ts (providers must not
// import from phase-engine; phase-engine already imports from providers), but
// Task 5 has not landed. Until it does, THIS declaration is the single source;
// when it lands, delete this and import it from ../../providers/credentials.ts.
export const SWARM_SEAT_KEYS_ENV = "QDS_SWARM_KEYS_FILE";

export interface CmdResult { exitCode: number; stdout: string; stderr: string; }
export type CmdRunner = (argv: readonly string[], opts?: { timeoutMs?: number }) => Promise<CmdResult>;

export interface OpenrigSwarmDeps {
  requestId?: string;
  /** HOME used to resolve the repo workdir + OpenRig home (tests inject a temp). */
  home?: string;
  /** Injectable command runner. Default: Bun.spawn with captured stdio. */
  run?: CmdRunner;
  tracer?: { trace: (event: Parameters<Tracer["trace"]>[0]) => void };
  emitMoneyLine?: (line: Record<string, unknown>) => void;
  invocationSeqByAgent?: Map<string, number>;
  log?: (line: Record<string, unknown>) => void;
  /** Test seam: overrides the default poll interval. */
  pollIntervalMs?: number;
  /** Test/composition seam: overrides `process.env[SWARM_SEAT_KEYS_ENV]`. */
  keysFile?: string;
}

export function parseQueueShow(stdout: string): { state: string | null; closureReason: string | null } {
  // Tolerant dual shape: the CLI's human "key: value" lines OR a JSON object.
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        state: typeof o.state === "string" ? o.state : null,
        closureReason: typeof o.closureReason === "string" ? o.closureReason : null,
      };
    } catch { /* fall through */ }
  }
  const kv = (key: string): string | null => {
    const m = trimmed.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim() ?? null;
  };
  return { state: kv("state"), closureReason: kv("closureReason") };
}

/** One seat of the swarm: the rigSpec member plus its OpenRig session name. */
interface Seat {
  member: RigMemberSpec;
  session: string;
}

function seatsOf(rig: RigSpec): Seat[] {
  const seats: Seat[] = [];
  for (const pod of rig.pods) {
    for (const member of pod.members) seats.push({ member, session: `${pod.id}-${member.id}@${rig.name}` });
  }
  return seats;
}

interface Settled {
  reason: "lead-closed" | "timeout-fallback";
  state?: string | null;
  closureReason?: string | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = done;
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("swarm phase aborted");
}

/**
 * The rig_swarm phase body. See the file header for the ordering invariants;
 * every block below is its own small function so the body reads top-to-bottom.
 */
export function openrigSwarmPhase(
  spec: PhaseSpec,
  deps: OpenrigSwarmDeps = {},
): PhaseBody<{ exitStatus: "success" | "fail" }> {
  return async (bodyCtx: PhaseBodyContext) => {
    const run = deps.run ?? defaultRun;
    const home = deps.home ?? process.env.HOME ?? "";
    const rigHome = path.join(home, DEFAULT_OPENRIG_HOME);
    const requestId = deps.requestId ?? bodyCtx.ctx.requestId;
    const trace = (name: string, payload: Record<string, unknown>): void => {
      try {
        deps.tracer?.trace({
          type: "log",
          name,
          requestId,
          phaseId: bodyCtx.phaseId,
          payloadJson: JSON.stringify(payload),
        });
      } catch {
        /* the trace store is a sidecar; the phase verdict owns the run */
      }
    };
    const logLine = (line: Record<string, unknown>): void => {
      try {
        (deps.log ?? defaultStderrLog)({ operation: "swarm.phase", phaseId: bodyCtx.phaseId, ...line });
      } catch {
        /* a throwing log sink must not replace the result it reports */
      }
    };

    const rig = spec.rigSpec;
    if (rig === undefined || !spec.leadSeat || !spec.objective || rig.pods.length === 0) {
      // The closed manifest schema refuses this at load; this guard is the
      // type-level backstop for direct constructors.
      throw new Error("rig_swarm spec missing rigSpec/pods/leadSeat/objective");
    }
    const seats = seatsOf(rig);

    // ── 1. Refusals first: no box state changes past this point's throws ──
    const keysPath = deps.keysFile ?? process.env[SWARM_SEAT_KEYS_ENV];
    if (!keysPath) {
      throw new Error(
        `${SWARM_SEAT_KEYS_ENV} is not set — the seat-keys file is unknown; refusing before any box state changes`,
      );
    }
    let keys: Record<string, string>;
    try {
      keys = JSON.parse(fs.readFileSync(keysPath, "utf8")) as Record<string, string>;
    } catch (e) {
      // The PATH only — a read/parse error's text must never echo file content.
      throw new Error(`seat keys file ${keysPath} is unreadable or not JSON (${e instanceof Error ? e.name : "error"})`);
    }
    for (const { member } of seats) {
      if (typeof keys[member.id] !== "string" || keys[member.id] === "") {
        throw new Error(`rigSpec member '${member.id}' has no key in the seat keys file — refusing to boot a keyless seat`);
      }
    }
    const workdir = ["app", "src"].map((d) => path.join(home, d)).find((p) => fs.existsSync(p));
    if (workdir === undefined) {
      throw new Error(`no repo workdir under ${home} (probed app/ then src/) — refusing to boot a swarm with no repo`);
    }

    let settled: Settled | undefined;
    let qid = "";
    try {
      // ── 2. Seed per-seat pi dirs: auth.json (0600) + settings.json ──
      for (const { member, session } of seats) {
        const agentDir = path.join(rigHome, "state", "pi", session, "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentDir, "auth.json"),
          JSON.stringify({ openrouter: { type: "api_key", key: keys[member.id] } }),
          { mode: 0o600 },
        );
        fs.writeFileSync(
          path.join(agentDir, "settings.json"),
          JSON.stringify({ extensions: ["/opt/qds/pi-ext/self-compact/self-compact.ts"] }),
        );
        trace("swarm_seat_up", { session });
      }

      // ── 3. Daemon up + healthz. `rig daemon start` is idempotent on an
      // already-running daemon, and the brief's own test suite pins the call —
      // so it runs unconditionally, then healthz is awaited (30×1s). ──
      await run(["rig", "daemon", "start", "--no-kernel"]);
      let healthy = false;
      for (let i = 0; i < 30; i++) {
        throwIfAborted(bodyCtx.signal);
        if ((await run(["curl", "-fsS", "127.0.0.1:7433/healthz"])).exitCode === 0) {
          healthy = true;
          break;
        }
        await sleep(1_000, bodyCtx.signal);
      }
      if (!healthy) throw new Error("rig daemon failed to become healthy");

      // ── 4. Materialize the rig dir under the phase's run root (NOT the
      // repo): agent.yaml stubs + rig.yaml, cwd per member. ──
      const rigDir = path.join(rigHome, "runs", bodyCtx.ctx.runId, "rig");
      for (const { member } of seats) {
        const dir = path.join(rigDir, "agents", member.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "agent.yaml"),
          stringify({
            name: member.id,
            runtime: member.runtime ?? "pi",
            model: member.model,
            cwd: member.cwd ?? workdir,
          }),
        );
      }
      fs.writeFileSync(
        path.join(rigDir, "rig.yaml"),
        stringify({
          name: rig.name,
          pods: rig.pods.map((pod) => ({
            id: pod.id,
            members: pod.members.map((m) => ({
              id: m.id,
              runtime: m.runtime ?? "pi",
              model: m.model,
              cwd: m.cwd ?? workdir,
            })),
          })),
        }),
      );

      // ── 5. Import ──
      const imp = await run([
        "curl", "-sS", "-X", "POST", "127.0.0.1:7433/api/rigs/import",
        "-H", `X-Rig-Root: ${rigDir}`,
        "-H", "Content-Type: text/yaml",
        "--data-binary", `@${path.join(rigDir, "rig.yaml")}`,
      ]);
      let importOk = false;
      try {
        importOk = (JSON.parse(imp.stdout) as { ok?: unknown }).ok === true;
      } catch {
        /* non-JSON body is a failed import */
      }
      if (imp.exitCode !== 0 || !importOk) {
        throw new Error(`rig import failed (exit ${imp.exitCode}) — the finally still tears down`);
      }

      // ── 6. Queue the objective (identity preamble per seat finding 2) ──
      const firstPodId = rig.pods[0]!.id;
      const leadSession = `${firstPodId}-${spec.leadSeat}@${rig.name}`;
      const objectiveBody =
        `OBJECTIVE: ${spec.objective}\n\n` +
        `IDENTITY: before running any rig command, run \`export OPENRIG_SESSION_NAME=${leadSession}\` ` +
        `(Pi seats do not receive OPENRIG_* env; without it your messages show From: <unknown sender>).`;
      const queuePayload = JSON.stringify({
        sourceSession: "qds-engine",
        destinationSession: leadSession,
        body: objectiveBody,
        nudge: true,
      });
      const q = await run([
        "curl", "-sS", "-X", "POST", "127.0.0.1:7433/api/queue/create",
        "-H", "Content-Type: application/json",
        "-d", queuePayload,
      ]);
      try {
        const o = JSON.parse(q.stdout) as { id?: unknown; qid?: unknown };
        if (typeof o.id === "string") qid = o.id;
        else if (typeof o.qid === "string") qid = o.qid;
      } catch {
        /* handled by the guard below */
      }
      if (qid === "") throw new Error(`queue create returned neither id nor qid (exit ${q.exitCode})`);

      // ── 7. Poll loop: settle on done, on abort throw, on deadline fall
      // back — the body settles so the composed gate still renders a verdict. ──
      const deadline = Date.now() + spec.maxDurationMs - SWARM_GATE_MARGIN_MS;
      let prevState: string | null = null;
      for (;;) {
        throwIfAborted(bodyCtx.signal);
        const res = await run(["rig", "queue", "show", qid]);
        const { state, closureReason } = parseQueueShow(res.stdout);
        if (state !== prevState) {
          trace("swarm_qitem_transition", { qid, from: prevState, to: state, closureReason });
          prevState = state;
        }
        if (state === "done") {
          settled = { reason: "lead-closed", state, closureReason };
          break;
        }
        if (Date.now() >= deadline) {
          settled = { reason: "timeout-fallback" };
          break;
        }
        await sleep(deps.pollIntervalMs ?? SWARM_POLL_INTERVAL_MS, bodyCtx.signal);
      }
    } finally {
      // ── 8. Costs BEFORE teardown — the FIRST thing the finally does, so
      // every exit path (done / abort / timeout / throw) attributes spend
      // before `rig down --delete --force` destroys the session JSONLs.
      // Best-effort per seat: a missing seat log must not skip teardown. ──
      const seq = deps.invocationSeqByAgent ?? new Map<string, number>();
      const emitMoney = deps.emitMoneyLine ?? defaultStderrMoney;
      for (const { member, session } of seats) {
        try {
          const sessionsDir = path.join(rigHome, "state", "pi", session, "sessions");
          let jsonls: string[] = [];
          try {
            jsonls = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
          } catch {
            continue; // no session dir = the seat never spoke; not a failure
          }
          if (jsonls.length === 0) continue;
          let best = jsonls[0] as string;
          let bestSize = -1;
          for (const f of jsonls) {
            const size = fs.statSync(path.join(sessionsDir, f)).size;
            if (size > bestSize) {
              bestSize = size;
              best = f;
            }
          }
          const text = fs.readFileSync(path.join(sessionsDir, best), "utf8");
          emitSeatCosts(parseSeatSessionJsonl(text, member.id, session), {
            emitMoneyLine: emitMoney,
            invocationSeqByAgent: seq,
            requestId,
            runId: bodyCtx.ctx.runId,
            phaseId: bodyCtx.phaseId,
            role: member.id,
          });
        } catch (e) {
          logLine({ step: "seat-costs", seat: session, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── 9. Teardown ALWAYS runs, fixed order, each step best-effort ──
      for (const argv of [
        ["rig", "down", rig.name, "--delete", "--force"],
        ["rig", "daemon", "stop"],
        ["tmux", "kill-server"],
      ] as const) {
        try {
          await run(argv);
        } catch (e) {
          logLine({ step: "teardown", argv: argv.join(" "), error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // ── 10. Settled trace AFTER teardown, then settle (hard failures threw
    // above and never reach here — the phase records fail). ──
    trace("swarm_settled", {
      reason: settled!.reason,
      qid,
      state: settled!.state ?? null,
      closureReason: settled!.closureReason ?? null,
      timeoutFallback: settled!.reason === "timeout-fallback",
    });
    return { exitStatus: "success" };
  };
}

const defaultStderrLog = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

const defaultStderrMoney = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

const defaultRun: CmdRunner = async (argv, opts) => {
  const proc = Bun.spawn(argv as string[], {
    stdout: "pipe", stderr: "pipe",
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};
