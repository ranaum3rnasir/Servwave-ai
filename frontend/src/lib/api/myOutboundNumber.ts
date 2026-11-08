import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';

/**
 * Master plan Task B2 — the `/phone` tab's caller-ID source.
 *
 * Thin TanStack Query wrapper over Task B1's
 * `GET /api/communication/my-outbound-number`: the CURRENT user's resolved
 * outbound number (their own default, else the org default, else none). Feeds
 * `dialFrom`/`fromTpnId` on the office softphone (`useCtmSoftphone.call`) so
 * an outbound call presents the right caller ID.
 */
export type MyOutboundNumber =
  | {
      /** The number's id at the phone service. Read it with `providerNumberIdOf`. */
      provider_number_id?: string;
      /** @deprecated Old name of `provider_number_id`, sent one more release.
       *  TODO(phone-api-neutral-names): drop with the backend alias. */
      ctm_number_id?: string;
      phone_number_id: string;
      formatted: string | null;
    }
  | { none: true };

/** Shared query key. */
const MY_OUTBOUND_NUMBER_KEY = ['communication', 'my-outbound-number'] as const;

/** The current user's resolved caller-ID number. `enabled` gates the fetch —
 *  only the office-softphone path (the `/phone` tab) needs it; every other
 *  host of `<Softphone/>` stays on the bridge/tel path, which resolves its
 *  from-number server-side and never fetches this. */
export function useMyOutboundNumber(enabled = true) {
  return useQuery<MyOutboundNumber>({
    queryKey: MY_OUTBOUND_NUMBER_KEY,
    enabled,
    queryFn: () =>
      api.get('/api/communication/my-outbound-number').then((r) => r.data as MyOutboundNumber),
  });
}
