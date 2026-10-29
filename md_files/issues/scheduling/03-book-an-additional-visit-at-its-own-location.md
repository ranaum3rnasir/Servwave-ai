# Book an additional visit at its own location

**Type:** AFK
**User stories covered:** 1, 3, 4, 5

## Parent

Spec: `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md`

## What to build

Slice 1 gave the lead's *active* walkthrough a location. This gives it to the second one.

A lead can hold more than one visit — `POST /leads/:id/visits` books an additional trip
alongside the one `/walkthrough/schedule` owns — and this is the case the whole feature
exists for: the first meeting at the showroom, the measure at the customer's house, a design
review back at the showroom. One lead, three visits, three different answers.

No storage changes. `POST /leads/:id/visits` takes the same optional location its sibling
door already takes, with the same validation and the same tenant scoping. The three-state field
is shared unchanged — but note this door only ever creates, so omitted and explicit null are
indistinguishable here; both mean the service address. "Omitted means unchanged" only becomes
observable at `PATCH /jobs/:id/visits/:visitId` in slice 4. The additional-visit dialog in `walkthroughTab.tsx`
gains the same control the scheduling dialog got.

**Reuse, do not re-implement.** Both doors now validate a location the same way, and a
second copy of the tenant-scoping check is a second place for it to drift out of step. Lift
the validation and the resolution into one helper the two doors share. This is the point at
which the shape is visible enough to factor honestly — slice 1 had one caller, and factoring
against one caller guesses at the seam.

**The merge field needs no work and that is worth verifying rather than assuming.**
`lead.walkthrough_location` resolves against whichever visit is *current* — while any visit is
still live, the one with the earliest scheduled time (no clock is consulted, so a live visit whose
time has passed still wins), and only once none are live, the most recent that happened. So booking
a second visit *earlier* than the first changes what an already-enrolled automation will render. That behaviour is inherited
from the date and time fields rather than introduced here, and the spec accepts it, but this
slice is where it first becomes reachable, so it needs a test that pins it deliberately
rather than leaving it to be discovered in a customer's inbox.

## Acceptance

- A second visit booked at a different location holds a different location from the first;
  neither write disturbs the other.
- With two visits at different locations, the walkthrough location merge field resolves
  against the current visit, matching whichever visit `lead.walkthrough_date` resolves
  against — a test asserts the two agree rather than asserting a hard-coded winner.
- Both lead-side doors reject a cross-tenant location id identically.
- Both lead-side doors reject a location id and a one-off address sent together.
- Booking an additional visit without a location leaves it at the service address.

## Out of scope for this slice

The job side (slice 4), the phone fields (slice 5), the read surfaces (slice 6).
