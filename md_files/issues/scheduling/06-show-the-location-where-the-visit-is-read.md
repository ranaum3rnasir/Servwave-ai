# Show the location where the visit is read

**Type:** AFK
**User stories covered:** 14, 15

## Parent

Spec: `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md`

## What to build

Slices 1 to 4 let the office *set* where a visit happens and let an automation *tell the
customer*. Everyone inside the organisation still reads the customer's address off the visit,
which is now sometimes wrong — and a technician sent to the wrong side of town is a worse
outcome than a customer told the wrong place, because nobody catches it until they arrive.

The visit's location becomes visible on the surfaces that already show a visit:

- the visit cards on the lead's walkthrough tab and the job's visits card
- the visit's detail on the schedule

**Show the difference, not the address, when there is no difference.** The great majority of
visits are at the service address, and printing it on every card would be noise on the common
case to serve the rare one. A visit at the service address reads as it does today. A visit
that is *not* at the service address says where it is instead, marked clearly enough that a
dispatcher scanning a day notices without reading.

**Wire it through the read shape once.** These surfaces read the visit through shared list
and detail shapes; the location belongs in those, resolved the same way the merge fields
resolve it, rather than each surface joining to `Location` for itself. A second resolution is
a second chance for the card and the email to disagree about where a customer is meant to be.

## Acceptance

- A visit at a company location shows that location on the lead's visit card, the job's visit
  card, and the schedule detail.
- A visit at a one-off address shows that address on all three, rendered **identically to a
  company location** — same element, same styling — so a one-off is not the only address in the
  product that reads differently. Note what this does and does not require: none of these three
  surfaces renders a *service* address through `ServiceLocationMap` today, so the one-off does not
  get one either. D4's map requirement is satisfied on the booking control, where the sibling
  address forms do render theirs. Adding a map only for one-offs would be the inconsistency, not
  the fix.
- A visit at the service address renders as it does today — no new line, no empty label.
- What a card shows and what the merge field renders for the same visit agree, and a test
  asserts the agreement rather than checking each in isolation.
- Mobile layout intact on all three surfaces.

## Out of scope for this slice

Mapping or directions from a location. Route optimisation. Any change to how the schedule
groups or filters visits.
