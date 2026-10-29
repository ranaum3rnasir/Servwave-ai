## Problem Statement

A visit carries no location of its own. Every walkthrough is assumed to happen at the lead's service
address, and every job visit at the job's, because that is the only address either record has. The
schema has no column for "where is this trip actually happening", so there is nothing for the booking
UI to ask and nothing for an automation to render.

For a whole class of trade — anyone with a showroom, a design studio, a yard, a workshop — that
assumption is wrong roughly half the time. The first meeting is at the showroom; the measure is at the
customer's house; a second design review is back at the showroom again. Same lead, same customer,
different places.

The consequence lands in the customer's inbox. An organisation writing a walkthrough confirmation
automation has exactly one address field available to them, and it always resolves to the customer's
own address. So either the confirmation email tells the customer to be somewhere they are not meant to
be, or the organisation leaves the address out entirely and telephones every customer to say where to
come — which is the thing the automation existed to stop.

The workarounds available today are all bad in the same way. An organisation can put its showroom in as
the lead's *service* address, but then the job site is lost and every downstream surface — the job, the
estimate, the technician's route — points at the showroom. It can hard-code the showroom address into
the automation body, but the automation body is static: one automation serves every lead, so
hard-coding sends showroom directions to the customer whose measure is at their house. This is the
crux, and it is why the fix cannot live in the Automation Center: **the value has to vary per visit,
and an automation cannot choose per visit.**

A second, smaller gap sits next to it. Confirmation emails can name who is coming — the walkthrough team
and the assigned technicians are both already merge fields — but cannot give the customer a way to reach
them. The only phone number an automation can render is the organisation's main line, so a customer
running fifteen minutes late calls the front desk, who then have to find the person out on the road.
`User.phone` and `User.phone_ext` already exist and are already editable in Settings; nothing exposes
them to a template.

## Solution

**A visit carries its own location, chosen when the visit is booked, in one of three states.**

- **The service address** — the parent's own address, exactly today's behaviour. This is the default
  and the great majority of visits will never leave it.
- **One of the organisation's own locations** — the showroom, the yard, the second branch. Picked from
  the locations the organisation already maintains in Settings.
- **A one-off address** — captured at booking time for a visit happening somewhere that is neither. It
  is entered through the same address autocomplete every other address in the product uses, into the
  same structured fields, so it maps and reads identically to any other address. It is deliberately
  **not** saved into the organisation's locations list; an address used once should not permanently
  enlarge a picker every colleague sees.

The choice is made in the same dialog that already asks for the date, the time and who is going,
because that is where the office already decides everything else that varies per trip.

**The stored value is a pointer, not a copy.** A visit at a company location holds a foreign key to
that location, not a snapshot of its address. Correct a typo in the showroom's address and tomorrow's
unsent reminder goes out right. The one-off address is the deliberate exception — it is stored on the
visit itself and stays frozen, which is correct, because an ad-hoc address has no record behind it to
stay in step with.

**No new enum.** The three states are derived from which nullable columns are set — the foreign key, or
the address fields. "Not both" is a database CHECK, the same idiom the visit table already uses to
enforce exactly one parent.

**Two new merge fields carry it into automations**, one per side, named for what they actually are
rather than for a generic concept that matches neither: **Walkthrough location** on the lead side,
**Job visit location** on the job side. Both ship together — the column is on the shared visit table, so
shipping one side alone would leave the field picker advertising a walkthrough location with no job
counterpart.

**Nothing else in the Automation Center changes.** No new trigger, no condition, no branch, no step
type. The organisation writing the automation clicks one new chip and drops it in the body, and the
per-visit variability that used to be impossible is now carried by the record. This is the design
principle the feature is an instance of: the Automation Center stays dumb, and the record carries the
answer.

**Two further merge fields give the customer a way to reach the person coming**, resolving from the
existing user phone columns: the walkthrough team's numbers on the lead side, the assigned
technicians' on the job side. Where nobody has a number on file these fall back to the organisation's
main line, never to an empty string.

## Decisions

**D1 — Location lives on the visit, not on the lead, the job, or the automation.** It is the unit that
varies. A lead can have a showroom meeting and a site measure in the same week.

**D2 — Pointer, not copy.** `location_id` is a foreign key. Copying the address at booking time has a
silent failure mode: the address is corrected, and the reminder that has not gone out yet still carries
the old one. The one-off address has no row to point at, so it is stored on the visit and stays frozen.

**D3 — Nullable columns and a CHECK, not an enum.** `location_id` set means a company location;
`location_address_line1` set means the one-off; both null means the service address. A mode enum would
be a third source of truth that can disagree with the columns it describes. The CHECK mirrors
`visits_exactly_one_parent`, which the same table already carries for `lead_id`/`job_id`, and keys off
`location_address_line1` — the one field of a structured address that is never optional.

**D4 — The one-off address is structured and geocoded, exactly like every other address in the
product.** Same five columns (`address_line1`, `address_line2`, `city`, `state`, `zip`), same
`AddressAutocomplete` component backed by Google Places, same static map. Being ad hoc is a statement
about whether it is *saved to the locations list*, not about what an address is; a one-off address the
customer cannot map, and that renders differently from every other address, would be the only such
address in the product. No latitude/longitude columns — nothing in this codebase stores coordinates;
the map takes the formatted address at render time, and the one-off inherits that for free.

**D5 — Naming follows the surface, not a generic word.** "Walkthrough location" on the lead side, "Job
visit location" on the job side. ServWave's vocabulary is walkthrough, so the copy says walkthrough.
Note this is a deliberate departure from the existing pair `lead.address` / `job.address`, which are
*both* labelled "Service address" because they genuinely mean the same thing. These two do not.

**D6 — Both sides ship, and the field picker is the reason.** The column is shared; the labels are
asymmetric by D5. Lead-only would read as an oversight in the picker.

**D7 — Never resolve to an empty string.** A declared merge field that resolves to `undefined` prints
its own token verbatim in a customer's inbox, because unknown fields are deliberately left literal so
typos stay visible. The usual guard, `?? ''`, is equally wrong here: "Please meet us at ." is broken
copy that has already been sent. The location field falls back to the resolved service address; the
phone fields fall back to the organisation's main line. This follows the precedent already set by
`technician.names`, which falls back to "Our team" so a seeded template never renders "coming: .".

**D8 — `location_id` is tenant-scoped on write.** A visit may only point at a location in its own
organisation, or a crafted request leaks another organisation's address into an email. The check
follows the shape `validatePerformers` already uses.

**D9 — A location referenced by a visit is archived, not deleted.** The foreign key restricts and the
delete handler returns 409 with a count, extending the guard it already applies to users assigned to
that location; nulling the reference instead would silently move a booked visit back to the customer's
address after the customer has been told otherwise. Because a branch that genuinely closes still needs
to leave the picker, `Location` gains `is_active` / `archived_at` — the same pattern `ServiceLocation`
already carries, and the same entity-redesign rule that says archive instead of delete when
referenced. An archived location leaves every booking picker but stays a live row, so every past and
booked visit keeps resolving. Outright delete survives for a location nothing references: forcing an
admin to archive a typo would be worse than the problem being solved.

Note what this does **not** mean: a visit's own location stays editable for the life of the visit.
Rebooking or editing a visit can move it between the service address, any active company location, and
a one-off address, any number of times. D9 restricts deleting the location *row in Settings*, nothing
about the visit.

**D10 — Renaming Walkthrough to Visit platform-wide stays out.** Tracked separately (SRVW-57, cancelled
2026-08-17 with no reason recorded). It is an enum migration plus a rewrite of live workflow rows and
in-flight enrolments, on automations organisations are actively running, and it does not make this
feature any better.

**D11 — Call routing stays out.** Rendering the performer's number in an email is a merge field.
Making a call to a number reach whoever is performing that visit is a telephony change, not an
automation one, and belongs in its own piece of work.

## Constraints and known behaviours

- **Four write surfaces**, and this is where the weight of the work actually sits, not in automations:
  `POST /leads/:id/walkthrough/schedule` (the active walkthrough), `POST /leads/:id/visits` (an
  additional one), `POST /jobs/:id/visits`, `PATCH /jobs/:id/visits/:visitId`. Each needs the field in
  its Zod schema and its handler.
- **A fifth path creates visits without booking them**: `POST /jobs/:id/assign` first-books through
  `syncJobWindowOntoVisits`. It needs no change — a visit it creates leaves both columns null, which is
  the service address, which is today's behaviour.
- **The automations half is small.** Four entries in the field catalog, the resolutions in `context.ts`,
  and `catalog.test.ts` already asserts that every offered field has both a label and a sample value, so
  a field shipped without either reddens on its own.
- **Frontend grouping is automatic.** `MergeFieldChips` buckets by prefix: `lead.` → "Lead &
  walkthrough", `job.` and `technician.` → "Job". A name without a known prefix falls silently into
  "Other", so the prefixes are load-bearing.
- **Walkthrough merge fields resolve against the lead's *current* visit**, and the rule is not the one
  the phrase suggests. While any visit is still live it is the one with the **earliest scheduled time**,
  which is not necessarily in the future — `resolveCurrentWalkthrough` consults no clock, so a live visit
  whose time has already passed still wins over a later one. Only once none are live does it become the
  most recent that happened. The consequence for an organisation sending a booking confirmation and then
  a day-before reminder is therefore the opposite of the obvious guess: booking a second visit *later*
  than the first changes nothing, while booking one *earlier* silently repoints the reminder. This is
  already true of the date and the time today, so the location inherits it rather than introducing it —
  but a location makes it more visible than a date does.
- **A location carries its own timezone; walkthrough times render in the organisation's.** A visit at a
  location in another timezone would print the wrong local time. Out of scope, and worth knowing before
  an organisation spanning timezones adopts this.
- **The company-location option needs locations to exist.** Settings already has the full CRUD, so
  there is no new admin surface, but an organisation with zero locations sees a picker offering only
  the service address and the one-off. That is honest and needs no special-casing beyond the empty
  state.

## User Stories

1. As an office admin booking a design consultation, I want to mark that the meeting is at our showroom rather than the customer's house, so that the confirmation email sends the customer to the right place.
2. As an office admin, I want the service address to stay the default, so that the great majority of visits need no extra decision.
3. As an office admin, I want to pick from the locations we already maintain, so that I am not retyping our own showroom address every time.
4. As an office admin booking a one-off meeting at a supplier's premises, I want to enter that address the same way I enter every other address in ServWave, so that it autocompletes and maps like any other — without becoming a permanent entry in our locations list.
5. As an office admin, I want to change where an already-booked visit is happening, so that a moved meeting does not need cancelling and rebooking.
6. As an operations manager, I want a corrected showroom address to flow into reminders that have not been sent yet, so that fixing it once fixes it everywhere.
7. As an operations manager, I want to be stopped from deleting a location that booked visits still point at, so that a tidy-up does not silently reroute customers.
8. As an organisation owner writing a walkthrough automation, I want a "Walkthrough location" field in the picker, so that one automation serves every lead regardless of where each meeting is.
9. As an organisation owner, I want the same capability on job visits under its own name, so that the field list reads consistently on both sides.
10. As an organisation owner, I want the location field to fall back to the service address when nothing else is set, so that adopting the field cannot make an existing automation worse.
11. As a customer receiving a confirmation, I want the address in the email to be where I am actually meant to go, so that I do not drive to the wrong place.
12. As a customer running late, I want a number in the email that reaches the person I am meeting, so that I am not relaying a message through the front desk.
13. As an organisation owner, I want the phone field to fall back to our main line when the person has no number on file, so that the email never shows a blank where a number should be.
14. As a technician, I want the visit's location visible on the visit itself, so that I know where to go without opening the customer record.
15. As a dispatcher looking at the schedule, I want a visit that is not at the service address to say so, so that I do not route someone to the wrong side of town.
16. As an operations manager closing a branch, I want to archive that location so it stops appearing when anyone books, while every visit that already happened there still reads correctly.

## Out of scope

- Routing an inbound call to the person performing the visit (D11).
- Renaming Walkthrough to Visit across the platform (D10).
- Rendering a visit's time in the location's timezone rather than the organisation's.
- Any change to which triggers exist or how automations are authored.
