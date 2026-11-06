import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { useFieldDraft } from '@/lib/drafts/useFieldDraft';
import { LONG_TEXT_MAX } from '@/lib/textLimits';
import { TextLengthCounter } from '@/components/form';
import { Button } from '@/ui-kit/components/ui/button';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { DraftRestoredNote } from '@/ui-kit/components/ui/draftRestoredNote';

import { formatDateTime, type VisitHistoryRow } from './leadShared';

/** "Scheduled Nov 5, 9:00 AM" / "Finished ..." / "Cancelled ..." / "To be scheduled": the card's status and time. */
function statusLine(w: VisitHistoryRow, tz: string): string {
  if (w.status === 'COMPLETED' && w.completed_at) return `Finished ${formatDateTime(w.completed_at, tz)}`;
  if (w.status === 'CANCELLED') return w.cancelled_at ? `Cancelled ${formatDateTime(w.cancelled_at, tz)}` : 'Cancelled';
  if (w.scheduled_at) return `Scheduled ${formatDateTime(w.scheduled_at, tz)}`;
  return 'To be scheduled';
}

function WalkthroughNotesCard({
  leadId, row, label, tz,
}: { leadId: string; row: VisitHistoryRow; label: string; tz: string }) {
  const queryClient = useQueryClient();
  const canWrite = row.can_write_notes === true;
  const saved = row.notes ?? '';
  const draft = useFieldDraft({
    recordType: 'LEAD', recordId: leadId, field: `walkthrough-notes-${row.id}`, baseline: saved, enabled: canWrite,
  });
  const tooLong = draft.value.length > LONG_TEXT_MAX;

  const save = useMutation({
    mutationFn: async (notes: string) => { await api.patch(`/api/leads/${leadId}/visits/${row.id}/notes`, { notes }); },
    // The text that was sent is what got saved; anything typed while the request was out stays a draft.
    onSuccess: (_data, sent) => {
      draft.markSaved(sent);
      refreshAfterVisitWrite(queryClient, { leadId });
    },
  });

  const who = row.status === 'CANCELLED' && row.cancelled_reason
    ? row.cancelled_reason
    : (row.performers ?? []).map((p) => `${p.first_name} ${p.last_name}`).join(', ');
  const subline = [statusLine(row, tz), who].filter(Boolean).join(' · ');

  return (
    <li className="flex flex-col gap-2.5 rounded-lg border p-3.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-bold">{label}</span>
        <span className="text-muted-foreground text-xs">{subline}</span>
      </div>
      {canWrite ? (
        <div>
          <Textarea
            aria-label={`${label} notes`}
            value={draft.value}
            onChange={(e) => draft.setValue(e.target.value)}
            rows={3}
            placeholder="Walkthrough notes..."
          />
          <TextLengthCounter length={draft.value.length} max={LONG_TEXT_MAX} />
          <DraftRestoredNote restored={draft.restored} onDiscard={draft.clear} />
          {draft.value !== saved && (
            <Button size="sm" className="mt-2" onClick={() => save.mutate(draft.value)} disabled={save.isPending || tooLong}>
              {save.isPending ? 'Saving...' : 'Save Notes'}
            </Button>
          )}
          {save.isError && <p className="text-destructive mt-1 text-sm">Failed to save notes</p>}
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap" aria-label={`${label} notes`}>
          {saved || <span className="text-muted-foreground">No notes</span>}
        </p>
      )}
    </li>
  );
}

/**
 * The Notes tab's "Walkthrough notes": one card per walkthrough, newest first (cancelled ones too), numbered by booking
 * order (oldest is Walkthrough 1, the number the customer's email also carries). A card the person may not write reads.
 */
export function LeadWalkthroughNotes({ leadId, history, tz }: { leadId: string; history: VisitHistoryRow[] | undefined; tz: string }) {
  const rows = [...(history ?? [])];
  if (rows.length === 0) return null;
  // Oldest booked is 1. visit_seq is that number; a row without one falls back to its place in creation order.
  const byCreation = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const numberOf = (r: VisitHistoryRow) => r.visit_seq ?? byCreation.findIndex((x) => x.id === r.id) + 1;
  rows.sort((a, b) => numberOf(b) - numberOf(a));
  return (
    <section aria-labelledby="walkthrough-notes-heading">
      <h3 id="walkthrough-notes-heading" className="text-muted-foreground mb-2.5 text-xs font-semibold tracking-wider uppercase">
        Walkthrough notes
      </h3>
      <ol className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <WalkthroughNotesCard key={`${r.id}:${r.notes ?? ''}`} leadId={leadId} row={r} label={`Walkthrough ${numberOf(r)}`} tz={tz} />
        ))}
      </ol>
    </section>
  );
}
