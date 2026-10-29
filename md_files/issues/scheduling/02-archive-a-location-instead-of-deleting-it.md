# Archive a location instead of deleting it

**Type:** AFK
**User stories covered:** 7, 16

## Parent

Spec: `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md`

## What to build

Slice 1 made a location undeletable once a visit points at it, which is the safe direction —
deleting it would silently move a booked visit back to the customer's address after the
customer has been told to come to the showroom. But a restriction with no escape is not a
finished design: a branch that genuinely closes has to be able to leave the picker, and today
its only exit is a delete that slice 1 now refuses.

**Archive, do not delete.** This is the pattern `ServiceLocation` already carries for exactly
this problem — `is_active`, `archived_at`, and the entity-redesign note that says archive
instead of delete when referenced. `Location` gains the same two columns and behaves the same
way, so an admin learns the concept once.

An archived location:

- **drops out of every picker** where a new visit is booked, so nobody books into a closed
  branch;
- **stays a live row**, so every past and booked visit that points at it keeps resolving, on
  the card and in the email alike;
- **can be restored**, because closing a branch and reopening it is a real thing and an
  irreversible archive would push admins back towards deleting.

Settings → Locations gains **Archive** and **Restore** alongside the delete it offers today,
and shows archived locations distinctly rather than hiding them — an admin looking for the old
yard needs to find it to restore it.

**Delete does not disappear.** A location nothing references — created by mistake, never used
— should still be removable outright; forcing an admin to archive a typo is worse than the
problem this solves. Keep the route, keep slice 1's 409 guard, and let archive be the answer
only when the 409 says it has to be.

**The filter belongs in one place.** Every picker that offers locations for a *new* booking
filters to active; every read path that resolves an *existing* visit's location does not. Get
this backwards in either direction and the symptom is either a bookable closed branch or a
visit whose location vanishes from its own card.

## Acceptance

- Archiving a location removes it from the booking picker on both the lead and the job side.
- A visit already pointing at an archived location still renders it — on the visit card and in
  the merge field — with no gap and no fallback to the service address.
- An archived location can be restored and reappears in the picker.
- A location nothing references can still be deleted outright.
- A location a visit references still returns 409 on delete, and the message points the admin
  at archiving rather than just refusing.
- Archiving is audited the way `location.deleted` already is.
- Inventory, stock and user-assignment surfaces that read locations are checked against the
  new filter — an archived location must not vanish from a stock record that still points at
  it.

## Out of scope for this slice

Merging or reassigning a location's visits to another location. Bulk archive.
