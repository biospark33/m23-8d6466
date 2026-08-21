/**
 * DF3.1 Agent C: verb registry (AC6, C6).
 *
 * listVerbs() returns the closed verb registry — the sole source for --help
 * and for DF3.5's skill-contract test. Every entry has exact shape:
 * {verb, summary, flags: [{name, required, valueType}], exitCodes}
 *
 * C6: flags list = dashed flags only (positionals like runId are per-verb
 * CLI grammar, not registry flags). exitCodes are story-normative.
 */
export interface VerbFlag {
  name: string;
  required: boolean;
  valueType: "string" | "path" | "boolean";
}

export interface VerbEntry {
  verb: string;
  summary: string;
  flags: VerbFlag[];
  exitCodes: number[];
}

/**
 * Return the verb registry. Exactly 4 entries: dispatch, status, harvest, teardown.
 * Shape is story-normative; exit codes match AC6 table.
 */
export function listVerbs(): VerbEntry[] {
  return [
    {
      verb: "dispatch",
      summary: "Mint a run handle and provision a sandbox",
      flags: [
        { name: "--driver", required: false, valueType: "string" },
        { name: "--brief", required: false, valueType: "path" },
        { name: "--dir", required: false, valueType: "path" },
      ],
      exitCodes: [0, 1, 2, 3, 5],
    },
    {
      verb: "status",
      summary: "List fleet state or single-run status",
      flags: [{ name: "--driver", required: false, valueType: "string" }],
      exitCodes: [0, 1, 4],
    },
    {
      verb: "harvest",
      summary: "Pull bundle + artifacts from a box",
      flags: [
        { name: "--driver", required: false, valueType: "string" },
        { name: "--dir", required: false, valueType: "path" },
      ],
      exitCodes: [0, 1, 4],
    },
    {
      verb: "teardown",
      summary: "Destroy a box and close its record",
      flags: [
        { name: "--driver", required: false, valueType: "string" },
        { name: "--dir", required: false, valueType: "path" },
        { name: "--no-harvest", required: false, valueType: "boolean" },
      ],
      exitCodes: [0, 1, 4],
    },
  ];
}

/**
 * Render usage text from the verb registry.
 *
 * This is the ONLY place --help content lives; no second hard-coded list.
 * The CLI imports listVerbs() and passes its output here.
 */
export function renderHelp(registry: VerbEntry[]): string {
  const lines: string[] = [];
  lines.push("Usage: fleet <verb> [options]");
  lines.push("");
  lines.push("Verbs:");

  for (const entry of registry) {
    lines.push(`  ${entry.verb.padEnd(10)} ${entry.summary}`);

    // Flags under the verb
    for (const flag of entry.flags) {
      const req = flag.required ? "required" : "optional";
      lines.push(`        ${flag.name} (${flag.valueType}, ${req})`);
    }

    lines.push(`        Exit codes: ${entry.exitCodes.join(", ")}`);
    lines.push("");
  }

  lines.push("Run `fleet <verb> --help` for verb-specific options.");
  return lines.join("\n");
}
