/**
 * Spider's suggested follow-up text (#2619, Spider 8/8). Offered in a lead's text box only when
 * the lead was opened from a Spider alert at a company that passes the Spider gate. It is never
 * sent on its own: the person edits it, or clears it, and presses Send.
 */

/** The longest suggestion the text box will take. */
export const SPIDER_FOLLOW_UP_MAX_CHARS = 500;

const STAGE_LABEL: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  WALKTHROUGH_SCHEDULED: 'Walkthrough Scheduled',
  WALKTHROUGH_COMPLETED: 'Walkthrough Completed',
  ESTIMATED: 'Estimate Sent',
};

const NEXT_STEP: Record<string, string> = {
  NEW: 'When is a good time for a quick call about what you need?',
  CONTACTED: 'Would you like to set up a time for us to come out and take a look?',
  WALKTHROUGH_SCHEDULED: 'Just checking that the time we booked to come out still works for you.',
  WALKTHROUGH_COMPLETED: 'Thanks for having us out. Is there anything else we should know before we send your estimate?',
  ESTIMATED: 'Do you have any questions about the estimate we sent?',
};

export function capFollowUp(text: string): string {
  return text.slice(0, SPIDER_FOLLOW_UP_MAX_CHARS);
}

export function buildSpiderFollowUp(lead: {
  status: string;
  customerFirstName?: string | null;
  serviceRequest?: string | null;
}): string {
  const name = lead.customerFirstName?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const service = lead.serviceRequest?.trim();
  const about = service ? ` about ${service}` : '';
  const stage = STAGE_LABEL[lead.status];
  const stageNote = stage ? ` (stage: ${stage})` : '';
  const next = NEXT_STEP[lead.status] ?? 'How can we help with next steps?';
  return capFollowUp(`${greeting} I am following up on your request${about}${stageNote}. ${next}`);
}

/** Router state a Spider alert card navigates to a lead with. */
export function cameFromSpiderAlert(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as { spiderFollowUp?: unknown }).spiderFollowUp === true;
}
