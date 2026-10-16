/**
 * A2 leaf-1.4.1 — the fixture-tier hunter-pack integration suite.
 *
 * Drives the full trigger→protocol→legs→harvest→retain→issue path headlessly
 * over the fake Home-bot journal (leaf-1.1.2) and the real src/qa modules
 * (findings / retain / issues), plus leaf-1.3.1's workKey/verdict seams — the
 * DOD's fixture-tier demo of the F3 loop with zero E21 code present.
 *
 * Every AC carries its story-pinned negative control, each asserting the
 * refusal token the module actually throws (G4: no vacuous arms).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAuditStore } from "../../src/audit/link-store.ts";
import { buildResult, type ResultPayload } from "../../src/fleet/result.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import type { GitHubApi } from "../../src/pr/github.ts";
import {
  EXTENSION_NAMESPACES,
  QaWorkKeyError,
  RunRecordStore,
  qaVerdictPatch,
  qaWorkKeyPatch,
  readQaVerdict,
  readQaWorkKey,
} from "../../src/providers/run-record.ts";
import {
  FileIssuesInputSchema,
  FindingSchema,
  MAX_FINDINGS_PER_HARVEST,
  MAX_QA_LEGS,
  QA_LENS,
  QA_LOG,
  QaFindingsError,
  QaVerdictProducerSchema,
  type Finding,
  type HarvestOutput,
  type IssuesFiling,
  type QaLens,
  type RetainFindingsInput,
  deriveFindingDocumentId,
  fileIssues,
  isActionable,
  normalizeHarvest,
  retainFindings,
} from "../../src/qa/index.ts";
import {
  HomeTriggerRefusedError,
  assertSpecSeams,
  createFakeHomeJournal,
  parseJsonlJournal,
  type FakeHomeJournal,
  type QaExternalJobConfig,
  type QaJournalRecord,
} from "./fake-home-journal.ts";
import { TURN_REFUSALS } from "../managers/home-seam-fakes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-a2-hunter-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const COMMIT = `${"a".repeat(39)}0`;
const REPO = "acme/widgets";
const REPO_URL = `https://github.com/${REPO}`;
const MANIFEST = "qa/lens-manifest.json";
const BANK = "qds-acmewidgets";
const PROTOCOL = "qa-protocol-1";
const TOKEN = "ghs_fixture_token_value";
const OWNER = { kind: "user" as const, id: "op-1" };

/** Leg run ids in the minted shape — retain's RUN_ID_RE is the qds-YYYYMMDD-hex6 pin. */
const LEG_RUN_IDS: Record<QaLens, string> = {
  correctness: "qds-20261016-cafe01",
  "secret-hygiene": "qds-20261016-badbad",
  "diff-scope": "qds-20261016-dead00",
};

const ACTIONABLE = {
  finding_text: "auth middleware drops the retry counter on 503 responses",
  diff_context_ref: "src/auth/middleware.ts:42",
};
/** Valid shape, stub-length text — retained but NOT actionable. */
const MINOR = { finding_text: "loop bound", diff_context_ref: "src/loop.ts:9" };

function harvestFor(lens: QaLens): HarvestOutput {
  if (lens === "correctness") {
    return { schemaVersion: 1, lens, findings: [ACTIONABLE, MINOR] };
  }
  return { schemaVersion: 1, lens, findings: [] };
}

function finding(h: { finding_text: string; diff_context_ref: string }, lens: QaLens = "correctness"): Finding {
  return { runId: LEG_RUN_IDS[lens], lens, finding_text: h.finding_text, diff_context_ref: h.diff_context_ref };
}

function retainInput(over: Partial<RetainFindingsInput> = {}): RetainFindingsInput {
  return {
    repoBankId: BANK,
    runId: LEG_RUN_IDS.correctness,
    lens: "correctness",
    commitSha: COMMIT,
    repoSlug: REPO,
    requestId: "req-hunter-1",
    legRan: true,
    findings: [finding(ACTIONABLE), finding(MINOR)],
    ...over,
  };
}

/** Journal ready for legs: bot added, budget reserved, trigger + protocol started. */
function makeJournal(): FakeHomeJournal {
  const j = createFakeHomeJournal({ gatewayUrl: REPO_URL, owner: OWNER });
  j.addBot("bot-qa");
  j.reserveBudget("bot-qa", 5);
  j.postMergeTrigger(COMMIT, "bot-qa");
  j.startProtocol({ commitSha: COMMIT, protocolRunId: PROTOCOL });
  return j;
}

/** A journal through leg submission — one external_job per lens. */
function drivenJournal(): FakeHomeJournal {
  const j = makeJournal();
  for (const lens of QA_LENS) {
    j.submitLeg({ lens, repoSlug: REPO, repoUrl: REPO_URL, commitSha: COMMIT, manifestPath: MANIFEST, groupCapUsd: 5 });
  }
  return j;
}

type LegSubmissionRecord = Extract<QaJournalRecord, { kind: "qa-leg-submitted" }>;

function legSubmissions(records: readonly QaJournalRecord[]): LegSubmissionRecord[] {
  return records.filter((r): r is LegSubmissionRecord => r.kind === "qa-leg-submitted");
}

/** The fork's ProtocolExternalJobConfig XOR + completeness pin, as a runtime predicate. */
function externalJobStrict(cfg: unknown): boolean {
  if (typeof cfg !== "object" || cfg === null) return false;
  const c = cfg as Partial<QaExternalJobConfig>;
  return (
    c.issueId === null &&
    typeof c.workId === "string" && c.workId.startsWith("w:qa-") &&
    typeof c.commitSha === "string" && /^[0-9a-f]{40}$/.test(c.commitSha) &&
    typeof c.repoSlug === "string" && typeof c.repoUrl === "string" &&
    typeof c.manifestPath === "string" &&
    typeof c.groupCapUsd === "number" &&
    typeof c.pollTimeoutMs === "number" &&
    c.onFailure === "fail"
  );
}

/** The fake's whole callable surface — the proof that no other step shape exists. */
function apiMethodNames(j: FakeHomeJournal): string[] {
  return Object.keys(j)
    .filter((k) => typeof (j as unknown as Record<string, unknown>)[k] === "function")
    .sort();
}

interface CapturedRetain {
  bankId: string;
  content: string;
}

function fakeClient() {
  const calls: CapturedRetain[] = [];
  const documents = new Map<string, string>();
  const client = {
    retain: async (bankId: string, content: string, metadata?: { documentId?: string }) => {
      calls.push({ bankId, content });
      if (typeof metadata?.documentId === "string") documents.set(metadata.documentId, content);
      return { memoryId: "", bankId, status: "created" as const, durationMs: 0 };
    },
  };
  return { calls, documents, client };
}

interface CreateIssueCall {
  owner: string;
  repo: string;
  title: string;
  body: string;
  token: string;
}

/** The REST seam (src/pr/github.ts GitHubApi) — the token rides the call args in-process. */
function fakeApi(htmlUrl = `https://github.com/${REPO}/issues/11`): { api: GitHubApi; calls: CreateIssueCall[] } {
  const calls: CreateIssueCall[] = [];
  const api = {
    createIssue: async (o: CreateIssueCall) => {
      calls.push(o);
      return { issueNumber: 11, htmlUrl };
    },
  } as unknown as GitHubApi;
  return { api, calls };
}

function captureLog(): { lines: LogEntry[]; restore: () => void } {
  const lines: LogEntry[] = [];
  return { lines, restore: setLogSink((entry) => lines.push(entry)) };
}

interface StoredRow {
  hop: string;
  event: string;
  subject_id: string | null;
}

function storedRows(path: string): StoredRow[] {
  const db = new Database(path);
  try {
    return db.prepare("SELECT hop, event, subject_id FROM audit_links").all() as StoredRow[];
  } finally {
    db.close();
  }
}

/** The whole src/qa surface, as text — the source-scan fences (AC6 spend, AC7 gate). */
const QA_SOURCES = ["findings.ts", "retain.ts", "issues.ts", "index.ts"].map((f) =>
  readFileSync(join(import.meta.dir, "../../src/qa", f), "utf8"),
);

// ---------------------------------------------------------------------------
// AC1: post-merge trigger → QA protocol → external_job legs
// ---------------------------------------------------------------------------

describe("AC1: trigger → protocol → external_job legs", () => {
  test("postMergeTrigger wakes the QA bot as a recorded operator-initiated turn; legs journal w:qa-* configs as qa-leg-submitted", () => {
    const j = makeJournal();
    for (const lens of QA_LENS) {
      j.submitLeg({ lens, repoSlug: REPO, repoUrl: REPO_URL, commitSha: COMMIT, manifestPath: MANIFEST, groupCapUsd: 5 });
    }
    const records = parseJsonlJournal(j.toJsonl());
    const trigger = records.find((r) => r.kind === "post-merge-trigger");
    expect(trigger).toMatchObject({ kind: "post-merge-trigger", commitSha: COMMIT });
    const turn = records.find((r) => r.kind === "turn");
    // The recorded initiator IS the home's owner (the operator, S02b INV-8) —
    // passed through the seam fakes, never synthesized by the fixture.
    expect(turn?.initiator).toEqual(j.home.owner ?? undefined);
    expect(records.find((r) => r.kind === "qa-protocol-start")).toMatchObject({
      kind: "qa-protocol-start",
      commitSha: COMMIT,
      protocolRunId: PROTOCOL,
    });
    const jobs = legSubmissions(records);
    expect(jobs.length).toBe(QA_LENS.length);
    for (const job of jobs) {
      expect(job.workId).toMatch(/^w:qa-/);
      expect(job.workId).toBe(job.config.workId);
      expect(externalJobStrict(job.config)).toBe(true);
    }
    // A leg's terminal record closes the submission, keyed by its workId.
    const first = jobs[0];
    if (!first) throw new Error("expected a leg submission");
    j.legTerminal({ workId: first.workId, status: "completed", exitCode: 0 });
    expect(parseJsonlJournal(j.toJsonl())).toContainEqual({
      kind: "qa-leg-terminal",
      workId: first.workId,
      status: "completed",
      exitCode: 0,
      order: expect.any(Number),
    });
  });

  test("one wake, one protocol: a second trigger for the same merged commitSha is refused and journaled; a different commitSha fires", () => {
    const j = makeJournal(); // the first wake for COMMIT already fired
    for (let i = 0; i < 2; i++) {
      let thrown: unknown;
      try {
        j.postMergeTrigger(COMMIT, "bot-qa");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(HomeTriggerRefusedError);
      expect((thrown as HomeTriggerRefusedError).code).toBe("protocol-already-fired");
    }
    const records = parseJsonlJournal(j.toJsonl());
    const refused = records.filter((r) => r.kind === "protocol-refused");
    expect(refused.length).toBe(2);
    for (const r of refused) {
      expect(r).toMatchObject({ kind: "protocol-refused", commitSha: COMMIT, reason: "protocol-already-fired" });
    }
    // The refusals fired no wake: exactly one recorded turn for COMMIT remains.
    expect(records.filter((r) => r.kind === "turn").length).toBe(1);
    // A different merged commitSha still fires its own protocol wake.
    const other = `${"b".repeat(39)}0`;
    j.postMergeTrigger(other, "bot-qa");
    const after = parseJsonlJournal(j.toJsonl());
    expect(after.filter((r) => r.kind === "post-merge-trigger").map((r) => r.commitSha)).toEqual([COMMIT, other]);
    expect(after.filter((r) => r.kind === "protocol-refused").length).toBe(2);
  });

  test("AC1 negative control (i): the fixture cannot express a non-merge wake — no PR-open/CI-start/heartbeat kind exists", () => {
    const records = parseJsonlJournal(drivenJournal().toJsonl());
    const kinds = new Set(records.map((r) => r.kind));
    // Every journaled kind is one of the pinned post-merge + refusal/turn/protocol/leg kinds.
    for (const k of kinds) {
      expect([
        "post-merge-trigger",
        "protocol-refused",
        "turn",
        "turn-refused",
        "budget-refused",
        "qa-protocol-start",
        "qa-leg-submitted",
        "qa-leg-terminal",
      ]).toContain(k);
    }
    for (const nonMerge of ["pr-open", "ci-start", "heartbeat"]) {
      expect([...kinds]).not.toContain(nonMerge);
      // …and the fixture's API has no method that could produce one.
      expect(apiMethodNames(drivenJournal()).some((n) => n.toLowerCase().includes(nonMerge))).toBe(false);
    }
    // Exactly one wake method exists on the fixture surface.
    expect(apiMethodNames(drivenJournal()).filter((n) => n.toLowerCase().includes("trigger"))).toEqual(["postMergeTrigger"]);
  });

  test("AC1 negative control (ii): a protocol step cannot mutate files — every journaled step is qa-protocol-start or qa-leg-submitted, and the API has no code-mutation shape", () => {
    const j = drivenJournal();
    const records = parseJsonlJournal(j.toJsonl());
    const stepRecords = records.filter((r) => r.kind === "qa-protocol-start" || r.kind === "qa-leg-submitted");
    expect(stepRecords.length).toBe(1 + QA_LENS.length);
    expect(legSubmissions(records).length).toBe(QA_LENS.length);
    // The fixture's callable surface is exactly the seam fakes' methods plus
    // the four protocol verbs — there is no applyFix/patch/edit step to call.
    expect(apiMethodNames(j)).toEqual([
      "addBot",
      "legTerminal",
      "postMergeTrigger",
      "reserveBudget",
      "runBotTurn",
      "startProtocol",
      "submitLeg",
      "toJsonl",
      "writeProfileTokens",
    ]);
  });

  test("AC1 negative control (iii): issueId synthesis is impossible — every config carries issueId null, and a synthesized one fails the strict shape", () => {
    const records = parseJsonlJournal(drivenJournal().toJsonl());
    const configs = legSubmissions(records).map((r) => r.config);
    expect(configs.length).toBe(QA_LENS.length);
    for (const cfg of configs) {
      expect(externalJobStrict(cfg)).toBe(true);
      expect(cfg.issueId).toBeNull();
      expect(cfg.workId.startsWith("w:qa-")).toBe(true);
    }
    // The check has teeth: a round-tripped config with a synthesized numeric
    // issueId (the namespace-conflation violation) fails the same predicate.
    const first = configs[0];
    if (!first) throw new Error("expected an external_job config");
    const roundTripped = JSON.parse(JSON.stringify(first)) as QaExternalJobConfig;
    expect(externalJobStrict(roundTripped)).toBe(true);
    expect(externalJobStrict({ ...roundTripped, issueId: 7 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2: per-lens fleet runs → (runId, lens) attribution
// ---------------------------------------------------------------------------

describe("AC2: per-lens runs attribute findings to (runId, lens)", () => {
  test("each lens is its own run record; normalizeHarvest mints the (runId, lens) pair host-side", () => {
    expect(QA_LENS.length).toBeLessThanOrEqual(MAX_QA_LEGS);
    for (const lens of QA_LENS) {
      const runId = LEG_RUN_IDS[lens];
      const leg: ResultPayload = { schemaVersion: 1, runId, requestId: null, status: "completed", terminal: true, artifacts: {} };
      const norm = normalizeHarvest(lens, leg, harvestFor(lens));
      if (!norm.legRan) throw new Error(`fixture leg ${lens} must have run`);
      expect(norm.runId).toBe(runId);
      expect(norm.lens).toBe(lens);
      for (const f of norm.findings) {
        expect(f.runId).toBe(runId);
        expect(f.lens).toBe(lens);
        expect(FindingSchema.safeParse(f).success).toBe(true);
      }
    }
  });

  test("AC2 negative control: a merged-prompt harvest claiming another lens behind one runId is refused (harvest-lens-mismatch)", () => {
    const leg: ResultPayload = {
      schemaVersion: 1,
      runId: LEG_RUN_IDS.correctness,
      requestId: null,
      status: "completed",
      terminal: true,
      artifacts: {},
    };
    const mergedPrompt = harvestFor("correctness"); // claims lens correctness…
    let thrown: unknown;
    try {
      // …submitted under the secret-hygiene leg's single run record.
      normalizeHarvest("secret-hygiene", leg, mergedPrompt);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(QaFindingsError);
    expect((thrown as QaFindingsError).code).toBe("harvest-lens-mismatch");
  });

  test("AC2 negative control (caller bug): a lens outside the roster has no leg to attribute to (harvest-unknown-lens)", () => {
    const leg: ResultPayload = {
      schemaVersion: 1,
      runId: LEG_RUN_IDS.correctness,
      requestId: null,
      status: "completed",
      terminal: true,
      artifacts: {},
    };
    expect(() => normalizeHarvest("prompt-quality", leg, harvestFor("correctness"))).toThrow(
      expect.objectContaining({ name: "QaFindingsError", code: "harvest-unknown-lens" }),
    );
  });

  test("an exit-6 leg keeps its findings: the completed-terminal record is the lifecycle signal, the harvest's presence the pass — findings retain", async () => {
    // An exit-6 leg closes its run record as status "completed", terminal —
    // the record's terminal state IS the lifecycle verdict; the exit code is
    // not re-derived here, and the harvest output present is what proves the
    // leg actually ran its pass over the commit.
    const leg: ResultPayload = {
      schemaVersion: 1,
      runId: LEG_RUN_IDS.correctness,
      requestId: null,
      status: "completed",
      terminal: true,
      artifacts: {},
    };
    const norm = normalizeHarvest("correctness", leg, harvestFor("correctness"));
    if (!norm.legRan) throw new Error("a completed-terminal leg with harvest output must read as legRan");
    expect(norm.findings.length).toBe(2);
    const { calls, client } = fakeClient();
    const r = await retainFindings({ client }, retainInput({ findings: norm.findings }));
    expect(r.documentIds.length).toBe(2);
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC3: idempotent shared-bank retain
// ---------------------------------------------------------------------------

describe("AC3: replay leaves one document set + one receipt row set", () => {
  test("a byte-identical replay keeps the same documentIds, one document and one receipt row per finding", async () => {
    const { documents, calls, client } = fakeClient();
    const dbPath = join(dir, "ac3-audit.db");
    const audit = openAuditStore(dbPath);
    try {
      const input = retainInput();
      const first = await retainFindings({ client, auditStore: audit }, input);
      const second = await retainFindings({ client, auditStore: audit }, input);
      expect(second.documentIds).toEqual(first.documentIds);
      expect(documents.size).toBe(first.documentIds.length);
      expect(storedRows(dbPath).length).toBe(first.documentIds.length);
      // Two findings x two retains on the wire; the substrate dedups by documentId.
      expect(calls.length).toBe(2 * first.documentIds.length);
      expect(new Set(calls.map((c) => c.bankId))).toEqual(new Set([BANK]));
    } finally {
      audit.close();
    }
  });

  test("AC3 negative control: box-side retain — a credential riding a finding is refused pre-network (retain-payload-invalid)", async () => {
    const { calls, client } = fakeClient();
    const carrying = { ...finding(ACTIONABLE), token: "ghs_boxside_credential" };
    await expect(retainFindings({ client }, retainInput({ findings: [carrying as unknown as Finding] }))).rejects.toMatchObject({
      code: "retain-payload-invalid",
    });
    expect(calls.length).toBe(0);
    // The sanctioned input surface itself has no credential slot at all.
    expect(Object.keys(retainInput()).sort()).toEqual([
      "commitSha",
      "findings",
      "legRan",
      "lens",
      "repoBankId",
      "repoSlug",
      "requestId",
      "runId",
    ]);
  });

  test("AC3 negative control: wrong-bank retain — a non-qds / solstice-* bank id is refused (retain-bank-not-repo)", async () => {
    const { calls, client } = fakeClient();
    for (const badBank of ["solstice-collective", "solstice-acmewidgets", "acmewidgets"]) {
      await expect(retainFindings({ client }, retainInput({ repoBankId: badBank }))).rejects.toMatchObject({
        code: "retain-bank-not-repo",
      });
    }
    expect(calls.length).toBe(0);
  });

  test("AC3 negative control: a finding attributed to another leg is never silently re-attributed (retain-attribution-mismatch)", async () => {
    const { calls, client } = fakeClient();
    const alien = { ...finding(ACTIONABLE), runId: LEG_RUN_IDS["secret-hygiene"] };
    await expect(retainFindings({ client }, retainInput({ findings: [alien] }))).rejects.toMatchObject({
      code: "retain-attribution-mismatch",
    });
    expect(calls.length).toBe(0);
  });

  test("AC3 negative control: a harvest past the per-harvest cap is refused, never truncated (retain-findings-overflow)", async () => {
    const { calls, client } = fakeClient();
    const overflow = Array.from({ length: MAX_FINDINGS_PER_HARVEST + 1 }, (_, i) => ({
      ...finding(ACTIONABLE),
      finding_text: `finding ${i} over the cap`,
    }));
    expect(overflow.length).toBe(MAX_FINDINGS_PER_HARVEST + 1);
    await expect(retainFindings({ client }, retainInput({ findings: overflow }))).rejects.toMatchObject({
      code: "retain-findings-overflow",
    });
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4: host-side issue filing
// ---------------------------------------------------------------------------

describe("AC4: fileIssues files actionable findings host-side", () => {
  test("files one issue per actionable finding over the REST client; the token rides tokenReader in-process, never a child or env", async () => {
    const { api, calls } = fakeApi();
    const filing: IssuesFiling = await fileIssues(
      { repoSlug: REPO, api, tokenReader: async () => TOKEN },
      { commitSha: COMMIT, runId: LEG_RUN_IDS.correctness, lens: "correctness", findings: [finding(ACTIONABLE), finding(MINOR)] },
    );
    expect(filing.filed).toBe(1);
    expect(filing.urls).toEqual([`https://github.com/${REPO}/issues/11`]);
    expect(isActionable(finding(MINOR))).toBe(false);
    expect(calls.length).toBe(1);
    const call = calls[0];
    if (!call) throw new Error("expected one REST createIssue call");
    expect(call.owner).toBe("acme");
    expect(call.repo).toBe("widgets");
    expect(call.token).toBe(TOKEN);
    expect(call.body).toContain(ACTIONABLE.finding_text);
    expect(call.title).toContain("correctness:");
  });

  test("AC4 negative control: token-in-env and box-shaped inputs are refused before any API call (issues-input-refused)", async () => {
    const { api, calls } = fakeApi();
    const base = { commitSha: COMMIT, runId: LEG_RUN_IDS.correctness, lens: "correctness", findings: [finding(ACTIONABLE)] };
    // GH_TOKEN as an input field is refused by the strict shape…
    expect(FileIssuesInputSchema.safeParse({ ...base, GH_TOKEN: TOKEN }).success).toBe(false);
    // …and so is any boxEnv-shaped caller.
    expect(FileIssuesInputSchema.safeParse({ ...base, boxEnv: { GH_TOKEN: TOKEN } }).success).toBe(false);
    for (const bad of [{ ...base, GH_TOKEN: TOKEN }, { ...base, boxEnv: { GH_TOKEN: TOKEN } }]) {
      await expect(fileIssues({ repoSlug: REPO, api, tokenReader: async () => TOKEN }, bad as never)).rejects.toMatchObject({
        code: "issues-input-refused",
      });
    }
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC5: E21 seam fidelity
// ---------------------------------------------------------------------------

describe("AC5: the fixture encodes only the E21-pinned seams", () => {
  test("assertSpecSeams green: TURN_REFUSALS exactly 3, the 4 SOLSTICE_* token names, isHomeBackedAgent behavior", () => {
    expect(() => assertSpecSeams()).not.toThrow();
    expect(TURN_REFUSALS).toHaveLength(3);
  });

  test("AC5 negative control: a second refusal vocabulary fails the pin — the pin has teeth", () => {
    const mutable = TURN_REFUSALS as unknown as string[];
    mutable.push("silent_owner");
    try {
      expect(() => assertSpecSeams()).toThrow(/spec seam drift/);
    } finally {
      mutable.pop();
    }
    expect(() => assertSpecSeams()).not.toThrow();
  });

  test("AC5 negative control: no invented E21 field — journal records and configs carry only pinned keys", () => {
    // Drive every record kind the union admits, so the key set observed here
    // covers the whole journal vocabulary, not just the happy path.
    const refused = createFakeHomeJournal({ gatewayUrl: REPO_URL, owner: null });
    refused.addBot("bot-nobody");
    // The journal records the refusal before re-raising it (fixture contract).
    expect(() => refused.postMergeTrigger(COMMIT, "bot-nobody")).toThrow(); // no_owner → turn-refused
    const unfunded = createFakeHomeJournal({ gatewayUrl: REPO_URL, owner: OWNER });
    unfunded.addBot("bot-broke");
    expect(() => unfunded.postMergeTrigger(COMMIT, "bot-broke")).toThrow(); // budget_reservation_missing
    const j = drivenJournal();
    // Close one submitted leg so the qa-leg-terminal kind's keys are observed too.
    const first = legSubmissions(parseJsonlJournal(j.toJsonl()))[0];
    if (!first) throw new Error("expected a leg submission");
    j.legTerminal({ workId: first.workId, status: "failed", exitCode: 6 });
    const records = [
      ...parseJsonlJournal(j.toJsonl()),
      ...parseJsonlJournal(refused.toJsonl()),
      ...parseJsonlJournal(unfunded.toJsonl()),
    ];
    const recordKeys = new Set<string>();
    const configKeys = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r)) recordKeys.add(k);
      if (r.kind === "qa-leg-submitted") for (const k of Object.keys(r.config)) configKeys.add(k);
    }
    expect([...recordKeys].sort()).toEqual([
      "botId",
      "commitSha",
      "config",
      "exitCode",
      "initiator",
      "kind",
      "order",
      "protocolRunId",
      "reason",
      "refusal",
      "status",
      "workId",
    ]);
    expect([...configKeys].sort()).toEqual([
      "commitSha",
      "groupCapUsd",
      "issueId",
      "manifestPath",
      "onFailure",
      "pollTimeoutMs",
      "repoSlug",
      "repoUrl",
      "workId",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC6: workKey stamp + verdict fold
// ---------------------------------------------------------------------------

describe("AC6: w:qa-* workKey stamp and the verdict fold", () => {
  test("AC6 spend fence: src/qa adds no macro-side aggregation surface — the per-runId ledger + run-cost hop stay the only spend machinery (source scan)", () => {
    for (const forbidden of ["cost-ledger", "CostLedger", "run-cost", "budget-primitive"]) {
      expect(QA_SOURCES.some((s) => s.includes(forbidden))).toBe(false);
    }
  });

  test("a submitted leg's workKey stamps its run record and round-trips; the producer verdict parses and folds into ResultPayload", () => {
    const store = new RunRecordStore({ dir });
    const j = makeJournal();
    const cfg = j.submitLeg({
      lens: "correctness",
      repoSlug: REPO,
      repoUrl: REPO_URL,
      commitSha: COMMIT,
      manifestPath: MANIFEST,
      groupCapUsd: 5,
    });
    const runId = LEG_RUN_IDS.correctness;
    store.create(runId);
    // The CONTRACT workId form (`w:qa-<utcstamp>-<lens>`, 40+ mixed-class
    // chars) stamps through the store: SHAPE_EXEMPT_PATHS exempts
    // extensions.qaWorkKey.workKey from the ≥40 mixed-class shape test while
    // the credential prefix scan and the ≤201 bound stay live (this test plus
    // the >201 refusal below are the exemption's regression proof).
    store.set(runId, qaWorkKeyPatch(cfg.workId));
    expect(cfg.workId).toMatch(/^w:qa-/);
    expect(readQaWorkKey(store.get(runId))).toBe(cfg.workId);
    // The exemption's ≥40 shape-test arm, proven with a grammar-valid key long
    // enough to cross the line (a long lens tail): stamps through fine.
    const longWorkId = `w:qa-20261016T120000Z-${"l".repeat(25)}`;
    store.create(`${runId}-long`);
    store.set(`${runId}-long`, qaWorkKeyPatch(longWorkId));
    expect(longWorkId.length).toBeGreaterThanOrEqual(40);
    expect(readQaWorkKey(store.get(`${runId}-long`))).toBe(longWorkId);

    const docId = deriveFindingDocumentId(runId, "correctness", 0);
    const producer = QaVerdictProducerSchema.parse({
      status: "approved",
      producedAt: "2026-10-16T00:00:00.000Z",
      escalated: true,
      qaRunId: runId,
      commitSha: COMMIT,
      findingCount: 1,
      findingRefs: [docId],
    });
    // The verdict goes through the ONE writer seam: boolean escalated in…
    store.set(runId, qaVerdictPatch(producer));
    // …int 1 at the store…
    expect(readQaVerdict(store.get(runId))?.status).toBe("approved");
    expect(readQaVerdict(store.get(runId))?.escalated).toBe(1);
    // …and boolean true on the wire.
    const payload = buildResult(store, runId);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.verdict?.status).toBe("approved");
    expect(payload.verdict?.escalated).toBe(true);
    expect(payload.verdict?.qaRunId).toBe(runId);
    // The namespace table still pins both entries at schemaVersion 1 (adds-only held).
    expect(EXTENSION_NAMESPACES.qaWorkKey).toEqual({ schemaVersion: 1, fields: { workKey: "string" } });
  });

  test("AC6 negative control: a non-w: workKey is refused (QaWorkKeyError); the exemption keeps the ≤201 bound", () => {
    expect(() => qaWorkKeyPatch("issue-7")).toThrow(QaWorkKeyError);
    expect(() => qaWorkKeyPatch("qa-7")).toThrow(QaWorkKeyError);
    const store = new RunRecordStore({ dir });
    store.create(LEG_RUN_IDS["diff-scope"]);
    const overBound = `w:qa-20261016T120000Z-${"a".repeat(197)}`;
    expect(overBound.length).toBeGreaterThan(201);
    expect(() => store.set(LEG_RUN_IDS["diff-scope"], qaWorkKeyPatch(overBound))).toThrow(/grammar bound/);
  });
});

// ---------------------------------------------------------------------------
// AC7: zero approval-gate traffic (source-scan fence)
// ---------------------------------------------------------------------------

describe("AC7: zero approval-gate interaction (source-scan fence)", () => {
  const qaSources = ["findings.ts", "retain.ts", "issues.ts", "index.ts"].map((f) =>
    readFileSync(join(import.meta.dir, "../../src/qa", f), "utf8"),
  );

  test("no src/qa file imports or references the approval gate or fleet approve", () => {
    for (const forbidden of ["approval-gate", "fleet approve", "requestApproval"]) {
      expect(qaSources.some((s) => s.includes(forbidden))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// DOD: the headless trigger→retain→issue demo
// ---------------------------------------------------------------------------

/** The journaled external_job leg submissions (one per submitted lens). */
function externalJobs(records: QaJournalRecord[]): QaJournalRecord[] {
  return records.filter((r): r is Extract<QaJournalRecord, { kind: "qa-leg-submitted" }> => r.kind === "qa-leg-submitted");
}

describe("DOD: headless end-to-end demo", () => {
  test("trigger → protocol → 3 legs → harvest → retain → issues → verdict, all headless", async () => {
    const { lines, restore } = captureLog();
    const { api, calls } = fakeApi();
    const store = new RunRecordStore({ dir });
    const { documents, client } = fakeClient();
    const dbPath = join(dir, "demo-audit.db");
    const audit = openAuditStore(dbPath);
    try {
      const j = makeJournal();
      const retainedBanks = new Set<string>();
      const allFindings: Finding[] = [];
      const docIds: string[] = [];
      const legs: { runId: string; lens: QaLens }[] = [];

      for (const lens of QA_LENS) {
        const cfg = j.submitLeg({ lens, repoSlug: REPO, repoUrl: REPO_URL, commitSha: COMMIT, manifestPath: MANIFEST, groupCapUsd: 5 });
        const runId = LEG_RUN_IDS[lens];
        store.create(runId);
        // The contract workId form stamps through the exemption (AC6 regression).
        store.set(runId, qaWorkKeyPatch(cfg.workId));
        expect(readQaWorkKey(store.get(runId))).toBe(cfg.workId);
        legs.push({ runId, lens });
        // diff-scope's leg does not run — absent-not-0 at the harvest seam.
        const leg: ResultPayload | undefined =
          lens === "diff-scope"
            ? undefined
            : { schemaVersion: 1, runId, requestId: null, status: "completed", terminal: true, artifacts: {} };
        const norm = normalizeHarvest(lens, leg, lens === "diff-scope" ? null : harvestFor(lens));
        if (!norm.legRan) continue;
        const r = await retainFindings(
          { client, auditStore: audit },
          {
            repoBankId: BANK,
            runId: norm.runId,
            lens,
            commitSha: COMMIT,
            repoSlug: REPO,
            requestId: `req-${runId}`,
            legRan: norm.legRan,
            findings: norm.findings,
          },
        );
        retainedBanks.add(r.bank);
        docIds.push(...r.documentIds);
        allFindings.push(...norm.findings);
      }

      const filing = await fileIssues(
        { repoSlug: REPO, api, tokenReader: async () => TOKEN },
        { commitSha: COMMIT, runId: LEG_RUN_IDS.correctness, lens: "correctness", findings: allFindings },
      );

      // Verdict produced by the producing QA run (the first leg's record IS the audit trail)…
      const producer = QaVerdictProducerSchema.parse({
        status: "approved",
        producedAt: "2026-10-16T00:00:00.000Z",
        escalated: true,
        qaRunId: legs[0]?.runId,
        commitSha: COMMIT,
        findingCount: allFindings.length,
        findingRefs: docIds,
      });
      const verdictRunId = producer.qaRunId;
      // Through the ONE writer seam: boolean escalated in, int at the store.
      store.set(verdictRunId, qaVerdictPatch(producer));
      const payload = buildResult(store, verdictRunId);

      // …then the demo's assertions.
      const records = parseJsonlJournal(j.toJsonl());
      expect(records.length).toBe(j.journal.length);
      expect(records[0]?.kind).toBe("post-merge-trigger");
      expect(externalJobs(records).length).toBe(QA_LENS.length);

      // Retained to the qds-<repo> bank only; one document per finding on replay-safe ids.
      expect([...retainedBanks]).toEqual([BANK]);
      expect(documents.size).toBe(docIds.length);
      expect(storedRows(dbPath).length).toBe(docIds.length);
      for (const row of storedRows(dbPath)) {
        expect(row.hop).toBe("memory-retain-receipt");
        expect(row.event).toBe("retain");
      }

      // Issues filed ONLY for the actionable findings (2 retained, 1 filed).
      expect(allFindings.length).toBe(2);
      expect(filing.filed).toBe(allFindings.filter(isActionable).length);
      expect(calls.length).toBe(filing.filed);

      // Vocabulary tokens, absent-not-0: qa-findings-retained exists for the
      // two legs that ran (ran-and-none keeps documentIds PRESENT as []), and
      // the non-ran diff-scope leg emitted NO line at all — absent, not 0.
      const retainedLines = lines.filter((l) => l.operation === QA_LOG.findingsRetained);
      expect(retainedLines.length).toBe(2);
      const idsLines = retainedLines.map((l) => l.documentIds);
      expect(idsLines.some((d) => Array.isArray(d) && d.length === 0)).toBe(true);
      expect(idsLines.some((d) => Array.isArray(d) && d.length === 2)).toBe(true);
      const issuedLines = lines.filter((l) => l.operation === QA_LOG.issuesFiled);
      expect(issuedLines.length).toBe(1);
      expect(issuedLines[0]?.count).toBe(filing.filed);

      // Verdict folded into the payload.
      expect(payload.verdict?.status).toBe("approved");
      expect(payload.verdict?.escalated).toBe(true);
      expect(payload.verdict?.qaRunId).toBe(legs[0]?.runId);
    } finally {
      restore();
      audit.close();
    }
  });
});
