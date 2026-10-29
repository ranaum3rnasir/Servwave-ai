# Slice 2 - The remaining four field types

**Parent:** SRVW-114 · **Type:** AFK · **Blocked by:** Slice 1

## What to build

Widen the type axis from TEXT to the full set named in the card: **NUMBER, DATE, SELECT, CHECKBOX**.
Still jobs only, still one panel, so the slice stays demoable end to end: an admin defines one field
of each type and fills all five in on a job.

Three layers move together per type:

* **Definition form** - the admin UI grows a type picker, and SELECT grows a choice editor
  (add, rename, reorder, remove a choice).
* **Validation** - `validateCustomFieldValues` coerces and rejects per type: a number field refuses
  non-numeric input, a date field stores an unambiguous serialization, a select field refuses a value
  outside its choice list, a checkbox stores a real boolean rather than a truthy string.
* **Panel rendering** - the right control per type, reusing the existing form primitives rather than
  new bespoke inputs.

The date field is a known trap: CLAUDE.md requires a vetted library at date and timezone edges, not
hand-rolled parsing. A custom date field is a plain calendar date with no time component, and it must
not shift by a day for a user in a non-UTC timezone.

## Acceptance criteria

- [ ] Admin can create a definition of each of the five types, and the type is immutable after creation (changing it would silently invalidate stored values)
- [ ] SELECT definitions carry an editable choice list; removing a choice already in use is either blocked or explicitly warned, and never corrupts stored values
- [ ] Each type renders its appropriate control in the Extra Info panel and round-trips its value through save and reload
- [ ] NUMBER rejects non-numeric input at the API, not only in the UI
- [ ] SELECT rejects a value outside the definition's choice list at the API
- [ ] CHECKBOX stores a JSON boolean, never a string
- [ ] DATE stores a timezone-stable calendar date, proven by a test that would fail under naive UTC conversion
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Blocked by

- Slice 1 (tracer)
