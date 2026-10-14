/**
 * Driver-registry resolution: create-time refusals vs the verbs that create
 * nothing (DF2.10 round 6, R5).
 *
 * DF2.10 AC3 makes `registerDriver("exedev", () => exeDevDriverFromEnv())` the
 * one place production reads an operator's boot-image override, and
 * `ExeDevDriver`'s constructor the trust boundary that validates it. Both stay.
 * What that change also did, unintentionally, was put those refusals in front
 * of `teardown`, `harvest`, `destroy`, `reap` and `status` — verbs that create
 * nothing. A stray `QDS_EXEDEV_IMAGE` export then left an operator unable to
 * clean up boxes that were already billing, and `asUsage` reported it as exit
 * 2: "permanently wrong, never retry".
 *
 * `resolveCleanupDriver` is the seam that fixes reachability WITHOUT moving the
 * validation. These tests pin both sides of it: the create path still refuses,
 * and the cleanup path still runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCleanupDriver, resolveDriver } from "../../src/providers/index.ts";
import { type LogEntry, setLogSink } from "../../src/lib/log.ts";

const PINNED = "ghcr.io/example/qds-exedev@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const dirs: string[] = [];
const saved = new Map<string, string | undefined>();
let logs: LogEntry[] = [];
let restoreLog: (() => void) | undefined;

function setEnv(key: string, value: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}

function captureLogs(): void {
  logs = [];
  restoreLog = setLogSink((entry) => logs.push(entry));
}

afterEach(() => {
  restoreLog?.();
  restoreLog = undefined;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveCleanupDriver — a create-time refusal must not strand a billing box", () => {
  test("a half-set image pin still refuses on the create path", () => {
    setEnv("QDS_EXEDEV_IMAGE", PINNED); // …and no QDS_EXEDEV_IMAGE_BUILD_ID
    // AC3's guard is untouched: half a pin makes every box die at gate B on a
    // marker mismatch that is really one unset variable, so it is refused
    // before a box is created.
    expect(() => resolveDriver("exedev")).toThrow(/QDS_EXEDEV_IMAGE_BUILD_ID/);
  });

  test("…and teardown/harvest/reap/status still get a driver, with the refusal logged", () => {
    setEnv("QDS_EXEDEV_IMAGE", PINNED);
    captureLogs();

    const driver = resolveCleanupDriver("exedev", { requestId: "req-cleanup" });
    expect(driver.name).toBe("exedev");
    expect(typeof driver.destroy).toBe("function");
    expect(typeof driver.listWithAnomalies).toBe("function");

    // Degraded, never silent: the operator is told what is still broken, and
    // the next create will refuse on exactly that.
    const line = logs.find((l) => l.operation === "provider.resolve");
    expect(line?.outcome).toBe("degraded");
    expect((line?.error as { code?: string } | undefined)?.code).toBe("image-pin-incomplete");
    expect(line?.remediation).toBeString();
  });

  test("a group-readable registry auth file degrades the same way", () => {
    const dir = mkdtempSync(join(tmpdir(), "qds-registry-auth-"));
    dirs.push(dir);
    const authFile = join(dir, "auth");
    writeFileSync(authFile, "user:pat\n");
    chmodSync(authFile, 0o644); // readable by someone this operator did not choose
    setEnv("QDS_EXEDEV_REGISTRY_AUTH_FILE", authFile);

    // WHICH private-registry gate fires first (INV-IBOX-3 ratification, the
    // 0600 mode, ownership) is driver.ts's business and moves; that one of
    // them refuses the create path is what this asserts.
    expect(() => resolveDriver("exedev")).toThrow(/registry/i);
    expect(resolveCleanupDriver("exedev").name).toBe("exedev");
  });

  test("an unknown driver name is still a hard failure, not a degrade", () => {
    // Only the driver's own construction refusals degrade. A typo'd --driver
    // is exactly the "permanently wrong, never retry" that exit 2 is for.
    expect(() => resolveCleanupDriver("exedevv")).toThrow(/unknown provider driver/);
  });

  test("with no override set, the cleanup seam is the ordinary resolve", () => {
    captureLogs();
    expect(resolveCleanupDriver("fake").name).toBe("fake");
    expect(logs.some((l) => l.operation === "provider.resolve")).toBe(false);
  });
});
