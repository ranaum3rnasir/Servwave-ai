import type { ReactNode } from 'react';

import {
  isUnappliedKey, useAttentionItem, usePaymentDetail, usePayoutDetail, type AttentionItem, type PaymentDetail,
} from '@/lib/api/paymentsPage';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import {
  DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm,
} from '@/ui-kit/components/data/descriptionList';
import { Button } from '@/ui-kit/components/ui/button';
import { SheetFooter } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { StatusChip } from '../../_shared/statusChip';
import { DrawerBody, DrawerCloseButton, DrawerHeaderBar, useDrawerHost } from '../drawerHost';
import { formatPayoutDay } from '../payouts';
import { AttentionActions, visibleActions } from './attentionActions';
import { CustomerBlock } from './CustomerBlock';
import { UnappliedItemView } from './UnappliedItemView';

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

const TITLE: Record<string, string> = {
  failed_payment: 'Bank payment failed',
  failed_refund: 'Refund failed',
  failed_payout: 'Payout failed',
};
const typeOf = (key: string) => key.slice(0, key.indexOf(':'));

function Row({ term, children, money = false }: { term: string; children: ReactNode; money?: boolean }) {
  return (
    <DescriptionItem>
      <DescriptionTerm>{term}</DescriptionTerm>
      <DescriptionDetails className={money ? undefined : 'font-normal'}>{children}</DescriptionDetails>
    </DescriptionItem>
  );
}

/** A value that pushes another view (View PMT-..., View PO-...): a link-looking button, so Back returns here. */
function ViewLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button type="button" variant="link" className="h-auto p-0 text-left font-normal whitespace-normal max-sm:min-h-11" onClick={onClick}>
      {children}
    </Button>
  );
}

function ItemShell({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <DrawerHeaderBar title={title} />
      <DrawerBody>{children}</DrawerBody>
      <SheetFooter>
        {footer}
        <DrawerCloseButton />
      </SheetFooter>
    </>
  );
}

function Head({ item, pill }: { item: AttentionItem; pill: ReactNode }) {
  const timeZone = useScheduleTimezone();
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[28px] leading-tight font-bold tabular-nums">{item.amount == null ? '—' : formatCurrency(item.amount)}</div>
        {pill}
      </div>
      {item.status === 'resolved' && (
        <Alert tone="neutral" role="status">
          <p>
            <b>Resolved.</b>{' '}
            {[item.resolution?.text, item.resolved_by_name, item.resolved_at ? formatInstant(item.resolved_at, timeZone, DAY) : null]
              .filter(Boolean).join(' · ')}
          </p>
        </Alert>
      )}
    </>
  );
}

/** The item's actions in full form (first filled), with the reason printed under any that is disabled. */
function ItemActions({ item }: { item: AttentionItem }) {
  return item.status === 'open' && visibleActions(item).length ? <AttentionActions item={item} size="default" /> : null;
}

const methodOf = (payment: PaymentDetail) => [payment.method_label, payment.method_detail].filter(Boolean).join(' · ');

function PaymentItem({ item, refund }: { item: AttentionItem; refund: boolean }) {
  const host = useDrawerHost();
  const timeZone = useScheduleTimezone();
  const payment = usePaymentDetail(item.payment_id);
  const detail = payment.data;
  const reference = item.payment_reference ?? detail?.reference ?? null;
  const viewPayment = (label: string) => item.payment_id && reference && (
    <ViewLink onClick={() => host.push({ kind: 'payment', id: item.payment_id! })}>{label}</ViewLink>
  );
  const email = {
    subject: item.compose?.subject ?? (detail && detail.customer_block.restricted === false ? `Invoice ${detail.customer_block.invoice.number}` : ''),
    body: item.compose?.body,
  };
  return (
    <ItemShell title={TITLE[typeOf(item.key)]!} footer={<ItemActions item={item} />}>
      <Head item={item} pill={<StatusChip domain="paymentDisplay" status={refund ? 'Refund failed' : 'Failed'} />} />
      <Alert tone="danger">
        <p>
          {refund
            ? <><b>Refund failed.</b> {item.amount == null ? 'The amount' : formatCurrency(item.amount)} could not be returned: {item.detail}.</>
            : <><b>Bank payment failed.</b> {item.detail}</>}
        </p>
      </Alert>
      {payment.isError && !detail ? (
        <LoadError title="Couldn’t load the customer." onRetry={() => void payment.refetch()} retrying={payment.isFetching} />
      ) : detail ? (
        <CustomerBlock block={detail.customer_block} email={email} />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
      <DescriptionList>
        {refund && <Row term="Refund amount" money>{item.amount == null ? '—' : formatCurrency(item.amount)}</Row>}
        <Row term="Failed on">{formatInstant(item.date, timeZone, DAY)}</Row>
        {!refund && <Row term="Method">{detail ? methodOf(detail) : '—'}</Row>}
        {!refund && reference && <Row term="Payment">{viewPayment(`View ${reference}`)}</Row>}
        {refund && reference && (
          <Row term="Original payment">
            {viewPayment(`View ${reference}${detail ? ` · ${formatCurrency(detail.amount)}` : ''}`)}
          </Row>
        )}
      </DescriptionList>
    </ItemShell>
  );
}

function PayoutItem({ item }: { item: AttentionItem }) {
  const host = useDrawerHost();
  const payout = usePayoutDetail(item.payout_id);
  const detail = payout.data;
  return (
    <ItemShell title={TITLE.failed_payout!} footer={<ItemActions item={item} />}>
      <Head item={item} pill={<StatusChip domain="payout" status="FAILED" />} />
      <Alert tone="danger"><p><b>Payout failed.</b> {item.detail}.</p></Alert>
      <DescriptionList>
        <Row term="Payout">
          {item.payout_id && item.payout_reference && (
            <ViewLink onClick={() => host.push({ kind: 'payout', id: item.payout_id! })}>{`View ${item.payout_reference}`}</ViewLink>
          )}
        </Row>
        <Row term="Date">{detail ? formatPayoutDay(detail.arrival_date) : '—'}</Row>
        <Row term="Destination">{detail?.destination_label ?? '—'}</Row>
        <Row term="Payments in it">{detail ? String(detail.payment_count) : '—'}</Row>
      </DescriptionList>
    </ItemShell>
  );
}

/**
 * An attention item as a view of the drawer host: the failed bank payment, the failed refund and the failed payout. It
 * is read by its key (so a reload on a `d` address works), through the read-by-key route that only needs View payments;
 * the item's actions keep their own switches.
 */
export function ItemView({ itemKey }: { itemKey: string }) {
  // Unapplied money reads a richer answer from the same route, so it has its own view.
  if (isUnappliedKey(itemKey)) return <UnappliedItemView itemKey={itemKey} />;
  return <FailedItemView itemKey={itemKey} />;
}

function FailedItemView({ itemKey }: { itemKey: string }) {
  const query = useAttentionItem(itemKey);
  const item = query.data;
  const title = TITLE[typeOf(itemKey)] ?? 'Item';
  if (!item) {
    return (
      <>
        <DrawerHeaderBar title={title} />
        <DrawerBody>
          {query.isError ? (
            <LoadError title="Couldn’t load this item." onRetry={() => void query.refetch()} retrying={query.isFetching} />
          ) : (
            <><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></>
          )}
        </DrawerBody>
        <SheetFooter><DrawerCloseButton /></SheetFooter>
      </>
    );
  }
  if (item.type === 'failed_payment') return <PaymentItem item={item} refund={false} />;
  if (item.type === 'failed_refund') return <PaymentItem item={item} refund />;
  if (item.type === 'failed_payout') return <PayoutItem item={item} />;
  return (
    <ItemShell title={title}>
      <LoadError title="This item can’t be opened here." onRetry={() => void query.refetch()} retrying={query.isFetching} />
    </ItemShell>
  );
}
