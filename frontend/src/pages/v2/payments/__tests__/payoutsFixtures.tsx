import { useLocation, useSearchParams } from 'react-router-dom';

import type {
  PayoutDetail, PayoutPaymentRow, PayoutPaymentsResponse, PayoutRow, PayoutsListResponse, PayoutTotals,
} from '@/lib/api/paymentsPage';

import PayoutsTab from '../tabs/PayoutsTab';
import { RANGE, makeDetail, makeRow, mockApi, serve as serveBase } from './paymentsFixtures';

export function makePayout(i: number, over: Partial<PayoutRow> = {}): PayoutRow {
  return {
    id: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
    reference: `PO-${String(i).padStart(6, '0')}`,
    arrival_date: `2026-10-${String(Math.max(1, 28 - i)).padStart(2, '0')}`,
    status: 'PAID',
    destination_label: 'Chase ending 4242',
    amount: 1000 + i,
    payment_count: 3,
    ...over,
  };
}

export const manyPayouts = (n: number) => Array.from({ length: n }, (_, i) => makePayout(i + 1));

export function makePayoutPayment(i: number, over: Partial<PayoutPaymentRow> = {}): PayoutPaymentRow {
  return {
    id: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`,
    customer: { id: `c${i}`, name: `Payer ${i}` },
    invoice: { id: `inv-${i}`, number: `INV-${2000 + i}` },
    restricted: false,
    voided: false,
    charged_amount: 100,
    amount: 100,
    fee: 3,
    refunded: 0,
    net: 97,
    ...over,
  };
}

export const manyPayoutPayments = (n: number) => Array.from({ length: n }, (_, i) => makePayoutPayment(i + 1));

export interface ServePayoutsOptions {
  payouts?: PayoutRow[];
  /** What the payout holds, keyed by payout id; any other payout holds `defaultPayments`. */
  paymentsOf?: Record<string, PayoutPaymentRow[]>;
  defaultPayments?: PayoutPaymentRow[];
  /** Totals the API reports for the whole payout; defaults to the sums of the fixture rows. */
  totals?: PayoutTotals;
  failureText?: string;
  listError?: boolean;
  detailError?: boolean;
  /** The payout detail's actions: false mimics a caller who may not manage the payout account. */
  canUpdateBank?: boolean;
}

type Params = Record<string, string | number | undefined>;

const sumTotals = (rows: PayoutPaymentRow[]): PayoutTotals => ({
  amount: Math.round(rows.reduce((t, r) => t + r.amount, 0) * 100) / 100,
  fee: Math.round(rows.reduce((t, r) => t + (r.fee ?? 0), 0) * 100) / 100,
  net: Math.round(rows.reduce((t, r) => t + (r.net ?? 0), 0) * 100) / 100,
});

/** The payments-page fixtures plus the three payouts routes (and everything the payments fixtures serve). */
export function servePayouts(opts: ServePayoutsOptions = {}) {
  const { payouts = manyPayouts(60), paymentsOf = {}, defaultPayments = manyPayoutPayments(3), totals, failureText = 'The bank account could not be credited.' } = opts;
  serveBase({ rows: [] });
  const base = mockApi.get.getMockImplementation()!;
  const rowsOf = (id: string) => paymentsOf[id] ?? defaultPayments;
  mockApi.get.mockImplementation(((url: string, config?: { params?: Params }) => {
    const params = config?.params ?? {};
    if (url === '/api/payments-page/payouts') {
      if (opts.listError) return Promise.reject(new Error('boom'));
      const limit = Number(params.limit ?? 25);
      const page = Number(params.page ?? 1);
      const body: PayoutsListResponse = {
        payouts: payouts.slice((page - 1) * limit, page * limit),
        pagination: { page, limit, total: payouts.length, totalPages: Math.max(1, Math.ceil(payouts.length / limit)) },
      };
      return Promise.resolve({ data: body });
    }
    const pay = /^\/api\/payments-page\/payouts\/([^/]+)\/payments$/.exec(url);
    if (pay) {
      const rows = rowsOf(pay[1]!);
      const limit = Number(params.limit ?? 25);
      const page = Number(params.page ?? 1);
      const body: PayoutPaymentsResponse = {
        payments: rows.slice((page - 1) * limit, page * limit),
        payment_count: rows.filter((r) => !r.voided).length,
        voided_count: rows.filter((r) => r.voided).length,
        pagination: { page, limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limit)) },
        totals: totals ?? sumTotals(rows),
      };
      return Promise.resolve({ data: body });
    }
    const one = /^\/api\/payments-page\/payouts\/([^/]+)$/.exec(url);
    if (one) {
      if (opts.detailError) return Promise.reject(new Error('boom'));
      const p = payouts.find((x) => x.id === one[1]);
      if (!p) return Promise.reject(new Error('404'));
      const rows = rowsOf(p.id);
      const detail: PayoutDetail = {
        ...p,
        payment_count: rows.length,
        net_matches_payout: true,
        net_difference: 0,
        failure_text: p.status === 'FAILED' ? failureText : null,
        actions: { update_bank_account: p.status === 'FAILED' && opts.canUpdateBank !== false },
        totals: totals ?? sumTotals(rows),
      };
      return Promise.resolve({ data: detail });
    }
    const payment = /^\/api\/payments-page\/payments\/([^/]+)$/.exec(url);
    if (payment) {
      // A payment opened from inside a payout: the payout's own row names the payer.
      const all = [...Object.values(paymentsOf).flat(), ...defaultPayments];
      const hit = all.find((r) => r.id === payment[1]);
      if (hit) {
        return Promise.resolve({
          data: makeDetail(makeRow(1, { id: hit.id, customer: hit.customer, invoice: hit.invoice, restricted: hit.restricted }), { can_refund: false }),
        });
      }
    }
    return (base as (u: string, c?: unknown) => unknown)(url, config);
  }) as never);
}

export const payoutListCalls = (): Params[] =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/payments-page/payouts').map(([, c]) => (c as { params: Params }).params);
export const payoutPaymentCalls = (id: string): Params[] =>
  mockApi.get.mock.calls
    .filter(([url]) => url === `/api/payments-page/payouts/${id}/payments`)
    .map(([, c]) => (c as { params: Params }).params);

function Where() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}

/** The Payouts tab inside the frame's contract, with the address shown. */
export function PayoutsHarness({ range = RANGE }: { range?: { from: string; to: string } }) {
  const [params, setSearchParams] = useSearchParams();
  const setParams = (patch: Record<string, string | null>) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    });
  return (
    <>
      <PayoutsTab range={range} tabState={{ params, setParams }} />
      <Where />
    </>
  );
}
