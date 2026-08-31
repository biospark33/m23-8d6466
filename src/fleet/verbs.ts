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
  /**
   * One sentence of grammar `{name, required, valueType}` cannot express —
   * today only `attach --message`'s `-` stdin sentinel (DF3.4 deferred item D2).
   *
   * ADDITIVE and OPTIONAL by design. The registry is the contract DF3.5's
   * skill-contract test compares against, so widening it had to be a change no
   * existing consumer can trip over: a flag without a note is byte-identical to
   * what it was, and a consumer that ignores the field reads the same three
   * columns it always did.
   *
   * It is NOT a description field. Every OTHER flag's meaning belongs in the
   * verb `summary` and in the story that owns it; this exists for a value whose
   * behaviour differs from its declared `valueType` — a case where an operator
   * (or a generated skill) reading `(string, optional)` would be actively
   * misled. Adding a note to a flag that has no such surprise makes `--help`
   * longer without making it truer.
   */
  note?: string;
}

export interface VerbEntry {
  verb: string;
  summary: string;
  flags: VerbFlag[];
  exitCodes: number[];
}

/**
 * Return the verb registry. DF3.1 owned the first four (dispatch, status,
 * harvest, teardown); fanout and rank are DF3.2's additive entries; approve,
 * reject, enrol and attach are DF3.4's (`enrol` arrived via deferred item D9's
 * allowlist work); `unlock` is DF3.4 deferred item D11's. Every wave ADDED
 * entries and edited none of its predecessors' — which is the property that
 * keeps DF3.5's generated skill contract stable.
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
      // ONE definition, ruled in docs/decisions/2026-08-tech-debt-answers.md
      // § Q11: 6 = "billable work landed; the CLI's own OUTPUT or CLEANUP
      // failed after it" — output and cleanup alike, CLI-only by construction
      // (`FleetError.exitCode` stays 1..5). Not 1: it is not retryable.
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
        { name: "--fanouts-dir", required: false, valueType: "path" },
        // F049: the OLD spelling of --fanouts-dir, kept for one release. `--dir`
        // is the runs directory on every other verb, so an operator using it
        // consistently drops fan-*.json into a runs tree and every later sweep
        // reports malformed_record_name. Deprecated on stderr; --fanouts-dir
        // wins when both are given.
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
        { name: "--fanouts-dir", required: false, valueType: "path" },
        // F049: the OLD spelling, kept for one release — see fanout above.
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
        // DUAL-purpose (F5) — the surprise `(path, optional)` cannot express and
        // the one `VerbFlag.note` exists for here: on every other verb that reads
        // a run, `--dir` is ONLY the runs directory. Reject shares this verb's
        // argv block, so its note says the same thing.
        {
          name: "--dir",
          required: false,
          valueType: "path",
          note: "allowlist host root AND runs directory — this verb reads its run record and bundle from this path too",
        },
        // The approver's id; its token arrives on STDIN, never argv (DF2.3
        // INV-CRED-3) — which is why no --token flag exists to declare.
        //
        // `required: true`, because `required` is a claim about the INVOCATION
        // and scripts/fleet.ts refuses without it as exit 2 — absent AND empty,
        // since it trims and treats `--approver ""` as absent. Declared
        // optional, this is the same defect the --driver note below describes,
        // one flag over: DF3.5 generates a skill from this registry, and a
        // generated call that omits an "optional" flag exits 2 every time.
        { name: "--approver", required: true, valueType: "string" },
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
        // The SAME dual meaning as approve's — reject shares its argv block and
        // its `--dir` resolution (allowlist root + runs directory), so the note
        // must say so too or `--help` would disagree between two verbs that
        // behave identically (F5).
        {
          name: "--dir",
          required: false,
          valueType: "path",
          note: "allowlist host root AND runs directory — this verb reads its run record and bundle from this path too",
        },
        // Required for the same reason as approve's — the two verbs share one
        // argv block in scripts/fleet.ts, so they share its refusal.
        { name: "--approver", required: true, valueType: "string" },
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
        // The message itself; read from STDIN when absent — or when the value
        // is the single character `-`, which AC5 of the story invokes verbatim
        // (`fleet attach <run-id> --message -`) and which scripts/fleet.ts
        // honours. It is `cat`/`tar`'s sentinel.
        //
        // NOW DECLARED (DF3.4 deferred item D2). It used to be a residual: the
        // registry could not express it, so `--help` and any DF3.5-generated
        // skill presented `-` as an ordinary string value. `VerbFlag.note` is
        // the additive field that fixes it, and `renderHelp` prints it.
        //
        // AND THE LITERAL `-` IS REACHABLE, which the old comment got wrong when
        // it called it "the one message that is literally `-`" being lost: the
        // sentinel costs nothing, because OMITTING the flag reads stdin too
        // (scripts/fleet.ts: `messageFlag === undefined || messageFlag === "-"`).
        // `printf -- '-' | fleet attach <run-id> --driver <d>` sends it. The note
        // says so, because an operator who believes a message is unsendable will
        // not try the one invocation that sends it.
        {
          name: "--message",
          required: false,
          valueType: "string",
          note: "the value `-` reads the message from stdin, as does omitting the flag; to send the literal one-character message `-`, pipe it instead",
        },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // 6 even though attach provisions nothing: the message can LAND in the
      // box (or be acked) and the outcome line still fail to print, which is
      // exactly the case `rank` declares 6 for.
      exitCodes: [0, 1, 2, 4, 5, 6],
    },
    {
      verb: "enrol",
      summary: "Mint an approver token and write its scrypt entry to the approver allowlist",
      flags: [
        // The id to enrol. Same spelling as approve/reject's, deliberately: an
        // operator enrols with the id they will later decide with, and two names
        // for one value is how they drift apart.
        { name: "--approver", required: true, valueType: "string" },
        // The host root the allowlist resolves under — the SAME flag, with the
        // SAME meaning, that `approve` takes. Without it enrol resolved the
        // allowlist from process.cwd() and nothing else: an enrolment run from
        // $HOME wrote `.factory/approvers.json` there, and every later
        // `fleet approve` from the repo authenticated against a DIFFERENT file
        // — the freshly minted approver was refused forever as unknown, with
        // nothing naming the two-root split. A comment used to assert the
        // cwd-agreement as an invariant; nothing enforced it, because cwd is
        // per-invocation state the verb cannot see. The flag makes the root
        // explicit, and both verbs resolve through the one guarded reader, so
        // two invocations of `fleet enrol --dir X` and `fleet approve --dir X`
        // cannot disagree about which allowlist is theirs.
        //
        // The one thing `(path, optional)` cannot say, and the surprise an
        // operator (or a generated skill) can act on wrongly: on every OTHER
        // verb `--dir` is the RUNS directory, and pointing it at a runs
        // directory here enrols a second, separate allowlist inside it. That
        // is the "behaviour differs from its declared valueType" case
        // `VerbFlag.note` exists for (D2).
        //
        // F5: "exactly as on `approve`" was the OLD note, and it was only half
        // true — approve's `--dir` is dual-purpose (allowlist root AND the runs
        // directory it reads its record and bundle from), so "the same flag"
        // carried a second meaning this verb never picks up. The note now says
        // which half enrol takes, and approve's own entry names its other half.
        {
          name: "--dir",
          required: false,
          valueType: "path",
          note: "the allowlist's HOST ROOT — the allowlist half of `approve`'s dual-purpose --dir, whose runs-directory half this verb never touches",
        },
        // F7. `(path, optional)` reads like a rerouting of output that does not
        // matter; this flag is the difference between a credential that lands in
        // a file only its owner can read and one that lands in a captured CI log
        // verbatim. It also REFUSES rather than truncating when the write fails
        // (exit 6, `--rotate`), and refuses outright when the path is the
        // allowlist itself.
        {
          name: "--out",
          required: false,
          valueType: "path",
          note: "writes the token JSON here (mode 0600) instead of stdout — use wherever stdout is captured",
        },
        {
          name: "--rotate",
          required: false,
          valueType: "boolean",
          // The surprise `(boolean, optional)` cannot express (D2's `note`): this
          // flag INVALIDATES a working credential the moment it succeeds.
          note: "re-mints an already-enrolled approver's token; their current one stops working immediately",
        },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // NO --driver. `--dir` is here for the reason above — the ALLOWLIST's
      // root, matching approve's spelling, not a runs directory (this verb
      // never touches a run record, so it can never reach a `--dir` that
      // means runs-dir).
      //
      // 5 = every guard refusal: the allowlist's path/mode/owner guards, an
      // already-enrolled id without --rotate, and a failed write — all "refused,
      // nothing was mutated". 6 = the entry WAS written and the token could not
      // be printed, which is the worst possible line to lose, so it gets the code
      // whose remediation is an operator action (`--rotate`) rather than a retry.
      // No 4: there is no run to be absent.
      exitCodes: [0, 1, 2, 5, 6],
    },
    {
      verb: "unlock",
      summary: "Inspect a run's approval lock and reclaim it when its holder cannot be proven dead",
      flags: [
        { name: "--dir", required: false, valueType: "path" },
        {
          name: "--force",
          required: false,
          valueType: "boolean",
          // A note, not a description: `(boolean, optional)` reads like every
          // other convenience switch, and this one can put two processes inside
          // a critical section. That is precisely the "behaviour differs from
          // its declared valueType" case `VerbFlag.note` exists for (D2).
          note: "removes the lock even when its holder is still running — only after you have confirmed no reverify is live for this run",
        },
        { name: "--help", required: false, valueType: "boolean" },
      ],
      // NO --driver, and NO --approver. Precedent for the first is `rank` and
      // `approve`: this verb touches one lock file and no box. The second is a
      // deliberate ruling recorded at `reclaimApprovalLock` — anyone who can
      // reach the runs directory can already `rm` the file, so a token check
      // would protect nothing and would train operators to hold a token for
      // janitorial work.
      //
      // 5 = EVERY refusal, with ONE generic envelope: a missing record, an
      // unreadable record and a live (or unprovable) holder all exit 5
      // `unlock-refused`, and the TRUE reason travels only in the gate event
      // beside it. That uniformity is the point — a caller holding no lock
      // could otherwise separate "no such run" (4) from "that run exists and
      // its holder is alive" (5) and enumerate run ids without ever touching a
      // lock, the same oracle round 9 closed for approve/reject by deferring
      // existence past authentication. This verb has no authentication to
      // defer past, so the observable results are made uniform instead. 6 = the
      // lock WAS removed and the confirmation line would not print — the work
      // landed and a retry is a no-op, which is what separates 6 from 1.
      exitCodes: [0, 1, 2, 5, 6],
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

    // Flags under the verb. The note, when a flag has one, is appended to that
    // flag's OWN line rather than wrapped onto a second: the flag block is
    // parsed line-per-flag (by `renderHelp`'s tests, and by anything else that
    // reads `--help`), so a second line would silently become a phantom flag.
    for (const flag of entry.flags) {
      const req = flag.required ? "required" : "optional";
      const note = flag.note === undefined ? "" : ` — ${flag.note}`;
      lines.push(`        ${flag.name} (${flag.valueType}, ${req})${note}`);
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
