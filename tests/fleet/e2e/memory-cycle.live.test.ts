/**
 * M1.2 AC7 — the memory cycle live round (v6a's only T2 round): primed
 * dispatch + idempotent harvest retain, end to end, on the real substrate.
 *
 * GATING: QDS_E2E_LIVE=1 AND QDS_E2E_TIER=2 (liveGate("2") throws on a tier
 * mismatch or a half-configured substrate env). Operator approves spend OUT
 * of band first; the round's worst-case figure is printed by the first leg
 * AND again immediately before the dispatch verb fires. With QDS_E2E_LIVE
 * unset every leg below is `todoIf`-ed off: the file imports cleanly,
 * registers zero executable tests, and touches NO network.
 *
 * WHAT IS REAL HERE (no fakes anywhere in this file — the story's negative
 * control: any mock/stub in the live path must fail review):
 *   - the memory legs drive the REAL HindsightClient against the dedicated
 *     instance named by the M1.2 memory env (HINDSIGHT_BASE_URL +
 *     HINDSIGHT_BEARER_TOKEN — env-only auth, INV-HM1; the client never sees
 *     a credential from this file). Real banks, real retain/recall REST.
 *   - the dispatch/harvest legs drive REAL `bun scripts/fleet.ts` subprocess
 *     verbs (the tier2-dispatch-engine pattern): one real exe.dev box, one
 *     real minted capped key, real setup gate, real in-box engine
 *     (`fleet run`, armed resident = real model spend), real harvest bundle +
 *     artifacts pull, real QDS_AUDIT_DB store for the round.
 *   - every assertion reads real substrate state: recall results, the
 *     side-channel row the dispatch subprocess wrote, the HARVESTED solicit
 *     prompt artifacts (the box run context as rendered — never SSH-parsed),
 *     the round's audit store rows.
 *
 * LEG STRUCTURE (sequential test() legs; state flows through `round`):
 *   L1  [VERIFY DD-28.26(3)] the echo — disposable `qds-probe-m12-*` bank,
 *       deterministic documentId, recall CONTAINS it (never keyed on a fact
 *       id), replay-retain leaves EXACTLY ONE document (live upsert,
 *       upsertObserved precedent: _bmad-output/evidence/p0-9-closure/
 *       2026-10-04T20-19-46Z-p0-9-document-id-retain-twice.json). On echo
 *       failure the named fallback engages and is PROVEN on a fresh bank:
 *       host-side retain-identity ledger keyed on documentId → skip-on-replay
 *       retains exactly one document.
 *   L2  primed dispatch — the marker is seeded into the bank the dispatch
 *       seam will resolve (see SEAM MIRROR below), the real dispatch primes,
 *       the in-box engine settles, the side-channel row reads
 *       {primed:true, directive:"kg_context"}.
 *   L3  harvest retain — the outcome document lands (documentId = runId),
 *       EXACTLY ONE memory-retain-receipt/retain row (subject = runId), the
 *       re-harvest produces NO second document and NO second receipt row;
 *       then the full cleanup verdicts (box, key, probe banks, leftovers).
 *
 * SEAM MIRROR (why L2 seeds a RESOLVER-fresh bank instead of L1's probe
 * bank): the dispatch fan-out set is exactly {<provision-time repo bank>,
 * qds-collective} (kg-context.ts recallFanOut), and BriefSchema ties
 * repoSlug to repoUrl's path — no live-round brief can resolve to a
 * `qds-probe-*` id. So L2 resolves the bank the SAME way the seam does —
 * `resolveRepoBankId(resolveBankId(repoSlug), liveBanks)` — which by
 * construction returns an id NOT in the live list; L2 creates it, seeds the
 * marker, and the fan-out deterministically recalls it. Freshness is also
 * the delete-safety guard: only banks this round created (absent from the
 * before-list) are deleted in cleanup, never a pre-existing production bank.
 *
 * EVIDENCE: scrubbed JSON per leg → _bmad-output/evidence/m1-2/ (AC7's dir;
 * timestamped like the sibling evidence files). The harness `writeEvidence`
 * is deliberately NOT used because its destination is env-or-df3-e2e and
 * this file must not set env; the local writer reuses the harness's
 * `secretHitsIn` as the write-refusal gate (keys/tokens never enter these
 * payloads by construction, and the sweep still refuses a leaked byte).
 * Box boot provenance rides every box-leg payload explicitly (image +
 * buildId off the preflight driver — the same fact F16 stamps).
 */
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { openAuditStoreForWalk, sha256Hex } from "../../../src/audit/link-store.ts";
import { extractExistingBankIds, resolveRepoBankId } from "../../../src/hindsight/bank-provisioner.ts";
import { HindsightClient } from "../../../src/hindsight/client.ts";
import { DEFAULT_RECALL_DIR, type RecallRow } from "../../../src/hindsight/kg-context.ts";
import { BankIdSchema, resolveBankId, type RecallResponse } from "../../../src/hindsight/schemas.ts";
import { forbiddenOrigin } from "../../../scripts/p0-9/leg-lib.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  REPO_ROOT,
  awaitBoxAbsent,
  destroyQuietly,
  emittedRunId,
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
  teardownQuietly,
  tmpWorkspace,
  waitForSettledVerdict,
  type LiveCtx,
} from "./live-harness.ts";

// ─── round constants ─────────────────────────────────────────────────────────

/** Plan default (e2e-plan.md §TIER-2): 50,000 µ$ = $0.05 worst-case per key. */
const T2_CAP_MICRO_USD = 50_000;
/** Box-hour rate from the operator's TIER-1 cost config (230,000 µ$/h). */
const T2_BOX_HOUR_RATE_MICRO_USD = 230_000;
/** The brief's repoSlug — canonically tied to QDS_EXEDEV_REPO_URL's path. */
const REPO_SLUG = "Quantum-Digital-Solutions/QDS-Factory";
/** The probe manifest the T2 tiers dispatch: code phases only, 60 s budget. */
const MANIFEST_PATH = "config/rosters/t2.pipeline.json";
/** The minted-runId grammar (dispatch.ts MINTED_RUN_ID_RE) — AC4's documentId. */
const MINTED_RUN_ID = /^qds-\d{8}-[a-f0-9]{6}$/;

/** `_bmad-output/evidence/m1-2/` — this round's evidence + ledger artifacts. */
const M12_EVIDENCE_DIR = join(REPO_ROOT, "_bmad-output/evidence/m1-2");

/** Dated, FIXED documentId suffix: same-day replays exercise the same identity. */
function datedStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/** A fresh, grammar-valid disposable probe bank id: `qds-probe-m12-<stamp>`. */
function probeBankId(): string {
  const id = `qds-probe-m12-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  expect(BankIdSchema.safeParse(id).success).toBe(true);
  return id;
}

/**
 * The M1.2 memory env — required by the memory legs, checked BY NAME (never
 * values). The wrong-instance trap (:8888 sidecar default / :18889 tenant
 * stack) is refused BEFORE any retain/recall fires (the p0-9 leg's guard).
 */
function requireMemoryEnv(): string {
  const base = (process.env.HINDSIGHT_BASE_URL ?? "").trim();
  if (base === "") {
    throw new Error("HINDSIGHT_BASE_URL is unset — the M1.2 memory env (HINDSIGHT_BASE_URL + HINDSIGHT_BEARER_TOKEN) is required for this leg");
  }
  const trap = forbiddenOrigin(base);
  if (trap !== null) throw new Error(trap);
  if ((process.env.HINDSIGHT_BEARER_TOKEN ?? "").trim() === "") {
    throw new Error("HINDSIGHT_BEARER_TOKEN is unset — the M1.2 memory env (HINDSIGHT_BASE_URL + HINDSIGHT_BEARER_TOKEN) is required for this leg");
  }
  return base;
}

// ─── evidence (AC7's dir; scrubbed; sweep-refused) ───────────────────────────

/** Deep string scrub — the same credential SHAPES the harness's sweep knows. */
function scrubDeep(v: unknown): unknown {
  if (typeof v === "string") {
    return v
      .replace(/sk-or-[A-Za-z0-9_-]+/g, "[REDACTED-KEY]")
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED-KEY]")
      .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED-KEY]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-KEY]");
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
 * Scrubbed JSON evidence → `_bmad-output/evidence/m1-2/<date>-<HHMMSS>-<name>
 * -<rand>.json`. Written PASS or FAIL (call from `finally`). The harness's
 * `secretHitsIn` is the write gate: any surviving secret shape refuses the
 * write — evidence that leaks is worse than no evidence. THROWS (mkdir/fs/
 * scrub refusal): callers inside a `finally` must go through
 * {@link writeM12EvidenceQuietly} so an evidence-write failure cannot skip
 * the cleanup verdicts or replace the held body error (the harness's F11
 * rule, mirrored here because `writeEvidenceQuietly` writes to the wrong
 * dir for this round).
 */
function writeM12Evidence(name: string, payload: Record<string, unknown>): string {
  mkdirSync(M12_EVIDENCE_DIR, { recursive: true });
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}-${now.toISOString().slice(11, 19).replace(/:/g, "")}`;
  const path = join(M12_EVIDENCE_DIR, `${stamp}-${name}-${Math.random().toString(36).slice(2, 8)}.json`);
  const body = JSON.stringify(
    { ...(scrubDeep(payload) as Record<string, unknown>), writtenAt: now.toISOString() },
    null,
    2,
  );
  const hits = secretHitsIn(body);
  if (hits.length > 0) {
    throw new Error(`evidence ${name} failed the secret scrub — ${hits.join("; ")} survived — refusing to write ${path}`);
  }
  writeFileSync(path, `${body}\n`);
  return path;
}

/** {@link writeM12Evidence} as CLEANUP — never throws (the harness's
 * `writeEvidenceQuietly` contract, pointed at this round's dir). */
function writeM12EvidenceQuietly(
  name: string,
  payload: Record<string, unknown>,
  problems: string[],
): string {
  try {
    const path = writeM12Evidence(name, payload);
    try {
      process.stderr.write(`[memory-cycle live] ${name} evidence: ${path}\n`);
    } catch {
      // dead stderr — the file is written regardless
    }
    return path;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    problems.push(`the ${name} evidence write FAILED: ${error}`);
    try {
      process.stderr.write(`[memory-cycle live] ${name} EVIDENCE WRITE FAILED: ${error}\n`);
    } catch {
      // dead stderr — the problem entry still reaches settleRun
    }
    return "";
  }
}

// ─── recall polling (real substrate, bounded) ────────────────────────────────

/**
 * Recall with a bounded re-poll: Hindsight's recall index can lag a just-
 * landed retain, so a zero-match count is RETRIED (a real recall each
 * attempt — never a fabricated result) before the caller's assertion
 * decides. Returns the LAST attempt's full response plus every attempt's
 * matching count, so the evidence shows the poll honestly.
 */
async function recallPolled(
  client: HindsightClient,
  bankId: string,
  query: string,
  documentId: string,
  opts: { attempts?: number; waitMs?: number } = {},
): Promise<{ res: RecallResponse; counts: number[] }> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const waitMs = opts.waitMs ?? 2_000;
  const counts: number[] = [];
  let res: RecallResponse = { results: [], durationMs: 0 };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    res = await client.recall(bankId, query, 25);
    counts.push(res.results.filter((r) => r.documentId === documentId).length);
    if (counts[attempt - 1] !== 0 || attempt === attempts) break;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return { res, counts };
}

/** The deterministic echo marker content — the replay retain is byte-identical BY CONSTRUCTION. */
function echoContent(docId: string): string {
  return `M1.2 live echo marker (documentId ${docId}): memory-cycle round-trip probe from tests/fleet/e2e/memory-cycle.live.test.ts — the additive null-tolerant documentId verification against the pinned Hindsight 0.10.0.`;
}

// ─── round state shared by the sequential legs ───────────────────────────────

interface RoundState {
  ctx?: LiveCtx;
  workspace: string;
  recordsDir: string;
  auditDb: string;
  requestId: string;
  runId: string;
  vmName: string;
  repoBankId: string;
  primeDocId: string;
  /** Banks THIS round created (resolver-fresh) — the only ones cleanup deletes. */
  banksWeCreated: string[];
  /** Side-channel recall rows the round wrote INTO THE REPO TREE
   * (`REPO_ROOT/_bmad-output/memory/recall/<id>.json`) — L3's finally removes
   * them so the round leaves nothing behind in `git status`. */
  recallRowPaths: string[];
  hashesBefore: ReadonlySet<string>;
  evidence: Record<string, unknown>[];
}

const round: RoundState = {
  workspace: "",
  recordsDir: "",
  auditDb: "",
  requestId: "",
  runId: "",
  vmName: "",
  repoBankId: "",
  primeDocId: "",
  banksWeCreated: [],
  recallRowPaths: [],
  hashesBefore: new Set<string>(),
  evidence: [],
};

// ─── the round ───────────────────────────────────────────────────────────────

describe("memory cycle live", () => {
  test.todoIf(liveTodoOff())("spend estimate printed before any box exists", () => {
    const boxHoursUsd = T2_BOX_HOUR_RATE_MICRO_USD / 1_000_000;
    process.stdout.write(
      `M1.2 memory-cycle worst-case spend: 1 box ≤ 1h (≈ $${boxHoursUsd.toFixed(2)}/h) + 1 key capped at ${T2_CAP_MICRO_USD} µ$ ` +
        `(gate C/D pings + armed-resident solicitations inside the cap) + Hindsight retain/recall REST ($0) = ≤ $${(
          boxHoursUsd + T2_CAP_MICRO_USD / 1_000_000
        ).toFixed(2)}. Realistic < $0.10. The key is revoked and the box destroyed in cleanup; probe banks are deleted in every leg's finally.\n`,
    );
    expect((process.env.QDS_EXEDEV_SHA ?? "").length).toBe(40);
  });

  // ── L1: the [VERIFY] echo (DD-28.26(3)) ──────────────────────────────────
  test.todoIf(liveTodoOff())(
    "L1 echo [VERIFY]: retain → recall documentId CONTAINS; replay-retain upserts to ONE document; fallback = ledger skip-on-replay on a fresh bank",
    async () => {
      liveGate("2");
      const base = requireMemoryEnv();
      const client = new HindsightClient({ baseUrl: base });
      const evidence: Record<string, unknown>[] = [];
      const workspace = tmpWorkspace("m12-l1");
      const banks: string[] = [];
      const problems: string[] = [];
      let failure: unknown;
      let mode = "server-upsert";
      const docId = `m12-echo-${datedStamp()}`;
      const content = echoContent(docId);
      const retainOpts = { documentId: docId, updateMode: "replace" as const, kind: "observation" as const, source: "agent" as const };
      try {
        // ── the echo round on a disposable bank ────────────────────────────
        const bankA = probeBankId();
        banks.push(bankA);
        evidence.push({ phase: "echo-setup", bankId: bankA, documentId: docId });
        await client.createBank(bankA);
        await client.retain(bankA, content, retainOpts);
        const first = await recallPolled(client, bankA, docId, docId);
        const containsDocId = first.res.results.some((r) => r.documentId === docId);
        // The fact ids the match rode on — recorded to show the assertion did
        // NOT key on them (distinct server-minted ids; never assumed equal).
        const factIds = first.res.results.filter((r) => r.documentId === docId).map((r) => r.memoryId);
        evidence.push({
          phase: "echo-recall-1",
          containsDocId,
          factIds,
          documentIds: first.res.results.map((r) => r.documentId),
          pollCounts: first.counts,
        });
        expect(containsDocId).toBe(true);

        // ── the replay retain: same documentId + same content ──────────────
        await client.retain(bankA, content, retainOpts);
        const second = await recallPolled(client, bankA, docId, docId);
        const matchesAfterReplay = second.res.results.filter((r) => r.documentId === docId).length;
        evidence.push({
          phase: "echo-recall-2",
          matchesAfterReplay,
          pollCounts: second.counts,
          upsertObservedPrecedent: "_bmad-output/evidence/p0-9-closure/2026-10-04T20-19-46Z-p0-9-document-id-retain-twice.json",
        });
        expect(matchesAfterReplay).toBe(1);

        // ── fallback ONLY on echo failure: ledger + skip-on-replay proof ───
        // (The two expects above throw here on failure; the catch engages the
        // fallback so the round can continue under the named degradation.)
      } catch (echoError) {
        mode = "fallback-skip-on-replay";
        failure = echoError;
        evidence.push({
          phase: "echo-fallback-engaged",
          reason: echoError instanceof Error ? echoError.message : String(echoError),
          fallback: "host-side retain-identity ledger keyed on documentId → skip-on-replay replaces server-side replace (DD-28.3 design intent, gated on this echo)",
        });
        try {
          // PROVE the fallback on a fresh bank, honestly (F10 — no invented
          // counts). EVERY retain below goes through ONE counting gate around
          // the REAL client — retains are FORWARDED (real network) and each
          // forwarded one increments `networkRetainCalls`: 1. retain once
          // (the identity's first sight; the ledger file does not exist yet,
          // so the gate finds no identity and the network retain happens);
          // 2. write the identity into the REAL host-side ledger file;
          // 3. attempt the SECOND retain through the SAME gate, which now
          // consults the file — identity present → the network retain is
          // SKIPPED; 4. the counter itself is the proof the skip happened
          // (it STAYS at the first retain's 1 — recording a hardcoded 0 was
          // the fabrication this leg once shipped) and the recall is the
          // proof the substrate STILL holds EXACTLY ONE document for the
          // identity. Only then is `replaysSkipped` written into the ledger —
          // a count naming something that actually happened. Any step that
          // cannot be proven fails the leg (the catch below).
          const bankB = probeBankId();
          banks.push(bankB);
          await client.createBank(bankB);
          const firstSeenAt = new Date().toISOString();
          // The ledger file lives under the round's evidence artifacts dir —
          // L1 has no run artifacts of its own, and a tmpdir would discard
          // the one artifact the fallback exists to leave behind. The count
          // is NOT in this write: nothing has been skipped yet.
          mkdirSync(M12_EVIDENCE_DIR, { recursive: true });
          const ledgerPath = join(M12_EVIDENCE_DIR, `m12-retain-identity-ledger-${datedStamp()}-${Math.random().toString(36).slice(2, 6)}.json`);
          // The counting gate: the ledger FILE is consulted on every attempt
          // — the ledger's whole point is what a host-side reader sees, so
          // the read lives INSIDE the gate, not in the test body — and a
          // file-absent / identity-absent read FORWARDS.
          let networkRetainCalls = 0;
          const gatedRetain = async (bankId: string, body: string) => {
            if (existsSync(ledgerPath)) {
              const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
                entries: { documentId: string; contentDigest: string }[];
              };
              if (ledger.entries.some((e) => e.documentId === docId && e.contentDigest === sha256Hex(body))) {
                return { skipped: true };
              }
            }
            networkRetainCalls += 1;
            return client.retain(bankId, body, retainOpts);
          };
          const firstRetain = await gatedRetain(bankB, content);
          const demo = await recallPolled(client, bankB, docId, docId);
          const oneDocument = demo.res.results.filter((r) => r.documentId === docId).length === 1;
          evidence.push({
            phase: "fallback-first-retain",
            bankId: bankB,
            forwarded: !("skipped" in firstRetain),
            networkRetainCalls,
            pollCounts: demo.counts,
          });
          expect(oneDocument).toBe(true);
          expect(networkRetainCalls).toBe(1);
          writeFileSync(
            ledgerPath,
            `${JSON.stringify(
              {
                mode,
                keyedOn: "documentId",
                entries: [
                  {
                    documentId: docId,
                    contentDigest: sha256Hex(content),
                    firstRetainedAt: firstSeenAt,
                    replayPolicy: "skip-on-replay",
                  },
                ],
              },
              null,
              2,
            )}\n`,
          );

          // The SECOND retain attempt runs through the SAME gate, which now
          // finds the identity in the file and SKIPS the network retain. The
          // two asserts below ARE the gate proof: `gateSkipped` is what the
          // gate RETURNED (not a restatement of intent) and the counter
          // STAYING at 1 shows no second network retain fired — if either is
          // false the fallback cannot be claimed and the leg fails. The
          // recall below is the substrate proof.
          const replay = await gatedRetain(bankB, content);
          const gateSkipped = "skipped" in replay;
          evidence.push({ phase: "fallback-replay-attempt", ledgerPath, gateSkipped, networkRetainCalls });
          expect(gateSkipped).toBe(true);
          expect(networkRetainCalls).toBe(1);

          const afterSkip = await recallPolled(client, bankB, docId, docId);
          const stillOne = afterSkip.res.results.filter((r) => r.documentId === docId).length === 1;
          evidence.push({ phase: "fallback-skip-proof", stillOne, pollCounts: afterSkip.counts });
          expect(stillOne).toBe(true);

          // NOW the count is written — the skip happened and was proven.
          writeFileSync(
            ledgerPath,
            `${JSON.stringify(
              {
                mode,
                keyedOn: "documentId",
                entries: [
                  {
                    documentId: docId,
                    contentDigest: sha256Hex(content),
                    firstRetainedAt: firstSeenAt,
                    replayPolicy: "skip-on-replay",
                    replaysSkipped: 1,
                  },
                ],
              },
              null,
              2,
            )}\n`,
          );
          evidence.push({ phase: "fallback-ledger", ledgerPath, replaysSkipped: 1, proven: true });
          // The fallback engaged AND its proof held: this is the leg's pass
          // condition ("continue the round with the fallback engaged") — the
          // echo failure stays recorded in the evidence, not in the verdict.
          failure = undefined;
        } catch (fallbackError) {
          failure = new Error(
            `the echo failed AND the fallback proof failed — the round cannot continue on this substrate: echo=(${
              echoError instanceof Error ? echoError.message : String(echoError)
            }) fallback=(${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`,
            { cause: echoError },
          );
        }
      } finally {
        // Probe-bank cleanup (M1.1's disposable-probe discipline): every bank
        // this leg created is deleted; a failed delete is recorded and fails
        // the leg AFTER the evidence write — a stranded bank is a real
        // failure, never a warning.
        for (const bankId of banks) {
          try {
            const deleted = await client.deleteBank(bankId);
            evidence.push({ phase: "finally-delete-bank", ...deleted, bankId });
          } catch (e) {
            problems.push(`probe bank ${bankId} delete FAILED: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        writeM12EvidenceQuietly(
          "m12-l1-echo",
          {
            test: "L1-echo",
            mode,
            documentId: docId,
            probeBankPrefix: "qds-probe-m12-",
            bootedBox: false,
            phases: evidence,
          },
          problems,
        );
        rmSync(workspace, { recursive: true, force: true });
      }
      settleRun(failure, problems);
    },
    // Priced at ceilings: ~8 client calls ≤ 30 s (RETAIN) / 10 s (RECALL) +
    // two recall polls ≤ 4 × (10 + 2) s each + two bank deletes ≤ 30 s each +
    // local writes. Every ceiling firing rejects into the catch; the finally
    // still runs. Healthy round: seconds.
    360_000,
  );

  // ── L2: primed dispatch + in-box engine (real box, real spend) ───────────
  test.todoIf(liveTodoOff())(
    "L2 primed dispatch: real box + capped key ≤ 50,000 µ$ — seam-mirrored bank seeded, kg_context primed, side-channel row, engine settles",
    async () => {
      liveGate("2");
      requireMemoryEnv(); // refuse BEFORE any spend: an unprimed dispatch would fail L2's assertions anyway
      let failure: unknown;
      const evidenceProblems: string[] = [];
      try {
        round.ctx = await preflight("2");
        const ctx = round.ctx;
        round.hashesBefore = await listedKeyHashes(); // F17 key-delta baseline
        round.workspace = tmpWorkspace("m12");
        round.recordsDir = join(round.workspace, "runs");
        mkdirSync(round.recordsDir, { recursive: true });
        // The round's OWN audit store (QDS_AUDIT_DB for every verb below) —
        // never the operator's .sandbox/audit.db.
        round.auditDb = join(round.workspace, "audit.db");
        const env = { QDS_RUNS_DIR: round.recordsDir, QDS_AUDIT_DB: round.auditDb };
        writeFileSync(
          join(round.workspace, "cost-config.json"),
          JSON.stringify({ defaultCapMicroUsd: T2_CAP_MICRO_USD, boxHourRateMicroUsd: T2_BOX_HOUR_RATE_MICRO_USD }),
        );
        round.evidence.push({ phase: "setup", ok: true, capMicroUsd: T2_CAP_MICRO_USD, auditDb: "round-owned (under the tmp workspace)" });

        // ── seed the bank the dispatch seam will fan out to (SEAM MIRROR) ──
        const mem = new HindsightClient();
        const existing = extractExistingBankIds(await mem.listBanks());
        const repoBankId = resolveRepoBankId(resolveBankId(REPO_SLUG), existing);
        if (repoBankId === null) throw new Error(`resolveRepoBankId could not resolve a fresh bank id for ${REPO_SLUG} — every candidate exists`);
        expect(existing.has(repoBankId)).toBe(false); // resolver freshness = the delete-safety guard
        round.repoBankId = repoBankId;
        // Armed BEFORE the await (L1's discipline): a createBank that times
        // out AFTER the server-side create still gets deleted by L3's
        // cleanup — pushing after the await orphaned exactly the bank this
        // guard exists for.
        round.banksWeCreated.push(repoBankId);
        await mem.createBank(repoBankId);
        round.primeDocId = `m12-prime-${datedStamp()}`;
        await mem.retain(
          repoBankId,
          `M1.2 primed-dispatch marker (documentId ${round.primeDocId}) for ${REPO_SLUG} issue 46: the memory-cycle live round seeds this observation so the dispatch seam's fan-out recall can prime and cite it.`,
          {
            documentId: round.primeDocId,
            updateMode: "replace",
            kind: "observation",
            source: "agent",
            tags: ["m12-primed-dispatch-probe"],
          },
        );
        round.evidence.push({ phase: "seed-repo-bank", repoBankId, documentId: round.primeDocId, preExistingBankCount: existing.size });

        // ── SPEND PRINT, immediately before the verb that fires ────────────
        const boxHoursUsd = T2_BOX_HOUR_RATE_MICRO_USD / 1_000_000;
        process.stderr.write(
          `[memory-cycle live] FIRING dispatch: 1 box ≤ 1h (≈ $${boxHoursUsd.toFixed(2)}/h) + 1 key capped ${T2_CAP_MICRO_USD} µ$ → worst case ≤ $${(boxHoursUsd + T2_CAP_MICRO_USD / 1_000_000).toFixed(2)}\n`,
        );

        const briefPath = join(round.workspace, "brief.json");
        // requestId: strict UUID v4 so dispatch HONOURS it (resolveBriefRequestId
        // drops anything else) — the side-channel row is keyed on exactly this id.
        round.requestId = randomUUID();
        writeFileSync(
          briefPath,
          JSON.stringify({
            repoSlug: REPO_SLUG,
            issueId: 46,
            requestId: round.requestId,
            commitSha: ctx.sha,
            manifestPath: MANIFEST_PATH,
            repoUrl: ctx.repoUrl,
          }),
        );

        const before = (await ctx.driver.list()).map((b) => b.name);
        round.evidence.push({ phase: "ls-before", boxes: before.filter((n) => n.startsWith("e2e-") || n.startsWith("qds-")) });

        // ── the dispatch verb, as a real subprocess, production path ───────
        const dispatch = await runFleet(
          ["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", round.recordsDir],
          { cwd: REPO_ROOT, env, timeoutMs: 1_200_000 },
        ).catch((e: unknown) => {
          const partial = fleetPartialOutput(e);
          // F4: arm ownership from the raw partial streams BEFORE rethrowing —
          // dispatch reaches the substrate before it can still fail, and these
          // bytes are the only handle on the box on this path.
          // `recoverDispatchIds` is `emittedRunId`'s documented failure-path
          // twin (refusal envelopes + teardown remediation lines name the box).
          const recovered = recoverDispatchIds(partial.stdout, partial.stderr);
          if (round.runId === "" && recovered.runId !== "") round.runId = recovered.runId;
          if (round.vmName === "" && recovered.vmName !== "") round.vmName = recovered.vmName;
          round.evidence.push({
            phase: "dispatch-verb-timeout",
            error: (e as Error).message,
            recoveredRunId: round.runId || null,
            recoveredVmName: round.vmName || null,
            recoveredBytes: partial.stdout.length + partial.stderr.length,
          });
          throw e;
        });
        // Ownership armed BEFORE the assertions that can throw (EB3 rule, F4):
        // dispatch names a box before it can still fail. The ack JSON's own
        // values are set AS FAR AS THEY ARE KNOWN — runId already armed from
        // the raw streams, vmName from the parsed ack — so a failed exit/state
        // assertion still leaves L3's finally the ids to tear the box down
        // with. Existing armed values are never clobbered.
        const ack = lastJsonLine<{ runId?: string; vmName?: string; state?: string }>(dispatch.stdout);
        if (ack.runId !== undefined && ack.runId !== "" && round.runId === "") round.runId = ack.runId;
        if (ack.vmName !== undefined && ack.vmName !== "" && round.vmName === "") round.vmName = ack.vmName;
        const emitted = emittedRunId(dispatch.stdout, dispatch.stderr);
        if (emitted !== undefined && round.runId === "") round.runId = emitted;
        round.evidence.push({ phase: "dispatch-verb", exitCode: dispatch.exitCode, stdoutTail: dispatch.stdout.trim().slice(-400), stderrTail: dispatch.stderr.trim().slice(-600) });
        expect(dispatch.exitCode).toBe(0);
        expect(ack.state).toBe("ready");
        expect(round.runId).toMatch(MINTED_RUN_ID);
        round.evidence.push({ phase: "ack", runId: round.runId, vmName: round.vmName });

        // ── the side-channel row the dispatch subprocess wrote ─────────────
        const rowPath = join(REPO_ROOT, DEFAULT_RECALL_DIR, `${round.requestId}.json`);
        // Recorded for L3's finally (repo-tree hygiene): the dispatch
        // subprocess wrote this row into the repo — the round removes it on
        // the way out instead of leaving it in `git status`.
        round.recallRowPaths.push(rowPath);
        expect(existsSync(rowPath)).toBe(true);
        const row = JSON.parse(readFileSync(rowPath, "utf8")) as RecallRow;
        round.evidence.push({ phase: "side-channel-row", rowPath: rowPath.replace(REPO_ROOT, ""), row });
        expect(row.runId).toBe(round.requestId);
        expect(row.primed).toBe(true);
        expect(row.directive).toBe("kg_context");
        expect(row.banks).toContain(repoBankId);
        expect(row.banks).toContain("qds-collective");
        expect(row.recalledDocumentIds).toContain(round.primeDocId);
        expect(row.chars).toBeGreaterThan(0);

        // ── the box is LIVE + the record carries the money identity ───────
        const live = (await ctx.driver.list()).map((b) => b.name);
        expect(live).toContain(round.vmName);
        const rec = new RunRecordStore({ dir: round.recordsDir }).get(round.runId);
        expect(rec.vmName).toBe(round.vmName);
        expect(rec.commitSha).toBe(ctx.sha);
        expect(rec.keyHash ?? "").not.toBe("");
        expect(rec.limitMicroUsd).toBe(T2_CAP_MICRO_USD);
        round.evidence.push({ phase: "record", ok: true, keyHash: rec.keyHash, limitMicroUsd: rec.limitMicroUsd });

        // ── fleet run: the in-box engine walks (armed resident = real render)
        const started = await runFleet(["run", round.runId, "--driver", "exedev", "--dir", round.recordsDir], { cwd: REPO_ROOT, env, timeoutMs: 180_000 });
        round.evidence.push({ phase: "run-verb", exitCode: started.exitCode, stdout: started.stdout.trim().slice(0, 200), stderrTail: started.stderr.trim().slice(-300) });
        expect(started.exitCode).toBe(0);

        const state = await waitForSettledVerdict({ recordsDir: round.recordsDir, evidence: round.evidence }, round.runId);
        round.evidence.push({ phase: "settled", state });
        // live-mirror: src/fleet/run-completion.ts ChainOutcome "ok" (the settled chain verdict literal)
        expect(state).toBe("ok");
      } catch (e) {
        failure = e;
        round.evidence.push({ phase: "test-error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        // DELIBERATE: no box destroy / no revoke here — L3 harvests the run
        // this leg created, and L3's finally owns the full cleanup verdict.
        // If THIS leg failed, L3 still runs and its finally tears down what
        // `round` names (ids are armed above every assertion that can throw).
        writeM12EvidenceQuietly(
          "m12-l2-primed-dispatch",
          {
            test: "L2-primed-dispatch",
            runId: round.runId,
            vmName: round.vmName,
            requestId: round.requestId,
            repoBankId: round.repoBankId,
            primeDocId: round.primeDocId,
            image: round.ctx === undefined ? null : { ref: round.ctx.driver.image, buildId: round.ctx.driver.imageBuildId },
            phases: round.evidence,
          },
          evidenceProblems,
        );
      }
      // The evidence-write problem fails the leg only when the body passed —
      // a body error is never replaced by a cleanup problem (settleRun's rule).
      if (failure !== undefined) throw failure;
      if (evidenceProblems.length > 0) throw new Error(evidenceProblems.join("; "));
    },
    //   preflight + key list + ls                              ~  260 s
    //   listBanks + createBank + retain (30 s ceilings)        ~   90 s
    //   dispatch verb                          1_200_000       ~ 1200 s
    //   run verb                               180_000         ~  180 s
    //   settle poll  12 × (status 60 s + wait 10 s)            ~  840 s
    //   evidence + local                                       ~   10 s
    //                                                     body ≈ 2580 s
    //   finally (evidence write only)                          ~   10 s
    // Hence 2_580 s → 2_640 s. NO cleanup legs here (L3 owns the verdicts):
    // every failure path arms the round's ids first — the dispatch timeout
    // via recoverDispatchIds on the partial streams, later failures via the
    // ack values set before any assertion that can throw — and L3's finally
    // now ALWAYS runs (F4: its hollow-leg guard throws INSIDE L3's try) and
    // tears down every resource those ids name. Only a bun timeout abort of
    // the runner itself skips even that.
    2_640_000,
  );

  // ── L3: harvest retain + idempotent replay + full cleanup ────────────────
  test.todoIf(liveTodoOff())(
    "L3 harvest retain: outcome document (documentId = runId), EXACTLY ONE receipt row, re-harvest dedups; box/key/probe-bank cleanup",
    async () => {
      liveGate("2");
      const ctx = round.ctx;
      const { recordsDir, runId, vmName, auditDb, repoBankId } = round;
      const env = { QDS_AUDIT_DB: auditDb };
      let failure: unknown;
      const destroyFailures: string[] = [];
      let finalBoxes: string[] | undefined;
      let keyProblems: string[] = [];
      const bankProblems: string[] = [];
      const rowProblems: string[] = [];
      const evidence: Record<string, unknown>[] = round.evidence;
      /** Set once the body's teardown + box-gone proof both held — the
       * finally's destroy backstop must NOT re-destroy a disposed box (a
       * failed double-destroy would fail a green round via destroyFailures). */
      let bodyTeardownOk = false;
      try {
        // F4: FIRST statement INSIDE the try — the hollow-leg refusal throws
        // into the try, so the finally below ALWAYS runs. A partial L2
        // (dispatch provisioned, then timed out) arrives armed with the ids
        // recovered from the dispatch streams, and this finally tears those
        // armed resources down instead of leaking them.
        if (ctx === undefined || round.runId === "" || round.vmName === "" || round.repoBankId === "") {
          throw new Error("L2 did not reach preflight/dispatch — nothing to harvest; refusing to fire a hollow leg");
        }
        const hostRepo = await scratchClone(ctx.repoUrl, ctx.sha, round.workspace);

        // ── the harvest verb (real harvest path; receipt into the round store)
        const harvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, env, timeoutMs: 300_000 });
        evidence.push({ phase: "harvest-verb", exitCode: harvest.exitCode, stdout: harvest.stdout.trim().slice(0, 300), stderrTail: harvest.stderr.trim().slice(-400) });
        expect(harvest.exitCode).toBe(0);
        expect(existsSync(join(recordsDir, `${runId}.bundle`))).toBeTrue();
        const artifactsDir = join(recordsDir, `${runId}-artifacts`);
        expect(existsSync(artifactsDir)).toBeTrue();

        // ── the box run context RENDERED — read off the HARVESTED artifacts,
        // never SSH-parsed off the box. The armed resident's solicit prompts
        // are the rendered run context; the kg_context block must be in them
        // with the marker's documentId and the citation grammar.
        const promptFiles = readdirSync(artifactsDir).filter((f) => f.startsWith(`${runId}-solicit-`) && f.endsWith("-prompt.txt"));
        evidence.push({ phase: "solicit-prompts", promptFiles });
        expect(promptFiles.length).toBeGreaterThan(0);
        let renderedIn: string | undefined;
        let renderedText = "";
        for (const f of promptFiles) {
          const text = readFileSync(join(artifactsDir, f), "utf8");
          if (text.includes("<kg_context>") && text.includes(`documentId="${round.primeDocId}"`) && text.includes("[cite:")) {
            renderedIn = f;
            renderedText = text;
            break;
          }
        }
        evidence.push({ phase: "rendered-kg-context", file: renderedIn ?? null, promptBytes: renderedText.length });
        expect(renderedIn).toBeDefined();

        // ── probe recall: the run bank now holds the outcome document ──────
        const mem = new HindsightClient();
        const probe = await recallPolled(mem, repoBankId, `run outcome ${runId}`, runId, { attempts: 5 });
        const outcomeDoc = probe.res.results.find((r) => r.documentId === runId);
        evidence.push({
          phase: "probe-recall",
          documentIds: probe.res.results.map((r) => r.documentId),
          pollCounts: probe.counts,
          outcomeContentHead: outcomeDoc?.content.slice(0, 200) ?? null,
        });
        expect(outcomeDoc).toBeDefined();
        // The retained payload is the host-authored structured outcome — its
        // runId field must name THIS run (content, not just identity).
        expect(outcomeDoc?.content ?? "").toContain(`"runId":"${runId}"`);

        // ── EXACTLY ONE memory-retain-receipt/retain row, subject = runId ──
        const receiptRows = (): ReturnType<ReturnType<typeof openAuditStoreForWalk>["linksForRun"]> => {
          const handle = openAuditStoreForWalk(auditDb);
          try {
            return handle.linksForRun(runId).filter((l) => l.hop === "memory-retain-receipt" && l.event === "retain");
          } finally {
            handle.close();
          }
        };
        let receipts = receiptRows();
        evidence.push({
          phase: "receipts-after-harvest-1",
          count: receipts.length,
          subjects: receipts.map((l) => l.subjectId ?? null),
          detail: receipts.map((l) => l.detail ?? null),
        });
        expect(receipts.length).toBe(1);
        expect(receipts[0]?.subjectId).toBe(runId);
        const receiptDetail = receipts[0]?.detail as { documentId?: string; bank?: string } | null | undefined;
        expect(receiptDetail?.documentId).toBe(runId);
        expect(receiptDetail?.bank).toBe(repoBankId);

        // ── re-harvest: NO second document, NO second receipt row ──────────
        const reharvest = await runFleet(["harvest", runId, "--driver", "exedev", "--dir", recordsDir], { cwd: hostRepo, env, timeoutMs: 300_000 });
        evidence.push({ phase: "reharvest-verb", exitCode: reharvest.exitCode, stdout: reharvest.stdout.trim().slice(0, 200) });
        expect(reharvest.exitCode).toBe(0);
        const reprobe = await recallPolled(mem, repoBankId, `run outcome ${runId}`, runId, { attempts: 5 });
        const matchesAfterReplay = reprobe.res.results.filter((r) => r.documentId === runId).length;
        receipts = receiptRows();
        evidence.push({ phase: "dedup-after-reharvest", matchesAfterReplay, pollCounts: reprobe.counts, receiptCount: receipts.length });
        expect(matchesAfterReplay).toBe(1);
        expect(receipts.length).toBe(1);

        // ── body teardown (the round is asserted; the verb closes it) ──────
        // --no-harvest is LOAD-BEARING: a teardown harvest here would fire the
        // retain seam a THIRD time after the dedup assertions above.
        const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"], { cwd: hostRepo, env, timeoutMs: 300_000 });
        evidence.push({ phase: "teardown-verb", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-300) });
        expect(td.exitCode).toBe(0);
        const closed = new RunRecordStore({ dir: recordsDir }).get(runId);
        expect(closed.closedAt ?? "").not.toBe("");
        expect(closed.spendMicroUsd ?? 0).toBeGreaterThan(0);
        expect(closed.spendMicroUsd ?? 1).toBeLessThanOrEqual(T2_CAP_MICRO_USD);
        expect(await listedKeyHashes()).not.toContain(closed.keyHash);
        const boxGone = await awaitBoxAbsent(ctx.driver, vmName, evidence);
        expect(boxGone.absent).toBe(true);
        bodyTeardownOk = true;
        evidence.push({ phase: "spend", spendMicroUsd: closed.spendMicroUsd, capMicroUsd: T2_CAP_MICRO_USD });
      } catch (e) {
        failure = e;
        evidence.push({ phase: "test-error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        // Failure-path backstops (never throw over the held body error):
        // teardown verb, box destroy, key revoke — the L2/L3 shared substrate.
        // F4: each step guards on its OWN armed id (and on ctx, which only
        // exists once preflight returned), so a partial L2 cleans exactly the
        // resources that exist and a hollow leg skips every unarmed one.
        if (ctx !== undefined && recordsDir !== "" && runId !== "") {
          const torn = await teardownQuietly(
            ["teardown", runId, "--driver", "exedev", "--dir", recordsDir, "--no-harvest"],
            { env, timeoutMs: 180_000 },
            evidence,
            { at: "finally-teardown", runId },
          );
          if (!torn.ok) destroyFailures.push(`${runId}: ${torn.error}`);
        }
        if (ctx !== undefined && vmName !== "" && !bodyTeardownOk) {
          const destroyed = await destroyQuietly(ctx.driver, vmName, evidence);
          if (!destroyed.ok) destroyFailures.push(`${vmName}: ${destroyed.error}`);
        }
        // Probe-bank cleanup — ONLY banks this round created (resolver-fresh;
        // a pre-existing production bank is never deleted). The loop is its
        // own unarmed guard: no armed bank, no iteration.
        for (const bankId of round.banksWeCreated) {
          try {
            const deleted = await new HindsightClient().deleteBank(bankId);
            evidence.push({ phase: "finally-delete-bank", ...deleted, bankId });
          } catch (e) {
            bankProblems.push(`probe bank ${bankId} delete FAILED: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (ctx !== undefined) {
          finalBoxes = (await fleetLeftovers(ctx.driver, [vmName, runId], evidence)).owned;
          let recordStore: RunRecordStore | undefined;
          try {
            if (recordsDir !== "") recordStore = new RunRecordStore({ dir: recordsDir });
          } catch (e) {
            evidence.push({ phase: "finally-store", ok: false, error: (e as Error).message });
          }
          keyProblems = await keyLeakProblems(round.hashesBefore, { driver: ctx.driver, store: recordStore, runIds: [runId] }, evidence);
        }
        // Side-channel row cleanup (repo-tree hygiene): every row L2 asserted
        // is removed here, best-effort — a failed delete never throws over
        // the held body error, but a row that SURVIVES is a real leak into
        // `git status`, so it is noted AND becomes a problem, like every
        // other stranded artifact.
        for (const rowPath of round.recallRowPaths) {
          let removed = false;
          let removeError = "";
          try {
            rmSync(rowPath, { force: true });
            removed = !existsSync(rowPath);
          } catch (e) {
            removeError = e instanceof Error ? e.message : String(e);
          }
          evidence.push({
            phase: "finally-delete-recall-row",
            ok: removed,
            rowPath: rowPath.replace(REPO_ROOT, ""),
            ...(removeError === "" ? {} : { error: removeError }),
          });
          if (!removed) {
            rowProblems.push(`the dispatch side-channel row was NOT removed from the repo tree: ${rowPath}${removeError === "" ? "" : ` (${removeError})`}`);
          }
        }
        writeM12EvidenceQuietly(
          "m12-l3-harvest-retain",
          {
            test: "L3-harvest-retain",
            runId,
            vmName,
            repoBankId,
            image: ctx === undefined ? null : { ref: ctx.driver.image, buildId: ctx.driver.imageBuildId },
            phases: evidence,
          },
          bankProblems,
        );
        if (round.workspace !== "") rmSync(round.workspace, { recursive: true, force: true });
      }
      settleRun(
        failure,
        // F4: ctx undefined means preflight never returned — no box, key or
        // bank could exist (preflight's only side effects are read-only), so
        // there is no fleet/key verdict to render and none is faked as clean.
        ctx === undefined
          ? [...destroyFailures, ...bankProblems, ...rowProblems]
          : [...fleetCleanupProblems(destroyFailures, finalBoxes, evidence), ...keyProblems, ...bankProblems, ...rowProblems],
      );
    },
    //   scratchClone allowance                                   ~ 180 s
    //   harvest verb                             300_000         ~ 300 s
    //   artifact reads + audit reads                             ~  20 s
    //   probe polls 2 × 5 × (recall 10 s + wait 2 s)             ~ 120 s
    //   re-harvest verb                          300_000         ~ 300 s
    //   teardown verb                            300_000         ~ 300 s
    //   awaitBoxAbsent 5 × (ls 120 s + wait 8 s)                 ~ 640 s
    //   key listings × 2                                         ~ 240 s
    //                                                        body ─────
    //                                                          2 100 s
    //   finally: teardownQuietly 180 + destroy 120 + fleetLeftovers
    //   ~1000 + keyLeakProblems ~480 + banks 2×30 + local 10    ~1850 s
    //                                                                   ────────
    //                                                            3 950 s
    // Hence 3_950 s → 4_020 s. Every inner ceiling FIRING is safe (rejects
    // into the catch; the finally still runs) — this number is what a fully
    // degraded round may consume before the one abort that skips cleanup.
    4_020_000,
  );
});
