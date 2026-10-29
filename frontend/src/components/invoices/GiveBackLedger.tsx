import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The "what has already been given back on this invoice" table.
 *
 * One component because there was one table drawn twice: `CreditInvoiceDialog`
 * and `RefundInvoiceDialog` each carried their own copy of this markup, and the
 * copies had drifted - different column sets, a green amount in one and a red
 * one in the other, a lone `-` prefix that only the refund copy rendered. Two
 * dialogs a click apart on the same invoice looked like two different products,
 * which is the complaint this file answers.
 *
 * The columns arrive as data so the two dialogs can name their own third
 * column ("Category" for a credit, "Method" for a refund) without the table
 * branching on which caller it has.
 */

/**
 * U+2014 EM DASH, the empty-cell placeholder both ledgers render. Written as an
 * escape because CLAUDE.md forbids the literal character in source; it is
 * CONTENT here, not prose, and a hyphen in a money column reads as a minus.
 */
export const EMPTY = '\u2014';

/**
 * U+2212 MINUS SIGN, prefixing a refunded amount. The typographic minus, not a
 * hyphen: it is the same width and height as the digits beside it, which a
 * hyphen in a tabular-nums column is not.
 */
export const MINUS = '\u2212';

export interface LedgerColumn<T> {
  key: string;
  label: string;
  /** Right-aligned + tabular, for the money column. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
}

export function GiveBackLedger<T extends { id: string }>({
  rows, columns,
}: {
  rows: T[];
  columns: LedgerColumn<T>[];
}) {
  if (rows.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="bg-background-light">
          <tr className="text-left text-text-secondary">
            {columns.map((col) => (
              <th key={col.key} className={cn('px-2 py-1.5 font-medium', col.numeric && 'text-right')}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((col) => (
                <td key={col.key} className={cn('px-2 py-1.5', col.numeric && 'text-right tabular-nums')}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
