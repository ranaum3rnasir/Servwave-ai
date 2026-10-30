import type { AttentionItem, AttentionType } from '@/lib/api/paymentsPage';

/** Rows the Needs-attention card shows; the rest is one click away in the table. */
export const CARD_ROWS = 6;
/** Open items the card (and the tab's counts, in the same request) fetch; the server's own maximum. */
export const ATTENTION_FETCH_LIMIT = 50;

const KIND_ORDER: AttentionType[] = ['dispute', 'failed_payment', 'failed_refund', 'failed_payout', 'unmatched_payment', 'unmatched_refund'];
const rank = (type: AttentionType) => KIND_ORDER.indexOf(type);

/**
 * The card's rows: the single most urgent item of each kind (kinds in a fixed order; disputes by soonest deadline, the
 * others newest first), then everything else in the same order, cut at {@link CARD_ROWS}. So six different problems
 * are never hidden behind six of the same one.
 */
export function arrangeCardItems(items: readonly AttentionItem[]): AttentionItem[] {
  const sorted = [...items].sort((x, y) => {
    const byKind = rank(x.type) - rank(y.type);
    if (byKind !== 0) return byKind;
    if (x.type === 'dispute') return (x.respond_by ?? '') < (y.respond_by ?? '') ? -1 : 1;
    return x.date < y.date ? 1 : -1;
  });
  const seen = new Set<AttentionType>();
  const first: AttentionItem[] = [];
  const rest: AttentionItem[] = [];
  for (const item of sorted) {
    if (seen.has(item.type)) rest.push(item);
    else {
      seen.add(item.type);
      first.push(item);
    }
  }
  return [...first, ...rest].slice(0, CARD_ROWS);
}
