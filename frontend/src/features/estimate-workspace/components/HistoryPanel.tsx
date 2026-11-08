import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileClock } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { getEstimateHistory, listEstimateVersions } from '@/lib/api/estimates';
import { estimateVersionPath } from '@/pages/v2/routes/estimates.paths';
import { formatCurrency } from '@/lib/utils';
import {
  buildEstimateHistoryTimeline,
  versionTriggerSentence,
  type EstimateActivityEvent,
  type EstimateVersionSummary,
} from '../lib/estimateHistoryTimeline';

// action -> a short, human sentence. Falls back to a generic label (never the raw dotted key)
// for anything unlisted — see `FALLBACK_ACTION_LABEL` below. Coverage against every
// `resourceType: 'Estimate'` action the backend actually logs is enforced by
// `HistoryPanel.actionLabels.test.ts`, which reads the backend source directly.
export const ACTION_LABELS: Record<string, string> = {
  'estimate.created': 'Estimate created',
  'estimate.updated': 'Estimate updated',
  'estimate.sent': 'Sent to customer',
  'estimate.approved': 'Approved by customer',
  'estimate.declined': 'Declined by customer',
  'estimate.deposit_paid': 'Deposit paid',
  'estimate.deposit_waived': 'Deposit waived',
  // R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3).
  'estimate.marked_sent': 'Marked sent (delivered outside the app)',
  'estimate.status_corrected': 'Status corrected',
  'estimate.approved_internal': 'Approved internally (verbal win)',
  'estimate.declined_internal': 'Declined internally',
  'estimate.approval_voided': 'Approval voided',
  'estimate.modified_after_send': 'Modified after send — flagged, re-send required',
  'estimate.superseded': 'Superseded by a revision',
  'estimate.revised_from': 'Created as a revision',
  'estimate.scope_preset_saved': 'Scope saved as a reusable preset',
  'estimate.ai_scope_drafted': 'AI scope-of-work draft generated',
  'estimate.deleted': 'Deleted',
  // #2091 — every remaining `resourceType: 'Estimate'` action the backend logs.
  'estimate.line_added': 'Line item added',
  'estimate.line_updated': 'Line item updated',
  'estimate.line_deleted': 'Line item removed',
  'estimate.lines_reordered': 'Line items reordered',
  'estimate.scope_added': 'Scope of work added',
  'estimate.scope_updated': 'Scope of work updated',
  'estimate.scope_deleted': 'Scope of work removed',
  'estimate.scopes_reordered': 'Scopes reordered',
  'estimate.scope_photo_uploaded': 'Photo added to a scope',
  'estimate.scope_photo_deleted': 'Photo removed from a scope',
  'estimate.attached_to_job': 'Attached to a job',
  'estimate.invoice_copied': 'Copied to an invoice',
  'estimate.deposit_repriced': 'Deposit amount updated',
  'estimate.selections_changed': 'Customer updated their selections',
  'estimate.deposit_checkout_started': 'Customer started deposit checkout',
  'estimate.deposit_method_selected': 'Customer chose a deposit payment method',
  'estimate.renumbered': 'Estimate number changed',
  'estimate.exported': 'Exported',
};

/** Never the raw dotted action key — see the boundary in `ACTION_LABELS` above. */
export const FALLBACK_ACTION_LABEL = 'Estimate activity';

/**
 * One format for both streams, so a version and the event beside it read off the same clock.
 *
 * Null is guarded as well as unparseable, matching `instant()` in the merge function — the two
 * helpers read the same fields and must not disagree about whether null is possible.
 * `new Date(null).getTime()` is 0, not NaN, so a NaN-only guard states the epoch as a send date.
 */
function whenLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * §G — History: the audit_logs trail (PR #295) and the past versions (#2030 slice 4), read-only.
 *
 * TWO STREAMS, ONE DRAWER. A flat list of "this field was edited" never answered the question a
 * reader actually arrives with, which is *what did the customer get?* The versions answer it, so
 * they are the anchors: heavier, clickable rows that open the read-only document, with the
 * lighter event rows filling in between them.
 *
 * The two streams are fetched INDEPENDENTLY and merged in the client. The activity query is
 * untouched by the version work — same key, same endpoint, same shape — so a versions query that
 * fails costs a reader nothing they had before: the events still render, with no versions among
 * them. An estimate that has simply never been delivered is not a failure — the endpoint answers
 * 200 with an empty list — and renders the same way.
 *
 * The merge itself lives in `../lib/estimateHistoryTimeline`, not in this JSX, because every
 * defect in a merged timeline is an ordering defect and none of them are reachable through a
 * rendered component without a fixture apiece.
 */
export function HistoryPanel({ open, onClose, estimateId }: { open: boolean; onClose: () => void; estimateId: string }) {
  const { data, isLoading } = useQuery<{ events: EstimateActivityEvent[] }>({
    queryKey: ['estimate-history', estimateId],
    queryFn: () => getEstimateHistory(estimateId),
    enabled: open && !!estimateId,
  });

  const { data: versionData, isLoading: versionsLoading } = useQuery<{ versions: EstimateVersionSummary[] }>({
    queryKey: ['estimate-versions', estimateId],
    queryFn: () => listEstimateVersions(estimateId),
    enabled: open && !!estimateId,
    // The only 404 here is an estimate this reader cannot resolve at all — never "no versions
    // yet", which answers 200 with an empty list. Either way a retry cannot change the answer and
    // only holds the events behind it. The drawer is fine without versions; it is not fine slow.
    retry: false,
  });

  const timeline = buildEstimateHistoryTimeline(data?.events, versionData?.versions);
  const loading = isLoading || versionsLoading;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription className="sr-only">
            Versions sent to the customer and the activity recorded on this estimate, newest first
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {loading && (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {!loading && timeline.length === 0 && (
            <p className="text-sm text-text-secondary">No activity recorded yet.</p>
          )}
          {!loading && timeline.length > 0 && (
            <ol className="space-y-3">
              {timeline.map((entry) =>
                entry.kind === 'version' ? (
                  <li key={entry.key}>
                    {/* The anchor row: tinted, bordered, and clickable across its whole area,
                        because this is the row a reader is scanning for. Opens the read-only
                        version page — the document exactly as the customer received it. */}
                    <Link
                      to={estimateVersionPath(estimateId, entry.version.version)}
                      className="block rounded-card border border-border bg-primary-subtle px-3 py-2.5 transition-shadow hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-text-primary">
                          <FileClock className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                          Version {entry.version.version}
                        </span>
                        {entry.version.total_amount !== null && entry.version.total_amount !== undefined && (
                          <span className="text-sm font-semibold tabular-nums text-text-primary">
                            {formatCurrency(entry.version.total_amount)}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {versionTriggerSentence(entry.version.trigger)}
                        {whenLabel(entry.version.sent_at) && ` · ${whenLabel(entry.version.sent_at)}`}
                      </p>
                    </Link>
                  </li>
                ) : (
                  <li key={entry.key} className="border-b border-border pb-2.5">
                    <p
                      className="text-sm font-semibold text-text-primary"
                      // The raw action key is developer detail, not reader copy — it only ever
                      // shows up in a hover title, and only when there is no plain-English label.
                      title={ACTION_LABELS[entry.event.action] ? undefined : entry.event.action}
                    >
                      {ACTION_LABELS[entry.event.action] ?? FALLBACK_ACTION_LABEL}
                    </p>
                    <p className="text-xs text-text-secondary">
                      {whenLabel(entry.event.created_at)}
                      {entry.event.actor_email && ` · ${entry.event.actor_email}`}
                    </p>
                  </li>
                ),
              )}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
