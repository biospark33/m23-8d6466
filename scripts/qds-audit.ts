#!/usr/bin/env bun
/**
 * CLI: qds-audit — the operator surface of the audit chain walk (DF5.3).
 *
 * Usage:
 *   qds-audit <pr-url|qds/<run-id>|runId> [--json] [--runs-dir <dir>]
 *             [--audit-db <path>] [--ledger <path>] [--reverify-dir <dir>]
 *
 * Walks one merged PR (or its run) back through every host-side record that
 * authorized it: `walkAuditChain` resolves the ten hops per contributing
 * runId; this command renders them.
 *
 * Exit matrix (BINDING — CI and the DF5.4-C9 fixture harness branch on it):
 *   0  a ChainReport was produced and the chain is COMPLETE — or `--help` was
 *      asked for and no walk happened. Help is recognised ONLY in a flag
 *      position (see `helpRequested`), so a seam missing its value can never
 *      reach it and be reported as a verified chain.
 *   1  a ChainReport was produced and it is INCOMPLETE  (the ONLY source of 1)
 *   2  no COMPLETE report reached stdout (a partial one may have — under a 2,
 *      stdout is never a report): usage error, an unusable seam path, an
 *      unresolvable ref, any `ChainWalkError`, any other fault during the walk
 *      (a missing runs dir, a corrupt store, a `gh` read that throws), a walk
 *      whose broken hops describe the ENVIRONMENT rather than the chain, or a
 *      report that could not be written in FULL. An environment fault must
 *      never be reported as "the audit chain is broken".
 *
 * That last pair are the two defences this file adds on top of the walker.
 * (a) `environmentFaults` re-reads the produced report: the walker OWNS the
 * classification (it rethrows store-open / ledger-open / spawn faults as a
 * `ChainWalkError`), but a walker that scores one of those against the chain
 * instead — an older `src/audit` behind a newer CLI, a DF5.4-C9 fixture report
 * — would otherwise reach `return … 1`, i.e. "this PR's chain is BROKEN",
 * which the matrix above exists to forbid. (b) every write goes through
 * `writeAll`: `writeSync` returns a SHORT count on a full pipe and the dropped
 * remainder is invisible, so a fixture harness would read half a JSON object
 * under exit 0. A REPORT that cannot be written in full is not a report (2);
 * a DIAGNOSTIC that cannot be written never changes the outcome it describes
 * (`writeBestEffort`) — the split `scripts/fleet.ts` states and the other
 * three CLIs follow.
 *
 * `--json` prints the ChainReport and NOTHING else on stdout; every
 * observability line (the walker's per-hop lines plus one final verdict line
 * here — the walker already logs per hop, so this CLI adds only the verdict)
 * goes to stderr. That guarantee is installed by `run()` itself, not by the
 * `import.meta.main` bootstrap, because `run()` is exported for harnesses.
 * All four store paths are explicit seams: an operator (or the DF5.4-C9 frozen
 * fixture) points them at a fixture set and the walk never touches the
 * developer's own `.sandbox/`. Overriding only SOME of them is legal but
 * warned about — a fixture run record joined against a live ledger is a
 * confidently wrong verdict.
 *
 * INV-AUDIT-2 is the WALKER's duty: it decides which fields enter a hop's
 * `detail`, and `--json` serialises the report verbatim (DF5.4-C9 imports it,
 * so this renderer must not allow-list it). What this file adds is a NARROWING
 * for humans: `describeHop` prints `key_hash` and its 8-char prefix and no
 * other credential field, and it adds no field the walker did not carry.
 */

import { statSync, writeSync } from "node:fs";
import { resolve } from "node:path";

import {
  AUDIT_HOPS,
  ChainWalkError,
  chainVerdict,
  DEFAULT_AUDIT_DB_FILE,
  walkAuditChain,
  type ChainReport,
  type HopOutcome,
} from "../src/audit/index.ts";
import { DEFAULT_COST_LEDGER_FILE } from "../src/providers/cost-ledger.ts";
import { resolveRunsDir } from "../src/providers/run-record.ts";
import { DEFAULT_REVERIFY_DIR } from "../src/reverify/report.ts";
import { log, newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";

const USAGE =
  "Usage: qds-audit <pr-url|qds/<run-id>|runId> [--json] [--runs-dir <dir>] [--audit-db <path>] [--ledger <path>] [--reverify-dir <dir>]";

const HELP = [
  USAGE,
  "",
  "  <ref>                   a merged PR URL, its qds/<run-id> branch, or the bare run id",
  "",
  "  --json                  print the ChainReport on stdout and nothing else",
  "  --runs-dir <dir>        run-record directory (default $QDS_RUNS_DIR)",
  "  --audit-db <path>       audit-links store (default $QDS_AUDIT_DB or .sandbox/audit.db)",
  "  --ledger <path>         cost ledger (default $QDS_COST_LEDGER_FILE)",
  "  --reverify-dir <dir>    re-verify record directory (default .sandbox/reverify)",
  "",
];

/**
 * The four STORE SEAMS: the kind of thing each must name, and whether its
 * ABSENCE is a typo or a walk input. The partial-override warning and the
 * pre-walk check both derive from this one table — `fallen.length <
 * VALUE_FLAGS.length` was only correct while every value flag happened to be a
 * seam, so the first non-seam value flag (`--format`, `--timeout-ms`) would
 * have fired the "fixture joined against a live store" warning on EVERY
 * default invocation and trained operators to ignore it.
 *
 * Only `--runs-dir` is `must-exist`, and deliberately so. For the other three
 * an absent path is a legitimate INPUT the walk has an answer for, and
 * refusing it here would replace an audit finding with a usage error: a run
 * that was never re-verified has no `<reverifyDir>` and hop 7 reporting that
 * IS the audit (exit 1, the true verdict), while an absent `--audit-db` /
 * `--ledger` is the walker's own typed refusal, which names the env var that
 * set it and which N5 escalates to 2 anyway. A WRONG-KIND path is always a
 * typo, so that half is checked for all four.
 */
const SEAMS = [
  ["runsDir", "--runs-dir", "directory", "must-exist"],
  ["auditDb", "--audit-db", "file", "may-be-absent"],
  ["ledger", "--ledger", "file", "may-be-absent"],
  ["reverifyDir", "--reverify-dir", "directory", "may-be-absent"],
] as const;
type SeamKey = (typeof SEAMS)[number][0];

const VALUE_FLAGS = SEAMS.map(([, flag]) => flag) as readonly string[];
const BOOL_FLAGS = ["--json"] as const;

/**
 * writeSync can write SHORT; a truncated report is worse than a slow one. The
 * same loop `scripts/qds-cost.ts`, `scripts/fleet.ts`, `scripts/pipeline-run.ts`
 * and `src/providers/harvest.ts` each carry — including the zero-length arm,
 * which is not a retryable short write but fd 1/2 left non-blocking (a CI
 * runner, a wrapper), surfaced as the EAGAIN it is so the guarded call sites
 * decide the outcome instead of spinning forever.
 *
 * ponytail: a FIFTH copy, because all four existing ones are module-private to
 * files this cluster may not edit. The lazy fix is one `scripts/lib/` export
 * replacing all five — a shared-file change, so it is recorded, not taken here.
 */
function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error(`fd ${fd} accepted 0 of ${buf.length - off} bytes`), { code: "EAGAIN" });
    off += n;
  }
}

/**
 * A DIAGNOSTIC write never changes the outcome it reports on: a throw out of
 * the log sink or out of `fail` escapes every envelope in `run()` and would
 * replace a classified refusal (already mapped to its exit code) with a bare
 * crash — the same posture `fleet.ts`'s sink and `qds-cost.ts` take.
 */
function writeBestEffort(fd: number, s: string): void {
  try {
    writeAll(fd, s);
  } catch {
    // Nothing left to report it to.
  }
}

export interface ParsedAuditArgs {
  ref: string;
  json: boolean;
  /** `--help`/`-h` in a FLAG position: print the help block, walk nothing. `ref` is then meaningless. */
  help?: true;
  runsDir?: string;
  auditDb?: string;
  ledger?: string;
  reverifyDir?: string;
}

/**
 * Is one of these flag tokens a help REQUEST rather than a seam's value?
 *
 * The check used to run on raw argv inside `walkAndRender`, so `qds-audit <ref>
 * --ledger --help` — a value flag missing its value, a documented exit-2 usage
 * error — printed help and returned 0, which the binding matrix defines as "a
 * ChainReport was produced and the chain is COMPLETE". `--runs-dir -h` was
 * worse: `tokenizeArgs` exempts `-h` from `rejectStraySingleDash`, so it
 * survived as a legal value continuation and STILL matched.
 *
 * Pairing rule: mirror `parseValueFlags` exactly — a value flag consumes the
 * next token whatever it is, so a token sitting in a value position is never
 * help. (`--ledger --help` therefore falls through to `parseValueFlags`, which
 * owns the missing-value error; `--runs-dir -h` becomes the literal seam value
 * `-h`, which `seamProblems` then refuses with the path echoed.)
 */
function helpRequested(flagTokens: readonly string[]): boolean {
  for (let i = 0; i < flagTokens.length; i++) {
    const t = flagTokens[i] as string;
    if (VALUE_FLAGS.includes(t)) {
      i++; // its value, whatever it looks like
      continue;
    }
    if (t === "--help" || t === "-h") return true;
  }
  return false;
}

export function parseAuditArgs(argv: readonly string[]): ParsedAuditArgs {
  // rejectStraySingleDash: a single-dash token is never legal here (one
  // positional, no value starts with `-`). Without it `-j` / `-runs-dir=/fix`
  // are DROPPED and the walk silently falls back to the real store paths —
  // the exact failure the seams exist to prevent.
  const { positionals, flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: BOOL_FLAGS,
    rejectStraySingleDash: true,
  });
  // BEFORE parseValueFlags, which would otherwise answer `--help` itself with
  // `writeSync(1, …)` + `process.exit(0)` — fatal for the exported `run()` (it
  // tears down the harness process) and a breach of the `--json` stdout
  // guarantee. Help is this file's to render, on the fd `--json` allows.
  if (helpRequested(flagTokens)) return { ref: "", json: bools.has("--json"), help: true };
  // `--json=true` reached `parseValueFlags`'s `=` branch, whose membership test
  // is against VALUE_FLAGS only, and came back `unknown flag: --json` — naming
  // a flag this CLI definitely has and sending the operator hunting for a typo
  // in a correct flag name. (The clean fix is `tokenizeArgs` learning the
  // `--boolflag=…` form; that is a shared file, so it is handled locally.)
  for (const t of flagTokens) {
    const eq = t.indexOf("=");
    if (eq > 0 && BOOL_FLAGS.includes(t.slice(0, eq) as (typeof BOOL_FLAGS)[number])) {
      throw new Error(`${t.slice(0, eq)} takes no value`);
    }
  }
  // Symmetry with the repeated-seam guard below: a parser that calls repetition
  // "a correctness problem, not a convenience" for one half of its flags and
  // silently last-wins for the other half has no rule at all. `bools` is a Set,
  // so the multiplicity has to be counted in argv — legal, because a bool flag
  // is never consumed as a value (`tokenizeArgs` matches it before any pairing).
  for (const flag of BOOL_FLAGS) {
    if (argv.filter((a) => a === flag).length > 1) throw new Error(`${flag} given more than once`);
  }
  const seams: Partial<Record<SeamKey, string>> = {};
  const seen = new Set<string>();
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      // Last-wins on a repeated seam would audit a store the operator did not
      // name first. On an audit tool that is a correctness problem, not a
      // convenience.
      if (seen.has(flag)) throw new Error(`${flag} given more than once`);
      seen.add(flag);
      // `resolve` does NOT expand `~`: a quoted `--audit-db "~/fixtures/audit.db"`
      // (or one read from a roster, where no shell expands it) became
      // `$CWD/~/fixtures/audit.db` and then a confident BROKEN chain about a
      // store nobody ever had. Refuse it instead of auditing the wrong path.
      if (value.startsWith("~")) {
        throw new Error(`${flag}: ~ is not expanded here — pass an absolute path (got ${value})`);
      }
      // Absolute: the value is reported back in the partial-seam warning and
      // compared against the defaults, both of which are absolute-ish paths.
      const p = resolve(value);
      if (flag === "--runs-dir") seams.runsDir = p;
      else if (flag === "--audit-db") seams.auditDb = p;
      else if (flag === "--ledger") seams.ledger = p;
      else if (flag === "--reverify-dir") seams.reverifyDir = p;
      else throw new Error(`unhandled value flag: ${flag}`); // VALUE_FLAGS grew without a branch
    },
    help: HELP,
  });
  // Exactly one ref. Checked AFTER the flag grammar so an unknown flag (or a
  // flag missing its value) is reported as itself instead of as a bad ref count.
  if (positionals.length !== 1) {
    throw new Error(
      positionals.length === 0
        ? "missing <pr-url|branch|runId>"
        : `expected exactly one ref, got ${positionals.length} (${positionals.join(", ")})`,
    );
  }
  return { ref: positionals[0] as string, json: bools.has("--json"), ...seams };
}

/**
 * Seams left at their default, with the path that default resolves to.
 * Mirrors `walkAuditChain`'s own fallback chain — if that moves, this moves.
 *
 * Every path is `resolve`d, like the overrides are. `DEFAULT_AUDIT_DB_FILE` and
 * `DEFAULT_REVERIFY_DIR` are the bare strings `.sandbox/audit.db` and
 * `.sandbox/reverify`, so the warning printed one absolute path beside two
 * relative ones and did not answer the single question it exists to answer:
 * which two directories is this walk joining?
 */
function seamFallbacks(args: ParsedAuditArgs): string[] {
  const fallen: string[] = [];
  if (args.runsDir === undefined) fallen.push(`--runs-dir → ${resolve(resolveRunsDir())}`);
  if (args.auditDb === undefined) {
    fallen.push(`--audit-db → ${resolve(process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE)}`);
  }
  if (args.ledger === undefined) {
    fallen.push(`--ledger → ${resolve(process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE)}`);
  }
  if (args.reverifyDir === undefined) fallen.push(`--reverify-dir → ${resolve(DEFAULT_REVERIFY_DIR)}`);
  return fallen;
}

/**
 * Overridden seams that cannot be what they were named as — a typo answered
 * with the path echoed, instead of with a confident BROKEN chain about a store
 * nobody ever had. Only the OVERRIDDEN ones are examined: the defaults are the
 * developer's own `.sandbox/`, whose ordinary states the walker classifies.
 * `--runs-dir` used to be the only seam protected at all, and only by accident
 * (`RunRecordStore` happens to throw ENOENT). See SEAMS for the must-exist /
 * may-be-absent split.
 */
function seamProblems(args: ParsedAuditArgs): string[] {
  const problems: string[] = [];
  for (const [key, flag, kind, presence] of SEAMS) {
    const path = args[key];
    if (path === undefined) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch (e) {
      if (presence === "must-exist") problems.push(`${flag} ${path}: ${(e as Error).message}`);
      continue;
    }
    if (kind === "directory" && !stat.isDirectory()) problems.push(`${flag} ${path}: not a directory`);
    if (kind === "file" && !stat.isFile()) problems.push(`${flag} ${path}: not a file`);
  }
  return problems;
}

/**
 * Broken hops whose `actual` describes the ENVIRONMENT, not the chain.
 *
 * The walker owns this classification (N5: store-open, ledger-open and spawn
 * faults are rethrown as a `ChainWalkError`, which this CLI already exits 2
 * for). This is the defence in depth for the case where it does not — an older
 * `src/audit` behind a newer CLI, or a `ChainReport` produced elsewhere —
 * because the alternative is `return … 1`, "this PR's chain is BROKEN", about a
 * store the walk could not open.
 *
 * Matched on SHAPE, not on an imported code list: `audit-store-*` is
 * `AuditStoreErrorCode`'s whole walk-reachable half, `ledger-unopenable` and a
 * leading errno (`ENOENT: …`, `EACCES`, `SQLITE_CORRUPT`) are what the ledger
 * and record readers put there, and "unhandled walk error" is the generic hop
 * catch's own diagnostic. Every genuine chain break spells its `actual` in
 * lowercase prose (`no approval entry`, `hasEvents: false`) or as JSON, so
 * none of them can collide with these.
 */
function environmentFaults(report: ChainReport): string[] {
  const faults: string[] = [];
  for (const run of Object.values(report.runs)) {
    for (const out of Object.values(run.hops as Record<string, HopOutcome | undefined>)) {
      if (out === undefined || out.status !== "broken") continue;
      if (!/^(audit-store-|ledger-unopenable$|E[A-Z]{2,}|SQLITE_)/.test(out.actual) && !out.diagnostic.startsWith("unhandled walk error")) {
        continue;
      }
      faults.push(`${out.hop}: ${out.actual} (${out.diagnostic})`);
    }
  }
  return faults;
}

/** The human block for one hop outcome — every field the union actually carries. */
export function describeHop(out: HopOutcome): string[] {
  const lines = [`status: ${out.status}`];
  switch (out.status) {
    case "resolved": {
      lines.push(`subject: ${out.subjectId}`);
      if (out.evidencePath !== undefined) lines.push(`evidence: ${out.evidencePath}`);
      if (out.evidenceDigest !== undefined) lines.push(`digest: ${out.evidenceDigest}`);
      if (out.linkId !== undefined) lines.push(`link: #${out.linkId}`);
      if (out.keyHash !== undefined) {
        // INV-AUDIT-2 narrowing: the hash and its 8-char prefix — never key material.
        lines.push(`keyHash: ${out.keyHash}`, `keyHashPrefix: ${out.keyHashPrefix ?? out.keyHash.slice(0, 8)}`);
      }
      const detail = out.detail as Record<string, unknown> | undefined;
      if (typeof detail?.totalMicroUsd === "number") {
        lines.push(`totalMicroUsd: ${detail.totalMicroUsd}`, `perRole: ${JSON.stringify(detail.perRole)}`);
      }
      break;
    }
    case "void":
    case "not-applicable":
      lines.push(out.reason);
      break;
    case "evidence-not-harvested":
      lines.push(out.reason, `evidence: ${out.evidencePath}`);
      break;
    case "unlinked":
      lines.push(`emitter: ${out.emitter}`, out.diagnostic);
      break;
    case "evidence-mismatch":
      lines.push(`expected: ${out.expectedDigest}`, `actual: ${out.actualDigest}`, `evidence: ${out.evidencePath}`);
      // Singular hops (1/7/8) additionally name both subject ids when the
      // rewrite landed in the field that FORMS the subject id.
      if (out.expectedSubjectId !== undefined) lines.push(`expectedSubject: ${out.expectedSubjectId}`);
      if (out.actualSubjectId !== undefined) lines.push(`actualSubject: ${out.actualSubjectId}`);
      break;
    case "order-violation":
      // CONSTRAINT order: `earlier` is the event the constraint requires first.
      lines.push(`constraint: ${out.constraint}`, `earlier: ${out.earlier}`, `later: ${out.later}`);
      break;
    case "hop-timeout":
      // `budget` names WHICH ceiling was exhausted — a per-hop stall and a
      // whole-walk overrun are different operator actions.
      lines.push(`elapsed: ${out.elapsedMs}ms`, `ceiling: ${out.ceilingMs}ms`, `budget: ${out.budget}`);
      break;
    case "broken":
      lines.push(`expected: ${out.expected}`, `actual: ${out.actual}`, out.diagnostic);
      if (out.evidencePath !== undefined) lines.push(`evidence: ${out.evidencePath}`);
      break;
    default: {
      // A new HopOutcome status must not render as a bare status with its
      // payload dropped — fail the BUILD. At RUNTIME it must not throw either:
      // this fires from inside `printHuman`, after the run header and some hop
      // blocks are already on stdout, so the throw left a truncated report
      // there, rejected `run()` and exited 2 — "no report was produced", which
      // is false, and which a CI job branching on the matrix reads as an
      // environment fault. Reachable whenever the walker and this file are not
      // compiled together (a published `src/audit` read by an older CLI, a
      // DF5.4-C9 fixture report). `status: <s>` is already the first line
      // above; the payload follows verbatim so nothing is dropped.
      const unreachable: never = out;
      lines.push(JSON.stringify(unreachable));
      break;
    }
  }
  return lines;
}

/**
 * The parenthetical on the `chain: BROKEN` summary line.
 *
 * `chainVerdict` is `brokenHops.length === 0 && anyResolved`, so a BROKEN
 * verdict carrying NO broken hops has two distinct causes and they need
 * different words. "no runs walked" was printed for both: a run whose every hop
 * came back `void`/`not-applicable` (none of which `breaksChain`, and none of
 * which is `resolved`) reported that nothing had been walked — while the
 * per-run block printed directly above it showed the run and its ten hops. An
 * operator reading the summary line alone concluded the ref had resolved to
 * nothing.
 *
 * Exported for the test: the zero-resolved-zero-broken state is not reachable
 * through a real walk today (every unevidenced hop resolves to something that
 * DOES break the chain), so the branch is defensive and a constructed
 * `ChainReport` is the only way to exercise it.
 */
export function brokenDetail(report: ChainReport, verdict: ReturnType<typeof chainVerdict>): string {
  // Deduped once and used for both the count and the list: two runs broken at
  // the same hop are one broken hop NAME, and the per-run blocks already show
  // the occurrences.
  const brokenHops = [...new Set(verdict.brokenHops.map((h) => h.hop))];
  if (brokenHops.length > 0) return `${brokenHops.length} broken hop(s): ${brokenHops.join(", ")}`;
  return Object.keys(report.runs).length === 0 ? "no runs walked" : "no hop resolved";
}

function printHuman(report: ChainReport, verdict: ReturnType<typeof chainVerdict>): void {
  for (const [runId, run] of Object.entries(report.runs)) {
    writeAll(1, `run ${runId}\n`);
    const hops = run.hops as Record<string, HopOutcome | undefined>;
    const printed = new Set<string>();
    const block = (hop: string, out: HopOutcome): void => {
      printed.add(hop);
      writeAll(1, `  ${hop} [${out.status}]\n`);
      for (const line of describeHop(out)) writeAll(1, `    ${line}\n`);
    };
    for (const hop of AUDIT_HOPS) {
      const out = hops[hop];
      if (out !== undefined) block(hop, out);
    }
    // Any hop the report carries that AUDIT_HOPS does not list: the verdict
    // line counts it, so it must be visible here too.
    for (const [hop, out] of Object.entries(hops)) {
      if (out !== undefined && !printed.has(hop)) block(hop, out);
    }
  }
  const where = `${report.ref}, ${report.refKind}`;
  if (verdict.complete) {
    writeAll(1, `chain: COMPLETE (${where})\n`);
    return;
  }
  writeAll(1, `chain: BROKEN (${where}; ${brokenDetail(report, verdict)})\n`);
}

/**
 * `exitWithFailure`'s stderr block without its `process.exit`: every path out
 * of `run()` returns its code so the exit matrix can be driven in-process.
 *
 * Best-effort: the code is already decided, and a throw from here would replace
 * a classified 2 with an unclassified crash.
 */
function fail(prefix: string, lines: readonly string[]): 2 {
  writeBestEffort(2, `${[prefix, ...lines.map((l) => `  - ${l}`)].join("\n")}\n`);
  return 2;
}

/**
 * Serializes the sink swap below. `setLogSink` is a MODULE-GLOBAL with a
 * save/restore discipline, so two overlapping `run()` calls interleave as
 * save(orig) · save(A) · restore(orig) · restore(A) — the first finisher
 * restores the sink the SECOND one displaced, and the caller's own sink is
 * gone for good while A's stderr writer stays installed after both returned.
 * `run` is exported precisely so a harness can drive it (and a harness driving
 * the exit matrix is exactly what runs two walks at once), so the window is
 * reachable from the API's intended use.
 *
 * ponytail: one global gate, not a per-argv one — the resource being guarded
 * IS global, and a walk is an operator-scale operation, not a hot path.
 */
let sinkGate: Promise<unknown> = Promise.resolve();

/**
 * Walk and render. RETURNS the exit code (see the matrix in the file header) —
 * it never terminates the process, so a harness can drive the matrix directly.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const mine = sinkGate.then(async () => {
    // Structured logs to stderr so stdout carries only the command's output.
    // Installed here rather than under `import.meta.main`: `run` is exported
    // precisely so a harness can drive it, and the --json stdout guarantee must
    // hold for that caller too. writeSync, not process.stderr.write: the latter
    // is async for pipes/files and our caller may exit before it drains.
    const restoreSink = setLogSink((entry) => {
      writeBestEffort(2, `${JSON.stringify(entry)}\n`);
    });
    try {
      return await walkAndRender(argv);
    } finally {
      restoreSink();
    }
  });
  // The GATE swallows the rejection (a failed walk must not wedge every later
  // one); the CALLER still gets `mine` verbatim, rejection and all.
  sinkGate = mine.catch(() => undefined);
  return mine;
}

async function walkAndRender(argv: readonly string[]): Promise<number> {
  let args: ParsedAuditArgs;
  try {
    args = parseAuditArgs(argv);
  } catch (e) {
    return fail("!! usage error", [USAGE, (e as Error).message]);
  }
  if (args.help === true) {
    // fd 2 under --json: the header binds --json to "the ChainReport and
    // NOTHING else on stdout", and a consumer's JSON.parse must not be handed a
    // help block. Best-effort — help is a diagnostic, and a failed write must
    // not turn a help request into a fault.
    writeBestEffort(args.json ? 2 : 1, HELP.join("\n"));
    return 0;
  }
  const badSeams = seamProblems(args);
  if (badSeams.length > 0) {
    return fail("!! seam-unusable", [
      ...badSeams,
      "next: fix the path(s) above — an overridden seam that is not there is a typo, not a broken chain",
    ]);
  }
  const ref = args.ref;
  const startedAt = Date.now();
  const requestId = newRequestId();

  const fallen = seamFallbacks(args);
  if (fallen.length > 0 && fallen.length < SEAMS.length) {
    // Some seams point at a fixture and some do not: the walk joins fixture
    // records against live stores. Legal (DF5.4-C9 may override a subset) but
    // never silent.
    log({
      requestId, operation: "audit-chain.seams", agentId: null,
      timestamp: new Date().toISOString(), duration: 0, status: "ok",
      warning: `seam(s) left at their default while others were overridden: ${fallen.join("; ")}`,
      ref,
    });
  }

  let report: ChainReport;
  try {
    // NOTHING TO CLOSE HERE, deliberately: `walkAuditChain` owns every handle
    // it opens and disposes them itself — the audit store in the walk's own
    // `.finally()` (chain.ts), the cost ledger in hop 3's `finally`, the trace
    // db in `readTrace`'s. `RunRecordStore` is fs-only. So the documented
    // two-walks-in-one-process use of the exported `run()` accumulates no
    // handles, and this CLI needs none of the close-and-report discipline the
    // other four grew. If the walker ever hands a handle back, that changes.
    report = await walkAuditChain(ref, {
      requestId,
      ...(args.runsDir !== undefined ? { runsDir: args.runsDir } : {}),
      ...(args.auditDb !== undefined ? { auditDb: args.auditDb } : {}),
      ...(args.ledger !== undefined ? { ledger: args.ledger } : {}),
      ...(args.reverifyDir !== undefined ? { reverifyDir: args.reverifyDir } : {}),
    });
  } catch (e) {
    // No report was produced — exit 2 for EVERY throwable, not just
    // ChainWalkError. Exit 1 means "the chain is broken"; an unreadable runs
    // dir or a `gh` read that threw is an environment fault, and conflating
    // the two is a false accusation against the PR under audit.
    const walkError = e instanceof ChainWalkError;
    const code = walkError ? (e as ChainWalkError).code : "walk-failed";
    const message = e instanceof Error ? e.message : String(e);
    const next = walkError
      ? (e as ChainWalkError).remediation
      : "the walk faulted before producing a report — fix the condition above and re-run (this is NOT a broken chain)";
    log({
      requestId, operation: "audit-chain.verdict", agentId: null,
      timestamp: new Date().toISOString(), duration: Date.now() - startedAt,
      status: "error", error: { code, message }, ref,
    });
    return fail(`!! ${code}`, [message, `next: ${next}`]);
  }

  const walked = chainVerdict(report);
  // Defence in depth on the walker's verdict: "I found no evidence" must never
  // render as "I verified every hop" — the shape a mis-pointed --runs-dir
  // produces. `chainVerdict` already requires at least one resolved hop; this
  // keeps the CLI's exit contract true even if that changes.
  const verdict = { ...walked, complete: walked.complete && Object.keys(report.runs).length > 0 };
  const faults = environmentFaults(report);
  // Logged BEFORE the render, not after: the render can now fail the
  // invocation (a short write is not a report), and the observability line must
  // describe the walk either way.
  log({
    requestId, operation: "audit-chain.verdict", agentId: null,
    timestamp: report.generatedAt, duration: Date.now() - startedAt,
    status: verdict.complete && faults.length === 0 ? "ok" : "error",
    ...(faults.length > 0 ? { error: { code: "walk-environment-fault", message: faults.join("; ") } } : {}),
    ref, refKind: report.refKind, complete: verdict.complete,
    brokenHops: verdict.brokenHops.map((h) => ({ hop: h.hop, status: h.status })),
    // snake_case KEYS per the story's Observability Contract (and the repo's
    // added-metric convention); read off the camelCase TS type by design —
    // see the comment on `ChainReport.timings`.
    pr_fetch_ms: report.timings.prFetchMs, per_hop_ms: report.timings.perHopMs,
  });
  if (faults.length > 0) {
    // Nothing on stdout: exit 2 means "no report reached stdout", and a
    // consumer that finds a report there under a 2 has no rule left to apply.
    // The hops and their faults ARE the actionable half, and they are here.
    return fail("!! walk-environment-fault", [
      ...faults,
      "next: the walk could not read part of its own environment — fix the condition(s) above and re-run (this is NOT a broken chain)",
    ]);
  }
  try {
    if (args.json) writeAll(1, `${JSON.stringify(report)}\n`);
    else printHuman(report, verdict);
  } catch (e) {
    // A report that did not land in FULL is not a report: `writeSync` returns a
    // short count on a full pipe and drops the remainder silently, which under
    // the old code handed the DF5.4-C9 fixture harness half a JSON object under
    // exit 0. EPIPE lands here too, classified, instead of escaping `run()`.
    return fail("!! report-unwritable", [
      (e as Error).message,
      `verdict was: ${verdict.complete ? "COMPLETE" : "BROKEN"} (${ref}, ${report.refKind})`,
      "next: re-run with the consumer able to accept the whole report (the verdict above is the one it would have carried)",
    ]);
  }
  return verdict.complete ? 0 : 1;
}

if (import.meta.main) {
  let code = 2;
  try {
    code = await run(Bun.argv.slice(2));
  } catch (err) {
    // Nothing should reach here (walkAndRender catches the walk, and the log
    // sink swallows its own errors) — but an exception that escapes must still
    // be a 2, never bun's default 1.
    writeBestEffort(2, `!! qds-audit: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(code);
}
