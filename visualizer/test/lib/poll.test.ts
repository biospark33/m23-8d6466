/**
 * F070 unit tests for src/lib/poll.ts.
 *
 * setInterval/clearInterval are stubbed per test so the backoff schedule can be
 * read off the recorded delays instead of waited out in real time; the last
 * test drops the stub to prove the tick really is what gets scheduled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_POLL_MS, POLL_MS, usePoller } from "../../src/lib/poll.ts";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/** Delays passed to setInterval, in call order. */
let armed: number[] = [];
let clears = 0;

function stubTimers() {
  armed = [];
  clears = 0;
  globalThis.setInterval = ((_fn: () => void, ms?: number) => {
    armed.push(ms ?? 0);
    return armed.length as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {
    clears++;
  }) as unknown as typeof clearInterval;
}

function restoreTimers() {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
}

describe("usePoller start/stop", () => {
  beforeEach(stubTimers);
  afterEach(restoreTimers);

  test("start arms at POLL_MS and stop disarms", () => {
    const poller = usePoller(() => {});
    expect(poller.active()).toBe(false);
    poller.start();
    expect(armed).toEqual([POLL_MS]);
    expect(poller.active()).toBe(true);
    poller.stop();
    expect(poller.active()).toBe(false);
    expect(clears).toBeGreaterThan(0);
  });

  test("start replaces a live interval rather than stacking a second one", () => {
    const poller = usePoller(() => {});
    poller.start();
    poller.start(1234);
    expect(armed).toEqual([POLL_MS, 1234]);
    expect(clears).toBe(2); // one per start, since start() stops first
  });
});

describe("usePoller backoff", () => {
  beforeEach(stubTimers);
  afterEach(restoreTimers);

  test("backs off exponentially and caps at MAX_POLL_MS", () => {
    const poller = usePoller(() => {});
    poller.start();
    for (let i = 0; i < 8; i++) poller.onFailure();
    expect(armed).toEqual([POLL_MS, 1000, 2000, 4000, 8000, 16000, MAX_POLL_MS, MAX_POLL_MS, MAX_POLL_MS]);
  });

  test("onSuccess resets the backoff to POLL_MS", () => {
    const poller = usePoller(() => {});
    poller.start();
    poller.onFailure();
    poller.onFailure();
    poller.onSuccess();
    expect(armed.at(-1)).toBe(POLL_MS);
    poller.onFailure();
    expect(armed.at(-1)).toBe(1000); // counted from zero again, not from three
  });

  test("a clean tick on an un-backed-off poller does not re-arm the interval", () => {
    const poller = usePoller(() => {});
    poller.start();
    poller.onSuccess();
    expect(armed).toEqual([POLL_MS]);
  });

  test("a tick resolving after stop never installs an interval nothing clears", () => {
    const poller = usePoller(() => {});
    poller.start();
    poller.onFailure();
    poller.stop();
    poller.onFailure();
    poller.onSuccess();
    expect(poller.active()).toBe(false);
    expect(armed).toEqual([POLL_MS, 1000]);
  });
});

describe("usePoller scheduling", () => {
  test("the armed interval calls the supplied tick", async () => {
    let ticks = 0;
    const poller = usePoller(() => {
      ticks++;
    });
    poller.start(1);
    await Bun.sleep(20);
    poller.stop();
    expect(ticks).toBeGreaterThan(0);
  });
});
