/**
 * Z3 crash-window gate — the host half of scripts/z3/fleet-gate.sh (the
 * fork container's SWARMCLAW_FACTORY_FLEET_CLI for the round). Pure fs over
 * the shared gate dir (<repo>/.sandbox/z3-gate; the clone is /factory in the
 * container): arm before the fire, release after the kill, abort on cleanup,
 * and read the wrapper's journal as the window witness.
 *
 * OPERATOR SETUP: the "Z3 round record" runbook in
 * docs/planning/v6-crossrepo-contract.md (mount, real-cli, env override,
 * recreate). Disarmed and un-aborted, the wrapper is a pure pass-through.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_GATE_DIR = path.resolve(import.meta.dir, "../../.sandbox/z3-gate");

export interface GateLine {
  verb: string;
  requestId: string;
  workId: string;
  phase: "held" | "released" | "expired" | "aborted" | "unparsed" | "exec";
  /** Epoch ms (1 s resolution — the wrapper's `date +%s`). */
  at: number;
}

export interface CrashGate {
  /** Hold the next z3 code submit; refuses when the wrapper's real-cli config is absent. */
  arm: () => void;
  /** Let the held (and every later) submit through. */
  release: () => void;
  /** Cleanup: every z3 code submit — held now or arriving later — exits 99 exec'ing nothing (wins over armed/release). */
  abort: () => void;
  journalFor: (requestId: string) => GateLine[];
}

export function crashGate(dir: string = DEFAULT_GATE_DIR): CrashGate {
  const f = (name: string) => path.join(dir, name);
  return {
    arm: () => {
      if (!existsSync(f("real-cli"))) {
        throw new Error(`${f("real-cli")} missing — the fork container's fleet gate is not configured (runbook: docs/planning/v6-crossrepo-contract.md "Z3 round record")`);
      }
      for (const n of ["release", "abort", "journal.jsonl"]) rmSync(f(n), { force: true });
      writeFileSync(f("armed"), `${new Date().toISOString()}\n`);
    },
    release: () => {
      writeFileSync(f("release"), `${new Date().toISOString()}\n`);
    },
    abort: () => {
      mkdirSync(dir, { recursive: true });
      appendFileSync(f("abort"), `${new Date().toISOString()}\n`);
    },
    journalFor: (requestId) => {
      if (!existsSync(f("journal.jsonl"))) return [];
      return readFileSync(f("journal.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as GateLine];
          } catch {
            return []; // a torn line from a killed writer is not a phase
          }
        })
        .filter((l) => l.requestId === requestId);
    },
  };
}
