/**
 * ADR-2's accepted fail-closed auto-merge policy, as pure evaluation.
 *
 * FAIL CLOSED, everywhere. The loader returns ON only when the operator
 * declared it AND every clause-5 conjunct verifies against the tree; a policy
 * file that cannot be proven trustworthy (mode, ownership, containment) is
 * OFF, never ON — the `.factory/` posture is 0600 operator-local, so a
 * posture failure is exactly the case where ON would be the attacker's
 * outcome. `consultAutoMerge` lists EVERY failing clause in canonical order
 * and is eligible only when none fire; an absent policy is signalled by the
 * ABSENCE of `reasons`, because no evaluation occurred at all. Nothing here
 * throws and no verdict payload or token ever leaves — ids and clause names
 * only.
 *
 * The scope vocabulary below (SCOPE_REQUIRES_PRIVILEGE, OUT_OF_SCOPE_DIFF) is
 * RESTATED per ADR-2 clause 4 / story AC3, NEVER imported from src/fixloop:
 * a policy module that imports the loop it polices could be flipped by the
 * thing it gates (see the import-zero test in the suite).
 *
 * The clause-5 carrier (`enqueueVetoWindow` veto-window queue) is probed
 * STATICALLY — file existence plus a text probe — never imported, so the
 * absent-module case (v6a, where the queue is not in the tree) is a state the
 * loader can express rather than a crash. Until the carrier lands, ON is
 * structurally unreachable, which is the accepted operator verdict's whole
 * point.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";

import { readGuardedFile } from "../providers/allowlist-path.ts";

export const DEFAULT_POLICY_FILE = ".factory/policy.json";
export const POLICY_AUTO_MERGE_APPROVER_ID = "policy:adr-2";

/** The clause-5 carrier files, probed relative to the host root. Never imported. */
const CARRIER_MODULE = "src/fleet/veto-window.ts";
const CARRIER_TEST = "tests/fleet/veto-window.test.ts";
const CARRIER_SYMBOL = "enqueueVetoWindow";

/** The consistency-side ADR reader's default; docs are not runtime config. */
const DEFAULT_ADR_FILE = "docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md";

export type AutoMergePolicyState =
  | { state: "absent" }
  | { state: "off"; stateReason: "policy-garbled" | "policy-unreadable" | "declared-off" | "clause5-carrier-absent" }
  | { state: "on" };

export type QaVerdict = { status: string; producedAt: string; escalated?: boolean };

export type NeverPathReason =
  | "never-path"
  | "scope-requires-privilege"
  | "out-of-scope-diff"
  | "verdict-absent"
  | "verdict-stale"
  | "verdict-escalated"
  | "policy-off";

/** Restated vocabulary (classifyDiffScope's class name for a deny-glob hit). */
export const SCOPE_REQUIRES_PRIVILEGE = "scope-requires-privilege";
/** Restated vocabulary (classifyDiffScope's class name for no allow match or an unpermitted action). */
export const OUT_OF_SCOPE_DIFF = "out-of-scope-diff";

export const NEVER_AUTO_MERGE_PREFIXES: readonly string[] = ["src/audit/"];
export const NEVER_AUTO_MERGE_PATHS: readonly string[] = [
  "src/fleet/approval-gate.ts",
  "src/providers/credentials.ts",
  "src/audit/link-store.ts",
];

export interface DiffEntry {
  path: string;
  action: "modify" | "add" | "delete";
}

export interface DiffScope {
  allowedPathGlobs: readonly string[];
  deniedPathGlobs: readonly { glob: string; reason: string }[];
  permittedActions: readonly ("modify" | "add" | "delete")[];
}

const PolicyFileSchema = z
  .strictObject({
    autoMergeDefault: z.boolean(),
    // Optional HERE on purpose: a missing acceptance date must fall to the
    // clause-5 arm (clause5-carrier-absent), not to the garbled arm — the
    // document parsed, one clause-5 conjunct is missing.
    adr2AcceptedOn: z.string().optional(),
    vetoWindowQueueLive: z.boolean().optional(),
  })
  .strict();

/** How the shared guard speaks about THIS file — thresholds are the guard's own. */
const POLICY_SPEC = {
  codePrefix: "auto-merge-policy",
  label: "auto-merge policy",
  defaultFile: DEFAULT_POLICY_FILE,
  contentHint: '{"autoMergeDefault": true, "adr2AcceptedOn": "YYYY-MM-DD", "vetoWindowQueueLive": true}',
  consequence: "auto-merge stays off",
} as const;

function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Static clause-5 probe: the veto-window module exists AND declares the
 * enqueue symbol AND its suite exists. Text, never import — importing would
 * turn "carrier absent" into a module-resolution crash instead of a state.
 */
function clause5CarrierPresent(root: string): boolean {
  try {
    const mod = readFileSync(resolve(root, CARRIER_MODULE), "utf8");
    if (!new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|class)\\s+${CARRIER_SYMBOL}\\b`).test(mod)) {
      return false;
    }
    statSync(resolve(root, CARRIER_TEST));
    return true;
  } catch {
    return false;
  }
}

export function readAutoMergePolicy(opts?: { policyPath?: string; cwd?: string }): AutoMergePolicyState {
  const root = resolve(opts?.cwd ?? process.cwd());
  const policyPath = resolve(root, opts?.policyPath ?? DEFAULT_POLICY_FILE);
  try {
    // Absence is decided HERE, before the guarded read: the guard has no
    // missing-file arm distinct from unreadable, and absence is the fail-closed
    // default anyway, so no arm of this pre-check can ever produce ON.
    if (!existsSync(policyPath)) return { state: "absent" };
  } catch {
    return { state: "absent" };
  }
  const read = readGuardedFile(root, policyPath, POLICY_SPEC);
  if (!read.ok) {
    // `-path` is the containment arm: the caller pointed the setting outside
    // the host root, so there is no operator setting at that path at all.
    if (read.refusal.code === "auto-merge-policy-path") return { state: "absent" };
    // Every other refusal (mode, owner, unreadable) is a posture failure and
    // must stay OFF — a world-readable policy is one another account wrote.
    return { state: "off", stateReason: "policy-unreadable" };
  }
  let parsed: z.output<typeof PolicyFileSchema>;
  try {
    parsed = PolicyFileSchema.parse(JSON.parse(read.text));
  } catch {
    return { state: "off", stateReason: "policy-garbled" };
  }
  if (parsed.autoMergeDefault !== true) return { state: "off", stateReason: "declared-off" };
  // All remaining conjuncts are clause-5's: the ADR acceptance date is shaped
  // like a date, the operator flagged the veto-window queue live, and the
  // queue actually exists in the tree. Any miss is the same state — the point
  // of clause 5 is that ON is unreachable while the carrier is missing.
  if (parsed.adr2AcceptedOn === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.adr2AcceptedOn)) {
    return { state: "off", stateReason: "clause5-carrier-absent" };
  }
  if (parsed.vetoWindowQueueLive !== true) return { state: "off", stateReason: "clause5-carrier-absent" };
  if (!clause5CarrierPresent(root)) return { state: "off", stateReason: "clause5-carrier-absent" };
  return { state: "on" };
}

export function evaluateNeverAutoMerge(diffPaths: readonly string[]): { park: boolean; reason?: "never-path" } {
  for (const raw of diffPaths) {
    const p = toPosixRel(raw);
    if (NEVER_AUTO_MERGE_PREFIXES.some((prefix) => p.startsWith(prefix))) return { park: true, reason: "never-path" };
    if ((NEVER_AUTO_MERGE_PATHS as readonly string[]).includes(p)) return { park: true, reason: "never-path" };
  }
  return { park: false };
}

/**
 * Minimal hand-rolled glob → RegExp: `*` within a segment, `**` across
 * segments, `?` a single non-separator character. Restated per ADR-2 clause 4
 * / story AC3 — the loop's own matcher is deliberately NOT imported (see the
 * module doc).
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c: string = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** DENY WINS: a deny hit is `scope-requires-privilege` — retrying can never help. */
export function evaluateDiffScope(
  diffEntries: readonly DiffEntry[],
  scope: DiffScope,
): { park: boolean; reason?: "scope-requires-privilege" | "out-of-scope-diff" } {
  for (const entry of diffEntries) {
    const p = toPosixRel(entry.path);
    if (scope.deniedPathGlobs.some((d) => globToRegExp(toPosixRel(d.glob)).test(p))) {
      return { park: true, reason: SCOPE_REQUIRES_PRIVILEGE };
    }
  }
  for (const entry of diffEntries) {
    const p = toPosixRel(entry.path);
    const allowed = scope.allowedPathGlobs.some((g) => globToRegExp(toPosixRel(g)).test(p));
    if (!allowed || !scope.permittedActions.includes(entry.action)) {
      return { park: true, reason: OUT_OF_SCOPE_DIFF };
    }
  }
  return { park: false };
}

/**
 * ADR-2 clause 2's minimal consumption pin: presence, freshness, escalation.
 * The producer (A2) may extend QaVerdict adds-only; stale is judged before
 * escalated so a stale AND escalated verdict reports the earlier clause.
 */
export function evaluateVerdict(
  verdict: QaVerdict | undefined,
  rebasedAt?: Date,
): { ok: boolean; reason?: "verdict-absent" | "verdict-stale" | "verdict-escalated" } {
  if (verdict === undefined) return { ok: false, reason: "verdict-absent" };
  const produced = new Date(verdict.producedAt).getTime();
  if (Number.isNaN(produced) || produced < (rebasedAt?.getTime() ?? 0)) return { ok: false, reason: "verdict-stale" };
  if (verdict.escalated === true) return { ok: false, reason: "verdict-escalated" };
  return { ok: true };
}

export function consultAutoMerge(
  input: {
    runId: string;
    diffPaths: readonly string[];
    diffEntries: readonly DiffEntry[];
    scope: DiffScope;
    rebasedAt?: Date;
  },
  verdict: QaVerdict | undefined,
  policy: AutoMergePolicyState,
): { runId: string; eligible: boolean; reasons?: NeverPathReason[] } {
  if (policy.state === "absent") {
    // No policy ⇒ no evaluation occurred; `reasons` is ABSENT so the caller
    // knows to emit no consult event at all.
    return { runId: input.runId, eligible: false };
  }
  // Canonical clause order; every failing clause is listed, never just the first.
  const reasons: NeverPathReason[] = [];
  if (evaluateNeverAutoMerge(input.diffPaths).park) reasons.push("never-path");
  const scope = evaluateDiffScope(input.diffEntries, input.scope);
  if (scope.reason) reasons.push(scope.reason);
  const v = evaluateVerdict(verdict, input.rebasedAt);
  if (v.reason) reasons.push(v.reason);
  if (policy.state === "off") reasons.push("policy-off");
  return { runId: input.runId, eligible: reasons.length === 0 && policy.state === "on", reasons };
}

/**
 * The repo-consistency oracle as a pure function. `verdictBlockPresent` is
 * DOCUMENTED here as: the ADR's amendment verdict block records the clause-1
 * disposition as accepted. The trap this shape guards against is reading
 * block-present as "the status flipped": a verdict block standing next to a
 * PROPOSED header is itself a violation, and it does NOT wave the
 * implementation or the setting through. A missing/headerless ADR arrives as
 * "PROPOSED" from the CALLER (readAdrStatus), never from this function.
 *
 * Violation names, stable for suite + operator output:
 *   verdict-block-while-proposed · impl-present-while-proposed ·
 *   setting-on-while-proposed · amended-without-accepted-verdict ·
 *   impl-present-while-amended-unaccepted · setting-on-while-amended-unaccepted
 */
export function evaluateTreeConsistency(input: {
  adrStatus: string;
  verdictBlockPresent?: boolean;
  settingOn: boolean;
  implPresent: boolean;
}): { consistent: boolean; violations: string[] } {
  const violations: string[] = [];
  if (input.adrStatus !== "ACCEPTED" && input.adrStatus !== "AMENDED") {
    if (input.verdictBlockPresent === true) violations.push("verdict-block-while-proposed");
    if (input.implPresent) violations.push("impl-present-while-proposed");
    if (input.settingOn) violations.push("setting-on-while-proposed");
  } else if (input.adrStatus === "AMENDED") {
    // Under AMENDED the accepted-disposition verdict block is what licenses
    // the surface; without it the amendment never took effect.
    if (input.verdictBlockPresent !== true) {
      violations.push("amended-without-accepted-verdict");
      if (input.implPresent) violations.push("impl-present-while-amended-unaccepted");
      if (input.settingOn) violations.push("setting-on-while-amended-unaccepted");
    }
  }
  return { consistent: violations.length === 0, violations };
}

/**
 * Consistency-side ADR reader: the leading word of the `- **Status:**` bullet.
 * Missing file or no status bullet ⇒ "PROPOSED" (fail-closed: a headerless ADR
 * is PROPOSED, so the tree reads red rather than green). An unrecognized
 * leading word ⇒ "UNKNOWN". NEVER called by readAutoMergePolicy — docs are
 * not runtime config; this exists for the consistency test.
 */
export function readAdrStatus(opts?: { adrPath?: string; cwd?: string }): "PROPOSED" | "ACCEPTED" | "AMENDED" | "UNKNOWN" {
  const root = resolve(opts?.cwd ?? process.cwd());
  const adrPath = resolve(root, opts?.adrPath ?? DEFAULT_ADR_FILE);
  let text: string;
  try {
    text = readFileSync(adrPath, "utf8");
  } catch {
    return "PROPOSED";
  }
  const word = text.match(/^\s*-\s*\*\*Status:\*\*\s*(\S+)/m)?.[1];
  if (word === "ACCEPTED" || word === "AMENDED" || word === "PROPOSED") return word;
  return word === undefined ? "PROPOSED" : "UNKNOWN";
}

export const NO_PRODUCER_MARKER = "factory_result";

/**
 * The artifact WRITE shape: an object literal `kind: "factory_result"` is how a
 * producer assembles the artifact; consumers COMPARE (`=== "factory_result"`)
 * and prose merely names it, so none of those contain this literal. Blunt, but
 * it separates writers from readers without a parser.
 */
export const PRODUCER_WRITE_SHAPE = `kind: "${NO_PRODUCER_MARKER}"`;

/**
 * The "no real QA producer exists in the production graph" arm, BLUNT BY
 * DESIGN: flag any src file (outside this module, which names the shape it
 * asserts absent) whose text contains the producer write shape
 * `kind: "factory_result"` — the object literal a producer assembles. A
 * consumer's `=== "factory_result"` comparison and a doc comment's prose do
 * not match, so the consult chain itself stays clean while a real producer
 * (A2-era) trips the wire. This is a tripwire, not a parser — v6a must return
 * clean, and any future hit is a human-review event, not an automated verdict.
 */
export function assertNoQaProducerInGraph(
  root: string = resolve(process.cwd(), "src"),
): { clean: boolean; offenders: string[] } {
  const offenders: string[] = [];
  const srcRoot = root;
  const selfRel = relative(root, resolve(root, "fleet/auto-merge-policy.ts")).split(sep).join("/");
  const walk = (dir: string): void => {
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or missing subtree flags nothing; the tripwire is best-effort read-only
    }
    for (const ent of ents) {
      // bun-types widen Dirent.name to `string | Buffer`; every use below needs the string.
      const name = String(ent.name);
      if (name.startsWith(".")) continue;
      const abs = resolve(dir, name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile() || !/\.(?:ts|tsx)$/.test(name)) continue;
      const rel = relative(srcRoot, abs).split(sep).join("/");
      if (rel === selfRel) continue;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes(PRODUCER_WRITE_SHAPE)) offenders.push(rel);
    }
  };
  walk(srcRoot);
  return { clean: offenders.length === 0, offenders };
}
