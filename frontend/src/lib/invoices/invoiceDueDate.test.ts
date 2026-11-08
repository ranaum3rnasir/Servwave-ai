import { describe, it, expect } from 'vitest';
import { dueDayDiff, getDueDateLabel, isOverdue, type InvoiceDetail } from './invoiceMoney';

// America/New_York is the org zone the defect was found in (UTC-4 in August, so a due instant
// in the small hours of UTC belongs to the PREVIOUS calendar day here). Asia/Manila is the
// discriminating fixture — UTC+8, i.e. the offset points the other way, so a test that passes
// in both cannot be accidentally satisfied by a fixed-direction offset.
const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

/** Only the fields these three derivations read; the rest of InvoiceDetail is irrelevant here. */
function invoice(over: Partial<InvoiceDetail>): InvoiceDetail {
  return { status: 'SENT', due_date: null, ...over } as InvoiceDetail;
}

// Staging invoice I00118 (ServWave Test org), the QA repro. Stored due_date is 02:35 UTC,
// which is 22:35 on 7/10 in New York — so the invoice page prints "Due 7/10/2026", and the
// count beside it has to be counted from 7/10 or the two contradict each other.
const I00118 = invoice({ due_date: '2026-07-11T02:35:09.368Z' });

describe('dueDayDiff', () => {
  it('counts from the ORG calendar day the due instant falls on', () => {
    const now = '2026-08-25T18:00:00.000Z'; // 14:00 in New York
    expect(dueDayDiff(I00118, NY, now)).toBe(-46);
    // The same instant is 7/11 in UTC and in Manila, hence one day fewer.
    expect(dueDayDiff(I00118, 'UTC', now)).toBe(-45);
  });

  it('returns null when the invoice has no due date at all', () => {
    expect(dueDayDiff(invoice({ due_date: null }), NY)).toBeNull();
  });
});

describe('getDueDateLabel', () => {
  // THE DEFECT. The old implementation divided the raw millisecond gap and took the
  // ceiling, which counts elapsed 24-hour periods rather than days on a calendar. Any due
  // date whose time-of-day is not exactly midnight therefore leaves a fraction that the
  // ceiling throws away, and the label reads one day short for the whole of that day.
  it('does not lose a day when the elapsed time is not a whole number of days', () => {
    // 45 days 15h25m have elapsed — a deliberately fractional gap. The old
    // Math.ceil(diffMs / DAY) answered "45 days overdue" here; 7/10 to 8/25 is 46 days.
    const now = '2026-08-25T18:00:00.000Z';
    expect(getDueDateLabel(I00118, NY, now)).toBe('46 days overdue');
  });

  it('holds one answer for a whole org day, whatever the time of day', () => {
    const acrossTheDay = [
      '2026-08-25T04:00:00.000Z', // 00:00 New York
      '2026-08-25T13:37:11.500Z', // a ragged instant mid-morning
      '2026-08-26T03:59:59.999Z', // 23:59 New York
    ].map((now) => getDueDateLabel(I00118, NY, now));
    expect(acrossTheDay).toEqual(['46 days overdue', '46 days overdue', '46 days overdue']);
  });

  it('reads "Due today" for the whole of the due day, then flips at the org midnight', () => {
    expect(getDueDateLabel(I00118, NY, '2026-07-10T13:00:00.000Z')).toBe('Due today');
    expect(getDueDateLabel(I00118, NY, '2026-07-11T03:59:59.999Z')).toBe('Due today'); // 23:59 EDT
    expect(getDueDateLabel(I00118, NY, '2026-07-11T04:00:00.000Z')).toBe('1 day overdue');
  });

  it('counts forward too, and singularises', () => {
    expect(getDueDateLabel(I00118, NY, '2026-07-09T13:00:00.000Z')).toBe('1 day left');
    expect(getDueDateLabel(I00118, NY, '2026-07-08T13:00:00.000Z')).toBe('2 days left');
  });

  it('is empty for an invoice with no due date', () => {
    expect(getDueDateLabel(invoice({ due_date: null }), NY)).toBe('');
  });

  // A calendar day is 23 or 25 hours long twice a year, so any count built on a fixed
  // 86_400_000 divisor drifts across a transition and eventually loses a whole day.
  it('counts a DST day as one day (spring forward — 23 hours)', () => {
    // US DST began 2026-03-08. Due 12:00 EST on the 7th.
    const inv = invoice({ due_date: '2026-03-07T17:00:00.000Z' });
    expect(getDueDateLabel(inv, NY, '2026-03-08T16:00:00.000Z')).toBe('1 day overdue'); // +23h
    expect(getDueDateLabel(inv, NY, '2026-03-09T16:00:00.000Z')).toBe('2 days overdue'); // +47h
  });

  it('counts a DST day as one day (fall back — 25 hours)', () => {
    // US DST ended 2026-11-01. Due 12:00 EDT on 10/31.
    const inv = invoice({ due_date: '2026-10-31T16:00:00.000Z' });
    expect(getDueDateLabel(inv, NY, '2026-11-01T17:00:00.000Z')).toBe('1 day overdue'); // +25h
    expect(getDueDateLabel(inv, NY, '2026-11-02T17:00:00.000Z')).toBe('2 days overdue'); // +49h
  });

  it('answers on the ORG clock, so the viewer\'s own zone cannot change it (#1634)', () => {
    // One org, one invoice, one instant. Which zone is passed genuinely changes the answer -
    // which is exactly why it must be the ORG's zone and never the reader's browser. At 09:00
    // New York it is already 21:00 in Manila, and the due instant lands on a different
    // calendar day in each, so a browser-zone count would have two staff quoting each other
    // different numbers for one invoice.
    const now = '2026-08-25T13:00:00.000Z';
    expect(getDueDateLabel(I00118, NY, now)).toBe('46 days overdue');
    expect(getDueDateLabel(I00118, MANILA, now)).toBe('45 days overdue');
  });
});

describe('isOverdue', () => {
  const now = '2026-08-25T18:00:00.000Z';

  it('is true for a payable invoice past its org due day', () => {
    expect(isOverdue(I00118, NY, now)).toBe(true);
    expect(isOverdue(invoice({ ...I00118, status: 'PARTIAL' }), NY, now)).toBe(true);
  });

  it('is false for a status that cannot be paid', () => {
    for (const status of ['DRAFT', 'PAID', 'VOIDED']) {
      expect(isOverdue(invoice({ ...I00118, status }), NY, now)).toBe(false);
    }
  });

  it('is false with no due date', () => {
    expect(isOverdue(invoice({ due_date: null }), NY, now)).toBe(false);
  });

  // The predicate and the label must agree, or the page renders a banner that contradicts
  // itself. Comparing raw instants made the chip flip at 22:35 on the due day while the
  // label still read "Due today" — "OVERDUE - Due today past due".
  it('never disagrees with the label it is rendered beside', () => {
    for (const at of [
      '2026-07-10T13:00:00.000Z',
      '2026-07-11T02:35:09.367Z', // one ms before the raw due instant
      '2026-07-11T02:35:09.369Z', // one ms after it — the old predicate flipped HERE
      '2026-07-11T03:59:59.999Z', // 23:59 on the due day in New York
      '2026-07-11T04:00:00.000Z', // the org midnight that actually makes it late
    ]) {
      const late = getDueDateLabel(I00118, NY, at).endsWith('overdue');
      expect(isOverdue(I00118, NY, at)).toBe(late);
    }
  });

  it('holds an invoice due today as NOT late all day — the AR report buckets it "current"', () => {
    expect(isOverdue(I00118, NY, '2026-07-11T03:59:59.999Z')).toBe(false);
    expect(isOverdue(I00118, NY, '2026-07-11T04:00:00.000Z')).toBe(true);
  });
});
