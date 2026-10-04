#!/usr/bin/env bun
/**
 * P0.9 leg driver: hindsight-live (story M1.1 AC1, dev-half).
 *
 * The boot/health/digest-identity leg plus the RAW response-shape check the
 * story makes load-bearing: before any downstream leg consumes the dedicated
 * instance, this leg issues ONE retain + ONE recall as raw HTTP against a
 * disposable `qds-probe-shape-<ts>` bank and records the response bodies
 * VERBATIM — before any schema parse (INV-HM1: maskTail-masked before
 * storage, F-028 — shape keys survive, credential values never land).
 * HindsightClient.retain()/recall()
 * strict-parse through RetainResponseSchema / RecallResponseSchema, so a
 * response that omits `memoryId` (the exact 0.10.0 drift this check exists
 * to detect) would throw inside the client before a shape could be recorded;
 * the raw bodies are the evidence the schemas.ts amendment is derived from.
 *
 * Clause map (story M1.1):
 *   AC1        env fail-closed by name + wrong-instance trap guard + health
 *              probe + digest identity (pin = integration-lineage fork
 *              checkout via QDS_FORK_CHECKOUT; live-mode failure fails the
 *              leg — make-or-break) + RAW shape probe on a disposable bank.
 *   Observability Contract  one p0-9-leg JSON line per event on stderr;
 *              step names retain|recall from the verifier's vocabulary;
 *              durations absent when unmeasured; tokens masked (INV-HM1).
 *
 * No connection host:port literal in this file — the origin always arrives
 * via deps/env and is trap-checked (leg-lib forbiddenOrigin) before any use.
 *
 * m1-1 round-2 hardening: hermetic mock (the fetch default is live-only —
 * R2-003); AbortController budgets on the health probe and both raw calls
 * (R2-008); evidence.origin recorded userinfo-stripped via leg-lib
 * sanitizeOrigin (R2-015).
 *
 * Output:  one timestamped evidence JSON (writeLegEvidence — live default
 *          _bmad-output/evidence/p0-9-closure/, mock refuses that dir); the
 *          written path is printed to stderr.
 * Exit:    0 pass / 1 leg failure (health, digest, probe, cleanup) /
 *          2 fatal refusal (env unset, wrong-instance trap).
 * Run:     bun scripts/p0-9/hindsight-live.ts
 *          (HINDSIGHT_LEG_MODE=mock: hermetic dev rehearsal — records
 *          skipped-hermetic health/probe steps and exits 1 DELIBERATELY,
 *          fail-closed per R2-003 (no transport is ever fabricated from env);
 *          a green rehearsal requires an injected transport (deps.fetchImpl),
 *          which only the test harness provides)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HindsightClient } from "../../src/hindsight/index.ts";
import {
  assertQdsRepoSlug,
  forbiddenOrigin,
  legLog,
  maskTail,
  requireBaseUrl,
  sanitizeOrigin,
  writeEvidenceOrStderr,
  type LegDeps,
  type LegEvidence,
  type LegMode,
  type LegStepRecord,
} from "./leg-lib.ts";

export const LEG = "p0-9-hindsight-live";

/** The digest segment of a pin/RepoDigest ref, `@` included — byte-exact compared. */
const SHA256_SEGMENT = /@sha256:[0-9a-f]{64}/;

/**
 * Per-call budget (AbortController) on the health probe and both raw shape
 * calls (R2-008) — a half-open connection must produce a RECORDED failed
 * step and a leg failure, never a hang (the resolves-for-every-outcome
 * contract). 10s, sibling parity with auth-retired-check's PROBE_TIMEOUT_MS.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** AbortController timeouts surface as DOMException name "AbortError". */
function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Minimal client surface the probe lifecycle touches (tests inject a fake). */
interface ProbeClient {
  createBank(bankId: string): Promise<unknown>;
  deleteBank(bankId: string): Promise<unknown>;
}

type Rec = (
  step: string,
  outcome: string,
  extra?: { bankId?: string; durationMs?: number; detail?: unknown },
) => void;

function makeRecorder(leg: string, steps: LegStepRecord[], logLines: string[]): Rec {
  return (step, outcome, extra = {}) => {
    steps.push({
      step,
      outcome,
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    });
    const entry = {
      leg,
      step,
      outcome,
      ...(extra.bankId !== undefined ? { bankId: extra.bankId } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    };
    logLines.push(JSON.stringify({ event: "p0-9-leg", ...entry }));
    legLog(entry);
  };
}

function finalize(
  steps: LegStepRecord[],
  logLines: string[],
  opts: { mode: LegMode; origin: string; ok: boolean; outcome: string; fatal?: boolean; ext?: Record<string, unknown> },
): LegEvidence {
  return {
    leg: LEG,
    mode: opts.mode,
    ok: opts.ok,
    outcome: opts.outcome,
    steps,
    // R2-015: a resolved origin is recorded userinfo-stripped (sanitizeOrigin);
    // "" (never resolved) stays "" — there is nothing to leak or normalize.
    origin: opts.origin === "" ? "" : sanitizeOrigin(opts.origin),
    exitCode: opts.ok ? 0 : opts.fatal === true ? 2 : 1,
    stdoutTail: "",
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
    ...(opts.ext ?? {}),
  };
}

/** The Authorization header VALUE the client itself would send (deps override, env fallback). */
function authValue(deps: LegDeps): string | undefined {
  if (deps.authHeader !== undefined && deps.authHeader.length > 0) return deps.authHeader;
  const token = process.env.HINDSIGHT_BEARER_TOKEN || process.env.HINDSIGHT_API_KEY;
  return token !== undefined && token !== "" ? `Bearer ${token}` : undefined;
}

/**
 * F-001/F-002 companion: a deps-carried origin gets the same trim +
 * trailing-slash strip the env path applies (checked value = used value) —
 * the threaded baseUrl is the normalized one.
 */
function normalizeOriginValue(origin: string): string {
  let s = origin.trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function dockerErrTail(r: { status: number | null; stderr: string }): string {
  const err = r.stderr.trim();
  return maskTail(err.length > 0 ? err.slice(0, 200) : `exit ${r.status ?? "signal"}`);
}

/**
 * Running digest of the dedicated container: `docker inspect --format
 * {{.Image}} <container>` → `docker image inspect --format {{index
 * .RepoDigests 0}} <imageRef>`. Container name from QDS_HINDSIGHT_CONTAINER
 * (default hindsight-qds) — a container NAME, not a connection origin.
 */
function dockerRepoDigest(container: string): { digest?: string; error?: string } {
  const image = spawnSync("docker", ["inspect", "--format", "{{.Image}}", container], { encoding: "utf8" });
  if (image.status !== 0 || image.stdout.trim().length === 0) {
    return { error: `docker inspect ${container} failed: ${dockerErrTail(image)}` };
  }
  const imageRef = image.stdout.trim();
  const repo = spawnSync("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", imageRef], { encoding: "utf8" });
  if (repo.status !== 0 || repo.stdout.trim().length === 0) {
    return { error: `docker image inspect failed for ${imageRef}: ${dockerErrTail(repo)}` };
  }
  const digest = repo.stdout.trim().match(SHA256_SEGMENT)?.[0];
  return digest !== undefined ? { digest } : { error: `no @sha256: segment in RepoDigests[0]: ${repo.stdout.trim().slice(0, 120)}` };
}

/** Live-mode digest identity: pin file vs running container, byte-exact. */
function liveDigestStep(rec: Rec, ext: Record<string, unknown>): boolean {
  const fork = process.env.QDS_FORK_CHECKOUT;
  if (fork === undefined || fork.trim() === "") {
    rec("digest-identity", "failed-fork-checkout-unset", {
      detail:
        "QDS_FORK_CHECKOUT unset — the pin source is the integration-lineage fork checkout's config/hindsight-version.txt; " +
        "no default checkout is trusted (a stale 0.8.6 pin is exactly what this step exists to catch)",
    });
    return false;
  }
  const pinPath = join(fork, "config", "hindsight-version.txt");
  let pin: string;
  try {
    pin = readFileSync(pinPath, "utf8").trim();
  } catch (e) {
    rec("digest-identity", "failed-pin-read", { detail: `cannot read ${pinPath}: ${(e as Error).message}` });
    return false;
  }
  const pinSha = pin.match(SHA256_SEGMENT)?.[0];
  if (pinSha === undefined) {
    rec("digest-identity", "failed-pin-no-digest", { detail: `pin file carries no @sha256: segment: ${pin.slice(0, 120)}` });
    return false;
  }
  const container = process.env.QDS_HINDSIGHT_CONTAINER ?? "hindsight-qds";
  const running = dockerRepoDigest(container);
  if (running.error !== undefined) {
    rec("digest-identity", "failed-docker-inspect", { detail: running.error });
    return false;
  }
  const runningSha = running.digest ?? "";
  if (runningSha !== pinSha) {
    rec("digest-identity", "failed-mismatch", { detail: { pin: pinSha, running: runningSha, container } });
    return false;
  }
  ext.pinDigest = pinSha;
  ext.runningDigest = runningSha;
  rec("digest-identity", "ok", { detail: { pin: pinSha, running: runningSha, container, matched: true } });
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function tryJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Shape observations derived from the RAW bodies — recorded as data, never enforced here. */
function deriveShapeObservations(ext: Record<string, unknown>, rawRetain: string | undefined, rawRecall: string | undefined): void {
  const retain = tryJson(rawRetain);
  const recall = tryJson(rawRecall);
  ext.hasRetainMemoryId = isPlainObject(retain) && "memoryId" in retain;
  ext.retainTopLevelKeys = isPlainObject(retain) ? Object.keys(retain) : null;
  ext.recallTopLevelKeys = isPlainObject(recall) ? Object.keys(recall) : null;
  const results = isPlainObject(recall) ? recall.results : undefined;
  ext.recallResultKeys =
    Array.isArray(results) && isPlainObject(results[0]) ? Object.keys(results[0]) : null;
}

/**
 * One raw POST — body returned VERBATIM (the evidence) even on a non-2xx,
 * with `ok:false` on both transport failure and HTTP failure so a 500'd
 * probe fails the leg while its body still lands in the evidence. R2-008:
 * an AbortController budget caps the call; a timeout records
 * failed-timeout, never a hang.
 */
async function rawCall(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  step: "retain" | "recall",
  bankId: string,
  rec: Rec,
): Promise<{ text?: string; ok: boolean }> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    rec(step, res.ok ? "ok" : `failed-http-${res.status}`, {
      bankId,
      durationMs: Date.now() - t0,
      detail: { status: res.status, bodyTail: maskTail(text, { maxLen: 200 }) },
    });
    return { text, ok: res.ok };
  } catch (e) {
    rec(step, isAbort(e) ? "failed-timeout" : "failed-transport", {
      bankId,
      detail: (e as Error).message,
    });
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The RAW shape probe: create the disposable bank via the (injected or real)
 * client, issue retain + recall as raw HTTP on the driver's own fetch, record
 * the bodies before any parse, and finally-delete the bank. A failed delete
 * fails the leg (story AC1: "a failed delete is recorded and fails the leg").
 */
async function rawShapeProbe(
  deps: LegDeps,
  mode: LegMode,
  baseUrl: string,
  fetchImpl: typeof fetch,
  auth: string | undefined,
  rec: Rec,
  ext: Record<string, unknown>,
  probeBankId: string,
): Promise<boolean> {
  // F-002: the constructed client (absent an injected one) carries the
  // resolved, trap-checked baseUrl — never the constructor's silent default.
  const client = (deps.client ?? new HindsightClient({ baseUrl, mode: mode === "live" ? "live" : "mock" })) as ProbeClient;
  const jsonHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(auth !== undefined ? { Authorization: auth } : {}),
  };
  let ok = true;
  let created = false;
  try {
    try {
      await client.createBank(probeBankId);
      created = true;
      rec("probe-create", "ok", { bankId: probeBankId });
    } catch (e) {
      rec("probe-create", "failed", { bankId: probeBankId, detail: (e as Error).message });
      ok = false;
    }
    if (created) {
      // async:false per the plan's 0.10.0 contract note — the shape check
      // wants the immediate response, not an operation id to poll.
      const retain = await rawCall(
        fetchImpl,
        `${baseUrl}/v1/default/banks/${probeBankId}/memories`,
        {
          items: [
            {
              content: "p0-9 hindsight-live disposable shape probe (raw unparsed path, story M1.1 AC1)",
              metadata: { source: "manual", kind: "observation", tags: ["p0-9-shape-probe"] },
            },
          ],
          async: false,
        },
        jsonHeaders,
        "retain",
        probeBankId,
        rec,
      );
      // F-028 (INV-HM1): mask BEFORE storing — a token echoed in a response
      // body must never land in closure evidence. Shape keys survive maskTail
      // (it masks credential-shaped VALUES, never key names), so the schemas
      // amendment still derives from the recorded bodies.
      ext.rawRetainBody = retain.text !== undefined ? maskTail(retain.text) : undefined;
      const recall = await rawCall(
        fetchImpl,
        `${baseUrl}/v1/default/banks/${probeBankId}/memories/recall`,
        { query: "p0-9 shape probe", limit: 1 },
        jsonHeaders,
        "recall",
        probeBankId,
        rec,
      );
      ext.rawRecallBody = recall.text !== undefined ? maskTail(recall.text) : undefined;
      if (!retain.ok || !recall.ok) ok = false;
      deriveShapeObservations(ext, retain.text, recall.text);
    }
  } finally {
    if (created) {
      try {
        await client.deleteBank(probeBankId);
        rec("probe-cleanup", "deleted", { bankId: probeBankId });
      } catch (e) {
        rec("probe-cleanup", "delete-failed", { bankId: probeBankId, detail: (e as Error).message });
        ok = false;
      }
    }
  }
  return ok;
}

/**
 * The leg entrypoint. Resolves LegEvidence for EVERY outcome including fatal
 * refusals (exitCode 2); never network-touches unless the collaborator is
 * injected via deps (mock rehearsal) or the mode is live.
 */
export async function runLeg(deps: LegDeps): Promise<LegEvidence> {
  const mode: LegMode = deps.mode === "live" ? "live" : "mock";
  const steps: LegStepRecord[] = [];
  const logLines: string[] = [];
  const rec = makeRecorder(LEG, steps, logLines);
  const ext: Record<string, unknown> = {};

  // (a) env fail-closed + wrong-instance trap — BEFORE any network.
  let baseUrl = "";
  try {
    baseUrl =
      deps.baseUrl !== undefined && deps.baseUrl.trim() !== ""
        ? normalizeOriginValue(deps.baseUrl)
        : requireBaseUrl(process.env);
  } catch (e) {
    rec("env-base-url", "fatal", { detail: (e as Error).message });
    return finalize(steps, logLines, { mode, origin: "", ok: false, outcome: "fatal-env", fatal: true, ext });
  }
  const trap = forbiddenOrigin(baseUrl);
  if (trap !== null) {
    rec("origin-guard", "fatal", { detail: trap });
    return finalize(steps, logLines, { mode, origin: baseUrl, ok: false, outcome: "fatal-forbidden-origin", fatal: true, ext });
  }

  // (b) health probe — raw GET ${baseUrl}/health, auth header when one is configured.
  // 0.10.0 serves no root route (measured live 2026-10-04: GET / → 404 on both the
  // dedicated and the tenant instance; its OpenAPI lists /health, /health/ready,
  // /health/live). /health also reports database connectivity, so it is the
  // stricter probe, not a looser one.
  // R2-003: the fetch default is LIVE-ONLY — a mock rehearsal without an
  // injected fetchImpl records skipped-hermetic steps (unmeasured, no network)
  // instead of issuing real requests off env.
  const fetchImpl = deps.fetchImpl ?? (mode === "live" ? globalThis.fetch : undefined);
  const auth = authValue(deps);
  let healthOk = false;
  if (fetchImpl === undefined) {
    rec("health-probe", "skipped-hermetic", {
      detail:
        "no transport (mock rehearsal without an injected fetchImpl) — no network issued; the health step is unmeasured, not green",
    });
  } else {
    // R2-008: AbortController budget — a half-open connection records a
    // failed step, never a hang.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const t0 = Date.now();
      const res = await fetchImpl(`${baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
        ...(auth !== undefined ? { headers: { Authorization: auth } } : {}),
      });
      const body = await res.text();
      rec("health-probe", res.ok ? "ok" : `failed-http-${res.status}`, {
        durationMs: Date.now() - t0,
        detail: { status: res.status, bodyTail: maskTail(body, { maxLen: 300 }) },
      });
      healthOk = res.ok;
    } catch (e) {
      rec("health-probe", isAbort(e) ? "failed-timeout" : "failed-transport", {
        detail: (e as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // (c) digest identity — live mode's make-or-break; mock rehearsal skips honestly.
  let digestOk = true;
  if (mode === "mock") {
    rec("digest-identity", "skipped-mock", {
      detail: "mock rehearsal does not verify the running container digest (the live VPS-day leg owns AC1's digest proof)",
    });
  } else {
    digestOk = liveDigestStep(rec, ext);
  }

  // (d) RAW shape probe — only against a healthy instance whose pin is proven:
  // shapes recorded off an unpinned container would be evidence of nothing.
  // R2-003: with no transport at all the probe records skipped-hermetic and
  // NOTHING is created or stranded (the probe-bank lifecycle never runs).
  let probeOk = true;
  if (fetchImpl === undefined) {
    rec("shape-probe", "skipped-hermetic", {
      detail:
        "no transport (mock rehearsal without an injected fetchImpl) — nothing is probed, created, or stranded",
    });
    probeOk = false;
  } else if (!healthOk) {
    rec("shape-probe", "skipped-health-down", { detail: "instance did not answer the health probe — no shape probe issued" });
    probeOk = false;
  } else if (!digestOk) {
    rec("shape-probe", "skipped-digest-unproven", { detail: "digest identity unproven — no raw shape probe issued against a possibly-unpinned container" });
    probeOk = false;
  } else {
    // F-004: the disposable probe bank id routes through the shared INV-MEM-1
    // prefix gate (fatal refusal on a non-qds- resolution) before any create.
    try {
      const probeBankId = assertQdsRepoSlug(`qds-probe-shape-${deps.now?.() ?? Date.now()}`);
      ext.probeBankId = probeBankId;
      probeOk = await rawShapeProbe(deps, mode, baseUrl, fetchImpl, auth, rec, ext, probeBankId);
    } catch (e) {
      rec("probe-bank-id", "fatal", { detail: (e as Error).message });
      return finalize(steps, logLines, {
        mode,
        origin: baseUrl,
        ok: false,
        outcome: "fatal-bank-prefix-violation",
        fatal: true,
        ext,
      });
    }
  }

  const ok = healthOk && digestOk && probeOk;
  return finalize(steps, logLines, { mode, origin: baseUrl, ok, outcome: ok ? "pass" : "leg-failure", ext });
}

async function main(): Promise<void> {
  const mode: LegMode = process.env.HINDSIGHT_LEG_MODE === "mock" ? "mock" : "live";
  // A blank baseUrl routes through runLeg's requireBaseUrl so the fatal
  // refusal (and its evidence) is recorded rather than thrown raw.
  const deps: LegDeps = { baseUrl: process.env.HINDSIGHT_BASE_URL ?? "", mode };
  const evidence = await runLeg(deps);
  // F-030: a run that mutated the instance must never lose its outcomes to a
  // failing evidence write — the payload lands on stderr and the exit is fatal.
  const { path: file, fellBack } = writeEvidenceOrStderr(LEG, evidence);
  if (!fellBack) process.stderr.write(`${file}\n`);
  process.exitCode = fellBack ? 2 : evidence.exitCode;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`${LEG} fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
