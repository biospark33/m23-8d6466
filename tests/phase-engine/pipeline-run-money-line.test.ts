/**
 * DF2.12 INV-COST-10: the money line's durability is ASSERTED, not inherited.
 *
 * The cost_attribution line reaches a durable surface only through
 * pipeline-run's fd-2 tee (`writeAll`): a plain `process.stderr.write` bypasses
 * that tee entirely (the tee is caller-level, not an OS-level dup of fd 2), so
 * under the in-box systemd unit — whose fd 2 is journald — the line would
 * never land on `$HOME/<runId>.engine.log` and every harvest would read zero
 * cost rows. The production writer is `moneyLineTee()`, injected by
 * pipeline-run at BOTH emission sites (dispatchTask's `emitMoneyLine` and
 * steering's `emitAttribution`); these tests pin each link of that chain.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const PIPELINE_RUN = path.join(REPO_ROOT, "scripts", "pipeline-run.ts");

describe("pipeline-run money-line tee (DF2.12 INV-COST-10)", () => {
  test("moneyLineTee writes through writeAll: the line lands on the engine log AND stays on stderr", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qds-money-line-"));
    const engineLog = path.join(dir, "engine.log");
    // A subprocess, because writeAll's fd-2 half must be observable: in-process
    // the line would vanish into this runner's own stderr. The tee contract is
    // BOTH surfaces, so the parent asserts each half independently.
    const script = [
      `import { openEngineLog, moneyLineTee } from ${JSON.stringify(PIPELINE_RUN)};`,
      `openEngineLog(${JSON.stringify(engineLog)});`,
      `moneyLineTee()({ type: "cost_attribution", agentId: "worker", role: "worker", costMicroUsd: 12345 });`,
    ].join("\n");
    const proc = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(proc.status, `subprocess failed: ${proc.stderr}`).toBe(0);
    // Half 1 — the durable surface the harvest pulls.
    const logged = fs.readFileSync(engineLog, "utf8");
    expect(logged).toContain('"type":"cost_attribution"');
    expect(logged).toContain('"costMicroUsd":12345');
    // Half 2 — the live stderr stream the engine promises one-JSON-per-line on.
    expect(proc.stderr).toContain('"type":"cost_attribution"');
    // Exactly one line total: the tee duplicates, it does not triplicate.
    const onLog = logged.split("\n").filter((l) => l.includes("cost_attribution")).length;
    const onErr = proc.stderr.split("\n").filter((l) => l.includes("cost_attribution")).length;
    expect(onLog).toBe(1);
    expect(onErr).toBe(1);
  });

  test("production wiring injects moneyLineTee at BOTH emission sites (structural pin)", () => {
    // Positive control first: an unreadable or truncated source must fail this
    // test as UNPROVEN, never as green-by-absence.
    const src = fs.readFileSync(PIPELINE_RUN, "utf8");
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain("function writeAll(");
    // The two production call sites: dispatchTask's dedicated money seam and
    // steering's emitAttribution dep. If either stops injecting the tee writer,
    // that site's cost_attribution lines fall back to raw stderr — journald
    // only under the in-box unit — and every harvest reads zero token rows.
    // This pin fails loud and names the seam; restoring it is a one-line
    // injection at the named call site.
    expect(src).toContain("emitMoneyLine: moneyLineTee()");
    expect(src).toContain("emitAttribution: moneyLineTee()");
  });
});
