import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';

import { useServicePlans, describeRecurrence, type ServicePlan } from '@/lib/api/service-plans';

import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Spinner } from '@/ui-kit/components/ui/spinner';

import { useRecordVisit } from '../pageBreadcrumbs';
import { StatusChip } from '../_shared/statusChip';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { PlanBuilderDialog } from '../_shared/planBuilderDialog';
import { PlanDetailSheet } from './components/planDetailSheet';
import { customerName, date, money, property } from '../_shared/planShared';

/**
 * Overview: read-only KPI tiles over the same `plans` array the other tabs
 * read.
 *
 * SRVW-234 decision (recorded here per the issue's acceptance criteria):
 * the surviving set is Total plans, Active, Drafts, Contract revenue (active).
 * `Visits remaining` is dropped (SRVW-230) rather than fixed - it summed
 * `visits_remaining` across every plan regardless of status, mixing cancelled
 * and draft plans in with live ones, and there is no reading of "visits left"
 * that is meaningful across that whole set.
 *
 *   - Total plans: count of `plans` with no status filter - the fleet size a
 *     contractor sizes the other tiles against. The API already returns it
 *     (it's just `plans.length`).
 *   - Active: count where `effective_status === 'ACTIVE'` - the operationally
 *     live count. Already returned per-plan.
 *   - Drafts: count where the raw `status === 'DRAFT'`. This reads as a
 *     different field than Active's `effective_status`, but is NOT actually a
 *     different denominator: `effectiveStatus()` (backend/src/lib/servicePlans
 *     /derive.ts) returns 'DRAFT' immediately whenever stored status is
 *     'DRAFT', before any expiry override, so `status === 'DRAFT'` and
 *     `effective_status === 'DRAFT'` select the identical set of plans. Kept
 *     on the raw field since "draft" is a stored state, not a derived one -
 *     changing it would be a no-op restyle, not a fix.
 *   - Contract revenue (active): sums `contract_price` over the same set as
 *     Active, so both tiles describe the same denominator.
 *
 * No replacement tile fills Visits remaining's freed slot. A per-plan
 * `due_soon`/`overdue` pair already comes back from the API (see
 * `ServicePlan` in lib/api/service-plans.ts) and would support an "Overdue"
 * or "Due soon" tile later, but that is new tile content, not a decision -
 * left for its own issue per SRVW-234's acceptance criteria.
 *
 * The tiles are not clickable, exactly as today - there is no filter on this
 * page for a KPI to apply - so they carry no `onClick` and the kit renders them
 * as divs rather than buttons.
 */
function OverviewTab({ plans, isLoading }: { plans: ServicePlan[]; isLoading: boolean }) {
  const k = useMemo(() => {
    let active = 0, drafts = 0, revenue = 0;
    for (const p of plans) {
      if (p.effective_status === 'ACTIVE') { active++; revenue += Number(p.contract_price); }
      if (p.status === 'DRAFT') drafts++;
    }
    return { active, drafts, revenue, total: plans.length };
  }, [plans]);

  return (
    <StatCardGroup>
      <StatCard label="Total plans" value={k.total} loading={isLoading} />
      <StatCard label="Active" value={k.active} loading={isLoading} />
      <StatCard label="Drafts" value={k.drafts} loading={isLoading} />
      <StatCard label="Contract revenue (active)" value={money(k.revenue)} loading={isLoading} />
    </StatCardGroup>
  );
}

/**
 * The plans list.
 *
 * The kit DataTable (mobile slice 31), for two things the plain kit table
 * primitives did not do: it pages (25 plans per page), so a big org's list no
 * longer renders every plan at once, and below `md` it renders each plan as a
 * labelled card instead of a seven-column table wider than a phone. Sorting,
 * search and a column menu are still not offered: no column is sortable and
 * the toolbar is not rendered.
 */
const PLAN_COLUMNS: ColumnDef<ServicePlan, unknown>[] = [
  {
    id: 'plan',
    header: 'Plan',
    meta: { label: 'Plan' },
    enableSorting: false,
    cell: ({ row }) => <span className="font-medium">{row.original.service_plan_number}</span>,
  },
  {
    id: 'customer',
    header: 'Customer',
    meta: { label: 'Customer' },
    enableSorting: false,
    cell: ({ row }) => customerName(row.original),
  },
  {
    id: 'property',
    header: 'Property',
    meta: { label: 'Property' },
    enableSorting: false,
    cell: ({ row }) => property(row.original),
  },
  {
    id: 'cadence',
    header: 'Cadence',
    meta: { label: 'Cadence' },
    enableSorting: false,
    cell: ({ row }) => describeRecurrence(row.original),
  },
  {
    id: 'nextDue',
    header: 'Next due',
    meta: { label: 'Next due' },
    enableSorting: false,
    // `emphasized` is server-derived (due soon / overdue). The legacy table
    // said this with the app table's `tone="highlight"`; the kit's cell has no
    // tone, so the emphasis goes on the value itself.
    cell: ({ row }) =>
      row.original.emphasized
        ? <span className="text-destructive font-medium">{date(row.original.next_due)}</span>
        : date(row.original.next_due),
  },
  {
    id: 'remaining',
    header: 'Remaining',
    meta: { label: 'Remaining' },
    enableSorting: false,
    // `??`, not `||`: a plan with 0 visits left reads "0", never "Ongoing".
    cell: ({ row }) => row.original.visits_remaining ?? 'Ongoing',
  },
  {
    id: 'status',
    header: 'Status',
    meta: { label: 'Status' },
    enableSorting: false,
    cell: ({ row }) => <StatusChip domain="servicePlan" status={row.original.effective_status} />,
  },
];

function PlansTab({ plans, onOpen }: { plans: ServicePlan[]; onOpen: (id: string) => void }) {
  if (plans.length === 0) return <EmptyState title="No service plans yet." />;
  return (
    <DataTable
      columns={PLAN_COLUMNS}
      data={plans}
      getRowId={(p) => p.id}
      onRowClick={(p) => onOpen(p.id)}
      mobileCards
      empty={<EmptyState title="No service plans yet." />}
    />
  );
}

/**
 * Completed visits across every plan, flattened.
 *
 * The old row key was `${plan.id}-${visit.scheduled_date}`, which collides if
 * one plan completes two visits on the same scheduled date. The table keys
 * rows by position instead (no `getRowId`), so two such rows both render; the
 * click still opens the row's own `planId`. Paged like the plans list.
 */
type HistoryRow = { planId: string; plan: string; customer: string; when: string };

const HISTORY_COLUMNS: ColumnDef<HistoryRow, unknown>[] = [
  {
    id: 'plan',
    header: 'Plan',
    meta: { label: 'Plan' },
    enableSorting: false,
    cell: ({ row }) => <span className="font-medium">{row.original.plan}</span>,
  },
  {
    id: 'customer',
    header: 'Customer',
    meta: { label: 'Customer' },
    enableSorting: false,
    cell: ({ row }) => row.original.customer,
  },
  {
    id: 'completed',
    header: 'Completed',
    meta: { label: 'Completed' },
    enableSorting: false,
    cell: ({ row }) => date(row.original.when),
  },
];

function HistoryTab({ plans, onOpen }: { plans: ServicePlan[]; onOpen: (id: string) => void }) {
  const rows = useMemo<HistoryRow[]>(
    () =>
      plans.flatMap((p) =>
        (p.visits ?? [])
          .filter((v) => v.status === 'COMPLETED')
          .map((v) => ({
            planId: p.id,
            plan: p.service_plan_number,
            customer: customerName(p),
            when: v.completed_at ?? v.scheduled_date,
          })),
      ),
    [plans],
  );

  if (rows.length === 0) return <EmptyState title="No completed visits yet." />;
  return (
    <DataTable
      columns={HISTORY_COLUMNS}
      data={rows}
      onRowClick={(r) => onOpen(r.planId)}
      mobileCards
      empty={<EmptyState title="No completed visits yet." />}
    />
  );
}

/**
 * /v2/service-plans - the service plans hub on the CRM UI kit.
 *
 * SRVW-229: the KPI band used to sit behind an "Overview" tab nobody had a
 * reason to click - the page defaults to Plans, so the tiles were never seen
 * on arrival. It now renders once, above the TabStrip, on every tab - the
 * same placement LeadsPage uses for its own KPI row. That leaves two tabs
 * (Plans, History), not one, so this does NOT hit the SRVW-216/217
 * single-remaining-tab case (where the TabStrip itself was removed); the
 * strip stays.
 *
 * One `useServicePlans()` query still feeds the tiles and both tabs, so
 * promoting the band changes nothing about fetching: it was already the same
 * query object passed down as props, just previously wrapped in a TabPanel
 * that mounted/unmounted it. It is now always mounted, which means no
 * unmount-driven refetch either.
 *
 * The active tab is local state starting at `plans` (NOT `history`) with no
 * `?tab=` param, exactly as today - `TabStrip`/`TabPanel` carry no URL or
 * persisted state (frontend/src/pages/v2/_shared/tabs.tsx), so promoting the
 * band does not touch that question.
 *
 * There is no permission gating on this page and there was none before: every
 * control renders for anyone who reaches the route, and enforcement is entirely
 * server-side. Adding a CASL gate here would change who can do what, which is
 * outside a restyle - it is recorded in the gap ledger instead.
 */
export default function ServicePlansPage() {
  useRecordVisit('service-plans');
  const { data: plans = [], isLoading } = useServicePlans();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('plans');

  return (
    <div>
      <PageHeader
        title="Service Plans"
        actions={
          <Button onClick={() => setBuilderOpen(true)}>
            <Plus />
            New Plan
          </Button>
        }
      />

      <OverviewTab plans={plans} isLoading={isLoading} />

      <Card className="mt-4">
        <TabStrip
          value={activeTab}
          onValueChange={setActiveTab}
          tabs={[
            { value: 'plans', label: 'Plans' },
            { value: 'history', label: 'History' },
          ]}
        />

        <TabPanel value="plans" activeValue={activeTab}>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="lg" />
            </div>
          ) : (
            <PlansTab plans={plans} onOpen={setDetailId} />
          )}
        </TabPanel>

        <TabPanel value="history" activeValue={activeTab}>
          <HistoryTab plans={plans} onOpen={setDetailId} />
        </TabPanel>
      </Card>

      <PlanBuilderDialog open={builderOpen} onOpenChange={setBuilderOpen} />
      <PlanDetailSheet id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
