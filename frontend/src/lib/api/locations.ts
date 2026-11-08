import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';

export interface Location {
  id: string;
  name: string;
  code: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  timezone: string | null;
  phone: string | null;
  manager_id: string | null;
  manager?: { id: string; first_name: string; last_name: string } | null;
  _count?: { members: number };
  /**
   * Whether this location can still be booked into (visit-location spec D9).
   *
   * OPTIONAL on the type, deliberately. The column is NOT NULL server-side, so a live response
   * always carries it - but every older test stub in this repo builds a Location literal without
   * it, and a required field would make each of those a type error for no behavioural gain.
   * Every reader treats "absent" as active, which is the only safe reading: absent-means-archived
   * would empty every picker in the product.
   */
  is_active?: boolean;
  archived_at?: string | null;
}

/**
 * `is_active` / `archived_at` are excluded: they are changed through the archive and unarchive
 * doors, never by the edit form. Leaving them in would let a full-row PATCH silently un-archive a
 * closed branch as a side effect of correcting its phone number.
 */
export type LocationInput = Omit<Location, 'id' | 'manager' | '_count' | 'is_active' | 'archived_at'>;

/** A location an office can still book a visit into. Absent `is_active` is a pre-slice-2 row. */
export const isBookableLocation = (loc: Pick<Location, 'is_active'>): boolean => loc.is_active !== false;

export function useLocations() {
  return useQuery<Location[]>({
    queryKey: ['locations'],
    queryFn: () => api.get('/api/locations').then((r) => r.data),
  });
}

export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: Partial<LocationInput>) => api.post('/api/locations', d).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...d }: { id: string } & Partial<LocationInput>) =>
      api.patch(`/api/locations/${id}`, d).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

/**
 * Archive and unarchive (visit-location spec D9).
 *
 * Delete is still below and still the right answer for a location nothing references. These are
 * the escape for one that IS referenced: the row stays alive so every visit already booked there
 * keeps resolving, and it leaves every booking picker so nobody books into a closed branch.
 *
 * `unarchive`, matching `POST /api/customers/:id/unarchive` - the repo's only other archive/undo
 * pair - while the button the admin presses still says "Restore". The API verb and the UI word
 * diverge here on purpose, exactly as "walkthrough" and `visits` already do.
 *
 * Both invalidate `['locations']`, which is the same cache the booking picker reads - so a branch
 * archived in Settings disappears from the picker in another tab's next fetch without a reload.
 */
export function useArchiveLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/locations/${id}/archive`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useUnarchiveLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/locations/${id}/unarchive`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useDeleteLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/locations/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}
