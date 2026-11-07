/**
 * M2.3 — the combined memory live round (story m2-3-combined-memory-live-round):
 * ONE T2 round on ONE real exe.dev box against the VPS stack proving the full
 * memory cycle under one credential lifecycle — primed dispatch (<kg_context>
 * appendix, M1.2's seam) → in-box kg_recall by the real worker (M2.2's
 * extension, roster-granted) → revoke-verify teardown BEFORE box destroy
 * (M2.2's +76 memory-teardown leg) → the host-side five-probe negative battery
 * (M2.1's refusal table; the 0.8.6 no-auth danger retired). Plus the AC2
 * degrade control: a transport-dead gateway proceeds UNPRIMED, silently, never
 * EMPTY_KG_DIRECTIVE. Every leg writes its own scrubbed JSON to
 * _bmad-output/evidence/memory-live/ (AC6). Gating: QDS_E2E_LIVE=1 AND
 * QDS_E2E_TIER=2 exactly; unset, every leg is todoIf-off and touches nothing.
 *
 * MECHANISMS MIRRORED (not invented — each from the cited owner):
 *   - probe-bank family seeding: memory-cycle.live.test.ts SEAM MIRROR — a
 *     probe repo slug `qds-probe/m23-<rand>` whose {base, -dev-meta} pair the
 *     dispatch seam resolves; git insteadOf aliases the probe URL back to
 *     ctx.repoUrl for the dispatch subprocess only.
 *   - roster staging: production dispatch reads the ACTIVE roster from
 *     dirname(manifestPath)/roster.yaml (dispatch.ts). The round stages the
 *     round manifest + a byte-identical copy of the story's roster fixture
 *     into the tmp workspace and runs the dispatch verb with cwd = workspace,
 *     which is dispatch's repoRoot (deps.repoRoot ?? process.cwd) — so the
 *     STAGED roster is the one the pre-billing gate reads, the repo tree is
 *     never written, and the side-channel recall row lands under the workspace
 *     (DEFAULT_RECALL_DIR resolves against the same cwd), not into git status.
 *     The dispatch_task phase's spec.roster names the COMMITTED fixture path,
 *     which loadRoster resolves against the IN-BOX run root — so the pinned
 *     QDS_EXEDEV_SHA must carry config/rosters/memory-live.roster.yaml (an
 *     operator precondition; the byte-identity assert below keeps the staged
 *     gate-read roster and the in-box-loaded one from drifting).
 *   - worker model turn: tier2-self-compact's dispatch_task shape — the
 *     manifest's phase brief instructs the fixer worker to call kg_recall once
 *     against the round's probe bank. PRIMARY seam: the harvested trace DB's
 *     worker_output payload (the worker's structured reply must BOTH quote the
 *     round marker AND carry the round's recall witness — a token seeded ONLY
 *     into the retained memory content, never the prompt; the marker alone is
 *     an echo hole). The extension's `[kg-recall] {event:...}` stderr
 *     lines in the other harvested artifacts are RECORD-ONLY — team-lead-driver
 *     discards worker stderr on a green round, so that channel is unreachable
 *     on success (observability gap filed). KG_RECALL_CHAR_CEILING is IN-BOX
 *     ONLY (story Technical Notes) — NO host-side ceiling is asserted here; a
 *     kg_recall.truncated event is recorded as observed, never judged.
 *   - box-env forensics (AC3 negative control, sc2-7 precedent): PRE-destroy,
 *     the box's delivered env file (KEY_ENV_FILE under the box home) is read
 *     and diffed against the DD-16 pair BY NAME — the only memory-family
 *     credential names present must be exactly {QDS_KG_RECALL_KEY,
 *     QDS_KG_GATEWAY_URL}; values are never lifted off the box.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { openAuditStoreForWalk, sha256Hex, type AuditLinkRow } from "../../../src/audit/link-store.ts";
import { extractExistingBankIds, resolveProvisionedRepoBankId } from "../../../src/hindsight/bank-provisioner.ts";
import { HindsightClient } from "../../../src/hindsight/client.ts";
import { DEFAULT_RECALL_DIR, primeDispatchBrief, type RecallRow } from "../../../src/hindsight/kg-context.ts";
import { BankIdSchema, resolveBankId } from "../../../src/hindsight/schemas.ts";
import { forbiddenOrigin } from "../../../scripts/p0-9/leg-lib.ts";
import { openTraceReader } from "../../../src/phase-engine/trace/reader.ts";
import { KEY_ENV_FILE } from "../../../src/providers/credentials.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { runNegativeProbeBattery } from "../../../scripts/e2e/memory-negative-probes.ts";
import {
  REPO_ROOT,
  awaitBoxAbsent,
  boxExec,
  boxHome,
  destroyQuietly,
  emittedRunId,
  fetchBoxFile,
  fleetCleanupProblems,
  fleetLeftovers,
  fleetPartialOutput,
  keyLeakProblems,
  lastJsonLine,
  liveGate,
  liveTodoOff,
  listedKeyHashes,
  preflight,
  recoverDispatchIds,
  runFleet,
  scratchClone,
  secretHitsIn,
  settleRun,
  setEffectiveImage,
  teardownQuietly,
  tmpWorkspace,
  waitForSettledVerdict,
  type LiveCtx,
} from "./live-harness.ts";

// ─── round constants (parity with the tier2 siblings — config integers, copied) ──

/** 2026-11-06: 50_000 µ$/key capped BELOW this leg's real spend profile (the
 * M1.2 T2 round measured ~76k µ$ authed-call spend; same authored-expectation
 * defect family — the cap-bit phase fail read as "transient"). 500_000 =
 * $0.50/key headroom. (The e2e-plan §TIER-2 plan default this constant
 * originally quoted is superseded by the measured spend.) */
const T2_CAP_MICRO_USD = 500_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const T2_BOX_HOUR_RATE_MICRO_USD = 230_000;
/** Leg ceilings (L1+L2+L3 test timeouts): the worst-case box exposure on ONE box. */
const LEG_CEILINGS_MS = [2_700_000, 2_400_000, 3_600_000];
/** Ceiling sum → hours + box cost in µ$ (honest: ceilings, not expectation). */
const LEG_TOTAL_MS = LEG_CEILINGS_MS.reduce((a, b) => a + b, 0); // 8_700_000 ms ≈ 2.42 h
const LEG_TOTAL_HOURS = LEG_TOTAL_MS / 3_600_000;
const BOX_WORST_MICRO_USD = Math.ceil(LEG_TOTAL_HOURS * T2_BOX_HOUR_RATE_MICRO_USD);
/** The minted-runId grammar (dispatch.ts MINTED_RUN_ID_RE). */
const MINTED_RUN_ID = /^qds-\d{8}-[a-f0-9]{6}$/;
/** The story's roster fixture (another leaf's file; the round consumes it). */
const ROSTER_FIXTURE_REL = "config/rosters/memory-live.roster.yaml";
/** Memory-family env names — the DD-16 pair is the ONLY allowed set on the box. */
const DD16_PAIR = new Set(["QDS_KG_RECALL_KEY", "QDS_KG_GATEWAY_URL"]);
const MEMORY_ENV_NAME = /^(QDS_KG_|QDS_MEM|MEMGATE_|HINDSIGHT_)/;

/** `_bmad-output/evidence/memory-live/` — the story's evidence directory. */
const EVIDENCE_DIR_M23 = join(REPO_ROOT, "_bmad-output/evidence/memory-live");

/**
 * The M2 memory env, checked BY NAME before any spend: the memory legs, the
 * dispatch deliverer (mintAndDeliverMemoryKey) and the teardown leg all read
 * these; the battery refuses without them. Names only — values never read out.
 */
function requireMemoryGateEnv(): string {
  const origin = (process.env.QDS_KG_GATEWAY_URL ?? "").trim(); // dp:ok the blank IS the signal — the === "" check below refuses the round on it
  const missing = ["MEMGATE_ADMIN_KEY", "QDS_MEMGATE_SIGNING_KEY", "QDS_MEMGATE_LEDGER"].filter( // dp:ok blank = missing, named in the refusal
    (n) => (process.env[n] ?? "").trim() === "", // dp:ok blank = missing — this filter IS the validation; names land in the refusal
  );
  if (origin === "" || missing.length > 0) {
    throw new Error(`memory gateway env incomplete — QDS_KG_GATEWAY_URL${missing.length ? ` and ${missing.join(", ")}` : ""} unset`);
  }
  const trap = forbiddenOrigin(origin);
  if (trap !== null) throw new Error(trap);
  return origin;
}

/** The Hindsight memory env by name (memory-cycle's wrong-instance guard). */
function requireMemoryEnv(): string {
  const base = (process.env.HINDSIGHT_BASE_URL ?? "").trim(); // dp:ok blank = unset, refused by the next line
  if (base === "") throw new Error("HINDSIGHT_BASE_URL unset — the memory env is required for this leg");
  const trap = forbiddenOrigin(base);
  if (trap !== null) throw new Error(trap);
  if ((process.env.HINDSIGHT_BEARER_TOKEN ?? "").trim() === "") { // dp:ok blank = unset, refused right here
    throw new Error("HINDSIGHT_BEARER_TOKEN unset — the memory env is required for this leg");
  }
  return base;
}

// ─── evidence (AC6: scrubbed, sweep-refused, quietly) ────────────────────────

/**
 * Deep scrub of the credential shapes the harness sweep knows — PLUS the two
 * value classes harness `scrubText` redacts and this file's sweep would
 * otherwise only REFUSE on (a lost evidence file instead of a redacted one):
 * the provisioning-key VALUE and any userinfo credential embedded in the
 * repo URL (the scratchClone-stderr shape).
 */
function scrubDeep(v: unknown): unknown {
  if (typeof v === "string") {
    let out = v
      .replace(/sk-or-[A-Za-z0-9_-]+/g, "[REDACTED-KEY]")
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED-KEY]")
      .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED-KEY]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-KEY]"); // dp:ok scrubber, not validation — blanking IS its job
    const provisioning = (process.env.OPENROUTER_PROVISIONING_KEY ?? "").trim(); // dp:ok absent key = nothing to scrub, not an error here
    if (provisioning.length > 8) out = out.split(provisioning).join("[REDACTED-KEY]");
    const repoUrl = (process.env.QDS_EXEDEV_REPO_URL ?? "").trim(); // dp:ok absent URL = no userinfo class to scrub
    const schemeAt = repoUrl.indexOf("://");
    if (schemeAt >= 0) {
      const credEnd = repoUrl.indexOf("@", schemeAt + 3);
      if (credEnd >= 0) out = out.split(repoUrl.slice(schemeAt + 3, credEnd)).join("[REDACTED-URL-CREDENTIAL]");
    }
    return out;
  }
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = scrubDeep(val);
    return out;
  }
  return v;
}

/**
 * Scrubbed JSON → `_bmad-output/evidence/memory-live/<stamp>-<name>-<rand>.json`.
 * Write gate: the harness `secretHitsIn` set PLUS the battery's own `mgrun-`
 * key-material literal — any survivor refuses the write (memory-cycle's local
 * writer shape; the harness writeEvidence's destination is env-or-df3-e2e).
 * THROWS — callers inside a `finally` go through {@link writeM23EvidenceQuietly}.
 */
function writeM23Evidence(name: string, payload: Record<string, unknown>): string {
  mkdirSync(EVIDENCE_DIR_M23, { recursive: true });
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 19).replace(/:/g, "")}`;
  const path = join(EVIDENCE_DIR_M23, `${stamp}-${name}-${Math.random().toString(36).slice(2, 8)}.json`);
  const body = JSON.stringify(
    { ...(scrubDeep(payload) as Record<string, unknown>), writtenAt: now.toISOString() },
    null,
    2,
  );
  const hits = [...secretHitsIn(body), ...(body.includes("mgrun-") ? ["memory-key material (mgrun-…)"] : [])];
  if (hits.length > 0) {
    throw new Error(`evidence ${name} failed the secret scrub — ${hits.join("; ")} survived — refusing to write ${path}`);
  }
  writeFileSync(path, `${body}\n`);
  return path;
}

/** {@link writeM23Evidence} as CLEANUP — never throws (harness F11 rule). */
function writeM23EvidenceQuietly(name: string, payload: Record<string, unknown>, problems: string[]): void {
  try {
    const path = writeM23Evidence(name, payload);
    process.stderr.write(`[memory-live] ${name} evidence: ${path}\n`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    problems.push(`the ${name} evidence write FAILED: ${error}`);
    try {
      process.stderr.write(`[memory-live] ${name} EVIDENCE WRITE FAILED: ${error}\n`);
    } catch {
      // dead stderr — the problem entry still reaches settleRun
    }
  }
}

// ─── round state shared by the sequential legs ───────────────────────────────

interface RoundState {
  ctx?: LiveCtx;
  workspace: string;
  l3Workspace: string;
  recordsDir: string;
  auditDb: string;
  requestId: string;
  runId: string;
  vmName: string;
  repoBankId: string;
  marker: string;
  /**
   * Recall witness: a round-unique token seeded ONLY into the retained memory
   * content — never in the task prompt. Its appearance in a worker_output
   * payload proves real kg_recall data flowed (the marker alone is echoable —
   * it sits verbatim in the prompt).
   */
  witness: string;
  recallQuery: string;
  banksWeCreated: string[];
  /** undefined = L1 never completed the listing; a Set (even empty) = measured. */
  hashesBefore: ReadonlySet<string> | undefined;
  evidence: Record<string, unknown>[];
}

const round: RoundState = {
  workspace: "",
  l3Workspace: "",
  recordsDir: "",
  auditDb: "",
  requestId: "",
  runId: "",
  vmName: "",
  repoBankId: "",
  marker: "",
  witness: "",
  recallQuery: "",
  banksWeCreated: [],
  hashesBefore: undefined,
  evidence: [],
};

/** A fresh probe repo family (memory-cycle's SEAM MIRROR): slug + base pair id. */
function probeRepoFamily(): { slug: string; base: string } {
  const slug = `qds-probe/m23-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const base = resolveBankId(slug);
  expect(BankIdSchema.safeParse(base).success).toBe(true);
  expect(BankIdSchema.safeParse(`${base}-dev-meta`).success).toBe(true);
  return { slug, base };
}

/**
 * Parse the `[kg-recall] {json}` stderr lines out of one artifact's text.
 * Each entry carries the event payload plus `rawControlChars` — whether the
 * RAW emitted line held code points below 32 other than the line's own newline
 * framing (the F10 hygiene observation, checked by code point, not regex).
 */
function kgRecallEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf("[kg-recall] ");
    if (at < 0) continue;
    const rawControlChars = [...line].some((c) => {
      const code = c.charCodeAt(0);
      // tab (9) and CR (13) are line framing (a CRLF file CRs every line), not payload
      return code < 32 && code !== 9 && code !== 13;
    });
    try {
      events.push({ rawControlChars, ...JSON.parse(line.slice(at + "[kg-recall] ".length)) as Record<string, unknown> }); // dp:ok inside the try{} — a torn line is caught and recorded unparseable, never thrown
    } catch {
      // a torn line is recorded as unparseable below, never silently dropped —
      // and its own control-char observation rides along so the hygiene rollup
      // cannot read vacuously true over torn output
      events.push({ event: "unparseable", line: line.slice(0, 120), rawControlChars }); // dp:ok the parse is try/catch-guarded above; torn lines are recorded, never trusted
    }
  }
  return events;
}

// ─── the round ───────────────────────────────────────────────────────────────

describe("memory combined live (M2.3)", () => {
  test.todoIf(liveTodoOff())("L0 spend: worst-case printed before anything bills", () => {
    const worst = (BOX_WORST_MICRO_USD + T2_CAP_MICRO_USD) / 1_000_000;
    const legs = LEG_CEILINGS_MS.map((ms) => `${(ms / 1_000_000).toFixed(1)}`).join(" + ");
    process.stdout.write(
      `M2.3 worst-case spend: 1 box, worst case ≤ ${LEG_TOTAL_HOURS.toFixed(2)} h across the three legs (${legs} Mms; ≈ $${(T2_BOX_HOUR_RATE_MICRO_USD / 1_000_000).toFixed(2)}/h) + 1 key capped ${T2_CAP_MICRO_USD} µ$ (gates + armed resident + one dispatch_task worker turn) + probe keys/Hindsight REST ($0) = ≤ $${worst.toFixed(2)}. Ceilings, not expectation. Box + keys + probe banks cleaned in finally.\n`,
    );
    expect((process.env.QDS_EXEDEV_SHA ?? "").length).toBe(40); // dp:ok the ?? "" IS the validation — blank fails the 40-char assert
  });

  test.todoIf(liveTodoOff())(
    "LD degrade [AC2 control]: unreachable gateway proceeds UNPRIMED — silent, no kg_context, never EMPTY_KG_DIRECTIVE",
    async () => {
      // The host-side control never creates a box (and must not need preflight).
      setEffectiveImage(null, { note: "degrade control never creates a box" });
      const problems: string[] = [];
      try {
        requireMemoryEnv(); // the env gate must be OPEN or the ladder stops at (a) with no row
        const ws = tmpWorkspace("m23-ld");
        try {
          const brief = { repoSlug: "qds-probe/m23-degrade", issueId: 46 };
          const requestId = randomUUID();
          const recallDir = join(ws, DEFAULT_RECALL_DIR);
          const client = new HindsightClient({ baseUrl: "http://127.0.0.1:1" }); // connection refused
          const primed = await primeDispatchBrief(brief, { client, recallDir, requestId });
          expect(primed).toBe(brief); // ladder (b): the SAME reference, v5 byte-identical
          expect("kgContext" in primed).toBe(false); // silent — no <kg_context> appendix
          const rowPath = join(recallDir, `${requestId}.json`);
          expect(existsSync(rowPath)).toBe(true);
          const row = JSON.parse(readFileSync(rowPath, "utf8")) as RecallRow; // dp:ok the file exists (asserted above) and the seam wrote it; a malformed row fails the leg loudly on field access
          expect(row.primed).toBe(false);
          expect(row.directive).toBe("none"); // NOT "empty" — zero-observations is a different branch
          writeM23EvidenceQuietly(
            "m23-degrade-control",
            {
              phase: "memory-live.degrade-control",
              unreachableOrigin: "http://127.0.0.1:1",
              requestId,
              row,
              noThrow: true,
              emptyKgDirectiveEmitted: false,
            },
            problems,
          );
        } finally {
          rmSync(ws, { recursive: true, force: true });
        }
      } catch (e) {
        writeM23EvidenceQuietly(
          "m23-degrade-control",
          { phase: "memory-live.degrade-control", error: e instanceof Error ? e.message : String(e) },
          problems,
        );
        if (problems.length > 0) {
          throw new Error(`${problems.join("; ")} (also failed: ${e instanceof Error ? e.message : String(e)})`, { cause: e });
        }
        throw e;
      }
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
    60_000,
  );

  test.todoIf(liveTodoOff())(
    "L1 primed dispatch: probe family seeded, <kg_context> primed, side-channel row, box armed",
    async () => {
      liveGate("2");
      requireMemoryEnv();
      requireMemoryGateEnv();
      let failure: unknown;
      const evidenceProblems: string[] = [];
      try {
        round.ctx = await preflight("2");
        const ctx = round.ctx;
        round.hashesBefore = await listedKeyHashes(); // F17 key-delta baseline
        round.workspace = tmpWorkspace("m23");
        round.recordsDir = join(round.workspace, "runs");
        round.auditDb = join(round.workspace, "audit.db");
        mkdirSync(round.recordsDir, { recursive: true });
        const env = { QDS_RUNS_DIR: round.recordsDir, QDS_AUDIT_DB: round.auditDb };
        writeFileSync(
          join(round.workspace, "cost-config.json"),
          JSON.stringify({ defaultCapMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD }),
        );

        // ── stage the manifest pair the dispatch gate reads (see header) ────
        const fixture = join(REPO_ROOT, ROSTER_FIXTURE_REL);
        if (!existsSync(fixture)) {
          throw new Error(`${ROSTER_FIXTURE_REL} is missing — the story's roster fixture must exist before the round fires`);
        }
        // The STAGED copy above reads the working tree, but the in-box
        // spec.roster load reads the PUSHED tree at the pinned SHA — pre-spend,
        // fail here rather than on the box. The bare-SHA probe first, so a
        // fetch problem reads as a fetch problem, not a missing fixture.
        const shaPresent = Bun.spawnSync(["git", "cat-file", "-e", ctx.sha], { cwd: REPO_ROOT, stderr: "pipe" });
        if (shaPresent.exitCode !== 0) {
          throw new Error(`QDS_EXEDEV_SHA ${ctx.sha} not present locally — fetch or correct the export; cannot verify the fixture at the pinned SHA`);
        }
        const atSha = Bun.spawnSync(["git", "cat-file", "-e", `${ctx.sha}:${ROSTER_FIXTURE_REL}`], { cwd: REPO_ROOT, stderr: "pipe" });
        if (atSha.exitCode !== 0) {
          throw new Error(`the pinned QDS_EXEDEV_SHA (${ctx.sha}) does not carry ${ROSTER_FIXTURE_REL} — the in-box spec.roster load reads the pushed tree; commit + push the fixture before firing`);
        }
        const rosterDir = join(round.workspace, "config", "rosters");
        mkdirSync(rosterDir, { recursive: true });
        copyFileSync(fixture, join(rosterDir, "roster.yaml"));
        const manifestRel = "config/rosters/m23-memory.pipeline.json";
        const manifestPath = join(round.workspace, manifestRel);
        round.requestId = randomUUID(); // strict UUID v4 so dispatch HONOURS it
        const probe = probeRepoFamily();
        const base = probe.base;
        const devMeta = `${base}-dev-meta`;

        // ── seed the PROBE FAMILY the dispatch seam resolves ────────────────
        const mem = new HindsightClient();
        const existing = extractExistingBankIds(await mem.listBanks());
        expect(existing.has(base)).toBe(false);
        expect(existing.has(devMeta)).toBe(false);
        round.repoBankId = base;
        await mem.createBank(base);
        round.banksWeCreated.push(base); // armed AFTER its own create resolves
        await mem.createBank(devMeta);
        round.banksWeCreated.push(devMeta); // so a partial create never deletes a bank that was never made
        const seamResolved = resolveProvisionedRepoBankId(base, extractExistingBankIds(await mem.listBanks()));
        expect(seamResolved).toBe(base);
        const marker = `m23 kg recall marker ${base}`;
        round.marker = marker;
        round.recallQuery = marker; // the in-box task recalls the seeded subject by this phrase
        // The recall witness rides the RETAINED CONTENT only — never the task
        // prompt — so its presence in the worker's structured output is proof
        // of real recall, not echo (the marker is in the prompt and echoable).
        const witness = `m23-witness-${randomUUID().slice(0, 8)}`;
        round.witness = witness;
        await mem.retain(
          base,
          `${marker}: the M2.3 combined-memory live round seeds this observation (recall witness ${witness}) for the ${probe.slug} probe family (issue 46) so dispatch-time priming and the in-box kg_recall both have a subject to hit.`,
          { documentId: `m23-prime-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`, updateMode: "replace", kind: "observation", source: "agent" },
        );

        // ── the manifest: code settle + the dispatch_task worker recall turn ──
        const task =
          `You are a memory-recall test worker. Work strictly alone and modify nothing in the repository. Step 1: call the kg_recall tool exactly ONCE with bank "${base}" and query "${marker}" (limit 5). Step 2: finish with the required JSON reply whose result.summary states how many memories came back and quotes THREE lines of the returned data verbatim, in order: first the block's header line (the one beginning "===== UNTRUSTED RECALLED DATA (kg_recall)"), then the FIRST data line below the header, then the SECOND data line below the header. Never call kg_recall with any other bank id.`;
        writeFileSync(
          manifestPath,
          JSON.stringify({
            version: "1.0.0",
            pipelineId: "m23-combined-memory",
            // 900,000 ≥ dispatch's requiredBudgetMs (3 phases × retries+1 ×
            // PARSE_FIX_ATTEMPTS+1 × maxDurationMs + routing margins) — 600,000
            // made dispatch refuse the manifest pre-spend EVERY run (R2-001).
            runBudgetMs: 900_000,
            phases: [
              {
                name: "m23-engine-probe",
                kind: "code",
                description: "M2.3 live round opening phase that echoes the round marker.",
                command: ["echo", "m23-combined-memory-ran"],
                maxDurationMs: 1000,
                retries: 0,
              },
              {
                name: "m23-kg-recall",
                kind: "dispatch_task",
                description: `M2.3 in-box recall turn for the ${probe.slug} probe family: the worker recalls this run's memory through kg_recall.`,
                roster: ROSTER_FIXTURE_REL,
                task,
                maxDurationMs: 240_000,
                retries: 0,
              },
              {
                name: "m23-close",
                kind: "code",
                description: "M2.3 closing sanity phase; the schema wants a closing phase and this one is free.",
                command: ["true"],
                maxDurationMs: 1000,
                retries: 0,
              },
            ],
          }),
        );
        // Staged roster ≡ the fixture content AT THE PINNED SHA — a staged vs
        // working-tree assert is a tautology (copyFileSync then sha256 of the
        // same bytes); the in-box spec.roster load reads the pushed tree, so
        // byte-identity is only meaningful against the SHA's blob.
        const atShaRoster = Bun.spawnSync(["git", "cat-file", "blob", `${ctx.sha}:${ROSTER_FIXTURE_REL}`], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
        if (atShaRoster.exitCode !== 0) {
          throw new Error(`could not read ${ROSTER_FIXTURE_REL} at the pinned QDS_EXEDEV_SHA (${ctx.sha}) — the in-box spec.roster load reads the pushed tree; commit + push the fixture before firing`);
        }
        expect(sha256Hex(readFileSync(join(rosterDir, "roster.yaml"), "utf8"))).toBe(sha256Hex(atShaRoster.stdout.toString()));

        // ── DoD roster-check preflight (runbook step, wired): exit 1 = a slug
        // is rejected → refuse the round pre-spend; exit 2 = the host lacks the
        // live-provider half (pi binary / OPENROUTER_API_KEY) → warn + proceed,
        // the runbook step still stands for the firing operator; exit 0 = green.
        // DoD letter: green BEFORE fire — any nonzero exit refuses the round.
        // The --roster target is the IN-REPO fixture (loadRoster confines to
        // the repo root; the staged tmp copy is outside it by design), which
        // is sound because the sha-bound compare above proved the staged
        // bytes == the pinned-SHA bytes == this file's committed bytes.
        const rosterCheck = Bun.spawnSync(["bun", "scripts/roster-check.ts", "--roster", join(REPO_ROOT, ROSTER_FIXTURE_REL)], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
        if (rosterCheck.exitCode !== 0) {
          throw new Error(`roster-check did not go green (exit ${rosterCheck.exitCode}) on ${ROSTER_FIXTURE_REL} — the DoD gate stands before fire: ${[rosterCheck.stdout.toString(), rosterCheck.stderr.toString()].join(" ").trim().slice(-400)}`);
        }
        const rosterCheckVerdict = "green";
        round.evidence.push({ phase: "roster-check", rosterCheck: rosterCheckVerdict });

        const briefPath = join(round.workspace, "brief.json");
        const probeUrl = `https://github.com/${probe.slug}.git`;
        writeFileSync(
          briefPath,
          JSON.stringify({
            repoSlug: probe.slug,
            issueId: 46,
            requestId: round.requestId,
            commitSha: ctx.sha,
            manifestPath: manifestRel,
            repoUrl: probeUrl,
          }),
        );
        // Git's insteadOf, scoped to THIS subprocess's env (never ~/.gitconfig):
        // the probe URL aliases to the real repo so fill's host-side bundle-push
        // clones the REAL repo at ctx.sha.
        const gitAliasEnv = {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${ctx.repoUrl}.insteadOf`,
          GIT_CONFIG_VALUE_0: probeUrl,
        };

        const boxHoursUsd = T2_BOX_HOUR_RATE_MICRO_USD / 1_000_000;
        process.stderr.write(
          `[memory-live] FIRING dispatch: 1 box, worst case ≤ ${LEG_TOTAL_HOURS.toFixed(2)} h across the three legs (${LEG_CEILINGS_MS.map((ms) => `${(ms / 1_000_000).toFixed(1)}`).join(" + ")} Mms; ≈ $${boxHoursUsd.toFixed(2)}/h) + 1 key capped ${T2_CAP_MICRO_USD} µ$ → worst case ≤ $${((BOX_WORST_MICRO_USD + T2_CAP_MICRO_USD) / 1_000_000).toFixed(2)} (ceilings, not expectation)\n`,
        );

        // cwd = workspace → dispatch's repoRoot resolves the STAGED pair and
        // writes the side-channel row UNDER the workspace (not the repo tree).
        const dispatch = await runFleet(
          [
            "dispatch",
            "--driver",
            "exedev",
            "--brief",
            briefPath,
            "--dir",
            round.recordsDir,
            // dual-role (tier2-rig-swarm-mixed): dispatch wall clock AND the
            // callerBudgetMs ceiling — runBudgetMs 900,000 must fit UNDER it
            // with headroom, or the ceiling refuses the manifest pre-spend.
            "--timeout-ms",
            "960000",
          ],
          { cwd: round.workspace, env: { ...env, ...gitAliasEnv }, timeoutMs: 1_200_000 },
        ).catch((e: unknown) => {
          const partial = fleetPartialOutput(e);
          const recovered = recoverDispatchIds(partial.stdout, partial.stderr);
          if (round.runId === "" && recovered.runId !== "") round.runId = recovered.runId;
          if (round.vmName === "" && recovered.vmName !== "") round.vmName = recovered.vmName;
          // live-mirror: live-harness.ts RunFleetTimeoutError ("runFleet timeout after N ms") — /timeout/ is its stable marker
          round.evidence.push({ phase: "dispatch-verb-failure", timedOut: e instanceof Error && /timeout/i.test(e.message), recoveredRunId: round.runId || null, recoveredVmName: round.vmName || null });
          throw e;
        });
        const ack = lastJsonLine<{ runId?: string; vmName?: string; state?: string }>(dispatch.stdout);
        if (ack.runId && round.runId === "") round.runId = ack.runId;
        if (ack.vmName && round.vmName === "") round.vmName = ack.vmName;
        const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
        if (emitted !== undefined && round.runId === "") round.runId = emitted;
        round.evidence.push({ phase: "dispatch-verb", exitCode: dispatch.exitCode, stderrTail: dispatch.stderr.trim().slice(-600) });
        expect(dispatch.exitCode).toBe(0);
        expect(ack.state).toBe("ready");
        expect(round.runId).toMatch(MINTED_RUN_ID);

        // ── the side-channel recall row (M1.2's observability seam) ─────────
        const rowPath = join(round.workspace, DEFAULT_RECALL_DIR, `${round.requestId}.json`); // dp:ok requestId is UUIDv4-generated above, never external
        expect(existsSync(rowPath)).toBe(true);
        const row = JSON.parse(readFileSync(rowPath, "utf8")) as RecallRow; // dp:ok existsSync asserted above; the file was written by the seam this round drove — malformed JSON fails the leg loudly
        round.evidence.push({ phase: "side-channel-row", rowPath: rowPath.replace(round.workspace, ""), row });
        expect(row.runId).toBe(round.requestId);
        expect(row.primed).toBe(true);
        expect(row.directive).toBe("kg_context");
        expect(row.banks).toContain(base);
        expect(row.recalledDocumentIds.length).toBeGreaterThan(0);
        expect(row.chars).toBeGreaterThan(0);

        const live = (await ctx.driver.list()).map((b) => b.name);
        expect(live).toContain(round.vmName);
        const rec = new RunRecordStore({ dir: round.recordsDir }).get(round.runId);
        expect(rec.vmName).toBe(round.vmName);
        expect(rec.keyHash ?? "").not.toBe(""); // dp:ok the ?? "" IS the validation — blank fails the assert
        expect(rec.limitMicroUsd).toBe(T2_CAP_MICRO_USD);
        round.evidence.push({ phase: "memory-live.primed-dispatch", ok: true, runId: round.runId, vmName: round.vmName, keyHash: rec.keyHash });
      } catch (e) {
        failure = e;
        round.evidence.push({ phase: "test-error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        // DELIBERATE: no cleanup here — L3 owns the full cleanup verdict; the
        // ids are armed above every assertion that can throw (EB3/F4).
        writeM23EvidenceQuietly(
          "m23-primed-dispatch",
          {
            phase: "memory-live.primed-dispatch",
            runId: round.runId,
            vmName: round.vmName,
            requestId: round.requestId,
            repoBankId: round.repoBankId,
            image: round.ctx === undefined ? null : { ref: round.ctx.driver.image, buildId: round.ctx.driver.imageBuildId },
            phases: round.evidence,
          },
          evidenceProblems,
        );
      }
      // Evidence problems must not be masked by a test failure (nor vice
      // versa): both present → problems lead, the failure rides as the cause.
      if (failure !== undefined && evidenceProblems.length > 0) {
        throw new Error(`${evidenceProblems.join("; ")} (also failed: ${failure instanceof Error ? failure.message : String(failure)})`, { cause: failure });
      }
      if (failure !== undefined) throw failure;
      if (evidenceProblems.length > 0) throw new Error(evidenceProblems.join("; "));
    },
    2_700_000,
  );

  test.todoIf(liveTodoOff())(
    "L2 in-box recall: engine settles, kg_recall fired in-box (no refusal), DD-16-only box env, harvest + receipt dedup",
    async () => {
      liveGate("2");
      const ctx = round.ctx;
      const { recordsDir, runId, vmName, auditDb } = round;
      let failure: unknown;
      const evidence: Record<string, unknown>[] = round.evidence;
      const evidenceProblems: string[] = [];
      try {
        if (ctx === undefined || runId === "" || vmName === "" || round.witness === "") {
          throw new Error("L1 did not reach dispatch (or never seeded the recall witness) — nothing to run; refusing a hollow leg");
        }
        const env = { QDS_RUNS_DIR: recordsDir, QDS_AUDIT_DB: auditDb };
        const started = await runFleet(["run", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: REPO_ROOT, env, timeoutMs: 300_000 });
        evidence.push({ phase: "run-verb", exitCode: started.exitCode, stderrTail: started.stderr.trim().slice(-4000), stdoutTail: started.stdout.trim().slice(-2000) });
        expect(started.exitCode).toBe(0);
        const state = await waitForSettledVerdict({ recordsDir, evidence }, runId, { attempts: 30, waitMs: 10_000 });
        evidence.push({ phase: "settled", state });
        if (state !== "ok") {
          // In-box journald holds the team-lead-driver's stderr — including the
          // "worker <id> stderr tail:" lines the runner's stdio discard hides.
          // Fetch the tail as evidence BEFORE L3 tears the box down.
          try {
            const jr = await boxExec(ctx.driver, vmName, ["sh", "-c", `journalctl -u 'qds-run@${runId}*' --no-pager -q 2>/dev/null | grep -iE "stderr tail|coms_await|worker|spawn|error" | tail -c 5000 || true`]);
            evidence.push({ phase: "journal-tail", tail: jr.stdout.trim().slice(-5000) });
          } catch { evidence.push({ phase: "journal-tail", error: "fetch failed (box may be gone)" }); }
        }
        // live-mirror: src/fleet/run-completion.ts ChainOutcome "ok" (the settled chain verdict literal)
        expect(state).toBe("ok");

        // ── box-env forensics (AC3 negative control), box still ALIVE ───────
        // The delivered env file (KEY_ENV_FILE under the box home) is diffed
        // against the DD-16 pair BY NAME — values stay on the box, never in
        // evidence. Any second memory-family credential name FAILS the leg.
        const home = await boxHome(ctx.driver, vmName);
        const envFile = await fetchBoxFile(ctx.driver, vmName, join(home, KEY_ENV_FILE));
        const envNames = envFile.split("\n").map((l) => l.split("=")[0]?.trim() ?? "").filter((n) => n.length > 0 && !n.startsWith("#")); // dp:ok blank names are filtered out by the length check in this same chain
        const memoryNames = envNames.filter((n) => MEMORY_ENV_NAME.test(n));
        const foreign = memoryNames.filter((n) => !DD16_PAIR.has(n));
        evidence.push({
          phase: "box-env-forensics",
          envFile: KEY_ENV_FILE,
          memoryCredentialNames: [...memoryNames].sort(),
          dd16PairPresent: [...DD16_PAIR].every((n) => memoryNames.includes(n)),
          foreignMemoryNames: foreign,
          envFileChars: envFile.length,
        });
        expect(foreign).toEqual([]); // no second memory credential, no write-capable key
        expect([...DD16_PAIR].every((n) => memoryNames.includes(n))).toBe(true);

        // ── harvest: the box run context as rendered, never SSH-parsed ──────
        const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, round.workspace);
        const harvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, env, timeoutMs: 300_000 });
        evidence.push({ phase: "harvest-verb", exitCode: harvest.exitCode, stderrTail: harvest.stderr.trim().slice(-400) });
        expect(harvest.exitCode).toBe(0);
        const artifactsDir = join(recordsDir, `${runId}-artifacts`);
        expect(existsSync(artifactsDir)).toBeTrue();

        // ── the in-box kg_recall evidence, off the harvested artifacts ──────
        // The harvest layout nests SUBDIRECTORIES (journal/, trace/ — the
        // tier2-in-box-engine extractedFiles precedent), so the scan walks
        // recursively and reads FILES only: a readFileSync on a directory is
        // EISDIR, a green round must never die on its own artifact tree.
        const events: Array<{ file: string; event: Record<string, unknown> }> = [];
        const artifactFiles = readdirSync(artifactsDir, { recursive: true })
          .map((rel) => join(artifactsDir, rel as string))
          .filter((p) => statSync(p).isFile());
        for (const p of artifactFiles) {
          const text = readFileSync(p, "utf8");
          for (const event of kgRecallEvents(text)) events.push({ file: p.slice(artifactsDir.length + 1), event });
        }
        const calls = events.filter((e) => e.event.event === "kg_recall.call");
        const refusals = events.filter((e) => typeof e.event.event === "string" && e.event.event.startsWith("kg_recall.refused"));
        const truncations = events.filter((e) => e.event.event === "kg_recall.truncated");
        const unparseableCount = events.filter((e) => e.event.event === "unparseable").length;
        evidence.push({
          phase: "memory-live.in-box-recall",
          artifactClasses: [...new Set(events.map((e) => e.file.split(".").pop() ?? e.file))],
          // Observability gap (filed, not this story's surface): team-lead-driver
          // discards worker stderr on a green round, so this `[kg-recall]`
          // channel is UNREACHABLE on success — record-only here; a future fix
          // to the stderr channel lights these lines up for free.
          stderrChannel: "record-only — worker stderr is discarded by team-lead-driver on success (observability gap filed)",
          callEvents: calls.map((e) => ({ file: e.file, bank: e.event.bank, queryLength: e.event.queryLength, at: e.event.at })),
          refusalEvents: refusals.map((e) => ({ file: e.file, event: e.event.event })),
          // KG_RECALL_CHAR_CEILING is IN-BOX ONLY — recorded as observed, never judged here.
          truncationEvents: truncations.map((e) => ({ file: e.file, budget: e.event.budget, produced: e.event.produced })),
          // Hygiene only (F10): the emitted lines are JSON — no raw control chars.
          hygiene: events.every((e) => e.event.rawControlChars !== true),
          unparseableKgRecallLines: unparseableCount,
          // The Observability Contract says sub-timings report ABSENT, not 0:
          // no landed seam exposes the gateway-side server duration (the host
          // latencyMs rides the L1 side-channel row), and the extension emits
          // clientMs on refusals only.
          serverDurationMs: null,
          clientMs: "absent on success — the extension emits clientMs on refusals only",
        });
        // RECORD-ONLY: the stderr-channel verdict is the trace-db primary
        // below; a refusal seen in ANY channel is still a delivery defect.
        evidence.push({ phase: "stderr-channel-recall", callEventCount: calls.length, refusalCount: refusals.length });
        // A torn [kg-recall] line in the harvested trace is an anomaly worth
        // naming, not silencing (the parse path records it, this judges it).
        if (unparseableCount > 0) {
          evidenceProblems.push(`${unparseableCount} unparseable [kg-recall] line(s) in the harvested artifacts — torn control-channel output`);
        }
        if (refusals.length > 0) {
          evidence.push({ phase: "kg-recall-refusal-in-artifact-channel", defect: "refusal recorded in artifact channel", refusals: refusals.map((e) => ({ file: e.file, event: e.event.event })) });
        }

        // ── PRIMARY: the dispatch_task worker's structured output ───────────
        // The marker alone is an echo hole (it sits verbatim in the task
        // prompt), so the verdict requires BOTH: the marker (task compliance)
        // AND the round's recall witness — a token seeded ONLY into the
        // retained memory content, never the prompt. A payload carrying the
        // witness can only have read it out of real kg_recall output (the
        // seeded memory is the bank's sole document, so any quoted data line
        // carries it). This seam owns the verdict.
        const traceDbPath = join(artifactsDir, "trace", "trace.db");
        expect(existsSync(traceDbPath)).toBeTrue();
        const reader = openTraceReader(traceDbPath);
        const workerPayloads: Array<Record<string, unknown>> = [];
        try {
          let cursor = 0;
          for (;;) {
            const page = reader.readEvents(round.requestId, cursor);
            for (const row of page.rows) {
              // the tracer writes type as loose string; the reader's row type
              // pins a narrower union, so cast at the comparison (types.ts gap)
              if ((row.type as string | null) !== "worker_output" || typeof row.payload_json !== "string") continue;
              try {
                workerPayloads.push(JSON.parse(row.payload_json) as Record<string, unknown>);
              } catch {
                // a torn payload is recorded as unparseable, never silently dropped
                workerPayloads.push({ event: "unparseable-worker-output-payload" });
              }
            }
            if (!page.hasMore) break;
            cursor = page.cursor;
          }
        } finally {
          reader.close();
        }
        const payloadText = (p: Record<string, unknown>): string =>
          [p.summary, p.output].filter((s): s is string => typeof s === "string").join("\n");
        const markerHits = workerPayloads.filter((p) => payloadText(p).includes(round.marker));
        const witnessHits = workerPayloads.filter((p) => payloadText(p).includes(round.witness));
        evidence.push({
          phase: "memory-live.worker-output-primary",
          source: "trace/trace.db events(requestId).worker_output.payload_json",
          workerOutputCount: workerPayloads.length,
          markerCarried: markerHits.length > 0,
          witnessCarried: witnessHits.length > 0,
          markerSnippet: markerHits.length > 0 ? String(scrubDeep(payloadText(markerHits[0]!))).slice(0, 400) : null,
        });
        expect(markerHits.length).toBeGreaterThan(0); // task compliance: the output quotes the recalled marker
        expect(witnessHits.length).toBeGreaterThan(0); // proof of recall: the witness exists ONLY in the retained memory content

        // ── The run's retain receipt + J3's routing-decision meta receipt ───
        // Authored 2026-10-09 expecting EXACTLY ONE retain receipt; J3 (merged
        // 2026-10-14, PR #427) added the idempotent routing-<runId>-dev-meta
        // retain to every run, so TWO is the correct current shape — observed
        // live on fire 16 (the first run where the worker actually executed):
        // subjects [qds-20261107-cddbb3, routing-qds-20261107-cddbb3-dev-meta].
        const receiptRows = (): AuditLinkRow[] => {
          const handle = openAuditStoreForWalk(auditDb);
          try {
            return handle.linksForRun(runId).filter((l) => l.hop === "memory-retain-receipt" && l.event === "retain");
          } finally {
            handle.close();
          }
        };
        let receipts = receiptRows();
        evidence.push({ phase: "receipts-after-harvest", count: receipts.length, subjects: receipts.map((l) => l.subjectId ?? null) });
        const subjects = receipts.map((l) => l.subjectId ?? null);
        expect(receipts.length).toBe(2);
        expect(subjects).toContain(runId);
        expect(subjects).toContain(`routing-${runId}-dev-meta`);
        // QDS_LOG_VERBOSE: same rationale as the teardown verb — without it the
        // log sink mutes the child's stderr under NODE_ENV=test, and the
        // divergent assert below would pass vacuously on a muted stream.
        const reharvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, env: { ...env, QDS_LOG_VERBOSE: "1" }, timeoutMs: 300_000 });
        evidence.push({ phase: "reharvest-verb", exitCode: reharvest.exitCode });
        expect(reharvest.exitCode).toBe(0);
        // AC7: the store's divergent tamper alarm is LOG-ONLY (link-store) — the
        // walk cannot see it, so the re-emit leg asserts the verb's own stream is clean.
        expect(reharvest.stderr.includes("divergent")).toBe(false);
        receipts = receiptRows();
        evidence.push({ phase: "dedup-after-reharvest", receiptCount: receipts.length, divergentInReharvestStderr: reharvest.stderr.includes("divergent") });
        // Digest-stable dedup: reharvest adds NO new rows (both the run receipt
        // and the routing-meta receipt stay at their pre-reharvest counts).
        expect(receipts.length).toBe(subjects.length); // === 2: no second row, no divergent alarm
      } catch (e) {
        failure = e;
        evidence.push({ phase: "test-error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        writeM23EvidenceQuietly(
          "m23-in-box-recall",
          {
            phase: "memory-live.in-box-recall",
            runId,
            vmName,
            image: ctx === undefined ? null : { ref: ctx.driver.image, buildId: ctx.driver.imageBuildId },
            phases: evidence,
          },
          evidenceProblems,
        );
      }
      // Evidence problems must not be masked by a test failure (nor vice
      // versa): both present → problems lead, the failure rides as the cause.
      if (failure !== undefined && evidenceProblems.length > 0) {
        throw new Error(`${evidenceProblems.join("; ")} (also failed: ${failure instanceof Error ? failure.message : String(failure)})`, { cause: failure });
      }
      if (failure !== undefined) throw failure;
      if (evidenceProblems.length > 0) throw new Error(evidenceProblems.join("; "));
    },
    2_400_000,
  );

  test.todoIf(liveTodoOff())(
    "L3 revoke-verified teardown + probe battery + audit walk + full cleanup",
    async () => {
      liveGate("2");
      const ctx = round.ctx;
      const { recordsDir, runId, vmName, auditDb, repoBankId } = round;
      const env = { QDS_RUNS_DIR: recordsDir, QDS_AUDIT_DB: auditDb };
      let failure: unknown;
      const problems: string[] = [];
      const destroyFailures: string[] = [];
      let finalBoxes: string[] | undefined;
      let keyProblems: string[] = [];
      const bankProblems: string[] = [];
      const evidence: Record<string, unknown>[] = round.evidence;
      let bodyTeardownOk = false;
      try {
        if (ctx === undefined || runId === "" || vmName === "" || repoBankId === "") {
          throw new Error("L1/L2 did not reach a live run — nothing to tear down; refusing a hollow leg");
        }
        // scratchClone's clone path is join(parentDir, "host-clone") — L2's
        // clone still occupies round.workspace's, and `git remote add origin`
        // on an existing remote refuses, so L3 clones under a FRESH parent.
        round.l3Workspace = tmpWorkspace("m23-l3");
        const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, round.l3Workspace);

        // ── teardown: memory revoke-verify rides INSIDE, ahead of destroy ───
        // QDS_LOG_VERBOSE: the memgate-revoke / memgate-verify-revoked lines
        // this leg asserts are the ONLY memory-key revoke-verify evidence
        // (INV-M3-4 puts them in NO audit row), and the log sink MUTES both
        // streams under NODE_ENV=test (lib/log.ts:30) — which bun test
        // sets and runFleet merges into this child. Unmute for THIS verb only.
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], {
          cwd: hostRepo,
          env: { ...env, QDS_LOG_VERBOSE: "1" },
          timeoutMs: 300_000,
        });
        // The memgate lines are the per-token memory record (gateway.ts): the
        // skip-revoke shape is an explicit FAILURE, never a skip (AC4).
        const memRevoke = td.stderr.includes('"event":"memgate-revoke"');
        const memVerify = td.stderr.includes('"event":"memgate-verify-revoked"');
        const memSkip = /"event":"memgate-skip"/.exec(td.stderr)?.[0] ?? null;
        evidence.push({
          phase: "teardown-verb",
          exitCode: td.exitCode,
          memRevokeLine: memRevoke,
          memVerifyRevokedLine: memVerify,
          memgateSkipLine: memSkip,
          stderrTail: td.stderr.trim().slice(-400),
        });
        // 0 = full success; 6 = harvest_waived family — the verb's own
        // classification when the destructive work LANDED (box destroyed, key
        // revoked, record closed) but a close-step leftover (an unpriced row
        // or the run lock) is honestly reported. scripts/fleet.ts's teardown
        // docblock: "the failure above is the close step's leftover, not a
        // half-destroyed run". Fire 18 (first execution of this arm — fires
        // 14-17 never reached it) exited 6 with memRevokeLine + memVerifyRevoked
        // Line proven and finally-destroy ok. A 6 WITHOUT the work-landed lines
        // still reds below (memSkip/memRevoke asserts) and the finally arms
        // stay strict — this is acceptance of a documented outcome, not of a
        // dirty cleanup.
        const tdExit = td.exitCode ?? -1;
        expect([0, 6]).toContain(tdExit);
        expect(memSkip).toBeNull();
        expect(memRevoke).toBe(true);
        expect(memVerify).toBe(true);

        // ── ordering from the round's OWN record: revoke+verify BEFORE destroy
        const handle = openAuditStoreForWalk(auditDb);
        let rows: AuditLinkRow[];
        try {
          rows = handle.linksForRun(runId);
        } finally {
          handle.close();
        }
        const idx = (hop: string, event: string): number => rows.findIndex((r) => r.hop === hop && r.event === event);
        const revokeAt = idx("run-credential", "revoke");
        const verifyAt = idx("run-credential", "verify-revoked");
        const destroyAt = idx("run-box", "teardown");
        evidence.push({
          phase: "memory-live.revoke-verified",
          rowOrder: rows.map((r) => `${r.hop}.${r.event}@${r.occurredAt}`),
          revokeAt,
          verifyAt,
          destroyAt,
        });
        expect(revokeAt).toBeGreaterThanOrEqual(0);
        expect(verifyAt).toBeGreaterThan(revokeAt); // verify follows revoke
        expect(destroyAt).toBeGreaterThan(verifyAt); // BOTH precede the box destroy (INV-M3-3)

        const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
        expect(closed.closedAt ?? "").not.toBe(""); // dp:ok blank fails the assert
        expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0); // dp:ok undefined -> 0 fails the > 0 assert (the validation)
        expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T2_CAP_MICRO_USD); // dp:ok undefined -> 1 passes this arm only; the > 0 arm above already failed on undefined
        expect(closed.keyHash ?? "").not.toBe(""); // dp:ok the ?? "" IS the validation (round-1 F-009 fix); the later not.toContain is then non-vacuous
        expect(await listedKeyHashes()).not.toContain(closed.keyHash);
        const boxGone = await awaitBoxAbsent(ctx.driver, vmName, evidence);
        expect(boxGone.absent).toBe(true);
        bodyTeardownOk = true;
        // worst-case persisted alongside the actual (Observability Contract:
        // worst-case pre-fire + actual; legs ceiling sum 8.7M ms on one box).
        const worstCaseMicroUsd = Math.round((T2_BOX_HOUR_RATE_MICRO_USD * 8.7) / 3.6 + T2_CAP_MICRO_USD);
        evidence.push({
          phase: "memory-live.spend",
          spendMicroUsd: closed.spendMicroUsd,
          capMicroUsd: T2_CAP_MICRO_USD,
          worstCaseMicroUsd,
        });

        // ── AC7: the round's audit walk — digest-stable, volatile-free, frozen ──
        const volatile = [round.recallQuery, round.marker, round.witness].filter((s) => s.length > 0);
        const leaked = rows.filter((r) => {
          const flat = JSON.stringify(r);
          return flat.includes("memgate") || volatile.some((v) => flat.includes(v));
        });
        const counts = (hop: string, event: string): number => rows.filter((r) => r.hop === hop && r.event === event).length;
        evidence.push({
          phase: "audit-walk",
          rowTotal: rows.length,
          receiptRetain: counts("memory-retain-receipt", "retain"),
          credentialRevoke: counts("run-credential", "revoke"),
          credentialVerifyRevoked: counts("run-credential", "verify-revoked"),
          volatileOrGatewayRows: leaked.map((r) => `${r.hop}.${r.event}`),
          auditHopsUntouched: true,
        });
        // TWO, not one: the run's retain receipt + J3's routing-<runId>-dev-meta
        // retain (see the receipt-section comment in L2 — observed live, fire 16).
        expect(counts("memory-retain-receipt", "retain")).toBe(2);
        expect(counts("run-credential", "revoke")).toBe(1);
        expect(counts("run-credential", "verify-revoked")).toBe(1);
        expect(leaked).toEqual([]); // memgate-* events stayed log lines (AUDIT_HOPS untouched)
      } catch (e) {
        failure = e;
        evidence.push({ phase: "test-error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        // Failure-path backstops, each guarded on its OWN armed id (F4).
        if (ctx !== undefined && recordsDir !== "" && runId !== "" && !bodyTeardownOk) {
          const torn = await teardownQuietly(["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], { env, timeoutMs: 180_000 }, evidence, { at: "finally-teardown", runId });
          if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
        }
        if (ctx !== undefined && vmName !== "" && !bodyTeardownOk) {
          const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
          if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
        }
        for (const bankId of round.banksWeCreated) {
          try {
            const deleted = await new HindsightClient().deleteBank(bankId);
            evidence.push({ phase: "finally-delete-bank", ...deleted, bankId });
          } catch (e) {
            bankProblems.push(`probe bank ${bankId} delete FAILED: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Driver/API faults in this block must NOT skip the battery, the
        // evidence write, or settleRun below — cleanup probes record, never throw.
        try {
        if (ctx !== undefined) {
          finalBoxes = (await fleetLeftovers(ctx.driver, [vmName, runId], evidence)).owned;
          let store: RunRecordStore | undefined;
          try {
            if (recordsDir !== "") store = new RunRecordStore({ dir: recordsDir });
          } catch (e) {
            evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
          }
          // L1 died before listedKeyHashes → the baseline is UNMEASURED and
          // EVERY account key would flag as leaked. Unmeasured is not leaked —
          // but a genuinely empty baseline (measured, zero keys) is fine.
          if (round.hashesBefore === undefined) {
            keyProblems = ["key baseline UNMEASURED — L1 never completed listedKeyHashes; key-leak delta cannot be computed"];
          } else {
            keyProblems = await keyLeakProblems(round.hashesBefore, { driver: ctx.driver, store, runIds: [runId] }, evidence);
          }
        }
        } catch (e) {
          problems.push(`finally cleanup-probe chain FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
        // ── AC5: the five-probe battery, UNskippable — it fires in the finally
        // on EVERY exit path (the story: a probe that cannot run is a FAILED
        // round, never a skipped assertion). Assertions become problem lines:
        // a throw here would mask the cleanup verdicts (settleRun's rule).
        // A reason:null (transport-class) outcome is also a failure — allRefused
        // demands every probe's NAMED reason (a gateway that drifts off the
        // {error:{code}} contract fails, never skips).
        try {
          const battery = await runNegativeProbeBattery({
            origin: (process.env.QDS_KG_GATEWAY_URL ?? "").trim(), // dp:ok blank origin throws ProbeConfigError inside the battery (caught -> problem line)
            env: { ...process.env },
            requestId: round.requestId,
          });
          evidence.push({
            phase: "memory-live.probe-battery",
            outcomes: battery.outcomes.map((o) => ({
              phase: `memory-live.probe.${o.probe}:${o.refused ? "refused" : "NOT-REFUSED"}`,
              probe: o.probe,
              refused: o.refused,
              reason: o.reason,
              httpStatus: o.httpStatus,
              latencyMs: o.latencyMs,
              ttlExpiresAtMs: o.ttlExpiresAtMs,
              ttlFiredAtMs: o.ttlFiredAtMs,
            })),
            allRefused: battery.allRefused,
            mintedTokenCount: battery.mintedTokenIds.length,
            revokedInCleanup: (battery.cleanup ?? []).map((c) => c.result),
          });
          if (!battery.allRefused) {
            problems.push(
              `probe battery FAILED: ${battery.outcomes.map((o) => `${o.probe}=${o.refused ? `refused(${o.reason})` : `NOT-REFUSED(reason ${String(o.reason)}, http ${String(o.httpStatus)})`}`).join(", ")}`,
            );
          }
        } catch (e) {
          problems.push(`the probe battery FAILED to run: ${e instanceof Error ? e.message : String(e)}`);
        }
        writeM23EvidenceQuietly(
          "m23-revoke-verified",
          {
            phase: "memory-live.revoke-verified",
            runId,
            vmName,
            repoBankId,
            image: ctx === undefined ? null : { ref: ctx.driver.image, buildId: ctx.driver.imageBuildId },
            phases: evidence,
          },
          problems,
        );
        if (round.workspace !== "") rmSync(round.workspace, { recursive: true, force: true });
        if (round.l3Workspace !== "") rmSync(round.l3Workspace, { recursive: true, force: true });
      }
      settleRun(
        failure,
        ctx === undefined
          ? [...destroyFailures, ...bankProblems, ...problems]
          : [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems, ...bankProblems, ...problems],
      );
    },
    3_600_000,
  );
});
