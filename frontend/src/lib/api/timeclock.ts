import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import type { Punch } from '@/lib/timeclock/types';

// ─── Shared types ──────────────────────────────────────────────────────────

export type PunchScope = 'me' | 'org';

/** A geofence store as the backend persists it (no client-only `address`). */
export interface GeofenceStore {
  id: string;
  label: string;
  lat: number;
  lng: number;
}

export interface GeofenceConfigDTO {
  radiusM: number;
  stores: GeofenceStore[];
}

/** The 422 body the server returns when an IN is blocked and no override yet. */
export interface OverrideVerdict {
  inZone: boolean;
  matched: { id: string; label: string; kind: 'store' | 'job' } | null;
  nearest: { id: string; label: string; kind: 'store' | 'job'; distanceM?: number } | null;
  distanceM: number;
}

export interface RequiresOverrideBody {
  requiresOverride: true;
  verdict: OverrideVerdict;
}

export interface RecordPunchInput {
  type: 'IN' | 'OUT';
  lat: number;
  lng: number;
  accuracy_m?: number;
  override?: boolean;
}

export type OtState = 'APPROVED' | 'REJECTED';

export interface OtReviewRow {
  user_id: string;
  period_key: string;
  state: OtState;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface UpdateUserTimeclockSettingsInput {
  id: string;
  enforce_clock_in_location?: boolean;
  can_approve_clock_overrides?: boolean;
}

// ─── Query keys ────────────────────────────────────────────────────────────

const PUNCHES_KEY = ['timeclock', 'punches'] as const;
const CONFIG_KEY = ['timeclock', 'config'] as const;
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
    zoneLabel: isClockedIn ? last!.matchedZoneLabel : null,
    isLoading,
  };
}

/**
 * Record a punch. The mutation deliberately does NOT swallow the 422/409 cases —
 * it rejects with the raw AxiosError so the caller can read `requiresOverride` /
 * `verdict` off `error.response.data` (422) or the 409 `error` message and drive
 * the override / re-punch UX. Only unexpected (5xx, network) errors toast here.
 */
export function useRecordPunch() {
  const qc = useQueryClient();
  return useMutation<Punch, AxiosError<RequiresOverrideBody | { error: string }>, RecordPunchInput>({
    mutationFn: (input) =>
      api.post('/api/timeclock/punches', input).then((r) => r.data.punch as Punch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PUNCHES_KEY });
    },
    onError: (err) => {
      // 422 (needs override) and 409 (re-punch) are flow signals the button handles.
      const status = err.response?.status;
      if (status === 422 || status === 409) return;
      toast({
        title: 'Punch failed',
        description: extractApiError(err, 'Could not record your punch'),
        variant: 'destructive',
      });
    },
  });
}

// ─── Geofence config + stores ────────────────────────────────────────────────

export function useGeofenceConfig() {
  return useQuery<GeofenceConfigDTO>({
    queryKey: CONFIG_KEY,
    queryFn: () => api.get('/api/timeclock/config').then((r) => r.data as GeofenceConfigDTO),
  });
}

export function useUpdateGeofenceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (radiusM: number) =>
      api.put('/api/timeclock/config', { radiusM }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONFIG_KEY }),
    onError: (err) =>
      toast({
        title: 'Save failed',
        description: extractApiError(err, 'Could not update clock-in radius'),
        variant: 'destructive',
      }),
  });
}

export function useCreateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { label: string; lat: number; lng: number }) =>
      api.post('/api/timeclock/stores', payload).then((r) => r.data.store as GeofenceStore),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONFIG_KEY }),
    onError: (err) =>
      toast({
        title: 'Could not add store',
        description: extractApiError(err, 'Failed to add store'),
        variant: 'destructive',
      }),
  });
}

export function useUpdateStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: { label?: string; lat?: number; lng?: number };
    }) => api.patch(`/api/timeclock/stores/${id}`, payload).then((r) => r.data.store as GeofenceStore),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONFIG_KEY }),
    onError: (err) =>
      toast({
        title: 'Save failed',
        description: extractApiError(err, 'Could not update store'),
        variant: 'destructive',
      }),
  });
}

export function useDeleteStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/timeclock/stores/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONFIG_KEY }),
    onError: (err) =>
      toast({
        title: 'Delete failed',
        description: extractApiError(err, 'Could not delete store'),
        variant: 'destructive',
      }),
  });
}

// ─── Per-user timeclock settings ─────────────────────────────────────────────

export function useUpdateUserTimeclockSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...settings }: UpdateUserTimeclockSettingsInput) =>
      api.patch(`/api/timeclock/users/${id}/timeclock-settings`, settings).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update timeclock settings'),
        variant: 'destructive',
      }),
  });
}

// ─── Override decisions ──────────────────────────────────────────────────────

export function useApproveOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/timeclock/punches/${id}/override/approve`).then((r) => r.data.punch as Punch),
    onSuccess: () => qc.invalidateQueries({ queryKey: PUNCHES_KEY }),
    onError: (err) =>
      toast({
        title: 'Approve failed',
        description: extractApiError(err, 'Could not approve override'),
        variant: 'destructive',
      }),
  });
}

export function useRejectOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/timeclock/punches/${id}/override/reject`).then((r) => r.data.punch as Punch),
    onSuccess: () => qc.invalidateQueries({ queryKey: PUNCHES_KEY }),
    onError: (err) =>
      toast({
        title: 'Reject failed',
        description: extractApiError(err, 'Could not reject override'),
        variant: 'destructive',
      }),
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
