#!/usr/bin/env bun
// Driver-owned branch-gate verifier for M1.3 (unlazy scope m1-3, node-1 N4).
// Runs both story scripts end-to-end against fixture stores in a tmpdir —
// no network, no spend: recall surface is a deterministic injected ProbeClient
// (the CI posture the story's E2E Slice sanctions), stores are real
// CostLedger/audit-store instances seeded in the tmpdir, and every store path
// is passed EXPLICITLY so nothing outside the tmpdir is read or written
// (F-013 hermeticity). Asserts: integrity pass, both artifacts written,
// checkpointEligible false below 30 cycles, read-only posture (absent ledger
// stays absent, audit.db mtime unchanged). The tmpdir is removed on every
// path — pass, fail, or throw. Prints a success-only marker.
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, openAuditStore, sha256Hex } from "../../src/audit/link-store.ts";
import { CostLedger } from "../../src/providers/cost-ledger.ts";
import { runProbeRecall } from "../../scripts/memory/probe-recall.ts";
import { runPrimingReport } from "../../scripts/memory/priming-report.ts";
import type { ProbeClient } from "../../scripts/memory/probe-schema.ts";

// fail() throws so the outer finally still removes the tmpdir — process.exit
// inside try/finally would skip cleanup (F-013). The catch records the message
// and exits AFTER the finally has cleaned up.
function fail(msg: string): never {
  throw new Error(`M13 E2E FAIL: ${msg}`);
}

let dir = "";
let failure = "";
try {
  dir = mkdtempSync(join(tmpdir(), "qds-m13-e2e-"));
  const recalls = join(dir, "recall");
  const reports = join(dir, "reports");
  const evidence = join(dir, "evidence");
  const probes = join(dir, "probes");
  for (const d of [recalls, reports, evidence, probes]) mkdirSync(d, { recursive: true });

  // --- fixture side-channel rows: 5 unique runs (3 primed, 2 unprimed; one dup file) ---
  const row = (runId: string, primed: boolean, latencyMs: number) =>
    `${JSON.stringify({ runId, primed, directive: primed ? "kg_context" : "none", banks: primed ? ["qds-factory-dev-meta"] : [], recalledDocumentIds: primed ? ["mulch-8ff7a752dd1c326b"] : [], chars: primed ? 512 : 0, latencyMs })}\n`;
  writeFileSync(join(recalls, "qds-20260101-aaaaaa.json"), row("0f0e1d2c-0000-4000-8000-000000000001", true, 120));
  writeFileSync(join(recalls, "qds-20260102-bbbbbb.json"), row("0f0e1d2c-0000-4000-8000-000000000002", true, 340));
  writeFileSync(join(recalls, "qds-20260103-cccccc.json"), row("0f0e1d2c-0000-4000-8000-000000000003", false, 90));
  writeFileSync(join(recalls, "qds-20260104-dddddd.json"), row("0f0e1d2c-0000-4000-8000-000000000004", true, 210));
  writeFileSync(join(recalls, "qds-20260105-eeeeee.json"), row("0f0e1d2c-0000-4000-8000-000000000005", false, 80));
  // duplicate runId across two files — dedupe, last-wins
  writeFileSync(join(recalls, "qds-20260106-ffffff.json"), row("0f0e1d2c-0000-4000-8000-000000000001", true, 999));

  // --- fixture audit.db: one receipt for run ...001 ---
  const auditPath = join(dir, "audit.db");
  {
    const store = openAuditStore(auditPath);
    const now = new Date().toISOString();
    store.record({
      runId: "0f0e1d2c-0000-4000-8000-000000000001",
      repoSlug: "QDS-Factory",
      requestId: "req-e2e-1",
      hop: "memory-retain-receipt",
      event: "retain",
      subjectId: "0f0e1d2c-0000-4000-8000-000000000001",
      subjectKind: "document",
      evidenceDigest: sha256Hex(
        canonicalJson({ bank: "qds-factory", documentId: "0f0e1d2c-0000-4000-8000-000000000001", contentDigest: "fixture" }),
      ),
      detail: { bank: "qds-factory", documentId: "0f0e1d2c-0000-4000-8000-000000000001" },
      occurredAt: now,
      recordedAt: now,
    });
    store.close();
  }
  const auditMtimeBefore = statSync(auditPath).mtimeMs;

  // --- fixture cost ledger: exact micros for two runs; absent-file check separate ---
  const ledgerPath = join(dir, "cost-ledger.db");
  {
    const ledger = new CostLedger({
      path: ledgerPath,
      // R2-016: run-record integration is stubbed, not exercised — CostLedger
      // requires a resolvable key record for token rows, so this stub mints
      // the fixture credential; there is no runs/ directory to read.
      readRunRecord: (runId) => ({ createdAt: new Date().toISOString(), keyHash: `e2e-${runId.slice(-4)}`, limitMicroUsd: 10_000_000 }),
    });
    const seeded = [
      { runId: "0f0e1d2c-0000-4000-8000-000000000001", costUsd: 1500 / 1_000_000 },
      { runId: "0f0e1d2c-0000-4000-8000-000000000002", costUsd: 500 / 1_000_000 },
      // R2-001: every observed cycle priced, so the costTable stays emitted —
      // primed 1500+500+100 = 2100 µ$, unprimed 100+100 = 200 µ$.
      { runId: "0f0e1d2c-0000-4000-8000-000000000003", costUsd: 100 / 1_000_000 },
      { runId: "0f0e1d2c-0000-4000-8000-000000000004", costUsd: 100 / 1_000_000 },
      { runId: "0f0e1d2c-0000-4000-8000-000000000005", costUsd: 100 / 1_000_000 },
    ];
    for (const s of seeded) {
      ledger.ingestCostEvent({
        agentId: "agent-e2e",
        model: "model-e2e",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: s.costUsd,
        turnCount: 1,
        durationMs: 0,
        timestamp: new Date().toISOString(),
        unpricedTurns: 0,
      }, {
        runId: s.runId,
        repoSlug: "test/repo",
        issueId: "1",
        requestId: "req-e2e",
        role: "lead",
        invocationSeq: 0,
      });
    }
    ledger.close();
  }
  const absentLedger = join(dir, "cost-ledger-absent.db");
  if (existsSync(absentLedger)) fail("absent ledger pre-exists");

  // --- fixture probe set: 3 probes against fake-served documents ---
  const probeSet = [
    { probeId: "e2e-p1", query: "how does the recall contract key documents", expectedDocumentIds: ["mulch-e2e-doc-1"], bank: "qds-factory-dev-meta" },
    { probeId: "e2e-p2", query: "side channel rows for priming", expectedDocumentIds: ["mulch-e2e-doc-2"], bank: "qds-factory-dev-meta" },
    { probeId: "e2e-p3", query: "unrelated query nothing serves", expectedDocumentIds: ["mulch-e2e-doc-3"], bank: "qds-factory-dev-meta" },
  ];
  const probeSetPath = join(probes, "probe-set.json");
  writeFileSync(probeSetPath, JSON.stringify(probeSet, null, 1));

  // fixture P0.9 mint records: the three probe docs minted into the seed bank
  const p09Dir = join(dir, "p0-9-closure");
  mkdirSync(p09Dir, { recursive: true });
  writeFileSync(
    join(p09Dir, "2026-10-07T00-00-00-000Z-p0-9-provision-and-import-e2e.json"),
    JSON.stringify({
      leg: "p0-9-provision-and-import", mode: "live", ok: true, outcome: "pass",
      writtenAt: "2026-10-07T00:00:00.000Z",
      mintRecord: {
        "qds-factory-dev-meta": { resolvedFrom: "QDS-Factory", documentIds: ["mulch-e2e-doc-1", "mulch-e2e-doc-2", "mulch-e2e-doc-3"] },
      },
    }),
  );

  // --- deterministic ProbeClient: canary + canned recalls (no network) ---
  const calls: { bankId: string; query: string }[] = [];
  const client: ProbeClient = {
    listBanks: async () => ({ banks: [{ bank_id: "qds-factory-dev-meta" }] }),
    retain: async () => ({ bankId: "qds-factory-dev-meta", status: "created" as const, durationMs: 0 }),
    recall: async (bankId: string, query: string, _limit?: number) => {
      calls.push({ bankId, query });
      if (query.includes("qds-canary")) {
        return { results: [{ memoryId: "m1", content: "canary", score: 1, documentId: "qds-canary" }], durationMs: 1 };
      }
      if (query.startsWith("how does the recall contract")) {
        return { results: [{ memoryId: "m2", content: "x", score: 0.9, documentId: "mulch-e2e-doc-1" }], durationMs: 5 };
      }
      if (query.startsWith("side channel rows")) {
        return { results: [{ memoryId: "m3", content: "x", score: 0.9, documentId: null }, { memoryId: "m4", content: "y", score: 0.8, documentId: "mulch-e2e-doc-2" }], durationMs: 7 };
      }
      return { results: [], durationMs: 3 };
    },
  };

  // --- run probe-recall (auditPath passed explicitly — F-013 hermeticity) ---
  const recallRes = await runProbeRecall({
    client,
    probeSetPath,
    evidenceDir: evidence,
    p09EvidenceDir: p09Dir,
    auditPath,
  });
  if (!recallRes.ok) fail(`probe-recall refused: ${recallRes.stage} ${recallRes.reason}`);
  if (!existsSync(recallRes.artifactPath)) fail("hit-rate artifact missing");
  const hitRate = JSON.parse(readFileSync(recallRes.artifactPath, "utf8"));
  if (hitRate.labelIntegrity !== "pass") fail("labelIntegrity not pass");
  if (hitRate.aggregate.probes !== 3 || hitRate.aggregate.hits !== 2) fail(`aggregate math: ${JSON.stringify(hitRate.aggregate)}`);
  // R2-002: the 3-probe fixture is below the 20-probe floor, so hitRateAt5 is
  // WITHHELD (absent, not NaN-compared — the old Math.abs check was vacuous).
  if ("hitRateAt5" in hitRate.aggregate) fail("hitRateAt5 emitted below the 20-probe floor");
  if (hitRate.aggregate.belowFloor !== true) fail("belowFloor not set below the floor");
  // hits === 2 verified through the perProbe rows, not just the aggregate.
  const perProbeHits = hitRate.perProbe.filter((p: { hit: boolean }) => p.hit).length;
  if (perProbeHits !== 2) fail(`perProbe hits ${perProbeHits} != 2`);
  if (!hitRate.canary || hitRate.canary.documentId !== "qds-canary" || hitRate.canary.hit !== true) fail("canary record wrong");
  // Every issued recall query is either the canary self-hit or a probe-set
  // query — no empty/unknown query ever reaches the bank (real canary guard;
  // replaces the vacuous empty-string check).
  if (!calls.some((c) => c.query.includes("qds-canary"))) fail("no canary recall issued");
  const probeQueries = new Set(probeSet.map((p) => p.query));
  for (const c of calls) {
    if (c.query.includes("qds-canary")) continue;
    if (!probeQueries.has(c.query)) fail(`unknown query issued: ${JSON.stringify(c.query)}`);
  }
  const canaryInPerProbe = hitRate.perProbe.some((p: { probeId: string }) => p.probeId.includes("canary"));
  if (canaryInPerProbe) fail("canary scored");

  // --- run priming-report (runsDir dropped, F-025; explicit absent dispatch log — hermetic) ---
  const report = await runPrimingReport({
    recallDir: recalls,
    ledgerPath,
    auditPath,
    dispatchLogPath: join(dir, "dispatch-failures.log"), // absent → key absent
    reportsDir: reports,
    probeSetPath,
    p09EvidenceDir: p09Dir,
  });
  if (report.metrics.cyclesToDate !== 5) fail(`cyclesToDate ${report.metrics.cyclesToDate} != 5 (dup runId not deduped?)`);
  if (report.metrics.primedCount !== 3 || report.metrics.unprimedCount !== 2) fail(`primed/unprimed ${report.metrics.primedCount}/${report.metrics.unprimedCount}`);
  if (report.metrics.checkpointEligible !== false) fail("checkpointEligible must be false below 30 cycles");
  if (!report.metrics.correlationNote.includes("correlation")) fail("correlation note missing");
  if (!existsSync(report.jsonPath) || !existsSync(report.mdPath)) fail("report artifacts missing");
  const metricsJson = JSON.parse(readFileSync(report.jsonPath, "utf8"));
  if (metricsJson.costTable?.primed?.totalMicroUsd !== 2100) fail(`cost join wrong: ${JSON.stringify(metricsJson.costTable)}`);
  if (metricsJson.receiptCoverage?.withReceipt !== 1 || metricsJson.receiptCoverage?.withoutReceipt !== 4) fail("receipt coverage wrong");
  // F-020: per-cycle rows present at 5 cycles, receipt presence per row.
  if (!Array.isArray(metricsJson.cycles) || metricsJson.cycles.length !== 5) fail(`cycles wrong: ${JSON.stringify(metricsJson.cycles)}`);
  if (metricsJson.cycles[0]?.receiptPresent !== true || metricsJson.cycles[1]?.receiptPresent !== false) fail("cycle receipt flags wrong");
  if (metricsJson.outcomeTable?.primed?.runs !== 3 || metricsJson.outcomeTable?.unprimed?.runs !== 2) fail("outcomeTable wrong");

  // --- read-only posture ---
  if (existsSync(absentLedger)) fail("absent ledger was created");
  const auditMtimeAfter = statSync(auditPath).mtimeMs;
  if (auditMtimeAfter !== auditMtimeBefore) fail("audit.db mtime changed");

  console.log("M13 E2E OK");
} catch (e) {
  failure = (e as Error).message;
} finally {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
}
if (failure !== "") {
  console.error(failure);
  process.exit(1);
}
