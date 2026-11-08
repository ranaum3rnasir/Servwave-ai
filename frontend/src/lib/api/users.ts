import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

export type UserRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';

export interface UserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  // SRVW-138/139 - `role` above stays the BASE role; a custom role layers grants on top of it.
  // `custom_role_id` is the custom_roles.id FK; `custom_role` is the row's key/label for display.
  custom_role_id?: string | null;
  custom_role?: { key: string; label: string } | null;
  is_active: boolean;
  has_login: boolean;
  phone: string | null;
  phone_ext: string | null;
  /** Signed URL to the uploaded profile photo, or null for the initials tile. Never a stock/
   *  generated avatar (2026-08-04 plan) — the frontend renders it only alongside a fallback. */
  avatar_url: string | null;
  department_id: string | null;
  department: { id: string; name: string } | null;
  enforce_clock_in_location: boolean;
  can_approve_clock_overrides: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A row of the scoped assignable roster — `GET /api/users/assignable`.
 *
 * This is deliberately NOT a user record. A picker needs a name and something to group
 * by; it has never needed a contact card, and the narrowed field set is itself the
 * privacy control that lets a SALES user (who holds no `read User`) reach the roster at
 * all. Do not re-add email, phone, extension, login state, activity flags or timestamps
 * here: widening the type is what would push the server back to leaking them.
 */
export interface AssignableUser {
  id: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  department: { id: string; name: string } | null;
  /** Signed URL to the profile photo, or null for the initials tile. Optional so fixtures compile (#370). */
  avatar_url?: string | null;
}

export interface InviteUserPayload {
  first_name: string;
  last_name: string;
  email: string;
  role: UserRole;
  custom_role_id?: string | null;
  phone?: string | null;
  phone_ext?: string | null;
  department_id: string | null;
}

export interface InviteResult {
  user: UserRow;
  email_sent: boolean;
  invite_url: string;
}

export interface UpdateUserPayload {
  first_name?: string;
  last_name?: string;
  role?: UserRole;
  custom_role_id?: string | null;
  is_active?: boolean;
  phone?: string | null;
  phone_ext?: string | null;
  department_id?: string | null;
}

export interface UpdateMePayload {
  first_name?: string;
  last_name?: string;
  phone?: string | null;
  phone_ext?: string | null;
}

export function useUsers() {
  return useQuery<UserRow[]>({
    queryKey: ['users', 'all'],
    queryFn: () => api.get('/api/users').then((r) => r.data.users),
  });
}

/**
 * WHICH LIST IS THIS, AND THEREFORE WHICH GRANT SCOPES IT. Two families, and the split matters.
 *
 * POOL-GOVERNED — `jobCrew`, `walkthroughPerformer`, `task`. Each names a write the server's
 * assignee pool actually governs, and the server scopes the roster with the same module the
 * write validator asks: `jobCrew` and `walkthroughPerformer` read `assign User`, `task` reads
 * `assign Task`. Without the grant the caller gets themselves and nobody else — that is the
 * product rule, not a degraded response, so a narrowed roster is never something to "fix"
 * client-side. (`task` is additionally held open for a holder of `read User` pending #1950.)
 *
 * DIRECTORY — `directory`, gated on `read User`. For a people list NO pool rule governs: the
 * lead-owner picker, the job-dispatcher picker, the calendar-entry participants field, the
 * automation recipient pickers, the assignee filter dropdowns. None of those writes consults the
 * pool, so scoping them by `assign User` would hide people the API accepts — an org whose custom
 * role holds `read User` + `create Lead` but not `assign User` saw its "Assign to" dropdown
 * collapse to one row while `POST /api/leads` still took anybody. `read User` is what gated these
 * surfaces before the roster was split off, so this family changes nothing for anyone.
 *
 * PICKING ONE: ask whether the SAVE this list feeds goes through `isAssigneeSetPermitted` on the
 * server. Two doors do — job crew and walkthrough performers. Everything else is `directory`,
 * except the task ASSIGNEE field, which keeps `task`, and the task WATCHERS field, which has
 * `taskWatcher`.
 *
 * `taskWatcher` IS A THIRD FAMILY, GATED BY NO GRANT (#1956). Watching is an observation, not an
 * assignment, and its server pool is a COHORT — yourself, every admin, and your own department —
 * rather than a scope widened by a grant. It is deliberately not `task` (which reads
 * `assign Task`, a grant no seeded role holds, so the field offered exactly one name and watched
 * nothing) and not `directory` (which reads `read User`, which SALES does not hold, so the field
 * would 403 instead). The matching write guard lives in `task.controller`.
 */
export type AssigneePurpose = 'jobCrew' | 'walkthroughPerformer' | 'task' | 'directory' | 'taskWatcher';

/**
 * Normalise the roster payload to an array, always.
 *
 * The contract is a BARE array; `{ users }` is tolerated because 21 suites mock axios with
 * the old directory envelope, and because the failure mode of guessing wrong is severe and
 * silent-ish: every picker calls `.filter`/`.map` straight off this, so a non-array does not
 * degrade, it throws through the render. Returning `[]` for anything unrecognised means the
 * worst case is an empty picker rather than a blank page.
 *
 * The `{ users }` branch is transitional — drop it once the endpoint is live and those mocks
 * model it. `users.test.tsx` pins the bare array as the shape that must work.
 */
function rosterOf(payload: unknown): AssignableUser[] {
  if (Array.isArray(payload)) return payload as AssignableUser[];
  const wrapped = (payload as { users?: unknown } | null | undefined)?.users;
  return Array.isArray(wrapped) ? (wrapped as AssignableUser[]) : [];
}

export interface AssignableUsersOpts {
  /** Required: it selects the grant the server scopes by, so there is no safe default. */
  purpose: AssigneePurpose;
  enabled?: boolean;
  departmentId?: string;
  eligibleFor?: 'owner' | 'task' | 'dispatcher';
  /** Union in users referenced by existing job/lead assignments even if no longer
   * eligible for NEW assignments — keeps completeness filters from dropping people
   * who are genuinely assigned (e.g. a non-technician on a job). */
  includeReferencedIn?: 'jobs' | 'leads';
}

/**
 * The scoped roster every people-picker goes through.
 *
 * Points at `/api/users/assignable`, NOT the user directory: the directory is gated on
 * `read User`, which SALES does not hold, so a rep's pickers used to 403 into an empty
 * list and read "No more members".
 *
 * This roster answers "who may I ADD". It is not the source for the names of people
 * ALREADY on a record — those ride along on the record itself and stay visible to its
 * owner whether or not they hold the grant. A picker that resolves existing chips through
 * this list will render "Unknown" for a self-only requester.
 */
export function useAssignableUsers(opts: AssignableUsersOpts) {
  const { purpose, enabled = true, departmentId, eligibleFor, includeReferencedIn } = opts;
  return useQuery<AssignableUser[]>({
    // `purpose` is part of the key: a task roster and a crew roster are scoped by different
    // grants, so sharing one cache entry would let whichever loaded last overwrite the other.
    queryKey: [
      'users',
      'assignable',
      purpose,
      departmentId ?? null,
      eligibleFor ?? null,
      includeReferencedIn ?? null,
    ],
    queryFn: () =>
      api
        .get('/api/users/assignable', {
          params: {
            purpose,
            ...(departmentId ? { department_id: departmentId } : {}),
            ...(eligibleFor ? { eligible_for: eligibleFor } : {}),
            ...(includeReferencedIn ? { include_referenced_in: includeReferencedIn } : {}),
          },
        })
        .then((r) => rosterOf(r.data)),
    enabled,
    staleTime: 30_000,
    // Department switches re-key the query — keep the previous roster on screen so
    // member boards don't flash empty while the scoped list loads.
    placeholderData: keepPreviousData,
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: InviteUserPayload) =>
      api.post('/api/users/invite', payload).then((r) => r.data as InviteResult),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['departments'] });
      toast({
        title: data.email_sent ? 'Invitation sent' : 'User created — email not sent',
        description: data.email_sent
          ? `${data.user.email} can now set a password or sign in with Google.`
          : `Could not email the invite. Copy this link to share it manually: ${data.invite_url}`,
        variant: data.email_sent ? undefined : 'destructive',
      });
    },
    onError: (err) =>
      toast({
        title: 'Could not invite user',
        description: extractApiError(err, 'Failed to invite user'),
        variant: 'destructive',
      }),
  });
}

export function useSendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/users/${id}/invite`).then((r) => r.data as InviteResult),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast({
        title: data.email_sent ? 'Invitation sent' : 'Invite link ready — email not sent',
        description: data.email_sent
          ? `${data.user.email} can now set a password or sign in with Google.`
          : `Could not email the invite. Copy this link to share it manually: ${data.invite_url}`,
        variant: data.email_sent ? undefined : 'destructive',
      });
    },
    onError: (err) =>
      toast({
        title: 'Could not send invite',
        description: extractApiError(err, 'Failed to send invite'),
        variant: 'destructive',
      }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateUserPayload }) =>
      api.patch(`/api/users/${id}`, payload).then((r) => r.data.user as UserRow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update user'),
        variant: 'destructive',
      }),
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Deactivate failed',
        description: extractApiError(err, 'Could not deactivate user'),
        variant: 'destructive',
      }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}/permanent`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Delete failed',
        description: extractApiError(err, 'Could not delete user'),
        variant: 'destructive',
      }),
  });
}

export function useRevokeLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/users/${id}/revoke-login`).then((r) => r.data.user as UserRow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Could not disable login',
        description: extractApiError(err, 'Failed to disable login'),
        variant: 'destructive',
      }),
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateMePayload) =>
      api.patch('/api/users/me', payload).then((r) => r.data.user as UserRow),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update your profile'),
        variant: 'destructive',
      }),
  });
}

export interface AvatarResult {
  avatar_url: string | null;
}

/** Upload/replace a profile photo. `userId` omitted → self (`/me/avatar`, no capability check);
 *  provided → admin-on-behalf-of (`/:id/avatar`, `canDo('update','User')` server-side). */
export function useSetAvatar(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const path = userId ? `/api/users/${userId}/avatar` : '/api/users/me/avatar';
      return api
        .post(path, form, { headers: { 'Content-Type': 'multipart/form-data' } })
        .then((r) => r.data as AvatarResult);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Upload failed',
        description: extractApiError(err, 'Could not upload photo'),
        variant: 'destructive',
      }),
  });
}

/** Remove a profile photo, reverting to the initials tile. Same `userId` convention as useSetAvatar. */
export function useDeleteAvatar(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const path = userId ? `/api/users/${userId}/avatar` : '/api/users/me/avatar';
      return api.delete(path).then((r) => r.data as AvatarResult);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Remove failed',
        description: extractApiError(err, 'Could not remove photo'),
        variant: 'destructive',
      }),
  });
}

export function useChangeMyPassword() {
  return useMutation({
    // SECURITY (review #4): the backend requires + re-verifies the current password.
    mutationFn: ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) =>
      api
        .post('/api/users/me/password', { current_password: currentPassword, password: newPassword })
        .then((r) => r.data),
    onError: (err) =>
      toast({
        title: 'Password change failed',
        description: extractApiError(err, 'Could not change your password'),
        variant: 'destructive',
      }),
  });
}

// ─── Per-user permission overrides (RBAC Phase 2) ───

export type OverrideState = 'inherit' | 'allow' | 'deny';

export interface UserCapability {
  action: string;
  subject: string;
  label: string;
  description: string;
  roleDefault: 'allowed' | 'not-in-role';
  override: OverrideState;
  effective: boolean;
}

export interface UserPermissions {
  user_id: string;
  editable: boolean;
  capabilities: UserCapability[];
}

export interface PermissionOverrideInput {
  action: string;
  subject: string;
  effect: 'allow' | 'deny';
}

export function useUserPermissions(id: string | null) {
  return useQuery<UserPermissions>({
    queryKey: ['user-permissions', id],
    queryFn: () => api.get(`/api/users/${id}/permissions`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useUpdateUserPermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, overrides }: { id: string; overrides: PermissionOverrideInput[] }) =>
      api.put(`/api/users/${id}/permissions`, { overrides }).then((r) => r.data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['user-permissions', vars.id] });
      qc.invalidateQueries({ queryKey: ['users'] });
      toast({ title: 'Permissions updated' });
    },
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update permissions'),
        variant: 'destructive',
      }),
  });
}
