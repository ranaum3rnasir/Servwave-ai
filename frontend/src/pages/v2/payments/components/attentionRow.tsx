import { Link, useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';

import type { AttentionItem } from '@/lib/api/paymentsPage';
import { formatInstant } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';

import { useDrawerHost } from '../drawerHost';
import { serializeStack, stackForItem } from '../drawerStack';
import { timeLeft } from '../timeLeft';
import { CustomerIdLink } from './CustomerIdLink';

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

/** The query string that results from changing the page's current one; the frame's keys survive. */
export function useHrefWith() {
  const [params] = useSearchParams();
  return (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    return `?${next.toString()}`;
  };
}

/**
 * The item's title: a link to what it opens when it opens something (its Payment, Payout or Dispute, with the item on top
 * when it has its own view), plain text otherwise. A plain click opens the page's drawer; the address is `?d=...`, so a
 * new-tab click or a copied link opens the same stack.
 */
export function ItemTitle({ item, className }: { item: AttentionItem; className?: string }) {
  const hrefWith = useHrefWith();
  const host = useDrawerHost();
  const views = stackForItem(item);
  if (!views) return <span className={className}>{item.title}</span>;
  return (
    <Link
      to={hrefWith({ d: serializeStack(views) })}
      className={`text-text-primary font-semibold hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center ${className ?? ''}`}
      onClick={(event) => {
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        host.open(views);
      }}
    >
      {item.title}
    </Link>
  );
}

/** The dispute deadline, "Respond by Oct 20, 2026 (6 days left)"; under 48 hours the time left is red and bold. */
function RespondBy({ item, timeZone, now }: { item: AttentionItem; timeZone: string; now: number }) {
  const left = timeLeft(item.respond_by, now);
  return (
    <>
      Respond by {formatInstant(item.respond_by!, timeZone, DAY)}
      {left && (
        <>
          {' ('}
          <span className={left.urgent ? 'text-destructive font-bold' : undefined}>{left.text}</span>
          {')'}
        </>
      )}
    </>
  );
}

const isUnapplied = (item: AttentionItem) => item.type === 'unmatched_payment' || item.type === 'unmatched_refund';

/**
 * The line under an item's title, parts joined by " · ", any part the data lacks left out (never a placeholder):
 * dispute "customer · ID · invoice · amount · Respond by {date} ({time left})"; payout "Payout {ref} · amount · detail";
 * unapplied money "customer · ID · amount · Meant for {invoice} · detail"; failed payment and refund
 * "customer · ID · invoice · amount · detail". A restricted item names no one.
 */
/** `now` is the page's minute clock, so the deadline text and the row's tile colour always agree. */
export function SecondaryLine({ item, timeZone, now }: { item: AttentionItem; timeZone: string; now: number }) {
  const amount = item.amount == null ? null : formatCurrency(item.amount);
  const parts: React.ReactNode[] = [];
  if (item.type === 'failed_payout') {
    // The payout is named by the same short reference the payouts list shows; only an item without one falls back to its date.
    parts.push(item.payout_reference ? `Payout ${item.payout_reference}` : `Payout of ${formatInstant(item.date, timeZone, SHORT_DAY)}`);
  } else if (item.restricted) {
    parts.push(<Restricted key="customer" />, <Restricted key="invoice" />);
  } else {
    if (item.customer) {
      parts.push(item.customer.name);
      if (item.customer.customer_number) parts.push(<CustomerIdLink key="cid" customer={item.customer} />);
    }
    if (item.invoice) parts.push(isUnapplied(item) ? `Meant for ${item.invoice.number}` : item.invoice.number);
  }
  if (amount) {
    // Unapplied money names its amount before the invoice it was meant for.
    const at = isUnapplied(item) && item.invoice && !item.restricted ? parts.length - 1 : parts.length;
    parts.splice(at, 0, amount);
  }
  if (item.type === 'dispute' && item.respond_by) parts.push(<RespondBy key="by" item={item} timeZone={timeZone} now={now} />);
  else if (item.detail) parts.push(item.detail);
  // Plain words stay one text node; only a restricted item, a customer ID or a deadline mixes in markup.
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
