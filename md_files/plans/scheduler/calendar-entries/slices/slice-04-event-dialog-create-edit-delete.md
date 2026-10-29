# Slice 04 — The Event dialog: create, edit, hard-delete, one participants field

**Type:** AFK
**Blocked by:** Slice 03 — Entries on the board: adapter, the three guards, Standard view
**Spec sections:** §2, §4, §7

## What to build

A dispatcher can create an **Event** from the scheduler, edit it, and delete it — without curl.
This is the slice that makes the feature usable by a human.

**Where it goes.** A new dialog in the live v2 tree,
`frontend/src/pages/v2/schedule/components/eventEntryDialog.tsx`. **Not**
`frontend/src/components/schedule/EventEditor.tsx` — that file has no importer outside its own
test and is a dead v1 fork (see Slice 03's note). The live editor the page mounts is
`frontend/src/pages/v2/schedule/components/eventEditor.tsx`, and a calendar entry does **not**
route into it: that component is built around crew, `MultiAssigneeSelect`, `deriveState` and a
`detailUrlOf` that only knows jobs and leads. A separate dialog is correct here.

**Entry points.** "New Event" from the scheduler's create affordance, and clicking an entry card
on the board opens the same dialog in edit mode. Both gated on
`ability.can('create'|'update', 'CalendarEntry')` — not on `boardCapabilitiesFor`, which returns
`readOnly: false` for SALES (§4).

**Fields.** Title (required), description, and the schedule. The time fields must come from
`frontend/src/pages/v2/_shared/scheduleTimeFields.tsx` over the pure `scheduleTimeValue` module,
which is where every v2 scheduling surface already lives (#1551). Do not derive the fields back
out of a narrower combined string — that is #1535 exactly, and half-filled edits collapse to `''`.

**The participants field is ONE field** (§7). Users and customers in the same picker, 0..N of
each, rendered as one chip list. Behind it:

- Users come from the assignable-users feed the scheduler already loads.
- Customers reuse `frontend/src/components/crm/CustomerPickerWithCreate.tsx` /
  `PickOrCreateCustomer.tsx`, so a pre-lead prospect can be created inline from the field.
  **Superseded (fix/ce-picker):** the product owner overrode this after manual QA - the field's
  customer picker now offers existing customers only (`allowCreate={false}`), with no inline
  create affordance; do not restore inline create as a "fix" for this line.
- **A customer is picked as a customer** — no contact drill-down, no email picker, no "which
  person at the company", and `kind = COMPANY` gets no special handling. None of that is exposed.
- **No free-text participants.** They would be a second contact concept that never links up when
  that person does become a customer.
- **Zero participants saves cleanly** and is the normal case for "Dave is off Thursday" — the
  form must not require one, and there must be a test for it.
- **The creator is not auto-attached** (§2). A dispatcher typing an entry on someone else's
  behalf must not get a card in their own column.

**Delete** is a hard delete (§7) behind an explicit warning dialog that says the event will be
removed for everyone.

The dialog's writes invalidate the `['schedule-calendar-entries', ...]` query key. This is the
#1718 class — a mutation that renders a card but never invalidates the list the board reads,
so the change appears only after a reload. Every one of create / edit / delete invalidates.

## Acceptance criteria

- [ ] A new RTL test file `frontend/src/pages/v2/schedule/__tests__/eventEntryDialog.test.tsx`
      covers: save with a title and a time and **no participants** → `POST` fires with
      `participants: []`; adding a user and a customer produces one `participants` array with both
      `kind`s; the payload never contains the caller's own user id unless they were explicitly
      picked.
- [ ] Editing an entry seeds the four schedule fields from the entry's own `start`/`end` and a
      save that touches only the description leaves `start`/`end` byte-identical in the `PATCH`
      body (the seeded-defaults hazard: a pre-filled dialog must not re-write fields nobody
      touched).
- [ ] Deleting shows the warning first, and only the confirm issues the `DELETE`.
- [ ] Each of create / edit / delete invalidates `['schedule-calendar-entries']`, asserted on the
      query client — not inferred from the card re-rendering.
- [ ] A SALES user with no `CalendarEntry` grant sees no "New Event" affordance and, on clicking
      an entry card, gets a read-only dialog with no Save and no Delete.
- [ ] Creating a customer inline from the participants field lands a real `Customer` row and
      attaches it in the same save.
- [ ] `npx tsc --noEmit` clean; `lint-changed-lines.mjs` clean on added lines.

## Out of scope for this slice

- The all-day toggle — Slice 05 owns both the toggle and the rendering it implies.
- Any notify checkbox, send dialog or delete-notification prompt — Slice 07. In this slice
  deleting an entry emails nobody, and that is the correct intermediate state.
- Member column placement — Slice 06.
- Recurrence controls — permanently out (§8).

## Verification

`cd frontend && npm test -- eventEntryDialog`. In the browser on staging: create an Event with
no participants and confirm it appears on the Standard board; create a second with one user and
one customer, including a customer created inline from the field; reopen it and confirm both
chips are present and the times round-trip; edit only the title and confirm the card updates
**without a page reload**; delete it and confirm the card disappears without a reload.
