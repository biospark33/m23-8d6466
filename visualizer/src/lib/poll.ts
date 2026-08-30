// The live views (session list, card, trace) all tail the same store on the
// same cadence, so the cadence, the failure backoff and the "don't re-arm a
// timer that was already stopped" rule live here once instead of three times.

/** Fast enough to feel live, cheap enough to run once per visible card. */
export const POLL_MS = 500
/** Ceiling on the failure backoff — a dead api is still retried, just slowly. */
export const MAX_POLL_MS = 30_000

export interface Poller {
  /** (Re)arms the interval, replacing any live one. */
  start(ms?: number): void
  /** Disarms; safe to call when nothing is armed. */
  stop(): void
  /** True while an interval is live — a caller re-arming on a state change. */
  active(): boolean
  /** Call after a tick succeeds: clears the backoff. */
  onSuccess(): void
  /** Call after a tick fails: backs the next one off. */
  onFailure(): void
}

/**
 * Interval polling with exponential failure backoff. `tick` is invoked by the
 * interval; the caller owns its own in-flight guard and reports the outcome
 * through onSuccess/onFailure. Callers are responsible for stop() on unmount.
 */
export function usePoller(tick: () => void): Poller {
  let timer: ReturnType<typeof setInterval> | undefined
  /** Consecutive failed ticks — backs the poll off so a dead api is not
   *  hammered twice a second for as long as the tab stays open. */
  let fails = 0

  function stop(): void {
    clearInterval(timer)
    timer = undefined
  }

  function start(ms: number = POLL_MS): void {
    stop()
    timer = setInterval(tick, ms)
  }

  return {
    start,
    stop,
    active: () => timer !== undefined,
    onSuccess(): void {
      if (!fails) return
      fails = 0
      // Re-arm only if a timer is still live: a tick that resolves after
      // onUnmounted would otherwise install an interval nothing ever clears.
      if (timer) start()
    },
    onFailure(): void {
      fails++
      if (timer) start(Math.min(POLL_MS * 2 ** Math.min(fails, 6), MAX_POLL_MS))
    },
  }
}
