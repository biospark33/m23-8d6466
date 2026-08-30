/**
 * F020: the registry proxy's observability wrapper logs driver rejections. The
 * calls it wraps (`exec`, `copyFile`) reject with box stderr and driver argv,
 * so the message reaches the log sink already carrying provider text — the
 * same reason every other error sink in the module composes `redactSecrets`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { registerDriver, resolveDriver } from "../../src/providers/index.ts";
import type { ProviderDriver } from "../../src/providers/driver.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";

const SECRET = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ";

/** A driver whose two proxied calls reject with a secret-bearing message. */
function leakyDriver(sync: boolean): ProviderDriver {
  const boom = () => {
    throw new Error(`ssh exited 1: ANTHROPIC_API_KEY=${SECRET}`);
  };
  return {
    name: "leaky",
    exec: sync ? boom : async () => boom(),
    copyFile: sync ? boom : async () => boom(),
  } as unknown as ProviderDriver; // dp:ok partial driver stub standing in for ProviderDriver
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
});

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  restores.push(setLogSink((e) => entries.push(e)));
  return entries;
}

describe("F020: registry-proxy error logs are redacted", () => {
  test.each([
    ["async rejection", false],
    ["sync throw", true],
  ])("%s from exec never puts the raw key in the log line", async (_label, sync) => {
    const entries = captureLogs();
    registerDriver("f020-leaky", () => leakyDriver(sync as boolean));
    const driver = resolveDriver("f020-leaky", { requestId: "req-f020", runId: "run-f020" });

    await expect(
      (async () => (driver as unknown as { exec: () => unknown }).exec())(), // dp:ok calls a method this stub deliberately does not implement, to assert the guard rejects it
    ).rejects.toThrow();

    const errored = entries.filter((e) => e.outcome === "error");
    expect(errored.length).toBe(1);
    const message = String((errored[0]?.error as { message: string }).message);
    expect(message).not.toContain(SECRET);
    expect(message).toContain("«redacted»");
    // The surrounding context survives — redaction, not suppression.
    expect(message).toContain("ssh exited 1");
  });

  test("copyFile rejection is redacted on the same path", async () => {
    const entries = captureLogs();
    registerDriver("f020-leaky-copy", () => leakyDriver(false));
    const driver = resolveDriver("f020-leaky-copy", { requestId: "req-f020b" });
    await expect(
      (driver as unknown as { copyFile: () => Promise<unknown> }).copyFile(), // dp:ok calls a method this stub deliberately does not implement, to assert the guard rejects it
    ).rejects.toThrow();
    const errored = entries.filter((e) => e.outcome === "error");
    expect(errored.length).toBe(1);
    expect(String((errored[0]?.error as { message: string }).message)).not.toContain(SECRET);
  });
});
