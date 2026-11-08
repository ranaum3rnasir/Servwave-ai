import { logger } from './logger';

/**
 * Bounded retry for the create transactions that mint a record number.
 *
 * ## Why this exists
 *
 * `allocateNumber` (lib/numbering.ts) probes that its candidate number is free and the row
 * carrying that number is inserted milliseconds later, in the same transaction. The org-row
 * lock the allocator takes serialises allocations against each OTHER, but it does not stop a
 * concurrent *hand-typed* number — a rename, or a create with a manual id — from claiming the
 * slot in between: those writes never touch the organizations row, so they take no lock at
 * all. The unique index then rejects the insert and the caller sees a 500 while creating a
 * perfectly ordinary job.
 *
 * The product rule is the opposite of that: if the next number is taken, jump to the next free
 * one — record creation must never fail because of numbering. Re-running the allocation is what
 * makes the jump happen, because the second pass probes against the row the winner just
 * committed and steps over it.
 *
 * ## Why it wraps the transaction rather than the insert
 *
 * A unique violation aborts the whole Postgres transaction: every statement after it fails with
 * `25P02` until rollback. So the retry cannot live inside the `$transaction` callback — the
 * allocation has to be re-done in a FRESH transaction. Hence the shape
 * `withNumberCollisionRetry(() => prisma.$transaction(...))`, and hence the requirement that
 * the wrapped unit of work be safe to run twice: it is only ever re-run after a rollback that
 * discarded everything the first attempt wrote, but any side effect OUTSIDE the database
 * (email, SMS, notification, Stripe, audit log) would fire again for real. Those must stay
 * outside the wrapped region.
 *
 * ## Why detection is lenient
 *
 * In the production outage this backstops (PR #1873) Prisma reported the collision with
 * `meta.target: null` — "Unique constraint failed on the (not available)". Matching on the
 * column name alone would have missed the real thing. So an unavailable target counts as a
 * possible number collision, and a NAMED target only has to mention `number` (every record-
 * number index is `<table>_organization_id_<x>_number_key`, and the column-list spelling of
 * the same error is `['organization_id', 'job_number']`).
 *
 * That null-target arm is the broad one, and it has a cost: a P2002 that Prisma cannot map to a
 * target is retried even when it has nothing to do with numbering, so such a failure now costs
 * three identical transactions instead of one. The cost is latency only — once the attempts run
 * out the ORIGINAL error is rethrown unchanged, so the caller's error handling and the client's
 * status code are exactly what they were before. Retrying a transaction that has already rolled
 * back cannot corrupt anything; it is bounded and it is why the outage shape is covered at all.
 */
const NUMBER_TARGET_HINT = 'number';

/** Attempts, not retries: 1 means "run once, never retry". */
export const DEFAULT_NUMBER_COLLISION_ATTEMPTS = 3;

export interface NumberCollisionRetryOptions {
  /** Total attempts including the first. Bounded so a genuinely stuck allocator surfaces. */
  attempts?: number;
  /** Free-text label for the log line, e.g. `'job.create'`. */
  label?: string;
}

/**
 * True when `err` is a unique violation that MIGHT be a record-number collision.
 *
 * Deliberately inclusive on a missing/unavailable target (see the module doc) and deliberately
 * exclusive on a target that names some other unique — a duplicate email or an idempotency-key
 * claim is a real error, and retrying it would repeat the same failure while hiding its cause.
 */
export function isNumberCollision(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null | undefined;
  if (!e || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  if (target === null || target === undefined) return true;
  const asText = Array.isArray(target) ? target.join('_') : String(target);
  if (asText === '' || asText === 'null' || asText === 'undefined') return true;
  return asText.toLowerCase().includes(NUMBER_TARGET_HINT);
}

/**
 * Re-run a number-minting unit of work when another writer takes the number it allocated.
 *
 * `fn` MUST be the whole transaction, not just the insert, and must be free of side effects
 * outside the database — see the module doc for both reasons.
 *
 * On exhaustion the FIRST error is rethrown, not the last: it is the one that describes the
 * collision as it originally happened, and the later attempts are this function's own doing.
 */
export async function withNumberCollisionRetry<T>(
  fn: () => Promise<T>,
  options: NumberCollisionRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_NUMBER_COLLISION_ATTEMPTS);
  let firstErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isNumberCollision(err)) throw err;
      if (attempt === 1) firstErr = err;
      if (attempt === attempts) break;
      logger.warn('Record number collided with a concurrent write; re-allocating', {
        label: options.label ?? 'unknown',
        attempt,
        attempts,
        target: (err as { meta?: { target?: unknown } }).meta?.target ?? null,
      });
    }
  }
  throw firstErr;
}
