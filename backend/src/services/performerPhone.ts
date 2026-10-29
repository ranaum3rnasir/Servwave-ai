/**
 * Performer phone (spec md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md).
 *
 * A confirmation email can already name who is coming. This is what lets it give the customer a
 * way to reach them, so somebody running fifteen minutes late calls the person on the road rather
 * than the front desk, who then have to find them.
 *
 * NO SCHEMA WORK AND NO NEW CAPTURE. `User.phone` and `User.phone_ext` already exist, are already
 * written through `lib/user-phone.ts` at every door, and are already editable in Settings and in
 * My Profile. What was missing was a way to render them, which is this module plus two catalog
 * entries plus two lines in each arm of the automation context.
 *
 * ── THE FALLBACK IS THE WHOLE THING (D7) ────────────────────────────────────────────────────
 *
 * Nobody is obliged to have a number on file, and most organisations adopting this have several
 * people who do not. Both of the usual guards are wrong:
 *
 *   - `?? ''` renders "Questions? Call ." - broken copy that has already been sent to somebody.
 *   - `undefined` renders `{{lead.performer_phones}}` VERBATIM, because `renderMergeFields`
 *     deliberately leaves an unknown field literal so a typo in a template stays visible.
 *
 * So both fields fall back to the organisation's main line - the same value `{{org.phone}}`
 * renders - and the main line falls back to a phrase. `technician.names` answering 'Our team' for
 * a crewless trip is the precedent this follows: name the thing generically rather than render a
 * hole. `formatVisitLocation`'s `SERVICE_ADDRESS_FALLBACK` is the same decision one field over.
 *
 * SOME OF THE CREW LACKING A NUMBER IS NOT THE FALLBACK CASE. The fallback is for NOBODY having
 * one. A trip where one of two people is reachable renders that one number, because sending the
 * customer to the front desk when somebody on the trip can be reached directly is the exact
 * failure this field exists to remove.
 */
import { prisma } from '../lib/prisma';
import { formatPhoneDisplay } from '../lib/phone-format';

/**
 * The last resort, and it is a phrase rather than a blank.
 *
 * Reached when the organisation has no main line on file either - `Organization.phone` is
 * nullable free text, so '' is a reachable state and it is the state every organisation is in
 * before somebody fills the field in. `{{org.phone}}` itself renders '' for such an org today;
 * these two fields cannot, because D7 binds them.
 *
 * The wording is doing a job. It has to read after "Call" and after "Call us at", so it is a noun
 * phrase and not a sentence; it has to fabricate nothing, so it names something the organisation
 * self-evidently has rather than inventing a number or pointing at a channel the email may not
 * have ("reply to this message" is false in an SMS step); and it has to read as a prompt to use
 * whatever contact route the customer already has rather than as an answer they can act on.
 * Lower case because it lands mid-sentence - "Questions? Call our office." - where 'Our team''s
 * capital is right for a field that usually STARTS one ("{{technician.names}} will be there.").
 */
export const MAIN_LINE_FALLBACK = 'our office';

/**
 * The shape `formatPerformerPhones` reads off one person - structural, so any select carrying
 * these two satisfies it.
 *
 * BOTH PROPERTIES ARE REQUIRED, and that is the point. Optional, a caller whose select forgot
 * `phone_ext` compiles, renders a number with no extension, and is indistinguishable from a
 * person who genuinely has none - a silent degradation that reaches the customer as a call to a
 * switchboard that cannot put them through. Same argument `RecipientUser.phone` records for
 * itself one module over.
 *
 * REQUIRED IS NOT THE SAME AS ENFORCED, and which one you get is decided per read, by what the
 * read's rows are CONSUMED as. Four of this feature's five crew reads are held by the compiler,
 * because each one's result is assigned into a shape that demands both columns: `validateCrew`'s
 * rows become `CrewMember`, the en-route read's become the declared `VisitCrewMember | null` on
 * its context object, and context.ts's two arms become `VisitPerson`. Drop
 * `...performerPhoneSelect` from any of those four and `tsc` goes red.
 *
 * THE FIFTH IS NOT. job.controller.ts's PATCH-reschedule pre-read reaches `formatPerformerPhones`
 * through a type predicate (`(u): u is VisitCrewMember`), and a predicate is a CAST, not a check
 * - it accepts a row carrying the two names and nothing else. Dropping the columns there compiles
 * clean, passes the suites that only read the rendered string, and silently hands the customer
 * the front desk on a move that did not re-crew the trip. That read is held instead by an
 * assertion on its `select` in `job-visit-location.test.ts`. A SIXTH read gets one of the two:
 * assign its rows into a shape that demands the pair, or pin the select in a test.
 */
export type PerformerPhoneRow = { phone: string | null; phone_ext: string | null };

/**
 * The `select` a caller needs for `formatPerformerPhones` to answer, exported so every reader of
 * this feature asks for the same pair rather than each writing out two columns and hoping.
 */
export const performerPhoneSelect = { phone: true, phone_ext: true } as const;

/**
 * Every person on the visit who can actually be reached, or the main line.
 *
 * `orgPhone` is passed IN rather than read here, for the reason `formatVisitLocation` takes the
 * service address as an argument: the fallback has to be the SAME string the email renders under
 * `{{org.phone}}`, and a second reading of the column would be free to drift from it inside one
 * message.
 *
 * A number and its extension are ONE contact, not two numbers: "(555) 010-0142 ext. 214" is one
 * way of reaching one person, and rendering the extension as a second comma-separated value would
 * have the customer dial it on its own. An extension with no number in front of it is dropped
 * entirely - it dials nothing, so it is not a contact and it does not suppress the fallback.
 *
 * Display, not storage: `User.phone` is stored E.164 by `userPhoneField`, and "+15550100142" in a
 * customer's inbox is a leak of the column rather than a phone number. `formatPhoneDisplay` is
 * the formatter every other customer-facing surface in the backend already renders through, and
 * it passes anything it cannot parse back unchanged rather than blanking it.
 */
export function formatPerformerPhones(crew: PerformerPhoneRow[], orgPhone: string): string {
  const contacts: string[] = [];
  for (const person of crew) {
    // `.trim()` after formatting, not before: formatPhoneDisplay returns a whitespace-only value
    // unchanged (no digits to work with), and '   ' is a hole by any other name.
    const number = formatPhoneDisplay(person.phone).trim();
    if (!number) continue;
    const ext = person.phone_ext?.trim();
    const contact = ext ? `${number} ext. ${ext}` : number;
    // Two people behind one switchboard with no extensions are one contact. Two people behind it
    // with different extensions are two, and stay two.
    if (!contacts.includes(contact)) contacts.push(contact);
  }
  if (contacts.length > 0) return contacts.join(', ');
  return mainLineOrTheOffice(orgPhone);
}

/**
 * The last two rungs of D7's chain, which BOTH phone fields end on.
 *
 * Written once rather than twice because the two fields are alternatives an author picks between,
 * and an organisation whose template prints one of them and whose reminder prints the other must
 * not read as two different companies. Factored out when the ServWave pair landed beside the
 * personal one; before that it was the tail of `formatPerformerPhones` alone.
 */
function mainLineOrTheOffice(orgPhone: string): string {
  // '' when the organisation has no number on file, NOT MAIN_LINE_FALLBACK. Since 2026-09-15 the
  // phrase is the seeded default for all five phone merge fields
  // (`automations/mergeFieldFallbacks.ts`) and the RENDERER applies it, so that the step's "If
  // empty, fill with" box is a control the author can use instead of one this function had
  // already pre-empted. The customer reads the same words. Every caller builds an automation
  // merge field, so nothing lost a phrase in the move.
  //
  // The name is kept: the rung it describes is still the last one, and "or the office" is still
  // what happens - one layer further out.
  return orgPhone.trim();
}

/**
 * The organisation's main line, for the dispatch sites that build a per-visit merge-field
 * override outside the automation context loader.
 *
 * Same contract as `getOrgTimezone` / `getOrgCurrency`, deliberately: these are called from
 * fire-and-forget post-commit paths, so a missing org, a null column or a database hiccup
 * resolves to "nothing on file" rather than turning a booking that already landed into a 500.
 * '' is the honest answer for all three, and the renderer turns it into the phrase off the step's
 * own fallback map.
 */
export async function getOrgMainLine(organizationId: string): Promise<string> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { phone: true },
    });
    return org?.phone ?? '';
  } catch {
    return '';
  }
}

/* ───────────────────────────────────────────────────────────────────────────────────────────────
 * THE ORGANISATION'S OWN NUMBER FOR THE SAME PEOPLE (slice 7).
 *
 * Slice:
 * md_files/issues/scheduling/07-let-the-author-choose-the-servwave-number-instead-of-the-personal-one.md
 *
 * Everything above renders the person's OWN number - `User.phone`, the one they typed into My
 * Profile, which for a lot of organisations is a personal mobile. Publishing that to every customer
 * on every confirmation is a decision an organisation has to be able to decline WITHOUT giving up
 * the capability, so this is a second field rather than a change to the first: the template says
 * which of the two this organisation is willing to print, and the author picks per automation.
 *
 * WHY IT LIVES IN THIS FILE rather than a sibling module. The two resolvers share more than a
 * subject: rungs 3 and 4 of this chain ARE `formatPerformerPhones`'s fallback, now spelled once as
 * `mainLineOrTheOffice`. And the question a maintainer actually arrives with - "which number does
 * each of these two fields put in front of a customer, and what happens when it is missing" - is
 * one question about two things. Two files would answer half of it each, and the half that drifts
 * is the one nobody reads. The one thing that would justify splitting is a third caller needing
 * only one of them; nothing does.
 *
 * THE NUMBER IS NOT A SECOND READING OF THE OUTBOUND CALLER ID.
 * `lib/communication/resolveOutboundNumber.ts` walks the same first two rungs and is deliberately
 * NOT reused: it answers with a vendor id for PLACING a call, requires that id to be present, and
 * carries a legacy fourth rung (the org's oldest active number) that exists to preserve
 * pre-mapping dialling behaviour. None of that is right for a string in an email - a number the
 * organisation never chose to publish is worse than the fallback - so this mirrors its SEMANTICS
 * and not its code. When the precedence rules change, both have to move together.
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The two columns a number is RENDERED from, exported so every reader of this feature asks for the
 * same pair rather than each writing them out and hoping.
 *
 * `formatted` is the display form the product already stores; `e164` is the storage form and the
 * only one guaranteed present. Neither is the vendor's identifier, and `PhoneNumber.source`
 * ('ctm' | 'byo') is deliberately absent: it is how the row was acquired, it is never rendered,
 * and it is never a distinction an author is shown.
 */
export const servWaveNumberSelect = { e164: true, formatted: true } as const;

export type ServWaveNumberRow = { e164: string; formatted: string | null };

/**
 * One organisation-owned number, rendered for a human.
 *
 * `formatted` first because it is what the organisation's own screens show, so the email and the
 * app agree; `e164` through `formatPhoneDisplay` when it is absent or blank, because "+15552040701"
 * in a customer's inbox is a leak of the column rather than a phone number. A row that yields
 * neither is not a contact and is dropped - it would otherwise suppress the fallback while
 * rendering a hole, which is the one outcome D7 forbids outright.
 */
function formatServWaveNumber(number: ServWaveNumberRow): string {
  const shown = number.formatted?.trim();
  if (shown) return shown;
  return formatPhoneDisplay(number.e164).trim();
}

/**
 * The organisation-owned number for every person on the visit, or the chain below it.
 *
 * D7's four rungs, in order:
 *   1. the person's own default assignment - `UserPhoneNumber.is_default`
 *   2. the organisation's default number   - `PhoneNumber.is_org_default`
 *   3. the organisation's main line        - `Organization.phone`, what `{{org.phone}}` renders
 *   4. `MAIN_LINE_FALLBACK`                - a phrase, never a blank and never the bare token.
 *                                          Applied by the RENDERER since 2026-09-15, off the
 *                                          step's own fallback map, not by this module.
 *
 * RUNG 1 NEVER FALLS THROUGH TO THE PERSON'S PERSONAL NUMBER, AND THAT IS THE POINT. An author who
 * chose this field over `performer_phones` chose not to publish mobiles; quietly substituting one
 * for whoever happens to have no assignment would hand the customer exactly the number the choice
 * was meant to withhold - silently, and only for some of the crew. Degrading to an
 * organisation-owned number is the correct failure.
 *
 * SOME OF THE CREW LACKING AN ASSIGNMENT IS NOT THE FALLBACK CASE, exactly as for the personal
 * field: the ones that resolve are rendered, and rung 2 is reached only when NOBODY on the trip
 * has one. That is also why the org-default read is issued only then - the rungs are ordered, and
 * a read that ran unconditionally is one line away from rendering the fallback beside the number
 * of the person actually going.
 *
 * NO EXTENSION. An extension belongs to `User.phone_ext` and describes the switchboard behind the
 * PERSONAL number; borrowing it here would print a routing code that does not exist on this line.
 *
 * TENANT SCOPE IS ON BOTH SIDES OF THE JOIN. The number must belong to this organisation or a
 * crafted crew leaks another organisation's line into an email; the PERSON must too, because
 * `UserPhoneNumber` carries no organisation of its own and "their own organisation" is what the
 * slice asks for. Both clauses are cheap and neither is redundant with the other.
 *
 * `orgPhone` is passed IN rather than read here for the reason `formatPerformerPhones` takes it:
 * rung 3 has to be the SAME string the email renders under `{{org.phone}}`, and a second reading
 * of the column would be free to drift from it inside one message.
 *
 * NEVER THROWS. Every dispatch site that calls this does so post-commit and fire-and-forget, on a
 * booking or a milestone that has already landed, so a database hiccup here would turn a
 * merge-field lookup into a 500 on a request that already succeeded. Same contract
 * `getOrgMainLine` records above; the honest answer to "I could not read it" is the bottom of the
 * chain, not an exception.
 */
export async function resolveServWavePhones(
  organizationId: string,
  userIds: string[],
  orgPhone: string,
): Promise<string> {
  try {
    // Skipped outright for a crewless trip: `user_id: { in: [] }` matches nothing, so the read
    // would be a round trip whose answer is already known.
    if (userIds.length > 0) {
      const links = await prisma.userPhoneNumber.findMany({
        where: {
          is_default: true,
          user_id: { in: userIds },
          user: { organization_id: organizationId },
          phone_number: { organization_id: organizationId, status: 'active' },
        },
        select: { user_id: true, phone_number: { select: servWaveNumberSelect } },
      });
      // ORDERED BY THE CREW, not by the read. The read issues no `orderBy` and Postgres promises
      // nothing without one, while the NAMES beside these numbers are built from `userIds` - so a
      // straight walk of the rows prints a two-person crew's numbers against the wrong people.
      //
      // GROUPED, not keyed. The app enforces at most one default per user, so each group is
      // normally one row and this reads as "their number". A `Map` keyed on user_id would be the
      // shorter way to say that, and it is the wrong one: handed two rows for one person it keeps
      // whichever arrived last, so a broken invariant - or a where-clause that stopped asking for
      // `is_default` - renders ONE arbitrary number, and a different one between sends. Rendering
      // both is a visible data bug; picking one at random is an invisible one.
      const byUser = new Map<string, ServWaveNumberRow[]>();
      for (const link of links) {
        const group = byUser.get(link.user_id);
        if (group) group.push(link.phone_number);
        else byUser.set(link.user_id, [link.phone_number]);
      }
      const contacts: string[] = [];
      for (const userId of userIds) {
        for (const number of byUser.get(userId) ?? []) {
          const contact = formatServWaveNumber(number);
          // Two people sharing one departmental number are ONE contact - the same rule the
          // personal field applies to a shared switchboard.
          if (contact && !contacts.includes(contact)) contacts.push(contact);
        }
      }
      if (contacts.length > 0) return contacts.join(', ');
    }

    // Rung 2. The app enforces at most one `is_org_default` per organisation, so `findFirst` is
    // the whole answer rather than the first of several.
    const orgDefault = await prisma.phoneNumber.findFirst({
      where: { organization_id: organizationId, status: 'active', is_org_default: true },
      select: servWaveNumberSelect,
    });
    const fallbackNumber = orgDefault ? formatServWaveNumber(orgDefault) : '';
    if (fallbackNumber) return fallbackNumber;
  } catch {
    // Deliberately falls through to the last two rungs rather than rethrowing - see NEVER THROWS.
  }

  return mainLineOrTheOffice(orgPhone);
}
