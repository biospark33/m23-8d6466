/**
 * DF3.1 Agent C: verb registry (AC6, C6).
 *
 * listVerbs() returns the closed verb registry — the sole source for --help
 * and for DF3.5's skill-contract test. Every entry has exact shape:
 * {verb, summary, flags: [{name, required, valueType}], exitCodes}
 *
 * C6: flags list = dashed flags only (positionals like runId are per-verb
 * CLI grammar, not registry flags). exitCodes are story-normative.
 *
 * The registry is a CONTRACT, not documentation: the CLI validates the flags it
 * accepts against these entries, and DF3.5's skill-contract test compares the
 * declared exit codes against the ones the verbs actually return. Every verb
 * takes `--help` and every verb can refuse with 2 (usage/schema) — an id that
 * fails the grammar, an extra positional, or a flag the verb does not take.
 *
 * `required` is a claim about the INVOCATION, and `--driver` is required on
 * every verb: `assertDriverChosen` in scripts/fleet.ts refuses without it as
 * exit 2, because no verb may ever default to the fake driver (a "torn down"
 * that destroyed nothing while the real box kept billing). Declaring it
 * optional here is how DF3.5 would generate a skill whose every call exits 2.
 * The one way to satisfy the requirement without the flag is an INJECTED
 * driver (tests, embedders), which is not an argv shape the registry describes.
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
        { name: "--driver", required: true, valueType: "string" },
        { name: "--brief", required: false, valueType: "path" },
        { name: "--dir", required: false, valueType: "path" },
        // The only route to DispatchDeps.port, hence the only way the ack can
        // carry an httpsUrl. "string": the CLI range-checks it as 1-65535.
        { name: "--port", required: false, valueType: "string" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      exitCodes: [0, 1, 2, 3, 5],
    },
    {
      verb: "status",
      summary: "List fleet state or single-run status",
      flags: [
        { name: "--driver", required: true, valueType: "string" },
        { name: "--dir", required: false, valueType: "path" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      exitCodes: [0, 1, 2, 4],
    },
    {
      verb: "harvest",
      summary: "Pull bundle + artifacts from a box",
      flags: [
        { name: "--driver", required: true, valueType: "string" },
        { name: "--dir", required: false, valueType: "path" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // 6 = cleanup failed on an otherwise-successful path (ledger close or run-lock
      // release). Distinct from 1 because it is NOT retryable: the work succeeded and
      // a retry only re-hits the wedged lock. See scripts/fleet.ts `cleanupFailed()`.
      exitCodes: [0, 1, 2, 4, 6],
    },
    {
      verb: "teardown",
      summary: "Destroy a box and close its record",
      flags: [
        { name: "--driver", required: true, valueType: "string" },
        { name: "--dir", required: false, valueType: "path" },
        { name: "--no-harvest", required: false, valueType: "boolean" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // 6 = cleanup failed on an otherwise-successful path — see `harvest` above.
      exitCodes: [0, 1, 2, 4, 6],
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

  // No "run `fleet <verb> --help` for verb-specific options" trailer: there is
  // no verb-specific help. Every `--help`/`-h`/`help` argv answers with this
  // one global string, and the CLI's tests pin all six shapes to identical
  // output — so the line advertised behaviour that is tested NOT to exist. The
  // options ARE the per-verb flags listed above; adding per-verb rendering
  // means routing in scripts/fleet.ts, not a sentence here.
  //
  // trimEnd because each entry pushes a blank separator line after it: without
  // the trailer that used to absorb it, the last one would trail the callers'
  // own "\n" with a second blank line.
  return lines.join("\n").trimEnd();
}
