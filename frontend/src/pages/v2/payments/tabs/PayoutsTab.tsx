import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Landmark } from 'lucide-react';

import { usePayoutsList, type PayoutRow } from '@/lib/api/paymentsPage';
import { formatCurrency } from '@/lib/utils';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { LoadError } from '../../_shared/loadError';
import { StatusChip } from '../../_shared/statusChip';
import { PaymentDrawer } from '../components/PaymentDrawer';
import { PayoutDrawer } from '../components/PayoutDrawer';
import { formatPayoutDay } from '../payouts';
import type { PaymentsTabProps } from '../types';

const columns: ColumnDef<PayoutRow>[] = [
  {
    id: 'date',
    header: 'Date',
    meta: { label: 'Date' },
    size: 160,
    cell: ({ row }) => (
      <>
        {formatPayoutDay(row.original.arrival_date)}
        <span className="text-muted-foreground block text-xs">{row.original.reference}</span>
      </>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    meta: { label: 'Status' },
    size: 140,
    cell: ({ row }) => <StatusChip domain="payout" status={row.original.status} />,
  },
  {
    id: 'destination',
    header: 'Destination',
    meta: { label: 'Destination' },
    size: 240,
    cell: ({ row }) => row.original.destination_label ?? '—',
  },
  {
    id: 'amount',
    header: () => <span className="block text-right">Amount</span>,
    meta: { label: 'Amount' },
    size: 140,
    cell: ({ row }) => (
      <span data-money className="block text-right tabular-nums">{formatCurrency(row.original.amount)}</span>
    ),
  },
];

/**
 * The Payouts tab (payments go-live P8): every payout, newest first, 25 to a page from the server. The period picker
 * does not filter it (it drives the tiles and the Payments tab). A row opens the payout drawer, whose address is
 * `?payout=`; a payment opened from inside it adds `?payment=`, so a refresh restores both.
 */
export default function PayoutsTab({ tabState }: PaymentsTabProps) {
  const { params, setParams } = tabState;
  const [page, setPage] = useState(1);
  const list = usePayoutsList(page);
  const rows = useMemo(() => list.data?.payouts ?? [], [list.data]);
  const pagination = list.data?.pagination;

  const payoutId = params.get('payout');
  const paymentId = params.get('payment');

  // The row (or the payment row inside the drawer) that opened a drawer, so Close and Escape put focus back on it.
  const payoutOpenerRef = useRef<HTMLElement | null>(null);
  const paymentOpenerRef = useRef<HTMLElement | null>(null);

  // Two modal drawers that mount in the SAME commit trap focus against each other and never settle (measured: a reload
  // of ?payout=&payment= hung the page). The payment drawer therefore waits one tick, so the payout drawer is already
  // the active layer when the payment drawer opens on top of it, as it is when a person clicks a row.
  const [paymentMayOpen, setPaymentMayOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPaymentMayOpen(true), 0);
    return () => clearTimeout(timer);
  }, []);

  const seed = useMemo(() => rows.find((p) => p.id === payoutId) ?? null, [rows, payoutId]);
  const remember = (ref: { current: HTMLElement | null }) => {
    ref.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  return (
    <div className="flex flex-col gap-4 pt-4">
      {list.isError && !list.data ? (
        <LoadError title="Couldn’t load payouts." onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <DataTable<PayoutRow, unknown>
          columns={columns}
          data={rows}
          getRowId={(p) => p.id}
          isLoading={list.isPending}
          isFetching={list.isFetching}
          page={page}
          pageCount={pagination?.totalPages ?? 1}
          onPageChange={setPage}
          pageSize={pagination?.limit ?? 25}
          rowCount={pagination?.total ?? 0}
          mobileCards
          rowsFocusable
          onRowClick={(p) => {
            remember(payoutOpenerRef);
            setParams({ payout: p.id });
          }}
          empty={<EmptyState icon={<Landmark />} title="No payouts yet" />}
        />
      )}
      <PayoutDrawer
        payoutId={payoutId}
        seed={seed}
        onClose={() => setParams({ payout: null, payment: null })}
        returnFocusRef={payoutOpenerRef}
        onOpenPayment={(id) => {
          remember(paymentOpenerRef);
          setParams({ payment: id });
        }}
      />
      <PaymentDrawer
        paymentId={paymentMayOpen ? paymentId : null}
        row={null}
        onClose={() => setParams({ payment: null })}
        onOpenPayout={(id) => setParams({ payout: id, payment: null })}
        returnFocusRef={paymentOpenerRef}
      />
    </div>
  );
}
