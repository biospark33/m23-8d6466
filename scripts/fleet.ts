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
 * guard fired).
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
 *  - the teardown sequence itself is `teardownSandbox`, one implementation.
 *
 * What is NOT shared is each CLI's own surface: argv grammar, exit-code table
 * (this one is 0-5; sandbox-teardown's is 0/1), error rendering (JSON envelopes
 * here, `!! code:` lines there) and the operator vocabulary in the lock refusal.
 * Those differ deliberately, and folding the two `run()` bodies into one would
 * have to re-introduce them as branches on a caller flag — the duplication that
 * remains is the part that is supposed to differ.
 */
import { readFileSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  CostLedger,
  DEFAULT_COST_CONFIG_FILE,
  DEFAULT_COST_LEDGER_FILE,
  loadCostConfig,
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
import { acquireRunLock, releaseRunLock } from "./lib/run-lock.ts";
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
// `--help` rides along harmlessly: `run` answers it from argv before parsing.
const BOOL_FLAGS = flagNames(true);

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
 * `--dir` moves the whole `.sandbox/` set together. The ledger and the cost
 * config are SIBLINGS of the records directory, so without this a --dir-scoped
 * run reserved its budget against one ledger at dispatch and settled its box
 * hours against another at teardown — whichever the operator's cwd happened to
 * name. Both call sites resolve through here so the two halves of a run's
 * money can never land in different files.
 *
 * The store's own resolution, one level up from store.dir, exactly as runsDir
 * is derived. With no --dir nothing is passed: CostLedger's env tier
 * ($QDS_COST_LEDGER_FILE / $QDS_COST_CONFIG_FILE) and its cwd-relative
 * defaults stand unchanged, so a default install looks where it always did.
 */
function costLedgerOpts(dir: string | undefined, storeDir: string) {
  if (dir === undefined) return {};
  const sandboxDir = dirname(storeDir);
  return {
    path: join(sandboxDir, basename(DEFAULT_COST_LEDGER_FILE)),
    // An absent cost-config.json under --dir falls back to DEFAULT_COST_CONFIG
    // (loadCostConfig maps ENOENT to defaults); an unreadable one still throws.
    config: loadCostConfig(join(sandboxDir, basename(DEFAULT_COST_CONFIG_FILE))).config,
  };
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

/** Render any throw as the envelope + this CLI's exit code. */
function report(err: (s: string) => void, e: unknown): number {
  if (e instanceof FleetError) {
    printError(err, e.code, e.message, e.remediation, e.payload);
    return e.exitCode;
  }
  // Non-Error rejections normalize to {} so the printer cannot itself throw
  // while reporting one.
  const x = (e ?? {}) as { code?: string; message?: string; remediation?: string };
  printError(err, x.code ?? "error", x.message ?? String(e), x.remediation);
  return 1;
}

interface Parsed {
  entry: VerbEntry;
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/**
 * argv → verb + validated flags. Every parser failure becomes a usage
 * FleetError (exit 2 with an envelope) rather than escaping run() as a bare
 * throw the top-level catch turns into a silent exit 1.
 */
function parseArgv(argv: readonly string[]): Parsed {
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
  const verb = positionals[0];
  // A bare `fleet` is a mistyped invocation, not a help request: the exit
  // table says usage = 2, and `fleet --help` is the way to ask for help.
  if (verb === undefined) throw usageError("no verb given", HELP);

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
  // trusting, and only a regular file can be refused before it is opened.
  if (!st.isFile()) throw unreadable("not a regular file");
  if (st.size > MAX_BRIEF_BYTES) {
    throw new FleetError(
      2,
      "brief-too-large",
      `brief is ${st.size} bytes; the cap is ${MAX_BRIEF_BYTES}`,
      "trim the brief or split payload out of it",
    );
  }
  try {
    return readFileSync(briefPath, "utf8");
  } catch (e) {
    throw unreadable((e as NodeJS.ErrnoException).code ?? (e as Error).message);
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
 * 2-5 are the operator's brief, flags, id or budget: retrying is futile.
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
    runId: runId ?? null,
    verb,
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
  // Help wins over every other reading of argv, so `fleet <verb> --help`
  // (which renderHelp advertises) answers with usage instead of a refusal.
  if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    out(`${HELP}\n`);
    return 0;
  }

  let parsed: Parsed;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    return report(err, e);
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
        port = Number(portRaw);
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
      const driver = deps?.driver ?? resolveDriver(driverName as string, { requestId });
      const store = deps?.store ?? new RunRecordStore({ ...storeOpts, requestId });
      const ledgerFactory =
        deps?.ledgerFactory ??
        ((): LedgerLike => {
          // Mirrors createRun's wiring: only a genuine missing record reads as
          // undefined; every other read failure refuses the dispatch.
          const ledger = new CostLedger({
            ...costLedgerOpts(dir, store.dir),
            readRunRecord: (id: string) => {
              try {
                return store.get(id);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
        keyApi: deps?.keyApi ?? openRouterKeyApi(),
        store,
        ledgerFactory,
        requestId,
        ...(port === undefined ? {} : { port }),
      };

      const ack = await dispatch(briefJson, dispatchDeps);
      out(`${JSON.stringify(ack)}\n`);
      return logVerb(requestId, verb, ack.runId, startedAt, 0);
    } catch (e) {
      // resolveDriver, RunRecordStore and openRouterKeyApi throw typed errors
      // with their own remediation; constructing them inside the try is what
      // keeps that fidelity in the envelope instead of a bare exit 1.
      //
      // CC-9: dispatch is a verb like any other, so it logs its one line on
      // BOTH exits. `dispatch()` emits its own resolved/ready/refused lines —
      // those are the run's; this is the invocation's, and the other three
      // verbs would be the only ones with it otherwise. A refusal that fired
      // before the brief resolved has no correlation id to report, so one is
      // minted for the invocation rather than a run's id forged for it.
      return logVerb(
        dispatchRequestId ?? newRequestId(),
        verb,
        runIdFromError(e),
        startedAt,
        report(err, e),
      );
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
      // id must not reach the store as an untyped path error.
      if (runIdArg !== undefined) assertFleetRunId(runIdArg);
      assertDriverChosen("status", driverName, deps?.driver);
      const driver = deps?.driver ?? resolveDriver(driverName as string, { requestId });
      const store = deps?.store ?? new RunRecordStore({ ...storeOpts, requestId });
      const statusDeps = { driver, store };
      const rows = runIdArg === undefined ? await statusAll(statusDeps) : [await statusRun(statusDeps, runIdArg)];
      for (const row of rows) out(`${JSON.stringify(row)}\n`);
      return logVerb(requestId, verb, runIdArg, startedAt, 0); // no runs is a state, not an error (AC4)
    } catch (e) {
      return logVerb(requestId, verb, runIdArg, startedAt, report(err, e));
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
    assertFleetRunId(runIdArg);
    // Before the lock and before the record read: a refusal here has mutated
    // nothing, so there is no lock to release and no box left half-torn-down.
    assertDriverChosen(verb, driverName, deps?.driver);

    const driver = deps?.driver ?? resolveDriver(driverName as string, { requestId, runId: runIdArg });
    const store = deps?.store ?? new RunRecordStore({ ...storeOpts, requestId });
    // The lock comes BEFORE the record read: reading first is a check-then-act
    // across the lock boundary — a concurrent teardown closes the run and
    // revokes its key while we hold a record that still names the keyHash.
    lock = acquireRunLock(store.dir, runIdArg);

    let rec: RunRecord;
    try {
      rec = getRecord({ store }, runIdArg);
    } catch (e) {
      const err2 = e as HarvestError;
      if (err2.code === "no-record") {
        throw new FleetError(
          4,
          "run-not-found",
          `no run record for ${runIdArg}`,
          "check the id (fleet status) — nothing was mutated",
        );
      }
      throw e;
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
      out(res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n");
      code = 0;
    } else {
      if (rec.keyHash !== undefined) tdeps.keyApi = deps?.keyApi ?? openRouterKeyApi();
      ledger = new CostLedger({
        ...costLedgerOpts(dir, store.dir),
        readRunRecord: (id: string) => {
          try {
            const r = getRecord({ store }, id);
            return { createdAt: r.createdAt, closedAt: r.closedAt, keyHash: r.keyHash, limitMicroUsd: r.limitMicroUsd };
          } catch (e) {
            if ((e as HarvestError).code === "no-record") return undefined;
            throw e;
          }
        },
      });
      tdeps.costLedger = ledger;
      const noHarvest = bools.has("--no-harvest");
      await teardownSandbox(tdeps, runIdArg, { noHarvest });
      // Reported AFTER the teardown ran: printed first, it claims a waiver for
      // a teardown that may never have happened.
      if (noHarvest) out(`teardown.harvest_waived ${runIdArg}\n`);
      out(`torn down: ${runIdArg}\n`);
      code = 0;
    }
  } catch (e) {
    code = report(err, e);
  } finally {
    if (ledger !== undefined) {
      try {
        ledger.close();
      } catch (e) {
        printError(
          err,
          "ledger-close-failed",
          `could not close the cost ledger: ${(e as Error).message}`,
          "the handle dies with the process; re-run to confirm it still reads",
        );
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
          err,
          "lock-release-failed",
          `could not release ${lock}: ${(e as Error).message}`,
          `rm ${lock} by hand once no other invocation holds it — until then every later harvest or teardown of this run refuses`,
        );
        code = 1;
      }
    }
  }
  return logVerb(requestId, verb, runIdArg, startedAt, code);
}

/** writeSync can write short; a truncated ack is worse than a slow one. */
function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

if (import.meta.main) {
  try {
    // stdout = output only; diagnostics stream as JSON lines on stderr.
    setLogSink((entry) => {
      writeAll(2, `${JSON.stringify(entry)}\n`);
    });
    process.exit(
      await run(
        process.argv.slice(2),
        (s) => writeAll(1, s),
        undefined,
        (s) => writeAll(2, s),
      ),
    );
  } catch (e) {
    // A non-Error throw printed `undefined` and told the operator nothing.
    writeAll(2, `${(e as Error)?.message ?? String(e)}\n`);
    process.exit(1);
  }
}
