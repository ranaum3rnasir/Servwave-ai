import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { markdownToPdfMake, hasRenderableContent } from '../markdown';
import { formatPhoneDisplay } from '../../phone-format';
import { type ScopeOfWork } from '../../scopes';
import { imageKeyForPhoto, imageKeyForRow, type DocumentImages } from '../document-images';
import {
  buildEstimateDocumentView,
  documentSections,
  hasDocDiscount,
  hasOptionalExtras,
  isOptionalExtra,
  lineNetTotal,
  optionalMarkerFor,
  optionalSummaryFor,
  OPTIONAL_TOTALS_NOTE,
  pickContent,
  type DocumentRow,
  type DocumentSection,
} from '../../estimate-document-view';
import { asScopeArray } from '../../scopes';

interface EstimateForPdf {
  estimate_number: string;
  created_at: Date;
  status: string;
  // NOTE: `subtotal` is the PRE-estimate-discount figure. calculateTotals computes
  // total = (subtotal - discount_amount) + tax_amount, so a template that prints only
  // Subtotal/Tax/Total shows a document that does not add up whenever a document-level
  // discount exists. Both templates print an explicit Discount row for that reason.
  subtotal: number;
  discount_amount: number;
  discount_name: string | null;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  signature_data: string | null;
  signature_at: Date | null;
  snapshot_terms: string | null;
  snapshot_notes: string | null;
  snapshot_payment_terms: string | null;
  // R6 (2026-07-22) — M5: direct anchor mirroring estimateDetailSelect's top-level
  // `customer`/`service_location` (denormalized from the lead at write time). Required keys
  // (nullable value) rather than optional so a caller that forgets to populate them gets a tsc
  // error, not a silent `undefined`. Preferred over `lead.customer`/`lead.service_address_*`
  // below (see resolveServiceLocation and each build function's `estimate.customer ?? …`) so the
  // template never throws when `lead` is null but the estimate's own customer_id (always
  // populated) is present.
  customer: {
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email: string | null;
    phone: string;
  } | null;
  service_location: {
    address_line1: string;
    address_line2: string | null;
    city: string; state: string; zip: string;
  } | null;
  lead: {
    service_address_line1: string | null;
    service_address_line2: string | null;
    service_city: string | null;
    service_state: string | null;
    service_zip: string | null;
    customer: {
      first_name: string | null;
      last_name: string | null;
      company_name: string | null;
      email: string | null;
      phone: string;
      service_locations: Array<{
        is_primary: boolean;
        address_line1: string;
        address_line2: string | null;
        city: string; state: string; zip: string;
      }>;
    };
  } | null;
  scope_notes?: string | null;
  // §2.5b — flat-priced, non-line-item scope-of-work blocks. calculateTotals() (estimate.
  // controller.ts) folds each priced scope's flat_price into subtotal/total_amount, so the
  // template must render one too or the printed line items sum to less than the printed
  // Sub total. `internal_cost` is deliberately excluded from this type — the PDF never renders
  // staff-only margin data (mirrors stripScopeCost's Omit shape).
  scopes?: Omit<ScopeOfWork, 'internal_cost'>[] | null;
  line_items: Array<{
    description: string;
    item_type: string;
    quantity: number;
    unit_price: number;
    // GROSS (quantity × unit_price). calculateTotals stores it pre-discount and adds
    // `line_total - discount_amount` to the subtotal, so a template must subtract
    // discount_amount itself before printing an amount that reconciles.
    line_total: number;
    discount_amount: number;
    price_book_item?: { image_url?: string | null } | null;
  }>;
}

// #2028 — `lineNetTotal`, `hasDocDiscount` and `pickContent` are CONTENT decisions, so they now
// live in the view-model beside every other one. Re-exported here because the invoice builders
// below and several suites import them from this module.
export { lineNetTotal, hasDocDiscount, pickContent } from '../../estimate-document-view';

interface OrgForPdf {
  name: string;
  address_line1: string;
  address_line2: string | null;
  city: string; state: string; postal_code: string;
  email: string;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  brand_color: string;
  estimate_terms: string;
  estimate_notes: string;
  estimate_payment_terms: string;
  // Optional (not required) so existing estimate-only callers/fixtures are unaffected —
  // only buildAlphaClassicInvoicePdf/buildCrmDefaultInvoicePdf read these.
  invoice_terms?: string;
  invoice_notes?: string;
  invoice_payment_terms?: string;
}

interface InvoiceForPdf {
  invoice_number: string;
  created_at: Date;
  due_date: Date | null;
  status: string;
  // Same GROSS/pre-discount convention as EstimateForPdf.subtotal above.
  subtotal: number;
  discount_amount: number;
  discount_name: string | null;
  tax_rate: number;
  tax_amount: number;
  // Entity-redesign §6 — draw-down against a paid kind=DEPOSIT invoice; a post-tax
  // Payment-shaped subtraction, never a discount line (see invoice.controller.ts).
  deposit_credit: number;
  total_amount: number;
  // The server-computed source of truth for what's left to collect. Printed directly
  // as "Balance Due" rather than re-derived from payments, so it never disagrees with
  // what recordPayment/refund/void actually persisted.
  amount_due: number;
  // Invoice.customer_id is required (entity-redesign §6) — no lead fallback needed, unlike
  // EstimateForPdf.customer above.
  customer: {
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email: string | null;
    // Nullable (unlike EstimateForPdf.customer.phone above) — formatPhoneDisplay already
    // tolerates null/undefined, and Customer.phone is a nullable column.
    phone: string | null;
    // #1997 round 3 — optional: `presentInvoiceDetail` deletes this key entirely for a requester
    // who cannot read the customer row (the same redaction the estimate side already applies).
    service_locations?: Array<{
      is_primary: boolean;
      address_line1: string;
      address_line2: string | null;
      city: string; state: string; zip: string;
    }>;
  };
  // From the job (job-anchored invoice); null for job-less deposit/standalone invoices.
  service_location: {
    address_line1: string;
    address_line2: string | null;
    city: string; state: string; zip: string;
  } | null;
  scopes?: Omit<ScopeOfWork, 'internal_cost'>[] | null;
  line_items: Array<{
    description: string;
    item_type: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    discount_amount: number;
    price_book_item?: { image_url: string | null } | null;
  }>;
  payments: Array<{ amount: number; voided_at: Date | null }>;
}

export function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtTaxRate(r: number): string {
  return `(${(r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%)`;
}

/**
 * Resolve the service location to print, preferring the direct `service_location` anchor over
 * the legacy `lead.service_address_*` fields — mirrors `resolveCustomer` below. Field names
 * differ between the two sources (`address_line1`/`city`/… vs `service_address_line1`/
 * `service_city`/…), so this is a real reshape, not just a fallback swap.
 */
function resolveServiceLocation(estimate: EstimateForPdf): {
  address_line1: string;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} | null {
  if (estimate.service_location) return estimate.service_location;
  const l = estimate.lead;
  if (l?.service_address_line1) {
    return {
      address_line1: l.service_address_line1,
      address_line2: l.service_address_line2,
      city: l.service_city,
      state: l.service_state,
      zip: l.service_zip,
    };
  }
  return null;
}

/** Shared by isSameAsBilling/isInvoiceSameAsBilling below — the four-field address equality
 * check both use once they've each resolved their own (differently-shaped) location + primary. */
function addressesMatch(
  a: { address_line1: string | null; city: string | null; state: string | null; zip: string | null },
  b: { address_line1: string | null; city: string | null; state: string | null; zip: string | null },
): boolean {
  return (
    a.address_line1 === b.address_line1 &&
    a.city === b.city &&
    a.state === b.state &&
    a.zip === b.zip
  );
}

export function isSameAsBilling(estimate: EstimateForPdf): boolean {
  const loc = resolveServiceLocation(estimate);
  // no distinct service location recorded — render as "same as billing"
  if (!loc) return true;
  // "primary" (the customer's own address) is only derivable via the legacy
  // lead→customer→service_locations nesting — the direct top-level `customer` select carries no
  // service_locations list to compare against, so a populated location with no lead to check
  // against renders as a distinct address rather than risk a false "Same as billing".
  const primary = estimate.lead?.customer?.service_locations?.find(s => s.is_primary);
  if (!primary) return false;
  return addressesMatch(loc, primary);
}

/**
 * The photo strip beneath a scope block: up to four across, wrapping beyond that, each sized with
 * a `fit` box so none is distorted. Only photos actually PRESENT in the dictionary are drawn —
 * pdfmake throws on a reference it cannot resolve, and a photo whose fetch failed has no entry.
 */
function photoStrip(row: DocumentRow, images: DocumentImages): any[] {
  const drawable = row.photos.filter((p) => images[imageKeyForPhoto(p.id)]);
  if (drawable.length === 0) return [];
  const columns = 4;
  const rows: any[] = [];
  for (let i = 0; i < drawable.length; i += columns) {
    const slice = drawable.slice(i, i + columns);
    rows.push({
      columns: [
        ...slice.map((p) => ({ image: imageKeyForPhoto(p.id), fit: [90, 90] as [number, number] })),
        // Pad the last row so a lone photo is not stretched across the full width.
        ...Array.from({ length: columns - slice.length }, () => ({ text: '' })),
      ],
      columnGap: 6,
      margin: [0, 4, 0, 0] as any,
    });
  }
  return rows;
}

/**
 * #2053, Ran's call — the marker on an optional add-on the customer has not selected. It is drawn
 * in this template's own label voice: bold, at the detail line's size, directly beneath the
 * description whose Amount it qualifies. A row that IS in the price gets nothing at all, so every
 * document written before optional items existed is unchanged to the byte.
 */
function optionalMarker(row: DocumentRow): any[] {
  const marker = optionalMarkerFor(row);
  if (!marker) return [];
  return [{ text: marker, bold: true, fontSize: 9, margin: [0, 2, 0, 0] as any }];
}

/** One line-item row, in this template's four columns. Layout only — the figures are decided. */
function lineItemRow(row: DocumentRow, images: DocumentImages): any[] {
  const pbKey = imageKeyForRow(row.key);
  return [
    {
      stack: [
        // The price-book item's own image, when the stock item has one. Where it does not, the
        // space is simply empty — no placeholder, no broken image.
        ...(images[pbKey] ? [{ image: pbKey, fit: [40, 40] as [number, number], margin: [0, 0, 0, 3] as any }] : []),
        { text: row.title, bold: true },
        ...(row.detail ? [{ text: row.detail, fontSize: 9, color: '#666' }] : []),
        ...optionalMarker(row),
      ],
    },
    { text: String(row.quantity), alignment: 'center' },
    { text: fmtCurrency(row.unitPrice ?? 0), alignment: 'right' },
    // Print the NET amount — what this line costs after its own discount. That figure is in the Sub
    // total for every row except an optional add-on the customer has not taken, which prints it too
    // (#2053, Ran) and says so with the marker above.
    row.discounted
      ? {
          stack: [
            { text: fmtCurrency(row.grossAmount ?? 0), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
            { text: fmtCurrency(row.netAmount ?? 0) },
          ],
          alignment: 'right' as const,
        }
      // BLANK, not a zero, when the row carries no amount at all — the rule `scopeRow` below
      // already applies to an unpriced block. A "$0.00" would tell the customer it is free.
      : { text: row.netAmount != null ? fmtCurrency(row.netAmount) : '', alignment: 'right' },
  ];
}

/**
 * One scope-of-work row, in the scope section's two columns. #2028 slice 3 — a scope has neither
 * a quantity nor a unit price, and now that it sits in its OWN section it no longer has to fill
 * the line-item table's columns with em-dashes to say so. The per-row "SCOPE OF WORK" eyebrow
 * went with them: the section heading says it once, above the whole list.
 *
 * An unpriced block's Amount is BLANK, not a zero — a zero would tell the customer the work is
 * free, where a blank says it is not separately priced.
 */
function scopeRow(row: DocumentRow, images: DocumentImages): any[] {
  return [
    {
      stack: [
        { text: row.title, bold: true },
        ...(row.detail ? [{ text: row.detail, fontSize: 9, color: '#666' }] : []),
        ...optionalMarker(row),
        ...photoStrip(row, images),
      ],
    },
    { text: row.netAmount != null ? fmtCurrency(row.netAmount) : '', alignment: 'right' },
  ];
}

/** This template's table border treatment, shared by both section tables. */
const SECTION_TABLE_LAYOUT = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0,
  hLineColor: () => '#e5e5e5',
};

/** A header cell in this template's grey column strip. */
function headerCell(text: string, alignment?: 'center' | 'right') {
  return { text, bold: true, fillColor: '#f5f5f5', ...(alignment ? { alignment } : {}) };
}

/**
 * The document's sections, drawn in this template's own voice: a bold "Thing:" label, exactly as
 * Prepared For / Terms / Notes are labelled, then the section's own table.
 *
 * #2028 slice 3 — a section is emitted only when the view-model returns it, so an estimate with
 * no line items no longer prints a Description / QTY / Price / Amount strip over an empty table,
 * and an estimate with both prints two labelled tables instead of one run-together list. A
 * document with only ONE section is drawn with no label at all (Ran, 2026-09-13): the view-model
 * nulls the title and this draws nothing for it.
 */
function sectionBlocks(sections: DocumentSection[], images: DocumentImages): any[] {
  return sections.flatMap((section, i) => {
    // A lone section carries no title (the view-model's call) and gets no heading block at all —
    // not an empty one, which would still take its 4pt of space above the table.
    const heading = section.title
      ? [{ text: `${section.title}:`, bold: true, margin: [0, i === 0 ? 0 : 16, 0, 4] as any }]
      : [];
    const notes = section.notes
      ? [{ text: section.notes, style: 'paragraph', margin: [0, 0, 0, section.rows.length > 0 ? 8 : 0] as any }]
      : [];
    if (section.rows.length === 0) return [...heading, ...notes];

    const table = section.kind === 'scope'
      ? {
          table: {
            headerRows: 1,
            widths: ['*', 70] as any,
            body: [
              [headerCell('Description'), headerCell('Amount', 'right')],
              ...section.rows.map((row) => scopeRow(row, images)),
            ],
          },
          layout: SECTION_TABLE_LAYOUT,
        }
      : {
          table: {
            headerRows: 1,
            widths: ['*', 40, 70, 70] as any,
            body: [
              [headerCell('Description'), headerCell('QTY', 'center'), headerCell('Price', 'right'), headerCell('Amount', 'right')],
              ...section.rows.map((row) => lineItemRow(row, images)),
            ],
          },
          layout: SECTION_TABLE_LAYOUT,
        };

    return [...heading, ...notes, table];
  });
}

export function buildAlphaClassicPdf(
  estimate: EstimateForPdf,
  org: OrgForPdf,
  images: DocumentImages = {},
): TDocumentDefinitions {
  // customer_id is required on every estimate going forward — the direct anchor is the common
  // case; `lead?.customer` is the fallback for rows still reached only through their lead.
  const c = estimate.customer ?? estimate.lead?.customer;
  if (!c) throw new Error('Estimate has no customer');
  // "primary" (the customer's own address, shown in Prepared For) is only derivable via the
  // legacy lead→customer→service_locations nesting — the direct top-level `customer` select
  // carries no service_locations list. Undefined when there's no lead; the Prepared For block
  // below tolerates that (renders name/phone/email without an address line).
  const primary = estimate.lead?.customer?.service_locations?.find(s => s.is_primary);
  // #2028 — every content decision (which rows exist, how each is presented, how discounts are
  // summarised, what the totals rows are, which copy to print) comes from the view-model. What is
  // left here is layout: this template's table shape, columns and typography.
  const view = buildEstimateDocumentView(estimate, org);
  const { terms, notes, paymentTerms } = view;

  const logoBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number] }
    : { text: org.name, fontSize: 24, bold: true, color: org.brand_color };

  const sameAsBilling = isSameAsBilling(estimate);
  const loc = resolveServiceLocation(estimate);
  const customerName = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const preparedFor = [
    { text: 'Prepared For:', bold: true, margin: [0, 0, 0, 4] as any },
    customerName,
    primary ? [primary.address_line1, primary.city + ', ' + primary.state + ' ' + primary.zip].join('\n') : '',
    // #352 — storage is digits-only canonical; format for the customer-facing PDF.
    formatPhoneDisplay(c.phone),
    c.email || '',
  ];
  const serviceLocation = [
    { text: 'Service Location:', bold: true, margin: [0, 0, 0, 4] as any },
    sameAsBilling
      ? 'Same as billing'
      : [
          customerName,
          `${loc?.address_line1}\n${loc?.city}, ${loc?.state} ${loc?.zip}`,
          formatPhoneDisplay(c.phone),
          c.email || '',
        ].join('\n'),
  ];

  // #2028 slice 3 — which sections this document has is the view-model's call, so the previewed
  // PDF, the emailed PDF and the public page make the same three decisions. The scope-of-work
  // narrative the salesperson typed leads the scope section: this template never drew it at all
  // (slice 5), so Northwind Services were sending customers documents with the scope of work missing.
  //
  // Every priced row still prints in the Amount column of its own section's table, so the Sub
  // total below remains the literal sum of everything printed above it. Slice 4: an UNPRICED
  // block is printed too, with a blank amount, and contributes nothing to the totals.
  const sections = sectionBlocks(documentSections(view), images);

  const totalsTable = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: [75, 75] as any,
          // Which rows exist, in what order, and which are subtractions is the view-model's
          // call (`view.totals`); this template supplies only their wording and weight.
          // NOTE: it does not print a Line Discounts row — each discounted line already shows
          // its gross struck through above, so a summary row would double-count visually.
          body: view.totals
            .filter((t) => t.kind !== 'line_discounts')
            .map((t) => {
              const label = t.kind === 'subtotal' ? 'Sub total'
                : t.kind === 'tax' ? `Tax ${fmtTaxRate(view.taxRate)}`
                : t.label;
              const amount = t.negative ? `−${fmtCurrency(t.amount)}` : fmtCurrency(t.amount);
              const emphasis = t.kind === 'total' ? { bold: true, fontSize: 12 } : {};
              return [
                { text: label, alignment: 'right', ...emphasis },
                { text: amount, alignment: 'right', ...emphasis },
              ];
            }),
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 10, 0, 20] as any,
  };

  // #2089 — "N of M optional add-ons included", a plain count beside the totals it summarises,
  // never a row inside them (same reasoning as the note below). No currency figure, so a price
  // change never requires this line to change — only a selection does. Absent entirely when the
  // document offers nothing optional.
  const optionalSummary = optionalSummaryFor(view);
  const optionalSummaryBlock = optionalSummary
    ? [{ text: optionalSummary, fontSize: 9, alignment: 'right' as const, color: '#666666', margin: [0, -12, 0, 2] as any }]
    : [];

  // #2053, Ran's call — the companion to the row markers. Without it the amounts beside them are
  // the only evidence, and a reader who scans straight to the bottom of the document has no way
  // to tell that the Total does not contain them. Printed only when the document actually offers
  // something optional, directly under the totals it qualifies, in this template's label voice.
  const optionalNote = hasOptionalExtras(view)
    ? [{ text: OPTIONAL_TOTALS_NOTE, bold: true, fontSize: 9, alignment: 'right' as const, margin: [0, optionalSummary ? 0 : -12, 0, 12] as any }]
    : [];

  const signatureBlock = view.signature
    ? [
        { text: 'Customer Signature:', bold: true, margin: [0, 20, 0, 8] as any },
        { image: view.signature.data, width: 150, height: 60 },
        { text: `Approved on ${view.signature.at ? fmtDate(view.signature.at) : ''}`, fontSize: 9, color: '#666' },
      ]
    : [];

  return {
    // #2029 — the document's images, by NAME. pdfmake stores each entry once however many times
    // the content references it, which an inline data URI per reference does not.
    images,
    content: [
      {
        columns: [
          { width: 200, ...logoBlock },
          { text: 'ESTIMATE', fontSize: 32, bold: true, color: '#666', alignment: 'right' },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        columns: [
          {
            stack: [
              org.name,
              `${org.address_line1}, ${org.city}, ${org.state}, ${org.postal_code}`,
              org.email,
              org.website || '',
            ],
          },
          {
            columns: [
              { width: '*', text: '' },
              {
                width: 'auto',
                table: {
                  widths: ['auto', 100] as any,
                  body: [
                    [{ text: 'Estimate #', bold: true, alignment: 'right' }, { text: estimate.estimate_number, alignment: 'right' }],
                    [{ text: 'Date',       bold: true, alignment: 'right' }, { text: fmtDate(estimate.created_at), alignment: 'right' }],
                    [{ text: 'Total',      bold: true, alignment: 'right' }, { text: fmtCurrency(estimate.total_amount), alignment: 'right' }],
                  ],
                },
                layout: 'noBorders',
              },
            ],
          },
        ],
        margin: [0, 0, 0, 30] as any,
      },
      {
        columns: [
          { stack: preparedFor },
          { stack: serviceLocation },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      ...sections,
      totalsTable as any,
      // The note is a SIBLING of the totals table, never a row inside it: the totals block is the
      // document's arithmetic and nothing this feature does may touch it. The negative top margin
      // borrows from the table's own 20pt tail so the note sits under the Total rather than
      // drifting down onto the Terms heading.
      ...optionalSummaryBlock,
      ...optionalNote,
      // A heading is printed only when there is body text under it. An org that has not written
      // its terms yet holds '' (and the send path snapshots that ''), so an unconditional heading
      // put a bare "Terms:" on that tenant's first sent estimate.
      ...(hasRenderableContent(terms)
        ? [{ text: 'Terms:', bold: true, margin: [0, 10, 0, 4] as any }, { text: terms, style: 'paragraph' }]
        : []),
      ...(hasRenderableContent(notes)
        ? [{ text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(notes)]
        : []),
      ...(hasRenderableContent(paymentTerms)
        ? [{ text: 'PAYMENT TERMS:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(paymentTerms)]
        : []),
      ...signatureBlock,
      { text: 'Thank You For Your Business', fontSize: 18, bold: true, alignment: 'center', margin: [0, 30, 0, 0] as any },
    ],
    defaultStyle: { font: 'Inter', fontSize: 10 },
    styles: {
      paragraph: { fontSize: 10, lineHeight: 1.3 },
    },
    pageMargins: [40, 40, 40, 40],
    pageSize: 'LETTER',
  };
}

/** True when the invoice carries no distinct job service location, or that location matches
 * the customer's own primary address — mirrors isSameAsBilling's estimate-side logic. */
export function isInvoiceSameAsBilling(invoice: InvoiceForPdf): boolean {
  const loc = invoice.service_location;
  if (!loc) return true;
  // #1997 round 3 — a redacted requester's `presentInvoiceDetail` deletes
  // `customer.service_locations` entirely (same as the estimate side); a populated service
  // location with no primary address to compare against renders as a distinct address rather
  // than risk a false "Same as billing" (mirrors isSameAsBilling's identical estimate-side note).
  const primary = invoice.customer.service_locations?.find((s) => s.is_primary);
  if (!primary) return false;
  return addressesMatch(loc, primary);
}

/** Sum of non-voided payments — the "Payments" row must not count money that was voided. */
export function activePaymentsTotal(payments: InvoiceForPdf['payments']): number {
  return Math.round(payments.filter((p) => !p.voided_at).reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;
}

export function buildAlphaClassicInvoicePdf(
  invoice: InvoiceForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  const c = invoice.customer;
  // Invoices have no snapshot_* columns (unlike estimates) — always the org's CURRENT copy.
  const terms = org.invoice_terms ?? '';
  const notes = org.invoice_notes ?? '';
  const paymentTerms = org.invoice_payment_terms ?? '';

  const logoBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number] }
    : { text: org.name, fontSize: 24, bold: true, color: org.brand_color };

  const sameAsBilling = isInvoiceSameAsBilling(invoice);
  const loc = invoice.service_location;
  // #1997 round 3 — absent (not merely empty) for a redacted requester; the Bill To block below
  // then prints the customer's name only, exactly like the estimate template's "Prepared For".
  const primary = c.service_locations?.find((s) => s.is_primary);
  const customerName = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const billTo = [
    { text: 'Bill To:', bold: true, margin: [0, 0, 0, 4] as any },
    customerName,
    primary ? [primary.address_line1, `${primary.city}, ${primary.state} ${primary.zip}`].join('\n') : '',
    formatPhoneDisplay(c.phone),
    c.email || '',
  ];
  const serviceLocation = [
    { text: 'Service Location:', bold: true, margin: [0, 0, 0, 4] as any },
    sameAsBilling
      ? 'Same as billing'
      : [
          customerName,
          `${loc?.address_line1}\n${loc?.city}, ${loc?.state} ${loc?.zip}`,
          formatPhoneDisplay(c.phone),
          c.email || '',
        ].join('\n'),
  ];

  const tableBody: any[] = [
    [
      { text: 'Description', bold: true, fillColor: '#f5f5f5' },
      { text: 'QTY',         bold: true, fillColor: '#f5f5f5', alignment: 'center' },
      { text: 'Price',       bold: true, fillColor: '#f5f5f5', alignment: 'right' },
      { text: 'Amount',      bold: true, fillColor: '#f5f5f5', alignment: 'right' },
    ],
  ];
  for (const li of invoice.line_items) {
    const parts = li.description.split('\n');
    const net = lineNetTotal(li);
    tableBody.push([
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length > 0
            ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#666' }]
            : []),
        ],
      },
      { text: String(li.quantity), alignment: 'center' },
      { text: fmtCurrency(li.unit_price), alignment: 'right' },
      Number(li.discount_amount) > 0
        ? {
            stack: [
              { text: fmtCurrency(li.line_total), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
              { text: fmtCurrency(net) },
            ],
            alignment: 'right' as const,
          }
        : { text: fmtCurrency(net), alignment: 'right' },
    ]);
  }
  const pricedScopes = asScopeArray(invoice.scopes).filter((s) => s.flat_price != null);
  for (const scope of pricedScopes) {
    tableBody.push([
      {
        stack: [
          { text: 'SCOPE OF WORK', bold: true, fontSize: 7, color: '#999999', margin: [0, 0, 0, 2] as any },
          { text: scope.title, bold: true },
          ...(scope.body ? [{ text: scope.body, fontSize: 9, color: '#666' }] : []),
        ],
      },
      { text: '—', alignment: 'center' },
      { text: '—', alignment: 'right' },
      { text: fmtCurrency(scope.flat_price ?? 0), alignment: 'right' },
    ]);
  }

  const paid = activePaymentsTotal(invoice.payments);
  const totalsTable = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: [75, 75] as any,
          body: [
            [{ text: 'Sub total', alignment: 'right' }, { text: fmtCurrency(invoice.subtotal), alignment: 'right' }],
            ...(hasDocDiscount(invoice)
              ? [[
                  { text: invoice.discount_name || 'Discount', alignment: 'right' },
                  { text: `−${fmtCurrency(Number(invoice.discount_amount))}`, alignment: 'right' },
                ]]
              : []),
            [{ text: `Tax ${fmtTaxRate(invoice.tax_rate)}`, alignment: 'right' }, { text: fmtCurrency(invoice.tax_amount), alignment: 'right' }],
            [{ text: 'Total', alignment: 'right', bold: true, fontSize: 12 }, { text: fmtCurrency(invoice.total_amount), alignment: 'right', bold: true, fontSize: 12 }],
            ...(invoice.deposit_credit > 0
              ? [[
                  { text: 'Deposit credit', alignment: 'right' },
                  { text: `−${fmtCurrency(invoice.deposit_credit)}`, alignment: 'right' },
                ]]
              : []),
            ...(paid > 0
              ? [[
                  { text: 'Payments', alignment: 'right' },
                  { text: `−${fmtCurrency(paid)}`, alignment: 'right' },
                ]]
              : []),
            [{ text: 'Balance Due', alignment: 'right', bold: true, fontSize: 12 }, { text: fmtCurrency(invoice.amount_due), alignment: 'right', bold: true, fontSize: 12 }],
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 10, 0, 20] as any,
  };

  return {
    content: [
      {
        columns: [
          { width: 200, ...logoBlock },
          { text: 'INVOICE', fontSize: 32, bold: true, color: '#666', alignment: 'right' },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        columns: [
          {
            stack: [
              org.name,
              `${org.address_line1}, ${org.city}, ${org.state}, ${org.postal_code}`,
              org.email,
              org.website || '',
            ],
          },
          {
            columns: [
              { width: '*', text: '' },
              {
                width: 'auto',
                table: {
                  widths: ['auto', 100] as any,
                  body: [
                    [{ text: 'Invoice #', bold: true, alignment: 'right' }, { text: invoice.invoice_number, alignment: 'right' }],
                    [{ text: 'Date',      bold: true, alignment: 'right' }, { text: fmtDate(invoice.created_at), alignment: 'right' }],
                    [{ text: 'Balance',   bold: true, alignment: 'right' }, { text: fmtCurrency(invoice.amount_due), alignment: 'right' }],
                    [{ text: 'Due On',    bold: true, alignment: 'right' }, { text: invoice.due_date ? fmtDate(invoice.due_date) : '—', alignment: 'right' }],
                  ],
                },
                layout: 'noBorders',
              },
            ],
          },
        ],
        margin: [0, 0, 0, 30] as any,
      },
      {
        columns: [
          { stack: billTo },
          { stack: serviceLocation },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        table: {
          headerRows: 1,
          widths: ['*', 40, 70, 70] as any,
          body: tableBody,
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => '#e5e5e5',
        },
      },
      totalsTable as any,
      // Same rule as the estimate above, and stricter than the truthiness test it replaces:
      // '   ' and '**' are truthy but render as nothing under the heading.
      ...(hasRenderableContent(terms) ? [{ text: 'Terms:', bold: true, margin: [0, 10, 0, 4] as any }, { text: terms, style: 'paragraph' }] : []),
      ...(hasRenderableContent(notes) ? [{ text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(notes)] : []),
      ...(hasRenderableContent(paymentTerms) ? [{ text: 'PAYMENT TERMS:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(paymentTerms)] : []),
      { text: 'Thank You For Your Business', fontSize: 18, bold: true, alignment: 'center', margin: [0, 30, 0, 0] as any },
    ],
    defaultStyle: { font: 'Inter', fontSize: 10 },
    styles: {
      paragraph: { fontSize: 10, lineHeight: 1.3 },
    },
    pageMargins: [40, 40, 40, 40],
    pageSize: 'LETTER',
  };
}

export type { EstimateForPdf, OrgForPdf, InvoiceForPdf };
