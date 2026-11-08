/**
 * LineItemsTable's real dnd-kit drag path (handleDragEnd), unit-tested via its extracted pure
 * core, resolveDragReorder. The existing job-items-editor.test.tsx / invoice-line-items-editor.
 * test.tsx reorder coverage only exercises the Move-down keyboard-fallback button — it never
 * drives handleDragEnd itself, so the cross-group-drop-rejection guard (item_type is immutable
 * per line; a MATERIAL row dropped onto a SERVICE row must no-op) had zero coverage.
 *
 * Simulating a real dnd-kit pointer drag through DndContext in jsdom requires layout measurement
 * (getBoundingClientRect) dnd-kit relies on and that jsdom doesn't provide — there is no existing
 * precedent for it anywhere in this repo's test suite (grep for DragEndEvent/DndContext in
 * src/**\/*.test.tsx turns up nothing). So instead of fighting jsdom, resolveDragReorder was
 * extracted out of the component as the pure, independently-testable core of handleDragEnd —
 * these tests invoke it directly with fabricated DragEndEvent-shaped ({ active, over }) inputs,
 * exercising the SAME group-lookup + cross-group guard code the real DndContext's onDragEnd
 * calls (LineItemsTable.tsx's handleDragEnd is now a two-line wrapper around this function).
 */
import { describe, it, expect } from 'vitest';
import { resolveDragReorder } from '@/components/jobs/items/LineItemsTable';
import type { InvoiceLineItem } from '@/lib/api/jobs';

function line(over: Partial<InvoiceLineItem> & { id: string }): InvoiceLineItem {
  return {
    sequence: 1,
    description: 'Item',
    quantity: 1,
    unit_price: 100,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 100,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    ...over,
  };
}

describe('resolveDragReorder (LineItemsTable handleDragEnd core)', () => {
  it('a same-group drag reorder proceeds: dropping SERVICE s1 onto SERVICE s2 swaps them, and the interleaved MATERIAL line stays in its original relative position', () => {
    const lines = [
      line({ id: 's1', item_type: 'SERVICE' }),
      line({ id: 'm1', item_type: 'MATERIAL' }),
      line({ id: 's2', item_type: 'SERVICE' }),
    ];

    const result = resolveDragReorder(lines, { active: { id: 's1' }, over: { id: 's2' } });

    // s1/s2 (the SERVICE group) swap; m1 (untouched MATERIAL group) keeps its original slot —
    // this is the full top-to-bottom id list the backend reorder endpoint validates against.
    expect(result).toEqual(['s2', 'm1', 's1']);
  });

  it('a cross-group drop (active in MATERIAL, over in SERVICE) is REJECTED as a no-op — returns null', () => {
    const lines = [
      line({ id: 'm1', item_type: 'MATERIAL' }),
      line({ id: 's1', item_type: 'SERVICE' }),
      line({ id: 's2', item_type: 'SERVICE' }),
    ];

    const result = resolveDragReorder(lines, { active: { id: 'm1' }, over: { id: 's1' } });

    expect(result).toBeNull();
  });

  it('a cross-group drop the OTHER direction (active in SERVICE, over in MATERIAL) is also rejected', () => {
    const lines = [
      line({ id: 'm1', item_type: 'MATERIAL' }),
      line({ id: 'm2', item_type: 'MATERIAL' }),
      line({ id: 's1', item_type: 'SERVICE' }),
    ];

    const result = resolveDragReorder(lines, { active: { id: 's1' }, over: { id: 'm2' } });

    expect(result).toBeNull();
  });

  it('dropping a line onto itself is a no-op — returns null', () => {
    const lines = [line({ id: 's1' }), line({ id: 's2' })];

    const result = resolveDragReorder(lines, { active: { id: 's1' }, over: { id: 's1' } });

    expect(result).toBeNull();
  });

  it('no drop target (dragged outside any droppable) is a no-op — returns null', () => {
    const lines = [line({ id: 's1' }), line({ id: 's2' })];

    const result = resolveDragReorder(lines, { active: { id: 's1' }, over: null });

    expect(result).toBeNull();
  });
});
