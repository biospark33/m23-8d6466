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
import { closeSync, fstatSync, openSync, readSync, statSync, writeSync } from "node:fs";

import {
  CostLedger,
  getRecord,
  harvestRun,
  openRouterKeyApi,
  resolveDriver,
  teardownSandbox,
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
import { log, setLogSink, newRequestId } from "../src/swarmclaw/log.ts";
import {
  assertFleetRunId,
  dispatch,
  FleetError,
  resolveBriefRequestId,
  type DispatchDeps,
  type LedgerLike,
} from "../src/fleet/dispatch.ts";
import { listVerbs, renderHelp, type VerbEntry } from "../src/fleet/verbs.ts";
import { statusAll, statusRun } from "../src/fleet/status.ts";
import type { KeyApi } from "../src/providers/credentials.ts";
import type { ExitStatus } from "../cli-anything/src/types.ts";

const HELP = renderHelp(listVerbs());

/** Brief ingress cap (story Guards): 64 KiB from stdin or --brief <path>. */
const MAX_BRIEF_BYTES = 64 * 1024;

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
    throw usageError(
      `--dir ${dir} does not exist: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
      "point --dir at the records directory the run was dispatched with — this verb never creates one",
    );
  }
  if (!st.isDirectory()) throw usageError(`--dir ${dir} is not a directory`, "point --dir at the records directory");
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
 * Redaction happens at the two places FOREIGN text enters this file (`asUsage`
 * and `report`'s untyped branch), not here. Doing it here instead covers one
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
 * This is one of the two places text this file did not compose becomes text it
 * PRINTS, so it is one of the two places `redactSecrets` belongs (the other is
 * `report`'s untyped branch). A driver constructor or `openRouterKeyApi()` that
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
  printError(err, x.code ?? "error", redactSecrets(x.message ?? e), remediation, debris);
  return 1;
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
    throw usageError((e as Error).message, HELP);
  }
  const { positionals, flagTokens, bools } = tokens;
  // The other half of the duplicate-flag guard below. `bools` is a Set, so
  // `--no-harvest --no-harvest` collapsed into one silently — and --no-harvest
  // is the flag that WAIVES artifact capture, so a repeated one is exactly the
  // invocation an operator must be sure they typed. Scanned over raw argv
  // because the Set has already lost the count; a bool token can never be a
  // positional (run ids never start with `-`) nor a value (the space form
  // refuses a `--`-prefixed value, cli-args.ts).
  const seenBool = new Set<string>();
  for (const a of argv) {
    if (!BOOL_FLAGS.includes(a)) continue;
    if (seenBool.has(a)) throw usageError(`${a} given more than once`, HELP);
    seenBool.add(a);
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
      help: [HELP],
    });
  } catch (e) {
    throw usageError((e as Error).message, HELP);
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
    throw new FleetError(2, "unknown-verb", `unknown verb ${JSON.stringify(verb)}`, HELP);
  }
  // AC6 parity in BOTH directions: the registry says which flags a verb takes,
  // so `fleet status --brief x` is refused rather than silently accepted.
  const allowed = new Set(entry.flags.map((f) => f.name));
  for (const flag of [...flags.keys(), ...bools]) {
    if (!allowed.has(flag)) {
      const list = [...allowed].join(" ");
      throw usageError(`${verb} does not take ${flag}`, `flags for ${verb}: ${list === "" ? "(none)" : list}`);
    }
  }
  return { entry, positionals, flags, bools };
}

/** Read stdin, refusing AS IT STREAMS — buffering first turns `yes |` into an OOM. */
async function readCappedStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of Bun.stdin.stream()) {
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `--brief <path>`: a regular file, under the cap, with the errno named. */
function readBriefFile(briefPath: string): string {
  const unreadable = (why: string): FleetError =>
    new FleetError(
      2,
      "brief-unreadable",
      `cannot read --brief ${briefPath}: ${why}`,
      "point --brief at a readable regular JSON file",
    );
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(briefPath);
  } catch (e) {
    // ENOENT / EACCES / ELOOP are not "invalid JSON" — the file was never read.
    throw unreadable((e as NodeJS.ErrnoException).code ?? (e as Error).message);
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
    throw unreadable((e as NodeJS.ErrnoException).code ?? (e as Error).message);
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
        throw unreadable((e as NodeJS.ErrnoException).code ?? (e as Error).message);
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
 * shape replaces. The first version refused fifo-or-regular-file and allowed
 * everything else, which quietly allowed a SOCKET — and a socket is what fd 0
 * is under any Node/Bun parent spawning with `stdio: "pipe"`, i.e. the most
 * common programmatic caller there is. Enumerating the dangerous types means
 * the next stdio type someone invents is allowed by default; enumerating the
 * benign ones means it is refused by default, which is the direction a guard
 * on a billable path should fail.
 *
 * Benign, and the complete list: a character device — `/dev/null` (cron,
 * systemd, containers) and a tty (an operator who typed the command and
 * redirected nothing) are both one — and a closed fd 0, where `fstat` throws
 * EBADF. Everything else (fifo, regular file, socket) is a brief someone
 * deliberately attached to this process.
 */
function assertOneBriefSource(briefPath: string): void {
  let st: ReturnType<typeof fstatSync>;
  try {
    st = fstatSync(0);
  } catch {
    return; // no fd 0 at all — nothing was attached
  }
  if (st.isCharacterDevice()) return;
  throw usageError(
    `--brief ${briefPath} was given AND a brief was redirected onto stdin`,
    "pass the brief exactly one way: `--brief <path>`, or on stdin with no --brief",
  );
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
 */
function logVerb(requestId: string, verb: string, runId: string | undefined, startedAt: number, code: number): number {
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
    phase: "complete",
    exitCode: code,
    exitStatus: (code === 0 ? "success" : code === 1 ? "transient" : "logic") as ExitStatus,
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
  const emit = (s: string): void => {
    try {
      out(s);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException | null)?.code ?? "";
      if (errno === "EPIPE") return;
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
  const finish = (rid: string, v: string, runId: string | undefined, code: number): number =>
    logVerb(rid, v, runId, startedAt, code === 0 && outputIncomplete ? 6 : code);
  // The ONE pre-tokenization reading of argv: `fleet help` names no verb to
  // tokenize against. Anchored to argv[0], so it cannot fire from a stray token
  // inside a destructive invocation the way `argv.includes("--help")` did.
  //
  // Logged like every other invocation (CC-9: "every verb logs one structured
  // line"). Help used to be the exception, which made `fleet teardown <id>
  // --driver real --help` — an operator who meant to destroy a box and did not
  // — the one invocation a dashboard could not see at all.
  if (argv[0] === "help") {
    emit(`${HELP}\n`);
    return finish(newRequestId(), "help", undefined, 0);
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
    emit(`${HELP}\n`);
    // `bounded`, and defaulting to the verb the operator effectively invoked:
    // `fleet --help` names none, and an unbounded `fleet $(200KB) --help` would
    // otherwise put all of it in the field the dashboards key on.
    return finish(newRequestId(), bounded(parsed.verb ?? "help"), undefined, 0);
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
    const interruptHandlers = ([
      ["SIGINT", 130],
      ["SIGTERM", 143],
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
        // exit-code note at the top of this file.
        logVerb(dispatchRequestId ?? newRequestId(), verb, dispatchRunId, startedAt, status);
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
          throw usageError(`--port ${JSON.stringify(portRaw)} is not a TCP port`, "--port takes an integer 1-65535");
        }
      }

      // INV-2: the brief is read and parsed — both side-effect free — before
      // anything is constructed. `new RunRecordStore` mkdirs and chmods the
      // records directory, which is a side effect an invalid brief must not
      // cause.
      const readBrief: () => Promise<string> =
        deps?.readBrief ??
        (async () => {
          if (briefPath !== undefined) {
            assertOneBriefSource(briefPath);
            return readBriefFile(briefPath);
          }
          // No prompt, no timeout: a TTY here means the operator typed `fleet
          // dispatch` and would wait forever for a pipe that never arrives.
          if (process.stdin.isTTY) {
            throw usageError("no brief on stdin", "pipe the brief JSON in, or pass --brief <path>");
          }
          return readCappedStdin();
        });

      let briefJson: unknown;
      const rawBrief = await readBrief();
      // The cap is on BYTES whichever source produced the text — `.length`
      // counts UTF-16 code units, which under-measures every non-ASCII brief.
      // Skipped when the decode was LOSSY: TextDecoder maps each invalid UTF-8
      // byte to U+FFFD, which re-encodes as THREE bytes, so a corrupt brief
      // measured here could exceed a cap its RAW bytes had already passed —
      // and both real readers cap raw bytes as they read. Replacement chars
      // are proof this count no longer describes what arrived; without one the
      // decode round-trips exactly and the measurement binds (which is what
      // still bounds an injected reader that bypasses both real caps).
      if (!rawBrief.includes("\u{FFFD}")) {
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
        briefJson = JSON.parse(rawBrief);
      } catch (e) {
        throw new FleetError(
          2,
          "invalid-brief",
          `brief is not valid JSON: ${(e as Error).message}`,
          "fix the JSON on stdin or in --brief <path>",
        );
      }

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
      const ledgerFactory =
        deps?.ledgerFactory ??
        ((): LedgerLike => {
          // Mirrors createRun's wiring: only a genuine missing record reads as
          // undefined; every other read failure refuses the dispatch.
          //
          // NOT wrapped in `asUsage`, unlike the teardown path's construction:
          // this factory is called from inside `dispatch()`'s admission try,
          // which already maps an unopenable or busy ledger to its exit-5
          // `admission-failed` refusal. Wrapping here would only relabel the
          // message on its way there.
          const ledger = new CostLedger({
            ...costLedgerOpts(store.dir),
            readRunRecord: (id: string) => {
              try {
                return store.get(id);
              } catch (e) {
                // Optional-chained: a `throw null` must not become a TypeError
                // in the handler that is supposed to classify it.
                if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
                throw e;
              }
            },
          });
          return ledger as unknown as LedgerLike;
        });
      // `readBrief` is the CLI's own seam; everything left is a DispatchDeps
      // seam forwarded verbatim, so one added there is never silently dropped.
      // The explicit keys below win over the spread.
      const { readBrief: _readBrief, ...seams } = deps ?? {};
      const dispatchDeps: DispatchDeps = {
        ...seams,
        driver,
        keyApi: deps?.keyApi ?? (briefCanMint ? asUsage(() => openRouterKeyApi()) : unusedKeyApi()),
        store,
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
        printError(
          note,
          "ack-unwritable",
          `the box for ${ack.runId} is live but its ack could not be written to stdout: ${(e as Error).message}`,
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
        printError(
          note,
          "records-skipped",
          `${skipped.length} record file(s) could not be read: the rows above are not the whole fleet`,
          "repair or remove the files named in skippedRecords, then re-run `fleet status` — nothing clears this on its own",
          { skippedRecords: skipped },
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
    const store = deps?.store ?? asUsage(() => new RunRecordStore({ ...storeOpts, requestId }));

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
      throw e;
    };

    // AC4: a run that does not exist must exit 4 having mutated NOTHING. The
    // lock is a real file — created, fsynced, and (on a crash before the
    // finally) left behind for a phantom run, while a concurrent invocation
    // sees the run as busy. So probe first, cheaply, and refuse before the
    // filesystem is touched.
    try {
      getRecord({ store }, runIdArg);
    } catch (e) {
      throw notFound(e);
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
      emit(res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n");
      code = 0;
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
      // Past this point an interrupt must NOT drop the lock: `teardownSandbox`
      // destroys the box, revokes the key and closes the record, and a Ctrl-C
      // partway through leaves a state only an operator can judge. Automatic
      // release would hand it straight to the next teardown, which would re-run
      // against a half-torn-down run.
      markRunLockDestructive(lock);
      destructiveInFlight = true;
      await teardownSandbox(tdeps, runIdArg, { noHarvest });
      // The destructive sequence completed: box destroyed, key revoked (or
      // named as unrevokable above), record closed. From here the lock is safe
      // to release — there is no half-torn-down state left for it to guard, and
      // this is the ONLY place that can say so: from inside the release,
      // "the caller reached its finally" looks the same whether
      // `teardownSandbox` returned or threw.
      destructiveInFlight = false;
      clearRunLockDestructive(lock);
      // Reported AFTER the teardown ran: printed first, it claims a waiver for
      // a teardown that may never have happened.
      if (noHarvest) emit(`teardown.harvest_waived ${runIdArg}\n`);
      emit(`torn down: ${runIdArg}\n`);
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
      // declared set (src/fleet/verbs.ts) already.
      code = keyUnattributable ? 6 : 0;
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
        printError(
          note,
          "ledger-close-failed",
          `could not close the cost ledger: ${(e as Error).message}`,
          "the handle dies with the process; re-run to confirm it still reads",
        );
        cleanupFailed();
      }
    }
    // releaseRunLock re-reads the body and unlinks it only while it is still
    // this invocation's claim, so a refused invocation — or one whose lock was
    // cleared and re-taken — never unlinks a live holder's file.
    if (lock !== undefined && destructiveInFlight) {
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
    } else if (lock !== undefined) {
      try {
        releaseRunLock(lock);
      } catch (e) {
        printError(
          note,
          "lock-release-failed",
          `could not release ${lock}: ${(e as Error).message}`,
          `rm ${lock} by hand once no other invocation holds it — until then every later harvest or teardown of this run refuses`,
        );
        cleanupFailed();
      }
    }
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
