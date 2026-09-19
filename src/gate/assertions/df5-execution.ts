/**
 * DF5.4 execution clauses (Story DF5.4): P1 preflight, C1 channel, C2 fleet,
 * C3 team, C4 gates — the §8 step-5 execution half of the lights-on gate.
 *
 * Every clause asserts against the frozen run of record — host-side evidence a
 * prior run wrote (G4: read-only, never re-executed). C3 and C4 are the two
 * clauses whose subject is an in-box claim: they assert the claim was produced
 * and harvested intact, never that it is true (INV-GATE-4 — the truth layer is
 * DF5.1's host-side re-verify, asserted by DF5.4-C6 in df5-boundary.ts).
 *
 * The run record is untrusted disk data: every field is read through `unknown`
 * and narrowed, never trusted by JSON shape. Auditors are pure (no IO) so each
 * clause contract is testable directly; the check closures do the IO, route
 * every count threshold through `meetsMinCount`, and append the p0-3-style
 * provenance suffix to every pass/fail detail. C4 reads the harvested trace
 * store through a temp-dir copy (chain.ts readTrace discipline) so recovering
 * its hot WAL never writes into the artifacts directory.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GateAssertion, GateCheckOutcome } from "../gate-runner.ts";
import { readJsonEvidence, readJsonEvidenceDiagnosed, scanNdjson, type NdjsonScan } from "./lib/verdict.ts";
import { meetsMinCount } from "./p0-2-coms.ts";

// ---------------------------------------------------------------------------
// unknown-narrowing helpers — the record is untrusted disk data
// ---------------------------------------------------------------------------

function fieldOf(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function positiveNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Diagnostic rendering of an untrusted value: names absence, never dumps objects. */
function show(v: unknown): string {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  if (typeof v === "object") return Array.isArray(v) ? "array" : "object";
  return typeof v === "string" ? `"${v.slice(0, 40)}"` : String(v);
}

// ---------------------------------------------------------------------------
// pure auditors
// ---------------------------------------------------------------------------

export interface ChannelAudit {
  /** One entry per failed leg, each naming the field and observed value. */
  failures: string[];
  requestId: string | undefined;
  repoSlug: string | undefined;
  issueId: string | undefined;
  admittedCeilingMicroUsd: number | undefined;
}

/**
 * DF5.4-C1: the durable evidence that dispatch went through DF3.1's operator
 * CLI and DF2.8's admission gate rather than being hand-created — a requestId
 * plus an admitted budget with a strictly positive ceiling. Every leg is a
 * positive assertion: 0/absent fails, because a run nothing admitted is a run
 * nothing capped.
 */
export function auditChannel(record: unknown): ChannelAudit {
  const failures: string[] = [];
  const requestId = nonEmptyString(fieldOf(record, "requestId"));
  if (requestId === undefined) {
    failures.push(`requestId=${show(fieldOf(record, "requestId"))} (expected non-empty string)`);
  }
  const budget = fieldOf(fieldOf(record, "extensions"), "budget");
  const repoSlug = nonEmptyString(fieldOf(budget, "repoSlug"));
  const issueId = nonEmptyString(fieldOf(budget, "issueId"));
  const admittedCeilingMicroUsd = positiveNumber(fieldOf(budget, "admittedCeilingMicroUsd"));
  if (repoSlug === undefined) {
    failures.push(`extensions.budget.repoSlug=${show(fieldOf(budget, "repoSlug"))} (expected non-empty string)`);
  }
  if (issueId === undefined) {
    failures.push(`extensions.budget.issueId=${show(fieldOf(budget, "issueId"))} (expected non-empty string)`);
  }
  if (admittedCeilingMicroUsd === undefined) {
    failures.push(
      `extensions.budget.admittedCeilingMicroUsd=${show(fieldOf(budget, "admittedCeilingMicroUsd"))} (expected > 0 — a run nothing admitted is a run nothing capped)`,
    );
  }
  return { failures, requestId, repoSlug, issueId, admittedCeilingMicroUsd };
}

export interface FleetAudit {
  failures: string[];
  closedAt: string | undefined;
  commitSha: string | undefined;
  approvalState: string | undefined;
  spendMicroUsd: number | undefined;
}

/**
 * DF5.4-C2: the fleet lifecycle closed out finished. The gate-green leg is the
 * recorded INV-GATE-5 carve-out — `extensions.gate` ABSENT, because DF3.1
 * writes that namespace only on setup-gate failure and absence is the only
 * trace a green gate leaves — guarded by its two positive companions
 * (`closedAt`, `commitSha`) so a truncated record cannot ride the negation to
 * green. `closedAt` alone is not "finished" either: pausing/awaiting-approval
 * are also closed records (DF3.4 teardown sets closedAt before the promote),
 * so the terminal approval state is asserted alongside it.
 */
export function auditFleet(record: unknown): FleetAudit {
  const failures: string[] = [];
  const closedAt = nonEmptyString(fieldOf(record, "closedAt"));
  if (closedAt === undefined) {
    failures.push(`closedAt=${show(fieldOf(record, "closedAt"))} (expected non-empty string — the record never closed)`);
  }
  const commitSha = nonEmptyString(fieldOf(record, "commitSha"));
  if (commitSha === undefined) {
    failures.push(`commitSha=${show(fieldOf(record, "commitSha"))} (expected non-empty string — no pinned fill SHA)`);
  }
  const extensions = fieldOf(record, "extensions");
  const gateNamespace = fieldOf(extensions, "gate");
  if (gateNamespace !== undefined) {
    failures.push(
      `extensions.gate present (outcome=${show(fieldOf(gateNamespace, "outcome"))}) — DF3.1 writes that namespace only on setup-gate failure; its absence is the only trace a green gate leaves (INV-GATE-5 recorded carve-out, guarded by the closedAt/commitSha companions)`,
    );
  }
  const approvalState = nonEmptyString(fieldOf(fieldOf(extensions, "approval"), "state"));
  if (approvalState !== "approved") {
    failures.push(
      `extensions.approval.state=${show(approvalState)} (expected "approved" — pausing/awaiting-approval are closed but not finished)`,
    );
  }
  const spendMicroUsd = positiveNumber(fieldOf(record, "spendMicroUsd"));
  if (spendMicroUsd === undefined) {
    failures.push(`spendMicroUsd=${show(fieldOf(record, "spendMicroUsd"))} (expected > 0)`);
  }
  return { failures, closedAt, commitSha, approvalState, spendMicroUsd };
}

export interface TeamEnvelopeAudit extends NdjsonScan {
  failures: string[];
  /** Evidence could not be evaluated — red, never green (INV-GATE-5). */
  skip?: string;
}

/**
 * DF5.4-C3: the team execution's NDJSON evidence arrived intact — at least one
 * well-formed line, zero malformed. Claim-integrity ONLY: this proves the
 * box's claim arrived, never that its content is true. The "at least one"
 * conjunct is C4's own discipline applied at home: a zero-line log is present,
 * parses, and carries zero malformed lines, and would pass without it.
 */
export function auditTeamEnvelope(scan: { exists: boolean } & NdjsonScan): TeamEnvelopeAudit {
  if (!scan.exists) {
    return { wellFormed: scan.wellFormed, malformed: scan.malformed, failures: [], skip: "no harvested team envelope" };
  }
  const failures: string[] = [];
  if (!meetsMinCount(scan.wellFormed.length, 1)) {
    failures.push("wellFormed lines=0 (expected >=1 — a zero-line log is present, parses and carries zero malformed lines; without this conjunct it would pass vacuously)");
  }
  if (scan.malformed.length !== 0) {
    const first = scan.malformed[0];
    failures.push(`malformed lines=${scan.malformed.length} (expected 0), first at line ${first?.line}: ${first?.error}`);
  }
  return { wellFormed: scan.wellFormed, malformed: scan.malformed, failures };
}

export interface GateResultsAudit {
  failures: string[];
  rowCount: number;
  /** Evidence could not be evaluated — red, never green (INV-GATE-5). */
  skip?: string;
}

/**
 * DF5.4-C4: the harvested trace store carries at least one `gate_results` row
 * for the run and every row's `passed` column is a literal 0 or 1 — never
 * NULL, which is an unproven verdict (INV-GATE-5 positive assertion).
 * Claim-integrity ONLY under INV-GATE-4: an in-box green can never be the
 * proof that a gate passed; that proof is DF5.1's host-side re-verify
 * (DF5.4-C6). Pass/fail DIVERSITY is deliberately not asserted — a run whose
 * gates all pass first time produces only `passed = 1` rows, and the frozen
 * run of record must stay permanently green; the discrimination (a `passed =
 * 0` row is lawful, a NULL or out-of-domain value is not) is a unit test.
 */
export function auditGateResults(
  rows: ReadonlyArray<{ passed: number | null }>,
  joinedOnRequestId: boolean,
): GateResultsAudit {
  if (!joinedOnRequestId) {
    return {
      failures: [],
      rowCount: 0,
      skip: "record carries no requestId — gate_results cannot be joined (the trace store keys on request_id, never on run_id)",
    };
  }
  const failures: string[] = [];
  if (!meetsMinCount(rows.length, 1)) {
    failures.push(`gate_results rows=${rows.length} (expected >=1 joined on request_id)`);
  }
  for (const [i, row] of rows.entries()) {
    const passed = row.passed;
    if (passed !== 0 && passed !== 1) {
      failures.push(
        `gate_results[${i}].passed=${passed === null ? "NULL" : String(passed)} (expected literal 0 or 1 — NULL is an unproven verdict and fails, INV-GATE-5)`,
      );
    }
  }
  return { failures, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export interface Df5ExecutionDeps {
  runId: string;
  runsDir: string;
}

/**
 * Folds an audit into one GateCheckOutcome. A skip marker wins BEFORE the
 * failures check: an auditor that could not evaluate its evidence is red
 * (`skip: true`), never green, even though its skip arm carries no failures —
 * the router enforces INV-GATE-5 fail-closed instead of trusting each closure
 * to hand-route its skip. The shipped closures hardcode the affirmative
 * (`exists: true`, `joinedOnRequestId: true`) so their outcomes are unchanged;
 * the arm exists for any auditor result that carries a marker.
 */
function verdict(
  audit: { failures: string[]; skip?: string },
  passDetail: string,
  provenance: string,
): GateCheckOutcome {
  if (audit.skip !== undefined) return { pass: false, skip: true, detail: audit.skip };
  return audit.failures.length > 0
    ? { pass: false, detail: `${audit.failures.join("; ")} — ${provenance}` }
    : { pass: true, detail: `${passDetail} — ${provenance}` };
}

export function df5ExecutionAssertions(deps: Df5ExecutionDeps): GateAssertion[] {
  const recordPath = path.join(deps.runsDir, `${deps.runId}.json`);
  const traceDir = path.join(deps.runsDir, `${deps.runId}-artifacts`, "trace");
  const eventsPath = path.join(traceDir, "events.jsonl");
  const traceDbPath = path.join(traceDir, "trace.db");
  const recordProvenance =
    `evidence-of-record ${recordPath} (recorded live run, not re-executed by this gate)`;
  // C3/C4 subjects are in-box claims: the suffix says so, so a green row can
  // never read as proof (INV-GATE-4 — the truth layer is DF5.4-C6).
  const harvestedClaimProvenance = (evidencePath: string) =>
    `evidence-of-record ${evidencePath} (harvested in-box claim — integrity asserted, truth is DF5.1's host-side re-verify asserted by DF5.4-C6; recorded live run, not re-executed by this gate)`;
  const unreadableRecord = (): GateCheckOutcome => ({
    pass: false,
    skip: true,
    detail: `run of record not readable (missing, unreadable, or not valid JSON): ${recordPath}`,
  });

  return [
    {
      id: "DF5.4-P1",
      story: "DF5.4",
      prd_clause: "§8 step 5 — run of record",
      description:
        "The run of record exists at <runsDir>/<runId>.json, parses, and names a runId exactly equal to this gate's --run-id (a record naming a different run is misfiled evidence)",
      group: "preflight",
      check: async () => {
        // One atomic read, no accessSync pre-check: a record that exists at
        // access time but cannot be read a moment later reports its read
        // failure (path + fs error), not a bogus "not valid JSON".
        const read = readJsonEvidenceDiagnosed(recordPath);
        if (!read.ok) {
          if (read.kind === "read") {
            return { pass: false, skip: true, detail: `run of record not readable (${read.error}): ${recordPath}` };
          }
          return {
            pass: false,
            detail: `run of record is present and readable but is not valid JSON (${read.error}) — ${recordProvenance}`,
          };
        }
        const record = read.value;
        const runId = nonEmptyString(fieldOf(record, "runId"));
        if (runId === undefined) {
          return {
            pass: false,
            detail: `record parses but names no usable runId (runId=${show(fieldOf(record, "runId"))}) — ${recordProvenance}`,
          };
        }
        // Identity, not mere presence: every downstream clause threads
        // deps.runId into its evidence paths, so a record at that path naming
        // a DIFFERENT run is misfiled evidence — red here at preflight, where
        // the operator can see both ids, not as a confusing downstream miss.
        if (runId !== deps.runId) {
          return {
            pass: false,
            detail: `record parses but names runId ${show(runId)}, not this gate's ${JSON.stringify(deps.runId)} — misfiled evidence — ${recordProvenance}`,
          };
        }
        return {
          pass: true,
          detail: `run of record ${runId} exists, parses and names this gate's runId — ${recordProvenance}`,
        };
      },
    },
    {
      id: "DF5.4-C1",
      story: "DF3.1/DF2.8",
      prd_clause: "§8 step 5 — channel",
      description:
        "The run record carries a requestId and an extensions.budget block with repoSlug, issueId and a non-zero admittedCeilingMicroUsd",
      group: "main",
      check: async () => {
        const record = readJsonEvidence(recordPath);
        if (record === undefined) return unreadableRecord();
        const audit = auditChannel(record);
        return verdict(
          audit,
          `dispatch went through the channel: requestId present, budget admitted ${audit.repoSlug}#${audit.issueId} at ${audit.admittedCeilingMicroUsd} micro-USD`,
          recordProvenance,
        );
      },
    },
    {
      id: "DF5.4-C2",
      story: "DF3.1/DF2.2/DF2.5",
      prd_clause: "§8 step 5 — fleet",
      description:
        'Record closed (closedAt) at a pinned SHA (commitSha), setup gate green (extensions.gate absent — the recorded negated-field carve-out), terminal approval "approved", non-zero spendMicroUsd',
      group: "main",
      check: async () => {
        const record = readJsonEvidence(recordPath);
        if (record === undefined) return unreadableRecord();
        const audit = auditFleet(record);
        return verdict(
          audit,
          `fleet lifecycle finished: closed at a pinned SHA, no extensions.gate namespace (green leaves no positive trace), approval approved, spend ${audit.spendMicroUsd} micro-USD`,
          recordProvenance,
        );
      },
    },
    {
      id: "DF5.4-C3",
      story: "DF1.6",
      prd_clause: "§8 step 5 — team",
      description:
        "The harvested team envelope <runId>-artifacts/trace/events.jsonl parses as NDJSON with >=1 well-formed line and zero malformed lines",
      group: "main",
      check: async () => {
        let text: string;
        try {
          text = fs.readFileSync(eventsPath, "utf8");
        } catch {
          return { pass: false, skip: true, detail: `no harvested team envelope (missing or unreadable): ${eventsPath}` };
        }
        const audit = auditTeamEnvelope({ exists: true, ...scanNdjson(text) });
        return verdict(
          audit,
          `${audit.wellFormed.length} well-formed NDJSON lines, 0 malformed — claim-integrity only: proves the team's claim arrived intact, never that it is true`,
          harvestedClaimProvenance(eventsPath),
        );
      },
    },
    {
      id: "DF5.4-C4",
      story: "DF1.2/DF1.4",
      prd_clause: "§8 step 5 — gates",
      description:
        "The harvested trace store (read via temp-dir copy) carries >=1 gate_results row joined on the record's requestId, every passed a literal 0/1 — claim-integrity only",
      group: "main",
      check: async () => {
        if (!fs.existsSync(traceDbPath)) {
          return { pass: false, skip: true, detail: `no harvested trace store: ${traceDbPath}` };
        }
        const record = readJsonEvidence(recordPath);
        if (record === undefined) return unreadableRecord();
        const requestId = nonEmptyString(fieldOf(record, "requestId"));
        if (requestId === undefined) {
          const unjoinable = auditGateResults([], false);
          return { pass: false, skip: true, detail: `${unjoinable.skip}: ${recordPath}` };
        }
        // Temp-dir copy (chain.ts readTrace discipline): a hot -wal with no
        // -shm ships by design and an in-place read either refuses or silently
        // reads a truncated DB — so copy the -wal FIRST, then the db, into a
        // mkdtemp scratch and open the COPY read-write so SQLite recovers the
        // WAL. The artifacts directory is never written.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df54-trace-"));
        try {
          const copyPath = path.join(tmp, "trace.db");
          try {
            if (fs.existsSync(`${traceDbPath}-wal`)) {
              fs.copyFileSync(`${traceDbPath}-wal`, `${copyPath}-wal`);
            }
            fs.copyFileSync(traceDbPath, copyPath);
          } catch (err) {
            return {
              pass: false,
              skip: true,
              detail: `harvested trace store not copyable (${err instanceof Error ? err.message : String(err)}): ${traceDbPath}`,
            };
          }
          let rows: Array<{ passed: number | null }> = [];
          let db: Database | undefined;
          try {
            db = new Database(copyPath);
            const raw = db
              .prepare("SELECT passed FROM gate_results WHERE request_id = ?")
              .all(requestId) as Array<{ passed: unknown }>;
            // The store is box-written disk data: a non-numeric passed value
            // is normalised to NaN so it fails the literal check, never a
            // silent coercion to green.
            rows = raw.map((row) => ({
              passed: typeof row.passed === "number" ? row.passed : row.passed === null ? null : Number.NaN,
            }));
          } catch (err) {
            return {
              pass: false,
              skip: true,
              detail: `harvested trace store not readable (${err instanceof Error ? err.message : String(err)}): ${traceDbPath}`,
            };
          } finally {
            db?.close();
          }
          const audit = auditGateResults(rows, true);
          return verdict(
            audit,
            `${audit.rowCount} gate_results rows joined on request_id, every passed a literal 0/1 — claim-integrity only (INV-GATE-4): an in-box green can never be the proof a gate passed`,
            harvestedClaimProvenance(traceDbPath),
          );
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
  ];
}
