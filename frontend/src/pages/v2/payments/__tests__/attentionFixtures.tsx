import { expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import type { AttentionItem, AttentionResponse, AttentionType, AttentionView } from '@/lib/api/paymentsPage';

import { AttentionCard } from '../components/AttentionCard';
import { PaymentsDrawerHost } from '../components/PaymentsDrawerHost';
import { PaymentsDrawerProvider } from '../drawerHost';
import { mockApi, serve, type ServeOptions } from './paymentsFixtures';

const KEY_ID = (i: number) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;

const BY_TYPE: Record<AttentionType, Partial<AttentionItem>> = {
  failed_payment: { title: 'Bank payment failed', detail: 'The bank returned the payment', actions: ['contact_customer', 'mark_resolved'] },
  failed_refund: {
    title: 'Refund failed', detail: 'The refund did not reach the customer', actions: ['refund_again', 'mark_resolved'],
  },
  dispute: {
    title: 'Dispute needs a response', detail: 'Product not received', actions: ['respond'],
    respond_by: '2026-10-20T19:00:00.000Z', days_left: 6,
  },
  failed_payout: { title: 'Payout failed', detail: 'The bank account could not be credited', actions: ['update_bank_account'] },
  unmatched_payment: { title: 'Money received that is not on an invoice', detail: 'Not tied to an invoice', actions: ['refund', 'mark_resolved'] },
  unmatched_refund: { title: 'Refund sent that is not on an invoice', detail: 'Not tied to an invoice', actions: ['mark_resolved'] },
};

export function makeItem(i: number, type: AttentionType = 'failed_payment', over: Partial<AttentionItem> = {}): AttentionItem {
  const noInvoice = type === 'failed_payout' || type === 'unmatched_payment' || type === 'unmatched_refund';
  return {
    key: `${type}:${KEY_ID(i)}`,
    type,
    status: 'open',
    title: 'x',
    detail: 'x',
    amount: 100 + i,
    date: new Date(Date.UTC(2026, 9, 12, 15, 0) - i * 3_600_000).toISOString(),
    resolved_at: null,
    resolved_by_name: null,
    resolution: null,
    respond_by: null,
    days_left: null,
    payment_id: type === 'failed_payout' || type.startsWith('unmatched') ? null : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    payment_reference: type === 'failed_payout' || type.startsWith('unmatched') ? null : `PMT-${String(i).padStart(6, '0')}`,
    dispute_reference: type === 'dispute' ? `DSP-${String(i).padStart(6, '0')}` : null,
    reference: type === 'unmatched_payment' ? `RCV-${String(i).padStart(6, '0')}` : type === 'unmatched_refund' ? `REF-${String(i).padStart(6, '0')}` : null,
    dispute_status: type === 'dispute' ? 'NEEDS_RESPONSE' : null,
    payout_id: type === 'failed_payout' ? `po-${i}` : null,
    payout_reference: type === 'failed_payout' ? `PO-ABC${i}` : null,
    dispute_id: type === 'dispute' ? `dp-${i}` : null,
    invoice: noInvoice ? null : { id: `inv-${i}`, number: `INV-${1000 + i}` },
    customer: noInvoice ? null : { id: `c${i}`, name: `Customer ${i}`, customer_number: `C-${1000 + i}` },
    restricted: false,
    actions: [],
    refund_again: type === 'failed_refund'
      ? { invoice_id: `inv-${i}`, payment_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, amount: 40, reason_category: 'GOODWILL', reason: 'Kept the customer happy' }
      : null,
    ...BY_TYPE[type],
    ...over,
  };
}

export const resolvedItem = (i: number, over: Partial<AttentionItem> = {}) =>
  makeItem(i, 'failed_payment', {
    status: 'resolved', actions: [], resolved_at: '2026-10-10T12:00:00.000Z', resolved_by_name: 'Pat Admin',
    resolution: { text: 'Handled outside ServWave', note: null }, ...over,
  });

export interface AttentionServe extends ServeOptions {
  open?: AttentionItem[];
  resolved?: AttentionItem[];
  /** Respond to a request for this offset with a 400 and the server's message. */
  tooDeep?: boolean;
  /** Reject the first N list requests (the card's query fails). */
  failFirst?: number;
}

export const attentionCalls = (): Array<Record<string, unknown>> =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/payments-page/attention').map(([, c]) => (c as { params: Record<string, unknown> }).params);

/** The payments fixtures plus the Needs attention list, paged and searched server-side like the real route. */
export function serveAttention({ open = [], resolved = [], tooDeep, failFirst = 0, ...rest }: AttentionServe = {}) {
  serve(rest);
  let failed = 0;
  const base = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: { params?: Record<string, unknown> }) => {
    const byKey = /^\/api\/payments-page\/attention\/([^/]+)$/.exec(url);
    if (byKey) {
      const found = [...open, ...resolved].find((x) => x.key === byKey[1]);
      return found ? Promise.resolve({ data: found }) : Promise.reject({ response: { status: 404, data: { error: 'Not found' } } });
    }
    if (url !== '/api/payments-page/attention') return (base as (...a: unknown[]) => unknown)(url, config);
    if (failed < failFirst) {
      failed += 1;
      return Promise.reject(new Error('boom'));
    }
    const p = config?.params ?? {};
    const view = (p.view ?? 'open') as AttentionView;
    const limit = Number(p.limit ?? 25);
    const page = Number(p.page ?? 1);
    if (tooDeep && (page - 1) * limit > 1000) {
      return Promise.reject({ response: { status: 400, data: { error: 'Narrow with search or a type filter' } } });
    }
    let all = view === 'open' ? open : resolved;
    if (typeof p.payment_id === 'string') all = all.filter((x) => x.payment_id === p.payment_id);
    const types = (p.type as string[] | undefined) ?? [];
    if (types.length) all = all.filter((x) => types.includes(x.type));
    const q = typeof p.q === 'string' ? p.q.toLowerCase() : '';
    if (q) all = all.filter((x) => (x.customer?.name ?? '').toLowerCase().includes(q) || (x.invoice?.number ?? '').toLowerCase().includes(q));
    const items = all.slice((page - 1) * limit, page * limit);
    const body: AttentionResponse = {
      items,
      pagination: { page, limit, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / limit)) },
      counts: { open: open.length, resolved: resolved.length },
    };
    return Promise.resolve({ data: body });
  }) as never);
}

/** The Needs-attention card once it has finished loading (the card is on the page from the first render, frame first). */
export async function findCard(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: /Needs attention/ });
  await waitFor(() => expect(screen.queryByRole('status', { name: /Loading what needs attention/ })).not.toBeInTheDocument());
  return region;
}

/** The Needs-attention card with the page's drawer host beside it, the way PaymentsPage mounts them. */
export function CardWithDrawer() {
  return (
    <PaymentsDrawerProvider>
      <AttentionCard />
      <PaymentsDrawerHost />
    </PaymentsDrawerProvider>
  );
}
