// ───────────────────────────────────────────────────────────────────────────
// Payments report — deterministic MOCK data + the demo/live data hook.
// One row = one payment received. Seeded PRNG so the numbers are stable across
// renders. Real orgs read GET /api/reports/payments (same row shape).
// ───────────────────────────────────────────────────────────────────────────
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { hashStr, mulberry32, rangeRnd } from './random';

// App "today" — fixed so mock data + relative date filters are deterministic.
export const BASE_MS = Date.parse('2026-06-07T12:00:00Z');
export const DAY = 86_400_000;

// R5b (2026-07-22) — D3. Kept identical to backend/src/services/payments-report.ts's
// PaymentMethodLabel (that file's own comment states the two must stay in lockstep).
export const PAYMENT_METHODS = ['Credit card', 'Check', 'ACH / Bank transfer', 'Cash', 'Zelle', 'Venmo', 'Cash App', 'Other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_CATEGORIES = ['Invoice', 'Deposit', 'Account', 'Recurring'] as const;
export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number];

export const PAYMENT_STATUSES = ['Succeeded', 'Pending', 'Failed', 'Refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TECHNICIANS = [
  'Emanuel Dahan',
  'Ohad',
  'Rami',
  'Priya',
  'Shaked',
  'Liran - Dor',
  'Ofir Sub',
  'Sem Pinto',
  'Shani',
  'Dispatch',
] as const;

const CLIENTS: { name: string; email: string }[] = [
  { name: 'James Iguana', email: 'iguanaxz@yahoo.com' },
  { name: 'Posinmen', email: 'posinmen@gmail.com' },
  { name: 'Valerie Marasco', email: 'valmarasco@gmail.com' },
  { name: 'Loki Golden', email: 'loki.golden@gmail.com' },
  { name: 'Derrick Collins', email: 'derrick.collins@gmail.com' },
  { name: 'Nadav', email: 'info@activesecurityinc.com' },
  { name: 'Bilton', email: 'tomer.gat@bilton.tech' },
  { name: 'Acme Facilities', email: 'ap@acmefacilities.com' },
  { name: 'Westside Plumbing', email: 'office@westsideplumb.com' },
  { name: 'Greenfield Co', email: 'billing@greenfield.co' },
  { name: 'Marina Towers', email: 'manager@marinatowers.com' },
  { name: 'Robert Hayes', email: 'r.hayes@gmail.com' },
  { name: 'Sunrise Cafe', email: 'owner@sunrisecafe.com' },
  { name: 'Delgado Rentals', email: 'admin@delgadorentals.com' },
  { name: 'Patel Residence', email: 'n.patel@outlook.com' },
  { name: 'Harbor Logistics', email: 'invoices@harborlog.com' },
];

const TXN_KINDS = ['Keyed', 'Client portal', 'Dispatch', 'Mobile'] as const;

export interface PaymentTxn {
  id: string;
  date: number; // epoch ms
  amount: number;
  tip: number;
  method: PaymentMethod;
  category: PaymentCategory;
  status: PaymentStatus;
  client: string;
  email: string;
  /** Masked last-4 for card payments, else ''. */
  card: string;
  /** Collected-by technician. */
  technician: string;
  /** Transaction origin (Keyed / Client portal / …). */
  txnKind: string;
  /** Processor confirmation note for card/ACH ("Approved"), else ''. */
  confirmation: string;
  /**
   * #498 - this row applies a deposit already collected to a final invoice. It is NOT new money
   * (the same dollars are also on the deposit's own row), so it is listed but never summed.
   * Always false in the demo dataset: the mock generator has no deposit-credit concept.
   */
  isDepositCredit: boolean;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// Weighted pick: pairs of [value, weight].
function weighted<T>(rng: () => number, pairs: [T, number][]): T {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [v, w] of pairs) {
    if ((r -= w) <= 0) return v;
  }
  return pairs[pairs.length - 1]![0];
}

export function buildPayments(): PaymentTxn[] {
  const rng = mulberry32(hashStr('payments-report-v1'));
  const rows: PaymentTxn[] = [];
  for (let i = 0; i < 64; i++) {
    const client = pick(rng, CLIENTS);
    const method = weighted<PaymentMethod>(rng, [
      ['Credit card', 5],
      ['ACH / Bank transfer', 3],
      ['Check', 2],
      ['Cash', 2],
    ]);
    const category = weighted<PaymentCategory>(rng, [
      ['Invoice', 5],
      ['Deposit', 3],
      ['Account', 2],
      ['Recurring', 2],
    ]);
    // Recurring skews small + steady; deposits mid; invoices full range.
    const amount =
      category === 'Recurring'
        ? Math.round(rangeRnd(rng, 49, 320) * 100) / 100
        : category === 'Deposit'
          ? Math.round(rangeRnd(rng, 150, 1200) * 100) / 100
          : Math.round(rangeRnd(rng, 120, 4500) * 100) / 100;

    const status = weighted<PaymentStatus>(rng, [
      ['Succeeded', 8],
      ['Pending', 2],
      ['Failed', 1],
      ['Refunded', 1],
    ]);

    // Tips only ever land on card / cash, and only sometimes.
    const tip =
      (method === 'Credit card' || method === 'Cash') && rng() < 0.25
        ? Math.round(rangeRnd(rng, 5, 60) * 100) / 100
        : 0;

    const card = method === 'Credit card' ? `XXXX${1000 + Math.floor(rng() * 8999)}` : '';
    const confirmation =
      method === 'Credit card' || method === 'ACH / Bank transfer' ? 'Approved' : '';

    const date = BASE_MS - Math.floor(rangeRnd(rng, 0, 120)) * DAY;

    rows.push({
      id: String(698520 - i),
      date,
      amount,
      tip,
      method,
      category,
      status,
      client: client.name,
      email: client.email,
      card,
      technician: pick(rng, TECHNICIANS),
      txnKind: pick(rng, TXN_KINDS),
      confirmation,
      isDepositCredit: false, // demo dataset has no deposit-credit applications
    });
  }
  return rows.sort((a, b) => b.date - a.date);
}

/**
 * Payment transactions for the report, plus the "now" both the relative-date
 * presets (resolveRange) and the weekly-window aggregations
 * (weeklyCollected/categoryBreakdown/weeklyTrend) resolve against.
 *  • demo org → the deterministic seeded mock, anchored to BASE_MS so its
 *    presets and 8-week windows match the seeded dataset.
 *  • real org → GET /api/reports/payments (every org payment, mapped to the same
 *    row shape, tip included), against the live clock — so presets and windows
 *    resolve against today, not BASE_MS.
 * The same payments-report-logic.ts aggregation runs over both, so demo + live
 * stay in lockstep. Live `now` is memoized once per mount so the report's
 * downstream useMemos stay stable.
 */
export function usePaymentsReport(isDemo: boolean): { rows: PaymentTxn[]; now: Date; isLoading: boolean } {
  // Memoized so the report's downstream useMemos stay referentially stable.
  const mock = useMemo(() => buildPayments(), []);
  const liveNow = useMemo(() => new Date(), []);
  const live = useQuery({
    queryKey: ['payments-report'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/payments');
      return (data.payments ?? []) as PaymentTxn[];
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) return { rows: mock, now: new Date(BASE_MS), isLoading: false };
  return { rows: live.data ?? [], now: liveNow, isLoading: live.isLoading };
}
