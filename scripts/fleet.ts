#!/usr/bin/env bun
/**
 * fleet — the factory's front door (Story DF3.1, D3/DD-1).
 *
 * Four verbs over the tested provider layer: dispatch, status, harvest,
 * teardown. The verb table and --help render from src/fleet/verbs.ts's
 * registry (AC6) — no second list lives here. Exit codes (this CLI's own
 * table, F3): 0 success · 1 run/provider failure · 2 usage/schema ·
 * 3 setup-gate failure (assertion code in the payload) · 4 run-not-found ·
 * 5 refused before provisioning (payload code says which guard fired).
 *
 * Harvest/teardown are thin, guard-preserving front doors onto DF2.5
 * (AC5): verify-before-fetch, the refs/sandbox/ refspec and the fixed
 * teardown order all stay inside harvestRun/teardownSandbox; the per-run
 * invocation lock is shared with DF2.5's CLI (scripts/lib/run-lock.ts) so
 * both entry points enforce identical teardown safety semantics.
 */
import { writeSync } from "node:fs";
import { readFileSync, rmSync, statSync } from "node:fs";


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
import { acquireRunLock } from "./lib/run-lock.ts";
import { setLogSink, newRequestId } from "../src/swarmclaw/log.ts";
import { dispatch, FleetError, type DispatchDeps, type LedgerLike } from "../src/fleet/dispatch.ts";
import { listVerbs, renderHelp } from "../src/fleet/verbs.ts";
import { statusAll, statusRun } from "../src/fleet/status.ts";
import type { KeyApi } from "../src/providers/credentials.ts";

const HELP = renderHelp(listVerbs());

/** Brief ingress cap (story Guards): 64 KiB from stdin or --brief <path>. */
const MAX_BRIEF_BYTES = 64 * 1024;

const VALUE_FLAGS = ["--driver", "--brief", "--dir"];
const BOOL_FLAGS = ["--no-harvest"];

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Injectable seams (repo DI idiom; tests override without module mocks). */
export interface FleetDeps {
  driver: ProviderDriver;
  keyApi: KeyApi;
  store: RunRecordStore;
  ledgerFactory: () => LedgerLike;
  readBrief: () => Promise<string>;
}

function usage(out: (s: string) => void): number {
  out(HELP);
  out("\n");
  return 0;
}

function printError(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  const payload: Record<string, unknown> = { code, message };
  if (remediation !== undefined) payload.remediation = remediation;
  out(`${JSON.stringify(payload)}\n`);
}

export async function run(
  argv: readonly string[],
  out: (s: string) => void,
  deps?: Partial<FleetDeps>,
): Promise<number> {
  const { positionals, flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: BOOL_FLAGS,
    rejectStraySingleDash: true,
  });

  const verb = positionals[0];
  if (verb === undefined) return usage(out);

  let driverName = "fake";
  let briefPath: string | undefined;
  let dir: string | undefined;
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (flag === "--driver") driverName = value;
      else if (flag === "--brief") briefPath = value;
      else if (flag === "--dir") dir = value;
    },
    help: [HELP],
  });

  const requestId = newRequestId();

  // ── dispatch ────────────────────────────────────────────────────────────────
  if (verb === "dispatch") {
    if (positionals.length > 1) {
      printError(out, "usage", "dispatch takes no positional arguments", "pass the brief on stdin or via --brief <path>");
      return 2;
    }
    const readBrief: () => Promise<string> =
      deps?.readBrief ??
      (async () => {
        const raw =
          briefPath === undefined
            ? await Bun.stdin.text()
            : (() => {
                // stat, not read-then-measure: the cap is on bytes, and a
                // path-sourced brief is refused before it is ever parsed.
                const size = statSync(briefPath).size;
                if (size > MAX_BRIEF_BYTES) {
                  throw new FleetError(
                    2,
                    "brief-too-large",
                    `brief is ${size} bytes; the cap is ${MAX_BRIEF_BYTES}`,
                    "trim the brief or split payload out of it",
                  );
                }
                return readFileSync(briefPath, "utf8");
              })();
        if (raw.length > MAX_BRIEF_BYTES) {
          throw new FleetError(
            2,
            "brief-too-large",
            `brief is ${raw.length} bytes; the cap is ${MAX_BRIEF_BYTES}`,
            "trim the brief or split payload out of it",
          );
        }
        return raw;
      });

    let briefJson: unknown;
    try {
      const rawBrief = await readBrief();
      // 64 KiB cap on the INGRESS text whichever source produced it (stdin,
      // --brief path, or an injected test seam).
      if (rawBrief.length > MAX_BRIEF_BYTES) {
        printError(
          out,
          "brief-too-large",
          `brief is ${rawBrief.length} bytes; the cap is ${MAX_BRIEF_BYTES}`,
          "trim the brief or split payload out of it",
        );
        return 2;
      }
      briefJson = JSON.parse(rawBrief);
    } catch (e) {
      // readBrief's own guard throws FleetError (brief-too-large) before any
      // parsing happens — re-emit it as itself, never as a JSON parse error.
      if (e instanceof FleetError) {
        printError(out, e.code, e.message, e.remediation);
        return e.exitCode;
      }
      printError(out, "invalid-brief", `brief is not valid JSON: ${(e as Error).message}`, "fix the JSON on stdin or in --brief <path>");
      return 2;
    }

    const driver = deps?.driver ?? resolveDriver(driverName, { requestId });
    const store = deps?.store ?? new RunRecordStore({ ...(dir === undefined ? {} : { dir }), requestId });
    const ledgerFactory =
      deps?.ledgerFactory ??
      ((): LedgerLike => {
        // Mirrors createRun's wiring: only a genuine missing record reads as
        // undefined; every other read failure refuses the dispatch.
        const ledger = new CostLedger({
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
    const dispatchDeps: DispatchDeps = {
      driver,
      keyApi: deps?.keyApi ?? openRouterKeyApi(),
      store,
      ledgerFactory,
    };

    try {
      const ack = await dispatch(briefJson, dispatchDeps);
      out(`${JSON.stringify(ack)}\n`);
      return 0;
    } catch (e) {
      if (e instanceof FleetError) {
        // One JSON line: the error envelope merged with the typed payload
        // (assertionCode, DF2.8 fields, reason…) — never two.
        const payload: Record<string, unknown> = { code: e.code, message: e.message, remediation: e.remediation, ...(e.payload ?? {}) };
        out(`${JSON.stringify(payload)}\n`);
        return e.exitCode;
      }
      const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
      printError(out, err.code ?? "error", err.message ?? String(e), err.remediation);
      return 1;
    }
  }

  // status / harvest / teardown all take an optional-or-required runId.
  const runIdArg = positionals[1];

  // ── status ──────────────────────────────────────────────────────────────────
  if (verb === "status") {
    if (positionals.length > 2) {
      printError(out, "usage", "status takes at most one <run-id>", "fleet status [run-id]");
      return 2;
    }
    const driver = deps?.driver ?? resolveDriver(driverName, { requestId });
    const store = deps?.store ?? new RunRecordStore({ ...(dir === undefined ? {} : { dir }), requestId });
    const statusDeps = { driver, store };
    try {
      const rows = runIdArg === undefined ? await statusAll(statusDeps) : [await statusRun(statusDeps, runIdArg)];
      for (const row of rows) out(`${JSON.stringify(row)}\n`);
      return 0; // no runs is a state, not an error (AC4)
    } catch (e) {
      if (e instanceof FleetError) {
        printError(out, e.code, e.message, e.remediation);
        return e.exitCode;
      }
      const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
      printError(out, err.code ?? "error", err.message ?? String(e), err.remediation);
      return 1;
    }
  }

  // ── harvest / teardown (AC5: thin front doors onto DF2.5, guards intact) ──
  if (verb === "harvest" || verb === "teardown") {
    if (runIdArg === undefined) {
      printError(out, "usage", `${verb} requires <run-id>\n${HELP}`, `fleet ${verb} <run-id>`);
      return 2;
    }
    if (!RUN_ID_RE.test(runIdArg)) {
      printError(out, "invalid-run-id", `invalid run-id: ${JSON.stringify(runIdArg)}`, "run ids match the hostname grammar [a-z0-9][a-z0-9-]*");
      return 2;
    }
    const noHarvest = bools.has("--no-harvest");
    if (verb === "harvest" && noHarvest) {
      printError(out, "usage", "harvest has no harvest gate to waive: --no-harvest is a teardown flag");
      return 2;
    }

    const driver = deps?.driver ?? resolveDriver(driverName, { requestId, runId: runIdArg });
    const store = deps?.store ?? new RunRecordStore({ ...(dir === undefined ? {} : { dir }), requestId });

    let rec: RunRecord;
    try {
      rec = getRecord({ store }, runIdArg);
    } catch (e) {
      const err = e as HarvestError;
      if (err.code === "no-record") {
        printError(out, "run-not-found", `no run record for ${runIdArg}`, "check the id (fleet status) — nothing was mutated");
        return 4;
      }
      printError(out, err.code ?? "record-read-failed", err.message ?? String(e), err.remediation);
      return 1;
    }

    const tdeps: TeardownDeps = {
      driver,
      store,
      requestId,
      gitCwd: process.cwd(),
      ...(dir === undefined ? {} : { runsDir: dir }),
    };
    let lock: string | undefined;
    let ledger: CostLedger | undefined;
    try {
      lock = acquireRunLock(store.dir, runIdArg);
      if (verb === "harvest") {
        // D8: harvest is credential-free — no keyApi is built.
        const res = await harvestRun(tdeps, runIdArg);
        out(res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n");
        return 0;
      }
      if (rec.keyHash !== undefined) tdeps.keyApi = deps?.keyApi ?? openRouterKeyApi();
      ledger = new CostLedger({
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
      if (noHarvest) out(`teardown.harvest_waived ${runIdArg}\n`);
      await teardownSandbox(tdeps, runIdArg, { noHarvest });
      out(`torn down: ${runIdArg}\n`);
      return 0;
    } catch (e) {
      const err = (e ?? {}) as { code?: string; remediation?: string; message?: string };
      printError(out, err.code ?? "error", err.message ?? String(e), err.remediation);
      return 1;
    } finally {
      if (ledger !== undefined) {
        try {
          ledger.close();
        } catch (e) {
          printError(out, "ledger-close-failed", `could not close the cost ledger: ${(e as Error).message}`, "the handle dies with the process; re-run to confirm it still reads");
        }
      }
      if (lock !== undefined) {
        try {
          rmSync(lock, { force: true });
        } catch (e) {
          printError(
            out,
            "lock-release-failed",
            `could not release ${lock}: ${(e as Error).message}`,
            `rm ${lock} by hand once no other invocation holds it`,
          );
        }
      }
    }
  }

  printError(out, "unknown-verb", `unknown verb ${JSON.stringify(verb)}`, HELP);
  return 2;
}

if (import.meta.main) {
  try {
    // stdout = output only; diagnostics stream as JSON lines on stderr.
    setLogSink((entry) => {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    });
    process.exit(await run(process.argv.slice(2), (s) => writeSync(1, s)));
  } catch (e) {
    writeSync(2, `${(e as Error).message}\n`);
    process.exit(1);
  }
}
