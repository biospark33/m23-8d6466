/**
 * Provider driver registry (DF2.1).
 *
 * `resolveDriver(name)` is the only way anything above the seam gets a driver.
 * Resolution is in-process: no socket is opened. It is NOT env-free — DF2.10
 * AC3 makes this the one place production reads an operator's boot-image
 * override, and `exeDevDriverFromEnv` may also open the file named by
 * `QDS_EXEDEV_REGISTRY_AUTH_FILE`. Both are create-time configuration, and
 * both are validated in `ExeDevDriver`'s constructor, at the same trust
 * boundary that refuses a bad tag. Verbs that CREATE NOTHING must not be held
 * behind those refusals — see `resolveCleanupDriver`. The resolved driver is
 * wrapped so every primitive call emits the observability contract line —
 * `{ requestId, runId, driver, verb, timestamp, durationMs, outcome }` plus
 * `driver_call_ms`.
 */

import { FakeDriver } from "./fake-driver.ts";
import { ExeDevDriverError, exeDevDriverFromEnv } from "./exedev/driver.ts";
import { log, newRequestId } from "../swarmclaw/log.ts";
import type { ProviderDriver } from "./driver.ts";
import { redactSecrets } from "./step-log.ts";

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
 * as `{ code, message }` — redacted, because `exec`/`copyFile` reject with box
 * stderr and driver argv (F020; same `redactSecrets(err.message ?? e)` form as
 * `timedLoggedStep`) — and re-thrown — the wrapper never swallows or reshapes
 * a failure, and it never logs a record's `keyHash` value (it only ever sees
 * driver arguments, which carry no credential; DF2.3 delivers keys on stdin and
 * that argument is deliberately not logged).
 */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "create",
  "list",
  "listWithAnomalies",
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
      // Only the seam's primitives are driver calls. Wrapping every callable
      // turned `toString()` and a driver's own private helpers into fake
      // observability lines. `listWithAnomalies` is in the set because the
      // reaper enumerates through it, not `list` — leaving it out made the one
      // listing that gates a destructive sweep the only unobserved driver call.
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
          emit("error", { code: errCode(e), message: redactSecrets((e as Error)?.message ?? e) });
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
            emit("error", { code: errCode(e), message: redactSecrets((e as Error)?.message ?? e) });
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
//
// DF2.10 AC3: this factory is the ONE place an operator override of the boot
// image is read, because it is the only place production constructs the driver
// — a default living only on `ExeDevDriverOptions` would never be set here.
// `exeDevDriverFromEnv` keeps the `process.env` read out of `create()`, whose
// AC3 negative control is an implementation that reads env in the hot path and
// still passes every unit test that constructs the driver directly.
registerDriver("exedev", () => exeDevDriverFromEnv());

/**
 * Resolve a driver for a verb that only ever touches boxes that ALREADY exist
 * — teardown, harvest, destroy, reap, status.
 *
 * The factory above reads the operator's create-time configuration, and the
 * constructor refuses a half-set image pin (`image-pin-incomplete`) or a
 * registry credential file anyone else can read (`registry-auth-file-mode`).
 * Both refusals are right where they are: half a pin makes every box come up,
 * pass gate A and die at gate B on what reads as a marker mismatch, and the
 * mode check is the whole security property the path-not-value indirection
 * buys. But these verbs CREATE NOTHING, and putting the create-time gate in
 * front of them meant a stray `QDS_EXEDEV_IMAGE` export left an operator
 * unable to clean up boxes that were already billing — with `asUsage`
 * (scripts/fleet.ts) flattening the refusal to exit 2, "permanently wrong,
 * never retry", while the spend kept running.
 *
 * So a create-time refusal DEGRADES here rather than failing: the retry is the
 * SAME factory over an empty environment, which is exactly the configuration
 * these verbs use — the image pin and the registry credential are read by
 * `create` and by nothing else. The refusal is never swallowed; it is logged,
 * naming what the operator has to fix before their next create.
 */
export function resolveCleanupDriver(name: string, ctx: ResolveContext = {}): ProviderDriver {
  try {
    return resolveDriver(name, ctx);
  } catch (e) {
    // Only the driver's own construction refusals degrade. An unknown driver
    // name is a bare Error and still exits 2, as it should.
    if (!(e instanceof ExeDevDriverError)) throw e;
    const requestId = ctx.requestId ?? newRequestId();
    const driver = instrument(exeDevDriverFromEnv({}, { requestId }), { ...ctx, requestId });
    log({
      requestId,
      operation: "provider.resolve",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "ok",
      error: { code: e.code, message: redactSecrets(e.message) },
      runId: ctx.runId ?? null,
      driver: name,
      outcome: "degraded",
      why: "this verb creates nothing, so it ran against the repo defaults rather than refusing — the create-time configuration above is still broken and the next create will refuse",
      remediation: e.remediation,
    });
    return driver;
  }
}

// F041: the shared `{code, remediation}` base under every error below.
export * from "./errors.ts";
export * from "./driver.ts";
export * from "./run-record.ts";
export * from "./credentials.ts";
export { FakeDriver } from "./fake-driver.ts";
export { ExeDevDriver, ExeDevDriverError, sshCommand } from "./exedev/driver.ts";
export type { ExeCommand, CreateProvenance, ExeDevDriverOptions } from "./exedev/driver.ts";
// DF2.4: cap-rejection classifier and redaction
export * from "./cap-rejection.ts";
// DF2.5: harvest + teardown join the seam's exported surface — the CLI and the
// dispatcher reach them through the same front door as everything else.
export * from "./harvest.ts";
export * from "./teardown.ts";
// DF2.6: quota ceilings (createRun's headroom gate) and the fleet-wide orphan
// reaper join the exported surface — same front door as teardown. The shared
// async bounds (withTimeout, LIST_TIMEOUT_MS) ride along from their own leaf.
export * from "./quota.ts";
export * from "./reaper.ts";
// `RUN_ID_SHAPE` arrives through BOTH star exports — it is declared in
// driver.ts (beside `isFactoryOwnedVm`, which needs it) and re-exported by
// reaper.ts so that module's existing importers are unchanged. Two star
// exports offering one name is TS2308 regardless of them resolving to the same
// declaration, so the barrel names the owner explicitly. Do NOT resolve this by
// giving reaper.ts its own copy of the regex: the two reapers share one
// ownership test precisely so they cannot drift apart on what is ours.
export { RUN_ID_SHAPE } from "./driver.ts";
export * from "./timeout.ts";
// DF2.8: the micro-dollar cost ledger (append-only, host-side) and the
// pre-spawn budget gate join the exported surface — the dispatcher (DF3.1)
// reaches them through the same front door as every other verb.
export * from "./cost-ledger.ts";
export * from "./budget-gate.ts";
