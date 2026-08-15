/**
 * The mechanical gate library + gate wiring (Story DF1.2).
 *
 * Gates check what is mechanically checkable; plan quality is a reviewer's
 * job (`MOD/gates.py:8`). Everything here is evidence-producing and
 * source-agnostic: artifact existence, non-emptiness, JSON parse,
 * diff-matches-claims, review self-consistency, and the `commandGate`
 * factory (in `command-gate.ts`).
 *
 * Wiring rule (AC4): a failing *block* does not fail the phase — the runner
 * did its job, the CODE is what failed (`MOD/quality.py:216-219`). A failing
 * *gate* does: `gatedBody` runs the body, records every gate's report through
 * DF1.1's `PhaseJournal` port, and throws out of the phase body once a gate
 * is `passed: false` — landing in DF1.1's `except` branch, which leaves the
 * phase `fail`. Gates are not a reporting side channel.
 */
import * as path from "node:path";
import { redactSecrets } from "../../../cli-anything/src/redact.ts";
import type { Envelope } from "../envelopes/types.ts";
import type { PhaseJournal } from "../journal.ts";
import { readArtifactBeneathRoot } from "../manifest.ts";
import type { PhaseBody, PhaseBodyContext } from "../phase.ts";
import { GateReport } from "./report.ts";

/** What a gate runs against. `runRoot` is the same pinned root the phase used (INV-3). */
export interface GateContext {
  runRoot: string;
  /** The env the examined subprocess was spawned with — redaction input (INV-2). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Gate {
  /** Legible in `gate_pass`/`gate_fail` events (SSSF's `gate.__name__`). */
  name: string;
  run(envelope: Envelope | undefined, ctx: GateContext): GateReport | Promise<GateReport>;
}

/** `f"{n}B"` under 1024, else one-decimal KB (`MOD/gates.py:22-24`). */
function size(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

/**
 * Read one declared artifact through DF1.1's beneath-root walk. Envelope
 * artifact strings are run-root-relative, so they are resolved against the
 * pinned root before the walk — an absolute path still walks the same four
 * steps and is still refused if it lands outside the root. Any refusal —
 * missing, outside the pinned root, unverifiable descriptor — surfaces as a
 * failed check, never as a skip (INV-5).
 */
function readArtifact(item: string, runRoot: string): { size: number; text: string } {
  const candidate = path.isAbsolute(item) ? item : path.resolve(runRoot, item);
  const { bytes, size: statSize } = readArtifactBeneathRoot(candidate, runRoot);
  return { size: statSize, text: bytes.toString("utf8") };
}

function existenceGate(
  name: string,
  field: "artifacts" | "changedFiles",
  failNote: string,
): Gate {
  return {
    name,
    run(envelope: Envelope | undefined, ctx: GateContext) {
      const report = new GateReport();
      for (const item of envelope?.[field] ?? []) {
        try {
          const { size: bytes } = readArtifact(item, ctx.runRoot);
          report.check(item, true, `exists, ${size(bytes)}`);
        } catch {
          report.check(item, false, failNote);
        }
      }
      return report;
    },
  };
}

/** Every declared artifact exists; size is the evidence (`MOD/gates.py:27-33`). */
export const artifactsExist: Gate = existenceGate(
  "artifactsExist",
  "artifacts",
  "declared artifact does not exist",
);

/** Every file claimed changed exists (`MOD/gates.py:61-68`). */
export const diffMatchesClaims: Gate = existenceGate(
  "diffMatchesClaims",
  "changedFiles",
  "claimed changed file does not exist",
);

/** Artifacts that exist are non-empty; existence is `artifactsExist`'s job (`MOD/gates.py:36-44`). */
export const filesNonEmpty: Gate = {
  name: "filesNonEmpty",
  run(envelope: Envelope | undefined, ctx: GateContext) {
    const report = new GateReport();
    for (const item of envelope?.artifacts ?? []) {
      let stat: { size: number };
      try {
        stat = readArtifact(item, ctx.runRoot);
      } catch {
        continue;
      }
      report.check(item, stat.size > 0, stat.size <= 0 ? "declared artifact is empty" : size(stat.size));
    }
    return report;
  },
};

/** `.json` artifacts parse; the note names the parsed type (`MOD/gates.py:47-58`). */
export const jsonParses: Gate = {
  name: "jsonParses",
  run(envelope: Envelope | undefined, ctx: GateContext) {
    const report = new GateReport();
    for (const item of envelope?.artifacts ?? []) {
      if (!item.endsWith(".json")) continue;
      let text: string;
      try {
        text = readArtifact(item, ctx.runRoot).text;
      } catch {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        const typeName =
          parsed === null
            ? "null"
            : Array.isArray(parsed)
              ? "array"
              : typeof parsed;
        report.check(item, true, `parses, ${typeName}`);
      } catch (err) {
        // The parse error can echo the artifact's own text, so the note is
        // redacted like every other journal-bound string (INV-2).
        const raw = err instanceof Error ? err.message : String(err);
        const note = redactSecrets(raw, ctx.env ?? {});
        report.check(item, false, `declared JSON artifact does not parse: ${note}`);
      }
    }
    return report;
  },
};

/**
 * The envelope judged against itself, without reading a line of the diff
 * (`MOD/gates.py:71-95`). An approval that ships blocking items, an approval
 * over an unmet requirement, or a rejection that names no problem, is a claim
 * the harness can refute (AC3). INV-5: an envelope claiming nothing (absent
 * `approved`) is refuted, not waved through.
 */
export const verdictConsistent: Gate = {
  name: "verdictConsistent",
  run(envelope: Envelope | undefined) {
    const report = new GateReport();
    const approved = envelope?.approved ?? false;
    const blocking = envelope?.blocking ?? [];
    const unmet = (envelope?.findings ?? []).filter((f) => !f.met);

    report.check(
      "approved vs blocking",
      !(approved && blocking.length > 0),
      blocking.length === 0
        ? "no blocking items"
        : approved
          ? `${blocking.length} blocking item(s) while approved=true`
          : `${blocking.length} blocking item(s), not approved`,
    );
    report.check(
      "approved vs findings",
      !(approved && unmet.length > 0),
      unmet.length === 0
        ? "every requirement met"
        : approved
          ? `${unmet.length} unmet requirement(s) while approved=true`
          : `${unmet.length} unmet requirement(s), not approved`,
    );
    const namesProblem = blocking.length > 0 || unmet.length > 0;
    report.check(
      "rejection names a problem",
      approved || namesProblem,
      approved || namesProblem
        ? "verdict is supported"
        : "approved=false but no blocking item or unmet requirement was given",
    );
    return report;
  },
};

/** Raised by `gatedBody` when a registered gate is `passed: false` — fails the phase (AC4). */
export class GateFailureError extends Error {
  constructor(
    message: string,
    readonly violations: string[],
  ) {
    super(message);
    this.name = "GateFailureError";
  }
}

function looksLikeEnvelope(value: unknown): value is Envelope {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export interface GatedBodyOptions<T> {
  /** How the body's value becomes the envelope the gates examine. */
  toEnvelope?: (value: T) => Envelope | undefined;
  /** Gate attempt number; DF1.3's retry loop owns values above 1. */
  attempt?: number;
}

/**
 * Composes gates onto a phase body: run the body, examine the envelope,
 * persist one `gate_pass`/`gate_fail` event per gate through DF1.1's
 * `PhaseJournal` port, then throw `GateFailureError` out of the phase body if
 * any gate is `passed: false`. Reports are never merged across gates — each
 * registered gate yields its own report and its own event.
 *
 * The registration seam for the existing verifiers (P0.5 pi-lens, P0.6 lsp,
 * P1.7 post-edit diagnostics): they plug in as `commandGate([...argv])` with
 * zero edits to their scripts.
 */
export function gatedBody<T>(
  journal: PhaseJournal,
  gateCtx: GateContext,
  gates: readonly Gate[],
  opts?: GatedBodyOptions<T>,
): (body: PhaseBody<T>) => PhaseBody<T> {
  return (body: PhaseBody<T>): PhaseBody<T> => async (bodyCtx: PhaseBodyContext) => {
    const value = await body(bodyCtx);
    const envelope =
      opts?.toEnvelope !== undefined
        ? opts.toEnvelope(value)
        : looksLikeEnvelope(value)
          ? (value as Envelope)
          : undefined;

    const failures: string[] = [];
    for (const gate of gates) {
      const started = performance.now();
      let report: GateReport;
      try {
        report = await gate.run(envelope, gateCtx);
      } catch (err) {
        // Fail closed: a gate that could not run is a failed check, never a
        // skip (INV-5).
        report = new GateReport().check(
          gate.name,
          false,
          `gate error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const gateExecMs = performance.now() - started;
      // Measure report derivation: violations shallow copy + checks map copy.
      const reportStarted = performance.now();
      const violations = report.violations;
      const checks = report.checks.map((c) => ({ ...c }));
      const gateReportMs = performance.now() - reportStarted;
      // Sub-millisecond work may round to 0; that's observably accurate.
      journal.writeGateEvent({
        runId: bodyCtx.ctx.runId,
        phaseId: bodyCtx.phaseId,
        type: report.passed ? "gate_pass" : "gate_fail",
        name: gate.name,
        requestId: bodyCtx.ctx.requestId,
        phase: bodyCtx.params.name,
        attempt: opts?.attempt ?? 1,
        gate_exec_ms: Math.round(gateExecMs),
        gate_report_ms: Math.round(gateReportMs),
        violations,
        checks,
      });
      // Keyed on `passed`, not on violations: a zero-check report is
      // `passed: false` with an EMPTY violations list (INV-5), and it must
      // still fail the phase.
      if (!report.passed) {
        failures.push(
          ...(violations.length > 0
            ? violations
            : [`${gate.name}: examined nothing`]),
        );
      }
    }
    if (failures.length > 0) {
      throw new GateFailureError(
        `phase '${bodyCtx.params.name}' failed gate(s):\n- ${failures.join("\n- ")}`,
        failures,
      );
    }
    return value;
  };
}
