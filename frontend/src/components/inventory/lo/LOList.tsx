/**
 * LOList — the one Logistic Order list table, re-anchored by props (spec §7 / §12 rec 9).
 *
 *   • No anchor prop  → the standalone Inventory-module list (every LO in the org).
 *   • jobId / invoiceId / servicePlanId → the same table scoped to that parent (Job Logistics
 *     tab, Invoice detail tab). When anchored the Anchor column is dropped — every row shares it.
 *
 * Status FILTER CHIPS (StagingView pattern) drive the server query. The Pending chip carries a
 * badge count from a dedicated `status: PENDING_APPROVAL, limit: 1` query so the badge reflects
 * the true pending total regardless of the active filter (the Inventory `ViewTab` `highlight`
 * idea, inlined) — NOT a separate approvals surface (§12 rec 4). The create button is ability-
 * gated (`create LogisticOrder`); it and each row open the shared LODetailSheet.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Plus } from 'lucide-react';
import {
  useLogisticOrders,
  type LoListFilters,
  type LogisticOrderListRow,
  type LogisticOrderStatus,
} from '@/lib/api/logisticOrders';
import { useAppAbility } from '@/contexts/AbilityContext';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/data/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { LODetailSheet } from './LODetailSheet';
import { formatLoDate, primaryAnchor } from './loStatus';

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

export function LOList({ jobId, invoiceId, servicePlanId }: LOListProps) {
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
  const rows = listQuery.data?.data ?? [];

  // Dedicated true-total for the Pending badge — independent of the active filter (Inventory
  // tab-count idiom: limit 1, read `.total`).
  const pendingCountQuery = useLogisticOrders({ ...anchorFilter, status: 'PENDING_APPROVAL', limit: 1 });
  const pendingCount = pendingCountQuery.data?.total ?? 0;

  const [sheet, setSheet] = useState<{ open: boolean; loId: string | null }>({
    open: false,
    loId: null,
  });

  const colCount = isAnchored ? 5 : 6;

  return (
    <div className="rounded-card border border-border bg-surface-light shadow-card">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-text-secondary" />
          <Heading level={2} scale="base">Logistic Orders</Heading>
        </div>
        {canCreate && (
          <Button
            variant="solid" tone="business"
            size="sm"
            onClick={() => setSheet({ open: true, loId: null })}
          >
            <Plus className="h-4 w-4" />
            New logistic order
          </Button>
        )}
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-5 py-2.5">
        {CHIPS.map((chip) => {
          const active = filter === chip.value;
          const showPending = chip.value === 'PENDING_APPROVAL' && pendingCount > 0;
          return (
            // Not converted to Button: segmented filter-chip control
            // (StagingView pattern), not a Button shape.
            <button
              key={chip.value}
              type="button"
              onClick={() => setFilter(chip.value)}
              aria-pressed={active}
              className={[
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition',
                active
                  ? 'bg-primary text-on-fill'
                  : 'bg-background-light text-text-secondary hover:bg-border/60',
              ].join(' ')}
            >
              {chip.label}
              {showPending && (
                <span className="rounded-full bg-warning px-1.5 text-[10px] font-bold text-on-fill">
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-secondary">
              <th className="px-5 py-2.5">Number</th>
              <th className="px-3 py-2.5">Status</th>
              {!isAnchored && <th className="px-3 py-2.5">Anchor</th>}
              <th className="px-3 py-2.5 text-right">Items</th>
              <th className="px-3 py-2.5">Created</th>
              <th className="px-3 py-2.5">Processed</th>
            </tr>
          </thead>
          <tbody>
            {listQuery.isLoading &&
              [0, 1, 2].map((i) => (
                <tr key={`sk-${i}`} className="border-t border-border">
                  <td colSpan={colCount} className="px-5 py-3">
                    <div className="h-6 animate-pulse rounded-control bg-background-light" />
                  </td>
                </tr>
              ))}

            {!listQuery.isLoading &&
              rows.map((row) => (
                <LORow
                  key={row.id}
                  row={row}
                  showAnchor={!isAnchored}
                  onOpen={() => setSheet({ open: true, loId: row.id })}
                />
              ))}

            {!listQuery.isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={colCount}
                  className="px-5 py-12 text-center text-sm text-text-secondary"
                >
                  <EmptyState
                    title={
                      filter === 'all'
                        ? 'No logistic orders yet — create one to pull tracked parts for this work.'
                        : `No ${filter === 'PENDING_APPROVAL' ? 'pending' : filter.toLowerCase()} logistic orders.`
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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

function LORow({
  row,
  showAnchor,
  onOpen,
}: {
  row: LogisticOrderListRow;
  showAnchor: boolean;
  onOpen: () => void;
}) {
  const anchor = primaryAnchor(row.anchors);
  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-t border-border transition hover:bg-background-light"
    >
      <td className="px-5 py-3 font-medium text-text-primary">{row.number}</td>
      <td className="px-3 py-3">
        <StatusBadge domain="logisticOrder" status={row.status} />
      </td>
      {showAnchor && (
        <td className="px-3 py-3">
          {anchor ? (
            anchor.to ? (
              <Link
                to={anchor.to}
                onClick={(e) => e.stopPropagation()}
                className="text-primary hover:underline"
              >
                {anchor.label}
              </Link>
            ) : (
              <span className="text-text-secondary">{anchor.label}</span>
            )
          ) : (
            <span className="text-text-secondary">Standalone</span>
          )}
        </td>
      )}
      <td className="px-3 py-3 text-right tabular-nums text-text-primary">{row.lineCount}</td>
      <td className="px-3 py-3 text-text-secondary">{formatLoDate(row.createdAt)}</td>
      <td className="px-3 py-3 text-text-secondary">{formatLoDate(row.processedAt)}</td>
    </tr>
  );
}
