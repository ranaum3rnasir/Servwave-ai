import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes, Truck, ArrowUpRight, PackageCheck } from 'lucide-react';
import api from '@/lib/axios';
import { cn } from '@/lib/utils';
import { STATUS_REGISTRY, STATUS_INTENT_CLASSES } from '@/design-system/status-registry';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/jobs/overview/SectionCard';

// Mirrors the `GET /api/inventory/job-stages?job_id=` payload (job-scoped).
interface JobStageLine {
  id: string;
  itemSku: string;
  itemName: string;
  qtyOrdered: number;
  qtyReceived: number;
  vendor?: string;
  poNumber?: string;
  expectedDate?: string;
}
interface JobStage {
  id: string;
  status: string;
  trade?: string;
  scheduledFor?: string;
  items: JobStageLine[];
}

function useJobStages(jobId: string) {
  return useQuery({
    queryKey: ['job-stages', jobId],
    queryFn: async () => {
      const { data } = await api.get('/api/inventory/job-stages', { params: { job_id: jobId } });
      return (data.jobStages ?? []) as JobStage[];
    },
    // Inventory is RBAC-gated; a 403 just means this user can't see staging — don't retry/noise.
    retry: false,
  });
}

// Copy only - the registry (STATUS_REGISTRY.stage) owns this domain's colour. These four
// labels are the wording this surface shipped with and are HELD pending escalations E4/E2:
// the registry is terser ('Awaiting all parts' / 'All parts in' / 'Delivered to tech') and
// its `partial` label still carries an em dash. `ready_for_pickup` is deliberately not
// overridden because its LABEL already matches the registry verbatim.
//
// THE LABELS ARE HELD; THE COLOURS ARE NOT. This is one of only two files where a stage
// chip changes HUE (the other is components/inventory/StagePreviewDialog.tsx):
//   ready_for_pickup  info BLUE     `bg-info/10 text-info`                #EBF3FE / #3B82F6
//                  -> brand OCEAN   `bg-primary-subtle text-primary`      #E8EEF0 / #0C2D3A
//   delivered         success GREEN `bg-sage-50 text-sage-700`            #EEF8F2 / #2F7D5D
//                  -> neutral GREY  `bg-neutral-surface text-neutral-text` #EEF1F3 / #5E707B
// `delivered` keeps its 'Delivered' label in the override map above and still changes colour -
// the two are independent, so do not read a held label as "nothing moved here".
//
// Both flips are a deliberate KEEP, not a side effect of the migration. The `stage` domain had
// FOUR chip surfaces before consolidation and they disagreed with each other: StageDetailDialog
// and StagingView already rendered <StatusBadge domain="stage">, i.e. straight off the registry,
// so brand-OCEAN `ready_for_pickup` and neutral-GREY `delivered` were ALREADY the live appearance
// on two of the four. StagePreviewDialog and this file were the two local copies, and they did
// not agree with the registry or with each other (three different colours for `ready_for_pickup`,
// three for `delivered`). There is therefore no single "today's appearance" to preserve, and the
// two minority copies converge onto the incumbent majority rather than inventing a third value.
// Full before -> after for every stage value: the "Appearance table" section of
// md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md.
//
// Delete this map, and the lookup below it, once E4 + E2 are adjudicated.
const STAGE_LABEL_OVERRIDES: Record<string, string> = {
  awaiting: 'Awaiting',
  partial: 'Partial',
  complete: 'Complete',
  delivered: 'Delivered',
};
function statusMeta(s: string) {
  // Same fallback shape as StatusBadge: an unmapped value renders verbatim and neutral.
  // (Previously it rendered `s.replace(/_/g, ' ')`, i.e. lowercase prose mid-sentence.)
  // No rendered effect: all five stage values the product can produce - awaiting, partial,
  // complete, ready_for_pickup, delivered, the exact set StageDetailDialog's status select
  // offers - are keys of STATUS_REGISTRY.stage, so this branch is never taken for real data.
  // It is not statically unreachable: `stage` is a SYNTHETIC domain with no Prisma enum behind
  // it (JobStage.status is a plain String, validated only as z.string().min(1).max(50) in
  // inv-stages.controller.ts), so an out-of-vocabulary string would still land here. This is a
  // shape-consistency change with the shared StatusBadge fallback, not a behaviour change.
  const entry = STATUS_REGISTRY.stage[s] ?? { label: s, intent: 'neutral' as const };
  return {
    label: STAGE_LABEL_OVERRIDES[s] ?? entry.label,
    cls: STATUS_INTENT_CLASSES[entry.intent],
  };
}

/**
 * Job Command Center — Items tab "Staging & fulfillment" section. Reads the
 * job's real `JobStage`s from the inventory module (status + received/ordered
 * progress + per-line vendor/PO) and deep-links to Inventory for receive
 * actions. Connected to the module rather than a disconnected per-line field —
 * estimate line items have no reliable inventory link. Hidden entirely if the
 * user lacks Inventory read (the fetch 403s → isError).
 */
export function JobStagesSection({ jobId }: { jobId: string }) {
  const { data: stages, isLoading, isError } = useJobStages(jobId);

  if (isError) return null;

  const inventoryLink = (
    <Link
      to="/inventory/staging"
      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      Open in Inventory <ArrowUpRight className="h-3.5 w-3.5" />
    </Link>
  );

  return (
    <SectionCard
      title="Staging & fulfillment"
      icon={<Boxes className="h-4 w-4 text-text-secondary" />}
      meta={inventoryLink}
      bodyClassName={isLoading || !stages?.length ? 'p-5' : 'p-0'}
    >
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !stages?.length ? (
        <EmptyState
          icon={Truck}
          title="No staging entries yet"
          description="Materials are staged from the Inventory module."
         
        />
      ) : (
        <div className="divide-y divide-border">
          {stages.map((stage) => {
            const ordered = stage.items.reduce((s, l) => s + Number(l.qtyOrdered || 0), 0);
            const received = stage.items.reduce((s, l) => s + Number(l.qtyReceived || 0), 0);
            const pct = ordered > 0 ? Math.min(Math.round((received / ordered) * 100), 100) : 0;
            const meta = statusMeta(stage.status);
            return (
              <div key={stage.id} className="px-5 py-4">
                <div className="flex items-center gap-2">
                  {/* meta.cls also carries a border colour token from STATUS_INTENT_CLASSES, but there
                      is no `border` width class here, so that colour is INERT - Tailwind preflight
                      zeroes every border to no width. Deliberate: this chip never had a hairline, and adding
                      one would be a fresh, undecided appearance change. See the inert-border note
                      in md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md. */}
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', meta.cls)}>
                    {meta.label}
                  </span>
                  {stage.trade && <span className="text-xs text-text-secondary">{stage.trade}</span>}
                  <span className="ml-auto text-xs tabular-nums text-text-secondary">
                    {received}/{ordered} received
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-background-light">
                  <div className="h-full rounded-full bg-sage-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-3 space-y-1.5">
                  {stage.items.map((l) => {
                    const done = Number(l.qtyReceived) >= Number(l.qtyOrdered) && Number(l.qtyOrdered) > 0;
                    return (
                      <div key={l.id} className="flex items-center gap-2 text-xs">
                        <PackageCheck
                          className={cn('h-3.5 w-3.5 shrink-0', done ? 'text-sage-700' : 'text-text-secondary/40')}
                        />
                        <span className="min-w-0 flex-1 truncate text-text-primary">
                          {l.itemName}
                          {l.itemSku ? <span className="text-text-secondary/70"> · {l.itemSku}</span> : null}
                        </span>
                        {(l.vendor || l.poNumber) && (
                          <span className="hidden truncate text-text-secondary/70 sm:inline">
                            {l.vendor}
                            {l.poNumber ? ` · ${l.poNumber}` : ''}
                          </span>
                        )}
                        <span className="shrink-0 tabular-nums text-text-secondary">
                          {Number(l.qtyReceived)}/{Number(l.qtyOrdered)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
