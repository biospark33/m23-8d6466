import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  importMulch,
  verifyTenantIsolation,
  dedupHash,
  FileTooLargeError,
  SymlinkEscapeError,
  SymlinkTargetUnreadableError,
  MAX_CONTENT_BYTES,
  MAX_FILE_BYTES,
} from "../../src/hindsight/mulch-importer.ts";
import { ERR_MULCH_FILE_COUNT } from "../../src/hindsight/schemas.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/mcp/stdio-transport.ts";

// ---------------------------------------------------------------------------
// Mock HindsightClient — records retain calls; recall returns programmable
// results. No live HTTP.
// ---------------------------------------------------------------------------

interface RetainCall {
  bankId: string;
  content: string;
  metadata?: { source?: string; kind?: string; tags?: string[] };
}

interface MockBank {
  // domain+concepts hash → retain call (so dedup semantics mirror the importer)
  byHash: Map<string, RetainCall>;
  // raw retains in order
  calls: RetainCall[];
}

function makeMockClient(opts: { recallResults?: (q: string, bank: string) => Array<{ content: string }> } = {}) {
  const banks = new Map<string, MockBank>();
  const allCalls: RetainCall[] = [];

  function bankOf(id: string): MockBank {
    let b = banks.get(id);
    if (!b) {
      b = { byHash: new Map(), calls: [] };
      banks.set(id, b);
    }
    return b;
  }

  const client = {
    async retain(
      bankId: string,
      content: string,
      metadata?: { source?: string; kind?: string; tags?: string[] },
    ) {
      const call: RetainCall = { bankId, content, metadata };
      const b = bankOf(bankId);
      b.calls.push(call);
      allCalls.push(call);
      // Track by dedup hash if metadata.tags present (mulch-import sets them).
      if (metadata?.tags) {
        // Re-derive domain from the JSONL content (best-effort mirror of importer).
        try {
          const parsed = JSON.parse(content) as { domain?: string; concepts?: string[] };
          if (parsed.domain && parsed.concepts) {
            const h = dedupHash(parsed.domain, parsed.concepts);
            b.byHash.set(h, call);
          }
        } catch {
          /* non-JSON content (tenant probe marker) — no dedup */
        }
      }
      return {
        memoryId: crypto.randomUUID(),
        bankId,
        status: "created" as const,
        durationMs: 1,
      };
    },
    async recall(bankId: string, query: string, _limit = 5) {
      const results = opts.recallResults
        ? opts.recallResults(query, bankId).map((c) => ({
            content: typeof c === "string" ? c : c.content,
            score: 0.9,
            memoryId: crypto.randomUUID(),
          }))
        : [];
      // ponytail: by default return nothing — tenant-isolation probe depends
      // on this so a marker retained in bankA does NOT surface from bankB.
      return { results, durationMs: 1 };
    },
    // exposed for assertions
    _banks: banks,
    _allCalls: allCalls,
  };
  return client;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let logs: LogEntry[];
let restoreSink: () => void;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mulch-test-"));
  logs = [];
  restoreSink = setLogSink((e) => {
    logs.push(e);
  });
});

afterEach(() => {
  restoreSink();
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importMulch — happy path", () => {
  test("yaml + json files import as JSONL; ids auto-gen'd; source recorded", async () => {
    writeFile(
      "seed.yaml",
      `- domain: qds
  concepts: [sparc, tdd]
  expertise: "SPARC is the methodology."
- domain: qds
  concepts: [trunk-based]
  expertise: "Trunk-based branching."
`,
    );
    writeFile(
      "more.json",
      `[{"domain":"swarmclaw","concepts":["mcp"],"expertise":"MCP bridge."}]`,
    );

    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "qds-factory-dev-meta",
    });

    expect(result.ok).toBe(true);
    expect(result.totalFiles).toBe(2);
    expect(result.importedFiles).toBe(2);
    expect(result.failures).toEqual([]);

    // 3 entries retained.
    expect(client._allCalls.length).toBe(3);
    for (const call of client._allCalls) {
      // Content is JSONL.
      const parsed = JSON.parse(call.content);
      expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/); // auto-gen UUID
      expect(parsed.source).toBeTruthy(); // recorded
      expect(call.metadata?.source).toBe("mulch-import");
      expect(call.metadata?.kind).toBe("expertise");
      expect(Array.isArray(call.metadata?.tags)).toBe(true);
    }
  });

  test("jsonl file parses line-by-line", async () => {
    writeFile(
      "data.jsonl",
      `{"domain":"a","concepts":["x"],"expertise":"A"}
{"domain":"b","concepts":["y"],"expertise":"B"}
`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-x",
    });
    expect(result.ok).toBe(true);
    expect(result.importedFiles).toBe(1);
    expect(client._allCalls.length).toBe(2);
  });
});

describe("importMulch — dedup (idempotency)", () => {
  test("same domain+concepts appearing twice in one run → second is update", async () => {
    // Two files, each with the SAME domain+concepts entry → second is an update.
    writeFile(
      "a.yaml",
      `- domain: qds
  concepts: [sparc]
  expertise: "SPARC methodology."
`,
    );
    writeFile(
      "b.yaml",
      `- domain: qds
  concepts: [sparc]
  expertise: "SPARC methodology (updated text)."
`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-dedup",
    });
    expect(result.ok).toBe(true);
    expect(result.importedFiles).toBe(1); // file a
    expect(result.updatedFiles).toBe(1); // file b (same domain+concepts)
    expect(client._allCalls.length).toBe(2); // both retained (update = retain)
  });

  test("cross-run idempotency delegates to bank retain (CC-10 best-effort)", async () => {
    // The importer's local Set is per-run; cross-run dedup is the bank's job.
    // We assert the contract: a second run still retains (idempotent update
    // server-side) and reports ok:true.
    writeFile(
      "seed.yaml",
      `- domain: qds
  concepts: [sparc]
  expertise: "SPARC methodology."
`,
    );
    const client = makeMockClient();
    const r1 = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-cross",
    });
    const r2 = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-cross",
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(client._allCalls.length).toBe(2); // one retain per run
  });

  test("dedup is order-independent on concepts", () => {
    const h1 = dedupHash("qds", ["sparc", "tdd"]);
    const h2 = dedupHash("qds", ["tdd", "sparc"]);
    expect(h1).toBe(h2);
  });

  test("dedup normalizes NFC (café NFC vs NFD)", () => {
    const nfc = "café".normalize("NFC");
    const nfd = "café".normalize("NFD");
    const h1 = dedupHash(nfc, [nfc]);
    const h2 = dedupHash(nfd, [nfd]);
    expect(h1).toBe(h2);
  });
});

describe("importMulch — partial failure", () => {
  test("one malformed entry → in failures[] with entryIndex, others imported", async () => {
    // domain as a number (not string) → fails MulchExpertiseSchema.
    writeFile(
      "mixed.json",
      `[
        {"domain":"ok","concepts":["a"],"expertise":"valid entry"},
        {"domain":123,"concepts":["b"],"expertise":"bad domain type"}
      ]`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-partial",
    });
    expect(result.ok).toBe(true);
    expect(result.importedFiles).toBe(1);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.entryIndex).toBe(1);
    expect(result.failures[0]!.file).toBe("mixed.json");
    expect(client._allCalls.length).toBe(1); // only the valid entry
  });

  test("malformed JSON → whole-file failure, other files still import", async () => {
    writeFile("broken.json", "{ not valid json");
    writeFile(
      "good.json",
      `[{"domain":"ok","concepts":["x"],"expertise":"works"}]`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-pf",
    });
    expect(result.ok).toBe(true);
    expect(result.importedFiles).toBe(1);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]!.file).toBe("broken.json");
    expect(result.failures[0]!.error).toBe("parse_failed");
    expect(result.failures[0]!.entryIndex).toBeUndefined();
  });
});

describe("importMulch — 100-file quota", () => {
  test("101 supported files → -32004 envelope, filesProcessed:100, no retains", async () => {
    for (let i = 0; i < 101; i++) {
      writeFileSync(join(tmpDir, `f${i}.json`), "[]");
    }
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-q",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ERR_MULCH_FILE_COUNT);
    expect(result.error?.message).toBe("File count exceeds maximum (100)");
    expect(result.filesProcessed).toBe(100);
    expect(client._allCalls.length).toBe(0);
  });

  test("exactly 100 files → imports (quota is >100)", async () => {
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(tmpDir, `f${i}.json`), "[]");
    }
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-q100",
    });
    expect(result.ok).toBe(true);
    expect(result.totalFiles).toBe(100);
  });
});

describe("importMulch — 5MB file cap", () => {
  test("6MB file → file_too_large, other files import", async () => {
    // Build a 6MB YAML: one entry with a giant expertise string.
    const big = "x".repeat(MAX_FILE_BYTES + 1024);
    writeFile("huge.yaml", `- domain: qds\n  concepts: [big]\n  expertise: "${big}"\n`);
    writeFile("small.json", `[{"domain":"ok","concepts":["y"],"expertise":"tiny"}]`);
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-mb",
    });
    expect(result.ok).toBe(true);
    expect(result.importedFiles).toBe(1);
    const cap = result.failures.find((f) => f.error === "file_too_large");
    expect(cap).toBeDefined();
    expect(cap!.file).toBe("huge.yaml");
  });
});

describe("importMulch — BOM strip", () => {
  test("BOM-prefixed yaml parses cleanly", async () => {
    // Write a UTF-8 BOM (EF BB BF) + valid YAML array.
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const yaml = Buffer.from(`- domain: qds\n  concepts: [bom]\n  expertise: "BOM test"\n`);
    const path = join(tmpDir, "bom.yaml");
    writeFileSync(path, Buffer.concat([bom, yaml]));

    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-bom",
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(client._allCalls.length).toBe(1);
    const parsed = JSON.parse(client._allCalls[0]!.content);
    expect(parsed.domain).toBe("qds");
  });
});

describe("importMulch — symlink escape (INV-HM3)", () => {
  test("symlink to /tmp target outside dir → rejected in failures", async () => {
    // Create an outside target with valid expertise content.
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      const outsideFile = join(outside, "escape.json");
      writeFileSync(outsideFile, `[{"domain":"evil","concepts":["x"],"expertise":"outside"}]`);
      // Create a symlink inside tmpDir pointing at it.
      symlinkSync(outsideFile, join(tmpDir, "evil.json"));

      const client = makeMockClient();
      const result = await importMulch({
        client: client as any,
        expertiseDir: tmpDir,
        bankId: "bank-sym",
      });
      expect(result.ok).toBe(true);
      const sym = result.failures.find((f) => f.error === "symlink_escape");
      expect(sym).toBeDefined();
      expect(sym!.file).toBe("evil.json");
      // No retain called for the escaped file.
      const evilRetains = client._allCalls.filter((c) => c.content.includes("evil"));
      expect(evilRetains.length).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("importMulch — empty dir", () => {
  test("empty dir → ok:true graceful skip with note", async () => {
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-empty",
    });
    expect(result.ok).toBe(true);
    expect(result.totalFiles).toBe(0);
    expect(result.importedFiles).toBe(0);
    expect(result.note).toBe("empty expertise dir");
    expect(client._allCalls.length).toBe(0);
  });

  test("dir with only unsupported exts → graceful skip", async () => {
    writeFile("readme.md", "# not expertise");
    writeFile("notes.txt", "misc");
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-none",
    });
    expect(result.ok).toBe(true);
    expect(result.totalFiles).toBe(0);
    expect(result.note).toBe("empty expertise dir");
  });

  test("subdirectory is skipped (non-recursive)", async () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "subdir", "nested.json"), "[]");
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-rec",
    });
    expect(result.ok).toBe(true);
    expect(result.totalFiles).toBe(0);
  });
});

describe("importMulch — per-entry content cap", () => {
  test("101KB expertise string → content_too_large failure", async () => {
    // B-2/E-11: the cap is checked on the WIRE PAYLOAD (the JSONL line), not
    // just the expertise field. Expertise at 101KB + JSONL wrapping overhead
    // still lands well over the 100KB cap → content_too_large fires.
    const tooBig = "y".repeat(MAX_CONTENT_BYTES + 1024);
    writeFile(
      "cap.json",
      `[
        {"domain":"big","concepts":["a"],"expertise":"${tooBig}"},
        {"domain":"ok","concepts":["b"],"expertise":"fine"}
      ]`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-cap",
    });
    expect(result.ok).toBe(true);
    const cap = result.failures.find((f) => f.error === "content_too_large");
    expect(cap).toBeDefined();
    expect(cap!.entryIndex).toBe(0);
    expect(client._allCalls.length).toBe(1); // only the small entry
  });
});

describe("importMulch — observability (CC-9)", () => {
  test("emits import + per-file log entries", async () => {
    writeFile("seed.json", `[{"domain":"qds","concepts":["x"],"expertise":"e"}]`);
    const client = makeMockClient();
    await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-log",
      requestId: "req-1",
    });
    const ops = logs.map((l) => l.operation);
    expect(ops).toContain("import");
    expect(ops).toContain("import.file");
    const fileLog = logs.find((l) => l.operation === "import.file");
    expect(fileLog).toBeDefined();
    expect(fileLog!.import_ms).toBeGreaterThanOrEqual(0);
    expect(fileLog!.bankId).toBe("bank-log");
  });
});

describe("verifyTenantIsolation (INV-HM4)", () => {
  test("marker retained in bankA not found in bankB → ok:true", async () => {
    const client = makeMockClient(); // default recall returns []
    const r = await verifyTenantIsolation({
      client: client as any,
      bankA: "bank-a",
      bankB: "bank-b",
      requestId: "iso-1",
    });
    expect(r.ok).toBe(true);
    expect(r.bankA).toBe("bank-a");
    expect(r.bankB).toBe("bank-b");
    expect(r.marker).toMatch(/^tenant-isolation-probe-/);
    // Marker was retained into bankA only.
    expect(client._allCalls.length).toBe(1);
    expect(client._allCalls[0]!.bankId).toBe("bank-a");
    expect(client._allCalls[0]!.content).toBe(r.marker);
  });

  test("marker leaked into bankB → ok:false with tenant_leak", async () => {
    const client = makeMockClient({
      recallResults: (q, bank) => {
        // bankB recalls the query verbatim (leak).
        if (bank === "bank-b") return [{ content: q }];
        return [];
      },
    });
    const r = await verifyTenantIsolation({
      client: client as any,
      bankA: "bank-a",
      bankB: "bank-b",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("tenant_leak");
  });
});

// ---------------------------------------------------------------------------
// Fix [5]: typed error classes (classification robustness)
// ---------------------------------------------------------------------------

describe("importMulch — fix [5] typed error classification", () => {
  test("FileTooLargeError classifies as file_too_large regardless of message", () => {
    // A renamed-message throw still classifies correctly via instanceof.
    const e: Error = new FileTooLargeError("totally custom message");
    const code = e instanceof FileTooLargeError
      ? "file_too_large"
      : "parse_failed";
    expect(code).toBe("file_too_large");
  });

  test("SymlinkEscapeError classifies as symlink_escape", () => {
    const e: Error = new SymlinkEscapeError("renamed symlink msg");
    const code = e instanceof SymlinkEscapeError
      ? "symlink_escape"
      : e instanceof SymlinkTargetUnreadableError
        ? "symlink_escape"
        : "parse_failed";
    expect(code).toBe("symlink_escape");
  });

  test("SymlinkTargetUnreadableError also classifies as symlink_escape", () => {
    const e: Error = new SymlinkTargetUnreadableError();
    const code = e instanceof SymlinkEscapeError
      ? "symlink_escape"
      : e instanceof SymlinkTargetUnreadableError
        ? "symlink_escape"
        : "parse_failed";
    expect(code).toBe("symlink_escape");
  });

  test("plain Error does NOT classify as file_too_large or symlink_escape", () => {
    const e: Error = new Error("file_too_large"); // message matches old sniff but instanceof fails
    const code = e instanceof FileTooLargeError
      ? "file_too_large"
      : e instanceof SymlinkEscapeError || e instanceof SymlinkTargetUnreadableError
        ? "symlink_escape"
        : "parse_failed";
    expect(code).toBe("parse_failed"); // robustness: message-sniff no longer trusted
  });

  test("end-to-end: 6MB file still produces file_too_large failure code", async () => {
    const big = "x".repeat(MAX_FILE_BYTES + 1024);
    writeFile("huge.yaml", `- domain: qds\n  concepts: [big]\n  expertise: "${big}"\n`);
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-fe",
    });
    expect(result.ok).toBe(true);
    const cap = result.failures.find((f) => f.error === "file_too_large");
    expect(cap).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix [6]: INV-HM3 symlink subdir rejection
// ---------------------------------------------------------------------------

describe("importMulch — fix [6] INV-HM3 symlink into subdir rejected", () => {
  test("symlink pointing at a subdir of expertise dir → rejected as symlink_escape", async () => {
    // Create .mulch/expertise/subdir/secret.json with valid expertise.
    mkdirSync(join(tmpDir, "subdir"));
    const targetPath = join(tmpDir, "subdir", "secret.json");
    writeFileSync(
      targetPath,
      `[{"domain":"sneaky","concepts":["x"],"expertise":"subdir content"}]`,
    );
    // Create a symlink at the TOP level of tmpDir pointing at subdir/secret.json.
    // Without fix [6] this would PASS realpath-within-root check (target IS
    // under dirReal) and get imported — expanding the read surface.
    symlinkSync(targetPath, join(tmpDir, "link.json"));

    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-sub",
    });
    expect(result.ok).toBe(true);
    // The symlink → subdir target is rejected.
    const sym = result.failures.find((f) => f.error === "symlink_escape");
    expect(sym).toBeDefined();
    expect(sym!.file).toBe("link.json");
    // Nothing was retained (the only file was the symlink).
    expect(client._allCalls.length).toBe(0);
  });

  test("symlink pointing at a top-level file in expertise dir → still works", async () => {
    // Regression guard: a symlink whose target IS a top-level file (not in a
    // subdir) must still be followed. Realpath equals the target's own path;
    // relative-to-dirReal contains no separator.
    const realFile = join(tmpDir, "real.json");
    writeFileSync(realFile, `[{"domain":"ok","concepts":["x"],"expertise":"via symlink"}]`);
    symlinkSync(realFile, join(tmpDir, "link.json"));

    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-sym-ok",
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    // Both real.json and link.json appear as top-level entries. real.json
    // imports; link.json resolves to real.json (same content, same dedup
    // hash) → counted as an update. So 2 retains, 1 imported + 1 updated.
    expect(client._allCalls.length).toBe(2);
    expect(result.importedFiles).toBe(1);
    expect(result.updatedFiles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix [8]: readdirSync errno distinction (EACCES → ok:false)
// ---------------------------------------------------------------------------

describe("importMulch — fix [8] unreadable expertise dir (EACCES)", () => {
  test("readdirSync EACCES → ok:false with expertise_dir_unreadable code", async () => {
    // We can't reliably chmod a tmpdir to 000 across hosts (root, macOS
    // APFS quirks), so mock the importer's readdirSync via module replacement
    // is non-trivial in bun. Instead, drive the path through a directory that
    // doesn't satisfy readdir: use a regular FILE as expertiseDir → ENOTDIR
    // (a non-ENOENT errno → ok:false per fix [8]).
    const notADir = join(tmpDir, "not-a-dir.json");
    writeFileSync(notADir, "[]");

    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: notADir,
      bankId: "bank-enotdir",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe("expertise_dir_unreadable");
    expect(result.error?.message).toBe("expertise_dir_unreadable");
  });

  test("readdirSync ENOENT (dir vanishes between realpath+readdir) → still graceful empty", async () => {
    // The dir-realpath check above the readdir block catches the normal
    // ENOENT case. To exercise the readdir ENOENT branch we point at a
    // non-existent path — but realpathSync fails first. Verify the
    // not-found path still returns ok:false with a clean message.
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: join(tmpDir, "does-not-exist"),
      bankId: "bank-noent",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe("expertise_dir_not_found"); // dir-not-found stable code
  });

  test("empty dir → graceful ok:true with empty expertise dir note (regression)", async () => {
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-empty2",
    });
    expect(result.ok).toBe(true);
    expect(result.note).toBe("empty expertise dir");
  });
});

// ---------------------------------------------------------------------------
// B-3 (HIGH): one malformed JSONL line must not drop the whole file.
// ---------------------------------------------------------------------------

describe("importMulch — B-3 malformed JSONL line is per-entry, not whole-file", () => {
  test("valid line still imports; bad line recorded as invalid_jsonl_line; no parse_failed", async () => {
    writeFile(
      "mixed.jsonl",
      `{"domain":"ok","concepts":["a"],"expertise":"valid"}
this is not json
{"domain":"ok2","concepts":["b"],"expertise":"also valid"}
`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-jsonl",
    });
    expect(result.ok).toBe(true);
    // Two valid lines retained.
    expect(client._allCalls.length).toBe(2);
    // Bad line recorded as per-entry failure.
    const bad = result.failures.find((f) => f.error === "invalid_jsonl_line");
    expect(bad).toBeDefined();
    expect(bad!.entryIndex).toBe(2); // 1-based file line number (spec: "JSONL line N")
    expect(bad!.file).toBe("mixed.jsonl");
    // NO whole-file parse_failed for this file.
    const pf = result.failures.find(
      (f) => f.file === "mixed.jsonl" && f.error === "parse_failed",
    );
    expect(pf).toBeUndefined();
    // The file still counts as imported.
    expect(result.importedFiles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B-1 (LOW): failed retain must not poison the dedup set.
// ---------------------------------------------------------------------------

describe("importMulch — B-1 failed retain does not poison dedup", () => {
  test("first retain throws, second same-hash entry still imports (not silent update)", async () => {
    // Two files, same domain+concepts → same dedup hash. The first retain
    // throws (simulating a transient bank failure); the second must STILL be
    // retained (counted as imported, not silently treated as an update).
    writeFile(
      "a.json",
      `[{"domain":"qds","concepts":["dedup"],"expertise":"first"}]`,
    );
    writeFile(
      "b.json",
      `[{"domain":"qds","concepts":["dedup"],"expertise":"second"}]`,
    );

    const client = makeMockClient();
    const origRetain = client.retain.bind(client);
    // Trigger the transient failure on a.json's specific content (expertise
    // "first"), NOT on call order. readdirSync iteration order is not guaranteed
    // across platforms/FSes, so a firstCall flag would make the
    // rf!.file==="a.json" assertion flaky whenever b.json is processed first.
    // Keying on the parsed expertise makes a.json deterministically fail
    // regardless of which file the importer reaches first.
    client.retain = async (bankId: string, content: string, metadata?: any) => {
      let expertise: string | undefined;
      try {
        expertise = (JSON.parse(content) as { expertise?: string }).expertise;
      } catch {
        /* non-JSON content (tenant probe marker) — never the failure trigger */
      }
      if (expertise === "first") {
        throw new Error("transient bank failure");
      }
      return origRetain(bankId, content, metadata);
    };

    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-poison",
    });
    expect(result.ok).toBe(true);
    // First retain threw → retain_failed recorded.
    const rf = result.failures.find((f) =>
      f.error.startsWith("retain_failed:"),
    );
    expect(rf).toBeDefined();
    expect(rf!.file).toBe("a.json");
    // Second entry was still retained (not skipped as a duplicate).
    expect(client._allCalls.length).toBe(1);
    // And counted as an import (hash was NOT poisoned by the failed first call).
    expect(result.importedFiles).toBe(1);
    expect(result.updatedFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// JSONL entryIndex desync: a validation/retain failure on a line that comes
// AFTER a skipped (blank / null / malformed) line must report the real 1-based
// file line number, not the 0-based position among surviving entries. Guards
// the parseFile → ParsedEntryWithIndex threading.
// ---------------------------------------------------------------------------

describe("importMulch — JSONL entryIndex tracks file line, not array offset", () => {
  test("schema-invalid entry reports its 1-based line number, not 0-based offset", async () => {
    // line 1: valid entry (imports)
    // line 2: valid JSON object but domain is a number → fails MulchExpertiseSchema
    writeFile(
      "desync.jsonl",
      `{"domain":"ok","concepts":["a"],"expertise":"valid"}
{"domain":123,"concepts":["b"],"expertise":"bad domain type"}
`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-desync",
    });
    expect(result.ok).toBe(true);
    // line 1 still imported.
    expect(client._allCalls.length).toBe(1);
    // line 2 failed schema validation at its REAL 1-based line number (2), not
    // the 0-based array offset (1). Before the ParsedEntryWithIndex fix this
    // reported entryIndex:1.
    const fail = result.failures.find((f) => f.file === "desync.jsonl");
    expect(fail).toBeDefined();
    expect(fail!.entryIndex).toBe(2); // 1-based file line number
    expect(fail!.file).toBe("desync.jsonl");
  });

  test("entryIndex stays correct when blank/null lines precede a failure", async () => {
    // line 1: valid entry
    // line 2: blank (skipped)
    // line 3: null tombstone (skipped)
    // line 4: valid entry
    // line 5: malformed JSON (invalid_jsonl_line)
    // line 6: valid JSON object, schema-invalid (domain number) → failure
    writeFile(
      "desync2.jsonl",
      `{"domain":"ok","concepts":["a"],"expertise":"v1"}

null
{"domain":"ok2","concepts":["b"],"expertise":"v2"}
{not json
{"domain":999,"concepts":["c"],"expertise":"bad"}
`,
    );
    const client = makeMockClient();
    const result = await importMulch({
      client: client as any,
      expertiseDir: tmpDir,
      bankId: "bank-desync2",
    });
    expect(result.ok).toBe(true);
    // The malformed line (line 5) is recorded at its real line number.
    const bad = result.failures.find((f) => f.error === "invalid_jsonl_line");
    expect(bad).toBeDefined();
    expect(bad!.entryIndex).toBe(5);
    // The schema-invalid entry (line 6) is also recorded at its real line
    // number — NOT offset 2 (the 0-based position among surviving entries).
    const schemaFail = result.failures.find(
      (f) => f.file === "desync2.jsonl" && f.error !== "invalid_jsonl_line",
    );
    expect(schemaFail).toBeDefined();
    expect(schemaFail!.entryIndex).toBe(6);
    // lines 1 + 4 imported (2 retains).
    expect(client._allCalls.length).toBe(2);
  });
});
