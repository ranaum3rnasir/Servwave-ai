/**
 * Multi-visit S4 (D7): the one place the job page drives a visit's lifecycle.
 *
 * The routed v2 Visits card calls THIS hook rather than posting its own URLs, so the button-to-
 * route mapping and the invalidation set stay in one place. There was a second, unrouted v1 card
 * that also called it; it was deleted once the v1 job page went, so the anti-drift rule #1551 was
 * spent establishing no longer has a twin to police here - keep new callers on this hook.
 *
 * A step is a visit write, so success runs the shared refreshAfterVisitWrite: the visits query
 * (B16 - a card whose button had just changed a visit went on rendering the pre-click status), the
 * job payload (Job.status and its schedule mirror are recomputed server-side in the same
 * transaction, D12), the board and the customer page.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import type { VisitMilestoneAction } from '@/lib/visits';

/**
 * The verb vocabulary lives in lib/visits.ts from S5, so VISIT_ACTIONS can sit beside it without
 * the cycle lib/visits -> useVisitLifecycle -> useJobVisits -> lib/visits. Re-exported here so
 * every existing caller keeps its import.
 */
export type { VisitAction, VisitMilestoneAction } from '@/lib/visits';

/**
 * D19's cancel is the one verb with a required body: `cancelVisitSchema` rejects a POST carrying
 * no `cancelled_reason` before the handler runs. Modelled as a UNION rather than an optional
 * field so a caller cannot call a trip off without saying why - the type, not a runtime check,
 * is what keeps every caller honest.
 */
export type VisitLifecycleVars =
  | { visitId: string; action: VisitMilestoneAction }
  | { visitId: string; action: 'cancel'; cancelled_reason: string };

export function useVisitLifecycle(jobId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: VisitLifecycleVars) => {
      const url = `/api/jobs/${jobId}/visits/${vars.visitId}/${vars.action}`;
      // The four milestone verbs post NO body at all, deliberately: passing an explicit
      // `undefined` second argument would still send axios two arguments, and every existing
      // assertion on those calls names one.
      if (vars.action === 'cancel') {
        await api.post(url, { cancelled_reason: vars.cancelled_reason });
        return;
      }
      await api.post(url);
    },
    onSuccess: () => {
      if (jobId) refreshAfterVisitWrite(queryClient, { jobId });
    },
    // Without this the refusals this hook CAN still meet are silent. The card gates each button on
    // the ability its route asks for, but D7a scopes a visit to its OWN crew while that ability
    // answers off job.assignees - the S3 union across every visit - so a technician crewed on
    // visit 3 is offered visit 1's buttons and the API 403s. lib/axios.ts's interceptor handles
    // 401 and 402 and not 403, so nothing was shown at all: the button looked dead.
    onError: (err) =>
      toast({
        title: 'Could not update the visit',
        description: extractApiError(err, 'Failed to update the visit'),
        variant: 'destructive',
      }),
  });
}
