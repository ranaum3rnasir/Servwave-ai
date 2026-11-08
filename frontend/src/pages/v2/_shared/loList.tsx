/**
 * The Logistic Orders list, rebuilt on the CRM UI kit.
 *
 * SHARED, not module-owned. Two v2 modules render it: Inventory's
 * `/inventory/logistic-orders` tab mounts it bare, and the Jobs detail page
 * mounts it anchored (`jobId`). Module isolation forbids Jobs importing an
 * Inventory file, and the alternative - Jobs keeping the LEGACY component -
 * put legacy chrome inside a v2 page. It qualifies on the folder's own terms:
 * everything it varies (`jobId` / `invoiceId` / `servicePlanId`) arrives as a
 * prop, and nothing it imports reaches back into a module folder.
 *
 * A presentation swap over `components/inventory/lo/LOList.tsx`. Every query
 * (`useLogisticOrders` with the same anchor filter and the same dedicated
 * `status: PENDING_APPROVAL, limit: 1` badge query), the `create
 * LogisticOrder` ability gate, the anchor-column drop when the list is
 * anchored, the row -> LODetailSheet contract and every user-visible string are
 * the legacy component's, unchanged.
 *
 * What moved onto the kit:
 *   - the hand-rolled card header becomes a kit PageHeader.
 *   - the hand-rolled `<button>` pill chips become kit Buttons carrying
 *     `aria-pressed` inside a `role="group"` - the same segmented idiom
 *     VendorsPage uses. The legacy pills expressed their state only in colour.
 *   - the hand-rolled `<table>` becomes the kit DataTable, which brings its own
 *     loading skeletons (the legacy three grey bars), empty slot and footer.
 *   - `data/status-badge` becomes the shared v2 StatusChip, which reads the
 *     same `design-system/status-registry` entry.
 *
 * KEPT LEGACY: `LODetailSheet` (648 lines of create/submit/approve/process/
 * cancel mutations) and the `loStatus` helpers, which are pure logic.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';

import {
  useLogisticOrders,
  type LoListFilters,
  type LogisticOrderListRow,
  type LogisticOrderStatus,
} from '@/lib/api/logisticOrders';
import { useAppAbility } from '@/contexts/AbilityContext';
import { LODetailSheet } from '@/components/inventory/lo/LODetailSheet';
import { formatLoDate, primaryAnchor } from '@/components/inventory/lo/loStatus';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';

import { StatusChip } from './statusChip';
import { useRecordVisit } from '../pageBreadcrumbs';

export interface LOListProps {
  /** Scope the list (and pre-anchor new orders) to a job. */
  jobId?: string;
  /** Scope the list to an invoice. */
  invoiceId?: string;
  /** Scope the list to a service plan. */
  servicePlanId?: string;
}

type ChipValue = 'all' | LogisticOrderStatus;

const CHIPS: { value: ChipValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PROCESSED', label: 'Processed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'RETURNED', label: 'Returned' },
];

function buildLOColumns(showAnchor: boolean): ColumnDef<LogisticOrderListRow, unknown>[] {
  const columns: ColumnDef<LogisticOrderListRow, unknown>[] = [
    {
      id: 'number',
      accessorKey: 'number',
      header: 'Number',
      size: 140,
      meta: { label: 'Number', fixed: true },
      cell: ({ row }) => <span className="font-medium">{row.original.number}</span>,
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: 'Status',
      size: 130,
      meta: { label: 'Status', fixed: true },
      cell: ({ row }) => <StatusChip domain="logisticOrder" status={row.original.status} />,
    },
  ];

  if (showAnchor) {
    columns.push({
      id: 'anchor',
      accessorKey: 'anchors',
      header: 'Anchor',
      size: 180,
      meta: { label: 'Anchor' },
      cell: ({ row }) => {
        const anchor = primaryAnchor(row.original.anchors);
        if (!anchor) return <span className="text-muted-foreground">Standalone</span>;
        if (!anchor.to) return <span className="text-muted-foreground">{anchor.label}</span>;
        // A router Link, not a Button: middle-click and open-in-new-tab are
        // the whole point of an anchor to another record.
        return (
          <Link
            to={anchor.to}
            onClick={(e) => e.stopPropagation()}
            className="text-brand hover:underline"
          >
            {anchor.label}
          </Link>
        );
      },
    });
  }

  columns.push(
    {
      id: 'lineCount',
      accessorKey: 'lineCount',
      header: 'Items',
      size: 90,
      meta: { label: 'Items', fixed: true },
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">{row.original.lineCount}</span>
      ),
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: 'Created',
      size: 130,
      meta: { label: 'Created', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatLoDate(row.original.createdAt)}</span>
      ),
    },
    {
      id: 'processedAt',
      accessorKey: 'processedAt',
      header: 'Processed',
      size: 130,
      meta: { label: 'Processed', fixed: true },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{formatLoDate(row.original.processedAt)}</span>
      ),
    },
  );

  return columns;
}

export function LOList({ jobId, invoiceId, servicePlanId }: LOListProps) {
  useRecordVisit('inventory', 'Logistic Orders');
  const ability = useAppAbility();
  const canCreate = ability.can('create', 'LogisticOrder');

  const anchorFilter = useMemo<LoListFilters>(
    () => ({
      ...(jobId ? { job_id: jobId } : {}),
      ...(invoiceId ? { invoice_id: invoiceId } : {}),
      ...(servicePlanId ? { service_plan_id: servicePlanId } : {}),
    }),
    [jobId, invoiceId, servicePlanId],
  );
  const isAnchored = Boolean(jobId || invoiceId || servicePlanId);

  const [filter, setFilter] = useState<ChipValue>('all');
  const listQuery = useLogisticOrders({
    ...anchorFilter,
    ...(filter !== 'all' ? { status: filter } : {}),
  });
  const rows = useMemo(() => listQuery.data?.data ?? [], [listQuery.data]);

  // Dedicated true-total for the Pending badge - independent of the active
  // filter (Inventory tab-count idiom: limit 1, read `.total`).
  const pendingCountQuery = useLogisticOrders({ ...anchorFilter, status: 'PENDING_APPROVAL', limit: 1 });
  const pendingCount = pendingCountQuery.data?.total ?? 0;

  const [sheet, setSheet] = useState<{ open: boolean; loId: string | null }>({
    open: false,
    loId: null,
  });

  const columns = useMemo(() => buildLOColumns(!isAnchored), [isAnchored]);

  return (
    <div>
      {/* The legacy card header carried a decorative `Boxes` icon beside the
          title. PageHeader has no icon slot and the kit drops decorative
          header icons everywhere else, so it goes - a ledger row, not a
          silent loss. The heading also moves from level 2 to PageHeader's h1,
          which is the level every other v2 Inventory tab body already uses. */}
      <PageHeader
        title="Logistic Orders"
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setSheet({ open: true, loId: null })}>
              <Plus />
              New logistic order
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        isLoading={listQuery.isLoading}
        onRowClick={(row) => setSheet({ open: true, loId: row.id })}
        enableColumnResizing
        mobileCards
        empty={
          <EmptyState
            title={
              filter === 'all'
                ? 'No logistic orders yet - create one to pull tracked parts for this work.'
                : `No ${filter === 'PENDING_APPROVAL' ? 'pending' : filter.toLowerCase()} logistic orders.`
            }
          />
        }
      >
        {() => (
          <div
            role="group"
            aria-label="Logistic order status"
            className="flex flex-wrap items-center gap-2 border-b px-4 py-3"
          >
            {CHIPS.map((chip) => {
              const active = filter === chip.value;
              const showPending = chip.value === 'PENDING_APPROVAL' && pendingCount > 0;
              return (
                <Button
                  key={chip.value}
                  variant={active ? 'default' : 'ghost'}
                  size="sm"
                  aria-pressed={active}
                  className="rounded-full"
                  onClick={() => setFilter(chip.value)}
                >
                  {chip.label}
                  {showPending && (
                    <Badge variant="amber" size="pill">
                      {pendingCount}
                    </Badge>
                  )}
                </Button>
              );
            })}
          </div>
        )}
      </DataTable>

      {sheet.open && (
        <LODetailSheet
          open={sheet.open}
          onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
          loId={sheet.loId}
          anchor={{ jobId, invoiceId, servicePlanId }}
        />
      )}
    </div>
  );
}
