/**
 * tests/p0-9/legs.test.ts — driver↔test contract for the six P0.9 leg
 * drivers (story M1.1 dev-half) + the shared leg-lib harness.
 *
 * ACTIVATION GATING: every driver block is `test.skipIf(!existsSync(<driver
 * path>))` — computed relative to this file (tests/p0-9/../scripts/p0-9/).
 * While a driver file is absent its whole block is SKIPPED (suite stays
 * green); the moment the file lands, the block activates and the driver must
 * make it green via filtered runs (`bun test tests/p0-9/legs.test.ts -t
 * "<block>"`). Integration asserts zero skips. No static driver imports —
 * drivers are loaded with dynamic `import()` INSIDE the tests, so a missing
 * module never breaks collection (this also pins the drivers'
 * import-safety: an `import.meta.main` guard, no top-level side effects).
 *
 * CONTRACT PINNED HERE (driver authors: these are the assertions to satisfy):
 *   - Driver shape: thin `main()` (env read via requireBaseUrl → runLeg →
 *     writeLegEvidence → process.exitCode under import.meta.main guard) +
 *     exported pure `runLeg(deps): Promise<LegEvidence>`.
 *   - runLeg RESOLVES to LegEvidence for every leg-level outcome, including
 *     fatal refusals (exitCode 2); it never network-touches unless the
 *     collaborator is injected via deps (fetchImpl / client / provisionImpl /
 *     retainImpl / authHeader). Tests never monkeypatch and never hit the
 *     network.
 *   - Exit path: ok:true ⇔ exitCode 0; ok:false ⇔ exitCode 1 (leg failure)
 *     or 2 (fatal refusal) — never a silently-green failed leg.
 *   - Round-trip step vocabulary = the verifier's own:
 *     retain | recall | reflect | consolidate | post_consolidate_recall.
 *   - Leg-specific evidence extensions asserted below: hindsight-live →
 *     `rawRetainBody`/`rawRecallBody` (verbatim pre-schema strings) +
 *     `probeBankId`; provision-and-import + idempotency-rerun →
 *     `createdInAttempt: string[]` (R3-005: the CLAIM set, not the raw diff),
 *     `unclaimedCreated: string[]` (diff banks NOT attributable — probe/
 *     manual/foreign, recorded and LEFT IN PLACE), `residue: string[]` +
 *     `deleteOutcomes: Record<bankId, outcome>` (provision + idempotency
 *     rollback paths), `rosters: {pre,post}` (idempotency), `mintRecord:
 *     Record<bankId, {resolvedFrom, documentIds}>` (provision);
 *     round-trip-dedicated → `roundTrip` (RoundTripOk-shaped);
 *     negative-probes → `refusals: Array<{name, class}>`;
 *     auth-retired-check → `authOutcomes:
 *     {unauthenticated, knownKeyOutOfScope, unknownKey}`,
 *     `measuredCount: number`, `dangerRetired: boolean` (R3-013: requires the
 *     RETAIN write leg specifically refused-auth),
 *     `containmentStatement: string`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  acquireHeartbeatLock,
  assertQdsRepoSlug,
  forbiddenOrigin,
  LEG_LOCK_STALE_MS,
  legLog,
  LIVE_EVIDENCE_DIR,
  maskTail,
  rerunAwareProvision,
  requireBaseUrl,
  resolveEvidenceDir,
  resolveRepoSlug,
  rosterPatternClaim,
  sanitizeOrigin,
  scanLiveShapePrereq,
  writeLegEvidence,
  type LegEvidence,
  type LegMode,
} from "../../scripts/p0-9/leg-lib.ts";
import { acquireFileLock } from "../../src/lib/file-lock.ts";
import { HindsightHttpError } from "../../src/hindsight/index.ts";
import { COLLECTIVE_BANK_ID, type ProvisionClient } from "../../src/hindsight/bank-provisioner.ts";
import { dedupHash } from "../../src/hindsight/mulch-importer.ts";

// ---------------------------------------------------------------------------
// Driver activation gating (skipIf idiom)
// ---------------------------------------------------------------------------

const DRIVER_DIR = join(import.meta.dir, "..", "..", "scripts", "p0-9");

function driverFile(name: string): string {
  return join(DRIVER_DIR, `${name}.ts`);
}

function hasDriver(name: string): boolean {
  return existsSync(driverFile(name));
}

/** Minimal structural type for a driver's exported pure entrypoint. */
type RunLeg = (deps: Record<string, unknown>) => Promise<LegEvidence>;

async function loadDriver(name: string): Promise<RunLeg> {
  const mod = (await import(driverFile(name))) as { runLeg?: RunLeg };
  if (typeof mod.runLeg !== "function") {
    throw new Error(
      `driver scripts/p0-9/${name}.ts must export runLeg(deps): Promise<LegEvidence>`,
    );
  }
  return mod.runLeg;
}

// ---------------------------------------------------------------------------
// Shared fixtures (house style: fake collaborators, tmpdirs, no network)
// ---------------------------------------------------------------------------

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "p0-9-legs-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** The closure-plan evidence payload contract every driver must emit. */
function assertEvidenceContract(e: LegEvidence): void {
  expect(typeof e.leg).toBe("string");
  expect(e.leg.length).toBeGreaterThan(0);
  expect(["live", "mock"]).toContain(e.mode);
  expect(typeof e.ok).toBe("boolean");
  expect(typeof e.outcome).toBe("string");
  expect(Array.isArray(e.steps)).toBe(true);
  for (const s of e.steps) {
    expect(typeof s.step).toBe("string");
    expect(typeof s.outcome).toBe("string");
  }
  expect(typeof e.origin).toBe("string");
  expect(typeof e.exitCode).toBe("number");
  expect(typeof e.stdoutTail).toBe("string");
  expect(typeof e.stderrTail).toBe("string");
  expect(typeof e.writtenAt).toBe("string");
  expect(Number.isNaN(Date.parse(e.writtenAt))).toBe(false);
  // Exit path: 0 pass / 1 leg-fail / 2 fatal refusal — never green-on-fail.
  if (e.ok) expect(e.exitCode).toBe(0);
  else expect([1, 2]).toContain(e.exitCode);
}

function baseEvidence(leg: string, mode: LegMode): LegEvidence {
  return {
    leg,
    mode,
    ok: true,
    outcome: "pass",
    steps: [],
    origin: "http://127.0.0.1:18890",
    exitCode: 0,
    stdoutTail: "",
    stderrTail: "",
    writtenAt: new Date().toISOString(),
  };
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ServedCall {
  call: FetchCall;
  status: number;
}

interface FetchRoute {
  match: (c: FetchCall) => boolean;
  respond: (c: FetchCall) => Response;
}

function headerMap(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(h)) {
    for (const pair of h as Array<[string, string]>) {
      out[pair[0].toLowerCase()] = String(pair[1]);
    }
  } else if (h !== null && h !== undefined && typeof h === "object") {
    for (const [k, v] of Object.entries(h)) {
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

/**
 * A scriptable fake `fetch`: routes calls, records every served
 * {call, status}. A route whose respond() throws rejects the fetch (the
 * transport-failure class) and records nothing — a failed call is not a
 * served one.
 */
function makeFetchRouter(routes: FetchRoute[], served: ServedCall[]): typeof fetch {
  return (async (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: headerMap(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    for (const r of routes) {
      if (r.match(call)) {
        const res = r.respond(call);
        served.push({ call, status: res.status });
        return res;
      }
    }
    const fallback = new Response(JSON.stringify({ error: "no route" }), { status: 599 });
    served.push({ call, status: fallback.status });
    return fallback;
  }) as typeof fetch;
}

/** Fake HindsightClient for provision-family drivers (stateful bank set = the honest diff source). */
function makeProvisionClient(
  cfg: { existing?: string[]; createFailsOn?: string[]; deleteFailsOn?: string[]; requestThrows?: boolean } = {},
): {
  calls: {
    createBank: string[];
    deleteBank: string[];
    listBanks: string[][];
    request: Array<{ method: string; path: string; body?: unknown }>;
  };
  listBanks: () => Promise<{ banks: { bank_id: string }[] }>;
  createBank: (bankId: string) => Promise<unknown>;
  deleteBank: (bankId: string) => Promise<unknown>;
  request: (method: string, p: string, body?: unknown) => Promise<unknown>;
} & Record<string, unknown> {
  const banks = new Set(cfg.existing ?? []);
  const calls = {
    createBank: [] as string[],
    deleteBank: [] as string[],
    listBanks: [] as string[][],
    request: [] as Array<{ method: string; path: string; body?: unknown }>,
  };
  return {
    calls,
    listBanks: async () => {
      const snapshot = [...banks];
      calls.listBanks.push(snapshot);
      return { banks: snapshot.map((bank_id) => ({ bank_id })) };
    },
    createBank: async (bankId: string) => {
      calls.createBank.push(bankId);
      if (cfg.createFailsOn?.includes(bankId)) {
        throw new HindsightHttpError(500, `create boom ${bankId}`, "req-create");
      }
      banks.add(bankId);
      return { bank_id: bankId };
    },
    deleteBank: async (bankId: string) => {
      calls.deleteBank.push(bankId);
      if (cfg.deleteFailsOn?.includes(bankId)) {
        throw new HindsightHttpError(500, `delete boom ${bankId}`, "req-delete");
      }
      banks.delete(bankId);
      return { deleted: true, alreadyGone: false, bankId };
    },
    request: async (method: string, p: string, body?: unknown) => {
      calls.request.push({ method, path: p, body });
      if (cfg.requestThrows) throw new HindsightHttpError(500, "retain boom", "req-retain");
      return { success: true, bank_id: "qds-factory", items_count: 0 };
    },
  };
}

/**
 * R2-022/R3-017: the deterministic tmp corpus EVERY provision-and-import test
 * injects via deps.expertiseDir — the mint record is pinned against OUR
 * entries, never the repo's real .mulch/expertise contents
 * (checkout-independent pass/fail).
 */
const TMP_CORPUS = [
  { domain: "qds-test-mint-a", concepts: ["alpha", "beta"], expertise: "fixture expertise A" },
  { domain: "qds-test-mint-b", concepts: ["gamma"], expertise: "fixture expertise B" },
  { domain: "qds-test-mint-c", concepts: [], expertise: "fixture expertise C" },
];

function makeTmpCorpus(): string {
  const dir = join(tmpDir, "corpus");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.json"), `${JSON.stringify(TMP_CORPUS, null, 2)}\n`);
  return dir;
}

/**
 * R3-005 claim-scoped-compensation fixture: a fresh-lane provisionImpl whose
 * third roster create (the collective) fails after b1+b2 landed — and whose
 * FAILURE ENVELOPE still carries the per-bank statuses (created/created/
 * failed) the driver's claim derivation reads. Optionally also creates a
 * foreign probe-shaped bank mid-window (what hindsight-live /
 * auth-retired-check do WITHOUT holding the provision-family lock) — it must
 * land in the diff, stay UNCLAIMED, and never be deleted.
 */
function failingThirdCreateImpl(
  client: unknown,
  probeBank?: string,
): (opts: unknown) => Promise<unknown> {
  const create = (client as { createBank: (bankId: string) => Promise<unknown> }).createBank;
  return async () => {
    await create("qds-factory");
    await create("qds-factory-dev-meta");
    await create(COLLECTIVE_BANK_ID).catch(() => {});
    if (probeBank !== undefined) await create(probeBank).catch(() => {});
    return {
      ok: false,
      banks: [
        { bankId: "qds-factory", status: "created" },
        { bankId: "qds-factory-dev-meta", status: "created" },
        { bankId: COLLECTIVE_BANK_ID, status: "failed" },
      ],
      requestId: "req-r3-005-fixture",
    };
  };
}

/**
 * PR-review fixture: the REAL provisionBanks failure shape — the partial
 * roster is DROPPED (ProvisionErr: {ok:false, error, requestId}, no banks),
 * while the creates themselves landed as side effects visible to listBanks.
 * The roster-pattern fallback claim must compensate these without any
 * fixture-supplied statuses.
 */
function realShapePartialFailureImpl(client: unknown): (opts: unknown) => Promise<unknown> {
  const create = (client as { createBank: (bankId: string) => Promise<unknown> }).createBank;
  return async () => {
    await create("qds-factory");
    await create("qds-factory-dev-meta");
    return {
      ok: false,
      error: { code: -32005, message: "bank provisioning failed: create boom" },
      requestId: "req-real-shape",
    };
  };
}

/** PR-review fixture: fresh SUCCESS where the collective already existed (status "exists") — the mint roster must still cover all three banks. */
function freshWithPreexistingCollectiveImpl(): (opts: unknown) => Promise<unknown> {
  return async () => ({
    ok: true,
    banks: [
      { bankId: "qds-factory", status: "created" },
      { bankId: "qds-factory-dev-meta", status: "created" },
      { bankId: COLLECTIVE_BANK_ID, status: "exists" },
    ],
    requestId: "req-fresh-partial-preexisting",
  });
}

/** Fake client for negative-probes: recall scriptable, listBanks snapshots recorded. */
function makeListClient(
  cfg: { recallThrows?: Error } = {},
): { calls: { createBank: string[]; listBanks: string[][] } } & Record<string, unknown> {
  const banks = new Set<string>();
  const createBank: string[] = [];
  const listBanks: string[][] = [];
  return {
    calls: { createBank, listBanks },
    listBanks: async () => {
      const snapshot = [...banks];
      listBanks.push(snapshot);
      return { banks: snapshot.map((bank_id) => ({ bank_id })) };
    },
    createBank: async (id: string) => {
      createBank.push(id);
      banks.add(id);
      return { bank_id: id };
    },
    recall: async () => {
      if (cfg.recallThrows) throw cfg.recallThrows;
      // A recall that ANSWERS on a probe that must refuse — the leg must
      // classify this as a mis-behaved probe and fail, not report green.
      return { results: [{ content: "should-not-be-here", score: 1 }], durationMs: 1 };
    },
  };
}

/** Fake client for hindsight-live's disposable probe-bank lifecycle. */
function makeProbeClient(
  cfg: { deleteFails?: boolean } = {},
): { calls: { createBank: string[]; deleteBank: string[] } } & Record<string, unknown> {
  const createBank: string[] = [];
  const deleteBank: string[] = [];
  return {
    calls: { createBank, deleteBank },
    createBank: async (id: string) => {
      createBank.push(id);
      return { bank_id: id };
    },
    deleteBank: async (id: string) => {
      deleteBank.push(id);
      if (cfg.deleteFails) throw new HindsightHttpError(500, "delete boom", "req-del");
      return { deleted: true, alreadyGone: false, bankId: id };
    },
  };
}

/** Fake client shaped like memory-round-trip.test.ts's makeClient (any-cast fake). */
function makeRoundTripClient(memoryId = "rt-mem-xyz"): Record<string, unknown> {
  return {
    retain: async () => ({ memoryId, bankId: "qds-factory", status: "created", durationMs: 10 }),
    recall: async () => ({
      results: [{ content: "Sprint planning uses SPARC methodology", score: 0.95, memoryId }],
      durationMs: 50,
    }),
    reflect: async () => ({
      bankId: "qds-factory",
      insights: [{ summary: "SPARC is the chosen methodology", relatedMemories: 1 }],
      durationMs: 100,
    }),
    consolidate: async () => ({ consolidatedCount: 2, preservedCount: 5, durationMs: 200 }),
  };
}

/** A hindsight-live evidence fixture in `dir` (the round-trip leg's live prereq). */
function writePrereqFixture(dir: string, mode: "live" | "mock"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-01T00-00-00-000Z-p0-9-hindsight-live-aaaaaa.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      { leg: "p0-9-hindsight-live", mode, ok: true, writtenAt: "2026-10-01T00:00:00.000Z" },
      null,
      2,
    )}\n`,
  );
  return file;
}

// ---------------------------------------------------------------------------
// leg-lib (runs NOW — no drivers required)
// ---------------------------------------------------------------------------

describe("leg-lib", () => {
  test("forbiddenOrigin fails the two wrong-instance trap ports, passes clean origins", () => {
    // story AC1/AC6 negative controls; runbook §6.3/§6.4
    const trap8888 = forbiddenOrigin("http://127.0.0.1:8888");
    expect(trap8888).not.toBeNull();
    expect(trap8888).toContain("8888");
    const trap18889 = forbiddenOrigin("http://127.0.0.1:18889");
    expect(trap18889).not.toBeNull();
    expect(trap18889).toContain("18889");
    // any host on the trap ports, not just loopback literals
    expect(forbiddenOrigin("http://hindsight-qds:8888")).not.toBeNull();
    expect(forbiddenOrigin("http://box.example:18889")).not.toBeNull();
    // clean origins pass: the dedicated host-side origin, no-port, other ports
    expect(forbiddenOrigin("http://127.0.0.1:18890")).toBeNull();
    expect(forbiddenOrigin("http://127.0.0.1")).toBeNull();
    expect(forbiddenOrigin("https://example.com")).toBeNull();
    // the colon anchors the port suffix: :18888 must NOT trip the :8888 trap
    expect(forbiddenOrigin("http://127.0.0.1:18888")).toBeNull();
  });

  test("forbiddenOrigin adversarial table: URL-port layer decides parseable origins; suffix layer catches raw host:port (R2-016)", () => {
    // layer 2 (URL port, parseable input): every connecting-to-trap shape —
    // the edge-hunter-verified catch set — is still caught with the layers
    // reordered
    for (const trapped of [
      "http://127.0.0.1:8888/../x", // default-port elision via path suffix
      "http://127.0.0.1:08888", // leading-zero port normalizes to 8888
      "http://safe@127.0.0.1:8888/", // userinfo in front of the trap
      "http://[::1]:8888",
      "http://[::ffff:127.0.0.1]:18889",
      " http://127.0.0.1:8888/ ", // F-001 trim + trailing-slash strip
    ]) {
      expect(forbiddenOrigin(trapped)).not.toBeNull();
    }
    // clean parseable origins pass — INCLUDING the R2-016 fix: a dedicated
    // origin whose PATH tail merely ends in a trap-looking suffix is not refused
    expect(forbiddenOrigin("http://127.0.0.1:18890/prefix:8888")).toBeNull();
    expect(forbiddenOrigin("http://[::8888]")).toBeNull(); // host ::8888 — no port, not a trap target
    // layer 1 (normalized suffix, UNPARSEABLE input only): raw scheme-less
    // host:port spellings still hit the trap table
    expect(forbiddenOrigin("127.0.0.1:8888")).not.toBeNull();
    expect(forbiddenOrigin("127.0.0.1:18889")).not.toBeNull();
  });

  test("forbiddenOrigin: opaque and trailing-dot trap misspellings are refused (R3-011)", () => {
    // hunter-verified: `localhost:8888` (letter-leading, scheme-less) parses
    // as an OPAQUE url — scheme `localhost`, host "", port "" — so the URL
    // layer had no port to read and passed the likeliest human misspelling
    // of the :8888 trap through BOTH layers; same for the R2-016-documented
    // `hindsight-qds:8888` residual
    for (const opaque of ["localhost:8888", "LOCALHOST:8888", "hindsight-qds:8888", "localhost:18889"]) {
      expect(forbiddenOrigin(opaque)).not.toBeNull();
    }
    // trailing dot: port `8888.` is not a number → unparseable → the
    // normalized string ends "8888." and used to slip the suffix layer too
    expect(forbiddenOrigin("http://127.0.0.1:8888.")).not.toBeNull();
    expect(forbiddenOrigin("http://127.0.0.1:18889.")).not.toBeNull();
    // BOTH directions — the R2-016 freedom survives: a parseable dedicated
    // origin whose PATH tail merely looks trap-shaped stays allowed, and the
    // trailing-dot tolerance does not over-refuse non-trap ports
    expect(forbiddenOrigin("http://127.0.0.1:18890/prefix:8888")).toBeNull();
    expect(forbiddenOrigin("http://127.0.0.1:18890.")).toBeNull();
  });

  test("maskTail: exact-word credential fields mask whole quoted values; keyword/monkey/keynote survive (R2-014)", () => {
    // header scheme forms — the specific rules run first, then the
    // authorization/bearer FIELD words double-mask the scheme token itself
    // (fail-closed, documented in maskTail's doc comment)
    expect(maskTail("Authorization: Bearer sekrit-token-123")).toBe("Authorization: *** ***");
    expect(maskTail("authorization: bearer abc")).toBe("authorization: *** ***");
    expect(maskTail("Authorization: X-Api-Key: sekrit")).toBe("Authorization: *** ***");
    expect(maskTail("HINDSIGHT_BEARER_TOKEN=tok-env-1")).toBe("HINDSIGHT_BEARER_TOKEN=***");
    expect(maskTail("HINDSIGHT_API_KEY=key-env-2")).toBe("HINDSIGHT_API_KEY=***");
    const jsonMasked = maskTail('{"HINDSIGHT_BEARER_TOKEN":"tok-json"}');
    expect(jsonMasked).not.toContain("tok-json");
    expect(jsonMasked).toContain("***");
    // exact-word field names: shape-evidence fields survive (keys never masked)
    expect(maskTail("keyword=not-a-secret")).toBe("keyword=not-a-secret");
    expect(maskTail("the monkey sees keynote: none")).toBe("the monkey sees keynote: none");
    for (const field of ["key", "token", "secret", "password", "api_key", "apikey", "credential", "authorization", "bearer"]) {
      expect(maskTail(`${field}=val-1`)).toBe(`${field}=***`);
    }
    // quoted values mask WHOLE, to the closing quote — & inside a quoted
    // value no longer leaks its tail (R2-014 / E-10)
    expect(maskTail('"apiKey":"ab&cd"')).toBe('"apiKey":"***"');
    expect(maskTail("{'token':'a b c'}")).toBe("{'token':'***'}");
    // query params: & is the next parameter, not part of the value — by design
    expect(maskTail("?token=abc&next=1")).toBe("?token=***&next=1");
    expect(maskTail("?keyword=v")).toBe("?keyword=v");
    // unquoted values keep the non-space/& class — the documented ceiling
    expect(maskTail("token=ab cd")).toBe("token=*** cd");
    expect(maskTail("GET /v1/default/banks 200 in 41ms")).toBe("GET /v1/default/banks 200 in 41ms");
    expect(maskTail("x".repeat(50), { maxLen: 10 })).toBe(`${"x".repeat(10)}...`);
  });

  test("maskTail: [_-]-compounded credential fields mask in every position; bare-alpha overmatch stays dead (R3-001)", () => {
    // hunter-verified live inputs: `_` is a word character, so R2-014's
    // \b anchors never fired inside an underscore run and ALL of these
    // escaped every masking rule
    for (const [field, value] of [
      ["X_API_KEY", "sk-live-abcdef123"],
      ["access_token", "eyJhbGciOiJIUzI1NiJ9"],
      ["secret_key", "hunter2pass"],
      ["admin_token", "root-tok"],
      ["api_token", "tok123"],
      ["AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI"],
      ["private_key", "pem-block-data"],
      ["client-secret", "hyphen-compound"], // hyphenated compound too
    ] as const) {
      expect(maskTail(`${field}=${value}`)).toBe(`${field}=***`);
    }
    // query param position
    expect(maskTail("?access_token=eyJ.x&next=1")).toBe("?access_token=***&next=1");
    expect(maskTail("?AWS_SECRET_ACCESS_KEY=wJal&next=1")).toBe("?AWS_SECRET_ACCESS_KEY=***&next=1");
    // JSON-body position (quoted)
    const jsonMasked = maskTail('{"AWS_SECRET_ACCESS_KEY":"wJalrXUtnFEMI"}');
    expect(jsonMasked).not.toContain("wJalrXUtnFEMI");
    expect(jsonMasked).toContain("***");
    // BOTH directions — R2-014's shape-evidence guarantee survives the
    // compound class: a bare-alpha extension of a core word is not a
    // [_-]-separated compound and stays raw
    expect(maskTail("keyword=not-a-secret")).toBe("keyword=not-a-secret");
    expect(maskTail("keywords=shape-evidence")).toBe("keywords=shape-evidence");
    expect(maskTail("the monkey sees keynote: none")).toBe("the monkey sees keynote: none");
    expect(maskTail("?keyword=v")).toBe("?keyword=v");
    expect(maskTail("monkeys=keynote")).toBe("monkeys=keynote");
  });

  test("maskTail: a JSON-escaped quote no longer leaks the quoted value's tail (R3-010)", () => {
    // hunter-verified: the value class used to stop at the `"` of `\"` —
    // `"api_key":"ab\"cd"` masked to `"api_key":"***"cd"` and leaked `cd`
    expect(maskTail(String.raw`"api_key":"ab\"cd"`)).toBe(String.raw`"api_key":"***"`);
    expect(maskTail(String.raw`{'secret_key':'a\'b'}`)).toBe(String.raw`{'secret_key':'***'}`);
    // an unclosed quote still masks to end of string
    expect(maskTail(String.raw`"token":"abc`)).toBe(String.raw`"token":"***`);
  });

  test("requireBaseUrl fails closed on unset/empty and on trap origins, returns clean values", () => {
    expect(() => requireBaseUrl({})).toThrow(/HINDSIGHT_BASE_URL/);
    expect(() => requireBaseUrl({ HINDSIGHT_BASE_URL: "" })).toThrow(/HINDSIGHT_BASE_URL/);
    expect(() => requireBaseUrl({ HINDSIGHT_BASE_URL: "http://127.0.0.1:8888" })).toThrow(/8888/);
    expect(() => requireBaseUrl({ HINDSIGHT_BASE_URL: "http://127.0.0.1:18889" })).toThrow(/18889/);
    expect(requireBaseUrl({ HINDSIGHT_BASE_URL: "http://127.0.0.1:18890" })).toBe(
      "http://127.0.0.1:18890",
    );
  });

  test("writeLegEvidence: openrig-sc2 filename, 2-space JSON + trailing newline", () => {
    const dir = join(tmpDir, "out");
    const payload = baseEvidence("p0-9-test-fixture", "mock");
    const file = writeLegEvidence({ mode: "mock", outDir: dir }, "p0-9-test-fixture", payload);
    const base = file.split("/").pop() ?? "";
    expect(base).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-p0-9-test-fixture-[a-z0-9]{6}\.json$/);
    const content = readFileSync(file, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(JSON.parse(content)).toEqual(payload);
    expect(content).toContain('\n  "leg"'); // 2-space indent
  });

  test("writeLegEvidence routing: live default = LIVE_EVIDENCE_DIR, explicit outDir honored; mock default reroutes to the rehearsal dir", () => {
    // F-017: routing proven WITHOUT writing — resolveEvidenceDir is the pure
    // authority, so no test ever writes into the real closure dir (a crash
    // between write and finally-cleanup must never strand fabricated live
    // evidence there).
    expect(resolveEvidenceDir({ mode: "live" })).toBe(LIVE_EVIDENCE_DIR);
    const explicit = join(tmpDir, "explicit-live");
    expect(resolveEvidenceDir({ mode: "live", outDir: explicit })).toBe(resolve(explicit));
    // mock default never touches the closure dir (documented decision) — the
    // ONE write-path check, into the shared rehearsal dir
    const mockFile = writeLegEvidence({ mode: "mock" }, "p0-9-test-fixture", baseEvidence("p0-9-test-fixture", "mock"));
    expect(resolve(dirname(mockFile))).toBe(resolve(join(tmpdir(), "p0-9-dev-rehearsal")));
    rmSync(mockFile, { force: true }); // the rehearsal dir is shared — take only this file
  });

  test("writeLegEvidence: mock mode REFUSES the closure dir even when named explicitly", () => {
    const closureDir = resolve(
      join(import.meta.dir, "..", "..", "_bmad-output", "evidence", "p0-9-closure"),
    );
    expect(() =>
      writeLegEvidence({ mode: "mock", outDir: closureDir }, "p0-9-test-fixture", baseEvidence("p0-9-test-fixture", "mock")),
    ).toThrow(/mock/i);
    // F-009: a subdirectory of the closure dir is refused too, not just the
    // exact path — no spelling escapes the mock-stands-in-for-live policy
    expect(() =>
      resolveEvidenceDir({ mode: "mock", outDir: join(closureDir, "sub") }),
    ).toThrow(/mock/i);
    // an explicit non-closure outDir is honored
    const dir = join(tmpDir, "explicit");
    const file = writeLegEvidence({ mode: "mock", outDir: dir }, "p0-9-test-fixture", baseEvidence("p0-9-test-fixture", "mock"));
    expect(resolve(dirname(file))).toBe(resolve(dir));
  });

  test("legLog emits one p0-9-leg JSON line per event on stderr", () => {
    const orig = process.stderr.write;
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      legLog({ leg: "p0-9-test", step: "retain", bankId: "qds-factory", durationMs: 12, outcome: "ok" });
      legLog({ leg: "p0-9-test", outcome: "fatal" });
    } finally {
      process.stderr.write = orig;
    }
    const lines = captured.trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(first.event).toBe("p0-9-leg");
    expect(first.leg).toBe("p0-9-test");
    expect(first.step).toBe("retain");
    expect(first.bankId).toBe("qds-factory");
    expect(first.durationMs).toBe(12);
    expect(first.outcome).toBe("ok");
    // durations absent ≠ 0: the minimal event carries no step/bankId/durationMs keys
    const second = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
    expect(second.event).toBe("p0-9-leg");
    expect(second.step).toBeUndefined();
    expect(second.durationMs).toBeUndefined();
  });

  test("acquireHeartbeatLock refreshes the lock mtime while held; a concurrent age-steal never fires (R2-002)", async () => {
    const lockPath = join(tmpDir, "provision.lock");
    const release = await acquireHeartbeatLock(lockPath, {
      staleMs: LEG_LOCK_STALE_MS,
      heartbeatMs: 25,
    });
    expect(release).not.toBeNull();
    const content = readFileSync(lockPath, "utf8");
    const m0 = statSync(lockPath).mtimeMs;
    await Bun.sleep(120);
    const m1 = statSync(lockPath).mtimeMs;
    expect(m1).toBeGreaterThan(m0); // the heartbeat touched it
    // content (pid:nonce) untouched — steal/release content verification still sees OUR lock
    expect(readFileSync(lockPath, "utf8")).toBe(content);
    // the provisioner-style thief: age-only steal at a budget FAR below the
    // leg's 900s — must see a FRESH lock and lose (the R2-002 asymmetry, closed)
    const thief = await acquireFileLock(lockPath, { isStale: ({ ageMs }) => ageMs >= 100 });
    expect(thief).toBeNull();
    // release clears the heartbeat and the lock
    release?.();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("acquireHeartbeatLock contrast: the same age-steal DOES take a lock held without a heartbeat", async () => {
    const lockPath = join(tmpDir, "bare.lock");
    const release = await acquireFileLock(lockPath, { isStale: () => false });
    expect(release).not.toBeNull();
    await Bun.sleep(120);
    const thief = await acquireFileLock(lockPath, { isStale: ({ ageMs }) => ageMs >= 100 });
    expect(thief).not.toBeNull(); // stale by age alone — stolen mid-window (the R2-002 bug, reproduced)
    // the original holder's release REFUSES to unlink the thief's lock — and
    // the wrapper-free guard surfaces it instead of silently freeing the path
    expect(() => release?.()).toThrow(/taken over/);
    thief?.();
  });

  test("scanLiveShapePrereq: a FAILED live shape-check does not satisfy the AC1 ordering gate (R2-001)", () => {
    const dir = join(tmpDir, "prereq");
    mkdirSync(dir, { recursive: true });
    // no evidence → refusal names the ordering
    const none = scanLiveShapePrereq({ mode: "live", outDir: dir });
    expect(none.ok).toBe(false);
    // mock mode is exempt
    expect(scanLiveShapePrereq({ mode: "mock", outDir: dir }).ok).toBe(true);
    // mock-stamped evidence cannot gate a live leg (AC2)
    writeFileSync(
      join(dir, "2026-10-01T00-00-00-000Z-p0-9-hindsight-live-aaaaaa.json"),
      `${JSON.stringify({ mode: "mock", ok: true })}\n`,
    );
    expect(scanLiveShapePrereq({ mode: "live", outDir: dir }).ok).toBe(false);
    // FAILED live evidence (mode:"live", ok:false) must NOT satisfy the gate —
    // the check ran, but it did not pass (R2-001); as the NEWEST live stamp it
    // takes R3-014's newest-failed refusal
    writeFileSync(
      join(dir, "2026-10-02T00-00-00-000Z-p0-9-hindsight-live-bbbbbb.json"),
      `${JSON.stringify({ mode: "live", ok: false })}\n`,
    );
    const failed = scanLiveShapePrereq({ mode: "live", outDir: dir });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toMatch(/newest/i);
    // a PASSED live stamp satisfies it
    writeFileSync(
      join(dir, "2026-10-03T00-00-00-000Z-p0-9-hindsight-live-cccccc.json"),
      `${JSON.stringify({ mode: "live", ok: true })}\n`,
    );
    const passed = scanLiveShapePrereq({ mode: "live", outDir: dir });
    expect(passed.ok).toBe(true);
    if (passed.ok) expect(passed.file).toBe("2026-10-03T00-00-00-000Z-p0-9-hindsight-live-cccccc.json");
  });

  test("scanLiveShapePrereq: an older PASS cannot satisfy the gate once a NEWER live stamp failed (R3-014)", () => {
    const dir = join(tmpDir, "prereq-r3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-10-01T00-00-00-000Z-p0-9-hindsight-live-passed.json"),
      `${JSON.stringify({ mode: "live", ok: true })}\n`,
    );
    // Monday's pass alone satisfies (the R2-001 behavior, unchanged)
    const alone = scanLiveShapePrereq({ mode: "live", outDir: dir });
    expect(alone.ok).toBe(true);
    // Wednesday's FAILED re-pin run is now the NEWEST live stamp — Thursday's
    // leg must not sail through on Monday's pass
    writeFileSync(
      join(dir, "2026-10-04T00-00-00-000Z-p0-9-hindsight-live-failed.json"),
      `${JSON.stringify({ mode: "live", ok: false })}\n`,
    );
    const refused = scanLiveShapePrereq({ mode: "live", outDir: dir });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toMatch(/newest/i);
      expect(refused.reason).toContain("hindsight-live.ts"); // names the re-run remedy
    }
    // recovery: a pass NEWER than the failure satisfies again (both orders pinned)
    writeFileSync(
      join(dir, "2026-10-05T00-00-00-000Z-p0-9-hindsight-live-passed2.json"),
      `${JSON.stringify({ mode: "live", ok: true })}\n`,
    );
    const recovered = scanLiveShapePrereq({ mode: "live", outDir: dir });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.file).toBe("2026-10-05T00-00-00-000Z-p0-9-hindsight-live-passed2.json");
    }
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "mock mode REFUSES a case-variant closure-dir spelling whose path does not exist yet (R2-010)",
    () => {
      // lexical-fallback branch: the case-different segment does not exist,
      // so realpath cannot canonicalize — on case-insensitive platforms the
      // later mkdir would case-fold onto the REAL closure dir
      const caseVariant = resolve(
        join(
          import.meta.dir,
          "..",
          "..",
          "_bmad-output",
          "evidence",
          "P0-9-CLOSURE",
          "not-yet-created-sub",
        ),
      );
      expect(() => resolveEvidenceDir({ mode: "mock", outDir: caseVariant })).toThrow(/mock/i);
    },
  );

  test("assertQdsRepoSlug: prefix gate + the collective roster id refused as a repo base (R2-021)", () => {
    expect(() => assertQdsRepoSlug("my-repo")).toThrow(/qds-/);
    expect(assertQdsRepoSlug("QDS-Factory")).toBe("qds-factory");
    // the collective id is a fixed roster member, not a repo base — using it
    // as a slug mints qds-collective-dev-meta junk on the rerun lane
    expect(() => assertQdsRepoSlug("qds-collective")).toThrow(/collective/);
    expect(() => assertQdsRepoSlug("QDS_Collective")).toThrow(/collective/); // resolves to the same id
    // probe-slug shape still resolves (timestamp suffix, under the truncation cap)
    expect(assertQdsRepoSlug(`qds-probe-${Date.now()}`)).toMatch(/^qds-probe-\d+$/);
  });

  test("resolveRepoSlug: QDS_REPO_SLUG wins, cwd basename is the one default (R2-018)", () => {
    expect(resolveRepoSlug({ QDS_REPO_SLUG: "qds-custom" })).toBe("qds-custom");
    expect(resolveRepoSlug({ QDS_REPO_SLUG: undefined })).toBe(basename(process.cwd()));
    expect(resolveRepoSlug({})).toBe(basename(process.cwd()));
  });

  test("sanitizeOrigin strips userinfo, degrades to a masked string on unparseable input (R2-015)", () => {
    expect(sanitizeOrigin("http://user:pass@127.0.0.1:18890")).toBe("http://127.0.0.1:18890/");
    expect(sanitizeOrigin("http://127.0.0.1:18890")).toBe("http://127.0.0.1:18890/");
    expect(sanitizeOrigin("definitely not a url")).toBe("***");
  });

  test("rerunAwareProvision: provisionImpl wins on the fresh path; rerun reports recreated roster members (R2-011)", async () => {
    const client = makeProvisionClient() as unknown as ProvisionClient;
    // fresh lane with an injected provisionImpl — the override must actually run
    let implOpts: unknown = null;
    const freshSteps: Array<{ label: string; mode: string; ok: boolean }> = [];
    const fresh = await rerunAwareProvision(client, "qds-factory", {
      existingBankIds: [],
      provisionImpl: async (o) => {
        implOpts = o;
        return {
          ok: true,
          banks: [
            { bankId: "qds-factory", status: "created" },
            { bankId: "qds-factory-dev-meta", status: "created" },
            { bankId: COLLECTIVE_BANK_ID, status: "exists" },
          ],
          requestId: "req-fresh-1",
        };
      },
      onStep: (s) => freshSteps.push(s),
    });
    expect(fresh.ok).toBe(true);
    expect(fresh.mode).toBe("resolved-fresh");
    // R3-009: the status:"exists" collective is NOT this attempt's creation —
    // the figure feeds R2-019 residue naming and must not overclaim
    expect(fresh.createdInAttempt).toEqual(["qds-factory", "qds-factory-dev-meta"]);
    expect((implOpts as { repoSlug?: string } | null)?.repoSlug).toBe("qds-factory");
    expect(freshSteps.some((s) => s.mode === "resolved-fresh" && s.ok)).toBe(true);

    // rerun lane: base exists, -dev-meta MISSING → the recreated member is an
    // honest creation, not []
    const rerunClient = makeProvisionClient({ existing: ["qds-factory"] });
    const rerunSteps: Array<{ label: string; mode: string; ok: boolean }> = [];
    const rerun = await rerunAwareProvision(
      rerunClient as unknown as ProvisionClient,
      "qds-factory",
      {
        existingBankIds: ["qds-factory", COLLECTIVE_BANK_ID], // -dev-meta absent
        onStep: (s) => rerunSteps.push(s),
      },
    );
    expect(rerun.ok).toBe(true);
    expect(rerun.mode).toBe("reupsert-existing");
    expect(rerun.createdInAttempt).toEqual(["qds-factory-dev-meta"]);
    expect(rerunClient.calls.createBank).toContain("qds-factory-dev-meta");
    expect(rerunSteps.length).toBeGreaterThan(0);
    expect(rerunSteps.every((s) => s.mode === "reupsert-existing" && s.label === "provision")).toBe(true);
    // full-roster-present rerun creates nothing
    const rerun2 = await rerunAwareProvision(
      rerunClient as unknown as ProvisionClient,
      "qds-factory",
      { existingBankIds: ["qds-factory", "qds-factory-dev-meta", COLLECTIVE_BANK_ID] },
    );
    expect(rerun2.ok).toBe(true);
    expect(rerun2.createdInAttempt).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hindsight-live (driver: scripts/p0-9/hindsight-live.ts)
// ---------------------------------------------------------------------------

describe("hindsight-live", () => {
  test.skipIf(!hasDriver("hindsight-live"))(
    "env fail-closed: absent baseUrl is a fatal exit-2 refusal naming HINDSIGHT_BASE_URL",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      const hadKey = "HINDSIGHT_BASE_URL" in process.env;
      const prev = process.env.HINDSIGHT_BASE_URL;
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.HINDSIGHT_BASE_URL;
      try {
        const ev = await runLeg({ mode: "mock" }); // no baseUrl anywhere
        assertEvidenceContract(ev);
        expect(ev.ok).toBe(false);
        expect(ev.exitCode).toBe(2);
        expect(`${ev.outcome} ${JSON.stringify(ev.steps)}`).toMatch(/HINDSIGHT_BASE_URL|baseUrl/i);
      } finally {
        if (hadKey) process.env.HINDSIGHT_BASE_URL = prev;
        else {
          // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
          delete process.env.HINDSIGHT_BASE_URL;
        }
      }
    },
  );

  test.skipIf(!hasDriver("hindsight-live"))(
    "forbiddenOrigin wired: :8888 and :18889 are fatal, recorded in evidence, and precede any network call",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      const served: ServedCall[] = [];
      const fetchImpl = makeFetchRouter(
        [{ match: () => true, respond: () => new Response("{}", { status: 200 }) }],
        served,
      );
      for (const origin of ["http://127.0.0.1:8888", "http://127.0.0.1:18889"]) {
        served.length = 0;
        const ev = await runLeg({ mode: "mock", baseUrl: origin, fetchImpl, outDir: tmpDir });
        assertEvidenceContract(ev);
        expect(ev.ok).toBe(false);
        expect(ev.exitCode).toBe(2);
        // R2-015: the recorded origin is sanitized (userinfo stripped; WHATWG
        // reconstruction appends "/" for path-less inputs)
        expect(ev.origin).toBe(sanitizeOrigin(origin));
        expect(`${ev.outcome} ${JSON.stringify(ev.steps)}`).toContain(origin.split(":").pop() ?? "");
        // the trap check precedes ANY network — the wrong instance is never probed
        expect(served.length).toBe(0);
      }
    },
  );

  test.skipIf(!hasDriver("hindsight-live"))(
    "health probe via injected fetchImpl; live digest failure (QDS_FORK_CHECKOUT unset) fails the leg while health stays green",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      const served: ServedCall[] = [];
      const fetchImpl = makeFetchRouter(
        [{ match: (c) => c.method === "GET", respond: () => new Response("{}", { status: 200 }) }],
        served,
      );
      const hadFork = "QDS_FORK_CHECKOUT" in process.env;
      const prevFork = process.env.QDS_FORK_CHECKOUT;
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_FORK_CHECKOUT;
      try {
        const ev = await runLeg({
          mode: "live",
          baseUrl: "http://127.0.0.1:18890",
          fetchImpl,
          outDir: tmpDir,
        });
        assertEvidenceContract(ev);
        expect(ev.mode).toBe("live");
        expect(ev.ok).toBe(false);
        expect(ev.exitCode).toBe(1); // leg failure (digest step), not a fatal refusal
        expect(served.some((x) => x.call.method === "GET")).toBe(true); // health actually probed
        expect(ev.steps.some((s) => /health/i.test(s.step) && !/fail/i.test(s.outcome))).toBe(true);
        const digest = ev.steps.find((s) => /digest/i.test(s.step));
        expect(digest).toBeDefined();
        expect(`${digest?.outcome ?? ""}`).toMatch(/fail|missing|fork|checkout/i);
      } finally {
        if (hadFork) process.env.QDS_FORK_CHECKOUT = prevFork;
        else {
          // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
          delete process.env.QDS_FORK_CHECKOUT;
        }
      }
    },
  );

  test.skipIf(!hasDriver("hindsight-live"))(
    "health probe targets GET /health — 0.10.0 serves no root route (measured live on qds-alpha 2026-10-04: / 404, /health 200)",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      const served: ServedCall[] = [];
      // Route table mirrors the live 0.10.0 instance: only /health answers;
      // the root path is a 404 there, so a probe of "/" must fail this leg.
      const fetchImpl = makeFetchRouter(
        [
          {
            match: (c) => c.method === "GET" && new URL(c.url).pathname === "/health",
            respond: () => new Response('{"status":"healthy","database":"connected"}', { status: 200 }),
          },
          { match: (c) => c.method === "GET", respond: () => new Response('{"detail":"Not Found"}', { status: 404 }) },
        ],
        served,
      );
      const hadFork = "QDS_FORK_CHECKOUT" in process.env;
      const prevFork = process.env.QDS_FORK_CHECKOUT;
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_FORK_CHECKOUT;
      try {
        const ev = await runLeg({ mode: "live", baseUrl: "http://127.0.0.1:18890", fetchImpl, outDir: tmpDir });
        assertEvidenceContract(ev);
        const health = ev.steps.find((s) => s.step === "health-probe");
        expect(health?.outcome).toBe("ok");
        const healthCalls = served.filter((x) => x.call.method === "GET");
        expect(healthCalls.length).toBe(1);
        expect(new URL(healthCalls[0]?.call.url ?? "http://x/").pathname).toBe("/health");
      } finally {
        if (hadFork) process.env.QDS_FORK_CHECKOUT = prevFork;
        else {
          // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
          delete process.env.QDS_FORK_CHECKOUT;
        }
      }
    },
  );

  test.skipIf(!hasDriver("hindsight-live"))(
    "health probe requires exactly 200 — another 2xx (204) is not the runbook's healthy answer",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      const fetchImpl = makeFetchRouter(
        [
          {
            match: (c) => c.method === "GET" && new URL(c.url).pathname === "/health",
            respond: () => new Response(null, { status: 204 }),
          },
        ],
        [],
      );
      const hadFork = "QDS_FORK_CHECKOUT" in process.env;
      const prevFork = process.env.QDS_FORK_CHECKOUT;
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_FORK_CHECKOUT;
      try {
        const ev = await runLeg({ mode: "live", baseUrl: "http://127.0.0.1:18890", fetchImpl, outDir: tmpDir });
        assertEvidenceContract(ev);
        expect(ev.steps.find((s) => s.step === "health-probe")?.outcome).toBe("failed-http-204");
      } finally {
        if (hadFork) process.env.QDS_FORK_CHECKOUT = prevFork;
        else {
          // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
          delete process.env.QDS_FORK_CHECKOUT;
        }
      }
    },
  );

  test.skipIf(!hasDriver("hindsight-live"))(
    "RAW retain request conforms to 0.10.0 MemoryItem: metadata is string-valued, tags ride at item level",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      const served: ServedCall[] = [];
      // 0.10.0 MemoryItem.metadata is Dict[str, str]; tags are an item-level
      // string array. Measured live on qds-alpha 2026-10-04: an array under
      // metadata.tags is a 422 (string_type at body.items[0].metadata.tags).
      const fetchImpl = makeFetchRouter(
        [
          {
            match: (c) => c.method === "POST" && /qds-probe-shape-.*\/memories$/.test(c.url),
            respond: (c) => {
              const items = (JSON.parse(c.body ?? "{}") as { items?: Array<Record<string, unknown>> }).items ?? [];
              const conforms = items.every(
                (it) =>
                  Object.values((it.metadata as Record<string, unknown> | undefined) ?? {}).every(
                    (v) => typeof v === "string",
                  ) &&
                  (it.tags === undefined || (Array.isArray(it.tags) && it.tags.every((t) => typeof t === "string"))),
              );
              return conforms
                ? new Response('{"success":true,"bank_id":"x","items_count":1,"async":false}', { status: 200 })
                : new Response('{"detail":[{"type":"string_type"}]}', { status: 422 });
            },
          },
          { match: () => true, respond: () => new Response("{}", { status: 200 }) },
        ],
        served,
      );
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        client: makeProbeClient(),
        outDir: tmpDir,
      });
      const retain = ev.steps.find((s) => s.step === "retain");
      expect(retain?.outcome).toBe("ok");
      const sent = served.find((x) => x.call.method === "POST" && /\/memories$/.test(x.call.url));
      const item = (JSON.parse(sent?.call.body ?? "{}") as { items: Array<Record<string, unknown>> }).items[0];
      expect(item?.tags).toEqual(["p0-9-shape-probe"]);
    },
  );

  test.skipIf(!hasDriver("hindsight-live"))(
    "RAW shape probe: disposable qds-probe-shape- bank, raw bodies recorded verbatim BEFORE any schema parse",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      // Distinctive raw bodies — evidence must carry them byte-for-byte from
      // the fake fetch, i.e. captured before RetainResponseSchema & co. parse.
      const RAW_RETAIN = '{"rawMarker":"retain-RAW-7f3a"}';
      const RAW_RECALL = '{"rawMarker":"recall-RAW-9b1c"}';
      const served: ServedCall[] = [];
      let probePost = 0;
      const fetchImpl = makeFetchRouter(
        [
          { match: (c) => c.method === "GET", respond: () => new Response("{}", { status: 200 }) },
          {
            match: (c) => c.method === "POST" && /qds-probe-shape-/.test(c.url),
            respond: () => {
              probePost++;
              return probePost === 1
                ? new Response(RAW_RETAIN, { status: 200 })
                : new Response(RAW_RECALL, { status: 200 });
            },
          },
          { match: () => true, respond: () => new Response("{}", { status: 200 }) },
        ],
        served,
      );
      const client = makeProbeClient();
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        client,
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true);
      expect(ev.mode).toBe("mock");
      expect(ev.rawRetainBody).toBe(RAW_RETAIN);
      expect(ev.rawRecallBody).toBe(RAW_RECALL);
      expect(String(ev.probeBankId ?? "")).toMatch(/^qds-probe-shape-/);
      // probe bank deleted on the green path too — via client.deleteBank or a raw DELETE
      const deleted =
        client.calls.deleteBank.some((id) => id.startsWith("qds-probe-shape-")) ||
        served.some((x) => x.call.method === "DELETE" && /qds-probe-shape-/.test(x.call.url));
      expect(deleted).toBe(true);
    },
  );

  test.skipIf(!hasDriver("hindsight-live"))(
    "probe cleanup: DELETE issued even when a later step throws; a FAILED delete fails the leg",
    async () => {
      const runLeg = await loadDriver("hindsight-live");
      // (a) second raw probe call 500s → later step fails, but the probe
      // DELETE still issued (finally semantics)
      const servedA: ServedCall[] = [];
      let probeCallA = 0;
      const fetchA = makeFetchRouter(
        [
          { match: (c) => c.method === "GET", respond: () => new Response("{}", { status: 200 }) },
          {
            match: (c) => c.method === "POST" && /qds-probe-shape-/.test(c.url),
            respond: () => {
              probeCallA++;
              return probeCallA === 1
                ? new Response("{}", { status: 200 })
                : new Response("server boom", { status: 500 });
            },
          },
          { match: () => true, respond: () => new Response("{}", { status: 200 }) },
        ],
        servedA,
      );
      const clientA = makeProbeClient();
      const evA = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl: fetchA,
        client: clientA,
        outDir: tmpDir,
      });
      assertEvidenceContract(evA);
      expect(evA.ok).toBe(false);
      const deletedA =
        clientA.calls.deleteBank.some((id) => id.startsWith("qds-probe-shape-")) ||
        servedA.some((x) => x.call.method === "DELETE" && /qds-probe-shape-/.test(x.call.url));
      expect(deletedA).toBe(true);
      // (b) the DELETE itself fails → leg non-zero with the failure recorded
      const servedB: ServedCall[] = [];
      const fetchB = makeFetchRouter(
        [
          {
            match: (c) => c.method === "DELETE" && /qds-probe-shape-/.test(c.url),
            respond: () => new Response("delete boom", { status: 500 }),
          },
          { match: () => true, respond: () => new Response("{}", { status: 200 }) },
        ],
        servedB,
      );
      const clientB = makeProbeClient({ deleteFails: true });
      const evB = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl: fetchB,
        client: clientB,
        outDir: tmpDir,
      });
      assertEvidenceContract(evB);
      expect(evB.ok).toBe(false);
      expect(evB.exitCode).toBe(1);
      expect(`${evB.outcome} ${JSON.stringify(evB.steps)}`).toMatch(/delete/i);
    },
  );
});

// ---------------------------------------------------------------------------
// provision-and-import (driver: scripts/p0-9/provision-and-import.ts)
// ---------------------------------------------------------------------------

describe("provision-and-import", () => {
  test.skipIf(!hasDriver("provision-and-import"))(
    "AC3 compensation fixture (R3-005 claim-scoped): fresh-failure envelope claims b1+b2; b2 delete fails → b1 delete STILL issued, residue names b2; a mid-window probe bank is unclaimed and NEVER deleted",
    async () => {
      const runLeg = await loadDriver("provision-and-import");
      // b1 = qds-factory, b2 = qds-factory-dev-meta; the injected
      // provisionImpl fails the 3rd create (collective) but reports the
      // per-bank statuses — the claim source. A probe-shaped bank appears in
      // the window (a concurrently-running leg's create, no family lock):
      // in the diff, unclaimed, left in place. b2's compensating delete
      // fails; b1's must still be attempted.
      const PROBE = "qds-probe-shape-1700000000000";
      const client = makeProvisionClient({ deleteFailsOn: ["qds-factory-dev-meta"] });
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client,
        provisionImpl: failingThirdCreateImpl(client, PROBE),
        lockPath: join(tmpDir, "leg.lock"),
        outDir: tmpDir,
        expertiseDir: makeTmpCorpus(),
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(false);
      expect(ev.exitCode).toBe(1);
      // the trio was attempted, two landed before the failure
      for (const id of ["qds-factory", "qds-factory-dev-meta", COLLECTIVE_BANK_ID]) {
        expect(client.calls.createBank).toContain(id);
      }
      // no short-circuit: BOTH claimed banks' deletes issued though one fails
      expect(client.calls.deleteBank).toContain("qds-factory");
      expect(client.calls.deleteBank).toContain("qds-factory-dev-meta");
      // R3-005: the foreign probe bank sits in the diff but is NOT this
      // attempt's to delete — named as unclaimed, never compensated
      expect(client.calls.deleteBank).not.toContain(PROBE);
      expect(ev.unclaimedCreated).toContain(PROBE);
      expect(ev.createdInAttempt).not.toContain(PROBE);
      // residue names exactly the bank whose delete failed
      const residue = ev.residue as string[] | undefined;
      expect(Array.isArray(residue)).toBe(true);
      expect(residue).toContain("qds-factory-dev-meta");
      expect(residue).not.toContain("qds-factory");
      expect(residue).not.toContain(PROBE);
    },
  );

  test.skipIf(!hasDriver("provision-and-import"))(
    "PR-review fallback claim: REAL-shape fresh failure (ProvisionErr drops the partial roster — no banks in the envelope, none fixture-added) still compensates the roster-shaped creates via the roster-pattern claim",
    async () => {
      const runLeg = await loadDriver("provision-and-import");
      // The injected provisionImpl replicates the REAL provisioner's failure:
      // b1+b2 land as listBanks-visible side effects, then the envelope is
      // the bare ProvisionErr ({ok:false, error, requestId}) — no banks field
      // anywhere. Without the roster-pattern fallback the claim would be []
      // and both banks would strand as unclaimedCreated.
      const client = makeProvisionClient();
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client,
        provisionImpl: realShapePartialFailureImpl(client),
        lockPath: join(tmpDir, "leg.lock"),
        outDir: tmpDir,
        expertiseDir: makeTmpCorpus(),
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(false);
      expect(ev.exitCode).toBe(1);
      // the pattern claim compensated exactly the roster-shaped creates
      expect(client.calls.deleteBank).toContain("qds-factory");
      expect(client.calls.deleteBank).toContain("qds-factory-dev-meta");
      const deleteOutcomes = ev.deleteOutcomes as Record<string, string> | undefined;
      expect(deleteOutcomes?.["qds-factory"]).toBe("deleted");
      expect(deleteOutcomes?.["qds-factory-dev-meta"]).toBe("deleted");
      // nothing stranded unclaimed: the diff was fully attributable
      expect(ev.unclaimedCreated).toEqual([]);
      expect(ev.residue).toEqual([]);
    },
  );

  test.skipIf(!hasDriver("provision-and-import"))(
    "PR-review mint roster: fresh success with a PRE-EXISTING collective (status exists) imports the corpus into ALL THREE banks — createdInAttempt alone would under-import to the created members",
    async () => {
      const runLeg = await loadDriver("provision-and-import");
      const client = makeProvisionClient({ existing: [COLLECTIVE_BANK_ID] });
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client,
        provisionImpl: freshWithPreexistingCollectiveImpl(),
        lockPath: join(tmpDir, "leg.lock"),
        outDir: tmpDir,
        expertiseDir: makeTmpCorpus(),
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true);
      // mint retain call sites cover every roster bank — including the
      // pre-existing collective (3 entries x 3 banks = 9 POSTs)
      const mintPaths = client.calls.request.filter((r) => r.method === "POST").map((r) => r.path);
      for (const bankId of ["qds-factory", "qds-factory-dev-meta", COLLECTIVE_BANK_ID]) {
        expect(mintPaths.some((p) => p === `/v1/default/banks/${bankId}/memories`)).toBe(true);
      }
      expect(mintPaths.length).toBe(9);
      // the mint record carries all three banks with the derived ids
      const mint = ev.mintRecord as Record<string, { documentIds: string[] }>;
      expect(Object.keys(mint).sort()).toEqual(["qds-collective", "qds-factory", "qds-factory-dev-meta"]);
      for (const bankId of Object.keys(mint)) expect(mint[bankId]!.documentIds.length).toBe(3);
    },
  );

  test.skipIf(!hasDriver("provision-and-import"))(
    "PR-review residue honesty: post-snapshot failure names KNOWN creations (claimable superset) as unconfirmed-delete residue, and a banks-less failure records unknown-attribution — never a clean []",
    async () => {
      const runLeg = await loadDriver("provision-and-import");
      // KNOWN case: the fixture's banks-shaped failure envelope carries the
      // statuses; the post-snapshot dies → residue = the claimable set
      // (claim1+claim2 statuses), reasoned unconfirmed-delete.
      const knownBase = makeProvisionClient({ deleteFailsOn: ["qds-factory-dev-meta"] });
      const knownList = knownBase.listBanks.bind(knownBase);
      let knownCalls = 0;
      const knownClient = {
        ...knownBase,
        listBanks: async () => {
          knownCalls += 1;
          if (knownCalls >= 2) throw new HindsightHttpError(500, "listBanks boom", "req-list");
          return knownList();
        },
      };
      const evKnown = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client: knownClient,
        provisionImpl: failingThirdCreateImpl(knownBase),
        lockPath: join(tmpDir, "leg.lock"),
        outDir: tmpDir,
        expertiseDir: makeTmpCorpus(),
      });
      assertEvidenceContract(evKnown);
      expect(evKnown.ok).toBe(false);
      const knownResidue = evKnown.residue as string[];
      expect(knownResidue).toContain("qds-factory-dev-meta");
      expect(String(evKnown.residueReason)).toMatch(/unconfirmed-delete/);
      // UNKNOWN case: the real ProvisionErr shape (no statuses) + post-snapshot
      // failure → unknown-attribution, never a bare clean [].
      const unknownBase = makeProvisionClient();
      const unknownList = unknownBase.listBanks.bind(unknownBase);
      let unknownCalls = 0;
      const unknownClient = {
        ...unknownBase,
        listBanks: async () => {
          unknownCalls += 1;
          if (unknownCalls >= 2) throw new HindsightHttpError(500, "listBanks boom", "req-list");
          return unknownList();
        },
      };
      const evUnknown = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client: unknownClient,
        provisionImpl: realShapePartialFailureImpl(unknownBase),
        lockPath: join(tmpDir, "leg2.lock"),
        outDir: tmpDir,
        expertiseDir: makeTmpCorpus(),
      });
      assertEvidenceContract(evUnknown);
      expect(evUnknown.ok).toBe(false);
      expect((evUnknown.residue as string[]).length).toBe(0);
      expect(String(evUnknown.residueReason)).toMatch(/unknown-attribution/);
    },
  );

  test.skipIf(!hasDriver("provision-and-import"))(
    "happy-path compensation (R3-005): created-in-attempt is the CLAIM set (status:created ∩ diff); deletes touch exactly claimed banks — never pre-existing, never a collective that pre-existed, never an unclaimed probe bank",
    async () => {
      const runLeg = await loadDriver("provision-and-import");
      const deps = {
        mode: "mock" as const,
        baseUrl: "http://127.0.0.1:18890",
        lockPath: join(tmpDir, "leg.lock"),
        outDir: tmpDir,
        expertiseDir: makeTmpCorpus(),
      };
      // A: import fails after a clean provision on an EMPTY instance →
      // compensation deletes exactly the three banks this attempt CLAIMS
      // (provisionBanks status:created — all three on the empty fake)
      const clientA = makeProvisionClient({ requestThrows: true });
      const evA = await runLeg({ ...deps, client: clientA });
      assertEvidenceContract(evA);
      expect(evA.ok).toBe(false);
      const createdA = evA.createdInAttempt as string[] | undefined;
      expect(Array.isArray(createdA)).toBe(true);
      expect(createdA).toContain("qds-factory");
      expect(createdA).toContain(COLLECTIVE_BANK_ID); // created THIS attempt
      expect([...clientA.calls.deleteBank].sort()).toEqual([...(createdA ?? [])].sort());
      expect(evA.unclaimedCreated).toEqual([]); // nothing foreign appeared
      // B: collective + an unrelated bank PRE-EXIST → not in the claim (a
      // pre-attempt bank is never this attempt's deletion) → never deleted
      const clientB = makeProvisionClient({
        existing: [COLLECTIVE_BANK_ID, "pre-existing-other"],
        requestThrows: true,
      });
      const evB = await runLeg({ ...deps, client: clientB });
      const createdB = evB.createdInAttempt as string[] | undefined;
      expect(createdB).not.toContain(COLLECTIVE_BANK_ID);
      expect(clientB.calls.deleteBank).not.toContain(COLLECTIVE_BANK_ID);
      expect(clientB.calls.deleteBank).not.toContain("pre-existing-other");
      expect(evB.unclaimedCreated).toEqual([]);
      // C: fully green run → no compensation deletes at all
      const clientC = makeProvisionClient();
      const evC = await runLeg({ ...deps, client: clientC });
      assertEvidenceContract(evC);
      expect(evC.ok).toBe(true);
      expect(evC.exitCode).toBe(0);
      expect(clientC.calls.deleteBank.length).toBe(0);
    },
  );

  test.skipIf(!hasDriver("provision-and-import"))(
    "diff window serializes under the injectable lockPath; released after the run",
    async () => {
      const runLeg = await loadDriver("provision-and-import");
      const lockPath = join(tmpDir, "ser.lock");
      // (a) a fresh lock held by a live PID blocks the leg — proves the
      // driver actually acquires the GIVEN path (acquireFileLock idiom,
      // src/lib/file-lock.ts), so a concurrent driver's creates cannot be
      // misattributed into this attempt's diff
      writeFileSync(lockPath, String(process.pid));
      const blocked = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client: makeProvisionClient(),
        lockPath,
        outDir: tmpDir,
      });
      assertEvidenceContract(blocked);
      expect(blocked.ok).toBe(false);
      expect(`${blocked.outcome} ${JSON.stringify(blocked.steps)}`).toMatch(/lock|in_progress/i);
      rmSync(lockPath, { force: true });
      // (b) a clean run releases the lock — nothing left behind
      const ok = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client: makeProvisionClient(),
        lockPath,
        outDir: tmpDir,
      });
      expect(ok.ok).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  test.skipIf(!hasDriver("provision-and-import"))(
    "mint record: per-bank documentIds incl. resolved repo bank; ids deterministic, mulch-prefixed, NOT runId-shaped, carried in the retain body",
    async () => {
      const runLeg = await loadDriver("provision-and-import");
      // R2-022/R3-017: the shared deterministic tmp corpus (TMP_CORPUS via
      // makeTmpCorpus) — the mint record is pinned against OUR entries, never
      // the repo's real .mulch/expertise contents.
      const expectedIds = TMP_CORPUS.map((e) => `mulch-${dedupHash(e.domain, e.concepts).slice(0, 16)}`);
      const deps = {
        mode: "mock" as const,
        baseUrl: "http://127.0.0.1:18890",
        lockPath: join(tmpDir, "mint.lock"),
        outDir: tmpDir,
        expertiseDir: makeTmpCorpus(),
      };
      const client1 = makeProvisionClient();
      const run1 = await runLeg({ ...deps, client: client1 });
      expect(run1.ok).toBe(true);
      const client2 = makeProvisionClient();
      const run2 = await runLeg({ ...deps, client: client2 });
      expect(run2.ok).toBe(true);
      const mint1 = run1.mintRecord as
        | Record<string, { resolvedFrom: string; documentIds: string[] }>
        | undefined;
      expect(mint1).toBeDefined();
      // includes the resolved REPO bank entry (not just dev-meta/collective)
      const repoKey = Object.keys(mint1 ?? {}).find((k) => /qds-factory/.test(k));
      expect(repoKey).toBeDefined();
      const entry = mint1?.[repoKey ?? ""];
      expect(entry?.resolvedFrom).toMatch(/qds[-_]?factory/i);
      const ids = entry?.documentIds ?? [];
      // the exact derived ids — the importer's own dedupHash over the
      // fixture's domain + concepts, in corpus order
      expect(ids).toEqual(expectedIds);
      for (const id of ids) {
        expect(id).toMatch(/^mulch-[0-9a-f]{16}$/); // mulch-<sha256(canonical)>.slice(0,16)
        expect(id).not.toMatch(/^qds-\d{8}-/); // NOT runId-shaped (qds-YYYYMMDD-*)
      }
      // deterministic: same input → same ids (no runId/time folded into the hash)
      const mint2 = run2.mintRecord as typeof mint1;
      expect(mint2?.[repoKey ?? ""]?.documentIds).toEqual(ids);
      // the retain call site carries document_id in the item body (captured
      // via the injected client's raw request recorder)
      const bodies = client1.calls.request.map((r) => JSON.stringify(r.body ?? {}));
      expect(bodies.some((b) => ids.some((id) => b.includes(id)))).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// idempotency-rerun (driver: scripts/p0-9/idempotency-rerun.ts)
// ---------------------------------------------------------------------------

describe("idempotency-rerun", () => {
  test.skipIf(!hasDriver("idempotency-rerun"))(
    "PR-review residue honesty: real-shape fresh failure + post-snapshot failure records unknown-attribution — never a clean [] implying nothing stranded",
    async () => {
      const runLeg = await loadDriver("idempotency-rerun");
      // the real ProvisionErr shape (creates land as listBanks-visible side
      // effects, envelope carries no banks) + a listBanks that dies on the
      // POST-snapshot: the diff is unknowable, so the evidence must say
      // unknown-attribution, not residue:[] = clean.
      const base = makeProvisionClient();
      const baseList = base.listBanks.bind(base);
      let listCalls = 0;
      const client = {
        ...base,
        listBanks: async () => {
          listCalls += 1;
          if (listCalls >= 2) throw new HindsightHttpError(500, "listBanks boom", "req-list");
          return baseList();
        },
      };
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client,
        provisionImpl: realShapePartialFailureImpl(base),
        lockPath: join(tmpDir, "idem.lock"),
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(false);
      expect(ev.exitCode).toBe(1);
      expect(Array.isArray(ev.residue)).toBe(true);
      expect((ev.residue as string[]).length).toBe(0);
      expect(String(ev.residueReason)).toMatch(/unknown-attribution/);
    },
  );

  test.skipIf(!hasDriver("idempotency-rerun"))(
    "two runs: roster identical across three snapshots, second run's diff empty, rosters recorded in evidence",
    async () => {
      const runLeg = await loadDriver("idempotency-rerun");
      const deps = {
        mode: "mock" as const,
        baseUrl: "http://127.0.0.1:18890",
        lockPath: join(tmpDir, "idem.lock"),
        outDir: tmpDir,
      };
      // one stateful fake client = one instance; run 2 sees run 1's banks
      const client = makeProvisionClient();
      const run1 = await runLeg({ ...deps, client });
      assertEvidenceContract(run1);
      expect(run1.ok).toBe(true);
      const created1 = run1.createdInAttempt as string[] | undefined;
      expect(created1).toContain("qds-factory");
      expect(created1).toContain(COLLECTIVE_BANK_ID);
      const rosters1 = run1.rosters as { pre: string[]; post: string[] } | undefined;
      expect(rosters1).toBeDefined();
      expect((rosters1?.pre ?? []).length).toBe(0);

      const run2 = await runLeg({ ...deps, client });
      assertEvidenceContract(run2);
      expect(run2.ok).toBe(true);
      // snapshot 2 (run1 post) === snapshot 3 (run2 post): nothing new
      const created2 = run2.createdInAttempt as string[] | undefined;
      expect(created2).toBeDefined();
      expect(created2).toEqual([]);
      const rosters2 = run2.rosters as { pre: string[]; post: string[] } | undefined;
      expect(rosters2).toBeDefined();
      expect([...(rosters2?.pre ?? [])].sort()).toEqual([...(rosters1?.post ?? [])].sort());
      expect([...(rosters2?.post ?? [])].sort()).toEqual([...(rosters2?.pre ?? [])].sort());
    },
  );

  test.skipIf(!hasDriver("idempotency-rerun"))(
    "AC3 rollback path (R3-005 claim-scoped): run-1 provision fails mid-roster → createdInAttempt is the CLAIM at failure time, compensating deletes recorded per bank, residue empty; a FAILED b1 delete names b1 as residue; a mid-window probe bank is unclaimed and never deleted",
    async () => {
      const runLeg = await loadDriver("idempotency-rerun");
      const deps = {
        mode: "mock" as const,
        baseUrl: "http://127.0.0.1:18890",
        lockPath: join(tmpDir, "idem-rollback.lock"),
        outDir: tmpDir,
      };
      // (a) the injected fresh-lane impl fails the collective create (bank 3
      // of 3) after b1+b2 landed and reports the per-bank statuses — the
      // CLAIM, never the raw post∖pre diff, is what compensation deletes (a
      // probe-shaped bank appears in the window: unclaimed, left in place).
      // The rerun lane then fails on the collective PUT too (createFailsOn).
      // Both claimed deletes succeed → residue empty, but the leg is still
      // non-zero (the provisions DID fail).
      const PROBE = "qds-probe-1700000000000";
      const clientA = makeProvisionClient({ createFailsOn: [COLLECTIVE_BANK_ID] });
      const evA = await runLeg({ ...deps, client: clientA, provisionImpl: failingThirdCreateImpl(clientA, PROBE) });
      assertEvidenceContract(evA);
      expect(evA.ok).toBe(false);
      expect(evA.exitCode).toBe(1);
      expect(evA.steps.some((s) => s.step === "provision-1" && /failed/.test(s.outcome))).toBe(true);
      // createdInAttempt was exactly [b1, b2] — the claim at failure time
      const createdA = evA.createdInAttempt as string[] | undefined;
      expect([...(createdA ?? [])].sort()).toEqual(["qds-factory", "qds-factory-dev-meta"]);
      // b1's compensating delete issued (and b2's too — the whole claim)
      expect(clientA.calls.deleteBank).toContain("qds-factory");
      expect(clientA.calls.deleteBank).toContain("qds-factory-dev-meta");
      // R3-005: the probe bank is in the diff but never this leg's to delete
      expect(clientA.calls.deleteBank).not.toContain(PROBE);
      expect(evA.unclaimedCreated).toContain(PROBE);
      const outcomesA = evA.deleteOutcomes as Record<string, string> | undefined;
      expect(outcomesA?.["qds-factory"]).toBe("deleted");
      expect(outcomesA?.["qds-factory-dev-meta"]).toBe("deleted");
      expect(evA.residue).toEqual([]);
      expect(evA.residue).not.toContain(PROBE);
      // (b) b1's compensating delete FAILS → residue names exactly b1, and
      // b2's delete still issues (no short-circuit past a failed delete)
      const clientB = makeProvisionClient({
        createFailsOn: [COLLECTIVE_BANK_ID],
        deleteFailsOn: ["qds-factory"],
      });
      const evB = await runLeg({ ...deps, client: clientB, provisionImpl: failingThirdCreateImpl(clientB) });
      assertEvidenceContract(evB);
      expect(evB.ok).toBe(false);
      expect(evB.exitCode).toBe(1);
      expect(evB.residue).toEqual(["qds-factory"]);
      const outcomesB = evB.deleteOutcomes as Record<string, string> | undefined;
      expect(outcomesB?.["qds-factory"]).toBe("failed");
      expect(outcomesB?.["qds-factory-dev-meta"]).toBe("deleted");
    },
  );
});

// ---------------------------------------------------------------------------
// round-trip-dedicated (driver: scripts/p0-9/round-trip-dedicated.ts)
// ---------------------------------------------------------------------------

describe("round-trip-dedicated", () => {
  test.skipIf(!hasDriver("round-trip-dedicated"))(
    "live mode without prior hindsight-live evidence → exit-2 refusal naming the ordering",
    async () => {
      const runLeg = await loadDriver("round-trip-dedicated");
      const ev = await runLeg({
        mode: "live",
        baseUrl: "http://127.0.0.1:18890",
        outDir: join(tmpDir, "no-prereq"),
        client: makeRoundTripClient(),
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(false);
      expect(ev.exitCode).toBe(2);
      expect(ev.outcome).toMatch(/hindsight-live/); // names the prerequisite leg
    },
  );

  test.skipIf(!hasDriver("round-trip-dedicated"))(
    "a MOCK-stamped hindsight-live evidence file does not satisfy the live prereq (AC2 negative control)",
    async () => {
      const runLeg = await loadDriver("round-trip-dedicated");
      const dir = join(tmpDir, "mock-prereq");
      writePrereqFixture(dir, "mock");
      const ev = await runLeg({
        mode: "live",
        baseUrl: "http://127.0.0.1:18890",
        outDir: dir,
        client: makeRoundTripClient(),
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(false);
      expect(ev.exitCode).toBe(2);
      expect(ev.outcome).toMatch(/hindsight-live|live/i);
    },
  );

  test.skipIf(!hasDriver("round-trip-dedicated"))(
    "with live prereq: verifyRoundTrip via injected client; RoundTripOk recorded with recallMs + serverRecall + slowQuery; evidence mode live",
    async () => {
      const runLeg = await loadDriver("round-trip-dedicated");
      const dir = join(tmpDir, "with-prereq");
      writePrereqFixture(dir, "live");
      const ev = await runLeg({
        mode: "live",
        baseUrl: "http://127.0.0.1:18890",
        outDir: dir,
        client: makeRoundTripClient(),
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true);
      expect(ev.mode).toBe("live");
      const rt = ev.roundTrip as
        | {
            ok: boolean;
            memoryId: string;
            durations: { recall: number; serverRecall: number };
            slowQuery: boolean;
          }
        | undefined;
      expect(rt).toBeDefined();
      expect(rt?.ok).toBe(true);
      // recallMs is the verifier's HOST-side durations.recall (F009); the
      // server's own figure is kept separately as serverRecall.
      expect(typeof rt?.durations.recall).toBe("number");
      expect(rt?.durations.recall).toBeGreaterThanOrEqual(0);
      expect(typeof rt?.durations.serverRecall).toBe("number");
      expect(typeof rt?.slowQuery).toBe("boolean");
    },
  );

  test.skipIf(!hasDriver("round-trip-dedicated"))(
    "mock rehearsal is exempt from the prereq and stamps mode mock",
    async () => {
      const runLeg = await loadDriver("round-trip-dedicated");
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        outDir: join(tmpDir, "mock-no-prereq"),
        client: makeRoundTripClient(),
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true);
      expect(ev.mode).toBe("mock");
    },
  );

  test.skipIf(!hasDriver("round-trip-dedicated"))(
    "negative control: the live path uses the injected client verbatim — never a self-constructed mode:mock client",
    async () => {
      // DI-shape assertion (documented choice): the fake returns a
      // distinctive memoryId; a leg that ignored deps.client — or built its
      // own HindsightClient, whose mode:"mock" short-circuits to canned
      // bodies (src/hindsight/client.ts) — could not surface it. Any
      // roundTrip evidence on the live path must carry OUR fake's value.
      const runLeg = await loadDriver("round-trip-dedicated");
      const dir = join(tmpDir, "di");
      writePrereqFixture(dir, "live");
      const ev = await runLeg({
        mode: "live",
        baseUrl: "http://127.0.0.1:18890",
        outDir: dir,
        client: makeRoundTripClient("di-mem-4f77"),
      });
      expect(ev.ok).toBe(true);
      const rt = ev.roundTrip as { memoryId?: string } | undefined;
      expect(rt?.memoryId).toBe("di-mem-4f77");
    },
  );
});

// ---------------------------------------------------------------------------
// negative-probes (driver: scripts/p0-9/negative-probes.ts)
// ---------------------------------------------------------------------------

describe("negative-probes", () => {
  test.skipIf(!hasDriver("negative-probes"))(
    "both refusal classes classified in evidence with ZERO banks created (listBanks before/after via injected client)",
    async () => {
      const runLeg = await loadDriver("negative-probes");
      // nonexistent-bank probe: client.recall throws the REST-era refusal
      // (HindsightHttpError 404 — the -32001-class supersession, story AC5)
      const client = makeListClient({
        recallThrows: new HindsightHttpError(404, "bank not found", "req-404"),
      });
      // unavailable-instance probe: transport failure (the -32002-class
      // supersession: 502 / fetch_failed / 408)
      const served: ServedCall[] = [];
      const fetchImpl = makeFetchRouter(
        [
          {
            match: () => true,
            respond: () => {
              throw new TypeError("fetch failed");
            },
          },
        ],
        served,
      );
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client,
        fetchImpl,
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true); // the refusals ARE the proof — leg is green
      const refusals = ev.refusals as Array<{ name: string; class: string }> | undefined;
      expect(Array.isArray(refusals)).toBe(true);
      expect((refusals ?? []).length).toBeGreaterThanOrEqual(2);
      expect((refusals ?? []).some((r) => /404/.test(r.class))).toBe(true);
      expect((refusals ?? []).some((r) => /fetch_failed|502|408/.test(r.class))).toBe(true);
      // zero banks created across BOTH probes
      expect(client.calls.createBank.length).toBe(0);
      const lists = client.calls.listBanks;
      expect(lists.length).toBeGreaterThanOrEqual(2);
      expect([...(lists[0] ?? [])].sort()).toEqual([...(lists[lists.length - 1] ?? [])].sort());
    },
  );

  test.skipIf(!hasDriver("negative-probes"))(
    "a probe that ANSWERS instead of refusing fails the leg (no green-by-default classification)",
    async () => {
      const runLeg = await loadDriver("negative-probes");
      const client = makeListClient(); // recall succeeds — must NOT be green
      const fetchImpl = makeFetchRouter(
        [{ match: () => true, respond: () => new Response("{}", { status: 200 }) }],
        [],
      );
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        client,
        fetchImpl,
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// auth-retired-check (driver: scripts/p0-9/auth-retired-check.ts)
// ---------------------------------------------------------------------------

/**
 * Auth-probe fetch fixture: DELETEs succeed; the TWO unauthenticated legs are
 * independently scriptable — retainStatus/recallStatus default to
 * `unauthStatus` (401 = refused, 200 = the 0.8.6 danger still live), and
 * retainError/recallError reject the transport (R3-013/R3-015 half-measured
 * and unmeasured pairs); the KNOWN credential's first call is the key-known
 * proof (200), later known-credential calls are cross-bank out-of-scope
 * (403); any other credential is an unknown key (401).
 */
function makeAuthFetch(opts: {
  unauthStatus?: number;
  retainStatus?: number;
  recallStatus?: number;
  retainError?: boolean;
  recallError?: boolean;
  known: string;
  served: ServedCall[];
}): typeof fetch {
  let knownCalls = 0;
  return makeFetchRouter(
    [
      { match: (c) => c.method === "DELETE", respond: () => new Response("{}", { status: 200 }) },
      {
        match: (c) => !("authorization" in c.headers) && /\/recall$/.test(c.url),
        respond: () => {
          if (opts.recallError) throw new TypeError("fetch failed");
          return new Response("{}", { status: opts.recallStatus ?? opts.unauthStatus ?? 401 });
        },
      },
      {
        match: (c) => !("authorization" in c.headers),
        respond: () => {
          if (opts.retainError) throw new TypeError("fetch failed");
          return new Response("{}", { status: opts.retainStatus ?? opts.unauthStatus ?? 401 });
        },
      },
      {
        match: (c) => c.headers.authorization === opts.known,
        respond: () => {
          knownCalls++;
          return knownCalls === 1
            ? new Response("{}", { status: 200 })
            : new Response("out of scope", { status: 403 });
        },
      },
      { match: () => true, respond: () => new Response("bad key", { status: 401 }) },
    ],
    opts.served,
  );
}

describe("auth-retired-check", () => {
  test.skipIf(!hasDriver("auth-retired-check"))(
    "unauthenticated probe: disposable qds-probe-<ts> bank, NO Authorization header; three outcome classes + dangerRetired + containmentStatement recorded",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      const served: ServedCall[] = [];
      const fetchImpl = makeAuthFetch({ unauthStatus: 401, known: "Bearer test-known-key", served });
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true);
      // the unauthenticated probe hit a qds- disposable bank with no Authorization
      const unauthProbes = served.filter(
        (x) => x.call.method !== "DELETE" && !("authorization" in x.call.headers),
      );
      expect(unauthProbes.some((x) => /qds-probe-/.test(x.call.url))).toBe(true);
      // the cross-bank probe used the injected credential
      expect(served.some((x) => x.call.headers.authorization === "Bearer test-known-key")).toBe(true);
      // schema: three SEPARATE outcome classes + the honest verdict + the
      // always-present containment statement
      const ao = ev.authOutcomes as Record<string, unknown> | undefined;
      expect(ao).toBeDefined();
      for (const key of ["unauthenticated", "knownKeyOutOfScope", "unknownKey"]) {
        expect(ao?.[key]).toBeDefined();
      }
      expect(typeof ev.dangerRetired).toBe("boolean");
      expect(ev.dangerRetired).toBe(true); // all three refused (401/403/401)
      // F-008: the measured-count is explicit evidence, not implied — a run
      // that probed says how many probe classes it measured
      expect(typeof ev.measuredCount).toBe("number");
      expect(ev.measuredCount as number).toBeGreaterThanOrEqual(1);
      expect(typeof ev.containmentStatement).toBe("string");
      expect((ev.containmentStatement as string).length).toBeGreaterThan(0);
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "danger NOT retired is recorded honestly when the unauthenticated probe is answered",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      const served: ServedCall[] = [];
      const fetchImpl = makeAuthFetch({ unauthStatus: 200, known: "Bearer test-known-key", served });
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      // the leg itself stays green: it MEASURED honestly; the verdict field
      // carries the bad news, never a presupposed "retired"
      expect(ev.ok).toBe(true);
      expect(ev.dangerRetired).toBe(false);
      expect(typeof ev.containmentStatement).toBe("string");
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "R3-013: retain transport-error + recall 401 (half-measured pair) → dangerRetired FALSE, class write-leg-unmeasured, inconclusive verdict naming the unmeasured write leg",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      const served: ServedCall[] = [];
      const fetchImpl = makeAuthFetch({
        retainError: true,
        recallStatus: 401,
        known: "Bearer test-known-key",
        served,
      });
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true); // the leg records; the probe-bank delete landed
      // the 0.8.6 danger is the unauthenticated WRITE answering 200 — a
      // recall-only 401 must NOT retire it when the write leg never completed
      expect(ev.dangerRetired).toBe(false);
      const unauth = (
        ev.authOutcomes as
          | { unauthenticated?: { class?: string; measured?: boolean; writeMeasured?: boolean } }
          | undefined
      )?.unauthenticated;
      expect(unauth?.class).toBe("write-leg-unmeasured");
      expect(unauth?.measured).toBe(true); // the READ responded — pair half-measured
      expect(unauth?.writeMeasured).toBe(false); // the WRITE never did
      const cs = ev.containmentStatement as string;
      expect(cs).toMatch(/write leg/i);
      expect(cs).toMatch(/UNMEASURED/i);
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "R3-013 converse: the RETAIN leg's own 401 retires the danger even when the recall leg transport-errors",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      const served: ServedCall[] = [];
      const fetchImpl = makeAuthFetch({
        retainStatus: 401,
        recallError: true,
        known: "Bearer test-known-key",
        served,
      });
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.dangerRetired).toBe(true); // the WRITE was auth-refused — retired
      const unauth = (ev.authOutcomes as { unauthenticated?: { class?: string } } | undefined)
        ?.unauthenticated;
      expect(unauth?.class).toBe("refused-auth");
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "R3-015: BOTH unauth legs transport-error → class not-measured (never refused-unclassified), dangerRetired false, not-measured verdict",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      const served: ServedCall[] = [];
      const fetchImpl = makeAuthFetch({
        retainError: true,
        recallError: true,
        known: "Bearer test-known-key",
        served,
      });
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.dangerRetired).toBe(false); // no measurement → no retirement claim
      const unauth = (
        ev.authOutcomes as { unauthenticated?: { class?: string; measured?: boolean } } | undefined
      )?.unauthenticated;
      expect(unauth?.class).toBe("not-measured"); // never "refused-unclassified"
      expect(unauth?.measured).toBe(false);
      expect(ev.containmentStatement as string).toMatch(/NOT measured in this run/i);
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "the key-known proof call precedes the cross-bank classification",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      const served: ServedCall[] = [];
      const fetchImpl = makeAuthFetch({ unauthStatus: 401, known: "Bearer test-known-key", served });
      await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      const proofIdx = served.findIndex(
        (x) => x.call.headers.authorization === "Bearer test-known-key" && x.status === 200,
      );
      const crossBankIdx = served.findIndex((x) => x.status === 403);
      expect(proofIdx).toBeGreaterThanOrEqual(0);
      expect(crossBankIdx).toBeGreaterThan(proofIdx);
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "authenticated cross-bank probe uses the ENV credential when no authHeader dep is given",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      const hadKey = "HINDSIGHT_BEARER_TOKEN" in process.env;
      const prev = process.env.HINDSIGHT_BEARER_TOKEN;
      process.env.HINDSIGHT_BEARER_TOKEN = "env-bearer-42";
      try {
        const served: ServedCall[] = [];
        const fetchImpl = makeAuthFetch({ unauthStatus: 401, known: "Bearer env-bearer-42", served });
        const ev = await runLeg({
          mode: "mock",
          baseUrl: "http://127.0.0.1:18890",
          fetchImpl,
          outDir: tmpDir,
        });
        expect(ev.ok).toBe(true);
        expect(served.some((x) => x.call.headers.authorization === "Bearer env-bearer-42")).toBe(true);
      } finally {
        if (hadKey) process.env.HINDSIGHT_BEARER_TOKEN = prev;
        else {
          // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
          delete process.env.HINDSIGHT_BEARER_TOKEN;
        }
      }
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "finally-delete: probe bank DELETE issued even when a later call throws; a FAILED delete fails the leg",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      // (a) the third call rejects → later steps fail, DELETE still issued
      const servedA: ServedCall[] = [];
      let calls = 0;
      const fetchA = makeFetchRouter(
        [
          { match: (c) => c.method === "DELETE", respond: () => new Response("{}", { status: 200 }) },
          {
            match: () => true,
            respond: () => {
              calls++;
              if (calls === 3) throw new TypeError("fetch failed");
              return new Response("{}", { status: 200 });
            },
          },
        ],
        servedA,
      );
      const evA = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl: fetchA,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      assertEvidenceContract(evA); // evidence resolved despite the mid-leg throw
      expect(servedA.some((x) => x.call.method === "DELETE" && /qds-probe-/.test(x.call.url))).toBe(true);
      // (b) the DELETE itself fails → leg fails with the failure recorded
      const servedB: ServedCall[] = [];
      const fetchB = makeFetchRouter(
        [
          {
            match: (c) => c.method === "DELETE",
            respond: () => new Response("delete boom", { status: 500 }),
          },
          { match: () => true, respond: () => new Response("{}", { status: 200 }) },
        ],
        servedB,
      );
      const evB = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        fetchImpl: fetchB,
        authHeader: "Bearer test-known-key",
        outDir: tmpDir,
      });
      assertEvidenceContract(evB);
      expect(evB.ok).toBe(false);
      expect(`${evB.outcome} ${JSON.stringify(evB.steps)}`).toMatch(/delete/i);
    },
  );

  test.skipIf(!hasDriver("auth-retired-check"))(
    "F-008 hermetic mock (no fetchImpl): outcome all-probes-skipped-hermetic, measuredCount 0, exit 0, dangerRetired false",
    async () => {
      const runLeg = await loadDriver("auth-retired-check");
      // no fetchImpl, no client, no network — the mock rehearsal records the
      // skips honestly instead of faking probe outcomes
      const ev = await runLeg({
        mode: "mock",
        baseUrl: "http://127.0.0.1:18890",
        outDir: tmpDir,
      });
      assertEvidenceContract(ev);
      expect(ev.ok).toBe(true);
      expect(ev.exitCode).toBe(0); // the leg records, it does not gate
      expect(ev.outcome).toMatch(/all-probes-skipped-hermetic/);
      expect(ev.measuredCount).toBe(0);
      expect(ev.dangerRetired).toBe(false); // no measurement → no retirement claim
      // every probe class honestly marked not-measured, never faked
      const ao = ev.authOutcomes as Record<string, { measured?: boolean; class?: string }> | undefined;
      for (const key of ["unauthenticated", "knownKeyOutOfScope", "unknownKey"]) {
        expect(ao?.[key]?.measured).toBe(false);
      }
      // R3-015: an unattempted probe is not-measured — never a refusal class
      expect(ao?.unauthenticated?.class).toBe("not-measured");
      expect(typeof ev.containmentStatement).toBe("string");
    },
  );
});

// ---------------------------------------------------------------------------
// rosterPatternClaim (leg-lib) — the PR-review fallback-claim pattern
// ---------------------------------------------------------------------------

describe("rosterPatternClaim (leg-lib)", () => {
  test("matches the attempt's own roster shape: base, collision suffixes -2..-11, and their -dev-meta forms", () => {
    const candidates = [
      "qds-factory",
      "qds-factory-dev-meta",
      "qds-factory-2",
      "qds-factory-7-dev-meta",
      "qds-factory-11",
      "qds-probe-shape-1700000000000",
      "qds-probe-1700000000001",
      "qds-collective",
      "qds-otherrepo",
      "qds-factory-12",
      "qds-factory-1",
      "qds-factory-dev",
    ];
    expect(rosterPatternClaim("QDS-Factory", candidates)).toEqual([
      "qds-factory",
      "qds-factory-dev-meta",
      "qds-factory-2",
      "qds-factory-7-dev-meta",
      "qds-factory-11",
    ]);
  });

  test("never claims the collective as a candidate; slug validation is assertQdsRepoSlug's job (shape-only function)", () => {
    // the collective id never matches a repo base's shape...
    expect(rosterPatternClaim("qds-factory", ["qds-collective", "qds-collective-dev-meta"])).toEqual([]);
    expect(rosterPatternClaim("qds-factory", [])).toEqual([]);
    // ...and a collective SLUG never reaches here: assertQdsRepoSlug refuses
    // it upstream (collective_id_slug) before any pattern call
    expect(() => assertQdsRepoSlug("qds-collective")).toThrow(/collective_id_slug/);
    // suffix-12 / singular -1 are outside the -2..-11 discipline
    expect(rosterPatternClaim("qds-factory", ["qds-factory-12", "qds-factory-1"])).toEqual([]);
  });
});
