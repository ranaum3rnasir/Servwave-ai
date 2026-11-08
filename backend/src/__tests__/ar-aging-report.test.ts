import { describe, it, expect } from 'vitest';
import { buildArAging, daysLateFor, computeDso, DSO_WINDOW_DAYS, NET_TERMS_DAYS, type ArInvoiceRow } from "../services/ar-aging-report";

const NOW = new Date('2026-06-19T12:00:00.000Z');

// The fixtures below are UTC-midnight instants, so they are pinned with tz='UTC' to keep
// testing the CALENDAR arithmetic in isolation. The org-zone behaviour - which is what
// production actually runs - gets its own block at the bottom of the file.
const NY = 'America/New_York';

function row(over: Partial<ArInvoiceRow>): ArInvoiceRow {
  return {
    invoiceNumber: 'I00001',
    amountDue: 100,
    dueDate: null,
    sentAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    customerId: 'cust-1',
    customerName: 'Acme Co',
    segment: 'Commercial',
    ...over,
  };
}

describe('daysLateFor', () => {
  it('uses due_date when present', () => {
    // due 10 days before now → 10 days late
    const r = row({ dueDate: new Date('2026-06-09T00:00:00.000Z') });
    expect(daysLateFor(r, NOW, 'UTC')).toBe(10);
  });

  it('is negative (not yet due) for a future due date → frontend buckets as current', () => {
    const r = row({ dueDate: new Date('2026-06-29T00:00:00.000Z') });
    expect(daysLateFor(r, NOW, 'UTC')).toBe(-10);
  });

  it('falls back to sent_at + net terms when no due_date', () => {
    // sent 40 days ago, +30 net terms → due 10 days ago → 10 late
    const r = row({ sentAt: new Date('2026-05-10T00:00:00.000Z'), dueDate: null });
    expect(daysLateFor(r, NOW, 'UTC')).toBe(40 - NET_TERMS_DAYS);
  });

  it('falls back to created_at + net terms when no due_date or sent_at', () => {
    const r = row({ createdAt: new Date('2026-05-10T00:00:00.000Z'), sentAt: null, dueDate: null });
    expect(daysLateFor(r, NOW, 'UTC')).toBe(40 - NET_TERMS_DAYS);
  });

  // Migration 20260825190000_invoice_due_date_backfill writes this same derivation INTO
  // `invoices.due_date`, so that the dashboard AR KPI and the customer Past Due tile -- neither of
  // which has the fallback above -- can finally age these rows too. The migration's contract is
  // that this report does not move when it runs: a backfilled row must age exactly as the same
  // row aged while its due_date was still NULL. These two cases pin that equivalence, so a change
  // to NET_TERMS_DAYS here (or to the INTERVAL in the migration) cannot silently desync them.
  it('ages a backfilled due_date identically to the sent_at fallback it replaces', () => {
    const sentAt = new Date('2026-05-10T00:00:00.000Z');
    const before = row({ sentAt, dueDate: null });
    // What the migration persists: sent_at + 30 days, the NET 30 default arm.
    const after = row({ sentAt, dueDate: new Date('2026-06-09T00:00:00.000Z') });
    expect(daysLateFor(after, NOW, 'UTC')).toBe(daysLateFor(before, NOW, 'UTC'));
  });

  it('ages a backfilled due_date identically to the created_at fallback it replaces', () => {
    // The never-sent population -- deposit and plan invoices, which carry no sent_at -- where the
    // migration anchors on created_at instead.
    const createdAt = new Date('2026-05-10T00:00:00.000Z');
    const before = row({ createdAt, sentAt: null, dueDate: null });
    const after = row({ createdAt, sentAt: null, dueDate: new Date('2026-06-09T00:00:00.000Z') });
    expect(daysLateFor(after, NOW, 'UTC')).toBe(daysLateFor(before, NOW, 'UTC'));
  });
});

describe('buildArAging', () => {
  it('groups invoices by customer into accounts', () => {
    const rows = [
      row({ invoiceNumber: 'I1', customerId: 'a', customerName: 'A', amountDue: 100 }),
      row({ invoiceNumber: 'I2', customerId: 'a', customerName: 'A', amountDue: 200 }),
      row({ invoiceNumber: 'I3', customerId: 'b', customerName: 'B', amountDue: 50 }),
    ];
    const accounts = buildArAging(rows, NOW, 'UTC');
    expect(accounts).toHaveLength(2);
    expect(accounts.find((x) => x.id === 'a')?.invoices).toHaveLength(2);
    expect(accounts.find((x) => x.id === 'b')?.invoices).toHaveLength(1);
  });

  it('carries segment as the account type', () => {
    const accounts = buildArAging([row({ segment: 'Residential' })], NOW, 'UTC');
    expect(accounts[0]?.type).toBe('Residential');
  });

  it('sorts accounts by total balance descending, invoices within too', () => {
    const rows = [
      row({ invoiceNumber: 'I1', customerId: 'small', customerName: 'Small', amountDue: 100 }),
      row({ invoiceNumber: 'I2', customerId: 'big', customerName: 'Big', amountDue: 300 }),
      row({ invoiceNumber: 'I3', customerId: 'big', customerName: 'Big', amountDue: 900 }),
    ];
    const accounts = buildArAging(rows, NOW, 'UTC');
    expect(accounts.map((a) => a.id)).toEqual(['big', 'small']);
    expect(accounts[0]?.invoices.map((i) => i.number)).toEqual(['I3', 'I2']); // 900 before 300
  });

  it('drops non-outstanding invoices defensively (amountDue <= 0)', () => {
    const accounts = buildArAging([row({ amountDue: 0 }), row({ invoiceNumber: 'I9', amountDue: 5 })], NOW, 'UTC');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.invoices).toHaveLength(1);
  });

  it('omits location when absent, includes it when present', () => {
    const accounts = buildArAging(
      [
        row({ invoiceNumber: 'I1', customerId: 'a', location: null }),
        row({ invoiceNumber: 'I2', customerId: 'a', location: 'Maple Tower', amountDue: 999 }),
      ],
      NOW,
      'UTC',
    );
    const invs = accounts[0]!.invoices;
    expect(invs.find((i) => i.number === 'I2')?.location).toBe('Maple Tower');
    expect(invs.find((i) => i.number === 'I1')).not.toHaveProperty('location');
  });
});

describe('buildArAging location passthrough', () => {
  const base = {
    invoiceNumber: 'I00100', amountDue: 500,
    dueDate: new Date('2026-04-01'), sentAt: null, createdAt: new Date('2026-03-01'),
    customerId: 'c1', customerName: 'Smith, John', segment: 'Residential' as const,
  };

  it('carries a location through to the invoice row', () => {
    const [acct] = buildArAging([{ ...base, location: '218 Wallis Rd, Rye, NH 03870' }], new Date('2026-05-01'), 'UTC');
    expect(acct!.invoices[0]!.location).toBe('218 Wallis Rd, Rye, NH 03870');
  });

  it('omits location when the invoice has no job-linked address', () => {
    const [acct] = buildArAging([{ ...base, location: null }], new Date('2026-05-01'), 'UTC');
    expect(acct!.invoices[0]!.location).toBeUndefined();
  });
});

describe('computeDso', () => {
  it('uses a 90-day window by default', () => {
    expect(DSO_WINDOW_DAYS).toBe(90);
  });

  it('returns (AR / sales) * window days, rounded', () => {
    expect(computeDso(100_000, 400_000)).toBe(23); // 22.5 → 23
  });

  it('returns the full window when AR equals sales', () => {
    expect(computeDso(50_000, 50_000)).toBe(90);
  });

  it('returns null when there are no sales in the window', () => {
    expect(computeDso(100_000, 0)).toBeNull();
  });

  it('returns null rather than a negative for nonsensical sales', () => {
    expect(computeDso(100_000, -5)).toBeNull();
  });

  it('returns 0 when nothing is outstanding', () => {
    expect(computeDso(0, 400_000)).toBe(0);
  });

  it('honours a custom window', () => {
    expect(computeDso(100_000, 400_000, 30)).toBe(8);
  });

  // Regression lock on the real numbers from the Lakeside cutover clone.
  it('reproduces the verified Lakeside figure', () => {
    expect(computeDso(276_854, 972_833)).toBe(26);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The org-zone contract. This is the arm production runs, and the one the
// invoice detail page's "N days overdue" label now shares.
// ─────────────────────────────────────────────────────────────────────────────
describe('daysLateFor — org calendar days', () => {
  // Staging invoice I00118, the QA repro. due_date is 02:35 UTC, which is 22:35 the
  // PREVIOUS EVENING in New York — so the org's calendar says the invoice came due on
  // 7/10, which is exactly the date the invoice page prints beside this number. The old
  // UTC-midnight strip answered 7/11 and shipped a count one short of the printed date.
  const I00118 = row({ dueDate: new Date('2026-07-11T02:35:09.368Z') });

  it('counts from the ORG day the due instant falls on, not the UTC one', () => {
    const at = new Date('2026-08-25T18:00:00.000Z'); // 14:00 in New York
    expect(daysLateFor(I00118, at, NY)).toBe(46);
    expect(daysLateFor(I00118, at, 'UTC')).toBe(45); // what the old code always answered
  });

  // THE DEFECT. A due date whose time-of-day is not midnight leaves a fractional day in
  // the raw millisecond gap, and flooring that gap throws the fraction away — the count
  // reads one short for the whole of the day it is short on. Whole calendar days are
  // immune, so the answer must not move as the clock walks across a single org day.
  it('is stable across a whole org day, however fractional the elapsed time', () => {
    const acrossTheDay = [
      '2026-08-25T04:00:01.000Z', // 00:00 New York, one second into the day
      '2026-08-25T13:37:11.500Z', // mid-morning, a deliberately ragged instant
      '2026-08-26T03:59:59.999Z', // 23:59 New York, the last instant of the day
    ].map((iso) => daysLateFor(I00118, new Date(iso), NY));

    expect(acrossTheDay).toEqual([46, 46, 46]);

    // The elapsed gap over that same span crosses a whole-day boundary (45.x → 46.x), which
    // is precisely why flooring it produced two different answers on one calendar day.
    const elapsed = (iso: string) =>
      Math.floor((Date.parse(iso) - I00118.dueDate!.getTime()) / 86_400_000);
    expect(elapsed('2026-08-25T04:00:01.000Z')).toBe(45);
    expect(elapsed('2026-08-26T03:59:59.999Z')).toBe(46);
  });

  it('treats the due day itself as 0 — due today is not yet late', () => {
    // 23:00 on 7/10 in New York: still the due day, still not late.
    expect(daysLateFor(I00118, new Date('2026-07-11T03:00:00.000Z'), NY)).toBe(0);
    // One minute past midnight on 7/11 in New York: one day late.
    expect(daysLateFor(I00118, new Date('2026-07-11T04:01:00.000Z'), NY)).toBe(1);
  });

  // A calendar day is 23 or 25 hours long twice a year, so any count built from a fixed
  // 86_400_000 divisor drifts an hour across a transition and eventually loses a whole day.
  it('counts DST days as one day each (spring forward, 23 hours)', () => {
    // US DST began 2026-03-08. 12:00 New York on the 7th → 12:00 on the 9th is 47 hours,
    // but it is two calendar days.
    const r = row({ dueDate: new Date('2026-03-07T17:00:00.000Z') }); // 12:00 EST
    expect(daysLateFor(r, new Date('2026-03-08T16:00:00.000Z'), NY)).toBe(1); // 12:00 EDT, +23h
    expect(daysLateFor(r, new Date('2026-03-09T16:00:00.000Z'), NY)).toBe(2); // +47h
  });

  it('counts DST days as one day each (fall back, 25 hours)', () => {
    // US DST ended 2026-11-01.
    const r = row({ dueDate: new Date('2026-10-31T16:00:00.000Z') }); // 12:00 EDT
    expect(daysLateFor(r, new Date('2026-11-01T17:00:00.000Z'), NY)).toBe(1); // 12:00 EST, +25h
    expect(daysLateFor(r, new Date('2026-11-02T17:00:00.000Z'), NY)).toBe(2); // +49h
  });

  it('adds net terms in calendar days, so the fallback also survives a DST change', () => {
    // Sent 12:00 New York on 2026-02-20; +30 CALENDAR days is 2026-03-22, and the window
    // contains the spring-forward transition. A +30×24h instant offset would land an hour
    // early and, for an evening send, on the previous org day.
    const r = row({ sentAt: new Date('2026-02-20T17:00:00.000Z'), dueDate: null });
    expect(daysLateFor(r, new Date('2026-03-22T16:00:00.000Z'), NY)).toBe(0);
    expect(daysLateFor(r, new Date('2026-03-23T16:00:00.000Z'), NY)).toBe(1);
  });

  it('ages one invoice identically for every viewer — the zone is the org\'s, not the reader\'s', () => {
    const at = new Date('2026-08-25T18:00:00.000Z');
    // Same org, same invoice: the answer is a property of the org, so it cannot depend on
    // where the person reading it is standing. Both of these are the ORG zone being passed.
    expect(daysLateFor(I00118, at, NY)).toBe(46);
    expect(buildArAging([I00118], at, NY)[0]!.invoices[0]!.daysLate).toBe(46);
  });
});
