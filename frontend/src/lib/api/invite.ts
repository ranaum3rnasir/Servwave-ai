import api from '@/lib/axios';

export interface InviteInfo {
  email: string;
  first_name: string;
  /** What the admin typed on the invite card, E.164, so the page can PREFILL it.
   *  Without the prefill a hire who never touches the box would be submitting a
   *  blank over a number that already exists. */
  phone: string | null;
  phone_ext: string | null;
}

/**
 * Validate the invite token and fetch who it's for (to greet the page).
 * POST (not GET) so the single-use token stays in the request body, never the
 * URL — keeps it out of backend request logs and proxy access logs.
 */
export async function getInviteInfo(token: string): Promise<InviteInfo> {
  const { data } = await api.post('/api/auth/invite', { token });
  return data as InviteInfo;
}

/**
 * Set the password for an invited user + record ToS/Privacy acceptance, and
 * carry the phone number they supplied. Resolves on success; throws on failure.
 *
 * `phone` is already E.164 or null - null being "the box was blank", which the
 * API reads as leave the stored number alone, never as erase it.
 */
export async function acceptInvite(
  token: string,
  password: string,
  acceptedTerms: boolean,
  phone: string | null,
): Promise<void> {
  await api.post('/api/auth/accept-invite', { token, password, accepted_terms: acceptedTerms, phone });
}

/** Record ToS/Privacy acceptance for an invited user WITHOUT setting a password
 *  (Google path), carrying the same phone. This is the path a phone capture is
 *  most easily forgotten on, and forgetting it skips every Google invitee. */
export async function recordInviteConsent(token: string, phone: string | null): Promise<void> {
  await api.post('/api/auth/accept-invite/terms', { token, accepted_terms: true, phone });
}
