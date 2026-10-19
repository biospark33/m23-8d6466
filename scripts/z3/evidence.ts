/**
 * Z3 leg-evidence writer — the ONE place a leg JSON reaches disk.
 *
 * Mirrors sc2-harness.ts `writeEvidence` (plain-object guard, writer-owned
 * `swarmclawForkRev` stamp refused from the caller at any depth, secret
 * scrub that fails the write, 'wx' flag) with the Z3 additions:
 *  - the writer also owns `leg` / `origin` / `writtenAt` — `origin` names the
 *    leg's own driver function, `writtenAt` and the filename stamp come from
 *    ONE Date, so a file renamed or rebuilt post-hoc no longer agrees with
 *    itself (AC1's hand-copied/reconstructed negative control);
 *  - every write registers the sha256 of the exact bytes on disk under its
 *    filename, so the round can prove each file is still what its driver wrote;
 *  - required leg fields (`exitCode`/`stdoutTail`/`stderrTail`/`observability`)
 *    are checked before anything lands.
 *
 * `live-harness.ts` stays un-stamping (Z1 AC7) and `sc2-harness.ts` owns the
 * openrig-sc2 stamp; both are fenced, so this writer is Z3's own.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Z3EvidenceLeg } from "./round-plan.ts";

/**
 * Each leg's driver, as the writer LABELS it. A label, not a provenance proof:
 * any caller of the writer gets the label for the leg it names. What proves a
 * file came from its driver is the sha256 registry (and the committed round
 * manifest built from it) — a hand-made or edited file is not in it.
 */
export const Z3_LEG_ORIGIN: Readonly<Record<Z3EvidenceLeg, string>> = {
  trigger: "scripts/z3/leg-drivers.ts driveTrigger",
  "kill-and-provision": "scripts/z3/leg-drivers.ts driveKillAndProvision",
  "box-forensics": "scripts/z3/leg-drivers.ts driveBoxForensics",
  "qa-run-observe": "scripts/z3/leg-drivers.ts driveQaRunObserve",
  "findings-retain": "scripts/z3/leg-drivers.ts driveFindingsRetain",
  "priming-recall": "scripts/z3/leg-drivers.ts drivePrimingRecall",
  "observe-read-only": "scripts/z3/leg-drivers.ts driveObserveReadOnly",
  "approval-park": "scripts/z3/leg-drivers.ts driveApprovalPark",
  approve: "scripts/z3/leg-drivers.ts driveApprove",
  "branch-and-complete": "scripts/z3/leg-drivers.ts driveBranchAndComplete",
  "crash-window-redrive": "scripts/z3/leg-drivers.ts driveCrashWindowRedrive",
  cleanup: "scripts/z3/leg-drivers.ts runCleanup",
  "round-manifest": "scripts/z3/leg-drivers.ts writeRoundManifest",
};

export interface EvidenceSink {
  outDir: string;
  /** The fork rev the round runs against (Z1 drift-alarm stamp). */
  forkRev: string;
  /** filename → sha256 of the bytes this writer put on disk. */
  registry: Map<string, string>;
  now?: () => Date;
  /** Env-carried secret VALUES with no recognizable shape (scrubbed by value). */
  knownSecrets?: readonly string[];
}

const WRITER_OWNED = ["leg", "origin", "writtenAt"] as const;

// Scrub arms: [pattern, replacement]. Bearer before the generic shapes so the
// scheme word survives for the reader.
const SCRUB: ReadonlyArray<[RegExp, string]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"]+:[^\s/@"]+@/gi, "$1[REDACTED-USERINFO]@"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
  [/sk-or-[A-Za-z0-9_-]+/g, "[REDACTED-KEY]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED-KEY]"],
  [/\b(?:z3tok|sc27tok)-[A-Za-z0-9]+/g, "[REDACTED-APPROVER-TOKEN]"],
  [/\bmgat\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED-AGENT-TOKEN]"],
  [/\bmgrun-[A-Za-z0-9_-]+/g, "[REDACTED-RUN-KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED-KEY]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-KEY]"],
];

// Detection is deliberately WIDER than the scrub (bare prefixes count): a
// shape the scrub could not remove must refuse the write, not land.
const DETECT: ReadonlyArray<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/(?!\[REDACTED-USERINFO\]@)[^\s/@:"]+:[^\s/@"]+@/i, "credentialed URL (user:secret@)"],
  [/\bbearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/i, "bearer token"],
  [/sk-or-/, "openrouter key (sk-or-…)"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "generic api key (sk-…)"],
  [/\b(?:z3tok|sc27tok)-/, "approver token"],
  [/\bmgat\.[A-Za-z0-9_-]+\./, "memory agent token (mgat.…)"],
  [/\bmgrun-/, "memory run key (mgrun-…)"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "github token (gh[pousr]_…)"],
  [/\bgithub_pat_/, "github pat (github_pat_…)"],
];

export function scrubText(s: string, knownSecrets: readonly string[] = []): string {
  let out = s;
  // Known VALUES first: a shape regex that redacts only a secret's head would leave its tail unmatchable.
  for (const secret of knownSecrets) if (secret !== "") out = out.split(secret).join("[REDACTED-ENV]");
  for (const [re, rep] of SCRUB) out = out.replace(re, rep);
  return out;
}

/** Pattern NAMES that match — never the matched bytes (a leak report must not compound the leak). */
export function credentialHits(text: string, knownSecrets: readonly string[] = []): string[] {
  const hits = DETECT.filter(([re]) => re.test(text)).map(([, name]) => name);
  if (knownSecrets.some((s) => s !== "" && text.includes(s))) hits.push("env-carried secret value");
  return hits;
}

function scrubDeep(v: unknown, known: readonly string[]): unknown {
  if (typeof v === "string") return scrubText(v, known);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, known));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[scrubText(k, known)] = scrubDeep(val, known);
    return out;
  }
  return v;
}

/** Fails CLOSED past depth 10 (sc2-harness round-2 review): a deeper stamp must not slip the guard. */
function hasStampDeep(value: object, depth = 0): boolean {
  if ("swarmclawForkRev" in value) return true;
  if (depth >= 10) throw new Error("evidence payload exceeds the supported stamp-scan depth");
  return Object.values(value).some((v) => typeof v === "object" && v !== null && hasStampDeep(v, depth + 1));
}

/** `2026-10-19T12-34-56-789Z` — the openrig-sc2 filename stamp. */
export function dashStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Writes one leg JSON; returns its path. Throws (nothing lands) on any refusal. */
export function writeZ3Evidence(sink: EvidenceSink, leg: Z3EvidenceLeg, payload: Record<string, unknown>): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`evidence payload must be a plain object — got ${Array.isArray(payload) ? "Array" : typeof payload}`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(sink.forkRev)) {
    throw new Error(`fork rev ${JSON.stringify(sink.forkRev)} is not a rev — the round must name the fork rev it ran against`);
  }
  if (hasStampDeep(payload)) {
    throw new Error("payload carries swarmclawForkRev — the writer owns the stamp at any depth; a caller-supplied stamp would launder a recorded rev");
  }
  for (const k of WRITER_OWNED) {
    if (k in payload) throw new Error(`payload carries ${k} — a writer-owned field (the leg's identity is the writer's, never the caller's)`);
  }
  if (!Number.isInteger(payload.exitCode)) throw new Error(`leg ${leg}: exitCode must be an integer`);
  if (typeof payload.stdoutTail !== "string" || typeof payload.stderrTail !== "string") {
    throw new Error(`leg ${leg}: stdoutTail and stderrTail must be strings`);
  }
  const obs = payload.observability;
  if (!Array.isArray(obs) || obs.length === 0 || !obs.every((l) => typeof l === "string")) {
    throw new Error(`leg ${leg}: observability must be a non-empty array of log lines`);
  }
  const at = (sink.now ?? (() => new Date()))();
  const known = sink.knownSecrets ?? [];
  const stamped = {
    leg,
    origin: Z3_LEG_ORIGIN[leg],
    ...(scrubDeep(payload, known) as Record<string, unknown>),
    writtenAt: at.toISOString(),
    swarmclawForkRev: sink.forkRev,
  };
  const body = `${JSON.stringify(stamped, null, 2)}\n`;
  const hits = credentialHits(body, known);
  if (hits.length > 0) throw new Error(`evidence ${leg} failed the secret scrub — ${hits.join("; ")} survived — refusing to write`);
  mkdirSync(sink.outDir, { recursive: true });
  const name = `${dashStamp(at)}-z3-${leg}.json`;
  const file = join(sink.outDir, name);
  try {
    writeFileSync(file, body, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`evidence write collision: ${file} already exists (same-millisecond same-leg write)`);
    }
    throw e;
  }
  sink.registry.set(name, sha256(body));
  return file;
}
