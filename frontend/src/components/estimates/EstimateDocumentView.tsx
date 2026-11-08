import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { Heading } from '@/components/ui/heading';
import { FileText, Package, Wrench } from 'lucide-react';
import { cn, formatCurrency, formatTaxRatePercent } from '@/lib/utils';
import {
  buildEstimateDocumentModel,
  documentSections,
  hasOptionalExtras,
  optionalMarkerFor,
  OPTIONAL_TOTALS_NOTE,
  type DocumentRow,
  type EstimateDocumentModel,
} from '@/lib/estimate-document-view';

// ─── Types ──────────────────────────────────────────

interface DocumentLineItem {
  id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  line_total: number;
  item_type?: string;
  discount_type?: string | null;
  discount_value?: number | null;
  discount_amount?: number | null;
  price_book_item?: { image_url?: string | null };
  // #2053 — absent on every pre-migration row and on every Job line; the shared model reads an
  // absent pair as "counts", which is the unconditional behaviour that predates the feature.
  is_optional?: boolean | null;
  is_selected?: boolean | null;
}

/**
 * A flat-priced, non-line-item scope-of-work block. #2028 — the server folds every priced
 * scope's flat_price into the subtotal, so a document that lists line items and a subtotal
 * without these prints an arithmetic the reader cannot reconcile.
 */
interface DocumentScope {
  id: string;
  title: string;
  body?: string | null;
  flat_price?: number | null;
  /** #2053 — see `DocumentLineItem`; a scope block carries the same pair. */
  is_optional?: boolean | null;
  is_selected?: boolean | null;
}

interface EstimateDocumentViewProps {
  estimateNumber?: string;
  documentLabel?: string;
  customerName: string;
  companyName?: string | null;
  scopeNotes?: string;
  /**
   * A view-model that has ALREADY been built — the frozen one a past version holds (#2030).
   * When given, it IS the document and the raw fields below are ignored: there is one rendering
   * path either way, only two ways of arriving at the same model.
   */
  document?: EstimateDocumentModel;
  lineItems?: DocumentLineItem[];
  scopes?: DocumentScope[];
  /** Flat, carrying `scope_id` — the view-model groups them under their block. */
  scopePhotos?: Array<{ id: string; scope_id: string; url: string; caption?: string | null }>;
  subtotal?: number;
  taxRate: number;
  taxAmount?: number;
  totalAmount?: number;
  discountType?: string | null;
  discountValue?: number | null;
  discountName?: string | null;
  discountAmount?: number | null;
  /**
   * An optional control drawn at the LEADING edge of every row - the customer-facing page's
   * tick box for an optional add-on, and nothing else today. Return null for a row that carries
   * no control; the column is still reserved for it.
   *
   * THE COLUMN IS GATED ON THIS PROP BEING PASSED, NOT ON WHAT IT RETURNS. A caller that passes
   * one reserves the column on every row, so a title does not sit 28px further right on the rows
   * that happen to have a control than on the rows that do not. A caller that passes nothing
   * draws no column and no spacer, so the two callers that pass none - `EstimateVersionPage` and
   * `ViewWorkOrderDialog` - render byte-identically WITH RESPECT TO THIS SLOT to the document
   * that predates it. Pinned by `__tests__/estimate-document-view-parity.test.tsx`.
   */
  rowControl?: (row: DocumentRow) => ReactNode;
  /**
   * #2089 - whether the estimate's selections are locked. Mirrors `areSelectionsLocked`
   * (`@/lib/estimates/selectionLock`): signing locks, full stop - `estimate.status === 'WON'` and
   * nothing else, not a deposit either paid or absent (#2205 superseded that reading).
   * An untaken optional row then reads "Declined" instead of "Optional (not included)". Ignored
   * when `document` is given — a frozen version prints whatever its own rows already carry.
   * Defaults to false, unchanged for every caller that does not pass it.
   */
  locked?: boolean;
}

// ─── Row ────────────────────────────────────────────

/** One row of the priced list — a line item or a scope block. Layout only. */
function DocumentRowCard({ row, rowControl }: { row: DocumentRow; rowControl?: (row: DocumentRow) => ReactNode }) {
  const control = rowControl ? rowControl(row) : null;
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-background-light border border-border">
      {/* Control column, drawn only for a caller that supplies a rowControl - see the prop. The
          box is 16px whether or not the row has a control; with none it is an empty SPACER,
          hidden from assistive technology so it is never announced as a control this row does
          not have. A control that wants a bigger tap target than 16px overflows this box with
          negative margins, the way `LineItemRow.tsx` does, so the reserved column stays 16px. */}
      {rowControl && (
        <div className="mt-1 h-4 w-4 shrink-0" aria-hidden={control == null || undefined}>{control}</div>
      )}

      {/* Image / type-tag column */}
      <div className="shrink-0">
        {row.imageUrl ? (
          <UploadedImage src={row.imageUrl} radius="lg" className="h-14 w-14" />
        ) : (
          <div className="h-14 w-14 rounded-lg bg-background-light flex items-center justify-center">
            {row.kind === 'scope'
              ? <FileText className="h-5 w-5 text-text-soft" />
              : row.itemType === 'MATERIAL'
                ? <Package className="h-5 w-5 text-text-soft" />
                : <Wrench className="h-5 w-5 text-text-soft" />}
          </div>
        )}
        <div className={cn(
          'mt-1 text-center text-[10px] font-medium py-0.5 rounded',
          row.kind === 'scope'
            ? 'bg-background-light text-text-secondary'
            : row.itemType === 'MATERIAL'
              ? 'bg-warning-surface text-warning-text'
              : 'bg-info-surface text-info-text',
        )}>
          {row.kind === 'scope' ? 'Scope' : row.itemType === 'MATERIAL' ? 'Material' : 'Service'}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{row.title}</p>
        {/* #2053, Ran's call - the tag on an optional add-on, beside the name it belongs to, in
            the page's own pill idiom (the same one the estimate editor puts an "Optional" chip in,
            so the salesperson and the customer read the same term). #2090: an add-on the customer
            HAS taken keeps the tag and drops the "(not included)" half, because it is now in the
            price. A row that was never optional shows nothing at all, so every document written
            before optional items existed renders exactly as it did. */}
        {optionalMarkerFor(row) && (
          <span className="mt-1 inline-block rounded-full border border-border bg-surface-light px-2.5 py-0.5 text-[11px] font-semibold text-text-secondary">
            {optionalMarkerFor(row)}
          </span>
        )}
        {row.detail && (
          <p className="text-xs text-text-secondary mt-0.5 whitespace-pre-wrap">{row.detail}</p>
        )}
        {row.kind === 'line_item' && (
          <div className="flex items-center gap-4 mt-1 text-xs text-text-secondary">
            <span>Qty: <span className="tabular-nums">{row.quantity}</span></span>
            <span>@ <span className="tabular-nums">{formatCurrency(row.unitPrice ?? 0)}</span></span>
          </div>
        )}
        {/* #2029 — the scope's own photos, up to four across and wrapping beyond that. These are
            the ONLY uploaded images on the document: never the lead's attachments, never the
            job's, never the estimate's own file panel. A scope with none renders no strip. */}
        {row.photos.length > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {row.photos.map((photo) => (
              <UploadedImage
                key={photo.id}
                src={photo.url}
                alt={photo.caption ?? 'Scope photo'}
                radius="lg"
                className="aspect-square w-full"
              />
            ))}
          </div>
        )}
        {row.discountType && (
          <p className="text-xs text-warning-text mt-0.5">
            Discount: {row.discountType === 'PERCENTAGE' ? `${row.discountValue}%` : formatCurrency(row.discountValue ?? 0)}
            {' '}(-{formatCurrency(row.discountAmount ?? 0)})
          </p>
        )}
      </div>

      {/* Amount. Blank ONLY on an unpriced scope block — a $0.00 would tell the customer the work
          is free, where a blank says it is not separately priced. An optional add-on prints its
          figure like any other row; the pill above says it is not in the Total. */}
      <div className="shrink-0 text-right">
        {row.netAmount == null ? null : row.discounted ? (
          <>
            <span className="text-xs text-text-soft line-through tabular-nums block">{formatCurrency(row.grossAmount ?? 0)}</span>
            <span className="text-sm font-semibold tabular-nums text-text-primary">{formatCurrency(row.netAmount ?? 0)}</span>
          </>
        ) : (
          <span className="text-sm font-semibold tabular-nums text-text-primary">{formatCurrency(row.netAmount ?? 0)}</span>
        )}
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────

export function EstimateDocumentView({
  estimateNumber,
  documentLabel = 'Estimate',
  customerName,
  companyName,
  scopeNotes,
  document,
  lineItems = [],
  scopes = [],
  scopePhotos = [],
  subtotal = 0,
  taxRate,
  taxAmount = 0,
  totalAmount = 0,
  discountName,
  discountAmount,
  rowControl,
  locked = false,
}: EstimateDocumentViewProps) {
  // #2028 — every content decision (which rows exist, how each is presented, how discounts are
  // summarised, what the totals rows are) comes from the shared view-model, which mirrors the one
  // the PDF templates render from. What is left in this component is layout.
  const view = document ?? buildEstimateDocumentModel({
    scopeNotes,
    lineItems,
    scopes,
    scopePhotos,
    subtotal,
    taxAmount,
    totalAmount,
    discountName,
    discountAmount,
    locked,
  });

  // #2028 slice 3 — which sections exist is the shared model's call, not this component's, so the
  // page, the emailed PDF and the previewed PDF make the same three decisions. A section is
  // returned only when it has content: an estimate with no line items draws no line-item
  // structure and no empty header, and one with both draws two separate cards.
  const sections = documentSections(view);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <FileText className="h-10 w-10 text-primary mx-auto mb-3" />
        <Heading level={1} scale="2xl" weight="bold">
          {estimateNumber ? `${documentLabel} ${estimateNumber}` : `New ${documentLabel}`}
        </Heading>
        <p className="text-sm text-text-secondary mt-1">
          Prepared for {customerName}
          {companyName && ` — ${companyName}`}
        </p>
      </div>

      {/* One card per section. The card boundary plus the eyebrow heading is the visual
          separation the two sections need — not a blank line between two runs of rows. */}
      {sections.map((section) => (
        <Card key={section.kind} padding="sm">
          {/* eyebrow style, no matching Heading variant. A lone section carries no title (the
              shared model's call) and gets no heading element at all — an empty one would still
              put its margin on the page. */}
          {section.title && (
            <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary mb-2">{section.title}</h3>
          )}
          {/* The scope narrative leads its own section rather than getting a second card with the
              same heading on it. */}
          {section.notes && (
            <p className="text-sm text-text-primary whitespace-pre-wrap">{section.notes}</p>
          )}
          {section.rows.length > 0 && (
            <div className={cn('space-y-3', section.notes && 'mt-3')}>
              {/* #2028 slice 4 — an UNPRICED scope block is rendered too, with a blank amount. It
                  used to be filtered out, so work the salesperson had described vanished from the
                  customer's page. It contributes nothing to the totals, which was already true. */}
              {section.rows.map((row) => (
                <DocumentRowCard key={row.key} row={row} rowControl={rowControl} />
              ))}
            </div>
          )}
        </Card>
      ))}

      {/* Totals — their OWN card, so they reconcile with whatever sections were printed above
          rather than living inside a line-item card that a scope-only estimate never draws.
          Which rows exist, in what order, and which are subtractions is the view-model's call;
          this supplies alignment and weight. */}
      <Card padding="sm">
        <div className="flex flex-col items-end space-y-1">
          {view.totals.map((total) => {
            const label = total.kind === 'tax'
              ? `Tax (${formatTaxRatePercent(taxRate)}%)`
              : total.label;
            const amount = total.negative
              ? `-${formatCurrency(total.amount)}`
              : formatCurrency(total.amount);
            if (total.kind === 'total') {
              return (
                <div key={total.kind} className="flex gap-8 text-lg font-bold border-t pt-2 mt-1">
                  <span>{label}</span>
                  <span className="tabular-nums">{amount}</span>
                </div>
              );
            }
            return (
              <div key={total.kind} className="flex gap-8 text-sm">
                <span className="text-text-secondary">{label}</span>
                <span className={cn('tabular-nums', total.negative && 'text-warning-text')}>{amount}</span>
              </div>
            );
          })}
          {/* #2053, Ran's call — the companion to the row markers. Without it the pill beside each
              add-on is the only evidence, and a reader who scans straight to the bottom has no way
              to tell that the Total does not contain those figures. It sits OUTSIDE the rows the
              model returns: it is a sentence about the arithmetic, never a line of it. */}
          {hasOptionalExtras(view) && (
            <p className="pt-1 text-xs text-text-secondary">{OPTIONAL_TOTALS_NOTE}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
