#!/usr/bin/env bun
/**
 * P0.9 leg `changed-content-upsert` (issue #408 work-item 2 remainder) — the
 * document_id upsert UPDATE path, measured, never assumed.
 *
 * The 2026-10-04 `document-id-retain-twice` evidence retained the SAME
 * document_id with IDENTICAL content and set `upsertObserved: true` — an
 * overstatement p0-9-closure/README.md corrects: that run proves only that an
 * identical re-retain is a no-op creating no duplicate. The UPDATE half of
 * the upsert needs a second retain whose content DIFFERS, plus a read-back.
 * This leg is that probe.
 *
 * Sequence (one disposable bank, deleted in a `finally`):
 *   1. retain VERSION-ONE content under an explicit `qds-`-prefixed
 *      document_id (the upsert identity — client refuses updateMode without
 *      one, and an empty identity must never ride the wire).
 *   2. recall on a v1-distinctive query — the honest baseline: the document
 *      exists and its v1 text is retrievable.
 *   3. retain VERSION-TWO content under the SAME document_id.
 *   4. recall on a v2-distinctive query — the read-back: among hits carrying
 *      the document's identity, v2 text present AND no v1 text AND exactly
 *      one identity hit = the update landed; both texts or multiple identity
 *      hits = ambiguous (duplicate/stale), never a measured update; no hits
 *      with the identity = the upsert is unproven.
 * `upsertObserved` is TRUE only for the first shape. The leg MEASURES, it
 * does not gate (auth-retired-check precedent): ok tracks the probe-bank
 * cleanup, the recorded fields carry the answer.
 *
 * INV-MEM-1: bank + document ids `qds-`-prefixed via leg-lib
 * assertQdsRepoSlug. Live runs gate on leg-lib scanLiveShapePrereq before any
 * instance traffic (F-022, mock exempt). Tokens/keys never appear in
 * evidence (maskTail on every detail; credentials never recorded — the
 * client carries them from env itself).
 *
 * Output: one timestamped evidence JSON (leg-lib writeEvidenceOrStderr; on
 * write failure the payload lands on stderr, F-030) with `probeBankId`,
 * `documentId`, `retainOne`/`retainTwo` {measured, answered, status?, usage?,
 * detail?}, `readBack` {measured, hits, withIdentity, sawV2, sawV1, detail?},
 * `upsertObserved` + the captured stderrTail (F-024), plus
 * `{event:"p0-9-leg"}` stderr lines.
 * Exit: 0 probes recorded (whatever they measured) / 1 probe-bank cleanup
 *      delete failed (the disposable bank may remain) / 2 fatal refusal (env
 *      guard, wrong-instance trap, missing live shape prereq (F-022),
 *      non-qds bank id (F-004)).
 * Run: bun scripts/p0-9/changed-content-upsert.ts
 *      (HINDSIGHT_BASE_URL required; HINDSIGHT_LEG_MODE=mock for rehearsal)
 */
import {
  assertQdsRepoSlug,
  forbiddenOrigin,
  legLog,
  maskTail,
  rand6,
  requireBaseUrl,
  sanitizeOrigin,
  scanLiveShapePrereq,
  writeEvidenceOrStderr,
  type LegDeps,
  type LegEvidence,
  type LegMode,
  type LegStepRecord,
} from "./leg-lib.ts";
import { HindsightClient } from "../../src/hindsight/index.ts";

/** Issue-#408 remainder leg slug (evidence filename component). */
const LEG = "p0-9-changed-content-upsert";

/** The retained document identity — explicit, `qds-`-prefixed, unique per run. */
const DOCUMENT_ID_PREFIX = "qds-ccupsert-doc";

/** Structural view of the collaborator the leg drives (deps.client is `unknown`). */
interface UpsertClient {
  createBank?: (bankId: string) => Promise<unknown>;
  retain: (
    bankId: string,
    content: string,
    metadata?: { documentId?: string; updateMode?: "replace"; source?: string },
  ) => Promise<unknown>;
  recall: (bankId: string, query: string, limit?: number) => Promise<unknown>;
  deleteBank?: (bankId: string) => Promise<{ deleted: boolean; alreadyGone: boolean; deletedCount?: number }>;
}

interface RetainOutcome {
  /** The retain call completed without throwing (any status semantics absorbed by the client). */
  measured: boolean;
  /** The client returned a view (no transport/validation throw). */
  answered: boolean;
  usage?: { input: number; output: number };
  detail?: string;
}

interface ReadBack {
  measured: boolean;
  /** Total hits returned for the probe query. */
  hits: number;
  /** Hits carrying the probe document's identity. */
  withIdentity: number;
  sawV2: boolean;
  sawV1: boolean;
  detail?: string;
}

interface CleanupOutcome {
  outcome: "deleted" | "already-gone" | "skipped" | "failed";
  detail?: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** F-024: one p0-9-leg line emitted AND captured (the evidence stderrTail's source). */
type Log = (entry: { step?: string; bankId?: string; documentId?: string; durationMs?: number; outcome: string }) => void;

function makeLog(leg: string, logLines: string[]): Log {
  return (entry) => {
    logLines.push(JSON.stringify({ event: "p0-9-leg", leg, ...entry }));
    legLog({ leg, ...entry });
  };
}

/** F-001/F-002 companion: a deps-carried origin gets the env path's trim + slash-strip (checked value = used value). */
function normalizeOriginValue(origin: string): string {
  let s = origin.trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/**
 * Read a recall view's results leniently: the transformed schema view carries
 * `{memoryId, content, score, documentId}`, but an injected fake may return
 * the older `{content, score}` items — identity matching tolerates both
 * spellings rather than fabricating a miss.
 */
function recallResults(raw: unknown): Array<{ content: string; documentId: string | null }> {
  if (raw === null || typeof raw !== "object") return [];
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const item = (r ?? {}) as Record<string, unknown>;
    const content = typeof item.content === "string" ? item.content : "";
    const doc = item.documentId;
    const documentId = typeof doc === "string" && doc !== "" ? doc : null;
    return { content, documentId };
  });
}

function usageOf(raw: unknown): RetainOutcome["usage"] {
  if (raw === null || typeof raw !== "object") return undefined;
  const usage = (raw as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
  return input !== undefined && output !== undefined ? { input, output } : undefined;
}

/** F-001/F-002/F-029 fatal shape (auth-retired-check precedent). */
function fatalEvidence(
  mode: LegMode,
  origin: string,
  outcome: string,
  stepName: string,
  log: Log,
  logLines: string[],
): LegEvidence {
  log({ outcome: "fatal" });
  return {
    leg: LEG,
    mode,
    ok: false,
    outcome,
    steps: [{ step: stepName, outcome: "fatal", detail: outcome }],
    // R2-015: userinfo-stripped when an origin was resolved; "" stays "".
    origin: origin === "" ? "" : sanitizeOrigin(origin),
    exitCode: 2,
    stdoutTail: "",
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
  };
}

/**
 * The leg body. Network-touching collaborators are injectable (`client`);
 * tests inject and never hit the network. Resolves LegEvidence for every
 * leg-level outcome including fatal refusals (exitCode 2).
 */
export async function runLeg(deps: Partial<LegDeps> = {}): Promise<LegEvidence> {
  const mode: LegMode = deps.mode ?? "live";
  const logLines: string[] = [];
  const log = makeLog(LEG, logLines);

  // --- baseUrl: deps override ("" ≡ unset, F-029), else env BY NAME, fail-closed ---
  let baseUrl = deps.baseUrl;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    try {
      baseUrl = requireBaseUrl(process.env as Record<string, string | undefined>);
    } catch (e) {
      return fatalEvidence(mode, "", `fatal: ${errMessage(e)}`, "env", log, logLines);
    }
  } else {
    baseUrl = normalizeOriginValue(baseUrl);
  }
  const trap = forbiddenOrigin(baseUrl);
  if (trap !== null) {
    return fatalEvidence(mode, baseUrl, `fatal: ${trap}`, "env", log, logLines);
  }

  // --- F-022: AC1 ordering — a live leg consumes the instance only after a
  // live-stamped hindsight-live shape-check evidence exists (mock exempt).
  if (mode === "live") {
    const prereq = scanLiveShapePrereq({
      mode,
      ...(deps.outDir !== undefined ? { outDir: deps.outDir } : {}),
    });
    if (!prereq.ok) {
      return fatalEvidence(mode, baseUrl, `fatal: ${prereq.reason}`, "prereq", log, logLines);
    }
    log({ step: "prereq", outcome: "ok" });
  }

  const client = (
    deps.client !== undefined
      ? deps.client
      : new HindsightClient({ baseUrl, mode: mode === "live" ? "live" : "mock" })
  ) as UpsertClient;

  // Explicit qds- prefix (INV-MEM-1) via the shared prefix gate (F-004);
  // timestamped so reruns never collide.
  const runTag = rand6();
  let probeBankId: string;
  try {
    probeBankId = assertQdsRepoSlug(`qds-ccupsert-${deps.now?.() ?? Date.now()}`);
  } catch (e) {
    return fatalEvidence(mode, baseUrl, `fatal: ${errMessage(e)}`, "bank-id", log, logLines);
  }
  const documentId = `${DOCUMENT_ID_PREFIX}-${runTag}`;
  // Version markers share the run tag (pairing) and differ in the VERSION
  // token (deterministic recall matching — a query on the marker retrieves
  // exactly the version that carries it).
  const contentV1 = `p0-9 changed-content upsert probe ${runTag} VERSION-ONE marker ${runTag}`;
  const contentV2 = `p0-9 changed-content upsert probe ${runTag} VERSION-TWO marker ${runTag}`;
  const steps: LegStepRecord[] = [];
  log({ outcome: "start", bankId: probeBankId, documentId });

  // --- probe-bank create before probing (F-007: existence-confound removal;
  // lazy-create tolerated when no createBank exists). ---
  if (typeof client.createBank === "function") {
    try {
      await client.createBank(probeBankId);
      steps.push({ step: "probe-create", outcome: "ok" });
      log({ step: "probe-create", bankId: probeBankId, outcome: "ok" });
    } catch (e) {
      steps.push({ step: "probe-create", outcome: "failed", detail: errMessage(e) });
      log({ step: "probe-create", bankId: probeBankId, outcome: "failed" });
    }
  } else {
    steps.push({
      step: "probe-create",
      outcome: "skipped-no-client (0.10.0 retain lazy-creates)",
    });
  }

  let retainOne: RetainOutcome = { measured: false, answered: false, detail: "not attempted" };
  let recallOne: ReadBack = { measured: false, hits: 0, withIdentity: 0, sawV2: false, sawV1: false, detail: "not attempted" };
  let retainTwo: RetainOutcome = { measured: false, answered: false, detail: "not attempted" };
  let recallTwo: ReadBack = { measured: false, hits: 0, withIdentity: 0, sawV2: false, sawV1: false, detail: "not attempted" };
  let cleanup: CleanupOutcome = { outcome: "skipped" };

  try {
    // --- 1. retain VERSION-ONE under the explicit identity -------------------
    try {
      const r1 = await client.retain(probeBankId, contentV1, {
        documentId,
        updateMode: "replace",
        source: "agent",
      });
      retainOne = { measured: true, answered: true, ...(usageOf(r1) !== undefined ? { usage: usageOf(r1) } : {}) };
      steps.push({ step: "retain-v1", outcome: "ok" });
      log({ step: "retain-v1", bankId: probeBankId, documentId, outcome: "ok" });
    } catch (e) {
      retainOne = { measured: false, answered: false, detail: maskTail(errMessage(e)) };
      steps.push({ step: "retain-v1", outcome: "fail", detail: maskTail(errMessage(e)) });
      log({ step: "retain-v1", outcome: "fail" });
    }

    // --- 2. baseline recall: v1 text retrievable under the identity ---------
    if (retainOne.answered) {
      try {
        const q1 = recallResults(await client.recall(probeBankId, `VERSION-ONE marker ${runTag}`, 10));
        const mine = q1.filter((r) => r.documentId === documentId);
        recallOne = {
          measured: true,
          hits: q1.length,
          withIdentity: mine.length,
          sawV2: mine.some((r) => r.content.includes("VERSION-TWO marker")),
          sawV1: mine.some((r) => r.content.includes("VERSION-ONE marker")),
        };
        steps.push({
          step: "recall-baseline",
          outcome: `hits=${recallOne.hits} identity=${recallOne.withIdentity} v1=${recallOne.sawV1}`,
        });
        log({ step: "recall-baseline", outcome: "ok" });
      } catch (e) {
        recallOne = { measured: false, hits: 0, withIdentity: 0, sawV2: false, sawV1: false, detail: maskTail(errMessage(e)) };
        steps.push({ step: "recall-baseline", outcome: "fail", detail: maskTail(errMessage(e)) });
        log({ step: "recall-baseline", outcome: "fail" });
      }
    } else {
      steps.push({ step: "recall-baseline", outcome: "skipped (retain v1 unmeasured)" });
    }

    // --- 3. retain VERSION-TWO, SAME identity, DIFFERENT content ------------
    if (retainOne.answered) {
      try {
        const r2 = await client.retain(probeBankId, contentV2, {
          documentId,
          updateMode: "replace",
          source: "agent",
        });
        retainTwo = { measured: true, answered: true, ...(usageOf(r2) !== undefined ? { usage: usageOf(r2) } : {}) };
        steps.push({ step: "retain-v2", outcome: "ok" });
        log({ step: "retain-v2", bankId: probeBankId, documentId, outcome: "ok" });
      } catch (e) {
        retainTwo = { measured: false, answered: false, detail: maskTail(errMessage(e)) };
        steps.push({ step: "retain-v2", outcome: "fail", detail: maskTail(errMessage(e)) });
        log({ step: "retain-v2", outcome: "fail" });
      }
    } else {
      steps.push({ step: "retain-v2", outcome: "skipped (retain v1 unmeasured)" });
    }

    // --- 4. read-back recall: which version does the identity carry now? ----
    if (retainTwo.answered) {
      try {
        const q2 = recallResults(await client.recall(probeBankId, `VERSION-TWO marker ${runTag}`, 10));
        const mine = q2.filter((r) => r.documentId === documentId);
        recallTwo = {
          measured: true,
          hits: q2.length,
          withIdentity: mine.length,
          sawV2: mine.some((r) => r.content.includes("VERSION-TWO marker")),
          sawV1: mine.some((r) => r.content.includes("VERSION-ONE marker")),
        };
        steps.push({
          step: "recall-read-back",
          outcome: `hits=${recallTwo.hits} identity=${recallTwo.withIdentity} v2=${recallTwo.sawV2} v1=${recallTwo.sawV1}`,
        });
        log({ step: "recall-read-back", outcome: "ok" });
      } catch (e) {
        recallTwo = { measured: false, hits: 0, withIdentity: 0, sawV2: false, sawV1: false, detail: maskTail(errMessage(e)) };
        steps.push({ step: "recall-read-back", outcome: "fail", detail: maskTail(errMessage(e)) });
        log({ step: "recall-read-back", outcome: "fail" });
      }
    } else {
      steps.push({ step: "recall-read-back", outcome: "skipped (retain v2 unmeasured)" });
    }
  } finally {
    // --- finally-delete: ALWAYS attempted once the probe bank was named ----
    if (typeof client.deleteBank === "function") {
      try {
        const r = await client.deleteBank(probeBankId);
        cleanup = { outcome: r.alreadyGone ? "already-gone" : "deleted" };
      } catch (e) {
        cleanup = { outcome: "failed", detail: maskTail(errMessage(e)) };
      }
    } else {
      cleanup = { outcome: "skipped", detail: "client exposes no deleteBank" };
    }
    steps.push({ step: "cleanup", outcome: `delete ${cleanup.outcome}` });
    log({ step: "cleanup", bankId: probeBankId, outcome: cleanup.outcome });
  }

  // The upsert verdict, from the measured read-back only:
  //   update landed  = v2 present AND v1 gone under the identity;
  //   ambiguous      = both versions visible (duplicate or stale copy);
  //   unproven       = identity absent from the read-back (recall is semantic;
  //                    a no-hit says nothing about the stored document).
  const upsertObserved =
    recallTwo.measured && recallTwo.sawV2 && !recallTwo.sawV1 && recallTwo.withIdentity === 1;
  const ok = cleanup.outcome !== "failed";
  const outcome = !ok
    ? `fail: probe-bank delete failed${cleanup.detail !== undefined ? ` — ${cleanup.detail}` : ""} (the disposable bank may remain; the probe bank must not outlive the leg)`
    : !recallTwo.measured
      ? `pass: read-back UNMEASURED (upsertObserved=false) — ${retainTwo.answered ? "read-back recall threw" : "retain v2 never completed"}; the record documents the upsert probe honestly without asserting an update; probe bank cleanup: ${cleanup.outcome}`
      : upsertObserved
        ? `pass: changed-content upsert OBSERVED — same document_id, different content, read-back carries VERSION-TWO only (identity hits=${recallTwo.withIdentity}); the update half of the upsert is measured (complements document-id-retain-twice's identical-content no-duplicate check); probe bank cleanup: ${cleanup.outcome}`
        : recallTwo.withIdentity === 0
          ? `pass: read-back carried NO hit under the probe identity (upsertObserved=false, unproven) — recall is semantic and a no-hit asserts nothing about the stored document; probe bank cleanup: ${cleanup.outcome}`
          : `pass: read-back AMBIGUOUS (upsertObserved=false) — identity hits=${recallTwo.withIdentity}, v2=${String(recallTwo.sawV2)}, v1=${String(recallTwo.sawV1)}; both versions visible is a duplicate or stale copy, never a measured update; probe bank cleanup: ${cleanup.outcome}`;
  log({ outcome: ok ? "ok" : "fail" });

  return {
    leg: LEG,
    mode,
    ok,
    outcome,
    steps,
    // R2-015: recorded userinfo-stripped (a creds-bearing origin must never
    // land in closure evidence).
    origin: sanitizeOrigin(baseUrl),
    exitCode: ok ? 0 : 1,
    stdoutTail: "",
    // F-024: the captured p0-9-leg lines, masked (INV-HM1)
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
    probeBankId,
    documentId,
    retainOne,
    recallBaseline: recallOne,
    retainTwo,
    readBack: recallTwo,
    upsertObserved,
  };
}

/**
 * Thin main: env → deps → runLeg → evidence → stderr path line → exitCode.
 * F-030: a failing evidence write dumps the payload to stderr and exits fatal.
 * R2-006: on the LIVE path main CONSTRUCTS the client (baseUrl-threaded via
 * requireBaseUrl, mode live) and passes it as deps.client so the retains
 * actually run on the box.
 */
async function main(): Promise<void> {
  const mode: LegMode = process.env.HINDSIGHT_LEG_MODE === "mock" ? "mock" : "live";
  let client: HindsightClient | undefined;
  if (mode === "live") {
    try {
      const baseUrl = requireBaseUrl(process.env as Record<string, string | undefined>);
      client = new HindsightClient({ baseUrl, mode: "live" });
    } catch {
      // env unset / trap — runLeg records the fatal-env evidence below
    }
  }
  const ev = await runLeg({ mode, ...(client !== undefined ? { client } : {}) });
  const { path: file, fellBack } = writeEvidenceOrStderr(LEG, ev);
  if (!fellBack) process.stderr.write(`${file}\n`);
  process.exitCode = fellBack ? 2 : ev.exitCode;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `${LEG} fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
  });
}
