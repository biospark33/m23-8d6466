#!/usr/bin/env bun
/**
 * P0.9 leg driver: idempotency-rerun (story M1.1 AC3, dev-half).
 *
 * Proves the roster idempotency claim inside ONE serialized diff window:
 * snapshot → provision → snapshot → provision AGAIN → snapshot, all under
 * leg-lib acquireHeartbeatLock (R2-002) at the
 * PROVISIONER'S OWN lock path (default ~/.hindsight/provision.lock,
 * bank-provisioner defaultLockPath — the same path provision-and-import and
 * the CLI use, so every provision-family writer serializes as one class;
 * deps.lockPath override) with the leg stale budget LEG_LOCK_STALE_MS
 * (deps.lockStaleMs override, F-005); provisionBanks runs with noLock:true —
 * the inner single-flight is suppressed, no deadlock.
 *
 * Provisioning is rerun-aware (same rule as provision-and-import): a first
 * run (base bank absent) goes through the consumed provisionBanks — the
 * resolution authority; a rerun (the factory's own base bank already on the
 * instance) re-issues the PUT upsert of the canonical roster, because
 * re-running the resolver would suffix -2 off our OWN bank. The mode is
 * recorded in each provision step's detail.
 *
 * The idempotency contract: the second provision must create nothing —
 * snapshot 3 equals snapshot 2 exactly (nothing added, nothing vanished).
 * The FIRST provision MAY create (that is the normal first run); its
 * attributed creations are recorded as createdInAttempt (R3-005: the CLAIM
 * set — fresh lane = provisionBanks' status:"created" members, rerun lane =
 * the helper's createdInAttempt roster members — intersected with the diff,
 * never the raw diff, which also contains concurrently-running legs' probe
 * banks and operator creations). Any rerun diff fails the leg; a failed
 * provision or a diff failure compensates by deleting exactly the CLAIMED
 * banks, with per-bank outcomes recorded and any failed delete named as
 * residue; unclaimed diff banks are recorded as unclaimedCreated[] and LEFT
 * IN PLACE (same discipline as provision-and-import).
 *
 * Output:  one timestamped evidence JSON carrying rosters {pre, post, post2}
 *          + createdInAttempt + createdInRerun + unclaimedCreated
 *          (writeEvidenceOrStderr — live default
 *          _bmad-output/evidence/p0-9-closure/, mock refuses it; on write
 *          failure the payload lands on stderr, F-030).
 * Exit:    0 pass / 1 leg failure (provision failure, rerun diff, residue) /
 *          2 fatal refusal (env unset, wrong-instance trap, missing live
 *          shape prereq (F-022), non-qds repo slug (F-004), lock unavailable).
 * Run:     bun scripts/p0-9/idempotency-rerun.ts
 *          (HINDSIGHT_LEG_MODE=mock for the dev rehearsal)
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isPidDead } from "../../src/lib/file-lock.ts";
import { HindsightClient } from "../../src/hindsight/index.ts";
import type { ProvisionOptions, ProvisionResult } from "../../src/hindsight/bank-provisioner.ts";
import {
  acquireHeartbeatLock,
  assertQdsRepoSlug,
  extractBankIds,
  forbiddenOrigin,
  LEG_LOCK_STALE_MS,
  legLog,
  maskTail,
  rerunAwareProvision,
  requireBaseUrl,
  resolveRepoSlug,
  rosterPatternClaim,
  sanitizeOrigin,
  scanLiveShapePrereq,
  writeEvidenceOrStderr,
  type LegDeps,
  type LegEvidence,
  type LegMode,
  type LegStepRecord,
} from "./leg-lib.ts";

export const LEG = "p0-9-idempotency-rerun";

/** Minimal client surface this leg touches (tests inject a plain-object fake). */
interface LegClient {
  listBanks(): Promise<unknown>;
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
    // R2-015: a resolved origin is recorded userinfo-stripped; "" (never
    // resolved) stays "".
    origin: opts.origin === "" ? "" : sanitizeOrigin(opts.origin),
    exitCode: opts.ok ? 0 : opts.fatal === true ? 2 : 1,
    stdoutTail: "",
    stderrTail: maskTail(logLines.join("\n"), { maxLen: 4000 }),
    writtenAt: new Date().toISOString(),
    ...(opts.ext ?? {}),
  };
}

/** F-001/F-002 companion: a deps-carried origin gets the env path's trim + slash-strip (checked value = used value). */
function normalizeOriginValue(origin: string): string {
  let s = origin.trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Classify a deleteBank result into AC3's per-bank outcome vocabulary. */
function deleteOutcome(r: unknown): string {
  if (r !== null && typeof r === "object" && !Array.isArray(r)) {
    const o = r as { deleted?: unknown; alreadyGone?: unknown; deletedCount?: unknown };
    if (o.deleted === true) return "deleted";
    if (o.alreadyGone === true || o.deletedCount === 0) return "already-gone";
  }
  return "deleted-unknown-shape";
}

async function snapshot(client: LegClient, rec: Rec, label: string): Promise<string[] | null> {
  try {
    const ids = extractBankIds(await client.listBanks());
    rec(`snapshot-${label}`, "ok", { detail: { count: ids.length } });
    return ids;
  } catch (e) {
    rec(`snapshot-${label}`, "failed", {
      detail: `listBanks failed — the diff window cannot be trusted, no compensation attempted: ${(e as Error).message}`,
    });
    return null;
  }
}

/**
 * R3-005: the banks this attempt may CLAIM — the only compensably deletable
 * set, never the raw post∖pre diff (which also contains concurrently-running
 * legs' probe banks and operator creations). Fresh lane: provisionBanks'
 * status:"created" members; defensive on both helper shapes — when the raw
 * envelope is not banks-shaped (failure envelope / thrown failure) fall back
 * to the helper's createdInAttempt. Rerun lane: the helper's createdInAttempt
 * semantics (canonical roster members it created this attempt; [] under
 * failure).
 */
function claimableCreates(result: { mode: string; createdInAttempt: string[]; raw: unknown }): string[] {
  if (result.mode !== "resolved-fresh") return result.createdInAttempt;
  const banks = (result.raw as { banks?: unknown } | undefined)?.banks;
  if (!Array.isArray(banks)) return result.createdInAttempt;
  return banks
    .filter(
      (b): b is { bankId: string } =>
        b !== null &&
        typeof b === "object" &&
        (b as { status?: unknown }).status === "created" &&
        typeof (b as { bankId?: unknown }).bankId === "string",
    )
    .map((b) => b.bankId);
}

/**
 * One provision attempt against the instance state `existingBankIds` — a thin
 * wrapper over leg-lib rerunAwareProvision (R2-011: the fresh/rerun fork, the
 * injected provisionImpl seam, and the step recording all live in the helper;
 * the wrapper owns only this leg's `provision-<n>` step labels). Returns the
 * helper's honest createdInAttempt alongside ok — the R2-019 residue source
 * when a later snapshot dies mid-window — plus the R3-005 claim set.
 *
 * First run (base bank absent): provisionBanks is the resolution authority —
 * its collision loop (-2..-11) is for genuinely foreign collisions. Rerun
 * (base bank present): the canonical-roster PUT upsert — exactly the
 * operation AC3 pins and the one whose idempotency this leg exists to prove.
 */
async function provisionOnce(
  deps: LegDeps,
  client: LegClient,
  repoSlug: string,
  existingBankIds: string[],
  rec: Rec,
  label: string,
): Promise<{ ok: boolean; mode: string; createdInAttempt: string[]; claimable: string[] }> {
  const t0 = Date.now();
  const result = await rerunAwareProvision(client, repoSlug, {
    existingBankIds,
    // DD-17: dedicated topology, no MCP bridge to probe.
    bridgeProbe: { registered: true, healthy: true },
    // F-005: the caller holds the provisioner's own lock across the window —
    // the inner single-flight is suppressed (no deadlock).
    holdProvisionerLock: true,
    rec: (_step, outcome, detail) => {
      rec(`provision-${label}`, outcome, { durationMs: Date.now() - t0, detail });
    },
    ...(deps.provisionImpl !== undefined
      ? {
          provisionImpl: deps.provisionImpl as (
            opts: ProvisionOptions,
          ) => Promise<ProvisionResult>,
        }
      : {}),
  });
  // PR-review fallback (mirrors provision-and-import): a FAILED fresh
  // provision's real ProvisionErr envelope carries NO banks, so the
  // status:"created" claim is unavailable exactly when compensation matters —
  // the attempt's own roster shape matched against the diff is the fallback
  // claim. The diff arrives at the call site (idempotencyWindow), so the
  // fallback is applied there via attempt.mode.
  return { ok: result.ok, mode: result.mode, createdInAttempt: result.createdInAttempt, claimable: claimableCreates(result) };
}

async function idempotencyWindow(
  deps: LegDeps,
  client: LegClient,
  repoSlug: string,
  rec: Rec,
  ext: Record<string, unknown>,
): Promise<boolean> {
  const pre = await snapshot(client, rec, "pre");
  if (pre === null) return false;
  const attempt1 = await provisionOnce(deps, client, repoSlug, pre, rec, "1");
  const post = await snapshot(client, rec, "post");
  if (post === null) {
    // R2-019: banks the first attempt reported creating are stranded with no
    // compensation — name them as unconfirmed-delete residue, never a clean [].
    ext.residue = attempt1.createdInAttempt;
    if (attempt1.createdInAttempt.length > 0) {
      ext.residueReason =
        "unconfirmed-delete: post-snapshot failure stranded the first attempt's creations with no delete attempted";
    }
    return false;
  }
  const attempt2 = await provisionOnce(deps, client, repoSlug, post, rec, "2");
  const post2 = await snapshot(client, rec, "post2");
  if (post2 === null) {
    // R2-019: same honesty for the rerun edge — everything the two attempts
    // reported creating is unconfirmed-delete residue.
    const stranded = [...attempt1.createdInAttempt, ...attempt2.createdInAttempt];
    ext.residue = stranded;
    if (stranded.length > 0) {
      ext.residueReason =
        "unconfirmed-delete: post2-snapshot failure stranded the attempts' creations with no delete attempted";
    }
    return false;
  }
  const ok1 = attempt1.ok;
  const ok2 = attempt2.ok;

  // R3-005: the diffs are OBSERVATION (createdInRerun stays the raw diff — it
  // is the idempotency violation detector), the claims are ATTRIBUTION —
  // compensation deletes only claim ∩ diff; the rest is recorded and left.
  // PR-review fallback (mirrors provision-and-import): a FAILED fresh attempt
  // whose envelope carries no banks (the real ProvisionErr shape) claims its
  // own roster shape out of the diff — family writers are lock-serialized and
  // probe banks cannot match the shape.
  const diff1 = post.filter((id) => !pre.includes(id));
  const createdInRerun = post2.filter((id) => !post.includes(id));
  const claim1 =
    !attempt1.ok && attempt1.mode === "resolved-fresh" && attempt1.claimable.length === 0
      ? rosterPatternClaim(repoSlug, diff1)
      : attempt1.claimable;
  const claim2 =
    !attempt2.ok && attempt2.mode === "resolved-fresh" && attempt2.claimable.length === 0
      ? rosterPatternClaim(repoSlug, createdInRerun)
      : attempt2.claimable;
  const claimed = [
    ...claim1.filter((id) => diff1.includes(id)),
    ...claim2.filter((id) => createdInRerun.includes(id)),
  ];
  const claimedSet = new Set(claimed);
  const createdInAttempt = [...claimedSet];
  const unclaimedCreated = [...diff1, ...createdInRerun].filter((id) => !claimedSet.has(id));
  const vanishedInRerun = post.filter((id) => !post2.includes(id));
  ext.rosters = { pre, post, post2 };
  ext.createdInAttempt = createdInAttempt;
  ext.createdInRerun = createdInRerun;
  ext.unclaimedCreated = unclaimedCreated;
  if (unclaimedCreated.length > 0) {
    rec("compensation-attribution", "unclaimed-created-left-in-place", {
      detail: {
        unclaimedCreated,
        reason:
          "not attributable to this attempt — probe/manual/foreign creation during the window; recorded, never deleted by this leg's compensation",
      },
    });
  }

  let failed = !ok1 || !ok2;
  if (createdInRerun.length > 0) {
    failed = true;
    rec("idempotency", "failed-created-on-rerun", { detail: { createdInRerun } });
  }
  if (vanishedInRerun.length > 0) {
    failed = true;
    rec("idempotency", "failed-vanished-on-rerun", { detail: { vanishedInRerun } });
  }
  if (!failed) {
    rec("idempotency", "ok", {
      detail: { rosterSize: post2.length, createdInAttempt: createdInAttempt.length, createdInRerun: 0 },
    });
  }

  // Compensation on failure — deletes exactly what THIS leg CLAIMS (first
  // attempt's claim plus the rerun's claimed illegal creations), never a
  // pre-existing bank and never an unclaimed diff bank (probe / manual /
  // foreign creations stay in place, named above); any failed delete is named
  // residue and keeps the leg non-zero.
  const deleteOutcomes: Record<string, string> = {};
  const residue: string[] = [];
  if (failed) {
    for (const bankId of claimed) {
      try {
        const outcome = deleteOutcome(await client.deleteBank(bankId));
        deleteOutcomes[bankId] = outcome;
        rec("compensate-delete", outcome, { bankId });
      } catch (e) {
        deleteOutcomes[bankId] = "failed";
        residue.push(bankId);
        rec("compensate-delete", "failed", { bankId, detail: (e as Error).message });
      }
    }
  }
  ext.deleteOutcomes = deleteOutcomes;
  ext.residue = residue;
  return !failed && residue.length === 0;
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
  const ext: Record<string, unknown> = {
    createdInAttempt: [],
    unclaimedCreated: [],
    residue: [],
    deleteOutcomes: {},
    rosters: { pre: [], post: [], post2: [] },
  };

  // Env fail-closed + wrong-instance trap — BEFORE any network.
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

  // F-022: AC1 ordering — a live leg consumes the instance only after a
  // live-stamped hindsight-live shape-check evidence exists (mock exempt).
  if (mode === "live") {
    const prereq = scanLiveShapePrereq(deps);
    if (!prereq.ok) {
      rec("prereq", "fatal", { detail: prereq.reason });
      return finalize(steps, logLines, {
        mode,
        origin: baseUrl,
        ok: false,
        outcome: "fatal-live-shape-prereq",
        fatal: true,
        ext,
      });
    }
    rec("prereq", "ok", { detail: { file: prereq.file } });
  }

  // F-004: INV-MEM-1 — the repo slug feeds bank creation; a resolution
  // lacking the qds- prefix is a fatal refusal, never a foreign mint.
  // R2-018: leg-lib resolveRepoSlug is THE one default (QDS_REPO_SLUG ??
  // cwd basename) shared by every driver.
  const repoSlug = resolveRepoSlug(process.env);
  ext.repoSlug = repoSlug;
  try {
    assertQdsRepoSlug(repoSlug);
  } catch (e) {
    rec("repo-slug", "fatal", { detail: (e as Error).message });
    return finalize(steps, logLines, {
      mode,
      origin: baseUrl,
      ok: false,
      outcome: "fatal-bank-prefix-violation",
      fatal: true,
      ext,
    });
  }

  // F-002: the constructed client (absent an injected one) carries the
  // resolved, trap-checked baseUrl — never the constructor's silent default.
  const client = (deps.client ?? new HindsightClient({ baseUrl, mode: mode === "live" ? "live" : "mock" })) as LegClient;

  // The provisioner's OWN lock (F-005): every provision-family writer (CLI,
  // provision-and-import, this leg) serializes as one class at one path.
  // R2-002: acquired through leg-lib acquireHeartbeatLock — the leg's 900s
  // window refreshes the lock file's mtime while held, so a concurrent
  // provisionBanks/CLI run (300s age-only steal) never steals into a live
  // window mid-mint.
  const lockPath = deps.lockPath ?? join(homedir(), ".hindsight", "provision.lock");
  const staleMs = deps.lockStaleMs ?? LEG_LOCK_STALE_MS;
  let release: (() => void) | null = null;
  try {
    // R2-020: the lock-dir mkdir lives INSIDE the try — a file-shaped dirname
    // or EACCES resolves fatal LegEvidence, never a bare crash out of runLeg.
    mkdirSync(dirname(lockPath), { recursive: true });
    release = await acquireHeartbeatLock(lockPath, {
      staleMs,
      holder: ({ ageMs, pid }) => ageMs >= staleMs || pid === undefined || isPidDead(pid),
    });
  } catch (e) {
    rec("lock", "fatal", { detail: (e as Error).message });
    return finalize(steps, logLines, { mode, origin: baseUrl, ok: false, outcome: "fatal-lock", fatal: true, ext });
  }
  if (release === null) {
    rec("lock", "fatal-in-progress", {
      detail: `${lockPath} is held by a live holder — the diff window cannot serialize; refusing to attribute another driver's creates into this attempt`,
    });
    return finalize(steps, logLines, {
      mode,
      origin: baseUrl,
      ok: false,
      outcome: "fatal-lock-in-progress",
      fatal: true,
      ext,
    });
  }

  let ok = false;
  try {
    ok = await idempotencyWindow(deps, client, repoSlug, rec, ext);
  } finally {
    try {
      release();
    } catch (e) {
      // Age-stolen mid-run: a diagnostic, never an outcome (provisioner idiom).
      rec("lock-release", "warn-taken-over", { detail: (e as Error).message });
    }
  }
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
