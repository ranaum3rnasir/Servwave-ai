import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf, fmtCurrency } from '../alpha-classic';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';
import { printer } from '../../fonts';
import { calculateTotals } from '../../../../controllers/estimate.controller';

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
};

describe('buildAlphaClassicPdf', () => {
  it('produces a valid docDefinition', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(doc).toHaveProperty('content');
    expect(doc).toHaveProperty('defaultStyle');
    expect((doc.defaultStyle as any).font).toBe('Inter');
  });

  it('renders the org name as fallback when logo_url is null', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Northwind Services LLC');
  });

  it('renders "Same as billing" when lead has no service address', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Same as billing');
  });

  it('renders the customer name and primary address', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Jane Doe');
    expect(json).toContain('123 Main Street');
  });

  it('includes line items with qty, price, amount', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Item 1');
    expect(json).toContain('$499.00');
    expect(json).toContain('Item 2');
  });

  it('includes subtotal, tax with rate, total', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Sub total');
    expect(json).toContain('$1,188.10');
    expect(json).toContain('6.625%');
    expect(json).toContain('$1,266.81');
  });

  it('omits signature block when signature_data is null', () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).not.toContain('Customer Signature');
  });

  it('includes signature block when signature_data is present', () => {
    const signed = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      signature_at: new Date('2026-04-23T10:00:00Z'),
    };
    const doc = buildAlphaClassicPdf(signed as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Customer Signature');
  });

  it('prefers snapshot fields over live org fields when present', () => {
    const snapped = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      status: 'WON' as const,
      snapshot_terms: 'SNAPSHOT TERMS',
      snapshot_notes: 'SNAPSHOT NOTES',
      snapshot_payment_terms: 'SNAPSHOT PAYMENT TERMS',
    };
    const doc = buildAlphaClassicPdf(snapped as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('SNAPSHOT TERMS');
    expect(json).not.toContain('Sample terms.');
    expect(json).toContain('SNAPSHOT NOTES');
    expect(json).toContain('SNAPSHOT PAYMENT TERMS');
  });

  it('renders through PdfPrinter without error', async () => {
    const doc = buildAlphaClassicPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
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

// #352 — storage is digits-only canonical; the customer-facing PDF must format
// the phone via formatPhoneDisplay in BOTH the Prepared For and Service Location
// blocks (alpha-classic is the DEFAULT template — estimate.controller falls back
// to it), with graceful passthrough for junk and empty for null.
describe('buildAlphaClassicPdf — customer phone formatting (#352)', () => {
  const withCustomerPhone = (phone: string | null, leadOverrides: Record<string, unknown> = {}) => ({
    ...PREVIEW_ESTIMATE_FIXTURE,
    lead: {
      ...PREVIEW_ESTIMATE_FIXTURE.lead,
      ...leadOverrides,
      customer: { ...PREVIEW_ESTIMATE_FIXTURE.lead.customer, phone },
    },
  });

  it('formats a digits-only stored phone as (xxx) xxx-xxxx in Prepared For AND Service Location', () => {
    // A distinct service address forces the non-"Same as billing" branch, which
    // renders the phone a second time in the Service Location block.
    const doc = buildAlphaClassicPdf(
      withCustomerPhone('5551234567', {
        service_address_line1: '999 Elsewhere Blvd',
        service_city: 'Newark',
        service_state: 'NJ',
        service_zip: '07102',
      }) as any,
      FIXTURE_ORG,
    );
    const json = JSON.stringify(doc);
    const occurrences = json.split('(555) 123-4567').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(json).not.toContain('5551234567');
  });

  it('passes a non-phone-shaped value through unchanged', () => {
    const doc = buildAlphaClassicPdf(withCustomerPhone('bg-import-phone:12345') as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('bg-import-phone:12345');
  });

  it('renders a null phone as empty without crashing', () => {
    const doc = buildAlphaClassicPdf(withCustomerPhone(null) as any, FIXTURE_ORG);
    expect(doc).toHaveProperty('content');
  });
});

// §2.5b — a priced scope-of-work block was folded into subtotal/total_amount by calculateTotals()
// but never rendered as a line, so the printed line items summed to LESS than the printed
// "Sub total". The scope must render as its own line so the reader can reconcile them.
describe('buildAlphaClassicPdf — priced scope-of-work blocks (§2.5b)', () => {
  const PRICED_SCOPE = {
    id: 'scope-1',
    title: 'Duct Cleaning',
    body: 'Full duct system cleaning and sanitizing.',
    flat_price: 200,
    is_taxable: true,
    internal_cost: null,
  };

  // Canonical totals computed the SAME way the write paths do — calculateTotals() folds the
  // scope's flat_price into subtotal/taxable base before tax. This is the number the fix must
  // make the printed rows reconcile with.
  const { subtotal, taxAmount, totalAmount } = calculateTotals(
    PREVIEW_ESTIMATE_FIXTURE.line_items.map((li) => ({
      quantity: li.quantity,
      unit_price: li.unit_price,
      is_taxable: li.is_taxable,
      discount_type: li.discount_type,
      discount_value: li.discount_value,
    })),
    PREVIEW_ESTIMATE_FIXTURE.tax_rate,
    undefined,
    [{ flat_price: PRICED_SCOPE.flat_price, is_taxable: PRICED_SCOPE.is_taxable }],
  );

  const ESTIMATE_WITH_SCOPE = {
    ...PREVIEW_ESTIMATE_FIXTURE,
    scopes: [PRICED_SCOPE],
    subtotal,
    tax_amount: taxAmount,
    total_amount: totalAmount,
  };

  it('renders the priced scope as its own line with title and price', () => {
    const doc = buildAlphaClassicPdf(ESTIMATE_WITH_SCOPE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Duct Cleaning');
    expect(json).toContain(fmtCurrency(200));
  });

  it('line items + the scope line sum to the same subtotal calculateTotals returns', () => {
    const doc = buildAlphaClassicPdf(ESTIMATE_WITH_SCOPE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);

    // Sum what is actually PRINTED in the reconciling table: the NET amount of each
    // line (line_total is gross), plus the priced scope row. Summing raw
    // line_total across every item — the previous assertion — reconciled only because the
    // fixture stored net line_totals, a convention production does not use.
    const printedLineItemsSum = PREVIEW_ESTIMATE_FIXTURE.line_items
      .reduce((s, li) => s + (li.line_total - li.discount_amount), 0);
    const printedScopeSum = PRICED_SCOPE.flat_price;
    expect(Math.round((printedLineItemsSum + printedScopeSum) * 100) / 100).toBe(subtotal);

    // The document's own printed "Sub total" must be that same reconciled figure.
    expect(json).toContain(fmtCurrency(subtotal));
  });

  // REVERSED by #2028 slice 4. This used to assert the opposite — that an unpriced scope was
  // omitted "because it carries no amount to reconcile". It carries no amount, but it does carry
  // a description the salesperson wrote for the customer, and dropping the whole block to avoid
  // printing a figure lost that. It now renders with a BLANK amount.
  it('renders an unpriced scope with its description and no amount', () => {
    const unpriced = { ...PRICED_SCOPE, id: 'scope-2', title: 'Site Walkthrough Notes', flat_price: null };
    const doc = buildAlphaClassicPdf({ ...PREVIEW_ESTIMATE_FIXTURE, scopes: [unpriced] } as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Site Walkthrough Notes');
    // It contributes nothing, so no zero is printed against it.
    expect(JSON.stringify(doc)).not.toContain('$0.00');
  });

  it('renders through PdfPrinter without error with a priced scope row', async () => {
    const doc = buildAlphaClassicPdf(ESTIMATE_WITH_SCOPE as any, FIXTURE_ORG);
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

// #2028 slice 5 — `scope_notes` is declared in EstimateForPdf and (since slice 1) selected on
// every path, but Alpha Classic never drew it. crm-default has rendered it since it shipped, and
// Northwind Services is on Alpha Classic, so this was a live omission on the documents actually being
// sent: the salesperson types the scope of work and the customer's PDF does not carry it.
describe('buildAlphaClassicPdf — scope notes', () => {
  it('renders the scope notes the salesperson typed', () => {
    const doc = buildAlphaClassicPdf(
      { ...PREVIEW_ESTIMATE_FIXTURE, scope_notes: 'Work is performed during business hours.' } as any,
      FIXTURE_ORG,
    );

    const json = JSON.stringify(doc);
    expect(json).toContain('Scope of Work');
    expect(json).toContain('Work is performed during business hours.');
  });

  it('renders no empty notes block when there are none', () => {
    const doc = buildAlphaClassicPdf({ ...PREVIEW_ESTIMATE_FIXTURE, scope_notes: null } as any, FIXTURE_ORG);

    expect(JSON.stringify(doc)).not.toContain('Scope of Work');
  });

  it('renders through PdfPrinter without error with scope notes present', async () => {
    const doc = buildAlphaClassicPdf(
      { ...PREVIEW_ESTIMATE_FIXTURE, scope_notes: 'Multi-line\nscope of work.' } as any,
      FIXTURE_ORG,
    );
    const pdfDoc = await printer.createPdfKitDocument(doc);
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      pdfDoc.on('data', (c: Buffer) => chunks.push(c));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
