import { vi } from 'vitest';
import { useLocation, useSearchParams } from 'react-router-dom';

import api from '@/lib/axios';
import type { PaymentDetail, PaymentRow, PaymentsListResponse, PaymentsSummary } from '@/lib/api/paymentsPage';

import PaymentsTab from '../tabs/PaymentsTab';

export const mockApi = vi.mocked(api);

export const RANGE = { from: '2026-09-14', to: '2026-10-13' };

export const SUMMARY: PaymentsSummary = {
  collected: 12480, fees: 374.4, net: 12105.6, refunds: 250, count: 120, fees_pending: 0, disputed_count: 3,
  next_payout: { amount: 0, in_transit: 0, date: null, schedule_text: null, bank_label: null },
};

export function makeRow(i: number, over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    date: new Date(Date.UTC(2026, 9, 12, 15, 0) - i * 3_600_000).toISOString(),
    status: 'Succeeded',
    method: 'CARD',
    method_label: 'Credit card',
    method_detail: 'Visa ending 4242',
    amount: 100 + i,
    fee: 3.5,
    net: 96.5 + i,
    refunded: 0,
    payout: null,
    payout_status: 'awaiting',
    customer: { id: `c${i}`, name: `Customer ${i}` },
    invoice: { id: `inv-${i}`, number: `INV-${1000 + i}` },
    restricted: false,
    ...over,
  };
}

export const manyRows = (n: number) => Array.from({ length: n }, (_, i) => makeRow(i + 1));

export function makeDetail(row: PaymentRow, over: Partial<PaymentDetail> = {}): PaymentDetail {
  return {
    ...row,
    invoice_amount: row.amount,
    tip: 0,
    service_fee: 0,
    failure_text: null,
    refunds: [],
    dispute: null,
    timeline: [{ label: 'Paid', at: row.date, note: null, tone: 'success' }],
    refundable_amount: row.amount,
    can_refund: true,
    can_respond_dispute: false,
    can_open_invoice: true,
    ...over,
  };
}

export interface ServeOptions {
  rows?: PaymentRow[];
  summary?: PaymentsSummary;
  detail?: (id: string) => PaymentDetail | Promise<PaymentDetail>;
  exportRows?: () => unknown;
  listError?: boolean;
}

type Params = Record<string, string | number | undefined>;

export function serve({ rows = manyRows(120), summary = SUMMARY, detail, exportRows, listError }: ServeOptions = {}) {
  mockApi.get.mockImplementation(((url: string, config?: { params?: Params }) => {
    const params = config?.params ?? {};
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
    if (url === '/api/payments-page/summary') return Promise.resolve({ data: summary });
    if (url === '/api/payments-page/payments/export') {
      if (exportRows) return Promise.resolve({ data: exportRows() });
      return Promise.resolve({
        data: { payments: rows.map((r) => ({ ...r, customer_name: r.restricted ? 'Restricted' : r.customer!.name, invoice_number: r.restricted ? 'Restricted' : r.invoice!.number })) },
      });
    }
    if (url === '/api/payments-page/payments') {
      if (listError) return Promise.reject(new Error('boom'));
      const limit = Number(params.limit ?? 25);
      const page = Number(params.page ?? 1);
      let list = [...rows];
      if (params.sortBy === 'amount') list.sort((a, b) => (params.sortDir === 'asc' ? a.amount - b.amount : b.amount - a.amount));
      list = list.slice((page - 1) * limit, page * limit);
      const body: PaymentsListResponse = {
        payments: list,
        pagination: { page, limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limit)) },
      };
      return Promise.resolve({ data: body });
    }
    const m = /^\/api\/payments-page\/payments\/([^/]+)$/.exec(url);
    if (m) {
      const id = m[1]!;
      if (detail) return Promise.resolve(detail(id)).then((d) => ({ data: d }));
      const r = rows.find((x) => x.id === id);
      return r ? Promise.resolve({ data: makeDetail(r) }) : Promise.reject(new Error('404'));
    }
    return Promise.resolve({ data: {} });
  }) as never);
}

export const listCalls = (): Params[] =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/payments-page/payments').map(([, c]) => (c as { params: Params }).params);
export const lastList = () => listCalls().at(-1)!;
export const exportCalls = (): Params[] =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/payments-page/payments/export').map(([, c]) => (c as { params: Params }).params);

function Where() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}

/** The tab inside the frame's contract: the page's query string and a setter, as PaymentsPage provides them. */
export function TabHarness({ range = RANGE }: { range?: { from: string; to: string } }) {
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
      <PaymentsTab range={range} tabState={{ params, setParams }} />
      <Where />
    </>
  );
}

export const urlSearch = () => document.querySelector('[data-testid="search"]')!.textContent ?? '';
