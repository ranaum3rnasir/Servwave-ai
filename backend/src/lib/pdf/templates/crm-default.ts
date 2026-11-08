import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { markdownToPdfMake, hasRenderableContent } from '../markdown';
import {
  fmtCurrency,
  fmtDate,
  fmtTaxRate,
  hasDocDiscount,
  lineNetTotal,
  pickContent,
  isInvoiceSameAsBilling,
  activePaymentsTotal,
  type EstimateForPdf,
  type OrgForPdf,
  type InvoiceForPdf,
} from './alpha-classic';
import { asScopeArray } from '../../scopes';
import {
  buildEstimateDocumentView,
  documentSections,
  hasOptionalExtras,
  isOptionalExtra,
  optionalMarkerFor,
  optionalSummaryFor,
  OPTIONAL_TOTALS_NOTE,
  type DocumentRow,
  type DocumentSection,
} from '../../estimate-document-view';
import { imageKeyForPhoto, imageKeyForRow, type DocumentImages } from '../document-images';

// The coloured type chips. INVOICE-ONLY since 2026-09-13 (Ran, after reviewing the rendered
// PDFs): an estimate's rows sit under a section that already says what they are, so a per-row
// marker restates it. The invoice builder below still reads its own line items rather than the
// view-model, so it keeps them until that is re-pointed — see `buildCrmDefaultInvoicePdf`.
const TAG_COLORS: Record<string, string> = {
  MATERIAL: '#F97316',
  SERVICE: '#3B82F6',
};

const TAG_LABELS: Record<string, string> = {
  MATERIAL: 'Material',
  SERVICE: 'Service',
};

// §2.5b — a priced scope-of-work block isn't a MATERIAL/SERVICE line item (no item_type), so it
// gets its own tag rather than a lookup miss against TAG_COLORS/TAG_LABELS. Invoice-only too.
const SCOPE_TAG_COLOR = '#6B7280';
const SCOPE_TAG_LABEL = 'Scope';

/**
 * The photo strip beneath a scope block: up to four across, wrapping beyond that, each sized with
 * a `fit` box so none is distorted. Only photos actually PRESENT in the dictionary are drawn —
 * pdfmake throws on a reference it cannot resolve, and a photo whose fetch failed has no entry.
 */
function photoStrip(row: DocumentRow, images: DocumentImages): any[] {
  const drawable = row.photos.filter((p) => images[imageKeyForPhoto(p.id)]);
  if (drawable.length === 0) return [];
  const columns = 4;
  const out: any[] = [];
  for (let i = 0; i < drawable.length; i += columns) {
    const slice = drawable.slice(i, i + columns);
    out.push({
      columns: [
        ...slice.map((p) => ({ image: imageKeyForPhoto(p.id), fit: [80, 80] as [number, number] })),
        // Pad the last row so a lone photo is not stretched across the full width.
        ...Array.from({ length: columns - slice.length }, () => ({ text: '' })),
      ],
      columnGap: 6,
      margin: [0, 4, 0, 0] as any,
    });
  }
  return out;
}

/**
 * The icon cell: the price-book item's own image, by NAME from the dictionary, or nothing.
 *
 * Ran, 2026-09-13, after reviewing the rendered PDFs: the grey em-dash this template used to draw
 * for a row with no image is gone. It was a column-filler left over from when scopes shared the
 * line-item table, and it reads as a value that is MISSING rather than one that does not apply. A
 * scope block never has an image, so its cell is always the empty one.
 */
function iconCell(row: DocumentRow, images: DocumentImages): any {
  const key = imageKeyForRow(row.key);
  return images[key] ? { image: key, fit: [48, 48] as [number, number] } : { text: '' };
}

/**
 * #2053, Ran's call — the marker on an optional add-on the customer has not selected, in this
 * template's own voice: an unpunctuated bold caption under the description, carrying its headings'
 * weight at the size of the grey "Qty n @ price" line it sits beneath, undimmed so it reads as a
 * statement rather than a footnote. A row that IS in the price gets nothing, so a document written
 * before optional items existed is unchanged.
 */
function optionalMarker(row: DocumentRow): any[] {
  const marker = optionalMarkerFor(row);
  if (!marker) return [];
  return [{ text: marker, bold: true, fontSize: 9, margin: [0, 2, 0, 0] as any }];
}

/** One line-item row, in this template's image + description + price columns. */
function lineItemRow(row: DocumentRow, images: DocumentImages, withIcon: boolean): any[] {
  // The struck-through figure is the GROSS price and the bold one is the net the Subtotal
  // actually contains. This once printed line_total for both, so a discounted line rendered the
  // same number twice, one of them crossed out.
  const priceCell: any = row.discounted
    ? {
        stack: [
          { text: fmtCurrency(row.grossAmount ?? 0), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
          { text: fmtCurrency(row.netAmount ?? 0), bold: true },
        ],
        alignment: 'right' as const,
      }
    // BLANK, not a zero, when the row carries no amount at all — the unpriced scope block `scopeRow`
    // below already treats this way. A "$0.00" would tell the customer the work is free. An
    // optional add-on is NOT this case (#2053, Ran): it prints its figure and carries the marker.
    : { text: row.netAmount != null ? fmtCurrency(row.netAmount) : '', alignment: 'right' as const };

  return [
    ...(withIcon ? [iconCell(row, images)] : []),
    {
      stack: [
        { text: row.title, bold: true },
        ...(row.detail ? [{ text: row.detail, fontSize: 9, color: '#666666' }] : []),
        { text: `Qty ${row.quantity} @ ${fmtCurrency(row.unitPrice ?? 0)}`, fontSize: 9, color: '#888888', margin: [0, 2, 0, 0] as any },
        ...optionalMarker(row),
      ],
    },
    priceCell,
  ];
}

/**
 * One scope-of-work row. An unpriced block's price cell is BLANK, not a zero — a zero would tell
 * the customer the work is free, where a blank says it is not separately priced.
 */
function scopeRow(row: DocumentRow, images: DocumentImages, withIcon: boolean): any[] {
  return [
    ...(withIcon ? [iconCell(row, images)] : []),
    {
      stack: [
        { text: row.title, bold: true },
        ...(row.detail ? [{ text: row.detail, fontSize: 9, color: '#666666' }] : []),
        ...optionalMarker(row),
        ...photoStrip(row, images),
      ],
    },
    { text: row.netAmount != null ? fmtCurrency(row.netAmount) : '', alignment: 'right' as const },
  ];
}

/**
 * The document's sections, drawn in this template's own voice: a bold 11pt heading — the one the
 * Scope of Work card has always used — over a table whose description and amount columns line up
 * down the page whether or not a section carries the optional icon column.
 *
 * #2028 slice 3 — a section is emitted only when the view-model returns it, so an estimate with
 * no line items draws no line-item table and an estimate with both draws two headed tables
 * instead of one run-together list. A document with only ONE section is drawn with no heading at
 * all (Ran, 2026-09-13): the view-model nulls the title and this draws nothing for it.
 */
function sectionBlocks(sections: DocumentSection[], images: DocumentImages): any[] {
  return sections.flatMap((section, i) => {
    // A lone section carries no title (the view-model's call) and gets no heading block at all —
    // not an empty one, which would still take its 4pt of space above the table.
    const heading = section.title
      ? [{ text: section.title, bold: true, fontSize: 11, margin: [0, i === 0 ? 0 : 16, 0, 4] as any }]
      : [];
    const notes = section.notes
      ? [{ text: section.notes, fontSize: 10, margin: [0, 0, 0, section.rows.length > 0 ? 8 : 0] as any }]
      : [];
    if (section.rows.length === 0) return [...heading, ...notes];

    // The icon column exists to hold a price-book image. With the em-dash placeholder gone there
    // is nothing else to put in it, so a section whose rows have no drawable image drops the
    // column rather than indenting its descriptions behind 64pt of nothing. A scope section never
    // has one: a scope's photos hang under its description, not beside it.
    const withIcon = section.rows.some((row) => images[imageKeyForRow(row.key)]);

    return [
      ...heading,
      ...notes,
      {
        table: {
          widths: (withIcon ? [64, '*', 80] : ['*', 80]) as any,
          body: section.rows.map((row) =>
            section.kind === 'scope' ? scopeRow(row, images, withIcon) : lineItemRow(row, images, withIcon),
          ),
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => '#e5e5e5',
        },
        margin: [0, 0, 0, 16] as any,
      },
    ];
  });
}

export function buildCrmDefaultPdf(
  estimate: EstimateForPdf,
  org: OrgForPdf,
  images: DocumentImages = {},
): TDocumentDefinitions {
  // customer_id is required on every estimate going forward — the direct anchor is the common
  // case; `lead?.customer` is the fallback for rows still reached only through their lead.
  const c = estimate.customer ?? estimate.lead?.customer;
  if (!c) throw new Error('Estimate has no customer');
  // #2028 — every content decision comes from the view-model; what is left here is this
  // template's own layout (the centred header, the image/tag column, the stacked totals).
  const view = buildEstimateDocumentView(estimate, org);
  const { terms, notes, paymentTerms } = view;

  // Centered header: logo or org name
  const headerBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number], alignment: 'center' as const }
    : { text: org.name, fontSize: 22, bold: true, color: org.brand_color, alignment: 'center' as const };

  // Centered title + prepared for
  const titleBlock = {
    stack: [
      { text: `Estimate ${estimate.estimate_number}`, fontSize: 22, bold: true, alignment: 'center' as const },
      { text: `Prepared for ${c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ')}`, fontSize: 10, color: '#666666', alignment: 'center' as const, margin: [0, 4, 0, 0] as any },
    ],
    margin: [0, 16, 0, 20] as any,
  };

  // #2028 slice 3 — which sections this document has is the view-model's call, so the previewed
  // PDF, the emailed PDF and the public page make the same three decisions. The scope-of-work
  // narrative leads the scope section rather than sitting in a card of its own with the same
  // heading on it. Slice 4: an UNPRICED scope block is printed too, with a blank price — it used
  // to be filtered out, so work the salesperson had described vanished from the customer's
  // document. It contributes nothing to the totals, which was already true.
  const sections = sectionBlocks(documentSections(view), images);

  // Totals — simple right-aligned column stack (no table wrapper). Which rows exist, in what
  // order, and which are subtractions is the view-model's call; this supplies wording and weight.
  // NOTE: no Line Discounts row — each discounted line already shows its gross struck through
  // above, so a summary row would double-count visually.
  const totalsBlock = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        stack: view.totals
          .filter((t) => t.kind !== 'line_discounts')
          .map((t) => {
            const label = t.kind === 'tax' ? `Tax ${fmtTaxRate(view.taxRate)}` : t.label;
            const amount = t.negative ? `−${fmtCurrency(t.amount)}` : fmtCurrency(t.amount);
            const emphasis = t.kind === 'total' ? { bold: true, fontSize: 12 } : {};
            return {
              columns: [
                { width: 80, text: label, ...emphasis, alignment: 'right' as const },
                { width: 80, text: amount, ...emphasis, alignment: 'right' as const },
              ],
              margin: (t.kind === 'total' ? [0, 4, 0, 0] : [0, 2, 0, 2]) as any,
            };
          }),
      },
    ],
    margin: [0, 0, 0, 24] as any,
  };

  // #2089 — "N of M optional add-ons included", a plain count sitting beside the totals it
  // summarises rather than inside them (same reasoning as the note below). No currency figure,
  // so a price change never requires this line to change — only a selection does. Absent
  // entirely when the document offers nothing optional.
  const optionalSummary = optionalSummaryFor(view);
  const optionalSummaryBlock = optionalSummary
    ? [{ text: optionalSummary, fontSize: 9, alignment: 'right' as const, color: '#666666', margin: [0, -16, 0, 2] as any }]
    : [];

  // #2053, Ran's call — the companion to the row markers. Without it the amounts beside them are
  // the only evidence, and a reader who scans straight to the bottom has no way to tell that the
  // Total does not contain them. Printed only when the document actually offers something
  // optional, right-aligned under the totals stack it qualifies, in this template's bold caption
  // voice. The negative top margin borrows from the totals block's own 24pt tail so the note sits
  // under the Total rather than drifting onto the Terms heading — unless the count above already
  // did that, in which case the note sits under IT instead.
  const optionalNote = hasOptionalExtras(view)
    ? [{ text: OPTIONAL_TOTALS_NOTE, bold: true, fontSize: 9, alignment: 'right' as const, margin: [0, optionalSummary ? 0 : -16, 0, 16] as any }]
    : [];

  // Signature block (conditional)
  const signatureBlock: any[] = view.signature
    ? [
        { text: 'Customer Signature:', bold: true, margin: [0, 20, 0, 8] as any, pageBreak: 'before' as any },
        { image: view.signature.data, width: 150, height: 60 },
        { text: `Approved on ${view.signature.at ? fmtDate(view.signature.at) : ''}`, fontSize: 9, color: '#666666' },
      ]
    : [];

  return {
    // #2029 — the document's images, by NAME. pdfmake stores each entry once however many times
    // the content references it, which an inline data URI per reference does not.
    images,
    content: [
      headerBlock,
      titleBlock,
      ...sections,
      totalsBlock,
      // A SIBLING of the totals stack, never a row inside it: the totals are the document's
      // arithmetic and nothing this feature does may touch them.
      ...optionalSummaryBlock,
      ...optionalNote,
      // A heading is printed only when there is body text under it. An org that has not written
      // its terms yet holds '' (and the send path snapshots that ''), so an unconditional heading
      // put a bare "Terms:" on that tenant's first sent estimate.
      ...(hasRenderableContent(terms)
        ? [{ text: 'Terms:', bold: true, margin: [0, 0, 0, 4] as any }, ...markdownToPdfMake(terms)]
        : []),
      ...(hasRenderableContent(notes)
        ? [{ text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(notes)]
        : []),
      ...(hasRenderableContent(paymentTerms)
        ? [{ text: 'Payment Terms:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(paymentTerms)]
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

export function buildCrmDefaultInvoicePdf(
  invoice: InvoiceForPdf,
  org: OrgForPdf,
): TDocumentDefinitions {
  const c = invoice.customer;
  // Invoices have no snapshot_* columns — always the org's CURRENT copy.
  const terms = org.invoice_terms ?? '';
  const notes = org.invoice_notes ?? '';
  const paymentTerms = org.invoice_payment_terms ?? '';

  const headerBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number], alignment: 'center' as const }
    : { text: org.name, fontSize: 22, bold: true, color: org.brand_color, alignment: 'center' as const };

  const customerName = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const titleBlock = {
    stack: [
      { text: `Invoice ${invoice.invoice_number}`, fontSize: 22, bold: true, alignment: 'center' as const },
      { text: `Billed to ${customerName}`, fontSize: 10, color: '#666666', alignment: 'center' as const, margin: [0, 4, 0, 0] as any },
    ],
    margin: [0, 16, 0, 20] as any,
  };

  const tableBody: any[] = [];
  for (const li of invoice.line_items) {
    const parts = li.description.split('\n');
    const tagLabel = TAG_LABELS[li.item_type] ?? li.item_type;
    const tagColor = TAG_COLORS[li.item_type] ?? '#888888';
    const hasDiscount = Number(li.discount_amount) > 0;
    const net = lineNetTotal(li);

    const priceCell: any = hasDiscount
      ? {
          stack: [
            { text: fmtCurrency(li.line_total), decoration: 'lineThrough', color: '#999999', fontSize: 9 },
            { text: fmtCurrency(net), bold: true },
          ],
          alignment: 'right' as const,
        }
      : { text: fmtCurrency(net), alignment: 'right' as const };

    tableBody.push([
      {
        stack: [
          li.price_book_item?.image_url
            ? { image: li.price_book_item.image_url, fit: [48, 48] as [number, number] }
            : { text: '—', color: '#cccccc', fontSize: 18, alignment: 'center' as const },
          {
            text: tagLabel,
            fontSize: 8,
            bold: true,
            color: '#ffffff',
            background: tagColor,
            alignment: 'center' as const,
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
      {
        stack: [
          { text: parts[0], bold: true },
          ...(parts.slice(1).length > 0
            ? [{ text: parts.slice(1).join('\n'), fontSize: 9, color: '#666666' }]
            : []),
          { text: `Qty ${li.quantity} @ ${fmtCurrency(li.unit_price)}`, fontSize: 9, color: '#888888', margin: [0, 2, 0, 0] as any },
        ],
      },
      priceCell,
    ]);
  }
  const pricedScopes = asScopeArray(invoice.scopes).filter((s) => s.flat_price != null);
  for (const scope of pricedScopes) {
    tableBody.push([
      {
        stack: [
          { text: '—', color: '#cccccc', fontSize: 18, alignment: 'center' as const },
          {
            text: SCOPE_TAG_LABEL,
            fontSize: 8,
            bold: true,
            color: '#ffffff',
            background: SCOPE_TAG_COLOR,
            alignment: 'center' as const,
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
      {
        stack: [
          { text: scope.title, bold: true },
          ...(scope.body ? [{ text: scope.body, fontSize: 9, color: '#666666' }] : []),
        ],
      },
      { text: fmtCurrency(scope.flat_price ?? 0), alignment: 'right' as const },
    ]);
  }

  const lineItemsTable = {
    table: {
      widths: [64, '*', 80] as any,
      body: tableBody,
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => '#e5e5e5',
    },
    margin: [0, 0, 0, 16] as any,
  };

  const paid = activePaymentsTotal(invoice.payments);
  const totalsBlock = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        stack: [
          {
            columns: [
              { width: 80, text: 'Subtotal', alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.subtotal), alignment: 'right' as const },
            ],
            margin: [0, 2, 0, 2] as any,
          },
          ...(hasDocDiscount(invoice)
            ? [{
                columns: [
                  { width: 80, text: invoice.discount_name || 'Discount', alignment: 'right' as const },
                  { width: 80, text: `−${fmtCurrency(Number(invoice.discount_amount))}`, alignment: 'right' as const },
                ],
                margin: [0, 2, 0, 2] as any,
              }]
            : []),
          {
            columns: [
              { width: 80, text: `Tax ${fmtTaxRate(invoice.tax_rate)}`, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.tax_amount), alignment: 'right' as const },
            ],
            margin: [0, 2, 0, 2] as any,
          },
          {
            columns: [
              { width: 80, text: 'Total', bold: true, fontSize: 12, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.total_amount), bold: true, fontSize: 12, alignment: 'right' as const },
            ],
            margin: [0, 4, 0, 0] as any,
          },
          ...(invoice.deposit_credit > 0
            ? [{
                columns: [
                  { width: 80, text: 'Deposit credit', alignment: 'right' as const },
                  { width: 80, text: `−${fmtCurrency(invoice.deposit_credit)}`, alignment: 'right' as const },
                ],
                margin: [0, 2, 0, 2] as any,
              }]
            : []),
          ...(paid > 0
            ? [{
                columns: [
                  { width: 80, text: 'Payments', alignment: 'right' as const },
                  { width: 80, text: `−${fmtCurrency(paid)}`, alignment: 'right' as const },
                ],
                margin: [0, 2, 0, 2] as any,
              }]
            : []),
          {
            columns: [
              { width: 80, text: 'Balance Due', bold: true, fontSize: 12, alignment: 'right' as const },
              { width: 80, text: fmtCurrency(invoice.amount_due), bold: true, fontSize: 12, alignment: 'right' as const },
            ],
            margin: [0, 4, 0, 0] as any,
          },
        ],
      },
    ],
    margin: [0, 0, 0, 24] as any,
  };

  const sameAsBilling = isInvoiceSameAsBilling(invoice);
  const loc = invoice.service_location;
  const serviceLocationBlock = [
    {
      stack: [
        { text: 'Service Location:', bold: true, fontSize: 10, margin: [0, 0, 0, 4] as any },
        {
          text: sameAsBilling
            ? 'Same as billing'
            : `${loc?.address_line1}, ${loc?.city}, ${loc?.state} ${loc?.zip}`,
          fontSize: 10,
          color: '#666666',
        },
      ],
      margin: [0, 0, 0, 16] as any,
    },
  ];

  return {
    content: [
      headerBlock,
      titleBlock,
      ...serviceLocationBlock,
      lineItemsTable,
      totalsBlock,
      // Same rule as the estimate above, and stricter than the truthiness test it replaces:
      // '   ' and '**' are truthy but render as nothing under the heading.
      ...(hasRenderableContent(terms) ? [{ text: 'Terms:', bold: true, margin: [0, 0, 0, 4] as any }, ...markdownToPdfMake(terms)] : []),
      ...(hasRenderableContent(notes) ? [{ text: 'Notes:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(notes)] : []),
      ...(hasRenderableContent(paymentTerms) ? [{ text: 'Payment Terms:', bold: true, margin: [0, 16, 0, 4] as any }, ...markdownToPdfMake(paymentTerms)] : []),
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
