import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LOST_REASON_OPTIONS } from '@/constants/lostReasons';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/**
 * The organisation's estimate decline reasons (decline-reasons slice B).
 *
 * TWO SURFACES READ THIS: the settings screen that curates the list, and - since slice C - the
 * STAFF decline dialog that offers it, through `useOfferedLostReasonOptions` at the bottom of
 * this file. The customer's picker does NOT come through here: the public estimate page is
 * unauthenticated and `api` sends a Bearer token, so it has its own token-scoped fetch in
 * `publicLostReasons.ts` (decision D6).
 *
 * Keyed on `code`, not on a row id, because half the answers this endpoint can give have no id:
 * an organisation that has never saved its list reads the five built-ins, which exist only in
 * code until its first save materialises them. See the controller header for the whole rule.
 */
export interface LostReasonOption {
  /** The stored value. Immutable - a declined estimate holds this string. */
  code: string;
  /** The words a customer and a staff member both read. Renameable. */
  label: string;
  is_active: boolean;
  sort_order: number;
  /** One of the five ServWave ships with: renameable and switchable, never removable. */
  is_builtin: boolean;
}

const KEY = ['lost-reason-options'];

export function useLostReasonOptions() {
  return useQuery<LostReasonOption[]>({
    queryKey: KEY,
    // The `?? []` matters for the same reason it does on job sub-statuses: a suite that mocks
    // axios with a `{ data: {} }` fallthrough would otherwise resolve undefined, and React Query
    // v5 logs "Query data cannot be undefined" for every one of them.
    queryFn: () => api.get('/api/lost-reason-options').then((r) => r.data.lost_reason_options ?? []),
  });
}

export function useCreateLostReasonOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label }: { label: string }) =>
      api.post('/api/lost-reason-options', { label }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (err) =>
      toast({
        title: 'Could not add that reason',
        description: extractApiError(err, 'Failed to add the decline reason'),
        variant: 'destructive',
      }),
  });
}

/** Rename, switch off, or switch back on. The server refuses to switch "Other" off. */
export function useUpdateLostReasonOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: { code: string; label?: string; is_active?: boolean }) =>
      api.patch(`/api/lost-reason-options/${code}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (err) =>
      toast({
        title: 'Could not update that reason',
        description: extractApiError(err, 'Failed to update the decline reason'),
        variant: 'destructive',
      }),
  });
}

export function useReorderLostReasonOptions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ordered_codes }: { ordered_codes: string[] }) =>
      api.post('/api/lost-reason-options/reorder', { ordered_codes }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (err) =>
      toast({
        title: 'Could not reorder the reasons',
        description: extractApiError(err, 'Failed to reorder the decline reasons'),
        variant: 'destructive',
      }),
  });
}

/**
 * The organisation's list in the shape a picker takes - slice C's staff half.
 *
 * `{ value, label }` rather than the DTO, because that is what `SelectField` reads and because a
 * picker has no business with `is_active` or `sort_order`. Order is the server's (sort_order then
 * code), so the dialog offers reasons in the order the admin dragged them into.
 *
 * INACTIVE ROWS ARE DROPPED HERE, NOT ON THE SERVER. `GET /api/lost-reason-options` answers with
 * the whole list including the switched-off rows, because the settings screen has to render them
 * in order to switch them back on. A picker is the one caller that wants only the live ones.
 *
 * THE BUILT-IN FALLBACK IS FOR "NOT LOADED", NOT FOR "EMPTY". An org that has saved its list and
 * switched rows off has curated it, and re-offering the five built-ins would put words back in
 * front of a customer that the admin deliberately retired. So the fallback is keyed on the query
 * having no answer yet (in flight, or failed) - which is also the case that matters, since a
 * picker that renders empty for a second costs the reason. D5 keeps "Other" un-deactivatable, so
 * a real org's live list is never empty anyway.
 */
export function useOfferedLostReasonOptions(): { value: string; label: string }[] {
  const { data } = useLostReasonOptions();
  return useMemo(() => {
    if (!data) return LOST_REASON_OPTIONS;
    return data.filter((o) => o.is_active).map((o) => ({ value: o.code, label: o.label }));
  }, [data]);
}
