/**
 * Provider driver registry (DF2.1).
 *
 * `resolveDriver(name)` is the only way anything above the seam gets a driver.
 * Resolution is in-process: no socket is opened and no env secret is read. The
 * resolved driver is wrapped so every primitive call emits the observability
 * contract line — `{ requestId, runId, driver, verb, timestamp, durationMs,
 * outcome }` plus `driver_call_ms`.
 */

import { FakeDriver } from "./fake-driver.ts";
import { ExeDevDriver } from "./exedev/driver.ts";
import { log, newRequestId } from "../swarmclaw/log.ts";
import type { ProviderDriver } from "./driver.ts";

export type DriverFactory = () => ProviderDriver;

const REGISTRY = new Map<string, DriverFactory>();

/** Register a driver under a name. DF2.2 registers `exedev` the same way. */
export function registerDriver(name: string, factory: DriverFactory): void {
  REGISTRY.set(name, factory);
}

export function registeredDrivers(): string[] {
  return [...REGISTRY.keys()].sort();
}

export interface ResolveContext {
  /** Propagated from the caller (the dispatcher in DF3.1) into every log line. */
  requestId?: string;
  runId?: string;
}

export function resolveDriver(name: string, ctx: ResolveContext = {}): ProviderDriver {
  const factory = REGISTRY.get(name);
  if (!factory) {
    throw new Error(`unknown provider driver: ${name} (registered: ${registeredDrivers().join(", ") || "none"})`);
  }
  return instrument(factory(), ctx);
}

/**
 * Wrap every async primitive with the observability contract. Errors are logged
 * as `{ code, message }` and re-thrown — the wrapper never swallows or reshapes
 * a failure, and it never logs a record's `keyHash` value (it only ever sees
 * driver arguments, which carry no credential; DF2.3 delivers keys on stdin and
 * that argument is deliberately not logged).
 */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "create",
  "list",
  "destroy",
  "expose",
  "setPublic",
  "whoami",
  "exec",
  "copyFile",
]);

function instrument(driver: ProviderDriver, ctx: ResolveContext): ProviderDriver {
  const requestId = ctx.requestId ?? newRequestId();
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // Only the seam's eight primitives are driver calls. Wrapping every
      // callable turned `toString()` and a driver's own private helpers into
      // fake observability lines.
      if (typeof value !== "function" || !PRIMITIVES.has(String(prop))) return value;
      const verb = String(prop);
      return (...args: unknown[]) => {
        const started = Date.now();
        const emit = (outcome: "ok" | "error", error?: { code: string; message: string }) => {
          const durationMs = Date.now() - started;
          log({
            requestId,
            operation: `provider.${verb}`,
            agentId: null,
            timestamp: new Date().toISOString(),
            duration: durationMs,
            status: outcome,
            ...(error ? { error } : {}),
            runId: ctx.runId ?? null,
            driver: target.name,
            verb,
            durationMs,
            outcome,
            driver_call_ms: durationMs,
          });
        };
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          emit("error", { code: errCode(e), message: (e as Error).message });
          throw e;
        }
        if (!(result instanceof Promise)) {
          emit("ok");
          return result;
        }
        return result.then(
          (v) => {
            emit("ok");
            return v;
          },
          (e) => {
            emit("error", { code: errCode(e), message: (e as Error).message });
            throw e;
          },
        );
      };
    },
  });
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code ?? "driver_error";
}

registerDriver("fake", () => new FakeDriver());
// DF2.2: the exe.dev driver constructs with the production ssh runner; tests
// inject the fake substrate at the command seam instead of a second registry
// name, so "exedev" always means the real driver.
registerDriver("exedev", () => new ExeDevDriver());

export * from "./driver.ts";
export * from "./run-record.ts";
export * from "./credentials.ts";
export { FakeDriver } from "./fake-driver.ts";
export { ExeDevDriver, ExeDevDriverError, sshCommand } from "./exedev/driver.ts";
export type { ExeCommand, CreateProvenance, ExeDevDriverOptions } from "./exedev/driver.ts";
