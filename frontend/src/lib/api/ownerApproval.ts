import api from '@/lib/axios';

/**
 * The Make Owner approval link (ticket 27, D1), opened from the email the company's Owner received. The token travels in the
 * POST body only, never an address, so it stays out of request logs.
 */
export interface OwnerApproval {
  company_name: string;
  new_owner_name: string;
}

/** The answer for every dead link: expired, used, replaced or unknown. */
export const OWNER_LINK_EXPIRED_CODE = 'owner_link_expired';

/** Who becomes the Owner of which company. Changes nothing. */
export async function previewOwnerApproval(token: string): Promise<OwnerApproval> {
  const { data } = await api.post('/api/auth/owner-approval', { token }, { silentErrors: true });
  return data as OwnerApproval;
}

/** Approve: ownership moves, once. */
export async function approveOwner(token: string): Promise<OwnerApproval> {
  const { data } = await api.post('/api/auth/owner-approval/approve', { token }, { silentErrors: true });
  return data as OwnerApproval;
}
