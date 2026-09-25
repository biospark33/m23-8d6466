/**
 * The rig_swarm phase body: one OpenRig swarm INSIDE the box, booted, fed its
 * objective, polled to settlement, torn down. Research doc §5.6 + §9a.
 *
 * Ordering invariants (each carries a test):
 *  - keys read BEFORE any daemon/box state changes;
 *  - teardown ALWAYS runs (finally), AFTER cost emission — a swarm has no
 *    natural stop (§9a finding 1) — and is RIG-SCOPED: the daemon is stopped
 *    only if THIS run started it, only this rig's tmux sessions are killed,
 *    and the seeded per-seat state (plaintext seat keys) is removed;
 *  - every CLI spawn is bounded (SWARM_CLI_TIMEOUT_MS); setup and poll spawns
 *    observe the phase abort, while teardown spawns deliberately do NOT (an
 *    aborted signal would kill every teardown child before it starts, when
 *    teardown is exactly what must survive an abort) — either bound alone
 *    cannot strand the run;
 *  - an unverified swarm never reads as success: timeout fallback settles
 *    `fail` (the gate still renders a verdict on the journal).
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
// The seat-keys env-var name is owned by the providers layer (providers must
// not import from phase-engine; phase-engine already imports from providers).
import { SWARM_SEAT_KEYS_ENV } from "../../providers/credentials.ts";

export const SWARM_POLL_INTERVAL_MS = 15_000;
export const SWARM_GATE_MARGIN_MS = 60_000;
/**
 * Bound on every poll-loop CLI call (`rig queue show`) and each healthz probe:
 * a daemon that accepts a connection but never responds would otherwise hang
 * one call forever — no abort observation, no finally, billed box strands.
 */
export const SWARM_CLI_TIMEOUT_MS = 30_000;
/** Consecutive failed/null-state polls tolerated before the phase throws (so the finally tears down). */
export const SWARM_MAX_STALE_POLLS = 4;
export const DEFAULT_OPENRIG_HOME = ".openrig";

export interface CmdResult { exitCode: number; stdout: string; stderr: string; }
export type CmdRunner = (argv: readonly string[], opts?: {
  timeoutMs?: number;
  signal?: AbortSignal; // phase abort observation, forwarded to the spawned process
}) => Promise<CmdResult>;

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
  reason: "lead-closed" | "timeout-fallback" | "queue-terminal";
  state?: string | null;
  closureReason?: string | null;
}

/**
 * Queue states that settle the poll loop without a deadline: `done` closes the
 * item, the others are failure closures. A readable state NOT in this set keeps
 * polling — unknown vocabulary is never treated as failure.
 */
const TERMINAL_QUEUE_STATES = new Set(["done", "failed", "cancelled", "canceled"]);

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

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
    // A relative or empty home puts rigHome under the cwd and lets the workdir
    // probe adopt an unrelated ./src checkout as every seat's cwd — refuse
    // before any path is built or state seeded.
    if (home === "" || !path.isAbsolute(home)) {
      throw new Error(`swarm phase needs an absolute HOME, got ${home === "" ? "unset/empty" : `'${home}'`} — refusing`);
    }
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
    // src FIRST: `src` is the repo clone (fill.ts's DEFAULT_FILL_WORKDIR) and
    // `app` is the ENV directory (credentials.ts's KEY_ENV_FILE dirname —
    // which always exists on a delivered box since the seat-key delivery
    // creates it). The original app-first order made every seat's cwd the env
    // dir (R0.7 round 11 forensics: rig.yaml `cwd: /home/exedev/app`).
    const workdir = ["src", "app"].map((d) => path.join(home, d)).find((p) => fs.existsSync(p));
    if (workdir === undefined) {
      throw new Error(`no repo workdir under ${home} (probed src/ then app/) — refusing to boot a swarm with no repo`);
    }

    // The deadline is computed ONCE — before seeding/daemon/import/queue — so
    // wall time never exceeds maxDurationMs by the setup time, and the
    // healthz window is bounded by the same clock.
    const deadline = Date.now() + spec.maxDurationMs - SWARM_GATE_MARGIN_MS;
    // Every CLI spawn: bounded and observing the phase abort — defaultRun
    // combines both into the spawned process.
    const cli = (argv: readonly string[]): Promise<CmdResult> =>
      run(argv, { timeoutMs: SWARM_CLI_TIMEOUT_MS, signal: bodyCtx.signal });
    // Teardown's own runner: the timeout WITHOUT the phase abort. The finally
    // must clean up AFTER the phase has been aborted, and an aborted signal
    // reaches defaultRun's AbortSignal.any to kill every child before it
    // starts — teardown through `cli` would silently no-op exactly when it
    // matters (the seeded state holds plaintext seat keys). Still bounded:
    // SWARM_CLI_TIMEOUT_MS alone cannot strand the finally.
    const cliTeardown = (argv: readonly string[]): Promise<CmdResult> =>
      run(argv, { timeoutMs: SWARM_CLI_TIMEOUT_MS });

    let settled: Settled | undefined;
    let qid = "";
    let daemonStarted = false;
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

      // ── 3. Probe-first daemon up: healthz BEFORE start — an already-green
      // daemon is adopted, not bounced (a concurrent run owns it), and the
      // daemon is only ever stopped if THIS run started it. A failed start
      // throws here, not ~30s later as "failed to become healthy". ──
      const healthyProbe = async (): Promise<boolean> =>
        (await cli(["curl", "-fsS", "127.0.0.1:7433/healthz"])).exitCode === 0;
      if (!(await healthyProbe())) {
        const start = await cli(["rig", "daemon", "start", "--no-kernel"]);
        if (start.exitCode !== 0) {
          throw new Error(`rig daemon start failed (exit ${start.exitCode}): ${start.stderr.trim().slice(0, 500) || "no stderr"}`);
        }
        daemonStarted = true;
        let healthy = false;
        for (let i = 0; i < 30 && Date.now() < deadline; i++) {
          throwIfAborted(bodyCtx.signal);
          if (await healthyProbe()) {
            healthy = true;
            break;
          }
          await sleep(1_000, bodyCtx.signal);
        }
        if (!healthy) throw new Error("rig daemon failed to become healthy");
      }

      // ── 4. Materialize the rig dir under the phase's run root (NOT the
      // repo): agent.yaml stubs + rig.yaml, cwd per member. ──
      // The shapes below are OpenRig 0.5.14's ACTUAL import contract
      // (rigspec-schema.js, validated empirically against the pinned daemon
      // in the R0.7 round-11/12 forensics): the daemon's first-pass validator
      // requires rig.yaml `version` + `pods[].label` + per-member
      // `agent_ref`/`profile`, agent.yaml requires `name` + `version` + a
      // `profiles` map the member's `profile` names — the first authored
      // shape (name/runtime/model/cwd only) was refused with
      // validation_failed before a single seat ever launched. The member's
      // session name the daemon derives (`<pod.id>-<member.id>@<rig.name>`)
      // is exactly `seatsOf`'s, so queueing identity holds.
      const rigDir = path.join(rigHome, "runs", bodyCtx.ctx.runId, "rig");
      for (const { member } of seats) {
        const dir = path.join(rigDir, "agents", member.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "agent.yaml"),
          stringify({
            name: member.id,
            version: "1",
            profiles: {
              default: {
                preferences: {
                  runtime: member.runtime ?? "pi",
                  ...(member.model !== undefined ? { model: member.model } : {}),
                },
              },
            },
          }),
        );
      }
      fs.writeFileSync(
        path.join(rigDir, "rig.yaml"),
        stringify({
          version: "1",
          name: rig.name,
          pods: rig.pods.map((pod) => ({
            id: pod.id,
            label: pod.id,
            members: pod.members.map((m) => ({
              id: m.id,
              agent_ref: `local:agents/${m.id}`,
              profile: "default",
              runtime: m.runtime ?? "pi",
              ...(m.model !== undefined ? { model: m.model } : {}),
              cwd: m.cwd ?? workdir,
            })),
          })),
        }),
      );

      // ── 5. Import ──
      // Bounded retry: healthz answers while the daemon is STILL initializing
      // (round 12 forensics — the phase's first import raced the startup
      // work, e.g. the plugin-vendor's network fetch, and the daemon refused
      // or dropped it ~6 s in; a replay against the settled daemon with the
      // IDENTICAL yaml imported and launched both seats). The pinned tree
      // owns that readiness gap; a short retry bound is our honest handle on
      // it — fail-closed after the bound, with the LAST response body in the
      // error so an import refusal can never again be diagnosed blind (the
      // old message discarded stdout and cost a whole probe round).
      let imp: CmdResult = { exitCode: 1, stdout: "", stderr: "not attempted" };
      let importOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        throwIfAborted(bodyCtx.signal);
        if (attempt > 1) {
          // Retries spend the phase's remaining budget; the FIRST attempt is
          // unconditional (the deadline-immediate paths still import once and
          // fail downstream — the timeout-fallback contract depends on it).
          // The sleep can consume the last of the budget, so the deadline is
          // re-checked AFTER it (abort propagates out of the sleep itself).
          await sleep(2_000, bodyCtx.signal);
          throwIfAborted(bodyCtx.signal);
          if (Date.now() >= deadline) break;
        }
        imp = await cli([
          "curl", "-sS", "-X", "POST", "127.0.0.1:7433/api/rigs/import",
          "-H", `X-Rig-Root: ${rigDir}`,
          "-H", "Content-Type: text/yaml",
          "--data-binary", `@${path.join(rigDir, "rig.yaml")}`,
        ]);
        let body: { ok?: unknown; code?: unknown } = {};
        try {
          body = JSON.parse(imp.stdout) as { ok?: unknown; code?: unknown };
          importOk = body.ok === true;
        } catch {
          /* non-JSON body is a failed import */
        }
        // rig_name_running on a DEDICATED per-run box with a fresh daemon
        // (program invariant 1: one tier-2 brain per box) can only be OUR OWN
        // prior attempt — the import succeeded server-side (rig created,
        // seats launched) and the response was lost. Round 14: attempt 1
        // launched both seats, attempts 2–3 hit this exact refusal.
        //
        // OWNERSHIP before adoption (never trust the box): the collision is
        // ours only if EVERY expected seat session `<pod.id>-<member.id>@
        // <rig.name>` is live in tmux — the same names the teardown kills by.
        // A listing that does not name all of them is a rig we cannot vouch
        // for; adopting it would queue work onto, and teardown would delete,
        // a rig this run does not own. Adoption ALSO requires curl exit 0 —
        // an asymmetric body over a failed transport is retried, same as the
        // ok-body case below.
        if (body.code === "rig_name_running" && imp.exitCode === 0) {
          const listed = await cli(["tmux", "list-sessions", "-F", "#S"]);
          const names = new Set(
            listed.stdout
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          );
          const owned = listed.exitCode === 0 && seats.every(({ session }) => names.has(session));
          if (owned) {
            importOk = true;
            trace("swarm_import_adopted_running", { attempt, sessions: [...names].sort() });
            break;
          }
        }
        // BOTH signals must say success: an ok body over a nonzero curl exit
        // is a transport anomaly worth the remaining attempts, not a break.
        if (importOk && imp.exitCode === 0) break;
        trace("swarm_import_retry", { attempt, exitCode: imp.exitCode, body: imp.stdout.slice(0, 300) });
      }
      if (imp.exitCode !== 0 || !importOk) {
        throw new Error(
          `rig import failed (exit ${imp.exitCode}) — the finally still tears down. ` +
            `Last response: ${imp.stdout.trim().slice(0, 500) || "(empty)"}`,
        );
      }

      // ── 6. Queue the objective (identity preamble per seat finding 2) ──
      // The lead seat may live in ANY pod (the schema only guarantees it is a
      // member SOMEWHERE): resolve its session from the seeded seats, never
      // pods[0] — with a pod-2 lead, the pods[0]-prefixed session was never
      // seeded and the objective queued into the void.
      const leadSeat = seats.find((s) => s.member.id === spec.leadSeat);
      if (leadSeat === undefined) {
        // Defensive: the closed manifest schema refuses a non-member leadSeat;
        // this is the type-level backstop for direct constructors.
        throw new Error(`leadSeat '${spec.leadSeat}' is not a rigSpec member — refusing to queue the objective`);
      }
      const leadSession = leadSeat.session;
      const objectiveBody =
        `OBJECTIVE: ${spec.objective}\n\nIDENTITY: before running any rig command, run \`export OPENRIG_SESSION_NAME=${leadSession}\` (Pi seats do not receive OPENRIG_* env; without it your messages show From: <unknown sender>).`;
      const queuePayload = JSON.stringify({
        sourceSession: "qds-engine",
        destinationSession: leadSession,
        body: objectiveBody,
        nudge: true,
      });
      const q = await cli([
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

      // ── 7. Poll loop: settle on any terminal queue state, on abort throw,
      // on deadline fall back. Each poll is bounded; SWARM_MAX_STALE_POLLS
      // consecutive unreadable polls throw, so the finally still runs. ──
      let prevState: string | null = null;
      let stalePolls = 0;
      for (;;) {
        throwIfAborted(bodyCtx.signal);
        const res = await cli(["rig", "queue", "show", qid]);
        const { state, closureReason } = parseQueueShow(res.stdout);
        if (res.exitCode !== 0 || state === null) {
          stalePolls += 1;
          if (stalePolls >= SWARM_MAX_STALE_POLLS) {
            throw new Error(
              `rig queue show ${qid} unreadable ${stalePolls} polls in a row (last exit ${res.exitCode}) — aborting so teardown runs`,
            );
          }
        } else {
          stalePolls = 0; // a readable state resets the streak
        }
        if (state !== prevState) {
          trace("swarm_qitem_transition", { qid, from: prevState, to: state, closureReason });
          prevState = state;
        }
        if (state !== null && TERMINAL_QUEUE_STATES.has(state)) {
          settled = state === "done"
            ? { reason: "lead-closed", state, closureReason }
            : { reason: "queue-terminal", state, closureReason };
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
      // every exit path attributes spend before the seeded state is destroyed.
      // Best-effort per seat AND per file: one torn JSONL degrades to partial,
      // never skips teardown. ──
      const seq = deps.invocationSeqByAgent ?? new Map<string, number>();
      const emitMoney = deps.emitMoneyLine ?? defaultStderrMoney;
      for (const { member, session } of seats) {
        try {
          const sessionsDir = path.join(rigHome, "state", "pi", session, "sessions");
          let jsonls: string[];
          try {
            jsonls = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
          } catch {
            continue; // no session dir = the seat never spoke; not a failure
          }
          let seatTotal = 0;
          for (const f of jsonls) {
            try {
              // Rotated/multi-session usage ALL attributes: every .jsonl is
              // parsed and summed, read off the event loop (async, not sync).
              const text = await Bun.file(path.join(sessionsDir, f)).text();
              seatTotal += emitSeatCosts(parseSeatSessionJsonl(text, member.id, session), {
                emitMoneyLine: emitMoney,
                invocationSeqByAgent: seq,
                requestId,
                runId: bodyCtx.ctx.runId,
                phaseId: bodyCtx.phaseId,
                role: member.id,
              });
            } catch (e) {
              logLine({ step: "seat-costs", seat: session, file: f, error: errText(e) });
            }
          }
          if (jsonls.length > 0) {
            trace("swarm_seat_cost", { session, files: jsonls.length, totalMicroUsd: seatTotal, role: member.id });
          }
        } catch (e) {
          logLine({ step: "seat-costs", seat: session, error: errText(e) });
        }
      }

      // ── 9. Teardown ALWAYS runs, fixed order, each step best-effort, and
      // RIG-SCOPED: this rig's down + tmux sessions + seeded state, and the
      // daemon only if THIS run started it — kill-server/daemon-stop are
      // box-global and would destroy a concurrent run. ──
      try {
        await cliTeardown(["rig", "down", rig.name, "--delete", "--force"]);
      } catch (e) {
        logLine({ step: "teardown", argv: `rig down ${rig.name} --delete --force`, error: errText(e) });
      }
      // Kill only this rig's tmux sessions (`...@<rig.name>`); no tmux server
      // running is not a failure.
      try {
        const ls = await cliTeardown(["tmux", "list-sessions", "-F", "#{session_name}"]);
        if (ls.exitCode === 0) {
          const suffix = `@${rig.name}`;
          for (const name of ls.stdout.split("\n").map((s) => s.trim()).filter((n) => n.endsWith(suffix))) {
            try {
              await cliTeardown(["tmux", "kill-session", "-t", name]);
            } catch (e) {
              logLine({ step: "teardown", argv: `tmux kill-session -t ${name}`, error: errText(e) });
            }
          }
        }
      } catch (e) {
        logLine({ step: "teardown", argv: "tmux list-sessions", error: errText(e) });
      }
      // The seeded state holds plaintext seat keys — remove exactly the dirs
      // this run created (per seat, not the whole state dir), post rig down.
      for (const { session } of seats) {
        try {
          fs.rmSync(path.join(rigHome, "state", "pi", session), { recursive: true, force: true });
        } catch (e) {
          logLine({ step: "teardown", argv: `rm state/pi/${session}`, error: errText(e) });
        }
      }
      if (daemonStarted) {
        try {
          await cliTeardown(["rig", "daemon", "stop"]);
        } catch (e) {
          logLine({ step: "teardown", argv: "rig daemon stop", error: errText(e) });
        }
      }
    }

    // ── 10. Settled trace AFTER teardown, then settle. Fail-closed: only a
    // lead-closed item is success — a timeout fallback means the swarm was
    // never verified, and any other terminal queue state is a failure. The
    // gate still renders a verdict; hard failures threw above. ──
    trace("swarm_settled", {
      reason: settled!.reason,
      qid,
      state: settled!.state ?? null,
      closureReason: settled!.closureReason ?? null,
      timeoutFallback: settled!.reason === "timeout-fallback",
    });
    return { exitStatus: settled!.reason === "lead-closed" ? "success" : "fail" };
  };
}

const defaultStderrLog = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

const defaultStderrMoney = (line: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(line)}\n`);
};

const defaultRun: CmdRunner = async (argv, opts) => {
  // Both bounds reach the spawned process: the per-call timeout via an
  // abort timer, the phase abort via the forwarded signal (AbortSignal.any,
  // Bun ≥ 1.1) — a hung child dies instead of hanging the run's finally.
  const signals = [opts?.signal, opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined]
    .filter((s): s is AbortSignal => s !== undefined);
  const proc = Bun.spawn(argv as string[], {
    stdout: "pipe", stderr: "pipe",
    ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};
