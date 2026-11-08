import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

export interface RoleSummary {
  role: string;
  label: string;
  fullAccess: boolean;
  editable: boolean;
  userCount: number;
  type: string;
  // SRVW-138/139 - present only on type:'custom' entries. `id` is the real custom_roles.id -
  // users.custom_role_id is a UUID FK to it, NOT the key, so a role picker that assigns a user
  // to this role needs `id`, not `role`.
  id?: string;
  description?: string;
  base_role?: string;
}

export type ScopeValue = 'All' | 'Owned' | 'Team' | 'Location';
export type CrudCell = { read: boolean; create: boolean; update: boolean; delete: boolean };
// SRVW-139 - toggle bundles for actions the CRUD matrix can't host (no create action, or a
// single lifecycle verb rather than a CRUD cell). Keep in lockstep with backend TOGGLES
// (roleViewModel.ts) - same shape as MODULES parity, but a fixed-key record needs no regex test.
export type RoleToggles = {
  dashboard: boolean;
  accountSettings: boolean;
  notifications: boolean;
  modifyDoneJobs: boolean;
  cancelJobs: boolean;
  // Multi-visit close-out (Q9, 2026-08-23) - the milestone-verb toggles. Previously each of these
  // lived ONLY on the per-user Permissions page (a different capability surface entirely); the
  // Roles & Permissions page had no cell for any of them.
  enRouteJobs: boolean;
  arriveJobs: boolean;
  startJobs: boolean;
  completeJobs: boolean;
  rescheduleJobs: boolean;
};

export interface RoleViewModel {
  role: string;
  editable: boolean;
  matrix: Record<string, CrudCell>;
  // SRVW-140 - `viewReports` is the honest control for `read Report`, split out of
  // "See financial data" (which now writes the `read Pricing` grant canSeePricing keys on).
  // Editable record IDs (2026-08-19 plan, decision #7) - `editRecordIds` is permission plumbing
  // for a NOT-YET-BUILT capability (the PATCH .../:id/number endpoints ship in a later PR).
  // Manual Communication Log slice 4 - `logPastCommunications` writes `log_past Communication`,
  // and ONLY that. It is deliberately not a CRUD cell: `Communication` already has a matrix row,
  // and its `create` grant is SHARED_BASELINE (click-to-call, texts, WhatsApp, email). Keep in
  // lockstep with backend SENSITIVE (roleViewModel.ts) - a key missing here is posted as absent,
  // and MANAGED_KEYS then DELETES the grant on the next Save.
  // Scoped assignee pool slice 1 - `assignOthers` writes `assign User`, and ONLY that: "may name
  // somebody other than themselves on a job crew or a walkthrough performer list". Deliberately
  // not a fifth cell on the Users matrix row - those four cells administer staff RECORDS, which
  // is a different question from whose names a role may put on work. Keep in lockstep with
  // backend SENSITIVE (roleViewModel.ts): a key missing here is posted as absent, and
  // MANAGED_KEYS then DELETES the grant on the next Save.
  sensitive: {
    seeFinancials: boolean;
    managePayments: boolean;
    viewReports: boolean;
    editRecordIds: boolean;
    logPastCommunications: boolean;
    // #2046 - "Access the Communication section" (org-wide inbox, call log, phone settings),
    // writes `access_inbox Communication` and ONLY that. A key missing here is posted as absent,
    // and MANAGED_KEYS then DELETES the grant on the next Save (same contract as the neighbouring
    // sensitive keys) - see backend SENSITIVE (roleViewModel.ts).
    accessCommunicationSection: boolean;
    assignOthers: boolean;
  };
  toggles: RoleToggles;
  scope: Record<string, ScopeValue>;
  general: { description: string };
}

export interface CreateRolePayload {
  label: string;
  base_role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';
  description?: string;
  clone_grants_from?: string;
}

// SRVW-138/139 - a role picker (StaffFormDialog, UsersTeamsPage) needs ONE flat list of
// assignable roles. `roles` already carries both the 4 system entries and the org's custom
// ones under the same `role` field (the custom key), so no separate merge is needed here.
export function roleAssignmentOptions(roles: RoleSummary[]): Array<{ value: string; label: string }> {
  return roles.map((r) => ({ value: r.role, label: r.label }));
}

// Resolve a picker's selected value back to what the user-assignment API actually needs: the
// BASE role (users.role) + the custom role's real id (users.custom_role_id), or null for a
// plain system role. Falls back to treating `value` as a bare base role if it doesn't match any
// entry in `roles` (e.g. roles hasn't loaded yet) - never silently drops the selection.
export function resolveRoleAssignment(
  roles: RoleSummary[],
  value: string,
): { role: string; custom_role_id: string | null } {
  const match = roles.find((r) => r.role === value);
  if (match?.type === 'custom' && match.id) {
    return { role: match.base_role ?? value, custom_role_id: match.id };
  }
  return { role: value, custom_role_id: null };
}

export function useRoles() {
  return useQuery<RoleSummary[]>({
    queryKey: ['roles'],
    queryFn: () => api.get('/api/roles').then((r) => r.data),
  });
}

export function useRolePermissions(role: string) {
  return useQuery<RoleViewModel>({
    queryKey: ['roles', role, 'permissions'],
    queryFn: () => api.get(`/api/roles/${role}/permissions`).then((r) => r.data),
    enabled: !!role,
  });
}

export function useUpdateRolePermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, vm }: { role: string; vm: Omit<RoleViewModel, 'editable'> }) =>
      api.put(`/api/roles/${role}/permissions`, vm).then((r) => r.data),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['roles', v.role] }),
    onError: (err) =>
      toast({
        title: 'Save failed',
        description: extractApiError(err, 'Could not save role permissions'),
        variant: 'destructive',
      }),
  });
}

export function useResetRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: string) => api.post(`/api/roles/${role}/reset`).then((r) => r.data),
    onSuccess: (_d, role) => qc.invalidateQueries({ queryKey: ['roles', role] }),
    onError: (err) =>
      toast({
        title: 'Reset failed',
        description: extractApiError(err, 'Could not reset role'),
        variant: 'destructive',
      }),
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateRolePayload) => api.post('/api/roles', payload).then((r) => r.data as RoleSummary),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }),
    onError: (err) =>
      toast({
        title: 'Could not create role',
        description: extractApiError(err, 'Failed to create role'),
        variant: 'destructive',
      }),
  });
}

export function useRenameRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ role, label, description }: { role: string; label?: string; description?: string }) =>
      api.patch(`/api/roles/${role}`, { label, description }).then((r) => r.data as RoleSummary),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }),
    onError: (err) =>
      toast({
        title: 'Could not update role',
        description: extractApiError(err, 'Failed to update role'),
        variant: 'destructive',
      }),
  });
}

export function useArchiveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: string) => api.post(`/api/roles/${role}/archive`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }),
    onError: (err) =>
      toast({
        title: 'Could not archive role',
        description: extractApiError(err, 'Failed to archive role'),
        variant: 'destructive',
      }),
  });
}
