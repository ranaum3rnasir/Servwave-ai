import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useEntitlementsReady, useFeature } from '@/lib/entitlements';
import { extractApiError } from '@/lib/utils';

/**
 * The company's addresses, in-house model: the DOMAIN is always the shared platform one and is not a company choice, so
 * the only thing writable here is the company part - the string before the `@` in the main address, and after the
 * person's name in everyone's own address.
 *
 * What the Sender Address page shows comes from `GET /api/organization/email-sender`, which a holder of Company settings
 * can read even when they cannot open the Email page (the compose box's sending-identity read is part of that section).
 */

export interface EmailSender {
  /** The main address in full, the one automated mail goes out from. */
  address: string;
  /** The company part: the string before the @ in the main address. */
  local_part: string;
  /** False while the part simply follows the company name. */
  local_part_is_custom: boolean;
  /** The domain after the @, shared by every company. */
  sender_domain: string;
}

export interface EmailSenderUpdate {
  local_part: string;
  local_part_is_custom: boolean;
  sender_domain: string;
}

const EMAIL_SENDER_KEY = ['organization', 'email-sender'] as const;

/** The main address and company part. Only asked while the company has the Email plan feature (the route answers 402 without it). */
export function useEmailSender(enabled = true) {
  const entitlementsReady = useEntitlementsReady();
  const hasEmail = useFeature('email');
  return useQuery<EmailSender>({
    queryKey: EMAIL_SENDER_KEY,
    queryFn: () => api.get('/api/organization/email-sender').then((r) => r.data),
    enabled: enabled && entitlementsReady && hasEmail,
  });
}

/** What to show under the field when a save is refused: the server's own words, without a field name in front. */
export function emailSenderErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { error?: string; details?: Array<{ message?: string }> } } })?.response?.data;
  const detail = data?.details?.find((d) => d.message)?.message;
  if (detail) return detail;
  return extractApiError(err, 'Could not save the address. Try again.');
}

/**
 * Ask the server whether it would accept a company part, changing nothing: the same call as the change with `dry_run`, so
 * the reserved list, the taken list and the length of everyone's address are judged by the one rule the change uses. A
 * refusal is the same refusal, shown under the field before the warning that everyone's address will change.
 */
export function useCheckEmailSender() {
  return useMutation<EmailSenderUpdate, unknown, string>({
    mutationFn: (localPart: string) =>
      api
        .patch('/api/organization/email-sender', { local_part: localPart, dry_run: true })
        .then((r) => r.data),
  });
}

/** PATCH the company part. An empty string returns the company to the part its name gives. */
export function useUpdateEmailSender() {
  const qc = useQueryClient();
  return useMutation<EmailSenderUpdate, unknown, string>({
    mutationFn: (localPart: string) =>
      api
        .patch('/api/organization/email-sender', { local_part: localPart })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: EMAIL_SENDER_KEY });
      // The Email page's compose box reads its From from the sending identity, and the Users page shows each person's
      // address, so both refetch or keep showing the old ones until they go stale.
      qc.invalidateQueries({ queryKey: ['communication', 'sending-identity'] });
      qc.invalidateQueries({ queryKey: ['communication', 'my-mailbox'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

// ─── The people who read the main mailbox (PRD 10, S10.8) ────────────────────────────────────────────────────────────
//
// A holder of Company settings links active people to the company's main mailbox on the Sender Address page. A company can
// have hundreds of people, so neither list is ever loaded whole: the linked people and the picker's candidates are each a
// page the server cuts, and the picker's search is the server's too.

export interface ReaderPerson {
  id: string;
  name: string;
}

export interface ReaderPage {
  items: ReaderPerson[];
  total: number;
  offset: number;
  limit: number;
}

const READERS_KEY = [...EMAIL_SENDER_KEY, 'readers'] as const;
const READERS_URL = '/api/organization/email-sender/readers';

/** One page of the active people linked to the main mailbox. */
export function useMainMailboxReaders(offset: number, enabled = true) {
  const entitlementsReady = useEntitlementsReady();
  const hasEmail = useFeature('email');
  return useQuery<ReaderPage>({
    queryKey: [...READERS_KEY, 'linked', offset],
    queryFn: () => api.get(READERS_URL, { params: { offset } }).then((r) => r.data),
    enabled: enabled && entitlementsReady && hasEmail,
  });
}

/** One page of the active people not linked yet, matching `search` by name. Asked only while the picker is open. */
export function useReaderCandidates(search: string, offset: number, enabled = true) {
  return useQuery<ReaderPage>({
    queryKey: [...READERS_KEY, 'candidates', search, offset],
    queryFn: () => api.get(`${READERS_URL}/candidates`, { params: { search: search || undefined, offset } }).then((r) => r.data),
    enabled,
  });
}

/** Link one person, or unlink one: both lists are stale afterwards, and nothing else on the page. */
export function useLinkReader() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string>({
    mutationFn: (userId: string) => api.put(`${READERS_URL}/${userId}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: READERS_KEY }),
  });
}

export function useUnlinkReader() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string>({
    mutationFn: (userId: string) => api.delete(`${READERS_URL}/${userId}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: READERS_KEY }),
  });
}
