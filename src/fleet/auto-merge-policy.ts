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
 * Two anchors, kept deliberately apart. The POLICY FILE is operator-local:
 * read under the host cwd/root, guarded, 0600 — per-host config. The CLAUSE-5
 * CARRIER is a factory build artifact: probed beside THIS MODULE (module-URL
 * anchor), never under the dispatched-against repo's cwd — the factory's own
 * infrastructure must arm the clause, not the repo being run against.
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
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { readGuardedFile } from "../providers/allowlist-path.ts";

export const DEFAULT_POLICY_FILE = ".factory/policy.json";
export const POLICY_AUTO_MERGE_APPROVER_ID = "policy:adr-2";

/**
 * The clause-5 carrier files, anchored to THIS MODULE's directory (the
 * factory tree): `carrierRoot/veto-window.ts` plus its suite two levels up.
 * Probed, never imported.
 */
const CARRIER_MODULE = "veto-window.ts";
const CARRIER_TEST = "../../tests/fleet/veto-window.test.ts";
const CARRIER_SYMBOL = "enqueueVetoWindow";

/** The consistency-side ADR reader's default; docs are not runtime config. */
const DEFAULT_ADR_FILE = "docs/decisions/2026-10-02-adr-2-autonomy-approval-surface.md";

export type AutoMergePolicyState =
  | { state: "absent" }
  | { state: "off"; stateReason: "policy-garbled" | "policy-unreadable" | "declared-off" | "clause5-carrier-absent" }
  | { state: "on" };

export type QaVerdict = { status: string; producedAt: string; escalated?: boolean };

/** Failing-clause names, in the ADR-2 contract's vocabulary. */
export type NeverPathReason =
  | "never-path"
  | "scope"
  | "verdict-absent"
  | "verdict-stale"
  | "verdict-escalated"
  | "verdict-rejected"
  | "policy-off";

/** Satisfied-clause names emitted when the consult is eligible. */
export type SatisfiedClauseReason = "never-path-clear" | "scope-ok" | "verdict-fresh" | "policy-on";

export type ConsultReason = NeverPathReason | SatisfiedClauseReason;

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

/**
 * Segment-wise lexical normalization: backslashes become separators, `//`
 * collapses, `.` segments drop, `..` pops against the stack (a leading `..`
 * stays — there is nothing above the caller's root to pop into). Lexical only:
 * the never-list is compared against the path a producer CLAIMS, then
 * case-folded at the compare site.
 */
function normalizeRel(p: string): string {
  const stack: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else stack.push("..");
      continue;
    }
    stack.push(seg);
  }
  return stack.join("/");
}

/** Comment text must never arm the carrier probe; strip before matching. */
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;
const stripComments = (src: string): string => src.replace(BLOCK_COMMENT_RE, " ").replace(LINE_COMMENT_RE, " ");

/**
 * Static clause-5 probe, anchored to the carrierRoot (default: THIS MODULE's
 * directory — the factory build tree). Text, never import — importing would
 * turn "carrier absent" into a module-resolution crash instead of a state.
 * Comments are stripped first; both the declaration form and the re-export
 * form count; the carrier's SUITE must also name the symbol.
 * shortcut: a determined stub still passes — semantic proof is the operator's
 * `vetoWindowQueueLive` assertion; the probe is a tripwire, not a verifier.
 */
function clause5CarrierPresent(carrierRoot: string): boolean {
  try {
    const mod = stripComments(readFileSync(resolve(carrierRoot, CARRIER_MODULE), "utf8"));
    if (
      !new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|class)\\s+${CARRIER_SYMBOL}\\b`).test(
        mod,
      ) &&
      !new RegExp(`export\\s*\\{[^}]*\\b${CARRIER_SYMBOL}\\b`).test(mod)
    ) {
      return false;
    }
    return stripComments(readFileSync(resolve(carrierRoot, CARRIER_TEST), "utf8")).includes(CARRIER_SYMBOL);
  } catch {
    return false;
  }
}

export function readAutoMergePolicy(opts?: {
  policyPath?: string;
  cwd?: string;
  /**
   * TEST/PRODUCER SEAM for the carrier probe only (same trusted-config class
   * as run-completion's consultContext): production callers never pass it, and
   * the probe defaults to this module's own directory. The policy FILE read is
   * untouched — operator-local per-host config stays anchored to cwd/hostRoot.
   */
  carrierRoot?: string;
}): AutoMergePolicyState {
  const root = resolve(opts?.cwd ?? process.cwd());
  const policyPath = resolve(root, opts?.policyPath ?? DEFAULT_POLICY_FILE);
  const carrierRoot = opts?.carrierRoot ?? fileURLToPath(new URL(".", import.meta.url));
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
  // queue actually exists in the factory tree. Any miss is the same state —
  // the point of clause 5 is that ON is unreachable while the carrier is
  // missing.
  if (parsed.adr2AcceptedOn === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.adr2AcceptedOn)) {
    return { state: "off", stateReason: "clause5-carrier-absent" };
  }
  if (parsed.vetoWindowQueueLive !== true) return { state: "off", stateReason: "clause5-carrier-absent" };
  if (!clause5CarrierPresent(carrierRoot)) return { state: "off", stateReason: "clause5-carrier-absent" };
  return { state: "on" };
}

/** DENY-first never-list: normalized, then compared case-insensitively —
 * the list is ours (lowercase, controlled), the diff paths are the host's,
 * and a case-insensitive filesystem must not bypass the gate by spelling. */
export function evaluateNeverAutoMerge(diffPaths: readonly string[]): { park: boolean; reason?: "never-path" } {
  for (const raw of diffPaths) {
    const p = normalizeRel(raw).toLowerCase();
    if (NEVER_AUTO_MERGE_PREFIXES.some((prefix) => p.startsWith(prefix.toLowerCase()))) {
      return { park: true, reason: "never-path" };
    }
    if ((NEVER_AUTO_MERGE_PATHS as readonly string[]).some((n) => n.toLowerCase() === p)) {
      return { park: true, reason: "never-path" };
    }
  }
  return { park: false };
}

/**
 * Glob → anchored RegExp, mirroring src/fixloop/feedback-run.ts's
 * `globToRegExp` (:484-507) EXACTLY — fidelity is the requirement, since this
 * restatement polices the same scope vocabulary the loop enforces: a double
 * star followed by a slash matches zero or more whole segments, a trailing or
 * non-slashed `**` is `.*`, `*` stays within a segment, `?` is exactly one
 * non-separator character, everything else escaped. Restated per ADR-2
 * clause 4 / story AC3 — never imported (see the module doc).
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` = zero or more whole segments; a trailing/non-slashed `**` is `.*`.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** DENY WINS: a deny hit is `scope-requires-privilege` — retrying can never help. */
export function evaluateDiffScope(
  diffEntries: readonly DiffEntry[],
  scope: DiffScope,
): { park: boolean; reason?: typeof SCOPE_REQUIRES_PRIVILEGE | typeof OUT_OF_SCOPE_DIFF } {
  for (const entry of diffEntries) {
    const p = normalizeRel(entry.path);
    if (scope.deniedPathGlobs.some((d) => globToRegExp(normalizeRel(d.glob)).test(p))) {
      return { park: true, reason: SCOPE_REQUIRES_PRIVILEGE };
    }
  }
  for (const entry of diffEntries) {
    const p = normalizeRel(entry.path);
    const allowed = scope.allowedPathGlobs.some((g) => globToRegExp(normalizeRel(g)).test(p));
    if (!allowed || !scope.permittedActions.includes(entry.action)) {
      return { park: true, reason: OUT_OF_SCOPE_DIFF };
    }
  }
  return { park: false };
}

/** The fleet-result vocabulary value a passing QA verdict carries (sc2-7 precedent). */
export const PASSING_QA_STATUSES: ReadonlySet<string> = new Set(["approved"]);

/**
 * ADR-2 clause 2's minimal consumption pin: presence, freshness, escalation,
 * passing status. The producer (A2) may extend QaVerdict adds-only; the order
 * is load-bearing — stale is judged before escalated, and both before the
 * passing-status arm, so a verdict failing several clauses reports the
 * earliest one. Fresh means strictly AFTER the rebase (same-ms is not fresh —
 * the verdict must postdate what it blesses) and not future-dated.
 */
export function evaluateVerdict(
  verdict: QaVerdict | undefined,
  rebasedAt?: Date,
  now: Date = new Date(),
): { ok: boolean; reason?: "verdict-absent" | "verdict-stale" | "verdict-escalated" | "verdict-rejected" } {
  if (verdict === undefined) return { ok: false, reason: "verdict-absent" };
  const produced = new Date(verdict.producedAt).getTime();
  if (Number.isNaN(produced) || produced <= (rebasedAt?.getTime() ?? 0) || produced > now.getTime()) {
    return { ok: false, reason: "verdict-stale" };
  }
  if (verdict.escalated === true) return { ok: false, reason: "verdict-escalated" };
  if (!PASSING_QA_STATUSES.has(verdict.status)) return { ok: false, reason: "verdict-rejected" };
  return { ok: true };
}

/**
 * The consult as a pure function. On ELIGIBLE the `reasons` list names the
 * SATISFIED requirements in canonical order (`never-path-clear`, `scope-ok`,
 * `verdict-fresh`, `policy-on`); on any failing clause it names the failures
 * in the same order using the contract clause names. Both diff projections
 * (`diffPaths` and `diffEntries`) feed the never-check — an entry present in
 * only one must not skip the gate — and an EMPTY diffEntries parks
 * out-of-scope BEFORE the allow-glob pass: zero reviewed changes is not
 * mergeable, and no allow glob can bless a vacuous diff. When the policy is
 * present but OFF, the result carries the loader's state passthrough
 * (`policyState`/`policyOff`) for the caller's consult event.
 */
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
): {
  runId: string;
  eligible: boolean;
  reasons?: ConsultReason[];
  policyState?: {
    state: "off";
    stateReason?: "policy-garbled" | "policy-unreadable" | "declared-off" | "clause5-carrier-absent";
  };
  policyOff?: string;
} {
  if (policy.state === "absent") {
    // No policy ⇒ no evaluation occurred; `reasons` is ABSENT so the caller
    // knows to emit no consult event at all.
    return { runId: input.runId, eligible: false };
  }
  // Canonical clause order; every failing clause is listed, never just the first.
  const reasons: NeverPathReason[] = [];
  if (evaluateNeverAutoMerge([...input.diffPaths, ...input.diffEntries.map((e) => e.path)]).park) {
    reasons.push("never-path");
  }
  if (input.diffEntries.length === 0) reasons.push("scope");
  const scope = evaluateDiffScope(input.diffEntries, input.scope);
  if (scope.reason) reasons.push("scope");
  const v = evaluateVerdict(verdict, input.rebasedAt);
  if (v.reason) reasons.push(v.reason);
  if (policy.state === "off") reasons.push("policy-off");
  if (reasons.length === 0 && policy.state === "on") {
    return {
      runId: input.runId,
      eligible: true,
      reasons: ["never-path-clear", "scope-ok", "verdict-fresh", "policy-on"],
    };
  }
  const result: {
    runId: string;
    eligible: boolean;
    reasons?: ConsultReason[];
    policyState?: {
      state: "off";
      stateReason?: "policy-garbled" | "policy-unreadable" | "declared-off" | "clause5-carrier-absent";
    };
    policyOff?: string;
  } = { runId: input.runId, eligible: false, reasons };
  if (policy.state === "off") {
    result.policyState = { state: "off", stateReason: policy.stateReason };
    result.policyOff = policy.stateReason;
  }
  return result;
}

/**
 * The repo-consistency oracle as a pure function. `verdictBlockPresent` is
 * DOCUMENTED here as: the ADR's amendment verdict block exists. Under
 * AMENDED, the block's CLAUSE-1 DISPOSITION (`clause1Accepted`, read from the
 * tree by `readVerdictBlock`) is the accepted-verdict condition — fail-closed
 * on anything else. The trap this shape guards against is reading
 * block-present as "the status flipped": a verdict block standing next to a
 * PROPOSED header is itself a violation, and it does NOT wave the
 * implementation or the setting through. A missing/headerless ADR arrives as
 * "PROPOSED" from the CALLER (readAdrStatus); any other unrecognized header
 * word arrives as-is and fails closed under the `...-while-unknown` names.
 *
 * Violation names, stable for suite + operator output:
 *   verdict-block-while-proposed · impl-present-while-proposed ·
 *   setting-on-while-proposed · amended-without-accepted-verdict ·
 *   impl-present-while-amended-unaccepted ·
 *   setting-on-while-amended-unaccepted ·
 *   verdict-block-while-unknown · impl-present-while-unknown ·
 *   setting-on-while-unknown
 */
export function evaluateTreeConsistency(input: {
  adrStatus: string;
  verdictBlockPresent?: boolean;
  clause1Accepted?: boolean;
  settingOn: boolean;
  implPresent: boolean;
}): { consistent: boolean; violations: string[] } {
  const violations: string[] = [];
  const known =
    input.adrStatus === "ACCEPTED" || input.adrStatus === "AMENDED" || input.adrStatus === "PROPOSED";
  if (!known) {
    // An unrecognized header word fails closed under its own name — never
    // mislabeled as PROPOSED, so the operator sees what the tree actually says.
    if (input.verdictBlockPresent === true) violations.push("verdict-block-while-unknown");
    if (input.implPresent) violations.push("impl-present-while-unknown");
    if (input.settingOn) violations.push("setting-on-while-unknown");
  } else if (input.adrStatus === "PROPOSED") {
    if (input.verdictBlockPresent === true) violations.push("verdict-block-while-proposed");
    if (input.implPresent) violations.push("impl-present-while-proposed");
    if (input.settingOn) violations.push("setting-on-while-proposed");
  } else if (input.adrStatus === "AMENDED") {
    // Under AMENDED the clause-1 ACCEPTED disposition is what licenses the
    // surface; anything else — block absent, disposition AMENDED/REJECTED,
    // unreadable — leaves the amendment inert.
    if (input.clause1Accepted !== true) {
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
 * leading word ⇒ "UNKNOWN". Fenced code blocks are stripped first — a Status
 * bullet QUOTED inside ``` fences is prose about a status, not a status.
 * NEVER called by readAutoMergePolicy — docs are not runtime config; this
 * exists for the consistency test.
 */
export function readAdrStatus(opts?: { adrPath?: string; cwd?: string }): "PROPOSED" | "ACCEPTED" | "AMENDED" | "UNKNOWN" {
  const text = readAdrText(opts);
  if (text === undefined) return "PROPOSED";
  const stripped = text.replace(/```[\s\S]*?```/g, " ");
  const word = stripped.match(/^\s*-\s*\*\*Status:\*\*\s*(\S+)/m)?.[1];
  if (word === "ACCEPTED" || word === "AMENDED" || word === "PROPOSED") return word;
  return word === undefined ? "PROPOSED" : "UNKNOWN";
}

/**
 * Consistency-side verdict-block reader: does the ADR carry an
 * `## Operator verdict` block, and what did it dispose of clause 1?
 * No block (or unreadable file) ⇒ `{present: false, clause1Accepted: undefined}`.
 * With a block: the clause-1 table row's disposition — ACCEPTED ⇒ true,
 * ANYTHING else (AMENDED, REJECTED, row missing) ⇒ false. Same docs-not-config
 * caveat as readAdrStatus: consistency test only.
 */
export function readVerdictBlock(opts?: { adrPath?: string; cwd?: string }): {
  present: boolean;
  clause1Accepted: boolean | undefined;
} {
  const text = readAdrText(opts);
  if (text === undefined) return { present: false, clause1Accepted: undefined };
  const heading = text.match(/^##\s+Operator verdict\b.*$/m);
  if (!heading) return { present: false, clause1Accepted: undefined };
  const row =
    text.slice((heading.index ?? 0) + heading[0].length).match(/^\s*\|\s*1\b.*$/m)?.[0] ?? "";
  return { present: true, clause1Accepted: row.includes("ACCEPTED") };
}

function readAdrText(opts?: { adrPath?: string; cwd?: string }): string | undefined {
  const root = resolve(opts?.cwd ?? process.cwd());
  try {
    return readFileSync(resolve(root, opts?.adrPath ?? DEFAULT_ADR_FILE), "utf8");
  } catch {
    return undefined;
  }
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
  const selfRel = "fleet/auto-merge-policy.ts";
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
      // readdir's dirent types do not resolve symlinks: stat the target so a
      // symlinked directory is walked instead of skipped (broken link ⇒ skip).
      let isDir = ent.isDirectory();
      if (!isDir && ent.isSymbolicLink()) {
        try {
          isDir = statSync(abs).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) {
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
