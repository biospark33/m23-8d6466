/**
 * L9 repo-sweep triage — functional suite (J4). Deleted together with the
 * module at the flex-cut. Mock client only; tmp provenance + corpus dirs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_MAX_CHARS,
  L9_EGRESS_CLASS,
  L9_QUESTIONS,
  MAX_HOTSPOTS_PER_CALL,
  lockedVersion,
  makeSweepTriageRanker,
  opensrcSpans,
  type SweepHotspot,
} from "../../src/autonomy/l9-repo-sweep-triage.ts";
import { CeilingExceededError, EgressRefusedError, JudgmentCeiling, JudgmentClient } from "../../src/judgment/index.ts";
import type { LogEntry } from "../../src/lib/log.ts";

let tmp: string;
let logs: LogEntry[];
const sink = (e: LogEntry) => void logs.push(e);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "l9-"));
  logs = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const prov = () => join(tmp, "prov");
const corpus = () => join(tmp, "corpus");
const hs: SweepHotspot[] = [
  { path: "src/b.ts", brief: "b brief", score: 5 },
  { path: "src/a.ts", brief: "a brief", score: 5 },
  { path: "src/c.ts", brief: "c brief", score: 9 },
];
const mockClient = () => new JudgmentClient({ provenanceDir: prov() });
const records = () => readFileSync(join(corpus(), "x-rx.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const triageLines = () => logs.filter((l) => l.event === "l9-triage");

describe("makeSweepTriageRanker", () => {
  test("returns the deterministic order (score desc, path asc), whatever the answers", async () => {
    const r = makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink });
    expect((await r.rank(hs)).map((h) => h.path)).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);
    // answers that would reorder (noul 0 for c) still change nothing
    const low: SweepHotspot[] = [{ path: "z", brief: "z", score: 1 }, { path: "y", brief: "y", score: 2 }];
    expect((await makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink }).rank(low)).map((h) => h.path)).toEqual(["y", "z"]);
  });

  test("one record + one provenance file + one log line per hotspot, ac-prose declared", async () => {
    const r = makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink });
    await r.rank(hs);
    const recs = records();
    expect(recs).toHaveLength(3);
    for (const rec of recs) {
      expect(rec.diff_context_ref).toBe(`sweep:${rec.finding_id.slice("sweep:".length)}`);
      expect(rec.arm).toBe("jev");
      expect(["PATCH", "DEFER", "DISMISS"]).toContain(rec.disposition);
    }
    expect(recs.find((x) => x.finding_id === "sweep:src/a.ts").finding_text).toBe("a brief");
    const files = readdirSync(prov());
    expect(files).toHaveLength(3);
    for (const f of files) {
      expect(readFileSync(join(prov(), f), "utf8")).toContain(L9_EGRESS_CLASS);
    }
    const lines = triageLines();
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).toMatchObject({ event: "l9-triage", leg: "l9", egress_class: "ac-prose", armed: false });
      expect(l.answer).toBeDefined();
      expect(typeof l.latency_ms).toBe("number");
      expect(typeof l.requestId).toBe("string");
    }
    expect(logs.some((l) => l.event === "l9-triage-order" && l.armed === false)).toBe(true);
  });

  test("envelope egress class is ac-prose", async () => {
    const seen: string[] = [];
    const client = mockClient();
    const spy = { judge: async (...a: Parameters<JudgmentClient["judge"]>) => { const e = await client.judge(...a); seen.push(e.egress_class); return e; } };
    await makeSweepTriageRanker({ client: spy, corpusDir: corpus(), log: sink }).rank(hs);
    expect(seen).toEqual(["ac-prose", "ac-prose", "ac-prose"]);
  });

  test("questions are noul + choice only — never score", () => {
    const types = new Set(Object.values(L9_QUESTIONS).map((q) => q.type));
    expect([...types].every((t) => t === "noul" || t === "choice")).toBe(true);
    expect(types.has("score" as never)).toBe(false);
  });

  test("brief is length-capped before egress", async () => {
    const sent: unknown[] = [];
    const client = mockClient();
    const spy = { judge: async (s: Parameters<JudgmentClient["judge"]>[0], ...rest: [Parameters<JudgmentClient["judge"]>[1], Parameters<JudgmentClient["judge"]>[2]]) => { sent.push(s); return client.judge(s, ...rest); } };
    await makeSweepTriageRanker({ client: spy, corpusDir: corpus(), log: sink }).rank([{ path: "p", brief: "x".repeat(BRIEF_MAX_CHARS * 3), score: 1 }]);
    expect((sent[0] as { brief: string }).brief).toHaveLength(BRIEF_MAX_CHARS);
  });

  test("egress refusal is a recorded miss: no throw, no record, order intact", async () => {
    const client = { judge: async () => { throw new EgressRefusedError("diff-hunk refused", "diff-hunk"); } };
    const out = await makeSweepTriageRanker({ client, corpusDir: corpus(), log: sink }).rank(hs);
    expect(out).toHaveLength(3);
    const misses = triageLines().filter((l) => l.miss);
    expect(misses).toHaveLength(3);
    expect(misses.every((l) => l.miss === "egress-refused" && l.egress_class === "ac-prose" && l.answer === undefined)).toBe(true);
    expect(() => records()).toThrow(); // nothing written
  });

  test("ceiling exhaustion is a recorded miss and stops further asks", async () => {
    let calls = 0;
    const client = { judge: async () => { calls++; throw new CeilingExceededError(10, 5); } };
    await makeSweepTriageRanker({ client, corpusDir: corpus(), log: sink }).rank(hs);
    expect(calls).toBe(1);
    expect(triageLines().map((l) => l.miss)).toEqual(["ceiling-exceeded", "ceiling-exhausted", "ceiling-exhausted"]);
  });

  test("a real exhausted JudgmentCeiling stops after the crossing call", async () => {
    const ceiling = new JudgmentCeiling(5);
    await makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), ceiling, log: sink }).rank(hs);
    expect(records()).toHaveLength(1); // mock usage 10 tokens > 5 => next admit refuses
    expect(triageLines().filter((l) => l.miss).length).toBe(2);
  });

  test("generic judge failure is a miss, not a throw", async () => {
    const client = { judge: async () => { throw new Error("boom"); } };
    const out = await makeSweepTriageRanker({ client, corpusDir: corpus(), log: sink }).rank(hs);
    expect(out).toHaveLength(3);
    expect(triageLines().every((l) => l.miss === "judge-failed")).toBe(true);
  });

  test("per-call hotspot cap", async () => {
    const many = Array.from({ length: MAX_HOTSPOTS_PER_CALL + 3 }, (_, i) => ({ path: `f${String(i).padStart(3, "0")}`, brief: "b", score: 1 }));
    const out = await makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink }).rank(many);
    expect(out).toHaveLength(many.length);
    expect(records()).toHaveLength(MAX_HOTSPOTS_PER_CALL);
    expect(triageLines().filter((l) => l.miss === "capped")).toHaveLength(3);
  });
});

describe("opensrcSpans", () => {
  const lock = `{
  "lockfileVersion": 1,
  "packages": {
    "zod": ["zod@3.25.76", "", {}, "sha512-x"],
    "@scope/pkg": ["@scope/pkg@1.2.3", "", { "dependencies": { "zod": "^3", }, }, "sha512-y"],
    "ws-pkg": ["ws-pkg@workspace:ws-pkg"],
    "parent/zod": ["zod@2.0.0", "", {}, "sha512-z"],
  },
}
`;
  const lockfilePath = () => join(tmp, "bun.lock");
  const files = [{ rel: "index.js", bytes: 10 }, { rel: "lib/big.ts", bytes: 99 }, { rel: "bad name.js", bytes: 500 }];

  test("lockedVersion picks the hoisted locked version, rejects workspace/unknown", () => {
    expect(lockedVersion(lock, "zod")).toBe("3.25.76");
    expect(lockedVersion(lock, "@scope/pkg")).toBe("1.2.3");
    expect(lockedVersion(lock, "ws-pkg")).toBeUndefined();
    expect(lockedVersion(lock, "nope")).toBeUndefined();
  });

  test("resolves the locked version and execs opensrc path pkg@version", () => {
    writeFileSync(lockfilePath(), lock);
    const calls: [string, readonly string[]][] = [];
    const r = opensrcSpans("zod", {
      lockfilePath: lockfilePath(), cache: new Map(), log: sink,
      exec: (c, a) => { calls.push([c, a]); return { exitCode: 0, stdout: "/cache/zod\n" }; },
      listFiles: () => files,
    });
    expect(calls).toEqual([["opensrc", ["path", "zod@3.25.76"]]]);
    expect(r.ok && r.version).toBe("3.25.76");
    if (!r.ok) throw new Error("unreachable");
    // unsafe filename dropped; metadata-only briefs, no source text
    expect(r.spans.map((s) => s.path)).toEqual(["zod@3.25.76/lib/big.ts", "zod@3.25.76/index.js"]);
    expect(r.spans[0]!.brief).toBe("dependency source span lib/big.ts of zod@3.25.76 (99 bytes)");
  });

  test("cache hit: exec called once for two lookups", () => {
    writeFileSync(lockfilePath(), lock);
    let n = 0;
    const deps = { lockfilePath: lockfilePath(), cache: new Map(), log: sink, exec: () => { n++; return { exitCode: 0, stdout: "/d" }; }, listFiles: () => files };
    const a = opensrcSpans("zod", deps);
    const b = opensrcSpans("zod", deps);
    expect(n).toBe(1);
    expect(a.ok && !a.cached).toBe(true);
    expect(b.ok && b.cached).toBe(true);
  });

  test("unknown / unlocked package, bad name: recorded miss, exec never called", () => {
    writeFileSync(lockfilePath(), lock);
    let n = 0;
    const deps = { lockfilePath: lockfilePath(), cache: new Map(), log: sink, exec: () => { n++; return { exitCode: 0, stdout: "/d" }; } };
    expect(opensrcSpans("nope", deps)).toMatchObject({ ok: false, miss: "package-not-locked" });
    expect(opensrcSpans("ws-pkg", deps)).toMatchObject({ ok: false, miss: "package-not-locked" });
    expect(opensrcSpans("--help", deps)).toMatchObject({ ok: false, miss: "invalid-package-name" });
    expect(opensrcSpans("zod", { ...deps, lockfilePath: join(tmp, "absent.lock") })).toMatchObject({ ok: false, miss: "lockfile-unreadable" });
    expect(n).toBe(0);
    expect(logs.filter((l) => l.miss).length).toBe(4);
    expect(logs.every((l) => l.egress_class === "ac-prose" && l.armed === false)).toBe(true);
  });

  test("missing binary and non-zero exit are recorded misses, never cached", () => {
    writeFileSync(lockfilePath(), lock);
    const cache = new Map();
    const base = { lockfilePath: lockfilePath(), cache, log: sink };
    expect(opensrcSpans("zod", { ...base, exec: () => { throw Object.assign(new Error("spawn opensrc ENOENT"), { code: "ENOENT" }); } })).toMatchObject({ ok: false, miss: "opensrc-unavailable" });
    expect(opensrcSpans("zod", { ...base, exec: () => ({ exitCode: 1, stdout: "" }) })).toMatchObject({ ok: false, miss: "opensrc-nonzero-exit" });
    expect(opensrcSpans("zod", { ...base, exec: () => ({ exitCode: null, stdout: "" }) })).toMatchObject({ ok: false, miss: "opensrc-nonzero-exit" });
    expect(cache.size).toBe(0);
  });

  test("spans feed the same ranker (ac-prose) and stay deterministic", async () => {
    writeFileSync(lockfilePath(), lock);
    const r = opensrcSpans("zod", { lockfilePath: lockfilePath(), cache: new Map(), log: sink, exec: () => ({ exitCode: 0, stdout: "/d" }), listFiles: () => files });
    if (!r.ok) throw new Error("unreachable");
    const ranked = await makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink }).rank(r.spans);
    expect(ranked.map((h) => h.path)).toEqual(r.spans.map((h) => h.path));
    expect(records()).toHaveLength(2);
  });
});
