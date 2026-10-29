import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';

/**
 * The org's sending address, in-house model: the DOMAIN is always the shared
 * platform one and is not an org choice, so the only thing writable here is the
 * local part - the string before the `@`.
 *
 * Reading it is not this module's job. The current value already rides on
 * `useSendingIdentity()` (`localPart` / `localPartIsCustom` / `senderDomain`),
 * which is the same call the compose surfaces use, so the settings page and the
 * compose window can never disagree about what the org sends as.
 */

export interface EmailSenderUpdate {
  local_part: string;
  local_part_is_custom: boolean;
  sender_domain: string;
}

/** Distinguishes "another org already has that address" from any other failure,
 *  so the field can render it inline rather than as a generic toast. */
export const LOCAL_PART_TAKEN = 'LOCAL_PART_TAKEN';

export function isLocalPartTaken(err: unknown): boolean {
  return (
    (err as { response?: { data?: { code?: string } } })?.response?.data?.code === LOCAL_PART_TAKEN
  );
}

export function emailSenderErrorMessage(err: unknown): string {
  if (isLocalPartTaken(err)) return 'Another organization already uses that address';
  return extractApiError(err, 'Could not save the sending address');
}

/** PATCH the local part. An empty string clears it, returning the org to the
 *  address derived from its company name. */
export function useUpdateEmailSender() {
  const qc = useQueryClient();
  return useMutation<EmailSenderUpdate, unknown, string>({
    mutationFn: (localPart: string) =>
      api
        .patch('/api/organization/email-sender', { local_part: localPart })
        .then((r) => r.data),
    onSuccess: () => {
      // The identity query is what every compose surface reads its From from,
      // so it has to refetch or the Inbox keeps showing the old address until
      // it goes stale.
      qc.invalidateQueries({ queryKey: ['communication', 'sending-identity'] });
    },
  });
}
