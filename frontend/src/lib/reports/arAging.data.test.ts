import { describe, it, expect } from 'vitest';
import { bucketFor, aggregate, applyFilter, bucketTotals, ACCOUNTS, invoiceDate, applyDateRange, NET_TERMS_DAYS, arAgingCsv, type FlatInvoice } from './arAging.data';
import { withinRange } from '@/lib/date-range';

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000);

describe('bucketFor', () => {
  it('maps days-late to the right bucket', () => {
    expect(bucketFor(0)).toBe('current');
    expect(bucketFor(15)).toBe('1-30');
    expect(bucketFor(45)).toBe('31-60');
    expect(bucketFor(75)).toBe('61-90');
    expect(bucketFor(100)).toBe('91-120');
    expect(bucketFor(200)).toBe('121+');
  });
});

describe('aggregate', () => {
  it('sums balance, takes max days-late, and worst bucket', () => {
    const agg = aggregate([
      { number: 'I1', daysLate: 10, balance: 100 },
      { number: 'I2', daysLate: 95, balance: 400 },
    ]);
    expect(agg.balance).toBe(500);
    expect(agg.daysLate).toBe(95);
    expect(agg.bucket).toBe('91-120');
  });
});

describe('applyFilter', () => {
  const acct = ACCOUNTS[0]!;
  it('returns all invoices when filter is null', () => {
    const out = applyFilter([acct], null);
    expect(out[0]!.invoices.length).toBe(acct.invoices.length);
  });
  it('keeps only invoices in the selected buckets and drops empty customers', () => {
    const out = applyFilter(ACCOUNTS, { buckets: ['current'] });
    out.forEach((a) => a.invoices.forEach((inv) => expect(bucketFor(inv.daysLate)).toBe('current')));
    expect(out.every((a) => a.invoices.length > 0)).toBe(true);
  });
});

describe('bucketTotals', () => {
  it('returns a value for every bucket in order', () => {
    const totals = bucketTotals(ACCOUNTS);
    expect(totals.map((t) => t.bucket)).toEqual(['current', '1-30', '31-60', '61-90', '91-120', '121+']);
    expect(totals.reduce((s, t) => s + t.value, 0)).toBeGreaterThan(0);
  });
});

describe('invoiceDate', () => {
  const now = new Date(2026, 5, 7); // midnight reference so day math is exact
  it('due date is today minus days-late', () => {
    expect(daysBetween(invoiceDate({ number: 'X', daysLate: 30, balance: 1 }, 'due', now), now)).toBe(30);
    expect(daysBetween(invoiceDate({ number: 'X', daysLate: 0, balance: 1 }, 'due', now), now)).toBe(0);
  });
  it('invoice date is due minus net terms', () => {
    const inv = { number: 'X', daysLate: 10, balance: 1 };
    expect(daysBetween(invoiceDate(inv, 'issued', now), now)).toBe(10 + NET_TERMS_DAYS);
  });
});

describe('withinRange', () => {
  it('treats null bounds as open', () => {
    const d = new Date(2026, 5, 1);
    expect(withinRange(d, null, null)).toBe(true);
    expect(withinRange(d, new Date(2026, 4, 1), new Date(2026, 5, 30))).toBe(true);
    expect(withinRange(d, new Date(2026, 5, 2), null)).toBe(false);
    expect(withinRange(d, null, new Date(2026, 4, 30))).toBe(false);
  });
});

describe('applyDateRange', () => {
  const now = new Date(2026, 5, 7, 12, 0, 0);
  it('returns all accounts when both bounds are null', () => {
    expect(applyDateRange(ACCOUNTS, 'issued', null, null, now).length).toBe(ACCOUNTS.length);
  });
  it('keeps only invoices whose chosen-field date is in range, dropping empty customers', () => {
    // Last 7 days by DUE date → only invoices with daysLate <= 6 survive (the "current" ones).
    const from = new Date(now); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - 6);
    const to = new Date(now); to.setHours(23, 59, 59, 999);
    const out = applyDateRange(ACCOUNTS, 'due', from, to, now);
    out.forEach((a) => a.invoices.forEach((i) => expect(i.daysLate).toBeLessThanOrEqual(6)));
    expect(out.every((a) => a.invoices.length > 0)).toBe(true);
    // Diaz Holdings has 2 current invoices in this window, its 22-day one excluded.
    const diaz = out.find((a) => a.id === 'diaz-holdings');
    expect(diaz?.invoices.map((i) => i.number).sort()).toEqual(['I00560', 'I00561']);
  });
});

describe('arAgingCsv', () => {
  const row: FlatInvoice = {
    key: 'c1-I00247',
    customer: 'Imperiali, Ron & Rebecca',
    type: 'Residential',
    location: '—',
    number: 'I00247',
    bucket: '31-60',
    daysLate: 50,
    balance: 27819.27,
    date: new Date(2026, 3, 27),
  };

  it('uses the caller-supplied date label as the header', () => {
    expect(arAgingCsv([row], 'Due date').header[4]).toBe('Due date');
  });

  it('emits nine columns per row', () => {
    const { header, rows } = arAgingCsv([row], 'Invoice date');
    expect(header).toHaveLength(9);
    expect(rows[0]).toHaveLength(9);
  });

  // Sortable, unambiguous, and — unlike the on-screen "Apr 27, 26" — comma-free.
  it('exports the date as local-calendar ISO, not a locale string', () => {
    expect(arAgingCsv([row], 'Invoice date').rows[0]![4]).toBe('2026-04-27');
  });

  it('exports the raw numeric balance, not a formatted string', () => {
    expect(arAgingCsv([row], 'Invoice date').rows[0]![7]).toBe(27819.27);
  });

  it('passes the customer name through unmodified for the writer to escape', () => {
    expect(arAgingCsv([row], 'Invoice date').rows[0]![0]).toBe('Imperiali, Ron & Rebecca');
  });
});
