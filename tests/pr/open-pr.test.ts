/**
 * `openPullRequest(runId)` end to end (Story DF5.2).
 *
 * Real git, a real bare remote, a real run record and a real `ReverifyReport`
 * on disk; only the GitHub HTTP surface is a fake. Every "nothing was pushed"
 * assertion reads the bare repo's refs, not a mock's call log.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { GitHubApiError } from "../../src/pr/github.ts";
import { openPullRequest, resolveIssueRefs } from "../../src/pr/open-pr.ts";
import { refusalPath } from "../../src/pr/push.ts";
import { captureHostToken, runRedactionMap } from "../../src/reverify/redaction.ts";
import {
  BASE_BRANCH,
  AUTHOR_LOGIN,
  REMOTE_URL,
  REPO_SLUG,
  TOKEN,
  approve,
  defaultAllowlist,
  fakeGitHub,
  makeHost,
  makeRecord,
  remoteRefs,
  writeAllowlist,
  writeReport,
  type Host,
} from "./helpers.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const token = async () => TOKEN;

function deps(host: Host, github = fakeGitHub(), over: Record<string, unknown> = {}) {
  return {
    hostRoot: host.root,
    store: host.store,
    reverifyDir: host.reverifyDir,
    prDir: host.prDir,
    runsDir: host.runsDir,
    exec: host.exec,
    github,
    token,
    log: () => {},
    // Absent ledger: the cost line is a reporting concern, and the tests that
    // care about it name their own path.
    ledgerPath: null as string | null,
    ...over,
  };
}

function refusals(host: Host, runId: string): Record<string, unknown>[] {
  return readFileSync(refusalPath(host.prDir, runId), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("AC1 — the happy path", () => {
  test("pushes the verified sha, opens the PR, records it at creation", async () => {
    const runId = "run-ac1";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The SHA landed on the remote under `qds/<run-id>` — not the ref name,
    // which could have moved between preflight and push.
    const refs = await remoteRefs(host);
    expect(refs[`refs/heads/qds/${runId}`]).toBe(host.headSha);

    expect(github.created).toHaveLength(1);
    expect(github.created[0]!.head).toBe(`qds/${runId}`);
    expect(github.created[0]!.base).toBe("main");
    expect(github.created[0]!.body).toContain(`Run: ${runId}`);
    expect(github.created[0]!.body).toContain("Issue: Closes #42");
    expect(github.created[0]!.body).toContain("Re-verify: green — 2/2 checks");
    expect(github.created[0]!.body).toContain("Approved by: steve at");
    expect(github.created[0]!.body).toContain("- src.ts");

    // Written AT CREATION, from the HOST clock — DF5.3's first hop and the
    // stamp DF5.4-C6 orders against.
    const pr = host.store.get(runId).extensions?.pr;
    expect(pr?.prUrl).toBe(out.prUrl);
    expect(pr?.prNumber).toBe(out.prNumber);
    expect(Date.parse(String(pr?.createdAt))).toBeGreaterThan(0);
  });

  test("no ledger rows renders `Cost: unavailable` and the PR still opens", async () => {
    const runId = "run-nocost";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();

    // A ledger path that does not exist — the boundary AC2 names.
    const out = await openPullRequest(runId, deps(host, github, { ledgerPath: join(host.root, "absent.db") }));
    expect(out.ok).toBe(true);
    expect(github.created[0]!.body).toContain("Cost: unavailable");
  });
});

describe("AC3 — fail closed", () => {
  test("a red report pushes nothing, opens nothing, records the refusal durably and comments once", async () => {
    const runId = "run-red";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId, { red: true }));
    const github = fakeGitHub();

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(false);
    if (out.ok) return;

    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
    expect(github.created).toHaveLength(0);
    expect(out.refusal.failedPrecondition).toBe("reverify-red");
    expect(out.refusal.failingChecks).toEqual(["tests: bun test"]);
    expect(out.refusal.reportPath).toContain(`${runId}.jsonl`);

    const lines = refusals(host, runId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.failedPrecondition).toBe("reverify-red");

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.issueNumber).toBe(42);
    expect(github.comments[0]!.body).toContain("tests: bun test");
  });

  test("a run with NO issue reference still refuses durably — the comment is not the sink", async () => {
    const runId = "run-noissue";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId, { issueId: "" });
    approve(host, runId, writeReport(host, runId, { red: true }));
    const github = fakeGitHub();

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(false);
    expect(github.comments).toHaveLength(0);
    expect(github.created).toHaveLength(0);
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
    // The durable line is what makes this fail-CLOSED rather than fail-quiet.
    expect(refusals(host, runId)).toHaveLength(1);
  });

  test("a failing issue-comment call does not rescue or mask the refusal", async () => {
    const runId = "run-commentfail";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId, { red: true }));
    const github = fakeGitHub();
    github.commentIssue = async () => {
      throw new Error("502 from GitHub");
    };

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(false);
    expect(refusals(host, runId)).toHaveLength(1);
  });

  test("a report green at another sha is not authorization for this one", async () => {
    const runId = "run-shamismatch";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId, { headSha: host.baseSha }));

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("reverify-sha-mismatch");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  });

  test("a missing report refuses", async () => {
    const runId = "run-noreport";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("reverify-missing");
  });

  test.each([
    ["absent", null],
    ["not approved", { state: "awaiting-approval" }],
    ["bound to another report", { reportId: "rv-someone-else" }],
    ["bound to another sha", { headSha: "0".repeat(40) }],
  ])("an approval %s refuses with nothing pushed", async (_label, over) => {
    const runId = `run-appr-${String(_label).replace(/[^a-z]+/g, "")}`;
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId, over === null ? { approval: null } : {});
    const report = writeReport(host, runId);
    if (over !== null) approve(host, runId, report, over as Record<string, string>);

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toStartWith("approval-");
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  });

  test("an approval decided BEFORE the report it would authorize refuses", async () => {
    const runId = "run-apprearly";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    const report = writeReport(host, runId);
    // Same report, same sha — only the clock is wrong. An approval of an
    // earlier verdict never authorizes a later re-harvest.
    approve(host, runId, report, { decidedAt: new Date(Date.parse(report.completedAt) - 60_000).toISOString() });

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("approval-precedes-report");
  });
});

describe("INV-PR-4 — the host verdict is the only evidence authority", () => {
  test("a box claiming success against a red host verdict opens no PR", async () => {
    const runId = "run-boxlies";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    // The box says every gate passed and it exited clean. The host says red.
    approve(host, runId, writeReport(host, runId, { red: true, claimedSuccess: true }));
    const github = fakeGitHub();

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(false);
    expect(github.created).toHaveLength(0);
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
    expect(github.comments).toHaveLength(1);
  });

  test("a box claiming failure against a green host verdict still opens the PR", async () => {
    const runId = "run-boxpessimist";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    // The mirror image of the case above: the box's claim is not evidence in
    // either direction — the host verdict is green, so the PR opens.
    approve(host, runId, writeReport(host, runId, { claimedSuccess: false }));
    const github = fakeGitHub();

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(true);
    expect(github.created).toHaveLength(1);
  });
});

describe("AC4 — idempotency and resumability", () => {
  test("a PR opened by a concurrent caller between the probe and the POST is ADOPTED, not refused", async () => {
    const runId = "run-raced";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();
    // The race, exactly: our probe found nothing, and the other caller's PR
    // lands before our POST. GitHub permits one open PR per head branch, so
    // ours is answered 422 — the loser adopts rather than refusing a run whose
    // branch is pushed and whose PR is open.
    github.createPr = async ({ head }) => {
      github.openPrs.push({ url: `https://github.com/${REPO_SLUG}/pull/7`, number: 7, head });
      throw new GitHubApiError(422, "POST /pulls failed: 422 A pull request already exists for acme:qds/run-raced");
    };

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.prNumber).toBe(7);
    expect(out.reused).toBe(true);
    expect(host.store.get(runId).extensions?.pr?.prUrl).toBe(`https://github.com/${REPO_SLUG}/pull/7`);
  });

  test("an open PR on this run's branch against ANOTHER base is neither reused nor adopted", async () => {
    const runId = "run-wrongbase";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();
    // Same head branch, a base this run does not publish against. Reusing it
    // would correlate the run to a PR that never targets the allowlisted base.
    github.openPrs.push({ url: `https://github.com/${REPO_SLUG}/pull/9`, number: 9, head: `qds/${runId}`, base: "gh-pages" });

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reused).toBe(false);
    expect(out.prNumber).not.toBe(9);
    expect(github.created).toHaveLength(1);
    expect(github.created[0]?.base).toBe(BASE_BRANCH);
  });

  test("a 422 the reuse probe cannot explain is still a refusal", async () => {
    const runId = "run-422other";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub({
      failCreate: new GitHubApiError(422, "POST /pulls failed: 422 No commits between main and qds/run-422other"),
    });

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(false);
    // Real git remote round-trips (or script spawns) can outrun bun's 5s
    // default under parallel-suite load — same load-flake family the fleet
    // race tests document; deterministic solo.
  }, 20_000);

  test("a record write that fails AFTER the PR is open refuses NAMING the PR, and the re-run reuses it", async () => {
    const runId = "run-writefail";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();

    // Fails only the post-publication write: the idempotency `store.get` and
    // the preflight's reads must still work, or the run never reaches the PR.
    let failNextSet = true;
    const brittle = new Proxy(host.store, {
      get(target, prop, recv) {
        if (prop === "set") {
          return (...args: unknown[]) => {
            if (failNextSet) {
              failNextSet = false;
              throw new Error("disk full");
            }
            return (target.set as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });

    const first = await openPullRequest(runId, deps(host, github, { store: brittle }));
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.refusal.failedPrecondition).toBe("record-write-after-publication");
    // The refusal is USABLE: it names the PR that is already open.
    expect(first.refusal.message).toContain(`https://github.com/${REPO_SLUG}/pull/101`);
    expect(github.created).toHaveLength(1);

    // Resumption: no second PR, no second push, and the record is written now.
    const second = await openPullRequest(runId, deps(host, github));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reused).toBe(true);
    expect(github.created).toHaveLength(1);
  });

  test("a second invocation returns the same PR, opens no second one and pushes nothing", async () => {
    const runId = "run-idem";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();

    const first = await openPullRequest(runId, deps(host, github));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const refsAfterFirst = await remoteRefs(host);

    const second = await openPullRequest(runId, deps(host, github));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.prUrl).toBe(first.prUrl);
    expect(second.prNumber).toBe(first.prNumber);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.reused).toBe(true);
    // A re-push-and-reopen implementation fails here.
    expect(github.created).toHaveLength(1);
    expect(await remoteRefs(host)).toEqual(refsAfterFirst);
  });

  test("a push that succeeded with a failed PR-open records no prUrl and resumes at the open", async () => {
    const runId = "run-resume";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub({ failCreate: new Error("503 from GitHub") });

    const first = await openPullRequest(runId, deps(host, github));
    expect(first.ok).toBe(false);
    // The branch IS on the remote — the push boundary completed.
    expect((await remoteRefs(host))[`refs/heads/qds/${runId}`]).toBe(host.headSha);
    // …and nothing was half-recorded.
    expect(host.store.get(runId).extensions?.pr?.prUrl).toBeUndefined();

    github.failCreate = null;
    const second = await openPullRequest(runId, deps(host, github));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(github.created).toHaveLength(1);
    expect(host.store.get(runId).extensions?.pr?.prUrl).toBe(second.prUrl);
  });

  test("a lost POST /pulls response reuses the existing open PR instead of duplicating it", async () => {
    const runId = "run-lostpost";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();
    // The first attempt's PR landed on GitHub but its response was lost, so no
    // `prUrl` was ever recorded.
    github.openPrs.push({ url: `https://github.com/${REPO_SLUG}/pull/7`, number: 7, head: `qds/${runId}` });

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.prNumber).toBe(7);
    expect(out.reused).toBe(true);
    expect(github.created).toHaveLength(0);
  });

  test("a remote branch already at a DIFFERENT sha is refused, never forced (INV-PR-6)", async () => {
    const runId = "run-diverged";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    // Someone else's commit already published under this run's branch name.
    await host.exec(["git", "push", host.remoteDir, `${host.baseSha}:refs/heads/qds/${runId}`], { cwd: host.root });

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("remote-ref-diverged");
    expect((await remoteRefs(host))[`refs/heads/qds/${runId}`]).toBe(host.baseSha);
  });
});

describe("AC5 — registered repositories and author identity only", () => {
  test("an unregistered remote pushes nothing and logs a security event", async () => {
    const runId = "run-unreg";
    const host = await makeHost(runId);
    writeAllowlist(host, { "other/repo": { remote: REMOTE_URL, baseBranch: "main", authorLogin: AUTHOR_LOGIN } });
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const events: Record<string, unknown>[] = [];

    const out = await openPullRequest(runId, deps(host, fakeGitHub(), { log: (e: Record<string, unknown>) => events.push(e) }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("allowlist");
    expect(events.some((e) => e.securityEvent === true)).toBe(true);
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  });

  test("an EMPTY allowlist matches no repository — it never means `any`", async () => {
    const runId = "run-emptylist";
    const host = await makeHost(runId);
    writeAllowlist(host, {});
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("allowlist");
  });

  test("an allowlist wider than 0600 is refused before it is read", async () => {
    const runId = "run-loosemode";
    const host = await makeHost(runId);
    defaultAllowlist(host, 0o644);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.message).toContain("must be 0600");
  });

  test("an entry with no authorLogin is not a valid entry", async () => {
    const runId = "run-noauthor";
    const host = await makeHost(runId);
    writeAllowlist(host, {
      [REPO_SLUG]: { remote: REMOTE_URL, baseBranch: "main" } as unknown as {
        remote: string;
        baseBranch: string;
        authorLogin: string;
      },
    });
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("allowlist");
  });

  test("a token authenticating as the WRONG login refuses — an unreviewable PR is not opened", async () => {
    const runId = "run-wrongid";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub({ loginValue: "someone-else" });
    const events: Record<string, unknown>[] = [];

    const out = await openPullRequest(runId, deps(host, github, { log: (e: Record<string, unknown>) => events.push(e) }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("author-identity-mismatch");
    expect(events.some((e) => e.securityEvent === true)).toBe(true);
    expect(github.created).toHaveLength(0);
    expect(await remoteRefs(host)).not.toHaveProperty(`refs/heads/qds/${runId}`);
  });

  test("no host token refuses with nothing pushed", async () => {
    const runId = "run-notoken";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    const out = await openPullRequest(runId, deps(host, fakeGitHub(), { token: async () => null }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("no-token");
  });
});

describe("INV-PR-6 — openPullRequest publishes to qds/<run-id> and nowhere else", () => {
  test("a non-default targetRef is refused outright, before the preflight", async () => {
    const runId = "run-badref";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();

    const out = await openPullRequest(runId, deps(host, github, { targetRef: "refs/heads/main" }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("non-default-target-ref");
    expect(github.created).toHaveLength(0);
    expect(await remoteRefs(host)).not.toHaveProperty("refs/heads/qds/run-badref");
  });
});

describe("INV-PR-2 — the token reaches no log, record or error surface", () => {
  test("a sentinel token appears in no log line, no run-record field and no refusal record", async () => {
    const runId = "run-sentinel";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();
    const events: Record<string, unknown>[] = [];

    const out = await openPullRequest(runId, deps(host, github, { log: (e: Record<string, unknown>) => events.push(e) }));
    expect(out.ok).toBe(true);

    const surfaces = [
      JSON.stringify(events),
      JSON.stringify(host.store.get(runId)),
      JSON.stringify(github.created),
      JSON.stringify(out),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(TOKEN);
  });
});

describe("P1.3 issue resolution (AC2) — non-blocking", () => {
  test("the mirror index translates a run's issue to the target repo's numbers", async () => {
    const runId = "run-mirror";
    const host = await makeHost(runId);
    const index = join(host.root, "mirror.jsonl");
    writeFileSync(
      index,
      `${JSON.stringify({ repoSlug: REPO_SLUG, issueId: "42", mirrorIssue: 900, parentIssue: 7 })}\n`,
    );
    expect(resolveIssueRefs(host.root, REPO_SLUG, "42", index)).toEqual({
      line: "Closes #900 (parent #7)",
      issueNumber: 900,
    });
  });

  test("an absent index falls back to the run's own numeric issue id", async () => {
    const host = await makeHost("run-mirror2");
    expect(resolveIssueRefs(host.root, REPO_SLUG, "42", join(host.root, "absent.jsonl"))).toEqual({
      line: "Closes #42",
      issueNumber: 42,
    });
  });

  test("a non-numeric, unmapped issue id renders `unresolved` rather than omitting the line", async () => {
    const host = await makeHost("run-mirror3");
    expect(resolveIssueRefs(host.root, REPO_SLUG, "PROJ-17", join(host.root, "absent.jsonl"))).toEqual({
      line: "unresolved",
      issueNumber: null,
    });
  });
});

describe("review round 11 — boundary validation and durable refusal", () => {
  test("a traversing run id throws before any path is named after it", async () => {
    const runId = "run-traverse";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    await expect(openPullRequest("../../etc/x", deps(host))).rejects.toThrow(/invalid run id/);

    // Nothing escaped `.sandbox/pr/`, because nothing was written at all.
    expect(existsSync(join(host.prDir, "..", "..", "etc"))).toBe(false);
    const refs = await remoteRefs(host);
    expect(Object.keys(refs).filter((r) => r.startsWith("refs/heads/qds/"))).toHaveLength(0);
  });

  test("an unreadable run record refuses durably instead of rejecting the promise", async () => {
    const runId = "run-norecord";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    // No `makeRecord`: `store.get` throws on the idempotency read, which is the
    // FIRST thing this function does after the ref check.
    const out = await openPullRequest(runId, deps(host));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(refusals(host, runId)).toHaveLength(1);
    expect(out.refusal.failedPrecondition).toBe("unexpected-error");
  });

  test("a failed git diff refuses rather than publishing a false 0-file body", async () => {
    const runId = "run-nodiff";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();

    // Every git call is the real one EXCEPT the body's diff.
    const exec = async (argv: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
      if (argv[0] === "git" && argv[1] === "diff") {
        return { exitCode: 128, stdout: "", stderr: "fatal: bad object", signal: null, timedOut: false };
      }
      return await host.exec(argv, opts);
    };

    const out = await openPullRequest(runId, deps(host, github, { exec }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusal.failedPrecondition).toBe("diff-unavailable");
    // No PR carrying "0 files, re-verified green" was ever opened.
    expect(github.created).toHaveLength(0);
    expect(refusals(host, runId)).toHaveLength(1);
  });

  test("an unrenderable redaction map throws BEFORE the push, not after it", async () => {
    const runId = "run-badmap";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));

    // `hostPat` is invisible to `redactSecrets`. Caught at entry, the branch is
    // never published for a call whose body could never render.
    await expect(
      openPullRequest(runId, deps(host, fakeGitHub(), { redaction: { hostPat: "ghp_0123456789abcdef" } })),
    ).rejects.toThrow(/invisible to redactSecrets/);
    const refs = await remoteRefs(host);
    expect(refs[`refs/heads/qds/${runId}`]).toBeUndefined();
  });

  test("the reuse probe is matched on the head branch, not on the first open PR", async () => {
    const runId = "run-otherbranch";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();
    // An unrelated PR is open on this repo. It is NOT this run's PR.
    github.openPrs.push({ url: `https://github.com/${REPO_SLUG}/pull/9`, number: 9, head: "someone-else" });

    const out = await openPullRequest(runId, deps(host, github));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reused).toBe(false);
    expect(github.created).toHaveLength(1);
  });
});

describe("INV-PR-7 — the map the shipped CLI assembles (F007)", () => {
  // Sentinels, not real credentials. Long enough to clear
  // `MIN_REDACTABLE_VALUE_LEN`, which is what makes them redactable at all.
  const KEY_HASH = "sha256-sentinel-key-hash-0123456789abcdef";

  test("the run's key hash comes off the record and the token is added at the read", async () => {
    const runId = "run-map";
    const host = await makeHost(runId);
    makeRecord(host, runId);
    host.store.set(runId, { keyHash: KEY_HASH });

    const map = runRedactionMap(runId, host.runsDir);
    expect(map).toEqual({ QDS_PROVIDER_KEY_HASH: KEY_HASH });

    // The token is NOT read to build the map — the preflight reads it last, on
    // purpose. `captureHostToken` fills the entry in at that read.
    const read = captureHostToken(map, async () => TOKEN);
    expect(map.QDS_PR_TOKEN).toBeUndefined();
    expect(await read()).toBe(TOKEN);
    expect(map.QDS_PR_TOKEN).toBe(TOKEN);
  });

  test("an absent record yields an empty map rather than throwing", async () => {
    const host = await makeHost("run-present");
    expect(runRedactionMap("run-absent", host.runsDir)).toEqual({});
  });

  test("a push whose stderr echoes the credential publishes neither the token nor the hash", async () => {
    const runId = "run-redact";
    const host = await makeHost(runId);
    defaultAllowlist(host);
    makeRecord(host, runId);
    host.store.set(runId, { keyHash: KEY_HASH });
    approve(host, runId, writeReport(host, runId));
    const github = fakeGitHub();

    // Assembled exactly as `scripts/open-pr.ts` assembles it — this test is the
    // CLI's map, not a bespoke one.
    const redaction = runRedactionMap(runId, host.runsDir);

    // git echoing back the credential it was handed. `push.ts` carries push
    // stderr verbatim into the refusal, and `open-pr.ts` renders the refusal
    // into an issue comment: the publication surface F007 left unredacted.
    const exec = async (argv: readonly string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
      argv.includes("push")
        ? {
            exitCode: 128,
            stdout: "",
            stderr: `fatal: Authentication failed for 'https://x-access-token:${TOKEN}@github.com/${REPO_SLUG}.git' (key ${KEY_HASH})`,
          }
        : host.exec(argv, opts);

    const out = await openPullRequest(
      runId,
      deps(host, github, { exec, redaction, token: captureHostToken(redaction, async () => TOKEN) }),
    );
    expect(out.ok).toBe(false);

    expect(github.comments).toHaveLength(1);
    const body = github.comments[0]!.body;
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(KEY_HASH);
    // Positive proof the map MATCHED — `not.toContain` alone also passes when
    // the refusal text never carried the values in the first place.
    expect(body).toContain("[REDACTED:QDS_PR_TOKEN]");
    expect(body).toContain("[REDACTED:QDS_PROVIDER_KEY_HASH]");
  });
});
