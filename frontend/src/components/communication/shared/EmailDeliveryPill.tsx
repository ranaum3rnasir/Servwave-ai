/**
 * Email delivery pill (email slice 5) — the one place an outbound email's
 * Resend delivery verdict gets painted. Routes entirely through the
 * `messageDelivery` status-registry domain + StatusBadge (design-system/
 * status-registry.ts) rather than a parallel deliveryNote()/tone system: the
 * registry already owns "what does this state mean, visually" for every other
 * domain in the app, and a delivery lifecycle is exactly that kind of state.
 *
 * Used wherever a sent Email's delivery fact needs to render: the Inbox
 * thread (InboxPage's ReadingPane), the Job/Customer/Lead Communication tabs
 * (CommRow), and the Invoice/Estimate pages' own send-status checks.
 *
 * NEVER renders an "Opened" claim — see the `messageDelivery` domain's own
 * doc comment in status-registry.ts for why (Apple Mail Privacy Protection
 * prefetches images for ~half of recipients). There is structurally nothing
 * to render as that claim: EmailDeliveryStatus has no OPENED value, and this
 * component only ever renders a value the registry maps.
 */
import { StatusBadge } from '@/components/data/status-badge';

export interface EmailDeliveryPillProps {
  /** Email.deliveryStatus / CommItem.deliveryStatus — absent means nothing
   *  has ever reported on this row (predates the webhook, or it hasn't fired
   *  yet). The pill renders nothing in that case, same as every other
   *  omit-if-null field on these two contracts. */
  status?: string;
  /** Email.deliveryStatusReason / CommItem.deliveryStatusReason — the
   *  provider's own words (bounce description, rejection message), shown as
   *  a tooltip when present. */
  reason?: string;
  className?: string;
}

export function EmailDeliveryPill({ status, reason, className }: EmailDeliveryPillProps) {
  if (!status) return null;
  return (
    <span title={reason || undefined} className={className}>
      <StatusBadge domain="messageDelivery" status={status} />
    </span>
  );
}
