import { Download, PackagePlus } from 'lucide-react';

import { BulkActionBar } from '@/ui-kit/components/crm/bulkActionBar';
import { Button } from '@/ui-kit/components/ui/button';

/**
 * The Stock grid's bulk-selection strip.
 *
 * Two actions, and the gates are different because the operations are:
 *
 *   - Export selected is ungated, like the toolbar Export beside it. It reads
 *     rows already on screen and writes a file; there is nothing to authorise.
 *   - Restock writes stock. It is gated on `update Inventory`, which is exactly
 *     what `POST /api/inventory/bulk-restock` enforces server-side
 *     (`canDo('update','Inventory')` in `inv-catalog.routes.ts`), so the button
 *     is absent for anyone the API would 403 rather than present and failing.
 *
 * The selection lives on the page in `useScopedRowSelection` and reaches the
 * table as `rowSelection`/`onRowSelectionChange`.
 */
export function StockBulkBar({
  count, canRestock, onClear, onExportSelected, onRestock,
}: {
  count: number;
  canRestock: boolean;
  onClear: () => void;
  onExportSelected: () => void;
  onRestock: () => void;
}) {
  if (count === 0) return null;

  return (
    <BulkActionBar count={count} noun={['item', 'items']} onClear={onClear}>
      <Button variant="outline" size="sm" onClick={onExportSelected}>
        <Download />
        Export selected
      </Button>
      {canRestock && (
        <Button variant="outline" size="sm" onClick={onRestock}>
          <PackagePlus />
          Restock
        </Button>
      )}
    </BulkActionBar>
  );
}
