/**
 * DF2.6 fleet seeder — one declarative call standing up a correlated
 * VM × key × record population over FakeDriver + FakeKeyApi + RunRecordStore
 * in a single tmpdir.
 *
 * The three-way join's derived runId is the spine: a VM IS its runId, a key's
 * runId is its `sbx-` name minus the prefix, a record's runId is its filename
 * stem. Seeds express population in those terms — `tag: null` is the
 * explicitly-UNTAGGED shape-matching VM (AC1's foreign negative control),
 * `createdAt` back-dates a key past/below `staleAfterMs`, `keyApiOpts` passes
 * FakeKeyApi knobs through (`omitCreatedAt` for key-age-unavailable,
 * `deleteStatus` for a teardown that always fails at revoke, `listTruncated`
 * for AC4), and `FleetRecord.keyHash` overrides the joined key's real hash
 * (the two-credentials-claim-one-run mismatch fixture).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SBX_OWNERSHIP_TAG } from "../../../src/providers/driver.ts";
import { SBX_KEY_PREFIX } from "../../../src/providers/credentials.ts";
import { FakeDriver } from "../../../src/providers/fake-driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { FakeKeyApi, type FakeKeyApiOptions } from "./fake-key-api.ts";

/** `tag` undefined ⇒ owned default (SBX_OWNERSHIP_TAG); `null` ⇒ explicitly untagged. */
export interface FleetVm {
  name: string;
  tag?: string | null;
}

/** `runId` builds `sbx-<runId>` unless `name` is given; `hash` overrides the entry's real hash. */
export interface FleetKey {
  runId?: string;
  name?: string;
  hash?: string;
  createdAt?: string;
  usageUsd?: number;
  /** Key-name prefix for the derived runId join. Default "sbx-". */
  prefix?: string;
}

/** `ageMs` back-dates `createdAt` from `now`; `closed` closes the record after any `set`. */
export interface FleetRecord {
  runId: string;
  /** Defaults to the seeded VM named `runId` when one exists. */
  vmName?: string;
  /** Defaults to the joined `sbx-<runId>` key's real hash — or, failing that, any key seeded by `runId` (custom prefix). */
  keyHash?: string;
  ageMs?: number;
  closed?: boolean;
}

export interface FleetState {
  vms?: FleetVm[];
  keys?: FleetKey[];
  records?: FleetRecord[];
  /** Passed to the FakeKeyApi constructor (deleteStatus, listTruncated, …). */
  keyApiOpts?: FakeKeyApiOptions;
}

export interface SeededFleet {
  driver: FakeDriver;
  keyApi: FakeKeyApi;
  store: RunRecordStore;
  boxesDir: string;
  /** Scratch parity dir — FakeKeyApi itself is in-memory. */
  keysDir: string;
  runsDir: string;
}

export async function seedFleet(
  baseDir: string,
  state: FleetState,
  now: Date = new Date(),
): Promise<SeededFleet> {
  const boxesDir = join(baseDir, "boxes");
  const runsDir = join(baseDir, "runs");
  const keysDir = join(baseDir, "keys");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const driver = new FakeDriver(boxesDir);
  const store = new RunRecordStore(runsDir);
  const keyApi = new FakeKeyApi(state.keyApiOpts);

  const vmNames = new Set<string>();
  for (const vm of state.vms ?? []) {
    if (!vm.name) throw new Error(`FleetVm needs a name (got ${JSON.stringify(vm)})`);
    if (vmNames.has(vm.name)) throw new Error(`duplicate FleetVm name: ${vm.name}`);
    // undefined ⇒ owned default; null ⇒ deliberately untagged (foreign control)
    const tag = vm.tag === null ? undefined : vm.tag ?? SBX_OWNERSHIP_TAG;
    await driver.create(vm.name, tag);
    vmNames.add(vm.name);
  }

  // key name -> hash the provider list reports (post any custom-hash mutation)
  const hashesByName = new Map<string, string>();
  // runId -> hash for keys seeded BY runId (any prefix) — the record join's
  // fallback when no canonical `sbx-<runId>` key exists
  const hashesByRunId = new Map<string, string>();
  for (const k of state.keys ?? []) {
    if (k.name === undefined && k.runId === undefined) {
      throw new Error(`FleetKey needs a runId or a name (got ${JSON.stringify(k)})`);
    }
    const name = k.name ?? `${k.prefix ?? SBX_KEY_PREFIX}${k.runId}`;
    const minted = await keyApi.createKey(name, 50);
    if (k.usageUsd !== undefined) keyApi.setUsage(minted.hash, k.usageUsd);
    if (k.createdAt !== undefined) keyApi.backdateKey(name, k.createdAt);
    let hash = minted.hash;
    if (k.hash !== undefined) {
      // mismatch fixture: the LIST's hash is what the join compares against
      const entry = keyApi.keys.find((e) => e.name === name);
      if (!entry) throw new Error(`fake key api lost the entry for ${name}`);
      entry.hash = k.hash;
      hash = k.hash;
    }
    hashesByName.set(name, hash);
    if (k.runId !== undefined) hashesByRunId.set(k.runId, hash);
  }

  for (const r of state.records ?? []) {
    if (!r.runId) throw new Error(`FleetRecord needs a runId (got ${JSON.stringify(r)})`);
    const created = new Date(now.getTime() - (r.ageMs ?? 0));
    store.create(r.runId, created);
    const patch: { vmName?: string; keyHash?: string } = {};
    if (r.vmName !== undefined) patch.vmName = r.vmName;
    else if (vmNames.has(r.runId)) patch.vmName = r.runId;
    if (r.keyHash !== undefined) patch.keyHash = r.keyHash;
    else {
      // canonical sbx-<runId> name first (the sweep's own join key), then any
      // key seeded by runId under a custom prefix
      const joined = hashesByName.get(`${SBX_KEY_PREFIX}${r.runId}`) ?? hashesByRunId.get(r.runId);
      if (joined !== undefined) patch.keyHash = joined;
    }
    if (patch.vmName !== undefined || patch.keyHash !== undefined) store.set(r.runId, patch);
    if (r.closed) store.close(r.runId, created);
  }

  return { driver, keyApi, store, boxesDir, keysDir, runsDir };
}
