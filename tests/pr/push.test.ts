/**
 * `pushVerifiedSha` — DF6.1's entry point, on DF5.2's gate (Story DF5.2).
 *
 * Real git against a real bare remote, so "non-force" and "fast-forward only"
 * are assertions about git's actual behaviour rather than about a mock's.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { PUBLISH_REF_PREFIX, assertPublishableRef, defaultTargetRef, pushVerifiedSha, refusalPath } from "../../src/pr/push.ts";
import { parseRemote, resolveRepoEntry } from "../../src/pr/repos.ts";
import { sealReport, type ReverifyEvidence, type ReverifyReport } from "../../src/reverify/report.ts";
import { exec } from "../../src/reverify/worktree.ts";
import {
  AUTHOR_LOGIN,
  REPO_SLUG,
  TOKEN,
  approve,
  defaultAllowlist,
  fakeGitHub,
  makeHost,
  makeRecord,
  remoteRefs,
  writeReport,
  type Host,
} from "./helpers.ts";

const token = async () => TOKEN;

// Every test in this file drives REAL git children (makeHost builds a repo and
// a bare remote; pushVerifiedSha runs ls-remote/push/merge-base), so bun's 5s
// default per-test budget is a load-bearing assumption only on an idle machine.
// 20s matches the explicit budget the git-heaviest tests here already declare.
setDefaultTimeout(20_000);

function deps(host: Host, over: Record<string, unknown> = {}) {
  return {
    hostRoot: host.root,
    store: host.store,
    reverifyDir: host.reverifyDir,
    prDir: host.prDir,
    runsDir: host.runsDir,
    exec: host.exec,
    github: fakeGitHub(),
    token,
    log: () => {},
    ...over,
  };
}

/** A second commit on top of `headSha`, and the sha it lands at. */
async function appendCommit(host: Host, onto: string): Promise<string> {
  await exec(["git", "checkout", "-q", "--detach", onto], { cwd: host.root });
  writeFileSync(join(host.root, "fix.ts"), "export const y = 2;\n");
  await exec(["git", "add", "fix.ts"], { cwd: host.root });
  await exec(["git", "commit", "-q", "-m", "the fix run's work"], { cwd: host.root });
  const sha = (await exec(["git", "rev-parse", "HEAD"], { cwd: host.root })).stdout.trim();
  await exec(["git", "checkout", "-q", "main"], { cwd: host.root });
  return sha;
}

/** A sealed green report at `host.headSha` under a caller-chosen reverifyId.
 *  `opts.headSha` re-points the verdict at another sha (the bound-selection
 *  head checks need reports at more than one sha); `opts.red` writes a red. */
function writeReportWithId(
  host: Host,
  runId: string,
  reverifyId: string,
  completedAt: string,
  opts: { headSha?: string; red?: boolean } = {},
): ReverifyReport {
  mkdirSync(host.reverifyDir, { recursive: true });
  const evidence: ReverifyEvidence = {
    reverifyId,
    runId,
    requestId: "req-df52",
    headSha: opts.headSha ?? host.headSha,
    baseSha: host.baseSha,
    startedAt: "2026-08-25T09:59:00.000Z",
    completedAt,
    durationMs: 60_000,
    checks: [
      { item: "install", ok: true, note: "exit 0" },
      { item: "tests: bun test", ok: !opts.red, note: opts.red ? "exit 1, 6 pass, 1 fail" : "exit 0, 7 pass, 0 fail" },
    ],
    testResults: opts.red ? { passed: 6, failed: 1 } : { passed: 7, failed: 0 },
    flags: ["test-files-modified"],
    discrepancies: [],
    claimed: null,
    toolchain: { git: "2.44.0", bun: "1.2.0" },
    timings: { worktree_ms: 1, install_ms: 1, tests_ms: 1, gates_ms: 1, cleanup_ms: 1 },
  };
  const report = sealReport(evidence, {});
  appendFileSync(join(host.reverifyDir, `${runId}.jsonl`), `${JSON.stringify(report)}\n`);
  return report;
}

describe("INV-PR-5 — there is no push path that skips the gate", () => {
  test("AC7 (DF5.3): a decision AT the report's completion instant is a violation — decided <= completed refuses", async () => {
    // The tightening is the story's: the old `decided < completed` boundary
    // admitted a millisecond-equal pair and opened the PR, while the audit
    // chain's strict comparison (same host clocks) called it order-violation.
    // Admission and chain must agree — equality is now a refusal here too.
    const runId = "run-push-equal";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    const completedAt = "2026-08-25T10:10:00.000Z";
    approve(host, runId, writeReportWithId(host, runId, "rv-approval-bound", completedAt), {
      decidedAt: completedAt,
    });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("approval-precedes-report");
  }, 20_000);

  test("AC7 (DF5.3): strictly-after still passes the tightened boundary", async () => {
    const runId = "run-push-strictly-after";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    const completedAt = "2026-08-25T10:10:00.000Z";
    approve(host, runId, writeReportWithId(host, runId, "rv-approval-bound", completedAt), {
      decidedAt: new Date(Date.parse(completedAt) + 1).toISOString(), // +1ms: strictly after
    });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(true);
  }, 20_000);

  test("a red report refuses the push, with the refusal recorded durably", async () => {
    const runId = "run-push-red";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId, { red: true }));

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("reverify-red");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
    expect(readFileSync(refusalPath(host.prDir, runId), "utf8")).toContain("reverify-red");
  }, 20_000);

  test("an unreadable LAST report line refuses — never a fall back to the earlier green", async () => {
    // "The LAST record is authoritative" inverts when the last line is the one
    // that was dropped: `at(-1)` returns the EARLIER report, and an earlier
    // green would authorize a push the current verdict never did.
    const runId = "run-push-tornreport";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    // A later re-verify whose append was killed mid-line.
    appendFileSync(join(host.reverifyDir, `${runId}.jsonl`), '{"verdict":"gre\n');

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("reverify-unreadable");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
    expect(readFileSync(refusalPath(host.prDir, runId), "utf8")).toContain("reverify-unreadable");
  }, 20_000);

  test("the approval-gate resume strand pushes: the BOUND report outranks the newer appended one", async () => {
    // AC1(c) resume: `pausing` crashed mid-gate; the operator's retry appended a
    // FRESH green report (runner.ts appends BEFORE requesting approval) and
    // re-presented the bound reportId, which the gate's resume arm promoted
    // while deliberately preserving it (tests/reverify/runner.test.ts pins the
    // preserved id). The record ends `approved` bound to rv-stranded while the
    // retry's newer report sits LAST — recency selection here would refuse
    // `approval-report-mismatch` on every successful resume, permanently.
    const runId = "run-push-resume";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    writeReportWithId(host, runId, "rv-stranded", "2026-08-25T10:00:00.000Z");
    writeReportWithId(host, runId, "rv-retry", "2026-08-25T10:05:00.000Z");
    approve(host, runId, writeReportWithId(host, runId, "rv-approval-bound", "2026-08-25T10:10:00.000Z"), {
      reportId: "rv-stranded",
    });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(true);
    expect((await remoteRefs(host))[`refs/heads/qds/${runId}`]).toBe(host.headSha);
  }, 20_000);

  test("S5: the resume strand still pushes when the NEWER report sits at a DIFFERENT sha", async () => {
    // The twin of the resume test above, with the heads UNLIKE each other. All
    // three reports at `host.headSha` let "the bound report wins" and "any
    // report wins" pass identically, because every candidate satisfies the
    // `report.headSha === headSha` check. With the retry's report at another
    // real sha, recency selection refuses (`reverify-sha-mismatch`) and only
    // the bound-report rule delivers — this is the shape that makes the
    // selection rule load-bearing.
    const runId = "run-push-resume-sha";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    // The stranded report is green at the sha the push will publish…
    writeReportWithId(host, runId, "rv-stranded", "2026-08-25T10:00:00.000Z");
    // …and the retry's newer appended report re-verified a DIFFERENT sha.
    writeReportWithId(host, runId, "rv-retry", "2026-08-25T10:05:00.000Z", { headSha: host.baseSha });
    approve(host, runId, writeReportWithId(host, runId, "rv-approval-bound", "2026-08-25T10:10:00.000Z"), {
      reportId: "rv-stranded",
    });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(true);
    expect((await remoteRefs(host))[`refs/heads/qds/${runId}`]).toBe(host.headSha);
  }, 20_000);

  test("S5: a bound report at a sha the ref no longer resolves to is STILL refused", async () => {
    // Selecting by bound id is a selection rule, not an authorization: the
    // selected report's own headSha check still fires before the approval is
    // consulted. A stranded green at an earlier sha never publishes the later
    // re-harvest, bound id or not.
    const runId = "run-push-boundstalesha";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    // The bound report is green at the BASE sha, not the one `ref` resolves to.
    writeReportWithId(host, runId, "rv-stranded", "2026-08-25T10:00:00.000Z", { headSha: host.baseSha });
    approve(host, runId, writeReportWithId(host, runId, "rv-approval-bound", "2026-08-25T10:10:00.000Z", { headSha: host.baseSha }), {
      reportId: "rv-stranded",
    });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("reverify-sha-mismatch");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  });

  test("S5: an approval whose headSha is not the published sha refuses, bound report aside", async () => {
    // The SECOND head check (`approval.headSha`) is independent of the report's:
    // the approval must be of THIS push, not merely of the report that won the
    // selection.
    const runId = "run-push-boundapprsha";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    const green = writeReportWithId(host, runId, "rv-stranded", "2026-08-25T10:00:00.000Z");
    approve(host, runId, green, { reportId: "rv-stranded", headSha: host.baseSha });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("approval-sha-mismatch");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  });

  test("S6: a DUPLICATED bound reportId binds to the LATEST duplicate — the re-verify under the same id re-authorizes", async () => {
    // A duplicated id means the run re-verified under the SAME id, so the
    // earliest match is the stale one — the twin of the "last record is
    // authoritative" default this selection exists for. `find` returned the
    // first (the red it replaced) and refused; latest-wins delivers the green
    // that superseded it. A stale report still could not authorize a push (the
    // headSha check), so latest-wins only ever turns a refusal into a delivery.
    const runId = "run-push-dupid";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    // First verify under this id: red.
    writeReportWithId(host, runId, "rv-dup", "2026-08-25T10:00:00.000Z", { red: true });
    // Re-verify under the SAME id: green.
    const green = writeReportWithId(host, runId, "rv-dup", "2026-08-25T10:05:00.000Z");
    approve(host, runId, green, { reportId: "rv-dup" });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(true);
    expect((await remoteRefs(host))[`refs/heads/qds/${runId}`]).toBe(host.headSha);
  }, 20_000);

  test("a bound reportId that names NO parsed report still refuses — fail-safe, not an authorization", async () => {
    // A bound id matching nothing may name the UNREADABLE tail, so falling back
    // to `at(-1)` is a refusal bound: the mismatch check still fires.
    const runId = "run-push-boundunknown";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    writeReportWithId(host, runId, "rv-real", "2026-08-25T10:00:00.000Z");
    approve(host, runId, writeReportWithId(host, runId, "rv-also-real", "2026-08-25T10:10:00.000Z"), {
      reportId: "rv-phantom",
    });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("approval-report-mismatch");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  }, 20_000);

  test("an unreadable LAST line refuses even when the bound reportId matches an earlier parsed report", async () => {
    // Selection never authorizes past a dropped tail: lastLineInvalid fires
    // before any approval check, bound id or not.
    const runId = "run-push-boundtorn";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    writeReportWithId(host, runId, "rv-stranded", "2026-08-25T10:00:00.000Z");
    approve(host, runId, writeReportWithId(host, runId, "rv-approval-bound", "2026-08-25T10:10:00.000Z"), {
      reportId: "rv-stranded",
    });
    // The torn line is appended LAST — the tail is what makes the latest
    // verdict unreadable.
    appendFileSync(join(host.reverifyDir, `${runId}.jsonl`), '{"verdict":"gre\n');

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("reverify-unreadable");
  }, 20_000);

  test("a fix run's append needs its OWN approval, exactly as a first PR does", async () => {
    const runId = "run-push-noappr";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId, { approval: null });
    writeReport(host, runId);

    const out = await pushVerifiedSha(runId, { ...deps(host), targetRef: "refs/heads/qds/existing-pr" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("approval-missing");
    expect(await remoteRefs(host)).not.toHaveProperty("refs/heads/qds/existing-pr");
  }, 20_000);
});

describe("INV-PR-6 — append-only publication", () => {
  test("the default ref pushes the verified sha and is idempotent on a re-push", async () => {
    const runId = "run-push-ok";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    const first = await pushVerifiedSha(runId, deps(host));
    expect(first).toMatchObject({ ok: true, sha: host.headSha, targetRef: defaultTargetRef(runId), pushed: true });
    expect((await remoteRefs(host))[`refs/heads/qds/${runId}`]).toBe(host.headSha);

    // Already there at this sha: a resume, not a second push.
    const second = await pushVerifiedSha(runId, deps(host));
    expect(second).toMatchObject({ ok: true, pushed: false });
    // Real git remote round-trips (or script spawns) can outrun bun's 5s
    // default under parallel-suite load — same load-flake family the fleet
    // race tests document; deterministic solo.
  }, 20_000);

  test("a non-default targetRef whose sha is NOT a descendant of the remote tip is refused", async () => {
    const runId = "run-push-rewrite";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    // The PR branch carries a commit this run's head does not contain: pushing
    // the run's head there would REWRITE published history.
    const sibling = await appendCommit(host, host.baseSha);
    await exec(["git", "push", host.remoteDir, `${sibling}:refs/heads/qds/pr-branch`], { cwd: host.root });

    const out = await pushVerifiedSha(runId, { ...deps(host), targetRef: "refs/heads/qds/pr-branch" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("not-fast-forward");
    expect((await remoteRefs(host))["refs/heads/qds/pr-branch"]).toBe(sibling);
    // Real git remote round-trips (or script spawns) can outrun bun's 5s
    // default under parallel-suite load — same load-flake family the fleet
    // race tests document; deterministic solo.
  }, 20_000);

  test("a descendant sha appends to the same non-default targetRef", async () => {
    const runId = "run-push-append";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    // The PR branch is at the run's ORIGINAL head; the fix run's sha descends
    // from it, so this is an append and nothing is rewritten.
    await exec(["git", "push", host.remoteDir, `${host.headSha}:refs/heads/qds/pr-branch`], { cwd: host.root });
    const fixSha = await appendCommit(host, host.headSha);
    await exec(["git", "update-ref", `refs/sandbox/${runId}`, fixSha], { cwd: host.root });
    approve(host, runId, writeReport(host, runId, { headSha: fixSha }));

    const out = await pushVerifiedSha(runId, { ...deps(host), targetRef: "refs/heads/qds/pr-branch" });
    expect(out).toMatchObject({ ok: true, sha: fixSha, pushed: true });
    expect((await remoteRefs(host))["refs/heads/qds/pr-branch"]).toBe(fixSha);
    // Real git remote round-trips (or script spawns) can outrun bun's 5s
    // default under parallel-suite load — same load-flake family the fleet
    // race tests document; deterministic solo.
  }, 20_000);

  test("the SHA is pushed, not the ref name — a ref that moved after preflight publishes nothing new", async () => {
    const runId = "run-push-sha";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    // Move the quarantine ref between the report and the push. The verified sha
    // is what the report names, so the moved ref must refuse rather than
    // publish an unverified commit.
    const moved = await appendCommit(host, host.headSha);
    await exec(["git", "update-ref", `refs/sandbox/${runId}`, moved], { cwd: host.root });

    const out = await pushVerifiedSha(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("reverify-sha-mismatch");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  });
});

describe("INV-PR-2 — the token is never argv and never on disk", () => {
  test("no git invocation carries the token as an argument", async () => {
    const runId = "run-push-argv";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const seen: string[][] = [];

    const out = await pushVerifiedSha(runId, {
      ...deps(host),
      exec: async (argv, opts) => {
        seen.push([...argv]);
        return host.exec(argv, opts);
      },
    });
    expect(out.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    // argv is what `ps` shows. The token rides in the child's environment.
    for (const argv of seen) expect(argv.join(" ")).not.toContain(TOKEN);
  });

  test("the refusal record carries no token", async () => {
    const runId = "run-push-refusaltoken";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId, { red: true }));

    await pushVerifiedSha(runId, deps(host));
    expect(readFileSync(refusalPath(host.prDir, runId), "utf8")).not.toContain(TOKEN);
  });
});

describe("AC3 — the refusal record is host-side, append-only and 0600", () => {
  test("each refused attempt appends one line", async () => {
    const runId = "run-push-append2";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId, { red: true }));

    await pushVerifiedSha(runId, deps(host));
    await pushVerifiedSha(runId, deps(host));

    const path = refusalPath(host.prDir, runId);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const rec = JSON.parse(line) as Record<string, unknown>;
      expect(rec).toHaveProperty("runId", runId);
      expect(rec).toHaveProperty("attemptedAt");
      expect(rec).toHaveProperty("failedPrecondition");
      expect(rec).toHaveProperty("failingChecks");
      expect(rec).toHaveProperty("reportPath");
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("INV-PR-1 — credential containment", () => {
  test("nothing under src/pr/ reaches a provider driver", () => {
    // The push credential is host-only. A `ProviderDriver` is the thing that
    // talks to a box, so an import edge from this module to one is exactly the
    // shape of the source story's in-box push (DD-10) — which MUST fail here.
    const dir = "src/pr";
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(dir, name), "utf8");
      const imports = [...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec).not.toContain("providers/driver");
        expect(spec).not.toContain("providers/fly");
        expect(spec).not.toContain("providers/local");
        expect(spec).not.toContain("swarmclaw");
      }
    }
  });
});

describe("the allowlist itself (INV-PR-3)", () => {
  test("a checked-in fixture resolves to its remote, base branch and required author", () => {
    // The fixture is committed at 0644 (git cannot carry 0600), so the mode
    // gate is exercised in the host tests where the file is written by the
    // suite; here the SHAPE is what is under test.
    const parsed = JSON.parse(readFileSync("tests/pr/fixtures/repos.json", "utf8")) as {
      repos: Record<string, { remote: string; baseBranch: string; authorLogin: string }>;
    };
    const entry = parsed.repos[REPO_SLUG]!;
    expect(entry.authorLogin).toBe(AUTHOR_LOGIN);
    expect(parseRemote(entry.remote)).toEqual({ owner: "acme", repo: "widgets" });
  });

  test("an ssh remote is not a valid entry — it would authenticate with a key this story never reads", () => {
    expect(parseRemote("git@github.com:acme/widgets.git")).toBeNull();
    expect(parseRemote("https://gitlab.com/acme/widgets.git")).toBeNull();
  });

  test("a missing allowlist refuses rather than defaulting to anything", async () => {
    const host = await makeHost("run-nolist");
    expect(() => resolveRepoEntry(host.root, REPO_SLUG)).toThrow(/could not be read/);
  });
});

describe("INV-PR-6 — the publish namespace", () => {
  test("every ref outside `refs/heads/qds/` is refused, traversal included", () => {
    for (const ref of [
      "refs/heads/main",
      "refs/tags/v1",
      "refs/heads/qds",
      "refs/heads/qds/",
      "refs/heads/qds/../../heads/main",
      "refs/heads/qds/..",
      "refs/heads/qds/.hidden",
      "refs/heads/qds/x.lock",
      "refs/heads/qds/a.",
      "refs/heads/qds/a..b",
      "refs/heads/qds/a..",
      "refs/heads/qds/ok/a.",
      "refs/heads/qds/a b",
      "refs/heads/qds/a~1",
      "refs/heads/qds/a^",
      "refs/heads/qds/a:b",
      "refs/heads/qds/a?",
      "refs/heads/qds/a*",
      "refs/heads/qds/a[b",
      "refs/heads/qds/a\\b",
      "refs/heads/qds/a@{1}",
      "refs/heads/qds/a//b",
      "refs/heads/qds/a\u0000b",
      "refs/heads/qds/a\tb",
      "refs/heads/qds/-lead",
    ]) {
      expect(() => assertPublishableRef(ref)).toThrow(/not a publishable ref/);
    }
  });

  test("the default ref and DF6.1's append branches are accepted", () => {
    expect(PUBLISH_REF_PREFIX).toBe("refs/heads/qds/");
    for (const ref of [defaultTargetRef("run-1"), "refs/heads/qds/run-1/fix-2", "refs/heads/qds/RUN_1.x"]) {
      expect(() => assertPublishableRef(ref)).not.toThrow();
    }
  });

  test("a push to an out-of-namespace ref refuses before the remote is touched", async () => {
    const runId = "run-outofns";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    const before = await remoteRefs(host);
    // The token read is instrumented: a ref the factory would never publish to
    // must refuse before the credential is touched at all.
    let tokenReads = 0;
    const out = await pushVerifiedSha(runId, {
      ...deps(host),
      targetRef: "refs/heads/main",
      token: async () => {
        tokenReads += 1;
        return TOKEN;
      },
    });
    expect(tokenReads).toBe(0);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("target-ref-outside-namespace");
    // The base branch still carries exactly what it carried; the run's verified
    // sha is not it.
    expect(await remoteRefs(host)).toEqual(before);
    expect(before["refs/heads/main"]).not.toBe(host.headSha);
  });

  test("a traversing run id throws before `<prDir>/<runId>.refusals.jsonl` is named", async () => {
    const runId = "run-pushtraverse";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    await expect(pushVerifiedSha("../../etc/x", deps(host))).rejects.toThrow(/invalid run id/);
  });
});

describe("the publish namespace agrees with git's own ref grammar", () => {
  // The guard exists so an unpublishable ref refuses BEFORE the credential is
  // read. Any name git would reject but the guard accepts defeats that: the
  // refusal arrives from `git push` instead, one child process too late.
  test("the guard never accepts a name git would reject", async () => {
    // One-directional on purpose. STRICTER than git is fine — the guard also
    // rejects a bare `@` component, which git allows — but LOOSER is the bug:
    // it means the refusal arrives from `git push`, one child process late.
    const names = [
      "run-1", "run-1/fix-2", "RUN_1.x", "a.b.c", "a-b_c.d", "v1.2.3", "@",
      "a.", "a..b", "a..", "ok/a.", ".a", "a.lock", "a b", "a\tb",
      "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a@{1}", "a//b", "a/", "",
    ];
    for (const name of names) {
      const ref = `${PUBLISH_REF_PREFIX}${name}`;
      const git = await exec(["git", "check-ref-format", ref]);
      let accepted = true;
      try {
        assertPublishableRef(ref);
      } catch {
        accepted = false;
      }
      if (accepted) {
        expect({ name, gitExit: git.exitCode }).toEqual({ name, gitExit: 0 });
      }
    }
  });

  test("the names DF5.2 and DF6.1 actually publish under are accepted", () => {
    for (const name of ["run-1", "run-20260825-a1b2c3", "run-1/fix-2", "RUN_1.x", "v1.2.3"]) {
      expect(() => assertPublishableRef(`${PUBLISH_REF_PREFIX}${name}`)).not.toThrow();
    }
  });

  test("an invalid ref component refuses before the credential is read", async () => {
    const runId = "run-dotdot";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    for (const targetRef of ["refs/heads/qds/a..b", "refs/heads/qds/a."]) {
      let tokenReads = 0;
      const out = await pushVerifiedSha(runId, {
        ...deps(host),
        targetRef,
        token: async () => {
          tokenReads += 1;
          return TOKEN;
        },
      });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.refusal.failedPrecondition).toBe("target-ref-outside-namespace");
      expect(tokenReads).toBe(0);
    }
  });
});

describe("F065 — the remote tip is shape-checked before it reaches a git child", () => {
  test("an ls-remote first token that is not a sha refuses instead of becoming a git option", async () => {
    const runId = "run-push-hostile-tip";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    // `tip` is whatever ls-remote's first whitespace token is. A remote (or a
    // MITM on the transport) that answers with a leading-dash token would have
    // it spliced straight into `git fetch … <tip>` and `git merge-base
    // --is-ancestor <tip> …`, where it parses as an option.
    const seen: string[][] = [];
    const hostileExec: typeof host.exec = (argv, opts) => {
      seen.push([...argv]);
      if (argv.includes("ls-remote")) {
        return Promise.resolve({ exitCode: 0, stdout: "--upload-pack=evil\trefs/heads/qds/pr-branch\n", stderr: "" });
      }
      return host.exec(argv, opts);
    };

    const out = await pushVerifiedSha(runId, {
      ...deps(host),
      exec: hostileExec,
      targetRef: "refs/heads/qds/pr-branch",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("remote-tip-unreadable");
    // The guard runs BEFORE the fetch — no git child ever saw the token.
    expect(seen.some((argv) => argv.includes("--upload-pack=evil"))).toBe(false);
  }, 20_000);
});
