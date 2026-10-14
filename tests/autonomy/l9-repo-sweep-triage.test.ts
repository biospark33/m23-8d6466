/**
 * L9 repo-sweep triage — functional suite (J4). Deleted together with the
 * module at the flex-cut. Mock client only; tmp provenance + corpus dirs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BRIEF_MAX_CHARS,
  L9_MOCK_CORPUS_DIR,
  resolveTriageCorpusDir,
  resolveProvenanceDir,
  MAX_WALK_ENTRIES,
  PATH_MAX_CHARS,
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
      expect(rec.finding_id).toMatch(new RegExp(`^${rec.diff_context_ref}@[0-9a-f]{8}$`));
      expect(rec.arm).toBe("jev");
      expect(["PATCH", "DEFER", "DISMISS"]).toContain(rec.disposition);
    }
    expect(recs.find((x) => x.diff_context_ref === "sweep:src/a.ts").finding_text).toBe("a brief");
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
    const spy = { mode: "mock" as const, judge: async (...a: Parameters<JudgmentClient["judge"]>) => { const e = await client.judge(...a); seen.push(e.egress_class); return e; } };
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
    const spy = { mode: "mock" as const, judge: async (s: Parameters<JudgmentClient["judge"]>[0], ...rest: [Parameters<JudgmentClient["judge"]>[1], Parameters<JudgmentClient["judge"]>[2]]) => { sent.push(s); return client.judge(s, ...rest); } };
    await makeSweepTriageRanker({ client: spy, corpusDir: corpus(), log: sink }).rank([{ path: "p", brief: "x".repeat(BRIEF_MAX_CHARS * 3), score: 1 }]);
    expect((sent[0] as { brief: string }).brief).toHaveLength(BRIEF_MAX_CHARS);
  });

  test("egress refusal is a recorded miss: no throw, no record, order intact", async () => {
    const client = { mode: "mock" as const, judge: async () => { throw new EgressRefusedError("diff-hunk refused", "diff-hunk"); } };
    const out = await makeSweepTriageRanker({ client, corpusDir: corpus(), log: sink }).rank(hs);
    expect(out).toHaveLength(3);
    const misses = triageLines().filter((l) => l.miss);
    expect(misses).toHaveLength(3);
    expect(misses.every((l) => l.miss === "egress-refused" && l.egress_class === "ac-prose" && l.answer === undefined)).toBe(true);
    expect(() => records()).toThrow(); // nothing written
  });

  test("ceiling exhaustion is a recorded miss and stops further asks", async () => {
    let calls = 0;
    const client = { mode: "mock" as const, judge: async () => { calls++; throw new CeilingExceededError(10, 5); } };
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
    const client = { mode: "mock" as const, judge: async () => { throw new Error("boom"); } };
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

describe("L9 review fixes (round 1)", () => {
  test("R1-01: default mock writes go to the mock/ subdir, never a top-level corpus file", async () => {
    expect(L9_MOCK_CORPUS_DIR.endsWith("/mock")).toBe(true);
    const root = join(tmp, "root");
    // mock client, no corpusDir => mock dir; emulate by pointing at root/mock via the exported rule
    const r = makeSweepTriageRanker({ client: mockClient(), corpusDir: join(root, "mock"), log: sink });
    await r.rank(hs);
    const top = existsSync(root) ? readdirSync(root).filter((f) => f.endsWith(".jsonl")) : [];
    expect(top).toEqual([]);
    expect(readdirSync(join(root, "mock")).some((f) => f.endsWith(".jsonl"))).toBe(true);
  });

  test("R1-01: with no corpusDir a mock client resolves under the mock/ subdir (pure; writes nothing)", () => {
    const mockDir = resolveTriageCorpusDir({ mode: "mock" });
    const liveDir = resolveTriageCorpusDir({ mode: "live" });
    expect(mockDir.endsWith(join("judgment", "corpus", "mock"))).toBe(true);
    expect(liveDir.endsWith(join("judgment", "corpus"))).toBe(true);
    expect(dirname(mockDir)).toBe(liveDir); // mock is a SUBDIR: ab-report reads only top-level *.jsonl
    expect(resolveTriageCorpusDir({ mode: "mock" }, "/x/injected")).toBe("/x/injected");
  });

  test("R1-13: second rank() over the same hotspots asks nothing; changed brief is re-asked", async () => {
    let asks = 0;
    const c = mockClient();
    const spy = { mode: "mock" as const, judge: async (...a: Parameters<JudgmentClient["judge"]>) => { asks++; return c.judge(...a); } };
    const r = makeSweepTriageRanker({ client: spy, corpusDir: corpus(), log: sink });
    await r.rank(hs);
    expect(asks).toBe(3);
    logs = [];
    await r.rank(hs);
    expect(asks).toBe(3);
    expect(triageLines().filter((l) => l.miss === "already-recorded")).toHaveLength(3);
    expect(records()).toHaveLength(3);
    await r.rank([{ path: "src/a.ts", brief: "a CHANGED", score: 5 }]);
    expect(asks).toBe(4);
    expect(records()).toHaveLength(4);
  });

  test("R1-20: long paths sharing a prefix get distinct ids", async () => {
    const pre = "p/".repeat(PATH_MAX_CHARS);
    await makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink }).rank([
      { path: `${pre}one.ts`, brief: "same", score: 1 },
      { path: `${pre}two.ts`, brief: "same", score: 1 },
    ]);
    const ids = records().map((x) => x.finding_id);
    expect(new Set(ids).size).toBe(2);
  });

  test("R1-20: non-finite scores are recorded misses; order is total and deterministic", async () => {
    let asks = 0;
    const c = mockClient();
    const spy = { mode: "mock" as const, judge: async (...a: Parameters<JudgmentClient["judge"]>) => { asks++; return c.judge(...a); } };
    const mixed: SweepHotspot[] = [
      { path: "n", brief: "n", score: Number.NaN },
      { path: "ok", brief: "ok", score: 1 },
      { path: "i", brief: "i", score: Number.POSITIVE_INFINITY },
      { path: "m", brief: "m", score: Number.NEGATIVE_INFINITY },
    ];
    const out = await makeSweepTriageRanker({ client: spy, corpusDir: corpus(), log: sink }).rank(mixed);
    expect(out.map((h) => h.path)).toEqual(["ok", "i", "m", "n"]);
    expect(asks).toBe(1);
    expect(triageLines().filter((l) => l.miss === "non-finite-score")).toHaveLength(3);
  });

  test("R1-21: default walk skips node_modules, symlinks (even broken) and does not fail", () => {
    const pkg = join(tmp, "pkg");
    mkdirSync(join(pkg, "lib"), { recursive: true });
    mkdirSync(join(pkg, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(pkg, "lib", "a.js"), "x");
    writeFileSync(join(pkg, "node_modules", "dep", "b.js"), "x");
    symlinkSync(join(tmp, "nowhere"), join(pkg, "broken.js"));
    symlinkSync(join(pkg, "lib"), join(pkg, "linkdir"));
    writeFileSync(join(tmp, "bun.lock"), `{"packages":{"zod":["zod@3.25.76","",{},"x"]}}`);
    const r = opensrcSpans("zod", { lockfilePath: join(tmp, "bun.lock"), cache: new Map(), log: sink, exec: () => ({ exitCode: 0, stdout: `${pkg}\n` }) });
    if (!r.ok) throw new Error(`unexpected miss ${r.miss}`);
    expect(r.spans.map((s) => s.path)).toEqual(["zod@3.25.76/lib/a.js"]);
  });

  test("R1-21: walk visits at most MAX_WALK_ENTRIES entries", () => {
    const pkg = join(tmp, "big");
    mkdirSync(pkg);
    for (let i = 0; i < 40; i++) writeFileSync(join(pkg, `f${i}.js`), "x");
    expect(MAX_WALK_ENTRIES).toBeGreaterThan(40); // bound is a constant; 40 files all fit
    writeFileSync(join(tmp, "bun.lock"), `{"packages":{"zod":["zod@3.25.76","",{},"x"]}}`);
    const r = opensrcSpans("zod", { lockfilePath: join(tmp, "bun.lock"), cache: new Map(), log: sink, exec: () => ({ exitCode: 0, stdout: pkg }) });
    expect(r.ok && r.spans.length).toBe(40);
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

describe("L9 review fixes (round 2, FX-E)", () => {
  test("R2-03: only explicit live selects the measured corpus; spy without mode routes to mock", async () => {
    const live = resolveTriageCorpusDir({ mode: "live" });
    expect(resolveTriageCorpusDir({})).toBe(resolveTriageCorpusDir({ mode: "mock" }));
    expect(resolveTriageCorpusDir({ mode: "typo" })).not.toBe(live);
    expect(resolveTriageCorpusDir({}).endsWith(join("corpus", "mock"))).toBe(true);
    const c = mockClient();
    const proxy = { judge: (...a: Parameters<JudgmentClient["judge"]>) => c.judge(...a) };
    expect(resolveTriageCorpusDir(proxy as { mode?: string })).toBe(resolveTriageCorpusDir({ mode: "mock" }));
    // @ts-expect-error Judge.mode is required: a wrapper that omits it does not typecheck
    makeSweepTriageRanker({ client: proxy, corpusDir: corpus(), log: sink });
  });

  test("R2-07: cap counts only asked hotspots; recorded ones stay in the would-be order", async () => {
    const many = Array.from({ length: MAX_HOTSPOTS_PER_CALL + 15 }, (_, i) => ({ path: `f${String(i).padStart(3, "0")}`, brief: "b", score: 1 }));
    const pre = many.slice(0, 10);
    await makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink }).rank(pre);
    logs = [];
    let asks = 0;
    const c = mockClient();
    const spy = { mode: "mock" as const, judge: async (...a: Parameters<JudgmentClient["judge"]>) => { asks++; return c.judge(...a); } };
    await makeSweepTriageRanker({ client: spy, corpusDir: corpus(), log: sink }).rank(many);
    expect(asks).toBe(MAX_HOTSPOTS_PER_CALL);
    expect(triageLines().filter((l) => l.miss === "already-recorded")).toHaveLength(10);
    expect(triageLines().filter((l) => l.miss === "capped")).toHaveLength(5);
    const order = logs.find((l) => l.event === "l9-triage-order");
    expect((order?.would_order as string[]).length).toBe(many.length);
  });

  test("R2-08: default provenance dir anchors to the factory root, not cwd (pure)", () => {
    const d = resolveProvenanceDir();
    expect(d.startsWith("/")).toBe(true);
    expect(d.endsWith(join("_bmad-output", "judgment", "provenance"))).toBe(true);
    expect(d).toBe(join(dirname(dirname(import.meta.dir)), "_bmad-output", "judgment", "provenance"));
    expect(resolveProvenanceDir("/x/p")).toBe("/x/p");
  });

  test("R2-18: every l9-triage log line carries answer_mode", async () => {
    await makeSweepTriageRanker({ client: mockClient(), corpusDir: corpus(), log: sink }).rank(hs);
    const all = logs.filter((l) => l.operation === "l9-triage");
    expect(all.length).toBeGreaterThan(3);
    expect(all.every((l) => l.answer_mode === "mock")).toBe(true);
    logs = [];
    const live = { mode: "live" as const, judge: async () => { throw new Error("x"); } };
    await makeSweepTriageRanker({ client: live, corpusDir: corpus(), log: sink }).rank(hs);
    expect(logs.every((l) => l.answer_mode === "live")).toBe(true);
  });
});
