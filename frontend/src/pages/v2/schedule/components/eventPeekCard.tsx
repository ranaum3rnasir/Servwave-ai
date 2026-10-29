import { Clock, MapPin, Users, X } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { customerDisplayName } from '@/lib/customer-name';
import { eventCrewPeople, fullName } from '@/components/schedule/eventPeople';
import { EVENT_TYPE_META, isAllDayEvent, type BoardEvent } from '@/components/schedule/scheduleModel';

import { MenuSurface } from './menuSurface';

const EN = '–';

/**
 * The card behind a card.
 *
 * The board's fanned overlap deliberately buys the LOOK and not the reading:
 * a covered card shows only its leftmost slot, exactly as Google Calendar's
 * does. This is where the reading happens, on the same division of labour -
 * hover for a look, click to keep it.
 *
 * One component, ONE card. Hover and click show exactly the same thing, actions included -
 * a preview that dropped the Open button was a second, quieter version of the same window,
 * and which one you got depended on whether you had clicked yet.
 *
 * `pinned` now changes only how long it stays: an unpinned card follows the pointer and
 * closes when the pointer leaves both it and the event, while a pinned one survives hovering
 * elsewhere and stays until something dismisses it.
 */
export interface EventPeekCardProps {
  event: BoardEvent;
  x: number;
  y: number;
  pinned: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Hovering the card itself must keep it up - see the note on the surface below. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function EventPeekCard({
  event, x, y, pinned, onOpen, onClose, onMouseEnter, onMouseLeave,
}: EventPeekCardProps) {
  const raw = event.raw ?? {};
  const customer = raw.customer as { first_name: string; last_name: string } | null | undefined;
  const customerName = customer ? customerDisplayName(customer, '') : event.customer;
  // THIS card's crew (slice 02): for a job's trip, that trip's own people - never the job-level
  // union, which named everyone booked on any of the job's visits.
  const crew = eventCrewPeople({ ...event, raw }).map(fullName).filter(Boolean).join(', ');

  /**
   * A calendar entry has no crew BY DESIGN (ADR 0002) - its people are participants, a
   * separate field, and its `crew` is [] on purpose. Reading that
   * empty array as "unstaffed" made every Event on the board flag itself red for a crew
   * it is never going to have, which is also why `eventDangerState` refuses to paint one.
   * So the row shows participants for an entry, and the red flag is for work only.
   */
  const isEntry = event.type === 'calendar-entry';
  const participants = isEntry
    ? ((raw.participants as { user?: Parameters<typeof fullName>[0] }[] | undefined) ?? [])
      .map((p) => fullName(p.user)).filter(Boolean).join(', ')
    : '';
  const people = isEntry ? participants : crew;

  const location = raw.service_location as
    | { address_line1?: string; city?: string; state?: string }
    | null
    | undefined;
  const address = location
    ? [location.address_line1, location.city, location.state].filter(Boolean).join(', ')
    : [raw.service_address_line1, raw.service_city, raw.service_state].filter(Boolean).join(', ');

  // An all-day event is stored 00:00 to an EXCLUSIVE 00:00, so formatting its two ends
  // printed "12:00 AM - 12:00 AM" - a true reading of the range and a useless one.
  const time = isAllDayEvent(event)
    ? 'All day'
    : event.start && event.end
      ? `${event.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ${EN} ${event.end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      : '';

  const meta = EVENT_TYPE_META[event.type];

  return (
    <MenuSurface
      className="w-[290px] px-0 py-0"
      style={{ left: x, top: y }}
      /**
       * Interactive whether pinned or not, because both states now render the SAME card,
       * actions included - a hover preview that showed an Open button it could not accept a
       * click on would be worse than not showing one.
       *
       * The old reason for `pointer-events: none` was that a preview must not block a click
       * meant for the event underneath. That is handled by position and hover intent instead:
       * the card opens offset from the pointer, and the page cancels its hide timer while the
       * pointer is over the card, so it is only under the cursor once you have deliberately
       * moved onto it.
       */
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role={pinned ? 'dialog' : 'tooltip'}
      aria-label={`${event.number} ${customerName}`}
    >
      <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
        {/* `bg-current` rather than an inline backgroundColor: the dot takes its fill from
            the type colour `meta.text` already sets, and the token ratchet counts a literal
            appearance value in a style object even when it is a CSS keyword. No `meta.soft`
            beside it: that is now an OPAQUE pale surface, and two bg utilities on one element
            are decided by stylesheet order, which could paint the dot near-white. */}
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-current ${meta.text}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold leading-tight">{customerName || event.title}</div>
          <div className="text-muted-foreground text-[11px] font-medium">
            {[event.number, meta.label].filter(Boolean).join(` ${EN} `)}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          className="-mr-1 -mt-1 size-6 shrink-0"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 px-3.5 pb-3 text-[12px]">
        {time && (
          <div className="text-muted-foreground flex items-center gap-2">
            <Clock className="size-3.5 shrink-0" />
            <span className="truncate">{time}</span>
          </div>
        )}
        <div className="text-muted-foreground flex items-center gap-2">
          <Users className="size-3.5 shrink-0" />
          {people ? (
            <span className="truncate">{people}</span>
          ) : isEntry ? (
            <span className="truncate">No participants</span>
          ) : (
            <span className="text-status-red-emphasis font-semibold">Needs crew</span>
          )}
        </div>
        {address && (
          <div className="text-muted-foreground flex items-start gap-2">
            <MapPin className="mt-0.5 size-3.5 shrink-0" />
            <span className="line-clamp-2">{address}</span>
          </div>
        )}
      </div>

      <div className="flex justify-end border-t px-2.5 py-2">
        <Button type="button" size="sm" className="h-7 text-[12px]" onClick={onOpen}>
          Open
        </Button>
      </div>
    </MenuSurface>
  );
}
