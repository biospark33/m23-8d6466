/**
 * DF3.4 W5b: the `approve` / `reject` / `attach` verb blocks in scripts/fleet.ts.
 *
 * These test the WIRING, not the machinery behind it: the gate's state machine
 * has its own suite (tests/fleet/approval-gate.test.ts), the allowlist has
 * tests/fleet/approvers.test.ts and `attachToRun` has tests/fleet/attach.test.ts.
 * What is only testable here is what the CLI adds — flag grammar, the
 * two-store/probe order, which outcome becomes which exit code, and the rule
 * that a refusal mutates nothing.
 *
 * Coverage lives in this file rather than tests/fleet/cli.test.ts because that
 * file is mid-edit by another wave.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { run, type FleetDeps } from "../../scripts/fleet.ts";
import { listVerbs } from "../../src/fleet/verbs.ts";
import { scryptToken, SCRYPT_PARAMS, authenticateApprover } from "../../src/fleet/approvers.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { requestApproval } from "../../src/fleet/approval-gate.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun } from "../../src/providers/driver.ts";
import type { ProviderDriver } from "../../src/providers/driver.ts";

const SHA = "a".repeat(40);
const RUN = "qds-20260828-aaa111";

let dir: string;
let store: RunRecordStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-gate-verbs-"));
  store = new RunRecordStore({ dir });
  authCalls = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** stdout + stderr captured separately — stdout is OUTPUT, stderr diagnostics. */
function streams(): { out: string[]; err: string[]; sink: (s: string) => void; errSink: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: (s) => out.push(s), errSink: (s) => err.push(s) };
}

const envelopes = (err: string[]): Array<Record<string, unknown>> =>
  err
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Every `(hostRoot, approverId)` pair the CLI really handed `authenticate`. */
let authCalls: Array<[string, string]> = [];

/**
 * An authenticated approver, injected — the token itself never enters a test.
 *
 * It TAKES ITS ARGUMENTS, and that is the whole point. The previous fixture was
 * `async () => ({ok: true, approverId})` — a zero-parameter closure returning
 * its own default — so `expect(printed).toMatchObject({approverId: "alice"})`
 * asserted a value THIS FILE supplied, never one that travelled through the CLI.
 * Swapping the call site's argument order, or passing `""` or the runId in place
 * of the parsed `--approver`, left every case in this file green while
 * production authenticated the wrong approver against the wrong host root.
 * Recording the call and DERIVING the returned id from the argument makes both
 * observable.
 */
const authOk = (): Partial<FleetDeps> => ({
  authenticate: async (hostRoot, approverId) => {
    authCalls.push([hostRoot, approverId]);
    return { ok: true, approverId };
  },
});

/** A sentinel with no legitimate reason to appear in any output. */
const NEEDLE = "s3cr3t-needle-9f3a";

/**
 * The auth double that answers, plus a SPY on whether a driver was ever
 * resolved. `approve` must reach no box, so a default driver resolution — or
 * any driver primitive at all — is the regression; the Proxy records the touch
 * and rethrows, so a probe that does reach it fails loudly instead of silently
 * succeeding against a driver nobody asked for.
 */
const authOkNoDriver = (): Partial<FleetDeps> => ({
  ...authOk(),
  driver: new Proxy({} as ProviderDriver, {
    get: (_t, prop) => {
      throw new Error(`approve touched driver.${String(prop)} — it must reach no box`);
    },
  }),
});

const authRefused: Partial<FleetDeps> = {
  authenticate: async () => ({
    ok: false,
    refusal: { code: "approver-token-mismatch", message: "the token does not match", remediation: "pipe the right token" },
  }),
};

/** The auth refusal, over a caller-supplied store — for arms that need a
 *  store's read to fail BEFORE authentication answers. */
const authRefusedWith = (over: Partial<FleetDeps>): Partial<FleetDeps> => ({ ...authRefused, ...over });

/** The auth success, over a caller-supplied store — for arms that need a
 *  store's read to fail AFTER authentication answers (the CLI reports those
 *  only once the caller is authenticated). */
const authOkWith = (over: Partial<FleetDeps>): Partial<FleetDeps> => ({ ...authOk(), ...over });

/**
 * A store double whose reads fail. Prototype delegation, not a reimplementation:
 * everything but `get` stays real.
 *
 * ASSUMPTION, now stated at the one place it lives: `get` is the only read seam
 * the CLI takes, and no store method routes an internal read through
 * `this.get`. If either breaks, the failure moves to a call site the comments
 * do not name — which is exactly what the per-site `reads === n` counters are
 * for: they make the double's OWN call count visible next to the assertion.
 *
 * - `failingStore`: EVERY read throws. For arms that classify on the first
 *   read (`assertRunExists` → `record-read-failed`).
 * - `storeFailingOnNthRead(store, 2)`: the first read succeeds, the Nth throws.
 *   For the verbs' SECOND read (the bound-pair / dispatch-id read that follows
 *   the existence probe) — the only route an unclassified throw has to exit 1.
 */
function failingStore(base: RunRecordStore, message: string): RunRecordStore {
  return Object.assign(Object.create(base) as RunRecordStore, {
    get() {
      throw new Error(message);
    },
  });
}

function storeFailingOnNthRead(base: RunRecordStore, n: number, message: string): RunRecordStore {
  let reads = 0;
  return Object.assign(Object.create(base) as RunRecordStore, {
    get(id: string) {
      const rec = base.get(id);
      if (++reads === n) throw new Error(message);
      return rec;
    },
  });
}

async function paused(reportId = "rv-1"): Promise<void> {
  store.create(RUN);
  await requestApproval({ store }, RUN, { proposal: "open a PR", reportId, headSha: SHA });
  stageBundle();
}

/**
 * Stage the harvested bundle the decide path now REQUIRES (round-9 V1: the
 * CLI wires `bundleDir` into `submitDecision`, so a decision over a missing
 * bundle refuses). Every fixture that means to REACH a decision stages one;
 * `writeFileSync(join(dir, `${RUN}.bundle`), …)` beside the record. Fixtures
 * that mean to refuse BEFORE the bundle check need no staging.
 */
function stageBundle(): void {
  fs.writeFileSync(path.join(dir, `${RUN}.bundle`), "bundle-bytes");
}

describe("fleet approve / reject — grammar and the driver exemption", () => {
  test("approve takes NO --driver: it never reaches a box", async () => {
    await paused();
    const s = streams();
    // A driver-primitive PROXY behind the auth double: any `get` on it throws,
    // so a CLI that resolved or defaulted a driver and probed a box fails
    // loudly here instead of passing green through a code-0 assertion alone.
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOkNoDriver(), s.errSink);
    // `rank`'s precedent. A --driver requirement here would be a flag nothing
    // consumes, and the registry declares none.
    expect(code).toBe(0);
    // The registry really does withhold it — the pair of assertions is what
    // makes the refusal below a decision rather than a coincidence.
    expect(listVerbs().find((v) => v.verb === "approve")?.flags.map((f) => f.name)).not.toContain("--driver");
  });

  test("approve REFUSES --driver, because the registry declares none", async () => {
    await paused();
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--driver", "fake", "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(2);
    expect(envelopes(s.err)[0]?.message).toMatch(/does not take --driver/);
  });

  test.each([["approve"], ["reject"]])("%s without --approver is a usage refusal", async (verb) => {
    await paused();
    const s = streams();
    const code = await run([verb, RUN, "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(2);
    expect(envelopes(s.err)[0]?.message).toMatch(/--approver/);
  });

  test.each([["approve"], ["reject"]])("%s with no <run-id> is a usage refusal", async (verb) => {
    const s = streams();
    const code = await run([verb, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(2);
    // WHICH guard fired: the sibling grammar refusals (a flag the verb does not
    // take, a malformed id) share the exit code, so the envelope is what makes
    // this the missing-positional refusal and not one of those.
    const envelope = envelopes(s.err)[0] as { message: string };
    expect(envelope.message).toMatch(new RegExp(`^${verb} requires <run-id>$`));
    // A refusal reports no decision, and nothing was mutated.
    expect(fs.existsSync(path.join(dir, `${RUN}.json`))).toBe(false);
  });

  test.each([
    // Refused one layer apart, and both are exit 2 naming the flag. `""` never
    // gets past the value grammar; `"   "` does, and is caught by the verb's own
    // trim — the arm a naive `=== undefined` presence check misses.
    ["", /--approver requires a non-empty value/],
    ["   ", /approve requires --approver/],
  ] as Array<[string, RegExp]>)(
    "--approver %p is a USAGE refusal naming the flag, not an allowlist refusal",
    async (approver, want) => {
      // `--approver "$APPROVER"` with APPROVER unset is how this actually
      // happens. It used to pass the presence check and reach the allowlist,
      // which refused it as exit 5 "check the token / the allowlist" with a
      // blank subject — the wrong half of the fix. An empty flag VALUE is a
      // wrong invocation: exit 2, naming the flag.
      await paused();
      const s = streams();
      const code = await run(["approve", RUN, "--approver", approver, "--dir", dir], s.sink, authOk(), s.errSink);
      expect(code).toBe(2);
      expect(envelopes(s.err)[0]?.message).toMatch(want);
      // …and it never reached authentication, so no allowlist was read.
      expect(authCalls).toEqual([]);
      // Nothing was decided either — the run is still awaiting an approver.
      expect(store.get(RUN).extensions?.approval?.state).toBe("awaiting-approval");
    },
  );

  test("a malformed run id is refused by the ID GRAMMAR, ahead of the --dir probe", async () => {
    const s = streams();
    const missing = path.join(dir, "nope");
    const code = await run(["approve", "NOT A RUN ID", "--approver", "alice", "--dir", missing], s.sink, authOk(), s.errSink);
    expect(code).toBe(2);
    // WHICH guard fired, not just that one did. Both guards return 2 and
    // neither creates the directory, so `code === 2 && !existsSync(missing)`
    // is satisfied identically by the --dir refusal — the sibling case below
    // proves that with a VALID run id. The envelope naming the id is the only
    // thing that observes the ordering this case is named for.
    const envelope = envelopes(s.err)[0] as { message: string };
    expect(envelope.message).toContain("NOT A RUN ID");
    expect(envelope.message).not.toContain("--dir");
    expect(fs.existsSync(missing)).toBe(false);
  });

  test("a nonexistent --dir is exit 2 and is NOT created", async () => {
    const s = streams();
    const missing = path.join(dir, "no-such-dir");
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", missing], s.sink, authOk(), s.errSink);
    expect(code).toBe(2);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test("an unknown run is exit 4 having mutated nothing", async () => {
    const s = streams();
    const code = await run(["approve", "qds-20260828-bbb222", "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(4);
    expect(envelopes(s.err)[0]?.code).toBe("run-not-found");
  });
});

describe("fleet approve / reject — authentication (INV-CRED-3)", () => {
  test("a refused token is exit 5 and the record is untouched", async () => {
    await paused();
    const before = fs.readFileSync(store.path(RUN), "utf8");
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "mallory", "--dir", dir], s.sink, authRefused, s.errSink);

    // 5, not 2: 2's remediation is the flag list, which is not the remediation
    // for a bad token. Nothing was mutated, and a guard named which.
    expect(code).toBe(5);
    expect(envelopes(s.err)[0]?.code).toBe("approver-token-mismatch");
    expect(fs.readFileSync(store.path(RUN), "utf8")).toBe(before);
  });

  test("authentication runs BEFORE the decision — a refused approver decides nothing", async () => {
    await paused();
    const s = streams();
    await run(["approve", RUN, "--approver", "mallory", "--dir", dir], s.sink, authRefused, s.errSink);
    expect(store.get(RUN).extensions?.approval?.state).toBe("awaiting-approval");
  });

  test("authenticate is called with (the --dir root, the parsed --approver) — in that order (round-9 C10 parity)", async () => {
    // The wiring, pinned. Nothing else in this file can see it: every other
    // assertion about `approverId` reads a value that now comes BACK from this
    // fixture, so the order, the root, and the fact that the id is the parsed
    // flag rather than the run id are only observable here. Swap the two
    // arguments at the call site and production authenticates the approver
    // "/some/cwd" against a host root named "alice" — a refusal for everyone,
    // or worse, an allowlist found somewhere unexpected.
    //
    // The ROOT is `--dir` since round-9 C10's two-sided parity: `fleet enrol
    // --dir X` writes the allowlist under X, so `fleet approve --dir X` must
    // authenticate under the SAME root — an approve that resolved under
    // process.cwd() would split the two halves of one credential store.
    await paused();
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(0);
    expect(authCalls).toEqual([[dir, "alice"]]);
    // Exactly once: a second call would mean the token is read twice.
    expect(authCalls).toHaveLength(1);
    // …and with the flag OMITTED the root falls back to process.cwd(),
    // byte-identical to the pre-parity default. The STORE is injected so the
    // record resolves without the flag — only the auth root is under test.
    // The first approve DECIDED the run, so its record is replaced before the
    // re-pause (create is O_EXCL).
    fs.rmSync(store.path(RUN), { force: true });
    await paused();
    const s2 = streams();
    expect(await run(["approve", RUN, "--approver", "alice"], s2.sink, { ...authOk(), store }, s2.errSink)).toBe(0);
    expect(authCalls).toEqual([
      [dir, "alice"],
      [process.cwd(), "alice"],
    ]);
  });

  test("the id the CLI PRINTS is the one authentication returned, not the one on argv", async () => {
    // The two are equal in the happy path, which is why the old fixture could
    // hide the difference. `submitDecision` records `auth.approverId` — the
    // ALLOWLIST's canonical id — and an allowlist is entitled to canonicalize
    // (case, whitespace, an alias). If the CLI recorded the argv string instead,
    // the attribution trail would name something the allowlist never blessed.
    await paused();
    const s = streams();
    const canonical: Partial<FleetDeps> = {
      authenticate: async (hostRoot, approverId) => {
        authCalls.push([hostRoot, approverId]);
        return { ok: true, approverId: `canonical:${approverId}` };
      },
    };
    const code = await run(["approve", RUN, "--approver", "Alice", "--dir", dir], s.sink, canonical, s.errSink);
    expect(code).toBe(0);
    expect(authCalls).toEqual([[dir, "Alice"]]);
    expect(JSON.parse(s.out.join("").trim())).toMatchObject({ approverId: "canonical:Alice" });
    expect(store.get(RUN).extensions?.approval?.approverId).toBe("canonical:Alice");
  });

  test("a secret riding back on the auth result never reaches stdout, stderr or a log line", async () => {
    // A PLANTED needle. The old case ran with no token-shaped string anywhere in
    // the invocation, so `not.toMatch(/token/i)` proved nothing about redaction —
    // it proved only that the word "token" is not in the CLI's vocabulary.
    //
    // This double returns the credential alongside the contract fields, which is
    // exactly what an `authenticate` that carried the token back would look like.
    // The CLI must read `approverId` off it and NOTHING else: a `...auth` spread
    // into the decision line, a `gateEvent` field — the same bug class the
    // attach block's "spelled out rather than spread" comment guards against —
    // or the STORED decision record puts the needle straight into an operator's
    // scrollback, their log sink, or the on-disk run record.
    await paused();
    const leaky: Partial<FleetDeps> = {
      authenticate: async (_hostRoot, approverId) =>
        ({ ok: true, approverId, token: NEEDLE, tokenHash: NEEDLE }) as unknown as Awaited<
          ReturnType<NonNullable<FleetDeps["authenticate"]>>
        >,
    };
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    const s = streams();
    try {
      expect(await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, leaky, s.errSink)).toBe(0);
    } finally {
      restore();
    }
    // The PERSISTED record is a scanned surface too: a spread that landed the
    // needle in the stored decision would leak it to disk with stdout, stderr
    // and the log stream all clean.
    const scanned = s.out.join("") + s.err.join("") + JSON.stringify(entries) + fs.readFileSync(store.path(RUN), "utf8");
    expect(scanned).not.toContain(NEEDLE);
    // The generic SHAPE of the leak this test exists for: a `...auth` spread
    // writes `"token"`/`"tokenHash"` as a KEY. That key shape is what is
    // forbidden — the bare WORD is not, because a refusal remediation ("pipe
    // the token on stdin") or a future prose field legitimately carries it and
    // would turn a prose match into a false red with no leak present. This is
    // a SUCCESS path, so no refusal text reaches any surface here at all; the
    // needle above is the assertion a real credential-shaped leak fails.
    expect(scanned).not.toMatch(/"token[a-z0-9_]*"\s*:/i);
    // The scan DID reach real output — not an empty string that vacuously
    // contains nothing.
    expect(scanned).toContain("alice");
    expect(scanned.length).toBeGreaterThan(50);
  });

  test("POSITIVE CONTROL: the same scan finds the needle when it IS echoed", async () => {
    // Without this, `not.toContain(NEEDLE)` above is satisfied by a scan that
    // looks in the wrong place — a stdout sink that never fired, a log sink that
    // was never installed. `--reason` is argv the CLI echoes BY DESIGN, so
    // planting the needle there proves the scan sees stdout, stderr and the log
    // stream that the negative case claims are clean.
    await paused();
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    const s = streams();
    try {
      await run(["approve", RUN, "--approver", "alice", "--reason", NEEDLE, "--dir", dir], s.sink, authOk(), s.errSink);
    } finally {
      restore();
    }
    // Reason is echoed on the already-decided path; assert on the record, which
    // is where this invocation's reason demonstrably landed, plus the store's
    // own bytes — the channel the negative scan above now covers EXPLICITLY
    // (it used to claim this coverage "by construction" while never reading
    // the file).
    expect(store.get(RUN).extensions?.approval?.reason).toBe(NEEDLE);
    expect(fs.readFileSync(store.path(RUN), "utf8")).toContain(NEEDLE);
    // …and a SECOND invocation prints the first decision back, needle and all:
    // that stdout line is the very stream the negative case scans.
    const s2 = streams();
    await run(["reject", RUN, "--approver", "bob", "--reason", "second", "--dir", dir], s2.sink, authOk(), s2.errSink);
    expect(s2.out.join("")).toContain(NEEDLE);
    // The LOG channel controlled too: the gate event carries the same reason
    // the line beside it does, so the sink the negative case installed must be
    // one that receives — not one that silently no-ops.
    expect(JSON.stringify(entries)).toContain(NEEDLE);
  });

  test("POSITIVE CONTROL: stderr is a live channel the scan concatenates", async () => {
    // The negative scan concatenates stderr, and stderr carries no argv echo on
    // a SUCCESSFUL approve — so a scan whose err component was permanently
    // empty would still pass, and the one channel refusals travel would be
    // uncontrolled. A store read that THROWS with the needle rides the verb's
    // unclassified-throw arm (`report()`'s redacted message) onto stderr
    // through the same printError path a leaked credential would take. The
    // auth double answers OK deliberately: the read failure is REPORTED only
    // after authentication (the enumerate-runs ordering), so a refused token
    // returns before it and the channel would stay empty.
    store.create(RUN);
    const flaky = failingStore(store, NEEDLE);
    const s = streams();
    await run(["approve", RUN, "--approver", "mallory", "--dir", dir], s.sink, authOkWith({ store: flaky }), s.errSink);
    expect(s.err.join("")).toContain(NEEDLE);
  });

  test("the auth-refusal gate event logs NO record state — \"unknown\" for every fixture (round-9 V3)", async () => {
    // The arm PREVIOUSLY echoed what the pre-auth read found ("absent",
    // "pausing", "awaiting-approval" below) — the test then pinned exactly
    // that echo. The echo was the defect: a caller holding no valid token can
    // provoke this event for ANY run id, and an observed state answers "did
    // this id reach the gate?" — an enumeration oracle. The state is now the
    // constant "unknown" whatever the record holds, and the real state stays
    // observable only on the POST-auth arms (`outcome.state` from
    // `submitDecision`'s answer). The three-fixture loop is kept, flipped from
    // "each sees its own state" to "all three see the same redaction" — a
    // constant now passes every one of them, which is the pin.
    const seen: Array<unknown> = [];
    for (const setup of [
      // Each arm owns its whole record, so the loop starts from nothing.
      async () => void store.create(RUN),
      async () => {
        store.create(RUN);
        await store.set(RUN, { extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-1", headSha: SHA } } });
      },
      paused,
    ] as Array<() => Promise<void>>) {
      fs.rmSync(store.path(RUN), { force: true });
      await setup();
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => entries.push(e));
      const s = streams();
      try {
        expect(await run(["approve", RUN, "--approver", "mallory", "--dir", dir], s.sink, authRefused, s.errSink)).toBe(5);
      } finally {
        restore();
      }
      const refused = entries.find((e) => e.event === "refused") as LogEntry;
      seen.push(refused.state);
      // The same redaction on every fixture, whatever the record says.
      expect(refused.state).toBe("unknown");
    }
    // The aggregate cannot re-assert a value (every member is the same
    // constant, and the per-fixture check above already pinned it) — so it
    // pins only what it CAN: that the loop really covered three record shapes
    // and was not silently shrunk to one.
    expect(seen).toHaveLength(3);
  });

  test("a FAILED record read logs state \"unknown\", never the observation \"absent\" (F5.38)", async () => {
    // The default rode `"absent"` — `submitDecision`'s word for a record read
    // that SUCCEEDED and found no approval namespace. A read that THREW
    // observed nothing, and logging `"absent"` there re-asserted a fact about
    // a record nobody read: the same claim-not-observation defect the test
    // above exists to catch, one default earlier.
    store.create(RUN);
    // EVERY read fails, so `assertRunExists` classifies it `record-read-failed`
    // (exit 5) before authentication — and the auth-refusal arm logs the state
    // it never observed.
    const flaky = failingStore(store, "record store on fire");
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    const s = streams();
    try {
      expect(await run(["approve", RUN, "--approver", "mallory", "--dir", dir], s.sink, authRefusedWith({ store: flaky }), s.errSink)).toBe(5);
    } finally {
      restore();
    }
    const refused = entries.find((e) => e.event === "refused") as LogEntry;
    expect(refused.state).toBe("unknown");
  });
});

describe("fleet approve / reject — DecisionOutcome → exit code", () => {
  test("approve records the decision, prints it, and exits 0", async () => {
    await paused();
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--reason", "ship it", "--dir", dir], s.sink, authOk(), s.errSink);

    expect(code).toBe(0);
    const printed = JSON.parse(s.out.join("").trim()) as Record<string, unknown>;
    // V3: `toEqual`, not `toMatchObject`. The loose form passes with ANY extra
    // key — which is exactly the leak class this line must not grow (a token
    // under a novel key, an unredacted field) — so the successful decision line
    // is pinned to its exact key set. `decidedAt` is the one value this test
    // cannot spell (the decision's own timestamp); the two checks below pin
    // that it is the ISO string the record's stamp is.
    expect(printed).toEqual({
      runId: RUN,
      outcome: "decided",
      state: "approved",
      approverId: "alice",
      decidedAt: printed.decidedAt as string,
      reason: "ship it",
    });
    expect(typeof printed.decidedAt).toBe("string");
    expect(Number.isNaN(Date.parse(printed.decidedAt as string))).toBe(false);
    const ext = store.get(RUN).extensions?.approval;
    expect(ext?.state).toBe("approved");
    expect(ext?.reason).toBe("ship it");
  });

  test("reject settles the run without a PR", async () => {
    await paused();
    const s = streams();
    const code = await run(["reject", RUN, "--approver", "bob", "--reason", "not yet", "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(0);
    expect(store.get(RUN).extensions?.approval?.state).toBe("rejected");
    // The verb is NAMED for what it must not do: `reject` settles without
    // opening one, so the record may not grow the `pr` namespace
    // (`prUrl`/`prNumber`/`createdAt`) a push would stamp — and the printed
    // line may not carry those keys either.
    const rec = store.get(RUN) as unknown as Record<string, unknown>;
    expect(rec.extensions).not.toHaveProperty("pr");
    expect(rec).not.toHaveProperty("prUrl");
    expect(rec).not.toHaveProperty("prNumber");
    const printed = JSON.parse(s.out.join("").trim()) as Record<string, unknown>;
    expect(printed).not.toHaveProperty("prUrl");
    expect(printed).not.toHaveProperty("prNumber");
  });

  test("a DUPLICATE decision is exit 0 and PRINTS THE FIRST — a success, not a refusal", async () => {
    await paused();
    const s1 = streams();
    await run(["approve", RUN, "--approver", "alice", "--reason", "first", "--dir", dir], s1.sink, authOk(), s1.errSink);
    const before = fs.readFileSync(store.path(RUN), "utf8");

    const s2 = streams();
    const code = await run(["reject", RUN, "--approver", "bob", "--reason", "second", "--dir", dir], s2.sink, authOk(), s2.errSink);

    // AC2: the FIRST decision is returned with no state change. Exit 0 because
    // the operator's intent — "this run is decided" — is satisfied; a refusal
    // code would make automation retry a decision that can never change.
    expect(code).toBe(0);
    expect(JSON.parse(s2.out.join("").trim())).toMatchObject({
      outcome: "already-decided",
      state: "approved",
      approverId: "alice",
      reason: "first",
    });
    expect(fs.readFileSync(store.path(RUN), "utf8")).toBe(before);
  });

  test("a decision RACING a rebind is exit 5 and names the report that displaced it", async () => {
    await paused("rv-1");
    const s = streams();
    // The registry declares no --report-id flag, so the pair the approver is
    // acting against is the one the verb reads BEFORE authenticating. This
    // rebind lands during that authentication — the exact window the
    // compare-and-set exists for, and the only one the CLI can actually open.
    const racing: Partial<FleetDeps> = {
      authenticate: async () => {
        await requestApproval({ store }, RUN, { proposal: "p", reportId: "rv-2", headSha: "b".repeat(40) });
        return { ok: true, approverId: "alice" };
      },
    };
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, racing, s.errSink);

    expect(code).toBe(5);
    expect(envelopes(s.err)[0]).toMatchObject({ code: "approval-report-changed", reportId: "rv-2" });
    expect(store.get(RUN).extensions?.approval?.state).toBe("awaiting-approval");
  });

  test("a PAUSING run is not decidable — exit 5, nothing mutated", async () => {
    store.create(RUN);
    await store.set(RUN, { extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-1", headSha: SHA } } });
    const before = fs.readFileSync(store.path(RUN), "utf8");
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);

    expect(code).toBe(5);
    expect(envelopes(s.err)[0]).toMatchObject({ code: "approval-not-decidable", state: "pausing" });
    expect(fs.readFileSync(store.path(RUN), "utf8")).toBe(before);
  });

  test("a run with no approval namespace is exit 5, not a crash", async () => {
    store.create(RUN);
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(5);
    expect(envelopes(s.err)[0]).toMatchObject({ code: "approval-not-decidable", state: "absent" });
  });

  test("--reason is capped at 1000 chars — the EXACT truncation, and the verb still succeeds", async () => {
    await paused();
    const s = streams();
    const exact = "x".repeat(5_000);
    const code = await run(
      ["approve", RUN, "--approver", "alice", "--reason", exact, "--dir", dir],
      s.sink,
      authOk(),
      s.errSink,
    );
    // `length <= 1000` alone is satisfied by a reason that was DROPPED or
    // garbled — `String(undefined)` is `"undefined"`, nine characters, and
    // passes — and the old case asserted no exit code either, so a refusal on
    // the long value looked identical to the cap working. Pin both.
    expect(code).toBe(0);
    // The CONTRACT, not `sanitizeLabel`'s output shape: the stored reason is at
    // most MAX_REASON_CHARS units, fills the cap exactly (the input was longer),
    // is a PREFIX of what was typed plus a truncation mark, and is not the
    // nine-char `"undefined"` a dropped value would produce — so a drop, a
    // tighter cap or a refusal is still red, while a legitimate re-derivation
    // of the cut (a different ellipsis width, a repaired surrogate) is not.
    const stored = String(store.get(RUN).extensions?.approval?.reason);
    expect(stored.length).toBeLessThanOrEqual(1_000);
    expect(stored.endsWith("…")).toBe(true);
    expect(exact.startsWith(stored.slice(0, -1))).toBe(true);
    // `sanitizeLabel(text, 1000)` today: 999 units plus one ellipsis, so the
    // result is never longer than the cap. `capText` then finds nothing left to
    // cut, which is precisely why the CLI imports the gate's own constant
    // instead of re-typing a second limit that could truncate to a different
    // length.
    expect(stored).toBe(`${"x".repeat(999)}…`);
  });

  test("--reason at EXACTLY the cap is stored verbatim — no truncation, no off-by-one", async () => {
    // The == boundary is the decision point the 5000-char case cannot see: a
    // `>` flipped to `>=` (or the cap read one low) truncates or refuses a
    // reason that is exactly legal. 1000 chars, all inside the ASCII range so
    // no ellipsis or repair can legitimately alter it.
    await paused();
    const s = streams();
    const exact = "y".repeat(1_000);
    const code = await run(["approve", RUN, "--approver", "alice", "--reason", exact, "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(0);
    expect(store.get(RUN).extensions?.approval?.reason).toBe(exact);
  });

  test("already-decided logs status:\"ok\" — it is the documented idempotent SUCCESS", async () => {
    // A dashboard keyed on `status` alerts on every line that is not "ok", so
    // the set has to be the exit-0 set exactly. This path exits 0 and argues at
    // length that it is a success, and it used to log `status:"error"` — so
    // every duplicate approval paged somebody.
    await paused();
    const s1 = streams();
    await run(["approve", RUN, "--approver", "alice", "--reason", "first", "--dir", dir], s1.sink, authOk(), s1.errSink);

    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    const s2 = streams();
    let code: number;
    try {
      code = await run(["reject", RUN, "--approver", "bob", "--reason", "second", "--dir", dir], s2.sink, authOk(), s2.errSink);
    } finally {
      restore();
    }
    expect(code).toBe(0);
    const line = entries.find((e) => e.event === "reject");
    expect(line).toMatchObject({ outcome: "already-decided", status: "ok" });
  });

  test("the decision line reads outcome.outcome, never the literal its arm is named for", async () => {
    // The `else` is a CATCH-ALL: both refusal arms returned above it, so any
    // future `DecisionOutcome` variant lands here. It used to hardcode
    // `"already-decided"` while `gateEvent` four lines below logged the true
    // value — so a seventh variant would be announced to the operator as a
    // settled decision, exit 0, with the structured log disagreeing beside it.
    await paused();
    const s1 = streams();
    await run(["approve", RUN, "--approver", "alice", "--reason", "first", "--dir", dir], s1.sink, authOk(), s1.errSink);

    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    const s2 = streams();
    try {
      await run(["reject", RUN, "--approver", "bob", "--dir", dir], s2.sink, authOk(), s2.errSink);
    } finally {
      restore();
    }
    // The two streams agree BY CONSTRUCTION, which is the property: same key,
    // same value, one read.
    const printed = JSON.parse(s2.out.join("").trim()) as { outcome: string };
    expect(printed.outcome).toBe(String(entries.find((e) => e.event === "reject")?.outcome));
    expect(printed.outcome).toBe("already-decided");
    //
    // LIMITATION, stated where the gap lives: on `already-decided` — the only
    // outcome this in-process harness can produce past the two refusal arms —
    // both sides above are satisfied by a CLI that hardcodes the literal into
    // each arm separately, so the regression this test is named for (the line
    // and the event disagreeing on a future variant) is only visible as code
    // shape, not as behaviour. So the shape is pinned: BOTH the completion
    // line and the gate event must read `outcome.outcome`, never a literal.
    const source = await fs.promises.readFile(path.join(import.meta.dir, "../../scripts/fleet.ts"), "utf8");
    const decisionBlock = source.slice(source.indexOf("const line ="), source.indexOf("return finish(requestId, verb, runIdArg, printed ? 0 : 6);"));
    expect(decisionBlock).toContain("outcome: outcome.outcome");
    // A literal in either constructed payload would reintroduce the split the
    // field read exists to prevent — no `outcome: "…"` literal may appear in
    // this block at all.
    expect(decisionBlock).not.toMatch(/outcome:\s*"/);
  });

  test.each([["approve"], ["reject"]])(
    "%s: an untyped throw past the existence check is exit 1, not a crash",
    async (verb) => {
      // The verb's only route to exit 1, and the registry declares 1 for both.
      // `assertRunExists` classifies `no-record` (4) and `record-read-failed`
      // (5) and rethrows everything else; a plain Error from the SECOND read —
      // the bound-pair read at fleet.ts:2475, outside `getRecord`'s typed arms —
      // reaches `report()` unclassified, which is exit 1 "the substrate failed,
      // retry". Narrowing the registry to drop 1 would be wrong; this is why.
      await paused();
      const flaky = storeFailingOnNthRead(store, 2, "record store on fire");
      const s = streams();
      const code = await run([verb, RUN, "--approver", "alice", "--dir", dir], s.sink, { ...authOk(), store: flaky }, s.errSink);
      expect(code).toBe(1);
      expect(envelopes(s.err).at(-1)?.message).toContain("record store on fire");
    },
  );

  test.each([["approve"], ["reject"]])(
    "%s: the decision LANDED and its line could not print — exit 6, never a retryable 1",
    async (verb) => {
      // 6 is declared by the registry for both and is asserted nowhere else.
      // The decision is already recorded when `reportCompletion` fires, so a
      // lost line must never be exit 1 "retry me": a retry against a terminal
      // record is a second decision attempt on something that can never change.
      await paused();
      const err: string[] = [];
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => void entries.push(e));
      let code: number;
      try {
        code = await run(
          [verb, RUN, "--approver", "alice", "--dir", dir],
          () => {
            throw new Error("EAGAIN: stdout would block");
          },
          authOk(),
          (s) => void err.push(s),
        );
      } finally {
        restore();
      }
      expect(code).toBe(6);
      expect(envelopes(err).at(-1)?.code).toBe("completion-unwritable");
      // …and the work really did land, which is what makes 6 the honest code.
      expect(store.get(RUN).extensions?.approval?.state).toBe(verb === "approve" ? "approved" : "rejected");
      // The gate event agrees with the exit code: `decided` is in
      // GATE_OK_OUTCOMES, but "ok" ⇔ exit 0 and this invocation exits 6 — the
      // event used to fire before the line's fate was known and claimed "ok".
      const decision = entries.find((e) => e.event === verb);
      expect(decision).toMatchObject({ outcome: "decided", status: "error" });
    },
  );
});

describe("fleet approve — expiry is evaluated BEFORE the decision (AC3)", () => {
  test("an approve arriving after expiresAt finds timed-out and is refused", async () => {
    store.create(RUN);
    await requestApproval({ store, now: () => new Date("2026-01-01T00:00:00.000Z"), timeoutMs: 60_000 }, RUN, {
      proposal: "p",
      reportId: "rv-1",
      headSha: SHA,
    });
    stageBundle();
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);

    // The sweep runs first, so the decision lands against `timed-out` — there
    // is no path from an expired window to `approved`.
    expect(code).toBe(0);
    expect(JSON.parse(s.out.join("").trim())).toMatchObject({ outcome: "already-decided", state: "timed-out" });
    expect(store.get(RUN).extensions?.approval?.approverId).toBe("system:timeout");
  });

  test("an approve landing EXACTLY at expiresAt still decides — the window closes strictly after", async () => {
    // The sweep is exercised above only strictly AFTER expiry, so a `>` flipped
    // to `>=` in the reader timed a run out at the very instant it was still
    // open, and nothing here would have noticed. Driven through the VERB (the
    // gate's own suite pins `expiredState` directly) so the sweep + CAS path an
    // operator's approve actually takes is what proves the boundary.
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    store.create(RUN);
    await requestApproval({ store, now: () => new Date(at), timeoutMs: 60_000 }, RUN, {
      proposal: "p",
      reportId: "rv-1",
      headSha: SHA,
    });
    stageBundle();
    expect(store.get(RUN).extensions?.approval?.expiresAt).toBe(new Date(at + 60_000).toISOString());
    // The gate's clock is `new Date()` (`nowOf`'s no-deps arm) when the verb
    // passes none, so the patch point is the CONSTRUCTOR — a `Date.now` stub
    // would leave `new Date()` reading the wall and the boundary silently
    // missed. Pinned to the exact expiry instant, reached from the open side.
    const RealDate = Date;
    class PinnedDate extends RealDate {
      // A zero-arg `new Date()` is what the gate's clock reads; any explicit
      // argument forwards untouched.
      constructor(value?: number) {
        if (value === undefined) super(at + 60_000);
        else super(value);
      }
      static now(): number {
        return at + 60_000;
      }
    }
    // biome-ignore lint/suspicious/noGlobalAssign: the gate's clock IS `new Date()`
    Date = PinnedDate as unknown as DateConstructor;
    try {
      const s = streams();
      const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
      expect(code).toBe(0);
      expect(JSON.parse(s.out.join("").trim())).toMatchObject({ outcome: "decided", state: "approved", approverId: "alice" });
      expect(store.get(RUN).extensions?.approval?.state).toBe("approved");
    } finally {
      // biome-ignore lint/suspicious/noGlobalAssign: restore
      Date = RealDate;
    }
  });

  test("the expiry emits its OWN timeout gate event, not just a decision line", async () => {
    store.create(RUN);
    await requestApproval({ store, now: () => new Date("2026-01-01T00:00:00.000Z"), timeoutMs: 60_000 }, RUN, {
      proposal: "p",
      reportId: "rv-1",
      headSha: SHA,
    });
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    try {
      const s = streams();
      await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    } finally {
      restore();
    }
    // `submitDecision` would persist the timeout on its own, so the CLI's
    // sweep is redundant for the WRITE — this is what makes it load-bearing:
    // it is the only thing that emits `event: "timeout"`, which the
    // observability contract requires as its own event.
    const timeouts = entries.filter((e) => e.event === "timeout");
    expect(timeouts.length).toBe(1);
    expect(timeouts[0]).toMatchObject({ runId: RUN, outcome: "timed-out", state: "timed-out" });
    expect(typeof timeouts[0]?.expiry_sweep_ms).toBe("number");
  });
});

describe("fleet attach", () => {
  const driver = (): Partial<FleetDeps> => ({ driver: new FakeDriver() });

  // `/run/steering` is root-owned on Linux CI and absent on darwin, so the
  // suite points the real paths at a tmpdir — attach.test.ts's own discipline.
  let priorRoot: string | undefined;
  beforeEach(() => {
    priorRoot = process.env.QDS_STEERING_ROOT;
    process.env.QDS_STEERING_ROOT = path.join(dir, "steering");
  });
  afterEach(() => {
    if (priorRoot === undefined) {
      // Under Bun `process.env.X = undefined` stores the STRING "undefined"
      // and stays truthy — it has to be deleted.
      // biome-ignore lint/performance/noDelete: assignment stores "undefined"
      delete process.env.QDS_STEERING_ROOT;
    } else {
      process.env.QDS_STEERING_ROOT = priorRoot;
    }
  });

  test("attach REQUIRES --driver, refused before any store is built", async () => {
    const missing = path.join(dir, "no-such-dir");
    const s = streams();
    const code = await run(["attach", RUN, "--message", "go", "--dir", missing], s.sink, {}, s.errSink);
    expect(code).toBe(2);
    expect(envelopes(s.err)[0]?.message).toMatch(/attach requires --driver/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test("a run with no box is run-not-attachable — exit 5, nothing queued", async () => {
    store.create(RUN);
    const s = streams();
    const code = await run(["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir], s.sink, driver(), s.errSink);
    expect(code).toBe(5);
    expect(envelopes(s.err)[0]).toMatchObject({ code: "run-not-attachable", state: "no-box" });
  });

  test("a run awaiting approval is not attachable — decide it, never queue to a dead box", async () => {
    await paused();
    const s = streams();
    const code = await run(["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir], s.sink, driver(), s.errSink);
    expect(code).toBe(5);
    expect(envelopes(s.err)[0]).toMatchObject({ code: "run-not-attachable", state: "awaiting-approval" });
    // B12: the refusal no longer CLAIMS the box is gone — a stranded pause
    // (crash between registration and promotion) leaves the box record open
    // and `fleet status` may well report it alive, so the old "its box is
    // gone" was a claim, not an observation. The actionable half survives.
    expect(envelopes(s.err)[0]?.remediation).not.toMatch(/box is gone/);
    expect(envelopes(s.err)[0]?.remediation).toMatch(/fleet approve/);
  });

  test("a message over the 4000-char ceiling is refused", async () => {
    store.create(RUN);
    await store.set(RUN, { vmName: RUN });
    const s = streams();
    const code = await run(
      ["attach", RUN, "--driver", "fake", "--message", "x".repeat(4_001), "--dir", dir],
      s.sink,
      driver(),
      s.errSink,
    );
    // The ceiling is DF3.3's DIRECTIVE_TEXT_CHAR_CEILING, enforced inside
    // attachToRun — this asserts the verb surfaces it rather than truncating.
    expect(code).toBe(2);
    expect(envelopes(s.err)[0]?.message).toMatch(/4000-char ceiling/);
  });

  test("an EMPTY message is a usage refusal, never an empty steering line", async () => {
    store.create(RUN);
    await store.set(RUN, { vmName: RUN });
    const s = streams();
    const code = await run(["attach", RUN, "--driver", "fake", "--message", "   ", "--dir", dir], s.sink, driver(), s.errSink);
    expect(code).toBe(2);
    expect(envelopes(s.err)[0]?.message).toMatch(/requires a message/);
  });

  test("a message of EXACTLY 4000 chars is accepted — the ceiling is the limit, not one below", async () => {
    // The == boundary of the same branch the 4001 case drives from the other
    // side: a `>` flipped to `>=` refuses a legal message, and an in-process
    // ack proves acceptance rather than inferring it from a later refusal.
    // Exactly 4000 PLAIN chars — sanitization expands only escapes, so the
    // pre-check's measure is exactly 4000 here.
    await withBox();
    const s = streams();
    // V4: acceptance is not enough at a boundary — the whole 4000-char payload
    // has to be OBSERVED arriving. The exit alone is satisfied by a CLI that
    // truncates to 4000 and then succeeds, which is the failure a ceiling
    // off-by-one can actually produce.
    const payload = "m".repeat(4_000);
    const d = execDriver((script) => (script.includes("acks.ndjson") ? ACKED("m-at-cap") : OK));
    const code = await run(
      ["attach", RUN, "--driver", "fake", "--message", payload, "--dir", dir],
      s.sink,
      {
        store,
        driver: d,
        attachOptions: { messageId: "m-at-cap", ceilingMs: 300, pollIntervalMs: 20 },
      },
      s.errSink,
    );
    expect(code).toBe(0);
    expect(envelopes(s.err)).toEqual([]);
    expect(JSON.parse(s.out.join("").trim())).toMatchObject({ outcome: "attach-acked", messageId: "m-at-cap" });
    const line = JSON.parse(execCallsOf(d).find((c) => c.stdin !== undefined)?.stdin as string) as { message: string };
    expect(line.message).toBe(payload);
    expect(line.message).toHaveLength(4_000);
  });

  test("attach-not-acked is exit 6, NOT the retryable 1 — a re-send double-delivers", async () => {
    const boxes = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-gate-boxes-"));
    try {
      const fake = new FakeDriver(boxes);
      const run1 = await provisionAdmittedRun(fake, store, { runId: RUN });
      const s = streams();
      // Nothing is listening in the box, so the ack never comes. A 300 ms
      // ceiling stands in for the real 30_000 ms (attach.test.ts's idiom).
      const code = await run(
        ["attach", RUN, "--driver", "fake", "--message", "steer left", "--dir", dir],
        s.sink,
        { driver: fake, store, attachOptions: { ceilingMs: 300, pollIntervalMs: 20 } },
        s.errSink,
      );

      expect(code).toBe(6);
      expect(envelopes(s.err).at(-1)).toMatchObject({ code: "attach-not-acked" });
      // The message IS queued — that is precisely why a retry would deliver it
      // twice and why this is 6 rather than 1.
      expect(JSON.parse(s.out.join("").trim())).toMatchObject({ runId: RUN, outcome: "attach-not-acked" });
      await fake.destroy(run1.vm.name);
    } finally {
      fs.rmSync(boxes, { recursive: true, force: true });
    }
  }, 20_000);

  test("an unknown run is exit 4", async () => {
    const s = streams();
    const code = await run(["attach", "qds-20260828-ccc333", "--driver", "fake", "--message", "go", "--dir", dir], s.sink, driver(), s.errSink);
    expect(code).toBe(4);
    // The no-record classification, not another 4-shaped guard: the envelope
    // names the code and the id, and stdout carries no completion line — the
    // inbox was never touched, which is what "unknown run" must mean on this
    // verb specifically.
    expect(envelopes(s.err)[0]).toMatchObject({ code: "run-not-found", message: expect.stringContaining("qds-20260828-ccc333") });
    expect(s.out.join("")).toBe("");
    expect(fs.existsSync(path.join(dir, "steering", "inbox.ndjson"))).toBe(false);
  });

  test("attach never CREATES a records dir — not even the default one", async () => {
    // `create: dir === undefined` exempted the DEFAULT records dir from attach's
    // own stated rationale ("attach WRITES NOTHING to the record"), which is
    // exactly backwards: the default dir is the one an operator never named and
    // is the one this verb has the least business chmod'ing 0700, sweeping temps
    // in, or probing for O_EXCL. It is `create: false` unconditionally now.
    const missing = path.join(dir, "default-runs");
    const prior = process.env.QDS_RUNS_DIR;
    process.env.QDS_RUNS_DIR = missing;
    // The default falls back to `.sandbox/runs` under the CWD, so the stray-dir
    // half of this claim needs a cwd it can observe: the repo's own `.sandbox`
    // predates the run, and asserting against it proves nothing. chdir'd, the
    // same regression that created the default dir would be visible HERE.
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const s = streams();
      // No `--dir` and an injected driver, so `assertDriverChosen` passes and
      // the READ-MODE default store is what refuses: the envelope names the
      // default path and its ENOENT, which is the proof this case wants — the
      // CLI probed the default path read-only instead of creating it. (A bare
      // `code === 2` cannot tell this apart from the `--driver` or `--message`
      // refusals on either side of it.)
      const code = await run(["attach", RUN, "--driver", "fake", "--message", "go"], s.sink, driver(), s.errSink);
      expect(code).toBe(2);
      expect(fs.existsSync(missing)).toBe(false);
      const envelope = envelopes(s.err)[0] as { message: string };
      expect(envelope.message).toContain(missing);
      expect(envelope.message).toContain("ENOENT");
      // No OTHER directory was created either — the cwd-relative default a
      // writable-store regression would have built.
      expect(fs.existsSync(path.join(dir, ".sandbox", "runs"))).toBe(false);
    } finally {
      process.chdir(prevCwd);
      if (prior === undefined) {
        // biome-ignore lint/performance/noDelete: assignment stores "undefined"
        delete process.env.QDS_RUNS_DIR;
      } else {
        process.env.QDS_RUNS_DIR = prior;
      }
    }
  });

  /**
   * A driver whose `exec` is a function of the SCRIPT it is handed.
   *
   * attach's two legs are distinguishable by their script — the append `cat >>`s
   * the inbox, the ack read `cat`s `acks.ndjson` — so one double drives them
   * independently and every `AttachResult` the CLI must map becomes reachable in
   * milliseconds, with no box, no tmpfs and no waiting. `attach.test.ts` owns
   * the real-box transport; what is only testable HERE is the mapping.
   */
  const execDriver = (
    handler: (script: string, stdin?: string) => { exitCode: number; stdout: string; stderr: string },
  ): FakeDriver => {
    const calls: Array<{ script: string; stdin?: string }> = [];
    const driver = {
      exec: async (_vm: string, argv: string[], stdin?: string) => {
        const script = argv.join(" ");
        calls.push({ script, stdin });
        return handler(script, stdin);
      },
    };
    (driver as unknown as { calls: typeof calls }).calls = calls;
    return driver as unknown as FakeDriver;
  };

  /** The exec driver's recorded calls, typed past the cast above. */
  const execCallsOf = (d: unknown): Array<{ script: string; stdin?: string }> =>
    (d as { calls: Array<{ script: string; stdin?: string }> }).calls;

  /** A run with a box on the record — the only precondition attach reads. */
  const withBox = async (over: Record<string, unknown> = {}): Promise<void> => {
    store.create(RUN);
    await store.set(RUN, { vmName: RUN, ...over });
  };

  const ACKED = (id: string) => ({ exitCode: 0, stdout: `${JSON.stringify({ messageId: id, point: "run_start" })}\n`, stderr: "" });
  const OK = { exitCode: 0, stdout: "", stderr: "" };

  test("attach-acked is exit 0 and PRINTS the completion line (the success path)", async () => {
    // Every other attach case in this file asserts a failure code. Nothing
    // pinned `attach-acked → 0`, nor the stdout line it emits — so mapping the
    // acked outcome to 6, or dropping the line entirely, turned nothing red on
    // the one path an operator uses daily.
    await withBox();
    const s = streams();
    const code = await run(
      ["attach", RUN, "--driver", "fake", "--message", "steer left", "--dir", dir],
      s.sink,
      {
        store,
        driver: execDriver((script) => (script.includes("acks.ndjson") ? ACKED("m-fixed") : OK)),
        attachOptions: { messageId: "m-fixed", ceilingMs: 300, pollIntervalMs: 20 },
      },
      s.errSink,
    );

    expect(code).toBe(0);
    expect(JSON.parse(s.out.join("").trim())).toEqual({
      runId: RUN,
      outcome: "attach-acked",
      messageId: "m-fixed",
    });
    // Success prints NOTHING on the diagnostics stream.
    expect(s.err.join("")).toBe("");
  });

  test("the MESSAGE reaches the append leg as stdin — not truncated, not emptied, not in argv", async () => {
    // The ack fixtures above are keyed on FILENAME only, so a CLI that emptied
    // or truncated the message after intake stayed green through every acked
    // and not-acked case. Recorded, then asserted: exactly ONE exec carries
    // stdin (the append), its stdin IS the message, and the message rides
    // nowhere in the argv (the `ps`-visible surface the append script exists
    // to keep clean).
    await withBox();
    const d = execDriver((script) => (script.includes("acks.ndjson") ? ACKED("m-obs") : OK));
    const s = streams();
    const code = await run(
      ["attach", RUN, "--driver", "fake", "--message", "steer left, hard", "--dir", dir],
      s.sink,
      { store, driver: d, attachOptions: { messageId: "m-obs", ceilingMs: 300, pollIntervalMs: 20 } },
      s.errSink,
    );
    expect(code).toBe(0);
    const calls = execCallsOf(d);
    expect(calls).toHaveLength(2); // append + one ack read
    const withStdin = calls.filter((c) => c.stdin !== undefined);
    expect(withStdin).toHaveLength(1);
    // The transport's contract is one NDJSON `AttachLine` on stdin, so the
    // message arrives EMBEDDED in it — parse the line and compare the field,
    // which is what a truncated or re-encoded payload fails.
    const line = JSON.parse(withStdin[0]?.stdin as string) as { message: string; runId: string; messageId: string };
    expect(line.message).toBe("steer left, hard");
    expect(line.runId).toBe(RUN);
    expect(line.messageId).toBe("m-obs");
    expect(withStdin[0]?.script).toContain("inbox.ndjson");
    for (const c of calls) expect(c.script).not.toContain("steer left");
    // The steering root the block installs IS the wiring the script uses: the
    // box resolves its own root from QDS_STEERING_ROOT, and the script's
    // expansion clause is what both legs share.
    expect(withStdin[0]?.script).toContain('root="${QDS_STEERING_ROOT:-/run/steering}"');
  });

  test("the run record's dispatch requestId is emitted as dispatchRequestId, never as requestId", async () => {
    // Two different identifiers under one key name in one verb's output is a
    // correlation bug for whoever joins the two streams: every other
    // `requestId` this CLI emits — the gate event, `logVerb`'s invocation line —
    // is THIS INVOCATION's, while `res.requestId` is the RUN RECORD's dispatch
    // id. A `...res` spread put the second one under the first one's name.
    // AWAITED (V1): `withBox` is async, and fire-and-forget races the verb's own
    // record read — the assertion below held only while `store.set` happened to
    // land first.
    await withBox({ requestId: "01234567-89ab-cdef-0123-456789abcdef" });
    const s = streams();
    const code = await run(
      ["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir],
      s.sink,
      {
        store,
        driver: execDriver((script) => (script.includes("acks.ndjson") ? ACKED("m2") : OK)),
        attachOptions: { messageId: "m2", ceilingMs: 300, pollIntervalMs: 20 },
      },
      s.errSink,
    );

    expect(code).toBe(0);
    const printed = JSON.parse(s.out.join("").trim()) as Record<string, unknown>;
    expect(printed.dispatchRequestId).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(printed).not.toHaveProperty("requestId");
  });

  // NOTE: "attach with NO --message at all is a usage refusal" used to live
  // here, in process. It could not: with the flag absent the CLI reads the REAL
  // fd 0 (`Bun.stdin.stream()` at scripts/fleet.ts:741 — there is no seam), so
  // the test's outcome depended on whatever stdin the person running `bun test`
  // happened to have. Under a fd 0 that stays open with no data it blocked and
  // died on bun's 5 s timeout; that is why it passed in one session's full run
  // and failed in the next against identical source. It is now a real
  // subprocess with a real empty pipe, in the D2 describe below where its
  // `--message -` sibling already lives.

  test("an untyped throw past the existence check is exit 1", async () => {
    // attach's only route to exit 1, which the registry declares and nothing
    // asserted. `assertRunExists` reads the record once; `attachToRun` reads it
    // again, and a plain Error from that second read reaches `report()`
    // unclassified.
    await withBox();
    const flaky = storeFailingOnNthRead(store, 2, "record store on fire");
    const s = streams();
    const code = await run(
      ["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir],
      s.sink,
      { ...driver(), store: flaky },
      s.errSink,
    );
    expect(code).toBe(1);
    expect(envelopes(s.err).at(-1)?.message).toContain("record store on fire");
  });

  test("an acked attach whose completion line cannot print is exit 6, not 0", async () => {
    // `finish(..., printed ? 0 : 6)`. The message reached the resident; only the
    // report of it was lost, so the operator must not read the short output as a
    // failure to retry — a retry mints a new messageId and double-delivers.
    await withBox();
    const err: string[] = [];
    const code = await run(
      ["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir],
      () => {
        throw new Error("EAGAIN: stdout would block");
      },
      {
        store,
        driver: execDriver((script) => (script.includes("acks.ndjson") ? ACKED("m3") : OK)),
        attachOptions: { messageId: "m3", ceilingMs: 300, pollIntervalMs: 20 },
      },
      (s) => void err.push(s),
    );
    expect(code).toBe(6);
    expect(envelopes(err).at(-1)?.code).toBe("completion-unwritable");
  });

  describe("run-not-attachable: the remediation matches the state that produced it", () => {
    // The `else` arm used to say "the run is paused at the approval gate, so its
    // box is gone — decide it with `fleet approve`/`fleet reject`" for EVERY
    // state that was not `no-box`. `attachToRun` refuses every approval state
    // plus any record carrying `closedAt` — `requestApproval` tears the box down
    // BEFORE it promotes — so `approved`, `rejected`, `timed-out` and `closed`
    // all reached that arm, and every one of them was told to decide a run that
    // is already decided or already over.
    const remediationFor = async (setup: () => Promise<void>): Promise<{ code: number; envelope: Record<string, unknown> }> => {
      // AWAITED, never fire-and-forget: `attachToRun` reads the record
      // synchronously at entry, so a setup whose `close()` lands in a later
      // microtask loses the race — the closed-run case was reading a record
      // with no `closedAt` yet, sailing past the refusal and exiting 6 off the
      // fake driver instead of 5 off `run-not-attachable`.
      await setup();
      const s = streams();
      const code = await run(
        ["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir],
        s.sink,
        { ...driver(), store },
        s.errSink,
      );
      return { code, envelope: envelopes(s.err).at(-1) as Record<string, unknown> };
    };

    test("no box recorded → the no-box remediation", async () => {
      const { code, envelope } = await remediationFor(async () => void store.create(RUN));
      expect(code).toBe(5);
      expect(envelope.state).toBe("no-box");
      expect(envelope.remediation).toContain("no box recorded");
    });

    test.each([["pausing"], ["awaiting-approval"]])("%s → the DECIDE-IT remediation", async (state) => {
      const { code, envelope } = await remediationFor(async () => {
        store.create(RUN);
        await store.set(RUN, { vmName: RUN, extensions: { approval: { state, proposal: "p", reportId: "rv-1", headSha: SHA } } });
      });
      expect(code).toBe(5);
      expect(envelope.state).toBe(state);
      expect(envelope.remediation).toMatch(/fleet approve/);
      // B12: the paused arm directs to a decision without asserting the box is
      // gone — a stranded pause can leave the box record open and alive.
      expect(envelope.remediation).not.toMatch(/box is gone/);
    });

    test.each([["approved"], ["rejected"], ["timed-out"]])("a SETTLED %s → the run-is-OVER remediation", async (state) => {
      const { code, envelope } = await remediationFor(async () => {
        store.create(RUN);
        await store.set(RUN, { vmName: RUN, extensions: { approval: { state, proposal: "p", reportId: "rv-1", headSha: SHA } } });
      });
      expect(code).toBe(5);
      expect(envelope.state).toBe(state);
      expect(envelope.remediation).toContain("this run is over");
      // The instruction that cannot be carried out is GONE, which is the whole
      // finding: a decided run has nothing left to approve or reject.
      expect(envelope.remediation).not.toMatch(/fleet approve/);
    });

    test("a plainly CLOSED run (no approval extension) → the run-is-OVER remediation", async () => {
      const { code, envelope } = await remediationFor(async () => {
        store.create(RUN);
        await store.set(RUN, { vmName: RUN });
        // Through `close()`, not `set()` — `closedAt` is immutable to `set` by
        // design, and a teardown is what really stamps it.
        store.close(RUN);
      });
      expect(code).toBe(5);
      expect(envelope.state).toBe("closed");
      expect(envelope.remediation).toContain("this run is over");
      expect(envelope.remediation).not.toMatch(/fleet approve/);
    });

    test("an UNRECOGNISED state → the inspect-first remediation, no torn-down claim (F5.36)", async () => {
      // A state string this build does not know is evidence of nothing: the
      // old catch-all asserted "its box was torn down" for every unlisted
      // state, which is false for a live run that merely carries an unknown
      // approval extension. The refusal must point at the record, not at a
      // story — and the state value must not be echoed unbounded. Round-9 B4
      // caps EVERY operator-facing echo (envelope field and remediation
      // alike) through `sanitizeLabel(state, 64)`: 63 units of the string,
      // then the ellipsis — a 10 KB attacker-controlled state cannot blow
      // either surface past that.
      const long = "S".repeat(10_000);
      const capped = `${"S".repeat(63)}…`;
      const { code, envelope } = await remediationFor(async () => {
        store.create(RUN);
        await store.set(RUN, { vmName: RUN, extensions: { approval: { state: long, proposal: "p", reportId: "rv-1", headSha: SHA } } });
      });
      expect(code).toBe(5);
      expect(envelope.state).toBe(capped);
      const remediation = String(envelope.remediation);
      expect(remediation).toContain("fleet status");
      expect(remediation).toContain("inspect");
      // The two facts the old text asserted — neither established here.
      expect(remediation).not.toContain("this run is over");
      expect(remediation).not.toContain("torn down");
      // The echo is CAPPED where it lives: the truncated head plus the
      // ellipsis, never the 10 KB the record holds and never one unit more
      // than the cap promises.
      expect(remediation).toContain(capped);
      expect(remediation).not.toContain("S".repeat(64));
    });
  });

  describe("attach-not-acked: four reasons, four remediations, one exit code", () => {
    // All four are exit 6 — the posture is identical (the message may already be
    // in the box, so a re-send double-delivers) — and the REMEDIATION is the
    // only thing that differs. Collapsing them told an operator whose box was
    // destroyed that "the message IS queued in the box", whose every clause was
    // false.
    const notAcked = async (
      handler: (script: string) => { exitCode: number; stdout: string; stderr: string },
    ): Promise<{ code: number; envelope: Record<string, unknown>; entries: LogEntry[] }> => {
      await withBox();
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => entries.push(e));
      const s = streams();
      let code: number;
      try {
        code = await run(
          ["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir],
          s.sink,
          {
            store,
            driver: execDriver(handler),
            attachOptions: { messageId: "m-na", ceilingMs: 300, pollIntervalMs: 20, perCallTimeoutMs: 200 },
          },
          s.errSink,
        );
      } finally {
        restore();
      }
      return { code, envelope: envelopes(s.err).at(-1) as Record<string, unknown>, entries };
    };

    test("no-ack: appended cleanly, nothing came back — and the PERMANENT fold-budget case is named", async () => {
      // The COMMON real shape of "no ack yet" is a cat that SUCCEEDS on a file
      // with nothing in it (`exitCode: 0, stdout: ""`), and that success is the
      // ONE thing that sets `answered` (AT1s): the box demonstrably read its
      // acks file and found nothing in it, so — and only so — the remediation
      // may claim the message IS queued. A failed cat is classified the other
      // way (the sibling case below); a clean empty read is the no-ack case.
      const { code, envelope } = await notAcked((script) => (script.includes("acks.ndjson") ? { exitCode: 0, stdout: "", stderr: "" } : OK));
      expect(code).toBe(6);
      expect(envelope.reason).toBe("no-ack");
      expect(envelope.remediation).toContain("IS queued in the box");
      expect(envelope.remediation).toContain("no in-box executor exists yet");
      expect(envelope.remediation).toContain("DF1.10");
      expect(envelope.remediation).toMatch(/fold budget/i);
    });

    test("a FAILED cat is box-unreachable, not no-ack — the box answered nothing (AT1s)", async () => {
      // The engine leaves a message refused by ATTACH_FOLD_CHAR_BUDGET
      // deliberately un-acked (steering.ts's fold arm), and attach cannot tell
      // that apart from a resident that simply has not solicited yet — the ack
      // channel carries no such signal. So the remediation has to name it:
      // "re-send" is the one action that makes the fold-budget case worse.
      //
      // V7 / AT1s: a non-zero cat used to fold into `no-ack`, which put the
      // "message IS queued in the box" claim on a box that had just failed to
      // answer a read — the answered-vs-absent divergence the no-ack arm exists
      // to keep honest. The failed read is now `box-unreachable`, so the claim
      // must be ABSENT here and the box-not-answering text present.
      const { code, envelope } = await notAcked((script) =>
        script.includes("acks.ndjson") ? { exitCode: 1, stdout: "", stderr: "" } : OK,
      );
      expect(code).toBe(6);
      expect(envelope.reason).toBe("box-unreachable");
      // The divergence, pinned on both sides: no queued claim, and the
      // unreachable arm's own words.
      expect(envelope.remediation).not.toContain("IS queued in the box");
      expect(envelope.remediation).toContain("did not answer");
      expect(envelope.remediation).toContain("fleet status");
    });

    test("an UNRECOGNISED reason → inspect-first, no queued claim (F5.37)", async () => {
      // UNREACHABLE FROM THIS BUILD: the CLI takes `reason` from
      // `attachToRun`'s four-member union, and no probe can hand the verb a
      // fifth — the CLI has no seam for injecting the library call (unlike
      // `store`/`driver`, which the verbs take whole). So the catch-all's
      // honesty is pinned at the SOURCE: the final `else` of the remediation
      // chain must not claim "IS queued" (nothing is established about an
      // unknown reason — the exact falsehood the four known arms were split
      // to stop) and must point at `fleet status` instead.
      const source = await fs.promises.readFile(path.join(import.meta.dir, "../../scripts/fleet.ts"), "utf8");
      // Anchor on the two literals that only the catch-all arm contains.
      const start = source.indexOf("`unrecognised ack outcome (");
      const end = source.indexOf(";\n        printError(", start);
      // BOTH anchors guarded. A drifted anchor returns -1, and an unguarded
      // slice then reads from `start - 300` to the second-to-last character of
      // the whole file — the `not.toContain` below would judge every other
      // verb's text, red or green for the wrong reason.
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      // The arm ITSELF, not a lookback window around it: the old 300-char
      // lookback pulled whichever known arm happened to END within reach into
      // the window, so `not.toContain("IS queued in the box")` held only while
      // the no-ack text (which says exactly that) stayed more than 300 chars
      // upstream — a char-count accident, not the pin.
      const elseArm = source.slice(start, end);
      // V8: the slice is pinned to the arm's OWN refusal literal, so a drifted
      // anchor cannot satisfy the negatives below with a slice of some OTHER
      // arm (an arm that never mentions "queued" trivially passes them). The
      // slice must contain the exact text this arm prints, and none of the four
      // known arms' distinctive literals.
      expect(elseArm).toContain("unrecognised ack outcome (");
      expect(elseArm).toContain("fleet status");
      expect(elseArm).toContain("possibly delivered");
      for (const known of ["IS queued in the box", "may or may not have landed", "is CORRUPT, not late", "did not answer the ack read"]) {
        expect(elseArm).not.toContain(known);
      }
    });

    test("send-failed: the append itself failed, so the message MAY NOT be queued", async () => {
      const { code, envelope } = await notAcked((script) =>
        script.includes("acks.ndjson") ? OK : { exitCode: 1, stdout: "", stderr: "no space left on device" },
      );
      expect(code).toBe(6);
      expect(envelope.reason).toBe("send-failed");
      // The claim the no-ack text makes is the one that must NOT appear here.
      expect(envelope.remediation).not.toContain("IS queued in the box");
      expect(envelope.remediation).toContain("may or may not have landed");
      // …and the transport's own words, so the operator can see WHY.
      expect(envelope.remediation).toContain("no space left on device");
    });

    test("acks-unreadable: a corrupt acks file is not a late one", async () => {
      const { code, envelope } = await notAcked((script) =>
        script.includes("acks.ndjson") ? { exitCode: 0, stdout: "{not json\nalso not json\n", stderr: "" } : OK,
      );
      expect(code).toBe(6);
      expect(envelope.reason).toBe("acks-unreadable");
      expect(envelope.remediation).toMatch(/corrupt/i);
      expect(envelope.remediation).not.toContain("may or may not have landed");
    });

    test("box-unreachable: the box stopped answering, which is not a fact about the file", async () => {
      const { code, envelope } = await notAcked((script) => {
        if (script.includes("acks.ndjson")) throw new Error("connection refused");
        return OK;
      });
      expect(code).toBe(6);
      expect(envelope.reason).toBe("box-unreachable");
      expect(envelope.remediation).toContain("did not answer");
      expect(envelope.remediation).not.toContain("IS queued in the box");
    });

    test("the gate event carries the reason too, not just the outcome", async () => {
      // `outcome: "attach-not-acked"` alone is one label over four transport
      // faults with four different fixes, so a dashboard keyed on it cannot tell
      // a slow resident from a box that has stopped answering.
      const { entries } = await notAcked((script) => {
        if (script.includes("acks.ndjson")) throw new Error("connection refused");
        return OK;
      });
      const line = entries.find((e) => e.event === "attach");
      expect(line).toMatchObject({ outcome: "attach-not-acked", reason: "box-unreachable" });
    });

    test("…and an ACKED attach carries no reason at all", async () => {
      await withBox();
      const entries: LogEntry[] = [];
      const restore = setLogSink((e) => entries.push(e));
      const s = streams();
      try {
        await run(
          ["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir],
          s.sink,
          {
            store,
            driver: execDriver((script) => (script.includes("acks.ndjson") ? ACKED("m-ok") : OK)),
            attachOptions: { messageId: "m-ok", ceilingMs: 300, pollIntervalMs: 20 },
          },
          s.errSink,
        );
      } finally {
        restore();
      }
      const line = entries.find((e) => e.event === "attach") as LogEntry;
      expect(line.outcome).toBe("attach-acked");
      expect(line).not.toHaveProperty("reason");
      expect(line.status).toBe("ok");
    });
  });
});

describe("CC-9 — every gate verb logs one structured line", () => {
  /** `log()` is muted under bun test, so assert through an installed sink. */
  async function captured(argv: string[], d: Partial<FleetDeps>): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    try {
      const s = streams();
      await run(argv, s.sink, d, s.errSink);
    } finally {
      restore();
    }
    return entries;
  }

  test("approve logs event/state/approverId with no token", async () => {
    await paused();
    const capturedLines = await captured(["approve", RUN, "--approver", "alice", "--dir", dir], authOk());
    const lines = capturedLines.filter((l) => l.event === "approve");
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ runId: RUN, event: "approve", state: "approved", approverId: "alice", outcome: "decided" });
    expect(typeof lines[0]?.decision_wait_ms).toBe("number");
    // V10: the scan is over the WHOLE capture, not the filtered lines — a token
    // riding any OTHER entry this invocation emitted (the invocation line, a
    // refusal) sailed past the `event === "approve"` filter above.
    const serialized = JSON.stringify(capturedLines);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });

  test("a FRESH decision carries its reason on the completion line AND the gate event (F5.41, INV-APPROVE-4)", async () => {
    // INV-APPROVE-4's letter: a decision is logged with approverId, timestamp,
    // reason, runId and requestId. `reason` used to ride only the
    // `already-decided` arm, so a first decision's WHY reached no log stream.
    await paused();
    const s = streams();
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => entries.push(e));
    let out = "";
    try {
      const code = await run(
        ["approve", RUN, "--approver", "alice", "--reason", "ship-it-42", "--dir", dir],
        (chunk) => {
          out += chunk;
        },
        authOk(),
        s.errSink,
      );
      expect(code).toBe(0);
    } finally {
      restore();
    }
    const printed = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(printed.reason).toBe("ship-it-42");
    const gate = entries.find((e) => e.event === "approve") as LogEntry;
    expect(gate.reason).toBe("ship-it-42");
  });

  test("a RAISING sink drops the event but warns on fd 2 ONCE per process (F5.39)", async () => {
    // A sink that throws on every emit used to be swallowed invisibly: every
    // gate event — the dispatchRequestId joins DF5.3 depends on among them —
    // vanished while all verbs kept exiting correctly. The events are still
    // dropped (a broken sink is broken), but the first failure earns one
    // stderr line naming the fault, and NOT one per emit.
    //
    // The warning is written with `writeSync(2)` — SYNCHRONOUSLY, not through
    // `process.stderr.write` — because it fires seconds before `process.exit`
    // on a stderr that is usually a CAPTURED pipe, and a pipe write queued on
    // the stream is dropped by the exit that follows it. So the assertion has
    // to observe fd 2 of a process that then exits, which is exactly what a
    // subprocess with a piped stderr is: the child installs a raising sink,
    // emits TWO gate events (both dropped), and exits immediately. One note in
    // what the parent reads back proves the latch AND the synchrony; the old
    // `process.stderr.write` spy proved neither (it captured a stream object,
    // not fd 2, and a spy keeps bytes the real pipe would have lost).
    store.create(RUN);
    const CLI_TS = JSON.stringify(path.join(import.meta.dir, "../../scripts/fleet.ts"));
    const LOG_TS = JSON.stringify(path.join(import.meta.dir, "../../src/swarmclaw/log.ts"));
    const child = `
      const { run } = await import(${CLI_TS});
      const { setLogSink } = await import(${LOG_TS});
      setLogSink(() => {
        throw new Error("sink exploded");
      });
      const sink = (): void => {};
      const argv = ["unlock", process.env.FIX_RUN_ID, "--dir", process.env.FIX_RUNS_DIR];
      const first = await run(argv, sink, {}, sink);
      const second = await run(argv, sink, {}, sink);
      process.exit(first === 0 && second === 0 ? 0 : 1);
`;
    const proc = Bun.spawn(["bun", "-e", child], {
      // The repo root, as `childEnv`'s comment describes: the CLI resolves
      // relative paths and `.env` from the CURRENT directory.
      cwd: path.join(import.meta.dir, "..", ".."),
      env: { ...childEnv(), FIX_RUN_ID: RUN, FIX_RUNS_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    // Both verbs really ran and really exited 0 — the drops happened on a
    // healthy invocation, not on one that was failing anyway.
    expect(code).toBe(0);
    expect(out).toBe("");
    // The store's OWN sink-failure note (`run-record: log sink threw for …`)
    // rides the same broken sink, so the gate warning is located by text.
    const notes = err.split("\n").filter((l) => l.includes("log sink is raising"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("gate events are being dropped");
  }, 30_000);

  test("an OVERLONG --reason arrives on the log line CAPPED, not raw (F5.41)", async () => {
    // The completion line is the one echo of argv this arm prints; it must
    // never carry an unbounded value. The cap is `MAX_REASON_CHARS`, the same
    // bound `submitDecision` writes the record under.
    await paused();
    const huge = "r".repeat(5000);
    const s = streams();
    let out = "";
    const code = await run(
      ["approve", RUN, "--approver", "alice", "--reason", huge, "--dir", dir],
      (chunk) => {
        out += chunk;
      },
      authOk(),
      s.errSink,
    );
    expect(code).toBe(0);
    const printed = JSON.parse(out.trim()) as Record<string, unknown>;
    // V11: the cap is a PREFIX, not just a length — "the first 1000 units of
    // what I typed" is the operator-facing promise, and a cap that kept the
    // LAST 1000 or a mangled middle would satisfy a length check alone. The
    // prefix is what the CLI SUBMITS (`sanitizeLabel` at the cap: 999 units of
    // the head, then the ellipsis), so the record holds the same value the
    // operator was shown — the two surfaces cannot disagree about WHY.
    const capped = `${huge.slice(0, 999)}…`;
    expect(printed.reason).toBe(capped);
    expect(String(store.get(RUN).extensions?.approval?.reason)).toBe(capped);
    expect(capped).toHaveLength(1_000);
  });

  test("NO log entry carries a token, under any key", async () => {
    await paused();
    // A LEAKY auth double, not the bare `authOk()`: with no secret-shaped string
    // anywhere in the invocation the negative assertions below pass on a CLI
    // that echoes every auth field verbatim — the exact anti-pattern this
    // file's own comment on the approve-section needle test documents. `token`
    // and `tokenHash` ride back beside the contract fields, which is what an
    // `authenticate` that carried the credential would look like.
    const leaky: Partial<FleetDeps> = {
      authenticate: async (_hostRoot, approverId) =>
        ({ ok: true, approverId, token: NEEDLE, tokenHash: NEEDLE }) as unknown as Awaited<
          ReturnType<NonNullable<FleetDeps["authenticate"]>>
        >,
    };
    const entries = await captured(["approve", RUN, "--approver", "alice", "--dir", dir], leaky);
    // Serialized whole, so a token smuggled in under ANY key is caught — the
    // stream-level check cannot see these lines at all, because `log()` is
    // muted under bun test and only an installed sink receives them.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(NEEDLE);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
    // The one identity that MAY appear is the approver id the operator typed —
    // and its presence is what proves the sink received real lines.
    expect(serialized).toContain("alice");
  });

  test("a refusal logs event:refused rather than a decision", async () => {
    await paused();
    const lines = (await captured(["approve", RUN, "--approver", "mallory", "--dir", dir], authRefused)).filter(
      (l) => l.event === "refused",
    );
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ runId: RUN, outcome: "approver-token-mismatch" });
    expect(lines[0]?.approverId).toBeUndefined();
  });
});

/**
 * The child env the out-of-process suites (D2, D5) hand their subprocesses,
 * scrubbed of every QDS_* ambient override plus the provisioning key.
 * `cwd: REPO` is deliberate — the CLI loads the repo `.env` — but this repo's
 * `.env` carries a real OPENROUTER_PROVISIONING_KEY, and a developer shell
 * exporting QDS_RUNS_DIR / QDS_STEERING_ROOT / QDS_FAKE_BOXES_DIR would
 * silently point the hermetic subprocess assertions at paths no assertion
 * here names. `QDS_LOG_VERBOSE` is scrubbed too: the muted-under-test posture
 * these assertions lean on must not be flippable from outside. Enumerating by
 * prefix rather than deny-listing is what makes a NEW override fail loudly
 * (the store refuses an `--dir` that does not exist) instead of quietly
 * redirecting one.
 */
const childEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "QDS_LOG_VERBOSE" || key === "OPENROUTER_PROVISIONING_KEY" || key.startsWith("QDS_")) delete env[key];
  }
  return env;
};

/**
 * The event union is a CONTRACT and every member must have a producer
 * (DF3.4 deferred item D1).
 *
 * `"pause"` was declared in `gateEvent`'s union from the day the story shipped
 * and nothing anywhere emitted it — DF5.3 is specified to join approvals across
 * every gate event, and the one the pause slice is built around produced no
 * line at all. A declared event with no producer is unfalsifiable by the
 * behavioural suites: they can only assert about lines that exist.
 *
 * So this reads the SOURCE, the way `tests/fleet/verbs.test.ts` binds
 * `DOCUMENTED_EXIT_CODES` to `report()`'s real clamp. It is a static invariant
 * over real files, not a mock: delete the producer and it goes red, add an
 * undeclared one and it goes red the other way.
 */
describe("gateEvent union ↔ producers", () => {
  const readSrc = (...p: string[]): string => fs.readFileSync(path.join(import.meta.dir, "..", "..", ...p), "utf8");

  test("every declared gate event is produced, and every produced one is declared", () => {
    const cli = readSrc("scripts", "fleet.ts");
    const gate = readSrc("src", "fleet", "approval-gate.ts");

    // The union as DECLARED, read off `gateEvent`'s own signature.
    const decl = cli.match(/const gateEvent = \(\s*event:\s*([^,]+),/);
    expect(decl).not.toBeNull();
    // `a-z0-9_-`, not `a-z-`: an event named `t3-moved` or `re_open` is a legal
    // member that the old class silently DROPPED — invisible to both sets and
    // therefore to both loops below, while the size guard stayed satisfied by
    // the members it did see. The character class is the fix; the RAW-COUNT
    // guard underneath is what catches a future literal shape neither set
    // understands.
    const literals = (s: string): string[] => [...s.matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1] as string);
    const declText = (decl as RegExpMatchArray)[1] ?? "";
    const declared = new Set(literals(declText));
    // Guard the regex itself: a rename that stops it matching would leave an
    // empty set and pass every loop below vacuously.
    expect(declared.size).toBeGreaterThanOrEqual(6);
    expect(declared).toContain("pause");
    // A member the literal-scan cannot see would shrink `declared` against the
    // signature's own `|` count. Every `|`-separated position must have
    // yielded a literal, so a dropped member fails HERE with the counts rather
    // than silently missing from both sets.
    expect({ separators: (declText.match(/\|/g) ?? []).length + 1, found: declared.size }).toEqual({
      separators: (declText.match(/\|/g) ?? []).length + 1,
      found: (declText.match(/\|/g) ?? []).length + 1,
    });

    // The union as PRODUCED. Two shapes, because there are two producers:
    // `gateEvent(<expr>, …)` in the CLI — whose first argument is sometimes a
    // ternary (`verb === "approve" ? "approve" : "reject"`), so the literals are
    // collected from the whole expression — and the gate module's own
    // `event: "pause"` line, which cannot route through the CLI's closure
    // because the CLI has no `requestApproval` call site.
    const produced = new Set<string>();
    for (const call of cli.matchAll(/gateEvent\(([^,]*),/g)) for (const e of literals(call[1] ?? "")) produced.add(e);
    for (const lit of gate.matchAll(/\bevent:\s*"([a-z0-9_-]+)"/g)) produced.add(lit[1] as string);

    // Named per member so a failure says WHICH event lost its producer rather
    // than printing two sets and leaving the diff to the reader.
    for (const event of declared) {
      expect({ event, produced: produced.has(event) }).toEqual({ event, produced: true });
    }
    // And the reverse: an emitted event the union does not declare is a
    // consumer's unhandled default branch.
    for (const event of produced) {
      expect({ event, declared: declared.has(event) }).toEqual({ event, declared: true });
    }
  });
});

/**
 * `--message -`, the undeclared sentinel, now declared (DF3.4 deferred item D2).
 *
 * OUT OF PROCESS, deliberately. The help text is rendered by a real
 * `bun scripts/fleet.ts` invocation, and the sentinel is exercised over a REAL
 * SHELL PIPE (`sh -c 'printf … | …'`, a genuine FIFO on fd 0) rather than
 * `Bun.spawn({stdin:"pipe"})`'s socket — the property under test is what an
 * operator's shell does, and an in-process call cannot observe either one.
 *
 * The `--driver fake` on these rows is INERT to what they prove: every refusal
 * below fires in the message-intake block, which sits after the record read and
 * before `attachToRun` ever touches the driver. The one row that does reach
 * `attachToRun` refuses on the record's missing box, which is also driver-free.
 */
describe("D2 — attach --message and its `-` stdin sentinel, out of process", () => {
  const CLI = path.join(import.meta.dir, "..", "..", "scripts", "fleet.ts");
  const REPO = path.join(import.meta.dir, "..", "..");
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

  /** One real invocation. `pipe` is a shell command whose stdout becomes fd 0. */
  async function cli(args: string[], pipe?: string): Promise<{ code: number; out: string; err: string }> {
    const cmd = `exec bun ${q(CLI)} ${args.map(q).join(" ")}`;
    const proc = Bun.spawn(["sh", "-c", pipe === undefined ? cmd : `${pipe} | ${cmd}`], {
      // Absolute CLI path AND an explicit cwd: `bun scripts/fleet.ts` resolves
      // relative paths and `.env` from the CURRENT directory, and a test that
      // inherits an arbitrary one fails in ways that look like product bugs.
      cwd: REPO,
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  }

  const NOTE = "the value `-` reads the message from stdin";

  /**
   * D7 — a typo'd run id is the most ordinary operator error on this verb, and
   * NOTHING pinned what an operator actually gets. The library reader
   * (`readApproval`) throws a raw storage error on a missing record, and the
   * deferred question was whether that reaches the operator. It does not: the
   * verb block's `assertRunExists` classifies it first. Pinned OUT OF PROCESS
   * because the property is the process's exit code, which an in-process call
   * cannot observe.
   *
   * Verified as a genuine guard, not a tautology: deleting the
   * `assertRunExists(probe, runIdArg)` call from the approve block turns this
   * red — the absent run then lands on exit **2**, a usage/validation refusal,
   * which tells an operator to check their flags when the flags were fine.
   * Source restored and re-verified byte-identical afterwards.
   *
   * `--approver`/auth: the CLI defers reporting a missing run until AFTER
   * authentication on purpose, so an unauthenticated caller cannot separate
   * "no such run" (4) from "that run exists" (5) by exit code and enumerate
   * run ids. That is why this test enrols a REAL approver with a REAL token on
   * a REAL 0600 allowlist and pipes it on stdin — with a bad token the verb
   * correctly answers 5 and would prove nothing about the absent-run path.
   */
  test("D7 — `fleet approve` on a run that does not exist is exit 4, naming the id", async () => {
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-d7-host-"));
    try {
      const factory = path.join(host, ".factory");
      fs.mkdirSync(factory, { mode: 0o700 });
      fs.chmodSync(host, 0o700);
      const salt = "d7salt";
      const token = "d7-token-value-not-a-real-credential";
      // `scryptToken`, not a hand-rolled KDF: it is exported precisely so a
      // fixture and the check cannot drift apart on the formula.
      const hash = scryptToken(salt, token);
      const allowlist = path.join(factory, "approvers.json");
      fs.writeFileSync(
        allowlist,
        JSON.stringify({ version: 1, approvers: { alice: { v: 2, salt, hash, ...SCRYPT_PARAMS } } }),
      );
      fs.chmodSync(allowlist, 0o600);
      // The runs dir must EXIST for the flag-less invocation to reach
      // `run-not-found` (a record missing from an EXISTING dir) instead of the
      // bootstrap refusal (round-9 B10) for a dir that does not.
      const runsDir = path.join(host, ".sandbox", "runs");
      fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });

      // `cwd: host` — the allowlist is read from the AUTH ROOT, which with no
      // `--dir` is `process.cwd()` (round-9 C10 parity keeps the pre-existing
      // default for the flag-less form), so this invocation must run from the
      // host, not from the repo — and must NOT pass `--dir`: under the parity
      // a `--dir` would point the allowlist read at the runs dir instead.
      const cmd = `exec bun ${q(CLI)} ${["approve", "run-typo-d7", "--approver", "alice"].map(q).join(" ")}`;
      const proc = Bun.spawn(["sh", "-c", `printf %s ${q(token)} | ${cmd}`], { cwd: host, env: { ...childEnv(), HOME: host }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

      // 4, not 1 and not 5: "that run does not exist", the documented no-record
      // code, distinct from "a guard fired before anything was mutated".
      expect(code).toBe(4);
      // A refusal prints NO completion line — stdout is output, and a refusal
      // produced none (the D5 teardown refusals pin the same rule).
      expect(out).toBe("");
      const refusal = envelopes([err]).find((e) => e.code !== undefined);
      expect(refusal).toMatchObject({ code: "run-not-found" });
      // The remediation NAMES what to do, and the message names the id — an
      // operator who typed one character wrong can act on this without reading
      // source. A raw `ENOENT` satisfies neither.
      expect(String(refusal?.message)).toContain("run-typo-d7");
      expect(String(refusal?.remediation)).toContain("fleet status");
      // The raw storage error never surfaces.
      expect(err).not.toContain("ENOENT");
      expect(err).not.toContain("unreadable run record");
      // Nothing was mutated: no record, and no lock left behind for the id.
      // Both paths DERIVED, not hand-spelled: the record name from the store's
      // own `path()` (its filename contract), the approval-lock name from the
      // gate source's one spelling — so a rename on either side turns this
      // assertion red for the right reason, and the test cannot silently
      // pass on a path the code no longer touches.
      //
      // V6 (HIGH): the CHILD ran with `cwd: host` and no `--dir`, so the runs
      // root it could have mutated is `host/.sandbox/runs` — the directory this
      // test created above for exactly that. The checks used to look at THIS
      // test's own store (`dir`), a path the child never received, so the
      // "nothing was mutated" claim was satisfied vacuously: a regression that
      // wrote the record into the real runs root stayed green beside assertions
      // about a directory the process had no route to.
      expect(fs.existsSync(path.join(runsDir, path.basename(store.path("run-typo-d7"))))).toBe(false);
      const gateSrc = fs.readFileSync(path.join(import.meta.dir, "../../src/fleet/approval-gate.ts"), "utf8");
      const lockSpelling = gateSrc.match(/join\(dir, `\$\{runId\}([^`]+)`\)/)?.[1];
      expect(lockSpelling).toBeDefined();
      expect(fs.existsSync(path.join(runsDir, `run-typo-d7${lockSpelling as string}`))).toBe(false);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  }, 30_000);

  test("`fleet attach --help` tells an operator what `-` does", async () => {
    const { code, out } = await cli(["attach", "--help"]);
    expect(code).toBe(0);
    // The note, on `--message`'s OWN line — not merely somewhere in the help.
    // A note that renders under the wrong flag is worse than no note.
    const line = out.split("\n").find((l) => l.trim().startsWith("--message ("));
    expect(line).toBeDefined();
    expect(line as string).toContain(NOTE);
    expect(line as string).toContain("(string, optional)");
  }, 30_000);

  test("`--message -` with an EMPTY pipe refuses — proving `-` is a sentinel, not the message", async () => {
    // If `-` were taken as the message it would be non-empty and this would get
    // past the guard. The refusal IS the proof that stdin was read instead.
    store.create(RUN);
    const { code, err } = await cli(["attach", RUN, "--driver", "fake", "--dir", dir, "--message", "-"], "printf ''");
    expect(code).toBe(2);
    expect(err).toContain("attach requires a message");
  }, 30_000);

  test("attach with NO --message at all is a usage refusal, never an empty steering line", async () => {
    // `--message "   "` is covered in the in-process block above; the flag being
    // ABSENT is the other half and takes a different route — the stdin read —
    // which on an empty pipe yields nothing and must land on the same refusal
    // rather than queueing an empty directive.
    //
    // The pipe is EXPLICIT and empty rather than inherited. That is the whole
    // repair: an inherited fd 0 that stays open with no data makes this read
    // block, and a test that hangs looks like a product defect until the
    // runner's timeout fires.
    store.create(RUN);
    const { code, err } = await cli(["attach", RUN, "--driver", "fake", "--dir", dir], "printf ''");
    expect(code).toBe(2);
    // The EXACT refusal, not `/message/i`: any stderr mentioning the word plus
    // an exit 2 would otherwise satisfy this — including a different refusal
    // that merely names the flag. The sibling `-`-with-empty-pipe test pins
    // the same string, which is the point: flag absent and flag empty land on
    // the same stdin-read refusal.
    expect(err).toContain("attach requires a message");
  }, 30_000);

  test("`--message -` DELIVERS the piped bytes as a steering message and acks — the success path", async () => {
    // Every other out-of-process stdin row ends in a refusal, so a `--message -`
    // intake that dropped, re-encoded or truncated the payload past the length
    // check stayed green: nothing showed piped bytes arriving anywhere. This
    // one runs the WHOLE loop for real — a real pipe into a real subprocess,
    // the real append script (the box resolves its own root from the same env
    // the child inherits: FakeDriver hands its exec `process.env`), the
    // message read back out of the box's inbox file and compared to what was
    // piped, a real ack line written the way the engine leg writes one, and
    // the real ack read the CLI polls — ending in `attach-acked`, exit 0.
    const payload = "steer-left-pipe-42";
    const boxes = path.join(dir, "boxes");
    const steering = path.join(dir, "steering");
    fs.mkdirSync(boxes, { recursive: true });
    // A REAL box, because `--driver fake` resolves the real driver and its
    // exec refuses a box that does not exist.
    const fake = new FakeDriver(boxes);
    await fake.create(RUN);
    store.create(RUN);
    await store.set(RUN, { vmName: RUN });

    const priorBoxes = process.env.QDS_FAKE_BOXES_DIR;
    const priorSteering = process.env.QDS_STEERING_ROOT;
    process.env.QDS_FAKE_BOXES_DIR = boxes;
    process.env.QDS_STEERING_ROOT = steering;
    try {
      // Spawned, not awaited: the CLI polls for the ack this test writes once
      // the inbox line lands, so the parent has to be the one that moves the
      // engine half of the loop forward. Joining first would deadlock on the
      // 30 s ceiling — and that deadlock, not a red assertion, is exactly what
      // a wedged intake would look like.
      const proc = Bun.spawn(["sh", "-c", `printf %s ${q(payload)} | exec bun ${q(CLI)} ${["attach", RUN, "--driver", "fake", "--dir", dir, "--message", "-"].map(q).join(" ")}`], {
        cwd: REPO,
        // Same scrub as every other subprocess here, PLUS the two overrides
        // this test installs deliberately: the box and the engine leg must
        // resolve the SAME steering root, and the CLI's own `store` is not
        // injected out of process.
        env: { ...childEnv(), QDS_FAKE_BOXES_DIR: boxes, QDS_STEERING_ROOT: steering },
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 25_000;
      let delivered: string[] = [];
      // V13: the line is parsed INSIDE the poll loop and a torn read is
      // retried, not fatal. The CLI appends the inbox line itself, so the file
      // can be observed mid-write; parsing it once, after the loop, turned that
      // ordinary interleaving into a SyntaxError that aborted the test — with
      // the child still running and polling a steering root the `afterEach` was
      // about to delete.
      let line: { messageId: string; message: string; runId: string } | undefined;
      // A throw from the poll loop (fs, JSON) used to exit the test with the
      // child still running — a live `bun` process polling a steering root the
      // `afterEach` was about to delete. Reaped on EVERY path below.
      const reap = (): void => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      };
      try {
          for (;;) {
            const inbox = path.join(steering, "inbox.ndjson");
            if (fs.existsSync(inbox)) {
              const text = fs.readFileSync(inbox, "utf8").trim();
              if (text !== "") delivered = text.split("\n");
              // A partial line is not evidence of a wedged intake: the next
              // tick re-reads the file whole. Only a whole line is used.
              const first = delivered[0];
              if (first !== undefined) {
                try {
                  line = JSON.parse(first) as { messageId: string; message: string; runId: string };
                } catch {
                  /* torn trailing line — retried on the next tick */
                }
              }
            }
            if (line !== undefined || Date.now() > deadline) break;
            await Bun.sleep(25);
          }
          if (line === undefined) {
            throw new Error(
              delivered.length === 0
                ? `no steering line arrived in ${steering} within 25s — the piped payload never landed`
                : `a steering line arrived in ${steering} but never parsed whole — the append kept landing torn`,
            );
          }
          // `localSteeringInbox.ack`'s exact file shape, written by this test in
          // the engine's seat.
          fs.appendFileSync(
          path.join(steering, "acks.ndjson"),
          `${JSON.stringify({ messageId: line.messageId, ackedAt: new Date().toISOString(), point: "run_start" })}\n`,
          { mode: 0o600 },
        );

        const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        // stderr carries the CLI's own structured JSONL stream (a real subprocess
        // is not under bun test's muting) — so "clean" means no WARNING and no
        // refusal envelope, not an empty stream. "No warning" is judged on
        // LINES, not a bare substring: the substring form passes while an
        // advisory riding any other prefix sails through, and a stray
        // "warning:" inside a JSON payload would false-red it. The stderr's
        // only legitimate content here is the JSONL invocation/gate lines.
        const errLines = err.split("\n").filter((l) => l.trim() !== "");
        expect(errLines.filter((l) => l.toLowerCase().startsWith("warning:"))).toEqual([]);
        expect(err).not.toContain("attach-not-acked");
        for (const l of errLines) expect(() => JSON.parse(l)).not.toThrow();
        expect(JSON.parse(out.trim()) as { outcome: string }).toMatchObject({ outcome: "attach-acked" });
        expect(code).toBe(0);
        expect(line.message).toBe(payload);
        expect(line.runId).toBe(RUN);
        const printed = JSON.parse(out.trim()) as { runId: string; outcome: string; messageId: string };
        expect(printed).toEqual({ runId: RUN, outcome: "attach-acked", messageId: line.messageId });
      } finally {
        reap();
      }
    } finally {
      if (priorBoxes === undefined) {
        // biome-ignore lint/performance/noDelete: assignment stores "undefined"
        delete process.env.QDS_FAKE_BOXES_DIR;
      } else {
        process.env.QDS_FAKE_BOXES_DIR = priorBoxes;
      }
      if (priorSteering === undefined) {
        // biome-ignore lint/performance/noDelete: assignment stores "undefined"
        delete process.env.QDS_STEERING_ROOT;
      } else {
        process.env.QDS_STEERING_ROOT = priorSteering;
      }
    }
  }, 60_000);

  test("`--message -` sends what the PIPE contains, not the flag's value", async () => {
    // A message one character over the ceiling: the refusal names the length,
    // so it is positive evidence that the piped bytes became the message rather
    // than the one-character "-".
    store.create(RUN);
    const over = 4_001;
    const { code, err } = await cli(
      ["attach", RUN, "--driver", "fake", "--dir", dir, "--message", "-"],
      `printf 'x%.0s' $(seq ${over})`,
    );
    expect(code).toBe(2);
    expect(err).toContain(`--message is ${over} chars`);
  }, 30_000);

  test("the literal one-character message `-` IS sendable — pipe it", async () => {
    // The residual the old registry comment claimed the sentinel "costs": it
    // costs nothing. Omitting the flag reads stdin too, so a piped `-` is an
    // ordinary message. Proof that it was ACCEPTED is that this run gets past
    // the intake guard entirely and refuses on the record instead — exit 5,
    // `run-not-attachable`, state `no-box` — rather than exit 2 "requires a
    // message".
    store.create(RUN);
    const { code, err } = await cli(["attach", RUN, "--driver", "fake", "--dir", dir], "printf -- '-'");
    expect(err).not.toContain("attach requires a message");
    expect(code).toBe(5);
    // stderr carries BOTH the gate-event log line and the refusal envelope;
    // the envelope is the one with a `code`, and taking `[0]` blindly would
    // assert against whichever the JSONL stream happened to emit first.
    const refusal = envelopes([err]).find((e) => e.code !== undefined);
    expect(refusal).toMatchObject({ code: "run-not-attachable", state: "no-box" });
  }, 30_000);
});

/**
 * D5 — exit 6 asserts LANDED work, which a throw structurally cannot report.
 *
 * The deferred item read as a one-token type bug: `FleetError.exitCode` is
 * typed `1|2|3|4|5` (`src/fleet/dispatch.ts`) while `report()` clamps to 6, so
 * "widen the union at both sites". The audit found the opposite — the
 * narrowness is a guard — and these are the real invocations that establish it.
 *
 * `scripts/fleet.ts`'s header defines 6 as "the verb's own work LANDED but the
 * invocation could not finish it or report it". A site reporting that has TWO
 * things to say: the completion line on stdout, which is the only record that
 * the work landed, and a diagnostic on stderr naming what is left over. A
 * thrown `FleetError` routes through `report()`, which renders the error
 * envelope and nothing else — so a thrown 6 would silently destroy the first
 * half, and is self-contradictory besides (a frame that throws has not
 * completed the work a 6 asserts DID complete). Widening the union would not
 * unblock a missing case: no construction site anywhere passes 6.
 *
 * WHAT THIS ADDS over the in-process teardown probes in `verbs.test.ts` (which
 * already assert code 6 with `torn down:` on stdout and `key-unattributable` on
 * stderr): those call `run()` and assert its RETURN VALUE. This asserts the
 * real PROCESS STATUS of a real `bun scripts/fleet.ts`, which is the only thing
 * an operator and their `|| alert` ever see, and which no in-process call can
 * observe. Every other real-subprocess exit code in this file is a refusal
 * (2, 4, 5); 6 — the code D5 is actually about — had none.
 *
 * `--driver fake` is the CLI's own documented local-dry-run driver ("pass
 * --driver fake for a local dry run", `scripts/fleet.ts`), resolved from argv
 * through the real `resolveDriver` — not a double injected past it.
 */
describe("D5 — exit 6 asserts landed work, out of process", () => {
  const CLI = path.join(import.meta.dir, "..", "..", "scripts", "fleet.ts");
  const REPO = path.join(import.meta.dir, "..", "..");

  /** One real invocation, stdout and stderr kept apart as the CLI routes them. */
  async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", CLI, ...args], {
      // Absolute CLI path AND an explicit cwd, for the reason the D2 helper
      // above records: `bun scripts/fleet.ts` resolves relative paths and
      // `.env` from the CURRENT directory, and an inherited one fails in ways
      // that look like product bugs.
      cwd: REPO,
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  }

  const codesOf = (err: string): string[] => [...err.matchAll(/"code":"([^"]+)"/g)].map((m) => m[1] as string);

  test("a real exit-6 site emits BOTH outputs — the completion line a throw would destroy, and the leftover", async () => {
    // The record `keyUnattributable` exists for, built through the store rather
    // than hand-written JSON: a box was provisioned and the run is still open,
    // but no `keyHash` was ever persisted. Dispatch mints the key AFTER
    // provisioning, so a crash in between leaves exactly this — a teardown that
    // is correct for the BOX and silent about a key that may still be billing.
    const id = "qds-20260101-aaaaaa";
    store.create(id);
    store.set(id, { vmName: id });

    const { code, out, err } = await cli(["teardown", id, "--driver", "fake", "--dir", dir]);

    // The real process status, not a returned number.
    expect(code).toBe(6);
    // Half one: the work LANDED, and stdout is the ONLY place that is recorded.
    // This is the half a thrown FleetError could never have printed.
    expect(out).toContain(`torn down: ${id}`);
    // Half two: the leftover, named on stderr in the SAME invocation.
    expect(codesOf(err)).toContain("key-unattributable");
  }, 30_000);

  test("the same teardown with nothing left over is exit 0 on the same completion line", async () => {
    // The control. Without it the assertion above is satisfied by a teardown
    // that returns 6 unconditionally, which would prove nothing about the fold.
    const id = "qds-20260101-cccccc";
    store.create(id);

    const { code, out } = await cli(["teardown", id, "--driver", "fake", "--dir", dir]);

    expect(code).toBe(0);
    expect(out).toContain(`torn down: ${id}`);
  }, 30_000);

  test.each([
    [2, ["teardown", "qds-20260101-bbbbbb"], "usage"],
    [4, ["teardown", "qds-20260101-bbbbbb", "--driver", "fake"], "run-not-found"],
  ])("a refusal exits %i and prints ONLY the envelope — stdout stays empty", async (want, args, wantCode) => {
    const { code, out, err } = await cli([...(args as string[]), "--dir", dir]);

    expect(code).toBe(want as number);
    expect(codesOf(err)).toContain(wantCode as string);
    // The contrast that makes the decision. A refusal has no landed work, so it
    // prints no completion line — and a refusal is exactly what a thrown
    // `FleetError` produces. That is why 6, which MUST print one, cannot be
    // expressed as a throw, and why the union stops at 5.
    expect(out).toBe("");
  }, 30_000);
});

/**
 * DF3.4 deferred item D11 — `fleet unlock`, the operator remedy that pays for
 * `withApprovalLock`'s strictness.
 *
 * The gate now reclaims a lock ONLY from a provably-dead holder, which is what
 * makes its mutual-exclusion guarantee real. The price is that a holder whose
 * pid the OS recycled onto an unrelated live process wedges the run forever;
 * this verb is how an operator ends that, deliberately and auditably, instead of
 * an invisible `age > 1h` door doing it on their behalf.
 *
 * The CLASSIFICATION arms (2/5/0-absent/0-reclaimed/0-forced) are
 * verbs.test.ts's probe table. The codes a probe cannot reach are here, and
 * `ONLY_REACHABLE_ELSEWHERE` binds this file's test TITLES to them — an
 * excuse that outlives its test is an excuse checked against nothing.
 */
describe("fleet unlock — the codes a probe cannot reach (D11)", () => {
  test("a FAILED record read is the generic unlock-refused refusal — exit 5, reason only in the gate event", async () => {
    // The record read is now GUARDED, not classified-and-rethrown: a read that
    // throws is folded into the ONE `unlock-refused` envelope every other
    // refusal of this verb produces (the missing record, the live holder), so a
    // caller holding no lock cannot separate "no such run" from "that run
    // exists" from "the holder is alive" and enumerate run ids. The gate event
    // is where the truth goes, and the raw store message — the fingerprint the
    // old exit-1 carried — must not surface at all.
    store.create(RUN);
    const flaky = failingStore(store, "record store on fire");
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => void entries.push(e));
    const s = streams();
    try {
      const code = await run(["unlock", RUN, "--dir", dir], s.sink, { store: flaky }, s.errSink);
      expect(code).toBe(5);
      const envelope = envelopes(s.err).at(-1) as Record<string, unknown>;
      expect(envelope.code).toBe("unlock-refused");
      // The generic envelope, verbatim: no pid, no age, no storage message.
      expect(String(envelope.message)).not.toContain("record store on fire");
      expect(String(envelope.message)).toContain("could not confirm");
      // The remedy names the gate event, because that is where the reason went.
      expect(String(envelope.remediation)).toContain("gate event");
      // …and the gate event is where the true reason is.
      const event = entries.find((e) => (e as unknown as { event?: string }).event === "unlock") as unknown as
        | Record<string, unknown>
        | undefined;
      expect(event).toMatchObject({ outcome: "record-read-failed", forced: false });
    } finally {
      restore();
    }
  });

  test("a MISSING record refuses through the same generic envelope — no `run-not-found`, exit 5", async () => {
    // The missing-record arm of the same fold. verbs.test.ts's probe table pins
    // the exit code and the envelope code; this pins the rest of the shape that
    // makes the fold an id-enumeration fix — the envelope must not carry a
    // `run-not-found` code or name the classification on stderr at all.
    const s = streams();
    const code = await run(["unlock", "qds-20260828-zzz999", "--dir", dir], s.sink, { store }, s.errSink);
    expect(code).toBe(5);
    expect(envelopes(s.err).at(-1)).toMatchObject({ code: "unlock-refused" });
    expect(s.err.join("")).not.toContain("run-not-found");
    expect(s.out.join("")).toBe("");
  });

  test("unlock: an untyped throw past the record read is exit 1, not a crash", async () => {
    // The verb's only route to exit 1, and the registry declares it. The record
    // read is guarded (the case above), so the unclassified throw has to come
    // from the LOCK read that follows it — reached through an injected store
    // that reads records from the real directory while reporting a `dir` that
    // is a regular file. `reclaimApprovalLock` then stats
    // `<file>/<runId>.approval.lock`, gets ENOTDIR, and rethrows raw: not
    // `no-record`, not `record-read-failed`, so it reaches `report()`
    // unclassified, which is exit 1 "the substrate failed, retry". Nothing was
    // mutated — the lock had not been touched — so a retry is the right advice.
    // (`report` DOES classify errno-carrying throws: an ENOTDIR off the same
    // read lands as exit 2. The throw here carries no errno, which is what an
    // unclassified substrate fault looks like.)
    store.create(RUN);
    const split = Object.assign(Object.create(store) as RunRecordStore, {
      get: (id: string) => store.get(id),
    }) as RunRecordStore;
    // `dir` is only read once — by the reclaim — and a getter keeps the record
    // read above on the REAL directory while the lock read below explodes.
    Object.defineProperty(split, "dir", {
      get: () => {
        throw new Error("lock volume on fire");
      },
    });
    const s = streams();
    const code = await run(["unlock", RUN, "--dir", dir], s.sink, { store: split }, s.errSink);
    expect(code).toBe(1);
    expect(envelopes(s.err).at(-1)?.message).toContain("lock volume on fire");
    // The record the verb DID read is untouched, and so is the runs root.
    expect(fs.existsSync(store.path(RUN))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${RUN}.approval.lock`))).toBe(false);
  });

  test("unlock: the lock WAS removed and its line could not print — exit 6, never a retryable 1", async () => {
    // 6 is declared by the registry and asserted nowhere else. The lock is
    // already gone when `reportCompletion` fires, so a lost line must never be
    // exit 1 "retry me" — it must not read as "nothing happened" either, which
    // is why the code differs from 0 at all. A retry is a harmless no-op that
    // reports `absent`, and that is exactly what separates 6 from 1 here: 1
    // promises a retry can still change something.
    store.create(RUN);
    const lock = path.join(dir, `${RUN}.approval.lock`);
    // Above every configured pid_max, so `kill(pid, 0)` can only raise ESRCH:
    // a provably-dead holder, which needs no --force.
    fs.writeFileSync(lock, "2147483647:dead-holder");
    const err: string[] = [];
    const code = await run(
      ["unlock", RUN, "--dir", dir],
      () => {
        throw new Error("EAGAIN: stdout would block");
      },
      { store },
      (s) => void err.push(s),
    );
    expect(code).toBe(6);
    expect(envelopes(err).at(-1)?.code).toBe("completion-unwritable");
    // …and the work really did land, which is what makes 6 the honest code.
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("unlock emits a gate event carrying the holder, the age and whether it was FORCED", async () => {
    // The audit trail D11 exists to create. The old age-door reclaimed with no
    // line at all, so a real occurrence was invisible and could only be
    // inferred; `forced: true` is the record that a human asserted what the host
    // could not prove.
    store.create(RUN);
    fs.writeFileSync(path.join(dir, `${RUN}.approval.lock`), `${process.pid}:still-working`);
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => void entries.push(e));
    try {
      const s = streams();
      expect(await run(["unlock", RUN, "--dir", dir, "--force"], s.sink, { store }, s.errSink)).toBe(0);
    } finally {
      restore();
    }
    const unlocked = entries.find((e) => (e as unknown as { event?: string }).event === "unlock") as unknown as
      | Record<string, unknown>
      | undefined;
    expect(unlocked).toMatchObject({ outcome: "reclaimed", state: "alive", forced: true, holderPid: process.pid });
    // A reclaim is a SUCCESS, so the line must not read as an error to a
    // dashboard keyed on `status` — the GATE_OK_OUTCOMES rule.
    expect(unlocked?.status).toBe("ok");
    expect(Number(unlocked?.lock_age_ms)).toBeGreaterThanOrEqual(0);
  });

  test("the gate event's `forced` rides THIS invocation's flag, never the successor's holder (F5.35)", async () => {
    // The `changed` outcome is a probe-unreachable interleaving: the lock the
    // verb inspected is replaced between `reclaimApprovalLock`'s first read and
    // its fenced removal, all inside one synchronous block, so no external
    // test can arrange it. Its audit fact is pinned on the two behaviours that
    // ARE reachable, plus one structural guard over the arm that is not.
    const source = await fs.promises.readFile(path.join(import.meta.dir, "../../scripts/fleet.ts"), "utf8");
    // BEHAVIOURAL, format-independent: the CLI derives the flag once (`--force`
    // in argv) and threads the SAME derived value into BOTH the reclaim call —
    // reclaiming only with the operator's asserted override — and the event.
    // Extract the unlock block, so a sibling verb's copy of the idiom cannot
    // satisfy this.
    const unlockStart = source.indexOf('verb === "unlock"');
    const unlockEnd = source.indexOf("// Unreachable through run()", unlockStart);
    expect(unlockStart).toBeGreaterThan(0);
    expect(unlockEnd).toBeGreaterThan(unlockStart);
    const unlock = source.slice(unlockStart, unlockEnd);
    const derived = unlock.match(/bools\.has\("--force"\)/g) ?? [];
    // The flag is read from argv — exactly once, at the derivation — and the
    // name the derivation binds to is what the reclaim call and the event both
    // receive. Re-deriving `forced` from `res.holder` anywhere in the block is
    // the D11 lie, banned by name regardless of spelling.
    expect(derived.length).toBe(1);
    const varName = unlock.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*bools\.has\("--force"\)/)?.[1];
    expect(varName).toBeDefined();
    expect(unlock).toContain(`reclaimApprovalLock(store.dir, runIdArg, ${varName})`);
    // The SAME derived flag reaches every operator-facing echo — the
    // completion line (spread into the changed outcome's fields), the gate
    // event (shorthand in the changed arm), and the refused arm (an explicit
    // `false`: nothing was reclaimed, so no override happened). Round-9
    // restructured the arms but kept the single derivation.
    expect(unlock).toMatch(new RegExp(`holder: res\\.holder, ${varName} \\}`));
    expect(unlock).toMatch(new RegExp(`^\\s*${varName},$`, "m"));
    expect(unlock).toContain("forced: false");
    // V9: the lie had ONE spelling pinned. `forced` is derived exactly once, so
    // ANY other `forced:` right-hand side in this block is a re-derivation —
    // from the reclaim result, from a fresh flag read, or from a comparison the
    // old regex happened to match. Every spelling is banned by name.
    expect(unlock).not.toMatch(/forced:\s*\w+\.holder\s*!==/);
    expect(unlock).not.toMatch(/forced:\s*\w+\.holder\s*===/);
    expect(unlock).not.toMatch(/forced:\s*res\./);
    expect(unlock).not.toMatch(/forced:\s*(?:bools|flags)\.has\(/);
    expect(unlock).not.toMatch(/forced:\s*!/);
    expect(unlock).not.toMatch(/forced:\s*true\b/);
    // …and the probe table above (gate-u-dead / gate-u-forced) pins the same
    // flag on both reachable outcomes' stdout.
  });
});

/**
 * DF3.4 deferred item D9 — `fleet enrol`, and the end-to-end proof that a
 * MINTED token is the one the decision path accepts.
 *
 * The classification arms live in verbs.test.ts's probe table against an
 * injected writer. These are the two codes a probe cannot reach, plus the
 * proof that matters most: a REAL subprocess mints a token into a REAL tmpdir
 * allowlist, and a second REAL subprocess spends it on `fleet approve` over
 * REAL stdin. Nothing about the credential is faked in that chain — which is
 * the whole point of D9, since the finding was that nothing enforced the
 * "machine-minted" assumption because nothing minted anything.
 */
describe("fleet enrol — the minted credential, end to end (D9)", () => {
  test("enrol: an untyped throw from the writer is exit 1, not a crash", async () => {
    const s = streams();
    const code = await run(
      ["enrol", "--approver", "alice"],
      s.sink,
      {
        enrol: () => {
          throw new Error("allowlist volume on fire");
        },
      },
      s.errSink,
    );
    // 1 is "the substrate failed, retry" — correct here, because an untyped
    // throw from the writer leaves nothing partially enrolled: the write is a
    // temp file plus a rename, so it either landed or it did not.
    expect(code).toBe(1);
    expect(envelopes(s.err).at(-1)?.message).toContain("allowlist volume on fire");
    expect(s.out.join("")).toBe("");
  });

  test("enrol: the entry LANDED and the minted token could not print — exit 6", async () => {
    // The worst line in this CLI to lose. The entry is already on disk, so the
    // allowlist now verifies a token NOBODY HOLDS — a retry would hit
    // `approver-already-enrolled`, which is exactly why this is 6 (an operator
    // action: `--rotate`) and never 1 (retry me).
    const err: string[] = [];
    const code = await run(
      ["enrol", "--approver", "alice"],
      () => {
        throw new Error("EAGAIN: stdout would block");
      },
      {
        enrol: () => ({ ok: true, approverId: "alice", token: "MINTED", path: "/tmp/x", replaced: false }),
      },
      (s) => void err.push(s),
    );
    expect(code).toBe(6);
    const codes = envelopes(err).map((e) => e.code);
    expect(codes).toContain("completion-unwritable");
    // …and the operator is told the credential is LOST, not merely that a line
    // did not print. The two are the same event and only one of them is
    // actionable.
    expect(codes).toContain("approver-token-unprintable");
    expect(envelopes(err).find((e) => e.code === "approver-token-unprintable")?.remediation).toContain("--rotate");
    // The token itself is NOT in any diagnostic — it is stdout's alone.
    expect(err.join("")).not.toContain("MINTED");
  });

  test("F7: `--out` writes the SAME token JSON to a 0600 file and stdout carries NO token", async () => {
    // The REAL writer against a tmpdir host root (`--dir` is the allowlist's
    // root, so nothing lands in this repo), because the property under test is
    // what the filesystem ends up holding. stdout is the captured channel the
    // flag exists to keep the token off: it may carry the CONFIRMATION only.
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-enrol-out-"));
    try {
      fs.mkdirSync(path.join(host, ".factory"), { mode: 0o700 });
      const tokenFile = path.join(host, "alice.token.json");
      const s = streams();
      const code = await run(["enrol", "--approver", "alice", "--dir", host, "--out", tokenFile], s.sink, {}, s.errSink);
      expect(code).toBe(0);
      expect(s.err.join("")).toBe("");
      // The confirmation line names the file and carries no credential.
      const printed = JSON.parse(s.out.join("").trim()) as Record<string, unknown>;
      expect(printed).toEqual({ approverId: "alice", allowlist: path.join(host, ".factory", "approvers.json"), writtenTo: tokenFile, replaced: false });
      // The file: same JSON shape the stdout path prints, including the token,
      // at the mode the registry note promises.
      const fileMode = fs.statSync(tokenFile).mode & 0o777;
      expect(fileMode).toBe(0o600);
      const written = JSON.parse(fs.readFileSync(tokenFile, "utf8")) as {
        approverId: string;
        token: string;
        allowlist: string;
        replaced: boolean;
        kdf: string;
      };
      expect(written.approverId).toBe("alice");
      expect(written.kdf).toBe("scrypt");
      expect(written.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The credential is real: it verifies against the allowlist just written.
      expect(authenticateApprover(host, "alice", written.token).ok).toBe(true);
      // …and the plaintext reached no other channel.
      expect(s.out.join("")).not.toContain(written.token);
      expect(fs.readFileSync(path.join(host, ".factory", "approvers.json"), "utf8")).not.toContain(written.token);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  test("F7: `--out` naming the allowlist itself is refused BEFORE anything is minted", async () => {
    // Writing the token over the allowlist would destroy every enrolled
    // credential while reporting a successful enrolment. The refusal is
    // pre-flight, so it is the truthful "nothing was mutated": no allowlist, no
    // entry, no token anywhere — and a re-run with a real `--out` works.
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-enrol-collide-"));
    try {
      fs.mkdirSync(path.join(host, ".factory"), { mode: 0o700 });
      const allowlist = path.join(host, ".factory", "approvers.json");
      const s = streams();
      const code = await run(["enrol", "--approver", "alice", "--dir", host, "--out", allowlist], s.sink, {}, s.errSink);
      expect(code).toBe(5);
      expect(envelopes(s.err).at(-1)).toMatchObject({ code: "approver-out-is-allowlist" });
      expect(s.out.join("")).toBe("");
      // Nothing was minted: the allowlist the flag pointed at does not exist.
      expect(fs.existsSync(allowlist)).toBe(false);
      // A RELATIVE spelling of the same file collides too — the check resolves,
      // it does not compare strings. The CLI resolves a relative `--out` from
      // ITS cwd, so this half runs with the host as the cwd.
      const prevCwd = process.cwd();
      process.chdir(host);
      try {
        const rel = streams();
        const relCode = await run(
          ["enrol", "--approver", "bob", "--dir", host, "--out", path.join(".factory", "approvers.json")],
          rel.sink,
          {},
          rel.errSink,
        );
        expect(relCode).toBe(5);
        expect(envelopes(rel.err).at(-1)).toMatchObject({ code: "approver-out-is-allowlist" });
      } finally {
        process.chdir(prevCwd);
      }
      expect(fs.existsSync(allowlist)).toBe(false);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  }, 30_000);

  test("a REAL minted token authenticates a REAL `fleet approve` over REAL stdin", async () => {
    // D9's verification, verbatim: "real allowlist files on a real filesystem:
    // enrol, authenticate … real `fleet approve` subprocess with a real token
    // over real stdin."
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-enrol-"));
    try {
      fs.mkdirSync(path.join(host, ".factory"), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(host, ".factory"), 0o700);
      // The DEFAULT runs location, so both subprocesses share ONE host root:
      // enrol runs flag-less (allowlist under cwd), and the approve below must
      // authenticate under the SAME root (round-9 C10 parity) — which with no
      // `--dir` is this cwd. A `--dir runsDir` here would point the allowlist
      // read at the runs dir and split the credential store the enrolment
      // just wrote.
      const runsDir = path.join(host, ".sandbox", "runs");
      fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });

      const fleet = path.join(import.meta.dir, "../../scripts/fleet.ts");
      // ── mint, in a real subprocess, with the host root as its cwd ──────────
      const enrolProc = Bun.spawn(["bun", fleet, "enrol", "--approver", "alice@example.test"], {
        cwd: host,
        env: { ...childEnv(), HOME: host },
        stdout: "pipe",
        stderr: "pipe",
      });
      const enrolOut = await new Response(enrolProc.stdout).text();
      const enrolErr = await new Response(enrolProc.stderr).text();
      expect(await enrolProc.exited).toBe(0);
      const enrolLines = enrolOut.trim().split("\n").filter(Boolean);
      const minted = JSON.parse(enrolLines.at(-1) as string) as {
        token: string;
        kdf: string;
        replaced: boolean;
      };
      expect(minted.kdf).toBe("scrypt");
      expect(minted.replaced).toBeFalse();
      // 256 bits of base64url, chosen by the factory and not by anybody.
      expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // THE TOKEN IS PRINTED ONCE. This is the only test where a REAL credential
      // exists, so the streams it must never reach are scanned here: the parse
      // above takes only the LAST stdout line, which would make an earlier
      // token-bearing line invisible, and stderr was previously never read at
      // all. ONCE is counted ON the mint line too — a token echoed twice there
      // (a confirmation field beside the payload) violates the property just
      // as an earlier line would.
      expect(enrolLines.slice(0, -1).join("\n")).not.toContain(minted.token);
      expect(enrolErr).not.toContain(minted.token);
      expect(enrolLines.at(-1)?.split(minted.token)).toHaveLength(2);
      // The allowlist really is on disk, really is 0600, and really is v2.
      const allowlistPath = path.join(host, ".factory", "approvers.json");
      expect(fs.statSync(allowlistPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(allowlistPath, "utf8")).approvers["alice@example.test"].v).toBe(2);
      // The PLAINTEXT is nowhere in the file. This is the property the whole
      // hashing scheme exists for, and it is cheap to assert.
      expect(fs.readFileSync(allowlistPath, "utf8")).not.toContain(minted.token);

      // ── a run parked at the gate, in that same host root ───────────────────
      const hostStore = new RunRecordStore({ dir: runsDir });
      hostStore.create(RUN);
      await requestApproval({ store: hostStore }, RUN, { proposal: "p", reportId: "rv-1", headSha: SHA });
      // The harvested bundle the decide path now requires (round-9 V1) — the
      // same staging `paused()` does in-process.
      fs.writeFileSync(path.join(runsDir, `${RUN}.bundle`), "bundle-bytes");

      // ── spend it: a real `fleet approve` with the token on real fd 0 ───────
      const tokenFile = path.join(host, "token");
      fs.writeFileSync(tokenFile, minted.token);
      // The fd is closed as soon as the child is spawned: leaving it open held
      // the file across the `finally`'s rmSync and stacked one fd per run.
      const tokenFd = fs.openSync(tokenFile, "r");
      const approveProc = Bun.spawn(["bun", fleet, "approve", RUN, "--approver", "alice@example.test"], {
        cwd: host,
        env: { ...childEnv(), HOME: host },
        stdin: tokenFd,
        stdout: "pipe",
        stderr: "pipe",
      });
      fs.closeSync(tokenFd);
      const approveOut = await new Response(approveProc.stdout).text();
      const approveErr = await new Response(approveProc.stderr).text();
      expect(await approveProc.exited).toBe(0);
      // The credential went IN on fd 0; neither stream may carry it back out —
      // the decision line was shape-checked but never scanned for this.
      expect(approveOut).not.toContain(minted.token);
      expect(approveErr).not.toContain(minted.token);
      expect(JSON.parse(approveOut.trim().split("\n").filter(Boolean).at(-1) as string)).toMatchObject({
        outcome: "decided",
        state: "approved",
        approverId: "alice@example.test",
      });
      // A clean decision writes NOTHING to stderr beyond its own structured
      // gate event — no warnings, no advisories. There is one entry shape, so
      // there is nothing to advise about.
      expect(approveErr).not.toContain("warning:");
      // The record really carries the decision DF5.2 gates the PR on.
      expect(hostStore.get(RUN).extensions?.approval).toMatchObject({
        state: "approved",
        approverId: "alice@example.test",
      });
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  }, 60_000);

  test("`fleet enrol --rotate` re-mints a REAL enrolment, and the old token dies", async () => {
    // The flag was parsed and then dropped: every remediation that named it
    // ("pass --rotate", "re-run with --rotate") sent the operator back to the
    // identical refusal. This drives the whole loop out of process so the
    // flag, the writer and the verifier are all real.
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-rotate-"));
    try {
      fs.mkdirSync(path.join(host, ".factory"), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(host, ".factory"), 0o700);
      const fleet = path.join(import.meta.dir, "../../scripts/fleet.ts");
      const enrol = async (
        extra: string[],
      ): Promise<{ code: number; out: string; err: string }> => {
        const proc = Bun.spawn(["bun", fleet, "enrol", "--approver", "ops@example.test", ...extra], {
          cwd: host,
          env: { ...childEnv(), HOME: host },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, out, err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code, out, err };
      };
      const lastLine = (out: string): { token: string; replaced: boolean } =>
        JSON.parse(out.trim().split("\n").filter(Boolean).at(-1) as string) as { token: string; replaced: boolean };

      const first = await enrol([]);
      expect(first.code).toBe(0);
      expect(lastLine(first.out).replaced).toBeFalse();

      // Without the flag: the exit-5 refusal whose remediation NAMES --rotate —
      // the instruction this test proves is now actionable.
      const dup = await enrol([]);
      expect(dup.code).toBe(5);
      expect(dup.err).toContain("approver-already-enrolled");
      expect(dup.err).toContain("--rotate");

      // With it: a NEW token, `replaced: true`, and the old token is dead.
      const rotated = await enrol(["--rotate"]);
      expect(rotated.code).toBe(0);
      const rotatedMinted = lastLine(rotated.out);
      expect(rotatedMinted.replaced).toBeTrue();
      expect(rotatedMinted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rotatedMinted.token).not.toBe(lastLine(first.out).token);
      // Printed once, on stdout only — the same stream rule the D9 test above
      // scans for the initial mint.
      expect(rotated.err).not.toContain(rotatedMinted.token);
      // The REAL verifier, against the REAL allowlist the subprocess wrote.
      expect(authenticateApprover(host, "ops@example.test", rotatedMinted.token).ok).toBe(true);
      expect(authenticateApprover(host, "ops@example.test", lastLine(first.out).token).ok).toBe(false);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  }, 60_000);
});
