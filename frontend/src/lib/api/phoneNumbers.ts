import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { fmtPhone } from '@/lib/api/communication-shared';
import { toast } from '@/ui-kit/components/ui/sonner';
import { featureNotInPlanCopy } from '@/lib/entitlements/catalog';

/**
 * Slice 3 — Caller-ID admin (phone-number ↔ user assignments).
 *
 * Reads/writes the tenant-scoped, admin-only endpoints under
 * `/api/communication` that the outbound resolver uses to pick a user's "from"
 * number:
 *   - which users may send from a number (the assignment set),
 *   - each user's personal default number,
 *   - the single org-wide default number.
 *
 * Same http client + query-key idiom as the sibling communication hooks
 * (`@/lib/api/communication`). Every mutation invalidates the one list query
 * when it SETTLES - success or failure - so the page always renders server
 * truth after a write, including after a write that failed half-way.
 *
 * Every mutation also reports its own outcome in a toast (Caller ID slice 02):
 * a success toast, or an error toast carrying the server's message. That lives
 * here, not in the page, so every screen that edits caller ID reports saves the
 * same way. The app has no global mutation error handler, so before this a
 * failed save was silent. The side panel's Save makes several calls as one
 * change, so it uses `useSaveNumberPeople`, which keeps them quiet and reports
 * a single outcome (slice 03).
 *
 * Every save request is sent with `silentErrors`, so the app-wide plan-gate,
 * rate-limit and server-error toasts stay quiet for it: a failed save shows
 * exactly ONE toast, its own, which names the save that failed.
 */

/** One user permitted to send from a number, with their per-number default flag. */
export type NumberAssignmentUser = {
  user_id: string;
  user_name: string;
  /** True when this number is the user's default caller ID. */
  is_default: boolean;
};

/** A phone number plus who can send from it and whether it's the org default.
 *  Released numbers never appear (the endpoint leaves them out). */
export type NumberAssignmentRow = {
  id: string;
  e164: string;
  label: string | null;
  is_org_default: boolean;
  /** False = calls only. Outbound texts skip a calls-only default and go out
   *  from a different number. */
  sms_enabled: boolean;
  /** `active`, `paused`, `pending` (a purchase still being set up) or
   *  `inactive` (the org disconnected its phone service; a reconnect brings it
   *  back). Released and failed rows are filtered out server-side. Only an
   *  active number can be a default. */
  status: string;
  /** `local` / `tollfree`, when known. */
  type: string | null;
  assignments: NumberAssignmentUser[];
};

/** Only an ACTIVE number can present as caller ID (the outbound resolver reads
 *  nothing else), so only an active number can be anyone's default. Paused,
 *  pending and inactive numbers are listed but cannot be chosen. */
export function canBeDefault(row: Pick<NumberAssignmentRow, 'status'>): boolean {
  return row.status === 'active';
}

/** How a number's texting reads on the page: "Calls and texts", "Calls only",
 *  "Paused", or "Unavailable" for anything else that is not active.
 *  'disconnected' (an inactive number: the org disconnected its phone service)
 *  and 'unavailable' (a purchase still being set up) share the "Unavailable"
 *  tag but give different reasons why the number cannot be a default. */
export type TextingState = 'texts' | 'calls-only' | 'paused' | 'disconnected' | 'unavailable';

export function textingState(row: Pick<NumberAssignmentRow, 'status' | 'sms_enabled'>): TextingState {
  if (row.status === 'paused') return 'paused';
  if (row.status === 'inactive') return 'disconnected';
  if (row.status !== 'active') return 'unavailable';
  return row.sms_enabled ? 'texts' : 'calls-only';
}

/** An org user — the pool the assignment checklist draws from. */
export type OrgUserOption = {
  id: string;
  name: string;
};

/** GET /api/communication/number-assignments response shape. */
export type NumberAssignmentsResponse = {
  numbers: NumberAssignmentRow[];
  users: OrgUserOption[];
};

/** PUT numbers/:id/assignments and PUT numbers/:id/org-default both return
 *  this. Assignment is a pure DB write: it records who is responsible for a
 *  number, and deliberately does NOT change where that number rings (routing
 *  lives on the number itself - see `useUpdateNumberForwarding`). */
export type AssignmentMutationResponse = { ok: true };

/** Shared query key — mutations invalidate this exact key. */
export const NUMBER_ASSIGNMENTS_KEY = ['communication', 'number-assignments'] as const;

/** Fallback when a failed save carries no message meant for a person: a
 *  timeout, a dropped connection or a server error, where the write may still
 *  have landed - so it promises nothing either way. Deliberately names nothing
 *  behind the API. */
const SAVE_FAILED_FALLBACK = 'The change may not have saved. Check the list and try again.';

/** A rate-limited save, in the words of the app-wide rate-limit toast. */
const RATE_LIMITED_COPY = "You're doing that too quickly. Please wait a moment and try again.";

/** The number as the admin knows it, read from the list already on screen.
 *  Null when the list is not cached (the toast then says "this number"). */
function cachedNumber(qc: QueryClient, id: string): string | null {
  const row = qc
    .getQueryData<NumberAssignmentsResponse>(NUMBER_ASSIGNMENTS_KEY)
    ?.numbers.find((n) => n.id === id);
  return row ? fmtPhone(row.e164) : null;
}

/** The server's own `{ error }` message, else the neutral fallback. Not the
 *  global `extractApiError`: that falls back to the transport's `err.message`
 *  ("Network Error", "Request failed with status code 502"), which tells an
 *  admin nothing about whether their change saved. A server error (5xx) always
 *  gets the fallback: its body ("Internal server error") is not written for a
 *  person. */
function saveErrorMessage(err: unknown): string {
  const response = (err as { response?: { status?: unknown; data?: { error?: unknown; feature?: unknown } } } | null)
    ?.response;
  // A plan gate and a rate limit answer with a code ("FEATURE_NOT_IN_PLAN"),
  // not a sentence: say it in words, the same way the app-wide toasts do.
  if (response?.status === 402) {
    return featureNotInPlanCopy(typeof response.data?.feature === 'string' ? response.data.feature : undefined);
  }
  if (response?.status === 429) return RATE_LIMITED_COPY;
  if (typeof response?.status === 'number' && response.status >= 500) return SAVE_FAILED_FALLBACK;
  const message = response?.data?.error;
  return typeof message === 'string' && message.trim() ? message : SAVE_FAILED_FALLBACK;
}

/** The save's own error toast, whatever the failure. It is the only one: the
 *  request was sent with `silentErrors`, so the app-wide toasts stay quiet. */
function showSaveFailed(title: string, err: unknown) {
  toast.error(title, { description: saveErrorMessage(err) });
}

/** Request options for every Caller ID save: no app-wide error toasts. */
const SAVE_REQUEST = { silentErrors: true } as const;

const ASSIGNMENTS_FAILED_TITLE = "Couldn't save who can use this number";

/** "Saved. 2 people can use (555) 201-4411" - how many people the save left on
 *  the number. */
function assignmentsSavedMessage(qc: QueryClient, id: string, userIds: string[]): string {
  const count = new Set(userIds).size;
  const number = cachedNumber(qc, id) ?? 'this number';
  return count === 0
    ? `Saved. Nobody is assigned to ${number}`
    : `Saved. ${count} ${count === 1 ? 'person' : 'people'} can use ${number}`;
}

/**
 * `quiet: true` is for a caller that makes several of these calls as ONE save
 * (the Caller ID side panel): the hook then shows no toast and does not refetch
 * on its own, and the caller reports a single outcome and refetches once.
 * Without it, every call toasts its own outcome and refetches when it settles.
 * Either way the request opts out of the app-wide error toasts.
 */
export type CallerIdMutationOptions = { quiet?: boolean };

/** The org's numbers with their user assignments + the org user pool.
 *  `enabled` gates the fetch — a non-admin / non-comm caller never requests the
 *  admin-only data (defence in depth on top of the page's fail-closed render). */
export function useNumberAssignments(enabled = true) {
  return useQuery<NumberAssignmentsResponse>({
    queryKey: NUMBER_ASSIGNMENTS_KEY,
    enabled,
    queryFn: () =>
      api.get('/api/communication/number-assignments').then((r) => r.data as NumberAssignmentsResponse),
  });
}

/** Set the exact set of users assigned to a number (PUT numbers/:id/assignments).
 *  The set is absolute - what is sent is what the number ends up with. */
export function useSetNumberAssignments({ quiet = false }: CallerIdMutationOptions = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) =>
      api
        .put(`/api/communication/numbers/${id}/assignments`, { user_ids: userIds }, SAVE_REQUEST)
        .then((r) => r.data as AssignmentMutationResponse),
    onSuccess: (_data, { id, userIds }) => {
      if (!quiet) toast.success(assignmentsSavedMessage(qc, id, userIds));
    },
    onError: (err) => {
      if (!quiet) showSaveFailed(ASSIGNMENTS_FAILED_TITLE, err);
    },
    onSettled: () => (quiet ? undefined : qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY })),
  });
}

/** Set/clear a user's default number (PUT users/:userId/default-number). The
 *  number must already be assigned to the user; `phoneNumberId: null` clears. */
export function useSetUserDefaultNumber({ quiet = false }: CallerIdMutationOptions = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, phoneNumberId }: { userId: string; phoneNumberId: string | null }) =>
      api
        .put(
          `/api/communication/users/${userId}/default-number`,
          { phone_number_id: phoneNumberId },
          SAVE_REQUEST,
        )
        .then((r) => r.data),
    onSuccess: (_data, { phoneNumberId }) => {
      if (!quiet) toast.success(phoneNumberId ? 'Default number saved' : 'Default number cleared');
    },
    onError: (err) => {
      if (!quiet) showSaveFailed("Couldn't save the default number", err);
    },
    onSettled: () => (quiet ? undefined : qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY })),
  });
}

/** A personal-default call failed AFTER the assignment list saved. Carries the
 *  original error so the toast can still show the server's message. */
class DefaultNumberSaveError extends Error {
  constructor(readonly original: unknown) {
    super('A default number did not save');
    this.name = 'DefaultNumberSaveError';
  }
}

/** One person's default on the number being saved: set (`true`) or cleared. */
export type DefaultChange = { userId: string; isDefault: boolean };

/**
 * Caller ID side panel Save (slice 03). No new write endpoint: it sends the
 * number's full assignment list, then one personal-default call for each
 * default that CHANGED, in order, stopping at the first failure. A default is
 * set only after the assignment it depends on has saved.
 *
 * It reports ONE outcome: a success toast saying how many people can use the
 * number, or one error toast. When the people saved and a default then failed,
 * that toast says so. Either way the list refetches once, so the page shows
 * what the server actually holds.
 */
export function useSaveNumberPeople() {
  const qc = useQueryClient();
  const setAssignments = useSetNumberAssignments({ quiet: true });
  const setUserDefault = useSetUserDefaultNumber({ quiet: true });
  return useMutation({
    mutationFn: async ({
      id,
      userIds,
      defaultChanges,
    }: {
      id: string;
      userIds: string[];
      defaultChanges: DefaultChange[];
    }) => {
      await setAssignments.mutateAsync({ id, userIds });
      for (const change of defaultChanges) {
        try {
          await setUserDefault.mutateAsync({
            userId: change.userId,
            phoneNumberId: change.isDefault ? id : null,
          });
        } catch (err) {
          throw new DefaultNumberSaveError(err);
        }
      }
    },
    onSuccess: (_data, { id, userIds }) => toast.success(assignmentsSavedMessage(qc, id, userIds)),
    // The people saved and a default did not: say exactly that, not that the
    // whole save failed. The calls are sent with `silentErrors` (no app-wide
    // toast), so this is the one toast for every failure, a 500 included.
    onError: (err) =>
      err instanceof DefaultNumberSaveError
        ? showSaveFailed('People saved, but the default number was not', err.original)
        : showSaveFailed(ASSIGNMENTS_FAILED_TITLE, err),
    onSettled: () => qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY }),
  });
}

/** Set/unset the single org-default number (PUT numbers/:id/org-default).
 *  Setting one clears any prior; `isOrgDefault: false` unsets. */
export function useSetOrgDefaultNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isOrgDefault }: { id: string; isOrgDefault: boolean }) =>
      api
        .put(`/api/communication/numbers/${id}/org-default`, { is_org_default: isOrgDefault }, SAVE_REQUEST)
        .then((r) => r.data as AssignmentMutationResponse),
    onSuccess: (_data, { id, isOrgDefault }) => {
      const number = cachedNumber(qc, id);
      toast.success(
        !isOrgDefault
          ? 'Organization default removed'
          : number
            ? `Organization default is now ${number}`
            : 'Organization default updated',
      );
    },
    onError: (err) => showSaveFailed("Couldn't change the organization default", err),
    onSettled: () => qc.invalidateQueries({ queryKey: NUMBER_ASSIGNMENTS_KEY }),
  });
}

/**
 * Task B3 — the `/phone` tab's caller-ID PICKER allow-list. ONLY the current
 * user's own assigned numbers plus the org default (deduped) — never the full
 * org roster (that's `useNumberAssignments` above, ADMIN-gated) and never
 * free text. Backs the from-number dropdown in `PhoneTabPage`.
 */
export type MyNumberOption = {
  phone_number_id: string;
  /** The number's id at the phone service. Read it with `providerNumberIdOf`. */
  provider_number_id?: string;
  /** @deprecated Old name of `provider_number_id`, sent one more release.
   *  TODO(phone-api-neutral-names): drop with the backend alias. */
  ctm_number_id?: string;
  formatted: string | null;
  is_org_default: boolean;
  is_user_default: boolean;
};

/** GET /api/communication/my-numbers response shape. */
export type MyNumbersResponse = { numbers: MyNumberOption[] };

/** Shared query key. */
const MY_NUMBERS_KEY = ['communication', 'my-numbers'] as const;

/** The current user's allow-listed caller-ID options. `enabled` gates the
 *  fetch — only the office-softphone path (the `/phone` tab) needs it. */
export function useMyNumbers(enabled = true) {
  return useQuery<MyNumbersResponse>({
    queryKey: MY_NUMBERS_KEY,
    enabled,
    queryFn: () => api.get('/api/communication/my-numbers').then((r) => r.data as MyNumbersResponse),
  });
}

/** The per-agent CTM softphone access payload (slice 1 endpoint). The embedded
 *  WebRTC device authenticates with this — the agency keys never reach the
 *  browser. The whole object must reach the embed's `accessToken` setter (it
 *  binds the device via account_id / user.account), so extra CTM fields are
 *  preserved via the index signature — never narrowed to `{ token }`. */
export type PhoneAccessToken = { token: string; valid_until?: number; [key: string]: unknown };

/** POST /api/communication/phone-access — the `getToken` the softphone wrapper
 *  calls. Kept as a plain async fn (not a hook) so the imperative embed wrapper
 *  can await it outside React. */
export async function requestPhoneAccessToken(): Promise<PhoneAccessToken> {
  const { data } = await api.post('/api/communication/phone-access');
  return data as PhoneAccessToken;
}
