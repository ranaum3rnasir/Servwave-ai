/**
 * THE BOARD CARD SAYS WHERE THE TRIP IS - slice 6, the schedule's own half.
 *
 * Spec:  md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D4, story 15)
 * Slice: md_files/issues/scheduling/06-show-the-location-where-the-visit-is-read.md
 *
 * ── WHY THIS IS HERE AND NOT ONLY IN THE DETAIL DIALOG ────────────────────────────────────────
 *
 * The schedule is the ONE read surface in this slice that already renders an address: every board
 * card paints the parent's service address under the time. Since slice 1 a visit can be somewhere
 * else, and the card went on painting the customer's street on a trip booked at the yard - not a
 * missing fact but a WRONG one, which is strictly worse, and is verbatim the "routed someone to the
 * wrong side of town" the spec's user story 15 is about.
 *
 * It is also what D4 asks for on this surface. "A one-off address maps through ServiceLocationMap
 * wherever a service address would" is a consistency rule: wherever a service address renders, the
 * visit's own location has to render the same way. On the three boards a service address is plain
 * text beside a pin, so that is what the visit's location is - the same element, in the same slot,
 * under the same height gate.
 *
 * Both card renderers are covered, because there are two and they were written separately: the
 * standard calendar's `ScheduleEvent`, and `cardAddressText`, which the technician grid and the
 * member-week board share.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { asWallClock } from '@/lib/schedule-tz';
import { cardAddressText } from '@/components/schedule/ScheduleCardBody';
import type { BoardEvent, SchedulableEvent } from '@/components/schedule/scheduleModel';

import { ScheduleEvent } from '../SchedulePage';

vi.mock('react-router-dom', async (orig) => ({
  ...((await orig()) as object),
  useNavigate: () => vi.fn(),
}));

const AT_YARD = 'North Yard, 9 Depot Rd, Raleigh, NC';
const CUSTOMER_STREET = '123 Main St';

/**
 * A three-hour card, which is what clears `showAddress` (the address row appears above 80px of
 * estimated height). A one-hour card never renders an address at all and would pass every case
 * below for the wrong reason.
 */
function jobEvent(over: Partial<SchedulableEvent> = {}): BoardEvent {
  return {
    boardId: 'jv-v1',
    parentId: 'job-1',
    visitId: 'v1',
    type: 'job',
    number: 'J00043',
    title: 'Rooftop Unit Swap',
    customer: 'Acme Corp',
    crew: ['u-alice'],
    ownerId: null,
    start: asWallClock(new Date(2026, 5, 10, 9, 0)),
    end: asWallClock(new Date(2026, 5, 10, 12, 0)),
    raw: {
      job_number: 'J00043',
      status: 'SCHEDULED',
      customer: { first_name: 'Acme', last_name: 'Corp' },
      assignees: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } }],
      service_location: { address_line1: CUSTOMER_STREET, city: 'Raleigh', state: 'NC' },
    },
    ...over,
  };
}

function walkthroughEvent(over: Partial<SchedulableEvent> = {}): BoardEvent {
  return {
    boardId: 'wt-lead-1',
    parentId: 'lead-1',
    type: 'walkthrough',
    number: 'L00012',
    title: 'Initial site visit',
    customer: 'Acme Corp',
    crew: ['u-alice'],
    ownerId: null,
    start: asWallClock(new Date(2026, 5, 11, 9, 0)),
    end: asWallClock(new Date(2026, 5, 11, 12, 0)),
    raw: {
      lead_number: 'L00012',
      status: 'CONTACTED',
      customer: { first_name: 'Acme', last_name: 'Corp' },
      walkthrough_performers: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } }],
      service_address_line1: CUSTOMER_STREET,
      service_city: 'Raleigh',
      service_state: 'NC',
    },
    ...over,
  };
}

describe('the standard calendar card', () => {
  it('paints the service address for a trip that is at the service address', () => {
    render(<ScheduleEvent event={jobEvent()} />);

    expect(screen.getByText(`${CUSTOMER_STREET}, Raleigh, NC`)).toBeInTheDocument();
  });

  it('paints where the TRIP is, not the customer’s street, when the two differ', () => {
    render(<ScheduleEvent event={jobEvent({ locationLabel: AT_YARD })} />);

    expect(screen.getByText(AT_YARD)).toBeInTheDocument();
    // The point of the case: the customer's address must be GONE, not merely joined. A card
    // carrying both is a card a dispatcher has to stop and read.
    expect(screen.queryByText(new RegExp(CUSTOMER_STREET))).toBeNull();
  });

  it('does the same for a walkthrough card', () => {
    render(<ScheduleEvent event={walkthroughEvent({ locationLabel: AT_YARD })} />);

    expect(screen.getByText(AT_YARD)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(CUSTOMER_STREET))).toBeNull();
  });

  it('leaves a walkthrough at the service address exactly as it was', () => {
    render(<ScheduleEvent event={walkthroughEvent()} />);

    expect(screen.getByText(`${CUSTOMER_STREET}, Raleigh, NC`)).toBeInTheDocument();
  });
});

describe('the technician grid and member-week boards', () => {
  it('prefer the trip’s own location over the parent’s service address', () => {
    expect(cardAddressText(jobEvent({ locationLabel: AT_YARD }))).toBe(AT_YARD);
    expect(cardAddressText(walkthroughEvent({ locationLabel: AT_YARD }))).toBe(AT_YARD);
  });

  it('fall back to the service address, unchanged, when the trip has no location of its own', () => {
    // Pinned as "contains the street", not as an exact string: the job branch's own derivation is
    // pre-existing and out of this slice's remit, and pinning it here would freeze a bug beside
    // a fix.
    expect(cardAddressText(walkthroughEvent())).toBe(`${CUSTOMER_STREET}, Raleigh, NC`);
    expect(cardAddressText(jobEvent())).not.toBe(AT_YARD);
  });
});
