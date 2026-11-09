import { useOrganization } from '@/lib/api/shared/organization';
import { isPhoneConnected, isSmsReady } from '@/lib/api/shared/phoneConnected';

/** Phone-service status, from the org record (§5.4): `connected` = the
 *  server's `phone_connected` (see `isPhoneConnected` for the deploy-window
 *  fallback); `smsReady` additionally requires the texting approval flag
 *  (`sms_ready`, read through `isSmsReady`).
 *  Gates the SMS composer and the liveness polling. */
export function useCtmStatus() {
  const { data: org } = useOrganization();
  const connected = isPhoneConnected(org);
  return { connected, smsReady: connected && isSmsReady(org) };
}
