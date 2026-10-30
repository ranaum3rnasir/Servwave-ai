import { Link, useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';

import type { AttentionItem } from '@/lib/api/paymentsPage';
import { formatInstant } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';

const SHORT_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

export function Restricted() {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5">
      <Lock className="size-3.5" aria-hidden />
      Restricted
    </span>
  );
}

/** Where an item's title leads: its payment drawer, its payout drawer, or nowhere (unmatched money has no drawer). */
export function itemTarget(item: AttentionItem): Record<string, string> | null {
  if (item.restricted) return null;
  if (item.payment_id) return { tab: 'payments', payment: item.payment_id };
  if (item.payout_id) return { tab: 'payouts', payout: item.payout_id };
  return null;
}

/** The query string that results from changing the page's current one; the frame's keys survive. */
export function useHrefWith() {
  const [params] = useSearchParams();
  return (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    return `?${next.toString()}`;
  };
}

/** The item's title: a link to its drawer when it has one, plain text otherwise. */
export function ItemTitle({ item, className }: { item: AttentionItem; className?: string }) {
  const hrefWith = useHrefWith();
  const target = itemTarget(item);
  if (!target) return <span className={className}>{item.title}</span>;
  return (
    <Link
      to={hrefWith(target)}
      className={`text-brand hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center ${className ?? ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      {item.title}
    </Link>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "{customer} · {invoice} · {amount} · {detail}", with the dispute and payout variants. A restricted item names no one. */
export function SecondaryLine({ item, timeZone }: { item: AttentionItem; timeZone: string }) {
  const amount = item.amount == null ? null : formatCurrency(item.amount);
  const parts: React.ReactNode[] = [];
  if (item.type === 'failed_payout') {
    // The payout is named by the same short reference the payouts list shows; only an item without one falls back to its date.
    parts.push(item.payout_reference ? `Payout ${item.payout_reference}` : `Payout of ${formatInstant(item.date, timeZone, SHORT_DAY)}`);
  } else if (item.restricted) {
    parts.push(<Restricted key="customer" />, <Restricted key="invoice" />);
  } else {
    if (item.customer) parts.push(item.customer.name);
    if (item.invoice) parts.push(item.invoice.number);
  }
  if (amount) parts.push(amount);
  if (item.type === 'dispute' && item.respond_by) {
    const left = item.days_left == null ? '' : ` (${plural(Math.max(0, item.days_left), 'day')} left)`;
    parts.push(`Respond by ${formatInstant(item.respond_by, timeZone, DAY)}${left}`);
  } else if (item.detail) {
    parts.push(item.detail);
  }
  // Plain words stay one text node; only a restricted item mixes in the lock.
  if (parts.every((part) => typeof part === 'string')) return <>{parts.join(' · ')}</>;
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {part}
        </span>
      ))}
    </>
  );
}
