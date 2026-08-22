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
 * `swarmclaw/log.ts` → `step-log.ts` into module load for every suite that
 * touches the file — a provider test paying for three modules to get one
 * promise combinator. This file imports nothing.
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
