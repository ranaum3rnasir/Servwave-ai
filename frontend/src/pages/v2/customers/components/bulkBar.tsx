import { BulkTagPopover } from '@/components/customers/BulkTagPopover';
import { BulkActionBar } from '@/ui-kit/components/crm/bulkActionBar';

/**
 * The list's bulk-selection strip.
 *
 * Presentation only. The selection itself lives on the page in
 * `useScopedRowSelection` - the legacy list's own hook - and reaches the table
 * through `rowSelection`/`onRowSelectionChange`, so the "a selection only makes
 * sense against the CURRENT page, sort and filter" rule is enforced where the
 * state is held rather than by an effect reaching into the table instance.
 */
export function BulkBar({
  selectedIds, onClear, canTag,
}: {
  selectedIds: string[];
  onClear: () => void;
  canTag: boolean;
}) {
  if (selectedIds.length === 0) return null;

  return (
    <BulkActionBar
      count={selectedIds.length}
      noun={['customer', 'customers']}
      onClear={onClear}
    >
      {canTag && <BulkTagPopover customerIds={selectedIds} onDone={onClear} />}
    </BulkActionBar>
  );
}
