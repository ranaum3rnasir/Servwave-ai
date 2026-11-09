import { fmtPhone } from '@/lib/api/communication-shared';
import type { OwnedNumber, NumberStatus } from '@/lib/api/communication-shared';

/** Wire row from GET /api/communication/numbers (snake_case DB shape). */
export type PhoneNumberRow = {
  id: string;
  e164: string;
  formatted?: string | null;
  label?: string | null;
  source?: string;
  type?: string | null;
  sms_enabled?: boolean;
  /** The number's id at the phone service (not read by the UI). */
  provider_number_id?: string | null;
  /** @deprecated Old name of `provider_number_id`, sent one more release.
   *  TODO(phone-api-neutral-names): drop with the backend alias. */
  ctm_number_id?: string | null;
  call_flow_id?: string | null;
  /** Where this number's calls ring (E.164), or null when it has no simple
   *  forward set. This IS the routing - see `useUpdateNumberForwarding`. */
  forward_to?: string | null;
  status?: string;
  created_at: string;
};

/** Statuses the UI knows how to render; anything else falls back to active so
 *  a new server-side state can never blank a row out. */
const NUMBER_STATUSES = new Set<NumberStatus>([
  'active',
  'paused',
  'released',
  'pending',
  'failed',
]);

/** Map a wire row onto the UI's OwnedNumber shape (NumbersView contract). */
export function mapOwnedNumber(row: PhoneNumberRow): OwnedNumber {
  return {
    id: row.id,
    number: row.formatted || fmtPhone(row.e164),
    ...(row.label ? { tag: row.label } : {}),
    type: row.type === 'tollfree' ? 'Toll-free' : 'Local',
    flowId: row.call_flow_id ?? '',
    forwardTo: row.forward_to ?? null,
    status: NUMBER_STATUSES.has(row.status as NumberStatus)
      ? (row.status as NumberStatus)
      : 'active',
    createdAt: row.created_at,
    smsEnabled: row.sms_enabled ?? false,
  };
}
