/**
 * DF3.1 Agent C: verbs + status unit tests.
 *
 * MODULE 1 (verbs.ts):
 * - listVerbs() returns exactly 4 entries with exact flag/exit-code shapes
 * - renderHelp() renders from the registry it is HANDED (proved with a
 *   synthetic registry — the real verb names must not leak through)
 * - the declared exitCodes are bound to the codes the CLI can actually return,
 *   in BOTH directions: every observed code is declared AND every declared code
 *   is observed (bar an explicit, documented allowlist for the ones only a full
 *   dispatch wiring can reach)
 * - the `required`/`valueType` columns are observed through the parser, not read
 *   back out of the same table they are asserted against
 *
 * MODULE 2 (status.ts):
 * - join logic across every state (live, boxMissing, boxUnknown, closed,
 *   orphan), including mixed fleets, ownership tags and the INV-1 crash window
 * - the list timeout: default, refusal of a non-positive one, timer cleanup
 * - statusRun validation (canonical RUN_ID_RE/RUN_ID_MAX) and ENOENT handling
 *
 * Fixtures provision through `provisionAdmittedRun` — the production sequence
 * that names the box after the run id and writes `vmName` back — so no test
 * recomputes a box-naming formula the factory does not use.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVerbs, renderHelp, type VerbEntry, type VerbFlag } from "../../src/fleet/verbs.ts";
// `FleetError` from its ONE owner: `status.ts` no longer re-exports it, because
// the barrel star-exports both modules and a duplicate star export breaks the
// day `status.ts` declares its own class of that name.
import { FleetError } from "../../src/fleet/dispatch.ts";
import {
  FLEET_ROW_ID,
  statusAll,
  statusRun,
  type StatusDeps,
  type StatusRow,
} from "../../src/fleet/status.ts";
import { CostLedger } from "../../src/providers/index.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun, SBX_OWNERSHIP_TAG, type ExecResult, type ProviderVm } from "../../src/providers/driver.ts";
import {
  RUN_ID_MAX,
  RUN_ID_RE,
  RunRecordStore,
  type RunRecord,
  type RunRecordPatch,
} from "../../src/providers/run-record.ts";
import { run, type FleetDeps } from "../../scripts/fleet.ts";
import { acquireRunLock, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { liveForeignPid, rejection } from "../helpers.ts";
// DF3.2 probe wiring: the full fanout path needs a key client, a ledger, and
// the fan-out record store the auto-rank reads.
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { goodLedger } from "./helpers.ts";
import { FanoutRecordStore } from "../../src/fleet/fanout.ts";
import { requestApproval } from "../../src/fleet/approval-gate.ts";
import type { ApproverAuth } from "../../src/fleet/approvers.ts";
import { DEFAULT_QUOTA_LIMITS, type LoadedQuotaLimits } from "../../src/providers/quota.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";

/**
 * Await a refusal and hand back the TYPED error — never a bare "something threw".
 *
 * A thin narrowing layer over `rejection` rather than a second implementation of
 * it: the two used to differ only in that this one wrapped a non-Error rejection
 * into an `Error` instead of failing, which made `toBeInstanceOf(FleetError)`
 * the only thing standing between a `throw "…"` regression and a green suite.
 * `rejection` now refuses a non-Error itself, so everything above the type
 * narrowing belongs there and this keeps only the FleetError columns.
 */
async function refusal(
  work: Promise<unknown>,
  exitCode: FleetError["exitCode"],
  code: string,
): Promise<FleetError> {
  const err = await rejection(work);
  expect(err).toBeInstanceOf(FleetError);
  const typed = err as FleetError;
  expect(typed.exitCode).toBe(exitCode);
  expect(typed.code).toBe(code);
  return typed;
}

/**
 * The host token `run-lock.ts` writes into a lock body, READ OFF A REAL LOCK
 * rather than reimplemented here — the same probe `tests/fleet/cli.test.ts`
 * makes, and for the same reason.
 *
 * `lockHost()` is module-private and platform-dependent (`<hostname>` on macOS,
 * `<hostname>/<pid-ns inode>` on Linux). `refuse` classifies a body whose host
 * it cannot match as FOREIGN, and a foreign lock is deliberately never probed
 * for liveness and never marked stale — so a hand-written token that drifts
 * from the source's collapses the held and stale branches this file
 * distinguishes into one "liveness unknown from here" arm that says nothing.
 */
const LOCK_HOST = ((): string => {
  const probeDir = mkdtempSync(join(tmpdir(), "qds-verb-lockhost-"));
  const lock = acquireRunLock(probeDir, "qds-19700101-000000");
  const host = (readFileSync(lock, "utf8").trim().split(/\s+/)[1] ?? "") as string;
  releaseRunLock(lock);
  rmSync(probeDir, { recursive: true, force: true });
  return host;
})();

/**
 * `run-lock.ts`'s own liveness probe (its `isAlive`, which is module-private):
 * signal 0 tests existence, and ESRCH is the ONLY proof of death — EPERM means
 * alive but not ours, which is the answer for pid 1 on every host this suite
 * runs on as a non-root user.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * A `FakeDriver` with its DEADLINED exec channel withheld — the driver every
 * JOIN test in this file provisions and lists through.
 *
 * MODULE 2's subject is the record↔box join: which record joins which box, and
 * which of `live`/`boxMissing`/`boxUnknown`/`closed`/`orphan` that join
 * produces. `live` is the join's own word for "the record is open and the
 * substrate still reports its box".
 *
 * DF1.10 AC5 puts a second read on top of that one: for a row the join made
 * `live`, `fleet status` goes on to read the run's in-box completion marker and
 * — when it is absent — `systemctl is-active` on the run's unit, and REPLACES
 * `live` with what it finds. `markerReader` (status.ts) gates that whole read on
 * the driver having `execTimed`, and DF1.10 gave `FakeDriver` one. So a fake box
 * now gets a real marker read, misses (there is no `/run/journal/final.json` on
 * the machine running this suite), probes a `systemctl` the fake substrate does
 * not have, and fail-closes to `unknown` — the honest AC5 answer, and one that
 * says nothing whatever about the join.
 *
 * Withholding `execTimed` is therefore the repair rather than re-pointing 14
 * assertions at `unknown`: it keeps these tests measuring the thing they are
 * named for. AC5's own vocabulary is the subject of `tests/fleet/status.test.ts`,
 * which drives the marker and unit reads with doubles that answer them.
 *
 * An OWN property shadowing the prototype method, because that is exactly what
 * `markerReader`'s `typeof driver.execTimed === "function"` test reads.
 */
function joinOnlyDriver(root: string): FakeDriver {
  const driver = new FakeDriver(root);
  // `writable` matters: doubles built with `Object.create(driver)` (startDriver)
  // assign their own `execTimed` over this one, and a readonly prototype slot
  // makes that assignment THROW rather than shadow.
  Reflect.defineProperty(driver, "execTimed", { value: undefined, configurable: true, writable: true });
  return driver;
}

/**
 * A driver whose `list` reports the boxes `driver` really has, under a tag of
 * the test's choosing (`null` = untagged, as exedev's `ls --json` reports).
 * The provisioning stays real; only the ownership evidence is varied.
 */
function retagged(driver: FakeDriver, tag: string | null): StatusDeps["driver"] {
  return {
    list: async (name?: string): Promise<ProviderVm[]> =>
      (await driver.list(name)).map(({ tag: _drop, ...vm }) => (tag === null ? vm : { ...vm, tag })),
  };
}

/**
 * The CLI's own exit table, verbatim from `scripts/fleet.ts`'s header: 0 success ·
 * 1 run/provider failure · 2 usage/schema · 3 setup-gate failure · 4 run-not-found ·
 * 5 refused before provisioning · 6 the verb succeeded but a cleanup after it did
 * not (the ledger would not close, or the run lock would not release).
 *
 * A numeric RANGE was the wrong shape for this: `<= 5` failed the moment 6 was
 * declared, and `<= 6` would pass an entry declaring 3 for `harvest` — a code
 * that verb has no path to. Membership in the documented set is the claim.
 *
 * The array is BOUND to the CLI below rather than hand-maintained here: as a
 * literal it is every code the CLI can return, so `toContain` could only ever
 * fail for 7+ — a mutation nobody makes.
 */
const DOCUMENTED_EXIT_CODES = [0, 1, 2, 3, 4, 5, 6];

/**
 * The flag lines rendered for ONE verb: everything between its summary line and
 * its `Exit codes:` line. Scoped per verb deliberately — a flag name may legally
 * be required on one verb and optional on another, so a whole-string search for
 * `--dir` cannot say which entry it just read (and `--dir` is a prefix of
 * `--driver`, which a substring search cannot tell apart at all).
 */
function flagLinesFor(help: string, verb: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  ${verb} `));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.includes("Exit codes:"));
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).map((l) => l.trim());
}

/**
 * Every flag on its OWN line, paired with its OWN valueType and its OWN
 * required/optional word.
 *
 * `toContain("required")` was satisfied by the ternary INVERTED (the one
 * synthetic flag was required, so the word appeared either way) and by a
 * renderer that emitted `--brief (string, required)` / `--driver (path,
 * optional)` — the tokens landed in the string, just not on the right lines.
 * The pairing is the claim: `required` is what DF3.5 turns into a generated
 * skill's call signature, and an optional `--driver` generates a skill whose
 * every call exits 2.
 */
function expectFlagLines(help: string, entry: VerbEntry): void {
  expect(flagLinesFor(help, entry.verb)).toEqual(
    entry.flags.map(
      (f) =>
        `${f.name} (${f.valueType}, ${f.required ? "required" : "optional"})${f.note === undefined ? "" : ` — ${f.note}`}`,
    ),
  );
}

/**
 * `needle` appears in `haystack` in order, gaps allowed. The open-world form of
 * an order pin: a registry that INSERTS a verb keeps every known pair correctly
 * ordered, while one that RESHUFFLES known verbs goes red.
 */
const inOrder = (needle: readonly string[], haystack: readonly string[]): boolean => {
  let i = 0;
  for (const h of haystack) {
    if (h === needle[i]) i += 1;
  }
  return i === needle.length;
};

describe("verbs.ts (registry)", () => {
  test("DOCUMENTED_EXIT_CODES is the CLI's table, not a copy of it that can drift", () => {
    // Everything below asserts `DOCUMENTED_EXIT_CODES` CONTAINS each declared
    // code, and the array is a hand-written copy of the whole table — so the
    // membership check only ever failed for 7 and up. It is worth having only
    // while it is bound to the CLI, and `report()` is the one place a throw
    // becomes a status: it clamps to a literal range that IS the table's extent
    // (anything outside is documented there as a bug in the thrower).
    const cli = readFileSync(join(import.meta.dir, "..", "..", "scripts", "fleet.ts"), "utf8");
    // Whitespace-insensitive, and BOTH spellings of the range — `>= F && <= C`
    // and its De Morgan twin `< F || > C` — so a reformat or an inverted
    // conditional does not red a table that is still correct. matchAll + count,
    // not first-match: `report()` is the ONE throw→status boundary, and a
    // second clamp appearing anywhere else in the file must turn this red
    // rather than let the regex silently re-bind the table to whichever site
    // it happened to meet first.
    const clamps = [
      ...cli.matchAll(
        /e\.exitCode\s*(?:>=\s*(\d+)\s*&&\s*e\.exitCode\s*<=\s*(\d+)|<\s*(\d+)\s*\|\|\s*e\.exitCode\s*>\s*(\d+))/g,
      ),
    ];
    expect(clamps).toHaveLength(1);
    const [, geFloor, leCeiling, ltFloor, gtCeiling] = clamps[0] as RegExpMatchArray;
    const floor = Number(geFloor ?? ltFloor);
    const ceiling = Number(leCeiling ?? gtCeiling);
    // The clamp's floor is 1, not 0: `report` is only ever reached from a catch,
    // so 0 is the one value it must refuse rather than the bottom of the table.
    expect(floor).toBe(1);
    expect(DOCUMENTED_EXIT_CODES).toEqual([
      0,
      ...Array.from({ length: ceiling }, (_, i) => i + 1),
    ]);
  });

  test("D5: the FleetError refusal union is 1–5 at BOTH declarations, and nothing constructs a 6", () => {
    // The companion to the clamp above, and the alarm D5 exists to leave
    // behind. `report()` accepts 1–6 while `FleetError.exitCode` is typed 1–5,
    // and that gap is DELIBERATE: 6 means the verb's work LANDED, so every real
    // 6 site prints a completion line through `reportCompletion` BEFORE naming
    // the leftover on stderr — two outputs, where a throw renders only the
    // error envelope and would destroy the landed-work record. The full
    // reasoning lives on the class in `dispatch.ts`; this pins it so a future
    // widening has to come here and read it rather than compile silently.
    //
    // Filed as a LOW "type is narrower than the runtime, widen it". The audit
    // said the opposite: the narrowness is the guard. This test is what keeps
    // the next reader from re-filing it.
    const dispatchSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "fleet", "dispatch.ts"), "utf8");
    // BOTH declarations — the class constructor and the module-local `refuse`
    // helper, which declares the identical union INDEPENDENTLY (Session B found
    // the second missing from D5's original write-up, so a check that pinned
    // only the first would leave the finding half-open). Whitespace-normalised
    // so a reformat cannot red a union that is still correct, and an exact
    // `toEqual` on the array so a THIRD declaration appearing is a failure too:
    // a new refusal helper with its own copy is the drift this pins.
    const unions = [...dispatchSrc.matchAll(/exitCode:\s*(\d(?:\s*\|\s*\d)*)\s*,/g)].map((m) =>
      (m[1] as string).replace(/\s+/g, ""),
    );
    expect(unions).toEqual(["1|2|3|4|5", "1|2|3|4|5"]);

    // The other half, and NOT redundant with the union above: a widening alone
    // is inert until something actually throws a 6, and a `new FleetError(6 as
    // 1, …)` cast reaches a 6 past the type without touching either
    // declaration. Scanned across every `.ts` under src/ and scripts/ rather
    // than the files that construct one today, because the point is to catch
    // the site that does not exist yet.
    //
    // Two spellings, because the literal-only scan had a hole exactly the size
    // of the sites it most needed to see: dispatch.ts's `refuse()` and
    // fanout-primitive.ts's `invalid()` construct their error from a PARAMETER,
    // so `new FleetError(exitCode, …)` matches no literal and a 6 threaded
    // through either helper went green. Every such site must declare its code
    // union in a type annotation, and that union is what is pinned instead —
    // a widened annotation (`1 | 2 | … | 6`) turns this red with the file and
    // union named, wherever the widening lands.
    const roots = ["src", "scripts"].map((d) => join(import.meta.dir, "..", "..", d));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const rel of readdirSync(root, { recursive: true }) as string[]) {
        if (!rel.endsWith(".ts")) continue;
        const src = readFileSync(join(root, rel), "utf8");
        for (const m of src.matchAll(/new FleetError\(\s*(\d)/g)) {
          if (m[1] === "6") offenders.push(`${rel}: new FleetError(6, …)`);
        }
        for (const m of src.matchAll(/exitCode\s*:\s*([0-9 |]+)[,)]/g)) {
          const union = (m[1] as string).replace(/[|\s]/g, "");
          if (union.includes("6")) offenders.push(`${rel}: exitCode union admits 6 (${union})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("F6 composition: no verb exposes an admission-skip flag, and the CLI refuses one", () => {
    // Auditor F6 (round 11). The dangerous capability is `dispatch`'s programmatic
    // `{ admitted: true }` seam (DF3.2's fan-out route, dispatch.ts:809): if it
    // ever leaked into the PUBLIC CLI surface as a flag — `--admitted`,
    // `--skip-admission`, `--no-headroom`, anything semantics-adjacent — every
    // headroom/budget gate would be bypassable from a shell with no code change
    // in the gates themselves. Two registry-derived pins close the class rather
    // than any one spelling:
    //   1. NO declared flag on ANY verb carries admission-skipping meaning;
    //   2. the CLI refuses EVERY undeclared flag on EVERY verb (the sweep test
    //      below is that half at runtime; this names the same property for the
    //      skip vocabulary specifically).
    const skipVocabulary = /admit|headroom|budget|ceiling|skip|force|bypass/i;
    /**
     * The ONE argued exemption, keyed to a verb AND a flag so that `--force` on
     * any OTHER verb still reds here, and so a second one has to argue its way
     * past this comment rather than joining a list.
     *
     * `unlock --force` (DF3.4 deferred item D11) matches the vocabulary and is
     * NOT what this test guards. The property is that no CLI flag bypasses an
     * ADMISSION gate — headroom, budget, the dispatch `{admitted:true}` seam —
     * because those decide whether work with a cost may start. `unlock --force`
     * removes an approval LOCK file: it starts nothing, provisions nothing and
     * spends nothing. What it overrides is the liveness proof on a lock whose
     * holder pid may have been recycled, which is a wedge the host genuinely
     * cannot resolve on its own, and it is exit-5-refused without the flag.
     *
     * It is also strictly SAFER than what it replaced: before D11 an invisible
     * `age > 1h` door did this same eviction automatically, with no flag, no log
     * line and no operator in the loop.
     */
    const ARGUED_EXEMPTION = new Set(["unlock --force"]);
    for (const entry of listVerbs()) {
      for (const flag of entry.flags) {
        const exempt = ARGUED_EXEMPTION.has(`${entry.verb} ${flag.name}`);
        expect({ verb: entry.verb, flag: flag.name, matchesSkip: !exempt && skipVocabulary.test(flag.name) }).toEqual({
          verb: entry.verb,
          flag: flag.name,
          matchesSkip: false,
        });
      }
    }
    // And the invariant travels with NEW flags: the sweep derives its list from
    // this same registry, so a future admission-shaped flag is refused against
    // every verb by construction before it can act.
    const allFlags = listVerbs().flatMap((v) => v.flags.map((f) => ({ verb: v.verb, name: f.name })));
    for (const f of allFlags) {
      if (ARGUED_EXEMPTION.has(`${f.verb} ${f.name}`)) continue;
      expect(skipVocabulary.test(f.name)).toBe(false);
    }
    // The exemption cannot outlive the flag it excuses: a stale entry here would
    // silently re-open the hole for a future flag of the same spelling.
    for (const key of ARGUED_EXEMPTION) {
      const [verb, name] = key.split(" ") as [string, string];
      // It must EXCUSE something: every entry is required to match the skip
      // vocabulary it is excused from, because a renamed `--force` would leave
      // the Set entry a silent no-op — the apparatus green while guarding
      // nothing. (A comment may not be asserted against, but the vocabulary
      // the argument is written against can.)
      expect(skipVocabulary.test(name)).toBe(true);
      expect(listVerbs().find((v) => v.verb === verb)?.flags.some((f) => f.name === name)).toBe(true);
    }
  });

  test("listVerbs keeps every known verb", () => {
    // OPEN-WORLD on purpose: an eighth verb must not have to edit this file to
    // exist — the registry may grow additively and every per-verb pin below is
    // keyed by name. What IS pinned here is that no KNOWN verb silently
    // disappears, which a length pin (`toHaveLength(N)`) could never express:
    // it breaks on the legal growth and stays green on the illegal deletion.
    const verbNames = listVerbs().map((v) => v.verb);
    for (const known of ["dispatch", "status", "harvest", "teardown"]) {
      expect(verbNames).toContain(known);
    }
    // DF3.2's additive pair is pinned by name too — appended after the DF3.1
    // four, none of which was edited to make room.
    expect(verbNames).toContain("fanout");
    expect(verbNames).toContain("rank");
    // Relative order of the known verbs is pinned as a SUBSEQUENCE by the
    // same-set test at the bottom of this describe; uniqueness has its own case.
  });

  test("DF3.4's three additive entries: approve, reject, attach", () => {
    const byName = new Map(listVerbs().map((v) => [v.verb, v]));
    for (const name of ["approve", "reject", "attach"]) {
      const entry = byName.get(name);
      expect({ name, found: entry !== undefined }).toEqual({ name, found: true });
      // Identical to harvest/teardown. NO 3 (dispatch-only), and there is no 7.
      // 6 is mandatory even for attach: `finish()` folds an EAGAIN-refused
      // stdout into 6 for every verb that would otherwise return 0 — the same
      // reason `rank` declares it.
      expect({ name, codes: (entry as VerbEntry).exitCodes }).toEqual({ name, codes: [0, 1, 2, 4, 5, 6] });
    }
    const flagNames = (v: string): string[] => (byName.get(v) as VerbEntry).flags.map((f) => f.name);
    // attach REQUIRES --driver: it reaches into the box over the driver port.
    expect(flagNames("attach")).toContain("--driver");
    expect((byName.get("attach") as VerbEntry).flags.find((f) => f.name === "--driver")?.required).toBe(true);
    // approve/reject take NO --driver — ABSENT, not `required: false`. A
    // `required: false` --driver is how DF3.5 would generate a skill whose
    // every call exits 2. `rank` is the precedent.
    expect(flagNames("approve")).not.toContain("--driver");
    expect(flagNames("reject")).not.toContain("--driver");
    // Every verb takes --help; the shape test covers the rest.
    for (const name of ["approve", "reject", "attach"]) expect(flagNames(name)).toContain("--help");
  });

  test("each verb has exact shape with no extra keys", () => {
    for (const v of listVerbs()) {
      // Exact keys: verb, summary, flags, exitCodes
      const keys = Object.keys(v).sort();
      expect(keys).toEqual(["exitCodes", "flags", "summary", "verb"]);

      // Verb is a non-empty string
      expect(typeof v.verb).toBe("string");
      expect(v.verb.length).toBeGreaterThan(0);

      // Summary is a non-empty string
      expect(typeof v.summary).toBe("string");
      expect(v.summary.length).toBeGreaterThan(0);

      // Flags is an array
      expect(Array.isArray(v.flags)).toBe(true);

      // Each flag has exact shape: the three REQUIRED columns, plus at most the
      // one optional `note` (DF3.4 deferred item D2 — the additive widening that
      // let `attach --message` declare its `-` stdin sentinel).
      //
      // Still a CLOSED pin, deliberately: a fourth key is what a `--token` flag
      // or a free-text `description` would arrive as, and the whole point of
      // this case is that the flag table cannot grow columns unnoticed. The set
      // is enumerated, not loosened to "contains the three".
      for (const flag of v.flags) {
        const flagKeys = Object.keys(flag).sort();
        // CLOSED shape: exactly the three required columns, plus at most
        // `note`. (The every-key check this once carried alongside it was its
        // logical consequence — a set differing from the four-key allowlist
        // could not have passed the filter+toEqual above — and said so only
        // less clearly.)
        expect(flagKeys.filter((k) => k !== "note")).toEqual(["name", "required", "valueType"]);
        expect(typeof flag.name).toBe("string");
        expect(typeof flag.required).toBe("boolean");
        expect(["string", "path", "boolean"]).toContain(flag.valueType);
        // A note is optional, but an EMPTY one is a bug: `renderHelp` would
        // print a dangling em dash, and a generated skill an empty sentence.
        if (flag.note !== undefined) {
          expect(typeof flag.note).toBe("string");
          expect(flag.note.length).toBeGreaterThan(0);
          // One line. A newline here splits the flag block into a phantom flag.
          expect(flag.note).not.toContain("\n");
        }
      }

      // Exit codes is an array of numbers, each one FROM the documented table.
      expect(Array.isArray(v.exitCodes)).toBe(true);
      for (const code of v.exitCodes) {
        expect(typeof code).toBe("number");
        expect(DOCUMENTED_EXIT_CODES).toContain(code);
      }
      // Every verb can succeed, and every verb can be mis-invoked.
      expect(v.exitCodes).toContain(0);
      expect(v.exitCodes).toContain(2);
      // Every verb takes --help; the CLI advertises `fleet <verb> --help`.
      expect(v.flags.some((f) => f.name === "--help" && f.valueType === "boolean")).toBe(true);
    }
  });

  /**
   * The WHOLE flag table per verb, not a length plus a name probe: `--dir`
   * declared as `{required: true}` or `{valueType: "boolean"}` is a different
   * grammar, and the CLI validates argv against exactly these entries.
   */
  const EXPECTED_FLAGS: Record<string, VerbFlag[]> = {
    dispatch: [
      { name: "--brief", required: false, valueType: "path" },
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--port", required: false, valueType: "string" },
    ],
    status: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ],
    harvest: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ],
    teardown: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--no-harvest", required: false, valueType: "boolean" },
    ],
    // DF3.2's additive entries (integration spec D12 + ruling C2's
    // --steps-json). --n/--cap-micro-usd are "string": the CLI range-checks
    // them as integers rather than trusting Number()'s coercions.
    fanout: [
      { name: "--brief", required: false, valueType: "path" },
      { name: "--cap-micro-usd", required: false, valueType: "string" },
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      // F049: the fan-outs directory's own flag. `--dir` above is the OLD
      // spelling of the same directory, kept for one release with a stderr
      // deprecation — on every other verb `--dir` is the RUNS directory.
      { name: "--fanouts-dir", required: false, valueType: "path" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--n", required: true, valueType: "string" },
      { name: "--pattern", required: true, valueType: "string" },
      { name: "--pin", required: false, valueType: "string" },
      { name: "--roster", required: false, valueType: "string" },
    ],
    // NO --driver BY DESIGN: rank touches fan-out records and step output only.
    rank: [
      { name: "--dir", required: false, valueType: "path" },
      // F049, as on fanout: rank reads what fanout wrote, so it takes the same
      // pair with the same one-release deprecation on `--dir`.
      { name: "--fanouts-dir", required: false, valueType: "path" },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--steps-json", required: false, valueType: "path" },
    ],
    /**
     * DF3.4's three, held to the SAME exact snapshot as the six above rather
     * than the presence probes they arrived with (`--driver` and `--help`).
     *
     * The gap that closes is a live one: adding `{name: "--approver-token", …}`
     * to `approve` plus a `flags.get` fallback in scripts/fleet.ts passed every
     * test in that PR — the two "no token leaks" cases never supply a token, so
     * they cannot see one on argv — and DF3.5 then generates a skill that puts
     * the approver's secret in `ps` output for every process on the host. The
     * whole reason no `--token` flag exists is INV-CRED-3, and a flag table is
     * where that invariant is actually written down.
     *
     * NO --driver on approve/reject: ABSENT, not `required: false`. `rank` is
     * the precedent, and `required: false` is how DF3.5 would generate a skill
     * whose every call exits 2.
     *
     * `--approver` is `required: true` for the mirror-image reason, and the
     * exit-code cases below are what pin it: scripts/fleet.ts refuses a missing
     * OR empty `--approver` as exit 2, so declaring it optional here is the
     * SAME "generated skill exits 2 every call" defect the paragraph above
     * describes — reached through the flag that is present rather than the one
     * that is absent.
     */
    approve: [
      { name: "--approver", required: true, valueType: "string" },
      // F5: DUAL-purpose, and the note is what says so — `(path, optional)`
      // reads like the runs directory every other verb takes, and approve also
      // reads its run record and bundle from it. Pinned verbatim for the same
      // reason `--message`'s note is.
      {
        name: "--dir",
        required: false,
        valueType: "path",
        note: "allowlist host root AND runs directory — this verb reads its run record and bundle from this path too",
      },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--reason", required: false, valueType: "string" },
    ],
    reject: [
      { name: "--approver", required: true, valueType: "string" },
      // The SAME note as approve's: reject shares its argv block, so `--help`
      // must not describe the same flag two different ways.
      {
        name: "--dir",
        required: false,
        valueType: "path",
        note: "allowlist host root AND runs directory — this verb reads its run record and bundle from this path too",
      },
      { name: "--help", required: false, valueType: "boolean" },
      { name: "--reason", required: false, valueType: "string" },
    ],
    // --driver REQUIRED here, unlike its two siblings: attach reaches INTO the
    // box over DF2.1's driver port, so it must never default one.
    // `--message` carries the ONE `note` in the registry (DF3.4 deferred item
    // D2). Pinned VERBATIM, like every other column: the note is what `--help`
    // and any DF3.5-generated skill tell an operator about the `-` sentinel, so
    // silently rewording it is the same class of drift as silently flipping
    // `required`. It is also the pin that keeps a note from being added to some
    // other flag as a general description field.
    attach: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
      {
        name: "--message",
        required: false,
        valueType: "string",
        note: "the value `-` reads the message from stdin, as does omitting the flag; to send the literal one-character message `-`, pipe it instead",
      },
    ],
    // D9's enrolment writer. `--approver` is required:true for the same reason
    // approve/reject's is — scripts/fleet.ts refuses without it as exit 2, and a
    // DF3.5 skill generated from an "optional" declaration would exit 2 on every
    // call. `--rotate` carries the registry's THIRD note: `(boolean, optional)`
    // reads like a convenience switch, and this one destroys a live credential.
    enrol: [
      { name: "--approver", required: true, valueType: "string" },
      // F5: the allowlist half of `--dir` only — approve's is dual-purpose, and
      // the note is where the difference is spelled out for `--help`.
      {
        name: "--dir",
        required: false,
        valueType: "path",
        note: "the allowlist's HOST ROOT — the allowlist half of `approve`'s dual-purpose --dir, whose runs-directory half this verb never touches",
      },
      { name: "--help", required: false, valueType: "boolean" },
      // F7: the token's out-of-band channel. Pinned verbatim like the other
      // notes — this is what `--help` tells an operator whose stdout is captured.
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
        note: "re-mints an already-enrolled approver's token; their current one stops working immediately",
      },
    ],
    // D11. NO --driver and NO --approver: it removes one lock file and decides
    // nothing, so neither guard has a hazard to prevent here (the ruling is
    // recorded at `reclaimApprovalLock`). `--force` carries the registry's
    // SECOND `note`, pinned verbatim for the same reason `--message`'s is: it is
    // what `--help` and any DF3.5-generated skill tell an operator about a flag
    // that can put two processes in one critical section, and `(boolean,
    // optional)` alone reads like a convenience switch.
    unlock: [
      { name: "--dir", required: false, valueType: "path" },
      {
        name: "--force",
        required: false,
        valueType: "boolean",
        note: "removes the lock even when its holder is still running — only after you have confirmed no reverify is live for this run",
      },
      { name: "--help", required: false, valueType: "boolean" },
    ],
    // DF1.10. `--driver` REQUIRED: this verb reaches into the box over the
    // driver port to start a systemd unit, so it may never default one. No
    // `--force`, no `--restart`: the double-start window is closed by systemd's
    // unit identity (AC6), and a flag that overrode it would be a flag for
    // re-walking phases whose spend already happened.
    run: [
      { name: "--dir", required: false, valueType: "path" },
      { name: "--driver", required: true, valueType: "string" },
      { name: "--help", required: false, valueType: "boolean" },
    ],
  };

  const EXPECTED_EXIT_CODES: Record<string, number[]> = {
    // 3 = setup gate, 5 = refused before provisioning; dispatch alone can reach them.
    // 6 = the box is LIVE and its ack could not be written to stdout
    // (`fleet dispatch … | head -0`). It was missing from the registry while
    // `scripts/fleet.ts` returned it, which is the one omission that matters
    // most: 6 is the code whose remediation is "`fleet teardown <id>` now or it
    // keeps billing", and a DF3.5 skill generated from an incomplete table drops
    // it into a default branch. See the ack-unwritable case in cli.test.ts.
    dispatch: [0, 1, 2, 3, 5, 6],
    // 2 is real for all three: a malformed id, an extra positional and a flag
    // the verb does not take are all refused as usage.
    status: [0, 1, 2, 4],
    // 6 = the verb SUCCEEDED and a cleanup after it did not (the cost ledger
    // would not close, or the run lock would not release). Deliberately not 1:
    // exit 1 means "the substrate failed, retry" and `logVerb` classifies it
    // `transient`, but the work here already landed and a retry only re-hits the
    // wedged lock. `status` cannot reach it — it takes neither lock nor ledger.
    // Demonstrated, not merely declared: see the exit-6 probes below.
    //
    // 5 = the run lock refused, so the verb never ran. Also deliberately not 1,
    // and for the mirror-image reason: `transient` tells automation to retry, and
    // for a STALE lock nothing will ever clear it. 5 is "refused before
    // provisioning", which is exactly what an acquire refusal is — the throw sits
    // between the record probe and any mutation. Demonstrated by the lock probes.
    harvest: [0, 1, 2, 4, 5, 6],
    teardown: [0, 1, 2, 4, 5, 6],
    // DF3.2. fanout: 1 = any collected arm failure (setupFailed/armFailed/
    // armUnknown) after a result returned; 5 = refused before anything was
    // provisioned (fleet-busy, no-headroom); 6 = the arms LANDED and a
    // completion line would not print. rank: 4 = unknown/unparseable fan-out
    // id, 1 = record read/write failure, 6 = the ranking LANDED and its result
    // line would not print (the shared finish folds an EAGAIN-refused stdout
    // into 6 for every verb that emits one). Still no 5: rank refuses nothing
    // before provisioning, because it never provisions.
    fanout: [0, 1, 2, 5, 6],
    rank: [0, 1, 2, 4, 6],
    // DF3.4. Identical to harvest/teardown, and every one of the six is genuinely
    // reachable — the probe table below reaches 0/2/4/5 and gate-verbs.test.ts
    // owns 1 (an untyped throw past the existence check) and 6 (the work landed
    // and its line would not print). No 3: that is dispatch's setup gate.
    approve: [0, 1, 2, 4, 5, 6],
    reject: [0, 1, 2, 4, 5, 6],
    attach: [0, 1, 2, 4, 5, 6],
    // D9. No 4 — there is no run to be absent. 5 covers every guard refusal
    // (the allowlist's path/mode/owner arms, an already-enrolled id without
    // --rotate, an unwritable file); 6 is the entry landing on disk while the
    // MINTED TOKEN could not be printed, which is the worst line in this CLI to
    // lose and whose remediation is `--rotate`, not a retry.
    enrol: [0, 1, 2, 5, 6],
    // D11. 0 covers BOTH "there was no lock" and "the lock was reclaimed" (a run
    // that is not wedged is the healthy answer, not a soft failure); 5 is EVERY
    // refusal this verb can produce — a missing record, an unreadable record and
    // a live (or unprovable) holder all land on the one generic `unlock-refused`
    // envelope, and the true reason rides only the gate event. That is why 4 is
    // GONE: a caller who could separate "no such run" from "the holder is alive"
    // by exit code could enumerate run ids without ever touching a lock, the
    // same oracle round 9 closed for approve/reject; 6 = the lock WAS removed
    // and the line would not print. No 3: that is dispatch's setup gate.
    unlock: [0, 1, 2, 5, 6],
    // DF1.10. 4 = no such run record (harvest/teardown/status's meaning). 5 is
    // TWO refusals sharing one posture — the record says the box is gone
    // (`run-not-startable`), and systemd ran the start job and it FAILED
    // (`AssertPathExists=` on the credential file, no such unit on a box from
    // the wrong image) — because both are identical on every retry and 1 is
    // `transient` = "retry me". 1 is reserved for the one arm a retry CAN
    // clear: the box never answered. Retrying THAT is safe by AC6's unit
    // identity, so the split is not cosmetic. 6 = the engine started and the
    // result line would not print. No 3: that is dispatch's setup gate, and
    // this verb provisions nothing.
    run: [0, 1, 2, 4, 5, 6],
  };

  // Every entry in the snapshot records, iterated. A hand-written list was the
  // original hole: approve/reject/attach were added to it in one diff while
  // enrol/unlock were added to BOTH snapshot records in the same diff and to
  // no list at all — so their verbatim `--rotate`/`--force` notes, `enrol
  // --approver required:true` and unlock's declared exit codes sat in dead
  // data that no test consumed, and deleting the `--force` note or flipping
  // `--approver` to optional stayed green. Driven from `Object.keys` instead,
  // the records and the loop cannot disagree: a verb snapshot here is a verb
  // pinned there, and a record entry with no registry verb fails the lookup.
  for (const verb of Object.keys(EXPECTED_FLAGS)) {
    test(`${verb} verb declares its exact flag table and exit codes`, () => {
      const entry = listVerbs().find((v) => v.verb === verb);
      expect(entry).toBeDefined();
      const flags: VerbFlag[] = [...entry!.flags].sort((a, b) => a.name.localeCompare(b.name));
      expect(flags).toEqual(EXPECTED_FLAGS[verb]!);
      expect(entry!.exitCodes).toEqual(EXPECTED_EXIT_CODES[verb]!);
    });
  }
  // The other direction, so a snapshot entry whose registry verb vanished (or
  // was renamed) is a failure here rather than an orphaned record key: the
  // records must name exactly the registry's verbs, no more and no fewer.
  test("the snapshot records cover exactly the registry's verbs", () => {
    expect(Object.keys(EXPECTED_FLAGS).sort()).toEqual(listVerbs().map((v) => v.verb).sort());
    expect(Object.keys(EXPECTED_EXIT_CODES).sort()).toEqual(Object.keys(EXPECTED_FLAGS).sort());
  });

  test("verbs are unique", () => {
    const verbNames = listVerbs().map((v) => v.verb);
    expect(new Set(verbNames).size).toBe(verbNames.length);
  });

  test("renderHelp renders the registry it is HANDED, not a hard-coded list", () => {
    // The doc contract is "the ONLY place --help content lives". A body that
    // ignores `registry` and prints the four real verbs passes any assertion
    // made against the real registry — so assert against a synthetic one.
    const synthetic: VerbEntry[] = [
      {
        verb: "syntheticverb",
        summary: "a verb that exists only in this test",
        // BOTH polarities, because one required flag makes `required ? … : …`
        // pass with the ternary INVERTED — and `required` is what DF3.5 generates
        // a skill's call signature from.
        flags: [
          { name: "--synthetic", required: true, valueType: "path" },
          { name: "--optional", required: false, valueType: "string" },
        ],
        exitCodes: [7],
      },
    ];
    const help = renderHelp(synthetic);
    expect(help).toContain("syntheticverb");
    expect(help).toContain("a verb that exists only in this test");
    // T1-12 (round 11): the exitCodes COLUMN form, not a bare substring —
    // `toContain("7")` was satisfied by "17"/"70"/any stray 7 anywhere in the
    // text. The real-registry test pins `join(", ")`; this pins it on a
    // synthetic registry too, so a renderer corrupting just this line fails
    // here and not only on main's data.
    expect(help).toMatch(/^ *Exit codes: 7$/m);
    expectFlagLines(help, synthetic[0]!);

    // ONE rendered entry, because one was handed over — a body that ignores
    // `registry` renders four. This is the primary signal and it cannot be
    // weakened by anything the static header or footer says.
    expect(help.split("Exit codes:")).toHaveLength(2);
    // The name leak is checked against the rendered ENTRIES only (every line
    // renderHelp indents), not the whole string: a header or footer containing
    // the word "status" is not the real registry bleeding through, and forbidding
    // four such common substrings everywhere fails a correct implementation.
    const entries = help
      .split("\n")
      .filter((l) => l.startsWith("  "))
      .join("\n");
    expect(entries).toContain("syntheticverb");
    for (const real of ["dispatch", "status", "harvest", "teardown", "fanout", "rank"]) {
      expect(entries).not.toContain(real);
    }
  });

  test("renderHelp generates usage from the real registry", () => {
    const registry: VerbEntry[] = listVerbs();
    const help = renderHelp(registry);
    expect(typeof help).toBe("string");
    expect(help.length).toBeGreaterThan(0);

    for (const entry of registry) {
      expect(help).toContain(entry.verb);
      expect(help).toContain(entry.summary);
      // Name AND valueType AND polarity, on the same line, for every flag —
      // the old `toContain(flag.name)` said nothing about the other two columns.
      expectFlagLines(help, entry);
      expect(help).toContain(entry.exitCodes.join(", "));
      // Both polarities really are exercised on every verb, so the pairing above
      // cannot be satisfied by an inverted ternary. rank is the ONE exemption:
      // it declares no --driver (nothing it does consumes a driver), and its
      // remaining flags are all genuinely optional, so `required` never appears
      // — the DF3.2 ruling, pinned here so a re-added required flag must argue
      // its way past this sentence.
      // DF3.4: approve/reject join rank as driver-less verbs, and their
      // remaining flags are all genuinely optional too — same argued exemption.
      // D11's `unlock` is the fourth: it takes a <run-id> POSITIONAL (which C6
      // keeps out of the flags list by design) and nothing else it could
      // require, so every declared flag on it is genuinely optional.
      if (!["rank", "approve", "reject", "unlock"].includes(entry.verb)) {
        expect(entry.flags.some((f) => f.required)).toBe(true);
      }
      expect(entry.flags.some((f) => !f.required)).toBe(true);
    }
    // Anchored to the FIRST line. `/Usage:|usage:|FLAGS/i` was satisfied by the
    // word "usage" appearing anywhere — including inside a summary — so losing
    // the usage line entirely still passed.
    expect(help.split("\n")[0]).toMatch(/^Usage: fleet /);
    // No trailing blank line: renderHelp trimEnd()s, and the callers append
    // their own "\n".
    expect(help).not.toMatch(/\n\s*$/);
  });
});

/**
 * The registry is a CONTRACT (DF3.5's skill-contract test reads it), so the
 * declared exit codes must be bound to the ones the CLI can actually return —
 * by a test, not by hope. `[0,1,4]` declared against a demonstrable exit 2 is
 * exactly how the last divergence shipped green.
 */
describe("verbs.ts ↔ scripts/fleet.ts exit codes", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  // DF3.2 probes reach the fanout/rank wiring, whose stores resolve
  // cwd-relative defaults — redirected into the case tmpdir like cli.test.ts
  // does for QDS_RUNS_DIR, so a probe can never litter the repo's .sandbox.
  let savedDirs: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-verb-exit-"));
    // No `execTimed`: the status probe below pins the JOIN's `live`, not AC5's
    // in-box read — see joinOnlyDriver.
    driver = joinOnlyDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
    savedDirs = {
      QDS_RUNS_DIR: process.env.QDS_RUNS_DIR,
      QDS_FANOUTS_DIR: process.env.QDS_FANOUTS_DIR,
    };
    process.env.QDS_RUNS_DIR = join(dir, "sandbox-runs");
    process.env.QDS_FANOUTS_DIR = join(dir, "fanouts");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedDirs)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One invocation with BOTH streams captured. Passing `() => {}` for each threw
   * away the only evidence that AC1's "exits 2 naming the offending field" is
   * anything more than an exit code: a refactor that returned the right code and
   * printed nothing, or printed the envelope onto stdout — poisoning the JSON
   * lines a caller pipes `fleet status` into — was indistinguishable.
   */
  async function invoke(
    argv: string[],
    deps: Partial<FleetDeps>,
  ): Promise<{ code: number; out: string; err: string }> {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const code = await run(
      argv,
      (s) => void outChunks.push(s),
      deps,
      (s) => void errChunks.push(s),
    );
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  }

  /**
   * A store whose directory listing is unreadable — status's only route to exit 1.
   *
   * `listWithAnomalies`, the accessor `statusAll` really calls: a stub declaring
   * only `list` still produced exit 1, but from a TypeError about a missing
   * method rather than from the store failure it claims to inject.
   */
  const unlistableStore = (): RunRecordStore =>
    ({
      dir: store.dir,
      listWithAnomalies: (): never => {
        throw new Error("malformed run record beta.json: unknown key: nope");
      },
    }) as unknown as RunRecordStore;

  /**
   * A store whose record read fails for a reason that is NOT absence — the
   * harvest/teardown route to exit 1. `getRecord` classifies on the errno, so a
   * plain Error is a `record-read-failed`, not a `no-record`.
   */
  const unreadableStore = (): RunRecordStore =>
    ({
      dir: store.dir,
      get: (): RunRecord => {
        throw new Error("record store on fire");
      },
    }) as unknown as RunRecordStore;

  /**
   * A store that wedges its own run lock: the SECOND `get` is fleet.ts's
   * post-lock read, so by then `<dir>/<runId>.lock` exists — rewriting its body
   * makes `releaseRunLock` refuse it as a foreign claim. That is exactly and only
   * what exit 6 reports (the verb succeeded, the cleanup after it did not), and
   * it is the lightest injection that reaches it: no ledger, no signal, no clock.
   */
  const lockWedgingStore = (): RunRecordStore => {
    let reads = 0;
    return Object.assign(Object.create(store) as RunRecordStore, {
      get(runId: string): RunRecord {
        const rec = store.get(runId);
        if (++reads === 2) writeFileSync(join(store.dir, `${runId}.lock`), "another invocation\n");
        return rec;
      },
    });
  };

  /**
   * A claim at `<store.dir>/<runId>.lock` in the body layout `acquireRunLock`
   * writes (`<pid> <host> <ISO> <nonce>`), under THIS host's token so `refuse()`
   * probes the pid rather than calling its liveness unknowable.
   *
   * Either way the CLI owes exit 5: the throw sits between the record probe and
   * any mutation, so nothing was touched, and exit 1 would stamp it `transient`
   * and tell automation to retry a lock that — in the stale case — nothing will
   * ever clear. But 5 and the `run-locked` message are IDENTICAL on the two
   * branches, so a probe asserting only those cannot tell a held lock from a
   * dead one, and an `isAlive` gutted to a constant passes it while sending an
   * operator to `rm` the lock of a teardown that is still destroying the run.
   * The REMEDIATION is the only field that differs, so each probe pins its own.
   *
   * Written by hand rather than by calling `acquireRunLock`: this process would
   * then hold it, and the release inside the verb's `finally` would be a real
   * release of a lock the test still owns.
   */
  const writeRunLock = (runId: string, pid: number, ageMs: number): void => {
    writeFileSync(
      join(store.dir, `${runId}.lock`),
      `${pid} ${LOCK_HOST} ${new Date(Date.now() - ageMs).toISOString()} beefcafe\n`,
    );
  };

  /**
   * A pid that is ALIVE and is NOT ours. The run lock is not re-entrant, so a
   * body carrying our own pid+host is refused as `run-lock-reentrant` — a
   * programming error — before `refuse` ever classifies it as contention.
   *
   * A child THIS suite owns, not a guess at one. `process.ppid` with a fallback
   * to pid 1 could be wrong in two directions and silent in both: a parent that
   * exits mid-suite turns the probe into the STALE case in disguise, and in a
   * container the fallback IS us, so the lock reads as re-entrancy. Neither
   * fails the assertion below — they just move it onto the wrong branch.
   */
  const foreignLive = liveForeignPid();
  afterAll(foreignLive.stop);
  const FOREIGN_LIVE_PID = foreignLive.pid;

  const holdRunLock = (runId: string): void => {
    // Still asserted, now as a precondition rather than a hope: the child is
    // kept alive for the whole suite, so this can only fail if the spawn itself
    // did — and that should say so here, not three assertions downstream.
    expect(isAlive(FOREIGN_LIVE_PID)).toBe(true);
    writeRunLock(runId, FOREIGN_LIVE_PID, 4_000);
  };

  /**
   * The other branch: a pid above every platform's pid_max, so `kill(pid, 0)`
   * answers ESRCH and `refuse` marks the lock stale. Nothing will ever release
   * it, which is exactly why the refusal must not be exit 1 `transient`.
   */
  const DEAD_PID = 9_999_999;
  const holdStaleRunLock = (runId: string): void => {
    expect(isAlive(DEAD_PID)).toBe(false);
    writeRunLock(runId, DEAD_PID, 90_000);
  };

  interface Probe {
    argv: string[];
    /**
     * What this invocation really returns. Pinned exactly, so neither direction
     * of the set check below can be satisfied vacuously by a probe that stopped
     * reaching the verb.
     */
    code: number;
    /** Deps for it. Default: the working driver + store, brief = invalid JSON. */
    deps?: () => Partial<FleetDeps>;
    /**
     * Must appear on stderr — and, whatever it is, never on stdout. A LIST where
     * one substring cannot separate two refusals that share a code and a
     * message: the live and stale lock branches differ only in their
     * remediation, and the teardown waiver rides alongside `torn down:`.
     */
    stderr?: string | string[];
    /** Must appear on stdout (the verb's own output). */
    stdout?: string | string[];
    /**
     * stdout must be EXACTLY empty. Not expressible via `stdout` — every value
     * there is matched with stringContaining, which `""` satisfies vacuously —
     * and emptiness is its own claim: an empty fleet whose status prints
     * nothing-by-crash (a skipped emitter) must not pass as quiet-by-design.
     */
    stdoutEmpty?: boolean;
    /** A run to provision first, so the probe has something real to act on. */
    provision?: string;
    /** Filesystem set-up run after the provisioning and before the invocation. Awaited, so async set-up lands before the invocation. */
    before?: () => void | Promise<void>;
    /**
     * Run after the invocation, with the captured result — for the claims that
     * live in the STORE, not on stdout: a CLI printing a state it never
     * persisted satisfies any substring pin, and the comment these probes carry
     * says "a decision that never reached the record still exits 0". Awaited,
     * and the assertions inside count toward the probe's own test.
     */
    after?: (res: { code: number; out: string; err: string }) => void | Promise<void>;
  }

  /**
   * Full fanout wiring under the case tmpdir (DF3.2): manifest + brief written
   * lazily, every store/lock path redirected, so a probe that reaches the
   * primitive never touches the repo's .sandbox. The env redirects in
   * beforeEach cover the stores' own defaults; these seams cover the rest.
   */
  const fanBrief = (): string => {
    mkdirSync(join(dir, "manifests"), { recursive: true });
    writeFileSync(
      join(dir, "manifests", "pipeline.json"),
      JSON.stringify({
        version: "1.0.0",
        pipelineId: "probe-pipeline",
        runBudgetMs: 200_000,
        // BOTH phases `code`. `plan` was `kind: "engineer"` until C19 narrowed
        // `PhaseKind` to `"code" | "dispatch_task"` and taught the schema to
        // refuse the removed kinds AT LOAD — so this fixture stopped parsing,
        // every fan-out arm settled `armFailed` instead of `ready`, and the
        // exit-code probe table below failed on an assertion that had nothing to
        // do with exit codes. It did NOT fail `tsc`: the manifest is an untyped
        // object literal written through `JSON.stringify`, so the narrowing was
        // invisible to the compiler and only the runtime parse caught it.
        //
        // `code`, not `dispatch_task`: nothing in this file asserts a phase KIND
        // — the manifest is parsed by `loadManifest` at dispatch and never
        // walked — so what the fixture has to be is a manifest that PARSES and
        // has more than one phase. `dispatch_task` would drag in `roster` and
        // `task` (and a roster that resolves) to buy a distinction no assertion
        // here reads. `command` is mandatory when kind is `code` and forbidden
        // otherwise (PhaseSpecSchema's superRefine), hence the argv.
        phases: [
          { name: "plan", kind: "code", description: "Draft the approach", command: ["bun", "--version"], maxDurationMs: 10_000, retries: 0 },
          { name: "build", kind: "code", description: "Run the suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
        ],
      }),
    );
    return JSON.stringify({
      repoSlug: "owner/repo",
      issueId: 7,
      commitSha: "c".repeat(40),
      manifestPath: join("manifests", "pipeline.json"),
      repoUrl: "https://github.com/owner/repo",
    });
  };
  const fanDeps = (): Partial<FleetDeps> => ({
    driver,
    store,
    keyApi: new FakeKeyApi(),
    ledgerFactory: () => goodLedger(),
    readBrief: async () => fanBrief(),
    repoRoot: dir,
    fanoutsDir: join(dir, "fanouts"),
    lockPath: join(dir, "fleet.lock"),
  });
  const lowCeiling = (maxVms: number): LoadedQuotaLimits => ({
    limits: { ...DEFAULT_QUOTA_LIMITS, maxVms },
    source: "default",
  });

  /**
   * DF3.4's gate verbs. `authenticate` MUST be injected — production reads the
   * token off fd 0, which a probe cannot attach to — and it takes its arguments
   * rather than returning a closure default, so a probe asserting
   * `"approverId":"alice"` on stdout is asserting a value that travelled through
   * the CLI. NO driver: approve/reject declare none and `parseArgv` refuses one.
   *
   * `auth` overrides the injected answer: the REFUSAL arm is a real exit path
   * (the CLI maps it to 5 with the refusal printed), and a table that only ever
   * injected `ok:true` proved nothing about where an auth refusal lands.
   */
  const gateDeps = (
    auth: (hostRoot: string, approverId: string) => ApproverAuth = (_h, approverId) => ({
      ok: true,
      approverId,
    }),
  ): Partial<FleetDeps> => ({
    store,
    authenticate: async (hostRoot, approverId) => auth(hostRoot, approverId),
  });

  /** A run parked at the gate, as `requestApproval` really leaves one. */
  const pauseRun = async (runId: string): Promise<void> => {
    store.create(runId);
    // The harvested bundle a real pause always sits over: production's
    // `requestApproval` runs with `bundleDir` wired, so a record that reached
    // the gate provably had one — and the decide path now enforces the same
    // invariant (`submitDecision` refuses a decision over a bundle that is
    // gone). Without it, every approve/reject success probe here would be
    // answered by that refusal instead of a decision.
    writeFileSync(join(store.dir, `${runId}.bundle`), "harvested");
    await requestApproval({ store }, runId, { proposal: "open a PR", reportId: `rv-${runId}`, headSha: "a".repeat(40) });
  };

  /**
   * DF1.10's `run` reaches the box with `sudo -n systemctl start …` — an argv
   * the shared FakeDriver would SPAWN FOR REAL, because its contract is to pass
   * argv verbatim to `Bun.spawn`. A probe table that used it would try to start
   * systemd units on whatever machine runs the suite. Every `run` probe
   * therefore injects a scripted driver: the exec's ANSWER is what these probes
   * are about.
   *
   * The argv is ASSERTED, not merely answered — and the assertion has to live
   * OUTSIDE the double. This double used to reply `{exitCode}` to anything at
   * all, so a `fleet run` that started the wrong unit, on the wrong run id, or
   * without `sudo -n` still exited 0 and printed `started:`; putting
   * `expect(argv)` INSIDE the double did not fix that, because a throwing
   * expect rejects the exec promise and `unitActivity`'s never-throw catch
   * converts that to `unknown` — the start's verdict stands, the probe passes,
   * and the assertion is silently gone (a corroboration call dropped entirely
   * fires no expect at all). So the double RECORDS every argv, and the probes
   * assert the recording in `after`, where nothing swallows them. AC6's whole
   * safety argument is the unit IDENTITY, so the identity is where the
   * assertion belongs.
   *
   * BOTH exec channels, and every argv of the sequence: `startRun` prefers
   * `execTimed` (its deadline must reach the spawn), guards the start with a
   * PRE-START `is-active` (a unit already `failed` re-runs ExecStart — that
   * refusal arm is probed below), and since DF1.10 CORROBORATES an accepted
   * start with `systemctl is-active` on the same unit — three driver calls on
   * the success path, not one. The probes are answered with empty stdout,
   * which `unitActivity` reads as `unknown`: no evidence either way, so the
   * start's own verdict stands and these probes stay about the start.
   *
   * Prototype delegation over the real FakeDriver rather than an
   * `as unknown as ProviderDriver` cast: the double then IS a `ProviderDriver`
   * without asserting so, and the cast can no longer hide a method the verb
   * grows a dependency on — which is exactly how the missing `execTimed` went
   * unnoticed here.
   */
  const startDriver = (
    exitCode: number,
    stderr = "",
    /** Every argv issued through this double, in order — asserted in `after`. */
    calls: string[][] = [],
  ): Partial<FleetDeps> => {
    const answer = (argv: string[]): ExecResult => {
      calls.push(argv);
      if (argv[0] === "systemctl") {
        // The corroboration probe: answered `unknown` (empty stdout, exit 0).
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr, exitCode };
    };
    return {
      store,
      driver: Object.assign(Object.create(driver) as FakeDriver, {
        exec: async (_vm: string, argv: string[]): Promise<ExecResult> => answer(argv),
        execTimed: async (_vm: string, argv: string[], _ms: number): Promise<ExecResult> => answer(argv),
      }),
    };
  };

  /**
   * The exit-0 probe's recording: the success path must issue pre-start
   * `is-active`, the `sudo -n` start, and the corroborating `is-active`, all on
   * the SAME unit (`qds-run@<run-id>.service`). Declared here because `deps`
   * and `after` are separate closures over it.
   */
  const corroborated: string[][] = [];

  /** Invocations whose refusal (or success) each verb can really produce. */
  const PROBES: Record<string, Probe[]> = {
    dispatch: [
      { argv: ["dispatch"], code: 2, stderr: "not valid JSON" }, // the injected brief
      { argv: ["dispatch", "stray-positional"], code: 2, stderr: "no positional arguments" },
      { argv: ["dispatch", "--port", "0"], code: 2, stderr: "--port" },
      // A flag the registry does not give dispatch.
      { argv: ["dispatch", "--no-harvest"], code: 2, stderr: "does not take --no-harvest" },
      // `--driver` is required:true, and nothing is injected to stand in for it.
      { argv: ["dispatch"], code: 2, deps: () => ({ store }), stderr: "dispatch requires --driver" },
    ],
    status: [
      // Empty fleet is a state, not an error (AC4) — and the emptiness is
      // ASSERTED rather than assumed. Every probe in this file shares ONE store
      // and they run in `listVerbs()` order, so "no runs yet" is a fact about
      // what happens to run before this line (dispatch's probes, all refusals)
      // and nothing pinned it. `before` makes the dependency fail loudly;
      // `stdoutEmpty` makes the quietness a claim — exit 0 over an empty store
      // is also what a status whose emitter never ran would print.
      {
        argv: ["status"],
        code: 0,
        stdoutEmpty: true,
        before: () => void expect(store.list()).toEqual([]),
      },
      // …and a status that PRINTS. `{code: 0}` over an EMPTY fleet is satisfied
      // by a status whose rows never reach the emitter at all — the row shape,
      // the join and the JSON line could all be gone and the code is still 0.
      {
        argv: ["status"],
        code: 0,
        provision: "status-live",
        stdout: ['"runId":"status-live"', '"state":"live"'],
      },
      { argv: ["status", "no-such-run"], code: 4, stderr: "no-such-run" },
      { argv: ["status", "INVALID_ID"], code: 2, stderr: "INVALID_ID" },
      { argv: ["status", "one", "two"], code: 2, stderr: "at most one" },
      { argv: ["status", "--brief", "somewhere"], code: 2, stderr: "does not take --brief" },
      { argv: ["status"], code: 2, deps: () => ({ store }), stderr: "status requires --driver" },
      {
        argv: ["status"],
        code: 1,
        deps: () => ({ driver, store: unlistableStore() }),
        stderr: "record-store-unreadable",
      },
      // The SINGLE-run path's exit 1, which `unlistableStore` cannot reach (it
      // fails `list()`, i.e. statusAll). Without it, widening statusRun's ENOENT
      // check would make `fleet status <id>` answer "No run record" / exit 4 for
      // a run whose record is merely unreadable, while its box is alive and spending.
      {
        argv: ["status", "some-run"],
        code: 1,
        deps: () => ({ driver, store: unreadableStore() }),
        stderr: "record-read-failed",
      },
    ],
    harvest: [
      { argv: ["harvest"], code: 2, stderr: "requires <run-id>" },
      { argv: ["harvest", "no-such-run"], code: 4, stderr: "no run record for no-such-run" },
      { argv: ["harvest", "INVALID_ID"], code: 2, stderr: "INVALID_ID" },
      { argv: ["harvest", "--no-harvest", "some-run"], code: 2, stderr: "does not take --no-harvest" },
      { argv: ["harvest", "some-run"], code: 2, deps: () => ({ store }), stderr: "harvest requires --driver" },
      {
        // Wave-1 C4 contract update: a corrupt record is 5 (do-not-retry — no
        // retry heals a corrupt record file), not 1 transient.
        argv: ["harvest", "some-run"],
        code: 5,
        deps: () => ({ driver, store: unreadableStore() }),
        stderr: "record-read-failed",
      },
      { argv: ["harvest", "harvest-ok"], code: 0, provision: "harvest-ok", stdout: "harvested: " },
      // The SAME id again: harvest is non-destructive, so a second call over a
      // run it already answered for must answer identically rather than refuse.
      // Every other probe here uses a fresh id invoked exactly once, which is
      // the shape no operator's fleet is ever in.
      { argv: ["harvest", "harvest-ok"], code: 0, stdout: "harvested: " },
      // A run whose record is CLOSED — the commonest state a `fleet harvest`
      // typed after the teardown finds. `harvestRun` keys on `vmName`/`commitSha`
      // and never reads `closedAt`, so nothing pinned that a closed run is a
      // clean exit 0 rather than a throw the CLI reports as a retryable 1.
      {
        argv: ["harvest", "harvest-closed"],
        code: 0,
        provision: "harvest-closed",
        before: () => void store.close("harvest-closed"),
        stdout: "harvested: ",
      },
      {
        argv: ["harvest", "harvest-wedged"],
        code: 6,
        provision: "harvest-wedged",
        deps: () => ({ driver, store: lockWedgingStore() }),
        // The work landed on stdout; the wedge is a diagnostic on stderr. Both,
        // together, ARE exit 6 — either alone would be 0 or 1.
        stdout: "harvested: ",
        stderr: "lock-release-failed",
      },
      {
        argv: ["harvest", "harvest-locked"],
        code: 5,
        provision: "harvest-locked",
        before: () => holdRunLock("harvest-locked"),
        // The LIVE remediation, not just the code and the message: those two are
        // byte-identical on the stale branch below.
        stderr: ["run-locked", "wait for that invocation to finish"],
      },
      {
        argv: ["harvest", "harvest-stale"],
        code: 5,
        provision: "harvest-stale",
        before: () => holdStaleRunLock("harvest-stale"),
        // 5 and not 1 is at its sharpest here: the holder is GONE, so no retry
        // can ever clear this lock. The remediation is the `rm` that can.
        stderr: ["run-locked", "no live process holds it"],
      },
    ],
    teardown: [
      { argv: ["teardown"], code: 2, stderr: "requires <run-id>" },
      { argv: ["teardown", "no-such-run"], code: 4, stderr: "no run record for no-such-run" },
      { argv: ["teardown", "INVALID_ID"], code: 2, stderr: "INVALID_ID" },
      { argv: ["teardown", "one", "two"], code: 2, stderr: "exactly one" },
      { argv: ["teardown", "some-run"], code: 2, deps: () => ({ store }), stderr: "teardown requires --driver" },
      {
        // Wave-1 C4 contract update: same as the harvest sibling above.
        argv: ["teardown", "some-run"],
        code: 5,
        deps: () => ({ driver, store: unreadableStore() }),
        stderr: "record-read-failed",
      },
      // 6, not 0: `provisionAdmittedRun` leaves the record `dispatch` leaves
      // between provisioning the box and persisting the keyHash — a box, an
      // OPEN run and no pointer to a key that may have been minted for it. The
      // box teardown succeeds and the key cannot be revoked, and `fleet
      // teardown … || alert` reading exit 0 as "nothing left running" is the
      // one thing that is not true. Same call the status branch makes twice
      // (`listUnavailable` → 1, `skippedRecords` → 2).
      {
        argv: ["teardown", "teardown-ok"],
        code: 6,
        provision: "teardown-ok",
        stdout: "torn down: ",
        stderr: "key-unattributable",
      },
      // …and the SAME id again, which is how teardown still reaches 0: the
      // record is closed now, so first-close-wins skips every step and there is
      // no unrevokable key to report. Deliberately positioned after the probe
      // above — it is that probe's run, re-torn-down. This is also the only
      // IDEMPOTENCE probe in the file: every other one uses a fresh id with a
      // live fully-provisioned box, invoked exactly once.
      { argv: ["teardown", "teardown-ok"], code: 0, stdout: "torn down: " },
      // A record whose box the provider already reaped — by far the commonest
      // real teardown, and a shape no probe here produced: the destroy step has
      // nothing to destroy, and the run must still close rather than abort on a
      // box that is legitimately gone.
      {
        argv: ["teardown", "teardown-boxless"],
        code: 6,
        provision: "teardown-boxless",
        // Awaited by the runner below — fire-and-forget here let the teardown
        // probe race the still-running destroy and see the box as present.
        before: () => driver.destroy("teardown-boxless"),
        stdout: "torn down: ",
        stderr: "key-unattributable",
      },
      // `--no-harvest` doing something, rather than merely tokenizing. The flag
      // WAIVES artifact capture, and its only other coverage in this file is the
      // grammar sweep — so deleting `const noHarvest = bools.has("--no-harvest")`
      // in scripts/fleet.ts (teardown then always harvests and never emits the
      // waiver) left the whole file green.
      {
        argv: ["teardown", "--no-harvest", "teardown-waived"],
        code: 6,
        provision: "teardown-waived",
        // The waiver AND the completion, because the waiver is printed only
        // after the teardown actually ran (printed first it claims a waiver for
        // a teardown that may never have happened).
        stdout: ["teardown.harvest_waived teardown-waived", "torn down: teardown-waived"],
        stderr: "key-unattributable",
      },
      {
        argv: ["teardown", "teardown-wedged"],
        code: 6,
        provision: "teardown-wedged",
        deps: () => ({ driver, store: lockWedgingStore() }),
        stdout: "torn down: ",
        stderr: "lock-release-failed",
      },
      {
        argv: ["teardown", "teardown-locked"],
        code: 5,
        provision: "teardown-locked",
        before: () => holdRunLock("teardown-locked"),
        // See the harvest pair: code + message cannot tell the two lock branches
        // apart, and the wrong one tells an operator to `rm` a live teardown's lock.
        stderr: ["run-locked", "wait for that invocation to finish"],
      },
      {
        argv: ["teardown", "teardown-stale"],
        code: 5,
        provision: "teardown-stale",
        before: () => holdStaleRunLock("teardown-stale"),
        stderr: ["run-locked", "no live process holds it"],
      },
    ],
    // DF3.2's pair. fanout's exit-1 here is the SUBSTRATE shape (an untyped
    // throw out of the primitive surfaces through report() as 1 with a named
    // envelope); the collected-arm-failure shape is cli.test.ts's, which owns
    // the full per-arm wiring. Exit 6 needs a stdout sink that refuses
    // mid-stream — excused below to its cli.test.ts case.
    fanout: [
      // No injected driver → the same refusal dispatch owes.
      { argv: ["fanout"], code: 2, deps: () => ({ store }), stderr: "fanout requires --driver" },
      { argv: ["fanout", "stray"], code: 2, stderr: "takes no positional arguments" },
      { argv: ["fanout", "--driver", "fake", "--n", "9"], code: 2, stderr: "--n" },
      {
        argv: ["fanout", "--driver", "fake", "--n", "2", "--cap-micro-usd", "0x10"],
        code: 2,
        stderr: "--cap-micro-usd",
      },
      // A brief that is not JSON — refused before any store is constructed.
      { argv: ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2"], code: 2, stderr: "not valid JSON" },
      // Refused BEFORE anything provisioned: one headroom check for all N,
      // zero records, zero boxes. The envelope names no-headroom.
      {
        argv: ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "3", "--roster", "a,b,c"],
        code: 5,
        deps: () => ({ ...fanDeps(), quotaLimits: lowCeiling(2) }),
        stderr: "no-headroom",
      },
      // The substrate arm of exit 1: fanoutsDir points at a regular FILE, so
      // the record store's mkdir throws EEXIST mid-fan-out and report() names
      // it. Nothing reaches stdout.
      {
        argv: ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "r0,r1"],
        code: 1,
        before: () => void writeFileSync(join(dir, "fanouts-blocked"), "not a directory"),
        deps: () => ({ ...fanDeps(), fanoutsDir: join(dir, "fanouts-blocked") }),
        stderr: "EEXIST",
      },
      // The happy path: two arms ready, one ack line each, then best-of-n's
      // auto-rank summary (unscored — this verb has no step-output source).
      {
        argv: ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "r0,r1"],
        code: 0,
        deps: () => fanDeps(),
        stdout: ['"outcome":"ready"', '"scores"'],
      },
    ],
    rank: [
      { argv: ["rank"], code: 2, stderr: "exactly one" },
      { argv: ["rank", "bogus-id"], code: 2, stderr: "not a fan-out id" },
      // Well-formed but absent: rank maps the ENOENT to its own exit 4.
      { argv: ["rank", "fan-20260101-000000"], code: 4, stderr: "no fan-out record found" },
      // A record that exists but cannot be parsed: substrate, not absence.
      {
        argv: ["rank", "fan-20260101-aaaaaa"],
        code: 1,
        before: () => {
          mkdirSync(process.env.QDS_FANOUTS_DIR!, { recursive: true });
          writeFileSync(join(process.env.QDS_FANOUTS_DIR!, "fan-20260101-aaaaaa.json"), "{ not json");
        },
        stderr: "malformed fan-out record",
      },
      // A real completed record ranks cleanly even with NO --steps-json:
      // every arm listed score:null, tie:false, rationale on stdout, exit 0.
      {
        argv: ["rank", "fan-20260101-bbbbbb"],
        code: 0,
        before: () => {
          const fstore = new FanoutRecordStore({ dir: process.env.QDS_FANOUTS_DIR });
          fstore.create({
            fanoutId: "fan-20260101-bbbbbb",
            requestId: "01234567-89ab-cdef-0123-456789abcdef",
            pattern: "best-of-n",
            n: 2,
            pin: "c".repeat(40),
            createdAt: new Date().toISOString(),
            arms: [
              { arm: 0, runId: "qds-20260101-000001", briefHash: "a".repeat(64) },
              { arm: 1, runId: "qds-20260101-000002", briefHash: "a".repeat(64) },
            ],
            winner: null,
            rankedAt: null,
            closedAt: new Date().toISOString(),
          });
        },
        stdout: ['"scores"', '"tie":false'],
      },
    ],
    // ── DF3.4's three ────────────────────────────────────────────────────────
    // Previously skipped WHOLESALE (`PROBES_OWED_ELSEWHERE`), which left the
    // registry declaring [0,1,2,4,5,6] for each with the ⊆/⊇ set check — this
    // file's own contract — asserting nothing about any of them. Behavioural
    // coverage still lives in gate-verbs.test.ts; what these add is the binding
    // between what that file exercises and what the registry advertises to
    // DF3.5's skill generator.
    approve: [
      { argv: ["approve"], code: 2, deps: gateDeps, stderr: "approve requires <run-id>" },
      // A flag the registry does not give approve — the `rank` exemption, live.
      { argv: ["approve", "gate-a1", "--approver", "alice", "--driver", "fake"], code: 2, deps: gateDeps, stderr: "does not take --driver" },
      { argv: ["approve", "gate-a-unknown", "--approver", "alice"], code: 4, deps: gateDeps, stderr: "run-not-found" },
      // Exists, but never reached the gate: 5, and NOT the 4 above — the two are
      // different facts and an operator acts on them differently.
      {
        argv: ["approve", "gate-a-absent", "--approver", "alice"],
        code: 5,
        deps: gateDeps,
        before: () => void store.create("gate-a-absent"),
        stderr: "approval-not-decidable",
      },
      // An AUTH refusal is its own exit path — 5, the refusal printed on stderr,
      // and the paused record untouched (no decision without a proven approver).
      // Every other probe here injects `ok:true`, so this is the only one that
      // observes where a bad token actually lands.
      {
        argv: ["approve", "gate-a-badtoken", "--approver", "alice"],
        code: 5,
        deps: () =>
          gateDeps(() => ({
            ok: false,
            refusal: {
              code: "approver-token-mismatch",
              message: "the token presented for alice does not match the registered hash",
              remediation: "pipe the correct token on stdin",
            },
          })),
        before: () => pauseRun("gate-a-badtoken"),
        stderr: "approver-token-mismatch",
        after: (res) => {
          expect(store.get("gate-a-badtoken").extensions?.approval?.state).toBe("awaiting-approval");
          expect(res.out).toBe("");
        },
      },
      // …and the success, which no exit-code-only probe can stand in for: a
      // decision that never reached the record still exits 0. Asserted against
      // the PERSISTED record, not the printed JSON — a CLI echoing its return
      // value satisfies any stdout pin while mutating nothing.
      {
        argv: ["approve", "gate-a-ok", "--approver", "alice"],
        code: 0,
        deps: gateDeps,
        before: () => pauseRun("gate-a-ok"),
        stdout: ['"state":"approved"', '"approverId":"alice"'],
        after: () => {
          const ext = store.get("gate-a-ok").extensions?.approval;
          expect(ext?.state).toBe("approved");
          expect(ext?.approverId).toBe("alice");
          expect(Date.parse(ext?.decidedAt as string)).not.toBeNaN();
        },
      },
    ],
    reject: [
      { argv: ["reject"], code: 2, deps: gateDeps, stderr: "reject requires <run-id>" },
      { argv: ["reject", "gate-r-unknown", "--approver", "alice"], code: 4, deps: gateDeps, stderr: "run-not-found" },
      {
        argv: ["reject", "gate-r-absent", "--approver", "alice"],
        code: 5,
        deps: gateDeps,
        before: () => void store.create("gate-r-absent"),
        stderr: "approval-not-decidable",
      },
      // The mirror of approve's badtoken probe — the refusal mapping is per-verb
      // code in scripts/fleet.ts, so each verb owes its own.
      {
        argv: ["reject", "gate-r-badtoken", "--approver", "alice"],
        code: 5,
        deps: () =>
          gateDeps(() => ({
            ok: false,
            refusal: {
              code: "approver-token-mismatch",
              message: "the token presented for alice does not match the registered hash",
              remediation: "pipe the correct token on stdin",
            },
          })),
        before: () => pauseRun("gate-r-badtoken"),
        stderr: "approver-token-mismatch",
        after: (res) => {
          expect(store.get("gate-r-badtoken").extensions?.approval?.state).toBe("awaiting-approval");
          expect(res.out).toBe("");
        },
      },
      {
        argv: ["reject", "gate-r-ok", "--approver", "alice"],
        code: 0,
        deps: gateDeps,
        before: () => pauseRun("gate-r-ok"),
        stdout: ['"state":"rejected"', '"approverId":"alice"'],
        after: () => {
          const ext = store.get("gate-r-ok").extensions?.approval;
          expect(ext?.state).toBe("rejected");
          expect(ext?.approverId).toBe("alice");
          expect(Date.parse(ext?.decidedAt as string)).not.toBeNaN();
        },
      },
    ],
    attach: [
      { argv: ["attach"], code: 2, deps: () => ({ store }), stderr: "attach requires <run-id>" },
      // --driver is required:true and nothing is injected to stand in for it.
      { argv: ["attach", "gate-t1", "--message", "go"], code: 2, deps: () => ({ store }), stderr: "attach requires --driver" },
      { argv: ["attach", "gate-t-unknown", "--message", "go"], code: 4, stderr: "run-not-found" },
      {
        argv: ["attach", "gate-t-nobox", "--message", "go"],
        code: 5,
        before: () => void store.create("gate-t-nobox"),
        stderr: ["run-not-attachable", "no box recorded"],
      },
    ],
    // D9's enrolment. The WRITER is injected here and only here: the real one
    // resolves its allowlist from `process.cwd()`, so an in-process probe would
    // write `.factory/approvers.json` into this repo. The real writer is proved
    // against a real filesystem in approvers.test.ts and end to end through a
    // real subprocess in a real tmpdir in gate-verbs.test.ts.
    enrol: [
      { argv: ["enrol"], code: 2, deps: () => ({ store }), stderr: "enrol requires --approver <id>" },
      // An empty flag VALUE is a wrong invocation (exit 2 naming the flag), not
      // an allowlist refusal — the same line approve/reject draw.
      { argv: ["enrol", "--approver", "  "], code: 2, deps: () => ({ store }), stderr: "enrol requires --approver <id>" },
      { argv: ["enrol", "--approver", "alice", "--driver", "fake"], code: 2, deps: () => ({ store }), stderr: "does not take --driver" },
      {
        argv: ["enrol", "--approver", "alice"],
        code: 0,
        deps: () => ({
          store,
          enrol: () => ({ ok: true as const, approverId: "alice", token: "MINTED-TOKEN", path: "/tmp/x/.factory/approvers.json", replaced: false }),
        }),
        // The token IS the output: an enrolment whose token never reaches the
        // operator has minted a credential nobody holds. (No `"kdf"` pin: the
        // primitive is the writer's business, not the registry↔CLI binding's,
        // and a crypto upgrade would have redded a routing probe.)
        stdout: ['"approverId":"alice"', '"token":"MINTED-TOKEN"'],
      },
      {
        argv: ["enrol", "--approver", "alice"],
        code: 5,
        deps: () => ({
          store,
          enrol: () => ({
            ok: false as const,
            refusal: {
              code: "approver-already-enrolled",
              message: "alice is already enrolled",
              remediation: "pass --rotate to mint a NEW token",
            },
          }),
        }),
        stderr: ["approver-already-enrolled", "--rotate"],
      },
    ],
    // D11's operator remedy. The lock files are written directly rather than by
    // parking a real holder: what these probe is the CLI's classification and
    // exit mapping, and the genuinely-concurrent arms — where a live process is
    // really inside `body()` — are approval-gate.test.ts's two-subprocess tests,
    // which is the only place they can honestly live.
    unlock: [
      { argv: ["unlock"], code: 2, deps: () => ({ store }), stderr: "unlock requires <run-id>" },
      // The `rank`/`approve` exemption, live: unlock declares no --driver.
      { argv: ["unlock", "gate-u1", "--driver", "fake"], code: 2, deps: () => ({ store }), stderr: "does not take --driver" },
      // BEFORE the lock is inspected — a missing record must never be answered
      // by removing a lock file. But the refusal is now the GENERIC one (5,
      // `unlock-refused`), not `run-not-found` (4): a caller who could separate
      // "no such run" from "the holder is alive" by exit code could enumerate
      // run ids without ever touching a lock. The true reason rides the gate
      // event, which gate-verbs.test.ts owns.
      {
        argv: ["unlock", "gate-u-unknown"],
        code: 5,
        deps: () => ({ store }),
        stderr: "unlock-refused",
        // The generic envelope must not smuggle the old classification back in
        // under a different key: "no such run" names the reason nowhere.
        after: (res) => expect(res.err).not.toContain("run-not-found"),
      },
      // No lock at all: the HEALTHY answer, and therefore exit 0.
      {
        argv: ["unlock", "gate-u-clean"],
        code: 0,
        deps: () => ({ store }),
        before: () => void store.create("gate-u-clean"),
        stdout: ['"outcome":"absent"'],
      },
      // A provably-dead holder needs no override — the acquire loop would have
      // reclaimed this itself. 2147483647 is above every configured pid_max.
      {
        argv: ["unlock", "gate-u-dead"],
        code: 0,
        deps: () => ({ store }),
        before: () => {
          store.create("gate-u-dead");
          writeFileSync(join(store.dir, "gate-u-dead.approval.lock"), "2147483647:dead-holder");
        },
        stdout: ['"outcome":"reclaimed"', '"holder":"dead"', '"forced":false'],
      },
      // A LIVE holder (this very process) is refused — and the refusal is the
      // SAME generic envelope the missing-record probe above gets: no pid, no
      // age, no "still running", no `approval-lock-holder-not-dead` code. Those
      // were the evidence the force decision needed, and they are still emitted
      // — in the gate event (F5.35), which gate-verbs.test.ts pins. What the
      // envelope must NOT be is a per-reason fingerprint an id-enumerating
      // caller can diff; `--force` is named as the remedy, which is the one
      // thing every refusal of this verb has in common.
      {
        argv: ["unlock", "gate-u-live"],
        code: 5,
        deps: () => ({ store }),
        before: () => {
          store.create("gate-u-live");
          writeFileSync(join(store.dir, "gate-u-live.approval.lock"), `${process.pid}:still-working`);
        },
        stderr: ["unlock-refused", "--force"],
        // No pid, no age, no holder status on either stream: the evidence the
        // force decision needs is the gate event's, not the envelope's.
        after: (res) => {
          for (const stream of [res.out, res.err]) {
            expect(stream).not.toContain(`${process.pid}`);
            expect(stream).not.toContain("lock_age_ms");
            expect(stream).not.toContain("holderPid");
            expect(stream).not.toContain("alive");
          }
        },
      },
      // …and the override works, is reported as forced, and says so on stdout so
      // the audit trail records that a human asserted what the host could not
      // prove.
      {
        argv: ["unlock", "gate-u-forced", "--force"],
        code: 0,
        deps: () => ({ store }),
        before: () => {
          store.create("gate-u-forced");
          writeFileSync(join(store.dir, "gate-u-forced.approval.lock"), `${process.pid}:still-working`);
        },
        stdout: ['"outcome":"reclaimed"', '"holder":"alive"', '"forced":true'],
      },
    ],
    // DF1.10. Every arm but 6 is reachable here; 6 needs a stdout sink that
    // throws AFTER the engine started, which `invoke()`'s array sinks cannot do
    // — excused below, bound to run.test.ts.
    run: [
      // Default deps INJECT a driver, so this reaches the positional check
      // rather than the --driver one: the two refusals are distinguished by
      // which argv they need, not by which happens to fire first.
      { argv: ["run"], code: 2, stderr: "run requires <run-id>" },
      { argv: ["run", "NOT_AN_ID"], code: 2, stderr: "invalid-run-id" },
      // With the id PRESENT and no driver injected, the driver requirement is
      // what refuses — the sweep at the bottom of this file asserts the same
      // message for every --driver-declaring verb, and this pins it inside the
      // exit-code contract too.
      { argv: ["run", "probe-run-start"], code: 2, deps: () => ({ store }), stderr: "run requires --driver" },
      // Absence, before any box is touched.
      { argv: ["run", "qds-19990101-000000"], code: 4, deps: () => startDriver(0), stderr: "run-not-found" },
      // The success: one confirmation line naming the run, and no waiting.
      {
        provision: "probe-run-start",
        argv: ["run", "probe-run-start"],
        code: 0,
        deps: () => startDriver(0, "", corroborated),
        // The whole substrate sequence, asserted where `unitActivity`'s catch
        // cannot swallow it: THREE calls, not two — the pre-start `is-active`
        // guard (a `failed` unit re-runs ExecStart, so it is refused BEFORE
        // any job runs), then the `sudo -n` start, then the post-start
        // corroboration on the SAME unit. A wrong-unit call, a dropped guard
        // or corroboration, or a reordered sequence fails here even though
        // the verb still exits 0.
        after: () => {
          expect(corroborated).toEqual([
            ["systemctl", "is-active", "qds-run@probe-run-start.service"],
            ["sudo", "-n", "systemctl", "start", "qds-run@probe-run-start.service"],
            ["systemctl", "is-active", "qds-run@probe-run-start.service"],
          ]);
        },
        stdout: "started: probe-run-start",
      },
      // systemd ran the job and it FAILED (AssertPathExists, no such unit). 5,
      // not 1: the identical retry produces the identical failure.
      //
      // Its OWN record, like every arm below. These three used to share the
      // exit-0 probe's `probe-run-start`, an inter-test dependency nothing
      // enforced: reordering the table, or giving the success probe a different
      // id, turned every one of them into a `run-not-found` 4 that the
      // exit-code sweep would have reported as a registry mismatch somewhere
      // else entirely.
      {
        argv: ["run", "probe-run-refused"],
        code: 5,
        provision: "probe-run-refused",
        deps: () => startDriver(1, "Unit qds-run@probe-run-refused.service not found."),
        stderr: "engine-start-refused",
        stdoutEmpty: true,
      },
      // ssh never connected (255 — the transport's own status, not systemctl's).
      // 1, and the ONLY 1 this verb produces: retrying is safe by AC6's unit
      // identity, so this is the one arm where `transient` is honest.
      {
        argv: ["run", "probe-run-unreachable"],
        code: 1,
        provision: "probe-run-unreachable",
        deps: () => startDriver(255),
        stderr: "engine-start-unreachable",
        stdoutEmpty: true,
      },
      // Exit 5's OTHER refusal arm, and it is a different code entirely:
      // `run-not-startable` fires BEFORE any exec, so nothing on the box is
      // touched. Without a case for it the ⊇ check below was satisfied by the
      // systemd arm alone — mapping this one to 1 (`transient`, told about a
      // run whose box does not exist) would have passed.
      //
      // `state:"no-box"`: a record that was created and never provisioned, the
      // shape a crash between mint and create leaves.
      {
        argv: ["run", "probe-run-no-box"],
        code: 5,
        before: () => void store.create("probe-run-no-box"),
        deps: () => startDriver(0),
        stderr: ["run-not-startable", "no box recorded"],
        stdoutEmpty: true,
      },
      // …and DF1.10's NEW state on the same refusal: the setup gate FAILED, so
      // per INV-5 the record is OPEN and the box is ALIVE with `vmName` set —
      // it passes every other guard. An engine started here walks phases (git
      // commits, LLM spend) on a box that failed assertion A/B/C.
      {
        argv: ["run", "probe-run-gate-failed"],
        code: 5,
        provision: "probe-run-gate-failed",
        before: () =>
          void store.set("probe-run-gate-failed", {
            extensions: { gate: { outcome: "failed" } },
          } as RunRecordPatch),
        deps: () => startDriver(0),
        stderr: ["run-not-startable", "gate-failed"],
        stdoutEmpty: true,
      },
    ],
  };

  /**
   * Codes a verb declares that NO probe in this file reaches, with the reason.
   * The ⊇ direction is scoped around exactly these and nothing else: a precise
   * partial check beats a total one that a verb declaring [0,1,2,3,4,5] passes.
   */
  const ONLY_REACHABLE_ELSEWHERE: Record<
    string,
    /**
     * `file` names the sibling suite that owes the code, defaulting to
     * cli.test.ts — where every DF3.1/3.2 excuse already pointed. DF3.4's gate
     * verbs are exercised in gate-verbs.test.ts instead, and an excuse checked
     * against the wrong file is an excuse checked against nothing.
     */
    { code: number; why: string; coveredBy: string; file?: string }[]
  > = {
    dispatch: [
      // Every one of these needs the full dispatch wiring — keyApi, ledgerFactory,
      // setupGate, a valid brief — which is tests/fleet/cli.test.ts's subject, not
      // this file's. `coveredBy` names the test that owes the code; the check below
      // asserts each title still exists there, so the excuse cannot outlive its test.
      {
        code: 0,
        why: "needs a keyApi + ledgerFactory + valid brief — cli.test.ts",
        coveredBy: "e2e: dispatch → status → teardown against the fake driver",
      },
      {
        code: 1,
        why: "needs a provider failure mid-dispatch — cli.test.ts",
        coveredBy: "a throw that is not an Error still reports exit 1 with a message",
      },
      {
        code: 3,
        why: "needs a failing setup gate — cli.test.ts",
        coveredBy: "setup-gate failure → exit 3 with the assertion code, box ALIVE and record OPEN (INV-5)",
      },
      {
        code: 5,
        why: "needs a budget refusal before provisioning — cli.test.ts",
        coveredBy: "an over-budget issue → exit 5 refused BEFORE provisioning (AC7)",
      },
      {
        code: 6,
        why: "needs a SUCCESSFUL dispatch and a stdout sink that throws — cli.test.ts",
        coveredBy: "dispatch whose ack cannot be written exits 6 with the box LIVE and the run id named",
      },
    ],
    status: [],
    // Wave-1 C4 contract update: the corrupt-record probes above now return 5
    // (do-not-retry — no retry heals a corrupt record file), not 1 transient.
    // 1 = a mid-capture HarvestError typed code (bundle-create-failed &c., a
    // provider-side substrate fault past the record probe) — it needs a full
    // in-box bundle protocol (git runner + seeded box + host checkout), which
    // cli.test.ts owns through its seeded-run fixtures, not this shared store.
    harvest: [
      {
        code: 1,
        why: "needs a mid-capture failure past the record probe — cli.test.ts",
        coveredBy: "a throw that is not an Error still reports exit 1 with a message",
      },
    ],
    teardown: [
      {
        code: 1,
        why: "needs a mid-capture failure past the record probe — cli.test.ts (same harvest-step shape as harvest's excuse)",
        coveredBy: "a throw that is not an Error still reports exit 1 with a message",
      },
    ],
    // fanout's probes above cover {0, 1, 2, 5}; 6 needs a stdout sink that
    // refuses with EAGAIN mid-stream (the outputIncomplete fold), which the
    // shared invoke() sinks here cannot do — cli.test.ts owns a sink that can.
    fanout: [
      {
        code: 6,
        why: "needs SUCCESSFUL arms and a stdout sink that throws EAGAIN — cli.test.ts",
        coveredBy: "a fanout whose completion lines cannot print exits 6 with the work landed",
      },
    ],
    // [0, 1, 2, 4] are all probed above; 6 needs the same refusing sink fanout's
    // excuse needs — cli.test.ts owns it.
    rank: [
      {
        code: 6,
        why: "needs a successful ranking and a stdout sink that throws EAGAIN — cli.test.ts",
        coveredBy: "a rank with no --steps-json whose result line cannot print exits 6 with rankedAt stamped",
      },
    ],
    // DF3.4. The probes above reach {0, 2, 4, 5} for approve/reject and
    // {2, 4, 5} for attach. What is left needs a fault the shared `invoke()`
    // cannot inject — a store whose SECOND read throws, and a stdout sink that
    // refuses — and gate-verbs.test.ts owns both, so the excuses name it.
    approve: [
      {
        code: 1,
        why: "needs a store whose second read throws an untyped Error — gate-verbs.test.ts",
        coveredBy: "%s: an untyped throw past the existence check is exit 1, not a crash",
        file: "gate-verbs.test.ts",
      },
      {
        code: 6,
        why: "needs a recorded decision and a stdout sink that throws — gate-verbs.test.ts",
        coveredBy: "%s: the decision LANDED and its line could not print — exit 6, never a retryable 1",
        file: "gate-verbs.test.ts",
      },
    ],
    // The SAME two cases: both are `test.each([["approve"], ["reject"]])`, so one
    // source title owes the code for both verbs.
    reject: [
      {
        code: 1,
        why: "needs a store whose second read throws an untyped Error — gate-verbs.test.ts",
        coveredBy: "%s: an untyped throw past the existence check is exit 1, not a crash",
        file: "gate-verbs.test.ts",
      },
      {
        code: 6,
        why: "needs a recorded decision and a stdout sink that throws — gate-verbs.test.ts",
        coveredBy: "%s: the decision LANDED and its line could not print — exit 6, never a retryable 1",
        file: "gate-verbs.test.ts",
      },
    ],
    attach: [
      {
        code: 0,
        why: "needs a driver double that answers the ack read — gate-verbs.test.ts",
        coveredBy: "attach-acked is exit 0 and PRINTS the completion line (the success path)",
        file: "gate-verbs.test.ts",
      },
      {
        code: 1,
        why: "needs a store whose second read throws an untyped Error — gate-verbs.test.ts",
        coveredBy: "an untyped throw past the existence check is exit 1",
        file: "gate-verbs.test.ts",
      },
      {
        code: 6,
        why: "needs an ACKED attach and a stdout sink that throws — gate-verbs.test.ts",
        coveredBy: "an acked attach whose completion line cannot print is exit 6, not 0",
        file: "gate-verbs.test.ts",
      },
    ],
    // D9. The probe table above reaches 0/2/5; these two need a fault it cannot
    // inject, and BOTH are asserted against the REAL writer rather than the
    // injected one.
    enrol: [
      {
        code: 1,
        why: "needs the writer to throw something untyped — gate-verbs.test.ts",
        coveredBy: "enrol: an untyped throw from the writer is exit 1, not a crash",
        file: "gate-verbs.test.ts",
      },
      {
        code: 6,
        why: "needs a successful enrolment and a stdout sink that throws — gate-verbs.test.ts",
        coveredBy: "enrol: the entry LANDED and the minted token could not print — exit 6",
        file: "gate-verbs.test.ts",
      },
    ],
    // D11. The probe table above reaches 0/2/5; these two need a fault the
    // probe harness cannot inject, exactly as approve/reject/attach's do.
    unlock: [
      {
        code: 1,
        why: "needs a lock-read fault past the guarded record read — gate-verbs.test.ts",
        coveredBy: "unlock: an untyped throw past the record read is exit 1, not a crash",
        file: "gate-verbs.test.ts",
      },
      {
        code: 6,
        why: "needs a reclaimed lock and a stdout sink that throws — gate-verbs.test.ts",
        coveredBy: "unlock: the lock WAS removed and its line could not print — exit 6, never a retryable 1",
        file: "gate-verbs.test.ts",
      },
    ],
    // DF1.10. The probe table above reaches 0/1/2/4/5. 6 is the landed-but-
    // unreportable arm: it needs a STARTED engine and a stdout sink that throws
    // EAGAIN, and `invoke()`'s array sinks cannot refuse a write.
    run: [
      {
        code: 6,
        why: "needs a STARTED engine and a stdout sink that throws EAGAIN — run.test.ts",
        coveredBy: "exit 6: the engine STARTED and the result line could not be written — landed, not retryable",
        file: "run.test.ts",
      },
    ],
  };

  /**
   * The allowlist above excuses 4 of dispatch's 5 declared codes, which reduces
   * the ⊇ direction to `{2}` for that verb — honest only while the tests it
   * defers to exist. Nothing BOUND the excuse to them: deleting a cli.test.ts
   * case left this file green with `dispatch` advertising an unreachable code to
   * DF3.5's generated skill.
   *
   * The binding this file can make from the outside is the sibling suite's
   * SOURCE: find the named case and require its BODY to assert the code being
   * excused. Not a run of that test (bun owns that) — but a deletion, a rename,
   * or a case that keeps its title while quietly dropping the assertion now
   * turns this red. Title-existence alone did not: `cli.includes('test("…"')`
   * was satisfied by a test that had stopped asserting anything about the code
   * it is here to owe, so both files could be green with `dispatch` advertising
   * an unreachable exit to DF3.5's generated skill.
   */
  test("every excused exit code names a sibling-suite case that still ASSERTS it", () => {
    const sources = new Map<string, string>();
    const sourceOf = (file: string): string => {
      const cached = sources.get(file);
      if (cached !== undefined) return cached;
      const text = readFileSync(join(import.meta.dir, file), "utf8");
      sources.set(file, text);
      return text;
    };
    const missing: string[] = [];
    for (const [verb, excuses] of Object.entries(ONLY_REACHABLE_ELSEWHERE)) {
      for (const { code, coveredBy, file = "cli.test.ts" } of excuses) {
        const source = sourceOf(file);
        // The title as `test(...)` writes it, not a loose substring: a comment
        // mentioning the name must not stand in for the case itself. All three
        // delimiters a title could legally use — a title containing `"` cannot
        // be double-quoted, so pinning one spelling would strand the excuse.
        //
        // `)(` is the `test.each([...])("title", …)` form, where the title is
        // the FIRST argument of the second call rather than of `test` itself.
        // Without it a parameterised case could never own an excuse, and both
        // gate verbs' exit-1/exit-6 coverage is written that way (one source
        // title owing the code for approve AND reject).
        let at = -1;
        let headLen = 0;
        for (const q of ['"', "`", "'"]) {
          const quoted = `${q}${coveredBy}${q}`;
          for (let i = source.indexOf(quoted); i >= 0; i = source.indexOf(quoted, i + 1)) {
            // Whitespace-tolerant: biome wraps a long `test.each(...)( "title",`
            // onto its own line, so the opener and the title are not adjacent.
            const before = source.slice(0, i).replace(/\s+$/, "");
            if (!before.endsWith("test(") && !before.endsWith("it(") && !before.endsWith(")(")) continue;
            if (at < 0 || i < at) {
              at = i;
              headLen = quoted.length;
            }
            break;
          }
        }
        if (at < 0) {
          missing.push(`${verb} exit ${code}: no test named ${JSON.stringify(coveredBy)} in ${file}`);
          continue;
        }
        // The body, bounded by the next top-level `test`/`it` in that file
        // (they are all indented two spaces inside one describe) — or, when the
        // excused case is the FILE'S LAST, by the end of the file. Scanning past
        // a real boundary would let ANY case's `toBe(0)` excuse every other one,
        // so only the genuine no-next-test case falls through to EOF.
        //
        // `[.(]`, not `\(`: `test.each(` opens a case too, and a boundary that
        // did not recognise it let a body run past the following case into the
        // one after that.
        const rest = source.slice(at + headLen);
        const end = rest.search(/\n {2}(?:test|it)[.(]/);
        const body = end < 0 ? rest : rest.slice(0, end);
        // T1-2 (round 11): an actual EXIT-CODE assertion shape, not any
        // `toBe(<code>)` token — `expect(capMicroUsd).toBe(5)` in a sibling
        // line satisfied the old regex while the exit stayed unasserted.
        // `(code|exitCode))?.toBe(N)` covers `expect(code).toBe(6)` and the
        // optional-chained variants; `\bcode: N\b` covers the object-literal
        // form the probe loops use. Verified empirically per excused code: each
        // still has ≥1 satisfier (dispatch 0's three satisfies come from its
        // dispatchCode/statusCode/teardownCode assertions).
        if (!new RegExp(`\\b(?:exitCode|[A-Za-z]*[Cc]ode)\\s*\\)?\\.toBe\\(\\s*${code}\\s*\\)`).test(body)) {
          missing.push(`${verb} exit ${code}: ${JSON.stringify(coveredBy)} no longer asserts exit ${code}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // …and every excuse names one: an entry with an empty `coveredBy` would pass
    // a substring check against any file.
    for (const excuses of Object.values(ONLY_REACHABLE_ELSEWHERE)) {
      for (const e of excuses) expect(e.coveredBy.length).toBeGreaterThan(0);
    }
  });

  test("the declared exitCodes and the codes the CLI really returns are the SAME set", async () => {
    // The ~40 probes below share ONE store and ONE driver, in this order. That
    // is deliberate (they build on each other: teardown's exit-0 probe re-tears
    // down the run its exit-6 sibling closed), but it means what each probe sees
    // depends on the registry's iteration order — and the empty-fleet probe was
    // over an empty fleet only because dispatch's probes happen to precede it.
    // Pin the RELATIVE order of the known verbs — as a SUBSEQUENCE, not an
    // exact list, so an additive verb may slot in anywhere without editing this
    // file while a reshuffle of known ones still fails HERE rather than
    // silently changing what half the table asserts about. DF3.2's pair is part
    // of that pinned subsequence: fanout and rank come after the DF3.1 four.
    expect(
      inOrder(["dispatch", "status", "harvest", "teardown", "fanout", "rank"], listVerbs().map((v) => v.verb)),
    ).toBe(true);
    // EVERY verb now has probes. DF3.4's three were skipped wholesale here on
    // the grounds that gate-verbs.test.ts owns their behaviour — true, and beside
    // the point: the ⊆/⊇ set equality below is this file's contract and no other
    // suite asserts it, so for three verbs advertising [0,1,2,4,5,6] to DF3.5's
    // skill generator, nothing checked that any of those six was reachable or
    // that the CLI returned nothing else. The residue that genuinely needs a
    // fault `invoke()` cannot inject now rides in `ONLY_REACHABLE_ELSEWHERE`,
    // which BINDS each excuse to a named case in the suite that owes it.
    //
    // Compared as a SET, not an array: the array form encoded the registry's
    // DECLARATION ORDER, so alphabetising `listVerbs()` reddened a test about
    // probe COVERAGE with a failure about ordering. The subsequence check above
    // is where order is asserted, deliberately and only for the verbs whose
    // relative order the probe table depends on.
    expect(new Set(listVerbs().filter((v) => PROBES[v.verb] === undefined).map((v) => v.verb))).toEqual(new Set());
    for (const entry of listVerbs()) {
      const probes = PROBES[entry.verb]!;
      const observed: number[] = [];
      for (const probe of probes) {
        if (probe.provision !== undefined) {
          await provisionAdmittedRun(driver, store, { runId: probe.provision });
        }
        await probe.before?.();
        const deps = probe.deps?.() ?? { driver, store, readBrief: async () => "{not json" };
        const res = await invoke(probe.argv, deps);
        observed.push(res.code);
        await probe.after?.(res);
        for (const want of [probe.stderr ?? []].flat()) {
          // Named on stderr, and NOT on stdout: a caller parsing `fleet status`
          // output must never have to skip an error envelope in it.
          expect({ argv: probe.argv, want, err: res.err }).toMatchObject({ err: expect.stringContaining(want) });
          expect(res.out).not.toContain(want);
        }
        for (const want of [probe.stdout ?? []].flat()) {
          expect({ argv: probe.argv, want, out: res.out }).toMatchObject({ out: expect.stringContaining(want) });
        }
        if (probe.stdoutEmpty === true) {
          expect({ argv: probe.argv, out: res.out }).toEqual({ argv: probe.argv, out: "" });
        }
        // Every non-zero exit says something. Silence is the failure mode an
        // exit-code-only assertion cannot see.
        if (res.code !== 0) expect(res.err.length).toBeGreaterThan(0);
      }
      expect(observed).toEqual(probes.map((p) => p.code));

      const declared = new Set(entry.exitCodes);
      const seen = new Set(observed);
      // ⊆ : nothing the CLI returns may be missing from the registry.
      expect(
        probes
          .filter((p) => !declared.has(p.code))
          .map((p) => `${p.argv.join(" ")} → exit ${p.code}, not in [${entry.exitCodes.join(",")}]`),
      ).toEqual([]);
      // ⊇ : nothing the registry advertises may be unreachable, bar the allowlist.
      const excused = new Set(ONLY_REACHABLE_ELSEWHERE[entry.verb]!.map((e) => e.code));
      expect([...declared].filter((c) => !seen.has(c) && !excused.has(c))).toEqual([]);
      // …and the allowlist itself stays honest: an excused code that a probe
      // now reaches must be struck from it, not left as a standing exemption.
      expect([...excused].filter((c) => seen.has(c))).toEqual([]);
    }
    // ~40 probes, each provisioning a run and several spawning lock-holder
    // processes: the cost is fixture-bound and routinely passes bun's 5s default,
    // and a mid-test kill leaves the dangling holder to poison the next test.
  }, 60_000);

  test("F5 (2026-08-24): close-step box-hour failure AFTER destroy+revoke releases the run lock — exit 6, nothing wedged", async () => {
    // Live shape (e2e-run-report F5): attributed run + no cost-config.json
    // beside the records dir. The teardown destroys the box, revokes nothing
    // (keyless), CLOSES the record — and the close step's ingest refuses the
    // unpriced row (box-hour-rate-unconfigured, fail-loud by design). The old
    // finally then held the run lock over a run with nothing billable left:
    // the operator had to rm the lock by hand for an already-dead run.
    const runId = "teardown-f5-unpriced";
    await provisionAdmittedRun(driver, store, { runId });
    store.set(runId, {
      extensions: {
        budget: {
          repoSlug: "owner/repo",
          issueId: "5",
          capMicroUsd: 1_000_000,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
          admittedCeilingMicroUsd: 1_000_000,
        },
      },
    });

    const res = await invoke(["teardown", runId], { driver, store });
    // The unpriced row still surfaces loudly — 6, "done, needs an operator".
    expect(res.code).toBe(6);
    expect(res.err).toContain("box-hour-rate-unconfigured");
    // THE pin: no lock-held note — the record is closed, so destroy+revoke
    // landed and the lock guards nothing billable. The landed fact rides the
    // lock-released note on stderr ("torn down:" is only printed on the
    // no-throw path, which this is not by construction).
    expect(res.err).not.toContain("lock-held");
    expect(res.err).toContain("lock-released-work-landed");

    // And the lock is REALLY gone, not just unreported: the next teardown is
    // the idempotent closed-record path (still fail-loud on the unpriced row —
    // that is the design until cost-config.json exists), never run-locked.
    const again = await invoke(["teardown", runId], { driver, store });
    expect(again.code).not.toBe(5);
    expect(again.err).not.toContain("run-locked");
    expect(again.err).not.toContain("lock-held");
  }, 60_000);

  test("F5 arm 2: a throw BEFORE close (record still open) still holds the lock", async () => {
    // The lock's real job: guarding a HALF-torn-down run. A destroy failure
    // leaves the record open and the box possibly alive — the lock must stay.
    const runId = "teardown-f5-halfdead";
    await provisionAdmittedRun(driver, store, { runId });
    const exploding = Object.create(driver) as FakeDriver;
    exploding.destroy = () => Promise.reject(new Error("rm exploded"));

    const res = await invoke(["teardown", runId], { driver: exploding, store });
    expect(res.code).toBe(6);
    expect(res.err).toContain("lock-held");
    // The lock is PHYSICALLY still there and refuses the next invocation. The
    // second invoke runs in THIS process, so the acquire refuses as
    // re-entrant (1) rather than run-locked (5) — either way, the refusal
    // proves the lock survived a failed teardown.
    expect(existsSync(join(store.dir, `${runId}.lock`))).toBe(true);
    const again = await invoke(["teardown", runId], { driver: exploding, store });
    expect(again.code).toBe(1);
    expect(again.err).toContain("run-lock-reentrant");
    // Release for the shared fixtures — this run's lock is deliberately
    // wedged (destructive mark still set), so plain releaseRunLock refuses;
    // rm the file directly, exactly what the remediation tells the operator.
    rmSync(join(store.dir, `${runId}.lock`), { force: true });
  }, 60_000);

  test("exit 6's OTHER documented route: the verb succeeded and the LEDGER would not close", async () => {
    // teardown/harvest declare 6 for two failures — "the cost ledger would not
    // close, or the run lock would not release" — and every probe above reaches
    // it through `lockWedgingStore`. So the ledger arm of the `finally` was
    // declared, documented and never run: deleting its `cleanupFailed()` left a
    // teardown whose spend may never have been durably committed reporting a
    // clean exit 0, which is the same lie the lock arm exits 6 to avoid.
    //
    // Through the CLI's OWN ledger, because teardown does not take
    // `deps.ledgerFactory` — it constructs a `CostLedger` beside the records
    // itself. The prototype is patched for exactly this call and restored in a
    // `finally`; the real `close()` still runs first, so nothing is leaked.
    const runId = "ledger-wedged";
    await provisionAdmittedRun(driver, store, { runId });
    // CLOSED first, so `keyUnattributable` cannot be what produces the 6: with a
    // closed record teardownSandbox short-circuits (first-close-wins) and the
    // verb's own code is 0, which makes the cleanup the sole cause.
    store.close(runId);

    const realClose = CostLedger.prototype.close;
    CostLedger.prototype.close = function wedged(this: CostLedger): void {
      realClose.call(this);
      throw new Error("ledger handle wedged");
    };
    let res: { code: number; out: string; err: string };
    try {
      res = await invoke(["teardown", runId], { driver, store });
    } finally {
      CostLedger.prototype.close = realClose;
    }

    expect(res.code).toBe(6);
    // The work landed and says so on stdout; the wedge is the diagnostic. Either
    // one alone would be exit 0.
    expect(res.out).toContain(`torn down: ${runId}`);
    expect(res.err).toContain("ledger-close-failed");
    // NOT the lock arm: this is the route the probes above could not reach, and
    // a `finally` that reported the wrong one would still be exit 6.
    expect(res.err).not.toContain("lock-release-failed");
    // …and the run stays operable — a ledger that will not close is not a reason
    // to strand the lock.
    expect(existsSync(join(store.dir, `${runId}.lock`))).toBe(false);
    expect(listVerbs().find((v) => v.verb === "teardown")?.exitCodes).toContain(6);
  });

  test("a NON-ERROR ledger close failure (throw null) still reports ledger-close-failed at exit 6 (CodeRabbit round 8)", async () => {
    // SQLite-adjacent code may reject with null/undefined. The reporting catch
    // must survive it: `(e as Error).message` on null throws a TypeError from
    // INSIDE the finally's catch, escaping the cleanup policy entirely and
    // hiding the original failure under a crash. Same route as the sibling
    // above, minus the Error.
    const runId = "ledger-wedged-null";
    await provisionAdmittedRun(driver, store, { runId });
    store.close(runId);
    const realClose = CostLedger.prototype.close;
    CostLedger.prototype.close = function wedgedNull(this: CostLedger): void {
      realClose.call(this);
      throw null;
    };
    let res: { code: number; out: string; err: string };
    try {
      res = await invoke(["teardown", runId], { driver, store });
    } finally {
      CostLedger.prototype.close = realClose;
    }
    expect(res.code).toBe(6);
    expect(res.out).toContain(`torn down: ${runId}`);
    expect(res.err).toContain("ledger-close-failed");
    expect(res.err).not.toContain("lock-release-failed");
    expect(existsSync(join(store.dir, `${runId}.lock`))).toBe(false);
  });
});

/**
 * The registry's `required` and `valueType` columns, observed through the CLI
 * rather than read back out of the same table they are asserted against
 * (`EXPECTED_FLAGS` cannot fail when the parser disagrees with the registry).
 */
describe("verbs.ts ↔ scripts/fleet.ts flag grammar", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;
  const sink = (): void => {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-verb-flags-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("--driver is required:true on EVERY verb that takes one — omitting it is refused as usage", async () => {
    // No injected driver, so nothing stands in for the flag. Declaring it
    // optional is how DF3.5 would generate a skill whose every call exits 2.
    //
    // Driven from the REGISTRY's own flag metadata, not from a verb list: the
    // sweep covers every verb that DECLARES --driver, whatever the registry
    // grows to, and skips those that don't (rank reads fan-out records and step
    // output — no box to choose a driver FOR — so it has no --driver to make
    // required; its negative is pinned right below).
    for (const entry of listVerbs()) {
      const declared = entry.flags.find((f) => f.name === "--driver");
      if (declared === undefined) continue;
      expect(declared.required).toBe(true);
      const argv =
        entry.verb === "dispatch" || entry.verb === "status" || entry.verb === "fanout"
          ? [entry.verb]
          : [entry.verb, "some-run"];
      const err: string[] = [];
      expect(await run(argv, sink, { store }, (s) => void err.push(s))).toBe(2);
      expect(err.join("")).toContain(`${entry.verb} requires --driver <name>`);
    }
    // …and the one deliberate exemption stays an EXEMPTION: a verb that stops
    // taking --driver must argue it here, not slip out of the sweep silently.
    expect(
      listVerbs()
        .filter((v) => !v.flags.some((f) => f.name === "--driver"))
        .map((v) => v.verb),
      // DF3.2's rank, plus DF3.4's approve/reject, D9's enrol and D11's unlock:
      // all four touch records or host-local config only — approve/reject
      // mutate one record's extensions.approval and provision nothing, enrol
      // writes `.factory/approvers.json` beside them, and unlock removes one
      // lock file — so assertDriverChosen's hazard (a teardown "destroying" a
      // fake box while the real one bills) cannot arise: no verb here ever
      // destroys, reads or bills a box. A SIXTH must argue it here.
    ).toEqual(["rank", "approve", "reject", "enrol", "unlock"]);
    // The seam the requirement lives behind: an INJECTED deps.driver stands in
    // for the flag entirely — `required` is about ARGV, not about embedders.
    expect(await run(["status"], sink, { store, driver }, sink)).toBe(0);
  });

  test("a value-taking flag with no value is refused; a boolean flag never eats the next token", async () => {
    const deps: Partial<FleetDeps> = { driver, store, readBrief: async () => "{not json" };
    // valueType "path"/"string" ⇒ the flag consumes a value, and a missing one is
    // the operator's typo, not an empty string to act on.
    //
    // Driven from the REGISTRY, over every verb and every flag: only `--dir` and
    // `--port` were ever tried, so `--brief`'s value-taking-ness — the column
    // DF3.5 turns into a generated skill's call signature — was declared and
    // never observed. Re-declared "boolean" it becomes a flag the tokenizer
    // consumes alone, leaving the brief's FILENAME behind as a positional, and
    // `dispatch takes no positional arguments` is the error the operator gets.
    for (const entry of listVerbs()) {
      for (const flag of entry.flags) {
        if (flag.valueType === "boolean") continue;
        // Trailing, so there is no next token that could be mistaken for a value.
        const err: string[] = [];
        expect(await run([entry.verb, flag.name], sink, deps, (s) => void err.push(s))).toBe(2);
        expect(err.join("")).toContain(flag.name);
      }
    }

    // …and the PARTITION itself, by hand, for the two flags the sweep above
    // cannot defend: it is driven from `valueType`, so a flag re-declared
    // "boolean" simply moves to the other branch and stops being tested. These
    // two probe the flag with a value present and assert it was EATEN.
    //
    // `--brief` (no `readBrief` injected, so the path is really opened): as a
    // boolean it consumes nothing and the brief's FILENAME is left behind as a
    // positional, which dispatch refuses as `takes no positional arguments`.
    const briefErr: string[] = [];
    expect(await run(["dispatch", "--brief", "some-brief.json"], sink, { driver, store }, (s) => void briefErr.push(s))).toBe(2);
    expect(briefErr.join("")).toContain("cannot read --brief some-brief.json");
    expect(briefErr.join("")).not.toContain("positional");

    // `--driver` (no driver injected, so the NAME is really resolved): as a
    // boolean the name is left behind as a positional and the refusal becomes
    // `status requires --driver <name>` — the opposite verdict about the same argv.
    const driverErr: string[] = [];
    expect(await run(["status", "--driver", "no-such-driver"], sink, { store }, (s) => void driverErr.push(s))).toBe(2);
    expect(driverErr.join("")).toContain("no-such-driver");
    expect(driverErr.join("")).not.toContain("requires --driver");

    // valueType "boolean" ⇒ it consumes NOTHING. If `--no-harvest` took a value
    // it would swallow the run id and teardown would refuse as "requires
    // <run-id>" (exit 2); reaching run-not-found (4) proves the id survived.
    expect(await run(["teardown", "--no-harvest", "no-such-run"], sink, deps, sink)).toBe(4);

    // The OUTPUT, not the code: both hypotheses exit 0 here. A value-taking
    // `--help` would swallow "no-such-run", leaving `status` with no positionals
    // over an empty store — which prints nothing and exits 0, exactly like the
    // help path. Only the usage text tells them apart.
    const out: string[] = [];
    expect(await run(["status", "--help", "no-such-run"], (s) => void out.push(s), deps, sink)).toBe(0);
    expect(out.join("")).toContain("Usage: fleet ");
    expect(out.join("")).toContain("status");
  });

  /**
   * `path` vs `string` has no TOKENIZER consequence — both consume a value — so
   * nothing in this file could tell them apart: `expect(flags).toEqual(
   * EXPECTED_FLAGS[verb])` compares the registry against a literal copy of
   * itself, and flipping `--dir` to `"string"` updates both in one commit while
   * DF3.5's generated skill starts emitting the wrong parameter type.
   *
   * The claim `path` makes is about the VALUE — the CLI opens it — so that is
   * what is pinned, per flag, next to the behaviour that justifies it. Flipping
   * the column now means deleting a demonstration of real filesystem behaviour,
   * which is friction with a reason attached rather than a table edit.
   */
  const flagOf = (verb: string, name: string): VerbFlag =>
    listVerbs()
      .find((v) => v.verb === verb)!
      .flags.find((f) => f.name === name)!;

  test("valueType `path` names a file the CLI really opens; `string` is never opened", async () => {
    // --dir: opened as a DIRECTORY. Pointed at a regular file it is refused
    // (ENOTDIR) — a value the CLI merely carried as a string could not notice.
    // `store` is deliberately NOT injected here: an injected store is what the
    // flag would otherwise be silently overridden by.
    expect(flagOf("status", "--dir").valueType).toBe("path");
    const notADir = join(dir, "regular-file");
    writeFileSync(notADir, "not a directory\n");
    const dirErr: string[] = [];
    expect(await run(["status", "--dir", notADir], sink, { driver }, (s) => void dirErr.push(s))).toBe(2);
    expect(dirErr.join("")).toContain(notADir);

    // --brief: READ as a file, and the BYTES at that path reach the schema. The
    // value names the brief; it is not the brief. `readBrief` is not injected,
    // for the same reason `store` is not above.
    expect(flagOf("dispatch", "--brief").valueType).toBe("path");
    const briefPath = join(dir, "brief.json");
    writeFileSync(briefPath, "{not json");
    const briefErr: string[] = [];
    expect(await run(["dispatch", "--brief", briefPath], sink, { driver, store }, (s) => void briefErr.push(s))).toBe(2);
    expect(briefErr.join("")).toContain("not valid JSON");

    // --port: `string`, and the distinction is not cosmetic — the CLI
    // range-checks it and never opens it, so a value that IS a readable file is
    // still refused. Declared `path`, DF3.5 would generate a skill handing it
    // one.
    expect(flagOf("dispatch", "--port").valueType).toBe("string");
    const portErr: string[] = [];
    expect(await run(["dispatch", "--port", briefPath], sink, { driver, store }, (s) => void portErr.push(s))).toBe(2);
    expect(portErr.join("")).toContain("is not a TCP port");
  });

  test("`-h` is the registry's `--help` in short form — accepted, and it eats nothing", async () => {
    // Implemented in scripts/fleet.ts (HELP_ALIAS, plus the one line normalizing
    // it to `--help`) and declared in NO registry entry, so nothing bound the
    // two: deleting that line makes `fleet status -h` an unknown flag the
    // per-verb `allowed` check refuses as exit 2, and every test still passed.
    expect(listVerbs().flatMap((v) => v.flags).some((f) => f.name === "-h")).toBe(false);
    const expected = `${renderHelp(listVerbs())}\n`;
    for (const entry of listVerbs()) {
      const out: string[] = [];
      const err: string[] = [];
      expect(await run([entry.verb, "-h"], (s) => void out.push(s), { driver, store }, (s) => void err.push(s))).toBe(0);
      // The SAME text as `--help`, on stdout, with nothing on stderr: a `-h`
      // that fell through to the verb would exit 0 for `status` over an empty
      // store too, printing nothing — which the exit code alone cannot tell apart.
      expect(out.join("")).toBe(expected);
      expect(err.join("")).toBe("");
    }
    // Boolean, like the `--help` it normalizes to: it consumes no value, so a
    // run id after it survives — and the help path still wins over the verb.
    const out: string[] = [];
    expect(await run(["teardown", "-h", "no-such-run"], (s) => void out.push(s), { driver, store }, sink)).toBe(0);
    expect(out.join("")).toBe(expected);
    // …and it is still subject to the duplicate-bool guard, so it is a real
    // registered boolean rather than a token the parser happens to ignore.
    expect(await run(["status", "-h", "-h"], sink, { driver, store }, sink)).toBe(2);
  });

  test("`fleet help` is a fifth accepted verb that listVerbs() does not return", async () => {
    // "exactly 4 entries" is true of the REGISTRY and false of the CLI: argv[0]
    // === "help" is answered before tokenization, so `help` is a verb DF3.5's
    // generated skill can never know about. Pinned rather than fixed — the
    // registry describes flag grammar, and `help` has none — but pinned so a
    // `version` or `doctor` added the same way cannot stay invisible.
    expect(listVerbs().map((v) => v.verb)).not.toContain("help");
    const out: string[] = [];
    expect(await run(["help"], (s) => void out.push(s), { driver, store }, sink)).toBe(0);
    expect(out.join("")).toBe(`${renderHelp(listVerbs())}\n`);

    // Any OTHER unregistered verb is still refused, so the acceptance above is
    // specific to `help` and not a parser that waves any first token through.
    for (const notAVerb of ["version", "doctor"]) {
      const err: string[] = [];
      expect(await run([notAVerb], sink, { driver, store }, (s) => void err.push(s))).toBe(2);
      expect(err.join("")).toContain("unknown-verb");
    }
    // And the CLI grows no more of them unnoticed: its ONLY pre-registry reading
    // of argv[0] is that one literal. Read from the source because there is no
    // runtime enumeration of "strings the CLI answers before the registry" —
    // the same binding the excused-exit-code test makes against cli.test.ts.
    const cli = readFileSync(join(import.meta.dir, "..", "..", "scripts", "fleet.ts"), "utf8");
    // `argv.at(0)` and bracket spacing are the same reading spelled differently.
    expect(
      [...cli.matchAll(/\bargv(?:\.at\(\s*0\s*\)|\[\s*0\s*\])\s*===\s*"([^"]*)"/g)].map((m) => m[1]),
    ).toEqual(["help"]);
  });

  test("a flag the registry does not give a verb is refused, per verb", async () => {
    const deps: Partial<FleetDeps> = { driver, store, readBrief: async () => "{not json" };
    // T1-3 (round 11): the sweep list is DERIVED from the registry, not a
    // hand-maintained three-flag literal — post-merge verbs added --pattern,
    // --n, --pin, --roster, --cap-micro-usd and --steps-json, none of which the
    // old list ever tried against a foreign verb. A verb whose parser stops
    // refusing another verb's flag now turns red HERE.
    const allFlags = [...new Set(listVerbs().flatMap((v) => v.flags.map((f) => f.name)))];
    expect(allFlags.length).toBeGreaterThan(3); // anti-vacuity: the derivation really widened
    for (const entry of listVerbs()) {
      const declared = new Set(entry.flags.map((f) => f.name));
      for (const flag of allFlags) {
        if (declared.has(flag)) continue;
        const err: string[] = [];
        // The value TYPE is resolved from the verb that OWNS the flag, not from
        // this entry — `entry.flags.find(... === flag)` is always undefined
        // here (the sweep only visits flags this verb does NOT declare), so it
        // typed every foreign flag as valued and appended "x" even to boolean
        // ones. The owning verb's declaration is the authority.
        const owner = listVerbs().find((v) => v.flags.some((f) => f.name === flag));
        const value = owner?.flags.find((f) => f.name === flag)?.valueType !== "boolean";
        const argv = value ? [entry.verb, flag, "x"] : [entry.verb, flag];
        expect(await run(argv, sink, deps, (s) => void err.push(s))).toBe(2);
        expect(err.join("")).toContain(`${entry.verb} does not take ${flag}`);
      }
    }
  });
});

describe("status.ts (statusAll join logic)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    // Store and driver get their OWN directories: sharing one passes today
    // only because record filenames end in `.json` and box names do not.
    dir = mkdtempSync(join(tmpdir(), "qds-status-"));
    driver = joinOnlyDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The REAL provisioning sequence: record → box named after the run id →
   * `vmName` written back. Nothing here re-derives a box name.
   */
  async function provision(runId: string, patch?: RunRecordPatch, port?: number): Promise<RunRecord> {
    const { record } = await provisionAdmittedRun(driver, store, {
      runId,
      ...(port === undefined ? {} : { port }),
    });
    return patch === undefined ? record : store.set(runId, patch);
  }

  test("closedAt → state 'closed', and the driver is still consulted", async () => {
    const runId = "test-closed-run";
    const rec = await provision(runId);
    store.close(runId);

    const listSpy = mock((name?: string) => driver.list(name));
    const rows: StatusRow[] = await statusAll({ driver: { list: listSpy }, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!.runId).toBe(runId);
    // A PARSEABLE instant, not merely a present key: `closedAt: "not a date"`
    // satisfies toBeDefined() and breaks the newest-first sort and every
    // age-based reaper downstream of it.
    expect(Date.parse(rows[0]!.closedAt as string)).not.toBeNaN();
    // A closed record over a live box is a box that is still billing.
    expect(rows[0]!.boxAlive).toBe(true);
    expect(rows[0]!.vmName).toBe(rec.vmName);
    expect(listSpy).toHaveBeenCalled();
  });

  test("closed + destroyed box → 'closed' with boxAlive FALSE (confirmed gone, not unknown)", async () => {
    // `false`, not absent: the driver answered. Absence is reserved for "the
    // substrate could not be reached", which the boxUnknown case below pins —
    // conflating the two reported every list failure as confirmed-destroyed.
    const runId = "test-closed-gone";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("closed");
    expect(rows[0]!.boxAlive).toBe(false);
  });

  test("closed + list FAILS → 'closed' with boxAlive ABSENT (the box may still be billing)", async () => {
    const runId = "test-closed-unknown";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const rows = await statusAll({
      driver: {
        list: async (): Promise<ProviderVm[]> => {
          throw new Error("list down");
        },
      },
      store,
      listTimeoutMs: 1000,
    });
    const closed = rows.find((r) => r.runId === runId)!;
    expect(closed.state).toBe("closed");
    expect(closed).not.toHaveProperty("boxAlive");
    // The other zero-`boxUnknown` fleet: every record CLOSED. No open record
    // means no boxUnknown row, so without the fleet-level row the outage is
    // invisible again — a clean-looking exit 0 over an unlistable substrate.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("open + vmName unset + no box → boxMissing", async () => {
    const runId = "test-no-vm";
    store.create(runId); // record only: no box was ever created
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
  });

  test("open + listOk + vm in set → live", async () => {
    const runId = "test-live-run";
    const rec = await provision(runId);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.vmName).toBe(rec.vmName);
  });

  test("open + listOk + vm NOT in set → boxMissing", async () => {
    const runId = "test-missing-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("boxMissing");
    expect(rows[0]!.runId).toBe(runId);
    expect(rows[0]!.vmName).toBe(rec.vmName);
  });

  test("open + list hangs past listTimeoutMs → boxUnknown", async () => {
    const runId = "test-unknown";
    await provision(runId);

    // A promise that never settles — no test-owned timer to leak.
    const hangingDriver = { list: () => new Promise<ProviderVm[]>(() => {}) };
    const rows = await statusAll({ driver: hangingDriver, store, listTimeoutMs: 5 });

    // The record row PLUS the unconditional listUnavailable row (see below).
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === runId)!.state).toBe("boxUnknown");
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("open + list throws → boxUnknown", async () => {
    const runId = "test-throw";
    await provision(runId);

    const throwingDriver = {
      list: async (): Promise<ProviderVm[]> => {
        throw new Error("driver list failed");
      },
    };
    const rows = await statusAll({ driver: throwingDriver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === runId)!.state).toBe("boxUnknown");
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("non-array driver reply degrades to boxUnknown, never a TypeError", async () => {
    const runId = "test-nonarray";
    await provision(runId);

    const nonArrayDriver = { list: async (): Promise<ProviderVm[]> => ({}) as unknown as ProviderVm[] };
    const rows = await statusAll({ driver: nonArrayDriver, store, listTimeoutMs: 1000 });

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === runId)!.state).toBe("boxUnknown");
    expect(rows.find((r) => r.runId === FLEET_ROW_ID)!.state).toBe("listUnavailable");
  });

  test("a list failure is VISIBLE with zero records — an empty fleet and an unreachable one differ", async () => {
    // The whole reason the row exists. `boxUnknown` only ever attaches to an
    // OPEN record, so with nothing on disk (or with every record closed) a total
    // listing failure produced `[]` — byte-identical to a healthy empty fleet,
    // and an exit 0 telling the operator the fleet is clean while every box in
    // it kept billing.
    const downDriver = {
      list: async (): Promise<ProviderVm[]> => {
        throw new Error("substrate unreachable");
      },
    };
    expect(await statusAll({ driver, store, listTimeoutMs: 1000 })).toEqual([]);

    const rows = await statusAll({ driver: downDriver, store, listTimeoutMs: 1000 });
    expect(rows).toEqual([{ runId: FLEET_ROW_ID, state: "listUnavailable" }]);
  });

  test("no non-run row's id can ever collide with a real run id", async () => {
    // It is the row's identity in a stream keyed by runId, so a collision would
    // let a run masquerade as the fleet-level failure (and vice versa).
    expect(RUN_ID_RE.test(FLEET_ROW_ID)).toBe(false);

    // The same claim for the OTHER recordless row class, and for a sharper
    // reason: an orphan's name is whatever the SUBSTRATE called it, and on a
    // tag-blind substrate that is every box in the account — so a bare
    // `"runId": "my-dev-box"` is a string whose next operator command is
    // `fleet teardown my-dev-box`, against a box no run ever owned.
    await driver.create("plain-box-name", SBX_OWNERSHIP_TAG);
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("orphan");
    expect(RUN_ID_RE.test(rows[0]!.runId)).toBe(false);
    // The box name still rides on `vmName` — that is what teardown targets —
    // and it IS a legal run id, so the guard above is the parenthesised
    // wrapping and not an accident of the fixture's name.
    expect(rows[0]!.vmName).toBe("plain-box-name");
    expect(RUN_ID_RE.test(rows[0]!.vmName!)).toBe(true);
  });

  test("a healthy list emits NO listUnavailable row", async () => {
    // Without this the row could be unconditional and every case above still
    // passes by name lookup.
    await provision("test-no-false-alarm");
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows.some((r) => r.state === "listUnavailable")).toBe(false);
  });

  test("store.list() failure surfaces as a typed FleetError, not a bare throw", async () => {
    // `listWithAnomalies`, not `list`: that is the accessor statusAll reads, and
    // a stub declaring only `list` was "failing" by being an absent method —
    // right exit code, wrong message, and it would have passed a statusAll that
    // never consulted the store at all.
    const brokenStore = {
      listWithAnomalies: (): never => {
        throw new Error("malformed run record beta.json: unknown key: nope");
      },
    } as unknown as RunRecordStore;

    const err = await refusal(
      statusAll({ driver, store: brokenStore, listTimeoutMs: 1000 }),
      1,
      "record-store-unreadable",
    );
    expect(err.message).toContain("malformed run record beta.json");
    expect(err.remediation).toContain("fleet status");
  });

  test("a .json whose stem is not a run id is REPORTED as skipped, never silently dropped", async () => {
    // INV-4's one exception: a `.json` with a bad FILENAME is skipped so that a
    // single unreadable name cannot take the whole directory down. But a skipped
    // file can hold an OPEN record naming a live box — so "3 runs" and "3 runs
    // and one record I refused to read" must not render identically, and a
    // truncated fleet must not be reported as the whole fleet.
    //
    // A real RunRecordStore, not a stub: the skipping happens inside
    // `listWithAnomalies`, so a stub handing back `{records, skipped}` asserts
    // the plumbing and not the one thing that decides which files are skipped.
    await provision("well-named-run");
    writeFileSync(join(store.dir, "NOT_A_RUN_ID.json"), '{"runId":"NOT_A_RUN_ID"}\n');

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    // ALONGSIDE the good rows, never instead of them, and sorted first for the
    // same reason listUnavailable is: it is a row about every other row.
    expect(rows.map((r) => [r.runId, r.state])).toEqual([
      [FLEET_ROW_ID, "recordsSkipped"],
      ["well-named-run", "live"],
    ]);
    // The FILENAME, so the operator can go repair the one file. A bare count
    // sends them reading the whole directory.
    expect(rows[0]!.skippedRecords).toEqual(["NOT_A_RUN_ID.json"]);

    // …and the single-run query for a run that is not there carries the caveat
    // too: the skipped file may be that run's own record under a mangled name,
    // so a bare "no such run" denies a box that may still be billing.
    const err = await refusal(
      statusRun({ driver, store, listTimeoutMs: 1000 }, "no-such-run"),
      4,
      "run-not-found",
    );
    expect(err.remediation).toContain("NOT_A_RUN_ID.json");

    // A clean directory emits NO such row — without this the row could be
    // unconditional and everything above still passes by name lookup.
    rmSync(join(store.dir, "NOT_A_RUN_ID.json"));
    const clean = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(clean.some((r) => r.state === "recordsSkipped")).toBe(false);
  });

  test("T1 (r3b-verbs-b): recordsSkipped and listUnavailable rows COEXIST — neither folds into the other", async () => {
    // Two independent truncations of two independent listings: the DRIVER
    // refused to name boxes (listUnavailable) and the RECORD store skipped a
    // file (recordsSkipped). Both share runId "(fleet)", so a refactor that
    // lets one row overwrite the other in a map keyed by id stays green while
    // one of the two outages vanishes from the output. Order rides stable-sort
    // insertion (records first, driver row pushed after) — pinned as such.
    await provision("coexist-run");
    writeFileSync(join(store.dir, "NOT_A_RUN_ID.json"), '{"runId":"NOT_A_RUN_ID"}\n');
    const rows = await statusAll({
      driver: {
        list: async (): Promise<ProviderVm[]> => {
          throw new Error("list down");
        },
      },
      store,
      listTimeoutMs: 1000,
    });
    const fleetRows = rows.filter((r) => r.runId === FLEET_ROW_ID);
    // BOTH, as separate rows.
    expect(fleetRows.map((r) => r.state)).toContain("recordsSkipped");
    expect(fleetRows.map((r) => r.state)).toContain("listUnavailable");
    expect(fleetRows).toHaveLength(2);
    // The skipped NAMES survive on their own row even with the driver down.
    expect(fleetRows.find((r) => r.state === "recordsSkipped")?.skippedRecords).toEqual(["NOT_A_RUN_ID.json"]);
  });

  test("T1 (r3b-verbs-b): safeUrl refuses userinfo-bearing and non-https httpsUrl on STATUS ROWS", async () => {
    // dispatch's INV-6 pins the same sanitizer on refusal MESSAGES; the status
    // row is a second sink (`rowForRecord` / `orphanRow`) and could ride the
    // raw value out with this suite green. https-only and no-userinfo are both
    // mandatory; `sanitizeLabel`'s cap is inherited, not re-pinned here.
    const rec = await provision("url-sanitized-run", { httpsUrl: "https://user:pw@host.example/vm" });
    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, rec.runId);
    expect(row.state).toBe("live");
    expect(row.httpsUrl).toBeUndefined();

    // Non-https scheme: dropped for the same reason.
    store.set(rec.runId, { httpsUrl: "http://host.example/vm" });
    const httpRow = await statusRun({ driver, store, listTimeoutMs: 1000 }, rec.runId);
    expect(httpRow.httpsUrl).toBeUndefined();

    // A clean URL SURVIVES verbatim-shaped (bounded): the absence proofs above
    // are vacuous if `safeUrl` just deleted everything.
    store.set(rec.runId, { httpsUrl: "https://clean-host.example/vm" });
    const okRow = await statusRun({ driver, store, listTimeoutMs: 1000 }, rec.runId);
    expect(okRow.httpsUrl).toBe("https://clean-host.example/vm");
  });

  test("T1 (r3b-verbs-b): a >64-char createdAt is TRUNCATED in the row but still sorts by its true instant", async () => {
    // `pinSortInstant` reads the RAW record value BEFORE `sanitizeLabel` bounds
    // it to MAX_TIMESTAMP=64 — deleting pinSortInstant passes every short-date
    // fixture and silently demotes over-long stamps to "unparseable sorts
    // first", inverting newest-first for exactly the malformed-createdAt runs an
    // operator most needs on top.
    // MAX_TIMESTAMP is module-private (status.ts:125); this test pins the
    // CONTRACT "row.createdAt is bounded, sort uses the raw instant", not the
    // constant itself — a widening of the bound must not break the sort pin.
    // A >64-char createdAt that still PARSES: a long fractional-second stamp.
    // JS Date.parse accepts arbitrary fraction digits (truncating to ms), so
    // 40 of them clears the 64-unit bound while remaining a valid instant.
    const longCreatedAt = `2026-01-02T03:04:05.${"1".repeat(40)}+00:00`;
    expect(longCreatedAt.length).toBeGreaterThan(64);
    expect(Number.isNaN(Date.parse(longCreatedAt))).toBe(false);
    const rows2: RunRecord[] = [
      { runId: "x-long", createdAt: longCreatedAt },
      { runId: "y-short-newer", createdAt: "2026-01-02T09:00:00Z" },
    ];
    const stubStore = {
      listWithAnomalies: () => ({ records: rows2, skipped: [] }),
    } as unknown as RunRecordStore;
    const rows = await statusAll({ driver, store: stubStore, listTimeoutMs: 1000 });
    // y-short-newer is genuinely later → first. If the raw pin were gone,
    // x-long's bounded string would parse as NaN/Infinity-first and WIN.
    expect(rows.map((r) => r.runId)).toEqual(["y-short-newer", "x-long"]);
  });

  test("newest-first by createdAt, numeric across mixed ISO shapes, runId breaking ties", async () => {
    // Fed in an order `store.list()` never produces, so deleting the sort fails.
    // Neither lexicographic order nor runId order is the expected answer:
    //   "…T01:00:00+01:00" sorts LAST lexicographically-desc but ties at t=0,
    //   "…T00:00:00.500Z" sorts BEFORE "…T00:00:00Z" as text yet is 500ms later.
    const rows2: RunRecord[] = [
      { runId: "b-oldest", createdAt: "2026-01-01T00:00:00Z" },
      { runId: "a-tied", createdAt: "2026-01-01T01:00:00+01:00" },
      { runId: "c-newest", createdAt: "2026-01-01T00:00:00.500Z" },
    ];
    const stubStore = {
      listWithAnomalies: () => ({ records: rows2, skipped: [] }),
    } as unknown as RunRecordStore;

    const rows = await statusAll({ driver, store: stubStore, listTimeoutMs: 1000 });
    expect(rows.map((r) => r.runId)).toEqual(["c-newest", "a-tied", "b-oldest"]);
  });

  test("empty fleet → empty array", async () => {
    // toEqual([]), not toHaveLength(0): `""` has length 0, and a statusAll that
    // returned one on the empty path would be `.map()`ed over by the CLI.
    expect(await statusAll({ driver, store, listTimeoutMs: 1000 })).toEqual([]);
  });

  test("row carries the record's optional fields", async () => {
    const runId = "test-optional";
    // The real expose path writes httpsUrl onto the record. Asserted by SHAPE:
    // the literal string "undefined" is defined, and is what a template that
    // interpolated a missing value produces.
    const rec = await provision(runId, undefined, 8080);
    expect(rec.httpsUrl).toMatch(/^https:\/\//);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.vmName).toBe(rec.vmName);
    expect(rows[0]!.httpsUrl).toBe(rec.httpsUrl);
  });

  test("spend/limit/requestId ride EVERY record-backed state, not just live", async () => {
    const costs: RunRecordPatch = {
      spendMicroUsd: 123456,
      limitMicroUsd: 500000,
      requestId: "req-costs",
    };
    // live
    await provision("cost-live", costs);
    // boxMissing
    const missing = await provision("cost-missing", costs);
    await driver.destroy(missing.vmName!);
    // closed (core fields must be written before close)
    await provision("cost-closed", costs);
    store.close("cost-closed");

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get("cost-live")!.state).toBe("live");
    expect(byId.get("cost-missing")!.state).toBe("boxMissing");
    expect(byId.get("cost-closed")!.state).toBe("closed");
    for (const id of ["cost-live", "cost-missing", "cost-closed"]) {
      const row = byId.get(id)!;
      expect(row.spendMicroUsd).toBe(123456);
      expect(row.limitMicroUsd).toBe(500000);
      expect(row.requestId).toBe("req-costs");
    }

    // boxUnknown builds its own row literal too. (A closed record still reads
    // `closed` with no list — closedAt is decided before the box evidence is.)
    const unknownRows = await statusAll({
      driver: {
        list: async (): Promise<ProviderVm[]> => {
          throw new Error("list down");
        },
      },
      store,
      listTimeoutMs: 1000,
    });
    // 3 record rows + the fleet-level listUnavailable row.
    expect(unknownRows).toHaveLength(4);
    for (const row of unknownRows.filter((r) => r.runId !== FLEET_ROW_ID)) {
      expect(row.state).toBe(row.runId === "cost-closed" ? "closed" : "boxUnknown");
      expect(row.spendMicroUsd).toBe(123456);
      expect(row.limitMicroUsd).toBe(500000);
      expect(row.requestId).toBe("req-costs");
    }
  });

  test("mixed fleet: closed + live + boxMissing + orphan in ONE call", async () => {
    // Every other test asserts toHaveLength(1), which a per-record branch that
    // leaks across iterations satisfies perfectly.
    await provision("mix-live", { requestId: "req-live" });
    const missing = await provision("mix-missing", { requestId: "req-missing" });
    await driver.destroy(missing.vmName!);
    await provision("mix-closed", { requestId: "req-closed" }); // box left alive
    store.close("mix-closed");
    // An owned box no record claims: unattributed spend.
    await driver.create("mix-orphan", SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((r) => [r.runId, r]));
    expect(byId.get("mix-live")!.state).toBe("live");
    expect(byId.get("mix-missing")!.state).toBe("boxMissing");
    expect(byId.get("mix-closed")!.state).toBe("closed");
    expect(byId.get("mix-closed")!.boxAlive).toBe(true);
    // By vmName, never by runId: an orphan's row id is parenthesised, precisely
    // so it can never be keyed (or pasted into `fleet teardown`) as a run.
    const orphan = rows.find((r) => r.vmName === "mix-orphan")!;
    expect(orphan.state).toBe("orphan");
    expect(RUN_ID_RE.test(orphan.runId)).toBe(false);
    // requestId on every state that HAS a record, and only there.
    expect(byId.get("mix-live")!.requestId).toBe("req-live");
    expect(byId.get("mix-missing")!.requestId).toBe("req-missing");
    expect(byId.get("mix-closed")!.requestId).toBe("req-closed");
    expect(orphan).not.toHaveProperty("requestId");
    // The closed record's live box is reported on its own row — never twice.
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(1);
  });

  test("orphan rows: no record, no requestId, sorted first and deterministically", async () => {
    await provision("claimed-run");
    await driver.create("orphan-b", SBX_OWNERSHIP_TAG);
    await driver.create("orphan-a", SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows.map((r) => r.runId)).toEqual(["(orphan orphan-a)", "(orphan orphan-b)", "claimed-run"]);
    // The ordering claim on its own terms, so a change to the id spelling can
    // never quietly take the sort with it: both orphans precede the record row.
    expect(rows.findIndex((r) => r.runId === "claimed-run")).toBe(rows.length - 1);
    for (const name of ["orphan-a", "orphan-b"]) {
      const row = rows.find((r) => r.vmName === name)!;
      expect(row.state).toBe("orphan");
      expect(row.vmName).toBe(name);
      // Never the bare box name — see the collision test above.
      expect(RUN_ID_RE.test(row.runId)).toBe(false);
      // ABSENT, not "": a required-but-empty instant makes every renderer's
      // `new Date(row.createdAt)` produce Invalid Date on the one row class the
      // sort floats to the top. (Two such rows also tie at +Infinity here, so
      // the deterministic order above is the comparator's NaN fallthrough.)
      expect(row).not.toHaveProperty("createdAt");
      expect(row).not.toHaveProperty("requestId");
    }
  });

  test("nameless driver entries are dropped, never keyed as an undefined runId", async () => {
    // `StatusDeps.driver` is structural, so an injected or third-party driver
    // can answer with entries that are not VMs. A nameless one used to key the
    // Map under `undefined` and reach the output as an orphan row with no
    // runId, which the comparator then dereferenced (TypeError) as soon as a
    // second such row existed.
    const junkDriver = {
      list: async (): Promise<ProviderVm[]> =>
        [
          { name: undefined },
          { name: "" },
          null,
          { name: "real-orphan", tag: SBX_OWNERSHIP_TAG },
          { name: undefined },
        ] as unknown as ProviderVm[],
    };
    const rows = await statusAll({ driver: junkDriver, store, listTimeoutMs: 1000 });
    // toStrictEqual, NOT toEqual: an undefined element compares equal to a
    // missing one under toEqual, and a trailing nameless row is exactly the
    // regression this test exists to reject.
    expect(rows).toHaveLength(1);
    expect(rows.map((r) => r.runId)).toStrictEqual(["(orphan real-orphan)"]);
    expect(rows[0]!.state).toBe("orphan");
    expect(rows[0]!.vmName).toBe("real-orphan");
  });

  test("a box carrying a FOREIGN tag never makes a run report live", async () => {
    const runId = "tagged-foreign";
    await provision(runId);

    const rows = await statusAll({ driver: retagged(driver, "someone-elses-fleet"), store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1); // filtered out entirely — not even an orphan
    expect(rows[0]!.state).toBe("boxMissing");
  });

  test("an UNTAGGED box is still ours (exedev ls reports no tag)", async () => {
    const runId = "tagged-absent";
    await provision(runId);

    const rows = await statusAll({ driver: retagged(driver, null), store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
  });

  test("a box named differently from its run: claimed by vmName, live, never ALSO an orphan", async () => {
    // Nothing else in this file produces `vmName !== runId` — provisioning names
    // the box after the run — so three branches in status.ts were dead in test:
    // the two-name join, the `claimed.add(rec.vmName)` sweep, and (in statusRun)
    // the list filter. A renamed box is exactly the one that keeps billing while
    // every row claims boxMissing.
    const runId = "renamed-box-run";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!); // nothing answers to the run id any more
    await driver.create("box-under-another-name", SBX_OWNERSHIP_TAG);
    store.set(runId, { vmName: "box-under-another-name" });

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    // ONE row. Dropping `rec.vmName` from the join names reports boxMissing for a
    // box that is alive; dropping `claimed.add(rec.vmName)` reports that same box
    // a second time as an orphan, so the fleet appears to hold two of them.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    expect(rows[0]!.vmName).toBe("box-under-another-name");
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(0);
  });

  test("vmName names a box that is gone while one lives under the run id → live", async () => {
    // The other half of the `[vmName, runId]` join: dropping `runId` from it is
    // invisible while every fixture has the two equal.
    const runId = "vmname-elsewhere";
    await provision(runId); // the box IS named after the run
    store.set(runId, { vmName: "a-box-that-was-renamed-away" });

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    // The record's own name still identifies the box — it is what the record says.
    expect(rows[0]!.vmName).toBe("a-box-that-was-renamed-away");
  });

  test("crash window: open record with no vmName but a live box under the run id → live", async () => {
    // INV-1's window: `driver.create` returned, the `set({vmName})` never landed.
    const runId = "crash-window-run";
    store.create(runId);
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
    // The box name teardown would target, taken from the box itself.
    expect(rows[0]!.vmName).toBe(runId);
    expect(rows.filter((r) => r.state === "orphan")).toHaveLength(0);
  });

  // ─── F091: the name collision at the join ─────────────────────────────────

  /** statusAll plus whatever it emitted on the shared log sink. */
  async function statusWithLines(d: StatusDeps): Promise<{ rows: StatusRow[]; lines: LogEntry[] }> {
    const lines: LogEntry[] = [];
    const restore = setLogSink((e) => lines.push(e));
    try {
      return { rows: await statusAll(d), lines };
    } finally {
      restore();
    }
  }

  test("two records claiming one box name → a duplicate-box-name line naming BOTH run ids", async () => {
    // `name` is the join key across records, driver and teardown, so two records
    // resolving to one box means one of them is reporting a box it does not own
    // — and the other's box, if it has one, is nowhere in the table.
    await provision("dup-run-1");
    store.create("dup-run-2");
    store.set("dup-run-2", { vmName: "dup-run-1" });

    const { rows, lines } = await statusWithLines({ driver, store, listTimeoutMs: 1000 });

    const line = lines.find((l) => l.code === "duplicate-box-name");
    expect(line).toBeDefined();
    const text = JSON.stringify(line);
    expect(text).toContain("duplicate-box-name");
    expect(text).toContain("dup-run-1");
    expect(text).toContain("dup-run-2");
    // The table is unchanged — the collision is REPORTED, not repaired.
    expect(rows.filter((r) => r.state === "live")).toHaveLength(2);
  });

  test("substrate reports two boxes under one name → the dropped box is reported, table keeps last-wins", async () => {
    // The last-wins map at the record→VM join: the earlier box vanishes from the
    // output while it is still live and billing.
    const twoBoxes = {
      list: async (): Promise<ProviderVm[]> => [
        { name: "dup-box", tag: SBX_OWNERSHIP_TAG, httpsUrl: "https://first.example" },
        { name: "dup-box", tag: SBX_OWNERSHIP_TAG, httpsUrl: "https://second.example" },
      ],
    };
    store.create("dup-claimant");
    store.set("dup-claimant", { vmName: "dup-box" });

    const { rows, lines } = await statusWithLines({ driver: twoBoxes, store, listTimeoutMs: 1000 });

    const line = lines.find((l) => l.code === "duplicate-box-name");
    expect(line).toBeDefined();
    expect(line!.boxCount).toBe(2);
    expect(JSON.stringify(line)).toContain("dup-claimant");
    // last-wins stands: one row, one box.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
  });

  test("no collision → no duplicate-box-name line", async () => {
    await provision("no-dup-run");
    const { lines } = await statusWithLines({ driver, store, listTimeoutMs: 1000 });
    expect(lines.filter((l) => l.code === "duplicate-box-name")).toHaveLength(0);
  });

  test("two records claim one name AND the driver is unavailable → boxCount is unknown, not 0", async () => {
    // boxes === null (driver failed) must not be read as "the substrate
    // reported zero boxes" — that overstates a listing the provider never
    // returned. Two records claiming the same name still needs reporting.
    store.create("dup-unavail-1");
    store.create("dup-unavail-2");
    store.set("dup-unavail-2", { vmName: "dup-unavail-1" });
    const throwingDriver = {
      list: async (): Promise<ProviderVm[]> => {
        throw new Error("driver list failed");
      },
    };

    const { lines } = await statusWithLines({ driver: throwingDriver, store, listTimeoutMs: 1000 });

    const line = lines.find((l) => l.code === "duplicate-box-name");
    expect(line).toBeDefined();
    expect(line!.boxCount).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain('"boxCount":0');
    expect(String(line!.message)).toContain("driver-unavailable");
    expect(String(line!.message)).not.toContain("reported 0 box");
  });
});

describe("provisionAdmittedRun (INV-1) — failure leaves the run reclaimable", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  const budget = {
    repoSlug: "acme/widgets",
    issueId: "42",
    capMicroUsd: 50_000_000,
    spentMicroUsd: 0,
    reservedMicroUsd: 0,
    admittedCeilingMicroUsd: 20_000_000,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-provision-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed driver.create leaves the record OPEN with its budget attribution", async () => {
    // Closing it here looked tidy and was wrong twice over: the ledger retires
    // a reservation only when a PRICED cost_event lands, which only teardown
    // writes from `extensions.budget` — and the reaper routes an aged OPEN
    // record through teardownSandbox while skipping a closed one outright
    // (`closed ⇒ nothing to claim`). A closed record therefore pinned the
    // issue's cap forever, and stranded any box the failing create did stand up.
    const runId = "create-fails-run";
    const failing = Object.assign(Object.create(driver) as FakeDriver, {
      create: async () => {
        throw new Error("substrate refused the create");
      },
    });

    const err = await rejection(provisionAdmittedRun(failing, store, { runId, budget }));
    expect(err.message).toContain("substrate refused the create");

    const rec = store.get(runId);
    expect(rec.closedAt).toBeUndefined();
    expect(rec.extensions?.budget?.admittedCeilingMicroUsd).toBe(budget.admittedCeilingMicroUsd);
    expect(rec.extensions?.budget?.repoSlug).toBe(budget.repoSlug);
    // No box name to claim, which is exactly what makes the record the handle.
    expect(rec.vmName).toBeUndefined();
  });

  test("a failed budget-extension write REMOVES the record so the reservation can expire", async () => {
    // The OPPOSITE call from the sibling above, and for the same money reason.
    // `store.create`'s O_EXCL has only won the id: `driver.create` has not run,
    // so nothing billable exists and there is no box to keep the record as a
    // handle for. What the record WOULD do is resolve with no `extensions.budget`
    // — and that pins the issue's cap forever (see below).
    const runId = "budget-write-fails";
    const failing = Object.assign(Object.create(driver) as FakeDriver, {
      create: async (): Promise<ProviderVm> => {
        throw new Error("driver.create must never be reached");
      },
    });
    const realSet = store.set.bind(store);
    let calls = 0;
    store.set = ((id: string, patch: Parameters<typeof realSet>[1]) => {
      calls += 1;
      if (calls === 1) throw new Error("record write failed");
      return realSet(id, patch);
    }) as typeof store.set;

    // finally, not "after the assertion": a failed assertion left `store.set`
    // patched for the rest of the body, and would leak past this test entirely
    // the moment `store` stops being rebuilt in beforeEach.
    let err: Error;
    try {
      err = await rejection(provisionAdmittedRun(failing, store, { runId, budget }));
    } finally {
      store.set = realSet;
    }
    expect(err.message).toContain("record write failed");

    // REMOVED, not left open: a record that resolves with no extensions.budget
    // pins the issue's cap forever (the orphan guard expires only an admission
    // whose record does not resolve; only a priced cost_event retires one).
    expect(() => store.get(runId)).toThrow(/ENOENT/);
    expect(await driver.list(runId)).toEqual([]);
  });

  test("a budget write timing out on the record LOCK refuses `budget-write-lock-timeout` and does NOT remove the record (T1/r3b)", async () => {
    // The third arm of provisionAdmittedRun's budget-write catch, added in
    // round 6 with no test anywhere: a lock TIMEOUT means someone else HOLDS
    // the lock — removing the record there would delete bytes a live writer is
    // about to rename back (record returns OPEN and BUDGETLESS anyway, id
    // re-mintable). The arm is chosen by `isRecordLockTimeout`, i.e. by the
    // `code: "lock-timeout"` the store attaches at its throw site (F039); every
    // other cause still takes the destructive rollback. Inverting the guard —
    // routing THIS cause onto rmSync, or that one onto this refusal — must fail
    // here.
    const runId = "budget-write-lock-timeout";
    const failing = Object.assign(Object.create(driver) as FakeDriver, {
      create: async (): Promise<ProviderVm> => {
        throw new Error("driver.create must never be reached");
      },
    });
    const realSet = store.set.bind(store);
    let calls = 0;
    store.set = ((id: string) => {
      calls += 1;
      if (calls === 1) {
        // Shaped exactly like run-record.ts's `withLock` timeout: coded, and
        // carrying the same message an operator would see.
        throw Object.assign(
          new Error("timed out waiting for the run record lock: /x/run.lock (held by pid 424242)"),
          { code: "lock-timeout" },
        );
      }
      return realSet(id, {} as Parameters<typeof realSet>[1]);
    }) as typeof store.set;

    let err: Error | undefined;
    try {
      err = await rejection(provisionAdmittedRun(failing, store, { runId, budget }));
    } finally {
      store.set = realSet;
    }
    // The LOCK-TIMEOUT refusal, typed and named — not the generic provision
    // failure the sibling above produces for an untyped write failure.
    expect(err.message).toContain("timed out waiting for the run record lock:");
    expect(err.message).toContain("deliberately NOT removed");

    // The record SURVIVES: this is the whole point of the arm. Reading it back
    // must NOT throw ENOENT — inverting the guard turns this into the sibling's
    // expectation, which is how a live writer's bytes get deleted.
    const rec = store.get(runId);
    expect(rec.closedAt).toBeUndefined();
    expect(rec.extensions?.budget).toBeUndefined();
  });
});

describe("status.ts (list timeout)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-timeout-"));
    driver = new FakeDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("F15: a listTimeoutMs above the 32-bit signed max is CLAMPED to it, never inverted to ~1ms", async () => {
    // fix-F15: `setTimeout` clamps a delay past 2^31-1 to 1 ms — an over-eager
    // configured ceiling used to become the SHORTEST possible budget, every box
    // reported boxUnknown and statusAll emitted listUnavailable. Clamping (not
    // refusing) is the contract: the largest real budget replaces an impossible
    // one. Pinned through the same timer-observation seam the default case
    // uses, because resolveTimeoutMs is module-private.
    await provisionAdmittedRun(driver, store, { runId: "clamp-run" });
    const boxes = await driver.list();
    let release!: (vms: ProviderVm[]) => void;
    const gate = new Promise<ProviderVm[]>((resolve) => {
      release = resolve;
    });
    const gated = { list: (): Promise<ProviderVm[]> => gate };

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed: { ms: unknown; handle: unknown }[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      armed.push({ ms, handle });
      return handle;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => {
      (realClearTimeout as (...a: unknown[]) => void)(handle);
    }) as unknown as typeof globalThis.clearTimeout;

    try {
      const pending = statusAll({
        driver: gated,
        store,
        // Exactly past the boundary: a value `setTimeout` would invert.
        listTimeoutMs: 2_147_483_648,
      });
      const armedByTheRace = armed.splice(0);
      expect(armedByTheRace).toHaveLength(1);
      // THE pin: the armed delay is the clamp ceiling, not 1 ms.
      expect(armedByTheRace[0]!.ms).toBe(2_147_483_647);
      release(boxes); // the listing answers; no timeout ever fires
      const rows = await pending;
      expect(rows.find((r) => r.state === "live")).toBeDefined();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("omitted listTimeoutMs arms the 30s default and the timer is always cleared", async () => {
    // Every other test injects a timeout, so `?? 30_000` → `?? 0` (or `?? 1`)
    // stays green while production reports boxUnknown for every run. Observe
    // the delay the race actually arms, and that the losing timer is cleared.
    // Provision BEFORE the patch: the store's lock retry and the driver both
    // arm timers of their own, and any one of them landing in `armed` would
    // make the single-30s-timer assertion below pass or fail for reasons that
    // have nothing to do with the status timeout under test.
    await provisionAdmittedRun(driver, store, { runId: "default-timeout-run" });
    // The driver's real answer, taken before the patch goes in, so the GATED
    // driver used below does no I/O of its own inside the observation window.
    const boxes = await driver.list();
    let release!: (vms: ProviderVm[]) => void;
    const gate = new Promise<ProviderVm[]>((resolve) => {
      release = resolve;
    });
    const gated = { list: (): Promise<ProviderVm[]> => gate };

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed: { ms: unknown; handle: unknown }[] = [];
    const cleared: unknown[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      armed.push({ ms, handle });
      return handle;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle: unknown) => {
      cleared.push(handle);
      (realClearTimeout as (...a: unknown[]) => void)(handle);
    }) as unknown as typeof globalThis.clearTimeout;

    let rows: StatusRow[];
    let timer: { ms: unknown; handle: unknown };
    try {
      // `listWithTimeout` builds `Promise.race([driver.list(name), new
      // Promise(…)])`, and a Promise executor runs SYNCHRONOUSLY — so with a
      // driver that yields nothing of its own, the status timer is armed before
      // this call expression returns. That synchronous window is the whole point:
      // nothing else can arm a timer inside it, so the timer under test is
      // identified by WHEN it was armed rather than by its delay. Deliberate
      // tradeoff: that couples the test to the arm staying synchronous — an
      // implementation that defers it past its first await must re-pin here.
      //
      // Filtering the whole await on `ms === 30_000` was the alternative, and it
      // reds a correct implementation the moment anything else — the runtime, a
      // sibling seam, a future retry loop — arms a 30s timer in that window. A
      // test that gets rerun until green gates nothing at all.
      const pending = statusAll({ driver: gated, store });
      const armedByTheRace = armed.splice(0);
      expect(armedByTheRace).toHaveLength(1);
      timer = armedByTheRace[0]!;
      // The delay the race really arms: `?? 30_000` → `?? 0` (or `?? 1`) makes
      // production report boxUnknown for every run, and every other test in this
      // file injects a timeout, so this is the only place it is observed.
      expect(timer.ms).toBe(30_000);
      release(boxes);
      rows = await pending;
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    // The losing timer is cleared — by HANDLE, so a `clearTimeout` of some other
    // timer cannot stand in for it. Left armed, a 30s handle keeps the event
    // loop alive: `fleet status` printed its rows and then hung for half a minute.
    expect(cleared).toContain(timer.handle);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("live");
  });

  test("a non-positive or non-finite listTimeoutMs is refused, never handed to setTimeout", async () => {
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await refusal(
        statusAll({ driver, store, listTimeoutMs: ms }),
        2,
        "invalid-list-timeout",
      );
      expect(err.message).toContain("positive finite number");
      await refusal(
        statusRun({ driver, store, listTimeoutMs: ms }, "some-run"),
        2,
        "invalid-list-timeout",
      );
    }
  });

  // ─── the ONE deadline across the named lookup and its unfiltered retry ──────
  //
  // These two are a PAIR and only mean anything together: the first proves the
  // retry still happens, the second proves it stops happening once the budget is
  // gone. Either alone is satisfied by a broken implementation — delete the
  // retry entirely and the second still passes; hand each attempt its own full
  // `timeoutMs` and the first still passes.
  //
  // Both assert on the CALLS rather than on wall-clock elapsed. The call log
  // distinguishes the two implementations exactly and never flakes, where a
  // timing threshold tight enough to separate one wait from two would.
  //
  // `toStrictEqual`, NOT `toEqual`, and that is load-bearing: the fallback is
  // invoked as `list(undefined)`, and `toEqual` treats `[runId, undefined]` as
  // equal to `[runId]`. Written with `toEqual` the second test below passes
  // against the very implementation it exists to reject — verified against the
  // pre-fix code, which really does call twice (measured: 91 ms against a 50 ms
  // bound) and really did go green.

  test("a named lookup that ERRORS FAST still gets its unfiltered retry", async () => {
    const runId = "retry-after-fast-error";
    await provisionAdmittedRun(driver, store, { runId });

    const calls: (string | undefined)[] = [];
    const list = (name?: string): Promise<ProviderVm[]> => {
      calls.push(name);
      // The shape the retry was written for: `ls <name>` exiting non-zero for a
      // box that is not there, which the driver surfaces as a THROW and which
      // `listOwnedBoxesOnce` cannot tell from a real list failure. It costs
      // almost none of the budget, so the second look is both affordable and the
      // whole difference between "nothing matched" and "could not be asked".
      if (name !== undefined) return Promise.reject(new Error("ls: no such box"));
      return driver.list();
    };

    const row = await statusRun({ driver: { list }, store, listTimeoutMs: 1_000 }, runId);

    expect(calls).toStrictEqual([runId, undefined]);
    // And the retry is what ANSWERS — a fallback that fired but whose result was
    // dropped would still satisfy the call log above.
    expect(row.state).toBe("live");
  });

  test("a named lookup that EXHAUSTS the budget does not start the fallback", async () => {
    const runId = "no-retry-after-timeout";
    await provisionAdmittedRun(driver, store, { runId });

    const calls: (string | undefined)[] = [];
    const list = (name?: string): Promise<ProviderVm[]> => {
      calls.push(name);
      // Never settles, so the named lookup can only end at the deadline — and
      // the deadline is then already spent.
      return new Promise<ProviderVm[]>(() => {});
    };

    const row = await statusRun({ driver: { list }, store, listTimeoutMs: 50 }, runId);

    // ONE call. A fallback started with a remaining budget of 0 would NOT have
    // rejected immediately: `listWithTimeout` races the driver against
    // `setTimeout(…, 0)`, and a zero-delay timer fires in a LATER timers phase,
    // so a driver resolving before that callback wins the race and pushes the
    // total past `timeoutMs` — the bound this deadline exists to hold.
    //
    // Nothing is lost by not trying. The named lookup timing out means the
    // substrate is wedged, and the fallback is the same call WITHOUT the filter:
    // strictly more work, against the same wedge.
    expect(calls).toStrictEqual([runId]);
    expect(row.state).toBe("boxUnknown");
  });
});

describe("status.ts (statusRun)", () => {
  let dir: string;
  let store: RunRecordStore;
  let driver: FakeDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-status-run-"));
    driver = joinOnlyDriver(join(dir, "boxes"));
    store = new RunRecordStore({ dir: join(dir, "runs") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function provision(runId: string, patch?: RunRecordPatch): Promise<RunRecord> {
    const { record } = await provisionAdmittedRun(driver, store, { runId });
    return patch === undefined ? record : store.set(runId, patch);
  }

  test("valid runId returns a single live row carrying the record's join key", async () => {
    const runId = "test-single-run";
    const rec = await provision(runId, { requestId: "req-single" });

    const row: StatusRow = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("live");
    expect(row.vmName).toBe(rec.vmName);
    expect(row.requestId).toBe("req-single");
  });

  test("a hyphenated id at the 63-char cap is accepted", async () => {
    // The one literal in the file. Every other reference to the boundary is
    // RUN_ID_MAX itself, so widening the constant to 253 kept this test green
    // while it still claimed to pin 63 — and the id becomes the box name, which
    // becomes a public hostname, where an RFC 1123 label caps at 63. A wider cap
    // mints unresolvable hostnames.
    expect(RUN_ID_MAX).toBe(63);
    const runId = `max-${"a".repeat(RUN_ID_MAX - 4)}`;
    expect(runId).toHaveLength(RUN_ID_MAX);
    await provision(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("live");
  });

  test("runId validation refuses as typed exit 2, on the canonical grammar and cap", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    // Grammar: uppercase, whitespace, path traversal, a leading hyphen, empty.
    for (const bad of ["INVALID_ID", "with spaces", "../escape", "-leading", "", "under_score"]) {
      await refusal(statusRun(deps, bad), 2, "invalid-run-id");
    }
    // The cap now comes from run-record.ts, not a private copy that allowed
    // any length: 63 passes (above), 64 must refuse as usage, not as a store error.
    const err = await refusal(statusRun(deps, "a".repeat(RUN_ID_MAX + 1)), 2, "invalid-run-id");
    expect(err.message).toContain(String(RUN_ID_MAX));
  });

  test("a non-string runId is refused by the typeof guard, not by the regex", async () => {
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    // Every one of these COERCES to a string the grammar accepts ("null",
    // "undefined", "123"), so only the typeof guard can refuse them.
    for (const bad of [null, undefined, 123]) {
      await refusal(statusRun(deps, bad as unknown as string), 2, "invalid-run-id");
    }
  });

  test("an id that ends in a hyphen is refused as usage, never passed to the store", async () => {
    // RUN_ID_RE is `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` — an RFC 1123 label, since
    // the id becomes the box name and the box name becomes a public hostname.
    // A stale private copy (`^[a-z0-9][a-z0-9-]*$`) accepts all of these and
    // reaches the store as run-not-found (4); the canonical grammar refuses at 2.
    const deps: StatusDeps = { driver, store, listTimeoutMs: 1000 };
    for (const bad of ["trailing-", "a--", "-", "--"]) {
      await refusal(statusRun(deps, bad), 2, "invalid-run-id");
    }
  });

  test("interior hyphens stay legal — the minted id shape still resolves", async () => {
    // The tightening must not over-reject: `qds-<YYYYMMDD>-<6 hex>` is what
    // mintRunId() produces for every real run.
    const runId = "qds-20260821-a1b2c3";
    await provision(runId);
    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("live");
  });

  test("ENOENT → exit 4 with operator-facing content, mutating nothing", async () => {
    await provision("bystander-run");
    const before = store.list();
    const listSpy = mock((name?: string) => driver.list(name));

    const err = await refusal(
      statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, "nonexistent-run"),
      4,
      "run-not-found",
    );
    // Content, not key presence: toHaveProperty("message") passes for "".
    expect(err.message).toContain("nonexistent-run");
    expect(err.remediation).toContain("run ID");
    // Mutates NOTHING when not found: the record store is untouched. The driver
    // IS consulted — reading the substrate is not a mutation, and it is the
    // only way to tell "no such run" from "a box nobody has a record for".
    expect(store.list()).toEqual(before);
    expect(listSpy).toHaveBeenCalledWith("nonexistent-run");
  });

  test("no record but a LIVE box under the run id → orphan, never exit 4", async () => {
    // The record and the box are separately losable (operator record cleanup, a
    // --dir mismatch between dispatch and this query, the INV-1 crash window).
    // `statusAll` already calls this box `orphan`; the id-specific query denying
    // it exists is the operator being told a box that is alive and SPENDING is
    // not there — the unattributed spend this verb exists to surface.
    const runId = "recordless-but-billing";
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("orphan");
    // The BOX name is the assertion that matters — it is what teardown targets.
    // The row id is parenthesised (never the bare name) even here, where the
    // caller handed us a legal run id: the row still describes a box no record
    // claims, and `fleet teardown <that id>` has no record to act on.
    expect(row.vmName).toBe(runId);
    expect(row.runId).toBe(`(orphan ${runId})`);
    expect(RUN_ID_RE.test(row.runId)).toBe(false);
    expect(row).not.toHaveProperty("createdAt");
    expect(row).not.toHaveProperty("requestId");
    // And the same id through the fleet-wide verb agrees — one shared row shape.
    const rows = await statusAll({ driver, store, listTimeoutMs: 1000 });
    expect(rows).toEqual([row]);
  });

  test("T1-4: an ENOENT orphan row carries skippedRecords when the listing skipped files", async () => {
    // status.ts's orphan arm spreads `skippedRecords` onto the row — a mangled
    // `.json` stem may be THIS run's renamed record, and an orphan verdict that
    // hides a possible record for the same id contradicts itself. Deleting that
    // spread passed every other orphan case (they plant no skipped files), so
    // it is pinned here: same shape as the fleet-level recordsSkipped row, on
    // THE row whose existence the caveat is about.
    const runId = "orphan-with-skipped";
    await driver.create(runId, SBX_OWNERSHIP_TAG);
    // A real store: the skipping happens inside `listWithAnomalies`, so the
    // fixture must plant a genuinely grammar-violating stem.
    writeFileSync(join(store.dir, "NOT_A_RUN_ID.json"), '{"runId":"NOT_A_RUN_ID"}\n');

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("orphan");
    expect(row.skippedRecords).toEqual(["NOT_A_RUN_ID.json"]);

    // …and the caveat rides out sanitized, like the fleet-level row's copy:
    // `safeName` strips control characters from substrate-supplied text before
    // it reaches the operator stream.
    expect(row.skippedRecords?.join("")).not.toMatch(/[\r\n\t]/);

    // No skipped files → no key at all (an orphan over a clean listing must not
    // grow an empty-array `skippedRecords` that renderers would print as "0").
    rmSync(join(store.dir, "NOT_A_RUN_ID.json"));
    await driver.destroy(runId);
    await driver.create(runId, SBX_OWNERSHIP_TAG);
    const cleanRow = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(cleanRow.state).toBe("orphan");
    expect(cleanRow).not.toHaveProperty("skippedRecords");
  });

  test("a list failure on the ENOENT path still refuses as 4, never invents a box", async () => {
    // boxUnknown needs a record to hang off. With neither a record nor a usable
    // list there is nothing to report, and a timeout must not be read as a hit.
    for (const failing of [
      { list: async (): Promise<ProviderVm[]> => { throw new Error("list down"); } },
      { list: (): Promise<ProviderVm[]> => new Promise<ProviderVm[]>(() => {}) },
    ]) {
      const err = await refusal(
        statusRun({ driver: failing, store, listTimeoutMs: 5 }, "gone-run"),
        4,
        "run-not-found",
      );
      // The unaskable-substrate arm: whether a live box answers to this id
      // cannot be ruled out, so the remediation may never say "create the run".
      expect(err.remediation).toContain("could not be listed");
    }
  });

  test("no record and a FOREIGN box under the run id → still exit 4", async () => {
    // The ownership filter runs on this path too: somebody else's box named
    // after our run id is not our spend and must not be reported as our orphan.
    const runId = "foreign-collision";
    await driver.create(runId, SBX_OWNERSHIP_TAG);
    await refusal(
      statusRun({ driver: retagged(driver, "someone-elses-fleet"), store, listTimeoutMs: 1000 }, runId),
      4,
      "run-not-found",
    );
  });

  test("found record uses the same join logic (no vmName, no box → boxMissing)", async () => {
    const runId = "test-join-logic";
    store.create(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.runId).toBe(runId);
    expect(row.state).toBe("boxMissing");
  });

  test("vmName set but the box is gone → boxMissing", async () => {
    const runId = "single-missing-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("boxMissing");
    expect(row.vmName).toBe(rec.vmName);
  });

  test("list throws → boxUnknown for the single run too", async () => {
    const runId = "single-unknown-throw";
    await provision(runId);

    const row = await statusRun(
      {
        driver: {
          list: async (): Promise<ProviderVm[]> => {
            throw new Error("list unavailable");
          },
        },
        store,
        listTimeoutMs: 1000,
      },
      runId,
    );
    expect(row.state).toBe("boxUnknown");
  });

  test("list hangs past the timeout → boxUnknown for the single run too", async () => {
    const runId = "single-unknown-timeout";
    await provision(runId);

    const row = await statusRun(
      { driver: { list: () => new Promise<ProviderVm[]>(() => {}) }, store, listTimeoutMs: 5 },
      runId,
    );
    expect(row.state).toBe("boxUnknown");
  });

  test("a record whose box carries another name is listed UNFILTERED, and reads live", async () => {
    // The filter branch: `list(runId)` cannot see a box that is not named after
    // the run, so hardcoding `rec.runId` there reports boxMissing while the box
    // bills on — and no test constructed the join, because provisioning always
    // names the box after the run.
    const runId = "single-renamed-box";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    await driver.create("some-other-box-name", SBX_OWNERSHIP_TAG);
    store.set(runId, { vmName: "some-other-box-name" });

    const listSpy = mock((name?: string) => driver.list(name));
    const row = await statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, runId);

    expect(listSpy).toHaveBeenCalledWith(undefined); // the whole fleet, not one name
    expect(row.state).toBe("live");
    expect(row.vmName).toBe("some-other-box-name");
  });

  test("crash window: no vmName but a live box under the run id → live", async () => {
    const runId = "single-crash-window";
    store.create(runId);
    await driver.create(runId, SBX_OWNERSHIP_TAG);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("live");
    expect(row.vmName).toBe(runId);
  });

  test("closed record over a LIVE box → closed + boxAlive, driver consulted", async () => {
    // A closed record no longer short-circuits the driver: teardown destroys
    // before it closes, so a live box here is one that never got destroyed.
    const runId = "test-closed-single";
    await provision(runId);
    store.close(runId);

    const listSpy = mock((name?: string) => driver.list(name));
    const row = await statusRun({ driver: { list: listSpy }, store, listTimeoutMs: 1000 }, runId);

    expect(row.state).toBe("closed");
    expect(row.runId).toBe(runId);
    expect(row.boxAlive).toBe(true);
    // WITH the run id: when the two candidate names agree, the driver's own name
    // filter is used rather than paging the whole fleet. `toHaveBeenCalled()`
    // alone could not tell that apart from an unfiltered list.
    expect(listSpy).toHaveBeenCalledWith(runId);
  });

  test("closed record whose box is gone → closed with boxAlive FALSE (the driver answered)", async () => {
    const runId = "test-closed-destroyed";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const row = await statusRun({ driver, store, listTimeoutMs: 1000 }, runId);
    expect(row.state).toBe("closed");
    expect(row.boxAlive).toBe(false);
  });

  test("closed record + list failure → closed with boxAlive ABSENT (nothing is known)", async () => {
    const runId = "test-closed-listdown";
    const rec = await provision(runId);
    await driver.destroy(rec.vmName!);
    store.close(runId);

    const row = await statusRun(
      {
        driver: {
          list: async (): Promise<ProviderVm[]> => {
            throw new Error("list down");
          },
        },
        store,
        listTimeoutMs: 1000,
      },
      runId,
    );
    expect(row.state).toBe("closed");
    expect(row).not.toHaveProperty("boxAlive");
  });

  test("a CORRUPT record refuses as a typed exit-1, never a raw rethrow", async () => {
    // `readRecord` throws a bare `Error("malformed run record …")` with no
    // `code`, so the old `throw e` escaped untyped and `report()` printed a
    // stack dump. Every sibling path types this: statusAll's
    // record-store-unreadable, harvest/teardown's record-read-failed.
    const runId = "test-corrupt-record";
    store.create(runId); // record only — no box, so the driver has nothing to add
    writeFileSync(join(dir, "runs", `${runId}.json`), "{ not json");

    const err = await refusal(statusRun({ driver, store, listTimeoutMs: 1000 }, runId), 1, "record-read-failed");
    expect(err.message).toContain(runId);
    // NOT `orphan`: a record exists, so the box is claimed and an orphan row
    // would report exit 0 while denying the corruption the operator must fix.
    expect(err.remediation).not.toMatch(/STILL LIVE/);
  });

  test("a corrupt record over a LIVE box says so — the box is billing and undiscoverable otherwise", async () => {
    // The second loss the raw rethrow caused: the driver was never consulted, so
    // the box that record owns stayed invisible on the one query an operator
    // types when they already know the run id.
    const runId = "test-corrupt-live";
    await provision(runId); // a REAL box, named after the run id
    writeFileSync(join(dir, "runs", `${runId}.json`), "{ not json");

    const err = await refusal(statusRun({ driver, store, listTimeoutMs: 1000 }, runId), 1, "record-read-failed");
    expect(err.remediation).toContain(runId);
    expect(err.remediation).toMatch(/STILL LIVE/);
  });
});
