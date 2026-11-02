/**
 * Host-pinned gate plan tests (Story DF5.1, AC2 / INV-RV-1).
 *
 * The tree supplies code to run; it never supplies the command that judges it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { ReverifyError } from "../../src/reverify/worktree.ts";
import { divergenceFlags, resolveHostPlan } from "../../src/reverify/plan.ts";
import { makeHarvestedRepo } from "./fixtures/harvested-repo.ts";

function writeHostPlan(dir: string, entry: Record<string, unknown>, slug = "acme/widget"): void {
  fs.mkdirSync(path.join(dir, ".factory", "manifests"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".factory", "manifests", "acme-widget.json"),
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "host-verify",
      runBudgetMs: 1_200_000,
      phases: [
        {
          name: "tests",
          kind: "code",
          description: "host-pinned test run",
          maxDurationMs: 150_000,
          retries: 0,
          command: ["bun", "test", "t/"],
          testCommand: ["bun", "test", "t/"],
        },
        {
          name: "typecheck",
          kind: "code",
          description: "host-pinned typecheck gate",
          maxDurationMs: 150_000,
          retries: 0,
          command: ["true"],
        },
      ],
    }),
  );
  writeEntry(dir, entry, slug);
}

/**
 * The operator's entry ALONE — so a test can re-decide `noTestSuite` without
 * rewriting the manifest it just edited (`writeHostPlan` writes both files).
 */
function writeEntry(dir: string, entry: Record<string, unknown>, slug = "acme/widget"): void {
  fs.writeFileSync(
    path.join(dir, ".factory", "pipeline.json"),
    JSON.stringify({ version: 1, repos: { [slug]: entry } }),
  );
}

describe("resolveHostPlan", () => {
  test("resolves the plan from the operator's entry, never the harvested tree", async () => {
    const repo = await makeHarvestedRepo({ divergentManifest: true });
    try {
      writeHostPlan(repo.dir, { manifest: ".factory/manifests/acme-widget.json" });
      const plan = resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
      // The in-tree manifest replaced the test command with `true`; the host
      // plan is unchanged by that.
      expect(plan.testCommand).toEqual(["bun", "test", "t/"]);
      expect(plan.gateCommands.map((g) => g.argv)).toEqual([["true"]]);
      expect(plan.noTestSuite).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("no entry for the repoSlug is a typed no-host-plan error", async () => {
    const repo = await makeHarvestedRepo();
    try {
      writeHostPlan(repo.dir, { manifest: ".factory/manifests/acme-widget.json" }, "other/repo");
      const err = (() => {
        try {
          resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
          return null;
        } catch (e) {
          return e as ReverifyError;
        }
      })();
      expect(err).toBeInstanceOf(ReverifyError);
      expect(err!.code).toBe("no-host-plan");
    } finally {
      repo.cleanup();
    }
  });

  test("an absent .factory/pipeline.json is no-host-plan, not a crash", async () => {
    const repo = await makeHarvestedRepo();
    try {
      const err = (() => {
        try {
          resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
          return null;
        } catch (e) {
          return e as ReverifyError;
        }
      })();
      expect(err!.code).toBe("no-host-plan");
    } finally {
      repo.cleanup();
    }
  });

  test("a host entry may declare the repository has no test suite", async () => {
    const repo = await makeHarvestedRepo();
    try {
      writeHostPlan(repo.dir, { manifest: ".factory/manifests/acme-widget.json", noTestSuite: true });
      const plan = resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
      expect(plan.noTestSuite).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("noTestSuite with no non-test phase is refused — a green would rest on nothing", async () => {
    const repo = await makeHarvestedRepo();
    try {
      writeHostPlan(repo.dir, { manifest: ".factory/manifests/acme-widget.json", noTestSuite: true });
      // Replace the gate phase with a non-`code` one (the manifest schema
      // requires two phases, and forbids `command` outside kind "code"), so the
      // plan resolves with tests declared absent AND nothing else to judge with.
      const manifestPath = path.join(repo.dir, ".factory", "manifests", "acme-widget.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { phases: Record<string, unknown>[] };
      // `dispatch_task` (DF1.10 C19 removed `agent`) — and a STRONGER fixture
      // than `agent` was: `agent` merely happened to carry no command, while
      // the schema FORBIDS `command` on `dispatch_task`. Converting this to
      // `code` would hand the phase a command, destroy the coverage and still
      // go green. `roster` is deliberately a path that does not exist: nothing
      // on this path walks the phase, so it is never resolved — the schema only
      // requires a non-empty string. Do not "fix" it by creating the file.
      manifest.phases[1] = {
        name: "plan",
        kind: "dispatch_task",
        description: "no host-runnable command",
        roster: "r.yaml",
        task: "hand it to a team",
        maxDurationMs: 150_000,
        retries: 0,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      // THE FIXTURE'S OWN INVARIANT, asserted rather than inherited from the
      // schema. Everything below depends on this manifest resolving to ZERO
      // host-runnable phases; that property currently holds because the schema
      // forbids `command` on `dispatch_task`, and if it ever stopped holding
      // (a relaxed schema, an edited fixture) the refusal below would go green
      // for a reason unrelated to what it claims to prove. Read with
      // `noTestSuite` OFF, because that is the only entry under which this
      // manifest resolves at all.
      writeEntry(repo.dir, { manifest: ".factory/manifests/acme-widget.json" });
      expect(resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha }).gateCommands)
        .toEqual([]);
      writeEntry(repo.dir, { manifest: ".factory/manifests/acme-widget.json", noTestSuite: true });

      const err = (() => {
        try {
          resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
          return null;
        } catch (e) {
          return e as ReverifyError;
        }
      })();
      expect(err).toBeInstanceOf(ReverifyError);
      expect(err!.code).toBe("no-host-plan");
      expect(err!.message).toContain("no non-test phase command");
    } finally {
      repo.cleanup();
    }
  });

  test("two testCommand-bearing phases: the FIRST is the host test run, and the second's testCommand never runs anywhere", async () => {
    // `phases.find` takes the first testCommand phase. The schema REQUIRES a
    // `command` on every code phase (and admits `testCommand` only on code),
    // so a second test phase cannot be command-less: it degrades to an
    // ordinary GATE under its `command`, while its `testCommand` — the argv
    // its own judge would have run — is silently neither the host test run
    // nor a gate. Pinned so a `.find` → `.filter` change or a reordering of
    // the chain cannot drop or duplicate a judge invisibly.
    const repo = await makeHarvestedRepo();
    try {
      writeHostPlan(repo.dir, { manifest: ".factory/manifests/acme-widget.json" });
      const manifestPath = path.join(repo.dir, ".factory", "manifests", "acme-widget.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { phases: Record<string, unknown>[] };
      manifest.phases[1]!.testCommand = ["bun", "test", "never-run/"];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const plan = resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
      // FIRST wins as the host test run…
      expect(plan.testCommand).toEqual(["bun", "test", "t/"]);
      // …the second phase gates under its COMMAND argv…
      expect(plan.gateCommands.map((g) => ({ name: g.name, argv: g.argv }))).toEqual([
        { name: "typecheck", argv: ["true"] },
      ]);
      // …and its testCommand appears nowhere in the resolved plan.
      expect(JSON.stringify(plan)).not.toContain("never-run");
    } finally {
      repo.cleanup();
    }
  });

  test("gate order follows manifest phase order across three code phases", async () => {
    // The `filter/map` chain preserves phase order, and nothing else asserted
    // it: every other fixture carries at most one gate, so a reordering
    // regression there was invisible.
    const repo = await makeHarvestedRepo();
    try {
      writeHostPlan(repo.dir, { manifest: ".factory/manifests/acme-widget.json" });
      const manifestPath = path.join(repo.dir, ".factory", "manifests", "acme-widget.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        phases: Record<string, unknown>[];
        runBudgetMs?: number;
      };
      manifest.phases.push({
        name: "lint",
        kind: "code",
        description: "host-pinned lint gate",
        maxDurationMs: 150_000,
        retries: 0,
        command: ["bun", "x", "lint"],
      });
      // Three phases of 150 ms each demand 1,365,000 ms of phase budget
      // (attempt multipliers plus routing margin — requiredBudgetMs), over
      // the two-phase fixture's 1.2 M ceiling but still under the caller's
      // HOST_PLAN_BUDGET_MS (2.7 M).
      manifest.runBudgetMs = 1_500_000;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const plan = resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
      expect(plan.gateCommands.map((g) => ({ name: g.name, argv: g.argv }))).toEqual([
        { name: "typecheck", argv: ["true"] },
        { name: "lint", argv: ["bun", "x", "lint"] },
      ]);
    } finally {
      repo.cleanup();
    }
  });

  test("a manifest path escaping the operator's .factory root is refused", async () => {
    const repo = await makeHarvestedRepo();
    try {
      writeHostPlan(repo.dir, { manifest: "../../../etc/passwd" });
      const err = (() => {
        try {
          resolveHostPlan({ hostRoot: repo.dir, repoSlug: "acme/widget", baseSha: repo.baseSha });
          return null;
        } catch (e) {
          return e as ReverifyError;
        }
      })();
      expect(err!.code).toBe("no-host-plan");
    } finally {
      repo.cleanup();
    }
  });
});

describe("divergenceFlags", () => {
  test("flags test, dependency and manifest surfaces touched by the harvested diff", async () => {
    const repo = await makeHarvestedRepo();
    try {
      const flags = await divergenceFlags(repo.dir, repo.baseSha, repo.headSha);
      expect(flags).toContain("test-files-modified");
      expect(flags).toContain("manifest-divergence");
      expect(flags).not.toContain("dependency-manifest-modified");
    } finally {
      repo.cleanup();
    }
  });

  test("a run that touched none of those surfaces carries no flags", async () => {
    const repo = await makeHarvestedRepo({ noTests: true });
    try {
      const flags = await divergenceFlags(repo.dir, repo.baseSha, repo.baseSha);
      expect(flags).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});
