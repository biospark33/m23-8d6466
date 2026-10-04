#!/usr/bin/env bun
/**
 * P0.9 leg `negative-probes` (transport re-homed; story M1.1 AC5).
 *
 * The two refusal proofs, with ZERO banks created on either:
 *   - nonexistent bank: reads against `qds-does-not-exist-<rand>` must refuse
 *     with `HindsightHttpError` 404 (the MCP-era -32001-class supersession on
 *     REST). Track A correction (0.10.0 source, binding): the recall path has
 *     NO `_require_bank_exists` — recall on a missing bank answers 200 EMPTY,
 *     not 404 — so the refusing read is the bank PROFILE endpoint
 *     (`GET /v1/default/banks/{id}/profile`), and the recall's empty-200 is
 *     pre-recorded honestly as its own class so VPS-day evidence reads
 *     consistent, not contradictory.
 *   - unavailable instance: one request against an origin nothing answers,
 *     expecting the -32002-class supersession shapes — 502 / fetch_failed /
 *     408 (the client's own transport mapping, src/lib/http.ts
 *     onTransportError, mirrored by this driver's classifier). R2-013: only
 *     TRANSPORT-error/timeout classes prove unavailability — an HTTP response
 *     of ANY status on the down URL means something answered and the probe is
 *     unproven (leg fails; class records http_<status>).
 *
 * Green-by-default is impossible: a probe that ANSWERS (no refusal) fails the
 * leg. The zero-banks claim is diffed, not assumed — `listBanks` snapshots
 * before and after must be identical, and this driver never calls `createBank`.
 * R2-017: `listBanks` is a REQUIRED collaborator method — a client without it
 * is a fatal refusal, never a vacuous [] snapshot.
 *
 * Clause map: story AC5; INV-MEM-1 (probe bank ids `qds-`-prefixed); env
 * discipline — `HINDSIGHT_BASE_URL` by name, fail-closed (requireBaseUrl),
 * wrong-instance trap ports refused (forbiddenOrigin), `deps.baseUrl === ""`
 * treated as unset (F-029); the down-instance probe TARGET lives in leg-lib
 * (PROBE_DOWN_URL_DEFAULT, F-021) — the sanctioned home AC1's no-host:port
 * rule names; bank-id extraction via leg-lib extractBankIds (F-006); live
 * runs gate on leg-lib scanLiveShapePrereq before any instance traffic
 * (F-022, mock exempt).
 *
 * Output: one timestamped evidence JSON (leg-lib writeEvidenceOrStderr; on
 * write failure the payload lands on stderr, F-030) with `refusals:
 * Array<{name, class, detail?}>` + the roster diff + the captured stderrTail
 * (F-024), plus `{event:"p0-9-leg"}` stderr lines.
 * Exit: 0 both probes refused, zero banks created / 1 any probe answered or
 *      the roster diff is non-empty / 2 fatal refusal (env guard, trap port,
 *      missing live shape prereq).
 * Run: bun scripts/p0-9/negative-probes.ts
 *      (HINDSIGHT_BASE_URL required; HINDSIGHT_LEG_MODE=mock: hermetic
 *      rehearsal — records the down-instance probe as skipped/unproven and
 *      exits 1 DELIBERATELY, fail-closed per R2-003 (no transport is ever
 *      fabricated from env); a green rehearsal requires an injected
 *      fetchImpl/client (deps), which only the test harness provides;
 *      QDS_PROBE_DOWN_URL optional override of the down-instance origin)
 */
import {
  extractBankIds,
  forbiddenOrigin,
  legLog,
  maskTail,
  PROBE_DOWN_URL_DEFAULT,
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
import { HindsightClient, HindsightHttpError } from "../../src/hindsight/index.ts";

/** The closure plan's own leg slug (evidence filename component). */
const LEG = "p0-9-negative-probes";

/** Per-attempt budget for the down-instance probe (AbortController, not a hang). */
const PROBE_DOWN_TIMEOUT_MS = 5_000;

interface Refusal {
  name: string;
  class: string;
  detail?: string;
}

/**
 * Minimal structural view of the bank-listing/recall client (deps.client is
 * `unknown`). R2-017: listBanks is REQUIRED — an injected collaborator
 * without it must be a fatal refusal, never a vacuous [] snapshot standing
 * in as the zero-banks proof.
 */
interface ListRecallClient {
  listBanks: () => Promise<unknown>;
  recall?: (bankId: string, query: string, limit?: number) => Promise<unknown>;
  request?: (method: string, path: string, body?: unknown) => Promise<unknown>;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** F-024: one p0-9-leg line emitted AND captured (the evidence stderrTail's source). */
type Log = (entry: { step?: string; bankId?: string; durationMs?: number; outcome: string }) => void;

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
 * Classify a transport failure into the -32002-class supersession vocabulary
 * (502 / fetch_failed / 408) — mirroring the client's own onTransportError
 * mapping so driver-recorded classes and client-thrown HindsightHttpError
 * statuses read as one vocabulary.
 */
function classifyTransport(e: unknown): string {
  if (e instanceof HindsightHttpError) {
    if (e.status === 408) return "408-timeout";
    if (e.status === 502) return "502-bad-gateway";
    return `http_${e.status}`;
  }
  if (e instanceof Error) {
    if (e.name === "AbortError") return "408-timeout";
    if (/fetch failed/i.test(e.message)) return "fetch_failed";
  }
  return "transport-error";
}

/** One fetch under an AbortController budget — a blackholed target must 408, not hang. */
async function fetchWithBudget(
  f: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await f(url, { method: "GET", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function fatalEvidence(
  mode: LegMode,
  origin: string,
  outcome: string,
  log: Log,
  logLines: string[],
): LegEvidence {
  log({ outcome: "fatal" });
  return {
    leg: LEG,
    mode,
    ok: false,
    outcome,
    steps: [{ step: "env", outcome: "fatal", detail: outcome }],
    // R2-015: userinfo-stripped when an origin was resolved; "" stays "".
    origin: origin === "" ? "" : sanitizeOrigin(origin),
    exitCode: 2,
    stdoutTail: "",
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
  };
}

/**
 * The leg body. Network-touching collaborators are injectable (`client`,
 * `fetchImpl`); tests inject both and never hit the network. A mock rehearsal
 * without an injected fetchImpl stays hermetic: the down-instance probe is
 * recorded as skipped (and therefore unproven → leg fails), never silently
 * green. Resolves LegEvidence for every outcome including fatal (exit 2).
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
      return fatalEvidence(mode, "", `fatal: ${errMessage(e)}`, log, logLines);
    }
  } else {
    baseUrl = normalizeOriginValue(baseUrl);
  }
  const trap = forbiddenOrigin(baseUrl);
  if (trap !== null) {
    return fatalEvidence(mode, baseUrl, `fatal: ${trap}`, log, logLines);
  }

  // --- F-022: AC1 ordering — a live leg consumes the instance only after a
  // live-stamped hindsight-live shape-check evidence exists (mock exempt).
  if (mode === "live") {
    const prereq = scanLiveShapePrereq({
      mode,
      ...(deps.outDir !== undefined ? { outDir: deps.outDir } : {}),
    });
    if (!prereq.ok) {
      return fatalEvidence(mode, baseUrl, `fatal: ${prereq.reason}`, log, logLines);
    }
    log({ step: "prereq", outcome: "ok" });
  }

  // F-002: the constructed client (absent an injected one) carries the
  // resolved, trap-checked baseUrl — never the constructor's silent default.
  const client = (
    deps.client !== undefined
      ? deps.client
      : new HindsightClient({ baseUrl, mode: mode === "live" ? "live" : "mock" })
  ) as ListRecallClient;

  // R2-017: the roster diff is this leg's zero-banks PROOF — a collaborator
  // lacking listBanks would diff [] against [] and pass vacuously. Fatal.
  if (typeof client.listBanks !== "function") {
    return fatalEvidence(
      mode,
      baseUrl,
      "fatal: the client exposes no listBanks — the zero-banks proof cannot run (a missing method is a fatal refusal, never a vacuous [] snapshot)",
      log,
      logLines,
    );
  }

  // --- down-instance probe target (setup: trap-checked like any origin) ---
  const downOrigin = process.env.QDS_PROBE_DOWN_URL ?? PROBE_DOWN_URL_DEFAULT;
  const downTrap = forbiddenOrigin(downOrigin);
  if (downTrap !== null) {
    // A trap port as the DOWN target would CONNECT to the shared sidecar /
    // tenant stack to "prove" unavailability — refused like any other trap.
    return fatalEvidence(mode, baseUrl, `fatal: QDS_PROBE_DOWN_URL ${downTrap}`, log, logLines);
  }

  const missingBankId = `qds-does-not-exist-${rand6()}`;
  const refusals: Refusal[] = [];
  const steps: LegStepRecord[] = [];
  log({ outcome: "start", bankId: missingBankId });

  // --- zero-banks window opens: pre-probe roster snapshot ------------------
  let banksBefore: string[] = [];
  try {
    banksBefore = extractBankIds(await client.listBanks());
    steps.push({ step: "listBanks", outcome: "ok", detail: `${banksBefore.length} bank(s)` });
  } catch (e) {
    return buildEvidence(mode, baseUrl, missingBankId, downOrigin, refusals, steps, false, banksBefore, [], `fail: pre-probe listBanks threw: ${errMessage(e)}`, 1, logLines);
  }
  log({ step: "listBanks", outcome: "ok" });

  // --- probe A: nonexistent bank --------------------------------------------
  // The refusal may surface on either read; a 404 on EITHER proves it.
  let bankProbeRefused = false;
  let bankProbeAnswered = false;

  // A1 — recall on the missing bank. 0.10.0 answers 200-empty here (Track A);
  // a 404 (the fake's modeled REST-era refusal) also proves the probe.
  try {
    const raw = await client.recall?.(missingBankId, "negative-probe", 5);
    const results =
      raw !== null && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results)
        ? ((raw as { results: unknown[] }).results as unknown[])
        : undefined;
    if (results === undefined) {
      refusals.push({
        name: "recall-missing-bank",
        class: "unparseable-response",
        detail: maskTail(errMessage(raw)),
      });
      steps.push({ step: "recall", outcome: "fail unparseable recall response" });
    } else if (results.length === 0) {
      refusals.push({
        name: "recall-missing-bank",
        class: "recall-missing-bank-empty-200",
        detail:
          "0.10.0 recall path has no _require_bank_exists: recall on a MISSING bank answers 200 " +
          "with empty results (Track A) — pre-recorded so the evidence reads consistent; the " +
          "REFUSING read is the bank profile endpoint (missing-bank-profile-read)",
      });
      steps.push({ step: "recall", outcome: "answered-empty-200 (pre-recorded 0.10.0 nuance)" });
    } else {
      bankProbeAnswered = true;
      refusals.push({
        name: "recall-missing-bank",
        class: "recall-missing-bank-answered-nonempty",
        detail: `recall on a missing bank returned ${results.length} result(s) — mis-behaved probe`,
      });
      steps.push({ step: "recall", outcome: "fail answered with results" });
    }
  } catch (e) {
    if (e instanceof HindsightHttpError) {
      refusals.push({
        name: "recall-missing-bank",
        class: `http_${e.status}`,
        detail: maskTail(e.message),
      });
      if (e.status === 404) bankProbeRefused = true;
      steps.push({ step: "recall", outcome: `refused http_${e.status}` });
    } else {
      refusals.push({
        name: "recall-missing-bank",
        class: "error",
        detail: maskTail(errMessage(e)),
      });
      steps.push({ step: "recall", outcome: "fail error" });
    }
  }
  log({ step: "recall", outcome: bankProbeAnswered ? "answered" : "recorded" });

  // A2 — profile read, the 0.10.0 REFUSING read (404 via _require_bank_exists).
  // Only when the client exposes raw `request` (the real HindsightClient does;
  // injected fakes model the refusal on recall instead — tests/p0-9 contract).
  if (typeof client.request === "function") {
    try {
      await client.request("GET", `/v1/default/banks/${missingBankId}/profile`);
      bankProbeAnswered = true;
      refusals.push({
        name: "missing-bank-profile-read",
        class: "answered-2xx",
        detail: "profile read on a missing bank ANSWERED — mis-behaved probe",
      });
      steps.push({ step: "bank-profile-read", outcome: "fail answered" });
    } catch (e) {
      if (e instanceof HindsightHttpError) {
        refusals.push({
          name: "missing-bank-profile-read",
          class: `http_${e.status}`,
          detail: maskTail(e.message),
        });
        if (e.status === 404) bankProbeRefused = true;
        steps.push({ step: "bank-profile-read", outcome: `refused http_${e.status}` });
      } else {
        refusals.push({
          name: "missing-bank-profile-read",
          class: classifyTransport(e),
          detail: maskTail(errMessage(e)),
        });
        steps.push({ step: "bank-profile-read", outcome: "fail transport/error" });
      }
    }
    log({ step: "bank-profile-read", outcome: "recorded" });
  } else {
    steps.push({
      step: "bank-profile-read",
      outcome: "skipped: injected client exposes no raw request — recall carries the probe",
    });
  }

  // --- probe B: unavailable instance ----------------------------------------
  let downRefused = false;
  let downAnswered = false;
  if (deps.fetchImpl !== undefined || mode === "live") {
    const f = deps.fetchImpl ?? fetch;
    try {
      const res = await fetchWithBudget(f, downOrigin, PROBE_DOWN_TIMEOUT_MS);
      // R2-013: an HTTP RESPONSE — ANY status, even 5xx — means SOMETHING
      // answered on the down URL (a gateway-fronted QDS_PROBE_DOWN_URL
      // override, a misrouted target): instance-unavailability is unproven
      // and the leg fails honestly. Sound on the loopback-discard default
      // (nothing legitimately listens there, so a refusal IS a transport
      // error); unsound to generalize a 502 from an override to "instance
      // down". Only transport-error/timeout classes prove this probe.
      downAnswered = true;
      refusals.push({
        name: "unavailable-instance",
        class: `http_${res.status}`,
        detail: `GET ${downOrigin} answered HTTP ${res.status} — an answer on the down URL (any status) leaves the unavailability probe unproven`,
      });
      steps.push({ step: "down-instance-probe", outcome: `fail answered http_${res.status}` });
    } catch (e) {
      // A transport failure IS the expected unavailable-instance refusal
      // (R2-013: ONLY these classes prove it — refused connection on the
      // loopback-discard default, a blackhole's 408, a dead route's
      // fetch_failed).
      const cls = classifyTransport(e);
      if (cls.startsWith("http_")) {
        // Defensive symmetry: an HTTP-shaped class out of a raw-fetch catch
        // means something answered after all — unproven, not refused.
        downAnswered = true;
        refusals.push({ name: "unavailable-instance", class: cls, detail: maskTail(errMessage(e)) });
        steps.push({ step: "down-instance-probe", outcome: `fail answered ${cls}` });
      } else {
        downRefused = true;
        refusals.push({
          name: "unavailable-instance",
          class: cls,
          detail: maskTail(errMessage(e)),
        });
        steps.push({ step: "down-instance-probe", outcome: `refused ${cls}` });
      }
    }
    log({ step: "down-instance-probe", outcome: downAnswered ? "answered" : "refused" });
  } else {
    refusals.push({
      name: "unavailable-instance",
      class: "skipped-mock-no-fetchImpl",
      detail:
        "mock rehearsal without an injected fetchImpl stays hermetic (no network); the probe is unproven",
    });
    steps.push({ step: "down-instance-probe", outcome: "skipped (hermetic mock)" });
  }

  // --- zero-banks window closes: post-probe roster diff --------------------
  let banksAfter: string[] = [];
  try {
    banksAfter = extractBankIds(await client.listBanks());
    steps.push({ step: "listBanks", outcome: "ok", detail: `${banksAfter.length} bank(s)` });
  } catch (e) {
    return buildEvidence(mode, baseUrl, missingBankId, downOrigin, refusals, steps, false, banksBefore, [], `fail: post-probe listBanks threw: ${errMessage(e)}`, 1, logLines);
  }
  log({ step: "listBanks", outcome: "ok" });
  const banksCreated = banksAfter.filter((id) => !banksBefore.includes(id));
  const rosterUnchanged =
    banksCreated.length === 0 &&
    banksBefore.length === banksAfter.length &&
    [...banksBefore].sort().join("\n") === [...banksAfter].sort().join("\n");

  const failures: string[] = [];
  if (!bankProbeRefused) failures.push("nonexistent-bank probe did not refuse with 404");
  if (bankProbeAnswered) failures.push("nonexistent-bank probe ANSWERED");
  if (!downRefused) failures.push("unavailable-instance probe did not refuse");
  if (downAnswered) failures.push("unavailable-instance probe ANSWERED");
  if (!rosterUnchanged) failures.push(`roster changed: created ${JSON.stringify(banksCreated)}`);

  const ok = failures.length === 0;
  const outcome = ok
    ? "pass: nonexistent-bank refused (404 class) and unavailable-instance refused (502/fetch_failed/408 class); zero banks created"
    : `fail: ${failures.join("; ")}`;
  return buildEvidence(mode, baseUrl, missingBankId, downOrigin, refusals, steps, ok, banksBefore, banksAfter, outcome, ok ? 0 : 1, logLines);
}

function buildEvidence(
  mode: LegMode,
  origin: string,
  missingBankId: string,
  downOrigin: string,
  refusals: Refusal[],
  steps: LegStepRecord[],
  ok: boolean,
  banksBefore: string[],
  banksAfter: string[],
  outcome: string,
  exitCode: number,
  logLines: string[],
): LegEvidence {
  legLog({ leg: LEG, outcome: ok ? "ok" : exitCode === 2 ? "fatal" : "fail" });
  logLines.push(JSON.stringify({ event: "p0-9-leg", leg: LEG, outcome: ok ? "ok" : exitCode === 2 ? "fatal" : "fail" }));
  return {
    leg: LEG,
    mode,
    ok,
    outcome,
    steps,
    // R2-015: userinfo-stripped when an origin was resolved; "" stays "".
    origin: origin === "" ? "" : sanitizeOrigin(origin),
    exitCode,
    stdoutTail: "",
    // F-024: the captured p0-9-leg lines, masked (INV-HM1)
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
    missingBankId,
    // R2-015: the probe target is evidence too — recorded userinfo-stripped
    // (a creds-bearing QDS_PROBE_DOWN_URL must never land in the JSON).
    downOrigin: sanitizeOrigin(downOrigin),
    banksBefore,
    banksAfter,
    banksCreated: banksAfter.filter((id) => !banksBefore.includes(id)),
    refusals,
  };
}

/**
 * Thin main: env → deps → runLeg → evidence → stderr path line → exitCode.
 * F-030: a failing evidence write dumps the payload to stderr and exits fatal.
 */
async function main(): Promise<void> {
  const mode: LegMode = process.env.HINDSIGHT_LEG_MODE === "mock" ? "mock" : "live";
  const ev = await runLeg({ mode });
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
