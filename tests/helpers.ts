/**
 * Cross-suite test helpers — anything imported by more than one suite lives
 * here rather than inside whichever suite happened to need it first.
 *
 * `rejection` used to sit in `tests/fleet/helpers.ts`, which made
 * `tests/providers/fake-driver.test.ts` depend on the fleet suite's internals:
 * the lower layer reaching up into the higher one, so any move or rename in the
 * fleet fixtures broke the provider suite. It also cost more than layering.
 * `tests/fleet/helpers.ts` VALUE-imports `defaultKeyCapMicroUsd` from
 * `src/providers/credentials.ts`, which drags `credentials.ts` →
 * `lib/log.ts` → `step-log.ts` into module load for every suite that
 * touches the file — a provider test paying for three modules to get one
 * promise combinator. This file imports nothing from `src/`, which is the part
 * that mattered; `node:`/`Bun` builtins are free.
 */

/**
 * Await a rejection to COMPLETION and hand back the error, so a test can assert
 * on its type, code and payload.
 *
 * NOT `await expect(p).rejects.toThrow(…)`: bun's `rejects` matcher returns
 * `undefined`, so that `await` yields a single microtask tick and lets the work
 * under test race whatever the test asserts next (typically: reading back the
 * record the failed call was supposed to leave behind). The matcher still
 * reports a mismatch, but the sequencing it reads as is not the sequencing it
 * has.
 *
 * A non-Error rejection FAILS the test rather than being wrapped into an
 * `Error`. Wrapping is what this helper used to do, and it made
 * `expect(err).toBeInstanceOf(Error)` unfailable at every call site: code that
 * regressed from `throw new FleetError(…)` to `throw "…"` still handed the
 * caller an `Error`, so the assertion passed and the regression was invisible.
 * The check belongs here, once, where the raw value is still in hand — callers
 * keep the `Error` return type and need no casts.
 */
export async function rejection(work: Promise<unknown>): Promise<Error> {
  const settled = await work.then(
    () => null,
    (e: unknown) => ({ raw: e }),
  );
  // `null` ⇒ it RESOLVED, which is the bug the caller is asserting against.
  if (settled === null) throw new Error("expected a rejection, got a resolution");
  if (!(settled.raw instanceof Error)) {
    throw new Error(
      `expected a rejection with an Error, got ${typeof settled.raw}: ${Bun.inspect(settled.raw)}`,
    );
  }
  return settled.raw;
}

/**
 * A pid that is ALIVE and is NOT this process, for as long as the caller holds
 * it — for lock fixtures that need the CONTENTION branch of a liveness probe.
 *
 * Every previous fixture for "a live foreign pid" was a GUESS at one, and both
 * guesses fail silently — the assertion under test still runs, just against the
 * wrong branch:
 *
 *  - `process.ppid`: a parent that exits mid-suite makes the probe the STALE
 *    case wearing the contention case's clothes.
 *  - pid 1: not foreign in a container, where the test runner IS pid 1. The
 *    lock body then carries OUR pid and is refused as re-entrancy — a
 *    programming error — before the contention branch is ever reached.
 *
 * Owning the process removes the guess: the pid is foreign by construction and
 * stays alive because nothing else can end it. `stop()` reaps it; call it from
 * `afterAll` so a suite never leaves the child behind.
 *
 * `unref`, so a suite that dies before its `afterAll` cannot wedge the runner
 * waiting on this child, and a bounded `sleep` so the worst case is one
 * short-lived orphan rather than a permanent one.
 */
export function liveForeignPid(): { pid: number; stop: () => void } {
  const child = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
  const stop = () => child.kill("SIGKILL");
  // Cheap, but it is the ONE assumption the caller cannot check for itself, and
  // a fixture that silently returned our own pid is precisely the bug this
  // helper replaces.
  if (child.pid === process.pid) {
    stop();
    throw new Error(`live-pid fixture spawned a child reporting our own pid ${child.pid}`);
  }
  return { pid: child.pid, stop };
}
