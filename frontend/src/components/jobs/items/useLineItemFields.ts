/**
 * useLineItemFields - the draft text and commit rules of one line's editable money fields
 * (quantity, cost, selling price, discount), shared by the table row (`LineItemRow`, md and up)
 * and the phone card (`LineItemCard`, below md) so the two layouts cannot disagree about what a
 * blur or an Enter saves.
 *
 * Numbers commit on blur or Enter and only when they changed and are valid (quantity above zero,
 * money not negative); the discount type commits through `commitDiscount`. Each draft re-syncs
 * when the server's value for the line changes (one field per render pass; React re-renders
 * until they all agree). Mutations are owned by the parent: this hook only
 * calls `onUpdate`.
 */
import { useState } from 'react';
import { toNum } from './money';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import type { UpdateLineItemPayload } from '@/lib/api/invoices';

// #2053 slice 1 - is_selected is estimate-only; widened locally rather than the shared payload
// type (same precedent as AddLineDialog.tsx's LineUpdatePatch).
export type RowUpdatePatch = UpdateLineItemPayload & { is_selected?: boolean };

export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT' | '';

/** First line of the description is the item name; the rest is detail. */
export function splitDescription(description: string): { name: string; detail: string } {
  const parts = description.split('\n');
  return { name: parts[0] || '', detail: parts.slice(1).join('\n') };
}

export function useLineItemFields(line: InvoiceLineItem, onUpdate: (patch: RowUpdatePatch) => void) {
  const [qty, setQty] = useState(String(toNum(line.quantity)));
  const [price, setPrice] = useState(String(toNum(line.unit_price)));
  const [cost, setCost] = useState(line.unit_cost != null ? String(toNum(line.unit_cost)) : '');
  const [discountType, setDiscountType] = useState<DiscountType>(line.discount_type ?? '');
  const [discountValue, setDiscountValue] = useState(
    line.discount_value != null ? String(toNum(line.discount_value)) : '',
  );

  // Re-sync a draft when the server's value for that field changes. Done while rendering (React's
  // "adjust state when a prop changes" pattern) rather than in an effect, so a changed value never
  // paints one frame with the stale draft.
  const [seen, setSeen] = useState({
    quantity: line.quantity,
    unit_price: line.unit_price,
    unit_cost: line.unit_cost,
    discount_type: line.discount_type,
    discount_value: line.discount_value,
  });
  if (seen.quantity !== line.quantity) {
    setSeen({ ...seen, quantity: line.quantity });
    setQty(String(toNum(line.quantity)));
  } else if (seen.unit_price !== line.unit_price) {
    setSeen({ ...seen, unit_price: line.unit_price });
    setPrice(String(toNum(line.unit_price)));
  } else if (seen.unit_cost !== line.unit_cost) {
    setSeen({ ...seen, unit_cost: line.unit_cost });
    setCost(line.unit_cost != null ? String(toNum(line.unit_cost)) : '');
  } else if (seen.discount_type !== line.discount_type) {
    setSeen({ ...seen, discount_type: line.discount_type });
    setDiscountType(line.discount_type ?? '');
  } else if (seen.discount_value !== line.discount_value) {
    setSeen({ ...seen, discount_value: line.discount_value });
    setDiscountValue(line.discount_value != null ? String(toNum(line.discount_value)) : '');
  }

  const commitQty = () => {
    const n = parseFloat(qty);
    if (!isNaN(n) && n > 0 && n !== toNum(line.quantity)) onUpdate({ quantity: n });
  };
  const commitPrice = () => {
    const n = parseFloat(price);
    if (!isNaN(n) && n >= 0 && n !== toNum(line.unit_price)) onUpdate({ unit_price: n });
  };
  const commitCost = () => {
    const n = parseFloat(cost);
    if (!isNaN(n) && n >= 0 && n !== toNum(line.unit_cost)) onUpdate({ unit_cost: n });
  };
  const commitDiscount = (type: DiscountType, value: string) => {
    if (!type) {
      if (line.discount_type != null) onUpdate({ discount_type: null, discount_value: null });
      return;
    }
    const n = parseFloat(value);
    if (isNaN(n) || n <= 0) return;
    onUpdate({ discount_type: type, discount_value: n });
  };
  /** The discount type Select: picking None clears the value and the saved discount. */
  const changeDiscountType = (v: string) => {
    const next = (v === 'NONE' ? '' : v) as DiscountType;
    setDiscountType(next);
    if (!next) {
      setDiscountValue('');
      commitDiscount('', '');
    }
  };

  return {
    qty, setQty, commitQty,
    price, setPrice, commitPrice,
    cost, setCost, commitCost,
    discountType, discountValue, setDiscountValue, commitDiscount, changeDiscountType,
  };
}
