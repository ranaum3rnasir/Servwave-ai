/**
 * Per-visit location (spec md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md).
 *
 * A visit carries its own location so a walkthrough can be held at the showroom rather than at
 * the customer's house. THREE STATES, DERIVED from which columns are set, never stored as a mode
 * (D3): `location_id` set means one of the organisation's own Locations; `location_address_line1`
 * set means the one-off address frozen on the visit; both null means the parent's service
 * address, which is what every visit written before this feature means.
 *
 * This module owns all three halves so every booking door adds a DOOR rather than a second copy
 * of the rules:
 *
 *   1. `visitLocationSchema` - the wire shape, and the refusals that are schema-level.
 *   2. `resolveVisitLocationWrite` - the tenant check (D8) plus the column patch.
 *   3. `formatVisitLocation` - the merge-field resolution, which must never produce an empty
 *      string (D7).
 *
 * ── WHAT THE SECOND CALLER PROVED (slice 3) ───────────────────────────────────────────────────
 *
 * Slice 1 factored this against ONE caller, `POST /leads/:id/walkthrough/schedule`, which is a
 * guess at where the seam is. `POST /leads/:id/visits` is the second, and it is the opposite kind
 * of door - a CREATE that never touches an existing row, where the first is an upsert that
 * collapses onto one. Nothing had to be reshaped for it: it names `visitLocationField` in its
 * schema, calls `resolveVisitLocationWrite(req, location, { currentLocationId: null })`, and hands
 * the patch to its own writer. The `currentLocationId` argument is what carried the weight - being
 * REQUIRED, it made the new door state out loud that a create stands nowhere yet, which is exactly
 * the answer that keeps slice 2's archived-location refusal in force at a door written after it.
 *
 * What the two doors still hold separately is four lines of Express: read `location` off the body,
 * call this, and turn a refusal into `res.status(...).json(...)`. That stays theirs deliberately.
 * Folding it in would mean handing a `Response` to a service whose whole job is to be callable
 * without one - by the job doors, by a test at this seam, by anything that is not a controller -
 * and would trade a duplicated `if` for a module that can only be used one way.
 */
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';

// ─── 1. The wire shape ─────────────────────────────────────────────────────

/**
 * One of the two OPTIONAL parts of a one-off address: trimmed like its three required siblings,
 * and then BLANK COLLAPSED TO `null` rather than left as ''.
 *
 * The trim on its own fixed the larger half of this and left the smaller half standing. `zip:
 * '   '` trims to '', '' is not caught by `input.zip ?? null` on the write path, and '' reaches
 * the column - so of the six location columns it was the one "nothing" that was not NULL. No
 * rendered copy shows it (`formatVisitLocation` filters falsy parts, so the broken sentence D7
 * forbids was never reachable from here), but `projectVisitLocation` hands it straight back into
 * the booking form's ZIP field, and it is what a static map would put in a query string. It is
 * fixed on exactly the argument the trim was made on: five fields on one address must not obey
 * two different rules, and "blank means nothing" is that rule stated the same way for all five -
 * the three required ones refuse it, the two optional ones store nothing.
 *
 * `undefined` is deliberately preserved as `undefined` rather than folded into `null`. That is
 * the key the caller never sent, and minting a `null` for it would make the wire shape state both
 * optional fields on every body - and would make the key REQUIRED in the inferred type, which is
 * a different claim about the shape than the one this field makes.
 *
 * `.max()` still measures the TRIMMED string, and `.min(1)` is still what is not added: a one-off
 * with no unit and no postcode remains the ordinary case.
 */
const optionalAddressPart = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

/**
 * A one-off address: the same five structured fields every other address in this product uses,
 * with the same three required (D4). `locationSchema` in lead.controller.ts is the address the
 * lead form already validates and this mirrors its required set - line 1, city and state - so a
 * half-typed address cannot reach a column.
 *
 * `zip` is optional here where the lead form requires it, and that is deliberate rather than
 * sloppy: a lead's service address anchors a `ServiceLocation` row whose `zip` is NOT NULL, and
 * this one anchors nothing. Requiring it would refuse a perfectly renderable "Suite 4, 12 Harbor
 * St, Asheville, NC" typed for a supplier's premises.
 *
 * TRIMMED BEFORE `.min(1)`, IN THAT ORDER, and it is the order that does the work: `.min(1)` on
 * its own accepts '   ', which reaches a column and renders "Please meet us at    , Asheville, NC"
 * in a customer's inbox. `validate` assigns the parse RESULT back onto `req.body`, so the trimmed
 * string is also the one that gets stored - the check and the write cannot disagree. The control
 * that feeds this door already refuses a blank-after-trim address (`isVisitLocationComplete`);
 * a schema laxer than its own UI is the wrong way round.
 *
 * ALL FIVE NORMALISE, INCLUDING THE TWO OPTIONAL ONES (slice 3) - see `optionalAddressPart` for
 * what the two optional ones do beyond trimming. `address_line2` and `zip` carried no `.trim()`
 * while their three required siblings did, so `zip: '   '` was stored as three spaces. Neither
 * reaches `formatVisitLocation`, so neither could produce the broken sentence above - what they
 * reach is the static map's query string and the booking form that seeds itself back off the row.
 * That makes it a smaller bug than the one the three required fields had, and it is fixed here
 * anyway rather than left: five fields on one address obeying two different rules is a shape the
 * next person to add a field has to guess at, and the guess that reads as normal is the wrong
 * one. Normalising does NOT make either required - `.min(1)` is exactly what is not added, so a
 * one-off with no unit and no postcode is still the ordinary case it has always been.
 *
 * `state` is capped at TWO characters, agreeing with the field that enters it (`maxLength={2}`)
 * and with `locationSchema`'s `state` on the lead form, so the same abbreviation is the only thing
 * either door accepts. It is NOT sized against `Location.state`: that column is the organisation's
 * own locations table, a different shape with a different picker, and pointing at it argued for a
 * fifty-character state nothing in this product can render beside a service address.
 */
const oneOffAddressSchema = z
  .object({
    address_line1: z.string().trim().min(1).max(200),
    address_line2: optionalAddressPart(200),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(2),
    zip: optionalAddressPart(20),
  })
  .strict();

const companyLocationSchema = z.object({ location_id: z.string().uuid() }).strict();

/**
 * Either a saved location or a one-off address, and REFUSING BOTH AT ONCE IS THIS SCHEMA'S JOB.
 *
 * A union of two `.strict()` objects gets that for free and gets it at the right layer: a body
 * carrying `location_id` AND `address_line1` matches neither branch, so it is a 400 from the
 * validate middleware rather than something the handler discovers when Postgres raises
 * `visits_location_not_both` and the generic catch turns it into an opaque 500. The DB CHECK
 * stays as the backstop it is meant to be, not as the enforcement.
 *
 * The same union is what refuses a half-typed address: `{ address_line1, state }` fails the
 * one-off branch on the missing `city` and fails the saved-location branch on the unknown key.
 */
export const visitLocationSchema = z.union([companyLocationSchema, oneOffAddressSchema]);

/**
 * The field as it appears on a booking body.
 *
 * THREE-STATE, and every one of them is load-bearing (see `resolveVisitLocationWrite`):
 * omitted leaves the stored location alone, `null` clears it back to the service address, and a
 * value sets it. The reschedule doors in this codebase already distinguish these three, and the
 * distinction matters more here than it does for a scalar: a caller moving only the time must not
 * silently reset a showroom meeting back to the customer's address.
 */
export const visitLocationField = visitLocationSchema.nullable().optional();

export type VisitLocationInput = z.infer<typeof visitLocationSchema>;

// ─── 2. The write path ─────────────────────────────────────────────────────

/** The six columns, as a Prisma data patch. An empty object means "change nothing". */
export type VisitLocationPatch = {
  location_id?: string | null;
  location_address_line1?: string | null;
  location_address_line2?: string | null;
  location_city?: string | null;
  location_state?: string | null;
  location_zip?: string | null;
};

/** Every location column back to null - the service address, and the state a cleared visit is in. */
const CLEARED: VisitLocationPatch = {
  location_id: null,
  location_address_line1: null,
  location_address_line2: null,
  location_city: null,
  location_state: null,
  location_zip: null,
};

/**
 * ONE message for "no such location in your organisation" and for "no such location anywhere",
 * because they must be indistinguishable.
 *
 * D8: a 404 naming a specific id, or a different message for the two cases, would make this door
 * an oracle for whether an id exists in somebody else's organisation. `validatePerformers` states
 * the same rule one module over with 'Performer not found or inactive'. It is a 400 rather than a
 * 404 for the same reason that one is: the id is a value INSIDE the body, so what is wrong is the
 * request, not the address of the resource.
 */
export const LOCATION_NOT_FOUND = 'Location not found';

export type VisitLocationResolution =
  | { ok: true; data: VisitLocationPatch }
  | { ok: false; status: number; error: string };

/**
 * Turn the validated `location` field into the columns to write, tenant-checking a saved location
 * on the way (D8).
 *
 * The tenant check is a read the caller cannot skip: without it a crafted `location_id` puts
 * another organisation's address into a customer's email, which is the whole reason this is a
 * check and not a bare foreign key - the FK constrains the id to a real location, not to a
 * location in the writer's own organisation.
 *
 * Whichever state is chosen, the OTHER state's columns are explicitly nulled rather than left
 * alone. Merging a one-off address onto a visit that already pointed at the showroom would leave
 * both set and hit `visits_location_not_both`; leaving a stale city behind a newly-picked
 * location would leave the row carrying an address nothing reads.
 *
 * THIS IS THE ONE PLACE THE ACTIVE FILTER LIVES ON THE WRITE SIDE (D9, slice 2). Hiding an
 * archived location in the dropdown is a courtesy: a tab opened before the yard closed still holds
 * it in its options, and a crafted body never opened a dropdown at all. Every booking door in this
 * feature funnels through here, so the refusal is stated once and no later slice can add a door
 * that forgets it.
 *
 * `currentLocationId` is the one exception, and without it archiving would be quietly destructive.
 * The booking form STATES a location on every save, so an admin nudging a closed-branch meeting by
 * an hour would post the archived id and get a 400 with no way through - and D9's own note is
 * explicit that a visit's own location stays editable for the life of the visit. So a visit
 * standing at that location may stay there; it just cannot be MOVED to one, and nothing else can
 * be moved to it either.
 *
 * IT IS A REQUIRED PROPERTY, NOT AN OPTIONAL ONE, and that is the whole point of the third
 * argument. Optional, it defaults to "this is a fresh booking" - which is the safe answer for the
 * refusal and the WRONG one for a reschedule, so the next door to gain a location
 * (`POST /jobs/:id/visits` and `PATCH /jobs/:id/visits/:visitId`) would inherit the archived-
 * location refusal for free and a broken reschedule for free with it: a job visit standing at a
 * since-archived location would 400 on every save until somebody remembered to thread this
 * through. Required, TypeScript makes each new caller state its answer out loud - `null` for a
 * create, the stored id for an update. A compile error at the job doors is worth more than a
 * comment nobody reads.
 *
 * The second caller has since landed and it went the way this paragraph predicted: `POST
 * /leads/:id/visits` (slice 3) is a pure CREATE, it was made to answer `null`, and slice 2's
 * refusal reached a door written after it with nothing restated at that door.
 */
export async function resolveVisitLocationWrite(
  req: Request,
  input: VisitLocationInput | null | undefined,
  opts: {
    /**
     * The location this visit already points at. `null` when the write CREATES a visit - there is
     * no location it is standing at yet - and the visit's stored `location_id` when the write
     * updates one. Never omitted: see the paragraph above.
     */
    currentLocationId: string | null;
  },
): Promise<VisitLocationResolution> {
  // Omitted. Not "no location" - "do not touch the location".
  if (input === undefined) return { ok: true, data: {} };
  // Explicitly cleared: back to the parent's service address.
  if (input === null) return { ok: true, data: { ...CLEARED } };

  if ('location_id' in input) {
    const stayingPut = Boolean(opts.currentLocationId) && input.location_id === opts.currentLocationId;
    const location = await prisma.location.findFirst({
      where: {
        id: input.location_id,
        ...tenantWhere(req),
        ...(stayingPut ? {} : { is_active: true }),
      },
      select: { id: true },
    });
    // An archived location answers exactly as a foreign or a nonexistent one does. Saying "that
    // location is archived" would make this door an oracle for a row the caller may not see, and
    // the caller who legitimately hits this is a stale tab whose only correct move is to re-pick.
    if (!location) return { ok: false, status: 400, error: LOCATION_NOT_FOUND };
    return { ok: true, data: { ...CLEARED, location_id: location.id } };
  }

  // `?? null` is for the key the caller omitted, and that is ALL it is for - it does not catch
  // '', which is why blank is collapsed in `optionalAddressPart` at the schema instead of here.
  // Stating the rule once, on the shape every door validates against, is what keeps the six
  // columns' idea of "nothing" identical; a second copy at this seam would be free to drift.
  return {
    ok: true,
    data: {
      ...CLEARED,
      location_address_line1: input.address_line1,
      location_address_line2: input.address_line2 ?? null,
      location_city: input.city,
      location_state: input.state,
      location_zip: input.zip ?? null,
    },
  };
}

// ─── 3. The read path ──────────────────────────────────────────────────────

/**
 * The six columns ALONE - which CANNOT produce a label, and is why this is private.
 *
 * A visit pointing at one of the organisation's own locations carries only the id; the name and
 * the street live on the `Location` row. So a select stopping here resolves a showroom booking to
 * `null` - "this trip is at the customer's service address" - which is not a missing answer but a
 * WRONG one, and one that reads exactly like the common case.
 *
 * It existed as an exported `visitLocationColumnsSelect` with no caller outside this file: an
 * invitingly-named, insufficient select sitting beside the sufficient one is how the next reader
 * reintroduces that bug. Unexported and renamed to say what it is missing. `visitLocationSelect`,
 * below, is the one every caller spreads.
 */
const locationColumnsWithoutTheRelation = {
  location_id: true,
  location_address_line1: true,
  location_address_line2: true,
  location_city: true,
  location_state: true,
  location_zip: true,
} as const;

/**
 * The `select` a caller needs for `formatVisitLocation` to answer. Exported so the automation
 * context and every later reader ask for the same set rather than each writing out six columns
 * and hoping they match.
 *
 * The relation, not a copy: D2's whole point is that correcting the showroom's address in
 * Settings changes what an unsent reminder renders, with no write to the visit. It is also the
 * DISCRIMINATOR both label projections read - see `projectJobVisitLocations` - so a select that
 * spreads this is exactly a select entitled to state where a trip is.
 */
export const visitLocationSelect = {
  ...locationColumnsWithoutTheRelation,
  location: { select: { name: true, address_line1: true, city: true, state: true } },
} as const;

/** The shape `formatVisitLocation` reads - structural, so any select carrying these satisfies it. */
export type VisitLocationRow = {
  location_id?: string | null;
  location_address_line1?: string | null;
  location_city?: string | null;
  location_state?: string | null;
  location?: { name: string; address_line1: string | null; city: string | null; state: string | null } | null;
};

/**
 * The last resort, and it is a phrase rather than a blank (D7).
 *
 * Reached only by a parent that has no service address on file at all - `Lead.service_location_id`
 * is nullable, so `lead.address` genuinely resolves to '' for such a record today. Both of the
 * usual guards are wrong here: an undefined resolution prints `{{lead.walkthrough_location}}`
 * verbatim in the customer's inbox, because `renderMergeFields` deliberately leaves an UNKNOWN
 * field literal so typos stay visible, and `?? ''` gives "Please meet us at ." - broken copy that
 * has already been sent. `technician.names` falling back to 'Our team' is the precedent: name the
 * thing generically rather than render a hole.
 *
 * The wording is doing a job. "the service address" reads back as a self-referential non-answer -
 * "Please meet us at the service address." tells a customer nothing in an email that, by
 * definition, has no address to state. Naming it as something the ORGANISATION holds rather than
 * as a field on a record - "Please meet us at the address we have on file for you." - is honest
 * about what is known, fabricates nothing, and reads as a prompt to call and check rather than as
 * an answer the customer is meant to act on.
 */
export const SERVICE_ADDRESS_FALLBACK = 'the address we have on file for you';
/*
 * WHERE THIS PHRASE IS APPLIED CHANGED ON 2026-09-15, THE WORDING DID NOT.
 *
 * It is no longer substituted here. It is the seeded default for all four address merge fields in
 * `automations/mergeFieldFallbacks.ts`, and the renderer applies it when the field resolves ''.
 * The customer reads exactly the same sentence; the difference is that the step's "If empty, fill
 * with" box is now a control the author can actually use, where before this function had already
 * filled the slot and the box could never fire. Every caller of `formatVisitLocation` builds an
 * automation merge field - all five of them - so nothing lost a phrase in the move.
 *
 * D7 IS NOT WEAKENED, IT MOVED. "A declared merge field must never render a hole" is now held
 * where the words are: `context.emptyMergeFields.test.ts` renders every advertised field of every
 * trigger through the default fallback set and refuses an empty one. A field added without a
 * fallback fails there rather than in somebody's inbox.
 */

/**
 * The visit's location, formatted the way `lead.address` / `job.address` format a service address
 * - same field order, same separator - so the two are indistinguishable in an email body.
 *
 * `serviceAddress` is the string the parent's own address field already resolves to, passed in
 * rather than re-derived: the fallback has to be the SAME string, and re-deriving it here would
 * be a second implementation free to drift from the one the customer sees under
 * `{{lead.address}}` in the very same email.
 *
 * A saved location leads with its NAME, and that is the one deliberate difference from a service
 * address: "Showroom, 12 Harbor St, Asheville, NC" tells the customer which of the organisation's
 * places to drive to, which a bare street address does not. A location with a real name and no
 * address at all still renders as just that name, which is non-empty and honest.
 *
 * EVERY BRANCH IS CHECKED FOR BLANK AFTER TRIMMING - see `formatVisitOwnLocation`, which is where
 * that check now lives and which this is defined in terms of.
 */
export function formatVisitLocation(
  visit: VisitLocationRow | null | undefined,
  serviceAddress: string,
): string {
  // '' when nothing is known, NOT the phrase - the step's fallback owns that slot now. See the
  // note beside SERVICE_ADDRESS_FALLBACK above.
  return formatVisitOwnLocation(visit) ?? serviceAddress.trim();
}

/**
 * The visit's OWN location, rendered - or `null` when it has none that renders, which is the common
 * case and means "the parent's service address, exactly as today".
 *
 * ── WHY THIS IS THE SEAM, AND NOT A SECOND FORMATTER (slice 6) ────────────────────────────────
 *
 * Slice 6 puts the location on the surfaces that READ a visit - the lead's visit cards, the job's
 * visits card, the schedule's visit detail - and those surfaces must show the DIFFERENCE, not the
 * address: a visit at the service address reads exactly as it did before, and one that is not says
 * where it is instead. That is a different question from the merge field's ("what address does this
 * customer's email state"), and answering it needed either a second resolution or this split.
 *
 * A SECOND RESOLUTION IS A SECOND CHANCE FOR THE CARD AND THE EMAIL TO DISAGREE about where a
 * customer is meant to be - and that disagreement is invisible until somebody drives. So the split
 * runs the other way round from the obvious one: this function is the whole of the rendering, and
 * `formatVisitLocation` is now DEFINED as this answer with D7's fallback applied to it. One join,
 * one field order, one blank-check - and the merge field's string for a visit that HAS a location
 * IS this string, by construction rather than by two implementations happening to agree.
 *
 * `null` rather than '' for "nothing of its own", for the reason every other part of this module
 * collapses blank to null: '' is a value that renders as one, and a caller writing `label && ...`
 * would be one falsy-check away from a marked line with nothing in it.
 *
 * A saved location leads with its NAME, and that is the one deliberate difference from a service
 * address: "Showroom, 12 Harbor St, Asheville, NC" tells the reader which of the organisation's
 * places to drive to, which a bare street address does not. A location with a real name and no
 * address at all still renders as just that name, which is non-empty and honest.
 *
 * EVERY BRANCH IS CHECKED FOR BLANK AFTER TRIMMING, and D7 is why it cannot lean on the schemas
 * instead. `createLocationSchema` now refuses a blank name, but a `Location` row written before it
 * did still has one, and a name of ' ' is truthy, joins to ' ', and renders "Please meet us at  .
 * Your service address is ..." in an inbox - verbatim the sentence D7 exists to forbid - and an
 * empty marked line on a card, which is the same defect with a different audience. A formatter that
 * cannot produce a hole from ANY row it is handed is the only version of that guarantee worth
 * having, so a branch that comes out blank falls through rather than returning whitespace.
 */
export function formatVisitOwnLocation(visit: VisitLocationRow | null | undefined): string | null {
  if (!visit) return null;

  /** The parts that carry text, trimmed, in the one order a service address renders in. */
  const join = (...parts: (string | null | undefined)[]) =>
    parts.map((p) => p?.trim()).filter(Boolean).join(', ');

  // The relation is the truth for a saved location. `location_id` set with no relation loaded means
  // the caller's select omitted it, and falling through is the safe way to be wrong: the email
  // renders the service address (a real address in the right format) and the card reports no
  // difference - the same claim made twice rather than two different ones.
  if (visit.location_id && visit.location) {
    const l = visit.location;
    const rendered = join(l.name, l.address_line1, l.city, l.state);
    if (rendered) return rendered;
  }

  if (visit.location_address_line1) {
    const rendered = join(visit.location_address_line1, visit.location_city, visit.location_state);
    if (rendered) return rendered;
  }

  return null;
}

/**
 * The visit's location, READ BACK from the row so the pointer can be followed, formatted over the
 * parent's own address.
 *
 * FOLLOWING THE POINTER IS THE WHOLE OF IT, and it is why a caller holding the row it just wrote
 * still comes through here. A row handed back by `visit.create` / `visit.update` carries
 * `location_id` and no `location` relation, and `formatVisitOwnLocation` handed that falls through
 * to the parent's address - the one wrong answer that reads as correct, because it is a real
 * address in the right format. A pointer needs the row it points at.
 *
 * `serviceAddress` is the string the parent's own address field already resolves to, passed in
 * rather than re-derived, for the reason `formatVisitLocation` documents: the no-location fallback
 * has to be the SAME string the customer reads under {{lead.address}} / {{job.address}} in the
 * very same message.
 *
 * Tenant-scoped, always. The id normally came from the caller's own write, but this is still a
 * read and another organisation's visit must not be reachable through it.
 *
 * ── WHY IT LIVES HERE AND NOT IN A CONTROLLER (#2175) ─────────────────────────────────────────
 *
 * It began as `visitLocationForOccurrence` in job.controller.ts, serving the automation dispatch
 * sites. #2175 gave it a second audience - the BUILT-IN transactional emails, which were still
 * addressing the parent's service location - and a second controller, because the walkthrough
 * notice is sent from lead.controller.ts. Those two emails can fire for one booking (the
 * `notify_customer` tick is deliberately independent of the automation engine), so a customer
 * booked at the showroom could receive one message naming the showroom and another naming their
 * house. A second copy of this read is a second chance for exactly that, so there is one.
 */
export async function loadVisitLocation(
  req: Request,
  visitId: string,
  serviceAddress: string,
): Promise<string> {
  const persisted = await prisma.visit.findFirst({
    where: { id: visitId, ...tenantWhere(req) },
    select: visitLocationSelect,
  });
  return formatVisitLocation(persisted, serviceAddress);
}

/**
 * A job payload's `visits[]`, each row carrying ONE resolved `location_label` in place of the
 * relation that was followed to produce it.
 *
 * The job LIST is what the scheduler board is built from - `jobToEvents` fans one job row into one
 * card per visit - so this is the read shape the board's cards and its visit detail both consume.
 * Written here rather than inline in the controller for the reason the rest of this module exists:
 * `listJobVisits` does the identical thing for the job's own Visits card, and two copies of "follow
 * the pointer, render it, drop the relation" is how the board and the detail page would come to
 * disagree about one trip.
 *
 * THE RELATION IS DROPPED, DELIBERATELY. It is a copy of a Settings row; a client rendering from
 * that copy would keep showing yesterday's address after an admin corrected the typo, which is the
 * one failure D2's pointer exists to prevent. The label is re-resolved on every read instead.
 *
 * Mirrors `projectJobCrewUnion` / `projectJobScheduleFields` in shape and signature so it composes
 * with them on the same loosely-typed payload those two already pass around, and is a no-op for a
 * payload whose select never carried `visits`.
 */
export function projectJobVisitLocations<T extends Record<string, unknown>>(job: T): T {
  const visits = job.visits as (VisitLocationRow & Record<string, unknown>)[] | null | undefined;
  if (!Array.isArray(visits)) return job;
  return {
    ...job,
    visits: visits.map((visit) => {
      // THE NEVER-ASKED GUARD, the same one `locationLabelOf` states on the lead side.
      //
      // `location_label: null` is the claim "this trip is at the parent's service address", and a
      // response is not entitled to make a claim about a column it never read. Without this, the
      // key appeared on every board payload whatever the select asked for - so a test could pin
      // `location_label: null` on a payload built from a select carrying no location at all, and
      // dropping `...visitLocationSelect` from `jobListSelect` would stay green while every board
      // card went back to painting the customer's street on a yard-booked trip.
      //
      // Keyed on the `location` RELATION rather than on `location_id`, because the relation is
      // what the label actually needs: a select carrying the six columns and not the relation can
      // see that a visit points SOMEWHERE and cannot say where, so it must not answer at all.
      if (!('location' in visit)) return visit;
      const { location, ...rest } = visit;
      return { ...rest, location_label: formatVisitOwnLocation({ ...rest, location }) };
    }),
  };
}

/**
 * The visit's location as the BOOKING FORM needs to seed itself: which of the three states the
 * visit is in, and the values behind it. `null` means the service address.
 *
 * This is not slice 6's "show the location on the surfaces that read a visit" - it is the seed
 * without which the form is actively destructive. The control defaults to the service address, so
 * a dialog opened on a showroom booking to change only the time would show "Service address",
 * post it, and send the customer somewhere they have already been told not to go. The API's
 * omitted-means-unchanged rule cannot save a form that states a location explicitly on every
 * save, and a form that hid the control on a reschedule would be worse.
 *
 * Deliberately NOT the location's name or address: the picker already has the organisation's
 * locations loaded and resolves the name from the id, and shipping a second copy of an address
 * whose whole point is that it is a pointer would be the snapshot D2 exists to refuse.
 */
export function projectVisitLocation(visit: VisitLocationRow | null | undefined) {
  if (!visit || !('location_id' in visit)) return undefined;
  const v = visit as VisitLocationRow & {
    location_address_line2?: string | null;
    location_zip?: string | null;
  };
  if (!v.location_id && !v.location_address_line1) return null;
  return {
    location_id: v.location_id ?? null,
    address_line1: v.location_address_line1 ?? null,
    address_line2: v.location_address_line2 ?? null,
    city: v.location_city ?? null,
    state: v.location_state ?? null,
    zip: v.location_zip ?? null,
  };
}
