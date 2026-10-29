# Slice 08 — Dragging an Event, and the notify toast

**Type:** AFK
**Blocked by:** Slice 07 — Notifications: scheduled, moved, cancelled
**Spec sections:** §3, §4, §5

## What to build

An Event becomes draggable on the board. Dropping it **saves directly** — no
`RescheduleConfirmDialog`, no crew prompt, no drop modal — and is followed by a **non-blocking**
toast offering "Notify participants of the new time?", which routes into Slice 07's *moved*
sender. Declining the toast, or ignoring it, leaves the move saved.

A calendar entry has no crew and no conflict participation, so every reason those dialogs exist
is absent: `RescheduleConfirmDialog` exists to confirm a crew change and warn about a conflict,
and `UnifiedDropModal` exists to compose a crew and a time. Neither applies.

- **`dragChannels.ts`** — `parseBoardDragId` gains a `ce-` case returning
  `{ kind: 'calendar-entry', entityId }`, and `BoardDragKind` gains the member. This is the
  slice where that case becomes safe to add: Slice 03 deliberately left it out so the
  fall-through `{ kind: 'job' }` could never be reached, and the accessors refused the drag.
  Both halves flip here together.
- **`draggableAccessor` / `resizableAccessor`** now return true for an entry **iff**
  `ability.can('update', 'CalendarEntry')`. §4: gate on the grant, **not** on
  `boardCapabilitiesFor`, which returns `readOnly: false` for SALES — a SALES user who cannot
  create an Event must not be able to drag one.
- **The drop handler** issues a `PATCH /api/calendar-entries/:id` with the new `start`/`end`,
  preserving the duration, and invalidates `['schedule-calendar-entries']`.
- **Plan Mode still excludes entries entirely** (§3). Dragging in Plan Mode does not create a
  ghost for an entry; "schedule all drafts" never touches them. Slice 03 established this and
  this slice must not regress it — turning drag on is exactly the change that could.
- **Resize** follows the same path as a drag: direct save, same toast.

## Acceptance criteria

- [ ] `dragChannels.test.ts`: `parseBoardDragId('ce-<uuid>')` returns
      `{ kind: 'calendar-entry', entityId: '<uuid>' }`; the existing `wt-` / `pv-` / bare-job
      cases pass unmodified.
- [ ] Dropping an entry issues exactly one `PATCH /api/calendar-entries/:id` and **zero**
      requests to `/api/jobs/*` or `/api/leads/*` — asserted on the mocked client, because the
      failure mode is a silent misroute to `/api/jobs/<uuid>/assign`.
- [ ] The drop opens **no** `RescheduleConfirmDialog` and **no** `UnifiedDropModal`; a test
      asserts neither dialog mounts.
- [ ] The move persists before the toast is answered — dismissing the toast does not roll back.
- [ ] Choosing "notify" hits the *moved* path from Slice 07 and stamps `notified_at`; declining
      sends nothing.
- [ ] A SALES user (no `CalendarEntry` grant) cannot drag an entry: `draggableAccessor` returns
      false, covered by a test.
- [ ] With Plan Mode active, dragging an entry creates no ghost and `ghostCount` is unchanged;
      "confirm all drafts" with entries on the board touches no entry.
- [ ] Duration is preserved across a drag — a 14:00–16:00 entry dropped on 09:00 becomes
      09:00–11:00, not 09:00 + a default.

## Out of scope for this slice

- Cross-lane member drags changing participants. Drag changes **where/when**; the dialog
  changes **who** — the same TG10 rule the board already encodes for crew. A drop on another
  member's lane reschedules; it does not reassign the participant.
- Any conflict warning on the drop — ADR 0002.
- Search — Slice 09.

## Verification

`cd frontend && npm test -- dragChannels SchedulePage eventEntryDialog`. Synthetic tests can
drive react-big-calendar's `onEventDrop` / `onEventResize` callbacks directly, so the handler is
genuinely covered — but still confirm in a real browser on staging: drag a timed Event two hours
later and watch the network tab show a single `PATCH /api/calendar-entries/:id`; confirm the
toast appears and the card has already moved; drag it again and decline; then check the entry's
participant rows and confirm `notified_at` moved only once.
