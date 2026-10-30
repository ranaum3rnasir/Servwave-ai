import type { AttentionItem } from '@/lib/api/paymentsPage';

/**
 * The Payments drawer is one host showing the top view of a stack (V7-07). The stack lives in one query param, `d`:
 * comma-separated, bottom first, each entry `{kind}:{id}`. An item's id is its attention key, which has a colon of its
 * own (`item:failed_payment:{uuid}`), so an entry splits on its FIRST colon only.
 */
export type DrawerKind = 'payment' | 'payout' | 'dispute' | 'respond' | 'item';
export interface DrawerView {
  kind: DrawerKind;
  id: string;
}

export const MAX_DEPTH = 4;
export const STACK_PARAM = 'd';
/** The addresses used before the stack existed; they are read, then rewritten as `d`. */
export const LEGACY_KEYS = ['payment', 'payout', 'dispute'] as const;

const KINDS: ReadonlySet<string> = new Set<DrawerKind>(['payment', 'payout', 'dispute', 'respond', 'item']);
const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;

export const viewKey = (v: DrawerView) => `${v.kind}:${v.id}`;
const same = (a: DrawerView, b: DrawerView) => a.kind === b.kind && a.id === b.id;

function clean(views: DrawerView[]): DrawerView[] {
  const out: DrawerView[] = [];
  for (const v of views) {
    if (!KINDS.has(v.kind) || !v.id || !SAFE_ID.test(v.id) || out.some((o) => same(o, v))) continue;
    out.push(v);
    if (out.length === MAX_DEPTH) break;
  }
  return out;
}

export function serializeStack(stack: DrawerView[]): string {
  return stack.map(viewKey).join(',');
}

/** The stack the address describes. `legacy` is true when it came from the old params (the host then rewrites the address). */
export function parseStack(params: URLSearchParams): { stack: DrawerView[]; legacy: boolean } {
  const raw = params.get(STACK_PARAM);
  if (raw != null) {
    const views: DrawerView[] = [];
    for (const entry of raw.split(',')) {
      const at = entry.indexOf(':');
      if (at < 1) continue;
      views.push({ kind: entry.slice(0, at) as DrawerKind, id: entry.slice(at + 1) });
    }
    return { stack: clean(views), legacy: false };
  }
  const legacy: DrawerView[] = [];
  const payout = params.get('payout');
  const payment = params.get('payment');
  const dispute = params.get('dispute');
  if (payout) legacy.push({ kind: 'payout', id: payout });
  if (payment) legacy.push({ kind: 'payment', id: payment });
  if (dispute) legacy.push({ kind: 'dispute', id: dispute });
  const stack = clean(legacy);
  return { stack, legacy: stack.length > 0 };
}

/** Push views on top. A view already in the stack cuts the stack back to it; a push past the depth cap is ignored. */
export function pushOnto(stack: DrawerView[], views: DrawerView[]): DrawerView[] {
  let out = stack;
  for (const v of views) {
    const at = out.findIndex((o) => same(o, v));
    if (at > -1) out = out.slice(0, at + 1);
    else if (out.length < MAX_DEPTH) out = [...out, v];
  }
  return out;
}

const ITEM_LABEL: Record<string, string> = {
  failed_payment: 'Failed payment',
  failed_refund: 'Failed refund',
  failed_payout: 'Failed payout',
  unmatched_payment: 'Unapplied payment',
  unmatched_refund: 'Unapplied refund',
};

/** What the Back button under a view says ("Back to Payment"). */
export function viewLabel(v: DrawerView): string {
  switch (v.kind) {
    case 'payment': return 'Payment';
    case 'payout': return 'Payout';
    case 'dispute': return 'Dispute';
    case 'respond': return 'Respond';
    default: return ITEM_LABEL[v.id.slice(0, v.id.indexOf(':'))] ?? 'Item';
  }
}

/**
 * What opening an attention item from outside shows: its Payment (or Payout) first so Back is always useful, then the
 * item itself; a dispute is its Payment, then the Dispute (then Respond for the Respond action). Unapplied money has no
 * payment underneath: the item is the whole stack. An item with nothing to open (a restricted one) is null.
 */
export function stackForItem(item: AttentionItem, { respond = false }: { respond?: boolean } = {}): DrawerView[] | null {
  if (item.restricted) return null;
  if (item.type === 'dispute') {
    if (!item.dispute_id) return null;
    const views: DrawerView[] = [];
    if (item.payment_id) views.push({ kind: 'payment', id: item.payment_id });
    views.push({ kind: 'dispute', id: item.dispute_id });
    if (respond) views.push({ kind: 'respond', id: item.dispute_id });
    return views;
  }
  if (item.type === 'failed_payment' || item.type === 'failed_refund') {
    return item.payment_id ? [{ kind: 'payment', id: item.payment_id }, { kind: 'item', id: item.key }] : null;
  }
  if (item.type === 'unmatched_payment' || item.type === 'unmatched_refund') return [{ kind: 'item', id: item.key }];
  if (item.type === 'failed_payout') {
    return item.payout_id ? [{ kind: 'payout', id: item.payout_id }, { kind: 'item', id: item.key }] : null;
  }
  return null;
}

/**
 * The stack with one dispute's Respond view taken off: what a finished or refused Respond leaves on screen. The Dispute
 * it answers stays (or is put there when the address held Respond alone), so the person lands on the dispute, not on
 * nothing.
 */
export function withoutRespond(stack: DrawerView[], disputeId: string): DrawerView[] {
  const at = stack.findIndex((v) => v.kind === 'respond' && v.id === disputeId);
  const below = at < 0 ? stack : stack.slice(0, at);
  const top = below.at(-1);
  return top && top.kind === 'dispute' && top.id === disputeId ? below : pushOnto(below, [{ kind: 'dispute', id: disputeId }]);
}
