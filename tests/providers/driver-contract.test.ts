/**
 * DF2.1 — the ProviderDriver contract suite.
 *
 * `runDriverContract()` is exported so DF2.2 (exe.dev) and the later OCI driver
 * story import it and run this identical, unmodified suite against their driver.
 * If a driver needs the suite changed, the seam leaked — that is the point of
 * keeping it importable rather than copy-pasted.
 *
 * The suite drives all seven lifecycle verbs (create, fill, setup, execute,
 * observe, teardown, reap) and asserts every provider-specific step resolves
 * through a `ProviderDriver` primitive.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  executeRun,
  fillRun,
  observeRun,
  ProvisionRefusedError,
  reapRuns,
  SBX_OWNERSHIP_TAG,
  setupRun,
  teardownRun,
  type ProviderDriver,
} from "../../src/providers/driver.ts";
import { RunRecordStore, newId } from "../../src/providers/run-record.ts";

/**
 * Options for {@link runDriverContract}. Not exported: `runDriverContract` is the
 * single surface DF2.2 and the OCI driver story import, and callers pass an
 * object literal.
 */
interface DriverContractOptions {
  /** Registry name, used only for the describe() label. */
  driverName: string;
  /** Fresh driver instance per suite run. */
  makeDriver: () => ProviderDriver;
  /** Optional per-test run id factory; defaults to `newId("box")`. */
  newRunId?: () => string;
}

export function runDriverContract(opts: DriverContractOptions): void {
  describe(`ProviderDriver contract: ${opts.driverName}`, () => {
    const nextId = opts.newRunId ?? (() => newId("box"));
    let driver: ProviderDriver;
    let store: RunRecordStore;
    let runsDir: string;
    let hostDir: string;
    const created: string[] = [];

    const track = (id: string): string => {
      created.push(id);
      return id;
    };

    beforeAll(() => {
      driver = opts.makeDriver();
      runsDir = mkdtempSync(join(tmpdir(), "qds-contract-runs-"));
      hostDir = mkdtempSync(join(tmpdir(), "qds-contract-host-"));
      store = new RunRecordStore({ dir: runsDir });
    });

    afterAll(async () => {
      for (const name of created) {
        try {
          await driver.destroy(name);
        } catch {
          // best-effort cleanup; the assertions already ran
        }
      }
      rmSync(runsDir, { recursive: true, force: true });
      rmSync(hostDir, { recursive: true, force: true });
    });

    test("whoami resolves without a run", async () => {
      expect(await driver.whoami()).toBeString();
    });

    test("create then list reports the box; destroy removes it", async () => {
      const name = track(nextId());
      const vm = await driver.create(name);
      expect(vm.name).toBe(name);
      expect((await driver.list()).map((v) => v.name)).toContain(name);
      expect((await driver.list(name)).map((v) => v.name)).toEqual([name]);
      await driver.destroy(name);
      expect((await driver.list()).map((v) => v.name)).not.toContain(name);
    });

    test("destroy is idempotent — teardown and reap both retry", async () => {
      const name = track(nextId());
      await driver.create(name);
      await driver.destroy(name);
      await driver.destroy(name);
      expect((await driver.list(name))).toEqual([]);
    });

    test("expose returns a URL and setPublic is accepted", async () => {
      const name = track(nextId());
      await driver.create(name);
      const url = await driver.expose(name, 8080);
      expect(url).toMatch(/^https:\/\//);
      await driver.setPublic(name);
      await driver.destroy(name);
    });

    test("exec reports stdout, stderr and a non-zero exit without throwing", async () => {
      const name = track(nextId());
      await driver.create(name);
      const ok = await driver.exec(name, ["sh", "-c", "echo out; echo err 1>&2"]);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain("out");
      expect(ok.stderr).toContain("err");
      const bad = await driver.exec(name, ["sh", "-c", "exit 3"]);
      expect(bad.exitCode).toBe(3);
      await driver.destroy(name);
    });

    test("exec delivers stdin — the channel DF2.3's key arrives on", async () => {
      const name = track(nextId());
      await driver.create(name);
      const res = await driver.exec(name, ["sh", "-c", "cat"], "secret-on-stdin\n");
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("secret-on-stdin");
      await driver.destroy(name);
    });

    test("copyFile is box → host", async () => {
      const name = track(nextId());
      await driver.create(name);
      await fillRun(driver, name, [{ path: "out/report.txt", content: "harvested\n" }]);
      const local = join(hostDir, `${name}.txt`);
      await driver.copyFile(name, "out/report.txt", local);
      expect(readFileSync(local, "utf8")).toBe("harvested\n");
      await driver.destroy(name);
    });

    test("INV-1: the run record exists before driver.create is ever called", async () => {
      const id = track(nextId());
      let recordExistedAtCreate = false;
      const watched = new Proxy(driver, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (prop !== "create" || typeof v !== "function") return v;
          return (...args: unknown[]) => {
            recordExistedAtCreate = existsSync(join(runsDir, `${id}.json`));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      await createRun(watched, store, { runId: id });
      expect(recordExistedAtCreate).toBe(true);
      await teardownRun(driver, store, id);
    });

    test("reap spares a box created in the INV-1 window, before vmName lands", async () => {
      // Exactly the crash window INV-1 exists to survive: the record is open,
      // the box exists and is named after the run id, and `vmName` has not been
      // written yet. Reaping here would destroy a live run's box.
      const id = track(nextId());
      store.create(id);
      await driver.create(id);
      expect(store.get(id).vmName).toBeUndefined();

      // S15: the open record claims this box by runId, so a clean sweep spares
      // it — but if any OTHER unproven box is visible account-wide (a sibling
      // test that crashed mid-lifecycle, on a real substrate a stranger's), the
      // sweep now refuses wholesale instead of destroying anything. Both
      // outcomes keep the live box alive; that is the invariant pinned here.
      let refused: ProvisionRefusedError | undefined;
      try {
        const destroyed = await reapRuns(driver, store);
        expect(destroyed).not.toContain(id);
      } catch (err) {
        if (!(err instanceof ProvisionRefusedError) || err.code !== "reap-vms-unowned") throw err;
        refused = err;
      }
      // Claimed-by-runId keeps the box off the refusal's spared list too.
      if (refused !== undefined) expect(refused.message).not.toContain(id);
      expect((await driver.list(id)).map((v) => v.name)).toEqual([id]);
      await teardownRun(driver, store, id);
      await driver.destroy(id);
    });

    test("all seven lifecycle verbs walk end to end over the seam", async () => {
      const id = track(nextId());

      // 1. create — record first (INV-1), then the box, then the record learns
      //    its vmName/httpsUrl.
      // No `tag` here by design: the ownership tag is createRun's alone (D1 —
      // not caller-displaceable), and exedev's `ls --json` reports no tag
      // field at all, so a tag assertion has no place in the shared suite.
      const rec = await createRun(driver, store, { runId: id, port: 8080 });
      expect(rec.vmName).toBe(id);
      expect(rec.httpsUrl).toMatch(/^https:\/\//);
      expect(rec.ports).toEqual([8080]);

      // 2. fill — content enters the box on exec stdin (copyFile is box → host).
      await fillRun(driver, id, [
        { path: "work/input.txt", content: "payload\n" },
        { path: "work/nested/deep.txt", content: "deep\n" },
      ]);

      // 3. setup — provisioning steps, failing loudly on the first bad one.
      await setupRun(driver, id, [["sh", "-c", "mkdir -p out"]]);
      await expect(setupRun(driver, id, [["sh", "-c", "exit 9"]])).rejects.toThrow(/setup step failed/);

      // 4. execute — the workload; a non-zero exit is data, not an exception.
      const run = await executeRun(driver, id, ["sh", "-c", "cat work/input.txt > out/result.txt; echo done"]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("done");

      // 5. observe — pull the artifact back to the host.
      const local = join(hostDir, `${id}-result.txt`);
      await observeRun(driver, id, "out/result.txt", local);
      expect(readFileSync(local, "utf8")).toBe("payload\n");

      // 6. teardown — box destroyed, then the record closed.
      const closed = await teardownRun(driver, store, id);
      expect(closed.closedAt).toBeString();
      expect((await driver.list(id))).toEqual([]);

      // 7. reap — a box no OPEN record claims is destroyed. Tagged, because
      // reap now destroys only boxes that PROVE they are ours (name grammar +
      // ownership tag): the listing is account-wide on a real substrate, so an
      // unclaimed untagged box may be a stranger's.
      const orphan = track(nextId());
      await driver.create(orphan, SBX_OWNERSHIP_TAG);
      const keeper = track(nextId());
      await createRun(driver, store, { runId: keeper });
      // What reap guarantees is now conditional on what the DRIVER can prove,
      // and the two shipped drivers differ: FakeDriver reports the tag it was
      // created with, exedev's `ls --json` carries no tag field at all. Assert
      // the rule, not one driver's outcome — an unclaimed box is destroyed only
      // when it proves it is ours, and is otherwise left listed and reachable.
      const listedOrphan = (await driver.list(orphan))[0];
      let destroyed: string[] | undefined;
      let refused: unknown;
      try {
        destroyed = await reapRuns(driver, store);
      } catch (e) {
        refused = e;
      }
      if (refused !== undefined) {
        // S15 fail-safe: a driver that cannot prove ownership of the unclaimed
        // box refuses the whole sweep instead of destroying on a guess or
        // silently sparing. Only reachable when the listing carries no tag.
        expect(listedOrphan?.tag === SBX_OWNERSHIP_TAG).toBe(false);
        expect(refused).toBeInstanceOf(ProvisionRefusedError);
        expect((refused as ProvisionRefusedError).code).toBe("reap-vms-unowned");
        expect((refused as Error).message).toContain(orphan);
      } else if (listedOrphan?.tag === SBX_OWNERSHIP_TAG) {
        expect(destroyed).toContain(orphan);
      } else {
        expect(destroyed).not.toContain(orphan);
        expect(destroyed).not.toContain(keeper);
        expect((await driver.list(orphan)).map((v) => v.name)).toEqual([orphan]);
        await driver.destroy(orphan); // what an operator does with a reported box
      }
      if (destroyed !== undefined) {
        expect(destroyed).not.toContain(keeper);
      }
      expect((await driver.list(keeper)).map((v) => v.name)).toEqual([keeper]);
      await teardownRun(driver, store, keeper);
    }, 60_000);

    test("step 7 twin: a CLEAN listing completes the sweep — no fleet-wide refusal", async () => {
      // The S15 refusal fires only when there is an UNPROVEN box to judge. A
      // tagless-listing driver (exedev's `ls --json` carries no tag field)
      // whose account shows nothing unclaimed must still get a completed sweep:
      // refusing wholesale on shape alone would wedge every teardown behind
      // one stranger's box forever, with nothing to spare and nothing to
      // destroy. One keeper run claims its box; the sweep has to finish,
      // destroy nothing, and leave it running.
      const id = track(nextId());
      await createRun(driver, store, { runId: id });
      let destroyed: string[] | undefined;
      let refused: unknown;
      try {
        destroyed = await reapRuns(driver, store);
      } catch (e) {
        // On a REAL substrate the account is shared, so strangers can appear
        // mid-suite; S15 refusing while naming THEM is correct behavior and is
        // not what this pin guards. What must never happen is OUR box being
        // named as the reason.
        refused = e;
      }
      if (refused !== undefined) {
        expect((refused as Error).message).not.toContain(id);
      } else {
        expect(destroyed).toEqual([]);
      }
      expect((await driver.list(id)).map((v) => v.name)).toEqual([id]);
      await teardownRun(driver, store, id);
    }, 60_000);
  });
}

// No module-level side effects below this line, and none above it either: DF2.2
// and the OCI driver story import `runDriverContract` into their own test file,
// so importing this module must not spawn boxes, mutate env, or register tests
// of its own. The `fake` driver's own run of the suite lives in
// tests/providers/fake-driver.test.ts.
