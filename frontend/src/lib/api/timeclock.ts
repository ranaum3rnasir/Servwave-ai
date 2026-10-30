import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import type { Punch } from '@/lib/timeclock/types';

// ─── Shared types ──────────────────────────────────────────────────────────

export type PunchScope = 'me' | 'org';

export interface RecordPunchInput {
  type: 'IN' | 'OUT';
  lat: number;
  lng: number;
  accuracy_m?: number;
}

export type OtState = 'APPROVED' | 'REJECTED';

export interface OtReviewRow {
  user_id: string;
  period_key: string;
  state: OtState;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

// ─── Query keys ────────────────────────────────────────────────────────────

const PUNCHES_KEY = ['timeclock', 'punches'] as const;
const OT_REVIEWS_KEY = ['timeclock', 'ot-reviews'] as const;

// ─── Punches ───────────────────────────────────────────────────────────────

export function usePunches(params: { scope: PunchScope; from?: string; to?: string }) {
  const { scope, from, to } = params;
  return useQuery<Punch[]>({
    queryKey: [...PUNCHES_KEY, scope, from ?? null, to ?? null],
    queryFn: () =>
      api
        .get('/api/timeclock/punches', { params: { scope, from, to } })
        .then((r) => r.data.punches as Punch[]),
  });
}

/**
 * Derived clock status for the current user — the single source of truth for the
 * header avatar dot and the dropdown punch block. `scope: 'me'` is already
 * user-scoped server-side, so the most-recent punch decides it (trailing IN =
 * still on the clock). React Query dedupes the shared query, so calling this in
 * both the header and the menu is one request.
 */
export function useIsClockedIn() {
  const { data: punches = [], isLoading } = usePunches({ scope: 'me' });
  const last = punches.length
    ? punches.reduce((a, b) => (b.ts > a.ts ? b : a))
    : null;
  const isClockedIn = last?.type === 'IN';
  return {
    isClockedIn,
    sinceTs: isClockedIn ? last!.ts : null,
    isLoading,
  };
}

/**
 * Record a punch. The mutation deliberately does NOT swallow the 409 case (already clocked in / not clocked in) -
 * it rejects with the raw AxiosError so the caller can reconcile to the server's state. Nothing blocks a punch
 * by where it happens; only unexpected (5xx, network) errors toast here.
 */
export function useRecordPunch() {
  const qc = useQueryClient();
  return useMutation<Punch, AxiosError<{ error: string }>, RecordPunchInput>({
    mutationFn: (input) =>
      api.post('/api/timeclock/punches', input).then((r) => r.data.punch as Punch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PUNCHES_KEY });
    },
    onError: (err) => {
      // 409 (re-punch) is a flow signal the button handles.
      if (err.response?.status === 409) return;
      toast({
        title: 'Punch failed',
        description: extractApiError(err, 'Could not record your punch'),
        variant: 'destructive',
      });
    },
  });
}

// ─── Overtime reviews ────────────────────────────────────────────────────────

export function useOtReviews(params: { scope: PunchScope; from?: string; to?: string }) {
  const { scope, from, to } = params;
  return useQuery<OtReviewRow[]>({
    queryKey: [...OT_REVIEWS_KEY, scope, from ?? null, to ?? null],
    queryFn: () =>
      api
        .get('/api/timeclock/ot-reviews', { params: { scope, from, to } })
        .then((r) => r.data.reviews as OtReviewRow[]),
  });
}

export function useUpsertOtReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { user_id: string; period_key: string; state: OtState }) =>
      api.post('/api/timeclock/ot-reviews', payload).then((r) => r.data.review as OtReviewRow),
    onSuccess: () => qc.invalidateQueries({ queryKey: OT_REVIEWS_KEY }),
    onError: (err) =>
      toast({
        title: 'Save failed',
        description: extractApiError(err, 'Could not record OT decision'),
        variant: 'destructive',
      }),
  });
}
