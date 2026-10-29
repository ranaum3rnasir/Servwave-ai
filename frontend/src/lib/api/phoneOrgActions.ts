import type { AxiosResponse } from 'axios';
import api from '@/lib/axios';

/**
 * The phone service's org actions (admin-only), on paths that carry ServWave's
 * own name. Each maps to the deprecated path the backend still serves as an
 * alias for one release.
 */
const PHONE_ORG_ACTIONS = {
  checkTextingApproval: {
    path: '/api/organization/phone/check-texting-approval',
    legacyPath: '/api/organization/connect-ctm/check-a2p',
  },
  disconnect: {
    path: '/api/organization/phone/disconnect',
    legacyPath: '/api/organization/disconnect-ctm',
  },
} as const;

export type PhoneOrgAction = keyof typeof PHONE_ORG_ACTIONS;

function isNotFound(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 404;
}

/**
 * POST one phone org action and return the response body.
 *
 * The frontend and backend deploy about two minutes apart in no fixed order, so
 * this bundle can briefly meet an old backend that has only the old path. A 404
 * from the new path (Express's answer for a route it does not have; these
 * handlers never 404 themselves) retries once on the old path. Any other
 * failure is the real answer and is thrown as is.
 * TODO(phone-api-neutral-names): drop the fallback with the backend aliases.
 */
export async function postPhoneOrgAction<T>(action: PhoneOrgAction): Promise<T> {
  const { path, legacyPath } = PHONE_ORG_ACTIONS[action];
  let res: AxiosResponse<T>;
  try {
    res = await api.post<T>(path);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    res = await api.post<T>(legacyPath);
  }
  return res.data;
}
