import { isoDateLocal } from '@/lib/format-date';
import { withinRange } from '@/lib/date-range';
import { severityRamp, token } from '@/design-system/tokens';

export type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '91-120' | '121+';

export const BUCKET_ORDER: Bucket[] = ['current', '1-30', '31-60', '61-90', '91-120', '121+'];

/**
 * Aging buckets map current -> 121+ onto the green -> terracotta severity ramp
 * ("worse as it goes"), so the chart and the badges read calm and on-brand.
 * Order matches BUCKET_ORDER.
 *
 * This was a rainbow of six raw hexes here AND a ramp-derived copy in
 * ArAgingReport.tsx that shadowed it - two definitions of one thing, already
 * drifted apart. It is also exactly the laundering the hex ratchet exists to
 * catch: at the `style={{ background: BUCKET_COLOR[b] }}` call site the raw
 * value was invisible. One definition now, read by the data layer and the
 * report alike.
 */
const ramp = (i: number) => severityRamp[i] ?? severityRamp[severityRamp.length - 1] ?? token('--danger');
export const BUCKET_COLOR: Record<Bucket, string> = {
  current: ramp(0), '1-30': ramp(1), '31-60': ramp(2),
  '61-90': ramp(3), '91-120': ramp(4), '121+': ramp(5),
};

// Escalation cadence (catalog F4): email@20d, call@30d, call+letter@45d, final@60d.
export const ACTION: Record<Bucket, string> = {
  current: 'On track', '1-30': 'Email reminder', '31-60': 'Call',
  '61-90': 'Call + letter', '91-120': 'Final notice', '121+': 'Collections',
};

export interface Invoice { number: string; location?: string; daysLate: number; balance: number }
export interface Account { id: string; customer: string; type: 'Residential' | 'Commercial'; invoices: Invoice[] }
export interface Filter { buckets: Bucket[] }

export function bucketFor(daysLate: number): Bucket {
  if (daysLate <= 0) return 'current';
  if (daysLate <= 30) return '1-30';
  if (daysLate <= 60) return '31-60';
  if (daysLate <= 90) return '61-90';
  if (daysLate <= 120) return '91-120';
  return '121+';
}

export function aggregate(invoices: Invoice[]): { balance: number; daysLate: number; bucket: Bucket } {
  const balance = invoices.reduce((s, i) => s + i.balance, 0);
  const daysLate = invoices.reduce((m, i) => Math.max(m, i.daysLate), 0);
  const worst = invoices.reduce((m, i) => Math.max(m, BUCKET_ORDER.indexOf(bucketFor(i.daysLate))), 0);
  return { balance, daysLate, bucket: BUCKET_ORDER[worst] ?? 'current' };
}

/** Keep only invoices whose bucket is in filter.buckets; drop customers left with none. */
export function applyFilter(accounts: Account[], filter: Filter | null): Account[] {
  if (!filter) return accounts;
  return accounts
    .map((a) => ({ ...a, invoices: a.invoices.filter((i) => filter.buckets.includes(bucketFor(i.daysLate))) }))
    .filter((a) => a.invoices.length > 0);
}

// ── Date filtering ──────────────────────────────────────────────────────────
// AR aging is a snapshot, so invoices carry only days-late. We derive concrete
// dates from it relative to a reference "today": an invoice's DUE date is
// (today − daysLate); its INVOICE (issue) date is (due − net terms).
export type DateField = 'issued' | 'due';
export const NET_TERMS_DAYS = 30;

/** Resolve an invoice's date for the chosen field, relative to `now` (time stripped). */
export function invoiceDate(inv: Invoice, field: DateField, now: Date): Date {
  const due = new Date(now); due.setHours(0, 0, 0, 0);
  due.setDate(due.getDate() - inv.daysLate);
  if (field === 'due') return due;
  const issued = new Date(due); issued.setDate(issued.getDate() - NET_TERMS_DAYS);
  return issued;
}

/** Inclusive range test; a null bound means "open" on that side. */
/** Keep only invoices whose chosen-field date falls in [from, to]; drop empty customers. */
export function applyDateRange(
  accounts: Account[], field: DateField, from: Date | null, to: Date | null, now: Date,
): Account[] {
  if (!from && !to) return accounts;
  return accounts
    .map((a) => ({ ...a, invoices: a.invoices.filter((i) => withinRange(invoiceDate(i, field, now), from, to)) }))
    .filter((a) => a.invoices.length > 0);
}

/** Total balance per bucket across all given accounts' invoices, in BUCKET_ORDER. */
export function bucketTotals(accounts: Account[]): { bucket: Bucket; value: number; color: string }[] {
  const all = accounts.flatMap((a) => a.invoices);
  return BUCKET_ORDER.map((b) => ({
    bucket: b,
    value: all.filter((i) => bucketFor(i.daysLate) === b).reduce((s, i) => s + i.balance, 0),
    color: BUCKET_COLOR[b],
  }));
}

// Deterministic MOCK. Commercial = "accounts" (multi-invoice, location-grouped); Residential = individual.
export const ACCOUNTS: Account[] = [
  {
    id: 'summit-property-mgmt', customer: 'Summit Property Mgmt', type: 'Commercial',
    invoices: [
      { number: 'I00412', location: 'Maple Tower', daysLate: 134, balance: 9200 },
      { number: 'I00451', location: 'Cedar Plaza', daysLate: 128, balance: 6100 },
      { number: 'I00498', location: 'Oak Center', daysLate: 96, balance: 3100 },
    ],
  },
  {
    id: 'vega-restaurants-llc', customer: 'Vega Restaurants LLC', type: 'Commercial',
    invoices: [
      { number: 'I00521', location: 'Downtown', daysLate: 67, balance: 7400 },
      { number: 'I00540', location: 'Airport', daysLate: 52, balance: 5200 },
    ],
  },
  {
    id: 'diaz-holdings', customer: 'Diaz Holdings', type: 'Commercial',
    invoices: [
      { number: 'I00560', location: 'Unit A', daysLate: 0, balance: 4200 },
      { number: 'I00561', location: 'Unit B', daysLate: 0, balance: 3000 },
      { number: 'I00533', location: 'Warehouse', daysLate: 22, balance: 2200 },
    ],
  },
  { id: 'carter-dee', customer: 'Carter, Dee', type: 'Residential', invoices: [{ number: 'I00505', daysLate: 102, balance: 6200 }] },
  { id: 'bauer-cole', customer: 'Bauer, Cole', type: 'Residential', invoices: [
      { number: 'I00488', daysLate: 74, balance: 5300 },
      { number: 'I00502', daysLate: 70, balance: 3500 },
  ] },
  { id: 'nguyen-bao', customer: 'Nguyen, Bao', type: 'Residential', invoices: [{ number: 'I00544', daysLate: 41, balance: 3200 }] },
  { id: 'pope-neil', customer: 'Pope, Neil', type: 'Residential', invoices: [{ number: 'I00549', daysLate: 38, balance: 4100 }] },
  { id: 'hayes-victor', customer: 'Hayes, Victor', type: 'Residential', invoices: [{ number: 'I00558', daysLate: 18, balance: 1450 }] },
  { id: 'flores-ana', customer: 'Flores, Ana', type: 'Residential', invoices: [{ number: 'I00566', daysLate: 12, balance: 980 }] },
  { id: 'shaw-greg', customer: 'Shaw, Greg', type: 'Residential', invoices: [{ number: 'I00570', daysLate: 0, balance: 2100 }] },
];

/** One flattened invoice row, as the report's table and its export both consume it. */
export interface FlatInvoice {
  key: string;
  customer: string;
  type: string;
  location: string;
  number: string;
  bucket: Bucket;
  daysLate: number;
  balance: number;
  date: Date;
}

/** Header + value matrix for the CSV export. Pure, so it unit-tests without
 *  rendering the report. Values stay raw — escaping belongs to the CSV writer. */
export function arAgingCsv(
  rows: FlatInvoice[],
  dateLabel: string,
): { header: string[]; rows: unknown[][] } {
  return {
    header: ['Customer', 'Type', 'Location', 'Invoice', dateLabel, 'Bucket', 'Days Late', 'Balance', 'Next Action'],
    rows: rows.map((r) => [
      r.customer, r.type, r.location, r.number, isoDateLocal(r.date),
      r.bucket, r.daysLate, r.balance, ACTION[r.bucket],
    ]),
  };
}

/** Fixture constant for the demo org's DSO denominator. NOT a computed figure —
 *  it is the sample-data counterpart to the live trailing-90d sales the API returns. */
export const AR_DEMO_SALES_90D = 520_000;
