/**
 * T1.8 — DF2.11's read-only cost ledger (AC5/AC6), on REAL substrate: real
 * bun:sqlite files on a real filesystem, and a REAL concurrent writer process
 * holding the WAL open while a reader opens through `CostLedger.openReadOnly`.
 *
 * What the unit suite cannot prove, and why each piece is here:
 *
 *  - AC5's "creates nothing" is an OBSERVABLE claim about the filesystem: the
 *    absent-ledger refusal must leave `dirname(path)` uncreated and no `-wal`/
 *    `-shm` sibling behind. A tmpdir-backed unit test proves the same shape,
 *    but this file proves it against the gate that has to survive a hostile
 *    host (permissions, umask, a filesystem whose O_EXCL semantics differ) —
 *    the substrate the operator actually runs on.
 *  - The WAL contentions arms are TIMING claims: a writer subprocess really
 *    holding `-wal` open (WAL mode checkpoints on last-connection close, so a
 *    live handle keeps committed rows un-checkpointed) while `openReadOnly`
 *    reads and sees them (view parity), with the snapshot invariance AC6
 *    demands — ledger file and `-wal` byte-identical in mode/mtime/size after
 *    a whole read session. A fake driver cannot hold a WAL; a real process can.
 *  - `ledger-wal-recovery-required` is proven from a REAL crash: a writer
 *    SIGKILLed with un-checkpointed commit content, its `-shm` gone — the
 *    exact post-crash shape the refusal exists for — and then HEALED by the
 *    remediation's own claim ("any writer checkpoints it as a side effect of
 *    opening") being made true by a real write-path open + close.
 *
 * NOT here, on purpose: `ledger-identity-changed`. Its probe→attach window is
 * microseconds wide; hitting it live needs an injected fs seam, which is a
 * fake — banned in this directory. The arm stays unit-pinned
 * (tests/providers/cost-ledger.test.ts); this file's header is the disposition
 * record for why no live leg exists.
 *
 * NO BOXES, NO KEYS, ZERO MODEL SPEND. TIER-1 by the only authority that
 * counts (`liveGate("1")`): the substrate under test is the host filesystem
 * and real process timing, and nothing here ever contacts a provider or a
 * model. The `sbx-…` key hash the writer stores is LEDGER DATA (a string
 * column INV-COST-5 requires), never a credential — no key exists behind it.
 *
 * The `cost-ledger.open` observability line is captured through a real
 * `setLogSink` (the production sink seam, not a mock: the emissions run for
 * real and are captured verbatim) and asserted per arm — a refusal that
 * logged nothing would be an outcome an operator cannot audit, which is the
 * contract the line exists for.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CostLedger, CostLedgerError } from "../../../src/providers/cost-ledger.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { setLogSink } from "../../../src/lib/log.ts";
import { liveGate, liveTodoOff, REPO_ROOT, setEffectiveImage, tmpWorkspace, writeEvidence } from "./live-harness.ts";

/** The one contract line the read path must emit on every exit. */
type OpenLine = { operation: string; outcome: string; mode: string; status: string; ledgerPath: string };

/**
 * The writer subprocess: a REAL second process that creates the run record the
 * ingest requires (INV-COST-5), opens the ledger through the WRITE path, and
 * ingests one spend-shaped event. argv: `<ledgerPath> <runsDir> <runId>`.
 * Prints `WRITER_READY` once the row is committed; the test SIGKILLs it when
 * done, so the rows stay un-checkpointed in `-wal` for as long as the handle
 * is live.
 */
function writerScript(readyFile: string): string {
  return `
import { writeFileSync } from "node:fs";
import { CostLedger } from ${JSON.stringify(join(REPO_ROOT, "src/providers/cost-ledger.ts"))};
import { RunRecordStore } from ${JSON.stringify(join(REPO_ROOT, "src/providers/run-record.ts"))};

const [, , ledgerPath, runsDir, runId] = process.argv;
const store = new RunRecordStore({ dir: runsDir });
store.create(runId);
// LEDGER DATA, not a credential: INV-COST-5 refuses to persist token spend
// whose run record names no key. No key exists behind this string — it is the
// attribution column every live teardown row also carries.
store.set(runId, { keyHash: "sbx-e2e-writer-no-such-key", limitMicroUsd: 50_000 });
const ledger = new CostLedger({
  path: ledgerPath,
  runsDir,
  readRunRecord: (id) => store.get(id),
});
ledger.ingestCostEvent(
  {
    agentId: "writer-1",
    model: "cheap/model",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    costUsd: 0.012345,
    turnCount: 3,
    unpricedTurns: 0,
    durationMs: 1_500,
    timestamp: new Date().toISOString(),
  },
  { runId, repoSlug: "e2e-private/test", issueId: "1", requestId: \`\${runId}-req\`, role: "lead", invocationSeq: 0 },
);
console.log("WRITER_READY");
// The ready SIGNAL is a file, not stdout: this process never exits by design
// (it holds the WAL open), so a stdout reader would never see EOF to wait on.
writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
// Hold the handle open: WAL mode checkpoints on LAST-connection close, so a
// live process keeps its committed rows sitting in -wal. The test kills this
// process (SIGKILL) when it is done reading.
setInterval(() => {}, 30_000);
`;
}

/** Spawn the writer; resolve once its ready FILE lands (or throw). */
async function spawnWriter(
  scriptPath: string,
  ledgerPath: string,
  runsDir: string,
  runId: string,
  readyFile: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; kill: () => void }> {
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, ledgerPath, runsDir, runId],
    cwd: REPO_ROOT,
    env: { ...process.env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (existsSync(readyFile)) break;
    if (Date.now() >= deadline) {
      proc.kill("SIGKILL");
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`writer ${runId} never became ready within 30s; stderr=${stderr.slice(-500)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { proc, kill: () => proc.kill("SIGKILL") };
}

/** Snapshot AC6 names: the ledger file and its `-wal` sibling, by name. */
function ledgerSnapshot(ledgerPath: string): Record<string, { mode: number; mtimeMs: number; size: number }> {
  const snap: Record<string, { mode: number; mtimeMs: number; size: number }> = {};
  for (const suffix of ["", "-wal"] as const) {
    const p = `${ledgerPath}${suffix}`;
    try {
      const st = statSync(p);
      snap[suffix === "" ? "db" : "wal"] = { mode: st.mode & 0o777, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // An absent sidecar is a real state (a fully-checkpointed ledger has no
      // -wal); recorded as absent so an UNEXPECTED materialisation fails below.
      snap[suffix === "" ? "db" : "wal"] = { mode: -1, mtimeMs: -1, size: -1 };
    }
  }
  return snap;
}

test.todoIf(liveTodoOff())(
  "T1.8 DF2.11 read-only ledger: absent refuses (creates nothing), a real concurrent writer's WAL is readable (view parity, snapshot-identical), writes refuse, and a real crashed WAL is refused then healed by the write path",
  async () => {
    liveGate("1");
    // Boxless by design (D6's shape): no preflight ran, so nothing stamped the
    // boot-image provenance writeEvidence refuses to write without — and
    // inheriting a previous file's stamp would claim this evidence proves
    // bytes no test here ever booted.
    setEffectiveImage(null, { note: "T1.8 never creates a box — the substrate is the host filesystem + real process timing" });
    const evidence: Record<string, unknown>[] = [];
    let workspace = "";
    let outcome = "fail";
    try {
      workspace = tmpWorkspace("t18");

      // ── AC5: the absent-ledger refusal creates NOTHING ────────────────────
      // Two layouts: the parent dir exists, and the whole path is missing —
      // the second is the one where "a reader manufactures an empty ledger"
      // would also have created the directory on its way.
      const existingDir = join(workspace, "existing");
      mkdirSync(existingDir, { recursive: true });
      for (const [label, ledgerPath] of [
        ["dir-exists", join(existingDir, "cost-ledger.db")],
        ["whole-path-absent", join(workspace, "missing", "cost-ledger.db")],
      ] as const) {
        const openLines: OpenLine[] = [];
        const prevSink = setLogSink((entry) => {
          if (entry.operation === "cost-ledger.open") openLines.push(entry as unknown as OpenLine);
        });
        let refused: CostLedgerError | undefined;
        try {
          CostLedger.openReadOnly({ path: ledgerPath });
        } catch (e) {
          if (e instanceof CostLedgerError) refused = e;
          else throw e;
        } finally {
          setLogSink(prevSink);
        }
        evidence.push({
          phase: `absent-${label}`,
          code: refused?.code ?? null,
          line: openLines[0] ?? null,
          pathExists: existsSync(ledgerPath),
          dirExists: existsSync(dirname(ledgerPath)),
          siblings: existsSync(dirname(ledgerPath)) ? readdirSync(dirname(ledgerPath)) : [],
        });
        expect(refused, label).toBeDefined();
        expect(refused?.code, label).toBe("ledger-absent");
        expect(existsSync(ledgerPath), label).toBeFalse();
        // AC5's "dirname was not created" is conditional by its own wording —
        // "if it did not exist". The dir-exists variant asserts the parent was
        // there all along and stays; the whole-path-absent variant is the one
        // that catches a reader manufacturing the directory on its way to
        // manufacturing an empty ledger. (The first live run caught this
        // test's own unconditional form — a test defect, fixed here.)
        expect(existsSync(dirname(ledgerPath)), label).toBe(label === "dir-exists");
        // Either way: no -wal/-shm sibling, and for dir-exists no NEW file of
        // any name beside the ledger path.
        if (label === "dir-exists") {
          expect(readdirSync(dirname(ledgerPath)), label).toEqual([]);
        }
        // The observability contract: the refusal logged its line, outcome ==
        // the error's code, status error (round-3 C12's convention).
        expect(openLines.length, label).toBe(1);
        expect(openLines[0]?.outcome, label).toBe("ledger-absent");
        expect(openLines[0]?.mode, label).toBe("read-only");
        expect(openLines[0]?.status, label).toBe("error");
      }

      // ── AC6: a REAL concurrent writer's WAL, read through openReadOnly ───
      const runsDir = join(workspace, "runs");
      mkdirSync(runsDir, { recursive: true });
      const ledgerPath = join(runsDir, "cost-ledger.db");
      const runId = "t18b-writer";
      const scriptPath = join(workspace, "writer.ts");
      const readyFile = join(workspace, `${runId}.ready`);
      writeFileSync(scriptPath, writerScript(readyFile));
      const writer = await spawnWriter(scriptPath, ledgerPath, runsDir, runId, readyFile);
      evidence.push({ phase: "writer-ready", ok: true, runId });
      // The writer genuinely holds the WAL: its committed row is sitting in
      // an un-checkpointed -wal while it lives.
      expect(existsSync(`${ledgerPath}-wal`), "writer's -wal must exist while it holds the handle").toBeTrue();
      const walLive = statSync(`${ledgerPath}-wal`);
      expect(walLive.size, "the writer's committed row is un-checkpointed -wal content").toBeGreaterThan(0);

      const snapshotBefore = ledgerSnapshot(ledgerPath);
      const dirBefore = readdirSync(runsDir).sort();

      // The READ session. openReadOnly must succeed beside the live writer,
      // see the writer's committed row (view parity with the write path's own
      // view), and leave the ledger byte-identical in mode/mtime/size.
      const readonlyHandle = CostLedger.openReadOnly({ path: ledgerPath });
      let readonlyView: unknown;
      try {
        readonlyView = readonlyHandle.readRunCost(runId);
        const issueView = readonlyHandle.readIssueCost("e2e-private/test", "1");
        const runsView = readonlyHandle.readIssueRuns("e2e-private/test", "1");
        // readIssueRuns answers a plain array (one row per run with activity).
        const runsRowCount = runsView.length;
        // Parity: a write-path view over the SAME data, opened beside the
        // writer (a second real connection, not a cache of the first).
        const writePathView = new CostLedger({
          path: ledgerPath,
          runsDir,
          readRunRecord: (id) => new RunRecordStore({ dir: runsDir }).get(id),
        });
        const writeSight = writePathView.readRunCost(runId);
        writePathView.close();
        evidence.push({
          phase: "view-parity",
          readonly: readonlyView,
          writePath: writeSight,
          issueView: issueView.totalMicroUsd,
          runsSeen: runsRowCount,
        });
        expect(readonlyView).toEqual(writeSight);
        expect(issueView.totalMicroUsd).toBeGreaterThan(0);
        expect(runsRowCount).toBeGreaterThan(0);

        // AC6's write half: every write method refuses ledger-readonly BEFORE
        // touching the database, and the row count is unchanged.
        const rowsBefore = readonlyHandle.readIssueRuns("e2e-private/test", "1").length;
        for (const attempt of [
          () =>
            readonlyHandle.ingestCostEvent(
              {
                agentId: "x",
                model: "cheap/model",
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0.001,
                turnCount: 1,
                unpricedTurns: 0,
                durationMs: 1,
                timestamp: new Date().toISOString(),
              },
              { runId, repoSlug: "e2e-private/test", issueId: "1", requestId: "ro-1", role: "lead", invocationSeq: 9 },
            ),
          () =>
            readonlyHandle.ingestBoxHours({
              runId,
              repoSlug: "e2e-private/test",
              issueId: "1",
              requestId: "ro-2",
            }),
          () =>
            readonlyHandle.admitIssue(
              { repoSlug: "e2e-private/test", issueId: "1", runId, requestId: "ro-3" },
              1_000,
              1_000,
            ),
        ]) {
          let refusedWrite: CostLedgerError | undefined;
          try {
            (attempt as () => unknown)();
          } catch (e) {
            if (e instanceof CostLedgerError) refusedWrite = e;
            else throw e;
          }
          expect(refusedWrite?.code, "write on a read-only handle").toBe("ledger-readonly");
        }
        expect(readonlyHandle.readIssueRuns("e2e-private/test", "1").length).toBe(rowsBefore);

        // The contention half: repeated readonly opens BESIDE the live writer
        // — busy_timeout must absorb the real concurrency, never surface a
        // ledger-unqueryable flake.
        for (let i = 0; i < 20; i++) {
          const h = CostLedger.openReadOnly({ path: ledgerPath });
          h.readRunCost(runId);
          h.close();
        }
        evidence.push({ phase: "repeated-opens", ok: true, count: 20 });
      } finally {
        readonlyHandle.close();
      }

      // AC6's snapshot: ledger file and -wal, mode/mtime/size IDENTICAL after
      // the whole session. (-shm is deliberately excluded: a readonly
      // connection may map the WAL index, it carries no rows, and asserting on
      // it would only make the snapshot flaky — the story's own wording.)
      const snapshotAfter = ledgerSnapshot(ledgerPath);
      const dirAfter = readdirSync(runsDir).sort();
      evidence.push({ phase: "snapshot", before: snapshotBefore, after: snapshotAfter, dirSame: dirBefore.join() === dirAfter.join() });
      expect(snapshotAfter).toEqual(snapshotBefore);
      // The read path created no new file of ANY name.
      expect(dirAfter.join()).toBe(dirBefore.join());

      // The writer dies the way real writers crash: SIGKILL, un-checkpointed.
      writer.kill();
      await writer.proc.exited;

      // ── AC6/Tech-Notes: the REAL crashed-WAL refusal, then the heal ───────
      // After SIGKILL the -wal holds commit content with no live holder. The
      // recovery-required shape is a non-empty -wal with NO -shm; the crash
      // leaves the -shm behind, and removing it is the fixture shaping that
      // exact post-crash state (a filesystem that lost the index file) — a
      // real file operation on real crash artifacts, not a fabricated one.
      expect(existsSync(`${ledgerPath}-wal`)).toBeTrue();
      expect(statSync(`${ledgerPath}-wal`).size).toBeGreaterThan(0);
      rmSync(`${ledgerPath}-shm`, { force: true });
      expect(existsSync(`${ledgerPath}-shm`)).toBeFalse();

      const refusalLines: OpenLine[] = [];
      const prevSink2 = setLogSink((entry) => {
        if (entry.operation === "cost-ledger.open") refusalLines.push(entry as unknown as OpenLine);
      });
      let walRefused: CostLedgerError | undefined;
      try {
        CostLedger.openReadOnly({ path: ledgerPath });
      } catch (e) {
        if (e instanceof CostLedgerError) walRefused = e;
        else throw e;
      } finally {
        setLogSink(prevSink2);
      }
      evidence.push({ phase: "wal-refusal", code: walRefused?.code ?? null, line: refusalLines[0] ?? null });
      expect(walRefused?.code).toBe("ledger-wal-recovery-required");
      expect(refusalLines.length).toBe(1);
      expect(refusalLines[0]?.outcome).toBe("ledger-wal-recovery-required");

      // The remediation's claim, made TRUE on the real file: "any writer
      // checkpoints it as a side effect of opening". The healer is a FRESH
      // PROCESS — on purpose, twice over. Production's healing writer is
      // always another process (a teardown, `qds cost`), and measured live
      // (this round's own triage): after THIS process has attached readonly
      // beside a writer that is then SIGKILLed with its `-shm` deleted, bun's
      // sqlite VFS fails a same-process write open of the same file with
      // SQLITE_IOERR_VNODE — while a fresh process opens, recovers and reads
      // the same bytes without complaint. The poison is process-local; the
      // product's claim is not. (See the story's round-6 record.)
      const healerScript = join(workspace, "healer.ts");
      writeFileSync(
        healerScript,
        `\
import { existsSync, writeFileSync } from "node:fs";
import { CostLedger, CostLedgerError } from ${JSON.stringify(join(REPO_ROOT, "src/providers/cost-ledger.ts"))};
import { RunRecordStore } from ${JSON.stringify(join(REPO_ROOT, "src/providers/run-record.ts"))};
const [, , ledgerPath, runsDir, runId, healedFile] = process.argv;
try {
  const healer = new CostLedger({ path: ledgerPath, runsDir, readRunRecord: (id) => new RunRecordStore({ dir: runsDir }).get(id) });
  healer.close();
  const view = CostLedger.openReadOnly({ path: ledgerPath });
  const seen = view.readRunCost(runId);
  view.close();
  writeFileSync(healedFile, JSON.stringify({ ok: true, shmRebuilt: existsSync(\`\${ledgerPath}-shm\`), view: seen }));
} catch (e) {
  writeFileSync(healedFile, JSON.stringify({ ok: false, code: (e as CostLedgerError).code ?? "error", message: (e as Error).message }));
}
`,
      );
      const healedFile = join(workspace, "healed.json");
      const healer = Bun.spawn({
        cmd: ["bun", healerScript, ledgerPath, runsDir, runId, healedFile],
        cwd: REPO_ROOT,
        env: { ...process.env } as Record<string, string>,
        stdout: "ignore",
        stderr: "pipe",
      });
      const healerExit = await healer.exited;
      const healerErr = await new Response(healer.stderr).text();
      expect(healerExit, `healer subprocess stderr: ${healerErr.slice(-400)}`).toBe(0);
      expect(existsSync(healedFile), "the healer must write its verdict").toBeTrue();
      const healed = JSON.parse(readFileSync(healedFile, "utf8")) as { ok: boolean; shmRebuilt?: boolean; view?: unknown; code?: string };
      evidence.push({ phase: "healed", healed });
      expect(healed.ok, `healer verdict: ${JSON.stringify(healed)}`).toBeTrue();
      expect(healed.shmRebuilt).toBeTrue(); // recovery rebuilt the index
      expect(JSON.stringify(healed.view)).toContain("12345"); // 12,345 µ$ — the writer's row survived its own crash

      outcome = "pass";
    } finally {
      try {
        writeEvidence("t1-8-ledger-readonly", { test: "T1.8", outcome, phases: evidence });
      } catch (e) {
        process.stderr.write(`[T1.8] evidence write failed: ${(e as Error).message}\n`);
      }
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }
  },
  120_000,
);
