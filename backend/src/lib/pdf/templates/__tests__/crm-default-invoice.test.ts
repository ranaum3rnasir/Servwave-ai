import { describe, it, expect } from 'vitest';
import { buildCrmDefaultInvoicePdf } from '../crm-default';
import { fmtCurrency } from '../alpha-classic';
import { PREVIEW_INVOICE_FIXTURE } from '../../preview-fixture';
import { printer } from '../../fonts';

const FIXTURE_ORG = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Alpha Doors & Security INC.',
  legal_name: null,
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030', country: 'US',
  email: 'info@alphasecurityus.com',
  phone: null,
  website: 'https://alphadoorsnewjersey.com/',
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_template: 'crm-default',
  estimate_terms: 'Sample terms.',
  estimate_notes: '- Note A\n- Note B',
  estimate_payment_terms: '- 70% on acceptance',
  invoice_terms: 'By paying the due balance, the Client acknowledges services were performed.',
  invoice_notes: '- Any change in quantity or labor not qualified will be additionally charged.',
  invoice_payment_terms: '- 70% due upon acceptance\n- 30% upon completion',
};

describe('buildCrmDefaultInvoicePdf', () => {
  it('produces a valid docDefinition with Inter default font', () => {
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    expect(doc).toHaveProperty('content');
    expect((doc.defaultStyle as any).font).toBe('Inter');
  });

  it('titles the document Invoice <number>, not Estimate', () => {
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Invoice I00001');
    expect(json).not.toContain('Estimate I00001');
  });

  it('renders a MATERIAL tag for material items and SERVICE tag for service items', () => {
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Material');
    expect(json).toContain('Service');
  });

  it('includes Subtotal, Tax, Total, Deposit credit, Payments, and bold Balance Due', () => {
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Deposit credit');
    expect(json).toContain(`−${fmtCurrency(PREVIEW_INVOICE_FIXTURE.deposit_credit)}`);
    expect(json).toContain('Payments');
    expect(json).toContain('Balance Due');
    expect(json).toContain(fmtCurrency(PREVIEW_INVOICE_FIXTURE.amount_due));
  });

  it('never renders a signature block', () => {
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).not.toContain('Customer Signature');
  });

  it('reads invoice_terms/invoice_notes/invoice_payment_terms, not the estimate copy', () => {
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('acknowledges services were performed');
    expect(json).not.toContain('Sample terms.');
  });

  it('omits Terms/Notes/Payment Terms sections when the org copy is blank', () => {
    const blankOrg = { ...FIXTURE_ORG, invoice_terms: '', invoice_notes: '', invoice_payment_terms: '' };
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, blankOrg);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('Terms:');
    expect(json).not.toContain('Notes:');
    expect(json).not.toContain('Payment Terms:');
  });

  it('renders through PdfPrinter without error', async () => {
    const doc = buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG);
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
