/**
 * Opening a lead from a Spider alert card (Ran, 15 Oct, D4: the contractor's click). The card
 * opens the tab for the lead's stage; at New it opens Communication with his pre-filled draft,
 * "Hello {name}, following up regarding your {service} (Stage: New)." The draft is never sent on
 * its own: the person edits it, or clears it, and presses Send. Nothing on the lead page marks the
 * alert read; the server ends it once a real contact moves the lead on (D1, SPEC-6).
 *
 * His click put the draft (with the customer's name) and the alert id in the address bar; here
 * they travel in the router state, and only the tab is in the address.
 */

/** The longest draft the text box will take (his cap). */
export const SPIDER_FOLLOW_UP_MAX_CHARS = 500;

/** Router state a Spider alert card navigates to a lead with. */
export interface SpiderLeadLinkState {
  /** The notification-recipient id of the alert that was clicked. Nothing on the lead page reads it. */
  spiderAlertId?: string;
  /** His pre-filled draft for the Communication tab. */
  spiderDraft?: string;
}

/** The lead page with the tab the contractor's click opens. */
export function spiderLeadLink(leadId: string, tab: string): string {
  return `/leads/${leadId}?tab=${encodeURIComponent(tab)}`;
}

function field(state: unknown, key: keyof SpiderLeadLinkState): string | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const v = (state as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The pre-filled draft a Spider alert card opened this lead with, capped at 500 characters. */
export function spiderDraftFrom(state: unknown): string | undefined {
  return field(state, 'spiderDraft')?.slice(0, SPIDER_FOLLOW_UP_MAX_CHARS);
}
