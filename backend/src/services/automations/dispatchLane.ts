/**
 * A bounded lane for a burst of automation dispatches from one request (a category delete that
 * takes 500 tasks dispatches 500 "Task is deleted" runs). `dispatchAutomationEvent(ev, { lane })`
 * hands its enrolment to the lane instead of starting it on its own, and the lane runs at most
 * `maxInFlight` of them at once, starting the next as each one settles - so the burst never opens
 * 500 sets of queries against the pool together.
 *
 * Still fire-and-forget for the caller: nothing is awaited by it, the work starts on a later tick
 * (after the caller's commit, #271), and a failure never reaches it (dispatch swallows and logs).
 *
 * Its own module, not dispatch.ts, because setup.ts mocks dispatch.ts for every suite: a caller
 * creating a lane must keep working when dispatch is a bare mock.
 */
export interface DispatchLane {
  /** Queue one unit of work; it starts when fewer than `maxInFlight` are running. Never throws. */
  run(work: () => Promise<void>): void;
}

export function createDispatchLane(maxInFlight: number): DispatchLane {
  const waiting: Array<() => Promise<void>> = [];
  let running = 0;

  const pump = () => {
    while (running < maxInFlight && waiting.length > 0) {
      const work = waiting.shift()!;
      running += 1;
      void work()
        .catch(() => undefined)
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };

  return {
    run(work) {
      waiting.push(work);
      setImmediate(pump);
    },
  };
}
