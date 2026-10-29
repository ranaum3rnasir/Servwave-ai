/**
 * Whether the org's phone service is set up, from the GET /api/organization
 * body. The server computes `phone_connected`; this response never carries
 * the phone account id. (The one place it can still reach the browser is the
 * softphone token payload from POST /communication/phone-access, passed
 * through whole to the phone component.)
 *
 * The fallback to `ctm_account_id` exists only for a deploy window: the
 * frontend and backend deploy about two minutes apart in no fixed order, so a
 * new bundle can briefly meet an old backend that sends no `phone_connected`
 * (and the real id in `ctm_account_id`). `??` consults the old key ONLY when
 * `phone_connected` is absent; the new backend always sends it, so the two are
 * never weighed against each other. TODO(phone-account-id cleanup): drop the
 * fallback with the key.
 */
export function isPhoneConnected(
  org: { phone_connected?: boolean; ctm_account_id?: string | true | null } | null | undefined,
): boolean {
  if (!org) return false;
  return org.phone_connected ?? Boolean(org.ctm_account_id);
}

/**
 * Whether texting is approved for the org, from the GET /api/organization
 * body. The server sends it as `sms_ready`; an old backend sends only the
 * deprecated `ctm_sms_ready` (same deploy window as above). `??` consults the
 * old key ONLY when `sms_ready` is absent. TODO(phone-api-neutral-names): drop
 * the fallback with the backend alias.
 */
export function isSmsReady(
  org: { sms_ready?: boolean; ctm_sms_ready?: boolean } | null | undefined,
): boolean {
  if (!org) return false;
  return org.sms_ready ?? Boolean(org.ctm_sms_ready);
}
