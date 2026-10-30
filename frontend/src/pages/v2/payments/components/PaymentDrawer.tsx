import { useState } from 'react';

import {
  netAfterRefunds, useAttention, usePaymentDetail, type AttentionItem, type PaymentRow,
} from '@/lib/api/paymentsPage';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import {
  DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm,
} from '@/ui-kit/components/data/descriptionList';
import { Timeline, TimelineContent, TimelineItem, TimelineTime } from '@/ui-kit/components/data/timeline';
import { Button } from '@/ui-kit/components/ui/button';
import { SheetFooter } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { StatusChip } from '../../_shared/statusChip';
import { DrawerBody, DrawerCloseButton, DrawerHeaderBar, useDrawerHost } from '../drawerHost';
import { timeLeft, useNow } from '../timeLeft';
import { AttentionActions, visibleActions } from './attentionActions';
import { CustomerBlock } from './CustomerBlock';
import { RefundPaymentDialog } from './RefundPaymentDialog';

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const PAID_OUT = /^Paid out in (PO-[A-Z0-9]+)$/;

const minus = (n: number) => (n === 0 ? formatCurrency(0) : formatCurrency(-Math.abs(n)));

/** "NEEDS_RESPONSE" -> "needs response" */
const words = (status: string) => status.toLowerCase().replace(/_/g, ' ');

const DEADLINE: Intl.DateTimeFormatOptions = { ...DAY, hour: 'numeric', minute: '2-digit' };

/**
 * The open items that belong to the payment, asked for by that payment (the server links an item to its payment), so
 * they come back however long the open backlog is. They sit in the footer at the footer's own button size.
 */
function useDrawerItems(paymentId: string) {
  const { data } = useAttention('open', { limit: 50, payment_id: paymentId });
  return (data?.items ?? []).filter((item) => item.payment_id === paymentId);
}

/** Respond is the footer's own "Respond to dispute" here, so an item's Respond is left out of its actions. */
const OMIT_RESPOND = ['respond' as const];
const hasActions = (item: AttentionItem) => visibleActions(item).some((a) => a !== 'respond');

/**
 * One payment, as a view of the drawer host (payments go-live P6, V7-07). The list row (a seed from the opener) shows at
 * once; the detail (timeline, alerts, what the caller may do) fills in when it arrives.
 *
 * A caller who may do nothing here sees only Close: the buttons come from the detail's flags, never from a role check.
 * The footer carries the payment's open items' actions in full form: one filled button at a time.
 */
export function PaymentView({ paymentId }: { paymentId: string }) {
  const host = useDrawerHost();
  const timeZone = useScheduleTimezone();
  const now = useNow(60_000);
  const detailQuery = usePaymentDetail(paymentId);
  const items = useDrawerItems(paymentId);
  const detail = detailQuery.data ?? null;
  const row = (host.seedOf('payment', paymentId) as PaymentRow | undefined) ?? null;
  // The Failed alert already says why; the timeline's Failed entry does not say it a second time.
  const failedAlertText = detail?.status === 'Failed' ? detail.failure_text : null;
  const shown: PaymentRow | null = detail ?? row;
  const [refunding, setRefunding] = useState(false);
  const failedToLoad = detailQuery.isError && !row;

  if (failedToLoad) {
    return (
      <>
        <DrawerHeaderBar title="Payment" />
        <div className="flex-1">
          <LoadError title="Couldn’t load this payment." onRetry={() => void detailQuery.refetch()} retrying={detailQuery.isFetching} />
        </div>
        <SheetFooter><DrawerCloseButton /></SheetFooter>
      </>
    );
  }
  if (!shown) {
    return (
      <>
        <DrawerHeaderBar title="Payment" />
        <DrawerBody><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></DrawerBody>
        <SheetFooter><DrawerCloseButton /></SheetFooter>
      </>
    );
  }

  const dispute = detail?.dispute ?? null;
  const answering = dispute?.status === 'NEEDS_RESPONSE';
  const canRespond = Boolean(detail && answering && detail.can_respond_dispute);
  // While a failed refund is open the footer offers "Refund again" instead of "Refund": never both.
  const hideRefund = items.some((item) => visibleActions(item).includes('refund_again'));
  const leadItem = items.findIndex(hasActions);
  const viewDispute = dispute && (
    <Button
      type="button" size="sm" variant="outline" className="shrink-0 max-md:h-11 touch:h-11"
      onClick={() => host.push({ kind: 'dispute', id: dispute.id })}
    >
      View
    </Button>
  );

  return (
    <>
      <DrawerHeaderBar title={`Payment ${shown.reference}`} />
      <DrawerBody>
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[28px] leading-tight font-bold tabular-nums">{formatCurrency(shown.amount)}</div>
            <StatusChip domain="paymentDisplay" status={shown.status} />
          </div>
          <div className="text-text-secondary mt-1 text-[13.5px]">
            {[shown.method_label, shown.method_detail, formatInstant(shown.date, timeZone, DAY)].filter(Boolean).join(' · ')}
          </div>
        </div>

        {detail?.status === 'Failed' && (
          <Alert tone="danger">
            {/* One element: the kit Alert lays its children out as flex items, which would drop the space. */}
            <p><b>Payment failed.</b> {detail.failure_text}</p>
          </Alert>
        )}
        {detail?.refund_failed && (
          <Alert tone="danger">
            <p><b>Refund failed.</b> {formatCurrency(detail.refund_failed.amount)} could not be returned: {detail.refund_failed.failure_text}.</p>
          </Alert>
        )}
        {dispute && (answering ? (
          <Alert tone="danger">
            <div className="flex w-full items-center justify-between gap-3">
              <span className="min-w-0">
                <b>Dispute: {dispute.reason_text}.</b>
                {dispute.respond_by && (
                  <>
                    {' '}Respond by {formatInstant(dispute.respond_by, timeZone, DEADLINE)}
                    {timeLeft(dispute.respond_by, now) && <> ({timeLeft(dispute.respond_by, now)!.text})</>}.
                  </>
                )}
              </span>
              {viewDispute}
            </div>
          </Alert>
        ) : (
          <Alert tone="neutral" role="status">
            <div className="flex w-full items-center justify-between gap-3">
              <span className="min-w-0"><b>Dispute {words(dispute.status)}.</b> {dispute.reason_text}.</span>
              {viewDispute}
            </div>
          </Alert>
        ))}

        {detail ? <CustomerBlock block={detail.customer_block} /> : <Skeleton className="h-40 w-full" />}

        <DescriptionList>
          <DescriptionItem>
            <DescriptionTerm>Amount</DescriptionTerm>
            <DescriptionDetails>{formatCurrency(shown.amount)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Fee</DescriptionTerm>
            <DescriptionDetails>{shown.fee == null ? '—' : minus(shown.fee)}</DescriptionDetails>
          </DescriptionItem>
          {shown.refunded > 0 && (
            <DescriptionItem>
              <DescriptionTerm>Refunded</DescriptionTerm>
              <DescriptionDetails>{minus(shown.refunded)}</DescriptionDetails>
            </DescriptionItem>
          )}
          <DescriptionItem className="border-t-2 font-semibold">
            <DescriptionTerm>Net</DescriptionTerm>
            <DescriptionDetails>{netAfterRefunds(shown) == null ? '—' : formatCurrency(netAfterRefunds(shown)!)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Method</DescriptionTerm>
            <DescriptionDetails className="font-normal">{shown.method_label}</DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
          {detail ? (
            <Timeline>
              {detail.timeline.map((entry, i) => {
                const paidOut = PAID_OUT.exec(entry.label);
                return (
                  <TimelineItem key={`${entry.at}-${i}`}>
                    <TimelineContent>
                      {paidOut && detail.payout ? (
                        <>
                          Paid out in{' '}
                          <button
                            type="button"
                            className="text-brand underline-offset-2 hover:underline"
                            onClick={() => host.push({ kind: 'payout', id: detail.payout!.id })}
                          >
                            {paidOut[1]}
                          </button>
                        </>
                      ) : (
                        <b>{entry.label}</b>
                      )}
                    </TimelineContent>
                    <TimelineTime dateTime={entry.at}>
                      {formatInstant(entry.at, timeZone, DAY)}
                      {entry.note && entry.note !== failedAlertText ? ` · ${entry.note}` : ''}
                    </TimelineTime>
                  </TimelineItem>
                );
              })}
            </Timeline>
          ) : (
            <Skeleton className="h-16 w-full" />
          )}
        </div>
      </DrawerBody>

      <SheetFooter>
        {canRespond && dispute && (
          <Button type="button" onClick={() => host.push({ kind: 'dispute', id: dispute.id }, { kind: 'respond', id: dispute.id })}>
            Respond to dispute
          </Button>
        )}
        {detail && items.map((item, i) => (
          <AttentionActions key={item.key} item={item} size="default" omit={OMIT_RESPOND} fill={!canRespond && i === leadItem} />
        ))}
        {detail?.can_refund && !hideRefund && (
          <Button type="button" variant="destructive" onClick={() => setRefunding(true)}>Refund</Button>
        )}
        <DrawerCloseButton />
      </SheetFooter>
      {detail?.can_refund && (
        <RefundPaymentDialog payment={detail} open={refunding} onOpenChange={setRefunding} />
      )}
    </>
  );
}
