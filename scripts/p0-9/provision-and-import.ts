#!/usr/bin/env bun
/**
 * P0.9 leg driver: provision-and-import (story M1.1 AC3 + the seed-probe
 * mint record, dev-half).
 *
 * Provisions the v6a roster trio (per-repo bank + `-dev-meta` +
 * `qds-collective`), then imports the Mulch expertise corpus into every
 * roster bank through a DRIVER-OWNED raw retain call site that carries a
 * deterministic `document_id` — `mulch-` + sha256(canonical {domain,
 * concepts}) — so a later leg (M1.3's reader contract) can re-derive the
 * ids. mulch-importer.ts stays untouched.
 *
 * Provisioning is rerun-aware via leg-lib rerunAwareProvision (F-025): on a
 * first run (base bank absent) the consumed provisionBanks is the resolution
 * authority; on a rerun (the factory's own base bank already on the instance)
 * the helper re-issues the PUT upsert of the canonical roster — re-running
 * the resolver would suffix -2 off our OWN bank and create junk on every
 * rerun. The mode is recorded in the provision step detail.
 *
 * Compensation semantics (AC3): the whole diff window — pre-snapshot →
 * provision → post-snapshot → compensation — serializes under leg-lib
 * acquireHeartbeatLock (R2-002: acquireFileLock + an mtime heartbeat, so the
 * leg's 900s window is never stolen by a concurrent 300s-budget
 * provisionBanks/CLI run mid-mint) at the PROVISIONER'S OWN lock path
 * (default ~/.hindsight/provision.lock, bank-provisioner defaultLockPath;
 * deps.lockPath override) with the leg stale budget LEG_LOCK_STALE_MS
 * (deps.lockStaleMs override), so a concurrent CLI/other-caller run fails its
 * own lock instead of interleaving creates into this attempt's diff (F-005);
 * provisionBanks runs with noLock:true — the inner single-flight is
 * suppressed, no deadlock. R3-005 claim-scoped compensation: the raw post∖pre
 * diff also contains banks created during the window by NON-family writers
 * (hindsight-live / auth-retired-check probe banks, operator creations) — the
 * diff alone must never drive deletes. Compensation deletes ONLY banks the
 * attempt can CLAIM: fresh lane = provisionBanks' status:"created" members
 * (falling back to the helper's createdInAttempt when the failure envelope is
 * not banks-shaped); rerun lane = the helper's createdInAttempt (roster
 * members it created this attempt) — each claim intersected with the diff so a
 * pre-attempt bank is never deleted. The REMAINING diff banks are recorded as
 * unclaimedCreated[] (named, LEFT IN PLACE — not attributable to this
 * attempt: probe/manual/foreign creation during the window). Each delete's
 * outcome is recorded (deleted / already-gone / failed); ANY failed delete of
 * a CLAIMED bank fails the leg with the residue named in the evidence. A
 * fully-green run deletes nothing. R2-019: a post-snapshot failure mid-window
 * names the attempt's reported creations as unconfirmed-delete residue instead
 * of a clean [].
 *
 * Output:  one timestamped evidence JSON (writeEvidenceOrStderr — live
 *          default _bmad-output/evidence/p0-9-closure/, mock refuses that
 *          dir; on write failure the payload lands on stderr, F-030).
 * Exit:    0 pass / 1 leg failure (provision, import, compensation residue) /
 *          2 fatal refusal (env unset, wrong-instance trap, missing live
 *          shape prereq (F-022), non-qds repo slug (F-004), lock unavailable).
 * Run:     bun scripts/p0-9/provision-and-import.ts
 *          (HINDSIGHT_LEG_MODE=mock for the dev rehearsal)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep as PATH_SEP } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { isPidDead } from "../../src/lib/file-lock.ts";
import { HindsightClient, MulchExpertiseSchema, type MulchExpertise } from "../../src/hindsight/index.ts";
import { dedupHash, MAX_CONTENT_BYTES } from "../../src/hindsight/mulch-importer.ts";
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

export const LEG = "p0-9-provision-and-import";

const SUPPORTED_EXTS = new Set([".yaml", ".yml", ".json", ".jsonl"]);

/** F-012: repo-root-relative from THIS file — a stray cwd must never yield a hollow green mint record. */
const DEFAULT_EXPERTISE_DIR = join(import.meta.dir, "..", "..", ".mulch", "expertise");

/** Minimal client surface this leg touches (tests inject a plain-object fake). */
interface LegClient {
  listBanks(): Promise<unknown>;
  createBank(bankId: string): Promise<unknown>;
  deleteBank(bankId: string): Promise<unknown>;
  request(method: string, path: string, body?: unknown): Promise<unknown>;
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Classify a deleteBank result into AC3's per-bank outcome vocabulary. */
function deleteOutcome(r: unknown): string {
  if (isPlainObject(r)) {
    if (r.deleted === true) return "deleted";
    if (r.alreadyGone === true || r.deletedCount === 0) return "already-gone";
  }
  return "deleted-unknown-shape";
}

// ---------------------------------------------------------------------------
// Mulch corpus reading (driver-owned: the retain call site carries
// document_id; mulch-importer.ts is consumed-unchanged)
// ---------------------------------------------------------------------------

function toArrayOrOne(parsed: unknown, name: string, failures: string[]): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed)) return [parsed];
  failures.push(`${name}: top-level value is neither array nor object`);
  return [];
}

function parseCorpusFile(name: string, text: string, failures: string[]): unknown[] {
  const ext = extname(name).toLowerCase();
  try {
    if (ext === ".yaml" || ext === ".yml") return toArrayOrOne(parseYaml(text), name, failures);
    if (ext === ".json") return toArrayOrOne(JSON.parse(text), name, failures);
    // .jsonl — one object per non-blank line; a malformed line is a failure, the rest still parse
    const out: unknown[] = [];
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo += 1;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch (e) {
        failures.push(`${name} line ${lineNo}: invalid JSON (${(e as Error).message})`);
      }
    }
    return out;
  } catch (e) {
    failures.push(`${name}: parse failed (${(e as Error).message})`);
    return [];
  }
}

function loadCorpus(dir: string): { entries: MulchExpertise[]; failures: string[]; note?: string } {
  const failures: string[] = [];
  if (!existsSync(dir)) {
    return { entries: [], failures, note: `expertise dir absent: ${dir} — mint record carries empty arrays (no corpus to import)` };
  }
  let dirReal: string;
  try {
    dirReal = realpathSync(dir);
  } catch (e) {
    return { entries: [], failures, note: `expertise dir unreadable: ${dir} (${(e as Error).message})` };
  }
  let names: string[] = [];
  try {
    names = readdirSync(dirReal);
  } catch (e) {
    return { entries: [], failures, note: `expertise dir unreadable: ${dir} (${(e as Error).message})` };
  }
  const entries: MulchExpertise[] = [];
  for (const name of names) {
    if (!SUPPORTED_EXTS.has(extname(name).toLowerCase())) continue;
    const full = join(dirReal, name);
    // INV-HM3 (importer's rule, mirrored): resolve the realpath and require
    // it to stay a TOP-LEVEL file inside the corpus dir — a symlink escaping
    // the dir (or ducking into a subdir) is a recorded failure, never read.
    let resolved: string;
    try {
      resolved = realpathSync(full);
    } catch (e) {
      failures.push(`${name}: unreadable target (${(e as Error).message})`);
      continue;
    }
    if (resolved !== dirReal && !resolved.startsWith(`${dirReal}${PATH_SEP}`)) {
      failures.push(`${name}: symlink_escape (target outside the expertise dir)`);
      continue;
    }
    if (relative(dirReal, resolved).includes(PATH_SEP)) {
      failures.push(`${name}: symlink_escape_subdir (target resolves into a subdirectory)`);
      continue;
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(resolved);
    } catch {
      continue; // vanished between readdir and stat — not this leg's problem
    }
    if (!st.isFile()) continue;
    let text: string;
    try {
      text = readFileSync(resolved, "utf8");
    } catch (e) {
      failures.push(`${name}: unreadable (${(e as Error).message})`);
      continue;
    }
    for (const raw of parseCorpusFile(name, text, failures)) {
      const validated = MulchExpertiseSchema.safeParse(raw);
      if (validated.success) entries.push(validated.data);
      else {
        failures.push(`${name}: ${validated.error.issues.map((i) => i.message).join("; ").slice(0, 200)}`);
      }
    }
  }
  if (entries.length === 0 && failures.length === 0) {
    return { entries, failures, note: `no supported expertise files in ${dir} — mint record carries empty arrays` };
  }
  return { entries, failures };
}

/** Canonical JSONL line — stable field order, mirroring mulch-importer's construction. */
function canonicalJsonl(entry: MulchExpertise): string {
  return JSON.stringify({
    id: entry.id,
    domain: entry.domain,
    concepts: entry.concepts,
    expertise: entry.expertise,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
  });
}

/**
 * Retain every corpus entry into every roster bank via the driver-owned raw
 * call site. document_id = `mulch-` + dedupHash(domain, concepts).slice(0,16)
 * — deterministic, NOT runId-shaped — so ids are re-derivable and idempotent
 * across runs. Per-bank retained ids land in the mint record. F-011: entries
 * whose canonical JSONL exceeds the importer's per-entry WIRE cap
 * (MAX_CONTENT_BYTES, mulch-importer.ts:319-327) are skipped per-entry and
 * recorded (oversized-skipped) — one fat entry must not fail the leg and
 * roll back the whole roster.
 */
async function mintCorpus(
  client: LegClient,
  roster: string[],
  expertiseDir: string,
  repoSlug: string,
  rec: Rec,
): Promise<{
  record: Record<string, { resolvedFrom: string; documentIds: string[] }>;
  failures: string[];
  oversized: string[];
  note?: string;
}> {
  const failures: string[] = [];
  const oversized: string[] = [];
  const record: Record<string, { resolvedFrom: string; documentIds: string[] }> = {};
  const corpus = loadCorpus(expertiseDir);
  for (const bankId of roster) {
    const documentIds: string[] = [];
    const seen = new Set<string>();
    const failuresBefore = failures.length;
    for (const entry of corpus.entries) {
      const documentId = `mulch-${dedupHash(entry.domain, entry.concepts).slice(0, 16)}`;
      if (seen.has(documentId)) continue;
      seen.add(documentId);
      const content = canonicalJsonl(entry);
      if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
        oversized.push(`${bankId} ${documentId} (${Buffer.byteLength(content, "utf8")}B)`);
        continue;
      }
      try {
        await client.request("POST", `/v1/default/banks/${bankId}/memories`, {
          items: [
            {
              content,
              document_id: documentId,
              // 0.10.0 MemoryItem: metadata is Dict[str, str]; tags are
              // item-level (an array under metadata.tags is a 422 — measured
              // live 2026-10-04, same class as hindsight-live.ts's shape
              // probe). Item-level tags array is the measured-good shape.
              metadata: { source: "mulch-import", kind: "expertise" },
              tags: entry.concepts,
            },
          ],
        });
        documentIds.push(documentId);
      } catch (e) {
        failures.push(`${bankId} ${documentId}: ${(e as Error).message}`);
      }
    }
    record[bankId] = { resolvedFrom: repoSlug, documentIds };
    rec("mulch-import", failures.length === failuresBefore ? "ok" : "failed", {
      bankId,
      detail: { expertiseDir, retained: documentIds.length, ...(corpus.note !== undefined ? { note: corpus.note } : {}) },
    });
  }
  return { record, failures, oversized, note: corpus.note };
}

// ---------------------------------------------------------------------------
// The provision attempt (rerun-aware via leg-lib rerunAwareProvision, F-025)
// ---------------------------------------------------------------------------

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
 * call into leg-lib rerunAwareProvision. R2-011: the injected provisionImpl
 * and the step recorder thread through the helper's own opts (provisionImpl
 * wins on the fresh path; rec records every step with its lane mode); the
 * local fork the helper's old signature forced is gone. Returns the mint
 * roster for the import step, the helper's honest createdInAttempt (the
 * R2-019 residue source when the post-snapshot dies mid-window), and the
 * R3-005 claim set for compensation.
 */
async function provisionAttempt(
  deps: LegDeps,
  client: LegClient,
  repoSlug: string,
  existingBankIds: string[],
  rec: Rec,
): Promise<{ ok: boolean; mode: string; roster: string[]; createdInAttempt: string[]; claimable: string[] }> {
  const t0 = Date.now();
  const withElapsed = (step: string, outcome: string, detail?: unknown): void =>
    rec(step, outcome, { durationMs: Date.now() - t0, detail });

  const result = await rerunAwareProvision(client, repoSlug, {
    existingBankIds,
    // DD-17: the dedicated topology has no MCP bridge to probe — the literal
    // {registered, healthy} asserts the topology Z4's factory env carries.
    bridgeProbe: { registered: true, healthy: true },
    // F-005: the caller holds the provisioner's OWN provision.lock across the
    // whole diff window — suppress the inner single-flight (no deadlock).
    holdProvisionerLock: true,
    rec: withElapsed,
    ...(deps.provisionImpl !== undefined
      ? {
          provisionImpl: deps.provisionImpl as (
            opts: ProvisionOptions,
          ) => Promise<ProvisionResult>,
        }
      : {}),
  });
  // The mint roster: the provisioner's ACTUAL bank list on the fresh lane
  // (raw.banks bankIds — includes "exists" members, so a pre-existing
  // collective still receives the corpus; createdInAttempt alone would
  // under-import to only the created members), the canonical upsert roster on
  // the rerun lane.
  const freshBanks = (result.raw as { banks?: unknown } | undefined)?.banks;
  const roster =
    result.mode === "reupsert-existing"
      ? ((result.raw as { roster?: string[] }).roster ?? [])
      : Array.isArray(freshBanks)
        ? freshBanks
            .filter(
              (b): b is { bankId: string } =>
                b !== null && typeof b === "object" && typeof (b as { bankId?: unknown }).bankId === "string",
            )
            .map((b) => b.bankId)
        : result.createdInAttempt;
  return {
    ok: result.ok,
    mode: result.mode,
    roster,
    createdInAttempt: result.createdInAttempt,
    claimable: claimableCreates(result),
  };
}

// ---------------------------------------------------------------------------
// The serialized diff window
// ---------------------------------------------------------------------------

async function provisionWindow(
  deps: LegDeps,
  client: LegClient,
  mode: LegMode,
  repoSlug: string,
  rec: Rec,
  ext: Record<string, unknown>,
): Promise<boolean> {
  // Pre-snapshot — the diff's left edge. A failure here abandons the window:
  // with no left edge the diff is unknowable and NO compensation is attempted
  // (deleting under unknown attribution is worse than leaving residue named
  // by the next run).
  let pre: string[];
  try {
    pre = extractBankIds(await client.listBanks());
    rec("snapshot-pre", "ok", { detail: { count: pre.length } });
  } catch (e) {
    rec("snapshot-pre", "failed", {
      detail: `listBanks failed; diff window abandoned, no compensation attempted (unknown attribution): ${(e as Error).message}`,
    });
    return false;
  }

  const attempt = await provisionAttempt(deps, client, repoSlug, pre, rec);
  const provisionOk = attempt.ok;
  const roster = attempt.roster;

  // Post-snapshot — ALWAYS taken, even on a failed provision: the post∖pre
  // diff is the only honest created-in-attempt set (the provisioner's failure
  // envelope drops the partial roster).
  let post: string[];
  try {
    post = extractBankIds(await client.listBanks());
    rec("snapshot-post", "ok", { detail: { count: post.length } });
  } catch (e) {
    rec("snapshot-post", "failed", {
      detail: `listBanks failed; diff unavailable, no compensation attempted: ${(e as Error).message}`,
    });
    // R2-019 + PR-review: a post-snapshot failure mid-window abandons
    // compensation while the attempt's creates may have landed — the residue
    // statement must never imply clean when attribution is merely unknown.
    // Known creations (the status figure — claimable, a superset of the
    // helper's createdInAttempt under failure) are named; an attempt without
    // an attributable figure records unknown-attribution, never a bare [].
    const known = attempt.claimable;
    ext.residue = known;
    ext.residueReason =
      known.length > 0
        ? "unconfirmed-delete: post-snapshot failure stranded the attempt's creations with no delete attempted"
        : attempt.ok
          ? "post-snapshot failure: this attempt claimed no creations — nothing of ours is known stranded; unattributed window writes, if any, are not visible"
          : "unknown-attribution: the attempt failed without a status figure and the post-snapshot also failed — whether its provisioning created banks cannot be determined from this evidence; inspect the instance before the next run";
    return false;
  }

  // R3-005: the diff is OBSERVATION, the claim is ATTRIBUTION — compensation
  // deletes only the intersection; the rest of the diff is recorded and left.
  // PR-review fallback: a FAILED fresh provision's real envelope (ProvisionErr)
  // carries NO banks, so claimableCreates has no status figure exactly when
  // compensation matters — the attempt's own roster SHAPE (base, collision
  // suffixes, -dev-meta) matched against the diff is the honest fallback claim
  // (family writers are lock-serialized; probe banks cannot match the shape).
  // A GREEN attempt keeps its (possibly empty) claim: pre-existing members
  // were never creations, and an empty claim is then the truth.
  const diff = post.filter((id) => !pre.includes(id));
  const claimable =
    !attempt.ok && attempt.mode === "resolved-fresh" && attempt.claimable.length === 0
      ? rosterPatternClaim(repoSlug, diff)
      : attempt.claimable;
  const createdInAttempt = claimable.filter((id) => diff.includes(id));
  const unclaimedCreated = diff.filter((id) => !createdInAttempt.includes(id));
  ext.createdInAttempt = createdInAttempt;
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
  let failed = !provisionOk;

  // Seed-probe mint record (M1.3 reader contract) — only on a green provision.
  if (provisionOk) {
    const expertiseDir = (deps as { expertiseDir?: string }).expertiseDir ?? DEFAULT_EXPERTISE_DIR;
    const mint = await mintCorpus(client, roster, expertiseDir, repoSlug, rec);
    ext.mintRecord = mint.record;
    const notes: string[] = [];
    if (mint.note !== undefined) notes.push(mint.note);
    if (mint.oversized.length > 0) {
      // F-011: skipped, not failed — the importer's own per-entry discipline.
      notes.push(
        `${mint.oversized.length} oversized-skipped entr${mint.oversized.length === 1 ? "y" : "ies"} (kind oversized-skipped, wire > ${MAX_CONTENT_BYTES}B): ${mint.oversized.join("; ")}`,
      );
    }
    if (notes.length > 0) ext.mintNote = notes.join("; ");
    if (mint.failures.length > 0) {
      failed = true;
      ext.mintFailures = mint.failures;
      // F-010: compensation is bank-level only — a mid-mint failure leaves
      // partial retains in canonical banks; name them, per bank, alongside
      // the failures instead of an empty residue.
      ext.memoryResidue = mint.record;
    }
    // F-012: a green live leg on an absent/empty corpus is a hollow mint
    // record — fail it honestly (mock rehearsal keeps the note, stays green).
    if (mode === "live" && mint.note !== undefined) {
      failed = true;
      rec("mulch-corpus", "failed-live-corpus-absent-empty", { detail: mint.note });
    }
  } else {
    ext.mintRecord = {};
  }

  // Compensation — deletes EXACTLY the claimed creations (R3-005: claim ∩
  // diff), never a pre-attempt bank and never an unclaimed diff bank (probe /
  // manual / foreign creations stay in place, named above). ANY failed delete
  // keeps the leg non-zero with the residue named.
  const deleteOutcomes: Record<string, string> = {};
  const residue: string[] = [];
  if (failed && createdInAttempt.length > 0) {
    for (const bankId of createdInAttempt) {
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
    mintRecord: {},
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

  // The serialized diff window — the provisioner's OWN lock (F-005): a
  // concurrent CLI/other-caller run fails its own lock instead of
  // interleaving creates into this attempt's diff. R2-002: acquired through
  // leg-lib acquireHeartbeatLock — the leg's 900s window refreshes the lock
  // file's mtime while held, so a concurrent provisionBanks/CLI run (300s
  // age-only steal) never sees a live window as stale and steals into it.
  const lockPath = deps.lockPath ?? join(homedir(), ".hindsight", "provision.lock");
  const staleMs = deps.lockStaleMs ?? LEG_LOCK_STALE_MS;
  let release: (() => void) | null = null;
  try {
    // R2-020: the lock-dir mkdir lives INSIDE the try — a file-shaped dirname
    // or EACCES resolves fatal LegEvidence (writeEvidenceOrStderr), never a
    // bare crash out of runLeg.
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
    ok = await provisionWindow(deps, client, mode, repoSlug, rec, ext);
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
  // F-030: a run that mutated the instance (provisions, compensations,
  // residue) must never lose its outcomes to a failing evidence write — the
  // payload lands on stderr and the exit is fatal.
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
