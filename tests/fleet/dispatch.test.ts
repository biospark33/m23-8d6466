/**
 * Dispatch tests (Story DF3.1): TDD — tests written first, repaired to the
 * bun:test/DI idioms after the original agent draft (import reassignment is
 * impossible in Bun; seams go through DispatchDeps).
 *
 * Coverage per story DoD:
 * - requestId resolution: supplied strict UUID v4 honoured; malformed + absent both mint fresh
 * - Caller-invented runId rejected; dispatcher-minted runId accepted via opts (AC2)
 * - Malformed briefs → FleetError exit 2, ZERO side effects (INV-2)
 * - Admission: OverBudgetError → exit 5, checkHeadroom allowed:false → exit 5
 * - {admitted:true} suppresses headroom call ONLY (budget still checked)
 * - Admission hand-off: the issue/run/estimate admitIssue was asked, ledger closed
 * - Ordering: record → box → key → fill → gate via call-order capture
 * - Cap hand-off: mintRunKey cap === admittedCeilingMicroUsd === manifest stamp === budget ext
 * - Gate failure: ready=false → FleetError exit 3, record OPEN, box NOT destroyed,
 *   gate outcome on the record, keyHash persisted (the key stays revocable)
 * - Ack shape asserted, and asserted to carry no key material
 * - 600s wall clock: injected ADVANCING clock, expiry and just-under boundary
 * - Public exposure happens only after the gate passes
 * - INV-4: no key material in logs, records or the ack
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as YAML from "yaml";

import { DEFAULT_QUOTA_LIMITS, type LoadedQuotaLimits } from "../../src/providers/quota.ts";

/** Fresh limits — NEVER mutate DEFAULT_QUOTA_LIMITS (shared, unfrozen reference). */
function limitsWith(overrides: Partial<typeof DEFAULT_QUOTA_LIMITS>): LoadedQuotaLimits {
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...overrides }, source: "default" };
}
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import type { ProviderVm } from "../../src/providers/driver.ts";
import type { SetupGateResult } from "../../src/providers/exedev/setup-gate.ts";
import { defaultKeyCapMicroUsd, SBX_KEY_PREFIX } from "../../src/providers/credentials.ts";
import { type AdmissionInput, CostLedgerError } from "../../src/providers/cost-ledger.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import { statusRun } from "../../src/fleet/status.ts";
import {
  FleetError,
  assertFleetRunId,
  fakeGate,
  mintRunId,
  dispatch,
  type DispatchDeps,
  type GateOpts,
  type LedgerLike,
} from "../../src/fleet/dispatch.ts";
import {
  ADMIT_THROW_MESSAGE,
  admitThrowsLedger,
  CLOSE_THROW_MESSAGE,
  closeThrowsLedger,
  goodLedger,
  overBudgetLedger,
} from "./helpers.ts";

/**
 * UUID v4, spelled out here rather than imported from the implementation's own
 * `isValidUuidV4`: a predicate loosened in `src/` would otherwise loosen the
 * test that is supposed to catch it, and the two would degrade together.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The dispatch wall-clock ceiling `DispatchDeps.timeoutMs` defaults to. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * The manifest path every brief here carries, RELATIVE to the containment root
 * (`deps().repoRoot`, the case's tmpdir).
 *
 * The schema refuses an ABSOLUTE `manifestPath` outright, because
 * `resolve(repoRoot, "/etc/shadow")` discards the root — absoluteness, not a
 * `..` segment, was the containment hole, and relative-with-no-`..` is
 * contained beneath any root at all. Dispatch resolves this against
 * `deps.repoRoot`, which is what makes it land on the file `validBrief` wrote.
 */
const MANIFEST_REL = join("manifests", "pipeline.json");

/**
 * The escaping fixture's path, also relative — a SYMLINK beneath the root whose
 * target resolves outside it. Relative and `..`-free, so the schema admits it;
 * only `loadManifest`'s realpath + beneath-root re-assertion can refuse it,
 * which is precisely the dispatch-side INV-2 gate under test.
 */
const ESCAPE_REL = join("manifests", "escape.json");

/**
 * Fixtures stay in `os.tmpdir()` and the containment root is INJECTED
 * (`deps.repoRoot`, defaulting to `process.cwd()`): nothing here writes into the
 * repo working tree, and no test mutates a process-global every other test file
 * in the run shares. `realpathSync` because macOS resolves `/var` →
 * `/private/var` — the containment check compares resolved paths, so an
 * unresolved fixture path makes the behaviour platform-dependent.
 */
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-1-dispatch-")));

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * A clock that starts at a fixed instant and only moves when a test moves it.
 *
 * `() => Date.now() + 601_000` is inert: dispatch takes its wall-clock BASELINE
 * from the same seam, so a constant offset reads as zero elapsed. Expiry is
 * only reachable by a clock that ADVANCES between the baseline and the check.
 */
function stepClock(): { clock: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return {
    clock: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("dispatch.ts (DF3.1 AC1-AC9, INV-1-INV-6, C1-C10)", () => {
  let dir: string;
  /**
   * A sibling of `dir`, for fixtures that must live OUTSIDE the containment
   * root. Per-test and removed with `dir`: minted straight under `tmpRoot` they
   * accumulated all file long and were swept only by `afterAll`, so a bail or a
   * mid-suite kill leaked them and any future assertion on `tmpRoot`'s contents
   * became order-dependent.
   */
  let outsideDir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  let keyApi: FakeKeyApi;
  let entries: LogEntry[] = [];
  /**
   * Subscribers on the sink, for the lines that arrive AFTER the call under
   * test has already returned (`within`'s abandoned-step handler). See
   * `awaitEntry`.
   */
  let entryWaiters: Array<{ match: (e: LogEntry) => boolean; resolve: () => void }> = [];
  let restoreLog: (() => void) | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpRoot, "run-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpRoot, "outside-")));
    store = new RunRecordStore(join(dir, "runs"));
    driver = new FakeDriver(join(dir, "boxes"));
    keyApi = new FakeKeyApi();
    entries = [];
    entryWaiters = [];
    // Capture the module's own sink (INV-4 checks). ONE array, not a parallel
    // `string[]` of the same entries: the stringified copy was a second capture
    // of the same lines that only three assertions ever read, and the two could
    // drift (a sink that pushed to one and not the other). `JSON.stringify(e)`
    // at the three call sites is the whole of what it bought.
    restoreLog = setLogSink((e) => {
      entries.push(e);
      entryWaiters = entryWaiters.filter((w) => {
        if (!w.match(e)) return true;
        w.resolve();
        return false;
      });
    });
  });

  afterEach(() => {
    restoreLog?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // ─── helpers ─────────────────────────────────────────────────────────────────

  function validBrief(overrides: Partial<{ requestId: string; manifestPath: string }> = {}) {
    const manifestPath = join(dir, MANIFEST_REL);
    mkdirSync(dirname(manifestPath), { recursive: true });
    const manifest = {
      version: "1.0.0",
      pipelineId: "test-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    return {
      repoSlug: "owner/repo",
      issueId: 42,
      commitSha: "a".repeat(40),
      manifestPath: MANIFEST_REL,
      repoUrl: "https://github.com/owner/repo",
      ...overrides,
    };
  }

  /**
   * `repoRoot` is the test's own temp dir, so the manifest-containment check has
   * a real root to enforce without anyone touching `process.cwd()`.
   *
   * `timeoutMs` is deliberately NOT injected: the production default is what
   * every test then exercises, so a changed default fails the clock tests
   * instead of passing invisibly behind an injected 600_000.
   */
  function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
    return {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      repoRoot: dir,
      ...overrides,
    };
  }

  /**
   * The gate options `dispatch` composes at its own call site, spelled out in
   * full and with NO cast: `{ runId } as Parameters<typeof fakeGate>[2]` left
   * every other field `undefined` — a state the real dispatch path never
   * produces — so a probe that branched on one exercised an unreachable
   * configuration, and a widened `GateOpts` would not break compilation here.
   */
  const gateOpts: GateOpts = {
    runId: "gate-probe-run",
    commitSha: "a".repeat(40),
    requestId: "9f1754e8-1c32-4bc7-8e0d-34f39bc8e5a1",
  };

  /** The refusal log lines this dispatch emitted (`refuse`'s own contract). */
  function refusalLines(): LogEntry[] {
    return entries.filter((e) => e.operation === "fleet.dispatch" && e.phase === "refused");
  }

  /**
   * Settle once a line matching `match` has reached the sink.
   *
   * For the ABANDONED-step lines, which are emitted after `dispatch` has already
   * rejected: the work promise settles on its own schedule and only `within`'s
   * handler is still subscribed to it. Drained off the SINK rather than off a
   * tick budget — "yield 50 times and then assert" is a bet on the scheduler,
   * and when it loses under load the failure surfaces at `toHaveLength(1)` as if
   * the line had been mis-emitted rather than merely not emitted yet. Unbounded
   * on purpose: the test's own timeout is the backstop, and "the line never
   * came" is then reported as a timeout on THIS await, which is what it is.
   */
  function awaitEntry(match: (e: LogEntry) => boolean): Promise<void> {
    if (entries.some(match)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      entryWaiters.push({ match, resolve });
    });
  }

  /** An abandoned-step line for `step`, once `within`'s handler has filed it. */
  async function abandonedLine(step: string): Promise<LogEntry> {
    await awaitEntry((e) => e.phase === "abandoned" && e.step === step);
    const lines = entries.filter((e) => e.phase === "abandoned");
    // Exactly one: a second abandoned step means a different step also expired,
    // and the assertions below would then be about whichever came first.
    expect(lines).toHaveLength(1);
    return lines[0] as LogEntry;
  }

  // ─── requestId resolution (AC2) ─────────────────────────────────────────────────────

  test("AC2: supplied strict UUID v4 is honoured", async () => {
    const requestId = "9f1754e8-1c32-4bc7-8e0d-34f39bc8e5a1";
    const brief = validBrief({ requestId });
    const result = await dispatch(brief, deps());
    expect(result.requestId).toBe(requestId);
  });

  test("AC2: malformed requestId mints fresh (never exits 2)", async () => {
    const requestId = "not-a-uuid";
    const brief = validBrief({ requestId });
    const result = await dispatch(brief, deps());
    expect(result.requestId).not.toBe(requestId);
    expect(result.requestId).toMatch(UUID_V4_RE);
  });

  test("AC2: absent requestId mints fresh", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());
    expect(result.requestId).toMatch(UUID_V4_RE);
  });

  test("AC2: caller-invented runId rejected (only mintRunId values accepted via opts)", async () => {
    const brief = validBrief();
    try {
      // @ts-expect-error AC2: a caller-invented id is not a MintedRunId — the brand
      // refuses it at compile time; this asserts the runtime guard still refuses a cast.
      await dispatch(brief, deps(), { runId: "invented-by-caller" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      // Not just "a FleetError": every later refusal is one too, and this test
      // is about the provenance guard specifically.
      expect(err.code).toBe("run-id-not-minted");
      expect(err.exitCode).toBe(2);
    }
    // Nothing was provisioned under the forged id.
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  // Ids that are ALMOST minted-shaped. `"invented-by-caller"` misses the
  // grammar by a mile, so it proved only that the first character of the check
  // works; every case here differs from a real minted id in exactly one place.
  //
  // `invalid-run-id` — `assertValidRunId`'s backstop two lines further down — is
  // NOT reachable from here, and cannot be: `RUN_ID_RE` is
  // `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`, which every string matching the minted
  // grammar satisfies by construction (leading `q`, trailing hex, `[a-z0-9-]`
  // throughout). The backstop earns its place only if the minted grammar is
  // ever loosened — and these cases are what would then fail, because the
  // loosening they would catch (uppercase, a wrong-width date, a trailing
  // segment) is exactly what they pin as refused today.
  for (const [label, forged] of [
    ["uppercase hex", "qds-20260101-ABCDEF"],
    ["a seven-digit date", "qds-2026010-abcdef"],
    ["a five-hex tail", "qds-20260101-abcde"],
    ["a non-hex tail", "qds-20260101-abcdeg"],
    ["a trailing segment", "qds-20260101-abcdef-2"],
    ["the wrong slug", "run-20260101-abcdef"],
    ["leading whitespace", " qds-20260101-abcdef"],
    // `$` matches before a FINAL newline in JS, so an unanchored-feeling regex
    // admits this one — the classic way a log-forging id slips a shape check.
    ["a trailing newline", "qds-20260101-abcdef\n"],
  ] as const) {
    test(`AC2: a runId with ${label} is refused as not-minted, before any admission`, async () => {
      const ledgerFactory = mock(() => goodLedger());
      try {
        await dispatch(validBrief(), deps({ ledgerFactory }), {
          // @ts-expect-error the brand refuses a forged literal at compile time;
          // this asserts the runtime guard still refuses a cast.
          runId: forged,
        });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.code).toBe("run-id-not-minted");
        expect(err.exitCode).toBe(2);
      }
      expect(ledgerFactory).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
      expect(await driver.list()).toHaveLength(0);
    });
  }

  test("AC2: dispatcher-minted runId accepted via opts", async () => {
    const preMinted = mintRunId();
    const brief = validBrief();
    const result = await dispatch(brief, deps(), { runId: preMinted });
    expect(result.runId).toBe(preMinted);
  });

  test("mintRunId() re-exports newId('qds') — dated, and RANDOM, not a counter", () => {
    const id = mintRunId();
    expect(id).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    // The DAY, not just eight digits: `newId` composes it from `toISOString()`,
    // and a shape assertion alone is satisfied by a constant.
    expect(id.slice(4, 12)).toBe(new Date().toISOString().slice(0, 10).replaceAll("-", ""));

    // INDEPENDENCE, which the collision-retry loop above assumes: a counter, a
    // pid-derived value or a second-resolution timestamp all satisfy the shape
    // and make the "re-mint on collision" loop re-mint the SAME id four times.
    //
    // NOT `toBe(256)`. 256 draws from 16^6 collide with probability
    // 256·255/(2·16^6) ≈ 0.0019 — about one CI failure in 515 runs, reported as
    // an id-generator regression. The floor below is 6 collisions clear of that,
    // which no birthday accident reaches, while a source with fewer than ~2^15
    // reachable values fails it almost surely.
    const minted = Array.from({ length: 256 }, () => mintRunId());
    const ids = new Set(minted);
    expect(ids.size).toBeGreaterThanOrEqual(250);
    // …and uniqueness alone does NOT catch a counter, which is distinct by
    // construction. A monotone source — a counter, a millisecond clock, an
    // incrementing pid — yields a strictly increasing tail; 256 independent
    // draws do so with probability 1/256!, i.e. never.
    const tails = minted.map((v) => Number.parseInt(v.slice(13), 16));
    expect(tails.every((t, i) => i === 0 || t > (tails[i - 1] as number))).toBeFalse();
    // And the randomness is in the TAIL, not smuggled into the date: every one
    // of those ids carries today's date, so the set above is 256 distinct
    // six-hex suffixes rather than 256 distinct prefixes.
    expect(new Set([...ids].map((v) => v.slice(0, 12))).size).toBe(1);
  });

  test("INV-4-bis: requestId is persisted on the record and surfaces on the status row", async () => {
    const requestId = "3c9f0b21-7a44-4d0e-b8b1-6f0c2e5a7d13";
    const result = await dispatch(validBrief({ requestId }), deps());

    expect(store.get(result.runId).requestId).toBe(requestId);

    // `fleet status` is the operator's only inspection surface — the join key
    // has to reach it, not just the record file.
    const row = await statusRun({ driver, store }, result.runId);
    expect(row.requestId).toBe(requestId);
    expect(row.state).toBe("live");
  });

  // ─── INV-2: validate before any side effect ───────────────────────────────────────────

  test("INV-2: unknown field → FleetError exit 2, zero provisioning", async () => {
    const brief = { ...validBrief(), unknownField: "should-reject" };
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-brief");
      expect(String(err.payload?.field)).toBe("unknownField");

      // Zero side effects
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
  });

  test("a hostile unknown-key NAME is ESCAPED in every operator-facing string", async () => {
    // The key is attacker-chosen — `NO_CONTROL_CHARS` guards brief VALUES, and
    // nothing constrains a key NAME — and `extractZodErrorField` returns it
    // verbatim by contract. `redact` is a SECRET redactor, not a control-char
    // escaper, so escaping here is the only thing between an unrecognized key
    // and the operator's terminal.
    //
    // The regression: the message used `JSON.stringify(field)` while the
    // remediation interpolated it RAW, and zod's own
    // "Unrecognized key(s) in object: '<raw>'" rode into `payload.issues`
    // unescaped as well. Drop the escaping from any of the three and a key like
    // the second one below forges a whole log line.
    const forgery = "a\nFLEET dispatch ok runId=fake";
    for (const [hostile, sanitized] of [
      ["[2Jrm -rf", "[2Jrm -rf"],
      [forgery, "aFLEET dispatch ok runId=fake"],
    ] as const) {
      try {
        await dispatch(validBrief({ [hostile]: "x" }), deps());
        expect.unreachable();
      } catch (e) {
        const err = e as FleetError;
        expect(err.code).toBe("invalid-brief");
        // The raw name never appears in ANY operator-facing string.
        const operatorFacing = [
          err.message,
          err.remediation,
          JSON.stringify(err.payload?.issues),
        ].join("\n");
        expect(operatorFacing).not.toContain(hostile);
        // …and where the raw name still HAS to appear, it appears escaped rather
        // than merely gone. zod builds "Unrecognized key(s) in object: '<raw>'"
        // from the key the brief carried, not from the sanitized label, so
        // `payload.issues` is the one string that still holds the original — and
        // the escaping is the only thing between it and the terminal. The
        // assertion sits on the issue string itself because `operatorFacing`
        // JSON-encodes the array a second time (`a\\nFLEET`), and because the
        // message and remediation now interpolate the SANITIZED label, in which
        // the character is not present in any form.
        expect(String((err.payload?.issues as string[] | undefined)?.[0])).toContain(
          JSON.stringify(hostile).slice(1, -1),
        );
        // `payload.field` is SANITIZED, not verbatim: `extractZodErrorField` now
        // strips the control characters (and length-caps the name) before the
        // label leaves the schema layer, so the structured field is safe in a
        // consumer that renders it without a JSON encoder. The escaping above
        // stays — it is what keeps the surviving text readable, and zod's own
        // "Unrecognized key(s) in object: '<raw>'" still carries the raw name
        // into `payload.issues`, which is the string that must be escaped.
        expect(err.payload?.field).toBe(sanitized);
      }
    }
  });

  test("INV-2: missing repoSlug → FleetError exit 2, zero provisioning", async () => {
    const brief = validBrief();
    Reflect.deleteProperty(brief, "repoSlug");
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      // The REASON, not just the exit code. Every refusal in this file exits 2
      // for something; a brief missing a required field that refused as
      // `manifest-rejected` or `timeout-invalid` would satisfy the code alone
      // and send the operator to fix a field that is perfectly fine.
      expect(err.code).toBe("invalid-brief");
      expect(err.payload?.field).toBe("repoSlug");

      expect(createSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
  });

  test("INV-2: bad commitSha → FleetError exit 2, zero provisioning", async () => {
    const brief = { ...validBrief(), commitSha: "not-40-hex" };
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      // Same argument as the sibling above: the exit code alone is shared with
      // every other pre-provision refusal, and the FIELD is what the operator
      // acts on.
      expect(err.code).toBe("invalid-brief");
      expect(err.payload?.field).toBe("commitSha");

      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
  });

  test("INV-2: a rejected brief never opens the ledger — no admission is spent", async () => {
    // The money-path half of INV-2, distinct from the record/box/key assertions
    // above: an implementation that admits first and validates after books the
    // issue's cap for a brief it then refuses, and the reservation outlives the
    // refusal (only a priced cost_event retires it).
    const brief = { ...validBrief(), unknownField: "x" };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      expect((e as FleetError).exitCode).toBe(2);
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  test("a refusal that fires before the run id exists logs runId: null", async () => {
    const brief = { ...validBrief(), unknownField: "x" };

    // The file's own try/catch idiom rather than `.rejects.toThrow()`:
    // bun-types declares `expect(…).rejects` as plain `Matchers`, whose members
    // return `void`, so `await` on it is a no-op the compiler flags (TS80007)
    // and the assertion reads as awaited without being it.
    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
    }

    const refusals = refusalLines();
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0] as LogEntry;
    // `null`, not undefined and not "" — the absence is named, never fabricated.
    expect(refusal.runId).toBeNull();
    expect(refusal.requestId).toBe("unresolved");
    expect(refusal.status).toBe("error");
    expect((refusal.error as { code: string }).code).toBe("invalid-brief");
  });

  test("AC4: the host-side dispatch log records each refusal's code and issue identity", async () => {
    // The only OTHER read of this file asserts what it does NOT contain, and
    // `appendDispatchFailure` is called inside a try/catch that swallows to
    // stderr — so it could write the wrong `code`, drop `repoSlug`/`issueId`/
    // `requestId`, or fail on every single refusal, and the whole suite stayed
    // green (`refusalLines()` reads a different, in-process sink). This is the
    // AC4 evidence itself.
    const requestId = "6b1f2a90-3d55-4f21-9c0e-7a8b1d2e3f40";
    const before = Date.now();

    // A refusal from BEFORE the brief parsed, then one from after it: the two
    // together pin the documented "null, never '' and never a fabricated value"
    // shape as well as the populated one.
    try {
      await dispatch({ ...validBrief(), unknownField: "x" }, deps());
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).code).toBe("invalid-brief");
    }
    try {
      await dispatch(validBrief({ requestId }), deps({ ledgerFactory: overBudgetLedger }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).code).toBe("budget-exceeded");
    }

    // Beside the run records, so `--dir` moves the evidence with them.
    const lines = readFileSync(join(dir, "dispatch-log.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const [early, admitted] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(early?.code).toBe("invalid-brief");
    expect(early?.repoSlug).toBeNull();
    expect(early?.issueId).toBeNull();
    expect(early?.requestId).toBeNull();

    expect(admitted?.code).toBe("budget-exceeded");
    expect(admitted?.repoSlug).toBe("owner/repo");
    // The NUMBER, not the ledger's stringified form — this file keys on it.
    expect(admitted?.issueId).toBe(42);
    expect(admitted?.requestId).toBe(requestId);
    expect(String(admitted?.message)).toContain("cap");
    // WHEN, not merely "parseable". `Date.parse("2001")` is a number, so a
    // frozen constant, a copied timestamp or a zero epoch all satisfied the old
    // assertion — and this line is the AC4 evidence an operator sorts by. Both
    // refusals fall inside this test's own wall-clock window, and the ISO-8601
    // shape is pinned separately (`toISOString` is what writes it).
    for (const line of [early, admitted]) {
      const t = Date.parse(String(line?.timestamp));
      expect(String(line?.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(Date.now());
    }
  });

  // ─── Refusals that fire before an admission is spent (INV-2) ────────────────────────

  /**
   * A brief whose `manifestPath` is INSIDE the root and resolves OUTSIDE it: a
   * symlink at `<root>/manifests/escape.json` pointing at a byte-identical copy
   * of the valid fixture under `outsideDir` (a sibling of `dir`, so outside both
   * the injected `repoRoot` and `process.cwd()`).
   *
   * The escape has to be a symlink now, not an absolute path. An absolute
   * `manifestPath` is refused by the SCHEMA (see the sibling test below), which
   * is a strictly earlier gate — routing this brief through it would prove the
   * schema again and leave dispatch's own containment gate, the subject of these
   * two tests, with no coverage at all. Relative and `..`-free passes the
   * schema, so only `loadManifest`'s realpath + beneath-root re-assertion can
   * refuse it.
   *
   * Byte-identical on purpose: the refusal must be the containment check, never
   * a parse complaint that would pass for the wrong reason.
   */
  function briefWithManifestOutsideRoot() {
    const brief = validBrief();
    const escapeTarget = join(outsideDir, "pipeline.json");
    copyFileSync(join(dir, MANIFEST_REL), escapeTarget);
    symlinkSync(escapeTarget, join(dir, ESCAPE_REL));
    return { ...brief, manifestPath: ESCAPE_REL };
  }

  test("INV-2: an absolute manifestPath is refused by the schema, naming the field", async () => {
    // The FIRST of the two containment gates, and the reason the second one is
    // exercised through a symlink below. `resolve(repoRoot, "/etc/shadow")`
    // discards the root entirely, so absoluteness — not a `..` segment — was
    // the hole; a schema with no repo root cannot do resolve-then-contain, and
    // relative-with-no-`..` IS the containment property expressed at that layer.
    const brief = { ...validBrief(), manifestPath: join(dir, MANIFEST_REL) };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-brief");
      // Named, not merely refused — the operator has to know which field.
      expect(err.payload?.field).toBe("manifestPath");
      expect(JSON.stringify(err.payload?.issues)).toContain("must be relative to the repo root");
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: a manifest symlinked out of the supplied repoRoot → exit 2 manifest-rejected, zero provisioning", async () => {
    // The root is the injected one, not the manifest's own directory: a root
    // derived from the candidate path makes every path its own root and the
    // beneath-root assertion vacuous. The seam must not have widened the guard.
    const brief = briefWithManifestOutsideRoot();
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("manifest-rejected");
      // CONTAINMENT specifically, not "the manifest could not be read": the
      // link's own name IS beneath the root and its target is a perfectly valid
      // manifest, so a guard that stopped at `lstat` — or one that only checked
      // existence — would load it. Only the realpath re-assertion says this.
      expect(err.message).toContain("resolves outside the run root");
      // The refusal names the root it enforced — the injected one, not cwd.
      expect(err.remediation).toContain(dir);
      expect(err.remediation).not.toContain(process.cwd());
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-2: with no repoRoot supplied the containment root is process.cwd()", async () => {
    // The fallback is `process.cwd()`. Covered here so the default cannot rot
    // behind the injected root every other test uses — and asserted WITHOUT
    // mutating the process's cwd, which is shared by every other test file.
    //
    // This arm proves WHICH root the default is, not the beneath-root check
    // itself: `manifestPath` is now relative, so an escaping fixture would have
    // to be a symlink planted inside the real repo working tree, and no test
    // here writes there. The symlink escape is exercised against the injected
    // root above; the two roots run through the same `loadManifest` call.
    const brief = validBrief();

    try {
      await dispatch(brief, deps({ repoRoot: undefined }));
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("manifest-rejected");
      expect((e as FleetError).remediation).toContain(process.cwd());
      // And NOT the injected root — the fixture exists beneath `dir`, so a
      // dispatch that ignored `repoRoot: undefined` and kept the injected value
      // would have loaded it and never reached this refusal at all.
      expect((e as FleetError).remediation).not.toContain(dir);
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  // ─── the roster pre-checks (step 3, before an admission is spent) ───────────────────

  /**
   * `FakeDriver` carries neither `setup` nor `fill`, so `isExedevDriver` is
   * false for it and the roster pre-checks are skipped for every other test in
   * this file — which is why the whole block had no coverage at all and could
   * be deleted with the suite still green.
   *
   * BOTH capabilities, because the predicate requires both: a driver with one
   * and not the other is exactly the incoherent lifecycle `isExedevDriver`
   * exists to refuse, and stubbing only `setup` would exercise a shape dispatch
   * treats as a dir box.
   *
   * The counters are the point of the assertions below: on a roster refusal
   * NEITHER may be called, because the refusal fires before anything is
   * provisioned — which is the entire reason these checks were moved out of the
   * gate, where INV-5 would then forbid tearing the billed box down.
   */
  function makeDriverExedevCapable(): { setupCalls: number; fillCalls: number } {
    const counts = { setupCalls: 0, fillCalls: 0 };
    Object.assign(driver, {
      setup: async () => {
        counts.setupCalls += 1;
      },
      fill: async () => {
        counts.fillCalls += 1;
      },
    });
    return counts;
  }

  /** The `tests/phase-engine/fixtures/dispatch-roster.yaml` shape, inline. */
  const VALID_ROSTER = [
    "defaults:",
    "  provider: anthropic",
    "  thinking: off",
    "  tools: null",
    "  writes: []",
    "  harness_engineering: []",
    "roles:",
    "  - name: lead",
    "    model: claude-haiku-4-5",
    "",
  ].join("\n");

  /**
   * A copy of the valid manifest at `rel`, so a case can move the manifest —
   * and therefore `dirname(manifestPath)`, where the roster is looked for —
   * without hand-authoring a second manifest body that could refuse for its own
   * reasons. Byte-identical on purpose, same argument as the symlink fixture.
   */
  function manifestAt(rel: string): string {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(dir, MANIFEST_REL), target);
    return rel;
  }

  /**
   * Every roster refusal owes the same four things: exit 2, the named code, and
   * ZERO spent — no ledger opened, no record, no box.
   */
  async function expectRosterRefusal(
    brief: unknown,
    code: string,
    rosterPath: string,
  ): Promise<FleetError> {
    const ledgerFactory = mock(() => goodLedger());
    const createSpy = mock(() => Promise.resolve({ name: "x", status: "running" } as ProviderVm));
    driver.create = createSpy;
    let err: FleetError | undefined;
    try {
      await dispatch(brief, deps({ ledgerFactory }));
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    const fleetError = err as FleetError;
    expect(fleetError.exitCode).toBe(2);
    expect(fleetError.code).toBe(code);
    expect(fleetError.payload?.rosterPath).toBe(rosterPath);
    // Pre-provision, so no teardown advice for a run that does not exist.
    expect(fleetError.payload).not.toHaveProperty("teardownCommand");
    // The whole point of moving these out of the gate: nothing was billed.
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    return fleetError;
  }

  test("INV-2: an exedev dispatch with NO roster beside the manifest → exit 2 roster-missing", async () => {
    // The counters `makeDriverExedevCapable` returns are not asserted here:
    // `setup`/`fill` both run against a box, and `expectRosterRefusal` has
    // already pinned that `driver.create` was never called — so `0` is true by
    // construction and cannot fail independently of the assertion above it.
    makeDriverExedevCapable();
    const brief = validBrief();

    const err = await expectRosterRefusal(
      brief,
      "roster-missing",
      join(dir, "manifests", "roster.yaml"),
    );
    expect(err.message).toContain("no roster beside the manifest");
  });

  test("INV-2: a roster.yaml that is a FIFO → exit 2 roster-rejected, and the dispatch does not HANG", async () => {
    // The roster block runs OUTSIDE `within` — it is synchronous host-side work
    // — so no timer can rescue it. Under the old `statSync(path)` then
    // `readFileSync(path)` pair a FIFO planted at this brief-steered path
    // (`manifestPath` → `dirname` → `roster.yaml`) blocked `readFileSync`
    // forever waiting for a writer, before any admission was spent: the process
    // wedges with the event loop stopped, which no assertion in this file could
    // observe and no `Promise.race` could interrupt.
    //
    // The order is what fixes it: `openSync(O_RDONLY|O_NONBLOCK)` cannot block,
    // and `fstatSync(fd)` then judges the HANDLE the read will use rather than
    // re-resolving the name (the TOCTOU half of the same defect).
    //
    // A regression here does not fail this test — it hangs the whole suite
    // until the runner's timeout kills it. That is the honest shape of the
    // failure and there is nothing lighter that detects a synchronous block.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    const mkfifo = Bun.spawnSync(["mkfifo", rosterPath]);
    // The fixture itself has to be real, or this test passes for the wrong
    // reason (a missing roster refuses too, under a different code).
    expect(mkfifo.exitCode).toBe(0);
    expect(existsSync(rosterPath)).toBeTrue();

    const err = await expectRosterRefusal(brief, "roster-rejected", rosterPath);
    // The verdict is about the FILE TYPE, not about parsing: nothing was ever
    // read out of the pipe.
    expect(err.message).toContain("not a regular file");
  });

  test("INV-2: a roster path outside the gate's plain-path charset → exit 2 roster-path-unsafe", async () => {
    // `assertPathSafe` inside the gate refuses this path because it is
    // interpolated into a remote `sh` command — but the gate runs at step 9, on
    // a box that is already billing, and INV-5 then forbids tearing that box
    // down. A repo checked out under `~/My Projects/…` therefore provisioned,
    // billed and failed over a fact knowable before anything existed.
    makeDriverExedevCapable();
    validBrief(); // writes the fixture this case copies
    const manifestPath = manifestAt(join("my manifests", "pipeline.json"));
    const rosterPath = join(dir, "my manifests", "roster.yaml");
    // The roster is PRESENT and perfectly valid: the refusal must be about the
    // path, never about a file that happens to be missing too.
    writeFileSync(rosterPath, VALID_ROSTER);

    const err = await expectRosterRefusal(
      { ...validBrief(), manifestPath },
      "roster-path-unsafe",
      rosterPath,
    );
    expect(err.message).toContain("plain-path charset");
  });

  test("INV-2: an unparseable roster → exit 2 roster-rejected", async () => {
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    writeFileSync(rosterPath, "roles: [ unterminated\n  - name: lead\n");

    const err = await expectRosterRefusal(brief, "roster-rejected", rosterPath);
    expect(err.message).toContain("roster rejected");
  });

  test("INV-2: a roster.yaml that is a DIRECTORY → exit 2 roster-rejected, not a bare EISDIR", async () => {
    // `existsSync` reports a directory as present, so the presence check above
    // passes it and the read is an EISDIR — untyped, that is a bare exit 1 with
    // no dispatch-log entry, on a path that is pure host-side validation.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    mkdirSync(rosterPath, { recursive: true });

    const err = await expectRosterRefusal(brief, "roster-rejected", rosterPath);
    expect(err.message).toContain("not a regular file");
  });

  test("INV-2: a roster that schema-FAILS → exit 2 roster-rejected", async () => {
    // Parseable YAML, closed-schema invalid: `roles` present but empty. The gate
    // reads this file with the same `parseRoster`, so the refusal is knowable
    // host-side and the box never needs to exist to discover it.
    makeDriverExedevCapable();
    const brief = validBrief();
    const rosterPath = join(dir, "manifests", "roster.yaml");
    writeFileSync(rosterPath, "defaults:\n  provider: anthropic\nroles: []\n");

    await expectRosterRefusal(brief, "roster-rejected", rosterPath);
  });

  test("a VALID roster beside the manifest passes the pre-check — dispatch continues to provisioning", async () => {
    // The positive control every refusal above needs. Without it a pre-check
    // that refused unconditionally satisfies all five, and the exedev path would
    // be unable to dispatch at all.
    //
    // `driver.create` is failed with a marker so the run stops at a step that
    // is unambiguously PAST the roster block: reaching `provision-failed` is
    // itself the assertion, and it needs no exedev gate to run.
    makeDriverExedevCapable();
    const brief = validBrief();
    writeFileSync(join(dir, "manifests", "roster.yaml"), VALID_ROSTER);
    driver.create = async () => {
      throw new Error("past the roster pre-check");
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(brief, deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.message).toContain("past the roster pre-check");
    }
    // The admission WAS spent this time — which is what makes the "zero
    // admission" assertions on the five refusals above mean something.
    expect(ledgerFactory).toHaveBeenCalled();
  });

  test("a NON-exedev driver never looks for a roster at all", async () => {
    // The predicate's other half. `FakeDriver` has neither `setup` nor `fill`,
    // so a dir-box dispatch must succeed with no roster anywhere — otherwise
    // every other test in this file is running against a gate it never reaches.
    const brief = validBrief();
    expect(existsSync(join(dir, "manifests", "roster.yaml"))).toBeFalse();
    const result = await dispatch(brief, deps());
    expect(result.state).toBe("ready");
  });

  /**
   * The `setTimeout` clamp is the upper bound's whole reason for existing: a
   * delay past 2^31-1 wraps to 1 ms, so a request to LENGTHEN the budget
   * inverts into the shortest one possible.
   */
  const MAX_TIMEOUT_MS = 2_147_483_647;

  // BOTH ends and the integrality rule, not just the `0` case: with only the
  // lower bound tested, deleting `> MAX_TIMEOUT_MS` or `isSafeInteger` from the
  // guard left the suite green while `timeoutMs: 1e21` armed a 1 ms deadline
  // and `timeoutMs: 1.5` reached `loadManifest`, which refuses a fractional
  // `callerBudgetMs` — reported as `manifest-rejected`, the wrong diagnosis.
  for (const [label, timeoutMs] of [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["one past the setTimeout clamp", MAX_TIMEOUT_MS + 1],
    ["past 2^53", 1e21],
  ] as const) {
    test(`INV-2: a ${label} timeoutMs → exit 2 timeout-invalid, zero provisioning`, async () => {
      // A ceiling nothing can satisfy must refuse at the boundary, not mid-run.
      const ledgerFactory = mock(() => goodLedger());
      try {
        await dispatch(validBrief(), deps({ timeoutMs, ledgerFactory }));
        expect.unreachable();
      } catch (e) {
        expect((e as FleetError).exitCode).toBe(2);
        expect((e as FleetError).code).toBe("timeout-invalid");
      }
      expect(ledgerFactory).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
      expect(await driver.list()).toHaveLength(0);
    });
  }

  test("INV-2: timeoutMs AT the setTimeout clamp is accepted — and is the ceiling that gets ARMED", async () => {
    // The boundary control. Without it the guard could be `>=` — refusing the
    // largest ceiling `setTimeout` can actually honour — and every case above
    // would still pass.
    //
    // ACCEPTANCE is not the whole claim, any more than it is for the port
    // sibling (which reads the value back off the record). A guard that
    // accepted this value and then clamped the ceiling back to the 600_000
    // default would pass a bare `state: "ready"` — so the clock is advanced to
    // just under the SUPPLIED ceiling, which is nearly four hours past the
    // default. `port` is what makes that observable: the post-gate re-sample
    // exists only where there is work left, and it is the line that would
    // refuse against a clamped ceiling.
    const { clock, advance } = stepClock();
    const result = await dispatch(
      validBrief(),
      deps({
        timeoutMs: MAX_TIMEOUT_MS,
        clock,
        port: 8080,
        setupGate: async (drv, vm, o) => {
          const gate = await fakeGate(drv, vm, o);
          advance(MAX_TIMEOUT_MS - 1_000);
          return gate;
        },
      }),
    );
    expect(result.state).toBe("ready");
    expect(store.get(result.runId).ports).toEqual([8080]);
  });

  for (const [label, port] of [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 8080.5],
    ["NaN", Number.NaN],
    ["one past 65535", 65_536],
  ] as const) {
    test(`INV-2: a ${label} port → exit 2 port-invalid, zero provisioning`, async () => {
      const ledgerFactory = mock(() => goodLedger());
      try {
        await dispatch(validBrief(), deps({ port, ledgerFactory }));
        expect.unreachable();
      } catch (e) {
        expect((e as FleetError).exitCode).toBe(2);
        expect((e as FleetError).code).toBe("port-invalid");
      }
      expect(ledgerFactory).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
      expect(await driver.list()).toHaveLength(0);
    });
  }

  test("INV-2: ports AT both ends of 1..65535 are accepted", async () => {
    // The boundary controls for the port guard, for the same reason as the
    // ceiling's: an off-by-one in either direction is invisible from the
    // rejection cases alone.
    for (const port of [1, 65_535]) {
      const result = await dispatch(validBrief(), deps({ port }));
      expect(result.state).toBe("ready");
      expect(store.get(result.runId).ports).toEqual([port]);
    }
  });

  test("a re-dispatch under a run id that already has a record refuses before the admission", async () => {
    const preMinted = mintRunId();
    await dispatch(validBrief(), deps(), { runId: preMinted });

    // Booking the issue's cap a second time and then dying on EEXIST leaves the
    // reservation committed against an issue that got nothing for it.
    const ledgerFactory = mock(() => goodLedger());
    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).exitCode).toBe(2);
      expect((e as FleetError).code).toBe("run-id-in-use");
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(1);
  });

  test("the LOSER of a same-runId race still refuses exit 2 run-id-in-use (store.create is the arbiter)", async () => {
    // The step-4 check the sibling above covers is a FAST PATH, not the
    // guarantee: two concurrent dispatches sharing an explicit `opts.runId`
    // (DF3.2's fan-out shape) both find no record, both pass it, and both commit
    // a reservation. `store.create`'s O_EXCL is what actually arbitrates, and
    // its EEXIST has to map back to the SAME exit-2 refusal — otherwise the
    // loser gets exit 1 `provision-failed`, which names the wrong cause and
    // tells the operator to go looking for a substrate fault that is not there.
    //
    // Nothing else injects an EEXIST from `store.create`: delete that arm of the
    // provisioning catch and every other test in this file still passes.
    const preMinted = mintRunId();
    const eexist = Object.assign(new Error("EEXIST: file already exists, open 'runs/…'"), {
      code: "EEXIST",
    });
    store.create = () => {
      throw eexist;
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(validBrief(), deps({ ledgerFactory }), { runId: preMinted });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("run-id-in-use");
      expect(err.payload?.runId).toBe(preMinted);
      // The provider's errno stays diagnosis, never classification: an operator
      // greps the fleet code, so `EEXIST` must not have become it.
      expect(err.payload?.providerCode).toBeUndefined();
    }
    // This is the CONCURRENT branch, not the step-4 one: the admission was
    // already spent by the time the create refused. Asserting it is what tells
    // the two run-id-in-use sites apart — the sibling above asserts the
    // opposite, and without this pair either test could be satisfied by the
    // other's code path.
    expect(ledgerFactory).toHaveBeenCalled();
    // No box was ever created: `store.create` is the first half of the step.
    expect(await driver.list()).toHaveLength(0);
  });

  test("two GENUINELY concurrent dispatches on one runId: the real store arbitrates, and the loser's reservation is stranded", async () => {
    // The sibling above stubs `store.create` to throw EEXIST, so it proves the
    // MAPPING and nothing about the window. This one runs two dispatches
    // against the real store with no stubs at all: both reach step 4, both find
    // no record, both await the headroom check (the interleaving point), and
    // `store.create`'s O_EXCL is the only thing that separates them. Replace it
    // with `existsSync` + `writeFileSync` and both dispatches succeed here.
    const preMinted = mintRunId();
    // ONE ledger for both arms, so `admitCalls` counts across them. The default
    // `ledgerFactory` mints a fresh throwaway per call, which is precisely what
    // makes the double-admission window unobservable.
    const ledger = goodLedger();

    const settled = await Promise.allSettled([
      dispatch(validBrief(), deps({ ledgerFactory: () => ledger }), { runId: preMinted }),
      dispatch(validBrief(), deps({ ledgerFactory: () => ledger }), { runId: preMinted }),
    ]);

    const winners = settled.filter((s) => s.status === "fulfilled");
    const losers = settled.filter((s) => s.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const err = (losers[0] as PromiseRejectedResult).reason as FleetError;
    expect(err).toBeInstanceOf(FleetError);
    // The SAME refusal as the sequential re-dispatch, not `provision-failed`:
    // exit 1 would send the operator hunting a substrate fault that is not there.
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe("run-id-in-use");
    expect(err.payload?.runId).toBe(preMinted);

    // Exactly one record and exactly one box — the point of the O_EXCL.
    expect(readdirSync(store.dir)).toEqual([`${preMinted}.json`]);
    expect(await driver.list()).toHaveLength(1);
    expect((winners[0] as PromiseFulfilledResult<{ runId: string }>).value.runId).toBe(preMinted);

    // ── the window itself. TRIPWIRE, NOT A SPECIFICATION.
    //
    // Both arms commit a reservation against the issue's cap before either
    // touches the store, so the loser's is stranded: `admitIssue`'s orphan guard
    // expires an admission only when NO record resolves for it, and the winner's
    // record resolves under exactly this id. It ages out with the winner's run
    // rather than being released at the refusal (finding A12). Releasing it is a
    // COST-LEDGER change — `admitIssue`'s contract forbids the caller releasing
    // — so this layer cannot fix it and must not pretend the leak is the design.
    //
    // `toHaveLength(2)` is what it must NOT say: an exact count makes the
    // correct fix (one admission, or a released second one) arrive looking like
    // a regression, and says nothing at all if the leak gets WORSE in some other
    // shape. The three lines below are the parts that are genuinely specified —
    // an upper bound the leak may not grow past, one identity for every booking,
    // and one close per open — plus the marker that says which is which.
    expect(ledger.admitCalls.length).toBeGreaterThanOrEqual(1);
    // KNOWN LEAK, bounded: two dispatches book at most two reservations. Three
    // would mean a retry is re-booking, which nothing here would otherwise see.
    expect(ledger.admitCalls.length).toBeLessThanOrEqual(2);
    // Every booking is against THIS run — a stranded reservation on some other
    // id is a different, worse bug than the one being tolerated.
    expect(new Set(ledger.admitCalls.map((c) => c.input.runId))).toEqual(new Set([preMinted]));
    // Every handle opened is closed, on the winning path and the losing one —
    // the leak is the reservation, never the fd.
    expect(ledger.closeCalls).toBe(ledger.admitCalls.length);
  });

  test("a SELF-MINTED id that collides is re-minted, and the run lands on the free one", async () => {
    // Nobody chose a minted id, so a collision is re-minted rather than refused
    // — and the loop that does it was untested: a `break` on the first collision
    // would dispatch under an id whose record belongs to another run, which is
    // the orphaned-reservation-then-EEXIST state the guard exists to prevent.
    const taken = new Set<string>();
    let probes = 0;
    let thirdProbe = "";
    const realGet = store.get.bind(store);
    store.get = (runId: string) => {
      probes += 1;
      // The first two minted ids are "already taken". Later reads — `store.set`
      // does its own read-modify-write through `get` — go to the real store.
      if (probes <= 2) {
        taken.add(runId);
        return { runId, createdAt: new Date().toISOString() } as ReturnType<typeof realGet>;
      }
      if (probes === 3) thirdProbe = runId;
      return realGet(runId);
    };

    const result = await dispatch(validBrief(), deps());

    expect(taken.size).toBe(2); // two DISTINCT ids, i.e. a fresh mint each time
    expect(taken.has(result.runId)).toBeFalse();
    expect(result.runId).toBe(thirdProbe);
    expect(readdirSync(store.dir)).toEqual([`${result.runId}.json`]);
  });

  test("run ids that ALL collide → exit 1 run-id-unmintable, blaming no other run", async () => {
    // The other end of the same loop: bounded, so a saturated run directory
    // refuses instead of spinning — and the refusal must not report the last
    // COLLIDING id as this dispatch's own, because that id belongs to someone
    // else's live run and the payload would be telling a tier-1 agent to tear
    // THAT down.
    const realGet = store.get.bind(store);
    let probes = 0;
    store.get = (runId: string) => {
      probes += 1;
      return { runId, createdAt: new Date().toISOString() } as ReturnType<typeof realGet>;
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("run-id-unmintable");
      expect(err.payload?.runId).toBeNull();
      expect(err.payload).not.toHaveProperty("teardownCommand");
      expect((refusalLines()[0] as LogEntry).runId).toBeNull();
    }
    // MINT_RETRIES (4) re-mints plus the first attempt. Pinned exactly: 1 is an
    // early `break` and anything unbounded is the spin the bound exists to stop.
    expect(probes).toBe(5);
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a run-record directory that cannot be READ refuses (exit 1) rather than reusing the id", async () => {
    // Absence is ENOENT and nothing else. An EACCES/EIO read the same way as
    // "free to reuse" hands the id to `store.create` on a store that cannot be
    // read at all — and an untyped escape costs the operator the dispatch-log
    // entry and the structured line every other exit owes them.
    const eacces = Object.assign(new Error("EACCES: permission denied, open 'runs/x.json'"), {
      code: "EACCES",
    });
    store.get = () => {
      throw eacces;
    };
    const ledgerFactory = mock(() => goodLedger());

    try {
      await dispatch(validBrief(), deps({ ledgerFactory }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("record-read-failed");
      expect(err.payload?.providerCode).toBe("EACCES");
      // Pre-provision: nothing to tear down.
      expect(err.payload).not.toHaveProperty("teardownCommand");
    }
    expect(ledgerFactory).not.toHaveBeenCalled();
    expect(await driver.list()).toHaveLength(0);
  });

  // ─── Admission: budget gate (AC7) ───────────────────────────────────────────────────

  test("AC7: OverBudgetError → FleetError exit 5 with DF2.8 fields, zero provisioning", async () => {
    const brief = validBrief();
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock(() =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: 50, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;
    const ledger = overBudgetLedger();

    try {
      await dispatch(brief, deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      expect(err.payload?.capMicroUsd).toBe(10_000_000);
      expect(err.payload?.spentMicroUsd).toBe(12_000_000);

      // Zero provisioning
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
    // The refusal path closes the handle too — a leaked SQLite handle per
    // refused dispatch is invisible until the fleet runs out of them.
    expect(ledger.closeCalls).toBe(1);
  });

  test("AC7: {admitted:true} still checks budget (only headroom suppressed)", async () => {
    // "ONLY headroom" is half the claim, and nothing here used to test it: with
    // an ordinary quota the headroom gate ALLOWS, so deleting the `opts.admitted`
    // short-circuit entirely left this green — the budget refusal fired either
    // way, one step later.
    //
    // A quota that would REFUSE is what tells them apart. Headroom runs BEFORE
    // the budget gate, so with the short-circuit deleted this dispatch exits 5
    // `no-headroom` and never reaches the ledger at all; with it, the ledger is
    // asked and `budget-exceeded` is the answer.
    const brief = validBrief();
    const listSpy = mock(() => Promise.resolve([] as ProviderVm[]));
    driver.list = listSpy;
    const ledger = overBudgetLedger();

    try {
      await dispatch(
        brief,
        deps({ ledgerFactory: () => ledger, quotaLimits: limitsWith({ maxVms: 0 }) }),
        { admitted: true },
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
    }
    // The budget gate was REACHED and asked about this issue…
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
    // …and the headroom gate was not: `checkHeadroom` is the only caller of
    // `driver.list` on this path.
    expect(listSpy).not.toHaveBeenCalled();
  });

  test("AC7: admitIssue is asked about THIS issue, run and cap, and the ledger is closed", async () => {
    const brief = validBrief();
    const cap = 12_345_678;
    const ledger = goodLedger(cap);

    const result = await dispatch(brief, deps({ ledgerFactory: () => ledger }));

    expect(ledger.admitCalls).toHaveLength(1);
    const call = ledger.admitCalls[0] as (typeof ledger.admitCalls)[number];
    expect(call.input).toEqual({
      repoSlug: "owner/repo",
      // The ledger's issue_id column is text — the brief's number is stringified
      // exactly once, here, or the same issue books two different rows.
      issueId: "42",
      runId: result.runId,
      requestId: result.requestId,
    });
    // capForIssue(config, …) with no per-issue override → the config default.
    expect(call.capMicroUsd).toBe(cap);
    // DF2.3's backstop, not a re-derived one: the clamp is min(keyCap, remaining).
    expect(call.keyCapMicroUsd).toBe(defaultKeyCapMicroUsd);
    expect(ledger.closeCalls).toBe(1);
  });

  test("AC7: a perIssueOverride is what reaches admitIssue — and it is matched CANONICALLY", async () => {
    // Every fixture in this file leaves `perIssueOverrides` empty, so
    // `capForIssue`'s override branch never ran at this seam and the sibling
    // above is a round-trip through the fixture's own default: delete the
    // override lookup from the budget gate entirely and it stays green.
    //
    // The override key is deliberately spelled in a DIFFERENT CASE from the
    // brief's slug. GitHub folds owner/name, so these name one issue — and an
    // override authored as `Owner/Repo#42` that quietly fails to apply to a
    // dispatch spelling it `owner/repo` reverts the cap to the default, which is
    // the failure direction that costs money.
    const override = 3_500_000;
    // Built INLINE, not through `goodLedger`: `LedgerLike.config` is a
    // `Pick<CostLedger, …>` and therefore READ-ONLY, and the shared fixture's
    // `perIssueOverrides` is `{}` by construction — which is exactly why this
    // branch had no coverage at this seam.
    const admitCalls: Array<{ input: AdmissionInput; capMicroUsd: number }> = [];
    const ledger: LedgerLike = {
      config: {
        defaultCapMicroUsd: 99_000_000,
        perIssueOverrides: {
          "Owner/Repo#42": override,
          // A near-miss on the SAME repo, to prove the issue number is part of
          // the key rather than the slug alone.
          "owner/repo#43": 1_000,
        },
      },
      admitIssue(input, capMicroUsd) {
        admitCalls.push({ input, capMicroUsd });
        return {
          admitted: true as const,
          status: "within-budget" as const,
          admittedCeilingMicroUsd: defaultKeyCapMicroUsd,
          // The resolved cap, echoed back — so a dispatcher that ignored what it
          // was handed and re-derived one downstream is still caught.
          capMicroUsd,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
          remainingMicroUsd: defaultKeyCapMicroUsd,
          unpricedRows: 0,
        };
      },
      close() {},
    };

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));

    expect(admitCalls).toHaveLength(1);
    const call = admitCalls[0] as (typeof admitCalls)[number];
    expect(call.capMicroUsd).toBe(override);
    // Not the default, and not the neighbouring issue's — named explicitly, so
    // the failure message says which of the three the dispatcher picked.
    expect(call.capMicroUsd).not.toBe(99_000_000);
    expect(call.input.repoSlug).toBe("owner/repo");
    expect(call.input.issueId).toBe("42");
    expect(result.state).toBe("ready");
  });

  test("AC7: an admitted ceiling of ZERO → exit 5 no-ceiling, and nothing is provisioned", async () => {
    // Every other ledger fixture here admits with a positive ceiling, so this
    // guard — the only thing between an admitted run and an unspendable one —
    // had no test at all. Remove it and the dispatcher mints a $0 key, stamps
    // `limitMicroUsd: 0` into the manifest and fails at gate item D, i.e. exit 3
    // with a LIVE billable box that INV-5 then forbids tearing down, instead of
    // refusing before anything exists.
    //
    // A POSITIVE cap with a zero ceiling, which is the shape production
    // produces: the ceiling is min(keyCap, remaining), so an issue with cap left
    // on paper and nothing remaining admits at exactly this.
    const ledger = goodLedger(0, defaultKeyCapMicroUsd);
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-ceiling");
      expect(err.payload?.admittedCeilingMicroUsd).toBe(0);
      expect(err.payload?.capMicroUsd).toBe(defaultKeyCapMicroUsd);
      // Pre-provision, so no teardown advice for a run that does not exist.
      expect(err.payload).not.toHaveProperty("teardownCommand");
    }
    expect(createSpy).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    // The admission WAS spent — this refusal cannot precede it, because the
    // ceiling under test is the decision's own output. The handle still closes.
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
  });

  test("AC7: an admitIssue that THROWS refuses (exit 5) and still closes the handle", async () => {
    // The untyped-throw sibling below injects the failure at `ledgerFactory`,
    // i.e. before a ledger object exists — so the `finally` that closes it is
    // trivially satisfied. This is the other side: the gate WAS reached, a real
    // handle is open, and the throw comes from inside `admitIssue`. That is the
    // one place a `close()` outside a `finally` gets skipped, and the real
    // ledger owns a SQLite handle, so it is one leaked fd per failed dispatch.
    const ledger = admitThrowsLedger();
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      // The FLEET code stays fixed for every untyped admission failure.
      expect(err.code).toBe("admission-failed");
      expect(err.message).toContain(ADMIT_THROW_MESSAGE);
      // A plain `Error` carries no `code`, and an absent code is named by
      // omission rather than by a fabricated fallback.
      expect(err.payload).not.toHaveProperty("providerCode");
    }
    // The gate was REACHED and blew up — distinct from never having been called,
    // which every pre-admission refusal in this file asserts instead.
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
    expect(createSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  test("AC7: a typed CostLedgerError keeps its OWN message, remediation and code — as PAYLOAD", async () => {
    // The typed arm, distinct from `admission-failed` above: a `CostLedgerError`
    // carries a real diagnosis and the operator's actual next command, and
    // collapsing it into the untyped arm would report a ledger-schema mismatch
    // or a locked ledger file as the generic "budget admission failed" with the
    // module's own fallback advice, losing both.
    //
    // The `code` is the one thing that does NOT pass through. This CLI's
    // exit-code table is its own (F3, module header) — `providerCodePayload`'s
    // rule — so the fleet code is fixed at `ledger-failed` and the ledger's own
    // goes in the payload as `providerCode`. Passing it through made a rename in
    // `cost-ledger.ts` silently change which rows an operator's dispatch-log
    // grep returns, which is exactly the drift the rule exists to prevent; that
    // the ledger's table is first-party and closed makes it a table two modules
    // must be renamed in step, not this module's table.
    const ledger = goodLedger();
    ledger.admitIssue = () => {
      throw new CostLedgerError(
        "ledger-schema-mismatch",
        "cost ledger schema is at version 3, this build expects 4",
        "run the ledger migration, then retry",
      );
    };

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("ledger-failed");
      expect(err.payload?.providerCode).toBe("ledger-schema-mismatch");
      expect(err.message).toBe("cost ledger schema is at version 3, this build expects 4");
      expect(err.remediation).toBe("run the ledger migration, then retry");
    }
    expect(ledger.closeCalls).toBe(1);
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a ledger whose close() THROWS does not fail an otherwise successful run — it is NAMED", async () => {
    // `close()` is where the reservation write is flushed, so a throw here means
    // the ledger may hold no record of the admission just granted and the next
    // dispatch for this issue overcommits the cap. Rethrowing would turn a
    // successful run into a crash after the box, the key and the gate are all
    // done; swallowing silently makes the overcommit undiagnosable. The
    // contract is "report, proceed", and neither half of it was tested.
    const ledger = closeThrowsLedger();

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));

    // PROCEED: the run is fully provisioned and acked.
    expect(result.state).toBe("ready");
    expect(store.get(result.runId).vmName).toBe(result.vmName);
    // The attempt was made — distinguishable from never closing at all.
    expect(ledger.closeCalls).toBe(1);

    // REPORT: on the structured log, under its own code, and classified
    // `transient` — an operator retries the flush, they do not rewrite a brief.
    const closeFailures = entries.filter(
      (e) => (e.error as { code?: string } | undefined)?.code === "ledger-close-failed",
    );
    expect(closeFailures).toHaveLength(1);
    const line = closeFailures[0] as LogEntry;
    expect(line.status).toBe("error");
    expect(line.exitStatus).toBe("transient");
    expect(line.phase).toBe("admitted");
    // Joinable: the line names the run whose reservation may be unflushed.
    expect(line.runId).toBe(result.runId);
    expect(line.requestId).toBe(result.requestId);
    expect(String((line.error as { message?: unknown }).message)).toContain(CLOSE_THROW_MESSAGE);
    // …and the failure is NOT reported as the run's own outcome: the terminal
    // line is still the success one.
    expect(entries.some((e) => e.phase === "ready" && e.status === "ok")).toBeTrue();
    expect(refusalLines()).toHaveLength(0);
  });

  // ─── Admission: headroom gate (AC8) ───────────────────────────────────────────────

  test("AC8: checkHeadroom allowed:false → FleetError exit 5, zero provisioning", async () => {
    const brief = validBrief();
    const listSpy = mock(() =>
      Promise.resolve([
        { name: "box1", status: "running" },
        { name: "box2", status: "running" },
        { name: "box3", status: "running" },
      ] as ProviderVm[]),
    );
    driver.list = listSpy;

    const loaded = limitsWith({ maxVms: 3 }); // 3 live == ceiling → headroom 0

    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    // The mint spy its `list-unverified` sibling asserts and this one only
    // CLAIMED to share: a refusal that minted a key first leaves a live,
    // spendable credential with no record naming it, which the exit code and
    // the box count are both blind to.
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps({ quotaLimits: loaded }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(createSpy).not.toHaveBeenCalled();
      expect(mintSpy).not.toHaveBeenCalled();
      expect(readdirSync(store.dir)).toHaveLength(0);
    }
    // AC4's evidence trail, which neither headroom arm asserted: a refusal that
    // files no structured line leaves the operator with an exit code and
    // nothing to join it to.
    expect(refusalLines()).toHaveLength(1);
    expect((refusalLines()[0] as LogEntry).status).toBe("error");
  });

  test("AC8: checkHeadroom list-unverified → FleetError exit 5", async () => {
    const brief = validBrief();
    // driver.list throws → checkHeadroom reports list-unverified (fail-closed)
    driver.list = mock(() => Promise.reject(new Error("list timeout")));
    const createSpy = mock(() => Promise.resolve({ name: "test", status: "running" } as ProviderVm));
    driver.create = createSpy;
    const mintSpy = mock((_name: string, limit: number) =>
      Promise.resolve({ key: "sk-test", hash: "abc", limitUsd: limit, usageUsd: 0 }),
    );
    keyApi.createKey = mintSpy;

    try {
      await dispatch(brief, deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("no-headroom");
      expect(err.payload?.reason).toBe("list-unverified");
    }
    // Fail-CLOSED, not merely fail-loud: an unverifiable roster that still
    // minted a key or wrote a record before refusing satisfies the exit code
    // above and leaves both behind. Same assertions as the `allowed:false`
    // sibling — the two paths refuse for different reasons but owe the same
    // "nothing happened".
    expect(createSpy).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
    expect(readdirSync(store.dir)).toHaveLength(0);
    // Same evidence trail as the `allowed:false` sibling.
    expect(refusalLines()).toHaveLength(1);
  });

  test("AC8: {admitted:true} suppresses the headroom call (a saturated fleet still dispatches)", async () => {
    const brief = validBrief();
    // Ceiling 0 with 0 live VMs: only passable if the headroom call is SKIPPED
    const loaded = limitsWith({ maxVms: 0 });

    const listSpy = mock(() => Promise.resolve([] as ProviderVm[]));
    driver.list = listSpy;

    const result = await dispatch(brief, deps({ quotaLimits: loaded }), { admitted: true });
    // The ack's SHAPE, not merely its existence: with `toBeDefined` the positive
    // half of this test rested entirely on the spy below, so a dispatch that
    // skipped the headroom call and then acked something structurally wrong
    // passed.
    expect(result).toMatchObject({
      runId: expect.stringMatching(/^qds-/),
      requestId: expect.stringMatching(UUID_V4_RE),
      state: "ready",
    });
    // EXACTLY zero: `checkHeadroom` is the only caller of `driver.list` on this
    // path, so "at most one" would be satisfied by the regression it is meant
    // to catch (one headroom call that happened to be allowed).
    expect(listSpy).not.toHaveBeenCalled();
  });

  // ─── INV-1 ordering: record → box → key → fill → gate ─────────────────────────────────

  test("INV-1: ordering asserted via call-order capture", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

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
      // The two `sh -c` steps are told APART. Both key delivery and the manifest
      // fill ride `sh -c`, and collapsing them into one `sh-exec` label made the
      // ordering check blind to the thing it names: `indexOf` finds the FIRST
      // one, so a fill moved to AFTER the gate still satisfied
      // `… < sh-exec < gate`. `deliverScript` opens with `umask 077`
      // (credentials.ts) and `fillRun` passes the target path as its last argv
      // element (driver.ts) — neither is a shape this test invents.
      if (argv[0] === "sh") {
        const script = argv[2] ?? "";
        if (script.startsWith("umask 077")) callOrder.push("deliver");
        else if (argv.at(-1) === "pipeline.yaml") callOrder.push("fill:pipeline.yaml");
        else if (argv.at(-1) === "run-context.json") callOrder.push("fill:run-context.json");
        else callOrder.push(`sh-exec:${script.slice(0, 24)}`);
      }
      return originalExec(vm, argv, stdin);
    };

    await dispatch(
      brief,
      deps({
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );

    // The WHOLE INV-1 chain, in full and exactly: record → box → key mint → key
    // delivery → manifest fill → gate. An equality rather than a subsequence,
    // now that the two `sh -c` steps are distinguishable — a subsequence over
    // labels that repeat is what let fill-after-gate through, and there is no
    // step here whose position is genuinely free.
    //
    // Truncated AT the gate: `fakeGate` runs five `sh -c` probes of its own, and
    // those belong to the gate's tests, not to this one.
    expect(callOrder).toContain("gate");
    expect(callOrder.slice(0, callOrder.indexOf("gate") + 1)).toEqual([
      "store.create",
      "driver.create",
      "mint",
      "deliver",
      "fill:pipeline.yaml",
      "fill:run-context.json",
      "gate",
    ]);
  });

  test("a raw failure inside the provisioning step is typed and still names the runId", async () => {
    // The create step STRADDLES the record: `provisionAdmittedRun` writes the
    // run record first (INV-1), then the box. An untyped throw escaping from
    // the second half carries no runId, so the CLI's failure line reported
    // `runId: null` for a run an operator can see in `fleet status` — exactly
    // when they need the id to tear it down.
    driver.create = mock(() => Promise.reject(new Error("substrate refused the box")));
    const brief = validBrief();
    // Held, not minted per call: the default `ledgerFactory` returns a fresh
    // throwaway, so `closeCalls` is unobservable — and a mid-provisioning throw
    // is exactly where a `close()` outside a `finally` gets skipped, leaking one
    // SQLite handle per failed dispatch until the fleet exhausts its fds.
    const ledger = goodLedger();
    let err: FleetError | undefined;
    try {
      await dispatch(brief, deps({ ledgerFactory: () => ledger }));
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    const e = err as FleetError;
    expect(e.exitCode).toBe(1);
    expect(e.message).toContain("substrate refused the box");
    const runId = e.payload?.runId;
    expect(typeof runId).toBe("string");
    // Not merely non-null — the id must name the record that is really on disk.
    expect(readdirSync(store.dir)).toContain(`${runId as string}.json`);
    expect(e.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId as string}`);
    // `refuse` also files the refusal log line the dispatch-log evidence needs.
    expect(refusalLines()).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
  });

  // ─── Cap hand-off (AC9) ─────────────────────────────────────────────────────────

  test("AC9: mintRunKey receives cap === admittedCeilingMicroUsd, under THIS run's key name", async () => {
    const brief = validBrief();
    const admittedCeiling = 25_000_000; // half of the DF2.3 default
    const originalMint = keyApi.createKey.bind(keyApi);
    const mintSpy = mock((name: string, limit: number) => originalMint(name, limit));
    keyApi.createKey = mintSpy;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    expect(mintSpy).toHaveBeenCalledTimes(1);
    const [nameArg, limitArg] = mintSpy.mock.calls[0] as [string, number];
    expect(limitArg).toBe(admittedCeiling / 1_000_000); // µ$ → USD at the HTTP boundary
    // The key NAME, which only the limit argument was ever read for. It is the
    // sole handle teardown has on the provider side: `revokeRunKey` refuses to
    // delete anything whose name lacks the `sbx-` prefix, and it finds the key
    // by the run id in that name. Minted under a stale or invented run's name,
    // teardown revokes ANOTHER run's live credential and leaves this one
    // spendable — and every other assertion in this file still passes.
    expect(nameArg).toBe(`${SBX_KEY_PREFIX}${result.runId}`);
  });

  test("AC9a: manifest stamped with limitMicroUsd = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    const admittedCeiling = 30_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    const record = store.get(result.runId);
    const filled = await driver.exec(record.vmName as string, ["cat", "pipeline.yaml"]);
    // Parsed and compared NUMERICALLY: a substring assertion on "30000000" also
    // matches 300000000 and 30000000000, so a 10×/1000× unit-conversion error
    // in the stamp would pass. `YAML.parse` reads the delivered file under
    // either encoding (serializeManifest emits JSON, a YAML subset).
    const delivered = YAML.parse(filled.stdout) as { limitMicroUsd?: unknown };
    expect(delivered.limitMicroUsd).toBe(admittedCeiling);
  });

  test("AC9b: budget extension carries effectiveCeilingMicros = admittedCeilingMicroUsd", async () => {
    const brief = validBrief();
    // Cap ≠ ceiling on purpose: with the two equal, a dispatcher that
    // propagated `capMicroUsd` wherever the ceiling belongs passes every
    // assertion below. The ceiling is min(keyCap, remaining), i.e. the smaller.
    const admittedCeiling = 20_000_000;
    const cap = 75_000_000;

    const result = await dispatch(brief, deps({ ledgerFactory: () => goodLedger(admittedCeiling, cap) }));

    const record = store.get(result.runId);
    expect(record.extensions?.budget?.admittedCeilingMicroUsd).toBe(admittedCeiling);
    expect(record.extensions?.budget?.capMicroUsd).toBe(cap);

    // The run context handed to the box carries the same computed-once value
    const ctxFile = await driver.exec(record.vmName as string, ["cat", "run-context.json"]);
    const ctx = JSON.parse(ctxFile.stdout) as { effectiveCeilingMicros?: number };
    expect(ctx.effectiveCeilingMicros).toBe(admittedCeiling);

    // The manifest is the cap's only in-box source (AC9a) — the CEILING, not
    // the issue cap, is what the box may spend.
    const filled = await driver.exec(record.vmName as string, ["cat", "pipeline.yaml"]);
    expect((JSON.parse(filled.stdout) as { limitMicroUsd?: number }).limitMicroUsd).toBe(admittedCeiling);
  });

  test("AC9: a provider that mints ABOVE the request is CLAMPED to the request — and the over-mint is an ERROR line", async () => {
    // The money path, and the direction with no other guard behind it.
    // `credentials.ts` persists `usdToMicros(res.limitUsd)` — the PROVIDER's own
    // answer — checking only that it is finite and positive, and dispatch reads
    // that figure back to stamp the box. A key API that rounds up, applies a
    // plan floor, is misconfigured or is answering for somebody else would
    // otherwise authorize the box to spend ABOVE the ceiling the ledger reserved
    // against the issue's cap, on the strength of its own reply.
    // `mintedCeilingMicros = Math.min(effectiveCeilingMicros, persisted)` is the
    // clamp; nothing exercised a persisted value LARGER than the request, so
    // deleting the `min` (or writing `max`) left every AC9 assertion green.
    const admittedCeiling = 25_000_000; // 25 USD at the HTTP boundary
    const overMintedUsd = 50; // double, and a plausible plan floor
    const requestedUsd: number[] = [];
    keyApi.createKey = async (_name: string, limitUsd: number) => {
      requestedUsd.push(limitUsd);
      // The provider ACKNOWLEDGES a bigger cap than it was asked for. Everything
      // downstream — the record's `limitMicroUsd`, the manifest stamp, the run
      // context — derives from this number unless the clamp intervenes.
      return { key: "sk-or-v1-overminted", hash: "cafef00d", limitUsd: overMintedUsd, usageUsd: 0 };
    };

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    // The REQUEST was the admitted ceiling — the clamp is about the reply, not
    // about asking for less.
    expect(requestedUsd).toEqual([admittedCeiling / 1_000_000]);

    // The box is stamped with the REQUESTED ceiling, in both carriers (9a and
    // 9b must not name two different numbers).
    const delivered = await driver.exec(result.vmName, ["sh", "-c", "cat pipeline.yaml"]);
    expect((JSON.parse(delivered.stdout) as { limitMicroUsd: number }).limitMicroUsd).toBe(admittedCeiling);
    const ctx = await driver.exec(result.vmName, ["sh", "-c", "cat run-context.json"]);
    expect((JSON.parse(ctx.stdout) as { effectiveCeilingMicros: number }).effectiveCeilingMicros).toBe(
      admittedCeiling,
    );
    // …and the provider's larger figure reaches no carrier the box reads.
    expect(delivered.stdout).not.toContain(String(overMintedUsd * 1_000_000));
    expect(ctx.stdout).not.toContain(String(overMintedUsd * 1_000_000));

    // The RECORD still holds what the provider actually minted — that key is
    // live at 50 USD whatever this module stamps, and the record is the only
    // place an operator can see the exposure.
    expect(store.get(result.runId).limitMicroUsd).toBe(overMintedUsd * 1_000_000);

    // An over-mint is a MONEY EVENT, not a diagnostic: it used to log
    // `status:"ok"` / `exitStatus:"success"` in both directions, so the one
    // direction meaning "the provider tried to hand this run more headroom than
    // it was admitted for" never reached error-based alerting.
    const overMintLines = entries.filter(
      (e) => (e.error as { code?: string } | undefined)?.code === "mint-cap-over-request",
    );
    expect(overMintLines).toHaveLength(1);
    const line = overMintLines[0] as LogEntry;
    expect(line.status).toBe("error");
    expect(line.exitStatus).toBe("transient");
    expect(line.phase).toBe("minted");
    // Joinable, and it names BOTH figures — "a key is live" and "it can spend N
    // µ$ more than was reserved" are different sizes of incident.
    expect(line.runId).toBe(result.runId);
    expect(line.requestId).toBe(result.requestId);
    const message = String((line.error as { message?: unknown }).message);
    expect(message).toContain(String(overMintedUsd * 1_000_000));
    expect(message).toContain(String(admittedCeiling));
    // NOT the under-mint code: that one is informational, and collapsing the two
    // is exactly how the money direction stopped alerting.
    expect(entries.some((e) => (e.error as { code?: string } | undefined)?.code === "mint-cap-differs")).toBeFalse();
    // The run itself SUCCEEDS — the clamp is not a refusal, and turning it into
    // one would strand a live key with no record.
    expect(result.state).toBe("ready");
    expect(refusalLines()).toHaveLength(0);
  });

  test("AC9: a provider that mints BELOW the request is honoured, and logged as informational", async () => {
    // The control for the clamp above, and the direction that is NOT an
    // incident: the box gets less than it asked for and dies against a limit it
    // was told about, which is the manifest stamp doing its job. With only the
    // over-mint case, a `min` replaced by "always the request" still passes.
    const admittedCeiling = 25_000_000;
    const mintedUsd = 10;
    keyApi.createKey = async () => ({
      key: "sk-or-v1-underminted",
      hash: "beefcafe",
      limitUsd: mintedUsd,
      usageUsd: 0,
    });

    const result = await dispatch(validBrief(), deps({ ledgerFactory: () => goodLedger(admittedCeiling) }));

    const delivered = await driver.exec(result.vmName, ["sh", "-c", "cat pipeline.yaml"]);
    expect((JSON.parse(delivered.stdout) as { limitMicroUsd: number }).limitMicroUsd).toBe(mintedUsd * 1_000_000);
    const differs = entries.filter(
      (e) => (e.error as { code?: string } | undefined)?.code === "mint-cap-differs",
    );
    expect(differs).toHaveLength(1);
    expect((differs[0] as LogEntry).status).toBe("ok");
    expect((differs[0] as LogEntry).exitStatus).toBe("success");
  });

  // ─── Gate failure (AC3, INV-5) ─────────────────────────────────────────────────────

  test("AC3: gate ready=false → FleetError exit 3, record OPEN, box alive, gate outcome recorded", async () => {
    const brief = validBrief();
    const ledger = goodLedger();
    const before = Date.now();

    try {
      await dispatch(
        brief,
        deps({
          ledgerFactory: () => ledger,
          setupGate: async () => ({
            ready: false,
            failedItem: "A" as const,
            assertionCode: 1 as const,
            assertions: [{ item: "A" as const, ok: false, note: "HEAD mismatch" }],
            debugCommands: ["ssh box.exe.xyz cat /tmp/provision"],
            teardownCommand: "bun scripts/fleet.ts teardown the-run",
            vm: "test-box",
          }),
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      expect(err.payload?.assertionCode).toBe(1);
      expect(err.payload?.failedItem).toBe("A");

      // Record OPEN (no closedAt) and the failure recorded host-side
      const record = store.get(err.payload?.runId as string);
      expect(record.closedAt).toBeUndefined();

      // AC3: the refusal is on the RUN RECORD too — `fleet status` is where an
      // operator learns why the run is open.
      expect(record.extensions?.gate?.outcome).toBe("failed");
      expect(record.extensions?.gate?.failedItem).toBe("A");
      expect(record.extensions?.gate?.assertionCode).toBe(1);
      // WHEN the gate failed, not merely "a parseable string": `Date.parse("2001")`
      // is a number, so a frozen constant, a zero epoch or a timestamp copied
      // from `createdAt` all passed — and `failedAt` is what an operator sorts a
      // wall of open runs by when deciding which box to tear down first.
      const failedAt = String(record.extensions?.gate?.failedAt);
      expect(failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(Date.parse(failedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(failedAt)).toBeLessThanOrEqual(Date.now());
      // …and it is not just `createdAt` under another name.
      expect(Date.parse(failedAt)).toBeGreaterThanOrEqual(Date.parse(record.createdAt));

      // A minted key is spendable the moment it exists. If the dispatcher dies
      // at the gate without persisting `keyHash`, the credential is live and
      // NOBODY can revoke it — the record is the only handle teardown has.
      expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);

      // Box NOT destroyed (INV-5: the evidence outlives the failure)
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();

      // The refusal line carries the run id once one exists — the counterpart
      // of the `runId: null` refusal above.
      const refusals = refusalLines();
      expect(refusals).toHaveLength(1);
      expect((refusals[0] as LogEntry).runId).toBe(record.runId);
    }
    expect(ledger.closeCalls).toBe(1);
  });

  for (const [label, returned] of [
    ["undefined", undefined],
    ["null", null],
  ] as const) {
    test(`AC3: a gate returning ${label} → exit 3 setup-gate-invalid, box ALIVE (not exit 1)`, async () => {
      // `deps.setupGate` is an injection seam, and the "every read of the gate's
      // own result is DEFENDED" claim covered `assertions`/`debugCommands`/
      // `failedItem` while `gate.ready` itself was an unguarded property read: a
      // gate returning nothing threw a TypeError that escaped to the OUTER catch
      // and came back as exit-1 `dispatch-failed`. That names the wrong cause —
      // exit 1 is a substrate fault an operator goes hunting for, exit 3 is the
      // gate, and the classification is the whole difference between the two.
      const ledger = goodLedger();
      try {
        await dispatch(
          validBrief(),
          deps({
            ledgerFactory: () => ledger,
            setupGate: (async () => returned) as unknown as DispatchDeps["setupGate"],
          }),
        );
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FleetError);
        const err = e as FleetError;
        expect(err.exitCode).toBe(3);
        expect(err.code).toBe("setup-gate-invalid");
        // WHAT it returned, so the operator fixing the gate knows which of the
        // two shapes they produced.
        expect(err.payload?.returned).toBe(label);
        expect(err.message).toContain(label);

        // INV-5, the same posture as an ordinary gate failure: the box outlives
        // the refusal and the record stays open, because the box is the evidence.
        const record = store.get(err.payload?.runId as string);
        expect(record.closedAt).toBeUndefined();
        expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);
        const boxes = await driver.list();
        expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
      }
      expect(ledger.closeCalls).toBe(1);
    });
  }

  test("AC3: a gate assertion note whose toString THROWS still refuses at exit 3", async () => {
    // `note` is DECLARED `string` (setup-gate.ts) and `deps.setupGate` is an
    // injection seam, so the declaration is a promise the seam does not keep —
    // and on an exedev box the note is whatever the BOX printed. A bare
    // `String(note)` at the refusal's call site put an unguarded coercion inside
    // the exit-3 path: a throwing `toString` escaped to the outer catch and
    // downgraded the whole thing to exit-1 `dispatch-failed`, losing the
    // classification, the assertion evidence and the gate's own teardown
    // command. `escapeText` guards both coercions in one place.
    const hostile = {
      toString() {
        throw new Error("hostile toString");
      },
    } as unknown as string;

    try {
      await dispatch(
        validBrief(),
        deps({
          setupGate: async (_drv, vm) => ({
            ready: false,
            failedItem: "A" as const,
            assertionCode: 1 as const,
            assertions: [{ item: "A" as const, ok: false, note: hostile }],
            debugCommands: [],
            teardownCommand: "bun scripts/fleet.ts teardown the-run",
            vm,
          }),
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(3);
      expect(err.code).toBe("setup-gate-failed");
      expect(err.code).not.toBe("dispatch-failed");
      // The note is REPORTED as unprintable rather than dropped: the item and
      // the assertion list still reach the operator, which is the evidence the
      // exit-3 envelope exists to carry.
      expect(err.message).toContain("«unprintable»");
      expect(err.payload?.failedItem).toBe("A");
      expect(err.payload?.assertions).toEqual(["A:«unprintable»"]);
    }
  });

  test("INV-5 ordering: a failed gate never makes the box public", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalExpose = driver.expose.bind(driver);
    driver.expose = async (vm: string, port: number) => {
      callOrder.push("expose");
      return originalExpose(vm, port);
    };
    const originalSetPublic = driver.setPublic.bind(driver);
    driver.setPublic = async (vm: string) => {
      callOrder.push("setPublic");
      return originalSetPublic(vm);
    };

    try {
      await dispatch(
        brief,
        deps({
          port: 8080,
          setupGate: async (_drv, vm) => {
            callOrder.push("gate");
            return {
              ready: false,
              failedItem: "C" as const,
              assertionCode: 2 as const,
              assertions: [{ item: "C" as const, ok: false, note: "env file mode" }],
              debugCommands: [],
              teardownCommand: "bun scripts/fleet.ts teardown the-run",
              vm,
            };
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as FleetError).code).toBe("setup-gate-failed");
    }
    // A box made public before the gate proves it is reachable while unproven —
    // and INV-5 then forbids tearing it down.
    expect(callOrder).toEqual(["gate"]);
  });

  test("INV-5 ordering: the box is exposed and made public only AFTER the gate passes", async () => {
    const brief = validBrief();
    const callOrder: string[] = [];

    const originalExpose = driver.expose.bind(driver);
    driver.expose = async (vm: string, port: number) => {
      callOrder.push("expose");
      return originalExpose(vm, port);
    };
    const originalSetPublic = driver.setPublic.bind(driver);
    driver.setPublic = async (vm: string) => {
      callOrder.push("setPublic");
      return originalSetPublic(vm);
    };

    const result = await dispatch(
      brief,
      deps({
        port: 8080,
        setupGate: async (drv, vm, o) => {
          callOrder.push("gate");
          return fakeGate(drv, vm, o);
        },
      }),
    );

    expect(callOrder).toEqual(["gate", "expose", "setPublic"]);
    expect(result.httpsUrl).toMatch(/^https:\/\//);

    // The RECORD, not just the ack. `fleet status` and every reaper read the
    // record, and the ack is a one-shot line on someone's terminal — so a
    // dispatch that acks a URL for a box it then made public, and never
    // persists it, leaves a live PUBLIC box whose address exists nowhere an
    // operator can find it. Asserted on the success path because the failure
    // path (`expose-no-url`) asserts the opposite and neither implies the other.
    const record = store.get(result.runId);
    expect(record.ports).toEqual([8080]);
    expect(record.httpsUrl).toBe(result.httpsUrl);
    // Same box in both, too — `vmName` was only ever cross-checked on the
    // failure path, so an ack naming a box the record does not know sends
    // teardown at the wrong VM.
    expect(record.vmName).toBe(result.vmName);
    expect(record.closedAt).toBeUndefined();
  });

  test("INV-5: a post-box failure with no code of its own → exit 1 dispatch-failed, box ALIVE, record OPEN", async () => {
    // The catch-all arm of the post-provision try/catch. Every other failure
    // after the box exists has its own code — `setup-gate-failed`,
    // `key-delivery-failed`, `expose-no-url`, `dispatch-timeout` — so nothing
    // reached `dispatch-failed` at all: delete it and the suite stays green
    // while the throw escapes untyped, which is a bare CLI exit 1 with no
    // dispatch-log entry, no runId and no teardown command for a LIVE box.
    //
    // `expose` is the sharpest carrier for it: dispatch claims `ports: [port]`
    // on the record BEFORE calling it. On an ORDINARY provider failure (this
    // one) nothing is in flight and the claim is RETRACTED to `[]` — a record
    // advertising a port nothing is listening on is a port-keyed reaper's and
    // `fleet status`'s problem, and the refusal's own "ALIVE but NOT public"
    // wording contradicted it. The claim is kept only on the abandon path (an
    // expose racing the deadline can still land), which the wall-clock tests
    // cover.
    driver.expose = async () => {
      throw Object.assign(new Error("substrate refused the tunnel"), { code: "ECONNRESET" });
    };
    let setPublicCalls = 0;
    driver.setPublic = async () => {
      setPublicCalls += 1;
    };

    try {
      await dispatch(validBrief(), deps({ port: 8080 }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-failed");
      expect(err.message).toContain("substrate refused the tunnel");
      expect(err.payload?.providerCode).toBe("ECONNRESET");
      const runId = err.payload?.runId as string;

      // INV-5's claims, all three: the operator's commands are on the payload…
      expect(err.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId}`);
      expect(err.payload?.debugCommands).toEqual([`bun scripts/fleet.ts status ${runId}`]);
      expect(err.remediation).toContain("the box is ALIVE");

      // …the record is OPEN, claims NO port (the pre-claim was retracted, since
      // nothing was ever opened) and carries no URL…
      const record = store.get(runId);
      expect(record.closedAt).toBeUndefined();
      expect(record.ports).toEqual([]);
      expect(record.httpsUrl).toBeUndefined();
      expect(err.payload?.vmName).toBe(record.vmName);

      // …and THIS run's box is still there. A count alone passes when the run's
      // own VM is gone and an unrelated box exists.
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
    // Nothing was published: the failure fired before setPublic.
    expect(setPublicCalls).toBe(0);
  });

  // ─── Ack shape (AC2) ─────────────────────────────────────────────────────────────

  test("Ack shape {runId, requestId, state: 'ready', vmName, httpsUrl?}", async () => {
    const brief = validBrief();
    const result = await dispatch(brief, deps());

    expect(result).toMatchObject({
      runId: expect.stringMatching(/^qds-/),
      requestId: expect.stringMatching(UUID_V4_RE),
      state: "ready",
      vmName: expect.stringMatching(/^qds-/),
    });
    // Unconditional, because the shape is not in doubt: `deps()` supplies no
    // port, dispatch withholds one from `provisionAdmittedRun`, and the fake
    // substrate only mints a URL for an exposed port — so the no-port ack must
    // carry NO `httpsUrl` at all. (The with-port arm is asserted by the INV-5
    // exposure-ordering test above.) The old `if` never ran, so a dispatcher
    // that acked a URL for an unexposed box passed here.
    expect(result.httpsUrl).toBeUndefined();
  });

  // ─── 600s wall clock timeout ───────────────────────────────────────────────────────

  test("600s wall clock: expiry past the default ceiling throws FleetError exit 1, box alive", async () => {
    const brief = validBrief();
    const { clock, advance } = stepClock();

    try {
      await dispatch(
        brief,
        // No timeoutMs: the PRODUCTION default is the ceiling under test.
        //
        // `port` is load-bearing, not incidental. The post-gate re-sample bounds
        // the WORK LEFT after the gate, and with no port there is none — step 10
        // is a no-op, so a dispatch whose gate went green is already complete
        // (box alive, key delivered at the full ceiling, record written) and
        // refusing it would tell the operator to tear down a healthy run and
        // re-spend the issue's cap. Drop the port and this must SUCCEED.
        deps({
          clock,
          port: 8080,
          setupGate: async (drv, vm, o) => {
            // Time passes ACROSS the gate — the longest await in a dispatch —
            // so the advance lands after the real work, exactly where the
            // ceiling has to be re-sampled. Advancing before the gate promise
            // reaches `within` instead makes that step abandon an in-flight
            // gate and throw dispatch-timeout from `within` rather than from
            // the post-gate re-sample, which is a different code path.
            const result = await fakeGate(drv, vm, o);
            advance(DEFAULT_TIMEOUT_MS + 1_000);
            return result;
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");
      // "post-gate", not "gate": this expiry is the re-sample AFTER the gate
      // returned ready, so blaming the step named "gate" accused a gate that
      // passed all five assertions. `gateReady` says so on the payload.
      expect(err.payload?.step).toBe("post-gate");
      expect(err.payload?.gateReady).toBeTrue();
      // The default itself, not just "some ceiling" — a changed default would
      // otherwise be invisible here.
      expect(err.message).toContain(`${DEFAULT_TIMEOUT_MS} ms`);

      // Box left alive (INV-5 posture: teardown is the operator's call), and it
      // is THIS run's box — a count alone passes when the run's own VM is gone
      // and an unrelated box exists.
      const record = store.get(err.payload?.runId as string);
      const boxes = await driver.list();
      expect(boxes.some((b) => b.name === record.vmName)).toBeTrue();
    }
  });

  test("600s wall clock: just under the ceiling does NOT expire", async () => {
    const brief = validBrief();
    const { clock, advance } = stepClock();

    // Boundary control: without it, a ceiling regressed to 60s (or raised to
    // 6000s) still passes the expiry test above.
    const result = await dispatch(
      brief,
      deps({
        clock,
        setupGate: async (drv, vm, o) => {
          const result = await fakeGate(drv, vm, o);
          advance(DEFAULT_TIMEOUT_MS - 1_000);
          return result;
        },
      }),
    );
    expect(result.state).toBe("ready");
  });

  // ─── a non-Error throw still refuses, instead of crashing the error path ─────────────

  test("a driver that throws a non-Error still produces a typed refusal", async () => {
    // `throw` takes any value, and the driver is third-party code from
    // dispatch's point of view. Reading `.message` off `null` throws a
    // TypeError from INSIDE the catch block, which replaces the refusal the
    // operator needs — exit code, remediation, dispatch-log entry and all —
    // with an unrelated crash out of the error path itself.
    driver.create = async () => {
      throw null;
    };
    const ledger = goodLedger();

    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => ledger }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      // The untyped throw carries no `code`/`remediation`, so both fall back.
      expect(err.code).toBe("provision-failed");
      // The fallback IN FULL, like the message assertion below it. `toBeTruthy`
      // was satisfied by any non-empty string, including the wrong step's advice
      // — and this step straddles the record, so the fallback deliberately says
      // "inspect the run" rather than "the box is alive" (which half of
      // record→box failed is unknown here, and teardown is idempotent over both).
      expect(err.remediation).toBe(
        `inspect the run, then tear it down: bun scripts/fleet.ts teardown ${err.payload?.runId as string}`,
      );
      expect(err.remediation).not.toContain("the box is ALIVE");
      // The thrown VALUE is what got stringified, in the position the caught
      // error's message occupies. `toContain("null")` was satisfied by text this
      // module writes anyway (refusals elsewhere carry `runId: null`), so it
      // held even for a message that had dropped the throw entirely.
      expect(err.message).toBe(`provisioning failed for run ${err.payload?.runId as string}: null`);
    }
    // The error path is the one most likely to skip the close (see the
    // provisioning-failure test above).
    expect(ledger.closeCalls).toBe(1);
  });

  // ─── fakeGate probe B: the two failure arms are told apart ───────────────────────────

  test("gate item B distinguishes a missing manifest from an unstamped one", async () => {
    // Probe B fires BEFORE item D (which owns "manifest non-empty"), so it has
    // to name both of its own failures. The arms previously shared `exit 2`
    // with `grep`'s own operational-error code, and an existing-but-unstamped
    // manifest and a manifest that never landed are opposite diagnoses: one
    // sends the operator to the stamping step, the other to the fill step.
    const opts = gateOpts;

    const missing = await driver.create("box-probe-missing");
    const noManifest = await fakeGate(driver, missing.name, opts);
    const bMissing = noManifest.assertions.find((a) => a.item === "B");
    expect(bMissing?.ok).toBeFalse();
    // `cat`'s stderr is discarded, so absent and present-but-unreadable both
    // arrive as an empty body; the nonzero exit is what separates them from a
    // manifest that is genuinely present and empty, and it rides the note.
    expect(bMissing?.note).toContain("pipeline.yaml missing or unreadable");
    expect(bMissing?.note).toMatch(/cat exit [1-9]/);
    expect(bMissing?.note).not.toContain("limitMicroUsd absent");

    const unstamped = await driver.create("box-probe-unstamped");
    await driver.exec(unstamped.name, ["sh", "-c", "printf '%s\\n' '{\"phases\":[]}' > pipeline.yaml"]);
    const noStamp = await fakeGate(driver, unstamped.name, opts);
    const bUnstamped = noStamp.assertions.find((a) => a.item === "B");
    expect(bUnstamped?.ok).toBeFalse();
    expect(bUnstamped?.note).toContain("limitMicroUsd absent");
    expect(bUnstamped?.note).not.toContain("pipeline.yaml missing");

    // And the stamped manifest still passes B — without this the assertions
    // above are satisfied by a probe that fails unconditionally.
    const stamped = await driver.create("box-probe-stamped");
    await driver.exec(stamped.name, [
      "sh",
      "-c",
      "printf '%s\\n' '{\"limitMicroUsd\":1,\"phases\":[]}' > pipeline.yaml",
    ]);
    const ok = await fakeGate(driver, stamped.name, opts);
    expect(ok.assertions.find((a) => a.item === "B")?.ok).toBeTrue();

    // A manifest that landed and is EMPTY is the fill step half-done, not the
    // fill step skipped — the only arm `cat` can prove, since it is the only one
    // that exits 0.
    const empty = await driver.create("box-probe-empty");
    await driver.exec(empty.name, ["sh", "-c", ": > pipeline.yaml"]);
    const bEmpty = (await fakeGate(driver, empty.name, opts)).assertions.find((a) => a.item === "B");
    expect(bEmpty?.ok).toBeFalse();
    expect(bEmpty?.note).toContain("present but empty");
    expect(bEmpty?.note).not.toContain("missing");

  });

  // The operational-error path: the manifest EXISTS and cannot be read (mode
  // 000, EIO, an ACL). `cat`'s stderr is discarded by the probe, so this arrives
  // as an empty body exactly like a manifest that never landed — and it used to
  // be reported as "missing", sending the operator back to a fill step that had
  // already succeeded. The NONZERO EXIT is the only thing that separates the two
  // from "present but empty", and it is what has to ride the note.
  //
  // Unreadability is injected at the DRIVER, not with `chmod 000`. Root reads a
  // mode-000 file, so the chmod fixture had to carry
  // `test.skipIf(process.getuid?.() === 0)` — which skips exactly where CI runs
  // (root in Docker), so this arm could collapse back into "missing" and ship
  // green with only a skip marker to say it had never been attempted. A stubbed
  // `exec` reproduces what an EACCES actually delivers to the probe (empty
  // stdout, nonzero exit) on every host and every uid.
  test("gate item B reports an existing-but-unreadable manifest by its EXIT CODE, not as empty", async () => {
    const box = await driver.create("box-probe-unreadable");
    // The manifest is REAL and well-formed — the file exists and would pass B
    // outright. Without this the case proves nothing about "existing but
    // unreadable"; it is the fixture's whole premise.
    await driver.exec(box.name, [
      "sh",
      "-c",
      "printf '%s\\n' '{\"limitMicroUsd\":1,\"phases\":[{\"name\":\"plan\"}]}' > pipeline.yaml",
    ]);
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      // Only the manifest read: every other probe still runs against the real
      // box, so a gate that failed earlier (item A) would be visible as a
      // different `failedItem` rather than silently satisfying these assertions.
      if (argv[0] === "sh" && (argv[2] ?? "").startsWith("cat pipeline.yaml")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return realExec(vm, argv, stdin);
    };

    const gate = await fakeGate(driver, box.name, gateOpts);
    expect(gate.failedItem).toBe("B");
    const bUnreadable = gate.assertions.find((a) => a.item === "B");
    expect(bUnreadable?.ok).toBeFalse();
    // The note names unreadability as a possibility — `cat` cannot tell the two
    // apart with stderr discarded, and claiming otherwise would be a diagnosis
    // the probe has not earned.
    expect(bUnreadable?.note).toContain("unreadable");
    // The exit code is the load-bearing part: it is what distinguishes this from
    // the `present but empty` arm, which is the only one `cat` can prove.
    expect(bUnreadable?.note).toMatch(/cat exit [1-9]/);
    expect(bUnreadable?.note).not.toContain("present but empty");
    // The opposite diagnosis, explicitly: this is the confusion the arm exists
    // to end, and it sends the operator to the wrong step.
    expect(bUnreadable?.note).not.toContain("limitMicroUsd absent");
  });

  test("gate items D and E inspect the manifest's CONTENT, not just its keys", async () => {
    // D used to re-test "manifest non-empty", which item B's own first arm has
    // already proved by the time D runs — it could not fail, so the
    // five-assertion gate was effectively four. It now checks that the stamped
    // ceiling is spendable, and E that the phases list has phases in it.
    //
    // Every box here carries a mode-600 `.env`, because probing STOPS at the
    // first failure: without item C passing, D and E never execute and the
    // assertions below would all be about C.
    const gateOn = async (name: string, manifest: string): Promise<SetupGateResult> => {
      const box = await driver.create(name);
      await driver.exec(box.name, [
        "sh",
        "-c",
        `printf '%s' '${manifest}' > pipeline.yaml && : > .env && chmod 600 .env`,
      ]);
      return fakeGate(driver, box.name, gateOpts);
    };

    // Stamped, so B passes — and worthless, so D must not.
    const zero = await gateOn("box-probe-zero", '{"limitMicroUsd":0,"phases":[{"name":"plan"}]}');
    expect(zero.failedItem).toBe("D");
    expect(zero.assertionCode).toBe(3);
    expect(zero.assertions.find((a) => a.item === "D")?.note).toContain("not a positive integer");

    // A ceiling that is a STRING is the µ$/USD confusion in its other form: a
    // presence check passes it and the box then has no numeric ceiling at all.
    // Pinned to the same depth as the `zero` case above — the item alone is
    // satisfied by a D that refused for some other reason entirely (and D is the
    // item every malformed ceiling lands on), so the code and the note are what
    // say the string was judged as a NUMBER and found not to be one.
    const stringly = await gateOn("box-probe-stringly", '{"limitMicroUsd":"50","phases":[{"name":"plan"}]}');
    expect(stringly.failedItem).toBe("D");
    expect(stringly.assertionCode).toBe(3);
    const dStringly = stringly.assertions.find((a) => a.item === "D")?.note;
    expect(dStringly).toContain("not a positive integer");
    // The offending value is QUOTED back, so `"50"` and `50` are distinguishable
    // in the refusal an operator reads.
    expect(dStringly).toContain('"50"');

    const noPhases = await gateOn("box-probe-nophases", '{"limitMicroUsd":1,"phases":[]}');
    expect(noPhases.failedItem).toBe("E");
    expect(noPhases.assertionCode).toBe(4);

    // Positive control: without it every assertion above is satisfied by a gate
    // that fails unconditionally.
    const good = await gateOn("box-probe-good", '{"limitMicroUsd":1,"phases":[{"name":"plan"}]}');
    expect(good.ready).toBeTrue();
    expect(good.failedItem).toBeUndefined();
  });

  // ─── INV-4: no key material in logs, records or the ack ──────────────────────────────

  /**
   * The POSITIVE CONTROL every absence proof below needs: the exec invocation
   * that actually carries the plaintext key into the box.
   *
   * `deliverRunKey` keeps the key out of argv and puts it on STDIN
   * (src/providers/credentials.ts — `deliverScript(envFile)` takes only the
   * env-file path), so this echoes the WHOLE invocation, which is what a real
   * exec wrapper reports on a failure and the only shape that puts the key in
   * reach of a sink. Without it, "no sink contains the key" is satisfied by a
   * dispatch where the key never came near one — it would stay green with every
   * redaction deleted, and it would stay green if `deliverRunKey` stopped being
   * called at all. The failure-path siblings further down already do this; the
   * success-path ones did not.
   */
  function captureKeyDelivery(): () => string {
    let echoed = "";
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      // The FIRST stdin-carrying exec only. `fillRun` writes `pipeline.yaml` and
      // `run-context.json` over stdin too and runs after the key delivery, so
      // last-one-wins captured a manifest write and the control failed on a
      // dispatch that had delivered the key perfectly well. Step order is
      // mint → deliver → fill (INV-1, asserted by the ordering test above).
      if (stdin !== undefined && echoed === "") echoed = `exec: ${argv.join(" ")} <<<${stdin}`;
      return realExec(vm, argv, stdin);
    };
    return () => echoed;
  }

  test("INV-4: no key material in log lines", async () => {
    const brief = validBrief();
    // The REAL `(name, limit)` signature, even where the values are unused: a
    // zero-arg stand-in lets the dispatcher pass nothing, pass the arguments in
    // the wrong order, or hand µ$ where USD belongs, and nothing here would
    // notice — leaving the µ$→USD conversion pinned by the AC9 test alone.
    const knownKey = "sk-or-known-key-material-12345";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "abc123",
      limitUsd: limit,
      usageUsd: 0,
    });
    const delivered = captureKeyDelivery();

    await dispatch(brief, deps());

    // Positive controls, BOTH required: `some(...)` on an EMPTY array is false,
    // so the absence proof means nothing unless lines were captured — and an
    // absence proof over a run where the plaintext never reached a sink's reach
    // is vacuous too (see `captureKeyDelivery`).
    expect(entries.length).toBeGreaterThan(0);
    expect(delivered()).toContain(knownKey);
    expect(entries.some((e) => JSON.stringify(e).includes("sk-or-known-key-material"))).toBeFalse();
  });

  test("INV-4: no key material in record write", async () => {
    const brief = validBrief();
    const knownKey = "sk-test-known-key-99999";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "deadbeef",
      limitUsd: limit,
      usageUsd: 0,
    });
    const delivered = captureKeyDelivery();

    const result = await dispatch(brief, deps());
    const record = store.get(result.runId);

    // Control: the plaintext really was in flight during this dispatch.
    expect(delivered()).toContain(knownKey);
    // keyHash present, plaintext absent
    expect(record.keyHash).toBe("deadbeef");
    expect(JSON.stringify(record)).not.toContain(knownKey);
  });

  test("INV-4: no key material in the dispatch ack", async () => {
    const brief = validBrief();
    const knownKey = "sk-test-ack-leak-4242";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "cafebabe",
      limitUsd: limit,
      usageUsd: 0,
    });
    const delivered = captureKeyDelivery();

    const result = await dispatch(brief, deps());

    // Control: the plaintext really was in flight during this dispatch.
    expect(delivered()).toContain(knownKey);
    // The ack is printed to stdout by the CLI. `toMatchObject` above ignores
    // extra keys, so a regression that hangs the plaintext off the ack would
    // leak it there undetected.
    expect(JSON.stringify(result)).not.toContain(knownKey);
    expect(result).not.toHaveProperty("key");
    expect(result).not.toHaveProperty("openrouterKey");
  });

  // ─── every exit is a refusal: no untyped throw reaches the CLI ───────────────────────

  test("an UNTYPED ledger failure refuses (exit 5) instead of escaping as a bare throw", async () => {
    // Not an OverBudgetError and not a CostLedgerError: a raw bun:sqlite
    // SQLITE_BUSY, an ENOENT/EACCES on the ledger file, a TypeError out of a
    // misconfigured ledgerFactory. These bypassed `refuse` entirely — no
    // dispatch-log entry (AC4 evidence), no structured line, no runId on the
    // payload, and a bare CLI exit 1 for what the module documents as an
    // admission refusal.
    const sqliteBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

    try {
      await dispatch(
        validBrief(),
        deps({
          ledgerFactory: () => {
            throw sqliteBusy;
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      // The FLEET code stays fixed; the provider's errno rides the payload, so
      // `admission-failed` remains greppable across every substrate failure.
      expect(err.code).toBe("admission-failed");
      expect(err.payload?.providerCode).toBe("SQLITE_BUSY");
      // The run id this dispatch settled on in step 4, in full — `toBe(itself)`
      // was satisfied by `undefined === undefined`, so the payload carrying NO
      // id at all (the very thing this line exists to pin, since the structured
      // line joins on it) passed. The refusal fires from step 5, after the id is
      // chosen and before anything is provisioned.
      expect(err.payload?.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      // Pre-provision, so no commands: nothing exists for the operator to tear
      // down, and `refuse` gates those on `ctxProvisionAttempted`, not on "an id
      // was chosen".
      expect(err.payload).not.toHaveProperty("teardownCommand");
      expect(err.payload).not.toHaveProperty("debugCommands");
      // The structured line joins on the same id.
      expect((refusalLines()[0] as LogEntry).runId).toBe(err.payload?.runId as string);
      expect(refusalLines()).toHaveLength(1);
    }
    // INV-2: the refusal fired before any provisioning.
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a headroom load failure refuses (exit 5) instead of escaping as a bare throw", async () => {
    // In production the trigger is `checkHeadroom`'s default parameter,
    // `limits = loadQuotaLimits()`, which throws QuotaLimitsError for malformed
    // JSON / an unknown key / a non-positive value / EACCES — and the CLI never
    // passes deps.quotaLimits. That path needs a process-global
    // ($QDS_QUOTA_LIMITS_FILE), so the same throw is provoked through the
    // injectable half: a malformed LoadedQuotaLimits. Either way the call sat
    // in no try/catch at all.
    try {
      await dispatch(
        validBrief(),
        deps({ quotaLimits: {} as unknown as LoadedQuotaLimits }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("headroom-failed");
      expect(refusalLines()).toHaveLength(1);
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-4: a driver that echoes the delivered key in its error never lands it in a sink", async () => {
    // The ordinary way an exec wrapper reports a failure is to include the
    // command it ran — and `deliverRunKey` hands the plaintext key to
    // `driver.exec`. That message used to be interpolated into `dispatch failed
    // after the box was created: …`, which reaches the dispatch log, the
    // structured line AND the returned FleetError; `redactUrls` only matches
    // `https?://…`, so a bare token survived every one of them.
    // The real OpenRouter shape, so the assertions below also cover the
    // `sk-or-v1-` PREFIX: a redactor that trimmed the random tail and left the
    // issuer prefix would still tell an attacker which vault to try.
    const knownKey = "sk-or-v1-leakydeliverykey31337";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "beefbeef",
      limitUsd: limit,
      usageUsd: 0,
    });
    // Built from the ARGUMENTS, not hand-spelled: `deliverRunKey` deliberately
    // keeps the key out of argv and puts it on STDIN
    // (src/providers/credentials.ts:363 — `deliverScript(envFile)` takes only
    // the env-file path), so a fake that echoes argv alone carries no key at
    // all and this whole test passes with the redaction switched off. Echoing
    // the whole invocation is what a real exec wrapper does when it reports a
    // failed command, and it is the only shape that puts the key in reach of
    // the sink.
    let echoed = "";
    driver.exec = async (_vm: string, argv: string[], stdin?: string) => {
      echoed = `exec failed: ${argv.join(" ")} <<<${stdin ?? ""}`;
      throw new Error(echoed);
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("key-delivery-failed");
      // The whole envelope, not just the message: remediation and payload are
      // operator-facing sinks too.
      const envelope = JSON.stringify({ m: err.message, r: err.remediation, p: err.payload });
      expect(envelope).not.toContain(knownKey);
      expect(envelope).not.toContain("sk-or-v1-");
    }
    // POSITIVE CONTROL on the fake itself. Every assertion below is an ABSENCE
    // proof, and an absence proof over a message that never carried the key is
    // vacuous — it would stay green with the redaction deleted. This is the one
    // assertion here that fails if `deliverRunKey` stops handing the plaintext
    // to `driver.exec`, at which point these tests need rewriting rather than
    // quietly congratulating themselves.
    expect(echoed).toContain(knownKey);

    // ── the FLEET-side half, kept distinct from the providers-side half below
    // so a regression in either is attributable to one module.
    //
    // Dispatch's OWN sinks: its structured lines and the host-side dispatch log
    // (AC4 evidence). Positive control first — `some` on an empty array is
    // false, so the absence proof is worthless without lines to search.
    const own = entries.filter((e) => e.operation === "fleet.dispatch");
    expect(own.length).toBeGreaterThan(0);
    const ownText = JSON.stringify(own);
    expect(ownText).not.toContain(knownKey);
    expect(ownText).not.toContain("sk-or-v1-");
    const dispatchLog = readFileSync(join(dir, "dispatch-log.jsonl"), "utf8");
    expect(dispatchLog).not.toContain(knownKey);
    expect(dispatchLog).not.toContain("sk-or-v1-");

    // ── the PROVIDERS-side half: NO sink may carry the plaintext, whichever
    // module owns it. `deliverRunKey` logs through credentials.ts's own `timed`
    // (src/providers/credentials.ts:175), which is a different helper from
    // `step-log.ts`'s `timedLoggedStep` — both now apply `redactSecrets`, and
    // this asserts across every operation so a third logging helper cannot
    // appear without one.
    //
    // An equality on the whole leaking SET rather than a `some(...)`: the
    // failure message then names the operation that leaked, which is the one
    // thing the operator needs and a boolean throws away.
    const leaking = entries.filter((e) => JSON.stringify(e).includes(knownKey)).map((e) => e.operation);
    expect(leaking).toEqual([]);
  });

  test("an expired ceiling provisions NOTHING — the step is never started", async () => {
    // `within` used to take a PROMISE, so every call site evaluated its argument
    // eagerly: `provisionAdmittedRun(…)` was already in flight when the deadline
    // was checked, the record and the box were created and billed anyway, and
    // the refusal carried no vmName because `ctxVmName` was never assigned.
    const { clock, advance } = stepClock();

    try {
      await dispatch(
        validBrief(),
        deps({
          clock,
          // The last seam before the create step — the ceiling is exhausted
          // between admission and provisioning.
          ledgerFactory: () => {
            advance(DEFAULT_TIMEOUT_MS + 1_000);
            return goodLedger();
          },
        }),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("create");
      expect(err.payload).not.toHaveProperty("vmName");
    }
    // The point of the fix: an abandoned create still made a record and a box.
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("INV-4-bis: a malformed deps.requestId refuses (exit 2) rather than being silently re-minted", async () => {
    // The CLI builds the run-record store and the driver with the id it
    // resolved, then hands it back here. Dropped silently, a malformed one made
    // the resolver mint a FRESH id, so the record's and the driver's log lines
    // carried a different correlation id from the ack — the exact cross-layer
    // split INV-4-bis exists to prevent, with no error anywhere.
    try {
      await dispatch(validBrief(), deps({ requestId: "not-a-uuid" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-request-id");
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    // The evidence trail every OTHER pre-provision refusal in this file asserts,
    // and this one did not: a refusal that files no structured line and no
    // dispatch-log entry is invisible to AC4's evidence, however correct its
    // exit code. The correlation id is the thing that failed to resolve, so the
    // line names it as unresolved rather than fabricating one.
    const refusals = refusalLines();
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as LogEntry).requestId).toBe("unresolved");
    expect((refusals[0] as LogEntry).runId).toBeNull();
    const logged = readFileSync(join(dir, "dispatch-log.jsonl"), "utf8").trim().split("\n");
    expect(logged).toHaveLength(1);
    expect((JSON.parse(logged[0] as string) as { code: string }).code).toBe("invalid-request-id");
  });

  test("INV-6: a SHORT secret path segment is redacted from the whole refusal envelope", async () => {
    // The rule was length-based (`/\\/[^/]{16,}/`), so an 11-character token in
    // a URL path reached the dispatch log, the structured line and the
    // FleetError intact — length is not a property of a secret. `remediation`
    // was not redacted at all, only `message`.
    const token = "abc123token";
    let thrown = "";
    driver.create = async () => {
      thrown = `create failed: https://exe.xyz/vm/${token}`;
      throw Object.assign(new Error(thrown), {
        code: "ECONNRESET",
        remediation: `retry against https://exe.xyz/vm/${token}`,
      });
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.payload?.providerCode).toBe("ECONNRESET");
      expect(err.message).not.toContain(token);
      expect(err.remediation).not.toContain(token);
      // The host survives — an operator has to be able to tell which substrate
      // the line is about.
      expect(err.message).toContain("https://exe.xyz");
    }
    // POSITIVE CONTROL, the same one the INV-4 siblings carry: every assertion
    // here is an absence proof, and an absence proof over a run where the token
    // never reached a sink's reach — or where no line was emitted at all — is
    // vacuous and stays green with the redaction deleted.
    expect(thrown).toContain(token);
    expect(entries.length).toBeGreaterThan(0);
    // The SAME sink set as the INV-4 sibling, not a narrower one: the structured
    // lines AND the persisted dispatch log (AC4 evidence), which is the copy
    // that outlives the process.
    expect(entries.filter((e) => JSON.stringify(e).includes(token)).map((e) => e.operation)).toEqual([]);
    expect(readFileSync(join(dir, "dispatch-log.jsonl"), "utf8")).not.toContain(token);
  });

  test("C7: an author-supplied limitMicroUsd never reaches the box — the admitted ceiling does", async () => {
    // AC9a makes the manifest the cap's ONLY in-box carrier, so a hand-authored
    // ceiling in the source manifest is an attempt to name the number the budget
    // gate is supposed to name. Stripped at dispatch's host-side read, not in
    // `loadManifest` — the runner reads the already-stamped manifest back
    // through that same loader and must keep the stamp.
    const authored = 999_000_000;
    const manifestRel = join("manifests", "authored-limit.json");
    mkdirSync(join(dir, "manifests"), { recursive: true });
    writeFileSync(
      join(dir, manifestRel),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "test-pipeline",
        runBudgetMs: 200_000,
        limitMicroUsd: authored,
        phases: [
          { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
        ],
      }),
    );

    const admittedCeiling = 250_000;
    const result = await dispatch(
      { ...validBrief(), manifestPath: manifestRel },
      deps({ ledgerFactory: () => goodLedger(admittedCeiling) }),
    );

    const delivered = await driver.exec(result.vmName, ["sh", "-c", "cat pipeline.yaml"]);
    expect(JSON.parse(delivered.stdout).limitMicroUsd).toBe(admittedCeiling);

    // The other half, and the one the assertion above cannot make: that the
    // authored number went NOWHERE. `limitMicroUsd` is the field the strip
    // targets, so a strip that only overwrote that one key — while the authored
    // figure reached the box by another carrier (`run-context.json`'s
    // `effectiveCeilingMicros`, DF1.6's spawn seam), reached the ledger's record
    // of what this run may spend, or reached a log line an operator reads as the
    // run's ceiling — passes the delivered-manifest check outright.
    const boxManifest = delivered.stdout;
    const ctx = await driver.exec(result.vmName, ["sh", "-c", "cat run-context.json"]);
    expect((JSON.parse(ctx.stdout) as { effectiveCeilingMicros: number }).effectiveCeilingMicros).toBe(
      admittedCeiling,
    );
    const record = store.get(result.runId);
    expect(record.extensions?.budget?.admittedCeilingMicroUsd).toBe(admittedCeiling);
    // Every sink at once, as TEXT: a carrier this test did not think to name is
    // still caught, and the failure message shows which one held it.
    for (const [label, text] of [
      ["pipeline.yaml", boxManifest],
      ["run-context.json", ctx.stdout],
      ["the run record", JSON.stringify(record)],
      ["the structured log", JSON.stringify(entries)],
      ["the ack", JSON.stringify(result)],
    ] as const) {
      expect(`${label}: ${text}`).not.toContain(String(authored));
    }
  });

  test("INV-4: an ABANDONED deliver that echoes the key never lands it on the abandoned-step line", async () => {
    // The sibling test above covers the RACE-WON path, where `deliverRunKey`'s
    // rejection reaches dispatch and the fixed-message catch swallows the text.
    // This is the other half: when the wall clock wins, the race has already
    // rejected with the timeout, so that catch never sees the provider error at
    // all — `within`'s abandoned handler does, and it logged the raw message
    // through `redactUrls`, which only matches `https?://…`. A bare token went
    // straight into the structured log.
    const knownKey = "sk-or-v1-abandonedleakykey31337";
    keyApi.createKey = async (_name: string, limit: number) => ({
      key: knownKey,
      hash: "beefbeef",
      limitUsd: limit,
      usageUsd: 0,
    });

    // Which STEP expires is pinned by the injected clock rather than by racing
    // real timers: the budget is spent inside `createKey`, i.e. during `mint`,
    // whose own timer was already armed with the full ceiling. `deliver` is then
    // the first step to compute a near-zero remainder — deterministically, and
    // without every earlier step running against a hair-trigger deadline.
    const { clock, advance } = stepClock();
    const mintKey = keyApi.createKey.bind(keyApi);
    keyApi.createKey = async (name: string, limit: number) => {
      advance(DEFAULT_TIMEOUT_MS - 30);
      return mintKey(name, limit);
    };

    // `deliverRunKey` is the ONLY exec that carries stdin (credentials.ts:371),
    // and the key rides on stdin rather than argv — so this echoes the whole
    // invocation, which is what a real exec wrapper reports on a failure and the
    // only shape that puts the key within reach of a sink.
    // GATED, not slept. A 250 ms exec racing a 30 ms remainder and then a fixed
    // 400 ms drain made this test a scheduling bet: under load the exec could
    // lose, and the failure surfaced as a REDACTION regression when it was a
    // timing one. The delivery now blocks until the test itself releases it,
    // which it does only after `dispatch` has already refused — so the race is
    // ABANDONED first by construction, at any load, and this rejection lands on
    // the abandoned handler with no other subscriber.
    let echoed = "";
    let releaseDeliver: () => void = () => {};
    const delivering = new Promise<void>((r) => {
      releaseDeliver = r;
    });
    const realExec = driver.exec.bind(driver);
    driver.exec = async (vm: string, argv: string[], stdin?: string) => {
      if (stdin === undefined) return realExec(vm, argv, stdin);
      echoed = `exec failed: ${argv.join(" ")} <<<${stdin}`;
      await delivering;
      throw new Error(echoed);
    };

    try {
      await dispatch(validBrief(), deps({ clock }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("deliver");
    }
    // Only NOW does the abandoned call fail. The handler fires on the abandoned
    // promise, one microtask chain later; awaited off the SINK, not off a tick
    // budget — see `awaitEntry` for why 50 `setTimeout(0)` ticks were a bet the
    // test could lose under load, and lose while reporting a redaction fault.
    releaseDeliver();
    const line = await abandonedLine("deliver");

    // POSITIVE CONTROLS, both required: an absence proof over a line that was
    // never emitted, or over a message that never carried the key, is vacuous —
    // it stays green with the redaction deleted.
    expect(echoed).toContain(knownKey);
    // The FAILURE arm of the handler, named: the abandoned call rejected, which
    // is a different line (and a different code) from an abandoned call that
    // completed — and it is the one that carries the provider's free text.
    expect((line.error as { code?: string }).code).toBe("abandoned-step-failed");
    expect(line.exitStatus).toBe("transient");

    const text = JSON.stringify(line);
    expect(text).not.toContain(knownKey);
    expect(text).not.toContain("sk-or-v1-");
    // And no other sink either — the handler is not the only line in flight.
    expect(entries.filter((e) => JSON.stringify(e).includes(knownKey)).map((e) => e.operation)).toEqual([]);
  });

  test("an ABANDONED mint names the KEY it left live — hash and cap, never the plaintext", async () => {
    // `within`'s abandoned-success handler used to duck-type on `value.vm`,
    // which only the `create` step resolves — so the two other steps whose late
    // success is expensive logged a line identifying NOTHING. A `mint` that
    // lands after the refusal is a live provider key at the full admitted
    // ceiling, and its `hash` is the only handle anyone has to revoke it; the
    // refusal has already gone out naming nothing about it, so this line is the
    // only pointer that exists until the record write catches up.
    const admittedCeiling = 12_000_000;
    const { clock, advance } = stepClock();
    // The mint step's deadline is what has to expire, and it is armed with what
    // is LEFT when the step starts — so the budget is spent inside `create`,
    // whose own timer was armed with the full ceiling before it ran. Nothing
    // races a real clock: 200 ms is the whole of the mint step's budget, by
    // construction and at any load.
    const realCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      const vm = await realCreate(name, tag);
      advance(DEFAULT_TIMEOUT_MS - 200);
      return vm;
    };
    const knownKey = "sk-or-v1-abandonedmintkey31337";
    let releaseMint: () => void = () => {};
    const minting = new Promise<void>((r) => {
      releaseMint = r;
    });
    keyApi.createKey = async (_name: string, limitUsd: number) => {
      // GATED, not slept: the mint completes only once the test releases it,
      // which it does after `dispatch` has already refused — so the call is
      // ABANDONED first by construction and the handler is its only subscriber.
      await minting;
      return { key: knownKey, hash: "d00dfeed", limitUsd, usageUsd: 0 };
    };

    try {
      await dispatch(validBrief(), deps({ clock, ledgerFactory: () => goodLedger(admittedCeiling) }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("dispatch-timeout");
      expect(err.payload?.step).toBe("mint");
      // The remediation is step-aware for the same reason this line is: the
      // operator has to be told a key may go live AFTER the refusal.
      expect(err.remediation).toContain("keyHash");
    }

    releaseMint();
    const line = await abandonedLine("mint");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    // What IDENTIFIES the key: the provider-side handle, and what it may spend.
    expect(line.keyHash).toBe("d00dfeed");
    expect(line.capMicroUsd).toBe(admittedCeiling);
    // INV-4: the hash, never the plaintext — this is a log sink.
    expect(JSON.stringify(line)).not.toContain(knownKey);
    expect(JSON.stringify(line)).not.toContain("sk-or-v1-");
  });

  test("an ABANDONED setPublic names the BOX it may have published", async () => {
    // The other duck-typed casualty: `setPublic` resolves `void`, so a late one
    // logged a line saying a step completed and nothing about WHICH box just
    // became publicly reachable — after the operator was told the dispatch
    // failed and has no reason to believe anything went public at all.
    const { clock, advance } = stepClock();
    let releasePublic: () => void = () => {};
    const publishing = new Promise<void>((r) => {
      releasePublic = r;
    });
    driver.setPublic = async () => {
      await publishing;
    };

    let err: FleetError | undefined;
    try {
      await dispatch(
        validBrief(),
        deps({
          clock,
          port: 8080,
          setupGate: async (drv, vm, o) => {
            const gate = await fakeGate(drv, vm, o);
            // Leaves 250 ms for everything after the gate: the post-gate
            // re-sample passes, `expose` (a local call) resolves, and
            // `setPublic` is the step the deadline lands on.
            advance(DEFAULT_TIMEOUT_MS - 250);
            return gate;
          },
        }),
      );
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect((err as FleetError).code).toBe("dispatch-timeout");
    expect((err as FleetError).payload?.step).toBe("setPublic");
    expect((err as FleetError).remediation).toContain("PUBLICLY REACHABLE");
    const runId = (err as FleetError).payload?.runId as string;

    // The port claim is KEPT on the abandon path — an expose that already
    // landed is real, and a record claiming no port would under-report a live
    // public box to `fleet status` and to every port-keyed reaper.
    expect(store.get(runId).ports).toEqual([8080]);

    releasePublic();
    const line = await abandonedLine("setPublic");
    expect((line.error as { code?: string }).code).toBe("abandoned-step-succeeded");
    expect(line.vmName).toBe(store.get(runId).vmName);
    expect(line.publiclyReachable).toBeTrue();
  });

  test("a create that TIMES OUT still leaves the correlation id on the record", async () => {
    // `store.create` takes only an id, so the correlation could only be written
    // after `provisionAdmittedRun` RETURNED — and on this path it never does.
    // The record survived with a `requestId` of nothing at all: `fleet status`
    // shows an open run that joins to no log line anywhere, forever, which is
    // exactly the run (one that died mid-provisioning) whose lines an operator
    // needs. `stampCorrelation` runs from the create step's own failure path.
    const requestId = "1f2e3d4c-5b6a-4798-8899-aabbccddeeff";
    const { clock, advance } = stepClock();
    let releaseCreate: () => void = () => {};
    const creating = new Promise<void>((r) => {
      releaseCreate = r;
    });
    const realCreate = driver.create.bind(driver);
    driver.create = async (name: string, tag?: string) => {
      await creating;
      return realCreate(name, tag);
    };

    let err: FleetError | undefined;
    try {
      await dispatch(
        validBrief({ requestId }),
        deps({
          clock,
          // The last seam before the create step: 200 ms is the whole of that
          // step's budget, and `store.create` (INV-1's first half) has already
          // written the record by the time it expires.
          ledgerFactory: () => {
            advance(DEFAULT_TIMEOUT_MS - 200);
            return goodLedger();
          },
        }),
      );
    } catch (e) {
      err = e as FleetError;
    }
    expect(err).toBeInstanceOf(FleetError);
    expect((err as FleetError).code).toBe("dispatch-timeout");
    expect((err as FleetError).payload?.step).toBe("create");
    const runId = (err as FleetError).payload?.runId as string;

    // The record exists (the create STARTED — this is not the `left <= 0`
    // pre-check path) and it is joinable.
    expect(readdirSync(store.dir)).toEqual([`${runId}.json`]);
    expect(store.get(runId).requestId).toBe(requestId);
    // The box is still in flight, so the record cannot name one yet — which is
    // precisely why the correlation had to land without waiting for it.
    expect(store.get(runId).vmName).toBeUndefined();

    // Let the abandoned create finish, so nothing is left running into the next
    // test — and the late box gets named on the record and on the line.
    releaseCreate();
    const line = await abandonedLine("create");
    expect(line.vmName).toBe(store.get(runId).vmName);
    expect(store.get(runId).requestId).toBe(requestId);
  });

  test("INV-6: a long host label is redacted without mangling the URL, and userinfo never survives", async () => {
    // The host arm sliced the string: `/[^/]{16,}/` matched the `//host` run
    // itself, so `https://abcdefghijklmnopq` came out as `https:/«redacted»` —
    // a malformed single-slash URL, losing the stated guarantee that the scheme
    // and host survive so an operator can tell WHICH box the line is about.
    // Conversely `tok@x.io` is one short segment, so userinfo passed the 16-char
    // floor untouched — and length is not a property of a credential.
    driver.create = async () => {
      throw new Error(
        "create failed: https://abcdefghijklmnopq/vm and https://tok@short.io/vm",
      );
    };

    try {
      await dispatch(validBrief(), deps());
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("provision-failed");
      expect(err.message).not.toContain("abcdefghijklmnopq");
      expect(err.message).not.toContain("tok@");
      // Not mangled into `https:/…`: the scheme keeps both its slashes.
      expect(err.message).not.toContain("https:/«");
      expect(err.message).toContain("https://«redacted»");
      // The host an operator can act on survives; the path does not.
      expect(err.message).toContain("https://short.io");
      expect(err.message).not.toContain("short.io/vm");
    }
  });

  // ─── assertFleetRunId: the one refusal built without `refuse` ────────────────────────

  test("INV-6: a too-long run id is echoed BOUNDED, not swallowed whole by the redactor", async () => {
    // `assertFleetRunId` is the fleet's single enforcement point for the run-id
    // grammar (`scripts/fleet.ts`'s verbs and `statusRun` both route through
    // it), and the ONE refusal in the module built directly rather than through
    // `refuse` — so `refuse`'s INV-6 pass never ran over it and the store's
    // message echoes raw argv.
    //
    // Composing `redact` over that message closes the leak and opens a
    // usability hole in the same move: `redactSecrets` eats any ≥40-char run
    // that is not a hex digest, so a fat-fingered 96-character argument came
    // back as `invalid run id: "«redacted»" (must match …)` — correct, and
    // unactionable. The bounded suffix is what makes it answerable: a short
    // HEAD (12 chars, under the redactor's 40-char floor) plus the LENGTH
    // answers "which argument did I get wrong" and reconstructs no key.
    const supplied = "Q".repeat(96);
    try {
      assertFleetRunId(supplied);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FleetError);
      const err = e as FleetError;
      expect(err.exitCode).toBe(2);
      expect(err.code).toBe("invalid-run-id");
      // The WHOLE message, exactly: the store's own grammar and cap, the
      // redacted echo, and the bounded suffix appended after it. Asserted in
      // full because each half has failed on its own — an unredacted echo, then
      // a redaction that ate the entire diagnosis.
      expect(err.message).toBe(
        `invalid run id: "«redacted»" (must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ and be <= 63 chars) — supplied: "${"Q".repeat(12)}…" (96 chars)`,
      );
      // Bounded means bounded: no copy of the 96-character argument survives
      // anywhere in the refusal.
      expect(err.message).not.toContain(supplied);
      expect(JSON.stringify(err.payload ?? {})).not.toContain(supplied);
    }
  });

  test("INV-6: a management URL in the run-id position is redacted, path and all", async () => {
    // The path this refusal used to bypass entirely. An operator who pastes a
    // provisioning/management URL into the run-id argument had it echoed to
    // stderr and into the dispatch log with its path intact — and
    // `redactSecrets` alone does not carry the whole-segment URL rule, so only
    // composing `redact` catches it. The 32-char tail is under nothing's length
    // floor as a path segment; length is not a property of a secret.
    const url = `https://mgmt.example.com/keys/${"a".repeat(32)}`;
    try {
      assertFleetRunId(url);
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.code).toBe("invalid-run-id");
      // Scheme and host survive — an operator has to know which substrate they
      // pasted — and EVERY path segment goes, not just the long one.
      expect(err.message).toContain("https://mgmt.example.com/«redacted»/«redacted»");
      expect(err.message).not.toContain("keys");
      expect(err.message).not.toContain("a".repeat(32));
    }
  });

  test("a pre-provision refusal names NO teardown command — nothing was provisioned", async () => {
    // The remediation was gated on `ctxRunId !== null`, which is set inside the
    // mint-collision loop — before the admission gates and before store.create.
    // Every refusal from step 4 on therefore handed a tier-1 agent
    // `fleet teardown <id>` for an id with no record.
    try {
      await dispatch(validBrief(), deps({ ledgerFactory: () => overBudgetLedger() }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.exitCode).toBe(5);
      expect(err.code).toBe("budget-exceeded");
      // The id is still reported — it is this dispatch's own, and the log line
      // joins on it. The COMMANDS are what must not be there.
      //
      // The minted SHAPE, not `toBeString()`: `""`, `"unknown"` and the last
      // COLLIDING id from the mint loop (which belongs to someone else's live
      // run) are all strings, and the structured line joins on this value.
      expect(err.payload?.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      // The same id the structured line carries — one refusal, one id.
      expect((refusalLines()[0] as LogEntry).runId).toBe(err.payload?.runId as string);
      expect(err.payload).not.toHaveProperty("teardownCommand");
      expect(err.payload).not.toHaveProperty("debugCommands");
    }
    expect(readdirSync(store.dir)).toHaveLength(0);
    expect(await driver.list()).toHaveLength(0);
  });

  test("a box is never made public when expose established no URL", async () => {
    // The URL was written to the record AFTER setPublic, and setPublic ran
    // whatever expose returned: a driver that resolved no URL still got its box
    // published, leaving it publicly reachable with nothing on the record saying
    // where. The `ports` claim two lines above already pre-claims for exactly
    // this reason; the URL write was the one state claim still made after the
    // call it describes.
    let setPublicCalls = 0;
    driver.expose = async () => undefined as unknown as string;
    driver.setPublic = async () => {
      setPublicCalls += 1;
    };

    try {
      await dispatch(validBrief(), deps({ port: 8080 }));
      expect.unreachable();
    } catch (e) {
      const err = e as FleetError;
      expect(err.exitCode).toBe(1);
      expect(err.code).toBe("expose-no-url");
      expect(err.payload?.port).toBe(8080);
      // INV-5: the box is alive and the record open, so the refusal carries the
      // operator's commands — for THIS run. `toBeString()` was satisfied by a
      // command naming a different run's id, and a tier-1 agent runs what this
      // field says: it would tear down someone else's live box and leave this
      // one billing.
      const runId = err.payload?.runId as string;
      expect(runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      expect(err.payload?.teardownCommand).toBe(`bun scripts/fleet.ts teardown ${runId}`);
      expect(err.payload?.debugCommands).toEqual([`bun scripts/fleet.ts status ${runId}`]);
    }
    expect(setPublicCalls).toBe(0);
    // The port claim landed before the provider calls and is RETRACTED by this
    // refusal: nothing is in flight (expose resolved, it just resolved nothing),
    // so a record still advertising 8080 would contradict the refusal's own
    // "ALIVE but NOT public" and hand port-keyed reapers a port the box does not
    // have. The URL never lands either, because none was ever established.
    const files = readdirSync(store.dir);
    expect(files).toHaveLength(1);
    const record = store.get((files[0] as string).replace(/\.json$/, ""));
    expect(record.ports).toEqual([]);
    expect(record.httpsUrl).toBeUndefined();
  });
});
