import { useMutation } from '@tanstack/react-query';

import api from '@/lib/axios';

/**
 * The address the "Reach sales" composer shows as its recipient.
 *
 * Display only. The server owns the real destination
 * (backend/src/lib/email.ts SALES_CONTACT_EMAIL) and never reads a recipient off
 * the request body, so this constant cannot redirect a message - it can only
 * disagree with where one actually went. Keep the two in step.
 */
export const SALES_CONTACT_EMAIL = 'info@servwave.com';

export interface SalesRequest {
  subject: string;
  message: string;
  /**
   * Which of the composer's preset questions this is, or null when the owner
   * wrote their own. The server turns it into a written line in the email so
   * the inbox can see what is being asked before reading the prose.
   */
  topic: string | null;
}

/**
 * Human copy for a failed sales send - mirrors emailSendErrorMessage: surfaces
 * the SERVER's own error text, falling back to a generic retry line only when
 * there is none (a network drop, say).
 *
 * The distinction matters here. The API separates a permanent block (409, the
 * message will never get through, do something else) from a transient one
 * (502, retrying is the right move). Overwriting that with a fixed "try again
 * shortly" is how the org kill-switch outage came to tell owners to retry a
 * send that failed identically every time.
 */
export function salesRequestErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } } };
  return e.response?.data?.error ?? "We couldn't send your message. Please try again shortly.";
}

/** POST /api/support/sales-request - delivers the composed message to the
 *  ServWave inbox. Rejects when the send did not happen, so the dialog can tell
 *  the owner the truth instead of toasting a success that never left. */
export function useSendSalesRequest() {
  return useMutation<{ status: string; to: string }, unknown, SalesRequest>({
    mutationFn: (body) => api.post('/api/support/sales-request', body).then((r) => r.data),
  });
}
