import { useState } from 'react';
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';

import {
  usePayoutDetail, usePayoutPayments, type PayoutDetail, type PayoutPaymentRow, type PayoutRow,
} from '@/lib/api/paymentsPage';
import { formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/ui-kit/components/ui/button';
import { SheetFooter } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { LoadError } from '../../_shared/loadError';
import { StatusChip } from '../../_shared/statusChip';
import { DrawerBody, DrawerCloseButton, DrawerHeaderBar, useDrawerHost } from '../drawerHost';
import { formatPayoutDay } from '../payouts';
import { CustomerIdLink } from './CustomerIdLink';
import { UpdateBankAccountDialog } from './UpdateBankAccountDialog';

/**
 * The drawer is narrow (26rem) and holds four columns, so its cells use a tighter side padding than the kit table's
 * 16px. Set once on the table, so no cell restyles itself through className.
 */
const COMPACT_TABLE = '[&_th]:px-2 [&_td]:px-2';

/** A control this drawer adds is at least 44px tall on a phone; the kit defaults are left alone. */
const PHONE_TAP = 'max-md:min-h-11';

/** A money figure: right-aligned in tabular figures; a figure not confirmed yet is a dash. */
function Money({ value }: { value: number | null }) {
  return (
    <span data-money className="block text-right tabular-nums">
      {value == null ? '—' : value === 0 ? formatCurrency(0) : formatCurrency(value)}
    </span>
  );
}

function PaymentLine({ payment, onOpen }: { payment: PayoutPaymentRow; onOpen: (id: string) => void }) {
  const openable = !payment.restricted;
  return (
    <TableRow
      tabIndex={openable ? 0 : undefined}
      className={openable ? `cursor-pointer ${PHONE_TAP}` : undefined}
      onClick={openable ? () => onOpen(payment.id) : undefined}
      onKeyDown={openable
        ? (event) => { if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(payment.id); }
        : undefined}
    >
      <TableCell>
        {payment.restricted || !payment.customer ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5">
            <Lock className="size-3.5" aria-hidden />
            Restricted
          </span>
        ) : (
          <>
            {payment.customer.name}
            <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
              <span>{payment.invoice?.number}</span>
              {payment.customer.customer_number && (
                <>
                  <span aria-hidden="true">·</span>
                  <CustomerIdLink customer={payment.customer} />
                </>
              )}
            </span>
          </>
        )}
        {payment.voided && <span className="mt-1 block"><StatusChip domain="paymentDisplay" status="Voided" /></span>}
      </TableCell>
      <TableCell><Money value={payment.amount} /></TableCell>
      <TableCell><Money value={payment.fee == null ? null : -Math.abs(payment.fee)} /></TableCell>
      <TableCell><Money value={payment.net} /></TableCell>
    </TableRow>
  );
}

/**
 * The payments inside a payout, 25 to a page, with the totals of the WHOLE payout in the footer. A payout can hold
 * hundreds of payments, so the page never holds them all at once. Keyed by payout so a different payout starts at page 1.
 */
function PayoutPayments({ payoutId, onOpenPayment }: { payoutId: string; onOpenPayment: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const query = usePayoutPayments(payoutId, page);
  const data = query.data;

  if (query.isError && !data) {
    return <LoadError title="Couldn’t load the payments in this payout." onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  if (!data) return <Skeleton className="h-24 w-full" />;

  const pages = data.pagination.totalPages;
  const count = data.payment_count;
  const voided = data.voided_count;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">
        {count} {count === 1 ? 'payment' : 'payments'} in this payout{voided > 0 ? ` · ${voided} voided` : ''}
      </h3>
      <Table className={COMPACT_TABLE}>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead><span className="block text-right">Amount</span></TableHead>
            <TableHead><span className="block text-right">Fee</span></TableHead>
            <TableHead><span className="block text-right">Net</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.payments.map((p) => <PaymentLine key={p.id} payment={p} onOpen={onOpenPayment} />)}
        </TableBody>
        <TableFooter>
          <TableRow className="font-semibold">
            <TableCell>Total</TableCell>
            <TableCell><Money value={data.totals.amount} /></TableCell>
            <TableCell><Money value={-Math.abs(data.totals.fee)} /></TableCell>
            <TableCell><Money value={data.totals.net} /></TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button" variant="outline" size="sm" className={PHONE_TAP} aria-label="Previous page"
            disabled={page <= 1 || query.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span className="text-muted-foreground text-sm tabular-nums">Page {page} of {pages}</span>
          <Button
            type="button" variant="outline" size="sm" className={PHONE_TAP} aria-label="Next page"
            disabled={page >= pages || query.isFetching} onClick={() => setPage((p) => Math.min(pages, p + 1))}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One payout, as a view of the drawer host (payments go-live P8, V7-07). The list row (a seed from the opener) shows at
 * once; the detail fills in the failure text and the payments.
 *
 * A failed payout offers "Update bank account" when the payout's own actions say so (the server decides); it opens the
 * same dialog the Needs attention card uses. A payment row pushes the Payment view, so Back returns to this payout.
 */
export function PayoutView({ payoutId }: { payoutId: string }) {
  const host = useDrawerHost();
  const detailQuery = usePayoutDetail(payoutId);
  const detail: PayoutDetail | null = detailQuery.data ?? null;
  const seed = (host.seedOf('payout', payoutId) as PayoutRow | undefined) ?? null;
  const shown: PayoutRow | null = detail ?? seed;
  const failedToLoad = detailQuery.isError && !shown;
  const canFix = Boolean(detail?.actions.update_bank_account);
  const [fixing, setFixing] = useState(false);

  if (failedToLoad) {
    return (
      <>
        <DrawerHeaderBar title="Payout" />
        <div className="flex-1">
          <LoadError title="Couldn’t load this payout." onRetry={() => void detailQuery.refetch()} retrying={detailQuery.isFetching} />
        </div>
        <SheetFooter><DrawerCloseButton /></SheetFooter>
      </>
    );
  }
  if (!shown) {
    return (
      <>
        <DrawerHeaderBar title="Payout" />
        <DrawerBody><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></DrawerBody>
        <SheetFooter><DrawerCloseButton /></SheetFooter>
      </>
    );
  }
  return (
    <>
      <DrawerHeaderBar title={`Payout ${shown.reference}`} />
      <DrawerBody>
        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[28px] leading-tight font-bold tabular-nums">{formatCurrency(shown.amount)}</div>
            <StatusChip domain="payout" status={shown.status} />
          </div>
          <div className="text-text-secondary mt-1 text-[13.5px]">
            {formatPayoutDay(shown.arrival_date)}
            {shown.destination_label ? ` · ${shown.destination_label}` : ''}
          </div>
        </div>

        {detail?.status === 'FAILED' && (
          <Alert tone="danger" role="alert">
            <p><b>Payout failed.</b> {detail.failure_text}</p>
          </Alert>
        )}

        <PayoutPayments key={payoutId} payoutId={payoutId} onOpenPayment={(id) => host.push({ kind: 'payment', id })} />
      </DrawerBody>

      <SheetFooter>
        {canFix && (
          <Button type="button" className={PHONE_TAP} onClick={() => setFixing(true)}>Update bank account</Button>
        )}
        <DrawerCloseButton />
      </SheetFooter>
      <UpdateBankAccountDialog open={fixing && canFix} onOpenChange={setFixing} />
    </>
  );
}
