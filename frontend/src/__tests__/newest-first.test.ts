/**
 * `newestFirst` — the single owner of the comm timeline's DISPLAY order.
 *
 * The Job / Lead / Customer tabs and the job overview's contact card all read the aggregator's
 * ASCENDING output through this one function. It had been hand-copied at each surface and the
 * copy the Job tab needed was never written, which is the defect it exists to make unrepeatable.
 */
import { describe, it, expect } from 'vitest';
import { newestFirst, type CommItem } from '@/lib/api/jobCommunications';

function item(id: string, at: string): CommItem {
  return {
    id,
    channel: 'call',
    direction: 'in',
    who: 'Test Customer',
    title: `Call ${id}`,
    preview: '',
    at,
  };
}

describe('newestFirst', () => {
  it('flips the aggregator ascending order to newest-first', () => {
    // Deliberately in the order the endpoint returns (oldest first) — an implementation that
    // forgot to sort would return this array unchanged and fail here.
    const ascending = [
      item('oldest', '2026-06-01T14:32:00.000Z'),
      item('middle', '2026-06-01T15:10:00.000Z'),
      item('newest', '2026-06-02T09:30:00.000Z'),
    ];
    expect(newestFirst(ascending).map((i) => i.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('does not mutate the caller array (it is react-query cache data)', () => {
    const ascending = [
      item('oldest', '2026-06-01T14:32:00.000Z'),
      item('newest', '2026-06-02T09:30:00.000Z'),
    ];
    newestFirst(ascending);
    expect(ascending.map((i) => i.id)).toEqual(['oldest', 'newest']);
  });

  it('compares instants, not strings — a zone offset must not decide the order', () => {
    // Same two instants, one expressed with a +02:00 offset. Lexically
    // '2026-06-01T16:30:00+02:00' sorts AFTER '2026-06-01T15:00:00.000Z', but it is the EARLIER
    // instant (14:30Z) — which is why this is not the `localeCompare` the tabs used to do.
    const rows = [
      item('earlier-with-offset', '2026-06-01T16:30:00+02:00'),
      item('later-utc', '2026-06-01T15:00:00.000Z'),
    ];
    expect(newestFirst(rows).map((i) => i.id)).toEqual(['later-utc', 'earlier-with-offset']);
  });

  it('answers with an empty list while the query is still in flight', () => {
    expect(newestFirst(undefined)).toEqual([]);
  });
});
