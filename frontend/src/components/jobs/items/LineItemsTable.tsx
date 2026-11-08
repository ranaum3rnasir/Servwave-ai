/**
 * LineItemsTable — the presentational line-items grid shared by the Job -> Items editor and the
 * Invoice detail editor. It owns NO data or cache logic: it renders the rows, the totals footer
 * and the add dialog, and fires the callbacks its parent supplies.
 *
 * Layout (v12): a single dense, flat receipt-style table by default — one thin-bottom-border row
 * per line (drag handle + product thumb + name over description + editable
 * qty/cost/price/discount/taxable), then the totals footer with the sales-tax jurisdiction
 * dropdown. An empty state with an "add the first line" CTA renders when there are no lines.
 * Column order: Item, Qty, Cost, Selling price, [Discount], Total, Taxable, (delete) — Taxable
 * sits right before the trailing delete action, Total before it. Item and Description were two
 * separate columns until they were merged into one document-shaped Item cell (name as the heading,
 * description stacked beneath): splitting the row's only fluid width across two columns squeezed
 * both, wrapping long item names one word per line.
 *
 * Two presentational props, both defaulting to v12's shape but NOT deleting the pre-v12 look:
 *   - `density` ('dense' default / 'card') — 'card' restores the pre-v12 floating rounded row
 *     with the 112px ProductThumb photo, kept behind the prop rather than removed.
 *   - `groupByType` (false default) — true restores the Materials/Services labeled sub-header
 *     split; v12's table has no grouping (one flat list), kept behind the prop rather than removed.
 *
 * Reordering: rows live inside a DndContext (mirrors BuilderSpine.tsx's dnd-kit precedent).
 * When `groupByType` is true, one SortableContext per Material/Service group is used —
 * item_type is immutable per line, so a cross-group drop is meaningless and is rejected as a
 * no-op (resolveDragReorder). When `groupByType` is false (the default), a single SortableContext
 * spans every line and any row may reorder past any other (resolveFlatDragReorder) — there are no
 * visual groups left to respect. Drag is the ONLY reorder affordance (the per-row Move up/down
 * chevrons were removed). However the order changed, the backend's reorder endpoint always
 * validates against the COMPLETE top-to-bottom line-id list, so `onReorder` is always called with
 * that full list, never just the ids that moved.
 *
 * The add dialog's open state is CONTROLLED (addOpen / onAddOpenChange) so the parent can drive it
 * from a header "+" button that lives outside this table (the Job's SectionCard meta slot, or the
 * Invoice editor's own header).
 *
 * Editing an existing line reuses the SAME dialog instance and the SAME controlled-from-the-parent
 * convention: `editingLine` / `onEditingLineChange` (Stage 4). Each row's pencil Edit button calls
 * `onEditingLineChange(line)`; the single <AddLineDialog> below is open when EITHER `addOpen` is
 * true OR `editingLine` is set, and its add-vs-edit mode is driven by whether `editingLine` is set.
 * `initialQuery` (v12 review fix L5) is forwarded straight through to that same dialog instance —
 * see `AddLineDialog.tsx`'s own doc for what it does.
 */
import { Fragment } from 'react';
import { Plus, Package } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TotalsFooter } from './TotalsFooter';
import { AddLineDialog } from './AddLineDialog';
import { LineItemRow } from './LineItemRow';
import { toNum } from './money';
import type {
  AddLineItemPayload,
  UpdateLineItemPayload,
  StateTaxRate,
} from '@/lib/api/invoices';
import type { InvoiceLineItem } from '@/lib/api/jobs';

// #2053 slice 1 — is_optional/is_selected are estimate-only; widened locally (same precedent as
// AddLineDialog.tsx/LineItemRow.tsx). Only ever sent when showOptionalToggle is true.
type LineAddPayload = AddLineItemPayload & { is_optional?: boolean; is_selected?: boolean };
type LineUpdatePatch = UpdateLineItemPayload & { is_optional?: boolean; is_selected?: boolean };

export interface LineItemsTableProps {
  lines: InvoiceLineItem[];
  /** Show the empty-state "add the first line" CTA (Job: canManage; Invoice: canManage && draft). */
  canAdd: boolean;
  /** Per-row trash + drag/Move reorder (Job: hasInvoice && canManage; Invoice: canManage && draft). */
  canManageRows: boolean;
  /** Inline row-field edits — gated on the rows being the invoice's OWN lines (not an estimate basis). */
  canEditRows: boolean;
  /**
   * Footer tip / invoice-discount / tax-jurisdiction edits. Independent of the rows: these are
   * invoice-level billing fields, editable on any editable DRAFT even when it owns zero lines.
   */
  canEditBilling: boolean;
  /**
   * Show the Cost column + the per-row margin sub-line under Selling price. The frontend mirror
   * of the backend's canSeePricing gate — Selling price itself is NOT gated by this.
   */
  canSeePricing: boolean;
  busy: boolean;

  /** Server-authoritative totals when an invoice exists. */
  hasInvoice: boolean;
  subtotal: string | number | null;
  tax_amount: string | number | null;
  tax_rate: string | number | null;
  discount_amount: string | number | null;
  tip: string | number | null;
  total_amount: string | number | null;
  taxRates?: StateTaxRate[];
  /** #985 - service-location state, forwarded to <TotalsFooter> to label the tax select. */
  taxStateCode?: string | null;
  estimateTotal?: number;
  /** Override the footer's bottom-total label (defaults to "Invoice total" / "Estimate total"). */
  totalLabel?: string;
  /**
   * Forwarded to the embedded `<TotalsFooter>` (v12 review fix B3). Default `true`. Pass `false`
   * when a page-level `<ReceiptCard>` already owns the running total for this surface, so the
   * footer doesn't render a second, potentially-disagreeing total (and its "Item cost" row,
   * which excludes scope `flat_price`, is suppressed alongside it rather than left standing
   * alone). See `TotalsFooter.tsx`'s file header.
   */
  showTotal?: boolean;
  /** Footer hint shown when the rows are a read-only estimate basis (no invoice yet). */
  showEstimateBasisHint?: boolean;
  /**
   * Show the per-row Discount column. Default true (Invoice/Estimate grids). The Job → Items
   * grid passes false: the job-line API doesn't persist discount fields yet, so the control
   * would silently no-op and snap back — hide it there until real job-line discount support
   * lands (SERV10X-38 Task 6c). v12's table has no per-line discount column at all; this prop
   * stays available (not removed) until the surfaces that still need it are migrated off it.
   */
  showDiscount?: boolean;
  /**
   * Row density. 'dense' (default) is v12's flat receipt table: thin bottom-border rows, ~11px
   * vertical padding, 13.5px type, a small inline item_type glyph instead of a product photo.
   * 'card' preserves the pre-v12 floating rounded row with the 112px ProductThumb — kept behind
   * this prop rather than deleted, for any surface that still wants a photo-forward row.
   */
  density?: 'dense' | 'card';
  /**
   * Split rows into labeled Materials/Services sub-groups. Default false — v12's table is one
   * flat list, matching all three surfaces (Estimate/Job/Invoice are all tables now). Kept as a
   * prop (not deleted) rather than removing the grouping capability outright.
   */
  groupByType?: boolean;
  /**
   * Minimum table width in px before the wrapper's horizontal scroll kicks in (dense only).
   * Default 1040 — the fixed money columns take ~724px of that, leaving the single fluid Item
   * column (name over description) the rest instead of wrapping a long name one word per line.
   * A surface rendering inside a narrow rail can lower it.
   */
  minWidth?: number;

  /** Add dialog (controlled by the parent). */
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  addLoading?: boolean;
  canSaveToPriceBook: boolean;
  /**
   * Edit dialog (controlled by the parent, mirroring addOpen/onAddOpenChange above). Set to a
   * line to open the shared dialog directly into its edit form; null when no row is being edited.
   */
  editingLine: InvoiceLineItem | null;
  onEditingLineChange: (line: InvoiceLineItem | null) => void;
  /**
   * Forwarded to the embedded `<AddLineDialog>` (v12 review fix L5) — when set (and no line is
   * being edited), the dialog skips the blank search screen and opens straight into the
   * creatingNew form pre-filled with this text. Lets a caller's `PriceBookPicker`'s "Add new
   * item: <query>" card hand its typed query through to this SAME dialog instance instead of it
   * reopening blank. Omit to keep the existing "open on blank search" behavior.
   */
  initialQuery?: string;
  /**
   * Forwarded to the embedded `<AddLineDialog>` (SRVW-221) - when the create form was opened via
   * `initialQuery` (the caller's PriceBookPicker hand-off), this is called instead of a plain
   * close on Back/Cancel/Escape/overlay-click, so the picker (which the hand-off closed, not left
   * mounted) can reopen and come back to the front with its browse state intact. NOT called on a
   * successful create - both dialogs close instead, by design. See AddLineDialog.tsx's own doc.
   */
  onBackToPicker?: () => void;

  onAdd: (payload: LineAddPayload) => Promise<void>;
  onUpdate: (lineId: string, patch: LineUpdatePatch) => void;
  onDelete: (lineId: string) => void;
  /**
   * Persist a drag reorder. `orderedIds` is ALWAYS the complete top-to-bottom id list for every
   * line currently in this table (all groups combined, in final desired order) — matching exactly
   * what the backend reorder endpoint validates against, even when the visible change only touched
   * one Material/Service group (or, in flat mode, looked like a single list).
   */
  onReorder: (orderedIds: string[]) => void;
  onTipChange: (value: number) => void;
  onDiscountChange: (value: number) => void;
  onTaxRateChange: (rate: number) => void;
  /**
   * #2053 slice 1 — reveal the Optional switch on the embedded `<AddLineDialog>` and the
   * "Optional" marker + row checkbox on each `<LineItemRow>`. Default `false`: Job/Invoice never
   * pass this. Only `EstimateLineItemsEditor` passes `true`. R6 — same prop name as
   * AddLineDialog/ScopeOfWorkCard.
   */
  showOptionalToggle?: boolean;
  /**
   * #2088 — threaded straight through to every `<LineItemRow>`. Default `false`, inert for
   * Job/Invoice. Since #2090 slice A3 it also carries the ONE thing that can make the optional
   * checkbox inert: the customer's signature.
   */
  selectionsLocked?: boolean;
}

const GROUPS = [
  { key: 'MATERIAL', label: 'Materials' },
  { key: 'SERVICE', label: 'Services' },
] as const;

type GroupKey = (typeof GROUPS)[number]['key'];
/** 'ALL' is the flat (ungrouped) table's single virtual group — every line lives in it. */
type GroupKeyOrAll = GroupKey | 'ALL';

/**
 * Splice a group's freshly-reordered id list back into the FULL lines array's id order, leaving
 * every other group's relative order untouched. The backend reorder endpoint validates against
 * the complete top-to-bottom id set (all groups combined), so a drag/Move that visibly only
 * touches one Material/Service group must still submit the whole list. `groupKey === 'ALL'`
 * matches every line (the flat/ungrouped case), so this doubles as the flat-mode splice too.
 */
function spliceGroupOrder(lines: InvoiceLineItem[], groupKey: GroupKeyOrAll, nextGroupIds: string[]): string[] {
  let cursor = 0;
  return lines.map((l) => {
    const inGroup = groupKey === 'ALL' || (l.item_type || 'SERVICE') === groupKey;
    if (!inGroup) return l.id;
    // Falls back to the line's own id if somehow out of bounds — never happens in practice since
    // nextGroupIds always has exactly this group's item count, but keeps this total under strict
    // indexed-access typing.
    const id = nextGroupIds[cursor] ?? l.id;
    cursor += 1;
    return id;
  });
}

/** The subset of dnd-kit's DragEndEvent that resolveDragReorder actually needs — kept minimal so
 *  tests can fabricate inputs without pulling in dnd-kit's full Active/Over shapes. */
export type DragEndLike = {
  active: { id: string | number };
  over: { id: string | number } | null;
};

/**
 * Pure core of the DndContext's onDragEnd handler for GROUPED mode (`groupByType={true}`) —
 * extracted so the cross-group-drop-rejection guard (item_type is immutable per line; a MATERIAL
 * row dropped onto a SERVICE row is meaningless) is independently unit-testable without spinning
 * up dnd-kit's DndContext in jsdom. Returns the full spliced id list to persist via onReorder, or
 * null when the drag is a no-op (no `over` target, dropped on itself, or a rejected cross-group
 * drop).
 */
export function resolveDragReorder(lines: InvoiceLineItem[], event: DragEndLike): string[] | null {
  const { active, over } = event;
  if (!over || active.id === over.id) return null;
  const activeId = String(active.id);
  const overId = String(over.id);

  const groups = GROUPS.map((g) => ({
    ...g,
    items: lines.filter((l) => (l.item_type || 'SERVICE') === g.key),
  })).filter((g) => g.items.length > 0);

  const activeGroup = groups.find((g) => g.items.some((l) => l.id === activeId));
  const overGroup = groups.find((g) => g.items.some((l) => l.id === overId));
  // item_type is immutable per line — a cross-group drop is meaningless. No-op.
  if (!activeGroup || !overGroup || activeGroup.key !== overGroup.key) return null;

  const groupIds = activeGroup.items.map((l) => l.id);
  const fromIndex = groupIds.indexOf(activeId);
  const toIndex = groupIds.indexOf(overId);
  if (fromIndex < 0 || toIndex < 0 || toIndex >= groupIds.length) return null;

  return spliceGroupOrder(lines, activeGroup.key, arrayMove(groupIds, fromIndex, toIndex));
}

/**
 * Flat-mode counterpart to resolveDragReorder, used when `groupByType` is false (v12's default —
 * one merged table, no Material/Service split). There are no visual groups left to respect, so any
 * line may reorder past any other; this is a plain arrayMove over the complete top-to-bottom id list.
 */
export function resolveFlatDragReorder(lines: InvoiceLineItem[], event: DragEndLike): string[] | null {
  const { active, over } = event;
  if (!over || active.id === over.id) return null;
  const ids = lines.map((l) => l.id);
  const fromIndex = ids.indexOf(String(active.id));
  const toIndex = ids.indexOf(String(over.id));
  if (fromIndex < 0 || toIndex < 0) return null;
  return arrayMove(ids, fromIndex, toIndex);
}

export function LineItemsTable({
  lines,
  canAdd,
  canManageRows,
  canEditRows,
  canEditBilling,
  canSeePricing,
  busy,
  hasInvoice,
  subtotal,
  tax_amount,
  tax_rate,
  discount_amount,
  tip,
  total_amount,
  taxRates = [],
  taxStateCode,
  estimateTotal = 0,
  totalLabel,
  showTotal = true,
  showEstimateBasisHint = false,
  showDiscount = true,
  density = 'dense',
  groupByType = false,
  minWidth = 1040,
  addOpen,
  onAddOpenChange,
  addLoading = false,
  canSaveToPriceBook,
  editingLine,
  onEditingLineChange,
  initialQuery,
  onBackToPicker,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
  onTipChange,
  onDiscountChange,
  onTaxRateChange,
  showOptionalToggle = false,
  selectionsLocked = false,
}: LineItemsTableProps) {
  const isDense = density !== 'card';

  const groups = groupByType
    ? GROUPS.map((g) => ({
        ...g,
        items: lines.filter((l) => (l.item_type || 'SERVICE') === g.key),
      })).filter((g) => g.items.length > 0)
    : [{ key: 'ALL' as GroupKeyOrAll, label: '', items: lines }];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const next = groupByType ? resolveDragReorder(lines, e) : resolveFlatDragReorder(lines, e);
    if (next) onReorder(next);
  }

  // A tip or invoice-level discount lives on the invoice independently of the line rows, so it can
  // linger after the last line is removed. Keep the totals footer rendered in that case (alongside
  // the empty-state CTA) so that money stays visible and editable instead of becoming orphaned.
  const hasResidualBilling = hasInvoice && (toNum(tip) > 0 || toNum(discount_amount) > 0);
  const showFooter = lines.length > 0 || hasResidualBilling;

  // Drag handle, Item (name + description), Qty, [Cost], Selling price, [Discount], Total, Taxable,
  // trash — the group sub-header spans all visible columns, so it must track Cost/Discount's presence.
  const columnCount = 7 + (showDiscount ? 1 : 0) + (canSeePricing ? 1 : 0);

  const thBase = isDense
    ? 'py-2 px-3 text-[10.5px] font-bold uppercase tracking-wider text-text-secondary'
    : 'pb-1 px-3 text-[10px] font-bold uppercase tracking-wider text-text-secondary';

  return (
    <>
      {lines.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No line items yet."
         
          action={
            canAdd ? (
              <Button
                type="button"
                variant="solid"
                tone="business"
                size="sm"
                onClick={() => onAddOpenChange(true)}
                aria-label="Add the first line item"
              >
                <Plus className="h-4 w-4" /> Add line item
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <table
              style={isDense ? { minWidth } : undefined}
              className={cn('w-full', isDense ? 'border-collapse' : 'border-separate border-spacing-y-3')}
            >
              <thead>
                <tr className={cn(isDense && 'border-b border-border bg-table-header')}>
                  <th className={isDense ? 'w-9' : 'w-10'} aria-hidden="true" />
                  {/* Item is the ONLY fluid column — everything to its right is fixed-width. It
                      carries the name AND the description stacked beneath it (they used to be two
                      side-by-side columns splitting this same width, which squeezed both). */}
                  <th className={cn(thBase, 'text-left', !isDense && 'pl-2')}>Item</th>
                  <th className={cn(thBase, 'w-[76px] text-right')}>Qty</th>
                  {canSeePricing && <th className={cn(thBase, 'w-[104px] text-right')}>Cost</th>}
                  <th className={cn(thBase, 'w-[116px] text-right')}>Selling price</th>
                  {showDiscount && <th className={cn(thBase, 'w-[148px] text-right')}>Discount</th>}
                  <th className={cn(thBase, 'w-[108px] text-right')}>Total</th>
                  <th className={cn(thBase, 'w-[84px] text-center')}>Taxable</th>
                  <th className="w-[52px]" aria-hidden="true" />
                </tr>
              </thead>
              <tbody className={cn(isDense && '[&>tr:last-child>td]:border-b-0')}>
                {groups.map((group) => (
                  <Fragment key={group.key}>
                    {groupByType && (
                      <tr>
                        <td
                          colSpan={columnCount}
                          className="px-1 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wider text-text-secondary"
                        >
                          {group.label} ({group.items.length})
                        </td>
                      </tr>
                    )}
                    <SortableContext items={group.items.map((l) => l.id)} strategy={verticalListSortingStrategy}>
                      {group.items.map((line) => (
                        <LineItemRow
                          key={line.id}
                          line={line}
                          density={density}
                          canEdit={canEditRows}
                          canManage={canManageRows}
                          canSeePricing={canSeePricing}
                          busy={busy}
                          showDiscount={showDiscount}
                          showOptionalToggle={showOptionalToggle}
                          selectionsLocked={selectionsLocked}
                          onUpdate={(patch) => onUpdate(line.id, patch)}
                          onDelete={() => onDelete(line.id)}
                          onEdit={() => onEditingLineChange(line)}
                        />
                      ))}
                    </SortableContext>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </DndContext>
        </div>
      )}

      {showFooter && (
        <TotalsFooter
          lines={lines}
          subtotal={hasInvoice ? subtotal : null}
          tax_amount={hasInvoice ? tax_amount : null}
          tax_rate={hasInvoice ? tax_rate : null}
          discount_amount={hasInvoice ? discount_amount : null}
          tip={hasInvoice ? tip : null}
          total_amount={hasInvoice ? total_amount : null}
          taxRates={taxRates}
          taxStateCode={taxStateCode}
          hasInvoice={hasInvoice}
          editable={canEditBilling}
          estimateTotal={estimateTotal}
          totalLabel={totalLabel}
          showTotal={showTotal}
          onTipChange={onTipChange}
          onDiscountChange={onDiscountChange}
          onTaxRateChange={onTaxRateChange}
        />
      )}

      {showEstimateBasisHint && lines.length > 0 && (
        <p className="mt-2 text-right text-xs text-text-secondary">
          Read-only estimate basis — add a line to start billing.
        </p>
      )}

      <AddLineDialog
        open={addOpen || editingLine != null}
        onOpenChange={(next) => {
          if (next) {
            onAddOpenChange(true);
          } else {
            // Closing (Cancel/Escape/overlay, or a successful submit closing from the parent)
            // always clears BOTH controlled slots — whichever one was driving `open` stays in sync.
            onAddOpenChange(false);
            onEditingLineChange(null);
          }
        }}
        loading={addLoading}
        canSaveToPriceBook={canSaveToPriceBook}
        canSeePricing={canSeePricing}
        editingLine={editingLine}
        initialQuery={initialQuery}
        onBackToPicker={onBackToPicker}
        onUpdate={onUpdate}
        onAdd={onAdd}
        showOptionalToggle={showOptionalToggle}
      />
    </>
  );
}
