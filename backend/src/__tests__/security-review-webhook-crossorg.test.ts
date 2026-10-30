import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { withCheckoutLedger } from './helpers';

// SECURITY (review #6): the Stripe webhook must reject a checkout that names an invoice belonging
// to a DIFFERENT org than the one resolved for the event. resolveOrgFromEvent can resolve the owner
// via event.account (Connect) independently of metadata.invoiceId, so without an explicit
// org-ownership assertion a signed event from org A naming org B's invoiceId could mark org B's
// invoice paid. This is defense-in-depth alongside the amount fail-closed check.

const mockPrisma = prisma as unknown as {
  organization: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findUnique: ReturnType<typeof vi.fn> };
  stripeEvent: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const VICTIM_INVOICE_ID = '10000000-0000-0000-0000-000000000001';

function postWebhook(body: object) {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'test_sig')
    .send(Buffer.from(JSON.stringify(body)));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockResolvedValue({});
});

describe('POST /api/webhooks/stripe — cross-org invoice rejection (#6)', () => {
  it('does NOT mark another org\'s invoice paid when the event resolves to a different org (Connect account path)', async () => {
    // Owner resolved from event.account = attacker org (accepts CARD).
    mockPrisma.organization.findFirst.mockResolvedValue({
      id: 'org_attacker',
      stripe_account_id: 'acct_attacker',
      accepted_payment_methods: ['CARD'],
    });
    // The named invoice belongs to a DIFFERENT (victim) org.
    mockPrisma.invoice.findUnique.mockResolvedValue({
      id: VICTIM_INVOICE_ID,
      invoice_number: 'I00001',
      status: 'SENT',
      kind: 'STANDARD',
      amount_due: 1000,
      total_amount: 1000,
      organization_id: 'org_victim',
      customer: null,
      estimate: null,
      job: { customer: { email: 'v@example.com', first_name: 'V', last_name: 'Ictim' } },
    });

    const event = {
      id: 'evt_crossorg_1',
      type: 'checkout.session.completed',
      account: 'acct_attacker',
      data: {
        object: {
          id: 'cs_attacker',
          object: 'checkout.session',
          payment_intent: 'pi_attacker',
          amount_total: 103500,
          metadata: { invoiceId: VICTIM_INVOICE_ID },
        },
      },
    };

    // Slice 08: the event is recorded and the captured money written down in one transaction.
    const tx: Record<string, any> = {};
    mockPrisma.$transaction.mockImplementation(async (fn: (t: any) => unknown) => fn(withCheckoutLedger(tx)));

    const res = await postWebhook(event);

    // Stripe gets a 200 (event consumed, no retry storm) but NO money side effects run on the
    // victim's invoice: no payment, no invoice write, no lock taken on it.
    expect(res.status).toBe(200);
    expect(tx.payment.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    // No lock on any invoice (the only raw statement is the per-session lock, which names no invoice).
    const raw = tx.$executeRaw.mock.calls.map(([strings, ...values]: [TemplateStringsArray, ...unknown[]]) => ({ sql: strings.join('?'), values }));
    expect(raw.filter((r: { sql: string }) => /invoices/i.test(r.sql))).toEqual([]);
    expect(JSON.stringify(raw)).not.toContain(VICTIM_INVOICE_ID);
    // The money landed in the attacker org's account, so it is recorded there, on the org itself,
    // and the victim's invoice is never named.
    const rows = tx.timelineEvent.create.mock.calls.map((c: any[]) => c[0].data);
    expect(rows).toEqual([expect.objectContaining({
      organization_id: 'org_attacker', entity_type: 'ORGANIZATION', entity_id: 'org_attacker', event_type: 'PAYMENT_UNRECORDED',
    })]);
    expect(JSON.stringify(rows)).not.toContain(VICTIM_INVOICE_ID);
  });
});
