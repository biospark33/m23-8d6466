/**
 * DF2.3 — per-run credential lifecycle tests.
 *
 * Every AC maps to a test here. The reference justfiles shipped unrun upstream
 * (story deviation note), so these are the blocking evidence, not inherited
 * behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRun , type ProviderAuditLink, type ProviderDriver } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import {
  SBX_KEY_PREFIX,
  SWARM_KEYS_DIR,
  SWARM_SEAT_KEYS_ENV,
  CredentialLifecycleError,
  captureSeatSpend,
  captureSpend,
  defaultKeyCapMicroUsd,
  deliverRunKey,
  deliverSeatKeys,
  KEY_ENV_FILE,
  mintRunKey,
  mintSeatKeys,
  openRouterKeyApi,
  revokeAndVerify,
  revokeRunKey,
  revokeSeatKeys,
  runCredentialLifecycle,
  verifyRevoked,
  type CredentialDeps,
  type KeyApi,
  type SeatKeyPlan,
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
  auditLinks = [];
  dir = mkdtempSync(join(tmpdir(), "qds-cred-"));
  store = new RunRecordStore(join(dir, "runs"));
  api = new FakeKeyApi();
  driver = new FakeDriver(join(dir, "boxes"));
  recording = new RecordingDriver(driver);
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
});

afterEach(() => {
  // INV-AUDIT-4, file-wide and free — the same backstop teardown.test.ts got,
  // in the file with the same capture pattern and ~50 pre-existing tests that
  // never read `auditLinks`. Every captured link must be attributable to a
  // record that genuinely CARRIES the DF2.8 budget attribution, so an emitter
  // that manufactured a repoSlug for one of this file's many unattributed runs
  // turns the whole file red. COLLECT first, clean up in a `finally`, assert
  // last: `store.get` THROWS on an unreadable record, and asserting inline
  // would leave the global log sink pointed at a dead test's array and the
  // temp dir on disk. (The `requestId` half cannot be checked from the record
  // alone — `deps.requestId` is a legitimate §5.2 source — so it is pinned by
  // the named C5 tests below.)
  const violations: string[] = [];
  try {
    for (const link of auditLinks) {
      let repoSlug: unknown;
      try {
        repoSlug = store.get(link.runId).extensions?.budget?.repoSlug;
      } catch (e) {
        violations.push(`${link.hop}.${link.event}: unreadable run record ${link.runId} — ${(e as Error).message}`);
        continue;
      }
      if (repoSlug !== link.repoSlug) {
        violations.push(
          `${link.hop}.${link.event} emitted for ${link.runId} with repoSlug ${JSON.stringify(link.repoSlug)}, record carries ${JSON.stringify(repoSlug)}`,
        );
      }
    }
  } finally {
    restoreLog?.();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(violations).toEqual([]);
});

/** DF5.3: every deps() captures its links here — see the DF5.3 lifecycle test. */
let auditLinks: ProviderAuditLink[] = [];

function deps(overrides: Partial<CredentialDeps> = {}): CredentialDeps {
  // fake boxes are plain host dirs — deliver to a box-relative path
  return {
    keyApi: api,
    driver: recording,
    store,
    envFile: "app/.env",
    recordAuditLink: (link) => {
      auditLinks.push(link);
    },
    ...overrides,
  };
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
  const rec = await createRun(recording, store, { runId, recordAuditLink: (l) => auditLinks.push(l) });
  return rec.vmName ?? runId;
}

describe("DF2.3 credential lifecycle", () => {
  test("DF5.3: the credential links land in lifecycle order — mint → deliver → revoke → verify-revoked (hop run-credential, keyHash subject)", async () => {
    const runId = "df53-links";
    await makeRun(runId);
    // The record's DF2.8 attribution is the ONLY repoSlug source an emitter may
    // use, and `requestId` is the chain's join key — CONTRACT C5: an emitter may
    // no longer invent one, so a record without it SKIPS every emit (pinned by
    // the C5 test below). Both identities are fixture, never manufactured.
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    await runCredentialLifecycle(deps(), runId);

    expect(auditLinks.map((l) => l.event)).toEqual(["mint", "deliver", "revoke", "verify-revoked"]);
    const hash = store.get(runId).keyHash as string;
    for (const l of auditLinks) {
      expect(l.hop).toBe("run-credential");
      expect(l.runId).toBe(runId);
      expect(l.repoSlug).toBe("qds/demo");
      expect(l.requestId).toBe("req-df53"); // the record's own id, never an invented one (C5)
      expect(l.subjectKind).toBe("credential-key");
      expect(l.subjectId).toBe(hash); // NEVER key material — keyHash only (INV-AUDIT-2)
    }
    // No plaintext ANYWHERE in the emitted links — the whole serialised array,
    // scanned with the same ≥8-char substring tool this file already points at
    // the record, the logs and argv. The old check was `not.toMatch(/sk-/i)`
    // over `l.detail` alone: it matched only FakeKeyApi's literal prefix, so a
    // key DERIVATIVE (`key.slice(3)`, the tail, a base64 form) or the plaintext
    // in any field other than `detail` — `subjectId`, a future `note` — passed,
    // into a durable, append-only, operator-readable store. (It would also have
    // failed a correctly redacted `sk-***` placeholder.)
    const plaintext = api.plaintexts.get(hash);
    expect(plaintext).toBeString();
    expect(leakScan(plaintext as string, JSON.stringify(auditLinks))).toBeNull();
    // The cap has no event of its own: it rides the MINT row's detail.limitMicroUsd.
    // The EXACT value, not expect.any(Number) — that matcher passes for 0, for
    // an unclamped request and for deps.capMicroUsd alike, and this number IS
    // the cap's whole audit trail. The granted-≠-requested case is pinned
    // separately below (a matcher cannot tell the two figures apart here,
    // because the default cap is granted in full).
    expect(auditLinks[0]?.detail).toEqual({ keyHash: hash, limitMicroUsd: defaultKeyCapMicroUsd });
    // The `deliver` row's `envFile` — the one detail field that is
    // caller-supplied and path-shaped, i.e. the field an operator reads to
    // learn WHERE the credential was written. Exact, like its neighbours: it
    // was the only lifecycle row with no assertion at all, so dropping it,
    // renaming it, or emitting the raw `deps.envFile` instead of the resolved
    // `KEY_ENV_FILE` default all passed.
    expect(auditLinks[1]?.detail).toEqual({ keyHash: hash, envFile: "app/.env" });
    // ROUND 3: the revoke row's `detail` carries NO `outcome`. Two attempts at
    // the documented retry (teardown aborted after revoke; nothing clears
    // `rec.keyHash`, so the provider then answers 404) would digest
    // `{keyHash, outcome:"revoked"}` and `{keyHash, outcome:"already-gone"}` —
    // colliding on the store's UNIQUE key with DIFFERENT evidence digests,
    // which it reports as `divergent`: a tamper alarm raised by an ordinary
    // retry. The outcome now rides the `credential.revoke` STEP LINE, which
    // carries no digest and may honestly differ per attempt.
    expect(auditLinks[2]?.detail).toEqual({ keyHash: hash });
    expect(auditLinks[3]?.detail).toEqual({ keyHash: hash });
    expect(logs.filter((l) => l.operation === "credential.revoke").map((l) => l.revokeOutcome)).toEqual(["revoked"]);
    // AC7: non-decreasing occurred_at (≤ — two links may share a millisecond).
    const stamps = auditLinks.map((l) => Date.parse(l.occurredAt));
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!).toBeGreaterThanOrEqual(stamps[i - 1]!);
  });

  test("DF5.3: an unattributed run emits nothing (INV-AUDIT-4 — no invented repoSlug)", async () => {
    const runId = "df53-nolinks";
    await makeRun(runId);
    await runCredentialLifecycle(deps(), runId);
    expect(auditLinks).toHaveLength(0);
    // ANCHORED: a zero-length array is also what an early no-op return produces,
    // so the claim "emitted nothing" is only worth anything beside proof that
    // the lifecycle ran in full. It did: a key was minted and recorded, its
    // spend captured, and the DELETE issued.
    const rec = store.get(runId);
    expect(rec.keyHash).toBeString();
    expect(rec.spendMicroUsd).toBeNumber();
    expect(api.keys).toHaveLength(1);
    expect(api.requests.some((r) => r.method === "DELETE" && r.path === `/keys/${rec.keyHash}`)).toBeTrue();
  });

  test("CONTRACT C5: an attributed run with NO requestId anywhere emits nothing and logs one audit-link-skipped per event", async () => {
    // The other half of INV-AUDIT-4. `requestId` is what chain.ts JOINS on
    // (`sessions.request_id` / `gate_results.request_id`), so a freshly minted
    // id is not a weak correlation — it is a false one. The emitter used to
    // invent one; now the emit is SKIPPED and hop 4 reports the run `unlinked`,
    // which is honest and fail-closed.
    const runId = "df53-no-request-id";
    await makeRun(runId);
    // Attributed — so repoSlug is NOT what suppresses these emits — but no
    // requestId on the record, and `deps()` propagates none either.
    store.set(runId, { extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    await runCredentialLifecycle(deps(), runId);

    expect(auditLinks).toHaveLength(0);
    expect(store.get(runId).keyHash).toBeString(); // the lifecycle really ran
    const skips = logs.filter((l) => l.operation === "providers.audit-link-skipped");
    // ROUND 3: the leading `create` is `makeRun`'s — `provisionAdmittedRun`
    // runs before this test attaches the attribution, and its `no-repo-slug`
    // arm used to skip SILENTLY. It logs now, so the file-wide count of these
    // lines changed; the four credential events are still the subject here.
    expect(skips.map((l) => l.event)).toEqual(["create", "mint", "deliver", "revoke", "verify-revoked"]);
    expect(skips.map((l) => l.reason)).toEqual([
      "no-repo-slug",
      "no-request-id",
      "no-request-id",
      "no-request-id",
      "no-request-id",
    ]);
    for (const s of skips) {
      expect(s.status).toBe("error");
      expect(s.runId).toBe(runId);
      // The LOG's own correlation is present (a generated id is fine for a
      // diagnostic line) — it is precisely what must not reach the link.
      expect(s.requestId).toBeString();
    }
  });

  test("CONTRACT C5 option (c): deps.requestId is NOT a fallback — a record without one skips even when deps propagates one", async () => {
    // The RECORD is the only source. `dispatch.ts` stamps
    // `store.set(runId, { requestId })` as its first write after provisioning,
    // so on every dispatch path the record already has it; the callers where
    // the two differ are the teardown/reap composition roots, which MINT theirs
    // — so a deps fallback is a laundering channel for a fabricated id, not a
    // second real source. Pinned so re-adding `?? deps.requestId` (the obvious
    // "fix" for a run that reports `unlinked`) fails here instead of quietly
    // stamping the chain's join column with a per-invocation id.
    const runId = "df53-deps-request-id";
    await makeRun(runId);
    store.set(runId, { extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });

    await runCredentialLifecycle(deps({ requestId: "req-minted-by-the-cli" }), runId);

    expect(auditLinks).toHaveLength(0);
    expect(store.get(runId).keyHash).toBeString(); // the lifecycle ran in full
    const skips = logs.filter((l) => l.operation === "providers.audit-link-skipped");
    // The leading `create` is `makeRun`'s unattributed skip — see the sibling
    // test. It carries a MINTED log correlation (createRun was given none),
    // which is why the deps-propagated-id assertion below skips it.
    expect(skips.map((l) => l.event)).toEqual(["create", "mint", "deliver", "revoke", "verify-revoked"]);
    expect(skips[0]!.reason).toBe("no-repo-slug");
    // The propagated id still does the job it was added for — the STEP LOG's
    // correlation — which is exactly where a minted id is legitimate.
    for (const s of skips.slice(1)) expect(s.requestId).toBe("req-minted-by-the-cli");
    expect(logs.some((l) => l.operation === "credential.mint" && l.requestId === "req-minted-by-the-cli")).toBeTrue();
  });

  test("DF5.3: the mint row carries the GRANTED µ$, not the requested cap (the cap's only audit trail)", async () => {
    // The production comment is explicit that `detail.limitMicroUsd` is the
    // APPLIED figure. With a provider that clamps DOWN, requested (1_000_000)
    // and granted (250_000) are different numbers, so the row can no longer be
    // satisfied by the request, by `deps.capMicroUsd`, or by 0.
    api = new FakeKeyApi({ returnedLimitUsd: 0.25 });
    const runId = "df53-mint-granted";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });

    const minted = await mintRunKey(deps({ capMicroUsd: 1_000_000 }), runId);

    expect(auditLinks).toHaveLength(1);
    expect(auditLinks[0]?.event).toBe("mint");
    expect(auditLinks[0]?.detail).toEqual({ keyHash: minted.hash, limitMicroUsd: 250_000 });
    // …which is exactly what the record kept, and NOT the request.
    expect(store.get(runId).limitMicroUsd).toBe(250_000);
    expect(api.requests.find((r) => r.method === "POST")?.limitUsd).toBe(1);
  });

  test("DF5.3: a refused mint (ceiling mismatch) emits NOTHING — AC3's core claim", async () => {
    // The refusal fires AFTER the provider created a live key, so a `mint` row
    // emitted before it would vouch for an event that never completed. The
    // round-4 failure tests capture links and never read them; this one reads.
    api = new FakeKeyApi({ returnedLimitUsd: 5 }); // 5 USD granted against a 1 USD request
    const runId = "df53-mint-refused";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });

    await expect(mintRunKey(deps({ capMicroUsd: 1_000_000 }), runId)).rejects.toThrow();

    expect(auditLinks).toHaveLength(0);
    // The key IS live and recorded (INV-CRED-1's reachability) — so "nothing
    // was emitted" is not merely "nothing happened".
    expect(store.get(runId).keyHash).toBeString();
    expect(store.get(runId).limitMicroUsd).toBeUndefined();
  });

  test("DF5.3: the delivery-failure compensation emits mint, then revoke + verify-revoked marked compensation", async () => {
    // Without these two the chain sees a `mint` with no counterpart and reports
    // hop 4 `unlinked` for a lifecycle that closed cleanly. `revokeAndVerify`
    // itself stays the run-less no-op sink (W14B-3/INV-AUDIT-4) — the emit
    // belongs at this call site, where the run identity is in scope.
    const runId = "df53-delivery-comp";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    const failing = Object.create(recording) as typeof recording;
    failing.exec = () => Promise.reject(new Error("box unreachable"));

    await expect(runCredentialLifecycle(deps({ driver: failing }), runId)).rejects.toThrow("box unreachable");

    const hash = store.get(runId).keyHash as string;
    expect(auditLinks.map((l) => l.event)).toEqual(["mint", "revoke", "verify-revoked"]);
    // No `deliver` row: the delivery is the thing that failed.
    expect(auditLinks.some((l) => l.event === "deliver")).toBeFalse();
    // ROUND 3: `detail` is `{keyHash}` only. The `compensation:` marker made
    // these two rows digest DIFFERENTLY from the ordinary revoke/verify-revoked
    // rows for the same (run_id, hop, event, subject_key) — so a replay through
    // the other path collided as `divergent`, the store's tamper alarm, on a
    // path that is itself a recovery. Which path produced the row is on the
    // `credential.delivery_compensation` step line, which carries no digest.
    expect(auditLinks[1]?.detail).toEqual({ keyHash: hash });
    expect(auditLinks[2]?.detail).toEqual({ keyHash: hash });
    // …and the step line the comment above points at actually exists on the
    // SUCCESS arm. It did not, until round 3's follow-up: stripping the
    // `compensation:` marker from `detail` fixed the `divergent` collision but
    // left a compensation that LANDED writing two `{keyHash}`-only rows
    // indistinguishable from an ordinary teardown's, with this operation logged
    // on the failure arm alone. Two rows plus silence is not observability, and
    // the comment four lines up would have been describing a line nothing wrote.
    const comp = logs.filter((l) => l.operation === "credential.delivery_compensation");
    expect(comp).toHaveLength(1);
    expect(comp[0]?.status).toBe("ok");
    expect(comp[0]?.outcome).toBe("revoked");
    expect(comp[0]?.runId).toBe(runId);
    expect(comp[0]?.step).toBe("delivery_compensation");
    // The prefix, never the hash: INV-AUDIT-2 applies to the step log too.
    // Asserted as a PROPERTY (a strict prefix, materially shorter) rather than
    // by restating the production slice — round 3 flagged that shape elsewhere,
    // since an expectation computed the same way the code computes it pins
    // nothing about the guarantee.
    const prefix = comp[0]?.keyHashPrefix as string;
    expect(hash.startsWith(prefix)).toBeTrue();
    expect(prefix.length).toBeLessThan(hash.length / 2);
    expect(JSON.stringify(comp[0])).not.toContain(hash);
    // …and the compensation really happened: the key is gone from the list.
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
  });

  test("DF5.3: a store refusal DURING the delivery compensation is SWALLOWED — deliberate, pinned in both directions", async () => {
    // The ONE emit site that swallows a store refusal, and it relabels a
    // compensation that fully SUCCEEDED as a failed one: both compensation
    // emits sit inside the `try` whose `catch (compErr)` logs
    // `credential.delivery_compensation` with `status: "error"`. That is the
    // opposite posture from `mintRunKey`/`deliverRunKey`, whose
    // propagate-on-refusal behaviour the two tests above pin — so without this
    // test a reviewer cannot tell a deliberate asymmetry from a regression, and
    // a flip in EITHER direction is invisible.
    const runId = "df53-delivery-comp-storefail";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    const failing = Object.create(recording) as typeof recording;
    failing.exec = () => Promise.reject(new Error("box unreachable"));

    let emits = 0;
    await expect(
      runCredentialLifecycle(
        deps({
          driver: failing,
          recordAuditLink: (link) => {
            auditLinks.push(link);
            // The mint link lands; the two compensation emits refuse.
            if (++emits > 1) throw new Error("store refused");
          },
        }),
        runId,
      ),
      // The DELIVERY failure is what reaches the operator — not the store's
      // refusal. The original cause is never masked by the compensation.
    ).rejects.toThrow("box unreachable");

    const hash = store.get(runId).keyHash as string;
    expect(auditLinks.map((l) => l.event)).toEqual(["mint", "revoke"]); // the second emit threw before pushing verify-revoked
    // The line claims the compensation FAILED …
    const comp = logs.filter((l) => l.operation === "credential.delivery_compensation");
    expect(comp).toHaveLength(1);
    expect(comp[0]!.status).toBe("error");
    // … and yet the revoke AND the verify both genuinely landed: the key is
    // gone from the authoritative list. That under-report is the documented
    // trade-off, not a lost compensation.
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeFalse();
  });

  test("DF5.3: the revoke STEP LINE resolves to already-gone when the provider says the key is not live", async () => {
    // `revoked` and `already-gone` are the same event resolved at two different
    // provider answers — both emit, and something must say WHICH. ROUND 3 moved
    // that "which" off `detail` and onto the `credential.revoke` step line:
    // `detail` is digested into `evidence_digest`, so the documented retry
    // (revoked, then 404 on the re-run) produced two DIFFERENT digests for the
    // same UNIQUE key and the store raised `divergent` — its tamper alarm — on
    // an ordinary recovery. The step line carries no digest.
    const runId = "df53-already-gone";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    const hash = (await mintRunKey(deps(), runId)).hash;
    await api.deleteKey(hash); // revoked out of band — the next DELETE 404s
    auditLinks.length = 0;
    logs.length = 0;

    expect(await revokeRunKey(deps(), runId)).toBe("already-gone");

    expect(auditLinks).toHaveLength(1);
    expect(auditLinks[0]?.detail).toEqual({ keyHash: hash });
    expect(logs.filter((l) => l.operation === "credential.revoke").map((l) => l.revokeOutcome)).toEqual([
      "already-gone",
    ]);
  });

  test("DF5.3: revoke's FAILURE arm emits nothing — a 5xx DELETE leaves no row vouching for the key", async () => {
    // `revokeHash` throws `revoke-failed` BEFORE the emit, so no `revoke` row
    // exists for a key the provider may still be serving. Untested until now:
    // the pre-existing 5xx test asserts `code` and never looks at the links.
    api = new FakeKeyApi({ deleteStatus: 500 });
    const runId = "df53-revoke-failed-nolinks";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    await mintRunKey(deps(), runId);
    const hash = store.get(runId).keyHash as string;
    auditLinks.length = 0;

    await expect(revokeRunKey(deps(), runId)).rejects.toThrow();

    expect(auditLinks).toEqual([]);
    // The key really IS still live — that is what makes the absence load-bearing.
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === hash)).toBeTrue();
  });

  test("DF5.3: a still-listed key emits a revoke row but NEVER a verify-revoked one", async () => {
    // The safety-critical arm the whole hop exists for. The DELETE succeeded,
    // so `revoke` is honest; but the authoritative list still shows the key, so
    // `verifyHash` throws `still-listed` and the `verify-revoked` emit — which
    // sits AFTER that await — never runs. Hoisting either emit above its await
    // (the natural refactor when someone wants the row "even if verification is
    // flaky") would ship a retroactive row asserting a revocation that did not
    // happen, with every other test in this file green.
    api = new FakeKeyApi({ staleListAfterDelete: true });
    const runId = "df53-still-listed-nolinks";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    await mintRunKey(deps(), runId);
    auditLinks.length = 0;

    expect(await revokeRunKey(deps(), runId)).toBe("revoked");
    const err = await verifyRevoked(deps(), runId).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("still-listed");

    expect(auditLinks.map((l) => l.event)).toEqual(["revoke"]);
    // The record keeps the hash: it is the operator's only handle on the key.
    expect(store.get(runId).keyHash).toBeString();
  });

  test("DF5.3: revokeRunKey's keyless arm returns 'none' and emits nothing (the NOT NULL columns)", async () => {
    // The `none` arm returns before the emit. A link added there would carry an
    // undefined `subjectId` straight into NOT NULL columns — and no event
    // happened to link: no key ever existed for this run.
    const runId = "df53-keyless-revoke";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    auditLinks.length = 0;

    expect(await revokeRunKey(deps(), runId)).toBe("none");

    expect(auditLinks).toHaveLength(0);
    expect(store.get(runId).keyHash).toBeUndefined();
  });

  test("DF5.3: an audit-store refusal PROPAGATES out of mintRunKey — and the key is COMPENSATED first", async () => {
    // driver.ts documents that a typed AuditStoreError propagates "for the
    // credential/box/bundle emits". Nothing made `recordAuditLink` throw, so a
    // plausible `try {} catch {}` "don't let audit break the mint" patch would
    // turn the chain best-effort with a green suite.
    //
    // ROUND 3 fixed the exposure this test used to PIN: `mintRunKey`'s throw
    // takes the plaintext `res.key` — the only copy (INV-4) — with the stack
    // frame, and `runCredentialLifecycle` calls `mintRunKey` OUTSIDE its try,
    // so its mint/revoke bracketing never ran and nothing at all held a live,
    // spend-capable key. The emit is still FAIL-LOUD (nothing is billing at
    // mint) but now COMPENSATED: revoked and proven absent before the refusal
    // propagates.
    const runId = "df53-mint-sink-throws";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });

    await expect(
      mintRunKey(
        deps({
          recordAuditLink: () => {
            throw new Error("store refused");
          },
        }),
        runId,
      ),
    ).rejects.toThrow("store refused");

    // Blast radius: the record still names the key (the operator's handle, and
    // what DF2.6's orphan sweep reaches) …
    const rec = store.get(runId);
    expect(rec.keyHash).toBeString();
    expect(rec.limitMicroUsd).toBe(50_000_000);
    // … but the key itself is GONE from the authoritative list, and the
    // compensation said so on its own line.
    expect((await api.listAllKeys(20)).entries.some((k) => k.hash === rec.keyHash)).toBeFalse();
    const comp = logs.filter((l) => l.operation === "credential.mint_compensation");
    expect(comp).toHaveLength(1);
    expect(comp[0]!.status).toBe("ok");
    expect(comp[0]!.compensated).toBe(1);
  });

  test("DF5.3: a store refusal turns a SUCCESSFUL 0600 delivery into a reported failure — deliberate, pinned", async () => {
    // The severe half of the same posture: the key really did land at mode 600,
    // and `deliverRunKey` still rejects because the audit row did not. Pinned so
    // the choice is visible rather than discovered by an operator.
    const runId = "df53-deliver-sink-throws";
    await makeRun(runId);
    store.set(runId, { requestId: "req-df53", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    const minted = await mintRunKey(deps(), runId);

    await expect(
      deliverRunKey(
        deps({
          recordAuditLink: () => {
            throw new Error("store refused");
          },
        }),
        runId,
        runId,
        minted.key,
      ),
    ).rejects.toThrow("store refused");

    // The delivery SUCCEEDED before the emit: the file is there at 0600.
    const stat = await driver.exec(runId, [
      "sh",
      "-c",
      `python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])' app/.env`,
    ]);
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout.trim()).toBe("600");
  });

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
        await deliverRunKey(deps({ envFile: bad }), runId, "vm-df23-envfile", minted.key);
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

    await expect(deliverRunKey(deps({ driver: echoing }), runId, `vm-${runId}`, minted.key)).rejects.toThrow();

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

  test("AC4: a cap above the defaultKeyCapMicroUsd backstop is refused before the provider is called", async () => {
    // DF2.13 derives the per-run cap from the admission budget; this guard is
    // the ceiling that derivation can never exceed. 50_000_001 is the
    // just-above-boundary probe (it round-trips, so it reaches THIS guard and
    // not the round-trip one), 90M the plausible fat-finger, 900M the
    // multi-run budget handed to one key.
    for (const [i, capMicroUsd] of [50_000_001, 90_000_000, 900_000_000].entries()) {
      const runId = `df213-cap-over-${i}`;
      await makeRun(runId);
      let err: unknown;
      try {
        await mintRunKey(deps({ capMicroUsd }), runId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CredentialLifecycleError);
      const cle = err as CredentialLifecycleError;
      expect(cle.code).toBe("cap-invalid");
      // The message names BOTH numbers and the backstop BY NAME — the operator
      // must learn which knob to turn, not just that one number beat another.
      // Underscore-formatted or bare literals both normalize to the same
      // digits, so the value assertions strip separators first.
      expect(cle.message).toContain("defaultKeyCapMicroUsd");
      const flat = cle.message.replace(/_/g, "");
      expect(flat).toContain(String(capMicroUsd));
      expect(flat).toContain(String(defaultKeyCapMicroUsd));
      // the remediation is to raise the BACKSTOP, never to wedge this cap past it
      expect(cle.remediation).toMatch(/defaultKeyCapMicroUsd|backstop/);
      expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      // nothing was minted, so nothing was recorded for this run
      expect(store.get(runId).keyHash).toBeUndefined();
    }
  });

  test("AC4: the backstop boundary is inclusive — a cap of exactly defaultKeyCapMicroUsd mints", async () => {
    // Pins the guard against over-refusal: the documented default is the
    // backstop, not above it.
    const runId = "df213-cap-at-backstop";
    await makeRun(runId);
    await mintRunKey(deps({ capMicroUsd: defaultKeyCapMicroUsd }), runId);
    const create = api.requests.find((r) => r.method === "POST" && r.path === "/keys");
    expect(create?.limitUsd).toBe(50); // 50_000_000 µ$ crosses the wire as 50 dollars
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  test("AC3: a derived remainder cap that round-trips through the dollar API mints exactly", async () => {
    // 4_837_211 is an arbitrary `cap − spent − reserved` integer nobody
    // inspected — the shape every DF2.13 per-run cap actually has. It survives
    // microsToUsd/usdToMicros (verified before this test was written:
    // Math.round((4_837_211 / 1e6) * 1e6) === 4_837_211), so the round-trip
    // guard must let it through and the wire figure must be exact.
    const runId = "df213-derived-remainder";
    await makeRun(runId);
    await mintRunKey(deps({ capMicroUsd: 4_837_211 }), runId);
    const create = api.requests.find((r) => r.method === "POST" && r.path === "/keys");
    expect(create?.limitUsd).toBe(4_837_211 / 1_000_000);
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  test("AC3: a derived cap that does not round-trip is refused before the provider is called", async () => {
    // 4_503_599_627_370_485 (2^52 − 11, odd) is VERIFIED lossy under the real
    // semantics — usdToMicros rounds AFTER scaling, and
    // Math.round((L / 1_000_000) * 1_000_000) !== L for this literal (checked
    // with `bun -e` before this test was written; the neighbouring 2^52 + 1
    // actually round-trips under that order and would not do here).
    const runId = "df213-derived-lossy";
    await makeRun(runId);
    let err: unknown;
    try {
      await mintRunKey(deps({ capMicroUsd: 4_503_599_627_370_485 }), runId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    const cle = err as CredentialLifecycleError;
    expect(cle.code).toBe("cap-invalid");
    // This literal ALSO exceeds the defaultKeyCapMicroUsd backstop, which
    // refuses with the same code — so the guard pinned here is identified by
    // MESSAGE, not by code alone: delete the round-trip guard above and the
    // backstop would satisfy `code` but not this string.
    expect(cle.message).toContain("does not round-trip");
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
    expect(comp?.compensated).toBe(1);
    expect(comp?.mint_compensation_ms).toBeNumber();
  });

  test("when the compensating revoke ALSO fails, the live unreachable key is logged and the store error is still the cause", async () => {
    // The twin of the test above, and the branch that actually matters: the
    // store write failed AND the revoke that would have taken the key back
    // failed too. This is the one path that ends with a LIVE, SPENDABLE key
    // that no record, no teardown and no `revokeQuietly` can ever reach — the
    // log line below is the only thing that will ever name it. If that line
    // regresses (wrong field, swallowed, or the revoke error escaping and
    // replacing the store error as the reported cause) the key becomes
    // invisible, so it is pinned here rather than left to the ok arm.
    const runId = "df23-store-write-and-revoke-fail";
    await makeRun(runId);
    const brokenStore = Object.create(store) as typeof store;
    brokenStore.set = (): never => {
      throw new Error("ENOSPC: no space left on device, write run record");
    };
    const brokenApi = Object.create(api) as typeof api;
    brokenApi.deleteKey = (): Promise<number> => {
      throw new CredentialLifecycleError(
        "revoke-failed",
        "DELETE /keys/… returned 500",
        "revoke by hand",
      );
    };
    let err: unknown;
    try {
      await mintRunKey(deps({ store: brokenStore, keyApi: brokenApi }), runId);
    } catch (e) {
      err = e;
    }
    // The STORE failure is still the reported cause. The compensation is
    // best-effort; it must never replace the error it is compensating for.
    expect((err as Error).message).toContain("ENOSPC");
    // The key really is still live — this is not a hypothetical branch.
    const live = (await api.listAllKeys(10)).entries.filter((k) => k.name.includes(runId));
    expect(live).toHaveLength(1);
    // …and it is OBSERVABLE, with the same fields the ok arm carries so a
    // dashboard summing this operation sees the failures too.
    const comp = logs.find((l) => l.operation === "credential.mint_compensation");
    expect(comp?.outcome).toBe("error");
    expect(comp?.status).toBe("error");
    expect(comp?.runId).toBe(runId);
    expect((comp?.error as { code?: string } | undefined)?.code).toBe("revoke-failed");
    expect(comp?.keyHashPrefix).toBeString(); // the only pointer to the orphan
    expect(comp?.compensated).toBe(0);
    expect(comp?.mint_compensation_ms).toBeNumber();
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
    // The malformed hash is NOT recorded, and that is the point of asserting
    // the charset FIRST. `mintRunKey`'s own `already-minted` refusal
    // interpolates a recorded keyHash straight into a copy-paste
    // `curl -X DELETE .../keys/${existing}`, and the store-write compensation
    // hands the raw hash to `revokeAndVerify`, whose `revoke-failed` message
    // and remediation do the same — so recording it just moves the
    // interpolation one run down the line. Manual cleanup goes by NAME, which
    // is what this refusal's remediation tells the operator to use.
    expect(store.get(runId).keyHash).toBeUndefined();
    for (const l of logs) expect(JSON.stringify(l)).not.toContain("rm -rf");
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

// ─── S1 rig_swarm: per-seat provider keys ─────────────────────────────────────
//
// The brief's `makeCredDeps()` maps onto this file's fixtures: module-level
// `api` (FakeKeyApi) + `store` (temp RunRecordStore), with the run cap at the
// backstop boundary (see seatDeps below). `keyApi.created` → POST rows of
// `api.requests`; `usageByHash` → `api.setUsage`; `revokedHashes` → deleted
// rows of `api.keys`.
describe("S1 rig_swarm per-seat keys", () => {
  // NOTE (brief deviation, documented in the task report): the brief's PLAN
  // used 250_000_000 µ$ seats under a 500_000_000 µ$ deps cap, which its OWN
  // backstop test (50_000_001 = defaultKeyCapMicroUsd + 1 must refuse) and
  // snippet (`p.limitMicroUsd > defaultKeyCapMicroUsd`) make unsatisfiable —
  // no single per-seat ceiling admits 250M while refusing 50_000_001. Every
  // production guard sides with the backstop: the budget gate admits
  // min(defaultKeyCapMicroUsd, remaining), resident-bounds enforces
  // capMicroUsd ≤ defaultKeyCapMicroUsd, and dispatch refuses an admitted
  // ceiling above it (resident-cap-above-backstop) — a seat above 50M can
  // never legitimately reach a mint. Fixtures therefore sit at the backstop
  // boundary: 25M µ$ per seat, Σ = 50M = defaultKeyCapMicroUsd exactly — the
  // run cap IS the backstop, because F033's run-level guard (mintSeatKeys'
  // port of mintRunKey's) refuses any capMicroUsd above it pre-mint.
  const PLAN: readonly SeatKeyPlan[] = [
    { seat: "lead", limitMicroUsd: 25_000_000 },
    { seat: "worker", limitMicroUsd: 25_000_000 },
  ];

  /** The brief's makeCredDeps: fixture deps with the swarm run cap. */
  const seatDeps = () => deps({ capMicroUsd: defaultKeyCapMicroUsd });

  test("mintSeatKeys mints one key per seat with its own limit and records the namespace", async () => {
    store.create("run-1");
    const { keys, hashes } = await mintSeatKeys(seatDeps(), "run-1", PLAN);
    expect(Object.keys(keys).sort()).toEqual(["lead", "worker"]);
    expect(
      api.requests.filter((r) => r.method === "POST").map(({ name, limitUsd }) => ({ name, limitUsd })),
    ).toEqual([
      { name: "sbx-run-1-lead", limitUsd: 25 }, // microsToUsd boundary
      { name: "sbx-run-1-worker", limitUsd: 25 },
    ]);
    const rec = store.get("run-1");
    expect(rec.extensions?.swarmSeats?.seats).toEqual(["lead", "worker"]);
    // Index-aligned: seats[i]'s hash is keyHashes[i] (the namespace contract).
    expect(rec.extensions?.swarmSeats?.keyHashes).toEqual(Object.values(hashes));
  });

  test("mintSeatKeys refuses when seat limits sum above the run cap", async () => {
    store.create("run-2");
    await expect(mintSeatKeys(seatDeps(), "run-2", [
      { seat: "lead", limitMicroUsd: 400_000_000 },
      { seat: "worker", limitMicroUsd: 400_000_000 },
    ])).rejects.toThrow(/seat limits sum .* above the run cap/);
  });

  test("mintSeatKeys refuses a seat above the backstop ceiling", async () => {
    // Post-F033 the RUN cap is itself bounded by the backstop, so a seat above
    // the backstop always breaches the Σ ≤ cap guard first — the per-seat
    // backstop check below it is defence in depth (reachable only if
    // defaultKeyCapMicroUsd ever moves). The refusal is still pre-mint and
    // typed, which is the property under test.
    store.create("run-3");
    await expect(mintSeatKeys(seatDeps(), "run-3", [{ seat: "lead", limitMicroUsd: 50_000_001 }]))
      .rejects.toThrow(CredentialLifecycleError);
    let err: unknown;
    try {
      await mintSeatKeys(seatDeps(), "run-3", [{ seat: "lead", limitMicroUsd: 50_000_001 }]);
    } catch (e) {
      err = e;
    }
    expect((err as CredentialLifecycleError).code).toBe("cap-invalid");
    expect((err as CredentialLifecycleError).message).toMatch(/above the run cap/);
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("mintSeatKeys refuses an already-minted run (single key OR swarm)", async () => {
    store.create("run-4");
    store.set("run-4", { keyHash: "aaaaaaaa" }); // single-key mint already happened
    await expect(mintSeatKeys(seatDeps(), "run-4", PLAN)).rejects.toThrow(/already carries keyHash/);
    // …and the swarm shape: a second mint over an existing swarm namespace.
    store.create("run-4b");
    await mintSeatKeys(seatDeps(), "run-4b", PLAN);
    await expect(mintSeatKeys(seatDeps(), "run-4b", PLAN)).rejects.toThrow(/already carries swarm seat keys/);
  });

  test("mintSeatKeys refuses duplicate seat names and bad seat spellings", async () => {
    store.create("run-5");
    await expect(mintSeatKeys(seatDeps(), "run-5", [
      { seat: "lead", limitMicroUsd: 10 }, { seat: "lead", limitMicroUsd: 10 },
    ])).rejects.toThrow(/duplicate seat/);
    await expect(mintSeatKeys(seatDeps(), "run-5", [{ seat: "Big Seat", limitMicroUsd: 10 }]))
      .rejects.toThrow(/seat name/);
  });

  test("a mid-mint failure compensates: every earlier seat key is revoked, nothing is recorded", async () => {
    store.create("run-comp");
    const originalCreate = api.createKey.bind(api);
    let calls = 0;
    api.createKey = async (name: string, limitUsd: number) => {
      calls++;
      if (calls === 2) throw new Error("second mint failed");
      return originalCreate(name, limitUsd);
    };
    await expect(mintSeatKeys(seatDeps(), "run-comp", PLAN)).rejects.toThrow("second mint failed");
    expect(api.keys).toHaveLength(1); // the lead key was minted…
    expect(api.keys[0]!.deleted).toBeTrue(); // …and compensated (revoked + verified)
    expect(store.get("run-comp").extensions?.swarmSeats).toBeUndefined();
  });

  test("captureSeatSpend sums provider usage across seats into spendMicroUsd", async () => {
    store.create("run-6");
    const { hashes } = await mintSeatKeys(seatDeps(), "run-6", PLAN);
    api.setUsage(hashes.lead!, 0.1);
    api.setUsage(hashes.worker!, 0.1);
    const total = await captureSeatSpend(seatDeps(), "run-6");
    expect(total).toBe(200_000); // 0.1 + 0.1 USD in µ$
    expect(store.get("run-6").spendMicroUsd).toBe(200_000);
  });

  test("captureSeatSpend treats an absent (out-of-band revoked) seat as 0, not a lie", async () => {
    store.create("run-7");
    const { hashes } = await mintSeatKeys(seatDeps(), "run-7", PLAN);
    await api.deleteKey(hashes.lead!); // revoked out-of-band: absent from the fully-enumerated list
    api.setUsage(hashes.worker!, 0.25);
    const total = await captureSeatSpend(seatDeps(), "run-7");
    expect(total).toBe(250_000);
  });

  test("captureSeatSpend refuses a PRESENT seat with non-numeric usage (fail-closed like captureSpend)", async () => {
    // Absent → 0 is correct (the test above); PRESENT with NaN usage must throw
    // with the single-key path's typed refusal — silently contributing 0 would
    // be the same authoritative-looking lie F035 exists to prevent.
    store.create("run-9");
    const { hashes } = await mintSeatKeys(seatDeps(), "run-9", PLAN);
    api.setUsage(hashes.lead!, Number.NaN);
    let err: unknown;
    try {
      await captureSeatSpend(seatDeps(), "run-9");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("invalid-provider-usage");
    expect((err as CredentialLifecycleError).message).toContain("run-9");
    expect(store.get("run-9").spendMicroUsd).toBeUndefined(); // no authoritative-looking spend written
  });

  test("revokeSeatKeys revokes every recorded hash", async () => {
    store.create("run-8");
    const { hashes } = await mintSeatKeys(seatDeps(), "run-8", PLAN);
    const n = await revokeSeatKeys(seatDeps(), "run-8");
    expect(n).toBe(2);
    expect(api.keys.filter((k) => k.deleted).map((k) => k.hash).sort())
      .toEqual(Object.values(hashes).sort());
  });

  test("run-record accepts swarmSeats with real-shaped 64-char lowercase hex hashes (assertNoSecret compatibility)", () => {
    // The namespace's hashes are provider sha256 hex: 64 chars, lowercase-only,
    // so the mixed-class heuristic cannot fire by construction and no
    // SECRET_PREFIXES entry matches. This test proves the argument against the
    // real store — a regression in either the heuristic or the namespace
    // registration bricks every swarm mint at the record write.
    store.create("run-scan");
    const hexes = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
    store.set("run-scan", { extensions: { swarmSeats: { seats: ["lead", "worker"], keyHashes: hexes } } });
    expect(store.get("run-scan").extensions?.swarmSeats?.keyHashes).toEqual(hexes);
  });

  // Stub driver: records argv+stdin, never executes — the seat script's fixed
  // absolute SWARM_KEYS_DIR is a real-box concern (live E2E owns it); what is
  // unit-testable here is the TRANSPORT contract: which argv ran, what rode
  // stdin, and what the mode gate did with the answer.
  function stubExec(stdoutFor: (script: string) => string) {
    const calls: { argv: string[]; stdin?: string }[] = [];
    const driver = {
      name: "stub",
      exec: async (_vm: string, argv: string[], stdin?: string) => {
        calls.push({ argv: [...argv], stdin });
        return { exitCode: 0, stdout: stdoutFor(String(argv[2])), stderr: "" };
      },
    } as unknown as ProviderDriver;
    return { calls, driver };
  }

  test("deliverSeatKeys ships key material on stdin only — never argv — and gates on the 0600 confirmation", async () => {
    const runId = "run-deliver";
    const vm = await makeRun(runId);
    const { keys } = await mintSeatKeys(seatDeps(), runId, PLAN);
    const { calls, driver } = stubExec((script) => (script.includes("cat >") ? "600" : ""));
    await deliverSeatKeys({ ...seatDeps(), driver }, runId, vm, keys);
    expect(calls).toHaveLength(2);
    const write = calls[0]!;
    expect(write.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(write.argv[2]).toContain(`${SWARM_KEYS_DIR}/${runId}.json`);
    expect(write.stdin).toBe(JSON.stringify(keys));
    // INV-4: no plaintext fragment in any argv or log line — stdin is the only carrier.
    for (const plaintext of Object.values(keys)) {
      expect(leakScan(plaintext, JSON.stringify(calls.map((c) => c.argv)), JSON.stringify(logs))).toBeNull();
    }
    const append = calls[1]!;
    expect(append.argv[2]).toContain("grep -q");
    expect(append.argv[2]).toContain(`${SWARM_SEAT_KEYS_ENV}=${SWARM_KEYS_DIR}/${runId}.json`);
  });

  test("deliverSeatKeys refuses a keys file whose confirmed mode is not 0600", async () => {
    const runId = "run-deliver-mode";
    const vm = await makeRun(runId);
    const { keys } = await mintSeatKeys(seatDeps(), runId, PLAN);
    const { driver } = stubExec((script) => (script.includes("cat >") ? "644" : ""));
    await expect(deliverSeatKeys({ ...seatDeps(), driver }, runId, vm, keys))
      .rejects.toThrow(/mode 644/);
  });

  // Task 6, audit-link symmetry (review finding): the single-key siblings emit
  // `deliver` (deliverRunKey) and `revoke` (revokeRunKey) links — the seat
  // functions emitted NOTHING, so a swarm run's hop 4 stopped at `mint`. Both
  // now emit one link per seat hash, same hop/subjectKind as the siblings —
  // and F006 adds a `verify-revoked` per seat hash after its `revoke`, so the
  // swarm hop-4 chain satisfies chain.ts's 4-event credential set.
  test("audit-link symmetry: mint, deliver, revoke and verify-revoked, one per seat hash", async () => {
    const runId = "run-seat-links";
    const vm = await makeRun(runId);
    store.set(runId, { requestId: "req-seat-links", extensions: { budget: { repoSlug: "qds/demo", issueId: "42" } } });
    const { keys, hashes } = await mintSeatKeys(seatDeps(), runId, PLAN);
    const { driver } = stubExec((script) => (script.includes("cat >") ? "600" : ""));
    await deliverSeatKeys({ ...seatDeps(), driver }, runId, vm, keys);
    await revokeSeatKeys(seatDeps(), runId);

    const links = auditLinks.filter((l) => l.runId === runId && l.hop === "run-credential");
    expect(links.map((l) => l.event)).toEqual([
      "mint",
      "mint",
      "deliver",
      "deliver",
      // revokeSeatKeys composes revoke → verify → both emits per hash, in
      // hashOrder: each seat's verify-revoked lands immediately after its own
      // revoke, then the next seat's pair.
      "revoke",
      "verify-revoked",
      "revoke",
      "verify-revoked",
    ]);
    expect(links.every((l) => l.subjectKind === "credential-key")).toBeTrue();
    // Every subject is one of the two seat hashes — mint, deliver, revoke AND
    // verify-revoked — never key material (INV-4/INV-AUDIT-2).
    const seatHashes = Object.values(hashes).sort();
    expect(links.map((l) => l.subjectId).sort())
      .toEqual([...seatHashes, ...seatHashes, ...seatHashes, ...seatHashes].sort());
    // F006's rows carry the emitter's standard detail — `{ keyHash }` (the
    // passed detail spreads in after it; the seat's identity rides subjectId,
    // the hash in detail is the same non-secret provider-side identifier).
    expect(links.filter((l) => l.event === "verify-revoked").map((l) => l.detail)).toEqual([
      { keyHash: hashes.lead },
      { keyHash: hashes.worker },
    ]);
    // INV-4/INV-AUDIT-2: never key material — hash subjects only, whole-array scan.
    for (const plaintext of Object.values(keys)) {
      expect(leakScan(plaintext, JSON.stringify(links))).toBeNull();
    }
  });

  // F007: the exclusion is SYMMETRIC. mintSeatKeys refuses a keyed record
  // (asserted above); this is the other door — mintRunKey over an existing
  // swarm namespace. Without it the single-key mint manufactures a hybrid
  // whose core hash teardown's verify step can never see revoked.
  test("mintRunKey refuses a swarm-keyed record — the single-key and per-seat paths are mutually exclusive", async () => {
    store.create("run-f007");
    await mintSeatKeys(seatDeps(), "run-f007", PLAN);
    let err: unknown;
    try {
      await mintRunKey(seatDeps(), "run-f007");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("already-minted");
    expect((err as CredentialLifecycleError).message).toMatch(/already carries swarm seat keys/);
    expect((err as CredentialLifecycleError).remediation).toMatch(/mutually exclusive/);
    // No second namespace, no core mint either — the refusal is total.
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(2);
    expect(store.get("run-f007").keyHash).toBeUndefined();
  });

  // F033: mintRunKey's three run-level cap guards, ported. Without them a NaN
  // cap sails `sum > capMicroUsd` (false for NaN) and mints live seat keys
  // against no real ceiling — INV-CAP-1 broken at the run level while every
  // per-seat check still passes. Each case refused BEFORE any seat mints.
  test("mintSeatKeys refuses a degenerate or above-backstop run cap before any mint (F033)", async () => {
    store.create("run-cap-guards");
    for (const [capMicroUsd, messageRe] of [
      [Number.NaN, /must be a positive integer/],
      [0, /must be a positive integer/],
      [-5_000_000, /must be a positive integer/],
      [Number.MAX_SAFE_INTEGER, /does not round-trip/],
      [50_000_001, /exceeds the backstop/],
    ] as const) {
      let err: unknown;
      try {
        await mintSeatKeys(deps({ capMicroUsd }), "run-cap-guards", PLAN);
      } catch (e) {
        err = e;
      }
      expect(err, `capMicroUsd ${capMicroUsd}`).toBeInstanceOf(CredentialLifecycleError);
      expect((err as CredentialLifecycleError).code, `capMicroUsd ${capMicroUsd}`).toBe("cap-invalid");
      expect((err as CredentialLifecycleError).message, `capMicroUsd ${capMicroUsd}`).toMatch(messageRe);
    }
    // Every refusal was pre-mint: the provider was never asked for a seat key.
    expect(api.requests).toHaveLength(0);
  });

  // F029: the runId becomes provider key names and remediation text here, so
  // it faces the same grammar deliverSeatKeys enforces before its `sh -c`
  // interpolation — the two halves of the seat lifecycle agree on what a
  // runId is, and the provider never sees the unvalidated form first.
  test("mintSeatKeys refuses a runId outside the store's hostname grammar (F029)", async () => {
    let err: unknown;
    try {
      await mintSeatKeys(seatDeps(), "run/../../etc passwd", PLAN);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("run-id-invalid");
    expect((err as CredentialLifecycleError).message).toMatch(/refusing to build provider key names/);
    expect(api.requests).toHaveLength(0);
  });

  // F034: the composed `sbx-<runId>-<seat>` is bounded by the provider's
  // 100-char key-name limit. At the grammar maxima (runId and seat both long)
  // the composition exceeds it — the wrong place to learn that is a mid-plan
  // provider death, so the refusal is pre-mint, before ANY seat.
  test("mintSeatKeys refuses a composed key name above the provider's 100-char bound (F034)", async () => {
    const longRunId = `run-${"x".repeat(88)}`; // 92 chars; passes the run-id grammar
    let err: unknown;
    try {
      await mintSeatKeys(seatDeps(), longRunId, PLAN);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLifecycleError);
    expect((err as CredentialLifecycleError).code).toBe("key-name-too-long");
    expect((err as CredentialLifecycleError).message).toMatch(/sbx-.*is 10[01] chars — the provider's key-name bound is 100/);
    expect(api.requests).toHaveLength(0);
  });

  // F011: spend MERGES instead of overwriting. A teardown retry after
  // hand-revoked seats re-reads a smaller total; storing that would rewrite
  // real captured spend downward — the authoritative-looking lie captureSpend's
  // absent-key branch exists to prevent.
  test("captureSeatSpend merges with prior spend — never rewrites it downward (F011)", async () => {
    store.create("run-merge");
    const { hashes } = await mintSeatKeys(seatDeps(), "run-merge", PLAN);
    api.setUsage(hashes.lead!, 0.1);
    api.setUsage(hashes.worker!, 0.1);
    expect(await captureSeatSpend(seatDeps(), "run-merge")).toBe(200_000);
    // A retry re-reads LESS (both seats now absent → computed 0): the stored
    // figure stands, in the return AND on the record.
    await api.deleteKey(hashes.lead!);
    await api.deleteKey(hashes.worker!);
    expect(await captureSeatSpend(seatDeps(), "run-merge")).toBe(200_000);
    expect(store.get("run-merge").spendMicroUsd).toBe(200_000);
    // The other arm: a HIGHER computed total is the one that lands — spend
    // only ever accumulates.
    store.create("run-merge-up");
    const { hashes: up } = await mintSeatKeys(seatDeps(), "run-merge-up", PLAN);
    store.set("run-merge-up", { spendMicroUsd: 500_000 }); // prior, hand-recorded
    api.setUsage(up.lead!, 0.1);
    api.setUsage(up.worker!, 0.1); // computed 200_000 < prior 500_000
    expect(await captureSeatSpend(seatDeps(), "run-merge-up")).toBe(500_000);
    api.setUsage(up.lead!, 0.8); // now computed 0.8 + 0.1 = 900_000 µ$ > prior
    expect(await captureSeatSpend(seatDeps(), "run-merge-up")).toBe(900_000);
    expect(store.get("run-merge-up").spendMicroUsd).toBe(900_000);
  });

  // F032: the count is FRESH revokes — a hash the provider answers
  // already-gone for is proven absent but was not revoked BY this call. A
  // retry over an all-already-gone namespace returns 0, so a caller can tell
  // "this pass killed N keys" from "everything was already gone".
  test("revokeSeatKeys counts fresh revokes only — already-gone seats do not count (F032)", async () => {
    store.create("run-fresh");
    const { hashes } = await mintSeatKeys(seatDeps(), "run-fresh", PLAN);
    expect(await revokeSeatKeys(seatDeps(), "run-fresh")).toBe(2);
    // Full retry: both already gone → 0, not 2.
    expect(await revokeSeatKeys(seatDeps(), "run-fresh")).toBe(0);
    // Mixed namespace: one seat revoked out of band, one live → exactly 1.
    store.create("run-fresh-mixed");
    const { hashes: mixed } = await mintSeatKeys(seatDeps(), "run-fresh-mixed", PLAN);
    await api.deleteKey(mixed.lead!);
    expect(await revokeSeatKeys(seatDeps(), "run-fresh-mixed")).toBe(1);
    // And every recorded hash is still proven absent, fresh or not.
    expect(api.keys.filter((k) => k.deleted).map((k) => k.hash).sort())
      .toEqual([...Object.values(hashes), ...Object.values(mixed)].sort());
  });
});

/** Mint a key for runId without running the whole lifecycle (test helper). */
async function mintFor(runId: string): Promise<string> {
  const res = await api.createKey(`${SBX_KEY_PREFIX}${runId}`, 50);
  store.set(runId, { keyHash: res.hash, limitMicroUsd: 50_000_000 });
  return res.hash;
}
