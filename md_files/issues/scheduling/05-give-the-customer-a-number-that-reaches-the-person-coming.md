# Give the customer a number that reaches the person coming

**Type:** AFK
**User stories covered:** 12, 13

## Parent

Spec: `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md`

## What to build

A confirmation email can already name who is coming. It cannot give the customer a way to
reach them, so a customer running late calls the main line and the front desk goes hunting
for someone who is out on the road.

**No schema work.** `User.phone` and `User.phone_ext` already exist and are already editable
in Settings → Users & Teams and in My Profile. The lead-side context loader already selects
`phone` on each visit assignee. This slice is a catalog entry, a resolution and a fallback —
which is why it is small enough to sit behind the location work rather than beside it.

Two fields, one per side, matching the names already in each group:

- **`lead.performer_phones`** — "Walkthrough team phone(s)", alongside `lead.performer_names`.
- **`technician.phones`** — "Technician phone(s)", alongside `technician.names` and
  `technician.first_name`. The `technician.` prefix already maps to the "Job" group.

Both render every person on the visit, formatted so an extension reads as one — a number and
its extension are one way of reaching one person, not two numbers.

**The fallback is the whole slice.** Nobody is obliged to have a number on file, and most
organisations adopting this will have several users who do not. Resolving to an empty string
puts "Call us on ." in a customer's inbox; resolving to `undefined` prints the token itself.
Both fall back to **the organisation's main line** — the same value `org.phone` renders. The
precedent is `technician.names` falling back to `'Our team'` so a seeded template never
renders "coming: ."; follow it.

Where some of the crew have numbers and others do not, render the ones that exist rather than
falling back wholesale — the fallback is for nobody having one, not for anybody lacking one.

## Acceptance

- A walkthrough whose performer has a phone number renders that number, not the main line.
- An extension renders attached to its number, as one reachable contact.
- A walkthrough whose performers have no numbers renders the organisation's main line.
- A two-person crew where one has a number renders that one number, not the main line.
- Neither field ever renders an empty string, and neither ever renders its own token.
- Both fields carry a label and a sample value, so `catalog.test.ts` passes.
- The walkthrough field appears in "Lead & walkthrough"; the technician field in "Job".

## Out of scope for this slice

Routing an inbound call to whoever is performing the visit. That is a telephony change, not
an automation one, and is tracked separately — rendering a number is not the same as making a
call reach a person.
