/**
 * G1: ADR-2's accepted fail-closed auto-merge policy (src/fleet/auto-merge-policy.ts).
 *
 * One test per clause of the story contract, named after the clause. The
 * make-or-break is the v6a invariant (arm 5): ON is structurally unreachable
 * while the clause-5 veto-window carrier is absent from the tree. Every
 * filesystem test runs under its own mkdtemp root via the `cwd`/`policyPath`
 * opts — nothing is ever written into the repo's real `.factory/`; the ONE
 * intentional real-tree test (arm 12) is read-only.
 */
import { describe, expect, afterEach, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assertNoQaProducerInGraph,
  consultAutoMerge,
  DEFAULT_POLICY_FILE,
  evaluateDiffScope,
  evaluateNeverAutoMerge,
  evaluateTreeConsistency,
  evaluateVerdict,
  NEVER_AUTO_MERGE_PATHS,
  NEVER_AUTO_MERGE_PREFIXES,
  NO_PRODUCER_MARKER,
  OUT_OF_SCOPE_DIFF,
  POLICY_AUTO_MERGE_APPROVER_ID,
  readAdrStatus,
  readAutoMergePolicy,
  SCOPE_REQUIRES_PRIVILEGE,
} from "../../src/fleet/auto-merge-policy.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1policy-"));
  dirs.push(d);
  return d;
};

/** The everything-set clause-5 policy body. */
const POLICY_ON = { autoMergeDefault: true, adr2AcceptedOn: "2026-10-15", vetoWindowQueueLive: true };

const writePolicy = (root: string, body: unknown, mode = 0o600): string => {  fs.mkdirSync(path.join(root, ".factory"), { recursive: true });
  const p = path.join(root, ".factory", "policy.json");
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  fs.chmodSync(p, mode);
  return p;
};

/** Fabricate the clause-5 carrier INSIDE a tmp tree root: module + symbol + test. */
const fabricateCarrier = (root: string): void => {
  fs.mkdirSync(path.join(root, "src", "fleet"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "fleet", "veto-window.ts"),
    "export function enqueueVetoWindow(x: number): number { return x; }\n",
  );
  fs.mkdirSync(path.join(root, "tests", "fleet"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "fleet", "veto-window.test.ts"), "// carrier suite placeholder\n");
};

const openScope = {
  allowedPathGlobs: ["src/**"],
  deniedPathGlobs: [] as { glob: string; reason: string }[],
  permittedActions: ["modify", "add", "delete"] as ("modify" | "add" | "delete")[],
};

const CLEAN_ENTRY = { path: "src/run.ts", action: "modify" as const };
const FRESH_VERDICT = { status: "pass", producedAt: "2026-10-15T12:00:00.000Z" };

describe("readAutoMergePolicy", () => {
  test("clause: absent file ⇒ state absent", () => {
    const root = tmp();
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "absent" });
  });

  test("clause: garbled JSON ⇒ off/policy-garbled", () => {
    const root = tmp();
    writePolicy(root, "{not json");
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "policy-garbled" });
  });

  test("clause: wrong mode (0644) ⇒ off/policy-unreadable — the 0600 posture", () => {
    const root = tmp();
    writePolicy(root, POLICY_ON, 0o644);
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "policy-unreadable" });
  });

  test("clause: declared-off ⇒ off/declared-off", () => {
    const root = tmp();
    writePolicy(root, { ...POLICY_ON, autoMergeDefault: false });
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "declared-off" });
  });

  test("clause 5: ON unreachable while the carrier is absent — the v6a invariant", () => {
    // The real repo cannot hold the carrier today; state that, then prove the
    // loader agrees on a tmp root that is identical minus the carrier.
    expect(fs.existsSync(path.join(process.cwd(), "src", "fleet", "veto-window.ts"))).toBe(false);
    const root = tmp();
    writePolicy(root, POLICY_ON);
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "clause5-carrier-absent" });
  });

  test("clause 5: invalid/missing adr2AcceptedOn ⇒ clause5-carrier-absent (independent of carrier)", () => {
    const root = tmp();
    fabricateCarrier(root);
    writePolicy(root, { ...POLICY_ON, adr2AcceptedOn: "15-10-2026" });
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "clause5-carrier-absent" });

    const root2 = tmp();
    fabricateCarrier(root2);
    writePolicy(root2, { autoMergeDefault: true, vetoWindowQueueLive: true });
    expect(readAutoMergePolicy({ cwd: root2 })).toEqual({ state: "off", stateReason: "clause5-carrier-absent" });
  });

  test("clause 5: vetoWindowQueueLive not true ⇒ clause5-carrier-absent even with carrier present", () => {
    const root = tmp();
    fabricateCarrier(root);
    writePolicy(root, { autoMergeDefault: true, adr2AcceptedOn: "2026-10-15" });
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "clause5-carrier-absent" });
  });

  test("clause 5: ON reachable ONLY through a fabricated carrier tree — the probe works", () => {
    const root = tmp();
    fabricateCarrier(root);
    writePolicy(root, POLICY_ON);
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "on" });
  });
});

describe("evaluateNeverAutoMerge", () => {
  test("clause: each named path parks; the src/audit/ prefix parks; clean set does not", () => {
    for (const p of NEVER_AUTO_MERGE_PATHS) {
      expect(evaluateNeverAutoMerge([p])).toEqual({ park: true, reason: "never-path" });
    }
    expect(evaluateNeverAutoMerge(["src/audit/anything.ts"])).toEqual({ park: true, reason: "never-path" });
    for (const prefix of NEVER_AUTO_MERGE_PREFIXES) expect(prefix).toBe("src/audit/");
    expect(evaluateNeverAutoMerge(["src/run.ts", "src/fleet/other.ts"])).toEqual({ park: false });
  });
});

describe("evaluateDiffScope", () => {
  const scope = (over: Partial<typeof openScope> = {}) => ({ ...openScope, ...over });

  test("clause: deny wins ⇒ scope-requires-privilege", () => {
    const s = scope({ deniedPathGlobs: [{ glob: "src/secret/**", reason: "operator-only" }] });
    expect(
      evaluateDiffScope(
        [
          { path: "src/run.ts", action: "modify" },
          { path: "src/secret/key.ts", action: "modify" },
        ],
        s,
      ),
    ).toEqual({ park: true, reason: SCOPE_REQUIRES_PRIVILEGE });
  });

  test("clause: unmatched allow ⇒ out-of-scope-diff", () => {
    expect(evaluateDiffScope([{ path: "docs/x.md", action: "modify" }], scope())).toEqual({
      park: true,
      reason: OUT_OF_SCOPE_DIFF,
    });
  });

  test("clause: unpermitted action ⇒ out-of-scope-diff", () => {
    expect(
      evaluateDiffScope([{ path: "src/run.ts", action: "delete" }], scope({ permittedActions: ["modify", "add"] })),
    ).toEqual({ park: true, reason: OUT_OF_SCOPE_DIFF });
  });

  test("clause: in-scope clean diff passes; globs behave (* segment, ** across, ? single)", () => {
    expect(evaluateDiffScope([CLEAN_ENTRY], scope())).toEqual({ park: false });
    // `**` crosses segments.
    expect(evaluateDiffScope([{ path: "src/a/b.ts", action: "modify" }], scope())).toEqual({ park: false });
    // `*` stays within a segment: src/*.ts must NOT match src/a/b.ts.
    const star = scope({ allowedPathGlobs: ["src/*.ts"] });
    expect(evaluateDiffScope([{ path: "src/a/b.ts", action: "modify" }], star)).toEqual({
      park: true,
      reason: OUT_OF_SCOPE_DIFF,
    });
    expect(evaluateDiffScope([{ path: "src/ab.ts", action: "modify" }], star)).toEqual({ park: false });
    // `?` is exactly one non-separator character.
    const q = scope({ allowedPathGlobs: ["src/a?.ts"] });
    expect(evaluateDiffScope([{ path: "src/ab.ts", action: "modify" }], q)).toEqual({ park: false });
    expect(evaluateDiffScope([{ path: "src/abc.ts", action: "modify" }], q)).toEqual({
      park: true,
      reason: OUT_OF_SCOPE_DIFF,
    });
  });
});

describe("evaluateVerdict", () => {
  test("clause: undefined ⇒ verdict-absent", () => {
    expect(evaluateVerdict(undefined)).toEqual({ ok: false, reason: "verdict-absent" });
  });

  test("clause: producedAt before rebasedAt (or unparseable) ⇒ verdict-stale", () => {
    const rebasedAt = new Date("2026-10-15T12:00:00.000Z");
    expect(evaluateVerdict({ status: "pass", producedAt: "2026-10-15T11:00:00.000Z" }, rebasedAt)).toEqual({
      ok: false,
      reason: "verdict-stale",
    });
    expect(evaluateVerdict({ status: "pass", producedAt: "not-a-date" }, rebasedAt)).toEqual({
      ok: false,
      reason: "verdict-stale",
    });
  });

  test("clause: escalated ⇒ verdict-escalated; stale wins over escalated", () => {
    expect(evaluateVerdict({ status: "pass", producedAt: "2026-10-15T12:00:00.000Z", escalated: true })).toEqual({
      ok: false,
      reason: "verdict-escalated",
    });
    expect(
      evaluateVerdict(
        { status: "pass", producedAt: "2026-10-15T11:00:00.000Z", escalated: true },
        new Date("2026-10-15T12:00:00.000Z"),
      ),
    ).toEqual({ ok: false, reason: "verdict-stale" });
  });

  test("clause: fresh + clean ⇒ ok", () => {
    expect(evaluateVerdict(FRESH_VERDICT, new Date("2026-10-15T11:00:00.000Z"))).toEqual({ ok: true });
  });
});

describe("consultAutoMerge", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    runId: "run-1",
    diffPaths: ["src/run.ts"],
    diffEntries: [CLEAN_ENTRY],
    scope: openScope,
    ...over,
  });
  const OFF = { state: "off", stateReason: "declared-off" } as const;

  test("clause: absent policy ⇒ reasons ABSENT, no evaluation occurred", () => {
    const r = consultAutoMerge(input(), FRESH_VERDICT, { state: "absent" });
    expect(r.eligible).toBe(false);
    expect("reasons" in r).toBe(false);
  });

  test("clause: present-OFF, otherwise clean ⇒ [policy-off]", () => {
    expect(consultAutoMerge(input(), FRESH_VERDICT, OFF)).toEqual({
      runId: "run-1",
      eligible: false,
      reasons: ["policy-off"],
    });
  });

  test("clause: ON + never-path ⇒ [never-path]", () => {
    const r = consultAutoMerge(input({ diffPaths: ["src/fleet/approval-gate.ts"] }), FRESH_VERDICT, { state: "on" });
    expect(r).toEqual({ runId: "run-1", eligible: false, reasons: ["never-path"] });
  });

  test("clause: ON + everything failing ⇒ full reasons in canonical order", () => {
    const r = consultAutoMerge(
      input({
        diffPaths: ["src/fleet/approval-gate.ts"],
        diffEntries: [{ path: "src/audit/x.ts", action: "modify" }],
        scope: { ...openScope, deniedPathGlobs: [{ glob: "src/audit/**", reason: "audit hops" }] },
      }),
      undefined,
      OFF,
    );
    expect(r.reasons).toEqual(["never-path", "scope-requires-privilege", "verdict-absent", "policy-off"]);
  });

  test("clause: ON + clean ⇒ eligible true, reasons []", () => {
    expect(consultAutoMerge(input(), FRESH_VERDICT, { state: "on" })).toEqual({
      runId: "run-1",
      eligible: true,
      reasons: [],
    });
  });
});

describe("evaluateTreeConsistency", () => {
  test("clause: PROPOSED + impl ⇒ violation", () => {
    expect(evaluateTreeConsistency({ adrStatus: "PROPOSED", settingOn: false, implPresent: true })).toEqual({
      consistent: false,
      violations: ["impl-present-while-proposed"],
    });
  });

  test("clause: PROPOSED + settingOn ⇒ violation (the tree is red)", () => {
    expect(evaluateTreeConsistency({ adrStatus: "PROPOSED", settingOn: true, implPresent: false })).toEqual({
      consistent: false,
      violations: ["setting-on-while-proposed"],
    });
  });

  test("clause: PROPOSED + verdictBlockPresent + impl ⇒ violation — the trap; the block does not wave impl through", () => {
    expect(
      evaluateTreeConsistency({ adrStatus: "PROPOSED", verdictBlockPresent: true, settingOn: false, implPresent: true }),
    ).toEqual({
      consistent: false,
      violations: ["verdict-block-while-proposed", "impl-present-while-proposed"],
    });
  });

  test("clause: ACCEPTED + impl + ON ⇒ consistent either way", () => {
    expect(evaluateTreeConsistency({ adrStatus: "ACCEPTED", settingOn: true, implPresent: true })).toEqual({
      consistent: true,
      violations: [],
    });
    expect(evaluateTreeConsistency({ adrStatus: "ACCEPTED", settingOn: false, implPresent: false })).toEqual({
      consistent: true,
      violations: [],
    });
  });

  test("clause: AMENDED ⇒ consistent only with the accepted-disposition verdict block", () => {
    expect(
      evaluateTreeConsistency({ adrStatus: "AMENDED", verdictBlockPresent: true, settingOn: true, implPresent: true }),
    ).toEqual({ consistent: true, violations: [] });
    expect(
      evaluateTreeConsistency({ adrStatus: "AMENDED", settingOn: true, implPresent: true }),
    ).toEqual({
      consistent: false,
      violations: ["amended-without-accepted-verdict", "impl-present-while-amended-unaccepted", "setting-on-while-amended-unaccepted"],
    });
  });
});

describe("the real tree (read-only)", () => {
  test("clause: the repo ADR reads ACCEPTED; the gitignored policy file is absent and the tree is consistent", () => {
    expect(readAdrStatus()).toBe("ACCEPTED");
    expect(fs.existsSync(path.join(process.cwd(), DEFAULT_POLICY_FILE))).toBe(false);
    expect(readAutoMergePolicy()).toEqual({ state: "absent" });
    expect(
      evaluateTreeConsistency({ adrStatus: readAdrStatus(), settingOn: false, implPresent: true }),
    ).toEqual({ consistent: true, violations: [] });
  });
});

describe("import-zero", () => {
  test("clause: the policy module never names the loop it polices", () => {
    const text = fs.readFileSync(path.join(process.cwd(), "src", "fleet", "auto-merge-policy.ts"), "utf8");
    // Import/export lines only: the module's comments are allowed to SAY what
    // it refuses to import.
    const importLines = text.split("\n").filter((l) => /^\s*(?:import|export)\b/.test(l));
    expect(importLines.some((l) => /fixloop|feedback-run|classifyDiffScope|classifyRunExit/.test(l))).toBe(false);
  });
});

describe("inertness", () => {
  test("clause: no QA producer exists in the production graph today", () => {
    expect(NO_PRODUCER_MARKER).toBe("factory_result");
    expect(POLICY_AUTO_MERGE_APPROVER_ID).toBe("policy:adr-2");
    expect(assertNoQaProducerInGraph()).toEqual({ clean: true, offenders: [] });
  });

  test("clause: the tripwire fires on a producer write-shape and spares a consumer", () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1prod-"));
    try {
      fs.mkdirSync(path.join(root, "fleet"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "fleet", "a2-producer.ts"),
        `export const artifact = { kind: "factory_result", verdict: {} };\n`,
      );
      fs.writeFileSync(
        path.join(root, "fleet", "consumer.ts"),
        `if (a.kind === "factory_result") consume();\n`,
      );
      expect(assertNoQaProducerInGraph(root)).toEqual({ clean: false, offenders: ["fleet/a2-producer.ts"] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loader never throws", () => {
  test("clause: a DIRECTORY at policyPath ⇒ off, never a throw", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".factory"));
    const r = readAutoMergePolicy({ cwd: root, policyPath: ".factory" });
    expect(r.state).toBe("off");
  });

  test("clause: an unreadable (chmod 000) policy ⇒ refusal state, never a throw", () => {
    const root = tmp();
    writePolicy(root, POLICY_ON, 0o000);
    const r = readAutoMergePolicy({ cwd: root });
    // Non-root: the guard refuses the read (policy-unreadable). Root ignores
    // the bits and reads an empty file (policy-garbled). Both are OFF.
    expect(r.state).toBe("off");
    if (r.state === "off") {
      expect(["policy-unreadable", "policy-garbled"]).toContain(r.stateReason);
    }
  });
});
