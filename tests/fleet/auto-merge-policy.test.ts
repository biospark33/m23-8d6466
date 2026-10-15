/**
 * G1: ADR-2's accepted fail-closed auto-merge policy (src/fleet/auto-merge-policy.ts).
 *
 * One test per clause of the story contract, named after the clause. The
 * make-or-break is the v6a invariant (arm 5): ON is structurally unreachable
 * while the clause-5 veto-window carrier is absent from the FACTORY tree (the
 * probe is anchored to this module's directory, not the host cwd). Every
 * filesystem test runs under its own mkdtemp root via the `cwd`/`policyPath`
 * opts and hands the probe a tmp `carrierRoot` — nothing is ever written into
 * the repo's real `.factory/` or `src/`; the ONE intentional real-tree test
 * (arm 12) is read-only.
 */
import { describe, expect, afterEach, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assertNoQaProducerInGraph,
  consultAutoMerge,
  evaluateDiffScope,
  evaluateNeverAutoMerge,
  evaluateTreeConsistency,
  evaluateVerdict,
  NEVER_AUTO_MERGE_PATHS,
  NEVER_AUTO_MERGE_PREFIXES,
  NO_PRODUCER_MARKER,
  OUT_OF_SCOPE_DIFF,
  PASSING_QA_STATUSES,
  POLICY_AUTO_MERGE_APPROVER_ID,
  readAdrStatus,
  readAutoMergePolicy,
  readVerdictBlock,
  SCOPE_REQUIRES_PRIVILEGE,
} from "../../src/fleet/auto-merge-policy.ts";

let dirs: string[] = [];
/** rmSync that rescues a deliberately hostile mode first (a 0666 dir has no
 * search bit, so even listing its contents fails until chmod restores it). */
const forceRm = (d: string): void => {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    fs.chmodSync(d, 0o700);
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      try {
        fs.chmodSync(path.join(d, String(ent.name)), ent.isDirectory() ? 0o700 : 0o600);
      } catch {
        // already permissive enough for the retry below
      }
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
};
afterEach(() => {
  for (const d of dirs) forceRm(d);
  dirs = [];
});

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1policy-"));
  dirs.push(d);
  return d;
};

/** The everything-set clause-5 policy body. */
const POLICY_ON = { autoMergeDefault: true, adr2AcceptedOn: "2026-10-15", vetoWindowQueueLive: true };

const writePolicy = (root: string, body: unknown, mode = 0o600): string => {
  fs.mkdirSync(path.join(root, ".factory"), { recursive: true });
  const p = path.join(root, ".factory", "policy.json");
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  fs.chmodSync(p, mode);
  return p;
};

/**
 * Fabricate the clause-5 carrier in a tmp tree shaped like the factory tree:
 * module at <root>/src/fleet/veto-window.ts, suite at <root>/tests/fleet/
 * veto-window.test.ts (the probe resolves the suite two levels up from the
 * carrierRoot it is handed, never from cwd). Returns the carrierRoot to pass.
 */
const fabricateCarrier = (root: string): string => {
  fs.mkdirSync(path.join(root, "src", "fleet"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "fleet", "veto-window.ts"),
    "export function enqueueVetoWindow(x: number): number { return x; }\n",
  );
  fs.mkdirSync(path.join(root, "tests", "fleet"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "fleet", "veto-window.test.ts"),
    'test("carrier", () => { enqueueVetoWindow(1); });\n',
  );
  return path.join(root, "src", "fleet");
};

const writeModule = (carrierRoot: string, body: string): void => {
  fs.writeFileSync(path.join(carrierRoot, "veto-window.ts"), body);
};
const writeCarrierTest = (root: string, body: string): void => {
  fs.writeFileSync(path.join(root, "tests", "fleet", "veto-window.test.ts"), body);
};

const openScope = {
  allowedPathGlobs: ["src/**"],
  deniedPathGlobs: [] as { glob: string; reason: string }[],
  permittedActions: ["modify", "add", "delete"] as ("modify" | "add" | "delete")[],
};

const CLEAN_ENTRY = { path: "src/run.ts", action: "modify" as const };
/** Passing verdict vocabulary (fleet results, sc2-7): status "approved". */
const FRESH_VERDICT = { status: "approved", producedAt: "2026-10-15T12:00:00.000Z" };
const FRESH_NOW = new Date("2026-10-15T13:00:00.000Z");
// Clock-independent for consult-level tests: strictly past, strictly after the rebase.
const PAST_VERDICT = { status: "approved", producedAt: "2026-10-01T00:00:00.000Z" };
const PAST_REBASED = new Date("2026-09-01T00:00:00.000Z");

const writeAdr = (root: string, body: string): string => {
  fs.mkdirSync(path.join(root, "docs", "decisions"), { recursive: true });
  // The module's DEFAULT_ADR_FILE basename — the readers below use the default
  // path, so the fixture must land where the default resolves.
  const p = path.join(root, "docs", "decisions", "2026-10-02-adr-2-autonomy-approval-surface.md");
  fs.writeFileSync(p, body);
  return p;
};

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

  test("clause 5: ON unreachable while the carrier is absent from the FACTORY tree — the v6a invariant", () => {
    // Upgrade cue: when the veto-window carrier lands, flip this to the ON
    // arm — failure here is an upgrade cue, not a product bug.
    // The real factory tree cannot hold the carrier today; state that, then
    // prove the module-anchored probe agrees even when the DISPATCHED repo
    // (the tmp cwd) looks identical minus the carrier.
    expect(fs.existsSync(path.join(process.cwd(), "src", "fleet", "veto-window.ts"))).toBe(false);
    const root = tmp();
    writePolicy(root, POLICY_ON);
    // No carrierRoot ⇒ the probe reads beside this module (the real src tree).
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "clause5-carrier-absent" });
  });

  test("clause 5: invalid/missing adr2AcceptedOn ⇒ clause5-carrier-absent (independent of carrier)", () => {
    // Upgrade cue: when the veto-window carrier lands, flip this to the ON
    // arm — failure here is an upgrade cue, not a product bug.
    const root = tmp();
    const carrierRoot = fabricateCarrier(root);
    writePolicy(root, { ...POLICY_ON, adr2AcceptedOn: "15-10-2026" });
    expect(readAutoMergePolicy({ cwd: root, carrierRoot })).toEqual({
      state: "off",
      stateReason: "clause5-carrier-absent",
    });
    // Plausible-calendar regex: no 13th month, no day 32/00 (C9). Shape-level
    // only — the contracted pattern still admits 02-30, deliberately.
    const root3 = tmp();
    const carrierRoot3 = fabricateCarrier(root3);
    writePolicy(root3, { ...POLICY_ON, adr2AcceptedOn: "2026-13-01" });
    expect(readAutoMergePolicy({ cwd: root3, carrierRoot: carrierRoot3 })).toEqual({
      state: "off",
      stateReason: "clause5-carrier-absent",
    });
    const root4 = tmp();
    const carrierRoot4 = fabricateCarrier(root4);
    writePolicy(root4, { ...POLICY_ON, adr2AcceptedOn: "2026-02-32" });
    expect(readAutoMergePolicy({ cwd: root4, carrierRoot: carrierRoot4 })).toEqual({
      state: "off",
      stateReason: "clause5-carrier-absent",
    });

    const root2 = tmp();
    const carrierRoot2 = fabricateCarrier(root2);
    writePolicy(root2, { autoMergeDefault: true, vetoWindowQueueLive: true });
    expect(readAutoMergePolicy({ cwd: root2, carrierRoot: carrierRoot2 })).toEqual({
      state: "off",
      stateReason: "clause5-carrier-absent",
    });
  });

  test("clause 5: vetoWindowQueueLive not true ⇒ clause5-carrier-absent even with carrier present", () => {
    // Upgrade cue: when the veto-window carrier lands, flip this to the ON
    // arm — failure here is an upgrade cue, not a product bug.
    const root = tmp();
    const carrierRoot = fabricateCarrier(root);
    writePolicy(root, { autoMergeDefault: true, adr2AcceptedOn: "2026-10-15" });
    expect(readAutoMergePolicy({ cwd: root, carrierRoot })).toEqual({
      state: "off",
      stateReason: "clause5-carrier-absent",
    });
  });

  test("clause 5: ON reachable ONLY through a fabricated carrier tree — the probe works", () => {
    const root = tmp();
    const carrierRoot = fabricateCarrier(root);
    writePolicy(root, POLICY_ON);
    expect(readAutoMergePolicy({ cwd: root, carrierRoot })).toEqual({ state: "on" });
  });

  test("clause 5: a comment-only carrier does NOT arm — comments stripped before matching", () => {
    const root = tmp();
    const carrierRoot = fabricateCarrier(root);
    writeModule(
      carrierRoot,
      [
        "/* export function enqueueVetoWindow(x: number): number { return x; } */",
        "// export const enqueueVetoWindow = 1;",
        "export const unrelated = true;",
      ].join("\n"),
    );
    writePolicy(root, POLICY_ON);
    expect(readAutoMergePolicy({ cwd: root, carrierRoot })).toEqual({
      state: "off",
      stateReason: "clause5-carrier-absent",
    });
  });

  test("clause 5: a re-export carrier DOES arm — `export { enqueueVetoWindow` counts", () => {
    const root = tmp();
    const carrierRoot = fabricateCarrier(root);
    writeModule(carrierRoot, 'export { enqueueVetoWindow } from "./veto-window-impl.ts";\n');
    writePolicy(root, POLICY_ON);
    expect(readAutoMergePolicy({ cwd: root, carrierRoot })).toEqual({ state: "on" });
  });

  test("clause 5: a carrier suite that never names the symbol does NOT arm", () => {
    const root = tmp();
    const carrierRoot = fabricateCarrier(root);
    writeCarrierTest(root, "// suite placeholder that never references the queue\n");
    writePolicy(root, POLICY_ON);
    expect(readAutoMergePolicy({ cwd: root, carrierRoot })).toEqual({
      state: "off",
      stateReason: "clause5-carrier-absent",
    });
  });

  test("clause: group/world-writable .factory DIRECTORY ⇒ off/policy-unreadable — the 0o022 ancestor mask", () => {
    const root = tmp();
    writePolicy(root, POLICY_ON);
    // 0766: the group/world WRITE bits trip the guard's 0o022 ancestor mask,
    // while the owner search bit keeps the file visible (a 0666 dir would read
    // as absent — no x bit, no stat — which is the -absent arm, not this one).
    fs.chmodSync(path.join(root, ".factory"), 0o766);
    expect(readAutoMergePolicy({ cwd: root })).toEqual({ state: "off", stateReason: "policy-unreadable" });
  });

  test("clause: policyPath escaping the root ⇒ absent (the -path class), even though the file exists", () => {
    const root = tmp();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-evil.json`);
    fs.writeFileSync(outside, JSON.stringify(POLICY_ON));
    try {
      expect(readAutoMergePolicy({ cwd: root, policyPath: `../${path.basename(outside)}` })).toEqual({
        state: "absent",
      });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
  // The ownership arm (self-or-root owner, `-owner` refusal) is degraded
  // off-platform by readGuardedFile's own design (getuid guard) and is not
  // re-tested here; the loader maps it to policy-unreadable like any other
  // posture refusal, which the 0644/0666/000 arms above already cover.
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

  test("clause: lexical normalization — ./, //, .. and backslashes cannot dodge the never-list", () => {
    expect(evaluateNeverAutoMerge(["./src/fleet/approval-gate.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["src//fleet/approval-gate.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["src/x/../fleet/approval-gate.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["src/run.ts", "src/fleet/other.ts"])).toEqual({ park: false });
  });

  test("clause: the src/audit node itself parks — 'src/audit' and 'src/audit/', not only children", () => {
    expect(evaluateNeverAutoMerge(["src/audit"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["src/audit/"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["SRC/Audit"])).toEqual({ park: true, reason: "never-path" });
  });

  test("clause: drive-prefix, absolute and leading-.. spellings cannot dodge the gate", () => {
    // Drive prefix and a leading / strip to the repo-relative form, so the
    // never-list still matches; a leading .. leaves the repo-relative
    // namespace entirely and parks as outside-root (fail closed either way).
    expect(evaluateNeverAutoMerge(["X:/src/audit/link-store.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["C:\\src\\fleet\\approval-gate.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["/src/audit/link-store.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["X:/src/run.ts"])).toEqual({ park: false });
    expect(evaluateNeverAutoMerge(["../src/audit/link-store.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["../src/run.ts"])).toEqual({ park: true, reason: "never-path" });
  });

  test("clause: case-insensitive compare — a case-folding host cannot bypass by spelling", () => {
    expect(evaluateNeverAutoMerge(["SRC/AUDIT/anything.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["Src/Fleet/Approval-Gate.TS"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["SRC/audit/LINK-STORE.ts"])).toEqual({ park: true, reason: "never-path" });
    expect(evaluateNeverAutoMerge(["SRC/RUN.TS"])).toEqual({ park: false });
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

  test("clause: `**/` matches zero segments — exact fixloop matcher fidelity", () => {
    // Mirrors the locked I6 semantics of src/fixloop/feedback-run.ts globToRegExp.
    const glob = scope({ allowedPathGlobs: ["src/**/*.ts"] });
    expect(evaluateDiffScope([{ path: "src/a.ts", action: "modify" }], glob)).toEqual({ park: false });
    expect(evaluateDiffScope([{ path: "src/a/b.ts", action: "modify" }], glob)).toEqual({ park: false });
    // Bare leading `**/`: matches at the root AND at depth.
    const leading = scope({ allowedPathGlobs: ["**/ci.yml"] });
    expect(evaluateDiffScope([{ path: "ci.yml", action: "modify" }], leading)).toEqual({ park: false });
    expect(evaluateDiffScope([{ path: ".github/workflows/ci.yml", action: "modify" }], leading)).toEqual({
      park: false,
    });
  });

  test("clause: normalized diff paths against normalized globs — ./ and // still match", () => {
    expect(evaluateDiffScope([{ path: "./src/run.ts", action: "modify" }], scope())).toEqual({ park: false });
    expect(evaluateDiffScope([{ path: "src//run.ts", action: "modify" }], scope())).toEqual({ park: false });
  });

  test("clause: BOTH sides casefold — an uppercase deny glob or uppercase diff path still matches", () => {
    // Deny spelled uppercase still catches the lowercase path (deliberately
    // stricter than fixloop's case-sensitive matcher — see the module doc).
    expect(
      evaluateDiffScope([{ path: "src/secret/key.ts", action: "modify" }], {
        allowedPathGlobs: ["src/**"],
        deniedPathGlobs: [{ glob: "SRC/SECRET/**", reason: "operator-only" }],
        permittedActions: ["modify", "add", "delete"],
      }),
    ).toEqual({ park: true, reason: SCOPE_REQUIRES_PRIVILEGE });
    expect(
      evaluateDiffScope([{ path: "SRC/SECRET/KEY.TS", action: "modify" }], {
        allowedPathGlobs: ["src/secret/**"],
        deniedPathGlobs: [{ glob: "src/secret/**", reason: "operator-only" }],
        permittedActions: ["modify", "add", "delete"],
      }),
    ).toEqual({ park: true, reason: SCOPE_REQUIRES_PRIVILEGE });
    // Allow side casefolds too: an uppercase path matches the lowercase glob.
    expect(evaluateDiffScope([{ path: "SRC/RUN.TS", action: "modify" }], scope())).toEqual({ park: false });
  });
});

describe("evaluateVerdict", () => {
  test("clause: undefined ⇒ verdict-absent", () => {
    expect(evaluateVerdict(undefined)).toEqual({ ok: false, reason: "verdict-absent" });
  });

  test("clause: producedAt before rebasedAt (or unparseable) ⇒ verdict-stale", () => {
    const rebasedAt = new Date("2026-10-15T12:00:00.000Z");
    expect(evaluateVerdict({ status: "approved", producedAt: "2026-10-15T11:00:00.000Z" }, rebasedAt, FRESH_NOW)).toEqual({
      ok: false,
      reason: "verdict-stale",
    });
    expect(evaluateVerdict({ status: "approved", producedAt: "not-a-date" }, rebasedAt, FRESH_NOW)).toEqual({
      ok: false,
      reason: "verdict-stale",
    });
  });

  test("clause: producedAt == rebasedAt (same ms) ⇒ verdict-stale — fresh must postdate the rebase", () => {
    const at = new Date("2026-10-15T12:00:00.000Z");
    expect(evaluateVerdict({ status: "approved", producedAt: "2026-10-15T12:00:00.000Z" }, at, FRESH_NOW)).toEqual({
      ok: false,
      reason: "verdict-stale",
    });
  });

  test("clause: future-dated producedAt (after now) ⇒ verdict-future — clock skew or forged producer", () => {
    expect(evaluateVerdict({ status: "approved", producedAt: "2026-10-15T14:00:00.000Z" }, undefined, FRESH_NOW)).toEqual({
      ok: false,
      reason: "verdict-future",
    });
  });

  test("clause: escalated ⇒ verdict-escalated — truthy non-boolean counts; stale beats escalated, future beats both", () => {
    expect(
      evaluateVerdict({ status: "approved", producedAt: "2026-10-15T12:30:00.000Z", escalated: true }, undefined, FRESH_NOW),
    ).toEqual({ ok: false, reason: "verdict-escalated" });
    // Truthy non-boolean escalation values fail closed (C5).
    expect(
      evaluateVerdict(
        { status: "approved", producedAt: "2026-10-15T12:30:00.000Z", escalated: "yes" as unknown as boolean },
        undefined,
        FRESH_NOW,
      ),
    ).toEqual({ ok: false, reason: "verdict-escalated" });
    expect(
      evaluateVerdict(
        { status: "approved", producedAt: "2026-10-15T11:00:00.000Z", escalated: true },
        new Date("2026-10-15T12:00:00.000Z"),
        FRESH_NOW,
      ),
    ).toEqual({ ok: false, reason: "verdict-stale" });
    // Precedence: future > stale > escalated.
    expect(
      evaluateVerdict(
        { status: "rejected", producedAt: "2026-10-15T14:00:00.000Z", escalated: true },
        new Date("2026-10-15T13:30:00.000Z"),
        FRESH_NOW,
      ),
    ).toEqual({ ok: false, reason: "verdict-future" });
  });

  test("clause: status outside PASSING_QA_STATUSES ⇒ verdict-rejected (fleet-result vocabulary: approved)", () => {
    expect(PASSING_QA_STATUSES).toEqual(new Set(["approved"]));
    expect(
      evaluateVerdict({ status: "rejected", producedAt: "2026-10-15T12:30:00.000Z" }, undefined, FRESH_NOW),
    ).toEqual({ ok: false, reason: "verdict-rejected" });
    expect(
      evaluateVerdict({ status: "changes-requested", producedAt: "2026-10-15T12:30:00.000Z" }, undefined, FRESH_NOW),
    ).toEqual({ ok: false, reason: "verdict-rejected" });
    // Precedence: escalated and stale both report before the status arm.
    expect(
      evaluateVerdict({ status: "rejected", producedAt: "2026-10-15T12:30:00.000Z", escalated: true }, undefined, FRESH_NOW),
    ).toEqual({ ok: false, reason: "verdict-escalated" });
    expect(
      evaluateVerdict({ status: "rejected", producedAt: "2026-10-15T11:00:00.000Z" }, new Date("2026-10-15T12:00:00.000Z"), FRESH_NOW),
    ).toEqual({ ok: false, reason: "verdict-stale" });
  });

  test("clause: fresh + approved ⇒ ok", () => {
    expect(evaluateVerdict(FRESH_VERDICT, new Date("2026-10-15T11:00:00.000Z"), FRESH_NOW)).toEqual({ ok: true });
  });
});

describe("consultAutoMerge", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    runId: "run-1",
    diffPaths: ["src/run.ts"],
    diffEntries: [CLEAN_ENTRY],
    scope: openScope,
    // rebasedAt is now REQUIRED whenever a verdict is present: freshness is
    // judged against the rebase, and consultAutoMerge reports verdict-stale
    // for a verdict without its anchor (fail-closed).
    rebasedAt: PAST_REBASED,
    ...over,
  });
  const OFF = { state: "off", stateReason: "declared-off" } as const;

  test("clause: absent policy ⇒ reasons ABSENT, no evaluation occurred", () => {
    const r = consultAutoMerge(input(), PAST_VERDICT, { state: "absent" });
    expect(r.eligible).toBe(false);
    expect("reasons" in r).toBe(false);
  });

  test("clause: present-OFF, otherwise clean ⇒ [policy-off] + policyState/policyOff passthrough", () => {
    expect(consultAutoMerge(input(), PAST_VERDICT, OFF)).toEqual({
      runId: "run-1",
      eligible: false,
      reasons: ["policy-off"],
      policyState: { state: "off", stateReason: "declared-off" },
      policyOff: "declared-off",
    });
  });

  test("clause: verdict present WITHOUT a rebasedAt anchor ⇒ verdict-stale (freshness needs the rebase)", () => {
    // C4: an era that produces verdicts must thread the rebase timestamp;
    // a missing anchor is fail-closed stale, not verdict-absent.
    const r = consultAutoMerge(input({ rebasedAt: undefined }), PAST_VERDICT, { state: "on" });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(["verdict-stale"]);
  });

  test("clause: ON + never-path ⇒ [never-path]", () => {
    const r = consultAutoMerge(input({ diffPaths: ["src/fleet/approval-gate.ts"] }), PAST_VERDICT, { state: "on" });
    expect(r).toEqual({ runId: "run-1", eligible: false, reasons: ["never-path"] });
  });

  test("clause: ON + everything failing ⇒ full reasons in canonical order (contract clause names)", () => {
    const r = consultAutoMerge(
      input({
        diffPaths: ["src/fleet/approval-gate.ts"],
        diffEntries: [{ path: "src/audit/x.ts", action: "modify" }],
        scope: { ...openScope, deniedPathGlobs: [{ glob: "src/audit/**", reason: "audit hops" }] },
        rebasedAt: PAST_REBASED,
      }),
      undefined,
      OFF,
    );
    expect(r.reasons).toEqual(["never-path", "scope", "verdict-absent", "policy-off"]);
  });

  test("clause: ON + clean ⇒ eligible true, reasons = the satisfied requirements in canonical order", () => {
    expect(consultAutoMerge(input(), PAST_VERDICT, { state: "on" })).toEqual({
      runId: "run-1",
      eligible: true,
      reasons: ["never-path-clear", "scope-ok", "verdict-fresh", "policy-on"],
    });
  });

  test("clause: empty diffEntries parks scope BEFORE the allow pass — zero reviewed changes is not mergeable", () => {
    const r = consultAutoMerge(input({ diffEntries: [] }), PAST_VERDICT, { state: "on" });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(["scope"]);
  });

  test("clause: never-check sees the UNION — an entry only in diffEntries still parks", () => {
    const r = consultAutoMerge(
      input({ diffEntries: [{ path: "src/audit/link-store.ts", action: "modify" }] }),
      PAST_VERDICT,
      { state: "on" },
    );
    expect(r.reasons).toEqual(["never-path"]);
  });

  test("clause: never-check sees the UNION — a path only in diffPaths still parks", () => {
    const r = consultAutoMerge(input({ diffPaths: ["src/providers/credentials.ts"] }), PAST_VERDICT, { state: "on" });
    expect(r.reasons).toEqual(["never-path"]);
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

  test("clause: ACCEPTED ⇒ consistent only WITH an accepted clause-1 verdict block (C2)", () => {
    expect(
      evaluateTreeConsistency({
        adrStatus: "ACCEPTED",
        verdictBlockPresent: true,
        clause1Accepted: true,
        settingOn: true,
        implPresent: true,
      }),
    ).toEqual({ consistent: true, violations: [] });
  });

  test("clause: ACCEPTED with NO verdict block ⇒ accepted-without-verdict-block — a bare header claim", () => {
    expect(
      evaluateTreeConsistency({ adrStatus: "ACCEPTED", clause1Accepted: undefined, settingOn: false, implPresent: false }),
    ).toEqual({ consistent: false, violations: ["accepted-without-verdict-block"] });
  });

  test("clause: ACCEPTED with a clause-1 REJECTED disposition ⇒ accepted-while-clause1-rejected", () => {
    expect(
      evaluateTreeConsistency({
        adrStatus: "ACCEPTED",
        verdictBlockPresent: true,
        clause1Accepted: false,
        settingOn: true,
        implPresent: true,
      }),
    ).toEqual({ consistent: false, violations: ["accepted-while-clause1-rejected"] });
  });

  test("clause: AMENDED ⇒ consistent only with clause1Accepted === true (the tree-read disposition)", () => {
    expect(
      evaluateTreeConsistency({
        adrStatus: "AMENDED",
        verdictBlockPresent: true,
        clause1Accepted: true,
        settingOn: true,
        implPresent: true,
      }),
    ).toEqual({ consistent: true, violations: [] });
    expect(
      evaluateTreeConsistency({ adrStatus: "AMENDED", clause1Accepted: true, settingOn: true, implPresent: true }),
    ).toEqual({ consistent: true, violations: [] });
  });

  test("clause: AMENDED with clause1Accepted undefined/false ⇒ amended-without-accepted-verdict (fail closed)", () => {
    expect(
      evaluateTreeConsistency({
        adrStatus: "AMENDED",
        verdictBlockPresent: true,
        clause1Accepted: undefined,
        settingOn: true,
        implPresent: true,
      }),
    ).toEqual({
      consistent: false,
      violations: ["amended-without-accepted-verdict", "impl-present-while-amended-unaccepted", "setting-on-while-amended-unaccepted"],
    });
    expect(
      evaluateTreeConsistency({ adrStatus: "AMENDED", clause1Accepted: false, settingOn: false, implPresent: false }),
    ).toEqual({
      consistent: false,
      violations: ["amended-without-accepted-verdict"],
    });
  });

  test("clause: UNKNOWN header word ⇒ ...-while-unknown names, fail-closed, never mislabeled PROPOSED", () => {
    expect(evaluateTreeConsistency({ adrStatus: "UNKNOWN", settingOn: true, implPresent: true })).toEqual({
      consistent: false,
      violations: ["impl-present-while-unknown", "setting-on-while-unknown"],
    });
    expect(
      evaluateTreeConsistency({ adrStatus: "SUPERSEDED", verdictBlockPresent: true, settingOn: false, implPresent: false }),
    ).toEqual({
      consistent: false,
      violations: ["verdict-block-while-unknown"],
    });
  });
});

describe("readVerdictBlock", () => {
  const ADR_WITH_BLOCK = [
    "# ADR-2",
    "",
    "## Operator verdict — ACCEPTED (2026-10-15, via story G1)",
    "",
    "| Clause | Disposition |",
    "|---|---|",
    "| 1 — auto-merge default | **ACCEPTED** as written. |",
    "| 2 — other | **AMENDED**. |",
    "",
  ].join("\n");
  const ADR_AMENDED_ROW = ADR_WITH_BLOCK.replace(
    "| 1 — auto-merge default | **ACCEPTED** as written. |",
    "| 1 — auto-merge default | **AMENDED**. |",
  );

  test("clause: real tree — the operator verdict block is present and clause 1 is ACCEPTED", () => {
    expect(readVerdictBlock()).toEqual({ present: true, clause1Accepted: true });
  });

  test("clause: no verdict block (or unreadable file) ⇒ present false, clause1Accepted undefined", () => {
    const root = tmp();
    writeAdr(root, "# ADR-2\n\n- **Status:** ACCEPTED\n");
    expect(readVerdictBlock({ cwd: root })).toEqual({ present: false, clause1Accepted: undefined });
    expect(readVerdictBlock({ cwd: root, adrPath: "docs/decisions/missing.md" })).toEqual({
      present: false,
      clause1Accepted: undefined,
    });
  });

  test("clause: block present + clause-1 ACCEPTED ⇒ clause1Accepted true", () => {
    const root = tmp();
    writeAdr(root, ADR_WITH_BLOCK);
    expect(readVerdictBlock({ cwd: root })).toEqual({ present: true, clause1Accepted: true });
  });

  test("clause: block present + clause-1 row NOT accepted (AMENDED) ⇒ clause1Accepted false", () => {
    const root = tmp();
    writeAdr(root, ADR_AMENDED_ROW);
    expect(readVerdictBlock({ cwd: root })).toEqual({ present: true, clause1Accepted: false });
  });

  test("clause: disposition parsed from the LEADING bolded token only — substring ACCEPTED does not pass (C1)", () => {
    // "REJECTED (was ACCEPTED)" and "NOT ACCEPTED" contain the substring but
    // their leading bolded token is not exactly ACCEPTED ⇒ false (the r1
    // fail-open: row.includes("ACCEPTED") would have waved both through).
    const root = tmp();
    writeAdr(
      root,
      ADR_WITH_BLOCK.replace(
        "| 1 — auto-merge default | **ACCEPTED** as written. |",
        "| 1 — auto-merge default | **REJECTED (was ACCEPTED)** as written. |",
      ),
    );
    expect(readVerdictBlock({ cwd: root })).toEqual({ present: true, clause1Accepted: false });
    const root2 = tmp();
    writeAdr(
      root2,
      ADR_WITH_BLOCK.replace(
        "| 1 — auto-merge default | **ACCEPTED** as written. |",
        "| 1 — auto-merge default | NOT ACCEPTED as written. |",
      ),
    );
    expect(readVerdictBlock({ cwd: root2 })).toEqual({ present: true, clause1Accepted: false });
    // An unbolded disposition cell yields no bolded token at all ⇒ false.
    const root3 = tmp();
    writeAdr(
      root3,
      ADR_WITH_BLOCK.replace(
        "| 1 — auto-merge default | **ACCEPTED** as written. |",
        "| 1 — auto-merge default | accepted, reluctantly. |",
      ),
    );
    expect(readVerdictBlock({ cwd: root3 })).toEqual({ present: true, clause1Accepted: false });
  });

  test("clause: a clause-1 row QUOTED inside a fenced example block does not read — fences stripped (C3)", () => {
    const root = tmp();
    writeAdr(
      root,
      [
        "# ADR-2",
        "",
        "## Operator verdict",
        "",
        "| Clause | Disposition |",
        "|---|---|",
        "| 1 — auto-merge default | **AMENDED**. |",
        "",
        "```md",
        "| 1 — example | **ACCEPTED** |",
        "```",
        "",
      ].join("\n"),
    );
    expect(readVerdictBlock({ cwd: root })).toEqual({ present: true, clause1Accepted: false });
  });

  test("clause: block present but no clause-1 row ⇒ clause1Accepted false (fail closed)", () => {
    const root = tmp();
    writeAdr(root, "## Operator verdict\n\n| Clause | Disposition |\n|---|---|\n| 2 — other | **ACCEPTED**. |\n");
    expect(readVerdictBlock({ cwd: root })).toEqual({ present: true, clause1Accepted: false });
  });
});

describe("readAdrStatus", () => {
  test("clause: a Status bullet QUOTED inside a fenced block does not read — fences stripped", () => {
    const root = tmp();
    writeAdr(
      root,
      [
        "# ADR-2",
        "",
        "- **Status:** PROPOSED",
        "",
        "```md",
        "- **Status:** ACCEPTED",
        "```",
        "",
      ].join("\n"),
    );
    expect(readAdrStatus({ cwd: root })).toBe("PROPOSED");
  });

  test("clause: missing file ⇒ PROPOSED (fail-closed), an unrecognized bullet ⇒ UNKNOWN", () => {
    const root = tmp();
    expect(readAdrStatus({ cwd: root })).toBe("PROPOSED");
    writeAdr(root, "- **Status:** SUPERSEDED\n");
    expect(readAdrStatus({ cwd: root })).toBe("UNKNOWN");
  });
});

describe("the real tree (read-only)", () => {
  test("clause: the repo ADR reads ACCEPTED with an accepted clause-1 verdict; consistency derives from the tree", () => {
    // Every input below is DERIVED from the real tree — no literal states the
    // tree's shape (accept#2/#3): a reverted header, a flipped setting, or a
    // moved module each change the derived inputs and can turn this red.
    const policy = readAutoMergePolicy();
    const implPresent =
      fs.existsSync(path.join(process.cwd(), "src", "fleet", "auto-merge-policy.ts")) &&
      /auto-merge-consult/.test(
        fs.readFileSync(path.join(process.cwd(), "src", "fleet", "run-completion.ts"), "utf8"),
      );
    expect(readAdrStatus()).toBe("ACCEPTED");
    const block = readVerdictBlock();
    expect(block).toEqual({ present: true, clause1Accepted: true });
    expect(
      evaluateTreeConsistency({
        adrStatus: readAdrStatus(),
        verdictBlockPresent: block.present,
        clause1Accepted: block.clause1Accepted,
        settingOn: policy.state === "on",
        implPresent,
      }),
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

  test("clause: the tripwire follows a symlinked DIRECTORY (dirent types do not resolve links)", () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1sym-"));
    const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1symreal-"));
    try {
      fs.mkdirSync(path.join(real, "nested"));
      fs.writeFileSync(
        path.join(real, "nested", "producer.ts"),
        `export const artifact = { kind: "factory_result", verdict: {} };\n`,
      );
      fs.symlinkSync(path.join(real, "nested"), path.join(root, "linked"));
      expect(assertNoQaProducerInGraph(root)).toEqual({ clean: false, offenders: ["linked/producer.ts"] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

/** Windows needs elevated privileges to create symlinks; POSIX does not. */
const SYMLINK_OK = process.platform !== "win32";

describe("inertness — cycle safety (C8)", () => {
  test.skipIf(!SYMLINK_OK)(
    "clause: a symlinked ancestor cycle terminates — the walk carries a dev:ino visited set",
    () => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1loop-"));
      try {
        // root/loop → root itself: without the visited set the walk diverges.
        fs.symlinkSync(root, path.join(root, "loop"));
        expect(assertNoQaProducerInGraph(root)).toEqual({ clean: true, offenders: [] });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
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
