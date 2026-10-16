/**
 * A1 leaf-1.2.1 — the digest composer's own suite (AC2 fence, AC3 additive
 * absorption, AC5 DD-20 join keys).
 *
 * The AC2 fence test asserts the ALLOWLIST, not a denylist: every DIRECT
 * import in `src/managers/**` plus the digest CLI leaf
 * `scripts/manager-digest.ts` (scanned recursively) that resolves into
 * `src/fleet/` — by dot-relative, dot-through-src, or repo-root `src/fleet/`
 * spelling, in from-import, side-effect, dynamic-import(), or re-export
 * statement shape — must name one of the permitted read surfaces; any other
 * fleet import fails, whatever symbol it carries. The fence is a static
 * import fence: transitive reach is out of its letter and rides each
 * dependency module's own story invariants. The mutating set is named in the
 * story as rationale and deliberately appears nowhere here as the check.
 *
 * The CLI invoker is a dep, so the journal idiom (one JSON line per
 * invocation, `tests/fleet/e2e/sc2-harness.ts`'s shape) asserts exactly the
 * two permitted verbs and nothing else.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ESCALATION_KINDS,
  composeDigest,
  fleetCliInvoker,
  FleetVerbTimeoutError,
  MAX_LINE_BYTES,
  MAX_SNAPSHOT_RUNS,
  MAX_STATUS_ROWS,
  PARK_THRESHOLD_MS,
  type CliInvoker,
  type DigestDeps,
} from "../../src/managers/digest-composer.ts";
import type { RunRecord } from "../../src/providers/run-record.ts";
import { WorkKeySchema } from "../../src/managers/manager-config.ts";
import {
  captureInto,
  costView,
  event,
  fakeCli,
  NOW,
  record,
  restoreCaptures,
} from "./fixture-helpers.ts";

const MANAGERS_DIR = join(import.meta.dir, "../../src/managers");
const DIGEST_CLI = join(import.meta.dir, "../../scripts/manager-digest.ts");
const APPROVAL_GATE = join(import.meta.dir, "../../src/fleet/approval-gate.ts");
/** Read as TEXT by the drift tripwire — never imported (outside the AC2 allowlist). */
const STATUS_TS = join(import.meta.dir, "../../src/fleet/status.ts");

/** Every .ts under `dir`, recursively (subdirs are future fence surface too). */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// ─── fakes (shared: tests/managers/fixture-helpers.ts) ───────────────────────

type DepsOpts = {
  cli: CliInvoker;
  records?: Map<string, RunRecord>;
  fleetMicroUsd?: Map<string, number>;
  botSpend?: Map<string, number>;
  /** runId -> manager association (botId + optional workKey). Absent = fleet-only. */
  meta?: Map<string, { botId: string; workKey?: string }>;
  /** readRecord throws for these runIds (a damaged record is not a missing one). */
  throwing?: Set<string>;
  verbTimeoutMs?: number;
  totalBudgetMs?: number;
};

function deps(opts: DepsOpts): DigestDeps {
  let reqSeq = 0;
  return {
    cli: opts.cli,
    readRecord: (runId) => {
      if (opts.throwing?.has(runId)) throw new Error(`damaged record: ${runId}`);
      return opts.records?.get(runId);
    },
    costLedger: {
      readRunCost: (runId) => costView(opts.fleetMicroUsd?.get(runId) ?? 0),
    },
    botTurnSpendUsd: (botId) => opts.botSpend?.get(botId),
    runMeta: (runId) => opts.meta?.get(runId),
    now: () => NOW,
    requestId: () => `req-digest-${++reqSeq}`,
    ...(opts.verbTimeoutMs !== undefined ? { verbTimeoutMs: opts.verbTimeoutMs } : {}),
    ...(opts.totalBudgetMs !== undefined ? { totalBudgetMs: opts.totalBudgetMs } : {}),
  };
}

function row(runId: string, opts?: { state?: string; createdAt?: string }): Record<string, unknown> {
  return {
    runId,
    state: opts?.state ?? "closed",
    ...(opts?.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
  };
}

afterEach(restoreCaptures);

// ─── AC2: the import fence asserts the ALLOWLIST ─────────────────────────────

/** Fleet imports permitted from src/managers/** — the AC2 allowlist, asserted here. */
const FLEET_ALLOWLIST = new Set(["status.ts", "result.ts"]);
/** Type-only additions: brief-schema.ts constants, never values. */
const FLEET_TYPE_ONLY = new Set(["brief-schema.ts"]);

/**
 * Every fleet-resolving import in `source` that is NOT on the allowlist. A
 * forbidden target fails whatever symbols it names; the type-only surface
 * fails a value import. Matches: full `import ... from` statements (bodies
 * without a `;` — the side-effect alt below stops the scan crossing one),
 * side-effect `import "spec";` statements, dynamic `import("spec")` calls,
 * and `export ... from` re-exports. Fleet targets are recognized as
 * dot-relative (`../fleet/`, `../../fleet/`, through an optional `src/`:
 * `../../src/fleet/`) or repo-root-relative (`src/fleet/`) — so a scanner
 * cannot be dodged by re-spelling the same module.
 */
function fleetImportViolations(source: string): string[] {
  const out: string[] = [];
  const fleetTarget = (spec: string): string | undefined => {
    const m = /^(?:(?:\.\.?\/)+(?:src\/)?|src\/)fleet\/(.+)$/.exec(spec);
    return m === null ? undefined : m[1]!;
  };
  const statements =
    /import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|import\s+["']([^"']+)["']|export\s+(type\s+)?[\s\S]*?from\s+["']([^"']+)["']/g;
  for (const m of source.matchAll(statements)) {
    const isTypeOnly = m[1] === "type " || m[5] === "type ";
    const spec = m[2] ?? m[3] ?? m[4] ?? m[6] ?? "";
    const target = fleetTarget(spec);
    if (target === undefined) continue;
    if (FLEET_ALLOWLIST.has(target)) continue;
    if (FLEET_TYPE_ONLY.has(target) && isTypeOnly) continue;
    out.push(`${spec} (${isTypeOnly ? "type-only" : "value"} import)`);
  }
  return out;
}

describe("AC2 import fence", () => {
  test("every src/managers/** import from src/fleet/ is on the allowlist (recursive)", () => {
    const violations: string[] = [];
    for (const path of [...walkTs(MANAGERS_DIR), DIGEST_CLI]) {
      const source = readFileSync(path, "utf8");
      for (const v of fleetImportViolations(source)) violations.push(`${path}: ${v}`);
    }
    expect(violations).toEqual([]);
  });

  test("the allowlist FAILS a fleet import outside it (asserted, not assumed)", () => {
    expect(
      fleetImportViolations(`import { requestApproval } from "../fleet/approval-gate.ts";`),
    ).toHaveLength(1);
    expect(
      fleetImportViolations(`import { sweepExpired } from "../fleet/approvers.ts";`),
    ).toHaveLength(1);
    expect(
      fleetImportViolations(`import { dispatchRun } from "../fleet/dispatch.ts";`),
    ).toHaveLength(1);
    // Dynamic-import form.
    expect(fleetImportViolations(`await import("../fleet/dispatch.ts");`)).toHaveLength(1);
    // Side-effect import form.
    expect(fleetImportViolations(`import "../fleet/dispatch.ts";`)).toHaveLength(1);
    // Repo-root-relative and dot-through-src spellings of the same module.
    expect(
      fleetImportViolations(`import { dispatchRun } from "src/fleet/dispatch.ts";`),
    ).toHaveLength(1);
    expect(
      fleetImportViolations(`import { dispatchRun } from "../../src/fleet/dispatch.ts";`),
    ).toHaveLength(1);
    // Re-export form.
    expect(
      fleetImportViolations(`export { dispatchRun } from "../fleet/dispatch.ts";`),
    ).toHaveLength(1);
    // An allowlisted side-effect import stays allowed — the side-effect alt
    // must not swallow the NEXT statement's allowlisted spec as its own.
    expect(
      fleetImportViolations(`import "../fleet/status.ts";\nimport { r } from "../fleet/result.ts";`),
    ).toEqual([]);
  });

  test("brief-schema.ts is type-only on the allowlist", () => {
    expect(fleetImportViolations(`import type { MAX_URL } from "../fleet/brief-schema.ts";`)).toEqual([]);
    expect(
      fleetImportViolations(`import { MAX_URL } from "../fleet/brief-schema.ts";`),
    ).toHaveLength(1);
    // A type-only RE-EXPORT of the type-only surface stays allowed.
    expect(
      fleetImportViolations(`export type { FleetBrief } from "../fleet/brief-schema.ts";`),
    ).toEqual([]);
  });

  test("non-fleet imports never trip the fence", () => {
    expect(
      fleetImportViolations(`import { deriveAttemptLadder } from "../fixloop/escalation.ts";`),
    ).toEqual([]);
    expect(fleetImportViolations(`import { log } from "../lib/log.ts";`)).toEqual([]);
  });

  test("no mutating symbol name appears anywhere in src/managers/** (recursive)", () => {
    const forbidden = [
      "buildEscalationComment",
      "postEscalationComment",
      "encodeFixOutcome",
      "requestApproval",
      "submitDecision",
      "sweepExpired",
    ];
    const hits: string[] = [];
    for (const path of walkTs(MANAGERS_DIR)) {
      const source = readFileSync(path, "utf8");
      for (const symbol of forbidden) {
        if (source.includes(symbol)) hits.push(`${path}: ${symbol}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// ─── AC3: additive absorption, bounded invocation ─────────────────────────────

/**
 * Timer calls at MODULE scope in `source` — the resident-process artifact the
 * AC3 fence forbids. Comments and string bodies are stripped first so brace
 * depth tracks code only; a timer inside a function (the invoker's own kill
 * timer) is scoped, exits with its owner, and is not a violation.
 */
function moduleScopeTimerHits(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
  const hits: string[] = [];
  const re = /\b(?:setInterval|setTimeout)\s*\(/g;
  let depth = 0;
  let scanned = 0;
  for (const m of code.matchAll(re)) {
    for (let i = scanned; i < m.index; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth = Math.max(0, depth - 1);
    }
    scanned = m.index;
    if (depth === 0) hits.push(code.slice(m.index, m.index + 20));
  }
  return hits;
}

describe("AC3 additive, bounded invocation", () => {
  test("the module-scope timer scan flags top-level timers, not in-function ones", () => {
    expect(moduleScopeTimerHits("setInterval(() => {}, 1000);")).toHaveLength(1);
    expect(moduleScopeTimerHits("function f() { setTimeout(() => {}, 1); }")).toEqual([]);
    // Comments naming the calls are not calls.
    expect(moduleScopeTimerHits("// setTimeout(x) lives elsewhere\nconst y = 1;")).toEqual([]);
  });

  test("no resident-process artifact: no module-scope timer in src/managers/** or the digest CLI leaf", () => {
    const hits: string[] = [];
    for (const path of [...walkTs(MANAGERS_DIR), DIGEST_CLI]) {
      for (const h of moduleScopeTimerHits(readFileSync(path, "utf8"))) hits.push(`${path}: ${h}`);
    }
    expect(hits).toEqual([]);
  });

  test("the composer invokes exactly status then result-per-run, then stops", async () => {
    const lines = captureInto();
    const { cli, journal } = fakeCli({
      statusRows: [row("run-a", { createdAt: NOW.toISOString() }), row("run-b", { createdAt: NOW.toISOString() })],
    });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("composed");
    expect(journal.map((j) => j.verb)).toEqual(["status", "result", "result"]);
    expect(journal[0]!.argv).toEqual(["status", "--driver", "exedev"]);
    expect(journal[1]!.argv).toEqual(["result", "run-a"]);
    expect(journal[2]!.argv).toEqual(["result", "run-b"]);
    // Bounded: nothing runs after the outcome returns.
    const frozen = journal.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(journal.length).toBe(frozen);
    expect(event(lines, "digest-complete")).toHaveLength(1);
  });

  test("the read dep is the only record surface: fixture ladder feeds through reads, no write path exists on the dep shape", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-parent", { createdAt: NOW.toISOString() })] });
    const records = new Map<string, RunRecord>([
      [
        "run-parent",
        record("run-parent", {
          fixLoop: { fixAttemptRunIds: ["fix-1"] },
        }),
      ],
      // The attempt's own terminal classification — read, never written.
      ["fix-1", record("fix-1", { fixLoop: { fixOutcomeClass: "ci-red" } })],
    ]);
    let reads = 0;
    const d = deps({ cli, records });
    const realRead = d.readRecord;
    d.readRecord = (runId) => {
      reads++;
      return realRead(runId);
    };
    const outcome = await composeDigest(d, {});
    expect(outcome.outcome).toBe("composed");
    expect(reads).toBeGreaterThanOrEqual(2); // parent + attempt, read-only
    // The escalation mark is DERIVED from the ladder — the additive view.
    expect(event(lines, "digest-escalation")).toHaveLength(0); // under ceiling → active
    expect(event(lines, "digest-snapshot")[0]!.fixloops_active).toBe(1);
  });
});

// ─── AC5: DD-20 join keys, absent-not-null / absent-not-0 ────────────────────

describe("AC5 join keys and spend", () => {
  test("a manager-associated line carries all three keys with both denominations verbatim", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-m", { createdAt: NOW.toISOString() })] });
    await composeDigest(
      deps({
        cli,
        fleetMicroUsd: new Map([["run-m", 12_345_678]]),
        botSpend: new Map([["bot-dev", 999.42]]),
        meta: new Map([["run-m", { botId: "bot-dev", workKey: "w:qa-fix-42" }]]),
      }),
      {},
    );
    const run = event(lines, "digest-run").find((l) => l.runId === "run-m")!;
    expect(run.workKey).toBe("w:qa-fix-42");
    expect(run.runId).toBe("run-m");
    expect(run.botId).toBe("bot-dev");
    // Both denominations verbatim — never converted between each other.
    expect(run.fleet_spend_micro_usd).toBe(12_345_678);
    expect(Number.isInteger(run.fleet_spend_micro_usd)).toBe(true);
    expect(run.bot_turn_spend_usd).toBe(999.42);
  });

  test("a fleet-only line: botId absent-not-null, bot_turn_spend_usd absent-not-0, workKey in w: form", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-f", { createdAt: NOW.toISOString() })] });
    await composeDigest(deps({ cli, fleetMicroUsd: new Map([["run-f", 500]]) }), {});
    const run = event(lines, "digest-run").find((l) => l.runId === "run-f")!;
    expect("botId" in run).toBe(false);
    expect(run.botId).toBeUndefined();
    expect("bot_turn_spend_usd" in run).toBe(false);
    expect(run.fleet_spend_micro_usd).toBe(500);
    expect(/^w:.+$/.test(run.workKey as string)).toBe(true);
    expect(run.workKey).toBe("w:run-f");
  });

  test("every emitted workKey passes WorkKeySchema", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [row("run-1", { createdAt: NOW.toISOString() }), row("run-2", { createdAt: NOW.toISOString() })],
    });
    await composeDigest(
      deps({
        cli,
        meta: new Map([["run-1", { botId: "bot-qa", workKey: "w:qa-something-long" }]]),
      }),
      {},
    );
    for (const l of event(lines, "digest-run")) {
      expect(() => WorkKeySchema.parse(l.workKey as string)).not.toThrow();
    }
  });

  test("a manager line whose gateway read has no figure carries bot_turn_spend_usd ABSENT, never a fabricated 0 — and the bot still counts as aggregated", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-m2", { createdAt: NOW.toISOString() })] });
    await composeDigest(
      deps({ cli, meta: new Map([["run-m2", { botId: "bot-dev" }]]) }),
      {},
    );
    const run = event(lines, "digest-run").find((l) => l.runId === "run-m2")!;
    expect(run.botId).toBe("bot-dev");
    expect("bot_turn_spend_usd" in run).toBe(false);
    // bots_aggregated counts DISTINCT ASSOCIATED botIds — the gateway figure's
    // presence is irrelevant, or the counter would disagree with the botIds
    // actually rendered on lines.
    expect(event(lines, "digest-snapshot")[0]!.bots_aggregated).toBe(1);
  });

  test("a botId outside the bot- vocabulary is rejected: association skipped, fleet-only line, bot_ids_rejected counted", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [
        row("run-rj", { createdAt: NOW.toISOString() }),
        // The bare prefix alone is not a bot id either — the config of record
        // refuses it (`/^bot-.+$/`), so the association guard does too.
        row("run-rj-bare", { createdAt: NOW.toISOString() }),
      ],
    });
    await composeDigest(
      // The gateway even carries a figure for the ill-formed id — the
      // rejection must still leave the line fleet-only, not half-attributed.
      deps({
        cli,
        botSpend: new Map([["not-a-bot", 42]]),
        meta: new Map([
          ["run-rj", { botId: "not-a-bot", workKey: "w:stamped-ok" }],
          ["run-rj-bare", { botId: "bot-" }],
        ]),
      }),
      {},
    );
    const run = event(lines, "digest-run").find((l) => l.runId === "run-rj")!;
    expect("botId" in run).toBe(false);
    expect("bot_turn_spend_usd" in run).toBe(false);
    // The whole association is skipped — even its stamped workKey never
    // renders; the line falls back to the derived form.
    expect(run.workKey).toBe("w:run-rj");
    const bare = event(lines, "digest-run").find((l) => l.runId === "run-rj-bare")!;
    expect("botId" in bare).toBe(false);
    expect(event(lines, "digest-snapshot")[0]!.bot_ids_rejected).toBe(2);
  });

  test("a stamped workKey that fails the schema renders the derived form and counts stamp_keys_invalidated", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-bad", { createdAt: NOW.toISOString() })] });
    expect(() => WorkKeySchema.parse("not-a-stamp")).toThrow(); // sanity: genuinely off-namespace
    const outcome = await composeDigest(
      deps({ cli, meta: new Map([["run-bad", { botId: "bot-qa", workKey: "not-a-stamp" }]]) }),
      {},
    );
    expect(outcome.outcome).toBe("composed");
    const run = event(lines, "digest-run").find((l) => l.runId === "run-bad")!;
    expect(run.workKey).toBe("w:run-bad"); // derived fallback, never the off-namespace stamp
    expect(event(lines, "digest-snapshot")[0]!.stamp_keys_invalidated).toBe(1);
  });

  test("a non-finite figure from either ledger is ABSENT on the line, never a null", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-nan", { createdAt: NOW.toISOString() })] });
    const d = deps({ cli, meta: new Map([["run-nan", { botId: "bot-nan" }]]) });
    d.costLedger.readRunCost = () => costView(Number.NaN);
    d.botTurnSpendUsd = () => Number.NaN;
    const outcome = await composeDigest(d, {});
    expect(outcome.outcome).toBe("composed");
    const run = event(lines, "digest-run")[0]!;
    expect("fleet_spend_micro_usd" in run).toBe(false);
    expect("bot_turn_spend_usd" in run).toBe(false);
    expect(run.fleet_spend_micro_usd).toBeUndefined(); // undefined, NOT null
    expect(run.bot_turn_spend_usd).toBeUndefined();
  });

  test("a derived workKey that fails the schema skips the line and counts run_lines_skipped", async () => {
    const lines = captureInto();
    const bad = ""; // an empty runId leaves the derived `w:` with no non-whitespace remainder
    const { cli } = fakeCli({ statusRows: [row(bad, { createdAt: NOW.toISOString() })] });
    expect(() => WorkKeySchema.parse(`w:${bad}`)).toThrow(); // sanity: the fixture is genuinely invalid
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("composed");
    expect(event(lines, "digest-run")).toEqual([]); // the line is never emitted
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.run_lines_skipped).toBe(1); // counted, never silent
    expect(snap.runs_observed).toBe(1); // the row was still observed honestly
  });

  test("a throwing costLedger.readRunCost leaves fleet_spend_micro_usd absent, never 0", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-led", { createdAt: NOW.toISOString() })] });
    const d = deps({ cli });
    d.costLedger.readRunCost = () => {
      throw new Error("ledger boom");
    };
    const outcome = await composeDigest(d, {});
    expect(outcome.outcome).toBe("composed");
    const run = event(lines, "digest-run")[0]!;
    expect("fleet_spend_micro_usd" in run).toBe(false);
    expect(run.fleet_spend_micro_usd).toBeUndefined();
  });

  test("a CostView with no events leaves fleet_spend_micro_usd ABSENT — never a 0 across the dep boundary", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-noev", { createdAt: NOW.toISOString() })] });
    const d = deps({ cli });
    d.costLedger.readRunCost = () => costView(0, false);
    const outcome = await composeDigest(d, {});
    expect(outcome.outcome).toBe("composed");
    const run = event(lines, "digest-run")[0]!;
    expect("fleet_spend_micro_usd" in run).toBe(false);
    expect(run.fleet_spend_micro_usd).toBeUndefined();
  });

  test("a 0 WITH events still renders fleet_spend_micro_usd 0 (the figure is real, not invented)", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-zero", { createdAt: NOW.toISOString() })] });
    const d = deps({ cli });
    d.costLedger.readRunCost = () => costView(0, true);
    const outcome = await composeDigest(d, {});
    expect(outcome.outcome).toBe("composed");
    const run = event(lines, "digest-run")[0]!;
    expect("fleet_spend_micro_usd" in run).toBe(true);
    expect(run.fleet_spend_micro_usd).toBe(0);
  });

  test("a throwing runMeta and botTurnSpendUsd still resolve: association skipped, figure absent", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-th", { createdAt: NOW.toISOString() })] });
    const d = deps({ cli, meta: new Map([["run-th", { botId: "bot-x", workKey: "w:stamped" }]]) });
    d.runMeta = () => {
      throw new Error("meta boom");
    };
    d.botTurnSpendUsd = () => {
      throw new Error("spend boom");
    };
    const outcome = await composeDigest(d, {});
    expect(outcome.outcome).toBe("composed"); // never throws, never fails the digest
    const run = event(lines, "digest-run")[0]!;
    expect("botId" in run).toBe(false);
    expect("bot_turn_spend_usd" in run).toBe(false);
    // The stamped key never reached validation — the derived form rendered.
    expect(run.workKey).toBe("w:run-th");
  });

  test("duplicate runId rows: last occurrence wins, duplicate_rows_dropped counted", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [
        // If the FIRST occurrence won, the orphan filter would drop the run —
        // a surviving digest-run line proves the LAST (newest) won.
        row("run-dup", { state: "orphan" }),
        row("run-dup", { createdAt: NOW.toISOString() }),
      ],
    });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("composed");
    expect(event(lines, "digest-run").map((l) => l.runId)).toEqual(["run-dup"]);
    expect(event(lines, "digest-snapshot")[0]!.duplicate_rows_dropped).toBe(1);
  });

  test("snapshot line carries exactly the contract fields", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-x", { createdAt: NOW.toISOString() })] });
    await composeDigest(deps({ cli }), {});
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(Object.keys(snap).sort()).toEqual([
      "agentId",
      "bots_aggregated",
      "duration",
      "event",
      "fixloops_active",
      "operation",
      "approvals_parked",
      "requestId",
      "runs_observed",
      "snapshot_ms",
      "status",
      "timestamp",
      "truncated",
    ].sort());
    expect(typeof snap.snapshot_ms).toBe("number");
    expect(snap.snapshot_ms).toBeGreaterThanOrEqual(0);
    expect(snap.runs_observed).toBe(1);
    // Clean legs: the degrade/skip fields are absent, not 0.
    expect("degraded" in snap).toBe(false);
    expect("reason" in snap).toBe(false);
    expect("run_lines_skipped" in snap).toBe(false);
    expect("non_run_rows_dropped" in snap).toBe(false);
    expect("duplicate_rows_dropped" in snap).toBe(false);
    expect("result_verbs_skipped" in snap).toBe(false);
    expect("result_verbs_failed" in snap).toBe(false);
    expect("bot_ids_rejected" in snap).toBe(false);
    expect("stamp_keys_invalidated" in snap).toBe(false);
    expect("malformed_ledger_legs" in snap).toBe(false);
  });
});

// ─── escalation marks ─────────────────────────────────────────────────────────

describe("escalation marks", () => {
  test("approval-park fires past the threshold, with reportId as the approvalId", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-p", { createdAt: NOW.toISOString() })] });
    const parkedAt = new Date(NOW.getTime() - PARK_THRESHOLD_MS - 1).toISOString();
    await composeDigest(
      deps({
        cli,
        records: new Map([
          [
            "run-p",
            record("run-p", {
              approval: { state: "awaiting-approval", requestedAt: parkedAt, reportId: "rep-9" },
            }),
          ],
        ]),
      }),
      {},
    );
    const marks = event(lines, "digest-escalation");
    expect(marks).toEqual([expect.objectContaining({ kind: "approval-park", approvalId: "rep-9" })]);
    const run = event(lines, "digest-run")[0]!;
    expect(run.escalation).toContain("approval-park");
    expect(event(lines, "digest-snapshot")[0]!.approvals_parked).toBe(1);
  });

  test("threshold boundary: just-under is parked-but-unmarked, exactly-at is marked (inclusive)", async () => {
    for (const [offset, shouldMark] of [
      [1000, false],
      [0, true],
      [-1000, true],
    ] as const) {
      const lines = captureInto();
      const { cli } = fakeCli({ statusRows: [row("run-b", { createdAt: NOW.toISOString() })] });
      const requestedAt = new Date(NOW.getTime() - PARK_THRESHOLD_MS + offset).toISOString();
      await composeDigest(
        deps({
          cli,
          records: new Map([
            ["run-b", record("run-b", { approval: { state: "awaiting-approval", requestedAt } })],
          ]),
        }),
        {},
      );
      const marks = event(lines, "digest-escalation");
      if (shouldMark) {
        // No reportId → the record's requestId… absent → the runId names the mark.
        expect(marks[0]).toEqual(expect.objectContaining({ kind: "approval-park", approvalId: "run-b" }));
      } else {
        expect(marks).toEqual([]);
        expect(event(lines, "digest-snapshot")[0]!.approvals_parked).toBe(1); // parked, under threshold
      }
    }
  });

  test("fixloop-exhausted fires when the ladder is at its charged ceiling", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-par", { createdAt: NOW.toISOString() })] });
    await composeDigest(
      deps({
        cli,
        records: new Map<string, RunRecord>([
          ["run-par", record("run-par", { fixLoop: { fixAttemptRunIds: ["f1", "f2"] } })],
          ["f1", record("f1", { fixLoop: { fixOutcomeClass: "ci-red" } })],
          ["f2", record("f2", { fixLoop: { fixOutcomeClass: "ci-red" } })],
        ]),
      }),
      {},
    );
    expect(event(lines, "digest-escalation")).toEqual([
      expect.objectContaining({ kind: "fixloop-exhausted", runId: "run-par" }),
    ]);
    expect(event(lines, "digest-run").find((l) => l.runId === "run-par")!.escalation).toContain(
      "fixloop-exhausted",
    );
    expect(event(lines, "digest-snapshot")[0]!.fixloops_active).toBe(0);
  });

  test("exit-6 fires from the result invocation's own exit code", async () => {
    const lines = captureInto();
    const { cli, journal } = fakeCli({
      statusRows: [row("run-six", { createdAt: NOW.toISOString() })],
      resultRc: (runId) => (runId === "run-six" ? 6 : 0),
    });
    await composeDigest(deps({ cli }), {});
    expect(event(lines, "digest-escalation")).toEqual([
      expect.objectContaining({ kind: "exit-6", runId: "run-six" }),
    ]);
    expect(journal.find((j) => j.verb === "result" && j.argv[1] === "run-six")!.rc).toBe(6);
  });

  test("a run-not-found result (rc 4) is no mark at all", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [row("run-gone", { createdAt: NOW.toISOString() })],
      resultRc: () => 4,
    });
    await composeDigest(deps({ cli }), {});
    expect(event(lines, "digest-escalation")).toEqual([]);
  });

  test("PARK_THRESHOLD_MS tracks the approval gate's DEFAULT_TIMEOUT_MS literal (drift tripwire)", () => {
    const src = readFileSync(APPROVAL_GATE, "utf8");
    const m = /DEFAULT_TIMEOUT_MS\s*=\s*([^;\n]+);/.exec(src);
    expect(m).not.toBeNull();
    // The literal is a product of integer factors (24 * 60 * 60 * 1000 today);
    // anything else is a drift the tripwire refuses to guess at.
    const factors = m![1]!.trim().split("*").map((s) => Number(s.trim()));
    expect(factors.length).toBeGreaterThan(1);
    expect(factors.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect(PARK_THRESHOLD_MS).toBe(factors.reduce((a, b) => a * b, 1));
  });

  test("a damaged readRecord degrades to record-less facts: no approval/fixloop marks, line still renders, no crash", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-dmg", { createdAt: NOW.toISOString() })] });
    const outcome = await composeDigest(
      deps({
        cli,
        // The record EXISTS and would carry both mark kinds — but the read
        // throws, so the composer sees a record without facts.
        records: new Map<string, RunRecord>([
          [
            "run-dmg",
            record("run-dmg", {
              approval: {
                state: "awaiting-approval",
                requestedAt: new Date(NOW.getTime() - PARK_THRESHOLD_MS - 1).toISOString(),
              },
              fixLoop: { fixAttemptRunIds: ["f1", "f2"] },
            }),
          ],
          ["f1", record("f1", { fixLoop: { fixOutcomeClass: "ci-red" } })],
          ["f2", record("f2", { fixLoop: { fixOutcomeClass: "ci-red" } })],
        ]),
        throwing: new Set(["run-dmg"]),
      }),
      {},
    );
    expect(outcome.outcome).toBe("composed");
    expect(event(lines, "digest-escalation")).toEqual([]);
    expect(event(lines, "digest-run")).toHaveLength(1); // the line still renders
    expect(event(lines, "digest-complete")).toHaveLength(1);
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.approvals_parked).toBe(0);
    expect(snap.fixloops_active).toBe(0);
  });

  test("a run whose line is skipped (invalid derived workKey) emits NO escalation marks and counts NO figures — exhausted ladder AND parked approval both stay out", async () => {
    const lines = captureInto();
    // Two distinct runIds whose derived `w:` form fails the schema: "" (empty
    // remainder) and "\u0007" (a control character in the remainder).
    const empty = "";
    const ctrl = "\u0007";
    const { cli } = fakeCli({
      statusRows: [
        row(empty, { createdAt: NOW.toISOString() }),
        row(ctrl, { createdAt: NOW.toISOString() }),
      ],
    });
    const parkedAt = new Date(NOW.getTime() - PARK_THRESHOLD_MS - 1).toISOString();
    const outcome = await composeDigest(
      deps({
        cli,
        records: new Map<string, RunRecord>([
          // The empty-id run: an EXHAUSTED ladder plus a parked approval —
          // both mark-worthy, neither countable.
          [
            empty,
            record(empty, {
              approval: { state: "awaiting-approval", requestedAt: parkedAt },
              fixLoop: { fixAttemptRunIds: ["f1", "f2"] },
            }),
          ],
          // The control-char run: an ACTIVE ladder plus a parked approval.
          [
            ctrl,
            record(ctrl, {
              approval: { state: "awaiting-approval", requestedAt: parkedAt },
              fixLoop: { fixAttemptRunIds: ["f3"] },
            }),
          ],
          ["f1", record("f1", { fixLoop: { fixOutcomeClass: "ci-red" } })],
          ["f2", record("f2", { fixLoop: { fixOutcomeClass: "ci-red" } })],
          ["f3", record("f3", { fixLoop: { fixOutcomeClass: "ci-red" } })],
        ]),
      }),
      {},
    );
    expect(outcome.outcome).toBe("composed");
    expect(event(lines, "digest-run")).toEqual([]); // both lines skipped
    expect(event(lines, "digest-escalation")).toEqual([]); // so no mark references a skipped run
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.run_lines_skipped).toBe(2);
    // The figures count RENDERED runs: with both lines skipped, the exhausted
    // ladder, the active ladder, and both parked approvals leave them at 0.
    expect(snap.fixloops_active).toBe(0);
    expect(snap.approvals_parked).toBe(0);
  });

  test("a parent ledger naming an id with NO record still composes: line renders, digest-complete fires (dangling-id pin)", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [row("run-par-dangle", { createdAt: NOW.toISOString() })],
    });
    const outcome = await composeDigest(
      deps({
        cli,
        records: new Map<string, RunRecord>([
          // The ledger names fix-ghost; NO record for it exists anywhere. The
          // ladder's own dangling-id catch (a read that raises → a dead
          // attempt) keeps the poll alive — this pin is a regression guard on
          // that behavior, not its proof.
          ["run-par-dangle", record("run-par-dangle", { fixLoop: { fixAttemptRunIds: ["fix-ghost"] } })],
        ]),
      }),
      {},
    );
    expect(outcome.outcome).toBe("composed");
    expect(event(lines, "digest-run")).toHaveLength(1); // the line renders
    expect(event(lines, "digest-complete")).toHaveLength(1); // the digest completes
  });

  test("a fixAttemptRunIds leg that is not an array of strings skips the fixloop leg and counts malformed_ledger_legs", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-mal", { createdAt: NOW.toISOString() })] });
    await composeDigest(
      deps({
        cli,
        records: new Map<string, RunRecord>([
          // A number sneaked into the ledger — the leg is unwalkable.
          ["run-mal", record("run-mal", { fixLoop: { fixAttemptRunIds: ["f1", 42] } })],
          ["f1", record("f1", { fixLoop: { fixOutcomeClass: "ci-red" } })],
        ]),
      }),
      {},
    );
    expect(event(lines, "digest-escalation")).toEqual([]);
    expect(event(lines, "digest-snapshot")[0]!.malformed_ledger_legs).toBe(1);
  });

  test("status.ts vocabulary the composer filters on has not drifted (tripwire)", () => {
    const src = readFileSync(STATUS_TS, "utf8");
    // The fleet-level row id the composer drops.
    const id = /export const FLEET_ROW_ID = "([^"]+)"/.exec(src);
    expect(id?.[1]).toBe("(fleet)");
    // The row states the composer's population filter names — a rename or a
    // dropped literal here would emit phantom run lines, so fail loudly.
    const union = /state:\s*([\s\S]*?)\|\s*\(string & \{\}\)/.exec(src);
    expect(union).not.toBeNull();
    const literals = [...union![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    for (const state of ["orphan", "listUnavailable", "recordsSkipped"]) {
      expect(literals).toContain(state);
    }
  });
});

// ─── boundedness ──────────────────────────────────────────────────────────────

describe("boundedness", () => {
  test("truncation drops oldest first with an explicit truncated count", async () => {
    const lines = captureInto();
    const total = MAX_SNAPSHOT_RUNS + 2;
    // One dated row TOO many, plus one row with NO createdAt at all: the
    // unknown-age row sorts first (the NEGATIVE_INFINITY sentinel) and must
    // be among the dropped — truncation drops the LEAST-known age before any
    // dated one.
    const undated = "run-undated";
    const rows = [
      ...Array.from({ length: total }, (_, i) =>
        row(`run-${String(i).padStart(3, "0")}`, { createdAt: new Date(NOW.getTime() + i * 1000).toISOString() }),
      ),
      row(undated),
    ];
    const { cli } = fakeCli({ statusRows: rows });
    await composeDigest(deps({ cli }), {});
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.runs_observed).toBe(total + 1);
    expect(snap.truncated).toBe(3);
    const runLines = event(lines, "digest-run");
    expect(runLines).toHaveLength(MAX_SNAPSHOT_RUNS);
    // The unknown-age row and the oldest two dated rows dropped, newest kept.
    expect(runLines.some((l) => l.runId === undated)).toBe(false);
    expect(runLines.some((l) => l.runId === "run-000")).toBe(false);
    expect(runLines.some((l) => l.runId === "run-001")).toBe(false);
    expect(runLines.some((l) => l.runId === `run-${String(total - 1).padStart(3, "0")}`)).toBe(true);
  });

  test("orphan and fleet-level rows are not run lines — and the rows they drop are counted", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [
        row("run-real", { createdAt: NOW.toISOString() }),
        row("(orphan stray-box)", { state: "orphan" }),
        { runId: "(fleet)", state: "listUnavailable" },
      ],
    });
    await composeDigest(deps({ cli }), {});
    expect(event(lines, "digest-run").map((l) => l.runId)).toEqual(["run-real"]);
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.runs_observed).toBe(1);
    expect(snap.non_run_rows_dropped).toBe(2);
  });

  test("a single orphan row is counted as non_run_rows_dropped, never silent", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [
        row("run-only", { createdAt: NOW.toISOString() }),
        row("(orphan ghost-box)", { state: "orphan" }),
      ],
    });
    await composeDigest(deps({ cli }), {});
    expect(event(lines, "digest-run").map((l) => l.runId)).toEqual(["run-only"]);
    expect(event(lines, "digest-snapshot")[0]!.non_run_rows_dropped).toBe(1);
  });

  test("status stdout over MAX_STATUS_ROWS degrades the leg with the cap reason", async () => {
    const lines = captureInto();
    const rows = Array.from({ length: MAX_STATUS_ROWS + 1 }, (_, i) =>
      row(`run-${i}`, { createdAt: NOW.toISOString() }),
    );
    const { cli } = fakeCli({ statusRows: rows });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("status-unavailable");
    expect(outcome.reason).toBe(`fleet status returned ${MAX_STATUS_ROWS + 1} rows, over the cap`);
    expect(event(lines, "digest-run")).toEqual([]); // no unbounded dump summarized
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.degraded).toBe(true);
    expect(snap.reason).toBe(outcome.reason);
    expect(event(lines, "digest-complete")).toHaveLength(1);
  });

  test("the cap check precedes parsing: an over-cap stdout never reaches JSON.parse", async () => {
    const lines = captureInto();
    // One row too many, with a MALFORMED line at the end: if the composer
    // parsed, the parse error would win — the cap reason proves it did not.
    const rows = Array.from({ length: MAX_STATUS_ROWS }, (_, i) =>
      JSON.stringify(row(`run-${i}`, { createdAt: NOW.toISOString() })),
    );
    const stdout = `${rows.join("\n")}\n{broken json\n`;
    const { cli } = fakeCli({ statusStdout: stdout });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("status-unavailable");
    expect(outcome.reason).toBe(`fleet status returned ${MAX_STATUS_ROWS + 1} rows, over the cap`);
    expect(outcome.reason).not.toContain("did not parse");
    expect(event(lines, "digest-complete")).toHaveLength(1);
  });

  test("malformed status stdout degrades the leg: /did not parse/ reason, no run lines, digest-complete present", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusStdout: `{broken\n${JSON.stringify(row("run-v", { createdAt: NOW.toISOString() }))}\n`,
    });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("status-unavailable");
    expect(outcome.reason).toMatch(/did not parse/);
    expect(event(lines, "digest-run")).toEqual([]); // one bad line poisons the whole leg
    expect(event(lines, "digest-complete")).toHaveLength(1);
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.degraded).toBe(true);
    expect(snap.reason).toBe(outcome.reason);
  });

  test("a fat field is truncated and flagged, never an over-budget line", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-fat", { createdAt: NOW.toISOString() })] });
    await composeDigest(
      deps({ cli, meta: new Map([["run-fat", { botId: `bot-${"x".repeat(20_000)}` }]]) }),
      {},
    );
    const run = event(lines, "digest-run").find((l) => l.runId === "run-fat")!;
    const bytes = Buffer.byteLength(JSON.stringify(run));
    expect(bytes).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(run.line_truncated).toBe(true);
  });

  test("per-verb timings absent-not-0 when the result verb was skipped", async () => {
    const lines = captureInto();
    const { cli, journal } = fakeCli({ statusRc: 1 });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("status-unavailable");
    expect(outcome.exitCode).toBe(1);
    expect(journal.map((j) => j.verb)).toEqual(["status"]); // result never invoked
    expect(event(lines, "digest-run")).toEqual([]);
    expect(event(lines, "digest-snapshot")[0]!.runs_observed).toBe(0);
    expect(event(lines, "digest-complete")).toHaveLength(1);
    for (const l of lines) expect("result_ms" in l).toBe(false);
    // Degrade visibility: the snapshot says so, with the reason.
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.degraded).toBe(true);
    expect(snap.reason).toBe("fleet status exited 1");
  });

  test("a non-zero status exit carries the capped, REDACTED stderr tail in the degrade reason", async () => {
    const lines = captureInto();
    const secret = "S".repeat(48); // a ≥40-char opaque run — redactSecrets swallows it
    const { cli } = fakeCli({
      statusRc: 3,
      statusStderr: `${secret} then ${"detail ".repeat(80)}\nsecond line\n`,
    });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.reason).toMatch(/^fleet status exited 3 — /);
    const tail = (outcome.reason as string).slice("fleet status exited 3 — ".length);
    expect(tail.length).toBeLessThanOrEqual(200); // capped, never a raw dump
    expect(outcome.reason).not.toContain("second line"); // tail only, capped at the first 200 chars
    // Redaction before the cap: the secret never reaches the outcome's reason
    // — nor the snapshot's.
    expect(outcome.reason).not.toContain(secret);
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.reason).toBe(outcome.reason);
    expect(snap.reason).not.toContain(secret);
  });

  test("result_ms is present and measured when the result verb ran", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-t", { createdAt: NOW.toISOString() })] });
    await composeDigest(deps({ cli }), {});
    const run = event(lines, "digest-run")[0]!;
    expect(typeof run.result_ms).toBe("number");
    expect(run.result_ms).toBeGreaterThanOrEqual(0);
  });

  test("a verb past its deadline degrades to unavailable with the timeout reason, never hangs", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ hang: true });
    const outcome = await composeDigest(deps({ cli, verbTimeoutMs: 25 }), {});
    expect(outcome.outcome).toBe("status-unavailable");
    expect(outcome.reason).toBe("the fleet status invocation timed out");
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.degraded).toBe(true);
    expect(snap.reason).toBe(outcome.reason);
    expect(event(lines, "digest-complete")).toHaveLength(1);
  });

  test("timeout and spawn-failure degrade reasons are distinguishable", async () => {
    const timedOut = await composeDigest(deps({ cli: fakeCli({ hang: true }).cli, verbTimeoutMs: 25 }), {});
    expect(timedOut.reason).toBe("the fleet status invocation timed out");
    const spawnFailed = await composeDigest(
      deps({ cli: fakeCli({ statusThrows: true }).cli }),
      {},
    );
    expect(spawnFailed.reason).toBe("fleet status failed: spawn failed: bun not found");
    expect(spawnFailed.outcome).toBe("status-unavailable");
  });

  test("past the total budget the result verbs stop, counted, outcome still composed", async () => {
    const lines = captureInto();
    const { cli, journal } = fakeCli({
      statusRows: [row("run-a", { createdAt: NOW.toISOString() }), row("run-b", { createdAt: NOW.toISOString() })],
      slowMs: 4,
    });
    const outcome = await composeDigest(deps({ cli, totalBudgetMs: 1 }), {});
    expect(outcome.outcome).toBe("composed"); // the digest fired with partial legs
    expect(outcome.reason).toMatch(/2 result verbs skipped/);
    expect(journal.map((j) => j.verb)).toEqual(["status"]); // no result verb issued
    expect(event(lines, "digest-run")).toHaveLength(2); // lines render, legs skipped
    for (const l of event(lines, "digest-run")) expect("result_ms" in l).toBe(false);
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.result_verbs_skipped).toBe(2);
    expect(snap.degraded).toBeUndefined(); // the STATUS leg was clean
    expect(event(lines, "digest-complete")).toHaveLength(1);
  });

  test("a result leg that fails (spawn-fail) counts result_verbs_failed, distinct from budget-cut skips", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [row("run-fr", { createdAt: NOW.toISOString() })],
      resultThrows: true,
    });
    const outcome = await composeDigest(deps({ cli }), {});
    expect(outcome.outcome).toBe("composed"); // the status leg was clean
    expect(outcome.reason).toBeUndefined();
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.result_verbs_failed).toBe(1);
    expect("result_verbs_skipped" in snap).toBe(false); // not a budget cut
    expect("result_ms" in event(lines, "digest-run")[0]!).toBe(false);
  });

  test("a HUNG result child classifies as result_verbs_failed (timeout kind): outcome composed, result_ms absent", async () => {
    const lines = captureInto();
    const { cli, journal } = fakeCli({
      statusRows: [row("run-hr", { createdAt: NOW.toISOString() })],
      resultHangs: true,
    });
    const outcome = await composeDigest(deps({ cli, verbTimeoutMs: 25 }), {});
    // The status leg was clean, so the digest still composes; the dead result
    // verb is a counted failure, never a hang and never a silent skip.
    expect(outcome.outcome).toBe("composed");
    expect(outcome.reason).toBeUndefined();
    expect(journal.map((j) => j.verb)).toEqual(["status", "result"]); // the verb WAS issued
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.result_verbs_failed).toBe(1);
    expect("result_verbs_skipped" in snap).toBe(false); // the per-verb budget cut it, not the total
    expect("result_ms" in event(lines, "digest-run")[0]!).toBe(false);
    expect(event(lines, "digest-complete")).toHaveLength(1);
  });

  test("the production invoker kills a wedged child and rejects with FleetVerbTimeoutError", async () => {
    const script = join(tmpdir(), `qds-digest-hang-${process.pid}.ts`);
    await Bun.write(script, "await new Promise(() => {});\n");
    try {
      const invoker = fleetCliInvoker({ entry: script, timeoutMs: 60 });
      await expect(invoker(["status"])).rejects.toBeInstanceOf(FleetVerbTimeoutError);
    } finally {
      try {
        unlinkSync(script);
      } catch {
        // best-effort cleanup of a tmp fixture
      }
    }
  });

  test("the production invoker sweeps a GRANDCHILD holding stdout open — no tree leak past the timeout", async () => {
    // `sleep`'s duration doubles as the run-unique marker (kill-tree.test.ts's
    // shape), so a leaked sleeper from an earlier run can never be mistaken
    // for this run's survivor.
    const marker = `3000.${process.pid}${Math.floor(Math.random() * 1e6)}`;
    const script = join(tmpdir(), `qds-digest-grandchild-${process.pid}.ts`);
    await Bun.write(
      script,
      [
        'import { spawn } from "node:child_process";',
        // The grandchild shares the leader's PIPED stdout: past the timeout it
        // is exactly what a lead-only kill would leave holding the pipe open.
        `spawn("sh", ["-c", "sleep ${marker}"], { stdio: ["ignore", "inherit", "inherit"] });`,
        "await new Promise(() => {});", // the wedged leader never exits on its own
      ].join("\n"),
    );
    const alive = (): number =>
      Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim().split("\n").filter(Boolean).length;
    try {
      const invoker = fleetCliInvoker({ entry: script, timeoutMs: 60 });
      const pending = invoker(["status"]);
      // Non-vacuous: the grandchild really started (and holds the pipe) while
      // the leader is still wedged.
      const deadline = Date.now() + 5_000;
      while (alive() === 0) {
        if (Date.now() > deadline) throw new Error("grandchild never started");
        await new Promise((r) => setTimeout(r, 25));
      }
      await expect(pending).rejects.toBeInstanceOf(FleetVerbTimeoutError);
      // The group sweep is synchronous from the killer's side; give the
      // signal a beat to land (kill-tree.test.ts's settle discipline).
      await new Promise((r) => setTimeout(r, 300));
      expect(alive()).toBe(0);
    } finally {
      Bun.spawnSync(["pkill", "-f", marker]);
      try {
        unlinkSync(script);
      } catch {
        // best-effort cleanup of a tmp fixture
      }
    }
  });

  test("the production invoker propagates a happy child's exit code, stdout, and stderr faithfully", async () => {
    const script = join(tmpdir(), `qds-digest-happy-${process.pid}.ts`);
    await Bun.write(script, 'console.log("out-line");\nconsole.error("err-line");\n');
    try {
      const invoker = fleetCliInvoker({ entry: script, timeoutMs: 10_000 });
      const result = await invoker(["status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("out-line");
      expect(result.stderr).toContain("err-line");
    } finally {
      try {
        unlinkSync(script);
      } catch {
        // best-effort cleanup of a tmp fixture
      }
    }
  });
});

// ─── channel discipline ───────────────────────────────────────────────────────

describe("channel discipline", () => {
  test("every line carries the invocation's own requestId and the managers.digest operation", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-r", { createdAt: NOW.toISOString() })] });
    const outcome = await composeDigest(deps({ cli }), {});
    for (const l of lines) {
      expect(l.operation).toBe("managers.digest");
      expect(l.requestId).toBe(outcome.requestId);
    }
    expect(new Set(lines.map((l) => l.event))).toEqual(
      new Set(["digest-snapshot", "digest-run", "digest-complete"]),
    );
  });

  test("snapshot_ms is clamped at 0 and carried as every line's duration", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [row("run-d", { createdAt: NOW.toISOString() })] });
    await composeDigest(deps({ cli }), {});
    for (const l of lines) {
      expect(typeof l.duration).toBe("number");
      expect(l.duration).toBeGreaterThanOrEqual(0);
    }
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.duration).toBe(snap.snapshot_ms);
    expect(snap.snapshot_ms).toBe(0); // deps.now is a fixed clock: clamped, not negative
  });
});

describe("A3 — sweep-report residue marks (adds-only)", () => {
  test("an undelivered sweep report becomes a sweep-scoped escalation mark carrying its sweepId", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({ statusRows: [] });
    const outcome = await composeDigest(
      { ...deps({ cli }), undeliveredSweepReports: () => ["sweep-2026-10-12", "not-a-sweep-id"] },
      {},
    );
    expect(event(lines, "digest-escalation")).toEqual([
      expect.objectContaining({ kind: "sweep-report-undelivered", sweepId: "sweep-2026-10-12" }),
    ]);
    expect(outcome.escalationMarks).toBe(1); // the malformed id is dropped, never rendered
    expect(ESCALATION_KINDS).toContain("sweep-report-undelivered");
  });

  test("absent dep = A1's digest unchanged; a throwing read is no marks, never a failed digest", async () => {
    for (const extra of [{}, { undeliveredSweepReports: (): string[] => { throw new Error("EACCES"); } }]) {
      const lines = captureInto();
      const { cli } = fakeCli({ statusRows: [] });
      const outcome = await composeDigest({ ...deps({ cli }), ...extra }, {});
      expect(outcome.outcome).toBe("composed");
      expect(event(lines, "digest-escalation")).toEqual([]);
      restoreCaptures();
    }
  });
});
