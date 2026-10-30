/**
 * Which lines the staff invoice page prints (payments go-live slice 35, from the slice 24 rule in
 * 00-run-decisions.md): never a line that is outside the invoice's total.
 *
 *  1. The invoice's own lines win.
 *  2. An invoice with scope blocks and no own lines prints the scope blocks only - the estimate's lines are NOT
 *     brought in beside them.
 *  3. Only a legacy job invoice with neither falls back to its estimate's lines.
 */
export function invoiceDisplayLines<T extends { sequence: number }>(
  ownLines: readonly T[],
  scopes: readonly unknown[] | null | undefined,
  estimateLines: readonly T[],
): T[] {
  const source = ownLines.length > 0 ? ownLines : (scopes?.length ?? 0) > 0 ? [] : estimateLines;
  return [...source].sort((a, b) => a.sequence - b.sequence);
}
