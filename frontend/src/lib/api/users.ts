import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { allPersonSwitchesKey, MAILBOXES_KEY } from '@/lib/api/shared/queryKeys';

export type UserRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';

export interface UserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  /** Whether the person is an Admin (P15): the flag on the person, never the role name. */
  is_admin?: boolean;
  // SRVW-138/139 - `role` above stays the BASE role; a custom role layers grants on top of it.
  // `custom_role_id` is the custom_roles.id FK; `custom_role` is the row's key/label for display.
  custom_role_id?: string | null;
  custom_role?: { key: string; label: string } | null;
  /** The name of the role the person holds, and how many of their switches differ from it (the role column). */
  role_label?: string;
  change_count?: number;
  /** The server's answer on the people list: in the Admin box (full access, no switches to set). A role copied from
   *  Admin is not in it, whatever its base role. */
  admin_box?: boolean;
  /** The person's own mailbox on the Users page's Email column (PRD 10): the primary address in full, with none while
   *  the person is in "address needed". `address_suffix` is what follows the name part (`.company@domain`), for the
   *  set and change dialogs. Null for a person with no live mailbox; also null while the company lacks the Email plan
   *  feature. */
  mailbox?: { status: string; address: string | null; address_suffix: string | null } | null;
  /** Where a deactivated person's mailbox went (PRD 10, S10.22): handed to a person, or merged into the main mailbox. Null for an
   *  active person, for a leaver with no mailbox, and while the company lacks the Email plan feature. */
  mailbox_handover?: { to: 'main' } | { to: 'person'; user_id: string; name: string } | null;
  /** The person's own switches turn Access Communication or Show Email off: they cannot read their mailbox. */
  email_page_closed?: boolean;
  is_active: boolean;
  /** Set when an Admin erased this deactivated person's personal data: they read as "Former user" and cannot be brought back. */
  erased_at?: string | null;
  has_login: boolean;
  /** A revoke that could not finish: sign-in is off, but Revoke is still offered so the Admin can try again (H2). */
  revoke_pending?: boolean;
  /** Make Owner (ticket 27): this person could become the Owner (an active Admin who has signed in). Only ever true on the
   *  Owner's own list; false for everyone else. */
  owner_eligible?: boolean;
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
  /** Handed back to the Owner only on a resend (ticket 26); absent for anyone else. */
  invite_url?: string;
}

export interface UpdateUserPayload {
  first_name?: string;
  last_name?: string;
  role?: UserRole;
  custom_role_id?: string | null;
  /** Grant or take away Admin. Left out, a change of role carries the flag with it. */
  is_admin?: boolean;
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

/** The people list as an Admin gets it: the full record. Admin screens only (Users & Teams, a person's switches, Spider). */
export function useUsers() {
  return useQuery<UserRow[]>({
    queryKey: ['users', 'all'],
    queryFn: () => api.get('/api/users').then((r) => r.data.users),
  });
}

/**
 * A person on the people list as a non-Admin gets them (M3, ticket 29): id, name, avatar and whether they are active,
 * and nothing else. An Admin's full row has all of these too, so a screen typed on this works for everyone.
 */
export type PersonName = Pick<UserRow, 'id' | 'first_name' | 'last_name' | 'is_active'> & { avatar_url?: string | null };

/** The same people list, typed for a screen anyone may open: it can read only what every requester gets. */
export function usePeople() {
  return useQuery<UserRow[], Error, PersonName[]>({
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

/**
 * The slot a people picker fills. The server answers each from the person's own switch (Can own leads /
 * be Sold By, Can be a dispatcher, Can be on a crew), never from a role name, and lists only active people.
 */
export type PickerSlot = 'owner' | 'dispatcher' | 'crew';

/** What `eligible_for` accepts: a slot, or `task` (the task owner and watcher pool, which is not a slot). */
export type EligibleFor = PickerSlot | 'task';

export interface AssignableUsersOpts {
  /** Required: it selects the grant the server scopes by, so there is no safe default. */
  purpose: AssigneePurpose;
  enabled?: boolean;
  departmentId?: string;
  eligibleFor?: EligibleFor;
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
        title: data.email_sent ? 'Invitation sent' : 'User created - email not sent',
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
        title: data.email_sent ? 'Invitation sent' : data.invite_url ? 'Invite link ready - email not sent' : 'Invite not sent',
        description: data.email_sent
          ? `${data.user.email} can now set a password or sign in with Google.`
          : data.invite_url
            ? `Could not email the invite. Copy this link to share it manually: ${data.invite_url}`
            : 'Could not email the invite. Please try again.',
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
    onSuccess: () => {
      // A role change fills the person's switches and moves who they are based on.
      void qc.invalidateQueries({ queryKey: allPersonSwitchesKey });
      return qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) =>
      toast({
        title: 'Update failed',
        description: extractApiError(err, 'Could not update user'),
        variant: 'destructive',
      }),
  });
}

/**
 * Set or change the name part of a person's mailbox address (the part before the company and the domain). The server
 * builds the address, refuses a taken, malformed or reserved name part in plain words, and leaves the old address
 * delivering. The caller shows a refusal itself, under its field, so there is no toast here.
 */
export function useSetMailboxAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, namePart }: { id: string; namePart: string }) =>
      api.put(`/api/users/${id}/mailbox-address`, { name_part: namePart }).then((r) => r.data.mailbox as { status: string; address: string }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['communication', 'my-mailbox'] });
      return qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/**
 * Hand a deactivated person's mailbox to another person or to the main mailbox, later. `handoverTo` is "main" or an active
 * person's id. The conversations and the addresses go with it; the previous holder loses it on their next request.
 */
export function useMoveMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, handoverTo }: { id: string; handoverTo: string }) =>
      api.put(`/api/users/${id}/mailbox-handover`, { handover_to: handoverTo }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MAILBOXES_KEY });
      return qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) =>
      toast({
        title: 'Move failed',
        description: extractApiError(err, 'Could not move the mailbox'),
        variant: 'destructive',
      }),
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    // `handoverTo` is who gets the person's email: "main" or an active person's id. Left out, the server uses the main mailbox.
    mutationFn: ({ id, handoverTo }: { id: string; handoverTo?: string }) =>
      (handoverTo === undefined ? api.delete(`/api/users/${id}`) : api.delete(`/api/users/${id}`, { data: { handover_to: handoverTo } }))
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) =>
      toast({
        title: 'Deactivate failed',
        description: extractApiError(err, 'Could not deactivate user'),
        variant: 'destructive',
      }),
  });
}

/** Erase a deactivated person's personal data (an Admin's step). The row and every record that names them stay. */
export function useErasePersonalData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${id}/erase-personal-data`).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      return qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) =>
      toast({
        title: 'Erase failed',
        description: extractApiError(err, 'Could not erase their personal data'),
        variant: 'destructive',
      }),
  });
}

export type ReassignModuleKey = 'tasks' | 'leads' | 'jobs';

/** What deactivating a person leaves open: per module, how many open records name them. Counts only. */
export interface DeactivationSummary {
  person: { id: string; first_name: string; last_name: string; is_active: boolean };
  modules: Array<{ key: ReassignModuleKey; label: string; open: number }>;
  total: number;
}

export function useDeactivationSummary(userId: string | undefined) {
  return useQuery<DeactivationSummary>({
    queryKey: ['users', userId, 'deactivation-summary'],
    queryFn: () => api.get(`/api/users/${userId}/deactivation-summary`).then((r) => r.data),
    enabled: !!userId,
    // The numbers are read when the dialog opens and must be the current ones.
    staleTime: 0,
  });
}

const NOT_MOVED_NOUN: Record<ReassignModuleKey, [string, string]> = {
  tasks: ['open task', 'open tasks'],
  leads: ['open lead', 'open leads'],
  jobs: ['open job', 'open jobs'],
};

/** "1 open lead, 2 open jobs" for the records a reassign could not move, or null when it moved everything. */
export function notMovedText(skipped: Partial<Record<ReassignModuleKey, number>> | undefined): string | null {
  const parts = (Object.keys(NOT_MOVED_NOUN) as ReassignModuleKey[])
    .filter((k) => (skipped?.[k] ?? 0) > 0)
    .map((k) => `${skipped![k]} ${NOT_MOVED_NOUN[k][skipped![k] === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(', ') : null;
}

/** Move a person's open records of the chosen modules to another active person (an Admin's optional step). */
export function useReassignOpenRecords() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, toUserId, modules }: { id: string; toUserId: string; modules: ReassignModuleKey[] }) =>
      api.post(`/api/users/${id}/reassign`, { to_user_id: toUserId, modules }).then((r) => r.data as {
        moved: Record<ReassignModuleKey, number>;
        skipped: Record<ReassignModuleKey, number>;
      }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      // A status never claims success for a failure (CR-5): what the person taking over could not hold is said, by module.
      const left = notMovedText(result?.skipped);
      if (left) {
        toast({
          title: 'Some open records were not moved',
          description: `${left} could not be moved: the person you chose can't hold those spots. They stay with the person you deactivated.`,
          variant: 'destructive',
        });
      }
    },
    onError: (err) =>
      toast({
        title: 'Reassign failed',
        description: extractApiError(err, 'Could not move their open records'),
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

/** Shown when Revoke got no answer from the server: it may or may not have finished, and the list (read again) says which. */
export const REVOKE_LOGIN_UNCONFIRMED_MESSAGE = 'Revoke login may not have finished. Check the list and try again.';

function revokeLoginErrorText(err: unknown): string {
  const serverMessage = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof serverMessage === 'string' && serverMessage.trim() ? serverMessage : REVOKE_LOGIN_UNCONFIRMED_MESSAGE;
}

export function useRevokeLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/users/${id}/revoke-login`).then((r) => r.data.user as UserRow),
    // Success or not, the list is read again, so the row shows what the server holds (H2: a failed revoke changes nothing).
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
    // The server's own words: a failed revoke says the person can still sign in (H2). Never reports success, and never shows
    // raw network text: with no answer at all, nobody knows whether it finished, so it says only that.
    onError: (err) =>
      toast({
        title: 'Could not revoke login',
        description: revokeLoginErrorText(err),
        variant: 'destructive',
      }),
  });
}

export const PASSWORD_RESET_NOT_SENT_MESSAGE = "We couldn't send the email. Try again or contact ServWave support.";
export const PASSWORD_RESET_ADMIN_LIMIT_MESSAGE = "You've sent a lot of reset links in the last 15 minutes. Try again in a few minutes.";

/** The words for a failed send: the server's own (the per-email limit, no login), else ServWave copy. */
function passwordResetErrorText(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: { error?: unknown; code?: unknown } } })?.response;
  // The per-admin request limiter answers a bare "Too many requests" with no code.
  if (response?.status === 429 && !response.data?.code) return PASSWORD_RESET_ADMIN_LIMIT_MESSAGE;
  const serverMessage = response?.data?.error;
  return typeof serverMessage === 'string' && serverMessage.trim() ? serverMessage : PASSWORD_RESET_NOT_SENT_MESSAGE;
}

/**
 * "Send password reset" on Users & Teams (password reset spec §7): the server emails the person the
 * same reset link "Forgot password?" sends. The admin never sees the link or a password; the answer
 * is only where the email went. Every failure gets this hook's one toast (`silentErrors` keeps the
 * app-wide "Slow down" toast off a per-email limit), never raw network text.
 */
export function useSendPasswordReset() {
  return useMutation({
    mutationFn: (id: string) =>
      api
        .post(`/api/users/${id}/password-reset`, undefined, { silentErrors: true })
        .then((r) => r.data as { ok: true; email: string }),
    onSuccess: ({ email }) => toast({ title: `Reset link sent to ${email}.` }),
    onError: (err) =>
      toast({ title: 'Password reset not sent', description: passwordResetErrorText(err), variant: 'destructive' }),
  });
}

/**
 * Make Owner (ticket 27, D1): ask to hand the company to this person. Nothing changes yet: the server emails the signed-in Owner
 * a one-time approval link. The caller shows the "check your email" step; a refusal shows the server's words.
 */
export function useMakeOwner() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/users/${id}/make-owner`, undefined, { silentErrors: true }).then((r) => r.data as { email_sent: true }),
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
