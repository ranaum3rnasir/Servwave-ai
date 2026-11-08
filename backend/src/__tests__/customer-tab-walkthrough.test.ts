/**
 * The Leads tab's walkthrough date on the customer page (visits-and-task-categories slice 05),
 * now resolved on the server by ONE function (`resolveCustomerTabWalkthrough`) instead of the
 * frontend's `nextWalkthroughByLead`. These are that function's cases, ported one for one:
 *
 *   1. the next upcoming walkthrough (live, not ended yet);
 *   2. else the most recent past one, an overdue uncompleted booking included;
 *   3. else none (no walkthrough, only untimed ones, or every one was called off).
 *   A cancelled walkthrough is never the date.
 *
 * Every fixture is built from a fixed NOW passed in explicitly, so the clock never matters.
 */
import { describe, it, expect } from 'vitest';
import type { VisitStatus } from '@prisma/client';
import { resolveCustomerTabWalkthrough } from '../services/walkthrough.service';

const NOW = new Date('2026-10-02T00:00:00.000Z');

type Wt = { id: string; visit_seq: number; status: VisitStatus; scheduled_at: Date | null; scheduled_end: Date | null; is_all_day: boolean };
const wt = (over: Partial<Wt> & Pick<Wt, 'id' | 'visit_seq'>): Wt => ({
  status: 'SCHEDULED',
  scheduled_at: null,
  // A walkthrough stores a start (and a duration), so its end is left unset unless a case needs one.
  scheduled_end: null,
  is_all_day: false,
  ...over,
});
const at = (iso: string) => new Date(iso);
const pick = (visits: Wt[]) => resolveCustomerTabWalkthrough(visits, NOW);

describe('resolveCustomerTabWalkthrough - the customer Leads tab\'s walkthrough (slice 05 rule)', () => {
  it('is the next upcoming walkthrough, not the first or the last one', () => {
    const next = pick([
      wt({ id: 'w1', visit_seq: 1, status: 'COMPLETED', scheduled_at: at('2026-09-20T14:00:00.000Z') }),
      wt({ id: 'w3', visit_seq: 3, scheduled_at: at('2026-10-09T14:00:00.000Z') }),
      wt({ id: 'w2', visit_seq: 2, scheduled_at: at('2026-10-05T14:00:00.000Z') }),
    ]);
    expect(next?.id).toBe('w2');
    expect(next?.scheduled_at).toEqual(at('2026-10-05T14:00:00.000Z'));
  });

  it('when every walkthrough is past, is the latest one - an overdue uncompleted trip included', () => {
    const next = pick([
      wt({ id: 'w1', visit_seq: 1, status: 'COMPLETED', scheduled_at: at('2026-09-01T14:00:00.000Z'), scheduled_end: at('2026-09-01T15:00:00.000Z') }),
      wt({ id: 'w2', visit_seq: 2, scheduled_at: at('2026-09-20T14:00:00.000Z'), scheduled_end: at('2026-09-20T15:00:00.000Z') }),
      wt({ id: 'w0', visit_seq: 3, status: 'COMPLETED', scheduled_at: at('2026-08-10T14:00:00.000Z'), scheduled_end: at('2026-08-10T15:00:00.000Z') }),
    ]);
    expect(next?.id).toBe('w2');
  });

  it('a trip under way (started, not ended) is still the upcoming one', () => {
    const next = pick([
      wt({ id: 'w1', visit_seq: 1, status: 'IN_PROGRESS', scheduled_at: at('2026-10-01T22:00:00.000Z'), scheduled_end: at('2026-10-02T02:00:00.000Z') }),
      wt({ id: 'w2', visit_seq: 2, scheduled_at: at('2026-10-04T14:00:00.000Z') }),
    ]);
    expect(next?.id).toBe('w1');
  });

  it('ignores a cancelled walkthrough, upcoming or past', () => {
    // A cancelled trip sooner than the live one does not become "next".
    expect(pick([
      wt({ id: 'w1', visit_seq: 1, status: 'CANCELLED', scheduled_at: at('2026-10-03T09:00:00.000Z') }),
      wt({ id: 'w2', visit_seq: 2, scheduled_at: at('2026-10-08T14:00:00.000Z') }),
    ])?.id).toBe('w2');
    // Nothing upcoming: a later cancelled trip does not beat the completed one as "latest"
    // (completed, then cancelled).
    expect(pick([
      wt({ id: 'w1', visit_seq: 1, status: 'COMPLETED', scheduled_at: at('2026-09-01T14:00:00.000Z') }),
      wt({ id: 'w2', visit_seq: 2, status: 'CANCELLED', scheduled_at: at('2026-09-25T14:00:00.000Z') }),
    ])?.id).toBe('w1');
  });

  it('a lead with no walkthrough, only cancelled ones, or only untimed ones has no date', () => {
    expect(pick([])).toBeNull();
    // The lost lead: marking it lost cancelled its only trip - upcoming, and still not its date.
    expect(pick([wt({ id: 'w1', visit_seq: 1, status: 'CANCELLED', scheduled_at: at('2026-12-01T14:00:00.000Z') })])).toBeNull();
    expect(pick([wt({ id: 'w1', visit_seq: 1, scheduled_at: null })])).toBeNull();
  });

  it('keeps the chosen trip\'s all-day flag with its start (an all-day booking reads as a day, not a time)', () => {
    const next = pick([
      wt({ id: 'w1', visit_seq: 1, scheduled_at: at('2026-10-06T04:00:00.000Z'), scheduled_end: at('2026-10-07T03:59:00.000Z'), is_all_day: true }),
    ]);
    expect(next).toMatchObject({ id: 'w1', is_all_day: true });
  });

  it('two trips at the same instant resolve to the lower visit number, whatever the array order', () => {
    const same = at('2026-10-05T14:00:00.000Z');
    expect(pick([wt({ id: 'b', visit_seq: 2, scheduled_at: same }), wt({ id: 'a', visit_seq: 1, scheduled_at: same })])?.id).toBe('a');
    const past = at('2026-09-05T14:00:00.000Z');
    expect(pick([wt({ id: 'b', visit_seq: 2, scheduled_at: past }), wt({ id: 'a', visit_seq: 1, scheduled_at: past })])?.id).toBe('a');
  });
});
