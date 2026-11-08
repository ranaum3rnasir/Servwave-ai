/**
 * The Staging tab body, rebuilt on the CRM UI kit.
 *
 * The routed Staging view (the legacy `components/inventory/StagingView.tsx` it replaced was deleted in PR 1 of the purchasing audit),
 * the largest of the five sub-views. Every piece of behaviour below is the
 * legacy component's, copied verbatim:
 *
 *   - the three seam queries (`useJobStages`, `usePurchaseOrders`, `useVendors`)
 *     and the two mutations (`useReceiveStageLine`, `useNotifyTechReady`), with
 *     the same local `stages` mirror re-seeded from the query on every change.
 *     Creating a stage is NOT mutated here: `CreateStageDialog` is the sole
 *     writer of a new stage (S4.4 removed the view's duplicate POST);
 *   - `markReady`, `setStagedArea` (including the StageAuditEntry it appends
 *     and the actor name taken from the auth store) and `receiveOne` with its
 *     awaiting/partial/complete recomputation - all unchanged, including every
 *     toast string;
 *   - the `pendingIntent` bell contract: an `{ id, nonce }` forwarded from
 *     InventoryPage opens StageDetailDialog by id, and re-fires on the same id;
 *   - the available-PO filter (not already staged, not received, not closed);
 *   - the single-active KPI/filter coupling - the tiles and the chips are the
 *     same `filter` state.
 *
 * What moved onto the kit:
 *   - the hand-rolled header becomes PageHeader, and the breadcrumb moves to
 *     the layout (it draws the trail once, for every route);
 *   - `data/KpiStrip`'s five KpiTiles become kit StatCards (no icon slot - the
 *     module-wide gap);
 *   - the raw two-state "From PO" trigger and its absolutely positioned panel
 *     become a kit Popover;
 *   - the raw pill filter tabs become kit Buttons carrying `aria-pressed`;
 *   - each stage card becomes a kit Card, its progress bar the kit Progress,
 *     its status the shared v2 StatusChip, and the five raw action buttons
 *     inside it kit Buttons.
 *
 * KEPT LEGACY: `CreateStageDialog`, `StageDetailDialog`, `POPreviewDialog` and
 * `StagingAreaPicker` - all four are mutation/validation surfaces, not chrome.
 */
import type React from 'react';
import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Calendar, CheckCircle2, ChevronDown, Clock, Eye,
  FileText, MapPin, Package, PackageCheck, Plus, Send, Truck, User,
} from 'lucide-react';

import { CreateStageDialog } from '@/components/inventory/CreateStageDialog';
import { StageDetailDialog } from '@/components/inventory/StageDetailDialog';
import { POPreviewDialog } from '@/components/inventory/POPreviewDialog';
import { StagingAreaPicker } from '@/components/inventory/StagingAreaPicker';
import {
  useJobStages, usePurchaseOrders, useVendors,
  useReceiveStageLine, useNotifyTechReady,
} from '@/lib/api/inventory';
import type { JobStage, StageAuditEntry, Location, PurchaseOrder } from '@/lib/api/inventory';
// `StagingStatus` is not re-exported by the seam; the legacy view imports the
// type from `_mock` for the same reason, and a type-only import never pulls a
// runtime value out of the mock module.
import type { StagingStatus } from '@/lib/api/_mock/inventory';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { Progress } from '@/ui-kit/components/ui/progress';
import { cn } from '@/ui-kit/lib/utils';

import { StatusChip } from '../../_shared/statusChip';
import { EM_DASH } from '../glyphs';

/**
 * Local copy of the seam helper until it is re-exported - verbatim-pure, and
 * the legacy view carries the identical copy for the identical reason.
 */
function stageProgress(s: JobStage): { received: number; ordered: number; pct: number } {
  const received = s.items.reduce((sum, i) => sum + i.qtyReceived, 0);
  const ordered = s.items.reduce((sum, i) => sum + i.qtyOrdered, 0);
  return { received, ordered, pct: ordered === 0 ? 0 : Math.round((received / ordered) * 100) };
}

type Props = {
  locations: Location[];
  onToast: (msg: string) => void;
  // Forwarded from InventoryPage when the TopBar bell fires a staging_*
  // intent. The `nonce` changes on every click so the effect re-runs even
  // when the same id is re-clicked.
  pendingIntent?: { id: string; nonce: number } | null;
};

const filterTabs: { value: StagingStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All Stages' },
  { value: 'awaiting', label: 'Awaiting' },
  { value: 'partial', label: 'Partial' },
  { value: 'complete', label: 'Ready' },
  { value: 'ready_for_pickup', label: 'Ready for pickup' },
];

/**
 * Trade -> Badge variant.
 *
 * The legacy pill painted itself from the seam's `tradeColor` map, which is a
 * bag of LEGACY token classes. A v2 file paints from the kit's own palette
 * instead, so the trade chip matches every other qualifier chip in the layer.
 */
const TRADE_VARIANT: Record<string, 'softAmber' | 'softBlue' | 'softPurple'> = {
  locksmith: 'softAmber',
  door: 'softBlue',
  security: 'softPurple',
  hvac: 'softAmber',
  plumbing: 'softBlue',
  multi: 'softBlue',
};

/** "locksmith" -> "Locksmith". Replaces the legacy chip's CSS `capitalize`. */
function tradeLabel(trade: string): string {
  return trade.charAt(0).toUpperCase() + trade.slice(1);
}

export function StagingView({ locations, onToast, pendingIntent }: Props) {
  // Live data from the seam. Local `stages` mirrors the query result so the
  // in-memory receive / mark-ready / staging-area edits stay responsive.
  // No `= []` default: the seed effect below keys on this, and a fresh array
  // per render would re-fire it forever. Same rule as `PriceBookPage`.
  const { data: seedStages } = useJobStages();
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const { data: allVendors = [] } = useVendors();
  const receiveStageLine = useReceiveStageLine();
  const notifyTechReady = useNotifyTechReady();

  // Actor identity for audit entries comes from the auth store.
  const authUser = useAuthStore((s) => s.user);
  const actorName = authUser ? `${authUser.first_name} ${authUser.last_name}`.trim() : 'Unknown user';

  // #2043 §E - New Pickup / From PO / Create New Pickup all POST /job-stages
  // (create Inventory); Receive +1, Notify Tech / Mark Delivered and the
  // staging-area picker all ride update Inventory routes.
  const ability = useAppAbility();
  const canCreate = ability.can('create', 'Inventory');
  const canUpdate = ability.can('update', 'Inventory');

  // `?? []` in the INITIALISER, which runs once, and never in the effect's
  // dependency - that distinction is the whole fix. A `= []` default on the
  // query mints a new array every render and re-fires the effect forever; a
  // fallback evaluated once cannot. Seeding here rather than starting empty
  // also matters beyond the first paint: `expandedId` below reads `stages[0]`
  // as ITS initial state, so a first render with no stages leaves the first
  // card collapsed permanently.
  const [stages, setStages] = useState<JobStage[]>(seedStages ?? []);
  // Re-seed local state when the query data arrives / changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stages mirror is re-seeded from the query, then mutated as stages are created and advanced in-page
    if (seedStages) setStages(seedStages);
  }, [seedStages]);

  const [filter, setFilter] = useState<StagingStatus | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(stages[0]?.id ?? null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailStage = stages.find((s) => s.id === detailId) ?? null;

  // Bell-driven open: when InventoryPage forwards a staging_* intent, open
  // StageDetailDialog by id. The `nonce` ensures the effect re-fires for
  // repeat clicks.
  useEffect(() => {
    if (!pendingIntent) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opens the detail dialog for an intent forwarded from the alert bus; the nonce makes a repeat bell click re-fire
    setDetailId(pendingIntent.id);
  }, [pendingIntent?.id, pendingIntent?.nonce]);

  const [showCreate, setShowCreate] = useState(false);
  const [prefilledPO, setPrefilledPO] = useState<PurchaseOrder | null>(null);
  // The Popover owns its own outside-click and Escape handling, so the legacy
  // document-level mousedown/keydown listeners are gone with it.
  const [showPOPicker, setShowPOPicker] = useState(false);
  const [previewPONumber, setPreviewPONumber] = useState<string | null>(null);

  // POs already staged (or fully received) are excluded from the picker
  const stagedPONumbers = new Set(stages.flatMap((s) => s.items.map((i) => i.poNumber)));
  const availablePOs = purchaseOrders.filter(
    (po) =>
      !po.stagedAsJobStageId &&
      !stagedPONumbers.has(po.poNumber) &&
      po.status !== 'received' &&
      po.status !== 'closed',
  );

  const filtered = filter === 'all' ? stages : stages.filter((s) => s.status === filter);

  function counts(s: StagingStatus | 'all') {
    if (s === 'all') return stages.length;
    return stages.filter((x) => x.status === s).length;
  }

  function markReady(id: string) {
    const stage = stages.find((s) => s.id === id);
    setStages((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, status: s.status === 'ready_for_pickup' ? 'delivered' : 'ready_for_pickup' }
          : s,
      ),
    );
    // Mock mutation: notifies the tech that a stage is ready for pickup.
    notifyTechReady.mutate({ stageId: id });
    onToast(
      stage?.status === 'ready_for_pickup'
        ? `✓ ${stage?.jobNumber} marked delivered`
        : `✓ ${stage?.jobNumber} marked ready for pickup · tech notified`,
    );
  }

  /**
   * Update the staging area (zone within the warehouse) for a stage. Every
   * pick / change / clear is recorded in the stage's audit log so the activity
   * feed shows who put the parts where, and when.
   */
  function setStagedArea(id: string, next: string | undefined) {
    let toastJob: string | undefined;
    let toastArea: string | undefined;
    setStages((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        toastJob = s.jobNumber;
        toastArea = next;
        // Skip the audit entry if nothing actually changed.
        if ((s.stagedArea ?? undefined) === (next ?? undefined)) {
          return { ...s, stagedArea: next };
        }
        const entry: StageAuditEntry = {
          id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          at: new Date().toISOString(),
          actorName,
          field: 'stagedArea',
          oldValue: s.stagedArea,
          newValue: next ?? '(cleared)',
          comment: next
            ? s.stagedArea
              ? `Moved from "${s.stagedArea}" to "${next}"`
              : `Placed in "${next}"`
            : `Cleared (was "${s.stagedArea ?? EM_DASH}")`,
        };
        return {
          ...s,
          stagedArea: next,
          updatedAt: new Date().toISOString(),
          auditLog: [...(s.auditLog ?? []), entry],
        };
      }),
    );
    if (toastJob) {
      if (toastArea) {
        onToast(`📍 ${toastJob} staged in ${toastArea}`);
      } else {
        onToast(`📍 ${toastJob} staging area cleared`);
      }
    }
  }

  function receiveOne(stageId: string, itemId: string) {
    setStages((prev) =>
      prev.map((s) => {
        if (s.id !== stageId) return s;
        const items = s.items.map((it) =>
          it.id === itemId
            ? { ...it, qtyReceived: Math.min(it.qtyOrdered, it.qtyReceived + 1) }
            : it,
        );
        const allIn = items.every((i) => i.qtyReceived >= i.qtyOrdered);
        const anyIn = items.some((i) => i.qtyReceived > 0);
        const newStatus: StagingStatus = allIn ? 'complete' : anyIn ? 'partial' : 'awaiting';
        return { ...s, items, status: newStatus };
      }),
    );
    // Mock mutation: records a single-unit receipt against the stage line.
    receiveStageLine.mutate({ stageId, itemId });
  }

  const totals = {
    stages: stages.length,
    awaiting: counts('awaiting'),
    partial: counts('partial'),
    complete: counts('complete'),
    ready: counts('ready_for_pickup'),
  };

  return (
    <div>
      <PageHeader
        title="Job Staging"
        description="Track parts received for specific jobs · partial shipments + backorders + ready-for-pickup."
        actions={
          canCreate ? (
            <>
            <Popover open={showPOPicker} onOpenChange={setShowPOPicker}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" aria-expanded={showPOPicker}>
                  <FileText />
                  From PO
                  <Badge variant="softBlue" size="pill">{availablePOs.length}</Badge>
                  <ChevronDown className={cn('transition', showPOPicker && 'rotate-180')} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[460px] max-w-[calc(100vw-1.5rem)] p-0">
                <div className="border-b px-3 py-2">
                  <p className="text-sm font-semibold">Open logistics orders</p>
                  <p className="text-muted-foreground text-[11px]">
                    Pick a PO to pre-fill a new staging pickup
                  </p>
                </div>
                <div className="max-h-[420px] overflow-y-auto py-1">
                  {availablePOs.length === 0 ? (
                    <div className="text-muted-foreground px-4 py-6 text-center text-xs">
                      All open POs are already staged 🎉
                    </div>
                  ) : (
                    availablePOs.map((po) => {
                      const qty = po.lines.reduce((s, l) => s + l.qtyOrdered, 0);
                      return (
                        <div key={po.id} className="hover:bg-muted flex w-full flex-col gap-1 border-t px-3 py-2.5 text-left">
                          <div className="flex items-center justify-between gap-2">
                            <div
                              role="button"
                              tabIndex={0}
                              className="flex flex-1 cursor-pointer items-center gap-2"
                              onClick={() => {
                                setPrefilledPO(po);
                                setShowCreate(true);
                                setShowPOPicker(false);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setPrefilledPO(po);
                                  setShowCreate(true);
                                  setShowPOPicker(false);
                                }
                              }}
                            >
                              <code className="bg-brand-subtle text-brand rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold">
                                {po.poNumber}
                              </code>
                              <span className="text-sm font-semibold">{po.vendor}</span>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              title="Preview PO as PDF · print"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowPOPicker(false);
                                setPreviewPONumber(po.poNumber);
                              }}
                            >
                              <Eye />
                              Preview
                            </Button>
                            <Badge variant="softNeutral" size="pill">
                              {po.lines.length} lines · {qty} units
                            </Badge>
                          </div>
                          {po.customer && (
                            <div className="text-muted-foreground flex items-center gap-1 text-xs">
                              <Package className="size-3" />
                              <span className="font-medium">{po.jobNumber}</span>
                              <span>·</span>
                              <span>{po.customer}</span>
                            </div>
                          )}
                          {po.expectedDate && (
                            <div className="text-status-amber-emphasis flex items-center gap-1 text-[11px]">
                              <Clock className="size-3" />
                              ETA{' '}
                              {new Date(po.expectedDate).toLocaleDateString(undefined, {
                                weekday: 'short', month: 'short', day: 'numeric',
                              })}
                            </div>
                          )}
                          {!po.customer && (
                            <div className="text-muted-foreground text-[11px] italic">
                              No job linked · pick a job during staging
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </PopoverContent>
            </Popover>
            <Button size="sm" onClick={() => { setPrefilledPO(null); setShowCreate(true); }}>
              <Plus />
              New Pickup
            </Button>
            </>
          ) : undefined
        }
      />

      {/* Quick stats - the same five buckets, still the single source of the
          `filter` state, so lighting one clears the other four. */}
      <StatCardGroup className="mb-4 xl:grid-cols-5">
        <StatCard
          label="Active Stages"
          value={totals.stages}
          tone="brand"
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <StatCard
          label="Awaiting"
          value={totals.awaiting}
          active={filter === 'awaiting'}
          onClick={() => setFilter('awaiting')}
        />
        <StatCard
          label="Partial"
          value={totals.partial}
          tone="amber"
          active={filter === 'partial'}
          onClick={() => setFilter('partial')}
        />
        <StatCard
          label="Ready"
          value={totals.complete}
          tone="green"
          active={filter === 'complete'}
          onClick={() => setFilter('complete')}
        />
        <StatCard
          label="Ready for pickup"
          value={totals.ready}
          tone="blue"
          active={filter === 'ready_for_pickup'}
          onClick={() => setFilter('ready_for_pickup')}
        />
      </StatCardGroup>

      {/* Filter chips */}
      <div role="group" aria-label="Stage filter" className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs font-semibold uppercase">Filter</span>
        {filterTabs.map((t) => {
          const active = filter === t.value;
          return (
            <Button
              key={t.value}
              variant={active ? 'default' : 'ghost'}
              size="sm"
              aria-pressed={active}
              className="rounded-full"
              onClick={() => setFilter(t.value)}
            >
              {t.label}
              <Badge variant={active ? 'outline' : 'softNeutral'} size="pill">{counts(t.value)}</Badge>
            </Button>
          );
        })}
      </div>

      {/* Stage cards */}
      <div className="flex flex-col gap-3">
        {/* The legacy empty box was dashed. Card's appearance ratchet is at its
            ceiling, so it takes the kit's solid card border. */}
        {filtered.length === 0 && (
          <Card>
            <EmptyState
              title="No staged jobs match this filter."
              action={
                canCreate ? (
                  <Button size="sm" onClick={() => setShowCreate(true)}>
                    <Plus />
                    Create New Pickup
                  </Button>
                ) : undefined
              }
            />
          </Card>
        )}
        {filtered.map((stage) => (
          <StageCard
            key={stage.id}
            stage={stage}
            locations={locations}
            vendors={allVendors}
            expanded={expandedId === stage.id}
            canUpdate={canUpdate}
            onToggle={() => setExpandedId(expandedId === stage.id ? null : stage.id)}
            onMarkReady={() => markReady(stage.id)}
            onReceiveOne={(itemId) => receiveOne(stage.id, itemId)}
            onOpenDetail={() => setDetailId(stage.id)}
            onPreviewPO={(poNumber) => setPreviewPONumber(poNumber)}
            onChangeStagedArea={canUpdate ? (next) => setStagedArea(stage.id, next) : undefined}
          />
        ))}
      </div>

      <StageDetailDialog
        open={!!detailStage}
        onClose={() => setDetailId(null)}
        stage={detailStage}
        locations={locations}
        onReceiveOne={(stageId, itemId) => receiveOne(stageId, itemId)}
        onSave={(updated, audit) => {
          setStages((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
          onToast(
            `✓ ${updated.jobNumber} updated · ${audit.length} change${audit.length === 1 ? '' : 's'} logged to audit trail`,
          );
        }}
        onEmailSent={(s, to) => {
          onToast(
            `✉ Pickup ticket for ${s.jobNumber} sent to ${to.length} recipient${to.length === 1 ? '' : 's'} · ${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}`,
          );
        }}
      />

      <CreateStageDialog
        open={showCreate}
        onClose={() => { setShowCreate(false); setPrefilledPO(null); }}
        locations={locations}
        prefilledFromPO={prefilledPO}
        onCreate={(stage) => {
          // Local view only - CreateStageDialog owns the POST. Firing the
          // mutation here too wrote every stage to the database TWICE (S4.4;
          // pinned by `__tests__/staging-create-once.test.tsx`).
          setStages((prev) => [stage, ...prev]);
          setExpandedId(stage.id);
          setFilter('all');
          const fromPO = prefilledPO?.poNumber;
          onToast(
            fromPO
              ? `✓ Staging created for ${stage.jobNumber} from ${fromPO} · ${stage.items.length} line${stage.items.length === 1 ? '' : 's'}`
              : `✓ Pickup created for ${stage.jobNumber} · ${stage.items.length} line item${stage.items.length === 1 ? '' : 's'} ordered`,
          );
        }}
      />

      <POPreviewDialog
        open={!!previewPONumber}
        onClose={() => setPreviewPONumber(null)}
        poNumber={previewPONumber}
      />
    </div>
  );
}

function StageCard({
  stage, locations, vendors, expanded, canUpdate, onToggle, onMarkReady, onReceiveOne,
  onOpenDetail, onPreviewPO, onChangeStagedArea,
}: {
  stage: JobStage;
  locations: Location[];
  vendors: { id: string; name: string }[];
  expanded: boolean;
  canUpdate: boolean;
  onToggle: () => void;
  onMarkReady: () => void;
  onReceiveOne: (itemId: string) => void;
  onOpenDetail: () => void;
  onPreviewPO: (poNumber: string) => void;
  onChangeStagedArea?: (next: string | undefined) => void;
}) {
  const { received, ordered, pct } = stageProgress(stage);
  const stagedLoc = locations.find((l) => l.id === stage.stagedLocationId);
  const isReady = stage.status === 'complete' || stage.status === 'ready_for_pickup';

  // Clicking the job# or customer name jumps straight to Full Transaction
  // (Stage Detail Dialog) - avoids the extra step of expanding the accordion
  // and hunting for "Open Full Transaction" in the footer.
  const openDetailFromHeader = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenDetail();
  };

  return (
    <Card className="gap-0 overflow-hidden">
      {/* Card head */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="hover:bg-muted flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition"
      >
        <ChevronDown className={cn('text-muted-foreground mt-0.5 size-4 shrink-0 transition', !expanded && '-rotate-90')} />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 font-mono text-[11px] font-semibold"
              title="Open Full Transaction"
              onClick={openDetailFromHeader}
            >
              {stage.jobNumber}
            </Button>
            <Button
              variant="link"
              size="sm"
              className="text-foreground hover:text-brand h-auto p-0 text-sm font-semibold"
              title="Open Full Transaction"
              onClick={openDetailFromHeader}
            >
              {stage.customer}
            </Button>
            {/* The legacy chip capitalised the raw trade in CSS. Badge's
                appearance ratchet is at its ceiling, so the capital comes from
                the label instead - same rendered text, different DOM text. */}
            <Badge variant={TRADE_VARIANT[stage.trade] ?? 'softNeutral'} size="pill">
              {stage.trade === 'multi' ? 'Multi-trade' : tradeLabel(stage.trade)}
            </Badge>
            <StatusChip domain="stage" status={stage.status} />
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="flex items-center gap-1">
              <MapPin className="size-3" />
              {stage.site}
            </span>
            {stage.assignedTech && (
              <span className="flex items-center gap-1">
                <User className="size-3" />
                {stage.assignedTech}
              </span>
            )}
            {stage.scheduledFor && (
              <span className="flex items-center gap-1">
                <Calendar className="size-3" />
                {new Date(stage.scheduledFor).toLocaleString(undefined, {
                  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </span>
            )}
            {stage.pickupVendorId ? (
              <span className="text-brand flex items-center gap-1">
                <Package className="size-3" />
                Pickup at {vendors.find((v) => v.id === stage.pickupVendorId)?.name ?? 'Vendor'}
                {stage.pickupAddress ? ` · ${stage.pickupAddress.slice(0, 48)}` : ''}
              </span>
            ) : stagedLoc ? (
              <span className="flex items-center gap-1">
                <Package className="size-3" />
                Staged at {stagedLoc.name}
                {stage.stagedArea && (
                  <span className="text-brand font-medium">{' · '}{stage.stagedArea}</span>
                )}
              </span>
            ) : null}
          </div>
        </div>
        <div className="ms-2 flex w-44 shrink-0 flex-col items-end gap-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-sm font-semibold">{received}</span>
            <span className="text-muted-foreground text-xs">/ {ordered}</span>
            <span className="text-muted-foreground text-[10px]">received</span>
          </div>
          <Progress value={pct} className="w-full" />
          <span className="text-muted-foreground text-[10px] font-medium">{pct}% complete</span>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t">
          {/* Items list */}
          <div className="px-4 py-3">
            <span role="heading" aria-level={3} className="text-muted-foreground mb-2 block text-[10px] font-semibold uppercase">
              Line items
            </span>
            <div className="bg-kit-card overflow-hidden rounded-md border">
              {stage.items.map((it, idx) => {
                const remaining = it.qtyOrdered - it.qtyReceived;
                const itemDone = remaining === 0;
                return (
                  <div
                    key={it.id}
                    className={cn(
                      'grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2.5',
                      idx > 0 && 'border-t',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-muted-foreground font-mono text-[10px]">{it.itemSku}</code>
                        {it.serialized && (
                          <Badge variant="softPurple" size="pill">serialized</Badge>
                        )}
                      </div>
                      <p className="truncate text-sm font-medium">{it.itemName}</p>
                      <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                        <span>{it.vendor}</span>
                        <span>·</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-[11px]"
                          title="Preview PO as PDF · print"
                          onClick={(e) => { e.stopPropagation(); onPreviewPO(it.poNumber); }}
                        >
                          <Eye />
                          {it.poNumber}
                        </Button>
                        {!itemDone && it.expectedDate && (
                          <>
                            <span>·</span>
                            <span className="text-status-amber-emphasis inline-flex items-center gap-0.5">
                              <Clock className="size-3" />
                              ETA {new Date(it.expectedDate).toLocaleDateString(undefined, {
                                month: 'short', day: 'numeric',
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Qty progress */}
                    <div className="flex flex-col items-end gap-0.5 font-mono text-xs">
                      <div className="flex items-baseline gap-1">
                        <span
                          className={cn(
                            'font-semibold',
                            itemDone ? 'text-status-green-emphasis' : 'text-status-amber-emphasis',
                          )}
                        >
                          {it.qtyReceived}
                        </span>
                        <span className="text-muted-foreground">/ {it.qtyOrdered}</span>
                        <span className="text-muted-foreground text-[10px]">{it.uom}</span>
                      </div>
                      {remaining > 0 && (
                        <span className="text-status-amber-emphasis flex items-center gap-0.5 text-[10px] font-medium">
                          <AlertTriangle className="size-2.5" />
                          {remaining} backordered
                        </span>
                      )}
                      {itemDone && (
                        <span className="text-status-green-emphasis inline-flex items-center gap-0.5 text-[10px] font-medium">
                          <CheckCircle2 className="size-2.5" />
                          Complete
                        </span>
                      )}
                    </div>

                    {/* Receive +1 action */}
                    {!itemDone && canUpdate ? (
                      <Button
                        variant="outline"
                        size="sm"
                        title="Receive 1 more unit (simulate partial delivery)"
                        onClick={() => onReceiveOne(it.id)}
                      >
                        Receive +1
                      </Button>
                    ) : (
                      <span className="text-muted-foreground px-2 py-1 text-xs">{EM_DASH}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Staging area picker - surfaces once the stage has anything to
              place on the shelf. Vendor-pickup stages don't need this. */}
          {!stage.pickupVendorId && stagedLoc && (
            <div className="bg-muted flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2">
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <MapPin className="text-brand size-3.5" />
                <span className="text-[10px] font-semibold uppercase">
                  Staging area in {stagedLoc.name}
                </span>
                {/* The legacy pill upper-cased this in CSS; the kit Badge keeps
                    its own casing (appearance ratchet at ceiling). */}
                {!stage.stagedArea && isReady && (
                  <Badge variant="softAmber" size="pill">
                    Tell the tech where
                  </Badge>
                )}
              </div>
              {onChangeStagedArea ? (
                <StagingAreaPicker
                  parentLocation={stagedLoc}
                  value={stage.stagedArea}
                  onChange={onChangeStagedArea}
                />
              ) : (
                <span className="text-muted-foreground text-xs">{stage.stagedArea ?? EM_DASH}</span>
              )}
            </div>
          )}

          {/* Notes + actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
            <div className="text-muted-foreground flex-1 text-xs">
              {stage.notes ? <p>📝 {stage.notes}</p> : <p>No notes</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canUpdate && stage.status === 'complete' && (
                <Button size="sm" onClick={onMarkReady}>
                  <Send />
                  Notify Tech · Ready for Pickup
                </Button>
              )}
              {canUpdate && stage.status === 'ready_for_pickup' && (
                <Button size="sm" onClick={onMarkReady}>
                  <Truck />
                  Mark Delivered to Tech
                </Button>
              )}
              {(stage.status === 'awaiting' || stage.status === 'partial') && (
                <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                  <Clock className="size-3" />
                  Awaiting remaining vendor deliveries
                </span>
              )}
              {isReady && (
                <span className="text-status-green-emphasis inline-flex items-center gap-1 text-xs font-medium">
                  <PackageCheck className="size-3" />
                  Held together as a single dispatch
                </span>
              )}
              <ArrowRight className="text-muted-foreground size-3" />
              <Button variant="outline" size="sm" onClick={onOpenDetail}>
                Open Full Transaction
              </Button>
              <Button variant="link" size="sm" className="h-auto p-0">
                Open Job →
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
