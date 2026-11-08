// Resolve the people shown on a schedule event from PR A's M2M payloads.
//   job         → assignees[].user                 (crew)
//   walkthrough → lead.walkthrough_performers[].user + walkthrough_visits[].assignees[].user (crew)
//   owner       → lead.commission_owner (off-board); jobs reach it via estimate.lead.
// Replaces the pre-PR-A single-FK readers (assigned_user / walkthrough_performer), which the
// assignment redesign deleted.

/**
 * A person as the EVENT's own payload carries them.
 *
 * `phone` is here rather than on `AssignableUser` on purpose. The roster endpoint
 * (`GET /api/users/assignable`) answers "who may I ADD" and is gated on the `assign User`
 * grant, so it carries no contact fields; the people ALREADY ON the record arrive with the
 * record, which its viewer owns. Reading crew contact details off the roster made the
 * call/text affordance vanish for exactly the viewers who are allowed to see it.
 * Optional because only the two schedule list selects project it so far.
 */
export interface PersonRef { id?: string; first_name?: string; last_name?: string; phone?: string | null }
// Mirrors scheduleModel's EventType. Service-plan visits are Jobs under the hood, so they
// resolve people through the job branch (assignees / estimate.lead.commission_owner).
// 'calendar-entry' (slice 03, ADR 0002) resolves to no crew and no owner - a calendar entry's
// participants are not crew and are not read here at all; folding them in is a LATER slice's
// decision (§3: "participants are added as a separate field, never folded into crew").
export type ScheduleEventType = 'job' | 'walkthrough' | 'service-plan' | 'calendar-entry';

type UserWrap = { user?: PersonRef | null };

/** Display name for a person, or null when absent / unnamed. */
export function fullName(p: PersonRef | null | undefined): string | null {
  if (!p) return null;
  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return name || null;
}

/**
 * The crew (performers) on an event's PARENT, as display people, in payload order - the people the
 * record can name, which every card of it resolves its own `crew` ids against (eventCrewPeople).
 *
 * For a job that is the server's `assignees` union across its trips. A lead has no such union: its
 * `walkthrough_performers` is the crew of its CURRENT trip only, so since the board draws one card
 * per walkthrough visit (slice 03) the trips' own crews are read too - otherwise the card of a
 * second trip staffed by somebody else could not name them. De-duplicated by id, first seen wins.
 */
export function crewPeopleOf(type: ScheduleEventType, raw: Record<string, unknown>): PersonRef[] {
  if (type === 'calendar-entry') return [];
  if (type !== 'walkthrough') {
    const rows = (raw.assignees as UserWrap[] | undefined) ?? [];
    return rows.map((r) => r.user).filter((u): u is PersonRef => Boolean(u));
  }
  const trips = (raw.walkthrough_visits as { assignees?: VisitCrewRow[] | null }[] | undefined) ?? [];
  const people = [
    ...visitCrewPeopleOf({ assignees: raw.walkthrough_performers as VisitCrewRow[] | undefined }),
    ...trips.flatMap(visitCrewPeopleOf),
  ];
  const seen = new Set<string>();
  return people.filter((p) => {
    if (!p.id) return true;
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/**
 * One crew row as a VISIT carries it: `visits[].assignees[]` on the job list payload. `user_id` is
 * the fallback identity for a row whose `user` relation is absent (an optimistic write carries ids
 * only until the refetch lands).
 */
export interface VisitCrewRow { user_id?: string | null; user?: PersonRef | null }

/**
 * The crew booked on ONE visit, in payload order (visits-and-task-categories slice 02).
 *
 * The board's card for a trip reads its crew from here, never from the parent's job-level
 * `assignees`, which is the UNION across every visit and puts a trip in the lanes of people who
 * are only on a sibling trip.
 */
export function visitCrewPeopleOf(visit: { assignees?: VisitCrewRow[] | null }): PersonRef[] {
  return (visit.assignees ?? []).flatMap((r) => {
    if (r.user) return [r.user.id ? r.user : { ...r.user, id: r.user_id ?? undefined }];
    return r.user_id ? [{ id: r.user_id }] : [];
  });
}

/** The commission owner (off-board). Walkthroughs read lead.commission_owner; jobs reach it via estimate.lead. */
export function ownerOf(type: ScheduleEventType, raw: Record<string, unknown>): PersonRef | null {
  if (type === 'calendar-entry') return null;
  if (type === 'walkthrough') return (raw.commission_owner as PersonRef | null) ?? null;
  const estimate = raw.estimate as { lead?: { commission_owner?: PersonRef | null } } | undefined;
  return estimate?.lead?.commission_owner ?? null;
}

/**
 * The event's crew, keyed by user id, from the event's OWN payload.
 *
 * The one place "resolve a crew id against this record" lives, so the two readers below
 * (`crewNamesOf` here, `crewContactRowsOf` in the event editor) cannot drift on which
 * source wins. Rows whose user carries no id are dropped rather than keyed on `undefined`.
 */
export function crewPeopleById(type: ScheduleEventType, raw: Record<string, unknown>): Map<string, PersonRef> {
  return new Map(crewPeopleOf(type, raw).flatMap((p) => (p.id ? [[p.id, p] as const] : [])));
}

/**
 * The people on THIS CARD, in its crew order: the event's own `crew` ids, named from its payload
 * (slice 02). For a job's trip card `crew` is that trip's crew, so this never lists a person who is
 * only on a sibling trip, which the payload's job-level `assignees` union would. A crew id the
 * payload cannot name is left out rather than printed as a blank.
 */
export function eventCrewPeople(event: {
  type: ScheduleEventType;
  raw: Record<string, unknown>;
  crew: readonly string[];
}): PersonRef[] {
  const byId = crewPeopleById(event.type, event.raw ?? {});
  return event.crew.flatMap((id) => {
    const person = byId.get(id);
    return person ? [person] : [];
  });
}

/** The minimum a roster row has to offer to serve as a name fallback. */
export interface RosterName { id: string; first_name: string; last_name: string }

/**
 * Display names for a crew, PAYLOAD FIRST and the roster only as a fallback.
 *
 * The roster (`GET /api/users/assignable`) answers "who may I ADD" and is gated on the
 * `assign User` grant. Resolving crew ids through it alone printed "No crew" over a crew
 * that plainly exists, for exactly the viewer who owns the record but may not change its
 * crew - the product ruling is the reverse: the names of people ALREADY ON a record are
 * never gated, because they come from the record, which the viewer owns.
 *
 * The roster half is still consulted for payloads that carry no crew relation at all (a
 * ghost minted from a bucket card that predates the `assignees` projection), and stays
 * org-wide at the call site so a department filter cannot blank a name out.
 */
export function crewNamesOf(
  type: ScheduleEventType,
  raw: Record<string, unknown>,
  crewIds: string[],
  roster: readonly RosterName[],
): string {
  const byId = crewPeopleById(type, raw);
  return crewIds
    .map((id) => {
      const fromPayload = fullName(byId.get(id));
      if (fromPayload) return fromPayload;
      const m = roster.find((u) => u.id === id);
      return m ? fullName(m) : null;
    })
    .filter((n): n is string => Boolean(n))
    .join(', ');
}
