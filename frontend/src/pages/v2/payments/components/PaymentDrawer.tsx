import { useState, type MutableRefObject, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { netAfterRefunds, usePaymentDetail, type PaymentDetail, type PaymentRow } from '@/lib/api/paymentsPage';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import {
  DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm,
} from '@/ui-kit/components/data/descriptionList';
import { Timeline, TimelineContent, TimelineItem, TimelineTime } from '@/ui-kit/components/data/timeline';
import { Button } from '@/ui-kit/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { StatusChip } from '../../_shared/statusChip';
import { v2Path } from '../../uiV2';
import { RefundPaymentDialog } from './RefundPaymentDialog';
import { PHONE_TAP_AREA } from '../phoneTap';

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const PAID_OUT = /^Paid out in (PO-[A-Z0-9]+)$/;

const minus = (n: number) => (n === 0 ? formatCurrency(0) : formatCurrency(-Math.abs(n)));

/** "NEEDS_RESPONSE" -> "needs response" */
const words = (status: string) => status.toLowerCase().replace(/_/g, ' ');

/**
 * One payment, in a right-hand drawer (payments go-live P6). The list row shows at once; the detail (timeline, alerts,
 * what the caller may do) fills in when it arrives. Its address is `?payment=` so a refresh or a shared link reopens it.
 *
 * A caller who may do nothing here sees only Close: the buttons come from the detail's flags, never from a role check.
 * `extraActions` is a slot rendered before Refund and Close (the attention view adds Respond, Contact customer, ...).
 */
export function PaymentDrawer({
  paymentId, row, onClose, extraActions, hideRefund = false, onOpenPayout, onOpenDispute, returnFocusRef,
}: {
  paymentId: string | null;
  row: PaymentRow | null;
  onClose: () => void;
  extraActions?: (detail: PaymentDetail) => ReactNode;
  /** The slot already offers the refund (Refund again), so the plain Refund button stays out: one filled button at a time. */
  hideRefund?: boolean;
  /** Opens the payout drawer (P8). Nothing happens until it is wired. */
  onOpenPayout?: (payoutId: string) => void;
  /** Opens the dispute drawer (P11) for this payment's dispute. */
  onOpenDispute?: (disputeId: string) => void;
  /** The element that opened the drawer; it gets focus back on close. */
  returnFocusRef?: MutableRefObject<HTMLElement | null>;
}) {
  const timeZone = useScheduleTimezone();
  const detailQuery = usePaymentDetail(paymentId);
  const detail = detailQuery.data ?? null;
  // The Failed alert already says why; the timeline's Failed entry does not say it a second time.
  const failedAlertText = detail?.status === 'Failed' ? detail.failure_text : null;
  const shown: PaymentRow | null = detail ?? row;
  const [refunding, setRefunding] = useState(false);

  const failedToLoad = detailQuery.isError && !row;

  return (
    <>
      <Sheet open={Boolean(paymentId)} onOpenChange={(next) => { if (!next) onClose(); }}>
        <SheetContent
          side="right"
          showClose={false}
          intent="content"
          className={PHONE_TAP_AREA}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {failedToLoad || (!shown && !detailQuery.isPending) ? (
            <>
              <SheetHeader>
                <SheetTitle>Payment</SheetTitle>
                <SheetDescription className="sr-only">Payment details</SheetDescription>
              </SheetHeader>
              <div className="flex-1">
                <LoadError title="Couldn’t load this payment." onRetry={() => void detailQuery.refetch()} retrying={detailQuery.isFetching} />
              </div>
            </>
          ) : !shown ? (
            <>
              <SheetHeader>
                <SheetTitle>Payment</SheetTitle>
                <SheetDescription className="sr-only">Payment details</SheetDescription>
              </SheetHeader>
              <div className="flex flex-1 flex-col gap-3 p-4"><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></div>
            </>
          ) : (
            <>
              <SheetHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <SheetTitle>{shown.customer?.name ?? 'Payment'}</SheetTitle>
                    <SheetDescription className="mt-1">
                      {shown.invoice && (
                        <Link to={v2Path(`/invoices/${shown.invoice.id}`)} className="whitespace-nowrap text-brand hover:underline">
                          {shown.invoice.number}
                        </Link>
                      )}
                      {shown.invoice && shown.method_detail ? ' · ' : ''}
                      {shown.method_detail}
                    </SheetDescription>
                  </div>
                  <StatusChip domain="paymentDisplay" status={shown.status} />
                </div>
              </SheetHeader>

              <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
                <div className="pt-2 text-3xl font-semibold tabular-nums">{formatCurrency(shown.amount)}</div>

                {detail?.status === 'Failed' && (
                  <Alert tone="danger">
                    {/* One element: the kit Alert lays its children out as flex items, which would drop the space. */}
                    <p><b>Payment failed.</b> {detail.failure_text}</p>
                  </Alert>
                )}
                {detail?.dispute && (() => {
                  const dispute = detail.dispute;
                  const answering = dispute.status === 'NEEDS_RESPONSE';
                  const action = onOpenDispute && (
                    <Button
                      type="button" size="sm" variant="outline" className="max-sm:h-11 touch:h-11"
                      onClick={() => onOpenDispute(dispute.id)}
                    >
                      {answering && detail.can_respond_dispute ? 'Respond' : 'View'}
                    </Button>
                  );
                  // One text block beside the button: the reason and the deadline read together.
                  return answering ? (
                    <Alert tone="danger">
                      <div className="flex w-full flex-wrap items-center justify-between gap-2">
                        <span>
                          <b>Dispute: {dispute.reason_text}.</b>
                          {dispute.respond_by && <> Respond by {formatInstant(dispute.respond_by, timeZone, DAY)}.</>}
                        </span>
                        {action}
                      </div>
                    </Alert>
                  ) : (
                    <Alert tone="neutral" role="status">
                      <div className="flex w-full flex-wrap items-center justify-between gap-2">
                        <span><b>Dispute {words(dispute.status)}.</b> {dispute.reason_text}.</span>
                        {action}
                      </div>
                    </Alert>
                  );
                })()}

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
                                    onClick={() => onOpenPayout?.(detail.payout!.id)}
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
              </div>

              <SheetFooter>
                {detail && extraActions?.(detail)}
                {detail?.can_refund && !hideRefund && (
                  <Button type="button" variant="destructive" onClick={() => setRefunding(true)}>Refund</Button>
                )}
                <Button type="button" variant="outline" onClick={onClose}>Close</Button>
              </SheetFooter>
            </>
          )}
          {(failedToLoad || (!shown && !detailQuery.isPending)) && (
            <SheetFooter>
              <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
      {detail?.can_refund && (
        <RefundPaymentDialog payment={detail} open={refunding} onOpenChange={setRefunding} />
      )}
    </>
  );
}
