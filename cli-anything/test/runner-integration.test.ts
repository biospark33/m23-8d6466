import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTeamSpawn, runTeamManifest, splitRoleModel } from "../src/runner.ts";
import { parseTeamManifestFile } from "../src/manifest.ts";
import type { MergedOutput } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const TEAM_MANIFEST = join(FIXTURES, "research-trio-test.yaml");

/** PATH with the team-mode warren shim prepended. */
function teamEnv(scenario: string): Record<string, string> {
  return {
    PATH: `${join(FIXTURES, "team-bin")}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "/tmp",
    QDS_FAKE_SCENARIO: scenario,
  };
}

const MERGED_KEYS = [
  "result",
  "changedFiles",
  "partial",
  "exitStatus",
  "durationMs",
  "waivers",
  "agentOutputs",
  "comsLog",
  "error",
].sort();

function expectUniformSchema(out: MergedOutput): void {
  expect(Object.keys(out).sort()).toEqual(MERGED_KEYS);
  if (out.exitStatus === "success") {
    expect(out.error).toBeNull();
  } else {
    expect(out.error).not.toBeNull();
    expect(typeof out.error?.message).toBe("string");
  }
}

describe("splitRoleModel", () => {
  it("splits provider at the FIRST slash only", () => {
    expect(splitRoleModel("anthropic/claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(splitRoleModel("openrouter/z-ai/glm-4.7")).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-4.7",
    });
  });

  it("guards missing delimiter (bypassed zod validation)", () => {
    expect(splitRoleModel("claude-sonnet-5")).toEqual({
      provider: "",
      model: "claude-sonnet-5",
    });
  });
});

describe("buildTeamSpawn", () => {
  it("builds the real warren 0.10.0 surface: warren run pi <project> -p <prompt> --provider --model", () => {
    const manifest = parseTeamManifestFile(TEAM_MANIFEST);
    const { file, argv } = buildTeamSpawn(manifest);
    expect(file).toBe("warren");
    expect(argv.slice(0, 3)).toEqual(["run", "pi", "qds-factory"]);
    expect(argv).toContain("-p");
    expect(argv).toContain("--provider");
    expect(argv).toContain("anthropic");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-test-lead");
  });
});

describe("runTeamManifest", () => {
  it("success: merged JSON, partial:false, union changedFiles, ≥2 coms messages (AC1, AC2)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, { env: teamEnv("success") });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("success");
    expect(out.partial).toBe(false);
    expect(out.error).toBeNull();
    // Set-union, deduped, sorted.
    expect(out.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(Object.keys(out.agentOutputs).sort()).toEqual(["worker-a", "worker-b"]);
    expect(out.comsLog.length).toBeGreaterThanOrEqual(2);
    // camelCase at the boundary.
    expect(out.comsLog[0]?.senderAgent).toBeDefined();
    expect(out.result).toEqual({ summary: "lead merged both workers" });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("worker timeout: partial:true, transient, missing worker logged with reason timeout (AC3)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("worker_timeout"),
      // 400 ms, paired with the shim's 1.5 s hold: long enough that worker-a's
      // reply lands inside the budget even under CPU contention, short enough
      // that worker-b's await timer still fires before the child exits.
      comsAwaitTimeoutMs: 400,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("transient");
    expect(out.partial).toBe(true);
    expect(out.error?.reason).toBe("transient");
    const details = out.error?.details as { missingWorkers?: Array<{ agentId: string; reason: string }> };
    expect(details.missingWorkers).toEqual([{ agentId: "worker-b", reason: "timeout" }]);
    // Received worker output is still populated (path 2, populated variant).
    expect(Object.keys(out.agentOutputs)).toEqual(["worker-a"]);
  }, 15_000);

  it("budget overflow: cumulative cost ≥ 90% cap → killTree within grace, exitStatus overflow (AC4, INV-2)", async () => {
    const started = Date.now();
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("budget_overflow"),
      graceMs: 200,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    expect(out.error?.reason).toBe("overflow");
    // Killed promptly (grace 200ms + watchdog), nowhere near the 60s hang.
    expect(Date.now() - started).toBeLessThan(15_000);
    // Cost details: cumulative spend reported, no secret leakage of env.
    const details = out.error?.details as {
      cumulativeCostUsd?: number;
      costUnpriced?: boolean;
    };
    expect(details.cumulativeCostUsd).toBeCloseTo(0.55, 5);
    // DF2.7: legacy cost lines (no turnCount/unpricedTurns) still accumulate
    // and still kill at the same threshold — the widening did not move the
    // budget guard (AC3 + INV-COST-3).
    expect(details.costUnpriced).toBe(false);
    // agentOutputs populated with whatever the lead collected (path 3).
    expect(Object.keys(out.agentOutputs)).toEqual(["worker-a"]);
  }, 20_000);

  it("budget overflow with unpriced turns: cumulative total is marked partial (DF2.7, INV-COST-5)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("budget_overflow_unpriced"),
      graceMs: 200,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    const details = out.error?.details as {
      cumulativeCostUsd?: number;
      costUnpriced?: boolean;
    };
    // Same accumulated spend as the priced run — an unpriced turn is never
    // priced at $0 and never credited against the total; it only marks the
    // record incomplete so nothing bills or spends against a partial figure.
    expect(details.cumulativeCostUsd).toBeCloseTo(0.55, 5);
    expect(details.costUnpriced).toBe(true);
  }, 20_000);

  it("coms init failure: transient with agentOutputs {} and no partial output (AC6)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, { env: teamEnv("coms_init_fail") });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("transient");
    expect(out.error?.reason).toBe("transient");
    expect(out.agentOutputs).toEqual({});
    expect(out.partial).toBe(false);
  }, 15_000);

  it("lead failure: worker partials preserved in artifacts/, agentOutputs {} (path 5)", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "p03-artifacts-"));
    try {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("lead_crash"),
        artifactsDir,
      });
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("lead_failure");
      expect(out.error?.reason).toBe("lead_failure");
      expect(out.agentOutputs).toEqual({});
      expect(out.changedFiles).toEqual([]);
      const files = readdirSync(artifactsDir).sort();
      expect(files).toEqual(["worker-a.json", "worker-b.json"]);
      const workerA = JSON.parse(
        readFileSync(join(artifactsDir, "worker-a.json"), "utf8"),
      ) as { result?: { summary?: string } };
      expect(workerA.result?.summary).toBe("worker-a done");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("lead failure artifacts are secret-redacted (INV-3 parity with stdout)", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "p03-artifacts-redact-"));
    const secret = "sk-artifact-secret-value-987654321";
    try {
      // The shim echoes worker results whose summary is fixed; the secret
      // rides the env — if any worker output ever contained it, the artifact
      // write must redact. Simulate by injecting the secret into the fixture
      // output via QDS_FAKE_SECRET_ECHO (shim appends it to worker summaries).
      await runTeamManifest(TEAM_MANIFEST, {
        env: {
          ...teamEnv("lead_crash"),
          FAKE_API_KEY: secret,
          QDS_FAKE_SECRET_ECHO: secret,
        },
        artifactsDir,
      });
      for (const f of readdirSync(artifactsDir)) {
        const content = readFileSync(join(artifactsDir, f), "utf8");
        expect(content).not.toContain(secret);
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("application non-zero exit with no held worker outputs → logic", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, { env: teamEnv("logic_exit") });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("logic");
    expect(out.error?.reason).toBe("logic");
  }, 15_000);

  it("worker omitting changedFiles = node failure → logic (CORRECTNESS-C)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("bad_worker_output"),
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("logic");
    expect(out.error?.message).toMatch(/changedFiles/);
  }, 15_000);

  it("wall-clock cap expiry → overflow (wall-clock wins over coms_await)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("hang"),
      wallClockCapMs: 300,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    expect(out.error?.reason).toBe("overflow");
  }, 20_000);

  it("F15: per-line cap drops an oversized multibyte line and resumes parsing (merged still lands)", async () => {
    // 1000 × "あ" = 3000 UTF-8 bytes but 1000 UTF-16 units. Under a 2048-byte
    // cap by units, OVER it by bytes — the old decoded.length counter would
    // let it slip past. Spy on the harness's own cap log to prove the
    // byte-accurate cap fired, and assert the trailing `merged` still parsed
    // (proving parsing resumed after the oversized line was discarded).
    const capError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("oversized_multibyte_line"),
        teamStdoutCapBytes: 2048,
      });
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("success");
      expect(out.result).toEqual({ summary: "resumed after oversized line" });
      const capFired = capError.mock.calls.some((c) =>
        String(c[0]).includes("lead stdout line exceeded"),
      );
      expect(capFired).toBe(true);
    } finally {
      capError.mockRestore();
    }
  }, 15_000);

  it("F15: multibyte char split at the cap boundary resets the decoder so resumed parsing is clean", async () => {
    // A 3-byte char straddles the chunk boundary that also breaches the byte
    // cap, leaving a partial char buffered in the StringDecoder when the line
    // is discarded. Without a decoder reset those stale bytes flush as a U+FFFD
    // prefix onto the trailing `merged` line — JSON.parse fails and the run
    // misclassifies. Success + the exact merged result proves the reset landed.
    const capError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("split_multibyte_at_cap"),
        teamStdoutCapBytes: 2048,
      });
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("success");
      expect(out.result).toEqual({ summary: "resumed after split multibyte line" });
      const capFired = capError.mock.calls.some((c) =>
        String(c[0]).includes("lead stdout line exceeded"),
      );
      expect(capFired).toBe(true);
    } finally {
      capError.mockRestore();
    }
  }, 15_000);

  it("CLI: `cli-anything run --manifest <team.yaml>` emits MergedOutput and exit 0 (AC1 wiring)", async () => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "index.ts"), "run", "--manifest", TEAM_MANIFEST],
      { env: teamEnv("success"), stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout) as MergedOutput;
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("success");
    expect(out.partial).toBe(false);
  }, 20_000);

  it("CLI: overflow maps to exit code 3 (INV-2 non-zero on cap breach)", async () => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "index.ts"), "run", "--manifest", TEAM_MANIFEST],
      {
        env: { ...teamEnv("budget_overflow"), QDS_TEAM_GRACE_MS: "200" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(3);
    const out = JSON.parse(stdout) as MergedOutput;
    expect(out.exitStatus).toBe("overflow");
  }, 30_000);

  it("INV-1/INV-3: secret env values never appear in the merged JSON", async () => {
    const secret = "sk-team-secret-value-abcdef123456";
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: { ...teamEnv("success"), FAKE_API_KEY: secret },
    });
    expect(JSON.stringify(out)).not.toContain(secret);
  }, 15_000);
});
