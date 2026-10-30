// Call ↔ job/lead linkage seam — attach a logged call to a job or a lead (or
// detach with null). Companion to the SMS one-click reassign in
// `@/lib/api/communication` (useReassignSmsJob); kept in its own module so the
// call-log surfaces don't pull the whole communication seam for one mutation.
//
// A job and its originating lead are two ends of the same thing, so the server
// stamps the pair whichever end is picked and clears the pair on detach. That
// is why both hooks below invalidate the same four scopes: one attach can move
// the row on the hub, the job tab, the customer tab AND the lead tab at once.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { ConversationLinkResult } from '@/lib/api/communication';
import { invalidateAllLeadViews } from '@/lib/api/jobCommunications';

/** Every surface that renders a call row, invalidated as one. */
function useCallLinkInvalidation() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['communication'] });
    qc.invalidateQueries({ queryKey: ['job-communications'] });
    qc.invalidateQueries({ queryKey: ['customer-communications'] });
    qc.invalidateQueries({ queryKey: ['lead-communications'] });
  };
}

/** One-click attach/reassign — link a call to a job (or clear with null).
 *  Backend: PATCH /api/communication/calls/:id/job { job_id } → { call } (or { call: null, left: true } when a
 *  detach took the call out of the person's reach).
 *  Callers update local state + toast on success ("act + cheap undo"). */
export function useReassignCallJob() {
  const qc = useQueryClient();
  const invalidate = useCallLinkInvalidation();
  return useMutation({
    mutationFn: ({ callId, jobId }: { callId: string; jobId: string | null }) =>
      api
        .patch(`/api/communication/calls/${callId}/job`, { job_id: jobId })
        .then((r) => r.data as ConversationLinkResult),
    onSuccess: () => {
      invalidate();
      // Filing a call on a job re-points (or clears) its lead, which can move the lead it left back
      // to New (SPEC-4 D7): every lead view refetches.
      invalidateAllLeadViews(qc);
    },
  });
}

/** The lead mirror — link a call to a lead (or clear with null).
 *  Backend: PATCH /api/communication/calls/:id/lead { lead_id } → { call }.
 *  The endpoint shipped with the lead-attribution fix but had no caller until
 *  the attach picker gained a Leads group. */
export function useReassignCallLead() {
  const qc = useQueryClient();
  const invalidate = useCallLinkInvalidation();
  return useMutation({
    mutationFn: ({ callId, leadId }: { callId: string; leadId: string | null }) =>
      api
        .patch(`/api/communication/calls/${callId}/lead`, { lead_id: leadId })
        .then((r) => r.data as ConversationLinkResult),
    onSuccess: () => {
      invalidate();
      // An attached outbound call moves a New lead to Contacted (SPEC-4 §6.3), and a call taken off a
      // lead can move the lead it left back to New (D7): every lead view refetches.
      invalidateAllLeadViews(qc);
    },
  });
}
