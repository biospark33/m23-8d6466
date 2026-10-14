/**
 * J3 (contract I1/I2) — the dispatch routing hook + tier carry, pinned at the
 * REAL `dispatch()` call site (the M2.2 dispatch-memory-seam pattern: real
 * sqlite run-record store on a per-suite tmpdir, fake driver, fixed clock,
 * env save/restore, no network). What is under test is the WIRING, not a
 * copy of it:
 *   (1) ordering — the hook runs ONCE, strictly after the runId is settled
 *       (its input.runId IS the minted id the ack returns) and strictly
 *       before admission's first observable (store.create);
 *   (2) no-op default — an unset router is byte-identical legacy behavior:
 *       zero routing artifacts, zero routing log lines;
 *   (3) carry — a resolved hook materializes the override in BOTH downstream
 *       surfaces (the host-side gate copy beside the run record, and the
 *       fill BoxFile at the checkout's `.qds/roster.yaml`) with the stamped
 *       manifest's dispatch_task roster repointed at it, while the SOURCE
 *       roster.yaml stays byte-identical;
 *   (4) skip fold — a THROWING hook never fails a dispatch and leaves zero
 *       routing artifacts;
 *   (5) import-closure fence — no src/judgment specifier under any spelling
 *       in dispatch.ts (static, dynamic import(), require()), with TEETH
 *       (every forbidden spelling is flagged on a synthetic positive) and
 *       not-vacuous (the real source is read in full and the scanner finds
 *       its real imports); plus the structural pin that the setup-gate
 *       literal's `rosterPath,` shorthand sits under the J3 shadow
 *       (adds-only cannot rewrite that line, so the scope does it);
 *   (6) invalid pair — an override pair no catalog contains still
 *       MATERIALIZES (dispatch does not validate; the gate/engine refuse):
 *       parseRoster accepts the rendered copy structurally and the UNCHANGED
 *       validateRoster refuses it exactly like a hand-written typo;
 *   (7) roster drift — an appliedPairs naming NO role the re-read roster
 *       still has folds the carry (no gate copy, no fill BoxFile, no manifest
 *       repoint) and emits ONE guarded routing-carry-skipped house line; plus
 *       the structural pin that the PRODUCTION wiring in scripts/fleet.ts
 *       arms the hook and runs the harvest leg — deleting either line must
 *       fail a test (the reviewer demonstrated every suite stays green with
 *       both deleted);
 *   (8) absent roster at carry — the named dispatch-level arm for the fold
 *       q1-contract covers behaviorally: no roster.yaml beside the manifest
 *       ⇒ dispatch completes, zero routing artifacts, ONE
 *       routing-roster-unavailable house line;
 *   (9) over-ceiling at carry (round-2) — a roster already over
 *       ROSTER_MAX_BYTES reaching the carry on the pre-check-skipping fake
 *       driver FOLDS like absent (one routing-roster-over-ceiling house
 *       line) instead of refusing a provisioned run.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { type LogEntry, setLogSink } from "../../src/lib/log.ts";
import { dispatch, fakeGate, type DispatchDeps, type RoutingDecisionInput, type RoutingHookResult } from "../../src/fleet/dispatch.ts";
import { goodLedger } from "./helpers.ts";
import {
  applyTierOverride,
  parseRoster,
  ROSTER_MAX_BYTES,
  renderRoster,
  type ResolvedRoster,
} from "../../src/phase-engine/roster/schema.ts";
import {
  type CatalogProbe,
  type ProviderProbe,
  type RateSources,
  type RateTable,
  validateRoster,
} from "../../src/phase-engine/roster/validate.ts";

/**
 * Every env var the neighboring dispatch legs key on. All are DELETED for the
 * whole suite: the memory/kg lanes must never fire here, and no config-present
 * case may fall through to a real client against the developer's env.
 */
const ENV_KEYS = [
  "MEMGATE_ADMIN_KEY",
  "QDS_MEMGATE_SIGNING_KEY",
  "QDS_KG_GATEWAY_URL",
  "QDS_MEMGATE_LEDGER",
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "HINDSIGHT_API_KEY",
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "qds-j3-dispatch-router-")));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** A structurally valid roster; `lead` rides every arm untouched. */
const ROSTER_YAML = `
defaults:
  provider: openrouter
  thinking: medium
  tools: null
  writes: []
  harness_engineering: []

roles:
  - name: lead
    model: anthropic/claude-haiku-4.5
    thinking: high

  - name: fixer
    model: deepseek/deepseek-v3.2
    writes: ["src/", "tests/"]
`;

const MANIFEST_REL = join("manifests", "pipeline.json");

/** The override a resolved hook hands back — `fixer` drops to the cheap pair.
 * The shape is a real SHAPES member and the score vector names all six
 * features with the e2e's A-dispatch values (1 task, 2 phases, 1 role, 3 path
 * mentions, neutral priors ⇒ 0.2357 ≤ 0.25 ⇒ solo-small) — the fixture reads
 * like the production line it stands in for. */
function routingResult(overrides: Record<string, { provider: string; model: string }> = {}): RoutingHookResult {
  return {
    shape: "solo-small",
    riskTier: "low",
    appliedTier: "economy",
    appliedPairs:
      Object.keys(overrides).length > 0
        ? overrides
        : { fixer: { provider: "openrouter", model: "deepseek/deepseek-v3.2" } },
    score: {
      manifest_task_count: 1,
      manifest_phase_count: 2,
      roster_role_count: 1,
      brief_path_mentions: 3,
      prior_completion_rate: 0.5,
      prior_spend_micro_usd: 0,
    },
  };
}

describe("dispatch routing hook + tier carry (J3)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let entries: LogEntry[] = [];
  let restoreLog: (() => void) | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "run-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    entries = [];
    restoreLog = setLogSink((e) => {
      entries.push(e);
    });
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreLog?.();
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else process.env[key] = saved;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Manifest with one dispatch_task phase (its `roster` is what J3 repoints). */
  function validBrief(): Record<string, unknown> {
    const manifestPath = join(dir, MANIFEST_REL);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(join(dirname(manifestPath), "roster.yaml"), ROSTER_YAML);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        phases: [
          {
            name: "route",
            kind: "dispatch_task",
            description: "Run the routed build",
            maxDurationMs: 10_000,
            retries: 0,
            roster: "manifests/roster.yaml",
            task: "Build the widget",
          },
          {
            name: "verify",
            kind: "code",
            description: "Verify the build",
            command: ["true"],
            maxDurationMs: 10_000,
            retries: 0,
          },
        ],
      }),
    );
    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath: MANIFEST_REL,
      repoUrl: "https://github.com/owner/repo",
    };
  }

  /** Fixed wall clock: deterministic ledger timestamps, ceiling never reached. */
  const FIXED_NOW = 1_800_000_000_000;

  function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      clock: () => FIXED_NOW,
      ...overrides,
    };
  }

  const sourceRosterPath = (): string => join(dir, "manifests", "roster.yaml");
  const gateCopyPath = (runId: string): string => join(dir, "runs", `${runId}.roster.yaml`);
  const boxRosterPath = (vmName: string): string => join(driver.root, vmName, "src", ".qds", "roster.yaml");
  const boxManifestPath = (vmName: string): string =>
    join(driver.root, vmName, "src", ".qds", "pipeline.yaml");
  /** The filled manifest's dispatch_task roster field, as the box received it. */
  function boxManifestRosterField(vmName: string): string {
    const manifest = JSON.parse(readFileSync(boxManifestPath(vmName), "utf8")) as {
      phases: { kind: string; roster?: string }[];
    };
    return manifest.phases.find((p) => p.kind === "dispatch_task")!.roster!;
  }
  const overriddenPair = (roster: ResolvedRoster): { provider: string; model: string } => {
    const fixer = roster.roles.find((r) => r.name === "fixer")!;
    return { provider: fixer.provider, model: fixer.model };
  };

  // ─── (1) ordering: hook once, after runId, before admission ──────────────────

  test("hook called ONCE, strictly after runId settlement and before admission", async () => {
    const callOrder: string[] = [];
    const calls: RoutingDecisionInput[] = [];
    const originalCreate = store.create.bind(store);
    store.create = (runId: string) => {
      callOrder.push("store.create");
      return originalCreate(runId);
    };
    const originalDriverCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      callOrder.push("driver.create");
      return originalDriverCreate(name, tag);
    };
    const originalMint = keyApi.createKey.bind(keyApi);
    keyApi.createKey = async (name: string, limit: number) => {
      callOrder.push("mint");
      return originalMint(name, limit);
    };
    const originalExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (argv[0] === "sh") {
        const script = argv[2] ?? "";
        if (script.startsWith("umask 077")) callOrder.push("deliver");
        else if (argv.at(-1) === "src/.qds/pipeline.yaml") callOrder.push("fill:pipeline.yaml");
        else if (argv.at(-1) === "src/.qds/run-context.json") callOrder.push("fill:run-context.json");
        else if (argv.at(-1) === "src/.qds/roster.yaml") callOrder.push("fill:roster.yaml");
      }
      return originalExec(vm, argv, stdin);
    };

    const result = await dispatch(
      validBrief(),
      deps({
        router: async (input) => {
          callOrder.push("router-hook");
          calls.push(input);
          return routingResult();
        },
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );
    expect(result.state).toBe("ready");

    // ONCE, and its input carries the SETTLED runId — the id the mint/collision
    // loop ended with, which is the id the ack returns, and nothing else.
    expect(calls).toHaveLength(1);
    const input = calls[0] as RoutingDecisionInput;
    expect(input.runId).toBe(result.runId);
    expect(input.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    expect(input.requestId).toBe(result.requestId);
    expect(input.repoSlug).toBe("owner/repo");
    // The correlation identity exactly as ctx carries it: an integer issueId.
    expect(input.issueId).toBe(42);
    expect(input.rosterPath).toBe(sourceRosterPath());
    expect(input.manifestBudgetMs).toBeGreaterThan(0);
    expect(input.now()).toBe(FIXED_NOW);

    // Strictly before admission's first observable — an equality over the
    // prefix, not a subsequence (same discipline as the memory seam's pin).
    expect(callOrder.slice(0, callOrder.indexOf("gate") + 1)).toEqual([
      "router-hook",
      "store.create",
      "driver.create",
      "mint",
      "deliver",
      "fill:pipeline.yaml",
      "fill:run-context.json",
      "fill:roster.yaml",
      "gate",
    ]);
  });

  // ─── (2) no-op default: unset router ⇒ byte-identical legacy ─────────────────

  test("unset router → zero routing artifacts, zero routing log lines", async () => {
    const result = await dispatch(validBrief(), deps());
    expect(result.state).toBe("ready");

    expect(existsSync(gateCopyPath(result.runId))).toBe(false);
    expect(existsSync(boxRosterPath(result.vmName))).toBe(false);
    // The stamped manifest keeps the authored roster reference untouched.
    expect(boxManifestRosterField(result.vmName)).toBe("manifests/roster.yaml");
    // The source roster is exactly what was authored.
    expect(readFileSync(sourceRosterPath(), "utf8")).toBe(ROSTER_YAML);
    // Zero routing-flavored log lines of any kind.
    const routingLines = entries.filter(
      (e) =>
        (typeof e.phase === "string" && e.phase.includes("routing")) ||
        (typeof (e as { event?: unknown }).event === "string" &&
          String((e as { event?: unknown }).event).includes("routing")),
    );
    expect(routingLines).toEqual([]);
  });

  // ─── (3) carry: the override materializes in BOTH downstream surfaces ────────

  test("resolved hook → gate copy + fill BoxFile + manifest repoint, source untouched", async () => {
    const result = await dispatch(validBrief(), deps({ router: async () => routingResult() }));
    expect(result.state).toBe("ready");

    // (1) the host-side gate copy beside the run record — the path the setup
    // gate's rosterPath literal binds to (pinned structurally in the fence arm
    // below; GateOpts carries no rosterPath, so this file IS the gate leg's
    // materialization).
    const gateCopy = parseRoster(readFileSync(gateCopyPath(result.runId), "utf8"));
    expect(overriddenPair(gateCopy)).toEqual({
      provider: "openrouter",
      model: "deepseek/deepseek-v3.2",
    });
    // The slug re-derived from the OVERRIDE pair, not the original model.
    expect(gateCopy.roles.find((r) => r.name === "fixer")!.slug).toBe(
      "openrouter/deepseek/deepseek-v3.2",
    );
    // The untouched role rides verbatim.
    expect(gateCopy.roles.find((r) => r.name === "lead")!.slug).toBe(
      "openrouter/anthropic/claude-haiku-4.5",
    );

    // (2) the fill BoxFile carries the SAME rendered text.
    expect(readFileSync(boxRosterPath(result.vmName), "utf8")).toBe(
      readFileSync(gateCopyPath(result.runId), "utf8"),
    );

    // (3) the stamped manifest's dispatch_task roster points at the in-box copy
    // (`loadRoster` resolves runRoot-relative inside the checkout).
    expect(boxManifestRosterField(result.vmName)).toBe(".qds/roster.yaml");

    // The SOURCE roster.yaml is byte-identical — the override never rewrites it.
    expect(readFileSync(sourceRosterPath(), "utf8")).toBe(ROSTER_YAML);
  });

  // ─── (4) skip fold: a throwing hook never fails the dispatch ─────────────────

  test("throwing hook → dispatch proceeds unchanged, zero routing artifacts", async () => {
    const result = await dispatch(
      validBrief(),
      deps({
        router: async () => {
          throw new Error("router exploded (synthetic)");
        },
      }),
    );
    // No refusal, no fold artifact: the ordinary ready result.
    expect(result.state).toBe("ready");
    expect(existsSync(gateCopyPath(result.runId))).toBe(false);
    expect(existsSync(boxRosterPath(result.vmName))).toBe(false);
    expect(boxManifestRosterField(result.vmName)).toBe("manifests/roster.yaml");
    expect(readFileSync(sourceRosterPath(), "utf8")).toBe(ROSTER_YAML);
  });

  // ─── (5) import-closure fence + gate-shadow structural pin ───────────────────

  test("no src/judgment specifier under any spelling in dispatch.ts (fence with teeth)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/fleet/dispatch.ts"), "utf8");
    // The forbidden spellings, each fed through the SAME scanner the real
    // source goes through — a scanner that flags nothing is a scanner that
    // proves nothing, so the synthetic positives must all trip it.
    const forbidden = [
      "src/judgment",
      'from "./judgment',
      'from "../judgment',
      'from "../../src/judgment',
      'import("./judgment',
      'import("../judgment',
      'import("../../src/judgment',
      'require("./judgment',
      'require("../judgment',
      'require("../../src/judgment',
    ];
    const scanner = (text: string): string[] => forbidden.filter((spelling) => text.includes(spelling));
    // Synthetic positives: each spelling must trip the scanner when it appears
    // in a source (injected raw, as a comment line — the scanner is a text
    // fence, so placement is irrelevant to the match).
    for (const spelling of forbidden) {
      expect(scanner(`${source}\n// ${spelling}\n`)).toContain(spelling);
    }
    // Not vacuous: the WHOLE source was scanned (dispatch.ts is ~4.5k lines)
    // and the scanner's positive control finds its real imports — while the
    // real source itself must be CLEAN.
    expect(source.length).toBeGreaterThan(100_000);
    expect(scanner(source)).toEqual([]);
    expect(source.includes("../phase-engine/roster/schema.ts")).toBe(true);
  });

  test("the gate's rosterPath shorthand sits under the J3 shadow (structural pin)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/fleet/dispatch.ts"), "utf8");
    const shadow = "let rosterPath = j3SourceRosterPath;";
    // The predicate: the setup-gate literal's `rosterPath,` shorthand (the one
    // argument following `requestId: o.requestId,`) is shadowed by a J3
    // declaration ABOVE it. Adds-only cannot rewrite that shorthand line, so
    // this scope is the only mechanism — if it regresses, the gate silently
    // reads the SOURCE roster instead of the override copy.
    const holds = (text: string): boolean => {
      const literalAt = text.indexOf("requestId: o.requestId,");
      if (literalAt === -1) return false;
      const shorthandAt = text.indexOf("rosterPath,", literalAt);
      if (shorthandAt === -1 || text.indexOf("rosterPath,", shorthandAt + 1) !== -1) return false;
      const shadowAt = text.indexOf(shadow);
      return shadowAt !== -1 && shadowAt < shorthandAt;
    };
    // Real source: holds. Positive tooth: a source without the shadow fails
    // the SAME predicate, so the pin has a direction.
    expect(holds(source)).toBe(true);
    const mutated = source.replace(shadow, "let rosterPathUnused = j3SourceRosterPath;");
    expect(holds(mutated)).toBe(false);
    expect(holds("")).toBe(false);
  });

  test("production wiring pinned: the deps literal arms the hook and the harvest leg runs", () => {
    const source = readFileSync(join(import.meta.dir, "../../scripts/fleet.ts"), "utf8");
    // The two wiring lines the round-1 reviewer deleted with every suite still
    // green — this pin exists so that deletion now fails here. The arming
    // literal is the only place production hands the hook to dispatch; the
    // harvest leg is the only consumer of the log the hook writes.
    const WIRING = ["router: makeRoutingHook(", "await retainRoutingDecisionsBestEffort("];
    const holds = (text: string): boolean => WIRING.every((needle) => text.includes(needle));
    // Real source: holds. Positive tooth: a source with EITHER line removed
    // fails the SAME predicate, so neither arm of the pin is vacuous.
    expect(holds(source)).toBe(true);
    for (const needle of WIRING) {
      expect(holds(source.replace(needle, "/* wiring removed */"))).toBe(false);
    }
    // Not vacuous: fleet.ts read in full (~360KB), so `holds` ran over the
    // real file, not a truncation.
    expect(source.length).toBeGreaterThan(200_000);
  });

  // ─── (6) invalid pair: materializes; unchanged validateRoster refuses ────────

  test("override pair no catalog contains still materializes; validateRoster refuses it", async () => {
    const result = await dispatch(
      validBrief(),
      deps({
        router: async () =>
          routingResult({ fixer: { provider: "ghost", model: "nope/v1" } }),
      }),
    );
    // Dispatch itself does not validate the override pair — the gate/engine
    // refuse downstream (AC4: "refused like hand-written" happens at
    // validate.ts, which this add never touches).
    expect(result.state).toBe("ready");

    // The copy MATERIALIZED with the invalid pair verbatim, and parseRoster
    // accepts it structurally (slug re-derived from the pair).
    const gateCopy = parseRoster(readFileSync(gateCopyPath(result.runId), "utf8"));
    expect(overriddenPair(gateCopy)).toEqual({ provider: "ghost", model: "nope/v1" });
    expect(gateCopy.roles.find((r) => r.name === "fixer")!.slug).toBe("ghost/nope/v1");

    // And the UNCHANGED validator refuses exactly like a hand-written typo —
    // the hermetic stub pattern from tests/phase-engine/roster-override.test.ts.
    const table = (entries: Record<string, object>): RateTable => ({
      unit: "usd-per-mtok",
      entries: new Map(Object.entries(entries)),
    });
    const rateSources: RateSources = {
      bundled: table({
        "openrouter/anthropic/claude-haiku-4.5": { input: 1, output: 5 },
        "openrouter/deepseek/deepseek-v3.2": { input: 0.5, output: 2 },
      }),
      custom: table({}),
    };
    const catalog =
      (pairs: string[]) =>
      async (): Promise<CatalogProbe> => ({ ok: true, pairs: new Set(pairs), durationMs: 3 });
    const provider =
      (ids: string[]) =>
      async (): Promise<ProviderProbe> => ({ ok: true, ids: new Set(ids), durationMs: 4 });
    const report = await validateRoster(
      parseRoster(renderRoster(gateCopy)),
      {
        probeCatalog: catalog([
          "openrouter/anthropic/claude-haiku-4.5",
          "openrouter/deepseek/deepseek-v3.2",
        ]),
        probeProvider: provider(["anthropic/claude-haiku-4.5", "deepseek/deepseek-v3.2"]),
        rateSources,
      },
    );
    expect(report.exitCode).toBe(1);
    expect(report.roles.find((r) => r.role === "fixer")!.problems.length).toBeGreaterThan(0);
    // The role the override never named still passes the same stub catalog.
    expect(report.roles.find((r) => r.role === "lead")!.problems).toEqual([]);
    // Sanity: the SAME stubs accept the VALID override (arm 3's pair) — the
    // refusal above is about the pair, not about overrides in general.
    const okReport = await validateRoster(
      parseRoster(renderRoster(applyTierOverride(parseRoster(ROSTER_YAML), routingResult().appliedPairs))),
      {
        probeCatalog: catalog([
          "openrouter/anthropic/claude-haiku-4.5",
          "openrouter/deepseek/deepseek-v3.2",
        ]),
        probeProvider: provider(["anthropic/claude-haiku-4.5", "deepseek/deepseek-v3.2"]),
        rateSources,
      },
    );
    expect(okReport.exitCode).toBe(0);
  });

  // ─── (7) roster drift: appliedPairs naming no surviving role folds the carry ─

  test("appliedPairs naming a role the roster lacks entirely → carry skipped, guarded house line", async () => {
    // `ghost` is no role in ROSTER_YAML — the roster's identity changed
    // between the hook's parse and the carry's re-read, as far as the override
    // is concerned.
    const result = await dispatch(
      validBrief(),
      deps({ router: async () => routingResult({ ghost: { provider: "openrouter", model: "deepseek/deepseek-v3.2" } }) }),
    );
    // The dispatch completes — the drift is a skip, never a failure.
    expect(result.state).toBe("ready");

    // Zero routing artifacts on every surface, exactly like the skip fold:
    expect(existsSync(gateCopyPath(result.runId))).toBe(false);
    expect(existsSync(boxRosterPath(result.vmName))).toBe(false);
    // spec.roster unrepointed — the box manifest keeps the authored reference.
    expect(boxManifestRosterField(result.vmName)).toBe("manifests/roster.yaml");
    expect(readFileSync(sourceRosterPath(), "utf8")).toBe(ROSTER_YAML);

    // ONE guarded house line names the skip.
    const skipLines = entries.filter((e) => e.code === "routing-roster-drift");
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]!.phase).toBe("routing-carry-skipped");
    expect(skipLines[0]!.status).toBe("ok");
    expect(skipLines[0]!.runId).toBe(result.runId);
  });

  // ─── (8) absent roster at carry: the named dispatch-level fold arm ────────────

  test("no roster.yaml beside the manifest at carry → dispatch completes, unavailable house line", async () => {
    // The usual fixture, then the roster DELETED before dispatch runs — the
    // fake driver never had one beside the manifest (the pre-admission
    // vetting runs only for an exedev driver with the default gate), so this
    // is the absent-roster shape the carry folds, end to end.
    const brief = validBrief();
    rmSync(sourceRosterPath());
    const result = await dispatch(brief, deps({ router: async () => routingResult() }));
    // The dispatch completes — a missing optional roster is a skip, never a
    // failure of a run that never needed the file.
    expect(result.state).toBe("ready");

    // Routing artifacts absent on every surface:
    expect(existsSync(gateCopyPath(result.runId))).toBe(false);
    expect(existsSync(boxRosterPath(result.vmName))).toBe(false);
    // spec.roster unrepointed — the box manifest keeps the authored reference.
    expect(boxManifestRosterField(result.vmName)).toBe("manifests/roster.yaml");

    // ONE guarded house line names the fold.
    const skipLines = entries.filter((e) => e.code === "routing-roster-unavailable");
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]!.phase).toBe("routing-carry-skipped");
    expect(skipLines[0]!.status).toBe("ok");
    expect(skipLines[0]!.runId).toBe(result.runId);
  });

  // ─── (9) over-ceiling roster at carry: folds like absent (round-2) ────────────

  test("roster over the ceiling at carry (pre-check skipped) → dispatch completes, over-ceiling house line", async () => {
    // Pad the roster past ROSTER_MAX_BYTES with comment lines. The
    // pre-admission pre-check only runs for an exedev driver with the default
    // gate, so the FakeDriver path delivers an already-oversized roster
    // straight to the carry — the over-ceiling fold used to `refuse` here,
    // AFTER provisioning (store.create, box, key mint all done). The file is
    // never parsed on this path: the stat fires first.
    const brief = validBrief();
    const pad = "# pad\n".repeat(Math.ceil((ROSTER_MAX_BYTES + 1 - ROSTER_YAML.length) / 6));
    writeFileSync(sourceRosterPath(), `${ROSTER_YAML}${pad}`);

    const result = await dispatch(brief, deps({ router: async () => routingResult() }));
    // The dispatch completes — the fold, not the old post-provisioning refusal.
    expect(result.state).toBe("ready");

    // Zero routing artifacts, exactly like the absent and drift folds:
    expect(existsSync(gateCopyPath(result.runId))).toBe(false);
    expect(existsSync(boxRosterPath(result.vmName))).toBe(false);
    expect(boxManifestRosterField(result.vmName)).toBe("manifests/roster.yaml");
    // The source roster is exactly what was authored (padded) — untouched.
    expect(readFileSync(sourceRosterPath(), "utf8")).toBe(`${ROSTER_YAML}${pad}`);

    // ONE guarded house line names the fold.
    const skipLines = entries.filter((e) => e.code === "routing-roster-over-ceiling");
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]!.phase).toBe("routing-carry-skipped");
    expect(skipLines[0]!.status).toBe("ok");
    expect(skipLines[0]!.runId).toBe(result.runId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E2E DEMO (story DoD, MANDATORY) — the real chain end to end, explicitly
// non-live: fixture-seeded .sandbox, the REAL host-side hook (makeRoutingHook
// from scripts/fleet.ts — the exact closure runDispatch wires), TWO
// fake-driver dispatches whose features straddle the SHAPE_BANDS cut, the
// mock-mode seam ask (INV-J5: no key, no spend), TWO strict routing-log
// lines, the provenance envelope under the logged jev_requestId, and the
// idempotent routing-<runId>-dev-meta retain via the REAL retain leg.
// ═════════════════════════════════════════════════════════════════════════════

import {
  makeRoutingHook,
  retainRoutingDecisionsBestEffort,
} from "../../scripts/fleet.ts";
import { RoutingLogLineSchema } from "../../src/judgment/index.ts";
import { resolveBankId } from "../../src/hindsight/schemas.ts";

describe("J3 e2e demo — real hook, real dispatch, real log, real retain (non-live)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let logDir: string;
  let provenanceDir: string;
  let savedEnv: Record<string, string | undefined> = {};
  let savedCwd = "";

  const E2E_ENV_KEYS = [
    "TYPESAFE_MOCK",
    "TYPESAFE_API_KEY",
    "HINDSIGHT_BASE_URL",
    "HINDSIGHT_BEARER_TOKEN",
    "HINDSIGHT_API_KEY",
  ] as const;

  const E2E_ROSTER = `
defaults:
  provider: openrouter
  thinking: medium
  tools: null
  writes: []
  harness_engineering: []

roles:
  - name: lead
    model: anthropic/claude-haiku-4.5
  - name: fixer
    model: deepseek/deepseek-v3.2
`;

/** One-role variant — the sanctioned single-agent case (a roster of one is
 * the degenerate dispatch_task) — dispatch A's fixture: the lighter roster
 * is what walks its score under the 0.25 solo-small cut. */
const E2E_ROSTER_SOLO = `
defaults:
  provider: openrouter
  thinking: medium
  tools: null
  writes: []
  harness_engineering: []

roles:
  - name: lead
    model: anthropic/claude-haiku-4.5
`;

  /** Fixed wall clock: deterministic ledger timestamps, ceiling never reached. */
  const E2E_FIXED_NOW = 1_900_000_000_000;

  function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      clock: () => E2E_FIXED_NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "e2e-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    logDir = join(dir, "routelog");
    provenanceDir = join(dir, "provenance");
    mkdirSync(logDir, { recursive: true });
    savedEnv = Object.fromEntries(E2E_ENV_KEYS.map((k) => [k, process.env[k]]));
    savedCwd = process.cwd();
    process.env.TYPESAFE_MOCK = "1";
    // biomeIgnoreDelete: env hygiene is a deletion — assigning undefined keeps
    // the key present, which is NOT the same state the deleted form produces.
    // biome-ignore lint/performance/noDelete: env deletion, not object property perf
    delete process.env.TYPESAFE_API_KEY;
    // The retain stage flips these on; the dispatch stages keep them off so
    // nothing else in the memory lane can fire.
    // biome-ignore lint/performance/noDelete: env deletion, not object property perf
    delete process.env.HINDSIGHT_BASE_URL;
    // biome-ignore lint/performance/noDelete: env deletion, not object property perf
    delete process.env.HINDSIGHT_BEARER_TOKEN;
    // biome-ignore lint/performance/noDelete: env deletion, not object property perf
    delete process.env.HINDSIGHT_API_KEY;
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Closed prior runs for owner/repo — the seeded .sandbox history the
   * prior-outcome feature reads. Hex6 ids match the minted shape. */
  function seedClosedPriors(count: number): void {
    for (let i = 0; i < count; i++) {
      const id = `qds-20260101-cccc0${i}`;
      store.create(id);
      store.set(id, { extensions: { budget: { repoSlug: "owner/repo" } } });
      store.close(id);
    }
  }

  /** The log the hook writes: store-rooted — dirname(store.dir) is where the
   * line describes its runs (production derives .sandbox the same way). */
  const e2eLogPath = (): string => join(dir, "routing-log.jsonl");
  const readE2eLog = (): string[] =>
    existsSync(e2eLogPath()) ? readFileSync(e2eLogPath(), "utf8").trim().split("\n") : [];

  /**
   * One dispatch through the REAL chain. `taskCount` and `phaseCount` size
   * the fixture manifest so the composite score lands on the intended side
   * of the 0.25 band cut (arithmetic in the stage comments).
   */
  async function runOneDispatch(
    label: string,
    taskCount: number,
    extraPhaseCount: number,
    rolesYaml: string = E2E_ROSTER,
  ): Promise<{ runId: string; requestId: string }> {
    const manifestDir = join(dir, `manifests-${label}`);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "roster.yaml"), rolesYaml);
    const manifestRel = join(`manifests-${label}`, "pipeline.json");
    const phases: unknown[] = [];
    for (let i = 0; i < taskCount; i++) {
      phases.push({
        name: `route-${i}`,
        kind: "dispatch_task",
        description: "Run the routed build",
        maxDurationMs: 10_000,
        retries: 0,
        roster: "manifests/roster.yaml",
        task: `Build the widget ${i}`,
      });
    }
    for (let i = 0; i < extraPhaseCount; i++) {
      phases.push({
        name: `verify-${i}`,
        kind: "code",
        description: "Verify",
        command: ["true"],
        maxDurationMs: 10_000,
        retries: 0,
      });
    }
    writeFileSync(
      join(manifestDir, "pipeline.json"),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: `e2e-${label}`,
        runBudgetMs: 400_000,
        phases,
      }),
    );
    const brief = {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath: manifestRel,
      repoUrl: "https://github.com/owner/repo",
    };
    // The REAL host-side closure — the exact factory runDispatch wires — with
    // test-only rooting so the chain never touches the repo's own .sandbox/
    // or judgment provenance.
    const hook = makeRoutingHook({
      store,
      note: () => {},
      routingOptions: { provenanceDir },
    });
    const result = await dispatch(brief, deps({ router: hook, timeoutMs: 500_000 }));
    return { runId: result.runId, requestId: result.requestId };
  }

  test("dispatch A (small) → solo-small → economy; dispatch B (swarm) → premium; log lines + provenance", async () => {
    // A: 1 task (1/6·0.28 = .0467) + 2 phases (2/4·0.12 = .06) + 1 role
    // (1/8·0.20 = .025) + 3 path tokens (3/20·0.16 = .024) + neutral priors
    // (0.5·0.16 = .08) ⇒ score = 0.2357 ≤ 0.25 → solo-small → economy.
    const a = await runOneDispatch("small", 1, 1, E2E_ROSTER_SOLO);
    // The fixture-seeded .sandbox between the dispatches: two CLOSED prior
    // runs for the same repo — the prior-outcome feature has real history to
    // read (rate 1.0), and B's arithmetic rides it.
    seedClosedPriors(2);
    // B: 6 tasks (saturated .28) + 8 phases (saturated .12) + 2 roles
    // (2/8·0.20 = .05) + 3 path tokens (.024) + closed history (1.0·0.16 = .16)
    // ⇒ score = 0.634 > 0.55 → swarm → premium.
    const b = await runOneDispatch("swarm", 6, 2);

    const raw = readE2eLog();
    expect(raw.length).toBe(2);
    const lines = raw.map((l) => RoutingLogLineSchema.parse(JSON.parse(l)));
    const aLine = lines.find((l) => l.runId === a.runId)!;
    const bLine = lines.find((l) => l.runId === b.runId)!;
    expect(aLine).toBeDefined();
    expect(bLine).toBeDefined();

    expect(aLine.shape).toBe("solo-small");
    expect(aLine.applied_tier).toBe("economy");
    expect(bLine.shape).toBe("swarm");
    expect(bLine.applied_tier).toBe("premium");
    // The recommendation is RECORDED, never applied (mock's first criteria
    // key = "economy" — the applied tier must not follow it on B).
    expect(bLine.jev_recommendation).toBe("economy");
    expect(bLine.applied_tier).not.toBe(bLine.jev_recommendation);
    expect(bLine.jev_skipped).toBeNull();
    expect(aLine.jev_requestId).not.toBeNull();
    expect(bLine.jev_requestId).not.toBeNull();

    // Provenance side channel: the envelope under the logged join key — the
    // envelope id is the dispatch correlation id (the default client seeds
    // it), so the file lives under the ack's requestId.
    expect(existsSync(join(provenanceDir, `${a.requestId}.json`))).toBe(true);
    expect(existsSync(join(provenanceDir, `${b.requestId}.json`))).toBe(true);

    // Tier carry, stage 1 (both dispatches): the host-side gate copy renders
    // EVERY role onto the tier's pair (uniform tier semantics).
    for (const { runId, tier } of [
      { runId: a.runId, tier: "economy" },
      { runId: b.runId, tier: "premium" },
    ] as const) {
      const copy = parseRoster(readFileSync(join(dir, "runs", `${runId}.roster.yaml`), "utf8"), "copy");
      const expected = tier === "economy" ? { provider: "openrouter", model: "deepseek/deepseek-v3.2" } : { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" };
      for (const role of copy.roles) {
        expect(role.provider).toBe(expected.provider);
        expect(role.model).toBe(expected.model);
      }
      // The source roster.yaml beside the manifest is byte-identical.
      const src = readFileSync(join(dir, `manifests-${tier === "economy" ? "small" : "swarm"}`, "roster.yaml"), "utf8");
      expect(src).toBe(tier === "economy" ? E2E_ROSTER_SOLO : E2E_ROSTER);
    }
  });

  // DoD letter, dispatch level: "two concurrent fake-driver dispatches produce
  // exactly two lines". Both runs share ONE store (`store.create` is
  // per-runId) and one logDir — the routing log's single-writer lock is
  // exactly what this exercises at dispatch level.
  test("two concurrent dispatches → exactly two strict-parseable lines, distinct runIds", async () => {
    const [a, b] = await Promise.all([
      runOneDispatch("small", 1, 1, E2E_ROSTER_SOLO),
      runOneDispatch("swarm", 6, 2),
    ]);
    const raw = readE2eLog();
    expect(raw.length).toBe(2);
    // A torn write fails the JSON.parse; a malformed-but-parseable line fails
    // the strict schema — together that is the no-interleave assertion.
    const lines = raw.map((l) => RoutingLogLineSchema.parse(JSON.parse(l)));
    const runIds = new Set(lines.map((l) => l.runId));
    expect(runIds.size).toBe(2);
    expect(runIds.has(a.runId)).toBe(true);
    expect(runIds.has(b.runId)).toBe(true);
  });

  test("retain stage: real retain leg, one routing-<runId>-dev-meta doc, idempotent replay", async () => {
    const a = await runOneDispatch("small", 1, 1);
    // Chain the harvest leg's real function against the REAL log: chdir to
    // the e2e root so the leg's cwd-relative read finds the log the hook
    // wrote (production spells both relative to the repo root).
    process.chdir(dir);
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:1";
    process.env.HINDSIGHT_BEARER_TOKEN = "e2e-token";
    // The leg's logDir option roots the read at the same place the hook's
    // routingOptions rooted the write — one contract, no relocation (review
    // round 1: the old copyFileSync bridge existed only because the leg had
    // no logDir seam).
    const calls: Array<{ bankId: string; content: string; metadata?: Record<string, unknown> }> = [];
    const auditLinks: unknown[] = [];
    const retainArgs = {
      runId: a.runId,
      requestId: a.requestId,
      store,
      harvestedCount: 3,
      auditRecord: (link: unknown) => auditLinks.push(link),
      clientFactory: () => ({
        listBanks: (): Promise<unknown> =>
          Promise.resolve({ banks: [{ bank_id: resolveBankId("owner/repo") }, { bank_id: `${resolveBankId("owner/repo")}-dev-meta` }] }),
        retain: (bankId: string, content: string, metadata?: Record<string, unknown>): Promise<unknown> => {
          calls.push({ bankId, content, metadata });
          return Promise.resolve({ ok: true });
        },
      }),
    };
    await retainRoutingDecisionsBestEffort(retainArgs);
    await retainRoutingDecisionsBestEffort(retainArgs);

    expect(calls.length).toBe(2);
    const banks = new Set(calls.map((c) => c.bankId));
    expect(banks).toEqual(new Set([`${resolveBankId("owner/repo")}-dev-meta`]));
    const [first, second] = calls;
    expect(first!.metadata).toMatchObject({ documentId: `routing-${a.runId}-dev-meta`, updateMode: "replace" });
    // Idempotent replay: byte-identical payload, identical args — the
    // substrate's document_id upsert REPLACES, never duplicates.
    expect(second!.content).toBe(first!.content);
    expect(second!.metadata).toEqual(first!.metadata);
    // INV-JR-3: no volatile envelope field anywhere in the payload.
    for (const bad of ["confidence", "probabilities", "latency", "usage", "answers"]) {
      expect(first!.content.includes(bad)).toBe(false);
    }
  });
});
