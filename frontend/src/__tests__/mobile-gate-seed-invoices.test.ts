/**
 * The invoices the gate seeds are SENT, as the legacy-modal cases need them.
 *
 * Since the invoice payment-link change (payments W4) a payment link no longer issues a DRAFT, so the
 * seed that used to rely on `POST /api/invoices/:id/payment-link` to mark the invoice sent left it a
 * DRAFT, and the Void Invoice and Issue Credit cases (which only exist on an issued invoice) found no
 * such menu entry on any device. The way to issue an invoice without emailing it is `mark-sent`.
 *
 * These tests run the gate's own seed code against a stand-in API that models the server's rules: a
 * payment link keeps the invoice's status, and only `mark-sent` issues a DRAFT.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoicedJob } from '../../e2e/mobile/seed';

type Invoice = { id: string; status: string; amount_due: number; public_token: string | null };

function statefulApi() {
  const invoice: Invoice = { id: 'inv-1', status: 'DRAFT', amount_due: 421.25, public_token: null };
  let statusWhenPaid: string | null = null;
  const ok = (body: unknown) => Promise.resolve({ res: { ok: () => true, status: () => 200 }, body });
  const api = {
    get suffix() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); },
    createCustomer: async (data: Record<string, unknown>) => ({ id: 'cust-1', ...data }),
    addLocation: async () => ({ id: 'loc-1' }),
    createLead: () => ok({ lead: { id: 'lead-1' } }),
    contactLead: () => ok({}),
    scheduleWalkthrough: () => ok({}),
    completeWalkthrough: () => ok({}),
    createEstimate: () => ok({ estimate: { id: 'est-1' } }),
    approveEstimatePublic: () => ok({}),
    testSignature: 'sig',
    createJob: () => ok({ job: { id: 'job-1' } }),
    assignJob: () => ok({}),
    startJob: () => ok({}),
    completeJob: () => ok({}),
    createInvoice: () => ok({ invoice }),
    recordPayment: () => { statusWhenPaid = invoice.status; return ok({}); },
    raw: (_method: string, url: string) => {
      if (url === '/api/organization') return ok({ timezone: 'America/Chicago' });
      if (url.startsWith('/api/invoices/') && url.endsWith('/mark-sent')) {
        invoice.status = 'SENT';
        invoice.public_token ??= 'tok-invoice';
        return ok({ invoice });
      }
      if (url.startsWith('/api/invoices/') && url.endsWith('/payment-link')) {
        invoice.public_token ??= 'tok-invoice';
        return ok({ invoice }); // W4: the link never changes the status
      }
      if (url.startsWith('/api/estimates/')) return ok({ estimate: { public_token: 'tok-estimate' } });
      return ok({});
    },
  } as unknown as Parameters<typeof invoicedJob>[0];
  return { api, invoice, paidWhile: () => statusWhenPaid };
}

describe('the invoices the gate seeds', () => {
  it('are issued (SENT), because a payment link no longer issues a draft', async () => {
    const { api, invoice } = statefulApi();
    await invoicedJob(api, 'tech-1', false);
    expect(invoice.status, 'the open invoice must be SENT for Void Invoice and Issue Credit to exist').toBe('SENT');
  });

  it('hand back the invoice link the public-page cases open', async () => {
    const { api } = statefulApi();
    const j = await invoicedJob(api, 'tech-1', false);
    expect(j.invoiceId).toBe('inv-1');
    expect(j.invoiceToken).toBe('tok-invoice');
  });

  it('are issued by the visual baseline seed the same way (it registers a Playwright setup on import, so its source is read)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'e2e', 'mobile', 'visual-setup.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).toMatch(/\/api\/invoices\/\$\{invoice\.id\}\/mark-sent/);
    expect(source, 'a payment link no longer issues the invoice').not.toMatch(/\/payment-link/);
  });

  it('take the cash payment on an issued invoice, not on a draft', async () => {
    const { api, paidWhile } = statefulApi();
    await invoicedJob(api, 'tech-1', true);
    expect(paidWhile()).toBe('SENT');
  });
});
