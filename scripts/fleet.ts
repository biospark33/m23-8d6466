#!/usr/bin/env bun
/**
 * fleet — the factory's front door (Story DF3.1, D3/DD-1).
 *
 * Four verbs over the tested provider layer: dispatch, status, harvest,
 * teardown. The verb table, --help AND the per-verb flag grammar all render
 * from src/fleet/verbs.ts's registry (AC6) — no second list lives here, and a
 * flag the registry does not declare for a verb is refused, not ignored.
 * Exit codes (this CLI's own table, F3): 0 success · 1 run/provider failure ·
 * 2 usage/schema · 3 setup-gate failure (assertion code in the payload) ·
 * 4 run-not-found · 5 refused before provisioning or the records-integrity
 * guard on a read path (payload code says which guard fired) · 6 the verb's own
 * work LANDED but the invocation could not finish it or report it, and no retry
 * can change that.
 *
 * 6 is deliberately wider than "a cleanup failed": the ledger would not close,
 * the run lock would not release, the ack for a LIVE box could not be written,
 * a torn-down run's key cannot be attributed to revoke it, stdout refused part
 * of the output. The shape they share is "already done, still needs an
 * operator" — where 1 means "nothing landed, retrying is the right move".
 *
 * 130/143 sit OUTSIDE this table on purpose, and the table is otherwise closed:
 * they are 128+SIGINT/SIGTERM, the shell's own convention for "this process was
 * signalled", and folding them in would report a Ctrl-C as a verb's verdict.
 * Only `dispatch` produces them — it is the one verb that installs handlers —
 * and it emits its CC-9 line before it goes.
 *
 * stdout carries the command's OUTPUT only (ack JSON, status rows, the
 * teardown lines); every diagnostic — error envelopes and the structured log
 * — goes to stderr as JSON lines.
 *
 * Harvest/teardown are thin, guard-preserving front doors onto DF2.5
 * (AC5): verify-before-fetch, the refs/sandbox/ refspec and the fixed
 * teardown order all stay inside harvestRun/teardownSandbox.
 *
 * The safety-critical parts of that front door are SHARED with DF2.5's own CLI
 * (`scripts/sandbox-teardown.ts`) rather than kept in step by hand, because
 * "identical semantics maintained by two parallel implementations" is a promise
 * nothing enforces:
 *
 *  - the per-run invocation lock — acquire AND release, including release on
 *    SIGINT/SIGTERM — is `scripts/lib/run-lock.ts`;
 *  - the run-id grammar is `assertFleetRunId`, which delegates to the record
 *    store's `assertValidRunId` (both CLIs now refuse the same set of ids; the
 *    grammar was tightened once already in this story, and a local copy of the
 *    pattern is exactly how the two drift);
 *  - the teardown sequence itself is `teardownSandbox`, one implementation;
 *  - where a run's MONEY lives — ledger file and cost config, resolved from the
 *    records directory — is `scripts/lib/cost-ledger-opts.ts`. The two CLIs had
 *    already drifted here: this one resolved the ledger beside `--dir` while
 *    sandbox-teardown settled box hours into the cwd-relative default, so a run
 *    dispatched with `--dir /srv/runs` left its reservation open forever in one
 *    file and its spend in another.
 *
 * What is NOT shared is each CLI's own surface: argv grammar, exit-code table
 * (this one is 0-6; sandbox-teardown's is 0/1), error rendering (JSON envelopes
 * here, `!! code:` lines there) and the operator vocabulary in the lock refusal.
 * Those differ deliberately, and folding the two `run()` bodies into one would
 * have to re-introduce them as branches on a caller flag — the duplication that
 * remains is the part that is supposed to differ.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  CostLedger,
  getRecord,
  harvestRun,
  openRouterKeyApi,
  resolveCleanupDriver,
  resolveDriver,
  teardownSandbox,
  type CostLedgerHook,
  type HarvestError,
  type ProviderDriver,
  type RunRecord,
  type TeardownDeps,
} from "../src/providers/index.ts";
import { resolveRunsDir, RunRecordStore } from "../src/providers/index.ts";
/**
 * The same redactor every `src/` sink runs its text through (INV-4/INV-6).
 *
 * Imported HERE because this module is where provider text stops being logged
 * and starts being PRINTED: `asUsage` copies a driver's or a credential
 * client's `.message` verbatim into the exit-2 envelope, and `report` attaches
 * the raw `.stack` and `cause.message` for any untyped throw. A request URL or
 * a key prefix in either one lands in a CI job log — so the module boundary,
 * not the provider layer, was where redaction stopped.
 */
import { MAX_ECHO, boundedEcho, redactSecrets } from "../src/providers/step-log.ts";
import type { BoxHoursCtx, CostWireEvent, IngestCtx, IngestResult, RunCostRecord } from "../src/providers/cost-ledger.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { costLedgerOpts } from "./lib/cost-ledger-opts.ts";
import {
  acquireRunLock,
  clearRunLockDestructive,
  markRunLockDestructive,
  releaseRunLock,
  RunLockedError,
  type RunLockHandle,
} from "./lib/run-lock.ts";
// DF3.7: the run-completion observer `fleet observe` drives. The module
// acquires NO lock itself — the verb's withRunLock (below) is the acquire,
// and the handle it hands out is the one the chain's teardown and the gate's
// #245 closure reuse. A separate statement, not an extension of the DF2.11
// import above: this file's DF3.7 edits are adds-only.
import {
  DEFAULT_OBSERVATION_WINDOW_MS,
  observeAndDriveChain,
  type ChainOutcome,
} from "../src/fleet/run-completion.ts";
// DF3.8: the `--all` sweep (src/fleet/observe.ts). A separate statement, not
// an extension of the DF3.7 block: this file's DF3.8 edits are adds-only. The
// sweep takes the per-run lock ITSELF, per candidate, so this wiring builds
// only what its deps ask for — driver, read-mode store, and the per-run chain
// context builders mirrored from runObserve's in-lock block.
import { observeSweep } from "../src/fleet/observe.ts";
// DF5.3: the composition roots in this script open the host-side audit-link
// store and bind its `record` into the provider emit seam (never the reverse —
// src/providers takes the seam, not this import).
import { AuditStoreError, openAuditStore, type AuditStoreWriter } from "../src/audit/link-store.ts";
import type { ProviderAuditLink } from "../src/providers/driver.ts";
// DF3.7: the whole-verb acquire/release wrapper for the observer verb — the
// same primitive fan-out's loser teardowns and the reaper hold their locks
// through. Named import from the same module as the DF2.11 block deliberately:
// extending THAT block would edit its lines.
import { withRunLock } from "./lib/run-lock.ts";
import { BriefSchema } from "../src/fleet/brief-schema.ts";
import { log, logSink, setLogSink, newRequestId, type LogEntry } from "../src/swarmclaw/log.ts";
import {
  assertFleetRunId,
  dispatch,
  FleetError,
  MAX_TIMEOUT_MS,
  resolveBriefRequestId,
  type DispatchDeps,
  type LedgerLike,
} from "../src/fleet/dispatch.ts";
/** The records-skipped envelope echoes `readdirSync` names through it (round 11). */
import { sanitizeLabel } from "../src/fleet/brief-schema.ts";
import { listVerbs, renderHelp, type VerbEntry } from "../src/fleet/verbs.ts";
import { MAX_DIAGNOSTIC, MAX_SKIPPED_ECHO, statusAll, statusRun } from "../src/fleet/status.ts";
// DF3.2: the fanout/rank front doors. fanout-primitive (not fanout.ts) holds
// the primitive — the store module must never import it back.
import { FANOUT_ID_RE, FanoutRecordStore, resolveFanoutsDir, type FanoutRecord } from "../src/fleet/fanout.ts";
import {
  assertFanoutPin,
  fanout,
  FANOUT_MAX_N,
  type FanoutPattern,
} from "../src/fleet/fanout-primitive.ts";
import { assertStepOutputShape, rank, type ArmStepOutput } from "../src/fleet/rank.ts";
// DF3.4: the approval gate, its allowlist and the steering front door. The
// state machines live in those modules; these blocks are the argv/exit-code
// surface over them, exactly as harvest/teardown are over DF2.5.
import {
  MAX_REASON_CHARS,
  reclaimApprovalLock,
  submitDecision,
  sweepExpired,
  type DecisionOutcome,
} from "../src/fleet/approval-gate.ts";
import {
  authenticateFromStdin,
  DEFAULT_APPROVERS_FILE,
  enrolApprover,
  type ApproverAuth,
  type ApproverEnrolment,
} from "../src/fleet/approvers.ts";
import { attachToRun, type AttachOptions } from "../src/fleet/attach.ts";
// DF1.10: the in-box engine start. Everything substrate-shaped about it (the
// argv, the `sudo -n`, the deadline, the failure split) lives there; this file
// is the argv/exit-code surface over it, exactly as it is over DF2.5 and DF3.4.
import { runUnitName, startRun, type StartRunDriver, type StartRunOptions, type StartRunResult } from "../src/fleet/run.ts";
import { submitWork, SubmitError } from "../src/fleet/submit.ts";
import { buildResult, ResultError } from "../src/fleet/result.ts";
import { isValidUuidV4 } from "../src/phase-engine/issue-correlation.ts";
import { ATTACH_MESSAGE_CHAR_CEILING } from "../src/phase-engine/steering.ts";
import { sanitizeForMessage } from "../src/phase-engine/types.ts";
import type { Brief } from "../src/fleet/brief-schema.ts";
import { defaultKeyCapMicroUsd, type KeyApi } from "../src/providers/credentials.ts";
import type { ExitStatus } from "../cli-anything/src/types.ts";

const HELP = renderHelp(listVerbs());

/** Brief ingress cap (story Guards): 64 KiB from stdin or --brief <path>. */
const MAX_BRIEF_BYTES = 64 * 1024;
// Same posture as MAX_BRIEF_BYTES, one tier up in size: --steps-json is
// capped AS STAT'D so readFileSync never pulls unbounded bytes into memory.
// r7-T-b2: exported so the CLI tests pin the --steps-json boundary against
// the production constant instead of a drifting 1024*1024 literal.
export const MAX_STEPS_BYTES = 1024 * 1024;

/**
 * The tokenizer's flag grammar, derived from the SAME registry `parseArgv`
 * validates against (AC6). Hard-coding the two lists here made the registry
 * authoritative for what a verb ACCEPTS but not for how argv is split, so a
 * flag added to a verb entry was tokenized as a positional until someone
 * remembered to edit this file too.
 */
const REGISTRY_FLAGS = listVerbs().flatMap((v) => v.flags);
const flagNames = (wantBoolean: boolean): string[] => [
  ...new Set(REGISTRY_FLAGS.filter((f) => (f.valueType === "boolean") === wantBoolean).map((f) => f.name)),
];
const VALUE_FLAGS = flagNames(false);
/**
 * `-h` is the short form of the registry's `--help`. Declared HERE as a bool so
 * the tokenizer keeps it out of `parseValueFlags` (which answers `-h` by
 * writing to stdout and calling process.exit(0) — fatal to an embedder and to
 * the test runner); `parseArgv` immediately normalizes it to `--help`, so the
 * per-verb `allowed` check sees the flag the registry actually declares rather
 * than a short form that slips past it.
 */
const HELP_ALIAS = "-h";
const BOOL_FLAGS = [...flagNames(true), HELP_ALIAS];

/**
 * Startup grammar validation (round 10): the tokenizer's two lists are UNIONS
 * over every verb's flags, so nothing in the derivation itself stops the same
 * flag name from being a boolean for one verb and a value flag for another —
 * it would then land in BOTH `BOOL_FLAGS` and `VALUE_FLAGS`, and `tokenizeArgs`
 * would split one verb's argv by the other verb's grammar (`--pin x` consumed
 * as a value for the boolean verb, left dangling for the valued one). The
 * registry is the contract, so an incoherent one must refuse to start rather
 * than mis-parse at runtime. Exported so tests can pin the helper directly;
 * empty ⇒ clean.
 */
export function flagTypeConflicts(entries: readonly VerbEntry[]): string[] {
  const typesByName = new Map<string, Set<string>>();
  for (const v of entries) {
    for (const f of v.flags) {
      const types = typesByName.get(f.name) ?? new Set<string>();
      types.add(f.valueType);
      typesByName.set(f.name, types);
    }
  }
  const conflicts: string[] = [];
  // Code-unit sort: deterministic across locales (localeCompare is not).
  for (const name of [...typesByName.keys()].sort()) {
    const types = typesByName.get(name) as Set<string>;
    if (types.size > 1) conflicts.push(`${name} is ${[...types].sort().join(" on some verbs, ")}`);
  }
  return conflicts;
}
// Fail fast at startup, before any verb can run against the broken grammar.
const FLAG_TYPE_CONFLICTS = flagTypeConflicts(listVerbs());
if (FLAG_TYPE_CONFLICTS.length > 0) {
  throw new Error(`fleet registry flag-type conflicts: ${FLAG_TYPE_CONFLICTS.join("; ")}`);
}
// The help tokens MUST ride the boolean table. `parseValueFlags`'s own help
// clause answers its match with writeSync + `process.exit(0)` — fatal to an
// embedder and to the test runner, and mid-verb an exit 0 is a phantom success.
// They are unreachable there only because every registry entry declares
// `--help` boolean and `-h` is aliased into BOOL_FLAGS below; this invariant
// turns a registry edit that silently breaks that premise into a startup
// refusal instead of a live exit-on-match path.
for (const helpToken of ["--help", HELP_ALIAS]) {
  if (!BOOL_FLAGS.includes(helpToken)) {
    throw new Error(`fleet grammar: ${helpToken} must be a derived boolean flag, never a parseValueFlags help match`);
  }
}

/**
 * The log sink as it stood when THIS module loaded. `run()` wires the
 * best-effort stderr sink only when the installed sink is still this default —
 * so embedders get hardened diagnostics without losing stdout purity, while a
 * caller that deliberately installed its own collector (tests) keeps it. Live
 * import binding: reflects any setLogSink that ran before this line.
 */
const BOOT_LOG_SINK = logSink;

/**
 * Injectable seams (repo DI idiom; tests override without module mocks).
 *
 * Inherits DispatchDeps' optional seams instead of restating them — repoRoot,
 * quotaLimits, clock, timeoutMs, dispatchLogPath, setupGate — so a seam added
 * there is reachable through the CLI without a second edit here. The keys the
 * CLI derives itself are omitted: driver/keyApi/store/ledgerFactory are
 * re-declared as REQUIRED below, and requestId/port come from the brief and
 * argv respectively.
 *
 * Every inherited seam is caller-only. `repoRoot` is INV-1's manifest
 * containment root, so it is deliberately NOT a CLI flag: the operator-facing
 * surface keeps defaulting to process.cwd(), and no brief- or argv-derived
 * value may ever reach it.
 */
export interface FleetDeps
  extends Omit<DispatchDeps, "driver" | "keyApi" | "store" | "ledgerFactory" | "requestId" | "port"> {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  ledgerFactory: () => LedgerLike;
  readBrief: () => Promise<string>;
  /**
   * `submit`'s engine-start seam (Q1.1), for the same reason `readBrief` and
   * `authenticate` are seams: the production closure runs `startRun` against
   * the resolved driver, which a verb-exit-mapping test cannot reach (no
   * systemd under the fake driver). Tests inject the outcome; production
   * leaves it undefined and gets the real unit start.
   */
  startEngine?: (runId: string) => Promise<StartRunResult>;
  /**
   * DF3.4's approver-token intake, seamed like `readBrief` and for the same
   * reason: the token arrives on fd 0, which a test cannot attach to
   * in-process. Production passes `authenticateFromStdin`; nothing else may
   * supply a token, and no flag ever carries one (DF2.3 INV-CRED-3).
   */
  authenticate?: (hostRoot: string, approverId: string) => Promise<ApproverAuth>;
  /**
   * `enrol`'s writer, for the same reason `authenticate` is a seam one line up:
   * the real one resolves its allowlist from `process.cwd()`, so an in-process
   * test of the verb's exit mapping would write `.factory/approvers.json` into
   * whatever directory the suite happens to be running in — which, for this
   * repo's tests, is the repo. The REAL writer is exercised against a real
   * filesystem in `tests/fleet/approvers.test.ts`, and end to end through a real
   * subprocess in a real tmpdir in `tests/fleet/gate-verbs.test.ts`.
   *
   * The trailing two parameters mirror `enrolApprover`'s own defaults — the
   * verb always passes them (the allowlist path is fixed, and `--rotate` is
   * argv the writer must SEE), so a double that cannot express rotate would
   * silently re-create the dead-flag bug this seam documents.
   */
  enrol?: (
    hostRoot: string,
    approverId: string,
    file?: string,
    opts?: { rotate?: boolean; dir?: string },
  ) => ApproverEnrolment;
  /**
   * `attach`'s ack ceiling and poll interval. No operator flag: the registry
   * declares none and 30 s is the story's fixed budget. It is a seam only so a
   * test can reach the `attach-not-acked` mapping in milliseconds instead of
   * waiting out the real ceiling — the same reason `attach.test.ts` passes
   * `ceilingMs` to `attachToRun` directly.
   */
  attachOptions?: AttachOptions;
  /**
   * DF1.10 `run`'s per-call start deadline, seamed exactly like
   * `attachOptions` one line up and for the same reason: the registry declares
   * no flag for it (90 s is derived, not chosen — it clears the ceiling on a
   * start job systemd is still legitimately running, which is the manager's
   * `DefaultTimeoutStartSec` bounding the tmpfiles oneshot the unit `Requires=`;
   * the unit's own `TimeoutStartSec` was deleted as provably inert for
   * `Type=simple` and is no longer what this is derived from), and a test needs
   * to reach the `box-unreachable` mapping in milliseconds instead of waiting
   * the real budget out.
   */
  runOptions?: StartRunOptions;
  /**
   * DF3.2 fanout/rank seams, forwarded into FanoutDeps verbatim. There is no
   * operator flag for either — `.sandbox/fanouts` and `.sandbox/fleet.lock`
   * follow their env/default resolution — but tests and embedders point them
   * at a tmpdir the same way they point `--dir`.
   */
  fanoutsDir?: string;
  lockPath?: string;
  /**
   * DF2.8: when present, race losers' teardown prices their box hours into
   * THIS ledger instead of the one the verb builds beside the records dir.
   * Absent and pattern=race ⇒ the verb constructs it (see the fanout block).
   */
  costLedger?: CostLedgerHook;
}

/** Every refusal is a FleetError so ONE renderer owns the envelope + exit code. */
function usageError(message: string, remediation: string): FleetError {
  return new FleetError(2, "usage", message, remediation);
}

/**
 * NO verb defaults to a driver. `fleet teardown <id>` with no --driver used to
 * "destroy" a FAKE box, print `torn down`, exit 0 and close the record while
 * the real box kept billing; `fleet dispatch` minted a fake run a CI script
 * believed it had provisioned. An injected driver (tests, embedders) is an
 * explicit choice already, so it satisfies the requirement without the flag.
 */
function assertDriverChosen(verb: string, driverName: string | undefined, injected: ProviderDriver | undefined): void {
  if (driverName !== undefined || injected !== undefined) return;
  throw usageError(
    `${verb} requires --driver <name>`,
    "pass --driver fake for a local dry run, or the provider driver to act on the real fleet",
  );
}

/**
 * Stands in for the key client on a brief `dispatch` is about to refuse at its
 * schema — see the `briefCanMint` comment. It is never touched (validation
 * precedes every credential step), and it throws rather than answering so a
 * reordering that DID reach it fails loudly instead of dispatching with a
 * silently inert credential client.
 */
function unusedKeyApi(): KeyApi {
  return new Proxy({} as KeyApi, {
    get: (_target, prop) => {
      // `then` and the well-known symbols are not USES of the key client —
      // they are the runtime asking what this object is. `await`ing anything
      // that transitively holds it, or `util.inspect`ing it in a log line,
      // reached this trap and replaced an exit-2 schema refusal that NAMES the
      // offending field with a bare stack and a retryable exit 1. Answering
      // "absent" is the truth for those; every real method still throws.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`keyApi.${String(prop)} on a brief that failed validation — the key client was never built`);
    },
  });
}

/**
 * The READ verbs never create the records directory.
 *
 * `new RunRecordStore` mkdirs `--dir` recursively and chmods it 0700 (INV-5),
 * which is right for `dispatch` — it is the verb that creates runs — and wrong
 * for status/harvest/teardown, whose contract is that a run they cannot find is
 * refused having "mutated nothing" (spec df3-1 :88-90). `fleet teardown
 * qds-nosuchrun --dir /srv/typo` exited 4 having created /srv/typo and every
 * missing parent, so the operator's next `fleet status --dir /srv/typo` then
 * reported an empty fleet from a directory that only exists because they typo'd
 * it once.
 *
 * Only a directory the operator NAMED is checked. The default
 * (`.sandbox/runs`, or $QDS_RUNS_DIR) being created on first use is the
 * intended bootstrap, and refusing it would break every fresh checkout.
 *
 * Skipped entirely for an injected store: an embedder's store is already built,
 * so there is nothing left to refuse before constructing one.
 *
 * 2, not 4. 4 is "that RUN does not exist", which presumes a records directory
 * to have looked in; a `--dir` that is not there is the invocation being wrong,
 * it is wrong identically on every retry, and `asUsage` already classifies the
 * sibling failures the store itself raises (ENOTDIR, EPERM, wrong mode) the
 * same way.
 *
 * Residual, and NOT fixed here: pointed at an EXISTING directory the store
 * constructor still chmods it 0700 before the record probe can refuse. Only a
 * no-create/no-chmod mode on RunRecordStore closes that, and it lives in
 * src/providers/run-record.ts.
 */
function assertRecordsDirUsable(dir: string | undefined, injected: RunRecordStore | undefined): void {
  if (dir === undefined || injected !== undefined) return;
  // No `dir === ""` arm: there used to be one, on the premise that an unset
  // `--dir "$RUNS_DIR"` reaches here — it cannot. `parseValueFlags` refuses an
  // empty value in BOTH spellings (`--dir ""` and `--dir=`) with "requires a
  // non-empty value" before dispatch, so the branch was dead code guarding
  // against a parse the grammar already rejects (cli-args.ts:62-75).
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch (e) {
    // `bounded`: `--dir $(head -c 200000 /dev/urandom)` is refused, but the
    // refusal must not echo all of what the operator typed (round 10 — every
    // argv-derived echo in an envelope goes through the same cap as a log
    // field; redact-first is bounded's own order).
    throw usageError(
      `--dir ${bounded(dir)} does not exist: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
      "point --dir at the records directory the run was dispatched with — this verb never creates one",
    );
  }
  if (!st.isDirectory()) throw usageError(`--dir ${bounded(dir)} is not a directory`, "point --dir at the records directory");
}

/**
 * Stands in for the record store on a brief `dispatch` is about to refuse at
 * its schema — the `unusedKeyApi` treatment, one dependency over.
 *
 * `dir` is the one thing it answers, because `dispatch()` reads `store.dir`
 * before it validates anything: that is where the AC4 refusal evidence goes, so
 * a refusal still needs to know it. Reading a plain string is not a side
 * effect. Every other member throws rather than answering, so a reordering that
 * DID reach the store on an invalid brief fails loudly instead of silently
 * mkdir'ing and chmod'ing a directory the operator only typo'd.
 */
function unusedStore(dir: string): RunRecordStore {
  return new Proxy({ dir } as RunRecordStore, {
    get: (target, prop) => {
      if (prop === "dir") return target.dir;
      // See `unusedKeyApi`: `then` and the well-known symbols are the runtime
      // asking what this object is, not a USE of the store.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`store.${String(prop)} on a brief that failed validation — the run store was never built`);
    },
  });
}

/**
 * One JSON line per refusal. The envelope fields are written LAST so a typed
 * payload (assertionCode, DF2.8 fields, reason…) can never overwrite the
 * `code`/`message` the caller switches on.
 *
 * Redaction happens at the places FOREIGN text enters this file (`asUsage`,
 * `report`'s untyped branch, and `ingestBriefJson`'s invalid-brief embed of a
 * JSON.parse message), not here. Doing it here instead covers one
 * more path and breaks a real one: `redactSecrets` blanks any ≥40-char opaque
 * token, and the messages this file composes itself deliberately ECHO argv —
 * `fleet teardown $(200KB)` is answered with the first 96 characters of what
 * the operator typed, which is the whole point of the echo and is exactly the
 * shape the token rule eats. Text we composed from argv is not a secret sink;
 * text a driver, a credential client or an errno handed us is.
 */
function printError(
  err: (s: string) => void,
  code: string,
  message: string,
  remediation?: string,
  payload?: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = { ...(payload ?? {}), code, message };
  // Empty advice is no advice: `null` (a record field read raw), `""` and a
  // whitespace-only string all landed as a `remediation` key that says
  // nothing, where the MISSING key reads as "this failure has no remediation
  // designed for it". The envelope callers are the `report` arms — both route
  // through here, so the rule holds for the typed and the untyped arm alike.
  if (typeof remediation === "string" && remediation.trim() !== "") line.remediation = remediation;
  err(`${JSON.stringify(line)}\n`);
}

/**
 * F049: `--dir` names two different directories depending on the verb.
 *
 * On dispatch/status/harvest/teardown it is the RUNS directory; on fanout and
 * rank it has always been the FAN-OUTS directory. An operator who uses the one
 * flag consistently — `fleet fanout --dir /srv/runs` alongside `fleet status
 * --dir /srv/runs` — writes `fan-*.json` into the runs tree, and every later
 * sweep of it reports `malformed_record_name`: the exact failure the fanout
 * block's own comment says the flag exists to avoid.
 *
 * `--fanouts-dir` is the unambiguous spelling. `--dir` keeps its fan-outs
 * meaning on these two verbs for ONE release rather than silently changing
 * directories under a working invocation — a rename that flips where records
 * are read from is how a fan-out becomes unfindable — so the change an
 * operator has to make is announced here first, on stderr, where it cannot
 * affect the exit code or the parsed output. Deliberately NOT fired when
 * `--fanouts-dir` was given as well (round-3 A18 asked for it): an operator
 * passing both has already migrated, the warning exists to move them off
 * `--dir`, and `cli.test.ts` pins that the warning stops for exactly that
 * invocation.
 *
 * ponytail: one-release deprecation — delete `--dir` from fanout/rank in
 * verbs.ts and this warning with it at the next tagged release.
 */
function warnDirDeprecated(note: (s: string) => void, verb: string): void {
  printError(
    note,
    "dir-deprecated",
    `--dir on \`${verb}\` names the FAN-OUTS directory, not the runs directory: this spelling is deprecated`,
    "pass --fanouts-dir <path> instead — on every other verb --dir is the runs directory, and fan-*.json written into a runs directory is reported as malformed_record_name",
  );
}

/**
 * Construct a provider-layer dependency, mapping its refusal to exit 2.
 *
 * `resolveDriver` throws a bare Error for an unknown driver name,
 * `openRouterKeyApi` a CredentialLifecycleError for an unset provisioning key,
 * and `new RunRecordStore` a bare Error for a records dir that is a regular
 * file (ENOTDIR), unwritable (EPERM) or not mode 0700. None is a FleetError, so
 * all fell through to the generic branch of `report` as exit 1 — which
 * `logVerb` stamps `transient`, i.e. "retry me". A typo'd driver, an unset env
 * var and a `--dir` pointing at the wrong thing are permanent operator errors:
 * automation reading `exitStatus` retried them forever. Only the classification
 * changes — and the redaction below, which is not a change of meaning.
 *
 * This is one of the places text this file did not compose becomes text it
 * PRINTS, so it is one of the places `redactSecrets` belongs (the others are
 * `report`'s untyped branch and the invalid-brief embed in
 * `ingestBriefJson`). A driver constructor or `openRouterKeyApi()` that
 * throws with the request URL or a key prefix in `.message` used to have it
 * copied verbatim into the exit-2 envelope — the provider layer's INV-4/INV-6
 * redaction stopped dead at this module boundary, while every `src/` sink runs
 * its text through the same helper. `redactSecrets` never throws (it fails
 * closed to the placeholder), so nothing here can fail while reporting.
 */
function asUsage<T>(build: () => T): T {
  try {
    return build();
  } catch (e) {
    if (e instanceof FleetError) throw e;
    const x = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    // Classified by whether a RETRY could clear it, not by where it was thrown.
    // `new RunRecordStore` mkdirs and chmods, and a full disk, a failing device
    // or an fd-table exhaustion while it does is the SUBSTRATE — exit 1
    // `transient` is exactly right for it, where exit 2 `logic` means "this
    // invocation is permanently wrong, never retry it" and stranded the run.
    // The HELP-as-remediation default is scoped the same way: the flag list is
    // not the remediation for ENOSPC.
    if (x.code !== undefined && RETRYABLE_ERRNOS.has(x.code)) throw e;
    // `?? e`, not `?? String(e)`: `redactSecrets` coerces anything without
    // throwing, and `String` on a null-prototype throw does not.
    // HELP is this file's own text and needs no redaction, but running the
    // default through the same call keeps one expression rather than two.
    throw usageError(redactSecrets(x.message ?? e), redactSecrets(x.remediation ?? HELP));
  }
}

/**
 * DF5.3/C-1: the audit store's open refusal, classified into THIS CLI's table
 * — the same refusal `scripts/sandbox-teardown.ts` and `scripts/sandbox-reap.ts`
 * report for the same fault, so one fault class does not produce four
 * diagnoses across four CLIs (C10).
 *
 * `code` is taken ONLY from an `AuditStoreError`. A bare fs errno reached
 * `report`'s untyped branch, which printed `code: "EACCES"` with the generic
 * "fix what the errno names" advice — accurate about the syscall and silent
 * about `QDS_AUDIT_DB`, the one knob that caused it. The errno stays in the
 * message, where it is diagnosis rather than classification.
 *
 * 5, not 1: every caller opens BEFORE it provisions or destroys anything, and a
 * sealed or unwritable path is identical on every retry — exit 1's `transient`
 * stamp sends automation back to re-run it forever.
 */
function auditStoreUnavailable(e: unknown, consequence: string): FleetError {
  const typed = e instanceof AuditStoreError ? e : undefined;
  const x = (e ?? {}) as { message?: string };
  return new FleetError(
    5,
    typed?.code ?? "audit-store-unavailable",
    // `?? e`, not `?? String(e)` — see `asUsage`: `redactSecrets` takes
    // `unknown` and cannot throw, where `String` on a null-prototype throw can.
    `the audit-link store could not be opened: ${redactSecrets(x.message ?? e)} — ${consequence}`,
    typed?.remediation ??
      "fix or clear the store path (QDS_AUDIT_DB, default .sandbox/audit.db), then re-run — nothing was mutated",
  );
}

/** Errnos a later attempt could clear — a full or failing device, not a typo. */
const RETRYABLE_ERRNOS = new Set(["ENOSPC", "EDQUOT", "EIO", "EBUSY", "EMFILE", "ENFILE", "EAGAIN", "ETIMEDOUT"]);
/**
 * The inverse, for errors that arrive with the ERRNO AS their `code` — no
 * layer classified them, the OS did. Permission, type and lookup failures are
 * there on every retry identically: exit 1 stamps them `transient`
 * ("retry me") and automation retries a permanent permission error forever —
 * the same drift `asUsage` fixes for CONSTRUCTOR-time errors, extended to the
 * RUNTIME ones `report` receives raw. Everything not listed stays exit 1: an
 * unlisted or missing errno is the substrate failing, and retry is the honest
 * read of what nobody has classified.
 */
const PERMANENT_ERRNOS = new Set(["EACCES", "EPERM", "ENOTDIR", "EISDIR", "ENOENT", "EROFS", "ELOOP", "EBADF"]);

/** Render any throw as the envelope + this CLI's exit code. */
function report(err: (s: string) => void, e: unknown): number {
  // Submit's own refusals carry their fleet-table exit code (2 usage / 5
  // refused) — rendered through the same envelope, mapped before the generic
  // designed-refusal branch would bin them at exit 1.
  if (e instanceof SubmitError) {
    printError(err, e.code, e.message, e.remediation);
    return e.exitCode;
  }
  // Result's one refusal: the missing record — the poller's exit-4 answer.
  if (e instanceof ResultError) {
    printError(err, e.code, e.message, e.remediation);
    return e.exitCode;
  }
  if (e instanceof FleetError) {
    printError(err, e.code, e.message, e.remediation, e.payload);
    // The exit table is 0-6 and `process.exit` takes a BYTE: a code outside
    // 0-255 wraps (256 → 0) and a refusal would report success. Anything off
    // the documented table is a bug in the thrower, and this is the one place
    // that turns a throw into a status, so it is the place to enforce it.
    //
    // The floor is 1, not 0. `report` is only ever reached from a catch, so 0
    // is not a "code outside the table" the way 256 and −1 are — it is the one
    // value that defeats the guard by passing it: the envelope goes to stderr
    // and `logVerb` then stamps the refusal `status:"ok"`/`exitStatus:"success"`.
    // `new FleetError(0, …)` is a copy-paste or a computed code that defaulted,
    // and both are exactly the "a refusal would report success" case.
    //
    // The fallback is 2, not 1. 1 is `transient` = "retry me", and a thrower
    // whose exit code is off the table has produced an unclassifiable failure —
    // there is no evidence a retry helps, and this file argues everywhere that
    // 1 is the one classification a non-retryable failure must never get. 2 is
    // "permanently wrong, do not retry", which is the safe read of a bug.
    //
    // The clamp's extent is the CLI's whole exit table (0-6) — that range is
    // what the registry drift-check in verbs.test.ts scrapes, so it must stay
    // the table, not the thrower's subset. The REFUSAL of 6 is therefore a
    // separate arm, not a lower ceiling (round-3 A2): 6 means the verb's work
    // LANDED and its completion line printed first — every real 6 site prints
    // through `reportCompletion` before it exits — while this function only
    // ever renders the error envelope. `FleetError.exitCode` is typed 1–5, and
    // `e` arrives as `unknown` here, so this runtime arm is what refuses a 6
    // built by a JS caller or through a cast: a thrown 6 is a thrower bug,
    // classified 2 ("permanently wrong"), never mapped through to "work
    // landed" — automation keying on 6 must not read a thrown refusal as
    // finished work.
    // Cast through unknown: `FleetError.exitCode` is DECLARED 1-5, so the
    // runtime arm below is the only guard for a 6 built by a JS caller or a
    // cast — which is exactly the case it exists for.
    if ((e.exitCode as unknown) === 6) return 2;
    return Number.isInteger(e.exitCode) && e.exitCode >= 1 && e.exitCode <= 6 ? e.exitCode : 2;
  }
  // Non-Error rejections normalize to {} so the printer cannot itself throw
  // while reporting one.
  const x = (e ?? {}) as { code?: string; message?: string; remediation?: string; stack?: string; cause?: unknown };
  // No DESIGNED refusal means nobody planned for this failure: a TypeError out
  // of a driver, a RangeError from inside teardownSandbox. One bare message for
  // a failure that may have left a box half-torn-down makes root-causing it
  // require re-running the destructive command — carry the stack (and the
  // cause's message) so the first run is enough. Typed refusals (RunLockedError,
  // the credential and harvest errors) already say what went wrong and where,
  // and stay the clean one-liners operators read daily.
  //
  // The test is `code` AND `remediation`, not `code` alone: a designed refusal
  // carries the operator's next step, and that is what makes it self-contained
  // enough to drop the stack. Codes alone did not — F040's run-record validators
  // throw context-free messages ("vmName must be a string") with a code and no
  // remediation, and `code !== undefined` silently binned the only thing that
  // said WHICH call site produced them.
  //
  // This branch and `asUsage` are the two places foreign text enters this
  // file's output, so both redact here rather than in `printError` — see there
  // for why the printer itself must not. A stack frame's arguments and a
  // `cause.message` are where a request URL or a `sk-…` prefix actually rides
  // out of the provider layer; `x.message` is a driver's or a teardown step's
  // own words.
  const cause = (x.cause ?? undefined) as { message?: string } | undefined;
  // `!== ""` joins the test because a designed refusal CARRIES advice: the
  // conditional-remediation shape a validator throws (`… : ""`) satisfies
  // `!== undefined` while saying nothing — treating it as designed dropped the
  // stack and cause that say WHICH call site produced the error, and printed a
  // `remediation: ""` key below, the exact "we have no advice" reading the
  // printer's own absent-vs-empty split forbids.
  // `trim()` joins the same test for the whitespace-only shape: `"   "` says
  // no more than `""` does, and treating it as designed dropped the stack and
  // cause over advice that was never there. `null` rides the coercion — a
  // null remediation is a designed refusal with no advice, not a designed
  // refusal at all.
  const remediationText = typeof x.remediation === "string" ? x.remediation.trim() : "";
  const designed = x.code !== undefined && remediationText !== "";
  const debris =
    designed
      ? undefined
      : {
          ...(typeof x.stack === "string" ? { stack: redactSecrets(x.stack) } : {}),
          // `cause.message ?? x.cause`, not `?? String(x.cause)`: `redactSecrets`
          // coerces anything without throwing, and `String` on a null-prototype
          // or hostile-`toString` cause throws inside the reporter.
          ...(cause === undefined ? {} : { cause: redactSecrets(cause.message ?? x.cause) }),
        };
  // `remediation` stays ABSENT when there is none — an empty string would put
  // the key in the envelope with nothing in it, which reads as "we have no
  // advice" where the missing key reads as "this failure has no remediation
  // designed for it". Only the present one is redacted. The `""` arm matches
  // `designed` above: a refusal that carries no advice is not a designed one,
  // and it does not get a key saying it is.
  const remediation = remediationText === "" ? undefined : redactSecrets(x.remediation as string);
  // An OS-classified permanent errno keeps the raw envelope (its `code` field
  // already names it) but must not inherit exit 1's "retry me" — the same
  // split `asUsage` draws for constructor-time errnos, extended here where
  // RUNTIME ones land. EPIPE/EAGAIN stay 1: the sink layer owns their
  // classification (emit tolerates them, reportCompletion exits 6) and a
  // completed verb whose REPORTING hit a closed pipe must not be relabeled
  // "permanently wrong".
  const permanentErrno =
    typeof x.code === "string" &&
    x.code !== "EPIPE" &&
    x.code !== "EAGAIN" &&
    PERMANENT_ERRNOS.has(x.code);
  printError(
    err,
    x.code ?? "error",
    redactSecrets(x.message ?? e),
    remediation ??
      (permanentErrno
        ? "this failure is identical on every retry — fix what the errno names (permissions, path type, absence) instead of re-running"
        : undefined),
    debris,
  );
  return permanentErrno ? 2 : 1;
}

/**
 * `report`, made unable to BE the failure it is reporting. `note` already
 * cannot throw, but `report`'s own body is not total: `JSON.stringify` throws
 * on a FleetError whose `payload` is circular, and when the reporter dies the
 * throw used to unwind past the verb's catch, through its `finally`, and out
 * of `run()` — no CC-9 line, no exit code, a raw stack for an embedder. The
 * fallback is 1 ("substrate failed"), the value the fanout and dispatch
 * comments already name as "the honest thing to die with" when the reporter
 * itself cannot finish. Every catch block in this file routes through this so
 * the guarantee holds uniformly, not only where someone remembered it.
 */
function reportCode(note: (s: string) => void, e: unknown): number {
  try {
    return report(note, e);
  } catch {
    // The reporter itself died (a circular payload is the plausible way). The
    // silent fallback was its own failure mode twice over: nothing at all on
    // the wire, and exit 1 — which `logVerb` stamps `transient`, sending
    // automation back to retry a bug that every retry reproduces. One minimal
    // stderr line (best-effort: `note` may be what is broken too), and 2 — a
    // bug is permanent, in the same class as the usage refusals, never
    // "try me again".
    try {
      note(
        `${JSON.stringify({
          code: "reporter-failed",
          message: `the error reporter itself failed while rendering this error: ${redactSecrets(bounded(String(e)))}`,
        })}\n`,
      );
    } catch {
      /* nothing left to report it to */
    }
    return 2;
  }
}

interface Parsed {
  help?: false;
  entry: VerbEntry;
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/**
 * A help request survives parsing intact; nothing else about argv matters —
 * except which verb it was asked about, which the CC-9 line needs. `fleet
 * teardown <id> --driver fake --help` is an operator who meant to destroy a box
 * and did not, and a dashboard that sees no line for it cannot tell that
 * invocation from one that never happened.
 */
type ParseResult = Parsed | { help: true; verb?: string };

/**
 * argv → verb + validated flags. Every parser failure becomes a usage
 * FleetError (exit 2 with an envelope) rather than escaping run() as a bare
 * throw the top-level catch turns into a silent exit 1.
 */
function parseArgv(argv: readonly string[]): ParseResult {
  let tokens: ReturnType<typeof tokenizeArgs>;
  try {
    tokens = tokenizeArgs(argv, {
      valueFlags: VALUE_FLAGS,
      boolFlags: BOOL_FLAGS,
      rejectStraySingleDash: true,
    });
  } catch (e) {
    // `bounded`: the tokenizer's messages embed the raw token (`unknown flag:
    // -<200KB>`), so the envelope must cap what argv put in it — same bound as
    // every other argv-derived echo in this file.
    throw usageError(bounded((e as Error).message), HELP);
  }
  const { positionals, flagTokens, bools } = tokens;
  // The other half of the duplicate-flag guard below. `bools` is a Set, so
  // `--no-harvest --no-harvest` collapsed into one silently — and --no-harvest
  // is the flag that WAIVES artifact capture, so a repeated one is exactly the
  // invocation an operator must be sure they typed. Scanned over raw argv
  // because the Set has already lost the count; a bool token can never be a
  // positional (run ids never start with `-`) nor a value (the space form
  // refuses a `--`-prefixed value, cli-args.ts).
  //
  // Aliases are canonicalized BEFORE the count: `-h --help` names one flag
  // twice, but the raw-string scan saw two distinct tokens and waved it
  // through to the Set, which collapsed it — the guard existed for exactly
  // this invocation and missed it (round 10).
  const seenBool = new Set<string>();
  for (const a of argv) {
    const name = a === HELP_ALIAS ? "--help" : a;
    if (!BOOL_FLAGS.includes(name)) continue;
    if (seenBool.has(name)) throw usageError(`${name} given more than once`, HELP);
    seenBool.add(name);
  }
  if (bools.delete(HELP_ALIAS)) bools.add("--help");

  // A DECLARED boolean flag given a value (`--no-harvest=true`) was reported as
  // an UNKNOWN flag: `parseValueFlags` evaluates the `=` form first and matches
  // it against VALUE_FLAGS only, so the operator was sent looking for a flag
  // that exists and that they spelled correctly. Caught here because that
  // parser is shared and has no boolean table of its own.
  for (const token of flagTokens) {
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : "";
    if (BOOL_FLAGS.includes(name)) throw usageError(`${name} takes no value`, HELP);
  }

  const flags = new Map<string, string>();
  try {
    parseValueFlags(flagTokens, {
      flags: VALUE_FLAGS,
      onValue: (flag, value) => {
        // Last-win silently discards the first value — for `--dir` that means
        // acting on a different runs directory than the one the operator saw
        // themselves type. Refuse instead.
        if (flags.has(flag)) throw new Error(`${flag} given more than once`);
        flags.set(flag, value);
      },
      /**
       * NOT a token list — despite the sibling options' shapes, this is the
       * help TEXT `parseValueFlags` writes before `process.exit(0)` when a bare
       * `--help`/`-h` reaches it. It must stay unreachable: both tokens are
       * intercepted into `bools` by `tokenizeArgs` (every registry entry
       * declares `--help` boolean; `-h` rides BOOL_FLAGS), and the module-level
       * invariant above refuses to start if that premise breaks. This CLI must
       * NEVER take the exit-on-match path — mid-verb it would print usage and
       * report success, and to an embedder it kills the process.
       */
      help: [HELP],
    });
  } catch (e) {
    // `bounded`, for the same reason as the tokenize catch above: the parser's
    // messages embed raw argv (`unknown flag: --<200KB>`).
    throw usageError(bounded((e as Error).message), HELP);
  }

  // Resolved from the PARSED flags, and only AFTER the value grammar has run.
  // `argv.includes("--help")` matched the token anywhere in raw argv, so
  // `fleet teardown <id> --driver fake --dir --help` — a `--dir` fat-fingered
  // with no value — printed usage to stdout and exited 0: a CI script doing
  // `fleet teardown … || alert` recorded success while the box and the API key
  // stayed live and billing, and no log line was emitted to contradict it. The
  // value grammar now rejects that argv as the typo it is, and only a --help
  // that survives it is a help request.
  if (bools.has("--help")) return { help: true, ...(positionals[0] === undefined ? {} : { verb: positionals[0] }) };

  const verb = positionals[0];
  // A bare `fleet` is a mistyped invocation, not a help request: the exit
  // table says usage = 2, and `fleet --help` is the way to ask for help.
  if (verb === undefined) throw usageError("no verb given", HELP);

  const entry = listVerbs().find((v) => v.verb === verb);
  if (entry === undefined) {
    // Both echoes `bounded`: argv-derived, so a refusal must not repeat an
    // unbounded slice of what was typed (round 10 — same cap as the log
    // fields, redact-first).
    throw new FleetError(2, "unknown-verb", `unknown verb ${JSON.stringify(bounded(verb))}`, HELP);
  }
  // AC6 parity in BOTH directions: the registry says which flags a verb takes,
  // so `fleet status --brief x` is refused rather than silently accepted.
  const allowed = new Set(entry.flags.map((f) => f.name));
  for (const flag of [...flags.keys(), ...bools]) {
    if (!allowed.has(flag)) {
      const list = [...allowed].join(" ");
      throw usageError(
        `${bounded(verb)} does not take ${bounded(flag)}`,
        `flags for ${bounded(verb)}: ${list === "" ? "(none)" : list}`,
      );
    }
  }
  return { entry, positionals, flags, bools };
}

/**
 * A parent that pipes its default stdin to us and never closes the write end
 * parks `readCappedStdin` forever, before any provisioning started — a CI job
 * hangs until ITS timeout with no envelope. The wait is bounded at a generous
 * two minutes (a slow producer streaming a full-cap brief takes seconds), so
 * the refusal names the missing EOF rather than the process sitting silent.
 */
const STDIN_BRIEF_TIMEOUT_MS = 120_000;

/**
 * What a stdin refusal calls the bytes it was waiting for, and which flag it
 * tells the operator to reach for instead.
 *
 * `readCappedStdin` has two callers with different flags: the brief-eating
 * verbs (`--brief`) and DF3.4's `attach` (`--message`). Before this parameter
 * every refusal was brief-shaped, so `fleet attach qds-… ` with a pipe nobody
 * closed sat for two minutes and then named `--brief` — a flag `attach` does
 * not declare, which sends the operator to look for a typo they cannot have
 * made. The default keeps every existing caller, and every pinned error code
 * (`brief-stdin-timeout`, `brief-too-large`), byte-identical by omission.
 */
interface StdinIntake {
  /** The noun in the message AND the error code's prefix. */
  noun: string;
  /** The "or …" clause of the remediation — a flag the CALLING verb has. */
  instead: string;
}
const BRIEF_INTAKE: StdinIntake = { noun: "brief", instead: "pass --brief <path> instead" };
const MESSAGE_INTAKE: StdinIntake = { noun: "message", instead: "pass --message <text> instead" };

/** Read stdin, refusing AS IT STREAMS — buffering first turns `yes |` into an OOM. */
async function readCappedStdin(intake: StdinIntake = BRIEF_INTAKE): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = Bun.stdin.stream().getReader();
  try {
    for (;;) {
      // Each READ races the window — including the FIRST one (nothing has
      // arrived yet) and the one waiting for EOF after the last chunk. The
      // old deadline check lived inside the loop BODY, so it only ran when a
      // chunk arrived: a parent that piped stdin and never wrote nor closed
      // hung in the await forever, past every deadline — the exact case the
      // constant exists to bound. A slow-but-flowing producer keeps winning
      // its per-read races and is never refused; only a pipe that stops
      // moving for the whole window is.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new FleetError(
              2,
              `${intake.noun}-stdin-timeout`,
              `no ${intake.noun} arrived on stdin within ${STDIN_BRIEF_TIMEOUT_MS / 1000}s`,
              `the writer holding this pipe's write end never closed it — close it, or ${intake.instead}`,
            ),
          );
        }, STDIN_BRIEF_TIMEOUT_MS);
      });
      let res: Awaited<ReturnType<typeof reader.read>>;
      try {
        res = await Promise.race([reader.read(), stall]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (res.done) break;
      const chunk = res.value;
      bytes += chunk.byteLength;
      if (bytes > MAX_BRIEF_BYTES) {
        throw new FleetError(
          2,
          `${intake.noun}-too-large`,
          `${intake.noun} exceeds the ${MAX_BRIEF_BYTES} byte cap`,
          `trim the ${intake.noun} or split payload out of it`,
        );
      }
      chunks.push(chunk);
    }
  } catch (e) {
    // Cancel, not just release: the abandoned read must not keep the stream
    // open behind the refusal.
    await reader.cancel().catch(() => {});
    throw e;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `--brief <path>`: a regular file, under the cap, with the errno named. */
function readBriefFile(briefPath: string): string {
  const unreadable = (why: string): FleetError =>
    new FleetError(
      2,
      "brief-unreadable",
      `cannot read --brief ${bounded(briefPath)}: ${why}`,
      "point --brief at a readable regular JSON file",
    );
  /**
   * Classify by whether a RETRY could clear it — the same doctrine `asUsage`
   * applies to its constructors, now applied here too. EMFILE/ENFILE/EAGAIN
   * are the substrate running out of fds or a non-blocking fd refusing, not a
   * typo'd path: wrapping them into the permanent exit-2 envelope told
   * automation "never retry" while the condition was gone milliseconds later
   * (round 10). They rethrow raw so `report` renders them as exit 1
   * `transient`; everything else stays the usage refusal.
   */
  // Explicit variable annotation, not just the arrow's return type: TypeScript
  // narrows control flow across a never-returning call only when the callee is
  // so annotated at the DECLARATION.
  const unreadableOrTransient: (e: unknown) => never = (e) => {
    const errno = (e as NodeJS.ErrnoException | null)?.code;
    if (errno !== undefined && RETRYABLE_ERRNOS.has(errno)) throw e;
    throw unreadable(errno ?? (e as Error).message);
  };
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(briefPath);
  } catch (e) {
    // ENOENT / EACCES / ELOOP are not "invalid JSON" — the file was never read.
    // (Transient errnos exit 1 instead — see `unreadableOrTransient`.)
    unreadableOrTransient(e);
  }
  // A directory, /dev/zero or a FIFO all report size 0: the cap would be
  // vacuous and the read unbounded. Only a regular file has a size worth
  // trusting, and only a regular file can be refused before it is opened —
  // opening a FIFO BLOCKS until a writer appears, so this check has to stay
  // ahead of the open even though the fstat below is the binding one.
  if (!st.isFile()) throw unreadable("not a regular file");
  if (st.size > MAX_BRIEF_BYTES) {
    throw new FleetError(
      2,
      "brief-too-large",
      `brief is ${st.size} bytes; the cap is ${MAX_BRIEF_BYTES}`,
      "trim the brief or split payload out of it",
    );
  }
  // The proofs above are about whatever the PATH named when it was stat'd; the
  // read is of whatever it names now. Re-point the path in between (a symlink
  // swung at a 4 GB file, a device node) and both the regular-file check and
  // the cap describe a different inode than the bytes that arrive. Open once,
  // prove the OPEN DESCRIPTOR, and read from it: `MAX_BRIEF_BYTES + 1` bytes,
  // so the cap binds on what was actually read rather than on a size that could
  // have grown since.
  let fd: number;
  try {
    fd = openSync(briefPath, "r");
  } catch (e) {
    unreadableOrTransient(e);
  }
  try {
    if (!fstatSync(fd).isFile()) throw unreadable("not a regular file");
    const buf = Buffer.alloc(MAX_BRIEF_BYTES + 1);
    let n = 0;
    for (;;) {
      let r: number;
      try {
        r = readSync(fd, buf, n, buf.length - n, null);
      } catch (e) {
        unreadableOrTransient(e);
      }
      if (r <= 0 || n + r >= buf.length) {
        n += Math.max(0, r);
        break;
      }
      n += r;
    }
    if (n > MAX_BRIEF_BYTES) {
      throw new FleetError(
        2,
        "brief-too-large",
        `brief exceeds the ${MAX_BRIEF_BYTES} byte cap`,
        "trim the brief or split payload out of it",
      );
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Refuse `--brief <path>` when a brief was ALSO redirected onto stdin.
 *
 * `fleet dispatch --brief old.json < new.json` provisioned from old.json and
 * said nothing — the same "acting on something other than what the operator saw
 * themselves type" this file refuses `--dir` twice for, except the outcome here
 * is a billable box built from the wrong brief. Both sources were explicitly
 * supplied, so neither can be silently preferred.
 *
 * The test is fd 0's TYPE, not `isTTY`. A CLI run from cron, systemd or a
 * container has stdin on /dev/null and no tty, so refusing on `!isTTY` would
 * break every non-interactive `--brief` invocation there is.
 *
 * ALLOW-LIST, not a deny-list, and that is the whole lesson of the bug this
 * shape replaces. An early version allowed everything but fifo-or-regular-file,
 * which quietly allowed the WRONG socket case; round 11 tightened the split to
 * what the type can actually prove (see the list below). Enumerated reasons,
 * closed set: the next stdio type someone invents is REFUSED by default, which
 * is the direction a guard on a billable path should fail.
 *
 * Benign, and the complete list: a character device — `/dev/null` (cron,
 * systemd, containers) and a tty (an operator who typed the command and
 * redirected nothing) are both one; a closed fd 0, where `fstat` throws EBADF;
 * and a SOCKET (round 11). A socket is what fd 0 is under any Node/Bun parent
 * spawning with `stdio: "pipe"` — the most common programmatic caller there
 * is — and no brief was attached to it: the socket IS the parent's unattended
 * default, not a second source. The first cut of this list refused sockets,
 * which turned every such `--brief` invocation into the exact "two sources"
 * refusal the guard exists to prevent, minus the two sources. Everything else
 * (fifo, regular file, and any type nobody has thought of yet) is refused:
 * a fifo is fed by a pipeline the caller wrote, a regular file by a `<`
 * redirect the caller wrote — deliberate attachments both.
 *
 * A fifo or regular file is refused only if it actually carries a byte —
 * round 12 found type alone can't tell "a real pipeline" from "a parent that
 * merely inherited an unattended pipe/file on fd 0" (a CI runner's own
 * child-process plumbing reports the identical `isFIFO()` type). Two
 * TIMED/streaming peeks regressed worse than the false refusal they were
 * fixing (one wedged Bun's shared stdin stream, the other risked starving
 * libuv's threadpool on a pipe with an open, silent writer); the fix that
 * actually works is a genuinely NON-BLOCKING one: `--brief <path>` never
 * needs stdin's bytes, so consuming one to look is free in the branch that
 * proceeds and moot in the branch that refuses.
 */
async function assertOneBriefSource(briefPath: string): Promise<void> {
  let st: ReturnType<typeof fstatSync>;
  try {
    st = fstatSync(0);
  } catch {
    return; // no fd 0 at all — nothing was attached
  }
  if (st.isCharacterDevice() || st.isSocket()) return;
  // The peek is ASYNC now (worker + timeout — see stdinHasQueuedByte); the
  // caller is `ingestBriefJson`'s reader, which was already awaited.
  if (!(await stdinHasQueuedByte())) return;
  throw usageError(
    `--brief ${bounded(briefPath)} was given AND a brief was redirected onto stdin`,
    "pass the brief exactly one way: `--brief <path>`, or on stdin with no --brief",
  );
}

/**
 * The peek's body, run on a WORKER thread (see `stdinHasQueuedByte` for why).
 * Reopens fd 0 non-blocking, reads at most ONE byte, and posts a single
 * boolean: true = a byte was queued. `/dev/fd/0` first (present on darwin and
 * on Linux via the /proc symlink), `/proc/self/fd/0` as the Linux fallback.
 */
const STDIN_PEEK_WORKER_SOURCE = `
import { closeSync, constants, openSync, readSync } from "node:fs";
let fd = -1;
for (const path of ["/dev/fd/0", "/proc/self/fd/0"]) {
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    break;
  } catch {}
}
let queued = false;
if (fd >= 0) {
  try {
    queued = readSync(fd, Buffer.alloc(1), 0, 1, null) > 0;
  } catch {}
  try {
    closeSync(fd);
  } catch {}
}
self.postMessage(queued);
`;

/**
 * How long the peek may hold the verb before "nothing queued" is assumed. A
 * byte that is coming is already there — the pipeline's writer starts the
 * moment the shell forks it, and the guard runs only after argv parsing — so
 * this is generously past every real `cat x |` delivery and bounds only the
 * inherited, SILENT pipe (a CI runner holding the write end open for the job's
 * whole duration).
 */
const STDIN_PEEK_TIMEOUT_MS = 250;

/**
 * True iff fd 0 has at least one byte ready RIGHT NOW. Reading through the
 * reopen drains the SAME pipe buffer fd 0 does, which is fine: the only
 * callers are the ALLOW path (goes on to read `--brief <path>`, never stdin
 * again) and the REFUSE path (throws immediately) — nothing is ever left
 * wanting the peeked byte back.
 *
 * On a WORKER thread, bounded by a timer (round-3 A1). The reopen is genuinely
 * non-blocking on Linux — `/proc/self/fd/0` opens a NEW file description that
 * honors the O_NONBLOCK above, so the read answers instantly or fails EAGAIN.
 * On DARWIN, though, fdescfs implements `open("/dev/fd/0")` as a DUP of fd 0
 * sharing the SAME file description: O_NONBLOCK is ignored, and the read
 * inherits fd 0's blocking mode — reproduced here (an empty pipe with a
 * `sleep 300` writer parked the read past 6s). On the JS thread that is the
 * hang the round-12 comment feared, BEFORE the brief is read and before
 * `readCappedStdin`'s stall window is even armed. The peek cannot be dropped
 * either (the suite pins the fifo-with-content refusal it makes possible), so
 * it runs on a thread of its own and the timer bounds the wait: a queued byte
 * answers instantly; a silent writer costs the timeout and no more; the
 * worker is TERMINATED, not abandoned, so no thread is left parked in the
 * read. It does NOT repeat either round-12 failure: it never touches Bun's
 * shared stdin stream (the worker opens its own descriptor), and it parks no
 * fs-threadpool thread (a synchronous read on the worker's own stack).
 *
 * Fails OPEN, not closed: no worker available, a worker error, or a timeout
 * all proceed rather than refuse. A missed two-source case is the lesser harm
 * on a guard whose false-positive already broke real automation (round 12).
 */
async function stdinHasQueuedByte(): Promise<boolean> {
  let worker: Worker;
  try {
    worker = new Worker(
      `data:text/javascript;base64,${Buffer.from(STDIN_PEEK_WORKER_SOURCE).toString("base64")}`,
    );
  } catch {
    // Fail-open stays (a missed two-source case is the lesser harm), but not
    // silently: an operator diagnosing a brief that was read twice would
    // otherwise never learn the guard was disarmed this invocation.
    try {
      writeSync(2, "fleet: warning: stdin peek worker unavailable — the two-brief-source guard is OFF this invocation\n");
    } catch {
      /* stderr refuses too */
    }
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const settle = (answer: boolean): void => {
      clearTimeout(timer);
      try {
        // Sync-shaped on Bun, promise-returning under the worker_threads
        // shape — a rejection after settle must not become an unhandled
        // rejection, and a sync return has no `.catch` to hang it on.
        void Promise.resolve(worker.terminate()).catch(() => {});
      } catch {
        /* already gone */
      }
      resolve(answer);
    };
    const timer = setTimeout(() => settle(false), STDIN_PEEK_TIMEOUT_MS);
    worker.addEventListener("message", (e: MessageEvent) => settle(e.data === true));
    worker.addEventListener("error", () => settle(false));
    // An exit without a message (source threw, runtime refused the data URL):
    // the same fail-open answer. Harmless after a settle — the promise is
    // already resolved and a terminate of a dead worker is caught above.
    worker.addEventListener("exit", () => settle(false));
  });
}

/**
 * Brief ingress shared by every brief-eating verb — `dispatch` and DF3.2's
 * `fanout`. The readBrief seam else the --brief/stdin discrimination, the
 * byte cap enforced AS READ (skipped for a lossy decode), and JSON.parse.
 * Extracted when fanout became the second caller: two copies of the cap/TTY/
 * source discipline is exactly how they drift. The pieces themselves stay put:
 * `readCappedStdin` streams its cap, `readBriefFile` proves the open
 * descriptor, `assertOneBriefSource` allow-lists fd 0.
 *
 * Every refusal is a FleetError exit 2, so both callers' catch blocks render
 * it unchanged. Nothing here touches disk beyond reading the brief itself.
 */
async function ingestBriefJson(briefPath: string | undefined, deps?: Partial<FleetDeps>): Promise<unknown> {
  const readBrief: () => Promise<string> =
    deps?.readBrief ??
    (async () => {
      if (briefPath !== undefined) {
        await assertOneBriefSource(briefPath);
        return readBriefFile(briefPath);
      }
      // No prompt: a TTY here means the operator typed a verb and would wait
      // forever for bytes that are never coming. A non-TTY (pipe) read IS
      // bounded — STDIN_BRIEF_TIMEOUT_MS, see readCappedStdin.
      if (process.stdin.isTTY) {
        throw usageError("no brief on stdin", "pipe the brief JSON in, or pass --brief <path>");
      }
      return readCappedStdin();
    });

  const rawBrief = await readBrief();
  // The cap is on BYTES whichever source produced the text — `.length` counts
  // UTF-16 code units, which under-measures every non-ASCII brief. The
  // re-measure is UNCONDITIONAL (round 10): a presence test for U+FFFD cannot
  // tell a lossy decode from a brief that legitimately contains the character,
  // so a legit-FFFD carrier could slip a >cap payload past this second
  // enforcement site. Over-refusing a corrupt sub-cap corrupt brief is the
  // accepted trade; the real readers still cap raw bytes as they read.
  {
    const briefBytes = Buffer.byteLength(rawBrief, "utf8");
    if (briefBytes > MAX_BRIEF_BYTES) {
      throw new FleetError(
        2,
        "brief-too-large",
        `brief is ${briefBytes} bytes; the cap is ${MAX_BRIEF_BYTES}`,
        "trim the brief or split payload out of it",
      );
    }
  }
  try {
    return JSON.parse(rawBrief); /* dp:ok guarded below: catch maps parse failure to FleetError(2, invalid-brief) */
  } catch (e) {
    throw new FleetError(
      2,
      "invalid-brief",
      `brief is not valid JSON: ${(e as Error).message}`,
      "fix the JSON on stdin or in --brief <path>",
    );
  }
}

/**
 * The budget gate's ONLY storage handle, wired beside the records dir. One
 * implementation for dispatch and fanout — only a genuine missing record reads
 * as undefined; every other read failure refuses the dispatch. NOT wrapped in
 * `asUsage`: the factory runs inside each verb's admission try, which already
 * maps an unopenable or busy ledger to its own exit-5 refusal. Wrapping here
 * would only relabel the message on the way there.
 */
function makeLedgerFactory(store: RunRecordStore): () => LedgerLike {
  return (): LedgerLike => {
    const ledger = new CostLedger({
      ...costLedgerOpts(store.dir),
      // Orphan-guard seam wiring (round 10): without it, recordStructurallyAbsent
      // stats `$QDS_RUNS_DIR ?? .sandbox/runs` — a directory THIS store never
      // wrote — so an aged read-fault cross-check reads absence from the wrong
      // tree.
      runsDir: store.dir,
      readRunRecord: (id: string) => {
        try {
          return store.get(id);
        } catch (e) {
          // Optional-chained: a `throw null` must not become a TypeError in the
          // handler that is supposed to classify it.
          if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
          throw e;
        }
      },
    });
    return ledger;
  };
}

/**
 * Structural minimum the loser-ledger hook needs from a handle: the real
 * CostLedger satisfies it, and tests substitute a controllable fake.
 * `ingestCostEvent` is optional on the handle for the same structural reason
 * `CostLedgerHook` makes it optional — the real ledger always has it.
 */
interface LoserLedgerHandle {
  ingestBoxHours(ctx: BoxHoursCtx): IngestResult;
  ingestCostEvent?(event: CostWireEvent, ctx: IngestCtx): IngestResult;
  close(): void;
}

/**
 * The lazy loser-ledger hook (see the fanout block's comment): opened on the
 * FIRST ingest, closed by the fanout verb's finally — teardown's close step
 * only ever ingests. The reference drop is unconditional (try/finally):
 * a close() that THROWS must still drop the handle, because an abandoned
 * loser teardown can reach its ingest after the verb's finally ran, and on a
 * handle whose close failed bun:sqlite answers "Database has closed" — the
 * late row lost, under-counting the ledger the cap admits against.
 * Dropped, the late ingest re-opens a fresh ledger, and the event-id conflict
 * rule keeps it idempotent against rows already landed. The throw still
 * propagates: the verb's finally is what reports it (exit 6). The opener seam
 * exists so that contract is testable without manufacturing a SQLite close
 * failure (bun's close is idempotent — a double close does not throw).
 *
 * PR #253 review: `ingestCostEvent` forwards too, through the SAME
 * lazy-open/drop-on-close seam — a loser teardown's close step drives the
 * harvested engine log's cost_attribution rows through it (teardown's
 * `ingestHarvestedTokensIfWired` no longer sees a hook without the method and
 * silently skips the run's token spend, which the cap then never counted).
 */
export function makeLoserLedgerHook(
  openLedger: () => LoserLedgerHandle,
): CostLedgerHook & { close(): void } {
  let handle: LoserLedgerHandle | undefined;
  return {
    ingestBoxHours: (ctx) => {
      if (handle === undefined) handle = openLedger();
      return handle.ingestBoxHours(ctx);
    },
    ingestCostEvent: (event, ctx) => {
      if (handle === undefined) handle = openLedger();
      const ingest = handle.ingestCostEvent;
      // Only a fake without the method lands here; the real CostLedger always
      // carries it. Fail loudly — "not asked" is the hook-less posture, never
      // a quiet zero (INV-COST-9).
      if (ingest === undefined) {
        throw new Error("loser-ledger handle exposes no ingestCostEvent — token rows cannot be ingested");
      }
      return ingest.call(handle, event, ctx);
    },
    close(): void {
      try {
        handle?.close();
      } finally {
        handle = undefined;
      }
    },
  };
}

/**
 * rank's record half: ENOENT reads as "no such fan-out" (rank maps null to its
 * exit-4 fanout-not-found), every OTHER read failure propagates — a malformed
 * or unreadable record is exit 1 substrate, never a quiet misscored arm.
 */
function readFanoutForRank(store: FanoutRecordStore, fanoutId: string): FanoutRecord | null {
  try {
    return store.get(fanoutId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Every verb logs one structured line (CC-9 observability contract):
 * {requestId, runId, verb, phase, timestamp, durationMs, exitStatus}.
 *
 * The exit table splits cleanly on retryability, so `exitStatus` follows it:
 * exit 1 is a run/provider failure — the substrate, not the invocation — and is
 * worth retrying, which is what `transient` means to whatever reads these lines
 * (dispatch's own refusal path already classifies its exit 1 the same way).
 * 2-5 are the operator's brief, flags, id or budget, and 6 is a wedged cleanup
 * that no amount of retrying can clear: retrying any of them is futile.
 *
 * `exitStatusOverride` carries the one exception the table cannot see: an
 * error that KNOWS its own classification despite landing on a do-not-retry
 * code (fanout's list-unverified refusal rides exit 5 but is the substrate
 * failing to answer — fanout-primitive's invalid() attaches it to the
 * FleetError). Undefined ⇒ the code-derived default, unchanged.
 */
/**
 * What a verb line may claim about its outcome. `ExitStatus` is the table's
 * vocabulary; `"signalled"` (round 11) covers 128+n exits, which sit outside
 * the classification table by design (see the header) and previously fell
 * through to `logic` — reading a Ctrl-C as a non-retryable logic failure.
 * `LogEntry`'s index signature carries the extra word without widening
 * cli-anything's enum for every other consumer.
 */
type VerbExitStatus = ExitStatus | "signalled";

/**
 * A sink that raises on EVERY emit must not be silent about it: one stderr
 * line per process names the fault while the events stay dropped (a broken
 * sink is broken) and the verbs keep their exit codes. Shared by `logVerb`
 * and `gateEvent` — the two producers of this CLI's structured lines — so a
 * raising sink degrades identically whichever producer hits it first.
 *
 * ONCE PER PROCESS is the pinned contract (F5.39, gate-verbs.test): an
 * embedder's later `run()` invocations with the same broken sink stay silent
 * after the first note. Round-3 A4 asked for a per-invocation latch on
 * embeddability grounds; the pin deliberately chooses one-line-per-process
 * over warn-per-invocation, so the latch stays global and the ask is the test
 * wave's to re-litigate, not this patch's.
 */
let warnedAboutSink = false;
function warnSinkRaising(): void {
  if (warnedAboutSink) return;
  warnedAboutSink = true;
  try {
    // SYNCHRONOUS (`writeAll` ⇒ `writeSync(2)`), not `process.stderr.write`:
    // this warning fires at the moment a verb is giving up on its structured
    // lines, which is frequently seconds before `process.exit` — and a stderr
    // that is a pipe (every captured run) writes `process.stderr` ASYNC, so the
    // one-per-process "gate events are being dropped" note was itself droppable
    // by the exit that followed it. `writeAll` also loops over short writes,
    // which a bare `writeSync` does not. Still best-effort: a stderr that
    // refuses the bytes (EPIPE, EBADF, EAGAIN) must not replace the verb's
    // outcome, which is what the catch is for — it is the fallback now, not the
    // primary delivery path.
    writeAll(2, "fleet: warning: the structured log sink is raising — gate events are being dropped\n");
  } catch {
    /* stderr is gone too; nothing else to do */
  }
}

function logVerb(
  requestId: string,
  verb: string,
  runId: string | undefined,
  startedAt: number,
  code: number,
  exitStatusOverride?: VerbExitStatus,
  /**
   * The one field that keeps a help request from being counted as a successful
   * verb execution (round 10): `fleet teardown <id> --driver real --help` used
   * to land a line indistinguishable from `fleet teardown <id>` — same
   * `status:"ok"`, same `exitStatus:"success"` — and dashboards counting
   * completions by this line counted a phantom teardown. It stays exit 0 (a
   * help request IS a successful invocation of the help path); it just no
   * longer CLAIMS to be a completed verb.
   */
  phase: "complete" | "help" = "complete",
): number {
  const durationMs = Date.now() - startedAt;
  // Guarded like `gateEvent`: a raising sink must not turn the invocation's
  // OWN completion line into an untyped throw past `finish` — that would
  // convert a settled exit code into a crash (`finish` sits outside every
  // verb `try`). One stderr note, once per process, same rule.
  try {
    log({
      requestId,
      operation: `fleet.${verb}`,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: code === 0 ? "ok" : "error",
      // Both are argv-derived on the refusal paths that reach here, and both are
      // capped at the ONE place every verb's line is built rather than at each
      // call site (one that forgot is how the unbounded `runId` shipped).
      runId: runId === undefined ? null : bounded(runId),
      verb: bounded(verb),
      phase,
      exitCode: code,
      // A caller with knowledge the exit table lacks (the only statuses it can
      // name are success/transient/logic) passes its own classification; the
      // table below is the fallback for every call site that has nothing
      // finer-grained to add.
      exitStatus:
        exitStatusOverride ?? ((code === 0 ? "success" : code === 1 ? "transient" : "logic") as ExitStatus),
    });
  } catch {
    warnSinkRaising();
  }
  return code;
}

/**
 * The runId a failed verb was acting on, when the throw itself knows it.
 * `dispatch` mints its id mid-flight, so a refusal after that point carries it
 * in the FleetError payload — without this the CLI's own log line would report
 * `null` for a run that demonstrably exists and may still hold a live box.
 */
function runIdFromError(e: unknown): string | undefined {
  const runId = e instanceof FleetError ? e.payload?.runId : undefined;
  return typeof runId === "string" ? runId : undefined;
}

/**
 * Cap an argv-derived token before it reaches a log field. `fleet teardown
 * $(head -c 200000 /dev/urandom)` is refused, but the id it was refused for
 * still landed unbounded in the CC-9 line's `runId` — one refused invocation
 * writing 200 KB into the operator's log stream.
 *
 * REDACT first, THEN cap — the order `assertFleetRunId` fixed for the refusal
 * echo. Capping first sliced a pasted credential across the 96-char boundary
 * into halves neither redaction rule matches, and nothing downstream of this
 * sink redacts at all, so the head went out verbatim. Minted ids
 * (`qds-YYYYMMDD-hex`, well under `redactSecrets`' 40-char floor) pass through
 * untouched, so ordinary runs log exactly as before.
 */
// The BODY moved to `src/providers/step-log.ts` (next to the redactor it
// composes) when `src/fleet/approval-gate.ts` became a second caller — `src/`
// cannot import from `scripts/`, so one shared callee is the only way both get
// the same rule. Kept as a local name rather than renaming ~30 call sites; the
// comment above is the reasoning, which travels with the implementation.
function bounded(s: string | undefined): string {
  return boundedEcho(s);
}

/**
 * The ONE spelling of "positive decimal flag" (F050). Three flags had three
 * regexes, three range checks and three copies of the same comment.
 *
 * Plain decimal ONLY, before `Number()` gets a say: it accepts hex (`0x1f4` →
 * 500), exponents (`1e3` → 1000), surrounding whitespace (`" 8080 "`) and zero
 * padding (`08080`) — every one of them an integer in range, and none of them
 * the number the operator typed. Digits are unbounded here on purpose: the
 * ceiling is `max`, not the regex width, so an over-long value is refused by
 * the range check with the range's own message rather than the grammar's.
 *
 * `noun` and `remediation` stay per-flag: they are the two halves an operator
 * reads, and parameterising them is what let the three call sites collapse
 * without rewording a single existing refusal.
 */
function parseDecimalFlag(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
  noun: string,
  remediation: string,
): number {
  const n = typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    // `bounded`: a rejected value is echoed, and argv is unbounded. `undefined`
    // is echoed bare (`JSON.stringify(undefined)` is not a string) — the
    // absent-flag wording every caller already had.
    throw usageError(
      `${name} ${raw === undefined ? "undefined" : JSON.stringify(bounded(raw))} is not ${noun}`,
      remediation,
    );
  }
  return n;
}

/**
 * Observe the run-id MINT through the one object both sides of a dispatch
 * already share — the record store. `dispatch()` persists the record via
 * `store.create(runId)` long before its promise resolves, but the CLI only
 * learned the id from the RESOLVED ack, so a SIGINT landing between the two
 * logged the interrupt line with `runId: null` for a run that demonstrably
 * existed on disk. Wrapping the store turns the persist itself into the
 * notification; the first created id wins, and every other member forwards
 * untouched (RunRecordStore's privates are compile-time only, so property
 * access through the proxy is transparent).
 *
 * Additive by design: no seam was added to src/fleet/dispatch.ts, and an
 * injected store is wrapped exactly like a constructed one. Exported so tests
 * can pin the forwarding + capture contract directly.
 */
export function observingMint(store: RunRecordStore, onMinted: (runId: string) => void): RunRecordStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop !== "create") return Reflect.get(target, prop);
      const create = target.create.bind(target);
      return (runId: string, now?: Date) => {
        onMinted(runId);
        return create(runId, now);
      };
    },
  });
}

/**
 * `fleet observe <run-id>` — DF3.7's approval-gate bridge.
 *
 * Watches one dispatched run's terminal marker through the shipped classifier
 * and, on a settled reading, drives the chain the operator runs by hand today
 * (harvest → teardown → reverify → the gate). Everything marker-shaped lives
 * in `src/fleet/run-completion.ts`; this block is the argv/exit-code surface
 * over it, exactly as `run` is over `src/fleet/run.ts` and teardown is over
 * DF2.5.
 *
 * The BLOCK ORDER is binding (AC5): argv → driver → records dir → THE LOCK,
 * with the pre-flight record read and everything after it (worktree assert,
 * key/ledger wiring, the poll, the chain) INSIDE the callback — no
 * check-then-act straddles the lock boundary. The module acquires nothing
 * itself: the handle `withRunLock` hands the callback is the one the chain's
 * teardown and the gate's #245 closure reuse, and a second acquire inside
 * would throw `RunLockReentrantError`.
 */
async function runObserve(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, dir, storeOpts, note, finish, reportCompletion, outputIncomplete } = ctx;
  const runIdArg = positionals[1];
  const driverName = flags.get("--driver");
  const windowRaw = flags.get("--window-ms");
  const requestId = newRequestId();
  const usage = "fleet observe <run-id>|--all --driver <name> [--window-ms <ms>]";
  // DF3.8: the `--all` sweep — its own arm, returning BEFORE the single-run
  // path below, whose behavior stays byte-identical (AC5/AC6).
  if (ctx.bools.has("--all")) return runObserveSweep(ctx, requestId, usage);
  /** 6, not 0, when the chain landed but the ledger would not close (fanout's one cleanup policy). */
  let ledgerCloseFailed = false;
  /** C10: the audit store's close obeys the SAME policy — one fault, one code. */
  let auditCloseFailed = false;
  /**
   * Latched by the deferred open below when the store would not open: the
   * chain's links were dropped. Verb-scoped because it feeds the same exit
   * decision the close failures do — a store that never opened dropped strictly
   * more evidence than one that would not close cleanly.
   */
  let auditLinksDropped = false;
  try {
    if (positionals.length > 2) throw usageError("observe takes exactly one <run-id>", usage);
    if (runIdArg === undefined) throw usageError("observe requires <run-id>", usage);
    assertFleetRunId(runIdArg);
    // This verb reads INTO the box (marker polls through the driver port) and
    // drives a teardown — attach's placement: no driver default, ever.
    assertDriverChosen(verb, driverName, deps?.driver);
    // The window is operator-settable precisely because fan-out's 1 h ceiling
    // is race-shaped and an unattended run routinely outlives it; the default
    // is the module's own (provisional until the live e2e reprices it). An
    // ABSENT flag means that default — the registry declares --window-ms
    // optional and its note names the default, so refusing `undefined` here
    // would make the documented invocation `fleet observe <id> --driver d`
    // exit 2 (the one bug the exit-4 probe caught on its first run).
    const windowMs =
      windowRaw === undefined
        ? DEFAULT_OBSERVATION_WINDOW_MS
        : parseDecimalFlag(
            "--window-ms",
            windowRaw,
            1,
            86_400_000,
            "a positive number of milliseconds",
            `pass --window-ms <ms> between 1 and 86400000 — the default is ${DEFAULT_OBSERVATION_WINDOW_MS}`,
          );
    // Cleanup posture, teardown's: the chain this verb drives destroys the
    // box, so an operator collecting a run must not be blocked by the
    // create-time driver gates on the way to it.
    const driver =
      deps?.driver ?? asUsage(() => resolveCleanupDriver(driverName as string, { requestId, runId: runIdArg }));
    assertRecordsDirUsable(dir, deps?.store);
    // The chain WRITES through this store (`closedAt`, the gate's approval
    // extension), so this is the writable construction — with runDestructive's
    // round-11 guard: a NAMED --dir is never created by a refused invocation.
    let store: RunRecordStore =
      deps?.store ??
      asUsage(() => new RunRecordStore({ ...storeOpts, ...(dir === undefined ? {} : { create: false }), requestId }));

    // AC5 lock-before-preflight: the verb registered as "observe" holds
    // <runsDir>/<runId>.lock across the whole bounded poll AND the chain it
    // drives; the pre-flight record read and everything after it run inside
    // the callback. A refusal to acquire is this verb's exit 5.
    const outcome = await withRunLock(store.dir, runIdArg, "fleet observe", async (h) => {
      // exit 4 for a genuine absence, 5 for an unreadable record — the shared
      // classifier every other single-run verb probes through.
      assertRunExists(store, runIdArg);
      // The probe passed, so the directory is one the run legitimately owns:
      // NOW the writable store the chain acts through (round-11 twin).
      if (dir !== undefined && deps?.store === undefined) {
        store = asUsage(() => new RunRecordStore({ ...storeOpts, requestId }));
      }
      const rec = getRecord({ store }, runIdArg);
      // reverify() re-judges the tree host-side, so the repo root is asserted
      // BEFORE any box is touched: a non-repo cwd is a start-up refusal, never
      // a `verdict:"error"` after the box is gone (Technical Notes). stdout
      // must be "true" AND exit 0 — inside `.git/` prints "false" WITH exit 0.
      const hostRoot = process.cwd();
      const worktree = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: hostRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (worktree.exitCode !== 0 || worktree.stdout.toString().trim() !== "true") {
        throw new FleetError(
          5,
          "reverify-host-root-unusable",
          `${hostRoot} is not a git worktree — the re-verification this verb drives needs a repo root`,
          "run fleet observe from the repo the run was dispatched against (the cwd is its hostRoot) — nothing was mutated",
          { runId: runIdArg, hostRoot: bounded(hostRoot) },
        );
      }
      // Fail-closed BEFORE any box touch on a keyed record: the chain's
      // teardown revokes through this client. Unkeyed: no client is built —
      // an unused one throws on first use rather than minting silently.
      // Keyed includes the S1 swarm namespace: a swarm record's revocable
      // keys ride extensions.swarmSeats (no core keyHash), and a chain
      // teardown that refuses at the spend guard strands those keys live.
      const swarmKeyCount = (rec.extensions?.swarmSeats?.keyHashes as string[] | undefined)?.length ?? 0;
      const keyApi =
        deps?.keyApi ?? (rec.keyHash !== undefined || swarmKeyCount > 0 ? asUsage(() => openRouterKeyApi()) : unusedKeyApi());
      // The write-path ledger teardown's box-hours ingest settles into — the
      // same constructor shape dispatch/teardown build beside the records dir,
      // WITH dispatch's readRunRecord seam (makeLedgerFactory's wiring): the
      // ingest re-reads the record at close time, and the CostLedger default
      // (`() => ({ createdAt: "" })`) reads as a phantom record whose closedAt
      // is never set — box-hours-record-open on EVERY driven run (T2.8 red
      // rounds 1-2, 2026-09-15).
      const costLedger = asUsage(
        () =>
          new CostLedger({
            ...costLedgerOpts(store.dir),
            runsDir: store.dir,
            readRunRecord: (id: string) => {
              try {
                return costRecordProjection(store.get(id));
              } catch (e) {
                if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
                throw e;
              }
            },
          }),
      );
      // DF5.3: the chain's teardown emits its `teardown` link — this verb is
      // the composition root, so the store opens beside the ledger handle and
      // closes in the same finally.
      // Opened on the FIRST link, not at the verb's entry: an observation whose
      // marker never settles inside the window drives nothing and emits
      // nothing, and must not materialise audit.db (+ its -wal/-shm) — the
      // file-set discipline F044 set for the ledger and sandbox-reap restates
      // for its dry run. Nothing is lost by deferring: the run is already
      // dispatched and BILLING by the time this verb runs, so an eager open
      // buys no fail-before-spend property (unlike fanout's, which precedes
      // provisioning and is deliberately kept eager).
      //
      // DECIDED (DF5.3 round 3), and the reason the open is not a bare `??=`:
      // the FIRST link is emitted from inside `emitTeardownLink`, which sits
      // after destroy, revoke, close and the ledger ingest and PROPAGATES its
      // refusal — so an unwritable store made a fully successful chain teardown
      // fail at its final statement, and this verb reported failure for work
      // that had landed. Here the teardown has already happened: a dropped link
      // is a recoverable `unlinked` at hop 4/5 (the next teardown's healing arm
      // re-emits it), an aborted chain is not. So a store-open failure at the
      // first link is a REPORTED DEGRADATION — classified, logged, and folded
      // into the exit code below like the close failures — never a throw.
      // Latched, because `??=` left `chainAudit` undefined after a failed open
      // and every later link re-attempted and re-threw: one fault, N failures.
      let chainAudit: AuditStoreWriter | undefined;
      const recordChainAuditLink = (link: ProviderAuditLink): void => {
        if (auditLinksDropped) return;
        if (chainAudit === undefined) {
          try {
            chainAudit = openAuditStore();
          } catch (e) {
            auditLinksDropped = true;
            const refusal = auditStoreUnavailable(
              e,
              `the chain's links for ${runIdArg} were dropped — the teardown itself is unaffected`,
            );
            printError(
              note,
              refusal.code,
              refusal.message,
              `${refusal.remediation}; hop 4/5 reports this run unlinked until a later \`fleet teardown ${runIdArg}\` re-emits it`,
              { runId: runIdArg },
            );
            return;
          }
        }
        chainAudit.record(link);
      };
      let chainOutcome: ChainOutcome;
      try {
        chainOutcome = await observeAndDriveChain(runIdArg, {
          driver,
          store,
          runsDir: store.dir,
          hostRoot,
          runLock: h,
          keyApi,
          recordAuditLink: recordChainAuditLink,
          // The RECORD's dispatch stamp is the join key whenever it carries
          // one — the module's recordRequestId applies that truthiness rule,
          // so this invocation's mint is what is passed: `??` here would let
          // a record stamped "" win, and the sweep case (which dispatches
          // nothing and mints no stamp) must not invent one (observability
          // contract).
          requestId,
          costLedger,
          windowMs,
        });
      } finally {
        // The ledger owns a SQLite handle: closed on every path, guarded, and
        // 6 (never 0) when the chain had landed — teardown's and fanout's one
        // cleanup-failure policy.
        try {
          costLedger.close();
        } catch (e) {
          ledgerCloseFailed = true;
          const x = (e ?? {}) as { message?: string };
          printError(
            note,
            "ledger-close-failed",
            `could not close the cost ledger: ${redactSecrets(x.message ?? e)}`,
            "the handle dies with the process; re-run to confirm it still reads",
          );
        }
        // DF5.3: the audit store closes on the same discipline — every link it
        // wrote is already committed, so a close fault is bookkeeping, not a
        // verb to retry. C10: it still feeds the exit decision (a store that did
        // not close cleanly may not have flushed). `?.` because a chain that
        // emitted nothing never opened one.
        try {
          chainAudit?.close();
        } catch (e) {
          auditCloseFailed = true;
          const x = (e ?? {}) as { message?: string };
          printError(
            note,
            "audit-store-close-failed",
            `could not close the audit-link store: ${redactSecrets(x.message ?? e)}`,
            "the handle dies with the process; re-run to confirm it still reads",
          );
        }
      }
      return chainOutcome;
    });

    /**
     * The outcome → exit map (the registry's declared table, DF3.7 AC5):
     * driven 0 · terminal run-engine-dead 5 · the transient pair
     * (run-completion-unobserved, box-unreachable) 1 · non-terminal unsettled
     * 0 (maxTicks — the foreground verb never sets it) · every refusal 5 ·
     * vetoed/approval-failed/chain-failed/handed-off 6.
     */
    let code: number;
    /** The stdout summary line: `kind` always, `code`/`chainMs` when the kind carries one. */
    const line: Record<string, unknown> = { runId: runIdArg, kind: outcome.kind };
    // An if/else chain, deliberately not a `switch`: this file's `case "…"`
    // arms are reserved for the dispatched VERBS (cli.test.ts's armed-arm
    // guard reads them back against the registry), and these literals are
    // ChainOutcome kinds, not verbs.
    if (outcome.kind === "driven") {
      line.chainMs = outcome.chainMs;
      if (outcome.markerOk !== undefined) line.markerOk = outcome.markerOk;
      code = 0;
    } else if (outcome.kind === "unsettled") {
      const t = outcome.terminal;
      if (t === undefined) {
        code = 0;
      } else {
        line.code = t.code;
        printError(note, t.code, redactSecrets(t.message), t.remediation);
        // run-engine-dead is a death certificate — identical on every retry,
        // so 5. Every other terminal arm is the TRANSIENT pair (the window
        // fill and the skip-streak fill, `run-completion-unobserved` and
        // `box-unreachable`): the box is left alive and the marker IS the
        // state, so a re-invocation is the designed recovery — 1. A terminal
        // code this table does not name keeps the transient posture: every
        // terminal arm fires in the poll phase, before any mutation.
        code = t.code === "run-engine-dead" ? 5 : 1;
      }
    } else if (outcome.kind === "refused") {
      line.code = outcome.code;
      printError(note, outcome.code, redactSecrets(outcome.message), outcome.remediation);
      code = 5;
    } else if (outcome.kind === "vetoed") {
      const reason = redactSecrets(outcome.reason);
      line.reason = reason;
      printError(
        note,
        "reverify-vetoed",
        `re-verification refused ${runIdArg}: ${reason}`,
        "the chain landed — box torn down, record closed — and the re-verifier judged the tree no; read the run's reverify report, nothing re-runs",
        { runId: runIdArg },
      );
      code = 6;
    } else if (outcome.kind === "approval-failed") {
      const error = redactSecrets(outcome.error);
      line.error = error;
      printError(
        note,
        "approval-failed",
        `the approval leg failed for ${runIdArg}: ${error}`,
        // The contract-fixed formatter over {kind, error}: names BOTH the
        // teardown verb and the gate's own log — no new field.
        `run \`fleet teardown ${runIdArg}\` if the box is still live, and read the approval gate's own log for this request failure (${error})`,
        { runId: runIdArg },
      );
      code = 6;
    } else if (outcome.kind === "chain-failed") {
      const step = sanitizeLabel(outcome.step, 64);
      line.step = step;
      printError(
        note,
        "chain-failed",
        `the chain for ${runIdArg} failed at step ${step}: ${redactSecrets(outcome.error)}`,
        step === "teardown"
          ? "the teardown aborted with the record still open and the box possibly alive — inspect the run (`fleet status`) and re-run teardown before anything else"
          : "the box is gone and the record may be closed — `fleet status <run-id>` says which; read the failure above before acting",
        { runId: runIdArg, step },
      );
      code = 6;
    } else {
      const gate = sanitizeLabel(outcome.outcome, 64);
      line.outcome = gate;
      printError(
        note,
        "approval-handed-off",
        `the gate did not register a new request for ${runIdArg}: ${gate}`,
        "the run is already in the pause flow or its approval is already decided — decide it with `fleet approve`/`fleet reject`, or read the gate log for the superseding report",
        { runId: runIdArg, outcome: gate },
      );
      code = 6;
    }
    // ONE stdout summary line for every outcome, through `reportCompletion`
    // with the `&& !outputIncomplete()` rule: a DRIVEN run whose line would
    // not print is the standing 6, never a silent 0 — on a failing arm the
    // typed envelope above is authoritative and a lost summary changes nothing.
    const printed =
      reportCompletion(
        [`${JSON.stringify(line)}\n`],
        code === 0
          ? undefined
          : "the typed outcome envelope on stderr is authoritative — this stdout line was a summary; re-check with `fleet status`",
      ) && !outputIncomplete();
    // `auditLinksDropped` rides the same rule: the chain LANDED and its
    // evidence did not, which is exactly 6's shape ("done, still needs an
    // operator") — and never over an outcome code the chain itself produced.
    if (code === 0 && (ledgerCloseFailed || auditCloseFailed || auditLinksDropped || !printed)) code = 6;
    return finish(requestId, verb, runIdArg, code);
  } catch (e) {
    // AC5: a lock refusal is this verb's exit 5 — refused before anything was
    // mutated, and for a STALE lock identical on every retry (runDestructive's
    // acquire-side reasoning).
    if (e instanceof RunLockedError) {
      printError(note, e.code, e.message, e.remediation, { runId: runIdArg });
      return finish(requestId, verb, runIdArg, 5);
    }
    return finish(requestId, verb, runIdArg, reportCode(note, e));
  }
}

/**
 * `fleet observe --all` — DF3.8's host-side sweep: the argv/exit surface over
 * `observeSweep` (src/fleet/observe.ts), exactly as `runObserve` is the
 * surface over the single-run module.
 *
 * THE EXIT TABLE IS DF3.7'S, CITED AND NOT RESTATED: a pass that COMPLETES
 * exits 0 whatever its candidates did — empty, all-refused, partial — because
 * a per-run refusal (completion-unwitnessed, run-lost-to-reboot,
 * sweep-engine-dead, sweep-box-unreachable, a busy or stale lock) is a
 * counted, logged skip, and the exit code belongs to the invocation, which
 * did not fail. Only a failure to complete the pass itself is non-zero:
 * usage 2, the module's typed start-up refusals 5 (non-worktree hostRoot,
 * unverified box listing — refused before anything was mutated and identical
 * on every retry), substrate failures through `reportCode`.
 */
async function runObserveSweep(ctx: VerbCtx, requestId: string, usage: string): Promise<number> {
  const { deps, verb, flags, dir, storeOpts, note, finish, reportCompletion, outputIncomplete } = ctx;
  const driverName = flags.get("--driver");
  try {
    if (ctx.positionals.length > 1) {
      throw usageError("observe --all takes no <run-id> — sweep the whole candidate set, or observe one run", usage);
    }
    if (flags.get("--window-ms") !== undefined) {
      // Not pedantry: an operator reaching for a wait on the sweep form has
      // misread what --all is, and honoring the flag would park the whole
      // serial pass behind one unfinished run (the exact hazard the story's
      // Technical Notes reject inheriting the window for).
      throw usageError("--window-ms is the single-run form's wait — a sweep is not a wait (one bounded read per candidate)", usage);
    }
    assertDriverChosen(verb, driverName, deps?.driver);
    assertRecordsDirUsable(dir, deps?.store);
    // Cleanup posture, teardown's: a settled candidate's chain destroys the
    // box, so an operator collecting runs must not be blocked by the
    // create-time driver gates on the way to them.
    const driver = deps?.driver ?? asUsage(() => resolveCleanupDriver(driverName as string, { requestId }));
    // Read-mode first (runObserve's round-11 twin): a NAMED --dir is never
    // created by a refused sweep. The writable store the chain writes through
    // opens lazily, inside the sweep, at the first candidate past its in-lock
    // re-read — the record's existence is the proof the dir is a runs dir.
    const store: RunRecordStore =
      deps?.store ??
      asUsage(() => new RunRecordStore({ ...storeOpts, ...(dir === undefined ? {} : { create: false }), requestId }));

    // Pass-level tally of the audit-link drops latched inside buildChainCtx:
    // each drop already prints its own stderr note, but on the unattended cron
    // surface those per-run lines can be lost to log handling while the
    // invocation still exits 0 — the completed pass restates the count once.
    let auditLinksDroppedCount = 0;

    const outcome = await observeSweep({
      driver,
      store,
      runsDir: store.dir,
      hostRoot: process.cwd(),
      requestId,
      // The per-run chain context, mirrored from runObserve's in-lock block:
      // key fail-closed on a keyed record, the write-path ledger WITH the
      // readRunRecord seam, the deferred-open audit store with its latched
      // drop policy — per candidate, closed by the sweep after each chain.
      buildChainCtx: (rec) => {
        const runId = rec.runId;
        // Same swarm-namespace wiring as runTeardown: a swarm record's keys
        // live in extensions.swarmSeats, not keyHash — without this the
        // chain-driven teardown refuses at the spend guard and strands the
        // seat keys live.
        const recKeys = (rec.extensions?.swarmSeats?.keyHashes as string[] | undefined)?.length ?? 0;
        const keyApi =
          deps?.keyApi ?? (rec.keyHash !== undefined || recKeys > 0 ? asUsage(() => openRouterKeyApi()) : unusedKeyApi());
        const costLedger = asUsage(
          () =>
            new CostLedger({
              ...costLedgerOpts(store.dir),
              runsDir: store.dir,
              readRunRecord: (id: string) => {
                try {
                  return costRecordProjection(store.get(id));
                } catch (e) {
                  if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
                  throw e;
                }
              },
            }),
        );
        // Opened on the FIRST link, not at entry, and latched on open failure
        // — runObserve's DF5.3 round-3 decision, per run: a store-open failure
        // at the first link is a REPORTED DEGRADATION, never a throw that
        // would abort an already-landed teardown.
        let chainAudit: AuditStoreWriter | undefined;
        let auditLinksDropped = false;
        const recordChainAuditLink = (link: ProviderAuditLink): void => {
          if (auditLinksDropped) return;
          if (chainAudit === undefined) {
            try {
              chainAudit = openAuditStore();
            } catch (e) {
              auditLinksDropped = true;
              auditLinksDroppedCount += 1;
              const refusal = auditStoreUnavailable(
                e,
                `the chain's links for ${runId} were dropped — the teardown itself is unaffected`,
              );
              printError(
                note,
                refusal.code,
                refusal.message,
                `${refusal.remediation}; hop 4/5 reports this run unlinked until a later \`fleet teardown ${runId}\` re-emits it`,
                { runId },
              );
              return;
            }
          }
          chainAudit.record(link);
        };
        return {
          keyApi,
          costLedger,
          recordAuditLink: recordChainAuditLink,
          close: () => {
            // Best-effort by contract; each fault is a typed note, and the
            // pass's exit is unaffected (a completed pass is a completed pass).
            try {
              costLedger.close();
            } catch (e) {
              const x = (e ?? {}) as { message?: unknown };
              printError(
                note,
                "ledger-close-failed",
                `could not close the cost ledger: ${redactSecrets(x.message ?? e)}`,
                "the handle dies with the process; re-run to confirm it still reads",
              );
            }
            try {
              chainAudit?.close();
            } catch (e) {
              const x = (e ?? {}) as { message?: unknown };
              printError(
                note,
                "audit-store-close-failed",
                `could not close the audit-link store: ${redactSecrets(x.message ?? e)}`,
                "the handle dies with the process; re-run to confirm it still reads",
              );
            }
          },
        };
      },
      // The writable twin, load-bearing only when a NAMED --dir was opened
      // read-mode above; with an injected store or the default runs dir it is
      // the same store.
      writableStore: deps?.store !== undefined || dir === undefined ? () => store : () => asUsage(() => new RunRecordStore({ ...storeOpts, requestId })),
    });

    if (outcome.kind === "refused") {
      // The module's start-up refusals — refused before any box was touched.
      printError(note, outcome.code, redactSecrets(outcome.message), outcome.remediation);
      return finish(requestId, verb, undefined, 5);
    }
    // ONE stdout summary line for the completed pass, with the standing 6
    // every emitting verb applies to a line that would not print. The raw
    // per-box uptime evidence has NO emitted channel: sweep-complete's line
    // carries the derived counters only, so the evidence stays here in the
    // returned summary (channel gap tracked as #266).
    const { uptime_evidence: _evidence, ...counters } = outcome.summary;
    const printed =
      reportCompletion([`${JSON.stringify({ all: true, ...counters })}\n`], undefined) && !outputIncomplete();
    // The single-run form exits 6 on this same event — "the chain landed and
    // its evidence did not" is exactly 6's shape there — but a sweep's exit
    // belongs to the invocation, and a completed pass is a completed pass: the
    // latched drops become ONE stderr note naming the count, never an exit.
    if (auditLinksDroppedCount > 0) {
      printError(
        note,
        "audit-links-dropped",
        `${auditLinksDroppedCount} driven run${auditLinksDroppedCount === 1 ? "" : "s"} finished with audit links dropped — the sweep continued past each, teardowns unaffected`,
        "the per-run audit-links-dropped notes above name each affected run; a later `fleet teardown <run-id>` re-emits one unlinked",
        { runs: auditLinksDroppedCount },
      );
    }
    return finish(requestId, verb, undefined, printed ? 0 : 6);
  } catch (e) {
    return finish(requestId, verb, undefined, reportCode(note, e));
  }
}

export async function run(
  argv: readonly string[],
  out: (s: string) => void,
  deps?: Partial<FleetDeps>,
  /**
   * Diagnostics sink. Defaults to `out` so a caller that captures one stream
   * still sees everything; `import.meta.main` binds it to stderr, which is
   * what keeps stdout pure output.
   */
  err: (s: string) => void = out,
): Promise<number> {
  const startedAt = Date.now();
  /**
   * Diagnostics sink, made unable to change an outcome. `report` and
   * `printError` are called from the harvest/teardown `finally` — where `code`
   * is about to be 6, "wedged, do not retry" — and from the catch blocks that
   * own every exit code this CLI produces. A throw out of any of them discards
   * that code for exit 1 `transient`, which is the retry loop the exit table
   * exists to prevent. `err` is a caller-supplied function, so the guard belongs
   * here rather than only on the `import.meta.main` binding.
   */
  const note = (s: string): void => {
    try {
      err(s);
    } catch {
      // A diagnostic that cannot be delivered is not the verb's outcome.
    }
  };
  /**
   * Output writes: never the verb's OUTCOME, but not silent either.
   *
   * `fleet teardown <id> | head -1` closes the pipe the moment head has its
   * line, so `out()` — `writeAll(1, …)` under `import.meta.main` — throws
   * EPIPE. Inside the verb's `try` that throw became `code = report(note, e)` =
   * 1, which `logVerb` stamps `transient`: automation RETRIED a destructive
   * verb that had already succeeded. Every write here describes work that is
   * already done, so no failed write may turn a completed teardown into "retry
   * me". ENOSPC or a bad fd is a real write failure and still throws.
   *
   * EPIPE and EAGAIN are both tolerated that far and then part company, because
   * they say different things about the OUTPUT. A hung-up reader is reading
   * nothing more either way, so EPIPE is silent. EAGAIN is an fd 1 a wrapper or
   * CI runner left non-blocking, still open, still being read — and `writeAll`
   * advances `off` across a partial write before it throws, so `fleet status`
   * over a fleet large enough to fill the pipe buffer ended mid-token on a
   * half-written `{"runId":"…`. Exit 0 then said that truncated listing WAS the
   * fleet — the same lie `listUnavailable` → exit 1 exists to prevent, and a
   * `| jq` consumer gets a parse error or, worse, a short listing it believes.
   * So it is recorded here and folded into the exit code by `finish`, rather
   * than swallowed as success or thrown as a retryable failure.
   *
   * NOT used for the dispatch ack — see the write there.
   */
  let outputIncomplete = false;
  /**
   * `failOnEpipe` splits the two kinds of stdout this file writes. Plain
   * listings (`fleet status | head -1`) keep the silent tolerance — a hung-up
   * reader is reading nothing more either way, and a read-only query must not
   * look like a substrate failure. COMPLETION lines routed through
   * `reportCompletion` do not: there the line IS the only report of work that
   * already happened, so a lost line is exactly the landed-but-unreportable
   * case that verb's exit 6 posture exists for — the same treatment ENOSPC and
   * EBADF already got. Before round 10 an EPIPE on `torn down:` vanished
   * silently with exit 0 while its siblings reported 6 through the same
   * envelope.
   */
  const emit = (s: string, failOnEpipe = false, truncationRemediation?: string): void => {
    try {
      out(s);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException | null)?.code ?? "";
      if (errno === "EPIPE") {
        if (!failOnEpipe) return;
        throw e;
      }
      if (errno !== "EAGAIN" && errno !== "EWOULDBLOCK") throw e;
      // One line per invocation, not per refused write: a full pipe refuses
      // every row after the first, and the diagnostic must not itself be what
      // floods the operator's stderr.
      if (outputIncomplete) return;
      outputIncomplete = true;
      printError(
        note,
        "stdout-truncated",
        "stdout would not take part of this command's output: what it printed is INCOMPLETE",
        // EAGAIN/EWOULDBLOCK is swallowed here rather than rethrown (see the
        // comment above `outputIncomplete`), so `reportCompletion`'s own catch
        // — where a call site's remediation normally lands — never runs for
        // this errno. Without threading the caller's remediation through here
        // too, fan-out's "these boxes are LIVE and BILLING" guidance would be
        // silently replaced by the generic non-blocking-pipe advice below.
        truncationRemediation ??
          "stdout was left non-blocking by a wrapper or CI runner — re-run with output to a file or a blocking pipe, and do not parse what was printed",
      );
    }
  };
  /**
   * `logVerb`, plus the one thing that can still change an outcome after the
   * verb has decided it: output that did not all arrive. 6, not 1 — the work
   * landed, so a retry cannot undo it or redo it, and only the printing failed.
   * It never touches an already-failing code: what the verb reported is worse
   * news than a short write, and this is the same rule the cleanup `finally`
   * below states for the ledger and the lock.
   */
  const finish = (
    rid: string,
    v: string,
    runId: string | undefined,
    code: number,
    exitStatusOverride?: VerbExitStatus,
    phase?: "complete" | "help",
  ): number =>
    logVerb(rid, v, runId, startedAt, code === 0 && outputIncomplete ? 6 : code, exitStatusOverride, phase);
  /**
   * The dispatch ack's posture over the COMPLETION lines — teardown's
   * `torn down:` and harvest's `harvested:`. Those lines describe work that has
   * already happened: a destroyed box, a closed record, a captured tree. A bare
   * `emit` tolerates EPIPE silently and EAGAIN as `stdout-truncated`, but any
   * other write failure (ENOSPC, EBADF) escaped the verb's try into
   * `report`, which stamps it exit 1 = `transient` = "retry me" — automation
   * re-running a destructive verb that had already landed. So the write failure
   * is caught here, named ONCE on stderr, and reported as false: the caller
   * exits 6, "the work landed but its line did not print", outside the retry
   * range like every other landed-but-unreportable code in this file.
   *
   * EPIPE rides the same path since round 10 (`failOnEpipe`): a completion line
   * lost to a closed pipe is as lost as one lost to ENOSPC — `| head -1` must
   * not turn "the box is destroyed" into a silent success the caller never saw.
   */
  const reportCompletion = (lines: string[], remediation?: string): boolean => {
    try {
      for (const line of lines) emit(line, true, remediation);
      return true;
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      printError(
        note,
        "completion-unwritable",
        `the command completed but its result line could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
        // Teardown's and harvest's lost lines describe work that is FINISHED;
        // fan-out's describe boxes that are live and BILLING, and the ids are
        // gone with the line. That call site passes its own remediation naming
        // the recovery, the way `ack-unwritable` does for a single box.
        remediation ??
          "the work the missing line describes DID happen — confirm with `fleet status`; do not treat the short output as a failure to retry",
      );
      return false;
    }
  };
  // The ONE pre-tokenization reading of argv: `fleet help` names no verb to
  // tokenize against. Anchored to argv[0], so it cannot fire from a stray token
  // inside a destructive invocation the way `argv.includes("--help")` did.
  //
  // Logged like every other invocation (CC-9: "every verb logs one structured
  // line"). Help used to be the exception, which made `fleet teardown <id>
  // --driver real --help` — an operator who meant to destroy a box and did not
  // — the one invocation a dashboard could not see at all.
  // Wire the hardened diagnostics sink for EMBEDDED callers (round 10): the
  // import.meta.main binding below only ever ran for the CLI itself, so a
  // library caller of run() got the module-default sink — plain stdout writes,
  // no best-effort guard. Idempotent and non-invasive: wired only when the
  // installed sink is STILL this module's boot default (a caller that set its
  // own collector keeps it), and skipped under bun test's muting policy so a
  // sink-less suite stays quiet (log.ts's NODE_ENV rule, replicated because it
  // is not exported).
  if (logSink === BOOT_LOG_SINK && !(process.env.NODE_ENV === "test" && !process.env.QDS_LOG_VERBOSE)) {
    setLogSink((entry) => writeBestEffort(2, `${JSON.stringify(entry)}\n`));
  }
  if (argv[0] === "help") {
    // Round 11: this short-circuit was the ONE pre-tokenization path with no
    // grammar check — `fleet help --bogus xyz junk` printed usage and exited 0,
    // reading to a script as a valid invocation, while the sibling spellings
    // (`fleet --help --bogus`) refused. Bare `help` stays the same exit-0 help;
    // anything AFTER it is validated like any other verb's argv: no unknown
    // flags (tokens the tokenizer would refuse anywhere else), and exactly one
    // optional verb positional naming a verb the registry knows.
    //
    // Wrapped so a refusal keeps BOTH halves of every other refusal — the
    // exit-2 envelope AND its own CC-9 line (`verb: "help"`): these throws sit
    // outside the parseArgv try below, and an unwrapped one would have escaped
    // run() entirely as a bare stack, which is exactly the shape this block
    // replaced.
    try {
      const extra = argv.slice(1);
      const badFlag = extra.find((t) => t.startsWith("-"));
      if (badFlag !== undefined) {
        throw usageError(`unknown flag after \`help\`: ${bounded(badFlag)}`, "`fleet help [<verb>]` takes no flags");
      }
      if (extra.length > 1) {
        throw usageError("`help` takes at most one <verb>", "`fleet help [<verb>]`");
      }
      if (extra[0] !== undefined && !listVerbs().some((v) => v.verb === extra[0])) {
        // Same bound as the tokenizer's own unknown-verb refusal (`bounded`
        // before `JSON.stringify`): an unbounded token echoed here would blow
        // the envelope's own output ceiling.
        throw new FleetError(2, "unknown-verb", `no such verb: ${JSON.stringify(bounded(extra[0]))}`, HELP);
      }
    } catch (e) {
      return finish(newRequestId(), "help", undefined, reportCode(note, e));
    }
    // Same write-failure contract as the `--help` path above: a throw out of
    // this emit used to escape run() raw — the envelope discipline held
    // everywhere else in the file but here.
    try {
      emit(`${HELP}\n`, true);
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      printError(
        note,
        "help-unwritable",
        `the usage text could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
        "stdout refused the bytes (disk full, bad fd) — fix the destination and re-run",
      );
      return finish(newRequestId(), "help", undefined, 6);
    }
    return finish(newRequestId(), "help", undefined, 0, undefined, "help");
  }

  let parsed: ParseResult;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    // CC-9: a usage refusal is still a failed invocation. Routing it around
    // logVerb left exit 2 with no correlating line, so log-based dashboards
    // under-counted exactly the failures an operator most needs to see. The
    // verb is the first positional when there is one — that is what the
    // operator meant even when the flags around it were refused.
    //
    // From the TOKENIZER's positionals, not a raw-argv scan: the scan returned
    // the first token without a leading dash, which for `fleet --dir /srv/runs
    // status --verbose` is `/srv/runs` — the value `--dir` consumed. The line
    // then logged `verb: "/srv/runs"`, a filesystem path in the field the
    // dashboards counting these failures are keyed on. Re-tokenized WITHOUT
    // rejectStraySingleDash so this split cannot itself throw (that is the one
    // thing tokenizeArgs refuses on), leaving `(none)` only when argv really
    // names no verb.
    //
    // Wrapped, and bounded. This split is a LOG FIELD on a path that has
    // already decided its exit code: a throw out of it (this tokenizer refuses
    // stray single dashes when asked to, and a shared helper can grow another
    // refusal) would escape `run()` entirely — raw stack, exit 1, no exit-2
    // envelope and no CC-9 line at all. And `fleet $(200KB)` put 200 KB of
    // argv into the field the dashboards key on.
    let attempted = "(none)";
    try {
      attempted = bounded(tokenizeArgs(argv, { valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS }).positionals[0]);
    } catch {
      // The verb name is worth a best effort and nothing more.
    }
    return finish(newRequestId(), attempted, undefined, reportCode(note, e));
  }
  if (parsed.help === true) {
    // Through `emit`'s failure contract — never bare. An ENOSPC/EBADF out of a
    // write here used to escape `run()` (the help paths sit outside every try)
    // as a raw stack with exit 1: the envelope discipline every other path in
    // this file keeps. A help request whose output could not be delivered is
    // still only a help request: envelope on stderr, exit 6 ("could not finish
    // reporting"), CC-9 line either way.
    try {
      emit(`${HELP}\n`, true);
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      printError(
        note,
        "help-unwritable",
        `the usage text could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
        "stdout refused the bytes (disk full, bad fd) — fix the destination and re-run",
      );
      return finish(newRequestId(), bounded(parsed.verb ?? "help"), undefined, 6);
    }
    // `bounded`, and defaulting to the verb the operator effectively invoked:
    // `fleet --help` names none, and an unbounded `fleet $(200KB) --help` would
    // otherwise put all of it in the field the dashboards key on. `phase:
    // "help"` — see logVerb: a help line must not be countable as a completed
    // verb execution.
    return finish(newRequestId(), bounded(parsed.verb ?? "help"), undefined, 0, undefined, "help");
  }
  const { entry, positionals, flags, bools } = parsed;
  const verb = entry.verb;
  const briefPath = flags.get("--brief");
  const dir = flags.get("--dir");
  const storeOpts = { ...(dir === undefined ? {} : { dir }) };

  // F015: `run()` ends where the verbs begin. Everything above is argv parse and
  // sink construction; each verb owns its own function below and is handed the
  // parsed invocation plus the four sinks this scope built (`emit`, `note`,
  // `finish`, `reportCompletion` — plus the raw `out` the dispatch ack writes
  // through deliberately). Nothing else crosses the boundary: the hoisted `let`s
  // the harvest/teardown block used to share with every verb above it now live
  // in `runDestructive`, which is the only thing that reads them.
  const ctx: VerbCtx = {
    deps,
    verb,
    positionals,
    flags,
    bools,
    dir,
    storeOpts,
    briefPath,
    startedAt,
    out,
    emit,
    note,
    finish,
    reportCompletion,
    // A reader over `reportCompletion`'s own truncation flag — see VerbCtx.
    outputIncomplete: () => outputIncomplete,
  };
  if (verb === "dispatch") return runDispatch(ctx);
  if (verb === "submit") return runSubmit(ctx);
  if (verb === "result") return runResult(ctx);
  if (verb === "fanout") return runFanout(ctx);
  if (verb === "rank") return runRank(ctx);
  if (verb === "status") return runStatus(ctx);
  // DF1.10's `run`: its own handler, not `runDestructive`'s fall-through — it
  // takes no run lock and destroys nothing (see runRun).
  if (verb === "run") return runRun(ctx);
  // DF3.7's observe: its own handler too, but for the opposite reason — it
  // takes the run lock ITSELF (inside runObserve, before the pre-flight
  // record read) and drives the teardown-bearing chain from a settled marker.
  if (verb === "observe") return runObserve(ctx);
  // DF3.4's gate verbs: one handler over five registry entries (see runGateVerbs).
  if (GATE_VERBS.has(verb)) return runGateVerbs(ctx);
  return runDestructive(ctx);
}

/**
 * One parsed invocation plus the sinks `run()` built for it (F015).
 *
 * The verb functions below are the six `if (verb === …)` blocks `run()` used to
 * hold inline, moved out unchanged. They share nothing but this: `run()` parses
 * argv, builds the sinks whose failure contracts the whole file's exit table
 * rests on, and hands both to exactly one of them.
 *
 * `out` is here alongside `emit` because dispatch's ack is deliberately NOT
 * written through `emit` — see the write there; it is the only handle on a live,
 * billing box, so it may not ride `emit`'s EPIPE tolerance.
 */
interface VerbCtx {
  deps: Partial<FleetDeps> | undefined;
  verb: string;
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
  dir: string | undefined;
  storeOpts: { dir?: string };
  briefPath: string | undefined;
  startedAt: number;
  out: (s: string) => void;
  emit: (s: string, failOnEpipe?: boolean) => void;
  note: (s: string) => void;
  finish: (
    rid: string,
    v: string,
    runId: string | undefined,
    code: number,
    exitStatusOverride?: VerbExitStatus,
    phase?: "complete" | "help",
  ) => number;
  reportCompletion: (lines: string[], remediation?: string) => boolean;
  /**
   * Whether any stdout write this invocation made was EAGAIN-truncated — the
   * flag `finish` folds into exit 6. Exposed beside `reportCompletion` because
   * that function's `boolean` answers only "did the line's own write SUCCEED":
   * an fd 1 left non-blocking swallows part of the line (after one
   * `stdout-truncated` envelope) WITHOUT throwing, so `reportCompletion`
   * answers true and a caller that trusted it logged the event "ok" beside an
   * exit 6. The gate verbs read this to know the printed contract was violated
   * even when the write itself reported success (round-9 B5). Read-only on
   * purpose: only the emit path that DETECTED the truncation may set it.
   */
  readonly outputIncomplete: () => boolean;
}

/**
 * The two outer `let`s the teardown arm writes and `runDestructive`'s `finally`
 * reads. A return value cannot carry them: the ledger is opened BEFORE
 * `teardownSandbox`, so a throw out of the arm must still leave the `finally`
 * able to close it, and `destructiveInFlight` is precisely the flag that says
 * whether that throw landed mid-destruction.
 */
interface DestructiveState {
  ledger?: CostLedger;
  /** DF5.3: the verb's audit-link store, closed in the finally beside the ledger. */
  audit?: AuditStoreWriter;
  destructiveInFlight: boolean;
}

/** `fleet dispatch` — the one verb that creates billable resources. */
async function runDispatch(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, briefPath, storeOpts, dir, startedAt, out, note, finish } = ctx;
  // Hoisted for the CC-9 log line below: a refusal before the brief parses
  // (no --driver, unreadable brief, bad JSON) has no correlation id yet, and
  // the line must still be emitted. Set to the RESOLVED id the moment there
  // is one, so the CLI's line joins the run's own (INV-4-bis).
  let dispatchRequestId: string | undefined;
  let dispatchRunId: string | undefined;
  let dispatchCode: number;
  /**
   * Dispatch is the ONE verb that creates billable resources, and it holds no
   * run lock because it has no run id until mid-flight. A Ctrl-C between
   * `driver.create()` returning and the record being persisted leaves a box
   * nothing points at, and INV-5 forbids the CLI destroying one it cannot
   * attribute — so the only recovery is the operator being told to look.
   *
   * Scoped to this verb and removed in the `finally`: `run()` is an embeddable
   * function, and a process-wide handler that outlives the call is not ours to
   * leave behind.
   *
   * Installed at the TOP of the verb — before the brief is read, before
   * `--port` is validated, before a driver exists — because the window it
   * covers has to start before anything can provision. That is also why what
   * it SAYS is gated on `mayHaveProvisioned`: `sleep 30 | fleet dispatch`
   * Ctrl-C'd while `readCappedStdin()` is still waiting cannot have created a
   * box, and sending an operator to audit a provider console for one that
   * demonstrably does not exist is how a real warning stops being read.
   */
  let mayHaveProvisioned = false;
  /**
   * The per-run lock taken the moment the mint becomes visible (round 11):
   * held from `store.create` through the key persist and the ack, so a
   * concurrent harvest/teardown cannot acquire it inside the
   * record-persisted/key-unpersisted window and destroy the box mid-mint.
   * Released here, in the verb's finally, and on the signal paths below.
   */
  let dispatchLock: string | undefined;
  const releaseDispatchLock = (): void => {
    if (dispatchLock === undefined) return;
    try {
      releaseRunLock(dispatchLock);
    } catch {
      // A lock we could not drop is reported like any wedged cleanup; inside
      // a signal handler the CC-9 line below still goes out either way.
    }
    dispatchLock = undefined;
  };
  const interruptHandlers = ([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const).map(([sig, status]) => {
    const handler = (): void => {
      if (mayHaveProvisioned) {
        printError(
          note,
          "dispatch-interrupted",
          "interrupted during dispatch: a box may have been provisioned with no run record",
          "check the provider for an unattributed box — INV-5 forbids this CLI destroying one it cannot attribute",
        );
      } else {
        printError(
          note,
          "dispatch-interrupted",
          "interrupted before dispatch began provisioning: nothing was created",
          "re-run when ready — no box, key or record exists for this invocation",
        );
      }
      // CC-9 before the exit, not after: `process.exit` skips the `finally`
      // and the `return finish(...)` below, so an interrupted dispatch was the
      // one invocation of any verb that produced no structured line at all —
      // exactly the invocation an operator most needs to find later. `log`'s
      // sink is best-effort (writeBestEffort), so this cannot itself throw out
      // of a signal handler.
      //
      // The status is 128+signo, deliberately outside the 0-6 table — see the
      // exit-code note at the top of this file. Its log classification rides
      // `exitStatusOverride` ("signalled") rather than the table's fallback:
      // 129/130/143 are neither success nor retryable nor a verdict about the
      // verb at all — see the header's own 130/143 note.
      releaseDispatchLock();
      logVerb(dispatchRequestId ?? newRequestId(), verb, dispatchRunId, startedAt, status, "signalled");
      process.exit(status);
    };
    process.on(sig, handler);
    return [sig, handler] as const;
  });
  try {
    if (positionals.length > 1) {
      throw usageError("dispatch takes no positional arguments", "pass the brief on stdin or via --brief <path>");
    }
    // Refused before the brief is read: a missing --driver must not make the
    // operator pipe a brief in only to be told the invocation was never valid.
    const driverName = flags.get("--driver");
    assertDriverChosen("dispatch", driverName, deps?.driver);
    const portRaw = flags.get("--port");
    const port =
      portRaw === undefined
        ? undefined
        : parseDecimalFlag("--port", portRaw, 1, 65_535, "a TCP port", "--port takes an integer 1-65535");
    // Validated beside --port, before the brief is read: a usage refusal must
    // not make the operator pipe a brief in first. The remediation is
    // dispatch.ts's own timeout-invalid text VERBATIM — the CLI and the module
    // must not paraphrase one constraint two ways (dispatch re-validates and
    // owns the refusal envelope for INJECTED deps either way).
    const timeoutRaw = flags.get("--timeout-ms");
    const timeoutMs =
      timeoutRaw === undefined
        ? undefined
        : parseDecimalFlag(
            "--timeout-ms",
            timeoutRaw,
            1,
            MAX_TIMEOUT_MS,
            "a positive integer of milliseconds",
            `omit timeoutMs for the 600_000 ms default, or pass a positive integer up to ${MAX_TIMEOUT_MS}`,
          );

    // INV-2: the brief is read and parsed — both side-effect free — before
    // anything is constructed. `new RunRecordStore` mkdirs and chmods the
    // records directory, which is a side effect an invalid brief must not
    // cause. (The seam/cap/parse machinery lives in `ingestBriefJson` since
    // `fanout` became the second brief-eating verb.)
    const briefJson = await ingestBriefJson(briefPath, deps);

    // INV-4-bis: the brief owns the correlation id. Minting one here and
    // letting dispatch() resolve a different one from the brief breaks the
    // join key between the CLI's records/driver logs and the run's own.
    const requestId = resolveBriefRequestId(briefJson) ?? newRequestId();
    dispatchRequestId = requestId;
    const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId }));
    // AC1: an invalid brief must exit 2 NAMING THE OFFENDING FIELD, and
    // `openRouterKeyApi()` reads $OPENROUTER_PROVISIONING_KEY at
    // construction. Built unconditionally it fired first, so on a host
    // without that key a malformed brief exited 2 with
    // `provisioning-key-missing` and no field — the operator set the env var
    // and re-hit the very same brief.
    //
    // It cannot simply be deferred to the mint that uses it: the mint runs
    // AFTER provisioning, and INV-5 forbids destroying that box, so a missing
    // env var would leave a billable box alive. So the same schema dispatch
    // is about to apply decides the order — the client is built only for a
    // brief that can reach a mint at all. dispatch() re-validates and owns
    // the refusal envelope either way; this parse only sequences the two.
    //
    // Hoisted ABOVE the store for the same reason, one INV further (AC1/AC4:
    // "validation completes before the first side effect"). The claim three
    // lines up — that the brief is parsed before anything is constructed —
    // only ever covered `JSON.parse`: `{"bogus":1}` is valid JSON, so
    // `fleet dispatch --dir /srv/newdir` exited 2 as promised having already
    // mkdir'd /srv/newdir and every missing parent, and pointed at an
    // EXISTING directory it chmod'd the operator's directory to 0700
    // (run-record.ts's constructor does both, INV-5).
    const briefCanMint = BriefSchema.safeParse(briefJson).success;
    const store =
      deps?.store ??
      (briefCanMint
        ? asUsage(() => new RunRecordStore({ ...storeOpts, requestId }))
        : // Same shape as `unusedKeyApi`, and for the same reason: dispatch()
          // owns the refusal envelope, so it still needs a `store` to hold —
          // it just must not be one whose construction touched the disk.
          unusedStore(resolveRunsDir(dir)));
    const ledgerFactory = deps?.ledgerFactory ?? makeLedgerFactory(store);
    // `readBrief` is the CLI's own seam, fanoutsDir/lockPath are DF3.2's and
    // costLedger is DF2.8's race-loser ledger — dispatch prices its own run
    // through ledgerFactory alone, so a caller-injected hook must not leak
    // through the spread into DispatchDeps. Everything else forwards
    // verbatim, so one seam added there is never silently dropped. The
    // explicit keys below win over the spread.
    const {
      readBrief: _readBrief,
      fanoutsDir: _fanoutsDir,
      lockPath: _lockPath,
      costLedger: _costLedger,
      ...seams
    } = deps ?? {};
    const dispatchDeps: DispatchDeps = {
      ...seams,
      driver,
      keyApi: deps?.keyApi ?? (briefCanMint ? asUsage(() => openRouterKeyApi()) : unusedKeyApi()),
      // The interrupt handlers below log `dispatchRunId`, which the resolved
      // ack used to set too late: a SIGINT after `store.create` persisted the
      // record but before dispatch() returned reported `runId: null` for a
      // run that exists. The store is where the mint becomes visible, so it
      // is observed here (round 10) — and since round 11 it is also where the
      // per-run lock is TAKEN, closing the harvest/teardown race against the
      // key mint: before this, a concurrent `teardown <id>` could acquire
      // between record-persisted and keyHash-persisted, warn
      // key-unattributable, and destroy the box mid-mint. A refusal here
      // must NOT abort the mint — the create has already landed; losing the
      // race is reported and the dispatch carries on.
      store: observingMint(store, (minted) => {
        if (dispatchRunId === undefined) dispatchRunId = minted;
        try {
          if (dispatchLock === undefined) dispatchLock = acquireRunLock(store.dir, minted, "fleet dispatch key-mint");
        } catch (e) {
          const x = (e ?? {}) as { message?: string };
          printError(
            note,
            "key-mint-lock-unavailable",
            `the run lock for ${minted} could not be taken while the key was being minted: ${redactSecrets(x.message ?? e)}`,
            "a concurrent harvest or teardown may be acting on this run id — check `fleet status` before touching either",
          );
        }
      }),
      ledgerFactory,
      requestId,
      ...(port === undefined ? {} : { port }),
      // LAST, like port: the explicit key wins over the `...seams` spread, so
      // argv is the authority whenever the flag is given — an injected
      // `deps.timeoutMs` (FleetDeps inherits the seam) fills the ABSENT-flag
      // case only.
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };

    // Everything an interrupt could NOT have orphaned is now behind us; from
    // here a box may exist, so the handler stops promising it does not.
    mayHaveProvisioned = true;
    const ack = await dispatch(briefJson, dispatchDeps);
    dispatchRunId = ack.runId;
    dispatchCode = 0;
    // NOT through `emit`. Every other write in this CLI describes work that is
    // already done and cannot be undone by telling nobody about it — but this
    // ack's runId is the ONLY handle on a box that is LIVE and BILLING and on
    // the key just minted for it. `fleet dispatch | head -0` closes the pipe
    // before the line lands, and swallowing that reported exit 0 while the box
    // was orphaned. 6, not 1: 1 means "retry me", and retrying dispatch
    // provisions a SECOND box rather than recovering the first.
    //
    // The ack is written RAW, `httpsUrl` included, and that is deliberate:
    // it is this command's OUTPUT, not a log sink. INV-6 governs the sinks —
    // the dispatch log, the structured lines, the refusal envelopes — because
    // those are persisted, shipped and read by people the run was never
    // handed to. The ack goes to the operator who typed the command and asked
    // for a box on `--port`; a redacted URL there is not a security property,
    // it is a box they cannot reach. (`dispatch()` logs the same value through
    // `redact` one line earlier, which is the sink rule doing its job — the
    // two are not in conflict, and INV-6's own docstring in
    // src/fleet/dispatch.ts should say which of the two it governs.)
    try {
      out(`${JSON.stringify(ack)}\n`);
    } catch (e) {
      // `(e ?? {})`: a sink may reject with null/undefined (a bare `throw;`,
      // a violated library contract), and reading `.message` off it would
      // make the failure REPORTER the failure — over a live, billing box.
      // `?? e`, not `?? String(e)`: `redactSecrets` coerces anything without
      // throwing, and `String` on a null-prototype throw does not. ONE idiom
      // across every catch in this file (F018) — `errText`'s `String(e)` was
      // the second one, and it threw on exactly the values this guards.
      const x = (e ?? {}) as { message?: string };
      printError(
        note,
        "ack-unwritable",
        `the box for ${ack.runId} is live but its ack could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
        `record run id ${ack.runId} now — \`fleet teardown ${ack.runId}\` is the only thing that stops it billing`,
        { runId: ack.runId },
      );
      dispatchCode = 6;
    }
  } catch (e) {
    // resolveDriver, RunRecordStore and openRouterKeyApi are each built
    // inside the try and inside `asUsage`: that is what keeps their own
    // message and remediation in the envelope, classified as the permanent
    // operator errors they are instead of a retryable exit 1.
    dispatchRunId = runIdFromError(e);
    dispatchCode = reportCode(note, e);
  } finally {
    // The per-run lock taken at the mint (round 11) rides the same finally:
    // released here on every non-signal path, after the ack write above has
    // had its say — a later teardown is safe exactly when this invocation's
    // record/key work is over. Signal paths release through the handler.
    releaseDispatchLock();
    // The ledger this factory builds is NOT closed here: `dispatch()` owns it
    // and closes it in its own `finally`, logging (deliberately not refusing
    // on) a failed flush. A second close would be an unconditional throw.
    for (const [sig, handler] of interruptHandlers) process.removeListener(sig, handler);
  }
  // CC-9: dispatch is a verb like any other, so it logs its one line on BOTH
  // exits. `dispatch()` emits its own resolved/ready/refused lines — those are
  // the run's; this is the invocation's, and the other three verbs would be
  // the only ones with it otherwise. A refusal that fired before the brief
  // resolved has no correlation id to report, so one is minted for the
  // invocation rather than a run's id forged for it.
  return finish(dispatchRequestId ?? newRequestId(), verb, dispatchRunId, dispatchCode);
}

/**
 * `fleet submit` (Q1.1) — the DAG-facing single call: dispatch → engine start
 * behind ONE replay-safe entry point. The idempotency machinery (the O_EXCL
 * intent claim, the mint observation, the replay answer) lives in
 * src/fleet/submit.ts; this verb is the argv surface over it, composed the way
 * runDispatch composes its own — driver, store, key client, ledger factory —
 * with the SAME posture toward construction: nothing is built before the
 * invocation-shaped inputs (flags, brief) have validated.
 *
 * Deliberately NOT runDispatch's interrupt-handler apparatus: submit's
 * recovery path is the REPLAY (the same --request-id re-invoked), not a
 * signal-handler warning, and the ack's raw-write posture below is where the
 * live-box contract lives. The per-run lock runDispatch takes at the mint is
 * likewise absent — a submit's race window is closed by the intent record the
 * same instant the run becomes visible; the harvest/teardown lock ceremony is
 * a dispatch-verb concern until a caller shows the race is reachable here.
 */
async function runSubmit(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, briefPath, storeOpts, dir, out, note, finish } = ctx;
  let submitRequestId: string | undefined;
  let submitRunId: string | undefined;
  let code: number;
  try {
    if (positionals.length > 1) {
      throw usageError("submit takes no positional arguments", "pass the brief on stdin or via --brief <path>");
    }
    const driverName = flags.get("--driver");
    assertDriverChosen("submit", driverName, deps?.driver);
    // Required, and it is the whole verb's point: without it nothing is
    // idempotent. Refused BEFORE the brief is read — a missing --request-id
    // must not make the operator pipe a brief in only to be refused.
    const requestId = flags.get("--request-id");
    if (requestId === undefined || requestId.trim() === "") {
      throw usageError("submit takes --request-id <uuid-v4>", "pass the DAG node's request id — it is the replay key");
    }
    // Shape-checked HERE, before the brief is read — the same rule as --port's
    // placement on dispatch: a usage refusal must not make the operator pipe a
    // brief in only to be refused. (submitWork re-checks; this is the early
    // guard that keeps the refusal off a read the invocation never deserved.)
    if (!isValidUuidV4(requestId)) {
      throw usageError(
        `--request-id ${bounded(requestId)} is not a strict UUID v4`,
        "pass the DAG node's request id as a UUID v4 — it is the idempotency key every replay keys on",
      );
    }
    submitRequestId = requestId;
    const budgetGroup = flags.get("--budget-group");
    const groupCapRaw = flags.get("--group-cap");
    const groupCapMicroUsd =
      groupCapRaw === undefined
        ? undefined
        : parseDecimalFlag(
            "--group-cap",
            groupCapRaw,
            1,
            Number.MAX_SAFE_INTEGER,
            "a positive integer of micro-dollars",
            "--group-cap takes the group's USD ceiling in micro-dollars (e.g. 2900000 for $2.90)",
          );
    // The pairing refusal BEFORE the brief is read, like every other usage
    // refusal on this verb.
    if ((budgetGroup === undefined) !== (groupCapMicroUsd === undefined)) {
      throw usageError(
        "--budget-group and --group-cap stand or fall together — one arrived without the other",
        "pass both flags for a budget-group run, or neither",
      );
    }
    const portRaw = flags.get("--port");
    const port =
      portRaw === undefined
        ? undefined
        : parseDecimalFlag("--port", portRaw, 1, 65_535, "a TCP port", "--port takes an integer 1-65535");
    const timeoutRaw = flags.get("--timeout-ms");
    const timeoutMs =
      timeoutRaw === undefined
        ? undefined
        : parseDecimalFlag(
            "--timeout-ms",
            timeoutRaw,
            1,
            MAX_TIMEOUT_MS,
            "a positive integer of milliseconds",
            `omit for the 600_000 ms default, or pass a positive integer up to ${MAX_TIMEOUT_MS}`,
          );

    const briefJson = await ingestBriefJson(briefPath, deps);
    // INV-4-bis: the submit's requestId IS the correlation id — the record,
    // the driver's log lines and the ack all carry it (dispatch re-validates
    // the shape; submit's core refuses before anything is claimed).
    const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId }));
    const briefCanMint = BriefSchema.safeParse(briefJson).success;
    const store =
      deps?.store ??
      (briefCanMint
        ? asUsage(() => new RunRecordStore({ ...storeOpts, requestId }))
        : unusedStore(resolveRunsDir(dir)));
    const ledgerFactory = deps?.ledgerFactory ?? makeLedgerFactory(store);
    const { readBrief: _rb, fanoutsDir: _fd, lockPath: _lp, costLedger: _cl, ...seams } = deps ?? {};

    // The engine seam: the real unit start, exactly what `fleet run` drives.
    // Its failure is not a throw — the ack says `provisioned` and the verb
    // maps the exit below (1 = retryable unreachable, 5 = the run's own
    // refusal shapes).
    const startEngine = deps?.startEngine ?? (async (runId: string) =>
      startRun({ driver: driver as StartRunDriver, store: deps?.store ?? store }, runId));

    // SEQUENCING ONLY — submitWork's own intent read below is the authoritative
    // refusal. An IN-FLIGHT intent refuses inside submitWork BEFORE any mint, so
    // building the key client eagerly would mask that bookkeeping refusal with a
    // provisioning-key-missing usage error on a keyless host — the same shape the
    // dispatch-side brief-parse-before-construction ordering above already fixed
    // for malformed briefs. `asUsage` is eager: the build runs at THIS statement,
    // before submitWork can answer anything. Conservative: only the in-flight
    // shape skips construction — every other path (corrupt intent, failed intent,
    // fresh submit) still builds exactly as before, and submitWork re-derives and
    // refuses on its own read regardless of what this peek saw.
    const intentInFlight = (() => {
      try {
        const intentPath = resolvePath(store.dir, SUBMITS_DIRNAME, `${requestId}.json`);
        return (JSON.parse(readFileSync(intentPath, "utf-8")) as { state?: string }).state === "in-flight";
      } catch {
        return false;
      }
    })();
    const ack = await submitWork({
      ...seams,
      brief: briefJson,
      requestId,
      driver,
      keyApi: deps?.keyApi ?? (briefCanMint && !intentInFlight ? asUsage(() => openRouterKeyApi()) : unusedKeyApi()),
      store,
      ledgerFactory,
      startEngine,
      ...(budgetGroup !== undefined ? { budgetGroup } : {}),
      ...(groupCapMicroUsd !== undefined ? { groupCapMicroUsd } : {}),
      ...(port === undefined ? {} : { port }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    submitRunId = ack.runId;
    // Raw `out`, not `emit` — the same posture as dispatch's ack: the runId is
    // the handle on a live box. On the replay path the box may be long gone,
    // but the line is still the only report of the answer, so a lost line is
    // exit 6 ("landed but unreportable"), and the recovery is the replay
    // itself — which is exactly why 6 is not 1 here.
    try {
      out(`${JSON.stringify(ack)}\n`);
      // running = the engine start landed (or the replay corroborated it);
      // provisioned = the box is ready and the engine did not start — on a
      // FIRST submit that is the retryable engine-start failure (exit 1); on
      // a replay of an intent whose engine was never requested it is the
      // delivered state (exit 0).
      code = ack.state === "running" || (ack.replayed && ack.state === "provisioned") ? 0 : 1;
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      printError(
        note,
        "ack-unwritable",
        `the run for ${ack.runId} is live but its ack could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
        `record run id ${ack.runId} now — re-submitting --request-id ${requestId} replays the same run without provisioning again`,
        { runId: ack.runId },
      );
      code = 6;
    }
  } catch (e) {
    code = reportCode(note, e);
  }
  return finish(submitRequestId ?? newRequestId(), verb, submitRunId, code);
}

/**
 * `fleet result` (Q1.3) — the poller-facing completion payload. ONE record
 * read, ONE JSON line: no driver, no box, no lock (the same posture as
 * `rank`). The payload carries `terminal`; exit 0 means "the record was found
 * and the payload printed", running or not — a poller branches on the field,
 * never on the exit code.
 */
async function runResult(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, storeOpts, out, note, finish } = ctx;
  let code: number;
  try {
    if (positionals.length !== 2) {
      throw usageError("result takes exactly one <run-id> positional", "fleet result <run-id> --json");
    }
    const store = deps?.store ?? asUsage(() => new RunRecordStore(storeOpts));
    const payload = buildResult(store, positionals[1] as string);
    try {
      out(`${JSON.stringify(payload)}\n`);
      code = 0;
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      printError(
        note,
        "payload-unwritable",
        `the payload for ${payload.runId} was computed but could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
        "stdout refused the bytes — re-run; the payload is a pure read and the poll loses nothing",
      );
      code = 6;
    }
  } catch (e) {
    code = reportCode(note, e);
  }
  return finish(newRequestId(), verb, undefined, code);
}

/** `fleet fanout` (DF3.2 D12) — N isolated dispatch arms as one pattern. */
async function runFanout(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, briefPath, dir, note, finish, reportCompletion, outputIncomplete } = ctx;
  // Hoisted like dispatch's id: a refusal before the brief resolves has no
  // correlation id yet, and the CC-9 line must still be emitted.
  let fanRequestId: string | undefined;
  let fanoutId: string | undefined;
  // Initialized to the failure side so the cleanup `finally` below may read
  // it: both the try and the catch assign before returning, so the default
  // is unreachable unless `report` itself throws — and then 1 ("substrate
  // failed") is the honest thing to die with.
  let fanoutCode = 1;
  // C10: set by the inner `finally` when the audit handle would not release.
  // Escalated in the OUTER finally, not inline: the inner one runs before the
  // arm outcomes assign `fanoutCode`, which would overwrite it.
  let auditCloseFailed = false;
  /** Set by the emit seam when a link arrives from a pattern that opens no store. */
  let auditMisordered = false;
  // The error's own retry classification, when it carries one — read in the
  // catch, honored on the completion line below (logVerb derives from exit
  // code alone, and 5 alone would read as do-not-retry "logic").
  let transientRefusal = false;
  // Race losers' teardown prices box hours through THIS handle (DF2.8);
  // closed in the finally like teardown's own ledger. Built LAZILY below —
  // just before fanout(), once the records store exists — because the real
  // CostLedger creates its SQLite db file in its constructor, and an eager
  // build left a money file behind on every pre-admission refusal
  // (fleet-busy, no-headroom): INV-2's "a refused fan-out mutates nothing".
  let loserLedger: (CostLedgerHook & { close(): void }) | undefined;
  try {
    if (positionals.length > 1) {
      throw usageError(
        "fanout takes no positional arguments",
        "pass flags only — the brief rides stdin or --brief <path>",
      );
    }
    const driverName = flags.get("--driver");
    assertDriverChosen("fanout", driverName, deps?.driver);
    // The pattern decides how the brief payload is SHAPED (many-stories wraps
    // its briefs), so it is read first. Its VALIDITY stays with fanout()'s own
    // validation — this only routes the parse; a typo'd or absent pattern
    // flows through the single-object path and is refused exit-2 there.
    const pattern = flags.get("--pattern");
    // Flag-level width gate FIRST, pattern-blind exactly as it has always
    // been: a malformed/out-of-range --n must refuse with ITS message even
    // when --pattern is missing or garbled (the declared-exit-codes probe in
    // verbs.test.ts pins this precedence). Pattern-scoped structure follows.
    const nRaw = flags.get("--n");
    const n = parseDecimalFlag(
      "--n",
      nRaw,
      1,
      FANOUT_MAX_N,
      "a fan-out width",
      `--n takes an integer 1-${FANOUT_MAX_N} (best-of-n/race need two arms to compare)`,
    );
    // C1 + INV-CAP-1 (DF2.14): the per-arm cap's ceiling is the BACKSTOP, not a
    // free-floating $1M domain figure. The old 1e12 bound advertised values
    // 20,000× the enforced ceiling: `--cap-micro-usd 100000000 --n 3` passed
    // this parse, passed F15's reconciliation, reserved 3 × $100 of admission
    // headroom, provisioned three BILLABLE boxes, and then died at the mint's
    // INV-CAP-1 `cap-invalid` on every arm — real money for work that could
    // never start. The bound is DERIVED from the same exported constant
    // `mintRunKey` enforces — never a numeric copy — so raising the backstop is
    // one edit plus its test (the drift alarm in tests/fleet/cli.test.ts
    // asserts refusal at exactly defaultKeyCapMicroUsd + 1, so a number edited
    // on either side moves the boundary instead of silently forking it).
    const capRaw = flags.get("--cap-micro-usd");
    const capMicroUsd =
      capRaw === undefined
        ? undefined
        : parseDecimalFlag(
            "--cap-micro-usd",
            capRaw,
            1,
            defaultKeyCapMicroUsd,
            "a micro-dollar amount",
            `--cap-micro-usd takes a positive integer of micro-dollars (1-${defaultKeyCapMicroUsd}, where $1 is 1000000) — a cap above the backstop defaultKeyCapMicroUsd is rejected HERE, at argument parsing, before fanout() runs anything (INV-CAP-1's own mint-time guard is the caller-agnostic backstop, not this refusal); lower it, or raise defaultKeyCapMicroUsd in src/providers/credentials.ts — a code change that owes a test naming it`,
          );

    // INV-2 / validation-before-construction: fanout()'s cheap structural
    // Brief ingestion comes next: reading + JSON-parsing the brief has always
    // preceded the pattern/roster semantics (the declared-exit-codes probe
    // feeds "{not json" and expects THAT refusal), and it mutates nothing —
    // so it stays ahead of the structural hoist below without touching INV-2.
    const briefJson = await ingestBriefJson(briefPath, deps);
    // Structural refusals are mirrored HERE, before the keyApi / store /
    // loser-ledger constructors, so structurally-invalid input never builds
    // a handle (let alone touches disk). The primitive keeps its own checks
    // untouched — this is the library boundary staying put while the CLI
    // refuses earlier. An absent/garbled PATTERN is refused here too — same
    // message fanout() would give, just before any constructor runs.
    const rawRosterValue = flags.get("--roster");
    const rosterIds = rawRosterValue
      ?.split(",")
      .map((s) => s.trim());
    // r7-S3a: Fail-closed for empty roster segments. `--roster "a,,b"` has
    // empty segments; flag PRESENT with ANY empty entry ⇒ refusal. This guard
    // SUBSUMES the "explicit empty roster" case it used to be followed by
    // (round-3 A19): `--roster ","` splits to two empty entries and is refused
    // HERE, `--roster ""` cannot even reach the verb (parseValueFlags refuses
    // an empty value for every value flag), and with no empty entry possible
    // the split always yields at least one non-empty id — so a
    // "provided but empty" state is unconstructible and the guard + the
    // `filter(s !== "")` that trailed it were dead code documenting a property
    // the code did not have. Every input they answered for still refuses, with
    // the S3a message (which is what the suite pins).
    if (rosterIds?.some((s) => s === "")) {
      throw usageError(
        "--roster contains an empty entry",
        "every comma-separated entry must be non-empty",
      );
    }
    // r7-S3b: Fail-closed for duplicate roster ids. Duplicates silently
    // degrade the experiment by provisioning identical-model arms.
    const seen = new Set<string>();
    for (const id of rosterIds ?? []) {
      if (seen.has(id)) {
        throw usageError(
          `--roster contains duplicate entry ${JSON.stringify(id)}`,
          "each roster entry must be unique",
        );
      }
      seen.add(id);
    }
    // Pattern-scoped structure, still pre-construction: a KNOWN pattern gets
    // its min-N refusals here; anything else takes the unknown-pattern
    // refusal — the same message fanout() would print, just earlier. The
    // many-stories roster FORBIDDEN check deliberately precedes this guard:
    // `many-stories --roster …` must refuse on the roster even when the brief
    // is not yet wrapper-valid (cli.test.ts pins both orderings).
    if (pattern === "many-stories" && rosterIds !== undefined) {
      throw usageError(
        "--roster is not valid for many-stories",
        "drop --roster; per-arm variation comes from the distinct briefs",
      );
    }
    if (pattern === "best-of-n" || pattern === "many-stories" || pattern === "race") {
      const minN = pattern === "many-stories" ? 1 : 2;
      if (n < minN) {
        // `bounded` on BOTH echoes: they repeat argv, and argv is unbounded
        // (the same invariant `parseDecimalFlag` states for its own refusal).
        throw usageError(
          `--n ${JSON.stringify(bounded(nRaw))} is not a fan-out width`,
          `--n takes an integer ${minN}-${FANOUT_MAX_N}${minN === 2 ? " (best-of-n/race need two arms to compare)" : ""}`,
        );
      }
    } else {
      // `bounded(String(pattern))`, not `JSON.stringify(bounded(pattern))`:
      // the quote-free shape the existing refusals (and their pins) use, with
      // the cap added — an undefined pattern still reads "undefined".
      throw usageError(
        `unknown pattern: ${bounded(String(pattern))}`,
        "pattern is one of best-of-n, many-stories, race",
      );
    }
    // Roster shape, same hoisting: required and exactly --n wide for
    // best-of-n/race (many-stories' forbidden case already refused above).
    if (pattern !== "many-stories") {
      if (rosterIds === undefined) {
        throw usageError(
          `${pattern} requires a roster list (one entry per arm)`,
          "pass the roster entries and rerun",
        );
      }
      if (rosterIds.length !== n) {
        throw usageError(`${pattern} got ${rosterIds.length} roster entries for n=${n}`, "the roster count must equal --n");
      }
    }

    // many-stories carries its N briefs as { "briefs": [ … ] }; every other
    // pattern takes exactly ONE object (fanout() refuses an array for them).
    let briefs: unknown;
    let requestIdSource: unknown;
    if (pattern === "many-stories") {
      const wrapped = (briefJson as { briefs?: unknown } | null)?.briefs;
      if (!Array.isArray(wrapped)) {
        throw new FleetError(
          2,
          "invalid-brief",
          'many-stories needs { "briefs": [ … ] }',
          "wrap the n brief objects in a briefs array",
        );
      }
      briefs = wrapped;
      requestIdSource = undefined;
    } else {
      briefs = briefJson;
      requestIdSource = briefJson;
    }
    // INV-4-bis: the brief owns the correlation id where one exists (the
    // single-brief patterns); many-stories' distinct briefs share none, so the
    // invocation mints the ONE id CC-9 joins all arms and the record under.
    fanRequestId = resolveBriefRequestId(requestIdSource) ?? newRequestId();

    // The pin is the control variable — checked BEFORE anything is
    // constructed, so a mismatch exits 2 having mutated nothing. It runs
    // after the known-pattern guard above: a garbage --pattern is an
    // unknown-pattern refusal, never a pin verdict over a typo'd value.
    const schemaList: unknown[] = Array.isArray(briefs) ? briefs : [briefs];
    assertFanoutPin(pattern as FanoutPattern, schemaList, flags.get("--pin"));

    // Validation-before-construction, dispatch's exact posture: these
    // constructors mkdir/chmod, so an invalid brief must refuse without them.
    // F049: `--dir` is NOT this store's dir. `--fanouts-dir` is the fan-outs
    // directory's own flag; `--dir` still names it on fanout and rank for one
    // release (deprecated on stderr below) because it has always meant the
    // fan-outs directory on these two verbs, so no working invocation breaks
    // silently. A fan-*.json inside a runs dir would make every later sweep of
    // that dir report malformed_record_name anomalies. The run records follow
    // their own default/env chain. An injected seam wins over both flags — and
    // silences the warning, so the test seam never prints a deprecation it did
    // not use. Warned BEFORE the constructors, matching rank.
    const fanoutsDirFlag = flags.get("--fanouts-dir");
    if (deps?.fanoutsDir === undefined && fanoutsDirFlag === undefined && dir !== undefined) {
      warnDirDeprecated(note, verb);
    }
    const briefsOk = schemaList.every((b) => BriefSchema.safeParse(b).success);
    const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId: fanRequestId }));
    const keyApi = deps?.keyApi ?? (briefsOk ? asUsage(() => openRouterKeyApi()) : unusedKeyApi());
    const store =
      deps?.store ??
      (briefsOk
        ? asUsage(() => new RunRecordStore({ requestId: fanRequestId }))
        : unusedStore(resolveRunsDir()));

    // `readBrief` is the CLI's own seam and fanoutsDir/lockPath are re-homed
    // below; everything else forwards verbatim into FanoutDeps.
    const {
      readBrief: _readBrief,
      fanoutsDir: injectedFanoutsDir,
      lockPath: injectedLockPath,
      costLedger: injectedCostLedger,
      ...seams
    } = deps ?? {};
    const fanoutsFlagDir = injectedFanoutsDir ?? fanoutsDirFlag ?? dir;
    // The hook defers FURTHER than its own construction: the real CostLedger
    // opens on the FIRST ingestBoxHours, and only a LOSER'S teardown close
    // step can call that — strictly past admission — so even a headroom-
    // refused race that got this far touches no money file. close() before
    // any use is a no-op. Race-only wiring: no other pattern disposes arms
    // through teardownSandbox; an injected seam (tests/embedders) wins.
    if (pattern === "race" && injectedCostLedger === undefined) {
      loserLedger = makeLoserLedgerHook(() =>
        asUsage(
          () =>
            new CostLedger({
              ...costLedgerOpts(store.dir),
              readRunRecord: (id: string) => {
                try {
                  return costRecordProjection(store.get(id));
                } catch (e) {
                  if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
                  throw e;
                }
              },
            }),
        ),
      );
    }
    // DF5.3: a race's loser disposal tears down through teardownSandbox, whose
    // `teardown` link flows through this seam — the fanout verb is the root,
    // so the store opens here and closes on every exit of the call.
    //
    // Race-only wiring, exactly like the loser ledger above: `disposeLosers` is
    // the ONLY caller of this seam (fanout-primitive.ts, guarded by
    // `input.pattern === "race"`), so a parallel/sequential fan-out would
    // otherwise materialise audit.db (+ -wal/-shm) and emit nothing. Kept EAGER
    // for a race rather than deferred to the first link: this open precedes
    // admission and provisioning, so an unopenable store refuses before N boxes
    // are live and billing — the fail-closed property `observe` has nothing to
    // gain from and this verb does.
    //
    // CLASSIFIED (C-1/C10), like every other refusal this CLI reports: the raw
    // open threw an fs errno that `report`'s untyped branch printed as
    // `code: "EACCES"` with advice that never named `QDS_AUDIT_DB`.
    let fanoutAudit: AuditStoreWriter | undefined;
    if (pattern === "race") {
      try {
        fanoutAudit = openAuditStore();
      } catch (e) {
        throw auditStoreUnavailable(
          e,
          "the race's loser-disposal links could not be written, so no box was provisioned",
        );
      }
    }
    let result: Awaited<ReturnType<typeof fanout>>;
    try {
      result = await fanout(pattern as FanoutPattern, n, briefs as Brief | Brief[], {
        ...seams,
        driver,
        keyApi,
        store,
        ledgerFactory: deps?.ledgerFactory ?? makeLedgerFactory(store),
        requestId: fanRequestId,
        ...(injectedCostLedger === undefined ? {} : { costLedger: injectedCostLedger }),
        ...(loserLedger === undefined ? {} : { costLedger: loserLedger }),
        ...(fanoutsFlagDir === undefined ? {} : { fanoutsDir: fanoutsFlagDir }),
        ...(injectedLockPath === undefined ? {} : { lockPath: injectedLockPath }),
        ...(rosterIds === undefined ? {} : { rosterIds: rosterIds }),
        ...(capMicroUsd === undefined ? {} : { capMicroUsd }),
        recordAuditLink: (link: ProviderAuditLink): void => {
          // Not optional-chained: an emit on a non-race pattern is a
          // MIS-ORDERED emit (only `disposeLosers` reaches this seam), and the
          // story sanctions exactly one silent no-op link sink — this is not
          // it. Loud beats a dropped link.
          //
          // Loud, but not paid for with live infrastructure. This seam is
          // called from inside `emitAuditLink`, which PROPAGATES by design
          // (driver.ts), so a throw here aborted the loser disposal it was
          // raised in — an ordering bug settled by leaving N losers alive and
          // BILLING. Record it, let the disposal finish, and fail the exit code
          // afterwards: the same shape the close-failure flags already use.
          if (fanoutAudit === undefined) {
            auditMisordered = true;
            printError(
              note,
              "audit-link-misordered",
              `audit link ${link.hop}/${link.event} was emitted by a ${pattern} fan-out, which opens no audit store — this is a fan-out ordering bug, and the link was dropped`,
              "file it against the emit site: `disposeLosers` is the only sanctioned caller of this seam and it runs only for a race — the fan-out's own arms are unaffected",
            );
            return;
          }
          fanoutAudit.record(link);
        },
      });
    } finally {
      // Every link is already committed, so a close fault is bookkeeping, not a
      // verb to retry — but C10 still routes it into the exit decision (the
      // escalation lands in the outer `finally`, which runs after the arm
      // outcomes set `fanoutCode`, so it can never be overwritten by them).
      try {
        fanoutAudit?.close();
      } catch (e) {
        auditCloseFailed = true;
        const x = (e ?? {}) as { message?: string };
        printError(
          note,
          "audit-store-close-failed",
          `could not close the audit-link store: ${redactSecrets(x.message ?? e)}`,
          "the handle dies with the process; re-run to confirm it still reads",
        );
      }
    }
    fanoutId = result.fanoutId;

    // One JSON line PER ARM — the status-row idiom: stdout is what a caller
    // parses, diagnostics ride stderr.
    //
    // F019: through `reportCompletion`, not a bare `emit`. Each line carries
    // the runId of a box that is LIVE and BILLING, and this is the only place
    // that id is ever printed — `fleet fanout … | head -1` closed the pipe and
    // dropped up to seven of them while still exiting 0. Same posture as the
    // dispatch ack and teardown's `torn down:`: the work landed, its report
    // did not, so 6 — and NOT 1, because retrying provisions N more boxes.
    const armLinesPrinted = reportCompletion(
      result.arms.map(
        (arm) =>
          `${JSON.stringify({
            fanoutId: result.fanoutId,
            arm: arm.arm,
            runId: arm.runId,
            outcome: arm.outcome,
            ...(arm.vmName === undefined ? {} : { vmName: arm.vmName }),
          })}\n`,
      ),
      `the run ids in the missing lines belong to boxes that are LIVE and BILLING — \`fleet status\` lists them and \`fleet teardown <id>\` is the only thing that stops each one; fan-out ${result.fanoutId} names the set`,
    );
    // Auto-rank (AC7/D12): best-of-n's whole point, emitted when EVERY arm is
    // ready. Advisory — it authorizes nothing, so it carries its OWN catch:
    // a failure here (record unreadable, store construction refused) must
    // never reach this verb's shared catch, which would flip N provisioned,
    // ready boxes into a reported refusal. It degrades to a stderr warning
    // and leaves fanoutCode derived from the ARM outcomes below alone.
    // This verb has no step-output source (`--steps-json` is rank's flag), so
    // arms list unscored with an explanatory rationale;
    // `fleet rank <id> --steps-json …` scores them afterwards.
    // Whether the advisory ranking line printed. Undefined when auto-rank did
    // not run (or failed outright, which its own catch reports): only a run
    // that PRODUCED the line can lose it.
    let rankedPrinted: boolean | undefined;
    if (pattern === "best-of-n" && result.arms.every((a) => a.outcome === "ready")) {
      try {
        const fstore = new FanoutRecordStore({ dir: resolveFanoutsDir(fanoutsFlagDir), requestId: fanRequestId });
        const ranked = await rank(result.fanoutId, {
          recordReader: (id) => readFanoutForRank(fstore, id),
          recordWriter: (id, mutator) => fstore.mutate(id, (rec) => mutator(rec) as FanoutRecord),
          stepOutputFor: () => null,
        });
        // Through `reportCompletion`, not a bare `emit` (round-3 A21): the arm
        // lines two hunk up are protected against a closed/non-blocking stdout
        // and this line was not — `fleet fanout … | head -1` dropped it
        // silently with exit 0. It is advisory and `fleet rank` reproduces it,
        // so it does not get the arm lines' "LIVE and BILLING" remediation —
        // but the loss is named, and folded into the exit code below on an
        // otherwise-clean run, the same rule `finish` applies everywhere else.
        rankedPrinted =
          reportCompletion(
            [`${JSON.stringify(ranked)}\n`],
            `the ranking is advisory and reproducible — \`fleet rank ${result.fanoutId} [--steps-json <path>]\` prints it again`,
          ) && !outputIncomplete();
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        printError(
          note,
          "auto-rank-failed",
          `the advisory ranking failed (${redactSecrets(x.message ?? e)}) — the fan-out itself succeeded`,
          `\`fleet rank ${result.fanoutId} [--steps-json <path>]\` ranks it after the fact`,
          { fanoutId: result.fanoutId },
        );
      }
    }
    // Exit 1 collects any arm that did not succeed-or-legitimately-lose:
    // setupFailed/armFailed/armUnknown are collected failures. lostRace alone
    // is NOT one — it is race's EXPECTED loser disposition, and a race that
    // produced its winner worked; reporting 1 there would make automation
    // alert on every successful race.
    fanoutCode = result.arms.some(
      (a) => a.outcome === "setupFailed" || a.outcome === "armFailed" || a.outcome === "armUnknown",
    )
      ? 1
      : 0;
    // Never over an already-failing code: an arm failure is worse news than a
    // lost line, the same rule the cleanup `finally` below states.
    if (fanoutCode === 0 && !armLinesPrinted) fanoutCode = 6;
    // The advisory ranking line, same rule and same floor (A21): the fan-out
    // landed, its ranking did not print, and `fleet rank` can reproduce it —
    // so it never overrides an arm failure, only an otherwise-clean 0.
    if (fanoutCode === 0 && rankedPrinted === false) fanoutCode = 6;
  } catch (e) {
    fanoutCode = reportCode(note, e);
    // FleetError declares no `exitStatus` FIELD, but fanout-primitive's
    // `invalid()` ATTACHES one dynamically (`Object.assign(err, { exitStatus:
    // "transient" })`) for the refusals that are the substrate failing to
    // answer (list-unverified) — the cast here is the only way to read it, and
    // round-3 A17 misread it as dead code. Kept verbatim.
    transientRefusal = e instanceof FleetError && (e as { exitStatus?: unknown }).exitStatus === "transient";
  } finally {
    // The ledger owns a SQLite handle; the arms' budget admissions closed
    // THEIR ledgers, and this one closes with the verb like teardown's does.
    // ONE cleanup-failure policy with that finally (and harvest's): guarded,
    // reported on stderr — and on an otherwise-successful path the failure IS
    // the error, downgraded to 6 ("landed, but not cleanly closable") without
    // ever overwriting an arm failure already collected. A throw here must
    // neither escape as an unhandled rejection after the return below nor
    // turn N priced losers into a silent clean exit.
    if (loserLedger !== undefined) {
      try {
        loserLedger.close();
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        printError(
          note,
          "ledger-close-failed",
          `could not close the loser cost ledger: ${redactSecrets(x.message ?? e)}`,
          "the handle dies with the process; re-run to confirm it still reads",
        );
        // C5: Exit code escalation only when fanoutCode === 0 (the log is always emitted).
        if (fanoutCode === 0) fanoutCode = 6;
      }
    }
    // Same rule for the audit handle the inner finally already reported, and
    // for a dropped (mis-ordered) link: never over an arm failure, only over an
    // otherwise-clean 0. The fan-out's arms landed; its evidence did not.
    if (fanoutCode === 0 && (auditCloseFailed || auditMisordered)) fanoutCode = 6;
  }
  return finish(
    fanRequestId ?? newRequestId(),
    verb,
    fanoutId,
    fanoutCode,
    transientRefusal ? "transient" : undefined,
  );
}

/** `fleet rank` (DF3.2 D12/C2) — advisory scoring of a completed fan-out. */
async function runRank(ctx: VerbCtx): Promise<number> {
  const { verb, positionals, flags, dir, emit, note, finish } = ctx;
  const requestId = newRequestId();
  try {
    if (positionals.length !== 2) {
      throw usageError("rank requires exactly one <fanout-id>", "fleet rank <fanout-id> [--steps-json <path>]");
    }
    const fanoutId = positionals[1] as string;
    // Grammar BEFORE any store construction: a malformed id must not mkdir the
    // very directory it is about to be refused for.
    if (!FANOUT_ID_RE.test(fanoutId)) {
      throw usageError(
        `${JSON.stringify(fanoutId.slice(0, MAX_ECHO))} is not a fan-out id`,
        "fan-out ids look like fan-YYYYMMDD-<6hex>; `fleet fanout` prints them",
      );
    }
    // NO assertDriverChosen here BY DESIGN (the registry gives rank no
    // --driver): rank reads fan-out records and step output, never a box, so
    // the B8 fake-driver hazard cannot arise.
    //
    // Step outputs (ruling C2): --steps-json maps runId → step output; absent
    // ⇒ the accessor nulls EVERY arm, which rank lists score:null — advisory
    // rank stays structurally useful rather than erroring. Parsed BEFORE any
    // store is constructed — the id grammar's principle, one flag further: a
    // malformed --steps-json must refuse without mkdir/chmod'ing the very
    // directory it is being refused over.
    const byRun = new Map<string, ArmStepOutput>();
    const stepsPath = flags.get("--steps-json");
    if (stepsPath !== undefined) {
      // Regular-file proof BEFORE the open (readBriefFile's posture): a
      // directory reports a small st.size that sails past the cap into an
      // EISDIR read, and a FIFO would BLOCK the open-side read forever waiting
      // for a writer — only a regular file has a size worth trusting and can
      // be refused before it is opened. A statSync failure (ENOENT, EACCES)
      // leaves the stat unknown and falls through to the open's own catch
      // below, keeping the missing-file message shape.
      const stepsStat = (() => {
        try {
          return statSync(stepsPath);
        } catch {
          return undefined;
        }
      })();
      if (stepsStat !== undefined && !stepsStat.isFile()) {
        throw usageError(
          `--steps-json ${stepsPath} is not a regular file`,
          "point --steps-json at a readable JSON file mapping run ids to step outputs",
        );
      }
      let fd: number;
      try {
        // O_NONBLOCK closes the same window the read-side proof below could
        // not: a path swapped to a FIFO between the stat above and here BLOCKS
        // an `O_RDONLY` open of it forever (waiting for a writer) — parked
        // before the post-open fstat ever runs to refuse it. Non-blocking,
        // the open answers: ENXIO (no writer) through the catch below, or a
        // descriptor the fstat proof refuses.
        fd = openSync(stepsPath, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (e) {
        throw usageError(
          `cannot read --steps-json ${stepsPath}: ${(e as NodeJS.ErrnoException | null)?.code ?? (e as Error).message}`,
          "point --steps-json at a readable JSON file mapping run ids to step outputs",
        );
      }
      let rawSteps: string;
      try {
        // The proofs above are about whatever the PATH named when it was
        // stat'd; the read is of whatever it names now — re-point the path in
        // between (a symlink swung at a multi-GB file, a swapped-in FIFO) and
        // both the regular-file proof and the cap describe a different inode
        // than the bytes that arrive. Same answer as `readBriefFile`: open
        // once, prove the OPEN DESCRIPTOR, and read at most
        // `MAX_STEPS_BYTES + 1` bytes, so the cap binds on what was actually
        // read rather than on a size that could have grown since. O_NONBLOCK
        // stays set for the read: on the regular file this proof demands it is
        // INERT (a regular file's reads never block, with or without the flag;
        // POSIX gives O_NONBLOCK meaning only on FIFOs, devices and sockets),
        // so there is nothing left for it to do — the runtime exposes no
        // fcntl(2) to clear it with (`fs.fcntlSync` is absent) and the reads
        // below need no clearing.
        if (!fstatSync(fd).isFile()) {
          throw usageError(
            `--steps-json ${stepsPath} is not a regular file`,
            "point --steps-json at a readable JSON file mapping run ids to step outputs",
          );
        }
        const buf = Buffer.alloc(MAX_STEPS_BYTES + 1);
        let n = 0;
        for (;;) {
          let r: number;
          try {
            r = readSync(fd, buf, n, buf.length - n, null);
          } catch (e) {
            const errno = (e as NodeJS.ErrnoException | null)?.code;
            // POSIX makes O_NONBLOCK inert on a regular file — the fstat above
            // proved the descriptor is one — but a runtime/kernel that
            // surfaces EAGAIN on it anyway must not turn a readable file into
            // a usage exit 2. Degrade instead: read the path whole (the
            // regular-file proof still bounds the block — the swap this block
            // defeats is INTO a FIFO or device, which fstatSync refuses — and
            // the cap below still binds on the byte count). EINTR moved no
            // bytes: retry the read.
            if (errno === "EAGAIN" || errno === "EWOULDBLOCK") {
              const whole = readFileSync(stepsPath);
              whole.copy(buf, 0);
              n = whole.length;
              break;
            }
            if (errno === "EINTR") continue;
            throw usageError(
              `cannot read --steps-json ${stepsPath}: ${errno ?? (e as Error).message}`,
              "point --steps-json at a readable JSON file mapping run ids to step outputs",
            );
          }
          if (r <= 0 || n + r >= buf.length) {
            n += Math.max(0, r);
            break;
          }
          n += r;
        }
        if (n > MAX_STEPS_BYTES) {
          throw usageError(
            "--steps-json exceeds the 1 MiB cap",
            "point --steps-json at a smaller JSON file mapping run ids to step outputs",
          );
        }
        rawSteps = buf.subarray(0, n).toString("utf8");
      } finally {
        closeSync(fd);
      }
      let parsedSteps: unknown;
      try {
        parsedSteps = JSON.parse(rawSteps); // dp:ok already inside the try/catch raising the `--steps-json is not valid JSON` usage error; D020 depth-walker ceiling
      } catch (e) {
        throw usageError(
          `--steps-json is not valid JSON: ${(e as Error).message}`,
          "fix the file, then rerun",
        );
      }
      if (typeof parsedSteps !== "object" || parsedSteps === null || Array.isArray(parsedSteps)) {
        throw usageError(
          "--steps-json must be a JSON object keyed by run id",
          'e.g. {"qds-…": {"testsExecuted": true, "testResults": {"passed": 3, "failed": 1}, "changedFiles": ["a.ts"]}}',
        );
      }
      // Shape-check at the trust boundary: garbage entries would otherwise
      // surface as NaN scores in the ranking table instead of a named refusal.
      // The RULES are rank.ts's — one validator, so a payload can never pass
      // here and be refused there under a different code. All this keeps is
      // the wrapper naming the flag that carried the entry.
      for (const [runId, out] of Object.entries(parsedSteps as Record<string, unknown>)) {
        assertStepOutputShape(runId, out as ArmStepOutput, (why, hint) =>
          usageError(`--steps-json entry ${JSON.stringify(runId)} ${why}`, hint),
        );
        byRun.set(runId, out as ArmStepOutput); /* dp:ok shape-checked field-by-field by assertStepOutputShape against ArmStepOutput's three optional keys */
      }
    }
    // A WRITABLE store — rank stamps rankedAt. Shared residual: pointing
    // --dir at an existing directory re-chmods it 0700 before the lookup can
    // refuse; the default dir bootstrapping on first use is intended.
    // Resolved through resolveFanoutsDir HERE TOO: fanout's producer side
    // resolves this same flag through it, and one flag keeps one meaning and
    // one chain (flag → env → default) at both ends of the round-trip.
    // F049: rank reads what fanout wrote, so it takes the same pair of flags
    // with the same precedence and the same one-release deprecation.
    const fanoutsDirFlag = flags.get("--fanouts-dir");
    if (fanoutsDirFlag === undefined && dir !== undefined) warnDirDeprecated(note, verb);
    const fstore = new FanoutRecordStore({ dir: resolveFanoutsDir(fanoutsDirFlag ?? dir), requestId });
    const result = await rank(fanoutId, {
      recordReader: (id) => readFanoutForRank(fstore, id),
      recordWriter: (id, mutator) => fstore.mutate(id, (rec) => mutator(rec) as FanoutRecord),
      stepOutputFor: (runId) => byRun.get(runId) ?? null,
    });
    // An UNMATCHED key is a silent no-op today: `stepOutputFor` nulls the arm
    // it cannot find, so a typo'd run id (or a file for a different fan-out)
    // exits 0 with the ranking reading exactly as if the entry had never been
    // supplied — indistinguishable from a fully-scored run for the keys that
    // did match. Name the gap; the exit code stays 0, because the ranking that
    // was asked for is the one that printed and `fleet rank` is advisory
    // (re-running with a corrected file changes it, so "retry me" is not the
    // lie here — but the operator has to be TOLD the payload was partly inert).
    const armRunIds = new Set(result.scores.map((s) => s.runId));
    const unmatchedKeys = [...byRun.keys()].filter((k) => !armRunIds.has(k));
    if (unmatchedKeys.length > 0) {
      // File-controlled text into a stderr envelope: sanitize, then cap the
      // count — the same two rules status's skippedRecords echo applies, with
      // the same shared constants so the two echoes cannot drift.
      const echoed = unmatchedKeys.slice(0, MAX_SKIPPED_ECHO).map((k) => sanitizeLabel(k, MAX_DIAGNOSTIC));
      printError(
        note,
        "steps-json-unmatched",
        `${unmatchedKeys.length} of ${byRun.size} --steps-json key(s) named no arm in ${fanoutId} — those entries scored nothing`,
        "check the run ids in the file against the arm ids `fleet rank` prints — a typo'd or foreign id matches no arm and is dropped",
        { unmatched: echoed, ...(unmatchedKeys.length > MAX_SKIPPED_ECHO ? { unmatchedOmitted: unmatchedKeys.length - MAX_SKIPPED_ECHO } : {}) },
      );
    }
    emit(`${JSON.stringify(result)}\n`);
    return finish(requestId, verb, fanoutId, 0);
  } catch (e) {
    return finish(requestId, verb, undefined, reportCode(note, e));
  }
}

/** `fleet status` — the only read-only verb; it never takes the run lock. */
async function runStatus(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, dir, storeOpts, emit, note, finish } = ctx;
  const runIdArg = positionals[1];
  const driverName = flags.get("--driver");
  const requestId = newRequestId();
  try {
    if (positionals.length > 2) {
      throw usageError("status takes at most one <run-id>", "fleet status [run-id]");
    }
    // The same grammar harvest/teardown enforce: an over-long or malformed
    // id must not reach the store as an untyped path error. RAW — see the
    // teardown call site for why the cap belongs to the refusal, not here.
    if (runIdArg !== undefined) assertFleetRunId(runIdArg);
    assertDriverChosen("status", driverName, deps?.driver);
    // R5: status only READS. A stray half-set image pin must not make the one
    // verb that shows an operator what is still running exit 2.
    const driver = deps?.driver ?? asUsage(() => resolveCleanupDriver(driverName as string, { requestId }));
    assertRecordsDirUsable(dir, deps?.store);
    // `create: dir === undefined`. status only ever READS (statusAll/statusRun
    // call `get` and `list`), and a read-mode store skips the mkdir AND the
    // chmod — so `fleet status --dir /srv/existing` stops re-permissioning an
    // operator's directory to 0700 just to look at it. The DEFAULT directory
    // keeps its writable store: creating `.sandbox/runs` on first use is the
    // intended bootstrap, and refusing it would break every fresh checkout.
    // harvest/teardown deliberately do NOT do this — `teardownSandbox` calls
    // `store.close`/`set`, which read mode refuses, so they would need a read
    // probe AND a writable store: two constructions to save a chmod on a
    // directory the run legitimately owns.
    const store = deps?.store ?? asUsage(() => new RunRecordStore({ ...storeOpts, create: dir === undefined, requestId }));
    const statusDeps = { driver, store };
    const rows = runIdArg === undefined ? await statusAll(statusDeps) : [await statusRun(statusDeps, runIdArg)];
    for (const row of rows) emit(`${JSON.stringify(row)}\n`);
    // `statusAll` emits a `listUnavailable` row whenever driver.list() failed
    // or timed out (src/fleet/status.ts). The rows it did produce are still
    // worth printing — they are the records — but every box column in them is
    // a guess, and during a substrate outage with no open records the whole
    // output is that one row. Exit 0 there told the operator the fleet was
    // clean while every box in it kept billing, and a `| jq 'select(...)'`
    // consumer never saw the row at all. 1 is the declared code for "the
    // substrate failed, retry", and it is exactly what happened.
    // `boxUnknown` is the ONE-RUN vocabulary for the same outage (A23):
    // statusRun never emits the fleet-level `listUnavailable` row — a failed
    // `driver.list` reaches this verb's rows as `boxUnknown` instead
    // (status.ts: `boxes === null ⇒ boxUnknown`, its only producer) — so
    // `fleet status <run-id>` during a provider outage used to exit 0 printing
    // box columns the comment below calls a guess. Keying on both states makes
    // the single-run form carry the same refusal the fleet form does.
    // R4-37: for a CLOSED or approval-state record even `boxUnknown` was out
    // of reach — `rowForRecord` returns before that arm — so statusRun itself
    // now refuses those with the same exit-1 `list-unavailable` FleetError,
    // and the predicate below covers the open-record half.
    const listFailed = rows.some((r) => r.state === "listUnavailable" || r.state === "boxUnknown");
    if (listFailed) {
      printError(
        note,
        "list-unavailable",
        "the provider could not be listed: box state is unknown for every row above",
        "re-run `fleet status` once the provider answers; treat no output as UNKNOWN, not as an empty fleet",
      );
    }
    // The record-side half of the same failure, and the same argument: a
    // listing that REFUSED a record file is not the fleet, and exit 0 says it
    // is. `reapRuns` (src/providers/driver.ts) already treats this condition
    // as a hard refusal.
    //
    // Keyed on `skippedRecords`, not on `state === "recordsSkipped"`: the same
    // fact reaches the output two ways — the fleet-level row from `statusAll`,
    // and a `statusRun` ORPHAN row whose verdict one of those unread files may
    // contradict. Both mean the answer above may be wrong, and one predicate
    // covers both.
    const skipped = rows.flatMap((r) => r.skippedRecords ?? []);
    if (skipped.length > 0) {
      // The names come from `readdirSync` — filesystem-controlled text — and
      // land in a stderr envelope: same two rules as every other non-argv
      // echo in this file (sanitize first, then a count cap). Unbounded, a
      // hostile or merely littered records dir printed megabytes; capped,
      // the refusal still names enough to act on and says how many it did
      // not. The per-name cap is status.ts's MAX_DIAGNOSTIC, the sink
      // the producer side already sizes these for; the COUNT cap is status.ts's MAX_SKIPPED_ECHO,
      // shared so the two skipped-record echoes cannot drift apart.
      const echoed = skipped.slice(0, MAX_SKIPPED_ECHO).map((n) => sanitizeLabel(n, MAX_DIAGNOSTIC));
      printError(
        note,
        "records-skipped",
        `${skipped.length} record file(s) could not be read: the rows above are not the whole fleet`,
        "repair or remove the files named in skippedRecords, then re-run `fleet status` — nothing clears this on its own",
        {
          skippedRecords: echoed,
          ...(skipped.length > MAX_SKIPPED_ECHO ? { skippedRecordsOmitted: skipped.length - MAX_SKIPPED_ECHO } : {}),
        },
      );
    }
    // 5, not 2 and not 1. Exit 1 is `transient` = "retry me", and a malformed
    // record filename is there on every retry — the same reasoning the teardown
    // `finally` uses for exit 6, and the same code harvest's own corrupt-record
    // probe pins (`record-read-failed`). Exit 2 was the old answer (round-9's
    // wording) and is exactly the collision A22 names: 2 is the code every
    // `usageError`/`asUsage` refusal carries — "argv wrong, don't page" under
    // the round-9 DEC2 rule a dashboard applies to this file — so a
    // data-integrity alarm keyed on the records-skipped envelope would be
    // SUPPRESSED as an operator typo. 5 is the file's "a guard fired, the
    // answer is withheld, no retry heals it" code, it is non-retryable like 2
    // without meaning "the operator typed it wrong", and status trivially
    // mutates nothing, so its guard posture is literal. It wins over
    // `listUnavailable`'s 1 when both fire, because retrying cannot complete
    // the listing either way.
    // …otherwise no runs is a state, not an error (AC4).
    return finish(requestId, verb, runIdArg, skipped.length > 0 ? 5 : listFailed ? 1 : 0);
  } catch (e) {
    return finish(requestId, verb, runIdArg, reportCode(note, e));
  }
}

/**
 * exit 4 for a genuine absence; every other read failure is exit 5.
 *
 * The same classification harvest/teardown's own `notFound` applies. It was a
 * closure inside `runGateVerbs` while DF3.4 was the only wave that needed it;
 * DF1.10's `run` needs the identical split, and the function never closed over
 * anything — its two arguments were always its whole input — so hoisting it is
 * how the two stay one rule. 4 is "that run does not exist", 5 is "a guard
 * fired before anything was mutated".
 */
function assertRunExists(recordStore: RunRecordStore, id: string): void {
  try {
    getRecord({ store: recordStore }, id);
  } catch (e) {
    if ((e as HarvestError | null)?.code === "no-record") {
      throw new FleetError(4, "run-not-found", `no run record for ${id}`, "check the id (fleet status) — nothing was mutated");
    }
    if ((e as HarvestError | null)?.code === "record-read-failed") {
      const h = e as HarvestError;
      throw new FleetError(5, h.code, h.message, h.remediation);
    }
    throw e;
  }
}

/**
 * The read-mode store construction, with the ONE remediation its constructor
 * cannot carry. `create: false` skips the mkdir — the read verbs' whole
 * posture — so a host that has never run `fleet status` refuses here with the
 * store's plain `run records dir … is unreadable: ENOENT` and the remediation
 * naming the bootstrap verb and the resolved path. `assertRecordsDirUsable`
 * cannot be that voice — it only checks a directory the operator NAMED, and a
 * named one that is missing is a typo, not a fresh host. The message stays the
 * constructor's verbatim (the suite pins it, and it already names the path and
 * the errno).
 *
 * Exit 5, not the 2 it carried until A22 (round-9 B10 had kept 2 on the
 * argument that only the wording was wrong): the ENOENT arm is a GUARD
 * refusal — nothing was mutated, and no retry of the same argv heals it — but
 * it is not a USAGE refusal, and 2 is the code `isUsageRefusal` keys on to
 * mean "argv wrong, don't page" (round-9 DEC2). A missing records directory
 * is substrate state a dashboard must see: the gate verbs now emit their
 * `refused` event for it like every other post-grammar refusal. Every verb
 * that reaches this constructor already declares 5 in the registry, so only
 * status's table widened.
 *
 * Hoisted out of `runGateVerbs` with `assertRunExists` above (DF1.10) and for
 * the same reason; the three values it used to close over are now parameters.
 */
function makeReadOnlyStore(
  storeOpts: { dir?: string },
  dir: string | undefined,
  requestId: string,
): RunRecordStore {
  return asUsage(() => {
    try {
      return new RunRecordStore({ ...storeOpts, create: false, requestId });
    } catch (e) {
      // `| null` + optional chaining, the sibling idiom (`assertRunExists`, the
      // loser-ledger `readRunRecord`): a `throw null` must not become a
      // TypeError inside the catch that is supposed to classify it — that
      // escapes as unclassified exit 1 instead of the ENOENT refusal below.
      if ((e as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw e;
      // TWO remediations, because the advice only held for the default
      // directory (A14): `fleet status --dir <named>` builds ITS store
      // `create: dir === undefined`, so it refuses to create a directory the
      // operator named — following the old single instruction looped forever.
      // A named directory is created by dispatch (the verb that mkdirs), and
      // the honest advice is to point at the one the run already has.
      throw new FleetError(
        5,
        "records-dir-absent",
        (e as Error).message,
        dir === undefined
          ? `run \`fleet status\` once to create ${resolveRunsDir(dir)}`
          : `read verbs never create a records directory you named — point --dir at the one \`fleet dispatch --dir ${bounded(dir)}\` created, or run \`fleet status\` once with no --dir to bootstrap the default at ${resolveRunsDir(undefined)}`,
      );
    }
  });
}

/**
 * `fleet run <run-id>` — DF1.10 AC1's host side.
 *
 * Starts `qds-run@<runId>.service` on a box dispatch already provisioned and
 * the setup gate already passed, and RETURNS. It never walks a phase, never
 * polls the marker, never waits for the engine: completion is `fleet status`'s
 * job and the artifacts are `fleet harvest`'s. `src/fleet/run.ts` holds the
 * whole argument for the argv, the `sudo -n`, the deadline and the absence of
 * any host-side "is it already running?" probe.
 *
 * Shaped like `attach` rather than like `harvest`/`teardown`: it takes NO run
 * lock. The lock guards a DESTRUCTIVE window — a box being destroyed, a key
 * being revoked, a record being closed — and this verb mutates nothing at all.
 * Serialising two concurrent `fleet run`s behind it would buy nothing either,
 * because the thing that makes a double start safe is systemd's unit identity,
 * which holds whether or not the host took a lock (AC6).
 *
 * THE `closedAt` CHECK IS A FAST REFUSAL, NOT AN INVARIANT — attach's honesty,
 * and the same window. The record is read here and the start fires under no
 * lock, so a `fleet teardown` running concurrently gets an engine started on a
 * box it is about to destroy.
 *
 * THE WINDOW IS WIDE, and saying so is the point: it is ANY overlapping
 * teardown, not the microseconds between a check and the start. It stays wide
 * because there is NOTHING TO CHECK — this was measured, not assumed. The
 * destructive mark is process-local (`scripts/lib/run-lock.ts:105,360-361` — a
 * `Set<string>` in module state, whose real job is stopping the SIGINT handler
 * releasing a lock mid-destroy), so another process's teardown leaves no trace
 * of itself. The lock FILE carries no verb either (`:958`, the body is
 * `<pid> <host> <ISO> <nonce>`), and `runDestructive` passes one holder string
 * for harvest and teardown alike, so "a lock exists" cannot tell a destroy from
 * an ordinary harvest. Refusing on the lock's mere existence would block every
 * `fleet run` for the duration of a NON-destructive harvest and add a
 * stale-lock failure mode to a verb that mutates nothing.
 *
 * Accepted because the blast radius is small, not because the race is
 * uninteresting: the box is destroyed (taking the engine with it) and the run's
 * capped key is revoked, so the exposure is at most a partial phase's spend
 * under a ceiling the run already authorized, on a box that is ceasing to
 * exist. AC6's marker refusal covers re-entry after the fact.
 *
 * ponytail: wide race, accepted. Narrowing it needs a CROSS-PROCESS destructive
 * signal, which is a lock-format change (write `acquireRunLock`'s existing
 * `holder` into the body, refuse here only when it says teardown) — shared
 * infrastructure with a second consumer, so it is its own change, not a rider
 * on this one.
 */
async function runRun(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, dir, storeOpts, note, finish, reportCompletion, outputIncomplete } = ctx;
  const runIdArg = positionals[1];
  const driverName = flags.get("--driver");
  const requestId = newRequestId();
  const usage = "fleet run <run-id> --driver <name>";
  // From VERB ENTRY, not from the `startRun` call it used to bracket: the line
  // below now also reports attempts that never reached the box, and "0 ms"
  // against a usage error would be the only honest number a call-scoped clock
  // could give them. For a start that did happen this widens `duration` by the
  // record read and the driver resolution — tens of ms, on a field that has
  // always measured "how long this attempt took".
  const startedAtMs = Date.now();
  /**
   * The RECORD's correlation id, not this invocation's — the join key that ties
   * this start to the dispatch that provisioned the box and to the engine's own
   * lines once it is walking (INV-4-bis). Read off `startRun`'s result rather
   * than the store: `startRun` has already read the record, and a second read is
   * a second failure mode for an echo. Absent on a record that was never
   * dispatched and on every refusal that precedes the read, and omitted rather
   * than invented.
   */
  let dispatchRequestId: string | undefined;
  /**
   * One structured line per start attempt — INCLUDING the attempts that never
   * reach `startRun`.
   *
   * Hoisted above the `try` for exactly that: a usage error, a malformed run
   * id, an unresolvable driver, an unusable records dir and an unknown run all
   * exit through the catch below, and while it lived inside the try none of
   * them produced a `fleet.run` line at all — the header's "one structured line
   * per start attempt" was true only of the attempts that got as far as the
   * box, which are the ones an operator needs to count least.
   *
   * Guarded like every sibling: a raising sink must never replace the verb's
   * real outcome.
   */
  const logStart = (status: "ok" | "error", extra: Record<string, unknown>): void => {
    const durationMs = Date.now() - startedAtMs;
    try {
      log({
        requestId,
        operation: "fleet.run",
        agentId: null,
        timestamp: new Date().toISOString(),
        duration: durationMs,
        durationMs,
        status,
        // `bounded`, because a refusal logs the id it refused: the pre-start
        // arms fire BEFORE `assertFleetRunId`, so this is raw argv there.
        // ABSENT maps to null — the sentinel a missing `bounded` would print
        // ("(none)") is a real string a sweep could mistake for a run id, and
        // every sibling emitter (`logVerb`, `gateEvent`) writes null here.
        runId: runIdArg === undefined ? null : bounded(runIdArg),
        verb: "run",
        // Record-supplied join key: capped and sanitized exactly like the
        // four other consumers of this field (`gateEvent`, the attach
        // completion line, status rows, approval-gate) — a torn record's
        // unbounded string may not ride the structured line raw.
        ...(dispatchRequestId === undefined ? {} : { dispatchRequestId: sanitizeLabel(dispatchRequestId, 128) }),
        ...extra,
      });
    } catch {
      // see `refuse` (dispatch.ts): the log line may not decide the exit code
    }
  };
  try {
    if (positionals.length > 2) throw usageError("run takes exactly one <run-id>", usage);
    if (runIdArg === undefined) throw usageError("run requires <run-id>", usage);
    // RAW, not `bounded`: `assertFleetRunId` owns the echo bound and the
    // redaction (see its call site in `runDestructive`). It also narrows the id
    // to the RFC 1123 label grammar BEFORE it can reach a systemd instance
    // name — the guarantee `src/fleet/run.ts` relies on to interpolate it.
    assertFleetRunId(runIdArg);
    // At the TOP, before any store is constructed: this verb reaches INTO the
    // box over the driver port, so it must never default one — attach's
    // placement, and harvest/teardown's before it.
    assertDriverChosen("run", driverName, deps?.driver);
    const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId, runId: runIdArg }));
    assertRecordsDirUsable(dir, deps?.store);
    // READ-MODE, unconditionally, for attach's reason: this verb WRITES
    // NOTHING to the record. The run's own history is the in-box journal and
    // the marker the engine writes; a host-side "started" stamp would be a
    // second, weaker copy of a fact `fleet status` already reads from the box.
    const store = deps?.store ?? makeReadOnlyStore(storeOpts, dir, requestId);
    assertRunExists(store, runIdArg);

    // `startRun` reads the SAME record a second time, and that read sits
    // OUTSIDE its own try BY DESIGN (its docblock: `assertRunExists` owns the
    // 4/5 classification) — but `assertRunExists` classified the FIRST read.
    // A record that vanishes or goes unreadable in the window between the two
    // reads escaped here as a raw HarvestError, which `report`'s untyped
    // branch stamps exit 1 `transient` — the one classification a vanished
    // record must never carry, because no retry restores it. Re-read through
    // the SAME classifier so the second read's failure carries the first
    // read's meaning (4 = gone, 5 = unreadable — one rule, not a second copy
    // of it). If the re-read finds the record back, the original error stands:
    // a retry honestly might work, and 1 is the right verdict for it.
    let res: StartRunResult;
    try {
      res = await startRun({ driver, store }, runIdArg, deps?.runOptions ?? {});
    } catch (e) {
      assertRunExists(store, runIdArg);
      // The record is BACK (the re-read above did not throw): rethrow WITHOUT
      // the errno classification. The original error is an fs errno from the
      // store's own read (`err.code` re-attached), and `report`'s errno table
      // would stamp any PERMANENT_ERRNOS code exit 2 "identical on every
      // retry" — the opposite of what this arm just observed. A clean
      // message-only rethrow (cause kept for forensics) gives the untyped
      // branch's documented transient verdict (1).
      if (e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string") {
        throw new Error(e.message, { cause: e });
      }
      throw e;
    }
    dispatchRequestId = res.outcome === "run-not-startable" ? undefined : res.requestId;

    if (res.outcome === "run-not-startable") {
      const state = sanitizeLabel(res.state, 64);
      logStart("error", { outcome: res.outcome, state });
      // 5, and NOT 1: the guard fired before any exec, so nothing on the box
      // was touched — and no retry of this verb can make a torn-down box
      // startable. attach's `run-not-attachable` is the same refusal in the
      // same place for the same reason.
      printError(
        note,
        "run-not-startable",
        `${runIdArg} cannot be started: it is ${state}`,
        // FOUR-WAY, and the fourth arm is the point — attach's round-9 E4/B12
        // ruling, adopted rather than re-learned. The three NAMED approval
        // states are all strictly after `requestApproval`'s teardown, so "its
        // box is gone" is established for those; an UNKNOWN state string is
        // evidence of nothing, and telling an operator their box was torn down
        // on the strength of a state this build does not recognise is a claim,
        // not an observation. `fleet status` is the check.
        res.state === "no-box"
          ? "this run has no box recorded — `fleet run` starts an engine on a box `fleet dispatch` already provisioned"
          : res.state === "closed"
            ? "this run is over and its box was torn down — dispatch a new run instead"
            : res.state === "pausing" || res.state === "awaiting-approval"
              ? "the run is paused at the approval gate — decide it with `fleet approve`/`fleet reject`; a phase engine started now would walk a run nobody has released"
              : res.state === "approved" || res.state === "rejected" || res.state === "timed-out"
                ? "this run is over and its box was torn down before it reached that state — dispatch a new run instead"
                : res.state === "(unknown approval state)"
                  ? "the record's approval extension carries no readable state — a torn or hand-edited write (`fleet status` may render this run as ordinary, so read the record's `extensions.approval` by hand before acting)"
                  : `this run reports the state "${state}", which takes no engine start — run \`fleet status ${runIdArg}\` and inspect the box before acting`,
        { runId: runIdArg, state },
      );
      return finish(requestId, verb, runIdArg, 5);
    }
    if (res.outcome === "start-failed") {
      logStart("error", {
        outcome: res.outcome,
        reason: res.reason,
        ...(res.exitCode === undefined ? {} : { exitCode: res.exitCode }),
      });
      const unreachable = res.reason === "box-unreachable";
      // Both fragments are OPTIONAL and both are omitted when absent rather
      // than rendered empty: a host deadline that fired has no exit status
      // (`(exit undefined)` would be a lie), and a box that failed silently has
      // no stderr (a message ending in a bare colon reads as truncated output).
      const status = res.exitCode === undefined ? "" : ` (exit ${res.exitCode})`;
      // `res.detail` is REMOTE BOX STDERR — the least trusted string on this
      // path, and until now the only one that reached the operator's terminal
      // raw. Redact, then strip control characters and cap, which is the
      // treatment `res.state` gets three lines up (and `bounded`'s documented
      // order: capping first can slice a credential across the boundary into
      // halves no redaction rule matches). Without the strip, ANSI/OSC escapes
      // from the box repaint the terminal that is reporting the failure, a lone
      // CR hides the line, and megabytes of it land in whatever captured it.
      const said =
        res.detail === undefined || res.detail === ""
          ? ""
          : `: ${sanitizeLabel(redactSecrets(res.detail), 512)}`;
      // The whole exit-code argument, in one place. `unit-refused` means
      // systemd ran the job and it failed — `AssertPathExists=` on the
      // credential file, or no such unit on a box built from the wrong image —
      // and the identical retry produces the identical failure, so it takes 5
      // ("refused, nothing started"), never 1's `transient` "retry me".
      // `box-unreachable` is the one arm a retry can clear, and retrying it is
      // safe by AC6's unit identity: if the start DID land before the transport
      // died, `systemctl start` on the active instance is a no-op.
      printError(
        note,
        unreachable ? "engine-start-unreachable" : "engine-start-refused",
        unreachable
          ? `box for ${runIdArg} never answered the engine start${status}${said}`
          : `systemd refused to start the engine for ${runIdArg}${status}${said}`,
        unreachable
          ? "confirm the box is up (`fleet status <run-id>`) and re-run — a start that did land makes the retry a systemd no-op, never a second engine"
          : `ssh the box and read \`systemctl status ${runUnitName(runIdArg)}\`: the unit is Restart=no, so this failure is terminal and identical on every retry`,
        { runId: runIdArg, unit: runUnitName(runIdArg), reason: res.reason },
      );
      return finish(requestId, verb, runIdArg, unreachable ? 1 : 5);
    }
    if (res.outcome !== "started") {
      // A THIRD failure outcome added to `StartRunResult` must be handled here,
      // not fall through to the success path below — which would print
      // `started: <run-id>`, log `status: "ok"` and return 0 for a start that
      // did not happen, and no test would notice because the outcome is new.
      // The same discipline the engine applies to `PhaseKind`
      // (`makeBodyFactory`'s `unreachableKind`): a new member is a COMPILE
      // error at every site that has to decide about it.
      const unreachableOutcome: never = res;
      throw new Error(
        `fleet run: unhandled startRun outcome ${bounded(JSON.stringify(unreachableOutcome))}`,
      );
    }

    // Through `reportCompletion`, not a bare `emit` (see it): the engine is
    // ALREADY walking phases in the box, so a lost result line is 6 — "landed,
    // and the CLI's own output failed after it" — never a retryable 1 that
    // would send automation back to start a run that is already running.
    //
    // `&& !outputIncomplete()` is the gate verbs' rule (approve/unlock/attach),
    // and it is about the LOG line, not the exit code — `finish` already folds
    // an EAGAIN-truncated stdout into 6 on its own. Without it this event would
    // read `status: "ok"` beside that exit 6: `reportCompletion` answers true
    // for a line fd 1 silently swallowed half of, so the write "succeeded" while
    // the operator's contract was violated.
    //
    // The STARTED arm can carry a `detail`, and dropping it printed a
    // byte-identical `started:` line for a corroborated and an UNCORROBORATED
    // start — the run.ts arm whose whole point is "the operator's next command
    // is `fleet status`, not trust" was dead code at this layer. Printed as a
    // SECOND line, after `started:` (which stays first so a half-lost write
    // still names the run), with the same redact-then-strip-then-cap treatment
    // `start-failed` gives its detail above, and mirrored onto the log line so
    // a `fleet.run` sweep sees the caveat without the terminal.
    const uncorroborated =
      res.detail === undefined || res.detail === "" ? "" : sanitizeLabel(redactSecrets(res.detail), 512);
    const printed =
      reportCompletion([
        `started: ${runIdArg}\n`,
        ...(uncorroborated === "" ? [] : [`${uncorroborated}\n`]),
      ]) && !outputIncomplete();
    logStart(printed ? "ok" : "error", {
      outcome: res.outcome,
      vm: res.vm,
      unit: res.unit,
      printed,
      ...(uncorroborated === "" ? {} : { detail: uncorroborated }),
    });
    return finish(requestId, verb, runIdArg, printed ? 0 : 6);
  } catch (e) {
    const exitCode = reportCode(note, e);
    // EVERY pre-start refusal exits here — usage, the run-id grammar, the driver,
    // the records dir, an unknown run — and each of them is a start attempt an
    // operator counting `fleet.run` lines has to see. Emitted from the catch
    // rather than from each arm on purpose: an arm added later is covered
    // without anyone remembering to add a line to it. `report` has already
    // printed the operator-facing message and chosen the code; the code is what
    // this line carries, since the message may quote the box.
    //
    // But "refused" is a claim about WHERE the failure landed, and the exit
    // code is the evidence this catch has (A20): 2/4/5 are the codes whose
    // meaning IS "decided before the box was touched" (usage, absent record,
    // guard refused), so they keep the word. 1 and 6 arrive from failures this
    // catch cannot place relative to the start decision — the errno-rethrow
    // arm above, the unreachable-outcome guard, a sink fault — and a start may
    // have LANDED on the box, so those log "start-unknown" instead: a
    // `fleet.run` sweep must not read them as "nothing started" when the exact
    // opposite is possible. (Behavior change, flagged: previously every catch
    // exit was labelled "refused".)
    //
    // 3 never joins the set because 3 can never arrive: it is the setup gate's
    // code, produced only inside dispatchRun's provisioning path, and nothing
    // this verb's try reaches (`startRun`, `assertRunExists`, the driver
    // resolution) constructs or rethrows one.
    const refused = exitCode === 2 || exitCode === 4 || exitCode === 5;
    logStart("error", { outcome: refused ? "refused" : "start-unknown", exitCode });
    return finish(requestId, verb, runIdArg, exitCode);
  }
}

/**
 * `fleet approve` / `reject` / `enrol` / `unlock` / `attach` — DF3.4's gate verbs
 * as one handler. Written as inline blocks inside `run()`'s monolith, the F015
 * split (waves 5-6) extracted every other verb into `runX(ctx)` functions; this
 * wrapper gives the gate verbs the same shape without rewriting a line of their
 * reviewed bodies. The blocks inside still route on `verb`, so one entry point
 * serves all five. Everything the monolith used to close over arrives through
 * `VerbCtx`, with this invocation's `requestId` minted locally — the same
 * per-verb ownership `runDestructive` established.
 */
/** The five registry verbs `run()` routes to the gate handler below. */
const GATE_VERBS: ReadonlySet<string> = new Set(["approve", "reject", "enrol", "unlock", "attach"]);

async function runGateVerbs(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, bools, dir, storeOpts, startedAt, note, finish, reportCompletion, outputIncomplete } = ctx;
  const runIdArg = positionals[1];
  const driverName = flags.get("--driver");
  const requestId = newRequestId();
  /**
   * Both helpers below moved to module scope in DF1.10, unchanged in behaviour:
   * `run` needs the identical 4/5 split and the identical read-mode store, and
   * a second copy of either is how the two would drift. Neither ever closed over
   * anything the caller could not hand it — `assertRunExists`'s two arguments
   * were always its whole input, and this arrow keeps the three values that
   * were, so the five call sites below read exactly as they did.
   */
  const readOnlyStore = (): RunRecordStore => makeReadOnlyStore(storeOpts, dir, requestId);

  /**
   * One structured line per gate event (the story's observability contract):
   * {requestId, runId, event, state, approverId?, durationMs, outcome}.
   *
   * Separate from `logVerb`'s per-INVOCATION line, which stays exactly as
   * DF3.1 wrote it — adding fields there would mean changing `finish`'s
   * signature, a DF3.1-owned surface. `dispatch()` already emits its own
   * run-scoped lines beside the CLI's; this is the same split.
   *
   * The token NEVER appears here, in any form: only `approverId` — which the
   * operator typed — and the outcome. Guarded, because a raising sink must
   * never replace the verb's real outcome (fanout-primitive's `emitLine` rule).
   */
  /**
   * A usage refusal is argv being wrong, not a gate outcome, so it emits no
   * gate event — uniformly across all five verbs (round-9 DEC2). A dashboard
   * keys on this stream's non-"ok" lines and pages on them; `fleet attach
   * <id>` with the message flag forgotten is an operator typo, and paging
   * somebody for it trained them to ignore the page. Everything the verbs
   * refuse AFTER the grammar — guards, absent runs, transport faults — still
   * emits. Discriminated on the typed envelope (`exitCode === 2`), never on
   * message text: `asUsage`, `assertDriverChosen`, `assertRecordsDirUsable`
   * and every `usageError` in the verb bodies all land here as FleetError(2).
   */
  const isUsageRefusal = (e: unknown): boolean => e instanceof FleetError && e.exitCode === 2;
  /**
   * `status: "ok"` ⇔ the invocation exits 0. Not a taste question: a dashboard
   * keyed on this field alerts on every line that is not "ok", so the set has
   * to be the exit-0 set exactly.
   *
   * Two things decide exit 0, so two things decide "ok": the OUTCOME (this
   * set) and whether the completion line actually printed. The event used to
   * fire before `reportCompletion`'s result was known, so a lost line logged
   * "ok" beside an exit 6. The success arms below now emit with the print
   * fate as `printed`, and a lost line degrades the event to "error" — the
   * invocation IS exiting 6, and the dashboard rule above is the whole point.
   *
   * `already-decided` is the one that was missing, and it is the documented
   * IDEMPOTENT-SUCCESS path — the block below exits 0 and argues at length that
   * it is a success — so every duplicate approval was logging an error. The
   * non-members are non-members because they exit non-zero: `attach-not-acked`
   * is 6 (landed, needs an operator), `run-not-attachable` and every allowlist
   * refusal are 5, `timed-out` is a window that closed.
   *
   * `unlock`'s exit-0 outcomes are all here for that same rule. `reclaimed`
   * is obvious; `absent` is the one worth stating, because a run with no
   * approval lock is the HEALTHY answer to "is this run wedged?" — a
   * dashboard that alerted on it would page somebody every time the verb
   * confirmed nothing was wrong. `changed` exits 0 as well: the lock the
   * operator was shown is gone and a SUCCESSOR holds the path now. The
   * `holder`/`ageMs` fields the completion line echoes describe the
   * PREDECESSOR's lock — the one the operator's force decision was about —
   * not the successor's (`reclaimApprovalLock`'s own docblock says so: `info`
   * is what was inspected, and the successor arrived after the inspection);
   * the event's `outcome` is the part that carries the new fact.
   */
  const GATE_OK_OUTCOMES: ReadonlySet<unknown> = new Set([
    "decided",
    "already-decided",
    "attach-acked",
    "reclaimed",
    "absent",
    "changed",
  ]);
  /**
   * The RUN's dispatch correlation id, once this invocation has read a record
   * that carries one — NOT this invocation's `requestId`, which is a different
   * fact under a different key (see the attach completion line below, which has
   * drawn that distinction since DF3.4 shipped).
   *
   * It is on the gate events because it is the ONLY id that is the same on both
   * sides of the gate: the `pause` line comes from `src/fleet/approval-gate.ts`
   * inside a reverify process, every decision line comes from a separate
   * `fleet approve`/`reject` invocation, and their `requestId`s can never match.
   * DF5.3 is specified to join approvals across every gate event; before this
   * field there was no key it could join on.
   *
   * `undefined` until a record is read, and OMITTED rather than nulled when it
   * stays that way — a refusal that never got as far as a record has no dispatch
   * id, and an absent field says that more honestly than a null does.
   */
  let gateDispatchRequestId: string | undefined;
  const gateEvent = (
    event: "pause" | "approve" | "reject" | "timeout" | "refused" | "attach" | "unlock",
    runId: string | undefined,
    fields: Record<string, unknown>,
    // Whether the invocation's completion line reached stdout. The success
    // arms emit AFTER `reportCompletion` answers, so an "ok"-set outcome
    // whose line was lost (exit 6) is logged "error", not "ok".
    printed = true,
  ): void => {
    // `fields` is spread FIRST and the computed keys come after it, so no
    // caller-supplied key — `status`, `runId`, `requestId`, `timestamp`, the
    // truthfulness set the GATE_OK_OUTCOMES rule calls the whole point — can
    // clobber what this line is named for. Every current caller passes none;
    // this is the guard for the caller that one day will.
    const durationMs = Date.now() - startedAt;
    const entry: LogEntry = {
      ...fields,
      requestId,
      operation: `fleet.${event}`,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: printed && GATE_OK_OUTCOMES.has(fields.outcome) ? "ok" : "error",
      runId: runId === undefined ? null : bounded(runId),
      event,
      // `""` is skipped as well as `undefined`: the unlock arm's `?? ""` guard
      // coerces a null `requestId` out of an operator-edited record, and an
      // empty join key names no dispatch at all — omitting it is truer than
      // printing an empty string DF5.3 would try to join on.
      ...(gateDispatchRequestId === undefined || gateDispatchRequestId === ""
        ? {}
        : { dispatchRequestId: sanitizeLabel(gateDispatchRequestId, 128) }),
    };
    try {
      log(entry);
    } catch {
      // A diagnostic is never the verb's outcome — but a sink that raises on
      // EVERY emit used to silence the whole gate stream invisibly (the
      // dispatchRequestId joins DF5.3 depends on included). `warnSinkRaising`
      // notes it once per process; the events are still dropped and the verbs
      // still exit correctly.
      warnSinkRaising();
    }
  };

  // ── approve / reject (DF3.4 AC2/AC4) ────────────────────────────────────────
  if (verb === "approve" || verb === "reject") {
    const decision = verb === "approve" ? "approved" : "rejected";
    try {
      if (positionals.length > 2) throw usageError(`${verb} takes exactly one <run-id>`, `fleet ${verb} <run-id> --approver <id>`);
      if (runIdArg === undefined) throw usageError(`${verb} requires <run-id>`, `fleet ${verb} <run-id> --approver <id>`);
      // RAW, not `bounded`: assertFleetRunId owns the echo bound (see the
      // teardown call site) and reports the true length.
      assertFleetRunId(runIdArg);
      // TRIMMED, and empty is the same refusal as absent. `--approver ""` — an
      // unset `--approver "$APPROVER"` is how it actually happens — used to
      // pass this presence check and reach the allowlist, which refused it as
      // exit 5 "check the token / the allowlist" with a blank subject. That is
      // the wrong half of the fix: an empty flag VALUE is a wrong invocation,
      // which is exit 2 naming the flag. The `--message` guard in the attach
      // block below already draws the line this way.
      const approverId = flags.get("--approver")?.trim();
      if (approverId === undefined || approverId === "") {
        throw usageError(
          `${verb} requires --approver <id>`,
          "pass the approver id registered in .factory/approvers.json; its token arrives on stdin, never as a flag",
        );
      }
      // NO assertDriverChosen, BY DESIGN — `rank`'s precedent (see its block).
      // This verb reads and writes one record's `extensions.approval` and
      // touches no box, so the fake-driver hazard that guard exists to stop is
      // structurally unreachable. The registry declares no --driver either, so
      // `parseArgv` refuses one before this line runs.
      assertRecordsDirUsable(dir, deps?.store);
      // The attach block's ONE-STORE order, for the same reason: probe through
      // a read-mode view UNCONDITIONALLY, so neither a typo'd named directory
      // nor the default one is chmod'd 0700, temp-swept, or O_EXCL-probed
      // before the caller has authenticated. This used to exempt the default
      // dir (`dir === undefined` ⇒ writable probe), which ran the full
      // mutating construction PRE-authentication — while the writable-store
      // comment below claims it is built "only once the run is confirmed AND
      // the caller has authenticated". The writable store is built below, at
      // exactly that point, for both cases.
      const probe = deps?.store ?? readOnlyStore();

      /**
       * Existence and the bound pair are READ here — before authentication,
       * which reads stdin and is where a rebind can land underneath the
       * approver — but nothing is REPORTED until the token has been checked.
       *
       * The read has to be early: `submitDecision` compare-and-sets on the
       * reportId "it read" (AC1(a2)), so a decision that raced a rebind is
       * answered with the pair that displaced it rather than being recorded
       * against a report the approver never saw. The REPORT has to be late:
       * every other guard in this block is ordered after `authenticate`, and
       * `assertRunExists` alone was not — so an unauthenticated caller could
       * separate "no such run" (4) from "that run exists" (5) by exit code and
       * enumerate the fleet's run ids without ever holding a token. Deferring
       * the throw costs one variable and keeps both properties.
       *
       * ponytail: the CAS is seeded from what THIS INVOCATION read, not from
       * what the approver saw on screen, so it cannot catch a rebind that
       * landed before they ran the command — only one landing during the token
       * read. The window it closes is the one the CLI actually has. Upgrade
       * path, deliberately not taken here: an approver-asserted `--report-id`
       * would close the wider window, but it is a DIFFERENT property than the
       * story specifies and needs a registry flag `src/fleet/verbs.ts` does not
       * declare. It is cheap to add later — W5a's AC7 work surfaces `reportId`
       * in `fleet status`, so an operator can already see the id to assert.
       */
      let preAuthFailure: unknown;
      let boundReportId = "";
      // The PRE-auth read answers exactly two questions — does the record
      // exist, and what reportId is it bound to — and NOTHING ELSE reaches an
      // unauthenticated caller. It deliberately does NOT read the approval
      // STATE: the auth-refusal arm's event used to echo what this read found
      // (`awaiting-approval` for a parked run, `absent` for a run with no gate
      // extension), which let a caller holding no token separate ids that
      // reached the gate from ids that never did — an enumeration oracle the
      // deferral of `preAuthFailure` exists to close, and round-9 V3's
      // HIGH finding. The state is still observable POST-auth: the two refusal
      // arms below log `outcome.state` from `submitDecision`'s own answer.
      try {
        assertRunExists(probe, runIdArg);
        const rec = probe.get(runIdArg);
        // `?? ""` is a DELIBERATE value, not a fabricated CAS token: a record
        // with no `reportId` at all is a hand-edit, and `submitDecision`
        // normalises BOTH sides of its compare-and-set the same way
        // (`String(existing.reportId ?? "")` against
        // `String(req.reportId ?? "")`), so "" compares equal to "" and the
        // decision proceeds — nothing is refused as `report-changed` that the
        // record itself did not change. The field is typed `string` (not
        // optional) for exactly this reason; `undefined` would coerce to the
        // same "" one line later.
        boundReportId = String(rec.extensions?.approval?.reportId ?? "");
      } catch (e) {
        preAuthFailure = e;
      }

      // The allowlist root is the SAME one `fleet enrol --dir` writes under
      // (round-9 C10 parity): the flag's declared meaning is the allowlist's
      // root, and an authenticate that resolved under `process.cwd()` while
      // enrol resolved under `--dir` would split the two halves of one
      // credential store. Omitted flag ⇒ `process.cwd()`, byte-identical to
      // the pre-C10 behavior.
      const auth = await (deps?.authenticate ?? authenticateFromStdin)(dir ?? process.cwd(), approverId);
      if (!auth.ok) {
        // Every refusal from the allowlist is exit 5: a guard fired, nothing
        // was mutated, and 2's default remediation is the flag list — which is
        // not the remediation for a bad token or an unreadable allowlist.
        // Reported BEFORE `preAuthFailure` is rethrown, so a caller holding no
        // valid token learns only that their token was refused.
        //
        // The event logs `state: "unknown"` as a CONSTANT. Any value from the
        // pre-auth read would be exactly the leak the arm's ordering forbids,
        // and "unknown" is also the truthful value: a caller who never proved
        // they may decide anything was shown nothing about this record. The
        // dispatch id is absent from the event for the same reason — it is
        // read from the record only AFTER this point (see below), so a refused
        // caller cannot correlate an id with an existence answer either.
        printError(note, auth.refusal.code, auth.refusal.message, auth.refusal.remediation, { runId: runIdArg });
        gateEvent("refused", runIdArg, { outcome: auth.refusal.code, state: "unknown" });
        return finish(requestId, verb, runIdArg, 5);
      }
      // Authenticated — now the run's absence (4) or its unreadable record (5)
      // may be named. `report` in the catch renders it exactly as it would have
      // rendered it above.
      if (preAuthFailure !== undefined) throw preAuthFailure;

      // The dispatch join key, read from the record the same way `attachToRun`
      // reads it — deliberately AFTER the auth answer, so the pre-auth event
      // above can never carry it. `extensions.approval.requestId` is the
      // fallback because the gate stamps the dispatch id there when it
      // registers the pause, so a record whose top-level field was never
      // written still joins. An unreadable record here has no id to join on
      // and nothing to invent: the writable store below re-reads and refuses
      // through its own typed arms.
      try {
        const rec = probe.get(runIdArg);
        // `?? ""` normalizes a record that carries `requestId: null` (hand-
        // editable disk — boundReportId's sibling guard, A16): `String(null)`
        // is the literal "null", which would have become ONE shared join key
        // every such run cross-contaminated DF5.3's joins through. "" is
        // omitted downstream by gateEvent's empty-key guard, like `undefined`.
        gateDispatchRequestId = rec.requestId ?? String(rec.extensions?.approval?.requestId ?? "");
      } catch {
        /* no id joinable; the post-auth arms report the read failure */
      }

      // The writable store, built only once the run is confirmed AND the caller
      // has authenticated: it is the construction that chmods the directory
      // 0700, sweeps its temps and probes O_EXCL, and none of that should
      // happen for a caller who never proved they may decide anything. Built
      // for BOTH dir cases now — the probe above is read-only unconditionally,
      // so it can never be the store a decision is submitted through.
      const store = deps?.store ?? asUsage(() => new RunRecordStore({ ...storeOpts, requestId }));

      // AC3: expiry is evaluated BEFORE this invocation's own decision, so a
      // decision arriving after `expiresAt` finds `timed-out` and is refused.
      // This path holds a writable store, which is the only place the sweep can
      // be persisted (`fleet status --dir` builds a create:false store).
      //
      // `submitDecision` sweeps internally too, so this call is redundant for
      // the WRITE — do not delete it on that basis. It is the ONLY thing that
      // emits `event: "timeout"`, which the observability contract requires as
      // its own event; without it an expired run logs a decision line and no
      // record that a window closed.
      const tSweep = Date.now();
      // A28: whether THIS invocation already emitted the timeout event. The
      // pre-sweep below is its producer — but it reads `expiresAt` once, and a
      // decision landing within a µs of the boundary can read it early (no
      // event here) while `submitDecision`'s internal sweep, re-evaluating
      // moments later, persists `timed-out` and answers `already-decided`. The
      // success arm below then emits the event on the DETECT side, guarded by
      // this flag so the normal path (sweep fired, decision refused over the
      // timed-out record) never logs the window twice.
      let timeoutEmitted = false;
      if (await sweepExpired({ store }, runIdArg)) {
        gateEvent("timeout", runIdArg, { outcome: "timed-out", state: "timed-out", expiry_sweep_ms: Date.now() - tSweep });
        timeoutEmitted = true;
      }

      // R4-7: the record's approval state AS THIS INVOCATION FOUND IT, read
      // between its own pre-sweep and its own decision. `submitDecision`'s
      // answer (`already-decided` over `timed-out`) cannot distinguish a
      // timeout IT just persisted from one some EARLIER sweep persisted — and
      // only the first is a window that closed during this invocation without
      // an announcement. The second is recorded here and suppresses the DETECT
      // arm's emit below: whoever swept it already emitted the timeout event,
      // and a re-invocation re-emitting it would double-count one close.
      let preDecisionTimedOut = false;
      try {
        preDecisionTimedOut = store.get(runIdArg).extensions?.approval?.state === "timed-out";
      } catch {
        /* unreadable record — the pre-sweep above and submitDecision's own refusal arms report it */
      }

      const tDecide = Date.now();
      // The bundle invariant's LAST writer, wired exactly where the pause wired
      // it (runner.ts's port passes `bundleDir: runsDir`): the record
      // `submitDecision` writes is the one DF5.2 reads to authorize a PR, so a
      // decision over a bundle that no longer exists is refused at the last
      // moment it can be. The directory is the SAME chain the store resolved —
      // `resolveRunsDir(dir)`, i.e. `--dir`, else `$QDS_RUNS_DIR`, else
      // `.sandbox/runs` (run-record.ts's one resolver; harvest's invariant is
      // the bundle IS `<runsDir>/<runId>.bundle`). The annotation admits
      // `undefined` because that is the value that would make
      // `assertBundlePresent` SKIP silently — today's resolver is total and can
      // never produce it, but the fail-safe is spelled out rather than trusted:
      // that state is announced on stderr, never silent (round-9 V1).
      const decideBundleDir: string | undefined = deps?.store === undefined ? resolveRunsDir(dir) : deps.store.dir;
      if (decideBundleDir === undefined) {
        note("fleet: the harvested-bundle check is DISABLED for this decision — the records directory could not be resolved");
      }
      const outcome: DecisionOutcome = await submitDecision(
        { store, ...(decideBundleDir === undefined ? {} : { bundleDir: decideBundleDir }) },
        runIdArg,
        {
          decision,
          approverId: auth.approverId,
          // `--reason` is argv — up to ARG_MAX of anything, control characters and
          // lone surrogates included — and it is the one echoed value in this
          // block that reached the record raw while every neighbour went through
          // a cap (`runId` through `assertFleetRunId`, `state`/`reportId` through
          // `sanitizeLabel`, `--message` through a char ceiling). `MAX_REASON_CHARS`
          // is the gate's OWN constant, imported rather than re-typed, so the CLI
          // and `capText` cannot truncate to two different limits: at exactly the
          // bound `capText` finds nothing left to cut. `sanitizeLabel` also marks
          // its truncation with an ellipsis and repairs a pair sliced in half,
          // which a raw `slice` at either layer does not.
          reason: sanitizeLabel(flags.get("--reason") ?? "", MAX_REASON_CHARS),
          reportId: boundReportId,
        },
      );
      const decisionWaitMs = Date.now() - tDecide;

      // Each arm is mapped deliberately; see the comment on each.
      if (outcome.outcome === "report-changed") {
        // 5: a guard fired before anything was written. The approver read one
        // report and a rebind replaced it — they must re-read and decide again,
        // which is an action, not a retry of this identical invocation.
        printError(
          note,
          "approval-report-changed",
          `${runIdArg} was rebound to report ${sanitizeLabel(outcome.reportId, 128)} while this decision was being authenticated`,
          "re-read the run with `fleet status` and decide against the report it is bound to now",
          { runId: runIdArg, reportId: sanitizeLabel(outcome.reportId, 128) },
        );
        gateEvent("refused", runIdArg, { outcome: "report-changed", state: "awaiting-approval", decision_wait_ms: decisionWaitMs });
        return finish(requestId, verb, runIdArg, 5);
      }
      if (outcome.outcome === "not-decidable") {
        // 5, for the same reason: nothing was mutated and the payload names the
        // guard. `pausing` means the box may still be going down; `absent`
        // means this run never reached the gate.
        printError(
          note,
          "approval-not-decidable",
          `${runIdArg} is ${sanitizeLabel(outcome.state, 64)}, not awaiting approval`,
          outcome.state === "pausing"
            ? "the run is still being torn down for its pause — re-run reverify (`bun scripts/reverify.ts <run-id>`): it re-presents the bound report and finishes the promotion; `fleet status` reports `pausing` until then"
            : "only a run paused at the pre-PR gate can be decided; `fleet status` shows which are",
          { runId: runIdArg, state: sanitizeLabel(outcome.state, 64) },
        );
        // `state` is RECORD-controlled (a torn or hand-edited
        // `extensions.approval.state` rides `submitDecision`'s answer verbatim)
        // and this is a log field, so it gets the same cap its sibling
        // `printError` above applies — the file's rule for every echoed field
        // (A11); it was the one raw passthrough in the block.
        gateEvent("refused", runIdArg, { outcome: "not-decidable", state: sanitizeLabel(outcome.state, 64), decision_wait_ms: decisionWaitMs });
        return finish(requestId, verb, runIdArg, 5);
      }

      // BOTH remaining arms are SUCCESS. `already-decided` is AC2's idempotency
      // rule: the FIRST decision is returned and nothing changes. Exit 0
      // because the operator's intent — "this run is decided" — holds; a
      // refusal code would send automation back to retry a decision that can
      // never change, which is exactly what exit 1 `transient` means and is
      // never true here.
      //
      // `outcome: outcome.outcome`, never the literal the arm is named for.
      // The second arm is the `already-decided` arm SPELLED BY ITS FIELD — it
      // used to hardcode `"already-decided"` while `gateEvent` four lines down
      // logged the true value, so the line and the log could disagree. A guard
      // above now refuses any outcome that is neither `decided` nor
      // `already-decided`, so "read the field, don't guess it" is a guard and
      // not a courtesy: an outcome variant this build does not know cannot
      // reach the success line at all (see the refusal arm below).
      // INV-APPROVE-4's letter: a decision is logged with approverId,
      // timestamp, reason, runId and requestId. `reason` rode only the
      // `already-decided` arm before; the fresh decision carries it too now —
      // the SAME value `submitDecision` persisted, capped by the same helper
      // (`reason` is capped AGAIN here only because the one it went through in
      // approval-gate.ts is not exported and this line must never print an
      // unbounded argv echo).
      //
      // WHO THIS LINE ATTRIBUTES (round-9 B3/B4): the second arm echoes the
      // STORED decision — and on the expired path `submitDecision`'s sweep has
      // just persisted `approverId: "system:timeout"`, the machine actor the
      // INV-APPROVE-4 reservation mints. Printing it under a HUMAN verb's
      // event attributed to a machine a decision no human made; the event
      // carries the INVOKING approver (`auth.approverId`, the id this
      // invocation authenticated) and the STORED decision's own state rides
      // beside it as `decisionState`, so neither fact is lost or conflated.
      // The completion line keeps the stored values verbatim — it IS the
      // record's answer, and `outcome.state`'s other consumers key on it.
      // Every echoed field is capped through `sanitizeLabel`/the same 128-char
      // bound the sibling arms use: a record is operator-writable disk, and an
      // uncapped hand-edited `reason`, `approverId` or `decidedAt` in it must
      // not blow the envelope or the log line this file caps everywhere else
      // (`decidedAt` is the record's own stamp, so it is capped like its
      // neighbours rather than trusted to be the 24-char ISO string a
      // well-behaved writer left).
      if (outcome.outcome !== "decided" && outcome.outcome !== "already-decided") {
        // The two refusal arms above returned, so a THIRD outcome here is a
        // `DecisionOutcome` variant this build does not know. It used to fall
        // into the settled-decision arm below: the operator read a JSON line
        // that looked answered and `finish` exited 0, while this same
        // invocation's gate event called the outcome an error — the two
        // streams disagreed about whether anything happened, on the verb whose
        // whole job is to say so. Unknown is refused, not guessed: nothing
        // here can say whether the record was written, so 5 (a guard fired;
        // nothing confirmed; a human must look before deciding again) and not
        // 1, whose "retry me" would invite a second decision against a record
        // that may already be terminal and immutable.
        const unrecognised = outcome as unknown as { outcome?: unknown; state?: unknown };
        printError(
          note,
          "decision-outcome-unrecognised",
          `${runIdArg} answered with an outcome this build does not know (${sanitizeLabel(String(unrecognised.outcome), 64)}) — nothing here can say whether the decision was recorded`,
          "run `fleet status` and read the record's approval extension by hand before deciding again; a newer fleet wrote an outcome this CLI cannot name",
          { runId: runIdArg, state: sanitizeLabel(String(unrecognised.state ?? ""), 64) },
        );
        gateEvent(
          verb === "approve" ? "approve" : "reject",
          runIdArg,
          { outcome: unrecognised.outcome, state: sanitizeLabel(String(unrecognised.state ?? ""), 64), decision_wait_ms: decisionWaitMs },
          false,
        );
        return finish(requestId, verb, runIdArg, 5);
      }
      // A28: the boundary race's DETECT arm. `already-decided` over a
      // `timed-out` record means a sweep persisted the timeout — this one's
      // internal sweep (the record was `awaiting-approval` until it ran, or the
      // pre-sweep above would have answered already) — and the pre-sweep missed
      // it, so the invocation would exit 0 with a decision line and NO
      // `event:"timeout"` row, the one thing the observability contract keys
      // the window's close on. Emit it here, idempotently: the producer arm's
      // flag makes a normal expired run (pre-sweep fired, decision refused over
      // the same timed-out record) a no-op, `preDecisionTimedOut` makes a
      // RE-invocation over an already-swept record one too (R4-7), and
      // `sweptHere` — the gate engine's mark on the one outcome whose sweep
      // did the persisting (round-5 BS-3) — makes the emit AT-MOST-ONCE across
      // concurrent invocations, not just within one: two decisions racing the
      // boundary both used to answer `already-decided` over the same
      // freshly-timed-out record and both logged the close. Only the flipper
      // carries the flag now; the window is closed and announced exactly once.
      // `decision_wait_ms`'s window is the closest bound on when the internal
      // sweep ran, but it is NOT the sweep's cost, so it rides this arm's OWN
      // field `expiry_detect_wait_ms` (R4-6): `expiry_sweep_ms` stays the
      // sweep's measured cost (the producer arm above) and a dashboard reading
      // it never compares a wait against a spend. Neither the exit code nor
      // the envelope changes.
      // ABOVE `const line` deliberately: the timeout event is not the decision
      // event, and the shape pin below (gate-verbs "never the literal its arm
      // is named for") rightly forbids an `outcome:` literal inside the
      // decision block that constructs the line and its event.
      if (
        outcome.outcome === "already-decided" &&
        outcome.state === "timed-out" &&
        outcome.sweptHere === true &&
        !timeoutEmitted &&
        !preDecisionTimedOut
      ) {
        gateEvent("timeout", runIdArg, {
          outcome: "timed-out",
          state: "timed-out",
          expiry_detect_wait_ms: decisionWaitMs,
        });
        timeoutEmitted = true;
      }
      const line =
        outcome.outcome === "decided"
          ? {
              runId: runIdArg,
              outcome: outcome.outcome,
              state: sanitizeLabel(outcome.state, 64),
              approverId: sanitizeLabel(outcome.approverId, 128),
              decidedAt: sanitizeLabel(outcome.decidedAt, 64),
              reason: sanitizeLabel(flags.get("--reason") ?? "", MAX_REASON_CHARS),
            }
          : {
              runId: runIdArg,
              outcome: outcome.outcome,
              state: sanitizeLabel(outcome.state, 64),
              approverId: sanitizeLabel(outcome.approverId, 128),
              decidedAt: sanitizeLabel(outcome.decidedAt, 64),
              reason: sanitizeLabel(outcome.reason, MAX_REASON_CHARS),
            };
      // Through `reportCompletion`: the decision is ALREADY RECORDED, so a lost
      // line is 6 ("landed, needs an operator"), never a retryable 1 that would
      // invite a second decision against a closed record.
      //
      // `outputIncomplete()` folds the EAGAIN-truncated case into the same
      // posture: `reportCompletion` answers true when the line's write itself
      // succeeded, but an fd 1 left non-blocking can still have eaten part of
      // it — `finish` exits 6 for exactly that, so the event beside it must
      // not claim "ok" (round-9 B5).
      const printed = reportCompletion([`${JSON.stringify(line)}\n`]) && !outputIncomplete();
      // AFTER the print, so the event's `status` can tell the truth: these
      // outcomes are in GATE_OK_OUTCOMES, but a lost line exits 6 and must not
      // log "ok" (see the set's header comment).
      gateEvent(
        verb === "approve" ? "approve" : "reject",
        runIdArg,
        {
          outcome: outcome.outcome,
          state: line.state,
          // The INVOKING approver, never the stored decision's. On
          // `already-decided` the stored id is the FIRST decision's (or
          // `system:timeout` after a sweep); a human verb's audit line must
          // name the human who ran it. The stored id is not lost — the line
          // beside this event carries it verbatim.
          approverId: sanitizeLabel(auth.approverId, 128),
          // The STORED record's state, named on its own key. On every outcome
          // this arm can produce today it equals `state` above — the expired
          // case arrives as `already-decided` over a `timed-out` record, and
          // that is what both carry — but `state` is this event's shared
          // vocabulary and `outcome`'s label varies; this is the slot that
          // says "the persisted approval record is in THIS state" without
          // overloading either field's meaning if a future outcome splits
          // them (round-9 DEC1).
          decisionState: sanitizeLabel(outcome.state, 64),
          decision_wait_ms: decisionWaitMs,
          // Same key and value as the line beside it, so the two streams join
          // on the reason as well as the run (INV-APPROVE-4's letter).
          reason: line.reason,
        },
        printed,
      );
      return finish(requestId, verb, runIdArg, printed ? 0 : 6);
    } catch (e) {
      // `state: "unknown"`, like the other catch arms: a throw that skipped
      // every observing arm has no state to name, and the PauseCtx default is
      // the file's vocabulary for exactly that (round-9 B7). Usage refusals
      // are excluded above — see `isUsageRefusal`.
      if (!isUsageRefusal(e)) gateEvent("refused", runIdArg, { outcome: "error", state: "unknown" });
      return finish(requestId, verb, runIdArg, reportCode(note, e));
    }
  }

  // ── enrol (DF3.4 deferred item D9) ──────────────────────────────────────────
  //
  // The writer the allowlist never had. D9's finding was that nothing enforced
  // the "tokens are high-entropy and machine-minted" assumption its LOW rating
  // depends on — because nothing MINTED them: the file was hand-authored JSON.
  // A length rule on an operator-supplied token would not have been the property
  // either (length is not entropy). Minting it is.
  if (verb === "enrol") {
    try {
      if (positionals.length > 1) {
        throw usageError("enrol takes no positional arguments", "fleet enrol --approver <id> [--rotate]");
      }
      const approverId = flags.get("--approver")?.trim();
      if (approverId === undefined || approverId === "") {
        throw usageError(
          "enrol requires --approver <id>",
          "pass the approver id to enrol; the token is MINTED by this verb and printed once — it is never supplied by you and never read from stdin",
        );
      }
      // `process.cwd()` — the SAME host root `fleet approve` authenticates
      // against (see the approve block's `authenticate` call). An enrolment that
      // resolved its allowlist differently from the verifier would write entries
      // nothing ever reads.
      //
      // `--rotate` is passed THROUGH, explicitly: the flag used to be parsed
      // and then dropped on the floor, which made the refusal remediations that
      // name it ("pass --rotate", "re-run with --rotate") unactionable — the
      // re-run took the identical non-rotate path and refused again. The
      // allowlist path is the writer's own default, named here so the options
      // argument has a positional to sit behind.
      //
      // `--dir` is passed through the same way (round-9 C10): the registry
      // declares it on `enrol` with approve's exact meaning — the ALLOWLIST's
      // root — and the writer resolves `opts.dir` over `hostRoot`. Threading it
      // is what makes the declaration true; a parsed-and-dropped flag is the
      // dead-flag posture this file's `--rotate` history documents above.
      // Omitted ⇒ `undefined`, and the writer keeps its `process.cwd()` root.
      //
      // NOTE THE ASYMMETRY with approve, where the same flag is DUAL-purpose:
      // there `--dir` is both the allowlist root (the `authenticate` call
      // below) AND the runs directory (`resolveRunsDir`/`storeOpts`, so the
      // record and bundle are read from it too). Here it is allowlist-only —
      // enrol never touches a run record. An operator who passes one path to
      // both verbs gets the allowlist they asked for on both, but approve will
      // also read its RUN RECORD from that path; the registry note on each
      // verb's `--dir` is where that has to be spelled out for `--help`.
      // F7: `--out <file>` — the out-of-band channel the paragraph below admits
      // the token does not have. Checked BEFORE anything is minted, so the
      // refusal is the truthful "nothing was mutated" 5: the allowlist path is
      // resolved exactly the way the writer resolves it (`readGuardedFile`'s
      // `resolve(root, file)`, with the same root choice — `--dir`, else the
      // cwd). Keep the two spellings in step if either moves.
      const outPath = flags.get("--out");
      if (outPath !== undefined && resolvePath(outPath) === resolvePath(dir ?? process.cwd(), DEFAULT_APPROVERS_FILE)) {
        printError(
          note,
          "approver-out-is-allowlist",
          `--out ${bounded(outPath)} is the allowlist itself — the minted token would overwrite every enrolled entry`,
          "pass a path OUTSIDE the allowlist: it holds only scrypt HASHES, and --out is where the one plaintext that verifies against them is written",
          { approverId: sanitizeLabel(approverId, 128) },
        );
        return finish(requestId, verb, runIdArg, 5);
      }
      const enrolled = (deps?.enrol ?? enrolApprover)(process.cwd(), approverId, DEFAULT_APPROVERS_FILE, {
        rotate: bools.has("--rotate"),
        dir,
      });
      if (!enrolled.ok) {
        // 5 for every arm: a guard fired and the allowlist was not modified.
        printError(note, enrolled.refusal.code, enrolled.refusal.message, enrolled.refusal.remediation, {
          approverId: sanitizeLabel(approverId, 128),
        });
        return finish(requestId, verb, runIdArg, 5);
      }
      // THE TOKEN IS PRINTED ONCE, HERE, AND NOWHERE ELSE. It is not logged, not
      // put on the gate event, and not echoed into any refusal — the whole point
      // of minting it is that only the operator's clipboard ever holds it. It
      // also reaches stdout RAW, on purpose: no redactor composes the
      // completion writer (`emit` → `writeAll(1, …)`, which passes bytes
      // through; `redactSecrets` runs only in `report`/`printError`'s refusal
      // envelopes), so a REDACTED placeholder can never be minted in its place
      // — an unusable credential that still looks minted would be worse than an
      // exposed one. The price is real: stdout is a captured channel (CI logs,
      // `tee`, shell history of the command that read it), so whoever can read
      // this invocation's stdout holds a live approver credential. Until the
      // token has an out-of-band channel, treat enrolment output as secret.
      // `--out` IS that channel: the SAME JSON goes to a 0600 file and stdout
      // gets a confirmation line that names the file and carries no token.
      // `reportCompletion`, because losing this line loses the credential: the
      // entry is already on disk, so a dropped line is exit 6 with an operator
      // action (`--rotate`), never a retryable 1 that would suggest re-running
      // and getting the same already-enrolled refusal.
      //
      // `&& !outputIncomplete()` is the sibling rule (approve/unlock/attach):
      // `reportCompletion` answers true when the line's write itself succeeded,
      // but an fd 1 left non-blocking can still have eaten part of it — and a
      // TRUNCATED token is worse than a lost one, because the operator pastes a
      // half-credential that verifies nothing and reads as a success. Exit 6,
      // never 0, when stdout did not take the whole line.
      const tokenLine = `${JSON.stringify({
        approverId: enrolled.approverId,
        token: enrolled.token,
        allowlist: enrolled.path,
        replaced: enrolled.replaced,
        kdf: "scrypt",
      })}\n`;
      // Mode 0600 — one open, one write, one close, and the mode is PINNED
      // afterwards: `open`'s mode argument applies only at creation, so a
      // pre-existing 0644 file would keep it and hold a live credential looser
      // than the allowlist it verifies against.
      //
      // The open does NOT truncate (`"r+"`, creating exclusively only when the
      // file is absent): `notThisFile` carries the allowlist's inode identity,
      // and it must be checked against the OPEN DESCRIPTOR before any byte of
      // the target is destroyed (A9). An `O_TRUNC` open follows a symlink, a
      // hardlink, or a case/NFC alias straight into the allowlist — the lexical
      // guard up in the flag block cannot see those, and by the time this
      // function could have compared strings the file was already gone. The
      // identity check happens after the open and before the truncate, which
      // also closes the check-then-write TOCTOU: the fd IS the inode written.
      const writeTokenFile = (
        target: string,
        line: string,
        notThisFile: { dev: number; ino: number } | undefined,
      ): { ok: true } | { ok: false; problem: string } => {
        let fd: number | undefined;
        // True once the target's prior contents are gone (truncated here) or
        // the file is one this call created: a failure past that point leaves a
        // HALF token at the path — plausible-looking, mode 0600, verifies
        // nothing — so the catch unlinks it rather than leave the trap (A10).
        // A failure BEFORE the truncate leaves a pre-existing file intact, and
        // no unlink: this call never owned those bytes.
        let destroyedOrCreated = false;
        // The inode THIS call opened, captured from the descriptor the moment
        // it exists: the failure-path unlink is only entitled to remove what
        // this call wrote, so the path is re-proved against it first (A10's
        // ownership rule, applied to the removal).
        let opened: { dev: number; ino: number } | undefined;
        try {
          try {
            fd = openSync(target, "r+");
          } catch (e) {
            if ((e as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw e;
            // Absent: create exclusively, so a racing writer cannot put an
            // inode under the identity check that the open did not resolve.
            fd = openSync(target, "wx", 0o600);
            destroyedOrCreated = true;
          }
          const fst = fstatSync(fd);
          opened = { dev: fst.dev, ino: fst.ino };
          if (notThisFile !== undefined) {
            const fst = fstatSync(fd);
            if (fst.dev === notThisFile.dev && fst.ino === notThisFile.ino) {
              return {
                ok: false,
                problem: "the --out path resolves to the allowlist itself (a symlink or alias) — the allowlist is intact and was NOT overwritten",
              };
            }
          }
          fchmodSync(fd, 0o600);
          ftruncateSync(fd, 0);
          destroyedOrCreated = true;
          writeAll(fd, line);
          return { ok: true };
        } catch (e) {
          if (destroyedOrCreated) {
            // Unlink only the inode this call opened: a racing writer can put
            // a fresh file at the path between the failed write and this
            // removal, and a path-named unlink would destroy a token this
            // call never minted.
            let ours = false;
            try {
              const now = statSync(target);
              ours = opened !== undefined && now.dev === opened.dev && now.ino === opened.ino;
            } catch {
              /* already gone — nothing of ours left to remove */
            }
            if (ours) {
              try {
                unlinkSync(target);
              } catch {
                /* nothing left to remove, or already gone — the report below stands */
              }
            }
          }
          return { ok: false, problem: (e as Error)?.message ?? String(e) };
        } finally {
          if (fd !== undefined) {
            try {
              closeSync(fd);
            } catch {
              /* already closed */
            }
          }
        }
      };
      let printed: boolean;
      if (outPath === undefined) {
        printed = reportCompletion([tokenLine]) && !outputIncomplete();
        if (!printed) {
          printError(
            note,
            "approver-token-unprintable",
            `${enrolled.approverId} was enrolled in ${enrolled.path} but the minted token could not be written to stdout IN FULL, so it is LOST`,
            "re-run with --rotate to mint a replacement — the entry on disk verifies a token nobody now holds",
            { approverId: sanitizeLabel(enrolled.approverId, 128) },
          );
        }
      } else {
        // The allowlist the enrolment JUST wrote is the one file `--out` must
        // never be (A9): compare inodes, not spellings — the flag block's
        // lexical guard only catches the exact spelling, while a symlink, a
        // hardlink, or a case-insensitive/NFC alias resolve to the same file.
        // It can only be checked NOW, because a first enrolment is the write
        // that brings the allowlist into existence; `enrolled.path` is the
        // resolved path the writer itself used. Absent ⇒ nothing to protect
        // and the write below creates the target fresh.
        let allowlistIdentity: { dev: number; ino: number } | undefined;
        try {
          const ast = statSync(enrolled.path);
          allowlistIdentity = { dev: ast.dev, ino: ast.ino };
        } catch (e) {
          // Absent is the one state this write can proceed past — there is
          // nothing to protect and the target is created fresh. Any OTHER
          // stat failure leaves the allowlist's identity UNPROVABLE, and
          // unprovable is not vanished: `r+`-ing into an unverified inode
          // could truncate the allowlist itself through a symlink or alias
          // the lexical guard never saw. Refuse the write.
          if ((e as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
            printError(
              note,
              "approver-out-unverifiable",
              `${enrolled.approverId} was enrolled in ${enrolled.path}, but the allowlist's identity could not be verified (${sanitizeLabel((e as NodeJS.ErrnoException | null)?.code ?? (e as Error).message, 128)}), so the token cannot be written to ${bounded(outPath)} — writing without that proof could overwrite the allowlist itself, so it was NOT attempted and the token is LOST`,
              "re-run with --rotate and a writable --out — the entry on disk verifies a token nobody now holds",
              { approverId: sanitizeLabel(enrolled.approverId, 128) },
            );
            return finish(requestId, verb, runIdArg, 6);
          }
          /* the allowlist vanished between the enrolment and this write */
        }
        const wrote = writeTokenFile(outPath, tokenLine, allowlistIdentity);
        if (!wrote.ok) {
          // 6, not 5: the ENTRY landed, so "nothing was mutated" would be false,
          // and the credential is now held by nobody — the same posture as the
          // unprintable arm above, whose remedy is also `--rotate`.
          printError(
            note,
            "approver-token-unwritable",
            `${enrolled.approverId} was enrolled in ${enrolled.path} but the minted token could not be written to ${bounded(outPath)} (${sanitizeLabel(wrote.problem, 200)}), so it is LOST`,
            "re-run with --rotate and a writable --out — the entry on disk verifies a token nobody now holds",
            { approverId: sanitizeLabel(enrolled.approverId, 128) },
          );
          return finish(requestId, verb, runIdArg, 6);
        }
        printed =
          reportCompletion(
            [
              `${JSON.stringify({
                approverId: enrolled.approverId,
                allowlist: enrolled.path,
                writtenTo: outPath,
                replaced: enrolled.replaced,
              })}\n`,
            ],
            // The line that was lost named the file; the token itself is safe in
            // it, so the operator's next action is a read, never a re-mint.
            `the token WAS written to ${bounded(outPath)} — read it from there; do not re-run (the entry is already enrolled)`,
          ) && !outputIncomplete();
      }
      // No `gateEvent`: enrolment is not a gate event (it decides nothing about
      // a run), and the union's members each have exactly one producer.
      return finish(requestId, verb, runIdArg, printed ? 0 : 6);
    } catch (e) {
      return finish(requestId, verb, runIdArg, reportCode(note, e));
    }
  }

  // ── unlock (DF3.4 deferred item D11) ────────────────────────────────────────
  //
  // The operator remedy that pays for `withApprovalLock`'s strictness. The lock
  // now reclaims ONLY from a provably-dead holder, so a run whose holder pid was
  // recycled onto an unrelated live process wedges forever; before D11 an
  // invisible `age > 1h` door unwedged it by surrendering mutual exclusion on
  // the operator's behalf. This says the same thing out loud, on purpose, and
  // leaves a line in the log saying who said it.
  if (verb === "unlock") {
    try {
      if (positionals.length > 2) throw usageError("unlock takes exactly one <run-id>", "fleet unlock <run-id> [--force]");
      if (runIdArg === undefined) throw usageError("unlock requires <run-id>", "fleet unlock <run-id> [--force]");
      // RAW, not `bounded`: assertFleetRunId owns the echo bound and reports the
      // true length (the teardown call site's reasoning).
      assertFleetRunId(runIdArg);
      // NO assertDriverChosen — `approve`'s precedent: this verb touches one
      // lock file and no box, so the fake-driver hazard cannot arise, and the
      // registry declares no --driver for `parseArgv` to accept.
      assertRecordsDirUsable(dir, deps?.store);
      // READ-MODE, like attach: this writes nothing to any RECORD (it removes a
      // lock file beside them), so the writable construction's chmod, temp sweep
      // and O_EXCL probe would be bought for nothing. The record read below
      // requires it to be there already. The fresh host gets `readOnlyStore`'s
      // bootstrap remediation (round-9 B10).
      const store = deps?.store ?? readOnlyStore();

      // ONE refusal envelope for every way this verb refuses, and ONE exit
      // code with it. The record read and the reclaim are the two things that
      // can refuse, and a caller who holds no lock — which on this verb is
      // EVERY caller, because `unlock` authenticates nobody BY DESIGN (the
      // registry's ruling: anyone who can reach the runs directory can already
      // `rm` the lock) — could otherwise separate "no such run" (exit 4,
      // `run-not-found`) from "that run exists and its holder is alive" (exit
      // 5, holder pid and age) and enumerate run ids without ever touching a
      // lock. That is the exact oracle round 9 closed for approve/reject by
      // deferring existence past authentication; this verb has no
      // authentication to defer past, so the observable results are made
      // uniform instead: same envelope, same exit code, and the TRUE reason
      // travels only in the gate event beside it. The record is still read
      // BEFORE the lock is touched — a missing record must never be answered
      // by removing a lock file, and an unreadable record is exactly the case
      // where the id is unverified.
      // `forced: false` on this arm is a PINNED semantic (F5.35), not drift:
      // `forced` names an override that HAPPENED, and a refused invocation
      // reclaimed nothing — so no override happened, whatever the operator
      // typed. Round-3 A29's "carry the flag into the refusals" ask is the
      // test wave's to re-litigate; the gate event's `detail` below still
      // carries the true reason.
      const unlockRefused = (detail: Record<string, unknown>): void => {
        printError(
          note,
          "unlock-refused",
          `${runIdArg} cannot be unlocked: this invocation could not confirm the run's approval lock is free to take`,
          "read this invocation's gate event for the true reason (a missing or unreadable run record, or a lock holder that cannot be proven dead) and check `fleet status` before re-running with --force",
          { runId: runIdArg },
        );
        gateEvent("unlock", runIdArg, { ...detail, forced: false });
      };

      let recFailure: unknown;
      try {
        // `getRecord`, not a bare `store.get`: it is the ONE classifier for a
        // record read (`store.get` throws plain Errors whose only absence mark
        // is an errno), so the gate event below names `run-not-found` versus
        // `record-read-failed` by the same rule harvest/teardown and
        // `assertRunExists` use — classified by typed code, never by message.
        const rec = getRecord({ store }, runIdArg);
        // `?? ""` — approve's guard. A record is operator-writable disk, so
        // `requestId: null` is reachable by hand, and `sanitizeLabel` throws on
        // a non-string: that throw would land AFTER the lock was reclaimed and
        // then AGAIN inside this verb's catch (`gateEvent` builds its entry
        // outside its own try), exiting as an unhandled crash. An empty join
        // key is omitted from the event instead of printed.
        gateDispatchRequestId = rec.requestId ?? "";
      } catch (e) {
        recFailure = e;
      }
      if (recFailure !== undefined) {
        unlockRefused({
          outcome: (recFailure as HarvestError | null)?.code === "no-record" ? "run-not-found" : "record-read-failed",
          state: "unknown",
        });
        return finish(requestId, verb, runIdArg, 5);
      }

      // WHAT ACTUALLY HAPPENED, not what the successor's lock looks like: a
      // forced reclaim is THIS invocation having used `--force` to take a lock
      // the host could not prove dead. Derived from the invocation's own flag
      // rather than from `res.holder`, because on the `changed` outcome the
      // reported holder describes the SUCCESSOR's lock — reading forced-ness
      // out of it logged a human override that never happened, which is the
      // one audit fact D11 exists to keep honest. (The F5.35 pin requires this
      // derivation to appear EXACTLY ONCE in the block and to feed both the
      // reclaim call and the event echoes; the refused arm's `forced: false`
      // above is deliberate — nothing was reclaimed, so no override happened.)
      const forced = bools.has("--force");
      const res = reclaimApprovalLock(store.dir, runIdArg, forced);
      if (res.outcome === "refused") {
        // 5: a guard fired and nothing was mutated. WHICH pid and HOW OLD —
        // the evidence the force decision needs — went into the gate event,
        // not into this envelope: the envelope is the one caller-facing line
        // an id-enumerating caller can diff, so it stays identical to the
        // missing-record refusal above. `holderPid` is a number by
        // construction (`lockHolderPid` admits digits only), so it is echoed
        // as a JSON number and never interpolated into a shell command here.
        unlockRefused({
          outcome: "approval-lock-holder-not-dead",
          state: res.holder,
          lock_age_ms: res.ageMs,
          ...(res.holderPid === undefined ? {} : { holderPid: res.holderPid }),
        });
        return finish(requestId, verb, runIdArg, 5);
      }

      // Through `reportCompletion`: the lock is ALREADY GONE by the time this
      // prints, so a lost line must not read as "nothing happened" — the same
      // reasoning approve's decision line uses. 6, never 1: the work landed and
      // re-running is a no-op that reports `absent`. Folded with
      // `outputIncomplete()` for the same EAGAIN reason approve's arm is
      // (round-9 B5).
      const printed = reportCompletion([
        `${JSON.stringify({
          runId: runIdArg,
          outcome: res.outcome,
          ...(res.outcome === "absent" ? {} : { holder: res.holder, forced }),
        })}\n`,
      ]) && !outputIncomplete();
      // `absent` is a SUCCESS, not a soft failure: this verb's contract is "this
      // run is not wedged on its approval lock when you are done", and a run
      // with no lock already satisfies it. Reporting it as an error would train
      // operators to treat the healthy answer as something to investigate.
      // Emitted after the print, so a lost completion line (exit 6) degrades
      // the event's `status` to "error" instead of claiming "ok".
      gateEvent(
        "unlock",
        runIdArg,
        {
          outcome: res.outcome,
          ...(res.outcome === "absent"
            ? { state: "absent" }
            : {
                state: res.holder,
                lock_age_ms: res.ageMs,
                ...(res.holderPid === undefined ? {} : { holderPid: res.holderPid }),
                // The audit fact D11 exists to create: a reclaim from a holder
                // that was NOT provably dead happened because a human said so.
                // This invocation's own flag, not the holder status — see the
                // `forced` derivation above.
                forced,
              }),
        },
        printed,
      );
      return finish(requestId, verb, runIdArg, printed ? 0 : 6);
    } catch (e) {
      // The OTHER gate verbs' catches emit; unlock's did not, so an untyped
      // throw here — a corrupt lock file, a store fault — left the one verb
      // whose whole job is the audit trail with NO line in it (round-9 B6).
      // `state: "unknown"`: nothing was read, so nothing was observed.
      if (!isUsageRefusal(e)) gateEvent("unlock", runIdArg, { outcome: "error", state: "unknown" });
      return finish(requestId, verb, runIdArg, reportCode(note, e));
    }
  }

  // ── attach (DF3.4, steering front door) ─────────────────────────────────────
  if (verb === "attach") {
    try {
      if (positionals.length > 2) throw usageError("attach takes exactly one <run-id>", "fleet attach <run-id> --driver <name> [--message <text>]");
      if (runIdArg === undefined) throw usageError("attach requires <run-id>", "fleet attach <run-id> --driver <name> [--message <text>]");
      assertFleetRunId(runIdArg);
      // At the TOP, before any store is constructed: attach reaches INTO the
      // box over the driver port, so it must never default one — and a refusal
      // here has touched nothing (harvest/teardown's placement, fleet.ts:2331).
      assertDriverChosen("attach", driverName, deps?.driver);
      const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId, runId: runIdArg }));
      assertRecordsDirUsable(dir, deps?.store);
      // ONE store, READ-MODE unconditionally. Unlike approve/reject, attach
      // WRITES NOTHING to the record — `attachToRun` only reads it to find the
      // box and the approval state — so the writable second construction
      // harvest/teardown needs would buy a chmod and a temp sweep for nothing.
      // `create: dir === undefined` used to exempt the DEFAULT records dir from
      // that reasoning, which is exactly backwards: the default dir is the one
      // an operator never named and is the one this verb has the least business
      // chmod'ing 0700, sweeping temps in, or probing for O_EXCL. `assertRunExists`
      // on the next line already requires the record to be THERE, so nothing
      // downstream needs a directory this store could have created. The fresh
      // host gets `readOnlyStore`'s bootstrap remediation (round-9 B10).
      const store = deps?.store ?? readOnlyStore();
      assertRunExists(store, runIdArg);

      // `--message <text>` inline; absent or `-` reads stdin (the story's AC5
      // shape), so operator text never has to survive a shell's quoting.
      const messageFlag = flags.get("--message");
      // A TTY on fd 0 means the operator typed the verb and piped NOTHING: the
      // read below would park for the whole stall window and only then refuse,
      // while the terminal — in canonical mode, echo on — puts everything they
      // type in the meantime into their scrollback. Refuse up front instead.
      // This is `ingestBriefJson`'s posture on the same fd for the same reason
      // (see its `process.stdin.isTTY` arm); it is `isTTY` and not fd 0's TYPE
      // because a chardev fd 0 is /dev/null under cron or systemd, where the
      // bounded read is the RIGHT behaviour — only an interactive terminal both
      // hangs and echoes.
      if ((messageFlag === undefined || messageFlag === "-") && process.stdin.isTTY) {
        throw usageError("no message on stdin", "pass `--message <text>`, or pipe the message in");
      }
      // One reader, `readCappedStdin`, labelled MESSAGE_INTAKE: its 64 KiB cap
      // sits far above the 4_000-char ceiling checked just below, so the
      // ceiling is what normally binds — but the cap and the stall window can
      // still fire first, and the label is what makes those two name
      // `--message` rather than the `--brief` this verb does not declare.
      // Trimmed on BOTH paths: a redirected file arrives with a trailing
      // newline, and an inline `--message "   "` is not a steering directive
      // either — an all-whitespace message must be refused, never queued.
      const message = (
        messageFlag === undefined || messageFlag === "-" ? await readCappedStdin(MESSAGE_INTAKE) : messageFlag
      ).trim();
      if (message === "") {
        throw usageError("attach requires a message", "pass `--message <text>`, or pipe the message on stdin");
      }
      // Mirrored from `attachToRun`'s own guard — the SAME measurement
      // (`sanitizeForMessage` length, which is what the fold's cap measures)
      // against the SAME imported constant — so the CLI refuses exactly the
      // messages the library refuses, with a usage envelope naming the flag.
      // Sanitizing EXPANDS (a newline becomes 2 chars, \x7f and the C1/U+2028
      // range 6), so a raw-length check waves an escape-heavy message through
      // to be silently truncated at the fold while the operator reads
      // `attach-acked`. `ATTACH_MESSAGE_CHAR_CEILING`, never
      // `DIRECTIVE_TEXT_CHAR_CEILING` — steering.ts declares the two equal
      // today by coincidence, not by contract.
      const messageChars = sanitizeForMessage(message).length;
      if (messageChars > ATTACH_MESSAGE_CHAR_CEILING) {
        throw usageError(
          `--message is ${messageChars} chars once escaped, over the ${ATTACH_MESSAGE_CHAR_CEILING}-char ceiling`,
          "shorten the message — steering guidance is a directive, not a document",
        );
      }

      const tAttach = Date.now();
      const res = await attachToRun({ driver, store }, runIdArg, message, deps?.attachOptions ?? {});
      const attachRttMs = Date.now() - tAttach;
      // Unreachable from argv — the pre-check above measures the identical
      // quantity against the same constant — but an embedder that skipped the
      // pre-check lands here, and the success path below would print this arm
      // exit-0 with `state: "attached"` while nothing was ever queued. Refuse
      // exactly as the pre-check does (the catch renders it like every other
      // usage refusal in this block).
      if (res.outcome === "message-over-ceiling") {
        throw usageError(
          `--message is ${res.messageChars} chars once escaped, over the ${res.ceilingChars}-char ceiling`,
          "shorten the message — steering guidance is a directive, not a document",
        );
      }
      // Same join key the completion line below prints, set BEFORE the event so
      // both carry it. `attachToRun` reads it off the run record — and the
      // `run-not-attachable` arm carries none, because it refuses on the record
      // read itself. Omitted there rather than invented.
      if (res.outcome !== "run-not-attachable") gateDispatchRequestId = res.requestId;
      // A closure because the call sites need the same fields at different
      // TIMES: `run-not-attachable` returns before a completion line exists,
      // and the other two arms emit after `reportCompletion` answers — so an
      // `attach-acked` whose line was lost (exit 6) logs "error", never "ok"
      // (see GATE_OK_OUTCOMES's header comment).
      const attachEvent = (printed = true): void =>
        gateEvent(
          "attach",
          runIdArg,
          {
            outcome: res.outcome,
            state: res.outcome === "run-not-attachable" ? res.state : "attached",
            attach_rtt_ms: attachRttMs,
            // WHY it was not acked, not just THAT it was not. `attach-not-acked` is
            // one outcome over four transport faults with four different fixes, so a
            // dashboard keyed on `outcome` alone cannot tell a resident that is
            // merely slow from a box that has stopped answering. Only present on the
            // arm that has one — `attach-acked` and `run-not-attachable` carry none.
            ...(res.outcome === "attach-not-acked" ? { reason: res.reason } : {}),
          },
          printed,
        );

      if (res.outcome === "run-not-attachable") {
        // `false`, not the default: this arm returns BEFORE any completion line
        // exists, so `printed: true` would claim a line reached stdout that was
        // never written (A13). The event still logs status "error" — the
        // outcome is not in GATE_OK_OUTCOMES — but the parameter now says what
        // actually happened on the stream.
        attachEvent(false);
        // 5: refused before anything was queued (attachToRun checks the record
        // BEFORE it writes to the inbox), so the box and the record are
        // untouched and the payload names which guard fired.
        printError(
          note,
          "run-not-attachable",
          `${runIdArg} cannot take a steering message: it is ${sanitizeLabel(res.state, 64)}`,
          // THREE-WAY, because `run-not-attachable` is no longer only the two
          // paused states. `attachToRun` refuses EVERY approval state plus any
          // record carrying `closedAt` — `requestApproval` tears the box down
          // BEFORE it promotes, so `approved`, `rejected`, `timed-out` and
          // `closed` are all strictly after that teardown. A two-way `else` sent
          // every one of those operators to `fleet approve`/`fleet reject` for a
          // run that is already decided or already over: an instruction that
          // cannot be carried out, on the verb whose whole job is to say what to
          // do next. The PAUSED arm asserts nothing about the box: a stranded
          // pause (a crash between registration and promotion) leaves the box
          // record OPEN and `fleet status` may well report it alive, so "its
          // box is gone" was a claim this verb never observed (round-9 E4/B12).
          res.state === "no-box"
            ? "this run has no box recorded — steering reaches a LIVE resident agent only"
            : res.state === "pausing" || res.state === "awaiting-approval"
              ? "the run is paused at the approval gate — decide it with `fleet approve`/`fleet reject` instead"
              : // Inspect-first for anything the three named arms do not cover:
                // `approved`/`rejected`/`timed-out`/`closed` are all strictly
                // AFTER requestApproval's teardown, so "the run is over" is
                // established for THOSE — but an unknown state string is
                // evidence of nothing, and asserting a torn-down box there was
                // a claim, not an observation. `fleet status` is the check.
                res.state === "approved" || res.state === "rejected" || res.state === "timed-out" || res.state === "closed"
                ? "this run is over and its box was torn down — steering reaches a LIVE resident agent only; dispatch a new run to act on this guidance"
                : `this run reports the state "${sanitizeLabel(res.state, 64)}", which takes no steering — run \`fleet status ${runIdArg}\` and inspect the box before acting`,
          { runId: runIdArg, state: sanitizeLabel(res.state, 64) },
        );
        return finish(requestId, verb, runIdArg, 5);
      }
      // Spelled out rather than spread. `res.requestId` is the RUN RECORD's
      // DISPATCH request id, and every other `requestId` this CLI emits — the
      // `gateEvent` four lines up, `logVerb`'s invocation line — is THIS
      // invocation's own. Two different identifiers under one key name, in one
      // verb's output, is a correlation bug waiting for whoever joins the two
      // streams; `dispatchRequestId` says which one it is. `messageId` goes
      // through `sanitizeLabel` for the same reason the `attach-not-acked`
      // envelope below already does — it is a value operators copy out of a
      // terminal, and a spread put it there raw.
      // `outputIncomplete()` folded in like approve/unlock's arms: a message
      // whose ack ceiling elapsed and whose messageId line was EAGAIN-truncated
      // must not log the event "ok" — `finish` exits 6 and the event agrees
      // (round-9 B5).
      const printed = reportCompletion([
        `${JSON.stringify({
          runId: runIdArg,
          outcome: res.outcome,
          messageId: sanitizeLabel(res.messageId, 128),
          ...(res.requestId === undefined ? {} : { dispatchRequestId: sanitizeLabel(res.requestId, 128) }),
        })}\n`,
      ]) && !outputIncomplete();
      attachEvent(printed);
      if (res.outcome === "attach-not-acked") {
        // 6, NOT 1, on EVERY reason. The exit code is the operator posture and
        // it is the same for all four — the message may already be in the box,
        // so a retry (which mints a NEW messageId, defeating the one dedupe key
        // this design rests on) double-delivers the guidance. What differs is
        // the REMEDIATION, and printing the `no-ack` one for all four told an
        // operator whose box was destroyed, or whose send failed outright, that
        // "the message IS queued in the box" — false, and it sends them looking
        // at a resident agent that is not the problem.
        const remediation =
          res.reason === "send-failed"
            ? // The send itself failed or timed out. `withTimeout` is a HOST-side
              // deadline with no abort path into the box, and a non-zero `cat` can
              // follow a partial write, so this is genuinely "may or may not have
              // landed" — the only arm where the operator has to look first.
              `the send FAILED (${sanitizeLabel(res.detail ?? "no detail", 200)}) and the message may or may not have landed — check the box's inbox before re-sending; a re-send delivers it twice if it did`
            : res.reason === "acks-unreadable"
              ? // Corruption, not latency: the file is there and no line of it
                // parses, so waiting longer buys nothing.
                "the acks file in the box is CORRUPT, not late — repair or remove it; the message itself is queued and needs no re-send"
              : res.reason === "box-unreachable"
                ? // The box declined to answer at all. Nothing here is evidence
                  // about the file, or about the resident.
                  "the box did not answer the ack read — verify it still exists (`fleet status`) before re-sending; a re-send delivers the message twice if the first one landed"
                : res.reason === "no-ack"
                  ? // no-ack: the append SUCCEEDED (send-failed returned
                    // above), so the append is established — but the engine
                    // now runs IN the box and should have acked within the
                    // ceiling, so its silence is a fault to investigate, not
                    // the system's shape (run dead, fold budget spent, box
                    // rebooted — a reboot wipes the queue and the run
                    // together, and nothing re-sends). One case is permanent:
                    // the engine leaves a message refused by
                    // ATTACH_FOLD_CHAR_BUDGET deliberately un-acked
                    // (steering.ts's fold arm), and for that one no amount of
                    // waiting or re-sending ever produces an ack.
                    "the message WAS appended to the box's inbox, but the in-box engine did not ack it within the ceiling — a fault to investigate, not the system's shape: is the run still live, is the steering fold budget exhausted, did the box reboot (a reboot wipes the queue with the run and nothing re-sends, so the append is established but the queue's survival is not). A re-send mints a fresh messageId — the dedupe key cannot catch it — so the guidance is delivered twice; a fold-budget refusal is left un-acked ON PURPOSE and a re-send cannot help"
                  : // A reason this build does not know: NOTHING is established
                    // about where the message or the ack got to, and guessing
                    // was the exact defect this arm's prose fixed for the four
                    // known reasons. Point at the evidence, not at a story.
                    `unrecognised ack outcome (${sanitizeLabel(res.reason, 32)}) — run \`fleet status ${runIdArg}\`, inspect the box's inbox and acks files, and treat the message as possibly delivered before re-sending (a re-send delivers it twice)`;
        printError(
          note,
          "attach-not-acked",
          `${runIdArg} was sent the message but did not ack it within the ceiling (${sanitizeLabel(res.reason, 32)})`,
          remediation,
          { runId: runIdArg, messageId: sanitizeLabel(res.messageId, 128), reason: sanitizeLabel(res.reason, 32) },
        );
        return finish(requestId, verb, runIdArg, 6);
      }
      return finish(requestId, verb, runIdArg, printed ? 0 : 6);
    } catch (e) {
      // `state: "unknown"` for the same reason the approve/reject catch names
      // it (round-9 B7), and NO event at all for a usage refusal: a missing
      // --message is argv being wrong, not a gate outcome — attach used to be
      // the ONE verb that logged operator typos into the alerting stream
      // (round-9 DEC2).
      if (!isUsageRefusal(e)) gateEvent("attach", runIdArg, { outcome: "error", state: "unknown" });
      return finish(requestId, verb, runIdArg, reportCode(note, e));
    }
  }

  // Unreachable through run(): `parseArgv` refuses any verb the registry does
  // not declare, and only the five gate verbs route here. An embedded caller
  // bypassing run() could still land on this line, and `Promise<number>`
  // forbids an implicit undefined — so name the invariant instead of tripping
  // over it.
  throw new Error(`runGateVerbs: verb ${verb} is not one of the gate verbs`);
}

/**
 * `fleet harvest` / `fleet teardown` (AC5: thin front doors onto DF2.5, guards
 * intact). The two verbs share every line of this scaffolding — grammar, driver,
 * the non-mutating record probe, the run lock, the CC-9 interrupt listeners and
 * the one cleanup-failure policy in the `finally` — and differ only in the arm
 * they run, which is why the split is `runHarvest`/`runTeardown` inside one
 * shared body rather than two copies of 190 lines.
 */
async function runDestructive(ctx: VerbCtx): Promise<number> {
  const { deps, verb, positionals, flags, dir, storeOpts, startedAt, note, finish, reportCompletion } = ctx;
  const runIdArg = positionals[1];
  const driverName = flags.get("--driver");
  const requestId = newRequestId();
  // Branded: the brand is the compile gate only — a hand-joined path string
  // does NOT get past it, while the runtime head check in teardownSandbox is
  // mere resolve-equality and would pass any string pointing at the same
  // .lock file. Possession is proven by the only sanctioned way to hold a
  // handle: having won acquireRunLock.
  let lock: RunLockHandle | undefined;
  /**
   * Did this invocation begin destroying the run and NOT finish — i.e. would
   * releasing the lock hand a half-torn-down run to the next invocation?
   *
   * The authoritative refusal lives in `releaseRunLock`, which now declines
   * while the lock is marked destructive (the CLI clears the mark on its
   * success path). This flag is the CLI's own side of the same fact, and it is
   * not redundant: it is what turns a throw mid-teardown into the ONE
   * diagnostic and exit code the operator should see, instead of the verb's
   * error followed by a second "could not release" line describing a refusal
   * this file asked for. It also keeps the two halves independently readable —
   * the run-lock module decides whether the lock may go, this decides what the
   * invocation REPORTS.
   */
  const state: DestructiveState = { destructiveInFlight: false };
  // The teardown verb's store, hoisted for the finally: the landed-check below
  // reads the run record AFTER `teardownSandbox` threw, and the block-scoped
  // `store` is out of reach there. Assigned only on the teardown/harvest/status
  // paths that can ever hold a destructive lock — undefined means "cannot
  // check", and the finally then holds the lock (fail-closed).
  let verbStore: RunRecordStore | undefined;
  /**
   * The verb's own CC-9 interrupt listeners (round 11), hoisted so the finally
   * below can remove them: empty until the lock is acquired, registered only
   * for the window where an interrupt would otherwise skip this block entirely
   * (run-lock's re-raise terminates the process before its finallys run).
   */
  let signalListeners: ReadonlyArray<readonly [NodeJS.Signals, () => void]> = [];
  // Assigned on every path, then possibly downgraded by the finally: a release
  // failure leaves the run locked against every later harvest/teardown while
  // the box and the key stay live, and `return 0` inside the try would have
  // committed the exit code before the cleanup could say so.
  let code: number;
  try {
    if (positionals.length > 2) {
      throw usageError(`${verb} takes exactly one <run-id>`, `fleet ${verb} <run-id>`);
    }
    if (runIdArg === undefined) {
      throw usageError(`${verb} requires <run-id>`, `fleet ${verb} <run-id>`);
    }
    // RAW, not `bounded`. The refusal ECHOES the id, and `fleet teardown
    // $(200KB)` must not put all of it in the envelope — but that bound now
    // lives in `assertFleetRunId`, which caps AND redacts the echo and reports
    // the true length. Capping first handed it a 108-char string to describe,
    // so the envelope carried two lengths that contradicted each other, and a
    // secret pasted into the run-id position could be cut across the 96-char
    // boundary into two halves neither redaction rule matches. One bound, at
    // the sink that owns the message. `bounded` still guards the LOG fields
    // below, which is a different stream with a different owner.
    assertFleetRunId(runIdArg);
    // Before the lock and before the record read: a refusal here has mutated
    // nothing, so there is no lock to release and no box left half-torn-down.
    assertDriverChosen(verb, driverName, deps?.driver);

    // R5: teardown/harvest create nothing. The create-time gates in
    // `exeDevDriverFromEnv` stay where they are — but held in front of THIS
    // verb they left an operator unable to clean up a box that was already
    // billing, reported as exit 2 = never retry. Degrades with a logged
    // warning naming what to fix before the next create.
    const driver = deps?.driver ?? asUsage(() => resolveCleanupDriver(driverName as string, { requestId, runId: runIdArg }));
    // Before the store is CONSTRUCTED, for the same reason the record probe
    // below is before the lock: this verb must not create the directory it was
    // asked to look in. See `assertRecordsDirUsable`.
    assertRecordsDirUsable(dir, deps?.store);
    // Round 11 (auditor F3 residual): the constructor used to be built WRITABLE
    // unconditionally, so `fleet teardown <typo> --dir /shared/existing` chmod'd
    // that operator-named directory to 0700 (and swept its stale temps) before
    // the exit-4 probe could refuse — mutating the thing a refused invocation
    // promised it had not touched. For a NAMED --dir the probe therefore reads
    // through a `create: false` view (status's exact treatment): it asserts the
    // directory is there without creating or re-permissioning anything. The
    // writable store is built AFTER the record is confirmed, when the directory
    // is one the run legitimately owns. The DEFAULT directory keeps the
    // writable bootstrap store — creating `.sandbox/runs` on first use is the
    // intended posture, and refusing it breaks every fresh checkout.
    let store: RunRecordStore =
      deps?.store ??
      asUsage(
        () =>
          new RunRecordStore({
            ...storeOpts,
            ...(dir === undefined ? {} : { create: false }),
            requestId,
          }),
      );
    verbStore = store;

    /** exit 4 for a genuine absence; every other read failure propagates. */
    const notFound = (e: unknown): never => {
      // Optional-chained (status.ts's form): a `throw null` must not become a
      // TypeError in the handler that is supposed to classify it — a genuinely
      // missing record would then surface as a retryable exit 1, not exit 4.
      if ((e as HarvestError | null)?.code === "no-record") {
        throw new FleetError(
          4,
          "run-not-found",
          `no run record for ${runIdArg}`,
          "check the id (fleet status) — nothing was mutated",
        );
      }
      // The shared classifier (harvest.ts getRecord) wraps every OTHER read
      // failure as a typed `record-read-failed`; it arrived here EXITING AS 1,
      // whose logVerb stamp is `transient` ("retry me") — and no retry heals a
      // corrupt record file. status.ts reaches the identical refusal through
      // FleetError (non-retryable), so this verb does too: 5 = "refused before
      // provisioning, payload names the guard" and nothing was mutated.
      if ((e as HarvestError | null)?.code === "record-read-failed") {
        const h = e as HarvestError;
        throw new FleetError(5, h.code, h.message, h.remediation);
      }
      throw e;
    };

    // AC4: a run that does not exist must exit 4 having mutated NOTHING. The
    // lock is a real file — created, fsynced, and (on a crash before the
    // finally) left behind for a phantom run, while a concurrent invocation
    // sees the run as busy. So probe first, cheaply, and refuse before the
    // filesystem is touched — through the `create: false` view above for a
    // NAMED --dir, so the refusal also mutates nothing.
    try {
      getRecord({ store }, runIdArg);
    } catch (e) {
      throw notFound(e);
    }

    // The probe passed, so the run exists: NOW build the writable store this
    // verb acts through (round 11). Building it FIRST chmod'd an existing
    // operator-named directory to 0700 before the probe could refuse.
    if (dir !== undefined && deps?.store === undefined) {
      const writable = asUsage(() => new RunRecordStore({ ...storeOpts, requestId }));
      verbStore = writable;
      store = writable;
    }

    // Then the lock, and only THEN the read that the verb actually uses: the
    // probe above is deliberately not trusted across the lock boundary, because
    // reading first is a check-then-act — a concurrent teardown closes the run
    // and revokes its key while we hold a record that still names the keyHash.
    try {
      lock = acquireRunLock(store.dir, runIdArg, "fleet invocation");
    } catch (e) {
      // A lock refusal is 5, not the generic 1. `logVerb` stamps 1
      // `transient` = "retry me", and for the STALE case (`refuse()` already
      // knows the holder's pid is dead and prints the `rm` that clears it)
      // nothing will ever clear the lock on its own — automation retried
      // forever and hit `run-locked` every time. The `finally` below reasons
      // exactly this way for the RELEASE failure and mints 6 for it; this is
      // the acquire side, and 5 is the code for "refused before provisioning"
      // — the throw happens between the record probe and any mutation, so
      // nothing was touched. The live-holder case rides along: a caller that
      // wants to wait for the holder switches on `run-locked` in the payload,
      // which is the fact, where `transient` is a guess.
      if (e instanceof RunLockedError) throw new FleetError(5, e.code, e.message, e.remediation);
      throw e;
    }

    /**
     * CC-9 for the interrupted verb (round 11): run-lock's signal path
     * releases (or declines) and then RE-RAISES the default disposition,
     * which skips this verb's `finally` — so a Ctrl-C'd harvest or teardown
     * was the one invocation that produced no structured line. This handler
     * emits it first; ordering with run-lock's own listener is harmless either
     * way (the line describes the interruption, not the lock's disposition),
     * and `log`'s sink is best-effort so nothing here throws out of a signal
     * context. Scoped and removed in the verb's finally like dispatch's pair.
     */
    const verbInterruptHandler = (sig: NodeJS.Signals): void => {
      logVerb(requestId, verb, runIdArg, startedAt, sig === "SIGINT" ? 130 : 143, "signalled");
    };
    // Direct references, so the finally below can remove exactly these.
    signalListeners = (["SIGINT", "SIGTERM"] as const).map(
      (sig) => [sig, () => verbInterruptHandler(sig)] as const,
    );
    for (const [sig, listener] of signalListeners) process.on(sig, listener);

    let rec: RunRecord;
    try {
      rec = getRecord({ store }, runIdArg);
    } catch (e) {
      throw notFound(e);
    }

    // DF5.3: the destructive verbs are their own composition root — the store
    // opens beside the ledger handle (`state.ledger`) and closes in the same
    // finally, so every teardown/harvest of this invocation emits its links.
    //
    // D8 — unconditional, deliberately, and not the same case as `observe`'s
    // deferred open or `sandbox-reap`'s dry run: both of those have a whole
    // MODE that emits nothing by construction (an unsettled marker, a
    // classify-only sweep), while every path through this block runs a verb
    // whose emit site is on its success path — `harvest`'s run-bundle link and
    // `teardown`'s run-box link. The residue is therefore bounded by the one
    // case the emitters skip: a record carrying no `repoSlug` or no
    // `requestId` takes `auditLinkSkip`'s skip-and-log door (C-3), and such an
    // invocation does leave `audit.db` (+ -wal/-shm) behind having recorded
    // nothing. That is accepted here rather than deferred like `observe`'s,
    // because this open precedes the destroy and the revoke: an unwritable
    // store refuses BEFORE the box comes down, where a deferred open would
    // discover it from inside the teardown's last statement — the exact
    // failure `observe`'s degradation arm exists to absorb.
    //
    // CLASSIFIED (C-1/C10): the raw open reached `report`'s untyped branch as
    // `code: "EACCES"` with advice that never named `QDS_AUDIT_DB`.
    let audit: AuditStoreWriter;
    try {
      audit = openAuditStore();
    } catch (e) {
      throw auditStoreUnavailable(
        e,
        `the ${verb}'s links could not be written, so nothing was torn down — the box and key are untouched`,
      );
    }
    state.audit = audit;
    const tdeps: TeardownDeps = {
      driver,
      store,
      requestId,
      gitCwd: process.cwd(),
      // The store's own resolution, not a second copy of the same `?? env ??
      // default` chain: the lock guards `<store.dir>/<runId>.lock`, so the
      // bundle/artifact paths must be under exactly that directory.
      runsDir: store.dir,
      recordAuditLink: (link) => audit.record(link),
    };
    if (verb === "harvest") {
      code = await runHarvest(ctx, tdeps, runIdArg);
    } else if (verb === "cancel") {
      // Q1.4: idempotent teardown. The record read under the lock decides:
      // a CLOSED record is already settled — nothing to destroy, exit 0, and
      // a settled run is NOT relabelled cancelled (it completed). An OPEN
      // record with a cancel mark is the crash-recovery case (mark landed,
      // teardown did not run) — it RE-RUNS the teardown rather than no-op'ing
      // over a possibly-live box. The mark is written BEFORE the teardown so
      // a cancelled-then-closed record reads `cancelled` in the result
      // payload; the close the teardown performs is the idempotency anchor.
      if (rec.closedAt !== undefined) {
        const printed = reportCompletion([
          `nothing to do: ${runIdArg} already settled — no box, no keys, no teardown`,
        ]);
        code = printed ? 0 : 6;
      } else {
        store.set(runIdArg, {
          extensions: { cancel: { state: "cancelled", at: new Date().toISOString() } },
        });
        const armed = await runTeardown(ctx, { tdeps, store, rec, lock, runIdArg, requestId, state });
        if (armed.early === true) return armed.code;
        if (armed.code === 0) {
          const printed = reportCompletion([`cancelled: ${runIdArg}`]);
          code = printed ? 0 : 6;
        } else {
          code = armed.code;
        }
      }
    } else {
      const armed = await runTeardown(ctx, { tdeps, store, rec, lock, runIdArg, requestId, state });
      // Re-raised HERE, inside the try, so the CC-9 line still precedes the
      // `finally`'s cleanup diagnostics exactly as the inline arm's own
      // `return finish(…)` did.
      if (armed.early === true) return armed.code;
      code = armed.code;
    }
  } catch (e) {
    code = reportCode(note, e);
  } finally {
    /**
     * ONE cleanup-failure policy, stated here and shared with
     * `scripts/sandbox-teardown.ts` and `scripts/qds-cost.ts` (which had three
     * different ones between them): on an otherwise-successful path a cleanup
     * failure IS the error — a spend that may never have been durably committed
     * and a run left locked against every later verb are not "success" — but it
     * never overwrites a failure the verb already reported.
     *
     * Its own code, not 1. Exit 1 means "the substrate failed, retry", and
     * `logVerb` classifies it `transient`; a wedged lock retried forever just
     * hits `run-locked` every time, because nothing will ever clear it. 6 is
     * outside the retryable range, so it classifies `logic`.
     */
    const cleanupFailed = (): void => {
      if (code === 0) code = 6;
    };
    if (state.ledger !== undefined) {
      try {
        state.ledger.close();
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        // Same normalization as the ack arm: a null/undefined rejection here
        // would throw a TypeError from INSIDE this catch, escaping the cleanup
        // policy and hiding the original close failure under a crash.
        printError(
          note,
          "ledger-close-failed",
          `could not close the cost ledger: ${redactSecrets(x.message ?? e)}`,
          "the handle dies with the process; re-run to confirm it still reads",
        );
        cleanupFailed();
      }
    }
    // DF5.3: the verb's audit store closes on the same cleanup policy — the
    // links are already committed, so a close fault is a leftover, not a
    // retriable failure.
    if (state.audit !== undefined) {
      try {
        state.audit.close();
      } catch (e) {
        const x = (e ?? {}) as { message?: string };
        printError(
          note,
          "audit-store-close-failed",
          `could not close the audit-link store: ${redactSecrets(x.message ?? e)}`,
          "the handle dies with the process; re-run to confirm it still reads",
        );
        cleanupFailed();
      }
    }
    // releaseRunLock re-reads the body and unlinks it only while it is still
    // this invocation's claim, so a refused invocation — or one whose lock was
    // cleared and re-taken — never unlinks a live holder's file.
    if (lock !== undefined && state.destructiveInFlight) {
      // F5 (2026-08-24): before deciding the lock must stay, ask the RECORD
      // what actually landed. teardownSandbox's fixed order is
      // spend→…→revoke→verify→destroy→close, and close is LAST — so a record
      // whose closedAt is set proves destroy AND revoke already ran, and the
      // throw came from the close step's post-close work (the box-hour ingest
      // refusing an unpriced row, an unopenable ledger). There is no
      // half-torn-down run left for the lock to guard: the box is destroyed,
      // the key revoked, the record closed. Holding the lock forced the
      // operator to rm it by hand for a run with nothing billable left
      // (e2e-run-report F5). Release it; the failure still exits 6 below —
      // "done, needs an operator (e.g. write cost-config.json, re-run)" —
      // and a re-run is the idempotent closed-record path, which retries the
      // ingest on its own.
      let landed = false;
      try {
        landed = verbStore !== undefined && runIdArg !== undefined && verbStore.get(runIdArg).closedAt !== undefined;
      } catch {
        landed = false; // unreadable record — hold the lock, let an operator see it
      }
      if (landed) {
        let markCleared = true;
        try {
          clearRunLockDestructive(lock);
        } catch (e) {
          markCleared = false;
          const x = (e ?? {}) as { message?: string };
          printError(
            note,
            "lock-clear-failed",
            `could not clear the destructive mark on ${lock}: ${redactSecrets(x.message ?? e)}`,
            `rm ${lock} by hand once no other invocation holds it — until then every later harvest or teardown of this run refuses`,
          );
        }
        if (markCleared) {
          printError(
            note,
            "lock-released-work-landed",
            `${runIdArg} was torn down (box destroyed, key revoked, record closed) and its lock was released — the failure above is the close step's leftover, not a half-destroyed run`,
            `resolve the reported leftover (e.g. write cost-config.json beside the records dir), then re-run: fleet teardown ${runIdArg} retries it idempotently`,
            { runId: runIdArg },
          );
          state.destructiveInFlight = false; // nothing left to guard — plain release below
        }
        // 6 either way: the work is DONE and the leftover (unpriced row, or an
        // unclearable mark) needs an operator — never 1, whose "retry me"
        // sends automation back to a run that no longer exists.
        code = 6;
      } else {
        // …but "still ours" is not the question on THIS path. `teardownSandbox`
        // threw partway through destroying the run, so the box may be gone with
        // the key un-revoked, or the record may still be open against a box that
        // no longer exists — the state the comment above `markRunLockDestructive`
        // says only an operator can judge. Releasing hands it to the next
        // invocation, which re-runs against a half-torn-down run.
        //
        // Not even attempted, rather than attempted and refused: `releaseRunLock`
        // would throw for exactly this reason (the destructive mark is still set,
        // because only the success path above clears it), and reporting that as
        // `lock-release-failed` would read as a cleanup that went wrong on top of
        // the verb's failure. It did not go wrong; it was declined on purpose.
        printError(
          note,
          "lock-held",
          `${lock} was NOT released: this teardown of ${runIdArg} failed partway through destroying the run`,
          `check the run's box, key and record before anything else touches it, then rm ${lock} — until then every later harvest or teardown of this run refuses`,
          { runId: runIdArg },
        );
        // Over the failure the verb already reported, which is the one place this
        // file's "cleanup never overwrites the verb's own code" rule has to bend:
        // the code being overwritten is `report`'s 1, `transient`, "retry me" —
        // and the retry it invites cannot do anything but hit `run-locked` (5)
        // forever, because this invocation just decided nothing will clear the
        // lock but a human. 6 is the honest classification of what was left
        // behind: partly done, not retryable, needs an operator.
        code = 6;
      }
    }
    if (lock !== undefined && !state.destructiveInFlight) {
      try {
        releaseRunLock(lock);
      } catch (e) {
        // releaseRunLock itself throws Errors today, but this file's policy is
        // uniform: a reporting catch must survive ANY rejection shape — the
        // two sibling arms above already normalize for the same reason.
        const x = (e ?? {}) as { message?: string };
        printError(
          note,
          "lock-release-failed",
          `could not release ${lock}: ${redactSecrets(x.message ?? e)}`,
          `rm ${lock} by hand once no other invocation holds it — until then every later harvest or teardown of this run refuses`,
        );
        cleanupFailed();
      }
    }
    // The verb scoped its CC-9 interrupt listeners at acquire; whether the verb
    // finished, threw, or exits through THIS finally on a normal path, they have
    // nothing left to guard and must not accumulate per call in an embedder.
    for (const [sig, listener] of signalListeners) process.removeListener(sig, listener);
  }
  return finish(requestId, verb, runIdArg, code);
}

/** `fleet harvest`'s arm of the shared destructive scaffolding: D8, credential-free. */
async function runHarvest(ctx: VerbCtx, tdeps: TeardownDeps, runIdArg: string): Promise<number> { // dp:ok awaited at fleet.ts:2609 inside runDestructive's try/finally, which owns the diagnostics and the exit code
  const { reportCompletion, outputIncomplete } = ctx;
  // D8: harvest is credential-free — no keyApi is built.
  const res = await harvestRun(tdeps, runIdArg);
  // Through `reportCompletion`, not a bare `emit` (see it): the harvest
  // has already run, so a lost result line is 6, never a retryable 1. Folded
  // with `outputIncomplete()` like every sibling arm (A12): `reportCompletion`
  // answers true when the write itself succeeded, but an fd 1 left
  // non-blocking can have swallowed half the line — the harvest happened and
  // `finish` exits 6 for it, so this must not read 0.
  return reportCompletion([
    res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n",
  ]) && !outputIncomplete()
    ? 0
    : 6;
}

/**
 * `fleet teardown`'s arm of the shared destructive scaffolding.
 *
 * `early` is the lock-mark-failed path: it used to `return finish(…, 6)` from
 * inside `runDestructive`'s try, so the CC-9 line was emitted BEFORE the
 * `finally`'s cleanup diagnostics. The caller re-raises it in the same place,
 * which keeps that ordering exactly.
 */
/**
 * The narrow projection every ledger `readRunRecord` seam hands over. ONE
 * function, not four inline literals: the S1 swarm token ingest resolves
 * INV-COST-5 attribution through `swarmSeats` (role → seat index), so every
 * producer must forward the trio at the TOP LEVEL — a full `RunRecord` does
 * not satisfy it (its seat trio lives under `extensions`), and a producer
 * that forgets the field reads as "key-hash-missing" at ingest, stranding
 * the very attribution the row exists to carry.
 */
function costRecordProjection(r: RunRecord): RunCostRecord {
  const swarm = r.extensions?.swarmSeats;
  return {
    createdAt: r.createdAt,
    closedAt: r.closedAt,
    keyHash: r.keyHash,
    limitMicroUsd: r.limitMicroUsd,
    swarmSeats:
      swarm && {
        seats: swarm.seats as string[],
        keyHashes: swarm.keyHashes as string[],
        limitMicroUsd: swarm.limitMicroUsd as number[] | undefined,
      },
  };
}

async function runTeardown(
  ctx: VerbCtx,
  args: {
    tdeps: TeardownDeps;
    store: RunRecordStore;
    rec: RunRecord;
    lock: RunLockHandle;
    runIdArg: string;
    requestId: string;
    state: DestructiveState;
  },
): Promise<{ code: number; early?: true }> {
  const { deps, verb, bools, note, finish, reportCompletion, outputIncomplete } = ctx;
  const { tdeps, store, rec, lock, runIdArg, requestId, state } = args;
  // Set by the branch below, read after the teardown: a possibly-live key
  // this teardown provably cannot revoke is not a success, and it cannot be
  // reported until the box half has actually run.
  let keyUnattributable = false;
  // S1 rig_swarm: a swarm record carries NO core keyHash — its revocable keys
  // live in extensions.swarmSeats.keyHashes (run-record.ts's registry). The
  // wiring used to build the client only for `rec.keyHash !== undefined`, so a
  // swarm teardown hit the spend guard's "deps.keyApi is absent" refusal and
  // aborted partway: per-seat keys LEFT LIVE on the provider, lock deliberately
  // held, exit 6 (live rounds 21-22 stranded real, spending keys on exactly
  // this gap — qds-20260926-35a2e4 / -3fac7f). The namespace's presence is the
  // same single-read staleness discipline the teardown's own swarmed branch
  // applies (teardown.ts:995).
  const swarmSeatHashCount = (rec.extensions?.swarmSeats?.keyHashes as string[] | undefined)?.length ?? 0;
  if (rec.keyHash !== undefined || swarmSeatHashCount > 0) {
    tdeps.keyApi = deps?.keyApi ?? asUsage(() => openRouterKeyApi());
  } else if (rec.vmName !== undefined && rec.closedAt === undefined) {
    // Absence of `keyHash` is NOT proof that no key exists. `dispatch`
    // provisions the box first and persists the keyHash after minting, so a
    // crash in between leaves exactly this record: a box that existed, an
    // open run, and no surviving pointer to a key that is still billing.
    // The teardown below is correct for the box and silent about the key,
    // and `torn down:` + exit 0 reads as "nothing left running".
    keyUnattributable = true;
    printError(
      note,
      "key-unattributable",
      `${runIdArg} has a box but no keyHash: if a key was minted for it, this teardown cannot revoke it`,
      "check the provider's key list for a key created around this run's createdAt and revoke it by hand",
      { runId: runIdArg },
    );
  }
  // Wrapped like every sibling construction: a permanently broken
  // cost-config.json or an unopenable ledger db throws a bare Error, which
  // fell through `report`'s generic branch as exit 1 `transient` — so every
  // `fleet teardown` on the host retried forever while the boxes billed.
  state.ledger = asUsage(
    () =>
      new CostLedger({
        ...costLedgerOpts(store.dir),
        // FP1 (round 10): orphan-expiry stat probes target THIS store's
        // runs dir (see makeLedgerFactory twin).
        runsDir: store.dir,
        readRunRecord: (id: string) => {
          try {
            return costRecordProjection(getRecord({ store }, id));
          } catch (e) {
            if ((e as HarvestError | null)?.code === "no-record") return undefined;
            throw e;
          }
        },
      }),
  );
  tdeps.costLedger = state.ledger;
  const noHarvest = bools.has("--no-harvest");
  /**
   * Guarded like its sibling `clearRunLockDestructive` below (round 10): a
   * PARTIAL mark write leaves the lock file's ownership body unreadable, so
   * every later release attempt refuses — the same "wedged, needs an
   * operator" shape that finally gives exit 6, and never the exit-1
   * "retry me" an unguarded throw produced. Fail CLOSED as well: the mark
   * is what makes the destructive window safe to interrupt into, so a
   * failed mark aborts BEFORE `teardownSandbox`. Nothing has been
   * destroyed; `destructiveInFlight` stays false, so the finally releases
   * the still-clean lock (or reports it un-releasable if the partial write
   * corrupted it — either way the operator is told).
   */
  try {
    markRunLockDestructive(lock);
  } catch (e) {
    const x = (e ?? {}) as { message?: string };
    printError(
      note,
      "lock-mark-failed",
      `could not mark ${lock} destructive: ${redactSecrets(x.message ?? e)} — refusing to tear down ${runIdArg}`,
      `nothing was destroyed; inspect and rm ${lock} by hand once no other invocation holds it, then re-run`,
    );
    // Nothing was destroyed and the lock is still clean: returning now lets
    // the finally run its normal release path (`destructiveInFlight` stayed
    // false), and 6 — not the unguarded throw's retryable 1 — reports the
    // wedged mark.
    return { code: finish(requestId, verb, runIdArg, 6), early: true };
  }
  state.destructiveInFlight = true;
  await teardownSandbox(tdeps, runIdArg, lock, { noHarvest });
  // The destructive sequence completed: box destroyed, key revoked (or
  // named as unrevokable above), record closed. From here the lock is safe
  // to release — there is no half-torn-down state left for it to guard, and
  // this is the ONLY place that can say so: from inside the release,
  // "the caller reached its finally" looks the same whether
  // `teardownSandbox` returned or threw.
  state.destructiveInFlight = false;
  // Guarded like the `finally` cleanups below, and for the same reason: the
  // teardown has LANDED, so a failure clearing the destructive mark is
  // bookkeeping left undone, not a verb to retry. Letting it escape to the
  // generic catch stamped landed destructive work exit 1 `transient`. 6 is
  // what the finally gives the sibling leftovers: "already done, still
  // needs an operator" — the mark stays set, so every later harvest or
  // teardown of this run refuses until an operator removes it.
  let markCleared = true;
  try {
    clearRunLockDestructive(lock);
  } catch (e) {
    markCleared = false;
    const x = (e ?? {}) as { message?: string };
    printError(
      note,
      "lock-clear-failed",
      `could not clear the destructive mark on ${lock}: ${redactSecrets(x.message ?? e)}`,
      `rm ${lock} by hand once no other invocation holds it — until then every later harvest or teardown of this run refuses`,
    );
  }
  // Reported AFTER the teardown ran: printed first, it claims a waiver for
  // a teardown that may never have happened. `&& !outputIncomplete()` is the
  // sibling rule (A12) — a silent EAGAIN truncation leaves `torn down:` half
  // printed while `reportCompletion` answers true, and a `|| alert` consumer
  // must see 6, not 0, for a landing it may never have read.
  const reportedLanding =
    reportCompletion([
      ...(noHarvest ? [`teardown.harvest_waived ${runIdArg}\n`] : []),
      `torn down: ${runIdArg}\n`,
    ]) && !outputIncomplete();
  // NOT 0. The box is gone and the record is closed, so the verb's own work
  // landed — but a key that may still be minting spend was not revoked and
  // this CLI cannot find it. `torn down:` + exit 0 is what `fleet teardown
  // … || alert` reads as "nothing left running", which is the one thing
  // that is not true here. The file resolves the identical "the answer
  // above may be wrong" condition the same way twice in `status`
  // (`listUnavailable` → 1, `skippedRecords` → 5): exit 0 lies to
  // automation, so the exit code carries it.
  //
  // 6 rather than 1 or 2, and by the same test the cleanup `finally` below
  // applies: the work is DONE, so 1 (`transient`, "retry me") would send
  // automation back to tear down a run that no longer exists, and the
  // leftover is a live credential no retry of this verb can reach. 6 is
  // "already done, still needs an operator", which is exactly the manual
  // key revocation the stderr line just asked for. It is in teardown's
  // declared set (src/fleet/verbs.ts) already. The un-clearable mark and
  // the unwritable result line above are the same classification — landed
  // work with a leftover only an operator can resolve.
  return { code: keyUnattributable || !markCleared || !reportedLanding ? 6 : 0 };
}


/**
 * writeSync can write short; a truncated ack is worse than a slow one.
 *
 * A zero-length return is NOT a short write to retry — it is fd 1/2 left
 * non-blocking by a CI runner or a wrapper refusing the bytes, and looping on
 * it spins forever while the run lock is held and the box bills. Surface it as
 * the EAGAIN it is, so the ONE decision that matters — does a failed write
 * change this invocation's outcome? — is taken per call site (`emit`/`note`
 * tolerate it because the work they describe is already done; the dispatch ack
 * does not, because its runId is the only handle on a live box).
 */
function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error(`fd ${fd} accepted 0 of ${buf.length - off} bytes`), { code: "EAGAIN" });
    off += n;
  }
}

/**
 * A DIAGNOSTIC write is never worth changing the outcome it reports on. Both
 * sinks bound here run where a throw is unrecoverable: the log sink is called
 * from `logVerb`, whose `return logVerb(...)` is outside every `try` in `run()`
 * — an EPIPE there discarded a `code` already set to 6 ("wedged, do not retry")
 * and escaped as exit 1 `transient`, the retry loop exit 6 exists to prevent.
 * `scripts/lib/run-lock.ts`'s `writeStderr` takes this posture for the same reason.
 */
function writeBestEffort(fd: number, s: string): void {
  try {
    writeAll(fd, s);
  } catch {
    // Nothing left to report it to.
  }
}

if (import.meta.main) {
  try {
    // stdout = output only; diagnostics stream as JSON lines on stderr.
    setLogSink((entry) => {
      writeBestEffort(2, `${JSON.stringify(entry)}\n`);
    });
    process.exit(
      await run(
        process.argv.slice(2),
        (s) => writeAll(1, s),
        undefined,
        (s) => writeBestEffort(2, s),
      ),
    );
  } catch (e) {
    // A non-Error throw printed `undefined` and told the operator nothing. The
    // stack goes with it: nothing reaches here that `run` was designed to
    // handle, so this is a bug report and one bare line is not one.
    const stack = (e as Error)?.stack;
    writeBestEffort(2, `${stack ?? (e as Error)?.message ?? String(e)}\n`);
    process.exit(1);
  }
}

