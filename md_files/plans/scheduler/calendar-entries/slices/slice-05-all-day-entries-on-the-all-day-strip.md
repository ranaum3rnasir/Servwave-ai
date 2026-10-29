# Slice 05 — All-day and multi-day entries on the all-day strip

**Type:** HITL — §9 risk 1 is a scheduling decision a human makes, and the strip is visual
**Blocked by:** Slice 04 — The Event dialog: create, edit, hard-delete, one participants field
**Spec sections:** §2, §3, §8, §9 risk 1

## What to build

An Event marked all-day renders as a pill in react-big-calendar's all-day strip, and a
multi-day Event ("Dave is on vacation Mon–Fri") renders as **one continuous bar across those
days** — one row, not five (§2).

- **`isAllDayEvent` gains a calendar-entry branch** reading `raw.is_all_day` — the same shape as
  the job branch's `e.isAllDay ?? e.raw?.is_all_day`, except an entry has no mirror-column
  hazard: `is_all_day` is a real column on the entry itself, not a write-through mirror of a
  child row. Carry it onto the adapter's `isAllDay` field anyway so the card reads its own flag.
- **`occupiesAllDayStrip` needs no change** — it already returns true for anything crossing a
  calendar-day boundary, which is what makes the multi-day bar work, and the page's
  `hasAllDayEvents` / `has-allday-events` class already keys off `occupiesAllDayStrip`.
  Verify that rather than assuming it; the gap between the two predicates is a bug this
  codebase has already shipped once (a timed cross-midnight job rendered into a collapsed
  container, zero pixels tall).
- **The dialog gains its all-day toggle** (Slice 04 shipped without one). Toggling it on
  collapses the time inputs to date inputs and the `end` is written as the end of the last
  selected day — reuse `allDayEndIso` in `SchedulePage.tsx` rather than re-deriving it.
- **The all-day slot popover** ("create here") must be able to seed a new Event, not only a job.

## ⚠️ Sequencing — this is §9 risk 1

The all-day strip and the react-big-calendar config are the same rendering path as the multi-day
work happening in a separate session. **Do not start this slice while that work is unmerged.**
Before opening a branch, confirm the other change is already in `origin/staging`
(`git log --oneline origin/staging -- frontend/src/pages/v2/schedule/SchedulePage.tsx
frontend/src/components/schedule/scheduleModel.ts`) or confirm with the human that it is not in
flight. If it is in flight, this slice waits and Slice 06 goes next — nothing after it depends
on all-day.

## Acceptance criteria

- [ ] `scheduleModel.test.ts`: `isAllDayEvent` is true for a calendar entry with
      `raw.is_all_day === true` and false when the flag is absent or false; the existing job and
      walkthrough cases pass unmodified.
- [ ] `allDayStripRouting.test.ts` (or its v2 equivalent) covers a calendar entry:
      `occupiesAllDayStrip` is true both for an all-day single-day entry and for a **timed**
      entry that crosses midnight.
- [ ] A Mon 00:00 → Fri 23:59 all-day entry renders as **one** element in the strip, not five —
      asserted on the rendered node count, not eyeballed.
- [ ] A timed entry on the same day still renders in the time grid with its hours intact and
      does **not** get routed into the strip.
- [ ] Turning the dialog's all-day toggle on and saving writes `is_all_day: true` and an `end`
      that covers the whole final day; turning it back off restores real times rather than
      leaving midnight-to-midnight.
- [ ] The all-day strip does not collapse to zero height when the only strip occupant is a
      calendar entry (the `has-allday-events` gate).
- [ ] **Human sign-off:** a screenshot of a week holding an all-day Event, a multi-day Event and
      an all-day job in the same strip.

## Out of scope for this slice

- Walkthrough all-day. §8 is explicit: `Walkthrough` has no `is_all_day` column and
  `isAllDayEvent` fakes it with `duration >= 1440`. It is a real gap, it needs a schema change
  and it touches the lead pipeline's read paths. Do not fix it here.
- Dragging an all-day entry between days — Slice 08.

## Verification

`cd frontend && npm test -- scheduleModel allDayStripRouting eventEntryDialog`. In the browser on
staging: create an all-day Event for tomorrow and a Mon–Fri Event, confirm one pill and one
continuous bar; create a timed Event the same day and confirm it stays in the grid; collapse and
expand the strip.
