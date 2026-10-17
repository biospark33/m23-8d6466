/**
 * Leaf-1.2.2 suite — host-side GitHub issue filing (gates G1/G2).
 *
 * Posture assertions: the token is read host-side (default `readHostToken`,
 * exercised against the real seam through a fake piped stdin) and carried
 * in-process into the REST client — never argv, never env, never a child
 * process. Absent-not-0 semantics of the `qa-issues-filed` count, strict-input
 * refusal (AC4 negative control), per-issue failure isolation, requestId
 * threading, and the forbidden-import fence (AC7) are asserted here too.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GitHubApi } from "../../src/pr/github.ts";
import { fileIssues, isActionable, QaIssuesError } from "../../src/qa/issues.ts";
import type { Finding } from "../../src/qa/findings.ts";
import type { LogEntry } from "../../src/lib/log.ts";

const COMMIT = "a".repeat(40);
const TOKEN = "ghp-test-token-not-secret";

const FINDING: Finding = {
  runId: "qds-20260101-abc123",
  lens: "correctness",
  finding_text: "auth middleware drops the retry counter on 503 responses",
  diff_context_ref: "src/auth/middleware.ts:42",
};

const STUB: Finding = {
  runId: "qds-20260101-abc123",
  lens: "correctness",
  finding_text: "todo: check",
  diff_context_ref: "src/auth/middleware.ts:42",
};

interface IssueCall {
  owner: string;
  repo: string;
  title: string;
  body: string;
  token: string;
}

/** Fake REST seam: records createIssue calls; only that method is exercised. */
function fakeApi(config: { failOnCall?: number } = {}): { api: GitHubApi; calls: IssueCall[] } {
  const calls: IssueCall[] = [];
  let n = 0;
  const api = {
    createIssue: async (o: IssueCall) => {
      n += 1;
      if (config.failOnCall === n) throw new Error("api exploded");
      calls.push({ ...o });
      return { issueNumber: 6 + n, htmlUrl: `https://github.com/${o.owner}/${o.repo}/issues/${6 + n}` };
    },
  } as unknown as GitHubApi;
  return { api, calls };
}

describe("isActionable", () => {
  test("a concrete diff ref + defect-length text is actionable", () => {
    expect(isActionable(FINDING)).toBe(true);
  });

  test("a blank diff ref is not actionable — no reproducible context", () => {
    expect(isActionable({ ...FINDING, diff_context_ref: "   " })).toBe(false);
  });

  test("a stub-length text is not actionable — not a specific defect", () => {
    expect(isActionable(STUB)).toBe(false);
  });

  test("the length bound is inclusive at ACTIONABLE_TEXT_MIN", () => {
    const text16 = "0123456789abcdef";
    expect(text16.length).toBe(16);
    expect(isActionable({ ...FINDING, finding_text: text16 })).toBe(true);
    expect(isActionable({ ...FINDING, finding_text: "0123456789abcde" })).toBe(false);
  });
});

describe("fileIssues — in-process REST posture", () => {
  test("one createIssue per actionable finding, token carried in-process — no env, no spawn", async () => {
    const { api, calls } = fakeApi();
    const logs: LogEntry[] = [];
    const envBefore = process.env.GH_TOKEN;
    // The key must be ABSENT (setting undefined yields the string "undefined").
    // biome-ignore lint/performance/noDelete: absence is the assertion
    delete process.env.GH_TOKEN;
    try {
      const result = await fileIssues(
        { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: (e) => logs.push(e) },
        { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING, STUB] },
      );

      // One call per ACTIONABLE finding (the stub is filtered), not per input row.
      expect(calls).toHaveLength(1);
      const call = calls[0] as IssueCall;
      expect(call.owner).toBe("acme");
      expect(call.repo).toBe("widgets");
      expect(call.token).toBe(TOKEN);
      // The token never lands in the process env on the way through.
      expect(process.env.GH_TOKEN).toBeUndefined();

      // Body = provenance block + full prose; title = bounded first line.
      expect(call.body).toContain("## QA finding");
      expect(call.body).toContain("auth middleware drops the retry counter");
      expect(call.body).toContain("qds-20260101-abc123");
      expect(call.body).toContain(COMMIT);
      expect(call.body).toContain("src/auth/middleware.ts:42");
      expect(call.title).toBe("correctness: auth middleware drops the retry counter on 503 responses");
      expect(call.title.length).toBeLessThanOrEqual(120);

      expect(result).toEqual({
        filed: 1,
        urls: ["https://github.com/acme/widgets/issues/7"],
        failures: [],
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.operation).toBe("qa-issues-filed");
      expect((logs[0] as LogEntry & { count?: number }).count).toBe(1);
      expect((logs[0] as LogEntry & { runId?: string }).runId).toBe("qds-20260101-abc123");
      // Absent-not-0: a clean batch carries no failedCount.
      expect((logs[0] as LogEntry & { failedCount?: number }).failedCount).toBeUndefined();
    } finally {
      if (envBefore !== undefined) process.env.GH_TOKEN = envBefore;
    }
  });

  test("title is bounded at 120 chars and cuts at the first line only", async () => {
    // Word-wrapped prose, not a single opaque token — a ≥40-char unbroken run
    // is exactly what redactSecrets now erases before the title is cut.
    const longFirst = "lorem ".repeat(50);
    const { api, calls } = fakeApi();
    await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      {
        commitSha: COMMIT,
        runId: "qds-20260101-abc123",
        lens: "secret-hygiene",
        findings: [{ ...FINDING, lens: "secret-hygiene", finding_text: `${longFirst}\nsecond line that must not appear` }],
      },
    );
    const call = calls[0] as IssueCall;
    expect(call.title.startsWith("secret-hygiene: ")).toBe(true);
    expect(call.title.length).toBe(120);
    expect(call.title).not.toContain("second line");
  });

  test("mixed-lens batch: title and provenance label from the FINDING, not the batch envelope", async () => {
    const { api, calls } = fakeApi();
    const finding: Finding = { ...FINDING, runId: "qds-20260202-def456", lens: "secret-hygiene" };
    await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [finding] },
    );
    const call = calls[0] as IssueCall;
    expect(call.title.startsWith("secret-hygiene: ")).toBe(true);
    expect(call.body).toContain("- runId: qds-20260202-def456");
    expect(call.body).not.toContain("- runId: qds-20260101-abc123");
  });

  test("titlePrefix prefixes the built title", async () => {
    const { api, calls } = fakeApi();
    await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", titlePrefix: "QA", findings: [FINDING] },
    );
    expect((calls[0] as IssueCall).title).toBe("QA correctness: auth middleware drops the retry counter on 503 responses");
  });

  test("a quoted credential is redacted in BOTH body and title — never posted raw", async () => {
    const secret = "sk-ant-api03-FAKEKEY0000000000000";
    const { api, calls } = fakeApi();
    await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      {
        commitSha: COMMIT,
        runId: "qds-20260101-abc123",
        lens: "secret-hygiene",
        findings: [{ ...FINDING, lens: "secret-hygiene", finding_text: `hardcoded credential ${secret} at src/auth/key.ts:9` }],
      },
    );
    const call = calls[0] as IssueCall;
    expect(call.body).toContain("«redacted»");
    expect(call.body).not.toContain(secret);
    expect(call.title).toContain("«redacted»");
    expect(call.title).not.toContain(secret);
  });

  test("a surrogate pair astride the 120-char cut is never split", async () => {
    // The emoji starts at UTF-16 offset 119 inside the composed title, so a
    // raw .slice(0, 120) would keep only its high surrogate.
    const firstLine = `${"a".repeat(106)}\u{1F600}trailing prose that must not appear in the title`;
    const { api, calls } = fakeApi();
    await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [{ ...FINDING, finding_text: firstLine }] },
    );
    const title = (calls[0] as IssueCall).title;
    expect([...title].length).toBeLessThanOrEqual(120);
    expect(title.endsWith("\u{1F600}")).toBe(true);
    // No lone surrogate anywhere in the string.
    expect(title).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test("requestId threads from input.requestId into the log line", async () => {
    const { api } = fakeApi();
    const logs: LogEntry[] = [];
    await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: (e) => logs.push(e) },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", requestId: "req-abc-123", findings: [FINDING] },
    );
    expect((logs[0] as LogEntry).requestId).toBe("req-abc-123");
  });
});

describe("fileIssues — slug + token gates", () => {
  test("a slug without exactly one / is a named batch refusal — no token read, no call", async () => {
    const { api, calls } = fakeApi();
    const tokenReader = async () => {
      throw new Error("tokenReader must not be reached");
    };
    await expect(
      fileIssues({ repoSlug: "acme", api, tokenReader, log: () => {} }, { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "l", findings: [FINDING] }),
    ).rejects.toMatchObject({ code: "issues-bad-repo-slug" });
    await expect(
      fileIssues({ repoSlug: "acme/widgets/extra", api, tokenReader, log: () => {} }, { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "l", findings: [FINDING] }),
    ).rejects.toMatchObject({ code: "issues-bad-repo-slug" });
    await expect(
      fileIssues({ repoSlug: "/widgets", api, tokenReader, log: () => {} }, { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "l", findings: [FINDING] }),
    ).rejects.toMatchObject({ code: "issues-bad-repo-slug" });
    expect(calls).toHaveLength(0);
  });

  test("a bad slug is refused even for a zero-actionable batch — the gate precedes the early return", async () => {
    const { api, calls } = fakeApi();
    const tokenReader = async () => {
      throw new Error("tokenReader must not be reached");
    };
    await expect(
      fileIssues({ repoSlug: "acme", api, tokenReader, log: () => {} }, { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [STUB] }),
    ).rejects.toMatchObject({ code: "issues-bad-repo-slug" });
    expect(calls).toHaveLength(0);
  });

  test("no token at all is a named batch refusal — nothing is filed", async () => {
    const { api, calls } = fakeApi();
    await expect(
      fileIssues(
        { repoSlug: "acme/widgets", api, tokenReader: async () => null, log: () => {} },
        { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING] },
      ),
    ).rejects.toThrow(QaIssuesError);
    expect(calls).toHaveLength(0);
  });
});

describe("fileIssues — token via the real readHostToken seam (fake stdin)", () => {
  test("the default tokenReader is readHostToken: piped stdin → in-process API call", async () => {
    // Bun.spawn snapshots the launch env, so an in-process stdin stub never
    // reaches the real seam — the house pattern runs fileIssues in a child bun
    // process: PATH has no `security` (the no-keychain host shape), the token
    // arrives piped on the child's stdin, and an injected fake api records the
    // token it received (still in-process inside the child — no spawn).
    const dir = mkdtempSync(join(tmpdir(), "qds-qa-issues-seam-"));
    const child = join(dir, "child.ts");
    const out = join(dir, "captured.json");
    writeFileSync(
      child,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { fileIssues } from ${JSON.stringify(join(import.meta.dir, "../../src/qa/issues.ts"))};`,
        "const captured: { token?: string } = {};",
        "const api = { createIssue: async (o) => { captured.token = o.token; return { issueNumber: 9, htmlUrl: `https://github.com/${o.owner}/${o.repo}/issues/9` }; } };",
        "const res = await fileIssues(",
        `  { repoSlug: "acme/widgets", api: api, log: () => {} },`,
        `  { commitSha: ${JSON.stringify(COMMIT)}, runId: "qds-20260101-abc123", lens: "correctness", findings: [${JSON.stringify(FINDING)}] },`,
        ");",
        `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ res, captured }));`,
      ].join("\n"),
    );
    try {
      // No `security` on PATH — the no-keychain host shape; the token is the
      // fake piped stdin.
      const proc = Bun.spawn([process.execPath, child], {
        stdin: new Blob([`${TOKEN}\n`]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: "/nonexistent" },
      });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(err).toBe("");
      expect(code).toBe(0);
      const { res, captured } = JSON.parse(readFileSync(out, "utf8")) as {
        res: { filed: number };
        captured: { token?: string };
      };
      expect(res.filed).toBe(1);
      // The real readHostToken's token reached the in-process API call only.
      expect(captured.token).toBe(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fileIssues — per-issue failure isolation", () => {
  test("a failure's error text is secret-redacted and bounded (retain.ts posture)", async () => {
    const secret = "sk-ant-api03-FAKEKEY0000000000000";
    let n = 0;
    const api = {
      createIssue: async () => {
        n += 1;
        throw new Error(n === 1 ? `POST failed: ${secret}` : `boom ${"ab".repeat(150)}`);
      },
    } as unknown as GitHubApi;
    const result = await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING, { ...FINDING, diff_context_ref: "src/b.ts:1" }] },
    );
    const [f1, f2] = result.failures;
    expect(f1?.error).toContain("«redacted»");
    expect(f1?.error).not.toContain(secret);
    expect(f2?.error).toHaveLength(200);
  });

  test("a rejected createIssue fails its own issue; the batch continues", async () => {
    const { api, calls } = fakeApi({ failOnCall: 1 });
    const result = await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING, { ...FINDING, diff_context_ref: "src/auth/session.ts:9" }] },
    );
    expect(calls).toHaveLength(1);
    expect(result.filed).toBe(1);
    expect(result.urls).toEqual(["https://github.com/acme/widgets/issues/8"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toBe("api exploded");
    expect(result.failures[0]?.finding.diff_context_ref).toBe("src/auth/middleware.ts:42");
  });

  test("a throwing createIssue is captured per-issue — never thrown mid-batch", async () => {
    const { api, calls } = fakeApi({ failOnCall: 2 });
    const result = await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING, { ...FINDING, diff_context_ref: "src/b.ts:1" }] },
    );
    expect(calls).toHaveLength(1);
    expect(result.filed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toBe("api exploded");
  });
});

describe("fileIssues — absent-not-0 semantics", () => {
  test("zero actionable findings: no API call, no token read, no log line at all", async () => {
    const { api, calls } = fakeApi();
    const logs: LogEntry[] = [];
    const tokenReaderCalls: number[] = [];
    const result = await fileIssues(
      {
        repoSlug: "acme/widgets",
        api,
        tokenReader: async () => {
          tokenReaderCalls.push(1);
          return TOKEN;
        },
        log: (e) => logs.push(e),
      },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [STUB] },
    );
    expect(result).toEqual({ filed: 0, urls: [], failures: [] });
    expect(calls).toHaveLength(0);
    expect(tokenReaderCalls).toHaveLength(0);
    expect(logs).toHaveLength(0); // ABSENT — the leg did not run
  });

  test("ran-and-filed-none: the count is 0, not absent", async () => {
    const { api } = fakeApi({ failOnCall: 1 });
    const logs: LogEntry[] = [];
    const result = await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: (e) => logs.push(e) },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING] },
    );
    expect(result.filed).toBe(0);
    expect((logs[0] as LogEntry & { count?: number }).count).toBe(0);
    // The leg ran and its one attempt failed, so the count rides the line.
    expect((logs[0] as LogEntry & { failedCount?: number }).failedCount).toBe(1);
  });
});

describe("fileIssues — same-batch dedup", () => {
  test("an identical (lens + text + diff ref) duplicate files once and reports skipped", async () => {
    const { api, calls } = fakeApi();
    const result = await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING, { ...FINDING }] },
    );
    expect(calls).toHaveLength(1);
    expect(result.filed).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});

describe("fileIssues — best-effort log sink", () => {
  test("a throwing sink does not reject the call or lose the filing result", async () => {
    const { api } = fakeApi();
    const throwingSink = () => {
      throw new Error("sink exploded");
    };
    const result = await fileIssues(
      { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: throwingSink },
      { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING] },
    );
    expect(result.filed).toBe(1);
    expect(result.urls).toEqual(["https://github.com/acme/widgets/issues/7"]);
  });
});

describe("fileIssues — strict input refusal (AC4 negative control)", () => {
  test("a boxEnv-shaped caller is refused by name before any token read or API call", async () => {
    const { api, calls } = fakeApi();
    const tokenReader = async () => {
      throw new Error("tokenReader must not be reached");
    };
    await expect(
      fileIssues(
        { repoSlug: "acme/widgets", api, tokenReader, log: () => {} },
        { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING], boxEnv: { GH_TOKEN: "x" } },
      ),
    ).rejects.toThrow(QaIssuesError);
    expect(calls).toHaveLength(0);
  });

  test("a GH_TOKEN-shaped field on the input is refused", async () => {
    const { api, calls } = fakeApi();
    await expect(
      fileIssues(
        { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
        { commitSha: COMMIT, runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING], GH_TOKEN: TOKEN },
      ),
    ).rejects.toThrow(QaIssuesError);
    expect(calls).toHaveLength(0);
  });

  test("a malformed commitSha is refused (strict shape)", async () => {
    await expect(
      fileIssues(
        { repoSlug: "acme/widgets", api: fakeApi().api, tokenReader: async () => TOKEN, log: () => {} },
        { commitSha: "not-a-sha", runId: "qds-20260101-abc123", lens: "correctness", findings: [FINDING] },
      ),
    ).rejects.toThrow(QaIssuesError);
  });

  test("a foreign runId shape is refused (minted qds-YYYYMMDD-hex6 only)", async () => {
    const { api, calls } = fakeApi();
    await expect(
      fileIssues(
        { repoSlug: "acme/widgets", api, tokenReader: async () => TOKEN, log: () => {} },
        { commitSha: COMMIT, runId: "run-20260101-legacy", lens: "correctness", findings: [FINDING] },
      ),
    ).rejects.toThrow(QaIssuesError);
    expect(calls).toHaveLength(0);
  });
});

describe("forbidden-import fence (AC7)", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/qa/issues.ts"), "utf8");

  test("the module never imports or references the approval gate", () => {
    expect(source.includes("approval-gate")).toBe(false);
  });

  test("the module never reads a token out of process env", () => {
    expect(source.includes("process.env.GH_TOKEN")).toBe(false);
  });

  test("the module never plants a token in a child env", () => {
    expect(source.includes("GH_TOKEN:")).toBe(false);
  });
});
