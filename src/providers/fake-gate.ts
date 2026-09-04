/**
 * The fake-substrate setup gate (Story DF3.1) — the dir-box counterpart of
 * DF2.2's exedev gate.
 *
 * It lives in the PROVIDERS layer, beside the driver it probes, because the
 * DoD's rule is literal: no substrate command string appears anywhere under
 * `src/fleet/`. It used to sit inside `dispatch.ts`, where five `sh -c` probes
 * were spelled out in the fleet layer — routed through `ProviderDriver.exec`,
 * so the calls were fine, but the strings were in the wrong module and a second
 * five-assertion gate had grown outside the layer that owns gates.
 *
 * Not a simulated pass: every item executes a command in the box and reports
 * what it found. The exedev gate stays the authoritative one.
 *
 * `dispatch.ts` re-exports `fakeGate`, so nothing had to change import site.
 */
import type { ProviderDriver } from "./driver.ts";
import type { SetupGateResult } from "./exedev/setup-gate.ts";
import { DEFAULT_FILL_WORKDIR, QDS_IN_BOX_DIR } from "./exedev/fill.ts";
import { redactSecrets } from "./step-log.ts";

/**
 * Where item B looks for the manifest — DERIVED from the two constants that
 * decide where `dispatch` puts it, never spelled out.
 *
 * DF1.10 AC2b moved the pair INSIDE the checkout, under `.qds/`, so that one
 * `--run-root` serves the manifest read, the ceiling witness, the roster and
 * every code phase's `cwd`. This gate probes what the fill step delivered, so
 * the two must move together: a literal here would let the probe keep passing
 * against a path nothing writes any more, or — worse — keep failing green-ly
 * on a box that was filled correctly.
 *
 * The import is from `exedev/` and this gate is the DIR-box one on purpose:
 * `fill.ts` is where the checkout's directory name and the run's in-box
 * directory name are decided for every substrate, and duplicating either here
 * is how the two copies drift.
 */
const BOX_MANIFEST = `${DEFAULT_FILL_WORKDIR}/${QDS_IN_BOX_DIR}/pipeline.yaml`;

/** Assertion code table mirrors DF2.2's ASSERTION_CODE (A/B share 1). */
const FAKE_ASSERTION_CODE: Record<"A" | "B" | "C" | "D" | "E", 1 | 2 | 3 | 4> = {
  A: 1,
  B: 1,
  C: 2,
  D: 3,
  E: 4,
};

/** The subset of the gate options this gate reads — `runId` and nothing else. */
export interface FakeGateOpts {
  runId: string;
}

/**
 * A substrate failure's detail is PREFIXED with this so an OPERATOR can tell
 * "the box is broken" (retryable) from "the manifest is wrong" (the brief's own
 * fault) WITHOUT re-deriving the diagnosis. `SetupGateResult` is DF2.2's shape
 * and carries no field for the distinction.
 *
 * The mark is PRESENTATION only as of this change: machine classification no
 * longer scans note text for it. Every failing note here embeds box/provider
 * echo somewhere (`detailOf(e)`, probe stderr), so free-text scanning let any
 * detail quoting `"substrate: "` reclassify a manifest failure retryable —
 * one doomed retry bought by whoever controls the string. `fakeGate` now
 * records its OWN verdicts on a side channel (`markSubstrate`, keyed off the
 * result object), and `isSubstrateFailure` reads THAT channel alone. The mark
 * still rides the notes so human readers keep the diagnosis inline.
 */
export const SUBSTRATE_MARK = "substrate: ";

/**
 * The structured channel behind `isSubstrateFailure`: the substrate verdicts
 * THIS module's probes produced, keyed per result object. A WeakMap because
 * `SetupGateResult` has no spare field and growing DF2.2's contract for one
 * caller's flag would reach every driver's gate; keyed OFF THE OBJECT rather
 * than a single boolean slot because dispatch can run gates concurrently
 * (fan-out arms) and injection tests build many results per process.
 *
 * An INJECTED gate (`deps.setupGate`) never touches this map, so its results
 * classify as non-substrate regardless of what its notes quote — which is the
 * fail-closed direction: do not advertise a retry off a claim you cannot trace
 * to your own probe.
 */
const substrateResults = new WeakMap<object, boolean>();

/** Record this result's substrate classification on the side channel. */
function markSubstrate(result: SetupGateResult, substrate: boolean): void {
  try {
    substrateResults.set(result, substrate);
  } catch {
    // A hostile/frozen result object must not crash the gate emitting it.
  }
}

/**
 * Read back what markSubstrate recorded. Anything this module did not produce
 * ⇒ false, never derived from message text.
 */
function markedSubstrate(result: SetupGateResult): boolean {
  try {
    return substrateResults.get(result) === true;
  } catch {
    return false;
  }
}

/**
 * "The command never ran at all", told apart from "the command ran and failed".
 *
 * `ExecResult.exitCode` is DECLARED `number`, but it crosses a driver boundary:
 * a signal-killed child carries Node's `null`, 126/127 are `/bin/sh`'s own
 * not-executable and command-not-found, and 128+n is a shell reporting the
 * signal that killed its child. Folded into the ordinary arms, all of them were
 * reported as a MANIFEST problem ("manifest unreadable (grep exit 127)") —
 * sending the operator to inspect a file when the box is the thing that is
 * broken. Takes `unknown` because the declared type has no overlap with `null`.
 */
export function substrateFailure(exitCode: unknown): string | undefined {
  if (exitCode === null || exitCode === undefined) {
    return `${SUBSTRATE_MARK}the box did not run the probe (killed by a signal) — a substrate failure, not a manifest one`;
  }
  // A NEGATIVE value is Bun/Node's spawn convention for "killed by signal n"
  // (-15 = SIGTERM). It used to fall through every arm below and reach dispatch
  // as a MANIFEST verdict with no SUBSTRATE_MARK — do-not-retry for what is
  // definitionally the box failing. Same band logic as the 128+n arm: no probe
  // here answers with its own negative status.
  if (typeof exitCode === "number" && exitCode < 0) {
    return `${SUBSTRATE_MARK}exit ${exitCode}: the probe was killed by signal ${-exitCode} — a substrate failure, not a manifest one`;
  }
  if (exitCode === 126) {
    return `${SUBSTRATE_MARK}exit 126: the probe command is present but not executable — the probe never ran`;
  }
  if (exitCode === 127) {
    return `${SUBSTRATE_MARK}exit 127: \`sh\` or the probe command is not on the box — the probe never ran`;
  }
  // A shell reports a signal-killed child as 128+n. None of the probes below is
  // a program that returns a status of its own in that range, so the whole band
  // is a substrate failure rather than a probe verdict.
  if (typeof exitCode === "number" && exitCode > 128 && exitCode < 256) {
    return `${SUBSTRATE_MARK}exit ${exitCode}: the probe was killed by signal ${exitCode - 128} — a substrate failure, not a manifest one`;
  }
  return undefined;
}

/**
 * Did this gate fail because the BOX is broken, rather than its contents?
 *
 * Reads ONLY the side channel this module's own probes write (`markSubstrate`)
 * — never the assertion notes. Scanning free text let any failing probe whose
 * detail quotes `"substrate: "` (a JSON-parse error echoing file content, a
 * driver message echoing box output) reclassify itself retryable; and an
 * injected gate could claim substrate with one string. Unmarked ⇒ false: the
 * fail-closed direction here is "do not advertise a retry".
 *
 * The Array guard stays (this is still called on injected results whose shape
 * is a caller's promise), but it now answers only "did the GATE crash", never
 * "was the box broken".
 */
export function isSubstrateFailure(gate: SetupGateResult): boolean {
  if (typeof gate !== "object" || gate === null) return false;
  return markedSubstrate(gate);
}

/**
 * Third-party free text (a driver's thrown message) as a probe detail.
 *
 * Nothing here may throw. It is called from the `catch (e)` in `fakeGate`'s
 * probe loop below, whose whole purpose is to keep the assertions accumulated
 * so far; a throw escaping this function discards them and produces exactly the
 * generic exit-1 failure that catch exists to prevent.
 *
 * Two ways it used to throw, both on values a rejecting `driver.exec` can carry:
 *  - `String(e)` HERE rather than inside `redactSecrets`. `String` throws on a
 *    null-prototype value (`Object.create(null)`) and on anything with a
 *    hostile `toString`/`Symbol.toPrimitive`. `redactSecrets` takes `unknown`
 *    and has the one guarded stringifier (`asText`), so `e` goes through
 *    UNCOERCED and the throw lands inside the guard;
 *  - reading `.message` off a value whose `message` is a throwing getter, which
 *    happens before `redactSecrets` is even reached.
 */
function detailOf(e: unknown): string {
  let message: unknown;
  try {
    message = (e as { message?: unknown } | null | undefined)?.message;
  } catch {
    // a hostile `message` getter is itself not a reason to lose the probe
  }
  return redactSecrets(typeof message === "string" ? message : e);
}

/**
 * Five REAL probes of the box's on-disk state, one per DF2.2 assertion item.
 *
 * Probing stops at the first failure: `assertions` is the EXECUTED set, and
 * every later probe would report the state of a box already known unready.
 */
export async function fakeGate(
  driver: ProviderDriver,
  vm: string,
  opts: FakeGateOpts,
): Promise<SetupGateResult> {
  /**
   * The box's manifest, read ONCE by item B and inspected structurally by B, D
   * and E. `serializeManifest` writes `JSON.stringify(…, null, 2)` under the
   * `.yaml` filename, so the host can parse it rather than grep it — and B/E
   * previously used unanchored, unscoped greps, which AC9a's "refuse if absent"
   * was satisfied by a `limitMicroUsd` inside an env-var name, a comment or a
   * nested object. Anchoring was not available: the writer emits one JSON
   * document, not one key per line.
   */
  let manifest: Record<string, unknown> | undefined;

  const probes: { item: "A" | "B" | "C" | "D" | "E"; note: string; run: () => Promise<{ ok: boolean; detail: string }> }[] = [
    {
      item: "A",
      note: "box reachable (exec true)",
      run: async () => {
        const r = await driver.exec(vm, ["true"]);
        const substrate = substrateFailure(r.exitCode);
        if (substrate !== undefined) return { ok: false, detail: substrate, substrate: true };
        return { ok: r.exitCode === 0, detail: `exit ${r.exitCode}` };
      },
    },
    {
      item: "B",
      note: "frozen manifest carries a root-level limitMicroUsd (AC9a refuse-if-absent)",
      run: async () => {
        // An existence pre-test before the read, mirroring item C's shape:
        // `cat`'s stderr is discarded, so EXISTS-BUT-UNREADABLE (mode 000, EIO)
        // and NEVER LANDED both arrived as an empty body + nonzero exit and
        // shared one diagnosis. They are opposite diagnoses — the fill step
        // can be re-run for the second and is wasted work for the first — and
        // only the second is the brief's own fault. Present-but-unreadable is
        // the BOX failing, so it carries SUBSTRATE_MARK like every signal arm;
        // a genuinely missing manifest stays unmarked (do-not-retry).
        const r = await driver.exec(
          vm,
          [
            "sh",
            "-c",
            `if [ ! -e ${BOX_MANIFEST} ]; then echo absent; exit 0; fi; cat ${BOX_MANIFEST} 2>/dev/null`,
          ],
        );
        const substrate = substrateFailure(r.exitCode);
        if (substrate !== undefined) return { ok: false, detail: substrate, substrate: true };
        const rawBody = (r.stdout ?? "").trim();
        if (rawBody === "absent") {
          return { ok: false, detail: `${BOX_MANIFEST} is absent — the fill step never delivered it (re-run the fill step)` };
        }
        const body = rawBody;
        if (body.length === 0) {
          // Existed at -e, produced nothing, exited nonzero ⇒ unreadable, not
          // missing. (.env vanishing between the two lands here too — rare, and
          // "retry" is the safe answer for a race.)
          return {
            ok: false,
            detail:
              r.exitCode === 0
                ? `${BOX_MANIFEST} is present but empty`
                : `${SUBSTRATE_MARK}${BOX_MANIFEST} exists but could not be read (exit ${r.exitCode}) — a substrate failure, not a manifest one; re-running the fill step will not help`,
            ...(r.exitCode === 0 ? {} : { substrate: true }),
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return { ok: false, detail: `${BOX_MANIFEST} is not parseable: ${detailOf(e)}` };
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, detail: `${BOX_MANIFEST} is not a manifest object` };
        }
        manifest = parsed as Record<string, unknown>;
        return manifest.limitMicroUsd === undefined
          ? { ok: false, detail: "limitMicroUsd absent" }
          : { ok: true, detail: "stamped" };
      },
    },
    {
      item: "C",
      note: "delivered key env file is mode 600 (DF2.3 delivery contract)",
      run: async () => {
        // GNU stat, then BSD stat, then give up: the previous probe shelled out
        // to python3, so any box without an interpreter failed item C for a
        // reason that has nothing to do with the key's mode. `stat` is in
        // coreutils/BSD base on every substrate the factory targets.
        //
        // No `|| echo none` fallback: that made every stat failure exit 0 with
        // empty output, so an EIO box was reported as a delivery-contract miss
        // (do-not-retry) instead of the transient substrate failure it is, and
        // `substrateFailure` below could never fire. The probe now answers on
        // stdout — "absent", "not-a-file", the mode digits, or "unreadable" —
        // and says which. The type probe keeps a DIRECTORY named `.env` from
        // reporting as a mode mismatch ("mode 755"): that sent the operator to
        // `chmod` a thing chmod cannot fix, when the fix is re-delivering the
        // key file the fill step failed to land.
        const r = await driver.exec(
          vm,
          [
            "sh",
            "-c",
            "if [ ! -e .env ]; then echo absent; exit 0; fi; if [ ! -f .env ]; then echo not-a-file; exit 0; fi; m=$(stat -c '%a' .env 2>/dev/null); [ -n \"$m\" ] && { echo \"$m\"; exit 0; }; m=$(stat -f '%Lp' .env 2>/dev/null); [ -n \"$m\" ] && { echo \"$m\"; exit 0; }; echo unreadable",
          ],
        );
        const substrate = substrateFailure(r.exitCode);
        if (substrate !== undefined) return { ok: false, detail: substrate, substrate: true };
        const mode = (r.stdout ?? "").trim();
        // ".env absent" is the DELIVERY CONTRACT failing (fill never landed the
        // key) — retrying cannot help. Wrong TYPE is the same contract failing
        // by a different road (something else wrote a directory/symlink-dir in
        // `.env`'s place): re-deliver, never chmod. Present-but-unreadable is
        // the BOX failing (EIO, a missing stat binary), which is transient, so
        // it carries SUBSTRATE_MARK like the signal arms above — and flags the
        // side channel to match, which is what classification now reads.
        // (.env vanishing between `-e` and `stat` lands here too — rare, and
        // "retry" is the safe answer for a race.)
        if (mode === "unreadable") {
          return {
            ok: false,
            substrate: true,
            detail: `${SUBSTRATE_MARK}.env exists but neither stat(1) could read its mode — a substrate failure, not a delivery-contract one`,
          };
        }
        if (mode === "absent") return { ok: false, detail: "mode absent (.env was not delivered)" };
        if (mode === "not-a-file") {
          return { ok: false, detail: ".env exists but is not a regular file — re-run the key delivery step; do not chmod" };
        }
        return { ok: mode === "600", detail: `mode ${mode || "unknown"}` };
      },
    },
    {
      item: "D",
      // CONTENT, never presence — the dir-box counterpart of DF2.2's item D,
      // which inspects the cost table's content rather than trusting a field
      // name. This item used to re-test "manifest non-empty", which item B's
      // own first arm has already proved by the time D runs: it could not fail,
      // so DF2.2's five-assertion gate was effectively four.
      note: "stamped limitMicroUsd is a spendable positive integer",
      run: async () => {
        const limit = manifest?.limitMicroUsd;
        return Number.isSafeInteger(limit) && (limit as number) > 0
          ? { ok: true, detail: `${limit as number} µ$` }
          : {
              ok: false,
              detail: `limitMicroUsd is ${JSON.stringify(limit)}, not a positive integer of micro-dollars`,
            };
      },
    },
    {
      item: "E",
      note: "manifest declares a non-empty phases list (DF1.1 schema shape)",
      run: async () => {
        const phases = manifest?.phases;
        return Array.isArray(phases) && phases.length > 0
          ? { ok: true, detail: `${phases.length} phases` }
          : { ok: false, detail: "no non-empty root-level phases list" };
      },
    },
  ];
  const assertions: SetupGateResult["assertions"] = [];
  let substrateFailed = false;
  for (const probe of probes) {
    let outcome: { ok: boolean; detail: string; substrate?: boolean };
    try {
      outcome = await probe.run();
    } catch (e) {
      // A rejecting `driver.exec` — SSH transport failure, dead box — used to
      // discard every assertion accumulated so far and escape as a generic
      // exit-1 "dispatch failed after the box was created", costing the
      // operator the per-item evidence the exit-3 envelope carries. It is the
      // box that failed, not the manifest, so it is marked as such.
      outcome = { ok: false, detail: `${SUBSTRATE_MARK}${detailOf(e)}`, substrate: true };
    }
    const { ok, detail, substrate } = outcome;
    if (!ok && substrate === true) substrateFailed = true;
    assertions.push({ item: probe.item, ok, note: ok ? probe.note : `${probe.note} — ${detail}` });
    if (!ok) break;
  }
  const firstFail = assertions.find((a) => !a.ok);
  // The substrate verdict rides a STRUCTURED side channel (see the WeakMap at
  // SUBSTRATE_MARK), not note text an echoed detail could forge.
  const shellSafeRunId = /^[\w.-]{1,128}$/.test(opts.runId)
    ? opts.runId
    : // Not this gate's to fix: the id came from outside the generated grammar.
      // Substituting keeps the command copy-pasteable without injecting whatever
      // the real value carries into the operator's shell; the refusal payload
      // still carries the unmodified runId for correlation.
      "<run-id>";
  const result: SetupGateResult = {
    ready: firstFail === undefined,
    ...(firstFail !== undefined
      ? { failedItem: firstFail.item, assertionCode: FAKE_ASSERTION_CODE[firstFail.item] }
      : {}),
    assertions,
    debugCommands: [`bun scripts/fleet.ts status ${shellSafeRunId}`],
    teardownCommand: `bun scripts/fleet.ts teardown ${shellSafeRunId}`,
    vm,
  };
  markSubstrate(result, substrateFailed);
  return result;
}
