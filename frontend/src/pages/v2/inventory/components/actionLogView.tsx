/**
 * The Activity tab body - the filterable stock-movements ledger - rebuilt on
 * the CRM UI kit.
 *
 * A presentation swap over `components/inventory/ActionLogView.tsx`. Unchanged:
 * the `useMovements({ ...filters, page, limit: PAGE_SIZE })` query and its key,
 * every server filter param, the `?lo=` search-param contract (including the
 * effect that resets to page 1 whenever it changes), the cost column's
 * "render only when the server did not cost-strip" rule, and the CSV export -
 * which still issues its own raw `api.get` with the same params, the same
 * `limit: 100` current-view snapshot, the same column set and the same
 * `stock-activity-<date>.csv` filename.
 *
 * What moved onto the kit:
 *   - the hand-rolled header strip becomes a kit PageHeader.
 *   - four `form/SelectField`s become kit Selects, keeping every
 *     `Filter by ...` accessible name.
 *   - the two date `Input`s become kit Inputs, keeping `From date` / `To date`.
 *   - the raw `×` close affordance on the Logistic Order chip becomes a kit
 *     ghost Button with an `X` icon and the same
 *     `Clear Logistic Order filter` label.
 *   - the hand-rolled `<table>` plus its separate prev/next row become one kit
 *     DataTable in server-paging mode.
 *   - the five hand-tinted verb pills become kit soft Badges.
 *
 * Cross-record links point at the v2 counterparts through `v2Path`, the way
 * every other v2 page links out.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, X } from 'lucide-react';

import api from '@/lib/axios';
import { useMovements, useInventoryItems, useLocations, useTechs } from '@/lib/api/inventory';
import type { Movement, MovementFilters, MovementType, PaginationMeta } from '@/lib/api/inventory';
import { formatCurrency } from '@/lib/utils';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { DatePicker } from '../../_shared/datePicker';
import { v2Path } from '../../uiV2';
import { EM_DASH } from '../glyphs';

const PAGE_SIZE = 25;

const TYPE_OPTIONS: { value: MovementType | 'all'; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'receive', label: 'Receive' },
  { value: 'consume', label: 'Consume' },
  { value: 'return', label: 'Return' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'adjust', label: 'Adjust' },
];

/** Verb -> its display label, the same text TYPE_OPTIONS offers in the filter. */
const TYPE_LABEL: Record<MovementType, string> = {
  receive: 'Receive',
  consume: 'Consume',
  transfer: 'Transfer',
  return: 'Return',
  adjust: 'Adjust',
};

/**
 * Verb -> Badge variant.
 *
 * The legacy pills were hand-tinted from the semantic tokens
 * (success/danger/info/primary/warning); these are the kit's soft equivalents,
 * so the same verb still reads the same colour.
 */
const TYPE_VARIANT: Record<MovementType, 'softGreen' | 'softRed' | 'softBlue' | 'softPurple' | 'softAmber'> = {
  receive: 'softGreen',
  consume: 'softRed',
  transfer: 'softBlue',
  return: 'softPurple',
  adjust: 'softAmber',
};

/** Decimal-safe qty: signed for `adjust`, up to 2 decimals. */
function fmtQty(m: Movement): string {
  const abs = Number.isInteger(m.qty) ? String(m.qty) : m.qty.toFixed(2);
  if (m.type === 'adjust' && m.qty > 0) return `+${abs}`;
  return abs;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildMovementColumns({
  hasCost, logisticOrderId,
}: {
  hasCost: boolean;
  logisticOrderId: string | undefined;
}): ColumnDef<Movement, unknown>[] {
  const columns: ColumnDef<Movement, unknown>[] = [
    {
      id: 'time',
      accessorKey: 'occurredAt',
      header: 'Time',
      size: 180,
      meta: { label: 'Time', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">{fmtTime(row.original.occurredAt)}</span>
      ),
    },
    {
      id: 'type',
      accessorKey: 'type',
      header: 'Type',
      size: 110,
      meta: { label: 'Type', fixed: true },
      // The legacy pill rendered the raw enum value and capitalised it in CSS.
      // Badge's appearance ratchet is at its ceiling, so the label comes from
      // the same TYPE_OPTIONS map the filter uses - the rendered text is
      // identical, the DOM text is now "Consume" rather than "consume".
      cell: ({ row }) => (
        <Badge variant={TYPE_VARIANT[row.original.type]} size="pill">
          {TYPE_LABEL[row.original.type]}
        </Badge>
      ),
    },
    {
      id: 'item',
      accessorKey: 'itemName',
      header: 'Item',
      size: 220,
      meta: { label: 'Item', fixed: true },
      cell: ({ row }) => (
        <span className="block min-w-0">
          <code className="text-muted-foreground block font-mono text-[11px]">{row.original.itemSku}</code>
          <span className="block truncate font-medium">{row.original.itemName}</span>
        </span>
      ),
    },
    {
      id: 'qty',
      accessorKey: 'qty',
      header: 'Qty',
      size: 90,
      meta: { label: 'Qty', fixed: true },
      cell: ({ row }) => <span className="block text-right font-mono">{fmtQty(row.original)}</span>,
    },
    {
      id: 'route',
      header: 'From → To',
      size: 220,
      meta: { label: 'From → To' },
      cell: ({ row }) => {
        const m = row.original;
        return (
          <span className="text-muted-foreground">
            {m.fromLocationName ?? (m.fromLocationId ? '…' : EM_DASH)}
            {' → '}
            {m.toLocationName ?? (m.toLocationId ? '…' : EM_DASH)}
          </span>
        );
      },
    },
    {
      id: 'job',
      accessorKey: 'jobNumber',
      header: 'Job',
      size: 150,
      meta: { label: 'Job' },
      cell: ({ row }) => {
        const m = row.original;
        return (
          <span className="block">
            {m.jobId ? (
              <Link to={v2Path(`/jobs/${m.jobId}`)} className="text-brand font-medium hover:underline">
                {m.jobNumber ?? 'Job'}
              </Link>
            ) : (
              <span className="text-muted-foreground">{EM_DASH}</span>
            )}
            {m.logisticOrderId && m.logisticOrderId !== logisticOrderId && (
              <Link
                to={`${v2Path('/inventory/activity')}?lo=${m.logisticOrderId}`}
                className="text-muted-foreground hover:text-brand mt-0.5 block font-mono text-[11px] hover:underline"
              >
                {m.logisticOrderNumber ?? 'Logistic Order'}
              </Link>
            )}
          </span>
        );
      },
    },
    {
      id: 'invoice',
      accessorKey: 'invoiceNumber',
      header: 'Invoice',
      size: 140,
      meta: { label: 'Invoice' },
      cell: ({ row }) => {
        const m = row.original;
        if (!m.invoiceId) return <span className="text-muted-foreground">{EM_DASH}</span>;
        return (
          <Link to={v2Path(`/invoices/${m.invoiceId}`)} className="text-brand font-medium hover:underline">
            {m.invoiceNumber ?? 'Invoice'}
          </Link>
        );
      },
    },
    {
      id: 'actor',
      accessorKey: 'actor',
      header: 'Actor',
      size: 150,
      meta: { label: 'Actor' },
      cell: ({ row }) => <span>{row.original.actor}</span>,
    },
    {
      id: 'reference',
      accessorKey: 'reference',
      header: 'Reference',
      size: 220,
      meta: { label: 'Reference' },
      cell: ({ row }) => (
        <span className="text-muted-foreground block max-w-[220px] truncate">{row.original.reference}</span>
      ),
    },
  ];

  // Cost rides along ONLY when the server did not strip it - the same
  // `rows.some(m => m.unitCost != null)` rule the legacy header used.
  if (hasCost) {
    columns.push({
      id: 'cost',
      accessorKey: 'unitCost',
      header: 'Cost',
      size: 110,
      meta: { label: 'Cost', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right font-mono">
          {row.original.unitCost != null ? formatCurrency(row.original.unitCost) : EM_DASH}
        </span>
      ),
    });
  }

  return columns;
}

export function ActionLogView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const logisticOrderId = searchParams.get('lo') ?? undefined;

  const [type, setType] = useState<MovementType | 'all'>('all');
  const [itemId, setItemId] = useState<string>('all');
  const [locationId, setLocationId] = useState<string>('all');
  const [actorUserId, setActorUserId] = useState<string>('all');
  const [occurredFrom, setOccurredFrom] = useState('');
  const [occurredTo, setOccurredTo] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const filters = useMemo<MovementFilters>(
    () => ({
      type: type === 'all' ? undefined : type,
      itemId: itemId === 'all' ? undefined : itemId,
      locationId: locationId === 'all' ? undefined : locationId,
      actorUserId: actorUserId === 'all' ? undefined : actorUserId,
      occurredFrom: occurredFrom || undefined,
      occurredTo: occurredTo || undefined,
      logisticOrderId,
    }),
    [type, itemId, locationId, actorUserId, occurredFrom, occurredTo, logisticOrderId],
  );

  const movementsQuery = useMovements({ ...filters, page, limit: PAGE_SIZE });
  // Pickers - the <=100-item window is acceptable for a filter dropdown (P5 2.2).
  const { data: items = [] } = useInventoryItems();
  const { data: locations = [] } = useLocations();
  const { data: techs = [] } = useTechs();

  const rows = useMemo(() => movementsQuery.data?.data ?? [], [movementsQuery.data]);
  const meta: PaginationMeta | undefined = movementsQuery.data?.meta;
  const hasCost = rows.some((m) => m.unitCost != null);

  function resetPage() {
    setPage(1);
  }

  // The LO filter can also change via a row link or Back navigation (not just
  // the dismiss chip / filter controls, which already call resetPage()) - keep
  // page in sync whenever it changes so a stale page 2+ doesn't strand the
  // user on an empty result set.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the filter can change via a row link or Back navigation, so pagination is reset on that navigation rather than during render
    resetPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logisticOrderId]);

  async function handleExport() {
    setExporting(true);
    try {
      // Current-view semantics: same filters, one capped snapshot page.
      const res = await api.get('/api/inventory/movements', {
        params: {
          type: filters.type,
          item_id: filters.itemId,
          location_id: filters.locationId,
          logistic_order_id: filters.logisticOrderId,
          actor_user_id: filters.actorUserId,
          occurred_from: filters.occurredFrom,
          occurred_to: filters.occurredTo,
          page: 1,
          limit: 100,
        },
      });
      const exportRows = (res.data as { data: Movement[] }).data ?? [];
      const withCost = exportRows.some((m) => m.unitCost != null);
      const csv = toCSV(
        exportRows.map((m) => ({
          time: m.occurredAt,
          type: m.type,
          sku: m.itemSku,
          item: m.itemName,
          qty: m.qty,
          from: m.fromLocationName ?? m.fromLocationId ?? '',
          to: m.toLocationName ?? m.toLocationId ?? '',
          job: m.jobNumber ?? '',
          invoice: m.invoiceNumber ?? '',
          actor: m.actor,
          reference: m.reference,
          ...(withCost ? { unitCost: m.unitCost ?? '' } : {}),
        })),
      );
      downloadCSV(csv, `stock-activity-${new Date().toISOString().slice(0, 10)}.csv`);
    } finally {
      setExporting(false);
    }
  }

  const columns = useMemo(
    () => buildMovementColumns({ hasCost, logisticOrderId }),
    [hasCost, logisticOrderId],
  );

  return (
    <div>
      <PageHeader
        title="Activity"
        description={`Every stock movement - receive, consume, return, transfer, adjust${
          meta ? ` · ${meta.total} total` : ''
        }`}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExport()}
            disabled={exporting || rows.length === 0}
          >
            <Download />
            Export CSV
          </Button>
        }
      />

      {logisticOrderId && (
        <div className="mb-3 flex items-center gap-2">
          <span className="border-input bg-brand-subtle inline-flex items-center gap-1 rounded-md border px-3 py-1 text-sm">
            Filtered to {rows[0]?.logisticOrderNumber ?? 'one Logistic Order'}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear Logistic Order filter"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('lo');
                setSearchParams(next, { replace: true });
                resetPage();
              }}
            >
              <X />
            </Button>
          </span>
        </div>
      )}

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        isLoading={movementsQuery.isLoading}
        enableColumnResizing
        mobileCards
        page={page}
        pageCount={meta?.totalPages ?? 1}
        onPageChange={setPage}
        initialPageSize={PAGE_SIZE}
        rowCount={meta?.total ?? rows.length}
        empty={
          <EmptyState
            title={movementsQuery.isLoading ? 'Loading activity…' : 'No movements match these filters.'}
          />
        }
      >
        {() => (
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <div className="w-40">
              <SelectField
                value={type}
                onValueChange={(v) => { setType(v as MovementType | 'all'); resetPage(); }}
                size="sm"
                aria-label="Filter by type"
                options={TYPE_OPTIONS}
              />
            </div>
            <div className="w-56">
              <SelectField
                value={itemId}
                onValueChange={(v) => { setItemId(v); resetPage(); }}
                size="sm"
                aria-label="Filter by item"
                options={[
                  { value: 'all', label: 'All items' },
                  ...items.map((i) => ({ value: i.id, label: `${i.sku} · ${i.name}` })),
                ]}
              />
            </div>
            <div className="w-48">
              <SelectField
                value={locationId}
                onValueChange={(v) => { setLocationId(v); resetPage(); }}
                size="sm"
                aria-label="Filter by location"
                options={[
                  { value: 'all', label: 'All locations' },
                  ...locations.map((l) => ({ value: l.id, label: l.name })),
                ]}
              />
            </div>
            <div className="w-48">
              <SelectField
                value={actorUserId}
                onValueChange={(v) => { setActorUserId(v); resetPage(); }}
                size="sm"
                aria-label="Filter by actor"
                options={[
                  { value: 'all', label: 'All actors' },
                  ...techs.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            </div>
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <DatePicker
                aria-label="From date"
                value={occurredFrom}
                max={occurredTo || undefined}
                onChange={(v) => { setOccurredFrom(v); resetPage(); }}
                className="w-[10rem]"
                inputClassName="h-8.5 px-2"
              />
              <span>to</span>
              <DatePicker
                aria-label="To date"
                value={occurredTo}
                min={occurredFrom || undefined}
                onChange={(v) => { setOccurredTo(v); resetPage(); }}
                className="w-[10rem]"
                inputClassName="h-8.5 px-2"
              />
            </div>
          </div>
        )}
      </DataTable>
    </div>
  );
}
