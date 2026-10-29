/**
 * PLAN MODE DRAFTS SAY WHERE THE TRIP IS - slice 6, the fifth address renderer.
 *
 * Spec:  md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D4, story 15)
 * Slice: md_files/issues/scheduling/06-show-the-location-where-the-visit-is-read.md
 *
 * The schedule page renders an address in five places. Slice 6 fixed four of them and left Plan
 * Mode - which is gated to Admin & Dispatcher, exactly the reader user story 15 names ("so that I
 * do not route someone to the wrong side of town"). A ghost carried no location of its own, so:
 *
 *   (1) its board card fell through `cardAddressText` to the PARENT's service address, painting
 *       the customer's street on a draft for a trip booked at the yard, and
 *   (2) the "Schedule Job?" confirm dialog printed that street under the literal word "Location:".
 *
 * Both read one rule - `planDraftLocation` - and both are asserted here, because a ghost is read
 * twice and deriving the two answers separately is how a card and its own confirm dialog would
 * name two different places for one draft.
 */
import { describe, it, expect } from 'vitest';

import { asWallClock, toWallClock } from '@/lib/schedule-tz';
import { cardAddressText } from '@/components/schedule/ScheduleCardBody';
import type { BoardEvent, SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { GhostEvent } from '@/hooks/usePlanMode';

import { planDraftLocation, ghostToEvent } from '../SchedulePage';

const AT_YARD = 'North Yard, 9 Depot Rd, Raleigh, NC';
const CUSTOMER_STREET = '123 Main St, Raleigh, NC';
const NY = 'America/New_York';

function ghost(over: Partial<GhostEvent> = {}): GhostEvent {
  return {
    id: 'g-1',
    sourceId: 'job-1',
    sourceType: 'job',
    isFromSidebar: false,
    isMovedConfirmed: false,
    start: '2026-06-10T13:00:00.000Z',
    end: '2026-06-10T15:00:00.000Z',
    crew: ['u-alice'],
    title: 'Rooftop Unit Swap',
    customerName: 'Acme Corp',
    address: CUSTOMER_STREET,
    raw: {
      job_number: 'J00043',
      service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
    },
    ...over,
  };
}

// ── the rule both readers share ─────────────────────────────────────────────

describe('planDraftLocation - the trip’s own location wins over the parent’s', () => {
  it('drafts the trip’s location, on BOTH fields, when the card has one', () => {
    const drafted = planDraftLocation({ locationLabel: AT_YARD }, CUSTOMER_STREET);

    // `address` is what the confirm dialog prints under "Location:"; `locationLabel` is what the
    // ghost's card renders from. One rule, so the two cannot name different places.
    expect(drafted.address).toBe(AT_YARD);
    expect(drafted.locationLabel).toBe(AT_YARD);
    expect(drafted.address).not.toContain('123 Main St');
  });

  it('falls back to the parent’s service address, unchanged, for a card with no trip location', () => {
    expect(planDraftLocation({ locationLabel: null }, CUSTOMER_STREET))
      .toEqual({ locationLabel: null, address: CUSTOMER_STREET });
  });

  /**
   * A card in the UNSCHEDULED bucket addresses the JOB, never a trip (jobToBucketEvent builds no
   * `locationLabel` at all), so absent must read as "no location of its own" rather than throwing
   * or drafting the string 'undefined'.
   */
  it('treats an absent locationLabel as the parent’s address, never as a location', () => {
    expect(planDraftLocation({}, CUSTOMER_STREET))
      .toEqual({ locationLabel: null, address: CUSTOMER_STREET });
  });

  // A parent with no address on file either: nothing to draft, and the dialog's `ghost.address &&`
  // gate then hides the line rather than printing an empty "Location:".
  it('drafts nothing when neither the trip nor the parent has an address', () => {
    expect(planDraftLocation({ locationLabel: null }, '').address).toBe('');
  });
});

// ── the ghost's card ────────────────────────────────────────────────────────

describe('ghostToEvent - a ghost’s card says where the trip is', () => {
  it('carries the ghost’s locationLabel onto the board event', () => {
    expect(ghostToEvent(ghost({ locationLabel: AT_YARD }), NY).locationLabel).toBe(AT_YARD);
  });

  /**
   * The consequence, through the renderer the three boards actually share. This is the assertion
   * with teeth: the card reads `locationLabel` and falls back to `raw.service_location`, so a
   * ghost that stopped carrying the label would paint the customer's street here and nothing else
   * on the page would complain.
   */
  it('so the shared card renderer paints the yard, not the customer’s street', () => {
    const event = ghostToEvent(ghost({ locationLabel: AT_YARD }), NY) as BoardEvent;

    expect(cardAddressText(event)).toBe(AT_YARD);
    expect(cardAddressText(event)).not.toContain('123 Main St');
  });

  it('a draft for a trip at the service address carries null, and the card is unchanged', () => {
    const event = ghostToEvent(ghost({ locationLabel: null }), NY) as BoardEvent;

    expect(event.locationLabel).toBeNull();
    // Not pinned to an exact string: the job branch's own parent derivation is pre-existing and
    // out of this slice's remit, and freezing it here would fight the fix that is owed to it.
    expect(cardAddressText(event)).not.toBe(AT_YARD);
  });

  /**
   * Ghosts are persisted to sessionStorage, so a draft written before this shipped is rehydrated
   * with no key at all. Absent must read as null, not as `undefined` - `cardAddressText` gates on
   * truthiness either way, but the typed field is what four surfaces read.
   */
  it('a draft rehydrated from before the field existed reads as null, never undefined', () => {
    expect(ghostToEvent(ghost(), NY).locationLabel).toBeNull();
  });

  // The rest of the mapping is a read boundary like eventAdapters.ts: the ghost's instants become
  // the org wall clock exactly here. Asserted so extracting it from the useMemo cannot have
  // quietly changed the zone the grid places a draft in.
  it('is still the read boundary - the instants become the org wall clock', () => {
    const e = ghostToEvent(ghost(), NY);

    expect(e.boardId).toBe('ghost-g-1');
    expect(e.isGhost).toBe(true);
    expect(e.start).toEqual(toWallClock(new Date('2026-06-10T13:00:00.000Z'), NY));
    expect(e.start.getHours()).toBe(9); // 13:00Z is 09:00 EDT
  });
});

// ── a live board card, for contrast: this is what a ghost now matches ───────

describe('a ghost and the live card it was dragged from agree', () => {
  it('render the same address for the same trip', () => {
    const live: SchedulableEvent = {
      boardId: 'jv-v1',
      parentId: 'job-1',
      type: 'job',
      number: 'J00043',
      title: 'Rooftop Unit Swap',
      customer: 'Acme Corp',
      crew: ['u-alice'],
      ownerId: null,
      locationLabel: AT_YARD,
      start: asWallClock(new Date(2026, 5, 10, 9, 0)),
      end: asWallClock(new Date(2026, 5, 10, 11, 0)),
      raw: { job_number: 'J00043', service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' } },
    };
    const drafted = planDraftLocation(live, CUSTOMER_STREET);
    const draftCard = ghostToEvent(ghost({ locationLabel: drafted.locationLabel }), NY) as BoardEvent;

    // The card the dispatcher dragged and the draft they dropped name the same place - and the
    // confirm dialog they then read names it too.
    expect(cardAddressText(draftCard)).toBe(cardAddressText(live as BoardEvent));
    expect(drafted.address).toBe(cardAddressText(live as BoardEvent));
  });
});
