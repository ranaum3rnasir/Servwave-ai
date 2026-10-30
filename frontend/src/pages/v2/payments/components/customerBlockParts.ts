import type { DialerEntityContext } from '@/stores/dialer.store';
import type { PaymentCustomerBlock } from '@/lib/api/paymentsPage';

export const RESTRICTED_CUSTOMER_TEXT = 'Customer details are restricted for your role.';

export type OpenBlock = Extract<PaymentCustomerBlock, { restricted: false }>;

/** The email an Email button opens the compose window with. A drawer that has none leaves the subject empty. */
export interface BlockEmail {
  subject?: string;
  body?: string;
}

/** What a call, text or conversation opened from this customer is filed on. */
export function dialerContextOf(block: OpenBlock): DialerEntityContext {
  return {
    customerId: block.id,
    customerName: block.name,
    ...(block.job ? { jobId: block.job.id, jobLabel: block.job.number } : {}),
    ...(block.lead ? { leadId: block.lead.id } : {}),
  };
}
