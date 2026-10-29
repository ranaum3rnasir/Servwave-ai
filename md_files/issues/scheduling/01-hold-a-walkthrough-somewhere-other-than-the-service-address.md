# Hold a walkthrough somewhere other than the service address

**Type:** AFK
**User stories covered:** 1, 2, 3, 4, 5, 6, 7, 8, 10, 11

## Parent

Spec: `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md`

## What to build

The tracer bullet: an office admin books a walkthrough at the showroom instead of the
customer's house, and the confirmation automation emails the showroom address.

Deliberately the narrowest complete path, but it must be complete — schema through to what
lands in the customer's inbox — because every later slice is an additional door onto the
same column and would otherwise be building against nothing.

**The migration creates both columns and the CHECK, once.** Later slices add doors, not
storage.

Nullable columns on the visit table:

- `location_id` — foreign key to the organisation's own `Location`, `onDelete: Restrict`.
- `location_address_line1`, `location_address_line2`, `location_city`, `location_state`,
  `location_zip` — a one-off address, in **the same five structured fields every other
  address in this product uses**. Match the column types on `ServiceLocation`. No
  latitude/longitude: nothing here stores coordinates, and `ServiceLocationMap` geocodes the
  formatted address at render time, so a structured one-off address maps for free.

The three states are **derived**, never stored: `location_id` set means a company location;
`location_address_line1` set means a one-off address; both null means the parent's service
address. Do not add a mode enum — it would be a third source of truth able to disagree with
the columns it describes.

"Not both set" is a **database CHECK** keyed off `location_address_line1` — the one field of a
structured address that is never optional — and Prisma cannot express it. The visit table already
carries exactly this idiom in `visits_exactly_one_parent` for `lead_id`/`job_id`; follow it,
including writing the constraint into the migration SQL by hand. Read
`.claude/skills/writing-migrations` before writing it — this migration runs in three places.
`Location` needs the back-relation.

**The write door for this slice is `POST /leads/:id/walkthrough/schedule`** — the one that
books and rebooks the lead's active walkthrough. Its Zod schema takes an optional
location: either a location id or a structured one-off address, and **rejecting both at once
is a schema-level concern**, not something the handler discovers when the database throws.
The one-off address validates the way service addresses already validate — line 1, city and
state required together, so a half-typed address cannot be stored.

`location_id` **must be tenant-scoped** before it is written. A visit may only point at a
location in its own organisation; without the check a crafted request puts another
organisation's address into a customer email. `validatePerformers` in the same area is the
shape to follow. A location id belonging to another tenant is a 400, not a 404 that leaks
whether the row exists.

**Omitted means unchanged, explicit null means clear.** The reschedule doors in this codebase
already distinguish these three states and the distinction matters here: a caller moving only
the time must not silently reset a showroom meeting back to the customer's address.

**The booking UI** is the existing walkthrough scheduling dialog on the lead
(`frontend/src/pages/v2/leads/components/walkthroughTab.tsx`), which already asks for date,
time and who is going. It gains one control asking where — defaulting to the service
address, offering the organisation's locations, and offering a one-off address that reveals
the **same `AddressAutocomplete` field used on the lead, customer and job forms** — not a bare
text input. An address entered here has to autocomplete, parse and map exactly like any other
address in ServWave; that consistency is the point of the decision.

An organisation with no locations configured sees only the two other options; that is honest,
and needs no special-casing beyond the empty state.

**The merge field is `lead.walkthrough_location`, labelled "Walkthrough location".** It goes
in `WALKTHROUGH_FIELDS` in the automations catalog with both a label and a sample value —
`catalog.test.ts` asserts every offered field has both, so omitting either reddens on its
own. The `lead.` prefix is load-bearing: `MergeFieldChips` buckets by prefix, and a name
without a known one falls silently into "Other" rather than "Lead & walkthrough".

**Resolution, in `context.ts`, must never produce an empty string.** This is the part that
would ship a broken customer email:

- `location_id` set → the location's name and address, read through the relation.
- `location_address_line1` set → the one-off address, formatted the same way `lead.address`
  formats the service address, so the two are indistinguishable in an email body.
- neither → **the same service-address string `lead.address` already resolves to.**

`?? ''` is wrong here. A declared field resolving to `undefined` prints `{{lead.walkthrough_location}}`
verbatim in the customer's inbox, because unknown fields are deliberately left literal so
typos stay visible — and `''` gives "Please meet us at ." instead. `technician.names` falling
back to `'Our team'` is the precedent. Resolve against the lead's **current** visit, the same
one `lead.walkthrough_date` uses; do not introduce a second notion of which visit is current.

**Deleting a location that visits point at must be refused.** `deleteLocation` already
returns 409 with a count for users assigned to that location; add visits to the same guard.
Without it the restricting foreign key surfaces as a 500 on a perfectly reasonable admin
action. This slice leaves a used location with no way out of the picker at all; slice 2 gives
it one by making archive the answer. Refusing is the safe direction to be temporarily stuck
in, but the two slices belong in the same release.

## Acceptance

- A walkthrough booked with a company location, then rendered through a confirmation
  automation, puts that location's address in the email body — not the customer's.
- A walkthrough booked with a one-off address renders it in the same format a service address
  renders in — same field order, same separators.
- A one-off address entered through the autocomplete lands in the five structured columns,
  parsed, not as one blob in line 1.
- A one-off address missing city or state is rejected by validation.
- A walkthrough booked with neither renders exactly what it renders today.
- Correcting the location's address in Settings changes what an unsent reminder will render,
  with no write to the visit.
- Rescheduling the time only, with no location in the payload, leaves the location alone.
- Sending both a location id and a one-off address is rejected by validation.
- A location id from another organisation is rejected, and the response does not reveal
  whether that id exists.
- Deleting a location that a visit points at returns 409 naming the count, not a 500.
- The chip appears in the "Lead & walkthrough" group of the field picker, not in "Other".

## Out of scope for this slice

Archiving a location (slice 2), the additional-visit door (slice 3), the whole job side
(slice 4), the phone fields (slice 5), and showing the location on the surfaces that read a
visit (slice 6).
