/**
 * The `commandGate` factory (Story DF1.2).
 *
 * Wraps any argv-spawned subprocess as a gate: exit 0 required, and on
 * failure the exit code plus the last 1,000 characters of stdout+stderr ride
 * along as the note (`MOD/gates.py:98-108`, hardening: argv array, never a
 * shell string — INV-1). A subprocess that cannot be spawned at all is a
 * failed check naming the error, never a pass and never a skip (AC5).
 *
 * This is the registration seam for the existing verifiers — P0.5's
 * `scripts/pi-lens-verify.ts` and P0.6's `scripts/lsp-verify.ts` plug in as
 * `commandGate([process.execPath, "scripts/lsp-verify.ts", ...])` with zero
 * edits: exit code as the check, redacted stdout tail as the note.
 */
import { redactSecrets } from "../../../cli-anything/src/redact.ts";
import type { Envelope } from "../envelopes/types.ts";
import type { Gate, GateContext } from "./library.ts";
import { GateReport } from "./report.ts";

/** Command output kept as evidence on a failure (`MOD/gates.py:19`). */
export const GATE_NOTE_TAIL_CHARS = 1_000;

export interface CommandGateOptions {
  /**
   * The env the subprocess is spawned with. Also the redaction input for the
   * note (INV-2): `redactSecrets` is parent-env-derived, so the gate must be
   * handed the same env map the subprocess saw. Omit to inherit the parent
   * process env.
   */
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  /** Short legible name for events; defaults to the joined argv. */
  label?: string;
}

function parentEnvStrings(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

function spawnErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function commandGate(argv: string[], opts: CommandGateOptions = {}): Gate {
  const name = `commandGate(${opts.label ?? argv.join(" ")})`;
  return {
    name,
    async run(_envelope: Envelope | undefined, ctx: GateContext): Promise<GateReport> {
      const report = new GateReport();
      const item = opts.label ?? argv.join(" ");
      const signal = opts.signal ?? ctx.signal;

      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        // INV-1: argv array, never a shell string. The argv originates from a
        // schema-validated manifest command or repo code at the registration
        // site — never from agent output or an envelope field.
        proc = Bun.spawn(argv, {
          ...(opts.env !== undefined ? { env: opts.env } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(signal !== undefined ? { signal } : {}),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        return report.check(item, false, `spawn error: ${spawnErrorMessage(err)}`);
      }

      let exitCode: number;
      let stdout = "";
      let stderr = "";
      try {
        [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
      } catch (err) {
        // A binary that vanishes mid-spawn can fail here rather than at the
        // Bun.spawn call; it is the same AC5 case.
        return report.check(item, false, `spawn error: ${spawnErrorMessage(err)}`);
      }

      if (exitCode === 0) return report.check(item, true, "exit 0");
      // INV-2: redact the FULL output before cutting the tail window — a
      // secret straddling the cut no longer matches the full-value pattern,
      // so truncating first would leak its partial suffix into the journal.
      // (Same order as the envelope adapter; `exitCode` is null when the
      // process died by signal, which fails closed as a non-zero exit.)
      const redactionEnv = opts.env ?? ctx.env ?? parentEnvStrings();
      const code = exitCode ?? -1;
      const tail = redactSecrets(`${stdout}${stderr}`, redactionEnv).slice(
        -GATE_NOTE_TAIL_CHARS,
      );
      return report.check(item, false, `exit ${code}\n${tail}`);
    },
  };
}
