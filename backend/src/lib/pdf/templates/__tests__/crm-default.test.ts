import { describe, it, expect } from 'vitest';
import { buildCrmDefaultPdf, buildCrmDefaultInvoicePdf } from '../crm-default';
import { fmtCurrency } from '../alpha-classic';
import { PREVIEW_ESTIMATE_FIXTURE, PREVIEW_INVOICE_FIXTURE } from '../../preview-fixture';
import { printer } from '../../fonts';
import { imageKeyForRow } from '../../document-images';
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
  estimate_template: 'crm-default',
  estimate_terms: 'Sample terms.',
  estimate_notes: '- Note A\n- Note B',
  estimate_payment_terms: '- 70% on acceptance',
};

/** Every `text` string in a docDefinition, in document order. */
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.text === 'string') out.push(o.text);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'text') continue;
      texts(v, out);
    }
    return out;
  }
  return out;
}

/** The `widths` of every table in a docDefinition, in document order. */
function tableWidths(node: unknown, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) {
    for (const child of node) tableWidths(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o.table?.widths) out.push(o.table.widths as unknown[]);
    for (const v of Object.values(o)) tableWidths(v, out);
    return out;
  }
  return out;
}

/** A priced scope block, so the scope row's own chip and placeholder are in the sample too. */
const FIXTURE_SCOPE = {
  id: 'scope-1',
  title: 'Duct Cleaning',
  body: 'Full duct system cleaning and sanitizing.',
  flat_price: 200,
  is_taxable: true,
};

describe('buildCrmDefaultPdf', () => {
  it('produces a valid docDefinition with Inter default font', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(doc).toHaveProperty('content');
    expect(doc).toHaveProperty('defaultStyle');
    expect((doc.defaultStyle as any).font).toBe('Inter');
  });

  it('falls back to org.name as header when logo_url is null', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Northwind Services LLC');
  });

  /**
   * REVERSED by Ran's 2026-09-13 review of the rendered PDFs. This used to assert the opposite —
   * that every estimate row carried a coloured Material / Service / Scope chip. Once the rows sit
   * under a section of their own, a per-row type marker restates the section, and the grey em-dash
   * that stood in for a missing price-book image reads as a MISSING value rather than an
   * inapplicable one. Both go, which is what Alpha Classic has always done.
   *
   * Matched on whole text nodes, never on `JSON.stringify(...).toContain('Scope')`, which the
   * words "Scope of Work" would satisfy on their own.
   */
  it('prints no per-row type chip and no em-dash placeholder on an estimate', () => {
    const printed = texts(
      buildCrmDefaultPdf({ ...PREVIEW_ESTIMATE_FIXTURE, scopes: [FIXTURE_SCOPE] } as any, FIXTURE_ORG).content,
    );

    expect(printed).not.toContain('Material');
    expect(printed).not.toContain('Service');
    expect(printed).not.toContain('Scope');
    expect(printed).not.toContain('—');
    // The rows themselves are untouched — it is the marker beside them that goes.
    expect(printed).toContain('Item 1');
    expect(printed).toContain('Duct Cleaning');
  });

  /**
   * The SCOPE BOUNDARY, pinned. The chip-and-placeholder code also serves the invoice builder in
   * the same file, which reads `invoice.subtotal` and its own `pricedScopes` loop rather than the
   * view-model. Re-pointing it is separate work, so an invoice deliberately still prints both and
   * an estimate and an invoice for the same job differ on this point. Change this test only with
   * that decision, never to make the two files match.
   */
  it('still prints the chip and the placeholder on an INVOICE, which does not read the view-model', () => {
    const printed = texts(buildCrmDefaultInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, FIXTURE_ORG).content);

    expect(printed).toContain('Material');
    expect(printed).toContain('Service');
    expect(printed).toContain('—');
  });

  /**
   * With the placeholder gone, a section whose rows have no price-book image has nothing to put
   * in the icon column, and a 64pt column of nothing is a gutter the description column should
   * have had. A scope section never has an image at all, so it never keeps the column.
   */
  it('drops the icon column from a section that has no image to draw in it', () => {
    const doc = buildCrmDefaultPdf({ ...PREVIEW_ESTIMATE_FIXTURE, scopes: [FIXTURE_SCOPE] } as any, FIXTURE_ORG);

    // Two sections, both narrowed: the fixture's line items carry no price-book image.
    expect(tableWidths(doc.content)).toEqual([['*', 80], ['*', 80]]);
  });

  /**
   * The case where the placeholder could still reach the page: one row in the section HAS an
   * image, so the column is kept, and the row that has none must leave its cell empty rather than
   * fill it with an em-dash. Without this the "no em-dash" claim above is unfalsifiable — drop
   * the column and the placeholder becomes unreachable whatever the code says.
   */
  it('leaves the icon cell empty, not em-dashed, for an imageless row in a section that keeps the column', () => {
    const mixed = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      line_items: [
        { ...PREVIEW_ESTIMATE_FIXTURE.line_items[0], id: 'li-1', price_book_item: { image_url: 'https://x.test/pb.jpg' } },
        { ...PREVIEW_ESTIMATE_FIXTURE.line_items[1], id: 'li-2', price_book_item: null },
      ],
    };
    const doc = buildCrmDefaultPdf(mixed as any, FIXTURE_ORG, {
      [imageKeyForRow('li-1')]: 'data:image/jpeg;base64,CCC',
    });

    expect(tableWidths(doc.content)).toEqual([[64, '*', 80]]);
    expect(texts(doc.content)).not.toContain('—');
  });

  it('keeps the icon column for a section that does have an image to draw', () => {
    const withImage = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      line_items: [{ ...PREVIEW_ESTIMATE_FIXTURE.line_items[0], id: 'li-1', price_book_item: { image_url: 'https://x.test/pb.jpg' } }],
    };
    const doc = buildCrmDefaultPdf(withImage as any, FIXTURE_ORG, {
      [imageKeyForRow('li-1')]: 'data:image/jpeg;base64,CCC',
    });

    expect(tableWidths(doc.content)).toEqual([[64, '*', 80]]);
  });

  it('shows a line-discount strikethrough on the third fixture item', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('"decoration":"lineThrough"');
    expect(json).toContain('$89.10');
  });

  it('includes "Scope of Work" card when scope_notes is present', () => {
    const withScope = { ...PREVIEW_ESTIMATE_FIXTURE, scope_notes: 'Install new maglock.' };
    const doc = buildCrmDefaultPdf(withScope as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Scope of Work');
  });

  it('omits signature block when signature_data is null', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).not.toContain('Customer Signature');
  });

  it('includes signature block when signature_data is present', () => {
    const signed = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      signature_at: new Date('2026-04-23T10:00:00Z'),
    };
    const doc = buildCrmDefaultPdf(signed as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Customer Signature');
  });

  it('prefers snapshot fields over live org fields when estimate is SENT+', () => {
    const snapped = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      status: 'WON' as const,
      snapshot_terms: 'SNAPSHOT TERMS',
      snapshot_notes: 'SNAPSHOT NOTES',
      snapshot_payment_terms: 'SNAPSHOT PAYMENT TERMS',
    };
    const doc = buildCrmDefaultPdf(snapped as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('SNAPSHOT TERMS');
    expect(json).not.toContain('Sample terms.');
  });

  it('renders through PdfPrinter without error', async () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
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

// §2.5b — a priced scope-of-work block was folded into subtotal/total_amount by calculateTotals()
// but never rendered as a line, so the printed line items summed to LESS than the printed
// "Subtotal". The scope must render as its own line so the reader can reconcile them.
describe('buildCrmDefaultPdf — priced scope-of-work blocks (§2.5b)', () => {
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
    const doc = buildCrmDefaultPdf(ESTIMATE_WITH_SCOPE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);
    expect(json).toContain('Duct Cleaning');
    expect(json).toContain(fmtCurrency(200));
  });

  it('line items + the scope line sum to the same subtotal calculateTotals returns', () => {
    const doc = buildCrmDefaultPdf(ESTIMATE_WITH_SCOPE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);

    // Sum what is actually PRINTED in the reconciling table: the NET amount of each
    // line (line_total is gross), plus the priced scope row. Summing raw
    // line_total across every item — the previous assertion — reconciled only because the
    // fixture stored net line_totals, a convention production does not use.
    const printedLineItemsSum = PREVIEW_ESTIMATE_FIXTURE.line_items
      .reduce((s, li) => s + (li.line_total - li.discount_amount), 0);
    const printedScopeSum = PRICED_SCOPE.flat_price;
    expect(Math.round((printedLineItemsSum + printedScopeSum) * 100) / 100).toBe(subtotal);

    // The document's own printed "Subtotal" must be that same reconciled figure.
    expect(json).toContain(fmtCurrency(subtotal));
  });

  // REVERSED by #2028 slice 4. This used to assert the opposite — that an unpriced scope was
  // omitted "because it carries no amount to reconcile". It carries no amount, but it does carry
  // a description the salesperson wrote for the customer, and dropping the whole block to avoid
  // printing a figure lost that. It now renders with a BLANK amount.
  it('renders an unpriced scope with its description and no amount', () => {
    const unpriced = { ...PRICED_SCOPE, id: 'scope-2', title: 'Site Walkthrough Notes', flat_price: null };
    const doc = buildCrmDefaultPdf({ ...PREVIEW_ESTIMATE_FIXTURE, scopes: [unpriced] } as any, FIXTURE_ORG);
    expect(JSON.stringify(doc)).toContain('Site Walkthrough Notes');
    // It contributes nothing, so no zero is printed against it.
    expect(JSON.stringify(doc)).not.toContain('$0.00');
  });

  it('renders through PdfPrinter without error with a priced scope row', async () => {
    const doc = buildCrmDefaultPdf(ESTIMATE_WITH_SCOPE as any, FIXTURE_ORG);
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

// ── Document arithmetic: everything printed must reconcile with the printed totals ──
// Each case below rendered a document that did not add up. They survived because the shared
// preview fixture stored NET line_totals (a convention calculateTotals never produces), which
// made the reconciliation assertion above tautological.
describe('buildCrmDefaultPdf — printed amounts reconcile with the printed totals', () => {
  it('prints a discounted line at its NET amount, with the gross struck through', () => {
    const doc = buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG);
    const json = JSON.stringify(doc);

    // Item 3: 1 × $99.00 with a 10% discount ⇒ gross 99.00, net 89.10.
    expect(json).toContain(fmtCurrency(89.10));
    const struck = JSON.parse(json) as unknown;
    // The gross figure may only appear as the struck-through element, never as the amount.
    expect(JSON.stringify(struck)).toContain('lineThrough');
  });

  it('prints a document-level discount row so Subtotal − Discount + Tax equals Total', () => {
    const discounted = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      discount_amount: 100,
      discount_name: 'Spring Promo',
      // Rounded to cents the same way calculateTotals rounds, so the assertion below compares
      // two figures the app could actually persist rather than a raw float artefact.
      total_amount: Math.round(
        (PREVIEW_ESTIMATE_FIXTURE.subtotal - 100 + PREVIEW_ESTIMATE_FIXTURE.tax_amount) * 100,
      ) / 100,
    };
    const json = JSON.stringify(buildCrmDefaultPdf(discounted as any, FIXTURE_ORG));

    expect(json).toContain('Spring Promo');
    expect(json).toContain(`−${fmtCurrency(100)}`);

    const reconciled = Math.round(
      (discounted.subtotal - discounted.discount_amount + discounted.tax_amount) * 100,
    ) / 100;
    expect(reconciled).toBe(discounted.total_amount);
    expect(json).toContain(fmtCurrency(discounted.total_amount));
  });

  it('omits the discount row entirely when there is no document-level discount', () => {
    const json = JSON.stringify(buildCrmDefaultPdf(PREVIEW_ESTIMATE_FIXTURE as any, FIXTURE_ORG));
    expect(json).not.toContain('Discount');
  });
});
