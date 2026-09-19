/**
 * DF5.4 lights-on-gate — accounting clauses (story DF5.4, leaf-1.1.5).
 *
 * Three assertions over the frozen run of record:
 *
 *  - **DF5.4-C9** (audit, DF5.3): spawns `scripts/qds-audit.ts --json` by
 *    runId — hop 1 resolves locally, so the walk performs no network access —
 *    and asserts the PARSED `ChainReport` (imported from `src/audit/index.ts`,
 *    never re-declared: it is the two-story wire format with one owner), not
 *    merely the exit code. The pure shape checker `auditChainReport` is
 *    exported so the depth mutants (a 9-hop chain, a stripped credential link,
 *    a non-void hop 10) are unit-testable without a walker.
 *  - **DF5.4-C10** (cost, DF2.8/DF2.11): reads the ledger through
 *    `CostLedger.openReadOnly()` — which refuses rather than creates — and
 *    asserts the run's aggregate µ$ total, separately comparing the RECORD's
 *    `spendMicroUsd` against `extensions.budget.admittedCeilingMicroUsd`. Two
 *    different meters; never one against the other's ceiling.
 *  - **DF5.4-V1** (memory, step 6): VOID per DD-4 — `void_reason` is the
 *    imported `OQ4_VOID_REASON`, byte-identical by construction. The chassis
 *    never invokes its check and excludes it from the verdict.
 *
 * INV-GATE-2: no assertion detail embeds a secret. The walker's stderr tail is
 * bounded AND scrubbed of token shapes before it can reach a detail.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { AUDIT_HOPS, OQ4_VOID_REASON, type ChainReport, type HopOutcome } from "../../audit/index.ts";
import type { GateAssertion, GateCheckOutcome } from "../gate-runner.ts";
import { CostLedger, CostLedgerError } from "../../providers/cost-ledger.ts";
import { meetsMinCount } from "./p0-2-coms.ts";
import { readJsonEvidence } from "./lib/verdict.ts";

export interface Df5AccountingDeps {
  runId: string;
  runsDir: string;
  auditDb: string;
  ledger: string;
  reverifyDir: string;
}

/** Hop statuses that break the chain — C9 requires ZERO of these under every runs key. */
const BAD_HOP_STATUSES: ReadonlySet<string> = new Set([
  "broken",
  "unlinked",
  "hop-timeout",
  "evidence-mismatch",
  "evidence-not-harvested",
]);

/** The three hops whose emitted `audit_links` rows no other clause covers (DF5.3 hops 4/5/6). */
const LINK_BEARING_HOPS: ReadonlySet<string> = new Set(["run-credential", "run-box", "run-bundle"]);

/** C9's subprocess budget (story: the ≤30 s walk fits its 60 s chassis slot; margin for a cold spawn). */
const WALKER_TIMEOUT_MS = 45_000;

/** INV-GATE-2: the stderr tail ceiling before a detail embeds it. */
const STDERR_TAIL_MAX_CHARS = 400;

/**
 * The C9 shape checker, pure: returns one violation string per broken
 * expectation against the report the walker ALREADY produced.
 *
 * Checks (story C9 row): ≥1 runs key whose `RunChain.runId` is the parent
 * runId (map keys may be a PR url on broken paths — match on the field, not
 * the key), exactly ten hops under EVERY key, zero hops in
 * `BAD_HOP_STATUSES`, hop `memory-retain-receipt` void, and each of
 * run-credential/run-box/run-bundle carrying ≥1 emitted link id
 * (`linkId`, or `detail.linkIds` non-empty — counted via `meetsMinCount`).
 */
export function auditChainReport(report: ChainReport, runId: string): string[] {
  const violations: string[] = [];
  const keys = Object.keys(report.runs ?? {});
  if (keys.length === 0) return ["runs map is empty — the walk produced no contributing runId"];
  if (!keys.some((k) => report.runs[k]?.runId === runId)) {
    violations.push(`no runs key resolves runId ${runId} (keys: ${keys.join(", ")})`);
  }
  for (const key of keys) {
    const chain = report.runs[key];
    if (!chain) continue;
    const hopNames = Object.keys(chain.hops ?? {});
    if (hopNames.length !== AUDIT_HOPS.length) {
      violations.push(`runs[${key}]: ${hopNames.length} hops, expected exactly ${AUDIT_HOPS.length}`);
    }
    for (const hop of AUDIT_HOPS) {
      const out = chain.hops?.[hop];
      if (out === undefined) {
        violations.push(`runs[${key}] hop ${hop}: missing from the hops record`);
        continue;
      }
      if (BAD_HOP_STATUSES.has(out.status)) {
        violations.push(`runs[${key}] hop ${hop}: status ${out.status}`);
      }
      if (hop === "memory-retain-receipt" && out.status !== "void") {
        violations.push(`runs[${key}] hop ${hop}: status ${out.status}, expected void (DD-4)`);
      }
      if (LINK_BEARING_HOPS.has(hop) && !BAD_HOP_STATUSES.has(out.status)) {
        // Story C9: hops 4/5/6 each carry ≥1 emitted link id, unconditionally —
        // a legal-elsewhere status (not-applicable, void, order-violation) on a
        // link-bearing hop of a lights-on run still violates. Only hops whose
        // status already reported above (BAD_HOP_STATUSES) skip, to avoid
        // double-counting one defect as two violations.
        const linkCount = emittedLinkCount(out);
        if (!meetsMinCount(linkCount, 1)) {
          violations.push(`runs[${key}] hop ${hop}: no emitted audit_links row id (status ${out.status})`);
        }
      }
    }
  }
  return violations;
}

/** Link ids an outcome carries: 1 for a top-level `linkId`, else `detail.linkIds.length`. */
function emittedLinkCount(out: HopOutcome): number {
  if (out.status === "resolved" && typeof out.linkId === "number") return 1;
  const detail: unknown = out.status === "resolved" ? out.detail : undefined;
  if (typeof detail === "object" && detail !== null && Array.isArray((detail as { linkIds?: unknown }).linkIds)) {
    return (detail as { linkIds: unknown[] }).linkIds.length;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// INV-GATE-2 helpers — exported pure so the redaction contract is testable.
// ---------------------------------------------------------------------------

/** Obvious token shapes, scrubbed before any stderr text reaches a detail. */
const SECRET_SHAPES: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /ghu_[A-Za-z0-9]{8,}/g,
  /ghs_[A-Za-z0-9]{8,}/g,
  /ghr_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /sk_[A-Za-z0-9_-]{8,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

/** Bounded, scrubbed, single-line stderr tail — the only stderr a detail may embed. */
export function boundStderrTail(stderr: string): string {
  const tail = stderr.length > STDERR_TAIL_MAX_CHARS ? `…${stderr.slice(-STDERR_TAIL_MAX_CHARS)}` : stderr;
  return scrubSecrets(tail).replace(/\s*\n\s*/g, " ⏎ ");
}

/** Typed walker/ledger code names (e.g. `audit-store-absent`) when present in stderr. */
function typedCodes(stderr: string): string {
  const matches = [...new Set(stderr.match(/\b(?:audit-store|audit-chain|ledger)-[a-z]{2,}(?:-[a-z]+)*\b/g) ?? [])];
  return matches.join(", ");
}

/** Names a non-zero walker exit, including the SIGKILL timeout arm. */
function describeWalkerExit(exit: number | null): string {
  if (exit === null || exit < 0) return `killed by signal (timeout budget ${WALKER_TIMEOUT_MS}ms, SIGKILL)`;
  return `exit code ${exit}`;
}

/** Repo root, resolved upward from this file — `scripts/qds-audit.ts` lives there. */
function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "scripts", "qds-audit.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

// ---------------------------------------------------------------------------
// DF5.4-C9
// ---------------------------------------------------------------------------

async function checkAuditChain(deps: Df5AccountingDeps): Promise<GateCheckOutcome> {
  const provenance = `walked scripts/qds-audit.ts --json ${deps.runId} by runId against the frozen run of record (read-only evidence; hop 1 resolves locally, no network access)`;
  const script = join(repoRoot(), "scripts", "qds-audit.ts");
  // FINITE-guarded clamp (transport.ts precedent): Bun.spawn refuses a NaN
  // timeout with a RangeError, which would masquerade as a chain fault.
  const timeout = Number.isFinite(WALKER_TIMEOUT_MS) ? Math.max(1, WALKER_TIMEOUT_MS) : 30_000;
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      script,
      "--json",
      deps.runId,
      "--runs-dir",
      deps.runsDir,
      "--audit-db",
      deps.auditDb,
      "--ledger",
      deps.ledger,
      "--reverify-dir",
      deps.reverifyDir,
    ],
    cwd: repoRoot(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // The exit code alone is never the assertion: stdout is parsed even on a
  // non-zero exit so a parsed-but-violating report names its own hops, and a
  // clean report under a non-zero exit still fails on the exit.
  let report: ChainReport | undefined;
  let parseFailure = "";
  try {
    report = JSON.parse(stdout) as ChainReport;
  } catch (err) {
    parseFailure = err instanceof Error ? err.message : String(err);
  }
  const problems: string[] = [];
  if (exit !== 0) {
    const codes = typedCodes(stderr);
    problems.push(`walker ${describeWalkerExit(exit)}${codes ? ` (typed code ${codes})` : ""}`);
  }
  if (report === undefined) {
    problems.push(`stdout did not parse as a ChainReport (${parseFailure})`);
  } else {
    problems.push(...auditChainReport(report, deps.runId));
  }
  if (problems.length > 0) {
    return {
      pass: false,
      detail: `${problems.join("; ")} — stderr tail: ${boundStderrTail(stderr)} — ${provenance}`,
    };
  }
  return {
    pass: true,
    detail: `ten-hop chain green for ${deps.runId}: 10 hops under every key, hop 10 void, emitted links on run-credential/run-box/run-bundle — ${provenance}`,
  };
}

// ---------------------------------------------------------------------------
// DF5.4-C10
// ---------------------------------------------------------------------------

async function checkCostLedger(deps: Df5AccountingDeps): Promise<GateCheckOutcome> {
  const provenance = `read CostLedger.openReadOnly ${deps.ledger} for ${deps.runId} (recorded evidence; the gate never dispatches spend)`;
  let handle: CostLedger;
  try {
    handle = CostLedger.openReadOnly({ path: deps.ledger });
  } catch (err) {
    const code = err instanceof CostLedgerError ? err.code : "ledger-open-fault";
    return {
      pass: false,
      skip: true,
      detail: `cost ledger not readable at ${deps.ledger} (${code}) — skip is red, never green, and no ledger is created — ${provenance}`,
    };
  }
  let view: ReturnType<CostLedger["readRunCost"]>;
  try {
    view = handle.readRunCost(deps.runId);
  } catch (err) {
    const code = err instanceof CostLedgerError ? err.code : "ledger-read-fault";
    return {
      pass: false,
      skip: true,
      detail: `run cost not readable from ${deps.ledger} (${code}) — ${provenance}`,
    };
  } finally {
    handle.close();
  }

  const failures: string[] = [];
  if (view.hasEvents !== true) failures.push(`ledger has no events for ${deps.runId} (hasEvents=false)`);
  if (!(view.totalMicroUsd > 0)) failures.push(`ledger totalMicroUsd is ${view.totalMicroUsd} µ$, not non-zero`);

  // The second meter: the RECORD's spend against the ceiling actually handed
  // to DF2.3's mint — never the ledger total against this ceiling.
  const recordPath = join(deps.runsDir, `${deps.runId}.json`);
  const record = readJsonEvidence(recordPath) as
    | { spendMicroUsd?: unknown; extensions?: { budget?: { admittedCeilingMicroUsd?: unknown } } }
    | undefined;
  if (record === undefined) {
    return {
      pass: false,
      skip: true,
      detail: `run record unreadable at ${recordPath} — the spend-vs-ceiling leg cannot be evaluated — ${provenance}`,
    };
  }
  const spend = record.spendMicroUsd;
  const ceiling = record.extensions?.budget?.admittedCeilingMicroUsd;
  if (typeof spend !== "number" || typeof ceiling !== "number") {
    failures.push("record lacks numeric spendMicroUsd / extensions.budget.admittedCeilingMicroUsd");
  } else if (spend > ceiling) {
    failures.push(`record spendMicroUsd ${spend} µ$ exceeds admittedCeilingMicroUsd ${ceiling} µ$`);
  }

  if (failures.length > 0) {
    return { pass: false, detail: `${failures.join("; ")} — ${provenance}` };
  }
  // INV-GATE-2: aggregate meters only — no per-role or per-token figures.
  return {
    pass: true,
    detail: `ledger total ${view.totalMicroUsd} µ$ over ${view.eventCount} events (hasEvents=true); record spendMicroUsd ${spend} µ$ ≤ admitted ceiling ${ceiling} µ$ — ${provenance}`,
  };
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export function df5AccountingAssertions(deps: Df5AccountingDeps): GateAssertion[] {
  return [
    {
      id: "DF5.4-C9",
      story: "DF5.3",
      prd_clause: "§8 step 5 — audit",
      description:
        "the audit chain walks green by runId: a parsed ChainReport with exactly ten hops per contributing runId, " +
        "zero broken/unlinked/timed-out/mismatched hops, hop 10 void, and emitted audit_links rows on the credential/box/bundle hops",
      group: "main",
      check: () => checkAuditChain(deps),
    },
    {
      id: "DF5.4-C10",
      story: "DF2.8/DF2.11",
      prd_clause: "§8 step 5 — cost",
      description:
        "the run's cost ledger reads non-zero with events through openReadOnly (never the writing constructor), " +
        "and the record's spendMicroUsd stays at or under its admitted budget ceiling — two different meters, never cross-compared",
      group: "main",
      check: () => checkCostLedger(deps),
    },
    {
      id: "DF5.4-V1",
      story: "DF5.4 (step 6)",
      prd_clause: "§8 step 5 — memory",
      description:
        "retain receipt — VOID per DD-4 (register §4 row 3): Hindsight has never booted on this host; " +
        "step-6 memory wiring is outside the v5 horizon",
      group: "main",
      // Presence of void_reason makes the chassis VOID this clause: check is
      // NEVER invoked and the verdict excludes it (gate-runner.ts:167-178).
      // The body exists only so the required shape is honest about what an
      // invocation would be — a contract violation, not a verdict.
      void_reason: OQ4_VOID_REASON,
      check: async () => ({
        pass: false,
        detail: "DF5.4-V1 check invoked — chassis contract violation (void_reason ⇒ check never invoked)",
      }),
    },
  ];
}
