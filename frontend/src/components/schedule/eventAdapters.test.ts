import { describe, it, expect } from 'vitest';
import { calendarEntryToEvent, jobToEvents, walkthroughToEvent } from './eventAdapters';
import { isOnBoardFor, eventDangerState } from './scheduleModel';

/**
 * Multi-visit S6 turned `jobToEvent` into `jobToEvents`, one event per live visit. Every case
 * below feeds a job with NO visits array, which is exactly the fallback the slice preserves: one
 * event off the D14 mirror, keyed on the bare job id. This helper keeps those cases asserting
 * that fallback rather than being deleted with the old name.
 */
const jobToEvent = (job: Record<string, unknown>, tz: string) => jobToEvents(job, tz)[0]!;
import { toInstant } from '@/lib/schedule-tz';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

const job = {
  id: 'job-1', job_number: 'J00041', status: 'SCHEDULED',
  scope_notes: 'Install HVAC',
  scheduled_start: '2026-06-10T09:00:00.000Z', scheduled_end: '2026-06-10T11:00:00.000Z',
  customer: { first_name: 'Lee', last_name: 'Adams', company_name: null },
  assignees: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } }],
  estimate: { lead: { commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } } },
};
const lead = {
  id: 'lead-9', lead_number: 'L00012',
  walkthrough_scheduled_at: '2026-06-10T13:00:00.000Z', walkthrough_duration_minutes: 90,
  customer: { first_name: 'Lee', last_name: 'Adams', company_name: 'Lee Co' },
  walkthrough_performers: [{ user: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } }],
  commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' },
};

describe('jobToEvent (converts at the read boundary — start/end become the org-tz WallClock)', () => {
  it('maps id, number, crew ids, owner, and a WallClock start/end in the given tz', () => {
    const e = jobToEvent(job, NY);
    expect(e).toMatchObject({ boardId: 'job-1', parentId: 'job-1', type: 'job', number: 'J00041', crew: ['u-alice'], ownerId: 'u-eve' });
    // 2026-06-10T09:00:00Z is 05:00 EDT (June is DST) — the WallClock's local digits read that.
    expect(e.start?.getHours()).toBe(5);
    expect(e.start?.getMinutes()).toBe(0);
    expect(e.end?.getHours()).toBe(7);
    expect(e.raw).toBe(job);
  });
  it('the WallClock round-trips back to the exact stored instant via toInstant', () => {
    const e = jobToEvent(job, NY);
    expect(toInstant(e.start!, NY).toISOString()).toBe(job.scheduled_start);
    expect(toInstant(e.end!, NY).toISOString()).toBe(job.scheduled_end);
  });
  it('unscheduled job → null start/end (state 1/3)', () => {
    const e = jobToEvent({ ...job, scheduled_start: null, scheduled_end: null }, NY);
    expect(e.start).toBeNull();
    expect(e.end).toBeNull();
  });
  it('crew-less job → empty crew (state 4 when timed)', () => {
    expect(jobToEvent({ ...job, assignees: [] }, NY).crew).toEqual([]);
  });
  it('start set, scheduled_end null → end synthesized as start + 120m default, in wall-clock space', () => {
    const e = jobToEvent({ ...job, scheduled_end: null }, NY);
    expect(e.start?.getHours()).toBe(5);
    expect(e.end?.getHours()).toBe(7); // +120m
  });
  it('customer null → customer field falls back to "Customer"', () => {
    const e = jobToEvent({ ...job, customer: null }, NY);
    expect(e.customer).toBe('Customer');
  });
  // SRVW-58 - tag chips on the board read event.tags, not event.raw.tags.
  it('carries tags through from the job payload', () => {
    const tags = [{ id: 't-1', name: 'VIP', color: '#EF4444' }];
    expect(jobToEvent({ ...job, tags }, NY).tags).toEqual(tags);
  });
  it('no tags key on the payload → empty array, never undefined', () => {
    expect(jobToEvent(job, NY).tags).toEqual([]);
  });
  it('a non-DST org tz (Manila) reads its own offset, not New York\'s', () => {
    // 2026-06-10T09:00:00Z is 17:00 in Asia/Manila (UTC+8, no DST).
    const e = jobToEvent(job, MANILA);
    expect(e.start?.getHours()).toBe(17);
  });
});

describe('walkthroughToEvent (converts at the read boundary — start/end become the org-tz WallClock)', () => {
  it('id is wt-prefixed; crew = performers; owner = commission_owner; end = start + duration', () => {
    const e = walkthroughToEvent(lead, NY);
    expect(e).toMatchObject({ boardId: 'wt-lead-9', parentId: 'lead-9', type: 'walkthrough', number: 'L00012', crew: ['u-eve'], ownerId: 'u-eve' });
    // 2026-06-10T13:00:00Z is 09:00 EDT.
    expect(e.start?.getHours()).toBe(9);
    expect(e.end?.getHours()).toBe(10);
    expect(e.end?.getMinutes()).toBe(30); // +90m
    expect(e.title).toContain('Lee Co'); // company name preferred
  });
  it('the WallClock round-trips back to the exact stored instant via toInstant', () => {
    const e = walkthroughToEvent(lead, NY);
    expect(toInstant(e.start!, NY).toISOString()).toBe(lead.walkthrough_scheduled_at);
  });
  it('unscheduled walkthrough → null start/end', () => {
    const e = walkthroughToEvent({ ...lead, walkthrough_scheduled_at: null }, NY);
    expect(e.start).toBeNull();
    expect(e.end).toBeNull();
  });
  it('walkthrough_duration_minutes null → end = start + 60m default', () => {
    const e = walkthroughToEvent({ ...lead, walkthrough_duration_minutes: null }, NY);
    expect(e.start?.getHours()).toBe(9);
    expect(e.end?.getHours()).toBe(10); // +60m
    expect(e.end?.getMinutes()).toBe(0);
  });
  // SRVW-58 - the /api/leads payload already carries tags (withTagsMany).
  it('carries tags through from the lead payload', () => {
    const tags = [{ id: 't-2', name: 'Recurring billing', color: '#2F7D5D' }];
    expect(walkthroughToEvent({ ...lead, tags }, NY).tags).toEqual(tags);
  });
  it('no tags key on the payload → empty array, never undefined', () => {
    expect(walkthroughToEvent(lead, NY).tags).toEqual([]);
  });
});

describe('calendarEntryToEvent (slice 03 — the CalendarEntry read boundary, ADR 0002)', () => {
  const entry = {
    id: 'entry-abc123',
    title: 'Dave is off Thursday',
    description: '',
    start: '2026-06-10T09:00:00.000Z',
    end: '2026-06-10T11:00:00.000Z',
    is_all_day: false,
  };

  it('boardId is ce-<id>; number is empty (spec §2 — no record number, title alone)', () => {
    const e = calendarEntryToEvent(entry, NY);
    expect(e.boardId).toBe('ce-entry-abc123');
    expect(e.parentId).toBe('entry-abc123');
    expect(e.type).toBe('calendar-entry');
    expect(e.number).toBe('');
    expect(e.title).toBe('Dave is off Thursday');
  });

  it('crew is empty and ownerId is null — an entry joins nothing (ADR 0002)', () => {
    const e = calendarEntryToEvent(entry, NY);
    expect(e.crew).toEqual([]);
    expect(e.ownerId).toBeNull();
    expect(e.customer).toBe('');
  });

  it('start/end are the org-zone WallClock, not the browser zone', () => {
    // 2026-06-10T09:00:00Z is 05:00 EDT (June is DST) in New York.
    const e = calendarEntryToEvent(entry, NY);
    expect(e.start?.getHours()).toBe(5);
    expect(e.end?.getHours()).toBe(7);
    // A different org tz reads its own offset, not New York's — proves the conversion happens
    // here, at the read boundary, using the passed tz (2026-06-10T09:00:00Z is 17:00 in Manila).
    const eManila = calendarEntryToEvent(entry, MANILA);
    expect(eManila.start?.getHours()).toBe(17);
  });

  it('the WallClock round-trips back to the exact stored instant via toInstant', () => {
    const e = calendarEntryToEvent(entry, NY);
    expect(toInstant(e.start!, NY).toISOString()).toBe(entry.start);
    expect(toInstant(e.end!, NY).toISOString()).toBe(entry.end);
  });

  it('carries the raw entry through for downstream reads', () => {
    expect(calendarEntryToEvent(entry, NY).raw).toBe(entry);
  });

  it('tags is always empty — a calendar entry does not carry tag chips', () => {
    expect(calendarEntryToEvent(entry, NY).tags).toEqual([]);
  });
});

describe('calendarEntryToEvent — participantUserIds (slice 06, member column placement)', () => {
  const entry = {
    id: 'entry-abc123',
    title: 'Dave is off Thursday',
    description: '',
    start: '2026-06-10T09:00:00.000Z',
    end: '2026-06-10T11:00:00.000Z',
    is_all_day: false,
  };

  it('fills participantUserIds from USER participants; CUSTOMER rows are excluded', () => {
    const withParticipants = {
      ...entry,
      participants: [
        { kind: 'USER', user_id: 'u-dave', customer_id: null, first_name: 'Dave', last_name: 'Ng' },
        { kind: 'CUSTOMER', user_id: null, customer_id: 'c-1', name: 'Acme Co' },
      ],
    };
    const e = calendarEntryToEvent(withParticipants, NY);
    expect(e.participantUserIds).toEqual(['u-dave']);
  });

  // ADR 0002's central constraint for this slice: naming a participant must never populate crew.
  it('crew stays [] even when the entry names a user participant', () => {
    const withParticipants = {
      ...entry,
      participants: [{ kind: 'USER', user_id: 'u-dave', customer_id: null }],
    };
    expect(calendarEntryToEvent(withParticipants, NY).crew).toEqual([]);
  });

  it('an entry whose only participants are customers → participantUserIds has no user ids', () => {
    const customerOnly = {
      ...entry,
      participants: [{ kind: 'CUSTOMER', user_id: null, customer_id: 'c-1', name: 'Acme Co' }],
    };
    expect(calendarEntryToEvent(customerOnly, NY).participantUserIds).toEqual([]);
  });

  it('no participants key on the payload → participantUserIds is empty, never throws', () => {
    expect(calendarEntryToEvent(entry, NY).participantUserIds).toEqual([]);
  });
});

// ═══ VISIT-LOCATION SLICE 6 - THE ONLY WIRING THERE IS ══════════════════════
//
// This module is the SINGLE place the API's `location_label` / `walkthrough_location_label`
// become `SchedulableEvent.locationLabel`. Every card renderer below it - the standard calendar's
// ScheduleEvent, `cardAddressText` (technician grid + member-week board), the schedule detail -
// reads the typed field and never the wire key, and every one of their tests builds a
// SchedulableEvent BY HAND with the label already on it.
//
// So without the cases below the whole schedule half of the slice is deletable in silence: set
// both mappings to `null` and 725 files / 7657 tests stay green while four surfaces revert to
// painting the customer's street on a trip booked at the yard - the exact defect the slice
// removes, and one nobody catches until a crew drives to the wrong address.

describe('jobToEvents - each trip carries its OWN location (slice 6)', () => {
  const AT_YARD = 'North Yard, 9 Depot Rd, Raleigh, NC';
  const AT_SUPPLIER = '400 Supplier Rd, Charlotte, NC';
  const visit = (over: Record<string, unknown>) => ({
    id: 'v1', visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: '2026-06-10T09:00:00.000Z', scheduled_end: '2026-06-10T11:00:00.000Z',
    ...over,
  });

  it('maps visits[].location_label onto locationLabel, PER VISIT', () => {
    const events = jobToEvents({
      ...job,
      visits: [
        visit({ id: 'v1', location_label: AT_YARD }),
        visit({ id: 'v2', visit_seq: 2, scheduled_at: '2026-06-11T09:00:00.000Z', location_label: AT_SUPPLIER }),
      ],
    }, NY);

    expect(events.map((e) => e.boardId)).toEqual(['jv-v1', 'jv-v2']);
    // TWO DIFFERENT STRINGS off two visits of ONE job, and that is the point: the label belongs
    // to the trip, not to the job. A mapping hoisted into sharedJobFields, read off the job row,
    // or pinned to a constant answers the same string for both cards and fails here - while a
    // single-visit case would not notice.
    expect(events.map((e) => e.locationLabel)).toEqual([AT_YARD, AT_SUPPLIER]);
  });

  it('a trip at the service address maps to null, so its card shows no location line', () => {
    const events = jobToEvents({ ...job, visits: [visit({ location_label: null })] }, NY);

    expect(events[0]!.locationLabel).toBeNull();
  });

  // A board payload served before this field shipped carries no key at all. `null`, not
  // `undefined`: the card renderers gate on the value, and "absent" has nothing better to mean.
  it('a payload from before the field existed maps to null, never undefined', () => {
    const events = jobToEvents({ ...job, visits: [visit({})] }, NY);

    expect(events[0]!.locationLabel).toBeNull();
  });
});

describe('walkthroughToEvent - the meeting carries its own location (slice 6)', () => {
  const AT_SHOWROOM = 'Showroom, 12 Harbor St, Asheville, NC';

  it('maps walkthrough_location_label onto locationLabel', () => {
    const e = walkthroughToEvent({ ...lead, walkthrough_location_label: AT_SHOWROOM }, NY);

    expect(e.locationLabel).toBe(AT_SHOWROOM);
    // The card's time and the card's place must come off the SAME trip - the lead's flat
    // walkthrough_* fields are all resolved from the current visit, and this asserts the label
    // arrives on the same event as that visit's start rather than on some other card.
    expect(e.start?.getHours()).toBe(9);
  });

  it('a meeting at the service address maps to null', () => {
    expect(walkthroughToEvent({ ...lead, walkthrough_location_label: null }, NY).locationLabel).toBeNull();
  });

  it('a payload from before the field existed maps to null, never undefined', () => {
    expect(walkthroughToEvent(lead, NY).locationLabel).toBeNull();
  });
});

describe('jobToEvents - "Visit n of m" counts the live trips on the seq axis', () => {
  const trip = (id: string, visit_seq: number, status = 'SCHEDULED') => ({
    id, visit_seq, status, scheduled_at: '2026-06-10T09:00:00.000Z', scheduled_end: '2026-06-10T11:00:00.000Z',
  });

  it('a cancelled last trip drops out of the total: the two live cards read 1 of 2 and 2 of 2', () => {
    const events = jobToEvents({ ...job, visits: [trip('v1', 1), trip('v2', 2), trip('v3', 3, 'CANCELLED')] }, NY);
    expect(events.map((e) => [e.visitSeq, e.visitCount])).toEqual([[1, 2], [2, 2]]);
  });

  it('a cancelled first trip keeps the survivors on the seq axis: 2 of 3 and 3 of 3', () => {
    const events = jobToEvents({ ...job, visits: [trip('v1', 1, 'CANCELLED'), trip('v2', 2), trip('v3', 3)] }, NY);
    expect(events.map((e) => [e.visitSeq, e.visitCount])).toEqual([[2, 3], [3, 3]]);
  });
});

// visits-and-task-categories slice 02 (PRD stories 6-8). Every card of a job used to carry the
// JOB-level crew - the union across all its visits - so a three-visit job whose trips are staffed
// by different people put every trip in every one of those people's lanes. A card is ONE trip,
// so its crew is that trip's crew and nobody else's.
describe('jobToEvents - each visit card carries its OWN crew (slice 02)', () => {
  const ALICE = { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', phone: null };
  const BOB = { id: 'u-bob', first_name: 'Bob', last_name: 'Ode', phone: null };
  const CARA = { id: 'u-cara', first_name: 'Cara', last_name: 'Diaz', phone: null };
  const onVisit = (...people: (typeof ALICE)[]) => people.map((u) => ({ user_id: u.id, user: u }));
  const trip = (id: string, visit_seq: number, day: number, assignees: unknown[], status = 'SCHEDULED') => ({
    id, visit_seq, status,
    scheduled_at: `2026-09-${day}T13:00:00.000Z`, scheduled_end: `2026-09-${day}T15:00:00.000Z`,
    assignees,
  });
  // A three-visit job staffed differently per trip - the shape of the demo org's multi-visit job.
  // The job-level `assignees` key is the server-side union of all three trips' crews.
  const threeCrews = {
    ...job,
    assignees: onVisit(ALICE, BOB, CARA).map(({ user }) => ({ user })),
    visits: [
      trip('v1', 1, 28, onVisit(ALICE)),
      trip('v2', 2, 29, onVisit(BOB)),
      trip('v3', 3, 30, onVisit(ALICE, CARA)),
    ],
  };

  it('a job with visits crewed differently yields one card per visit, each listing only its own crew', () => {
    const events = jobToEvents(threeCrews, NY);

    expect(events.map((e) => [e.boardId, e.crew])).toEqual([
      ['jv-v1', [ALICE.id]],
      ['jv-v2', [BOB.id]],
      ['jv-v3', [ALICE.id, CARA.id]],
    ]);
  });

  it('in the Member view each visit sits only in its own crew\'s lanes', () => {
    const events = jobToEvents(threeCrews, NY);
    const laneOf = (memberId: string) => events.filter((e) => isOnBoardFor(e, memberId)).map((e) => e.boardId);

    expect(laneOf(ALICE.id)).toEqual(['jv-v1', 'jv-v3']);
    expect(laneOf(BOB.id)).toEqual(['jv-v2']);
    expect(laneOf(CARA.id)).toEqual(['jv-v3']);
  });

  it('a visit with no crew is unassigned - in nobody\'s lane and flagged as needing crew - even when its siblings are crewed', () => {
    const events = jobToEvents({ ...threeCrews, visits: [trip('v1', 1, 28, onVisit(ALICE)), trip('v2', 2, 29, [])] }, NY);
    const uncrewed = events.find((e) => e.boardId === 'jv-v2')!;

    expect(uncrewed.crew).toEqual([]);
    expect([ALICE.id, BOB.id, CARA.id].some((id) => isOnBoardFor(uncrewed, id))).toBe(false);
    expect(eventDangerState(uncrewed, new Set())).toBe('needs-crew');
  });

  it('a cancelled visit produces no card, so its crew is in no lane on its account', () => {
    const events = jobToEvents({
      ...threeCrews,
      visits: [trip('v1', 1, 28, onVisit(ALICE)), trip('v2', 2, 29, onVisit(BOB), 'CANCELLED')],
    }, NY);

    expect(events.map((e) => e.boardId)).toEqual(['jv-v1']);
    expect(events.some((e) => isOnBoardFor(e, BOB.id))).toBe(false);
  });
});
