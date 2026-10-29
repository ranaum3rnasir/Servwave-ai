/**
 * LineItemCard - one line of the line-items editor as an editable card, for phones (below md).
 *
 * `LineItemsTable` renders this INSTEAD of the 1,040 px table when the viewport is below md; from
 * md up it renders `LineItemRow` exactly as before. Same props, same callbacks, same grants:
 *   - `canEdit` makes the money fields live inputs (quantity, cost, selling price, discount) and
 *     the Taxable switch, and shows the pencil that opens the shared edit dialog;
 *   - `canManage` shows the drag handle, Move up / Move down and Remove;
 *   - `canSeePricing` shows the Cost field and the margin / markup pair, as the Cost column does.
 *
 * Reordering without a drag: Move up / Move down sit in the card's toolbar next to the drag
 * handle. They report the same complete top-to-bottom id list a drag would (the table computes it
 * with `resolveMoveReorder`), so the saved order cannot differ. The handle stays for those who
 * drag; a finger can also drag it (it is `touch-none`, activated by the table's PointerSensor).
 *
 * Layout: toolbar row, then the item (photo, name, description), then one labelled field per
 * line (label on the left, input on the right), then the line total. One field per row on
 * purpose: at 320 px two number boxes side by side leave neither wide enough to read. Every
 * control is a primary touch target (inputs 44 px by default, buttons and the switch grow on a
 * coarse pointer). The data and commit rules come from `useLineItemFields`, the same hook the
 * row uses.
 *
 * There is no row-level click-to-edit here (the table row has one): a card whose body is a button
 * would nest the inputs in a button. The pencil is the way in, as it is on the row.
 */
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Trash2, Pencil, GripVertical, ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn, formatCurrency } from '@/lib/utils';
import { calculateProfitability, formatProfitabilityPercent } from '@/lib/profitability';
import { resolveLineItemImage } from '@/lib/catalog/lineItemImage';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteLineItemPrompt } from '@/lib/confirmPrompts';
import { ProductThumb } from './ProductThumb';
import { ClampedDescription } from './ClampedDescription';
import { useLineImageUpload } from './useLineImageUpload';
import { splitDescription, useLineItemFields, type RowUpdatePatch } from './useLineItemFields';
import { toNum } from './money';
import type { InvoiceLineItem } from '@/lib/api/jobs';

export interface LineItemCardProps {
  line: InvoiceLineItem;
  canEdit: boolean;
  canManage: boolean;
  /** Show the Cost field + the margin / markup pair. Mirrors the backend's canSeePricing gate. */
  canSeePricing: boolean;
  onUpdate: (patch: RowUpdatePatch) => void;
  onDelete: () => void;
  /** Open the shared AddLineDialog in edit mode for this line. */
  onEdit: () => void;
  /** Move this line one place up / down. Absent or `canMove*` false: the button is disabled. */
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  busy?: boolean;
  /** Render the Discount field. Default true; the Job grid passes false (see LineItemsTable). */
  showDiscount?: boolean;
  /** Estimate only: the Optional tag and the Include checkbox (see LineItemRow). */
  showOptionalToggle?: boolean;
  /** Estimate only: the customer has answered the optional offers (see LineItemRow). */
  selectionsLocked?: boolean;
}

/** One labelled field: the label on the left, the control on the right, at least 44 px tall. */
function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <Label htmlFor={htmlFor} tone="subtle" className="min-w-0 text-sm">
        {label}
      </Label>
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function LineItemCard({
  line,
  canEdit,
  canManage,
  canSeePricing,
  onUpdate,
  onDelete,
  onEdit,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  busy = false,
  showDiscount = true,
  showOptionalToggle = false,
  selectionsLocked = false,
}: LineItemCardProps) {
  // Always called: the handle's listeners only attach to a rendered element when canManage.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: line.id });

  const { name, detail } = splitDescription(line.description);
  const photo = resolveLineItemImage(line.price_book_item) ?? line.photos?.[0]?.url ?? null;
  const { onAddImage, uploading } = useLineImageUpload(line);
  const showAddImage = canEdit && !photo && !!line.estimate_id && !!line.price_book_item_id;

  const { confirm, confirmDialog } = useConfirm();
  const handleDelete = async () => {
    if (!(await confirm(deleteLineItemPrompt(name)))) return;
    onDelete();
  };

  const f = useLineItemFields(line, onUpdate);
  const effectiveTotal = Math.max(0, toNum(line.line_total) - toNum(line.discount_amount));
  const profitability = calculateProfitability(line.unit_cost, line.unit_price);

  // Same wording rules as the row: one tag carries an optional row's whole state.
  const isSelected = line.is_selected ?? true;
  const optionalTag = !selectionsLocked ? 'Optional' : isSelected ? 'Included' : 'Not included';
  const checkboxChecked = line.rep_selected ?? isSelected;

  const id = (field: string) => `line-${line.id}-${field}`;
  const showToolbar = canManage || canEdit;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="line-item-card"
      className={cn(
        'rounded-xl border border-border bg-surface-light p-3',
        isDragging && 'relative z-10 shadow-lg',
      )}
    >
      {showToolbar && (
        <div className="-mt-1 mb-2 flex items-center gap-1">
          {canManage && (
            <>
              {/* Left raw: a dnd-kit drag handle - this program's own never-convert shape
                  (mirrors LineItemRow's handle and StepNode.tsx's precedent). */}
              <button
                type="button"
                ref={setActivatorNodeRef}
                aria-label={`Drag to reorder ${name}`}
                className="flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded text-text-secondary/60 hover:bg-background-light hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary active:cursor-grabbing"
                {...attributes}
                {...listeners}
              >
                <GripVertical className="h-4 w-4" aria-hidden />
              </button>
              <Button
                type="button"
                variant="ghost"
                tone="subtle"
                size="icon"
                onClick={onMoveUp}
                disabled={busy || !canMoveUp}
                className="shrink-0"
                aria-label={`Move ${name} up`}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                tone="subtle"
                size="icon"
                onClick={onMoveDown}
                disabled={busy || !canMoveDown}
                className="shrink-0"
                aria-label={`Move ${name} down`}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </>
          )}
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              tone="subtle"
              size="icon"
              onClick={onEdit}
              disabled={busy}
              className="ml-auto shrink-0"
              aria-label={`Edit ${name}`}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      <div className="flex items-start gap-3">
        {showOptionalToggle && line.is_optional && (
          <Checkbox
            id={`include-${line.id}`}
            className="mt-1"
            checked={checkboxChecked}
            disabled={selectionsLocked || busy || !canEdit}
            onCheckedChange={(v) => onUpdate({ is_selected: v === true })}
            aria-label={`Include ${name}`}
          />
        )}
        <ProductThumb
          src={photo}
          alt={name}
          itemType={line.item_type}
          size={null}
          className="h-14 w-14 shrink-0 rounded-md"
          onAddImage={showAddImage ? onAddImage : undefined}
          uploading={showAddImage ? uploading : undefined}
        />
        <div className="min-w-0 flex-1">
          <p className="break-words font-semibold leading-tight text-text-primary">{name}</p>
          {showOptionalToggle && line.is_optional && (
            <span
              data-testid="optional-state-tag"
              className="mt-1 inline-block rounded-full bg-background-light px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-secondary"
            >
              {optionalTag}
            </span>
          )}
          <ClampedDescription text={detail} lines={2} className="mt-1" />
        </div>
      </div>

      <div className="mt-2 divide-y divide-border border-t border-border">
        <Field label="Quantity" htmlFor={id('qty')}>
          {canEdit ? (
            <Input
              id={id('qty')}
              kind="quantity"
              min={0.01}
              step={0.01}
              value={f.qty}
              disabled={busy}
              onChange={(e) => f.setQty(e.target.value)}
              onBlur={f.commitQty}
              onKeyDown={(e) => e.key === 'Enter' && f.commitQty()}
              className="w-28 text-right tabular-nums"
              aria-label={`Quantity for ${name}`}
            />
          ) : (
            <span className="tabular-nums">{toNum(line.quantity)}</span>
          )}
        </Field>

        {canSeePricing && (
          <Field label="Cost" htmlFor={id('cost')}>
            {canEdit ? (
              <Input
                id={id('cost')}
                kind="money"
                min={0}
                step={0.01}
                value={f.cost}
                disabled={busy}
                onChange={(e) => f.setCost(e.target.value)}
                onBlur={f.commitCost}
                onKeyDown={(e) => e.key === 'Enter' && f.commitCost()}
                className="w-28 text-right tabular-nums"
                aria-label={`Cost for ${name}`}
              />
            ) : (
              <span className="tabular-nums">
                {line.unit_cost != null ? formatCurrency(toNum(line.unit_cost)) : '-'}
              </span>
            )}
          </Field>
        )}

        <div>
          <Field label="Selling price" htmlFor={id('price')}>
            {canEdit ? (
              <Input
                id={id('price')}
                kind="money"
                min={0}
                step={0.01}
                value={f.price}
                disabled={busy}
                onChange={(e) => f.setPrice(e.target.value)}
                onBlur={f.commitPrice}
                onKeyDown={(e) => e.key === 'Enter' && f.commitPrice()}
                className="w-28 text-right tabular-nums"
                aria-label={`Selling price for ${name}`}
              />
            ) : (
              <span className="tabular-nums">{formatCurrency(toNum(line.unit_price))}</span>
            )}
          </Field>
          {canSeePricing && profitability.state !== 'invalid-price' && (
            // A wrapper carries the group role and name: a <dl> must hold only term/description
            // groups, and a role on the <dl> itself breaks that (axe `dlitem`).
            <div role="group" aria-label={`Profitability for ${name}`} className="pb-2">
              <dl className="flex justify-end gap-4">
                {[
                  { word: 'Margin', value: profitability.marginPercent },
                  { word: 'Markup', value: profitability.markupPercent },
                ].map(({ word, value }) => (
                  <div key={word} className="text-right">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">{word}</dt>
                    <dd className="text-xs font-medium tabular-nums text-text-secondary">
                      {formatProfitabilityPercent(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>

        {showDiscount && (
          <Field label="Discount">
            {canEdit ? (
              <>
                <Select value={f.discountType || 'NONE'} disabled={busy} onValueChange={f.changeDiscountType}>
                  <SelectTrigger className="w-24" aria-label={`Discount type for ${name}`}>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">None</SelectItem>
                    <SelectItem value="PERCENTAGE">%</SelectItem>
                    <SelectItem value="FIXED_AMOUNT">$</SelectItem>
                  </SelectContent>
                </Select>
                {f.discountType && (
                  <Input
                    kind="money"
                    min={0}
                    step={0.01}
                    value={f.discountValue}
                    disabled={busy}
                    onChange={(e) => f.setDiscountValue(e.target.value)}
                    onBlur={() => f.commitDiscount(f.discountType, f.discountValue)}
                    onKeyDown={(e) => e.key === 'Enter' && f.commitDiscount(f.discountType, f.discountValue)}
                    className="w-24 text-right tabular-nums"
                    aria-label={`Discount value for ${name}`}
                  />
                )}
              </>
            ) : toNum(line.discount_amount) > 0 ? (
              <span className="text-sm tabular-nums text-text-secondary">
                -{formatCurrency(toNum(line.discount_amount))}
              </span>
            ) : (
              <span className="text-sm text-text-secondary">-</span>
            )}
          </Field>
        )}

        <Field label="Taxable" htmlFor={id('taxable')}>
          {canEdit ? (
            <Switch
              id={id('taxable')}
              checked={line.is_taxable}
              disabled={busy}
              onCheckedChange={(v) => onUpdate({ is_taxable: v })}
              aria-label={`Taxable for ${name}`}
            />
          ) : (
            <span className="text-sm text-text-secondary">{line.is_taxable ? 'Yes' : '-'}</span>
          )}
        </Field>

        <div className="flex min-h-11 items-center justify-between gap-3">
          {canManage && (
            <Button
              type="button"
              variant="ghost"
              tone="danger"
              size="sm"
              onClick={handleDelete}
              disabled={busy}
              className="-ml-3 shrink-0"
              aria-label={`Remove ${name}`}
            >
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          )}
          <span className="ml-auto flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-semibold text-text-primary">Total</span>
            <span data-testid="line-card-total" className="text-base font-bold tabular-nums text-text-primary">
              {formatCurrency(effectiveTotal)}
            </span>
          </span>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}
