/**
 * Section 4.4 of the multi-visit QA run: the customer-facing visit number had no
 * uniqueness guarantee.
 *
 * nextVisitSeqForJob is a bare aggregate with no lock, so two concurrent POSTs can read
 * the same MAX and both write seq N. That number ships in the customer's email subject
 * ("J00233 - Visit 2"), so a duplicate is two different trips the customer cannot tell
 * apart. A unique index now makes the second writer fail rather than succeed with a wrong
 * number - and this is the half that turns that failure back into a correct number instead
 * of a 500 in the dispatcher's face.
 *
 * Bursts of 2, 3, 4 and 6 simultaneous creates on staging all returned distinct numbers,
 * which is why the report grades this a latent risk: the single free-tier Render instance
 * serialises transactions this short. The window widens on a multi-instance box.
 */
import { describe, it, expect, vi } from 'vitest';

import { withVisitSeqRetry, VISIT_SEQ_UNIQUE_TARGETS } from '../services/walkthrough.service';

/** What Prisma raises when a unique index rejects a write. */
function uniqueViolation(target: string[] = ['job_id', 'visit_seq']) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  });
}

describe('withVisitSeqRetry', () => {
  it('returns the result untouched when nothing collides', async () => {
    const fn = vi.fn().mockResolvedValue({ visit_seq: 2 });
    await expect(withVisitSeqRetry(fn)).resolves.toEqual({ visit_seq: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-runs the whole unit of work when two writers pick the same number', async () => {
    // The retry has to re-run the TRANSACTION, not just the insert: a unique violation
    // aborts the transaction, so the MAX has to be re-read inside a fresh one.
    const fn = vi.fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValue({ visit_seq: 3 });
    await expect(withVisitSeqRetry(fn)).resolves.toEqual({ visit_seq: 3 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on the lead index too', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(uniqueViolation(['lead_id', 'visit_seq']))
      .mockResolvedValue({ visit_seq: 2 });
    await expect(withVisitSeqRetry(fn)).resolves.toEqual({ visit_seq: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up rather than looping for ever, and rethrows the collision', async () => {
    const fn = vi.fn().mockRejectedValue(uniqueViolation());
    await expect(withVisitSeqRetry(fn)).rejects.toMatchObject({ code: 'P2002' });
    // Bounded: a genuinely stuck allocator must surface, not spin.
    expect(fn.mock.calls.length).toBeLessThanOrEqual(4);
    expect(fn.mock.calls.length).toBeGreaterThan(1);
  });

  it('does NOT swallow a different unique violation', async () => {
    // Only the visit_seq indexes mean "someone took our number". Anything else is a real
    // error and retrying it would just repeat the same failure while hiding its cause.
    const fn = vi.fn().mockRejectedValue(uniqueViolation(['organization_id', 'code']));
    await expect(withVisitSeqRetry(fn)).rejects.toMatchObject({ code: 'P2002' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-unique error', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'P2024' }));
    await expect(withVisitSeqRetry(fn)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('names both index targets it guards', () => {
    expect(VISIT_SEQ_UNIQUE_TARGETS).toContain('visits_job_id_visit_seq_key');
    expect(VISIT_SEQ_UNIQUE_TARGETS).toContain('visits_lead_id_visit_seq_key');
  });
});
