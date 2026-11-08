import { describe, it, expect } from 'vitest';
import { buildAlphaClassicInvoicePdf, isInvoiceSameAsBilling, fmtCurrency } from '../alpha-classic';
import { PREVIEW_INVOICE_FIXTURE } from '../../preview-fixture';
import { printer } from '../../fonts';

const FIXTURE_ORG = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Northwind Services LLC',
  legal_name: null,
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US',
  email: 'info@northwind.example.com',
  phone: null,
  website: 'https://northwind.example.com/',
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_template: 'alpha-classic',
  estimate_terms: 'Sample terms.',
  estimate_notes: '- Note A\n- Note B',
  estimate_payment_terms: '- 70% on acceptance',
  invoice_terms: 'By paying the due balance, the Client acknowledges services were performed.',
  invoice_notes: '- Any change in quantity or labor not qualified will be additionally charged.',
  invoice_payment_terms: '- 70% due upon acceptance\n- 30% upon completion',
};

describe('buildAlphaClassicInvoicePdf', () => {
  it('produces a valid docDefinition', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    expect(doc).toHaveProperty('content');
    expect(doc).toHaveProperty('defaultStyle');
    expect((doc.defaultStyle as any).font).toBe('Inter');
  });

  it('titles the document INVOICE, not ESTIMATE', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('INVOICE');
    expect(json).not.toContain('ESTIMATE');
  });

  it('renders the header block as Invoice # / Date / Balance / Due On', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Invoice #');
    expect(json).toContain('I00001');
    expect(json).toContain('Date');
    expect(json).toContain('Balance');
    expect(json).toContain('Due On');
    // Balance in the header is amount_due, not total_amount.
    expect(json).toContain(fmtCurrency(PREVIEW_INVOICE_FIXTURE.amount_due));
  });

  it('renders the customer name and service location', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Jane Doe');
    expect(json).toContain('123 Main Street');
  });

  it('includes line items with qty, price, amount', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Item 1');
    expect(json).toContain('$499.00');
  });

  it('includes Sub total, Tax, Total, Deposit credit, Payments, and bold Balance Due', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Sub total');
    expect(json).toContain(fmtCurrency(PREVIEW_INVOICE_FIXTURE.subtotal));
    expect(json).toContain('Total');
    expect(json).toContain(fmtCurrency(PREVIEW_INVOICE_FIXTURE.total_amount));
    expect(json).toContain('Deposit credit');
    expect(json).toContain(`−${fmtCurrency(PREVIEW_INVOICE_FIXTURE.deposit_credit)}`);
    expect(json).toContain('Payments');
    expect(json).toContain(`−${fmtCurrency(100.00)}`);
    expect(json).toContain('Balance Due');
    expect(json).toContain(fmtCurrency(PREVIEW_INVOICE_FIXTURE.amount_due));

    // Arithmetic must actually reconcile: total − deposit − payments == amount_due.
    const paid = PREVIEW_INVOICE_FIXTURE.payments.reduce((s, p) => s + p.amount, 0);
    expect(
      Math.round((PREVIEW_INVOICE_FIXTURE.total_amount - PREVIEW_INVOICE_FIXTURE.deposit_credit - paid) * 100) / 100,
    ).toBe(PREVIEW_INVOICE_FIXTURE.amount_due);
  });

  it('omits the Deposit credit and Payments rows when there are none', () => {
    const noPayments = { ...PREVIEW_INVOICE_FIXTURE, deposit_credit: 0, payments: [], amount_due: PREVIEW_INVOICE_FIXTURE.total_amount };
    const doc = buildAlphaClassicInvoicePdf(noPayments as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('Deposit credit');
    expect(json).not.toContain('Payments');
  });

  it('excludes voided payments from the Payments row', () => {
    const withVoided = {
      ...PREVIEW_INVOICE_FIXTURE,
      payments: [
        { amount: 100.00, voided_at: null },
        { amount: 50.00, voided_at: new Date('2026-05-01T00:00:00Z') },
      ],
    };
    const doc = buildAlphaClassicInvoicePdf(withVoided as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain(`−${fmtCurrency(100.00)}`);
    expect(json).not.toContain(`−${fmtCurrency(150.00)}`);
  });

  it('never renders a signature block', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).not.toContain('Customer Signature');
  });

  it('reads invoice_terms/invoice_notes/invoice_payment_terms, not the estimate copy', () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('acknowledges services were performed');
    expect(json).not.toContain('Sample terms.');
  });

  it('omits the Terms/Notes/Payment Terms sections entirely when the org copy is blank', () => {
    const blankOrg = { ...FIXTURE_ORG, invoice_terms: '', invoice_notes: '', invoice_payment_terms: '' };
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, blankOrg);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('Terms:');
    expect(json).not.toContain('Notes:');
    expect(json).not.toContain('PAYMENT TERMS:');
  });

  it('renders "Same as billing" when the invoice has no distinct service location', () => {
    const noServiceLocation = { ...PREVIEW_INVOICE_FIXTURE, service_location: null };
    const doc = buildAlphaClassicInvoicePdf(noServiceLocation as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Same as billing');
  });

  // #1997 round 3 (MEDIUM) — presentInvoiceDetail now strips a redacted customer's
  // `service_locations` (see customerContact.ts), so the template must tolerate the key being
  // entirely ABSENT rather than dereferencing it unconditionally. "Bill To" degrades to the
  // customer's name only — no address, no crash.
  it('renders Bill To with the name only, no crash, when customer.service_locations is absent (redacted requester)', () => {
    const { service_locations: _omit, ...customerWithoutLocations } = PREVIEW_INVOICE_FIXTURE.customer as { service_locations: unknown; [k: string]: unknown };
    // Isolate the Bill To assertion from the (deliberately untouched, out-of-scope) job service
    // location — see alpha-classic.ts's `resolveServiceLocation`/`Service Location` block, which
    // still renders `invoice.service_location` regardless of the customer redaction.
    const redacted = { ...PREVIEW_INVOICE_FIXTURE, customer: customerWithoutLocations, service_location: null };

    expect(() => buildAlphaClassicInvoicePdf(redacted as any, FIXTURE_ORG)).not.toThrow();
    const doc = buildAlphaClassicInvoicePdf(redacted as any, FIXTURE_ORG);
    const billToBlock = (doc.content as unknown[]).find(
      (c) => JSON.stringify(c).includes('Bill To:'),
    ) as { columns: { stack: unknown[] }[] };
    const billToStack = billToBlock.columns[0].stack;
    expect(JSON.stringify(billToStack)).toContain('Bill To:');
    expect(billToStack).toContain('Jane Doe');
    expect(JSON.stringify(billToStack)).not.toContain('123 Main Street');
  });

  it('isInvoiceSameAsBilling does not throw and reports false when customer.service_locations is absent', () => {
    const { service_locations: _omit, ...customerWithoutLocations } = PREVIEW_INVOICE_FIXTURE.customer as { service_locations: unknown; [k: string]: unknown };
    const redacted = { ...PREVIEW_INVOICE_FIXTURE, customer: customerWithoutLocations };

    expect(() => isInvoiceSameAsBilling(redacted as any)).not.toThrow();
    expect(isInvoiceSameAsBilling(redacted as any)).toBe(false);
  });

  it('renders through PdfPrinter without error', async () => {
    const doc = buildAlphaClassicInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const pdfDoc = await printer.createPdfKitDocument(doc);
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      pdfDoc.on('data', (c: Buffer) => chunks.push(c));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(1000);
  });
});
