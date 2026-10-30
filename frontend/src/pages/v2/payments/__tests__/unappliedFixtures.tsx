import type { AttachableInvoice, AttentionItem, UnappliedDetail } from '@/lib/api/paymentsPage';

import { makeItem, serveAttention, type AttentionServe } from './attentionFixtures';
import { mockApi } from './paymentsFixtures';

export const CAPTURE_ID = '00000000-0000-4000-9000-0000000000a1';
export const PAYMENT_KEY = `unmatched_payment:${CAPTURE_ID}`;
export const REFUND_KEY = `unmatched_refund:${CAPTURE_ID}`;

const BLOCK = {
  restricted: false as const, id: 'cust-9', customer_number: 'C-1009', name: 'Dana Reyes', company: null, address: null,
  phone: '5551234567', email: 'dana@example.com', job: null, lead: null, invoice: { id: 'inv-meant', number: 'INV-1301' },
};

/** An unapplied payment as the drawer reads it: wrong amount against INV-1301, a card, one suggested invoice. */
export function makeUnapplied(over: Partial<UnappliedDetail> = {}): UnappliedDetail {
  return {
    id: CAPTURE_ID,
    key: PAYMENT_KEY,
    kind: 'PAYMENT',
    title: 'Money received that is not on an invoice',
    status: 'open',
    amount: 120,
    reference: 'RCV-48213AAA',
    created_at: '2026-10-14T18:08:00.000Z',
    reason_short: 'Amount did not match',
    reason_long: 'The payment is $120.00 but INV-1301 is $150.00.',
    restricted: false,
    meant_for: { invoice: { id: 'inv-meant', number: 'INV-1301', status: 'SENT', total: 150 } },
    customer_block: BLOCK,
    payer: {
      received_at: '2026-10-14T18:08:00.000Z', reference: 'RCV-48213AAA', method_label: 'Card', detail: 'Visa •••• 4242', description: 'Door repair',
    },
    suggested_invoices: [
      invoiceRow(1, { id: 'inv-meant', number: 'INV-1301', meant: true, balance: 150, amount: 150, can_attach: true }),
    ],
    resolved_at: null,
    resolved_by_name: null,
    resolution: null,
    actions: ['attach_to_invoice', 'create_invoice', 'refund', 'mark_resolved'],
    ...over,
  };
}

export function invoiceRow(n: number, over: Partial<AttachableInvoice> = {}): AttachableInvoice {
  return {
    id: `inv-${n}`, number: `INV-${1300 + n}`, customer: 'Dana Reyes', due_date: '2026-10-20T19:00:00.000Z', job_type: 'Door repair',
    amount: 120, balance: 120, payable_now: over.balance ?? 120, meant: false, can_attach: true, status: 'SENT', same_amount: true, ...over,
  };
}

export const unappliedItem = (over: Partial<AttentionItem> = {}): AttentionItem =>
  makeItem(7, 'unmatched_payment', {
    key: PAYMENT_KEY, amount: 120, actions: ['attach_to_invoice', 'create_invoice', 'refund', 'mark_resolved'],
    customer: { id: 'cust-9', name: 'Dana Reyes', customer_number: 'C-1009' }, invoice: { id: 'inv-meant', number: 'INV-1301' }, ...over,
  });

export interface UnappliedServe extends Omit<AttentionServe, 'detail'> {
  unapplied?: UnappliedDetail;
  /** The Attach dialog's search rows; filtered by `q` on number or customer like the server does. */
  invoices?: AttachableInvoice[];
}

/** The card list plus the unapplied detail and the invoice search, over the Payments fixtures. */
export function serveUnapplied({ unapplied: detail = makeUnapplied(), invoices = [], ...rest }: UnappliedServe = {}) {
  serveAttention({ open: [unappliedItem({ key: detail.key })], ...rest });
  const base = mockApi.get.getMockImplementation()! as (u: string, c?: unknown) => unknown;
  mockApi.get.mockImplementation(((url: string, config?: { params?: { q?: string } }) => {
    if (url === `/api/payments-page/attention/${detail.key}`) return Promise.resolve({ data: detail });
    if (url === `/api/payments-needing-attention/${detail.id}/invoices`) {
      const q = (config?.params?.q ?? '').toLowerCase();
      const items = invoices.filter((i) => `${i.number} ${i.customer}`.toLowerCase().includes(q));
      return Promise.resolve({ data: { items } });
    }
    return base(url, config);
  }) as never);
}
