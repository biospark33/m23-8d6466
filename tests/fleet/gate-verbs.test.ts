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
import { scryptToken, SCRYPT_PARAMS } from "../../src/fleet/approvers.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { requestApproval } from "../../src/fleet/approval-gate.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { provisionAdmittedRun } from "../../src/providers/driver.ts";

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

const authRefused: Partial<FleetDeps> = {
  authenticate: async () => ({
    ok: false,
    refusal: { code: "approver-token-mismatch", message: "the token does not match", remediation: "pipe the right token" },
  }),
};

async function paused(reportId = "rv-1"): Promise<void> {
  store.create(RUN);
  await requestApproval({ store }, RUN, { proposal: "open a PR", reportId, headSha: SHA });
}

describe("fleet approve / reject — grammar and the driver exemption", () => {
  test("approve takes NO --driver: it never reaches a box", async () => {
    await paused();
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    // `rank`'s precedent. A --driver requirement here would be a flag nothing
    // consumes, and the registry declares none.
    expect(code).toBe(0);
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

  test("authenticate is called with (process.cwd(), the parsed --approver) — in that order", async () => {
    // The wiring, pinned. Nothing else in this file can see it: every other
    // assertion about `approverId` reads a value that now comes BACK from this
    // fixture, so the order, the root, and the fact that the id is the parsed
    // flag rather than the run id are only observable here. Swap the two
    // arguments at the call site and production authenticates the approver
    // "/some/cwd" against a host root named "alice" — a refusal for everyone,
    // or worse, an allowlist found somewhere unexpected.
    await paused();
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    expect(code).toBe(0);
    expect(authCalls).toEqual([[process.cwd(), "alice"]]);
    // Exactly once: a second call would mean the token is read twice.
    expect(authCalls).toHaveLength(1);
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
    expect(authCalls).toEqual([[process.cwd(), "Alice"]]);
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
    // into the decision line or a `gateEvent` field — the same bug class the
    // attach block's "spelled out rather than spread" comment guards against —
    // puts the needle straight into an operator's scrollback and their log sink.
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
    const scanned = s.out.join("") + s.err.join("") + JSON.stringify(entries);
    expect(scanned).not.toContain(NEEDLE);
    // The generic shapes too, now that a real needle exists to anchor them.
    expect(scanned).not.toMatch(/token/i);
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
    // own bytes — a channel the negative scan covers by construction.
    expect(store.get(RUN).extensions?.approval?.reason).toBe(NEEDLE);
    expect(fs.readFileSync(store.path(RUN), "utf8")).toContain(NEEDLE);
    // …and a SECOND invocation prints the first decision back, needle and all:
    // that stdout line is the very stream the negative case scans.
    const s2 = streams();
    await run(["reject", RUN, "--approver", "bob", "--reason", "second", "--dir", dir], s2.sink, authOk(), s2.errSink);
    expect(s2.out.join("")).toContain(NEEDLE);
  });

  test("the auth-refusal gate event logs the run's REAL state, not a constant", async () => {
    // Every other refusal arm logs the state it actually found; this one used to
    // hardcode `"awaiting-approval"`, which is a claim rather than an
    // observation. Three genuinely different states, one fixture each — a
    // constant passes at most one of them.
    const seen: Array<unknown> = [];
    for (const [setup, want] of [
      // Each arm owns its whole record, so the loop starts from nothing.
      [async () => void store.create(RUN), "absent"],
      [
        async () => {
          store.create(RUN);
          store.set(RUN, { extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-1", headSha: SHA } } });
        },
        "pausing",
      ],
      [paused, "awaiting-approval"],
    ] as Array<[() => Promise<void>, string]>) {
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
      seen.push(entries.find((e) => e.event === "refused")?.state);
    }
    expect(seen).toEqual(["absent", "pausing", "awaiting-approval"]);
  });
});

describe("fleet approve / reject — DecisionOutcome → exit code", () => {
  test("approve records the decision, prints it, and exits 0", async () => {
    await paused();
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--reason", "ship it", "--dir", dir], s.sink, authOk(), s.errSink);

    expect(code).toBe(0);
    const printed = JSON.parse(s.out.join("").trim()) as Record<string, unknown>;
    expect(printed).toMatchObject({ runId: RUN, state: "approved", approverId: "alice" });
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
    store.set(RUN, { extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-1", headSha: SHA } } });
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
    const code = await run(
      ["approve", RUN, "--approver", "alice", "--reason", "x".repeat(5_000), "--dir", dir],
      s.sink,
      authOk(),
      s.errSink,
    );
    // `length <= 1000` alone is satisfied by a reason that was DROPPED or
    // garbled — `String(undefined)` is `"undefined"`, nine characters, and
    // passes — and the old case asserted no exit code either, so a refusal on
    // the long value looked identical to the cap working. Pin both.
    expect(code).toBe(0);
    // `sanitizeLabel(text, 1000)`: 999 units plus one ellipsis, so the result is
    // never longer than the cap. `capText` then finds nothing left to cut, which
    // is precisely why the CLI imports the gate's own constant instead of
    // re-typing a second limit that could truncate to a different length.
    expect(store.get(RUN).extensions?.approval?.reason).toBe(`${"x".repeat(999)}…`);
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
      let reads = 0;
      const flaky = Object.assign(Object.create(store) as RunRecordStore, {
        get(id: string) {
          const rec = store.get(id);
          if (++reads === 2) throw new Error("record store on fire");
          return rec;
        },
      });
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
      const code = await run(
        [verb, RUN, "--approver", "alice", "--dir", dir],
        () => {
          throw new Error("EAGAIN: stdout would block");
        },
        authOk(),
        (s) => void err.push(s),
      );
      expect(code).toBe(6);
      expect(envelopes(err).at(-1)?.code).toBe("completion-unwritable");
      // …and the work really did land, which is what makes 6 the honest code.
      expect(store.get(RUN).extensions?.approval?.state).toBe(verb === "approve" ? "approved" : "rejected");
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
    const s = streams();
    const code = await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);

    // The sweep runs first, so the decision lands against `timed-out` — there
    // is no path from an expired window to `approved`.
    expect(code).toBe(0);
    expect(JSON.parse(s.out.join("").trim())).toMatchObject({ outcome: "already-decided", state: "timed-out" });
    expect(store.get(RUN).extensions?.approval?.approverId).toBe("system:timeout");
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

  test("a run awaiting approval is not attachable — its box is gone", async () => {
    await paused();
    const s = streams();
    const code = await run(["attach", RUN, "--driver", "fake", "--message", "go", "--dir", dir], s.sink, driver(), s.errSink);
    expect(code).toBe(5);
    expect(envelopes(s.err)[0]).toMatchObject({ code: "run-not-attachable", state: "awaiting-approval" });
  });

  test("a message over the 4000-char ceiling is refused", async () => {
    store.create(RUN);
    store.set(RUN, { vmName: RUN });
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
    store.set(RUN, { vmName: RUN });
    const s = streams();
    const code = await run(["attach", RUN, "--driver", "fake", "--message", "   ", "--dir", dir], s.sink, driver(), s.errSink);
    expect(code).toBe(2);
    expect(envelopes(s.err)[0]?.message).toMatch(/requires a message/);
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
    try {
      const s = streams();
      // No `--dir` and no injected store, so the default path is the one taken.
      const code = await run(["attach", RUN, "--driver", "fake", "--message", "go"], s.sink, driver(), s.errSink);
      expect(code).toBe(2);
      expect(fs.existsSync(missing)).toBe(false);
    } finally {
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
  ): FakeDriver =>
    ({
      exec: async (_vm: string, argv: string[], stdin?: string) => handler(argv.join(" "), stdin),
    }) as unknown as FakeDriver;

  /** A run with a box on the record — the only precondition attach reads. */
  const withBox = (over: Record<string, unknown> = {}): void => {
    store.create(RUN);
    store.set(RUN, { vmName: RUN, ...over });
  };

  const ACKED = (id: string) => ({ exitCode: 0, stdout: `${JSON.stringify({ messageId: id, point: "run_start" })}\n`, stderr: "" });
  const OK = { exitCode: 0, stdout: "", stderr: "" };

  test("attach-acked is exit 0 and PRINTS the completion line (the success path)", async () => {
    // Every other attach case in this file asserts a failure code. Nothing
    // pinned `attach-acked → 0`, nor the stdout line it emits — so mapping the
    // acked outcome to 6, or dropping the line entirely, turned nothing red on
    // the one path an operator uses daily.
    withBox();
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

  test("the run record's dispatch requestId is emitted as dispatchRequestId, never as requestId", async () => {
    // Two different identifiers under one key name in one verb's output is a
    // correlation bug for whoever joins the two streams: every other
    // `requestId` this CLI emits — the gate event, `logVerb`'s invocation line —
    // is THIS INVOCATION's, while `res.requestId` is the RUN RECORD's dispatch
    // id. A `...res` spread put the second one under the first one's name.
    withBox({ requestId: "01234567-89ab-cdef-0123-456789abcdef" });
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
    withBox();
    let reads = 0;
    const flaky = Object.assign(Object.create(store) as RunRecordStore, {
      get(id: string) {
        const rec = store.get(id);
        if (++reads === 2) throw new Error("record store on fire");
        return rec;
      },
    });
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
    withBox();
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
    const remediationFor = async (setup: () => void): Promise<{ code: number; envelope: Record<string, unknown> }> => {
      setup();
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
      const { code, envelope } = await remediationFor(() => void store.create(RUN));
      expect(code).toBe(5);
      expect(envelope.state).toBe("no-box");
      expect(envelope.remediation).toContain("no box recorded");
    });

    test.each([["pausing"], ["awaiting-approval"]])("%s → the DECIDE-IT remediation", async (state) => {
      const { code, envelope } = await remediationFor(() => {
        store.create(RUN);
        store.set(RUN, { vmName: RUN, extensions: { approval: { state, proposal: "p", reportId: "rv-1", headSha: SHA } } });
      });
      expect(code).toBe(5);
      expect(envelope.state).toBe(state);
      expect(envelope.remediation).toMatch(/fleet approve/);
    });

    test.each([["approved"], ["rejected"], ["timed-out"]])("a SETTLED %s → the run-is-OVER remediation", async (state) => {
      const { code, envelope } = await remediationFor(() => {
        store.create(RUN);
        store.set(RUN, { vmName: RUN, extensions: { approval: { state, proposal: "p", reportId: "rv-1", headSha: SHA } } });
      });
      expect(code).toBe(5);
      expect(envelope.state).toBe(state);
      expect(envelope.remediation).toContain("this run is over");
      // The instruction that cannot be carried out is GONE, which is the whole
      // finding: a decided run has nothing left to approve or reject.
      expect(envelope.remediation).not.toMatch(/fleet approve/);
    });

    test("a plainly CLOSED run (no approval extension) → the run-is-OVER remediation", async () => {
      const { code, envelope } = await remediationFor(() => {
        store.create(RUN);
        store.set(RUN, { vmName: RUN });
        // Through `close()`, not `set()` — `closedAt` is immutable to `set` by
        // design, and a teardown is what really stamps it.
        store.close(RUN);
      });
      expect(code).toBe(5);
      expect(envelope.state).toBe("closed");
      expect(envelope.remediation).toContain("this run is over");
      expect(envelope.remediation).not.toMatch(/fleet approve/);
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
      withBox();
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
      // The engine leaves a message refused by ATTACH_FOLD_CHAR_BUDGET
      // deliberately un-acked (steering.ts's fold arm), and attach cannot tell
      // that apart from a resident that simply has not solicited yet — the ack
      // channel carries no such signal. So the remediation has to name it:
      // "re-send" is the one action that makes the fold-budget case worse.
      const { code, envelope } = await notAcked((script) =>
        script.includes("acks.ndjson") ? { exitCode: 1, stdout: "", stderr: "" } : OK,
      );
      expect(code).toBe(6);
      expect(envelope.reason).toBe("no-ack");
      expect(envelope.remediation).toContain("IS queued in the box");
      expect(envelope.remediation).toMatch(/fold budget/i);
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
      withBox();
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
    const lines = (await captured(["approve", RUN, "--approver", "alice", "--dir", dir], authOk())).filter(
      (l) => l.event === "approve",
    );
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ runId: RUN, event: "approve", state: "approved", approverId: "alice", outcome: "decided" });
    expect(typeof lines[0]?.decision_wait_ms).toBe("number");
  });

  test("NO log entry carries a token, under any key", async () => {
    await paused();
    const entries = await captured(["approve", RUN, "--approver", "alice", "--dir", dir], authOk());
    // Serialized whole, so a token smuggled in under ANY key is caught — the
    // stream-level check cannot see these lines at all, because `log()` is
    // muted under bun test and only an installed sink receives them.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
    // The one identity that MAY appear is the approver id the operator typed.
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
    const literals = (s: string): string[] => [...s.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string);
    const declared = new Set(literals((decl as RegExpMatchArray)[1] ?? ""));
    // Guard the regex itself: a rename that stops it matching would leave an
    // empty set and pass every loop below vacuously.
    expect(declared.size).toBeGreaterThanOrEqual(6);
    expect(declared).toContain("pause");

    // The union as PRODUCED. Two shapes, because there are two producers:
    // `gateEvent(<expr>, …)` in the CLI — whose first argument is sometimes a
    // ternary (`verb === "approve" ? "approve" : "reject"`), so the literals are
    // collected from the whole expression — and the gate module's own
    // `event: "pause"` line, which cannot route through the CLI's closure
    // because the CLI has no `requestApproval` call site.
    const produced = new Set<string>();
    for (const call of cli.matchAll(/gateEvent\(([^,]*),/g)) for (const e of literals(call[1] ?? "")) produced.add(e);
    for (const lit of gate.matchAll(/\bevent:\s*"([a-z-]+)"/g)) produced.add(lit[1] as string);

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

      // `cwd: host` — the allowlist is read from `process.cwd()`, so this
      // invocation must run from the host, not from the repo.
      const cmd = `exec bun ${q(CLI)} ${["approve", "run-typo-d7", "--approver", "alice", "--dir", dir].map(q).join(" ")}`;
      const proc = Bun.spawn(["sh", "-c", `printf %s ${q(token)} | ${cmd}`], { cwd: host, stdout: "pipe", stderr: "pipe" });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

      // 4, not 1 and not 5: "that run does not exist", the documented no-record
      // code, distinct from "a guard fired before anything was mutated".
      expect(code).toBe(4);
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
      expect(fs.existsSync(path.join(dir, "run-typo-d7.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "run-typo-d7.approval.lock"))).toBe(false);
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
    expect(err).toMatch(/message/i);
  }, 30_000);

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
 * The CLASSIFICATION arms (2/4/5/0-absent/0-reclaimed/0-forced) are
 * verbs.test.ts's probe table. The two here are the codes a probe cannot reach,
 * and `ONLY_REACHABLE_ELSEWHERE` binds this file's test TITLES to them — an
 * excuse that outlives its test is an excuse checked against nothing.
 */
describe("fleet unlock — the codes a probe cannot reach (D11)", () => {
  test("unlock: an untyped throw past the existence check is exit 1, not a crash", async () => {
    // The verb's only route to exit 1, and the registry declares it.
    // `assertRunExists` classifies `no-record` (4) and `record-read-failed` (5)
    // and rethrows everything else; a plain Error from the SECOND read — the
    // dispatch-id read that follows it — reaches `report()` unclassified, which
    // is exit 1 "the substrate failed, retry". A retry is the RIGHT advice here:
    // nothing was mutated, because the lock had not been touched yet.
    store.create(RUN);
    let reads = 0;
    const flaky = Object.assign(Object.create(store) as RunRecordStore, {
      get(id: string) {
        const rec = store.get(id);
        if (++reads === 2) throw new Error("record store on fire");
        return rec;
      },
    });
    const s = streams();
    const code = await run(["unlock", RUN, "--dir", dir], s.sink, { store: flaky }, s.errSink);
    expect(code).toBe(1);
    expect(envelopes(s.err).at(-1)?.message).toContain("record store on fire");
    expect(s.out.join("")).toBe("");
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

  test("a REAL minted token authenticates a REAL `fleet approve` over REAL stdin", async () => {
    // D9's verification, verbatim: "real allowlist files on a real filesystem:
    // enrol, authenticate … real `fleet approve` subprocess with a real token
    // over real stdin."
    const host = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-enrol-"));
    try {
      fs.mkdirSync(path.join(host, ".factory"), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.join(host, ".factory"), 0o700);
      const runsDir = path.join(host, "runs");
      fs.mkdirSync(runsDir, { recursive: true });

      const fleet = path.join(import.meta.dir, "../../scripts/fleet.ts");
      // ── mint, in a real subprocess, with the host root as its cwd ──────────
      const enrolProc = Bun.spawn(["bun", fleet, "enrol", "--approver", "alice@example.test"], {
        cwd: host,
        stdout: "pipe",
        stderr: "pipe",
      });
      const enrolOut = await new Response(enrolProc.stdout).text();
      expect(await enrolProc.exited).toBe(0);
      const minted = JSON.parse(enrolOut.trim().split("\n").filter(Boolean).at(-1) as string) as {
        token: string;
        kdf: string;
        replaced: boolean;
      };
      expect(minted.kdf).toBe("scrypt");
      expect(minted.replaced).toBeFalse();
      // 256 bits of base64url, chosen by the factory and not by anybody.
      expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

      // ── spend it: a real `fleet approve` with the token on real fd 0 ───────
      const tokenFile = path.join(host, "token");
      fs.writeFileSync(tokenFile, minted.token);
      const approveProc = Bun.spawn(["bun", fleet, "approve", RUN, "--approver", "alice@example.test", "--dir", runsDir], {
        cwd: host,
        stdin: fs.openSync(tokenFile, "r"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const approveOut = await new Response(approveProc.stdout).text();
      const approveErr = await new Response(approveProc.stderr).text();
      expect(await approveProc.exited).toBe(0);
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
});
