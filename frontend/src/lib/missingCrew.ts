/**
 * Can this card miss its crew at all? (Roles & Permissions, PRD 3 and PRD 9, S09.13.)
 *
 * The server's Missing crew test (backend `lib/missingCrew.ts`) counts a visit only while it is booked (live, timed) on a
 * job that is neither Cancelled nor Completed or later, or on an open lead. The dashboard tile, the Needs Attention item
 * and the Schedule's "No crew" filter all read it, and the card's "Needs crew" mark asks the same status question here,
 * so a finished visit on a Done job with nobody on it carries no mark while the filter leaves it out. This is the status
 * half of that test; whether anybody is on the visit and whether it has a time are the card's own facts, so they stay
 * with the caller. A test fails when the lists below drift from the server's.
 */
import { isLiveVisit } from '@/lib/visits';
import { isCompletedOrLaterJobStatus } from '@/lib/jobs/closeOut';

/** The lead statuses that close a lead (backend `OPEN_LEAD_STATUSES` is everything before Won in the lead status order). */
export const CLOSED_LEAD_STATUSES: readonly string[] = ['WON', 'LOST', 'CANCELLED'];

interface MissingCrewCard {
  type: string;
  /** This card's own visit status, when the card is a visit. */
  visitStatus?: string | null;
  /** The parent row: the job (or the lead, for a walkthrough). */
  raw?: Record<string, unknown> | null;
}

export function cardCanMissCrew(card: MissingCrewCard): boolean {
  // A visit that is finished or called off is not booked, whatever the job around it is doing.
  if (card.visitStatus && !isLiveVisit({ status: card.visitStatus })) return false;
  const status = card.raw?.status;
  if (typeof status !== 'string') return true;
  if (card.type === 'walkthrough') return !CLOSED_LEAD_STATUSES.includes(status);
  return status !== 'CANCELLED' && !isCompletedOrLaterJobStatus(status);
}
