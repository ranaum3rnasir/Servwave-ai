import { TableCell, type TableCellProps } from '@/ui-kit/components/ui/table';

/**
 * A table cell whose call-site presentation lives INSIDE the cell.
 *
 * The kit's `TableCell` has no alignment, weight or tone prop, so every report
 * that wanted a right-aligned number or a muted caption was reaching past the
 * primitive and setting those classes on it directly - 60 call sites across six
 * files, and exactly what the component-API ratchet exists to stop: appearance
 * decided at the call site rather than by the component.
 *
 * This puts them on a block wrapper inside the cell instead. `text-right` still
 * aligns (the wrapper is a block and fills the cell), and `TableCell` itself
 * goes back to carrying nothing. Structural props - `colSpan`, `padding`,
 * `pinned` - forward to the real cell, where they belong.
 */
export function Td({ className, children, ...props }: TableCellProps) {
  return (
    <TableCell {...props}>
      {className ? <div className={className}>{children}</div> : children}
    </TableCell>
  );
}
