import { describe, it, expect } from 'vitest';
import {
  resolveCurrentWalkthrough,
  projectLegacyWalkthroughFields,
  projectLeadWalkthroughFields,
  projectLeadVisitCrew,
} from '../services/walkthrough.service';

// D15: "Current visit" = the next upcoming SCHEDULED visit; if none upcoming, the most recent visit
// that happened (completed or cancelled). One rule, reused by updateWalkthrough's write target, the
// four legacy-shaped SELECT/serialize sites, and the automation merge fields.
describe('resolveCurrentWalkthrough', () => {
  const base = {
    id: 'w1', visit_seq: 1, status: 'CANCELLED' as const, scheduled_at: null, duration_minutes: null,
    completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-01-01'),
  };

  it('returns null for a lead that holds no visits at all', () => {
    expect(resolveCurrentWalkthrough([])).toBeNull();
  });

  // Multi-visit S1: with several live visits per lead, "current" can no longer be "the first
  // SCHEDULED row we happen to see" - it has to be the EARLIEST still-coming trip.
  it('picks the earliest upcoming visit when a lead holds several live ones', () => {
    const later   = { ...base, id: 'w-later',   status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-10') };
    const sooner  = { ...base, id: 'w-sooner',  status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-02') };
    expect(resolveCurrentWalkthrough([later, sooner])?.id).toBe('w-sooner');
  });

  it('prefers a live visit over a completed one regardless of array order', () => {
    const completed = { ...base, id: 'w-done', status: 'COMPLETED' as const, completed_at: new Date('2026-06-01') };
    const upcoming  = { ...base, id: 'w-next', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-02') };
    expect(resolveCurrentWalkthrough([completed, upcoming])?.id).toBe('w-next');
  });

  it('a SCHEDULED visit is current even alongside older happened visits', () => {
    const completed = { ...base, id: 'w-old', status: 'COMPLETED' as const, completed_at: new Date('2026-02-01') };
    const scheduled = { ...base, id: 'w-new', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-04-01') };
    expect(resolveCurrentWalkthrough([completed, scheduled])?.id).toBe('w-new');
  });

  it('with no SCHEDULED visit, the most recently COMPLETED one is current', () => {
    const older = { ...base, id: 'w-older', status: 'COMPLETED' as const, completed_at: new Date('2026-02-01') };
    const newer = { ...base, id: 'w-newer', status: 'COMPLETED' as const, completed_at: new Date('2026-03-01') };
    expect(resolveCurrentWalkthrough([older, newer])?.id).toBe('w-newer');
  });

  it('a later CANCELLED visit outranks an earlier COMPLETED one', () => {
    const completed = { ...base, id: 'w-completed', status: 'COMPLETED' as const, completed_at: new Date('2026-02-01') };
    const cancelled = { ...base, id: 'w-cancelled', status: 'CANCELLED' as const, cancelled_at: new Date('2026-03-01') };
    expect(resolveCurrentWalkthrough([completed, cancelled])?.id).toBe('w-cancelled');
  });
});

describe('projectLegacyWalkthroughFields', () => {
  const base = {
    id: 'w1', visit_seq: 1, status: 'CANCELLED' as const, scheduled_at: null, duration_minutes: null,
    completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-01-01'),
  };

  it('an empty visit list projects every field to null', () => {
    expect(projectLegacyWalkthroughFields(undefined, { full: true })).toEqual({
      walkthrough_scheduled_at: null,
      walkthrough_completed_at: null,
      walkthrough_duration_minutes: null,
      walkthrough_notes: null,
      walkthrough_cancelled_at: null,
      walkthrough_cancelled_reason: null,
      walkthrough_cancelled_by: null,
      walkthrough_canceller: null,
      walkthrough_customer_email_sent_at: null,
      walkthrough_count: 0,
      walkthrough_history: [],
    });
  });

  it('a SCHEDULED current visit projects scheduled_at/duration but NOT completed_at (D15 incoherence fix)', () => {
    const scheduled = { ...base, status: 'SCHEDULED' as const, scheduled_at: new Date('2026-04-01'), duration_minutes: 45 };
    const fields = projectLegacyWalkthroughFields([scheduled], { full: false });
    expect(fields.walkthrough_scheduled_at).toEqual(new Date('2026-04-01'));
    expect(fields.walkthrough_completed_at).toBeNull();
    expect(fields.walkthrough_duration_minutes).toBe(45);
  });

  it('a COMPLETED current visit projects completed_at and notes; list mode omits the detail-only keys', () => {
    const completed = { ...base, status: 'COMPLETED' as const, completed_at: new Date('2026-04-05'), notes: 'All good' };
    const full = projectLegacyWalkthroughFields([completed], { full: true });
    expect(full.walkthrough_completed_at).toEqual(new Date('2026-04-05'));
    expect(full.walkthrough_notes).toBe('All good');

    const list = projectLegacyWalkthroughFields([completed], { full: false });
    expect(list).not.toHaveProperty('walkthrough_notes');
    expect(list.walkthrough_completed_at).toEqual(new Date('2026-04-05'));
  });

  it('a CANCELLED current visit projects cancellation fields, never completed_at', () => {
    const cancelled = {
      ...base, status: 'CANCELLED' as const, cancelled_at: new Date('2026-04-10'),
      cancelled_reason: 'Customer rescheduled', cancelled_by: 'user-1',
    };
    const fields = projectLegacyWalkthroughFields([cancelled], { full: true });
    expect(fields.walkthrough_cancelled_at).toEqual(new Date('2026-04-10'));
    expect(fields.walkthrough_cancelled_reason).toBe('Customer rescheduled');
    expect(fields.walkthrough_cancelled_by).toBe('user-1');
    expect(fields.walkthrough_completed_at).toBeNull();
  });

  // PR-C2: WALKTHROUGH_SCHEDULED/WALKTHROUGH_COMPLETED left LeadStatus, so LeadDetailPage's
  // walkthrough tab can no longer branch on lead.status to show "how many visits, and what
  // happened on the earlier ones" - it needs that off the wire. full mode only (list mode has
  // never carried per-visit detail, same reasoning as walkthrough_notes above).
  it('full mode also projects walkthrough_count and a newest-first walkthrough_history', () => {
    const older = { ...base, id: 'w-older', status: 'CANCELLED' as const, cancelled_at: new Date('2026-02-01'), created_at: new Date('2026-01-15') };
    const current = { ...base, id: 'w-current', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-04-01'), created_at: new Date('2026-03-20') };
    const fields = projectLegacyWalkthroughFields([older, current], { full: true });
    expect(fields.walkthrough_count).toBe(2);
    expect((fields.walkthrough_history as Array<{ id: string }>).map((w) => w.id)).toEqual(['w-current', 'w-older']);
  });

  it('list mode omits walkthrough_count and walkthrough_history', () => {
    const fields = projectLegacyWalkthroughFields([{ ...base }], { full: false });
    expect(fields).not.toHaveProperty('walkthrough_count');
    expect(fields).not.toHaveProperty('walkthrough_history');
  });

  it('an empty walkthrough list projects walkthrough_count: 0 and an empty history', () => {
    const fields = projectLegacyWalkthroughFields(undefined, { full: true });
    expect(fields.walkthrough_count).toBe(0);
    expect(fields.walkthrough_history).toEqual([]);
  });

  // ── walkthrough_location: the seed the booking form is destructive without ────────────────
  //
  // Visit-location spec (D2/D7). This key is the ONLY way the lead detail response tells the
  // booking dialog where the current visit is. The dialog's location control defaults to the
  // service address and the form states a location on EVERY save, so with the key missing a
  // Reschedule of the time alone posts `location: null` and sends a customer who was told to come
  // to the showroom to their own house instead. Nothing else in the backend suite reads the key,
  // so removing the projection was a silent, whole-suite-green regression.
  //
  // The three-way shape is the point: `undefined` means this caller's select never asked for the
  // columns, which is NOT `null` meaning "no location, i.e. the service address". Collapsing them
  // would have every response quietly assert every visit is at the customer's address.
  const atShowroom = {
    ...base,
    status: 'SCHEDULED' as const,
    scheduled_at: new Date('2026-04-01'),
    location_id: 'loc-1',
    location_address_line1: null,
    location_address_line2: null,
    location_city: null,
    location_state: null,
    location_zip: null,
  };

  it('full mode carries the current visit’s location as a pointer, never its address', () => {
    const fields = projectLegacyWalkthroughFields([atShowroom], { full: true });

    expect(fields).toHaveProperty('walkthrough_location');
    expect(fields.walkthrough_location).toEqual({
      location_id: 'loc-1',
      address_line1: null,
      address_line2: null,
      city: null,
      state: null,
      zip: null,
    });
  });

  it('full mode carries a one-off address as five separate fields', () => {
    const oneOff = {
      ...base,
      status: 'SCHEDULED' as const,
      scheduled_at: new Date('2026-04-01'),
      location_id: null,
      location_address_line1: '12 Harbor St',
      location_address_line2: 'Suite 4',
      location_city: 'Asheville',
      location_state: 'NC',
      location_zip: '28801',
    };

    expect(projectLegacyWalkthroughFields([oneOff], { full: true }).walkthrough_location).toEqual({
      location_id: null,
      address_line1: '12 Harbor St',
      address_line2: 'Suite 4',
      city: 'Asheville',
      state: 'NC',
      zip: '28801',
    });
  });

  it('full mode says null - not "absent" - for a visit at the service address', () => {
    const atService = { ...atShowroom, location_id: null };
    const fields = projectLegacyWalkthroughFields([atService], { full: true });

    expect(fields).toHaveProperty('walkthrough_location');
    expect(fields.walkthrough_location).toBeNull();
  });

  it('omits the key entirely when the select never carried the columns', () => {
    // `base` has no location columns at all - a list select, or any caller that did not ask.
    // Answering `null` here would be a guess dressed as a fact.
    const fields = projectLegacyWalkthroughFields([{ ...base }], { full: true });
    expect(fields).not.toHaveProperty('walkthrough_location');
  });

  it('list mode never carries it, the same as every other detail-only key', () => {
    expect(projectLegacyWalkthroughFields([atShowroom], { full: false }))
      .not.toHaveProperty('walkthrough_location');
  });
});

// Reused at every SELECT/serialize site the PR-D2 gap flagged (lead.controller.ts's
// leadListSelect/leadDetailSelect, estimate/job's lead-nested selects, search's LEAD_SELECT).
describe('projectLeadWalkthroughFields', () => {
  it('a no-op when the object never selected `walkthroughs` at all (untouched callers)', () => {
    // Real objects like this never fail the generic constraint (they're never bare literals at the
    // call site - see estimate.controller.ts/job.controller.ts's `as never` casts); the `as never`
    // here only works around TS's weak-type check on an inline object literal with zero properties
    // in common with `{ walkthroughs?: ... }`, not a production concern.
    const lead = { id: 'lead-1', status: 'NEW' };
    expect(projectLeadWalkthroughFields(lead as never, { full: true })).toBe(lead);
  });

  it('projects an empty walkthroughs array to null fields, not a skip (the `in` check)', () => {
    const lead = { id: 'lead-1', visits: [] };
    const out = projectLeadWalkthroughFields(lead, { full: false }) as Record<string, unknown>;
    expect(out.walkthrough_scheduled_at).toBeNull();
    expect(out).not.toHaveProperty('visits');
  });

  // #1590 renamed the Lead -> VisitAssignee relation from `walkthrough_performers` to
  // `visit_assignees`, and because a Prisma relation name IS the JSON key, the API quietly
  // stopped sending a field the whole frontend reads - the lead hero, the walkthrough tab, the
  // scheduler board's crew and the copilot handler all ask for `walkthrough_performers` and got
  // `undefined`. The projection's job is to keep the legacy flat NAMES while the model moves
  // underneath, so the rename belongs here rather than in six frontend readers (#1637).
  it('projects visit_assignees back onto the legacy walkthrough_performers name', () => {
    const lead = {
      id: 'lead-1',
      visits: [],
      visit_assignees: [{ user_id: 'u1', user: { id: 'u1', first_name: 'Alex', last_name: 'Romero' } }],
    };
    const out = projectLeadWalkthroughFields(lead, { full: true }) as Record<string, unknown>;
    expect(out.walkthrough_performers).toEqual([
      { user_id: 'u1', user: { id: 'u1', first_name: 'Alex', last_name: 'Romero' } },
    ]);
    expect(out).not.toHaveProperty('visit_assignees');
  });

  it('leaves a caller that never selected the performers relation without the key', () => {
    const lead = { id: 'lead-1', visits: [] };
    const out = projectLeadWalkthroughFields(lead, { full: true }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('walkthrough_performers');
  });

  // The two renames are independent: a select carrying performers but no visits must still get
  // the legacy name, or the early return for untouched callers would swallow it.
  it('renames the performers even when the visits relation was not selected', () => {
    const lead = { visit_assignees: [{ user_id: 'u1' }] };
    const out = projectLeadWalkthroughFields(lead as never, { full: false }) as Record<string, unknown>;
    expect(out.walkthrough_performers).toEqual([{ user_id: 'u1' }]);
    expect(out).not.toHaveProperty('visit_assignees');
  });

  it('sources walkthrough_scheduled_at from the relation and strips the raw walkthroughs key', () => {
    const scheduled = {
      id: 'w1', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-01'), duration_minutes: 60,
      completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
      cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-04-01'),
    };
    const lead = { id: 'lead-1', status: 'CONTACTED', visits: [scheduled] };
    const out = projectLeadWalkthroughFields(lead, { full: false }) as Record<string, unknown>;
    expect(out.walkthrough_scheduled_at).toEqual(new Date('2026-05-01'));
    expect(out).not.toHaveProperty('visits');
    expect(out.id).toBe('lead-1');
  });
});

// ─── The crew belongs to ONE visit (#1952, and the walkthrough form's 403 dead end) ───────────
//
// S8 flat-mapped every visit's assignees together, so the key answered "everyone who was ever on
// any trip for this lead". Two things fell out of that. A person on two trips was rendered twice
// ("with Mike Turner, Mike Turner") - `visit_assignees` is @@unique([visit_id, user_id]), so
// crossing visits was the ONLY way a name could repeat. And a lead whose visits were all
// cancelled still reported a crew, which the walkthrough form read as "already staffed": it
// pre-filled a technician the viewer may not name, locked the field, and the save came back 403
// because `findActiveWalkthrough` sees no live visit and takes the strict path.
//
// The crew is now the CURRENT visit's - resolveCurrentWalkthrough, the same resolution the flat
// walkthrough_* fields use, so the crew and the time on the wire always describe one visit.
describe('projectLeadVisitCrew', () => {
  const base = {
    id: 'v', visit_seq: 1, status: 'SCHEDULED' as const, scheduled_at: null, duration_minutes: null,
    completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2026-01-01'),
  };
  const crew = (...ids: string[]) => ids.map((id) => ({ user_id: id, user: { id } }));
  /** The projected crew, as ids. The projection is generic in the lead, so the internal key it
   *  adds is `unknown` on the way out - narrowed once here instead of at every case below. */
  const crewIdsOf = (lead: Record<string, unknown>): string[] =>
    ((projectLeadVisitCrew(lead).visit_assignees as { user_id: string }[] | undefined) ?? [])
      .map((a) => a.user_id);

  it('a no-op when `visits` was never selected', () => {
    const lead = { id: 'lead-1', status: 'NEW' };
    expect(projectLeadVisitCrew(lead)).toBe(lead);
  });

  it('projects an empty crew for a lead selected with no visits at all', () => {
    expect(crewIdsOf({ id: 'lead-1', visits: [] })).toEqual([]);
  });

  // THE DEAD END. The flat fields describe the latest cancelled trip, so the crew is that
  // trip's - history, which the form reads as history too (walkthroughTab.liveVisitPerformerIds).
  // What it must NOT be is a union: the earlier trip's technician is on no visit this lead has.
  it('names only the current visit\'s crew when every visit is cancelled', () => {
    const older = { ...base, id: 'v-older', status: 'CANCELLED' as const, cancelled_at: new Date('2026-02-01'), assignees: crew('u-old') };
    const latest = { ...base, id: 'v-latest', status: 'CANCELLED' as const, cancelled_at: new Date('2026-03-01'), assignees: crew('u-latest') };
    expect(crewIdsOf({ id: 'lead-1', visits: [older, latest] })).toEqual(['u-latest']);
  });

  // The case a frontend gate alone cannot fix: with a union, a self-only rep rescheduling this
  // lead would resend [u-cancelled, u-live] against a live visit whose set is [u-live] - a
  // CHANGE, so `validatePerformers` refuses it 403 instead of exempting the restatement.
  it('ignores a cancelled visit\'s crew entirely when a live visit exists', () => {
    const cancelled = { ...base, id: 'v-cancelled', status: 'CANCELLED' as const, cancelled_at: new Date('2026-02-01'), assignees: crew('u-cancelled') };
    const live = { ...base, id: 'v-live', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-01'), assignees: crew('u-live') };
    expect(crewIdsOf({ id: 'lead-1', visits: [cancelled, live] })).toEqual(['u-live']);
  });

  // findActiveWalkthrough hands validatePerformers the EARLIEST live visit's assignees, so with
  // two live visits the wire has to name that same row's crew or the form restates the wrong set.
  it('takes the EARLIEST live visit when a lead holds several', () => {
    const later = { ...base, id: 'v-later', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-10'), assignees: crew('u-later') };
    const sooner = { ...base, id: 'v-sooner', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-02'), assignees: crew('u-sooner') };
    expect(crewIdsOf({ id: 'lead-1', visits: [later, sooner] })).toEqual(['u-sooner']);
  });

  // #1952's symptom, at its source: the same person on two trips was two rows on the wire and
  // two names in the card's "with ...". One visit's set cannot repeat a user.
  it('does not repeat a person who is on more than one of the lead\'s visits', () => {
    const first = { ...base, id: 'v1', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-02'), assignees: crew('u-mike') };
    const second = { ...base, id: 'v2', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-09'), assignees: crew('u-mike') };
    expect(crewIdsOf({ id: 'lead-1', visits: [first, second] })).toEqual(['u-mike']);
  });

  it('keeps EVERY member of the visit it does resolve to', () => {
    const live = { ...base, id: 'v-live', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-01'), assignees: crew('u-a', 'u-b') };
    expect(crewIdsOf({ id: 'lead-1', visits: [live] })).toEqual(['u-a', 'u-b']);
  });

  it('projects an empty crew for a current visit nobody is on', () => {
    const live = { ...base, id: 'v-live', status: 'SCHEDULED' as const, scheduled_at: new Date('2026-05-01'), assignees: [] };
    expect(crewIdsOf({ id: 'lead-1', visits: [live] })).toEqual([]);
  });
});
