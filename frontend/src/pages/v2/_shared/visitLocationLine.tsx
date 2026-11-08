import { MapPin } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * "This trip is not at the customer's address, it is HERE" - the one line every surface that reads
 * a visit gains.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md
 * Slice: md_files/issues/scheduling/06-show-the-location-where-the-visit-is-read.md
 *
 * ── SHOW THE DIFFERENCE, NOT THE ADDRESS ──────────────────────────────────────────────────────
 *
 * `label` is null for the great majority of visits - the ones at the parent's service address -
 * and this renders NOTHING for them. Not an empty line, not a label with nothing after it: a visit
 * at the service address has to read exactly as it did before this slice existed, because printing
 * the customer's own address on every card would be noise on the common case to serve the rare one.
 *
 * ── IT PRINTS WHAT THE SERVER RESOLVED, AND DOES NOT RESOLVE ANYTHING ─────────────────────────
 *
 * The string arrives already rendered, from `formatVisitOwnLocation` - the same function
 * `formatVisitLocation` (the merge field in the customer's email) is defined in terms of. That is
 * the whole reason this component takes a string rather than the six columns and a locations list:
 * a client that composed the line itself would be a SECOND RESOLUTION of "name, then address, in
 * this order, unless it is blank", and a second resolution is a second chance for the card and the
 * email to disagree about where a customer is meant to be. Nothing here reformats, re-cases,
 * re-orders or shortens it.
 *
 * ── WHY IT IS MARKED, AND WHY IT IS NOT A MAP ────────────────────────────────────────────────
 *
 * A dispatcher scanning a day has to NOTICE this without reading it, so it carries a pin no
 * sibling line on these cards carries, and the text is not muted the way its siblings are. The pin
 * is decorative, so the line also carries a real "Location:" label - an icon is nothing to a
 * screen reader, and a bare address read aloud among dates and names says nothing about what it is.
 *
 * No `ServiceLocationMap` here, and that is D4 applied rather than ignored: D4 says a one-off
 * address must behave like every other address, and NONE of the three surfaces this line appears on
 * renders a service address as a map - the lead's walkthrough tab and the job's Visits card render
 * no address at all today, and the schedule renders one as plain text beside a pin. Adding a map
 * here would make the visit's location the only address on these surfaces that gets one. The map
 * D4 actually requires is on the BOOKING control, where the sibling address forms show theirs, and
 * slice 1 put it there.
 */
export function VisitLocationLine({
  label,
  className,
}: {
  /** The resolved line, or null/undefined when this trip is at the parent's service address. */
  label?: string | null;
  className?: string;
}) {
  if (!label) return null;
  return (
    <p className={cn('mt-0.5 flex min-w-0 items-center gap-1 text-xs font-medium', className)}>
      <MapPin className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">Location: </span>
      <span data-testid="visit-location" className="truncate">{label}</span>
    </p>
  );
}
