/**
 * The backstop for the class of failure PR #1873 fixed one instance of.
 *
 * `allocateNumber` probes that a number is free and the row carrying it is inserted a moment
 * later. A hand-typed number (a rename, or a create with a manual id) takes NO lock on the
 * organizations row, so it can claim that slot in between — and the product rule is that a
 * taken number is stepped over, never that record creation fails. This turns the resulting
 * unique violation back into a fresh allocation.
 *
 * The detection cases are the substance: in the Northwind Services outage Prisma reported the
 * collision with `meta.target: null` ("Unique constraint failed on the (not available)"), so a
 * guard keyed on the column name alone would have sat out the real thing.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  withNumberCollisionRetry,
  isNumberCollision,
  DEFAULT_NUMBER_COLLISION_ATTEMPTS,
} from '../number-collision-retry';

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/** What Prisma raises when a unique index rejects a write. */
function uniqueViolation(target: unknown, message = 'Unique constraint failed') {
  return Object.assign(new Error(message), { code: 'P2002', meta: { target } });
}

describe('isNumberCollision', () => {
  it('accepts the shape the production outage actually reported (target: null)', () => {
    expect(isNumberCollision(uniqueViolation(null, 'Unique constraint failed on the (not available)'))).toBe(true);
  });

  it('accepts a missing meta entirely', () => {
    expect(isNumberCollision(Object.assign(new Error('x'), { code: 'P2002' }))).toBe(true);
  });

  it('accepts the index-name spelling', () => {
    expect(isNumberCollision(uniqueViolation('jobs_organization_id_job_number_key'))).toBe(true);
  });

  it('accepts the column-list spelling', () => {
    expect(isNumberCollision(uniqueViolation(['organization_id', 'estimate_number']))).toBe(true);
  });

  it('rejects a unique violation that names some other column', () => {
    expect(isNumberCollision(uniqueViolation(['organization_id', 'email']))).toBe(false);
  });

  it('rejects anything that is not P2002', () => {
    expect(isNumberCollision(Object.assign(new Error('pool'), { code: 'P2024' }))).toBe(false);
    expect(isNumberCollision(new Error('plain'))).toBe(false);
    expect(isNumberCollision(null)).toBe(false);
    expect(isNumberCollision(undefined)).toBe(false);
  });
});

describe('withNumberCollisionRetry', () => {
  it('returns the value untouched when nothing collides', async () => {
    const fn = vi.fn().mockResolvedValue({ job_number: '698855' });
    await expect(withNumberCollisionRetry(fn)).resolves.toEqual({ job_number: '698855' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-runs the whole unit of work on the null-target collision', async () => {
    // The retry has to re-run the TRANSACTION, not just the insert: a unique violation aborts
    // the transaction it happens in, so the next candidate must be probed in a fresh one.
    const fn = vi.fn()
      .mockRejectedValueOnce(uniqueViolation(null))
      .mockResolvedValue({ job_number: '698856' });
    await expect(withNumberCollisionRetry(fn)).resolves.toEqual({ job_number: '698856' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-runs on a named target too', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(uniqueViolation('invoices_organization_id_invoice_number_key'))
      .mockResolvedValue({ invoice_number: 'INV-2' });
    await expect(withNumberCollisionRetry(fn)).resolves.toEqual({ invoice_number: 'INV-2' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('returns a LATE success — the collision may repeat before it clears', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(uniqueViolation(null))
      .mockRejectedValueOnce(uniqueViolation(['organization_id', 'job_number']))
      .mockResolvedValue({ job_number: '698857' });
    await expect(withNumberCollisionRetry(fn)).resolves.toEqual({ job_number: '698857' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops at the attempt bound and rethrows the ORIGINAL error', async () => {
    const first = uniqueViolation(null, 'the original');
    const fn = vi.fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValue(uniqueViolation(null, 'a later one'));
    await expect(withNumberCollisionRetry(fn)).rejects.toBe(first);
    // Bounded: a genuinely stuck allocator must surface rather than spin.
    expect(fn).toHaveBeenCalledTimes(DEFAULT_NUMBER_COLLISION_ATTEMPTS);
  });

  it('honours an explicit attempt bound', async () => {
    const fn = vi.fn().mockRejectedValue(uniqueViolation(null));
    await expect(withNumberCollisionRetry(fn, { attempts: 5 })).rejects.toMatchObject({ code: 'P2002' });
    expect(fn).toHaveBeenCalledTimes(5);
    fn.mockClear();
    // attempts: 1 means "run once, never retry".
    await expect(withNumberCollisionRetry(fn, { attempts: 1 })).rejects.toMatchObject({ code: 'P2002' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a unique violation on a different column', async () => {
    // Retrying a duplicate email would repeat the same failure while hiding its cause.
    const fn = vi.fn().mockRejectedValue(uniqueViolation(['organization_id', 'email']));
    await expect(withNumberCollisionRetry(fn)).rejects.toMatchObject({ code: 'P2002' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-P2002 error, and rethrows it unchanged', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'P2024' });
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(withNumberCollisionRetry(fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
