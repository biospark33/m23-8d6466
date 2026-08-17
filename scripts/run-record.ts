#!/usr/bin/env bun
/**
 * CLI: run-record — the operator-facing surface of the run-record store (DF2.1).
 *
 * Usage:
 *   run-record new-id <slug>                 → prints a generated run id
 *   run-record create <id>                   → creates the record, prints its path
 *   run-record path <id>                     → prints the record path
 *   run-record get <id> <field>              → prints the field (empty line if unset)
 *   run-record set <id> --vmName <v> ...     → merges fields, prints the record
 *   run-record close <id>                    → closes the record, prints it
 *   run-record list                          → prints one JSON record per line
 *
 * `--dir <path>` (or `$QDS_RUNS_DIR`) selects the records directory.
 *
 * argv is the only place a value arrives as a string, so coercion is per-field
 * and explicit — never "try JSON first". A `commitSha` of `5734129` is a string
 * that happens to parse as a number.
 */

import { writeSync } from "node:fs";

import {
  CORE_FIELDS,
  EXTENSION_NAMESPACES,
  RunRecordStore,
  SETTABLE_FIELDS,
  newId,
  type RunRecordPatch,
} from "../src/providers/run-record.ts";
import { newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";

// Structured logs go to stderr so stdout carries only the command's output.
if (import.meta.main) {
  setLogSink((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  });
}

/**
 * Per-field coercion at the CLI boundary, derived from the store's schema —
 * everything not listed stays a string.
 */
const COERCE: Readonly<Record<string, "int" | "ports">> = Object.fromEntries(
  Object.entries(CORE_FIELDS).filter(([, kind]) => kind !== "string"),
) as Readonly<Record<string, "int" | "ports">>;

/** Writable core fields — the store's settable-field policy, verbatim. */
const SET_FIELDS = [...SETTABLE_FIELDS];

const SET_FLAGS = SET_FIELDS.map((f) => `--${f}`);
const ALL_FLAGS = [...SET_FLAGS, "--dir", "--ext"];

const HELP = [
  "Usage: run-record <command> [args] [--dir <path>]",
  "",
  "Commands:",
  "  new-id <slug>              generate a run id (<slug>-<YYYYMMDD>-<6 hex>)",
  "  create <id>                create the record (fails EEXIST if it exists)",
  "  path <id>                  print the record path",
  "  get <id> <field>           print one field (empty line when unset)",
  `  set <id> [${SET_FLAGS.join("|")}] [--ext <ns>.<field>=<value>]`,
  "  close <id>                 close the record (first close wins)",
  "  list                       print one JSON record per line",
  "",
  `Extension namespaces: ${Object.keys(EXTENSION_NAMESPACES).join(", ")}`,
  "",
];

export interface ParsedArgs {
  positionals: string[];
  dir?: string;
  patch: RunRecordPatch;
}

function coerce(field: string, raw: string): string | number | number[] {
  const kind = COERCE[field];
  if (kind === undefined) return raw;
  if (kind === "int") {
    if (!/^-?\d+$/.test(raw)) throw new Error(`--${field} must be an integer, got ${JSON.stringify(raw)}`);
    return Number(raw);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--${field} must be a JSON array of integers, got ${JSON.stringify(raw)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "number" || !Number.isInteger(p))) {
    throw new Error(`--${field} must be a JSON array of integers, got ${JSON.stringify(raw)}`);
  }
  return parsed as number[];
}

function applyExt(patch: RunRecordPatch, raw: string): void {
  const m = raw.match(/^([A-Za-z0-9]+)\.([A-Za-z0-9]+)=(.*)$/);
  if (!m) throw new Error(`--ext expects <ns>.<field>=<value>, got ${JSON.stringify(raw)}`);
  const [ns, field, value] = [m[1] as string, m[2] as string, m[3] as string];
  const spec = Object.hasOwn(EXTENSION_NAMESPACES, ns) ? EXTENSION_NAMESPACES[ns] : undefined;
  // The store is the authority on the allow-list; the CLI only needs the field
  // kind to coerce. An unregistered ns falls through as a string and the store
  // rejects it naming the key.
  const kind = spec && Object.hasOwn(spec.fields, field) ? spec.fields[field] : undefined;
  let v: string | number = value;
  if (kind === "int") {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`--ext ${ns}.${field} must be an integer, got ${JSON.stringify(value)}`);
    }
    v = Number(value);
  }
  const extensions = (patch.extensions ?? {}) as Record<string, Record<string, string | number>>;
  extensions[ns] = { ...(extensions[ns] ?? {}), [field]: v };
  patch.extensions = extensions as RunRecordPatch["extensions"];
}

/**
 * Split argv into positionals and flag tokens (shared tokenizer in
 * `scripts/lib/cli-args.ts` — a value flag consumes the following token only
 * when it is not itself a flag), then hand the flag tokens to the shared
 * grammar so unknown flags are rejected with the shared errors.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const { positionals, flagTokens } = tokenizeArgs(argv, { valueFlags: ALL_FLAGS });

  const out: ParsedArgs = { positionals, patch: {} };
  parseValueFlags(flagTokens, {
    flags: ALL_FLAGS,
    onValue: (flag, value) => {
      if (flag === "--dir") {
        out.dir = value;
        return;
      }
      if (flag === "--ext") {
        applyExt(out.patch, value);
        return;
      }
      const field = flag.slice(2);
      (out.patch as Record<string, unknown>)[field] = coerce(field, value);
    },
    help: HELP,
  });
  return out;
}

function fieldToString(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function run(argv: readonly string[], out: (s: string) => void): number {
  const { positionals, dir, patch } = parseArgs(argv);
  const command = positionals[0];
  if (command === undefined) {
    throw new Error(`missing command\n${HELP.join("\n")}`);
  }
  const arg = (i: number, what: string): string => {
    const v = positionals[i];
    if (v === undefined) throw new Error(`${command} requires <${what}>`);
    return v;
  };

  // `new-id` mints an id and touches no directory — do not construct a store for
  // it, so id generation stays usable before the records dir is provisioned.
  if (command === "new-id") {
    out(`${newId(arg(1, "slug"))}\n`);
    return 0;
  }

  const store = new RunRecordStore({ ...(dir === undefined ? {} : { dir }), requestId: newRequestId() });
  switch (command) {
    case "create": {
      const id = arg(1, "id");
      store.create(id);
      out(`${store.path(id)}\n`);
      return 0;
    }
    case "path":
      out(`${store.path(arg(1, "id"))}\n`);
      return 0;
    case "get": {
      // Operands first, then IO: a missing <field> must not surface as an
      // ENOENT about the record.
      const id = arg(1, "id");
      const field = arg(2, "field");
      const rec = store.get(id) as unknown as Record<string, unknown>;
      if (!Object.hasOwn(rec, field) && !isKnownField(field)) {
        throw new Error(`unknown key: ${field}`);
      }
      // An unset field is exit 0 + an empty line: emptiness is the "that phase
      // never finished" signal callers branch on, not an error condition.
      out(`${fieldToString(rec[field])}\n`);
      return 0;
    }
    case "set":
      out(`${JSON.stringify(store.set(arg(1, "id"), patch))}\n`);
      return 0;
    case "close":
      out(`${JSON.stringify(store.close(arg(1, "id")))}\n`);
      return 0;
    case "list": {
      for (const rec of store.list()) out(`${JSON.stringify(rec)}\n`);
      return 0;
    }
    default:
      throw new Error(`unknown command: ${command}\n${HELP.join("\n")}`);
  }
}

function isKnownField(field: string): boolean {
  return field === "extensions" || Object.hasOwn(CORE_FIELDS, field);
}

if (import.meta.main) {
  try {
    // writeSync, not process.stdout.write: piped stdout can still be pending
    // when process.exit tears the process down and the diagnostics are lost.
    process.exit(run(process.argv.slice(2), (s) => writeSync(1, s)));
  } catch (e) {
    writeSync(2, `${(e as Error).message}\n`);
    process.exit(1);
  }
}
