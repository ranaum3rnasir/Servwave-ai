/**
 * A phone number's id at the phone service (the value the softphone dials
 * from), read off a /communication/my-outbound-number or /my-numbers body.
 *
 * The backend sends it as `provider_number_id`. An old backend sends only the
 * deprecated `ctm_number_id`: the frontend and backend deploy about two
 * minutes apart in no fixed order, so a new bundle can briefly meet an old
 * backend. `??` consults the old key ONLY when the new one is absent; the new
 * backend sends both with the same value. TODO(phone-api-neutral-names): drop
 * the fallback with the backend alias.
 */
export function providerNumberIdOf(
  n: { provider_number_id?: string | null; ctm_number_id?: string | null } | null | undefined,
): string | undefined {
  return n?.provider_number_id ?? n?.ctm_number_id ?? undefined;
}
