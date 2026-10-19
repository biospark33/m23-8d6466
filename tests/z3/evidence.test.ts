/**
 * Z3 evidence writer — fixture tier: the writer owns the swarmclawForkRev
 * stamp (refused at any depth from the caller), scrubs secrets before the
 * bytes land (and fails the write when a shape survives), names files in the
 * openrig-sc2 house style, and never overwrites ('wx').
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { credentialHits, scrubText, writeZ3Evidence, Z3_LEG_ORIGIN, type EvidenceSink } from "../../scripts/z3/evidence.ts";

const REV = "0123456789abcdef0123456789abcdef01234567";
const FIXED = new Date("2026-10-19T12:34:56.789Z");

let dir: string;
let sink: EvidenceSink;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "z3-evidence-"));
  sink = { outDir: dir, forkRev: REV, registry: new Map(), now: () => FIXED };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = { exitCode: 0, stdoutTail: "", stderrTail: "", observability: ['{"event":"z3-leg"}'] };

describe("writeZ3Evidence", () => {
  test("names the file <ISO with :. → ->-z3-<leg>.json and stamps leg/origin/writtenAt/rev itself", () => {
    const p = writeZ3Evidence(sink, "trigger", { ...base, protocolRunId: "p1" });
    expect(basename(p)).toBe("2026-10-19T12-34-56-789Z-z3-trigger.json");
    const json = JSON.parse(readFileSync(p, "utf8"));
    expect(json).toMatchObject({
      leg: "trigger",
      origin: Z3_LEG_ORIGIN.trigger,
      writtenAt: FIXED.toISOString(),
      swarmclawForkRev: REV,
      protocolRunId: "p1",
    });
  });

  test("registers the exact on-disk bytes' sha256 under the file name", () => {
    const p = writeZ3Evidence(sink, "approve", base);
    const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
    expect(sink.registry.get(basename(p))).toBe(sha);
  });

  test("refuses a caller-supplied swarmclawForkRev, top-level or nested", () => {
    expect(() => writeZ3Evidence(sink, "trigger", { ...base, swarmclawForkRev: "x" })).toThrow(/owns the stamp/);
    expect(() => writeZ3Evidence(sink, "trigger", { ...base, deep: [{ a: { swarmclawForkRev: "x" } }] })).toThrow(
      /owns the stamp/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses caller-supplied writer-owned fields and non-plain payloads", () => {
    expect(() => writeZ3Evidence(sink, "trigger", { ...base, origin: "hand" })).toThrow(/writer-owned/);
    expect(() => writeZ3Evidence(sink, "trigger", { ...base, writtenAt: "then" })).toThrow(/writer-owned/);
    expect(() => writeZ3Evidence(sink, "trigger", [] as unknown as Record<string, unknown>)).toThrow(/plain object/);
  });

  test("refuses a payload missing the required leg fields", () => {
    expect(() => writeZ3Evidence(sink, "trigger", { stdoutTail: "", stderrTail: "", observability: ["x"] })).toThrow(/exitCode/);
    expect(() => writeZ3Evidence(sink, "trigger", { ...base, observability: [] })).toThrow(/observability/);
  });

  test("refuses an unset fork rev (a round that cannot name its rev cannot trigger a bump)", () => {
    expect(() => writeZ3Evidence({ ...sink, forkRev: "UNSET" }, "trigger", base)).toThrow(/fork rev/);
  });

  test("'wx': a same-millisecond same-leg write fails loud instead of overwriting", () => {
    writeZ3Evidence(sink, "trigger", base);
    expect(() => writeZ3Evidence(sink, "trigger", base)).toThrow(/collision/);
  });

  test("scrubs every credential shape before the bytes land", () => {
    const p = writeZ3Evidence(sink, "approve", {
      ...base,
      stdoutTail: "key sk-or-v1-abcdef0123456789 tok z3tok-deadbeefcafe",
      stderrTail: "git https://user:ghp_secretvalue@github.com/x.git Authorization: Bearer abcdefghijklmnop",
      nested: { "mgat.eyJ0b2tlbklkIjoibWdhdC0xIn0.c2lnbmF0dXJl": "mgrun-QUJDREVGR0hJSktM" },
    });
    const text = readFileSync(p, "utf8");
    expect(credentialHits(text)).toEqual([]);
    expect(text).not.toContain("sk-or-v1");
    expect(text).not.toContain("z3tok-dead");
    expect(text).not.toContain("ghp_secretvalue");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("mgrun-QUJD");
    expect(text).not.toContain("eyJ0b2tlbklkIjoibWdhdC0xIn0");
  });

  test("env-carried secret values (no recognizable shape) are scrubbed by value", () => {
    const s = { ...sink, knownSecrets: ["literal-provisioning-value"] };
    const p = writeZ3Evidence(s, "approve", { ...base, stdoutTail: "x literal-provisioning-value y" });
    expect(readFileSync(p, "utf8")).not.toContain("literal-provisioning-value");
  });

  test("scrub failure fails the write: a key prefix the scrub cannot match is refused, nothing lands", () => {
    // `sk-or-` cut by a newline: the scrub needs a key body to match, the
    // post-scrub check flags the bare prefix — the write must refuse.
    expect(() => writeZ3Evidence(sink, "approve", { ...base, stdoutTail: "truncated sk-or-\n" })).toThrow(/scrub/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("scrubText / credentialHits", () => {
  test("a known secret value is replaced whole even when it starts with a shape prefix", () => {
    const secret = "sk-or-v1-abc.def~tail";
    const out = scrubText(`x ${secret} y`, [secret]);
    expect(out).toBe("x [REDACTED-ENV] y");
    expect(credentialHits(out, [secret])).toEqual([]);
  });

  test("credentialHits names patterns, never the matched bytes", () => {
    const hits = credentialHits("sk-or-v1-zzzzzzzzzzzz and https://a:b@host/");
    expect(hits.length).toBe(2);
    expect(hits.join(" ")).not.toContain("zzzz");
  });

  test("every GitHub token family is scrubbed and detected (ghp_/gho_/ghu_/ghs_/ghr_)", () => {
    for (const p of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const tok = `${p}_${"A1b2C3d4".repeat(4)}`;
      expect(scrubText(`git: ${tok}`)).not.toContain(tok);
      expect(credentialHits(tok).length).toBe(1);
    }
  });

  test("the agent token id (mgat-<hex>) is an identifier, not a credential — it survives", () => {
    expect(scrubText("agentTokenId=mgat-0123456789abcdef01234567")).toContain("mgat-0123456789abcdef01234567");
    expect(credentialHits("mgat-0123456789abcdef01234567")).toEqual([]);
  });
});
