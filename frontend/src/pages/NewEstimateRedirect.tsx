import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { createEstimateForAnchor, type EstimateAnchor } from '@/features/estimate-workspace/lib/newEstimate';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * `/estimates/new` - create-and-redirect shim. Estimates are create=edit now: the real
 * authoring surface is EstimateWorkspacePage at `/estimates/:id`. This page eagerly creates an
 * empty DRAFT anchored by whichever of lead_id / customer_id / job_id the entry carried (the
 * backend accepts any one), then replaces itself with the workspace. In-app entries always carry
 * an anchor (NewEstimateDialog); a bare, anchorless `/estimates/new` bounces to the list.
 */
export default function NewEstimateRedirect() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const startedRef = useRef(false);
  const cancelledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const leadId = searchParams.get('lead_id');
  const customerId = searchParams.get('customer_id');
  const jobId = searchParams.get('job_id');

  // One anchor, in priority order lead_id -> customer_id -> job_id. Memoized so it can be an
  // effect dep without a fresh object literal re-firing the effect on every render.
  const anchor = useMemo<EstimateAnchor | null>(
    () =>
      leadId
        ? { lead_id: leadId }
        : customerId
          ? { customer_id: customerId }
          : jobId
            ? { job_id: jobId }
            : null,
    [leadId, customerId, jobId],
  );

  useEffect(() => {
    // Re-arm on every (re)mount: StrictMode's dev double-effect runs the first pass's cleanup
    // before the second setup, and the POST that first pass fired must still be allowed to land.
    // (A plain `let cancelled` scoped to one effect run would be flipped by that cleanup and the
    // redirect would never happen in dev.)
    cancelledRef.current = false;
    const disarm = () => {
      cancelledRef.current = true;
    };

    // Nothing to create without an anchor (the <Navigate> below owns that case), and the guard is
    // set BEFORE the async call so StrictMode's dev double-mount can't create a second draft.
    if (!anchor || startedRef.current) return disarm;
    startedRef.current = true;

    // createEstimateForAnchor drops the stale estimate lists as part of the create - without that
    // the workspace we are about to land on renders its tab strip from a list that predates the
    // estimate we just made, and App.tsx's client would keep it for five more minutes.
    createEstimateForAnchor(anchor, queryClient)
      .then((newId) => {
        // The row exists either way, but a user who hit Back while this was in flight must not be
        // yanked forward into it (react-router's useNavigate still works after unmount).
        if (!cancelledRef.current) navigate(`/estimates/${newId}`, { replace: true });
      })
      .catch((err) => {
        if (!cancelledRef.current) setError(extractApiError(err, 'Could not create the estimate.'));
      });

    return disarm;
  }, [anchor, navigate, queryClient]);

  // Pure derivation from the search params - no request to skip, and no one-frame "Creating
  // estimate..." flash before the bounce.
  if (!anchor) return <Navigate to="/estimates" replace />;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <p className="text-sm text-text-secondary">{error}</p>
        <Button variant="outline" onClick={() => navigate('/estimates', { replace: true })}>
          Back to estimates
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />
      <p className="text-sm text-text-secondary">Creating estimate...</p>
    </div>
  );
}
