import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Download, PackageCheck, PackageOpen, Plus, ShoppingCart, X,
} from 'lucide-react';

import {
  HISTORY_PO_STATUSES, OPEN_PO_STATUSES,
  useBrands, useCategories, useCreatePO,
  useInventoryItems, useInventoryJobs, useLocations,
  usePurchaseOrders, useReceivePO, useVendors,
} from '@/lib/api/inventory';
import type {
  Brand, Category, Item, NewPOInput, PurchaseOrder, Vendor,
} from '@/lib/api/inventory';
import { extractApiError } from '@/lib/utils';
import { downloadCSV, toCSV } from '@/lib/inventory/csv';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import { useAppAbility } from '@/contexts/AbilityContext';

// Legacy dialogs reused unchanged - each owns the receive / lifecycle
// contracts and their server error handling.
import { NewPODialog } from '@/components/inventory/NewPODialog';
import { PODetailDialog, type ReceiveSubmit } from '@/components/inventory/PODetailDialog';
import { POPreviewDialog } from '@/components/inventory/POPreviewDialog';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { toast } from '@/ui-kit/components/ui/sonner';

import { useRecordVisit } from '../pageBreadcrumbs';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { ExportBulkBar } from './components/exportBulkBar';
import { buildHistoryPOColumns, buildOpenPOColumns, fmtDate, fmtInstant } from './poColumns';
import { poTotal } from '@/lib/inventory/po-money';

type Tab = 'open' | 'history';

// Which KPI tile is currently "active". Only one can ever be true at a time.
type ActiveKPI = null | 'drafts' | 'ordered' | 'late' | 'week';

const TODAY = new Date(); // live clock - drives the Late / Arriving-this-week KPIs
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * MS_PER_DAY;

// Only a PLACED order can be late or arriving: a draft has not been ordered and
// a received / closed / cancelled PO is no longer expected (PR 2).
function isAwaited(po: PurchaseOrder): boolean {
  return po.status === 'ordered' || po.status === 'partial';
}

function isLate(po: PurchaseOrder): boolean {
  if (!po.expectedDate || !isAwaited(po)) return false;
  return new Date(po.expectedDate).getTime() < TODAY.getTime();
}

function isArrivingThisWeek(po: PurchaseOrder): boolean {
  if (!po.expectedDate || !isAwaited(po)) return false;
  const exp = new Date(po.expectedDate).getTime();
  return exp >= TODAY.getTime() && exp <= TODAY.getTime() + ONE_WEEK_MS;
}

const TRADES = ['locksmith', 'door', 'security', 'hvac', 'plumbing', 'multi'];

const EMPTY_COPY: Record<Tab, { title: string; description: string }> = {
  open: {
    title: 'No open POs',
    description: 'Nothing open. Every order has been received or closed.',
  },
  history: {
    title: 'No closed POs yet',
    description: 'Received, closed and cancelled POs will land here for audit + lead-time analysis.',
  },
};

/**
 * /v2/inventory/purchase-orders - the PO workspace on the CRM UI kit.
 *
 * Two tabs, two buckets (Purchasing Audit Verdict PR 2): Open (draft + ordered
 * + partial) and History (received + closed + cancelled). The Pre-PO queue and
 * its estimate reservations are gone - nothing creates a reservation any more.
 * Every query, mutation, deep-link rule, sort order and server-error branch is
 * the legacy page's; the four KPI tiles are kit StatCards, the app TabStrip is
 * the v2 one, and the grids are kit DataTables.
 */
export default function PurchaseOrdersPage() {
  useRecordVisit('inventory', 'Purchase Orders');
  const ability = useAppAbility();
  const canCreatePO = ability.can('create', 'PurchaseOrder');
  const [tab, setTabRaw] = useState<Tab>('open'); // default landing tab
  const [search, setSearch] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [tradeFilter, setTradeFilter] = useState('');
  const [activeKPI, setActiveKPI] = useState<ActiveKPI>(null);
  const [searchParams] = useSearchParams();

  // Deep-link seeding (e.g. Dialer PO link): `?q=` pre-fills the text search and
  // `?status=` selects the tab whose bucket contains that status.
  useEffect(() => {
    const q = searchParams.get('q');
    const status = searchParams.get('status');
    if (status) {
      const t: Tab = (HISTORY_PO_STATUSES as readonly string[]).includes(status) ? 'history' : 'open';
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the tab is seeded once from the URL query string, which lives outside React state
      setTabRaw(t);
    }
    if (q) setSearch(q);
  }, [searchParams]);

  // NO `= []` DEFAULT on the five a seed effect keys on (below). That default
  // mints a FRESH array every render while the query is pending, so the effect
  // sees a changed dependency every render and re-fires forever - the loop
  // `src/__tests__/purchase-orders-deeplink.test.tsx` mocks the seam to dodge.
  // `seedJobs` keeps its default: it is read straight in render, never seeded
  // into state.
  const { data: seedPOs } = usePurchaseOrders();
  const { data: seedJobs = [] } = useInventoryJobs();
  const { data: seedVendors } = useVendors();
  const { data: seedItems } = useInventoryItems();
  const { data: seedCategories } = useCategories();
  const { data: seedBrands } = useBrands();
  // Resolves the receive destination's display name for the success toast.
  const { data: seedLocations = [] } = useLocations();

  const createPO = useCreatePO();
  const receivePO = useReceivePO();

  // KPI click: clicking a different tile moves the active state to it (and
  // navigates to the Open tab, where all four buckets live); clicking the
  // active one toggles it off.
  function handleKPIClick(key: NonNullable<ActiveKPI>) {
    if (activeKPI === key) {
      setActiveKPI(null);
      return;
    }
    setActiveKPI(key);
    setTabRaw('open');
  }

  // Manual tab navigation always clears any active KPI filter.
  function setTab(next: Tab) {
    setTabRaw(next);
    setActiveKPI(null);
  }

  const [allPOs, setAllPOs] = useState<PurchaseOrder[]>([]);

  // Local catalog state so items / vendors / categories added from inside
  // NewPODialog persist across the rest of the page session.
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [allVendorsCatalog, setAllVendorsCatalog] = useState<Vendor[]>([]);
  const [allCategoriesCatalog, setAllCategoriesCatalog] = useState<Category[]>([]);
  const [allBrandsCatalog, setAllBrandsCatalog] = useState<Brand[]>([]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- PO mirror is seeded from the query, then mutated optimistically on create / receive
  useEffect(() => { if (seedPOs) setAllPOs(seedPOs); }, [seedPOs]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- items mirror is seeded here, then extended by items created inside NewPODialog
  useEffect(() => { if (seedItems) setAllItems(seedItems); }, [seedItems]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- vendors mirror is seeded here, then extended by vendors created inside NewPODialog
  useEffect(() => { if (seedVendors) setAllVendorsCatalog(seedVendors); }, [seedVendors]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- categories mirror is seeded here, then extended by categories created inside NewPODialog
  useEffect(() => { if (seedCategories) setAllCategoriesCatalog(seedCategories); }, [seedCategories]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- brands mirror is seeded here, then extended by brands created inside NewPODialog
  useEffect(() => { if (seedBrands) setAllBrandsCatalog(seedBrands); }, [seedBrands]);

  const openPOs = useMemo(
    () => allPOs.filter((p) => OPEN_PO_STATUSES.includes(p.status)),
    [allPOs],
  );
  const historyPOs = useMemo(
    () => allPOs.filter((p) => HISTORY_PO_STATUSES.includes(p.status)),
    [allPOs],
  );

  const kpiDrafts = openPOs.filter((p) => p.status === 'draft').length;
  const kpiOrdered = openPOs.filter((p) => p.status === 'ordered').length;
  const kpiLate = openPOs.filter(isLate).length;
  const kpiArrivingThisWeek = openPOs.filter(isArrivingThisWeek).length;

  const applyTextFilter = <T extends { vendor?: string; jobNumber?: string; customer?: string }>(
    rows: T[],
    hay: (r: T) => string,
  ): T[] => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (vendorFilter && (r.vendor ?? '') !== vendorFilter) return false;
      if (tradeFilter && (r as unknown as { trade?: string }).trade !== tradeFilter) return false;
      if (!q) return true;
      return hay(r).toLowerCase().includes(q);
    });
  };

  const filteredOpen = useMemo(
    () =>
      applyTextFilter(openPOs, (p) =>
        [p.poNumber, p.vendor, p.jobNumber, p.customer, p.lines.map((l) => l.itemSku).join(' ')].join(' '),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openPOs, search, vendorFilter, tradeFilter],
  );

  const filteredHistory = useMemo(
    () => applyTextFilter(historyPOs, (p) => [p.poNumber, p.vendor, p.jobNumber, p.customer].join(' ')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyPOs, search, vendorFilter, tradeFilter],
  );

  const vendorOptions = useMemo(() => {
    const set = new Set<string>();
    allPOs.forEach((p) => set.add(p.vendor));
    return Array.from(set).sort();
  }, [allPOs]);

  const [detailPO, setDetailPO] = useState<PurchaseOrder | null>(null);
  const [previewPO, setPreviewPO] = useState<PurchaseOrder | null>(null);
  const [newPOOpen, setNewPOOpen] = useState(false);

  // The PO number is server-assigned: await the create, fold the returned PO
  // into local state and land on the Open tab (drafts live there) so the row
  // is visible.
  async function handleCreatePO(input: NewPOInput) {
    try {
      const r = await createPO.mutateAsync(input);
      setAllPOs((prev) => [r.purchaseOrder, ...prev]);
      setTab('open');
      toast(`${r.purchaseOrder.poNumber} saved as draft`);
    } catch {
      toast('Could not save the PO - try again');
    }
  }

  // Lifecycle writes (mark as ordered, status moves, notes) happen inside the
  // detail dialog; it hands back the server's PO so the grid and the open
  // dialog show the new state before the invalidated query refetches.
  function handleUpdated(serverPO: PurchaseOrder) {
    setAllPOs((prev) => prev.map((p) => (p.id === serverPO.id ? serverPO : p)));
    setDetailPO((cur) => (cur && cur.id === serverPO.id ? serverPO : cur));
  }

  function handleDeleted(id: string) {
    setAllPOs((prev) => prev.filter((p) => p.id !== id));
    setDetailPO((cur) => (cur && cur.id === id ? null : cur));
  }

  // NO optimistic fold - the server's {purchaseOrder} response is the truth.
  function handleReceive(event: ReceiveSubmit) {
    receivePO.mutate(event, {
      onSuccess: (r) => {
        const serverPO = r.purchaseOrder;
        setAllPOs((prev) => prev.map((p) => (p.id === serverPO.id ? serverPO : p)));
        setDetailPO(serverPO);
        const locationName =
          seedLocations.find((l) => l.id === event.destinationLocationId)?.name ?? 'stock';
        toast(`✓ ${serverPO.poNumber} updated · received into ${locationName}`);
      },
      onError: (err) => {
        // Matches the real server contracts (inv-po.controller.receivePurchaseOrder):
        //   400 OVER_RECEIVE       -> { error, item_sku, qty_ordered, qty_received }
        //   409 STAGED_PO          -> { error, message, staged_skus: string[] }
        //   409 NO_STOCK_LOCATION  -> { error, message }
        const data = (err as {
          response?: {
            data?: {
              error?: string;
              message?: string;
              item_sku?: string;
              qty_ordered?: number;
              qty_received?: number;
              staged_skus?: string[];
            };
          };
        })?.response?.data;

        if (data?.error === 'OVER_RECEIVE') {
          toast.error("Received can't exceed ordered", {
            description: data.item_sku
              ? `${data.item_sku}: tried to receive ${data.qty_received ?? '?'}, only ${data.qty_ordered ?? '?'} ordered`
              : undefined,
          });
          return;
        }

        if (data?.error === 'STAGED_PO') {
          const skus = (data.staged_skus ?? []).join(', ');
          toast.error('Receive staged items from the Staging view', {
            description: skus ? `Staged line${skus.includes(',') ? 's' : ''}: ${skus}` : data.message,
          });
          return;
        }

        if (data?.error === 'NO_STOCK_LOCATION') {
          // The dialog normally catches this before the POST (no destination
          // options); the server is the authority when it slips through.
          toast.error('No inventory location yet', {
            description: data.message ?? 'Add an inventory location under Settings → Locations before receiving.',
          });
          return;
        }

        toast.error(extractApiError(err, 'Failed to save the receipt'));
      },
    });
  }

  const openColumns = useMemo(
    () =>
      buildOpenPOColumns({
        isLate,
        isArrivingThisWeek,
        onPreview: setPreviewPO,
        onReceive: setDetailPO,
        selectable: true,
      }),
    [],
  );

  const historyColumns = useMemo(
    () => buildHistoryPOColumns({ onPreview: setPreviewPO, selectable: true }),
    [],
  );

  // Open rows sort late first, then by expected ASC.
  const openRows = useMemo(() => {
    const rows =
      activeKPI === 'drafts'
        ? filteredOpen.filter((p) => p.status === 'draft')
        : activeKPI === 'ordered'
          ? filteredOpen.filter((p) => p.status === 'ordered')
          : activeKPI === 'late'
            ? filteredOpen.filter(isLate)
            : activeKPI === 'week'
              ? filteredOpen.filter(isArrivingThisWeek)
              : filteredOpen;
    return [...rows].sort((a, b) => {
      const aLate = isLate(a) ? 0 : 1;
      const bLate = isLate(b) ? 0 : 1;
      if (aLate !== bLate) return aLate - bLate;
      const aExp = a.expectedDate ? new Date(a.expectedDate).getTime() : Infinity;
      const bExp = b.expectedDate ? new Date(b.expectedDate).getTime() : Infinity;
      return aExp - bExp;
    });
  }, [filteredOpen, activeKPI]);

  // History sorts by the real receivedAt DESC (PR 2), falling back to ordered/created dates.
  const historyRows = useMemo(() => {
    const at = (p: PurchaseOrder) => new Date(p.receivedAt ?? p.orderedAt ?? p.createdAt).getTime();
    return [...filteredHistory].sort((a, b) => at(b) - at(a));
  }, [filteredHistory]);

  // --- Selection --------------------------------------------------------------
  // TWO selections, one per grid. Each scope key is the set of inputs its OWN
  // rows are derived from, so a filter that only moves one tab's rows only
  // drops that tab's selection. `tab` is in both keys as well: the panels
  // unmount on a tab switch, and carrying a hidden selection back would be a
  // surprise.
  const openSelection = useScopedRowSelection(
    JSON.stringify([tab, search, vendorFilter, tradeFilter, activeKPI]),
  );
  const historySelection = useScopedRowSelection(
    JSON.stringify([tab, search, vendorFilter, tradeFilter]),
  );

  const selectedOpen = useMemo(
    () => openRows.filter((p) => openSelection.selectedIds.includes(p.id)),
    [openRows, openSelection.selectedIds],
  );
  const selectedHistory = useMemo(
    () => historyRows.filter((p) => historySelection.selectedIds.includes(p.id)),
    [historyRows, historySelection.selectedIds],
  );

  // --- CSV export -------------------------------------------------------------
  /**
   * NEW: neither this page nor its legacy counterpart had a CSV export, so
   * there was no exporter to reuse. One mapping per grid, because the two
   * grids print two different column sets - a single shared mapping would
   * have to null out half its columns per tab.
   *
   * Each mapping is its grid's own columns, in the grid's order, computed by
   * the same helpers the cells use (`poTotal`, `fmtDate`), so the file and the
   * screen cannot drift. Both the toolbar Export and Export selected go
   * through `exportRows`, which is the shared `toCSV`/`downloadCSV` writer the
   * CSV export guard requires.
   */
  const toOpenExportRow = (p: PurchaseOrder) => ({
    Status: p.status,
    'PO #': p.poNumber,
    Vendor: p.vendor,
    Job: p.jobNumber ?? '',
    Customer: p.customer ?? '',
    Ordered: fmtDate(p.orderedAt),
    Expected: fmtDate(p.expectedDate),
    Lines: p.lines.length,
    Total: poTotal(p),
    'Qty Ordered': p.lines.reduce((sum, l) => sum + l.qtyOrdered, 0),
    'Qty Received': p.lines.reduce((sum, l) => sum + l.qtyReceived, 0),
  });

  const toHistoryExportRow = (p: PurchaseOrder) => ({
    Status: p.status,
    'PO #': p.poNumber,
    Vendor: p.vendor,
    Job: p.jobNumber ?? '',
    Customer: p.customer ?? '',
    Ordered: fmtDate(p.orderedAt),
    // The real stamp (PR 2) - blank, never the expected date, when the PO was
    // closed or cancelled without a receipt. Lead time is the server's
    // receivedAt − orderedAt, blank when either date is missing.
    'Received on': p.receivedAt ? fmtInstant(p.receivedAt) : '',
    'Lead time (days)': p.leadTimeDays ?? '',
    Total: poTotal(p),
  });

  function exportRows(rows: Record<string, unknown>[], name: string) {
    if (rows.length === 0) {
      toast('Nothing to export', { description: 'No purchase orders match the current filters.' });
      return;
    }
    downloadCSV(toCSV(rows), `purchase-orders-${name}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  /** The toolbar Export acts on the CURRENT tab's whole filtered set. */
  function handleExportTab() {
    if (tab === 'history') { exportRows(historyRows.map(toHistoryExportRow), 'history'); return; }
    exportRows(openRows.map(toOpenExportRow), 'open');
  }

  const tabs = [
    {
      value: 'open',
      label: (
        <span className="flex items-center gap-1.5">
          <PackageOpen className="size-3.5" />
          Open
          <Badge variant="softNeutral" size="pill">{openPOs.length}</Badge>
        </span>
      ),
    },
    {
      value: 'history',
      label: (
        <span className="flex items-center gap-1.5">
          <PackageCheck className="size-3.5" />
          History
          <Badge variant="softNeutral" size="pill">{historyPOs.length}</Badge>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        description="Track every order from draft to receipt."
        actions={
          canCreatePO ? (
            <Button onClick={() => setNewPOOpen(true)}>
              <Plus />
              Create PO
            </Button>
          ) : undefined
        }
      />

      <StatCardGroup className="mb-4 xl:grid-cols-4">
        <StatCard
          label="Drafts"
          value={String(kpiDrafts)}
          active={activeKPI === 'drafts'}
          onClick={() => handleKPIClick('drafts')}
        />
        <StatCard
          label="Ordered"
          value={String(kpiOrdered)}
          active={activeKPI === 'ordered'}
          onClick={() => handleKPIClick('ordered')}
        />
        <StatCard
          label="Late"
          value={String(kpiLate)}
          active={activeKPI === 'late'}
          onClick={() => handleKPIClick('late')}
        />
        <StatCard
          label="Arriving this week"
          value={String(kpiArrivingThisWeek)}
          active={activeKPI === 'week'}
          onClick={() => handleKPIClick('week')}
        />
      </StatCardGroup>

      <TabStrip tabs={tabs} value={tab} onValueChange={(v) => setTab(v as Tab)} />

      {/* Search + filter row, shared across both tabs. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-3">
        <div className="min-w-[12rem] flex-1">
          <SearchInput value={search} onValueChange={setSearch} placeholder="Search purchase orders…" />
        </div>
        <SelectField
          value={vendorFilter || 'all'}
          onValueChange={(v) => setVendorFilter(v === 'all' ? '' : v)}
          size="sm"
          aria-label="All vendors"
          options={[
            { value: 'all', label: 'All vendors' },
            ...vendorOptions.map((v) => ({ value: v, label: v })),
          ]}
        />
        <SelectField
          value={tradeFilter || 'all'}
          onValueChange={(v) => setTradeFilter(v === 'all' ? '' : v)}
          size="sm"
          aria-label="All trades"
          options={[
            { value: 'all', label: 'All trades' },
            ...TRADES.map((t) => ({ value: t, label: t })),
          ]}
        />
        {activeKPI && (
          <Button
            variant="ghost"
            size="sm"
            title="Click the lit KPI tile again, or use this button, to clear the filter"
            onClick={() => setActiveKPI(null)}
          >
            Clear KPI filter
            <X />
          </Button>
        )}
        {/* Exports the ACTIVE tab's whole filtered set. It sits in the shared
            search/filter row because that row is what scopes both grids;
            its selected-row sibling lives in each grid's own bulk bar and
            shares that grid's mapping. */}
        <Button variant="outline" size="sm" onClick={handleExportTab}>
          <Download />
          Export
        </Button>
      </div>

      <div className="pt-4">
        <TabPanel value="open" activeValue={tab}>
          <DataTable
            columns={openColumns}
            data={openRows}
            getRowId={(p) => p.id}
            onRowClick={(p) => setDetailPO(p)}
            rowSelection={openSelection.rowSelection}
            onRowSelectionChange={openSelection.setRowSelection}
            enableColumnResizing
            mobileCards
            empty={
              <EmptyState
                icon={<ShoppingCart />}
                title={EMPTY_COPY.open.title}
                description={EMPTY_COPY.open.description}
              />
            }
          >
            {() => (
              <ExportBulkBar
                count={selectedOpen.length}
                noun={['purchase order', 'purchase orders']}
                onClear={() => openSelection.setRowSelection({})}
                onExportSelected={() =>
                  exportRows(selectedOpen.map(toOpenExportRow), 'open-selected')}
              />
            )}
          </DataTable>
        </TabPanel>

        <TabPanel value="history" activeValue={tab}>
          <DataTable
            columns={historyColumns}
            data={historyRows}
            getRowId={(p) => p.id}
            onRowClick={(p) => setDetailPO(p)}
            rowSelection={historySelection.rowSelection}
            onRowSelectionChange={historySelection.setRowSelection}
            enableColumnResizing
            mobileCards
            empty={
              <EmptyState
                icon={<PackageCheck />}
                title={EMPTY_COPY.history.title}
                description={EMPTY_COPY.history.description}
              />
            }
          >
            {() => (
              <ExportBulkBar
                count={selectedHistory.length}
                noun={['purchase order', 'purchase orders']}
                onClear={() => historySelection.setRowSelection({})}
                onExportSelected={() =>
                  exportRows(selectedHistory.map(toHistoryExportRow), 'history-selected')}
              />
            )}
          </DataTable>
        </TabPanel>
      </div>

      <PODetailDialog
        open={!!detailPO}
        onClose={() => setDetailPO(null)}
        po={detailPO}
        onReceive={handleReceive}
        onUpdated={handleUpdated}
        onDeleted={handleDeleted}
      />
      <POPreviewDialog open={!!previewPO} onClose={() => setPreviewPO(null)} po={previewPO} />
      <NewPODialog
        open={newPOOpen}
        onClose={() => setNewPOOpen(false)}
        onCreate={handleCreatePO}
        vendors={allVendorsCatalog}
        items={allItems}
        existingPOs={allPOs}
        jobs={seedJobs}
        onAddItem={(item) => setAllItems((prev) => [item, ...prev])}
        onAddVendor={(v) => setAllVendorsCatalog((prev) => [...prev, v])}
        categories={allCategoriesCatalog}
        onAddCategory={(c) => setAllCategoriesCatalog((prev) => [...prev, c])}
        brands={allBrandsCatalog}
      />
    </div>
  );
}
