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
  KEY_ENV_FILE,
  mintRunKey,
  openRouterKeyApi,
  revokeAndVerify,
  revokeRunKey,
  runCredentialLifecycle,
  verifyRevoked,
  type CredentialDeps,
  type KeyApi,
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

  test("KEY_ENV_FILE is HOME-relative (F3, 2026-08-24): the real image's ssh HOME is the only writable root", () => {
    // /home/agent/app/.env pinned the inkwell-era layout; the real exe.dev
    // image ships no /home/agent and /home is root-owned, so every default
    // delivery failed at mkdir. Relative "app/.env" resolves against the ssh
    // HOME (where every driver exec lands) and stays a SIBLING of the fill
    // clone dir "src" — the separation contract in fill.ts holds.
    expect(KEY_ENV_FILE).toBe("app/.env");
    expect(KEY_ENV_FILE.startsWith("/")).toBe(false);
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

  // A base64-ish provider hash: 40+ chars of mixed case and digits, i.e. exactly
  // the shape the long-token redactor exists to catch. It is an IDENTIFIER, not
  // key material (DF2.1 persists it in the plaintext record).
  const MIXED_CASE_HASH = "RGvhoNKDIZzsKKEoJm2Y7CDsY2m1S91GtNb3jvbXbfg";

  test("AC3: the revoke-failed line keeps the FULL keyHash — the operator's only handle on a still-live key", async () => {
    // keyHashPrefix carries 8 chars, which names no key you can revoke by hand,
    // and this is the one line whose whole content is "the key may still be
    // live". A redacted hash here leaves a billing key nobody can find.
    api = new FakeKeyApi({ returnedHash: MIXED_CASE_HASH, deleteStatus: 500 });
    const runId = "df23-revoke-failed-hash";
    await makeRun(runId);
    await expect(runCredentialLifecycle(deps(), runId)).rejects.toThrow();

    const line = logs.find((l) => l.operation === "credential.revoke" && l.status === "error");
    expect(line).toBeDefined();
    expect(line?.error?.code).toBe("revoke-failed");
    expect(line?.error?.message).toContain(MIXED_CASE_HASH);
    // The remediation is a LIVE key-management deep link, and the deep-link arm
    // now runs on the genuinely untouched text — it used to run AFTER `keep` was
    // parked, where the mark's guillemets fell outside `KEY_MANAGEMENT_URL_RE`'s
    // tail charset and blinded it to every `…/keys/<id>` whose id merely
    // CONTAINED `keep`. So this line's copy-paste curl goes. The hash — the
    // thing the operator actually needs — still reaches them three other ways:
    // the message above, the `keyHashPrefix` field, and the THROWN
    // CredentialLifecycleError's remediation, which redaction never touches
    // (pinned by the "curl remediation printed" tests above).
    expect(line?.remediation).toContain("[REDACTED]");
    expect(line?.remediation).toContain("$OPENROUTER_PROVISIONING_KEY");
  });

  test("AC3 control: the same line still redacts real key material standing beside the kept hash", async () => {
    // Proves the exemption is the hash alone and not a hole in the redactor:
    // a transport wrapper reporting the request it made embeds the
    // Authorization header, so the DELETE's own error text can carry the key.
    api = new FakeKeyApi({ returnedHash: MIXED_CASE_HASH });
    const runId = "df23-revoke-failed-control";
    await makeRun(runId);
    const minted = await mintRunKey(deps(), runId);
    const leaky: KeyApi = {
      createKey: (n, l) => api.createKey(n, l),
      listAllKeys: (m) => api.listAllKeys(m),
      getKeyEntry: (h, m) => api.getKeyEntry(h, m),
      deleteKey: async () => {
        throw new CredentialLifecycleError(
          "transport",
          `DELETE ${MIXED_CASE_HASH} -H 'Authorization: Bearer ${minted.key}' failed`,
          `retry with $OPENROUTER_PROVISIONING_KEY against ${MIXED_CASE_HASH}`,
        );
      },
    };
    await expect(revokeRunKey(deps({ keyApi: leaky }), runId)).rejects.toThrow();

    const line = logs.find((l) => l.operation === "credential.revoke" && l.status === "error");
    expect(line?.error?.message).toContain(MIXED_CASE_HASH); // identifier kept...
    expect(leakScan(minted.key, JSON.stringify(line))).toBeNull(); // ...key gone
  });

  test("a step rejecting with null or a non-string message still logs a line and rethrows the original value", async () => {
    // `e as CredentialLifecycleError` promised nothing: `err.code` on null, and
    // `redactSecrets` on a structured message, both threw from INSIDE the
    // error-logging path — replacing the real failure with a TypeError and
    // writing no line at all.
    const rejectWith = (value: unknown): KeyApi => ({
      createKey: async () => {
        throw value;
      },
      listAllKeys: (m) => api.listAllKeys(m),
      getKeyEntry: (h, m) => api.getKeyEntry(h, m),
      deleteKey: (h) => api.deleteKey(h),
    });

    let caught: unknown = "not-thrown";
    await makeRun("df23-null-rejection");
    try {
      await mintRunKey(deps({ keyApi: rejectWith(null) }), "df23-null-rejection");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(null);
    let line = logs.find((l) => l.operation === "credential.mint" && l.status === "error");
    expect(line?.error?.code).toBe("credential_error");
    expect(line?.error?.message).toBe("null");

    logs.length = 0;
    const structured = { code: "transport-detail", message: { detail: "socket hang up" } };
    await makeRun("df23-nonstring-rejection");
    try {
      await mintRunKey(deps({ keyApi: rejectWith(structured) }), "df23-nonstring-rejection");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(structured);
    line = logs.find((l) => l.operation === "credential.mint" && l.status === "error");
    expect(line?.error?.code).toBe("transport-detail");
    expect(line?.error?.message).toBe("[object Object]");
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
    // "-x" reads as a FLAG, not a path (F034's leading-"-" refusal).
    for (const bad of ["app/.env; touch /tmp/pwned", "app/$(whoami).env", "../../etc/passwd", "", "-x"]) {
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

  test("security: a key echoed by a failing exec never reaches the credential.deliver log line (INV-4)", async () => {
    const runId = "df23-leak";
    await makeRun(runId);
    const minted = await mintRunKey(deps(), runId);
    // STDIN, not argv: `deliverRunKey` puts the key on stdin and keeps it out
    // of `["sh","-c",deliverScript(envFile)]` entirely. So the leak arrives via
    // a driver that echoes the whole invocation — stdin included — when it
    // reports a failure. An argv-only echo carries no key and proves nothing.
    const echoing = {
      ...recording,
      exec: async (vm: string, argv: string[], stdin?: string) => {
        throw Object.assign(new Error(`exec failed on ${vm}: ${argv.join(" ")} <<< ${stdin ?? ""}`), {
          code: "exec-failed",
          remediation: `re-run: ${argv.join(" ")} <<< ${stdin ?? ""}`,
        });
      },
    } as unknown as typeof recording;

    await expect(deliverRunKey(deps({ driver: echoing }), `vm-${runId}`, minted.key)).rejects.toThrow();

    const deliverLines = logs.filter((l) => l.operation === "credential.deliver");
    expect(deliverLines.length).toBeGreaterThan(0);
    expect(leakScan(minted.key, JSON.stringify(deliverLines))).toBeNull();
    // Redacted, not dropped — the step and its code still diagnose the failure.
    expect(JSON.stringify(deliverLines)).toContain("exec failed on");
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

  test("security: a cap that does not round-trip through microsToUsd/usdToMicros is refused before the provider is called", async () => {
    // The F004 over-grant check compares against microsToUsd(capMicroUsd) — if
    // THIS number is lossy, that comparison's own operand is wrong, not just
    // the echo it's checking. Number.MAX_SAFE_INTEGER is the sharpest case:
    // an integer, but /1e6 then *1e6 does not return it exactly.
    const runId = "df23-cap-lossy";
    await makeRun(runId);
    let err: unknown;
    try {
      await mintRunKey(deps({ capMicroUsd: Number.MAX_SAFE_INTEGER }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("cap-invalid");
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

  test("INV-CRED-2: openRouterKeyApi refuses at construction on a missing provisioning key, by env-var name only", () => {
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
    // Track DELETE calls to assert the compensating action
    const originalDelete = api.deleteKey.bind(api);
    const deleted: string[] = [];
    api.deleteKey = async (hash) => {
      deleted.push(hash);
      return originalDelete(hash);
    };
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
    expect(deleted).toContain(hash);
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

  test("F004: a mint echo ABOVE the requested cap is refused (over-grant), keyHash still recorded", async () => {
    // provider "granted" 5 USD against a 1 USD (1_000_000 µ$) request
    api = new FakeKeyApi({ returnedLimitUsd: 5 });
    const runId = "df23-overgrant";
    await makeRun(runId);
    let err: unknown;
    try {
      await mintRunKey(deps({ capMicroUsd: 1_000_000 }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("mint-ceiling-mismatch");
    // the refused-but-live key stays reachable for revoke
    expect(store.get(runId).keyHash).toBeString();
    // the over-granted ceiling is NOT persisted as this run's limit
    expect(store.get(runId).limitMicroUsd).toBeUndefined();
  });

  test("a store write that fails AFTER the provider accepted the mint revokes the live key instead of orphaning it", async () => {
    // The "record BEFORE judging the returned cap" order above protects every
    // refusal that fires after `store.set` — but not `store.set` itself. When
    // THAT throws, the key is live at the provider and the record, the only
    // thing a later `revokeRunKey`/`revokeQuietly` can read, was never
    // written: nothing downstream ever learns the hash, and the key survives
    // the run spendable and unreachable. So the mint compensates in place.
    const runId = "df23-store-write-fails";
    await makeRun(runId);
    const brokenStore = Object.create(store) as typeof store;
    brokenStore.set = (): never => {
      throw new Error("ENOSPC: no space left on device, write run record");
    };
    let err: unknown;
    try {
      await mintRunKey(deps({ store: brokenStore }), runId);
    } catch (e) {
      err = e;
    }
    // The WRITE failure is the reported cause — not the revoke, and not a
    // success that silently lost the key.
    expect((err as Error).message).toContain("ENOSPC");
    // And the key the provider had already created is gone: every entry minted
    // for this run is revoked, so nothing spendable outlived the failure.
    const live = (await api.listAllKeys(10)).entries.filter((k) => k.name.includes(runId));
    expect(live).toEqual([]);
    // …and the compensation SAYS SO. Only the failed revoke used to be logged,
    // so the successful one — the case where a live key was minted and then
    // taken back — left the mint as the last word on this run in the log.
    const comp = logs.find((l) => l.operation === "credential.mint_compensation");
    expect(comp?.outcome).toBe("ok");
    expect(comp?.runId).toBe(runId);
    expect(comp?.keyHashPrefix).toBeString(); // names WHICH key, for the audit
  });

  test("F004: a provider that clamps DOWN is accepted (only over-grants are refused)", async () => {
    api = new FakeKeyApi({ returnedLimitUsd: 0.25 });
    const runId = "df23-clamped";
    await makeRun(runId);
    await mintRunKey(deps({ capMicroUsd: 1_000_000 }), runId);
    expect(store.get(runId).limitMicroUsd).toBe(250_000);
  });

  test("F004: a fractional over-grant that rounds DOWN to the cap is still refused", async () => {
    // 1.0000004 USD rounds to exactly 1_000_000 µ$ under Math.round — a
    // post-rounding comparison would miss this over-grant entirely.
    api = new FakeKeyApi({ returnedLimitUsd: 1.0000004 });
    const runId = "df23-fractional-overgrant";
    await makeRun(runId);
    let err: unknown;
    try {
      await mintRunKey(deps({ capMicroUsd: 1_000_000 }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("mint-ceiling-mismatch");
    expect(store.get(runId).limitMicroUsd).toBeUndefined();
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

  test("F035: captureSpend refuses THIS run's malformed usage instead of writing NaN", async () => {
    const runId = "df23-bad-usage";
    await makeRun(runId);
    const hash = await mintFor(runId);
    const poisoned: KeyApi = {
      ...api,
      createKey: (n, l) => api.createKey(n, l),
      listAllKeys: (m) => api.listAllKeys(m),
      deleteKey: (h) => api.deleteKey(h),
      getKeyEntry: async () => ({
        entry: { hash, name: `${SBX_KEY_PREFIX}${runId}`, usageUsd: Number.NaN },
        truncated: false,
      }),
    };
    let err: unknown;
    try {
      await captureSpend(deps({ keyApi: poisoned }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("invalid-provider-usage");
    expect((err as CredentialLifecycleError).message).toContain(runId);
    // no authoritative-looking spend was written
    expect(store.get(runId).spendMicroUsd).toBeUndefined();
  });

  test("F035: a NEGATIVE usage (provider refund) is NOT refused — it must reach teardown", async () => {
    // The refund case is reachable provider behaviour and is fail-closed
    // downstream (cap-hit-demo.test.ts:598). Refusing it here would abort before
    // revoke and strand the live key — the very failure F035 is about.
    const runId = "df23-refund";
    await makeRun(runId);
    const hash = await mintFor(runId);
    api.setUsage(hash, -0.000002);
    expect(await captureSpend(deps(), runId)).toBe(-2);
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

  test("hash-malformed refusal: provider returns hash with shell metachars", async () => {
    const runId = "df23-malformed-hash";
    await makeRun(runId);
    api = new FakeKeyApi({ returnedHash: "abc; rm -rf /tmp" });
    let err: unknown;
    try {
      await mintRunKey(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("mint-malformed");
    expect((err as CredentialLifecycleError).remediation).not.toContain("abc; rm -rf");
    expect((err as CredentialLifecycleError).remediation).toContain(`key named ${SBX_KEY_PREFIX}${runId}`);
    // record still carries keyHash for manual cleanup
    const rec = store.get(runId);
    expect(rec.keyHash).toBe("abc; rm -rf /tmp");
  });

  test("mint transport timeout compensation: orphaned server-side key is revoked", async () => {
    const runId = "df23-transport-comp";
    await makeRun(runId);
    api = new FakeKeyApi({ mintTransportErrorAfterCreate: true });
    let err: unknown;
    try {
      await mintRunKey(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("transport");
    // the key was revoked server-side by compensation — not stranded live
    const list = await api.listAllKeys(20);
    expect(list.entries.some((k) => k.name === `${SBX_KEY_PREFIX}${runId}`)).toBeFalse();
    expect(list.truncated).toBeFalse();
  });

  test("mint transport timeout compensation failure: list truncated, still rethrows original", async () => {
    const runId = "df23-transport-comp-fail";
    await makeRun(runId);
    api = new FakeKeyApi({ mintTransportErrorAfterCreate: true, listTruncated: true });
    let err: unknown;
    try {
      await mintRunKey(deps(), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("transport");
    // compensation failed (list truncated), but original error still thrown
    expect((err as CredentialLifecycleError).message).toContain("timed out");
  });

  test("a hostile non-string rejection survives every error log without replacing the real failure", async () => {
    // Pins the redaction contract the error paths lean on: redactSecrets
    // coerces ANY rejection value without throwing (asText) and fails to a
    // marker rather than raising (its own try/catch), so a logger can never
    // become the failure it is reporting — and no raw hostile value leaks.
    const runId = "df23-hostile-reject";
    await makeRun(runId);
    // A null-prototype object: String(it) THROWS, so any unguarded coercion in
    // an error path would replace the real error with its own.
    const hostile: object = Object.assign(Object.create(null), { evil: true });
    const d = deps({
      driver: { exec: () => Promise.reject({ code: "boom", message: hostile }) } as unknown as CredentialDeps["driver"],
      keyApi: {
        createKey: (name: string, limitUsd: number) => api.createKey(name, limitUsd),
        listAllKeys: (maxPages: number) => api.listAllKeys(maxPages),
        deleteKey: (hash: string) => api.deleteKey(hash),
        getKeyEntry: () => Promise.reject(Object.assign(Object.create(null), { noMessageHere: true })),
      } as unknown as KeyApi,
    });

    let err: unknown;
    try {
      await runCredentialLifecycle(d, runId);
    } catch (e) {
      err = e;
    }
    // The ORIGINAL delivery rejection propagated, untouched by both log arms.
    expect(err).toMatchObject({ code: "boom" });
    // The mint had already succeeded and been recorded — revocable later.
    expect(store.get(runId).keyHash).toBeString();
    // Both cited sites logged STRING messages: the hostile values coerced to
    // the redactor's unprintable marker, never echoed raw.
    const deliver = logs.find((l) => l.operation === "credential.deliver" && l.status === "error");
    expect(JSON.stringify(deliver?.error)).toContain("[unprintable]");
    expect(JSON.stringify(deliver?.error)).not.toContain("evil");
    const comp = logs.find((l) => l.operation === "credential.delivery_compensation");
    expect(comp?.status).toBe("error");
    expect(JSON.stringify(comp?.error)).toContain("[unprintable]");
    expect(JSON.stringify(comp?.error)).not.toContain("noMessageHere");
  });

  test("maxPages validation: openRouterKeyApi().listAllKeys throws for non-positive maxPages", async () => {
    const realEnv = process.env.OPENROUTER_PROVISIONING_KEY;
    process.env.OPENROUTER_PROVISIONING_KEY = "test-key";
    try {
      const api = openRouterKeyApi();
      for (const bad of [0, -1, -5]) {
        let err: unknown;
        try {
          await api.listAllKeys(bad);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CredentialLifecycleError);
        expect((err as CredentialLifecycleError).code).toBe("max-pages-invalid");
        expect((err as CredentialLifecycleError).message).toContain(String(bad));
      }
    } finally {
      if (realEnv === undefined) {
        // biome-ignore lint/performance/noDelete: restoring test state
        delete process.env.OPENROUTER_PROVISIONING_KEY;
      } else {
        process.env.OPENROUTER_PROVISIONING_KEY = realEnv;
      }
    }
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

  test("F035: a malformed usage row does NOT abort the listing — every other key still enumerates", async () => {
    // Refusing inside the per-entry mapper would let ONE unrelated poisoned row
    // abort the spend step of every run (before revoke, leaving keys live) and
    // break the reaper's sweep. The listing stays tolerant; the refusal lives in
    // `captureSpend`, on the entry that run actually owns.
    const api = client();
    let page = 0;
    setFetch(async () =>
      jsonResponse(
        page++ === 0
          ? {
              data: [
                { hash: "poisoned", name: "sbx-someone-else", usage: "n/a" },
                { hash: "healthy", name: "sbx-mine", usage: 0.5 },
              ],
            }
          : { data: [] },
      ));
    const list = await api.listAllKeys(20);
    expect(list.truncated).toBeFalse();
    expect(list.entries).toHaveLength(2);
    // the healthy row is intact and readable by hash — the reaper's path too
    expect(list.entries.find((k) => k.hash === "healthy")?.usageUsd).toBe(0.5);
    // and the poisoned row carries NaN rather than a fabricated 0
    expect(list.entries.find((k) => k.hash === "poisoned")?.usageUsd).toBeNaN();
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
