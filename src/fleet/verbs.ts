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
 *
 * DF3.2's ONE exception proves the rule: `rank` takes no `--driver` because no
 * driver exists to choose — it reads fan-out records and step output only, so
 * requiring a flag nothing consumes would train operators to paste magic
 * values. It is also why rank is absent from assertDriverChosen's callers.
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
 * Return the verb registry. Exactly 6 entries: dispatch, status, harvest,
 * teardown, fanout, rank (fanout/rank are DF3.2's additive entries — no
 * DF3.1-owned entry was edited).
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
      // 6 = the box is LIVE and the ack could not be written to stdout
      // (`fleet dispatch … | head -0` closes the pipe before the line lands).
      // Declared because this registry is a CONTRACT — DF3.5's skill-contract
      // test compares these against what the verbs actually return, and a
      // generated skill drops an undeclared code into its default branch. 6 is
      // the one code whose remediation is "`fleet teardown <id>` now or it keeps
      // billing", so it is the worst one to lose. See scripts/fleet.ts's
      // `ack-unwritable`.
      //
      // NOTE, not resolved here: fleet.ts's own header defines 6 as "the verb
      // succeeded but a CLEANUP after it did not (ledger close / lock release)".
      // An unwritable ack is neither — it is the verb's own OUTPUT failing after
      // the billable work landed. The shared property that makes 6 right is that
      // it is NOT retryable (retrying dispatch provisions a second box), which
      // is the same reason it is not 1. Widening that definition is a taxonomy
      // change and belongs with the CLI's table, not here.
      exitCodes: [0, 1, 2, 3, 5, 6],
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
      // 5 = the run lock refused, so the verb never ran — "refused before
      // provisioning", and nothing was mutated. Not 1: `logVerb` stamps 1
      // `transient` ("retry me"), and for a STALE lock nothing will ever clear
      // it, so automation retried forever. See scripts/fleet.ts `acquireRunLock`.
      // 6 = cleanup failed on an otherwise-successful path (ledger close or run-lock
      // release). Distinct from 1 because it is NOT retryable: the work succeeded and
      // a retry only re-hits the wedged lock. See scripts/fleet.ts `cleanupFailed()`.
      exitCodes: [0, 1, 2, 4, 5, 6],
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
      // 5 = the run lock refused; 6 = cleanup failed on an otherwise-successful
      // path — see `harvest` above for both.
      exitCodes: [0, 1, 2, 4, 5, 6],
    },
    {
      verb: "fanout",
      summary: "Run N isolated dispatch arms as one pattern (best-of-n, many-stories, race)",
      flags: [
        { name: "--driver", required: true, valueType: "string" },
        { name: "--pattern", required: true, valueType: "string" },
        // "string", like --port: the CLI range-checks it as a positive integer
        // (2..8 best-of-n/race, 1..8 many-stories — INV-6) rather than trusting
        // Number()'s coercions.
        { name: "--n", required: true, valueType: "string" },
        // Must equal the brief's commitSha(s) — checked by assertFanoutPin
        // before anything is constructed.
        { name: "--pin", required: false, valueType: "string" },
        // Comma-separated roster ids; best-of-n/race require exactly --n of
        // them, many-stories refuses the flag outright.
        { name: "--roster", required: false, valueType: "string" },
        // Per-arm key cap in integer micro-dollars (DD-9), positive-int-checked
        // like --n. Absent ⇒ the single-run default cap.
        { name: "--cap-micro-usd", required: false, valueType: "string" },
        { name: "--brief", required: false, valueType: "path" },
        // The FAN-OUT records directory (.sandbox/fanouts), NOT the runs dir:
        // fanout writes fan-*.json records; rank reads them.
        { name: "--dir", required: false, valueType: "path" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // 1 = any collected arm failure after a result returned (setupFailed,
      // armFailed, armUnknown); 5 = refused before anything provisioned
      // (fleet-busy, no-headroom); 2 validation; 6 = landed but a completion
      // line would not print. See scripts/fleet.ts's fanout block.
      exitCodes: [0, 1, 2, 5, 6],
    },
    {
      verb: "rank",
      summary: "Score a completed best-of-N fan-out (advisory; emits scores, tie, rationale)",
      flags: [
        // The FAN-OUT records directory (not the runs dir): rank touches fanout
        // records and step output only — it reads no run record (DF3.2 K11).
        { name: "--dir", required: false, valueType: "path" },
        // Optional JSON map runId → {testsExecuted?, testResults?, changedFiles?}.
        // Absent ⇒ every arm is listed score:null with an explanatory
        // rationale — advisory rank stays structurally useful (ruling C2).
        { name: "--steps-json", required: false, valueType: "path" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // NO --driver: rank touches records and step output only; requiring a
      // flag nothing consumes trains operators to paste magic values.
      // assertDriverChosen is skipped for rank (no driver to default — the B8
      // hazard cannot arise).
      //
      // 6 = the ranking LANDED (record read, scores computed, rankedAt stamped)
      // and the result line would not print — the shared `finish` folds an
      // EAGAIN-refused stdout into 6 exactly as it does for dispatch/fanout.
      // Still no 5: rank refuses nothing before provisioning, because it never
      // provisions.
      exitCodes: [0, 1, 2, 4, 6],
    },
    // ── DF3.4's three additive entries. No DF3.1- or DF3.2-owned entry edited.
    {
      verb: "approve",
      summary: "Approve a run paused at the pre-PR gate, releasing it to open its PR",
      flags: [
        { name: "--dir", required: false, valueType: "path" },
        // The approver's id; its token arrives on STDIN, never argv (DF2.3
        // INV-CRED-3) — which is why no --token flag exists to declare.
        { name: "--approver", required: false, valueType: "string" },
        { name: "--reason", required: false, valueType: "string" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // NO --driver, on `rank`'s precedent: this verb reads and writes one
      // record's `extensions.approval` and touches no box, so requiring a flag
      // nothing consumes would train operators to paste magic values. The
      // assertDriverChosen hazard it exists to stop — a teardown "destroying" a
      // fake box while the real one keeps billing — is structurally unreachable
      // for a verb that provisions and destroys nothing. Declaring it
      // `required: false` instead of omitting it is how DF3.5 would generate a
      // skill whose every call exits 2.
      //
      // Same six as harvest/teardown. No 3 (dispatch-only). 6 = the decision
      // LANDED and the confirmation line would not print — `finish` folds an
      // EAGAIN-refused stdout into 6 for every verb that would return 0.
      exitCodes: [0, 1, 2, 4, 5, 6],
    },
    {
      verb: "reject",
      summary: "Reject a run paused at the pre-PR gate, settling it without a PR",
      flags: [
        { name: "--dir", required: false, valueType: "path" },
        { name: "--approver", required: false, valueType: "string" },
        { name: "--reason", required: false, valueType: "string" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // NO --driver — see approve above; reject is its mirror image.
      exitCodes: [0, 1, 2, 4, 5, 6],
    },
    {
      verb: "attach",
      summary: "Queue a steering message for a run's resident agent and wait for its ack",
      flags: [
        // REQUIRED here, unlike approve/reject: attach reaches INTO the box
        // over DF2.1's driver port (exec + stdin to append the inbox line,
        // exec + cat to read the ack back), so it must never default a driver.
        { name: "--driver", required: true, valueType: "string" },
        { name: "--dir", required: false, valueType: "path" },
        // The message itself; read from STDIN when absent, so operator text
        // never has to survive a shell's quoting.
        { name: "--message", required: false, valueType: "string" },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // 6 even though attach provisions nothing: the message can LAND in the
      // box (or be acked) and the outcome line still fail to print, which is
      // exactly the case `rank` declares 6 for.
      exitCodes: [0, 1, 2, 4, 5, 6],
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
