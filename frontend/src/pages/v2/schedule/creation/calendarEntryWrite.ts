import type { useQueryClient } from '@tanstack/react-query';

import type { ParticipantDraft } from '../components/participantsField';

/**
 * Calendar-entry write plumbing, shared by the OLD `eventEntryDialog` and the NEW unified
 * creation popover. Extracted rather than copied: two independent opinions about which caches
 * a calendar-entry write must invalidate is exactly the bug class the note below is about.
 */

/**
 * Every cache a calendar-entry write must invalidate - the #1718/#1725 class this feature
 * must not repeat. Two readers exist today:
 *
 *  - the board's own `useScheduleData` (`['schedule-calendar-entries', dateRange]`);
 *  - the customer page's Schedule tab, slice 10 (`['customer-calendar-entries', id]`).
 *
 * Both keys below are PREFIXES (no `dateRange`/`id`), so `invalidateQueries` matches every
 * variant currently cached - every window the board has ever fetched, and every customer's
 * Schedule tab, not just the one(s) this save happens to know about. That "know about" case
 * matters more than it looks: a save that REMOVES a customer participant has to refresh THAT
 * customer's tab too, so the entry disappears from it - and by the time save runs, the removed
 * id is no longer in the draft, so the caller cannot reliably enumerate "which customer ids
 * were touched" at all. Invalidating every `customer-calendar-entries` query rather than
 * targeting only the id(s) still present is the same trade the board's own prefix match
 * already makes across `dateRange`, and it is cheap: that tab's query only exists in the cache
 * while a customer's Schedule tab is actually mounted, so a broad invalidation costs nothing
 * extra in practice.
 *
 * One function, not this pair duplicated across create/update/delete - and now not duplicated
 * across the two creation surfaces either.
 */
const CALENDAR_ENTRIES_KEY = ['schedule-calendar-entries'];
const CUSTOMER_CALENDAR_ENTRIES_KEY = ['customer-calendar-entries'];

export function invalidateCalendarEntryQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: CALENDAR_ENTRIES_KEY });
  queryClient.invalidateQueries({ queryKey: CUSTOMER_CALENDAR_ENTRIES_KEY });
}

/** The wire shape for an entry's participant set. */
export function participantsPayload(participants: ParticipantDraft[]) {
  return participants.map((p) => (
    p.kind === 'USER'
      ? { kind: 'USER' as const, user_id: p.id }
      : { kind: 'CUSTOMER' as const, customer_id: p.id }
  ));
}
