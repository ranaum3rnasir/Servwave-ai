import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Landmark } from 'lucide-react';

import { useCanSeePrices } from '@/contexts/AbilityContext';
import { usePayoutsList, type PayoutRow } from '@/lib/api/paymentsPage';
import { formatCurrency } from '@/lib/utils';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { LoadError } from '../../_shared/loadError';
import { useScrollTableIntoView } from '../useScrollTableIntoView';
import { StatusChip } from '../../_shared/statusChip';
import { useDrawerHost } from '../drawerHost';
import { formatPayoutDay } from '../payouts';
import type { PaymentsTabProps } from '../types';

const allColumns: ColumnDef<PayoutRow>[] = [
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
 * does not filter it (it drives the tiles and the Payments tab). A row opens the payout in the page's drawer host.
 */
export default function PayoutsTab(_props: PaymentsTabProps) {
  const host = useDrawerHost();
  // P11: a payout's amount is a sum of payments, so it needs See prices; without it the column is not drawn.
  const canSeePrices = useCanSeePrices();
  const columns = useMemo(() => allColumns.filter((c) => canSeePrices || c.id !== 'amount'), [canSeePrices]);
  const [page, setPage] = useState(1);
  const { ref: tableTopRef, request: scrollTableTop } = useScrollTableIntoView();
  const list = usePayoutsList(page);
  const rows = useMemo(() => list.data?.payouts ?? [], [list.data]);
  const pagination = list.data?.pagination;

  return (
    <div className="flex flex-col gap-4 pt-4">
      {list.isError && !list.data ? (
        <LoadError title="Couldn’t load payouts." onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <div ref={tableTopRef}>
          <DataTable<PayoutRow, unknown>
            columns={columns}
            data={rows}
            getRowId={(p) => p.id}
            isLoading={list.isPending}
            isFetching={list.isFetching}
            page={page}
            pageCount={pagination?.totalPages ?? 1}
            onPageChange={(next) => { setPage(next); scrollTableTop(); }}
            pageSize={pagination?.limit ?? 25}
            rowCount={pagination?.total ?? 0}
            mobileCards
            rowsFocusable
            onRowClick={(p) => host.open([{ kind: 'payout', id: p.id }], { seeds: { [`payout:${p.id}`]: p } })}
            empty={<EmptyState icon={<Landmark />} title="No payouts yet" />}
          />
        </div>
      )}
    </div>
  );
}
