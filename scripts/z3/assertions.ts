/**
 * Z3 — the round verdict, re-derived from the leg files ON DISK.
 *
 * One pure function per acceptance criterion; each takes the raw files
 * (`{name, text}`) and returns problems (empty = the AC holds). Nothing here
 * trusts a driver's own `ok`-shaped fields: every verdict is recomputed from
 * the recorded observations (boxes, records, receipts, timestamps, the CLI's
 * own stdout line, the event types), so the fixture tier can prove each AC's
 * negative control FAILS on bad evidence and the live round asserts the same
 * functions over what actually landed.
 *
 * Provenance is the sha256 registry, which the round commits as its
 * `-z3-round-manifest.json` — `registryFromManifest` rebuilds it for a later
 * audit. AC1 refuses to judge without one.
 *
 * Absent-not-0: a leg that did not run contributes nothing — an absent leg is
 * an unproven claim, which is a problem, never a pass.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BankIdSchema } from "../../src/hindsight/schemas.ts";
import { QA_LENS } from "../../src/qa/findings.ts";
import { forbiddenOrigin } from "../p0-9/leg-lib.ts";
import { credentialHits, dashStamp, sha256, Z3_LEG_ORIGIN } from "./evidence.ts";
import { FLEET_APPROVE_STDIN, lastJson } from "./leg-drivers.ts";
import {
  type Z3EvidenceLeg,
  Z3_APPROVED_CASE,
  Z3_CLEANUP_LEG,
  Z3_LEGS,
  Z3_MANIFEST_LEG,
  Z3_MAX_FLEET_RUNS,
  Z3_STEP,
  Z3_TEMPLATE_ID,
  Z3_WORK_ID,
} from "./round-plan.ts";

export interface LegFile {
  name: string;
  text: string;
}

type Json = Record<string, unknown>;
interface Leg {
  name: string;
  text: string;
  leg: string;
  stamp: string;
  json: Json;
}

const NAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-z3-([a-z-]+)\.json$/;
const KNOWN_LEGS = new Set<string>([...Z3_LEGS, Z3_CLEANUP_LEG, Z3_MANIFEST_LEG]);

/** Every `*-z3-*.json` in the evidence dir (operator-GO.json and other files are not legs). */
export function readLegFiles(dir: string): LegFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.includes("-z3-") && n.endsWith(".json"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

/** Leg files whose filename stamp is at/after `since` — one round's window of a shared dir. */
export function filesSince(files: readonly LegFile[], since: Date): LegFile[] {
  const from = dashStamp(since);
  return files.filter((f) => (NAME_RE.exec(f.name)?.[1] ?? "") >= from);
}

/** Rebuilds the writer registry from the committed round manifest (newest one in `files`), or null. */
export function registryFromManifest(files: readonly LegFile[]): Map<string, string> | null {
  const manifest = [...files].sort((a, b) => a.name.localeCompare(b.name)).filter((f) => f.name.endsWith(`-z3-${Z3_MANIFEST_LEG}.json`)).at(-1);
  if (manifest === undefined) return null;
  try {
    const j = JSON.parse(manifest.text) as { files?: Record<string, unknown> };
    const entries = Object.entries(j.files ?? {}).filter((e): e is [string, string] => typeof e[1] === "string");
    // The manifest cannot list its own hash; its bytes are what the audit re-reads.
    return new Map([...entries, [manifest.name, sha256(manifest.text)]]);
  } catch {
    return null;
  }
}

/** Parses every z3 leg file; unparseable/misnamed files become problems (and are dropped). */
function parse(files: readonly LegFile[]): { legs: Leg[]; problems: string[] } {
  const legs: Leg[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const m = NAME_RE.exec(f.name);
    if (!m) {
      problems.push(`${f.name}: not a z3 leg filename (<ISO-dash>-z3-<leg>.json)`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(f.text);
    } catch {
      problems.push(`${f.name}: not JSON`);
      continue;
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      problems.push(`${f.name}: not a JSON object`);
      continue;
    }
    legs.push({ name: f.name, text: f.text, stamp: m[1] as string, leg: m[2] as string, json: json as Json });
  }
  // Fire order: the filename stamp IS the write instant (AC1 checks it).
  legs.sort((a, b) => a.name.localeCompare(b.name));
  return { legs, problems };
}

const of = (legs: Leg[], leg: Z3EvidenceLeg) => legs.filter((l) => l.leg === leg);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
const at = (l: Leg) => Date.parse(String(l.json.writtenAt));

// ─── AC1 ─────────────────────────────────────────────────────────────────────

/**
 * AC1 (make-or-break): all 11 legs present in the counts the round shape
 * implies, each file written by ITS OWN driver — filename leg = content leg,
 * filename stamp = writtenAt, the round's fork rev on every file, bytes equal
 * to what the writer registered, every registered file present — and the arc
 * green end to end.
 */
export function assertAc1RoundComplete(
  files: readonly LegFile[],
  opts: { forkRev: string; registry: ReadonlyMap<string, string> | null; qaLegs?: number },
): string[] {
  const { legs, problems } = parse(files);
  if (opts.registry === null) problems.push("no writer registry / round manifest — provenance is unproven");
  for (const l of legs) {
    const j = l.json;
    if (!KNOWN_LEGS.has(l.leg)) {
      problems.push(`${l.name}: unknown leg ${l.leg}`);
      continue;
    }
    if (j.leg !== l.leg) problems.push(`${l.name}: content says leg ${String(j.leg)} — a copied file`);
    if (j.origin !== Z3_LEG_ORIGIN[l.leg as Z3EvidenceLeg]) {
      problems.push(`${l.name}: origin ${JSON.stringify(j.origin)} is not the ${l.leg} driver — not written by its own driver`);
    }
    const w = Date.parse(String(j.writtenAt));
    if (!Number.isFinite(w) || dashStamp(new Date(w)) !== l.stamp) {
      problems.push(`${l.name}: writtenAt ${String(j.writtenAt)} disagrees with the filename stamp — renamed or reconstructed post-hoc`);
    }
    if (j.swarmclawForkRev !== opts.forkRev) problems.push(`${l.name}: swarmclawForkRev ${String(j.swarmclawForkRev)} ≠ round rev ${opts.forkRev}`);
    if (j.exitCode !== 0) problems.push(`${l.name}: exitCode ${String(j.exitCode)} — the arc is not green`);
    if (typeof j.stdoutTail !== "string" || typeof j.stderrTail !== "string") problems.push(`${l.name}: missing stdoutTail/stderrTail`);
    if (!(strs(j.observability)?.length ?? 0)) problems.push(`${l.name}: no observability lines`);
    if (opts.registry !== null && opts.registry.get(l.name) !== sha256(l.text)) {
      problems.push(`${l.name}: bytes are not what the leg driver wrote (unregistered or edited) — hand-copied/reconstructed evidence`);
    }
  }
  if (opts.registry !== null) {
    const present = new Set(files.map((f) => f.name));
    for (const name of opts.registry.keys()) if (!present.has(name)) problems.push(`${name}: registered by the writer but missing from the evidence`);
  }
  // Counts the round shape implies: one per fleet run, one per QA leg, one otherwise.
  const qa = opts.qaLegs ?? QA_LENS.length;
  const want: Record<string, number> = { "kill-and-provision": qa + 1, "box-forensics": qa + 1, "qa-run-observe": qa, "findings-retain": qa };
  for (const leg of Z3_LEGS) {
    const n = of(legs, leg).length;
    if (n === 0) problems.push(`leg ${leg} is missing`);
    else if (n !== (want[leg] ?? 1)) problems.push(`leg ${leg} appears ${n}×, the round shape implies ${want[leg] ?? 1}`);
  }

  // The arc: trigger fired the z3 template; one workId stamp across every
  // fleet run; every fleet run has a factory_result (F-011); priming closed
  // inside the protocol; the branch took the human-decision case.
  const trigger = of(legs, "trigger")[0];
  if (trigger !== undefined && trigger.json.templateId !== Z3_TEMPLATE_ID) problems.push(`trigger fired ${String(trigger.json.templateId)}`);
  const provs = of(legs, "kill-and-provision");
  const runIds = provs.map((l) => String(l.json.runId));
  const code = provs.find((l) => l.json.stepId === Z3_STEP.codeRun);
  const stamp = code === undefined ? null : Z3_WORK_ID.codeStamp(String(code.json.workId));
  if (code !== undefined && stamp === null) problems.push(`code run workId ${String(code.json.workId)} is not w:z3-<stamp>-code`);
  if (stamp !== null) {
    for (const l of provs.filter((p) => p !== code)) {
      const lens = String(l.json.stepId).replace(/^qa-leg-/, "");
      if (l.json.workId !== Z3_WORK_ID.qa(stamp, lens)) {
        problems.push(`${l.name}: workId ${String(l.json.workId)} is not this fire's ${Z3_WORK_ID.qa(stamp, lens)}`);
      }
    }
  }
  const branch = of(legs, "branch-and-complete").at(-1);
  if (branch !== undefined) {
    const results = Array.isArray(branch.json.factoryResults) ? (branch.json.factoryResults as Json[]) : [];
    for (const id of runIds) {
      if (!results.some((r) => r.runId === id)) problems.push(`no factory_result for fleet run ${id} (F-011)`);
    }
    const taken = branch.json.branchTaken as Json | null | undefined;
    if (taken?.stepId !== Z3_STEP.branch) problems.push("no branch_taken witness on the z3-branch step");
    else if (taken.caseId !== Z3_APPROVED_CASE) problems.push(`the branch took case ${String(taken.caseId)}, not ${Z3_APPROVED_CASE}`);
    if (branch.json.runStatus !== "completed") problems.push(`protocol run ended ${String(branch.json.runStatus)}`);
  }
  const retained = new Set(of(legs, "findings-retain").flatMap((l) => strs(l.json.documentIds) ?? []));
  for (const p of of(legs, "priming-recall")) {
    const cited = (strs(p.json.recalledDocumentIds) ?? []).filter((id) => retained.has(id));
    if (p.json.directive !== "kg_context" || cited.length === 0) {
      problems.push(`${p.name}: the code run's <kg_context> cites no finding this round retained — priming round-trip open`);
    }
  }
  return problems;
}

// ─── AC2 ─────────────────────────────────────────────────────────────────────

/**
 * D-1 (docs/planning/v6-crossrepo-contract.md "Z3 round record"): ADR-2 is
 * ACCEPTED and G1 shipped its fail-closed machinery (src/fleet/auto-merge-policy.ts
 * + the run-completion consult), but ON is structurally unreachable until the
 * clause-5 veto-window carrier (`enqueueVetoWindow`) is in the tree.
 */
export const ADR2_LICENSE = "treating ADR-2 as license to auto-merge while ON is structurally unreachable (the clause-5 veto-window carrier `enqueueVetoWindow` is not in the tree) fails";

/** AC2: park → recorded (scrypt-verified, stdin, labeled) decision → branch; nothing auto-merges. */
export function assertAc2ApproveRecorded(files: readonly LegFile[]): string[] {
  const { legs } = parse(files);
  const problems: string[] = [];
  for (const b of of(legs, "branch-and-complete")) {
    const types = strs(b.json.eventTypes);
    if (types === undefined) problems.push(`${b.name}: no recorded event types — no-auto-merge is unproven`);
    else if (types.some((t) => /merge/i.test(t))) problems.push(`${b.name}: a merge event — ${ADR2_LICENSE}`);
  }
  for (const l of legs) if (!Number.isFinite(at(l))) problems.push(`${l.name}: unreadable writtenAt — the decision order is unproven`);
  // INV-Z3-2: the ADR-2 policy state probed at the fire, read-only — absent/off only.
  const trigger = of(legs, "trigger")[0];
  if (trigger !== undefined) {
    const policy = trigger.json.autoMergePolicy as Json | undefined;
    if (policy === undefined || typeof policy.state !== "string") problems.push("the ADR-2 auto-merge policy state was not recorded at the fire — INV-Z3-2 is unproven");
    else if (policy.state === "on") problems.push(`the ADR-2 auto-merge policy read ON at the fire — ${ADR2_LICENSE}`);
  }
  const park = of(legs, "approval-park").at(-1);
  if (park === undefined || park.json.status !== "awaiting-approval" || park.json.terminal !== false) {
    problems.push("no recorded approval park (awaiting-approval, non-terminal)");
    return problems;
  }
  const runId = park.json.runId;
  const approve = of(legs, "approve").find((l) => l.json.runId === runId && at(l) > at(park));
  const branch = of(legs, "branch-and-complete").find((l) => l.json.runId === runId);
  const branchApproved = (branch?.json.branchTaken as Json | null | undefined)?.caseId === Z3_APPROVED_CASE;
  if (approve === undefined) {
    problems.push(
      `no recorded approve decision for ${String(runId)} after the park${branch ? ` — the round proceeded past the park undecided${branchApproved ? " yet the branch claims a human decision" : ""}` : ""}`,
    );
    return problems;
  }
  const a = approve.json;
  // Re-derived from the CLI's own decided line, never the driver's flag.
  const said = lastJson(String(a.stdoutTail ?? ""));
  const verified = a.cliExitCode === 0 && said.outcome === "decided" && str(a.approverId) !== undefined && said.approverId === a.approverId;
  if (str(a.approverId) === undefined) problems.push("approve records no approver id");
  if (said.approverId === "policy:adr-2" || a.approverId === "policy:adr-2") problems.push(`the decision was the ADR-2 policy's, not a human's — ${ADR2_LICENSE}`);
  if (!verified) problems.push("approve is not scrypt-verified (the CLI's decided line does not name the allowlisted approver)");
  if (said.state !== "approved") problems.push(`decided state ${String(said.state)}`);
  if (a.tokenChannel !== "stdin") problems.push(`approve token channel ${String(a.tokenChannel)}, not stdin`);
  if (a.decisionSource !== FLEET_APPROVE_STDIN) {
    problems.push(
      `decision source ${String(a.decisionSource)} — only ${FLEET_APPROVE_STDIN} decides (ADR-1 §3); ${ADR2_LICENSE}`,
    );
  }
  if (typeof a.scripted !== "boolean") problems.push("approve carries no scripted label");
  if (a.executedBy !== "human" && a.executedBy !== "driver") problems.push(`approve executedBy ${String(a.executedBy)}`);
  if (a.executedBy === "driver" && a.scripted !== true) problems.push("a driver-executed approve is not labeled scripted: true");
  if (branch !== undefined && !(at(branch) > at(approve))) problems.push("branch-and-complete does not follow the approve decision");
  return problems;
}

// ─── AC3 ─────────────────────────────────────────────────────────────────────

/** AC3: per fleet run, one VM named and HELD, forensics proves exactly one, teardown reaps it; ≤ cap; sequential. */
export function assertAc3ExactlyOneBox(files: readonly LegFile[]): string[] {
  const { legs } = parse(files);
  const problems: string[] = [];
  const provs = of(legs, "kill-and-provision");
  if (provs.length === 0) problems.push("no kill-and-provision leg — the box count is unproven");
  const runIds = provs.map((l) => String(l.json.runId));
  if (new Set(runIds).size !== runIds.length) problems.push("a runId was provisioned twice");
  if (runIds.length > Z3_MAX_FLEET_RUNS) problems.push(`${runIds.length} fleet runs exceed Z3_MAX_FLEET_RUNS ${Z3_MAX_FLEET_RUNS}`);
  const earlier: string[] = [];
  for (const p of provs) {
    const id = String(p.json.runId);
    const live = strs(p.json.liveBoxesForRun) ?? [];
    if (live.length !== 1) problems.push(`${id}: ${live.length} live boxes (exactly one required)`);
    else if (live[0] !== p.json.vmName) problems.push(`${id}: live box ${live[0]} is not the named VM ${String(p.json.vmName)}`);
    const samples = p.json.boxCountSamples;
    if (!Array.isArray(samples) || samples.length < 2 || !samples.every((n) => n === 1)) {
      problems.push(`${id}: box count samples ${JSON.stringify(samples)} — the one box did not HOLD across the stability window`);
    }
    const before = strs(p.json.inventoryBefore);
    if (before === undefined) problems.push(`${id}: no inventory read before provision`);
    else if (before.some((b) => earlier.includes(b))) problems.push(`${id}: provisioned while an earlier run's box was live — not sequential`);
    earlier.push(...live);
    const forensics = of(legs, "box-forensics").filter((f) => f.json.runId === id);
    if (forensics.length !== 1) {
      problems.push(`${id}: ${forensics.length} box-forensics legs — the box count is unproven`);
      continue;
    }
    const f = (forensics[0] as Leg).json;
    const fLive = strs(f.liveBoxesForRun) ?? [];
    if (fLive.length !== 1 || fLive[0] !== f.recordVmName) problems.push(`${id}: forensics live boxes ≠ the record's vmName`);
    if (f.recordRunId !== id) problems.push(`${id}: forensics re-read no run record`);
    const after = strs(f.afterTeardownBoxesForRun);
    if (after === undefined || after.length !== 0) problems.push(`${id}: teardown did not reap the box (or was not read)`);
  }
  return problems;
}

// ─── AC4 ─────────────────────────────────────────────────────────────────────

/** AC4: a kill that landed IN the submit window + re-drive — one box, one booking, the run record untouched, state reused. */
export function assertAc4CrashWindow(files: readonly LegFile[]): string[] {
  const { legs } = parse(files);
  const legsOf = of(legs, "crash-window-redrive");
  if (legsOf.length !== 1) return [`${legsOf.length} crash-window-redrive legs (exactly one required)`];
  const j = (legsOf[0] as Leg).json;
  const problems: string[] = [];
  if (j.stepStatusAtKill !== "submitting") problems.push(`the kill landed at ${String(j.stepStatusAtKill)}, not inside the submit window`);
  if (j.heldAtKill !== true) problems.push("no held-submit witness at the kill — the kill did not land inside the window");
  // Re-derived from the recorded gate journal, never the driver's flags.
  const gj = Array.isArray(j.gateJournal) ? (j.gateJournal as Json[]) : null;
  const killedAt = Date.parse(String(j.killedAt));
  if (gj === null) problems.push("no gate journal recorded — the window witness is unproven");
  else {
    if (!gj.some((l) => l.phase === "held" && Number(l.at) <= killedAt + 1000)) problems.push("the gate journal shows no hold at/before the kill");
    // fail-closed at the journal's 1 s resolution: an end line in the kill's own second counts as before it
    if (gj.some((l) => (l.phase === "expired" || l.phase === "aborted" || l.phase === "exec") && Number(l.at) <= killedAt)) {
      problems.push("the hold had already expired/aborted/exec'd before the kill");
    }
    const execs = gj.filter((l) => l.phase === "exec").length;
    if (execs !== 1) problems.push(`the gate journal shows ${execs} fleet-submit execs (exactly one required)`);
    const released = gj.find((l) => l.phase === "released");
    const retainDoneAt = Date.parse(String(j.retainDoneAt));
    if (released === undefined || !(Number(released.at) >= Math.floor(retainDoneAt / 1000) * 1000)) {
      problems.push("the gate journal does not show the release after the last retain");
    }
  }
  if (j.releasedAfterRetain !== true) problems.push("the held submit was not released after the last retain — the priming witness is a race");
  if (j.submitExecs !== 1) problems.push(`${String(j.submitExecs)} fleet-submit execs across the kill + re-drive (exactly one required)`);
  const req = str(j.requestIdBeforeKill);
  if (req === undefined || j.requestIdAfterRedrive !== req) problems.push("the re-drive did not reuse the persisted requestId");
  const records = Array.isArray(j.recordsForRequestId) ? (j.recordsForRequestId as Json[]) : [];
  if (records.length !== 1) problems.push(`${records.length} run records for the requestId — the re-drive recreated the run record`);
  else if (records[0]?.runId !== j.runId) problems.push("the surviving run record names another runId");
  const atKill = j.recordAtKill as Json | null | undefined;
  const after = records[0];
  if (atKill?.state === "present") {
    if (after === undefined || after.runId !== atKill.runId || after.createdAt !== atKill.createdAt) {
      problems.push("the re-drive mutated or recreated the run record (runId/createdAt changed across the kill)");
    }
  } else if (atKill?.state === "absent") {
    // Explicit witness: no record at the kill ⇒ the surviving one was born after it.
    if (after !== undefined && !(Date.parse(String(after.createdAt)) >= Date.parse(String(j.killedAt)))) {
      problems.push("the record predates the kill yet was absent at it — the window witness is inconsistent");
    }
  } else {
    problems.push("no record-at-kill witness — whether the record survived the kill is unproven");
  }
  const samples = Array.isArray(j.boxCountSamples) ? (j.boxCountSamples as unknown[]) : [];
  if (samples.length === 0 || !samples.every((n) => typeof n === "number")) problems.push("box count across the re-drive is unproven");
  else if ((samples as number[]).some((n) => n > 1)) problems.push("the re-drive provisioned a second box for the runId");
  const gate = j.gateAdmissionsForRequest;
  const group = j.groupReservationsForRequest;
  if (typeof gate !== "number" || typeof group !== "number") problems.push("ledger bookings unread — double-booking is unproven");
  else {
    if (gate > 1 || group > 1) problems.push(`gate ${gate} / group ${group} bookings — the re-drive double-booked spend`);
    if (gate + group === 0) problems.push("no ledger booking for the request — spend escaped the ledger");
  }
  return problems;
}

// ─── AC5 ─────────────────────────────────────────────────────────────────────

const AGENT_TOKEN_ID_RE = /^mgat-[0-9a-f]{24}$/;

function gatewayProblems(name: string, g: unknown): string[] {
  const o = g as Json | null | undefined;
  const origin = str(o?.origin);
  const out: string[] = [];
  if (origin === undefined) return [`${name}: the gateway assertion logs no origin`];
  try {
    const u = new URL(origin);
    if (u.username !== "" || u.password !== "") out.push(`${name}: gateway origin carries credentials`);
  } catch {
    out.push(`${name}: gateway origin ${origin} is not a URL`);
  }
  if (forbiddenOrigin(origin) !== null) out.push(`${name}: gateway origin ${origin} is a wrong-instance trap port`);
  if (!AGENT_TOKEN_ID_RE.test(String(o?.agentTokenId))) out.push(`${name}: the gateway assertion names no M2.1 agent-token id`);
  return out;
}

/**
 * AC5: findings retained host-side only; no box WRITE credential; gateway
 * origin + agent-token id logged. Live, the host side is the factory host
 * client's own journaled calls; the box half rests on the memgate issuance
 * ledger — the only path a box has to bank-write scope (INV-MG) — filtered to
 * non-recall verbs (dispatch's per-run recall key is expected, not a write).
 */
export function assertAc5HostSideRetain(files: readonly LegFile[]): string[] {
  const { legs } = parse(files);
  const problems: string[] = [];
  const retains = of(legs, "findings-retain");
  if (retains.length === 0) problems.push("no findings-retain leg — host-side retain is unproven");
  for (const l of legs) {
    const traces = Array.isArray(l.json.retainTraces) ? (l.json.retainTraces as Json[]) : [];
    if (traces.some((t) => t.side !== "host")) problems.push(`${l.name}: a finding was retained from inside a box (F10/INV-7)`);
  }
  for (const r of retains) {
    if (r.json.retainSide !== "host") problems.push(`${r.name}: retain side ${String(r.json.retainSide)}`);
    if (!Array.isArray(r.json.retainTraces)) problems.push(`${r.name}: no retain traces — the retain side is unproven`);
    else {
      const traced = [...new Set((r.json.retainTraces as Json[]).map((t) => String(t.documentId)))].sort();
      if (JSON.stringify(traced) !== JSON.stringify([...(strs(r.json.documentIds) ?? [])].sort())) {
        problems.push(`${r.name}: the host retain traces do not cover exactly the retained documents`);
      }
    }
    const creds = r.json.boxWriteCredentials;
    if (!Array.isArray(creds)) problems.push(`${r.name}: box write credentials unread`);
    else if (creds.length > 0) problems.push(`${r.name}: a write credential existed in the box`);
    // INV-Z3-6 delta (docs/planning/v6-crossrepo-contract.md "Z3 round record"): the
    // `qds-` prefix check is delegated to retain's dispatch-family guard (seam gap #11).
    if (!BankIdSchema.safeParse(r.json.bank).success) problems.push(`${r.name}: bank ${String(r.json.bank)} is not an explicit bank id`);
    problems.push(...gatewayProblems(r.name, r.json.gatewayAssertion));
  }
  for (const p of of(legs, "priming-recall")) problems.push(...gatewayProblems(p.name, p.json.gatewayAssertion));
  return problems;
}

// ─── AC6 ─────────────────────────────────────────────────────────────────────

/** AC6: observe legs ride factory_observe (read-only), complete, target the leg's own run — no box, no key. */
export function assertAc6ObserveReadOnly(files: readonly LegFile[]): string[] {
  const { legs } = parse(files);
  const problems: string[] = [];
  const qa = of(legs, "qa-run-observe");
  const code = of(legs, "observe-read-only");
  if (qa.length === 0) problems.push("no qa-run-observe leg");
  if (code.length === 0) problems.push("no observe-read-only leg");
  const provRun = (stepId: string) => of(legs, "kill-and-provision").find((p) => p.json.stepId === stepId)?.json.runId;
  for (const l of [...qa, ...code]) {
    if (l.json.stepKind !== "factory_observe") problems.push(`${l.name}: step kind ${String(l.json.stepKind)}, not factory_observe`);
    if (l.json.stepStatus !== "completed") problems.push(`${l.name}: observe step ended ${String(l.json.stepStatus)}`);
    const target = l.leg === "observe-read-only" ? Z3_STEP.codeRun : Z3_STEP.qaLeg(String(l.json.lens));
    const want = provRun(target);
    if (want === undefined || l.json.observedRunId !== want) problems.push(`${l.name}: observes ${String(l.json.observedRunId)}, not ${target}'s run ${String(want)}`);
    for (const k of ["boxesProvisioned", "providerKeysMinted", "memoryKeysMinted"]) {
      const v = l.json[k];
      if (!Array.isArray(v)) problems.push(`${l.name}: ${k} unmeasured`);
      else if (v.length > 0) problems.push(`${l.name}: the observe leg ${k === "boxesProvisioned" ? "provisioned a box" : `minted a ${k.startsWith("provider") ? "provider" : "memory"} key`}`);
    }
  }
  return problems;
}

// ─── AC7 ─────────────────────────────────────────────────────────────────────

/** AC7: no live credential in any file; spend + GO recorded pre-fire; the finally revoke-verified and destroyed — on every path. */
export function assertAc7LiveRules(files: readonly LegFile[], opts: { roundFailed?: boolean; knownSecrets?: readonly string[] } = {}): string[] {
  const problems: string[] = [];
  for (const f of files) {
    const hits = credentialHits(f.text, opts.knownSecrets);
    if (hits.length > 0) problems.push(`${f.name}: live credential in evidence (${hits.join("; ")})`);
  }
  const { legs } = parse(files);
  const trigger = of(legs, "trigger")[0];
  if (trigger !== undefined) {
    if (!(typeof trigger.json.worstCaseSpendUsd === "number" && trigger.json.worstCaseSpendUsd > 0)) problems.push("worst-case spend not recorded at fire");
    if (typeof trigger.json.forkCapsUsd !== "number" || trigger.json.forkCapsUsd !== trigger.json.worstCaseSpendUsd) {
      problems.push(`the fired caps ($${String(trigger.json.forkCapsUsd)}) are not the GO-gated worst case`);
    }
    if (trigger.json.forkRevVerification !== "image-label" && trigger.json.forkRevVerification !== "unverifiable-from-image") {
      problems.push("the fork rev's verification status is unrecorded");
    }
    const go = trigger.json.operatorGo as Json | undefined;
    if (str(go?.who) === undefined || str(go?.when) === undefined) problems.push("operator GO not recorded at fire");
    else if (!(Date.parse(String(go?.when)) <= Date.parse(String(trigger.json.firedAt)))) problems.push("the operator GO is not dated before the fire");
  }
  const cleanup = of(legs, Z3_CLEANUP_LEG).at(-1);
  if (cleanup === undefined) return [...problems, "no cleanup record — the finally did not run (or did not record)"];
  const c = cleanup.json;
  if (opts.roundFailed === true && c.failurePath !== true) problems.push("the round failed but the cleanup did not record the failure path");
  const receipts = Array.isArray(c.revokeVerify) ? (c.revokeVerify as Json[]) : [];
  if (receipts.length === 0) {
    problems.push(`the finally skipped revoke-verify${c.failurePath === true ? " on the failure path" : ""}`);
  } else if (!receipts.every((r) => typeof r.phase === "string" && typeof r.ok === "boolean")) {
    problems.push("revoke-verify receipts are malformed");
  } else if (receipts.some((r) => r.ok !== true)) {
    problems.push("revoke-verify reported a leak (a receipt is not ok)");
  }
  const runIds = strs(c.runIds) ?? [];
  const destroy = Array.isArray(c.boxDestroy) ? (c.boxDestroy as Json[]) : null;
  if (destroy === null) problems.push("the finally recorded no box destroy");
  else {
    for (const id of runIds) {
      const r = destroy.find((x) => x.runId === id);
      if (r === undefined) problems.push(`no box destroy receipt for ${id}`);
      else if (r.exitCode !== 0) problems.push(`box destroy for ${id} exited ${String(r.exitCode)}`);
    }
  }
  for (const p of of(legs, "kill-and-provision")) {
    if (!runIds.includes(String(p.json.runId))) problems.push(`cleanup never covered fleet run ${String(p.json.runId)}`);
  }
  const leftover = c.leftoverBoxes;
  if (!Array.isArray(leftover)) problems.push("the final fleet listing is unmeasured");
  else if (leftover.length > 0) problems.push(`boxes outlived the round: ${leftover.join(", ")}`);
  const stray = c.unattributedFreshBoxes;
  if (!Array.isArray(stray)) problems.push("fresh boxes after the round are unmeasured");
  else if (stray.length > 0) problems.push(`fresh box(es) no run of this round claims: ${stray.join(", ")} — a possible leak`);
  return problems;
}

/** Every AC over one round — what the live test asserts empty. */
export function assertZ3Round(
  files: readonly LegFile[],
  opts: { forkRev: string; registry: ReadonlyMap<string, string> | null; roundFailed?: boolean; knownSecrets?: readonly string[] },
): string[] {
  const tag = (ac: string, ps: string[]) => ps.map((p) => `${ac}: ${p}`);
  return [
    ...tag("AC1", assertAc1RoundComplete(files, opts)),
    ...tag("AC2", assertAc2ApproveRecorded(files)),
    ...tag("AC3", assertAc3ExactlyOneBox(files)),
    ...tag("AC4", assertAc4CrashWindow(files)),
    ...tag("AC5", assertAc5HostSideRetain(files)),
    ...tag("AC6", assertAc6ObserveReadOnly(files)),
    ...tag("AC7", assertAc7LiveRules(files, opts)),
  ];
}
