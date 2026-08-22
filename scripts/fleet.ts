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
 * guard fired) · 6 the verb succeeded but a cleanup after it did not (the
 * ledger would not close, or the run lock would not release — the run is left
 * wedged and retrying the verb cannot help).
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
 * (this one is 0-5; sandbox-teardown's is 0/1), error rendering (JSON envelopes
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
import { RunRecordStore } from "../src/providers/index.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { costLedgerOpts } from "./lib/cost-ledger-opts.ts";
import { acquireRunLock, markRunLockDestructive, releaseRunLock, RunLockedError } from "./lib/run-lock.ts";
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
 * One JSON line per refusal. The envelope fields are written LAST so a typed
 * payload (assertionCode, DF2.8 fields, reason…) can never overwrite the
 * `code`/`message` the caller switches on.
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
 * automation reading `exitStatus` retried them forever. Message and remediation
 * are preserved verbatim; only the classification changes.
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
    throw usageError(x.message ?? String(e), x.remediation ?? HELP);
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
    return Number.isInteger(e.exitCode) && e.exitCode >= 0 && e.exitCode <= 6 ? e.exitCode : 1;
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
  const cause = (x.cause ?? undefined) as { message?: string } | undefined;
  const debris =
    x.code !== undefined
      ? undefined
      : {
          ...(typeof x.stack === "string" ? { stack: x.stack } : {}),
          ...(cause === undefined ? {} : { cause: cause.message ?? String(x.cause) }),
        };
  printError(err, x.code ?? "error", x.message ?? String(e), x.remediation, debris);
  return 1;
}

interface Parsed {
  help?: false;
  entry: VerbEntry;
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/** A help request survives parsing intact; nothing else about argv matters. */
type ParseResult = Parsed | { help: true };

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
  if (bools.has("--help")) return { help: true };

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
 */
const MAX_ECHO = 96;
function bounded(s: string | undefined): string {
  if (s === undefined) return "(none)";
  return s.length <= MAX_ECHO ? s : `${s.slice(0, MAX_ECHO)}…(${s.length} chars)`;
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
   * Output writes, EPIPE-tolerant.
   *
   * `fleet teardown <id> | head -1` closes the pipe the moment head has its
   * line, so `out()` — `writeAll(1, …)` under `import.meta.main` — throws
   * EPIPE. Inside the verb's `try` that throw became `code = report(note, e)` =
   * 1, which `logVerb` stamps `transient`: automation RETRIED a destructive
   * verb that had already succeeded. Every write here describes work that is
   * already done, and a reader who hung up cannot be told anything either way,
   * so a broken pipe is not the verb's outcome. EAGAIN/EWOULDBLOCK rides along:
   * an fd 1 the caller left non-blocking (a CI runner, a wrapper) refuses the
   * bytes exactly the way a hung-up reader does, and a *completed* destructive
   * teardown must not become exit 1 `transient` because of it either. ENOSPC or
   * a bad fd is a real write failure and still throws.
   *
   * NOT used for the dispatch ack — see the write there.
   */
  const tolerated = new Set(["EPIPE", "EAGAIN", "EWOULDBLOCK"]);
  const emit = (s: string): void => {
    try {
      out(s);
    } catch (e) {
      if (!tolerated.has((e as NodeJS.ErrnoException | null)?.code ?? "")) throw e;
    }
  };
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
  // The ONE pre-tokenization reading of argv: `fleet help` names no verb to
  // tokenize against. Anchored to argv[0], so it cannot fire from a stray token
  // inside a destructive invocation the way `argv.includes("--help")` did.
  if (argv[0] === "help") {
    emit(`${HELP}\n`);
    return 0;
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
    return logVerb(newRequestId(), attempted, undefined, startedAt, report(note, e));
  }
  if (parsed.help === true) {
    emit(`${HELP}\n`);
    return 0;
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
     */
    const interruptHandlers = ([
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const).map(([sig, status]) => {
      const handler = (): void => {
        printError(
          note,
          "dispatch-interrupted",
          "interrupted during dispatch: a box may have been provisioned with no run record",
          "check the provider for an unattributed box — INV-5 forbids this CLI destroying one it cannot attribute",
        );
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
          if (briefPath !== undefined) return readBriefFile(briefPath);
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
      const briefBytes = Buffer.byteLength(rawBrief, "utf8");
      if (briefBytes > MAX_BRIEF_BYTES) {
        throw new FleetError(
          2,
          "brief-too-large",
          `brief is ${briefBytes} bytes; the cap is ${MAX_BRIEF_BYTES}`,
          "trim the brief or split payload out of it",
        );
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
      const store = deps?.store ?? asUsage(() => new RunRecordStore({ ...storeOpts, requestId }));
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
      const briefCanMint = BriefSchema.safeParse(briefJson).success;
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
    return logVerb(dispatchRequestId ?? newRequestId(), verb, dispatchRunId, startedAt, dispatchCode);
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
      // id must not reach the store as an untyped path error.
      if (runIdArg !== undefined) assertFleetRunId(bounded(runIdArg));
      assertDriverChosen("status", driverName, deps?.driver);
      const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId }));
      const store = deps?.store ?? asUsage(() => new RunRecordStore({ ...storeOpts, requestId }));
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
      return logVerb(requestId, verb, runIdArg, startedAt, skipped.length > 0 ? 2 : listFailed ? 1 : 0);
    } catch (e) {
      return logVerb(requestId, verb, runIdArg, startedAt, report(note, e));
    }
  }

  // ── harvest / teardown (AC5: thin front doors onto DF2.5, guards intact) ──
  let lock: string | undefined;
  let ledger: CostLedger | undefined;
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
    // `bounded`, because the refusal ECHOES the id: `assertValidRunId`'s message
    // quotes what it rejected, and `fleet teardown $(200KB)` put all of it in
    // the envelope. A capped id fails the same grammar (nothing ≤ 63 chars is
    // changed by the cap), so the check is identical and the echo is not.
    assertFleetRunId(bounded(runIdArg));
    // Before the lock and before the record read: a refusal here has mutated
    // nothing, so there is no lock to release and no box left half-torn-down.
    assertDriverChosen(verb, driverName, deps?.driver);

    const driver = deps?.driver ?? asUsage(() => resolveDriver(driverName as string, { requestId, runId: runIdArg }));
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
      if (rec.keyHash !== undefined) {
        tdeps.keyApi = deps?.keyApi ?? asUsage(() => openRouterKeyApi());
      } else if (rec.vmName !== undefined && rec.closedAt === undefined) {
        // Absence of `keyHash` is NOT proof that no key exists. `dispatch`
        // provisions the box first and persists the keyHash after minting, so a
        // crash in between leaves exactly this record: a box that existed, an
        // open run, and no surviving pointer to a key that is still billing.
        // The teardown below is correct for the box and silent about the key,
        // and `torn down:` + exit 0 reads as "nothing left running".
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
      await teardownSandbox(tdeps, runIdArg, { noHarvest });
      // Reported AFTER the teardown ran: printed first, it claims a waiver for
      // a teardown that may never have happened.
      if (noHarvest) emit(`teardown.harvest_waived ${runIdArg}\n`);
      emit(`torn down: ${runIdArg}\n`);
      code = 0;
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
    if (lock !== undefined) {
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
  return logVerb(requestId, verb, runIdArg, startedAt, code);
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
