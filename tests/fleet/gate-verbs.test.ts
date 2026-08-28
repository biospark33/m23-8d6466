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

/** An authenticated approver, injected — the token itself never enters a test. */
const authOk = (approverId = "alice"): Partial<FleetDeps> => ({
  authenticate: async () => ({ ok: true, approverId }),
});

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

  test("a malformed run id is refused before any store is built", async () => {
    const s = streams();
    const missing = path.join(dir, "nope");
    const code = await run(["approve", "NOT A RUN ID", "--approver", "alice", "--dir", missing], s.sink, authOk(), s.errSink);
    expect(code).toBe(2);
    // The id grammar refuses ahead of the --dir probe, and NEITHER created it.
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

  test("no envelope or log line carries a token-shaped secret", async () => {
    await paused();
    const s = streams();
    await run(["approve", RUN, "--approver", "alice", "--dir", dir], s.sink, authOk(), s.errSink);
    const all = s.out.join("") + s.err.join("");
    expect(all).not.toMatch(/token/i);
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
    const code = await run(["reject", RUN, "--approver", "bob", "--reason", "not yet", "--dir", dir], s.sink, authOk("bob"), s.errSink);
    expect(code).toBe(0);
    expect(store.get(RUN).extensions?.approval?.state).toBe("rejected");
  });

  test("a DUPLICATE decision is exit 0 and PRINTS THE FIRST — a success, not a refusal", async () => {
    await paused();
    const s1 = streams();
    await run(["approve", RUN, "--approver", "alice", "--reason", "first", "--dir", dir], s1.sink, authOk(), s1.errSink);
    const before = fs.readFileSync(store.path(RUN), "utf8");

    const s2 = streams();
    const code = await run(["reject", RUN, "--approver", "bob", "--reason", "second", "--dir", dir], s2.sink, authOk("bob"), s2.errSink);

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

  test("--reason is capped at 1000 chars", async () => {
    await paused();
    const s = streams();
    await run(["approve", RUN, "--approver", "alice", "--reason", "x".repeat(5_000), "--dir", dir], s.sink, authOk(), s.errSink);
    expect(String(store.get(RUN).extensions?.approval?.reason).length).toBeLessThanOrEqual(1_000);
  });
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
