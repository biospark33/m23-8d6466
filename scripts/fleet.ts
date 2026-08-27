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
 * 4 run-not-found · 5 refused before provisioning (payload code says which
 * guard fired) · 6 the verb's own work LANDED but the invocation could not
 * finish it or report it, and no retry can change that.
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
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";

import {
  CostLedger,
  getRecord,
  harvestRun,
  openRouterKeyApi,
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
import { redactSecrets } from "../src/providers/step-log.ts";
import type { BoxHoursCtx, IngestResult } from "../src/providers/cost-ledger.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { costLedgerOpts } from "./lib/cost-ledger-opts.ts";
import {
  acquireRunLock,
  clearRunLockDestructive,
  markRunLockDestructive,
  releaseRunLock,
  RunLockedError,
} from "./lib/run-lock.ts";
import { BriefSchema } from "../src/fleet/brief-schema.ts";
import { log, logSink, setLogSink, newRequestId } from "../src/swarmclaw/log.ts";
import {
  assertFleetRunId,
  dispatch,
  FleetError,
  resolveBriefRequestId,
  type DispatchDeps,
  type LedgerLike,
} from "../src/fleet/dispatch.ts";
/** The records-skipped envelope echoes `readdirSync` names through it (round 11). */
import { sanitizeLabel } from "../src/fleet/brief-schema.ts";
import { listVerbs, renderHelp, type VerbEntry } from "../src/fleet/verbs.ts";
import { statusAll, statusRun } from "../src/fleet/status.ts";
// DF3.2: the fanout/rank front doors. fanout-primitive (not fanout.ts) holds
// the primitive — the store module must never import it back.
import { FANOUT_ID_RE, FanoutRecordStore, resolveFanoutsDir, type FanoutRecord } from "../src/fleet/fanout.ts";
import {
  assertFanoutPin,
  fanout,
  FANOUT_MAX_N,
  type FanoutPattern,
} from "../src/fleet/fanout-primitive.ts";
import { rank, type ArmStepOutput } from "../src/fleet/rank.ts";
import type { Brief } from "../src/fleet/brief-schema.ts";
import type { KeyApi } from "../src/providers/credentials.ts";
import type { ExitStatus } from "../cli-anything/src/types.ts";

const HELP = renderHelp(listVerbs());

/**
 * Extract a readable error description from any thrown value.
 * Returns the message when Error, else String(e), else "unknown".
 */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e === null || e === undefined) return "unknown";
  return String(e);
}

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
  if (remediation !== undefined) line.remediation = remediation;
  err(`${JSON.stringify(line)}\n`);
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
    return Number.isInteger(e.exitCode) && e.exitCode >= 1 && e.exitCode <= 6 ? e.exitCode : 2;
  }
  // Non-Error rejections normalize to {} so the printer cannot itself throw
  // while reporting one.
  const x = (e ?? {}) as { code?: string; message?: string; remediation?: string; stack?: string; cause?: unknown };
  // No `code` at all means NOBODY designed this failure: a TypeError out of a
  // driver, a RangeError from inside teardownSandbox. One bare message for a
  // failure that may have left a box half-torn-down makes root-causing it
  // require re-running the destructive command — carry the stack (and the
  // cause's message) so the first run is enough. Typed refusals (RunLockedError,
  // the credential and harvest errors) already say what went wrong and where,
  // and stay the clean one-liners operators read daily.
  //
  // This branch and `asUsage` are the two places foreign text enters this
  // file's output, so both redact here rather than in `printError` — see there
  // for why the printer itself must not. A stack frame's arguments and a
  // `cause.message` are where a request URL or a `sk-…` prefix actually rides
  // out of the provider layer; `x.message` is a driver's or a teardown step's
  // own words.
  const cause = (x.cause ?? undefined) as { message?: string } | undefined;
  const debris =
    x.code !== undefined
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
  // designed for it". Only the present one is redacted.
  const remediation = x.remediation === undefined ? undefined : redactSecrets(x.remediation);
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

/** Read stdin, refusing AS IT STREAMS — buffering first turns `yes |` into an OOM. */
async function readCappedStdin(): Promise<string> {
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
              "brief-stdin-timeout",
              `no brief arrived on stdin within ${STDIN_BRIEF_TIMEOUT_MS / 1000}s`,
              "the writer holding this pipe's write end never closed it — close it, or pass --brief <path> instead",
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
          "brief-too-large",
          `brief exceeds the ${MAX_BRIEF_BYTES} byte cap`,
          "trim the brief or split payload out of it",
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
 */
function assertOneBriefSource(briefPath: string): void {
  let st: ReturnType<typeof fstatSync>;
  try {
    st = fstatSync(0);
  } catch {
    return; // no fd 0 at all — nothing was attached
  }
  if (st.isCharacterDevice() || st.isSocket()) return;
  throw usageError(
    `--brief ${bounded(briefPath)} was given AND a brief was redirected onto stdin`,
    "pass the brief exactly one way: `--brief <path>`, or on stdin with no --brief",
  );
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
        assertOneBriefSource(briefPath);
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
 */
interface LoserLedgerHandle {
  ingestBoxHours(ctx: BoxHoursCtx): IngestResult;
  close(): void;
}

/**
 * The lazy loser-ledger hook (see the fanout block's comment): opened on the
 * FIRST ingestBoxHours, closed by the fanout verb's finally — teardown's close
 * step only ever ingests. The reference drop is unconditional (try/finally):
 * a close() that THROWS must still drop the handle, because an abandoned
 * loser teardown can reach its ingest after the verb's finally ran, and on a
 * handle whose close failed bun:sqlite answers "Database has closed" — the
 * late box-hours row lost, under-counting the ledger the cap admits against.
 * Dropped, the late ingest re-opens a fresh ledger, and the event-id conflict
 * rule keeps it idempotent against rows already landed. The throw still
 * propagates: the verb's finally is what reports it (exit 6). The opener seam
 * exists so that contract is testable without manufacturing a SQLite close
 * failure (bun's close is idempotent — a double close does not throw).
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
const MAX_ECHO = 96;
function bounded(s: string | undefined): string {
  if (s === undefined) return "(none)";
  const safe = redactSecrets(s);
  return safe.length <= MAX_ECHO ? safe : `${safe.slice(0, MAX_ECHO)}…(${safe.length} chars)`;
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
  const emit = (s: string, failOnEpipe = false): void => {
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
  const reportCompletion = (...lines: string[]): boolean => {
    try {
      for (const line of lines) emit(line, true);
      return true;
    } catch (e) {
      const x = (e ?? {}) as { message?: string };
      printError(
        note,
        "completion-unwritable",
        `the command completed but its result line could not be written to stdout: ${redactSecrets(x.message ?? e)}`,
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
      return finish(newRequestId(), "help", undefined, report(note, e));
    }
    // Same write-failure contract as the `--help` path above: a throw out of
    // this emit used to escape run() raw — the envelope discipline held
    // everywhere else in the file but here.
    try {
      emit(`${HELP}\n`, true);
    } catch (e) {
      printError(
        note,
        "help-unwritable",
        `the usage text could not be written to stdout: ${redactSecrets(errText(e))}`,
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
    return finish(newRequestId(), attempted, undefined, report(note, e));
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
      printError(
        note,
        "help-unwritable",
        `the usage text could not be written to stdout: ${redactSecrets(errText(e))}`,
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

  // ── dispatch ────────────────────────────────────────────────────────────────
  if (verb === "dispatch") {
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
      let port: number | undefined;
      if (portRaw !== undefined) {
        // Plain decimal ONLY, before Number() gets a say: it accepts hex
        // (`0x1f4` → 500), exponents (`1e3` → 1000), surrounding whitespace
        // (`" 8080 "`) and zero padding (`08080`), every one of which is an
        // integer in 1-65535 and none of which is the port the operator typed.
        // The CLI must not bind a port they never wrote. The range check below
        // still owns 0 and 65536+.
        port = /^[1-9]\d{0,4}$/.test(portRaw) ? Number(portRaw) : Number.NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          // `bounded`: a rejected value is echoed, and argv is unbounded.
          throw usageError(
            `--port ${JSON.stringify(bounded(portRaw))} is not a TCP port`,
            "--port takes an integer 1-65535",
          );
        }
      }

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
            printError(
              note,
              "key-mint-lock-unavailable",
              `the run lock for ${minted} could not be taken while the key was being minted: ${redactSecrets(errText(e))}`,
              "a concurrent harvest or teardown may be acting on this run id — check `fleet status` before touching either",
            );
          }
        }),
        ledgerFactory,
        requestId,
        ...(port === undefined ? {} : { port }),
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
        printError(
          note,
          "ack-unwritable",
          `the box for ${ack.runId} is live but its ack could not be written to stdout: ${redactSecrets(errText(e))}`,
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
      dispatchCode = report(note, e);
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

  // ── fanout (DF3.2 D12) ──────────────────────────────────────────────────────
  if (verb === "fanout") {
    // Hoisted like dispatch's id: a refusal before the brief resolves has no
    // correlation id yet, and the CC-9 line must still be emitted.
    let fanRequestId: string | undefined;
    let fanoutId: string | undefined;
    // Initialized to the failure side so the cleanup `finally` below may read
    // it: both the try and the catch assign before returning, so the default
    // is unreachable unless `report` itself throws — and then 1 ("substrate
    // failed") is the honest thing to die with.
    let fanoutCode = 1;
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
      // Mirrors --port: plain decimal ONLY, then range — Number() alone accepts
      // hex (`0x3` → 3), exponents and zero padding that are not what was
      // typed. Digits are unbounded on purpose: the ceiling lives solely in
      // the range check against FANOUT_MAX_N below.
      const n = typeof nRaw === "string" && /^[1-9][0-9]*$/.test(nRaw) ? Number(nRaw) : Number.NaN;
      if (!Number.isInteger(n) || n < 1 || n > FANOUT_MAX_N) {
        throw usageError(
          `--n ${JSON.stringify(nRaw)} is not a fan-out width`,
          `--n takes an integer 1-${FANOUT_MAX_N} (best-of-n/race need two arms to compare)`,
        );
      }
      // Positive safe integer, mirroring the --port numeric-flag idiom (D10).
      const capRaw = flags.get("--cap-micro-usd");
      let capMicroUsd: number | undefined;
      if (capRaw !== undefined) {
        capMicroUsd = /^[1-9]\d*$/.test(capRaw) ? Number(capRaw) : Number.NaN;
        // C1: Upper bound of $1M (1e12 µ$) — domain ceiling for per-arm caps.
        const CAP_MAX_MICRO_USD = 1_000_000_000_000;
        if (!Number.isSafeInteger(capMicroUsd) || capMicroUsd < 1 || capMicroUsd > CAP_MAX_MICRO_USD) {
          throw usageError(
            `--cap-micro-usd ${JSON.stringify(capRaw)} is not a micro-dollar amount`,
            `--cap-micro-usd takes a positive integer of micro-dollars (1-${CAP_MAX_MICRO_USD}, where $1 is 1000000)`,
          );
        }
      }

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
      // r7-S3a: Fail-closed for empty roster segments BEFORE filtering.
      // `--roster "a,,b"` has empty segments; flag PRESENT with ANY empty
      // entry ⇒ refusal. Filter happens AFTER this guard.
      if (rosterIds?.some((s) => s === "")) {
        throw usageError(
          "--roster contains an empty entry",
          "every comma-separated entry must be non-empty",
        );
      }
      // Apply the filter AFTER the empty-segment guard.
      const filteredRosterIds = rosterIds?.filter((s) => s !== "");
      // C2: Fail-closed for explicit empty roster. `--roster ""` or `--roster ","`
      // produces an empty list; flag PRESENT but resulting list EMPTY ⇒ refusal.
      // Flag absent ⇒ filteredRosterIds stays undefined (no roster provided).
      if (filteredRosterIds !== undefined && filteredRosterIds.length === 0) {
        throw usageError(
          "--roster provided but empty",
          "pass at least one roster entry, or omit --roster entirely",
        );
      }
      // r7-S3b: Fail-closed for duplicate roster ids. Duplicates silently
      // degrade the experiment by provisioning identical-model arms.
      const seen = new Set<string>();
      for (const id of filteredRosterIds ?? []) {
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
      if (pattern === "many-stories" && filteredRosterIds !== undefined) {
        throw usageError(
          "--roster is not valid for many-stories",
          "drop --roster; per-arm variation comes from the distinct briefs",
        );
      }
      if (pattern === "best-of-n" || pattern === "many-stories" || pattern === "race") {
        const minN = pattern === "many-stories" ? 1 : 2;
        if (n < minN) {
          throw usageError(
            `--n ${JSON.stringify(nRaw)} is not a fan-out width`,
            `--n takes an integer ${minN}-${FANOUT_MAX_N}${minN === 2 ? " (best-of-n/race need two arms to compare)" : ""}`,
          );
        }
      } else {
        throw usageError(
          `unknown pattern: ${String(pattern)}`,
          "pattern is one of best-of-n, many-stories, race",
        );
      }
      // Roster shape, same hoisting: required and exactly --n wide for
      // best-of-n/race (many-stories' forbidden case already refused above).
      if (pattern !== "many-stories") {
        if (filteredRosterIds === undefined) {
          throw usageError(
            `${pattern} requires a roster list (one entry per arm)`,
            "pass the roster entries and rerun",
          );
        }
        if (filteredRosterIds.length !== n) {
          throw usageError(`${pattern} got ${filteredRosterIds.length} roster entries for n=${n}`, "the roster count must equal --n");
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
      // --dir is NOT this store's dir: for both producer and consumer it names
      // the FAN-OUTS directory (rank's semantics — one flag, one meaning), and
      // a fan-*.json inside a runs dir would make every later sweep of that
      // dir report malformed_record_name anomalies. The run records follow
      // their own default/env chain.
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
      const fanoutsFlagDir = injectedFanoutsDir ?? dir;
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
                    return store.get(id);
                  } catch (e) {
                    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
                    throw e;
                  }
                },
              }),
          ),
        );
      }
      const result = await fanout(pattern as FanoutPattern, n, briefs as Brief | Brief[], {
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
        ...(filteredRosterIds === undefined ? {} : { rosterIds: filteredRosterIds }),
        ...(capMicroUsd === undefined ? {} : { capMicroUsd }),
      });
      fanoutId = result.fanoutId;

      // One JSON line PER ARM — the status-row idiom: stdout is what a caller
      // parses, diagnostics ride stderr.
      for (const arm of result.arms) {
        emit(
          `${JSON.stringify({
            fanoutId: result.fanoutId,
            arm: arm.arm,
            runId: arm.runId,
            outcome: arm.outcome,
            ...(arm.vmName === undefined ? {} : { vmName: arm.vmName }),
          })}\n`,
        );
      }
      // Auto-rank (AC7/D12): best-of-n's whole point, emitted when EVERY arm is
      // ready. Advisory — it authorizes nothing, so it carries its OWN catch:
      // a failure here (record unreadable, store construction refused) must
      // never reach this verb's shared catch, which would flip N provisioned,
      // ready boxes into a reported refusal. It degrades to a stderr warning
      // and leaves fanoutCode derived from the ARM outcomes below alone.
      // This verb has no step-output source (`--steps-json` is rank's flag), so
      // arms list unscored with an explanatory rationale;
      // `fleet rank <id> --steps-json …` scores them afterwards.
      if (pattern === "best-of-n" && result.arms.every((a) => a.outcome === "ready")) {
        try {
          const fstore = new FanoutRecordStore({ dir: resolveFanoutsDir(fanoutsFlagDir), requestId: fanRequestId });
          const ranked = await rank(result.fanoutId, {
            recordReader: (id) => readFanoutForRank(fstore, id),
            recordWriter: (id, mutator) => fstore.mutate(id, (rec) => mutator(rec) as FanoutRecord),
            stepOutputFor: () => null,
          });
          emit(`${JSON.stringify(ranked)}\n`);
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
    } catch (e) {
      fanoutCode = report(note, e);
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
          printError(
            note,
            "ledger-close-failed",
            `could not close the loser cost ledger: ${redactSecrets(errText(e))}`,
            "the handle dies with the process; re-run to confirm it still reads",
          );
          // C5: Exit code escalation only when fanoutCode === 0 (the log is always emitted).
          if (fanoutCode === 0) fanoutCode = 6;
        }
      }
    }
    return finish(
      fanRequestId ?? newRequestId(),
      verb,
      fanoutId,
      fanoutCode,
      transientRefusal ? "transient" : undefined,
    );
  }

  // ── rank (DF3.2 D12/C2) ─────────────────────────────────────────────────────
  if (verb === "rank") {
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
        let rawSteps: string;
        // Regular-file proof BEFORE the cap and the read (readBriefFile's
        // posture): a directory reports a small st.size that sails past the
        // cap into an EISDIR read, and a FIFO would BLOCK the read forever
        // waiting for a writer — only a regular file has a size worth trusting
        // and can be refused before it is opened. A statSync failure (ENOENT,
        // EACCES) leaves the stat unknown and falls through to the read's own
        // catch below, keeping the missing-file message shape.
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
        const stepsSize = stepsStat?.size ?? -1;
        if (stepsSize > MAX_STEPS_BYTES) {
          throw usageError(
            "--steps-json exceeds the 1 MiB cap",
            "point --steps-json at a smaller JSON file mapping run ids to step outputs",
          );
        }
        try {
          rawSteps = readFileSync(stepsPath, "utf8");
        } catch (e) {
          throw usageError(
            `cannot read --steps-json ${stepsPath}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
            "point --steps-json at a readable JSON file mapping run ids to step outputs",
          );
        }
        let parsedSteps: unknown;
        try {
          parsedSteps = JSON.parse(rawSteps);
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
        for (const [runId, out] of Object.entries(parsedSteps as Record<string, unknown>)) {
          const bad = (why: string): FleetError =>
            usageError(
              `--steps-json entry ${JSON.stringify(runId)} ${why}`,
              "each entry carries testsExecuted?, testResults{passed,failed}? and changedFiles[]?",
            );
          if (typeof out !== "object" || out === null || Array.isArray(out)) throw bad("must be an object");
          const o = out as Record<string, unknown>;
          if (o.testsExecuted !== undefined && typeof o.testsExecuted !== "boolean") {
            throw bad("has a non-boolean testsExecuted (it is a guard flag, never a divisor)");
          }
          if (o.testResults !== undefined) {
            const tr = o.testResults as Record<string, unknown> | null;
            if (
              typeof tr !== "object" ||
              tr === null ||
              !Number.isInteger(tr.passed) ||
              !Number.isInteger(tr.failed) ||
              (tr.passed as number) < 0 ||
              (tr.failed as number) < 0
            ) {
              // Non-negative, not just integral: a negative count would rank a
              // broken arm above healthy ones (passRate > 1). rank()'s own
              // shape guard refuses it too — this is the boundary naming the
              // flag that carried it.
              throw bad("needs testResults with non-negative integer passed/failed counts");
            }
          }
          // C3: Refuse inconsistent testResults/testsExecuted combo.
          // testResults present while testsExecuted === false is logically inconsistent.
          // (Inverse is legal: testsExecuted true with no testResults = passRate 0).
          if (o.testResults !== undefined && o.testsExecuted === false) {
            throw bad("has testResults but testsExecuted is false — tests must have been executed to have results");
          }
          if (
            o.changedFiles !== undefined &&
            (!Array.isArray(o.changedFiles) || o.changedFiles.some((f) => typeof f !== "string"))
          ) {
            throw bad("has changedFiles that is not an array of path strings");
          }
          byRun.set(runId, o as unknown as ArmStepOutput); /* dp:ok shape-checked field-by-field above against ArmStepOutput's three optional keys */
        }
      }
      // A WRITABLE store — rank stamps rankedAt. Shared residual: pointing
      // --dir at an existing directory re-chmods it 0700 before the lookup can
      // refuse; the default dir bootstrapping on first use is intended.
      // Resolved through resolveFanoutsDir HERE TOO: fanout's producer side
      // resolves this same flag through it, and one flag keeps one meaning and
      // one chain (flag → env → default) at both ends of the round-trip.
      const fstore = new FanoutRecordStore({ dir: resolveFanoutsDir(dir), requestId });
      const result = await rank(fanoutId, {
        recordReader: (id) => readFanoutForRank(fstore, id),
        recordWriter: (id, mutator) => fstore.mutate(id, (rec) => mutator(rec) as FanoutRecord),
        stepOutputFor: (runId) => byRun.get(runId) ?? null,
      });
      emit(`${JSON.stringify(result)}\n`);
      return finish(requestId, verb, fanoutId, 0);
    } catch (e) {
      return finish(requestId, verb, undefined, report(note, e));
    }
  }

  // status / harvest / teardown all take an optional-or-required runId.
  const runIdArg = positionals[1];
  const driverName = flags.get("--driver");
  const requestId = newRequestId();

  // ── status ──────────────────────────────────────────────────────────────────
  if (verb === "status") {
    try {
      if (positionals.length > 2) {
        throw usageError("status takes at most one <run-id>", "fleet status [run-id]");
      }
      // The same grammar harvest/teardown enforce: an over-long or malformed
      // id must not reach the store as an untyped path error. RAW — see the
      // teardown call site for why the cap belongs to the refusal, not here.
      if (runIdArg !== undefined) assertFleetRunId(runIdArg);
      assertDriverChosen("status", driverName, deps?.driver);
      const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId }));
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
      const listFailed = rows.some((r) => r.state === "listUnavailable");
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
        // not. 512 is status.ts's MAX_DIAGNOSTIC, the sink the producer side
        // already sizes these for.
        const MAX_SKIPPED_ECHO = 50;
        const echoed = skipped.slice(0, MAX_SKIPPED_ECHO).map((n) => sanitizeLabel(n, 512));
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
      // 2, not 1. Exit 1 is `transient` = "retry me", and a malformed record
      // filename is there on every retry — the same reasoning the teardown
      // `finally` uses for exit 6. It wins over `listUnavailable`'s 1 when both
      // fire, because retrying cannot complete the listing either way.
      // …otherwise no runs is a state, not an error (AC4).
      return finish(requestId, verb, runIdArg, skipped.length > 0 ? 2 : listFailed ? 1 : 0);
    } catch (e) {
      return finish(requestId, verb, runIdArg, report(note, e));
    }
  }

  // ── harvest / teardown (AC5: thin front doors onto DF2.5, guards intact) ──
  let lock: string | undefined;
  let ledger: CostLedger | undefined;
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
  let destructiveInFlight = false;
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

    const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId, runId: runIdArg }));
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

    const tdeps: TeardownDeps = {
      driver,
      store,
      requestId,
      gitCwd: process.cwd(),
      // The store's own resolution, not a second copy of the same `?? env ??
      // default` chain: the lock guards `<store.dir>/<runId>.lock`, so the
      // bundle/artifact paths must be under exactly that directory.
      runsDir: store.dir,
    };
    if (verb === "harvest") {
      // D8: harvest is credential-free — no keyApi is built.
      const res = await harvestRun(tdeps, runIdArg);
      // Through `reportCompletion`, not a bare `emit` (see it): the harvest
      // has already run, so a lost result line is 6, never a retryable 1.
      code = reportCompletion(
        res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n",
      )
        ? 0
        : 6;
    } else {
      // Set by the branch below, read after the teardown: a possibly-live key
      // this teardown provably cannot revoke is not a success, and it cannot be
      // reported until the box half has actually run.
      let keyUnattributable = false;
      if (rec.keyHash !== undefined) {
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
      ledger = asUsage(
        () =>
          new CostLedger({
            ...costLedgerOpts(store.dir),
            // FP1 (round 10): orphan-expiry stat probes target THIS store's
            // runs dir (see makeLedgerFactory twin).
            runsDir: store.dir,
            readRunRecord: (id: string) => {
              try {
                const r = getRecord({ store }, id);
                return {
                  createdAt: r.createdAt,
                  closedAt: r.closedAt,
                  keyHash: r.keyHash,
                  limitMicroUsd: r.limitMicroUsd,
                };
              } catch (e) {
                if ((e as HarvestError | null)?.code === "no-record") return undefined;
                throw e;
              }
            },
          }),
      );
      tdeps.costLedger = ledger;
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
      let marked = true;
      try {
        markRunLockDestructive(lock);
      } catch (e) {
        marked = false;
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
        return finish(requestId, verb, runIdArg, 6);
      }
      destructiveInFlight = true;
      await teardownSandbox(tdeps, runIdArg, { noHarvest });
      // The destructive sequence completed: box destroyed, key revoked (or
      // named as unrevokable above), record closed. From here the lock is safe
      // to release — there is no half-torn-down state left for it to guard, and
      // this is the ONLY place that can say so: from inside the release,
      // "the caller reached its finally" looks the same whether
      // `teardownSandbox` returned or threw.
      destructiveInFlight = false;
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
      // a teardown that may never have happened.
      const reportedLanding = reportCompletion(
        ...(noHarvest ? [`teardown.harvest_waived ${runIdArg}\n`] : []),
        `torn down: ${runIdArg}\n`,
      );
      // NOT 0. The box is gone and the record is closed, so the verb's own work
      // landed — but a key that may still be minting spend was not revoked and
      // this CLI cannot find it. `torn down:` + exit 0 is what `fleet teardown
      // … || alert` reads as "nothing left running", which is the one thing
      // that is not true here. The file resolves the identical "the answer
      // above may be wrong" condition the same way twice in `status`
      // (`listUnavailable` → 1, `skippedRecords` → 2): exit 0 lies to
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
      code = keyUnattributable || !markCleared || !reportedLanding ? 6 : 0;
    }
  } catch (e) {
    code = report(note, e);
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
    if (ledger !== undefined) {
      try {
        ledger.close();
      } catch (e) {
        // Same normalization as the ack arm: a null/undefined rejection here
        // would throw a TypeError from INSIDE this catch, escaping the cleanup
        // policy and hiding the original close failure under a crash.
        printError(
          note,
          "ledger-close-failed",
          `could not close the cost ledger: ${redactSecrets(errText(e))}`,
          "the handle dies with the process; re-run to confirm it still reads",
        );
        cleanupFailed();
      }
    }
    // releaseRunLock re-reads the body and unlinks it only while it is still
    // this invocation's claim, so a refused invocation — or one whose lock was
    // cleared and re-taken — never unlinks a live holder's file.
    if (lock !== undefined && destructiveInFlight) {
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
          destructiveInFlight = false; // nothing left to guard — plain release below
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
    if (lock !== undefined && !destructiveInFlight) {
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
