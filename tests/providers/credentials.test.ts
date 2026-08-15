/**
 * DF2.3 — per-run credential lifecycle tests.
 *
 * Every AC maps to a test here. The reference justfiles shipped unrun upstream
 * (story deviation note), so these are the blocking evidence, not inherited
 * behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRun } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import {
  SBX_KEY_PREFIX,
  CredentialLifecycleError,
  captureSpend,
  defaultKeyCapMicroUsd,
  deliverRunKey,
  mintRunKey,
  openRouterKeyApi,
  revokeAndVerify,
  runCredentialLifecycle,
  verifyRevoked,
  type CredentialDeps,
} from "../../src/providers/credentials.ts";
import { FakeKeyApi } from "./fixtures/fake-key-api.ts";
import { RecordingDriver } from "./fixtures/recording-driver.ts";

let dir: string;
let store: RunRecordStore;
let api: FakeKeyApi;
let recording: RecordingDriver;
let driver: FakeDriver;
let logs: LogEntry[];
let restoreLog: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-cred-"));
  store = new RunRecordStore(join(dir, "runs"));
  api = new FakeKeyApi();
  driver = new FakeDriver(join(dir, "boxes"));
  recording = new RecordingDriver(driver);
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  restoreLog?.();
  rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<CredentialDeps> = {}): CredentialDeps {
  // fake boxes are plain host dirs — deliver to a box-relative path
  return { keyApi: api, driver: recording, store, envFile: "app/.env", ...overrides };
}

/** Any >=8-char substring of the secret found in any corpus, else null. */
function leakScan(secret: string, ...corpora: string[]): string | null {
  for (let i = 0; i + 8 <= secret.length; i++) {
    const frag = secret.slice(i, i + 8);
    for (const corpus of corpora) {
      if (corpus.includes(frag)) return frag;
  }
  }
  return null;
}

async function makeRun(runId: string): Promise<string> {
  const rec = await createRun(recording, store, { runId });
  return rec.vmName ?? runId;
}

describe("DF2.3 credential lifecycle", () => {
  test("defaultKeyCapMicroUsd is the documented 50_000_000 µ$ backstop", () => {
    expect(defaultKeyCapMicroUsd).toBe(50_000_000);
  });

  test("e2e (MANDATORY): full lifecycle leaves an OPEN record, populated fields, absent key, zero plaintext leakage", async () => {
    const spendApi = new FakeKeyApi({ usageOnCreateUsd: 0.0081, zeroUsageOnDelete: true });
    api = spendApi;
    const runId = "df23-e2e";
    await makeRun(runId);

    await runCredentialLifecycle(deps(), runId);

    const rec = store.get(runId);
    expect(rec.keyHash).toBeString();
    expect(rec.limitMicroUsd).toBe(50_000_000);
    // spend was captured before the DELETE zeroed usage
    expect(rec.spendMicroUsd).toBe(8100);
    // closure is DF2.5 teardown's last step — record stays open
    expect(rec.closedAt).toBeUndefined();

    // hash absent from the authoritative list afterwards
    const list = await api.listAllKeys(20);
    expect(list.entries.some((k) => k.hash === rec.keyHash)).toBeFalse();

    // VM alive: nothing in this story destroys a box
    const vms = await driver.list();
    expect(vms.some((v) => v.name === runId)).toBeTrue();

    // zero plaintext: record file, every log line, every recorded argv
    const secret = api.plaintexts.get(rec.keyHash ?? "");
    expect(secret).toBeString();
    const argvCorpus = recording.execCalls.map((c) => c.argv.join(" ")).join("\n");
    const leak = leakScan(secret as string, readFileSync(store.path(runId), "utf8"), JSON.stringify(logs), argvCorpus);
    expect(leak).toBeNull();
  });

  test("AC1 negative control: a double that zeroes usage post-delete still yields non-zero spend", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.5, zeroUsageOnDelete: true });
    const runId = "df23-spend";
    await makeRun(runId);
    await runCredentialLifecycle(deps(), runId);
    const rec = store.get(runId);
    expect(rec.spendMicroUsd).toBe(500_000);
    expect(api.usageOf(rec.keyHash as string)).toBe(0);
  });

  test("AC2: 200-for-dead-key — single-key endpoint says 200, verifyRevoked still passes via the list", async () => {
    const runId = "df23-deadkey";
    await makeRun(runId);
    await runCredentialLifecycle(deps(), runId);
    const hash = store.get(runId).keyHash as string;
    // the MEASURED provider behaviour our gate must not rely on
    expect(api.singleKeyEndpointStatus(hash)).toBe(200);
    await verifyRevoked(deps(), runId);
  });

  test("AC2: stale list — DELETE 2xx but hash still listed ⇒ fail, VM alive, record open, curl remediation printed", async () => {
    api = new FakeKeyApi({ staleListAfterDelete: true });
    const runId = "df23-stale";
    await makeRun(runId);
    let err: unknown;
    try {
      await runCredentialLifecycle(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    const cle = err as CredentialLifecycleError;
    expect(cle.code).toBe("still-listed");
    expect(cle.remediation).toContain("curl -X DELETE");
    // env var referenced by NAME, never expanded
    expect(cle.remediation).toContain("$OPENROUTER_PROVISIONING_KEY");
    expect(cle.remediation).not.toContain("sk-or-");
    expect((await driver.list()).some((v) => v.name === runId)).toBeTrue();
    expect(store.get(runId).closedAt).toBeUndefined();
  });

  test("AC3: DELETE 404 with the hash genuinely absent ⇒ already-revoked, idempotent re-run", async () => {
    const runId = "df23-404";
    await makeRun(runId);
    // first lifecycle revokes for real
    await runCredentialLifecycle(deps(), runId);
    // second DELETE hits 404 — still fine because the list confirms absence
    await revokeAndVerify(deps(), store.get(runId).keyHash as string);
    await revokeAndVerify(deps(), store.get(runId).keyHash as string);
    expect(store.get(runId).closedAt).toBeUndefined();
  });

  test("AC3 negative control: 404 while the hash is STILL listed must never read as revocation", async () => {
    api = new FakeKeyApi({ deleteStatus: 404 });
    const runId = "df23-404-live";
    await makeRun(runId);
    let err: unknown;
    try {
      await runCredentialLifecycle(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("still-listed");
  });

  test("AC3: DELETE 5xx ⇒ hard failure, VM untouched, record open, next command printed", async () => {
    api = new FakeKeyApi({ deleteStatus: 500 });
    const runId = "df23-500";
    await makeRun(runId);
    let err: unknown;
    try {
      await runCredentialLifecycle(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    const cle = err as CredentialLifecycleError;
    expect(cle.code).toBe("revoke-failed");
    expect(cle.remediation).toContain("curl -X DELETE");
    expect((await driver.list()).some((v) => v.name === runId)).toBeTrue();
    expect(store.get(runId).closedAt).toBeUndefined();
    // spend was still captured before the failed revoke
    expect(store.get(runId).spendMicroUsd).toBe(0);
  });

  test("AC4: empty key list verifies; a truncated page fails closed as list-unverified", async () => {
    const runId = "df23-empty";
    await makeRun(runId);
    // mint nothing extra; revoke the run key so the list is empty
    await revokeAndVerify(deps(), await mintFor(runId));
    await verifyRevoked(deps(), runId); // empty list ⇒ absence verified

    // now a list that cannot be enumerated within the page budget
    const manyApi = new FakeKeyApi({ pageSize: 1 });
    api = manyApi;
    for (let i = 0; i < 25; i++) await manyApi.createKey(`${SBX_KEY_PREFIX}filler-${i}`, 1);
    let err: unknown;
    try {
      await verifyRevoked(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("list-unverified");
  });

  test("AC5: no >=8-char secret substring in any recorded argv; remote file mode 600 by stat", async () => {
    const runId = "df23-deliver";
    await makeRun(runId);
    await runCredentialLifecycle(deps(), runId);
    const secret = api.plaintexts.get(store.get(runId).keyHash as string) as string;
    const corpus = recording.execCalls.map((c) => c.argv.join(" ")).join("\n");
    expect(leakScan(secret, corpus)).toBeNull();
    expect(leakScan(secret, JSON.stringify(logs))).toBeNull();
    // every exec that carried stdin (the delivery) touched only the env file
    const deliveries = recording.execCalls.filter((c) => c.hadStdin);
    expect(deliveries.length).toBeGreaterThan(0);
    // independent stat of the delivered file — never reading its value back
    const r = await driver.exec(runId, [
      "sh",
      "-c",
      `python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])' app/.env`,
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("600");
  });

  test("AC6: 50_000_000 µ$ cap crosses the wire as 50 dollars and returns as µ$; spend round-trips", async () => {
    api = new FakeKeyApi({ usageOnCreateUsd: 0.0081 });
    const runId = "df23-units";
    await makeRun(runId);
    await runCredentialLifecycle(deps(), runId);
    const create = api.requests.find((r) => r.method === "POST" && r.path === "/keys");
    expect(create).toBeDefined();
    expect(create?.limitUsd).toBe(50); // dollars on the wire, never 50_000_000
    expect(create?.name).toBe(`${SBX_KEY_PREFIX}${runId}`);
    const rec = store.get(runId);
    expect(rec.limitMicroUsd).toBe(50_000_000); // µ$ in the record, never 50.00
    expect(rec.spendMicroUsd).toBe(8100); // 0.0081 USD -> 8_100 µ$
  });

  test("INV-CRED-6: revokeAndVerify refuses a key without the sbx- prefix and never issues its DELETE", async () => {
    const personal = await api.createKey("mac-mini-agent", 10);
    let err: unknown;
    try {
      await revokeAndVerify(deps(), personal.hash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("prefix-refused");
    expect(api.requests.some((r) => r.method === "DELETE" && r.path === `/keys/${personal.hash}`)).toBeFalse();
  });

  test("INV-CRED-6 fail-closed: an unenumerable list disarms the prefix guard ⇒ refusal, never a blind DELETE", async () => {
    // pageSize 1 with >20 keys: the entry cannot be found within the page budget
    const manyApi = new FakeKeyApi({ pageSize: 1 });
    api = manyApi;
    for (let i = 0; i < 25; i++) await manyApi.createKey(`${SBX_KEY_PREFIX}filler-${i}`, 1);
    const personal = await manyApi.createKey("mac-mini-agent", 10);
    let err: unknown;
    try {
      await revokeAndVerify(deps(), personal.hash);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("list-unverified");
    expect(manyApi.requests.some((r) => r.method === "DELETE" && r.path === `/keys/${personal.hash}`)).toBeFalse();
  });

  test("captureSpend refuses to record 0 when the list is unenumerable", async () => {
    api = new FakeKeyApi({ pageSize: 1, usageOnCreateUsd: 0.5 });
    const runId = "df23-spend-unverified";
    await makeRun(runId);
    for (let i = 0; i < 25; i++) await api.createKey(`${SBX_KEY_PREFIX}filler-${i}`, 1);
    let err: unknown;
    try {
      await runCredentialLifecycle(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("list-unverified");
    // spend was never written — an authoritative-looking 0 must not exist
    expect(store.get(runId).spendMicroUsd).toBeUndefined();
    // keyHash IS written (mint ran); the record stays open, the VM stays alive
    expect(store.get(runId).keyHash).toBeString();
    expect((await driver.list()).some((v) => v.name === runId)).toBeTrue();
  });

  test("security: a shell-metacharacter or .. envFile is refused before any script is built", async () => {
    const runId = "df23-envfile";
    await makeRun(runId);
    const minted = await mintRunKey(deps(), runId);
    for (const bad of ["app/.env; touch /tmp/pwned", "app/$(whoami).env", "../../etc/passwd", ""]) {
      let err: unknown;
      try {
        await deliverRunKey(deps({ envFile: bad }), "vm-df23-envfile", minted.key);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CredentialLifecycleError);
      expect((err as CredentialLifecycleError).code).toBe("env-file-invalid");
    }
    // nothing was ever exec'd with a forged script
    expect(recording.execCalls).toHaveLength(0);
  });

  test("security: a non-positive or non-integer cap is refused before the provider is called", async () => {
    const runId = "df23-cap";
    await makeRun(runId);
    for (const bad of [0, -5, 12.5]) {
      let err: unknown;
      try {
        await mintRunKey(deps({ capMicroUsd: bad }), runId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CredentialLifecycleError);
      expect((err as CredentialLifecycleError).code).toBe("cap-invalid");
    }
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("one live key per run: minting over an existing keyHash is refused", async () => {
    const runId = "df23-remint";
    await makeRun(runId);
    await runCredentialLifecycle(deps(), runId);
    let err: unknown;
    try {
      await mintRunKey(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("already-minted");
    expect((err as CredentialLifecycleError).remediation).toContain("curl -X DELETE");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  test("INV-CRED-5: failed mint leaves the VM (visible, cheap) alive and the record open without a keyHash", async () => {
    api = new FakeKeyApi({ createStatus: 401 });
    const runId = "df23-mintfail";
    await makeRun(runId);
    let err: unknown;
    try {
      await runCredentialLifecycle(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((await driver.list()).some((v) => v.name === runId)).toBeTrue();
    const rec = store.get(runId);
    expect(rec.keyHash).toBeUndefined();
    expect(rec.closedAt).toBeUndefined();
  });

  test("INV-CRED-2: openRouterKeyApi hard-exits on a missing provisioning key, by env-var name only", () => {
    const had = process.env.OPENROUTER_PROVISIONING_KEY;
    // delete is the only correct way to restore "not set" for the env probe.
    // biome-ignore lint/performance/noDelete: see above
    delete process.env.OPENROUTER_PROVISIONING_KEY;
    try {
      expect(() => openRouterKeyApi()).toThrow("OPENROUTER_PROVISIONING_KEY");
    } finally {
      if (had !== undefined) process.env.OPENROUTER_PROVISIONING_KEY = had;
    }
  });

  test("observability: lifecycle logs carry step, keyHashPrefix, durationMs, outcome and sub-timings", async () => {
    const runId = "df23-obs";
    await makeRun(runId);
    await runCredentialLifecycle(deps(), runId);
    const hash = store.get(runId).keyHash as string;
    const steps = logs.filter((l) => String(l.operation).startsWith("credential."));
    const names = steps.map((l) => l.step);
    for (const expected of ["mint", "deliver", "capture_spend", "revoke", "verify"]) {
      expect(names).toContain(expected);
    }
    for (const l of steps) {
      expect(l.outcome).toBe("ok");
      expect(typeof l.durationMs).toBe("number");
      if (l.keyHashPrefix) expect(l.keyHashPrefix).toBe(hash.slice(0, 8));
    }
    const timings = ["mint_ms", "deliver_ms", "capture_spend_ms", "revoke_ms", "verify_ms"];
    for (const t of timings) {
      expect(steps.some((l) => l[t] !== undefined)).toBeTrue();
    }
  });

  test("orphan prevention: a failed delivery after a successful mint is compensated by revoke+verify", async () => {
    const runId = "df23-deliver-orphan";
    await makeRun(runId);
    // exec fails for every call after the box-create phase: the mint succeeded,
    // the delivery cannot reach the box.
    const failing = Object.create(recording) as typeof recording;
    failing.exec = () => Promise.reject(new Error("box unreachable"));
    let err: unknown;
    try {
      await runCredentialLifecycle(deps({ driver: failing }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("box unreachable");
    // the minted key was revoked and verified absent — not stranded live
    const hash = store.get(runId).keyHash as string;
    expect(hash).toBeString();
    const list = await api.listAllKeys(20);
    expect(list.entries.some((k) => k.hash === hash)).toBeFalse();
    expect(list.truncated).toBeFalse();
  });

  test("orphan prevention: an invalid envFile is refused by the lifecycle BEFORE any mint", async () => {
    const runId = "df23-envfile-early";
    await makeRun(runId);
    let err: unknown;
    try {
      await runCredentialLifecycle(deps({ envFile: "app/.env; touch /tmp/pwned" }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("env-file-invalid");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(store.get(runId).keyHash).toBeUndefined();
  });

  test("INV-CRED-1: an uncapped mint is refused AND its keyHash stays recorded for revoke", async () => {
    api = new FakeKeyApi({ returnedLimitUsd: null });
    const runId = "df23-uncapped";
    await makeRun(runId);
    let err: unknown;
    try {
      await runCredentialLifecycle(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("uncapped-key");
    // the refused-but-live key is RECORDED — an unrecorded live key is the orphan
    const hash = store.get(runId).keyHash;
    expect(hash).toBeString();
    // and the record is enough to reach it: revokeRunKey reads keyHash
    await revokeAndVerify(deps(), hash as string);
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
  });

  test("INV-CRED-1: a malformed limit (0/NaN) is refused like an uncapped one", async () => {
    for (const [i, bad] of [0, Number.NaN].entries()) {
      api = new FakeKeyApi({ returnedLimitUsd: bad });
      const runId = `df23-badlimit-${i}`;
      await makeRun(runId);
      let err: unknown;
      try {
        await mintRunKey(deps(), runId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CredentialLifecycleError);
      expect((err as CredentialLifecycleError).code).toBe("uncapped-key");
      expect(store.get(runId).keyHash).toBeString();
    }
  });

  test("captureSpend on a key absent from a fully-enumerated list records nothing, returns last spend", async () => {
    const runId = "df23-absent";
    await makeRun(runId);
    const hash = await mintFor(runId);
    // revoked out-of-band: absent from the list, but the list IS enumerable
    await api.deleteKey(hash);
    const spend = await captureSpend(deps(), runId);
    expect(spend).toBe(0); // nothing was ever stored — no authoritative 0 written
    expect(store.get(runId).spendMicroUsd).toBeUndefined();
  });

  test("fixture fidelity: exactly-maxPages full pages is truncation — only a budgeted empty page proves exhaustion", async () => {
    const boundary = new FakeKeyApi({ pageSize: 1 });
    for (let i = 0; i < 4; i++) await boundary.createKey(`${SBX_KEY_PREFIX}b-${i}`, 1);
    const exact = await boundary.listAllKeys(4);
    expect(exact.truncated).toBeTrue(); // 4 full pages, no budget for the empty proof page
    expect(exact.entries).toHaveLength(4);
    const roomy = await boundary.listAllKeys(5);
    expect(roomy.truncated).toBeFalse();
    expect(roomy.entries).toHaveLength(4);
  });
});

describe("openRouterKeyApi (production client, fetch double)", () => {
  const realFetch = globalThis.fetch;

  /** Minimal fetch double — Bun's typeof fetch demands preconnect etc. */
  function setFetch(fn: (input?: unknown) => Promise<Response>): void {
    globalThis.fetch = fn as unknown as typeof fetch;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    // delete is the only correct way to restore "not set" for an env probe.
    // biome-ignore lint/performance/noDelete: see above
    delete process.env.QDS_TEST_PROVISIONING_KEY;
  });

  function client(): ReturnType<typeof openRouterKeyApi> {
    process.env.QDS_TEST_PROVISIONING_KEY = "prov-key";
    return openRouterKeyApi({ provisioningKeyEnv: "QDS_TEST_PROVISIONING_KEY" });
  }

  test("POST /keys is never retried on transport failure — one attempt only", async () => {
    const api = client();
    let calls = 0;
    setFetch(async () => {
      calls++;
      throw new Error("connection reset");
    });
    let err: unknown;
    try {
      await api.createKey("sbx-x", 50);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("transport");
    expect(calls).toBe(1);
  });

  test("GET retries transport failures then succeeds; non-Error rejections yield readable text", async () => {
    const api = client();
    let calls = 0;
    setFetch(async () => {
      calls++;
      if (calls < 3) throw "network glitch"; // non-Error rejection value
      return jsonResponse({ data: [] });
    });
    const list = await api.listAllKeys(20);
    expect(list.truncated).toBeFalse();
    expect(list.entries).toHaveLength(0);
    expect(calls).toBe(3);
  });

  test("GET exhausts retries on a persistent non-Error rejection, message keeps the raw text", async () => {
    const api = client();
    let calls = 0;
    setFetch(async () => {
      calls++;
      throw "network glitch"; // non-Error rejection value, every attempt
    });
    let err: unknown;
    try {
      await api.listAllKeys(20);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("transport");
    expect((err as CredentialLifecycleError).message).toContain("network glitch");
    expect((err as CredentialLifecycleError).message).toContain("3 attempts");
    expect(calls).toBe(3);
  });

  test("pagination walks to the EMPTY page and advances offset by page length", async () => {
    const api = client();
    const offsets: number[] = [];
    setFetch(async (input: unknown) => {
      const url = new URL(String(input));
      offsets.push(Number(url.searchParams.get("offset")));
      const page = offsets.length;
      return jsonResponse(page === 1 ? { data: [{ hash: "h1", name: "sbx-a", usage: 0.5 }] } : { data: [] });
    });
    const list = await api.listAllKeys(20);
    expect(list.truncated).toBeFalse();
    expect(list.entries).toHaveLength(1);
    expect(offsets).toEqual([0, 1]);
  });

  test("limit normalization: null stays null, numeric strings convert, usage passes through", async () => {
    for (const [wire, expected] of [[null, null], ["50", 50], [12.5, 12.5]] as const) {
      const api = client();
      setFetch(async () =>
        jsonResponse({ data: { key: "sk-or-1", hash: "h1", limit: wire, usage: 0.0081 } }));
      const res = await api.createKey("sbx-x", 50);
      expect(res.limitUsd).toBe(expected);
      expect(res.usageUsd).toBe(0.0081);
    }
  });

  test("a non-JSON body fails as response-unparseable without leaking body text", async () => {
    const api = client();
    setFetch(async () => new Response("<html>secret-key-echo</html>", { status: 200 }));
    let err: unknown;
    try {
      await api.createKey("sbx-x", 50);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    const cle = err as CredentialLifecycleError;
    expect(cle.code).toBe("response-unparseable");
    expect(cle.message).not.toContain("secret-key-echo");
  });

  test("deleteKey URL-encodes the hash as a single path segment", async () => {
    const api = client();
    let deletedPath = "";
    setFetch(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/keys/")) deletedPath = `/${url.pathname.split("/").pop()}`;
      return jsonResponse({ data: [] });
    });
    await api.deleteKey("a b/c?x=1");
    expect(deletedPath).toBe("/a%20b%2Fc%3Fx%3D1");
  });
});

/** Mint a key for runId without running the whole lifecycle (test helper). */
async function mintFor(runId: string): Promise<string> {
  const res = await api.createKey(`${SBX_KEY_PREFIX}${runId}`, 50);
  store.set(runId, { keyHash: res.hash, limitMicroUsd: 50_000_000 });
  return res.hash;
}
