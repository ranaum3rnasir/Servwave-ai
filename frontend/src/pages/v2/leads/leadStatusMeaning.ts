/**
 * What each lead status means, in plain words: the hover on every item of the lead status menu
 * (walkthrough lead-statuses PRD section 5). The copy is Ran's; do not reword it here.
 *
 * Whether a status can be picked, and why a locked one is locked, is NOT here: the server decides
 * that and returns it as `status_options` on the lead, so this file holds no rule.
 */
export const LEAD_STATUS_MEANING: Record<string, string> = {
  NEW: 'A new lead. No one has reached out yet.',
  CONTACTED: "We've contacted this lead at least once.",
  WALKTHROUGH_SCHEDULED: "A walkthrough is booked and hasn't happened yet.",
  WALKTHROUGH_COMPLETED: 'The walkthrough is done, and nothing else is booked.',
  ESTIMATED: "We've sent this lead an estimate.",
  WON: 'The customer approved doing the job.',
  LOST: "This lead didn't turn into a job.",
  CANCELLED: 'This lead was cancelled.',
};

/** The shape the server returns for each status on `GET /api/leads/:id` (`status_options`). */
export interface LeadStatusOptionFromServer {
  status: string;
  available: boolean;
  reason: string | null;
}
