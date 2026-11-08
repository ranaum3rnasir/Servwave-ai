import { Download } from 'lucide-react';

import { BulkActionBar } from '@/ui-kit/components/crm/bulkActionBar';
import { Button } from '@/ui-kit/components/ui/button';

/**
 * A bulk-selection strip whose only action is Export selected.
 *
 * Shared by the price book, the three purchase-order grids and vendor spend -
 * four tables in this one module whose bulk affordance is identical, because
 * the backend offers them nothing else. `PriceBookItem`, `PurchaseOrder` and
 * `Vendor` have no `bulk-*` route of any kind (the nine that exist belong to
 * customers, estimates, invoices and jobs), so anything write-shaped here
 * would be a button with nothing behind it. Export needs no backend: the rows
 * are already in hand.
 *
 * The Stock grid does NOT use this - it has a second, real action (bulk
 * restock) and its own gate, so it keeps `stockBulkBar.tsx`.
 *
 * `noun` is a prop rather than a constant precisely so this stays module-
 * agnostic per table: "3 purchase orders selected", "3 vendors selected".
 */
export function ExportBulkBar({
  count, noun, onClear, onExportSelected,
}: {
  count: number;
  /** Singular/plural, e.g. ['purchase order', 'purchase orders']. */
  noun: [string, string];
  onClear: () => void;
  onExportSelected: () => void;
}) {
  if (count === 0) return null;

  return (
    <BulkActionBar count={count} noun={noun} onClear={onClear}>
      <Button variant="outline" size="sm" onClick={onExportSelected}>
        <Download />
        Export selected
      </Button>
    </BulkActionBar>
  );
}
