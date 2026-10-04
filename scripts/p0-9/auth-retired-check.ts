#!/usr/bin/env bun
/**
 * P0.9 leg `auth-retired-check` (story M1.1 AC4) — the no-auth danger,
 * measured, never assumed (INV-MEM-3).
 *
 * The probe bank is CREATED before probing (F-007: via deps.client.createBank
 * when available; otherwise the create is recorded as its own step and the
 * probe proceeds — 0.10.0's retain path lazy-creates, so an unauthenticated
 * probe against a MISSING bank can refuse for existence/validity reasons and
 * fake an auth refusal). Refusals are classified by STATUS CLASS (F-007):
 * 401/403 = auth refusal; 404/422 = non-auth refusal (existence/validity).
 * R3-013: the 0.8.6 danger is the unauthenticated WRITE (retain) answering
 * 200 — dangerRetired:true requires the RETAIN leg specifically refused-auth;
 * a half-measured pair (retain transport-error + recall 401) is
 * class write-leg-unmeasured with the inconclusive verdict, never a
 * retirement. R3-015: both legs transport-error → class not-measured (never
 * refused-unclassified — a refusal classification for a probe that produced
 * no response at all asserts more than was observed).
 *
 * Probes (raw HTTP through `deps.fetchImpl ?? fetch` — the same transport the
 * HindsightClient uses, so tests capture the wire requests directly):
 *   (a) UNAUTHENTICATED retain + recall against the disposable
 *       `qds-probe-<timestamp>` bank (explicit `qds-` prefix, INV-MEM-1,
 *       routed through leg-lib assertQdsRepoSlug, F-004) with NO
 *       Authorization header. The 0.8.6 danger was exactly this call
 *       answering 200; `dangerRetired` is computed from the measurement,
 *       never presupposed. The probe bank is deleted in a `finally` block; a
 *       FAILED delete is recorded and fails the leg.
 *   (b) AUTHENTICATED cross-bank attempt with the instance's OWN credential
 *       (`deps.authHeader`, else a Bearer built from HINDSIGHT_BEARER_TOKEN ||
 *       HINDSIGHT_API_KEY — this instance's env only, never the tenant
 *       stack's hindsight.env; an EMPTY deps.authHeader counts as absent).
 *       A key-known PROOF call (authenticated listBanks-shaped read → 2xx)
 *       runs FIRST, otherwise a refusal could not be attributed to scope vs
 *       key. Track A correction (binding): 0.10.0 auth is INSTANCE-WIDE
 *       (single tenant key, opt-in HINDSIGHT_API_TENANT_EXTENSION) and NO
 *       per-bank authorization exists — so when the known key SUCCEEDS
 *       cross-bank the class is recorded as `not-applicable-authz-absent`
 *       (with status + masked body tail), and the containment statement
 *       carries the weight.
 *   (c) UNKNOWN key: one deliberately-invalid bearer against the same bank —
 *       its 401-vs-2xx is only interpretable given the (b) proof result.
 *
 * The leg MEASURES, it does not gate: an answering unauthenticated probe
 * yields `dangerRetired:false` on a GREEN leg (the verdict field carries the
 * bad news). `measuredCount` + the `all-probes-skipped-hermetic` outcome make
 * a zero-probe hermetic run explicit (F-008). `containmentStatement` is
 * ALWAYS present (INV-MEM-2/3 wording: loopback bind + firewall + the M2
 * gateway while authz is absent).
 *
 * Output: one timestamped evidence JSON (leg-lib writeEvidenceOrStderr; on
 * write failure the payload lands on stderr, F-030) with `authOutcomes
 * {unauthenticated, knownKeyOutOfScope, unknownKey}`, `measuredCount`,
 * `dangerRetired`, `containmentStatement`, `probeBankId` + the captured
 * stderrTail (F-024), plus `{event:"p0-9-leg"}` stderr lines. Tokens/keys
 * NEVER appear in evidence (maskTail on every body tail; credentials recorded
 * only as found/not-found).
 * Exit: 0 probes recorded (whatever they measured) / 1 probe-bank cleanup
 *      delete failed / 2 fatal refusal (env guard, wrong-instance trap,
 *      missing live shape prereq (F-022), non-qds bank id (F-004)).
 * Run: bun scripts/p0-9/auth-retired-check.ts
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

/** Story-added leg slug (evidence filename component). */
const LEG = "p0-9-auth-retired-check";

/** Per-probe budget (AbortController) — a stalled peer must not hang the leg. */
const PROBE_TIMEOUT_MS = 10_000;

/** The single retain item the unauthenticated probe writes (deterministic). */
const UNAUTH_PROBE_CONTENT = "p0-9 auth-retired-check unauthenticated probe (disposable)";

interface AuthProbeOutcome {
  /** 2xx observed. `false` + `measured:false` = not attempted, NOT "refused". */
  answered: boolean;
  /** A response (any status) was actually observed for this probe. */
  measured: boolean;
  /**
   * R3-013 (unauthenticated only): the RETAIN (write) leg produced a
   * response — the leg whose refusal can retire the 0.8.6 write danger.
   */
  writeMeasured?: boolean;
  status?: number;
  class?: string;
  bodyTail?: string;
  detail?: string;
}

interface RawProbe {
  kind: "answered" | "refused" | "error";
  status?: number;
  bodyTail?: string;
  error?: string;
}

interface CleanupOutcome {
  outcome: "deleted" | "already-gone" | "skipped" | "failed";
  detail?: string;
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

/** F-007 status classes: 401/403 = auth refusal; 404/422 = non-auth (existence/validity). */
function isAuthRefusalStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}
function isNonAuthRefusalStatus(status: number | undefined): boolean {
  return status === 404 || status === 422;
}

/** The instance's OWN credential (deps override, empty ≡ absent; env fallback; never recorded raw). */
function deriveCredential(deps: Partial<LegDeps>): string | undefined {
  if (deps.authHeader !== undefined && deps.authHeader !== "") return deps.authHeader;
  const tok = process.env.HINDSIGHT_BEARER_TOKEN || process.env.HINDSIGHT_API_KEY;
  return tok !== undefined && tok !== "" ? `Bearer ${tok}` : undefined;
}

/** One raw HTTP probe under an AbortController budget; never throws. */
async function rawCall(
  f: typeof fetch,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<RawProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await f(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      kind: res.ok ? "answered" : "refused",
      status: res.status,
      bodyTail: maskTail(text.slice(-200)),
    };
  } catch (e) {
    return { kind: "error", error: maskTail(errMessage(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * INV-MEM-2/3: the containment statement is ALWAYS present — wherever authz
 * is absent (or the danger measured still-live), containment-by-topology is
 * stated in the same breath as the verdict, never silent.
 *
 * R2-009: refused-UNCLASSIFIED probes (429/500/proxy-rewritten — a response
 * that is neither an auth-class refusal, a non-auth refusal, nor a 2xx
 * answer) get their own INCONCLUSIVE verdict. Narrating them as ANSWERED
 * asserted a measurement that did not happen; the always-present verdict
 * field must never claim more than the probe observed.
 *
 * R3-013: a half-measured pair (the retain WRITE leg transport-errored while
 * the recall read produced a response) is INCONCLUSIVE — the danger being
 * retired is specifically the unauthenticated WRITE answering 200, and no
 * retirement claim is made from a pair whose write leg never completed.
 */
function buildContainmentStatement(
  dangerRetired: boolean,
  measured: boolean,
  writeMeasured: boolean,
  refusedNonAuth: boolean,
  answered: boolean,
): string {
  const topology =
    "Containment is topological on this instance (INV-MEM-2/3): the dedicated Hindsight " +
    "binds loopback only (host publish 127.0.0.1:18890 per Z4's compose; 18889 stays the " +
    "tenant stack's host map and is never resolved by a factory leg), the box firewall " +
    "admits 22/80/443 only (runbook G2 — 8888/18889/18890 are never published), and the " +
    "M2 memory gateway is the standing authz front door until it lands.";
  const verdict = !measured
    ? "The unauthenticated probe was NOT measured in this run (no transport) — no retirement claim is made."
    : dangerRetired
      ? "Measured verdict: the unauthenticated probe was REFUSED for auth reasons (401/403) — the 0.8.6 no-auth danger is retired on this instance by live evidence."
      : refusedNonAuth
        ? "Measured verdict: the unauthenticated probe was refused for NON-AUTH reasons (existence/validity: 404/422) — the no-auth danger is neither confirmed retired nor demonstrably live; containment carries the weight until an auth-class measurement exists."
        : answered
          ? "Measured verdict: the unauthenticated probe was ANSWERED — the 0.8.6 no-auth danger is NOT retired. 0.10.0 auth is instance-wide (opt-in tenant-key extension) with NO per-bank authorization (Track A), so containment remains loopback bind + firewall + the M2 gateway when it lands — stated here, not hidden."
          : !writeMeasured
            ? "Measured verdict: INCONCLUSIVE — the write leg of the unauthenticated probe was UNMEASURED (the retain transport-errored; only the recall read produced a response): the 0.8.6 danger is specifically the unauthenticated WRITE answering 200, and no retirement claim is made from a half-measured probe pair — containment carries the weight until the write leg is measured."
            : "Measured verdict: INCONCLUSIVE — the unauthenticated probe was refused with an UNCLASSIFIED status (neither auth 401/403, existence/validity 404/422, nor a 2xx answer; e.g. 429/500 or a proxy-rewritten response): the danger is neither retired nor answered, and no verdict is asserted from an unclassifiable refusal — containment carries the weight until a classifiable measurement exists.";
  return `${topology} ${verdict}`;
}

/**
 * Probe-bank cleanup. Prefers `deps.client.deleteBank` (the client's own
 * 404/deleted_count-idempotent semantics); falls back to a raw DELETE through
 * the same transport the probes used (tests inject fetchImpl and no client) —
 * a 200 with `deleted_count:0` maps to already-gone there too (F-007 L3,
 * client.deleteBank vocabulary). A failed delete is reported as `failed` and
 * fails the leg.
 */
async function cleanupProbeBank(
  deps: Partial<LegDeps>,
  f: typeof fetch | undefined,
  baseUrl: string,
  probeBankId: string,
  cred: string | undefined,
): Promise<CleanupOutcome> {
  const c = deps.client as
    | { deleteBank?: (id: string) => Promise<{ deleted: boolean; alreadyGone: boolean; deletedCount?: number }> }
    | undefined;
  if (typeof c?.deleteBank === "function") {
    try {
      const r = await c.deleteBank(probeBankId);
      return { outcome: r.alreadyGone ? "already-gone" : "deleted" };
    } catch (e) {
      return { outcome: "failed", detail: errMessage(e) };
    }
  }
  if (f === undefined) {
    return {
      outcome: "skipped",
      detail: "no transport and no client.deleteBank (hermetic run — nothing was probed or created)",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await f(`${baseUrl}/v1/default/banks/${probeBankId}`, {
      method: "DELETE",
      ...(cred !== undefined ? { headers: { Authorization: cred } } : {}),
      signal: controller.signal,
    });
    if (res.status === 404) return { outcome: "already-gone" };
    if (res.ok) {
      try {
        const body = JSON.parse(await res.text()) as { deleted_count?: unknown };
        if (body.deleted_count === 0) return { outcome: "already-gone" };
      } catch {
        // unparseable body — the 2xx still means the delete landed
      }
      return { outcome: "deleted" };
    }
    return { outcome: "failed", detail: `HTTP ${res.status}` };
  } catch (e) {
    return { outcome: "failed", detail: errMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The leg body. Network-touching collaborators injectable (`fetchImpl`,
 * `client`, `authHeader`); a mock rehearsal without an injected fetchImpl
 * stays hermetic (probes recorded as skipped, never faked). Resolves
 * LegEvidence for every outcome including fatal refusals (exit 2).
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

  const f = deps.fetchImpl ?? (mode === "live" ? fetch : undefined);
  const cred = deriveCredential(deps);
  // Explicit qds- prefix (INV-MEM-1) via the shared prefix gate (F-004);
  // timestamped so reruns never collide.
  let probeBankId: string;
  try {
    probeBankId = assertQdsRepoSlug(`qds-probe-${deps.now?.() ?? Date.now()}`);
  } catch (e) {
    return fatalEvidence(mode, baseUrl, `fatal: ${errMessage(e)}`, "bank-id", log, logLines);
  }

  const steps: LegStepRecord[] = [];
  const unauthUrl = `${baseUrl}/v1/default/banks/${probeBankId}/memories`;
  const recallUrl = `${unauthUrl}/recall`;
  const profileUrl = `${baseUrl}/v1/default/banks/${probeBankId}/profile`;
  const banksUrl = `${baseUrl}/v1/default/banks`;
  log({ outcome: "start", bankId: probeBankId });

  // --- F-007: create the probe bank BEFORE probing (existence-refusal
  // confound removal). deps.client.createBank when available; else the create
  // is recorded as its own step and the probe proceeds (lazy-create path).
  const probeClient = deps.client as { createBank?: (id: string) => Promise<unknown> } | undefined;
  if (typeof probeClient?.createBank === "function") {
    try {
      await probeClient.createBank(probeBankId);
      steps.push({ step: "probe-create", outcome: "ok" });
      log({ step: "probe-create", bankId: probeBankId, outcome: "ok" });
    } catch (e) {
      steps.push({ step: "probe-create", outcome: "failed", detail: errMessage(e) });
      log({ step: "probe-create", bankId: probeBankId, outcome: "failed" });
    }
  } else {
    steps.push({
      step: "probe-create",
      outcome:
        "skipped-no-client (0.10.0 retain lazy-creates; refusal classes below distinguish auth from existence)",
    });
  }

  let unauthenticated: AuthProbeOutcome = {
    answered: false,
    measured: false,
    // R3-015: an unattempted probe is not-measured — never a refusal class.
    class: "not-measured",
    detail: "skipped: no transport (hermetic mock without injected fetchImpl)",
  };
  let keyProof: { attempted: boolean; ok?: boolean; status?: number; error?: string } = {
    attempted: false,
  };
  let knownKeyOutOfScope: AuthProbeOutcome = {
    answered: false,
    measured: false,
    detail: "skipped: no transport (hermetic mock without injected fetchImpl)",
  };
  let unknownKey: AuthProbeOutcome = {
    answered: false,
    measured: false,
    detail: "skipped: no transport (hermetic mock without injected fetchImpl)",
  };
  let cleanup: CleanupOutcome = { outcome: "skipped" };

  try {
    // --- (a) unauthenticated retain + recall — NO Authorization header -----
    if (f !== undefined) {
      const noAuth = { "content-type": "application/json" };
      const retainProbe = await rawCall(f, unauthUrl, "POST", noAuth, {
        items: [{ content: UNAUTH_PROBE_CONTENT }],
      });
      const recallProbe = await rawCall(f, recallUrl, "POST", noAuth, {
        query: "auth retired-check probe",
        limit: 1,
      });
      const answered = retainProbe.kind === "answered" || recallProbe.kind === "answered";
      const describe = (p: RawProbe): string =>
        `${p.kind}${p.status !== undefined ? ` (${p.status})` : ""}${p.error !== undefined ? ` error: ${p.error}` : ""}`;
      // R3-013: the 0.8.6 danger is the unauthenticated WRITE (retain)
      // answering 200 — only the RETAIN leg's own AUTH-class (401/403)
      // refusal can retire it. The old pair-wide OR retired the danger off a
      // recall-only 401 while the write leg transport-errored.
      const retainAuthRefused =
        retainProbe.kind === "refused" && isAuthRefusalStatus(retainProbe.status);
      const retainMeasured = retainProbe.kind !== "error";
      // F-007: a 404/422 refusal (either leg) is an existence/validity
      // refusal and is named refused-non-auth.
      const nonAuthRefused =
        (retainProbe.kind === "refused" && isNonAuthRefusalStatus(retainProbe.status)) ||
        (recallProbe.kind === "refused" && isNonAuthRefusalStatus(recallProbe.status));
      unauthenticated = {
        answered,
        measured: retainProbe.kind !== "error" || recallProbe.kind !== "error",
        writeMeasured: retainProbe.kind !== "error",
        ...(retainProbe.status !== undefined ? { status: retainProbe.status } : {}),
        ...(retainProbe.bodyTail !== undefined ? { bodyTail: retainProbe.bodyTail } : {}),
        // R3-015: both legs transport-error → not-measured (never
        // refused-unclassified). R3-013: write-leg-unmeasured when only the
        // read produced a response.
        class: retainProbe.kind === "error" && recallProbe.kind === "error"
          ? "not-measured"
          : answered
            ? "answered-2xx"
            : retainAuthRefused
              ? "refused-auth"
              : !retainMeasured
                ? "write-leg-unmeasured"
                : nonAuthRefused
                  ? "refused-non-auth"
                  : "refused-unclassified",
        detail: `unauthenticated retain ${describe(retainProbe)}, recall ${describe(recallProbe)}`,
      };
      steps.push({
        step: "unauth-retain",
        outcome: `${retainProbe.kind}${retainProbe.status !== undefined ? ` ${retainProbe.status}` : ""}`,
      });
      steps.push({
        step: "unauth-recall",
        outcome: `${recallProbe.kind}${recallProbe.status !== undefined ? ` ${recallProbe.status}` : ""}`,
      });
      log({ step: "recall", bankId: probeBankId, outcome: answered ? "answered" : "refused" });
    } else {
      steps.push({ step: "unauth-retain", outcome: "skipped (hermetic mock)" });
      steps.push({ step: "unauth-recall", outcome: "skipped (hermetic mock)" });
    }

    // --- (b) authenticated cross-bank, proof first --------------------------
    if (f !== undefined && cred !== undefined) {
      // KEY-KNOWN PROOF: an authenticated listBanks-shaped read. Without a 2xx
      // here, a later refusal is indistinguishable (wrong key vs scope) and
      // would fake "danger retired" evidence (story AC4).
      const proof = await rawCall(f, banksUrl, "GET", { Authorization: cred }, undefined);
      keyProof = {
        attempted: true,
        ok: proof.kind === "answered",
        ...(proof.status !== undefined ? { status: proof.status } : {}),
        ...(proof.error !== undefined ? { error: proof.error } : {}),
      };
      steps.push({
        step: "auth-proof",
        outcome: `${proof.kind}${proof.status !== undefined ? ` ${proof.status}` : ""}`,
      });
      log({ step: "auth-proof", outcome: proof.kind });

      const cross = await rawCall(f, profileUrl, "GET", { Authorization: cred }, undefined);
      knownKeyOutOfScope = {
        answered: cross.kind === "answered",
        measured: cross.kind !== "error",
        ...(cross.status !== undefined ? { status: cross.status } : {}),
        ...(cross.bodyTail !== undefined ? { bodyTail: cross.bodyTail } : {}),
        class:
          cross.kind === "answered"
            ? proof.kind === "answered"
              ? "not-applicable-authz-absent"
              : "answered-2xx-proof-unavailable"
            : cross.kind === "refused"
              ? isNonAuthRefusalStatus(cross.status)
                ? `known-key-refused-non-auth-http_${cross.status}`
                : `known-key-out-of-scope-http_${cross.status}`
              : "known-key-out-of-scope-error",
        ...(cross.kind === "answered" && proof.kind === "answered"
          ? {
              detail:
                "0.10.0 auth is INSTANCE-WIDE (single tenant key, opt-in extension) and no " +
                "per-bank authorization exists (Track A): the known key succeeds cross-bank, so " +
                "'out of scope' is not applicable here — containment carries the weight (see containmentStatement)",
            }
          : {}),
        ...(cross.error !== undefined ? { detail: `error: ${cross.error}` } : {}),
      };
      steps.push({
        step: "cross-bank",
        outcome: `${cross.kind}${cross.status !== undefined ? ` ${cross.status}` : ""}`,
      });
      log({ step: "cross-bank", bankId: probeBankId, outcome: cross.kind });
    } else if (f === undefined) {
      steps.push({ step: "auth-proof", outcome: "skipped (hermetic mock)" });
      steps.push({ step: "cross-bank", outcome: "skipped (hermetic mock)" });
    } else {
      keyProof = { attempted: false };
      knownKeyOutOfScope = {
        answered: false,
        measured: false,
        class: "skipped-no-credential",
        detail:
          "no instance credential configured (deps.authHeader absent; HINDSIGHT_BEARER_TOKEN / " +
          "HINDSIGHT_API_KEY unset) — the known-key class split is unmeasurable, not green",
      };
      steps.push({ step: "auth-proof", outcome: "skipped (no credential)" });
      steps.push({ step: "cross-bank", outcome: "skipped (no credential)" });
    }

    // --- (c) unknown key — distinguishable only via the (b) proof ----------
    if (f !== undefined) {
      const badCred = `Bearer qds-invalid-${rand6()}`;
      const bad = await rawCall(f, profileUrl, "GET", { Authorization: badCred }, undefined);
      unknownKey = {
        answered: bad.kind === "answered",
        measured: bad.kind !== "error",
        ...(bad.status !== undefined ? { status: bad.status } : {}),
        ...(bad.bodyTail !== undefined ? { bodyTail: bad.bodyTail } : {}),
        class:
          bad.kind === "answered"
            ? "unknown-key-answered"
            : bad.kind === "refused"
              ? keyProof.ok === true
                ? `unknown-key-refused-http_${bad.status}`
                : "indistinguishable-proof-unavailable"
              : "unknown-key-error",
        detail: "deliberately-invalid bearer (qds-invalid-<rand>) — never a real credential",
        ...(bad.error !== undefined ? { detail: `error: ${bad.error}` } : {}),
      };
      steps.push({
        step: "unknown-key",
        outcome: `${bad.kind}${bad.status !== undefined ? ` ${bad.status}` : ""}`,
      });
      log({ step: "unknown-key", outcome: bad.kind });
    } else {
      steps.push({ step: "unknown-key", outcome: "skipped (hermetic mock)" });
    }
  } finally {
    // --- finally-delete: ALWAYS attempted once the probe bank was named ----
    cleanup = await cleanupProbeBank(deps, f, baseUrl, probeBankId, cred);
    steps.push({ step: "cleanup", outcome: `delete ${cleanup.outcome}` });
    log({ step: "cleanup", bankId: probeBankId, outcome: cleanup.outcome });
  }

  // F-007 + R3-013: only an AUTH-class refusal (401/403) on the RETAIN (write)
  // leg of the unauthenticated probe retires the danger — non-auth (404/422)
  // refusals and half-measured pairs keep it false.
  const dangerRetired = unauthenticated.class === "refused-auth";
  const refusedNonAuth = unauthenticated.class === "refused-non-auth";
  const containmentStatement = buildContainmentStatement(
    dangerRetired,
    unauthenticated.measured,
    unauthenticated.writeMeasured ?? false,
    refusedNonAuth,
    unauthenticated.answered,
  );
  // F-008: an explicit measured-count + a named all-skipped outcome for the
  // fully-hermetic run (which stays exit 0 — the leg records, it does not gate).
  const measuredCount = [unauthenticated, knownKeyOutOfScope, unknownKey].filter((p) => p.measured).length;
  const ok = cleanup.outcome !== "failed";
  const outcome = !ok
    ? `fail: probe-bank delete failed${cleanup.detail !== undefined ? ` — ${cleanup.detail}` : ""} (the disposable bank may remain; story AC4 requires the delete to land)`
    : measuredCount === 0
      ? `pass: all-probes-skipped-hermetic — measuredCount=0, no transport (hermetic mock without injected fetchImpl); dangerRetired carries no retirement claim; probe bank cleanup: ${cleanup.outcome}`
      : `pass: probes recorded (measuredCount=${measuredCount}) — dangerRetired=${String(dangerRetired)}${unauthenticated.class !== undefined ? ` (${unauthenticated.class})` : ""} (${unauthenticated.detail ?? ""}); probe bank cleanup: ${cleanup.outcome}`;
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
    authOutcomes: { unauthenticated, knownKeyOutOfScope, unknownKey },
    keyProof,
    credentialSource:
      deps.authHeader !== undefined && deps.authHeader !== ""
        ? "deps.authHeader"
        : cred !== undefined
          ? "env"
          : "none",
    measuredCount,
    dangerRetired,
    containmentStatement,
  };
}

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
 * Thin main: env → deps → runLeg → evidence → stderr path line → exitCode.
 * F-030: a failing evidence write dumps the payload to stderr and exits fatal.
 *
 * R2-006: on the LIVE path main CONSTRUCTS the client (baseUrl-threaded via
 * requireBaseUrl, mode live) and passes it as deps.client so the probe-bank
 * CREATE actually runs on the box — without a threaded client the create is
 * dead code and AC4's existence-confound removal never executes. A create
 * failure is recorded as its own step and the refusal classes absorb the
 * existence confound honestly.
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
