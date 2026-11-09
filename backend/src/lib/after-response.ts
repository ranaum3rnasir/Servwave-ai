/**
 * Work a route starts after (or beside) its answer: a bell, an alert email, a file brought over. The route does not wait for
 * the caller; a TEST has to know when all of it is over before it reads the result. Registering the work here costs nothing in
 * production (the same promise comes back, nothing about when it runs or how it fails changes) and lets a test wait on the
 * real completion signal instead of sleeping.
 *
 * Every piece of such work that sends mail or rings a bell must be registered here; a guard test
 * (__tests__/real-db-test-waits-guard.test.ts) rejects a bare `void alert...(` in the controllers that start it.
 */
const pending = new Set<Promise<unknown>>();

/** Registers `work` and hands back the same promise. */
export function trackAfterResponse<T>(work: Promise<T>): Promise<T> {
  const done = work.then(
    () => undefined,
    () => undefined,
  );
  pending.add(done);
  void done.then(() => pending.delete(done));
  return work;
}

/** How many tracked pieces of work are still running. */
export function pendingAfterResponse(): number {
  return pending.size;
}

/** Test-only: forget work that will never finish (a drain that timed out). */
export function forgetPendingAfterResponse(): void {
  pending.clear();
}

/**
 * Resolves once no tracked work is running, including work that tracked work started meanwhile, and once the review-attention
 * alerts a request queued (services/notifications/reviewAttentionQueue.ts, a second after-response mechanism) have been sent. Rejects when that does not
 * happen in `timeoutMs`: a drain that cannot finish is a failing test, never a quiet pass.
 */
export async function afterResponseDrained(options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  const { reviewAttentionSettled, reviewAttentionPending } = await import('../services/notifications/reviewAttentionQueue.js');
  const outstanding = () => pending.size + reviewAttentionPending();
  // The response's own 'finish' may still be on its way when the client has the answer, so one turn is always given first.
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (outstanding() > 0) {
    const left = deadline - Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(left, 0));
    });
    const outcome = await Promise.race([Promise.all([...pending, reviewAttentionSettled()]).then(() => 'drained' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout' && outstanding() > 0) {
      const n = outstanding();
      throw new Error(`${n} piece${n === 1 ? '' : 's'} of after-response work still pending after ${timeoutMs} ms`);
    }
    // Let work that finished work started register before the sets are read again.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
